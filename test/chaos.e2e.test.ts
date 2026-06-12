// Chaos test (hard invariant #1): kill the gate mid-approval → the call must
// fail closed. No orphan execution, not even after a new gate adopts the db.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalBroker } from "../src/broker.js";
import { openDb } from "../src/db.js";
import { MOCK, ROOT, tmpDir } from "./helpers.js";

describe("chaos: gate killed mid-approval", () => {
  test("parked call never executes — before or after restart", async () => {
    const dir = tmpDir();
    const dbPath = join(dir, "gate.db");
    const mockLog = join(dir, "mock.log");
    writeFileSync(mockLog, "");

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    const transport = new StdioClientTransport({
      command: "bun",
      args: [
        join(ROOT, "src", "index.ts"),
        "--config", join(ROOT, "test", "fixtures", "chaos.yaml"),
        "--", ...MOCK,
      ],
      env: { ...env, DAEMONSUDO_DB: dbPath, MOCK_LOG: mockLog },
      stderr: "inherit",
    });
    const client = new Client({ name: "chaos-client", version: "0.0.0" });
    await client.connect(transport);

    // park a risky call, then murder the gate while it waits for a human
    const callPromise = client.callTool({ name: "delete_thing", arguments: { id: "boom" } });
    const db = await openDb(dbPath);
    let pendingId = "";
    for (let i = 0; i < 100 && !pendingId; i++) {
      const row = db.get<{ id: string }>("SELECT id FROM pending WHERE status = 'pending'");
      if (row) pendingId = row.id;
      else await new Promise((r) => setTimeout(r, 100));
    }
    expect(pendingId).not.toBe("");

    expect(transport.pid).toBeTruthy();
    process.kill(transport.pid!, "SIGKILL");

    // the client's request dies with the gate — it must not succeed
    await expect(callPromise).rejects.toThrow();

    // nothing executed downstream
    expect(readFileSync(mockLog, "utf8")).toBe("");

    // a fresh gate adopting this db closes out the orphaned pending call
    new ApprovalBroker(db, 60_000);
    const row = db.get<{ status: string }>("SELECT status FROM pending WHERE id = ?", [pendingId]);
    expect(row?.status).toBe("timeout");

    // still nothing executed, and no receipt claims execution
    expect(readFileSync(mockLog, "utf8")).toBe("");
    const executed = db.all(
      "SELECT * FROM receipts WHERE decision IN ('auto', 'approved')",
    );
    expect(executed).toEqual([]);

    db.close();
    await client.close().catch(() => {});
    expect(existsSync(mockLog)).toBe(true);
  }, 30000);
});
