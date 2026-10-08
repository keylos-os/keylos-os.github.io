# boot

> The boot chain from firmware to the first warden instruction. It covers the UKI layout, an initrd that unlocks the disk with TPM2+PIN, verifies the volume identity, mounts the sealed OS generation, loads the `kl-exec` BPF LSM and the boot trust set, and runs the verify-before-unlock QR flow.
> If a check fails, boot stops or falls back to recovery. It never boots unverified code.

**Status:** specified (v1.0) · **Spec:** [`boot/spec.md`](../../specs/boot/spec.md)

![Boot chain](../images/boot-chain.svg)

## Responsibilities

- Define the UKI: kernel, initrd, cmdline with `composefs=<OS generation digest>`, `.pcrsig` with signed PCR11 predictions, `.pcrpkey`. systemd-stub is the stub and systemd-boot the loader. Both are reused.
- Initrd sequence:
  1. Verify before unlock (protocols §20.5): show the `KLV1` hello QR, take the 8-character challenge typed from [vouch](vouch.md), and show a QR of an AK0 quote over PCR0–15.
  2. Ask for the PIN.
  3. Unseal the disk key under the policy: signed PCR11 ∧ pcrlock-compatible PCR0–7 ∧ NV version floor.
  4. Unlock LUKS2 with an AEAD integrity profile.
  5. Verify the volume identity and measure it into PCR15.
  6. Mount the composefs OS generation with `verity=require`.
  7. Select the config generation: the highest-counter `keylos.configgen/1` statement that verifies against the owner registry anchored in NV `0x01300105`, with counter ≥ NV `0x01300101`; otherwise the safe config shipped in the OS generation.
  8. Load the `kl-exec` BPF LSM before running anything else, register the OS and bootstrap generations, write the boot trust set (`/run/keylos/boot/trust.json`), and load the signed IPE policy (initramfs and kexec rules only).
  9. Hand over to warden.
- Recovery: recovery-key unlock, TPM lockout recovery, re-enrolment hooks for [installer](installer.md).

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Consumes | `depot-mount-helper` library (no `depotd` in the initrd) | Digest-checked composefs mounts of the OS, config and bootstrap generations |
| Consumes | TPM 2.0 (tss-esapi), libcryptsetup | Unseal, unlock, VBU quotes with AK0 (`0x81010003`) |
| Produces | PCR11 phases, PCR12, PCR15 | Read by vouch (VBU) and fleet attestation |
| Hands over | `kl-exec` map fds 3–7, `/run/keylos/boot/trust.json`, `/run/keylos/boot/report.json` (also fd 8) | Boot trust set and boot report (protocols §20.1) |

## Runs as

The initrd, before PID 1 exists. It runs as UID 0 with no network, a fixed binary set from the verified initramfs, and no interactive shell except the recovery prompt.

## State

| Item | Location |
|---|---|
| TPM NV indexes (read) | `0x01300101` (config counter), `0x01300102` (os-floor), `0x01300103` (pcrlock-policy), `0x01300105` (owner-registry-head), `0x01300108` (attestation-key names); see [Names, paths and IDs](../13-reference/names-paths-and-ids.md) |
| LUKS2 header | `keylos-root` partition |
| Boot entries | ESP `/EFI/Linux/*.efi`, managed by [courier](courier.md) |

## Receipts

None directly, because the ledger isn't running yet. warden writes the `boot` receipt with the boot facts that boot handed over.

## Key decisions

- [ADR-0008: Host executes only sealed code](../11-decisions/adr-0008-host-executes-only-sealed-code.md)
- [ADR-0013: Owner Secure Boot keys](../11-decisions/adr-0013-owner-secure-boot-keys.md)
- [ADR-0014: TPM+PIN and signed PCR policy](../11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md)
- [ADR-0015: Verify before unlock](../11-decisions/adr-0015-verify-before-unlock.md)
- [ADR-0022: Read-only /etc via confext](../11-decisions/adr-0022-read-only-etc-confext.md)

## Limitations

- Firmware, microcode and the TPM itself are trusted and can't be verified.
- pcrlock-style prediction depends on firmware event logs being well formed. Unpredictable PCRs are dropped from the policy, not trusted.

## Related

- [Boot chain](../05-integrity/boot-chain.md)
- [Boot to desktop](../02-architecture/boot-to-desktop.md)
- [Attestation and vouch](../05-integrity/attestation-and-vouch.md)
- [Recovery](../10-operations/recovery.md)
