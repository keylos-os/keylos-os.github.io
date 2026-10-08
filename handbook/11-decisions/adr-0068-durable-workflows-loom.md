# ADR-0068: Durable workflows in a separate coordinator, loom

> Durable execution is a small, separate service that keeps workflow progress and never authority. Every attempt gets fresh, boot-scoped authority from the broker's workflow record, and every effect is authorized again by broker and gate.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Agents / state / authority | protocols, loom, broker, gate, aide, warden, strata, bench, vault, ledger, hearth |

## Context

- Agent tasks and other long work must survive service crashes and reboots: completed steps, pending approvals and scheduled continuation ([durable execution proposal](../publication-notes.md)).
- Tokens and root keys are per boot ([ADR-0040](adr-0040-per-boot-token-keys.md)); broker request deduplication lasts 24 h in `/run`; gate payload retention and session-keyed ownership do not cover long waits.
- A retry after a lost reply can repeat an external effect; `Committed` for caller-executed effects meant "authorized", not "done".
- Restoring an older store could bring back cancelled work or reset budgets.

## Decision

- A new repository and t0 service, **loom**, owns a transactional, encrypted workflow store and a built-in engine for explicit versioned state machines (`keylos.workflow/1`) with an SDK. Contracts are backend-independent (protocols §20.25–§20.27, `loom.capnp`, `loom-sys.capnp`).
- loom holds no workflow authority. Each step is a claim with a new attempt and ownership epoch; the broker accepts the claim, revokes earlier attempts, restores the workflow label and mints fresh tokens from the approved scope under current policy.
- Approvals are durable decisions keyed by the logical operation; prompts stay boot-local.
- Effects are durable records in gate keyed by derived effect IDs, with one declared retry strategy (transactional, downstream idempotency, reconciliation, no safe retry), an explicit outcome-unknown state, and authorization separate from completion.
- Budgets are workflow-lifetime accounts with idempotent reserve, settle and release.
- Locked owners pause their workflows unless enrolled `runWhileLocked` with presence; key wrapping does not decide execution.
- Rollback of the loom, broker-workflow and gate-effect stores is detected against the ledger, which the TPM counter `0x01300100` already protects.

## Alternatives considered

| Option | Why not |
|---|---|
| A library hosted by aide | Ties durability to agents, and the S3 proof would imply aide exists; other workflows need it too |
| Adopt an external durable runtime as the engine | Its semantics do not give encrypted, forgettable history, local-only operation, keylos authority boundaries or effect reconciliation; kept as an informative adapter option |
| Persist tokens or extend their lifetime | Breaks "tokens never outlive a boot" and makes revocation and reboot healing weaker |
| A new TPM NV index for loom's rollback counter | NV wear and provisioning cost; the ledger checkpoint counter already anchors receipts |
| Retry effects on recovery by default | Repeats irreversible actions when the destination does not deduplicate |

## Consequences

### Positive
- Long-running and agent work survives restarts without standing authority.
- Cancelled or forgotten work cannot come back through recovery or an old backup.
- Unknown outcomes are visible instead of silently retried.

### Negative
- A new service, new facets and new broker and gate state to implement and test.
- Some effects end in outcome unknown and need the owner.

### Follow-ups
- S3 Phase B durability proof with a gate test double; S6 Phase C real gate and reboot tests; S7 coding-agent workflow as a loom workflow.
- Implementation items in `.dev/stages/S2-followups.md` ("Durable execution (S3 Phase B)").

## Related

- [Durable workflows](../08-state/durable-workflows.md)
- [ADR-0027: Effect outbox and mandates](adr-0027-effect-outbox-and-mandates.md)
- [ADR-0061: Prepared merges and the writer fence](adr-0061-prepared-merges-and-writer-fence.md)
