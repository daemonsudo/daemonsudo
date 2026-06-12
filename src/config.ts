import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { sha256 } from "./ledger.js";

export type Action = "auto" | "approve" | "deny";

export interface Rule {
  pattern: string;
  action: Action;
}

export interface GateConfig {
  defaults: Action;
  timeoutMs: number;
  rules: Rule[];
  redact: string[];
  telegram?: {
    tokenEnv: string;
    allowedUsers: number[];
  };
  web: {
    host: string;
    port: number;
  };
  /** sha256 of the gate.yaml bytes in force — stamped on every receipt */
  gateHash: string;
  /** opt-in weekly ping of {version, anon_id} — default off */
  telemetry: boolean;
}

const ACTIONS: Action[] = ["auto", "approve", "deny"];

export function parseDuration(value: string | number): number {
  if (typeof value === "number") return value * 1000;
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(value.trim());
  if (!m) throw new Error(`invalid duration: '${value}' (use e.g. 30s, 10m, 1h)`);
  const n = Number(m[1]);
  switch (m[2] ?? "s") {
    case "ms": return n;
    case "s": return n * 1000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    default: return n * 1000;
  }
}

function asAction(value: unknown, where: string): Action {
  if (typeof value === "string" && ACTIONS.includes(value as Action)) return value as Action;
  throw new Error(`invalid action '${String(value)}' in ${where} (expected auto | approve | deny)`);
}

export function defaultDbPath(): string {
  return process.env.DAEMONSUDO_DB ?? join(homedir(), ".gate", "gate.db");
}

/**
 * Load gate.yaml. With no explicit path, ./gate.yaml is used when present;
 * otherwise the built-in safe defaults apply (everything requires approval).
 */
export function loadConfig(path?: string): GateConfig {
  let raw: Record<string, unknown> = {};
  let gateHash = sha256("daemonsudo-builtin-defaults");
  const file = path ?? join(process.cwd(), "gate.yaml");
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    raw = (parse(text) ?? {}) as Record<string, unknown>;
    gateHash = sha256(text);
  } else if (path) {
    throw new Error(`config file not found: ${path}`);
  }

  const rules: Rule[] = Object.entries((raw.rules ?? {}) as Record<string, unknown>).map(
    ([pattern, action]) => ({ pattern, action: asAction(action, `rule '${pattern}'`) }),
  );

  const channels = (raw.channels ?? {}) as Record<string, Record<string, unknown>>;
  const tg = channels.telegram;
  const web = channels.web ?? {};

  return {
    defaults: raw.defaults === undefined ? "approve" : asAction(raw.defaults, "defaults"),
    timeoutMs: parseDuration((raw.timeout as string | number) ?? "10m"),
    rules,
    redact: ((raw.redact ?? []) as unknown[]).map(String),
    telegram: tg
      ? {
          tokenEnv: String(tg.token_env ?? "GATE_TELEGRAM_TOKEN"),
          allowedUsers: ((tg.allowed_users ?? []) as unknown[]).map(Number),
        }
      : undefined,
    web: {
      host: String(web.host ?? "127.0.0.1"),
      port: web.port === undefined ? 4910 : Number(web.port),
    },
    gateHash,
    telemetry: raw.telemetry === true,
  };
}
