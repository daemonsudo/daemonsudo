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
  decided_at TEXT,
  decided_reason TEXT,
  origin TEXT NOT NULL DEFAULT 'mcp'
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  server TEXT NOT NULL,
  tool TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  session_boot TEXT,
  created_channel TEXT NOT NULL,
  created_user TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  revoked_at TEXT,
  revoke_receipt_id TEXT
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
  migrate(db);
  return db;
}

/**
 * Additive migrations for dbs created before v0.3 (user_version < 2). Fresh
 * dbs get the full v2 shape from SCHEMA; each step is guarded so a
 * half-applied run is safe to repeat. v0.2 binaries opening a v2 db keep
 * working — columns are additive and v0.2 INSERTs use explicit column lists.
 */
function migrate(db: Db): void {
  const version = db.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
  if (version >= 2) return;
  const pendingCols = new Set(
    db.all<{ name: string }>("SELECT name FROM pragma_table_info('pending')").map((c) => c.name),
  );
  if (!pendingCols.has("decided_reason")) {
    db.exec("ALTER TABLE pending ADD COLUMN decided_reason TEXT;");
  }
  if (!pendingCols.has("origin")) {
    db.exec("ALTER TABLE pending ADD COLUMN origin TEXT NOT NULL DEFAULT 'mcp';");
  }
  // grants table already covered by SCHEMA's CREATE TABLE IF NOT EXISTS
  db.exec("PRAGMA user_version = 2;");
}

/** Open without schema/migrations — test fixtures build old-shaped dbs with it. */
export async function openRaw(path: string): Promise<Db> {
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
