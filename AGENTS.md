# Repository Guidelines

> Generated from `CLAUDE.md` and revised for Codex-compatible agent usage.
> This file should preserve repository workflow guidance, not Claude-only tooling instructions.

## Project Structure & Module Organization

Core TypeScript lives in `src/`. The CLI starts in `src/index.ts`; proxy, policy, approval, persistence, and receipt logic are split across focused modules. Channels and UI live in `src/channels/` and `src/web/`. Tests and YAML fixtures are under `test/`. Use `examples/` for configurations, `presets/` for curated rules, and `infra/` only for website infrastructure.

Read `../future-of-programming/GATE-PLAN.md` before non-trivial changes; it is the architectural source of truth. Treat its recorded stack and scope decisions as settled. If one blocks work, present the tradeoff instead of silently substituting.

## Build, Test, and Development Commands

- `bun install`: install dependencies from `bun.lock`.
- `bun run build`: compile strict TypeScript into `dist/`.
- `bun test`: run unit, integration, and end-to-end tests.
- `bun run dev`: run the gate against `examples/mock-server.mjs`.
- `node examples/demo.mjs`: exercise auto-approved and web-approved calls end to end.
- `node dist/index.js verify`: validate the receipt chain offline after building.

## Coding Style & Naming Conventions

Use two-space indentation, double quotes, semicolons, trailing commas, and ESM imports with `.js` extensions. Prefer explicit interfaces at subsystem boundaries. Use `camelCase` for values/functions, `PascalCase` for types/classes, and lowercase filenames. No formatter or linter is configured; match adjacent code and require `bun run build` to pass.

## Testing Guidelines

Tests use `bun:test` and follow `*.test.ts`; end-to-end cases use `*.e2e.test.ts`. Add focused unit coverage for rules and ledger behavior and proxy e2e coverage for protocol changes. Preserve the chaos invariant: killing the gate during approval must fail closed without downstream execution. Fixtures reserve ports 14909–14913.

## Security & Architecture Invariants

Approval and deny paths must fail closed. Preserve byte-faithful passthrough outside `tools/call`; use the official `@modelcontextprotocol/sdk` rather than hand-writing protocol logic. Never store or notify raw matched secrets, and render arguments as inert escaped, truncated text. Receipts remain append-only, hash-chained, Ed25519-signed, and offline-verifiable. Support Bun and Node 22.5+. Keep web pages server-rendered with Hono and Telegram long-polling. Do not add parked v0.1 features such as Docker, Postgres, Slack/Discord, Cedar, or hosted services.

## Commit & Pull Request Guidelines

Keep commits small and imperative, following existing subjects such as `stage 3: ...`, `docs: ...`, or `infra: ...`. Pull requests should explain behavior and security impact, link relevant issues, list verification commands, and include screenshots for web approval or receipt-view changes.
