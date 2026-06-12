#!/usr/bin/env node
// Mock MCP server used by the test suite and the demo. Plain JS so it runs
// under `node` with no build step. When MOCK_LOG is set, every *executed*
// tool call is appended there — the e2e tests use that file to prove that
// gated calls never reached this server.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync } from "node:fs";
import { z } from "zod";

const record = (line) => {
  if (process.env.MOCK_LOG) appendFileSync(process.env.MOCK_LOG, line + "\n");
};

const server = new McpServer({ name: "mock-things", version: "1.0.0" });

server.registerTool(
  "read_thing",
  { description: "Read a thing", inputSchema: { id: z.string() } },
  async ({ id }) => {
    record(`read_thing ${id}`);
    return { content: [{ type: "text", text: `thing ${id}: 42` }] };
  },
);

server.registerTool(
  "delete_thing",
  { description: "Delete a thing (destructive!)", inputSchema: { id: z.string() } },
  async ({ id }) => {
    record(`delete_thing ${id}`);
    return { content: [{ type: "text", text: `deleted thing ${id}` }] };
  },
);

server.registerTool(
  "send_thing",
  {
    description: "Send a thing somewhere",
    inputSchema: { id: z.string(), to: z.string(), password: z.string().optional() },
  },
  async ({ id, to }) => {
    record(`send_thing ${id} ${to}`);
    return { content: [{ type: "text", text: `sent thing ${id} to ${to}` }] };
  },
);

server.registerTool(
  "drop_things",
  { description: "Drop ALL the things", inputSchema: {} },
  async () => {
    record("drop_things");
    return { content: [{ type: "text", text: "dropped everything" }] };
  },
);

await server.connect(new StdioServerTransport());
