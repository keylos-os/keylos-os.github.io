# ADR-0061: Agent merges commit an immutable prepared result under a writer fence

> An approval binds a prepared merge: an immutable object holding the exact result of conflict resolution and automatic merging against a captured live state. Commit applies only that object, after warden has frozen every other writer and strata has revalidated the live state.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | State / agents | strata, bench, aide, gate, warden, protocols |

## Context

- strata froze a transaction, computed the change-set digest and checked the mandate, and only then handled conflicts. A clean three-way merge could still change the committed content after the digest was approved (ISSUES.md ISS-003).
- bench's merge manifest and strata's internal change-set digest were two different digest meanings for one approval.
- A strata mutex or a momentary lease test does not stop an application writing live files between validation and application.

## Decision

- `TransactionExt.prepare` freezes the views, captures the live state of every affected path, applies recorded resolutions and clean three-way merges, and stores an immutable prepared merge `pm-…` (protocols §7.5.7, E30).
- One shared manifest, `keylos.fsmerge/2` (§20.12), lists each change with its expected live state and resulting digest. Its digest is the `fs.merge` payload digest, the diff shown on the trusted path comes from the same object, and `BenchMerge.manifest`/`commitShare` wrap it. `keylos.fsmerge/1` and `commitWithMandate` are superseded.
- `PreparedMerge.commit(mandate)` verifies the digest, takes a writer fence, revalidates every expected live state, and applies exactly the stored operations: no new merge, no read of a newer agent overlay. Stale state returns `kl:conflict`; a changed result needs a new prepare and a new approval.
- **Writer fence:** `PrincipalControl.fenceWriters` makes warden freeze every session whose view can write inside the target. A writer that can't be frozen (a tier-0 service other than strata, a kernel or network filesystem writer) makes the fence fail with `kl:conflict`. The fence is released explicitly, when the capability is dropped, or after 30 s; if it ends before the commit journal reaches `applied`, strata rolls back.

## Alternatives considered

| Option | Why not |
|---|---|
| Merge at commit time, then compare digests | The approved content still isn't the committed content when a merge runs |
| Revalidate without exclusion | Leaves a race between validation and apply |
| Lock files with leases | Advisory; not every writer holds an fd at check time |
| Refuse every commit when live files changed | Breaks normal parallel work on a project |

## Consequences

### Positive
- What the human approved is byte for byte what is committed.
- Late agent writes stay in the overlay and need their own review.

### Negative
- Writers of the target are briefly frozen during commit.
- Targets with non-freezable writers can't take agent merges until a finer mechanism exists.

### Follow-ups
- Integration tests for live edits after review, late agent writes, racing writers, replayed mandates and interrupted commits.

## Related

- [Snapshots and transactions](../08-state/snapshots-and-transactions.md)
- [ADR-0029: Agents propose, humans sign](adr-0029-agents-propose-humans-sign.md)
- [ADR-0027: Effect outbox and mandates](adr-0027-effect-outbox-and-mandates.md)
- [strata spec](../../specs/strata/spec.md) · [protocols §20.12](../../specs/protocols/spec.md#2012-merge-manifest-keylosfsmerge2)
