/**
 * Approval broker: parks risky calls in SQLite, hands out a decision promise,
 * times out to deny. Channels (web, Telegram) subscribe via onPending and
 * settle calls through decide(); web proves possession of the capability
 * token, Telegram proves the callback nonce.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ulid } from "ulid";
import type { Db } from "./db.js";

export interface PendingCall {
  id: string;
  created_at: string;
  expires_at: string;
  server: string;
  tool: string;
  args: unknown;
  rule: string;
  token: string;
  nonce: string;
}

export interface BrokerDecision {
  status: "approved" | "denied" | "timeout";
  channel?: string;
  user?: string;
  reason?: string;
}

export interface ParkedCall {
  id: string;
  token: string;
  decision: Promise<BrokerDecision>;
}

interface PendingRow {
  id: string;
  created_at: string;
  expires_at: string;
  server: string;
  tool: string;
  args_json: string;
  rule: string;
  status: string;
  token: string;
  nonce: string;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export class ApprovalBroker {
  private waiters = new Map<string, (d: BrokerDecision) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners: Array<(p: PendingCall) => void> = [];

  constructor(
    private db: Db,
    private timeoutMs: number,
  ) {}

  /**
   * Fail-closed recovery: calls left pending by a previous gate process can
   * never execute — their requests died with it. Close them out.
   *
   * Call only after this process has proven sole ownership of the gate (e.g. it
   * won the web port bind). Running it eagerly in the constructor would let a
   * second, doomed `serve` instance wipe a live daemon's in-flight approvals
   * before failing on the port conflict.
   */
  recoverStalePending(): void {
    this.db.run("UPDATE pending SET status = 'timeout', decided_at = ? WHERE status = 'pending'", [
      new Date().toISOString(),
    ]);
  }

  /** Channels subscribe to be notified of newly parked calls. */
  onPending(fn: (p: PendingCall) => void): void {
    this.listeners.push(fn);
  }

  /** Park a call. Throws if the DB is unavailable — callers must fail closed. */
  park(input: { server: string; tool: string; args: unknown; rule: string }): ParkedCall {
    const id = ulid();
    const token = randomBytes(16).toString("hex");
    const nonce = randomBytes(8).toString("hex");
    const created = new Date();
    const expires = new Date(created.getTime() + this.timeoutMs);
    const pending: PendingCall = {
      id,
      created_at: created.toISOString(),
      expires_at: expires.toISOString(),
      server: input.server,
      tool: input.tool,
      args: input.args,
      rule: input.rule,
      token,
      nonce,
    };
    this.db.run(
      `INSERT INTO pending (id, created_at, expires_at, server, tool, args_json, rule, status, token, nonce)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [id, pending.created_at, pending.expires_at, input.server, input.tool,
       JSON.stringify(input.args ?? {}), input.rule, token, nonce],
    );
    const decision = new Promise<BrokerDecision>((resolve) => {
      this.waiters.set(id, resolve);
    });
    this.timers.set(
      id,
      setTimeout(() => this.finish(id, { status: "timeout" }), this.timeoutMs),
    );
    for (const fn of this.listeners) {
      try {
        fn(pending);
      } catch (e) {
        console.error("daemonsudo: channel notify failed:", e instanceof Error ? e.message : e);
      }
    }
    return { id, token, decision };
  }

  /**
   * Settle a pending call from a channel. The caller must present the
   * capability token (web) or the callback nonce (Telegram).
   */
  decide(
    id: string,
    opts: { approve: boolean; channel: string; user: string; token?: string; nonce?: string },
  ): { ok: boolean; error?: string } {
    const row = this.db.get<PendingRow>("SELECT * FROM pending WHERE id = ?", [id]);
    if (!row) return { ok: false, error: "unknown approval id" };
    if (row.status !== "pending") return { ok: false, error: `already ${row.status}` };
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.finish(id, { status: "timeout" });
      return { ok: false, error: "expired" };
    }
    const credentialOk =
      (opts.token !== undefined && safeEqual(opts.token, row.token)) ||
      (opts.nonce !== undefined && safeEqual(opts.nonce, row.nonce));
    if (!credentialOk) return { ok: false, error: "invalid credential" };

    this.finish(id, {
      status: opts.approve ? "approved" : "denied",
      channel: opts.channel,
      user: opts.user,
    });
    return { ok: true };
  }

  /** Client cancelled the underlying MCP request. */
  cancel(id: string, reason: string): void {
    this.finish(id, { status: "denied", channel: "client", user: "client", reason });
  }

  get(id: string): PendingCall | undefined {
    const row = this.db.get<PendingRow>(
      "SELECT * FROM pending WHERE id = ? AND status = 'pending'",
      [id],
    );
    return row ? this.toPending(row) : undefined;
  }

  listPending(): PendingCall[] {
    return this.db
      .all<PendingRow>("SELECT * FROM pending WHERE status = 'pending' ORDER BY created_at ASC")
      .map((r) => this.toPending(r));
  }

  private toPending(row: PendingRow): PendingCall {
    return {
      id: row.id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      server: row.server,
      tool: row.tool,
      args: JSON.parse(row.args_json),
      rule: row.rule,
      token: row.token,
      nonce: row.nonce,
    };
  }

  private finish(id: string, decision: BrokerDecision): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    try {
      this.db.run(
        `UPDATE pending SET status = ?, decided_channel = ?, decided_user = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
        [decision.status, decision.channel ?? null, decision.user ?? null,
         new Date().toISOString(), id],
      );
    } catch (e) {
      console.error("daemonsudo: pending update failed:", e instanceof Error ? e.message : e);
    }
    if (waiter) waiter(decision);
  }
}
