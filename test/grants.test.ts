import { expect, test } from "bun:test";
import { join } from "node:path";
import { ulid } from "ulid";
import { ApprovalBroker, type ParkedCall } from "../src/broker.js";
import { DecisionCore, type CoreCall } from "../src/core.js";
import { openDb, type Db } from "../src/db.js";
import { clampTtlMs, expiresAtFor, GrantStore } from "../src/grants.js";
import { Ledger, loadOrCreateKeys, makeSigner, makeVerifier, verifyChain, type Receipt } from "../src/ledger.js";
import { YamlGlobEngine } from "../src/rules.js";
import { tmpDir } from "./helpers.js";

const BOOT = ulid();
const HOUR = 3_600_000;

function receipts(db: Db): Receipt[] {
  return db
    .all<{ json: string }>("SELECT json FROM receipts ORDER BY seq ASC")
    .map((r) => JSON.parse(r.json) as Receipt);
}

async function grantSetup(rules: Array<{ pattern: string; action: "auto" | "approve" | "deny" }>) {
  const db = await openDb(join(tmpDir(), "gate.db"));
  const ledger = new Ledger(db, [], makeSigner(loadOrCreateKeys(db)));
  const broker = new ApprovalBroker(db, 60_000);
  const store = new GrantStore(db);
  const core = new DecisionCore(new YamlGlobEngine(rules, "auto"), ledger, broker, {
    store,
    bootId: BOOT,
    maxTtlMs: 8 * HOUR,
  });
  return { db, ledger, broker, store, core };
}

const CALL: CoreCall = {
  server: "mock",
  tool: "delete_row",
  args: { id: 1 },
  requester: { session: "s", call_id: "1" },
  origin: "mcp",
};

test("findActive: TTL / session / revoked matrix", async () => {
  const db = await openDb(join(tmpDir(), "gate.db"));
  const store = new GrantStore(db);
  const now = new Date();
  const future = new Date(now.getTime() + HOUR).toISOString();
  const past = new Date(now.getTime() - HOUR).toISOString();

  const live = store.create({ server: "s", tool: "t", expiresAt: future, sessionBoot: null, channel: "web", user: "w", receiptId: "r1" });
  expect(store.findActive("s", "t", now, BOOT)?.id).toBe(live.id);
  expect(store.findActive("s", "other", now, BOOT)).toBeUndefined();
  expect(store.findActive("other", "t", now, BOOT)).toBeUndefined();

  // expired timed grant
  store.revoke(live.id, "rr");
  const expired = store.create({ server: "s", tool: "t", expiresAt: past, sessionBoot: null, channel: "web", user: "w", receiptId: "r2" });
  expect(store.findActive("s", "t", now, BOOT)).toBeUndefined();
  expect(store.get(expired.id)).toBeDefined();

  // session grant: only matches its own boot
  const sess = store.create({ server: "s", tool: "t", expiresAt: null, sessionBoot: BOOT, channel: "web", user: "w", receiptId: "r3" });
  expect(store.findActive("s", "t", now, BOOT)?.id).toBe(sess.id);
  expect(store.findActive("s", "t", now, ulid())).toBeUndefined();

  // session grants die (get revoked) on a new boot
  const newBoot = ulid();
  store.expireStaleSessionGrants(newBoot);
  expect(store.get(sess.id)?.revoked_at).toBeTruthy();
  expect(store.findActive("s", "t", now, newBoot)).toBeUndefined();

  // revoked grants never match
  const revived = store.create({ server: "s", tool: "t", expiresAt: future, sessionBoot: null, channel: "web", user: "w", receiptId: "r4" });
  store.revoke(revived.id, "rr2");
  expect(store.findActive("s", "t", now, BOOT)).toBeUndefined();
  db.close();
});

test("TTL clamps to max_ttl", () => {
  expect(clampTtlMs(24 * HOUR, 8 * HOUR)).toBe(8 * HOUR);
  const at = expiresAtFor({ ttlMs: 24 * HOUR }, 8 * HOUR, 0);
  expect(at).toBe(new Date(8 * HOUR).toISOString());
  expect(expiresAtFor({ session: true }, 8 * HOUR)).toBeNull();
});

