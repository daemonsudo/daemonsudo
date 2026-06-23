/**
 * One SQLite file holds everything: pending approvals, receipts, signing keys.
 * Runtime-portable wrapper: bun:sqlite on Bun, node:sqlite on Node ≥24.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Db {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  close(): void;
}

const SCHEMA = `
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

export async function openDb(path: string): Promise<Db> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = await openRaw(path);
  db.exec("PRAGMA journal_mode = WAL;");
  // pre-v1 dbs (keys table keyed by id, no kid) predate the frozen receipt schema
  const legacy = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'keys' AND sql NOT LIKE '%kid%'",
  );
  if (legacy && legacy.n > 0) {
    db.close();
    throw new Error(
      `pre-v1 ledger at ${path} — the daemonsudo/v1 receipt schema is incompatible; move or delete the file`,
    );
  }
  db.exec(SCHEMA);
  return db;
}

async function openRaw(path: string): Promise<Db> {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { create: true });
    return {
      exec: (sql) => db.exec(sql),
      run: (sql, params = []) => void db.query(sql).run(...(params as never[])),
      get: (sql, params = []) => db.query(sql).get(...(params as never[])) ?? undefined,
      all: (sql, params = []) => db.query(sql).all(...(params as never[])),
      close: () => db.close(),
    } as Db;
  }
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    throw new Error(
      "daemonsudo needs SQLite: run with Bun, or Node >= 24 (node:sqlite). " +
        `Current runtime: node ${process.versions.node}`,
    );
  }
  const db = new sqlite.DatabaseSync(path);
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => void db.prepare(sql).run(...(params as never[])),
    get: (sql, params = []) => db.prepare(sql).get(...(params as never[])) as never,
    all: (sql, params = []) => db.prepare(sql).all(...(params as never[])) as never,
    close: () => db.close(),
  } as Db;
}
