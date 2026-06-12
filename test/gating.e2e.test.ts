// Stage 2 exit test: rules engine drives auto/deny through the live proxy,
// every decision leaves a receipt, denied calls never reach the server.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import type { Receipt } from "../src/ledger.js";
import { connectThroughGate, ROOT, tmpDir } from "./helpers.js";

const FIXTURE = join(ROOT, "test", "fixtures", "gating.yaml");

describe("rule-gated calls", () => {
  test("auto executes, deny blocks, approve fails closed without channels", async () => {
    const dir = tmpDir();
    const dbPath = join(dir, "gate.db");
    const mockLog = join(dir, "mock.log");
    writeFileSync(mockLog, "");

    const client = await connectThroughGate({
      config: FIXTURE,
      env: { DAEMONSUDO_DB: dbPath, MOCK_LOG: mockLog },
    });

    // auto → passes through
    const ok = await client.callTool({ name: "read_thing", arguments: { id: "a1" } });
    expect(ok.isError).toBeFalsy();
    expect((ok.content as Array<{ text: string }>)[0].text).toBe("thing a1: 42");

    // deny → in-band tool error, never executed
    const denied = await client.callTool({ name: "drop_things", arguments: {} });
    expect(denied.isError).toBe(true);
    expect((denied.content as Array<{ text: string }>)[0].text).toContain("drop_*: deny");

    // approve-matched with nobody approving → parked, then denied on timeout
    const closed = await client.callTool({
      name: "send_thing",
      arguments: { id: "a1", to: "x", password: "hunter2" },
    });
    expect(closed.isError).toBe(true);
    expect((closed.content as Array<{ text: string }>)[0].text).toContain("timed out");

    // only the auto call reached the mock server
    expect(readFileSync(mockLog, "utf8").trim().split("\n")).toEqual(["read_thing a1"]);

    // receipts: one per decision, chained, secrets redacted
    const db = await openDb(dbPath);
    const receipts = db
      .all<{ json: string }>("SELECT json FROM receipts ORDER BY seq ASC")
      .map((r) => JSON.parse(r.json) as Receipt);
    expect(receipts.map((r) => [r.tool, r.decision])).toEqual([
      ["read_thing", "auto"],
      ["drop_things", "denied"],
      ["send_thing", "timeout"],
    ]);
    expect(receipts[0].result?.status).toBe("ok");
    expect(receipts[0].server).toBe("mock-things");
    expect(JSON.stringify(receipts)).not.toContain("hunter2");
    // requester correlation: MCP client identity + one session across the run
    expect(receipts[0].requester?.client).toBeTruthy();
    expect(receipts[0].requester?.call_id).toBeTruthy();
    expect(receipts.map((r) => r.requester?.session)).toEqual(
      Array(3).fill(receipts[0].requester?.session),
    );
    db.close();

    await client.close();
  }, 20000);
});
