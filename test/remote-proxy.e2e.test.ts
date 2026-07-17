/**
 * Stage 5 exit test: MCP remote-broker mode. The proxy holds no policy, keys,
 * or db — the daemon (port 14920) decides and owns every receipt.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { openDb, type Db } from "../src/db.js";
import { makeVerifier, verifyChain, type Receipt } from "../src/ledger.js";
import { connectThroughGate, spawnServe, tmpDir } from "./helpers.js";

const BASE = "http://127.0.0.1:14920";
const DIR = tmpDir();
const DAEMON_DB = join(DIR, "daemon.db");
const TOKEN_PATH = join(DIR, "serve.token");
const PROXY_DB = join(DIR, "proxy-should-never-exist.db");
const MOCK_LOG = join(DIR, "mock.log");

let serve: { kill(): void } | undefined;
let client: Client;
let db: Db;

function receipts(): Receipt[] {
  return db
    .all<{ json: string }>("SELECT json FROM receipts ORDER BY seq ASC")
    .map((r) => JSON.parse(r.json) as Receipt);
}

async function waitForPending(): Promise<{ id: string; token: string }> {
  for (let i = 0; i < 100; i++) {
    const row = db.get<{ id: string; token: string }>(
      "SELECT id, token FROM pending WHERE status = 'pending' LIMIT 1",
    );
    if (row) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no pending approval appeared in the daemon db");
}

function decide(id: string, token: string, action: string, reason?: string) {
  return fetch(`${BASE}/approve/${id}`, {
    method: "POST",
    body: new URLSearchParams({ t: token, action, ...(reason ? { reason } : {}) }),
  });
}

beforeAll(async () => {
  writeFileSync(MOCK_LOG, "");
  serve = await spawnServe({
    configYaml: `defaults: auto
timeout: 30s
rules:
  delete_thing: approve
channels:
  web: { host: "127.0.0.1", port: 14920 }
`,
    db: DAEMON_DB,
    tokenPath: TOKEN_PATH,
    healthUrls: [BASE],
  });
  client = await connectThroughGate({
    env: {
      DAEMONSUDO_REMOTE_URL: BASE,
      DAEMONSUDO_TOKEN_PATH: TOKEN_PATH,
      DAEMONSUDO_DB: PROXY_DB,
      MOCK_LOG,
    },
  });
  db = await openDb(DAEMON_DB);
});

afterAll(async () => {
  db?.close();
  await client?.close().catch(() => {});
  serve?.kill();
});

test("auto call executes via remote decide; receipt lands in the DAEMON's db", async () => {
  const result = await client.callTool({ name: "read_thing", arguments: { id: "r1" } });
  expect(result.isError).toBeFalsy();
  const r = receipts().at(-1)!;
  expect(r.decision).toBe("auto");
  expect(r.tool).toBe("read_thing");
  expect(r.server).toBe("mock-things");
  expect(r.result?.status).toBe("ok");
  // the proxy never opened a local db
  expect(existsSync(PROXY_DB)).toBe(false);
});

test("approve → executes; receipt approved with approver", async () => {
  const call = client.callTool({ name: "delete_thing", arguments: { id: "r2" } });
  const pending = await waitForPending();
  expect((await decide(pending.id, pending.token, "approve")).ok).toBe(true);
  expect((await call).isError).toBeFalsy();
  const r = receipts().at(-1)!;
  expect(r.decision).toBe("approved");
  expect(r.approver?.channel).toBe("web");
  expect(r.result?.status).toBe("ok");
});

test("deny → in-band isError with the approver's reason", async () => {
  const call = client.callTool({ name: "delete_thing", arguments: { id: "r3" } });
  const pending = await waitForPending();
  await decide(pending.id, pending.token, "deny", "not on my watch");
  const result = await call;
  expect(result.isError).toBe(true);
  expect((result.content as Array<{ text: string }>)[0].text).toContain("not on my watch");
  const r = receipts().at(-1)!;
  expect(r.decision).toBe("denied");
  expect(r.reason).toBe("not on my watch");
});

test("grant → second call skips parking; receipt carries grant_id", async () => {
  const call = client.callTool({ name: "delete_thing", arguments: { id: "r4" } });
  const pending = await waitForPending();
  await decide(pending.id, pending.token, "g15");
  expect((await call).isError).toBeFalsy();
  const grantId = receipts().at(-1)!.grant!.id;

  const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pending")!.n;
  const second = await client.callTool({ name: "delete_thing", arguments: { id: "r5" } });
  expect(second.isError).toBeFalsy();
  expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pending")!.n).toBe(before);
  expect(receipts().at(-1)!.grant_id).toBe(grantId);
});

test("only allowed calls reached the mock; daemon chain verifies", async () => {
  expect(readFileSync(MOCK_LOG, "utf8").trim().split("\n")).toEqual([
    "read_thing r1",
    "delete_thing r2",
    "delete_thing r4",
    "delete_thing r5",
  ]);
  const keys = db.all<{ kid: string; public_hex: string }>("SELECT kid, public_hex FROM keys");
  expect(verifyChain(db, new Map(keys.map((k) => [k.kid, makeVerifier(k.public_hex)]))).ok).toBe(true);
});
