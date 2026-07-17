/**
 * Stage 3 exit test: full grant lifecycle through the real MCP gate.
 * Port 14917. park → approve-with-15m-grant → executes; second call executes
 * with NO new pending row and a grant_id receipt; CLI revoke (direct-DB
 * fallback — second ledger writer) → third call parks again; chain verifies.
 */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "../src/db.js";
import { makeVerifier, verifyChain, type Receipt } from "../src/ledger.js";
import { connectThroughGate, GATE_CMD, ROOT, tmpDir } from "./helpers.js";

const WEB = "http://127.0.0.1:14917";

function receipts(db: Db): Receipt[] {
  return db
    .all<{ json: string }>("SELECT json FROM receipts ORDER BY seq ASC")
    .map((r) => JSON.parse(r.json) as Receipt);
}

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

test("grant lifecycle: approve-with-grant → silent second call → revoke → parks again", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gate.db");
  const mockLog = join(dir, "mock.log");
  writeFileSync(mockLog, "");

  const client = await connectThroughGate({
    config: join(ROOT, "test", "fixtures", "grants.yaml"),
    env: { DAEMONSUDO_DB: dbPath, MOCK_LOG: mockLog },
  });
  const db = await openDb(dbPath);

  // 1. first call parks; approve with a 15m grant
  const first = client.callTool({ name: "delete_thing", arguments: { id: "g1" } });
  const pending = await waitForPending(db);
  const ok = await fetch(`${WEB}/approve/${pending.id}`, {
    method: "POST",
    body: new URLSearchParams({ t: pending.token, action: "g15" }),
  });
  expect(ok.status).toBe(200);
  expect((await first).isError).toBeFalsy();

  const afterFirst = receipts(db);
  const approving = afterFirst.at(-1)!;
  expect(approving.decision).toBe("approved");
  expect(approving.grant).toBeDefined();
  const grantId = approving.grant!.id;

  // 2. second call executes with NO new pending row
  const pendingRowsBefore = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pending")!.n;
  const second = await client.callTool({ name: "delete_thing", arguments: { id: "g2" } });
  expect(second.isError).toBeFalsy();
  expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pending")!.n).toBe(pendingRowsBefore);
  const secondReceipt = receipts(db).at(-1)!;
  expect(secondReceipt.grant_id).toBe(grantId);
  expect(secondReceipt.decision).toBe("approved");
  expect(secondReceipt.approver?.latency_ms).toBe(0);

  // 3. CLI revoke — daemon probe fails (dead port) → direct-DB path, a second ledger writer
  const revoke = Bun.spawnSync(
    [...GATE_CMD, "revoke", grantId, "--db", dbPath],
    { env: { ...process.env, DAEMONSUDO_DB: dbPath, DAEMONSUDO_BASE_URL: "http://127.0.0.1:14999" } },
  );
  expect(revoke.exitCode).toBe(0);
  expect(String(revoke.stdout)).toContain(`revoked ${grantId}`);

  const revokeReceipt = receipts(db).at(-1)!;
  expect(revokeReceipt.tool).toBe("grant.revoke");
  expect(revokeReceipt.server).toBe("daemonsudo");
  expect(revokeReceipt.grant_id).toBe(grantId);

  // 4. third call parks again — deny it to finish
  const third = client.callTool({ name: "delete_thing", arguments: { id: "g3" } });
  const pending3 = await waitForPending(db);
  await fetch(`${WEB}/approve/${pending3.id}`, {
    method: "POST",
    body: new URLSearchParams({ t: pending3.token, action: "deny", reason: "grant revoked" }),
  });
  const thirdResult = await third;
  expect(thirdResult.isError).toBe(true);
  expect((thirdResult.content as Array<{ text: string }>)[0].text).toContain("grant revoked");

  // only the two granted calls ever reached the mock
  expect(
    (await Bun.file(mockLog).text()).trim().split("\n"),
  ).toEqual(["delete_thing g1", "delete_thing g2"]);

  // 5. two writers, one chain — verify end to end
  const keys = db.all<{ kid: string; public_hex: string }>("SELECT kid, public_hex FROM keys");
  const result = verifyChain(db, new Map(keys.map((k) => [k.kid, makeVerifier(k.public_hex)])));
  expect(result.ok).toBe(true);

  db.close();
  await client.close();
}, 30000);
