/**
 * Stage 6 exit test: mirror receiver auth/monotonicity/append-only, and the
 * pusher's never-block-append + retry-after-recovery behavior. Port 14922.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { Ledger, loadOrCreateKeys, makeSigner, type Checkpoint } from "../src/ledger.js";
import { MirrorPusher, parseCheckpointLines, runMirrorReceiver } from "../src/mirror.js";
import { tmpDir } from "./helpers.js";

const PORT = 14922;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "mirror-test-token";

function cp(seq: number, hash: string, chain = "CHAIN1"): Checkpoint {
  return { chain_id: chain, seq, receipt_hash: hash, kid: "k1", sig: "ed25519:00" };
}

function post(body: unknown, token?: string) {
  return fetch(`${BASE}/checkpoint`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("receiver: bearer auth, seq monotonicity, hash pinning, append-only file", async () => {
  const file = join(tmpDir(), "mirror.jsonl");
  const receiver = await runMirrorReceiver({ host: "127.0.0.1", port: PORT, file, token: TOKEN });

  expect((await post(cp(1, "sha256:aa"))).status).toBe(401);
  expect((await post(cp(1, "sha256:aa"), "wrong")).status).toBe(401);

  expect((await post(cp(1, "sha256:aa"), TOKEN)).status).toBe(200);
  expect((await post(cp(2, "sha256:bb"), TOKEN)).status).toBe(200);
  // regression refused
  expect((await post(cp(1, "sha256:aa"), TOKEN)).status).toBe(409);
  // rewrite at the same seq refused
  expect((await post(cp(2, "sha256:EVIL"), TOKEN)).status).toBe(409);
  // idempotent re-send of the same head is fine and not re-appended
  expect((await post(cp(2, "sha256:bb"), TOKEN)).status).toBe(200);

  const stored = parseCheckpointLines(readFileSync(file, "utf8"));
  expect(stored.map((c) => c.seq)).toEqual([1, 2]);

  // reads are bearer-authed too, filterable by chain
  expect((await fetch(`${BASE}/checkpoints`)).status).toBe(401);
  const listed = (await (
    await fetch(`${BASE}/checkpoints?chain_id=CHAIN1`, { headers: { authorization: `Bearer ${TOKEN}` } })
  ).json()) as Checkpoint[];
  expect(listed.length).toBe(2);

  receiver.stop();
  await new Promise((r) => setTimeout(r, 50));

  // restart on the same file: the seq floor survives (rebuilt from JSONL)
  const again = await runMirrorReceiver({ host: "127.0.0.1", port: PORT, file, token: TOKEN });
  expect((await post(cp(1, "sha256:aa"), TOKEN)).status).toBe(409);
  expect((await post(cp(3, "sha256:cc"), TOKEN)).status).toBe(200);
  again.stop();
});

test("pusher: receiver down → append stays instant; checkpoint arrives after recovery", async () => {
  // the previous test's receiver must be fully gone — a zombie listener would eat our pushes
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(200) });
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      break; // port is dead — good
    }
  }
  const dir = tmpDir();
  const db = await openDb(join(dir, "gate.db"));
  const keys = loadOrCreateKeys(db);
  // nothing is listening on the port yet
  const pusher = new MirrorPusher({ url: BASE, token: TOKEN, initialBackoffMs: 100 });
  const ledger = new Ledger(db, [], makeSigner(keys), undefined, (c) => pusher.push(c));

  const t0 = Date.now();
  ledger.append({ server: "m", tool: "t1", args: {}, decision: "auto", rule: "r" });
  ledger.append({ server: "m", tool: "t2", args: {}, decision: "auto", rule: "r" });
  expect(Date.now() - t0).toBeLessThan(200); // dead mirror never blocks the ledger

  // bring the receiver up; the retry loop delivers the LATEST head
  const file = join(dir, "mirror.jsonl");
  const receiver = await runMirrorReceiver({ host: "127.0.0.1", port: PORT, file, token: TOKEN });
  let stored: Checkpoint[] = [];
  for (let i = 0; i < 50 && stored.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      stored = parseCheckpointLines(readFileSync(file, "utf8"));
    } catch {}
  }
  expect(stored.length).toBe(1); // latest-wins: one head, not two
  expect(stored[0].seq).toBe(2);
  expect(stored[0].kid).toBe(keys.kid);

  pusher.stop();
  receiver.stop();
  db.close();
}, 15000);
