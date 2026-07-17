/**
 * The serve token authenticates /gate/* callers (CC hooks, remote proxies,
 * the grants CLI). Resolution order: DAEMONSUDO_TOKEN (direct value — for
 * container env injection) beats DAEMONSUDO_TOKEN_PATH (mounted secret)
 * beats ~/.gate/serve.token.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function tokenPath(): string {
  return process.env.DAEMONSUDO_TOKEN_PATH ?? join(homedir(), ".gate", "serve.token");
}

function envToken(): string | undefined {
  return process.env.DAEMONSUDO_TOKEN?.trim() || undefined;
}

/** Read-only lookup for clients (hook, CLI, remote proxy). */
export function loadToken(): string | undefined {
  const env = envToken();
  if (env) return env;
  try {
    const path = tokenPath();
    return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Daemon-side: mint and persist the token on first run. */
export function loadOrCreateToken(): string {
  const env = envToken();
  if (env) return env;
  const path = tokenPath();
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const tok = randomBytes(32).toString("hex");
  const dir = join(homedir(), ".gate");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, tok, { mode: 0o600 });
  return tok;
}
