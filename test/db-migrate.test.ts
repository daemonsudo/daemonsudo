import { expect, test } from "bun:test";
import { join } from "node:path";
import { openDb, openRaw } from "../src/db.js";
import { Ledger, loadOrCreateKeys, makeSigner, makeVerifier, verifyChain } from "../src/ledger.js";
import { tmpDir } from "./helpers.js";

/** The exact v0.2 schema, as shipped — migration input fixture. */
const V02_SCHEMA = `
CREATE TABLE IF NOT EXISTS receipts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  server TEXT NOT NULL,
  tool TEXT NOT NULL,
  decision TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  server TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  rule TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  token TEXT NOT NULL,
  nonce TEXT NOT NULL,
  decided_channel TEXT,
  decided_user TEXT,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS keys (
  kid TEXT PRIMARY KEY,
  secret_hex TEXT NOT NULL,
  public_hex TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

test("v0.2 db gains columns + grants table on open, chain still verifies", async () => {
  const path = join(tmpDir(), "gate.db");

  // Hand-build a v0.2-shaped db with two signed receipts.
  const old = await openRaw(path);
  old.exec(V02_SCHEMA);
  const oldLedger = new Ledger(old, [], makeSigner(loadOrCreateKeys(old)));
  oldLedger.append({ server: "mock", tool: "read_row", args: { id: 1 }, decision: "auto", rule: "auto" });
  oldLedger.append({ server: "mock", tool: "delete_row", args: { id: 2 }, decision: "denied", rule: "deny" });
  old.close();

  const db = await openDb(path);
  expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(2);

  const cols = db.all<{ name: string }>("SELECT name FROM pragma_table_info('pending')").map((c) => c.name);
  expect(cols).toContain("decided_reason");
  expect(cols).toContain("origin");
  expect(
    db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'grants'"),
  ).toBeDefined();

  // A v0.2 binary's INSERT (explicit column list, no origin) still works.
  db.run(
    `INSERT INTO pending (id, created_at, expires_at, server, tool, args_json, rule, status, token, nonce)
     VALUES ('x', 't', 't', 's', 'tool', '{}', 'r', 'pending', 'tok', 'non')`,
  );
  expect(db.get<{ origin: string }>("SELECT origin FROM pending WHERE id = 'x'")?.origin).toBe("mcp");

  const keys = db.all<{ kid: string; public_hex: string }>("SELECT kid, public_hex FROM keys");
  const result = verifyChain(db, new Map(keys.map((k) => [k.kid, makeVerifier(k.public_hex)])));
  expect(result.ok).toBe(true);
  expect(result.count).toBe(2);
  db.close();

  // Idempotent: a second open leaves the db valid.
  const again = await openDb(path);
  expect(again.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(2);
  again.close();
});

test("pre-v1 dbs are still rejected", async () => {
  const path = join(tmpDir(), "gate.db");
  const legacy = await openRaw(path);
  legacy.exec("CREATE TABLE keys (id TEXT PRIMARY KEY, secret_hex TEXT NOT NULL);");
  legacy.close();
  await expect(openDb(path)).rejects.toThrow(/pre-v1 ledger/);
});
