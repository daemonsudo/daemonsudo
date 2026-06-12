# daemonsudo

**sudo for AI agents** — approval gates + signed receipts for MCP tool calls. Wrap any MCP server in one line; risky tool calls pause for a human "yes" (Telegram/web), every executed call leaves a signed, hash-chained receipt.

## Source of truth

The complete spec lives at `../future-of-programming/GATE-PLAN.md` — product behavior, architecture, stack, config format, receipt schema, security rules, repo layout (§7), and the week-by-week build order (§8). **Read it before any non-trivial work.**

Decisions there are settled (each records its reason). Do not relitigate stack or scope choices in passing — if one genuinely blocks you, stop and present the tradeoff instead of silently substituting.

## Hard invariants (never trade away)

1. **Fail closed.** If the gate crashes, the DB is unavailable, or state is ambiguous, calls matching `approve`/`deny` rules must NOT reach the downstream server. Only `auto` passthrough may degrade gracefully.
2. **Transparent proxy.** All MCP traffic except `tools/call` passes through byte-faithfully. A client must behave identically with the gate inserted — this is the standing e2e test.
3. **No secrets in the ledger or in notifications.** Receipt args pass redaction globs before storage; full args are hashed, never stored raw when matched.
4. **Render tool args as inert text.** Approval cards (web + Telegram) must escape/truncate everything — args are untrusted input and a prompt-injection vector.
5. **Receipts are append-only, hash-chained, ed25519-signed.** `daemonsudo verify` must always be able to validate the chain offline.

## Stack (locked — reasons in GATE-PLAN §4)

TypeScript; must run on **Node ≥20 AND Bun**. Official `@modelcontextprotocol/sdk` for all protocol work (write zero protocol code). SQLite (single file) for pending approvals + receipts. `@noble/ed25519` for signing. Hono for the server-rendered web pages (no React, no build step). Telegram via Bot API **long-polling** (no webhook/public URL). Packaged for `npx daemonsudo -- <cmd>`; bin exposes both `daemonsudo` and `dsudo`.

v0.1 cut list is binding (GATE-PLAN §4): no Cedar, no Slack/Discord, no Postgres, no Docker, no hosted anything, no dry-run/undo/analytics yet.

## Conventions

- MIT license. Small, focused commits.
- Test-first where cheap (rules engine, ledger); e2e for the proxy against the in-repo mock MCP server (`test/`). Chaos test: kill the gate mid-approval → call must fail closed, no orphan execution.
- Check current MCP SDK docs before protocol work — the spec moved in 2026 (new transport, Tasks extension with `input_required`).
- **One-shot build, ordered stages.** GATE-PLAN §8's "weeks" are build stages, not calendar: (1) transparent proxy → (2) rules + auto/deny + unsigned receipts → (3) approval broker + web page → (4) signing + chain + `verify` → (5) Telegram + redaction + receipts viewer → (6) README/examples/polish. Each stage's exit test must pass before the next stage starts — but don't stop for human review between stages; deliver the whole v0.1 and demo at the end.

## Commands

```bash
bun install && bun run build   # tsc → dist/
bun test                       # unit + e2e against examples/mock-server.mjs (incl. chaos fail-closed test)
bun run dev                    # gate against the mock server (bun src/index.ts)
node examples/demo.mjs         # end-to-end demo: auto call + web-approved delete
node dist/index.js verify      # walk the receipt chain offline (also: receipts; --db <path>)
```

Test fixtures pin web ports 14909–14913 to avoid clashes. Tests set `DAEMONSUDO_DB` to temp dirs; the real db lives at `~/.gate/gate.db` (WAL — checkpointed on gate exit so the single file stays self-contained).

## Ecosystem facts the docs assume

- npm `daemonsudo@0.0.1` placeholder is already published (account: `gtapps`) — the real package versions over it. The standalone `dsudo` npm name is blocked (typosquat rule); `dsudo` ships as a bin alias only.
- GitHub home: `github.com/daemonsudo/daemonsudo`. Domains: daemonsudo.dev (primary), daemonsudo.com (redirect).
- README voice (week 4): speak sudo's language — `gate.yaml` is *the sudoers file for your agents*; the receipt ledger is *auth.log, but signed*.
