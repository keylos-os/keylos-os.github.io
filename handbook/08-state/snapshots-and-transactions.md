# Snapshots and transactions

> `strata` keeps read-only snapshots of every data subvolume on a schedule. It also runs commands and agent work as **transactions**: an overlay you can inspect, then commit or abort.
> Commits are crash-safe and always leave an undo point. Agent commits additionally need the owner's approval of the exact change set. Specified (v1.0).

![Transaction lifecycle](../images/transaction-try.svg)

## Snapshot classes

| Class | Applies to | When | Kept |
|---|---|---|---|
| `user` | Homes, app config/data/state, projects | Hourly (only if changed), daily 03:00, weekly, monthly | 24 hourly, 14 daily, 8 weekly, 12 monthly |
| `system` | `/var`, service state | Daily, weekly | 7 daily, 4 weekly |
| `txn` | Pre-commit and base snapshots of transactions | Per transaction | 50 per subvolume / 30 days |
| `update` | `/var` and homes before an OS update | Requested by `courier` | Last 3 |
| `manual` | `strata snapshot` | On request | Until deleted |
| `cache`, `none` | App caches, `/keystore`, temp | Never | — |

A scheduled snapshot is skipped if the subvolume has not changed since the last one (its btrfs generation number did not advance), so idle machines don't accumulate identical snapshots.

### Space pressure

keylos does not use btrfs quota groups; their accounting rescans cause multi-minute stalls. Retention is by count and age. When the disk fills up, `strata` prunes in a fixed order:

| Level | Trigger | Action |
|---|---|---|
| low | < 15 % or < 30 GiB free | Stop hourly snapshots; prune expired transaction leftovers, transaction snapshots older than 7 days, hourly beyond 6 |
| critical | < 5 % or < 8 GiB free | Also prune daily beyond 3, system beyond 1, weekly and monthly beyond 1. Refuse new transactions |

Pinned snapshots are never pruned automatically.

## Transactions

A transaction gives a set of directories a private, writable view while the real directories stay untouched.

```
begin(dirs)            base snapshot of each subvolume  →  overlay(lower = base, upper = new)
   │                   processes see the overlay at the original paths
   ▼
changes / conflicts    computed from the upper layer and the live tree
   ▼
commit                 freeze views → pre-commit snapshot (undo point) → apply via journal
   or abort            discard upper layer
```

| Property | How |
|---|---|
| Cheap start | One btrfs snapshot plus one overlay mount (p50 ≤ 30 ms) |
| Cheap copy-up | Upper and lower are on the same btrfs, so the first write to a 20 GiB file is a reflink, not a copy |
| Correct renames and hardlinks | Overlay options `index=on`, `redirect_dir=on`, `xino=on` |
| No network by default | `Strata.begin` takes a `NetworkPolicy` enum: `deny` (default for `kish try` and bench shares), `gate` (`--net`: egress through gate, recorded as effects) or `inherit` |
| Views reach processes | A process spawned with `SpawnSpec.transaction` gets the transaction's views mounted by warden (`StrataTxn.txnExt`, `TransactionExt.policy`) and `KEYLOS_TXN` set |
| Bounded | Per-transaction upper budget (default 20 GiB); automatic abort after 7 days unless pinned |

### `try` in the shell

```
$ try { make install PREFIX=~/.local; ./migrate-notes.sh ~/notes }
  12 added, 3 modified, 1 deleted   (no conflicts)
  [c]ommit  [a]bort  [d]iff  [k]eep for later
> c
committed x-01JB7…   undo with: undo x-01JB7…
```

### Agent work

Agents always work on overlays: `bench` exports transaction views to the agent's workbench VM as virtio-fs shares. When the agent finishes:

1. `BenchMerge.manifest` freezes a snapshot of the share's overlay and asks strata to **prepare the merge** (`TransactionExt.prepare`). strata captures the live state of every affected path, applies recorded conflict resolutions and clean three-way merges, and stores the result as an immutable **prepared merge** (`pm-…`). Its manifest (`keylos.fsmerge/2`: every changed path with its kind, the expected live state and the resulting digest) and the manifest digest are returned.
2. `aide` stages an `fs.merge` intent through gate whose payload digest is that manifest digest; the T3 prompt on the trusted path shows the diff of the prepared result, exactly what was hashed.
3. The owner's signed approval (a mandate) binds that exact digest.
4. gate's executor calls `BenchMerge.commitShare` with the digest and the mandate, which commits that prepared merge (`PreparedMerge.commit`). strata verifies the mandate, takes a **writer fence** (warden freezes every session that could write into the target, `PrincipalControl.fenceWriters`), re-checks every expected live state, and applies exactly the stored operations: no new merge, no read of the agent's overlay. Stale live state fails with `kl:conflict` and needs a new prepare and a new approval. The pre-commit snapshot is the undo point (`fs.undo` compensator).

