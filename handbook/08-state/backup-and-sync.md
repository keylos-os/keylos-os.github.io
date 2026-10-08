# Backup and sync

> keylos backs up from read-only snapshots into restic-format repositories, so the standard restic tool can always restore them. It replicates whole subvolumes to other keylos machines with btrfs send/receive, and tests restores automatically.
> TPM-anchored records detect an attacker who rolls the disk back to an older image. Live sync of documents is left to a confined sync app. Specified (v1.0).

## Backup

| Property | Choice |
|---|---|
| Source | Latest snapshot set, never live data, so every backup is crash-consistent per subvolume |
| Format | restic repository format v2, written by `rustic_core`, restorable with upstream `restic` |
| Targets | Local disk, SFTP, S3-compatible, REST server |
| Network | Only through `gate` with a policy grant; credentials injected by `gate`, never seen by the backup process |
| Password | A `vault` item, never in configuration or environment |
| Schedule | Daily 03:30; skipped on battery or metered networks, forced after 3 days |
| Retention | 7 daily, 5 weekly, 12 monthly, 3 yearly |
| Sealed units | Backed up as ciphertext, so forgetting a unit shreds its backups too |

Configured in Nickel:

```nickel
strata.backup.targets.nas = {
  uri = "sftp://backup@nas.lan/keylos",
  passwordSecret = "strata/backup/nas",
  class = 'standard,
}
```

### Backup classes

| Class | Contains |
|---|---|
| `standard` | Everything snapshotted, sealed units as ciphertext |
| `sealed-only` | Only sealed units' ciphertext and data labelled internal or lower. Use it for untrusted cloud storage |

### Restore tests

A backup you have never restored is a hope, not a backup. Every 30 days per target, `strata`:
1. restores a random sample (at least 1 % or 200 files, up to 2 GiB) into a scratch subvolume;
2. compares it with the snapshot;
3. runs a repository check over 2 % of the data;
4. records a receipt.

An overdue or failed test raises a warning.

## Replicas

`strata replica` sends snapshots to another keylos machine you paired with:
- Pairing needs approval on both sides, and the connection uses mutual TLS with machine keys.
- Sends are incremental against the last common snapshot.
- The receiving side checks every path in the stream against escape (`../`, absolute paths) and stores replicas read-only under `/snapshots/replicas/<peer>/`.

## Rebuilding a machine

| Piece | From |
|---|---|
| OS | Signed OS generation digest (from the release log) |
| Configuration | The config git repository |
| Keys | Keystore backup, escrowed separately from data backups |
| Data | restic restore or replica receive into fresh subvolumes |

The installer's restore flow chains these. CI restores a full machine in a VM monthly.

## Rollback detection (anchors)

Full-disk encryption with integrity stops tampering with individual blocks, but it can't stop someone restoring a complete older copy of the disk. Every block of an older image is still authentic. That attack would bring back deleted secrets, old trust decisions, or data from a revoked app.

`strata` keeps an **anchor**:
- It records the filesystem generation, each subvolume's generation, a digest of the snapshot list and a digest of the keystore manifest.
- It is authenticated with a TPM-resident HMAC key (`0x81000110`, usable only with the enrolled PCR15 and once the counter exists) and numbered with the TPM monotonic counter `0x01300107`.
- It is updated hourly while data changes, on every commit (at most once a minute) and at shutdown.

| At boot | Verdict |
|---|---|
| Anchor counter equals the TPM counter, filesystem not older | OK |
| One behind (crash between increment and write), filesystem not older | OK; rewritten |
| Further behind, or filesystem older than anchored | **Rollback detected**: pruning and backups stop, the owner is alerted. Nothing is deleted |
| MAC invalid | Tampered |

Configuration has its own counter and is protected the same way ([Config generations](config-generations.md#anti-rollback)).

## Sync

keylos does not sync live data itself. A sync app (the keylos package of Syncthing) runs as a normal confined tier-1 app with grants to the folders you choose.

| Data | Recommended path |
|---|---|
| Documents, photos | Sync app, end-to-end encrypted; untrusted relay peers store ciphertext |
| System configuration | The config git repository: push and pull, three-way merges, applied with presence |
| App databases (SQLite) | Never synced live. `strata` marks them with `user.keylos.nosync` and the keylos sync package honours it |
| Everything else | Replicas or backups |

## Limitations

- Snapshot sets are consistent per subvolume, not across subvolumes.
- Restic retention is per repository; forgetting a plain unit purges only repositories reachable at the next run.
- Anchors detect whole-image rollback, not replay of individual old sectors within the same period. Those show up as filesystem corruption instead.
- TPMs with low counter endurance get a lower anchor rate (every 6 hours), widening the detection window.

## Related

- [Snapshots and transactions](snapshots-and-transactions.md)
- [Crypto-shredding](crypto-shredding.md)
- [strata specification §4.8, §4.10](../../specs/strata/spec.md)
- [ADR-0014: TPM+PIN, signed PCR policy](../11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md)
- [ADR-0020: btrfs on LUKS2 AEAD](../11-decisions/adr-0020-btrfs-luks2-aead.md)
