# ADR-0047: Kubernetes pods run in microVMs by default, through a keylos CRI

> keylos runs upstream `kubelet` and `kube-proxy` as confined services and implements the container runtime interface itself in a new repository, `cri`. The default runtime class `keylos-vm` runs every pod in its own `bench` microVM. The `keylos-sealed` class runs signed `container` generations as ordinary tier-1 principals. The kubelet never holds root, and every pod is admitted by Cedar policy.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Execution / servers | cri, bench, warden, broker, depot, strata, net, fleet, devd, pkgs, keylos, protocols |

## Context

- A node agent such as kubelet expects to be root. It mounts volumes, programs networking through CNI plugins, writes cgroups and runs arbitrary images through runc. Each of these contradicts a keylos invariant:
  - the host runs only sealed code (I1);
  - nothing holds ambient authority (I2);
  - only `warden` creates namespaces ([ADR-0025](adr-0025-namespaces-only-by-warden.md)).
- Container images are unsealed code by definition. Running them on the host kernel under runc would make every image a potential host compromise. Shared-kernel container escapes are a recurring class: CVEs in runc, overlayfs and netfilter reachable from containers. About 44% of kernelCTF exploits relied on unprivileged user namespaces, which container runtimes typically enable ([Google kCTF](https://security.googleblog.com/2023/06/learnings-from-kctf-vrps-42-linux.html)).
- Pod-per-VM runtimes are proven in production: Kata Containers and firecracker-containerd. Their overhead, tens of MB and around 150 ms per pod, is acceptable for most server workloads.
- Some organisations need container density and speed for images they build and sign themselves.
- Clusters need to know a node is in a verified state before trusting it with workloads and secrets.

## Decision

- **Boundary.** kubelet reaches `cri` through one route, `cri#kubelet`. The transport is CRI v1 gRPC over an `AF_UNIX` stream socket pair created by `warden`. This is the only non-capwire IPC in keylos ([protocols §21.1](../../specs/protocols/spec.md#211-boundary)).
- **kubelet** is a tier-1 sealed service with no root and no capabilities.
  - Volume mounts, networking and image handling are done by `cri`.
  - `cri` holds the delegated cgroup subtree `/keylos.slice/kube.slice`.
- **Runtime classes** ([protocols §21.2](../../specs/protocols/spec.md#212-runtime-classes)):
  - `keylos-vm` (default): one bench VM per pod sandbox (`purpose: pod`). Containers run inside the guest under `youki`. Any OCI image is allowed, and images are never registered with `kl-exec` on the host.
  - `keylos-sealed`: images are converted by `depot` into `container` generations. They launch only with an `org-publisher` generation statement, and run as t1 principals via `PodSpawn`, with `runtime-default` seccomp and no added capabilities.
- **Admission.** `cri` normalises each sandbox request into `keylos.podspec/1` and calls `BrokerSystem.admitPod`. Cedar action `admit` on entity `PodSpec` decides.
  - The default policy forbids privileged pods, host namespaces, added capabilities, unconfined seccomp, privilege escalation, and `hostPath` outside a read-only allowlist.
  - `@tier`/`@orgApproval` permits hold the sandbox in `pending-approval`.
- **Networking.** One cri network namespace from `net` (`NetPlumbingCluster.clusterUplink`), with a bridge, host-local IPAM, and VXLAN or direct routing. NetworkPolicy is compiled to nftables.
  - Pod VMs use tap devices. This is the only tap use in keylos; workbench and tier-2 VMs never get one ([ADR-0044](adr-0044-vsock-control-and-userspace-nic.md)).
  - Optional `cluster.egressViaGate` sends pod egress outside the cluster through `gate`.
- **Storage.**
  - emptyDir and local PVs are `strata` volumes; projected volumes are tmpfs.
  - NFS, iSCSI and RBD are mounted only inside pod VMs.
  - CSI node plugins run in pod VMs, with block devices from `MediaAttach.claimBlock`.
- **Attestation.** Before kubelet starts, `cri` runs `FleetCluster.joinAttested` with an AK quote over a single-use `joinChallenge`, plus a CVM report on confidential VMs. Credentials (`clusterCertificate` roles `kubelet`, `kube-proxy`, `cri`) are issued only to attested nodes, and renewal stops if re-attestation fails.

## Alternatives considered

| Option | Why not |
|---|---|
| containerd + runc on the host with kubelet as root | Violates I1, I2 and ADR-0023; one image escape owns the node |
| containerd + Kata as the runtime, kubelet as root | Still needs a root kubelet, host CNI plugins and host mounts; duplicates bench |
| gVisor (runsc) for pods | Compatible with many workloads, but syscall overhead is high for I/O-heavy pods and it adds a second sandbox technology to the TCB |
| No Kubernetes support | Excludes keylos from server fleets, where attestation and confinement are most valuable |
| Third-party CNI and eBPF CNIs on the host | eBPF and netfilter programming by third-party code contradicts the single-loader BPF rule (§9.3) |

## Consequences

### Positive
- A malicious or compromised image has to escape a VM, not just a namespace.
- The cluster control plane is a principal with policy-limited authority on the node, not root.
- Nodes prove their integrity before joining, and drop out when attestation fails.
- Pod admissions and denials leave receipts (`pod.admit`, `pod.deny`).

### Negative
- Memory and start-up overhead per pod in the default class. `maxPods` bounds the count, and nodes are exempt from the desktop VM caps.
- Not supported: privileged pods, `hostNetwork`/`hostPID`/`hostIPC`, host-access DaemonSets, eBPF CNIs and Windows containers. Node agents must ship as sealed tier-0 services.
- GPUs only by whole-device VFIO passthrough into pod VMs.

### Follow-ups
- critest and the Kubernetes node e2e subset are part of the `cri` conformance suite.
- Track upstream CRI changes for each of the three supported Kubernetes minors.

## Related

- [Kubernetes nodes](../10-operations/kubernetes.md)
- [Run a Kubernetes node](../12-guides/run-a-kubernetes-node.md)
- [cri component](../03-components/cri.md)
- [ADR-0009: Unsealed code runs only in workbenches](adr-0009-unsealed-code-in-workbenches.md)
- [ADR-0010: crosvm as the single VMM](adr-0010-crosvm-single-vmm.md)
