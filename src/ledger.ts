/**
 * Receipt ledger (schema daemonsudo/v1): append-only, SHA-256 hash-chained,
 * ed25519-signed. Receipts are stored as RFC 8785 canonical JSON; `prev_hash`
 * chains each receipt to the full stored JSON of the previous one. Signatures
 * cover the canonical JSON of the receipt minus its `sig` field.
 *
 * prev_hash alone cannot detect deletion of the *newest* receipts, so every
 * append also rewrites a signed head checkpoint ({chain_id, seq, receipt_hash})
 * in ledger_meta — `verify` requires it to name the last receipt.
 */
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import type { Db } from "./db.js";

// noble v3 needs a sha512 implementation for the sync API; node:crypto's
// works on both Node and Bun with no extra dependency.
ed.hashes.sha512 = (msg: Uint8Array) =>
  new Uint8Array(createHash("sha512").update(msg).digest());

export const SCHEMA_ID = "daemonsudo/v1";

export type Decision = "auto" | "approved" | "denied" | "timeout" | "error";

export interface Approver {
  channel: string;
  user: string;
  latency_ms: number;
}

/** Who asked: MCP client identity, per-gate-run session, JSON-RPC call id. */
export interface Requester {
  client?: string;
  session: string;
  call_id: string;
}

export interface Receipt {
  schema: typeof SCHEMA_ID;
  id: string;
  chain_id: string;
  seq: number;
  prev_hash: string;
  ts: string;
  server: string;
  tool: string;
  args_hash: string;
  args_redacted: unknown;
  decision: Decision;
  rule: string;
  /** sha256 of the gate.yaml in force — which policy version produced the verdict */
  gate_hash: string;
  requester?: Requester;
  approver?: Approver;
  result?: { status: "ok" | "error"; content_hash: string };
  /** fingerprint of the signing key — verification survives key rotation */
  kid?: string;
  sig: string;
}

export interface ReceiptInput {
  server: string;
  tool: string;
  args: unknown;
  decision: Decision;
  rule: string;
  requester?: Requester;
  approver?: Approver;
  result?: { status: "ok" | "error"; content_hash: string };
}

export interface Signer {
  kid: string;
  sign(payload: string): string;
}

const GENESIS = "daemonsudo-genesis";

export interface KeyPair {
  kid: string;
  secretHex: string;
  publicHex: string;
}

/** Key fingerprint: first 16 hex chars of sha256 over the raw public key bytes. */
export function keyFingerprint(publicHex: string): string {
  return createHash("sha256").update(Buffer.from(publicHex, "hex")).digest("hex").slice(0, 16);
}

/** Signing key: generated on first run, stored in the db, exportable. */
export function loadOrCreateKeys(db: Db): KeyPair {
  const row = db.get<{ kid: string; secret_hex: string; public_hex: string }>(
    "SELECT kid, secret_hex, public_hex FROM keys ORDER BY created_at DESC LIMIT 1",
  );
  if (row) return { kid: row.kid, secretHex: row.secret_hex, publicHex: row.public_hex };
  const { secretKey, publicKey } = ed.keygen();
  const pair = {
    secretHex: Buffer.from(secretKey).toString("hex"),
    publicHex: Buffer.from(publicKey).toString("hex"),
  };
  const kid = keyFingerprint(pair.publicHex);
  db.run("INSERT INTO keys (kid, secret_hex, public_hex, created_at) VALUES (?, ?, ?, ?)", [
    kid,
    pair.secretHex,
    pair.publicHex,
    new Date().toISOString(),
  ]);
  return { kid, ...pair };
}

export function makeSigner(keys: KeyPair): Signer {
  const secret = Buffer.from(keys.secretHex, "hex");
  return {
    kid: keys.kid,
    sign: (payload) =>
      `ed25519:${Buffer.from(ed.sign(Buffer.from(payload, "utf8"), secret)).toString("hex")}`,
  };
}

export function makeVerifier(publicHex: string): (payload: string, sig: string) => boolean {
  const pub = Buffer.from(publicHex, "hex");
  return (payload, sig) => {
    if (!sig.startsWith("ed25519:")) return false;
    try {
      return ed.verify(
        Buffer.from(sig.slice("ed25519:".length), "hex"),
        Buffer.from(payload, "utf8"),
        pub,
      );
    } catch {
      return false;
    }
  };
}

