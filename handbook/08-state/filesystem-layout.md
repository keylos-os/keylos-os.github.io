# Filesystem layout

> keylos uses one encrypted, integrity-protected btrfs filesystem split into subvolumes with distinct jobs: the store, system state, homes, the keystore and snapshots.
> Code comes only from the store. Every writable location is `noexec`, and every unit of data that needs its own snapshot, backup or forget policy is its own subvolume. Specified (v1.0).

## Disk

| Partition | Size | Content |
|---|---|---|
| ESP | 1 GiB, FAT32 | systemd-boot, signed UKIs. Mounted at `/efi` only during updates |
| `keylos-root` | Rest of disk | LUKS2 with dm-integrity authenticated encryption (`aegis128`, or AES-GCM + HMAC-SHA256), containing one btrfs filesystem |
| `keylos-swap` (optional) | RAM size | Encrypted with an ephemeral random key at every boot. There is no hibernation: kernel lockdown refuses it |

Authenticated encryption means a modified block fails to decrypt rather than returning attacker-chosen plaintext. It does not stop an attacker from restoring an older complete image of the disk. That is handled by [anchors](backup-and-sync.md#rollback-detection-anchors).

## Top-level subvolumes

| Subvolume | Mounted at | Writer | Snapshotted | Notes |
|---|---|---|---|---|
| `@store` | `/store` | `depot` | No (content-addressed; generations are the history) | Objects with fs-verity, generation images, `depot` database, ledger data |
| `@var` | `/var` | services | `system` class | `nosuid,nodev,noexec`. Each service's `/var/lib/<svc>` is its own subvolume |
| `@home` | `/home` | `hearth`/`strata` | Per child subvolume | Each `/home/<user>` is a subvolume |
| `@keystore` | `/keystore` | `vault` | **Never** | Wrapped keys only. Excluded from snapshots, replicas and backups, so forgetting a key really forgets it |
| `@snapshots` | `/snapshots` | `strata` | — | Snapshots, transaction layers, received replicas |

The root `/` and `/usr` are not on this filesystem in mutable form. They are the composefs-mounted OS generation, whose content objects live in `@store` and are verified page by page by fs-verity. `/etc` is the mounted [config generation](config-generations.md).

## Inside a home

```
/home/alice                         subvolume (unit u-home-alice, plain)
├── Documents, Pictures, …          ordinary directories
├── src/
│   └── keylos/                     project subvolume (registered with `strata project add`)
└── .apps/
    └── org.example.Editor/
        ├── config/                 subvolume — snapshotted, backed up
        ├── data/                   subvolume — snapshotted, backed up, maybe sealed
        ├── cache/                  subvolume — never snapshotted
        └── state/                  subvolume — snapshotted
```

Why so many subvolumes:
- **Snapshots** are per subvolume. App caches never bloat snapshots, and a project can be rolled back without touching mail.
- **Units** map to subvolumes. Forgetting an app's data deletes exactly its subvolumes and their snapshots.
- **Atomic swaps.** A transaction can replace a whole project subvolume in one rename when nothing else has it open.
- **Ownership.** App subvolumes belong to a stable per-(user, app) data-owner UID. `warden` maps it onto the app's dynamic UID with an idmapped mount, so running UIDs can change on every launch while ownership on disk stays stable.

## Mount options

| Location | Options | Enforced by |
|---|---|---|
| `/`, `/usr` | `ro`, composefs `verity=require` | Kernel (overlayfs + fs-verity), `kl-exec` |
| `/etc` | `ro`, composefs `verity=require` | Kernel |
| `/var`, `/home`, `/snapshots` | `nosuid,nodev,noexec` | Mount flags; `kl-exec` as a second layer |
| App views of their data | `nosuid,nodev,noexec`, idmapped | `warden` |
| Transaction views | `nosuid,nodev,noexec`, overlay | `strata` |

Even without `noexec`, `kl-exec` refuses to execute anything that is not on a mount of a verified, signed generation. `noexec` is defence in depth and makes the intent obvious.

## What a process sees

A tier-1 app does not see the host layout. `warden` builds a private mount view:

| Path in the view | Source |
|---|---|
| `/` | The app's generation (plus its runtime at `/usr`) |
| `/etc` | Only files listed in `/etc/keylos/app-visible.list` |
| `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `$XDG_CACHE_HOME`, `$XDG_STATE_HOME` | The app's four subvolumes |
| `/grants/<name>` | Directories the user granted, via the powerbox |
| `/run/user/<uid>/` | Its Wayland socket and, if granted, its PipeWire remote |
| `/tmp` | Private tmpfs |

Nothing else exists in the view. There is no path to another app's data, to `~/.ssh`, or to `/keystore`.

## Extended attributes

| xattr | Meaning |
|---|---|
| `security.bpf.keylos.prov` | Who created this file: principal, generation, transaction, time. See [Provenance](provenance.md) |
| `security.bpf.keylos.label` | Confidentiality and integrity label (two bytes). Missing means the location default |
| `security.keylos.unit` | The data unit this subvolume or directory belongs to |
| `user.keylos.nosync` | Hint to sync tools: live database or lock file, do not sync |

`security.*` xattrs can only be set with `CAP_SYS_ADMIN`, which no principal has, so apps and agents cannot forge them.

## Default labels by location

| Location | Label (conf / integ) |
|---|---|
| Home data, app data | private / user |
| `~/Downloads`, browser downloads, files received by messaging | public / untrusted |
| Store objects | public / trusted |
| Agent overlay writes | max(base label, session label) |
| `/var/lib/<svc>` | internal / trusted |

Labels feed the [Rule of Two](../06-security/README.md) enforcement in `broker` and `gate`. `strata` preserves and recomputes them on commit.

## Limitations

- btrfs RAID5/6 is not supported. Use single, `raid1`, `raid1c3` or `raid10`.
- Snapshots of several subvolumes taken together are not atomic across subvolumes; they are taken within about 2 s of each other.
- xattr-based metadata (provenance, labels) is lost when files leave keylos through tools that do not preserve `security.*` xattrs.

## Related

- [Snapshots and transactions](snapshots-and-transactions.md)
- [Crypto-shredding](crypto-shredding.md)
- [Users and homes](users-and-homes.md)
- [strata specification §4.2–4.3](../../specs/strata/spec.md)
- [ADR-0020: btrfs on LUKS2 AEAD](../11-decisions/adr-0020-btrfs-luks2-aead.md)
- [ADR-0024: dynamic UIDs per principal](../11-decisions/adr-0024-dynamic-uids-per-principal.md)
