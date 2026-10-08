# Components

> keylos is made of 31 repositories. Each one is an independent project with its own normative `spec.md`, and the only thing they share is [protocols](protocols.md).
> This section has one page per component: its role, the interfaces it provides and uses, how it is confined, the state it owns and the receipts it writes.

All components are **specified (v1.0)**. The repository specs are normative. These pages summarise them at the contract level.

![Layers and components](../images/layers-and-components.svg)

## By layer

| Layer | Component | Role | Runs as |
|---|---|---|---|
| Contracts | [protocols](protocols.md) | Identifiers, capwire, every Cap'n Proto interface, signed formats, token vocabulary, Cedar schema, labels, effects, layout | Library (crates) |
| Boot | [boot](boot.md) | UKI layout, initrd, TPM2+PIN unlock, PCR15 volume identity, composefs mount, `kl-exec` load, verify-before-unlock | initrd (pre-PID 1) |
| Boot | [courier](courier.md) | TUF client, A/B staging, PCR prediction, boot counting, NV floor, firmware updates | t0 service |
| Execution | [warden](warden.md) | PID 1 and supervisor: spawn, namespaces, Landlock/seccomp, dynamic UIDs, cgroups, routes | PID 1 (UID 0) |
| Execution | [bench](bench.md) | crosvm microVM manager: workbenches, tier-2 app VMs, snapshots, forks, shares | t0 service |
| Execution | [compat](compat.md) | Legacy tier: FHS views, image import, open-broker, Xwayland, D-Bus islands | t0 service |
| Execution | [cri](cri.md) | Kubernetes container runtime: CRI v1 for kubelet, pod microVMs, sealed pods, admission, pod networking and volumes, attested join | t0 service (`server-k8s`) |
| Authority | [broker](broker.md) | Capability broker: Biscuit tokens, Cedar, powerbox, approvals, labels, Rule of Two, revocation | t0 service |
| Authority | [ledger](ledger.md) | Append-only signed receipt log with TPM-anchored checkpoints | t0 service |
| Authority | [vault](vault.md) | Secrets broker: per-item ACLs, memfd_secret delivery, signing, SSH agent, crypto-shred keys | t0 service |
| Identity | [hearth](hearth.md) | Users, homes, login, lock, FIDO2 owner presence, key enrolment | t0 service |
| Effects | [gate](gate.md) | Egress proxy, credential injection, effect outbox, mandates, metering | t0 service |
| Networking | [net](net.md) | Links, Wi-Fi, DNS, WireGuard, host firewall, NTS time | t0 service |
| Orchestration | [loom](loom.md) | Durable workflow coordinator: enrolled workflows, fresh attempts, durable decisions and effects, cancel and forget | t0 service |
| Agents | [aide](aide.md) | Agent sessions, templates, tool pinning, harness API, review and merge | t0 service |
| Store | [depot](depot.md) | Object store, composefs generations, install, capability diffs, GC, revocations | t0 service |
| Supply chain | [forge](forge.md) | Hermetic builder, recipes, source rules, lockfile translators, rebuilder mode | t0 service (builds in VMs) |
| Supply chain | [tlog](tlog.md) | C2SP transparency logs, witnesses, verification library | Server + library |
| Supply chain | [pkgs](pkgs.md) | Package recipe collection | Data (recipes) |
| State | [strata](strata.md) | Subvolumes, snapshots, transactions, crypto-shredding, provenance, backup | t0 service |
| State | [config](config.md) | Nickel configuration, schemas, confext generations, presence-signed apply | t0 service |
| Experience | [kish](kish.md) | Shell: typed pipes, fd powerbox, transactions | `shell` principal |
| Experience | [atrium](atrium.md) | Wayland compositor and desktop shell, trusted path | t0 service |
| Experience | [portals](portals.md) | fd-only portals: files, screen, camera, mic, print, clipboard, location, notify, a11y | t0 services |
| Hardware | [devd](devd.md) | Device manager: uevents, hwdb, device capabilities, power | t0 service |
| Operations | [journal](journal.md) | Structured logs, metrics, crash reports | t0 service |
| Developers | [sdk](sdk.md) | Manifests, cmdsig, capwire helpers, packaging, signing, test harness | Library + CLI |
| Operations | [installer](installer.md) | Installer, enrolment ceremony, recovery environment | Live image |
| Operations | [fleet](fleet.md) | Optional organisation management: policy, attestation, witnesses | Server + t0 agent |
| Operations | [vouch](vouch.md) | Phone companion: verify-before-unlock, witness, remote approvals | Mobile app |
| Distribution | [keylos](keylos.md) | Kernel config, image assembly, profiles, default policy, release engineering | Build repo |

## How components talk

- Every runtime interaction is a capwire call on a capability that [warden](warden.md) handed over at spawn, or one returned by an earlier call ([Capwire](../04-contracts/capwire.md)). There is no system bus.
- Authority is checked by [broker](broker.md) and turned into fds. Effects that leave the machine pass through [gate](gate.md).
- Every privileged action leaves a receipt in [ledger](ledger.md).

![Repository dependencies](../images/repo-dependencies.svg)

## Related

- [System context and layers](../02-architecture/system-context-and-layers.md)
- [Dependency rules](../02-architecture/dependency-rules.md)
- [Contracts](../04-contracts/README.md)
- [Repository catalogue](../13-reference/repo-catalogue.md)
