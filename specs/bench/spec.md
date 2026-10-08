# keylos/bench — microVM manager for workbenches and tier-2 apps

| | |
|---|---|
| Repository | `github.com/keylos-os/bench` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | Service generation `io.keylos.bench` containing:<br>• `benchd-host`: the `bench` service, tier 0<br>• device backends `bench-fs` (vhost-user-fs backend), `bench-net` (vhost-user-net userspace network), `bench-gpu` (crosvm GPU backend launcher)<br>• `bench-relay` (per-VM relay that acts as the VM principal)<br>• the CLIs `work` and `bench`<br><br>Bench-image generation `io.keylos.bench.guest` containing:<br>• guest kernel<br>• guest PID 1 and agent `benchd`<br>• the minimal guest userland<br>• `bench-wl` (guest Wayland proxy)<br><br>Bench-image generations `io.keylos.bench.media` (media VM), `io.keylos.bench.captive-browser` (network sign-in), `io.keylos.bench.pod` (pod VMs for `cri`, with `youki`) and `io.keylos.bench.agent-desktop` (nested atrium for computer-use agents); their recipes live here, `pkgs` builds them.<br><br>Rust crates `keylos-bench-proto` (host↔guest protocol) and `keylos-project` (the `project.ncl` schema and evaluator). |
| Depends on | `keylos-protocols 1.0.0 (final)`<br>`crosvm` (pinned release; `vhost-user` frontends, snapshot/restore, `virtio-gpu` context types)<br>`fuse-backend-rs` (passthrough filesystem used by `bench-fs`)<br>`smoltcp` 0.11<br>`nickel-lang-core` |
| Runtime peers | `warden` (spawns every process bench needs), `depot` (mounts generations), `strata` (overlay transactions for writable shares), `gate` (all guest egress through `ShimEndpoint`; executes `fs.merge`), `broker` (grants, labels), `aide` (grant delegation and the agent host for agent VMs), `devd` (`/dev/kvm`, GPU render nodes, `MediaAttach` for removable media and VFIO), `atrium` (Wayland for tier-2, workbench-app and agent-desktop display), `net` (captive portals), `cri` (pod VMs), `portals` and `vault` (guest portals for tier-2 VMs), `ledger` (receipts) |
| Provides | `Bench` and `Vm` (`protocols §7.3.13`, including share hot-plug, agent desktops and media VMs); `BenchMerge`, `MediaBrowser` and `GuestPortals` (`protocols §7.5.10`); `AgentDesktop` (`protocols §7.5.13`, served to aide); the `work` and `bench` CLIs; the `project.ncl` schema; the repo-local guest protocol |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

The keylos host executes only sealed code. bench is where **everything else** runs:

- **Tier 3, workbenches.**
  - Development environments.
  - Builds and test runs.
  - Package-manager installs (`pip`, `npm`, `cargo`, `apt` inside the guest).
  - **Every AI agent session.** `aide` places sessions here.
- **Tier 2, untrusted apps.**
  - GUI and CLI applications that are internet-origin or not reproducible.
  - Legacy images imported by `compat`.
  - These are shown on the host desktop through a Wayland proxy.
- **Special-purpose VMs** (`VmSpec.purpose`, `protocols §7.3.13`):
  - **media** VMs that mount removable storage so the host never parses it (`protocols §9.5`);
  - **captive** VMs: a disposable browser for network sign-in pages;
  - **pod** VMs: one per Kubernetes pod sandbox for `cri` (`protocols §21`);
  - **agentDesktop** VMs: a nested desktop that a computer-use agent drives while the human watches (`protocols §14.5`);
  - **build** VMs for `forge`.

Each VM is a crosvm microVM with its own guest kernel. The guest kernel is the isolation boundary: anything that happens inside the guest can affect only what bench explicitly shared or granted.

**bench provides:**
1. **VM lifecycle.** Create, boot, snapshot, restore, fork, stop and destroy VMs, with every host process confined by `warden`.
2. **Shares.** Host directories exposed through virtio-fs. A writable share is either *direct* or an *overlay* whose changes are committed through `strata` transactions.
3. **Store access.** Toolchain and runtime generations the guest needs are exposed read-only from the host store, so guest and host use the same verified objects.
4. **Networking.** The guest NIC is terminated by a userspace network stack on the host. Every flow becomes a `gate.connect` call checked against the VM's grants.
5. **GPU and display.** Graphics through virtio-gpu (native context, Venus, or none), or a whole GPU by VFIO passthrough. Tier-2 apps, workbench apps such as IDEs, and agent-desktop mirrors display through cross-domain Wayland to `atrium`.
6. **Project workbenches.** Driven by `project.ncl`, with the `work` command.
7. **Fast start.** Memory snapshots with copy-on-write restore and fork, for starts of about 100–300 ms, and a warm pool of pre-restored VMs for agent sessions.
8. **Agent overlay merges.** `BenchMerge` freezes an agent VM's overlay, has `strata` prepare an immutable merge of it, describes that prepared merge as a `keylos.fsmerge/2` manifest, renders its diff, and commits exactly that prepared merge only against a mandate that binds its digest (protocols E30).
9. **Share hot-plug.** Directories granted while a VM runs are attached as new virtio-fs shares (`Vm.attachShare`).
10. **Guest portals.** Tier-2 guests and agent desktops reach notifications, URI opening, printing, their own display capture, per-item secrets and the file picker through `GuestPortals` on vsock 7004.
11. **Admission control.** The number of concurrent VMs follows the machine's RAM class (`protocols §2.3`).

**Non-goals:**
- **Running host-sealed code in VMs as a security measure.** Sealed tier-0 and tier-1 code runs on the host.
- **A general cloud or VM hosting platform.** No live migration, no multi-host scheduling.
- **Nested virtualisation inside workbenches.** It is disabled.
- **Windows or macOS guests.** Guests are Linux only.
- **Persistent VMs as pets.** Every VM is reproducible from an image, its shares and an optional snapshot. Workbench state that must survive lives in shares or cache volumes, never only in a guest disk.

---

## 2. Context and embedded contracts

### 2.1 Position in the system

```
              aide ──┐            compat ──┐         kish / work CLI ──┐
                     ▼                     ▼                           ▼
                ┌─────────────────────── bench (tier 0) ────────────────────────┐
                │ VM registry · snapshot store · project evaluator · receipts   │
                └──┬───────────┬──────────────┬───────────────┬────────────┬────┘
        warden.spawn     depot.mount     strata.begin     gate (ShimEndpoint) atrium (Display)
                │
   per VM:  crosvm (VMM) ── vhost-user ──► bench-fs (vhost-user-fs)  per share
                         ── vhost-user ──► bench-net (userspace TCP/IP → gate)
                         ── vhost-user ──► bench-gpu (virtio-gpu backend)
                         ── vsock ───────► benchd (guest PID 1) ◄── benchd-host (ports 1024–1535; 7002 → bench-relay → aide;
                                                                     7004 → bench-relay GuestPortals)
            media / pod VMs: block devices and VFIO groups from devd MediaAttach; pod VMs: tap in the cri netns
```

### 2.2 Embedded contracts

Every contract below is copied verbatim into Appendix A by mechanical extraction from keylos-protocols 1.0.0 (final).

| Contract | Use | Appendix |
|---|---|---|
| `protocols §2` platform baseline (kernel, virtualization rows) | KVM requirement, no silent downgrade | A.1 |
| `protocols §3.4` principals | VM principals `bench:<image>@<human>/<session…>`; a VM principal maps to the VMM's cgroup | A.2 |
| `protocols §6.1` generation kinds | `bench-image`, `part`, `legacy-image` | A.3 |
| `protocols §6.3` manifest schema | `benchImage` section (`purposes`, `desktop`) that bench enforces | A.43 |
| `protocols §7.1`, `§7.2`, `§7.2.1` capwire, routes and facets, capwire-vsock profile | Host services and the guest channel | A.4–A.6 |
| `common.capnp` + errors | Everywhere | A.7 |
| `warden.capnp` | `SpawnSpec`, `Process` (bench implements `Process` for guest processes) | A.8 |
| `broker.capnp` | `request`, `materialize`, `inspect`, `powerbox` (through `bench-relay`) | A.9 |
| `gate.capnp` | `NetTarget` | A.10 |
| `depot.capnp` | `mount`, `get`, `root`, `unroot` (facet `mounter`) | A.11 |
| `strata.capnp` | `begin` with `NetworkPolicy`, `Transaction` | A.12 |
| `bench.capnp` | **Implemented** | A.13 |
| `aide.capnp` | `AgentHost` (relayed for agent VMs on vsock 7002) | A.14 |
| `warden-sys.capnp` | `VmSpawn` (`register`, `spawnVmm`, `unregister`: VM principals and their per-VM processes); `GrantMounts.idmappedDir`; `PrincipalControl` semantics for revocation | A.15 |
| `broker-sys.capnp` | `LabelAuthority.raiseFor` (virtio-fs opens) | A.16 |
| `strata-sys.capnp` | `StrataTxn.txnExt`, `StrataTxn.prepared`, `StrataTxn.preparedFor`, `TransactionExt.prepare`, `TransactionExt.bindWorkflow`, `PreparedMerge` (`manifest`, `diff`, `commit`, `status`) | A.17 |
| `bench-sys.capnp` | **Implemented**: `BenchMerge`; calls `GrantDelegate` on aide | A.18 |
| `net-sys.capnp` | `NetCaptive.signIn` semantics: `net` starts captive VMs on facet `bench#net` (bench calls nothing on `net`) | A.19 |
| `gate-sys.capnp` | `ShimEndpoint` (all guest egress, DNS, SSH agent, CA bundle) | A.20 |
| `aide-sys.capnp` | `AgentHostExt`, `VmExec` (relayed) | A.21 |
| `display.capnp` | `Display.clientSocket` for tier-2 display VMs | A.22 |
| `protocols §8.2`, `§8.4` | Token facts for network grants and the `captive` fact; revocation | A.23, A.24 |
| `protocols §9.2` tiers | t2 and t3 are bench VMs | A.25 |
| `protocols §10.5` environment | `KEYLOS_AGENT_HOST` inside agent workbenches | A.26 |
| `protocols §14.1` labels | Label authority on share reads | A.27 |
| `protocols §19.2`, `§19.3`, `§19.5` | Facets, the `vm.*` receipt events, vsock ports | A.28–A.30 |
| `protocols §20.12` | `keylos.fsmerge/2` merge manifest of a prepared merge | A.31 |
| `protocols §2.3` | RAM classes and VM admission caps | A.32 |
| `devd-sys.capnp` | `MediaAttach.claimBlock`, `claimVfio`, `release` (facet `bench`) | A.33 |
| `protocols §9.5` | Removable media only in media VMs; VFIO passthrough rules | A.34 |
| `protocols §14.5` | Agent desktops | A.35 |
| `protocols §21.2`, `§21.5`, `§21.6` | Pod VMs for `cri` (runtime classes, networking, storage) | A.36–A.38 |
| `portals.capnp` | `Notify`, `OpenUri`, `Print` (called by `bench-relay` for `GuestPortals`) | A.39 |
| `vault.capnp` | `Vault.open` on facet `app` for `GuestPortals.secret` | A.40 |
| `protocols §20.10` | Secret delivery format read by `bench-relay` | A.41 |
| `protocols §14.4` | Mandates (`media.export`, `fs.merge`); which signatures relying services verify | A.42 |
| `protocols §14.2` | Effect kinds, caller-executed effects (`media.export`: gate authorizes, bench executes and writes the receipt) | A.44 |
| `hearth-sys.capnp` | `HearthSystem.owners` (owner-presence keys for mandate verification) | A.45 |
| `ledger.capnp` | `Ledger.serviceKey` (`service/broker` key for mandate verification), `append` | A.46 |
| `loom-sys.capnp` | `BrokerWorkflow.verify` for attempt VMs; `AttemptBinding` semantics of `VmSpec.attempt`/`ForkSpec.attempt` | A.47 |
| `protocols §20.25`, `§20.26` | Durable execution: attempts get fresh VM principals; `fs.merge` is a `transactional` effect committed by `pm-…` id with an idempotent completion record | A.48, A.49 |

### 2.3 Rules this spec relies on (summary; the appendix is normative)

- A VM principal (tier 2 or 3) maps to the cgroup of its VMM process; guest processes are not host principals and act with the VM's authority (`protocols §3.4`).
- Between guest and host, capwire runs over `AF_VSOCK` with **no fd passing**; the host identifies a VM by its CID, which bench assigns (`protocols §7.2.1`). Guests reach port 1024 (benchd control), 1025–1535 (bulk), 7002 (agent VMs only) and 7004 (tier-2 and agent-desktop VMs only) (`protocols §19.5`).
- All guest network traffic leaves through the single virtio-net device terminated by `bench-net`, which maps each flow to `ShimEndpoint.connect` on `gate` (`protocols §19.5`).
- `gate` executes `fs.merge` intents by calling `BenchMerge.commitShare`, and durable workflow effects by `BenchMerge.commitPrepared` (by `pm-…` id); `Vm.commit` is for human workbenches only (`protocols §7.3.13`, `§7.5.10`).
- A VM that is an attempt of a durable workflow is an ordinary, fresh VM principal; durability lives in `loom`, the broker's workflow record and strata's prepared-merge completion records, never in a running VM (`protocols §20.25`).
- Labels only go up; services that hand data from one principal to another raise the receiver's label first (`protocols §14.1`).

---

## 3. Requirements

### 3.1 Lifecycle

