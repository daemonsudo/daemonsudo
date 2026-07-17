/**
 * Stage 5 chaos tests (port 14921): remote-broker mode must fail closed in
 * every direction — daemon killed mid-approval, daemon never started (auto
 * included), and proxy killed mid-park (daemon cancels the orphan).
 */
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "../src/db.js";
import { connectThroughGate, MOCK, ROOT, spawnServe, tmpDir } from "./helpers.js";

const BASE = "http://127.0.0.1:14921";

const DAEMON_YAML = `defaults: auto
timeout: 30s
rules:
  delete_thing: approve
channels:
  web: { host: "127.0.0.1", port: 14921 }
`;

async function waitForPending(db: Db): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const row = db.get<{ id: string }>("SELECT id FROM pending WHERE status = 'pending' LIMIT 1");
    if (row) return row.id;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no pending approval appeared");
}

test("(a) daemon SIGKILLed mid-approval → in-band error, nothing executed, no execution receipt", async () => {
  const dir = tmpDir();
  const daemonDb = join(dir, "daemon.db");
  const tokenPath = join(dir, "serve.token");
  const mockLog = join(dir, "mock.log");
  writeFileSync(mockLog, "");

  const serve = await spawnServe({
    configYaml: DAEMON_YAML,
    db: daemonDb,
    tokenPath,
    healthUrls: [BASE],
  });
  const client = await connectThroughGate({
    env: { DAEMONSUDO_REMOTE_URL: BASE, DAEMONSUDO_TOKEN_PATH: tokenPath, MOCK_LOG: mockLog },
  });

  const call = client.callTool({ name: "delete_thing", arguments: { id: "boom" } });
  const db = await openDb(daemonDb);
  await waitForPending(db);
  serve.kill("SIGKILL"); // the decision dies with the daemon, no graceful goodbye

  const result = await call;
  expect(result.isError).toBe(true); // fail closed, in-band
  expect(readFileSync(mockLog, "utf8")).toBe("");
  const executed = db.all("SELECT * FROM receipts WHERE decision IN ('auto', 'approved')");
  expect(executed).toEqual([]);
  db.close();
  await client.close().catch(() => {});
}, 30000);

test("(b) daemon never started → would-be-auto call denied in-band (fail-closed includes auto)", async () => {
  const dir = tmpDir();
  const mockLog = join(dir, "mock.log");
  writeFileSync(mockLog, "");

  const client = await connectThroughGate({
    env: { DAEMONSUDO_REMOTE_URL: "http://127.0.0.1:14998", MOCK_LOG: mockLog },
  });
  const result = await client.callTool({ name: "read_thing", arguments: { id: "auto1" } });
  expect(result.isError).toBe(true);
  expect((result.content as Array<{ text: string }>)[0].text).toContain("fail closed");
  expect(readFileSync(mockLog, "utf8")).toBe("");
  await client.close().catch(() => {});
}, 30000);

test("(c) proxy SIGKILLed mid-park → daemon cancels the pending row", async () => {
  const dir = tmpDir();
  const daemonDb = join(dir, "daemon.db");
  const tokenPath = join(dir, "serve.token");
  const mockLog = join(dir, "mock.log");
  writeFileSync(mockLog, "");

  const serve = await spawnServe({
    configYaml: DAEMON_YAML,
    db: daemonDb,
    tokenPath,
    healthUrls: [BASE],
  });

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(ROOT, "src", "index.ts"), "--", ...MOCK],
    env: { ...env, DAEMONSUDO_REMOTE_URL: BASE, DAEMONSUDO_TOKEN_PATH: tokenPath, MOCK_LOG: mockLog },
    stderr: "inherit",
  });
  const client = new Client({ name: "chaos-client", version: "0.0.0" });
  await client.connect(transport);

  const call = client.callTool({ name: "delete_thing", arguments: { id: "orphan" } });
  call.catch(() => {}); // the request dies with the proxy below
  const db = await openDb(daemonDb);
  const pendingId = await waitForPending(db);

  process.kill(transport.pid!, "SIGKILL");

  // daemon notices the dropped socket and cancels the orphan
  let status = "pending";
  for (let i = 0; i < 100 && status === "pending"; i++) {
    status = db.get<{ status: string }>("SELECT status FROM pending WHERE id = ?", [pendingId])!.status;
    if (status === "pending") await new Promise((r) => setTimeout(r, 100));
  }
  expect(status).toBe("denied");
  const reason = db.get<{ decided_reason: string }>(
    "SELECT decided_reason FROM pending WHERE id = ?", [pendingId],
  );
  expect(reason?.decided_reason).toBe("proxy-disconnect");
  expect(readFileSync(mockLog, "utf8")).toBe("");

  db.close();
  serve.kill();
  await client.close().catch(() => {});
}, 30000);