/**
 * RFC 8785 (JCS) canonical JSON: object keys sorted recursively by UTF-16 code
 * units, no whitespace. JSON.stringify supplies the JCS-mandated ECMAScript
 * string and number serializations; JS `<` on strings compares UTF-16 code
 * units, which is exactly the JCS member ordering.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

export function sha256(payload: string): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

/**
 * Replace every value whose dotted path matches a redact glob with
 * "[redacted]". Matched values never land in the ledger raw — only inside
 * args_hash (a hash of the full args).
 */
export function redact(value: unknown, globs: string[]): unknown {
  if (globs.length === 0) return value;
  // "*.password" should also catch a top-level "password"
  const res = globs.flatMap((g) =>
    g.startsWith("*.") ? [globToRegExp(g), globToRegExp(g.slice(2))] : [globToRegExp(g)],
  );
  const walk = (v: unknown, path: string): unknown => {
    if (path && res.some((re) => re.test(path))) return "[redacted]";
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((item, i) => walk(item, path ? `${path}.${i}` : String(i)));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = walk(val, path ? `${path}.${k}` : k);
    }
    return out;
  };
  return walk(value, "");
}

/** The chain's identity, generated once per ledger and stamped on every receipt. */
function loadOrCreateChainId(db: Db): string {
  const row = db.get<{ value: string }>("SELECT value FROM ledger_meta WHERE key = 'chain_id'");
  if (row) return row.value;
  const id = ulid();
  db.run("INSERT INTO ledger_meta (key, value) VALUES ('chain_id', ?)", [id]);
  return id;
}

export class Ledger {
  private chainId: string;
  private gateHash: string;

  constructor(
    private db: Db,
    private redactGlobs: string[] = [],
    private signer?: Signer,
    gateHash?: string,
  ) {
    this.chainId = loadOrCreateChainId(db);
    this.gateHash = gateHash ?? sha256("daemonsudo-no-gate-config");
  }

  append(input: ReceiptInput): Receipt {
    const last = this.db.get<{ seq: number; json: string }>(
      "SELECT seq, json FROM receipts ORDER BY seq DESC LIMIT 1",
    );
    const unsigned: Omit<Receipt, "sig"> = {
      schema: SCHEMA_ID,
      id: ulid(),
      chain_id: this.chainId,
      seq: (last?.seq ?? 0) + 1,
      prev_hash: sha256(last ? last.json : GENESIS),
      ts: new Date().toISOString(),
      server: input.server,
      tool: input.tool,
      args_hash: sha256(canonicalJson(input.args ?? {})),
      args_redacted: redact(input.args ?? {}, this.redactGlobs),
      decision: input.decision,
      rule: input.rule,
      gate_hash: this.gateHash,
      ...(input.requester ? { requester: input.requester } : {}),
      ...(input.approver ? { approver: input.approver } : {}),
      ...(input.result ? { result: input.result } : {}),
      ...(this.signer ? { kid: this.signer.kid } : {}),
    };
    const sig = this.signer ? this.signer.sign(canonicalJson(unsigned)) : "unsigned";
    const receipt: Receipt = { ...unsigned, sig };
    const json = canonicalJson(receipt);
    // receipt + head checkpoint move together or not at all
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.run(
        "INSERT INTO receipts (seq, id, ts, server, tool, decision, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [receipt.seq, receipt.id, receipt.ts, receipt.server, receipt.tool, receipt.decision, json],
      );
      this.writeCheckpoint(receipt.seq, json);
      this.db.exec("COMMIT;");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
    return receipt;
  }

  /** Signed head pointer — deleting the newest receipts leaves it dangling. */
  private writeCheckpoint(seq: number, json: string): void {
    const payload = {
      chain_id: this.chainId,
      seq,
      receipt_hash: sha256(json),
      ...(this.signer ? { kid: this.signer.kid } : {}),
    };
    const sig = this.signer ? this.signer.sign(canonicalJson(payload)) : "unsigned";
    this.db.run(
      "INSERT INTO ledger_meta (key, value) VALUES ('checkpoint', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [canonicalJson({ ...payload, sig })],
    );
  }

