#!/usr/bin/env node
/**
 * daemonsudo — sudo for AI agents.
 *
 *   daemonsudo [--config gate.yaml] -- <command> [args...]   MCP gate (v0.1 door)
 *   daemonsudo serve [--config gate.yaml]                    CC daemon (v0.2 door)
 *   daemonsudo hook [--ensure-daemon]                        CC hook client (stdin→daemon)
 *   daemonsudo init [--preset <name>]                        write a starter gate.yaml
 *   daemonsudo verify [--db path]                            verify the receipt chain
 *   daemonsudo receipts [--db path]                          print recent receipts
 *   daemonsudo grants [--db path]                            list standing grants
 *   daemonsudo grant <server> <tool> --ttl 15m|1h|8h         mint a grant (operator-side)
 *   daemonsudo revoke <grant-id>                             revoke a grant (operator-side)
 *   daemonsudo mirror --listen <host:port> [--file path]     off-box checkpoint receiver
 */
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalBroker } from "./broker.js";
import { DiscordChannel } from "./channels/discord.js";
import { TelegramChannel } from "./channels/telegram.js";
import { defaultDbPath, loadConfig, parseDuration } from "./config.js";
import { DecisionCore } from "./core.js";
import { openDb, type Db } from "./db.js";
import { BOOT_ID, createGrantWithReceipt, GrantStore, revokeGrantWithReceipt } from "./grants.js";
import {
  Ledger,
  loadOrCreateKeys,
  makeSigner,
  makeVerifier,
  verifyAgainstMirror,
  verifyChain,
  type Checkpoint,
  type Receipt,
} from "./ledger.js";
import { MirrorPusher, parseCheckpointLines, runMirrorReceiver } from "./mirror.js";
import { GateProxy, ToolGate } from "./proxy.js";
import { RemoteToolGate } from "./remote.js";
import { YamlGlobEngine } from "./rules.js";
import { loadToken } from "./token.js";
import { maybeSendTelemetryPing } from "./telemetry.js";
import { startWeb } from "./web/index.js";

const PRESETS_DIR = fileURLToPath(new URL("../presets/", import.meta.url));

function presetNames(): string[] {
  try {
    return readdirSync(PRESETS_DIR)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => f.slice(0, -".yaml".length))
      .filter((n) => n !== "default")
      .sort();
  } catch {
    return [];
  }
}

function usage(): never {
  console.error(
    "usage: daemonsudo [--config gate.yaml] -- <command> [args...]\n" +
      "       daemonsudo serve [--config gate.yaml]\n" +
      "       daemonsudo hook [--ensure-daemon]\n" +
      `       daemonsudo init [--preset ${presetNames().join("|")}]\n` +
      "       daemonsudo verify [--db path] [--against <url|file>]\n" +
      "       daemonsudo receipts [--db path]\n" +
      "       daemonsudo grants [--db path]\n" +
      "       daemonsudo grant <server> <tool> [--ttl 15m|1h|8h] [--db path]\n" +
      "       daemonsudo revoke <grant-id> [--db path]\n" +
      "       daemonsudo mirror --listen <host:port> [--file mirror.jsonl]",
  );
  process.exit(2);
}

function cmdInit(args: string[]): never {
  // Special-case the CC plugin preset to show install instructions.
  if (args[0] === "--preset" && args[1] === "claude-code") {
    console.log(
      "Install the daemonsudo Claude Code plugin to register the hooks and auto-start the daemon:\n" +
        "  claude plugin install daemonsudo\n\n" +
        "Or for manual installation, copy examples/claude-code-settings.json into your project's\n" +
        ".claude/settings.json (or ~/.claude/settings.json for all projects), then run:\n" +
        "  daemonsudo serve",
    );
    process.exit(0);
  }
  const i = args.indexOf("--preset");
  const preset = i === -1 ? undefined : args[i + 1];
  if (i !== -1 && !preset) usage();
  const available = presetNames();
  if (preset && !available.includes(preset)) {
    console.error(`daemonsudo: unknown preset '${preset}' (available: ${available.join(", ")})`);
    process.exit(2);
  }
  const target = join(process.cwd(), "gate.yaml");
  if (existsSync(target)) {
    console.error("daemonsudo: gate.yaml already exists here — move it aside first");
    process.exit(1);
  }
  copyFileSync(join(PRESETS_DIR, `${preset ?? "default"}.yaml`), target);
  console.log(
    `wrote gate.yaml${preset ? ` (preset: ${preset})` : ""} — edit the rules, then wrap your server:\n` +
      "  daemonsudo --config gate.yaml -- <your mcp server command>",
  );
  process.exit(0);
}

