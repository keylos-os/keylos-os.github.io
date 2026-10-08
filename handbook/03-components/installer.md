# installer

> Installation, first-boot enrolment and the recovery environment. The installer partitions and encrypts the disk, installs a verified OS generation, and runs the enrolment ceremony: owner Secure Boot keys, TPM2+PIN, FIDO2 owner-presence keys (primary and backup), a printed recovery key, and pairing with the [vouch](vouch.md) phone app.
> The recovery environment is a signed UKI that can unlock with the recovery key and repair the system without weakening verification.

**Status:** specified (v1.0) · **Spec:** [`installer/spec.md`](../../specs/installer/spec.md)

## Responsibilities

- **Media:** a signed live image (UKI + composefs), itself verified at boot. It offers a hardware check (TPM 2.0 revision, Secure Boot custom-key support, KVM, IOMMU).
- **Disk:** GPT with ESP and `keylos-root` (LUKS2 + dm-integrity AEAD, btrfs subvolumes per protocols §10.2). Optional encrypted swap.
- **Secure Boot:** enrol owner PK/KEK/db (distro key, owner key, allow-listed option-ROM hashes) where firmware allows. Otherwise use shim + MOK and mark the integrity profile `degraded`.
- **TPM:**
  - TPM2+PIN enrolment under the signed PCR11 policy and pcrlock-compatible PCR0–7 policy;
  - NV indexes (version floor, config counter, ledger counter);
  - SRK pinning.
- **Owner keys:** primary and backup FIDO2 via [hearth](hearth.md). Generate the owner-seal TPM key and enrol it into the config generation.
- **Recovery key:** generated, printed or shown once. It stores the TPM lockout auth.
- **vouch pairing:** exchange the attestation key and the machine identity key.
- **First config generation:** signed with the newly enrolled presence key.
- **Recovery:** unlock with the recovery key, re-enrol the TPM after firmware changes, replace lost FIDO2 keys (bumps the NV floor), and restore from backup.

## Interfaces

Uses [boot](boot.md), [hearth](hearth.md), [config](config.md), [depot](depot.md) and [strata](strata.md) in offline mode. Provides no runtime interface.

## Key decisions

- [ADR-0013: Owner Secure Boot keys](../11-decisions/adr-0013-owner-secure-boot-keys.md)
- [ADR-0014: TPM+PIN and signed PCR policy](../11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md)
- [ADR-0011: Owner presence via FIDO2](../11-decisions/adr-0011-owner-presence-fido2.md)

## Related

- [Install and enrolment](../10-operations/install-and-enrolment.md)
- [Recovery](../10-operations/recovery.md)
- [Key ceremonies](../10-operations/key-ceremonies.md)
