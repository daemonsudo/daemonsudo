// Stage 4 exit test: receipts are signed, the chain verifies offline, and
// any tampering — edited fields, swapped order, deleted rows — is caught.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb, type Db } from "../src/db.js";
import {
  canonicalJson,
  Ledger,
  loadOrCreateKeys,
  makeSigner,
  makeVerifier,
  verifyChain,
  type Receipt,
} from "../src/ledger.js";
import { tmpDir } from "./helpers.js";

async function signedLedger(): Promise<{ db: Db; ledger: Ledger; publicHex: string }> {
  const db = await openDb(join(tmpDir(), "gate.db"));
  const keys = loadOrCreateKeys(db);
  return { db, ledger: new Ledger(db, [], makeSigner(keys)), publicHex: keys.publicHex };
}

function seed(ledger: Ledger): void {
  ledger.append({ server: "m", tool: "read_thing", args: { id: "1" }, decision: "auto", rule: "read_*: auto" });
  ledger.append({
    server: "m", tool: "delete_thing", args: { id: "2" }, decision: "approved", rule: "delete_*: approve",
    approver: { channel: "web", user: "web", latency_ms: 1200 },
  });
  ledger.append({ server: "m", tool: "drop_things", args: {}, decision: "denied", rule: "drop_*: deny" });
}

describe("signed receipt chain", () => {
  test("keys persist across opens", async () => {
    const db = (await signedLedger()).db;
    const a = loadOrCreateKeys(db);
    const b = loadOrCreateKeys(db);
    expect(a).toEqual(b);
    expect(a.publicHex).toHaveLength(64);
    db.close();
  });

  test("clean chain verifies", async () => {
    const { db, ledger, publicHex } = await signedLedger();
    seed(ledger);
    const res = verifyChain(db, makeVerifier(publicHex));
    expect(res).toEqual({ ok: true, count: 3 });
    db.close();
  });

  test("editing a receipt field breaks verification", async () => {
    const { db, ledger, publicHex } = await signedLedger();
    seed(ledger);
    // attacker rewrites history: the denied call becomes approved
    const row = db.get<{ seq: number; json: string }>(
      "SELECT seq, json FROM receipts WHERE tool = 'drop_things'",
    )!;
    const receipt = JSON.parse(row.json) as Receipt;
    receipt.decision = "approved";
    db.run("UPDATE receipts SET json = ? WHERE seq = ?", [canonicalJson(receipt), row.seq]);

    const res = verifyChain(db, makeVerifier(publicHex));
    expect(res.ok).toBe(false);
    expect(res.badSeq).toBe(row.seq);
    expect(res.error).toBe("bad signature");
    db.close();
  });

  test("deleting a receipt breaks the chain", async () => {
    const { db, ledger, publicHex } = await signedLedger();
    seed(ledger);
    db.run("DELETE FROM receipts WHERE tool = 'delete_thing'", []);
    const res = verifyChain(db, makeVerifier(publicHex));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("hash chain broken");
    db.close();
  });

  test("a receipt re-signed with a different key is rejected", async () => {
    const { db, ledger, publicHex } = await signedLedger();
    seed(ledger);
    const other = await signedLedger(); // different db → different key
    const row = db.get<{ seq: number; json: string }>("SELECT seq, json FROM receipts WHERE tool = 'drop_things'")!;
    const receipt = JSON.parse(row.json) as Receipt;
    receipt.decision = "approved";
    const { sig: _sig, ...unsigned } = receipt;
    const otherKeys = loadOrCreateKeys(other.db);
    const forged: Receipt = {
      ...(unsigned as Omit<Receipt, "sig">),
      sig: makeSigner(otherKeys).sign(canonicalJson(unsigned)),
    };
    db.run("UPDATE receipts SET json = ? WHERE seq = ?", [canonicalJson(forged), row.seq]);
    const res = verifyChain(db, makeVerifier(publicHex));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bad signature");
    db.close();
    other.db.close();
  });
});

describe("daemonsudo verify CLI", () => {
  test("✓ exit 0 on a clean ledger; ✗ exit 1 after tampering", async () => {
    const path = join(tmpDir(), "gate.db");
    const db = await openDb(path);
    const ledger = new Ledger(db, [], makeSigner(loadOrCreateKeys(db)));
    seed(ledger);

    const cli = (...args: string[]) =>
      Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "index.ts"), ...args]);

    const ok = cli("verify", "--db", path);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toContain("✓ 3 receipts verified");

    const list = cli("receipts", "--db", path);
    expect(list.exitCode).toBe(0);
    expect(list.stdout.toString()).toContain("drop_things");

    db.run("UPDATE receipts SET json = replace(json, 'denied', 'approved') WHERE tool = 'drop_things'", []);
    const bad = cli("verify", "--db", path);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("INVALID");

    db.close();
  }, 20000);
});
