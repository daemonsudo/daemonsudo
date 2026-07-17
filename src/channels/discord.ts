/**
 * Discord approval channel. DMs each allowed user a plain-text card with
 * approve/grant/deny buttons; "Deny + reason" opens a modal. Args are
 * untrusted input — rendered inert inside a code fence with backticks
 * neutralized so Discord never interprets them.
 *
 * The channel speaks a minimal duck-typed client surface and builds raw
 * component JSON (no discord.js imports here) — the constructor's
 * clientFactory is both the test seam and the transport boundary, so a raw
 * Gateway client could replace discord.js without touching card logic.
 * allowed_users are STRINGS: snowflakes exceed 2^53.
 */
import type { ApprovalBroker, PendingCall } from "../broker.js";
import { GRANT_INTENTS, isKnownAction } from "../grants.js";
import type { Channel } from "./channel.js";
import { renderArgs } from "../web/index.js";

const EPHEMERAL = 64; // MessageFlags.Ephemeral

// Discord message component types & styles (API v10) — note "4" is both
// ButtonStyle.Danger and ComponentType.TextInput depending on context.
const TYPE_ACTION_ROW = 1;
const TYPE_BUTTON = 2;
const TYPE_TEXT_INPUT = 4;
const STYLE_SUCCESS = 3;
const STYLE_DANGER = 4;
const STYLE_PARAGRAPH = 2;

export interface DiscordInteraction {
  isButton(): boolean;
  isModalSubmit(): boolean;
  customId: string;
  user: { id: string };
  message?: { content?: string };
  reply(opts: { content: string; flags?: number }): Promise<unknown>;
  update(opts: { content: string; components: unknown[] }): Promise<unknown>;
  showModal?(modal: unknown): Promise<unknown>;
  fields?: { getTextInputValue(id: string): string };
}

export interface DiscordClientLike {
  on(event: "interactionCreate", fn: (interaction: DiscordInteraction) => void): unknown;
  once(event: "clientReady", fn: () => void): unknown;
  login(token: string): Promise<unknown>;
  destroy(): unknown;
  users: { fetch(id: string): Promise<{ send(msg: unknown): Promise<unknown> }> };
}

export type DiscordClientFactory = () => DiscordClientLike | Promise<DiscordClientLike>;