- **REQ-BENCH-001** bench MUST refuse every VM operation with `kl:unsupported` when `/dev/kvm` is unavailable. It MUST NOT fall back to emulation or to host execution.
- **REQ-BENCH-002** Every VM principal MUST be created with `VmSpawn.register(VmPrincipal)` on route `warden#bench` before any of its processes exists, and every host process the VM needs (crosvm, each device backend, `bench-net`, `bench-relay`) MUST be spawned with `VmSpawn.spawnVmm(session, spec)` into that principal's cgroup; `spec.generation` is always the bench generation. bench MUST NOT use `Supervisor.spawn` for per-VM processes and MUST NOT `fork`/`exec` itself. After the last per-VM process has exited, bench MUST call `VmSpawn.unregister(session)`.
- **REQ-BENCH-003** Each VM MUST run as its own principal (`bench:<image>@<human>/<session…>`; actor kind `agent` for VMs started on facet `aide`, `legacy` for facet `compat`, `pod` for facet `cri`, §4.14) with its own dynamic UID and cgroup, both allocated by `VmSpawn.register`. `VmPrincipal.offered` carries the tokens the requester passed in `VmSpec.network` (for agent VMs: tokens held by the launching human's session, offered by aide); the VM uses only the attenuated tokens `register` returns. The cgroup is `…/benches.slice/<session>.scope` for tier 3, `…/agents.slice/<session>.scope` for agent VMs, `…/apps.slice/<session>.scope` for tier 2, or the cri-delegated `/keylos.slice/kube.slice/…` scope for pod VMs. Every per-VM process (crosvm, backends, `bench-relay`) runs in that VM principal.
- **REQ-BENCH-004** `Bench.start` MUST verify that `VmSpec.image` is a launchable `bench-image` generation (`Depot.get`). Otherwise it fails with `kl:invalid` or `kl:revoked`.
- **REQ-BENCH-005** A VM MUST have no capability to reach host resources except:
  1. its shares,
  2. its read-only store mounts,
  3. the `bench-net` userspace network (which reaches only `gate` through `ShimEndpoint`),
  4. the GPU and display devices it was granted,
  5. the vsock control channel (port 1024) to `benchd-host` and its bulk ports (1025–1535),
  6. for agent VMs only, vsock port 7002, relayed to `aide`'s `host` facet,
  7. for tier-2 app VMs and agent-desktop VMs only, vsock port 7004 (`GuestPortals`, §4.17),
  8. for media and pod VMs, the block devices and VFIO groups claimed for them through `MediaAttach` (§4.16, §4.19, §4.20),
  9. for pod VMs, the tap device in the cri network namespace (§4.19), and for captive VMs, direct egress admitted by `net` (§4.18).
- **REQ-BENCH-006** VM lifecycle MUST follow the state machine of §4.3. Illegal transitions fail with `kl:conflict`.
- **REQ-BENCH-007** `Vm.stop` MUST stop the guest gracefully within 5 s, then kill the VM cgroup. `Vm.discard` MUST additionally abort all overlay transactions and delete per-VM scratch state.
- **REQ-BENCH-008** Revocation of the VM principal's grants is enforced by the broker through `PrincipalControl.terminate` on the VM session (`kill` for agents, `freeze` for apps; `protocols §8.4`). bench MUST observe the result (`Process.wait` on crosvm, or the frozen cgroup) and move the VM to `failed` or `paused` within 1 s, without restarting it.

### 3.2 Shares

- **REQ-BENCH-010** Each `Share` MUST be served by its own `bench-fs` process, confined by Landlock to exactly the share's directory (or the overlay view dirfd), holding no other filesystem access.
- **REQ-BENCH-011** A share with `writable=true, overlay=true` MUST be served from a `strata` transaction view (`Strata.begin([dir], NetworkPolicy.deny)`). The real tree changes only through a strata commit.
- **REQ-BENCH-012** For agent VMs (started on facet `aide`), every writable share MUST be an overlay. bench MUST reject `overlay=false, writable=true` for such VMs with `kl:denied`.
- **REQ-BENCH-013** `Vm.commit(share)` MUST be accepted only for human workbenches (T0: the human is acting directly) and MUST fail with `kl:denied` for agent VMs. Agent overlays merge only through `BenchMerge.commitShare` (§5.1.1), which `gate` calls when it executes an approved `fs.merge` intent.
- **REQ-BENCH-014** Share directories MUST be passed to bench as fds. bench MUST NOT resolve host paths on behalf of a caller.
- **REQ-BENCH-015** bench MUST NOT follow symlinks on the host side of any share. `bench-fs` MUST serve with `openat2(RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS)` semantics. Symlinks are presented to the guest as symlinks, and the guest resolves them inside its own namespace.
- **REQ-BENCH-016** Before the guest receives the first byte of a file from a share, bench MUST raise the VM session's label to that file's label (`security.bpf.keylos.label`, else the location default) with `LabelAuthority.raiseFor` (`protocols §14.1`). Raises are cached per (share, label) so each distinct label costs one call.
- **REQ-BENCH-017** `Vm.attachShare(share)` MUST start a new `bench-fs` backend for the share (REQ-BENCH-010, -011, -012 and -015 apply unchanged), hot-plug a vhost-user-fs device into the running VM, and make `benchd` mount it at `/shares/<name>` before returning. Names MUST match `[a-z0-9][a-z0-9-]{0,31}` and be unique per VM. `Vm.detachShare(name)` MUST make further guest accesses to that share fail with `EIO`, then unplug the device and stop its backend; an overlay share's transaction stays open until committed or discarded.

### 3.3 Store access

- **REQ-BENCH-020** Generations in a VM's store set (the image's `/usr/share/bench/storeset.json`, plus the project's toolchains) MUST be mounted on the host with `Depot.mount` (route `depot#mounter`) and exported read-only at `/keylos/gens/<64 hex>` in the guest. The `/keylos/gens` share MUST use DAX when the guest supports it. These host mounts are never registered with `kl-exec`: the host never executes from them.
- **REQ-BENCH-021** bench MUST hold a depot GC root `bench:<session>` for every generation mounted for a VM. The root is released when the VM is destroyed and no snapshot references it.

### 3.4 Networking

- **REQ-BENCH-030** The guest MUST have exactly one virtio-net device, backed by `bench-net`. No tap device, bridge or host network-namespace interface may be created for a VM. The single exception is pod VMs (`purpose = pod`), whose network device is a tap in the cri network namespace (`protocols §21.5`, §4.19); media VMs have no network device at all.
- **REQ-BENCH-031** `bench-net` MUST answer guest A/AAAA queries with **synthetic addresses** from `100.64.0.0/10` (IPv4) and `fd6b:6c6f:7300::/48` (IPv6). Each name gets a fresh address per VM. The address-to-name map is the only way a guest flow becomes a `NetTarget`.
- **REQ-BENCH-032** Except for captive VMs (REQ-BENCH-037) and pod VMs, every guest TCP connection MUST be converted into exactly one `ShimEndpoint.connect(target, tokens)` call, and every UDP flow into one `ShimEndpoint.udpAssociate` (`protocols §7.5.12`), passing the VM's network tokens; `gate` picks the authorizing token. If `gate` refuses, the guest receives TCP RST or ICMP unreachable, and bench raises a grant request (§4.12).
- **REQ-BENCH-033** Guest connections to literal IP addresses that did not come from bench's synthetic DNS MUST be refused, unless a grant names that IP literal.
- **REQ-BENCH-034** `bench-net` MUST NOT forward ICMP to the outside, MUST NOT provide IPv6 router advertisements except for its own prefix, and MUST rate-limit DNS to 200 queries/s per VM. DNS record types other than A/AAAA MUST be answered only through `ShimEndpoint.resolve`, which answers for granted names only.
- **REQ-BENCH-035** When `ShimEndpoint.caBundle` returns a session CA (gate intercepts TLS for this principal), bench MUST expose it to the guest as the read-only share `keylos-ca`, and `benchd` MUST add it to the guest trust store before any user process starts. When it returns empty, the share is absent.
- **REQ-BENCH-036** A VM with `purpose = captive` MUST use the image `io.keylos.bench.captive-browser`, MUST be started only on facet `net` (by `net`, from `NetCaptive.signIn`, `protocols §7.5.11`), and MUST NOT have shares or a store set beyond its image. bench calls nothing on `net`: the portal URL arrives in `VmSpec.bootArgs` (`captive.url`) and is delivered to the guest over benchd control at boot; the captive token is attached to the VM session by the broker. bench refuses a token carrying `captive(true)` for any other image or purpose.
- **REQ-BENCH-037** A captive VM's `bench-net` MUST run in **direct-egress mode** (§4.18): it opens host sockets itself, only to tcp/80, tcp/443 and udp+tcp/53, only until the `expires(…)` fact of the VM session's captive token (`Broker.myGrants` as the VM principal; at most 600 s after admission), and never through `gate`. Every other purpose MUST use `ShimEndpoint` exclusively (REQ-BENCH-032).

### 3.5 GPU and display

- **REQ-BENCH-040** With `VmSpec.gpu = true`, bench MUST select the first supported context type in this order:
  1. `drm` (native context, for amdgpu, i915/xe and msm hosts)
  2. `venus`
  3. none (the VM starts without a GPU and records the downgrade in its confinement report)
- **REQ-BENCH-041** GPU access MUST be materialised through `broker` as a device grant on the render node (`dev:drm:renderD*`). The card node (`card*`) MUST NOT be passed to any VM.
- **REQ-BENCH-042** With `VmSpec.display = true`, bench MUST call `Display.clientSocket(vmPrincipal, tier, generation, process)` on route `atrium#display` (`protocols §7.5.16`) and give the returned socket directory to `bench-gpu`, which connects as the VM principal. crosvm's cross-domain context MUST use that socket only.
- **REQ-BENCH-043** Tier-2 VMs MUST NOT receive clipboard or screenshot access except through the portals the app was granted. The guest `bench-wl` proxy MUST drop `wlr-data-control`, `ext-data-control`, `zwlr_screencopy` and `ext-image-copy-capture` globals.
- **REQ-BENCH-044** `VmSpec.gpuPassthrough` (a PCI address) MUST be honoured only for purposes `workbench`, `agent`, `app` and `pod`, effective tier 2 or 3, when the generation (app manifest, pod container, or project) declares `needs.gpu: "passthrough"`. bench claims the device with `MediaAttach.claimVfio` (route `devd#bench` or, for pods, the fds cri obtained) and releases it when the VM is destroyed. A passthrough VM gets no virtio-gpu device.
- **REQ-BENCH-045** With `display = true` and `displayMode = readOnly`, the display proxy (`bench-gpu`) MUST drop every input event (`wl_pointer`, `wl_keyboard`, `wl_touch`, `zwp_tablet_*`, text-input and data-device offers) from the host towards the guest. `Vm.takeOver(true)` switches the VM to `interactive`; `takeOver(false)` switches back.

### 3.6 Snapshots and forks

- **REQ-BENCH-050** A snapshot MUST capture:
  - guest memory, vCPU and device state (crosvm snapshot),
  - the scratch disk (btrfs reflink copy),
  - the list of shares and store mounts (identity only, never share contents).
- **REQ-BENCH-051** Restore MUST map guest memory from the snapshot file `MAP_PRIVATE` (copy-on-write, lazy page-in). Restore MUST NOT read the whole memory image before resuming the vCPUs.
- **REQ-BENCH-052** `Vm.fork` MUST produce a VM that shares the parent's memory snapshot copy-on-write, gets a reflink copy of the scratch disk, and gets **new** overlay transactions on all writable shares. The fork's base is the parent's current overlay view; fork-of-fork chains are allowed.
- **REQ-BENCH-053** Before a restored or forked guest resumes, `benchd` MUST be told to:
  - re-seed the guest RNG (`virtio-rng` + `RNDADDENTROPY` with 64 bytes from the host),
  - step the guest clock to host time,
  - regenerate the guest `machine-id` (forks and warm-pool VMs),
  - renew DHCP and DNS leases.
- **REQ-BENCH-054** Snapshots that contain a GPU device in a non-snapshottable state MUST be refused (`kl:unsupported`). Project base snapshots MUST be taken before GPU attach.
- **REQ-BENCH-055** bench MUST keep a **warm pool** for each entry of `bench.warm_pool` (§10): the entry's base snapshot memory kept resident in the page cache, and `count` scratch-disk reflinks prepared in advance. A start that matches an entry restores from it without disk reads. The pool holds no running VM and no process: every VM is spawned fresh as its own principal, so no guest state or identity can carry over between users.
- **REQ-BENCH-056** Hot-plugged shares (`Vm.attachShare`) MUST be recorded in the VM's share list. A snapshot of a VM with hot-plugged shares records them by identity like any other share; restore and fork re-attach them (new overlay transactions for writable overlay shares).
- **REQ-BENCH-057** `Vm.fork(spec)` MUST register the fork as a new VM principal with `VmSpawn.register`, using `ForkSpec.session` (generated when empty), `ForkSpec.parentSession` (default: the source VM's `parentSession`), `ForkSpec.principalKind` (default: the source VM's kind), and `VmPrincipal.offered`, `checks` and `budgets` copied from `ForkSpec.offered` (default: the source VM principal's tokens), `ForkSpec.checks` and `ForkSpec.budgets` (`protocols §7.3.13`, §7.5.1). The fork uses only the tokens `register` returns, so a sub-agent's fork is narrowed by the broker's attenuation with those checks and metered by the carved sub-budgets; bench never widens or re-mints tokens itself. On facet `aide` the fork's kind MUST be `agent` whatever the spec says; on other facets bench MUST refuse `agent`, `legacy` and `pod` with `kl:denied`. A null spec means all defaults.
- **REQ-BENCH-058** `Bench.reattach(session)` MUST return a new `Vm` capability only when the VM is running and was started (or forked) by the same caller principal; otherwise `kl:not-found`. VMs of purposes `pod`, `agent` and `agentDesktop` MUST keep running when their `Vm` capability is dropped, until `Vm.stop`, the end of their parent session (`PrincipalControl.events`), or a bench restart. VMs of all other purposes MUST be stopped within 5 s after their last `Vm` capability is dropped.
- **REQ-BENCH-059** A bench service restart MUST stop every VM (kill each VM cgroup through `PrincipalControl.terminate`, abort no overlay transaction) and mark them `stopped` in the registry before serving; callers detect the restart by `reattach` failing with `kl:not-found`.

### 3.7 Projects

- **REQ-BENCH-060** `Bench.project(dir)` MUST read `project.ncl` from the given dirfd with `RESOLVE_BENEATH`, evaluate it with the schema of §5.4, and start or attach the project's workbench.
- **REQ-BENCH-061** A project's **base snapshot** MUST be keyed by the hash of:
  - the evaluated project configuration,
  - the bench-image generation,
  - the store set.

  Changing any of these MUST produce a new base snapshot on next start (a cold boot), and keep the previous one until GC.
- **REQ-BENCH-062** Project cache volumes MUST be btrfs subvolumes owned by bench under `/var/lib/bench/caches/<project-id>/<cache-name>`, labelled `public/untrusted`. Agent forks receive reflink snapshots of caches, never the live cache.
- **REQ-BENCH-063** bench MUST NOT install generations. When a project names a toolchain that is not installed, `Bench.project` fails with `kl:not-found` listing the missing names; the `work` CLI installs them with `Depot.install` (route `depot#user`, T2 approval) and retries.

### 3.8 Guest

- **REQ-BENCH-070** The guest PID 1 MUST be `benchd`. It MUST talk to the host only over vsock (CID 2), using the capwire-vsock profile (`protocols §7.2.1`) on port 1024 and bulk ports 1025–1535; agent harnesses additionally reach port 7002.
- **REQ-BENCH-071** The guest kernel MUST be built with `CONFIG_KVM=n` (no nesting), with virtio-fs, virtio-net, virtio-gpu, virtio-vsock, virtio-rng, virtio-balloon (free page reporting) and EROFS, and without loadable module support.
- **REQ-BENCH-072** `benchd` MUST run user commands as an unprivileged guest user `work` (UID 1000), with `sudo`-free root available inside the guest only to project setup hooks that declare `root = true`. Guest root confers no host authority.
- **REQ-BENCH-073** In agent VMs `benchd` MUST set `KEYLOS_AGENT_HOST=vsock:2:7002` for the harness (`protocols §10.5`). In tier-2 app VMs and agent-desktop VMs it MUST set `KEYLOS_GUEST_PORTALS=vsock:2:7004`; in workbenches it MUST NOT.

### 3.9 Merges, delegation and audit

- **REQ-BENCH-080** bench MUST write a receipt (route `ledger#writer`) for VM start, stop, snapshot, fork, commit and discard, using the core events `vm.start`, `vm.stop`, `vm.snapshot`, `vm.fork`, `vm.commit`, `vm.discard` (`protocols §19.3`), and for every grant request it makes on the guest's behalf (`x-bench.grant.request`, §9.2).
- **REQ-BENCH-081** `BenchMerge.manifest` MUST freeze a snapshot of the share's overlay, obtain a strata prepared merge of it (`TransactionExt.prepare`, protocols §7.5.7) and return that prepared merge's `keylos.fsmerge/2` manifest (`protocols §20.12`), `SHA-256` of its JCS bytes, the snapshot id and the `pm-…` id. The digest is the strata prepared merge's own digest; bench never computes a second digest meaning. Later writes by the agent MUST NOT change what the prepared merge describes; calling `manifest` again yields a new prepared merge and digest.
- **REQ-BENCH-082** `BenchMerge.commitShare` (facet `merge`, `gate` only) MUST resolve `manifestDigest` to the share's current prepared merge (by its recorded `pm-…` id, `StrataTxn.prepared`), verify that the prepared merge's manifest digest equals `manifestDigest`, that the mandate is a verifiable `keylos.mandate/1` envelope whose `effects[]` contains `{kind: "fs.merge", digest: manifestDigest}`, and only then call `PreparedMerge.commit(mandate)`. A digest naming no current prepared merge or a mandate mismatch fails with `kl:integrity`; stale live state, an unfenceable writer or a lost fence are returned from strata unchanged (`kl:conflict`, `kl:unavailable`), after which `aide` must request a new manifest and a new approval.
- **REQ-BENCH-083** For agent VMs, every grant request the guest raises MUST go to `GrantDelegate.request` on route `aide#grant-delegate`; bench MUST NOT ask the broker directly on an agent VM's behalf. bench MUST parse `outcomeJson` exactly as defined in `protocols §7.5.10` and MUST treat any other shape as `denied`.

### 3.9a Workflow attempts and retained prepared merges

- **REQ-BENCH-116** `VmSpec.attempt` and `ForkSpec.attempt` with a non-zero epoch MUST be accepted only on facet `aide` and only with `principalKind = agent`; otherwise `kl:denied`. Before allocating anything bench MUST check the binding with `BrokerWorkflow.verify(binding, parentSession)` (route `broker#workflow`; a stale binding fails `kl:conflict`, a cancelled workflow `kl:revoked`) and MUST copy the binding unchanged into `VmPrincipal.attempt` (`protocols §7.5.1`); bench never creates, alters or infers a binding. A `fork` without `ForkSpec.attempt` produces a VM without a binding, even when its source is an attempt VM.
- **REQ-BENCH-117** For an attempt VM, bench MUST call `TransactionExt.bindWorkflow(binding)` on the transaction of every overlay share before the VM is started (and before a hot-plugged overlay share is attached); a failure fails `start`, `fork` or `attachShare` with the same code and leaves nothing running.
- **REQ-BENCH-118** `BenchMerge.commitPrepared(prepared, manifestDigest, mandate, binding)` (facet `merge`, `gate` only) MUST work from the `pm-…` id alone, whether or not the VM that prepared it still exists: obtain the prepared merge with `StrataTxn.preparedFor(prepared, binding)`; require its manifest digest to equal `manifestDigest` (`kl:integrity` otherwise); verify the mandate exactly as in REQ-BENCH-082 and additionally that `constraints.workflow` equals `binding.workflow` (`kl:denied` otherwise); read `PreparedMerge.status()` and, when it is `committed`, return the stored transaction and undo snapshot without committing again and without a second `vm.commit`; otherwise call `PreparedMerge.commit(mandate)` and write `vm.commit` with `data.prepared` and `data.workflow`. Stale live state, an unfenceable writer or a lost fence are returned as from `commitShare`.
- **REQ-BENCH-119** `BenchMerge.preparedStatus(prepared)` (facet `merge`, `gate` and `aide`) MUST return `PreparedMerge.status()` of a prepared merge of a transaction bench began, read through `StrataTxn.prepared` (bench is the transaction's owner); unknown ids fail `kl:not-found`. It is a read and never needs a current binding.
- **REQ-BENCH-120** bench MUST NOT claim persistence of attempt VMs: a bench service restart stops them like every other VM (REQ-BENCH-059), keeping their overlay transactions and prepared merges intact, and bench never restarts or reattaches a VM as a new attempt; a later attempt is a new VM with a new session started by `aide`. The `share → pm-…` mapping in the VmRecord is a cache: after a restart `commitPrepared` and `preparedStatus` rely only on the `pm-…` id and strata's durable completion record (`protocols §20.26`, strategy `transactional`).
- **REQ-BENCH-121** bench MUST retain the overlay transaction of every attempt VM share that has a `Ready` prepared merge until strata commits, discards or aborts it (the frozen-snapshot limit of 24 hours in §5.1.1 does not apply to it); committing a prepared merge needs only strata's prepared store, never bench's frozen snapshot.

### 3.10 Purposes, VmSpec fields and admission

- **REQ-BENCH-090** bench MUST enforce the purpose matrix of §4.14: which facet may request which `purpose`, which images, tiers, shares, network modes, display modes and vsock ports each purpose gets. A request outside the matrix fails with `kl:denied`.
- **REQ-BENCH-091** `VmSpec.session`, when non-empty, MUST be used as the VM principal's session; `parentSession` MUST be the session the VM principal's chain descends from (the aide-created session for agent VMs). `principalKind` MUST be one of `bench` (default), `agent`, `legacy`, `pod`; bench MUST refuse `agent` except on facet `aide`, `legacy` except on facet `compat`, and `pod` except on facet `cri`.
- **REQ-BENCH-092** `VmSpec.storeSet` MUST be added to the image's own store set; every listed generation MUST be launchable (`Depot.get`), except that `unsignedImageOk = true` is honoured **only** for facet `user` calls by `service:forge` with `purpose = build` (tier 3), in which case the image and store set may be unsigned build intermediates (`part`). bench MUST refuse `unsignedImageOk` from any other caller or purpose with `kl:denied`.
- **REQ-BENCH-093** bench MUST apply admission control by RAM class (`protocols §2.3`): the number of concurrently running VMs with purposes `workbench`, `agent`, `app`, `media`, `pod`, `agentDesktop` and `build` MUST NOT exceed the class cap. On the `server-k8s` profile, pod VMs are not counted. Captive VMs are not counted (at most one exists). A request beyond the cap fails with `kl:unavailable` and the detail `vm-cap:<class>:<cap>`.
- **REQ-BENCH-095** `Bench.start` MUST refuse with `kl:denied` an image whose manifest `benchImage.purposes` (`protocols §6.3`) does not list the requested `purpose`, and purpose `agentDesktop` unless `benchImage.desktop` is `true`. Images without a `benchImage` section are refused for every purpose.
- **REQ-BENCH-096** `VmSpec.bootArgs` MUST be delivered to the guest as `Guest.bootArgs` before any guest user process starts, and bench MUST reject keys that do not match `[a-z][a-z0-9.-]{0,63}` or values over 4 KiB (`kl:invalid`). Keys used by bench itself: `captive.url` (purpose `captive`).
- **REQ-BENCH-097** `VmSpec.tap`, `tapConfig` and `podId` MUST be accepted only on facet `cri` with `purpose = pod`; for any other request a tap fd index other than `0xFFFF` fails with `kl:denied`. The pod VM's VMM processes MUST be placed under the pod's cgroup named by `podId` (passed as `VmPrincipal.podId`).
- **REQ-BENCH-098** `Vm.info()` MUST return the VM session, the cgroup ID of the VM principal's scope, the guest CID and the purpose. On facet `net` it is allowed only for captive VMs that `net` started.
- **REQ-BENCH-099** `Vm.attachBlock(dev)` MUST hot-plug a virtio-blk device backed by the passed fd into a running pod VM (facet `cri`) and make it visible to the guest before returning; `detachBlock(device)` MUST unplug it, after which guest I/O fails. Both are refused for other purposes (`kl:denied`).
- **REQ-BENCH-094** On the `small` and `medium` classes bench MUST mark guest memory `MADV_MERGEABLE` (KSM) for tier-3 VMs, and on every class MUST enable virtio-balloon free-page reporting; on `small` it MUST compress snapshot memory images with zstd.

### 3.11 Media VMs

- **REQ-BENCH-100** `Bench.media(device)` MUST start (or attach to) exactly one media VM per authorized removable device, with image `io.keylos.bench.media`, the device's block fd from `MediaAttach.claimBlock(device, readOnly = false)` (route `devd#bench`) as its only block device, no network, no shares and no display. The host MUST NOT open, mount or parse the device's contents.
- **REQ-BENCH-101** `MediaBrowser.open` MUST stream bytes from the guest through a bulk vsock stream and MUST raise the caller's label to `public/untrusted` (`LabelAuthority.raiseFor`) before the first byte is returned; bench never caches file contents on the host.
- **REQ-BENCH-102** `MediaBrowser.export` and `ExportCompletion.finish` MUST verify, before any byte enters the media VM, that the mandate is the delivered `keylos.mandate/1` envelope `gate` returned for a committed `media.export` intent (`IntentStatus.result`, `protocols §14.2`): signed by an owner-presence key (`HearthSystem.owners`, route `hearth#system`) or by `service/broker` (`Ledger.serviceKey("broker")`, route `ledger#reader`); not expired; `effects[]` contains `{kind: "media.export", digest: "sha256:<SHA-256 of the bytes>"}`; and not used before. bench MUST keep the digests of used `media.export` mandates for their lifetime plus 24 h and refuse reuse. Any failure is `kl:integrity` and nothing is written.
- **REQ-BENCH-104** After the device write and `fsync` succeed, bench MUST write the completion receipt `media.export` (`protocols §19.3`, writer bench) with the device ID, path, byte count, content digest and mandate digest. `gate` has already written `effect.commit` (meaning "authorized").
- **REQ-BENCH-105** `MediaBrowser.exportSeekable(path, sizeLimit)` MUST return a writable, seekable memfd capped at `sizeLimit` (at most `bench.media.export_max_gib`) and an `ExportCompletion`. Nothing reaches the device until `finish(mandate)`: bench seals the memfd (`F_SEAL_WRITE|F_SEAL_SHRINK|F_SEAL_GROW`), computes its SHA-256, verifies the mandate per REQ-BENCH-102 against that digest, then writes it. `abort()` or dropping the capability discards the memfd.
- **REQ-BENCH-103** `MediaBrowser.eject` MUST unmount inside the guest, call `MediaAttach.release(device)`, stop the VM and write `media.eject`. Device removal MUST have the same effect without the unmount.

### 3.12 Agent desktops, guest portals and pods

- **REQ-BENCH-110** `Vm.desktop()` MUST succeed only for VMs with `purpose = agentDesktop` started on facet `aide`, and MUST return an `AgentDesktop` capability whose `input` is refused (`kl:denied`) while the VM is taken over. `screenshot`, `a11yTree` and `launch` act only on the nested desktop inside the VM.
- **REQ-BENCH-111** Agent-desktop VMs MUST start with `display = true` and `displayMode = readOnly`. Human take-over is the only way host input reaches the nested desktop (REQ-BENCH-045).
- **REQ-BENCH-112** `GuestPortals` (vsock 7004) MUST be served only to tier-2 app VMs and agent-desktop VMs, by that VM's `bench-relay` acting as the VM principal; workbenches never get port 7004.
- **REQ-BENCH-113** `GuestPortals.capture` MUST return frames of that VM's own display only, never host surfaces.
- **REQ-BENCH-114** `GuestPortals.secret` MUST call `Vault.open` on route `vault#app` as the VM principal; only items whose vault ACL allows the VM principal's actor pattern are returned, and every call writes the vault's own `secret.open` receipt.
- **REQ-BENCH-115** Pod VMs (`purpose = pod`, facet `cri` only) MUST have no virtio-net device backed by `bench-net`; their network device is the tap device in the cri network namespace (§4.19). They MUST NOT get display, GPU (except passthrough) or vsock ports other than 1024–1535.

## 4. Design

### 4.1 Components

| Component | Runs as | Role |
|---|---|---|
| `benchd-host` | Service principal `service:bench:…`, tier 0 | Implements `Bench` and `Vm`. Owns the VM registry, the snapshot store and project evaluation, and orchestrates the per-VM processes. |
| `crosvm` | Per VM; principal `bench:<image>@<human>/<s>`, tier `t2` or `t3` | The VMM. Started with `--disable-sandbox`; isolation is applied by `warden` (§6.3). |
| `bench-fs` | Per share | vhost-user-fs backend built on `fuse-backend-rs`'s passthrough filesystem, with an open hook that reports each newly opened inode's label to `benchd-host` (REQ-BENCH-016). Confinement comes from `warden` plus Landlock on the share root. The `grants` share of tier-2 VMs is a dynamic root to which `benchd-host` adds entries at runtime. |
| `bench-net` | Per VM | vhost-user-net backend: a userspace TCP/IP stack (smoltcp) that terminates guest flows and maps them to `gate.connect`. Also does DHCP and synthetic DNS. |
| `bench-gpu` | Per VM, only with GPU or display | crosvm `device gpu` run as a vhost-user GPU backend. Holds the render-node fd and, for display VMs, the atrium Wayland connection. |
| `bench-relay` | Per VM | Runs as the VM principal and holds the routes the VM needs as itself: `broker#principal` (grant requests and powerbox for human and tier-2 VMs) and, for agent VMs, `aide#host`. `benchd-host` hands it accepted vsock connections (port 7002) and requests; it relays capwire-vsock datagrams to `aide` verbatim (no fds exist on that profile) and performs broker calls as the VM principal. |
| `benchd` | Guest PID 1 | Mounts the guest filesystems, runs commands, reports changes, handles snapshot quiescing. |
| `bench-wl` | Guest | Wayland proxy over virtio-gpu cross-domain. Strips forbidden globals. |
| `work` | CLI, `shell` principal | Human UX for project workbenches |
| `bench` | CLI, `shell` principal | Administration of VMs, images and snapshots |

### 4.2 Host data layout

```
/var/lib/bench/                         btrfs subvolume @var/bench (rw, noexec)
  vms/<session>/                        per running VM
    scratch.img                         guest writable disk (sparse, reflink-cloned from image or snapshot)
    vm.json                             VmRecord (§4.4)
    sockets/                            vhost-user and control sockets (0700, the VM's UID)
  snapshots/<snap-id>/
    meta.json                           SnapshotRecord (§4.5)
    memory.bin                          guest RAM image (MAP_PRIVATE on restore)
    devices.json                        crosvm device state
    scratch.img                         reflink copy
  caches/<project-id>/<cache>/          btrfs subvolumes (rw, labelled public/untrusted)
  projects/<project-id>.json            ProjectRecord: last evaluated config hash, base snapshot id
  registry.db                           SQLite (WAL) registry of VMs, snapshots, projects
```

- The `noexec` mount flag does not affect guests: a guest executes from its own virtual disk image.
- `kl-exec` (`protocols §9.3`) never sees guest-executed code, because only the guest kernel maps it executable. Store generations bench mounts for guests are never registered as executable on the host.

### 4.3 VM state machine

```
            start/project                 boot ok (benchd hello)
  [absent] ───────────────► [booting] ──────────────────────────► [running]
                               │  restore ok                         │ │  ▲
                               │◄────────── [restoring] ◄── start(fromSnapshot)
                               │ boot timeout / crash                │ │  │ resume
                               ▼                                     │ ▼  │
                            [failed] ◄─────────── crash ─────────── [paused]
                                                                     │   (snapshot in progress,
                               stop()                                │    or frozen on revoke)
  [destroyed] ◄── discard() ◄─ [stopped] ◄──────────────────────────┘
       ▲                          │ start(fromSnapshot) creates a NEW VM; stopped VMs are not resumed
       └──────────── discard() ───┘
```

| From | Event | To | Actions |
|---|---|---|---|
| absent | `start`, `project` | booting | Allocate the session; spawn backends, then crosvm; start the boot timer (10 s) |
| absent | `start` with `fromSnapshot` | restoring | Reflink scratch; spawn backends; `crosvm --restore`; start the restore timer (3 s) |
| booting / restoring | `benchd` `hello` received | running | Apply post-restore fixups (REQ-BENCH-053); write receipt `vm.start` |
| booting / restoring | Timer expires or crosvm exits | failed | Collect crosvm logs; kill the cgroup |
| running | `snapshot` | paused → running | `benchd.quiesce` (sync, freeze filesystems in the guest), crosvm suspend, write state, resume |
| running | Revocation with `onRevoke=freeze` | paused | cgroup `freeze` on the VM scope |
| running | `stop` | stopped | `benchd.shutdown` (5 s), then cgroup kill |
| any | `discard` | destroyed | Kill, abort overlays, delete `vms/<session>`, release GC roots |
| running | crosvm exits unexpectedly | failed | Overlay transactions stay open for inspection until `discard` |

### 4.4 VmRecord

```json
{
  "schema": "keylos.bench.vm/1",
  "session": "s-01JB…",
  "principal": "bench:gen:fsv256:…@alice/s-01JB…",
  "tier": "t3",
  "actorKind": "bench",
  "origin": {"kind": "project", "projectId": "proj-3f9a…", "parentVm": null, "agentSession": null},
  "image": "gen:fsv256:…",
  "storeSet": ["gen:fsv256:…"],
  "shares": [{"name": "src", "mode": "overlay", "transaction": "x-01JB…", "guestPath": "/work/src"}],
  "vcpus": 4, "memoryMiB": 8192,
  "gpu": {"requested": true, "context": "drm", "renderNode": "dev:drm:renderD128"},
  "display": false,
  "netGrantRoots": ["t-…"],
  "attempt": null,
  "snapshotParent": "snap-01JB…",
  "state": "running",
  "created": "2026-10-07T21:30:00Z"
}
```

`attempt` is `null` or the `AttemptBinding` of an attempt VM as `{"workflow", "attempt", "epoch", "step", "owner"}` (REQ-BENCH-116); it is informational for bench and never authority.

### 4.5 SnapshotRecord

```json
{
  "schema": "keylos.bench.snapshot/1",
  "id": "snap-01JB…",
  "name": "project-base",
  "image": "gen:fsv256:…",
  "storeSet": ["gen:fsv256:…"],
  "configHash": "sha256:…",
  "vcpus": 4, "memoryMiB": 8192,
  "gpu": false,
  "shares": [{"name": "src", "guestPath": "/work/src", "mode": "overlay"}],
  "crosvm": "1.x (exact version string)",
  "guestKernel": "gen:fsv256:… (path within image)",
  "created": "…",
  "parent": null,
  "pinned": false,
  "bytes": {"memory": 8589934592, "memoryResident": 734003200, "scratch": 1073741824}
}
```

**Compatibility.** A snapshot is restorable only when the crosvm version, the guest kernel and the vCPU/memory configuration are identical, and the host CPU feature set is a superset of the one recorded. Otherwise restore fails with `kl:unsupported`, and the caller (for example `work`) falls back to a cold boot that produces a new base snapshot.

### 4.6 Shares and store mounts

**Guest mount table**, created by `benchd`:

| Guest path | Source | Mode |
|---|---|---|
| `/` | Image root: the guest root filesystem as an EROFS image (`root.erofs` in the bench-image generation) on virtio-blk, read-only | ro |
| `/var`, `/home/work`, `/tmp`, `/opt/local` | `scratch.img` (ext4) on virtio-blk; overlay upper for `/etc` and `/usr/local` | rw |
| `/keylos/gens/<hex>` | virtio-fs tag `gens`; host side is a directory of `Depot.mount` fds assembled by `bench-fs --gens` | ro, DAX |
| `/work/<share>` | virtio-fs tag `share-<name>` | ro / rw |
| `/cache/<name>` | virtio-fs tag `cache-<name>` | rw |
| `/run/keylos/host` | vsock capwire endpoint (abstracted by the `benchd` socket `/run/keylos/benchd.sock`) | |

**Overlay shares:**
1. bench calls `Strata.begin([share.dir], NetworkPolicy.deny)` on route `strata#bench`. `deny` is the transaction network policy: the VM's network path is gate-mediated, so strata is told to deny any other.
2. bench serves `Transaction.view()[0]` through `bench-fs`.
3. Guest writes land in the transaction's upper layer.
4. `Vm.changes()` returns `Transaction.changes()` summarised per share as text lines of the form `M path`, `A path`, `D path`, `R from -> to`.

**Gens share assembly.** `bench-fs --gens` receives an O_PATH dirfd for each mounted generation tree, plus the generation's hex name. It presents a synthetic read-only root directory whose entries are those trees. Store content is labelled `public/trusted` (`protocols §14.1`), so it causes no label raise.

**Label hook.** On every FUSE `OPEN`, `CREATE` and first `READ` of an inode, `bench-fs` reads `security.bpf.keylos.label` (or derives the location default) and, if this (share, label) pair has not been reported yet, sends it to `benchd-host` over its control socket and waits for the acknowledgement. `benchd-host` calls `LabelAuthority.raiseFor(vmSession, label, "share:<name>")` on route `broker#label-authority` and acknowledges. Only then does `bench-fs` return data (REQ-BENCH-016). If the broker refuses the raise (Rule of Two), the open fails with `EACCES` and bench records `x-bench.label.refused`.

**`keylos-ca` share.** If `ShimEndpoint.caBundle()` returns a PEM bundle, `benchd-host` writes it into a per-VM read-only directory exported as `keylos-ca` and mounted at `/keylos/ca` in the guest; `benchd` installs it into the guest trust store at boot and after restore (REQ-BENCH-035).

**`grants` share (tier 2).** A dynamic, initially empty share mounted at `/keylos/grants`. When a tier-2 app picks a file through the powerbox (§4.12), `benchd-host` adds the returned fd under a fresh name and the guest open broker returns `/keylos/grants/<name>` to the app.

### 4.7 Networking: `bench-net`

**Why userspace termination.** The alternatives are worse:

| Option | Problem |
|---|---|
| vsock only | Breaks unmodified tools (git over ssh, database clients, language servers that fetch) |
| tap + bridge, or tap into a host netns | Exposes host kernel netfilter and IP stack processing of guest-crafted packets, needs `CAP_NET_ADMIN`, and leaves host-level policy dependent on DNS-to-IP guesses |

A userspace stack with synthetic DNS gives every guest flow an **exact host name**, keeps guest packets out of the host kernel network stack entirely, and turns each flow into a policy-checked `ShimEndpoint.connect` on `gate`.

**Gate endpoint.** `bench-net` runs as the VM principal. Its entrypoint in the bench generation declares the route `gate#shim`; `warden` wires it at spawn, and `gate` binds that `ShimEndpoint` to the VM principal (`protocols §19.2`: per-principal endpoints created by bench for bench-net). `bench-net` receives the VM's network tokens from `benchd-host` over its control socket, and new tokens as grants are added.

**Guest view:**
- DHCP: IPv4 `10.0.2.15/24`, gateway `10.0.2.2`, DNS `10.0.2.3`.
- IPv6: `fd6b:6c6f:7300:1::15/64`, router and DNS `fd6b:6c6f:7300:1::2`.
- MTU 65520.

**DNS:**
1. A query for name N gets A/AAAA answers with a synthetic address `S(N)` drawn from the pools in REQ-BENCH-031, and TTL 60.
2. `bench-net` checks only that N is syntactically valid. It does not check grants at resolution time: resolution leaks nothing, and checks happen at connect.
3. Other record types (MX, SRV, TXT, HTTPS, CAA) are answered by `ShimEndpoint.resolve(N, qtype)`, which answers only for names covered by a grant of the VM. Otherwise the answer is NXDOMAIN.
4. The address map is per VM and kept in memory, at most 65,536 entries, evicted LRU when no flow references them.

**Flow handling:**
1. The guest opens TCP to `S(N):p`. `bench-net` accepts the SYN locally, then looks up N.
2. `ShimEndpoint.connect(NetTarget{host=N, port=p, proto=tcp, methods=[]}, tokens)` with all of the VM's network tokens. `gate` picks the first authorizing token, applies method checks, labels and the Rule of Two, and returns a socket fd.
3. If `gate` refuses (`kl:denied`, `kl:needs-approval`), the flow is RST and an asynchronous grant request is raised (§4.12). Refusals are cached per (N, p) for 60 s.
4. Bytes are copied in both directions between the smoltcp socket and the gate socket (splice where possible). Half-close and RST propagate.
5. UDP flows (for example QUIC or DNS-over-UDP to granted resolvers) use `ShimEndpoint.udpAssociate`, which returns a datagram fd for that target. Any UDP flow `gate` refuses is dropped.
6. **Literal IPs.** A flow to an address not in the synthetic map is treated as host = that IP literal. It succeeds only if a grant names the literal (REQ-BENCH-033).

**SSH agent.** When the VM holds an SSH grant, `benchd` exposes `SSH_AUTH_SOCK=/run/keylos/ssh-agent.sock` in the guest. Each guest connection is carried over a bulk vsock stream to `benchd-host`, which passes the stream fd to `bench-net` over its control socket; `bench-net` splices it to a socket from `ShimEndpoint.sshAgent()`. Keys never enter the guest.

**Throughput.** One `bench-net` worker thread per VM handles up to 64 flows; more flows add workers. The stack uses TSO/GSO-sized buffers via virtio-net offload negotiation (64 KiB segments).

### 4.8 GPU and display

**Native context** (`drm`):
- crosvm's GPU device runs in `bench-gpu`, with the render-node fd materialised from `broker` (device token).
- The guest runs the native Mesa user-mode driver (radeonsi/radv, iris/anv, freedreno/turnip).
- Command buffers are submitted through the host kernel driver.

**Venus:** the fallback when native context is unsupported for the host GPU or kernel. It needs a host-side Vulkan driver loaded in `bench-gpu` from a sealed generation.

**Display for tier 2:**
1. bench calls `Display.clientSocket(vmPrincipal, tier, generation, crosvmProcess)` on route `atrium#display` (`protocols §7.5.16`). `generation` is the app or legacy image the VM runs, so atrium shows its name. atrium returns an `O_PATH` directory fd containing a listening socket bound to the VM principal.
2. `bench-gpu`, which runs as the VM principal, connects to that socket (atrium's peer check therefore passes) and uses the connection as crosvm's Wayland socket.
3. In the guest, `bench-wl` listens on `$XDG_RUNTIME_DIR/wayland-0`, forwards through the virtio-gpu cross-domain context, and filters globals (REQ-BENCH-043).
4. Window titles get the VM principal's tier badge from atrium. bench passes nothing that could spoof it.

**Audio for tier 2:** the guest PipeWire connects to a PipeWire remote forwarded over a bulk vsock stream. The host side is a remote fd that `bench-relay` obtains as the VM principal from `portal-mic`: facet `playback` (static route for apps with audio output) or facet `capture` (broker grant, prompt on use). Without a capture grant, audio output only.

### 4.9 Host↔guest protocol: capwire/vsock profile

- **Transport:** the capwire-vsock profile (`protocols §7.2.1`): `AF_VSOCK`, `SOCK_SEQPACKET`, port 1024 on the host (CID 2). One control connection per VM, initiated by `benchd`. Bulk streams use ports 1025–1535 (`protocols §19.5`), announced in control messages.
- **No fd passing.** `Fd` fields never appear; receivers reject them.
- **Authentication.** `benchd-host` is the only host listener on ports 1024–1535 and 7002. It maps the peer CID to the VM (bench assigns CIDs ≥ 3 uniquely per running VM). The guest is never trusted for identity claims.
- **Agent host (port 7002).** For agent VMs, `benchd-host` accepts connections on port 7002 from that VM's CID and hands each accepted socket to the VM's `bench-relay`, which relays datagrams verbatim to its `aide#host` connection. `aide` therefore sees the VM principal as the peer. For non-agent VMs, connections on 7002 are refused.

**Schema** `bench-guest.capnp`, owned by this repo, file ID `@0xb3c4d5e6f7080001`:

```capnp
@0xb3c4d5e6f7080001;

struct GuestHello { kernel @0 :Text; benchdVersion @1 :Text; bootNanos @2 :UInt64; restored @3 :Bool; }

struct ExecSpec {
  argv @0 :List(Text);
  env  @1 :List(KV);
  cwd  @2 :Text;
  user @3 :Text;            # "work" (default) or "root" (setup hooks only)
  tty  @4 :Bool;
  rows @5 :UInt16; cols @6 :UInt16;
  stdio @7 :List(StreamPort);   # one per mapped fd: target fd + vsock stream port + direction
  struct KV { key @0 :Text; value @1 :Text; }
  struct StreamPort { target @0 :Int32; port @1 :UInt32; dir @2 :Dir; enum Dir { in @0; out @1; both @2; } }
}

struct GuestExit { code @0 :Int32; signal @1 :Int32; cpuNanos @2 :UInt64; maxRss @3 :UInt64; }

interface GuestProcess {
  wait    @0 () -> (exit :GuestExit);
  signal  @1 (signo :Int32) -> ();
  resize  @2 (rows :UInt16, cols :UInt16) -> ();
}

interface Guest {                         # served by benchd
  exec     @0 (spec :ExecSpec) -> (process :GuestProcess);
  quiesce  @1 () -> ();                    # sync + fsfreeze all rw filesystems
  thaw     @2 () -> ();
  fixup    @3 (entropy :Data, unixNanos :Int64, newMachineId :Text) -> ();
  shutdown @4 (graceSecs :UInt16) -> ();
  mounts   @5 () -> (json :Text);
  stats    @6 () -> (json :Text);          # memory, cpu, disk usage
  mountShare   @7 (tag :Text, path :Text, readOnly :Bool) -> ();   # hot-plugged virtio-fs share (§4.15)
  unmountShare @8 (path :Text, force :Bool) -> ();
  setEnv       @9 (key :Text, value :Text) -> ();                  # environment for processes started after the call
  desktop      @10 () -> (desktop :GuestDesktop);                  # agent-desktop images only (§4.21)
  media        @11 () -> (media :GuestMedia);                      # media image only (§4.16)
  bootArgs     @12 (args :List(ExecSpec.KV)) -> ();               # VmSpec.bootArgs, delivered once before user processes start (REQ-BENCH-096)
  attachedBlocks @13 () -> (json :Text);                          # virtio-blk devices visible to the guest (attachBlock confirmation)
}

interface GuestDesktop {                  # served by the nested atrium's agent-desktop bridge inside the guest
  screenshot @0 () -> (png :Data, width :UInt32, height :UInt32);
  input      @1 (eventsJson :Text) -> ();
  a11yTree   @2 () -> (json :Text);
  launch     @3 (appName :Text) -> ();
}

interface GuestMedia {                    # served by media-agent inside the media VM
  info   @0 () -> (json :Text);                                     # filesystem type, label, size, read-only flag
  list   @1 (path :Text) -> (json :Text);                           # [{name, kind, size, modified}]
  open   @2 (path :Text, port :UInt32) -> (size :UInt64);           # streams the file to bulk port `port`
  write  @3 (path :Text, port :UInt32, size :UInt64, overwrite :Bool) -> ();   # reads `size` bytes from bulk port `port`
  eject  @4 () -> ();                                               # sync + unmount
}

interface HostControl {                   # bootstrap capability served by benchd-host to benchd
  hello       @0 (hello :GuestHello) -> (guest :Guest);  # benchd passes its Guest capability back
  requestGrant @1 (kind :Text, detailJson :Text, reason :Text) -> (outcomeJson :Text);
  openFile    @2 (kind :Text, title :Text, suggestedName :Text) -> (guestPath :Text);   # powerbox through bench-relay; result added to the grants share (§4.12)
  log         @3 (level :UInt8, message :Text) -> ();
}
```

`Vm.exec` maps to `Guest.exec`. For each `FdMapping`, `benchd-host` opens a vsock stream port and pumps bytes between the host fd and that port. The returned `W.Process` is implemented by bench:

| `Process` method | Behaviour |
|---|---|
| `pidfd` | Fails `kl:unsupported` (there is no host process) |
| `principal` | Returns the VM principal |
| `wait` | Maps `GuestExit` to `ExitStatus` |
| `signal`, `kill` | Forwarded; `kill` sends SIGKILL to the guest process group |
| `confinement` | Returns the VM's confinement report, `tier` = `t2`/`t3` |

### 4.10 Snapshot and restore

**Snapshot procedure** (`Vm.snapshot(name)`):
1. Assert state `running` and no GPU attached; otherwise fail (REQ-BENCH-054).
2. `Guest.quiesce()`, with a 2 s timeout. On timeout, abort the snapshot.
3. crosvm control socket: `suspend`, then `snapshot take <dir>` (memory to `memory.bin`, device state to `devices.json`).
4. `cp --reflink=always scratch.img snapshots/<id>/scratch.img`.
5. crosvm `resume`; `Guest.thaw()`.
6. Write `meta.json` and the registry row. Receipt `vm.snapshot`.
7. The guest pause time budget is ≤ 300 ms plus the time to write dirty memory. Memory is written sparse: zero pages are skipped using the balloon's free-page reporting hints.

**Restore** (`VmSpec.fromSnapshot`):
1. Validate compatibility (§4.5).
2. Reflink `scratch.img` into `vms/<session>/`.
3. Spawn the backends for the same share and store layout. New overlay transactions are begun for writable overlay shares; restored guests MUST NOT see old transaction contents. Store generations MUST be identical digests.
4. `crosvm run --restore <dir>`, with guest memory backed by `memory.bin` mapped `MAP_PRIVATE`. Pages fault in lazily from the page cache.
5. On `hello` with `restored = true`, call `Guest.fixup(entropy, now, machineId)` with a new machine ID only for forks. Then remount virtio-fs shares: the guest-side FUSE sessions are re-established by `benchd`, because host-side `bench-fs` processes are new.

**Fork** (`Vm.fork`):
1. Take a temporary snapshot `fork-<id>` (as above, with `pinned=false`).
2. Restore it twice: once into the new VM, once back into the parent (resume). Alternatively, when the crosvm build supports in-place resume after `snapshot take`, the parent simply resumes.
3. The child's writable overlay shares get new transactions whose lower layer is the parent's current **view**. This uses strata's `begin` on the parent transaction's view dirfd.
4. Memory sharing between parent and child is copy-on-write through the common `memory.bin` page cache.

**Warm pool** (REQ-BENCH-055):
1. For each entry of `bench.warm_pool` (§10) — an image, a store set and a size class — bench keeps one base snapshot (built like a project base snapshot, with no shares) and keeps its `memory.bin` resident with `posix_fadvise(WILLNEED)` and a periodic `mincore` check.
2. It keeps `count` scratch-disk reflink copies ready under `snapshots/<id>/spare-<n>.img`.
3. A `Bench.start` (or an agent VM creation) whose image, store set and size class match an entry restores from that snapshot with a ready scratch copy. All processes are spawned fresh as the new VM principal; REQ-BENCH-053 fixups (new RNG seed, clock, machine ID) run before the guest's first instruction.
4. Resident pool memory counts against `max_committed_memory_percent`; under memory pressure the pool is dropped first (`POSIX_FADV_DONTNEED`).

**Snapshot GC:**
- Keep pinned snapshots and the current base snapshot per project.
- Delete fork temporaries 10 minutes after the last child is destroyed.
- Keep at most `bench.snapshots.maxPerProject` (default 3) non-pinned snapshots per project, oldest deleted first.

### 4.11 Project workbenches

**Sequence for `work` in a directory containing `project.ncl`:**

```
work ─► kish resolves cwd as O_PATH dirfd (shell powerbox) ─► Bench.project(dirfd)
  bench: read project.ncl (RESOLVE_BENEATH) ─► evaluate (nickel, sandboxed: no imports outside project dir)
       ─► resolve toolchains via Depot.list/get (route depot#mounter); missing → fail kl:not-found with the list (REQ-BENCH-063)
       ─► configHash = sha256(JCS(evaluated) || image || storeSet)
       ─► base snapshot exists for configHash?
             yes → restore (≈150 ms) ; no → cold boot, run setup hooks, snapshot "project-base"
       ─► attach shares: project dir (direct rw for humans), caches
       ─► return Vm ; work CLI calls Vm.exec(shell, tty=true) and attaches the terminal
```

**Project identity:** `project-id = "proj-" + base32(sha256(owner username || "/" || canonical project directory inode identity (st_dev:st_ino at first use)))`. It is stored in `projects/<id>.json` and survives directory renames.

**Agent sessions.** `aide` (facet `bench#aide`) calls `Bench.project(dir)` to get the project's Vm, then `Vm.fork()`. VMs created or forked on facet `aide` are agent VMs: all writable shares become overlays (REQ-BENCH-012), port 7002 is relayed (§4.9), and grant requests go to `GrantDelegate` (REQ-BENCH-083). Agent forks of a human workbench therefore start in milliseconds, with the full toolchain warm.

### 4.12 Grant requests on behalf of the guest

The guest cannot talk to `broker`. When `bench-net` refuses a flow, or `benchd` calls `HostControl.requestGrant`:

| VM origin | Behaviour |
|---|---|
| Human project workbench | `bench-relay` calls `Broker.request(GrantRequest{resource=net(N,p), rights=[connect], reason="workbench <project> wants N:p", durationSecs=policy default})` **as the VM principal** (route `broker#principal`). The human sees a T2 prompt naming the workbench; tokens obtained are added to the VM's network token set and passed to `bench-net`. |
| Agent VM | `benchd-host` calls `GrantDelegate.request(vmSession, kind, detailJson, reason)` on route `aide#grant-delegate` (`protocols §7.5.10`). `aide` applies its session policy and labels (T2/T3) and returns the outcome; granted tokens arrive in `outcomeJson` (base64 Biscuit) and are added to the VM's token set. |
| Tier-2 app | `bench-relay` calls `Broker.request` as the VM principal. The manifest `needs.network` entries were granted at install time (or not), so a runtime miss is a T2 prompt "App X wants to reach N". |

**Powerbox.** In tier-2 app VMs and agent desktops, guest code asks through `GuestPortals.powerbox` (vsock 7004, §4.17). In workbenches (which have no port 7004), `benchd` offers the same through `HostControl.openFile(kind, title, suggestedName)` for the human's terminal tools. Both make `bench-relay` call `Broker.powerbox(PowerboxRequest{kind, title, suggestedName})` as the VM principal. A picked file is added to the VM's `grants` share (§4.6) and the call returns its guest path; a picked directory is hot-plugged with `Vm.attachShare` (§4.15) and the call returns `/shares/<name>`. The broker raises the VM's label for the picked entries.

**Rate limit:** one pending request per (VM, host); repeated refusals within 60 s are not re-asked.

### 4.13 Resource limits

| Resource | Default (tier 3) | Default (tier 2) | Enforcement |
|---|---|---|---|
| vCPUs | min(host CPUs − 1, 8) | 2 | crosvm `--cpus`; cgroup `cpu.max` = vcpus × 100% |
| Memory | 25% of host RAM, max 16 GiB | 2 GiB | crosvm memory size; cgroup `memory.max` = guest + 256 MiB overhead; balloon with free-page reporting |
| Scratch disk | 64 GiB sparse | 8 GiB sparse | File size; guest ext4 |
| Disk I/O | `io.weight` 100 | `io.weight` 50 | cgroup |
| Network | 1 Gbit/s shaping per VM; 256 concurrent flows | 100 Mbit/s; 64 flows | `bench-net` token bucket |
| Wall time | Unlimited (project), or the `aide` session deadline | Unlimited | `Limits.wallSecs` |

### 4.14 Purposes

`VmSpec.purpose` (`protocols §7.3.13`) selects a fixed profile. bench rejects any combination outside this matrix (REQ-BENCH-090).

| Purpose | Facet | Image | Tier / actor kind | Shares | Network | Display | vsock beyond 1024–1535 | Counts against cap |
|---|---|---|---|---|---|---|---|---|
| `workbench` | `user` (kish, `work`, atrium), `admin` | Allowed bench-images (`bench.images.allowed`) | t3 / `bench` | Any; writable direct for the human | `bench-net` → gate | Optional (workbench apps, §4.23) | — | yes |
| `agent` | `aide` | Template's `benchImage` | t3 / `agent` | Overlay only (REQ-BENCH-012) | `bench-net` → gate | No | 7002 | yes |
| `agentDesktop` | `aide` | Template's `benchImage` (with nested atrium), e.g. `io.keylos.bench.agent-desktop` | t3 / `agent` | Overlay only | `bench-net` → gate | Yes, starts `readOnly` | 7002, 7004 | yes |
| `app` | `compat` (legacy images); `user` from `kish` and the atrium launcher (non-reproducible native apps, effective tier 2) | The legacy image's bench-image, or `bench.app_image` for native apps (the app generation in the store set) | t2 / `legacy` (compat), `bench` (native) | `grants` share and hot-plugged picks only | `bench-net` → gate | Yes, `interactive` | 7004 | yes |
| `media` | `user` (`Bench.media` only: atrium, portal-files) | `io.keylos.bench.media` | t3 / `bench` | None | None | No | — | yes |
| `build` | `user` (forge only) | Build bench-image; `unsignedImageOk` allowed | t3 / `bench` | forge's build directories | `bench-net` → gate (fixed-output fetches only, per forge's tokens) | No | — | yes |
| `captive` | `net` only | `io.keylos.bench.captive-browser` | t3 / `bench` | None | Direct egress (§4.18) | Yes, `interactive` | — | no |
| `pod` | `cri` | `io.keylos.bench.pod` | t2 / `pod` | Hot-plugged (images, volumes) | Tap in the cri netns (§4.19) | No | — | no on `server-k8s`, else yes |

The VM principal is `bench:<image>@<human>/<session…>` for kinds `bench` and `legacy`, `agent:<template>@<human>/…` for agent VMs (aide passes `session` and `parentSession`), and `pod:<ns>/<name>:oci:sha256:<first image>@_cluster/…` for pods (cri passes `session`; `protocols §21.2`). bench passes the actor kind, session, parent session, image, template and tier in `VmPrincipal` to `VmSpawn.register` (REQ-BENCH-002), and every per-VM process is spawned into that principal with `VmSpawn.spawnVmm`.

Every purpose additionally requires the image's manifest `benchImage.purposes` to list it (REQ-BENCH-095): `io.keylos.bench.guest` lists `workbench`, `agent`, `app`, `build`; agent-desktop images list `agentDesktop` with `desktop: true`; `io.keylos.bench.media`, `io.keylos.bench.captive-browser` and `io.keylos.bench.pod` list only their own purpose.

### 4.15 Share hot-plug

`Vm.attachShare(share)`:
1. Validate the name (REQ-BENCH-017), the purpose's share rules (§4.14) and, for agent VMs, that the share is an overlay.
2. For an overlay share, `Strata.begin([share.dir], NetworkPolicy.deny)` (route `strata#bench`).
3. Spawn a `bench-fs` backend for the share as the VM principal (§6.3).
4. Hot-plug a vhost-user-fs device with tag `share-<name>` through the crosvm control socket (`crosvm device add vhost-user-fs`). When the pinned crosvm build cannot hot-plug, bench uses one of the 8 spare vhost-user-fs slots reserved at boot (`bench.hotplug_slots`); when none is free, it fails with `kl:unavailable`.
5. `Guest.mountShare(tag, "/shares/<name>", readOnly)` (§4.9). Return when the guest confirms the mount.

`Vm.detachShare(name)`:
1. `Guest.unmountShare("/shares/<name>", force = true)`: open files get `EIO` from then on.
2. Unplug the device and stop the backend.
3. The overlay transaction (if any) remains; it is listed by `Vm.changes` until committed or discarded.

Writes `x-bench.share.attach` / `x-bench.share.detach`.

**Callers.** `broker` reaches tier-2 and tier-3 VMs' runtime directory grants through `bench-relay` (the powerbox path, §4.12) and `GuestPortals.powerbox`; `aide` attaches shares to agent VMs it owns; `cri` attaches image and volume shares to pod VMs.

### 4.16 Media VMs and `MediaBrowser`

`Bench.media(device)` (facet `user`; callers atrium and portal-files):
1. If a media VM for `device` is running, return it and a new `MediaBrowser` capability bound to the caller.
2. Otherwise claim the device: `MediaAttach.claimBlock(device, readOnly = false)` on route `devd#bench` (`protocols §7.5.8`). devd refuses unless the device is authorized (`protocols §9.5`).
3. Start a VM with `purpose = media`, image `io.keylos.bench.media`, 1 vCPU, 512 MiB, the block fd as `blockDevices[0]` (virtio-blk, `readOnly` false), no network, no shares, no display. The VM counts against the RAM-class cap.
4. The media image's `media-agent` (guest) probes partitions (`info` from devd tells which) and mounts the first supported filesystem read-write with `nodev,nosuid,noexec`: vfat, exfat, ntfs3, ext4, btrfs (read-only), iso9660, udf; MTP devices are accessed with a userspace MTP client. Kernel filesystem bugs therefore hit only the guest kernel.
5. Write `media.attach` with the device ID, the filesystem type and the VM session.

`MediaBrowser` (`protocols §7.5.10`), served by `benchd-host`:

| Method | Behaviour |
|---|---|
| `list(path)` | Forwarded to `media-agent`; paths are relative to the mount root, normalised, no `..`; at most 10,000 entries per call; names returned as received (untrusted) |
| `open(path)` | Opens a bulk vsock stream from the guest; bench first raises the caller's label (REQ-BENCH-101), then returns a `ByteSource` reading the stream and the file size |
| `export(path, data, mandate)` | Reads the data fd once into a bench-owned memfd while hashing it, checks the mandate (REQ-BENCH-102), then streams it to `media-agent`, which writes `path` with `O_CREAT|O_EXCL` (or a temp file plus rename when the mandate's constraints say `overwrite: true`) and `fsync`s; then writes `media.export` (REQ-BENCH-104) |
| `exportSeekable(path, sizeLimit)` | Creates a memfd with `MFD_ALLOW_SEALING`, size cap `sizeLimit`; returns it with an `ExportCompletion`. `finish(mandate)` seals, hashes, verifies (REQ-BENCH-105) and writes as `export`; `abort()` discards. An unfinished completion is discarded after 1 h |
| `eject()` | REQ-BENCH-103 |

**Who obtains the mandate.** The caller (`portal-files` or `atrium`, on behalf of the requesting app) stages a `media.export` intent on `gate` with the payload digest, the human approves it, and `Intent.commit` returns the delivered mandate in `IntentStatus.result`. bench never talks to `gate` for this.

A media VM is stopped after 10 minutes without any `MediaBrowser` holder or call. Removal of the device is detected by devd (`Devd.watch`) and handled as eject without unmount.

### 4.17 Guest portals (vsock 7004)

For tier-2 app VMs and agent-desktop VMs, `benchd-host` accepts connections on port 7004 from that VM's CID and hands them to the VM's `bench-relay`, which serves `GuestPortals` (`protocols §7.5.10`) **as the VM principal**:

| Method | Implementation in `bench-relay` |
|---|---|
| `notify` | `Notify.post` on route `portal-notify#default` (static route when the VM's generation declares `portal-notify`; otherwise `kl:denied`) |
| `openUri` | `OpenUri.open` on route `portal-openuri#default`; web URIs go to the untrusted browser because the caller is tier 2 |
| `print` | Reads the guest `ByteSource` into a sealed memfd (limit 512 MiB), then `Print.print` on route `portal-print#default` |
| `capture` | Frames of **this VM's** display only, taken by `bench-gpu` from the VM's own surfaces, streamed as PNG frames at most 2 per second; never the host session (REQ-BENCH-113) |
| `secret` | `Vault.open(name, purpose)` on route `vault#app` as the VM principal (REQ-BENCH-114); the value is read from the delivery memfd per `protocols §20.10` and returned as `Data` (it crosses into the guest, so the vault item's ACL must name the VM's generation) |
| `powerbox` | `Broker.powerbox` as the VM principal; a picked directory is hot-plugged with `Vm.attachShare` (§4.15) and the call returns its share name; a picked file is added to the `grants` share (§4.6) under a fresh name, which is returned |

Agent-desktop VMs use the same bridge so that apps inside the nested desktop can notify and open URIs, which reach the human labelled with the agent session's label.

### 4.18 Captive VMs

1. The human chooses "Sign in to network" in atrium, which calls `NetCaptive.signIn` (`protocols §7.5.11`). `net` calls `Bench.start(VmSpec{image = io.keylos.bench.captive-browser, purpose = captive, display = true, displayMode = interactive, bootArgs = [captive.url = <portal URL>]})` on facet `bench#net`.
2. bench registers the VM principal (`VmSpawn.register`) and returns the `Vm`; `net` reads `Vm.info()` (session, cgroup ID), mints the captive token (`BrokerSystem.mintCaptive`), which the broker attaches to the VM session, and admits the VM's cgroup for direct egress on tcp/80, tcp/443 and udp+tcp/53 for at most 600 s.
3. bench spawns `bench-net` in **direct-egress mode** with `VmSpawn.spawnVmm`: the entrypoint `bench-net-captive`, which warden starts without a private network namespace so it can open host sockets; its seccomp profile allows `socket(AF_INET/AF_INET6, SOCK_STREAM|SOCK_DGRAM)` and `connect` only, and it connects only to the destination ports above. It waits until `Broker.myGrants` (as the VM principal) shows the captive token, and stops at the token's `expires`. DNS queries go to the network's DHCP-provided resolver (the captive network's own DNS); synthetic DNS is off.
4. The guest receives `captive.url` through `Guest.bootArgs` before the browser starts; the browser opens it. The window appears through atrium's `Display` like any tier-3 VM.
5. At `expires`, or when `net` stops the VM (`Vm.stop` on facet `net`, for example when the network is no longer captive), `bench-net-captive` exits; the VM is discarded (no snapshot, no state kept).

### 4.19 Pod VMs (`cri`)

`cri` starts one pod VM per pod sandbox in the `keylos-vm` runtime class (`protocols §21.2`) on facet `cri`:
- **Image and runtime.** Image `io.keylos.bench.pod`: a minimal guest with `benchd`, `youki` and the CRI guest shim. `cri` drives containers with `Vm.exec(["youki", …])` against OCI bundles it hot-plugs as shares (`Vm.attachShare`): one read-only share per image root filesystem (from cri's image store), one share per volume (`StrataVolumes` subvolumes for emptyDir and local PVs; tmpfs content for projected volumes delivered as read-only shares). Container stdio is mapped through `Vm.exec` fd mappings.
- **Network.** A pod VM has one virtio-net device backed by a **tap** in the cri network namespace (`protocols §21.5`). The tap fd is created by `cri` inside that namespace and passed in `VmSpec.tap`, with `VmSpec.tapConfig` (`ifname`, `mac`, `mtu`) and `VmSpec.podId` (REQ-BENCH-097); bench hands it to crosvm (`--tap-fd`, `--mac`, MTU through the virtio-net config). `bench-net` is not used, and the guest gets its address from cri's IPAM through the kernel command line (`ip=` parameters). Egress policy for pods is cri's (nftables in the cri netns, optional gate shims).
- **Storage devices.** CSI node plugins and raw block volumes get block fds that cri claimed with `MediaAttach.claimBlock` (devd facet `cri`); cri passes them in `VmSpec.blockDevices` at start, or hot-plugs them later with `Vm.attachBlock` / `detachBlock` (REQ-BENCH-099), for example CSI volumes published after the sandbox started.
- **Restarts.** After a `crid` restart, cri calls `Bench.reattach(session)` for each pod VM it recorded; pod VMs keep running in between (REQ-BENCH-058).
- **GPU.** Only whole-device passthrough (`gpuPassthrough`, REQ-BENCH-044), with the VFIO fds cri obtained from `MediaAttach.claimVfio`; never virtio-gpu.
- **Limits.** vCPUs and memory from the pod's resources (`VmSpec.vcpus`, `memoryMiB`); cgroup under `/keylos.slice/kube.slice/<pod-uid>.scope` as assigned by cri's `PodSpawn` delegation (`protocols §10.3`).
- **Admission.** Pod VMs are exempt from the RAM-class cap on `server-k8s` (kubelet `maxPods` bounds them) and count against it elsewhere.

### 4.20 VFIO passthrough

For `gpuPassthrough = "<PCI address>"`: bench calls `MediaAttach.claimVfio(pciAddress)` (route `devd#bench`; for pods cri passes the fds), receives the VFIO group and device fds, and passes them to crosvm (`--vfio` with fd arguments). The device must be listed in config `devices.passthrough` (devd checks). The VM gets no virtio-gpu device and no display proxy. On destroy, bench calls `MediaAttach.release`. Snapshots of passthrough VMs are refused (`kl:unsupported`).

### 4.21 Agent desktops

- **Start.** aide calls `Bench.start` on facet `aide` with `purpose = agentDesktop`, the template's bench-image (which contains a nested atrium in headless agent-desktop mode and the apps the template lists), `display = true`, `displayMode = readOnly`. The host atrium shows the nested desktop as one window (atrium spec §4.20).
- **`Vm.desktop()`** returns an `AgentDesktop` (`protocols §7.5.13`) implemented by `benchd-host` over the guest protocol (`Guest.desktop`, §4.9):

| Method | Implementation |
|---|---|
| `screenshot` | The nested atrium renders its output into a PNG inside the guest; bench returns it (limit 8192×8192) |
| `input` | Validated JCS event list (at most 256 events, coordinates inside the output), delivered to the nested atrium's virtual input device; refused while taken over |
| `a11yTree` | The nested atrium's accessibility tree as JSON |
| `launch` | Starts an app inside the nested desktop by generation name; only apps present in the image or store set |
| `status` | `watchedBy` (the host atrium's mirror, when shown) and `takenOver` |

- **Take-over.** `Vm.takeOver(true)` sets `displayMode = interactive`: `bench-gpu` forwards host input to the guest and `AgentDesktop.input` fails with `kl:denied`. `takeOver(false)` restores read-only. Each switch writes `x-bench.desktop.takeover`.
- **Isolation.** The nested atrium is a separate compositor inside the guest; nothing in the agent desktop can reach the host session except through the display proxy (pixels out) and `GuestPortals` (§4.17).

### 4.22 Admission control

At start, bench reads the RAM class from `/run/keylos/boot/report.json` (`protocols §2.3`, §10.7), overridable by config `bench.ram_class`. Before each VM start (any path), bench counts running VMs per REQ-BENCH-093:

| Class | Cap | Memory tuning |
|---|---|---|
| `small` | 2 | KSM on tier-3 guest memory; free-page reporting; zstd-compressed snapshots; warm pool limited to one entry |
| `medium` | 6 | KSM on tier-3 guest memory; free-page reporting |
| `large` | 16 | Free-page reporting |

A start beyond the cap fails with `kl:unavailable` (`vm-cap:<class>:<cap>`); `aide` queues agent sessions on that error, other callers show it to the human. The warm pool does not count (it holds no running VM).

### 4.23 Workbench apps (IDEs)

A project lists GUI apps to run **inside** its workbench (`apps` in `project.ncl`, §5.4), for example an IDE. With any `apps` entry, the workbench starts with `display = true`, `displayMode = interactive`, and the `apps` generations in its store set. `work open <app>` (or the launcher entry atrium shows for the project) runs the app's entrypoint in the guest with `Vm.exec`; its windows appear on the host desktop through the display proxy with the violet tier-3 frame and the project name. Language servers, debuggers and test runners run inside the VM with the app. GPU follows `resources.gpu`.

---

## 5. Interfaces

### 5.1 capwire

bench implements `Bench` and `Vm` (`protocols §7.3.13`, A.13) and `BenchMerge` (`protocols §7.5.10`, A.18). Every bootstrap capability also implements `common.Extensible`. Facets are exactly those of `protocols §19.2`:

| Facet | Callers | Allowed |
|---|---|---|
| `user` | `kish`, `work`, `atrium`, `portal-files`, `forge` | `project`, `start` with purposes `workbench`, `build` (forge only, `unsignedImageOk`) and `app` (kish and the atrium launcher: non-reproducible native apps at tier 2); `snapshots`; `media` (atrium, portal-files); `reattach` (own VMs); `Vm` methods on VMs owned by the caller's human (`commit` for human workbenches; `attachShare`/`detachShare`; `fork`) |
| `net` | `net` | `start` with `purpose = captive` only; `Vm.info`, `Vm.stop` on captive VMs it started |
| `aide` | `aide` | All of `Bench`/`Vm` (including `fork` with `ForkSpec` and `reattach`); VMs created get actor kind `agent` (REQ-BENCH-012), purposes `agent` and `agentDesktop`, port 7002 relay and grant delegation; `Vm.desktop`, `takeOver` (aide relays the human's `AgentSession.takeOver`); `Vm.commit` refused |
| `compat` | `compat` | `start` with `purpose = app`, `display=true` for tier-2 legacy apps; `attachShare`/`detachShare` on those VMs |
| `merge` | `gate`, `aide` | `BenchMerge.manifest`, `render`, `preparedStatus`; `commitShare` and `commitPrepared` for `gate` only |
| `cri` | `cri` | `start` with `purpose = pod` (`tap`, `tapConfig`, `podId`); `reattach`; `Vm` (all, including `attachShare`/`detachShare`, `attachBlock`/`detachBlock`, `info`) on pod VMs |
| `admin` | owner `shell` (the `bench` CLI), `config` | All, plus `BenchAdmin` below |

`BenchAdmin` is repo-local (file ID outside the protocols range) and obtained with `Extensible.ext` on facet `admin`:

```capnp
@0xb3c4d5e6f7080002;
using C = import "common.capnp";
interface BenchAdmin {
  list      @0 () -> (json :Text);                       # all VMs (VmRecord array)
  kill      @1 (session :Text) -> ();
  deleteSnapshot @2 (id :Text) -> ();
  pinSnapshot @3 (id :Text, pinned :Bool) -> ();
  gc        @4 (dryRun :Bool) -> (json :Text);
  images    @5 () -> (json :Text);
  pool      @6 () -> (json :Text);                       # warm pool entries and residency
}
```

#### 5.1.1 `BenchMerge` semantics

| Method | Behaviour |
|---|---|
| `manifest(session, share)` | Checks the VM of `session` is an agent VM and `share` is an overlay share. Freezes the share's guest-side writes (virtio-fs flush), then calls `TransactionExt.prepare` on the share's transaction (through `StrataTxn.txnExt`, route `strata#bench`). strata freezes the views, captures the live base, merges and stores an immutable prepared merge (strata §4.5.6); for sealed agent workspaces the transaction uses the unitfs backend and the prepared store is ciphertext (strata §4.5.10). bench returns the prepared merge's `keylos.fsmerge/2` JCS bytes (`PreparedMerge.manifest`), its digest, the `source` snapshot id and the `pm-…` id, and records `share → pm-…`. Further agent writes are not in the prepared merge; the share is re-opened for writing on a fresh overlay generation only after commit or discard |
| `render(session, share, snapshot)` | Unified diff of the share's current prepared merge (`PreparedMerge.diff("")`; `snapshot` must equal its `source`, else `kl:conflict`), as a sealed memfd (text files; binary files listed as "binary, N bytes, sha256 …"). Used by `aide` and `gate` to build the `fs.merge` rendering, so the rendering shows exactly the prepared content |
| `commitShare(session, share, manifestDigest, mandate)` | `gate` only. Looks up the share's recorded prepared merge and checks its manifest digest equals `manifestDigest`; verifies the mandate envelope (`protocols §14.4`; signer per its `presence` and `channel` fields) and that one of its `effects` is `{kind: "fs.merge", digest: "sha256:<manifestDigest>"}`; then calls `PreparedMerge.commit(mandate)`, which fences writers, revalidates the live state and applies exactly the stored operations. Returns the strata transaction id and the undo snapshot. Writes `vm.commit`. Stale live state fails with `kl:conflict` listing paths (a new `manifest` and approval are needed) |

| `commitPrepared(prepared, manifestDigest, mandate, binding)` | `gate` only, for durable workflow effects (REQ-BENCH-118): resolves the prepared merge by id through `StrataTxn.preparedFor`, independent of the preparing session; returns the stored completion record when already committed; otherwise checks digest and mandate (with `constraints.workflow`) and calls `PreparedMerge.commit` |
| `preparedStatus(prepared)` | `gate`, `aide`: `PreparedMerge.status()` (REQ-BENCH-119), used by gate to reconcile an `fs.merge` effect after a lost reply |

Frozen merge snapshots are kept until the VM is discarded or 24 hours pass, whichever comes first (except REQ-BENCH-121).

#### 5.1.2 Routes bench holds

| Holder | Route | Use |
|---|---|---|
| `benchd-host` | `warden#bench` | `VmSpawn.register`, `spawnVmm`, `unregister` (VM principals and per-VM processes); `GrantMounts.idmappedDir` for shares |
| `benchd-host` | `depot#mounter` | `mount`, `get`, `root`, `unroot` |
| `benchd-host` | `strata#bench` | `begin`, `StrataTxn` (including `preparedFor`), `TransactionExt.bindWorkflow`, `PreparedMerge.status` |
| `benchd-host` | `broker#workflow` | `BrokerWorkflow.verify` for attempt VMs (REQ-BENCH-116) |
| `benchd-host` | `broker#principal` | `materialize` of device tokens (`/dev/kvm`, render nodes) |
| `benchd-host` | `broker#label-authority` | `LabelAuthority.raiseFor` (REQ-BENCH-016) |
| `benchd-host` | `aide#grant-delegate` | `GrantDelegate.request` |
| `benchd-host` | `atrium#display` | `Display.clientSocket` |
| `benchd-host` | `hearth#system` | `HearthSystem.owners` (owner-presence keys for `media.export` and `fs.merge` mandates) |
| `benchd-host` | `ledger#reader` | `Ledger.serviceKey("broker")` (non-presence mandates) |
| `benchd-host` | `devd#bench` | `MediaAttach.claimBlock`, `claimVfio`, `release` (§4.16, §4.20) |
| `benchd-host` | `ledger#writer` | Receipts (including the `media.export` completion receipt) |
| `bench-net` (VM principal) | `gate#shim` | `ShimEndpoint` |
| `bench-relay` (VM principal) | `broker#principal`; agent VMs: `aide#host`; tier-2 apps with audio: `portal-mic#playback` (and `portal-mic#capture` when granted) | Grant requests, powerbox, agent host relay, audio |
| `bench-relay` (VM principal; tier-2 and agent-desktop VMs) | `portal-*#default` (bench-relay is a registered holder for its VM principal, `protocols §19.2`; wired by warden at `spawnVmm` for the portals the VM's generation declares), `vault#app` (registered holder) | `GuestPortals` (§4.17) |
| `bench-net-captive` (captive VM principal) | `broker#principal` (`myGrants`, to read the captive token); host sockets limited by `net`'s firewall admission | Direct egress (§4.18) |

### 5.2 CLI `work`

The `work` CLI runs as the `shell` principal and acts on the current directory (resolved by `kish` into a dirfd).

| Command | Effect | Exit codes |
|---|---|---|
| `work` | Start or attach the project workbench; open an interactive shell in `/work/<project-name>` | 0; 2 no `project.ncl`; 3 KVM unavailable; 4 evaluation error |
| `work run -- <cmd…>` | Run one command in the workbench, streaming stdio; exit with the command's code | Command's code; 125 on bench error |
| `work status` | Print state, snapshot, shares, store set, grants and resource use | 0 |
| `work stop` | Stop the project VM | 0 |
| `work reset` | Discard the VM and its base snapshot; the next `work` cold-boots | 0 |
| `work snapshot [name]` | Take a named snapshot | 0 |
| `work restore <name>` | Replace the running VM with one restored from a named snapshot | 0 |
| `work fork [--name n]` | Fork the workbench; open a shell in the fork (writable shares become overlays) | 0 |
| `work diff [--share s]` | Show changes in overlay shares (forks) | 0 |
| `work commit [--share s]` | Commit overlay changes of a human fork (T0); refused for agent VMs, whose changes merge through `aide review` | 0; 5 conflicts |
| `work discard` | Discard the fork | 0 |
| `work grants` | List network grants of the workbench | 0 |
| `work allow <host>[:port] [--for 8h]` | Request a network grant (T2 prompt) | 0; 6 denied |
| `work gc` | Remove unused snapshots and caches of this project | 0 |
| `work init [--template t]` | Write a starter `project.ncl` (templates: rust, python, node, go, c, generic) | 0 |
| `work open <app>` | Start a workbench app (an `apps` entry, §4.23) inside the workbench; its windows appear on the host desktop | 0; 7 app not listed |
| `work attach <dir> [--name n] [--rw]` | Hot-plug a directory the shell resolved as an fd into the running workbench at `/shares/<n>` | 0 |
| `work detach <name>` | Remove a hot-plugged share | 0 |

**Flags common to all commands:**

| Flag | Meaning |
|---|---|
| `--project <dir>` | Use another directory (passed as an fd by the shell) |
| `--json` | Machine-readable output (`records` in cmdsig) |
| `--no-snapshot` | Force a cold boot |

`work` ships `cmdsig` files for every subcommand (for example the output of `work status` is `records{key:text, value:text}`).

### 5.3 CLI `bench`

| Command | Effect |
|---|---|
| `bench ls [--all]` | List VMs (session, origin, tier, state, memory, uptime) |
| `bench kill <session>` | Kill a VM |
| `bench images` | List installed bench-image generations |
| `bench snapshots [--project p]` | List snapshots with size and pin state |
| `bench pin <snap>` / `bench unpin <snap>` | Pin or unpin a snapshot |
| `bench rm-snapshot <snap>` | Delete a snapshot |
| `bench gc [--dry-run]` | Global snapshot and cache GC |
| `bench console <session>` | Attach to the serial console (owner, T2 approval for VMs of other humans) |

Exit codes: 0 success; 1 not found; 2 denied; 3 KVM unavailable; 125 internal error.

### 5.4 `project.ncl` schema

The schema is published as the Nickel module `keylos/project@1`:

```nickel
{
  ProjectSchema = {
    name | String,
    image | String | default = "io.keylos.bench.guest",          # bench-image generation name or gen ref
    toolchains | Array String | default = [],                     # generation names or gen refs, e.g. "org.rust-lang.rustc@1.90"
    packages | Array String | default = [],                       # additional store generations exposed in /keylos/gens
    setup | Array {
        run | Array String,                                        # argv
        root | Bool | default = false,
        when | [| 'base, 'every-start |] | default = 'base,
      } | default = [],
    services | { _ : { run | Array String, ports | Array Number | default = [] } } | default = {},
    caches | { _ : { path | String, max_gib | Number | default = 20 } } | default = {},
    env | { _ : String } | default = {},                          # validated: no secret-looking names (KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL)
    resources | {
        vcpus | Number | optional,
        memory_gib | Number | optional,
        disk_gib | Number | default = 64,
        gpu | Bool | default = false,
      } | default = {},
    network | {
        allow | Array String | default = [],                       # "host[:port][/proto]" requested at first start (T2)
        registries | Array [| 'crates-io, 'npm, 'pypi, 'go-proxy, 'maven-central, 'debian, 'fedora, 'ghcr, 'dockerhub |] | default = [],
      } | default = {},
    agents | {
        default_template | String | optional,
        budget_usd | Number | default = 5,
        deadline_minutes | Number | default = 60,
        network | Array String | default = [],                     # subset of network.allow agents may use without asking
      } | default = {},
    shares | { _ : { path | String, writable | Bool | default = true } } | default = {},  # extra paths relative to project root
    apps | Array {
        generation | String,                                       # GUI app generation run inside the workbench (e.g. an IDE)
        entrypoint | String | default = "main",
        autostart | Bool | default = false,
      } | default = [],
  }
}
```

**Normative rules:**
- `env` values are visible to every guest process and to agents. The schema contract rejects names matching `(?i)(key|token|secret|passw|credential)`. Secrets reach workbenches only through `gate` credential injection.
- `network.registries` expand to fixed host lists maintained in the bench-image generation (`/usr/share/bench/registries.json`).
- `toolchains` are resolved to `gen` refs. A missing name triggers `Depot.install` (a T2 approval when the generation is not yet installed).

**Example:**

```nickel
let P = import "keylos/project@1" in
{
  name = "payments-api",
  toolchains = ["org.rust-lang.rustc@1.90", "org.postgresql.server@17"],
  setup = [{ run = ["cargo", "fetch"] }],
  services = { db = { run = ["postgres", "-D", "/var/lib/pg"], ports = [5432] } },
  caches = { cargo = { path = "/home/work/.cargo/registry" } },
  network = { registries = ['crates-io], allow = ["api.stripe.com:443/https"] },
  agents = { default_template = "io.keylos.agent.coder", budget_usd = 10 },
} | P.ProjectSchema
```

### 5.5 Files and sockets

| Path | Owner | Purpose |
|---|---|---|
| `/run/keylos/svc/bench/` | warden | bench service sockets |
| `/var/lib/bench/**` | bench service UID | §4.2 |
| `vms/<session>/sockets/{vmm.sock,fs-<share>.sock,net.sock,gpu.sock}` | The VM principal's UID | crosvm control and vhost-user sockets; bench's UID gets access via a passed fd, never by path |

---

## 6. Security

### 6.1 Threats and mitigations

| # | Threat | Mitigation |
|---|---|---|
| B1 | Guest kernel compromise leads to VMM escape | crosvm is written in Rust and runs with a minimal device set (virtio-blk, net via vhost-user, fs via vhost-user, gpu via vhost-user, vsock, rng, balloon; no legacy devices except serial). The VMM process is confined per §6.3. Each device backend is a separate confined process. |
| B2 | A compromised device backend reaches host data | Each backend holds only its own fds: `bench-fs` holds one share root, `bench-net` holds only its gate capability, `bench-gpu` holds the render node and optionally the Wayland socket. Landlock deny-all except those; seccomp baseline plus minimal allowances. |
| B3 | Guest exfiltrates via the network | No NIC path except `bench-net` to `gate`. Synthetic DNS means every flow is checked by host name. gate enforces labels and the Rule of Two for agent sessions. |
| B4 | Guest abuses DNS as a covert channel | Synthetic DNS answers locally and never forwards A/AAAA queries. Other record types are forwarded only for granted names, rate-limited (REQ-BENCH-034). |
| B5 | Symlink or path tricks in shares escape to the host (the class of Flatpak CVE-2024-42472 and Claude Code CVE-2026-39861) | Shares are served from fds with `RESOLVE_BENEATH`; `bench-fs` never follows guest-created symlinks on the host side (REQ-BENCH-015). Commits go through strata, which also never follows paths (I7). |
| B6 | An agent writes into config read by a harness or another agent | Agent VMs only see overlay shares; commits are T3 and rendered as diffs. Share directories never include `~/.config`, `.apps/` or harness state unless explicitly granted, and `aide` never grants them. |
| B7 | GPU driver attack from the guest | Native context still reaches the host kernel GPU driver; this is an accepted residual risk. GPU is off by default for agent VMs (policy MAY forbid it entirely) and is per-VM opt-in. The card node is never exposed. |
| B8 | Snapshot leaks secrets (memory images) | Snapshot files are owned by the bench UID, live on the encrypted root, and are part of the `bench` data unit with its own crypto-shred key (§6.4). `work reset` and `bench rm-snapshot` delete them. Agent fork temporaries are deleted within 10 minutes. |
| B9 | Forked VMs reuse RNG state or keys | REQ-BENCH-053 fixups. Guest software that cached randomness before the snapshot is advised against: base snapshots are taken before user sessions start. |
| B10 | Clipboard or screen theft by tier-2 apps | `bench-wl` filters globals; atrium enforces security context on the tagged connection. |
| B11 | Time-of-check races on share directories | Share fds are taken from the caller; there is no path resolution. Overlay commit conflicts are detected by strata. |
| B12 | A malicious `project.ncl` (cloned repository) | Evaluation is sandboxed: the Nickel evaluator runs inside bench with no I/O except reading files beneath the project dirfd and the schema. Everything a project requests (toolchains, hosts) goes through grants and T2 prompts; a project cannot grant itself anything. |
| B13 | Resource exhaustion | cgroup limits (§4.13), per-VM flow caps, snapshot GC, memory overcommit protection (`bench.maxCommittedMemory`, default 150% of RAM), RAM-class VM caps (§4.22). |
| B14 | Malicious filesystem image on a USB stick | Mounted only inside the media VM's guest kernel; the host never opens the device except to pass its fd to crosvm (REQ-BENCH-100). Bytes leave the VM as untrusted streams. |
| B15 | Exfiltration to removable media | `MediaBrowser.export` requires a `media.export` mandate bound to the exact bytes (REQ-BENCH-102). |
| B16 | Captive-portal VM used as an unfiltered network path | Only the captive image, only for ≤ 600 s, only ports 80/443/53, no shares, no store set, discarded after use (REQ-BENCH-036, -037). |
| B17 | Agent drives the human's real desktop | Agent desktops are nested desktops inside the agent's VM; host input reaches them only after human take-over; agents get `AgentDesktop` only for their own VM (REQ-BENCH-110, -111). |
| B18 | VFIO device attacks the host (DMA) | Passthrough only for config-listed devices, with the IOMMU required on every profile (`protocols §2`); the host driver is unbound while the VM runs. |
| B19 | Pod VM reaches host networks | The only network device is the tap in the cri netns; cri's nftables policy applies; no `bench-net`, no vsock beyond 1024–1535. |
| B21 | Replay of a `media.export` mandate to write other or additional bytes | Mandates are bound to the content digest and single-use (REQ-BENCH-102); `exportSeekable` seals the memfd before hashing (REQ-BENCH-105). |
| B22 | A caller other than `net` starts a captive VM to bypass gate | Purpose `captive` only on facet `bench#net` (REQ-BENCH-036); direct egress also needs the broker-attached captive token and `net`'s firewall admission. |
| B20 | Tier-2 guest abuses guest portals | `bench-relay` calls portals as the VM principal, so every portal applies tier-2 rules (untrusted browser routing, attribution, label raises); secrets only for items whose ACL names the VM's generation. |

### 6.2 What bench itself holds

`benchd-host`:
- **Principal:** `service:bench:<gen>@_system/s-…`, tier 0.
- **Routes:** as listed in §5.1.2. `benchd-host` holds no `gate` route; only each VM's `bench-net` holds `gate#shim`, bound to that VM principal.
- **Devices:** `/dev/kvm` (obtained from `devd` through a broker device grant at service start, passed to crosvm only), and `/dev/vhost-vsock` (passed to crosvm).
- **Filesystem:** read-write `/var/lib/bench` through a dirfd provided by `warden` at spawn. Landlock: that tree only.
- **No network.** bench does not hold network grants itself; `bench-net` connects through gate with the VM's tokens.

### 6.3 Confinement of per-VM processes

All are spawned by `warden` with `VmSpawn.spawnVmm` (route `warden#bench`) into the VM principal that `VmSpawn.register` created, with that principal's actor kind (`bench`, `agent`, `legacy` or `pod`) and session.

| Process | Namespaces | Landlock | seccomp beyond baseline | Fds |
|---|---|---|---|---|
| crosvm | mnt, pid, ipc, uts, cgroup, net (`lo` only) | deny-all except its `vms/<session>` dir (rw), the `snapshots/<id>` dir (ro or rw while taking) and the bench generation (ro) | KVM ioctls on the kvm/vm/vcpu fds (filtered by fd-number argument check where possible), `eventfd2`, `timerfd_*`, `signalfd4`, large `mmap`/`mremap`/`madvise`, `ioctl(VHOST_*)` on vhost-vsock, `sched_setaffinity` | `/dev/kvm`, `/dev/vhost-vsock`, vhost-user sockets, control socket |
| bench-fs | as above | read-only or read-write on the share root fd only (rw only for writable shares), plus the vhost-user socket | `openat2`, `fgetxattr` (labels), `fallocate`, `copy_file_range`; no `open_by_handle_at` (no `CAP_DAC_READ_SEARCH`; inode file handles are disabled) | share dirfd (idmapped to the VM UID with `GrantMounts.idmappedDir`), vhost-user socket, control socket to `benchd-host` |
| bench-net | as above (no net namespace interface except `lo`) | none (no filesystem) | none beyond baseline | vhost-user socket, `gate#shim` capwire socket, control socket |
| bench-relay | as above | none | none beyond baseline | `broker#principal` socket, `aide#host` socket (agent VMs), control socket |
| bench-gpu | as above | read on the Mesa/Vulkan driver generation | DRM ioctls on the render node fd, `memfd_create`, `udmabuf` ioctls when present | render-node fd, Wayland socket (display VMs), vhost-user socket |
| bench-net-captive | mnt, pid, ipc, uts, cgroup (no net namespace: host network stack) | none | `socket(AF_INET/AF_INET6, SOCK_STREAM/SOCK_DGRAM)`, `connect`, `sendmmsg`/`recvmmsg`; no `bind` to ports < 1024, no raw sockets | vhost-user socket, control socket; `net`'s firewall admits its UID only on tcp/80, tcp/443, udp+tcp/53 until `expires` |
| crosvm (pod VMs) | as crosvm, plus the tap fd created by cri in the cri netns | as crosvm | as crosvm, plus `TUNSETOFFLOAD`/`TUNSETVNETHDRSZ` ioctls on the tap fd | tap fd, block fds, VFIO fds as passed |

**User namespaces:** none of these processes get a user namespace, and none can create one (baseline).

### 6.4 Data protection

`/var/lib/bench` is a strata data unit `bench` with its own crypto-shred key. Per-project caches and snapshots are sub-units `bench/<project-id>`. `strata forget bench/<project-id>` destroys them irrecoverably, including in snapshots and backups.

---

## 7. Failure modes and recovery

| Failure | Detection | Behaviour |
|---|---|---|
| crosvm crash | `Process.wait` returns | VM goes to `failed`; overlay transactions kept for `Vm.changes`/`diff`; `work` offers `work restore` or `work reset` |
| Backend crash (`bench-fs`) | Process exit | Guest sees an I/O error on that share. bench restarts the backend once, with the same fd; the guest `benchd` remounts. A second crash within 60 s marks the share failed. |
| `bench-net` crash | Process exit | All flows reset. Restart once; the guest DHCP lease survives. |
| Snapshot incompatible after an update | Restore validation | Cold boot, new base snapshot; old snapshot GC'd after 7 days unless pinned |
| Host memory pressure | PSI on the VM cgroups (`memory.pressure` > 40% over 10 s) | Inflate balloons of tier-3 VMs by 25%; freeze idle tier-2 VMs (no input for 10 min); never kill a VM with uncommitted overlays without a notification |
| Disk full in `/var/lib/bench` | `statfs` < 5% | Refuse new snapshots; GC fork temporaries; notify through `atrium` |
| strata commit conflict | `Transaction.conflicts` non-empty | `Vm.commit` fails with `kl:conflict`, listing paths; `work diff` shows them; the user resolves in the fork and retries |
| Grant revoked mid-flow | gate closes the socket | Guest sees RST; subsequent connects are re-checked |
| Guest stops answering vsock | `Guest.stats` heartbeat every 10 s; 3 misses | VM marked `unresponsive` in status; `stop` escalates to kill |
| bench service restart | warden restarts bench | Every VM is stopped (REQ-BENCH-059): bench kills the VM cgroups through `PrincipalControl.terminate`, calls `VmSpawn.unregister`, marks the VMs `stopped` in `registry.db` and keeps overlay transactions and snapshots. Callers see `kl:not-found` from `reattach` and restart their VMs (cri recreates pod sandboxes; aide resumes sessions from their last snapshot; `work` restores the project base snapshot). |
| Attempt binding stale or workflow cancelled at `start`/`fork` | REQ-BENCH-116 | `kl:conflict` / `kl:revoked`; nothing allocated |
| `commitPrepared` after the preparing VM is gone (bench or host restart) | — | Works from the `pm-…` id (REQ-BENCH-118, REQ-BENCH-120); an already committed prepared merge returns its stored record |
| `crid` or `aide` restart | Caller reconnects | Pod, agent and agent-desktop VMs keep running; the caller calls `Bench.reattach(session)` (REQ-BENCH-058) |
| Image lacks the requested purpose | REQ-BENCH-095 | `kl:denied` naming the image's `benchImage.purposes` |
| VM cap reached | Admission check | `kl:unavailable` (`vm-cap:<class>:<cap>`); aide queues; other callers report it |
| Hot-plug unsupported and no spare slot | crosvm control error | `attachShare` fails with `kl:unavailable`; the VM is unaffected |
| Removable device pulled during a read or export | devd watch; guest I/O error | `MediaBrowser` calls fail with `kl:unavailable`; VM stopped; `media.eject` with `reason: removed` |
| Media filesystem unsupported or corrupt | `media-agent` mount failure | `MediaBrowser.list` fails with `kl:unsupported`; the device stays claimed until `eject` so the human can see it |
| Captive admission expires while the portal page is open | `expires` reached | `bench-net-captive` exits; the browser shows its network error; atrium offers "Try again" |
| VFIO device fails to reset on release | devd reports an error | The device stays bound to `vfio-pci` and unavailable until reboot; a trusted notification explains |

---

## 8. Performance budgets

Reference host: 8-core x86-64 or Apple-class aarch64 laptop, NVMe.

| Operation | Budget (p50 / p95) |
|---|---|
| Restore from base snapshot to `hello` | 120 ms / 300 ms |
| Fork of a running VM (child `hello`) | 80 ms / 200 ms (excluding a dirty-memory flush larger than 256 MiB) |
| Cold boot to `hello` (no snapshot) | 900 ms / 1.5 s |
| `Vm.exec` round trip (`true`) | 8 ms / 20 ms |
| `work` in a warm project to shell prompt | 250 ms / 500 ms |
| virtio-fs sequential read with DAX | ≥ 70% of host throughput |
| virtio-fs metadata (`git status` on 100k files) | ≤ 3× host time |
| `bench-net` throughput per VM | ≥ 1.5 Gbit/s TCP with a local gate echo; latency overhead ≤ 0.3 ms per connection setup excluding gate |
| Host memory overhead per VM (excluding guest RAM) | ≤ 40 MiB (crosvm + backends) |
| Snapshot pause time | ≤ 300 ms plus dirty memory at 2 GiB/s |
| `Vm.attachShare` to guest mount ready | 150 ms / 400 ms |
| `Bench.media` cold (VM boot + mount) | 1.2 s / 2 s |
| `MediaBrowser.list` (1,000 entries) | 60 ms / 200 ms |
| Media read throughput | ≥ 80% of host USB throughput |
| `AgentDesktop.screenshot` (1920×1080) | 60 ms / 150 ms |
| Captive VM start to browser window | 1.5 s / 3 s |
| `Vm.attachBlock` to guest device visible | 100 ms / 300 ms |
| `Bench.reattach` | 5 ms / 20 ms |
| `ExportCompletion.finish` verification (excluding device write), 1 GiB | 1.2 s / 2 s (SHA-256 bound) |

---

## 9. Observability

### 9.1 Logs

Structured records (`protocols §10.6`) with fields `vm` (session), `project`, `op`, `latency_ms` and `state`. crosvm and backend stderr are captured by `warden` into the journal under the VM principal.

### 9.2 Receipts

bench writes receipts through `ledger#writer`. Core events (`protocols §19.3`):

| Event | `data` fields |
|---|---|
| `vm.start` | session, tier, image, storeSet, shares (name, mode), gpu context, network root IDs, warm-pool hit, `attempt` (`{workflow, attempt, epoch}` for attempt VMs) |
| `vm.stop` | session, reason, uptime |
| `vm.snapshot` | session, snapshot id, bytes |
| `vm.fork` | parent session, child session, snapshot id |
| `vm.commit` | session, share, transaction id, approval id or mandate digest; for `commitPrepared` also `prepared` and `workflow` (session = the preparing VM's session) |
| `vm.discard` | session, uncommitted shares |

Repo-local extension events (`protocols §19.3` extension rule; written only by bench, no meaning for other components):

| Event | `data` fields |
|---|---|
| `x-bench.grant.request` | session, resource, path (`broker` or `delegate`), outcome |
| `x-bench.label.refused` | session, share, label |
| `x-bench.merge.manifest` | session, share, snapshot, manifest digest, change count |
| `x-bench.share.attach`, `x-bench.share.detach` | session, share name, mode, transaction id |
| `x-bench.desktop.takeover` | session, interactive (bool), human |

Core events also written by bench: `media.attach` (device, filesystem, VM session), `media.eject` (device, reason: `user` / `removed` / `idle`) and `media.export` (device, path, bytes, content digest, mandate digest; the completion receipt of the caller-executed effect, `protocols §14.2`).

`strata` additionally writes `txn.*` receipts, and `gate` writes `effect.*` and `net.connect`.

### 9.3 Metrics

Exposed through `journal`, as OpenMetrics text on request:

| Metric | Type |
|---|---|
| `bench_vms{tier,state}` | gauge |
| `bench_start_seconds{kind=restore\|cold\|fork}` | histogram |
| `bench_snapshot_bytes` | gauge |
| `bench_net_flows_active` | gauge |
| `bench_net_flows_refused_total{reason}` | counter |
| `bench_fs_ops_total{share,op}` | counter |
| `bench_memory_committed_bytes` | gauge |

---

## 10. Configuration

Nickel module `keylos/config/bench@1`, part of the system config generation:

```nickel
{
  bench | {
    enabled | Bool | default = true,
    images | {
      default | String | default = "io.keylos.bench.guest",
      allowed | Array String | default = ["io.keylos.bench.guest"],   # names or gen refs
    } | default = {},
    defaults | {
      tier3 | { vcpus | Number | optional, memory_gib | Number | default = 8, disk_gib | Number | default = 64 },
      tier2 | { vcpus | Number | default = 2, memory_gib | Number | default = 2, disk_gib | Number | default = 8 },
    } | default = {},
    gpu | {
      allow_tier3 | Bool | default = true,
      allow_agents | Bool | default = false,
      allow_tier2 | Bool | default = true,
      context_order | Array [| 'drm, 'venus |] | default = ['drm, 'venus],
    } | default = {},
    snapshots | {
      max_per_project | Number | default = 3,
      fork_temp_ttl_minutes | Number | default = 10,
      incompatible_ttl_days | Number | default = 7,
    } | default = {},
    max_committed_memory_percent | Number | default = 150,
    network | {
      per_vm_mbit | { tier3 | Number | default = 1000, tier2 | Number | default = 100 },
      max_flows | { tier3 | Number | default = 256, tier2 | Number | default = 64 },
      dns_qps | Number | default = 200,
    } | default = {},
    registries_override | { _ : Array String } | default = {},
    warm_pool | Array {
        image | String,                     # bench-image name or gen ref
        store_set | Array String | default = [],
        size | [| 'small, 'default, 'large |] | default = 'default,
        count | Number | default = 2,       # prepared scratch reflinks
      } | default = [ { image = "io.keylos.bench.guest", size = 'default, count = 2 } ],
    merge_snapshot_ttl_hours | Number | default = 24,
    ram_class | [| 'auto, 'small, 'medium, 'large |] | default = 'auto,   # protocols §2.3; 'auto reads the boot report
    hotplug_slots | Number | default = 8,
    media | {
      image | String | default = "io.keylos.bench.media",
      idle_minutes | Number | default = 10,
      filesystems | Array String | default = ["vfat", "exfat", "ntfs3", "ext4", "btrfs", "iso9660", "udf", "mtp"],
      export_max_gib | Number | default = 16,                         # exportSeekable size cap
    } | default = {},
    captive_image | String | default = "io.keylos.bench.captive-browser",
    app_image | String | default = "io.keylos.bench.guest",          # bench-image for non-reproducible native apps (purpose app on facet user)
    pod_image | String | default = "io.keylos.bench.pod",
  }
}
```

---

## 11. Testing and acceptance

### 11.1 Unit tests

- State machine: every legal and illegal transition (table-driven from §4.3).
- `project.ncl` schema: valid and invalid examples, including secret-like env names.
- Synthetic DNS allocator: uniqueness, LRU eviction, IPv4/IPv6 pools.
- Flow-to-`NetTarget` mapping (synthetic address map, literal IPs, UDP association) and refusal caching.
- `keylos.fsmerge/2` handling: the digest bench returns equals strata's prepared-merge digest; JCS bytes checked against the `fsmerge/` protocols vectors.
- Mandate check in `commitShare`: matching and mismatching `effects[].digest`.
- Snapshot compatibility checks.

### 11.2 Fuzz targets (cargo-fuzz)

| Target | Input |
|---|---|
| `fuzz_guest_proto` | Arbitrary capnp messages from the guest into `HostControl` |
| `fuzz_bench_net` | Arbitrary Ethernet frames into the `bench-net` stack (smoltcp plus the flow mapper) |
| `fuzz_dns` | Arbitrary DNS queries |
| `fuzz_project_eval` | Arbitrary `project.ncl` input to the sandboxed evaluator (must never perform I/O outside the dirfd) |

### 11.3 Conformance

- protocols vectors: `capwire/` (including capwire-vsock fd rejection), `fsmerge/`, `labels/`, `ids/`.

### 11.4 Integration tests

They run on a KVM-capable CI runner with a full keylos image.

| ID | Test | Pass criterion |
|---|---|---|
| AT-BENCH-01 | `work` in a fresh Rust project | Shell within 1.5 s cold; second `work` within 500 ms p95 |
| AT-BENCH-02 | `curl https://example.com` in a workbench without a grant | RST; T2 prompt raised; after approval succeeds; `x-bench.grant.request` and `net.connect` receipts present |
| AT-BENCH-03 | Guest connects to `1.1.1.1:443` literally | Refused (REQ-BENCH-033) |
| AT-BENCH-04 | Agent fork creates a symlink `link -> /etc/passwd` in an overlay share; `gate` executes an approved `fs.merge` through `BenchMerge.commitShare` | The committed tree contains a symlink; no host file outside the share was read or written (verified by fanotify watch on the host) |
| AT-BENCH-05 | Fork, modify, discard | Parent tree unchanged; `vm.discard` receipt |
| AT-BENCH-06 | Fork RNG | Parent and child read 32 bytes from `/dev/urandom` after the fork; the values differ |
| AT-BENCH-07 | Kill `bench-fs` during a write | Restarted once; guest remount; no host-side corruption |
| AT-BENCH-08 | Revoke the agent root token | Agent VM killed within 1 s |
| AT-BENCH-09 | Tier-2 app tries `zwlr_screencopy_manager_v1` | Global absent in the guest |
| AT-BENCH-10 | Host without `/dev/kvm` | `work` exits 3 with a clear message; nothing runs on the host |
| AT-BENCH-11 | GPU VM on an AMD host | `drm` context; `vkcube` renders; confinement report shows `gpu: drm` |
| AT-BENCH-12 | bench service restart with 3 running VMs (a workbench, an agent VM and a pod VM) | All three are stopped and marked `stopped`; overlay transactions are intact; `reattach` fails `kl:not-found`; a new `work` restores from the base snapshot |
| AT-BENCH-13 | `BenchMerge.commitShare` with a mandate whose digest names a different manifest | `kl:integrity`; nothing merged |
| AT-BENCH-14 | Agent writes a file after `BenchMerge.manifest`, then the approved merge commits | The late write is not merged; it stays in the agent's overlay |
| AT-BENCH-45 | After `manifest` and approval, a host process edits a non-overlapping line of a merged file; `gate` calls `commitShare` | `kl:conflict` (stale); nothing merged; a new `manifest` returns a different digest and the old mandate fails `kl:integrity` |
| AT-BENCH-46 | `manifest` twice without a commit; `commitShare` with the first digest | `kl:integrity`: only the latest prepared merge is committable |
| AT-BENCH-47 | Sealed agent workspace (unitfs) on a kernel without btrfs fscrypt: `manifest`, `render`, `commitShare` | Merge succeeds; no plaintext of the workspace appears outside the unit's ciphertext backing (strata IT-37) |
| AT-BENCH-15 | `Vm.commit` on an agent VM | `kl:denied` |
| AT-BENCH-16 | Agent VM opens a share file labelled `private/user` | The VM session label (via `LabelAuthority.labelOf`) is `private/…` before the guest receives the first byte |
| AT-BENCH-17 | Harness connects to `vsock:2:7002` | `aide` test double sees a connection whose peer is the VM principal; from a non-agent VM the connection is refused |
| AT-BENCH-18 | `ShimEndpoint.caBundle` returns a CA | `/keylos/ca` exists in the guest and `curl` trusts the interception certificate; with empty bundle, the share is absent |
| AT-BENCH-19 | Workbench `dig MX example.com` without a grant for `example.com` | NXDOMAIN; with a grant, the answer from `ShimEndpoint.resolve` |
| AT-BENCH-20 | Warm-pool start of an agent VM | `vm.start` with warm-pool hit; restore to `hello` within the budget; guest machine ID differs from the pool snapshot's |
| AT-BENCH-21 | `attachShare` on a running workbench | `/shares/<n>` appears within budget; `detachShare` makes an open file return `EIO`; no host path resolution (fanotify) |
| AT-BENCH-22 | `Bench.media` for a FAT stick with a crafted corrupt filesystem | Guest kernel errors only; host `dmesg` shows no filesystem driver activity; `list` fails `kl:unsupported` |
| AT-BENCH-23 | `MediaBrowser.open` | Caller label raised to `public/untrusted` before the first byte; bytes match the file |
| AT-BENCH-24 | `MediaBrowser.export` with a mandate for different bytes | `kl:integrity`; nothing written to the device |
| AT-BENCH-25 | RAM class `small` with 2 running VMs | A third `start` fails `kl:unavailable` with `vm-cap:small:2`; a captive VM still starts |
| AT-BENCH-26 | Agent desktop | `Vm.desktop().screenshot` returns the nested desktop; host keyboard input does not reach it while read-only; after `takeOver(true)`, it does and `AgentDesktop.input` fails `kl:denied` |
| AT-BENCH-27 | `GuestPortals.capture` from a tier-2 VM | Frames contain only that VM's surfaces |
| AT-BENCH-28 | `GuestPortals.secret` for an item whose ACL does not name the VM generation | `kl:denied` |
| AT-BENCH-29 | Port 7004 from a workbench | Connection refused |
| AT-BENCH-30 | Captive VM | Direct egress to tcp/443 works for ≤ 600 s and stops after `expires`; tcp/22 never works; the VM has no shares |
| AT-BENCH-31 | Pod VM (fixture tap in a test netns) | `youki` runs a container from a hot-plugged image share; traffic leaves only through the tap |
| AT-BENCH-32 | `unsignedImageOk` from a non-forge caller | `kl:denied` |
| AT-BENCH-33 | VFIO passthrough of a config-listed test device | crosvm receives the VFIO fds; no virtio-gpu device; snapshot refused |
| AT-BENCH-34 | Workbench with an `apps` IDE entry | `work open ide` shows a host window with the violet frame and project name |
| AT-BENCH-35 | Start any VM | warden sees `VmSpawn.register` before any `spawnVmm`; every per-VM process is in the registered principal's cgroup; `unregister` after exit; no `Supervisor.spawn` calls from bench (warden trace) |
| AT-BENCH-36 | `Vm.fork(ForkSpec{principalKind = bench})` on facet `aide` | The fork's principal is `agent:…` with the given session; on facet `user`, `principalKind = agent` fails `kl:denied` |
| AT-BENCH-36a | `Vm.fork(ForkSpec{checks = ["check if operation(\"path\", $op), [\"read\"].contains($op)"], budgets = [usd-micro 1000000]})` | warden's `VmSpawn.register` test double receives the checks and budgets in `VmPrincipal`; the fork's tokens fail a write `materialize`; no token from bench itself reaches the fork |
| AT-BENCH-37 | aide drops its `Vm` capability of a running agent VM, then calls `reattach(session)` | VM still running; new capability works; `reattach` from another principal fails `kl:not-found`; a workbench is stopped 5 s after its last capability is dropped |
| AT-BENCH-38 | Captive VM requested on facet `user` | `kl:denied`; on facet `net` with `bootArgs captive.url`, the guest browser opens that URL; `bench-net-captive` stops at the token's `expires` |
| AT-BENCH-39 | Start `io.keylos.bench.media` with purpose `workbench`; start an image without `benchImage` | Both `kl:denied` (REQ-BENCH-095) |
| AT-BENCH-40 | Pod VM with `VmSpec.tap` and `tapConfig` | The guest NIC has the given MAC and MTU; a tap fd on any non-pod request fails `kl:denied` |
| AT-BENCH-41 | `attachBlock` on a running pod VM | Guest sees the virtio-blk device within budget; `detachBlock` makes guest I/O fail; refused on a workbench |
| AT-BENCH-42 | `MediaBrowser.export` with a valid broker-signed mandate, then the same mandate again | First write succeeds and `media.export` receipt names the mandate digest; second call `kl:integrity` |
| AT-BENCH-43 | `exportSeekable`: write, seek back, rewrite, `finish` with a mandate for the final contents | Device file equals the final contents; a mandate for an intermediate state fails `kl:integrity`; `abort` writes nothing |
| AT-BENCH-44 | Native non-reproducible app launched from the atrium launcher | `start` on facet `user` with purpose `app` succeeds at tier 2 with `bench.app_image`; port 7004 available; purpose `app` from `portal-files` fails `kl:denied` |
| AT-BENCH-48 | `start` with `VmSpec.attempt` on facet `user`; on facet `aide` with `principalKind = bench`; on facet `aide` with a stale binding (broker double) | `kl:denied`; `kl:denied`; `kl:conflict`, no VM, cgroup or share created |
| AT-BENCH-49 | Attempt VM with an overlay share | `bindWorkflow` called for the share's transaction before boot; `VmPrincipal.attempt` equals the binding; `vm.start` carries `attempt` |
| AT-BENCH-50 | Prepare a merge in attempt VM A1, restart bench (all VMs stopped), `commitPrepared(pm, digest, mandate, binding A2)` | Committed exactly the prepared operations; `vm.commit` with `prepared`; the frozen snapshot is not needed |
| AT-BENCH-51 | Repeat the same `commitPrepared` (lost reply); then `preparedStatus(pm)` | Same transaction and undo snapshot, no second apply, no second `vm.commit`; status `committed` |
| AT-BENCH-52 | `commitPrepared` with a mandate naming another workflow, without `constraints.workflow`, or with a stale binding A1 after A2 was claimed | `kl:denied`; `kl:denied`; `kl:not-found` (strata `preparedFor`); nothing merged |
| AT-BENCH-53 | Attempt VM share with a `Ready` prepared merge, 25 hours later (test clock) | Overlay transaction and prepared merge still present (REQ-BENCH-121) |

---

## 12. Implementation notes

**Language:** Rust 2024, async on tokio 1.x.

| Crate | Use |
|---|---|
| `tokio` 1 | async runtime |
| `capnp` 0.20 / `capnp-rpc` 0.20 | capwire (through `keylos-capwire`) |
| `smoltcp` 0.11 | `bench-net` stack |
| `vhost-user-backend` 0.15, `vhost` 0.11, `virtio-queue` 0.12, `vm-memory` 0.14 | `bench-net` vhost-user backend |
| `nickel-lang-core` 0.9 | `project.ncl` evaluation |
| `rusqlite` 0.31 | registry |
| `serde`, `serde_json` | records |
| `nix` 0.29, `rustix` 0.38 | syscalls |
| `fuse-backend-rs` 0.12 | `bench-fs` passthrough filesystem with the label hook |
| `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-labels` 1.0.0 | Contracts, capwire (including the vsock profile), fsmerge manifests, mandate verification |
| `landlock` 0.4 | backend self-restriction (defence in depth; warden already applied the baseline) |
| `tokio-vsock` 0.5 | vsock |

**Repository layout:**

```
bench/
  crates/benchd-host/      service
  crates/bench-net/        vhost-user-net backend
  crates/bench-fs/         vhost-user-fs backend (fuse-backend-rs) + gens assembler + label hook
  crates/bench-relay/      per-VM relay (broker calls as the VM, agent host relay)
  crates/bench-gpu/        crosvm gpu backend launcher
  crates/benchd/           guest PID 1 (static, musl)
  crates/bench-wl/         guest Wayland proxy
  crates/keylos-bench-proto/  bench-guest.capnp + bindings
  crates/keylos-project/   project.ncl schema + evaluator
  crates/cli-work/, crates/cli-bench/
  guest/                   guest kernel config fragment, image recipe (forge), root.erofs layout
  schema/bench-guest.capnp, schema/bench-admin.capnp
  nickel/project.ncl, nickel/config-bench.ncl
  tests/                   integration (KVM)
```

**Building:**
- The service generation and the guest image generation are built by `forge` from recipes in `pkgs`; this repo provides the recipe sources.
- The guest kernel config is a fragment applied to the keylos kernel source with `CONFIG_KVM=n`, `CONFIG_MODULES=n`, virtio drivers built in, EROFS, ext4 and FUSE.
- `benchd` is statically linked (musl) so the guest root is minimal.

**crosvm:**
- Pinned by generation; started with `--disable-sandbox` (warden confines it), `--vhost-user fs,net,gpu` and `--vsock cid=<n>`.
- Snapshots via the control socket (`crosvm snapshot take`, `crosvm suspend`, `crosvm resume`) and `crosvm run --restore`.
- bench MUST detect the crosvm snapshot capability at startup. If it is absent, snapshot operations fail `kl:unsupported` and every start is a cold boot (budgets in §8 do not apply).

---

## 13. Decisions and alternatives

| Decision | Alternatives considered | Reason |
|---|---|---|
| crosvm as the only VMM ([ADR-0010](../../handbook/11-decisions/adr-0010-crosvm-single-vmm.md)) | Firecracker (no GPU), cloud-hypervisor (weaker GPU story), libkrun (smaller device model, fewer snapshot features) | One audited VMM for both GUI tier 2 and headless tier 3; native-context GPU; vhost-user device split; snapshot/restore |
| Unsealed code only in workbenches ([ADR-0009](../../handbook/11-decisions/adr-0009-unsealed-code-in-workbenches.md)) | IMA appraisal, per-cgroup IPE exceptions | Keeps the host invariant simple: the host kernel never maps unsealed code executable |
| Userspace network termination with synthetic DNS | vsock-only proxying; tap + netns + TPROXY | Compatibility with unmodified tools; exact host names for policy; no guest packets in the host IP stack |
| Device backends as separate warden-spawned processes | crosvm's internal minijail sandbox | Only warden creates namespaces ([ADR-0025](../../handbook/11-decisions/adr-0025-namespaces-only-by-warden.md)); keeps one confinement implementation |
| Overlay shares committed through strata | Guest-side git or `rsync` back | One transaction engine with conflict detection, undo snapshots and receipts ([ADR-0027](../../handbook/11-decisions/adr-0027-effect-outbox-and-mandates.md)) |
| Memory snapshots `MAP_PRIVATE` | Full eager restore; userfaultfd lazy restore | Fast restore and cheap forks through the page cache, without granting `userfaultfd` |
| Agents get overlay-only shares ([ADR-0029](../../handbook/11-decisions/adr-0029-agents-propose-humans-sign.md)) | Direct writes with checkpoints | Agent output is a proposal until a human commits |
| Store generations shared read-only into guests ([ADR-0042](../../handbook/11-decisions/adr-0042-one-store-for-language-ecosystems.md)) | Guest downloads toolchains | Same verified bytes host and guest; instant toolchains; no duplicate downloads |
| Agent merges bound to a strata prepared merge (`BenchMerge`, [ADR-0027](../../handbook/11-decisions/adr-0027-effect-outbox-and-mandates.md), protocols E30) | Merge the live overlay at approval time; a bench-only manifest digest with strata merging again at commit | What the human approved is exactly what lands; late agent writes and post-approval automatic merges cannot ride along |
| Per-VM `bench-relay` acting as the VM principal | bench calling the broker or aide on the VM's behalf | Grants, prompts and agent-host connections carry the VM's own identity; bench holds no authority it could confuse between VMs |
| Warm pool as resident snapshots, not running VMs | Pre-booted idle VMs claimed by sessions | No VM process ever changes principal; no state can survive between users |

### 13.1 Dependencies and open points

bench uses only interfaces, facets and formats of keylos-protocols 1.0.0 (final). It relies on:
- `warden` wiring `gate#shim` to `bench-net` and `aide#host` / `broker#principal` to `bench-relay` as the VM principal, as declared in the bench generation's entrypoints (`protocols §19.2`), and spawning `bench-net-captive` without a private network namespace (§4.18).
- `gate` calling `BenchMerge.commitShare` only after it holds the approval mandate for the `fs.merge` intent, whose digest is the strata prepared-merge digest (protocols E30, `keylos.fsmerge/2`).
- `aide` returning `GrantDelegate.request` outcomes in the JSON shape of `protocols §7.5.10`.
- `aide` setting `VmSpec.attempt`/`ForkSpec.attempt` only for attempts `loom` claimed, `strata` verifying bindings in `bindWorkflow`/`preparedFor` and keeping prepared-merge completion records for the workflow horizon, and `gate` calling `commitPrepared` with the current binding (protocols E41, E42, E48).

- `warden` implementing `VmSpawn` as specified in `protocols §7.5.1`, including wiring `bench-relay` to `portal-*#default` and `vault#app` for the VM principal.
- `net` starting captive VMs on facet `bench#net` and admitting them per `NetCaptive.signIn`.
- `portal-files` and `atrium` staging `media.export` on `gate` and passing the delivered mandate.

All earlier open points (pod tap encoding, bench-relay holder registration, native tier-2 apps, `media.export` receipts, captive admission by bench) are resolved by protocols 1.0.0 (final) and specified above.

---

## Appendix A — Embedded contracts (verbatim)

Each block below is copied verbatim, by mechanical extraction, from `protocols/spec.md` of **keylos-protocols 1.0.0 (final)**. Only the section's own heading line is replaced by the `A.n` heading. Table excerpts keep the header rows and the rows relevant to this repository. If a copy differs from protocols, protocols wins.

### A.1 `protocols §2` — Platform baseline (excerpt: kernel and virtualization rows)

| Item | Requirement |
|---|---|
| Kernel | Linux ≥ 6.18 (LTS floor). The shipped kernel targets the current stable series (7.x). Features are detected at runtime; see §2.1. |
| Kernel lockdown | `lockdown=integrity` at minimum. Consequently **hibernation is unsupported** on every profile (lockdown refuses it). Suspend-to-RAM is supported. |
| Virtualization | KVM required for workbench and tier-2 VMs. Without KVM, those workloads refuse to run; they never silently downgrade. |
| IOMMU | Required on every profile except `degraded`. Kernel command line `iommu=force` plus `intel_iommu=on` or `amd_iommu=force_isolation`; Thunderbolt/USB4 security level `secure` or `user`. Without an active IOMMU, external PCIe/Thunderbolt devices are never authorized (§9.5). On the `cloud` profile, a virtio-only instance type without an emulated IOMMU is accepted and recorded as `"iommu": "none-virtual"` in the boot report (§20.1): such instances expose no external DMA-capable bus, and VFIO passthrough and external device authorization are unavailable on them. |

### A.2 `protocols §3.4` — Principal identifiers

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

### A.3 `protocols §6.1` — Generation kinds

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

### A.4 `protocols §7.1` — Model

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

### A.5 `protocols §7.2` — Routes and facets

`warden` wires services according to **routes** declared in service and app manifests plus policy.

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

- A **facet** is a server-defined restriction name. The registry of every facet, its holders and the methods it allows is §19.2. Servers MUST refuse methods their facet doesn't allow with `kl:denied`.
- Route references are written `service#facet` (for example `vault#app`).
- The server learns the facet of each connection from `ServiceHost.accept` (§7.5.1) or `Supervisor.connectionInfo`.
- Service sockets live under `/run/keylos/svc/<service>/` with mode `0700`, owned by `warden`'s UID. No other principal can `connect()` to them. Connections are created by `warden` (`socketpair` + hand-off through `ServiceHost.accept`).
- Dynamic routes (a service capability granted at runtime) are materialised by `broker` through `ServiceConnect.connectService` (§7.5.1).

### A.6 `protocols §7.2.1` — capwire-vsock profile (host ↔ guest)

Between a VM guest and the host, capwire runs over **`AF_VSOCK` `SOCK_SEQPACKET`** with these differences:
1. **No fd passing.** `Fd` fields MUST NOT appear in messages on this profile; receivers MUST reject them.
2. Bulk data uses `ByteStream`/`ByteSource` capabilities, or dedicated vsock stream connections on the bulk port range (§19.5) announced in messages.
3. **Authentication.** The host identifies the VM by its vsock CID, which `bench` assigns uniquely per running VM (CID ≥ 3). The guest is never trusted for identity claims; every host-side endpoint is bound to exactly one VM principal.
4. Ports are registered in §19.5. The guest initiates every connection to host CID 2.

### A.7 `protocols §7.3.1` — `common.capnp`

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

### A.8 `protocols §7.3.2` — `warden.capnp`

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

### A.9 `protocols §7.3.3` — `broker.capnp`

```capnp
@0xc7a1e5d3b2f40003;
using C = import "common.capnp";

struct NetTarget {
  host    @0 :Text;            # DNS name or IP literal; "listen:<addr>" requests a listening socket (§7.3.7)
  port    @1 :UInt16;
  proto   @2 :Proto;
  methods @3 :List(Text);      # HTTP methods, empty = protocol-level grant only
  enum Proto { tcp @0; udp @1; https @2; }
}

struct Budget { unit @0 :Text; amount @1 :Int64; }   # unit: "usd-micro", "tokens", "calls"

struct ResourceRef {
  union {
    path      @0 :Text;          # resolved by broker with openat2(RESOLVE_BENEATH) from a held root
    dirFd     @1 :C.Fd;          # caller already holds it; request attenuation/annotation
    net       @2 :NetTarget;
    device    @3 :Text;          # device id, protocols §3.5
    secret    @4 :Text;          # vault item name (caller-scoped)
    budget    @5 :Budget;
    spawn     @6 :C.Ref;         # right to spawn a generation
    service   @7 :Text;          # "name#facet"
    effect    @8 :Text;          # effect kind, e.g. "email.send"
    delegate  @9 :Void;          # right to create sub-principals
    principal @10 :DebugTarget;  # debug target (Right.debug), §9.3
    screen    @11 :Text;         # "window:<atrium window id>": one still snapshot of a real-session window (Right.read), §14.5
    model     @12 :Text;         # "<provider>/<model>@<version>": re-approval of an agent session's model after drift (Right.use), §14.5
  }
}

struct DebugTarget {
  target  @0 :Text;              # "session:s-…" (a running session and its descendants) or "gen:fsv256:…" (any instance of a generation of the requesting human)
  scope   @1 :Scope;
  enum Scope { process @0; kernel @1; }   #! kernel: bpftrace-class tracing, presence-only, ≤ 900 s
}

enum Right { read @0; write @1; create @2; delete @3; exec @4; connect @5; bind @6; use @7; spend @8; spawn @9; stage @10; commit @11; delegate @12; debug @13; }

struct GrantRequest {
  resource     @0 :ResourceRef;
  rights       @1 :List(Right);
  reason       @2 :Text;         # shown to the human
  durationSecs @3 :UInt32;       # 0 = policy default
  persist      @4 :Bool;         # request a persistent grant (survives session and reboot; needs presence)
  onBehalfOf   @5 :C.PrincipalId; # informational only (vault, depot, strata, atrium via requestFor): the principal the service acts for;
                                  #! shown on the prompt and recorded in receipts; never used for authorization
}

struct GrantOutcome {
  union {
    granted @0 :C.Token;
    pending @1 :Approval;
    denied  @2 :Text;
  }
}

interface Approval {
  id      @0 () -> (id :Text);
  wait    @1 () -> (outcome :GrantOutcome);
  cancel  @2 () -> ();
  mandate @3 () -> (mandate :Data);   #! DSSE keylos.mandate/1 after approval; kl:not-found before or if denied
}

struct Handle {
  union {
    fd      @0 :C.Fd;            # file, dirfd (O_PATH), device, memfd
    socket  @1 :C.Fd;            # connected socket (usually to gate) or capwire socket to a service
    cap     @2 :Capability;      # service capability
  }
}

interface Broker {
  request     @0 (req :GrantRequest) -> (outcome :GrantOutcome);
  materialize @1 (token :C.Token, resource :ResourceRef, rights :List(Right)) -> (handle :Handle);
  attenuate   @2 (token :C.Token, checks :List(Text)) -> (token :C.Token);  #! Datalog checks, protocols §8.3
  delegate    @3 (tokens :List(C.Token), child :C.SessionId, checks :List(Text)) -> (tokens :List(C.Token));
  revoke      @4 (rootId :Data) -> ();
  inspect     @5 (token :C.Token) -> (facts :List(Text), expires :C.Timestamp, rootId :Data);
  label       @6 () -> (label :C.Label);
  raiseLabel  @7 (label :C.Label, reason :Text) -> (label :C.Label);  #! raises the CALLER's session label only; labels only go up
  powerbox    @8 (req :PowerboxRequest) -> (grants :List(PowerboxGrant));
  myGrants    @9 () -> (tokens :List(C.Token));
  debug       @10 (token :C.Token, debugger :C.Ref, entrypoint :Text, argv :List(Text), pty :C.Fd) -> (process :Capability);
      #! materialises a Right.debug grant through warden DebugAttach (§7.5.1); returns a warden.Process
}

struct PowerboxRequest {
  kind     @0 :Kind;
  title    @1 :Text;
  mimeTypes @2 :List(Text);
  multiple @3 :Bool;
  suggestedName @4 :Text;
  enum Kind { openFile @0; openDirectory @1; saveFile @2; }
}

struct PowerboxGrant {
  fd    @0 :C.Fd;        # opened file, or O_PATH dirfd usable in the holder's view (attached via GrantMounts, §7.5.1)
  token @1 :C.Token;     # token describing the grant (for persistence / delegation)
  displayName @2 :Text;
  viewPath @3 :Text;     # path of the grant inside the holder's view (/grants/<name>), for path-expecting code
}
```

**Directory grants and Landlock.** A Landlock domain cannot be widened after `restrict_self`. A directory granted at runtime is therefore made reachable by `warden` attaching a bind mount at `/grants/<name>` inside the holder's mount namespace (`GrantMounts.attachGrant`, §7.5.1), whose subtree is covered by the Landlock rule the view was built with (`/grants` is allowed at spawn with the access rights of the highest possible grant; actual access is bounded by mount flags and the attached tree). `materialize` of a path or dirFd grant returns an fd opened **through that mount**.

**Directory grant ceilings.** Every directory grant has an **exposure label** (its ceiling, §14.1). The broker raises the holder's session label to the ceiling **before** the mount is attached, and passes the ceiling to `attachGrant`; `warden` then refuses, for the grant's lifetime, every open of an object through that mount (and every read through an fd opened through it) whose label exceeds the ceiling or is malformed (§9.3). Grant trees are non-recursive bind mounts: mounts nested below the granted directory are not reachable through the grant.

**Single-file grants.** A file picked for a path-expecting client is never exposed by attaching its parent directory. It is exposed as a **single-file view** `/grants/<name>/<basename>`: a directory served by `portal-files` that contains only the selected file and the holder's own temporary files. Writes follow the granted rights (a read-only grant refuses every write); a safe-save `rename(<temporary> → <basename>)` is carried out by `portal-files` as an atomic replace of the selected file in its real parent, whose dirfd `portal-files` holds and never exposes; every other name is refused. Access to the parent or any sibling needs an explicit `openDirectory` consent. Remembered grants, re-materialization, revocation and drag-and-drop keep the same single-file scope.

### A.10 `protocols §7.3.7` — `gate.capnp`

```capnp
@0xc7a1e5d3b2f40007;
using C = import "common.capnp";
using B = import "broker.capnp";

enum EffectClass { reversible @0; compensable @1; irreversible @2; }

struct EffectArg { name @0 :Text; value @1 :Text; source @2 :Text; label @3 :C.Label; }

struct EffectIntent {
  kind        @0 :Text;            # registered effect kind, protocols §14.2
  class       @1 :EffectClass;
  target      @2 :Text;            # e.g. "smtp:mail.example.com", "https://api.github.com/repos/o/r/pulls"
  args        @3 :List(EffectArg);
  idempotencyKey @4 :Text;
  compensator @5 :Text;            # registered compensator kind, empty if none
  payload     @6 :C.Fd;            # full request body / message
}

struct IntentStatus {
  id     @0 :Text;
  state  @1 :State;
  result @2 :Text;
  receipt @3 :Text;                # rcpt ref
  enum State { staged @0; approved @1; committed @2; failed @3; canceled @4; compensated @5; }
}

interface Intent {
  status   @0 () -> (status :IntentStatus);
  dryRun   @1 () -> (rendered :List(Text));
  commit   @2 () -> (status :IntentStatus);          # may throw kl:needs-approval
  cancel   @3 () -> ();
  compensate @4 () -> (status :IntentStatus);
}

interface Gate {
  connect   @0 (target :B.NetTarget, token :C.Token) -> (socket :C.Fd);   # proxied, policy-checked stream; target.host "listen:<addr>" returns a listening socket
  stage     @1 (intent :EffectIntent) -> (intent :Intent);
  intents   @2 (session :C.SessionId) -> (list :List(IntentStatus));
      #! facet client: the named session MUST be the caller's own session or a descendant; returns intents of that session
      #! and all its descendant sessions, recursively
  meter     @3 (rootId :Data) -> (spent :List(B.Budget), remaining :List(B.Budget));
  charge    @4 (rootId :Data, amount :B.Budget, reason :Text) -> ();      # facet meter only
  intent    @5 (id :Text) -> (intent :Intent);
      #! facet client: only intents staged by the caller's session or its descendants (kish `effects` commit/cancel)
}
```

**Terminated HTTP mode.** For `https` grants that need method filtering or credential injection, a native client does not get an end-to-end TLS stream: `connect` returns a socket on which the client speaks **plain HTTP/1.1** to `gate`, which terminates the request, applies method checks and credential injection, and performs TLS to the real host itself. Clients detect this from the token's `net` fact (`$method` ≠ `"*"`). Legacy and VM clients use the TLS-interception path instead (§9.4). SDKs MUST support the terminated mode.

**Acting for a subject.** On facet `aide`, `stage` acts for the agent session whose token is carried in the intent arg `x-subject-token` (base64 Biscuit); `gate` stages for that token's `principal` after verifying `right("effect", kind, "stage")`. On facet `broker`, `connect` acts for the token's `principal`. On every other facet the subject is the caller.

### A.11 `protocols §7.3.8` — `depot.capnp`

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

### A.12 `protocols §7.3.10` — `strata.capnp`

```capnp
@0xc7a1e5d3b2f40010;
using C = import "common.capnp";

enum NetworkPolicy { deny @0; gate @1; inherit @2; }
  #! deny: processes in the transaction get no network; gate: egress only via gate with the caller's tokens; inherit: the spawner's own policy

struct Change { path @0 :Text; kind @1 :Kind; enum Kind { added @0; modified @1; deleted @2; renamed @3; meta @4; } from @2 :Text; }

struct Conflict { path @0 :Text; reason @1 :Text; }

interface Transaction {
  id      @0 () -> (id :Text);
  view    @1 () -> (dirs :List(C.Fd));         # O_PATH dirfds of the overlay views (same order as begin)
  changes @2 () -> (changes :List(Change));
  diff    @3 (path :Text) -> (diff :C.Fd);
  conflicts @4 () -> (conflicts :List(Conflict));
  commit  @5 () -> (snapshot :Text);           # returns pre-commit snapshot id (undo point)
  abort   @6 () -> ();
}

struct Provenance {
  principal   @0 :C.PrincipalId;
  generation  @1 :C.Ref;
  transaction @2 :Text;
  created     @3 :C.Timestamp;
  label       @4 :C.Label;
}

struct SnapshotInfo { id @0 :Text; subvolume @1 :Text; created @2 :C.Timestamp; reason @3 :Text; pinned @4 :Bool; }

interface Strata {
  begin     @0 (dirs :List(C.Fd), networkPolicy :NetworkPolicy) -> (txn :Transaction);   #! holding the dirfds is the authority
  snapshot  @1 (subvolume :Text, reason :Text) -> (info :SnapshotInfo);
  snapshots @2 (subvolume :Text) -> (list :List(SnapshotInfo));
  restore   @3 (snapshot :Text, path :Text, target :C.Fd) -> ();
  undo      @4 (transaction :Text) -> ();
  why       @5 (file :C.Fd) -> (provenance :Provenance);
  forget    @6 (unit :Text) -> ();             # crypto-shred a data unit
  createUnit @7 (path :C.Fd, unit :Text, policy :Text) -> ();
}
```

**Transaction storage backends.** `begin` dispatches each target dirfd to a registered backend. A plain btrfs directory uses the snapshot and overlay path. A plaintext view of a sealed unit served over FUSE (`keylos.unitfs/1`) is resolved through `strata`'s own mount records to (unit, relative subtree); `strata` clones the unit's ciphertext backing subvolume (a read-only base and a writable working clone) and serves a transaction-specific plaintext view of that subtree only. Changes and prepared merges are computed on the logical plaintext views; commit applies the logical operations to the live backing through the unit format, after quiescing the unit and fencing its writers. No plaintext upper layer, undo copy or journal content of a sealed unit is ever stored outside its encrypted backing; undo uses a ciphertext pre-commit snapshot, and `forget` of the unit aborts its transactions and leaves every transaction artifact undecryptable. While the unit is locked its transaction views are unavailable and commits fail `kl:unavailable`. Mixed backends in one transaction, nested units and cross-unit transactions fail `kl:unsupported`.

### A.13 `protocols §7.3.13` — `bench.capnp`

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

### A.14 `protocols §7.3.14` — `aide.capnp`

```capnp
@0xc7a1e5d3b2f40014;
using C = import "common.capnp";

struct AgentEvent {
  time    @0 :C.Timestamp;
  session @1 :C.SessionId;
  union {
    message   @2 :Text;            # agent → human text
    toolCall  @3 :Text;            # JSON {tool, args}
    toolResult @4 :Text;
    approval  @5 :Text;            # approval id pending
    effect    @6 :Text;            # intent id
    label     @7 :C.Label;
    budget    @8 :Text;
    finished  @9 :Text;
    rich      @10 :Text;           # JCS JSON {"type": "state"|"question"|"breaker"|"mcpPinMismatch"|"discrepancy"|"grant"|"modelChange"|"desktop", …}
  }
}

interface AgentSession {
  id       @0 () -> (id :C.SessionId);
  send     @1 (text :Text) -> ();                      # human → agent
  events   @2 (watcher :C.Watcher(AgentEvent)) -> (cancel :C.Cancelable);
  changes  @3 () -> (summary :Text);
  review   @4 () -> (prompt :Text);                    # stages fs.merge intents; opens T3 review on trusted path
  stop     @5 () -> ();
  fork     @6 () -> (session :AgentSession);
  takeOver @7 (interactive :Bool) -> ();             # human: switch the agent-desktop mirror (relayed to Vm.takeOver)
  attempt  @8 () -> (binding :C.AttemptBinding);     # the workflow attempt this session executes (§20.25); epoch 0 if none
}

struct SessionSpec {
  template  @0 :C.Ref;               # agent-template generation
  task      @1 :Text;
  grants    @2 :List(C.Token);       # attenuated from the human's authority
  project   @3 :C.Fd;                # optional project dirfd
  budget    @4 :List(Text);          # e.g. "usd-micro:5000000"
  deadlineSecs @5 :UInt32;
}

interface Aide {
  start    @0 (spec :SessionSpec) -> (session :AgentSession);
  sessions @1 () -> (list :List(C.SessionId));
  attach   @2 (id :C.SessionId) -> (session :AgentSession);
}

interface AgentHost {                 # served by aide to the harness inside the workbench (vsock port 7002)
  tools     @0 () -> (json :Text);     # pinned tool definitions
  callTool  @1 (name :Text, argsJson :Text, provenanceJson :Text) -> (resultJson :Text, label :C.Label);
  model     @2 (requestJson :Text) -> (responseJson :Text);   # model API via gate (metered)
  emit      @3 (event :AgentEvent) -> ();
  requestGrant @4 (reasonJson :Text) -> (outcomeJson :Text);
}
```

### A.15 `protocols §7.5.1` — `warden-sys.capnp`

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

### A.16 `protocols §7.5.2` — `broker-sys.capnp`

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

### A.17 `protocols §7.5.7` — `strata-sys.capnp`

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

### A.18 `protocols §7.5.10` — `bench-sys.capnp`

```capnp
@0xc7a1e5d3b2f40029;
using C = import "common.capnp";

interface BenchMerge {             # facet merge (gate fs.merge executor, aide for manifest/render)
  manifest    @0 (session :C.SessionId, share :Text) -> (manifestJson :Text, digest :C.Digest, snapshot :Text, prepared :Text);
      #! freezes a snapshot of the share's overlay and prepares the merge through strata (TransactionExt.prepare);
      #! manifestJson is that prepared merge's keylos.fsmerge/2 (§20.12), prepared its pm-… id
  render      @1 (session :C.SessionId, share :Text, snapshot :Text) -> (diff :C.Fd);   # unified diff
  commitShare @2 (session :C.SessionId, share :Text, manifestDigest :C.Digest, mandate :Data) -> (transaction :Text, undoSnapshot :Text);
      #! commits the prepared merge whose manifest digest is manifestDigest (PreparedMerge.commit); later agent writes are never included
  commitPrepared @3 (prepared :Text, manifestDigest :C.Digest, mandate :Data, binding :C.AttemptBinding) -> (transaction :Text, undoSnapshot :Text);
      #! gate only: commits a retained prepared merge by its pm-… id, independent of the session that prepared it (a fresh attempt
      #! of the owning workflow, §20.25; strata StrataTxn.preparedFor); idempotent: a committed prepared merge returns its
      #! stored completion record (PreparedMerge.status) instead of committing again
  preparedStatus @4 (prepared :Text) -> (state :Text, transaction :Text, undoSnapshot :Text);
      #! gate, aide: the prepared merge's durable completion record (PreparedMerge.status), for reconciliation by effect id
}

interface GrantDelegate {          # served by aide (facet grant-delegate), called by bench for agent VMs
  request @0 (vmSession :C.SessionId, kind :Text, detailJson :Text, reason :Text) -> (outcomeJson :Text);
      #! outcomeJson (JCS): {"outcome": "granted" | "denied" | "pending", "token": "<base64 Biscuit>" | null,
      #!                     "approval": "a-…" | null, "reason": "…"}
}

struct MediaEntry { name @0 :Text; kind @1 :Text; size @2 :UInt64; modified @3 :C.Timestamp; }   # kind: file | dir | symlink

interface MediaBrowser {           # returned by Bench.media; held by portal-files and atrium
  list   @0 (path :Text) -> (entries :List(MediaEntry));
  open   @1 (path :Text) -> (source :C.ByteSource, size :UInt64);    #! bytes are labelled public/untrusted
  export @2 (path :Text, data :C.Fd, mandate :Data) -> ();
      #! copies data into the media VM, which writes it to the device; requires a media.export mandate bound to the
      #! SHA-256 of data (caller-executed effect, §14.2); bench writes the receipt media.export
  eject  @3 () -> ();                 # unmount in the guest, release the device, stop the VM
  exportSeekable @4 (path :Text, sizeLimit :UInt64) -> (fd :C.Fd, done :ExportCompletion);
      #! a writable, seekable memfd for applications that must seek while saving; nothing reaches the device until
      #! done.finish with a media.export mandate bound to the SHA-256 of the final contents
}

interface ExportCompletion {
  finish @0 (mandate :Data) -> ();   # seals the memfd, verifies the mandate against its digest, writes it to the device
  abort  @1 () -> ();
}

interface GuestPortals {           # served by bench-relay to a tier-2 guest over capwire-vsock (port 7004)
  notify    @0 (title :Text, body :Text, actions :List(Text)) -> (id :UInt32);
  openUri   @1 (uri :Text) -> ();
  print     @2 (document :C.ByteSource, mime :Text, optionsJson :Text) -> (jobId :Text);
  capture   @3 () -> (stream :C.ByteSource);                  # this VM's own display only, never the host session
  secret    @4 (name :Text, purpose :Text) -> (value :Data);  #! vault facet app scoped to the VM principal; the value
                                                             #! crosses into the guest, so policy MUST allow it per item
  powerbox  @5 (kind :Text, title :Text, mimeTypes :List(Text)) -> (shareName :Text);
      #! host-side picker; the chosen file or directory is hot-plugged as a share (Vm.attachShare)
}
```

### A.19 `protocols §7.5.11` — `net-sys.capnp`

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

### A.20 `protocols §7.5.12` — `gate-sys.capnp`

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

### A.21 `protocols §7.5.13` — `aide-sys.capnp`

```capnp
@0xc7a1e5d3b2f4002c;
using C = import "common.capnp";

struct AgentBootstrap {
  session      @0 :C.SessionId;
  principal    @1 :C.PrincipalId;
  templateJson @2 :Text;
  gitName      @3 :Text;
  gitEmail     @4 :Text;
  trailers     @5 :List(Text);
  env          @6 :List(C.KeyValue);   # proxy settings, KEYLOS_* (no secrets)
  localMcp     @7 :List(Text);         # JSON per local MCP server
}

interface AgentHostExt {           # obtained via Extensible.ext on the AgentHost connection (vsock 7002)
  bootstrap   @0 () -> (bootstrap :AgentBootstrap);
  modelStream @1 (requestJson :Text) -> (stream :C.ByteSource);
  heartbeat   @2 () -> ();
  desktop     @3 () -> (desktop :AgentDesktop);   #! only when the template sets vm.desktop: true; else kl:unsupported
}

interface VmExec {                 # used by WASI harnesses (camel/1) to run VM tools
  run @0 (argv :List(Text), stdin :Data, timeoutSecs :UInt32) -> (exit :Int32, stdout :Data, stderr :Data);
}

interface AgentDesktop {           # computer-use agents (§14.5); served by bench (Vm.desktop) to aide and by aide to the harness
  screenshot @0 () -> (png :Data, width :UInt32, height :UInt32);
  input      @1 (eventsJson :Text) -> ();
      # JCS list of {"type": "move"|"click"|"down"|"up"|"scroll"|"key"|"text", …}; delivered to the nested desktop only
  a11yTree   @2 () -> (json :Text);                         # A11yUpdate list of the nested desktop, as JSON
  launch     @3 (appName :Text) -> ();                      # start an app inside the agent desktop VM
  status     @4 () -> (watchedBy :List(Text), takenOver :Bool);   # takenOver: the human controls input; agent input is refused
}
```

### A.22 `protocols §7.5.16` — `display.capnp`

```capnp
@0xc7a1e5d3b2f4002f;
using C = import "common.capnp";
using W = import "warden.capnp";

enum ClientClass { trusted @0; t1 @1; t2 @2; legacyX @3; assistive @4; ime @5; }

interface Display {                # facets warden, bench, compat (xwaylandWm), settings (outputs)
  clientSocket @0 (principal :C.PrincipalId, tier :W.Tier, generation :C.Ref, process :W.Process)
                -> (socketDir :C.Fd, name :Text, cls :ClientClass);
      #! socketDir: O_PATH dirfd containing the listening socket `name`; the binding lives until process.wait resolves
  xwaylandWm   @1 (principal :C.PrincipalId, wm :C.Fd) -> ();
      #! facet compat only; wm = socketpair end connected to Xwayland's -wm fd
  outputs      @2 () -> (json :Text);
  windowOwner  @3 (window :Text) -> (principal :C.PrincipalId, human :Text, app :Text);
      #! facet broker only: owner of "window:<id>" (ResourceRef.screen); app = the generation name; kl:not-found if unknown
}
```

### A.23 `protocols §8.2` — Authority block vocabulary

The broker MUST write the authority block using only these facts. Other components MUST understand all of them.

| Fact | Meaning |
|---|---|
| `principal($p)` | Holder principal text |
| `session($s)` | Holder session |
| `root_id($r)` | Root ID (bytes) |
| `right($kind, $resource, $op)` | Resource text by kind: `path` — `<rel>`, a normalised relative path (no leading `/`, no `.`/`..`, no trailing `/`, `""` = the whole root) naming a subtree matched on component boundaries, under the root named by the token's `path_root` fact; `net` — the host (or `listen:<addr>`), with the `net(...)` facts for that host carrying port, proto and method (a net right without a `net` fact for its host is invalid; a grant with only specific methods does not authorise a protocol-level connect, `"*"` does); `delegate` — `"*"`. `$kind` ∈ {"path", "net", "device", "secret", "budget", "spawn", "service", "effect", "delegate", "principal", "screen", "model"}; `$op` is a `Right` enumerant name. Kind `principal` (resource `session:s-…` or `gen:fsv256:…`) carries only `debug`; kind `screen` (resource `window:<id>`) only `read`, single use; kind `model` (resource `<provider>/<model>@<version>`) only `use` |
| `debug_scope($scope)` | `"process"` or `"kernel"` for a `debug` right; absent means `process` |
| `path_root($fdkey)` | Declares a broker-held root dirfd `$fdkey`; a path right applies under every `path_root` of the authority block. The broker mints at most one `path_root` per token |
| `net($host, $port, $proto, $method)` | `$method` is "*" for no HTTP restriction; `$host` "listen:<addr>" for listening grants |
| `budget($unit, $amount)` | Ceiling per charge in the authorizer (`amount ≤ ceiling`); cumulative spending is tracked by `gate` keyed by root_id |
| `expires($time)` | |
| `tier_floor($n)` | Minimum confinement tier for any process using this token |
| `max_depth($n)` | Maximum **absolute** delegation depth (the root holder is depth 0) |
| `max_fanout($n)` | Maximum number of child sessions |
| `label_ceiling($conf)` | Highest confidentiality the holder may read under this token: bounds both the session label and, when supplied, the object label |
| `persist($grantId)` | Token re-minted from persistent grant `$grantId` |
| `captive($bool)` | Captive-portal token: valid only for the captive-browser VM while `net` reports a captive network (minted by `BrokerSystem.mintCaptive`, ≤ 10 min, `tier_floor` ≥ 2) |
| `model($provider, $model, $version)` | A model identity approved for an agent session (§14.5); the authority block may list several (the approved set). An observed model must match a `model` fact of every block that has one; `gate` compares observed model versions against them |
| `budget_parent($rootId)` | The token's budget is a hard sub-meter of `$rootId` (`GateMeterAdmin.carve`) |
| `workflow($wf, $epoch)` | The token was minted for an attempt of workflow `$wf` (`wf-…`) at ownership epoch `$epoch` (§20.25). Verifiers that act for workflows (`gate` `DurableEffects`) MUST compare `$epoch` with the binding they are given and with the current claim; the fact never authorizes anything by itself |
| `budget_account($ba)` | Spending under this token is charged to the durable workflow budget account `$ba` (`ba-…`, `WorkflowBudget`, §7.5.25) in addition to the root meter, so a fresh attempt's new root never resets spent amounts |

**Fact multiplicity.** The authority block has exactly one `principal`, `session` and `root_id`, and at most one each of `expires`, `tier_floor`, `max_depth`, `max_fanout`, `label_ceiling`, `persist`, `captive`, `debug_scope` (per right), `budget_parent`, `workflow` and `budget_account`; `model` may occur several times. `persist`, `workflow` and `budget_account` are trusted only in the authority block.

### A.24 `protocols §8.4` — Revocation

- Revoking a root ID invalidates every token derived from it, including tokens whose `budget_parent` names it. Revocations are in-memory and persisted until the next reboot, when keys rotate anyway.
- **Workflow revocation is durable.** Cancelling or revoking a workflow (`BrokerWorkflow.cancel`, §20.25) writes a persistent cancellation record in the broker, revokes every root carrying that workflow's `workflow` fact, and makes every later claim and attempt registration of the workflow fail, across restarts and reboots; it is not undone by the per-boot key rotation.
- The broker MUST check revocation on every `materialize`, and `gate` on every `connect`, `stage` and `charge`.
- **Already-materialized fds cannot be pulled back from a process.** Revoking therefore also terminates or freezes holders through `PrincipalControl.terminate` (§7.5.1), according to the grant record's `onRevoke`: `kill` (default for agents) or `freeze` (default for apps; the user decides). Attached grant mounts are detached (`GrantMounts.detachGrant`).

### A.25 `protocols §9.2` — Tiers

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

### A.26 `protocols §10.5` — Environment conventions

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

### A.27 `protocols §14.1` — Labels

| Dimension | Values (lowest → highest) |
|---|---|
| Confidentiality | `public` (0) < `internal` (1) < `private` (2) < `secret` (3) |
| Integrity | `trusted` (0) < `user` (1) < `untrusted` (2). Higher means *less* trustworthy |

- **Objects:**
  - Files carry `security.bpf.keylos.label`. Files without one inherit the default for their location: home data `private/user`; downloads and web content `public/untrusted`; store objects `public/trusted`.
  - Sockets get a label per connection from `gate`: responses from hosts are `untrusted` unless the policy marks the host `user`.
- **Sessions:** each principal session has a label. On every broker-mediated read, `session.conf = max(session.conf, object.conf)` and `session.integ = max(session.integ, object.integ)`. Labels never decrease within a session.
- **Label authority:** services that hand data from one principal to another (gate, bench, portals, atrium, strata, aide, journal, warden) raise the receiver's label with `LabelAuthority.raiseFor` (§7.5.2) **before** handing the data over. `warden` reads live labels with `labelOf` for `ConnectionInfo.label`.
- **Removable media and discovery:** bytes from `MediaBrowser` and results from `Discovery.browse` are `public/untrusted`.
- **Rule of Two** (enforced by `broker` and `gate`): define three properties of a session:
  - **U** = `integ == untrusted`
  - **P** = `conf ≥ private`
  - **X** = holds or requests a capability with `Right.commit`, an `effect` resource, or egress to a host not marked `sink-safe`

  A session MUST NOT hold all three. Requesting the third turns into a **declassification** approval at tier T3, unless a policy-registered **flow proof** (§20.11) is accepted. A flow proof is accepted only from an `agent-template` whose manifest `agent.flowProof` is `"camel/1"` and whose harness runtime is in the policy's trusted list.
- **Directory grants** (ceilings). A directory exposed to a session through a grant has an **exposure label** *c*, and the label assumptions hold only if *c* bounds everything readable through the grant for its whole lifetime:
  - The receiver's session label is raised to *c* (`raiseFor`) **before** the directory is exposed, and the resulting policy decision (Rule of Two) is enforced at that point.
  - *c* is enforced by `warden` (§7.3.3, §9.3): objects labelled above *c*, or with a malformed label, are not readable through the grant, whenever they appeared. Unlabelled objects count at their location default.
  - The broker may choose *c* as the join of a **complete** assessment of the tree. A bounded or truncated walk never justifies anything lower than the location default; entries above *c* then stay unreadable through the grant and are reported as hidden.
  - Without enforcement (null ceiling) the exposure label is the lattice maximum `secret/untrusted`.
  - Writes, relabels and renames into the tree, retained handles and concurrent changes are covered because enforcement happens at every open and read through the grant, not at grant time. A retained fd loses read access as soon as its object's label rises above *c*.
  - Agent input SHOULD be an **immutable assessed view** (a transaction base snapshot or a bench share snapshot): its complete assessment is final, so its exposure label can be lower without losing workflows to the `secret` deny of agent policy.

### A.28 `protocols §19.2` — Facets (excerpt: rows naming bench or the vsock 7002 forward)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| warden | `bench` | bench | `VmSpawn` (VM principals; `spawnVmm` for per-VM `crosvm` device processes, `bench-net` wired to `gate#shim`, `bench-relay` wired to `aide#host`, `broker#principal`, `vault#app` and `portal-*#default`); `GrantMounts.idmappedDir` |
| broker | `label-authority` | gate, bench, portal-*, atrium, strata, aide, journal, warden | `LabelAuthority` |
| broker | `workflow` | loom, gate, aide, strata, bench | `BrokerWorkflow` (§7.5.25): `enroll`, `claim`, `decide`, `rebind`, `resume`, `cancel`, `cancelDecision`, `record`, `raise`: loom; `authorizeEffect`, `verify`, `record`, `cancelDecision`: gate; `offer`, `verify`, `decide`, `rebind`: aide (its agent attempts); `verify`, `record`: strata, bench |
| vault | `app` | apps (per `needs.secrets`), `shell`, legacy, bench-relay (for its VM principal, §7.5.10 `GuestPortals.secret`) | `open`, `store`, `delete`, `list`, `sign`, `sshAgent` (own items) |
| hearth | `system` | warden, devd, config, broker, gate, vouch, strata, bench, depot, ledger, loom | `HearthSystem` (gate, vouch, strata, bench, depot, ledger: `owners` only; loom: `owners`, `userState`, `watchUsers`) |
| gate | `shim` | per-principal endpoints created by warden (tier L) and bench (bench-net per VM) | `ShimEndpoint` |
| aide | `host` | one per agent VM (vsock 7002 forward by bench-relay) | `AgentHost`, `AgentHostExt` (incl. `desktop`), `VmExec` |
| aide | `grant-delegate` | bench | `GrantDelegate` |
| depot | `mounter` | warden, bench, compat | `mount` (container generations only while rooted by `cri:pod:…`), `get`, `root`, `unroot`, `revocationStatus` |
| strata | `bench` | bench | `begin`; `StrataTxn` (including `preparedFor`); `TransactionExt.bindWorkflow` |
| devd | `bench` | bench | `MediaAttach` |
| bench | `user` | kish, `work`, atrium, portal-files, forge | `project`, `start` (purposes workbench; build (forge only, `unsignedImageOk`); app (kish, atrium launcher: non-reproducible native apps at tier 2)), `snapshots`, `media` (atrium, portal-files), `reattach` (own VMs) |
| bench | `net` | net | `start` (purpose captive only), `Vm.info`, `Vm.stop` |
| bench | `aide` | aide | all (including `fork` with `ForkSpec`, `reattach`); VMs get actor kind `agent` |
| bench | `compat` | compat | `start` with `display=true` for tier-2 legacy apps |
| bench | `merge` | gate, aide | `BenchMerge` (`commitShare`, `commitPrepared`: gate only; `preparedStatus`: gate, aide) |
| bench | `cri` | cri | `start` (purpose pod), `reattach`, `Vm` (all, including `attachShare`/`detachShare`, `attachBlock`/`detachBlock`, `info`) |
| bench | `admin` | owner `shell`, config | all, bench-local admin |
| atrium | `display` | warden, bench, compat | `Display` (`xwaylandWm`: compat only) |
| portal-* | `default` | apps declaring the portal in `needs.services`; bench-relay (for its tier-2 VM principal, `GuestPortals`) | the portal's interface (§7.3.15, §7.5.20) |

### A.29 `protocols §19.3` — Receipt events (excerpt: bench row)

| Event | Writer |
|---|---|
| `vm.start`, `vm.stop`, `vm.snapshot`, `vm.fork`, `vm.commit`, `vm.discard`, `media.attach`, `media.eject`, `media.export` | bench |

### A.30 `protocols §19.5` — vsock ports (host CID 2)

| Port | Direction | Service | Profile |
|---|---|---|---|
| 1024 | guest → host | `bench` (benchd control: `HostControl` / `Guest`) | capwire-vsock |
| 1025–1535 | either | `bench` bulk streams announced in control messages | raw byte streams |
| 7002 | guest → host | `aide` `AgentHost` (forwarded by `bench-relay` for agent VMs only) | capwire-vsock |
| 7004 | guest → host | `bench-relay` `GuestPortals` (tier-2 app VMs, agent desktops; never workbenches) | capwire-vsock |

All other guest network traffic leaves through the VM's single virtio-net device, terminated on the host by `bench-net`, which maps each flow to a `ShimEndpoint.connect` call on `gate` (§7.5.12).

### A.31 `protocols §20.12` — Merge manifest (`keylos.fsmerge/2`)

```json
{"schema":"keylos.fsmerge/2","prepared":"pm-…","session":"s-…","share":"project",
 "targets":["/home/alice/src/proj"],"base":"snap-…","source":"snap-…",
 "changes":[{"target":0,"path":"src/main.rs","kind":"modified","expectedLive":"sha256:…","afterDigest":"sha256:…","mode":"0644","size":1834},
            {"target":0,"path":"README.md","kind":"added","expectedLive":"absent","afterDigest":"sha256:…","mode":"0644","size":210}]}
```

The manifest of a **prepared merge** (`TransactionExt.prepare`, §7.5.7), an immutable object that stores the exact result to be applied: conflicts are resolved and automatic three-way merges are done **before** the manifest exists. `BenchMerge.manifest` returns it for bench shares, and `strata` for every other merge. Its SHA-256 over the JCS is the payload digest of the `fs.merge` intent and is bound by the mandate; the rendered diff is derived from the same object.

- `share` is the bench share name or `null`; `targets` are the canonical live directories; `base` is the transaction's base snapshot, `source` the frozen snapshot of the working view the result was prepared from.
- `changes` is sorted by (`target`, `path` bytes) without duplicates. `kind` ∈ `added`, `modified`, `deleted`, `renamed` (with `from`), `meta`. `expectedLive` is the content digest the live path must still have at commit, or `"absent"` (required for `added`; every other kind needs a digest). `target` is the index of the change's entry in `targets`. `afterDigest` is `null` exactly for `deleted`; `mode` (4 octal digits) and `size` are required except for `deleted`.
- **Commit** (`PreparedMerge.commit`): the mandate's effect digest MUST equal the manifest digest; `strata` takes a writer fence (`PrincipalControl.fenceWriters`), checks every `expectedLive`, and applies exactly the stored operations. It never merges again and never reads the working view; a stale precondition fails `kl:conflict`, and a different result needs a new prepared merge and a new approval.

`keylos.fsmerge/1` (`{"schema":"keylos.fsmerge/1","session","share","base","snapshot","changes":[{path, kind, beforeDigest, afterDigest, mode, size}]}`) is superseded: it remains parseable, but no mandate is bound to it.

**Trust boundary.** `strata` holds the prepared object and enforces the commit rules above for every origin; `bench` maps its share manifests to the prepared object and calls its `commit`.

### A.32 `protocols §2.3` — Resource classes

`bench` admission control and memory tuning follow the machine's **RAM class** (detected at boot, overridable in config):

| RAM | Class | Max concurrent VMs (workbench, agent, tier-2, media, pod) | Defaults |
|---|---|---|---|
| < 12 GiB | `small` | 2 | zram swap (ephemeral key), KSM on, compressed snapshots, agents queue |
| 12–24 GiB | `medium` | 6 | KSM on, free-page reporting |
| > 24 GiB | `large` | 16 | free-page reporting |

`server-k8s` nodes are exempt from the VM cap for pod VMs; kubelet `maxPods` bounds them instead. When the cap is reached, new agent sessions queue (`aide`), and other VM requests fail with `kl:unavailable`.

### A.33 `protocols §7.5.8` — `devd-sys.capnp`

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

### A.34 `protocols §9.5` — Devices, removable media and DMA

- **USB authorization.** `devd` sets `authorized_default=0` on every USB host controller. A newly attached device stays unauthorized (no driver binds) until approved on the trusted path and authorized through `DeviceAdmin.authorize` (§7.5.8). Approvals are stored per device identity (vendor, product, serial, port) when the human ticks "remember".
  - Input devices present during installation are pre-authorized.
  - A new device exposing a HID keyboard-like interface (`hidSafety: "keyboard-like"`) can only be approved using an **already-authorized** input device; its own keystrokes are discarded until then (BadUSB keystroke-injection defence).
  - Policy MAY auto-authorize device classes (`devices.autoAuthorize`, e.g. `["audio", "fido"]`); class `hid`, `net` and `mass-storage` are never auto-authorized by default.
  - **Before `devd` runs.** The kernel command line sets `usbcore.authorized_default=2` (only devices on internal, hard-wired ports are authorized). The initrd's authorizer (`boot`) additionally authorizes external hubs and devices whose interfaces are **all** HID, so external keyboards work for VBU, the PIN and the recovery prompt; it never authorizes storage, network or composite devices with a non-HID interface. In the initrd, keystrokes reach only those prompts (the TPM dictionary-attack lockout bounds PIN guessing). After `switch_root`, `devd` re-evaluates every authorized external device: a device that is neither remembered nor listed in `/var/lib/keylos/devd/preauthorized.json` is deauthorized and becomes pending. The remaining window is residual risk R15 of the distribution.
  - `/var/lib/keylos/devd/preauthorized.json` (written by the installer: the input devices present at installation; read by `devd`): `{"schema":"keylos.preauth/1","devices":[{"vendor":"046d","product":"c52b","serial":"…","port":"usb1-2","classes":["hid"]}]}` (vendor/product as 4 lowercase hex digits; `serial` empty when the device has none).
- **Thunderbolt / USB4 / external PCIe.** The IOMMU is required (§2). Domains and devices are authorized by `devd` only after trusted-path approval; without an IOMMU they are never authorized. Pre-boot DMA protection relies on firmware; the boot report records whether the firmware declared it.
- **Removable storage is never mounted by host filesystem drivers.** Authorizing a mass-storage, SD, optical or MTP device makes its block device (or MTP endpoint) available only through `MediaAttach.claimBlock` to a **media VM** (`VmSpec.purpose = media`, image `io.keylos.bench.media`), started by `Bench.media`. The VM mounts the filesystem and serves files through `MediaBrowser` (§7.5.10).
  - Bytes read through `MediaBrowser.open` are labelled `public/untrusted`; `portal-files` shows the device as the location "USB: <label>".
  - Writing to the device is the effect `media.export` (§14.2): data is copied into the media VM, which writes it.
  - Exception: a disk whose LUKS2 header carries the keylos backup token (`keylos-backup`) and verifies against the machine's backup key is unlocked and mounted on the host by `strata` for backups only.
- **Fingerprint readers** may unlock the screen lock only. They never satisfy presence and never unlock the disk.
- **VFIO passthrough** (`needs.gpu: "passthrough"`, pod VMs): only devices listed in config `devices.passthrough` are bound to `vfio-pci` through `MediaAttach.claimVfio`; the host driver is unbound for the VM's lifetime.

### A.35 `protocols §14.5` — Operating rules

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.

### A.36 `protocols §21.2` — Runtime classes

| RuntimeClass | Isolation | Images | Notes |
|---|---|---|---|
| `keylos-vm` (default) | One `bench` microVM per pod sandbox (`VmSpec.purpose = pod`); containers run inside the guest under `youki` driven by `benchd` | Any OCI image, pulled by `cri` into `/var/lib/keylos/cri/images` (via `gate` when `cluster.egressViaGate`), shared read-only into the VM | VM principal `pod:<ns>/<name>:oci:sha256:<first image>@_cluster/…`; GPU only by passthrough |
| `keylos-sealed` | t1 principals spawned by `warden` through `PodSpawn` (§7.5.1) | Only `container` generations (§6.1) with a generation statement signed by an `org-publisher` key enabled on the machine | One principal per container; seccomp `runtime-default`; no added capabilities ever |

### A.37 `protocols §21.5` — Networking

- `net` creates the **cri network namespace** at its own start on `server-k8s` (veth uplink to the host, bridge `kl-cri0`), from config `cluster.*`. `warden` obtains it with `NetPlumbingCluster.clusterNetns` and starts `crid`, `kubelet` and `kube-proxy` in it. `cri` configures it dynamically with `clusterUplink` (the pod CIDR assigned through the Node object, NAT, overlay) and obtains per-pod network namespaces from `net` with op `podNetns`. This is the single exception to "only `warden` creates namespaces" (§9.1): network namespaces only.
- **`keylos.cri.uplink/1`** (JCS JSON passed to `clusterUplink`):
  - `{"schema":"keylos.cri.uplink/1","op":"uplink","podCidr":"10.244.3.0/24","clusterCidrs":["10.244.0.0/16"],"serviceCidr":"10.96.0.0/12","mtu":1450,"nat":true,"overlay":{"mode":"none" | "vxlan","vni":4242,"peers":[{"node":"…","ip":"…","podCidr":"…"}]}}` → returns the cri namespace;
  - `{"schema":"keylos.cri.uplink/1","op":"podNetns","podId":"pod-…","ip":"10.244.3.17","mac":"…","mtu":1450}` → returns a new pod namespace with a veth attached to `kl-cri0`;
  - `{"schema":"keylos.cri.uplink/1","op":"release","podId":"pod-…"}` → deletes it (returns no fd: `Fd.index` 0xFFFF).
- Pod VMs attach a **tap** device to a bridge inside the cri namespace. This is the only use of tap devices in keylos; workbench and tier-2 VMs never get one. Sealed pods get a veth pair into the same bridge.
- IPAM is host-local per pod CIDR; cross-node connectivity is direct routing or a VXLAN overlay configured by `cri`. Third-party CNI plugins are not supported; eBPF-based CNIs are not supported on the host.
- NetworkPolicy objects (watched by `cri` through the node's credential) are compiled to nftables in the cri namespace.
- With `cluster.egressViaGate = true`, pod egress to addresses outside the cluster CIDRs is redirected to a per-pod `gate` shim endpoint (`PodSpawn.egressShim`, §7.5.1; `keylos-vm` pods use their VM's `bench-net`) and is subject to gate policy. The broker attaches the pod principals' tokens at `registerSession` from policy `cluster.egress`.

### A.38 `protocols §21.6` — Storage

- `emptyDir` and local PersistentVolumes are `strata` subvolumes (`StrataVolumes`, §7.5.7); `configMap`, `secret`, `projected` and `downwardAPI` volumes are tmpfs filled by `cri` (Kubernetes secrets arrive from the API server and are never stored in `vault`).
- NFS, iSCSI and RBD volumes are mounted **inside pod VMs only** (`keylos-vm`).
- CSI drivers are supported only as `container` generations declaring `needs.csi`; their node plugins run in a pod VM, and block devices reach them through `MediaAttach.claimBlock` (devd facet `cri`).
- `hostPath` is denied by default policy except a read-only allowlist.

### A.39 `protocols §7.3.15` — `net.capnp`, `devd.capnp`, `journal.capnp`, `portals.capnp`, `compat.capnp`

```capnp
@0xc7a1e5d3b2f40015;   # net.capnp
using C = import "common.capnp";
struct Link { name @0 :Text; kind @1 :Text; state @2 :Text; addresses @3 :List(Text); metered @4 :Bool; }
struct WifiNetwork { ssid @0 :Text; security @1 :Text; signal @2 :Int16; known @3 :Bool; }
interface Net {
  links     @0 () -> (list :List(Link));
  wifiScan  @1 () -> (list :List(WifiNetwork));
  wifiJoin  @2 (ssid :Text, credential :C.Fd) -> ();    #! facet user only; credential stored via vault
  vpnUp     @3 (profile :Text) -> ();                   #! facet user only
  vpnDown   @4 (profile :Text) -> ();                   #! facet user only
  resolve   @5 (name :Text) -> (addresses :List(Text), dnssec :Bool);
  time      @6 () -> (synced :Bool, offsetNanos :Int64, source :Text);
  status    @7 () -> (json :Text);
}
```

```capnp
@0xc7a1e5d3b2f40016;   # devd.capnp
using C = import "common.capnp";
struct Device { id @0 :Text; subsystem @1 :Text; name @2 :Text; properties @3 :List(C.KeyValue); }
interface Devd {
  list   @0 (subsystem :Text) -> (list :List(Device));
  open   @1 (id :Text, token :C.Token, flags :UInt32) -> (fd :C.Fd);   # facet broker; callers use broker.materialize
  watch  @2 (subsystem :Text, watcher :C.Watcher(Device)) -> (cancel :C.Cancelable);
  power  @3 (op :Text) -> ();                                         # "suspend" | "poweroff" | "reboot" (hibernate: kl:unsupported)
}
```

```capnp
@0xc7a1e5d3b2f40017;   # journal.capnp
using C = import "common.capnp";
struct Entry { time @0 :C.Timestamp; principal @1 :C.PrincipalId; level @2 :UInt8; message @3 :Text; fields @4 :List(C.KeyValue); }
interface Journal {
  writer @0 () -> (stream :C.Fd);                                  # SOCK_SEQPACKET, protocols §10.6 record format; attributed to the caller
  query  @1 (filterJson :Text, limit :UInt32) -> (entries :List(Entry), cursor :Text);
  follow @2 (filterJson :Text, watcher :C.Watcher(Entry)) -> (cancel :C.Cancelable);
}
```

```capnp
@0xc7a1e5d3b2f40018;   # portals.capnp
using C = import "common.capnp";
struct CaptureStream { nodeId @0 :UInt32; width @1 :UInt32; height @2 :UInt32; sourceDescription @3 :Text; }
interface ScreenCapture { start @0 (kind :Text) -> (streams :List(CaptureStream), remote :C.Fd); }   # remote = PipeWire remote fd restricted to the nodes
interface Camera        { open @0 () -> (remote :C.Fd); }
interface Microphone    { open @0 () -> (remote :C.Fd); }
interface OpenUri       { open @0 (uri :Text) -> (); openFile @1 (file :C.Fd) -> (); }
interface NotifyHandler { activated @0 (id :UInt32, action :Text) -> (); }
interface Notify        { post @0 (title :Text, body :Text, actions :List(Text), handler :NotifyHandler) -> (id :UInt32); close @1 (id :UInt32) -> (); }
  #! handler is optional; when null, activation spawns the app's "notify-action" entrypoint with the action id as argv[1]
interface Print         { print @0 (document :C.Fd, mime :Text, optionsJson :Text) -> (jobId :Text); }
interface Clipboard     { read @0 (mime :Text) -> (data :C.Fd); write @1 (mime :Text, data :C.Fd) -> (); }
interface Location      { current @0 (accuracy :Text) -> (lat :Float64, lon :Float64, accuracyM :Float64); }
interface Accessibility { observe @0 () -> (observer :Capability); }    # returns an A11yObserver (§7.5.17); assistive-tech principals only
struct ServiceInstance { name @0 :Text; type @1 :Text; host @2 :Text; port @3 :UInt16; addresses @4 :List(Text); txt @5 :List(C.KeyValue); }
interface Discovery {                                                    # portal-discovery (mDNS / DNS-SD)
  browse  @0 (serviceType :Text, watcher :C.Watcher(ServiceInstance)) -> (cancel :C.Cancelable);   #! results raise the caller's label to integ untrusted
  publish @1 (instance :Text, serviceType :Text, port :UInt16, txt :List(C.KeyValue)) -> (handle :C.Cancelable);
      #! requires a listen grant for port (needs.listen scope lan) and a publish grant; on the local link only
}
struct ScanOptions { resolutionDpi @0 :UInt16; mode @1 :Text; source @2 :Text; format @3 :Text; }   # mode: color|gray|lineart; format: png|pdf|jpeg
interface Scan {                                                         # portal-scan (SANE backends in a compat island)
  scanners @0 () -> (list :List(Text));
  scan     @1 (scanner :Text, options :ScanOptions) -> (image :C.Fd);    #! trusted-path confirmation per scan; result labelled public/user
}
```

```capnp
@0xc7a1e5d3b2f40019;   # compat.capnp
using C = import "common.capnp";
using W = import "warden.capnp";
interface Compat {
  importImage @0 (source :Text) -> (generation :C.Ref);   # "oci://…", "flatpak://remote/ref", "distro:<name>:<release>", "rootfs:<dirfd>"
  run         @1 (generation :C.Ref, argv :List(Text), fds :List(W.FdMapping), grants :List(C.Token)) -> (process :W.Process);
}
```

### A.40 `protocols §7.3.6` — `vault.capnp`

```capnp
@0xc7a1e5d3b2f40006;
using C = import "common.capnp";

struct ItemAcl {
  actors  @0 :List(Text);        # actor patterns, e.g. "app:gen:fsv256:…", "app:name=org.example.Editor"
  ops     @1 :List(Op);
  prompt  @2 :PromptPolicy;
  enum Op { read @0; use @1; update @2; delete @3; }
  enum PromptPolicy { never @0; perSession @1; always @2; presence @3; }
}

struct ItemInfo { name @0 :Text; kind @1 :Text; created @2 :C.Timestamp; acl @3 :ItemAcl; }

interface Vault {
  open    @0 (name :Text, purpose :Text) -> (secret :C.Fd);       #! delivery format §20.10 (memfd_secret, mmap-only, length-prefixed)
  store   @1 (name :Text, kind :Text, value :C.Fd, acl :ItemAcl) -> ();   # value.index 0xFFFF = ACL-only update
  delete  @2 (name :Text) -> ();
  list    @3 () -> (items :List(ItemInfo));
  sign    @4 (name :Text, alg :Text, data :Data) -> (signature :Data);   # key never leaves vault
  sshAgent @5 () -> (socket :C.Fd);                                     # per-principal SSH agent protocol socket
  dataKey @6 (unit :Text) -> (key :C.Fd);                                # crypto-shred unit key (facets strata, ledger, gate, aide, journal, loom; each only for its own unit prefix)
  forget  @7 (unit :Text) -> ();                                         # destroy unit key (same facets)
  inject  @8 (name :Text, target :Text) -> (handle :Data);              # facet gate only: opaque handle for credential injection
}
```

An injection handle is redeemed by `gate` with `open("inject:<hex handle>", purpose)` on facet `gate`.

### A.41 `protocols §20.10` — Secret delivery (`Vault.open`)

- **Primary:** a `memfd_secret(FD_CLOEXEC)` fd of the value's length plus 8, rounded up to the page size, laid out as `u64 little-endian length ‖ value ‖ zero padding`. secretmem fds are readable only through `mmap`; recipients map them `PROT_READ`, read the length, use the bytes, and zeroize and unmap on drop (`keylos-vault-client::SecretBuf`).
- **Fallback** (when `memfd_secret` is unavailable): a `memfd_create(MFD_CLOEXEC|MFD_ALLOW_SEALING|MFD_NOEXEC_SEAL)` fd with the same layout, sealed `F_SEAL_WRITE|F_SEAL_SHRINK|F_SEAL_GROW|F_SEAL_SEAL`. The receipt records `data.delivery = "memfd-sealed"`.

### A.42 `protocols §14.4` — Mandates (`keylos.mandate/1`)

```json
{"schema":"keylos.mandate/1","approval":"a-…","principal":"…","tier":"t3",
 "effects":[{"kind":"email.send","target":"smtp:…","digest":"sha256:<payload digest>"}],
 "scope":"once","constraints":{"maxAmount":null,"expires":"…"},"decidedBy":"alice","presence":true,
 "channel":"local"}
```

- `channel`: `local` (atrium trusted path), `phone` (vouch), `org` (fleet approver), `quorum` (a quorum presence envelope, §5.4; `decidedBy` is `"quorum"`).
- `constraints.workflow` and `constraints.decision`: present exactly in mandates of durable decisions (§20.25): the `wf-…` the decision belongs to and its `dr-…`. A verifier acting for a workflow MUST require `constraints.workflow` to equal the effect's workflow; verifiers that do not know these members reject the mandate (unknown members, §5.1), so an older verifier fails closed.
- `constraints.channels`: the channels the broker allowed for this approval (§14.3, `ApprovalPrompt.channels`), a non-empty array of channel names without duplicates. The deciding `channel` MUST be one of them unless it is `quorum` (quorum presence replaces local presence on quorum machines).
- **Drafts.** `ApprovalPrompt.mandateDraft` is not a valid mandate: it carries placeholder `decidedBy` and `channel` values until the deciding channel fills them in and signs. Only a decided mandate is validated as `keylos.mandate/1`.
- **Extensions carry no authority.** `x-` members (§5.1) of a mandate are informational; no verifier may base an authorization decision on them.
- **Grant effects.** For a grant decision the broker writes one effect `{"kind": "grant.<k>", "target": <canonical resource string>, "digest": "sha256:" + SHA-256(JCS(R))}`, where R is the JSON form of the `GrantRequest`: `{"resource": {<union member>: v}, "rights": [Right enumerant names], "reason", "durationSecs", "persist", "onBehalfOf": <principal text or null>}`, with v = the text value for `path`, `device`, `secret`, `service`, `effect`, `screen`, `model` and `spawn`; `null` for `dirFd` and `delegate`; `{"host", "port", "proto", "methods"}` for `net`; `{"unit", "amount"}` for `budget`; `{"target", "scope"}` for `principal`. A service that asked for a confirmation through `requestFor` (vault: `grant.secret` with `{"secret": "<owner>/<name>"}`) verifies kind and digest.
- **Decision signatures** (inside the approval flow): presence-signed (§5.3) when `presence` is true; otherwise signed by the deciding channel's approver key: the atrium approver key or the `vouchd` phone key (both registered with `BrokerSystem.registerApprover`), or an `approver/<id>` key.
- **Mandates as delivered** (`Approval.mandate`, `GrantResult.mandate`): a presence-signed mandate is delivered as is; a non-presence mandate is re-signed by `service/broker` after the broker has verified the channel's decision signature. Relying services (gate, strata, bench, depot, devd) therefore verify only owner-presence keys (owner registry, via `HearthSystem.owners`) and the `service/broker` key (as registered with `ledger`, `Ledger.serviceKey`, §7.3.5); they never need approver keys.
- The `approval.decide` receipt carries `mandateDigest` (SHA-256 of the delivered mandate envelope).
- `gate` MUST NOT commit an irreversible intent without a mandate whose `effects[].digest` matches the intent payload digest.

### A.43 `protocols §6.3` — Manifest schema (`keylos.manifest/1`)

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

### A.44 `protocols §14.2` — Effect kinds

Registered kinds, with their default class:

| Kind | Class |
|---|---|
| `fs.merge` | compensable (undo snapshot; compensator `fs.undo`) |
| `git.push` | compensable for new branches; irreversible for force pushes, pushes to protected branches and any other push to an existing branch |
| `git.pr.open` | compensable |
| `email.send` | irreversible |
| `message.send` (chat) | irreversible |
| `http.post`, `http.put`, `http.patch` | irreversible unless the host policy registers a compensator |
| `http.delete` | irreversible |
| `payment.authorize` | irreversible (requires an AP2-style mandate in `data`) |
| `publish.package` | irreversible |
| `cloud.iam.change` | irreversible |
| `db.write.prod` | irreversible |
| `calendar.create` | compensable |
| `file.share` | compensable |
| `device.actuate` | irreversible |
| `net.listen` | compensable (close the port). Required for any port reachable from non-loopback addresses (scope `lan`/`any`); loopback-only listening needs no effect |
| `media.export` | compensable (delete the file on the device); counts as egress (property X) for the Rule of Two |
| `config.propose` | reversible (a proposal only; applying it is `config.apply`) |

Policy can register additional kinds (`x-…`), each optionally with an effect renderer component (§20.15). Classes can be raised, never lowered.

**Mandate-only kinds.** The broker records decisions that are not intents with these kinds in mandate `effects[]` (§14.4): `grant.<k>` for every resource kind *k* of §8.2 (`grant.path`, `grant.net`, `grant.device`, `grant.secret`, `grant.budget`, `grant.spawn`, `grant.service`, `grant.effect`, `grant.delegate`, `grant.principal`, `grant.screen`, `grant.model`), `grant.declassify`, `debug.attach`, `pod.admit`, and for durable workflows (§20.25) `workflow.enroll` (target `wf-…`, digest = SHA-256 of the JCS `EnrollRequest` JSON form `{"workflow", "definition": {"generation": <gen ref text>, "name", "digest": <digest text>}, "inputDigest": <digest text>, "scope": [<GrantRequest JSON forms>], "budgets": [{"unit", "amount"}], "resume": "manual" | "automatic", "runWhileLocked", "horizonSecs", "reason", "account"}`), `workflow.resume` (target `wf-…`) and `workflow.decide` (target the `ws-…` or `fx-…` the decision is about, digest = SHA-256 of the JCS question or resolution document). They are valid only in mandates, written only by `broker`, and never appear in manifests, command signatures, intents or `gate` intents.

**Required review details.** Approval of an effect requires that the trusted path presents at least these details of the exact payload (§7.3.4); a policy-registered kind's renderer declares its own, and a kind without a declaration requires the complete canonical payload:

| Kind | Required details |
|---|---|
| `email.send`, `message.send` | every recipient (to, cc, bcc), subject, complete body, attachment names, types and sizes |
| `http.*` | method, complete URL, request body (or its digest plus a complete canonical rendering for bodies over the channel limit) |
| `payment.authorize` | amount, currency, payee, mandate terms |
| `fs.merge` | the complete `keylos.fsmerge/2` manifest and the diff of every changed text file; binary changes by path, size and digest |
| `git.push`, `git.pr.open` | remote, refs (old → new), commits with titles; force flag |
| `publish.package`, `cloud.iam.change`, `db.write.prod`, `device.actuate` | target and the complete operation |
| `file.share`, `calendar.create`, `media.export`, `net.listen` | target (people, device or port and scope) and the object |
| `config.propose`, `config.apply` | the complete plan diff |
| `grant.*`, `debug.attach`, `pod.admit`, `grant.declassify` | resource, rights, duration, persistence, requesting principal and `onBehalfOf` |
| `workflow.enroll` | definition (name, version, generation, digest), every scope item as for `grant.*`, budget ceilings, resume policy (`automatic` stated as "runs again after restarts without asking"), `runWhileLocked`, horizon, the owner and the label the workflow starts with |
| `workflow.resume`, `workflow.decide` | workflow, definition, current step, the complete question or resolution document, and for `workflow.decide` on an effect the effect's own required details |

**Caller-executed effects.** For `media.export`, `device.actuate` and `config.propose`, `gate` stages, renders and decides the intent but does not perform it. A successful `Intent.commit` returns, in `IntentStatus.result`, the base64 delivered mandate (§14.4) bound to the payload digest, and `gate` writes `effect.commit` meaning "authorized". The executor (`bench` `MediaBrowser.export`/`ExportCompletion.finish`, the device's owning service, `config` for `propose`) MUST verify the mandate (owner-presence or `service/broker` signature, payload digest, expiry, single use) before acting, and writes its own completion receipt (`media.export` by `bench`). Stagers of `media.export` are `portal-files` and `atrium` on behalf of the requesting app. **Authorization is not completion**: an intent in `committed` state of a caller-executed kind, and an effect in `authorized` state (§20.26), say only that the effect may be performed; a workflow waits for the executor's authenticated completion (its receipt, `DurableEffects.complete`) before it treats the effect as done.

### A.45 `protocols §7.5.3` — `hearth-sys.capnp`

```capnp
@0xc7a1e5d3b2f40022;
using C = import "common.capnp";

interface HearthSystem {           # facet system
  validateSession @0 (session :C.SessionId) -> (user :Text, authenticatedAt :C.Timestamp, methods :List(Text), locked :Bool);
  owners          @1 () -> (registryJson :Text);            # keylos.owners/1 (§20.3)
  prepareSuspend  @2 () -> ();                              # devd before suspend; returns within 2 s
  resumed         @3 () -> ();
  exportPasswd    @4 () -> (passwd :Text, group :Text);     # for legacy views
  userState       @5 (user :Text) -> (locked :Bool, since :C.Timestamp);
      #! locked = the user has no authenticated, unlocked login session (logged out counts as locked); loom only
  watchUsers      @6 (watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);
      #! JCS {"user", "locked", "since", "deleted"} for every change of userState of any user and for user deletion; loom only
}

interface HearthSeal {             # facets seal (depot, forge)
  openWindow  @0 (windowJson :Text) -> (windowId :Text, presenceEnvelope :Data);   # keylos.seal-window/1 (§20.4); touch on trusted path
  sealSign    @1 (windowId :Text, statementJson :Text) -> (signature :Data, keyRef :Text);   # ECDSA P-256 DER by owner-seal/<i>
      #! any facet-seal holder may sign within a window another holder opened;
      #! statementJson MUST be keylos.seal/1 or keylos.genstmt/1 and its drv MUST be in the window's drvs, else kl:denied
  closeWindow @2 (windowId :Text) -> ();
}

interface HearthTpm {              # facet tpm (courier, vault, strata, ledger, config; vouch and fleet: activateCredential only)
  defineSpace @0 (index :UInt32) -> ();
      #! (re)defines an NV index listed in §19.6 with exactly its registry template; only the index's registered owner may call
  evict       @1 (handle :UInt32) -> ();
      #! evicts a persistent handle listed in §19.6 (e.g. 0x81000103 after first boot); presence required except for 0x81000103
  sbSign      @2 (which :Text, payload :Data, presenceEnvelope :Data) -> (signature :Data);
      #! which = "kek" | "db": signs an authenticated-variable update (PKCS#7 payload digest) with 0x81000101 / 0x81000102
      #! behind the seal gate; presenceEnvelope purpose "boot.sb-sign" covering SHA-256(payload); caller courier
  activateCredential @3 (akHandle :UInt32, credentialBlob :Data, encryptedSecret :Data) -> (secret :Data);
      #! TPM2_ActivateCredential with the EK (endorsement auth held by hearth) for AK 0x81010002 or AK0 0x81010003;
      #! used by vouch pairing and fleet enrolment to prove the AK lives in this TPM
  recreateKey        @4 (handle :UInt32, presenceEnvelope :Data) -> ();
      #! re-creates a persistent key listed in §19.6 from its registry template after a TPM clear or loss (e.g. the strata
      #! anchor HMAC key 0x81000110); only the key's registered owner may call; presence purpose "boot.recreate-key"
  sbAccepted         @5 (kekCert :C.Digest, dbCert :C.Digest) -> ();
      #! courier only: the firmware KEK and db variables (read back at boot) contain the new owner certificates with these
      #! SHA-256 digests; hearth then swaps the staged signers onto 0x81000101/0x81000102 (kl:conflict if nothing is staged)
}

interface HearthQuorum {           # facets presence (request, collect), quorum (submit: fleet), admin (list)
  request @0 (purpose :Text, payload :Data, rendering :List(Text)) -> (requestId :Text, requestEnvelope :Data);
      #! creates a keylos.quorum/1 request (§20.18), signed by service/hearth with its ledger key chain; expires ≤ 24 h
  submit  @1 (requestId :Text, signedEnvelope :Data) -> (have :UInt8, need :UInt8);
      #! adds approver signatures (each a §5.3 signature over the request's payload PAE) after verifying them
  collect @2 (requestId :Text) -> (envelope :Data);   #! kl:needs-approval until ≥ threshold distinct owners have signed
  list    @3 () -> (json :Text);
}

interface HearthFleet {            # facet fleet-lock (fleet)
  lockAll @0 (commandEnvelope :Data) -> ();
      #! verified keylos.fleet.command/1 "lock": locks every session, revokes every agent session (kill), requires owner unlock
}

interface HearthAdmin {            # facet admin
  createUser  @0 (name :Text, displayName :Text, owner :Bool) -> (uid :UInt32);   # presence
  disableUser @1 (name :Text, disabled :Bool) -> ();                                # presence
  deleteUser  @2 (name :Text, forgetData :Bool) -> ();                              # presence
  setPassword @3 (name :Text, secret :C.Fd) -> ();
  addOwner    @4 (name :Text) -> ();                                                # presence (quorum)
  removeOwner @5 (name :Text) -> ();
  setQuorum   @6 (addOwner :UInt8, remove :UInt8) -> ();   #! superseded before release: MUST return kl:unsupported
  registry    @7 () -> (json :Text);
  setQuorumPolicy @8 (mode :Text, quorum :UInt8, threshold :UInt8) -> ();
      #! appends a set-quorum owner-registry entry (§20.3): mode "touch" | "quorum"; quorum = owners required for
      #! owner-set changes; threshold = distinct owners for quorum presence (mode quorum)
}
```

**NV definition after genesis.** Once `hearth` holds the owner hierarchy authorization (installer genesis), every service that needs one of its registered NV indices (re)created obtains it through `HearthTpm.defineSpace`; no other service uses owner authorization. `defineSpace` defines the index from its registry template, generates a fresh authValue, and writes the sealed authValue file `nv-auth/0x<index>.sealed` (§19.6) before returning. `HearthQuorum` on facet `admin` serves `collect` and `list`; each `list` entry includes `requestEnvelope` (standard base64).

### A.46 `protocols §7.3.5` — `ledger.capnp`

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

### A.47 `protocols §7.5.25` — `loom-sys.capnp`

The system contracts of durable execution (§20.25, §20.26): durable effects and workflow budget accounts (gate), workflow records, claims and durable decisions (broker), agent attempts (aide) and attempt observations (loom).

```capnp
@0xc7a1e5d3b2f40039;
using C = import "common.capnp";
using B = import "broker.capnp";
using G = import "gate.capnp";
using P = import "prompt.capnp";
using L = import "loom.capnp";

enum RetryStrategy { transactional @0; downstreamIdempotency @1; reconciliation @2; noSafeRetry @3; }   #! §20.26

enum EffectState {                #! §20.26: authorized is not completion; only succeeded/failed are confirmed outcomes
  prepared @0; awaitingApproval @1; authorized @2; dispatching @3;
  succeeded @4; failed @5; outcomeUnknown @6; cancelled @7; compensated @8;
}

struct EffectSpec {
  effect  @0 :Text;                # fx-… from AttemptHost.effect
  binding @1 :C.AttemptBinding;    # the preparing attempt; MUST match the token's workflow fact (§8.2)
  intent  @2 :G.EffectIntent;      # kind, class, target, args, payload; idempotencyKey MUST be empty (the effect id is the key)
}

struct EffectRecord {
  effect        @0 :Text;            # fx-…
  workflow      @1 :Text;            # wf-…: the owner of the effect (never a session)
  state         @2 :EffectState;
  strategy      @3 :RetryStrategy;   #! declared by the executor, fixed at prepare (§20.26)
  kind          @4 :Text;
  target        @5 :Text;
  requestDigest @6 :C.Digest;        #! §20.26; a later prepare with the same effect id and another digest: kl:conflict
  payloadDigest @7 :C.Digest;
  decision      @8 :Text;            # dr-… when an approval was required
  intent        @9 :Text;            # e-… of gate's outbox intent
  epoch         @10 :UInt64;         # ownership epoch that last authorized or dispatched it
  dispatched    @11 :C.Timestamp;
  dedupUntil    @12 :C.Timestamp;    # end of the destination's deduplication window (downstreamIdempotency); 0 otherwise
  outcome       @13 :Text;           # JCS: executor result (succeeded, failed) or the reason (outcomeUnknown)
  receipts      @14 :List(Text);     # rcpt refs of the authorization and completion receipts
  retainUntil   @15 :C.Timestamp;    #! the dedup record is kept at least until then (§20.26)
}

interface DurableEffects {         # gate; facets client and aide: prepare, complete, lookup, watch; facet loom: all except prepare
  prepare   @0 (spec :EffectSpec, token :C.Token) -> (record :EffectRecord);
      #! stages the effect for its workflow (the token's principal is the attempt session); durable before return; idempotent
      #! per effect id with an equal request digest; a stale epoch: kl:conflict
  commit    @1 (effect :Text, binding :C.AttemptBinding) -> (record :EffectRecord);
      #! facet loom: authorizes with BrokerWorkflow.authorizeEffect (current policy, durable decision) and dispatches per strategy;
      #! returns the record when it is awaitingApproval, has a confirmed outcome, or is outcomeUnknown
  complete  @2 (effect :Text, receipt :Text) -> (record :EffectRecord);
      #! caller-executed kinds (§14.2): the executor's completion receipt (rcpt ref) is the authenticated outcome
  lookup    @3 (effect :Text) -> (record :EffectRecord);      #! durable lookup by effect id (facet client/aide: own workflow only)
  watch     @4 (effect :Text, watcher :C.Watcher(EffectRecord)) -> (cancel :C.Cancelable);
  cancel    @5 (effect :Text, reason :Text) -> (record :EffectRecord);
      #! prepared or awaitingApproval → cancelled; from authorized on it cannot be cancelled (record returned unchanged)
  reconcile @6 (effect :Text) -> (record :EffectRecord);      # run the executor's reconciliation now (strategy reconciliation)
  resolve   @7 (effect :Text, outcome :Text, mandate :Data) -> (record :EffectRecord);
      #! outcomeUnknown → succeeded | failed on the owner's decision (mandate kind workflow.decide bound to the record, §14.4)
  forget    @8 (workflow :Text) -> ();
      #! forgotten workflow: shreds its payloads (unit gate:<owner>:<wf-id>); keeps the minimal dedup records (§20.26)
}

struct BudgetEntry { key @0 :Text; state @1 :Text; amount @2 :List(B.Budget); }   # state "reserved" | "settled" | "released" | "unresolved"

interface WorkflowBudget {         # gate; facet broker: open, close, status; facet loom and facet aide: reserve, settle, release, status
  open    @0 (account :Text, workflow :Text, ceilings :List(B.Budget)) -> ();   #! idempotent; same account, other ceilings: kl:conflict
  reserve @1 (account :Text, key :Text, amount :List(B.Budget)) -> (entry :BudgetEntry);
      #! idempotent per (account, key); kl:budget when spent + reserved + unresolved + amount exceeds a ceiling
  settle  @2 (account :Text, key :Text, actual :List(B.Budget), outcome :Text) -> (entry :BudgetEntry);
      #! once per key: replaces the reservation by actual; outcome "unknown" keeps it as unresolved (still counted); a repeat with
      #! equal values returns the entry, with other values kl:conflict
  release @3 (account :Text, key :Text) -> (entry :BudgetEntry);   # drops an unsettled reservation; idempotent
  status  @4 (account :Text) -> (ceilings :List(B.Budget), reserved :List(B.Budget), spent :List(B.Budget), unresolved :List(B.Budget));
  close   @5 (account :Text) -> ();   # terminal workflow: no further reservations; spent amounts stay recorded
}

struct EnrollRequest {
  workflow       @0 :Text;            # wf-…
  definition     @1 :L.DefinitionRef;
  inputDigest    @2 :C.Digest;
  scope          @3 :List(B.GrantRequest);
  budgets        @4 :List(B.Budget);
  resume         @5 :L.ResumePolicy;
  runWhileLocked @6 :Bool;
  horizonSecs    @7 :UInt64;
  reason         @8 :Text;
  account        @9 :Text;            # ba-… the broker opens with WorkflowBudget.open when the enrollment is approved
}

struct DecisionRecord {
  id       @0 :Text;                  # dr-…
  workflow @1 :Text;
  key      @2 :Text;                  # logical operation, e.g. "enroll", "effect:fx-…", "grant:<name>", "decide:<ws-…>"
  digest   @3 :C.Digest;              #! sha256 of the JCS {workflow, key, requests, effects}: never a session or attempt (§20.25)
  state    @4 :Text;                  # "pending" | "approved" | "denied" | "expired" | "cancelled"
  approval @5 :Text;                  # boot-local a-… of the prompt currently shown; empty when none
  mandate  @6 :Data;                  # the delivered mandate (§14.4) when approved
  expires  @7 :C.Timestamp;           #! fixed when decided; never extended by a rebind or a later attempt
}

struct DecisionEffect { kind @0 :Text; target @1 :Text; digest @2 :C.Digest; rendered @3 :List(P.RenderedEffect); }

struct WorkflowRecordInfo {
  workflow       @0 :Text;
  owner          @1 :Text;
  state          @2 :Text;            # "enrolling" | "active" | "cancelled" | "forgotten"
  epoch          @3 :UInt64;          # highest claimed ownership epoch
  attempt        @4 :Text;            # wa-… of that claim
  label          @5 :C.Label;         # workflow label high-water mark
  horizon        @6 :C.Timestamp;
  account        @7 :Text;            # ba-…
  resume         @8 :L.ResumePolicy;
  runWhileLocked @9 :Bool;
  definition     @10 :L.DefinitionRef;
}

interface BrokerWorkflow {         # broker, facet workflow (holders per §19.2)
  enroll   @0 (subject :C.SessionId, req :EnrollRequest) -> (decision :DecisionRecord);
      #! loom: Cedar action enroll for the subject (the owner's session) plus every scope item as a persistent request (§20.25)
  claim    @1 (binding :C.AttemptBinding, generation :C.Ref, spawner :C.SessionId) -> (record :WorkflowRecordInfo);
      #! loom: binding.epoch MUST be record.epoch + 1 (else kl:conflict); persisted before return; revokes every root of
      #! earlier attempts; generation and spawner are the only ones allowed to register this attempt (SessionReg.attempt)
  verify   @2 (binding :C.AttemptBinding, session :C.SessionId) -> (record :WorkflowRecordInfo);
      #! gate, strata, bench, aide: binding is the current claim and session belongs to it; else kl:conflict (stale) or kl:revoked
  decide   @3 (binding :C.AttemptBinding, key :Text, requests :List(B.GrantRequest), effects :List(DecisionEffect)) -> (decision :DecisionRecord);
      #! durable logical request: deduplicated by (workflow, key) and the digest, never by session; persisted before any prompt
  rebind   @4 (decision :Text, binding :C.AttemptBinding, session :C.SessionId) -> (result :B.GrantOutcome);
      #! explicit use of an approved decision by a fresh attempt: revalidated against current policy, revocation and expiry;
      #! grants are minted for session; never extends expiry or presence
  authorizeEffect @5 (binding :C.AttemptBinding, effect :Text, kind :Text, target :Text, payloadDigest :C.Digest,
                      rendered :List(P.RenderedEffect)) -> (decision :DecisionRecord);
      #! gate: current authority for one workflow effect (record, policy, Rule of Two with the workflow label, epoch); approved
      #! immediately (no prompt, empty mandate) or through a durable decision with key "effect:<fx-…>"
  offer    @6 (binding :C.AttemptBinding) -> (tokens :List(C.Token));
      #! aide: path and net tokens of the workflow scope bound to aide's own session, expiring after 120 s, for building the
      #! shares and offered tokens of the attempt's VM (§20.25)
  resume   @7 (subject :C.SessionId, workflow :Text) -> (decision :DecisionRecord);   # loom: Cedar action resume for the subject
  cancel   @8 (subject :C.SessionId, workflow :Text, reason :Text, forget :Bool) -> (record :WorkflowRecordInfo);
      #! loom (subject = the cancelling session, Cedar action cancel; empty subject for loom's own forget of a deleted user's
      #! workflows, §20.25): durable cancellation and
      #! revocation record, persisted before return; revokes every root of the workflow; refuses every later claim
  record   @9 (workflow :Text) -> (record :WorkflowRecordInfo);   # loom, gate, strata
  raise    @10 (workflow :Text, label :C.Label, reason :Text) -> (label :C.Label);
      #! loom: raises the workflow label high-water mark (labels only go up), persisted before return
  cancelDecision @11 (decision :Text, reason :Text) -> (decision :DecisionRecord);
      #! loom, gate: withdraws one pending durable decision (its prompt is closed); idempotent; a decided one is returned unchanged
}

interface AgentWorkflowHost {      # aide, facet loom
  startAttempt @0 (binding :C.AttemptBinding, template :C.Ref, task :Text, input :C.Fd, label :C.Label) -> (session :C.SessionId);
      #! starts an agent session as the attempt (VmSpec.attempt); the harness reaches loom only through aide
  stopAttempt  @1 (binding :C.AttemptBinding, mode :Text) -> ();   # mode "cancel" | "fence" | "pause"
  status       @2 (binding :C.AttemptBinding) -> (json :Text);
}

interface LoomSystem {             # loom, facet aide
  attempt         @0 (binding :C.AttemptBinding, session :C.SessionId) -> (host :L.AttemptHost);
      #! the AttemptHost of an agent attempt aide started; aide records every model and host-tool observation through it
  ended           @1 (binding :C.AttemptBinding, reason :Text) -> ();
      #! the attempt ended without complete/fail: "crashed" | "paused" | "breaker" | "deadline" | "vm-lost"; never a cancellation
  cancelRequested @2 (binding :C.AttemptBinding, subject :C.SessionId, reason :Text) -> ();
      #! the human stopped the attached agent session (AgentSession.stop): loom treats it as Workflow.cancel by subject
}
```

### A.48 `protocols §20.25` — Durable execution

A **workflow** is an enrolled, durable task: a pinned definition (§20.27) run by `loom` as a sequence of steps, each executed by one or more **attempts**. The central invariant is normative for every component named in this section:

> Workflow progress survives execution attempts. Authority is revalidated before every further effect, and persistence never resurrects revoked permissions or cancelled work.

Boot-scoped authority is unchanged: tokens, root keys, sessions and prompt IDs never outlive their boot (§8.1). What survives is the record of progress and of decisions, never the authority to act on it.

**Roles.**

| Component | Durable responsibility | Never |
|---|---|---|
| `loom` | Workflow store: enrollments, runs, steps, attempts, recorded observations, timers, signals, tombstones; scheduling, claims, cancellation; the receipt outbox | holds workflow authority, executes effects, decides approvals |
| `broker` | Workflow records (approved scope, ownership epoch, label high-water mark, cancellation), attempt authority at registration, durable decisions | trusts loom for anything but the identity of the next claim |
| `gate` | Durable effect records by effect ID, executor strategies, workflow budget accounts | executes an effect without current authorization |
| `warden` | A fresh session for every attempt process (`SpawnSpec.attempt`) | persists sessions or fds, interprets attempt bindings |
| `aide` | Agent sessions as attempts (`AgentWorkflowHost`); model and tool observations recorded through `loom` | resumes an agent session that is not an attempt of an enrolled workflow |
| `strata`, `bench` | Prepared merges and their completion records retained for the workflow's horizon, reachable by a fresh attempt | bind a prepared merge to a dead session only |
| `vault` | `loom:` unit keys (wrapped under the system key, forgettable) | enforce the owner-lock policy (loom does) |
| `ledger` | Signed evidence of decisions, transitions and outcomes | act as a workflow store or deduplicate submissions |
| `hearth` | The owner's lock state (`HearthSystem.userState`, `watchUsers`) | |

**Identities** (§3.5). `WorkflowId` (`wf-`) names the enrolled task, `RunId` (`wr-`) one run of it, `StepId` (`ws-`) one occurrence of one state in a run, `AttemptId` (`wa-`) one execution attempt, `EffectId` (`fx-`) one logical external or local operation shared by all retries, `OwnershipEpoch` the fence advanced by every claim, `DecisionId` (`dr-`) a durable approval, `BudgetAccountId` (`ba-`) the workflow's budget. Step and effect IDs are derived, so a replayed step finds the records of its earlier attempts. A session ID is never the identity of durable work: every attempt runs under fresh sessions, and loom records the attempt-to-session mapping. Old principals, bearer tokens, fds and prompt IDs are never stored as replay material; signatures and digests are stored as evidence and re-verified, never as a substitute for current policy.

**Status vocabulary.** `WorkflowInfo.status` (§7.3.16) and the `status` of `workflow.*` receipts take exactly these values; `detail` carries one of the listed codes.

| Status | Meaning | `detail` codes |
|---|---|---|
| `running` | An attempt is executing or a claim is scheduled | `step:<ws-…>` |
| `waiting` | No attempt is needed until an external event | `decision:<dr-…>`, `timer:<RFC 3339 time>`, `signal:<name>`, `effect:<fx-…>` (awaiting the executor's outcome), `enrollment:<dr-…>` |
| `paused` | Eligible work is held back by a pause condition | `user`, `locked` (owner locked), `awaiting-resume` (manual resume after a restart), `breaker`, `budget`, `time-untrusted`, `rollback-review`, `capacity` |
| `blocked-by-authority` | The next step needs authority that does not exist now | `revoked`, `policy`, `decision-denied:<dr-…>`, `decision-expired:<dr-…>`, `definition-revoked`, `horizon` |
| `outcome-unknown` | An effect's outcome cannot be established automatically | `effect:<fx-…>` |
| `completed`, `failed` | Terminal: the definition reached an `end` state (`failed` also for `history-lost`) | `end:<state>`, `error:<code>`, `history-lost` |
| `cancelled` | Terminal: durably cancelled | `by:<human>` |
| `forgotten` | Terminal: history crypto-shredded; only a tombstone remains | none |

**Enrollment.** Enrollment is the only way work becomes resumable; an agent, app or guest session never becomes durable by being paused, stopped or restarted.
1. A human's `shell` (or `atrium`) calls `Loom.enroll` on `loom#user`. loom checks the definition (§20.27): the generation is launchable and not revoked (`Depot.get`), its manifest lists the name in `provides.workflows`, and the file's digest equals `DefinitionRef.digest`; it validates the input against the definition's input schema, assigns the `wf-` ID, and commits an `enrolling` record (deduplicated by owner and `idempotencyKey`).
2. loom calls `BrokerWorkflow.enroll(<caller session>, EnrollRequest)`. The broker evaluates Cedar `enroll` (§16.1) and every scope item as a persistent request; the tier is the maximum, at least `t2`, with presence when `resume = automatic` or `runWhileLocked` (as for persistent grants); guest humans and non-`shell` subjects are denied by default policy. The decision is a durable decision (below) with key `enroll` and the mandate effects `workflow.enroll` plus one `grant.<k>` per scope item (§14.2).
3. When approved, the broker writes the workflow record `keylos.workflow-grant/1` (signed by `service/broker`, file and directory `fsync`ed), with the label baseline = the enrolling session's label at that moment, the horizon (`horizonSecs` capped by policy, default 30 days, maximum 400 days) and the budget account, which it opens with `WorkflowBudget.open` on `gate#broker`. Only then does the workflow leave `waiting` (`enrollment:<dr-…>`).
4. The enrolling session's tokens are never used by the workflow; the approved scope is the only authority later attempts can receive.

**Claims and ownership fencing.** loom executes every step through a **claim**: before an attempt, loom commits the claim (new `wa-`, epoch e + 1, the activity's generation, the spawner session) in its store, then calls `BrokerWorkflow.claim`. The broker accepts only epoch = its record's epoch + 1 (`kl:conflict` otherwise: a stale or second coordinator, or a restored store), persists it before replying, and revokes every root minted for earlier attempts of the workflow. Every consumer rejects a stale epoch where it can still prevent an action: loom's `AttemptHost` (every method), the broker at attempt registration and in `authorizeEffect`, `gate` in `DurableEffects` (binding versus the token's `workflow` fact and the current claim, `BrokerWorkflow.verify`), strata in `preparedFor` and `bindWorkflow`. A process that missed a cancellation or lost its coordinator may stay alive; it cannot act, because its roots are revoked and its epoch is stale. A cooperative stop or an expired lease alone never authorizes anything. A new fence cannot undo a request a remote system already accepted; such effects are settled by their effect ID (§20.26). One loom instance owns the store exclusively (SQLite exclusive locking plus a lock file); a second instance fails its first claim with `kl:conflict` and stops.

**Attempt authority.** An attempt is a fresh principal: a process spawned by loom (`SpawnSpec.attempt`, principal `<actor>@<owner>/<loom session>/<attempt session>`) or an agent VM started by `aide` (`VmSpec.attempt`). `warden` forwards the binding in `SessionReg.attempt` and uses `binding.owner` as the principal's human. At registration the broker requires the binding to be the current claim, the child's generation to be the claimed generation, its parent to be the claimed spawner and its human to be the record's owner; otherwise registration fails `kl:conflict` (stale) or `kl:revoked` (cancelled). It then, in this order:
1. sets the session label to the join of the default and the workflow's label high-water mark (labels before grants);
2. re-evaluates every scope item against current policy with the workflow principal entity (§16.1): `t0`/`t1` items are minted, `t2`/`t3` items only with the enrollment mandate, as for persistent grants; revoked, expired, cancelled or denied items are not minted;
3. mints fresh tokens for the attempt session with `workflow(<wf>, <epoch>)`, `budget_account(<ba>)` and `expires` no later than the horizon (§8.2).
The attempt process obtains these tokens like every principal, with `Broker.myGrants` on its `broker#principal` route; `warden` never passes the tokens of `SessionRegResult` to the process. An attempt therefore holds an effect token only for kinds in the enrolled scope: at `enroll`, loom refuses (`kl:invalid`) a scope that lacks an effect item for any kind an activity of the definition declares in `effects`, so `DurableEffects.prepare` always has a token to present. Offered tokens of the spawner are never delegated to an attempt. `BrokerWorkflow.offer` gives `aide` short-lived path and net tokens of the scope on its own session, only to build the attempt VM's shares, exactly as human-offered tokens are used today.

**Durable decisions.** `BrokerWorkflow.decide` creates or returns the durable decision of one logical operation. Its identity is (`workflow`, `key`) and its digest the SHA-256 of the JCS `{"workflow", "key", "requests": [<GrantRequest JSON forms, §14.4>], "effects": [{"kind", "target", "digest"}]}`; neither contains a session, attempt or prompt ID, so a fresh attempt finds the same decision. The same key with another digest fails `kl:conflict`. The broker persists the record before showing any prompt and persists the decision before replying to anyone (a crash between decision and reply loses nothing). Prompts are boot-local and re-presented after restarts (§14.3); `expires` is fixed at creation. A fresh attempt uses an approved grant decision only through `rebind`, which re-checks the record, current policy, revocation, expiry and presence and mints for the new session; an effect decision is consumed by `gate`, once per effect ID (§20.26). A trusted approval is always a decided mandate bound to the operation and payload, never a workflow signal. For a `decide` state (§20.27) the decision carries one `DecisionEffect` per option (kind `workflow.decide`, target `<ws-…>#<option>`, digest over the JCS `{"question", "option"}`); the human approves exactly one option, and the delivered mandate's `effects[]` holds only that entry, the one permitted difference from the draft. `BrokerWorkflow.cancelDecision` withdraws one pending decision (for example when its effect is cancelled).

**Effects.** loom never executes effects. An activity prepares an effect at `gate` with the effect ID loom assigned (`AttemptHost.effect`, `DurableEffects.prepare` with its token); loom commits it later with the current claim (`DurableEffects.commit` on `gate#loom`), and `gate` asks the broker for current authority (`authorizeEffect`) every time. The effect contract is §20.26.

**Labels.** The workflow label is a high-water mark kept by the broker (`BrokerWorkflow.raise`; the broker also raises it whenever an attempt session's label rises). loom stores every observation and result with its label; replayed observations keep their labels; `AttemptHost.task` returns the workflow label; a fresh attempt therefore never restarts at `public/trusted` after the workflow consumed more sensitive or less trusted data. The Rule of Two (§14.1) applies to workflow effects with the workflow label.

**Budgets.** Each workflow has one budget account (`ba-`) with the enrollment's ceilings, held by `gate` independently of token roots. Attempt tokens carry `budget_account`, so metered spending is charged to the account whatever root the attempt holds; new roots never reset spent amounts. Reservations are keyed (`reserve`, `settle`, `release` are idempotent per key): `gate` uses `<wa-…>:<request number>` for metered requests, loom and aide derive keys from step and observation keys. A reservation of an attempt that was fenced before settling is settled as `unresolved` (still counted against the ceiling) until the actual charge is known; a key is settled at most once with a final amount, so a duplicated completion message never double-charges. The account is closed when the workflow is terminal.

**Recorded observations and replay.** Orchestration is deterministic: the next state depends only on the definition and on recorded outcomes, results, signals and timer firings. Every non-deterministic observation that can influence a later decision (model responses, tool results, clock readings, randomness) is recorded through `AttemptHost.record` before the activity uses it. A later attempt of the same step obtains recorded observations by key (`AttemptHost.recorded`) instead of asking a model or tool again; it calls live only past the last recorded key. Observation keys are `<kind>:<n>` with a per-kind counter that starts at 0 in every step and counts in the order the activity makes the observations, so a deterministic replay reaches the same keys. An activity whose result was never recorded is retried, reconciled or reported per its declared semantics (§20.27); it is never treated as completed because it probably ran.

**Durability.** loom acknowledges an enrollment, transition, observation, result, signal, cancel or forget only after its SQLite transaction (WAL, `synchronous=FULL`) committed, every blob it references was written with `O_TMPFILE`, `fsync`ed, linked and its directory `fsync`ed, and, where a receipt is required, after the receipt is acknowledged. A failed `fsync`, a full disk or any other barrier failure aborts the transaction and is reported `kl:unavailable`; after an `fsync` failure the store is reopened and verified before the next write. A state transition and the messages it causes (claims, effect commits, receipts) are committed in the same transaction as outbox rows and delivered afterwards with stable IDs; deliveries are deduplicated by those IDs on the receiving side.

**Receipt outbox.** loom writes `workflow.*` receipts (§19.3) with `subject` = the principal that enrolled the workflow and `data` = `{workflow, run, n, …}` holding only IDs, states, epochs, digests and reason codes, never inputs, results or model and tool content; `n` is the per-workflow event number and (`workflow`, `n`) the stable logical event ID. Each receipt is an outbox row committed with its transition. Delivery: loom builds and signs the submitted form, persists its `time` and submitted-form digest in the row, then calls `Ledger.append`; on success it records the returned `seq`. A `re-sign` refusal (§13.1) is answered by persisting a new submitted form and resubmitting. **Reconciliation** after a restart: loom first appends `workflow.recover` (subject: loom itself) with a `time` later than every outstanding submission's `time`; once it is acknowledged, no outstanding submission can be appended any more (§13.1 time order), and each is settled by searching its submitted-form digest among loom's receipts after the last acknowledged `seq` (`Ledger.query`, `principalPrefix "service:loom:"`, §7.3.5): found → acknowledged with that `seq`; not found → it was never appended, and loom submits it again as a new submitted form. Each logical event therefore produces at most one receipt, and at least one once the ledger is reachable. The ledger itself never deduplicates; a coordinator+ledger atomic transaction is not claimed.

**Rollback detection.** loom's store records the ledger `seq` of its newest acknowledged receipt. After `workflow.recover` is acknowledged, every loom receipt between that `seq` and the recovery receipt must be an outstanding submission of the store; any other one, a store that is behind the ledger, or a ledger that is behind the store (an alarm epoch, §13.3) means an older store was restored. loom then writes `workflow.rollback-detected`, pauses every workflow (`rollback-review`) and re-applies the authoritative records: `workflow.cancel` and `workflow.forget` receipts after its anchor (their `refs` stay readable after shredding, §13.4) become tombstones; the broker's workflow records give the current epoch and cancellation state; `gate`'s effect records and budget accounts give effect outcomes and spent amounts; a workflow whose history the store no longer has becomes `failed` with `history-lost`, never restarted. Dispatch resumes only after the owner accepts with `loom rollback accept` (presence purpose `loom.rollback-accept`, §20.2). The broker's workflow and decision records and `gate`'s effect records and budget accounts are anchored the same way against their own receipts (`principalPrefix "service:broker:"`, `"service:gate:"`). The anchor rests on the ledger's own rollback protection (NV counter `0x01300100`, §13.3); no further NV index is used. Restoring an older store therefore cannot resurrect cancelled work, reset budgets or repeat effects; restoring the whole disk image is detected by the ledger's counter and leads to the same review.

**Cancellation.** `Workflow.cancel`: (1) loom commits a `cancelling` tombstone; (2) `BrokerWorkflow.cancel` writes the broker's durable cancellation record, revokes every root carrying the workflow fact and cancels the workflow's pending decisions; (3) loom terminates attempts (`Process.kill`, `AgentWorkflowHost.stopAttempt(…, "cancel")`), cancels prepared and awaiting effects (`DurableEffects.cancel`) and drops timers; (4) after `workflow.cancel` is acknowledged, `cancel` returns. Step 2 needs the subject's live session (the broker evaluates Cedar `cancel` for it). If loom restarts between steps 1 and 2 and that session no longer exists, the workflow stays non-runnable (the `cancelling` tombstone allows no claims and no attempts) and loom completes steps 2–4 when the broker's record shows the cancellation or when the owner calls `cancel` again; it never resumes the workflow. Effects already authorized or dispatched are not undone by cancellation: loom keeps resolving their outcomes (lookup, reconciliation) and records them. Cancellation runs no further workflow logic; compensation is a new authorized effect, run before cancelling through the definition's `abort` signal (§20.27). Recovery never re-enrolls a cancelled workflow: its tombstone, the broker's record and the ledger evidence each refuse it.

**Forgetting.** `Workflow.forget` cancels the workflow if it is not terminal, commits a `forgotten` tombstone, then destroys every copy of its private history: `vault.forget("loom:<owner>:<wf-…>")`, `DurableEffects.forget` (gate shreds the workflow's payload unit `gate:<owner>:<wf-…>`), discard of retained prepared merges, removal of `aide`'s attempt units and `Depot.unroot`. loom evicts cached keys and plaintext, and re-checks the tombstone after every asynchronous key or blob fetch before caching or delivering the result. What remains: loom's tombstone (`wf-`, run IDs, owner, terminal kind, time), the broker's cancellation record, `gate`'s minimal effect records (§20.26) and the ledger's ID-only receipts, which suffice to prevent recreation and contain no private data. Cryptographic erasure completes as the vault reports it (vault rotation). History that is deleted or expired is reported as `forgotten` or `history-lost`, never silently restarted.

**Owner lock.** Key wrapping does not decide execution: `loom:` units are wrapped under the vault's system key, so loom can keep recording outcomes of in-flight operations while the owner is locked. Execution follows an explicit lock policy: a workflow owned by a human pauses (`paused`, `locked`) while that human is locked (`HearthSystem.userState`: no authenticated, unlocked login session; logged out counts as locked), unless it was enrolled with `runWhileLocked` (presence-approved). While paused by the lock, loom makes no claims, dispatches nothing and decrypts no history for execution; overdue timers wait. When hearth is unreachable loom assumes the owner is locked. Workflows of `_system` never pause for a lock. When hearth reports a user deleted (`watchUsers`, `deleted`), loom forgets every workflow of that user.

**Restart and reboot.** At start loom runs the receipt reconciliation and the rollback check, then for each non-terminal workflow reads the broker's record (cancelled → finish the cancellation), looks up every effect that is not settled (`DurableEffects.lookup`), and treats every attempt of the previous run of loom as ended (its sessions are gone or fenced). A workflow with `resume = manual` becomes `paused` (`awaiting-resume`) until its owner calls `Workflow.resume` (Cedar `resume`); one with `resume = automatic` is claimed again without asking, still fully reauthorized by the broker. Steps whose activity result was not recorded continue per the activity's semantics (§20.27).

**Timers, signals and time.** Timers are stored rows; a timer fires only when trusted time (§3.6) has reached its due time, never early; while the clock is not trusted loom uses `max(now, time floor)` and pauses timer-driven work whose due time lies beyond the floor (`time-untrusted`). Decision expiry, horizons and deadlines are checked against trusted time. After a long downtime overdue work is caught up in due order at most `catchUpPerMinute` (default 6) claims per minute, a periodic timer fires once rather than once per missed period, and every overdue item re-checks cancellation, pause, lock, budget and horizon first. Signals are recorded with the sender's label, deduplicated by (name, key); a workflow past its horizon is `blocked-by-authority` (`horizon`): the broker refuses its claims.

**Retention.** History is kept until the workflow is forgotten, or `historyRetentionDays` (default 30) after it became terminal, when loom forgets it automatically. Decision records live until 30 days after the workflow is terminal; effect dedup records per §20.26; tombstones are never deleted. Replay retention is independent of the ledger's monthly audit retention: shredding a receipt month never removes history a live workflow needs, and forgetting a workflow leaves no decryptable copy of its history in any receipt.

### A.49 `protocols §20.26` — Effect executor contract

Every workflow effect is a **durable effect record** in `gate` (`DurableEffects`, §7.5.25), owned by its workflow and identified by its effect ID, independent of the attempt sessions that prepare, authorize or observe it. Ordinary intents (§7.3.7) keep their own rules; a durable effect is also an outbox intent (`EffectRecord.intent`) and appears in `Gate.intents` of the preparing session.

**States.** `prepared` → (`awaitingApproval` →) `authorized` → `dispatching` → `succeeded` | `failed` | `outcomeUnknown`; `prepared` and `awaitingApproval` → `cancelled`; `succeeded` → `compensated` (compensable kinds). `authorized` means only that the effect may be performed now: it is recorded by `effect.commit` and is never reported as completion. Only `succeeded` and `failed` are confirmed outcomes (receipt `effect.complete`); `outcomeUnknown` (receipt `effect.unknown`) is an explicit state, not a failure. For caller-executed kinds (§14.2) gate moves the record to `authorized` and returns the mandate; the executor's own completion receipt, presented through `DurableEffects.complete`, is the authenticated outcome that moves it to `succeeded` or `failed`.

**Request digest.** `requestDigest` = SHA-256 of the JCS `{"effect", "workflow", "kind", "class", "target", "args": [{"name", "value", "source", "label": {"conf", "integ"}}…] (sorted by name, without `x-subject-token`), "payloadDigest", "compensator"}` (class and label values as their enumerant names; `compensator` `null` when empty). It binds the effect ID to exactly one request: `prepare` with an existing effect ID and an equal digest returns the existing record; with another digest it fails `kl:conflict`, so a payload can never change under an existing effect ID. The mandate binds the payload digest (§14.4) and `constraints.workflow` the workflow.

**Authorization at commit.** `DurableEffects.commit` (facet `loom`) requires the binding to be the workflow's current claim, then calls `BrokerWorkflow.authorizeEffect` with the record's kind, target, payload digest and gate's required renderings. The broker revalidates the workflow record (not cancelled, not past its horizon), the owner's eligibility, current policy and revocation, the Rule of Two with the workflow label, and the budget; it answers approved (no approval needed) or with the durable decision of key `effect:<fx-…>`. The record waits in `awaitingApproval` (`decision`) until the decision is approved; loom observes the decision only through `commit` and re-issues `DurableEffects.commit` with its current claim at its poll interval (and with a fresh claim after a restart) while the record waits (gate answers from its record, the broker returns the existing decision; `DurableEffects.watch` is optional). A denied or expired decision, or a policy denial by `authorizeEffect`, moves the record to `cancelled` with outcome `{"reason": "decision-denied" | "decision-expired" | "policy-denied"}`, which loom reports as the commit outcome `denied`; any other `cancelled` record is the commit outcome `cancelled`. Once the decision is approved, gate verifies the delivered mandate (§14.4, `constraints.workflow`, payload digest, expiry) and consumes it: the transition to `authorized`, the mandate's single use and the effect ID are committed atomically, so a decision is consumed at most once and an effect ID is authorized at most once.

**Retry strategies.** Every executor declares exactly one strategy for every (kind, target) it executes; gate records it at `prepare` and never changes it for an existing record. A missing or unverifiable declaration is `noSafeRetry`.

| Strategy | Requirement on the executor | After a crash or a lost reply in `dispatching` |
|---|---|---|
| `transactional` | The operation and its completion record commit atomically inside the executing service, keyed by a stable ID (for `fs.merge`: the prepared merge and its `PreparedMerge.status`, `BenchMerge.commitPrepared`) | Look up the completion record: present → its outcome; absent → the operation did not happen and may be dispatched again under the same effect ID |
| `downstreamIdempotency` | The destination enforces the effect ID as key together with payload identity for a documented window W; gate's configuration MUST declare that destination `verified` with W. Sending an `Idempotency-Key` header alone is not proof | Re-send with the same key while now < `dedupUntil` (first dispatch + W); afterwards → `outcomeUnknown`, never a blind repeat |
| `reconciliation` | A registered reconciler queries authoritative destination state by the effect ID or the payload digest (for example the remote ref equals the pushed commit); a view that is only eventually consistent, or absence from a sent folder, is never proof of non-execution | `present` → `succeeded`; authoritative `absent` → may dispatch again; anything else → `outcomeUnknown` |
| `noSafeRetry` | none | → `outcomeUnknown` |

Retries reuse the effect ID; a retry never happens after the record left `dispatching` for a confirmed outcome, and a record in `outcomeUnknown` is never dispatched again automatically, whatever the strategy, after its window expired.

**Resolving an unknown outcome.** `outcomeUnknown` ends only by reconciliation (`DurableEffects.reconcile`) or by the owner (`Workflow.resolve` → `DurableEffects.resolve` with a `workflow.decide` mandate bound to the record; presence for irreversible kinds). The resolution mandate's effect is `{"kind": "workflow.decide", "target": "<fx-…>", "digest": "sha256:" + SHA-256(JCS({"effect": "<fx-…>", "outcome": "succeeded" | "failed"}))}`. The owner's resolution records `succeeded` or `failed`; it never re-dispatches the effect ID. Repeating the operation needs a new step occurrence and therefore a new effect ID, with its own authorization.

**Cancellation and compensation.** `DurableEffects.cancel` cancels a `prepared` or `awaitingApproval` record (and its pending decision); from `authorized` on the record cannot be cancelled and its outcome is settled as above. Compensation of a succeeded effect is `Intent.compensate` for its intent where a compensator is registered, or a new effect with its own effect ID; neither is a rollback guarantee.

**Dedup retention.** Retention is part of correctness. gate keeps every record (effect ID, workflow, request and payload digests, strategy, state, outcome, receipts, `dedupUntil`) at least until the latest of: the workflow's horizon (from the broker's record), `dedupUntil`, and 30 days after the record reached a terminal state; a record that is not terminal is never deleted. Payload blobs are kept until the record is terminal plus 7 days, or until the workflow is forgotten (`DurableEffects.forget`), which shreds them and keeps the minimal record. A workflow never runs past its horizon (the broker refuses its claims), so no workflow can re-request an effect ID whose record was deleted.

**Executors behind gate.** gate's kind registry declares the strategy per executor: `BenchMerge.commitPrepared` (`fs.merge`) is `transactional`; HTTP replay is `downstreamIdempotency` only for destinations configured as `verified`, otherwise `reconciliation` where a reconciler is registered (`git.push`: the remote ref; `git.pr.open`: a search by head branch and the effect ID in the body), otherwise `noSafeRetry`; SMTP is `reconciliation` only with an IMAP rule whose provider is configured as strongly consistent, otherwise `noSafeRetry`; `net.listen` is `transactional`; caller-executed kinds are `noSafeRetry` unless the executor documents a completion lookup.
