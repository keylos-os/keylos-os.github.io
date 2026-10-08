# ADR-0013: Owner-controlled Secure Boot keys by default

> Where firmware allows, the installer enrols owner-controlled Secure Boot keys. The db holds the keylos release key, the owner's key and allow-listed option-ROM hashes, but not the Microsoft third-party UEFI CA. shim + MOK remains a fallback install mode, shown as `degraded`.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Boot | installer, boot, courier, keylos |

## Context

- The Microsoft UEFI CA 2011 that signs shim expired in June 2026. New shims are signed only by the 2023 CA. Updating db has bricked some machines (https://lwn.net/Articles/1079808/).
- Trusting the Microsoft third-party CA trusts every shim and GRUB it ever signed. Old vulnerable vendor shims were still trusted in 2026 (CERT VU#616257, https://www.kb.cert.org/vuls/id/616257).
- Bitpixie-style downgrade attacks boot an old signed, vulnerable boot component to extract sealed keys (https://neodyme.io/blog/bitlocker_screwed_without_a_screwdriver/).
- Some GPUs and NICs need the Microsoft CA to verify their option ROMs. Their hashes can be allow-listed in db instead.

## Decision

- Default: put firmware in setup mode during install. Enrol owner PK, a KEK holding the owner and keylos keys, and a db holding the keylos release-stream signing keys, the owner key and the option-ROM hashes measured at install.
- No Microsoft third-party CA in db on the `full` integrity profile.
- Fallback: shim + MOK where firmware can't enrol custom keys, or where the user needs dual boot with other OSes. The profile shows as `degraded` in status and in attestation.
- dbx and SBAT updates are staged: update db, test, then apply dbx ([Updates and rollback](../10-operations/updates-and-rollback.md)).

## Alternatives considered

| Option | Why not |
|---|---|
| shim + MOK only | Inherits the whole Microsoft-signed bootloader universe; downgrade surface |
| No Secure Boot (TPM only) | Measured boot detects but doesn't prevent; weaker unseal policy |
| Remove Microsoft CA entirely without allow-listing | Bricks machines whose GPU option ROMs need it |

## Consequences

### Positive
- Removes a large class of downgrade attacks.
- The owner decides what boots.

### Negative
- Firmware quirks. Some vendors' setup-mode UX is poor.
- Losing the owner key means resetting firmware to setup mode and re-enrolling (documented in [Recovery](../10-operations/recovery.md)).
- Dual boot with Windows needs the fallback mode.

## Related

- [Boot chain](../05-integrity/boot-chain.md)
- [Install and enrolment](../10-operations/install-and-enrolment.md)
- [ADR-0014: TPM+PIN and signed PCR policy](adr-0014-tpm-pin-signed-pcr-policy.md)
