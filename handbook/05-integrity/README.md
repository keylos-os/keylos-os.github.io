# Integrity

> How keylos makes sure that what runs is what was published and approved, from source code to every executed byte, and how the owner can check it.
> The section follows the chain in order: supply chain, transparency, boot, execution, persistence, and verification by the owner.

**Status:** specified (v1.0).

![Supply chain from source to running file](../images/supply-chain.svg)

## The chain in one table

| Link | Mechanism | Defends against | Page |
|---|---|---|---|
| Source → build | Git-tree pinning, regenerated build files, build and test in separate sandboxes, hermetic builds | Tarball-only payloads, test-fixture payloads (the xz-utils pattern) | [Supply chain](supply-chain.md) |
| Build → published bytes | k-of-n independent rebuilders, realisation log, release log, witnesses | A compromised builder, a targeted (split-view) release | [Transparency and rebuilders](transparency-and-rebuilders.md) |
| Published → installed | TUF over OCI, content-addressed store, fs-verity on every object | Mirrors, rollback, freeze attacks | [Supply chain](supply-chain.md) |
| Installed → booted | Owner Secure Boot keys, signed UKI, TPM + PIN with signed PCR policy, release floor, volume identity | Evil maid, downgrade, partition swap | [Boot chain](boot-chain.md) |
| Booted → executed | composefs `verity=require`, `kl-exec` BPF LSM, W^X, interpreter exec checks, workbenches for unsealed code | Dropped binaries, scripts, memfd tricks, JIT abuse | [Exec integrity and sealing](exec-integrity-and-sealing.md) |
| Executed → persisted | Signed config generations, read-only `/etc`, TPM counters | Persistence through configuration, rollback of config | [Reboot heals](reboot-heals.md) |
| Owner verification | Verify-before-unlock, runtime quotes, checkpoint witnessing via the phone | Tampering the owner cannot otherwise see | [Attestation and vouch](attestation-and-vouch.md) |

## Pages

| Page | Contents |
|---|---|
| [Boot chain](boot-chain.md) | UKI, PCR usage, the unlock policy, the release floor, volume identity, recovery |
| [Exec integrity and sealing](exec-integrity-and-sealing.md) | The `kl-exec` BPF LSM and its maps, IPE as a second layer, interpreters, JIT, owner sealing, workbenches |
| [Reboot heals](reboot-heals.md) | The persistence argument, what it covers, what breaks it |
| [Supply chain](supply-chain.md) | Source rules, builds, the store, distribution |
| [Transparency and rebuilders](transparency-and-rebuilders.md) | Logs, witnesses, rebuilder quorum |
| [Attestation and vouch](attestation-and-vouch.md) | Verify-before-unlock, runtime attestation, the phone companion |

## Trust that remains

No design removes all trust. keylos makes the remaining trust small and explicit:

| You still trust | Why it cannot be removed | How keylos limits it |
|---|---|---|
| Firmware, CPU microcode, the TPM | Below the OS | Measured into PCRs; firmware changes are visible to the phone |
| The Linux kernel | Shared by all host tiers | Minimal config, lockdown, risky syscalls denied, untrusted code in VMs |
| The bootstrap seed and the rebuilder quorum | Someone has to build the first compiler | Full-source bootstrap; k independent operators must agree |
| Upstream source code | Reproducibility proves binary = source, not that the source is benign | Source rules, review tiers for risky changes |
| The owner's own approvals | The owner decides what is theirs | Presence (a physical touch) and rendered effects make approvals deliberate |

## Related

- [Boot to desktop](../02-architecture/boot-to-desktop.md)
- [Confinement tiers](../06-security/confinement-tiers.md)
- [boot spec](../../specs/boot/spec.md), [courier spec](../../specs/courier/spec.md), [depot spec](../../specs/depot/spec.md), [forge spec](../../specs/forge/spec.md), [tlog spec](../../specs/tlog/spec.md)
