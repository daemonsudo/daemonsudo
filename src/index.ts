#!/usr/bin/env node
/**
 * daemonsudo — sudo for AI agents.
 *
 *   daemonsudo [--config gate.yaml] -- <command> [args...]   run the gate
 *   daemonsudo verify [--db path]                            verify the receipt chain
 *   daemonsudo receipts [--db path]                          print recent receipts
 */
import { ApprovalBroker } from "./broker.js";
import { defaultDbPath, loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { Ledger } from "./ledger.js";
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

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
  const ledger = new Ledger(db, config.redact);
  const rules = new YamlGlobEngine(config.rules, config.defaults);
  const broker = new ApprovalBroker(db, config.timeoutMs);
  const interceptor = new ToolGate(rules, ledger, broker);

  await startWeb(broker, ledger, config);

  const proxy = new GateProxy({ command: cmd[0], args: cmd.slice(1), interceptor });
  await proxy.start();
  console.error(`daemonsudo: gating '${cmd.join(" ")}' (${config.rules.length} rules, defaults: ${config.defaults})`);
}

main().catch((e: unknown) => {
  console.error("daemonsudo: fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
