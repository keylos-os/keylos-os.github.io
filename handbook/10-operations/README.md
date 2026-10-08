# Operations

> How a keylos machine is installed, kept up to date, recovered when something goes wrong, and, optionally, managed by an organisation. Also covers the key ceremonies behind releases and the runbooks for the incidents an owner is most likely to face.
> Status: **specified (v1.0)**. Normative specs: [installer](../../specs/installer/spec.md), [courier](../../specs/courier/spec.md), [fleet](../../specs/fleet/spec.md), [keylos](../../specs/keylos/spec.md).

## Operating model

keylos is operated by its **owner**. In managed mode, the owner is an organisation. Three ideas shape day-to-day operation:

| Idea | Consequence for operations |
|---|---|
| Everything is a generation | Updates, config changes and rollbacks are switches between signed generations; nothing is patched in place |
| The owner's FIDO2 key is the authority for persistent change | Config apply, sealing, policy change and enrolment of new keys need a touch; keep two keys |
| Every change leaves a receipt | When something goes wrong, the [ledger](../04-contracts/receipts.md) tells you who did what, and the checkpoint witness tells you whether the record was tampered with |

## Pages

| Page | Contents |
|---|---|
| [Install and enrolment](install-and-enrolment.md) | Installer flow, disk layout, TPM provisioning, FIDO2 and Secure Boot enrolment, recovery key, first config, vouch pairing, migration, unattended installs |
| [Updates and rollback](updates-and-rollback.md) | Streams, staging, PCR prediction, boot counting, version floor, firmware updates, rolling back |
| [Recovery](recovery.md) | The recovery environment: unlocking with the recovery key, rollback, re-enrolling the TPM or FIDO2 keys, reinstall keeping home, factory reset |
| [Key ceremonies](key-ceremonies.md) | Project release signing, TUF root rotation, rebuilder and witness governance, owner-side key ceremonies |
| [Fleet](fleet.md) | Organisation management: BYOD vs managed, policy overlays, attestation, approvals, privacy boundaries |
| [Servers and cloud](servers-and-cloud.md) | Headless and cloud profiles, quorum presence, vTPM and confidential VMs, signed first-boot seeds |
| [Kubernetes nodes](kubernetes.md) | The `server-k8s` profile: kubelet, cri, runtime classes, admission, networking, storage, attestation |
| [Observability](observability.md) | Journal, metrics, crash reports, receipts and how to query them |
| [Runbooks](runbooks/README.md) | Step-by-step responses to common incidents |

## The owner's toolkit

| Item | Where it lives | Needed for |
|---|---|---|
| Two FIDO2 security keys | With the owner (one kept separately) | Presence: config, seal, policy, T3 payments, key enrolment |
| TPM PIN | Memory | Daily unlock |
| Recovery key (printed, 8 groups) | Safe place, offline | TPM failure, lost keys, recovery environment |
| vouch phone | With the owner | Verify before unlock, witness, remote approvals |
| Recovery kit PDF (optional) | Removable media, offline | Recovery key plus machine fingerprints and key labels |

## Everyday commands

```
kish status                 integrity profile, revocation age, stream, OS and config generations, pending update, attestation
courier check               look for updates
courier status              staged update and boot counter state
config history              list config generations
config revert <gen>         plan a revert (needs a touch)
ledger query --since 1d     recent receipts for your machine
why <file>                  who created a file, in which transaction
vouch phones                paired phones and last witness time
fleet status                organisation enrolment and compliance (if enrolled)
```

## Related

- [Profiles and hardware](../01-overview/profiles-and-hardware.md)
- [Attestation and vouch](../05-integrity/attestation-and-vouch.md)
- [Decisions](../11-decisions/README.md)
