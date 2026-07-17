/**
 * Remote-broker mode: the in-container proxy is a dumb forwarder. The host
 * daemon owns gate.yaml, rules, grants, keys, and the ledger; this side
 * holds no policy and writes no receipts. Daemon unreachable → EVERYTHING
 * fails closed, `auto` included — remote unreceipted execution would
 * violate every-call-leaves-a-receipt.
 */
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { canonicalJson, sha256 } from "./ledger.js";
import {
  requesterFor,
  startHeartbeat,
  type GateProxy,
  type Interceptor,
  type ToolCallRequest,
} from "./proxy.js";

interface RemoteDecision {
  decision: "allow" | "deny";
  call_ref?: string;
  mode?: "auto" | "approved" | "grant";
  grant_id?: string;
  status?: "denied" | "timeout";
  reason?: string;
}

export class RemoteToolGate implements Interceptor {
  /** JSON-RPC request id → abort for the in-flight decision fetch */
  private inflight = new Map<string | number, AbortController>();

  constructor(private opts: { url: string; token?: string }) {}

  handleCancelled(requestId: string | number): boolean {
    const ac = this.inflight.get(requestId);
    if (!ac) return false;
    ac.abort(); // daemon sees the socket drop and cancels the pending row
    return true;
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.token) headers["x-daemonsudo-token"] = this.opts.token;
    return fetch(`${this.opts.url}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  }

  async handleToolCall(msg: ToolCallRequest, proxy: GateProxy): Promise<void> {
    const tool = msg.params.name;
    const ac = new AbortController();
    this.inflight.set(msg.id, ac);

    // Heartbeat immediately — this side can't tell "deciding" from "parked".
    const progressToken = msg.params._meta?.progressToken;
    const heartbeat =
      progressToken === undefined ? undefined : startHeartbeat(proxy, progressToken, tool);

    try {
      // Any transport/HTTP/parse error below throws → GateProxy's catch
      // responds with an in-band fail-closed error.
      const res = await this.post(
        "/gate/mcp/call",
        {
          server: proxy.serverName,
          tool,
          args: msg.params.arguments ?? {},
          requester: requesterFor(msg, proxy),
        },
        ac.signal,
      );
      if (!res.ok) throw new Error(`daemon replied ${res.status}`);
      const decision = (await res.json()) as RemoteDecision;

      if (decision.decision === "deny") {
        const why =
          decision.status === "timeout"
            ? "approval timed out"
            : `denied${decision.reason ? ` (${decision.reason})` : ""}`;
        await proxy.respondToolError(msg.id, `daemonsudo: '${tool}' not executed — ${why}`);
        return;
      }
      if (decision.decision !== "allow" || !decision.call_ref) {
        throw new Error("malformed daemon response");
      }

      const response = (await proxy.forwardToChild(msg)) as {
        result?: { isError?: boolean };
        error?: unknown;
      };
      const failed = response.error !== undefined || response.result?.isError === true;
      try {
        await this.post("/gate/mcp/result", {
          call_ref: decision.call_ref,
          status: failed ? "error" : "ok",
          content_hash: sha256(canonicalJson(response.result ?? response.error ?? null)),
        });
      } catch (e) {
        // The call already executed; a lost result report must not turn a
        // true result into a client-visible lie. The daemon's stash sweeper
        // will still write the receipt (without result) and log loudly.
        console.error(
          "daemonsudo: result report failed:",
          e instanceof Error ? e.message : e,
        );
      }
      await proxy.sendToClient(response as unknown as JSONRPCMessage);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.inflight.delete(msg.id);
    }
  }
}
