# ADR-0033: Creation-time provenance only

> When a file is created, a BPF LSM hook records who created it (principal, session, generation, transaction, time) in `security.bpf.keylos.prov`. keylos does not try whole-system read and write flow tracking.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | State | strata, kish, aide, ledger |

## Context

- "Who created this file?" answers uninstall sweeps, agent attribution and cleanup questions cheaply.
- Whole-system provenance is expensive and lossy. A 2026 study measured CamFlow at 45% file and 55% network overhead with 95–96% log loss, and SPADE with 91–99% loss (https://arxiv.org/pdf/2608.11418). PASS and LPM became unmaintainable (https://arxiv.org/pdf/2107.01678).
- fanotify events are asynchronous (short-lived creators can't be attributed). A BPF LSM hook runs synchronously in the creating task. A kfunc to set xattrs at inode init was proposed in July 2026.

## Decision

- A BPF LSM program on inode creation writes `security.bpf.keylos.prov` (CBOR `{p, g, x, t}`) using the inode-init xattr kfunc when it is available, and a fanotify-driven userspace fallback otherwise, which may miss the shortest-lived creators.
- The `security.` namespace stops same-UID forgery.
- `Strata.why(fd)` and `kish why` combine provenance with ledger receipts.
- No byte-level lineage claims.

## Alternatives considered

| Option | Why not |
|---|---|
| Whole-system provenance (CamFlow, SPADE) | Overhead and loss |
| auditd | Heavy and lossy |
| User-space xattrs | Forgeable |

## Consequences

### Positive
- Cheap attribution for every file at its creation.

### Negative
- xattrs are lost by many copy tools and sync protocols. Provenance is best-effort outside keylos-native flows.

## Related

- [Provenance](../08-state/provenance.md)
- [strata](../03-components/strata.md)
