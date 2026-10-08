# ADR-0069: Contract fixes from the execution-core implementation

> Implementing warden, kl-exec, journal and loom exposed contract gaps. File labels move to the `security.bpf.` xattr namespace so a BPF LSM can enforce grant ceilings, the kl-exec contract gains its missing hooks, numbers and link hand-over, and warden stays subject to kl-exec's ptrace rule and supervises through pidfds.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Contracts / integrity | protocols, warden, boot, journal, loom, broker, strata, gate, keylos |

## Context

- Grant ceilings need a BPF LSM (`kl-label`) that reads each file's label. The kernel lets BPF programs read xattrs only through kfuncs that accept `user.*` and `security.bpf.*` names, so `security.keylos.label` was unreadable and warden could not enforce non-null ceilings (warden SPEC-NOTES W1). Provenance (`security.keylos.prov`), stamped by a BPF LSM at file creation, had the same problem.
- A check-only `execveat(…, AT_EXECVE_CHECK)` never reaches `bprm_check_security`, `perf_event_open` cannot see an event's target, LSM attachments die with their last link fd, and the event and policy numbers were unpinned, so warden and journal could not decode them reliably (boot SPEC-NOTES S3-1…S3-5).
- `kl-exec`'s `ptrace_access_check` also guards `/proc/<pid>/ns/*`, `/proc/<pid>/maps`, `pidfd_getfd` and namespace access through pidfds. Under the strict reading warden could not open its own children's namespace files, and journal's core-dump helper could not read `/proc/<pid>/maps` (boot S3-6, warden W5).
- loom pinned definitions by the hash of the file, while the conformance vector hashed a re-serialized definition with defaults filled in (loom S3-1).

## Decision

- **Label xattrs** (protocols §10.4, §14.1, E53): `security.bpf.keylos.label` and `security.bpf.keylos.prov`. Setting any `security.*` name still needs `CAP_SYS_ADMIN` in the filesystem's user namespace, which no principal holds; no keylos program attaches `inode_xattr_skipcap`. Checked on the dev VM: an unprivileged file owner gets `EPERM` for `security.bpf.*`, whereas `user.*` would be writable and is therefore not used.
- **kl-exec contract** (§9.3, E54–E60): a `bprm_creds_for_exec` row for check-only execs; `perf_event_open` admits paired tasks and `perf_event_alloc` checks the target; fixed phase values, hook IDs, event fields and the kernel `dev_t` encoding; links created with `BPF_LINK_CREATE` and passed as fds 9–18 (`keylos.execlinkfds=`), held by warden; offsets from BTF at load, with BTF and the arm64 ftrace options required in the kernel configuration.
- **No ptrace exemption** (§9.3, E58): no task is exempt, the warden core included. Components supervise through pidfds, `PIDFD_GET_INFO`, `/proc/<pid>/{cgroup,status}` and namespace fds each child sends at spawn. The core-dump helper takes file mappings from the core's `NT_FILE` note.
- **Durable execution** (§20.25–§20.27, E64–E67): the definition digest is the SHA-256 of the shipped canonical bytes; attempts fetch their tokens with `Broker.myGrants` and the enrollment scope must cover every declared effect kind; loom observes pending effect decisions by re-issuing `commit`, and a denied decision ends the effect `cancelled` with a reason.

## Alternatives considered

| Option | Why not |
|---|---|
| `user.keylos.label` | Any file owner can write `user.*` xattrs, so a principal could relabel its own files downwards |
| Keep `security.keylos.label` and enforce ceilings in a FUSE layer | Adds a userspace hop to every read of every grant; FUSE is reserved for single-file views |
| Exempt `warden_tgid` from `ptrace_access_check` | A compromise of the most privileged userspace process would also gain every other task's memory; pidfds and spawn-time fds already cover what warden needs |
| Hash the re-serialized definition | A client cannot reproduce the digest without the validator's defaults, and a validator change would change every pinned digest |

## Consequences

### Positive
- Grant ceilings can be enforced in the kernel, so non-null ceilings become possible.
- warden, journal and tools decode `kl_exec_events` the same way, and `kl-exec` stays attached for warden's whole life.
- A compromised warden gains no ptrace-equivalent access through the exemption that was not granted.

### Negative
- Writers and readers of labels (broker now; strata, bench, aide, compat later) must use the new names.
- The core-dump helper must parse mappings from the core instead of `/proc`.
- Workflows must list their effect kinds in the enrollment scope.

### Follow-ups
- Implement `kl-label` and non-null ceilings in warden, rename the label xattr in broker, drop `/proc/%P/maps` from the core-dump helper ([S3 follow-ups](../publication-notes.md)).

## Related

- [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md)
- [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md)
- [Durable workflows](../08-state/durable-workflows.md)
- [ADR-0062: Directory label ceilings](adr-0062-directory-label-ceilings.md)
- [ADR-0068: Durable workflows in loom](adr-0068-durable-workflows-loom.md)
- [protocols §9.3](../../specs/protocols/spec.md#93-code-integrity-host)
