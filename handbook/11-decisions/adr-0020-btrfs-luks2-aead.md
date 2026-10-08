# ADR-0020: btrfs on LUKS2 with authenticated encryption

> The data filesystem is btrfs (single device or RAID1/10) on LUKS2 with dm-integrity authenticated encryption. Retention is by snapshot count and age; qgroups are never used. Per-user and per-app fscrypt keys are adopted when btrfs fscrypt merges.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | State | strata, installer, boot, hearth, keylos |

## Context

| Option | Status (Oct 2026) |
|---|---|
| btrfs | Mature snapshots and send/receive. RAID5/6 still not production-ready (https://lwn.net/Articles/895424/). fscrypt series at v7, experimental (https://lkml.iu.edu/hypermail/linux/kernel/2602.0/09611.html). qgroup rescans cause real slowdowns (openSUSE Leap 16 reports) |
| bcachefs | Removed from mainline in 6.18, DKMS only (https://www.linuxjournal.com/content/bcachefs-ousted-mainline-kernel-move-dkms-and-what-it-means) |
| ZFS | Out of tree (licence); block-cloning corruption history in 2.2.0 |
| XFS | Reflinks, but no subvolume snapshots |
| NILFS2 | Niche, poorly maintained |

- Plain AES-XTS is malleable. dm-integrity with AEAD (AEGIS-128 or HMAC) detects tampering by an offline attacker.

## Decision

- btrfs subvolumes: `@store`, `@var`, `@home`, `@keystore` (never snapshotted), `@snapshots`, plus per-user and per-app subvolumes.
- LUKS2 + dm-integrity AEAD on root. Optional (default on desktops) for secondary data disks.
- No qgroups. Snapshot retention by count and age, managed by strata.
- RAID1/10 only for multi-device setups.
- Until btrfs fscrypt merges, crypto-shred units use userspace per-unit encryption ([ADR-0032](adr-0032-crypto-shredding.md)).

## Alternatives considered

See Context. ZFS is offered as an advanced profile only.

## Consequences

### Positive
- In-tree, mature snapshots for reversibility. Authenticated encryption against offline tampering.

### Negative
- dm-integrity write amplification and TRIM limits.
- No per-user kernel-level encryption keys yet.

## Related

- [Filesystem layout](../08-state/filesystem-layout.md)
- [strata](../03-components/strata.md)
- [ADR-0032: Crypto-shredding](adr-0032-crypto-shredding.md)
