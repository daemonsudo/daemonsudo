import { expect, test } from "bun:test";
import { join } from "node:path";
import { ApprovalBroker, type ParkedCall } from "../src/broker.js";
import type { Rule } from "../src/config.js";
import { DecisionCore, type CoreCall } from "../src/core.js";
import { openDb, type Db } from "../src/db.js";
import { Ledger, loadOrCreateKeys, makeSigner, type Receipt } from "../src/ledger.js";
import { YamlGlobEngine } from "../src/rules.js";
import { tmpDir } from "./helpers.js";

async function setup(rules: Rule[], opts: { broker?: boolean; timeoutMs?: number } = {}) {
  const db = await openDb(join(tmpDir(), "gate.db"));
  const ledger = new Ledger(db, [], makeSigner(loadOrCreateKeys(db)));
  const broker = opts.broker === false ? undefined : new ApprovalBroker(db, opts.timeoutMs ?? 60_000);
  const core = new DecisionCore(new YamlGlobEngine(rules, "auto"), ledger, broker);
  return { db, broker, core };
}

function receipts(db: Db): Receipt[] {
  return db
    .all<{ json: string }>("SELECT json FROM receipts ORDER BY seq ASC")
    .map((r) => JSON.parse(r.json) as Receipt);
}

const CALL: CoreCall = {
  server: "mock",
  tool: "delete_row",
  args: { table: "users", id: 7 },
  requester: { client: "test 1.0", session: "sess", call_id: "42" },
  origin: "mcp",
};

test("auto: execute outcome, receipt only on recordResult", async () => {
  const { db, core } = await setup([{ pattern: "delete_row", action: "auto" }]);
  const outcome = await core.evaluate(CALL);
  if (outcome.kind !== "execute") throw new Error("expected execute");
  expect(outcome.decision).toBe("auto");
  expect(outcome.rule).toBe("delete_row: auto");
  expect(receipts(db).length).toBe(0);

  outcome.recordResult({ status: "ok", content_hash: "sha256:abc" });
  const [r] = receipts(db);
  expect(Object.keys(r).sort()).toEqual([
    "args_hash", "args_redacted", "chain_id", "decision", "gate_hash", "id", "kid",
    "prev_hash", "requester", "result", "rule", "schema", "seq", "server", "sig", "tool", "ts",
  ]);
  expect(r.decision).toBe("auto");
  expect(r.server).toBe("mock");
  expect(r.tool).toBe("delete_row");
  expect(r.args_redacted).toEqual({ table: "users", id: 7 });
  expect(r.requester).toEqual({ client: "test 1.0", session: "sess", call_id: "42" });
  expect(r.result).toEqual({ status: "ok", content_hash: "sha256:abc" });
  db.close();
});

test("deny rule: block outcome, terminal receipt exactly once", async () => {
  const { db, core } = await setup([{ pattern: "delete_*", action: "deny" }]);
  const outcome = await core.evaluate(CALL);
  if (outcome.kind !== "block") throw new Error("expected block");
  expect(outcome.decision).toBe("denied");
  expect(outcome.blockedBy).toBe("rule");
  const rs = receipts(db);
  expect(rs.length).toBe(1);
  expect(Object.keys(rs[0]).sort()).toEqual([
    "args_hash", "args_redacted", "chain_id", "decision", "gate_hash", "id", "kid",
    "prev_hash", "requester", "rule", "schema", "seq", "server", "sig", "tool", "ts",
  ]);
  expect(rs[0].decision).toBe("denied");
  expect(rs[0].rule).toBe("delete_*: deny");
  expect(rs[0].approver).toBeUndefined();
  expect(rs[0].result).toBeUndefined();
  db.close();
});

test("approve → approved: execute outcome carries approver", async () => {
  const { db, broker, core } = await setup([{ pattern: "delete_row", action: "approve" }]);
  let parked: ParkedCall | undefined;
  const pending = core.evaluate(CALL, { onParked: (p) => { parked = p; } });
  await new Promise((r) => setTimeout(r, 10));
  expect(parked).toBeDefined();
  expect(broker!.get(parked!.id)?.origin).toBe("mcp");
  broker!.decide(parked!.id, { approve: true, channel: "web", user: "web", token: parked!.token });

  const outcome = await pending;
  if (outcome.kind !== "execute") throw new Error("expected execute");
  expect(outcome.decision).toBe("approved");
  expect(outcome.approver?.channel).toBe("web");
  expect(receipts(db).length).toBe(0);
  outcome.recordResult({ status: "ok", content_hash: "sha256:abc" });
  const [r] = receipts(db);
  expect(r.decision).toBe("approved");
  expect(r.approver?.channel).toBe("web");
  expect(r.approver?.user).toBe("web");
  expect(typeof r.approver?.latency_ms).toBe("number");
  db.close();
});

test("approve → denied by approver: terminal receipt exactly once, with approver", async () => {
  const { db, broker, core } = await setup([{ pattern: "delete_row", action: "approve" }]);
  let parked: ParkedCall | undefined;
  const pending = core.evaluate(CALL, { onParked: (p) => { parked = p; } });
  await new Promise((r) => setTimeout(r, 10));
  broker!.decide(parked!.id, { approve: false, channel: "telegram", user: "99", token: parked!.token });

  const outcome = await pending;
  if (outcome.kind !== "block") throw new Error("expected block");
  expect(outcome.decision).toBe("denied");
  expect(outcome.blockedBy).toBe("approver");
  expect(outcome.approver).toEqual({ channel: "telegram", user: "99" });
  const rs = receipts(db);
  expect(rs.length).toBe(1);
  expect(rs[0].decision).toBe("denied");
  expect(rs[0].approver).toEqual({ channel: "telegram", user: "99", latency_ms: rs[0].approver!.latency_ms });
  db.close();
});

test("approve → timeout: terminal receipt exactly once, no approver", async () => {
  const { db, core } = await setup([{ pattern: "delete_row", action: "approve" }], { timeoutMs: 50 });
  const outcome = await core.evaluate(CALL);
  if (outcome.kind !== "block") throw new Error("expected block");
  expect(outcome.decision).toBe("timeout");
  expect(outcome.blockedBy).toBeUndefined();
  const rs = receipts(db);
  expect(rs.length).toBe(1);
  expect(rs[0].decision).toBe("timeout");
  expect(rs[0].approver).toBeUndefined();
  db.close();
});

test("approve with no broker: fails closed with a denied receipt", async () => {
  const { db, core } = await setup([{ pattern: "delete_row", action: "approve" }], { broker: false });
  const outcome = await core.evaluate(CALL);
  if (outcome.kind !== "block") throw new Error("expected block");
  expect(outcome.decision).toBe("denied");
  expect(outcome.blockedBy).toBe("no-broker");
  const rs = receipts(db);
  expect(rs.length).toBe(1);
  expect(rs[0].decision).toBe("denied");
  db.close();
});

test("parkOnly parks with cc origin and no rules involvement", async () => {
  const { db, broker, core } = await setup([{ pattern: "*", action: "deny" }]);
  const parked = core.parkOnly({ server: "claude-code", tool: "Bash", args: { command: "ls" }, rule: "ask", origin: "cc" });
  expect(broker!.get(parked.id)?.origin).toBe("cc");
  broker!.decide(parked.id, { approve: true, channel: "web", user: "web", token: parked.token });
  expect((await parked.decision).status).toBe("approved");
  expect(receipts(db).length).toBe(0); // parkOnly writes no receipts — the door owns them
  db.close();
});
