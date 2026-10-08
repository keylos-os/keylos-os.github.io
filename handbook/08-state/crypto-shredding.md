# Crypto-shredding

> Snapshots, replicas and backups keep everything, including what you deleted. keylos makes deletion real by giving sensitive data its own key: forgetting the data means destroying that key, which makes every copy undecryptable at once.
> Data is grouped into **units**. Sealed units are encrypted per unit; plain units rely on full-disk encryption and best-effort purging. Specified (v1.0).

## The problem

| Copy of your data | Deleted by `rm`? | Deleted by "delete from snapshots"? |
|---|---|---|
| Live file | yes | yes |
| Local snapshots | no | yes, by rewriting each snapshot |
| Replica on another machine | no | only if reachable |
| Restic backup on a NAS or in S3 | no | only after forget + prune on every repository |
| Old backup disk in a drawer | no | no |

Only one approach handles every row: keep the data encrypted under a key that exists in exactly one place, then destroy that key.

## Units

A **unit** is a named set of subvolumes or directories sharing one data key, identified by `u-<ULID>` and recorded in the `security.keylos.unit` xattr.

| Unit | Default mode |
|---|---|
| Home root (`u-home-<user>`) | plain |
| App data, for apps in sensitive categories (messaging, mail, browser profiles, passwords, health, finance) | **sealed** |
| App data, other apps | plain |
| Projects | plain (`--sealed` to opt in) |
| Agent session workspaces and transcripts | **sealed** |
| User-created units (`strata unit create --sealed`) | as chosen |

## Sealed units

The unit key comes from [vault](../../specs/vault/spec.md) and is wrapped by the keystore key in `/keystore`. `/keystore` is never snapshotted, replicated or included in data backups. The key exists in plaintext only in `memfd_secret` memory, which is removed from the kernel's direct map, or in the kernel's fscrypt keyring, and only while the owning user is unlocked.

Two backends implement sealed units:

| | unitfs (default on today's kernels) | native fscrypt |
|---|---|---|
| Available when | Always (KL1) | btrfs fscrypt support is present in the kernel |
| How | A FUSE server per unit presents plaintext; the backing subvolume stores ciphertext files | fscrypt v2 policy on the unit's subvolume |
| Content cipher | AES-256-GCM per 4 KiB block, per-file key | AES-256-XTS |
| Names | AES-SIV, deterministic per directory | AES-256-CTS |
| Speed | 40–70 % of native (sequential) | near native |
| Migration | `strata unit migrate` (automatic when idle) once fscrypt is available | — |

Both backends store **ciphertext on btrfs**. Snapshots, reflinks, send/receive and restic backups therefore all hold ciphertext. Once the key is destroyed, every one of those copies becomes random bytes.

## Forgetting

```
$ strata unit forget "Chat history"
  Unit u-01JB… (sealed, 3 subvolumes, in 41 snapshots, 2 backup targets)
  After this, no copy can be decrypted — including snapshots and backups.
  Touch your security key to confirm.
```

| Step | Effect |
|---|---|
| 1 | T3 approval with presence on the trusted path |
| 2 | Unit unmounted; FUSE server stopped or fscrypt key removed |
| 3 | `vault.forget(unit)` destroys the wrapped key |
| 4 | Live subvolumes deleted |
| 5 | Snapshots and backup runs containing the unit are marked "shredded" in the registry |
| 6 | Receipt `unit.forget` |

After step 3 succeeds, nothing on the system can decrypt any copy. Deleting the ciphertext in steps 4–5 is housekeeping.

## Plain units

Forgetting a plain unit deletes the live subvolumes, deletes or rewrites the local snapshots that contain it, and runs `forget --path` plus prune on reachable backup repositories. The command states clearly that **replicas and backups out of reach keep plaintext copies**.

## Locking and suspend

Sealed units are unmounted when the user locks the screen or the machine suspends (`lockOnSuspend`, on by default), and their keys leave memory. Apps using them are paused by `warden` and see the data again after unlock.

## Leaving keylos

`strata unit export <unit> --to <dir>` decrypts a unit into a plain directory. It requires presence. The unitfs format is documented in the strata spec, so the data is never locked into keylos.

## Limitations

- unitfs costs throughput; sealed is therefore not the default for every app.
- AES-SIV filenames reveal when two files in the same directory have the same name. Accepted.
- Crypto-shredding protects against future recovery of copies. It does not help if the data was already copied out in plaintext (sync peers, mail attachments).
- SSD wear-levelling and TRIM are not deletion guarantees. Only key destruction counts.

## Related

- [Filesystem layout](filesystem-layout.md)
- [Backup and sync](backup-and-sync.md)
- [strata specification §4.7](../../specs/strata/spec.md)
- [vault specification](../../specs/vault/spec.md)
- [ADR-0032: crypto-shredding](../11-decisions/adr-0032-crypto-shredding.md)
