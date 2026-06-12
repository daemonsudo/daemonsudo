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
import type { ApprovalBroker } from "./broker.js";
import { canonicalJson, sha256, type Ledger } from "./ledger.js";
import type { RuleEngine } from "./rules.js";

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

const PROGRESS_INTERVAL_MS = 15_000;

/**
 * The decision flow for intercepted tools/call requests:
 * auto → forward + receipt · deny → block + receipt · approve → park with the
 * broker, hold the request open, then execute or block per the decision.
 */
export class ToolGate implements Interceptor {
  /** pending approval id → JSON-RPC request id of the parked call */
  private parked = new Map<string | number, string>();

  constructor(
    private rules: RuleEngine,
    private ledger: Ledger,
    private broker?: ApprovalBroker,
  ) {}

  handleCancelled(requestId: string | number): boolean {
    const pendingId = this.parked.get(requestId);
    if (pendingId === undefined || !this.broker) return false;
    this.broker.cancel(pendingId, "cancelled by client");
    return true; // we never forwarded the request, so swallow the cancellation
  }

  async handleToolCall(msg: ToolCallRequest, proxy: GateProxy): Promise<void> {
    const tool = msg.params.name;
    const args = msg.params.arguments ?? {};
    const match = this.rules.match(tool);

    if (match.action === "auto") {
      return this.execute(msg, proxy, "auto", match.rule);
    }

    if (match.action === "deny") {
      this.receipt(proxy, { tool, args, decision: "denied", rule: match.rule });
      await proxy.respondToolError(msg.id, `daemonsudo: '${tool}' denied by rule '${match.rule}'`);
      return;
    }

    // approve — fail closed when no broker can park the call
    if (!this.broker) {
      await proxy.respondToolError(
        msg.id,
        `daemonsudo: '${tool}' requires approval (rule '${match.rule}') but no approval channel is available — failing closed`,
      );
      this.receipt(proxy, { tool, args, decision: "denied", rule: match.rule });
      return;
    }

    const parkedAt = Date.now();
    const parked = this.broker.park({
      server: proxy.serverName,
      tool,
      args,
      rule: match.rule,
    });
    this.parked.set(msg.id, parked.id);

    // Hold the MCP request open; heartbeat progress so clients with
    // resetTimeoutOnProgress don't give up while a human decides.
    const progressToken = msg.params._meta?.progressToken;
    let beats = 0;
    const heartbeat = progressToken === undefined
      ? undefined
      : setInterval(() => {
          void proxy
            .sendProgress(progressToken, ++beats, `daemonsudo: waiting for approval of '${tool}'`)
            .catch(() => {});
        }, PROGRESS_INTERVAL_MS);

    try {
      const decision = await parked.decision;
      if (decision.status === "approved") {
        const approver = {
          channel: decision.channel ?? "unknown",
          user: decision.user ?? "unknown",
          latency_ms: Date.now() - parkedAt,
        };
        return await this.execute(msg, proxy, "approved", match.rule, approver);
      }
      const why =
        decision.status === "timeout"
          ? `approval timed out after ${Math.round((Date.now() - parkedAt) / 1000)}s`
          : `denied by ${decision.user ?? "approver"} via ${decision.channel ?? "channel"}${decision.reason ? ` (${decision.reason})` : ""}`;
      this.receipt(proxy, {
        tool,
        args,
        decision: decision.status === "timeout" ? "timeout" : "denied",
        rule: match.rule,
        approver:
          decision.status === "denied" && decision.channel
            ? { channel: decision.channel, user: decision.user ?? "unknown", latency_ms: Date.now() - parkedAt }
            : undefined,
      });
      await proxy.respondToolError(msg.id, `daemonsudo: '${tool}' not executed — ${why}`);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.parked.delete(msg.id);
    }
  }

  /** Forward to the downstream server, relay the response, write the receipt. */
  private async execute(
    msg: ToolCallRequest,
    proxy: GateProxy,
    decision: "auto" | "approved",
    rule: string,
    approver?: { channel: string; user: string; latency_ms: number },
  ): Promise<void> {
    const tool = msg.params.name;
    const args = msg.params.arguments ?? {};
    const response = (await proxy.forwardToChild(msg)) as {
      result?: { isError?: boolean };
      error?: unknown;
    };
    const failed = response.error !== undefined || response.result?.isError === true;
    try {
      this.ledger.append({
        server: proxy.serverName,
        tool,
        args,
        decision,
        rule,
        approver,
        result: {
          status: failed ? "error" : "ok",
          content_hash: sha256(canonicalJson(response.result ?? response.error ?? null)),
        },
      });
    } catch (e) {
      // The call already executed; a receipt failure here is logged loudly but
      // must not turn a true result into a lie.
      console.error("daemonsudo: receipt write failed:", e instanceof Error ? e.message : e);
    }
    await proxy.sendToClient(response as unknown as JSONRPCMessage);
  }

  private receipt(
    proxy: GateProxy,
    input: {
      tool: string;
      args: unknown;
      decision: "denied" | "timeout";
      rule: string;
      approver?: { channel: string; user: string; latency_ms: number };
    },
  ): void {
    try {
      this.ledger.append({ server: proxy.serverName, ...input });
    } catch (e) {
      console.error("daemonsudo: receipt write failed:", e instanceof Error ? e.message : e);
    }
  }
}