Neither the agent nor a concurrent live edit can change the result between approval and commit: the prepared object is immutable, later agent writes stay in the overlay, and writers are frozen while the result is applied ([ADR-0061](../11-decisions/adr-0061-prepared-merges-and-writer-fence.md)).

## Conflicts

`strata` compares three versions of each changed path: the **base** (at begin), **ours** (upper) and **theirs** (live now).

| Situation | Result |
|---|---|
| Only the transaction changed the file | Applied |
| Both changed a text file, different lines | Merged automatically (three-way, line-based) |
| Both changed a text file, same lines | Conflict with standard markers; resolve as ours, theirs or merged |
| File open for writing elsewhere | Conflict `open-elsewhere`; detected with a kernel write-lease test |
| Active SQLite database (WAL/SHM) | Conflict `sqlite-active`; never merged |
| Binary changed on both sides | Conflict; choose a side |
| Device, FIFO or socket created | Refused |
| setuid/setgid bits, `security.*` xattrs | Stripped on commit |

## Encrypted units

Agent workspaces default to sealed units. On kernels without btrfs fscrypt a sealed unit's plaintext is a `keylos.unitfs/1` FUSE view over a ciphertext backing subvolume, so the plaintext directory is not a btrfs target. `Strata.begin` therefore dispatches per storage backend (protocols §7.3.10, [ADR-0065](../11-decisions/adr-0065-encrypted-unitfs-transactions.md)):

| Backend | Base and working copy | Commit | Undo |
|---|---|---|---|
| Plain btrfs | Read-only snapshot plus overlay | Overlay changes applied through the journal | Pre-commit snapshot |
| unitfs (sealed) | Snapshot and writable clone of the **ciphertext** backing; a transaction-specific unitfs view serves only the granted subtree | Logical operations written through the unitfs format into the live backing, after quiesce and a writer fence | Ciphertext pre-commit snapshot |

No plaintext upper, undo or journal content is written outside encrypted storage. Forgetting the unit aborts its transactions, and every artifact is under the unit key anyway. While the owner is locked the views are unavailable and commit returns `kl:unavailable`. Mixed backends, nested units and cross-unit transactions are refused in 1.0.

## Commit modes

| Mode | When | Atomicity |
|---|---|---|
| Atomic | The target is a whole subvolume and no process outside the transaction has it in view | Whole tree, one `RENAME_EXCHANGE` of subvolumes |
| Incremental | Otherwise | Per file: reflink to a temp file, then rename. A journal makes the whole commit roll forward or back after a crash |

After a power cut during commit, the tree is either fully before or fully after the commit, never a mixture. This is integration test IT-06 in the strata spec.

## Undo

Every commit returns a pre-commit snapshot ID. `undo x-…` restores exactly the paths the transaction changed:
- If any of those paths changed again after the commit, undo refuses and lists them.
- `undo --force` overwrites them, after keeping their current content in a guard snapshot. So undo is itself undoable.

## Restoring from snapshots

| Command | Effect |
|---|---|
| `strata snapshots ~/notes` | List snapshots of the subvolume containing `~/notes` |
| `strata browse snap-… ~/notes` | Read-only view of that snapshot |
| `strata restore snap-… ~/notes/todo.md` | Restore one file; current content is kept in a guard snapshot |

## Limitations

- Shared memory mappings and live databases inside the target are refused, not handled.
- Format-aware merges (JSON, TOML) are not done; only line-based merges.
- Effects outside the machine during a transaction with `--net` are not undone by `undo`. They appear in receipts, and agent egress goes through `gate`'s outbox.

## Related

- [Filesystem layout](filesystem-layout.md)
- [Backup and sync](backup-and-sync.md)
- [strata specification §4.4–4.6](../../specs/strata/spec.md)
- [kish specification](../../specs/kish/spec.md)
- [ADR-0027: effect outbox and mandates](../11-decisions/adr-0027-effect-outbox-and-mandates.md)
- [ADR-0028: approval tiers](../11-decisions/adr-0028-approval-tiers.md)
