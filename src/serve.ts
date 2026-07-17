/**
 * daemonsudo serve — persistent daemon for the Claude Code door.
 *
 * One process per gate.db. Owns the broker (single Telegram consumer), the
 * ledger (single writer), and the web channel. The two /gate/* routes are the
 * bridge between CC hooks and v0.1's broker/ledger/channels.
 *
 * Correlation: PermissionRequest has no tool_use_id, so we key the approved-call
 * stash on (session_id, tool_name, sha256(tool_input)). Edge case: if the daemon
 * crashes between returning allow and the PostToolUse arriving, the stash entry
 * expires and that receipt lands as decision="auto" — accepted for v0.2.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { ApprovalBroker, type BrokerDecision } from "./broker.js";
import { TelegramChannel } from "./channels/telegram.js";
import { defaultDbPath, loadConfig } from "./config.js";
import { DecisionCore } from "./core.js";
import { BOOT_ID, createGrantWithReceipt, GrantStore, revokeGrantWithReceipt } from "./grants.js";
import { openDb } from "./db.js";
import {
  Ledger,
  loadOrCreateKeys,
  makeSigner,
  sha256,
  type Approver,
} from "./ledger.js";
import { YamlGlobEngine } from "./rules.js";
import { loadOrCreateToken, tokenPath } from "./token.js";
import { createGateApp, listenOn, startWeb } from "./web/index.js";

const STASH_TTL_MS = 15 * 60 * 1000;

interface StashEntry {
  decision: "approved";
  approver: Approver;
  ts: number;
}

function stashKey(sessionId: string, toolName: string, toolInput: unknown): string {
  const inputJson = (() => {
    try { return JSON.stringify(toolInput ?? {}); } catch { return String(toolInput); }
  })();
  const h = createHash("sha256").update(inputJson).digest("hex");
  return `${sessionId}:${toolName}:${h}`;
}

function checkToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function runServe(configPath?: string): Promise<void> {
  const config = loadConfig(configPath);
  const db = await openDb(defaultDbPath());
  const token = loadOrCreateToken();

  const ledger = new Ledger(db, config.redact, makeSigner(loadOrCreateKeys(db)), config.gateHash);
  const broker = new ApprovalBroker(db, config.timeoutMs);
  const grants = new GrantStore(db);
  const core = new DecisionCore(new YamlGlobEngine(config.rules, config.defaults), ledger, broker, {
    store: grants,
    bootId: BOOT_ID,
    maxTtlMs: config.grantsMaxTtlMs,
  });

  // Approved-call stash: keyed by (session, tool, input-hash). In-memory with TTL.
  const stash = new Map<string, StashEntry>();
  const pruneStash = () => {
    const cutoff = Date.now() - STASH_TTL_MS;
    for (const [k, v] of stash) if (v.ts < cutoff) stash.delete(k);
  };

  function register(app: Hono): void {
    // PermissionRequest hook → park with broker, block until human decides.
    app.post("/gate/approve", async (c) => {
      if (!checkToken(c.req.header("x-daemonsudo-token"), token)) {
        return c.json({ error: "unauthorized" }, 401);
      }
      let body: { session_id: string; tool_name: string; tool_input: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "bad json" }, 400);
      }

      const parkedAt = Date.now();
      // The CC door never runs the rules engine — CC already decided "ask".
      const parked = core.parkOnly({
        server: "claude-code",
        tool: body.tool_name,
        args: body.tool_input,
        rule: "ask",
        origin: "cc",
      });

      // Cancel the parked call if the hook disconnects (CC session killed).
      const cancelOnAbort = () => broker.cancel(parked.id, "hook-disconnect");
      c.req.raw.signal.addEventListener("abort", cancelOnAbort, { once: true });

      let decision: BrokerDecision;
      try {
        decision = await parked.decision;
      } finally {
        c.req.raw.signal.removeEventListener("abort", cancelOnAbort);
      }

      const latency_ms = Date.now() - parkedAt;

      if (decision.status === "approved") {
        pruneStash();
        stash.set(stashKey(body.session_id, body.tool_name, body.tool_input), {
          decision: "approved",
          approver: {
            channel: decision.channel ?? "unknown",
            user: decision.user ?? "unknown",
            latency_ms,
          },
          ts: Date.now(),
        });
        return c.json({ behavior: "allow" });
      }

      // Denied or timeout: write the terminal receipt now — no PostToolUse follows.
      const terminalDecision = decision.status === "timeout" ? "timeout" : "denied";
      core.terminalReceipt(
        {
          server: "claude-code",
          tool: body.tool_name,
          args: body.tool_input,
          requester: { client: "claude-code", session: body.session_id, call_id: parked.id },
          origin: "cc",
        },
        terminalDecision,
        "ask",
        decision.channel ? { channel: decision.channel, user: decision.user!, latency_ms } : undefined,
        terminalDecision === "denied" ? decision.reason : undefined,
      );
      return c.json({ behavior: "deny", ...(decision.reason ? { reason: decision.reason } : {}) });
    });

    // PostToolUse / PostToolUseFailure hook → correlate + write one receipt.
    app.post("/gate/receipt", async (c) => {
      if (!checkToken(c.req.header("x-daemonsudo-token"), token)) {
        return c.json({ error: "unauthorized" }, 401);
      }
      let body: {
        session_id: string;
        tool_name: string;
        tool_input: unknown;
        tool_response?: unknown;
        hook_event_name: string;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "bad json" }, 400);
      }

      const key = stashKey(body.session_id, body.tool_name, body.tool_input);
      const entry = stash.get(key);
      if (entry) stash.delete(key);

      const decision = entry?.decision ?? "auto";
      const isFailure = body.hook_event_name === "PostToolUseFailure";
      const contentHash = sha256(
        (() => { try { return JSON.stringify(body.tool_response ?? ""); } catch { return String(body.tool_response); } })()
      );

      try {
        ledger.append({
          server: "claude-code",
          tool: body.tool_name,
          args: body.tool_input,
          decision,
          rule: entry ? "ask" : "auto",
          requester: { client: "claude-code", session: body.session_id, call_id: "cc" },
          approver: entry?.approver,
          result: { status: isFailure ? "error" : "ok", content_hash: contentHash },
        });
      } catch (e) {
        console.error("daemonsudo serve: receipt append failed:", e instanceof Error ? e.message : e);
      }
      return c.json({ ok: true });
    });

    // Grants CLI → daemon: the daemon stays the ledger's single writer.
    app.post("/gate/grants", async (c) => {
      if (!checkToken(c.req.header("x-daemonsudo-token"), token)) {
        return c.json({ error: "unauthorized" }, 401);
      }
      let body: { server: string; tool: string; ttl_ms?: number; session?: boolean; user?: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "bad json" }, 400);
      }
      if (!body.server || !body.tool) return c.json({ error: "server and tool required" }, 400);
      const intent = body.session
        ? { session: true as const }
        : { ttlMs: Number(body.ttl_ms) };
      if (!("session" in intent) && (!Number.isFinite(intent.ttlMs) || intent.ttlMs <= 0)) {
        return c.json({ error: "ttl_ms must be a positive number (or pass session: true)" }, 400);
      }
      const grant = createGrantWithReceipt(grants, ledger, {
        server: body.server,
        tool: body.tool,
        intent,
        maxTtlMs: config.grantsMaxTtlMs,
        bootId: BOOT_ID,
        channel: "cli",
        user: body.user ?? "operator",
      });
      return c.json({ ok: true, grant: { id: grant.id, expires_at: grant.expires_at } });
    });

    app.post("/gate/grants/revoke", async (c) => {
      if (!checkToken(c.req.header("x-daemonsudo-token"), token)) {
        return c.json({ error: "unauthorized" }, 401);
      }
      let body: { id: string; user?: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "bad json" }, 400);
      }
      const res = revokeGrantWithReceipt(grants, ledger, body.id ?? "", "cli", body.user ?? "operator");
      return res.ok ? c.json({ ok: true }) : c.json({ error: res.error }, 400);
    });
  }

  const web = await startWeb(broker, ledger, config, register, grants);
  if (!web) {
    // For `serve`, the HTTP port is the only interface — can't run without it.
    console.error(
      "daemonsudo serve: FATAL — could not bind port (is another daemon already running?)",
    );
    process.exit(1);
  }

  // Optional second listener for the gate API (docker bridge): /health +
  // /gate/* only. FATAL if it can't bind — a silent fallback to loopback
  // would fake the security boundary the operator configured.
  let stopGateListener: (() => void) | undefined;
  if (config.gateListen) {
    const { host, port } = config.gateListen;
    try {
      stopGateListener = await listenOn(createGateApp(register), host, port);
      console.error(`daemonsudo serve: gate API listener at http://${host}:${port} (token-authed)`);
    } catch (e) {
      console.error(
        `daemonsudo serve: FATAL — gate.listen ${host}:${port} failed to bind (${e instanceof Error ? e.message : e})`,
      );
      process.exit(1);
    }
  }

  // We won the port bind → we're the sole owner. Only now is it safe to close
  // out approvals orphaned by a previous daemon; a doomed second `serve` exits
  // above before reaching this, leaving a live daemon's pending queue intact.
  broker.recoverStalePending();
  grants.expireStaleSessionGrants(BOOT_ID);

  if (config.telegram) {
    const tgToken = process.env[config.telegram.tokenEnv];
    if (!tgToken) {
      console.error(`daemonsudo serve: ${config.telegram.tokenEnv} not set — Telegram disabled`);
    } else if (config.telegram.allowedUsers.length === 0) {
      console.error("daemonsudo serve: no telegram.allowed_users — Telegram disabled");
    } else {
      new TelegramChannel({
        token: tgToken,
        allowedUsers: config.telegram.allowedUsers,
        broker,
        webBaseUrl: web.baseUrl,
      }).start();
    }
  }

  console.error(
    `daemonsudo serve: ready — web ${web.baseUrl} · token ${tokenPath()}`,
  );

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    web.stop();
    stopGateListener?.();
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
