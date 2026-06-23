/**
 * Unit tests for src/hook.ts — the stateless Claude Code hook client.
 *
 * Tests spawn `bun src/hook.ts` as a subprocess and feed it stdin, then
 * assert on stdout/stderr/exit code.  A minimal Bun.serve() mock HTTP server
 * stands in for the daemon so no real `daemonsudo serve` is needed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// Pinned to a unique port so parallel test files don't collide.
const MOCK_PORT = 14915;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const TOKEN = "testhooktoken";
const TOKEN_PATH = join(tmpdir(), `hook-test-token-${Date.now()}.txt`);

// The mock server records incoming requests so tests can inspect them.
let lastApproveReq: { body: unknown; headers: Record<string, string> } | undefined;
let lastReceiptReq: { body: unknown } | undefined;
let mockApproveResponse: { behavior: "allow" | "deny" } = { behavior: "allow" };
let mockApproveStatus = 200;

let mockServer: ReturnType<typeof Bun.serve> | undefined;

beforeAll(() => {
  writeFileSync(TOKEN_PATH, TOKEN + "\n");

  mockServer = Bun.serve({
    port: MOCK_PORT,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const headersObj: Record<string, string> = {};
      req.headers.forEach((v, k) => { headersObj[k] = v; });

      if (url.pathname === "/health") {
        return new Response("ok", { status: 200 });
      }
      if (url.pathname === "/gate/approve") {
        return req.json().then((body) => {
          lastApproveReq = { body, headers: headersObj };
          return Response.json(mockApproveResponse, { status: mockApproveStatus });
        });
      }
      if (url.pathname === "/gate/receipt") {
        return req.json().then((body) => {
          lastReceiptReq = { body };
          return new Response(null, { status: 204 });
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  mockServer?.stop(true);
  try { rmSync(TOKEN_PATH, { force: true }); } catch {}
});

afterEach(() => {
  lastApproveReq = undefined;
  lastReceiptReq = undefined;
  mockApproveResponse = { behavior: "allow" };
  mockApproveStatus = 200;
});

/** Spawn `bun src/hook.ts`, feed `input` to stdin, return stdout/stderr/exit. */
async function runHook(
  input: unknown,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", join(ROOT, "src", "hook.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DAEMONSUDO_BASE_URL: MOCK_BASE,
      DAEMONSUDO_TOKEN_PATH: TOKEN_PATH,
      ...env,
    },
  });
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("PermissionRequest", () => {
  test("daemon approves → emits allow to stdout, exit 0", async () => {
    mockApproveResponse = { behavior: "allow" };
    const { stdout, exitCode } = await runHook({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      permission_mode: "auto",
    });
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout) as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(out.hookSpecificOutput.decision.behavior).toBe("allow");
  });

  test("daemon denies → emits deny to stdout, exit 0", async () => {
    mockApproveResponse = { behavior: "deny" };
    const { stdout, stderr, exitCode } = await runHook({
      hook_event_name: "PermissionRequest",
      session_id: "s2",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
      permission_mode: "auto",
    });
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout) as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(out.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(stderr).toContain("remote decision");
  });

  test("daemon unreachable → fail closed (deny), exit 0", async () => {
    // Use a port nothing is listening on.
    const { stdout, stderr, exitCode } = await runHook(
      {
        hook_event_name: "PermissionRequest",
        session_id: "s3",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
      },
      { DAEMONSUDO_BASE_URL: "http://127.0.0.1:19999" },
    );
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout) as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(out.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(stderr).toContain("daemon unreachable");
  });

  test("daemon unreachable + FAIL_OPEN=1 → no stdout output, exit 0", async () => {
    const { stdout, stderr, exitCode } = await runHook(
      {
        hook_event_name: "PermissionRequest",
        session_id: "s4",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
      },
      { DAEMONSUDO_BASE_URL: "http://127.0.0.1:19999", DAEMONSUDO_HOOK_FAIL_OPEN: "1" },
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(""); // No output → CC falls through to its own dialog.
    expect(stderr).toContain("fail open");
  });

  test("token forwarded in x-daemonsudo-token header", async () => {
    await runHook({
      hook_event_name: "PermissionRequest",
      session_id: "s5",
      tool_name: "Bash",
      tool_input: {},
    });
    expect(lastApproveReq?.headers["x-daemonsudo-token"]).toBe(TOKEN);
  });
});

describe("PostToolUse / PostToolUseFailure", () => {
  test("PostToolUse → POSTs receipt, exit 0", async () => {
    const { exitCode, stderr } = await runHook({
      hook_event_name: "PostToolUse",
      session_id: "s6",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_response: { stdout: "hi\n", stderr: "" },
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe(""); // No warnings.
    expect(lastReceiptReq).toBeTruthy();
    expect((lastReceiptReq!.body as Record<string, unknown>).session_id).toBe("s6");
  });

  test("PostToolUseFailure → POSTs receipt, exit 0", async () => {
    const { exitCode } = await runHook({
      hook_event_name: "PostToolUseFailure",
      session_id: "s7",
      tool_name: "Bash",
      tool_input: { command: "bad cmd" },
      tool_response: { stdout: "", stderr: "command not found" },
    });
    expect(exitCode).toBe(0);
    expect(lastReceiptReq).toBeTruthy();
  });

  test("PostToolUse → daemon unreachable → logs warning, exit 0 (never blocks)", async () => {
    const start = Date.now();
    const { exitCode, stderr } = await runHook(
      {
        hook_event_name: "PostToolUse",
        session_id: "s8",
        tool_name: "Bash",
        tool_input: {},
        tool_response: {},
      },
      { DAEMONSUDO_BASE_URL: "http://127.0.0.1:19999" },
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("WARNING");
    // Should not hang — must complete well under 5s.
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

describe("unknown hook_event_name", () => {
  test("unknown event → logs warning, exit 0", async () => {
    const { exitCode, stderr } = await runHook({ hook_event_name: "SomeOtherHook" });
    expect(exitCode).toBe(0);
    expect(stderr).toContain("unknown");
  });
});
