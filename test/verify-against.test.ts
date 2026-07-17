/**
 * Stage 6 exit test: verify --against catches the attack local verify can't
 * see — the KEY HOLDER truncating or rewriting the ledger and re-signing a
 * fresh head checkpoint. The mirror's witnessed checkpoints break the lie.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { openDb, type Db } from "../src/db.js";
import {
  canonicalJson,
  Ledger,
  loadOrCreateKeys,
  makeSigner,
  makeVerifier,
  sha256,
  verifyAgainstMirror,
  verifyChain,
  type Checkpoint,
  type KeyPair,
  type Receipt,
  type VerifierFn,
} from "../src/ledger.js";
import { tmpDir } from "./helpers.js";

async function build(n: number): Promise<{
  db: Db;
  keys: KeyPair;
  verifiers: Map<string, VerifierFn>;
  mirrored: Checkpoint[];
}> {
  const db = await openDb(join(tmpDir(), "gate.db"));
  const keys = loadOrCreateKeys(db);
  const captured: Checkpoint[] = [];
  const ledger = new Ledger(db, [], makeSigner(keys), undefined, (c) => captured.push(JSON.parse(c) as Checkpoint));
  for (let i = 1; i <= n; i++) {
    ledger.append({ server: "m", tool: `tool_${i}`, args: { i }, decision: "auto", rule: "r" });
  }
  return { db, keys, verifiers: new Map([[keys.kid, makeVerifier(keys.publicHex)]]), mirrored: captured };
}

/** What the attacker (who holds the signing key) does after tampering: re-sign a fresh head. */
function resignHead(db: Db, keys: KeyPair): void {
  const head = db.get<{ seq: number; json: string }>("SELECT seq, json FROM receipts ORDER BY seq DESC LIMIT 1")!;
  const chainId = db.get<{ value: string }>("SELECT value FROM ledger_meta WHERE key = 'chain_id'")!.value;
  const payload = { chain_id: chainId, seq: head.seq, receipt_hash: sha256(head.json), kid: keys.kid };
  const sig = makeSigner(keys).sign(canonicalJson(payload));
  db.run("UPDATE ledger_meta SET value = ? WHERE key = 'checkpoint'", [canonicalJson({ ...payload, sig })]);
}

test("truncation: newest rows deleted + head re-signed → local verify passes, --against flags it", async () => {
  const { db, keys, verifiers, mirrored } = await build(5);

  db.run("DELETE FROM receipts WHERE seq > 3");
  resignHead(db, keys);

  // the agent holds the key, so the local chain looks pristine
  expect(verifyChain(db, verifiers).ok).toBe(true);

  const res = verifyAgainstMirror(db, verifiers, mirrored);
  expect(res.ok).toBe(false);
  expect(res.error).toContain("truncated");
  expect(res.badSeq).toBe(4); // the first mirrored checkpoint past the local head
  db.close();
});

test("rewrite: receipt k rewritten + suffix re-signed → local verify passes, --against flags seq k", async () => {
  const { db, keys, verifiers, mirrored } = await build(4);
  const signer = makeSigner(keys);

  // rewrite receipt #2, then re-chain and re-sign everything after it
  const rows = db.all<{ seq: number; json: string }>("SELECT seq, json FROM receipts ORDER BY seq ASC");
  let prevJson: string | null = null;
  for (const row of rows) {
    const receipt = JSON.parse(row.json) as Receipt;
    const { sig: _sig, ...unsigned } = receipt;
    if (row.seq < 2) {
      prevJson = row.json;
      continue;
    }
    if (row.seq === 2) unsigned.tool = "innocent_looking_tool";
    unsigned.prev_hash = sha256(prevJson ?? "daemonsudo-genesis");
    const sig = signer.sign(canonicalJson(unsigned));
    const json = canonicalJson({ ...unsigned, sig });
    db.run("UPDATE receipts SET json = ? WHERE seq = ?", [json, row.seq]);
    prevJson = json;
  }
  resignHead(db, keys);

  expect(verifyChain(db, verifiers).ok).toBe(true); // the lie is self-consistent

  const res = verifyAgainstMirror(db, verifiers, mirrored);
  expect(res.ok).toBe(false);
  expect(res.error).toContain("rewritten");
  expect(res.badSeq).toBe(2);
  db.close();
});

test("clean ledger passes --against; forged mirror checkpoints are rejected", async () => {
  const { db, verifiers, mirrored } = await build(3);
  expect(verifyAgainstMirror(db, verifiers, mirrored).ok).toBe(true);

  // a mirror entry not signed by our key must not be trusted
  const chainId = mirrored[0].chain_id;
  const forged: Checkpoint = { chain_id: chainId, seq: 99, receipt_hash: "sha256:ff", kid: mirrored[0].kid, sig: "ed25519:00" };
  const res = verifyAgainstMirror(db, verifiers, [...mirrored, forged]);
  expect(res.ok).toBe(false);
  expect(res.error).toContain("invalid signature");
  db.close();
});
