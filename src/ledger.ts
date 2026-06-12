/**
 * Receipt ledger: append-only, SHA-256 hash-chained, ed25519-signed.
 * Receipts are stored as canonical JSON; `prev_hash` chains each receipt to
 * the full stored JSON of the previous one. Signatures cover the canonical
 * JSON of the receipt minus its `sig` field.
 */
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import type { Db } from "./db.js";

export type Decision = "auto" | "approved" | "denied" | "timeout" | "error";

export interface Approver {
  channel: string;
  user: string;
  latency_ms: number;
}

export interface Receipt {
  id: string;
  prev_hash: string;
  ts: string;
  server: string;
  tool: string;
  args_hash: string;
  args_redacted: unknown;
  decision: Decision;
  rule: string;
  approver?: Approver;
  result?: { status: "ok" | "error"; content_hash: string };
  sig: string;
}

export interface ReceiptInput {
  server: string;
  tool: string;
  args: unknown;
  decision: Decision;
  rule: string;
  approver?: Approver;
  result?: { status: "ok" | "error"; content_hash: string };
}

export interface Signer {
  sign(payload: string): string;
}

const GENESIS = "daemonsudo-genesis";

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
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

export class Ledger {
  constructor(
    private db: Db,
    private redactGlobs: string[] = [],
    private signer?: Signer,
  ) {}

  append(input: ReceiptInput): Receipt {
    const last = this.db.get<{ json: string }>(
      "SELECT json FROM receipts ORDER BY seq DESC LIMIT 1",
    );
    const unsigned: Omit<Receipt, "sig"> = {
      id: ulid(),
      prev_hash: sha256(last ? last.json : GENESIS),
      ts: new Date().toISOString(),
      server: input.server,
      tool: input.tool,
      args_hash: sha256(canonicalJson(input.args ?? {})),
      args_redacted: redact(input.args ?? {}, this.redactGlobs),
      decision: input.decision,
      rule: input.rule,
      ...(input.approver ? { approver: input.approver } : {}),
      ...(input.result ? { result: input.result } : {}),
    };
    const sig = this.signer ? this.signer.sign(canonicalJson(unsigned)) : "unsigned";
    const receipt: Receipt = { ...unsigned, sig };
    this.db.run(
      "INSERT INTO receipts (id, ts, server, tool, decision, json) VALUES (?, ?, ?, ?, ?, ?)",
      [receipt.id, receipt.ts, receipt.server, receipt.tool, receipt.decision, canonicalJson(receipt)],
    );
    return receipt;
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

/**
 * Walk the chain oldest→newest: each prev_hash must equal the hash of the
 * previous stored receipt, and each signature must verify against the public
 * key. Pure read — usable offline against a copied gate.db.
 */
export function verifyChain(
  db: Db,
  verifySig: (payload: string, sig: string) => boolean,
): VerifyResult {
  const rows = db.all<{ seq: number; json: string }>(
    "SELECT seq, json FROM receipts ORDER BY seq ASC",
  );
  let prevJson: string | null = null;
  for (const row of rows) {
    const receipt = JSON.parse(row.json) as Receipt;
    if (canonicalJson(receipt) !== row.json) {
      return { ok: false, count: rows.length, badSeq: row.seq, error: "stored JSON is not canonical" };
    }
    const expectedPrev = sha256(prevJson ?? GENESIS);
    if (receipt.prev_hash !== expectedPrev) {
      return { ok: false, count: rows.length, badSeq: row.seq, error: "hash chain broken" };
    }
    const { sig, ...unsigned } = receipt;
    if (!verifySig(canonicalJson(unsigned), sig)) {
      return { ok: false, count: rows.length, badSeq: row.seq, error: "bad signature" };
    }
    prevJson = row.json;
  }
  return { ok: true, count: rows.length };
}
