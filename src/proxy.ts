/**
 * MCP passthrough proxy + tools/call interception.
 *
 * The gate sits between an MCP client (stdin/stdout) and the real MCP server
 * (spawned child). Every message is relayed verbatim — the SDK transports
 * handle framing — except client→server `tools/call` requests, which are
 * handed to the interceptor when one is configured.
 */
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ulid } from "ulid";
import type { BlockOutcome, DecisionCore } from "./core.js";
import { canonicalJson, sha256, type Requester } from "./ledger.js";

export interface ToolCallRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: "tools/call";
  params: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: { progressToken?: string | number };
  };
}

export interface Interceptor {
  handleToolCall(msg: ToolCallRequest, proxy: GateProxy): Promise<void>;
  /** Client cancelled a request we may be holding. Return true to swallow the notification. */
  handleCancelled(requestId: string | number): boolean;
}

export interface GateProxyOptions {
  command: string;
  args: string[];
  interceptor?: Interceptor;
}

export class GateProxy {
  private child: StdioClientTransport;
  private parent: StdioServerTransport;
  private interceptor?: Interceptor;
  /** ids of client requests we forwarded ourselves and whose responses we want back */
  private held = new Map<string | number, (msg: JSONRPCMessage) => void>();
  private initializeId: string | number | undefined;
  /** downstream server identity, sniffed from the initialize response */
  serverName: string;
  /** client identity, sniffed from the initialize request's clientInfo */
  clientName: string | undefined;
  /** one id per gate run — correlates this run's receipts */
  readonly sessionId = ulid();

  constructor(opts: GateProxyOptions) {
    this.interceptor = opts.interceptor;
    this.serverName = [opts.command, ...opts.args].join(" ");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    this.child = new StdioClientTransport({
      command: opts.command,
      args: opts.args,
      env,
      stderr: "inherit",
    });
    this.parent = new StdioServerTransport();
  }

  async start(): Promise<void> {
    this.child.onmessage = (m) => this.onChildMessage(m);
    this.parent.onmessage = (m) => this.onClientMessage(m);
    this.child.onerror = (e) => console.error("daemonsudo: downstream error:", e.message);
    this.parent.onerror = (e) => console.error("daemonsudo: client transport error:", e.message);
    // Downstream died → we are useless; client hangup → take downstream with us.
    this.child.onclose = () => process.exit(0);
    this.parent.onclose = () => this.shutdown();
    process.stdin.once("end", () => this.shutdown());
    process.stdin.once("close", () => this.shutdown());
    process.once("SIGTERM", () => this.shutdown());
    process.once("SIGINT", () => this.shutdown());
    await this.child.start();
    await this.parent.start();
  }

  /** Exit deterministically even if closing the child hangs. */
  private shutdown(): void {
    void this.child.close().catch(() => {});
    setTimeout(() => process.exit(0), 300);
  }

  private onClientMessage(m: JSONRPCMessage): void {
    const msg = m as Record<string, unknown>;
    if (msg.method === "initialize" && msg.id !== undefined) {
      this.initializeId = msg.id as string | number;
      const info = (msg.params as { clientInfo?: { name?: string; version?: string } } | undefined)
        ?.clientInfo;
      if (info?.name) this.clientName = info.version ? `${info.name} ${info.version}` : info.name;
    }
    if (msg.method === "notifications/cancelled" && this.interceptor) {
      const requestId = (msg.params as { requestId?: string | number } | undefined)?.requestId;
      if (requestId !== undefined && this.interceptor.handleCancelled(requestId)) return;
    }
    if (msg.method === "tools/call" && msg.id !== undefined && this.interceptor) {
      const call = m as unknown as ToolCallRequest;
      void this.interceptor.handleToolCall(call, this).catch((err: unknown) => {
        // Fail closed: any error in the decision path blocks the call.
        const reason = err instanceof Error ? err.message : String(err);
        console.error("daemonsudo: interception error (failing closed):", reason);
        void this.respondToolError(call.id, `daemonsudo: call blocked (fail closed): ${reason}`);
      });
      return;
    }
    void this.child.send(m).catch((e: Error) => console.error("daemonsudo: forward to server failed:", e.message));
  }