function dbPathFromFlags(args: string[]): string {
  const i = args.indexOf("--db");
  return i !== -1 && args[i + 1] ? args[i + 1] : defaultDbPath();
}

/** Load mirrored checkpoints from a receiver URL (bearer-authed) or a JSONL file. */
async function loadCheckpoints(source: string): Promise<Checkpoint[]> {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const token = process.env.DAEMONSUDO_MIRROR_TOKEN;
    const res = await fetch(`${source}/checkpoints`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`mirror replied ${res.status} (set DAEMONSUDO_MIRROR_TOKEN?)`);
    return (await res.json()) as Checkpoint[];
  }
  return parseCheckpointLines(readFileSync(source, "utf8"));
}

async function cmdVerify(args: string[]): Promise<never> {
  const db = await openDb(dbPathFromFlags(args));
  const keys = db.all<{ kid: string; public_hex: string }>("SELECT kid, public_hex FROM keys");
  if (keys.length === 0) {
    const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM receipts")?.n ?? 0;
    if (n === 0) {
      console.log("✓ empty ledger (no receipts yet)");
      process.exit(0);
    }
    console.error(`✗ ${n} receipts but no signing key — cannot verify`);
    process.exit(1);
  }
  const verifiers = new Map(keys.map((k) => [k.kid, makeVerifier(k.public_hex)]));
  const result = verifyChain(db, verifiers);
  if (!result.ok) {
    const where = result.badSeq === undefined ? "" : ` at receipt #${result.badSeq}`;
    console.error(`✗ chain INVALID${where}: ${result.error}`);
    console.error(`  (${result.count} receipts total)`);
    process.exit(1);
  }
  console.log(
    `✓ ${result.count} receipts verified — hash chain intact, head checkpoint matches, all signatures valid`,
  );
  for (const k of keys) console.log(`  key ${k.kid}: ed25519:${k.public_hex}`);

  const ai = args.indexOf("--against");
  if (ai !== -1) {
    const source = args[ai + 1];
    if (!source) usage();
    let mirrored: Checkpoint[];
    try {
      mirrored = await loadCheckpoints(source);
    } catch (e) {
      console.error(`✗ could not load mirror checkpoints: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    const against = verifyAgainstMirror(db, verifiers, mirrored);
    if (!against.ok) {
      console.error(`✗ mirror check FAILED: ${against.error}`);
      process.exit(1);
    }
    console.log(`✓ ${against.count} mirrored checkpoints match — no truncation, no rewrites`);
  }
  process.exit(0);
}

async function cmdMirror(args: string[]): Promise<void> {
  const li = args.indexOf("--listen");
  const hostPort = li !== -1 ? args[li + 1] : undefined;
  if (!hostPort) usage();
  const colon = hostPort.lastIndexOf(":");
  const host = colon === -1 ? "127.0.0.1" : hostPort.slice(0, colon);
  const port = Number(hostPort.slice(colon + 1));
  if (!Number.isFinite(port)) usage();
  const fi = args.indexOf("--file");
  const file = fi !== -1 && args[fi + 1] ? args[fi + 1] : "mirror.jsonl";
  const token = process.env.DAEMONSUDO_MIRROR_TOKEN;
  if (!token) {
    console.error("daemonsudo mirror: DAEMONSUDO_MIRROR_TOKEN must be set (bearer auth)");
    process.exit(2);
  }
  await runMirrorReceiver({ host, port, file, token });
  // keep running until killed — the listener holds the event loop open
}

async function cmdReceipts(args: string[]): Promise<never> {
  const db: Db = await openDb(dbPathFromFlags(args));
  const rows = db.all<{ json: string }>("SELECT json FROM receipts ORDER BY seq DESC LIMIT 50");
  if (rows.length === 0) {
    console.log("no receipts yet.");
    process.exit(0);
  }
  for (const row of rows.reverse()) {
    const r = JSON.parse(row.json) as Receipt;
    const who = r.approver ? ` by ${r.approver.channel}:${r.approver.user}` : "";
    console.log(`#${String(r.seq).padEnd(5)} ${r.ts}  ${r.decision.padEnd(8)} ${r.tool}  [${r.rule}]${who}  ${r.id}`);
  }
  process.exit(0);
}

const DAEMON_BASE = process.env.DAEMONSUDO_BASE_URL ?? "http://127.0.0.1:4910";

/** POST to a live daemon so it stays the ledger's writer; undefined when it's down. */
async function daemonPost(path: string, body: unknown): Promise<Response | undefined> {
  try {
    const up = await fetch(`${DAEMON_BASE}/health`, { signal: AbortSignal.timeout(1_500) });
    if (!up.ok) return undefined;
  } catch {
    return undefined;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = loadToken();
  if (token) headers["x-daemonsudo-token"] = token;
  return fetch(`${DAEMON_BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** Positional args, skipping `--flag value` pairs for the given value-taking flags. */
function positionalArgs(args: string[], valueFlags: string[]): string[] {
  return args.filter((a, i) => !a.startsWith("--") && !valueFlags.includes(args[i - 1] ?? ""));
}

function grantState(g: { revoked_at: string | null; expires_at: string | null }): string {
  if (g.revoked_at) return `revoked ${g.revoked_at}`;
  return g.expires_at ? `expires ${g.expires_at}` : "session";
}

async function cmdGrantsList(args: string[]): Promise<never> {
  const db = await openDb(dbPathFromFlags(args));
  const rows = new GrantStore(db).list();
  if (rows.length === 0) {
    console.log("no grants.");
    process.exit(0);
  }
  for (const g of rows) {
    console.log(`${g.id}  ${g.server} ${g.tool}  ${grantState(g)}  by ${g.created_channel}:${g.created_user}`);
  }
  process.exit(0);
}

async function cmdGrantCreate(args: string[]): Promise<never> {
  const [server, tool] = positionalArgs(args, ["--ttl", "--db"]);
  if (!server || !tool) usage();
  const ttlIdx = args.indexOf("--ttl");
  const ttlMs = parseDuration(ttlIdx !== -1 && args[ttlIdx + 1] ? args[ttlIdx + 1] : "1h");
  const user = process.env.USER ?? "operator";

  const viaDaemon = await daemonPost("/gate/grants", { server, tool, ttl_ms: ttlMs, user });
  if (viaDaemon) {
    const body = (await viaDaemon.json()) as { ok?: boolean; grant?: { id: string; expires_at: string }; error?: string };
    if (!viaDaemon.ok || !body.grant) {
      console.error(`daemonsudo: grant failed: ${body.error ?? viaDaemon.status}`);
      process.exit(1);
    }
    console.log(`grant ${body.grant.id} — ${server} ${tool} expires ${body.grant.expires_at} (via daemon)`);
    process.exit(0);
  }

  const config = loadConfig();
  const db = await openDb(dbPathFromFlags(args));
  const ledger = new Ledger(db, config.redact, makeSigner(loadOrCreateKeys(db)), config.gateHash);
  const grant = createGrantWithReceipt(new GrantStore(db), ledger, {
    server,
    tool,
    intent: { ttlMs },
    maxTtlMs: config.grantsMaxTtlMs,
    bootId: BOOT_ID,
    channel: "cli",
    user,
  });
  console.log(`grant ${grant.id} — ${server} ${tool} expires ${grant.expires_at}`);
  process.exit(0);
}

async function cmdGrantRevoke(args: string[]): Promise<never> {
  const [id] = positionalArgs(args, ["--db"]);
  if (!id) usage();
  const user = process.env.USER ?? "operator";

  const viaDaemon = await daemonPost("/gate/grants/revoke", { id, user });
  if (viaDaemon) {
    const body = (await viaDaemon.json()) as { ok?: boolean; error?: string };
    if (!viaDaemon.ok) {
      console.error(`daemonsudo: revoke failed: ${body.error ?? viaDaemon.status}`);
      process.exit(1);
    }
    console.log(`revoked ${id} (via daemon)`);
    process.exit(0);
  }

  const config = loadConfig();
  const db = await openDb(dbPathFromFlags(args));
  const ledger = new Ledger(db, config.redact, makeSigner(loadOrCreateKeys(db)), config.gateHash);
  const res = revokeGrantWithReceipt(new GrantStore(db), ledger, id, "cli", user);
  if (!res.ok) {
    console.error(`daemonsudo: revoke failed: ${res.error}`);
    process.exit(1);
  }
  console.log(`revoked ${id}`);
  process.exit(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "init") return cmdInit(argv.slice(1));
  if (argv[0] === "verify") return cmdVerify(argv.slice(1));
  if (argv[0] === "receipts") return cmdReceipts(argv.slice(1));
  if (argv[0] === "grants") return cmdGrantsList(argv.slice(1));
  if (argv[0] === "grant") return cmdGrantCreate(argv.slice(1));
  if (argv[0] === "revoke") return cmdGrantRevoke(argv.slice(1));
  if (argv[0] === "mirror") return cmdMirror(argv.slice(1));

  // CC plugin commands — dispatch before flag parsing so they get their own argv.
  if (argv[0] === "serve") {
    const { runServe } = await import("./serve.js");
    const i = argv.indexOf("--config");
    await runServe(i !== -1 ? argv[i + 1] : undefined);
    return;
  }
  if (argv[0] === "hook") {
    const { main: hookMain } = await import("./hook.js");
    await hookMain();
    return;
  }

  // Flags end at `--` or at the first token that isn't a flag (some runners,
  // e.g. bun, swallow the `--` separator).
  let configPath: string | undefined;
  let i = 0;
  for (; i < argv.length; i++) {
    if (argv[i] === "--") {
      i++;
      break;
    }
    if (argv[i] === "--config") configPath = argv[++i];
    else if (argv[i].startsWith("-")) usage();
    else break;
  }
  const cmd = argv.slice(i);
  if (cmd.length === 0) usage();
  const config = loadConfig(configPath);

  // Remote-broker mode: no local db/ledger/rules/broker/web/telegram at all —
  // the host daemon owns policy, keys, and the ledger. This proxy just asks.
  const remoteUrl = process.env.DAEMONSUDO_REMOTE_URL ?? config.remoteUrl;
  if (remoteUrl) {
    const proxy = new GateProxy({
      command: cmd[0],
      args: cmd.slice(1),
      interceptor: new RemoteToolGate({ url: remoteUrl, token: loadToken() }),
    });
    await proxy.start();
    console.error(
      `daemonsudo: remote-broker mode — gating '${cmd.join(" ")}' via ${remoteUrl} (daemon down = fail closed, auto included)`,
    );
    return;
  }

  const db = await openDb(defaultDbPath());
  // fold the WAL back into the db file on exit so a copied gate.db is
  // self-contained for offline `daemonsudo verify`
  process.on("exit", () => {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      /* best effort */
    }
  });
  maybeSendTelemetryPing(db, config.telemetry);
  const pusher = config.mirror
    ? new MirrorPusher({ url: config.mirror.url, token: process.env[config.mirror.tokenEnv] })
    : undefined;
  const ledger = new Ledger(
    db,
    config.redact,
    makeSigner(loadOrCreateKeys(db)),
    config.gateHash,
    pusher && ((cp) => pusher.push(cp)),
  );
  const rules = new YamlGlobEngine(config.rules, config.defaults);
  const broker = new ApprovalBroker(db, config.timeoutMs);
  broker.recoverStalePending(); // adopt this db: close out a prior gate run's orphans
  const grantStore = new GrantStore(db);
  grantStore.expireStaleSessionGrants(BOOT_ID);
  const interceptor = new ToolGate(
    new DecisionCore(rules, ledger, broker, {
      store: grantStore,
      bootId: BOOT_ID,
      maxTtlMs: config.grantsMaxTtlMs,
    }),
  );

  const web = await startWeb(broker, ledger, config, undefined, grantStore);

  if (config.telegram) {
    const token = process.env[config.telegram.tokenEnv];
    if (!token) {
      console.error(
        `daemonsudo: telegram configured but ${config.telegram.tokenEnv} is not set — telegram channel disabled`,
      );
    } else if (config.telegram.allowedUsers.length === 0) {
      console.error("daemonsudo: telegram configured without allowed_users — telegram channel disabled");
    } else {
      new TelegramChannel({
        token,
        allowedUsers: config.telegram.allowedUsers,
        broker,
        webBaseUrl: web?.baseUrl,
      }).start();
    }
  }

  if (config.discord) {
    const dcToken = process.env[config.discord.tokenEnv];
    if (!dcToken) {
      console.error(
        `daemonsudo: discord configured but ${config.discord.tokenEnv} is not set — discord channel disabled`,
      );
    } else if (config.discord.allowedUsers.length === 0) {
      console.error("daemonsudo: discord configured without allowed_users — discord channel disabled");
    } else {
      new DiscordChannel({
        token: dcToken,
        allowedUsers: config.discord.allowedUsers,
        broker,
        webBaseUrl: web?.baseUrl,
      }).start();
    }
  }

  const proxy = new GateProxy({ command: cmd[0], args: cmd.slice(1), interceptor });
  await proxy.start();
  console.error(`daemonsudo: gating '${cmd.join(" ")}' (${config.rules.length} rules, defaults: ${config.defaults})`);
}

main().catch((e: unknown) => {
  console.error("daemonsudo: fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
