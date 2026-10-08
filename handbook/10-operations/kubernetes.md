# Kubernetes nodes

> The `server-k8s` profile turns a keylos machine into a Kubernetes worker node. Upstream `kubelet` and `kube-proxy` run as confined services. keylos's own `cri` implements the container runtime: by default each pod runs in its own microVM. The cluster control plane is a principal whose authority on the node is limited by Cedar policy, and nodes join only after proving their integrity.
> Status: **specified (v1.0)**. Normative: [protocols §21](../../specs/protocols/spec.md#21-cluster-nodes-cri), [cri spec](../../specs/cri/spec.md).

![Cluster node: kubelet, cri, pod VMs and sealed pods](../images/cluster-node.svg)

## What runs on a node

| Component | Runs as | Holds |
|---|---|---|
| `kubelet` | Tier-1 sealed service, no root, no capabilities | Route `cri#kubelet` (CRI v1 gRPC over a unix stream socket); read-only view of `/keylos.slice/kube.slice` for stats; state dir `/var/lib/keylos/cri/kubelet` (written by cri) |
| `kube-proxy` | Sealed service in nftables mode (`network: cluster`) | `CAP_NET_ADMIN` only inside the cri network namespace |
| `cri` | Tier-0 keylos service (`network: cluster`) | The delegated cgroup subtree; `CAP_NET_ADMIN` in the cri netns; facets on bench, warden, depot, strata, net, devd, fleet |
| Pod VMs | `bench` microVMs, `purpose: pod` | Containers run under `youki` inside the guest |
| Sealed pods | t1 principals spawned through `PodSpawn` | One principal per container, `runtime-default` seccomp, read-only root plus tmpfs at `/tmp`, `/run`, `/var/tmp`, `/dev/shm`; `kubectl exec` joins the container through `PodSpawn.execInContainer` |

kubelet never mounts volumes, programs networking or handles images. It asks `cri`, which does that work under its own facets.

## Runtime classes

| RuntimeClass | Isolation | Images | When to use |
|---|---|---|---|
| `keylos-vm` (default) | One microVM per pod sandbox | Any OCI image, pinned by digest, never executed on the host | Third-party images, multi-tenant workloads, anything you didn't build |
| `keylos-sealed` | Host principals, no VM | `container` generations with a generation statement signed by an enabled `org-publisher` key | Your organisation's own images, where density and start time matter |

`depot` converts sealed images deterministically: layers are applied in order, whiteouts resolved, ownership kept and timestamps zeroed. The result runs only if the org's TUF repository has a matching generation statement.

## Admission

Every `RunPodSandbox` is normalised by `cri` into `keylos.podspec/1` and sent to `BrokerSystem.admitPod`. The broker evaluates Cedar action `admit` with principal `service:kubelet`.

| Default forbid | Why |
|---|---|
| `privileged`, added capabilities, `allowPrivilegeEscalation` | No root on the node |
| `hostNetwork`, `hostPID`, `hostIPC` | No host namespaces for workloads |
| `seccompProfile == "unconfined"` | Seccomp is part of the baseline |
| `hostPath` outside `cluster.hostPathAllowlist` (default empty) | Host files are not pod storage |
| `keylos-sealed` with `allImagesSealed == false` | Sealed pods only run signed generations (`cri` computes the attribute) |

A `permit` with `@tier` or `@orgApproval` holds the sandbox in `pending-approval` until someone decides. Denials fail with gRPC `PermissionDenied` and the reasons. Every decision leaves `pod.admit` or `pod.deny`.

## Networking

- `net` creates the **cri network namespace** at its own start, with a veth uplink to the host and the bridge `kl-cri0`. This is the one exception to "only `warden` creates namespaces" ([ADR-0025 addendum](../11-decisions/adr-0025-namespaces-only-by-warden.md#addendum-round-3-the-cri-network-namespace)). `warden` starts `crid`, `kubelet` and `kube-proxy` inside it (`NetPlumbingCluster.clusterNetns`); `cri` configures the pod CIDR, NAT and overlay with `clusterUplink` (`keylos.cri.uplink/1`).
- **Attachment:** pod VMs get a tap device on `kl-cri0` (`VmSpec.tap`); sealed pods get their own network namespace with a veth, created by `net` (op `podNetns`). This is the only place keylos uses tap devices.
- **Addressing and routing:** IPAM is host-local per pod CIDR. Cross-node traffic uses direct routing or a VXLAN overlay that cri configures.
- **NetworkPolicy** is compiled to nftables in the cri namespace.
- **Egress via gate:** with `cluster.egressViaGate = true`, pod traffic leaving the cluster CIDRs goes through gate and is subject to gate policy and receipts: sealed pods through the per-pod shim from `PodSpawn.egressShim`, pod VMs through their own `bench-net`. The host drops pod traffic that tries to bypass it. Destinations come from config `cluster.egress`.
- **Not supported:** third-party CNI plugins and eBPF-based CNIs.

## Storage

| Volume | Implementation |
|---|---|
| `emptyDir` | `strata` subvolume per pod (`StrataVolumes.create`, kind `emptyDir`), deleted with the pod |
| Local PersistentVolume | `strata` subvolume kept until release |
| `configMap`, `secret`, `projected`, `downwardAPI` | Written by the mount-free kubelet under its state directory; pod VMs get a read-only share, sealed pods a tmpfs copy (`PodMount.tmpfsBytes`, updates at container restart). Kubernetes secrets never enter `vault` |
| NFS, iSCSI, RBD | Mounted inside pod VMs only |
| CSI | Drivers shipped as `container` generations declaring `needs.csi`; node plugins run in a pod VM; block devices from `MediaAttach.claimBlock`, hot-plugged into running pod VMs with `Vm.attachBlock` |

Size limits are enforced without btrfs quotas: strata scans usage every 30 s and cri evicts pods that exceed `ephemeral-storage`.

## Joining a cluster

1. The installer or config enables the `server-k8s` profile. `cri`, `kubelet` and `kube-proxy` generations come from the release.
2. Before kubelet starts, `cri` gets a single-use challenge (`FleetCluster.joinChallenge`, valid ≤ 300 s) and calls `FleetCluster.joinAttested` with an AK quote over it (and the confidential-VM report on `cvm` machines). `fleet` checks the quote against the release log.
3. Only then does cri get its credentials with `FleetCluster.clusterCertificate` (roles `kubelet`, `kube-proxy` and `cri`) and write the kubeconfigs.
4. Certificates are renewed before expiry. If re-attestation fails, for example after an unapproved firmware change, renewal stops and the node drops out when its certificate expires.

## Operating the node

```
cri pods                    pods with runtime class, state and admission result
cri node                    attestation state, kubelet version, capacity
cri images                  cached OCI images and container generations
cri drain --reason "…"      cordon and evict through the kubelet's API (owner shell)
ledger query --event pod.   admissions, denials, starts and stops
```

## Not supported

- Privileged pods, and `hostNetwork`/`hostPID`/`hostIPC`.
- DaemonSets that need host access. Node agents ship as sealed tier-0 services instead.
- Windows containers.
- GPU sharing. Whole-device VFIO passthrough into pod VMs only.

## Limitations

- Each `keylos-vm` pod costs tens of MB and a VM start, bounded by `maxPods`. Pod VMs are exempt from the desktop RAM-class VM cap.
- Third-party operators that assume a privileged node agent need adaptation.
- Sealed containers cannot write outside their tmpfs mounts; images that need a writable root use `keylos-vm`.
- A `crid` restart keeps pods running (pod VMs are reattached with `Bench.reattach`), but a `bench` restart stops every pod VM.

## Related

- [Run a Kubernetes node](../12-guides/run-a-kubernetes-node.md)
- [Servers and cloud](servers-and-cloud.md)
- [cri component](../03-components/cri.md)
- [ADR-0047: Pods in microVMs through a keylos CRI](../11-decisions/adr-0047-cri-microvm-pods.md)
- [Fleet](fleet.md)
