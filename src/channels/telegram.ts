/**
 * Telegram approval channel. Bot API long-polling — no webhook, no public
 * URL, works behind NAT. Only configured user IDs may decide; callbacks
 * carry a one-time nonce bound to the pending id. Card text is plain text
 * (no parse_mode) and truncated: args are untrusted input, never interpreted.
 */
import type { ApprovalBroker, PendingCall } from "../broker.js";
import { renderArgs } from "../web/index.js";

export interface TelegramOptions {
  token: string;
  allowedUsers: number[];
  broker: ApprovalBroker;
  webBaseUrl?: string;
  /** test seam */
  fetchFn?: typeof fetch;
  pollTimeoutSec?: number;
}

interface TgUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from?: { id?: number };
    data?: string;
    message?: { chat: { id: number }; message_id: number; text?: string };
  };
}

export class TelegramChannel {
  private fetchFn: typeof fetch;
  private offset = 0;
  private running = false;

  constructor(private opts: TelegramOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  start(): void {
    this.running = true;
    this.opts.broker.onPending((p) => void this.notifyPending(p).catch((e: unknown) => {
      console.error("daemonsudo: telegram notify failed:", e instanceof Error ? e.message : e);
    }));
    void this.pollLoop();
    console.error(
      `daemonsudo: telegram channel active (${this.opts.allowedUsers.length} allowed approver${this.opts.allowedUsers.length === 1 ? "" : "s"})`,
    );
  }

  stop(): void {
    this.running = false;
  }

  private async api<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.opts.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? "failed"}`);
    return data.result as T;
  }

  async notifyPending(p: PendingCall): Promise<void> {
    const text =
      `⚠️ daemonsudo: approval needed\n\n` +
      `tool: ${p.tool}\nserver: ${p.server}\nrule: ${p.rule}\n\n` +
      `args:\n${renderArgs(p.args, 800)}\n\n` +
      `expires ${p.expires_at}` +
      (this.opts.webBaseUrl ? `\n${this.opts.webBaseUrl}/approve/${p.id}?t=${p.token}` : "");
    await Promise.all(
      this.opts.allowedUsers.map((user) =>
        this.api("sendMessage", {
          chat_id: user,
          text,
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Approve", callback_data: `a:${p.id}:${p.nonce}` },
              { text: "❌ Deny", callback_data: `d:${p.id}:${p.nonce}` },
            ]],
          },
        }),
      ),
    );
  }

  async handleUpdate(update: TgUpdate): Promise<void> {
    const cq = update.callback_query;
    if (!cq) return;
    const from = cq.from?.id;
    const answer = (text: string) =>
      this.api("answerCallbackQuery", { callback_query_id: cq.id, text }).catch(() => {});

    if (from === undefined || !this.opts.allowedUsers.includes(from)) {
      await answer("not authorized");
      return;
    }
    const [act, id, nonce] = (cq.data ?? "").split(":");
    if ((act !== "a" && act !== "d") || !id || !nonce) {
      await answer("malformed callback");
      return;
    }
    const approve = act === "a";
    const res = this.opts.broker.decide(id, {
      approve,
      channel: "telegram",
      user: String(from),
      nonce,
    });
    await answer(res.ok ? (approve ? "approved ✓" : "denied ✗") : `failed: ${res.error}`);
    if (res.ok && cq.message) {
      const stamp = approve ? `✅ approved by ${from}` : `❌ denied by ${from}`;
      await this.api("editMessageText", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: `${cq.message.text ?? ""}\n\n${stamp}`,
      }).catch(() => {});
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.api<TgUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: this.opts.pollTimeoutSec ?? 50,
          allowed_updates: ["callback_query"],
        });
        for (const u of updates ?? []) {
          this.offset = u.update_id + 1;
          await this.handleUpdate(u);
        }
      } catch (e) {
        if (!this.running) return;
        console.error("daemonsudo: telegram poll error:", e instanceof Error ? e.message : e);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}
