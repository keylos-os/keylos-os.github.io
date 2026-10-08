# loom

> The durable workflow coordinator. loom keeps enrolled workflows' progress (steps, recorded observations, timers, signals, decisions pending) across crashes and reboots, and runs each step as a fresh attempt.
> It orchestrates only: it holds no workflow authority, and [broker](broker.md) and [gate](gate.md) authorize every attempt and every effect.

**Status:** specified (v1.0) · **Spec:** [`loom/spec.md`](../../specs/loom/spec.md)

## Responsibilities

- Enroll workflows from pinned `keylos.workflow/1` definitions after a broker enrollment decision, and keep their state in its own transactional, encrypted store.
- Claim every step with a new attempt and ownership epoch; spawn process attempts through [warden](warden.md) and agent attempts through [aide](aide.md).
- Record model and tool observations, results, timers and signals durably before acknowledging them, and replay recorded observations to later attempts.
- Commit prepared effects through gate's `DurableEffects` and settle their outcomes, including outcome unknown.
- Cancel and forget durably; pause a user's workflows while the user is locked unless enrolled `runWhileLocked`.
- Write `workflow.*` receipts through a durable receipt outbox, and detect a restored older store against the ledger.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Loom`, `Workflow`, `AttemptHost` (`loom.capnp`) | Facets `user`, `admin`, `attempt` |
| Provides | `LoomSystem` (`loom-sys`) | Facet `aide` |
| Consumes | `BrokerWorkflow` (broker, facet `workflow`) | Enrollment, claims, decisions, cancellation |
| Consumes | `DurableEffects`, `WorkflowBudget` (gate, facet `loom`) | Effects by effect ID, budget accounts |
| Consumes | `AgentWorkflowHost` (aide, facet `loom`) | Agent attempts |
| Consumes | vault (facet `loom`), ledger (`writer`), hearth (`system`: `userState`, `watchUsers`), depot (facet `loom`), warden (`service`) | Keys, receipts, lock state, definitions, attempt spawns |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| loom | `user` | human `shell`s, atrium | `Loom`, `Workflow` (own human's workflows; `enroll` with the caller as owner) |
| loom | `admin` | owner `shell` | `Loom`, `Workflow` for every human (read, `pause`, `cancel`, `forget`); loom-local admin (rollback review) |
| loom | `attempt` | attempt sessions spawned by loom (`SpawnSpec.attempt`) | `AttemptHost`, bound to the connecting attempt session |
| loom | `aide` | aide | `LoomSystem` (§7.5.25) for agent attempts aide started |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| `loom.capnp` | `0xc7a1e5d3b2f40038` | `Loom`, `Workflow`, `AttemptHost` |
| [`loom-sys.capnp`](../../specs/protocols/spec.md#7525-loom-syscapnp) | `0xc7a1e5d3b2f40039` | `DurableEffects`, `WorkflowBudget`, `BrokerWorkflow`, `AgentWorkflowHost`, `LoomSystem` |
<!-- /generated:sysif -->

## Runs as

A t0 service (`loomd`) with its own state directory and no network. It never uses warden's `FdStore` or `/run` for durable state.

## State

| Path | Content |
|---|---|
| `/var/lib/keylos/loom/loom.db` | Workflow store (SQLite WAL, `synchronous=FULL`) |
| `/var/lib/keylos/loom/blobs/` | Large encrypted results and checkpoints |


## Key decisions

- [ADR-0068: Durable workflows in a separate coordinator](../11-decisions/adr-0068-durable-workflows-loom.md)
- [ADR-0040: Per-boot token keys](../11-decisions/adr-0040-per-boot-token-keys.md)

## Limitations

- An effect whose destination offers neither verified idempotency nor authoritative reconciliation can end in outcome unknown, which the owner resolves.
- Power-loss safety of forgetting depends on vault's epoch rotation.

## Related

- [Durable workflows](../08-state/durable-workflows.md)
- [Effects and the outbox](../07-agents/effects-and-outbox.md)
