# Recovery

> When the normal boot path can't proceed (TPM refuses to unseal, a FIDO2 key is lost, an update broke something, or you need to start over), the recovery environment takes over. It is a separately signed image that can never unseal the disk on its own, so it is safe to leave on every machine.
> Status: **specified (v1.0)**. Normative spec: [installer](../../specs/installer/spec.md) §4.13–§4.14.

## How to get there

| Situation | Path |
|---|---|
| Boot menu | Hold `r` (or pick "keylos recovery") in systemd-boot |
| Symptoms return after a reboot | Pick **safe start** in the boot menu: normal verified boot, no session restore, app data quarantined read-only ([Reboot heals](../05-integrity/reboot-heals.md#safe-start-and-quarantine)) |
| TPM unseal fails | The initrd offers the recovery key, then "Boot recovery environment" |
| A config generation failed to activate | The recovery entry offers a revert to the previous generation, signed by an owner (never an automatic fallback) |
| Headless machine (`server`, `cloud`) | Serial console: the recovery entry asks for the recovery key |
| Update fails its health checks 3 times | Boot counting falls back to the previous generation automatically; recovery is not needed |

Recovery is a profile inside the normal UKI, not a separate image. boot extends PCR11 with `enter-recovery` instead of `leave-initrd`, so the TPM disk token and every secret sealed to `ready` **never** unseal in recovery. You unlock with the recovery key: type its 8 groups (each group's CRC-8 points at a typo), or reconstruct it from *k* trustee share cards.

## What it can do

| Operation | You need | Result |
|---|---|---|
| Unlock | Recovery key (typed, or rebuilt from trustee shares) | Disk opened for the operations below |
| Revert after activation failure | Unlocked + owner presence (quorum on headless profiles) | The previous config generation is re-signed with the next counter |
| Complete a fleet wipe | Unlocked + a verified quorum of the machine's owners | Keyslots destroyed, keystore zeroed, NV indices removed |
| Inspect | Unlocked | Generations, receipts, update state, store verification |
| Roll back OS | Unlocked | Previous OS generation becomes the default boot entry |
| Roll back config | Unlocked + FIDO2 touch | New config generation (next counter) with the content of an older one |
| Re-enrol TPM | Recovery key + FIDO2 touch | New pcrlock policy from the current firmware; disk token resealed; NV indices recreated if the TPM was cleared |
| Re-enrol FIDO2 | Recovery key + an existing FIDO2 key, **or** recovery key alone + a 24-hour delay | New keys added, lost keys removed, owner-seal policy rebuilt |
| Reset Secure Boot to setup mode | Recovery key (unwraps your owner PK) | Ready for re-enrolment or shim fallback |
| Reinstall keeping home | Recovery key + FIDO2 (or the delayed path) | Fresh store, var and config; home and app data kept; keystore re-wrapped |
| Factory reset | Recovery key | Crypto-erase: LUKS header and keyslots destroyed, NV indices removed |
| Export data | Unlocked | Copy chosen files to removable media |

Every operation shows its exact effect before it runs, the same way a T3 approval does.

## The 24-hour delay

If both FIDO2 keys are gone, the recovery key alone can enrol new ones, but only after **24 hours**. During that time:
- the greeter shows a banner with a "Cancel" button that any existing FIDO2 key can press;
- a paired vouch phone is notified at its next contact.

This makes a stolen recovery key much less useful to someone who also has the machine but not your keys, while still letting you recover from losing everything else.

## Safety properties

- Recovery never runs code from the installed disk. It mounts the disk `noexec`, and its `kl-exec` allow map holds only the recovery generation itself.
- It has no network unless you enable it, for example to download a fresh OS generation. Downloads are TUF-verified like normal updates.
- Every change writes a **pending receipt**. The main system's ledger ingests them at next boot, writing them as `service:ledger` with `onBehalfOf` the recovery action, for events registered as recovery-replayable, so recovery actions appear in the audit trail.
- The TPM lockout auth derives from the recovery key, so only recovery can clear a dictionary-attack lockout.

## Reinstall keeping home

1. Unlock with the recovery key and touch a FIDO2 key, or use the delayed path.
2. `@home` is snapshotted read-only first.
3. Store, var and snapshots are recreated. The store is repopulated from the recovery media or a verified download.
4. The keystore is unwrapped with the old keys, or with the recovery escrow key `vault` maintains, and re-wrapped under the new TPM objects.
5. A new first config generation is created. Its counter continues from the TPM, so old config generations can never be replayed.

Users, UIDs and per-app data stay where they were.

## Limitations

- If the TPM is cleared and the recovery key is lost, the data is gone. That is by design.
- The recovery environment's text UI is deliberately minimal and has no applications.
- Firmware that cannot re-enter setup mode limits "reset Secure Boot" to switching to shim fallback.

## Related

- [Runbook: TPM unlock failure](runbooks/tpm-unlock-failure.md)
- [Runbook: lost FIDO2 key](runbooks/lost-fido2-key.md)
- [Runbook: failed update](runbooks/failed-update.md)
- [Install and enrolment](install-and-enrolment.md)
- [installer spec](../../specs/installer/spec.md)
