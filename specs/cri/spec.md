# keylos/cri: Kubernetes node runtime

| | |
|---|---|
| Repository | `github.com/keylos-os/cri` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `crid` (tier-0 service generation `io.keylos.cri`); `cri-unpack` (image converter helper, same generation, spawned by `crid`); `kl-podagent` (guest agent binary, packaged by `pkgs` into the pod bench-image `io.keylos.bench.pod`); `cri-ctl` (CLI generation `io.keylos.cri-ctl`); crate `keylos-podspec` (pod normalisation to `keylos.podspec/1`, also used by the `broker` policy test runner); Nickel module `keylos.cluster` (consumed by the `config` repo) |
| Depends on | `keylos-protocols 1.0` (crates `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-biscuit`, `keylos-tpm-registry`); upstream Kubernetes CRI v1 API (`k8s.io/cri-api`, `runtime.v1`) for the Kubernetes minors listed in §2.3 |
| Runtime peers | `warden` (`warden#service`, `warden#cri`), `broker` (`broker#system`), `bench` (`bench#cri`), `depot` (`depot#cri`), `strata` (`strata#cri`), `net` (`net#plumbing`), `devd` (`devd#cri`), `fleet` (`fleet#cluster`), `ledger` (`ledger#writer`), `journal` (`journal#client`), `gate` (§4.10.8, `ShimEndpoint` capabilities for sealed pods from `PodSpawn.egressShim`; pod VMs reach gate through their `bench-net`), upstream `kubelet` and `kube-proxy` (sealed generations from `pkgs`) |
| Provides | CRI v1 `RuntimeService` and `ImageService` to `kubelet` on route `cri#kubelet` (protocols §21.1); `CriAdmin` (protocols §7.5.23) on facets `admin` and `status`; runtime classes `keylos-vm` and `keylos-sealed`; pod admission through `BrokerSystem.admitPod`; receipts `pod.admit`, `pod.deny`, `pod.start`, `pod.stop` |
| Profiles | `server-k8s` only (protocols §2.2). The generation is not part of any other profile's image. |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as described in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`cri` turns a keylos machine into a Kubernetes worker node without giving the cluster, `kubelet` or any pod root on the host. It is the only component that speaks to upstream Kubernetes code, and the only place where a non-capwire IPC boundary exists in keylos (protocols §7.1).

`cri`:

1. **Serves CRI v1** (`runtime.v1.RuntimeService`, `runtime.v1.ImageService`) to the upstream `kubelet` over the `AF_UNIX` stream socket that `warden` creates for the route `cri#kubelet`.
2. **Admits pods** by normalising every pod into `keylos.podspec/1` and asking `broker` (`BrokerSystem.admitPod`) to evaluate the Cedar action `admit`. It holds pods in `pending-approval` when a permit requires an approval, and denies everything the policy denies. It re-checks every container against the admitted spec.
3. **Runs pods in two runtime classes**:
   - **`keylos-vm`** (default): one `bench` microVM per pod sandbox (`VmSpec.purpose = pod`). Containers run inside the guest under `youki`, driven by `kl-podagent`. Any OCI image is allowed, because nothing from it ever executes on the host.
   - **`keylos-sealed`**: `container` generations (OCI images converted by `depot` and signed by an org publisher) run as tier-1 principals spawned by `warden` through `PodSpawn`. There is no VM, and no added capability ever.
4. **Manages images**: pulls OCI images with digest pinning, converts `keylos-vm` images into read-only EROFS images in a confined helper, and installs `keylos-sealed` images through `depot`.
5. **Owns cluster networking on the node**: inside the cluster network namespace that `net` creates at its own start (with the bridge `kl-cri0`), it runs IPAM, pod taps and veths, cross-node routing (direct or VXLAN), the NetworkPolicy compiler, the optional egress-via-gate redirection and the CRI streaming server.
6. **Maps Kubernetes volumes** onto keylos storage: `strata` subvolumes (`StrataVolumes`), tmpfs-backed projected volumes, network volumes inside pod VMs only, CSI node plugins in pod VMs, block devices and GPUs through `devd` (`MediaAttach`).
7. **Attests the node** to the cluster before `kubelet` runs (`FleetCluster.joinAttested`). The join is bound to a fresh `FleetCluster.joinChallenge`. It obtains and renews node credentials (`FleetCluster.clusterCertificate` with roles `kubelet`, `kube-proxy` and `cri`), and lets the node drop out when re-attestation fails.
8. **Writes receipts** for pod admission, denial, start and stop.

**Non-goals**

| Not provided | Reason / replacement |
|---|---|
| Privileged pods, `hostNetwork`, `hostPID`, `hostIPC`, added capabilities | protocols §21.8; denied by the default policy and by `cri` itself regardless of policy (§3.3) |
| DaemonSets that need host access (CNI agents, node exporters with host mounts, log shippers reading `/var/log`) | Node-level agents ship as sealed tier-0 services (`pkgs`); metrics come from `journal` `Metrics` and the CRI stats API |
| Third-party CNI plugins, eBPF CNIs | `cri` implements the pod network itself (§4.10) |
| Windows containers, Linux user namespaces for pods (`hostUsers: false`) | Pods in `keylos-vm` are already isolated by a VM; `keylos-sealed` containers use warden's per-pod mapping-only user namespace (protocols §7.5.1 `PodContext.runAsUid`) |
| `LoadBalancer` services implemented on the node | Use `NodePort` behind an external load balancer |
| Container checkpointing (`CheckpointContainer`) | Returns `UNIMPLEMENTED` |
| GPU sharing (time slicing, MIG) | Whole-device VFIO passthrough into a pod VM only (§4.17) |
| Running `kubelet` with root, or letting `kubelet` mount filesystems | `kubelet` runs in mount-free mode (§2.4); `cri` performs every mount-equivalent through keylos interfaces |

**Terminology**

| Term | Meaning |
|---|---|
| Pod sandbox | The CRI `PodSandbox`. In `keylos-vm` it is one microVM; in `keylos-sealed` it is a pod network namespace plus a pod cgroup slice |
| Pod ID | `pod-` + ULID (protocols §3.5), assigned by `cri` at `RunPodSandbox`. It is the CRI `pod_sandbox_id` returned to kubelet |
| Cluster netns | The network namespace that `net` creates for the cluster (protocols §21.5). `crid`, `kubelet` and `kube-proxy` run inside it (`services.json` `network: "cluster"`, protocols §20.16) |
| Pod netns | For `keylos-sealed`, the per-pod network namespace with one veth into the cluster bridge. For `keylos-vm`, the guest's own network stack behind a tap device |
| Image blob | A flattened, whiteout-resolved EROFS image of one OCI image manifest, used read-only by pod VMs |
| Container generation | A `container`-kind generation (protocols §6.1) produced by `depot` from an OCI image for `keylos-sealed` |
| Admitted spec | The `keylos.podspec/1` document that `broker` admitted for a sandbox; later container requests MUST stay inside it |

---

## 2. Context and embedded contracts

### 2.1 Position in the system

```
               API server (remote, cluster control plane)
                      ▲            ▲
       node cert (TLS)│            │cri credential (TLS, RBAC keylos-cri-node)
                      │            │
┌─────────────────────┼────────────┼──────────── cluster netns (net) ─────────────────────────┐
│   kubelet (t1, no root, mount-free mode)   kube-proxy (t1, CAP_NET_ADMIN here only)         │
│        │ CRI v1 gRPC over AF_UNIX stream (route cri#kubelet, created by warden)             │
│        ▼                                                                                   │
│   crid (t0) ── bridge kl-cri0 (net) ── tap/veth per pod ── VXLAN kl-vx0 / direct routes ─┼── host netns (net)
│     │  streaming server 10.x.0.1:10010 (exec/attach/port-forward)                          │
└─────┼──────────────────────────────────────────────────────────────────────────────────────┘
      │ capwire (SOCK_SEQPACKET)
      ├── broker#system      admitPod
      ├── bench#cri          pod VMs (kl-podagent inside, youki), reattach, attachBlock
      ├── warden#cri         PodSpawn (spawn, execInContainer, egressShim), idmappedDir, PrincipalControl
      ├── depot#cri          oci+container:// installs, GC roots
      ├── strata#cri         StrataVolumes (emptyDir, local PVs)
      ├── net#plumbing       NetPlumbingCluster.clusterUplink (uplink, podNetns, release)
      ├── devd#cri           MediaAttach (block devices for CSI, VFIO GPUs)
      ├── fleet#cluster      joinChallenge, joinAttested, clusterCertificate
      └── ledger#writer      pod.* receipts
```

### 2.2 Routes and facets

| Direction | Route | Interfaces used | Purpose |
|---|---|---|---|
| kubelet → cri | `cri#kubelet` | CRI v1 gRPC (`RuntimeService`, `ImageService`) | Pod and image lifecycle |
| owner shell → cri | `cri#admin` | `CriAdmin` (all) | `cri-ctl` |
| fleet, atrium → cri | `cri#status` | `CriAdmin.pods`, `node`, `images` | Status display |
| cri → warden | `warden#service` | `Bootstrap`, `ServiceHost` (fd 3), `Supervisor.spawn`, `identify`, `FdStore` | Service lifecycle; spawning `cri-unpack` helpers; keeping log-pipe fds across restarts (§7.2) |
| cri → warden | `warden#cri` | `PodSpawn.spawnContainer`, `execInContainer`, `egressShim`; `GrantMounts.idmappedDir`; `PrincipalControl.terminate`/`events` (pod sessions only, with `replay`) | `keylos-sealed` containers, exec and egress shims; volume trees |
| cri → broker | `broker#system` | `BrokerSystem.admitPod`; `Broker.inspect` | Admission |
| cri → bench | `bench#cri` | `Bench.start` (purpose `pod`), `Bench.reattach`; `Vm` (all, including `attachShare`/`detachShare`, `attachBlock`/`detachBlock`, `info`) | Pod VMs |
| cri → depot | `depot#cri` | `install` (`oci+container://`, `tuf:`), `get`, `list`, `root`, `unroot` | `keylos-sealed` images; pod bench-image |
| cri → strata | `strata#cri` | `StrataVolumes` | `emptyDir`, local PersistentVolumes |
| cri → net | `net#plumbing` | `NetPlumbingCluster.clusterUplink` (ops `uplink`, `podNetns`, `release`, protocols §21.5) | Pod CIDR, NAT, overlay peers; pod network namespaces |
| cri → devd | `devd#cri` | `MediaAttach` | Block devices for CSI node plugins; VFIO GPUs |
| cri → fleet | `fleet#cluster` | `FleetCluster.joinChallenge`, `joinAttested`, `clusterCertificate` | Attested join; node and component certificates |
| cri → ledger | `ledger#writer` | `Ledger.append` | Receipts |
| cri → journal | `journal#client` | stream fd 2, `Metrics` (own) | Logs and metrics |
| cri → gate | `ShimEndpoint` capabilities from `PodSpawn.egressShim` (no route) | `ShimEndpoint.connect`, `udpAssociate`, `resolve` | `cluster.egressViaGate` for `keylos-sealed` pods |

### 2.3 Upstream contracts

| Item | Contract |
|---|---|
| CRI API | `runtime.v1` from `k8s.io/cri-api`, generated from the `api.proto` of the newest supported minor. Messages and RPCs added by newer minors that `cri` does not implement return gRPC `UNIMPLEMENTED`; kubelet treats that as "feature unsupported". |
| Supported Kubernetes minors | The three most recent minors at the `cri` release date. For a release in October 2026 these are **1.35, 1.36, 1.37**. The set is recorded in `crid --version` and in `CriAdmin.node`. A kubelet whose `Version` request reports another minor is refused at the first `Version` call with `FAILED_PRECONDITION`. |
| kubelet build | The `kubelet` generation (`io.keylos.kubelet`) built by `forge` from upstream source with the keylos patch set described in §2.4. On every `cri#kubelet` connection `crid` takes the peer generation from `ServiceHost.accept`, reads its manifest with `Depot.get` (facet `cri`), and refuses the connection unless the manifest name is `io.keylos.kubelet` and the informational field `x-kubelet.patchSet` is `keylos-mountless` (the patch set protocols §21.1 makes part of the contract). This is a compatibility check, not an authority decision: the kubelet's authority comes only from the route. |
| kube-proxy | Upstream, nftables mode, running inside the cluster netns. |
| RuntimeClass objects | The cluster administrator creates `RuntimeClass` objects with handlers `keylos-vm` and `keylos-sealed` (template in §10.3). `cri` treats an empty handler as `keylos-vm`. |

### 2.4 Kubelet mount-free mode (required kubelet behaviour)

`kubelet` holds no root, no capabilities and no mount syscalls (protocols §9.1, §21.1). The `kubelet` generation in `pkgs` carries the **`keylos-mountless`** patch set, which protocols §21.1 makes part of the cluster-node contract. `cri` depends on this behaviour:

| Kubelet behaviour | Required |
|---|---|
| State directory | `--root-dir=/var/lib/keylos/cri/kubelet` (protocols §21.1). `cri` writes `config/` (kubelet configuration and kubeconfig) and `pki/` (kubelet credentials) inside it; kubelet has read-only access to those two subdirectories and read-write access only to `pods/`, `plugins/`, `plugins_registry/`, `device-plugins/` and `state/` (§10.4) |
| State files | The patch set moves `cpu_manager_state`, `memory_manager_state` and `dra_manager_state` into `<root-dir>/state/`, so no file is written at the top level of the root directory |
| Mounter | Every mount, unmount and device-attach step is a no-op that reports success; `IsLikelyNotMountPoint` returns `false` for targets the mounter has "mounted" |
| Atomic-writer volumes | configMap, secret, projected and downwardAPI contents are written into plain directories under `<root-dir>/pods/<uid>/volumes/<plugin>/<volume>/` with kubelet's atomic writer. `cri` turns them into `PodMount` trees with `tmpfsBytes > 0` (sealed pods) or read-only VM shares (§4.11) |
| `subPath` | No bind mount: kubelet passes `host_path = <volume dir>/<subPath>` in the CRI `Mount`; `cri` resolves it with `openat2(RESOLVE_BENEATH \| RESOLVE_NO_SYMLINKS)` relative to the volume directory (§4.11) |
| Volume plugins | In-tree plugins that would mount on the host (NFS, iSCSI, RBD, FC, `local` with a block device) report success without mounting; the actual mount happens inside the pod VM (§4.11). CSI node-stage/publish calls go to CSI node plugins running in pod VMs (§4.18) |
| cgroups | `cgroupsPerQOS: false`, `enforceNodeAllocatable: []`, `cgroupDriver: cgroupfs`, `cgroupRoot: /`, `kubeletCgroups`/`systemCgroups` unset. `cri` enforces node allocatable on `/keylos.slice/kube.slice` (§4.13) |
| Stats | Feature gate `PodAndContainerStatsFromCRI=true`; cAdvisor reads only node-level `/proc` and `/sys` paths granted read-only |
| Certificates | `rotateCertificates: false`, `serverTLSBootstrap: false`; client and serving certificates are files written by `cri` (§4.4) |
| Logs | `podLogsDir: /var/lib/keylos/cri/logs` |
| Device plugins | `cri` registers as a device plugin over the kubelet device-plugin socket under the root directory (§4.17) |
| Static pods | `staticPodPath` unset. Static pods are not supported on keylos nodes (node agents ship as tier-0 services) |

`cri` verifies these settings at kubelet connection time through the kubelet configuration file it writes itself (§4.4.3); `kubelet` has no other configuration source.

### 2.5 Interpretation notes (normative for this repo)

These notes fix how `cri` reads the protocols contracts where several readings are possible. None of them needs a protocols change.

| ID | Note | Used in |
|---|---|---|
| N1 | The kubelet **serving** certificate is requested with `FleetCluster.clusterCertificate("kubelet", csr)` where the CSR carries extended key usage `serverAuth` and the node-IP SANs; the client certificate uses the same role with `clientAuth`. `fleet` issues per EKU. | §4.4 |
| N2 | Pod VMs outlive their `Vm` capability until `Vm.stop`, the end of their parent session (the `crid` service session) or a `bench` restart (protocols §7.3.13, `Bench.reattach`). A `crid` restart therefore keeps pod VMs; `crid` reattaches (§7.2). | §7.2 |
| N3 | `net` creates the cri network namespace and the bridge `kl-cri0` at its own start from config `cluster.*`; `warden` starts `crid`, `kubelet` and `kube-proxy` in it (`network: "cluster"`). `crid` configures it only through `clusterUplink` and its own `CAP_NET_ADMIN` inside it (VXLAN device, FDB, nftables). Exposure of the kubelet port, NodePorts and VXLAN on the host side is part of `net`'s `cluster.*` configuration, not of the uplink object. | §4.10 |
| N4 | Admission is against the API server's Pod object (protocols §21.3); the CRI configs are cross-checked against it. | §4.6 |
| N5 | A `keylos-sealed` container generation is rooted `cri:pod:<pod-id>` before the first `PodSpawn.spawnContainer` of that pod and unrooted at `RemovePodSandbox` (protocols §21.4, `depot` mounts container generations only while so rooted). `cri:image:<digest>` roots keep pulled generations for `ListImages` between pods. | §4.8 |
| N6 | `keylos-vm` pods with `cluster.egressViaGate` send traffic outside the cluster CIDRs through their VM's `bench-net` (the pod principal's tokens come from the broker at `VmSpawn.register`, policy `cluster.egress`); the host side drops tap traffic to such destinations. `keylos-sealed` pods use `PodSpawn.egressShim`. | §4.10.8 |

### 2.6 Embedded protocols contracts

Appendix A contains, verbatim and generated mechanically from `keylos-protocols 1.0.0`, every protocols section this repository implements or consumes:

| Protocols section | Why |
|---|---|
| §2.2, §2.3 | `server-k8s` profile; RAM classes and the pod-VM cap exemption |
| §3.3, §3.4, §3.5 | Kubernetes names, pod principals, pod IDs |
| §6.1, §6.3 | `container` generations; `needs.csi`, `needs.gpu: "passthrough"` |
| §7.1, §7.2 | capwire and the CRI exception; routes and facets |
| §7.3.1, §7.3.2 | Common types; `SpawnSpec`, `Process` |
| §7.3.5 | `Ledger.append` |
| §7.3.8 | `Depot`, `oci+container://` |
| §7.3.13 | `VmSpec`, `Vm`, `Bench` |
| §7.5.1 | `PodSpawn`, `PodContext`, `GrantMounts`, `PrincipalControl` |
| §7.5.2 | `BrokerSystem.admitPod`, `PodAdmission` |
| §7.5.7 | `StrataVolumes` |
| §7.5.8 | `MediaAttach` |
| §7.5.11 | `NetPlumbingCluster` |
| §7.5.12 | `ShimEndpoint` |
| §7.5.21 | `FleetCluster` |
| §7.5.23 | `CriAdmin` |
| §9.1, §9.2, §9.3 | Baseline, pod tiers, `runtime-default` seccomp, kl-exec rules |
| §10.1, §10.3, §10.5, §10.6, §10.7 | Paths, cgroups, environment, log and metrics records, cross-repo files |
| §13.1 | Receipt payload |
| §16.1, §16.2 | Cedar `PodSpec`, `admit`, default pod forbids |
| §19.1, §19.2, §19.3, §19.4 (rows for cri) | Registries |
| §19.6 | AK and PCR usage for attestation |
| §20.16 | `services.json` |
| §21 | The cluster-node contract |

If an embedded copy differs from `keylos-protocols 1.0.0`, protocols wins.

---
## 3. Requirements

### 3.1 Service and boundary

- **REQ-CRI-001** `crid` MUST run as tier-0 service `cri` (protocols §19.1) only on the `server-k8s` profile. On any other profile it MUST refuse to start with `kl:unsupported`.
- **REQ-CRI-002** `crid` MUST serve CRI v1 only on the stream socket handed over by `warden` for route `cri#kubelet`, and MUST NOT create, bind or listen on any other `AF_UNIX` path.
- **REQ-CRI-003** `crid` MUST accept CRI connections only from a peer whose principal is `service:kubelet:<gen>@_system/…` (from `ServiceHost.accept`), and only if the kubelet generation passes the compatibility check of §2.3.
- **REQ-CRI-004** `crid` MUST implement every RPC of `runtime.v1.RuntimeService` and `runtime.v1.ImageService` listed in §5.1 with the semantics given there, and MUST return gRPC `UNIMPLEMENTED` for every other RPC.
- **REQ-CRI-005** The capwire services `CriAdmin` on facets `admin` and `status` MUST enforce the method split of protocols §19.2 (`drain` on `admin` only).
- **REQ-CRI-006** `crid` MUST call `Bootstrap.ready` only after the node has been attested and the kubelet credential and kubeconfig have been written (§4.3). Until then, CRI calls MUST fail with `UNAVAILABLE` and the message `node not attested`.

### 3.2 Admission

- **REQ-CRI-010** Every `RunPodSandbox` MUST be admitted by `BrokerSystem.admitPod` with the normalised `keylos.podspec/1` (§4.6) and the runtime class before any resource for the pod is created.
- **REQ-CRI-011** `cri` MUST build the admitted spec from the Pod object watched from the API server, matched by the sandbox's `metadata.uid`. If the Pod object is not available within 10 s, `RunPodSandbox` MUST fail with `UNAVAILABLE`.
- **REQ-CRI-012** A denial MUST fail `RunPodSandbox` with gRPC `PERMISSION_DENIED` and a message listing the admission reasons, and MUST write a `pod.deny` receipt.
- **REQ-CRI-013** When the admission returns an approval ID, `cri` MUST record the sandbox in state `pending-approval`, fail the call with `UNAVAILABLE` and message `pending approval a-…`, and return the same pending state for repeated `RunPodSandbox` calls for the same pod UID and spec digest until the approval resolves (§4.6.4).
- **REQ-CRI-014** Every `CreateContainer` MUST be checked against the admitted spec (§4.6.5). An image digest, security context or volume set not covered by the admitted spec MUST trigger re-admission; a re-admission denial MUST fail `CreateContainer` with `PERMISSION_DENIED`.
- **REQ-CRI-015** Independently of policy, `cri` MUST refuse (with `PERMISSION_DENIED` and reason `keylos:unsupported`) pods that request privileged mode, host network, host PID, host IPC, added capabilities, an unconfined seccomp profile, `allowPrivilegeEscalation`, `hostUsers: false`, host ports, or a sysctl outside the Kubernetes safe set. Policy can only narrow this list.
- **REQ-CRI-016** `runtimeClass == "keylos-sealed"` pods MUST use only images that resolve to launchable `container` generations; any other image MUST fail `PullImage` or `CreateContainer` with `PERMISSION_DENIED`.

### 3.3 keylos-vm runtime class

- **REQ-CRI-020** Each `keylos-vm` pod sandbox MUST be exactly one `bench` VM started with `purpose = pod`, `principalKind = pod`, `session` = a new session and `parentSession` = the `crid` service session.
- **REQ-CRI-021** The VM image MUST be the pod bench-image named by `cluster.podBenchImage` (default `io.keylos.bench.pod`), resolved through `depot` and launchable.
- **REQ-CRI-022** Container rootfs content MUST reach the guest only as read-only image blobs (§4.9.3) and per-pod writable scratch storage inside the VM; image content MUST NOT be unpacked onto any host filesystem as files.
- **REQ-CRI-023** The pod VM's cluster network device MUST be a tap in the cluster netns attached to `kl-cri0`, passed as `VmSpec.tap` with `tapConfig` and `podId` (§4.10.3). Its `bench-net` device MUST carry only traffic to destinations outside the cluster CIDRs, and only when `cluster.egressViaGate` is true (§4.10.8). The VM MUST NOT have vsock ports other than the bench control port.
- **REQ-CRI-024** Network volumes (NFS, iSCSI, RBD) and CSI node plugins MUST be mounted or run inside pod VMs only.
- **REQ-CRI-025** VM memory and vCPU sizing MUST follow §4.7.2. A pod whose sizing exceeds `cluster.vm.maxMemoryMiB` or `cluster.vm.maxVcpus` MUST be denied with `RESOURCE_EXHAUSTED`.

### 3.4 keylos-sealed runtime class

- **REQ-CRI-030** Each `keylos-sealed` container MUST be spawned through `PodSpawn.spawnContainer` with a `container` generation, actor kind `pod`, tier t1, seccomp profile `runtime-default` and no added capabilities. Pods asking for `Unconfined` or `Localhost` seccomp profiles are refused by REQ-CRI-015, so `runtime-default` is the only profile in use.
- **REQ-CRI-031** Each `keylos-sealed` pod MUST have its own pod netns obtained from `net` with `clusterUplink` op `podNetns` (protocols §21.5) and its own cgroup slice under `/keylos.slice/kube.slice/<pod-id>.slice`.
- **REQ-CRI-032** Volume trees passed in `PodContext.mounts` MUST be produced by `GrantMounts.idmappedDir` from directories `cri` holds as `O_PATH` fds, never from paths. configMap, secret, projected, downwardAPI and memory-medium emptyDir volumes MUST use `PodMount.tmpfsBytes > 0`.
- **REQ-CRI-033** `ExecSync` and `Exec` for `keylos-sealed` containers MUST use `PodSpawn.execInContainer` with the target container's session; `cri` MUST NOT emulate exec with a new container.
- **REQ-CRI-034** Before the first `PodSpawn.spawnContainer` of a pod, `cri` MUST root every container generation of the pod as `cri:pod:<pod-id>` with `Depot.root`, and MUST unroot them at `RemovePodSandbox` (§2.5 N5).
- **REQ-CRI-035** `keylos-sealed` containers MUST run with a read-only root plus the tmpfs mounts `warden` provides (protocols §21.8). A pod whose containers need a writable root filesystem outside those paths MUST use `keylos-vm`; `cri` reports this as `EROFS` at run time, not as an admission denial.

### 3.5 Images

- **REQ-CRI-040** Images MUST be pulled by digest. A tag MUST be resolved once per `PullImage` call and the resolved digest recorded; later operations use only the digest.
- **REQ-CRI-041** Image content for `keylos-vm` MUST be stored only under `/var/lib/keylos/cri/images` (protocols §10.1), which is `noexec`, and MUST NOT be registered with `kl-exec`.
- **REQ-CRI-042** Layer decompression and tar parsing MUST happen only in the confined helper `cri-unpack` (§6.4), never in `crid`.
- **REQ-CRI-043** When `cluster.verifyPullCredentials` is true (default), a cached private image MUST be served to a pod only if the pod's namespace and pull-secret set has previously pulled it successfully, or the registry confirms access with the pod's credentials (§4.9.5).
- **REQ-CRI-044** Image garbage collection MUST NOT remove an image referenced by any existing container, and MUST release `depot` GC roots (`unroot`) for container generations it no longer references.

### 3.6 Networking

- **REQ-CRI-050** `crid` MUST run in the cluster netns that `net` creates (`services.json` `network: "cluster"`), MUST configure it only through `NetPlumbingCluster.clusterUplink` and its own `CAP_NET_ADMIN` inside it, and MUST NOT hold `CAP_NET_ADMIN` in any other namespace.
- **REQ-CRI-051** Pod IPs MUST be allocated from the node's pod CIDR (`Node.spec.podCIDRs`) with host-local IPAM persisted in `crid` state (§4.10.2). An address MUST NOT be reused within 60 s of release.
- **REQ-CRI-052** NetworkPolicy objects MUST be compiled into nftables rules in the cluster netns (§4.10.6), applied within 2 s (p99) of a change observed on the API server watch, and MUST default to allow-all for pods not selected by any policy (Kubernetes semantics).
- **REQ-CRI-053** Traffic from pods to the host netns MUST be dropped except: the API server and DNS forwarding paths NATed through the uplink, and the node ports and kubelet port DNATed by `net` (§4.10.7).
- **REQ-CRI-054** With `cluster.egressViaGate = true`, pod egress to destinations outside the cluster CIDRs MUST go through `gate`: `keylos-sealed` pods through the `ShimEndpoint` from `PodSpawn.egressShim`, `keylos-vm` pods through their VM's `bench-net` (§2.5 N6). When neither is available, that traffic MUST be dropped.
- **REQ-CRI-055** Pods MUST NOT reach any capwire service. Pod principals hold no routes.

### 3.7 Storage

- **REQ-CRI-060** `emptyDir` (disk medium) and `local` PersistentVolumes MUST be `strata` volumes (`StrataVolumes.create`); `emptyDir` with medium `Memory`, `secret`, `projected`, `configMap` and `downwardAPI` volumes MUST be tmpfs-backed (§4.11).
- **REQ-CRI-061** `hostPath` volumes MUST be allowed only for paths in `cluster.hostPathAllowlist` (default empty), only read-only, and only when admission allowed them.
- **REQ-CRI-062** Ephemeral storage limits MUST be enforced using `StrataVolumes.usage` and the pod VM's scratch-disk usage; exceeding a limit MUST make `cri` report the pod to kubelet for eviction (§4.13.3).
- **REQ-CRI-063** A `subPath` MUST be resolved with `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` relative to its volume directory, both on the host and in the guest.

### 3.8 Attestation and credentials

- **REQ-CRI-070** Before the first CRI call is served, `crid` MUST obtain a challenge with `FleetCluster.joinChallenge` and complete `FleetCluster.joinAttested` with an AK (`0x81010002`) quote over PCRs 0–15 (protocols §19.6) whose `qualifyingData` is `SHA-256("keylos-join/1" ‖ challenge ‖ machine key)`, the TCG event log, the challenge, and the confidential-VM report on the `cvm` integrity profile. A challenge MUST be used once and only before its expiry.
- **REQ-CRI-071** The kubelet client certificate, kubelet serving certificate, kube-proxy client certificate and the cri cluster credential MUST be obtained only through `FleetCluster.clusterCertificate` with roles `kubelet` (client and serving, §2.5 N1), `kube-proxy` and `cri`. Private keys MUST be generated inside `crid` and stored only under `/var/lib/keylos/cri/kubelet/pki`, `/var/lib/keylos/cri/kube-proxy/pki` and `/var/lib/keylos/cri/pki` with mode 0600.
- **REQ-CRI-072** `crid` MUST re-attest every `cluster.reattestHours` (default 6) and before every certificate renewal. A failed re-attestation MUST stop renewals; the node MUST NOT obtain new credentials until an attestation succeeds.
- **REQ-CRI-073** Certificates MUST be renewed when two thirds of their lifetime has elapsed.

### 3.9 Lifecycle, resources and observability

- **REQ-CRI-080** `crid` MUST persist pod, container, image and IPAM state in `/var/lib/keylos/cri/state.redb` (`keylos.cri.state/1`) with fsync before acknowledging any state-changing CRI call.
- **REQ-CRI-081** Every sandbox MUST get a cgroup slice `/keylos.slice/kube.slice/<pod-id>.slice` with `cpu.weight`, `cpu.max`, `memory.max`, `memory.high` and `pids.max` derived from the pod's resources (§4.13).
- **REQ-CRI-082** `crid` MUST write receipts `pod.admit`, `pod.deny`, `pod.start` and `pod.stop` (§4.19) through `ledger#writer` before acknowledging the corresponding CRI call.
- **REQ-CRI-083** Container logs MUST be written in the CRI log format to the path the kubelet requested, under `cluster.podLogsDir`.
- **REQ-CRI-084** `crid` MUST provide CRI stats (`ContainerStats`, `ListContainerStats`, `PodSandboxStats`, `ListPodSandboxStats`) with values taken from cgroup files (sealed) or from `kl-podagent` (VM) plus the VM process overhead.
- **REQ-CRI-085** Exec, attach and port-forward MUST be served only by the streaming server in the cluster netns, with single-use tokens valid for 30 s (§4.14).
- **REQ-CRI-086** `crid` MUST NOT write any file outside `/var/lib/keylos/cri`, `/run/keylos/cri` and its delegated cgroup subtree.
- **REQ-CRI-087** A `crid` restart MUST NOT restart pods: `crid` MUST reattach running pod VMs with `Bench.reattach`, recover `keylos-sealed` container sessions with `PrincipalControl.events(replay = true)`, and recover log pipes from `FdStore` (§7.2).
- **REQ-CRI-088** Strata volumes and tmpfs volume trees for pods MUST be owned on disk by the `_cluster` UID `0x0FFF0000` (protocols §10.3) and reach containers only through idmapped trees.

---
## 4. Design

### 4.1 Process structure

| Process | Principal | Runs where | Role |
|---|---|---|---|
| `crid` | `service:cri:<gen>@_system/s-…` | Host, tier 0, inside the cluster netns | CRI server, admission, pod orchestration, networking control plane, streaming server, attestation, receipts |
| `cri-unpack` | child session of `crid`, actor `service:cri` (helper entrypoint `unpack`) | Host, tier 0 helper spawned with `Supervisor.spawn` (facet `service`) | Decompresses layers and runs `mkfs.erofs --tar=f` to build image blobs; one process per image conversion |
| `cri-egress` | thread of `crid` | Host, cluster netns | Transparent egress proxy for `cluster.egressViaGate` (§4.10.8) |
| `kl-podagent` | none on the host (inside the pod VM, part of the VM principal) | Guest of each `keylos-vm` pod VM | Drives `youki`, mounts image blobs and volumes, collects stats and logs, implements exec/attach/port-forward in the guest |
| `cri-ctl` | the owner's `shell` principal | Host | CLI over `cri#admin` / `cri#status` |

`crid` is a single tokio process with these subsystems, each a module of the crate `crid`:

```
crid
├── grpc        CRI v1 server (tonic) on the kubelet stream socket; request validation; deadline handling
├── admin       CriAdmin capwire server
├── admit       podspec normaliser (crate keylos-podspec), admission cache, re-admission, approval tracker
├── kube        API server client (kube-rs): Pod, Node, NetworkPolicy, Namespace, Service watches using the cri credential
├── sandbox     sandbox state machine (§4.5), runtime-class dispatch
├── vmrt        keylos-vm runtime: bench VMs, warm pool, kl-podagent sessions
├── sealedrt    keylos-sealed runtime: PodSpawn, pod netns, cgroup files, log pipes
├── images      pull (oci-client), auth, blob conversion via cri-unpack, depot installs, GC
├── netctl      bridge, taps, veths, IPAM, routes, VXLAN, nftables (NetworkPolicy, egress redirect), uplink reconcile
├── volumes     volume mapping (§4.11), StrataVolumes, tmpfs projected volumes, idmappedDir
├── stream      streaming server for exec/attach/port-forward (HTTP/2 + SPDY/WebSocket per upstream streaming library semantics)
├── stats       cgroup and guest stats, metrics descriptors
├── devplugin   device-plugin client to kubelet (VFIO GPUs)
├── attest      TPM quote (tss-esapi), event log, FleetCluster join, re-attestation
├── pki         CSR generation, certificate storage, renewal, kubeconfig rendering
├── store       redb state (keylos.cri.state/1), journal of in-flight operations
└── receipts    ledger writer
```

### 4.2 State and storage

