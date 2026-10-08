# Repository catalogue

> Every repository of the keylos organisation: its layer, where it runs, the interfaces it serves and uses, and its specification.
> All repositories are Rust unless noted, depend on `keylos-protocols` 1.x, and are specified (v1.0).

## On-machine components

| Repo | Layer | Runs as | Serves (protocols §7.3) | Uses | Spec |
|---|---|---|---|---|---|
| warden | Execution | PID 1, UID 0 | `Supervisor`, `Process` | `Depot`, `Broker`, `Ledger` | [spec](../../specs/warden/spec.md) |
| boot | Boot | initrd (UKI) | — (initrd program, UKI layout) | `Depot` (boot facet), TPM, LUKS2 | [spec](../../specs/boot/spec.md) |
| courier | Boot | t0 service | `Courier` | `Depot`, `Ledger`, `TrustedPrompt`, TUF, tlog | [spec](../../specs/courier/spec.md) |
| broker | Authority | t0 service | `Broker`, `Approval` | `TrustedPrompt`, `Ledger`, `Supervisor`, portals | [spec](../../specs/broker/spec.md) |
| ledger | Authority | t0 service | `Ledger` | TPM NV counter, journal | [spec](../../specs/ledger/spec.md) |
| vault | Authority | t0 service | `Vault` | `Ledger`, TPM, `TrustedPrompt` | [spec](../../specs/vault/spec.md) |
| hearth | Identity | t0 service | `Hearth` | `Ledger`, `TrustedPrompt`, FIDO2 devices via `Devd` | [spec](../../specs/hearth/spec.md) |
| gate | Effects | t0 service | `Gate`, `Intent` | `Broker`, `Vault`, `Ledger`, `Net` | [spec](../../specs/gate/spec.md) |
| net | Networking | t0 service | `Net` | `Vault`, `Ledger`; iwd (confined) | [spec](../../specs/net/spec.md) |
| aide | Agents | t0 service | `Aide`, `AgentSession`, `AgentHost` | `Bench`, `Gate`, `Broker`, `Strata`, `Depot`, `Ledger` | [spec](../../specs/aide/spec.md) |
| loom | Orchestration | t0 service | `Loom`, `Workflow`, `AttemptHost`, `LoomSystem` | `BrokerWorkflow`, `DurableEffects`, `WorkflowBudget`, `AgentWorkflowHost`, `Vault`, `Ledger`, `HearthSystem`, `Depot`, `Supervisor` | [spec](../../specs/loom/spec.md) |
| depot | Store | t0 service | `Depot` | `Ledger`, `TrustedPrompt`, tlog client | [spec](../../specs/depot/spec.md) |
| strata | State | t0 service | `Strata`, `Transaction` | `Vault`, `Ledger`, `Supervisor` | [spec](../../specs/strata/spec.md) |
| config | State | t0 service | `Config`, `Plan` | `Hearth`, `Depot`, `TrustedPrompt`, `Ledger` | [spec](../../specs/config/spec.md) |
| kish | Experience | t1 (shell principal) | — (shell; implements cmdsig pipes) | `Supervisor`, `Broker`, `Strata`, `Aide`, `Ledger` | [spec](../../specs/kish/spec.md) |
| atrium | Experience | t0 service (compositor) | `TrustedPrompt`; Wayland | `Hearth`, `Broker`, `Supervisor` | [spec](../../specs/atrium/spec.md) |
| portals | Experience | t0 services (`portal-*`) | `ScreenCapture`, `Camera`, `Microphone`, `OpenUri`, `Notify`, `Print`, `Clipboard`, `Location`, `Accessibility` | `Broker`, `Devd`, `TrustedPrompt` | [spec](../../specs/portals/spec.md) |
| bench | Execution | t0 service + confined crosvm | `Bench`, `Vm` | `Supervisor`, `Depot`, `Strata`, `Gate` | [spec](../../specs/bench/spec.md) |
| compat | Execution | t0 service | `Compat` | `Supervisor`, `Depot`, `Broker` | [spec](../../specs/compat/spec.md) |
| cri | Execution | t0 service (`server-k8s`, `network: host`) | CRI v1 gRPC (facet `kubelet`); `CriAdmin` | `Bench`, `PodSpawn`, `BrokerSystem.admitPod`, `Depot`, `StrataVolumes`, `NetPlumbingCluster`, `MediaAttach`, `FleetCluster` | [spec](../../specs/cri/spec.md) |
| devd | Hardware | t0 service | `Devd` | `Broker`, `Ledger` | [spec](../../specs/devd/spec.md) |
| journal | Operations | t0 service | `Journal` | — | [spec](../../specs/journal/spec.md) |

## Contracts and supply chain

| Repo | Layer | Produces | Spec |
|---|---|---|---|
| protocols | Contracts | Crates `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-biscuit`, `keylos-labels`; `.capnp` schemas; JSON Schemas; conformance vectors | [spec](../../specs/protocols/spec.md) |
| forge | Supply chain | Hermetic builder, rebuilder mode, realisation attestations, lockfile translators | [spec](../../specs/forge/spec.md) |
| tlog | Supply chain | Log server (C2SP tlog-tiles), witness, client verification library | [spec](../../specs/tlog/spec.md) |
| pkgs | Supply chain | Recipes (Nickel) for the whole distribution, including patched interpreters | [spec](../../specs/pkgs/spec.md) |
| keylos | Distribution | Kernel configuration, image assembly, profiles, default policy, release engineering, conformance suite | [spec](../../specs/keylos/spec.md) |

## Developers and operations

| Repo | Layer | Produces | Spec |
|---|---|---|---|
| sdk | Developers | Manifest and cmdsig tooling, capwire client helpers, packaging and signing, a local test harness | [spec](../../specs/sdk/spec.md) |
| installer | Operations | Installer, first-boot enrolment ceremony, recovery environment | [spec](../../specs/installer/spec.md) |
| fleet | Operations | Organisation policy distribution, attestation verifier, witness | [spec](../../specs/fleet/spec.md) |
| vouch | Operations | Phone app (Android and iOS) for verify-before-unlock, checkpoint witnessing and remote approvals; not Rust-only (Kotlin/Swift UI on a Rust core) | [spec](../../specs/vouch/spec.md) |

## Reused upstream components

keylos reuses mature upstream components where they are the reference implementation. Each runs confined.

| Component | Used by | Confinement |
|---|---|---|
| Linux kernel | everything | — (TCB) |
| systemd-boot, systemd-stub, systemd-measure/pcrlock formats | boot, courier | Boot-time only; predictions computed at build and update time |
| libcryptsetup (LUKS2) | boot | initrd only |
| crosvm | bench | Per-device sandboxed processes |
| Smithay | atrium | Library inside atrium |
| iwd | net | t0 with a dedicated policy |
| BlueZ, PipeWire, CUPS | devd, portals | D-Bus islands and t0 policies |
| Mesa | apps, bench | Inside each app's confinement |
| ntpd-rs (NTS) | net | Library or t0 |
| rustls, capnp-rust, biscuit-auth, cedar-policy, Nickel | many | Libraries |

## Related

- [Repository index](repo-catalogue.md)
- [System context and layers](../02-architecture/system-context-and-layers.md)
- [Dependency rules](../02-architecture/dependency-rules.md)
- [Components](../03-components/README.md)
