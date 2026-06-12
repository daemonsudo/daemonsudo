// Stage 3 exit test: approve-matched calls park, a web decision releases or
// blocks them, timeouts deny. The downstream server only ever executes after
// an explicit approve.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "../src/db.js";
import type { Receipt } from "../src/ledger.js";
import { connectThroughGate, ROOT, tmpDir } from "./helpers.js";

const WEB = "http://127.0.0.1:14911";

async function waitForPending(db: Db): Promise<{ id: string; token: string }> {
  for (let i = 0; i < 100; i++) {
    const row = db.get<{ id: string; token: string }>(
      "SELECT id, token FROM pending WHERE status = 'pending' LIMIT 1",
    );
    if (row) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no pending approval appeared");
}

function receipts(db: Db): Receipt[] {
  return db
    .all<{ json: string }>("SELECT json FROM receipts ORDER BY seq ASC")
    .map((r) => JSON.parse(r.json) as Receipt);
}

describe("web approval flow", () => {
  test("park → web approve → execute; deny blocks; bad token rejected", async () => {
    const dir = tmpDir();
    const dbPath = join(dir, "gate.db");
    const mockLog = join(dir, "mock.log");
    writeFileSync(mockLog, "");

    const client = await connectThroughGate({
      config: join(ROOT, "test", "fixtures", "approval.yaml"),
      env: { DAEMONSUDO_DB: dbPath, MOCK_LOG: mockLog },
    });
    const db = await openDb(dbPath);

    // --- approve path ---
    const callPromise = client.callTool({ name: "delete_thing", arguments: { id: "d1" } });
    const { id, token } = await waitForPending(db);

    // approval card renders the args as inert text
    const card = await fetch(`${WEB}/approve/${id}?t=${token}`);
    expect(card.status).toBe(200);
    const cardHtml = await card.text();
    expect(cardHtml).toContain("delete_thing");
    expect(cardHtml).toContain("&quot;d1&quot;");

    // a wrong token must not decide anything
    const forged = await fetch(`${WEB}/approve/${id}`, {
      method: "POST",
      body: new URLSearchParams({ t: "0".repeat(32), action: "approve" }),
    });
    expect(forged.status).toBe(400);
    expect(readFileSync(mockLog, "utf8")).toBe("");

    const ok = await fetch(`${WEB}/approve/${id}`, {
      method: "POST",
      body: new URLSearchParams({ t: token, action: "approve" }),
    });
    expect(ok.status).toBe(200);

    const result = await callPromise;
    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text: string }>)[0].text).toBe("deleted thing d1");
    expect(readFileSync(mockLog, "utf8").trim()).toBe("delete_thing d1");

    // deciding twice fails
    const again = await fetch(`${WEB}/approve/${id}`, {
      method: "POST",
      body: new URLSearchParams({ t: token, action: "approve" }),
    });
    expect(again.status).toBe(400);

    // --- deny path ---
    const denyPromise = client.callTool({
      name: "send_thing",
      arguments: { id: "d2", to: "x", password: "hunter2" },
    });
    const pend2 = await waitForPending(db);
    const no = await fetch(`${WEB}/approve/${pend2.id}`, {
      method: "POST",
      body: new URLSearchParams({ t: pend2.token, action: "deny" }),
    });
    expect(no.status).toBe(200);
    const denied = await denyPromise;
    expect(denied.isError).toBe(true);
    expect((denied.content as Array<{ text: string }>)[0].text).toContain("not executed");
    expect(readFileSync(mockLog, "utf8").trim()).toBe("delete_thing d1"); // send never ran

    // --- receipts ---
    const all = receipts(db);
    expect(all.map((r) => [r.tool, r.decision])).toEqual([
      ["delete_thing", "approved"],
      ["send_thing", "denied"],
    ]);
    expect(all[0].approver?.channel).toBe("web");
    expect(all[0].approver?.latency_ms).toBeGreaterThan(0);
    expect(all[0].result?.status).toBe("ok");
    expect(JSON.stringify(all)).not.toContain("hunter2");

    db.close();
    await client.close();
  }, 30000);

  test("approval timeout denies the call", async () => {
    const dir = tmpDir();
    const dbPath = join(dir, "gate.db");
    const mockLog = join(dir, "mock.log");
    writeFileSync(mockLog, "");

    const client = await connectThroughGate({
      config: join(ROOT, "test", "fixtures", "approval-timeout.yaml"),
      env: { DAEMONSUDO_DB: dbPath, MOCK_LOG: mockLog },
    });

    const result = await client.callTool({ name: "delete_thing", arguments: { id: "t1" } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain("timed out");
    expect(readFileSync(mockLog, "utf8")).toBe("");

    const db = await openDb(dbPath);
    const all = receipts(db);
    expect(all.map((r) => [r.tool, r.decision])).toEqual([["delete_thing", "timeout"]]);
    db.close();
    await client.close();
  }, 30000);
});
