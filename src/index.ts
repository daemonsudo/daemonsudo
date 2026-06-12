#!/usr/bin/env node
/**
 * daemonsudo — sudo for AI agents.
 *
 *   daemonsudo [--config gate.yaml] -- <command> [args...]   run the gate
 *   daemonsudo verify [--db path]                            verify the receipt chain
 *   daemonsudo receipts [--db path]                          print recent receipts
 */
import { ApprovalBroker } from "./broker.js";
import { TelegramChannel } from "./channels/telegram.js";
import { defaultDbPath, loadConfig } from "./config.js";
import { openDb, type Db } from "./db.js";
import {
  Ledger,
  loadOrCreateKeys,
  makeSigner,
  makeVerifier,
  verifyChain,
  type Receipt,
} from "./ledger.js";
import { GateProxy, ToolGate } from "./proxy.js";
import { YamlGlobEngine } from "./rules.js";
import { startWeb } from "./web/index.js";

function usage(): never {
  console.error(
    "usage: daemonsudo [--config gate.yaml] -- <command> [args...]\n" +
      "       daemonsudo verify [--db path]\n" +
      "       daemonsudo receipts [--db path]",
  );
  process.exit(2);
}

function dbPathFromFlags(args: string[]): string {
  const i = args.indexOf("--db");
  return i !== -1 && args[i + 1] ? args[i + 1] : defaultDbPath();
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
  if (result.ok) {
    console.log(
      `✓ ${result.count} receipts verified — hash chain intact, head checkpoint matches, all signatures valid`,
    );
    for (const k of keys) console.log(`  key ${k.kid}: ed25519:${k.public_hex}`);
    process.exit(0);
  }
  const where = result.badSeq === undefined ? "" : ` at receipt #${result.badSeq}`;
  console.error(`✗ chain INVALID${where}: ${result.error}`);
  console.error(`  (${result.count} receipts total)`);
  process.exit(1);
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "verify") return cmdVerify(argv.slice(1));
  if (argv[0] === "receipts") return cmdReceipts(argv.slice(1));

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
  const ledger = new Ledger(db, config.redact, makeSigner(loadOrCreateKeys(db)), config.gateHash);
  const rules = new YamlGlobEngine(config.rules, config.defaults);
  const broker = new ApprovalBroker(db, config.timeoutMs);
  const interceptor = new ToolGate(rules, ledger, broker);

  const web = await startWeb(broker, ledger, config);

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

  const proxy = new GateProxy({ command: cmd[0], args: cmd.slice(1), interceptor });
  await proxy.start();
  console.error(`daemonsudo: gating '${cmd.join(" ")}' (${config.rules.length} rules, defaults: ${config.defaults})`);
}

main().catch((e: unknown) => {
  console.error("daemonsudo: fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
