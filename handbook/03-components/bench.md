# bench

> The microVM manager, built on crosvm. bench runs every piece of unsealed code: workbenches for development and agent sessions (tier 3), and VMs for untrusted apps (tier 2). VMs start from snapshots, fork cheaply, see only granted shares (with copy-on-write overlays where asked), reach the network only through [gate](gate.md), and display through a Wayland proxy with optional virtio-gpu native context.

**Status:** specified (v1.0) · **Spec:** [`bench/spec.md`](../../specs/bench/spec.md)

## Responsibilities

- **Images:** `bench-image` generations from [depot](depot.md), with a guest kernel and a guest agent.
- **VMs:**
  - `Bench.start(VmSpec)` sets vCPUs, memory, shares (virtio-fs with virtiofsd itself Landlocked), GPU, display and network tokens;
  - targets about 100–300 ms start from a snapshot.
- **Workbenches:** `Bench.project(dir)` reads `project.ncl`, then creates or attaches to the project VM with toolchains and caches.
- **Forks and snapshots:** `Vm.fork`, `Vm.snapshot`. Agent sessions are forks of the project workbench.
- **Changes and commit:** `Vm.changes` summarises overlay changes. `Vm.commit(share)` merges through a [strata](strata.md) transaction (T3 for agents). `Vm.discard` drops everything.
- **Exec:** `Vm.exec` returns a `Process`-compatible handle. `Vm.console` gives a pty.
- **Tier 2:** app VMs with a Wayland proxy to [atrium](atrium.md) and GPU native context where the host supports it.
- **Resources:** each VM in its own cgroup slice. Memory ballooning and free-page reporting.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Bench`, `Vm` (`bench.capnp`) | Facets `user`, `aide`, `compat`, `admin` |
| Provides | `BenchMerge` (`bench-sys`) | Facet `merge` (gate, aide) |
| Provides | Guest control on vsock 1024, bulk streams on 1025–1535 | capwire-vsock profile; `benchd` in the guest |
| Consumes | depot (facet `mounter`) | Bench images and read-only store mounts |
| Consumes | warden (facet `bench`) | `GrantMounts.idmappedDir`; spawning crosvm and its device processes |
| Consumes | gate `ShimEndpoint` (facet `shim`) | `bench-net`: every guest flow becomes one `connect` |
| Consumes | strata (facet `bench`) | Share overlays as transactions with `NetworkPolicy.deny` |
| Consumes | broker `LabelAuthority` | Labels raised on virtio-fs opens |
| Consumes | aide `GrantDelegate` | Grant requests from agent VMs |
| Consumes | atrium `Display` | Tier-2 and tier-3 windows (net starts captive-browser VMs through `bench#net`) |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| bench | `user` | kish, `work`, atrium, portal-files, forge | `project`, `start` (purposes workbench; build (forge only, `unsignedImageOk`); app (kish, atrium launcher: non-reproducible native apps at tier 2)), `snapshots`, `media` (atrium, portal-files), `reattach` (own VMs) |
| bench | `net` | net | `start` (purpose captive only), `Vm.info`, `Vm.stop` |
| bench | `aide` | aide | all (including `fork` with `ForkSpec`, `reattach`); VMs get actor kind `agent` |
| bench | `compat` | compat | `start` with `display=true` for tier-2 legacy apps |
| bench | `merge` | gate, aide | `BenchMerge` (`commitShare`, `commitPrepared`: gate only; `preparedStatus`: gate, aide) |
| bench | `cri` | cri | `start` (purpose pod), `reattach`, `Vm` (all, including `attachShare`/`detachShare`, `attachBlock`/`detachBlock`, `info`) |
| bench | `admin` | owner `shell`, config | all, bench-local admin |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`bench-sys.capnp`](../../specs/protocols/spec.md#7510-bench-syscapnp) | `0xc7a1e5d3b2f40029` | `BenchMerge`, `GrantDelegate`, `MediaBrowser`, `ExportCompletion`, `GuestPortals` |
<!-- /generated:sysif -->

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `vm.start`, `vm.stop`, `vm.snapshot`, `vm.fork`, `vm.commit`, `vm.discard`, `media.attach`, `media.eject`, `media.export`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Runs as

A t0 service holding `/dev/kvm`. Each crosvm instance and device process is sandboxed (crosvm's per-device minijail model plus the keylos baseline).

## Key decisions

- [ADR-0009: Unsealed code in workbenches](../11-decisions/adr-0009-unsealed-code-in-workbenches.md)
- [ADR-0010: crosvm as the single VMM](../11-decisions/adr-0010-crosvm-single-vmm.md)

## Limitations

- Without KVM, workbenches and tier-2 apps refuse to run.
- GPU native context depends on host driver support (AMD and Freedreno first; Intel later).

## Related

- [Sessions and workbenches](../07-agents/sessions-and-workbenches.md)
- [Developer workbench](../09-experience/developer-workbench.md)
- [Confinement tiers](../06-security/confinement-tiers.md)
