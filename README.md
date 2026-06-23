# daemonsudo

**sudo for AI agents.** Approval gates + signed receipts for MCP tool calls.

Today your agent has your keys — it deletes rows, sends emails, and drops tables the instant a model decides to. daemonsudo makes it **knock first**: wrap any MCP server in one line of config, and risky tool calls pause for a human *yes* on your phone or browser, while every executed call leaves a signed, hash-chained receipt.

- `gate.yaml` is **the sudoers file for your agents**
- the receipt ledger is **auth.log, but signed**
- approval is the password prompt — except it's your phone

No accounts, no cloud, no code changes, no public URL. MIT.

## 60-second install

Two commands to gated. First, write a curated ruleset for your server:

```bash
npx daemonsudo init --preset github   # or: postgres | stripe | filesystem | browser
# plain `npx daemonsudo init` writes the safe-by-default skeleton
```

Each preset is a plain, commented gate.yaml (they live in [`presets/`](presets/)) — reads pass through, writes knock, the destructive tier is denied outright. Edit it like any config file.

Then prepend daemonsudo to that MCP server's command in your client config (Claude Desktop / Claude Code / Cursor / anything MCP):

```jsonc
// before                                   // after
"db": {                                     "db": {
  "command": "npx",                           "command": "npx",
  "args": ["some-db-mcp"]                     "args": ["daemonsudo", "--config", "/abs/path/gate.yaml",
}                                                      "--", "npx", "some-db-mcp"]
                                            }
```

The gate spawns the real server as a child process and proxies its stdio. Everything except `tools/call` passes through untouched — your client can't tell the gate is there until a risky call knocks.

## The sudoers file

```yaml
# gate.yaml
defaults: approve            # unknown tools must knock (safe-by-default)
timeout: 10m                 # nobody answers → deny

rules:                       # glob on tool name → auto | approve | deny
  read_*: auto               # boring calls pass through (and get receipts)
  list_*: auto
  delete_*: approve          # destructive calls wait for a human
  send_*: approve
  drop_*: deny               # some things nobody should approve

redact:                      # these never land raw in receipts or cards
  - "*.password"
  - "*.api_key"

channels:
  telegram:
    token_env: GATE_TELEGRAM_TOKEN   # env var NAME — the token never lives in config
    allowed_users: [123456789]       # the only Telegram IDs that can approve
  web:
    port: 4910                       # localhost approval + receipts pages
```

Most-specific glob wins, then file order. A JSON schema ships in the package (`gate.schema.json`) for editor autocomplete.

## What an approval looks like

When a call matches `approve`, the agent's request is held open and the gate prints a capability link (and pings Telegram if configured):

```
daemonsudo: approval needed → http://127.0.0.1:4910/approve/01JX…?t=9f2c…
```

The card shows the tool, the server, the rule that fired, and the args — escaped, truncated, never interpreted (args are attacker-controlled input; the card treats them that way). Approve and the call executes; deny — or let it time out — and the agent gets a clean in-band tool error it can read and react to.

Telegram setup: make a bot with [@BotFather](https://t.me/botfather), put the token in `GATE_TELEGRAM_TOKEN`, message your bot once, and put your user ID in `allowed_users`. Long-polling — works behind NAT, no webhook, no public URL.

## auth.log, but signed

Every executed *and* refused call appends a receipt (`schema: "daemonsudo/v1"`): what ran, who asked (`requester` — MCP client, session, call id), who approved (and how slowly), which policy was in force (`gate_hash` — sha256 of your gate.yaml), and what came back. Receipts are [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON, SHA-256 hash-chained (`chain_id` + monotonic `seq`), and ed25519-signed with a key generated on first run — each receipt names its key by fingerprint (`kid`), so verification survives key rotation.

```bash
daemonsudo receipts          # recent ledger, newest last
daemonsudo verify            # walk the chain offline
# ✓ 1240 receipts verified — hash chain intact, head checkpoint matches, all signatures valid
```

Edit one byte of history — flip a `denied` to `approved`, delete a row — and `verify` names the exact receipt that breaks. Deleting the *newest* receipts doesn't break `prev_hash`, so every append also rewrites a signed head checkpoint; chop the tail and `verify` reports the truncation. Secrets matched by `redact` globs never enter the ledger raw; the full args are stored only as a hash, so you can still attest *what* was authorized without storing *it*.

How the fields map to the draft [Agent Receipt Protocol](https://agentreceipts.ai): [docs/crosswalk.md](docs/crosswalk.md).

Browse it at `http://127.0.0.1:4910/receipts`.

## Security model

- **Fail closed.** Gate crash, dead DB, ambiguous state — calls matching `approve`/`deny` do not reach the server. Pendings orphaned by a crash are closed out on restart, never executed. Only `auto` passthrough may degrade gracefully.
- **Untrusted args.** Approval cards render args as inert, escaped, truncated text — web and Telegram both. Prompt injection in tool args has nowhere to go.
- **Capability auth.** Web approvals require the per-call token from the link; Telegram callbacks carry a one-time nonce and are accepted only from `allowed_users`. The web server binds to localhost by default.
- **No secrets in the ledger or notifications** — see `redact` above.

## Requirements

- **Bun ≥ 1.1** or **Node ≥ 24** (the gate stores state in SQLite via `bun:sqlite` / `node:sqlite` — one file, `~/.gate/gate.db`, zero ops; override with `DAEMONSUDO_DB`)
- `dsudo` ships as a second name for the same CLI

## Try it without wiring up a real server

```bash
git clone https://github.com/daemonsudo/daemonsudo && cd daemonsudo
bun install && bun run build
node examples/demo.mjs       # read_thing passes; delete_thing knocks — go approve it
```

## Development

```bash
bun install
bun test          # unit + e2e against the in-repo mock MCP server, incl. the
                  # chaos test (SIGKILL mid-approval → nothing executes)
bun run build     # tsc → dist/
```

## Telemetry (opt-in, off by default)

daemonsudo phones home only if you put `telemetry: true` in your gate.yaml. At most once a week it POSTs exactly this to `https://daemonsudo.dev/ping`:

```json
{ "version": "0.1.0", "anon_id": "<random hex generated locally on first ping>" }
```

That is the entire payload — nothing about your tools, rules, args, or traffic, ever. If the endpoint is unreachable the ping is dropped silently; telemetry runs fire-and-forget and can never affect gating.

## v0.1 scope

Approvals (web + Telegram), rules + presets, redaction, signed receipts, `verify`. Deliberately **not** here yet: dry-run previews, undo contracts, Cedar policies, Slack/Discord, Postgres, Docker, hosted anything. The local single-user flow is free forever.

## Roadmap

Demand-driven — 👍 an issue to vote it up:

- [Slack & Discord approval channels](https://github.com/daemonsudo/daemonsudo/issues/1)
- [Claude Code PreToolUse hook adapter](https://github.com/daemonsudo/daemonsudo/issues/2) — gate native Bash/Edit/Write tools, not just MCP
- [More rule presets — which servers?](https://github.com/daemonsudo/daemonsudo/issues/3)

---

daemonsudo is not affiliated with or endorsed by the sudo project or Anonyome Labs' Sudo Platform.

MIT © daemonsudo contributors
