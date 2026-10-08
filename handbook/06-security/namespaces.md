# Namespaces

> In keylos, namespaces are views, not boundaries. They decide what a process can see and name. Landlock, seccomp, the BPF LSM and VMs decide what it can do.
> Only `warden` creates namespaces (one bounded exception: `net` creates network namespaces for Kubernetes nodes), and native code never runs inside a user namespace. That closes most of the kernel attack surface that makes containers risky.

**Status:** specified (v1.0). Owned by [warden](../../specs/warden/spec.md).

## The user-namespace problem

A user namespace makes its creator "root" inside it and hands out capabilities such as `CAP_SYS_ADMIN` and `CAP_NET_ADMIN` there. Those capabilities unlock kernel code an ordinary process cannot reach: netfilter (nf_tables), filesystem mounting, and more. In Google's kernelCTF programme, about 44% of submitted exploits needed unprivileged user namespaces. Distribution-level restrictions (AppArmor gates) have been bypassed repeatedly.

keylos avoids the problem rather than gating it:

1. `warden` is already privileged, so it creates mount, PID, IPC, UTS, cgroup and network namespaces **directly**, without a user namespace. The process gets the isolation and no capabilities.
2. seccomp denies `unshare`, `setns` and the namespace flags of `clone` to every process. `clone3` returns `ENOSYS` so libc falls back to `clone`, whose flags are checked.
3. User namespaces exist only for the **legacy tier**, where old software expects a full UID range. `warden` creates them and writes `user.max_user_namespaces=0` inside, so they cannot nest.
4. Inside workbench VMs, anything goes (Docker, nested containers), because the guest kernel is the boundary.
5. **One exception, on `server-k8s` only:** `net` creates the cri network namespace (bridge `kl-cri0`) at its start and one network namespace per `keylos-sealed` pod (`clusterUplink` op `podNetns`). They are network namespaces only; `warden` still starts every process and joins it into them ([ADR-0025 addendum](../11-decisions/adr-0025-namespaces-only-by-warden.md#addendum-round-3-the-cri-network-namespace), [Kubernetes nodes](../10-operations/kubernetes.md)).

## Namespace by namespace

| Namespace | keylos use | Notes |
|---|---|---|
| Mount | **Per-process view**: the generation at `/`, the app's data, the grants, nothing else. Built from detached trees with `fsopen`, `fsmount`, `open_tree` and `move_mount` | Propagation private; no `/sys` for apps; live generation swaps use `MOVE_MOUNT_BENEATH` |
| PID | Hides other processes; the process is PID 1 of its namespace | Cross-namespace handles are pidfds |
| Network | Native apps: only `lo`, with connected sockets from `gate`. Legacy: `pasta` forwarding to `gate`. Pooled, because creation is slow | Also isolates abstract unix sockets; gives host-level egress filtering that Landlock alone cannot |
| IPC | Isolates SysV shared memory, semaphores, message queues, POSIX mqueues | Landlock cannot restrict these |
| UTS | Per-process hostname (the generation name) | — |
| cgroup | Hides the cgroup hierarchy | Resource limits come from cgroup v2 controllers |
| Time | Not used for host processes; used inside workbenches when restoring snapshots | — |
| User | Legacy tier only; also used by `warden` as a **mapping description** for idmapped mounts (no process ever enters these) | Nesting disabled |

## Idmapped mounts: files stay owned by the human

Processes run under dynamic UIDs, but a human's files on disk belong to the human's UID. `warden` presents data directories through **idmapped mounts** that map the human UID to the principal's dynamic UID:
- files the app creates appear on disk as owned by the human;
- one app instance cannot read another instance's data unless it was granted;
- snapshots and backups see stable ownership.

The user namespace used for the mapping is held by `warden` only.

## Pitfalls handled

| Pitfall | Handling |
|---|---|
| Inherited `/proc` leaks environment and command lines | Fresh procfs per PID namespace with `hidepid=invisible,subset=pid` |
| Mount propagation leaking mounts between views | Everything is private; views are built from detached trees |
| Joining another namespace through `/proc/<pid>/ns` or a pidfd | `setns` denied by seccomp |
| Abstract unix sockets (X11, ssh-agent) shared across sandboxes | Private network namespaces plus Landlock scoping |
| Namespaces do not reduce kernel attack surface | seccomp allowlist does |
| Namespaces do not limit resources | cgroup v2 limits per principal |

## Limitations

- Network namespace creation and teardown are slow (tens of milliseconds), so `warden` keeps a pool.
- The legacy tier's user namespace re-exposes some kernel code paths inside that namespace. Its seccomp profile still denies mount and namespace syscalls, and internet-sourced legacy images run in t2 instead.

## Related

- [Confinement tiers](confinement-tiers.md)
- [Process tree and tiers](../02-architecture/process-tree-and-tiers.md)
- [warden spec](../../specs/warden/spec.md) §4.4 (child setup), §4.7 (mount views), §4.10 (legacy)
- [ADR-0025 Namespaces only by warden](../11-decisions/adr-0025-namespaces-only-by-warden.md), [ADR-0037 Legacy tier with FHS views](../11-decisions/adr-0037-legacy-tier-fhs-views.md)
