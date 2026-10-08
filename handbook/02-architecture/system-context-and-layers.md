# System context and layers

> keylos is one machine, its owner, and an outside world it trusts only through signatures, logs and quorums.
> Inside, 22 on-machine components sit in six layers on a stock kernel. Seven more repositories build, publish, install and attest it.

![System context](../images/system-context.svg)

## Outside the machine

| Party | Relationship | Trust |
|---|---|---|
| **Owner** | Uses the machine; holds the FIDO2 key, the PIN and the recovery key | The only principal that can sign config, seals, policy and T3 mandates |
| **vouch** (owner's phone) | Verifies the boot state before unlock; witnesses ledger checkpoints; approves remotely | Holds verification keys only; cannot grant authority by itself |
| **Release infrastructure** | TUF repository and OCI registry of the release streams (`stable`, `beta`, `dev`) | Threshold-signed TUF roots; never trusted alone |
| **Rebuilders** | Independent operators who rebuild every generation and sign realisation attestations | k-of-n quorum (default 2-of-3) |
| **Transparency logs** | Realisation log and release log (C2SP tlog-tiles) with independent witnesses | Inclusion with ≥ 2 witness cosignatures is required |
| **App publishers** | Sign app generations under TUF delegation or a Sigstore identity | Trusted for their own generations, and confined by tier and manifest |
| **Third-party hosts** | APIs, mail, git forges, model providers | Untrusted; reachable by non-human principals only through gate |
| **fleet** (optional) | An organisation's policy distribution, attestation verifier and witness | Signs policy generations that the owner enrolled |

## The six layers

| Layer | Components | Owns | Tier |
|---|---|---|---|
| **Experience** | [kish](../../specs/kish/spec.md), [atrium](../../specs/atrium/spec.md), [portals](../../specs/portals/spec.md) | Human interaction: shell, compositor and desktop shell, trusted path, powerbox UI, device portals | t1 (kish), t0 (atrium, portals) |
| **Agents and effects** | [aide](../../specs/aide/spec.md), [gate](../../specs/gate/spec.md), [net](../../specs/net/spec.md) | Agent sessions, the egress proxy and effect outbox, budgets, links, DNS, VPN, time | t0 |
| **Authority** | [broker](../../specs/broker/spec.md), [ledger](../../specs/ledger/spec.md), [vault](../../specs/vault/spec.md), [hearth](../../specs/hearth/spec.md) | Grants and policy, receipts, secrets, humans and presence | t0 |
| **Execution** | [warden](../../specs/warden/spec.md), [bench](../../specs/bench/spec.md), [compat](../../specs/compat/spec.md), [devd](../../specs/devd/spec.md), [journal](../../specs/journal/spec.md) | Processes, confinement, VMs, the legacy tier, devices, logs | PID 1 (warden), t0 |
| **State** | [depot](../../specs/depot/spec.md), [strata](../../specs/strata/spec.md), [config](../../specs/config/spec.md) | The store and generations, snapshots and transactions, configuration | t0 |
| **Boot and updates** | [boot](../../specs/boot/spec.md), [courier](../../specs/courier/spec.md) | UKI and initrd, unlock, measured boot, updates and rollback | initrd, t0 |

Beneath them sits the **Linux kernel** (feature level KL1–KL3), with the TPM 2.0 and UEFI firmware. Beside them sits **[protocols](../../specs/protocols/spec.md)**: the identifiers, interfaces and formats every component speaks.

Off the machine:

| Repository | Role |
|---|---|
| [pkgs](../../specs/pkgs/spec.md) | Recipes for every package in the distribution |
| [forge](../../specs/forge/spec.md) | Hermetic builder and rebuilder |
| [tlog](../../specs/tlog/spec.md) | Transparency logs, witnesses and the client verification library |
| [keylos](../../specs/keylos/spec.md) | Assembles images, kernel configuration, profiles and default policy |
| [sdk](../../specs/sdk/spec.md) | Tools for app and service authors |
| [installer](../../specs/installer/spec.md) | Installation, enrolment ceremony and recovery environment |
| [fleet](../../specs/fleet/spec.md) | Optional organisation management |
| [vouch](../../specs/vouch/spec.md) | The phone companion |

## What flows where

| Flow | Path | Carries |
|---|---|---|
| Authority | Owner or policy → broker → token → materialize → fd in the process | Biscuit tokens, file descriptors, sockets, service capabilities |
| Evidence | Every tier-0 decision → ledger → TPM-anchored checkpoint → optional witness | Receipts (DSSE, hash-chained) |
| Code | forge → rebuilders → logs → TUF/OCI → courier (resolves) → depot (installs) → store → warden registers verified mounts → `kl-exec` | Generations, generation statements, attestations, inclusion proofs |
| Effects | Principal → gate → outbox → mandate → external host | Intents, rendered effects, mandates, credentials injected by vault |
| Configuration | Nickel source → config → owner presence → confext generation → `/etc` | Signed config generations, NV counter |
| Data | Process → strata transactions and snapshots → backups | Subvolumes, snapshots, crypto-shred units |

## Layer rules

1. **Experience never holds authority of its own.** kish and atrium act on behalf of the human principal through broker; portals hand over fds that broker authorised.
2. **Authority components do not execute user code.** broker, vault and ledger never spawn principals; warden spawns them on request with grants that broker minted.
3. **State components are the only writers of their stores.** depot alone writes `/store`, strata alone writes `/snapshots` and `/keystore` metadata, and config alone produces config generations.
4. **Boot components finish before userspace has authority.** The disk key is unavailable after `leave-initrd`, because the PCR11 phase changes.
5. **Agents and effects are on-machine policy points.** Model calls, tool network access and all external effects of non-human principals pass through gate.

## Profiles

The same components serve four profiles. [Profiles and hardware](../01-overview/profiles-and-hardware.md) has the details.

| Profile | Differences |
|---|---|
| Desktop and laptop | Full experience layer; workbenches; tier-2 app VMs; vouch pairing offered at install |
| Server | No atrium or portals; trusted-path prompts go to vouch or fleet; workbenches for CI and agents |
| Appliance | A fixed set of sealed services; no shell login; updates only through courier; fleet attestation |

## Related

- [Dependency rules](dependency-rules.md)
- [Process tree and tiers](process-tree-and-tiers.md)
- [Repository catalogue](../13-reference/repo-catalogue.md)
- [Threat model](../01-overview/threat-model.md)