async function defaultClientFactory(): Promise<DiscordClientLike> {
  const { Client, GatewayIntentBits, Partials } = await import("discord.js");
  return new Client({
    intents: [GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  }) as unknown as DiscordClientLike;
}

export interface DiscordOptions {
  token: string;
  allowedUsers: string[];
  broker: ApprovalBroker;
  webBaseUrl?: string;
  /** test seam + transport boundary */
  clientFactory?: DiscordClientFactory;
}

/** Untrusted args → inert code fence (backticks can't break out). */
function inertArgs(args: unknown): string {
  return "```\n" + renderArgs(args, 800).replaceAll("`", "ˋ") + "\n```";
}

const button = (act: string, p: PendingCall, label: string, style: number) => ({
  type: TYPE_BUTTON,
  style,
  label,
  custom_id: `${act}:${p.id}:${p.nonce}`,
});

/** Grant buttons only on MCP-origin cards (CC has native standing allows). */
function componentRows(p: PendingCall): unknown[] {
  const row = (components: unknown[]) => ({ type: TYPE_ACTION_ROW, components });
  const approvals = [button("a", p, "✅ Approve once", STYLE_SUCCESS)];
  if (p.origin === "mcp") {
    approvals.push(
      button("g15", p, "✅ 15m", STYLE_SUCCESS),
      button("g60", p, "✅ 1h", STYLE_SUCCESS),
      button("gs", p, "✅ session", STYLE_SUCCESS),
    );
  }
  return [
    row(approvals),
    row([button("d", p, "❌ Deny", STYLE_DANGER), button("r", p, "✋ Deny + reason", STYLE_DANGER)]),
  ];
}

export class DiscordChannel implements Channel {
  private client: DiscordClientLike | undefined;
  /** resolves when the client is constructed and handlers are wired (tests await it) */
  ready: Promise<void> = Promise.resolve();

  constructor(private opts: DiscordOptions) {}

  start(): void {
    this.ready = this.init().catch((e: unknown) => {
      console.error("daemonsudo: discord channel failed to start:", e instanceof Error ? e.message : e);
    });
  }

  stop(): void {
    this.client?.destroy();
  }

  private async init(): Promise<void> {
    const client = await (this.opts.clientFactory ?? defaultClientFactory)();
    this.client = client;
    client.on("interactionCreate", (i) => {
      void this.handleInteraction(i).catch((e: unknown) => {
        console.error("daemonsudo: discord interaction failed:", e instanceof Error ? e.message : e);
      });
    });
    client.once("clientReady", () => {
      console.error(
        `daemonsudo: discord channel active (${this.opts.allowedUsers.length} allowed approver${this.opts.allowedUsers.length === 1 ? "" : "s"})`,
      );
    });
    this.opts.broker.onPending((p) => {
      void this.notifyPending(p).catch((e: unknown) => {
        console.error("daemonsudo: discord notify failed:", e instanceof Error ? e.message : e);
      });
    });
    await client.login(this.opts.token);
  }

  async notifyPending(p: PendingCall): Promise<void> {
    if (!this.client) throw new Error("discord client not started");
    const content =
      `⚠️ daemonsudo: approval needed\n\n` +
      `tool: ${p.tool}\nserver: ${p.server}\nrule: ${p.rule}\n\n` +
      `args:\n${inertArgs(p.args)}\n` +
      `expires ${p.expires_at}` +
      (this.opts.webBaseUrl ? `\n${this.opts.webBaseUrl}/approve/${p.id}?t=${p.token}` : "");
    await Promise.all(
      this.opts.allowedUsers.map(async (uid) => {
        const user = await this.client!.users.fetch(uid);
        await user.send({ content, components: componentRows(p) });
      }),
    );
  }

  async handleInteraction(i: DiscordInteraction): Promise<void> {
    if (!this.opts.allowedUsers.includes(i.user.id)) {
      await i.reply({ content: "not authorized", flags: EPHEMERAL });
      return;
    }
    if (i.isButton()) return this.handleButton(i);
    if (i.isModalSubmit()) return this.handleModal(i);
  }

  private async handleButton(i: DiscordInteraction): Promise<void> {
    const [act, id, nonce] = i.customId.split(":");
    if (!isKnownAction(act) || !id || !nonce) {
      await i.reply({ content: "malformed interaction", flags: EPHEMERAL });
      return;
    }
    if (act === "r") {
      // free-text deny reason via modal; dismissing it just leaves the call pending
      await i.showModal?.({
        custom_id: `rm:${id}:${nonce}`,
        title: "Deny with reason",
        components: [
          {
            type: TYPE_ACTION_ROW,
            components: [
              {
                type: TYPE_TEXT_INPUT,
                custom_id: "reason",
                label: "Reason (shown to the agent)",
                style: STYLE_PARAGRAPH,
                max_length: 300,
                required: false,
              },
            ],
          },
        ],
      });
      return;
    }
    const approve = act !== "d";
    const res = this.opts.broker.decide(id, {
      approve,
      channel: "discord",
      user: i.user.id,
      nonce,
      grant: GRANT_INTENTS[act],
    });
    await this.stampOutcome(i, res, approve ? `✅ approved by ${i.user.id}` : `❌ denied by ${i.user.id}`);
  }

  private async handleModal(i: DiscordInteraction): Promise<void> {
    const [tag, id, nonce] = i.customId.split(":");
    if (tag !== "rm" || !id || !nonce) return;
    const reason = (i.fields?.getTextInputValue("reason") ?? "").trim().slice(0, 300) || undefined;
    const res = this.opts.broker.decide(id, {
      approve: false,
      channel: "discord",
      user: i.user.id,
      nonce,
      reason,
    });
    await this.stampOutcome(i, res, `✋ denied by ${i.user.id}${reason ? ` (${reason})` : ""}`);
  }

  private async stampOutcome(
    i: DiscordInteraction,
    res: { ok: boolean; error?: string },
    stamp: string,
  ): Promise<void> {
    if (!res.ok) {
      await i.reply({ content: `failed: ${res.error}`, flags: EPHEMERAL });
      return;
    }
    if (i.message) {
      await i.update({ content: `${i.message.content ?? ""}\n\n${stamp}`, components: [] });
    } else {
      await i.reply({ content: stamp });
    }
  }
}
