# Boot to desktop

> What happens between pressing the power button and seeing the desktop, step by step. Each step names the component that owns it, what it verifies, and what it measures into the TPM.
> The sequence has one goal: by the time anything from the disk runs, every byte of it has been checked against a value the owner or the project signed.

**Status:** specified (v1.0). The components are [boot](../../specs/boot/spec.md), [warden](../../specs/warden/spec.md) and [courier](../../specs/courier/spec.md).

![Boot chain from firmware to warden](../images/boot-chain.svg)

## The sequence

| # | Step | Owner | Verifies | Measures |
|---|---|---|---|---|
| 1 | Firmware runs, checks Secure Boot signatures | UEFI | systemd-boot and the UKI are signed by a key in `db` (owner-controlled by default) | PCR0–7 (firmware, boot loader, UKI PE, Secure Boot state) |
| 2 | systemd-boot picks the newest entry with tries left | systemd-boot | — | — |
| 3 | systemd-stub unpacks the UKI | systemd-stub | — | PCR11 (kernel, initrd, cmdline, os-release, `.pcrpkey`) |
| 4 | Kernel starts with `lockdown=integrity` and `lsm=landlock,lockdown,yama,ipe,bpf`; IPE loads its signed policy (initramfs and kexec rules) | kernel | Module signatures | PCR9 (initrd) |
| 5 | `kl-initrd` starts as the only process | boot | — | PCR11 `enter-initrd` |
| 6 | `kl-exec` BPF LSM attached before anything else executes | boot | — | — |
| 7 | Optional: verify-before-unlock with the phone | boot + vouch | Phone checks an AK0 quote over PCR0–15 against the release statement and its log proof | — |
| 8 | PIN prompt; TPM releases the disk secret | boot | Signed PCR11 policy, release floor, pcrlock policy for firmware, PIN | — |
| 9 | LUKS2 opens; volume identity is checked | boot | The unlocked disk is the enrolled disk | PCR15 (volume identity) |
| 10 | OS generation mounts as composefs with `verity=require` | boot | Image digest equals `composefs=` in the signed cmdline | — |
| 11 | Config generation selected and mounted read-only at `/etc` | boot | Owner-presence signature against the owner registry anchored in NV `0x01300105`; counter ≥ NV `0x01300101`; otherwise the safe config | — |
| 12 | Boot trust set and boot report written to `/run/keylos/boot/`; OS and bootstrap generations added to the `kl-exec` allow map | boot | — | — |
| 13 | `switch_root`; `warden` starts as PID 1 | boot → warden | — | PCR11 `leave-initrd` (disk secret now unreleasable) |
| 14 | warden receives the `kl-exec` map fds (3–7) and the boot report (fd 8); bootstrap services `journal`, `ledger`, `depot` start | warden | Generation digests from `bootstrapGens` in the trust set | — |
| 15 | `courier` extends PCR11 `sysinit` | courier | — | PCR11 `sysinit` |
| 16 | Boot services start in parallel (broker, vault, hearth, strata, devd, net, gate, config, portals, atrium, bench, compat, aide) | warden | Each generation is launchable and signed | — |
| 17 | `atrium` shows the greeter; `hearth` logs the human in | atrium, hearth | FIDO2 or password per user policy | — |
| 18 | `courier` assesses the boot; on success, marks the entry good, extends `ready`, may raise the floor | courier | Services healthy for 60 s, ledger checkpoint written | PCR11 `ready` |

## Timing budget

| Segment | Budget (reference laptop) |
|---|---|
| `kl-initrd`, excluding PIN entry | ≤ 900 ms |
| TPM unseal | ≤ 400 ms (firmware TPM), ≤ 900 ms (discrete TPM) |
| `switch_root` → bootstrap services healthy | ≤ 400 ms |
| `switch_root` → greeter | ≤ 2.0 s |

## What can stop the boot

| Condition | What the user sees | Next step |
|---|---|---|
| UKI not signed by a trusted key | Firmware refuses | Boot another entry or recovery media |
| Release older than the TPM floor | "This release is older than the minimum allowed" | Boot loader falls back to a newer entry |
| Firmware or boot configuration changed unexpectedly | "Firmware or boot configuration changed", with the list of PCRs | Recovery key, then `courier` re-locks |
| Phone says NOT VERIFIED | The initrd asks before showing the PIN prompt | Power off, or recovery |
| Disk is not the enrolled disk | "Volume identity mismatch" and halt | Check the hardware |
| No valid config generation | Desktop starts with the safe config and a critical banner | Re-apply config with presence |

## Recovery path

The recovery profile of the same UKI unlocks with the 256-bit recovery key. It extends PCR11 with `enter-recovery`, so no TPM-sealed secret is available, and starts the recovery generation instead of `warden`. From there the owner can re-enrol the TPM, stage a release from USB media, or restore data. See [Updates and rollback](../10-operations/updates-and-rollback.md).

## Why the order matters

- **kl-exec before anything executes.** The first exec after the initrd would otherwise be a window in which a file on disk could run.
- **Volume identity before mounting.** This defeats the partition-swap attacks against TPM-only unlock.
- **`leave-initrd` before `switch_root`.** After this point, even a compromised userspace cannot ask the TPM for the disk secret again.
- **The ledger starts early.** The `boot` receipt anchors every later receipt of the session.

## Limitations

- Firmware code itself is measured but not verified by keylos. A compromised firmware is out of scope.
- A discrete TPM's bus can be sniffed. The PIN makes a sniffed unseal insufficient on its own, and salted sessions encrypt the secret on the bus.
- The degraded profile (no TPM) has no measured unlock and no verify-before-unlock.

## Related

- [Boot chain](../05-integrity/boot-chain.md)
- [Process tree and tiers](process-tree-and-tiers.md)
- [Reboot heals](../05-integrity/reboot-heals.md)
- [Attestation and vouch](../05-integrity/attestation-and-vouch.md)
- [boot spec](../../specs/boot/spec.md), [warden spec](../../specs/warden/spec.md), [courier spec](../../specs/courier/spec.md)
- [ADR-0014 TPM + PIN with a signed PCR policy](../11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md), [ADR-0015 Verify before unlock](../11-decisions/adr-0015-verify-before-unlock.md)
