# Install and enrolment

> Installing keylos is mostly a key ceremony. The installer partitions and encrypts the disk, but its real job is enrolling the keys that every later decision depends on: owner Secure Boot keys, a TPM-sealed unlock, two FIDO2 keys, a recovery key, and an optional vouch phone.
> Status: **specified (v1.0)**. Normative spec: [installer](../../specs/installer/spec.md).

## Before you start

| You need | Why |
|---|---|
| The installer USB (verify its digest against the release log) | The installer only runs from a signed image |
| Two FIDO2 keys with `hmac-secret` and a PIN set | Owner presence; one key is a backup |
| A way to record the recovery key (paper) | Last-resort unlock and re-enrolment |
| Optionally: your phone with vouch installed | Verify before unlock, witness, remote approvals |
| Optionally: firmware in Secure Boot **setup mode** | Owner-controlled Secure Boot keys (otherwise shim fallback) |

## Flow

```
 welcome → hardware check → profile → disk → owner account → FIDO2 ×2 → PIN
        → Secure Boot mode → network → vouch pairing → recovery key → summary
        → install → test reboot → first boot
```

Every step is in a journal. A power loss mid-install lets you resume or roll back. Secure Boot keys are written **second to last**, so an aborted install never leaves firmware trusting a system that isn't there.

### Hardware check

The installer reports everything that affects integrity before you choose anything:
- architecture level, UEFI version;
- Secure Boot state (user, setup, audit, deployed);
- TPM revision and `PolicyAuthorizeNV` support;
- IOMMU, KVM;
- kernel feature level;
- option ROMs it found.

It then shows the integrity profile you will get. Without a TPM, only the `degraded` profile is offered, with a plain-language list of what that loses.

### Disk

| Partition | Content |
|---|---|
| ESP, 1 GiB | systemd-boot, signed UKIs, recovery UKI and DDI |
| `keylos-root` | LUKS2 with AEAD integrity → btrfs with `@store`, `@var`, `@home`, `@keystore`, `@snapshots` |
| `keylos-swap` (laptop, optional) | Encrypted with an ephemeral key; no hibernation |

The disk is formatted with integrity, which initialises every sector. btrfs is created **without quotas**. `@keystore` is never snapshotted, which is what makes crypto-shredding work.

### Owner and FIDO2

You register two security keys. Each registration is one touch. The keys become:
- **owner-presence keys**: they sign config generations, seals, policy changes and T3 mandates;
- the authority behind your TPM-resident **owner-seal key** (`0x81000140+i`): its only policy is `PolicySecret` on your NV **seal gate** (`0x01300140+i`), whose auth value hearth rotates each sealing window with the keys' `hmac-secret` output from a fresh, user-verified touch (the same construction hearth uses at runtime);
- optionally, extra disk-unlock slots used only if the TPM refuses to unseal.

With a single key, the installer makes you acknowledge that losing it means using the recovery key.

### TPM

The installer:
1. pins the TPM's storage root key, so the initrd can detect a TPM interposer;
2. creates keylos's NV indices from the TPM registry ([Registries](../04-contracts/registries.md#tpm-objects)): ledger counter `0x01300100`, config counter `0x01300101`, OS floor `0x01300102` (an 8-byte release `seq`), pcrlock policy `0x01300103`, keystore floor `0x01300104`, owner-registry head `0x01300105`, login-failure counter `0x01300106`, strata anchor counter `0x01300107`, attestation-key names `0x01300108`, and one seal gate per owner from `0x01300140`; it also creates the AK (`0x81010002`), AK0 (`0x81010003`), the recovery auth object (`0x81000105`) and the owner-seal keys;
3. seals the disk key under:
   - the release-stream-signed PCR 11 policy;
   - the pcrlock policy for firmware PCRs;
   - the OS version floor;
   - PCR 15 being zero;
   - your PIN.

PCRs whose firmware event logs can't be predicted are left out of the policy, and the installer tells you which.

### Secure Boot

| Firmware state | What happens |
|---|---|
| Setup mode | Owner mode: the installer generates your PK and KEK, enrols `db` = keylos release-stream certificate + your owner certificate + hashes of your option ROMs, then PK last |
| Not in setup mode | Instructions for your vendor, or **shim fallback** (Microsoft-signed shim + MOK). Fallback is shown in status and in vouch |

