/**
 * CC door integration tests.
 *
 * Starts `daemonsudo serve` on pinned port 14914, sends synthetic hook payloads
 * via direct HTTP (bypassing the actual Claude Code binary), and asserts receipt
 * chain integrity.
 *
 * Ports 14909–14913 are owned by existing MCP tests; 14914 is exclusively ours.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import {
  Ledger,
  loadOrCreateKeys,
  makeSigner,
  makeVerifier,
  verifyChain,
  type Receipt,
} from "../src/ledger.js";

const PORT = 14914;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DB = join(tmpdir(), `daemonsudo-cc-test-${Date.now()}.db`);
const TEST_TOKEN_PATH = join(tmpdir(), `daemonsudo-cc-test-${Date.now()}.token`);
const ROOT = join(import.meta.dir, "..");

let serve: ReturnType<typeof Bun.spawn> | undefined;

async function waitReady(ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch {}
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  throw new Error("serve did not become ready");
}

function postHook(path: string, body: unknown, token: string) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-daemonsudo-token": token },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  serve = Bun.spawn(
    ["bun", join(ROOT, "src", "index.ts"), "serve", "--config", join(ROOT, "presets", "claude-code.yaml")],
    {
      env: {
        ...process.env,
        DAEMONSUDO_DB: TEST_DB,
        DAEMONSUDO_TOKEN_PATH: TEST_TOKEN_PATH,
        // Override the port for isolation.
        // The claude-code preset binds 127.0.0.1:4910; we need 14914.
        // We patch via env since config.web.port comes from the yaml.
        // Easiest: write a temp config that overrides the port.
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  // Give it a moment then check stderr for port override problem.
  // Actually we need to override the port. Let's write a temp config.
  serve.kill();

  // Write a temp config that uses port 14914.
  const configPath = join(tmpdir(), `cc-test-config-${Date.now()}.yaml`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(configPath, `timeout: 9m\nredact: ["*.token"]\nchannels:\n  web:\n    host: "127.0.0.1"\n    port: ${PORT}\n`);

  serve = Bun.spawn(
    ["bun", join(ROOT, "src", "index.ts"), "serve", "--config", configPath],
    {
      env: { ...process.env, DAEMONSUDO_DB: TEST_DB, DAEMONSUDO_TOKEN_PATH: TEST_TOKEN_PATH },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  await waitReady();
});

afterAll(() => {
  serve?.kill();
  try { rmSync(TEST_DB, { force: true }); } catch {}
  try { rmSync(TEST_TOKEN_PATH, { force: true }); } catch {}
});

function token(): string {
  return readFileSync(TEST_TOKEN_PATH, "utf8").trim();
}

describe("cc-serve /gate/approve + /gate/receipt", () => {
  test("auto-approved call (no PermissionRequest) → receipt with decision=auto", async () => {
    const r = await postHook("/gate/receipt", {
      session_id: "sess-auto",
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: { stdout: "hello\n", stderr: "" },
      hook_event_name: "PostToolUse",
    }, token());
    expect(r.ok).toBe(true);

    // Verify the receipt landed.
    const db = await openDb(TEST_DB);
    const row = db.get<{ decision: string; json: string }>(
      "SELECT decision, json FROM receipts ORDER BY seq DESC LIMIT 1",
    );
    db.close();
    expect(row?.decision).toBe("auto");
    const receipt = JSON.parse(row!.json) as Receipt;
    expect(receipt.tool).toBe("Bash");
    expect(receipt.result?.status).toBe("ok");
  });

  test("approved call → stash → receipt with decision=approved + approver", async () => {
    const t = token();
    const sessionId = "sess-approve-1";
    const toolInput = { command: "git push origin main" };

    // Park the call: /gate/approve blocks until broker decides.
    let approveResp: Response | undefined;
    const gatePromise = postHook("/gate/approve", {
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: toolInput,
    }, t).then((r) => { approveResp = r; });

    // Wait for broker to park the call in SQLite.
    await new Promise<void>((r) => setTimeout(r, 400));

    // Read pending ID + token directly from the DB (avoids HTML parsing brittleness).
    const dbR = await openDb(TEST_DB);
    const pending = dbR.get<{ id: string; token: string }>(
      "SELECT id, token FROM pending WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1",
    );
    dbR.close();
    expect(pending).toBeTruthy();

    // Approve via the web form.
    const decideRes = await fetch(`${BASE}/approve/${pending!.id}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `t=${pending!.token}&action=approve`,
    });
    expect(decideRes.ok).toBe(true);

    // /gate/approve should now return allow.
    await gatePromise;
    expect(approveResp?.ok).toBe(true);
    const gateBody = await approveResp!.json() as { behavior: string };
    expect(gateBody.behavior).toBe("allow");

    // Simulate PostToolUseFailure (git push failed — no remote).
    const receiptRes = await postHook("/gate/receipt", {
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: toolInput,
      tool_response: { stdout: "", stderr: "fatal: 'origin' does not appear to be a git repository" },
      hook_event_name: "PostToolUseFailure",
    }, t);
    expect(receiptRes.ok).toBe(true);

    // Verify the receipt.
    const db = await openDb(TEST_DB);
    const row = db.get<{ decision: string; json: string }>(
      "SELECT decision, json FROM receipts WHERE tool = 'Bash' ORDER BY seq DESC LIMIT 1",
    );
    db.close();
    expect(row?.decision).toBe("approved");
    const receipt = JSON.parse(row!.json) as Receipt;
    expect(receipt.approver?.channel).toBe("web");
    expect(receipt.result?.status).toBe("error");
    expect(receipt.result?.content_hash).toMatch(/^sha256:/);
  });

  test("denied call → terminal receipt with decision=denied, no result", async () => {
    const t = token();
    const sessionId = "sess-deny-1";
    const toolInput = { command: "rm -rf /" };

    let gateResp: Response | undefined;
    const gatePromise = postHook("/gate/approve", {
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: toolInput,
    }, t).then((r) => { gateResp = r; });

    await new Promise<void>((r) => setTimeout(r, 400));

    // Read pending and deny.
    const dbR = await openDb(TEST_DB);
    const pending = dbR.get<{ id: string; token: string }>(
      "SELECT id, token FROM pending WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1",
    );
    dbR.close();
    expect(pending).toBeTruthy();

    await fetch(`${BASE}/approve/${pending!.id}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `t=${pending!.token}&action=deny`,
    });

    await gatePromise;
    expect(gateResp?.ok).toBe(true);
    const body = await gateResp!.json() as { behavior: string };
    expect(body.behavior).toBe("deny");

    // Verify terminal receipt (written at deny time, no result field).
    const db = await openDb(TEST_DB);
    const row = db.get<{ decision: string; json: string }>(
      "SELECT decision, json FROM receipts ORDER BY seq DESC LIMIT 1",
    );
    db.close();
    expect(row?.decision).toBe("denied");
    const receipt = JSON.parse(row!.json) as Receipt;
    expect(receipt.result).toBeUndefined();
    expect(receipt.approver?.channel).toBe("web");
  });

  test("unauthorized token → 401", async () => {
    const r = await postHook("/gate/receipt", { session_id: "x", tool_name: "Bash", tool_input: {} }, "wrongtoken");
    expect(r.status).toBe(401);
  });

  test("receipt chain passes daemonsudo verify", async () => {
    const db = await openDb(TEST_DB);
    const keys = db.all<{ kid: string; public_hex: string }>("SELECT kid, public_hex FROM keys");
    const verifiers = new Map(keys.map((k) => [k.kid, makeVerifier(k.public_hex)]));
    const result = verifyChain(db, verifiers);
    db.close();
    expect(result.ok).toBe(true);
    expect(result.count).toBeGreaterThan(0);
  });
});
