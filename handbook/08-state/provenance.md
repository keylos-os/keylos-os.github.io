# Provenance

> Every file created on keylos records who created it: which principal (user, app, service or agent session), from which generation, inside which transaction, and when. `why <file>` answers "where did this come from?" and "can I delete this?".
> keylos records **creation only**, never full read/write lineage, because whole-system provenance costs too much and loses too much. Specified (v1.0).

## What is recorded

`security.bpf.keylos.prov` is a small CBOR record written at creation:

| Field | Example |
|---|---|
| `p` principal | `agent:gen:fsv256:9e1f…@alice/s-01JB6Q…` |
| `g` generation | `gen:fsv256:9e1f…` (the app, service or agent template) |
| `x` transaction | `x-01JB7…` or empty |
| `t` time | Nanoseconds since the Unix epoch |

```
$ why ~/src/app/migrations/0042.sql
  created  2026-10-07 21:34:12 by agent "coder" (template gen:fsv256:9e1f…) for alice
  session  s-01JB6Q… — task: "add index for orders"
  in       transaction x-01JB7… committed 21:41 (approved by alice, mandate a-01JB7…)
  label    private / untrusted
```

## How it works

| Mode | When | Mechanism | Latency |
|---|---|---|---|
| Kernel | The running kernel exports the `bpf_init_inode_xattr` kfunc | A BPF LSM program on `inode_init_security` writes the xattr as part of creating the inode, with the creator's identity taken from its cgroup | Atomic with creation, ≈2 µs |
| Fallback | Otherwise (today's kernels) | The BPF program records (device, inode, generation, cgroup) into a ring buffer. `strata-provd` joins these with fanotify creation events and writes the xattr through a file handle | p99 ≤ 1 s |

Identity always comes from kernel state: the cgroup of the creating task, mapped to a principal by `warden` at spawn time. A process cannot claim to be someone else, and `security.*` xattrs need a capability no principal has.

## What it is used for

| Use | How |
|---|---|
| `why` in the shell | Shows creator, transaction and approval |
| Uninstalling an app cleanly | Finds stray files created by that app outside its data directories |
| Reviewing agent work | Every file an agent created is attributable to its session and the approval that merged it |
| Incident response | "Which files did this compromised app create in the last week?" |
| Labels | Files created by sessions reading untrusted input inherit an `untrusted` integrity label |

## Why not full provenance

| Approach | Cost reported in the literature | Problem |
|---|---|---|
| Whole-system provenance (every read and write) | 13–55 % overhead, > 90 % log loss under load | Too slow, incomplete exactly when it matters |
| Audit subsystem | Heavy, lossy | Same |
| Creation-time only (keylos) | ≈ 2–10 µs per create | Doesn't answer "where did these bytes come from"; does answer "who made this file" |

## Limitations

- Copying a file with a tool that drops `security.*` xattrs, or moving it off the machine, loses provenance.
- In fallback mode, files created and deleted within the join window are never attributed; the count is in metrics.
- Above about 10,000 creates per second, the fallback daemon samples file creations (directories are always recorded) and marks the rest as unattributed.
- Modifications are not recorded per file. Transactions and receipts cover modifications made through `try`, agents and merges.

## Related

- [Snapshots and transactions](snapshots-and-transactions.md)
- [Filesystem layout](filesystem-layout.md)
- [strata specification §4.9](../../specs/strata/spec.md)
- [ADR-0033: creation-time provenance](../11-decisions/adr-0033-creation-time-provenance.md)
- [ADR-0031: receipts ledger](../11-decisions/adr-0031-receipts-ledger.md)
