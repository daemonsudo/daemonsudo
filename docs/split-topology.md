# Split topology: agent in a container, gate on the host

In the default (local) topology the agent and the gate share one account —
the agent can read `serve.token` and the signing keys, so the gate is a
tripwire it could walk around. Split topology moves policy, keys, and the
ledger to a host daemon. A containerized agent can only *ask*.

```
┌───────────── container ─────────────┐        ┌────────────── host ──────────────┐
│ agent (Claude Code / MCP client)    │        │ daemonsudo serve                  │
│   hooks / remote proxy ──────────── ┼──────► │   gate listener 172.17.0.1:4911   │
│   DAEMONSUDO_BASE_URL + _TOKEN      │        │   (token-authed /gate/* + /health)│
└─────────────────────────────────────┘        │   operator UI 127.0.0.1:4910      │
                                               │   gate.yaml · keys · gate.db      │
                                               └───────────────────────────────────┘
```

## Host: run the daemon with a gate listener

`gate.yaml` on the host:

```yaml
gate:
  listen: { host: 172.17.0.1, port: 4911 }   # docker bridge — /health + /gate/* ONLY
channels:
  web:    { host: 127.0.0.1, port: 4910 }    # operator UI stays loopback
```

Then `daemonsudo serve`. The gate listener serves only `/health` (tokenless,
for liveness probes) and the token-authed `/gate/*` API. Operator pages
(`/approve`, `/receipts`, `/pending`, `/grants`) never appear on it — the
topology is the boundary, not a flag. If the configured listener cannot
bind, the daemon exits FATAL rather than silently falling back to loopback.

**Firewall the gate listener to the bridge** (it is token-authed, but
defense in depth is cheap):

```bash
iptables -A INPUT -p tcp --dport 4911 ! -i docker0 -j DROP
```

## Container: point the client at the host

```yaml
# docker-compose.yml
services:
  agent:
    environment:
      DAEMONSUDO_BASE_URL: "http://host.docker.internal:4911"
      DAEMONSUDO_TOKEN: "${DAEMONSUDO_TOKEN}"      # direct value beats DAEMONSUDO_TOKEN_PATH
    extra_hosts:
      - "host.docker.internal:host-gateway"        # required on Linux
```

Prefer a mounted secret? Mount the token file and set
`DAEMONSUDO_TOKEN_PATH=/run/secrets/daemonsudo-token` instead —
`DAEMONSUDO_TOKEN` (direct value) takes precedence when both are set.

- **Claude Code door:** the hooks POST `/gate/approve` / `/gate/receipt` to
  `DAEMONSUDO_BASE_URL`. Daemon unreachable → the hook fails closed (deny)
  unless `DAEMONSUDO_HOOK_FAIL_OPEN=1`.
- **MCP door:** run the in-container proxy in remote-broker mode with
  `DAEMONSUDO_REMOTE_URL=http://host.docker.internal:4911` (or `remote.url`
  in the container's gate.yaml). The proxy keeps no policy, keys, or ledger;
  the daemon evaluates rules→grants→park and writes every receipt. Daemon
  unreachable → **everything fails closed, `auto` included** — remote
  unreceipted execution would violate every-call-leaves-a-receipt.

## Honest limits

In split topology the *decision* is the boundary. The daemon cannot verify
the args or result the proxy reports for an executed call — a compromised
container could lie in its result report. That report is tripwire-grade
evidence, not proof. What the split does guarantee: matched calls cannot
execute without a host-side decision, and the keys/ledger never live where
the agent runs.

Operator CLI (`grants`, `grant`, `revoke`, `verify`, `mirror`) is
host-side by construction — run it next to the daemon, not in the
container. (Hermit installs: the `Bash(*sudo *)` deny pattern blocks the
whole CLI from agent context anyway.)
