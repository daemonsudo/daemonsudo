/**
 * Opt-in telemetry (GATE-PLAN §9): `telemetry: true` in gate.yaml, default
 * off. At most one ping a week of { version, anon_id } — the exact payload is
 * documented verbatim in the README. Nothing about tools, rules, or traffic,
 * ever. Every failure is swallowed: telemetry must never affect gating.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Db } from "./db.js";

export const TELEMETRY_URL = "https://daemonsudo.dev/ping";
const WEEK_MS = 7 * 24 * 3_600_000;

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function meta(db: Db, key: string): string | undefined {
  return db.get<{ value: string }>("SELECT value FROM ledger_meta WHERE key = ?", [key])?.value;
}

function setMeta(db: Db, key: string, value: string): void {
  db.run(
    "INSERT INTO ledger_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

/** Fire-and-forget weekly ping. Never throws, never blocks, never retried mid-run. */
export function maybeSendTelemetryPing(
  db: Db,
  enabled: boolean,
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
): void {
  try {
    if (!enabled) return;
    const last = meta(db, "telemetry_last_ping");
    if (last && now - Date.parse(last) < WEEK_MS) return;
    let anonId = meta(db, "telemetry_anon_id");
    if (!anonId) {
      anonId = randomBytes(16).toString("hex");
      setMeta(db, "telemetry_anon_id", anonId);
    }
    setMeta(db, "telemetry_last_ping", new Date(now).toISOString());
    void fetchFn(TELEMETRY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: packageVersion(), anon_id: anonId }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  } catch {
    /* telemetry must never affect gating */
  }
}