If an option ROM can't be identified by hash, you choose between trusting the Microsoft UEFI CAs (integrity profile `shared-boot`) and accepting that the device might not initialise.

**Dual boot.** Choosing "keep Windows bootable" sets `secureboot.keepMicrosoftCAs = true` and keeps the Microsoft Windows and third-party UEFI CAs in db. The machine then runs the `shared-boot` integrity profile, shown in status and by vouch ([ADR-0054](../11-decisions/adr-0054-dual-boot-option.md)).

### Recovery key

32 random bytes, shown as 64 hex digits in 8 groups of 8, each followed by a 2-digit CRC-8 ([protocols §20.21](../../specs/protocols/spec.md#2021-recovery-key)), plus a QR code. You re-type two random groups to prove you recorded it. It unlocks the disk, derives the TPM recovery and lockout authorizations and the owner registry's recovery signer, and authorises TPM re-enrolment. It is never stored on the machine.

Optionally, split it into **trustee shares** (k of n Shamir shares, printed as cards) for people you trust. Each card alone reveals nothing.

### First config generation

The installer writes your choices as a Nickel config repository: profile, owners, locale, networks, apps, vouch, fleet. It compiles them and asks for **one touch** to sign the first config generation, with counter 1. From then on, `/etc` is read-only and changes only through new signed generations.

### vouch pairing

The machine shows a QR code and the phone scans it. Over the local network, the phone:
- validates the TPM's EK certificate;
- proves the attestation key lives in that TPM;
- records the firmware baseline.

Without a shared network, the phone shows 12 words for you to type on the machine, and the pairing completes on the first network contact.

## First boot

The installer leaves a one-time **enrolment bundle** (`keylos.firstboot/1`, [protocols §20.13](../../specs/protocols/spec.md#2013-first-boot-bundle-keylosfirstboot1)), which each service consumes and deletes. It names the TPM registry version instead of listing handles:

| Service | Takes |
|---|---|
| `hearth` | Owner account, FIDO2 credentials, seal gate, owner-registry genesis |
| `vault` | Wi-Fi and imported secrets (sealed to the boot policy) |
| `ledger` | First receipts: boot, key enrolments, config apply |
| `courier` | Secure Boot mode, PCRs covered by pcrlock |
| `config` | Config counter, bundle digest check |
| `strata` | Imported data units |

## Migrating from another Linux

The installer mounts the old disk **read-only** and copies selected folders into `~/Imported/<source>/`, labelled `private/untrusted`. Dotfiles are copied aside and never applied. After first boot, `config adopt` can offer to translate them. SSH and GnuPG keys can be imported into `vault` one by one.

## Headless and cloud installs

| Profile | What changes |
|---|---|
| `server`, `server-k8s`, `appliance` | Owners enrol their FIDO2 credentials, and the installer sets `policy.mode = "quorum"` with the chosen threshold. Approvals then come from owners' own machines ([Servers and cloud](servers-and-cloud.md)) |
| `cloud` | No interactive installer: the image boots, fetches a `keylos.firstboot/1` bundle from the metadata service, checks it against the fleet seed keys, and ignores unsigned user-data. The provider vTPM is used; on confidential VMs the CVM report is recorded |
| `server-k8s` | Also enrols with the fleet so `cri` can attest and join a cluster ([Kubernetes nodes](kubernetes.md)) |

## Unattended installs

For appliances and fleets, `installer --answers file.ncl` takes every choice from a file. Running it without any prompt (`--yes`) requires the answers file to be signed by the organisation's fleet key. FIDO2 enrolment can be deferred to first boot, or delegated to fleet approvers for appliances.

## Limitations

- Owner-mode Secure Boot excludes dual-boot loaders unless you add them, which moves the machine to `compat`.
- Some firmware cannot leave and re-enter setup mode reliably. Shim fallback exists for that.
- Formatting with integrity takes minutes on large disks.

## Related

- [installer spec](../../specs/installer/spec.md)
- [Recovery](recovery.md)
- [Key ceremonies](key-ceremonies.md)
- [Profiles and hardware](../01-overview/profiles-and-hardware.md)
- [Attestation and vouch](../05-integrity/attestation-and-vouch.md)
- [ADR-0013: Owner Secure Boot keys](../11-decisions/adr-0013-owner-secure-boot-keys.md)
- [ADR-0014: TPM + PIN with signed PCR policy](../11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md)
