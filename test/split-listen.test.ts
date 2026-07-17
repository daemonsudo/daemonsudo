/**
 * Stage 4 exit test: dual listeners. Web/operator listener on 14918,
 * gate-API listener on 14919. The gate listener serves ONLY /health +
 * /gate/* (token-authed); operator pages 404 there. /gate/* stays mounted
 * on the web listener for back-compat.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnServe, tmpDir } from "./helpers.js";

const WEB = "http://127.0.0.1:14918";
const GATE = "http://127.0.0.1:14919";
const DIR = tmpDir();
const TEST_DB = join(DIR, "gate.db");
const TEST_TOKEN_PATH = join(DIR, "serve.token");

let serve: { kill(): void } | undefined;

beforeAll(async () => {
  serve = await spawnServe({
    configYaml: `timeout: 9m
gate:
  listen: { host: "127.0.0.1", port: 14919 }
channels:
  web: { host: "127.0.0.1", port: 14918 }
`,
    db: TEST_DB,
    tokenPath: TEST_TOKEN_PATH,
    healthUrls: [WEB, GATE],
  });
});

afterAll(() => serve?.kill());

function token(): string {
  return readFileSync(TEST_TOKEN_PATH, "utf8").trim();
}

function postReceipt(base: string, tok?: string) {
  return fetch(`${base}/gate/receipt`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(tok ? { "x-daemonsudo-token": tok } : {}),
    },
    body: JSON.stringify({
      session_id: "split",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_response: { stdout: "hi\n" },
      hook_event_name: "PostToolUse",
    }),
  });
}

test("/health is tokenless on both listeners", async () => {
  expect((await fetch(`${WEB}/health`)).ok).toBe(true);
  expect((await fetch(`${GATE}/health`)).ok).toBe(true);
});

test("gate listener: /gate/receipt works with token, 401 without", async () => {
  expect((await postReceipt(GATE, token())).ok).toBe(true);
  expect((await postReceipt(GATE)).status).toBe(401);
  expect((await postReceipt(GATE, "wrong")).status).toBe(401);
});

test("operator pages 404 on the gate listener", async () => {
  expect((await fetch(`${GATE}/receipts`)).status).toBe(404);
  expect((await fetch(`${GATE}/pending`)).status).toBe(404);
  expect((await fetch(`${GATE}/grants`)).status).toBe(404);
  expect((await fetch(`${GATE}/approve/someid`)).status).toBe(404);
});

test("back-compat: /gate/* still works on the web listener; operator pages too", async () => {
  expect((await postReceipt(WEB, token())).ok).toBe(true);
  expect((await fetch(`${WEB}/receipts`)).status).toBe(200);
  expect((await fetch(`${WEB}/pending`)).status).toBe(200);
});
