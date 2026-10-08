# ADR-0054: Dual boot is an explicit option with its own integrity profile

> By default the Secure Boot db holds only owner and distribution keys. The owner can set `secureboot.keepMicrosoftCAs = true` to keep the Microsoft Windows and third-party UEFI CAs, so another OS can boot. The machine then runs the integrity profile `shared-boot`, shown in status and in the vouch verdict. The remaining downgrade risk is reduced by TPM+PIN, the signed PCR11 policy and the NV release floor.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Boot | installer, courier, boot, vouch, keylos, protocols |

## Context

- Owner-controlled Secure Boot keys remove the large set of Microsoft-signed shims and boot managers from the trust base ([ADR-0013](adr-0013-owner-secure-boot-keys.md)). That set enabled bitpixie-class downgrade attacks, where an old signed component leaks the disk key ([Neodyme](https://neodyme.io/blog/bitlocker_screwed_without_a_screwdriver/)), and it carries vendor shims still being revoked in 2026 ([CERT VU#616257](https://www.kb.cert.org/vuls/id/616257)).
- Without the Microsoft CAs, Windows cannot boot. Many users dual boot, and some firmware or option ROMs need the third-party CA.
- Silently keeping the CAs would make keylos's strongest default meaningless. Refusing dual boot would exclude a large group of users.

## Decision

- **The option.** `secureboot.keepMicrosoftCAs` defaults to false. The installer asks during Secure Boot enrolment; changing it later is a presence-signed config change plus a firmware enrolment ceremony.
- **Integrity profile `shared-boot`** ([protocols §2.2](../../specs/protocols/spec.md#22-profiles-and-integrity-profiles)) is derived at every boot and shown in `kish status`, in the boot report and in the vouch verdict.
- **What still protects the disk key:**
  - TPM+PIN;
  - the signed PCR11 policy bound to `enter-initrd`;
  - the pcrlock policy for PCR0–7;
  - the NV release floor;
  - PCR15 volume identity.
  A downgraded or foreign boot path changes PCRs and fails unsealing; the PIN still blocks a stolen-disk attack.
- **Revocation hygiene.** courier applies dbx and SBAT updates in the staged order (db first) on `shared-boot` machines, as on any other.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep Microsoft CAs by default | Re-imports the whole downgrade surface for every user, including those who never dual boot |
| Refuse dual boot | Excludes many desktop users |
| Chain-load Windows from a keylos-signed boot manager | Windows boot managers are Microsoft-signed; chain-loading doesn't remove the CA from the trust decision |
| Hide the difference | Users and vouch must know which guarantees hold |

## Consequences

### Positive
- Dual boot works, and the user knows exactly what it costs.
- The default stays strong for everyone else.

### Negative
- `shared-boot` machines remain exposed to vulnerabilities in Microsoft-signed components until they are revoked in dbx.
- Firmware enrolment ceremonies differ by vendor; documented per certified machine.

## Related

- [Boot chain](../05-integrity/boot-chain.md)
- [Profiles and hardware](../01-overview/profiles-and-hardware.md)
- [Install and enrolment](../10-operations/install-and-enrolment.md)
- [ADR-0014: TPM2+PIN with signed PCR policy](adr-0014-tpm-pin-signed-pcr-policy.md)
