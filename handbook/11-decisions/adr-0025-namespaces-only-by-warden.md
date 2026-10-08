# ADR-0025: Only warden creates namespaces; user namespaces only for legacy

> warden is privileged, so it creates mount, pid, ipc, uts, cgroup and network namespaces directly, without a user namespace. Sandboxed processes get isolation with no capabilities inside it. seccomp denies `unshare`, `setns` and namespace flags everywhere. User namespaces exist only for the legacy tier, with nesting disabled.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Security | warden, compat, bench, keylos |

## Context

- A user namespace grants `CAP_SYS_ADMIN` and `CAP_NET_ADMIN` inside it, which unlocks kernel code such as nf_tables and filesystem mounting. Google's kCTF found about 44% of submitted exploits needed unprivileged user namespaces (https://security.googleblog.com/2023/06/learnings-from-kctf-vrps-42-linux.html). nf_tables bugs reachable only through userns keep appearing (for example CVE-2026-23111).
- Ubuntu's AppArmor gate on unprivileged userns was bypassed several times (https://blog.qualys.com/vulnerabilities-threat-research/2025/03/27/qualys-tru-discovers-three-bypasses-of-ubuntu-unprivileged-user-namespace-restrictions).
- Namespaces are views, not boundaries. The boundary is Landlock, seccomp, LSMs and VMs.

## Decision

- Only warden creates namespaces. Native tiers use no user namespace.
- seccomp baseline denies `unshare`, `setns`, and `CLONE_NEW*` on `clone`/`clone3` (clone3 → `ENOSYS`).
- The legacy tier gets a warden-built user namespace with 65536-UID blocks and child `user.max_user_namespaces=0` (hierarchical, so no nesting).
- Network namespaces carry host-level egress control (only `lo` plus broker sockets, or `pasta` to gate for legacy). A pool hides creation cost.
- Inside workbench VMs, namespaces and containers are unrestricted, because the guest kernel is the boundary.

## Alternatives considered

| Option | Why not |
|---|---|
| Unprivileged userns for sandboxes (bwrap style) | Exposes the kernel code most exploits need |
| Global `user.max_user_namespaces=0` | Also blocks the legacy tier's needs |
| AppArmor-gated userns | Bypassed repeatedly |

## Consequences

### Positive
- Removes the largest exploit-enabling kernel surface from all native sandboxes.

### Negative
- Sandboxed apps can't use containers on the host. They use workbenches.

## Addendum (round 3): the cri network namespace

On the `server-k8s` profile, `net` creates **network namespaces** for Kubernetes: the cri network namespace with the bridge `kl-cri0` at its own start, and one pod network namespace per `keylos-sealed` pod through `NetPlumbingCluster.clusterUplink` op `podNetns` (protocols §9.1, §21.5). This is the single exception to the decision above.

- **Why `net`, not `warden`.** Pod networking needs veth pairs, bridge ports, routes and NAT that `net` already owns on the host side; `warden` stays out of network configuration. `cri` itself cannot create namespaces (§9.1 baseline).
- **Bounds.** Network namespaces only, never user, mount or PID namespaces; only on `server-k8s`; only for the cri network and its pods. `warden` still starts every process, and joins `crid`, `kubelet` and `kube-proxy` into the cri namespace (`services.json` `network: "cluster"`, from `NetPlumbingCluster.clusterNetns`) and sealed containers into their pod namespace (`PodContext.netns`).
- **Capabilities.** `CAP_NET_ADMIN` is effective only inside the cri namespace for `crid` and `kube-proxy`; pods hold no capabilities.

## Related

- [Namespaces](../06-security/namespaces.md)
- [Confinement tiers](../06-security/confinement-tiers.md)
- [warden](../03-components/warden.md)
