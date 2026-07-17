/**
 * Stage 7 exit test: Discord channel logic against a fake client — portless
 * and transport-agnostic (the same fake works whether the real client layer
 * is discord.js or a raw Gateway implementation).
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { ApprovalBroker } from "../src/broker.js";
import {
  DiscordChannel,
  type DiscordClientLike,
  type DiscordInteraction,
} from "../src/channels/discord.js";
import { openDb } from "../src/db.js";
import { tmpDir } from "./helpers.js";

interface Sent {
  userId: string;
  content: string;
  components: Array<{ components: Array<{ custom_id: string; label: string }> }>;
}

class FakeClient implements DiscordClientLike {
  sent: Sent[] = [];
  destroyed = false;
  loggedIn: string | undefined;
  private handlers = new Map<string, (i: DiscordInteraction) => void>();

  on(event: string, fn: (i: DiscordInteraction) => void): void {
    this.handlers.set(event, fn);
  }
  once(_event: string, _fn: () => void): void {}
  async login(token: string): Promise<void> {
    this.loggedIn = token;
  }
  destroy(): void {
    this.destroyed = true;
  }
  users = {
    fetch: async (userId: string) => ({
      send: async (msg: unknown) => {
        this.sent.push({ userId, ...(msg as Omit<Sent, "userId">) });
      },
    }),
  };
  emit(i: DiscordInteraction): void {
    this.handlers.get("interactionCreate")!(i);
  }
}

interface Recorded {
  replies: Array<{ content: string; flags?: number }>;
  updates: Array<{ content: string; components: unknown[] }>;
  modals: Array<{ custom_id: string }>;
}

function fakeInteraction(opts: {
  kind: "button" | "modal";
  customId: string;
  userId: string;
  messageContent?: string;
  reasonText?: string;
}): { interaction: DiscordInteraction; rec: Recorded } {
  const rec: Recorded = { replies: [], updates: [], modals: [] };
  const interaction: DiscordInteraction = {
    isButton: () => opts.kind === "button",
    isModalSubmit: () => opts.kind === "modal",
    customId: opts.customId,
    user: { id: opts.userId },
    message: opts.messageContent === undefined ? undefined : { content: opts.messageContent },
    reply: async (o) => void rec.replies.push(o),
    update: async (o) => void rec.updates.push(o),
    showModal: async (m) => void rec.modals.push(m as { custom_id: string }),
    fields: { getTextInputValue: () => opts.reasonText ?? "" },
  };
  return { interaction, rec };
}

async function setup() {
  const db = await openDb(join(tmpDir(), "gate.db"));
  const broker = new ApprovalBroker(db, 60_000);
  const client = new FakeClient();
  const channel = new DiscordChannel({
    token: "DTOKEN",
    allowedUsers: ["111111111111111111", "222222222222222222"], // > 2^53 territory
    broker,
    webBaseUrl: "http://127.0.0.1:4910",
    clientFactory: () => client,
  });
  channel.start();
  await channel.ready;
  return { db, broker, client, channel };
}

function buttonActs(sent: Sent): string[] {
  return sent.components.flatMap((row) => row.components.map((b) => b.custom_id.split(":")[0]));
}

test("fan-out to every allowed user; inert args; nonce-bound custom_ids", async () => {
  const { db, broker, client } = await setup();
  const parked = broker.park({
    server: "mock-things",
    tool: "delete_thing",
    args: { note: "``` @everyone **bold** injection", password: "hunter2" },
    rule: "delete_*: approve",
    origin: "mcp",
  });
  await new Promise((r) => setTimeout(r, 10)); // onPending fan-out is async

  expect(client.loggedIn).toBe("DTOKEN");
  expect(client.sent.map((s) => s.userId).sort()).toEqual([
    "111111111111111111",
    "222222222222222222",
  ]);
  const card = client.sent[0];
  expect(card.content).toContain("delete_thing");
  expect(card.content).not.toContain("```" + " @everyone"); // backticks neutralized — no fence breakout
  expect(card.content).toContain("@everyone"); // text still visible, just inert
  const nonce = broker.get(parked.id)!.nonce;
  expect(card.components[0].components[0].custom_id).toBe(`a:${parked.id}:${nonce}`);
  broker.cancel(parked.id, "test done");
  db.close();
});

test("grant buttons only on mcp-origin cards", async () => {
  const { db, broker, client } = await setup();
  const mcp = broker.park({ server: "m", tool: "t", args: {}, rule: "r", origin: "mcp" });
  const cc = broker.park({ server: "claude-code", tool: "Bash", args: {}, rule: "ask", origin: "cc" });
  await new Promise((r) => setTimeout(r, 10));

  const mcpCard = client.sent.find((s) => s.content.includes("tool: t"))!;
  const ccCard = client.sent.find((s) => s.content.includes("tool: Bash"))!;
  expect(buttonActs(mcpCard)).toEqual(["a", "g15", "g60", "gs", "d", "r"]);
  expect(buttonActs(ccCard)).toEqual(["a", "d", "r"]);
  broker.cancel(mcp.id, "done");
  broker.cancel(cc.id, "done");
  db.close();
});

test("unauthorized users can't decide; forged nonce fails; g60 carries grant intent", async () => {
  const { db, broker, client } = await setup();
  const parked = broker.park({ server: "m", tool: "t", args: {}, rule: "r", origin: "mcp" });
  const nonce = broker.get(parked.id)!.nonce;

  // stranger
  const stranger = fakeInteraction({ kind: "button", customId: `a:${parked.id}:${nonce}`, userId: "999" });
  client.emit(stranger.interaction);
  await new Promise((r) => setTimeout(r, 10));
  expect(stranger.rec.replies[0]?.content).toBe("not authorized");
  expect(broker.get(parked.id)).toBeDefined(); // still pending

  // right user, forged nonce
  const forged = fakeInteraction({
    kind: "button", customId: `a:${parked.id}:deadbeef`, userId: "111111111111111111", messageContent: "card",
  });
  client.emit(forged.interaction);
  await new Promise((r) => setTimeout(r, 10));
  expect(forged.rec.replies[0]?.content).toContain("invalid credential");
  expect(broker.get(parked.id)).toBeDefined();

  // right user + nonce, g60 → approved with a 1h grant intent, card stamped
  const good = fakeInteraction({
    kind: "button", customId: `g60:${parked.id}:${nonce}`, userId: "111111111111111111", messageContent: "card",
  });
  client.emit(good.interaction);
  const decision = await parked.decision;
  expect(decision.status).toBe("approved");
  expect(decision.channel).toBe("discord");
  expect(decision.grant).toEqual({ ttlMs: 60 * 60_000 });
  await new Promise((r) => setTimeout(r, 10));
  expect(good.rec.updates[0]?.content).toContain("✅ approved by 111111111111111111");
  expect(good.rec.updates[0]?.components).toEqual([]);
  db.close();
});

test("deny + reason: button opens a modal, modal submit delivers the reason", async () => {
  const { db, broker, client } = await setup();
  const parked = broker.park({ server: "m", tool: "t", args: {}, rule: "r", origin: "mcp" });
  const nonce = broker.get(parked.id)!.nonce;

  const btn = fakeInteraction({
    kind: "button", customId: `r:${parked.id}:${nonce}`, userId: "222222222222222222", messageContent: "card",
  });
  client.emit(btn.interaction);
  await new Promise((r) => setTimeout(r, 10));
  expect(btn.rec.modals[0]?.custom_id).toBe(`rm:${parked.id}:${nonce}`);
  expect(broker.get(parked.id)).toBeDefined(); // modal open ≠ decided

  const modal = fakeInteraction({
    kind: "modal", customId: `rm:${parked.id}:${nonce}`, userId: "222222222222222222",
    messageContent: "card", reasonText: "prod is frozen",
  });
  client.emit(modal.interaction);
  const decision = await parked.decision;
  expect(decision.status).toBe("denied");
  expect(decision.reason).toBe("prod is frozen");
  await new Promise((r) => setTimeout(r, 10));
  expect(modal.rec.updates[0]?.content).toContain("prod is frozen");
  db.close();
});

test("plain deny works; stop() destroys the client", async () => {
  const { db, broker, client, channel } = await setup();
  const parked = broker.park({ server: "m", tool: "t", args: {}, rule: "r", origin: "mcp" });
  const nonce = broker.get(parked.id)!.nonce;
  const deny = fakeInteraction({
    kind: "button", customId: `d:${parked.id}:${nonce}`, userId: "111111111111111111", messageContent: "card",
  });
  client.emit(deny.interaction);
  expect((await parked.decision).status).toBe("denied");
  channel.stop();
  expect(client.destroyed).toBe(true);
  db.close();
});
