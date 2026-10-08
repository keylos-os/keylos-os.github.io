# System interfaces

> System interfaces are the contracts that tier-0 services, plus a few privileged components such as atrium, use with each other: process control, grant mounts, label authority, seal windows, transactions, device administration and the other plumbing behind the public interfaces.
> They live in 22 canonical schema files in protocols §7.5. No repository defines a cross-repo interface of its own.

**Status:** specified (v1.0) · **Normative source:** [protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)

## How a component reaches one

A system interface is obtained in one of two ways:

| Way | Example |
|---|---|
| As the bootstrap capability of a route whose facet names it as primary | broker's route `warden#broker` exposes `GrantMounts`, `PrincipalControl`, `ServiceConnect` |
| Through `Extensible.ext(interfaceId)` on a service's bootstrap capability | aide calls `ext(AgentHostExt)` on the `AgentHost` connection |

The facet registry ([Registries](registries.md), [protocols §19.2](../../specs/protocols/spec.md#192-facets)) decides which facet may obtain which interface. Asking for anything else returns `kl:denied`.

## The files

| File | File ID | Interfaces | Server | Typical callers |
|---|---|---|---|---|
| `warden-sys.capnp` | `0xc7a1e5d3b2f40020` | `Bootstrap`, `ServiceHost`, `GrantMounts`, `PrincipalControl`, `ServiceConnect`, `FdStore`, `LegacySpawn`, `UserSpawn`, `TrustedSpawn` | warden (`ServiceHost`: every service) | broker, compat, bench, strata, hearth, portals, atrium |
| `broker-sys.capnp` | `0xc7a1e5d3b2f40021` | `BrokerSystem`, `LabelAuthority` | broker | warden, gate, aide, atrium, config, hearth, strata, net, bench, portals |
| `hearth-sys.capnp` | `0xc7a1e5d3b2f40022` | `HearthSystem`, `HearthSeal`, `HearthAdmin` | hearth | warden, devd, config, broker, depot, forge |
| `vault-sys.capnp` | `0xc7a1e5d3b2f40023` | `VaultUsers` | vault | hearth |
| `ledger-sys.capnp` | `0xc7a1e5d3b2f40024` | `LedgerWitness`, `LedgerAdmin` | ledger | vouch, fleet, owner shell; net and warden (`timeFloor`) |
| `courier-sys.capnp` | `0xc7a1e5d3b2f40025` | `CourierResolver` | courier | depot |
| `strata-sys.capnp` | `0xc7a1e5d3b2f40026` | `StrataTxn`, `TransactionExt`, `StrataAdmin`, `StrataHomes` | strata | warden, bench, aide, kish, hearth, courier |
| `devd-sys.capnp` | `0xc7a1e5d3b2f40027` | `DeviceAdmin`, `PowerEvents`, `Bluetooth`, `Backlight` | devd | warden, broker, hearth, strata, atrium |
| `journal-sys.capnp` | `0xc7a1e5d3b2f40028` | `JournalWarden`, `Crashes`, `Metrics` | journal | warden, owner shell, fleet |
| `bench-sys.capnp` | `0xc7a1e5d3b2f40029` | `BenchMerge`, `GrantDelegate` | bench (`GrantDelegate`: aide) | gate, aide, bench |
| `net-sys.capnp` | `0xc7a1e5d3b2f4002a` | `NetWatch`, `NetResolver`, `NetPlumbing`, `NetCaptive` | net | gate, warden, atrium, bench |
| `gate-sys.capnp` | `0xc7a1e5d3b2f4002b` | `ShimEndpoint` | gate | per-principal shims: tier L (warden) and `bench-net` per VM |
| `aide-sys.capnp` | `0xc7a1e5d3b2f4002c` | `AgentHostExt`, `VmExec` | aide | harnesses inside agent VMs |
| `config-sys.capnp` | `0xc7a1e5d3b2f4002d` | `ConfigFleet` | config | fleet |
| `compat-sys.capnp` | `0xc7a1e5d3b2f4002e` | `CompatIsland` | compat | devd (BlueZ), portal-print (CUPS), vault (imports) |
| `display.capnp` | `0xc7a1e5d3b2f4002f` | `Display` | atrium | warden, bench, compat |
| `a11y.capnp` | `0xc7a1e5d3b2f40030` | `A11yApp`, `A11yHost`, `A11yObserver` | atrium | a11y bridge, AccessKit apps, assistive principals |
| `screencast.capnp` | `0xc7a1e5d3b2f40031` | `Screencast`, `ShortcutsHost`, `IndicatorHost` | atrium | portal-screen, portal-shortcuts, sensor portals |
| `picker.capnp` | `0xc7a1e5d3b2f40032` | `FilePicker` | portal-files | broker (`pick`), atrium (`confirmDrop`) |
| `portals-extra.capnp` | `0xc7a1e5d3b2f40033` | `Background`, `GlobalShortcuts`, `Inhibit` | portal-background, portal-shortcuts, portal-inhibit | apps |
| `fleet-sys.capnp` | `0xc7a1e5d3b2f40034` | `FleetCompliance`, `OrgDecider` | fleet | gate, broker |
| `vouch-sys.capnp` | `0xc7a1e5d3b2f40035` | `VouchLink` | vouch (machine-side `vouchd`) | atrium, courier |

## The important ones

| Interface | What it makes possible |
|---|---|
| `ServiceHost.accept` | warden hands every new connection to a service together with the peer's principal, tier, generation and facet. Services never `accept()` on their own sockets |
| `GrantMounts.attachGrant` | Runtime directory grants. A Landlock domain can't be widened after it's applied, so warden bind-mounts the granted tree, idmapped to the holder's dynamic UID, at `/grants/<name>` in the holder's mount namespace |
| `PrincipalControl.terminate` | Revocation: kill, freeze or thaw a session and all its descendants, because fds already handed out can't be pulled back |
| `LegacySpawn.spawnLegacy` | A legacy process in a user namespace with a 65 536-UID block, returning the seccomp-notify listener to compat's open broker |
| `TrustedSpawn.spawnTerminal` | The human's trusted terminal: the only process tree without `SECBIT_EXEC_DENY_INTERACTIVE` |
| `BrokerSystem.requestFor` | gate asks for an approval on behalf of the session that staged an intent, and gets the `GrantResult` including the signed mandate |
| `BrokerSystem.checkFlow` | Rule-of-Two check at stage, commit and connect, accepting a flow proof where policy allows |
| `LabelAuthority.raiseFor` | Services that hand data from one principal to another raise the receiver's label **before** the hand-off |
| `HearthSeal.openWindow` / `sealSign` | A presence-authorised sealing window of at most 600 s, and seal signatures by the owner-seal TPM key |
| `CourierResolver.resolve` | courier, the only TUF client, turns `tuf:<stream>/<name>` into an OCI reference, expected generation, attestations and generation statement for depot |
| `StrataTxn.txnExt` | A transaction's views, which warden mounts into a process spawned with `SpawnSpec.transaction` |
| `BenchMerge.commitShare` | gate merges an agent overlay only if the snapshot's changes hash to the digest the mandate binds |
| `ShimEndpoint.connect` | Tier-L shims and `bench-net` turn every outbound flow into a policy-checked gate connection |

## Rules

- A repository MAY define repo-local interfaces used only by its own binaries. Their file IDs MUST lie outside `0xc7a1e5d3b2f4xxxx`. Anything another repository consumes belongs in protocols.
- New system interfaces are added in a protocols minor release with the next free file ID.
- A system interface is never reachable from tier-1, tier-2, tier-3 or legacy principals unless the facet registry lists them.

## Related

- [Registries](registries.md)
- [Capwire](capwire.md)
- [Dependency rules](../02-architecture/dependency-rules.md)
- [Components](../03-components/README.md)
- [ADR-0004: capwire, no system bus](../11-decisions/adr-0004-capwire-no-system-bus.md)
