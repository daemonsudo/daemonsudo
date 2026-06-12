#!/usr/bin/env node
// 90-second demo: an MCP client talking to the mock server *through the gate*.
//
//   node examples/demo.mjs [gate command...]
//
// Default gate command:
//   node dist/index.js --config examples/gate.yaml -- node examples/mock-server.mjs
//
// read_thing passes instantly (auto rule); delete_thing pauses until you
// approve it in the browser (the gate prints the approval link below).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const gate =
  process.argv.length > 2
    ? process.argv.slice(2)
    : ["node", "dist/index.js", "--config", "examples/gate.yaml", "--", "node", "examples/mock-server.mjs"];

console.log(`agent → ${gate.join(" ")}\n`);

const transport = new StdioClientTransport({
  command: gate[0],
  args: gate.slice(1),
  env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stdout.write(`  [gate] ${chunk}`));

const client = new Client({ name: "demo-agent", version: "0.1.0" });
await client.connect(transport);

console.log("1) agent calls read_thing — matches `read_*: auto`, passes straight through:");
const read = await client.callTool({ name: "read_thing", arguments: { id: "customer-42" } });
console.log(`   → ${read.content[0].text}\n`);

console.log("2) agent calls delete_thing — matches `delete_*: approve`. The agent now KNOCKS:");
const t0 = Date.now();
const del = await client.callTool(
  { name: "delete_thing", arguments: { id: "customer-42" } },
  undefined,
  { timeout: 15 * 60_000, resetTimeoutOnProgress: true, onprogress: () => {} },
);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`   → ${del.content[0].text}  (${del.isError ? "BLOCKED" : "approved"} after ${secs}s)\n`);

console.log("3) every decision left a signed receipt — check the chain:");
console.log("   npx daemonsudo verify   ·   receipts page: http://127.0.0.1:4910/receipts\n");

await client.close();
