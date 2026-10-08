# ADR-0062: Directory grants have enforced label ceilings

> A directory grant carries an exposure label, its ceiling. The receiver is raised to the ceiling before exposure, and warden's BPF LSM refuses anything labelled above it for the grant's lifetime. A bounded scan can hide entries but never lower the label.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Security / labels | broker, warden, portals, bench, protocols |

## Context

- The broker sampled at most 2,000 entries or 50 ms of a directory and raised confidentiality on truncation, but not integrity. Reads through the attached directory were unmediated, so an omitted untrusted or secret file escaped the Rule of Two (ISSUES.md ISS-004).
- Even a complete initial scan is not a bound: higher-labelled files can be created, renamed in or relabelled after the grant.
- Labelling every live directory `secret/untrusted` would make agent policy (which denies `secret`) and app egress unusable.

## Decision

- Every directory grant has a ceiling *c*; the receiver is raised to *c* before exposure (protocols §14.1, E31).
- `GrantMounts.attachGrant` takes the ceiling. warden's BPF LSM refuses `open` of objects labelled above *c* or with a malformed label through that mount, and reads through fds opened via it. Unlabelled objects get their location default; without `bpf-init-inode-xattr`, unlabelled objects created after attach count as `secret/untrusted`. A grant without a ceiling means no enforcement, and the broker must then use `secret/untrusted`.
- The broker picks *c* as the join of a complete walk when it finishes within bounds; a truncated walk never goes below the location default, and entries above *c* are hidden.
- Grant trees are non-recursive bind mounts. Relabels, renames into the tree and retained handles are judged by the object's current label.
- Agent input should be immutable, completely assessed snapshots (bench shares, transaction bases).

## Alternatives considered

| Option | Why not |
|---|---|
| Bounded scan as the label | Not a bound; the bug |
| `secret/untrusted` for every live directory | Breaks agent and app workflows |
| Filesystem watcher updating the label | Eventually consistent; data is already read |
| Per-read broker mediation | Destroys performance of attached directories |

## Consequences

### Positive
- The label a session holds is a true upper bound of what it could read through its grants.
- Large directories don't need a full scan up front.

### Negative
- Higher-labelled entries become invisible through a grant until the holder accepts the higher label.
- Depends on the LSM hooks in warden and on label xattrs written at file creation.

### Follow-ups
- Tests: truncated walks, omitted secret or untrusted entries, files added after the grant, relabel and rename races, immutable views, interaction with existing effect and egress grants.

## Related

- [ADR-0026: Labels and the Rule of Two](adr-0026-labels-and-rule-of-two.md)
- [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md)
- [broker spec](../../specs/broker/spec.md) · [protocols §14.1](../../specs/protocols/spec.md#141-labels)
