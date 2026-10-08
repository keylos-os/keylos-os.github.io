# warden

> PID 1 and the supervisor. warden is the only process that creates namespaces, allocates principal UIDs and cgroups, and wires capwire sockets between principals.
> Every process on the host starts through `Supervisor.spawn` and receives exactly the fds, tokens and routes its spec lists. Nothing else is inherited.

**Status:** specified (v1.0) · **Spec:** [`warden/spec.md`](../../specs/warden/spec.md)

## Responsibilities

- Take over from the initrd ([boot](boot.md)), mount the runtime filesystems and start tier-0 services in dependency order.
- Spawn every principal from a launchable generation:
  - mount its view from [depot](depot.md);
  - build mount, pid, ipc, uts, cgroup and (usually) net namespaces **without a user namespace**;
  - apply the Landlock and seccomp baseline;
  - allocate a dynamic UID and a cgroup;
  - pass fds and tokens.
- Build user-namespace views only for the legacy tier, with nesting disabled.
- Route capwire connections: create socket pairs between principals according to manifest routes and policy, and record the facet for each connection.
- Name the peer of every connection it creates in `ServiceHost.accept`, and answer `connectionInfo`; `Supervisor.identify` maps pidfds of processes to principals (never a socket's peer pidfd).
- Service lifecycle: start, stop, restart, reload, restart policies, health, boot counting hand-off to [courier](courier.md).
- Capture stdout/stderr into [journal](journal.md) streams.
- Produce confinement reports (`Process.confinement`, protocols §9.4).
- Load `kl-label`, the BPF LSM that enforces directory grant ceilings from the `security.bpf.keylos.label` xattr.
- Supervise without ptrace access: warden is subject to `kl-exec`'s `ptrace_access_check` like every task, so it uses pidfds and the namespace fds each child sends at spawn, never `/proc/<pid>/ns/*` ([ADR-0069](../11-decisions/adr-0069-s3-execution-core-contract-fixes.md)).

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Supervisor`, `Process` (`warden.capnp`) | Facets `client`, `service`, `admin`; `Process.freeze`/`thaw`, cgroup-wide `signal` |
| Provides | `warden-sys` | `Bootstrap`/`ServiceHost` hand-off, `GrantMounts`, `PrincipalControl`, `ServiceConnect`, `FdStore`, `LegacySpawn`, `UserSpawn`, `TrustedSpawn` |
| Consumes | `kl-exec` maps (fds 3–7 from boot), the boot report (fd 8) and the hook links (fds 9–18) | Registers superblocks of verified generations; keeps the links open so `kl-exec` stays attached |
| Consumes | depot (facet `mounter`) | composefs fsmount fds with `verity=require` |
| Consumes | broker `BrokerSystem.registerSession`/`sessionEnded` (facet `system`) | Grants and labels at spawn |
| Consumes | strata (facet `warden`) | `mountUnit`; transaction views for `SpawnSpec.transaction` |
| Consumes | journal `JournalWarden` (facet `warden`) | Log streams |
| Consumes | net `NetPlumbing` (facet `plumbing`), ledger `timeFloor` (facet `time`) | Egress and local-link UIDs; time floor |
| Consumes | ledger (facet `writer`) | Receipts |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| warden | `client` | every principal | `Supervisor.spawn` (child of caller's session), `identify` |
| warden | `service` | tier-0 services | `Supervisor.spawn`, `identify`, `connectionInfo`; `FdStore`. `SpawnSpec.attempt` only from `loom` |
| warden | `admin` | owner `shell`, config, courier, devd, atrium | all `Supervisor` (including `control("_system", poweroff\ |
| warden | `broker` | broker | `GrantMounts`, `PrincipalControl`, `ServiceConnect`, `DebugAttach` |
| warden | `compat` | compat | `LegacySpawn`; `GrantMounts.idmappedDir`; `Supervisor.spawn` (compat generation entrypoints only) |
| warden | `bench` | bench | `VmSpawn` (VM principals; `spawnVmm` for per-VM `crosvm` device processes, `bench-net` wired to `gate#shim`, `bench-relay` wired to `aide#host`, `broker#principal`, `vault#app` and `portal-*#default`); `GrantMounts.idmappedDir` |
| warden | `strata` | strata | `PrincipalControl.events`, `mountView`, `fenceWriters` (`WriterFence`) |
| warden | `hearth` | hearth | `PrincipalControl.terminate` (sessions of the locking human) |
| warden | `portals` | portal-files, portal-openuri | `GrantMounts.attachGrant`/`detachGrant` for portal-island grants and single-file views (§7.3.3) |
| warden | `launcher` | atrium launcher | `UserSpawn` |
| warden | `handler` | portal-openuri, portal-notify, portal-background | `UserSpawn` |
| warden | `trusted-terminal` | atrium-term | `TrustedSpawn` |
| warden | `cri` | cri | `PodSpawn`; `GrantMounts.idmappedDir`; `PrincipalControl.terminate`/`events` (pod sessions only) |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`warden-sys.capnp`](../../specs/protocols/spec.md#751-warden-syscapnp) | `0xc7a1e5d3b2f40020` | `Bootstrap`, `ServiceHost`, `GrantMounts`, `PrincipalControl`, `ServiceConnect`, `FdStore`, `LegacySpawn`, `UserSpawn`, `TrustedSpawn`, `DebugAttach`, `PodSpawn`, `VmSpawn` |
<!-- /generated:sysif -->

## Runs as

| Property | Value |
|---|---|
| Tier | Kernel-adjacent; PID 1 with UID 0 |
| Privileges | Full. It is the reason no other userspace process needs root. |
| Confinement | Its own seccomp filter (denies module loading, kexec, bpf except signed loaders). Kept small and fuzzed. |

## State

| Path | Content |
|---|---|
| `/run/keylos/svc/<service>/` | Service sockets (mode 0700, warden UID) |
| `/run/keylos/warden/` | UID allocation table, running principal registry |
| cgroup tree | `/keylos.slice/...` per protocols §10.3 |

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `boot`, `shutdown`, `spawn`, `exit`, `debug.attach`, `debug.detach`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Key behaviours

| Topic | Rule |
|---|---|
| UIDs | Dynamic principal UIDs from `0x00100000–0x0FFEFFFF` (`0x0FFF0000` is the reserved on-disk owner of `_cluster` data), quarantined 60 s after release; legacy blocks from `0x10000000` |
| Feature levels | Probes KL1–KL3 and records compensations, for example `udp-via-netns` on KL1/KL2 |
| Environment | Sets `KEYLOS_PRINCIPAL`, `KEYLOS_SESSION`, `KEYLOS_TIER`, `KEYLOS_CAPWIRE_FDS` and XDG paths. Rejects secret-like variables. |
| Terminals | `setsid` + `TIOCSCTTY` only for a given pty. `TIOCSTI` disabled system-wide. |

## Key decisions

- [ADR-0023: No root, no setuid](../11-decisions/adr-0023-no-root-no-setuid.md)
- [ADR-0024: Dynamic UIDs per principal](../11-decisions/adr-0024-dynamic-uids-per-principal.md)
- [ADR-0025: Namespaces only by warden](../11-decisions/adr-0025-namespaces-only-by-warden.md)
- [ADR-0004: capwire, no system bus](../11-decisions/adr-0004-capwire-no-system-bus.md)

## Related

- [Process tree and tiers](../02-architecture/process-tree-and-tiers.md)
- [Confinement tiers](../06-security/confinement-tiers.md)
- [Namespaces](../06-security/namespaces.md)
- [Capwire](../04-contracts/capwire.md)
