import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync } from "node:fs";
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

/**
 * Spawn `daemonsudo serve` with the given gate.yaml text and poll every
 * health URL until ready. Caller owns cleanup via the returned kill().
 */
export async function spawnServe(opts: {
  configYaml: string;
  db: string;
  tokenPath: string;
  healthUrls: string[];
  env?: Record<string, string>;
}): Promise<{ kill(signal?: number | NodeJS.Signals): void }> {
  const configPath = join(tmpDir(), "gate.yaml");
  writeFileSync(configPath, opts.configYaml);
  const proc = Bun.spawn(["bun", join(ROOT, "src", "index.ts"), "serve", "--config", configPath], {
    env: cleanEnv({
      DAEMONSUDO_DB: opts.db,
      DAEMONSUDO_TOKEN_PATH: opts.tokenPath,
      ...opts.env,
    }),
    stderr: "pipe",
    stdout: "pipe",
  });
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try {
      const checks = await Promise.all(
        opts.healthUrls.map((u) => fetch(`${u}/health`, { signal: AbortSignal.timeout(500) })),
      );
      if (checks.every((r) => r.ok)) return proc;
    } catch {}
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error("serve did not become ready on all listeners");
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
