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
    this.parent.onclose = () => {
      void this.child.close().finally(() => process.exit(0));
    };
    await this.child.start();
    await this.parent.start();
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
