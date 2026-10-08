# State

> How keylos stores everything that changes: user data, app data, system state and configuration. It explains how every change can be inspected, undone, forgotten or restored, and how the system detects tampering and rollback.
> Two components own state: [strata](../../specs/strata/spec.md) (data, snapshots, transactions, units, provenance, backup) and [config](../../specs/config/spec.md) (declarative system configuration). Both are specified (v1.0).

## The three tiers of state

| Tier | What | Owner | Mechanism | Undo |
|---|---|---|---|---|
| System and apps | OS, runtimes, apps, services, agent templates | `depot`, `courier` | Content-addressed generations in the store | Boot or switch to the previous generation |
| Configuration | Everything under `/etc`, policy, persistent grants | `config` | Nickel source → signed config and policy generations | `config revert`, automatic re-activation on failure |
| Data | Homes, app data, projects, `/var` | `strata` | btrfs subvolumes, snapshots, transactions, units | `strata restore`, `undo`, snapshot browsing |

The tiers are deliberately separate:
- The first two are immutable once built and are verified on every access. Code never runs from the data tier.
- The data tier is mutable and snapshotted.

That split is what gives keylos its "reboot heals" property: reboot restores verified code and owner-approved configuration. Malware can't persist as code or configuration, but it can damage or poison data. Data is recoverable from snapshots, and hostile data that keeps re-triggering a parser bug is handled by quarantine in a safe start ([Reboot heals](../05-integrity/reboot-heals.md#safe-start-and-quarantine)).

## Design rules

1. **Every persistent change has an author.** Files carry creation provenance. Transactions, snapshots, config applies and forgets produce receipts in the [ledger](../../specs/ledger/spec.md).
2. **Inspect before commit.** Commands run with `try`, and every agent works on an overlay. The change set is shown before it reaches the live tree.
3. **Forgetting is cryptographic.** Sensitive data lives in sealed units with their own keys. Destroying the key destroys every copy, including snapshots and backups.
4. **Configuration is signed.** A new `/etc` needs the owner's FIDO2 touch, and a TPM counter prevents rolling back to an older signed configuration.
5. **No btrfs quotas.** Retention is count-and-age based, with a documented pruning order under space pressure.

## Pages

| Page | Contents |
|---|---|
| [Filesystem layout](filesystem-layout.md) | Disk layout, subvolumes, mount options, what each principal sees |
| [Snapshots and transactions](snapshots-and-transactions.md) | Snapshot classes and retention, space pressure, `try`, agent merges, conflicts, commit, undo |
| [Config generations](config-generations.md) | Nickel modules, plans, presence-signed apply, activation, revert, drift, adopt, agent proposals |
| [Crypto-shredding](crypto-shredding.md) | Data units, sealed versus plain, unitfs and fscrypt, `forget`, keys and the keystore |
| [Provenance](provenance.md) | Who created a file: the BPF LSM program, the fallback daemon, `why`, limits |
| [Backup and sync](backup-and-sync.md) | Restic-format backups, replicas, restore tests, anchors and rollback detection, sync |
| [Receipt privacy](receipt-privacy.md) | Sealed receipt payloads per human per month, retention and shredding, who reads what |
| [Users and homes](users-and-homes.md) | Humans, homes, app data ownership, login and lock |
| [Durable workflows](durable-workflows.md) | loom: progress that survives attempts and reboots, fresh authority per attempt, durable decisions and effects, cancel, forget, rollback |

## At a glance

```
            ┌──────────────── immutable, verified on access ────────────────┐
  /  /usr   │ OS generation (composefs, fs-verity)                          │
  /etc      │ config generation (signed by owner presence, NV counter)      │
            └───────────────────────────────────────────────────────────────┘
            ┌──────────────── mutable, noexec, snapshotted ─────────────────┐
  /home     │ per-user subvolume ─┬─ .apps/<app>/{config,data,cache,state}  │
            │                     └─ projects (subvolumes)                  │
  /var      │ @var + per-service /var/lib/<svc> subvolumes                  │
  /snapshots│ read-only snapshots, transaction layers, replicas             │
            └───────────────────────────────────────────────────────────────┘
  /keystore   wrapped keys only — never snapshotted, never replicated
  /store      objects + generations (depot)
```

## Related

- [strata specification](../../specs/strata/spec.md)
- [config specification](../../specs/config/spec.md)
- [ADR-0020: btrfs on LUKS2 AEAD](../11-decisions/adr-0020-btrfs-luks2-aead.md)
- [ADR-0022: read-only /etc via confext](../11-decisions/adr-0022-read-only-etc-confext.md)
- [ADR-0032: crypto-shredding](../11-decisions/adr-0032-crypto-shredding.md)
- [ADR-0033: creation-time provenance](../11-decisions/adr-0033-creation-time-provenance.md)
