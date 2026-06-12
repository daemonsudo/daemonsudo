# Receipt crosswalk: daemonsudo/v1 ↔ ARP

[ARP (Agent Receipt Protocol)](https://agentreceipts.ai) is a draft standard for
records of *what an agent did*. daemonsudo records *whether a gate allowed it* —
ARP has no decision/approver/rule model at all, which is why daemonsudo keeps
its own flat schema (`schema: "daemonsudo/v1"`) instead of adopting ARP's
W3C VC envelope. The schemas align where they overlap; both canonicalize with
**RFC 8785 (JCS)** and prefix hashes with `sha256:`. A lossless
receipt → ARP-VC converter is a possible v2.

| daemonsudo/v1 | ARP (v0.5.0 draft) | notes |
|---|---|---|
| `schema` | `@context` / VC `type` | flat string vs JSON-LD envelope |
| `id` (ulid) | `id` (`urn:receipt:<uuid>`) | format gap only |
| `chain_id` | `chain.chain_id` | match |
| `seq` | `chain.sequence` | match; daemonsudo adds a signed head checkpoint for tail-truncation detection (ARP uses a `terminal` flag, which only covers graceful chain closure) |
| `prev_hash` | `chain.previous_receipt_hash` | match |
| `ts` | `action.timestamp` | rename |
| `server` | `action.target.system` | rename |
| `tool` | — | no equivalent |
| `args_hash` | `action.parameters_hash` | near-exact; both RFC 8785 + sha256 |
| `args_redacted` | `action.parameters_disclosure` | match |
| `decision` | — | **no equivalent** — ARP's `outcome.status` is only success/failure/pending; the gate verdict is daemonsudo's differentiator |
| `rule` | ~`authorization.scopes` | gap; daemonsudo pins the policy via `gate_hash` instead |
| `gate_hash` | — | sha256 of the gate.yaml in force; nearest peer is APS `policy_ref` |
| `requester` | ~VC `issuer` / agent identity | daemonsudo: MCP client identity + per-run session + JSON-RPC call id (per MCP discussions #269/#804) |
| `approver` | — | **no equivalent** |
| `result.status` | `outcome.status` | `ok` ↔ `success`, `error` ↔ `failure` |
| `result.content_hash` | `outcome.response_hash` | match |
| `kid` | `proof.verificationMethod` | daemonsudo: first 16 hex chars of sha256 over the raw ed25519 public key |
| `sig` | `proof` (Ed25519Signature2020) | same key type; flat `ed25519:<hex>` vs proof block |

Full analysis and sources: the June 13, 2026 standards review
(`GATE-PLAN.md` §5 in the planning repo).
