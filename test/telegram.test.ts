// Stage 5: Telegram channel logic against a faked Bot API — card contents,
// nonce auth, allowed_users enforcement. No network.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ApprovalBroker } from "../src/broker.js";
import { TelegramChannel } from "../src/channels/telegram.js";
import { openDb } from "../src/db.js";
import { tmpDir } from "./helpers.js";

interface ApiCall {
  method: string;
  body: Record<string, unknown>;
}

function fakeApi(): { calls: ApiCall[]; fetchFn: typeof fetch } {
  const calls: ApiCall[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, result: [] }));
  }) as typeof fetch;
  return { calls, fetchFn };
}

async function setup() {
  const db = await openDb(join(tmpDir(), "gate.db"));
  const broker = new ApprovalBroker(db, 60_000);
  const { calls, fetchFn } = fakeApi();
  const channel = new TelegramChannel({
    token: "TESTTOKEN",
    allowedUsers: [111, 222],
    broker,
    webBaseUrl: "http://127.0.0.1:4910",
    fetchFn,
  });
  return { db, broker, channel, calls };
}

describe("telegram channel", () => {
  test("notifies every allowed user with inert text and nonce buttons", async () => {
    const { db, broker, channel, calls } = await setup();
    const parked = broker.park({
      server: "mock-things",
      tool: "delete_thing",
      args: { id: "x", note: "<b>injection</b> attempt", password: "hunter2" },
      rule: "delete_*: approve",
    });
    await channel.notifyPending(broker.get(parked.id)!);

    const sends = calls.filter((c) => c.method === "sendMessage");
    expect(sends.map((s) => s.body.chat_id).sort()).toEqual([111, 222]);
    const text = sends[0].body.text as string;
    expect(text).toContain("delete_thing");
    expect(text).toContain("<b>injection</b> attempt"); // plain text, no parse_mode
    expect(sends[0].body.parse_mode).toBeUndefined();
    const kb = (sends[0].body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })
      .inline_keyboard[0];
    expect(kb[0].callback_data).toBe(`a:${parked.id}:${broker.get(parked.id)!.nonce}`);
    db.close();
  });

  test("only allowed users with the right nonce can decide", async () => {
    const { db, broker, channel, calls } = await setup();
    const parked = broker.park({ server: "m", tool: "delete_thing", args: {}, rule: "delete_*: approve" });
    const nonce = broker.get(parked.id)!.nonce;
    const cb = (from: number, data: string) => ({
      update_id: 1,
      callback_query: { id: "cb1", from: { id: from }, data,
        message: { chat: { id: from }, message_id: 9, text: "card" } },
    });

    // stranger
    await channel.handleUpdate(cb(999, `a:${parked.id}:${nonce}`));
    expect(broker.get(parked.id)).toBeDefined(); // still pending
    expect(calls.at(-1)?.method).toBe("answerCallbackQuery");
    expect(calls.at(-1)?.body.text).toBe("not authorized");

    // right user, forged nonce
    await channel.handleUpdate(cb(111, `a:${parked.id}:deadbeefdeadbeef`));
    expect(broker.get(parked.id)).toBeDefined();
    expect(String(calls.at(-1)?.body.text)).toContain("invalid credential");

    // right user, right nonce → approved
    await channel.handleUpdate(cb(111, `a:${parked.id}:${nonce}`));
    const decision = await parked.decision;
    expect(decision).toEqual({ status: "approved", channel: "telegram", user: "111" });
    // card edited with the outcome
    expect(calls.at(-1)?.method).toBe("editMessageText");
    expect(String(calls.at(-1)?.body.text)).toContain("✅ approved by 111");
    db.close();
  });

  test("deny via button resolves the parked call as denied", async () => {
    const { db, broker, channel } = await setup();
    const parked = broker.park({ server: "m", tool: "send_thing", args: {}, rule: "send_*: approve" });
    const nonce = broker.get(parked.id)!.nonce;
    await channel.handleUpdate({
      update_id: 2,
      callback_query: { id: "cb2", from: { id: 222 }, data: `d:${parked.id}:${nonce}` },
    });
    expect((await parked.decision).status).toBe("denied");
    db.close();
  });
});