test("approve-with-grant mints the grant, stamps the receipt, and skips the next knock", async () => {
  const { db, broker, store, core } = await grantSetup([{ pattern: "delete_row", action: "approve" }]);
  let parked: ParkedCall | undefined;
  const pending = core.evaluate(CALL, { onParked: (p) => { parked = p; } });
  await new Promise((r) => setTimeout(r, 10));
  broker.decide(parked!.id, {
    approve: true, channel: "telegram", user: "111", token: parked!.token,
    grant: { ttlMs: 15 * 60_000 },
  });
  const outcome = await pending;
  if (outcome.kind !== "execute") throw new Error("expected execute");
  outcome.recordResult({ status: "ok", content_hash: "sha256:x" });

  const [approving] = receipts(db);
  expect(approving.grant).toBeDefined();
  expect(approving.grant!.scope).toEqual({ server: "mock", tool: "delete_row" });
  expect(approving.grant!.expires_at).toBeTruthy();

  const row = store.get(approving.grant!.id)!;
  expect(row.created_channel).toBe("telegram");
  expect(row.created_user).toBe("111");
  expect(row.receipt_id).toBe(approving.id);

  // second call executes under the grant — no parking, receipt carries grant_id
  const second = await core.evaluate(CALL);
  if (second.kind !== "execute") throw new Error("expected execute under grant");
  expect(second.grantId).toBe(approving.grant!.id);
  expect(second.approver).toEqual({ channel: "telegram", user: "111", latency_ms: 0 });
  second.recordResult({ status: "ok", content_hash: "sha256:y" });
  const all = receipts(db);
  expect(all[1].grant_id).toBe(approving.grant!.id);
  expect(all[1].decision).toBe("approved");
  db.close();
});

test("an explicit deny rule beats an active grant", async () => {
  const { db, store, core } = await grantSetup([{ pattern: "delete_row", action: "deny" }]);
  store.create({
    server: "mock", tool: "delete_row",
    expiresAt: new Date(Date.now() + HOUR).toISOString(),
    sessionBoot: null, channel: "web", user: "w", receiptId: "r1",
  });
  const outcome = await core.evaluate(CALL);
  if (outcome.kind !== "block") throw new Error("expected block");
  expect(outcome.decision).toBe("denied");
  expect(outcome.blockedBy).toBe("rule");
  db.close();
});

test("grants are MCP-door only — cc origin never matches", async () => {
  const { db, store, core, broker } = await grantSetup([{ pattern: "*", action: "approve" }]);
  store.create({
    server: "claude-code", tool: "Bash",
    expiresAt: new Date(Date.now() + HOUR).toISOString(),
    sessionBoot: null, channel: "web", user: "w", receiptId: "r1",
  });
  let parkedId: string | undefined;
  const pending = core.evaluate(
    { server: "claude-code", tool: "Bash", args: {}, origin: "cc" },
    { onParked: (p) => { parkedId = p.id; } },
  );
  await new Promise((r) => setTimeout(r, 10));
  expect(parkedId).toBeDefined(); // parked despite the active grant
  broker.cancel(parkedId!, "test done");
  await pending;
  db.close();
});

test("TTL clamp applies on approval-minted grants; chain verifies end to end", async () => {
  const { db, broker, core } = await grantSetup([{ pattern: "delete_row", action: "approve" }]);
  let parked: ParkedCall | undefined;
  const pending = core.evaluate(CALL, { onParked: (p) => { parked = p; } });
  await new Promise((r) => setTimeout(r, 10));
  const before = Date.now();
  broker.decide(parked!.id, {
    approve: true, channel: "web", user: "web", token: parked!.token,
    grant: { ttlMs: 999 * HOUR },
  });
  const outcome = await pending;
  if (outcome.kind !== "execute") throw new Error("expected execute");
  outcome.recordResult({ status: "ok", content_hash: "sha256:x" });
  const [r] = receipts(db);
  const expires = new Date(r.grant!.expires_at!).getTime();
  expect(expires - before).toBeLessThanOrEqual(8 * HOUR + 5_000);

  const keys = db.all<{ kid: string; public_hex: string }>("SELECT kid, public_hex FROM keys");
  expect(verifyChain(db, new Map(keys.map((k) => [k.kid, makeVerifier(k.public_hex)]))).ok).toBe(true);
  db.close();
});
