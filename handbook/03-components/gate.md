# gate

> The effect broker. All network egress from sandboxed principals and every effect that changes the outside world pass through gate.
> It proxies connections with host and method policy, injects credentials without revealing them, labels responses, stages effects as intents in an outbox, refuses to commit irreversible intents without a matching mandate, and meters budgets with hard stops.

**Status:** specified (v1.0) · **Spec:** [`gate/spec.md`](../../specs/gate/spec.md)

![Effect outbox](../images/effect-outbox.svg)

## Responsibilities

- **Egress proxy:**
  - `Gate.connect` returns a connected socket after checking the token's `net(...)` facts;
  - checks TLS SNI and Host match, and the HTTP method allowlist;
  - only gate's own stack resolves DNS;
  - every connection is labelled (`untrusted` responses unless the host is marked `user`/`trusted`).
- **Credential injection:** uses `Vault.inject` handles. Agents hold a handle, never the secret.
- **Effect outbox:**
  - `stage` turns an `EffectIntent` into an `Intent` (states `staged → approved → committed`, or `failed`, `canceled`, `compensated`);
  - provides `dryRun` renderings;
  - commits idempotently by idempotency key;
  - runs compensators where they are registered.
- **Mandates:** an irreversible intent commits only with a `keylos.mandate/1` whose `effects[].digest` equals the payload digest.
- **Metering:** `charge` and `meter` keep budgets per token root ID (`usd-micro`, `tokens`, `calls`). Exhaustion is a hard stop (`kl:budget`).
- **Rule of Two:** in cooperation with [broker](broker.md), egress that would complete untrusted + private + external requires declassification.
- **Classification:** an effect's kind and class come from protocols §14.2 plus policy (`x-` kinds). Classes can be raised, never lowered.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Gate` (`gate.capnp`) | `connect`, `stage`, `intents`, `meter`, `charge` (metering facet) |
| Provides | `Intent` | `status`, `dryRun`, `commit`, `cancel`, `compensate` |
| Consumes | `Broker` | Token checks, labels, approvals |
| Consumes | `Vault.inject` (gate facet) | Credential handles |
| Consumes | `Net.resolve` | DNS |
| Consumes | `Ledger.append` (writer) | receipts |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| gate | `client` | principals with net needs, portal-files, atrium (staging `media.export`) | `connect`, `stage` (own session), `intents` (own session tree, recursive), `intent` (own session tree), `meter` (own roots); `DurableEffects.prepare`, `complete`, `lookup`, `watch` (attempt sessions, own workflow) |
| gate | `broker` | broker | `connect` and `stage` for the token holder; `GateMeterAdmin`; `WorkflowBudget.open`, `close`, `status` |
| gate | `shim` | per-principal endpoints created by warden (tier L) and bench (bench-net per VM) | `ShimEndpoint` |
| gate | `meter` | aide, configured model clients | `charge`, `meter` |
| gate | `aide` | aide | `connect`, `stage` for agent sessions (§7.3.7), `intents`, `meter`; `DurableEffects.prepare`, `complete`, `lookup`, `watch` and `WorkflowBudget.reserve`, `settle`, `release`, `status` for agent attempt sessions |
| gate | `admin` | owner `shell`, atrium | `intents`, `meter` (any session) |
| gate | `debug` | warden, atrium, owner `shell` | `GateDebug` |
| gate | `loom` | loom | `DurableEffects` (all except `prepare`), `WorkflowBudget` (`reserve`, `settle`, `release`, `status`) (§7.5.25) |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`gate-sys.capnp`](../../specs/protocols/spec.md#7512-gate-syscapnp) | `0xc7a1e5d3b2f4002b` | `ShimEndpoint`, `GateDebug`, `GateMeterAdmin` |
| [`loom-sys.capnp`](../../specs/protocols/spec.md#7525-loom-syscapnp) | `0xc7a1e5d3b2f40039` | `DurableEffects`, `WorkflowBudget`, `BrokerWorkflow`, `AgentWorkflowHost`, `LoomSystem` |
<!-- /generated:sysif -->

## Runs as

A t0 service, the only principal with a route to the external network besides [net](net.md) itself. Uses the rustls stack, TLS 1.2+ to third parties.

## State

| Path | Content |
|---|---|
| `/var/lib/gate/outbox/` | Intents, payloads (encrypted with a crypto-shred unit per session), mandates |
| `/var/lib/gate/meter/` | Budget counters per root ID (per boot plus persistent grants) |


## Key decisions

- [ADR-0027: Effect outbox and mandates](../11-decisions/adr-0027-effect-outbox-and-mandates.md)
- [ADR-0026: Labels and the Rule of Two](../11-decisions/adr-0026-labels-and-rule-of-two.md)
- [ADR-0039: Secrets never in env](../11-decisions/adr-0039-secrets-never-in-env.md)

## Related

- [Effects and outbox](../07-agents/effects-and-outbox.md)
- [Budgets](../07-agents/budgets.md)
- [Network egress](../06-security/network-egress.md)
