import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const MOCK = ["node", join(ROOT, "examples", "mock-server.mjs")];

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "daemonsudo-test-"));
}

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { ...env, ...extra };
}

/** Client connected straight to the mock server (no gate). */
export async function connectDirect(env: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: MOCK[0],
    args: MOCK.slice(1),
    env: cleanEnv(env),
  });
  await client.connect(transport);
  return client;
}

/** Client connected to the mock server through the gate. */
export async function connectThroughGate(opts: {
  config?: string;
  env?: Record<string, string>;
} = {}): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const gateArgs = [join(ROOT, "src", "index.ts")];
  if (opts.config) gateArgs.push("--config", opts.config);
  gateArgs.push("--", ...MOCK);
  const transport = new StdioClientTransport({
    command: "bun",
    args: gateArgs,
    env: cleanEnv(opts.env ?? {}),
    stderr: "inherit",
  });
  await client.connect(transport);
  return client;
}
