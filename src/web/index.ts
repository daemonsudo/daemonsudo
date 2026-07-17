/**
 * Server-rendered approval + receipts pages. No build step, no client JS.
 * Args are untrusted (prompt-injection vector): everything is escaped and
 * truncated before it touches HTML.
 */
import { Hono } from "hono";
import type { ApprovalBroker, PendingCall } from "../broker.js";
import type { GateConfig } from "../config.js";
import { GRANT_INTENTS, revokeGrantWithReceipt, type GrantStore } from "../grants.js";
import type { Ledger } from "../ledger.js";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function truncate(s: string, max = 2000): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [truncated ${s.length - max} chars]`;
}

/** Untrusted value → inert, size-bounded, pretty JSON for display. */
export function renderArgs(args: unknown, max = 2000): string {
  let json: string;
  try {
    json = JSON.stringify(args, null, 2) ?? "null";
  } catch {
    json = String(args);
  }
  return truncate(json, max);
}

const STYLE = `
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #101418;
         color: #d8dee6; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.2rem; } h1 a { color: inherit; text-decoration: none; }
  .card { border: 1px solid #2c3440; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0;
          background: #161b22; }
  pre { background: #0b0e12; border: 1px solid #2c3440; border-radius: 6px; padding: .75rem;
        overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .muted { color: #8b97a6; font-size: .85rem; }
  .decision-auto { color: #7ee787; } .decision-approved { color: #7ee787; }
  .decision-denied { color: #ff7b72; } .decision-timeout { color: #e3b341; }
  .decision-error { color: #ff7b72; }
  button { font: inherit; padding: .5rem 1.5rem; border-radius: 6px; border: 0; cursor: pointer; }
  .approve { background: #238636; color: #fff; } .deny { background: #b62324; color: #fff; }
  form { display: inline-block; margin-right: .75rem; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  td, th { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #2c3440;
           vertical-align: top; }
  .ok { color: #7ee787; } .bad { color: #ff7b72; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><h1><a href="/receipts">daemonsudo</a> · ${escapeHtml(title)}</h1>${body}</body></html>`;
}

function pendingCard(p: PendingCall, withButtons: boolean, token?: string): string {
  const form = (action: string, label: string, cls: string, extra = "") =>
    `<form method="post" action="/approve/${escapeHtml(p.id)}">
  <input type="hidden" name="t" value="${escapeHtml(token ?? "")}">
  <input type="hidden" name="action" value="${action}">
  ${extra}<button class="${cls}" type="submit">${label}</button>
</form>`;
  // grant buttons only on MCP-origin cards (CC has native standing allows)
  const grantForms =
    p.origin === "mcp"
      ? form("g15", "Approve 15m", "approve") +
        form("g60", "Approve 1h", "approve") +
        form("gs", "Approve session", "approve")
      : "";
  const buttons =
    withButtons && token
      ? `<p>${form("approve", "Approve once", "approve")}${grantForms}${form(
          "deny",
          "Deny",
          "deny",
          `<input type="text" name="reason" maxlength="300" placeholder="reason (optional)">\n  `,
        )}</p>`
      : "";
  return `<div class="card">
<p><strong>${escapeHtml(p.tool)}</strong> <span class="muted">on ${escapeHtml(p.server)}</span></p>
<p class="muted">rule: ${escapeHtml(p.rule)} · requested ${escapeHtml(p.created_at)} · expires ${escapeHtml(p.expires_at)}</p>
<pre>${escapeHtml(renderArgs(p.args))}</pre>
${buttons}</div>`;
}

export function createWebApp(
  broker: ApprovalBroker,
  ledger: Ledger,
  register?: (app: Hono) => void,
  grants?: GrantStore,
): Hono {
  const app = new Hono();
  // Extra routes registered before the built-in ones (e.g. /gate/* for the CC door).
  register?.(app);

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/", (c) => c.redirect("/receipts"));

  app.get("/approve/:id", (c) => {
    const p = broker.get(c.req.param("id"));
    if (!p) return c.html(page("approval", `<p>No such pending approval — already decided or expired.</p>`), 404);
    const token = c.req.query("t") ?? "";
    return c.html(page("approval requested", pendingCard(p, true, token)));
  });

  app.post("/approve/:id", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    const token = typeof form.t === "string" ? form.t : "";
    const action = typeof form.action === "string" ? form.action : "";
    const approve = action === "approve" || action in GRANT_INTENTS;
    const reason =
      !approve && typeof form.reason === "string" && form.reason.trim()
        ? form.reason.trim().slice(0, 300)
        : undefined;
    const res = broker.decide(id, {
      approve,
      channel: "web",
      user: "web",
      token,
      reason,
      grant: GRANT_INTENTS[action],
    });
    if (!res.ok) return c.html(page("approval", `<p class="bad">✗ ${escapeHtml(res.error ?? "failed")}</p>`), 400);
    return c.html(
      page(
        "decided",
        `<p class="${approve ? "ok" : "bad"}">${approve ? "✓ approved — the call is executing" : "✗ denied — the agent gets a refusal"}</p>
         <p class="muted"><a href="/receipts" style="color:#8b97a6">receipts →</a></p>`,
      ),
    );
  });

  app.get("/pending", (c) => {
    const items = broker.listPending();
    const body = items.length
      ? items.map((p) => pendingCard(p, false) + `<p class="muted">open the approval link printed to the gate's stderr (or sent to Telegram) to decide</p>`).join("")
      : "<p class='muted'>nothing pending.</p>";
    return c.html(page(`pending (${items.length})`, body));
  });

  if (grants) {
    app.get("/grants", (c) => {
      const rows = grants
        .list()
        .map((g) => {
          const state = g.revoked_at
            ? `revoked ${escapeHtml(g.revoked_at)}`
            : g.expires_at
              ? `expires ${escapeHtml(g.expires_at)}`
              : "session";
          const revokeForm = g.revoked_at
            ? ""
            : `<form method="post" action="/grants/revoke">
<input type="hidden" name="id" value="${escapeHtml(g.id)}">
<button class="deny" type="submit">Revoke</button></form>`;
          return `<tr>
<td><strong>${escapeHtml(g.tool)}</strong><br><span class="muted">${escapeHtml(g.server)}</span></td>
<td class="${g.revoked_at ? "bad" : "ok"}">${state}</td>
<td class="muted">${escapeHtml(g.created_channel)}:${escapeHtml(g.created_user)}<br>${escapeHtml(g.created_at)}</td>
<td class="muted">${escapeHtml(g.id.slice(-8))}</td>
<td>${revokeForm}</td>
</tr>`;
        })
        .join("");
      return c.html(
        page(
          "grants",
          `<p class="muted">standing approvals — one knock per permission, not per call</p>
<table><tr><th>scope</th><th>state</th><th>created</th><th>id</th><th></th></tr>${rows}</table>`,
        ),
      );
    });

    app.post("/grants/revoke", async (c) => {
      const form = await c.req.parseBody();
      const id = typeof form.id === "string" ? form.id : "";
      const res = revokeGrantWithReceipt(grants, ledger, id, "web", "web");
      if (!res.ok) return c.html(page("grants", `<p class="bad">✗ ${escapeHtml(res.error ?? "failed")}</p>`), 400);
      return c.redirect("/grants");
    });
  }

  app.get("/receipts", (c) => {
    const receipts = ledger.list(200);
    const rows = receipts
      .map((r) => {
        const approver = r.approver
          ? `${escapeHtml(r.approver.channel)}:${escapeHtml(r.approver.user)} (${(r.approver.latency_ms / 1000).toFixed(1)}s)`
          : "—";
        return `<tr>
<td class="muted">${escapeHtml(r.ts)}</td>
<td><strong>${escapeHtml(r.tool)}</strong><br><span class="muted">${escapeHtml(r.server)}</span>
<details><summary class="muted">args</summary><pre>${escapeHtml(renderArgs(r.args_redacted, 1000))}</pre></details></td>
<td class="decision-${escapeHtml(r.decision)}">${escapeHtml(r.decision)}${r.reason ? `<br><span class="muted">${escapeHtml(truncate(r.reason, 300))}</span>` : ""}</td>
<td class="muted">${escapeHtml(r.rule)}</td>
<td>${approver}</td>
<td class="muted">${escapeHtml(r.id.slice(-8))}<br>${r.sig === "unsigned" ? "unsigned" : "✍ signed"}</td>
</tr>`;
      })
      .join("");
    return c.html(
      page(
        `receipts (${ledger.count()})`,
        `<p class="muted">auth.log, but signed — verify offline with <code>daemonsudo verify</code></p>
<table><tr><th>ts</th><th>tool</th><th>decision</th><th>rule</th><th>approver</th><th>receipt</th></tr>${rows}</table>`,
      ),
    );
  });

  return app;
}

export interface WebChannel {
  baseUrl: string;
  stop(): void;
}

/** Bind a Hono app; throws when the port is taken. */
export async function listenOn(app: Hono, host: string, port: number): Promise<() => void> {
  if (process.versions.bun) {
    const Bun = (globalThis as Record<string, unknown>).Bun as {
      serve(opts: unknown): { stop(closeActive?: boolean): void };
    };
    // idleTimeout:0 keeps long-held /gate/approve connections alive past Bun's default.
    const server = Bun.serve({ hostname: host, port, fetch: app.fetch, idleTimeout: 0 });
    // stop(true): actually release the port — callers stop() only on shutdown,
    // where a lingering listener would shadow the next bind.
    return () => server.stop(true);
  }
  const { serve } = await import("@hono/node-server");
  const server = serve({ fetch: app.fetch, hostname: host, port });
  // Node reports EADDRINUSE asynchronously — await the bind so a taken port
  // THROWS here like it does on Bun. A second daemon must die before it can
  // touch shared state (recoverStalePending), not after.
  // Detach the sibling listener once one side fires: a leftover 'error'
  // listener would silently swallow later runtime errors on the socket.
  await new Promise<void>((resolve, reject) => {
    const net = server as unknown as import("node:net").Server;
    const onListening = () => { net.off("error", onError); resolve(); };
    const onError = (err: Error) => { net.off("listening", onListening); reject(err); };
    net.once("listening", onListening);
    net.once("error", onError);
  });
  // Disable Node's default timeouts so /gate/approve can block for 9+ minutes.
  (server as { requestTimeout?: number; timeout?: number }).requestTimeout = 0;
  (server as { requestTimeout?: number; timeout?: number }).timeout = 0;
  return () => server.close();
}

/**
 * The gate-API app for a second listener (docker bridge): ONLY /health
 * (tokenless) + the /gate/* routes. Operator pages never appear here —
 * the topology is the boundary.
 */
export function createGateApp(register: (app: Hono) => void): Hono {
  const app = new Hono();
  register(app);
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}

/** Start the approval/receipts server. Returns undefined when the port is taken. */
export async function startWeb(
  broker: ApprovalBroker,
  ledger: Ledger,
  config: GateConfig,
  register?: (app: Hono) => void,
  grants?: GrantStore,
): Promise<WebChannel | undefined> {
  const app = createWebApp(broker, ledger, register, grants);
  const { host, port } = config.web;
  const baseUrl = `http://${host}:${port}`;
  try {
    const stop = await listenOn(app, host, port);
    broker.onPending((p) => {
      console.error(`daemonsudo: approval needed → ${baseUrl}/approve/${p.id}?t=${p.token}`);
    });
    console.error(`daemonsudo: web channel at ${baseUrl} (receipts: ${baseUrl}/receipts)`);
    return { baseUrl, stop };
  } catch (e) {
    console.error(
      `daemonsudo: web channel failed to start on ${baseUrl} (${e instanceof Error ? e.message : e}) — approvals via other channels only`,
    );
    return undefined;
  }
}
