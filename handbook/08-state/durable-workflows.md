# Durable workflows

> A durable workflow is a task that keeps its progress across crashes, restarts and reboots: completed steps, pending decisions and scheduled continuation. It never keeps authority. Every further attempt and every effect is authorized again under the policy in force at that moment.
> The coordinator is [loom](../03-components/loom.md). The shared contract is protocols §20.25–§20.27 ([protocols spec](../../specs/protocols/spec.md)); the coordinator's behaviour is in the [loom spec](../../specs/loom/spec.md).

![Durable workflow](../images/durable-workflow.svg)

## The invariant

> Workflow progress survives execution attempts. Authority is revalidated before every further effect, and persistence never resurrects revoked permissions or cancelled work.

Boot-scoped tokens stay boot-scoped. What survives a reboot is the record of what happened and what was decided, not the right to act on it.

## Progress versus authority

| Survives (durable) | Does not survive |
|---|---|
| The pinned definition, the enrollment's approved scope, recorded step results and observations, timers, signals | Tokens, root keys, sessions, fds, prompt IDs |
| The broker's workflow record: ownership epoch, label high-water mark, cancellation | Any attempt's authority |
| Durable decisions (`dr-…`) and their mandates | Boot-local approval prompts (`a-…`) |
| gate's durable effect records (`fx-…`) and the workflow budget account (`ba-…`) | Meter state tied to a dead root |

Enrollment is the only way work becomes durable. A paused, stopped or crashed agent session never becomes permission to run in the background, and guests cannot enroll.

## Steps, attempts and epochs

A definition (`keylos.workflow/1`) is an explicit versioned state machine; loom interprets it and contains no workflow code. Each step runs as one or more **attempts**:

1. loom commits a **claim** in its store: a new attempt `wa-…` and ownership epoch e + 1.
2. The broker accepts the claim only if e + 1 follows its own record, persists it, and revokes the roots of every earlier attempt.
3. The attempt is a fresh principal (a process spawned through warden, or an agent VM started by aide). At registration the broker restores the workflow label first, then mints fresh tokens from the approved scope after re-evaluating current policy. The attempt fetches them from the broker like any principal (`Broker.myGrants`); because the approved scope is the only source, a workflow must enroll an effect item for every effect kind its activities declare.

Every consumer rejects stale epochs: a worker that missed a cancellation can stay alive, but it can neither record a result nor touch an effect. Step and effect IDs are derived from the run, state and occurrence, so a retried step finds what its earlier attempts recorded. Model responses and tool results are recorded before use and replayed by key instead of asking the model again.

## Decisions that outlive a boot

An approval for a workflow is a **durable decision** in the broker, keyed by the workflow and the logical operation, never by the session. It is stored before any prompt is shown and decided before anyone is told, so a crash between the human's decision and the reply loses nothing. Prompts are re-presented after restarts, the expiry never moves, and a fresh attempt uses an approved decision only through an explicit, revalidated rebind.

## Effects and the four strategies

loom never executes effects. An activity prepares an effect at [gate](../03-components/gate.md) under its effect ID; loom later asks gate to commit it, and gate asks the broker for current authority each time. "Authorized" is never reported as "done"; the executor's confirmed outcome is.

| Strategy | When a reply is lost |
|---|---|
| Transactional | The executor's completion record says whether it happened |
| Downstream idempotency | Re-send with the same key, only inside the destination's verified window |
| Reconciliation | Query authoritative destination state; absence from an eventually consistent view proves nothing |
| No safe retry | The effect becomes **outcome unknown** |

An unknown outcome ends only by reconciliation or by the owner's resolution, and a resolution never repeats the effect. Dedup records are kept for the workflow's whole horizon.

## Cancel, forget, lock

- **Cancel** is durable in loom and in the broker, revokes every attempt root and refuses every later claim. If loom crashes after marking the workflow cancelling but before the broker recorded it, the workflow stays frozen until the broker record or the owner completes the cancellation; it never resumes. Already dispatched effects are not undone; their outcomes are still settled. Compensation is a new, authorized effect.
- **Forget** cancels, then shreds the history (vault `loom:` unit, gate payloads, retained prepared merges). Only ID-only tombstones remain, enough to stop the workflow being recreated.
- **Owner lock.** History keys are system-wrapped so outcomes can still be recorded, but a user's workflows pause while that user is locked unless they were enrolled with `runWhileLocked`, which needs presence.

## Rollback

Restoring an older loom store must not bring back cancelled work, reset budgets or repeat effects. loom anchors its store to the ledger: it remembers the sequence number of its newest acknowledged receipt and, after a restart, any newer loom receipt it does not know means its store is old. It then pauses everything for the owner's review and re-applies the authoritative records: cancellations from the ledger, epochs from the broker, effect outcomes and budgets from gate. The ledger's own TPM counter protects the anchor, so no new NV index is needed.

## Staging

| Phase | Stage | What it proves |
|---|---|---|
| B | S3 | Coordinator durability in the conformance harness with a documented gate test double: record a step, wait for a verified approval, tear down and relaunch with new sessions, commit an effect with a stable key, reconcile a lost reply, cancel without resurrection |
| C | S6 | Real gate outbox and adapters, supervisor restart and fencing, VM and machine reboot, the vault recovery dependency |
| D | S7 | The coding-agent workflow `edit → test → prepare exact merge → approval → commit → publish` as a loom workflow (the S7 exit test) |

## Related

- [loom](../03-components/loom.md)
- [Effects and the outbox](../07-agents/effects-and-outbox.md)
- [Snapshots and transactions](snapshots-and-transactions.md)
- [Crypto-shredding](crypto-shredding.md)
- [ADR-0068: Durable workflows in a separate coordinator](../11-decisions/adr-0068-durable-workflows-loom.md)
