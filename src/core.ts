/**
 * DecisionCore — the shared rules→park→receipt orchestration behind every
 * door: ToolGate (local MCP), /gate/approve (Claude Code), and the remote
 * broker endpoint. Doors own transport (holding requests open, error texts);
 * the core owns decisions and terminal receipts. A blocked call's terminal
 * receipt is written here exactly once; an executed call's receipt is written
 * by the door via the outcome's recordResult closure, once the result exists.
 */
import type { ApprovalBroker, Origin, ParkedCall } from "./broker.js";
import type { Approver, Ledger, Requester } from "./ledger.js";
import type { RuleEngine } from "./rules.js";

export type { Origin };

export interface CoreCall {
  server: string;
  tool: string;
  args: unknown;
  requester?: Requester;
  origin: Origin;
}

export interface ExecuteOutcome {
  kind: "execute";
  decision: "auto" | "approved";
  rule: string;
  approver?: Approver;
  /** Write the execution receipt — call once, after the downstream result. */
  recordResult(result: { status: "ok" | "error"; content_hash: string }): void;
}

export interface BlockOutcome {
  kind: "block";
  decision: "denied" | "timeout";
  rule: string;
  /** why a denied call was blocked; timeout carries no blockedBy */
  blockedBy?: "rule" | "no-broker" | "approver";
  /** raw decider identity, for the door's error text */
  approver?: { channel?: string; user?: string };
  reason?: string;
  elapsedMs: number;
}

export type CoreOutcome = ExecuteOutcome | BlockOutcome;

export class DecisionCore {
  constructor(
    private rules: RuleEngine,
    private ledger: Ledger,
    private broker?: ApprovalBroker,
  ) {}

  async evaluate(
    call: CoreCall,
    opts: { onParked?: (parked: ParkedCall) => void } = {},
  ): Promise<CoreOutcome> {
    const match = this.rules.match(call.tool);

    if (match.action === "auto") {
      return this.executeOutcome(call, "auto", match.rule);
    }

    if (match.action === "deny") {
      this.terminalReceipt(call, "denied", match.rule);
      return { kind: "block", decision: "denied", rule: match.rule, blockedBy: "rule", elapsedMs: 0 };
    }

    // approve — fail closed when no broker can park the call
    if (!this.broker) {
      this.terminalReceipt(call, "denied", match.rule);
      return { kind: "block", decision: "denied", rule: match.rule, blockedBy: "no-broker", elapsedMs: 0 };
    }

    const parkedAt = Date.now();
    const parked = this.broker.park({
      server: call.server,
      tool: call.tool,
      args: call.args,
      rule: match.rule,
      origin: call.origin,
    });
    opts.onParked?.(parked);
    const decision = await parked.decision;
    const elapsedMs = Date.now() - parkedAt;

    if (decision.status === "approved") {
      return this.executeOutcome(call, "approved", match.rule, {
        channel: decision.channel ?? "unknown",
        user: decision.user ?? "unknown",
        latency_ms: elapsedMs,
      });
    }

    const terminal = decision.status === "timeout" ? "timeout" : "denied";
    this.terminalReceipt(
      call,
      terminal,
      match.rule,
      terminal === "denied" && decision.channel
        ? { channel: decision.channel, user: decision.user ?? "unknown", latency_ms: elapsedMs }
        : undefined,
    );
    return {
      kind: "block",
      decision: terminal,
      rule: match.rule,
      blockedBy: terminal === "denied" ? "approver" : undefined,
      approver: { channel: decision.channel, user: decision.user },
      reason: decision.reason,
      elapsedMs,
    };
  }

  /** Park without running rules — the CC door already decided "ask". */
  parkOnly(input: { server: string; tool: string; args: unknown; rule: string; origin: Origin }): ParkedCall {
    if (!this.broker) throw new Error("no approval broker available");
    return this.broker.park(input);
  }

  cancel(pendingId: string, reason: string): void {
    this.broker?.cancel(pendingId, reason);
  }

  private executeOutcome(
    call: CoreCall,
    decision: "auto" | "approved",
    rule: string,
    approver?: Approver,
  ): ExecuteOutcome {
    return {
      kind: "execute",
      decision,
      rule,
      approver,
      recordResult: (result) => {
        try {
          this.ledger.append({
            server: call.server,
            tool: call.tool,
            args: call.args,
            requester: call.requester,
            decision,
            rule,
            approver,
            result,
          });
        } catch (e) {
          // The call already executed; a receipt failure here is logged loudly
          // but must not turn a true result into a lie.
          console.error("daemonsudo: receipt write failed:", e instanceof Error ? e.message : e);
        }
      },
    };
  }

  terminalReceipt(
    call: CoreCall,
    decision: "denied" | "timeout",
    rule: string,
    approver?: Approver,
  ): void {
    try {
      this.ledger.append({
        server: call.server,
        tool: call.tool,
        args: call.args,
        requester: call.requester,
        decision,
        rule,
        approver,
      });
    } catch (e) {
      console.error("daemonsudo: receipt write failed:", e instanceof Error ? e.message : e);
    }
  }
}
