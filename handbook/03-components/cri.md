# cri

> The Kubernetes container runtime for keylos nodes. cri implements CRI v1 for an upstream, unprivileged `kubelet`. By default it runs every pod sandbox in its own `bench` microVM; signed `container` generations can run as plain host principals instead. It admits every pod through Cedar policy, owns pod networking and volumes, and gets the node's kubelet certificates only after TPM attestation.

**Status:** specified (v1.0) · **Spec:** [`cri/spec.md`](../../specs/cri/spec.md)

## Responsibilities

- **CRI server:** `runtime.v1.RuntimeService` and `ImageService` over the `cri#kubelet` stream socket, for the three most recent Kubernetes minors.
- **Admission:** normalise sandbox requests into `keylos.podspec/1` and call `BrokerSystem.admitPod`. Hold `pending-approval` sandboxes.
- **Runtime classes:**
  - `keylos-vm`: pod VMs through `bench` (`purpose: pod`), with containers under `youki` in the guest.
  - `keylos-sealed`: `container` generations through `PodSpawn`.
- **Images:** pull and pin OCI images for `keylos-vm`. Install `oci+container://` sources through depot for `keylos-sealed`.
- **Networking:** runs inside the cri netns `net` creates (bridge `kl-cri0`); host-local IPAM, pod taps (`VmSpec.tap`) and pod netns (`clusterUplink` op `podNetns`), VXLAN or direct routing, NetworkPolicy compiled to nftables, optional egress through gate (`PodSpawn.egressShim` for sealed pods, `bench-net` for pod VMs).
- **Storage:**
  - emptyDir and local PVs through `StrataVolumes`, and projected tmpfs volumes;
  - NFS, iSCSI and RBD inside pod VMs;
  - CSI node plugins in pod VMs, and VFIO passthrough.
- **Attestation:** `FleetCluster.joinChallenge` and `joinAttested` before kubelet starts. Credentials through `FleetCluster.clusterCertificate` (roles `kubelet`, `kube-proxy`, `cri`), with renewal.
- **Restarts:** a `crid` restart keeps pods; pod VMs are reattached with `Bench.reattach`, sealed sessions recovered with `PrincipalControl.events(replay)`, log pipes from `FdStore`.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | CRI v1 gRPC | Facet `kubelet` (the only non-capwire IPC in keylos) |
| Provides | `CriAdmin` (`cri-sys`) | Facets `admin` (owner shell), `status` (fleet, atrium) |
| Consumes | bench (facet `cri`) | `start` with purpose `pod`, `reattach`, `Vm` including `attachShare`/`detachShare`, `attachBlock`/`detachBlock`, `info` |
| Consumes | warden (facet `cri`) | `PodSpawn` (`spawnContainer`, `execInContainer`, `egressShim`), `GrantMounts.idmappedDir`, `PrincipalControl` for pod sessions |
| Consumes | broker (facet `system`) | `BrokerSystem.admitPod` |
| Consumes | depot (facet `cri`) | `install` (`oci+container://`, `tuf:`), `get`, `list`, `root`, `unroot` |
| Consumes | strata (facet `cri`) | `StrataVolumes` |
| Consumes | net (facet `plumbing`) | `NetPlumbingCluster.clusterUplink` (ops `uplink`, `podNetns`, `release`) |
| Consumes | devd (facet `cri`) | `MediaAttach.claimBlock`, `claimVfio` |
| Consumes | fleet (facet `cluster`) | `FleetCluster` (`joinChallenge`, `joinAttested`, `clusterCertificate`) |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| cri | `kubelet` | kubelet | CRI v1 gRPC (`RuntimeService`, `ImageService`) over the `AF_UNIX` stream socket (§21) |
| cri | `admin` | owner `shell` | `CriAdmin` (all) |
| cri | `status` | fleet, atrium | `CriAdmin.pods`, `node`, `images` |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`cri-sys.capnp`](../../specs/protocols/spec.md#7523-cri-syscapnp) | `0xc7a1e5d3b2f40036` | `CriAdmin` |
<!-- /generated:sysif -->

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `pod.admit`, `pod.deny`, `pod.start`, `pod.stop`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Runs as

A tier-0 service with `network: host`. It holds `CAP_NET_ADMIN` only inside the cri network namespace and the delegated cgroup subtree `/keylos.slice/kube.slice`. State lives under `/var/lib/keylos/cri/` (images, kubelet state, certificates).

## Key decisions

- [ADR-0047: Pods in microVMs through a keylos CRI](../11-decisions/adr-0047-cri-microvm-pods.md)
- [ADR-0044: vsock for control, a userspace NIC for traffic](../11-decisions/adr-0044-vsock-control-and-userspace-nic.md) (the tap-device exception)

## Limitations

- No privileged pods, host namespaces, added capabilities, eBPF CNIs, Windows containers or GPU sharing.
- Pod VMs cost memory and start time, bounded by kubelet `maxPods`.

## Related

- [Kubernetes nodes](../10-operations/kubernetes.md)
- [Run a Kubernetes node](../12-guides/run-a-kubernetes-node.md)
- [bench](bench.md) · [fleet](fleet.md) · [broker](broker.md)