  list(limit = 200): Receipt[] {
    return this.db
      .all<{ json: string }>("SELECT json FROM receipts ORDER BY seq DESC LIMIT ?", [limit])
      .map((r) => JSON.parse(r.json) as Receipt);
  }

  count(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM receipts")?.n ?? 0;
  }
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  error?: string;
  badSeq?: number;
}

export type VerifierFn = (payload: string, sig: string) => boolean;

/**
 * Walk the chain oldest→newest: canonical form, schema, prev_hash, seq
 * monotonicity, one chain_id throughout, and a signature that verifies
 * against the key named by each receipt's kid. Then the signed head
 * checkpoint must name the last receipt — deleting the newest rows
 * (tail truncation) is the one tamper prev_hash alone cannot see.
 * Pure read — usable offline against a copied gate.db.
 */
export function verifyChain(db: Db, keys: Map<string, VerifierFn>): VerifyResult {
  const rows = db.all<{ seq: number; json: string }>(
    "SELECT seq, json FROM receipts ORDER BY seq ASC",
  );
  if (rows.length === 0) {
    const cp = db.get<{ value: string }>("SELECT value FROM ledger_meta WHERE key = 'checkpoint'");
    if (cp) {
      return { ok: false, count: 0, error: "ledger empty but a head checkpoint exists — receipts were deleted" };
    }
    return { ok: true, count: 0 };
  }

  const count = rows.length;
  const chainId = (JSON.parse(rows[0].json) as Receipt).chain_id;
  let prevJson: string | null = null;
  let expectedSeq = 1;
  for (const row of rows) {
    const fail = (error: string): VerifyResult => ({ ok: false, count, badSeq: row.seq, error });
    const receipt = JSON.parse(row.json) as Receipt;
    if (canonicalJson(receipt) !== row.json) return fail("stored JSON is not canonical");
    if (receipt.schema !== SCHEMA_ID) return fail(`unknown receipt schema '${String(receipt.schema)}'`);
    if (receipt.prev_hash !== sha256(prevJson ?? GENESIS)) return fail("hash chain broken");
    if (receipt.seq !== expectedSeq) {
      return fail(`seq not monotonic (expected ${expectedSeq}, got ${receipt.seq})`);
    }
    if (receipt.chain_id !== chainId) return fail("chain_id mismatch");
    const verifySig = receipt.kid === undefined ? undefined : keys.get(receipt.kid);
    if (!verifySig) return fail(`unknown key id '${receipt.kid ?? "(none)"}'`);
    const { sig, ...unsigned } = receipt;
    if (!verifySig(canonicalJson(unsigned), sig)) return fail("bad signature");
    prevJson = row.json;
    expectedSeq++;
  }

  const cpRow = db.get<{ value: string }>("SELECT value FROM ledger_meta WHERE key = 'checkpoint'");
  if (!cpRow) {
    return { ok: false, count, error: "head checkpoint missing — ledger tail may have been truncated" };
  }
  const cp = JSON.parse(cpRow.value) as {
    chain_id: string;
    seq: number;
    receipt_hash: string;
    kid?: string;
    sig: string;
  };
  const { sig: cpSig, ...cpUnsigned } = cp;
  const cpVerify = cp.kid === undefined ? undefined : keys.get(cp.kid);
  if (!cpVerify || !cpVerify(canonicalJson(cpUnsigned), cpSig)) {
    return { ok: false, count, error: "head checkpoint signature invalid" };
  }
  if (cp.chain_id !== chainId) {
    return { ok: false, count, error: "head checkpoint chain_id mismatch" };
  }
  const head = rows[rows.length - 1];
  if (cp.seq !== expectedSeq - 1 || cp.receipt_hash !== sha256(head.json)) {
    return {
      ok: false,
      count,
      badSeq: head.seq,
      error: `ledger tail truncated — checkpoint expects seq ${cp.seq}, ledger ends at ${expectedSeq - 1}`,
    };
  }
  return { ok: true, count };
}
