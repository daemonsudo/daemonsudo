// Telemetry is opt-in, sends exactly {version, anon_id} at most weekly, and
// can never affect gating — failures are swallowed.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { maybeSendTelemetryPing, packageVersion, TELEMETRY_URL } from "../src/telemetry.js";
import { tmpDir } from "./helpers.js";

async function db() {
  return openDb(join(tmpDir(), "gate.db"));
}

function fakeFetch() {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fn = ((url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return Promise.resolve(new Response("ok"));
  }) as typeof fetch;
  return { fn, calls };
}

describe("telemetry", () => {
  test("off by default: disabled → no request, nothing stored", async () => {
    const d = await db();
    const { fn, calls } = fakeFetch();
    maybeSendTelemetryPing(d, false, fn);
    expect(calls).toEqual([]);
    expect(d.all("SELECT * FROM ledger_meta WHERE key LIKE 'telemetry%'")).toEqual([]);
    d.close();
  });

  test("enabled → exactly {version, anon_id}, at most once a week", async () => {
    const d = await db();
    const { fn, calls } = fakeFetch();
    const t0 = Date.parse("2026-06-13T00:00:00Z");

    maybeSendTelemetryPing(d, true, fn, t0);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(TELEMETRY_URL);
    const body = calls[0].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["anon_id", "version"]); // nothing else, ever
    expect(body.version).toBe(packageVersion());
    expect(body.anon_id).toMatch(/^[0-9a-f]{32}$/);

    // within the week: silent; after: pings again with the same anon_id
    maybeSendTelemetryPing(d, true, fn, t0 + 6 * 24 * 3_600_000);
    expect(calls.length).toBe(1);
    maybeSendTelemetryPing(d, true, fn, t0 + 8 * 24 * 3_600_000);
    expect(calls.length).toBe(2);
    expect((calls[1].body as Record<string, unknown>).anon_id).toBe(body.anon_id);
    d.close();
  });

  test("a broken endpoint or fetch can never throw into the gate", async () => {
    const d = await db();
    const rejecting = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const throwing = (() => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    expect(() => maybeSendTelemetryPing(d, true, rejecting)).not.toThrow();
    expect(() => maybeSendTelemetryPing(d, true, throwing, Date.now() + 8 * 24 * 3_600_000)).not.toThrow();
    d.close();
  });
});