  private onChildMessage(m: JSONRPCMessage): void {
    const msg = m as Record<string, unknown>;
    if (msg.id !== undefined && msg.method === undefined) {
      if (msg.id === this.initializeId) {
        const name = (msg.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo?.name;
        if (name) this.serverName = name;
      }
      const waiter = this.held.get(msg.id as string | number);
      if (waiter) {
        this.held.delete(msg.id as string | number);
        waiter(m);
        return;
      }
    }
    void this.parent.send(m).catch((e: Error) => console.error("daemonsudo: forward to client failed:", e.message));
  }

  /** Forward a (held) request to the downstream server and await its response. */
  forwardToChild(msg: ToolCallRequest): Promise<JSONRPCMessage> {
    return new Promise((resolve, reject) => {
      this.held.set(msg.id, resolve);
      this.child.send(msg as unknown as JSONRPCMessage).catch((e: Error) => {
        this.held.delete(msg.id);
        reject(e);
      });
    });
  }

  async sendToClient(msg: JSONRPCMessage): Promise<void> {
    await this.parent.send(msg);
  }

  /** Reply to the client with an in-band tool error (visible to the model, not a protocol error). */
  async respondToolError(id: string | number, text: string): Promise<void> {
    await this.parent.send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }], isError: true },
    } as unknown as JSONRPCMessage);
  }

  async sendProgress(token: string | number, progress: number, message: string): Promise<void> {
    await this.parent.send({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: token, progress, message },
    } as unknown as JSONRPCMessage);
  }
}

export const PROGRESS_INTERVAL_MS = 15_000;

/** Who is asking, for the receipt: client identity + session + call correlation id. */
export function requesterFor(msg: ToolCallRequest, proxy: GateProxy): Requester {
  return {
    ...(proxy.clientName ? { client: proxy.clientName } : {}),
    session: proxy.sessionId,
    call_id: String(msg.id),
  };
}

/** Progress heartbeat so clients with resetTimeoutOnProgress don't give up while a human decides. */
export function startHeartbeat(
  proxy: GateProxy,
  progressToken: string | number,
  tool: string,
): ReturnType<typeof setInterval> {
  let beats = 0;
  return setInterval(() => {
    void proxy
      .sendProgress(progressToken, ++beats, `daemonsudo: waiting for approval of '${tool}'`)
      .catch(() => {});
  }, PROGRESS_INTERVAL_MS);
}

/**
 * The decision flow for intercepted tools/call requests:
 * auto → forward + receipt · deny → block + receipt · approve → park with the
 * broker, hold the request open, then execute or block per the decision.
 */
export class ToolGate implements Interceptor {
  /** pending approval id → JSON-RPC request id of the parked call */
  private parked = new Map<string | number, string>();

  constructor(private core: DecisionCore) {}

  handleCancelled(requestId: string | number): boolean {
    const pendingId = this.parked.get(requestId);
    if (pendingId === undefined) return false;
    this.core.cancel(pendingId, "cancelled by client");
    return true; // we never forwarded the request, so swallow the cancellation
  }

  async handleToolCall(msg: ToolCallRequest, proxy: GateProxy): Promise<void> {
    const tool = msg.params.name;

    // Hold the MCP request open while parked.
    const progressToken = msg.params._meta?.progressToken;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    try {
      const outcome = await this.core.evaluate(
        {
          server: proxy.serverName,
          tool,
          args: msg.params.arguments ?? {},
          requester: requesterFor(msg, proxy),
          origin: "mcp",
        },
        {
          onParked: (parked) => {
            this.parked.set(msg.id, parked.id);
            if (progressToken !== undefined) heartbeat = startHeartbeat(proxy, progressToken, tool);
          },
        },
      );

      if (outcome.kind === "execute") {
        const response = (await proxy.forwardToChild(msg)) as {
          result?: { isError?: boolean };
          error?: unknown;
        };
        const failed = response.error !== undefined || response.result?.isError === true;
        outcome.recordResult({
          status: failed ? "error" : "ok",
          content_hash: sha256(canonicalJson(response.result ?? response.error ?? null)),
        });
        await proxy.sendToClient(response as unknown as JSONRPCMessage);
        return;
      }

      await proxy.respondToolError(msg.id, blockText(tool, outcome));
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.parked.delete(msg.id);
    }
  }
}

function blockText(tool: string, o: BlockOutcome): string {
  if (o.blockedBy === "rule") return `daemonsudo: '${tool}' denied by rule '${o.rule}'`;
  if (o.blockedBy === "no-broker") {
    return `daemonsudo: '${tool}' requires approval (rule '${o.rule}') but no approval channel is available — failing closed`;
  }
  const why =
    o.decision === "timeout"
      ? `approval timed out after ${Math.round(o.elapsedMs / 1000)}s`
      : `denied by ${o.approver?.user ?? "approver"} via ${o.approver?.channel ?? "channel"}${o.reason ? ` (${o.reason})` : ""}`;
  return `daemonsudo: '${tool}' not executed — ${why}`;
}
