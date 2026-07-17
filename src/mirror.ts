/**
 * Checkpoint mirror: streams each signed head checkpoint to an off-box
 * receiver so truncation/rewrite by the key holder becomes detectable
 * (`verify --against`). The pusher keeps only the LATEST head — a head at
 * seq N covers 1..N via the chain walk — and never blocks receipt writes.
 * The receiver is a tiny append-only JSONL store that refuses regressions.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Checkpoint } from "./ledger.js";
import { listenOn } from "./web/index.js";

export class MirrorPusher {
  private latest: string | undefined;
  private inflight = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private backoffMs: number;
  private failures = 0;
  private fetchFn: typeof fetch;
  private stopped = false;

  constructor(
    private opts: { url: string; token?: string; fetchFn?: typeof fetch; initialBackoffMs?: number },
  ) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.backoffMs = opts.initialBackoffMs ?? 1_000;
  }

  /** The ledger's onCheckpoint seam. Synchronous and instant — never blocks append. */
  push(checkpointJson: string): void {
    this.latest = checkpointJson;
    this.kick();
  }

  stop(): void {
    // `stopped` also stops an in-flight send's completion from re-arming the retry loop
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private kick(): void {
    if (this.stopped || this.inflight || this.timer || this.latest === undefined) return;
    void this.send();
  }

  private async send(): Promise<void> {
    const payload = this.latest!;
    this.latest = undefined;
    this.inflight = true;
    try {
      const res = await this.fetchFn(`${this.opts.url}/checkpoint`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
        },
        body: payload,
      });
      // 409 = the mirror already holds a newer head — ours is superseded, not a failure.
      if (!res.ok && res.status !== 409) throw new Error(`mirror replied ${res.status}`);
      this.failures = 0;
      this.backoffMs = this.opts.initialBackoffMs ?? 1_000;
      this.inflight = false;
      this.kick(); // a newer head may have arrived while we were sending
    } catch (e) {
      if (this.latest === undefined) this.latest = payload; // retry unless superseded
      this.inflight = false;
      this.failures++;
      if (this.failures === 1 || this.failures % 10 === 0) {
        console.error(
          `daemonsudo: mirror push failing (${this.failures}x): ${e instanceof Error ? e.message : e} — receipts unaffected, retrying`,
        );
      }
      if (!this.stopped) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.kick();
        }, this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      }
    }
  }
}

function bearerOk(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice("Bearer ".length));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCheckpointLines(text: string): Checkpoint[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Checkpoint);
}

/**
 * `daemonsudo mirror --listen` — append-only JSONL checkpoint receiver.
 * Refuses seq regressions and hash changes at the same seq (409): once the
 * mirror saw seq N, the key holder can't quietly rewrite history below it.
 */
export async function runMirrorReceiver(opts: {
  host: string;
  port: number;
  file: string;
  token: string;
}): Promise<{ stop(): void }> {
  // heads: chain_id → highest checkpoint seen (rebuilt from the file on restart)
  const heads = new Map<string, Checkpoint>();
  const lines: Checkpoint[] = existsSync(opts.file)
    ? parseCheckpointLines(readFileSync(opts.file, "utf8"))
    : [];
  for (const cp of lines) {
    const prev = heads.get(cp.chain_id);
    if (!prev || cp.seq > prev.seq) heads.set(cp.chain_id, cp);
  }

  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/checkpoint", async (c) => {
    if (!bearerOk(c.req.header("authorization"), opts.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let cp: Checkpoint;
    try {
      cp = await c.req.json();
    } catch {
      return c.json({ error: "bad json" }, 400);
    }
    if (!cp.chain_id || typeof cp.seq !== "number" || !cp.receipt_hash || !cp.sig) {
      return c.json({ error: "chain_id, seq, receipt_hash, sig required" }, 400);
    }
    const head = heads.get(cp.chain_id);
    if (head) {
      if (cp.seq < head.seq) return c.json({ error: `seq regression (have ${head.seq})` }, 409);
      if (cp.seq === head.seq && cp.receipt_hash !== head.receipt_hash) {
        return c.json({ error: `hash change at seq ${cp.seq} — rewrite attempt?` }, 409);
      }
    }
    if (!head || cp.seq > head.seq) {
      appendFileSync(opts.file, JSON.stringify(cp) + "\n");
      heads.set(cp.chain_id, cp);
    }
    return c.json({ ok: true });
  });

  app.get("/checkpoints", (c) => {
    if (!bearerOk(c.req.header("authorization"), opts.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const chainId = c.req.query("chain_id");
    const all = existsSync(opts.file) ? parseCheckpointLines(readFileSync(opts.file, "utf8")) : [];
    return c.json(chainId ? all.filter((cp) => cp.chain_id === chainId) : all);
  });

  const stop = await listenOn(app, opts.host, opts.port);
  console.error(
    `daemonsudo mirror: receiving checkpoints at http://${opts.host}:${opts.port} → ${opts.file}`,
  );
  return { stop };
}