| Path | Content | Mode |
|---|---|---|
| `/var/lib/keylos/cri/state.redb` | `keylos.cri.state/1` (redb database, schema below) | 0600 |
| `/var/lib/keylos/cri/images/blobs/<digest>.erofs` | Image blobs (flattened EROFS, one per OCI manifest digest), fs-verity enabled | 0444, `noexec` |
| `/var/lib/keylos/cri/images/tmp/` | In-progress conversions | 0700 |
| `/var/lib/keylos/cri/pods/<pod-id>/scratch.img` | Sparse per-pod scratch disk for `keylos-vm` (container upper dirs, image-volume overlays) | 0600 |
| `/var/lib/keylos/cri/pods/<pod-id>/images/` | Hard links to the image blobs this pod uses (the pod VM's `images` share) | 0500 |
| `/var/lib/keylos/cri/logs/` | Pod log directory (`podLogsDir`), shared with kubelet read-write | 0750 |
| `/var/lib/keylos/cri/pki/` | The cri cluster credential (§4.4) | 0700 |
| `/var/lib/keylos/cri/kubelet/` | kubelet root directory (protocols §21.1): `config/` and `pki/` written by `cri` (kubelet read-only); `pods/`, `plugins/`, `plugins_registry/`, `device-plugins/`, `state/` written by kubelet | 0750 |
| `/var/lib/keylos/cri/kube-proxy/` | `config/kube-proxy.yaml`, `config/kubeconfig`, `pki/` for kube-proxy (written by `cri`) | 0750 |

**State schema (`keylos.cri.state/1`).** redb tables, keys and values in CBOR:

| Table | Key | Value |
|---|---|---|
| `sandboxes` | pod-id | `{uid, namespace, name, attempt, runtimeClass, state, specDigest, admitted: podspec, approval, session, principal, ip, netns: {kind, ref}, vm: {snapshotClass, memoryMiB, vcpus}, created, started, stopped, labels, annotations, logDirectory, dnsConfig, portMappings: []}` |
| `containers` | container-id (`c-` + ULID) | `{podId, name, attempt, image: {ref, digest}, generation?, state, pid?, exitCode?, startedAt, finishedAt, reason, message, logPath, mounts, resources, session?, principal?}` |
| `images` | image digest | `{repoTags, repoDigests, sizeBytes, kind: "blob" | "generation", blob?: path, generation?: ref, pulledBy: [{namespace, secretsHash, time}], lastUsed, pinned}` |
| `ipam` | IP (text) | `{podId, allocated, releasedAt?}` |
| `ops` | op-id | in-flight operation journal entry `{kind, podId, step, started}` |
| `meta` | key | `{nodeName, podCIDRs, clusterCIDRs, serviceCIDRs, attestedAt, certs: {...expiry}}` |

**Operation journal.** Every multi-step operation (`RunPodSandbox`, `StopPodSandbox`, `RemovePodSandbox`, `CreateContainer`, `PullImage`, `RemoveImage`) writes an `ops` entry before its first side effect and updates `step` after each one. At startup, `crid` replays unfinished entries backwards, undoing completed steps (§7.2). Steps are idempotent.

### 4.3 Startup and node join

```
crid start (warden, inside the cri network namespace net created; network: "cluster")
 1. Bootstrap.host(ServiceHost) on fd 3
 2. open state.redb; replay ops journal; reattach running pod VMs and sealed sessions (§7.2)
 3. read cluster config (/etc/keylos/cluster via config generation, §10.1)
 4. NetPlumbingCluster.clusterUplink(uplink object)          # pod CIDR, NAT, overlay peers (§4.10.7)
 5. attest:
      (challenge, expires) = FleetCluster.joinChallenge()          # single use, ≤ 300 s
      qd = SHA-256("keylos-join/1" ‖ challenge ‖ machineKey)       # protocols §7.5.21
      quote = TPM2_Quote(AK 0x81010002, PCR 0–15 SHA-256 bank, qualifyingData = qd)
      eventLog = /sys/kernel/security/tpm0/binary_bios_measurements
      cvmReport = SEV-SNP / TDX report (cvm integrity profile only), report data = qd
      joinJson = FleetCluster.joinAttested(quote, eventLog, cvmReport, challenge)
 6. for each credential in §4.4.1: generate key, CSR, FleetCluster.clusterCertificate(role, csr)
 7. render kubelet/config/{kubelet.yaml,kubeconfig}, kube-proxy/config/{kube-proxy.yaml,kubeconfig} (§4.4.3)
 8. start API watches with the cri credential (Pod, Node, NetworkPolicy, Namespace, Service, EndpointSlice)
 9. learn Node.spec.podCIDRs (wait up to cluster.podCIDRWaitSecs, default 120; kubelet registers the Node)
10. reconcile running state: pods recorded as running whose VM or processes are gone → mark exited (§7.2)
11. Bootstrap.ready()          # warden now completes cri#kubelet connections; kubelet starts serving
12. Bootstrap.watchdog() every watchdogSecs/2
```

Steps 9 and 11 interlock: kubelet must run to register the Node object, and the pod CIDR is assigned only after registration. `crid` therefore reports `ready` after step 8, serves `Version`, `Status`, `RuntimeConfig` and `ImageFsInfo` immediately, and holds `RunPodSandbox` with `UNAVAILABLE` (`waiting for pod CIDR`) until step 9 completes. `Status` reports the `NetworkReady` condition as false with reason `PodCIDRPending` in that window; kubelet keeps the node `NotReady`.

**`joinJson`** (from `fleet`) is JCS JSON:

```json
{"apiServer": "https://api.cluster.example:6443",
 "caBundle": "-----BEGIN CERTIFICATE-----…",
 "clusterName": "prod-eu-1",
 "nodeName": "node-17",
 "clusterDNS": ["10.96.0.10"], "clusterDomain": "cluster.local",
 "clusterCIDRs": ["10.244.0.0/16"], "serviceCIDRs": ["10.96.0.0/12"],
 "networkMode": "vxlan", "vxlan": {"vni": 4201, "port": 4789},
 "certificateLifetimeHours": 168,
 "bootstrapToken": "…"}
```

Fields not listed in §10.2 are ignored. `bootstrapToken` is not used by `cri` (kubelet never performs TLS bootstrapping) and is discarded. Cluster settings in `joinJson` override the corresponding local config values only when the local value is unset; a conflicting explicit local value fails the join with `kl:conflict`.

### 4.4 Credentials

#### 4.4.1 Credential set

| Credential | Role | CSR subject | Usage | Lifetime | Files |
|---|---|---|---|---|---|
| kubelet client | `kubelet` (EKU `clientAuth`) | `CN=system:node:<nodeName>, O=system:nodes` | kubelet → API server | `certificateLifetimeHours` (default 168) | `kubelet/pki/kubelet-client.{key,crt}` |
| kubelet serving | `kubelet` (EKU `serverAuth`, §2.5 N1) | `CN=system:node:<nodeName>, O=system:nodes`, SAN = node IPs and node name | API server → kubelet :10250 | same | `kubelet/pki/kubelet-serving.{key,crt}` |
| kube-proxy | `kube-proxy` | `CN=system:kube-proxy` | kube-proxy → API server | same | `kube-proxy/pki/kube-proxy.{key,crt}` |
| cri cluster credential | `cri` | `CN=system:keylos-cri:<nodeName>, O=system:keylos-cri` | `crid` watches (Pod, Node, NetworkPolicy, Namespace, Service, EndpointSlice) and drain | same | `pki/cri.{key,crt}` |

Files are relative to `/var/lib/keylos/cri/`. Keys are ECDSA P-256 generated with `rcgen` from OS randomness. The cluster administrator binds `system:keylos-cri` to the ClusterRole in §10.3.

#### 4.4.2 Renewal

- A timer fires at two thirds of the shortest remaining lifetime (REQ-CRI-073). It runs re-attestation (§4.3 step 5); on success it renews all four credentials. On failure it retries with exponential backoff (1 min to 30 min) and emits metric `cri_attestation_ok 0` and log level 3.
- New files are written with `O_TMPFILE` + `linkat` into place, then renamed over the old names in one directory sync.
- kubelet and kube-proxy load client certificates from the kubeconfig's `client-certificate`/`client-key` file paths. client-go reloads file-based client certificates when the files change. `crid` verifies the reload by checking, within 10 min of renewal, that the API server reports a kubelet connection with the new certificate serial (`Node.status` heartbeat via the cri credential: `crid` compares `Lease` renew times before and after). If the reload is not observed, `crid` logs level 2 and continues: the old certificate stays valid for one third of its lifetime, which is the documented maximum overlap.
- The kubelet serving certificate is reloaded by kubelet from `tlsCertFile`/`tlsPrivateKeyFile` on change (kubelet's dynamic serving certificate file watcher).

#### 4.4.3 Rendered component configuration

`crid` is the only writer of kubelet and kube-proxy configuration. The kubelet generation's service entry in `services.json` starts kubelet with exactly `--root-dir=/var/lib/keylos/cri/kubelet --config=/var/lib/keylos/cri/kubelet/config/kubelet.yaml --kubeconfig=/var/lib/keylos/cri/kubelet/config/kubeconfig --container-runtime-endpoint=unix:///run/keylos/cri/cri.sock`. `kubelet.yaml`:

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
# root directory: --root-dir=/var/lib/keylos/cri/kubelet (flag in the services.json entry)
podLogsDir: /var/lib/keylos/cri/logs
cgroupDriver: cgroupfs
cgroupsPerQOS: false
enforceNodeAllocatable: []
cgroupRoot: /
rotateCertificates: false
serverTLSBootstrap: false
tlsCertFile: /var/lib/keylos/cri/kubelet/pki/kubelet-serving.crt
tlsPrivateKeyFile: /var/lib/keylos/cri/kubelet/pki/kubelet-serving.key
authentication: {x509: {clientCAFile: /var/lib/keylos/cri/kubelet/pki/cluster-ca.crt}, webhook: {enabled: true}, anonymous: {enabled: false}}
authorization: {mode: Webhook}
clusterDNS: [<joinJson.clusterDNS>]
clusterDomain: <joinJson.clusterDomain>
maxPods: <cluster.maxPods>
staticPodPath: ""
featureGates: {PodAndContainerStatsFromCRI: true}
containerLogMaxSize: <cluster.logs.maxSize>
containerLogMaxFiles: <cluster.logs.maxFiles>
imageGCHighThresholdPercent: <cluster.images.gcHighPercent>
imageGCLowThresholdPercent: <cluster.images.gcLowPercent>
evictionHard: <cluster.eviction.hard>
runtimeRequestTimeout: 2m
address: <cluster-netns address of kubelet, §4.10.1>
port: 10250
readOnlyPort: 0
protectKernelDefaults: false
makeIPTablesUtilChains: false
```

`kube-proxy/config/kube-proxy.yaml` sets `mode: nftables`, `clusterCIDR`, `nodePortAddresses: [<cluster netns address>]`, `bindAddress` to the cluster netns address, `healthzBindAddress` and `metricsBindAddress` on the cluster netns address, and `conntrack` settings that do not write host sysctls (`maxPerCore: 0`, `min: 0`).

### 4.5 Sandbox lifecycle

```
                    RunPodSandbox
                         │
                         ▼
   ┌──────────────► admitting ──deny──► denied (terminal; RemovePodSandbox deletes record)
   │                 │      │
   │       approval  │      │ allow
   │                 ▼      ▼
   │     pending-approval   creating ──fail──► failed-create (resources undone; record kept 60 s)
   │        │   │               │
   │  denied│   │approved       ▼
   └────────┘   └─────────► ready ◄──── containers create/start/stop
                                │
                         StopPodSandbox
                                ▼
                            notready (VM stopped / processes killed; IP released after 60 s quarantine)
                                │
                         RemovePodSandbox
                                ▼
                             removed (record and storage deleted)
```

| State | CRI `PodSandboxState` | `CriAdmin.PodInfo.state` |
|---|---|---|
| admitting | — (call in progress) | `admitting` |
| pending-approval | — (calls fail with `UNAVAILABLE`) | `pending-approval` |
| creating | — | `admitting` |
| ready | `SANDBOX_READY` | `ready` |
| notready | `SANDBOX_NOTREADY` | `notready` |
| denied | — | `denied` |

**Creating** (both runtime classes, in order; each step journalled):

1. Allocate pod ID (`pod-` + ULID) and IP (§4.10.2).
2. Create cgroup slice `/keylos.slice/kube.slice/<pod-id>.slice` and write limits (§4.13).
3. Prepare volumes known from the admitted spec (§4.11): strata volumes, tmpfs volumes.
4. Network: tap (`keylos-vm`) or pod netns via `net` op `podNetns` (`keylos-sealed`) (§4.10).
5. `keylos-sealed`: root the pod's container generations `cri:pod:<pod-id>` (REQ-CRI-034).
6. Runtime-specific start: VM start (§4.7.3) or nothing (sealed pods have no process until the first container).
7. Write `pod.start` receipt; set state `ready`; return the pod ID.

**Stopping** (`StopPodSandbox`, idempotent): stop all containers with the grace period kubelet already applied (`StopContainer` timeouts), then for `keylos-vm` call `Vm.stop`, for `keylos-sealed` `PrincipalControl.terminate(session, kill)` for each container session; detach shares; release the tap (`keylos-vm`) or the pod netns (`clusterUplink` op `release`); mark the IP for release; write `pod.stop`.

**Removing** (`RemovePodSandbox`): requires `notready`; `Depot.unroot(gen, "cri:pod:<pod-id>")` for sealed pods; `StrataVolumes.release` for every emptyDir; delete tmpfs volume directories, the scratch disk and the per-pod image link directory; delete log files only when kubelet asks (kubelet removes pod log directories itself, `cri` owns the files' lifetime only for containers it removes); delete the sandbox record.

### 4.6 Admission

#### 4.6.1 Inputs

- The CRI `PodSandboxConfig` (metadata, labels, annotations, `linux.security_context`, `linux.sysctls`, `port_mappings`, `dns_config`, `runtime_handler`).
- The Pod object from the API server, matched by `metadata.uid`, at the `resourceVersion` observed by the watch. The Pod object is authoritative for containers, images, volumes and resources.

#### 4.6.2 Normalisation to `keylos.podspec/1`

`keylos-podspec` produces the Cedar `PodSpec` attributes (protocols §16.1) as JCS JSON. The algorithm is deterministic; its output digest (`specDigest`, SHA-256 of the JCS bytes) keys admission caching.

| Attribute | Derivation |
|---|---|
| `namespace`, `name` | Pod metadata |
| `runtimeClass` | CRI `runtime_handler`, empty → `keylos-vm` |
| `serviceAccount` | `spec.serviceAccountName` (default `default`) |
| `labels` | Pod labels as `key=value`, sorted |
| `images` | For each init, regular and ephemeral container: the image reference resolved to `oci:sha256:<manifest digest>` (§4.9.1); for `keylos-sealed`, `gen:fsv256:<container generation>` once converted. Unresolvable references (registry unreachable, credentials unknown at sandbox time) are recorded as `oci:unresolved:<reference>` and force re-admission at `CreateContainer` (§4.6.5) |
| `privileged` | any container `securityContext.privileged` |
| `hostNetwork`, `hostPID`, `hostIPC` | Pod spec fields, OR'd with the CRI `NamespaceOption` values (they MUST agree; disagreement is a validation error) |
| `hostPaths` | Paths of `hostPath` volumes; `hostPathsReadOnly` = every mount of every hostPath volume is read-only |
| `addedCapabilities` | Union of `securityContext.capabilities.add` across containers |
| `seccompProfile` | Pod-level or most permissive container-level type: `RuntimeDefault`, `Unconfined`, `Localhost`; absent → `RuntimeDefault` (keylos default) |
| `appArmorProfile` | Same rule; keylos ignores AppArmor content but records the request |
| `runAsRoot` | Any container whose effective `runAsUser` is 0 or unset with `runAsNonRoot != true` |
| `allowPrivilegeEscalation` | Any container with it unset or true and not `privileged=false` + `runAsNonRoot`: Kubernetes default (true) applies; keylos enforces `no_new_privs` regardless |
| `gpuPassthrough` | Sum of extended-resource requests `keylos.io/vfio-gpu` |
| `csiDrivers` | CSI volume driver names (inline CSI volumes and PVC-bound CSI PVs, resolved through the PV objects visible to the cri credential) |
| `volumeTypes` | Kubernetes volume source type names, sorted |
| `cpuMillis`, `memoryBytes` | Sum of container limits (or requests when no limit) plus init-container maxima, plus RuntimeClass overhead (§4.7.2) |

#### 4.6.3 Decision

```
admission = BrokerSystem.admitPod(podspecJson, runtimeClass)
if not admission.allowed and admission.approval == "":    → deny (reasons)
if admission.approval != "":                              → pending-approval
if runtimeClass == "keylos-sealed" and admission.tierFloor == 2: → deny ("policy requires keylos-vm")
else                                                      → allow
```

`cri` additionally enforces REQ-CRI-015 before calling the broker; a pod failing it is denied with reason `keylos:unsupported:<field>` and never reaches the broker.

Admission results are cached by `(uid, specDigest)` for the sandbox's lifetime; a new `attempt` of the same sandbox with the same digest reuses the decision.

#### 4.6.4 Pending approvals

- The sandbox record stays in `pending-approval` with the approval ID. `crid` polls nothing: it calls `admitPod` again on the next `RunPodSandbox` retry from kubelet (kubelet retries with back-off). The broker deduplicates by its own approval ID and returns `allowed = true` once approved.
- A pending approval expires after `cluster.admission.pendingTimeoutMinutes` (default 60). Expiry or a denial turns the record into `denied` and writes `pod.deny`.
- On `server-k8s` there is no `atrium`; approvals reach owners through `fleet` (`@orgApproval`) or paired phones (`@channels`). Policies for pods SHOULD avoid tier annotations unless an approval channel exists; otherwise every annotated pod waits until timeout.

#### 4.6.5 Container checks and re-admission

At `CreateContainer` the container config MUST satisfy, against the admitted spec:

| Check | Failure |
|---|---|
| The container name exists in the Pod object (or is an ephemeral container added through the API) | `INVALID_ARGUMENT` |
| The image digest (after `PullImage` resolution) is in `admitted.images` | re-admission |
| Security context no more permissive than admitted (privileged, capabilities, seccomp type, runAsUser 0) | re-admission |
| Every mount's volume exists in the admitted volume set | re-admission |
| Resource limits do not raise `cpuMillis`/`memoryBytes` above admitted | re-admission (and VM resize is not supported: `RESOURCE_EXHAUSTED` for `keylos-vm`) |

Re-admission recomputes the podspec from the current Pod object plus the container config, calls `admitPod`, and replaces the admitted spec when allowed. Ephemeral debug containers (`kubectl debug`) always go through re-admission.

### 4.7 Runtime class `keylos-vm`

#### 4.7.1 Pod bench-image

`io.keylos.bench.pod` (built by `pkgs` from this repo's `kl-podagent` plus a minimal guest kernel, `youki`, `mkfs.ext4`, NFS/iSCSI/RBD clients, `e2fsprogs`) contains:

```
/sbin/init → kl-podagent (PID 1 in the guest)
/usr/bin/youki
/usr/lib/kl-podagent/seccomp/runtime-default.json   (the CRI RuntimeDefault profile)
/etc/kl-podagent/…                                    static guest config
```

The guest has no shell login, no SSH and no package manager. `kl-podagent` speaks the repo-local protocol of §5.3 to `crid`.

#### 4.7.2 Sizing and warm pool

- `memoryMiB = roundUpToClass(podMemoryLimit + overheadMemory)` where `overheadMemory = cluster.vm.overheadMiB` (default 96) and classes are `{256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536}` MiB. A pod without a memory limit gets `cluster.vm.defaultMemoryMiB` (default 2048).
- `vcpus = clamp(ceil(podCpuLimitMillis / 1000), 1, cluster.vm.maxVcpus)`; without a CPU limit, `cluster.vm.defaultVcpus` (default 2).
- The RuntimeClass `overhead.podFixed` the administrator configures (§10.3) MUST equal `{memory: overheadMiB Mi, cpu: 100m}` so scheduler accounting matches.
- **Warm pool.** For each memory class listed in `cluster.vm.warmClasses` (default `[512, 1024, 2048]`), `crid` keeps `cluster.vm.warmPerClass` (default 2) booted-and-snapshotted VMs: it starts a VM, waits for `kl-podagent` `ready`, calls `Vm.snapshot("cri-warm-<class>-<imagegen>")` and stops it; `RunPodSandbox` starts from that snapshot (`VmSpec.fromSnapshot`). Snapshots are invalidated when the pod bench-image generation changes. vCPU count is set at restore when bench supports it; otherwise warm snapshots exist per (class, vcpus) for `vcpus ∈ {1, 2, 4}`.

#### 4.7.3 Starting the VM

```
tap = netctl.createTap(podId)                 # in the cri netns, attached to kl-cri0 (§4.10.3)
spec = VmSpec{
  image = podBenchImage, vcpus, memoryMiB, gpu = false,
  network = [],                                # bench-net uses the pod principal's tokens from VmSpawn.register (§2.5 N6)
  display = false, fromSnapshot = warm or "",
  tap = tap fd, tapConfig = {ifname: "eth0", mac, mtu}, podId,
  session = new, parentSession = crid session, principalKind = pod, purpose = pod,
  storeSet = [], unsignedImageOk = false,
  gpuPassthrough = <pci address if keylos.io/vfio-gpu allocated (§4.17)>,
  shares = [
    {name: "images", dir: O_PATH(/var/lib/keylos/cri/pods/<pod-id>/images), writable: false, overlay: false},
    {name: "logs",   dir: O_PATH(/var/lib/keylos/cri/logs/<ns>_<name>_<uid>), writable: true, overlay: false},
  ],
  blockDevices = [
    {device: "cri:scratch", fd: scratch.img fd (O_RDWR), readOnly: false},
    … block devices claimed for CSI node plugins (§4.18)
  ],
  bootArgs = [{key: "pod.egressViaGate", value: "true" | "false"}]}
vm = Bench.start(spec)
agent = vm.exec(["/sbin/kl-podagent", "--serve-stdio"], env=[], fds=[0←pipe, 1←pipe], tty=false)
agent.hello(podConfig)                          # §5.3: IP, gateway, DNS, hostname, sysctls, scratch device, volumes
```

`kl-podagent` formats `cri:scratch` as ext4 on first use (the file is created sparse with size `cluster.vm.scratchGiB`, default 20, or the pod's ephemeral-storage limit if smaller), mounts it at `/run/pod`, configures `eth0` from `podConfig` and reports `ready`.

`kl-podagent` runs as a guest daemon; the `--serve-stdio` process is a connection to it, so a new connection can be opened after a `crid` restart (`--attach`, §7.2). The VM session is recorded in the sandbox record for `Bench.reattach`. If the guest daemon exits, the sandbox becomes `notready` and every container `CONTAINER_EXITED` with reason `PodAgentExited`.

#### 4.7.4 Containers in the guest

For `CreateContainer`:
1. Ensure the image blob is linked into the pod's image directory (`link(2)` of `blobs/<digest>.erofs` to `pods/<pod-id>/images/<digest>.erofs`). The `images` share reflects the new file without a restart.
2. Send `CreateContainer` to `kl-podagent` with the OCI runtime config `crid` generated (§4.7.5) and the mount list.
3. `kl-podagent` mounts `/shares/images/<digest>.erofs` (file-backed EROFS, read-only) at `/run/pod/images/<digest>`, creates an overlay with upper and work under `/run/pod/c/<container-id>/`, and calls `youki create` with the bundle.

`StartContainer`, `StopContainer` (SIGTERM, grace, SIGKILL; executed by `kl-podagent` with timing from `crid`), `RemoveContainer`, `ExecSync`, `UpdateContainerResources` (CPU only; memory changes beyond the VM size fail with `RESOURCE_EXHAUSTED`) map directly to `kl-podagent` requests.

#### 4.7.5 OCI runtime configuration (guest)

`crid` generates the OCI `config.json` (runtime-spec 1.2) for `youki`:

| Field | Value |
|---|---|
| `process.user` | From CRI `run_as_user`/`run_as_group`/supplemental groups, resolved by `kl-podagent` against the image's `/etc/passwd` inside the guest when given by name |
| `process.capabilities` | The CRI default container set (`CAP_CHOWN`, `CAP_DAC_OVERRIDE`, `CAP_FSETID`, `CAP_FOWNER`, `CAP_MKNOD`, `CAP_NET_RAW`, `CAP_SETGID`, `CAP_SETUID`, `CAP_SETFCAP`, `CAP_SETPCAP`, `CAP_NET_BIND_SERVICE`, `CAP_SYS_CHROOT`, `CAP_KILL`, `CAP_AUDIT_WRITE`) minus `drop`; `add` never present (admission). These are guest capabilities; they confer nothing on the host |
| `process.noNewPrivileges` | true |
| `linux.seccomp` | `RuntimeDefault` profile shipped in the image |
| `linux.namespaces` | pid (shared per pod when `shareProcessNamespace`), mount, ipc (per pod), uts (per pod), network (the guest's single namespace), cgroup |
| `linux.resources` | From CRI `LinuxContainerResources` |
| `linux.maskedPaths`, `readonlyPaths` | Kubernetes defaults (CRI `masked_paths`, `readonly_paths`) |
| `root` | Overlay of the image blob mount, `readonly` per CRI |
| `mounts` | §4.11 mapping, guest paths |
| `hooks` | none |

#### 4.7.6 Logs, stdio and TTY in the guest

`kl-podagent` writes container stdout/stderr in CRI log format (`<RFC3339Nano> <stream> <P|F> <message>`) to `/shares/logs/<container>/<attempt>.log`, which is the kubelet-requested `log_path` on the host. `ReopenContainerLog` makes `kl-podagent` reopen the file. TTY containers write a single `stdout` stream.

### 4.8 Runtime class `keylos-sealed`

#### 4.8.1 Images

`PullImage` for a `keylos-sealed` pod (kubelet passes the sandbox config, so `crid` knows the runtime class) calls `Depot.install("oci+container://<registry>/<repo>@sha256:<manifest>")` on facet `cri` and then `Depot.root(gen, "cri:image:<digest>")`. The generation's identity follows protocols §21.4 (`oci-convert/1`); `cri` never computes it. The returned `GenerationInfo` MUST be `launchable`; otherwise `PullImage` fails with `PERMISSION_DENIED` and the `launchReasons` (for example `no-authorising-signature` when no org-publisher statement exists).

#### 4.8.2 Pod network and cgroups

At sandbox creation `crid` calls `clusterUplink` with op `podNetns` (§4.10.4) and the allocated IP; `net` creates the namespace with a veth attached to `kl-cri0` and returns the netns fd, which `crid` keeps for `PodContext.netns`. The slice `/keylos.slice/kube.slice/<pod-id>.slice` is created by `crid` in its delegated subtree.

#### 4.8.3 Spawning a container

```
ctx = PodContext{
  podId, namespace, name, uid,
  netns = pod netns fd, sharePid = spec.shareProcessNamespace,
  mounts = [PodMount{tree: GrantMounts.idmappedDir(dirFd, forPrincipal = <pod principal text>, readOnly), target, readOnly,
                    tmpfsBytes = size for configMap/secret/projected/downwardAPI/Memory emptyDir, else 0} …],
  cgroupParent = "/keylos.slice/kube.slice/<pod-id>.slice",
  seccomp = "runtime-default",
  readOnlyRoot = true,                         # always (protocols §21.8); warden adds tmpfs /tmp, /run, /var/tmp, /dev/shm
  runAsUid = effective run_as_user (default from container generation's config.user, else 65532)}
spec = SpawnSpec{
  generation = container generation, entrypoint = "main" (synthesised by depot from OCI entrypoint/cmd),
  argv = CRI command+args (override rules of the OCI image config), env = CRI envs (KEYLOS_* rejected),
  fds = [0 ← /dev/null or stdin pipe, 1 ← log pipe, 2 ← log pipe], grants = [], cwd = none (working dir from config),
  limits = from LinuxContainerResources, actorKind = pod}
process = PodSpawn.spawnContainer(spec, ctx)
shim = PodSpawn.egressShim(podId)             # once per pod, only with cluster.egressViaGate (§4.10.8)
```

- `crid` reads the log pipes and writes CRI-format log files (§4.15). The read ends are also stored in `FdStore` under `cri:log:<container-id>:{1,2}` so they survive a `crid` restart.
- Exit status comes from `Process.wait`. `StopContainer` sends SIGTERM via `Process.signal`, waits the timeout, then `Process.kill`.
- `ExecSync` and `Exec` call `PodSpawn.execInContainer(spec, containerSession)` with the container's generation and the exec command as argv: the process joins the container's mount, pid, net, ipc and uts namespaces and its cgroup, so it sees the container's tmpfs contents (REQ-CRI-033).
- Stats come from the container's cgroup files under the delegated `kube.slice` subtree (`cpu.stat`, `memory.stat`, `memory.current`, `io.stat`, `pids.current`).

### 4.9 Images

#### 4.9.1 Pull

- Registry client: `oci-client` with rustls, HTTPS only, except registries listed in `cluster.images.insecureRegistries` (default empty; plain HTTP is never used for any other registry).
- Credentials: from the CRI `AuthConfig` passed by kubelet (`username`/`password`, `auth`, `identity_token`, `registry_token`). They are used for the duration of the pull and never written to disk; only `secretsHash = SHA-256(JCS(sorted auth configs))` is stored (§4.9.5).
- Resolution: tag → manifest digest by a `HEAD`/`GET` on the manifest; a multi-platform index selects the node platform (`linux/amd64` or `linux/arm64`, variant from the CPU). The resolved digest is the image identity; `repoTags` and `repoDigests` are recorded for `ListImages`.
- Transport: `crid`'s own registry and API-server connections leave the cluster netns through the uplink NAT that `net` maintains. They do not pass through `gate`, also when `cluster.egressViaGate` is true; that setting applies to pod traffic only (§4.10.8). Registries reachable by `crid` are therefore bounded by `net`'s host firewall for the cluster uplink, not by gate grants.
- Limits: `cluster.images.maxCompressedBytes` (default 20 GiB) and `maxUncompressedBytes` (default 64 GiB) per image; at most `cluster.images.concurrentPulls` (default 3) pulls in parallel; layers are verified against their descriptor digests while streaming.

#### 4.9.2 keylos-sealed images

See §4.8.1. `crid` never stores sealed image content itself; `depot` owns it. `ListImages` reports container generations rooted by `cri:image:*` with `id = gen:fsv256:…` and the OCI digests from the generation manifest's `container` section. Running pods additionally hold `cri:pod:<pod-id>` roots (§2.5 N5).

#### 4.9.3 keylos-vm image blobs

A blob is a flattened EROFS image of the whole image filesystem:

```
crid:   spawn cri-unpack (Supervisor.spawn, entrypoint "unpack") with
          fd 3 = O_RDONLY layer files (decompressed or not) in order,
          fd 4 = O_WRONLY|O_CREAT output file in images/tmp/,
          argv = ["--layers", n, "--max-bytes", maxUncompressedBytes]
cri-unpack:
   for each layer: decompress (gzip | zstd | none) with size caps → tar stream
   merge layers in order applying OCI whiteouts (.wh.<name>, .wh..wh..opq) into an in-memory index (path → entry)
   emit one canonical tar stream (sorted paths, whiteouts resolved, ownership and modes kept, mtimes kept)
   pipe it into mkfs.erofs --tar=f -E^xattr-name-filter -T0 --all-root=0 -zlz4hc output
   exit 0 on success
crid:   enable fs-verity on the output, measure it, rename to images/blobs/<manifest digest>.erofs
```

- `cri-unpack` runs with the baseline seccomp profile, no network, a Landlock ruleset with no filesystem access (it works only on passed fds), `memory.max = 2 GiB`, `pids.max = 16`, and a wall-time limit of 30 min. `mkfs.erofs` (from `erofs-utils`, sealed in `pkgs`) is executed by `cri-unpack` from the `cri` generation.
- Path validation: entries with absolute paths, `..` components, NUL bytes, or names longer than 4096 bytes fail the conversion. Device nodes are dropped (the guest mounts with `nodev`). setuid/setgid bits are kept (they apply inside the guest only).
- The blob's fs-verity digest is recorded; `kl-podagent` re-checks it before mounting (the share is read-only, and the guest verifies to defend against host-side corruption).

#### 4.9.4 Garbage collection

kubelet drives image GC through `RemoveImage`. `crid` refuses to remove an image used by any container record (`FAILED_PRECONDITION`), removes the blob (or calls `Depot.unroot(gen, "cri:image:<digest>")`), and deletes the `images` row. `ImageFsInfo` reports the `images` subtree of `/var/lib/keylos/cri` (`keylos-vm`) and `depot`'s usage for rooted container generations (`keylos-sealed`) as two filesystems.

#### 4.9.5 Pull-credential verification

When `cluster.verifyPullCredentials` is true and an image is already present:

| Image pulled before with | Pod presents | Result |
|---|---|---|
| no credentials (public) | anything | served |
| credentials hash H for namespace N | same N and H | served |
| credentials | different namespace or hash | `crid` performs an authenticated manifest `HEAD` with the pod's credentials; on 200 the pod's `(N, H)` is added to `pulledBy` and the image is served; otherwise `PullImage` fails with `PERMISSION_DENIED` |

kubelet calls `PullImage` for `IfNotPresent` images only when `ImageStatus` reports absence, so `crid` reports a private image as absent to `ImageStatus` for a sandbox whose `(N, H)` is not in `pulledBy`. `ImageStatus` carries no sandbox; `crid` therefore applies this rule at `CreateContainer`: a container referencing a private image not pulled under its own `(N, H)` fails with `PERMISSION_DENIED` and reason `ErrImagePullCredentials`, and kubelet's next sync pulls it with credentials.

### 4.10 Networking

#### 4.10.1 Cluster netns layout

```
host netns (net)                    cri netns (net creates at start with kl-cri0; crid, kubelet, kube-proxy run inside)
──────────────────                  ───────────────────────────────────────────────────────────────
uplink kl-up0 ◄──── veth ──────►    kl-up1  169.254.42.2/30 (default route via 169.254.42.1)
  169.254.42.1/30                   kl-cri0  <podCIDR gateway>, e.g. 10.244.17.1/24
  DNAT node:10250 → kubelet          ├── tap-<id> (keylos-vm pods, one per pod VM)
  DNAT node:<nodePorts> → kl-cri0     └── veth-<id> (keylos-sealed pods, peer in pod netns)
  DNAT udp node:4789 → kl-up1       kl-vx0  VXLAN (networkMode vxlan), VNI from joinJson
  SNAT pod egress → node IP         nftables tables: inet kl-netpol, inet kl-egress, ip kube-proxy (owned by kube-proxy)
  routes: peer podCIDRs → kl-up1 (direct mode)
```

- kubelet listens on `169.254.42.2:10250` and on the bridge gateway address; `net` DNATs node IP:10250 to it from its `cluster.*` configuration (§2.5 N3).
- The streaming server (§4.14) listens on `169.254.42.2:10010`; kubelet reaches it inside the same netns.
- DNS for pods is CoreDNS (cluster workload); `clusterDNS` addresses are service IPs handled by kube-proxy.

#### 4.10.2 IPAM

- Pod CIDRs come from `Node.spec.podCIDRs` (IPv4 and optionally IPv6).
- Allocation is first-free above the gateway, persisted in the `ipam` table with fsync, with a 60 s quarantine after release (REQ-CRI-051).
- The gateway (`.1`) and broadcast addresses are reserved.

#### 4.10.3 Pod VM taps

`netctl.createTap(podId)` opens `/dev/net/tun`, `TUNSETIFF` (`IFF_TAP | IFF_NO_PI | IFF_VNET_HDR`, name `tap-<last 8 of pod-id>`), sets `TUNSETPERSIST` off, enslaves it to `kl-cri0`, sets MTU (`cluster.mtu`, default 1450 with VXLAN, 1500 direct) and returns the fd, which becomes `VmSpec.tap`. The MAC is `02:6b:` + 4 bytes derived from the pod IP. The tap disappears when the last fd closes (VM stop).

#### 4.10.4 Pod netns (keylos-sealed)

`crid` calls `NetPlumbingCluster.clusterUplink` with the protocols §21.5 object:

```json
{"schema": "keylos.cri.uplink/1", "op": "podNetns", "podId": "pod-…",
 "ip": "10.244.17.23", "mac": "02:6b:0a:f4:11:17", "mtu": 1450}
```

`net` creates the namespace and a veth pair whose pod end is `eth0` with the IP (prefix length and default route via the `kl-cri0` gateway taken from the pod CIDR of the last `uplink` object), attaches the other end to `kl-cri0`, and returns the pod netns fd. Namespaced sysctls from the Kubernetes safe set are applied by `warden` when the first container joins (`PodContext`), not by `net`. Releasing sends `{"schema":"keylos.cri.uplink/1","op":"release","podId":"pod-…"}`, which returns no fd (`Fd.index` 0xFFFF).

#### 4.10.5 Cross-node routing

| `networkMode` | Mechanism |
|---|---|
| `direct` | `crid` watches Node objects and sends `net` the set of `(peer node IP, peer podCIDRs)` routes in the uplink config (§4.10.7); `net` routes them in the host netns to the peer node IPs; the cluster netns default route covers them |
| `vxlan` | `crid` creates `kl-vx0` (VNI, UDP port from `joinJson`, `nolearning`) in the cluster netns, programs FDB entries (peer VTEP MAC derived from node IP → peer node IP) and routes `peer podCIDR via <peer VTEP IP> dev kl-vx0 onlink`; `net` DNATs inbound UDP to `kl-up1` and SNATs outbound VXLAN to the node IP |

Peer changes are applied within 2 s of a Node watch event.

#### 4.10.6 NetworkPolicy compiler

- Inputs: NetworkPolicy, Pod (labels, IPs, namespace), Namespace (labels) watches.
- Output: nftables table `inet kl-netpol` in the cluster netns, generated as a whole and applied atomically (one netlink batch), hooked at `forward` priority `filter - 10` on `kl-cri0` traffic (bridge traffic is routed, `br_netfilter` is not used: pods talk through the bridge at L2 only for ARP/ND; IP forwarding between bridge ports goes through the routing path because `crid` sets `proxy_arp` and per-port isolation (`isolated on`) on every tap and veth, so all inter-pod traffic is routed through `kl-cri0`'s IP and therefore hits the `forward` hook).
- Per selected pod: an ingress chain and an egress chain; peers compile to sets of IPs (`ipBlock` CIDRs minus `except`, pod selectors resolved to current pod IPs, namespace selectors), ports and protocols, named ports resolved per target pod.
- Kubernetes semantics: a pod is isolated for ingress/egress only if selected by at least one policy with that policy type; allowed traffic is the union; replies allowed via `ct state established,related`.
- Recompilation is debounced to 200 ms and bounded to p99 2 s end-to-end (REQ-CRI-052). The compiler is deterministic; the generated ruleset digest is exported as a metric.

#### 4.10.7 Uplink configuration

`crid` reconciles the uplink by calling `NetPlumbingCluster.clusterUplink` with the protocols §21.5 `uplink` object:

```json
{"schema": "keylos.cri.uplink/1", "op": "uplink",
 "podCidr": "10.244.17.0/24", "clusterCidrs": ["10.244.0.0/16"], "serviceCidr": "10.96.0.0/12",
 "mtu": 1450, "nat": true,
 "overlay": {"mode": "vxlan", "vni": 4201,
             "peers": [{"node": "node-18", "ip": "192.0.2.18", "podCidr": "10.244.18.0/24"}]}}
```

- `overlay.mode = "none"` with `peers` means direct routing: `net` routes each peer pod CIDR in the host netns to the peer node IP.
- `overlay.mode = "vxlan"`: `net` forwards the VXLAN UDP port between the host and `kl-up1` and SNATs outbound VXLAN to the node IP; `crid` itself creates `kl-vx0` and its FDB entries inside the cri netns (§4.10.5).
- Host-side exposures (kubelet 10250, NodePort range, kube-proxy healthz 10256) are `net` configuration (`cluster.expose`, defaults as listed), not part of this object (§2.5 N3).
- `net` returns the cri network namespace fd. The call is idempotent; `crid` re-sends the full object on any change (Node podCIDR assignment, peer changes).

#### 4.10.8 Egress via gate

With `cluster.egressViaGate = true`:

- **Host-side enforcement** (both runtime classes): `kl-egress` nftables rules in the cri netns drop pod traffic from taps and veths to destinations outside `clusterCidrs ∪ serviceCidr ∪ nodeIPs`, except the redirect below. With `egressViaGate = false`, such traffic is NATed by `net`.
- **`keylos-sealed`**: the rules redirect that TCP and UDP traffic to `cri-egress` (TPROXY on `169.254.42.2:15001`). `cri-egress` maps the source IP to the pod and uses the pod's `ShimEndpoint` from `PodSpawn.egressShim(podId)` (`connect` for TCP, `udpAssociate` for UDP, original destination as `NetTarget`, no tokens: the endpoint is bound to the pod's principals and gate evaluates the grants the broker attached from policy `cluster.egress`). It then splices bytes.
- **`keylos-vm`**: `kl-podagent` routes destinations outside the cluster CIDRs to the VM's `bench-net` device (boot argument `pod.egressViaGate`), which reaches gate through the VM's shim (§2.5 N6). Guest routing is not trusted: the host rule above drops anything the guest sends to those destinations through the tap.
- DNS names: `cri-egress` sees IPs only. Policies for pods therefore grant `net` rights by IP/CIDR, or pods use names resolved through `ShimEndpoint.resolve` by a CoreDNS forwarder configured by the administrator.
- A denied connect or a gate error closes the connection.

#### 4.10.9 kube-proxy

kube-proxy runs in the cluster netns in nftables mode and owns table `ip kube-proxy`/`ip6 kube-proxy`. `crid` never touches it. NodePort traffic arrives DNATed by `net` onto the cluster netns address and is handled by kube-proxy there.

### 4.11 Volumes

Every CRI `Mount` from kubelet carries a `host_path` under the kubelet root directory, the pod logs dir, or (hostPath volumes) an arbitrary host path. `crid` classifies it using the Pod object's volume list (the mount's `host_path` names `pods/<uid>/volumes/<plugin>/<volume-name>`):

| Volume type | keylos-vm | keylos-sealed |
|---|---|---|
| `emptyDir` (disk) | `StrataVolumes.create(podId, name, "emptyDir", sizeLimit)` → dir fd → `GrantMounts.idmappedDir` → `Vm.attachShare` `vol-<name>` (writable) | Same strata volume → `idmappedDir(forPrincipal = pod principal)` → `PodMount` |
| `emptyDir` (`Memory`) | Guest tmpfs created by `kl-podagent` with `size = sizeLimit` (counts against VM memory) | Empty directory → `idmappedDir` → `PodMount` with `tmpfsBytes = sizeLimit` (default `cluster.memoryEmptyDirMiB`); warden creates the tmpfs, so the size is enforced by the kernel |
| `secret`, `configMap`, `projected`, `downwardAPI` | kubelet writes the files under `<root-dir>/pods/<uid>/volumes/` with its atomic writer (§2.4); `crid` shares that directory read-only (`idmappedDir` → `attachShare`, read-only); updates propagate live | Same directory → `idmappedDir` → `PodMount` read-only with `tmpfsBytes` = the volume size rounded up to 1 MiB: warden copies the tree into a tmpfs at spawn. Updates reach the container at its next restart (§6.2) |
| `persistentVolumeClaim` → `local` PV | `StrataVolumes.create(podId, pvName, "local", capacity)` (kept until `release` on PV deletion) | same |
| `persistentVolumeClaim` → NFS / iSCSI / RBD / FC | Mounted inside the guest by `kl-podagent` (iSCSI/RBD/FC through block devices claimed with `MediaAttach.claimBlock` when local, or network transport through the pod's tap) | **Denied at admission** (`volumeTypes` contains a network type and runtime class is `keylos-sealed`) |
| CSI (PVC-bound or inline) | Node plugin runs in the same pod VM or a dedicated CSI pod VM (§4.18) | Denied at admission |
| `hostPath` | Allowed only per REQ-CRI-061: `crid` opens the path `O_PATH`, `idmappedDir(readOnly = true)` → read-only share | Same, read-only `PodMount` |
| `image` (OCI artifact volume) | Image blob linked into the pod's `images` share; mounted read-only by `kl-podagent` | `container` generation mounted by warden is not available for volumes; denied at admission |
| `subPath` / `subPathExpr` | Guest resolves `openat2(RESOLVE_BENEATH \| RESOLVE_NO_SYMLINKS)` inside the share and bind-mounts within the guest | `crid` opens the subpath with `openat2(RESOLVE_BENEATH \| RESOLVE_NO_SYMLINKS)` relative to the volume dir fd, then `idmappedDir` of that fd |

Strata volumes are owned on disk by the `_cluster` UID `0x0FFF0000` (REQ-CRI-088); containers see their own UIDs through the idmapped trees.

`crid` opens every directory as an `O_PATH` fd by walking from a held root (`/var/lib/keylos/cri/kubelet`, `/var/lib/keylos/cri`, or the `StrataVolumes` dir fd) with `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)`. A path that does not resolve this way fails `CreateContainer` with `INVALID_ARGUMENT`.

**Mount propagation**: `HostToContainer` and `Bidirectional` propagation are refused (`INVALID_ARGUMENT`); only `None` is supported.

### 4.12 Security contexts mapping (keylos-sealed)

| Kubernetes / CRI field | keylos-sealed behaviour |
|---|---|
| `runAsUser`, `runAsGroup`, `supplementalGroups`, `fsGroup` | `PodContext.runAsUid`; the container-visible UID is mapped through warden's per-pod mapping-only user namespace (idmapped rootfs and volumes). GIDs map in the same namespace. `fsGroup` ownership changes are applied by idmapping, never by `chown` |
| `readOnlyRootFilesystem` | Always effectively true: the root is read-only plus tmpfs at `/tmp`, `/run`, `/var/tmp`, `/dev/shm` (protocols §21.8, REQ-CRI-035) |
| `capabilities.drop` | Accepted (the container has no capabilities anyway) |
| `capabilities.add` | Refused (REQ-CRI-015) |
| `seccompProfile` | `RuntimeDefault` → `runtime-default`; others refused |
| `procMount: Unmasked` | Refused |
| `sysctls` | Safe namespaced set only, applied by `net` in the pod netns (network sysctls) or by warden (`kernel.shm*`, `kernel.msg*` in the IPC namespace) |
| `appArmorProfile`, `seLinuxOptions` | Ignored (recorded in the podspec; keylos confinement replaces them) |

### 4.13 Resources and cgroups

#### 4.13.1 Pod slices

| cgroup file | Value |
|---|---|
| `cpu.weight` | Kubernetes shares-to-weight conversion: `shares = max(2, cpuRequestMillis × 1024 / 1000)`, `weight = 1 + ((shares − 2) × 9999) / 262142` (integer arithmetic) |
| `cpu.max` | `limitMillis × 100 000 / 1000` and period `100000`, or `max` without a CPU limit |
| `memory.max` | Sum of container memory limits (+ VM overhead for `keylos-vm`), or `max` without limits |
| `memory.high` | `memory.max × cluster.memoryHighRatio` (default 0.9) when limited |
| `pids.max` | `cluster.podPidsLimit` (default 4096) |

For `keylos-vm` the slice contains the VM principal's scope: `bench` places the VMM and device processes under `/keylos.slice/kube.slice/<pod-id>.slice/vm.scope`, taking the pod ID from `VmSpec.podId` (protocols §7.3.13). Container-level limits are applied inside the guest by `youki`.

#### 4.13.2 Node allocatable

`crid` writes `/keylos.slice/kube.slice` `memory.max`/`cpu.max` = node capacity − `cluster.reserved.{memoryMiB, cpuMillis}` − eviction thresholds, and reports the same allocatable through `Status`'s runtime conditions and the kubelet configuration (`systemReserved` is rendered into `kubelet.yaml`).

#### 4.13.3 Ephemeral storage

`crid` polls every 30 s: `StrataVolumes.usage(podId)` (emptyDir), the guest-reported scratch usage (`keylos-vm`), and and container writable layer usage (`kl-podagent` for pod VMs; sealed containers have no writable layer, and their tmpfs usage is memory, reported through `memory.stat` `shmem`). Usage is reported through `ContainerStats.writable_layer` and `PodSandboxStats` so kubelet's eviction manager evicts over-limit pods with Kubernetes semantics.

### 4.14 Streaming server

- `Exec`, `Attach` and `PortForward` return URLs `http://169.254.42.2:10010/{exec,attach,portforward}/<token>`; tokens are 32 random bytes (base64url), single-use, valid 30 s, bound to the request (container ID, command, stdin/tty flags).
- The server implements the upstream streaming protocols kubelet proxies: SPDY/3.1 with `v4.channel.k8s.io`, `v5.channel.k8s.io` and WebSocket `v5.channel.k8s.io` for exec/attach; `portforward.k8s.io` for port-forward.
- Exec/attach for `keylos-vm` are forwarded to `kl-podagent` over a bench bulk stream; port-forward opens a TCP connection inside the guest network namespace to `localhost:<port>` (performed by `kl-podagent`).
- For `keylos-sealed`, exec calls `PodSpawn.execInContainer` (§4.8.3) with pipes or a pty pair allocated by `crid` (`/dev/ptmx` inside crid's view; the secondary end is passed as `SpawnSpec.terminal`); attach connects to the container's stdio pipes kept by `crid`; port-forward connects from `crid` (cluster netns) to the pod IP and port.
- The listener is reachable only inside the cluster netns; `net` does not expose port 10010.

### 4.15 Container logs

- Log path: `<podLogsDir>/<namespace>_<pod-name>_<uid>/<container-name>/<attempt>.log` as requested by kubelet in `ContainerConfig.log_path` relative to `PodSandboxConfig.log_directory`; `crid` refuses any path that does not resolve under `podLogsDir` (`openat2(RESOLVE_BENEATH)`).
- Format: CRI log format, lines split at 16 KiB into partial (`P`) records.
- `keylos-sealed`: `crid` reads the stdout/stderr pipes with 256 KiB buffers per container and writes records; back-pressure blocks the container's writes (pipe full), never drops data.
- `keylos-vm`: written by `kl-podagent` into the `logs` share.
- Rotation: kubelet renames and calls `ReopenContainerLog`; `crid` (or `kl-podagent`) reopens within 1 s.

### 4.16 Stats and metrics

| CRI field | keylos-sealed source | keylos-vm source |
|---|---|---|
| CPU usage (`usage_core_nano_seconds`, `usage_nano_cores`) | `cpu.stat usage_usec` of the container scope | guest cgroup via `kl-podagent`; pod total adds the VMM scope's `cpu.stat` |
| Memory (`working_set_bytes`, `usage_bytes`, `rss_bytes`, `page_faults`) | `memory.current`, `memory.stat` | guest values; pod total adds VMM RSS minus guest RAM |
| Writable layer | §4.13.3 | guest scratch accounting |
| Network (pod) | interface counters of the pod netns veth (host side, inverted) | tap counters (inverted) |
| Process count | `pids.current` | guest |

`ListMetricDescriptors`/`ListPodSandboxMetrics` export the cAdvisor-compatible metric set kubelet requests (`container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`, `container_network_*`, `container_fs_*`).

### 4.17 Device plugin (VFIO GPUs)

- `crid` registers with kubelet as a device plugin on `/var/lib/keylos/cri/kubelet/device-plugins/kubelet.sock` (it can open it: the kubelet root directory is under `/run/keylos/cri`), resource name `keylos.io/vfio-gpu`, devices = PCI addresses listed in config `devices.passthrough` that are GPUs.
- `Allocate` returns an empty container response (no device nodes, mounts or CDI devices) and `crid` records the allocated PCI addresses in its own allocation table. kubelet calls `Allocate` before `RunPodSandbox` for the pod's containers, and the device plugin API carries no pod UID, so `crid` binds allocations to sandboxes by matching the allocated device IDs against the Pod object's container resource requests at `RunPodSandbox` (the Pod object lists `keylos.io/vfio-gpu` requests; the oldest unbound allocation with the same device count is taken). `GetPreferredAllocation` is not implemented.
- The GPU is claimed with `MediaAttach.claimVfio(pci)` and passed as `VmSpec.gpuPassthrough`. Only `keylos-vm` pods can request it; admission sees `gpuPassthrough > 0`.
- Released with `MediaAttach.release` when the sandbox stops.

### 4.18 CSI

- A CSI driver is supported only when its image corresponds to a `container` generation declaring `needs.csi` (protocols §6.3), and it always runs in a `keylos-vm` pod VM. The driver image is pulled as an ordinary OCI image blob for the VM. The `container` generation is used only to establish the org-publisher signature: `crid` installs it through `depot` (`oci+container://` with the same manifest digest) and requires it to be launchable with `needs.csi.driver` equal to the driver name. A CSI driver pod whose image has no such generation is denied at `CreateContainer` with `PERMISSION_DENIED`.
- The node plugin's registration socket is a unix socket inside the guest; `kl-podagent` proxies it to a socket under `/var/lib/keylos/cri/kubelet/plugins_registry/<driver>-reg.sock` created by `crid` (`crid` holds the listening socket in its view; kubelet connects to it through its root directory).
- `NodeStageVolume`/`NodePublishVolume` from kubelet reach the plugin through that proxy. Staging and publishing paths in the requests are rewritten by `kl-podagent` into guest paths; the published volume is then exported to consuming pods in the same VM, or, for consuming pods in other VMs, the volume's block device is claimed by `crid` (`MediaAttach.claimBlock`) and attached to the consuming pod's VM (`VmSpec.blockDevices` at sandbox start, or `Vm.attachBlock` when the volume is published after the sandbox started; `Vm.detachBlock` at unpublish).

### 4.19 Receipts

| Event | When | Subject | `data` |
|---|---|---|---|
| `pod.admit` | Admission allowed (first time per `(uid, specDigest)`), and every re-admission | pod principal | `{podId, uid, namespace, name, runtimeClass, specDigest, images, policyIds, approval}` |
| `pod.deny` | Admission denied, pending approval expired, or REQ-CRI-015 refusal | `service:kubelet:<gen>@_system/<session>` | `{uid, namespace, name, runtimeClass, specDigest, reasons}` |
| `pod.start` | Sandbox `ready` | pod principal | `{podId, uid, runtimeClass, ip, vm: {memoryMiB, vcpus} or null}` |
| `pod.stop` | Sandbox stopped | pod principal | `{podId, uid, reason, durationSecs}` |

Pod principals have human `_cluster`, so these receipts are never sealed (protocols §13.4). Free text from the Pod object (names, labels) is included only in `data` and is cluster metadata, not personal data; the distribution's privacy notice covers it.

Repo-specific events (protocols §19.3 extension rule): `x-cri.attest` (`{result, pcrDigest, profile}`), `x-cri.cert.renew` (`{credential, serial, expires}`), `x-cri.image.pull` (`{digest, kind, bytes}`).

### 4.20 Drain

`CriAdmin.drain(reason)` uses the cri cluster credential: it marks the Node `unschedulable` (requires the RBAC verb `patch` on its own Node in the `keylos-cri-node` ClusterRole) and creates an Eviction for every pod bound to the node except mirror pods, respecting PodDisruptionBudgets (the API server enforces them); it returns when no evictable pods remain or after 10 min (then `kl:unavailable` with the remaining pod list).

---
## 5. Interfaces

### 5.1 CRI v1 RPC coverage (`cri#kubelet`)

All RPCs validate inputs (IDs must exist, names must be DNS-1123, paths must resolve under their roots) and return gRPC status codes as listed. `INVALID_ARGUMENT` is returned for malformed requests in every RPC and is not repeated below.

**RuntimeService**

| RPC | keylos-vm | keylos-sealed | Errors |
|---|---|---|---|
| `Version` | `runtime_name = "keylos-cri"`, `runtime_version` = crate version, `runtime_api_version = "v1"` | same | `FAILED_PRECONDITION` for an unsupported kubelet minor (§2.3) |
| `RunPodSandbox` | §4.5, §4.6, §4.7.3 | §4.5, §4.6, §4.8.2 | `PERMISSION_DENIED` (admission), `UNAVAILABLE` (pending approval, not attested, pod CIDR pending, Pod object not yet visible), `RESOURCE_EXHAUSTED` (VM sizing, IPs exhausted, VM cap) |
| `StopPodSandbox` | §4.5 | §4.5 | idempotent; unknown ID → OK (CRI semantics) |
| `RemovePodSandbox` | §4.5 | §4.5 | `FAILED_PRECONDITION` when not stopped; unknown ID → OK |
| `PodSandboxStatus` | state, IP(s), network namespace path empty (no host path is exposed), `runtime_handler`, `verbose` info = JSON `{podId, principal, vm: {...}}` | same with `netns: "keylos:pod-…"` | `NOT_FOUND` |
| `ListPodSandbox` | filters by ID, state, labels | same | — |
| `CreateContainer` | §4.6.5, §4.7.4 | §4.6.5, §4.8.3 (process is created stopped: `crid` keeps the spec and spawns at `StartContainer`) | `PERMISSION_DENIED`, `NOT_FOUND` (sandbox, image), `RESOURCE_EXHAUSTED` |
| `StartContainer` | `kl-podagent` start | `PodSpawn.spawnContainer` | `FAILED_PRECONDITION` if not created |
| `StopContainer` | SIGTERM, timeout, SIGKILL in guest | `Process.signal(15)`, timeout, `Process.kill` | idempotent |
| `RemoveContainer` | removes upper dir and state | removes state and the `FdStore` log-pipe entries | idempotent |
| `ListContainers` | filters by ID, state, sandbox, labels | same | — |
| `ContainerStatus` | exit code, reason, timestamps, image ref, mounts, log path, resources | same | `NOT_FOUND` |
| `UpdateContainerResources` | CPU in guest; memory only within VM size | cgroup files of the container scope | `RESOURCE_EXHAUSTED` |
| `ReopenContainerLog` | `kl-podagent` reopen | `crid` reopen | `FAILED_PRECONDITION` if not running |
| `ExecSync` | `kl-podagent` exec with timeout; output capped at 16 MiB (CRI limit) | `PodSpawn.execInContainer` (§4.8.3) | `DEADLINE_EXCEEDED` |
| `Exec`, `Attach`, `PortForward` | URLs per §4.14 | same | `NOT_FOUND` |
| `ContainerStats`, `ListContainerStats`, `PodSandboxStats`, `ListPodSandboxStats` | §4.16 | §4.16 | — |
| `UpdateRuntimeConfig` | accepts `network_config.pod_cidr` and checks it equals the Node's podCIDR; mismatch → `INVALID_ARGUMENT` | same | |
| `Status` | `RuntimeReady` (true when attested and the state DB is open), `NetworkReady` (true when pod CIDR known and the bridge is up); `verbose` = JSON `{attestation, kubeletGeneration, warmPool, featureLevel}` | same | |
| `RuntimeConfig` | `linux.cgroup_driver = CGROUPFS` | same | |
| `GetContainerEvents` | server stream of container lifecycle events (evented PLEG) | same | |
| `ListMetricDescriptors`, `ListPodSandboxMetrics` | §4.16 | §4.16 | |
| `CheckpointContainer` | — | — | `UNIMPLEMENTED` |
| `UpdatePodSandboxResources` (newer minors) | CPU only within VM size | slice limits | `UNIMPLEMENTED` on minors that lack it |
| any other | — | — | `UNIMPLEMENTED` |

**ImageService**

| RPC | Behaviour |
|---|---|
| `ListImages` | Blobs and rooted container generations (§4.9.2) |
| `ImageStatus` | `id` = manifest digest (blob) or `gen:fsv256:…` (generation); `size`; `pinned` for images in `cluster.images.pinned` |
| `PullImage` | §4.9.1; runtime class from `sandbox_config.runtime_handler` (empty sandbox config → `keylos-vm`) |
| `RemoveImage` | §4.9.4 |
| `ImageFsInfo` | Two `FilesystemUsage` entries (§4.9.4) and `container_filesystems` = the strata volume usage for writable layers |

### 5.2 `CriAdmin` (protocols §7.5.23)

| Method | Facet | Behaviour |
|---|---|---|
| `pods` | `admin`, `status` | Every sandbox record except `removed`, with `principals` (VM principal or container principals) and `admission` (the last `PodAdmission` as JSON) |
| `node` | `admin`, `status` | JSON `{nodeName, kubeletVersion, supportedMinors, runtimeClasses, attestation: {state, at, profile, pcrDigest}, certificates: [{credential, notAfter}], capacity: {cpu, memoryMiB, pods}, allocatable, warmPool: {class: count}, networkMode, podCIDRs}` |
| `drain` | `admin` | §4.20 |
| `images` | `admin`, `status` | JSON list of images with kind, size, last use, `pulledBy` count (never credentials) |

### 5.3 Repo-local: `podagent.capnp` (crid ↔ kl-podagent)

`crid` and `kl-podagent` are both built from this repository; this protocol is repo-local (protocols §1). It runs as Cap'n Proto RPC over the `kl-podagent` stdio pipes created by `Vm.exec` (no fds). Bulk streams (exec/attach/port-forward data) use bench bulk vsock streams announced in messages per the capwire-vsock profile (protocols §7.2.1).

```capnp
@0x8c3d5e7f9a1b2c41;   # repo-local; outside the reserved 0xc7a1e5d3b2f4xxxx range

struct PodConfig {
  podId      @0 :Text;
  hostname   @1 :Text;
  ip         @2 :Text;           # CIDR
  gateway    @3 :Text;
  mtu        @4 :UInt16;
  mac        @5 :Text;
  dns        @6 :Text;           # resolv.conf content generated by crid from CRI DNSConfig
  sysctls    @7 :List(KV);
  scratchDev @8 :Text;           # guest block device name of cri:scratch
  scratchFresh @9 :Bool;         # format on first use
  shareProcessNamespace @10 :Bool;
  struct KV { key @0 :Text; value @1 :Text; }
}

struct GuestMount {
  source   @0 :Text;             # "share:<name>[/<subpath>]" | "tmpfs:<sizeBytes>" | "blob:<digest>" | "nfs:<server>:<export>" | "block:<device>" | "csi:<driver>:<volumeId>"
  target   @1 :Text;             # container path
  readOnly @2 :Bool;
  options  @3 :List(Text);
}

struct ContainerSpec {
  id          @0 :Text;
  name        @1 :Text;
  imageDigest @2 :Text;          # blob mounted from share "images"
  ociConfig   @3 :Data;          # runtime-spec 1.2 config.json generated by crid (§4.7.5)
  mounts      @4 :List(GuestMount);
  logPath     @5 :Text;          # path inside share "logs"
  tty         @6 :Bool;
  stdin       @7 :Bool;
  stdinOnce   @8 :Bool;
}

struct GuestStats {
  containers @0 :List(CStat);
  scratchUsedBytes @1 :UInt64;
  struct CStat { id @0 :Text; cpuUsec @1 :UInt64; memWorkingSet @2 :UInt64; memUsage @3 :UInt64;
                 rss @4 :UInt64; pageFaults @5 :UInt64; writableBytes @6 :UInt64; pids @7 :UInt32; }
}

struct ContainerEvent {
  id    @0 :Text;
  union { started @1 :Void; exited @2 :Int32; oomKilled @3 :Void; }
  time  @4 :Int64;
}

interface PodAgent {
  hello     @0 (config :PodConfig) -> (agentVersion :Text, kernel :Text);       # must be first; ready when it returns
  create    @1 (spec :ContainerSpec) -> ();
  start     @2 (id :Text) -> ();
  stop      @3 (id :Text, signal :Int32, timeoutSecs :UInt32) -> (exitCode :Int32);
  remove    @4 (id :Text) -> ();
  execSync  @5 (id :Text, argv :List(Text), timeoutSecs :UInt32) -> (stdout :Data, stderr :Data, exitCode :Int32);
  exec      @6 (id :Text, argv :List(Text), tty :Bool, stdin :Bool, streamPort :UInt16) -> (exitCode :Int32);
  attach    @7 (id :Text, stdin :Bool, streamPort :UInt16) -> ();
  portForward @8 (port :UInt16, streamPort :UInt16) -> ();
  resize    @9 (id :Text, cols :UInt16, rows :UInt16) -> ();
  reopenLog @10 (id :Text) -> ();
  update    @11 (id :Text, cpuQuotaUsec :Int64, cpuPeriodUsec :UInt64, cpuWeight :UInt16) -> ();
  stats     @12 () -> (stats :GuestStats);
  events    @13 (watcher :EventWatcher) -> ();
  mountVolume @14 (name :Text, mount :GuestMount) -> ();    # network volumes, CSI publish
  csiProxy  @15 (driver :Text, streamPort :UInt16) -> ();   # proxies the plugin registration and node sockets
}

interface EventWatcher { event @0 (event :ContainerEvent) -> stream; }
```

`kl-podagent` rejects any request before `hello`, any `GuestMount.source` with `..` components, and any `ociConfig` that sets `linux.namespaces` path entries, `linux.devices` outside the default set, or hooks.

### 5.4 Repo-local: `cri-ctl` CLI schema

`cri-ctl` uses `CriAdmin` directly; it has no repo-local capwire interface. Its command signatures ship as `/.keylos/cmdsig/cri-ctl.json` in the `io.keylos.cri-ctl` generation.

### 5.5 CLI: `cri-ctl`

```
cri-ctl [--format text|json|records] <command>

  pods [--state STATE] [--namespace NS]         list sandboxes (records: podId, namespace, name, runtimeClass, state, ip, age)
  pod <pod-id|namespace/name>                   show one sandbox: admission reasons, principals, containers, volumes, VM sizing
  node                                          node status (CriAdmin.node)
  images [--kind blob|generation]               cached images
  drain [--reason TEXT] [--yes]                 cordon and evict (facet admin; asks for confirmation unless --yes)
  attest                                        show last attestation result and PCR digest (from node)
  version                                       crid and supported Kubernetes minors
```

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 1 | Partial (for example `drain` timed out with pods remaining) |
| 2 | Usage error |
| 3 | `kl:denied` (route or facet missing) |
| 4 | `kl:unavailable` (cri not running or not attested) |
| 5 | Other `kl:` error |

### 5.6 Files, sockets and ports

| Resource | Owner | Notes |
|---|---|---|
| `/run/keylos/cri/cri.sock` (inside kubelet's view) | warden binds the route's stream socket here for kubelet | crid never sees the path |
| `/var/lib/keylos/cri/**`, `/run/keylos/cri/**` | crid | §4.2 |
| `/sys/fs/cgroup/keylos.slice/kube.slice/**` | crid (delegated subtree, rw) | kubelet read-only |
| `169.254.42.2:10010/tcp` (cluster netns) | crid streaming server | not exposed outside the cluster netns |
| `169.254.42.2:15001/tcp+udp` (cluster netns) | `cri-egress` TPROXY | only with `egressViaGate` |
| `169.254.42.2:10250/tcp` | kubelet | DNATed from node IPs by net |
| `169.254.42.2:10256/tcp` | kube-proxy healthz | DNATed from node IPs by net |
| `/dev/net/tun` | crid (device privilege) | taps |
| `/dev/tpmrm0` | crid (device privilege) | AK quotes |
| `/sys/kernel/security/tpm0/binary_bios_measurements` | crid (read-only) | event log |

### 5.7 Consumed interfaces (method level)

| Interface | Methods used | Notes |
|---|---|---|
| `Bootstrap` / `ServiceHost` | `host`, `ready`, `watchdog`, `status`; `accept`, `stop`, `reload` | `reload`: re-read `/etc/keylos/cluster.json` (§10.1) |
| `FdStore` | `put`, `take`, `drop` | Log-pipe read ends (§7.2) |
| `Supervisor` (facet `service`) | `spawn` (`cri-unpack`), `identify` | |
| `PodSpawn` | `spawnContainer`, `execInContainer`, `egressShim` | |
| `GrantMounts` (facet `cri`) | `idmappedDir` | |
| `PrincipalControl` (facet `cri`) | `terminate`, `events` (with `replay = true` at startup) | Pod sessions only |
| `Process` | `wait`, `signal`, `kill`, `freeze`, `thaw`, `confinement` | |
| `BrokerSystem` (facet `system`) | `admitPod` | |
| `Bench` (facet `cri`) | `start`, `reattach` | |
| `Vm` | `exec`, `stop`, `snapshot`, `attachShare`, `detachShare`, `attachBlock`, `detachBlock`, `info` | `console` is never used |
| `Depot` (facet `cri`) | `install`, `get`, `list`, `root`, `unroot` | |
| `StrataVolumes` | `create`, `release`, `usage` | |
| `NetPlumbingCluster` | `clusterUplink` (ops `uplink`, `podNetns`, `release`) | §4.10.4, §4.10.7 |
| `MediaAttach` | `claimBlock`, `claimVfio`, `release` | |
| `FleetCluster` | `joinChallenge`, `joinAttested`, `clusterCertificate` | |
| `Ledger` (facet `writer`) | `append` | |
| `ShimEndpoint` (from `PodSpawn.egressShim`) | `connect`, `udpAssociate`, `resolve` | §4.10.8 |

---
## 6. Security

### 6.1 Threats and mitigations

| # | Threat | Mitigation |
|---|---|---|
| T1 | A cluster administrator or compromised API server schedules a pod that tries to reach the host (privileged, hostPath, host namespaces, capabilities) | REQ-CRI-015 refuses these regardless of policy; Cedar `admit` forbids (protocols §16.1); `keylos-sealed` containers are t1 principals with `runtime-default` seccomp, no capabilities, kl-exec allowing only the container generation; `keylos-vm` pods are VMs |
| T2 | A compromised `kubelet` (upstream Go code) | kubelet has no root, no capabilities, no mount syscalls, no routes except `cri#kubelet`; everything it asks for passes admission; it cannot spawn processes on the host except through CRI, and CRI containers are confined as above |
| T3 | A malicious OCI image exploits the image unpacker (tar bombs, path traversal, decompression bugs) | Parsing only in `cri-unpack` (no filesystem access except passed fds, no network, memory and time caps); output is one EROFS file; size caps; path validation; `mkfs.erofs` runs confined |
| T4 | A malicious image or container in `keylos-vm` attacks the host kernel | Guest kernel boundary (crosvm with sandboxed device processes); network only through the tap into the cluster netns, which has no route to host services; no vsock ports beyond bench control |
| T5 | Pod traffic attacks host services | The cluster netns is separate; `net` drops traffic from the cluster netns to the host except NAT egress and listed DNAT exposures (REQ-CRI-053); pods have no capwire routes (REQ-CRI-055) |
| T6 | Cross-pod attacks on the bridge (ARP spoofing, MAC/IP spoofing) | Port isolation on every tap/veth, all inter-pod traffic routed through `kl-cri0`'s IP (§4.10.6); nftables anti-spoofing rule per port: source IP must equal the pod's IP (and MAC for taps) |
| T7 | Image cache leaks private images across namespaces | §4.9.5 pull-credential verification; per-pod image link directories so a VM sees only its own images |
| T8 | Replay of an old attestation, or a tampered node joining | Quote bound to a single-use `joinChallenge` and the machine key; fleet verifies against the release log; re-attestation every 6 h and before renewals; a failed attestation stops credentials (REQ-CRI-072) |
| T9 | Stolen node credentials | Keys only under `/var/lib/keylos/cri` on the AEAD-encrypted root; short lifetimes (default 7 days); the node authorizer restricts them; the cri credential's RBAC (§10.3) has no write access except its own Node and evictions |
| T10 | Exec/attach hijacking through the streaming server | Single-use 32-byte tokens, 30 s validity, bound to the request; listener only in the cluster netns; kubelet authenticates the API server's request before asking `crid` for a URL |
| T11 | Approval spam (pods with annotated permits) | Pending approvals deduplicated by `(uid, specDigest)`; at most `cluster.admission.maxPending` (default 32) pending sandboxes; beyond that, new annotated pods are denied with reason `too-many-pending` |
| T12 | A pod-VM guest forging stats or events to cause wrong evictions | Stats from the guest affect only its own pod; VM-level limits are enforced on the host by cgroups regardless of guest reports |

### 6.2 Residual risks

- Kubernetes secrets are written by kubelet under `/var/lib/keylos/cri/kubelet/pods/` (protocols §21.1), on the AEAD-encrypted root, and are deleted with the pod. A full compromise of `kubelet` or `crid` reveals every secret volume on the node.
- In `keylos-sealed`, configMap and secret updates reach a container only when it restarts, because warden copies the tree into a tmpfs at spawn (§4.11). `crid` is tier-0 Rust code with no routes to user data, which limits but does not remove this.
- `keylos-sealed` containers share the host kernel; their kernel attack surface is the `runtime-default` seccomp profile plus baseline-1. Policy SHOULD restrict `keylos-sealed` to vetted org-publisher images.
- `egressViaGate` sees IPs, not host names, for pod traffic (§4.10.8).
- NetworkPolicy convergence is eventually consistent (p99 2 s); during that window, newly started pods may be reachable before their policy applies. `crid` mitigates for selected pods by installing a default-deny rule for a new pod IP before the sandbox becomes `ready` when any policy in the namespace selects it.

### 6.3 Confinement of `crid`

| Aspect | Setting |
|---|---|
| Tier | t0 |
| Network | cri network namespace (`services.json` `network: "cluster"`); `CAP_NET_ADMIN` and `CAP_NET_RAW` effective only there |
| Capabilities | `CAP_NET_ADMIN`, `CAP_NET_RAW` (bridge, taps, nftables, VXLAN, anti-spoofing). No others |
| Devices | `/dev/net/tun` (rw), `/dev/tpmrm0` (rw) |
| seccomp | `baseline-1` (no additional syscalls; `ioctl` for `TUNSETIFF`, `TUNSETOFFLOAD`, `TUNSETVNETHDRSZ` is within baseline) |
| Landlock | rw: `/var/lib/keylos/cri`, `/run/keylos/cri`, `/sys/fs/cgroup/keylos.slice/kube.slice`; ro: `/sys/kernel/security/tpm0/binary_bios_measurements`, `/etc/keylos/cluster.json`, `/proc/self`; network rules: TCP connect to any (registries, API server) through the cluster netns NAT; bind `169.254.42.2:10010`, `:15001` |
| Routes | §2.2 |
| BPF | none |
| `services.json` entry | §10.4 |

### 6.4 Confinement of helpers and peers configured by this repo

| Process | Confinement |
|---|---|
| `cri-unpack` | t0 helper, no network namespace interfaces except `lo`, Landlock with no filesystem rights (fd-only), baseline-1, `memory.max` 2 GiB, `pids.max` 16, 30 min wall time |
| `kubelet` | t1 service, no capabilities, baseline-1, cri netns, Landlock rw `/var/lib/keylos/cri/kubelet/{pods,plugins,plugins_registry,device-plugins,state}`, `/var/lib/keylos/cri/logs`; ro `/var/lib/keylos/cri/kubelet/{config,pki}`, `/sys/fs/cgroup/keylos.slice/kube.slice`, node-level `/proc` and `/sys` entries listed in §10.4 |
| `kube-proxy` | t1 service, `CAP_NET_ADMIN` (cri netns), baseline-1, Landlock ro `/var/lib/keylos/cri/kube-proxy` |
| `kl-podagent` | Guest PID 1 in the pod VM; it is part of the VM principal and has no host authority |

---

## 7. Failure modes and recovery

### 7.1 Component failures

| Failure | Detection | Behaviour |
|---|---|---|
| kubelet restarts | stream socket closes | No effect on pods; kubelet resyncs with `ListPodSandbox`/`ListContainers` |
| `broker` unavailable | `admitPod` error `kl:unavailable` | `RunPodSandbox` and re-admissions fail `UNAVAILABLE`; running pods continue |
| `bench` unavailable | `Bench.start` error | `RunPodSandbox` for `keylos-vm` fails `UNAVAILABLE` |
| `bench` restarts | `Vm` capabilities disconnect | All pod VMs are gone (a bench restart stops every VM, protocols §7.3.13); their sandboxes become `notready`, containers `CONTAINER_EXITED` with reason `RuntimeRestart`; kubelet recreates them |
| `depot` unavailable | install error | `PullImage` for `keylos-sealed` fails `UNAVAILABLE` |
| `strata` unavailable | `StrataVolumes` error | Sandboxes needing emptyDir/local volumes fail `UNAVAILABLE`; usage polling pauses (no evictions on stale data) |
| `net` unavailable | `clusterUplink` error | At startup: `crid` retries with back-off and stays not-ready. At runtime: peer route updates queue; sealed pods cannot get netns (`UNAVAILABLE`) |
| `fleet` unavailable | join/renew error | At startup: not ready; at runtime: renewals retry; credentials keep working until expiry |
| `ledger` unavailable | append error | State-changing CRI calls fail `UNAVAILABLE` (REQ-CRI-082); stops and removals proceed and their receipts are spooled in `ops` and appended when `ledger` returns |
| API server unreachable | watch errors | Admission of new pods fails `UNAVAILABLE` (no Pod object); NetworkPolicy state is frozen at the last observed state; running pods continue |
| `kl-podagent` crash | agent `Process.wait` returns | Sandbox `notready`, containers exited; kubelet recreates |
| Image conversion fails | `cri-unpack` exit ≠ 0 | `PullImage` fails `INVALID_ARGUMENT` (format) or `RESOURCE_EXHAUSTED` (caps); temporary files deleted |
| Disk full under `/var/lib/keylos/cri` | `ENOSPC` | `PullImage` fails `RESOURCE_EXHAUSTED`; kubelet image GC runs; logs keep writing until the log rotation threshold |

### 7.2 `crid` restart

A `crid` restart does not restart pods (REQ-CRI-087). Pod VMs outlive their `Vm` capability (§2.5 N2), sealed containers are warden principals, and the log pipes are kept in `FdStore`. On start (§4.3 step 2):

1. Replay the `ops` journal: undo partially created sandboxes (release IPs, taps, strata volumes, pod netns with op `release`, `cri:pod:` roots).
2. `keylos-vm`: for each sandbox recorded `ready`, call `Bench.reattach(vmSession)`. On success open a new agent connection with `vm.exec(["/sbin/kl-podagent", "--attach"])` and resynchronise container states with the agent. On `kl:not-found` (the VM stopped while `crid` was down), mark the sandbox `notready` with reason `RuntimeRestart`.
3. `keylos-sealed`: call `PrincipalControl.events(…, replay = true)`. Running pod sessions are replayed first; container records whose session is running stay `running`, all others become `exited`. Log-pipe read ends are recovered with `FdStore.take("cri:log:<container-id>:{1,2}")`; a missing entry means the pipe was lost, the container's later writes fail with `EPIPE`, and `crid` restarts that container (kubelet sees `CONTAINER_EXITED`, reason `LogPipeLost`).
4. The tap fds belong to bench's VMM processes and the pod netns fds are re-obtained from `net` with op `podNetns` for the same `podId` (idempotent in `net`); no network state is rebuilt.
5. IPAM reservations of sandboxes that did not survive are kept for 60 s, as for any release.

A `bench` restart, by contrast, stops every pod VM (§7.1).

### 7.3 Node reboot

On boot, all sandboxes are `notready`; `crid` clears VM-related state, keeps strata `local` volumes, and kubelet recreates pods. Pod IPs may change.

### 7.4 Attestation failure

The node keeps running existing pods while credentials are valid. `Status` reports `RuntimeReady=false` with reason `AttestationFailed` once credentials expire, so the control plane marks the node `NotReady` and reschedules pods. Recovery is a successful re-attestation (for example after the owner approves the firmware change through the normal update flow).

---

## 8. Performance budgets

Measured on the reference `server-k8s` machine (16 cores, 64 GiB, NVMe) at KL2.

| Operation | p50 | p99 |
|---|---|---|
| `RunPodSandbox`, `keylos-vm`, warm pool hit | 250 ms | 600 ms |
| `RunPodSandbox`, `keylos-vm`, cold | 900 ms | 2 s |
| `RunPodSandbox`, `keylos-sealed` | 80 ms | 250 ms |
| `CreateContainer` + `StartContainer` (image present), `keylos-vm` | 120 ms | 400 ms |
| `CreateContainer` + `StartContainer`, `keylos-sealed` | 60 ms | 200 ms |
| Admission round trip (`admitPod`, cached policy) | 3 ms | 15 ms |
| `ExecSync` overhead (empty command) | 20 ms | 60 ms |
| `ListContainers` with 250 pods / 750 containers | 3 ms | 10 ms |
| Image blob conversion throughput | ≥ 200 MB/s uncompressed | |
| NetworkPolicy change to enforcement | 300 ms | 2 s |
| Peer node route change to enforcement | 300 ms | 2 s |

| Resource | Budget |
|---|---|
| `crid` RSS (250 pods) | ≤ 256 MiB |
| Host overhead per `keylos-vm` pod (VMM + device processes, excluding guest RAM) | ≤ 40 MiB |
| Pod density, `keylos-vm`, 512 MiB class | ≥ 100 pods on 64 GiB |
| Pod density, `keylos-sealed` | kubelet `maxPods` (default 110) |
| Unplanned `crid` restarts | ≤ 1 per node per 30 days |

---

## 9. Observability

### 9.1 Logs

Structured records (protocols §10.6) with fields `podId`, `uid`, `namespace`, `name`, `containerId`, `rpc`, `code`. Levels: 3 for admission denials and attestation failures, 4 for RPC errors, 6 for lifecycle transitions, 7 for RPC traces (off by default). Secrets, credentials and environment values never appear in logs.

### 9.2 Receipts

`pod.admit`, `pod.deny`, `pod.start`, `pod.stop` (core, §4.19); `x-cri.attest`, `x-cri.cert.renew`, `x-cri.image.pull` (repo-specific).

### 9.3 Metrics (records with first byte `0x1F`, protocols §10.6)

| Metric | Type | Labels |
|---|---|---|
| `cri_rpc_duration_seconds` | histogram | `rpc`, `code` |
| `cri_pods` | gauge | `runtime_class`, `state` |
| `cri_containers` | gauge | `runtime_class`, `state` |
| `cri_admission_total` | counter | `result` (`allow`, `deny`, `pending`, `unsupported`), `runtime_class` |
| `cri_sandbox_start_seconds` | histogram | `runtime_class`, `warm` |
| `cri_warm_pool` | gauge | `class` |
| `cri_image_pull_bytes_total` | counter | `kind` |
| `cri_image_convert_seconds` | histogram | |
| `cri_netpol_rules` | gauge | |
| `cri_netpol_apply_seconds` | histogram | |
| `cri_attestation_ok` | gauge | |
| `cri_certificate_expiry_seconds` | gauge | `credential` |
| `cri_pending_approvals` | gauge | |
| `cri_egress_connections_total` | counter | `result` |

---
## 10. Configuration

### 10.1 Delivery

The `config` repo renders the Nickel module `keylos.cluster` (shipped by this repository) into `/etc/keylos/cluster.json` in the config generation. Only `crid` reads it. On `ServiceHost.reload`, `crid` re-reads the file; changes to network addressing (`mtu`, `networkMode`) apply to new pods only, and changes to `egressViaGate` apply to new connections.

### 10.2 Nickel schema (`keylos.cluster`)

```nickel
{
  cluster | {
    enable | Bool | default = false,                       # true only on the server-k8s profile
    nodeName | String | optional,                          # default: joinJson.nodeName
    podBenchImage | String | default = "io.keylos.bench.pod",
    networkMode | [| 'direct, 'vxlan |] | optional,        # default: joinJson.networkMode
    mtu | Number | optional,                               # default 1450 (vxlan) / 1500 (direct)
    egressViaGate | Bool | default = false,
    hostPathAllowlist | Array String | default = [],       # read-only only
    verifyPullCredentials | Bool | default = true,
    maxPods | Number | default = 110,
    podPidsLimit | Number | default = 4096,
    memoryHighRatio | Number | default = 0.9,
    memoryEmptyDirMiB | Number | default = 64,             # tmpfsBytes for Memory emptyDir without sizeLimit (keylos-sealed)
    expose | Array { proto | String, port | Number | optional, portRange | String | optional } | optional,   # read by net (host-side DNAT), §2.5 N3
    podCIDRWaitSecs | Number | default = 120,
    reattestHours | Number | default = 6,
    reserved | { memoryMiB | Number | default = 2048, cpuMillis | Number | default = 1000 },
    eviction | { hard | { _ : String } | default = { "memory.available" = "500Mi", "nodefs.available" = "10%", "imagefs.available" = "15%" } },
    logs | { maxSize | String | default = "10Mi", maxFiles | Number | default = 5 },
    admission | {
      pendingTimeoutMinutes | Number | default = 60,
      maxPending | Number | default = 32,
    },
    images | {
      insecureRegistries | Array String | default = [],
      pinned | Array String | default = [],
      maxCompressedBytes | Number | default = 21474836480,
      maxUncompressedBytes | Number | default = 68719476736,
      concurrentPulls | Number | default = 3,
      gcHighPercent | Number | default = 85,
      gcLowPercent | Number | default = 80,
    },
    vm | {
      overheadMiB | Number | default = 96,
      defaultMemoryMiB | Number | default = 2048,
      defaultVcpus | Number | default = 2,
      maxMemoryMiB | Number | default = 65536,
      maxVcpus | Number | default = 16,
      scratchGiB | Number | default = 20,
      warmClasses | Array Number | default = [512, 1024, 2048],
      warmPerClass | Number | default = 2,
    },
  },
}
```

Validation (config compile time): `enable = true` requires profile `server-k8s`; `warmClasses` values must be memory classes from §4.7.2; `hostPathAllowlist` entries must be absolute, normalised, and outside `/keystore`, `/store`, `/var/lib/keylos`, `/run/keylos`, `/etc/keylos` and `/home`.

### 10.3 Cluster-side objects (administrator templates)

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata: {name: keylos-vm}
handler: keylos-vm
overhead: {podFixed: {memory: "96Mi", cpu: "100m"}}
scheduling: {nodeSelector: {keylos.io/node: "true"}}
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata: {name: keylos-sealed}
handler: keylos-sealed
scheduling: {nodeSelector: {keylos.io/node: "true"}}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: {name: keylos-cri-node}
rules:
- apiGroups: [""]
  resources: [pods, namespaces, nodes, services]
  verbs: [get, list, watch]
- apiGroups: [networking.k8s.io]
  resources: [networkpolicies]
  verbs: [get, list, watch]
- apiGroups: [discovery.k8s.io]
  resources: [endpointslices]
  verbs: [get, list, watch]
- apiGroups: [""]
  resources: [persistentvolumes, persistentvolumeclaims]
  verbs: [get, list, watch]
- apiGroups: [""]
  resources: [pods/eviction]
  verbs: [create]
- apiGroups: [""]
  resources: [nodes]
  verbs: [patch]          # own Node only, enforced by a ValidatingAdmissionPolicy matching system:keylos-cri:<node>
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: {name: keylos-cri-node}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: keylos-cri-node}
subjects: [{kind: Group, name: system:keylos-cri, apiGroup: rbac.authorization.k8s.io}]
```

The ValidatingAdmissionPolicy restricting Node patches to the requester's own node and to the `spec.unschedulable` field is part of the template set shipped in `deploy/cluster/` of this repository.

### 10.4 Service entries (rendered by `config` into `services.json`)

```json
{"cri": {"generation": "gen:fsv256:…", "entrypoint": "main", "tier": 0, "perHuman": false,
         "uid": "dynamic", "network": "cluster", "writer": true,
         "privileges": {"capabilities": ["CAP_NET_ADMIN", "CAP_NET_RAW"],
                        "paths": [{"path": "/var/lib/keylos/cri", "access": "rw"},
                                  {"path": "/run/keylos/cri", "access": "rw"},
                                  {"path": "/sys/fs/cgroup/keylos.slice/kube.slice", "access": "rw"},
                                  {"path": "/sys/kernel/security/tpm0/binary_bios_measurements", "access": "ro"}],
                        "devices": ["/dev/net/tun"], "tpm": true},
         "bpf": [],
         "routes": [{"to": "warden", "facet": "cri"}, {"to": "broker", "facet": "system"},
                    {"to": "bench", "facet": "cri"}, {"to": "depot", "facet": "cri"},
                    {"to": "strata", "facet": "cri"}, {"to": "net", "facet": "plumbing"},
                    {"to": "devd", "facet": "cri"}, {"to": "fleet", "facet": "cluster"},
                    {"to": "ledger", "facet": "writer"}],
         "readiness": {"timeoutSecs": 300}, "watchdogSecs": 10, "restart": "on-failure"},
 "kubelet": {"generation": "gen:fsv256:…", "entrypoint": "main", "tier": 1, "network": "cluster",
             "privileges": {"capabilities": [],
                            "paths": [{"path": "/var/lib/keylos/cri/kubelet/config", "access": "ro"},
                                      {"path": "/var/lib/keylos/cri/kubelet/pki", "access": "ro"},
                                      {"path": "/var/lib/keylos/cri/kubelet/pods", "access": "rw"},
                                      {"path": "/var/lib/keylos/cri/kubelet/plugins", "access": "rw"},
                                      {"path": "/var/lib/keylos/cri/kubelet/plugins_registry", "access": "rw"},
                                      {"path": "/var/lib/keylos/cri/kubelet/device-plugins", "access": "rw"},
                                      {"path": "/var/lib/keylos/cri/kubelet/state", "access": "rw"},
                                      {"path": "/var/lib/keylos/cri/logs", "access": "rw"},
                                      {"path": "/sys/fs/cgroup/keylos.slice/kube.slice", "access": "ro"},
                                      {"path": "/proc/meminfo", "access": "ro"}, {"path": "/proc/stat", "access": "ro"},
                                      {"path": "/proc/loadavg", "access": "ro"}, {"path": "/sys/devices/system/cpu", "access": "ro"}]},
             "routes": [{"to": "cri", "facet": "kubelet"}],
             "readiness": {"timeoutSecs": 120}, "restart": "always"},
 "kube-proxy": {"generation": "gen:fsv256:…", "entrypoint": "main", "tier": 1, "network": "cluster",
                "privileges": {"capabilities": ["CAP_NET_ADMIN"],
                               "paths": [{"path": "/var/lib/keylos/cri/kube-proxy", "access": "ro"}]},
                "routes": [], "restart": "always"}}
```

Each component reads only its own directory: kubelet's credentials are in `kubelet/pki/`, kube-proxy's in `kube-proxy/pki/`, and the cri cluster credential in `pki/`, which neither component can read. `network: "cluster"` makes `warden` start the service inside the namespace returned by `NetPlumbingCluster.clusterNetns` (protocols §20.16).

---

## 11. Testing and acceptance

### 11.1 Unit tests

- `keylos-podspec`: every derivation rule of §4.6.2, against golden Pod objects; protocols `vectors/podspec/` MUST pass.
- NetworkPolicy compiler: table-driven cases covering ingress/egress, `ipBlock` with `except`, named ports, namespace selectors, empty selectors, policy types, multiple policies; the generated ruleset is compared byte-for-byte to goldens.
- IPAM: allocation, quarantine, persistence across restart.
- OCI config generation (§4.7.5): golden `config.json` per CRI request fixture.
- Volume classification (§4.11) for every volume type.
- cgroup value conversion (§4.13.1) against the Kubernetes reference table.

### 11.2 Fuzz targets (cargo-fuzz, run ≥ 1 h per release)

| Target | Input |
|---|---|
| `fuzz_podspec` | Arbitrary Pod JSON plus CRI sandbox config |
| `fuzz_cri_requests` | Arbitrary protobuf messages for every RPC against an in-memory runtime |
| `fuzz_unpack` | Arbitrary layer tarballs (gzip/zstd/plain) into `cri-unpack`'s merge logic |
| `fuzz_netpol` | Arbitrary NetworkPolicy/Pod/Namespace sets into the compiler |
| `fuzz_podagent` | Arbitrary `podagent.capnp` messages into `kl-podagent`'s request validator |
| `fuzz_logs` | Arbitrary stdout/stderr byte streams into the CRI log writer |

### 11.3 Conformance

- **critest** (`cri-tools` validation suite) at the version matching each supported minor, run against both runtime classes. Expected skips: tests requiring privileged containers, host network/PID/IPC, `hostUsers: false`, AppArmor, SELinux, checkpointing, and (for `keylos-sealed`) tests that mount arbitrary host paths. Every other test MUST pass.
- **Kubernetes node e2e**, focus `[NodeConformance]`, skipping `[Privileged]`, `HostNetwork`, `HostPID`, `HostIPC`, `[Feature:SCTPConnectivity]`, `[Feature:UserNamespacesSupport]`, `[Feature:Checkpoint]`, AppArmor and SELinux tests. Every other test MUST pass for `keylos-vm`; for `keylos-sealed`, tests that need images without org-publisher statements are run with a test publisher key enabled.
- **Sonobuoy certified-conformance** run on a 3-node cluster of keylos nodes with an upstream control plane (kubeadm, on non-keylos control-plane machines): all non-skipped tests pass.
- protocols conformance vectors: `podspec/`, `cedar/` (admit decisions), `receipts/` (pod.* receipts), `capwire/`.

### 11.4 Integration tests

Run in CI on nested-virtualisation runners with `swtpm`, a real `bench`/`warden`/`broker`/`net`/`depot`/`strata` set from the same release, and a kubeadm control plane.

### 11.5 Acceptance criteria

| ID | Test | Pass condition |
|---|---|---|
| CRI-A01 | Pod with `privileged: true` | `RunPodSandbox` fails `PERMISSION_DENIED`; `pod.deny` receipt with reason `keylos:unsupported:privileged` |
| CRI-A02 | Pod with `hostPath: /etc` read-only, allowlist empty | Denied |
| CRI-A03 | Pod with `hostPath: /srv/data` read-only, allowlisted | Runs; writes fail `EROFS` |
| CRI-A04 | `keylos-vm` pod running an image that executes a kernel-exploit PoC for a host-only syscall path | Host unaffected; guest may crash; sandbox becomes `notready` |
| CRI-A05 | `keylos-sealed` pod with an image lacking an org-publisher statement | `PullImage` fails `PERMISSION_DENIED`, reason `no-authorising-signature` |
| CRI-A06 | Image with a `../../` tar entry | Conversion fails; no file written outside `images/tmp/`; temp cleaned |
| CRI-A07 | Decompression bomb (1 MiB → 100 GiB) | Conversion stops at `maxUncompressedBytes`; `RESOURCE_EXHAUSTED` |
| CRI-A08 | NetworkPolicy deny-all ingress applied while traffic flows | New connections refused within 2 s; established ones too (ct state cleared for the pod) |
| CRI-A09 | Pod tries to reach `169.254.42.1` (host side of uplink) on any port | Dropped |
| CRI-A10 | Pod tries ARP/IP spoofing of another pod's IP | Dropped by anti-spoofing rules |
| CRI-A11 | Private image pulled by namespace A; pod in namespace B without credentials uses it with `IfNotPresent` | `CreateContainer` fails with `ErrImagePullCredentials` |
| CRI-A12 | Firmware PCR change without an approved update, then re-attestation | `x-cri.attest` failure; renewals stop; node goes `NotReady` at certificate expiry |
| CRI-A13 | `crid` killed with SIGKILL during `RunPodSandbox` | After restart, no leaked tap, IP, strata volume, pod netns or `cri:pod:` root; kubelet recreates the pod |
| CRI-A13b | `crid` killed with SIGKILL while 20 pods of each runtime class run | After restart all pods keep running (no container restarts, no lost log lines); `Bench.reattach` used for every pod VM |
| CRI-A14 | Pod with `@tier("t3")` permit on a fleet machine | Sandbox `pending-approval`; runs after the org approval; `pod.admit` carries the approval ID |
| CRI-A15 | 100 `keylos-vm` pods (512 MiB class) on the reference machine | All `Running`; host overhead within §8 |
| CRI-A16 | `kubectl exec` with a token replayed after 31 s | Rejected |
| CRI-A17 | `kubectl logs -f` across a log rotation | No lost or duplicated lines |
| CRI-A18 | GPU passthrough pod requesting `keylos.io/vfio-gpu: 1` | Runs in a VM with the device; host driver unbound; released after deletion |
| CRI-A19 | emptyDir with `sizeLimit: 1Gi` filled to 2 GiB | Pod evicted by kubelet within 60 s |
| CRI-A20 | `egressViaGate` with a pod principal lacking a grant to `203.0.113.5:443` | Connection closed; `net.connect` denial visible in gate receipts |
| CRI-A21 | Container added by `kubectl debug` with an image not in the admitted spec | Re-admission happens; denied if policy forbids the image |
| CRI-A22 | kubelet generation without `x-kubelet.patchSet = keylos-mountless` | Connection refused; `Status` never reported |
| CRI-A23 | Join with a replayed `joinAttested` request (same challenge twice) | Second join rejected by fleet; `crid` requests a fresh challenge and succeeds |
| CRI-A24 | `kubectl exec` into a sealed container that wrote `/tmp/x` | The exec'd shell sees `/tmp/x` (shared mount namespace via `execInContainer`) |
| CRI-A25 | CSI volume published to a running `keylos-vm` pod | Device appears in the guest through `Vm.attachBlock`; pod is not recreated |
| CRI-A26 | `keylos-vm` pod with `egressViaGate` sends to an external IP through the tap by changing its guest routes | Dropped on the host; the same request through `bench-net` is subject to gate policy |
| CRI-A27 | Sealed pod writes to `/etc/x` | `EROFS`; writes to `/tmp` succeed |

---

## 12. Implementation notes

### 12.1 Crates

| Crate | Version | Use |
|---|---|---|
| `tokio` | 1.x | Runtime |
| `tonic`, `prost`, `tonic-build` | 0.12 / 0.13 | CRI gRPC server; protos generated from vendored `k8s.io/cri-api` `api.proto` per supported minor (`proto/v1.35`, `v1.36`, `v1.37`), merged into one superset service |
| `kube`, `k8s-openapi` | 1.x / 0.2x with the newest supported minor feature | API watches |
| `oci-client` | 0.1x | Registry client |
| `flate2`, `zstd` | 1.x / 0.13 | Layer decompression (`cri-unpack`) |
| `tar` | 0.4 | Layer parsing (`cri-unpack`) |
| `rtnetlink`, `netlink-packet-route` | 0.1x | Links, addresses, routes, bridge, VXLAN, FDB |
| `rustables` | 0.8+ | nftables over netlink |
| `tss-esapi` | 7.x | TPM quotes |
| `rcgen`, `x509-parser`, `rustls` | current | Keys, CSRs, TLS |
| `redb` | 2.x | State |
| `hyper`, `h2` | 1.x | Streaming server (SPDY framing implemented in-crate) |
| `capnp`, `capnp-rpc` | 0.19+ | capwire (through `keylos-capwire`) and `podagent.capnp` |
| `libcontainer` (youki) | 0.4+ | Guest runtime library used by `kl-podagent` (the `youki` binary is also shipped for debugging) |

### 12.2 Repository layout

```
cri/
├── crates/
│   ├── crid/               the service (modules per §4.1)
│   ├── cri-unpack/         image converter helper
│   ├── kl-podagent/        guest agent
│   ├── cri-ctl/            CLI
│   └── keylos-podspec/     normaliser (shared with broker tests)
├── proto/                  vendored CRI api.proto per supported minor
├── schema/podagent.capnp   repo-local protocol (§5.3)
├── nickel/keylos.cluster.ncl
├── deploy/cluster/         RuntimeClass, RBAC, ValidatingAdmissionPolicy templates (§10.3)
├── tests/{critest,node-e2e,integration,acceptance}/
├── tools/embed.py          regenerates Appendix A from keylos-protocols
└── fuzz/
```

### 12.3 Build

- `forge` recipe builds the `io.keylos.cri` service generation (crid, cri-unpack, mkfs.erofs runtime dependency from `pkgs`), the `io.keylos.cri-ctl` CLI generation, and the `kl-podagent` binary consumed by `pkgs` for `io.keylos.bench.pod`.
- Reproducible build required (protocols §11); `kl-podagent` is statically linked (musl) for the guest.
- MSRV per keylos release policy; `#![forbid(unsafe_code)]` in every crate except `crid::netctl::tun` (ioctl wrappers) and `kl-podagent::mount`, each `unsafe` block with a safety comment.

---

## 13. Decisions and alternatives

### 13.1 Decisions

| Decision | Alternatives considered | Rationale | ADR |
|---|---|---|---|
| Default runtime class is a microVM per pod | runc/crun containers on the host; gVisor | Arbitrary OCI images would otherwise execute on the host, breaking "host executes only sealed code"; the VM boundary also removes most kernel attack surface | [ADR-0047](../../handbook/11-decisions/adr-0047-cri-microvm-pods.md), [ADR-0008](../../handbook/11-decisions/adr-0008-host-executes-only-sealed-code.md), [ADR-0009](../../handbook/11-decisions/adr-0009-unsealed-code-in-workbenches.md) |
| crosvm through `bench`, not a cri-owned VMM | Embed Cloud Hypervisor or Firecracker in cri | One VMM to harden and audit | [ADR-0010](../../handbook/11-decisions/adr-0010-crosvm-single-vmm.md) |
| Sealed host containers only for org-publisher-signed generations | Allow any image as a host container | kl-exec allows only registered generations; signed generations keep provenance | [ADR-0007](../../handbook/11-decisions/adr-0007-composefs-fsverity-store.md) |
| CRI gRPC as the single non-capwire boundary | Patch kubelet to speak capwire | Keeps kubelet upstream except for the small mount-free patch set | [ADR-0004](../../handbook/11-decisions/adr-0004-capwire-no-system-bus.md) |
| Pod admission in Cedar through broker | Kubernetes admission webhooks only | The node enforces its own policy even against a compromised control plane | [ADR-0006](../../handbook/11-decisions/adr-0006-cedar-policy.md) |
| kubelet mount-free mode | Give kubelet `CAP_SYS_ADMIN` | No root in userspace; mounts would let kubelet reshape its view | [ADR-0023](../../handbook/11-decisions/adr-0023-no-root-no-setuid.md), [ADR-0025](../../handbook/11-decisions/adr-0025-namespaces-only-by-warden.md) |
| Image blobs as flattened EROFS images | Unpack layers onto the host filesystem and share via virtio-fs | No untrusted file trees on the host; ownership preserved without host chown; one read-only file per image |  |
| Built-in pod networking | CNI plugins | CNI plugins need host privileges and execute arbitrary binaries | [ADR-0047](../../handbook/11-decisions/adr-0047-cri-microvm-pods.md) |
| Taps only in the cluster netns | `bench-net` userspace NIC for pods | Pods need L3 reachability and inbound traffic; `bench-net` terminates flows as gate connections | [ADR-0044](../../handbook/11-decisions/adr-0044-vsock-control-and-userspace-nic.md) |
| Node attestation before credentials | Bootstrap tokens | A tampered node never joins | [ADR-0015](../../handbook/11-decisions/adr-0015-verify-before-unlock.md), [ADR-0048](../../handbook/11-decisions/adr-0048-quorum-presence.md) |
| Receipts for pod lifecycle | Kubernetes events only | Local, tamper-evident record of what ran on the machine | [ADR-0031](../../handbook/11-decisions/adr-0031-receipts-ledger.md) |

### 13.2 Contract history

The gaps this spec originally worked around (tap and pod-ID fields, the uplink format, pod netns creation, `network: "cluster"`, admission inputs, exec into sealed containers, per-pod egress shims, join freshness, credential roles, VM survival across `crid` restarts, block hot-plug) are resolved in protocols 1.0 (Appendix C, C18–C22, C37). No workaround remains; §2.5 lists interpretation notes only.

---

## Appendix A. Embedded protocols contracts (verbatim)

Generated by the repository's `tools/embed.py` from `keylos-protocols 1.0.0`. Do not edit between the markers.

<!-- BEGIN protocols §2.2 (verbatim) -->
> **protocols 2.2 Profiles and integrity profiles**

A machine runs exactly one **profile** (chosen at install, recorded in the first-boot bundle and the boot report) and has exactly one **integrity profile** (derived at every boot, shown in status, in the boot report and in the `vouch` verdict).

| Profile | Use | Notes |
|---|---|---|
| `desktop`, `laptop` | Interactive machines | atrium, portals, presence by touch |
| `server` | Headless | No atrium; presence by **quorum** (§5.4); serial-console recovery with the recovery key |
| `server-k8s` | Kubernetes node | `server` + `cri`, `kubelet`, `kube-proxy` (§21) |
| `cloud` | VM image in a public or private cloud | vTPM (provider EK chains in the attestation trust store); confidential VMs (SEV-SNP, TDX) supported, SVSM vTPM preferred; first-boot bundle from the metadata service (§20.13); quorum presence |
| `kiosk` | Single-app appliance | Autologin to one app principal; atrium kiosk mode; trusted path still present for owners |
| `appliance` | Fixed-function device | As `server`, without `bench` |

| Integrity profile | Condition |
|---|---|
| `full` | Owner-controlled Secure Boot keys (no Microsoft CAs in db), TPM 2.0, IOMMU, every check passes |
| `shared-boot` | `secureboot.keepMicrosoftCAs = true` (dual boot): the Microsoft Windows and third-party UEFI CAs are in db. Bitpixie-class downgrade risk is mitigated by TPM+PIN, the signed PCR11 policy and the NV release floor, and is documented |
| `shim` | Booted through shim + MOK (no custom-key Secure Boot available) |
| `cloud-vtpm` | `cloud` profile with a provider vTPM and no confidential-VM report |
| `cvm` | `cloud` profile in a confidential VM whose report is verified together with the TPM quote |
| `degraded` | No TPM, or Secure Boot off; no sealing, no VBU, persistent warning |
<!-- END protocols §2.2 -->

<!-- BEGIN protocols §2.3 (verbatim) -->
> **protocols 2.3 Resource classes**

`bench` admission control and memory tuning follow the machine's **RAM class** (detected at boot, overridable in config):

| RAM | Class | Max concurrent VMs (workbench, agent, tier-2, media, pod) | Defaults |
|---|---|---|---|
| < 12 GiB | `small` | 2 | zram swap (ephemeral key), KSM on, compressed snapshots, agents queue |
| 12–24 GiB | `medium` | 6 | KSM on, free-page reporting |
| > 24 GiB | `large` | 16 | free-page reporting |

`server-k8s` nodes are exempt from the VM cap for pod VMs; kubelet `maxPods` bounds them instead. When the cap is reached, new agent sessions queue (`aide`), and other VM requests fail with `kl:unavailable`.
<!-- END protocols §2.3 -->

<!-- BEGIN protocols §3.3 (verbatim) -->
> **protocols 3.3 Names**

- **Generation names** use reverse-DNS: `org.example.Editor`. The pattern is `^[a-z][a-z0-9-]*(\.[a-zA-Z0-9-]+){2,}$`, at most 255 characters. The prefixes `io.keylos.` and `org.keylos.` are reserved for the project.
- **Service names** are `[a-z][a-z0-9-]{0,62}` (for example `vault`, `portal-files`). The registry is §19.1.
- **Facet names** are `[a-z][a-z0-9-]{0,31}`. The registry is §19.2.
- **Usernames** are `[a-z_][a-z0-9_-]{0,31}`. `_system` and `_cluster` are reserved, and the prefix `guest-` is reserved for ephemeral guest sessions (`guest-<8 lowercase base32>`, created and destroyed by `hearth`).
- **Kubernetes names**: `pod-ns` and `pod-name` follow Kubernetes DNS-1123 label / subdomain rules (`[a-z0-9]([-a-z0-9]*[a-z0-9])?`, ≤ 63 and ≤ 253 characters).
<!-- END protocols §3.3 -->

<!-- BEGIN protocols §3.4 (verbatim) -->
> **protocols 3.4 Principal identifiers**

A principal is the tuple **(actor, human, session chain)**.

```
principal   = actor "@" human "/" session *( "/" session )
actor       = "app:" ref-gen
            / "service:" service-name ":" ref-gen
            / "agent:" ref-gen
            / "legacy:" ref-gen
            / "bench:" ref-gen
            / "pod:" pod-ns "/" pod-name ":" ref-gen-or-image
            / "shell"
            / "kernel"
human       = username / "_system" / "_cluster"
ref-gen-or-image = ref-gen / "oci:sha256:" 64HEXDIGLC   ; sealed container generation, or OCI image digest (keylos-vm pods)
session     = "s-" ULID          ; Crockford base32, 26 characters
ref-gen     = "gen:fsv256:" 64HEXDIGLC
```

Examples:
- `shell@alice/s-01JB6Q8Z0RXQ4M3W9V2N7T5K1C`
- `agent:gen:fsv256:9e1f…@alice/s-01JB6Q…/s-01JB6R…` (a sub-agent: the last session is the child)
- `service:vault:gen:fsv256:77aa…@_system/s-01JB5…`

Rules:
- The **session chain** records delegation. A child principal's chain is its parent's chain plus one new session. Its authority MUST be a subset of its parent's (§8).
- The **canonical key** for maps and log indexes is the full text form.
- Within a kernel, a running principal instance maps 1:1 to a **(UID, cgroup)** pair allocated by `warden` (§10.3). The mapping is published through `Supervisor.identify` (§7.3.2).
- A VM principal (tier 2 or 3) maps to the cgroup of its VMM process; processes inside the guest are not separate host principals.
- **Pod principals** (§21) always have human `_cluster`. A `keylos-vm` pod is one VM principal per pod sandbox whose actor names the pod's first container image; a `keylos-sealed` pod has one principal per container. The session chain starts at the `cri` service session.
<!-- END protocols §3.4 -->

<!-- BEGIN protocols §3.5 (verbatim) -->
> **protocols 3.5 Other identifiers**

| Identifier | Form |
|---|---|
| Session | `s-` + ULID, created by the spawner. ULIDs are unique and monotonic in time; only the canonical uppercase text form is valid. |
| Token root ID | 16 random bytes; text form `t-` + the 26-character **uppercase Crockford base32** encoding of the 128-bit big-endian value (the ULID codec; first character `0`–`7`). |
| Grant record ID | `g-` + ULID (persistent grant records, broker) |
| Effect intent ID | `e-` + ULID |
| Transaction ID | `x-` + ULID |
| Approval ID | `a-` + ULID. Minted by `broker` for the approvals it runs, and by `hearth` for the mandates of its own presence-confirmed effects (`x-hearth.*` kinds, never sent to `broker`) |
| Snapshot ID | `snap-` + ULID |
| Plan ID (config) | `p-` + ULID |
| Seal window ID | `w-` + ULID |
| Prepared merge ID | `pm-` + ULID (strata, §7.5.7, §20.12) |
| Quorum request ID | `q-` + ULID |
| Debug grant ID | `dbg-` + ULID |
| Pod sandbox ID (cri) | `pod-` + ULID (the Kubernetes pod UID is kept as metadata) |
| Media session ID (bench) | `med-` + ULID |
| Family inbox item ID (hearth) | `fi-` + ULID (a non-owner request waiting for an owner; never an approval ID, which is `a-…` and broker-issued) |
| Fleet command ID | `fc-` + ULID (§20.23) |
| Workflow ID | `wf-` + ULID. The persistent identity of one enrolled workflow (§20.25); minted by `loom`, never reused |
| Run ID | `wr-` + ULID. One run of a workflow (a fresh run after a migration, §20.27) |
| Step ID | `ws-` + the 26-character ULID of the run ID + `.` + state name (`[a-z][a-z0-9-]{0,31}`) + `.` + occurrence (decimal, no leading zeros, `0` for the first entry of that state in the run), e.g. `ws-01JB6Q8Z0RXQ4M3W9V2N7T5K1C.test.2`. Deterministic: the same run, state and occurrence always give the same step ID |
| Attempt ID | `wa-` + ULID. One execution attempt of a step; fresh for every claim, mapped to fresh runtime sessions |
| Effect ID | `fx-` + 26 uppercase Crockford base32 characters of the first 16 bytes of SHA-256(`"keylos-effect/1"` ‖ `0x00` ‖ step ID text ‖ `0x00` ‖ effect name) (the `t-` codec; first character `0`–`7`). Deterministic: every attempt of a step derives the same ID for the same named effect (§20.25) |
| Ownership epoch | `oe-` + decimal (≥ 1, no leading zeros) in documents; `UInt64` on the wire. Advanced by one at every claim of a workflow (§20.25) |
| Decision ID | `dr-` + ULID. A durable logical approval request and its decision (broker, §20.25); distinct from the boot-local prompt ID `a-…` |
| Budget account ID | `ba-` + ULID. A workflow-lifetime budget account held by `gate` (§20.25) |
| Catalog entry ID | reverse-DNS generation name (§3.3) |
| Device ID | `dev:` + subsystem + `:` + stable path, e.g. `dev:video4linux:pci-0000:00:14.0-usb-0:5:1.0` |
| Machine identity key | `key:sha256:…` of the machine's ledger signing key (the "machine key") |
<!-- END protocols §3.5 -->

<!-- BEGIN protocols §6.1 (verbatim) -->
> **protocols 6.1 Generation kinds**

| Kind | Content | Mounted by |
|---|---|---|
| `os` | Base OS tree (`/usr`, plus the initial `/` skeleton) | `boot` (initrd) |
| `runtime` | Shared library/runtime tree used by apps | `warden` (in app views) |
| `app` | A desktop or CLI application | `warden` |
| `service` | A system service | `warden` |
| `agent-template` | Harness, tool definitions, prompt and policy for an agent (§6.4) | `aide` → `bench` |
| `bench-image` | Guest OS image for workbenches and tier-2 VMs | `bench` |
| `legacy-image` | Imported foreign rootfs (OCI, Flatpak, distro); format in the `compat` spec (`keylos.compat/1`) | `compat` → `bench`/`warden` |
| `config` | Rendered configuration tree (a confext) | `boot` |
| `policy` | Cedar policy set + Biscuit authorizer templates | `broker` |
| `data` | A static data set (fonts, models, datasets) | `warden` (read-only bind) |
| `part` | A build intermediate (a derivation output that is not itself launchable: libraries, headers, toolchain parts) | `forge`, `bench` (store mounts) |
| `container` | An OCI container image converted deterministically into a generation, signed by an org publisher (§21); runnable only by `cri` in the `keylos-sealed` runtime class | `warden` (for `cri`) |
| `kmod` | Out-of-tree kernel modules built by the project for one exact kernel release (`/lib/modules/<uname>/extra/*.ko`, each module signed with the release stream's module-signing key) | `boot`, `warden` (module path only) |
<!-- END protocols §6.1 -->

<!-- BEGIN protocols §6.3 (verbatim) -->
> **protocols 6.3 Manifest schema (`keylos.manifest/1`)**

```json
{
  "schema": "keylos.manifest/1",
  "kind": "app",
  "name": "org.example.Editor",
  "version": "2.5.0",
  "summary": "A text editor",
  "publisher": "key:sha256:…",
  "derivation": "drv:sha256:…",
  "runtime": "gen:fsv256:…",
  "tier": 1,
  "entrypoints": {
    "main": {"exec": "/usr/bin/editor", "args": [], "kind": "gui"},
    "cli":  {"exec": "/usr/bin/editor-cli", "args": [], "kind": "cli"}
  },
  "needs": {
    "jit": false,
    "gpu": "render",
    "network": [{"host": "api.example.com", "ports": [443], "proto": "tcp", "methods": ["GET", "POST"], "why": "Sync"}],
    "listen": [],
    "devices": [],
    "services": ["portal-files", "portal-notify"],
    "secrets": [{"name": "sync-token", "why": "Account sync"}],
    "dataUnits": ["default"],
    "spawn": [],
    "portalIsland": false,
    "labels": {"readsUntrusted": true}
  },
  "provides": {
    "commands": ["editor"],
    "services": [],
    "mimeTypes": ["text/plain"],
    "uriSchemes": [],
    "agentTools": [],
    "workflows": []
  },
  "effects": [],
  "l10n": {"default": "en", "languages": ["en", "uk", "de"]},
  "compat": null,
  "agent": null,
  "webapp": null,
  "container": null,
  "kmod": null,
  "benchImage": null,
  "grafted": false,
  "requiresFeatureLevel": "KL1",
  "reproducible": true
}
```

Normative field rules:
- `kind`, `name`, `version` (SemVer 2.0), `schema` and `entrypoints` (except for kinds `config`, `policy`, `data`, `part`, `agent-template`, `container`, `kmod`) are REQUIRED. `benchImage` is REQUIRED for kind `bench-image`.
- `tier` for kind `container` is set by `cri` per runtime class (§21), never by the manifest; kind `kmod` has no tier.
- `tier`:
  - one of `0` (services only), `1`, `2`, `"L"`;
  - `bench-image`, `agent-template` and `part` omit it;
  - the **effective tier** is `max(manifest.tier, policy floor, token tier_floor)`. Policy floors are config options of the form `apps.<name>.tierFloor`. Policy can raise a tier, never lower it.
- `entrypoints.<name>.kind`: `gui`, `cli`, `service`, `harness`, `handler` (spawned by `portal-openuri` for URIs/MIME types), `notify-action` (spawned when a notification action is activated).
- `needs.gpu`: `"none"`, `"render"` (render node), `"display"` (compositor only, no GPU device) or `"passthrough"` (VFIO passthrough of a whole GPU into a VM; valid only for effective tier 2/3 and for pods, and only on machines whose config lists a passthrough GPU). If omitted, it is `"none"`.
- `needs.realtime: true` asks for realtime scheduling: `warden` sets `RLIMIT_RTPRIO = 20` and `RLIMIT_RTTIME = 200 000 µs` for the principal. Shown at install. There is no realtime broker daemon.
- `needs.csi` (kind `container` only): `{"driver": "<CSI driver name>", "nodePlugin": "<entrypoint>", "controller": false}` declares a CSI node plugin; such containers always run in a `keylos-vm` pod VM (§21).
- `webapp` (kind `app` only): `{"origin": "https://app.example.com", "scope": "/", "name": "…", "icons": ["/.keylos/icons/…"], "browserRuntime": "gen:fsv256:…"}`. The generation is an installable web app: it runs the sealed browser-shell runtime named by `browserRuntime`, restricted to `origin` through `gate` grants derived from `origin` and `needs.network`, with its own data unit and principal. A webapp generation MUST NOT declare `needs.jit` itself; the runtime generation declares it.
- `container` (kind `container` only): `{"image": "oci:sha256:<manifest digest>", "platform": "linux/amd64", "config": {"entrypoint": [], "cmd": [], "env": [], "user": "", "workingDir": ""}}`, copied from the OCI image config at conversion.
- `kmod` (kind `kmod` only): `{"kernel": "<uname -r>", "modules": ["nvidia", "nvidia-modeset", …], "firmware": []}`.
- `benchImage` (kind `bench-image` only): `{"purposes": ["workbench", "agent", …], "desktop": false}`. `purposes` lists the `VmSpec.Purpose` values (§7.3.13) the image supports; `bench` refuses other purposes. `desktop: true` marks an agent-desktop image (nested atrium) and is required for purpose `agentDesktop`.
- `needs.jit: true` lets the generation create executable anonymous memory (§9.3). It MUST be shown to the user at install.
- `needs.network[]` entries are **requests**. The broker turns them into grants at install time (after consent) or on first use, depending on policy.
- `needs.listen[]`: `{"port": N, "proto": "tcp"|"udp", "scope": "loopback"|"lan"|"any", "why": "…"}`. Inbound listening is granted only through `gate` (`listen:` targets, §7.3.7) and `net` firewall plumbing.
- `needs.portalIsland: true` asks `compat`/`warden` to run a per-app portal island (GTK/Qt portal shim) inside the app's own principal. It grants no authority.
- `effects[]` declares effect kinds the app can stage through `gate` (§14.2), for example `{"kind": "email.send", "class": "irreversible"}`.
- `provides.workflows[]` names the workflow definitions the generation ships, each at `/.keylos/workflows/<name>.json` (`keylos.workflow/1`, §20.27; names `[a-z][a-z0-9-]{0,62}`). `loom` enrolls only definitions listed here.
- `l10n`: default language and available translations in `/.keylos/l10n/<lang>.json` (`{"summary": …, "entrypoints": {"main": {"name": …}}, "needs": {"network": [{"why": …}]}}`). Display code MUST apply bidi isolation and confusable checks to localised strings.
- `compat`: `null` except for `legacy-image`, where it is an object conforming to `keylos.compat/1` (defined in the `compat` spec; consumed only by `compat`).
- `agent`: `null` except for `agent-template`, where it is `{"template": "/.keylos/agent/template.json", "flowProof": null | "camel/1"}` (§6.4).
- `grafted: true` marks a generation produced by an emergency graft (§11.1). Grafted generations are launchable but flagged in every UI and replaced automatically when the real rebuild lands.
- `reproducible: false` forces effective `tier ≥ 2` unless an owner exception record exists (`keylos.exception/1`, §20.9).
- Unknown fields MUST be rejected unless prefixed `x-`. Anything prefixed `x-` MUST be ignored by verifiers and MUST NOT carry authority.
- **Capability diff:** on update, `depot` computes the difference in `needs`, `tier`, `effects` and `provides.services` between the installed and the new manifest. Any widening needs consent (`keylos.consent/1`, §20.8) before the new generation becomes launchable.

The JSON Schema is `jsonschema/manifest-1.json`, shipped in this repo.
<!-- END protocols §6.3 -->

<!-- BEGIN protocols §7.1 (verbatim) -->
> **protocols 7.1 Model**

All keylos IPC between principals on one kernel uses **Cap'n Proto RPC (rpc.capnp, level 1 plus promise pipelining)** over **AF_UNIX `SOCK_SEQPACKET`** sockets.

- **There is no system bus.** A process can reach only the capabilities it was handed:
  - the bootstrap capability of each socket `warden` passed to it at spawn (listed in `KEYLOS_CAPWIRE_FDS`, §10.5),
  - capabilities returned by calls on those.
- **The one exception is the CRI boundary** (§21): the upstream `kubelet` speaks the Kubernetes CRI v1 gRPC API to `cri` over an `AF_UNIX` `SOCK_STREAM` socket that `warden` creates and passes to `kubelet` (route `cri#kubelet`). No other non-capwire IPC between keylos principals is allowed.
- **Holding is authority.** A capability or an fd received through capwire is itself the authority to use it. capwire has **no call-attached tokens**: methods that need token-based authority take an explicit `C.Token` parameter; otherwise the route facet or the held capability is the authority.
- **Framing:** one Cap'n Proto message (standard segment-table framing) per datagram.
  - Maximum datagram size: 4 MiB.
  - Larger data MUST use a `ByteStream`/`ByteSource` capability or a passed fd.
- **File descriptors** travel as `SCM_RIGHTS` ancillary data on the same datagram, at most 64 per datagram. Inside the message, an fd is referenced by an `Fd` struct whose `index` is its position in that datagram's fd array.
  - **No fd** is written as `index = 0xFFFF`, which is the struct default; a null `Fd` pointer also means "no fd". Senders SHOULD write `Fd` structs explicitly. A method that requires an fd fails with `kl:invalid` when it gets none.
  - An `Fd.index` that is out of range, or that a receiver resolves a second time, fails **that call** (or that result's processing) with `kl:invalid`; the connection stays up. The transport is schema-unaware, so an index is checked when the receiver resolves the field.
  - Every received fd that no field took is closed when the receiver releases the message (call parameters released, or the response dropped).
  - Fds can be attached to any parameter or result struct of a message built on a capwire connection, including structs with pointer fields only; a caller does not need to resolve a bootstrap promise before sending fds on it.
  - `ENOBUFS` and `ENOMEM` from `sendmsg` are transient: the sender retries with backoff for up to 1 s before it fails the connection.
- **Datagram rules** (violations are protocol errors that fail the **whole connection**, reported to the local side as `kl:invalid`): exactly one standard-framed message per datagram with no trailing bytes; size ≤ 4 MiB; ≤ 64 fds; ancillary data not truncated (`MSG_TRUNC`/`MSG_CTRUNC`); fds never on capwire-vsock. Senders MUST NOT send zero-length datagrams; a receiver reads a zero-byte datagram as end of connection. A sender whose own outgoing message would exceed 4 MiB fails the connection rather than leave the peer waiting.
- **Socket buffers.** `warden` (and any component that creates capwire sockets for others) sets `SO_SNDBUFFORCE` and `SO_RCVBUFFORCE` to at least 4 MiB + 64 KiB (4 259 840 bytes) on both ends of every capwire socketpair it creates, so 4 MiB datagrams fit; distributions set `net.core.wmem_max` and `net.core.rmem_max` ≥ 4 259 840 (§2). capwire-vsock endpoints set `SO_VM_SOCKETS_BUFFER_SIZE`/`_MAX_SIZE` to the same value.
- **Peer identity:**
  - Every capwire connection between principals is a `socketpair` created by `warden` (§7.2). For such sockets the kernel records the **creating** process (`warden`) as the peer of both ends, so `SO_PEERPIDFD` and `SO_PEERCRED` name `warden`, not the peer. Servers MUST take the peer's principal, tier, generation and facet **only** from `ServiceHost.accept` (§7.5.1), or from `Supervisor.connectionInfo` for a connection ID `warden` delivered.
  - `SO_PEERPIDFD` + `Supervisor.identify` MAY be used only for sockets the peer itself `connect()`ed to a listening socket (not used between keylos principals in 1.0; reserved for diagnostics and future listeners).
  - Servers MUST NOT use PIDs, executable paths, or claims inside messages to decide who the caller is.
- **Bootstrap:** the socket's bootstrap capability implements the service's root interface **and** `common.Extensible` (§7.3.1). It is already narrowed by `warden` to the route's facet (§7.2).
<!-- END protocols §7.1 -->

<!-- BEGIN protocols §7.2 (verbatim) -->
> **protocols 7.2 Routes and facets**

`warden` wires services according to **routes** declared in service and app manifests plus policy.

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

- A **facet** is a server-defined restriction name. The registry of every facet, its holders and the methods it allows is §19.2. Servers MUST refuse methods their facet doesn't allow with `kl:denied`.
- Route references are written `service#facet` (for example `vault#app`).
- The server learns the facet of each connection from `ServiceHost.accept` (§7.5.1) or `Supervisor.connectionInfo`.
- Service sockets live under `/run/keylos/svc/<service>/` with mode `0700`, owned by `warden`'s UID. No other principal can `connect()` to them. Connections are created by `warden` (`socketpair` + hand-off through `ServiceHost.accept`).
- Dynamic routes (a service capability granted at runtime) are materialised by `broker` through `ServiceConnect.connectService` (§7.5.1).
<!-- END protocols §7.2 -->

<!-- BEGIN protocols §7.3.1 (verbatim) -->
> **protocols 7.3.1 `common.capnp`**

```capnp
@0xc7a1e5d3b2f40001;

struct Digest {
  algo  @0 :Algo;
  bytes @1 :Data;            #! sha256/fsv256: 32 bytes; sha512: 64 bytes
  enum Algo { sha256 @0; sha512 @1; fsv256 @2; }
}

struct Ref {                 # typed reference, protocols §3.2
  kind   @0 :Kind;
  digest @1 :Digest;
  enum Kind { obj @0; gen @1; src @2; drv @3; rcpt @4; key @5; }
}

struct Fd { index @0 :UInt16 = 0xFFFF; }   #! index into the SCM_RIGHTS array of the carrying datagram; 0xFFFF (the default) and a null pointer mean "no fd"

struct Timestamp { unixNanos @0 :Int64; }

struct PrincipalId { text @0 :Text; }   #! canonical text form, protocols §3.4
struct SessionId   { text @0 :Text; }

struct Label {
  conf  @0 :Conf;
  integ @1 :Integ;
  enum Conf  { public @0; internal @1; private @2; secret @3; }
  enum Integ { trusted @0; user @1; untrusted @2; }
}

struct Token { biscuit @0 :Data; }      #! Biscuit v3 serialized token, protocols §8

struct KeyValue { key @0 :Text; value @1 :Text; }

struct AttemptBinding {          #! one execution attempt of a durable workflow (§20.25); epoch 0 (the default) = not an attempt
  workflow @0 :Text;             # wf-…
  attempt  @1 :Text;             # wa-…
  epoch    @2 :UInt64;           # ownership epoch of the claim (BrokerWorkflow.claim, §7.5.25)
  step     @3 :Text;             # ws-… the attempt executes
  owner    @4 :Text;             # the workflow's owning human; warden uses it as the attempt principal's human
}

interface ByteStream {
  write @0 (bytes :Data) -> stream;
  done  @1 ();
}

interface ByteSource {
  read @0 (maxBytes :UInt32) -> (bytes :Data, eof :Bool);
}

interface Cancelable { cancel @0 (); }

interface Watcher(T) {          # server-push subscription
  event @0 (event :T) -> stream;
}

interface Extensible {          #! implemented by every bootstrap capability
  ext     @0 (interfaceId :UInt64) -> (cap :Capability);   #! kl:denied if the facet does not allow that interface, or the server does not implement it
  version @1 () -> (protocols :Text, implementation :Text);   #! protocols: SemVer of this document ("1.0.0"); implementation: "<repo>/<SemVer>"
}
```

**Errors.** Methods signal failure with a Cap'n Proto exception of type `failed`. The exception `reason` string MUST start with `kl:<code>`, optionally followed by `:<ref>` (non-empty), then optionally a space and a human-readable message. Codes outside the table are a parse error. Root interfaces are not declared `extends(C.Extensible)`; clients obtain the `Extensible` view of a bootstrap capability by casting the same capability.

| Code | Meaning |
|---|---|
| `denied` | Policy refused. Not retryable without new authority. |
| `needs-approval` | `:<ref>` is an approval ID (`a-…`). Retry after the approval resolves, or use the returned `Approval`. |
| `not-found` | |
| `invalid` | Malformed request |
| `conflict` | State changed concurrently |
| `expired` | |
| `revoked` | |
| `budget` | Budget exhausted |
| `integrity` | Verification failure: signature, digest, fs-verity |
| `unavailable` | Transient; MAY retry with backoff |
| `unsupported` | Feature level or platform lacks support |
| `internal` | |

Example: `kl:needs-approval:a-01JB6R… Sending email requires approval`.
<!-- END protocols §7.3.1 -->

<!-- BEGIN protocols §7.3.2 (verbatim) -->
> **protocols 7.3.2 `warden.capnp`**

```capnp
@0xc7a1e5d3b2f40002;
using C = import "common.capnp";

enum Tier { t0 @0; t1 @1; t2 @2; t3 @3; legacy @4; }

struct FdMapping { target @0 :Int32; fd @1 :C.Fd; }

struct Limits {
  cpuWeight  @0 :UInt16 = 100;    # cgroup cpu.weight
  memoryMax  @1 :UInt64;          # bytes, 0 = inherit
  pidsMax    @2 :UInt32;          # 0 = inherit
  ioWeight   @3 :UInt16 = 100;
  wallSecs   @4 :UInt32;          # 0 = unlimited
}

struct SpawnSpec {
  generation  @0 :C.Ref;          #! kind gen; MUST be launchable (sealed, not revoked)
  entrypoint  @1 :Text;           # manifest entrypoint key, default "main"
  argv        @2 :List(Text);     # appended to entrypoint args
  env         @3 :List(C.KeyValue);  #! secrets MUST NOT be passed via env; warden rejects names matching policy secret patterns and reserved KEYLOS_* names;
                                     #! for actorKind pod the secret-pattern check is skipped (the admitted Kubernetes env may carry secrets, §21)
  fds         @4 :List(FdMapping);   # explicit fds; nothing else is inherited
  grants      @5 :List(C.Token);     # tokens attached to the new principal
  cwd         @6 :C.Fd;              # O_PATH dirfd; optional
  limits      @7 :Limits;
  terminal    @8 :C.Fd;              # pty secondary; optional; warden calls setsid+TIOCSCTTY
  session     @9 :C.SessionId;       # new child session id; warden generates if empty
  actorKind   @10 :ActorKind;
  transaction @11 :Text;             # optional strata transaction id (x-…); warden mounts the transaction views over the granted dirs
  enum ActorKind { app @0; service @1; agent @2; legacy @3; bench @4; shell @5; pod @6; }
  attempt     @12 :C.AttemptBinding; #! workflow attempt (§20.25): honoured only from service loom (facet service); warden forwards it
                                     #! unchanged in SessionReg.attempt and never interprets it; set by any other caller: kl:denied
}

struct ExitStatus {
  union {
    exited   @0 :Int32;
    signaled @1 :Int32;
    failedToStart @2 :Text;   # kl:<code> reason
  }
  cpuNanos @3 :UInt64;
  maxRss   @4 :UInt64;
}

interface Process {
  pidfd     @0 () -> (fd :C.Fd);             # kl:unsupported for VM processes
  principal @1 () -> (id :C.PrincipalId);
  wait      @2 () -> (status :ExitStatus);
  signal    @3 (signo :Int32) -> ();         #! delivered to every process of the principal's cgroup
  kill      @4 () -> ();                     # cgroup.kill
  confinement @5 () -> (report :Text);       # JSON confinement report, protocols §9.4
  freeze    @6 () -> ();                     # cgroup.freeze = 1
  thaw      @7 () -> ();                     # cgroup.freeze = 0
}

struct ConnectionInfo {
  peer   @0 :C.PrincipalId;
  facet  @1 :Text;
  tier   @2 :Tier;
  label  @3 :C.Label;          # current session label (from broker)
  generation @4 :C.Ref;
}

interface Supervisor {
  spawn          @0 (spec :SpawnSpec) -> (process :Process);   #! the child's session chain extends the caller's
  identify       @1 (pidfd :C.Fd) -> (id :C.PrincipalId, tier :Tier, generation :C.Ref);
  connectionInfo @2 (connectionId :UInt64) -> (info :ConnectionInfo);
  services       @3 () -> (list :List(ServiceStatus));
  control        @4 (service :Text, op :ServiceOp) -> (status :ServiceStatus);
      #! service "_system" is the pseudo-target for system power: ops poweroff/reboot (facet admin only)
  enum ServiceOp { start @0; stop @1; restart @2; reload @3; poweroff @4; reboot @5; }
}

struct ServiceStatus {
  name       @0 :Text;
  state      @1 :State;
  generation @2 :C.Ref;
  since      @3 :C.Timestamp;
  restarts   @4 :UInt32;
  enum State { inactive @0; starting @1; running @2; stopping @3; failed @4; }
}
```
<!-- END protocols §7.3.2 -->

<!-- BEGIN protocols §7.3.5 (verbatim) -->
> **protocols 7.3.5 `ledger.capnp`**

```capnp
@0xc7a1e5d3b2f40005;
using C = import "common.capnp";

struct ReceiptRef { seq @0 :UInt64; digest @1 :C.Digest; }

struct Checkpoint { note @0 :Text; }   #! C2SP signed-note checkpoint text, protocols §13.3

struct Filter {
  principalPrefix @0 :Text;
  sessionId  @1 :Text;
  eventTypes @2 :List(Text);
  since      @3 :C.Timestamp;
  until      @4 :C.Timestamp;
  limit      @5 :UInt32;
  fromSeq    @6 :UInt64;          # 0 = from the start; only receipts with seq ≥ fromSeq (continuation: fromSeq = query's next)
}

interface Ledger {
  append     @0 (envelope :Data) -> (ref :ReceiptRef);     #! facet "writer" only
  get        @1 (seq :UInt64) -> (envelope :Data);
  query      @2 (filter :Filter) -> (envelopes :List(Data), next :UInt64);
  checkpoint @3 () -> (checkpoint :Checkpoint);
  prove      @4 (seq :UInt64, treeSize :UInt64) -> (hashes :List(Data));   # RFC 6962 inclusion proof
  consistency @5 (from :UInt64, to :UInt64) -> (hashes :List(Data));
  watch      @6 (filter :Filter, watcher :C.Watcher(Data)) -> (cancel :C.Cancelable);
  serviceKey @7 (service :Text) -> (spki :Data, keyRef :Text, registered :C.Timestamp);
      #! facet reader: the currently registered key of service/<service> (from ledger.key.register); kl:not-found if none.
      #! Relying services use it to verify service-signed records, e.g. non-presence mandates signed by service/broker (§14.4)
}
```

**Read access** (facet `reader`; `writer` includes it): a principal sees receipts whose `subject` or `writer` is itself or a descendant session; a `shell` principal sees every receipt whose subject's human is its human; agent principals see only their own session chain; tier-0 services see receipts per their facet entry in §19.2, and every writer service sees every receipt whose `writer` actor is its own service name under any session and generation (`service:<name>:…`, also from earlier boots), so it can reconcile its own submissions (§20.25); `fleet` (facet `fleet-export`) sees metadata only, unless an owner exception of kind `fleet-receipt-access` (§20.9) lists the event type. Sealed payloads (§13.4) are decrypted for a reader only if the reader may read the receipt **and** the unit key still exists; receipts of crypto-shredded units are returned redacted (`keylos.receipt-redacted/1`). The returned form of a decrypted sealed receipt is defined in §13.4. `query` returns matching visible receipts in increasing `seq`, at most `limit`; `next` is the `seq` of the first matching visible receipt that was not returned (0 = none), and a client continues with the same filter and `fromSeq = next`. `watch` ignores `fromSeq`. Facet `vouch-heartbeat` (vouchd) sees only the metadata (time, subject human) of `user.login` receipts of every human, for the inheritance dead-man timer (§20.19).
<!-- END protocols §7.3.5 -->

<!-- BEGIN protocols §7.3.8 (verbatim) -->
> **protocols 7.3.8 `depot.capnp`**

```capnp
@0xc7a1e5d3b2f40008;
using C = import "common.capnp";

struct GenerationInfo {
  ref       @0 :C.Ref;
  kind      @1 :Text;
  name      @2 :Text;
  version   @3 :Text;
  manifest  @4 :Data;         # manifest JSON bytes
  launchable @5 :Bool;
  sealedBy  @6 :List(Text);   # key refs whose signatures over the generation statement verified
  grafted   @7 :Bool;
  revoked   @8 :Bool;
  installed @9 :C.Timestamp;
  launchReasons @10 :List(Text);   # why launchable is false: "no-authorising-signature", "revoked:<reason>", "needs-consent",
                                   # "quorum-deferred", "unreviewed-tier2", "offline-install-needs-t3", "kernel-mismatch" (kmod)
}

interface Depot {
  get        @0 (ref :C.Ref) -> (info :GenerationInfo);
  list       @1 (kind :Text, name :Text) -> (list :List(GenerationInfo));
  install    @2 (source :Text) -> (info :GenerationInfo, capabilityDiff :Text);  # "oci://…[#gen=fsv256:…]", "tuf:<stream>/<name>", ".klb" bundle fd path via powerbox
  mount      @3 (ref :C.Ref) -> (tree :C.Fd);          #! facet mounter (warden, bench, compat) and config (kind config only); fsmount fd (composefs, verity=require)
  openObject @4 (ref :C.Ref) -> (fd :C.Fd);            # read-only fd of store object
  importTree @5 (tree :C.Fd, manifest :Data) -> (info :GenerationInfo);   # facets forge (all kinds), config (config, policy), compat (legacy-image)
  seal       @6 (ref :C.Ref, statement :Data) -> (info :GenerationInfo);  # attach owner seal (DSSE seal statement signed via HearthSeal)
  root       @7 (ref :C.Ref, holder :Text) -> ();      # GC root
  unroot     @8 (ref :C.Ref, holder :Text) -> ();
  gc         @9 (dryRun :Bool) -> (freedBytes :UInt64, removed :List(C.Ref));
  verify     @10 (ref :C.Ref) -> (ok :Bool, problems :List(Text));
  revocations @11 () -> (listEnvelope :Data);
  openPath   @12 (ref :C.Ref, path :Text) -> (fd :C.Fd);
      #! read-only fd of a regular file inside a generation, resolved in the generation's own tree (no symlink escape).
      #! facet user: only paths under /.keylos/ (manifest.json, cmdsig/*, l10n/*, agent/*, icons/*, sbom.spdx.json,
      #! provenance.json, workflows/*) of generations the caller may spawn, agent templates, or catalog entries; facet mounter: any path;
      #! facet loom: /.keylos/manifest.json and /.keylos/workflows/* of any installed generation
  revocationStatus @13 () -> (serial :UInt64, issued :C.Timestamp, ageSecs :UInt64);
      #! facets user, mounter, compat: the newest verified revocation list; ageSecs measured against trusted time (§3.6, §14.5)
}
```

**GC roots** are named `<holder>:<purpose>:<id>`. Registered holder prefixes: `loom:workflow:<wf-id>` (the pinned definition generation of every workflow that is not yet terminal, and of a terminal one until it is forgotten; §20.25), `warden:running:<session>` (every generation `warden` mounted; `warden` calls `unroot` when the last principal using that mount exits, so `depot` needs no unmount notification), `cri:pod:<pod-id>` (container generations and images of a pod), `courier:os:<seq>` (bootable OS generations), `courier:kmod:<kernel-release>` (kmod generations for an installed kernel). Other prefixes are repo-local.

**Container mounts.** `mount` of a `container` generation succeeds only while it is rooted by a `cri:pod:<pod-id>` holder; `cri` roots it before calling `PodSpawn` (§21.4).

`install("tuf:<stream>/<name>")` and `install("tuf:org:<org>/<name>")` are resolved through `CourierResolver.resolve` (§7.5.6), which also returns the catalog review status; `depot` is never a TUF client. Revocation lists reach `depot` the same way: `courier` resolves `tuf:<stream>/revocations` and `depot` takes the DSSE list from `Resolution.revocations` (§7.5.6). Source form `oci+container://<registry>/<repo>@sha256:<manifest>` (facet `cri` only) converts an OCI image into a `container` generation (§21.4). `courier` installs OS generations with the source form `oci://<registry>/<repo>@sha256:<manifest>#gen=fsv256:<hex>`, which `depot` MUST accept (the fragment pins the expected generation digest).
<!-- END protocols §7.3.8 -->

<!-- BEGIN protocols §7.3.13 (verbatim) -->
> **protocols 7.3.13 `bench.capnp`**

```capnp
@0xc7a1e5d3b2f40013;
using C = import "common.capnp";
using W = import "warden.capnp";
using B = import "broker.capnp";

struct Share { name @0 :Text; dir @1 :C.Fd; writable @2 :Bool; overlay @3 :Bool; }

struct VmSpec {
  image     @0 :C.Ref;              # bench-image generation
  shares    @1 :List(Share);
  vcpus     @2 :UInt16;
  memoryMiB @3 :UInt32;
  gpu       @4 :Bool;               # virtio-gpu native context
  network   @5 :List(C.Token);      # net grants; all egress via bench-net → gate
  display   @6 :Bool;               # Wayland proxy to atrium (tier-2 apps, workbench apps such as IDEs, agent-desktop mirrors)
  fromSnapshot @7 :Text;
  session       @8 :C.SessionId;    # the VM principal's session; bench generates it if empty
  parentSession @9 :C.SessionId;    # session the VM principal descends from (agent: the aide-created session chain parent)
  principalKind @10 :W.SpawnSpec.ActorKind;   # bench (default), agent, legacy, pod
  storeSet      @11 :List(C.Ref);   # generations exposed read-only in the guest store (/store) in addition to the image closure
  unsignedImageOk @12 :Bool;        #! honoured only for facet user calls by service:forge with purpose build, tier 3
  purpose       @13 :Purpose;
  displayMode   @14 :DisplayMode;   # meaningful when display = true
  gpuPassthrough @15 :Text;         # PCI address of a VFIO-claimed GPU (needs.gpu "passthrough"); empty = none
  blockDevices  @16 :List(BlockDev);   # media VMs and pod VMs: block devices claimed through devd MediaAttach
  enum Purpose { workbench @0; agent @1; app @2; media @3; build @4; captive @5; pod @6; agentDesktop @7; }
  enum DisplayMode { interactive @0; readOnly @1; }   # readOnly: human watches an agent desktop; takeOver switches to interactive
  struct BlockDev { device @0 :Text; fd @1 :C.Fd; readOnly @2 :Bool; }
  bootArgs      @17 :List(C.KeyValue);  # delivered to the guest over benchd control at boot (e.g. "captive.url" for purpose captive)
  tap           @18 :C.Fd;              #! purpose pod only (facet cri): tap device created in the cri network namespace; index 0xFFFF = none
  tapConfig     @19 :TapConfig;
  podId         @20 :Text;              # purpose pod: pod-… (§3.5); bench places the VMM processes under the pod's cgroup
  struct TapConfig { ifname @0 :Text; mac @1 :Text; mtu @2 :UInt16; }
  attempt       @21 :C.AttemptBinding;  #! facet aide only (agent attempts of a workflow, §20.25); copied to VmPrincipal.attempt
}

struct ForkSpec {
  session       @0 :C.SessionId;    # session of the forked VM principal; bench generates it if empty
  parentSession @1 :C.SessionId;    # defaults to the source VM's parentSession
  principalKind @2 :W.SpawnSpec.ActorKind;   # aide forks: agent; default: the source VM's kind
  offered       @3 :List(C.Token);    #! tokens for the fork; default: the source VM principal's tokens (sub-agents: the parent agent's)
  checks        @4 :List(Text);       #! attenuation checks for the fork (copied to VmPrincipal.checks)
  budgets       @5 :List(B.Budget);   #! sub-budgets for the fork (copied to VmPrincipal.budgets)
  attempt       @6 :C.AttemptBinding; #! facet aide only: the fork is an attempt of a workflow (§20.25); copied to VmPrincipal.attempt
}

interface Vm {
  exec     @0 (argv :List(Text), env :List(C.KeyValue), fds :List(W.FdMapping), tty :Bool) -> (process :W.Process);
  snapshot @1 (name :Text) -> (id :Text);
  fork     @2 (spec :ForkSpec) -> (vm :Vm);         #! spec null = defaults; the fork is a new VM principal registered through VmSpawn
  changes  @3 () -> (shares :List(Text));          # per-share change summaries
  commit   @4 (share :Text) -> (transaction :Text); # human workbenches only; agent overlays merge via BenchMerge (§7.5.10)
  discard  @5 () -> ();
  stop     @6 () -> ();
  console  @7 () -> (pty :C.Fd);
  attachShare @8 (share :Share) -> ();             #! hot-plug: new virtio-fs export in the running VM; the guest sees /shares/<name>
  detachShare @9 (name :Text) -> ();               #! open guest files on the share get EIO afterwards
  desktop  @10 () -> (desktop :Capability);        #! purpose agentDesktop only: returns an aide-sys AgentDesktop (§7.5.13)
  takeOver @11 (interactive :Bool) -> ();          # agentDesktop: switch the human's mirror between readOnly and interactive
  info        @12 () -> (session :C.SessionId, cgroupId :UInt64, cid :UInt32, purpose :VmSpec.Purpose);
  attachBlock @13 (dev :VmSpec.BlockDev) -> ();    #! hot-plug a virtio-blk device (pod VMs: CSI volumes published after start)
  detachBlock @14 (device :Text) -> ();
}

interface Bench {
  start     @0 (spec :VmSpec) -> (vm :Vm);
  project   @1 (projectDir :C.Fd) -> (vm :Vm);     # start/attach project workbench per project.ncl
  snapshots @2 () -> (list :List(Text));
  media     @3 (device :Text) -> (vm :Vm, browser :Capability);
      #! starts (or attaches to) the media VM for an authorized removable block device; browser is a bench-sys MediaBrowser (§7.5.10)
  reattach  @4 (session :C.SessionId) -> (vm :Vm);
      #! a new Vm capability for a running VM started by the same caller principal (cri after a crid restart, aide).
      #! VMs of purposes pod, agent and agentDesktop outlive their Vm capability until Vm.stop, the end of their parent
      #! session, or a bench restart (which stops every VM)
}
```
<!-- END protocols §7.3.13 -->

<!-- BEGIN protocols §7.5.1 (verbatim) -->
> **protocols 7.5.1 `warden-sys.capnp`**

```capnp
@0xc7a1e5d3b2f40020;
using C = import "common.capnp";
using W = import "warden.capnp";
using B = import "broker.capnp";

interface Bootstrap {                  #! bootstrap of fd 3 in every tier-0 service (connection to warden)
  host     @0 (host :ServiceHost) -> ();   # the service registers its ServiceHost; MUST be called first
  ready    @1 () -> ();                    # readiness signal
  watchdog @2 () -> ();                    # liveness ping (interval from the service manifest)
  status   @3 (text :Text) -> ();          # human-readable status line
}

interface ServiceHost {                #! implemented by every tier-0 service; warden is the only caller
  accept @0 (socket :C.Fd, connectionId :UInt64, facet :Text, peer :C.PrincipalId, tier :W.Tier, generation :C.Ref) -> ();
  stop   @1 (reason :Text) -> ();          # cooperative stop before SIGTERM
  reload @2 () -> ();                      # the config generation changed; warden has rebuilt the service's /etc view
}

interface GrantMounts {                # facets broker, bench, compat, portals, cri (idmappedDir only)
  attachGrant @0 (session :C.SessionId, name :Text, tree :C.Fd, readOnly :Bool, ceiling :C.Label) -> (inView :C.Fd, viewPath :Text);
      #! bind-mounts tree (non-recursive, idmapped to the holder's dynamic UID) at /grants/<name> in the holder's mount namespace;
      #! inView = O_PATH fd of the mount root opened through the holder's namespace;
      #! ceiling = the grant's exposure label (§14.1): objects labelled above it are never readable through the mount;
      #! a null ceiling means no enforcement (the caller MUST then have raised the holder to secret/untrusted)
  detachGrant @1 (session :C.SessionId, name :Text) -> ();
  idmappedDir @2 (dir :C.Fd, forPrincipal :C.PrincipalId, readOnly :Bool) -> (tree :C.Fd);
      #! detached idmapped clone (open_tree + mount_setattr MOUNT_ATTR_IDMAP); used by bench/compat for shares
}

enum TerminateMode { kill @0; freeze @1; thaw @2; }

struct PrincipalEvent {
  session   @0 :C.SessionId;
  principal @1 :C.PrincipalId;
  time      @2 :C.Timestamp;
  union {
    spawned @3 :W.Tier;
    exited  @4 :W.ExitStatus;
    frozen  @5 :Void;
    thawed  @6 :Void;
  }
  cgroupId  @7 :UInt64;          # kernel cgroup id of the principal's scope (stable for the session's lifetime)
}

interface PrincipalControl {           # facets broker, admin, hearth (terminate own humans' sessions), strata (events, mountView), cri (pod sessions)
  terminate @0 (session :C.SessionId, mode :TerminateMode) -> ();   #! applies to the session and all descendant sessions
  list      @1 (humanFilter :Text) -> (sessions :List(C.PrincipalId));
  events    @2 (watcher :C.Watcher(PrincipalEvent), replay :Bool) -> (cancel :C.Cancelable);
      #! replay = true: first emits one `spawned` event for every currently running session (visible to the facet), then live events
  mountView @3 (session :C.SessionId) -> (json :Text);               # JCS: [{target, source, flags, grant}]
  fenceWriters @4 (tree :C.Fd, exclude :List(C.SessionId)) -> (fence :WriterFence);
      #! facet strata: freezes every session (except exclude and their descendants) whose view can write inside tree,
      #! and returns once they are frozen; kl:conflict if a writer cannot be frozen (tier-0 service other than strata,
      #! kernel or network filesystem writer); released by WriterFence.release, when the capability is dropped, or after 30 s
}

interface WriterFence {
  sessions @0 () -> (list :List(C.SessionId));   # the frozen sessions
  release  @1 () -> ();                         # thaws them
}

interface ServiceConnect {             # facet broker
  connectService @0 (session :C.SessionId, service :Text, facet :Text) -> (socket :C.Fd);
      #! creates a route for an existing principal; returns the principal-side capwire socket
}

interface FdStore {                    # facet service (each service sees only its own keys)
  store @0 (key :Text, fd :C.Fd) -> ();    #! survives the service's restarts within one boot
  fetch @1 (key :Text) -> (fd :C.Fd);
  drop  @2 (key :Text) -> ();
}

struct LegacyGrant { tree @0 :C.Fd; target @1 :Text; readOnly @2 :Bool; }

struct LegacyView {
  image    @0 :C.Ref;                  # legacy-image generation
  stateDir @1 :C.Fd;                   # per-image writable state (overlay upper + work)
  grants   @2 :List(LegacyGrant);
  netMode  @3 :Text;                   # "none" | "pasta"
}

interface LegacySpawn {                # facet compat
  spawnLegacy @0 (spec :W.SpawnSpec, view :LegacyView, brokerSession :C.SessionId) -> (process :W.Process, notifyFd :C.Fd);
      #! user namespace with a 65 536-UID block, child user.max_user_namespaces=0;
      #! notifyFd = seccomp user-notification listener for the open broker (protocols §9.2);
      #! brokerSession = the per-app open-broker session that gets the read pairing to this app (§9.3)
}

interface UserSpawn {                  # facets launcher (atrium launcher), handler (portal-openuri, portal-notify, portal-background)
  spawnForHuman @0 (spec :W.SpawnSpec, human :Text, initialLabel :C.Label) -> (process :W.Process);
      #! new top-level session under the human's current shell session; label starts at max(default, initialLabel)
}

interface TrustedSpawn {               # facet trusted-terminal (atrium-term only)
  spawnTerminal @0 (spec :W.SpawnSpec, pty :C.Fd) -> (process :W.Process);
      #! actorKind MUST be shell; warden withholds SECBIT_EXEC_DENY_INTERACTIVE for exactly this process tree (§9.3)
}

interface DebugAttach {                # facet broker (materialises Right.debug, §9.3)
  attach @0 (target :Text, scope :Text, debugger :C.Ref, entrypoint :Text, argv :List(Text),
             pty :C.Fd, expiresSecs :UInt32, grantId :Text, requester :C.PrincipalId) -> (process :W.Process);
      #! target "session:s-…" | "gen:fsv256:…"; scope "process" | "kernel"; expiresSecs ≤ 3600 (process), ≤ 900 (kernel);
      #! debugger MUST be a launchable generation whose manifest name is in the policy list debug.debuggers;
      #! warden spawns it as a child of requester's shell session (the human the grant was minted to) with seccomp profile
      #! debug-1 and the ambient capabilities of §9.3, writes kl_debug_pairs, and on expiry or exit removes the pair,
      #! kills the debugger and writes debug.detach
}

struct PodMount {
  tree       @0 :C.Fd;
  target     @1 :Text;
  readOnly   @2 :Bool;
  tmpfsBytes @3 :UInt64;   # 0: bind tree at target; > 0: warden creates a tmpfs of that size at target and copies tree into it
                           #  (configMap, secret, projected and downwardAPI volumes, §21.6)
}

struct PodContext {
  podId        @0 :Text;               # pod-… (§3.5)
  namespace    @1 :Text;
  name         @2 :Text;
  uid          @3 :Text;               # Kubernetes pod UID (metadata)
  netns        @4 :C.Fd;               # pod network namespace created by cri inside the cri network
  sharePid     @5 :Bool;               # shareProcessNamespace
  mounts       @6 :List(PodMount);     # volumes, prepared by cri (strata volumes, projected tmpfs)
  cgroupParent @7 :Text;               # under /keylos.slice/kube.slice/
  seccomp      @8 :Text;               # "baseline-1" | "runtime-default" (baseline-1 ∩ the CRI RuntimeDefault profile)
  readOnlyRoot @9 :Bool;
  runAsUid     @10 :UInt32;            # container-visible UID; mapped through a per-pod mapping-only userns held by warden (idmapped rootfs)
}

interface PodSpawn {                   # facet cri (keylos-sealed runtime class only, §21)
  spawnContainer @0 (spec :W.SpawnSpec, pod :PodContext) -> (process :W.Process);
      #! spec.generation MUST be kind container with an org-publisher genstmt; actorKind pod; tier t1;
      #! the container joins pod.netns and (if sharePid) the pod's pid namespace; no added capabilities, ever;
      #! the root is read-only plus tmpfs at /tmp, /run, /var/tmp and /dev/shm (§21.8)
  execInContainer @1 (spec :W.SpawnSpec, container :C.SessionId) -> (process :W.Process);
      #! CRI Exec/ExecSync: a child session of the container's principal that joins its mount, pid, net, ipc and uts
      #! namespaces and its cgroup; spec.generation MUST equal the container's generation; no added capabilities
  egressShim      @2 (podId :Text) -> (shim :Capability);
      #! a gate-sys ShimEndpoint (§7.5.12) bound to the pod's principals, created by warden as for tier L; cri runs the
      #! pod's egress redirector with it when cluster.egressViaGate is set (§21.5)
}

struct VmPrincipal {
  session       @0 :C.SessionId;
  parentSession @1 :C.SessionId;      # session the VM descends from (agent: the aide-created chain; pod: cri's session)
  principalKind @2 :W.SpawnSpec.ActorKind;   # bench, agent, legacy or pod
  image         @3 :C.Ref;            # bench-image generation
  template      @4 :C.Ref;            # agent-template generation for agent VMs, else empty
  tier          @5 :W.Tier;           # t2 or t3
  offered       @6 :List(C.Token);    #! tokens held by parentSession (e.g. the launching human's), to be attenuated for the VM
  purpose       @7 :Text;             # VmSpec.Purpose enumerant name
  podId         @8 :Text;             # purpose pod only
  checks        @9 :List(Text);       #! Datalog checks (§8.3) the broker appends when attenuating `offered` for this VM (sub-agents: aide narrows the parent's grants)
  budgets       @10 :List(B.Budget);  #! hard sub-meters carved from the offered roots (GateMeterAdmin.carve, §7.5.12) for this VM principal
  attempt       @11 :C.AttemptBinding; #! from VmSpec.attempt / ForkSpec.attempt; forwarded unchanged in SessionReg.attempt
}

interface VmSpawn {                    # facet bench
  register   @0 (vm :VmPrincipal) -> (principal :C.PrincipalId, cgroupId :UInt64, tokens :List(C.Token));
      #! creates the VM principal (dynamic UID, cgroup scope, BrokerSystem.registerSession); the actor follows §3.4
      #! (agent: "agent:" + template; pod: "pod:…"; otherwise "<kind>:" + image); tokens are those the broker issued
  spawnVmm   @1 (session :C.SessionId, spec :W.SpawnSpec) -> (process :W.Process);
      #! spawns crosvm, its device processes, bench-net and bench-relay inside the VM principal's cgroup;
      #! spec.generation MUST be the bench generation; warden wires bench-net to gate#shim and bench-relay to
      #! aide#host (agent VMs), broker#principal, vault#app and portal-*#default for that principal
  unregister @2 (session :C.SessionId) -> ();   # after the last VMM process of the principal exited
}
```
<!-- END protocols §7.5.1 -->

<!-- BEGIN protocols §7.5.2 (verbatim) -->
> **protocols 7.5.2 `broker-sys.capnp`**

```capnp
@0xc7a1e5d3b2f40021;
using C = import "common.capnp";
using B = import "broker.capnp";
using P = import "prompt.capnp";

struct SessionReg {
  child    @0 :C.PrincipalId;
  parent   @1 :C.SessionId;        # empty for warden-originated system services
  offered  @2 :List(C.Token);
  onRevoke @3 :Text;               # "kill" | "freeze"
  budgets  @4 :List(B.Budget);     #! hard sub-budget ceilings for the child (VmPrincipal/ForkSpec budgets): the broker carves each from
                                   #! the matching offered root (GateMeterAdmin.carve) before issuing tokens; kl:budget if a parent meter is short
  attempt  @5 :C.AttemptBinding;   #! workflow attempt (§20.25): verified against the broker's workflow record (claimed epoch, attempt,
                                   #! allowed generation and spawner); the child's label and tokens then come from that record (§7.5.25)
}

struct SessionRegResult {
  tokens    @0 :List(C.Token);
  label     @1 :C.Label;
  tierFloor @2 :UInt8;             # 0..4 = t0..legacy
}

struct FlowCheck {
  session       @0 :C.SessionId;
  kind          @1 :Text;          # effect kind or "net"
  target        @2 :Text;
  payloadDigest @3 :C.Digest;
  rendered      @4 :List(P.RenderedEffect);
  provenance    @5 :List(P.ArgProvenance);
  flowProof     @6 :Data;          # optional DSSE keylos.flowproof/1 (§20.11)
  intent        @7 :Text;          # e-… id of the staged intent; empty for connect-time "net" checks
}

struct GrantResult {
  outcome @0 :B.GrantOutcome;
  mandate @1 :Data;                # DSSE keylos.mandate/1 when the outcome was decided by approval; empty otherwise.
                                   #! presence-signed when presence was required; otherwise signed by service/broker (§14.4)
}

struct PodAdmission {
  allowed   @0 :Bool;
  reasons   @1 :List(Text);        # forbid/permit policy ids and failed checks
  tierFloor @2 :UInt8;             # 1 = keylos-sealed allowed, 2 = keylos-vm required
  approval  @3 :Text;              # a-… when an @tier/@orgApproval permit applies (pods wait for it)
}

interface BrokerSystem {           # facet system
  registerSession    @0 (reg :SessionReg) -> (result :SessionRegResult);           # warden
  sessionEnded       @1 (session :C.SessionId, exitText :Text) -> ();              # warden
  checkFlow          @2 (check :FlowCheck) -> (result :GrantResult);               # gate: Rule of Two at stage/commit/connect
  requestFor         @3 (subject :C.SessionId, req :B.GrantRequest, intent :Text, idempotencyKey :Text,
                          intentSession :C.SessionId, decidedOnTrustedPath :Bool) -> (result :GrantResult);
      #! approval request on behalf of a subject session (intent = e-… id or empty). Allowed subjects per caller:
      #! gate → sessions that staged the intent (intentSession = the staging session when it differs from subject);
      #! aide → its agent sessions; strata, depot, vault, atrium → only their own session (atrium: device authorization).
      #! The broker deduplicates by (caller, idempotencyKey) for 24 h: a repeated call returns the same approval/result.
      #! decidedOnTrustedPath: atrium only (device authorization): the human already decided on atrium's trusted-path card;
      #! the broker evaluates policy, records approval.decide with channel "local" and returns the mandate without
      #! prompting again. MUST be false (else kl:invalid) for every other caller or when policy requires presence.
  registerApprover   @4 (publicKey :Data, alg :Text, channel :Text) -> ();         # atrium ("local") and vouchd ("phone"), once per boot
  registerSessionKey @5 (session :C.SessionId, publicKey :Data) -> ();             # aide: agent session key (flow proofs, commits)
  annotateRequest    @6 (session :C.SessionId, provenanceJson :Text) -> ();        # aide: provenance hints for the next request
  rootsChanged       @7 (fdkeys :List(Text)) -> ();                                # strata: re-open held roots after rollback
  revokeSession      @8 (session :C.SessionId, mode :Text) -> ();                  # hearth (lock/logout), warden
  loadPolicy         @9 (generation :C.Ref) -> ();                                 # config: activate a policy generation
  validatePolicy     @10 (tree :C.Fd) -> (ok :Bool, problems :List(Text));         # config: dry-run a candidate policy tree
  mintCaptive        @11 (session :C.SessionId) -> (token :C.Token);               # net: captive-portal token (§8.2 captive fact)
  admitPod           @12 (podSpecJson :Text, runtimeClass :Text) -> (admission :PodAdmission);
      #! cri: Cedar evaluation of action "admit" on a PodSpec entity (§16, §21.3); podSpecJson is the CRI PodSandboxConfig
      #! plus container configs, normalised by cri to keylos.podspec/1 (§21.3)
}

interface LabelAuthority {         # facet label-authority
  labelOf  @0 (session :C.SessionId) -> (label :C.Label);
  raiseFor @1 (session :C.SessionId, label :C.Label, reason :Text) -> (label :C.Label);   #! labels only go up; receipt label.raise
}
```

`registerApprover.publicKey` is a DER SubjectPublicKeyInfo; other encodings fail `kl:invalid`. A method whose receipt must be written before it replies (§19.3) answers `kl:unavailable` while the serving component's own `ledger.key.register` has not been appended; the broker registers its key before it serves facet `system`.
<!-- END protocols §7.5.2 -->

<!-- BEGIN protocols §7.5.7 (verbatim) -->
> **protocols 7.5.7 `strata-sys.capnp`**

```capnp
@0xc7a1e5d3b2f40026;
using C = import "common.capnp";
using S = import "strata.capnp";

enum Choice { ours @0; theirs @1; merged @2; }

interface TransactionExt {
  policy            @0 () -> (networkPolicy :S.NetworkPolicy, views :List(Text));   # view paths for warden mounting
  resolve           @1 (path :Text, choice :Choice, merged :C.Fd) -> ();
  changeSet         @2 () -> (jcs :C.Fd, digest :C.Digest);                         # keylos.changeset/1
  commitWithMandate @3 (mandate :Data) -> (snapshot :Text);                         #! superseded before release by prepare + PreparedMerge.commit: MUST return kl:unsupported
  pin               @4 (pinned :Bool) -> ();
  owner             @5 () -> (session :C.SessionId);                                # session that began the transaction
  prepare           @6 () -> (prepared :PreparedMerge);
      #! freezes the views, captures the live state of every affected path, applies recorded resolutions and clean three-way
      #! merges, and stores the result as an immutable prepared merge (§20.12 keylos.fsmerge/2); kl:conflict while conflicts remain
  bindWorkflow      @7 (binding :C.AttemptBinding) -> ();
      #! facets bench, aide: the transaction (and every prepared merge of it) is owned by binding.workflow from now on (§20.25);
      #! strata verifies the binding for the transaction's owner session with BrokerWorkflow.verify; idempotent; kl:conflict if
      #! the transaction is already bound to another workflow
}

interface PreparedMerge {
  id       @0 () -> (id :Text);                                  # pm-… (§3.5)
  manifest @1 () -> (jcs :C.Fd, digest :C.Digest);               # keylos.fsmerge/2; digest = the fs.merge payload digest
  diff     @2 (path :Text) -> (diff :C.Fd);                      # unified diff of the stored result ("" = whole merge)
  commit   @3 (mandate :Data) -> (snapshot :Text);
      #! verifies the mandate binds digest, takes a writer fence (PrincipalControl.fenceWriters), revalidates every expectedLive
      #! entry and applies exactly the stored operations (no new merge, no overlay read); stale live state → kl:conflict
  discard  @4 () -> ();
  status   @5 () -> (state :Text, transaction :Text, snapshot :Text);
      #! durable completion record: state "prepared" | "committed" | "discarded" | "stale"; for "committed" the commit's
      #! transaction id and pre-commit (undo) snapshot. Retained at least until the owning workflow's horizon (§20.25)
}

interface StrataTxn {              # facets user, bench, aide, cli, warden
  txnExt @0 (id :Text) -> (txn :S.Transaction, ext :TransactionExt);
      #! user/bench/aide/cli: only transactions begun by the caller (or its session ancestors).
      #! warden: any; warden MUST check that the spawner's session equals owner() or descends from it before mounting views
  prepared @1 (id :Text) -> (prepared :PreparedMerge);
      #! user/bench/aide/cli: prepared merges of the caller's own transactions (same ownership rule as txnExt); not on facet warden
  preparedFor @2 (id :Text, binding :C.AttemptBinding) -> (prepared :PreparedMerge);
      #! facets bench, aide: a prepared merge of a transaction bound to binding.workflow (bindWorkflow), for a fresh attempt of that
      #! workflow that does not descend from the session that prepared it; strata verifies the binding is current
      #! (BrokerWorkflow.verify); a stale or foreign binding: kl:not-found
}

struct UnitInfo { id @0 :Text; alias @1 :Text; mode @2 :Text; subvolumes @3 :List(Text); mounted @4 :Bool; backend @5 :Text; }
struct SubvolInfo { uuid @0 :Text; path @1 :Text; kind @2 :Text; human @3 :Text; owner @4 :Text; unit @5 :Text; snapshotClass @6 :Text; backupClass @7 :Text; }
struct BackupStatus { target @0 :Text; lastRun @1 :C.Timestamp; lastResult @2 :Text; lastRestoreTest @3 :C.Timestamp; nextRun @4 :C.Timestamp; }

interface StrataAdmin {            # facet admin; mountUnit also on facet warden; lockUnits/unlockUnits also on facet hearth; preUpdate also on facet courier
  subvolumes      @0 (human :Text) -> (list :List(SubvolInfo));
  createSubvolume @1 (parent :C.Fd, name :Text, kind :Text, owner :Text) -> (info :SubvolInfo);
  deleteSubvolume @2 (uuid :Text) -> ();
  units           @3 () -> (list :List(UnitInfo));
  mountUnit       @4 (unit :Text) -> (view :C.Fd);       # detached mount fd of the plaintext view
  lockUnits       @5 (human :Text) -> ();
  unlockUnits     @6 (human :Text) -> ();
  pin             @7 (snapshot :Text, pinned :Bool) -> ();
  deleteSnapshot  @8 (snapshot :Text) -> ();
  backupNow       @9 (target :Text) -> (run :Text);
  backups         @10 () -> (list :List(BackupStatus));
  status          @11 () -> (json :Text);
  preUpdate       @12 (reason :Text) -> (set :Text);      # snapshot set before an OS update
}

interface StrataHomes {            # facet hearth
  createHome @0 (user :Text, uid :UInt32) -> (info :SubvolInfo);
  deleteHome @1 (user :Text, forget :Bool) -> ();
  createEphemeralHome @2 (user :Text, uid :UInt32) -> (info :SubvolInfo);   # guest sessions: not snapshotted, ephemeral unit key
}

interface StrataVolumes {          # facet cri
  create  @0 (podId :Text, name :Text, kind :Text, sizeBytes :UInt64) -> (dir :C.Fd);
      #! kind "emptyDir" (subvolume, deleted with the pod) | "local" (local PersistentVolume, kept until release);
      #! dir is an O_PATH fd; sizeBytes is enforced without qgroups: strata scans usage every 30 s and reports
      #! over-limit volumes in usage(), and cri evicts the pod (Kubernetes ephemeral-storage semantics)
  release @1 (podId :Text, name :Text) -> ();
  usage   @2 (podId :Text) -> (json :Text);
}
```

On facet `gate`, strata serves `Strata.undo` only, for transactions that were committed by an `fs.merge` intent whose compensation `gate` executes (§14.2).
<!-- END protocols §7.5.7 -->

<!-- BEGIN protocols §7.5.8 (verbatim) -->
> **protocols 7.5.8 `devd-sys.capnp`**

```capnp
@0xc7a1e5d3b2f40027;
using C = import "common.capnp";

struct NodePlan {
  id @0 :Text; name @1 :Text; kind @2 :Kind; major @3 :UInt32; minor @4 :UInt32;
  enum Kind { char @0; block @1; }
}

struct PendingDevice {
  device    @0 :Text;              # dev:… id
  bus       @1 :Text;              # "usb" | "thunderbolt" | "pci"
  vendor    @2 :UInt16;
  product   @3 :UInt16;
  serial    @4 :Text;
  port      @5 :Text;              # physical port path
  classes   @6 :List(Text);        # interface classes, e.g. "hid", "mass-storage", "audio", "fido", "net"
  name      @7 :Text;              # descriptor strings, untrusted (rendered as untrusted text)
  hidSafety @8 :Text;              # "none" | "keyboard-like" (requires confirmation with an already-authorized input device)
}

interface DeviceAdmin {            # facets warden, broker (plan, revoke); authorize (atrium: authorize, deauthorize, pending)
  plan   @0 (principal :C.PrincipalId, tokens :List(C.Token)) -> (nodes :List(NodePlan));
  revoke @1 (rootId :Data) -> ();
  authorize   @2 (device :Text, persist :Bool, decisionEnvelope :Data) -> ();
      #! sets the kernel authorized flag (USB) or approves the Thunderbolt/USB4 domain; decisionEnvelope is the mandate
      #! atrium obtained through BrokerSystem.requestFor (resource device, §14.4): devd verifies only the service/broker
      #! or owner-presence signature and the device id; persist stores the identity (vendor, product, serial, port)
  deauthorize @3 (device :Text, forget :Bool) -> ();
  pending     @4 (watcher :C.Watcher(PendingDevice)) -> (cancel :C.Cancelable);
}

interface MediaAttach {            # facets bench, cri
  claimBlock @0 (device :Text, readOnly :Bool) -> (fd :C.Fd, info :Text);
      #! fd of the whole authorized removable block device for a media or pod VM; the host never mounts it (§9.5);
      #! info = JSON {sizeBytes, model, removable, partitions}
  claimVfio  @1 (pciAddress :Text) -> (groupFd :C.Fd, deviceFd :C.Fd);
      #! binds the device to vfio-pci (it must be listed for passthrough in config); the host driver is unbound
  release    @2 (device :Text) -> ();
}

struct PowerEvent { union { preSleep @0 :Text; postResume @1 :Text; battery @2 :Text; sensor @3 :Text; lid @4 :Bool; } }

interface PowerEvents {            # facet client (events), service (subscribe + ack: hearth, strata, atrium)
  subscribe @0 (watcher :C.Watcher(PowerEvent)) -> (cancel :C.Cancelable);
  ack       @1 (op :Text) -> ();
}

struct BtDevice { address @0 :Text; name @1 :Text; paired @2 :Bool; connected @3 :Bool; kind @4 :Text; battery @5 :Int8; }

interface Bluetooth {              # facet admin
  power      @0 (on :Bool) -> ();
  scan       @1 (watcher :C.Watcher(BtDevice)) -> (cancel :C.Cancelable);
  pair       @2 (address :Text) -> ();             # confirmation on the trusted path
  connect    @3 (address :Text) -> ();
  disconnect @4 (address :Text) -> ();
  forget     @5 (address :Text) -> ();
  devices    @6 () -> (list :List(BtDevice));
}

interface Backlight {              # facet atrium
  list @0 () -> (devices :List(Text));
  set  @1 (device :Text, permille :UInt16) -> ();
  get  @2 (device :Text) -> (permille :UInt16);
}
```
<!-- END protocols §7.5.8 -->

<!-- BEGIN protocols §7.5.11 (verbatim) -->
> **protocols 7.5.11 `net-sys.capnp`**

```capnp
@0xc7a1e5d3b2f4002a;
using C = import "common.capnp";

struct NetEvent {
  union {
    linkChanged      @0 :Text;      # JSON Link
    timeTrusted      @1 :Bool;
    captive          @2 :Bool;
    metered          @3 :Bool;
    vpnChanged       @4 :Text;      # JSON {profile, up}
    resolverInsecure @5 :Text;      # upstream id
  }
}

interface NetWatch {               # facets user, status, resolver, captive
  watch @0 (watcher :C.Watcher(NetEvent)) -> (cancel :C.Cancelable);
}

interface NetResolver {            # facet resolver (gate, tier-0 services)
  query @0 (wire :Data) -> (wire :Data, secure :Bool);   # RFC 1035 wire format, one question
}

struct ListenPort {
  port  @0 :UInt16;
  proto @1 :Proto;
  scope @2 :Scope;
  enum Proto { tcp @0; udp @1; }
  enum Scope { loopback @0; lan @1; any @2; }
}

interface NetPlumbing {            # facet plumbing
  setEgressUids    @0 (uids :List(UInt32)) -> ();                         # warden: UIDs allowed host-netns egress (gate, net helpers)
  setListenPorts   @1 (tcp :List(UInt16), udp :List(UInt16), ports :List(ListenPort)) -> ();
      #! gate: subset of config listenPorts; when ports is non-empty it supersedes tcp/udp (which then MUST be empty)
      #! and carries each port's scope (needs.listen scope, §6.3)
  setLocalLinkUids @2 (uids :List(UInt32)) -> ();                         # warden: UIDs allowed mDNS/IPP on local links (portal-print)
}

interface NetCaptive {             # facet captive (atrium)
  status @0 () -> (captive :Bool, ssid :Text, portalUrl :Text);
  admit  @1 (vmUid :UInt32) -> ();  #! superseded before release: MUST return kl:unsupported
  admitSession @2 (vmSession :C.SessionId) -> (expires :C.Timestamp);   #! superseded before release: MUST return kl:unsupported; use signIn
  portalUrl    @3 () -> (url :Text);  # the detected portal URL
  signIn       @4 () -> (expires :C.Timestamp);
      #! atrium ("Sign in to network"): net starts the captive VM itself through bench#net (purpose captive, image
      #! io.keylos.bench.captive-browser, display true, bootArgs captive.url), reads its session and cgroup with Vm.info,
      #! mints the captive token (BrokerSystem.mintCaptive), which the broker attaches to the VM session (bench-net reads it
      #! with Broker.myGrants), and allows that VM's bench-net direct egress on tcp/80, tcp/443 and udp+tcp/53 for at most
      #! 600 s while the network is captive. The window appears through atrium's Display like any tier-3 VM
  endSignIn    @5 () -> ();
      #! atrium (sign-in window closed): net stops the captive VM (Vm.stop) and revokes its direct egress immediately
}

interface NetPlumbingCluster {     # facet plumbing (clusterUplink: cri; clusterNetns: warden)
  clusterUplink @0 (configJson :Text) -> (netns :C.Fd);
      #! configJson is keylos.cri.uplink/1 (§21.5): op "uplink" configures the cri network namespace (pod CIDR routes,
      #! NAT, overlay) and returns it; op "podNetns" creates a pod network namespace attached to the cri bridge and
      #! returns it; op "release" deletes a pod namespace. cri holds CAP_NET_ADMIN only inside the cri namespace
  clusterNetns  @1 () -> (netns :C.Fd);
      #! warden: the cri network namespace, created by net at its own start on server-k8s from config cluster.*;
      #! warden starts services with services.json network "cluster" (crid, kubelet, kube-proxy) inside it
}

interface NetDiscovery {           # facet discovery (portal-discovery)
  browse  @0 (serviceType :Text, onLink :Text, watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);   # JSON ServiceInstance
  publish @1 (instance :Text, serviceType :Text, port :UInt16, txtJson :Text, forUid :UInt32) -> (handle :C.Cancelable);
}
```
<!-- END protocols §7.5.11 -->

<!-- BEGIN protocols §7.5.12 (verbatim) -->
> **protocols 7.5.12 `gate-sys.capnp`**

```capnp
@0xc7a1e5d3b2f4002b;
using C = import "common.capnp";
using B = import "broker.capnp";

interface ShimEndpoint {           # facet shim: one endpoint per principal (tier L shim, bench-net per VM)
  connect      @0 (target :B.NetTarget, tokens :List(C.Token)) -> (socket :C.Fd);   # gate picks the first authorizing token
  udpAssociate @1 (target :B.NetTarget, tokens :List(C.Token)) -> (dgram :C.Fd);
  resolve      @2 (name :Text, qtype :UInt16) -> (answer :Data);   # DNS wire-format response, granted names only
  sshAgent     @3 () -> (socket :C.Fd);
  caBundle     @4 () -> (pem :Text);                               # session CA (if TLS interception is active)
}

interface GateDebug {              # facet debug (warden, atrium, owner shell)
  interception @0 (session :C.SessionId) -> (active :Bool, hosts :List(Text));   # fills the confinement report (§9.4)
  status       @1 () -> (json :Text);
}

interface GateMeterAdmin {         # facet broker
  meterFor @0 (rootId :Data) -> (spent :List(B.Budget), remaining :List(B.Budget), parent :Data);
  carve    @1 (parentRoot :Data, childRoot :Data, budget :List(B.Budget)) -> ();
      #! creates a hard sub-meter: every charge to childRoot is also charged to parentRoot; gate refuses a carve that
      #! would make the sum of the children's ceilings exceed the parent's remaining amount (kl:budget)
  release  @2 (childRoot :Data) -> ();   # returns the unspent remainder to the parent
}
```
<!-- END protocols §7.5.12 -->

<!-- BEGIN protocols §7.5.21 (verbatim) -->
> **protocols 7.5.21 `fleet-sys.capnp`**

```capnp
@0xc7a1e5d3b2f40034;
using C = import "common.capnp";
using P = import "prompt.capnp";

interface FleetCompliance {        # facets gate (complianceToken), client (status)
  status          @0 () -> (json :Text);
  complianceToken @1 (audience :Text) -> (envelope :Data);   # DSSE compliance assertion for org services
}

interface OrgDecider {             # facet decider (broker)
  decide @0 (prompt :P.ApprovalPrompt, group :Text) -> (decision :P.Decision);
      #! for permits annotated @orgApproval("<group>"); the mandate is signed by an approver/<id> key
}

interface FleetCluster {           # facet cluster (cri)
  joinAttested @0 (quote :Data, eventLog :Data, cvmReport :Data, challenge :Data) -> (joinJson :Text);
      #! fleet verifies the TPM quote (AK, §19.6; qualifyingData = SHA-256("keylos-join/1" ‖ challenge ‖ machine key))
      #! against the release log and, for cvm, the confidential-VM report; challenge MUST come from joinChallenge and be
      #! unexpired; returns the cluster API endpoint, CA bundle and a bootstrap token bound to the node identity
  kubeletCertificate @1 (csrDer :Data) -> (chainPem :Text, expires :C.Timestamp);   # = clusterCertificate("kubelet", …)
  joinChallenge      @2 () -> (challenge :Data, expires :C.Timestamp);   # 32 random bytes, valid ≤ 300 s, single use
  clusterCertificate @3 (role :Text, csrDer :Data) -> (chainPem :Text, expires :C.Timestamp);
      #! role "kubelet" | "kube-proxy" | "cri" (cri's own cluster credential: NetworkPolicy and Pod watches, drain);
      #! issued only to attested nodes; renewed by cri before expiry; private keys stay in the cri state directory
}
```
<!-- END protocols §7.5.21 -->

<!-- BEGIN protocols §7.5.23 (verbatim) -->
> **protocols 7.5.23 `cri-sys.capnp`**

```capnp
@0xc7a1e5d3b2f40036;
using C = import "common.capnp";

struct PodInfo {
  podId        @0 :Text;
  namespace    @1 :Text;
  name         @2 :Text;
  runtimeClass @3 :Text;            # "keylos-vm" | "keylos-sealed"
  state        @4 :Text;            # "admitting" | "pending-approval" | "ready" | "notready" | "denied"
  principals   @5 :List(C.PrincipalId);
  admission    @6 :Text;            # JSON of the BrokerSystem.admitPod result
}

interface CriAdmin {               # facets admin (owner shell), status (fleet, atrium)
  pods     @0 () -> (list :List(PodInfo));
  node     @1 () -> (json :Text);   # attestation state, kubelet version, runtime classes, capacity
  drain    @2 (reason :Text) -> ();  # admin only: cordon + evict through the API server using cri's cluster credential (role "cri")
  images   @3 () -> (json :Text);   # cached OCI images (keylos-vm) and container generations (keylos-sealed)
}
```
<!-- END protocols §7.5.23 -->

<!-- BEGIN protocols §9.1 (verbatim) -->
> **protocols 9.1 Baseline for every non-kernel process except `warden` itself**

1. `PR_SET_NO_NEW_PRIVS`.
2. Own cgroup, own dynamic UID (§10.3), no supplementary groups. Human-owned data and directory grants reach dynamic UIDs through **idmapped mounts** (§7.5.1); mapping-only user namespaces used for idmapping are held by `warden`, and no process ever runs inside them.
3. Landlock ruleset at the highest available ABI:
   - starts from deny-all for all handled access rights;
   - allows only the mount view (§10.1), `/grants` (runtime grant mounts) and explicitly granted fds/paths;
   - scopes `ABSTRACT_UNIX_SOCKET` and `SIGNAL`;
   - uses `RESTRICT_SELF_TSYNC` when available.
4. seccomp-bpf allowlist profile `baseline-1`, default action `ENOSYS`. Always denied:
   - `unshare`, `setns`, and namespace flags on `clone`/`clone3` (clone3 → `ENOSYS`, forcing the libc `clone` fallback, which is then flag-checked);
   - `io_uring_*`, `bpf`, `perf_event_open`, `userfaultfd`;
   - `keyctl`, `add_key`, `request_key`;
   - `kexec_*`, `init_module`, `finit_module`, `delete_module`;
   - `mount`, `umount2`, `pivot_root`, `chroot`, `fsopen`, `fsmount`, `fsconfig`, `move_mount`, `open_tree`, `mount_setattr`;
   - `ptrace`, `process_vm_readv`, `process_vm_writev`;
   - `personality` (except the default);
   - `acct`, `swapon`, `swapoff`, `reboot`, `settimeofday`, `clock_settime`, `clock_adjtime`, `adjtimex` (read-only calls included: seccomp cannot inspect `struct timex`, so both are denied with `EPERM`);
   - `ioctl` `TIOCSTI` and `TIOCLINUX`.
5. Namespaces created by `warden` without a user namespace: mount, pid, ipc, uts, cgroup; net unless the principal is a tier-0 service with `network: "host"` (or `"cluster"`, which joins the cri network namespace, §20.16). **Single exception to "only `warden` creates namespaces":** on `server-k8s`, `net` creates the cri network namespace and the per-pod network namespaces inside the cri network (network namespaces only, never user or mount namespaces; §21.5).
6. A fresh `/proc` (`hidepid=invisible,subset=pid`).
7. No controlling terminal unless one is given; `TIOCSTI` disabled system-wide (`dev.tty.legacy_tiocsti=0`).
8. `mseal` of the stack and libc read-only segments (done by the keylos libc startup shim where available); `PR_SET_MDWE` (W^X) unless the generation has `needs.jit`.
9. `RLIMIT_RTPRIO = 0` unless the generation has `needs.realtime` (then 20, with `RLIMIT_RTTIME = 200 000 µs`).

The only other seccomp profiles are `baseline-1+<digest>` (baseline-1 plus the tier-0 extras a service's `privileges.syscalls` and `privileges.socketFamilies` list in `services.json`, §20.16; `<digest>` is the lowercase hex SHA-256 of the extras' names, syscalls and socket families together, sorted by bytes, each followed by `\n`), used only for tier-0 services; `debug-1` (baseline-1 plus `ptrace`, `process_vm_readv`, `perf_event_open`) and `debug-1k` (`debug-1` plus `bpf`, for scope `kernel`), used exclusively for `DebugAttach` debuggers (§9.3); `openbroker-1` (baseline-1 plus `process_vm_readv`; `ptrace`, `process_vm_writev` and `pidfd_getfd` stay denied), used exclusively for `compat`'s per-app open-broker processes (§9.3); and `runtime-default` (baseline-1 ∩ the Kubernetes RuntimeDefault profile) for `keylos-sealed` pods.
<!-- END protocols §9.1 -->

<!-- BEGIN protocols §9.2 (verbatim) -->
> **protocols 9.2 Tiers**

| Tier | Isolation | Code allowed |
|---|---|---|
| t0 | Baseline + service-specific allowances (system services) | Sealed only |
| t1 | Baseline (apps) | Sealed only |
| t2 | microVM (crosvm) managed by `bench`, display via Wayland proxy | Any (inside guest) |
| t3 | microVM workbench (dev environments, agent sessions) | Any (inside guest) |
| legacy | Baseline + a user namespace built by `warden` (child `user.max_user_namespaces=0`) + FHS view + seccomp user-notification open broker (`compat`). Only forge-built, reproducible legacy images signed by a trusted key run as tier L on the host; every imported image runs in t2 | Sealed legacy image |
| pod (`keylos-sealed`) | t1 baseline with `runtime-default` seccomp, in the pod network namespace inside the `cri` network (§21) | Sealed `container` generations signed by an org publisher |
| pod (`keylos-vm`) | t2-class microVM per pod sandbox managed by `bench` for `cri` | Any OCI image (inside guest) |

Media VMs (removable storage, §9.5), captive-portal browser VMs and agent desktops are tier-3 VMs with their own `VmSpec.purpose`.
<!-- END protocols §9.2 -->

<!-- BEGIN protocols §9.3 (verbatim) -->
> **protocols 9.3 Code integrity (host)**

**Primary enforcement: the `kl-exec` BPF LSM.** `boot` loads `kl-exec` in the initrd before executing any file other than itself, and hands its maps and links to `warden` across `switch_root`. The program reads kernel structures at offsets the loader computes from the running kernel's BTF (`/sys/kernel/btf/vmlinux`) before load; a missing member fails the load.

| Hook | Decision |
|---|---|
| `bprm_check_security` | Allow if the file's superblock `s_dev` ∈ `kl_exec_allowed_sb`, or (phase INITRD and the file is on the initramfs). Else `-EACCES` |
| `bprm_creds_for_exec` with `bprm->is_check` set (`execveat(…, AT_EXECVE_CHECK)`) | Same rule as `bprm_check_security`. A check-only exec returns after this hook and never reaches `bprm_check_security`, so this row is what refuses an interpreter's check of an unregistered script. Regular execs are decided only by `bprm_check_security` (one event per denial) |
| `mmap_file` with `PROT_EXEC` | File-backed: same rule as exec. Anonymous: allow only if the task's cgroup ID ∈ `kl_exec_jit_cgroups`. Else `-EACCES` |
| `file_mprotect` adding `PROT_EXEC` | File-backed: same as exec. Anonymous or private-writable: allow only for JIT cgroups |
| `kernel_read_file` (firmware, modules, policy, X.509) | Allow if the file's sb ∈ allowed set or (phase INITRD and initramfs). kexec reads are always denied |
| `kernel_load_data` (`init_module`, firmware blobs) | Deny (modules load only via `finit_module` from verified files) |
| `bpf` (`BPF_PROG_LOAD`, `BPF_LINK_DETACH`, `BPF_PROG_DETACH`) | Allow for the `warden` core (thread-group ID recorded in `kl_exec_policy.warden_tgid` at hand-over) and for `boot` in phase INITRD. Allow for a debugger task whose cgroup has a `kl_debug_pairs` entry with scope `kernel`, for tracing program types only (kprobe, tracepoint, raw_tracepoint, perf_event), never LSM, cgroup or XDP types. Deny for every other task |
| `ptrace_access_check` | Allow only if the tracer's cgroup has an unexpired `kl_debug_pairs` entry whose target cgroup contains the tracee (or is an ancestor of it). Yama and the seccomp profile apply in addition. The hook also guards every other `ptrace_may_access` path (`/proc/<pid>/{mem,maps,environ,fd,ns/*,root,…}`, `kcmp`, `pidfd_getfd`, `setns` and `PIDFD_GET_*_NAMESPACE` on a pidfd, `process_vm_*`); no task is exempt, including the `warden` core. Checks with `PTRACE_MODE_NOAUDIT` are refused without an event |
| `perf_event_open` | Allow only for a task whose cgroup has an unexpired `kl_debug_pairs` entry (the hook sees only the `PERF_SECURITY_*` type, not the target) |
| `perf_event_alloc` (events created by a `perf_event_open(2)` call admitted above) | Scope `process`: allow only task events whose target task is in the target cgroup (or a descendant) and cgroup events on the target cgroup; CPU-wide events are refused. Scope `kernel`: allow system-wide events. Kernel-internal counters (watchdog, ptrace hardware breakpoints) are not `perf_event_open(2)` requests and are not checked |

**Map contract.** `boot` passes the map fds to `warden` as fds 3–7 in the order given by the kernel command line `keylos.execmapfds=3,4,5,6,7`:

| Map | Type | Key → value | Writer |
|---|---|---|---|
| `kl_exec_allowed_sb` | `BPF_MAP_TYPE_HASH`, 65 536 entries | `u32 s_dev` (kernel `dev_t`, below) → `u32 gen_index` | warden core only |
| `kl_exec_jit_cgroups` | `BPF_MAP_TYPE_HASH`, 4 096 entries | `u64 cgroup_id` → `u8 1` | warden core only |
| `kl_exec_policy` | `BPF_MAP_TYPE_ARRAY`, 1 entry | `u32 0` → `struct {u8 enforce; u8 audit_allow; u8 phase; u8 pad; u32 warden_tgid;}` | boot only, then frozen (`bpf_map_freeze`) after `warden_tgid` is written at hand-over |
| `kl_exec_events` | `BPF_MAP_TYPE_RINGBUF`, 1 MiB | denial events `{u64 cgroup_id; u32 pid; u32 hook; u32 s_dev; u64 ino;}` | warden core (reader) |
| `kl_debug_pairs` | `BPF_MAP_TYPE_HASH`, 256 entries | `u64 tracer_cgroup_id` → `struct {u64 target_cgroup_id; u64 expires_boottime_ns; u8 scope;}` (scope 0 = process, 1 = kernel) | warden core only (`DebugAttach`) |

Internal maps of the program (for example the LRU map that limits the `perf_event_alloc` check to `perf_event_open(2)` requests) are not handed over and are not part of this contract.

**Numeric values.** Decoders (`warden`, `journal`, tools) rely on these:
- `kl_exec_policy.phase`: INITRD = 0, SYSTEM = 1. `enforce` = 1 refuses denials; `enforce` = 0 is permissive (denials are logged and allowed; development only). `audit_allow` = 1 also logs allowed decisions.
- `kl_exec_events.hook` IDs: 1 `bprm_check_security`, 2 `mmap_file`, 3 `file_mprotect`, 4 `kernel_read_file`, 5 `kernel_load_data`, 6 `bpf`, 7 `ptrace_access_check`, 8 `perf_event_open`, 9 `bprm_creds_for_exec`, 10 `perf_event_alloc`; bit 31 set marks an audit-allow record. The C layout has 4 bytes of padding before `ino` (record size 32 bytes).
- File hooks carry the file's superblock `s_dev` and inode number (anonymous mappings: 0, 0). Other hooks reuse the two fields: `kernel_load_data` `s_dev` = the `kernel_load_data_id`; `bpf` `s_dev` = the command, `ino` = the program type for `BPF_PROG_LOAD`; `ptrace_access_check` `s_dev` = the mode, `ino` = the tracee's thread-group ID; `perf_event_open` `s_dev` = the `PERF_SECURITY_*` type; `perf_event_alloc` `s_dev` = 1 task event, 2 cgroup event, 3 CPU-wide event, `ino` = the target cgroup ID when known.
- `s_dev` everywhere is the **kernel** encoding of `super_block.s_dev` (`MKDEV`: `major << 20 | minor`), not the userspace `st_dev`/`makedev()` encoding. Registrants convert `statx`'s `stx_dev_major`/`stx_dev_minor`.

**Links.** The program's hooks are attached with `BPF_LINK_CREATE` links and live exactly as long as a link fd is open (no bpffs pins after `switch_root`). `boot` passes the ten link fds to `warden` as fds 9–18, one per hook row, in no particular order, with `keylos.execlinkfds=9,10,11,12,13,14,15,16,17,18` in `warden`'s argv (the boot report is fd 8, §20.1). The `warden` core MUST keep them open for its lifetime and never closes or passes them on; closing them detaches `kl-exec`.

**Registering a generation.** Before adding a mount's superblock to `kl_exec_allowed_sb`, the registrant (`boot` for the OS and bootstrap generations; `warden` for everything else, including mounts it makes on behalf of `bench` and `compat`) MUST:
1. obtain the tree from `depot.mount` (or mount it itself with `verity=require` from a digest-checked image, as `boot` does);
2. verify the generation statement (§20.7) DSSE signatures against the **boot trust set** (§20.1): release-stream keys for distro generations, publisher keys enabled in the config generation, and the owner-seal keys for owner-sealed generations;
3. check the generation is not listed `unlaunchable` in the current revocation list (§11.7);
4. read the superblock device with `statx(tree_fd, "", AT_EMPTY_PATH)` and convert it to the kernel `dev_t` (`stx_dev_major << 20 | stx_dev_minor`).

The decision is sound because the composefs overlay was mounted with `verity=require` from an image whose digest was checked, overlay superblocks are not shared across mounts from different images, and only `warden` can update the map. Writable mounts are always `noexec` in addition.

**Second layer: IPE.** IPE runs a policy signed by `kernel-policy/<stream>`:

```
policy_name=keylos policy_version=1.0.0
DEFAULT action=ALLOW
op=KEXEC_IMAGE action=DENY
op=KEXEC_INITRAMFS action=DENY
op=EXECUTE boot_verified=TRUE action=ALLOW
op=KERNEL_READ boot_verified=TRUE action=ALLOW
```

**Other code paths:**
- `module.sig_enforce=1`. Modules load only from the OS generation or from a **`kmod` generation** (§6.1), and every module MUST carry a signature by the release stream's module-signing key: only project-built, release-signed out-of-tree modules exist. Owner-sealed modules are impossible by design (lockdown enforces module signatures, and owners hold no module-signing key). `warden` registers a `kmod` generation's mount only if its manifest `kmod.kernel` equals the running kernel release.
- `vm.memfd_noexec=2`; `kernel.unprivileged_bpf_disabled=2`; signed BPF loaders only for `boot` and `warden`.
- **Service BPF programs.** Some tier-0 services need BPF programs (strata provenance, net firewall helpers, gate accounting). `warden` loads them only from the **OS generation**, from `/usr/lib/keylos/bpf/<service>/<program>.o` files listed for that service in `services.json` (§20.16), before starting the service; it attaches them and passes their map fds to the service as `KEYLOS_BPF_FDS` (§10.5). Services never call `bpf()` themselves.
- **Grant ceilings.** The warden core loads a label-ceiling LSM program (`kl-label`, separate from the `kl-exec` hand-over) that enforces the exposure label of directory grants (§7.3.3, §14.1): an `open` through a grant mount, and a read through an fd opened through one, fails with `-EACCES` when the object's `security.bpf.keylos.label` (§10.4) exceeds the grant's ceiling or is malformed. `kl-label` attaches `file_open` and `file_permission` (plus `mmap_file` for reads through a mapping), keyed by the grant mount's ID in its map `kl_grant_ceiling`, and reads kernel structures at BTF-computed offsets as `kl-exec` does. Unlabelled objects get their location default (§14.1), except that on kernels without the `bpf-init-inode-xattr` feature an unlabelled object created after the grant was attached counts as `secret/untrusted`. Where `warden` cannot enforce ceilings, `attachGrant` gets a null ceiling and the broker MUST raise the holder to `secret/untrusted`.
- **JIT.** Generations with `needs.jit: true` get their cgroup added to `kl_exec_jit_cgroups` by `warden` and no `PR_SET_MDWE`.
- **Interpreters.** Interpreters shipped in keylos generations MUST honour `AT_EXECVE_CHECK` and the `SECBIT_EXEC_RESTRICT_FILE` / `SECBIT_EXEC_DENY_INTERACTIVE` securebits. `warden` sets both securebits on every host principal **except** the **trusted-terminal tree**, which gets only `SECBIT_EXEC_RESTRICT_FILE`.
- **Trusted-terminal tree.** The tree is the process spawned through `TrustedSpawn.spawnTerminal` and every process that `kish` running in it spawns as a job (foreground or background, including REPLs started from the prompt). A process spawned by any *other* program in that tree (for example an editor that spawns a helper) is outside the tree and gets both securebits; `warden` decides by the spawning principal's actor kind (`shell` from the trusted terminal) and the `SpawnSpec` origin, not by process ancestry alone.
- **Core dumps.** The kernel `core_pattern` pipe helper (`|/usr/lib/keylos/journal/coredump %P %s %t`) is started by the kernel in the root cgroup. This is the one userspace exception to "only the warden core runs in the root cgroup": the helper is an OS-generation binary, installs its own seccomp filter before reading any input, and **moves itself** into `/keylos.slice/system.slice/journal-coredump.scope` before reading the dump (cgroup v2 delegation rules allow only a process in the root cgroup's domain with root credentials to make that move; `journal` cannot). `journal` verifies the move and refuses dumps from a helper still in the root cgroup. `kl-exec`'s `bpf` rule does not depend on cgroup membership, so the exception grants it nothing. The helper is not exempt from `ptrace_access_check` either: it reads only `/proc/%P/{cgroup,status}` (not ptrace-guarded) and takes the crashed process's file mappings from the core's `NT_FILE` note, never from `/proc/%P/maps`.
- **Supervising without ptrace access.** Because `ptrace_access_check` exempts no task, `warden` and every other component observe and control other processes only through operations the hook does not guard: pidfds (from `clone3(CLONE_PIDFD)` or `pidfd_open`) for signals (`pidfd_send_signal`) and exit (`waitid(P_PIDFD)`), `PIDFD_GET_INFO` for credentials and the cgroup ID, `/proc/<pid>/{cgroup,status}`, and cgroup files. A child's namespace fds are captured at spawn: the child opens its own `/proc/self/ns/*` (a task's access to itself is not checked) and passes them to the spawner before its start barrier, and a mapping helper passes its own user-namespace fd the same way. No keylos component opens another task's `/proc/<pid>/{ns/*,root,cwd,fd,maps,mem,environ}` or uses `PIDFD_GET_*_NAMESPACE`, `setns` on a pidfd, `pidfd_getfd`, `kcmp` or `process_vm_*` on another task, except a debugger or open broker within its `kl_debug_pairs` entry.
- **Known limitation (composefs `mprotect`).** For an overlay (composefs) file mapping the kernel passes the backing file to `file_mprotect`, whose superblock is not the registered overlay superblock, so adding `PROT_EXEC` to such a mapping with `mprotect` is refused outside JIT cgroups. `execve` and `mmap(PROT_EXEC)` see the overlay file and are unaffected; only text relocations and similar are refused. Generations needing them declare `needs.jit`.
- **Legacy open broker.** `compat` runs **one open-broker process per legacy app** (the `kl_debug_pairs` map holds one target per tracer). At `LegacySpawn` time (parameter `brokerSession`, §7.5.1) `warden` writes a `kl_debug_pairs` entry (scope `process`, no expiry while the app runs) from that open-broker process's cgroup to the legacy app's cgroup. For this pair `ptrace_access_check` permits `PTRACE_MODE_READ` and `PTRACE_MODE_ATTACH_REALCREDS` (the mode the kernel checks for `process_vm_readv`). The open broker runs with seccomp profile `openbroker-1`, which allows `process_vm_readv` and denies `ptrace`, `process_vm_writev` and `pidfd_getfd`, so the pairing yields read access to the app's memory for decoding seccomp-notification syscall arguments and nothing else.
- **Debugging (`Right.debug`).** A debug grant is minted only at tier T3 with presence, lasts at most 3 600 s (scope `process`) or 900 s (scope `kernel`), and is never minted to an agent principal unless the target session lies inside that agent's own session tree; agents never get scope `kernel` and never a `gen:` target. A request with `durationSecs = 0` resolves to the policy default before minting (default 900 s for `process`, 300 s for `kernel`). It is materialised by `Broker.debug` → `DebugAttach.attach` (§7.5.1): `warden` spawns the debugger generation (policy list `debug.debuggers`, e.g. gdb, lldb, perf, bpftrace) with seccomp profile `debug-1`, writes the `kl_debug_pairs` entry, and grants the debugger ambient capabilities: `CAP_SYS_PTRACE` and `CAP_PERFMON` for scope `process` (tracing another dynamic UID and opening cgroup-scoped perf events need them), plus `CAP_BPF` for scope `kernel`. `kl-exec`'s `ptrace_access_check`, `perf_event_open` and `bpf` hooks bound what those capabilities reach to the paired target. Receipts `debug.attach`/`debug.detach`. Inside workbench VMs debugging is unrestricted.
<!-- END protocols §9.3 -->

<!-- BEGIN protocols §10.1 (verbatim) -->
> **protocols 10.1 Host layout**

| Path | Content | Properties |
|---|---|---|
| `/` | OS generation (composefs, `verity=require`) | ro |
| `/usr` | Part of the OS generation | ro |
| `/etc` | Merged config generation (confext) | ro |
| `/var` | btrfs subvolume `@var` | rw, `nosuid,nodev,noexec` |
| `/home/<user>` | btrfs subvolume per user | rw, `nosuid,nodev,noexec` |
| `/home/<user>/.apps/<app-name>/{config,data,cache,state}` | Subvolume per app and user | the only writable paths in an app's view |
| `/store/objects/<2 hex>/<62 hex>` | Store objects, fs-verity enabled, mode 0444 | written only by `depot` |
| `/store/gens/<64 hex>.erofs` | Generation images | |
| `/store/evidence/` | Generation statements, attestations, consent records | `depot` |
| `/store/db/` | `depot` database | |
| `/store/rcpt/` | `ledger` data | |
| `/keystore` | btrfs subvolume `@keystore`, **excluded from all snapshots** | `vault`, `hearth`, `ledger`, `strata` key material (wrapped) |
| `/snapshots` | btrfs snapshot area, `strata` only | |
| `/run` | tmpfs | |
| `/run/keylos/svc/<svc>/` | Service socket directories | 0700 warden |
| `/run/keylos/boot/trust.json`, `report.json` | Boot trust set and boot report (§20.1) | 0444, written by `boot` |
| `/var/lib/keylos/<repo>/` | Each service's private state directory (other repos may read only the files listed in §10.7) | owned by the service's dynamic UID |
| `/var/lib/keylos/cri/images/` | OCI content store for `keylos-vm` pods (unsealed, never executed on the host) | `cri`; `noexec`; shared read-only into pod VMs |
| `/efi` | ESP | mounted only during updates (and by `boot` for `/efi/keylos/vbu-totp.sealed`) |

**App mount view** (what a tier-1 process sees):
- its app generation at `/` (with `/usr` from its runtime generation if it declares one);
- `/etc` filtered to the app-visible subset (`/etc/keylos/app-visible.list` in the config generation);
- its `.apps/<name>` subvolumes at `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `$XDG_CACHE_HOME`, `$XDG_STATE_HOME` (idmapped to its dynamic UID);
- `/run/user/<uid>/` with only its Wayland socket (security-context tagged) and its PipeWire remote if granted;
- `/grants/` (initially empty; runtime grants are attached here);
- `/tmp` as a private tmpfs;
- nothing else.
<!-- END protocols §10.1 -->

<!-- BEGIN protocols §10.3 (verbatim) -->
> **protocols 10.3 UIDs and cgroups**

**UIDs:**

| Range | Use |
|---|---|
| 0 | Kernel threads, `warden` (PID 1). No other process. |
| 1000–59999 | Humans (allocated by `hearth`) |
| 0x00100000–0x0FFEFFFF | Dynamic principal UIDs, allocated by `warden` per running principal instance. Quarantined for 60 s after release. |
| 0x0FFF0000 | Reserved on-disk owner of `_cluster` data (pod volumes, cri state); reached by containers only through idmapped mounts; never allocated to a process |
| 0x0FFF0001–0x0FFFFFFF | Reserved |
| 0x10000000–0x7FFEFFFF | Legacy-tier user-namespace ranges, 65536-UID blocks, allocated by `warden` |

**cgroups:**

```
/keylos.slice/system.slice/<service>.scope
/keylos.slice/user-<uid>.slice/{shell,apps,agents,benches,legacy}.slice/<session>.scope
/keylos.slice/kube.slice/<pod-id>.slice/<container-or-vm>.scope      (cgroup subtree delegated to cri)
/keylos.slice/guest-<id>.slice/…                                    (ephemeral guest sessions, removed at logout)
```
<!-- END protocols §10.3 -->

<!-- BEGIN protocols §10.5 (verbatim) -->
> **protocols 10.5 Environment conventions**

Processes receive:
- `KEYLOS_PRINCIPAL` (text)
- `KEYLOS_SESSION`
- `KEYLOS_TIER`
- `KEYLOS_CAPWIRE_FDS`: a comma list of `name=fdnum` for passed service sockets, for example `broker=3,portal-files=4`. Names follow the route-name rule below.
- `KEYLOS_ARGFD_<argname>` and `KEYLOS_PIPE_IN` / `KEYLOS_PIPE_OUT` (§12)
- `KEYLOS_TXN`: the strata transaction ID when spawned with `SpawnSpec.transaction`
- `KEYLOS_AGENT_HOST`: `vsock:2:7002` inside agent workbenches
- `KEYLOS_GUEST_PORTALS`: `vsock:2:7004` inside tier-2 guests
- `KEYLOS_BPF_FDS`: `name=fdnum` list of BPF map fds `warden` loaded for a tier-0 service (§9.3)
- `KEYLOS_TPM_FD`: for services whose `services.json` entry has `privileges.tpm: true`, the number of an inherited fd of `/dev/tpmrm0` that `warden` opened for the service; services use it as their TPM (for example TCTI `device:/proc/self/fd/<n>`) and never open TPM devices by path
- XDG variables, with paths per §10.1

In tier-0 services fd 3 is the `warden` bootstrap socket (`Bootstrap`, §7.5.1) and is not listed in `KEYLOS_CAPWIRE_FDS`.

**Route names in `KEYLOS_CAPWIRE_FDS`:**

| Route | Name |
|---|---|
| `<svc>#client`, `<svc>#default` | `<svc>` |
| `broker#principal` | `broker` |
| `warden#client`, `warden#service` | `warden` |
| any other `<svc>#<facet>` | `<svc>#<facet>` |

**Adopting inherited descriptors.** Programs take ownership of fd 3 and of the descriptors named in `KEYLOS_CAPWIRE_FDS`, `KEYLOS_BPF_FDS` and `KEYLOS_TPM_FD` exactly once at start-up through the `keylos-capwire` inheritance helper (§18), which checks that each fd is open and sets `FD_CLOEXEC`; programs need no `unsafe` code of their own for it.

**Development knobs.** Names starting with `KEYLOS_DEV_` are reserved for development-only settings, for example `KEYLOS_DEV_TPM_TCTI` (a TPM TCTI string such as `swtpm:host=127.0.0.1,port=2321`, which replaces `KEYLOS_TPM_FD`). Production builds never read them, and `warden` never sets them; only the development supervisor of a development image may. Every other development knob of a keylos component uses this prefix. The registered knobs are:

| Knob | Read by | Effect (development builds only) |
|---|---|---|
| `KEYLOS_DEV_TPM_TCTI` | every TPM-using service (vault, hearth, ledger, broker, strata, courier, config) | TPM TCTI string that replaces `KEYLOS_TPM_FD` |
| `KEYLOS_DEV_LEDGER_SELF_PROVISION` | ledger | `1`: on a fresh store with the counter `0x01300100` absent, define it itself (`x-devProvision`) instead of waiting for `HearthTpm.defineSpace`; never after hearth genesis |
| `KEYLOS_DEV_LEDGER_SAMPLE_EXPORT` | ledger (tests) | Directory for sample exports written by the privacy test harness |
| `KEYLOS_DEV_HEARTH_SOFT_AUTHENTICATOR` | hearth | Use a software FIDO2 authenticator instead of a CTAP2 device |
| `KEYLOS_DEV_BROKER_IMPLICIT_SESSIONS` | broker | `1`: register an unregistered `broker#principal` peer implicitly instead of failing `kl:denied` |
| `KEYLOS_DEV_BROKER_POLICY_DIR` | broker | Directory that replaces the warden-mounted `/policy` generation |
| `KEYLOS_DEV_BROKER_GENERATION` | broker | Generation ref used for the broker's own principal when `ServiceHost.accept` and `policy.ref` give none |
| `KEYLOS_DEV_TIME_TRUSTED` | broker, loom | `1`: treat the system clock as trusted without a `NetWatch` `timeTrusted` event |
| `KEYLOS_DEV_WATCHDOG_SECS` | broker and every other daemon with a `watchdogSecs` of its own (it reads the knob itself; the `warden-svc` host reads none) | Watchdog interval that replaces the manifest's `watchdogSecs` |
| `KEYLOS_DEV_LOOM_FAULTS` | loom | Comma list of fault-injection points (`crash:<point>`, `fsync-fail:<point>`, `enospc:<point>`, points named in the loom spec) for the durability acceptance tests |
| `KEYLOS_DEV_LOOM_CLOCK_SKEW_SECS` | loom | Signed offset added to loom's view of trusted time, for timer, expiry and long-downtime tests |

A knob that is not listed here MUST NOT be read by any component; a new knob is registered here before use.

No secrets, ever. Names starting with `KEYLOS_` are reserved; `SpawnSpec.env` MUST NOT set them, with one exception: a `shell` principal MAY set `KEYLOS_ARGFD_*`, `KEYLOS_PIPE_IN` and `KEYLOS_PIPE_OUT` (§12); `warden` verifies that every fd named in `KEYLOS_ARGFD_*` is present in `SpawnSpec.fds`.
<!-- END protocols §10.5 -->

<!-- BEGIN protocols §10.6 (verbatim) -->
> **protocols 10.6 Log records**

Processes write logs to the journal stream fd (fd 2 is connected to it by default) as:
- plain text lines, or
- **structured records**: a datagram whose first byte is `0x1E` followed by a CBOR map with keys `l` (level 0–7), `m` (message) and `f` (fields map), or
- **metrics records**: a datagram whose first byte is `0x1F` followed by a CBOR map with keys `n` (metric name), `t` (`"counter"` | `"gauge"` | `"histogram"`), `v` (number, or for histograms a map of bucket bound → count plus `sum` and `count`) and `l` (labels map).
<!-- END protocols §10.6 -->

<!-- BEGIN protocols §10.7 (verbatim) -->
> **protocols 10.7 Cross-repository files**

A repository MAY read a file written by another repository **only if the file is listed here**; everything else is that repository's private state.

| Path | Format | Writer | Readers |
|---|---|---|---|
| `/run/keylos/boot/trust.json`, `report.json` | `keylos.boottrust/1`, `keylos.bootreport/1` (§20.1) | boot | any tier-0 service, `vouch` tooling |
| `/etc/keylos/services.json` | `keylos.services/1` (§20.16) | config | warden, boot, ledger |
| `/etc/keylos/policy.ref` | `keylos.policyref/1` (§20.17) | config | warden, broker |
| `/etc/keylos/owner-seal/<i>.spki` | DER SubjectPublicKeyInfo | config | boot |
| `/etc/keylos/publishers.json` | `keylos.publishers/1` (§20.20) | config | boot, depot |
| `/etc/keylos/exceptions/*.dsse` | `keylos.exception/1` envelopes (§20.9) | config | depot, ledger, warden (effective tiers) |
| `/etc/keylos/strata/snapshot-exclude.list` | newline-separated absolute paths | config | strata, vault |
| `/etc/keylos/app-visible.list` | newline-separated paths under `/etc` | config | warden |
| `/store/evidence/<hex>/statement.dsse` | `keylos.genstmt/1` envelope (§20.7), `<hex>` = generation digest | depot | boot, warden |
| `/store/revocations/<stream>.dsse` | `keylos.revocations/1` envelope (§11.7) | depot | boot, warden |
| `/var/lib/keylos/config/*.dsse` | `keylos.configgen/1` envelopes (§15) | config | boot |
| `/var/lib/keylos/hearth/owners.log` | owner registry (§20.3) | hearth (installer at genesis; installer's `rescue` in the recovery profile: `recover` and credential entries) | boot (replay in the initrd); `config-recover` and `rescue` (recovery profile only) |
| `/var/lib/keylos/fleet/wipe.dsse` | wipe bundle: the §20.23 wipe command plus an owner quorum envelope of purpose `boot.wipe` (§20.2) | fleet | `rescue` (recovery profile only) |
| `/var/lib/keylos/tpm/nv-auth/<index>.sealed` | `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` of the sealed authValue object (§19.6, "Sealed secrets"); `<index>` is `0x` + 8 lowercase hex digits, e.g. `0x01300100.sealed` | installer at genesis; hearth on (re)definition (`HearthTpm.defineSpace`); `rescue` (recovery profile) | the index's registered owner service only |
| `/var/lib/keylos/tpm/hierarchy-owner.sealed`, `hierarchy-endorsement.sealed` | TPM-sealed hierarchy authValues (§19.6) | installer at genesis; hearth on rotation | hearth |
| `/var/lib/keylos/tpm/hierarchy-owner.recovery` | HPKE (§4) ciphertext of the owner-hierarchy authValue to the recovery recipient (§20.21) | installer; hearth on rotation | recovery environment |
| `/var/lib/keylos/hearth/seal-gate-<i>.sealed` | quorum seal-gate blob (§19.6) | installer at genesis (quorum machines); hearth | hearth |
| `/var/lib/keylos/hearth/platform/<keyid>.blob` | assisted platform authenticator blob: JCS `{rpId, credentialId, cose, salt, key, hmacKey}` (§5.3) | installer (assisted credential enrolled at install); hearth | hearth |
| `/var/lib/keylos/recovery/recipient.pub` | 32-byte raw X25519 public key of the recovery recipient (§20.21) | installer | vault, hearth |
| `/var/lib/keylos/recovery/pending/<ULID>.dsse` | `keylos.pendingreceipt/1` (§20.22) | recovery environment (`rescue`, installer repo) | ledger (appends at the next normal boot, then deletes) |
| `/var/lib/keylos/devd/preauthorized.json` | `keylos.preauth/1` (§9.5) | installer | devd |
| `/etc/keylos/fleet/approvers.json` | `keylos.fleetapprovers/1` (§20.23); the only source of org approver keys | config (fleet module) | hearth, rescue (recovery environment), broker |
| `/keystore/ledger/signing.sealed` | TPM-sealed Ed25519 seed of the machine key | installer | ledger (MUST accept an existing key) |
| `/var/lib/keylos/firstboot/bundle.json` | `keylos.firstboot/1` (§20.13) | installer | the consumers listed in §20.13 |
| `/efi/keylos/vbu-totp.sealed` | sealed 20-byte TOTP secret (§20.5) | installer (`keylos-enrol vbu-totp`) | boot |
| `/usr/lib/keylos/bpf/<service>/*.o` | BPF ELF objects in the OS generation | pkgs (build) | warden |
| `/run/keylos/gate/ca.pem` (inside tier-L views) | PEM CA bundle of the principal's gate shim | gate | compat (sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`) |
| kernel command line `keylos.revocations=<serial>:<sha256>` | revocation list pin of the UKI's own release | release build (inside the signed UKI command line; `courier` only verifies it at staging) | boot |

**Per-service configuration files.** `/etc/keylos/<service>.json` and `/etc/<service>/*` are rendered by `config` and read only by that service; they need no row here, and their formats are defined in the service's own spec.

**Durable-execution state.** The durable records of §20.25 are private state of their owners (no other repository reads them); each lives in exactly one place, on persistent storage, behind a checked durability barrier:

| State | Owner | Location |
|---|---|---|
| Workflow store: enrollments, runs, steps, attempts, observations, timers, signals, tombstones, receipt outbox | loom | `/var/lib/keylos/loom/loom.db` (SQLite WAL, `synchronous=FULL`) and `/var/lib/keylos/loom/blobs/` |
| Workflow records (enrollment scope, epoch, label high-water mark, cancellation) and durable decisions | broker | `/var/lib/keylos/broker/workflows/`, `/var/lib/keylos/broker/decisions/` |
| Durable effect records and workflow budget accounts | gate | `/var/lib/keylos/gate/outbox.redb` (tables `effects`, `effects_by_workflow`), `/var/lib/keylos/gate/meter.redb` (table `accounts`) |
| Prepared-merge completion records | strata | strata's registry (strata spec) |

None of them may live in `warden`'s `FdStore`, under `/run`, in a diagnostic snapshot, or only in a ledger receipt.
<!-- END protocols §10.7 -->

<!-- BEGIN protocols §13.1 (verbatim) -->
> **protocols 13.1 Receipt payload (`keylos.receipt/1`)**

```json
{
  "schema": "keylos.receipt/1",
  "seq": 1042,
  "prev": "rcpt:sha256:…",
  "time": "2026-10-07T21:30:00.123456789Z",
  "writer": "service:broker:gen:fsv256:…@_system/s-…",
  "subject": "agent:gen:fsv256:…@alice/s-…",
  "event": "grant.issue",
  "data": {"rootId": "t-…", "rights": ["path:/home/alice/src/proj:read"], "expires": "…"},
  "label": {"conf": "private", "integ": "untrusted"},
  "approval": null
}
```

Rules:
- `seq` and `prev` are assigned by `ledger`. The writer signs the payload with `seq: 0` and `prev: null` (the **submitted form**); `ledger` fills them in, countersigns the final payload, and stores both signatures with the submitted form's digest. Verifiers reconstruct the submitted form (set `seq` to 0 and `prev` to null) to verify the writer's signature, and verify `service/ledger`'s signature over the final payload.
- **Signatures.** The stored envelope carries exactly two signatures, in this order: the writer's (over the PAE of the submitted form), then `service/ledger`'s (over the PAE of the final payload). They are told apart by `keyid`; signature objects carry no other members (no `scope`).
- **Ledger-originated receipts** (events the ledger writes itself, such as its own `ledger.key.register`, `ledger.alarm`, `ledger.redact` and `ledger.shred`): `writer` is the ledger's own principal and so is `subject`, except for replays of spooled receipts (§20.22), which keep the original subject and are sealed exactly when §13.4 requires it (a person's subject); a receipt whose subject is the ledger is never sealed. The envelope carries exactly one signature, `service/ledger`'s over the final payload; there is no submitted-form signature. `subject` is never empty: a writer whose event has no natural subject names its own principal. The first receipt of an empty ledger, and of every ledger epoch after an alarm, is the ledger's own `ledger.key.register {service: "ledger", spki, keyRef}`, so readers obtain the machine key through `Ledger.serviceKey("ledger")`. Verifiers (`keylos-formats`) accept both forms.
- **Time order.** `time` is non-decreasing in `seq`. The ledger orders each group commit by (`time`, arrival) before assigning sequence numbers, and refuses a submission whose `time` is earlier than the current head's with `kl:invalid` and a message containing `re-sign`. The writer then rebuilds the submitted form with a fresh `time`, signs it again and resubmits (writer libraries do this, with bounded retries). A resubmission is a new submission; the ledger does not deduplicate, and logical deduplication is the writer's responsibility. The rule keeps every month unit, retention cut and `since`/`until` range a contiguous `seq` range, so a late receipt can never land in a month that was already shredded or expired.
- Event names are registered in §19.3.
- Receipts with personal payloads carry `sealed` instead of clear `data` and `label` (§13.4).
<!-- END protocols §13.1 -->

<!-- BEGIN protocols §16.1 (verbatim) -->
> **protocols 16.1 Schema**

Namespace `Keylos`. Policies are authored in config and compiled into `policy` generations. The `broker` evaluates every request with:
- principal = `Keylos::Principal`
- action = `Keylos::Action::"<op>"`
- resource = one of the entity types below
- context = request context

```
namespace Keylos {
  entity Human = { owner: Bool, guest: Bool };
  entity Principal in [Human] = {
    kind: String,              // app | service | agent | legacy | bench | shell | pod
    human: String,             // the principal's human ("_system", "_cluster" or a username)
    humanOwner: Bool,
    humanGuest: Bool,
    generationName: String,
    generation: String,
    tier: String,
    depth: Long,
    label: { conf: String, integ: String },
  };
  entity Path = { root: String, rel: String, labelConf: String, labelInteg: String };
  entity Host = { name: String, port: Long, sinkSafe: Bool, trusted: Bool };
  entity Device = { subsystem: String };
  entity Secret = { owner: String };
  entity Effect = { kind: String, class: String };
  entity Generation = { name: String, publisher: String, reproducible: Bool };
  entity Service = { name: String, facet: String };
  entity Budget = { unit: String };
  entity DebugTarget = { target: String, scope: String, targetHuman: String, targetKind: String };
  entity PodSpec = {
    namespace: String, name: String, runtimeClass: String,
    serviceAccount: String, labels: Set<String>,                    // Kubernetes labels as "key=value" strings
    images: Set<String>,                                            // "oci:sha256:…" or "gen:fsv256:…"
    privileged: Bool, hostNetwork: Bool, hostPID: Bool, hostIPC: Bool,
    hostPaths: Set<String>, hostPathsReadOnly: Bool,
    addedCapabilities: Set<String>, seccompProfile: String, appArmorProfile: String,
    runAsRoot: Bool, allowPrivilegeEscalation: Bool,
    gpuPassthrough: Long, csiDrivers: Set<String>, volumeTypes: Set<String>,
    cpuMillis: Long, memoryBytes: Long,
    allImagesSealed: Bool,                                          // every image is a gen: container generation (computed by cri)
  };
  entity Screen = { window: String, app: String };
  entity Model = { provider: String, model: String, version: String };
  entity Workflow = {
    definitionName: String, definition: String,                    // workflow name, "gen:fsv256:…" of its generation
    owner: String,                                                  // the owning human
    autoResume: Bool, runWhileLocked: Bool, horizonSecs: Long,
    scopeKinds: Set<String>,                                        // resource kinds of the enrollment scope ("path", "net", …)
    effectKinds: Set<String>,                                       // effect kinds the definition may commit
  };

  action "read", "write", "create", "delete", "exec" appliesTo { principal: Principal, resource: Path, context: Ctx };
  action "connect", "bind" appliesTo { principal: Principal, resource: Host, context: Ctx };
  action "use" appliesTo { principal: Principal, resource: [Device, Secret, Service, Model], context: Ctx };
  action "snapshot" appliesTo { principal: Principal, resource: Screen, context: Ctx };
  action "spend" appliesTo { principal: Principal, resource: Budget, context: Ctx };
  action "spawn" appliesTo { principal: Principal, resource: Generation, context: Ctx };
  action "stage", "commit" appliesTo { principal: Principal, resource: Effect, context: Ctx };
  action "delegate" appliesTo { principal: Principal, resource: Principal, context: Ctx };
  action "debug" appliesTo { principal: Principal, resource: DebugTarget, context: Ctx };
  action "admit" appliesTo { principal: Principal, resource: PodSpec, context: Ctx };   // principal = service:kubelet / cri
  action "enroll", "resume", "cancel" appliesTo { principal: Principal, resource: Workflow, context: Ctx };   // §20.25
  type Ctx = { time: Long, persist: Bool, durationSecs: Long, reason: String, approvalTier: String,
               amount?: Long, channel?: String, approver?: String,
               offlineDays?: Long, profile?: String, integrityProfile?: String, requester?: String,
               workflow?: String, epoch?: Long };            // workflow: the wf-… a request is decided for (§20.25); epoch: its claim
}
```

The distribution's default policy MUST contain at least these `admit` forbids: `privileged`, `hostNetwork`, `hostPID`, `hostIPC`, non-empty `addedCapabilities`, `seccompProfile == "unconfined"`, `allowPrivilegeEscalation`, and any `hostPaths` outside the read-only allowlist `cluster.hostPathAllowlist` (default empty). `runtimeClass == "keylos-sealed"` additionally requires `allImagesSealed` (every image is a `gen:` reference to a `container` generation; `cri` computes the attribute because Cedar has no quantifiers over sets). Policies about the same human (debug targets, family and guest rules) compare `principal.human` with `resource.targetHuman` or `context.requester`.

**Workflow decisions** (§20.25). `enroll`, `resume` and `cancel` are evaluated with the requesting session as principal and the `Workflow` entity as resource. Requests decided for a workflow without a live requesting session (attempt grants at registration, `BrokerWorkflow.authorizeEffect`, `decide`) are evaluated with a principal entity built from the workflow record: `kind` = the actor kind of the definition's generation (`app`, `service`, or `agent` for agent activities), `human` = the owner, `generationName`/`generation` of the activity's generation, `depth` = 1, `label` = the workflow label high-water mark, and `context.workflow`/`context.epoch` set. The default policy MUST contain: `enroll` only by a non-guest owner-or-user `shell` (or `atrium` for it) for workflows the human owns, with tier ≥ t2, and presence when `autoResume` or `runWhileLocked`; `resume` by the owner's `shell` at t0; `cancel` by the owner's `shell` (also when `aide` relays the owner's `AgentSession.stop`, `LoomSystem.cancelRequested`) and by owner `shell`s of the machine, at t0. Enrollment scope items are evaluated as persistent requests (`context.persist = true`).
<!-- END protocols §16.1 -->

<!-- BEGIN protocols §16.2 (verbatim) -->
> **protocols 16.2 Decision mapping and annotations**

- `forbid` wins.
- `permit` with annotation `@tier("t2")` or `@tier("t3")` means "permitted after approval at that tier".
- `permit` with `@presence("true")` requires presence regardless of tier.
- `permit` with `@orgApproval("<group>")` means "permitted after an approval decided by `OrgDecider.decide` for that approver group" (fleet-enrolled machines only); `context.channel` is `"org"` and `context.approver` the approver key ref during evaluation of the resulting mandate.
- **Evaluation order** when a permit carries both `@tier` and `@orgApproval`: the local tier approval (trusted path, or phone if allowed) is obtained **first**; only after it is granted is `OrgDecider.decide` called. Both decisions are required, and the delivered mandate records both (`channel: "org"`, with the local decision's digest in `constraints.localDecision`). On BYOD fleet machines org policies MUST use this form for effects that touch the owner's personal data.
- `permit` with `@channels("local,phone")` lists the approval channels allowed for that permit (default `local`).
- A `permit` without a tier annotation means **T1 for action `connect`** and **T0 otherwise**.
- **Several matching permits** combine to the most restrictive requirement: the highest `@tier`, presence if any permit requires it, every `@orgApproval` group, and the intersection of the `@channels` sets (an empty intersection denies). `phone` never satisfies presence and is dropped when presence is required; on quorum machines presence is satisfied through the `quorum` channel.
- Annotation values: `@tier` ∈ `t0`…`t3`; `@presence` ∈ `"true"`/`"false"`; `@channels` a comma-separated subset of `local`, `phone`; anything else fails closed (deny). `@presence("true")` requires a synchronous trusted-path prompt with presence whatever the tier. `@orgApproval` without `@tier` needs no local interaction; on machines that are not fleet-enrolled such permits are ignored. Policies carry an `@id("<name>")` annotation, used in receipts and diagnostics.
- No matching `permit` means `denied`.
- On fleet-enrolled machines, org `forbid` policies are loaded into the same policy set and cannot be overridden by owner `permit`s.
<!-- END protocols §16.2 -->

<!-- BEGIN protocols §19.1 rows=cri|kubelet|kube-proxy|Service \| (verbatim) -->
> **protocols 19.1 Service names** (rows for this repository)

| Service | Repo | Tier | Notes |
|---|---|---|---|
| `cri` | cri | t0 | CRI v1 server; `server-k8s` profile only (§21) |
| `kubelet` | pkgs (upstream, sealed) | t1 service | Holds no root; route `cri#kubelet`; `server-k8s` only |
| `kube-proxy` | pkgs (upstream, sealed) | t1 service | `CAP_NET_ADMIN` only inside the cri network namespace; `server-k8s` only |
<!-- END protocols §19.1 rows=cri|kubelet|kube-proxy|Service \| -->

<!-- BEGIN protocols §19.2 rows=\bcri\b|\| ledger \| .writer.|\| journal \| .client.|\| gate \| .shim. (verbatim) -->
> **protocols 19.2 Facets** (rows for this repository)

Every route names exactly one facet. Servers MUST implement exactly these facets; holders other than those listed are routed only when policy explicitly grants `right("service", "<svc>#<facet>", "use")`.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| warden | `cri` | cri | `PodSpawn`; `GrantMounts.idmappedDir`; `PrincipalControl.terminate`/`events` (pod sessions only) |
| broker | `system` | warden, gate, aide, atrium, config, hearth, strata, net, depot, vault, vouch, cri | `BrokerSystem` (per-method callers as commented in §7.5.2; `requestFor` with the allowed-subject rule, atrium only for its own session (device authorization); `registerApprover`: atrium, vouch; `admitPod`: cri; `mintCaptive`: net); `Broker.inspect` |
| ledger | `writer` | tier-0 services listed as writers in §19.3 | `Ledger` (all) |
| gate | `shim` | per-principal endpoints created by warden (tier L) and bench (bench-net per VM) | `ShimEndpoint` |
| net | `plumbing` | warden, gate, cri | `NetPlumbing` (`setEgressUids`, `setLocalLinkUids`: warden; `setListenPorts`: gate); `NetPlumbingCluster` (`clusterUplink`: cri; `clusterNetns`: warden) |
| depot | `mounter` | warden, bench, compat | `mount` (container generations only while rooted by `cri:pod:…`), `get`, `root`, `unroot`, `revocationStatus` |
| depot | `cri` | cri | `install` (sources `oci+container://` and `tuf:`), `get`, `list`, `root`, `unroot` |
| strata | `cri` | cri | `StrataVolumes` |
| devd | `cri` | cri | `MediaAttach` |
| journal | `client` | every principal | `writer`, `query`/`follow` (own), `Crashes` (own human), `Metrics` (own) |
| bench | `cri` | cri | `start` (purpose pod), `reattach`, `Vm` (all, including `attachShare`/`detachShare`, `attachBlock`/`detachBlock`, `info`) |
| fleet | `cluster` | cri | `FleetCluster` (`joinChallenge`, `joinAttested`, `clusterCertificate`, `kubeletCertificate`) |
| cri | `kubelet` | kubelet | CRI v1 gRPC (`RuntimeService`, `ImageService`) over the `AF_UNIX` stream socket (§21) |
| cri | `admin` | owner `shell` | `CriAdmin` (all) |
| cri | `status` | fleet, atrium | `CriAdmin.pods`, `node`, `images` |
<!-- END protocols §19.2 rows=\bcri\b|\| ledger \| .writer.|\| journal \| .client.|\| gate \| .shim. -->

<!-- BEGIN protocols §19.3 rows=pod\.|Event \| (verbatim) -->
> **protocols 19.3 Receipt events** (rows for this repository)

| Event | Writer |
|---|---|
| `pod.admit`, `pod.deny`, `pod.start`, `pod.stop` | cri |
<!-- END protocols §19.3 rows=pod\.|Event \| -->

<!-- BEGIN protocols §19.4 rows=podspec|cri\.state (verbatim) -->
> **protocols 19.4 Media types and formats** (rows for this repository)

| Schema | Media type | Owner (full definition) | Purpose |
|---|---|---|---|
| `keylos.podspec/1` | (JCS JSON, Cedar input) | protocols §21.3 | Normalised pod admission input |
| `keylos.cri.state/1` | (cri-internal) | cri | Pod and image state |
<!-- END protocols §19.4 rows=podspec|cri\.state -->

<!-- BEGIN protocols §19.6 (verbatim) -->
> **protocols 19.6 TPM objects**

All keylos NV indices live in the owner-hierarchy NV range block **0x01300100–0x013001FF**.

**Common NV attributes.** Every keylos NV index has `TPMA_NV_OWNERREAD | TPMA_NV_AUTHREAD | TPMA_NV_POLICYREAD`, `TPMA_NV_NO_DA` unless stated otherwise, and `TPMA_NV_PLATFORMCREATE` clear. Its authPolicy is `PolicyOR{PolicyCommandCode(TPM2_CC_NV_Read), <write policy>}` where the index has a write policy, else `PolicyCommandCode(TPM2_CC_NV_Read)` alone, so **anyone with TPM access can read** counters, floors and heads (their contents are integrity-relevant, not secret) while writes stay controlled. Exception: the two `vault-epoch` indices are secret: `AUTHREAD | AUTHWRITE | NO_DA`, `OWNERREAD` and `POLICYREAD` clear, and an **empty authPolicy**, so every read and write needs the index's authValue, which is sealed like the others (PCR11 `ready` ∧ PCR15). Services that write an index hold its authValue as a TPM-sealed secret (`/var/lib/keylos/tpm/nv-auth/0x<8 lowercase hex>.sealed`, §10.7) bound to the signed PCR11 `ready` phase and PCR15 (volume identity).

**Sealed secrets.** Every secret this section calls "sealed to PCR11 `ready` ∧ PCR15" (NV authValue files, hierarchy blobs, service keys, quorum seal-gate blobs, the vault system key) is a keyedHash **sealed data object** created under the SRK `0x81000001`: nameAlg SHA-256; attributes `fixedTPM | fixedParent | adminWithPolicy | noDA`, with `userWithAuth` and `sensitiveDataOrigin` clear; empty authValue; the secret as sensitive data. It is stored as `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` (each marshalled with its size prefix).
- **Production authPolicy:** `PolicyAuthorize(release-stream PCR11 key, the signed policy for phase "ready")` followed by `PolicyPCR(sha256:{15})`; the approved policy the release key signs is `PolicyPCR(sha256:{11})` at the `ready` value (§20.6).
- **Development fallback:** `PolicyPCR(sha256:{15})` alone, used only by development builds where no signed PCR11 policy exists. Readers identify the variant by comparing the object's authPolicy with both digests; production builds accept only the production digest.

NV authValue files are written by the installer at genesis, by `hearth` whenever it (re)defines an index (`HearthTpm.defineSpace`, §7.5.3), and by `rescue`; each is read only by the index's registered owner.

**Hierarchy authorization.**
- **Owner hierarchy:** set at install to a random 32-byte value, stored as a TPM-sealed blob for `hearth` (PCR11 `ready` ∧ PCR15, `/var/lib/keylos/tpm/hierarchy-owner.sealed`) and, for recovery, as an HPKE ciphertext to the recovery recipient (`hierarchy-owner.recovery`, §20.21); `hearth` rewrites both when it rotates the value. `hearth` is the sole userspace holder of owner-hierarchy operations and exposes the needed ones through `HearthTpm` (§7.5.3). `boot` reads NV in the initrd through the `PolicyCommandCode(NV_Read)` branch; it never needs owner auth.
- **Endorsement hierarchy:** set to a random value sealed like the owner auth (used only for AK/AK0 provisioning).
- **Lockout:** random value derived as HKDF-SHA256(recovery key, "keylos-lockout/1"); only the recovery environment uses it.

| NV index | Name | Type and size | Write authorization | Owner |
|---|---|---|---|---|
| `0x01300100` | ledger-counter | counter | AUTHWRITE, authValue sealed to `ledger` | ledger |
| `0x01300101` | config-counter | counter | AUTHWRITE, authValue sealed to `config` | config (read by boot) |
| `0x01300102` | os-floor | ordinary, 8 bytes, u64 big-endian (minimum bootable release `seq`); `POLICYWRITE`, empty authValue (public reads, including `PolicyNV`) | `PolicyAuthorize(release-stream key, policyRef "keylos/floor-write/1")` over **exact-target** approved policies ("Floor writes" below) | courier, installer (read by boot) |
| `0x01300103` | pcrlock-policy | ordinary, 34 bytes (TPM2B_DIGEST) | `PolicyAuthorize(release-stream key, "keylos/pcrlock-write/1")` or `PolicySecret(recovery auth object 0x81000105)`; the index authPolicy is the **flat** `PolicyOR{PolicyCommandCode(NV_Read), PolicyAuthorize(…), PolicySecret(…)}` (never nested) | courier, boot (recovery) |
| `0x01300104` | keystore-floor | counter | AUTHWRITE, authValue sealed to `vault` | vault |
| `0x01300105` | owner-registry-head | ordinary, 104 bytes: SHA-256(last registry line) ‖ u64 BE seq ‖ SHA-256(JCS owner-presence key set) ‖ SHA-256(JCS owner Secure Boot certificate set) | AUTHWRITE, authValue sealed to `hearth` (installer at genesis) | hearth (read by boot) |
| `0x01300106` | login-failure-counter | counter | AUTHWRITE, authValue sealed to `hearth` | hearth |
| `0x01300107` | strata-anchor-counter | counter | AUTHWRITE, authValue sealed to `strata` | strata |
| `0x01300108` | attestation-key-names | ordinary, 68 bytes: Name(AK) ‖ Name(AK0) | owner authorization at enrolment | installer, boot (read by vouch tooling) |
| `0x01300110` | vault-epoch/0 | ordinary, 40 bytes: epoch key (32) ‖ u64 BE epoch; an all-zero key means erased | authValue (`AUTHREAD | AUTHWRITE`, empty authPolicy; authValue sealed to PCR11 `ready` ∧ PCR15 in `nv-auth/0x01300110.sealed`) | vault |
| `0x01300111` | vault-epoch/1 | same as vault-epoch/0; the two alternate as active and candidate index (vault §4.5.1) | authValue (as vault-epoch/0, `nv-auth/0x01300111.sealed`) | vault |
| `0x01300140 + i` (i < 16) | seal-gate/i | ordinary, 1 byte, used for its authValue; common attributes (`OWNERREAD`, `AUTHREAD`, `POLICYREAD`) plus `POLICYWRITE`; NO_DA **not** set. authPolicy = `PolicyOR{PolicyCommandCode(NV_Read), PolicyCommandCode(NV_ChangeAuth) ∧ PolicyAuthValue}` | `PolicyCommandCode(NV_ChangeAuth) ∧ PolicyAuthValue` | hearth |

**Seal-gate salts.** The FIDO2 `hmac-secret` salts for owner *i*'s window *k* are `s_k = SHA-256("keylos-seal" ‖ u64_be(k))` (k encoded as 8 bytes, big-endian), and the assertion carries `(s_k, s_{k+1})`. On **quorum** machines (§5.4) the next authValue is held in a TPM-sealed blob `/var/lib/keylos/hearth/seal-gate-<i>.sealed` (PCR11 `ready` ∧ PCR15) and released by `hearth` only after a verified quorum envelope of purpose `seal.window`.

**Changing a seal gate's authValue.** `TPM2_NV_ChangeAuth` under the gate's policy and "undefine, then define again with the identical template and the new authValue" (owner authorization, after proving the current authValue) are equivalent: the NV Name excludes the authValue and a gate is never written, so its Name, and every `PolicySecret` binding to it, is unchanged. With the second method `hearth` seals the new authValue durably before the undefine, and a start that finds a registered gate absent defines it again with that pending value.

**Floor writes.** For every UKI it releases, the release stream signs exactly one approved policy for `keylos/floor-write/1`, bound to that UKI's measured PCR11 value and to exactly one target value *F*:
- OS UKI (phase `ready`): `PolicyPCR(sha256:{11})` ∧ `PolicyNV(0x01300102, operand u64_be(F), offset 0, TPM_EO_UNSIGNED_LE)` (current floor ≤ *F*) ∧ `PolicyCpHash(TPM2_NV_Write(authHandle 0x01300102, nvIndex 0x01300102, data u64_be(F), offset 0))`, with *F* = the release's `floor` (§20.6).
- Installer UKI and the cloud UKI's `seed` profile: `PolicyPCR(sha256:{11})` ∧ `PolicyNvWritten(NO)` ∧ `PolicyCpHash(…write F…)`: initialisation of a freshly defined index only.
Two releases MUST NOT carry different *F* for the same UKI digest. In one measured boot only one target is therefore writable: concurrent or stale policy sessions can only write the same *F*, an older release's policy does not match PCR11, and a write never lowers the floor because `PolicyNV` refuses it when the current value exceeds *F* (the guarantee assumes the release-stream key is not compromised). The value written is exactly *F*, never an intermediate one; a lost acknowledgment is answered by writing *F* again. A missing or unreadable `os-floor` after provisioning (TPM clear, interrupted write) is a recovery and re-enrolment condition, never silently reconstructed: the recovery environment defines the index again and initialises it with the floor of the signed release statement of the release being re-enrolled, and reports that hardware floor history was lost.

| Persistent handle | Hierarchy | Object | Registered owner |
|---|---|---|---|
| `0x81000001` | owner | SRK (ECC P-256, TCG standard template); its public key is pinned at enrolment | hearth (installer at genesis) |
| `0x81000101` | owner | Owner Secure Boot KEK signer (RSA-2048). Policy: with one owner, `PolicySecret(seal-gate/0)`; with two or more, `PolicyOR` over `PolicySecret(seal-gate/i)` of the enrolled owners (`PolicyOR` needs ≥ 2 branches). Adding or removing an owner re-creates both signers and re-enrols them in firmware (documented ceremony) | hearth (installer at genesis) |
| `0x81000102` | owner | Owner Secure Boot db signer (RSA-2048); same policy | hearth (installer at genesis) |
| `0x81000103` | owner | First-boot vault seed key: ECC P-256 decrypt key for HPKE DHKEM(P-256, HKDF-SHA256) (§4), sealed to the boot policy; evicted at first boot (`HearthTpm.evict`) | vault (`evict` only) |
| `0x81000105` | owner | Recovery auth object; authValue = HKDF-SHA256(recovery key, "keylos-recovery-auth/1") | hearth (installer at genesis) |
| `0x81000110` | owner | strata anchor HMAC key; policy `PolicyPCR(15) ∧ PolicyNV(0x01300107 ≥ 1)` | strata |
| `0x81000120` | owner | fleet device key (fleet-enrolled machines) | fleet |
| `0x81000140 + i` | owner | owner-seal/i (ECDSA P-256 signing; `userWithAuth` clear; policy `PolicySecret(0x01300140 + i)`) | hearth (installer at genesis) |
| `0x81010002` | endorsement | AK: restricted signing ECC P-256; runtime attestation (vouch, fleet, cluster join) | hearth (installer at genesis) |
| `0x81010003` | endorsement | AK0: restricted signing ECC P-256; pre-unlock VBU quotes (§20.5) | hearth (installer at genesis) |
| `0x81000180`–`0x81000183` | owner | Reserved staging handles for re-creating the owner Secure Boot KEK/db signers (`0x81000101`/`0x81000102`) when the owner set changes; empty outside that ceremony | hearth (installer at genesis) |

Only the registered owner of a handle may call `HearthTpm.recreateKey` (or, for `0x81000103`, `evict`) for it.

**AK and AK0 attributes:** `fixedTPM`, `fixedParent`, `sensitiveDataOrigin`, `userWithAuth`, `restricted`, `sign` set; `adminWithPolicy` clear; empty authValue; empty authPolicy (credential activation with the EK requires the admin role through the empty authValue). Quotes carry the PCR values; no PCR binding of the key is needed.

PCR usage (normative for boot, courier, vouch, fleet, cri):

| PCR | Content |
|---|---|
| 0–7 | Firmware, option ROMs, Secure Boot state (pcrlock policy, NV `0x01300103`) |
| 11 | UKI sections and boot phases; signed PCR11 policy |
| 12 | Kernel command line and credentials |
| 13 | System extensions (none in keylos; MUST be the "no extension" value; `kmod` generations are not system extensions) |
| 14 | shim/MOK state (shim fallback mode only) |
| 15 | Volume identity (LUKS volume key hash), extended by the initrd after unlock |

**PCR11 phases, in order** (each extended exactly once per boot by the named component):

| Phase | Extended by | When |
|---|---|---|
| `enter-initrd` | boot (`kl-initrd`, its first action) | before any other initrd step. systemd-stub measures the UKI sections into PCR11 but extends no phase string |
| `leave-initrd` | boot | after unlock, PCR15 extension, trust-set write and kl-exec load; immediately before `switch_root`. The disk-unseal policy is bound to `enter-initrd`, so the disk key is unavailable afterwards |
| `sysinit` | warden | after mounting `/var`, `/home`, `/store`, `/keystore` and taking over the kl-exec maps |
| `ready` | warden | immediately **before** starting the first tier-0 service (ledger and journal included). Secrets sealed to `ready` (service keys, NV authValues, hearth's hierarchy auth) are therefore available to tier-0 services and to nothing launched before this point |
| `enter-recovery` | boot | instead of `leave-initrd`, in the recovery profile; nothing sealed to `ready` is available afterwards |

No component extends PCR11 after `ready`.
<!-- END protocols §19.6 -->

<!-- BEGIN protocols §20.16 (verbatim) -->
> **protocols 20.16 Service table (`keylos.services/1`)**

`/etc/keylos/services.json` (JCS), rendered by `config`, read by `warden`, `boot` and `ledger`:

```json
{"schema":"keylos.services/1",
 "bootstrapGens":{"journal":"gen:fsv256:…","ledger":"gen:fsv256:…","depot":"gen:fsv256:…"},
 "services":{
   "strata":{"generation":"gen:fsv256:…","entrypoint":"main","tier":0,"perHuman":false,
             "uid":"dynamic","network":"none","writer":true,
             "privileges":{"capabilities":["CAP_SYS_ADMIN"],"paths":[{"path":"/snapshots","access":"rw"}],
                           "devices":[],"tpm":false},
             "bpf":["/usr/lib/keylos/bpf/strata/provenance.o"],
             "routes":[{"to":"vault","facet":"strata"},{"to":"warden","facet":"strata"}],
             "readiness":{"timeoutSecs":30},"watchdogSecs":10,"restart":"on-failure"},
   "portal-files":{"generation":"gen:fsv256:…","perHuman":true,
             "privileges":{"paths":[{"path":"/home/{human}","access":"rw"}]}, "…":"…"}
 }}
```

- `bootstrapGens` are mounted by `warden` before `depot` runs (§20.1).
- `writer: true` registers the service's key as a ledger writer (`ledger` reads this field).
- `privileges.paths` MAY use the placeholder `{human}` for per-human services; `warden` substitutes it per instance. Each entry's `access` is `ro` or `rw`.
- `bpf`: BPF objects `warden` loads for the service (§9.3); only paths under `/usr/lib/keylos/bpf/<service>/`.
- `network`: `"none"` (private netns with `lo`), `"gate"` (egress via gate only), `"host"` (host netns; listed services only: `net`, `gate`), `"cluster"` (the cri network namespace from `NetPlumbingCluster.clusterNetns`; `server-k8s` only: `cri`, `kubelet`, `kube-proxy`).
- Fields not listed here are `warden`-local and MUST be prefixed `x-`.
<!-- END protocols §20.16 -->

<!-- BEGIN protocols §21 (verbatim) -->
> **protocols 21. Cluster nodes (CRI)**

### 21.1 Boundary

- The `server-k8s` profile runs upstream `kubelet` and `kube-proxy` (sealed generations built by `forge`, packaged in `pkgs`) and the keylos `cri` service.
- `kubelet` reaches `cri` only through the route `cri#kubelet`: `warden` creates an `AF_UNIX` `SOCK_STREAM` socket pair and passes `kubelet` its end as `--container-runtime-endpoint=unix:///run/keylos/cri/cri.sock` (a path inside kubelet's view bound to that socket). This is the only non-capwire IPC in keylos (§7.1).
- `cri` implements CRI v1 (`runtime.v1.RuntimeService`, `runtime.v1.ImageService`) for the three most recent Kubernetes minor versions at release time.
- `kubelet` runs as a tier-1 service without root and without capabilities, in the cri network namespace (`services.json` `network: "cluster"`). It holds: the `cri#kubelet` route; the cgroup subtree `/keylos.slice/kube.slice` (delegated to `cri`, read-only to kubelet for stats); its state directory `/var/lib/keylos/cri/kubelet` (written by `cri`: certificates, kubeconfig). Volume mounts, networking and image handling are done by `cri`, never by kubelet.
- **Mount-free kubelet.** `pkgs` builds kubelet with the `keylos-mountless` patch set, which is part of this contract: kubelet never calls `mount`/`umount` (they are denied by seccomp anyway). Its volume plugins write configMap, secret, projected and downwardAPI contents into plain directories under `/var/lib/keylos/cri/kubelet/pods/<uid>/volumes/`, and every mount, unmount, and device-attach step is a no-op; `cri` turns those directories into `PodMount` trees (`tmpfsBytes > 0` for secret-bearing types, §7.5.1) or VM shares, and handles emptyDir, local, NFS/iSCSI/RBD and CSI volumes itself (§21.6).
- `kube-proxy` runs in nftables mode inside the `cri` network namespace with `CAP_NET_ADMIN` there only.

### 21.2 Runtime classes

| RuntimeClass | Isolation | Images | Notes |
|---|---|---|---|
| `keylos-vm` (default) | One `bench` microVM per pod sandbox (`VmSpec.purpose = pod`); containers run inside the guest under `youki` driven by `benchd` | Any OCI image, pulled by `cri` into `/var/lib/keylos/cri/images` (via `gate` when `cluster.egressViaGate`), shared read-only into the VM | VM principal `pod:<ns>/<name>:oci:sha256:<first image>@_cluster/…`; GPU only by passthrough |
| `keylos-sealed` | t1 principals spawned by `warden` through `PodSpawn` (§7.5.1) | Only `container` generations (§6.1) with a generation statement signed by an `org-publisher` key enabled on the machine | One principal per container; seccomp `runtime-default`; no added capabilities ever |

### 21.3 Admission

`RunPodSandbox` carries no container configs, so `cri` admits against the **API server's Pod object** (read with its cluster credential, matched by pod UID); it normalises the Pod into `keylos.podspec/1` (the attributes of the Cedar `PodSpec` entity, §16.1, as JCS JSON) and calls `BrokerSystem.admitPod`. The broker evaluates action `admit` with principal `service:kubelet`. A denial makes `RunPodSandbox` fail with gRPC `PermissionDenied` and the reasons; an `@tier`/`@orgApproval` permit makes `cri` hold the sandbox in `pending-approval` until the approval resolves. `CreateContainer` re-admits when the container config adds anything the admitted Pod object did not contain (image, capability, mount, device). Receipts `pod.admit`/`pod.deny` (cri).

### 21.4 Images

- `keylos-vm`: OCI images are pulled by `cri` with digest pinning; tags are resolved once and recorded. They are never executed on the host (`noexec` store) and never registered with `kl-exec`.
- `keylos-sealed`: `cri` calls `Depot.install("oci+container://<registry>/<repo>@sha256:<manifest>")` (facet `cri`). `depot` converts the image with **`oci-convert/1`** into a `container` generation and makes it launchable only if a `keylos.genstmt/1` for that generation digest, signed by an enabled `org-publisher` key, is available from the org TUF repository (`courier`). `cri` roots the generation as `cri:pod:<pod-id>` before `PodSpawn`; `depot` mounts container generations only while so rooted.
- **`oci-convert/1`** (normative; implemented only by crate `keylos-oci-convert`, §18): layers applied in manifest order; OCI whiteouts (`.wh.<name>`) and opaque markers (`.wh..wh..opq`) resolved; hardlinks kept; device nodes, sockets and FIFOs dropped (the runtime provides `/dev`); numeric uid/gid and mode bits kept; setuid/setgid bits cleared; `security.capability` and all `security.*`/`trusted.*` xattrs dropped (no file capabilities, ever); `user.*` xattrs kept; timestamps zeroed; entries sorted by path bytes; the result is built into a composefs generation exactly as `depot` builds any generation, with `/.keylos/manifest.json` of kind `container` whose `container` section copies the OCI config.
- **Identity** of a converted generation: `name` = `oci.` + the registry host's labels reversed + `.` + the repository path segments, joined by `.`, with every character outside `[a-z0-9-]` replaced by `-`; `version` = `0.0.0+oci.<first 16 hex digits of the manifest digest>`; `derivation` (and the genstmt `drv`) = `drv:sha256:<SHA-256 of the JCS bytes of the conversion descriptor>`, where the descriptor is `{"schema":"keylos.ociconv/1","algorithm":"oci-convert/1","image":"oci:sha256:<manifest>","platform":"linux/amd64","config":"sha256:<config blob>","layers":["sha256:…"]}`. For kind `container`, `drv` names this descriptor, not a `keylos.drv/1` derivation. `layers` lists the **compressed layer blob digests exactly as they appear in the image manifest, in manifest order** (not uncompressed `diff_id`s); `platform` is the platform selected from an image index (or the manifest's config platform).

### 21.5 Networking

- `net` creates the **cri network namespace** at its own start on `server-k8s` (veth uplink to the host, bridge `kl-cri0`), from config `cluster.*`. `warden` obtains it with `NetPlumbingCluster.clusterNetns` and starts `crid`, `kubelet` and `kube-proxy` in it. `cri` configures it dynamically with `clusterUplink` (the pod CIDR assigned through the Node object, NAT, overlay) and obtains per-pod network namespaces from `net` with op `podNetns`. This is the single exception to "only `warden` creates namespaces" (§9.1): network namespaces only.
- **`keylos.cri.uplink/1`** (JCS JSON passed to `clusterUplink`):
  - `{"schema":"keylos.cri.uplink/1","op":"uplink","podCidr":"10.244.3.0/24","clusterCidrs":["10.244.0.0/16"],"serviceCidr":"10.96.0.0/12","mtu":1450,"nat":true,"overlay":{"mode":"none" | "vxlan","vni":4242,"peers":[{"node":"…","ip":"…","podCidr":"…"}]}}` → returns the cri namespace;
  - `{"schema":"keylos.cri.uplink/1","op":"podNetns","podId":"pod-…","ip":"10.244.3.17","mac":"…","mtu":1450}` → returns a new pod namespace with a veth attached to `kl-cri0`;
  - `{"schema":"keylos.cri.uplink/1","op":"release","podId":"pod-…"}` → deletes it (returns no fd: `Fd.index` 0xFFFF).
- Pod VMs attach a **tap** device to a bridge inside the cri namespace. This is the only use of tap devices in keylos; workbench and tier-2 VMs never get one. Sealed pods get a veth pair into the same bridge.
- IPAM is host-local per pod CIDR; cross-node connectivity is direct routing or a VXLAN overlay configured by `cri`. Third-party CNI plugins are not supported; eBPF-based CNIs are not supported on the host.
- NetworkPolicy objects (watched by `cri` through the node's credential) are compiled to nftables in the cri namespace.
- With `cluster.egressViaGate = true`, pod egress to addresses outside the cluster CIDRs is redirected to a per-pod `gate` shim endpoint (`PodSpawn.egressShim`, §7.5.1; `keylos-vm` pods use their VM's `bench-net`) and is subject to gate policy. The broker attaches the pod principals' tokens at `registerSession` from policy `cluster.egress`.

### 21.6 Storage

- `emptyDir` and local PersistentVolumes are `strata` subvolumes (`StrataVolumes`, §7.5.7); `configMap`, `secret`, `projected` and `downwardAPI` volumes are tmpfs filled by `cri` (Kubernetes secrets arrive from the API server and are never stored in `vault`).
- NFS, iSCSI and RBD volumes are mounted **inside pod VMs only** (`keylos-vm`).
- CSI drivers are supported only as `container` generations declaring `needs.csi`; their node plugins run in a pod VM, and block devices reach them through `MediaAttach.claimBlock` (devd facet `cri`).
- `hostPath` is denied by default policy except a read-only allowlist.

### 21.7 Node attestation and credentials

- Before kubelet starts, `cri` performs `FleetCluster.joinAttested` with an AK quote (and a confidential-VM report on `cvm`); `fleet` verifies it against the release log. Only then does `cri` obtain kubelet client certificates (`FleetCluster.kubeletCertificate`) and write the kubelet kubeconfig.
- Certificates are renewed by `cri` before expiry; a failed re-attestation (for example after an unapproved firmware change) stops renewal and the node drops out of the cluster when its certificate expires.

### 21.8 Not supported

Privileged pods; `hostNetwork`, `hostPID`, `hostIPC`; added Linux capabilities; DaemonSets that need host access (node agents ship as sealed tier-0 services instead); Windows containers; GPU sharing other than whole-device passthrough into pod VMs; a writable container root filesystem in `keylos-sealed` pods (the root is read-only, with tmpfs at `/tmp`, `/run`, `/var/tmp` and `/dev/shm`, because a writable overlay would be an unregistered superblock from which nothing could execute; use `keylos-vm` for images that write to their root).
<!-- END protocols §21 -->
