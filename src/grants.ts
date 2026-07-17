/**
 * Standing grants (MCP door only): one approval can mint a scoped
 * (server, tool) + TTL grant so subsequent matching calls skip the knock.
 * Grants never override explicit deny rules — the core checks rules first.
 * "Session" grants (expires_at NULL) live exactly as long as the process
 * that created them, keyed by a per-boot ulid.
 */
import { ulid } from "ulid";
import type { Db } from "./db.js";
import type { Ledger } from "./ledger.js";

/** One id per gate/daemon process — session grants die with it. */
export const BOOT_ID = ulid();

export const DEFAULT_MAX_TTL_MS = 8 * 3_600_000;

export interface Grant {
  id: string;
  server: string;
  tool: string;
  created_at: string;
  expires_at: string | null;
  session_boot: string | null;
  created_channel: string;
  created_user: string;
  receipt_id: string;
  revoked_at: string | null;
  revoke_receipt_id: string | null;
}

/** A channel's approve-with-grant intent, carried on the broker decision. */
export type GrantIntent = { ttlMs: number } | { session: true };

/** action key → approve-with-grant intent — shared by the Telegram and web approval UIs */
export const GRANT_INTENTS: Record<string, GrantIntent> = {
  g15: { ttlMs: 15 * 60_000 },
  g60: { ttlMs: 60 * 60_000 },
  gs: { session: true },
};

export function clampTtlMs(ttlMs: number, maxTtlMs: number): number {
  return Math.min(ttlMs, maxTtlMs);
}

export class GrantStore {
  constructor(private db: Db) {}

  create(input: {
    id?: string;
    server: string;
    tool: string;
    expiresAt: string | null;
    sessionBoot: string | null;
    channel: string;
    user: string;
    receiptId: string;
  }): Grant {
    const grant: Grant = {
      id: input.id ?? ulid(),
      server: input.server,
      tool: input.tool,
      created_at: new Date().toISOString(),
      expires_at: input.expiresAt,
      session_boot: input.sessionBoot,
      created_channel: input.channel,
      created_user: input.user,
      receipt_id: input.receiptId,
      revoked_at: null,
      revoke_receipt_id: null,
    };
    this.db.run(
      `INSERT INTO grants (id, server, tool, created_at, expires_at, session_boot,
         created_channel, created_user, receipt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [grant.id, grant.server, grant.tool, grant.created_at, grant.expires_at,
       grant.session_boot, grant.created_channel, grant.created_user, grant.receipt_id],
    );
    return grant;
  }

  findActive(server: string, tool: string, now: Date, bootId: string): Grant | undefined {
    return this.db.get<Grant>(
      `SELECT * FROM grants
       WHERE server = ? AND tool = ? AND revoked_at IS NULL
         AND ((expires_at IS NOT NULL AND expires_at > ?)
              OR (expires_at IS NULL AND session_boot = ?))
       ORDER BY created_at DESC LIMIT 1`,
      [server, tool, now.toISOString(), bootId],
    );
  }

  list(limit = 200): Grant[] {
    return this.db.all<Grant>("SELECT * FROM grants ORDER BY created_at DESC LIMIT ?", [limit]);
  }

  get(id: string): Grant | undefined {
    return this.db.get<Grant>("SELECT * FROM grants WHERE id = ?", [id]);
  }

  revoke(id: string, revokeReceiptId: string): boolean {
    const before = this.get(id);
    if (!before || before.revoked_at) return false;
    this.db.run(
      "UPDATE grants SET revoked_at = ?, revoke_receipt_id = ? WHERE id = ? AND revoked_at IS NULL",
      [new Date().toISOString(), revokeReceiptId, id],
    );
    return true;
  }

  /** Run at startup next to recoverStalePending: a prior boot's session grants can never match again. */
  expireStaleSessionGrants(bootId: string): void {
    this.db.run(
      "UPDATE grants SET revoked_at = ? WHERE expires_at IS NULL AND revoked_at IS NULL AND session_boot != ?",
      [new Date().toISOString(), bootId],
    );
  }
}

export function expiresAtFor(intent: GrantIntent, maxTtlMs: number, now = Date.now()): string | null {
  if ("session" in intent) return null;
  return new Date(now + clampTtlMs(intent.ttlMs, maxTtlMs)).toISOString();
}

/**
 * CLI/daemon-created grant (Decision 10): a standalone synthetic-tool receipt
 * (server "daemonsudo", tool "grant.create", decision approved) plus the row.
 */
export function createGrantWithReceipt(
  store: GrantStore,
  ledger: Ledger,
  input: {
    server: string;
    tool: string;
    intent: GrantIntent;
    maxTtlMs: number;
    bootId: string;
    channel: string;
    user: string;
  },
): Grant {
  const id = ulid();
  const expiresAt = expiresAtFor(input.intent, input.maxTtlMs);
  const receipt = ledger.append({
    server: "daemonsudo",
    tool: "grant.create",
    args: { grant_id: id, server: input.server, tool: input.tool, expires_at: expiresAt },
    decision: "approved",
    rule: "operator",
    approver: { channel: input.channel, user: input.user, latency_ms: 0 },
    grant: { id, scope: { server: input.server, tool: input.tool }, expires_at: expiresAt },
  });
  return store.create({
    id,
    server: input.server,
    tool: input.tool,
    expiresAt,
    sessionBoot: expiresAt === null ? input.bootId : null,
    channel: input.channel,
    user: input.user,
    receiptId: receipt.id,
  });
}

/** Revocation (Decision 10): synthetic grant.revoke receipt, then mark the row. */
export function revokeGrantWithReceipt(
  store: GrantStore,
  ledger: Ledger,
  id: string,
  channel: string,
  user: string,
): { ok: boolean; error?: string } {
  const grant = store.get(id);
  if (!grant) return { ok: false, error: "unknown grant id" };
  if (grant.revoked_at) return { ok: false, error: "already revoked" };
  const receipt = ledger.append({
    server: "daemonsudo",
    tool: "grant.revoke",
    args: { grant_id: id, server: grant.server, tool: grant.tool },
    decision: "approved",
    rule: "operator",
    approver: { channel, user, latency_ms: 0 },
    grant_id: id,
  });
  store.revoke(id, receipt.id);
  return { ok: true };
}
