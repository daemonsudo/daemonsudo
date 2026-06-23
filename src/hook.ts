/**
 * daemonsudo hook — stateless CC hook client. Invoked by Claude Code on each
 * PermissionRequest / PostToolUse / PostToolUseFailure / SessionStart event.
 *
 * PermissionRequest: POSTs to /gate/approve and blocks until the daemon decides
 * (up to ~595s before the local AbortController fires). Returns allow/deny JSON
 * to stdout for CC to act on. Daemon unreachable → fail CLOSED (deny), unless
 * DAEMONSUDO_HOOK_FAIL_OPEN=1.
 *
 * PostToolUse / PostToolUseFailure: POSTs to /gate/receipt, exits 0 regardless.
 * The tool already ran — never block. Daemon unreachable → loud stderr only.
 *
 * --ensure-daemon (SessionStart): probes /health; if the daemon is down, spawns
 * `daemonsudo serve` detached via setsid. Exits 0 regardless.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const DAEMON_BASE = process.env.DAEMONSUDO_BASE_URL ?? "http://127.0.0.1:4910";

function tokenPath(): string {
  return process.env.DAEMONSUDO_TOKEN_PATH ?? join(homedir(), ".gate", "serve.token");
}

function loadToken(): string | undefined {
  const path = tokenPath();
  try {
    return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
  } catch {
    return undefined;
  }
}

async function postJson(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const token = loadToken();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-daemonsudo-token"] = token;
  try {
    const res = await fetch(`${DAEMON_BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    const data = await res.json().catch(() => undefined);
    return { ok: res.ok, data, error: res.ok ? undefined : String((data as Record<string,unknown>)?.error ?? res.status) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function emitAllow(): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    }) + "\n",
  );
}

function emitDeny(reason: string): void {
  process.stderr.write(`daemonsudo hook: denying — ${reason}\n`);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    }) + "\n",
  );
}

async function handlePermissionRequest(input: Record<string, unknown>): Promise<void> {
  // Abort ~5s before CC's own 600s hook timeout so CC can show its local dialog.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 595_000);

  const res = await postJson("/gate/approve", {
    session_id: input.session_id,
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    permission_mode: input.permission_mode,
  }, ac.signal);
  clearTimeout(timer);

  if (!res.ok) {
    const failOpen = process.env.DAEMONSUDO_HOOK_FAIL_OPEN === "1";
    if (failOpen) {
      // No output → CC falls through to its own local dialog.
      process.stderr.write(`daemonsudo hook: daemon unreachable (${res.error}) — fail open, CC decides\n`);
      return;
    }
    emitDeny(`daemon unreachable (${res.error}) — set DAEMONSUDO_HOOK_FAIL_OPEN=1 to fall back to local dialog`);
    return;
  }

  const behavior = (res.data as Record<string, unknown>)?.behavior;
  if (behavior === "allow") {
    emitAllow();
  } else {
    emitDeny("remote decision: deny");
  }
}

async function handlePostToolUse(input: Record<string, unknown>): Promise<void> {
  const res = await postJson("/gate/receipt", {
    session_id: input.session_id,
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    tool_response: input.tool_response,
    hook_event_name: input.hook_event_name,
  });
  if (!res.ok) {
    process.stderr.write(
      `daemonsudo hook: WARNING — receipt POST failed (${res.error}); call was executed but not receipted\n`,
    );
  }
}

async function ensureDaemon(): Promise<void> {
  try {
    const res = await fetch(`${DAEMON_BASE}/health`, { signal: AbortSignal.timeout(2_000) });
    if (res.ok) return; // Already running.
  } catch {
    // Fall through to spawn.
  }

  // Resolve the daemonsudo binary path (same binary that spawned us).
  const bin = process.execPath === process.argv[0]
    ? process.argv[1]  // bun src/hook.ts → argv[1] is the script
    : process.argv[1]; // node dist/hook.js → argv[1] is the dist file

  // Prefer the installed `daemonsudo` binary on PATH.
  const daemonsudoBin = "daemonsudo";

  try {
    const child = spawn(daemonsudoBin, ["serve"], {
      detached: true,
      stdio: "ignore",
      // setsid equivalent: detached:true on POSIX creates a new session.
    });
    child.unref();
    // Brief poll until /health responds (up to 5s).
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((r) => setTimeout(r, 500));
      try {
        const r = await fetch(`${DAEMON_BASE}/health`, { signal: AbortSignal.timeout(1_000) });
        if (r.ok) return;
      } catch {}
    }
    process.stderr.write("daemonsudo hook: daemon spawned but /health not yet up — continuing\n");
  } catch (e) {
    process.stderr.write(`daemonsudo hook: could not spawn daemon (${e instanceof Error ? e.message : e})\n`);
  }
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--ensure-daemon")) {
    await ensureDaemon();
    process.exit(0);
  }

  let input: Record<string, unknown>;
  try {
    const raw = readFileSync(0, "utf8"); // fd 0 works with pipes; /dev/stdin doesn't in headless
    input = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    process.stderr.write(`daemonsudo hook: failed to read stdin: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  }

  const event = String(input.hook_event_name ?? "");

  if (event === "PermissionRequest") {
    await handlePermissionRequest(input);
    process.exit(0);
  }

  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    await handlePostToolUse(input);
    process.exit(0);
  }

  process.stderr.write(`daemonsudo hook: unknown hook_event_name '${event}' — ignoring\n`);
  process.exit(0);
}

// Auto-run when invoked directly (not imported as a module).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`daemonsudo hook: fatal: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  });
}
