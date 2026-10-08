# keylos/strata — state, snapshots, transactions, crypto-shredding and provenance

| | |
|---|---|
| Repository | `github.com/keylos-os/strata` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `strata` (tier-0 service daemon), `strata-unitfs` (per-unit FUSE filesystem server), `strata-provd` (provenance join daemon), `provenance.o` (BPF LSM program, installed in the **OS generation** at `/usr/lib/keylos/bpf/strata/provenance.o`, protocols §9.3), `strata` CLI, Rust crates `strata-core`, `strata-merge`, `strata-unitfs-format` |
| Depends on | `keylos-protocols 1.0` (crates `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-labels`, `keylos-presence`, `keylos-tpm-registry`); runtime services `warden`, `vault`, `ledger`, `broker`, `hearth` (TPM provisioning), `gate`, `devd`, `atrium` (notify), `journal`; callers include `cri` (pod volumes) and `gate` (`fs.merge` compensation); TPM 2.0 |
| Provides | capwire interface `Strata` (`strata.capnp`, protocols §7.3.10); system interfaces `StrataTxn`, `TransactionExt`, `StrataAdmin`, `StrataHomes`, `StrataVolumes` (`strata-sys.capnp`, protocols §7.5.7); facet-restricted `Transaction` capabilities; the shared merge manifest `keylos.fsmerge/2` (protocols §20.12); the strata-internal formats `keylos.anchor/1`, `keylos.unitfs/1` |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`strata` owns **all mutable data state** on a keylos machine: everything under `/var`, `/home`, `/keystore` (wrapped keys only) and `/snapshots`. It provides:

1. **Subvolume management.** It creates, names, tracks and removes the btrfs subvolumes that hold users, per-app data, projects and system state.
2. **Snapshots.** Scheduled and event-driven read-only snapshots with count-and-age retention, plus free-space-pressure pruning. No btrfs qgroups.
3. **Transactions.** Overlay-based, inspectable, commit-or-abort execution of commands (`kish try { … }`) and agent work (`fs.merge`), with conflict detection, three-way text merge, **immutable prepared merges** (what is approved is exactly what is committed), a writer fence, crash-safe commit and `undo`. Targets may be plain btrfs directories or sealed `keylos.unitfs/1` units (§4.5.10).
4. **Data units and crypto-shredding.** Per-unit data keys from `vault`. Sensitive units are encrypted per unit, so `forget` makes every live copy, snapshot copy and backup copy unreadable.
5. **User-data rollback detection.** Anchors bound to a TPM NV monotonic counter.
6. **Creation-time provenance.** A BPF LSM program plus a join daemon write `security.bpf.keylos.prov` on every file created on keylos-managed filesystems. `why` answers "who created this file".
7. **Backup and replication.** Restic-format repositories written through `rustic_core`, and btrfs send/receive replicas, always taken from read-only snapshots. A monthly restore test is built in. Local backup disks are keylos-formatted LUKS2 disks; no other removable medium is ever mounted on the host (protocols §9.5).
8. **Pod volumes.** `emptyDir` and local PersistentVolume subvolumes for `cri` (`StrataVolumes`, protocols §7.5.7, §21.6), with usage enforcement without qgroups.
9. **Guest homes.** Ephemeral, never-snapshotted homes for guest sessions, sealed with a key that exists only in `strata`'s memory (`StrataHomes.createEphemeralHome`).

### 1.1 Non-goals

- Byte-level data lineage ("where did these bytes come from"). Only creation is recorded (ADR-0033).
- Live synchronisation of documents between machines. That is the Syncthing app's job, run confined as a tier-1 app. `strata` only marks what must not be synced live (§4.11).
- Versioning of the OS, apps or configuration. Those are generations owned by `depot`, `courier` and `config`.
- Undo of effects outside the machine. That is `gate`'s outbox and compensation (protocols §14).
- RAID5/6. Supported layouts are single, `raid1`, `raid1c3` and `raid10`.
- Mounting removable media (USB sticks, SD cards, optical discs, phones). Those are mounted only inside media VMs (`bench`, protocols §9.5). The single exception is a keylos backup disk (§4.10.5).

---

## 2. Context and embedded contracts

`strata` is a tier-0 service that `warden` starts early in boot, after `vault` and `ledger`. It serves two things on capwire:
- `Strata` (`strata.capnp`, protocols §7.3.10);
- the system interfaces `StrataTxn`, `TransactionExt`, `StrataAdmin`, `StrataHomes` and `StrataVolumes` (`strata-sys.capnp`, protocols §7.5.7).

Like every tier-0 service, it registers its `ServiceHost` with `warden` through `Bootstrap` on fd 3 (protocols §7.5.1) and receives route connections through `ServiceHost.accept`.

### 2.1 Callers

| Caller | Facet (protocols §19.2) | Uses |
|---|---|---|
| `kish` and other `shell` processes; apps with the route | `user` | `try` (`begin` plus `StrataTxn`), `undo`, `why`, `snapshots`, `restore`, `createUnit` |
| The `strata` CLI | `cli` | As `user`, plus `forget` |
| `bench` | `bench` | Overlay shares of workbench VMs: `begin`, `StrataTxn` (including `preparedFor`), `TransactionExt.prepare`, `TransactionExt.bindWorkflow`, `PreparedMerge.commit`, `PreparedMerge.status` |
| `aide` | `aide` | Agent transactions: `begin`, `StrataTxn` (including `preparedFor`), `TransactionExt.bindWorkflow` |
| `compat` | `compat` | `createUnit`, `forget` for units of legacy apps |
| `warden` | `warden` | Mounting transaction views for `SpawnSpec.transaction` (`StrataTxn`, after the owner check of §4.5.3); `StrataAdmin.mountUnit` for app units (lazy creation, §4.12) |
| `hearth` | `hearth` | `StrataHomes` (including `createEphemeralHome` for guests); `StrataAdmin.lockUnits`/`unlockUnits` at lock, suspend and login |
| `courier` | `courier` | `StrataAdmin.preUpdate` before an OS update |
| `gate` | `gate` | `Strata.undo`, only as the `fs.undo` compensation of an `fs.merge` intent (§4.5.9) |
| `cri` | `cri` | `StrataVolumes` (pod `emptyDir` and local PersistentVolumes, §4.14) |
| `config`, owner `shell` | `admin` | Everything, including `StrataAdmin` |

`config` sets retention and backup policy through the config generation (§10), not through calls.

### 2.2 Dependencies

| Service | Facets held | Used for |
|---|---|---|
| `warden` | `service`, `strata` | Spawning `strata-backup` and `strata-provd`; `identify`; `FdStore`; `PrincipalControl.events(watcher, replay = true)` (with `cgroupId`; replay of running sessions first) and `mountView` (provenance map, atomic-mode check, home deletion) |
| `vault` | `strata` | `dataKey` and `forget`, for unit keys and strata-internal keys (§4.7.6, §4.10) |
| `ledger` | `writer` (includes `reader`) | Receipts; `Ledger.serviceKey("broker")` for the `service/broker` public key that verifies non-presence mandates (§6.2.2) |
| `broker` | `workflow` | `BrokerWorkflow.verify` (bind a transaction to the current attempt of its workflow) and `BrokerWorkflow.record` (current epoch, state and horizon of a bound transaction's workflow), §4.5.11 |
| `broker` | `principal`, `system`, `label-authority` | Device tokens for keylos backup disks (class `storage-backup`); `BrokerSystem.requestFor` presence approvals with strata's **own** session as subject (§6.2.3); `rootsChanged` after a restore that replaces a root; `LabelAuthority.labelOf`/`raiseFor` (§6.1) |
| `hearth` | `tpm`, `system`, `presence` | `HearthTpm.defineSpace(0x01300107)` and `HearthTpm.recreateKey(0x81000110, …)` when the anchor objects must be re-created (§4.8); `HearthSystem.owners` (owner-presence keys for mandate verification, §6.2.2); `Hearth.presence` (purpose `boot.recreate-key`) |
| `gate` | `client` | Backup and replica egress |
| `devd` | `client`, `service` | `PowerEvents` (battery state, suspend) |
| `atrium` | `notify` | Critical notifications |
| `journal` | `client` | Logs and metrics |
| TPM 2.0 | `/dev/tpmrm0` fd passed by `warden` | Anchors (§4.8) |

**Files read from other repositories** (allowed by protocols §10.7): `/etc/keylos/strata/snapshot-exclude.list` (rendered by `config`, §4.4.1); `/var/lib/keylos/tpm/nv-auth/0x01300107.sealed` (the anchor counter's sealed authValue, written by `installer` or `hearth`, §4.8). `strata` reads no other repository's files.

### 2.3 Embedded contracts

Appendix A holds a verbatim copy of every protocols contract `strata` implements or consumes, so this file can be implemented with only the `keylos-protocols` 1.0.0 crates. If a copy differs from protocols, protocols wins.

| Contract | Use in strata | Appendix |
|---|---|---|
| Platform baseline and kernel feature levels (protocols §2) | Feature probing; hibernation unsupported | A.1 |
| Identifiers (protocols §3.2, §3.4, §3.5) | Transaction, snapshot and unit IDs; principals in provenance and receipts | A.2 |
| DSSE envelopes and presence signatures (protocols §5.1, §5.3) | Mandate verification for `fs.merge` and presence approvals | A.3 |
| capwire model, routes and facets (protocols §7.1, §7.2) | Serving and calling every interface | A.4 |
| `common.capnp` and error codes (protocols §7.3.1) | Every call | A.5 |
| `strata.capnp` (protocols §7.3.10) | **Implemented** | A.6 |
| `strata-sys.capnp` (protocols §7.5.7) | **Implemented** | A.7 |
| `warden.capnp` (protocols §7.3.2) | `SpawnSpec.transaction`, `identify`, spawning `strata-backup` | A.8 |
| `warden-sys.capnp` (protocols §7.5.1) | `Bootstrap`, `ServiceHost` (implemented), `PrincipalControl`, `FdStore` | A.9 |
| `vault.capnp` and secret delivery (protocols §7.3.6, §20.10) | Unit keys and internal keys | A.10 |
| `ledger.capnp` (protocols §7.3.5) | Receipts and receipt lookup | A.11 |
| `gate.capnp` (protocols §7.3.7) | Backup egress | A.12 |
| `broker.capnp`, `broker-sys.capnp` (protocols §7.3.3, §7.5.2) | Grants, `requestFor`, `rootsChanged`, `LabelAuthority` | A.13 |
| `prompt.capnp` (protocols §7.3.4) | `TrustedPrompt.notify` | A.14 |
| `devd-sys.capnp` (protocols §7.5.8) | `PowerEvents` | A.15 |
| Confinement, code integrity, devices (protocols §9) | Self-confinement; `noexec` data mounts; BPF loading; backup disks | A.16 |
| Filesystem and system layout (protocols §10) | Subvolumes, xattrs, UIDs, environment | A.17 |
| Receipts, receipt privacy and the event registry (protocols §13.1, §13.4, §19.3) | Receipts emitted (§9.2) | A.18 |
| Labels, effects, approval tiers, mandates (protocols §14) | Label recomputation at commit; `fs.merge` mandates | A.19 |
| Facets (protocols §19.2) | Facets served and held | A.20 |
| TPM objects (protocols §19.6) | Anchor counter and HMAC key | A.21 |
| Boot trust set, owner registry, merge manifest (protocols §20.1, §20.3, §20.12) | Owner-registry entry format (presence keys arrive through `HearthSystem.owners`); agent merges through `bench` | A.22 |
| Devices, removable media and DMA (protocols §9.5) | Backup-disk exception; no other host mounts of removable media | A.16 |
| Cross-repository files (protocols §10.7) | Files `strata` may read | A.17 |
| Cluster-node storage (protocols §21.6) and resource classes (protocols §2.3) | `StrataVolumes` | A.23 |
| Operating rules (protocols §14.5) | Offline behaviour of backups | A.19 |
| `hearth.capnp`, `hearth-sys.capnp` (protocols §7.3.12, §7.5.3), consumed | `Hearth.presence`, `HearthSystem.owners`, `HearthTpm.defineSpace`/`recreateKey` | A.24 |
| `loom-sys.capnp` (protocols §7.5.25), consumed | `BrokerWorkflow.verify` and `record` for workflow-owned transactions (§4.5.11) | A.25 |
| Durable execution and the effect executor contract (protocols §20.25, §20.26) | Workflow-owned transactions, retained prepared merges and their completion records (the `transactional` strategy of `fs.merge`) | A.26 |

### 2.4 Optional kernel features

`strata` probes for these features in addition to the protocols feature level:

| Probe | Detection | Effect |
|---|---|---|
| `btrfs-fscrypt` | `FS_IOC_GET_ENCRYPTION_POLICY_EX` on a btrfs directory returns anything other than `EOPNOTSUPP`/`ENOTTY`, and a test policy can be set on a scratch subvolume | Data units use native fscrypt (§4.7.2) |
| `bpf-init-inode-xattr` | BTF of the running kernel contains the kfunc `bpf_init_inode_xattr` | The provenance xattr is written in the kernel at creation, and `strata-provd` runs in verify-only mode (§4.9) |
| `overlay-index-redirect` | Mounting a scratch overlay with `index=on,redirect_dir=on,xino=on,metacopy=off` succeeds | Required. Without it, `begin` fails with `kl:unsupported` |
| `reflink` | `FICLONE` succeeds between two scratch files | Required for copy-up budgets; always true on btrfs |

---

## 3. Requirements

### 3.1 Subvolumes

- **REQ-STRATA-001** `strata` MUST be the only principal that creates, deletes, snapshots or changes the read-only property of btrfs subvolumes under `@var`, `@home` and `@snapshots`. `@store` is managed by `depot`, and `@keystore` is created once by `installer`.
- **REQ-STRATA-002** Every per-user home (`/home/<user>`), every per-app-per-user data directory (`/home/<user>/.apps/<app>/{config,data,cache,state}`), every project directory registered with `strata project add`, and every service state directory `/var/lib/<service>` MUST be a separate btrfs subvolume. That gives each its own snapshot, retention, backup and unit policy.
- **REQ-STRATA-003** Subvolumes MUST be mounted or exposed `nosuid,nodev,noexec`. `strata` MUST NOT create a subvolume reachable through a path that is mounted exec.
- **REQ-STRATA-004** `strata` MUST maintain a subvolume registry (§4.2) that maps subvolume UUID → kind, owner human, owning app/service, unit ID, snapshot policy and backup class. The registry is the source of truth for every scheduled operation.

### 3.2 Snapshots

- **REQ-STRATA-010** Snapshots MUST be read-only btrfs snapshots stored under `/snapshots/<subvol-uuid>/<snap-id>`.
- **REQ-STRATA-011** `strata` MUST NOT enable or depend on btrfs quota groups. If qgroups are found enabled at startup, `strata` MUST disable them (`BTRFS_IOC_QUOTA_CTL` with `BTRFS_QUOTA_CTL_DISABLE`), log a warning record with field `event = "qgroups-disabled"` to the journal, and emit the receipt `x-strata.qgroups-disabled` (§9.2).
- **REQ-STRATA-012** Retention MUST be count-and-age based per snapshot class (§4.4) and configurable through the config generation.
- **REQ-STRATA-013** When free space falls below the pressure thresholds (§4.4.3), `strata` MUST prune unpinned snapshots in the documented order until the threshold clears or nothing prunable remains. Pinned snapshots MUST NOT be pruned automatically.
- **REQ-STRATA-014** `/keystore` and every subvolume of kind `keystore` or `unit-backing-keys` MUST NOT be snapshotted, replicated or backed up by the snapshot machinery.
- **REQ-STRATA-015** Every snapshot creation and deletion MUST emit a receipt (`snapshot.create`, `snapshot.delete`). Scheduled snapshots MAY be batched into one receipt per scheduler tick, listing all IDs.

### 3.3 Transactions

- **REQ-STRATA-020** `Strata.begin(dirs, networkPolicy)` MUST:
  - check that the caller may write each passed dirfd (§6.2). Holding the dirfds is the authority; there are no call-attached tokens (protocols §7.1);
  - create, for each passed dirfd, a view whose lower layer is a **read-only base snapshot** of the directory's containing subvolume taken at begin time, scoped to that directory: an overlay for plain btrfs targets, an encrypted working clone for sealed unitfs targets (§4.5.10, REQ-STRATA-032);
  - return the views as `O_PATH` dirfds of detached mounts via `Transaction.view`;
  - never let a write from the view reach the live tree before `commit`.
- **REQ-STRATA-021** Overlay mounts MUST use `index=on,redirect_dir=on,xino=on,metacopy=off`. Upper and work directories MUST be on the same btrfs filesystem as the lower base snapshot, so copy-up uses reflinks.
- **REQ-STRATA-022** `networkPolicy` is the `NetworkPolicy` enum (`deny`, `gate`, `inherit`; protocols §7.3.10). `strata` records it in the transaction record and the `txn.begin` receipt, and returns it from `TransactionExt.policy` (protocols §7.5.7). Enforcement happens at spawn: `warden` reads it when it spawns a process with `SpawnSpec.transaction` and configures that process's network namespace accordingly (§4.5.3, §4.5.4). `inherit` MUST be refused with `kl:denied` unless the caller is a `shell` principal.
- **REQ-STRATA-023** `Transaction.changes` MUST report every added, modified, deleted, renamed or metadata-changed path. Renames are reported as `renamed` with `from`, using overlay redirect xattrs.
- **REQ-STRATA-024** `Transaction.conflicts` MUST report, at minimum:
  - paths changed in the live tree since begin, where both sides changed;
  - files open by any process outside the transaction;
  - SQLite databases (and their `-wal`, `-shm` and `-journal` siblings) that are active;
  - binary files changed on both sides;
  - type changes on both sides (file ↔ directory ↔ symlink);
  - special files (devices, FIFOs, sockets) created in the upper layer.
- **REQ-STRATA-025** Every commit MUST go through an **immutable prepared merge** (§4.5.6, protocols §7.5.7 `PreparedMerge`):
  1. `prepare` freezes the views read-only, captures the live state of every affected path (`expectedLive`), applies the recorded resolutions and clean three-way merges, and stores the result as an immutable prepared object whose `keylos.fsmerge/2` manifest digest is the `fs.merge` payload digest (protocols §20.12);
  2. `PreparedMerge.commit` takes a writer fence, revalidates every `expectedLive` entry, takes a pre-commit snapshot of each affected live subvolume (the undo point), applies **exactly** the stored operations crash-safely via the commit journal, and returns the pre-commit snapshot ID.

  If any conflict is unresolved, `prepare` MUST fail with `kl:conflict`. A three-way text merge that succeeds without conflict markers counts as resolved, and its result is part of the prepared object. Commit MUST NOT merge again, read the transaction's views, or include anything written after `prepare`. `Transaction.commit` (shell-origin transactions) is `prepare` followed immediately by `PreparedMerge.commit` without a mandate.
- **REQ-STRATA-026** After a crash during commit, `strata` MUST, before accepting new transactions on the affected subvolumes, either complete the commit (if the journal reached `applied`) or roll back to the pre-commit snapshot (otherwise). Either way it emits a receipt.
- **REQ-STRATA-027** `undo(txn)` MUST restore each path the transaction changed to its pre-commit content, provided the path has not changed since commit. Otherwise `undo` fails with `kl:conflict`, listing the paths. `undo --force` overwrites them, but only after preserving the current content in a new snapshot.
- **REQ-STRATA-028** Transactions begun on the `bench` or `aide` facets (agent work, `fs.merge`) MUST be committed only through `PreparedMerge.commit(mandate)` of a prepared merge of that transaction, with a mandate whose `fs.merge` digest equals that prepared merge's manifest digest and that passes the checks in §6.2. `Transaction.commit` on such a transaction MUST fail with `kl:needs-approval`; `TransactionExt.commitWithMandate` MUST fail with `kl:unsupported` on every transaction (superseded before release, protocols §7.5.7). Transactions begun on the `user` or `cli` facets by a `shell` principal MAY commit with `Transaction.commit`, without a mandate.
- **REQ-STRATA-029** An uncommitted transaction older than its TTL (default 7 days; config `strata.transactions.ttl`) MUST be aborted automatically, emitting `txn.abort` with `reason: "ttl"`, unless it is pinned.
- **REQ-STRATA-030** A prepared merge MUST be immutable: its stored content (reflinked copies for btrfs targets, ciphertext for unitfs targets), operations and manifest MUST NOT change after `prepare` returns. Writes to the transaction's views after `prepare` (late agent writes) MUST NOT reach the prepared object; a further `prepare` creates a **new** prepared merge with a new `pm-…` ID and digest, which needs a new approval. At most one prepared merge per transaction is committable; preparing again discards the previous one.
- **REQ-STRATA-031** `PreparedMerge.commit` MUST hold a writer fence (`PrincipalControl.fenceWriters`, protocols §7.5.1) over every affected target for the whole interval from revalidation to the journal reaching `applied`, excluding only the transaction's own frozen sessions. If the fence cannot be taken (a non-freezable writer can write the target) commit MUST fail with `kl:conflict` and reason `writer-unfenceable`; if the fence ends (30 s limit, warden restart) before `applied`, `strata` MUST roll back from the pre-commit snapshot and return `kl:unavailable`. Revalidation alone is never treated as sufficient.
- **REQ-STRATA-032** `begin` MUST dispatch each target to a registered storage backend: plain btrfs directories use the overlay backend (§4.5.2); plaintext views of sealed units served by `strata-unitfs` (identified from `strata`'s own mount registry, never from client claims) use the unitfs backend (§4.5.10). Other filesystems, mixed backends in one transaction, nested units and targets spanning more than one unit MUST fail with `kl:unsupported`.
- **REQ-STRATA-033** For unitfs targets, no plaintext content, plaintext name or plaintext undo state of the unit MAY be written outside the unit's ciphertext backing format: base snapshots, working copies, prepared results, undo snapshots and journals hold ciphertext or only ciphertext-side identifiers. Sensitive journal fields (paths) are encrypted under a key derived from the unit key.
- **REQ-STRATA-034** `forget(unit)` MUST first abort every open transaction and discard every prepared merge with a target in that unit (`txn.abort` reason `forget`); afterwards every artifact of those transactions is undecryptable because it is held only under the unit key. While a unit is locked (§4.7.6) its transaction views are unavailable and `prepare`/`commit` fail `kl:unavailable`.

### 3.4 Data units and forgetting

- **REQ-STRATA-040** A data unit is a named set of subvolumes or directories sharing one data key. The unit ID grammar is `u-` + ULID, with an optional human alias. Unit IDs are written to `security.keylos.unit` on the unit root.
- **REQ-STRATA-041** Units have a mode: `sealed` (contents encrypted with the unit key; forgettable by key destruction) or `plain` (only full-disk LUKS2; forgettable best-effort, §4.7.5). The default mode per subvolume kind is in §4.7.1.
- **REQ-STRATA-042** For `sealed` units, file contents and file names MUST be encrypted with keys derived only from the unit key. The unit key MUST exist outside `vault` only as a `memfd_secret` mapping inside `strata` or `strata-unitfs`, or inside the kernel keyring for native fscrypt.
- **REQ-STRATA-043** `forget(unit)` on a sealed unit MUST:
  1. obtain a T3 approval with presence through `BrokerSystem.requestFor`, with `strata`'s own session as the subject and the requesting principal named in the rendering (§6.2.3). The exceptions are `StrataHomes.deleteHome(user, forget = true)` from `hearth`, which has already required presence for the user deletion, and the ephemeral units of guest homes (§4.15), which need no approval;
  2. unmount the unit;
  3. call `vault.forget(unit)`;
  4. delete the live subvolumes;
  5. mark all snapshots and backups containing the unit as "shredded" in the registry.

  After step 3 succeeds, no copy of the unit content is decryptable by the system.
- **REQ-STRATA-044** `forget` on a plain unit MUST delete the live subvolumes and **purge** the unit's paths from every local snapshot (§4.7.5), and MUST warn that replicas and backups keep plaintext copies unless the backup class is `sealed-only`.

### 3.5 Rollback detection

- **REQ-STRATA-050** `strata` MUST maintain the anchor (§4.8), bound to the TPM NV counter `strata-anchor-counter` (`0x01300107`, protocols §19.6) and the anchor HMAC key `0x81000110`. It MUST update the anchor at least hourly while data changed, at every clean shutdown, and after every transaction commit (rate-limited to one counter increment per 60 s). It reads the counter through the public `NV_Read` policy branch and writes it with the authValue unsealed from `/var/lib/keylos/tpm/nv-auth/0x01300107.sealed` (protocols §10.7, §19.6).
- **REQ-STRATA-051** At startup `strata` MUST verify the anchor. On a mismatch that indicates rollback, it MUST:
  - refuse to start scheduled pruning and backups;
  - emit `anchor.rollback-detected`;
  - raise a critical `TrustedPrompt.notify`;
  - expose the state through `strata status`.

  It MUST NOT delete data automatically.

### 3.6 Provenance

- **REQ-STRATA-060** Every regular file, directory, symlink and special file created on `@var` or `@home` MUST receive `security.bpf.keylos.prov` within 1 s of creation in fallback mode, or atomically at creation when the `bpf-init-inode-xattr` kfunc is available.
- **REQ-STRATA-061** The provenance record MUST identify the creating principal from kernel-observed state (the cgroup ID at creation time), never from process-supplied data.
- **REQ-STRATA-062** `why(fd)` MUST return the provenance of the file the fd refers to, or `kl:not-found` if it has none (for example, created before keylos or copied by a tool that drops xattrs).

### 3.7 Backup and replication

- **REQ-STRATA-070** Backups MUST be taken from read-only snapshots, never from live subvolumes.
- **REQ-STRATA-071** The backup format MUST be a restic-compatible repository (format version 2) written via `rustic_core`, so standard restic tools can restore it.
- **REQ-STRATA-072** Repository passwords MUST be derived from `vault`-held keys (`Vault.dataKey("strata:backup:<target>")`, §4.10.2). They MUST NOT appear in configuration, the environment or argv.
- **REQ-STRATA-073** Sealed units MUST be backed up as their ciphertext backing store, so forgetting a unit also shreds its backed-up copies.
- **REQ-STRATA-074** `strata` MUST run a restore test for every backup target at least every 30 days by default. The test restores a random sample into a scratch subvolume, verifies it, and records `backup.restore-test`. A failed or overdue test MUST raise a warning notification.
- **REQ-STRATA-075** Network targets MUST be reached via `Gate.connect` with a token granted to `strata` by policy. `strata` MUST NOT open network sockets directly.
- **REQ-STRATA-076** While the revocation age exceeds 30 days or trusted time is unavailable (protocols §3.6, §14.5), backups keep running, but restore tests do not mark a target `ok` without trusted time; status shows the reason.

### 3.8 Pod volumes

- **REQ-STRATA-080** `StrataVolumes` MUST be served only on facet `cri` (protocols §19.2).
- **REQ-STRATA-081** `create(podId, name, kind, sizeBytes)` MUST create a btrfs subvolume (kind `PodVolume`) under `/var/lib/keylos/strata/volumes/` and return an `O_PATH` dirfd of it. Kind `emptyDir` lives under `pods/<podId>/<name>` and is deleted at `release` (and at the next start if `cri` no longer reports the pod). Kind `local` lives under `local/<name>`, is keyed by `name` alone, and survives pod deletion until `release`.
- **REQ-STRATA-082** Pod volumes MUST NOT be snapshotted, replicated or backed up (snapshot class `none`, backup class `none`), unless config `strata.volumes.snapshotLocal` is true, in which case `local` volumes get the `system` class.
- **REQ-STRATA-083** `sizeBytes` MUST be enforced without qgroups: `strata` measures usage every `strata.volumes.usageScanSecs` (default 30) and reports volumes over their limit in `usage(podId)`; `cri` evicts (protocols §7.5.7, §21.6). A volume above 2 × its limit is additionally made read-only (`BTRFS_IOC_SUBVOL_SETFLAGS`) until `release` or until usage drops below the limit.
- **REQ-STRATA-084** The on-disk owner of a pod volume root is the reserved `_cluster` UID `0x0FFF0000` (protocols §10.3; never allocated to a process), mode `0755`, and the subvolume is reachable on the host only by `strata` and through the dirfd returned to `cri`; `cri` and `warden` expose it to containers only through idmapped mounts (protocols §7.5.1 `GrantMounts.idmappedDir`, `PodContext`), so on-disk UIDs inside the volume equal container-visible UIDs and stay stable across reboots. `strata` MUST refuse `create` if UID `0x0FFF0000` is found owning any file outside `@var/cluster` (a sign that the reserved UID leaked into an allocator) and report it as a critical integrity error.
- **REQ-STRATA-085** At start and after every `PrincipalControl.events` reconnect, `strata` and `strata-provd` MUST subscribe with `replay = true` and rebuild their live-session sets and the provenance principal map from the replayed `spawned` events before treating any session as absent.

### 3.9 Guest homes

- **REQ-STRATA-090** `StrataHomes.createEphemeralHome(user, uid)` MUST only accept usernames with the reserved `guest-` prefix (protocols §3.3). It creates `/home/<user>` as a subvolume of kind `GuestHome` with snapshot class `none` and backup class `none`, and seals it as unit `u-guest-<user>` whose key is 32 random bytes generated in `strata` (never obtained from or stored in `vault`) and held only in `memfd_secret` memory.
- **REQ-STRATA-091** `deleteHome(<guest user>, forget)` MUST drop the key, delete the subvolume and its unitfs backing store, and remove the registry entries, regardless of `forget`. At start, `strata` MUST delete every `GuestHome` subvolume left over from a crash or power loss: its key no longer exists, so its content is unreadable.
- **REQ-STRATA-092** Guest homes MUST NOT be mounted through `mountUnit` for any principal outside the guest's own sessions, and MUST NOT be the target of `begin` from another human.

### 3.10 Removable media and backup disks

- **REQ-STRATA-095** `strata` MUST NOT mount any filesystem from removable media, except a **keylos backup disk**: a removable block device of class `storage-backup` (granted by policy through a device token, protocols §9.5) whose LUKS2 header carries a `keylos-backup` token that verifies against this machine's backup-disk key (§4.10.5). On a verification failure `strata` releases the device without mounting anything.

### 3.11 Transaction ownership

- **REQ-STRATA-097** Every transaction records its **owner session**: the session of the principal that called `begin`. `TransactionExt.owner()` returns it (protocols §7.5.7). On the `warden` facet, `strata` serves `txnExt` for any `Open` transaction, and `warden` MUST check that the spawner's session equals `owner()` or descends from it before mounting views. On every other facet, `txnExt` answers only for transactions whose owner is the caller's session or one of its session ancestors. `StrataTxn.prepared(id)` follows the same ownership rule and is not served on the `warden` facet.

### 3.13 Workflow-owned transactions (durable execution)

A transaction begun for an attempt of a durable workflow (protocols §20.25) belongs to the workflow, not to the attempt's session, so a fresh attempt after a restart or reboot reaches its retained prepared merge and the merge's completion record. Approval and commit rules (REQ-STRATA-025, REQ-STRATA-028, REQ-STRATA-030, REQ-STRATA-031, §6.2.2) are unchanged.

- **REQ-STRATA-100** `TransactionExt.bindWorkflow(binding)` (facets `bench`, `aide`) MUST verify the binding with `BrokerWorkflow.verify(binding, owner)` for the transaction's owner session (REQ-STRATA-097) and then record `{workflow, attempt, epoch}` in the transaction record durably (registry commit, `fsync`) before returning. It MUST be idempotent for the same workflow, fail `kl:conflict` when the transaction is bound to another workflow or the binding is stale (`verify` returned `kl:conflict`), fail `kl:revoked` when the workflow is cancelled, and fail `kl:denied` on transactions begun on any facet other than `bench` or `aide`. It writes `x-strata.txn.bind`.
- **REQ-STRATA-101** `StrataTxn.preparedFor(id, binding)` (facets `bench`, `aide`) MUST return the `PreparedMerge` only when its transaction is bound to `binding.workflow` and `BrokerWorkflow.record(binding.workflow)` reports state `active`, `epoch = binding.epoch` and `attempt = binding.attempt`; in every other case (unknown ID, unbound or foreign transaction, stale epoch, cancelled or forgotten workflow) it MUST fail with `kl:not-found`, so prepared-merge IDs of other workflows are not confirmed. It does not require session ancestry.
- **REQ-STRATA-102** For a bound transaction, the capabilities reached through `txnExt` and `prepared` by session ancestry (REQ-STRATA-097; for `bench` and `aide` transactions the owner is the calling service's session) MUST refuse every mutating method (`prepare`, `resolve`, `PreparedMerge.commit`, `PreparedMerge.discard`, `Transaction.abort`) with `kl:not-found` once the recorded binding is no longer the workflow's current claim; read methods (`id`, `changes`, `diff`, `manifest`, `PreparedMerge.status`) stay available, so `bench` can report a completion record (`BenchMerge.preparedStatus`) after a restart. A newer attempt mutates only through `preparedFor` with its current binding. `warden`'s view mounting (facet `warden`) is unchanged.
- **REQ-STRATA-103** `PreparedMerge.status()` MUST return the durable completion record of the prepared merge: `prepared` (`Ready`, also while a commit is running), `committed` with the commit's transaction ID and its pre-commit (undo) snapshot ID (the first one when there are several subvolumes; all are in the `txn.commit` receipt), `discarded`, or `stale`. A second `commit` while one is running MUST fail `kl:unavailable`. Crash recovery (§4.5.6) runs before `strata` serves any request, so `status` never reports an interrupted commit as `prepared` and `committed` at once.
- **REQ-STRATA-104** **Idempotent commit.** `PreparedMerge.commit(mandate)` on a `Committed` prepared merge with a mandate that passes §6.2.2 checks 1–5 for its digest MUST return the stored pre-commit snapshot without applying anything, writing no second `txn.commit`. An interrupted commit is rolled back (§4.5.6) and the prepared merge returns to `Ready`: it stays committable with the same mandate (the approval ID was not consumed, §6.2.2 check 6), and revalidation (§4.5.6 step 3) refuses it if the live tree changed meanwhile.
- **REQ-STRATA-105** **Retention.** The completion record of a prepared merge of a bound transaction (ID, manifest digest, state, transaction ID, pre-commit snapshot IDs) MUST be kept at least until 30 days after the later of the workflow's horizon (`BrokerWorkflow.record`) and the record's last state change; other completion records at least 30 days. The prepared content store is deleted as before (1 h after commit or discard); only the record is retained. A bound transaction that is not committed MUST NOT be aborted by the TTL (REQ-STRATA-029) before its workflow's horizon.
- **REQ-STRATA-106** **Cancelled and forgotten workflows.** When `BrokerWorkflow.record` reports a bound transaction's workflow `cancelled` or `forgotten` (checked on every access and by an hourly sweep), `strata` MUST abort its open transactions (`txn.abort` reason `workflow-cancelled`) and discard its `Ready` prepared merges; for `forgotten` it MUST also delete their prepared stores and reduce completion records to `{id, digest, state}`. Committed transactions stay committed and keep their undo snapshots under ordinary retention.
- **REQ-STRATA-107** For a bound transaction `PreparedMerge.commit` MUST require `constraints.workflow` in the mandate to equal the bound workflow (protocols §14.4) and accepts that in place of §6.2.2 check 5 (principal ancestry): the deciding attempt's session is not an ancestor of the committing one. A mandate without `constraints.workflow`, or naming another workflow, MUST be refused with `kl:denied`.

### 3.12 Safe start and quarantine

Reboot restores verified code and owner-approved configuration. Writable state may still contain hostile data and may require quarantine or recovery (protocols §9, E35). `strata` provides the data side of that recovery.

- **REQ-STRATA-098** `strata quarantine <app|unit> [--user U]` (owner `shell`, facet `cli`/`admin`) MUST take a snapshot of the app's data units (reason `quarantine`, pinned) and mark the units `quarantined`: `warden` then mounts them **read-only** into every view (`mountUnit` returns a read-only mount), so the app can start without its state being modified, and the owner can inspect or copy data out. `strata quarantine release` clears the mark; `strata quarantine rollback <snap-id>` restores the units from an earlier snapshot (keeping the current content in an `UndoGuard` snapshot) and then releases. Receipts `x-strata.quarantine`, `x-strata.quarantine-release`.
- **REQ-STRATA-099** In a **safe start** (chosen at the `kl-initrd` PIN prompt and signalled as `x-safeStart: true` in `/run/keylos/boot/report.json`, boot spec), `warden` mounts app data units read-only until the owner releases each app (warden spec). `strata` MUST serve `mountUnit` read-only for those units, record the safe start in `x-strata.quarantine{safeStart: true}`, and turn an owner's release into a cleared mark (or a rollback, as above); a unit the owner chooses to keep quarantined becomes a persistent quarantine (REQ-STRATA-098). It MUST NOT delete or rewrite any data automatically.

---

## 4. Design

### 4.1 Process architecture

| Process | Tier | Privileges | Role |
|---|---|---|---|
| `strata` | t0 | `CAP_SYS_ADMIN` (btrfs ioctls, mount API, `mount_setattr`, `security.*` xattrs), `CAP_DAC_READ_SEARCH` (`open_by_handle_at`), `CAP_FOWNER`, `CAP_CHOWN`, `CAP_LEASE`; TPM access through the `/dev/tpmrm0` fd passed by warden | Main service: registry, scheduler, transactions, units, anchor, backup orchestration, capwire server |
| `strata-unitfs@<unit>` | t0 | `/dev/fuse` fd from warden; no capabilities | FUSE server for one sealed unit (only on kernels without `btrfs-fscrypt`) |
| `strata-provd` | t0 | `CAP_SYS_ADMIN` (fanotify `FAN_REPORT_*` on filesystem marks, `security.*` xattrs), `CAP_DAC_READ_SEARCH`, `CAP_BPF` (map operations only: it never loads BPF programs; it receives the map fds of `provenance.o` from `strata` at spawn, §4.9.2) | Provenance: maintain the BPF maps, join BPF records with fanotify events, write xattrs |
| `strata-backup` | t0 (spawned per run) | No capabilities; read-only dirfds of snapshots; Gate sockets | Runs `rustic_core` against one target |

`strata` is single-instance. All mutating operations on one subvolume are serialized by a per-subvolume async mutex. Operations on different subvolumes run concurrently, up to `strata.concurrency` (default 4).

### 4.2 Registry

`/var/lib/keylos/strata/registry.redb`. This is a `redb` database; its subvolume is excluded from user snapshots, but it is snapshotted with the `system` class.

| Table | Key | Value |
|---|---|---|
| `subvols` | subvolume UUID (16 bytes) | `SubvolRecord` (CBOR) |
| `snapshots` | snapshot ID | `SnapshotRecord` |
| `txns` | transaction ID | `TxnRecord` |
| `units` | unit ID | `UnitRecord` |
| `backups` | (target, run ULID) | `BackupRunRecord` |
| `anchors` | counter value | `AnchorRecord` |
| `paths` | canonical path (bytes) | subvolume UUID (reverse index) |

```rust
struct SubvolRecord {
    uuid: [u8; 16],
    path: PathBuf,                 // canonical absolute path
    kind: SubvolKind,              // Home, AppConfig, AppData, AppCache, AppState, Project, ServiceState, Var, System, Keystore
    human: Option<String>,         // owning human (username)
    owner: Option<String>,         // app name or service name
    unit: Option<UnitId>,
    snapshot_class: SnapshotClass, // §4.4.1
    backup_class: BackupClass,     // none | standard | sealed-only
    created: Timestamp,
    excluded: bool,                // excluded from snapshots (keystore, caches)
}
struct SnapshotRecord {
    id: SnapId, subvol: [u8; 16], btrfs_uuid: [u8; 16], transid: u64,
    created: Timestamp, reason: SnapReason, pinned: bool, set: Option<Ulid>,
    shredded_units: Vec<UnitId>,   // units forgotten since this snapshot was taken
}
enum SnapReason { Scheduled(SnapshotClass), PreCommit(TxnId), Base(TxnId), PreUpdate(String), Manual(String), BackupSource(Ulid), UndoGuard(TxnId) }
```

The registry is reconciled with the actual btrfs subvolume tree at startup (`BTRFS_IOC_TREE_SEARCH_V2` over the root tree):
- Subvolumes present on disk but missing from the registry are adopted as kind `Unknown`, with the `none` snapshot class and a warning.
- Registry records for missing subvolumes are marked `missing` and reported. They are never recreated silently.

### 4.3 Subvolume operations

| Operation | Mechanism |
|---|---|
| Create | `BTRFS_IOC_SUBVOL_CREATE_V2` in the parent dirfd, opened with `openat2(RESOLVE_BENEATH\|RESOLVE_NO_SYMLINKS\|RESOLVE_NO_MAGICLINKS)` from the held root fd of `@home`/`@var`. Then `fchown` to the owning UID: the human's UID for everything under `/home/<user>` (including app subvolumes), or the service's state UID for `/var/lib/<service>` (§6.4). Then set `security.keylos.unit` and `security.bpf.keylos.label` (default `private/user`). |
| Snapshot | `BTRFS_IOC_SNAP_CREATE_V2` with `BTRFS_SUBVOL_RDONLY` into `/snapshots/<uuid>/`. Then the record is written. |
| Delete | `BTRFS_IOC_SNAP_DESTROY_V2` by subvolume ID. Space is reclaimed asynchronously by the btrfs cleaner. `strata` calls `BTRFS_IOC_WAIT_SYNC` only when pruning under pressure (§4.4.3). |
| Set ro/rw | `BTRFS_IOC_SUBVOL_SETFLAGS`. Used only for purge (§4.7.5) and for converting a received replica. |

Every path argument from a client arrives as an fd, never as a path string (protocols §7.1, §7.3.10). `strata` resolves an fd to a subvolume with `BTRFS_IOC_INO_LOOKUP` and `fstatfs` (it checks `f_type == BTRFS_SUPER_MAGIC` and the filesystem UUID against the root filesystem).

### 4.4 Snapshot scheduling and retention

#### 4.4.1 Classes

| Class | Applies by default to | Schedule | Retention (count / age) |
|---|---|---|---|
| `user` | Home, AppConfig, AppData, AppState, Project | hourly at :00 (if changed), daily at 03:00 local time, weekly Sunday 03:00, monthly 1st 03:00 | hourly 24 / 2 d; daily 14 / 15 d; weekly 8 / 9 w; monthly 12 / 13 mo |
| `system` | Var, ServiceState | daily, weekly | daily 7; weekly 4 |
| `cache` | AppCache | never | — |
| `none` | Keystore, unit backing-key directories, `/var/tmp`, `/var/cache` | never | — |
| `txn` | Pre-commit and base snapshots | per event | pre-commit: 50 per subvolume / 30 d; base: deleted at commit/abort + 1 h |
| `update` | Var and all Home subvolumes before an OS update (requested by `courier`) | per event | 3 |
| `manual` | Explicit `strata snapshot` | per event | never pruned automatically unless `--expire` |

A scheduled snapshot is skipped when the subvolume's btrfs generation (`transid`, from `BTRFS_IOC_GET_SUBVOL_INFO`) has not advanced since the previous snapshot of that subvolume in any class.

#### 4.4.2 Consistency groups

Snapshots taken in one scheduler tick for one human share a `set` ULID. btrfs snapshots are not atomic across subvolumes. `strata` takes the set in a tight loop: it calls `syncfs` once per filesystem first, then snapshots all subvolumes of the set within at most 2 s. Restore tools present sets as a unit. Cross-subvolume crash-consistency is not guaranteed and is documented to users.

#### 4.4.3 Space pressure

Free space is measured with `BTRFS_IOC_SPACE_INFO` plus `statfs`. The usable-free estimate is unallocated plus free-in-allocated data chunks, adjusted for RAID profile.

| Level | Trigger (either) | Action |
|---|---|---|
| `ok` | free ≥ 15 % and ≥ 30 GiB | none |
| `low` | free < 15 % or < 30 GiB | Stop creating `user` hourly snapshots. Prune in order P1–P3. Warn the user. |
| `critical` | free < 5 % or < 8 GiB | Prune P1–P6. Refuse `begin` for new transactions (`kl:unavailable`). Raise a critical notification. |

Prune order, oldest first within each step. Re-measure after each deletion plus `WAIT_SYNC`:

| Step | Pruned |
|---|---|
| P1 | Expired base snapshots; aborted-transaction leftovers |
| P2 | `txn` pre-commit snapshots older than 7 d |
| P3 | `user` hourly beyond the most recent 6 |
| P4 | `user` daily beyond the most recent 3 |
| P5 | `system` beyond the most recent 1 per class |
| P6 | `user` weekly and monthly beyond the most recent 1 each |

Without qgroups, `strata` cannot know a snapshot's exclusive size before deleting it. The order targets the snapshots most likely to be large and least valuable.

### 4.5 Transactions

#### 4.5.1 Records and states

```rust
struct TxnRecord {
    id: TxnId, owner: PrincipalId, human: String, created: Timestamp,
    network_policy: NetPolicy,          // Deny | Gate | Inherit
    targets: Vec<TxnTarget>, state: TxnState,
    ttl: Duration, pinned: bool,
    origin: TxnOrigin,                   // Shell | Agent { session } | Bench { vm } | Api
    backend: Backend,                    // Overlay | Unitfs { unit } (§4.5.10), one per transaction
    prepared: Option<PreparedId>,        // pm-… of the current prepared merge (§4.5.6), if any
    pre_commit_snapshots: Vec<SnapId>,
    workflow: Option<WorkflowBinding>,   // bindWorkflow (§4.5.11): {workflow wf-…, attempt wa-…, epoch} of the binding attempt
}
struct PreparedRecord {                  // immutable once written (REQ-STRATA-030)
    id: PreparedId,                      // pm- + ULID (protocols §3.5)
    txn: TxnId, created: Timestamp,
    manifest_digest: Digest,             // SHA-256(JCS(keylos.fsmerge/2)), the fs.merge payload digest
    ops: Vec<PreparedOp>,                // exactly what commit applies, in order
    store: PathBuf,                      // /snapshots/.prepared/<pm-id>/ (reflinked content; ciphertext for unitfs)
    state: PreparedState,                // Ready | Committing { journal } | Committed | Discarded | Stale
    completion: Option<Completion>,      // Committed: {transaction, pre_commit_snapshots, committed_at}; kept per REQ-STRATA-105
}
struct PreparedOp { target: u32, path: RelPath, kind: ChangeKind, from: Option<RelPath>,
                    expected_live: LiveState,  // Sha256(content) | Absent | Dir | Symlink(target digest)
                    content: Option<StoreRef>, mode: Option<u32>, meta: Option<MetaSet> }
struct TxnTarget {
    live_dir: PathBuf,                   // canonical live directory path
    subvol: [u8; 16], rel: PathBuf,      // directory relative to subvolume root
    base_snapshot: SnapId,               // read-only snapshot at begin
    upper: PathBuf, work: PathBuf,       // /snapshots/.txn/<txn>/<i>/{upper,work}
    mount_fd_cache: Option<OwnedFd>,
}
enum TxnState { Open, Frozen, Prepared { pm: PreparedId }, Committing { journal: u64 }, Committed, Aborted, Failed }
```

```
Open ──prepare──► Prepared(pm) ──PreparedMerge.commit──► Committing ──► Committed
  │                  │    ▲                                   │
  │                  │    └── prepare again (new pm, new      └──crash / fence lost──► recovery
  │                  │        digest, old pm discarded)            (complete | rollback)
  │                  └──stale live state──► Prepared (pm marked Stale; commit refused kl:conflict)
  └──abort/ttl/forget──► Aborted
```

`Frozen` (views read-only) is entered by `prepare` and kept until commit or abort; the views are not thawed between preparations.

#### 4.5.2 Begin

For each passed dirfd `d`:

1. Resolve `d` to (subvolume, relative path). Reject if:
   - the target is not a directory (`kl:invalid`);
   - it is on a non-btrfs filesystem or a different filesystem (`kl:unsupported`), unless it is the plaintext view of a sealed unit served by `strata-unitfs` and registered in `strata`'s mount registry, which uses the unitfs backend (§4.5.10, REQ-STRATA-032);
   - its targets would mix backends, nest units or span more than one unit (`kl:unsupported`);
   - it is inside `/keystore` or `/snapshots` (`kl:denied`);
   - the caller is not authorized.

   **Authorization:** holding `d` is the authority (protocols §7.1, §7.3.10), but only for the access `d`'s mount gives the caller. `strata` applies the write check of §6.2: the mount `d` was opened through must be writable, and the directory must be writable by the caller's UID as seen through that mount.
2. Take the base snapshot: a read-only snapshot of the containing subvolume to `/snapshots/<uuid>/<snap-id>` with reason `Base(txn)`. For targets that are the same subvolume, one base snapshot is shared.
3. Create `/snapshots/.txn/<txn>/<i>/upper` and `work` as plain directories inside the `@snapshots` subvolume, which is on the same filesystem, so copy-up reflinks work.
4. Build the overlay with the new mount API:
   ```
   fs = fsopen("overlay", FSOPEN_CLOEXEC)
   fsconfig(fs, SET_STRING, "lowerdir+", "<base snapshot>/<rel>")
   fsconfig(fs, SET_STRING, "upperdir", upper); fsconfig(fs, SET_STRING, "workdir", work)
   fsconfig(fs, SET_STRING, "index", "on"); "redirect_dir"="on"; "xino"="on"; "metacopy"="off"; "uuid"="on"
   fsconfig(fs, CMD_CREATE); m = fsmount(fs, FSMOUNT_CLOEXEC, MOUNT_ATTR_NOSUID|NODEV|NOEXEC)
   ```
   `m` is a detached mount fd. Ownership and permissions inside mirror the live directory, because the base snapshot preserves them.
5. Record the state `Open`. Emit `txn.begin` with `data: {targets, networkPolicy, origin}`.

Begin costs one snapshot per distinct subvolume plus one mount per target. Budget in §8.

#### 4.5.3 Views and processes

`Transaction.view` returns the views as `O_PATH` fds of detached mounts, in `begin` order. They reach processes in two ways:
- **Host processes** (`kish try`, protocols §7.3.2). The spawner sets `SpawnSpec.transaction` to the transaction ID. `warden`, holding the `warden` facet:
  1. calls `StrataTxn.txnExt(id)` to get the `Transaction` and its `TransactionExt`;
  2. calls `TransactionExt.policy()` to get `(networkPolicy, views)`, where `views[i]` is the canonical live path of target *i*;
  3. calls `Transaction.view()` and `move_mount`s each view fd over `views[i]` inside the child's private mount namespace;
  4. sets `KEYLOS_TXN` in the child (protocols §10.5) and builds the child's network namespace per `networkPolicy` (§4.5.4).

  `strata` answers `txnExt` on the `warden` facet only for transactions in state `Open`, and `warden` checks `TransactionExt.owner()` against the spawner's session before mounting (REQ-STRATA-097). On the `user`, `cli`, `bench` and `aide` facets it answers only for transactions whose owner is the caller's session or one of its session ancestors (protocols §7.5.7).
- **VM processes** (`bench`). `bench` exports the view fds as virtio-fs shares. The VM's own network is always gate-only through `bench-net`; `bench` begins its transactions with `NetworkPolicy.deny`, because no host process is spawned into them.

Every process in the transaction therefore sees the overlay at the same paths it would normally use. Processes spawned later by those processes inherit the mount namespace and therefore the views.

#### 4.5.4 Network policy

| Value | Meaning | Who enforces it |
|---|---|---|
| `deny` | Transaction processes get a network namespace with only `lo` and no `gate` socket | `warden`, from `TransactionExt.policy` |
| `gate` | Egress only via sockets obtained from `Gate.connect`; each connection is a receipted effect | `warden` (namespace) and `gate` |
| `inherit` | The spawner's normal network grants apply. Allowed only when the transaction was begun by a `shell` principal (`kish try --net-inherit`); otherwise `begin` fails with `kl:denied`. The receipt records it | `warden` |

The default for `kish try` is `deny`; `kish try --net` uses `gate`.

#### 4.5.5 Change detection and conflicts

**Changes** are computed by walking the upper directory:
- A regular file present in upper and in lower is `modified` if its content differs. `strata` compares reflink-shared extents first (`FIEMAP` physical offsets): identical shared extents mean equal; otherwise it compares content hashes (BLAKE3, internal use only).
- Present in upper only: `added`.
- A whiteout (char device 0/0, or the xattr `trusted.overlay.whiteout`): `deleted`.
- An opaque directory (`trusted.overlay.opaque=y`): every lower entry in it is `deleted` and every upper entry is `added`.
- `trusted.overlay.redirect` on a directory: `renamed`, with `from` set to the redirect target.
- Equal content but differing mode, owner, xattrs (except `security.bpf.keylos.prov`) or mtime-only differences: `meta`. mtime-only differences are suppressed unless `--strict-meta` is set.

**Conflicts** are computed at `conflicts()` and again at `prepare()`, against the live tree. `PreparedMerge.commit` does not recompute conflicts: it only revalidates the captured `expectedLive` state under the writer fence (§4.5.6). For each changed path `p`:

| Check | Conflict reason |
|---|---|
| The live `p` differs from base `p` (compare `(ino, btrfs transid-of-inode via BTRFS_IOC_INO_LOOKUP_USER + generation, size, mtime_ns, ctime_ns)`; if inconclusive, compare content) **and** the upper change is not a pure delete of an unchanged file | `both-changed` → try merge (§4.5.8) |
| `F_SETLEASE(F_WRLCK)` on the live file fails with `EAGAIN` (another fd is open). `strata` opens the live file `O_RDONLY`, tries the lease, and releases it immediately | `open-elsewhere` |
| Path or sibling matches SQLite (header `SQLite format 3\0`, or names `*-wal`, `*-shm`, `*-journal`) and either side changed it | `sqlite-active` if any lease test on the database, WAL or SHM fails; otherwise `sqlite-binary` (no merge; the user chooses a side) |
| Binary on both sides (not valid UTF-8, contains NUL, or > 8 MiB) and both changed | `binary-both-changed` |
| Type change on both sides | `type-conflict` |
| Upper contains a device, FIFO or socket | `special-file` (always refused) |
| Live path is a mount point or crosses into another subvolume | `cross-subvolume` (refused) |
| Live file has an active `flock`/POSIX lock (`/proc/locks` entries for the inode) | `locked` |

Every conflict except `special-file` and `cross-subvolume` can be resolved per path with:

```
resolve(path, choice)   choice ∈ {ours, theirs, merged(<fd>)}
```

This is `TransactionExt.resolve(path, choice, merged)` (protocols §7.5.7), where `choice` is the `Choice` enum `ours`, `theirs` or `merged`; `merged` carries the resolved content as an fd. The default resolution UI is in `kish` and `atrium`.

#### 4.5.6 Prepare and commit

Approval binds a digest; the commit applies exactly what that digest names. The sequence is therefore **prepare → render and approve → commit**, and nothing between approval and apply may change the result (ISS-003, protocols E30).

**`TransactionExt.prepare()`** (and the first half of `Transaction.commit`):

```
1. freeze: for each view mount fd: mount_setattr(fd, "", AT_EMPTY_PATH, {attr_set: MOUNT_ATTR_RDONLY})
   → stragglers get EROFS; state := Frozen (kept until commit or abort)
2. changes := compute (§4.5.5) from the frozen views
3. capture: for each changed path p, read the live state of p (content sha256 of the live file, "absent",
   directory, symlink target digest) → expectedLive(p); this is the live base the result is computed against
4. conflicts := compute (§4.5.5) against that captured state; apply recorded resolutions (TransactionExt.resolve);
   try three-way merges (§4.5.8) for both-changed text paths; if any conflict remains → kl:conflict (no pm created)
5. store: for each operation, reflink (FICLONE) the result content (upper file, resolver's merged fd, or clean
   merge output) into /snapshots/.prepared/<pm-id>/<n>; unitfs targets: the stored content is the ciphertext file
   produced through strata-unitfs-format under the unit key (§4.5.10); fsync the store
6. manifest := keylos.fsmerge/2 (protocols §20.12) listing every op with path, kind, from, expectedLive,
   afterDigest, mode, size; digest := SHA-256(JCS(manifest)); write PreparedRecord (state Ready) to the registry
   (fsync); discard any earlier prepared merge of the transaction (state Discarded, store deleted)
7. emit x-strata.txn.prepare {txn, prepared, digest, counts}; return PreparedMerge
```

The prepared store is immutable from step 6 on: nothing reads the transaction's views again for this prepared merge (REQ-STRATA-030). An approver renders `PreparedMerge.manifest()` and `PreparedMerge.diff()`, which are computed only from the prepared record and its store, so the displayed diff, the signed manifest and the committed content are the same object.

**`PreparedMerge.commit(mandate)`** (mandate empty for shell-origin transactions):

```
1. authorize: origin Agent/Bench → §6.2.2 (mandate binds manifest_digest); origin Shell → no mandate; state must be Ready
2. fence := PrincipalControl.fenceWriters(target dirfds, exclude = the transaction's own sessions)   (protocols §7.5.1)
   kl:conflict "writer-unfenceable" → return it; the prepared merge stays Ready
3. revalidate: for each op, the live state of its path MUST equal expectedLive (sha256 recomputed for files whose
   (ino, transid, size, mtime_ns, ctime_ns) changed since capture; directories and symlinks compared exactly);
   open-elsewhere and locked checks (§4.5.5) are repeated for the affected paths;
   any mismatch → fence.release; mark pm Stale; emit x-strata.txn.stale {txn, prepared, paths};
   return kl:conflict listing the paths (the caller prepares again and obtains a new approval)
4. for each affected live subvolume S: snapshot S → pre-commit snapshot P_S (class txn)
   (unitfs: snapshot of the ciphertext backing subvolume)
5. write journal /var/lib/keylos/strata/txn/<txn>/journal (redb table, fsync): pm id, digest, the op list, fence
   deadline, state=prepared
6. choose mode:
   atomic  — if target dir == subvolume root AND no process outside the txn has an fd/cwd inside S
             (checked through PrincipalControl.mountView; see §6.5), build S' = writable snapshot of S, apply the
             stored ops into S', then renameat2(parent, S, parent, S', RENAME_EXCHANGE); delete old S after 1 h grace.
   incremental — otherwise: apply the stored ops in order on live S:
       added/modified file: reflink the stored content to <dir>/.strata-<txn>-<n>.tmp (FICLONE),
                           copy metadata, set security.bpf.keylos.prov with x = <txn> (§4.9.2),
                           fsync, renameat2(tmp → name) (RENAME_NOREPLACE for added)
       deleted: unlinkat / remove tree bottom-up
       renamed dir: renameat2 with RENAME_NOREPLACE
       meta: fchmod/fchown/fsetxattr
       each op marked done in journal (batched fsync every 64 ops and at end)
   Before every journal batch strata checks the fence is still held; a lost fence → rollback (below), kl:unavailable
7. journal state=applied; fsync; fence.release; set txn Committed, pm Committed; emit txn.commit (data:
   preparedDigest, prepared, mode, counts, preCommitSnapshots); schedule base snapshot, upper/work and prepared
   store deletion (1 h grace)
8. anchor update (rate-limited)
```

Commit never runs a merge, never reads the views or the overlay upper layer, and never applies an operation that is not in the prepared record. `TransactionExt.commitWithMandate` fails `kl:unsupported` (REQ-STRATA-028).

**Writer exclusion.** The fence freezes every session whose view can write inside the targets (cgroup freeze), so no writer can change a live path between revalidation (step 3) and `applied` (step 7); processes holding writable fds or shared mappings are frozen with them. Writers that cannot be frozen (tier-0 services other than `strata`, kernel-side or network-filesystem writers) make the fence fail, and the commit is refused rather than run unprotected. The fence lasts at most 30 s (protocols §7.5.1); commits that would not finish in that time (large incremental commits) are applied in atomic mode when §6.5 allows it, or refused with `kl:unavailable` and reason `commit-too-large-for-fence` after the journal rollback.

**Crash recovery** (REQ-STRATA-026). At startup, for every journal:

| Journal state | Action |
|---|---|
| `prepared` with no op done | Discard the journal; the prepared merge returns to `Ready` (its digest and store are unchanged, so the same mandate may be presented again) |
| `prepared` with at least one op done | Roll back: restore every touched path from `P_S` (reflink copy); the transaction returns to `Prepared` and the prepared merge to `Ready` (REQ-STRATA-104: committable again with the same mandate; revalidation catches any later live change). Emit `x-strata.txn.rollback` with `reason: "crash-rollback"`. |
| `prepared`, fence deadline passed while running (warden restart, timeout) | Same rollback, `reason: "fence-lost"`; the caller gets `kl:unavailable` |
| `applied` | Finish cleanup, mark the transaction `Committed`. |

The fence is not persistent: after a `strata` or `warden` restart every frozen session is thawed by `warden` (fence capability dropped), so recovery never leaves principals frozen. Atomic mode crash between snapshot and exchange: `S'` is simply deleted.

#### 4.5.7 Merge manifest and digest

The digest a T3 mandate for `fs.merge` binds to is the **prepared merge's** manifest digest:

```
digest = sha256( JCS( keylos.fsmerge/2 manifest ) )     (protocols §20.12)
  {"schema": "keylos.fsmerge/2", "prepared": "pm-…", "session": "s-…", "share": "<bench share>"|null,
   "targets": ["<canonical live dir>", …], "base": "snap-…", "source": "snap-…",
   "changes": [ {"path": "<rel to target>", "kind": "added|modified|deleted|renamed|meta", "from": "<rel>"?,
                 "expectedLive": "sha256:…"|"absent", "afterDigest": "sha256:…"|null, "mode": "0644"?, "size": n?}
                … sorted by (target index, path bytes) ] }
```

`base` is the begin-time base snapshot, `source` the frozen state of the views the result was computed from. The same manifest format is used by `bench` (`BenchMerge.manifest`, protocols §7.5.10), so there is one digest meaning for every `fs.merge`. `keylos.changeset/1` (the earlier strata-internal digest) is no longer bound by mandates; `TransactionExt.changeSet` returns the fsmerge/2 manifest of the current prepared merge (`kl:not-found` before `prepare`). `PreparedMerge.manifest()` returns the JCS document as a memfd, so the approver renders exactly what is hashed.

#### 4.5.8 Three-way merge

Merges run **only inside `prepare`**, against the live state captured in step 3 of §4.5.6. Paths with `both-changed` where all three versions (base, ours, theirs) are text (valid UTF-8, no NUL, each ≤ 8 MiB) are merged with the `diffy` three-way merge on line granularity.

| Outcome | Handling |
|---|---|
| Merges cleanly | The merge output becomes the stored content of that op in the prepared object, recorded as `merged` (kind `modified`, `expectedLive` = the captured live digest), with provenance `x` = the transaction. It is visible in the manifest and diff before approval |
| Conflicts | Stays a conflict; `prepare` fails `kl:conflict`. `diff(path)` returns the merge result with standard `<<<<<<<`/`=======`/`>>>>>>>` markers for the resolver |

A live change after `prepare` is never merged automatically into an approved result: it makes the prepared merge stale at commit (§4.5.6 step 3), and a new `prepare` computes a new result with a new digest that needs a new approval.

There are **no** format-aware merges (JSON, TOML) in v1.0. These are left to resolvers.

#### 4.5.9 Undo

`undo(txn)`:

1. Load the change set. For each changed path, check that the live content still equals the content committed by `txn` (the sha256 in the change set, or deletion). Collect the mismatches.
2. If there are mismatches and no force flag: `kl:conflict` listing them.
3. Snapshot the affected subvolumes (reason `UndoGuard`).
4. Restore each path from the pre-commit snapshot using the incremental mechanism of §4.5.6 (reflink, tmp, rename). Added paths are deleted; deleted paths are restored.
5. Emit `txn.undo` and mark the transaction `Undone`. Undo is itself undoable: `strata undo` on the guard snapshot.

**Undo as compensation.** On the `gate` facet, `undo(txn)` is accepted only for a transaction that was committed through `PreparedMerge.commit` with an `fs.merge` mandate (origin `Agent` or `Bench`); `gate` calls it when it executes the `fs.undo` compensator of the corresponding `fs.merge` intent (protocols §14.2). It runs without the force flag: if the merged paths changed since the merge, it fails with `kl:conflict` and `gate` marks the compensation failed. Any other transaction gives `kl:denied` on this facet.

For unitfs transactions the pre-commit snapshot is a snapshot of the ciphertext backing subvolume, and undo restores ciphertext files through the same mechanism; no plaintext undo copy exists.

#### 4.5.10 Encrypted (unitfs) targets

Agent workspaces and other sealed units on kernels without btrfs fscrypt are served as plaintext only through `strata-unitfs` (§4.7.3); the plaintext directory fd is a FUSE mount, not a btrfs target. Transactions on them use the **unitfs backend** (REQ-STRATA-032, protocols §7.3.10, E34):

1. **Resolve.** `strata` maps the dirfd to `(unit, rel)` from its own mount registry: the dirfd's mount ID must be a unitfs mount that `strata` (through `strata-unitfs@<unit>`) serves, and `rel` the directory below the unit root. The authorization is the §6.2.1 check on the caller's own view of that mount; the transaction is restricted to `rel`, and cloning the backing never grants access to the rest of the unit.
2. **Quiesce and clone.** `strata-unitfs@<unit>` flushes and fsyncs every open file (FUSE `flush` drained, writeback off), under a writer fence (§4.5.6) for the duration of the clone; then `strata` takes a read-only snapshot of the ciphertext backing subvolume (`base`) and a writable snapshot of it (`work`), both under `/snapshots/.txn/<txn>/` and both ciphertext only.
3. **View.** A transaction-specific `strata-unitfs@<unit>:<txn>` instance serves `work` as plaintext, rooted at `rel` (entries outside `rel` are not reachable), with the unit key from the same `vault.dataKey` delivery. Its view fd is what `Transaction.view` returns; `warden` mounts it like an overlay view.
4. **Changes and conflicts.** Computed on logical plaintext views: `base` and `work` are walked through `strata-unitfs-format` (decrypting names and comparing per-file content digests computed in memory), the live tree through the live unitfs instance. No plaintext file is written.
5. **Prepare.** The prepared store holds the operations' content as ciphertext files in unitfs format under the unit key (fresh file IDs and file keys); the manifest is computed from plaintext digests in memory. Paths in the journal and prepared record are stored encrypted under `HKDF-SHA256(K_u, "unitfs/1 txn-journal")` (REQ-STRATA-033).
6. **Commit.** Under the writer fence and with the live `strata-unitfs@<unit>` quiesced, `strata` applies the stored operations into the live backing directory through `strata-unitfs-format` (tmp file + rename per file, as in §4.5.6), then tells the live instance to invalidate its caches (FUSE notify inval). Existing FUSE handles of other principals keep referring to the replaced inode's old ciphertext until reopened, exactly like the incremental btrfs mode.
7. **Undo** restores from the ciphertext pre-commit snapshot (§4.5.9).

| Event | Behaviour |
|---|---|
| Owning human locks / suspend (§4.7.6) | The transaction instance drops its key and exits with the live instance; views return `ENOTCONN`; `prepare`/`commit` fail `kl:unavailable`. The transaction stays `Open`/`Prepared` |
| Unlock | Views are re-served from `work`; a prepared merge stays committable (its store is ciphertext) |
| `strata` or `strata-unitfs` restart, reboot | Transaction records and stores persist (ciphertext); views are re-served after the unit's next unlock; journals recover as in §4.5.6 |
| `forget(unit)` | Every open transaction on the unit is aborted and every prepared merge discarded first (REQ-STRATA-034); all their artifacts are ciphertext under `K_u`, which `vault.forget` destroys |
| Mixed btrfs + unitfs targets, nested units, more than one unit | `kl:unsupported` at `begin` |

#### 4.5.11 Workflow-owned transactions

```
attempt A1 (epoch e) of workflow W, agent VM session S1 (bench or aide is the caller)
  begin(dirs) → x;  TransactionExt.bindWorkflow({W, A1, e, step, owner})
       strata: BrokerWorkflow.verify(binding, owner(x) = S1) → ok → TxnRecord.workflow := binding (fsync)
  prepare() → pm (Ready);  gate prepares the fs.merge effect fx with payload = pm's manifest   (protocols §20.26)
--- crash / reboot: S1 is gone; loom claims A2 (epoch e+1) ---
bench (for gate, BenchMerge.commitPrepared(pm, digest, mandate, binding A2))
  StrataTxn.preparedFor(pm, binding A2)
       strata: TxnRecord(x).workflow.workflow == W ∧ BrokerWorkflow.record(W) = {active, epoch e+1, attempt A2} → PreparedMerge
  PreparedMerge.status() → committed? return the stored record (no second apply)    (REQ-STRATA-103/104)
  PreparedMerge.commit(mandate)  — §6.2.2 with REQ-STRATA-107 (constraints.workflow = W), fence, revalidate, apply
```

`strata` caches `BrokerWorkflow.record` answers for at most 1 s; a `kl:revoked` or a newer epoch invalidates the cache entry at once. The binding is evidence of ownership, never authority to commit: every commit still needs a mandate bound to the manifest digest. The completion record (`PreparedRecord.completion`) is what makes `fs.merge` a `transactional` effect (protocols §20.26): the operation and its completion record commit together in the journal's `applied` step, keyed by the `pm-…` ID.

### 4.6 `try` semantics (contract with `kish`)

`kish try [--net | --net-inherit] [--keep] { block }` maps to:

1. `begin(dirs, networkPolicy)` on the `user` facet:
   - `dirs` are the cwd and every directory the block's commands were granted with write access;
   - `networkPolicy` is `deny` by default, `gate` with `--net`, and `inherit` with `--net-inherit`.
2. `kish` obtains the `Transaction` and its `TransactionExt` with `StrataTxn.txnExt(id)`. It spawns every external command of the block with `SpawnSpec.transaction = id`, so `warden` mounts the views (§4.5.3). `kish` itself resolves paths under transaction directories through the `Transaction.view` dirfds.
3. On block exit, `kish` shows `changes()` and `conflicts()`, then offers:
   - commit (`Transaction.commit`, which prepares and commits in one step; a live change between the two fails `kl:conflict` and `kish` offers to retry);
   - abort;
   - keep: `TransactionExt.pin(true)`, which leaves the transaction `Open` and resumable with `kish try --resume x-…`;
   - diff;
   - per-path resolution (`TransactionExt.resolve`).
4. On commit, `kish` shows the transaction ID as the undo handle (`undo x-…`).

`strata` itself never prompts. Prompts belong to the caller or to the trusted path.

### 4.7 Data units

#### 4.7.1 Default unit modes

| Subvolume kind | Default unit | Default mode |
|---|---|---|
| Home (root) | `u-home-<user>` | plain |
| AppConfig, AppData, AppState of an app whose manifest lists `needs.dataUnits` | One unit per listed name, `u-app-<user>-<app>-<name>` | **sealed** if the app's generation name is in config `strata.units.sealedApps` (the default list covers the distribution's messaging, mail, browser, password-manager, health and finance apps), or the manifest sets `x-unitMode: "sealed"`; otherwise plain. `x-unitMode` is only a hint that can raise protection, never lower it, so it carries no authority (protocols §6.3) |
| AppCache | none | — |
| Project | `u-proj-<ULID>` | plain, unless created with `--sealed` |
| Agent session workspaces (`bench` overlays, chat transcripts stored by `aide`) | `u-agent-<session>` | **sealed** |
| User-created (`strata unit create --sealed`) | as given | as given |

#### 4.7.2 Sealed units with native fscrypt (feature `btrfs-fscrypt`)

- The unit root directory gets an fscrypt **v2** policy: contents `AES-256-XTS`, filenames `AES-256-CTS`, flags `IV_INO_LBLK_64` if the device supports inline encryption, otherwise default.
- The policy's master key = HKDF-SHA256(unit key, salt = unit ID, info = "keylos-fscrypt-v2"), 64 bytes. It is added with `FS_IOC_ADD_ENCRYPTION_KEY` on mount of the unit (when the owning human's session unlocks) and removed with `FS_IOC_REMOVE_ENCRYPTION_KEY` at lock or forget.
- The key identifier is stored in the unit record.

#### 4.7.3 Sealed units on kernels without btrfs fscrypt: `keylos.unitfs/1`

Each sealed unit has a **backing subvolume** `<unit path>.unitfs/` holding ciphertext. `strata-unitfs@<unit>` serves the plaintext view over FUSE. `warden` mounts that view at the unit path inside principals' mount views; the FUSE connection fd goes to `strata-unitfs`. Format:

| Element | Encoding |
|---|---|
| Unit master key `K_u` | 32 bytes from `vault.dataKey(unit)` |
| Name key | `K_n = HKDF-SHA256(K_u, "unitfs/1 names")` |
| File key wrap key | `K_w = HKDF-SHA256(K_u, "unitfs/1 wrap")` |
| Directory entry name | `base64url-nopad(AES-256-SIV(K_n, AD = parent dir id (16 bytes), plaintext name))`. Names longer than 175 plaintext bytes are stored as `L.<sha256-prefix>` with the full ciphertext in a sibling `L.<prefix>.name` file. |
| Directory id | 16 random bytes, stored in `.unitfs-dirid` inside each backing directory |
| File header (first 64 bytes) | `magic "KUFS" (4) ‖ version 1 (1) ‖ reserved (3) ‖ file id (16) ‖ wrapped file key (40 = AES-256-KW of 32-byte K_f under K_w)` |
| Content | 4096-byte plaintext blocks, each stored as `nonce (12) ‖ AES-256-GCM(K_f, nonce, AD = file id ‖ block index u64 BE, block) ‖ tag (16)`. The last block may be short. Nonce = 12 random bytes per write of the block. |
| Symlink target | Encrypted like a single short content block in the backing symlink's target string (base64url) |
| Metadata | Plaintext mode, uid, gid and timestamps are mirrored on backing inodes (needed for permission checks); sizes are derived. `security.keylos.*` xattrs are mirrored. User xattrs are encrypted as `user.kufs.<siv name>` → AES-GCM value. |

The format is implemented in the crate `strata-unitfs-format` with no FUSE dependency, so offline tools (`strata unit export`) can decrypt with the key.

**Properties:**
- Backing files are ordinary btrfs files, so snapshots, reflinks, send/receive and restic all operate on ciphertext.
- Destroying `K_u` makes every copy undecryptable.
- Deterministic names (SIV) leak equality of names within one directory. Accepted.
- The GCM nonce is random per block write. `K_f` is rotated by rewriting the file once 2^30 block writes have been issued under one file key (tracked in the header's reserved bytes as a counter class: 0 means fewer than 2^28). `strata-unitfs` rewrites the file in place through a tmp file and rename when the counter class reaches 3.

**Operation:**
- FUSE uses `fuser` with `writeback_cache` off and `direct_io` off.
- Kernel page cache is enabled for read caching (`FOPEN_KEEP_CACHE` when the backing mtime is unchanged).
- Expected throughput is 40–70 % of native btrfs on sequential I/O and 25–50 % on metadata-heavy workloads. That is why sealed is not the default for every unit.
- Transactions on unitfs units use the unitfs backend (§4.5.10): clones of the ciphertext backing, never plaintext copies.

#### 4.7.4 Migration to native fscrypt

When `btrfs-fscrypt` becomes available (after a kernel update), `strata unit migrate <unit>|--all` runs. The default is `strata.units.autoMigrate = "idle"`: migrate when on AC power and idle for 10 minutes.

1. Create a new subvolume with an fscrypt v2 policy, keyed from the same `K_u`.
2. Copy plaintext from the unitfs view into the new subvolume as a unit-scoped internal transaction.
3. Swap the paths with `RENAME_EXCHANGE`.
4. Delete the backing subvolume.
5. Old snapshots stay in unitfs format. They remain readable with `K_u` and remain shreddable.

#### 4.7.5 Plain units: best-effort forget

`forget` on a plain unit:
1. Deletes the live subvolumes.
2. For each local snapshot that contains the unit's subvolumes as separate snapshots (the normal case, since units are subvolumes): deletes those snapshots.
3. For snapshots of a parent subvolume that contain unit paths as directories (pre-registration data): flips the snapshot to read-write, deletes the paths, flips it back to read-only, and records `purged` in the snapshot record. That invalidates the snapshot as a send/receive parent; the next replication of that subvolume does a full send.
4. Adds the unit to every `BackupRunRecord` as `requires-purge`, and runs `rustic forget --path <unit paths>` plus `prune` on each target at the next backup run.

Even then, copies in external replicas, sync peers and backup repositories that `strata` can't reach stay plaintext. The CLI says so before confirmation.

#### 4.7.6 Unit keys at rest

- `vault` stores unit keys wrapped under the keystore key in `/keystore`.
- `strata` never writes unit keys anywhere. It obtains `K_u` via `vault.dataKey(unit)` as a `memfd_secret` fd when the owning human's session unlocks. The fd is passed to `strata-unitfs@<unit>` at spawn, or used for `FS_IOC_ADD_ENCRYPTION_KEY`.
- On lock or suspend, `hearth` calls `StrataAdmin.lockUnits(human)` on the `hearth` facet: units marked `lockOnSuspend` (default for sealed units) are unmounted, and their key material is dropped (unitfs process exits; fscrypt key removed). `StrataAdmin.unlockUnits(human)` after login or unlock mounts them again. `strata` also subscribes to `PowerEvents` (protocols §7.5.8, `devd` facet `service`) and acknowledges `preSleep` only after the units of every locked human are unmounted.
- Unit keys arrive from `vault.dataKey` in the secret-delivery layout of protocols §20.10: a `memfd_secret` fd, readable only through `mmap`, holding a u64 length and the key bytes.

### 4.8 Anchors: user-data rollback detection

**Threat:** an offline attacker restores an older but valid image of the LUKS2 volume. Authenticated encryption doesn't catch that, because each old block is authentic. That would, for example, bring back a deleted file, an old SSH `known_hosts`, or a revoked app's data.

**Anchor record** (`keylos.anchor/1`), stored in `/var/lib/keylos/strata/anchor` and in the registry:

```json
{"schema":"keylos.anchor/1","counter":4711,"time":"…",
 "fs":{"uuid":"<btrfs fsid>","generation":918273},
 "subvols":[{"uuid":"…","transid":918200}, …],
 "snapshots":"sha256:<digest of sorted (snap id, btrfs uuid, transid) list>",
 "keystore":{"uuid":"<@keystore subvolume uuid>","transid":918150}}
```

```
mac = HMAC-SHA256(K_anchor, JCS(anchor))
```

The `keystore` entry is the `@keystore` subvolume's btrfs generation, read with `BTRFS_IOC_GET_SUBVOL_INFO` on the subvolume ID through the root filesystem fd, without reading its contents (Landlock denies `strata` read access beneath `/keystore`). A rolled-back keystore therefore shows as a lower `transid`.

TPM objects (protocols §19.6; constants from `keylos-tpm-registry`):

| Object | Handle | Definition |
|---|---|---|
| `strata-anchor-counter` | NV `0x01300107` | Counter with the common keylos NV attributes (protocols §19.6): readable by anyone through the `PolicyCommandCode(NV_Read)` branch; written with `AUTHWRITE` using an authValue that `installer` (at genesis) or `hearth` (on re-provisioning) stores as a TPM-sealed blob at `/var/lib/keylos/tpm/nv-auth/0x01300107.sealed`, sealed to the signed PCR11 `ready` phase and PCR15 (volume identity) |
| `K_anchor` (anchor HMAC key) | persistent `0x81000110` (owner hierarchy) | Keyed-hash key; policy `PolicyPCR(15) ∧ PolicyNV(0x01300107 ≥ 1)` |

`strata` never creates these objects; it holds no owner-hierarchy authorization (protocols §19.6: only `hearth` does). Both are created at installation. A missing object at start means the TPM was cleared or not provisioned (`unanchored`, below). `strata anchor reset` then asks `hearth` to re-define the counter with `HearthTpm.defineSpace(0x01300107)` (facet `tpm`, presence required by `hearth`) and, if `0x81000110` is also missing, to re-create the HMAC key with `HearthTpm.recreateKey(0x81000110, presenceEnvelope)`, where the envelope is obtained from `Hearth.presence` with purpose `boot.recreate-key` over the handle (protocols §7.5.3). `strata` is the registered owner of both objects (protocols §19.6). After a reset, the anchor restarts from the current snapshot roots and the next update writes a `x-strata.anchor.reset` receipt.

**Update:**
1. Unseal the counter authValue from `/var/lib/keylos/tpm/nv-auth/0x01300107.sealed` (succeeds only in the PCR11 `ready` phase with the enrolled volume identity).
2. Read the counter `c` from NV `0x01300107` (public `NV_Read` branch).
3. `TPM2_NV_Increment(0x01300107)`.
4. Write the anchor with `counter = c+1` and its MAC (computed with `K_anchor` under its policy session), then fsync.

The increment comes before the write, so a crash in between leaves the stored anchor at a lower counter. On startup that looks like rollback, so the verifier accepts `stored = NV − 1` once, if the stored fs generation ≤ the current one. It then immediately rewrites the anchor.

**Verify at startup:**

| Observation | Verdict |
|---|---|
| MAC invalid | `tampered` |
| `stored.counter == NV` and `fs.generation_now ≥ stored.fs.generation` | ok |
| `stored.counter == NV − 1` (crash window) and generations monotonic | ok, rewrite |
| `stored.counter < NV − 1`, or `fs.generation_now < stored.fs.generation` | `rollback-detected` |
| NV index missing (TPM cleared) | `unanchored` → re-create after a T3 approval with presence (§6.2, `strata anchor reset`) |

Rate: at most one increment per 60 s, and at least one per hour while the fs generation advanced. That is about 9,000–60,000 increments per year, within TPM NV endurance for counters (implemented as RAM-backed counters with periodic NV flush on most TPMs). On TPMs reporting `TPM_PT_NV_COUNTERS_MAX` exhaustion risk, `strata` lowers the rate to one per 6 h.

**Residual:** replaying individual old sectors within one image epoch can produce an inconsistent filesystem that the anchor doesn't flag. btrfs metadata checksums plus dm-integrity sector binding make this detectable as corruption, not as rollback.

### 4.9 Provenance

#### 4.9.1 Record

`security.bpf.keylos.prov` holds a CBOR map (protocols §10.4):

```
{ "p": principal text, "g": generation ref text, "x": transaction id text | null, "t": unix nanos (int) }
```

Maximum size 512 bytes. Principals longer than the budget are stored with the session chain truncated to the first and last sessions, joined by `/…/`.

#### 4.9.2 Kernel path (feature `bpf-init-inode-xattr`)

**Loading.** Only `warden` core may load BPF programs on a keylos host (`kl-exec` denies `BPF_PROG_LOAD` to every other task, protocols §9.3). Service BPF programs are loaded only from the **OS generation**: the object is built in this repository and installed by `pkgs` at `/usr/lib/keylos/bpf/strata/provenance.o`, and the `strata` entry of `/etc/keylos/services.json` lists it in `bpf` (protocols §20.16). `warden` loads and attaches it before starting `strata`, and passes the map fds to the `strata` service in `KEYLOS_BPF_FDS` (protocols §10.5) as `prov_fs`, `cg2prin`, `clock` and `events`. `strata` hands those fds to `strata-provd` when it spawns it (`SpawnSpec.fds`, with the fd numbers in argv `--maps prov_fs=3,cg2prin=4,clock=5,events=6`, because `KEYLOS_*` names are reserved for `warden`). `strata-provd` only reads and updates maps; nothing in `strata` loads or detaches programs.

`provenance.o` attaches `lsm/inode_init_security`. For an inode on a filesystem whose `sb->s_uuid` is in `prov_fs` (filled by `strata-provd`):

1. Read `bpf_get_current_cgroup_id()`.
2. Look up the cgroup ID in hash map `cg2prin` (cgroup ID → pre-encoded CBOR prefix `{p, g}`, maintained by `strata-provd` from `warden` spawn events; §4.9.4).
3. Leave `x` null. Files created inside a transaction are created on the transaction's upper layer; `strata` sets `x` to the transaction ID when it writes them into the live tree at commit (§4.5.6), keeping `p`, `g` and `t` from the upper-layer record. Live-tree files therefore carry `x` exactly when a transaction committed them.
4. Append `t = bpf_ktime_get_boot_ns()` translated by the boot offset in map `clock`.
5. Call `bpf_init_inode_xattr(xattrs, xattr_count, "keylos.prov", value, len)`. The `security.` prefix is implied by the hook.

If `cg2prin` misses (a process spawned before the map update, which should not happen because warden publishes before exec), the program writes `{p: "unknown", c: cgroup id}`, and `strata-provd` later rewrites it from its spawn log.

#### 4.9.3 Fallback path (no kfunc)

The BPF program attaches `lsm/inode_init_security` and records `(s_dev, i_ino, i_generation, cgroup_id, ktime)` into a ring buffer (`BPF_MAP_TYPE_RINGBUF`, 8 MiB). It does not write xattrs.

`strata-provd`:
- holds a fanotify group with `FAN_REPORT_DFID_NAME | FAN_REPORT_FID | FAN_CLASS_NOTIF`, marked on the filesystems (`FAN_MARK_FILESYSTEM`) with `FAN_CREATE | FAN_ONDIR | FAN_MOVED_TO`;
- joins ring-buffer records with fanotify events on `(dev, ino, generation)`, decoding the btrfs file handle from `FAN_REPORT_FID`, which contains objectid = ino, root id and generation;
- opens the object with `open_by_handle_at(mount_fd, handle, O_PATH)` and writes `security.bpf.keylos.prov` via `fsetxattr` on `/proc/self/fd/<n>`.

Records that can't be joined within 5 s (the file was deleted) are dropped and counted. Records for files that already have a provenance xattr are skipped, so the kernel path wins when both run.

Fallback latency: p99 ≤ 1 s at 10,000 creates/s. Beyond that rate, `strata-provd` degrades by sampling: it keeps every directory creation and 1 in N file creations, with N adaptive. It counts the degradation in metrics and marks unattributed files `{p: "unattributed"}` lazily on `why`.

#### 4.9.4 Principal map maintenance

- `strata-provd` subscribes to `PrincipalControl.events(watcher, replay = true)` on the `warden` facet `strata` (protocols §7.5.1): it first receives one `spawned` event for every currently running session, then live events.
- On `spawned`, it takes the principal's kernel cgroup ID from `PrincipalEvent.cgroupId` (stable for the session's lifetime) and inserts `cgroup_id → CBOR {p, g}`. It does not derive cgroup paths.
- On `exited`, it deletes the entry after a 5 s grace for late records.
- A restarted `strata-provd` resubscribes with `replay = true`, which rebuilds the full map (including sessions spawned while it was down) before live events resume. Creations between its exit and the replay are recorded by the kernel program with the cgroup ID only (`{p: "pending", c: <cgroup id>}`); `strata-provd` rewrites them to the full record once the replayed map contains that cgroup ID, and only cgroups that exited before the replay remain `{p: "unknown", c: …}`, reported by `why` as unattributed. The tmpfs map snapshot `/run/keylos/strata/prin-map.cbor` is kept only to serve `why` during the replay.

#### 4.9.5 `why`

`why(fd)` performs `fgetxattr(fd, "security.bpf.keylos.prov")`, decodes it, and adds the current file label (`security.bpf.keylos.label`, or the location default). A missing xattr gives `kl:not-found`. The `strata why` CLI also prints the transaction receipt and the creating principal's session receipt chain from `ledger`, when available.

### 4.10 Backup

#### 4.10.1 Targets

| Kind | URI | Transport |
|---|---|---|
| Local disk | `local:<backup-disk name>/<path>` | Only a **keylos backup disk** (§4.10.5): a `storage-backup` class device obtained with a device token from `broker` (policy grant for the configured disk), materialized as an fd through `Broker.materialize`. `strata` verifies its `keylos-backup` token, unlocks it and mounts the inner btrfs with `nosuid,nodev,noexec`. No other filesystem or medium is accepted |
| SFTP | `sftp://user@host:port/path` | `Gate.connect` TCP stream; SSH via `russh` with an Ed25519 key derived from `Vault.dataKey("strata:sftp:<target>")` (HKDF-SHA256, info `"keylos-strata-sftp/1"`). The key exists only in a `memfd_secret` mapping inside `strata-backup`; `strata backup pubkey <target>` prints its public half for the server's `authorized_keys` |
| S3-compatible | `s3://endpoint/bucket/prefix` | `Gate.connect` HTTPS; credentials injected by `gate` (`vault.inject`) |
| REST server | `rest:https://host/path` | `Gate.connect` HTTPS |
| keylos replica | `replica://<peer replica key id>` | btrfs send stream over a `Gate.connect` TLS connection to another keylos `strata` (§4.10.4) |

#### 4.10.2 Runs

Default schedule: daily at 03:30 local time, after the daily snapshot set. On battery power (from `PowerEvents` `battery` events) and metered networks it is skipped, retried every hour, and forced after 3 days.

Per run, for each target:

1. Choose the source snapshots: the latest snapshot set, filtered by backup class.
   - `none`: skipped.
   - `standard`: plain and sealed units.
   - `sealed-only`: only sealed units' backing stores plus non-unit subvolumes labelled ≤ `internal`.
2. Spawn `strata-backup` (t0) with:
   - read-only `O_PATH` dirfds of the snapshot roots;
   - the repository password as a `memfd_secret` fd: `base64url(HKDF-SHA256(Vault.dataKey("strata:backup:<target>"), info = "keylos-strata-restic/1"))`, 43 characters. `strata backup password <target>` reveals it after a presence approval (§6.2), so the repository can be restored with stock `restic` elsewhere;
   - the gate socket factory capability.
3. `strata-backup` runs `rustic_core` backup with `--tag keylos,<set ULID>`. It uses the paths as they appear live (via `--as-path`), so restores land in the right places. Excludes: `*.unitfs/.unitfs-lock`, caches, and anything marked `security.bpf.keylos.label` conf `secret` unless the target is flagged `allowSecret`.
4. Apply forget policy: keep daily 7, weekly 5, monthly 12, yearly 3. Prune weekly.
5. Record a `BackupRunRecord` and emit `backup.run` (snapshot set, target, bytes added, duration, result).

#### 4.10.3 Restore test

Every 30 days per target (`strata.backup.restoreTestDays`):
1. Pick a random snapshot from the last 7 days.
2. Restore a random sample of at least 1 % of files and at least 200 files, up to 2 GiB, into a scratch subvolume `/var/lib/keylos/strata/restore-test/<run>`.
3. Compare the content hash of each file with the corresponding snapshot file.
4. Run `rustic check --read-data-subset 2%`.
5. Delete the scratch subvolume and emit `backup.restore-test`.

#### 4.10.4 Replicas (btrfs send/receive)

`strata replica add <name> --to replica://<key>` pairs two machines:
- The peer must accept, with a T3 approval on the peer.
- Mutual TLS uses an Ed25519 replica key derived from `Vault.dataKey("strata:replica")` (HKDF-SHA256, info `"keylos-strata-replica/1"`). The pairing records each side's public key, and nothing else is accepted.
- The receiving side listens through `gate` (`Gate.connect` with a `listen:` target, protocols §7.3.7), granted by policy for configured peers only.

Each run (receipt `x-strata.replica.send`):
1. For each subvolume in scope, send the latest snapshot incrementally against the last snapshot both sides share (tracked by received UUID), using `BTRFS_IOC_SEND` into a pipe.
2. Stream over the TLS connection.
3. The receiving `strata` runs `BTRFS_IOC_RECEIVE`-equivalent processing. That is userspace stream parsing as in `btrfs receive`, implemented in Rust (`strata-core::receive`) with strict path containment: every path in the stream is resolved with `RESOLVE_BENEATH` under the receive root, and any absolute or escaping path aborts the receive.
4. Received snapshots are stored read-only under `/snapshots/replicas/<peer>/`.

Sealed units travel as ciphertext.

#### 4.10.5 Keylos backup disks

A keylos backup disk is a removable disk that `strata backup init-disk` formatted for this machine:

1. `init-disk <device> --name <name>` needs a presence approval (`x-strata.backup-disk-init`, §6.2.3) because it destroys the disk's content. `strata` obtains a device token for the disk through `Broker.request` (resource `device`, reason naming the disk), materializes the fd, and:
   - creates a LUKS2 container (`aes-xts-plain64`, Argon2id) whose single keyslot passphrase is `base64url(HKDF-SHA256(K_disk, info = "keylos-strata-backupdisk-pass/1" ‖ LUKS UUID))`, where `K_disk = Vault.dataKey("strata:backupdisk")`;
   - adds the LUKS2 token `{"type": "keylos-backup", "keyslots": ["0"], "machine": "key:sha256:<machine key>", "name": "<name>", "mac": "<base64url HMAC-SHA256(HKDF-SHA256(K_disk, info = "keylos-strata-backupdisk-mac/1"), JCS(token without mac) ‖ LUKS UUID)>"}`;
   - creates a btrfs filesystem inside and the restic repository of the target.
2. When such a disk is plugged in and authorized, `devd` classifies it `storage-backup` from the token's presence alone (it performs no cryptography). `strata`, which holds the policy grant for the configured disk, opens it, recomputes the MAC with `K_disk` and compares it in constant time. A mismatch (a forged token, a disk of another machine) releases the device and raises a warning; nothing is mounted.
3. On a match `strata` unlocks it (`libcryptsetup`), mounts the btrfs `nosuid,nodev,noexec` under its private mount namespace, runs the scheduled or pending backup, unmounts and closes the container. The disk is never visible in any principal's view.

### 4.11 Sync integration

`strata` does not sync. It provides:
- `strata.syncHints` written as a `user.keylos.nosync` xattr on SQLite databases and lock files it detects in app data. Sync apps should honour it; the keylos Syncthing package does.
- An API, through `strata why` and `snapshots`, that sync apps may use to version conflicts.

Configuration sync uses git through `config`.

### 4.12 Homes

`StrataHomes` (protocols §7.5.7) is served on the `hearth` facet only.

`createHome(user, uid)`:
1. Creates `/home/<user>` as a subvolume of kind `Home`, owned by `uid`, mode `0700`, label `private/user`.
2. Creates the unit `u-home-<user>` (plain by default; sealed if `strata.units.sealHomes` is true).
3. Registers `user ↔ uid` in the registry; that mapping is also used by the provenance map (§4.9.4).
4. Returns its `SubvolInfo`.

It is idempotent: a second call for an existing, matching home returns the existing record.

`deleteHome(user, forget)`:
1. Refuses with `kl:conflict` while any session of that human is live (`PrincipalControl.events` state).
2. With `forget = true`, it shreds every unit of the human (sealed units: key destruction; plain units: §4.7.5) and deletes every subvolume and snapshot of the human. `hearth` has already obtained presence for the user deletion, so `strata` asks for no further approval.
3. With `forget = false`, it deletes the live subvolumes but keeps snapshots under their normal retention.

It emits `unit.forget` per unit and `snapshot.delete` per batch.

`createEphemeralHome(user, uid)` creates a guest home (§4.15).

App subvolumes under `/home/<user>/.apps/<app>/{config,data,cache,state}` are created lazily. When `warden` builds an app view it calls `StrataAdmin.mountUnit("u-app-<user>-<app>-<name>")` (facet `warden`); on the first call `strata` creates the subvolumes and the unit. `mountUnit` returns a detached mount of the plaintext view for sealed units (§4.7.3) and an `open_tree(OPEN_TREE_CLONE)` detached mount of the subvolume for plain units. `warden` idmaps it to the app's dynamic UID (§6.4). Owners can also create subvolumes explicitly with `StrataAdmin.createSubvolume`.

### 4.13 Pre-update snapshot sets

`StrataAdmin.preUpdate(reason)` (facet `courier`) takes one snapshot set (§4.4.2) of `@var` and every `Home` subvolume with class `update`, and returns the set ULID. `courier` records it with the staged update, so a rollback can offer the matching data state. Retention: the last 3 sets. Guest homes and pod volumes are not included.

### 4.14 Pod volumes (`StrataVolumes`)

Layout under the `@var` subvolume tree:

```
/var/lib/keylos/strata/volumes/
  pods/<pod-id>/<name>/      emptyDir subvolumes (kind PodVolume, snapshot class none)
  local/<name>/              local PersistentVolume subvolumes (kind PodVolume, class none or system)
```

`create(podId, name, kind, sizeBytes)`:
1. Validate `podId` (`pod-` + ULID, protocols §3.5) and `name` (DNS-1123 label); reject `..`, `/` and over-long names.
2. Idempotent: an existing volume with the same key and kind is returned as is (its `sizeBytes` limit is updated).
3. Create the subvolume (§4.3) owned by UID `0x0FFF0000` (the reserved `_cluster` on-disk owner, protocols §10.3), mode `0755`, label `internal/user`, no unit (pod data is not personal data of a human; crypto-shredding is by deletion).
4. Record `{podId, name, kind, sizeBytes, created}` in the registry table `volumes`; emit `x-strata.volume.create`.
5. Return an `O_PATH` dirfd opened with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` from the held `@var` root.

**Usage scan.** Every `usageScanSecs`, for each volume, `strata` walks the subvolume with `statx` (`STATX_BLOCKS`) and sums `st_blocks × 512`, bounded at 2 000 000 inodes per volume per scan (over the bound, it uses `BTRFS_IOC_TREE_SEARCH_V2` over the subvolume's extent items, which counts shared extents once). `usage(podId)` returns JCS `{"volumes": [{"name", "kind", "usedBytes", "limitBytes", "over": bool, "readOnly": bool, "scanned": "<time>"}]}`.

`release(podId, name)`:
- `emptyDir`: delete the subvolume (asynchronous cleaner) and the registry record; `x-strata.volume.release`.
- `local`: delete only when `name` is not referenced by another pod record; the CRI semantics of PersistentVolume reclaim (`Delete`) are decided by `cri`, which calls `release` only for volumes to delete.

**Reconciliation.** At start, `strata` keeps every pod volume. When `cri` starts, it calls `create` again for every volume of the pods it still runs; the call is idempotent and re-attaches the volume. `emptyDir` volumes not re-attached within 10 minutes after `cri`'s first connection are deleted; `local` volumes are never deleted by reconciliation.

### 4.15 Guest homes

`createEphemeralHome(user, uid)` (facet `hearth`):
1. Check the `guest-` prefix (REQ-STRATA-090) and that no home of that name exists.
2. Generate `K_g` (32 random bytes) into a `memfd_secret` mapping.
3. Create the backing subvolume `/home/<user>.unitfs/` (kind `GuestHome`, snapshot and backup class `none`) and start `strata-unitfs@u-guest-<user>` with `K_g` (the unitfs format of §4.7.3, also on kernels with btrfs fscrypt, because a key that never leaves `strata` must not enter the kernel keyring of a shared machine).
4. Register the unit (`mode: ephemeral`), emit `unit.create`, return the `SubvolInfo`.

`hearth` deletes the home at guest logout with `deleteHome(user, forget = true)` (`guest.end`); `strata` zeroizes `K_g` first, then deletes the backing store and the plaintext mount point, and emits `unit.forget`. A guest's app units are created lazily under the guest home by `mountUnit` and are sealed with keys derived from `K_g` (`HKDF-SHA256(K_g, info = unit id)`), so they share the guest home's lifetime.

---

## 5. Interfaces

### 5.1 capwire facets

`strata` serves `Strata` and the `strata-sys` interfaces on `/run/keylos/svc/strata/`. It implements exactly the facets listed for `strata` in protocols §19.2 (Appendix A.20), refusing other methods with `kl:denied`:

| Facet | Holders | Methods allowed (refines protocols §19.2) |
|---|---|---|
| `user` | `shell`, apps with the route, `kish` | `begin`, `snapshot` (own subvolumes, reason forced `manual`), `snapshots`, `restore` and `undo` (own), `why` (any fd they hold), `createUnit` (own home subtree); `StrataTxn` (own transactions) |
| `cli` | the `strata` CLI under `shell` | as `user`, plus `forget` (own units, presence through §6.2) |
| `bench` | `bench` | `begin` (origin `Bench`); `StrataTxn` (own transactions; `preparedFor` for workflow-owned ones, §4.5.11); `TransactionExt.bindWorkflow` |
| `aide` | `aide` | `begin` (origin `Agent`); `StrataTxn` (own transactions; `preparedFor` for workflow-owned ones, §4.5.11); `TransactionExt.bindWorkflow` |
| `compat` | `compat` | `createUnit`, `forget` for `app/*` units of legacy apps (presence through §6.2) |
| `warden` | `warden` | `StrataAdmin.mountUnit`; `StrataTxn` (any `Open` transaction, §4.5.3) |
| `hearth` | `hearth` | `StrataHomes` (`createHome`, `deleteHome`, `createEphemeralHome`); `StrataAdmin.lockUnits`/`unlockUnits` |
| `courier` | `courier` | `StrataAdmin.preUpdate` |
| `gate` | `gate` | `Strata.undo`, only for `fs.merge`-committed transactions (§4.5.9) |
| `cri` | `cri` | `StrataVolumes` (§4.14) |
| `admin` | `config`, owner `shell` | all, including `forget` (presence through §6.2); `StrataAdmin` |

"Own" means the subvolume's `human` equals the caller principal's human and, for app subvolumes, the caller is that app or a `shell` principal. For transactions, "own" means begun by the caller's session or a session ancestor.

### 5.2 System interfaces

The `strata-sys` interfaces (protocols §7.5.7, Appendix A.7) are obtained with `Extensible.ext(interfaceId)` on the `Strata` bootstrap capability, as the facet allows:

| Interface | Methods and `strata` semantics |
|---|---|
| `StrataTxn` | `txnExt(id)` returns the `Transaction` and its `TransactionExt`; `prepared(id)` returns a `PreparedMerge` by `pm-…` ID (own transactions; used by `bench` and `aide` after a restart); `preparedFor(id, binding)` returns it for a current attempt of the owning workflow (REQ-STRATA-101) |
| `TransactionExt` | `policy()` returns `(networkPolicy, views)`, with `views[i]` the canonical live path of target *i* (§4.5.3); `resolve` (§4.5.5); `prepare()` (§4.5.6) returns the immutable `PreparedMerge`; `changeSet()` returns the current prepared merge's `keylos.fsmerge/2` JCS document as a memfd plus its digest (`kl:not-found` before `prepare`, §4.5.7); `commitWithMandate(mandate)` fails `kl:unsupported` (superseded, REQ-STRATA-028); `pin(pinned)` exempts the transaction from TTL abort (REQ-STRATA-029); `owner()` returns the session that began the transaction (REQ-STRATA-097) |
| `PreparedMerge` | `id()` (`pm-…`), `manifest()` (fsmerge/2 memfd + digest), `diff(path)` (from the prepared store only), `commit(mandate)` (§4.5.6, §6.2.2; idempotent, REQ-STRATA-104), `discard()`, `status()` (durable completion record, REQ-STRATA-103) |
| `StrataAdmin` | `subvolumes`, `createSubvolume`, `deleteSubvolume`, `units`, `mountUnit` (detached mount fd of a sealed unit's plaintext view, §4.7.3), `lockUnits`/`unlockUnits` (§4.7.6), `pin`, `deleteSnapshot`, `backupNow`, `backups`, `status` (JSON as printed by `strata status --json`), `preUpdate` (§4.13) |
| `StrataHomes` | `createHome`, `deleteHome` (§4.12), `createEphemeralHome` (§4.15) |
| `StrataVolumes` | `create`, `release`, `usage` (§4.14) |

### 5.3 CLI: `strata`

Global flags: `--json` (machine output), `--yes` (skip the local confirmation; never skips trusted-path prompts), `--quiet`.

| Command | Description |
|---|---|
| `strata status` | Space level, anchor state, provenance mode, units mounted, last backup per target, pending transactions |
| `strata subvol list [--user U] [--kind K]` | Registry listing |
| `strata subvol create <dir> --kind project [--sealed]` | Turn a new directory into a registered project subvolume (the directory must not exist yet) |
| `strata project add <existing-dir>` | Convert an existing directory to a subvolume. Implemented as create-new + reflink copy + `RENAME_EXCHANGE`; refuses if files are open |
| `strata snapshot <path> [--reason TEXT] [--pin]` | Manual snapshot |
| `strata snapshots [<path>] [--all]` | List snapshots |
| `strata snapshot pin\|unpin <snap-id>` | |
| `strata snapshot rm <snap-id>` | Delete; requires a confirmation for pinned snapshots |
| `strata browse <snap-id> [<path>]` | Opens a read-only view (prints a path under `/run/user/<uid>/strata/browse/<snap>` mounted in the caller's view by `warden`) |
| `strata restore <snap-id> <path> [--to <dir>]` | Restore a file or tree. The default target is the original location; the existing content is kept in an `UndoGuard` snapshot |
| `strata txn list` | Open, frozen and recent transactions |
| `strata txn show <x-id> [--diff [<path>]]` | Changes, conflicts, diff |
| `strata txn commit <x-id>` | Commit (shell-origin transactions only; prepare + commit) |
| `strata txn prepare <x-id>` | Prepare and print the `pm-…` ID, manifest digest and diff (any own transaction) |
| `strata txn abort <x-id>` | |
| `strata txn resolve <x-id> <path> ours\|theirs\|--merged <file>` | |
| `strata undo <x-id> [--force]` | |
| `strata why <path>` | Provenance + label + receipts |
| `strata unit list` | |
| `strata unit create <dir> [--sealed] [--alias NAME]` | |
| `strata unit forget <unit\|alias>` | Requires presence (FIDO2 touch) via the trusted path |
| `strata unit migrate <unit>\|--all` | unitfs → fscrypt migration |
| `strata unit export <unit> --to <dir>` | Decrypt-copy, for leaving keylos. Requires presence |
| `strata backup targets` | |
| `strata backup add <name> <uri> [--class standard\|sealed-only]` | Writes a config proposal; targets are part of configuration |
| `strata backup run [<name>]` | |
| `strata backup snapshots <name>` | List repository snapshots |
| `strata backup restore <name> <repo-snapshot> <path> --to <dir>` | |
| `strata backup test <name>` | Run a restore test now |
| `strata backup init-disk <device-id> --name <name>` | Format a removable disk as a keylos backup disk (§4.10.5). Destroys its content; requires presence |
| `strata replica add\|list\|run\|remove …` | |
| `strata anchor verify` | Run the anchor check now |
| `strata anchor reset` | After a TPM clear or a confirmed legitimate restore. Requires presence |
| `strata volumes list [--pod P]` | Pod volumes with usage and limits (owner; `server-k8s` profile) |
| `strata quarantine <app\|unit> [--user U]` | Quarantine app data units read-only after a pinned snapshot (REQ-STRATA-098) |
| `strata quarantine list\|release <app\|unit>\|rollback <app\|unit> <snap-id>` | Show, release, or roll back quarantined units |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Operation failed (`kl:internal`, `kl:unavailable`) |
| 2 | Usage error |
| 3 | Denied (`kl:denied`) |
| 4 | Conflict (`kl:conflict`) |
| 5 | Not found |
| 6 | Needs approval (approval ID on stderr) |
| 7 | Integrity failure (`kl:integrity`, rollback detected) |
| 8 | Unsupported on this kernel |

### 5.4 Environment and spawn conventions

`strata` defines no environment variables. Processes in a transaction are spawned with `SpawnSpec.transaction` (protocols §7.3.2); `warden` mounts the views (§4.5.3) and sets `KEYLOS_TXN` (protocols §10.5). Names starting with `KEYLOS_` are reserved, so spawners MUST NOT set them in `SpawnSpec.env`.

### 5.5 Files

| Path | Content |
|---|---|
| `/var/lib/keylos/strata/registry.redb` | Registry |
| `/var/lib/keylos/strata/anchor` | Current anchor JSON + MAC |
| `/var/lib/keylos/tpm/nv-auth/0x01300107.sealed` | TPM-sealed authValue of NV `0x01300107`, written by `installer`/`hearth`, read by `strata` only (protocols §10.7) |
| `/var/lib/keylos/strata/volumes/{pods,local}/…` | Pod volume subvolumes (§4.14) |
| `/var/lib/keylos/strata/txn/<x-id>/journal` | Commit journal |
| `/snapshots/<subvol-uuid>/<snap-id>` | Snapshots |
| `/snapshots/.txn/<x-id>/<i>/{upper,work}` | Transaction layers (overlay backend); `/snapshots/.txn/<x-id>/{base,work}` ciphertext clones (unitfs backend) |
| `/snapshots/.prepared/<pm-id>/` | Immutable prepared-merge store (reflinked content; ciphertext for unitfs targets) |
| `/snapshots/replicas/<peer>/…` | Received replicas |
| `/etc/strata/strata.toml` | Rendered config, from the config generation (§10) |

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| A principal uses `begin`, `restore` or `why` to read data it has no access to | All targets arrive as fds the caller already holds, with access-mode checks (§6.2). `restore` writes only into a caller-provided target fd. `why` only reads xattrs of a file the caller already holds open |
| Symlink or path tricks against `strata` during commit or restore (confused deputy) | All operations resolve with `openat2(RESOLVE_BENEATH\|RESOLVE_NO_SYMLINKS\|RESOLVE_NO_MAGICLINKS\|RESOLVE_NO_XDEV)` from held dirfds. `strata` never follows paths provided as strings. Upper-layer symlinks are copied as symlinks, never dereferenced |
| An agent smuggles a privileged file into a merge (setuid bit, device node, `security.*` xattrs) | Commit strips `S_ISUID`, `S_ISGID` (on files) and `security.*`/`trusted.*` xattrs other than `security.bpf.keylos.label` and `security.bpf.keylos.prov`. The label is recomputed as the max of the base label and the origin session's label (`LabelAuthority.labelOf`, protocols §7.5.2). Special files are refused. Mount flags `nosuid,nodev,noexec` remain the second line of defence |
| An agent commits its own changes | REQ-STRATA-028: only `PreparedMerge.commit` with a mandate that binds the prepared digest and passes §6.2.2. Mandates are single-use: their approval ID is recorded |
| Committed content differs from approved content (merge after approval, late agent write, racing writer) | REQ-STRATA-025/030/031: immutable prepared merge, commit applies only stored ops, writer fence, stale live state → `kl:conflict` |
| Data from one principal reaches another through a transaction | When the committing principal differs from the transaction's origin session (a human merging agent work), `strata` raises the committing session's label to the transaction's label with `LabelAuthority.raiseFor` before returning from commit (protocols §14.1, label authority) |
| A forged provenance xattr | `security.*` xattrs need `CAP_SYS_ADMIN` to set. Principals have none. Copies by tools drop the xattr rather than forge it |
| Offline rollback of user data | Anchors (§4.8) |
| Theft of a unit key from `strata` memory | Keys are held only in `memfd_secret` mappings, with `mseal` on key pages. `strata` and `strata-unitfs` are not ptrace-able (Yama, plus no other process shares their UID). Core dumps are disabled (`PR_SET_DUMPABLE 0`) |
| Backup credentials leak | Repository passwords and SFTP and replica keys are derived from `vault` keys in `memfd_secret` mappings and never written. S3 credentials are injected by `gate`; `strata-backup` never sees them |
| Malicious replica stream | Receive-side containment (§4.10.4) and size limits. Only paired replica keys are accepted |
| Denial of service by filling the disk inside a transaction | Upper dirs live in `@snapshots`. `strata` enforces a per-transaction upper budget, default 20 GiB or 10 % of free space, whichever is smaller. It measures upper usage with an fanotify `FAN_MODIFY` listener on the upper mount plus periodic `du` via `statx` walks. When exceeded, the views are frozen read-only and `kl:budget` is reported |

### 6.2 Access checks, mandates and presence

#### 6.2.1 Write check for `begin`

Holding a dirfd is the authority (protocols §7.1, §7.3.10). There are no call-attached tokens. `strata` grants a target only for the access that the caller's own view gives it:
1. `fstatvfs(d)`: the mount `d` belongs to MUST NOT be read-only (`ST_RDONLY` clear). Read-only grants are read-only mounts in the holder's view (`GrantMounts.attachGrant(readOnly)`, protocols §7.5.1), so this check carries the grant's access mode.
2. `statx(d, "", AT_EMPTY_PATH)` through that mount: the caller's UID MUST pass Unix write-permission evaluation (owner, group, mode, POSIX ACLs) on the attributes as seen through the mount, which applies the mount's idmapping. The caller's UID is taken from the connection's kernel credentials (`SO_PEERCRED` uid, cross-checked against the peer pidfd). It is used only for this permission evaluation; identity always comes from `warden` (protocols §7.1).
3. `d` MUST resolve to a directory on the root btrfs filesystem, outside `/keystore` and `/snapshots` (§4.5.2).

Landlock restrictions are invisible to other processes. `strata` therefore relies on `warden` expressing every read-only access as a read-only mount in the principal's view, which is how grant mounts and app views are built (protocols §7.3.3, directory grants).

#### 6.2.2 Mandates for agent commits

`PreparedMerge.commit(mandate)` of a transaction begun on the `bench` or `aide` facet succeeds only if all of these hold:
1. `mandate` is a DSSE envelope of `keylos.mandate/1` whose payload is JCS-canonical (protocols §5.1, §14.4).
2. Exactly one entry of `effects[]` has kind `fs.merge`.
3. **Binding:** that entry's `digest` equals the prepared merge's `keylos.fsmerge/2` manifest digest (§4.5.7), on both facets. `bench` maps its `BenchMerge` manifest digest to the same prepared merge (protocols §7.5.10), so there is no second digest meaning. The prepared merge must be `Ready` (not `Stale`, `Discarded` or `Committed`).
4. **Authenticity.** A delivered mandate is either presence-signed or re-signed by `service/broker` (protocols §14.4); `strata` never needs approver keys:
   - If the signature `alg` is `fido2-es256` or `fido2-eddsa`, it is verified with `keylos-presence` (protocols §5.3) against the owner-presence credentials returned by `HearthSystem.owners()` (facet `hearth#system`, the live owner registry). `strata` caches the owner set for 60 s and refreshes it once on a verification miss, so credentials enrolled after boot verify and removed credentials stop verifying within a minute.
   - If the signature is by `service/broker` (`ed25519`), `strata` verifies it with the key returned by `Ledger.serviceKey("broker")` (protocols §7.3.5). The key is cached and refreshed once on an unknown key ID (broker key rotation), at most once per 10 s.
   - Any other signer (an atrium approver key, the phone key, an `approver/<id>` key) MUST be refused.
5. `mandate.principal` is the transaction's origin principal or one of its session ancestors, and `constraints.expires`, if present, is in the future (trusted time, protocols §3.6).
6. `mandate.approval` has not been used before. Used approval IDs are kept in the registry table `mandates` for 400 days. An approval ID is recorded as used only when the journal reaches `applied`; a commit refused for stale live state or a lost fence leaves it unused, but it can never authorize a different prepared merge because its digest binds this one.

A failure gives `kl:denied` (checks 1, 2, 3, 5), `kl:integrity` (check 4) or `kl:revoked` (check 6).

#### 6.2.3 Presence approvals

`forget` (facets `cli`, `compat`, `admin`), `strata unit export`, `strata anchor reset`, `strata backup password` and `strata backup init-disk` need an approval with presence. Protocols §7.5.2 lets `strata` call `requestFor` only for **its own session**, so the request names `strata` as the subject and carries the requesting principal in the rendered reason:

```
BrokerSystem.requestFor(subject = strata's own session,
                        req = { resource: effect "<kind>", rights: [commit],
                                reason: "<rendered summary, including the requesting principal and the unit/disk>",
                                durationSecs: 300, persist: false },
                        intent = "",
                        idempotencyKey = "<kind>:<target id>:<requesting session>")
```

Repeated calls with the same idempotency key (a CLI retry while the prompt is open) return the same approval (protocols §7.5.2). Presence is an owner credential by definition (protocols §5.3), so on a family machine a non-owner's request is shown to an owner with `requester` set (protocols §14.3).

| Operation | `<kind>` |
|---|---|
| `forget` | `x-strata.unit-forget` |
| unit export | `x-strata.unit-export` |
| anchor reset | `x-strata.anchor-reset` |
| backup password | `x-strata.backup-password` |
| backup disk format | `x-strata.backup-disk-init` |

The `strata` module of `config` registers these effect kinds as `irreversible` and ships `permit` policies for principal `service:strata` annotated `@tier("t3") @presence("true")` (protocols §16.2). `strata` proceeds only if the result is `granted` and `GrantResult.mandate` is presence-signed (verified as in §6.2.2 check 4, first case) for the same kind. Otherwise it returns `kl:denied`, or `kl:needs-approval` with the approval ID while it is pending.

`StrataHomes.deleteHome(user, forget = true)` from `hearth` needs no further approval: `hearth` required presence for the user deletion.

#### 6.2.4 Other checks

- `restore(snapshot, path, target)`: the snapshot MUST belong to a subvolume the caller owns (§5.1), and `target` is written with the same checks as §6.2.1.
- `why(fd)`: no check beyond holding `fd`.
- `undo(txn)`: own transactions only; the live paths are rewritten with the checks of §6.2.1 against the transaction's original targets.

### 6.3 Self-confinement

`strata` is tier 0 with these allowances beyond the baseline (protocols §9.1):

| Allowance | Why |
|---|---|
| seccomp: `fsopen`, `fsconfig`, `fsmount`, `mount_setattr`, `open_tree`, `move_mount` (only with `MOVE_MOUNT_F_EMPTY_PATH` from detached fds), `umount2` | Overlay views and unit mounts |
| seccomp: `ioctl` restricted to btrfs ioctls (`0x94` magic), `FS_IOC_*` fscrypt and verity, `FICLONE`, `FIEMAP` | Subvolume and encryption operations |
| seccomp: `fanotify_init`, `fanotify_mark` (`strata-provd` only); `bpf` with command ∈ {`BPF_MAP_LOOKUP_ELEM`, `BPF_MAP_UPDATE_ELEM`, `BPF_MAP_DELETE_ELEM`, `BPF_MAP_GET_NEXT_KEY`} (`strata-provd` only, on map fds received from `warden`) | Provenance. Program loading stays with `warden` core (§4.9.2); `kl-exec` denies it to every other task anyway |
| seccomp: `fcntl F_SETLEASE` | Open-file detection |
| Landlock: read/write beneath `/var`, `/home`, `/snapshots`; read of `/etc/keylos/strata/snapshot-exclude.list` and `/var/lib/keylos/tpm/nv-auth/0x01300107.sealed`; read beneath `/keystore` denied (it uses vault); no execute anywhere except its own generation | |
| Devices: `/dev/mapper/control` and dm nodes (unlocking keylos backup disks with `libcryptsetup`); backup-disk block devices only as fds materialized from `storage-backup` device tokens | §4.10.5 |
| Capabilities: `CAP_SYS_ADMIN`, `CAP_DAC_READ_SEARCH`, `CAP_FOWNER`, `CAP_CHOWN`, `CAP_LEASE` (`strata`); `CAP_SYS_ADMIN`, `CAP_DAC_READ_SEARCH`, `CAP_BPF` (`strata-provd`, map access under `kernel.unprivileged_bpf_disabled=2` only) | Ambient in their own cgroup only; `NO_NEW_PRIVS` still set |
| Network | None. Egress only via `Gate.connect` fds |

`strata-unitfs@<unit>` has no capabilities. Its Landlock rules are read/write beneath the unit's backing subvolume only; its only other fd is `/dev/fuse`. The FUSE server never execs.

### 6.4 Ownership of app data

Everything under `/home/<user>`, including app subvolumes, is owned on disk by the human's UID (1000–59999, allocated by `hearth`). Service state subvolumes are owned by the UID named in `StrataAdmin.createSubvolume(owner)`.

Running principals have dynamic UIDs (protocols §10.3). `warden` makes the data reachable through **idmapped mounts** (protocols §9.1 item 2, `GrantMounts.idmappedDir`): the app's `.apps/<app>` subvolumes are mounted in its view idmapped from the human's UID to the app's dynamic UID. Data ownership is therefore stable on disk while running UIDs change, and two apps of the same human never see each other's data, because each view contains only that app's subvolumes.

### 6.5 Atomic-mode liveness check

Atomic commit (§4.5.6) swaps a whole subvolume, which would strand writers holding fds into the old one. `strata` uses it only when no other principal can reach the subvolume:
1. `strata` keeps the set of live sessions from `PrincipalControl.events(…, replay = true)` (protocols §7.5.1), so the set is complete from the first event batch.
2. For each live session other than the transaction's own sessions, it calls `PrincipalControl.mountView(session)` and checks whether any entry's `source` lies inside the subvolume.
3. If none does, atomic mode is allowed.

If the event stream is not established or its replay has not completed, or any `mountView` call fails or times out (200 ms), `strata` uses incremental mode.

The atomic-mode check decides only between swap and in-place application; writer exclusion during every commit is the writer fence (§4.5.6, REQ-STRATA-031), not this check.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| `vault` unavailable at unlock | Sealed units stay unmounted. Apps depending on them fail to start with `kl:unavailable`. Plain units are unaffected |
| `ledger` unavailable | Operations proceed. Receipts are queued in `/var/lib/keylos/strata/receipt-queue` (bounded at 100 MiB, oldest-dropped with a count) and flushed when `ledger` returns. Exception: `forget` and `undo` refuse to proceed without `ledger` (`kl:unavailable`), because their audit is mandatory |
| TPM unavailable | Anchor updates are suspended (`unanchored` warning). Everything else works |
| Disk full during commit | The incremental commit fails on ENOSPC and rolls back from the journal. The transaction returns to `Prepared` (the prepared merge stays `Ready`) with conflict `no-space` |
| Crash during commit | §4.5.6 recovery |
| Live path changed after `prepare` | `PreparedMerge.commit` fails `kl:conflict` with the paths; the prepared merge is `Stale`; a new `prepare` and a new approval are needed |
| Writer fence refused (non-freezable writer) | `kl:conflict` reason `writer-unfenceable`; nothing applied |
| Writer fence lost before `applied` (timeout, `warden` restart) | Rollback from the pre-commit snapshot, `x-strata.txn.rollback{reason: "fence-lost"}`, `kl:unavailable`; the prepared merge is `Ready` again |
| `broker` unavailable | `bindWorkflow` and `preparedFor` fail `kl:unavailable`; accesses to bound transactions that need the currency check (REQ-STRATA-102) fail `kl:unavailable`; unbound transactions are unaffected |
| Workflow cancelled or forgotten | REQ-STRATA-106: open bound transactions aborted, `Ready` prepared merges discarded; committed ones untouched |
| Unit locked during a unitfs transaction | Views `ENOTCONN`; `prepare`/`commit` `kl:unavailable`; the transaction resumes after unlock (§4.5.10) |
| Crash of `strata-unitfs` | `warden` restarts it. Open fds in apps see `ENOTCONN` until the restart; apps are expected to retry. Writes since the last flush are lost; unitfs fsyncs on each FUSE `fsync`/`flush` |
| btrfs `ENOSPC` with metadata exhausted | `strata` triggers a balance of empty block groups (`btrfs balance start -dusage=0 -musage=0` equivalent via `BTRFS_IOC_BALANCE_V2`), then pressure pruning |
| Rollback detected | §3.5. The user decides: `anchor reset` (accept) or restore from backup |
| Registry corruption | Rebuild from the on-disk subvolume tree, snapshot directories and xattrs. Transaction records are rebuilt from journals; anything else becomes `Unknown` |
| Provenance ring buffer overflow | Counted in a metric. Affected files get no xattr; `why` returns `not-found` |
| Backup disk token MAC mismatch | Device released unmounted; warning naming the disk; backup of that target marked failed |
| `cri` does not reconnect after a restart | `emptyDir` volumes deleted 10 minutes after `cri`'s first connection if not re-attached; `local` volumes kept (§4.14) |
| Crash or power loss during a guest session | The guest home's key existed only in memory; the leftover `GuestHome` subvolume is deleted at start (REQ-STRATA-091) |
| Anchor objects missing after a TPM clear | `unanchored`; `anchor reset` re-defines the counter through `hearth`; a missing HMAC key needs recovery-environment re-provisioning (§4.8) |

---

## 8. Performance budgets

| Operation | Budget (NVMe SSD, 8 cores) |
|---|---|
| `begin` with one target | p50 ≤ 30 ms, p99 ≤ 150 ms (snapshot + overlay mount) |
| Copy-up of a 20 GiB file on first write | ≤ 50 ms (reflink) |
| `changes()` for 10,000 changed files | ≤ 1 s |
| `conflicts()` for 10,000 changed files | ≤ 2 s (lease tests are O(changed files)) |
| Incremental commit of 1,000 files | ≤ 2 s |
| Atomic commit of any size | ≤ 200 ms (excluding conflict checks) |
| Scheduled snapshot of an unchanged subvolume | ≤ 1 ms (skipped by transid) |
| Snapshot of a changed subvolume | ≤ 20 ms |
| Provenance (kernel path) per create | ≤ 2 µs added |
| Provenance (fallback) per create | ≤ 10 µs added in-kernel; userspace join p99 ≤ 1 s |
| unitfs sequential read | ≥ 40 % of native |
| `strata` RSS at idle | ≤ 40 MiB |
| `strata-unitfs` RSS per unit | ≤ 16 MiB |

---

## 9. Observability

### 9.1 Logs

Structured journal records (protocols §10.6), with these fields as applicable: `txn`, `subvol`, `snap`, `unit`, `target`, `level`.

### 9.2 Receipts emitted

`strata` holds the `ledger` facet `writer`. Core events are those registered for `strata` in protocols §19.3 (Appendix A.18). Repository-specific events use the `x-strata.` prefix under the protocols extension rule and carry no semantics for other components.

| Event | When | `data` |
|---|---|---|
| `txn.begin` | begin | `{txn, targets, networkPolicy, origin}` |
| `txn.commit` | commit | `{txn, prepared, preparedDigest, mode, added, modified, deleted, renamed, meta, preCommitSnapshots, mandate?}` |
| `txn.abort` | abort, TTL, `forget` or a cancelled workflow (`workflow-cancelled`) | `{txn, reason}` |
| `txn.undo` | undo | `{txn, guardSnapshot, forced}` |
| `snapshot.create` | each snapshot, or a batch per scheduler tick | `{ids, subvols, reason, set?}` |
| `snapshot.delete` | prune or delete | `{ids, reason}` |
| `unit.create` | unit creation | `{unit, mode, backend}` |
| `unit.forget` | forget | `{unit, mode, subvolumesDeleted, snapshotsAffected, backupsMarked, approval}` |
| `backup.run` | backup run | `{target, set, result, bytesAdded, durationMs}` |
| `backup.restore-test` | restore test | `{target, sampleFiles, result}` |
| `anchor.rollback-detected` | startup verify | `{stored, nv, fsGenNow}` |
| `x-strata.replica.send` | replica run | `{peer, subvols, bytes}` |
| `x-strata.qgroups-disabled` | qgroups found enabled and disabled at startup (REQ-STRATA-011) | `{fs}` |
| `x-strata.anchor.reset` | `strata anchor reset` after a presence approval | `{previousState, approval}` |
| `x-strata.volume.create` | pod volume created | `{podId, name, kind, sizeBytes}` |
| `x-strata.volume.release` | pod volume deleted | `{podId, name, kind, reason}` |
| `x-strata.backup-disk.init` | keylos backup disk formatted | `{name, device, luksUuid, approval}` |
| `x-strata.txn.prepare` | prepared merge created | `{txn, prepared, digest, added, modified, deleted, renamed, meta, merged}` |
| `x-strata.txn.stale` | commit refused for changed live state | `{txn, prepared, paths}` |
| `x-strata.txn.bind` | transaction bound to a workflow (REQ-STRATA-100) | `{txn, workflow, attempt, epoch}` |
| `x-strata.txn.rollback` | interrupted commit rolled back, prepared merge `Ready` again (REQ-STRATA-104) | `{txn, prepared, reason}` |
| `x-strata.quarantine`, `x-strata.quarantine-release` | quarantine set / released or rolled back (REQ-STRATA-098) | `{units, snapshot, safeStart, rollback?}` |

`unit.create` and `unit.forget` for guest homes carry `mode: "ephemeral"`. Receipts whose subject has a human (unit and transaction events of humans) are sealed by `ledger` (protocols §13.4); `strata` submits them in clear form like any writer.

### 9.3 Metrics (OpenMetrics, exposed through `journal`)

| Metric | Type |
|---|---|
| `strata_free_bytes`, `strata_space_level` | gauge |
| `strata_snapshots_total{class}` | gauge |
| `strata_snapshot_create_seconds` | histogram |
| `strata_txn_open` | gauge |
| `strata_txn_commit_seconds{mode}` | histogram |
| `strata_txn_conflicts_total{reason}` | counter |
| `strata_prov_records_total{path="kernel\|fallback"}` | counter |
| `strata_prov_unjoined_total` | counter |
| `strata_prov_ringbuf_drops_total` | counter |
| `strata_unitfs_ops_total{op}` | counter |
| `strata_backup_last_success_timestamp{target}` | gauge |
| `strata_backup_restore_test_age_seconds{target}` | gauge |
| `strata_anchor_state` | gauge (0 = ok, 1 = unanchored, 2 = rollback, 3 = tampered) |

---

## 10. Configuration

`config` renders `/etc/strata/strata.toml` from the Nickel module `strata` (schema shipped in this repo as `config/strata.ncl`; installed in the OS generation at `/usr/share/keylos/config/schemas/strata.ncl`):

```nickel
{
  strata | {
    concurrency | Number | default = 4,
    retention | {
      user | { hourly | Number | default = 24, daily | Number | default = 14,
               weekly | Number | default = 8, monthly | Number | default = 12 },
      system | { daily | Number | default = 7, weekly | Number | default = 4 },
      txn | { count | Number | default = 50, maxAgeDays | Number | default = 30 },
      update | Number | default = 3,
    },
    schedule | {
      hourlyMinute | Number | default = 0,
      dailyAt | String | default = "03:00",
      backupAt | String | default = "03:30",
    },
    pressure | {
      lowPercent | Number | default = 15, lowGiB | Number | default = 30,
      criticalPercent | Number | default = 5, criticalGiB | Number | default = 8,
    },
    transactions | {
      ttl | String | default = "7d",
      upperBudgetGiB | Number | default = 20,
      defaultNetwork | [| 'deny, 'gate |] | default = 'deny,   # 'inherit is never a default (§4.5.4)
    },
    units | {
      sealedApps | Array String | default = [],      # generation names whose app data units are sealed;
                                                      # the distribution profile fills in its messaging, mail,
                                                      # browser, password-manager, health and finance apps
      sealHomes | Bool | default = false,
      autoMigrate | [| 'idle, 'never, 'now |] | default = 'idle,
      lockOnSuspend | Bool | default = true,
    },
    provenance | { enabled | Bool | default = true, fallbackMaxRate | Number | default = 10000 },
    backup | {
      targets | { _ : {
        uri | String,
        class | [| 'standard, 'sealed_only |] | default = 'standard,
        device | String | optional,         # local targets: device id (protocols §3.5) granted by policy
        schedule | String | default = "daily",
        allowSecret | Bool | default = false,
        keep | { daily | Number | default = 7, weekly | Number | default = 5,
                 monthly | Number | default = 12, yearly | Number | default = 3 },
      } } | default = {},
      restoreTestDays | Number | default = 30,
      skipOnBattery | Bool | default = true,
      skipOnMetered | Bool | default = true,
    },
    replicas | { _ : { peer | String, subvolumes | Array String | default = ["home"] } } | default = {},
    volumes | {
      usageScanSecs | Number | default = 30,
      snapshotLocal | Bool | default = false,      # give local PersistentVolumes the system snapshot class
    },
  }
}

`/etc/keylos/strata/snapshot-exclude.list` (protocols §10.7) is rendered by the same module: newline-separated absolute paths that `strata` never snapshots, replicates or backs up, in addition to its built-in exclusions. The default content is `/keystore`; `vault` refuses to run if that line is missing.
```

Changes to `strata` config take effect on `reload`: the scheduler and retention are re-read, and running transactions are unaffected.

---

## 11. Testing and acceptance criteria

### 11.1 Unit tests

- Change detection over synthetic overlay upper layers: whiteouts, opaque dirs, redirects, metacopy-off copy-ups.
- fsmerge/2 manifest JCS and digest stability (golden vectors in `tests/vectors/fsmerge2/`, checked against the protocols `fsmerge/` vectors).
- Prepared-record immutability: every mutation path after `prepare` is rejected; a second `prepare` yields a new ID and digest.
- Three-way merge cases (clean, conflicting, CRLF, missing trailing newline).
- Retention algorithm over simulated clocks: every class boundary, DST transitions, leap days.
- unitfs format: encrypt/decrypt round-trips, tamper detection (bit flips in header, block, tag, block reordering, truncation), long names, SIV determinism.
- Anchor verify table: every row in §4.8.

### 11.2 Integration tests (QEMU/KVM on kernels 6.18 LTS and current stable, run by `bench` CI images)

| ID | Scenario | Pass condition |
|---|---|---|
| IT-01 | `begin` on a project dir; write, delete and rename inside the view; the live tree is unchanged; `commit` | Live tree equals the expected tree; pre-commit snapshot equals the old tree |
| IT-02 | Concurrent live edit of the same text file on non-overlapping lines before `prepare` | Clean merge in the prepared object, visible in its manifest and diff; committed |
| IT-03 | Concurrent live edit on overlapping lines | `both-changed` conflict with markers in `diff` |
| IT-04 | A file open for write by an outside process during commit | `open-elsewhere` conflict; commit refused |
| IT-05 | An active SQLite WAL database changed inside the transaction | `sqlite-active`; refused |
| IT-06 | Power cut (QEMU `system_reset`) at 50 random points during a 5,000-file incremental commit | After reboot the tree equals either the pre-commit or the post-commit tree, never a mixture |
| IT-07 | `undo` after commit; then `undo` after a further live edit | First succeeds; second gives `kl:conflict` |
| IT-08 | Agent-origin commit (facet `aide`): `Transaction.commit`; `commitWithMandate`; `PreparedMerge.commit` with a mandate for a different digest; with a reused approval ID; with a correct mandate | `kl:needs-approval`, `kl:unsupported`, `kl:denied`, `kl:revoked`, ok |
| IT-09 | Sealed unit on a KL1 kernel without btrfs fscrypt: write, snapshot, backup, `forget` | After forget: snapshot and backup contents can't be decrypted with any key held on the system (the test asserts that `vault` returns not-found and the files are random-looking) |
| IT-10 | Same as IT-09 with `btrfs-fscrypt` (patched test kernel) and `unit migrate` | Migration preserves content; old snapshots are still readable before forget |
| IT-11 | Restore an older LUKS image (`dd`) of the root volume after anchors advanced | `rollback-detected` at boot |
| IT-12 | Provenance: 100,000 creates by 10 principals, fallback mode | ≥ 99.9 % attributed correctly; p99 latency ≤ 1 s |
| IT-13 | Space pressure: fill the disk to 4 % free | Pruning follows P1–P6; pinned snapshots survive; `begin` refused |
| IT-14 | Backup to a local restic repo; restore with upstream `restic` 0.18 | Byte-identical restore |
| IT-15 | Replica with a crafted send stream containing `../` paths | Receive aborts; nothing written outside the root |
| IT-16 | `special-file` and setuid in upper | Refused / stripped |
| IT-17 | `kish try` spawns a command with `SpawnSpec.transaction`; the command writes to the live path | The write lands in the overlay; `KEYLOS_TXN` is set; the live tree is unchanged until commit |
| IT-18 | `begin` with `NetworkPolicy.inherit` from an app principal; from a `shell` principal | `kl:denied`; ok |
| IT-19 | `begin` on a dirfd from a read-only grant mount (`/grants/<name>`, `readOnly = true`) | `kl:denied` |
| IT-20 | `forget` from the CLI with the presence approval declined; approved | `kl:denied`, unit intact; unit shredded, receipt carries the approval ID |
| IT-21 | TPM cleared between boots | `strata status` reports `unanchored`; `anchor reset` requires presence, re-defines NV `0x01300107` through `HearthTpm.defineSpace` and re-creates `0x81000110` through `HearthTpm.recreateKey`; the next anchor update succeeds |
| IT-22 | `StrataVolumes.create` for an `emptyDir` with a 1 GiB limit; a pod writes 1.5 GiB, then 2.5 GiB | `usage` reports `over`; at 2 × the limit the volume becomes read-only; `release` deletes it |
| IT-23 | `cri` restarts and re-attaches one of two pods' volumes | The re-attached `emptyDir` survives; the other is deleted after 10 minutes; `local` volumes survive |
| IT-24 | Guest home: create, write, log out; repeat with a power cut during the guest session | Home and backing store deleted at logout; after the power cut the leftover is deleted at start; no key for it exists in `vault` |
| IT-25 | Plug in a USB stick with an ext4 filesystem; a stick with a forged `keylos-backup` token; a genuine keylos backup disk | No host mount of the first two (`/proc/*/mountinfo`); the forged one is released with a warning; the genuine one is mounted only in `strata`'s namespace during the backup |
| IT-26 | `gate` calls `undo` on a shell-committed transaction; on an `fs.merge`-committed transaction | `kl:denied`; undone |
| IT-27 | `warden` asked to spawn with `SpawnSpec.transaction` for a transaction owned by another session | `TransactionExt.owner()` differs; `warden` refuses; the views are never mounted |
| IT-28 | `forget` requested by a non-owner human on a family machine | The prompt reaches an owner with `requester` set; the request's subject is `strata`'s session; idempotent retry returns the same approval |
| IT-29 | `PreparedMerge.commit` with a mandate re-signed by `service/broker`; with a presence mandate from an owner enrolled after boot; with a mandate signed only by the atrium approver key; after the broker key rotates | Accepted; accepted; `kl:integrity`; accepted after one `serviceKey` refresh |
| IT-30 | Restart `strata-provd` while 3 sessions are running and a 4th is spawned during the downtime | After replay, all 4 cgroups are in the map; files created by the 4th during the downtime are rewritten from `pending` to the full record; `why` attributes them |
| IT-31 | `StrataVolumes.create` for a pod | Volume root owned by UID `0x0FFF0000`, mode `0755`; a container sees it through an idmapped mount as its own UID; no process on the host runs as `0x0FFF0000` |
| IT-32 | Agent transaction prepared and approved; then a non-overlapping live edit of a changed text file; commit | `kl:conflict` (stale), nothing applied; the approved result is never auto-merged with the live edit; a new `prepare` gives a new digest and the old mandate is refused |
| IT-33 | Agent writes into its view after `prepare`; commit with the mandate for the prepared digest | Committed content equals the prepared manifest; the late write is absent from the live tree |
| IT-34 | An outside writer races the revalidate/apply interval (writes in a tight loop, holds a writable mmap) | The writer is frozen by the fence for the interval (its writes land before revalidation → stale, or after `applied`), never inside it; a tier-0 writer with write access → `kl:conflict` `writer-unfenceable` |
| IT-35 | Kill `strata` after 50 % of the ops of a fenced commit; kill `warden`'s fence (timeout) during apply | Rollback to pre-commit state, `crash-rollback` / `fence-lost`; no principal stays frozen; the mandate's approval ID is still unused but only valid for that prepared merge |
| IT-36 | Replay the same mandate after a successful commit; present it after `strata` restart for the still-`Ready` prepared merge | `kl:revoked`; accepted once (journal had no op done) |
| IT-37 | Sealed agent workspace on a kernel without btrfs fscrypt: `kish try` and an agent `fs.merge` on a unitfs view | Both succeed; `/snapshots/.txn` and `/snapshots/.prepared` contain only unitfs-format ciphertext (scanner finds no plaintext name or content of a marker file) |
| IT-38 | Encrypted undo of IT-37's merge; power cut at 20 points during a unitfs commit | Undo restores content from the ciphertext pre-commit snapshot; after each power cut the tree is the pre- or post-commit state |
| IT-39 | Open handles: an app holds a file open in the live unit during a unitfs commit; lock and unlock the human; restart `strata` | The handle keeps old content until reopened; views `ENOTCONN` while locked, `prepare`/`commit` `kl:unavailable`; the transaction resumes after unlock and restart |
| IT-40 | `forget` of a unit with one open and one committed unitfs transaction | Open transaction aborted (`forget`), prepared merges discarded; no key held on the system decrypts any `.txn`, `.prepared` or pre-commit snapshot artifact |
| IT-41 | `begin` on targets mixing btrfs and unitfs, two units, or a nested unit | `kl:unsupported` |
| IT-42 | `strata quarantine` an app, start it, write to its data; safe start with untrusted apps; `rollback` | Writes fail `EROFS`; apps start with read-only units; rollback restores the snapshot and keeps the current content in an `UndoGuard` snapshot |
| IT-43 | `bindWorkflow` with the current binding; again with the same; with a binding of another workflow; with a stale epoch; on a `user`-facet transaction | ok; ok (idempotent); `kl:conflict`; `kl:conflict`; `kl:denied` |
| IT-44 | Fresh attempt: prepare under attempt A1 (epoch 3), stop the VM and `strata`, broker double claims epoch 4 (A2); `preparedFor(pm, A2)`; `preparedFor(pm, A1)`; `prepared(pm)` by the owning service (ancestry) | `PreparedMerge` returned; `kl:not-found`; a capability whose `status` works and whose `commit` and `discard` fail `kl:not-found` |
| IT-45 | Commit through A2 with a mandate carrying `constraints.workflow = W`; repeat the commit; `status()` | Applied once, one `txn.commit`; the repeat returns the same snapshot without applying; `status` = `committed` with transaction and undo snapshot |
| IT-46 | Kill `strata` after 50 % of the ops of a workflow commit; restart; commit again with the same mandate; with a live edit made in between | Rolled back, `x-strata.txn.rollback`, `status` = `prepared`; committed once; with the edit `kl:conflict` (stale) |
| IT-47 | Mandate without `constraints.workflow`, or naming another workflow, for a bound transaction | `kl:denied`, nothing applied |
| IT-48 | Broker double reports the workflow `cancelled`, then `forgotten` | Open bound transaction aborted (`workflow-cancelled`), `Ready` prepared merge discarded; after `forgotten` the prepared store is gone and the record holds only id, digest and state; a committed transaction of the same workflow is untouched |
| IT-49 | Bound transaction left uncommitted beyond the 7-day TTL with a 30-day workflow horizon (test clock); completion record 31 days after the horizon | Not aborted before the horizon; the record is still present until horizon + 30 days, then pruned |

### 11.3 Fuzzing (cargo-fuzz, continuous)

- `fuzz_unitfs_block`: decrypt arbitrary backing files.
- `fuzz_send_stream`: the receive parser.
- `fuzz_prov_cbor`: the provenance xattr decoder.
- `fuzz_fsmerge`: arbitrary upper trees → change list → prepared manifest → digest determinism.
- `fuzz_capwire_strata`: arbitrary capwire datagrams, via the `keylos-capwire` harness.

### 11.4 Conformance

`strata` MUST pass the protocols conformance suites `ids/`, `dsse/`, `presence/`, `receipts/`, `labels/`, `capwire/`, `fsmerge/`, `tpm/` and `workflow/` (attempt bindings, workflow IDs).

### 11.5 Acceptance criteria for 1.0

All of IT-01 to IT-49 pass on x86-64 and aarch64; all §8 budgets are met on the reference hardware (see `keylos` spec); fuzzers have run 7 CPU-days with no crash; a `restic` interoperability test passes.

---

## 12. Implementation notes

### 12.1 Crates

| Need | Crate |
|---|---|
| Async runtime | `tokio` 1.x |
| Cap'n Proto | `capnp` 0.20, `capnp-rpc` 0.20 (via `keylos-capwire`) |
| Contracts | `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-labels`, `keylos-presence`, `keylos-tpm-registry` 1.0 |
| Registry | `redb` 2.x |
| CBOR | `ciborium` 0.2 |
| btrfs/ioctl and mount API | `rustix` 0.38/1.x (mount API, `openat2`, `renameat2`), plus repo-local ioctl definitions |
| fanotify | `rustix` fanotify support or `nix` 0.29 |
| FUSE | `fuser` 0.14 |
| Crypto | `aes-gcm` 0.10, `aes-siv` 0.7, `aes-kw` 0.2, `hkdf` 0.12, `sha2` 0.10, `hmac` 0.12, `blake3` 1.x |
| TPM | `tss-esapi` 7.x |
| Backup | `rustic_core` (latest 0.x) |
| Merge | `diffy` 0.4 |
| BPF | `libbpf-rs` 0.24, `libbpf-cargo` for the skeleton; the BPF program is C compiled with clang (BPF target); it is not part of the userspace TCB language rule |
| SSH | `russh` 0.4x |
| Time and schedule | `jiff` 0.x |
| Logging | `tracing` + keylos journal layer (`keylos-formats`) |

### 12.2 Repository layout

```
strata/
  Cargo.toml (workspace)
  crates/strata-core/        registry, scheduler, retention, txn engine, anchors, receive parser
  crates/strata-merge/       change detection + three-way merge + prepared merges + fsmerge/2 manifests
  crates/strata-unitfs-format/
  crates/strata-unitfs/      FUSE server binary
  crates/strata-provd/       provenance daemon
  crates/strata-cli/         `strata` CLI
  crates/strata/             service binary (capwire server)
  bpf/provenance.bpf.c       LSM program; built here, installed by pkgs into the OS generation at
                             /usr/lib/keylos/bpf/strata/provenance.o, loaded by warden core
  config/strata.ncl          config schema module
  manifests/                 generation manifests for strata, strata-unitfs, strata-provd
  tests/vectors/  tests/it/  fuzz/
```

### 12.3 Build and packaging

- Built by `forge` from recipe `pkgs/strata`.
- Outputs:
  - service generation `io.keylos.strata` (tier 0, entrypoints `main`, `unitfs`, `provd`);
  - CLI command `strata`, with cmdsig files for every subcommand;
  - the part `io.keylos.strata.bpf` (kind `part`) containing `provenance.o`, which `pkgs` places into the OS generation at `/usr/lib/keylos/bpf/strata/provenance.o` (protocols §9.3: service BPF objects are loaded only from the OS generation).
- `reproducible: true`.

---

## 13. Decisions and alternatives

| Decision | Alternatives considered | Reference |
|---|---|---|
| btrfs on LUKS2 AEAD, no qgroups | ZFS (out-of-tree licence); bcachefs (removed from mainline); qgroups (rescan stalls) | [ADR-0020](../../handbook/11-decisions/adr-0020-btrfs-luks2-aead.md) |
| Overlay transactions with base snapshots as lower | Live tree as lower (sees concurrent changes, breaking diff semantics); a full btrfs snapshot as the working copy (no partial targets, expensive merge) | [ADR-0020](../../handbook/11-decisions/adr-0020-btrfs-luks2-aead.md) |
| Incremental commit by default, atomic subvolume swap only when provably unused | Always atomic (loses writes from processes holding old fds); always incremental (no whole-tree atomicity) | — |
| Crypto-shredding with per-unit keys and a snapshot-excluded keystore | Rewriting snapshots and backups to delete (impossible for replicas, slow, breaks dedup) | [ADR-0032](../../handbook/11-decisions/adr-0032-crypto-shredding.md) |
| unitfs FUSE format until btrfs fscrypt lands, then automatic migration | gocryptfs (Go; outside the Rust TCB rule); per-unit LUKS loop images (CoW-hostile, fixed size); waiting for fscrypt (no shredding in 1.0) | [ADR-0032](../../handbook/11-decisions/adr-0032-crypto-shredding.md) |
| Creation-time provenance only | Whole-system provenance (CamFlow/SPADE: 13–55 % overhead, > 90 % log loss) | [ADR-0033](../../handbook/11-decisions/adr-0033-creation-time-provenance.md) |
| Restic-format backups via rustic | Borg (2.0 still beta, different format); kopia (Go); a custom format (no ecosystem restore tools) | — |
| Anchors with a TPM NV counter | Full Merkle tree over user data (prohibitive cost); no detection | [ADR-0014](../../handbook/11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md) |
| Receipts for every state transition | Logs only (not tamper-evident) | [ADR-0031](../../handbook/11-decisions/adr-0031-receipts-ledger.md) |
| Removable media never mounted on the host; keylos backup disks as the only exception | Host automount (filesystem parsers in the host kernel) | [ADR-0052](../../handbook/11-decisions/adr-0052-usb-authorization-and-media-bench.md) |
| Pod volumes as plain subvolumes with scan-based limits | qgroups (rescan stalls, ADR-0020); loop-mounted images (fixed size, double caching) | [ADR-0047](../../handbook/11-decisions/adr-0047-cri-microvm-pods.md) |
| Guest homes keyed only in memory | Ordinary homes deleted at logout (data recoverable from snapshots and free space) | [ADR-0032](../../handbook/11-decisions/adr-0032-crypto-shredding.md) |
| Immutable prepared merge, then approval, then fenced commit of exactly the stored operations (protocols E30, ISSUES ISS-003) | Merging at commit after approval (committed content could differ from approved content); revalidation without writer exclusion (writers race the apply) | — |
| Writer exclusion by freezing writers through `warden` (`fenceWriters`), refusing unfenceable targets | Leases or hash checks only (do not stop a writer between check and apply); kernel-level write barrier (none exists for arbitrary trees) | — |
| unitfs transactions over ciphertext clones with a transaction-specific plaintext view (protocols E34, ISS-007) | Dropping the btrfs check (plaintext upper/undo files in `/snapshots`); refusing transactions on sealed units (agent workspaces default to sealed) | [ADR-0032](../../handbook/11-decisions/adr-0032-crypto-shredding.md) |
| Quarantine of app data units after reboot when state is suspect (protocols E35, ISS-008) | Claiming reboot heals data (hostile data persists) | — |

### 13.1 Notes on cross-repository contracts

- **N1.** The `service/broker` key comes from `Ledger.serviceKey` and owner-presence keys from `HearthSystem.owners` (protocols §14.4); `strata` reads no boot trust set keys for mandates.
- **N2.** After a TPM clear, both anchor objects are re-created through `HearthTpm.defineSpace` and `HearthTpm.recreateKey` with presence (protocols §7.5.3); no recovery-environment provisioning is needed.
- **N3.** Pod volume roots are owned on disk by the reserved `_cluster` UID `0x0FFF0000` (protocols §10.3, REQ-STRATA-084).
- **N4.** Prepared merges, `keylos.fsmerge/2`, `PreparedMerge`, `pm-` IDs and the superseded `commitWithMandate` are protocols E30; the writer fence is `PrincipalControl.fenceWriters` (protocols §7.5.1, E30).
- **N5.** The storage-backend dispatch and unitfs transactions are protocols E34 (§7.3.10); mixed, nested and cross-unit transactions stay unsupported in 1.0.
- **N7.** Workflow-owned transactions, `bindWorkflow`, `preparedFor` and `PreparedMerge.status` are protocols E48; the durable-execution contract and the `transactional` strategy of `fs.merge` are protocols §20.25 and §20.26 (E39, E42). An interrupted commit now returns its prepared merge to `Ready` (REQ-STRATA-104), so the `transactional` retry of the same effect ID can succeed with the same mandate.
- **N6.** Safe start and quarantine implement the recovery side of protocols E35 (§9): reboot restores code and configuration, not the trustworthiness of writable state.

---

## Appendix A — Embedded contracts (verbatim)

### A.1 protocols §2 — Platform baseline

> Verbatim copy of `protocols/spec.md` lines 47–106 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

## 2. Platform baseline

| Item | Requirement |
|---|---|
| Architectures | x86-64 (x86-64-v2 minimum) and aarch64 (ARMv8.2+). Both are tier-1. |
| Firmware | UEFI 2.7+ with Secure Boot capable of custom keys, and TPM 2.0 (firmware or discrete, rev ≥ 1.38, which `PolicyAuthorizeNV` requires). Machines without a TPM can only run the `degraded` integrity profile. |
| Kernel | Linux ≥ 6.18 (LTS floor). The shipped kernel targets the current stable series (7.x). Features are detected at runtime; see §2.1. |
| Socket buffers | `net.core.wmem_max` and `net.core.rmem_max` ≥ 4 259 840 (4 MiB + 64 KiB), so capwire datagrams of 4 MiB fit (§7.1). |
| Kernel lockdown | `lockdown=integrity` at minimum. Consequently **hibernation is unsupported** on every profile (lockdown refuses it). Suspend-to-RAM is supported. |
| Virtualization | KVM required for workbench and tier-2 VMs. Without KVM, those workloads refuse to run; they never silently downgrade. |
| IOMMU | Required on every profile except `degraded`. Kernel command line `iommu=force` plus `intel_iommu=on` or `amd_iommu=force_isolation`; Thunderbolt/USB4 security level `secure` or `user`. Without an active IOMMU, external PCIe/Thunderbolt devices are never authorized (§9.5). On the `cloud` profile, a virtio-only instance type without an emulated IOMMU is accepted and recorded as `"iommu": "none-virtual"` in the boot report (§20.1): such instances expose no external DMA-capable bus, and VFIO passthrough and external device authorization are unavailable on them. |
| Implementation language | Rust (edition 2024, MSRV published per release) for every trusted-computing-base component. New C code MUST NOT be added to the TCB. Reused C components MUST run confined (tier 0 with a dedicated policy). |

### 2.1 Kernel feature levels

Components MUST probe for features and MUST pick behaviour by **feature level**, not by kernel version string.

| Level | Required kernel features | Typical kernel |
|---|---|---|
| `KL1` | Landlock ABI ≥ 7, BPF LSM (`lsm=` includes `bpf`), IPE, fs-verity, overlayfs `verity=require`, pidfd (`CLONE_PIDFD`, `pidfd_getfd`, `SO_PEERPIDFD`), `openat2`, new mount API, `MOVE_MOUNT_BENEATH`, idmapped mounts, `AT_EXECVE_CHECK`, `memfd_secret`, `mseal`, cgroup v2 (`cgroup.freeze`, `cgroup.kill`) | 6.18 |
| `KL2` | KL1 + Landlock ABI ≥ 9 (`FS_RESOLVE_UNIX`, `RESTRICT_SELF_TSYNC`) | 7.1 |
| `KL3` | KL2 + Landlock ABI ≥ 10 (UDP rules) | 7.2 |

On KL1 and KL2 there are no Landlock rules for pathname unix sockets or UDP. Components MUST compensate: the sandbox gets a private network namespace with only `lo`, and egress goes through `gate`; the mount view gives no access to pathname sockets. That compensation MUST be recorded in the process's confinement report (§9.4).

The LSM order on the kernel command line is `lsm=landlock,lockdown,yama,ipe,bpf`.

### 2.2 Profiles and integrity profiles

A machine runs exactly one **profile** (chosen at install, recorded in the first-boot bundle and the boot report) and has exactly one **integrity profile** (derived at every boot, shown in status, in the boot report and in the `vouch` verdict).

| Profile | Use | Notes |
|---|---|---|
| `desktop`, `laptop` | Interactive machines | atrium, portals, presence by touch |
| `server` | Headless | No atrium; presence by **quorum** (§5.4); serial-console recovery with the recovery key |
| `server-k8s` | Kubernetes node | `server` + `cri`, `kubelet`, `kube-proxy` (§21) |
| `cloud` | VM image in a public or private cloud | vTPM (provider EK chains in the attestation trust store); confidential VMs (SEV-SNP, TDX) supported, SVSM vTPM preferred; first-boot bundle from the metadata service (§20.13); quorum presence |
| `kiosk` | Single-app appliance | Autologin to one app principal; atrium kiosk mode; trusted path still present for owners |
| `appliance` | Fixed-function device | As `server`, without `bench` |

| Integrity profile | Condition |
|---|---|
| `full` | Owner-controlled Secure Boot keys (no Microsoft CAs in db), TPM 2.0, IOMMU, every check passes |
| `shared-boot` | `secureboot.keepMicrosoftCAs = true` (dual boot): the Microsoft Windows and third-party UEFI CAs are in db. Bitpixie-class downgrade risk is mitigated by TPM+PIN, the signed PCR11 policy and the NV release floor, and is documented |
| `shim` | Booted through shim + MOK (no custom-key Secure Boot available) |
| `cloud-vtpm` | `cloud` profile with a provider vTPM and no confidential-VM report |
| `cvm` | `cloud` profile in a confidential VM whose report is verified together with the TPM quote |
| `degraded` | No TPM, or Secure Boot off; no sealing, no VBU, persistent warning |

### 2.3 Resource classes

`bench` admission control and memory tuning follow the machine's **RAM class** (detected at boot, overridable in config):

| RAM | Class | Max concurrent VMs (workbench, agent, tier-2, media, pod) | Defaults |
|---|---|---|---|
| < 12 GiB | `small` | 2 | zram swap (ephemeral key), KSM on, compressed snapshots, agents queue |
| 12–24 GiB | `medium` | 6 | KSM on, free-page reporting |
| > 24 GiB | `large` | 16 | free-page reporting |

`server-k8s` nodes are exempt from the VM cap for pod VMs; kubelet `maxPods` bounds them instead. When the cap is reached, new agent sessions queue (`aide`), and other VM requests fail with `kl:unavailable`.


### A.2 protocols §3.2, §3.4, §3.5 — Identifiers

> Verbatim copy of `protocols/spec.md` lines 126–142, 152–182, 184–214 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 3.2 Typed references

```
ref         = kind ":" digest
kind        = "obj" / "gen" / "src" / "drv" / "rcpt" / "key"
```

| Kind | Meaning | Digest algo |
|---|---|---|
| `obj` | A store object (a regular file in the store) | `fsv256` |
| `gen` | A generation: an EROFS composefs metadata image | `fsv256` |
| `src` | A source input (git tree or archive) | `sha256` of the **canonical tar stream** defined in §11.2 (for git trees and for archives after normalisation) |
| `drv` | A build derivation (recipe + resolved inputs) | `sha256` of the canonical JSON derivation |
| `rcpt` | A ledger receipt | `sha256` of the DSSE envelope bytes |
| `key` | A public key | `sha256` of the SubjectPublicKeyInfo DER |

Example: `gen:fsv256:3f9a…c01e` (64 hex characters).

### 3.4 Principal identifiers

A principal is the tuple **(actor, human, session chain)**.

```
principal   = actor "@" human "/" session *( "/" session )
actor       = "app:" ref-gen
            / "service:" service-name ":" ref-gen
            / "agent:" ref-gen
            / "legacy:" ref-gen
            / "bench:" ref-gen
            / "pod:" pod-ns "/" pod-name ":" ref-gen-or-image
            / "shell"
            / "kernel"
human       = username / "_system" / "_cluster"
ref-gen-or-image = ref-gen / "oci:sha256:" 64HEXDIGLC   ; sealed container generation, or OCI image digest (keylos-vm pods)
session     = "s-" ULID          ; Crockford base32, 26 characters
ref-gen     = "gen:fsv256:" 64HEXDIGLC
```

Examples:
- `shell@alice/s-01JB6Q8Z0RXQ4M3W9V2N7T5K1C`
- `agent:gen:fsv256:9e1f…@alice/s-01JB6Q…/s-01JB6R…` (a sub-agent: the last session is the child)
- `service:vault:gen:fsv256:77aa…@_system/s-01JB5…`

Rules:
- The **session chain** records delegation. A child principal's chain is its parent's chain plus one new session. Its authority MUST be a subset of its parent's (§8).
- The **canonical key** for maps and log indexes is the full text form.
- Within a kernel, a running principal instance maps 1:1 to a **(UID, cgroup)** pair allocated by `warden` (§10.3). The mapping is published through `Supervisor.identify` (§7.3.2).
- A VM principal (tier 2 or 3) maps to the cgroup of its VMM process; processes inside the guest are not separate host principals.
- **Pod principals** (§21) always have human `_cluster`. A `keylos-vm` pod is one VM principal per pod sandbox whose actor names the pod's first container image; a `keylos-sealed` pod has one principal per container. The session chain starts at the `cri` service session.

### 3.5 Other identifiers

| Identifier | Form |
|---|---|
| Session | `s-` + ULID, created by the spawner. ULIDs are unique and monotonic in time; only the canonical uppercase text form is valid. |
| Token root ID | 16 random bytes; text form `t-` + the 26-character **uppercase Crockford base32** encoding of the 128-bit big-endian value (the ULID codec; first character `0`–`7`). |
| Grant record ID | `g-` + ULID (persistent grant records, broker) |
| Effect intent ID | `e-` + ULID |
| Transaction ID | `x-` + ULID |
| Approval ID | `a-` + ULID. Minted by `broker` for the approvals it runs, and by `hearth` for the mandates of its own presence-confirmed effects (`x-hearth.*` kinds, never sent to `broker`) |
| Snapshot ID | `snap-` + ULID |
| Plan ID (config) | `p-` + ULID |
| Seal window ID | `w-` + ULID |
| Prepared merge ID | `pm-` + ULID (strata, §7.5.7, §20.12) |
| Quorum request ID | `q-` + ULID |
| Debug grant ID | `dbg-` + ULID |
| Pod sandbox ID (cri) | `pod-` + ULID (the Kubernetes pod UID is kept as metadata) |
| Media session ID (bench) | `med-` + ULID |
| Family inbox item ID (hearth) | `fi-` + ULID (a non-owner request waiting for an owner; never an approval ID, which is `a-…` and broker-issued) |
| Fleet command ID | `fc-` + ULID (§20.23) |
| Workflow ID | `wf-` + ULID. The persistent identity of one enrolled workflow (§20.25); minted by `loom`, never reused |
| Run ID | `wr-` + ULID. One run of a workflow (a fresh run after a migration, §20.27) |
| Step ID | `ws-` + the 26-character ULID of the run ID + `.` + state name (`[a-z][a-z0-9-]{0,31}`) + `.` + occurrence (decimal, no leading zeros, `0` for the first entry of that state in the run), e.g. `ws-01JB6Q8Z0RXQ4M3W9V2N7T5K1C.test.2`. Deterministic: the same run, state and occurrence always give the same step ID |
| Attempt ID | `wa-` + ULID. One execution attempt of a step; fresh for every claim, mapped to fresh runtime sessions |
| Effect ID | `fx-` + 26 uppercase Crockford base32 characters of the first 16 bytes of SHA-256(`"keylos-effect/1"` ‖ `0x00` ‖ step ID text ‖ `0x00` ‖ effect name) (the `t-` codec; first character `0`–`7`). Deterministic: every attempt of a step derives the same ID for the same named effect (§20.25) |
| Ownership epoch | `oe-` + decimal (≥ 1, no leading zeros) in documents; `UInt64` on the wire. Advanced by one at every claim of a workflow (§20.25) |
| Decision ID | `dr-` + ULID. A durable logical approval request and its decision (broker, §20.25); distinct from the boot-local prompt ID `a-…` |
| Budget account ID | `ba-` + ULID. A workflow-lifetime budget account held by `gate` (§20.25) |
| Catalog entry ID | reverse-DNS generation name (§3.3) |
| Device ID | `dev:` + subsystem + `:` + stable path, e.g. `dev:video4linux:pci-0000:00:14.0-usb-0:5:1.0` |
| Machine identity key | `key:sha256:…` of the machine's ledger signing key (the "machine key") |


### A.3 protocols §5.1, §5.3 — Signed documents and presence signatures

> Verbatim copy of `protocols/spec.md` lines 252–269, 291–317 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 5.1 Envelope

Every signed keylos document is a **DSSE envelope** (Dead Simple Signing Envelope v1.0):

```json
{"payloadType": "<media type>", "payload": "<base64>", "signatures": [{"keyid": "key:sha256:…", "sig": "<base64>", "alg": "ed25519"}]}
```

Rules:
- `alg` is a keylos extension field inside each signature object. DSSE verifiers that ignore unknown fields stay compatible.
- **Payloads** are JSON canonicalized with RFC 8785 (JCS), UTF-8 encoded.
- Media types have the form `application/vnd.keylos.<doc>+json; version=<major>`. The registry is §19.4.
- Signers MUST sign the DSSE PAE encoding. Verifiers MUST recompute the JCS form of the decoded payload and reject if it differs from the payload bytes. That rule forbids non-canonical payloads.
- Every `application/vnd.keylos.*` payload has a `schema` field of the form `keylos.<doc>/<major>` matching its media type (in-toto statements, §11.4, carry none).
- Base64 is the standard alphabet with canonical padding; non-canonical encodings are rejected.
- **Envelope bytes.** Wherever this document hashes "the envelope" (`rcpt:` refs, owner-registry `prev`, `windowDigest`, `mandateDigest`), the bytes are the **JCS** of `{"payloadType","payload","signatures":[{"keyid","alg","sig", …}]}`; stored envelopes (e.g. `owners.log` lines) MUST be in that form.
- **Unknown algorithms.** A signature with an unknown `alg` never counts; an envelope verifies when enough known-algorithm signatures by distinct keys verify (§4).
- Unknown members of every keylos document (any nesting level) are rejected unless prefixed `x-`.

### 5.3 Presence signatures

A FIDO2 authenticator cannot sign arbitrary bytes: it signs `authenticatorData ‖ clientDataHash`. A presence signature over a DSSE payload is constructed as follows:

```
pae := DSSE-PAE(payloadType, payload)
cdh := SHA-256(pae)
assertion := CTAP2 authenticatorGetAssertion(rpId = "keylos.owner", clientDataHash = cdh,
                                              allowList = enrolled credentials, options = {up: true, uv: per purpose})
sigObj := {"keyid": "key:sha256:<SPKI of credential>", "alg": "fido2-es256" | "fido2-eddsa",
           "sig": base64(CBOR{1: authenticatorData, 2: signature, 3: credentialId})}
```

Verification (crate `keylos-presence`; every verifier MUST use it or an equivalent conforming implementation):
1. Check the payload is JCS-canonical and its `schema` matches the expected purpose (§20.2).
2. Decode the CBOR map. Check `authenticatorData.rpIdHash == SHA-256("keylos.owner")`.
3. Check the UP flag is set, and the UV flag when the purpose requires it.
4. Look up the credential by `keyid` in the **owner registry** (§20.3) state current at the payload's `time`. The credential MUST NOT have been removed before that time.
5. Verify `signature` over `authenticatorData ‖ cdh` with the credential's COSE key.

Stateful verifiers (`hearth`) SHOULD track `signCount`. Stateless verifiers (`boot`) skip it.

Login assertions (screen unlock, greeter) use the separate rpId `keylos.login` and are never accepted as presence signatures; presence always uses `keylos.owner`.

The FIDO2 `hmac-secret` extension is used only by `hearth` for the seal gate (§11.6). Its outputs never leave `hearth`.

**Accepted authenticators.** Any FIDO2 authenticator with user verification counts, roaming or platform. `hearth` includes a TPM-backed platform authenticator for owners who cannot operate a roaming key: user presence is a confirmation on the trusted path (a pointer, keyboard or switch-access action inside the atrium-drawn prompt), user verification is the owner's PIN entered there. Such a credential is enrolled with `"assisted": true` in its owner-registry entry (§20.3); `status`, the `vouch` verdict and every presence prompt show it. The platform authenticator's TPM signing key and its `hmac-secret` key are created under the SRK `0x81000001` with `userWithAuth` **clear** and authPolicy `PolicyPCR(sha256:{15}) ∧ PolicyAuthValue`, whose authValue `hearth` derives from the owner's PIN; PCR15 alone never authorizes a signature. Their blob `/var/lib/keylos/hearth/platform/<keyid>.blob` (§10.7) is the JCS object `{"rpId", "credentialId", "cose", "salt", "key", "hmacKey"}`, binary members in standard base64, `key` and `hmacKey` each `TPM2B_PRIVATE ‖ TPM2B_PUBLIC`. Policy MAY forbid assisted credentials for specific purposes (`config.presence.assistedAllowed`, default: allowed for every purpose).


### A.4 protocols §7.1, §7.2 — capwire model, routes and facets

> Verbatim copy of `protocols/spec.md` lines 503–527, 529–541 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 7.1 Model

All keylos IPC between principals on one kernel uses **Cap'n Proto RPC (rpc.capnp, level 1 plus promise pipelining)** over **AF_UNIX `SOCK_SEQPACKET`** sockets.

- **There is no system bus.** A process can reach only the capabilities it was handed:
  - the bootstrap capability of each socket `warden` passed to it at spawn (listed in `KEYLOS_CAPWIRE_FDS`, §10.5),
  - capabilities returned by calls on those.
- **The one exception is the CRI boundary** (§21): the upstream `kubelet` speaks the Kubernetes CRI v1 gRPC API to `cri` over an `AF_UNIX` `SOCK_STREAM` socket that `warden` creates and passes to `kubelet` (route `cri#kubelet`). No other non-capwire IPC between keylos principals is allowed.
- **Holding is authority.** A capability or an fd received through capwire is itself the authority to use it. capwire has **no call-attached tokens**: methods that need token-based authority take an explicit `C.Token` parameter; otherwise the route facet or the held capability is the authority.
- **Framing:** one Cap'n Proto message (standard segment-table framing) per datagram.
  - Maximum datagram size: 4 MiB.
  - Larger data MUST use a `ByteStream`/`ByteSource` capability or a passed fd.
- **File descriptors** travel as `SCM_RIGHTS` ancillary data on the same datagram, at most 64 per datagram. Inside the message, an fd is referenced by an `Fd` struct whose `index` is its position in that datagram's fd array.
  - **No fd** is written as `index = 0xFFFF`, which is the struct default; a null `Fd` pointer also means "no fd". Senders SHOULD write `Fd` structs explicitly. A method that requires an fd fails with `kl:invalid` when it gets none.
  - An `Fd.index` that is out of range, or that a receiver resolves a second time, fails **that call** (or that result's processing) with `kl:invalid`; the connection stays up. The transport is schema-unaware, so an index is checked when the receiver resolves the field.
  - Every received fd that no field took is closed when the receiver releases the message (call parameters released, or the response dropped).
  - Fds can be attached to any parameter or result struct of a message built on a capwire connection, including structs with pointer fields only; a caller does not need to resolve a bootstrap promise before sending fds on it.
  - `ENOBUFS` and `ENOMEM` from `sendmsg` are transient: the sender retries with backoff for up to 1 s before it fails the connection.
- **Datagram rules** (violations are protocol errors that fail the **whole connection**, reported to the local side as `kl:invalid`): exactly one standard-framed message per datagram with no trailing bytes; size ≤ 4 MiB; ≤ 64 fds; ancillary data not truncated (`MSG_TRUNC`/`MSG_CTRUNC`); fds never on capwire-vsock. Senders MUST NOT send zero-length datagrams; a receiver reads a zero-byte datagram as end of connection. A sender whose own outgoing message would exceed 4 MiB fails the connection rather than leave the peer waiting.
- **Socket buffers.** `warden` (and any component that creates capwire sockets for others) sets `SO_SNDBUFFORCE` and `SO_RCVBUFFORCE` to at least 4 MiB + 64 KiB (4 259 840 bytes) on both ends of every capwire socketpair it creates, so 4 MiB datagrams fit; distributions set `net.core.wmem_max` and `net.core.rmem_max` ≥ 4 259 840 (§2). capwire-vsock endpoints set `SO_VM_SOCKETS_BUFFER_SIZE`/`_MAX_SIZE` to the same value.
- **Peer identity:**
  - Every capwire connection between principals is a `socketpair` created by `warden` (§7.2). For such sockets the kernel records the **creating** process (`warden`) as the peer of both ends, so `SO_PEERPIDFD` and `SO_PEERCRED` name `warden`, not the peer. Servers MUST take the peer's principal, tier, generation and facet **only** from `ServiceHost.accept` (§7.5.1), or from `Supervisor.connectionInfo` for a connection ID `warden` delivered.
  - `SO_PEERPIDFD` + `Supervisor.identify` MAY be used only for sockets the peer itself `connect()`ed to a listening socket (not used between keylos principals in 1.0; reserved for diagnostics and future listeners).
  - Servers MUST NOT use PIDs, executable paths, or claims inside messages to decide who the caller is.
- **Bootstrap:** the socket's bootstrap capability implements the service's root interface **and** `common.Extensible` (§7.3.1). It is already narrowed by `warden` to the route's facet (§7.2).

### 7.2 Routes and facets

`warden` wires services according to **routes** declared in service and app manifests plus policy.

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

- A **facet** is a server-defined restriction name. The registry of every facet, its holders and the methods it allows is §19.2. Servers MUST refuse methods their facet doesn't allow with `kl:denied`.
- Route references are written `service#facet` (for example `vault#app`).
- The server learns the facet of each connection from `ServiceHost.accept` (§7.5.1) or `Supervisor.connectionInfo`.
- Service sockets live under `/run/keylos/svc/<service>/` with mode `0700`, owned by `warden`'s UID. No other principal can `connect()` to them. Connections are created by `warden` (`socketpair` + hand-off through `ServiceHost.accept`).
- Dynamic routes (a service capability granted at runtime) are materialised by `broker` through `ServiceConnect.connectService` (§7.5.1).


### A.5 protocols §7.3.1 — common.capnp and error codes

> Verbatim copy of `protocols/spec.md` lines 555–636 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.1 `common.capnp`

```capnp
@0xc7a1e5d3b2f40001;

struct Digest {
  algo  @0 :Algo;
  bytes @1 :Data;            #! sha256/fsv256: 32 bytes; sha512: 64 bytes
  enum Algo { sha256 @0; sha512 @1; fsv256 @2; }
}

struct Ref {                 # typed reference, protocols §3.2
  kind   @0 :Kind;
  digest @1 :Digest;
  enum Kind { obj @0; gen @1; src @2; drv @3; rcpt @4; key @5; }
}

struct Fd { index @0 :UInt16 = 0xFFFF; }   #! index into the SCM_RIGHTS array of the carrying datagram; 0xFFFF (the default) and a null pointer mean "no fd"

struct Timestamp { unixNanos @0 :Int64; }

struct PrincipalId { text @0 :Text; }   #! canonical text form, protocols §3.4
struct SessionId   { text @0 :Text; }

struct Label {
  conf  @0 :Conf;
  integ @1 :Integ;
  enum Conf  { public @0; internal @1; private @2; secret @3; }
  enum Integ { trusted @0; user @1; untrusted @2; }
}

struct Token { biscuit @0 :Data; }      #! Biscuit v3 serialized token, protocols §8

struct KeyValue { key @0 :Text; value @1 :Text; }

struct AttemptBinding {          #! one execution attempt of a durable workflow (§20.25); epoch 0 (the default) = not an attempt
  workflow @0 :Text;             # wf-…
  attempt  @1 :Text;             # wa-…
  epoch    @2 :UInt64;           # ownership epoch of the claim (BrokerWorkflow.claim, §7.5.25)
  step     @3 :Text;             # ws-… the attempt executes
  owner    @4 :Text;             # the workflow's owning human; warden uses it as the attempt principal's human
}

interface ByteStream {
  write @0 (bytes :Data) -> stream;
  done  @1 ();
}

interface ByteSource {
  read @0 (maxBytes :UInt32) -> (bytes :Data, eof :Bool);
}

interface Cancelable { cancel @0 (); }

interface Watcher(T) {          # server-push subscription
  event @0 (event :T) -> stream;
}

interface Extensible {          #! implemented by every bootstrap capability
  ext     @0 (interfaceId :UInt64) -> (cap :Capability);   #! kl:denied if the facet does not allow that interface, or the server does not implement it
  version @1 () -> (protocols :Text, implementation :Text);   #! protocols: SemVer of this document ("1.0.0"); implementation: "<repo>/<SemVer>"
}
```

**Errors.** Methods signal failure with a Cap'n Proto exception of type `failed`. The exception `reason` string MUST start with `kl:<code>`, optionally followed by `:<ref>` (non-empty), then optionally a space and a human-readable message. Codes outside the table are a parse error. Root interfaces are not declared `extends(C.Extensible)`; clients obtain the `Extensible` view of a bootstrap capability by casting the same capability.

| Code | Meaning |
|---|---|
| `denied` | Policy refused. Not retryable without new authority. |
| `needs-approval` | `:<ref>` is an approval ID (`a-…`). Retry after the approval resolves, or use the returned `Approval`. |
| `not-found` | |
| `invalid` | Malformed request |
| `conflict` | State changed concurrently |
| `expired` | |
| `revoked` | |
| `budget` | Budget exhausted |
| `integrity` | Verification failure: signature, digest, fs-verity |
| `unavailable` | Transient; MAY retry with backoff |
| `unsupported` | Feature level or platform lacks support |
| `internal` | |

Example: `kl:needs-approval:a-01JB6R… Sending email requires approval`.


### A.6 protocols §7.3.10 — strata.capnp (implemented)

> Verbatim copy of `protocols/spec.md` lines 1099–1144 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.10 `strata.capnp`

```capnp
@0xc7a1e5d3b2f40010;
using C = import "common.capnp";

enum NetworkPolicy { deny @0; gate @1; inherit @2; }
  #! deny: processes in the transaction get no network; gate: egress only via gate with the caller's tokens; inherit: the spawner's own policy

struct Change { path @0 :Text; kind @1 :Kind; enum Kind { added @0; modified @1; deleted @2; renamed @3; meta @4; } from @2 :Text; }

struct Conflict { path @0 :Text; reason @1 :Text; }

interface Transaction {
  id      @0 () -> (id :Text);
  view    @1 () -> (dirs :List(C.Fd));         # O_PATH dirfds of the overlay views (same order as begin)
  changes @2 () -> (changes :List(Change));
  diff    @3 (path :Text) -> (diff :C.Fd);
  conflicts @4 () -> (conflicts :List(Conflict));
  commit  @5 () -> (snapshot :Text);           # returns pre-commit snapshot id (undo point)
  abort   @6 () -> ();
}

struct Provenance {
  principal   @0 :C.PrincipalId;
  generation  @1 :C.Ref;
  transaction @2 :Text;
  created     @3 :C.Timestamp;
  label       @4 :C.Label;
}

struct SnapshotInfo { id @0 :Text; subvolume @1 :Text; created @2 :C.Timestamp; reason @3 :Text; pinned @4 :Bool; }

interface Strata {
  begin     @0 (dirs :List(C.Fd), networkPolicy :NetworkPolicy) -> (txn :Transaction);   #! holding the dirfds is the authority
  snapshot  @1 (subvolume :Text, reason :Text) -> (info :SnapshotInfo);
  snapshots @2 (subvolume :Text) -> (list :List(SnapshotInfo));
  restore   @3 (snapshot :Text, path :Text, target :C.Fd) -> ();
  undo      @4 (transaction :Text) -> ();
  why       @5 (file :C.Fd) -> (provenance :Provenance);
  forget    @6 (unit :Text) -> ();             # crypto-shred a data unit
  createUnit @7 (path :C.Fd, unit :Text, policy :Text) -> ();
}
```

**Transaction storage backends.** `begin` dispatches each target dirfd to a registered backend. A plain btrfs directory uses the snapshot and overlay path. A plaintext view of a sealed unit served over FUSE (`keylos.unitfs/1`) is resolved through `strata`'s own mount records to (unit, relative subtree); `strata` clones the unit's ciphertext backing subvolume (a read-only base and a writable working clone) and serves a transaction-specific plaintext view of that subtree only. Changes and prepared merges are computed on the logical plaintext views; commit applies the logical operations to the live backing through the unit format, after quiescing the unit and fencing its writers. No plaintext upper layer, undo copy or journal content of a sealed unit is ever stored outside its encrypted backing; undo uses a ciphertext pre-commit snapshot, and `forget` of the unit aborts its transactions and leaves every transaction artifact undecryptable. While the unit is locked its transaction views are unavailable and commits fail `kl:unavailable`. Mixed backends in one transaction, nested units and cross-unit transactions fail `kl:unsupported`.


### A.7 protocols §7.5.7 — strata-sys.capnp (implemented)

> Verbatim copy of `protocols/spec.md` lines 1986–2072 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.5.7 `strata-sys.capnp`

```capnp
@0xc7a1e5d3b2f40026;
using C = import "common.capnp";
using S = import "strata.capnp";

enum Choice { ours @0; theirs @1; merged @2; }

interface TransactionExt {
  policy            @0 () -> (networkPolicy :S.NetworkPolicy, views :List(Text));   # view paths for warden mounting
  resolve           @1 (path :Text, choice :Choice, merged :C.Fd) -> ();
  changeSet         @2 () -> (jcs :C.Fd, digest :C.Digest);                         # keylos.changeset/1
  commitWithMandate @3 (mandate :Data) -> (snapshot :Text);                         #! superseded before release by prepare + PreparedMerge.commit: MUST return kl:unsupported
  pin               @4 (pinned :Bool) -> ();
  owner             @5 () -> (session :C.SessionId);                                # session that began the transaction
  prepare           @6 () -> (prepared :PreparedMerge);
      #! freezes the views, captures the live state of every affected path, applies recorded resolutions and clean three-way
      #! merges, and stores the result as an immutable prepared merge (§20.12 keylos.fsmerge/2); kl:conflict while conflicts remain
  bindWorkflow      @7 (binding :C.AttemptBinding) -> ();
      #! facets bench, aide: the transaction (and every prepared merge of it) is owned by binding.workflow from now on (§20.25);
      #! strata verifies the binding for the transaction's owner session with BrokerWorkflow.verify; idempotent; kl:conflict if
      #! the transaction is already bound to another workflow
}

interface PreparedMerge {
  id       @0 () -> (id :Text);                                  # pm-… (§3.5)
  manifest @1 () -> (jcs :C.Fd, digest :C.Digest);               # keylos.fsmerge/2; digest = the fs.merge payload digest
  diff     @2 (path :Text) -> (diff :C.Fd);                      # unified diff of the stored result ("" = whole merge)
  commit   @3 (mandate :Data) -> (snapshot :Text);
      #! verifies the mandate binds digest, takes a writer fence (PrincipalControl.fenceWriters), revalidates every expectedLive
      #! entry and applies exactly the stored operations (no new merge, no overlay read); stale live state → kl:conflict
  discard  @4 () -> ();
  status   @5 () -> (state :Text, transaction :Text, snapshot :Text);
      #! durable completion record: state "prepared" | "committed" | "discarded" | "stale"; for "committed" the commit's
      #! transaction id and pre-commit (undo) snapshot. Retained at least until the owning workflow's horizon (§20.25)
}

interface StrataTxn {              # facets user, bench, aide, cli, warden
  txnExt @0 (id :Text) -> (txn :S.Transaction, ext :TransactionExt);
      #! user/bench/aide/cli: only transactions begun by the caller (or its session ancestors).
      #! warden: any; warden MUST check that the spawner's session equals owner() or descends from it before mounting views
  prepared @1 (id :Text) -> (prepared :PreparedMerge);
      #! user/bench/aide/cli: prepared merges of the caller's own transactions (same ownership rule as txnExt); not on facet warden
  preparedFor @2 (id :Text, binding :C.AttemptBinding) -> (prepared :PreparedMerge);
      #! facets bench, aide: a prepared merge of a transaction bound to binding.workflow (bindWorkflow), for a fresh attempt of that
      #! workflow that does not descend from the session that prepared it; strata verifies the binding is current
      #! (BrokerWorkflow.verify); a stale or foreign binding: kl:not-found
}

struct UnitInfo { id @0 :Text; alias @1 :Text; mode @2 :Text; subvolumes @3 :List(Text); mounted @4 :Bool; backend @5 :Text; }
struct SubvolInfo { uuid @0 :Text; path @1 :Text; kind @2 :Text; human @3 :Text; owner @4 :Text; unit @5 :Text; snapshotClass @6 :Text; backupClass @7 :Text; }
struct BackupStatus { target @0 :Text; lastRun @1 :C.Timestamp; lastResult @2 :Text; lastRestoreTest @3 :C.Timestamp; nextRun @4 :C.Timestamp; }

interface StrataAdmin {            # facet admin; mountUnit also on facet warden; lockUnits/unlockUnits also on facet hearth; preUpdate also on facet courier
  subvolumes      @0 (human :Text) -> (list :List(SubvolInfo));
  createSubvolume @1 (parent :C.Fd, name :Text, kind :Text, owner :Text) -> (info :SubvolInfo);
  deleteSubvolume @2 (uuid :Text) -> ();
  units           @3 () -> (list :List(UnitInfo));
  mountUnit       @4 (unit :Text) -> (view :C.Fd);       # detached mount fd of the plaintext view
  lockUnits       @5 (human :Text) -> ();
  unlockUnits     @6 (human :Text) -> ();
  pin             @7 (snapshot :Text, pinned :Bool) -> ();
  deleteSnapshot  @8 (snapshot :Text) -> ();
  backupNow       @9 (target :Text) -> (run :Text);
  backups         @10 () -> (list :List(BackupStatus));
  status          @11 () -> (json :Text);
  preUpdate       @12 (reason :Text) -> (set :Text);      # snapshot set before an OS update
}

interface StrataHomes {            # facet hearth
  createHome @0 (user :Text, uid :UInt32) -> (info :SubvolInfo);
  deleteHome @1 (user :Text, forget :Bool) -> ();
  createEphemeralHome @2 (user :Text, uid :UInt32) -> (info :SubvolInfo);   # guest sessions: not snapshotted, ephemeral unit key
}

interface StrataVolumes {          # facet cri
  create  @0 (podId :Text, name :Text, kind :Text, sizeBytes :UInt64) -> (dir :C.Fd);
      #! kind "emptyDir" (subvolume, deleted with the pod) | "local" (local PersistentVolume, kept until release);
      #! dir is an O_PATH fd; sizeBytes is enforced without qgroups: strata scans usage every 30 s and reports
      #! over-limit volumes in usage(), and cri evicts the pod (Kubernetes ephemeral-storage semantics)
  release @1 (podId :Text, name :Text) -> ();
  usage   @2 (podId :Text) -> (json :Text);
}
```

On facet `gate`, strata serves `Strata.undo` only, for transactions that were committed by an `fs.merge` intent whose compensation `gate` executes (§14.2).


### A.8 protocols §7.3.2 — warden.capnp (consumed)

> Verbatim copy of `protocols/spec.md` lines 638–722 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.2 `warden.capnp`

```capnp
@0xc7a1e5d3b2f40002;
using C = import "common.capnp";

enum Tier { t0 @0; t1 @1; t2 @2; t3 @3; legacy @4; }

struct FdMapping { target @0 :Int32; fd @1 :C.Fd; }

struct Limits {
  cpuWeight  @0 :UInt16 = 100;    # cgroup cpu.weight
  memoryMax  @1 :UInt64;          # bytes, 0 = inherit
  pidsMax    @2 :UInt32;          # 0 = inherit
  ioWeight   @3 :UInt16 = 100;
  wallSecs   @4 :UInt32;          # 0 = unlimited
}

struct SpawnSpec {
  generation  @0 :C.Ref;          #! kind gen; MUST be launchable (sealed, not revoked)
  entrypoint  @1 :Text;           # manifest entrypoint key, default "main"
  argv        @2 :List(Text);     # appended to entrypoint args
  env         @3 :List(C.KeyValue);  #! secrets MUST NOT be passed via env; warden rejects names matching policy secret patterns and reserved KEYLOS_* names;
                                     #! for actorKind pod the secret-pattern check is skipped (the admitted Kubernetes env may carry secrets, §21)
  fds         @4 :List(FdMapping);   # explicit fds; nothing else is inherited
  grants      @5 :List(C.Token);     # tokens attached to the new principal
  cwd         @6 :C.Fd;              # O_PATH dirfd; optional
  limits      @7 :Limits;
  terminal    @8 :C.Fd;              # pty secondary; optional; warden calls setsid+TIOCSCTTY
  session     @9 :C.SessionId;       # new child session id; warden generates if empty
  actorKind   @10 :ActorKind;
  transaction @11 :Text;             # optional strata transaction id (x-…); warden mounts the transaction views over the granted dirs
  enum ActorKind { app @0; service @1; agent @2; legacy @3; bench @4; shell @5; pod @6; }
  attempt     @12 :C.AttemptBinding; #! workflow attempt (§20.25): honoured only from service loom (facet service); warden forwards it
                                     #! unchanged in SessionReg.attempt and never interprets it; set by any other caller: kl:denied
}

struct ExitStatus {
  union {
    exited   @0 :Int32;
    signaled @1 :Int32;
    failedToStart @2 :Text;   # kl:<code> reason
  }
  cpuNanos @3 :UInt64;
  maxRss   @4 :UInt64;
}

interface Process {
  pidfd     @0 () -> (fd :C.Fd);             # kl:unsupported for VM processes
  principal @1 () -> (id :C.PrincipalId);
  wait      @2 () -> (status :ExitStatus);
  signal    @3 (signo :Int32) -> ();         #! delivered to every process of the principal's cgroup
  kill      @4 () -> ();                     # cgroup.kill
  confinement @5 () -> (report :Text);       # JSON confinement report, protocols §9.4
  freeze    @6 () -> ();                     # cgroup.freeze = 1
  thaw      @7 () -> ();                     # cgroup.freeze = 0
}

struct ConnectionInfo {
  peer   @0 :C.PrincipalId;
  facet  @1 :Text;
  tier   @2 :Tier;
  label  @3 :C.Label;          # current session label (from broker)
  generation @4 :C.Ref;
}

interface Supervisor {
  spawn          @0 (spec :SpawnSpec) -> (process :Process);   #! the child's session chain extends the caller's
  identify       @1 (pidfd :C.Fd) -> (id :C.PrincipalId, tier :Tier, generation :C.Ref);
  connectionInfo @2 (connectionId :UInt64) -> (info :ConnectionInfo);
  services       @3 () -> (list :List(ServiceStatus));
  control        @4 (service :Text, op :ServiceOp) -> (status :ServiceStatus);
      #! service "_system" is the pseudo-target for system power: ops poweroff/reboot (facet admin only)
  enum ServiceOp { start @0; stop @1; restart @2; reload @3; poweroff @4; reboot @5; }
}

struct ServiceStatus {
  name       @0 :Text;
  state      @1 :State;
  generation @2 :C.Ref;
  since      @3 :C.Timestamp;
  restarts   @4 :UInt32;
  enum State { inactive @0; starting @1; running @2; stopping @3; failed @4; }
}
```


### A.9 protocols §7.5.1 — warden-sys.capnp (consumed; ServiceHost implemented)

> Verbatim copy of `protocols/spec.md` lines 1573–1744 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.5.1 `warden-sys.capnp`

```capnp
@0xc7a1e5d3b2f40020;
using C = import "common.capnp";
using W = import "warden.capnp";
using B = import "broker.capnp";

interface Bootstrap {                  #! bootstrap of fd 3 in every tier-0 service (connection to warden)
  host     @0 (host :ServiceHost) -> ();   # the service registers its ServiceHost; MUST be called first
  ready    @1 () -> ();                    # readiness signal
  watchdog @2 () -> ();                    # liveness ping (interval from the service manifest)
  status   @3 (text :Text) -> ();          # human-readable status line
}

interface ServiceHost {                #! implemented by every tier-0 service; warden is the only caller
  accept @0 (socket :C.Fd, connectionId :UInt64, facet :Text, peer :C.PrincipalId, tier :W.Tier, generation :C.Ref) -> ();
  stop   @1 (reason :Text) -> ();          # cooperative stop before SIGTERM
  reload @2 () -> ();                      # the config generation changed; warden has rebuilt the service's /etc view
}

interface GrantMounts {                # facets broker, bench, compat, portals, cri (idmappedDir only)
  attachGrant @0 (session :C.SessionId, name :Text, tree :C.Fd, readOnly :Bool, ceiling :C.Label) -> (inView :C.Fd, viewPath :Text);
      #! bind-mounts tree (non-recursive, idmapped to the holder's dynamic UID) at /grants/<name> in the holder's mount namespace;
      #! inView = O_PATH fd of the mount root opened through the holder's namespace;
      #! ceiling = the grant's exposure label (§14.1): objects labelled above it are never readable through the mount;
      #! a null ceiling means no enforcement (the caller MUST then have raised the holder to secret/untrusted)
  detachGrant @1 (session :C.SessionId, name :Text) -> ();
  idmappedDir @2 (dir :C.Fd, forPrincipal :C.PrincipalId, readOnly :Bool) -> (tree :C.Fd);
      #! detached idmapped clone (open_tree + mount_setattr MOUNT_ATTR_IDMAP); used by bench/compat for shares
}

enum TerminateMode { kill @0; freeze @1; thaw @2; }

struct PrincipalEvent {
  session   @0 :C.SessionId;
  principal @1 :C.PrincipalId;
  time      @2 :C.Timestamp;
  union {
    spawned @3 :W.Tier;
    exited  @4 :W.ExitStatus;
    frozen  @5 :Void;
    thawed  @6 :Void;
  }
  cgroupId  @7 :UInt64;          # kernel cgroup id of the principal's scope (stable for the session's lifetime)
}

interface PrincipalControl {           # facets broker, admin, hearth (terminate own humans' sessions), strata (events, mountView), cri (pod sessions)
  terminate @0 (session :C.SessionId, mode :TerminateMode) -> ();   #! applies to the session and all descendant sessions
  list      @1 (humanFilter :Text) -> (sessions :List(C.PrincipalId));
  events    @2 (watcher :C.Watcher(PrincipalEvent), replay :Bool) -> (cancel :C.Cancelable);
      #! replay = true: first emits one `spawned` event for every currently running session (visible to the facet), then live events
  mountView @3 (session :C.SessionId) -> (json :Text);               # JCS: [{target, source, flags, grant}]
  fenceWriters @4 (tree :C.Fd, exclude :List(C.SessionId)) -> (fence :WriterFence);
      #! facet strata: freezes every session (except exclude and their descendants) whose view can write inside tree,
      #! and returns once they are frozen; kl:conflict if a writer cannot be frozen (tier-0 service other than strata,
      #! kernel or network filesystem writer); released by WriterFence.release, when the capability is dropped, or after 30 s
}

interface WriterFence {
  sessions @0 () -> (list :List(C.SessionId));   # the frozen sessions
  release  @1 () -> ();                         # thaws them
}

interface ServiceConnect {             # facet broker
  connectService @0 (session :C.SessionId, service :Text, facet :Text) -> (socket :C.Fd);
      #! creates a route for an existing principal; returns the principal-side capwire socket
}

interface FdStore {                    # facet service (each service sees only its own keys)
  store @0 (key :Text, fd :C.Fd) -> ();    #! survives the service's restarts within one boot
  fetch @1 (key :Text) -> (fd :C.Fd);
  drop  @2 (key :Text) -> ();
}

struct LegacyGrant { tree @0 :C.Fd; target @1 :Text; readOnly @2 :Bool; }

struct LegacyView {
  image    @0 :C.Ref;                  # legacy-image generation
  stateDir @1 :C.Fd;                   # per-image writable state (overlay upper + work)
  grants   @2 :List(LegacyGrant);
  netMode  @3 :Text;                   # "none" | "pasta"
}

interface LegacySpawn {                # facet compat
  spawnLegacy @0 (spec :W.SpawnSpec, view :LegacyView, brokerSession :C.SessionId) -> (process :W.Process, notifyFd :C.Fd);
      #! user namespace with a 65 536-UID block, child user.max_user_namespaces=0;
      #! notifyFd = seccomp user-notification listener for the open broker (protocols §9.2);
      #! brokerSession = the per-app open-broker session that gets the read pairing to this app (§9.3)
}

interface UserSpawn {                  # facets launcher (atrium launcher), handler (portal-openuri, portal-notify, portal-background)
  spawnForHuman @0 (spec :W.SpawnSpec, human :Text, initialLabel :C.Label) -> (process :W.Process);
      #! new top-level session under the human's current shell session; label starts at max(default, initialLabel)
}

interface TrustedSpawn {               # facet trusted-terminal (atrium-term only)
  spawnTerminal @0 (spec :W.SpawnSpec, pty :C.Fd) -> (process :W.Process);
      #! actorKind MUST be shell; warden withholds SECBIT_EXEC_DENY_INTERACTIVE for exactly this process tree (§9.3)
}

interface DebugAttach {                # facet broker (materialises Right.debug, §9.3)
  attach @0 (target :Text, scope :Text, debugger :C.Ref, entrypoint :Text, argv :List(Text),
             pty :C.Fd, expiresSecs :UInt32, grantId :Text, requester :C.PrincipalId) -> (process :W.Process);
      #! target "session:s-…" | "gen:fsv256:…"; scope "process" | "kernel"; expiresSecs ≤ 3600 (process), ≤ 900 (kernel);
      #! debugger MUST be a launchable generation whose manifest name is in the policy list debug.debuggers;
      #! warden spawns it as a child of requester's shell session (the human the grant was minted to) with seccomp profile
      #! debug-1 and the ambient capabilities of §9.3, writes kl_debug_pairs, and on expiry or exit removes the pair,
      #! kills the debugger and writes debug.detach
}

struct PodMount {
  tree       @0 :C.Fd;
  target     @1 :Text;
  readOnly   @2 :Bool;
  tmpfsBytes @3 :UInt64;   # 0: bind tree at target; > 0: warden creates a tmpfs of that size at target and copies tree into it
                           #  (configMap, secret, projected and downwardAPI volumes, §21.6)
}

struct PodContext {
  podId        @0 :Text;               # pod-… (§3.5)
  namespace    @1 :Text;
  name         @2 :Text;
  uid          @3 :Text;               # Kubernetes pod UID (metadata)
  netns        @4 :C.Fd;               # pod network namespace created by cri inside the cri network
  sharePid     @5 :Bool;               # shareProcessNamespace
  mounts       @6 :List(PodMount);     # volumes, prepared by cri (strata volumes, projected tmpfs)
  cgroupParent @7 :Text;               # under /keylos.slice/kube.slice/
  seccomp      @8 :Text;               # "baseline-1" | "runtime-default" (baseline-1 ∩ the CRI RuntimeDefault profile)
  readOnlyRoot @9 :Bool;
  runAsUid     @10 :UInt32;            # container-visible UID; mapped through a per-pod mapping-only userns held by warden (idmapped rootfs)
}

interface PodSpawn {                   # facet cri (keylos-sealed runtime class only, §21)
  spawnContainer @0 (spec :W.SpawnSpec, pod :PodContext) -> (process :W.Process);
      #! spec.generation MUST be kind container with an org-publisher genstmt; actorKind pod; tier t1;
      #! the container joins pod.netns and (if sharePid) the pod's pid namespace; no added capabilities, ever;
      #! the root is read-only plus tmpfs at /tmp, /run, /var/tmp and /dev/shm (§21.8)
  execInContainer @1 (spec :W.SpawnSpec, container :C.SessionId) -> (process :W.Process);
      #! CRI Exec/ExecSync: a child session of the container's principal that joins its mount, pid, net, ipc and uts
      #! namespaces and its cgroup; spec.generation MUST equal the container's generation; no added capabilities
  egressShim      @2 (podId :Text) -> (shim :Capability);
      #! a gate-sys ShimEndpoint (§7.5.12) bound to the pod's principals, created by warden as for tier L; cri runs the
      #! pod's egress redirector with it when cluster.egressViaGate is set (§21.5)
}

struct VmPrincipal {
  session       @0 :C.SessionId;
  parentSession @1 :C.SessionId;      # session the VM descends from (agent: the aide-created chain; pod: cri's session)
  principalKind @2 :W.SpawnSpec.ActorKind;   # bench, agent, legacy or pod
  image         @3 :C.Ref;            # bench-image generation
  template      @4 :C.Ref;            # agent-template generation for agent VMs, else empty
  tier          @5 :W.Tier;           # t2 or t3
  offered       @6 :List(C.Token);    #! tokens held by parentSession (e.g. the launching human's), to be attenuated for the VM
  purpose       @7 :Text;             # VmSpec.Purpose enumerant name
  podId         @8 :Text;             # purpose pod only
  checks        @9 :List(Text);       #! Datalog checks (§8.3) the broker appends when attenuating `offered` for this VM (sub-agents: aide narrows the parent's grants)
  budgets       @10 :List(B.Budget);  #! hard sub-meters carved from the offered roots (GateMeterAdmin.carve, §7.5.12) for this VM principal
  attempt       @11 :C.AttemptBinding; #! from VmSpec.attempt / ForkSpec.attempt; forwarded unchanged in SessionReg.attempt
}

interface VmSpawn {                    # facet bench
  register   @0 (vm :VmPrincipal) -> (principal :C.PrincipalId, cgroupId :UInt64, tokens :List(C.Token));
      #! creates the VM principal (dynamic UID, cgroup scope, BrokerSystem.registerSession); the actor follows §3.4
      #! (agent: "agent:" + template; pod: "pod:…"; otherwise "<kind>:" + image); tokens are those the broker issued
  spawnVmm   @1 (session :C.SessionId, spec :W.SpawnSpec) -> (process :W.Process);
      #! spawns crosvm, its device processes, bench-net and bench-relay inside the VM principal's cgroup;
      #! spec.generation MUST be the bench generation; warden wires bench-net to gate#shim and bench-relay to
      #! aide#host (agent VMs), broker#principal, vault#app and portal-*#default for that principal
  unregister @2 (session :C.SessionId) -> ();   # after the last VMM process of the principal exited
}
```


### A.10 protocols §7.3.6, §20.10 — vault.capnp and secret delivery (consumed)

> Verbatim copy of `protocols/spec.md` lines 938–967, 4331–4334 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.6 `vault.capnp`

```capnp
@0xc7a1e5d3b2f40006;
using C = import "common.capnp";

struct ItemAcl {
  actors  @0 :List(Text);        # actor patterns, e.g. "app:gen:fsv256:…", "app:name=org.example.Editor"
  ops     @1 :List(Op);
  prompt  @2 :PromptPolicy;
  enum Op { read @0; use @1; update @2; delete @3; }
  enum PromptPolicy { never @0; perSession @1; always @2; presence @3; }
}

struct ItemInfo { name @0 :Text; kind @1 :Text; created @2 :C.Timestamp; acl @3 :ItemAcl; }

interface Vault {
  open    @0 (name :Text, purpose :Text) -> (secret :C.Fd);       #! delivery format §20.10 (memfd_secret, mmap-only, length-prefixed)
  store   @1 (name :Text, kind :Text, value :C.Fd, acl :ItemAcl) -> ();   # value.index 0xFFFF = ACL-only update
  delete  @2 (name :Text) -> ();
  list    @3 () -> (items :List(ItemInfo));
  sign    @4 (name :Text, alg :Text, data :Data) -> (signature :Data);   # key never leaves vault
  sshAgent @5 () -> (socket :C.Fd);                                     # per-principal SSH agent protocol socket
  dataKey @6 (unit :Text) -> (key :C.Fd);                                # crypto-shred unit key (facets strata, ledger, gate, aide, journal, loom; each only for its own unit prefix)
  forget  @7 (unit :Text) -> ();                                         # destroy unit key (same facets)
  inject  @8 (name :Text, target :Text) -> (handle :Data);              # facet gate only: opaque handle for credential injection
}
```

An injection handle is redeemed by `gate` with `open("inject:<hex handle>", purpose)` on facet `gate`.

### 20.10 Secret delivery (`Vault.open`)

- **Primary:** a `memfd_secret(FD_CLOEXEC)` fd of the value's length plus 8, rounded up to the page size, laid out as `u64 little-endian length ‖ value ‖ zero padding`. secretmem fds are readable only through `mmap`; recipients map them `PROT_READ`, read the length, use the bytes, and zeroize and unmap on drop (`keylos-vault-client::SecretBuf`).
- **Fallback** (when `memfd_secret` is unavailable): a `memfd_create(MFD_CLOEXEC|MFD_ALLOW_SEALING|MFD_NOEXEC_SEAL)` fd with the same layout, sealed `F_SEAL_WRITE|F_SEAL_SHRINK|F_SEAL_GROW|F_SEAL_SEAL`. The receipt records `data.delivery = "memfd-sealed"`.


### A.11 protocols §7.3.5 — ledger.capnp (consumed)

> Verbatim copy of `protocols/spec.md` lines 902–936 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.5 `ledger.capnp`

```capnp
@0xc7a1e5d3b2f40005;
using C = import "common.capnp";

struct ReceiptRef { seq @0 :UInt64; digest @1 :C.Digest; }

struct Checkpoint { note @0 :Text; }   #! C2SP signed-note checkpoint text, protocols §13.3

struct Filter {
  principalPrefix @0 :Text;
  sessionId  @1 :Text;
  eventTypes @2 :List(Text);
  since      @3 :C.Timestamp;
  until      @4 :C.Timestamp;
  limit      @5 :UInt32;
  fromSeq    @6 :UInt64;          # 0 = from the start; only receipts with seq ≥ fromSeq (continuation: fromSeq = query's next)
}

interface Ledger {
  append     @0 (envelope :Data) -> (ref :ReceiptRef);     #! facet "writer" only
  get        @1 (seq :UInt64) -> (envelope :Data);
  query      @2 (filter :Filter) -> (envelopes :List(Data), next :UInt64);
  checkpoint @3 () -> (checkpoint :Checkpoint);
  prove      @4 (seq :UInt64, treeSize :UInt64) -> (hashes :List(Data));   # RFC 6962 inclusion proof
  consistency @5 (from :UInt64, to :UInt64) -> (hashes :List(Data));
  watch      @6 (filter :Filter, watcher :C.Watcher(Data)) -> (cancel :C.Cancelable);
  serviceKey @7 (service :Text) -> (spki :Data, keyRef :Text, registered :C.Timestamp);
      #! facet reader: the currently registered key of service/<service> (from ledger.key.register); kl:not-found if none.
      #! Relying services use it to verify service-signed records, e.g. non-presence mandates signed by service/broker (§14.4)
}
```

**Read access** (facet `reader`; `writer` includes it): a principal sees receipts whose `subject` or `writer` is itself or a descendant session; a `shell` principal sees every receipt whose subject's human is its human; agent principals see only their own session chain; tier-0 services see receipts per their facet entry in §19.2, and every writer service sees every receipt whose `writer` actor is its own service name under any session and generation (`service:<name>:…`, also from earlier boots), so it can reconcile its own submissions (§20.25); `fleet` (facet `fleet-export`) sees metadata only, unless an owner exception of kind `fleet-receipt-access` (§20.9) lists the event type. Sealed payloads (§13.4) are decrypted for a reader only if the reader may read the receipt **and** the unit key still exists; receipts of crypto-shredded units are returned redacted (`keylos.receipt-redacted/1`). The returned form of a decrypted sealed receipt is defined in §13.4. `query` returns matching visible receipts in increasing `seq`, at most `limit`; `next` is the `seq` of the first matching visible receipt that was not returned (0 = none), and a client continues with the same filter and `fromSeq = next`. `watch` ignores `fromSeq`. Facet `vouch-heartbeat` (vouchd) sees only the metadata (time, subject human) of `user.login` receipts of every human, for the inheritance dead-man timer (§20.19).


### A.12 protocols §7.3.7 — gate.capnp (consumed)

> Verbatim copy of `protocols/spec.md` lines 969–1021 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.7 `gate.capnp`

```capnp
@0xc7a1e5d3b2f40007;
using C = import "common.capnp";
using B = import "broker.capnp";

enum EffectClass { reversible @0; compensable @1; irreversible @2; }

struct EffectArg { name @0 :Text; value @1 :Text; source @2 :Text; label @3 :C.Label; }

struct EffectIntent {
  kind        @0 :Text;            # registered effect kind, protocols §14.2
  class       @1 :EffectClass;
  target      @2 :Text;            # e.g. "smtp:mail.example.com", "https://api.github.com/repos/o/r/pulls"
  args        @3 :List(EffectArg);
  idempotencyKey @4 :Text;
  compensator @5 :Text;            # registered compensator kind, empty if none
  payload     @6 :C.Fd;            # full request body / message
}

struct IntentStatus {
  id     @0 :Text;
  state  @1 :State;
  result @2 :Text;
  receipt @3 :Text;                # rcpt ref
  enum State { staged @0; approved @1; committed @2; failed @3; canceled @4; compensated @5; }
}

interface Intent {
  status   @0 () -> (status :IntentStatus);
  dryRun   @1 () -> (rendered :List(Text));
  commit   @2 () -> (status :IntentStatus);          # may throw kl:needs-approval
  cancel   @3 () -> ();
  compensate @4 () -> (status :IntentStatus);
}

interface Gate {
  connect   @0 (target :B.NetTarget, token :C.Token) -> (socket :C.Fd);   # proxied, policy-checked stream; target.host "listen:<addr>" returns a listening socket
  stage     @1 (intent :EffectIntent) -> (intent :Intent);
  intents   @2 (session :C.SessionId) -> (list :List(IntentStatus));
      #! facet client: the named session MUST be the caller's own session or a descendant; returns intents of that session
      #! and all its descendant sessions, recursively
  meter     @3 (rootId :Data) -> (spent :List(B.Budget), remaining :List(B.Budget));
  charge    @4 (rootId :Data, amount :B.Budget, reason :Text) -> ();      # facet meter only
  intent    @5 (id :Text) -> (intent :Intent);
      #! facet client: only intents staged by the caller's session or its descendants (kish `effects` commit/cancel)
}
```

**Terminated HTTP mode.** For `https` grants that need method filtering or credential injection, a native client does not get an end-to-end TLS stream: `connect` returns a socket on which the client speaks **plain HTTP/1.1** to `gate`, which terminates the request, applies method checks and credential injection, and performs TLS to the real host itself. Clients detect this from the token's `net` fact (`$method` ≠ `"*"`). Legacy and VM clients use the TLS-interception path instead (§9.4). SDKs MUST support the terminated mode.

**Acting for a subject.** On facet `aide`, `stage` acts for the agent session whose token is carried in the intent arg `x-subject-token` (base64 Biscuit); `gate` stages for that token's `principal` after verifying `right("effect", kind, "stage")`. On facet `broker`, `connect` acts for the token's `principal`. On every other facet the subject is the caller.


### A.13 protocols §7.3.3, §7.5.2 — broker.capnp and broker-sys.capnp (consumed)

> Verbatim copy of `protocols/spec.md` lines 724–835, 1746–1827 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.3 `broker.capnp`

```capnp
@0xc7a1e5d3b2f40003;
using C = import "common.capnp";

struct NetTarget {
  host    @0 :Text;            # DNS name or IP literal; "listen:<addr>" requests a listening socket (§7.3.7)
  port    @1 :UInt16;
  proto   @2 :Proto;
  methods @3 :List(Text);      # HTTP methods, empty = protocol-level grant only
  enum Proto { tcp @0; udp @1; https @2; }
}

struct Budget { unit @0 :Text; amount @1 :Int64; }   # unit: "usd-micro", "tokens", "calls"

struct ResourceRef {
  union {
    path      @0 :Text;          # resolved by broker with openat2(RESOLVE_BENEATH) from a held root
    dirFd     @1 :C.Fd;          # caller already holds it; request attenuation/annotation
    net       @2 :NetTarget;
    device    @3 :Text;          # device id, protocols §3.5
    secret    @4 :Text;          # vault item name (caller-scoped)
    budget    @5 :Budget;
    spawn     @6 :C.Ref;         # right to spawn a generation
    service   @7 :Text;          # "name#facet"
    effect    @8 :Text;          # effect kind, e.g. "email.send"
    delegate  @9 :Void;          # right to create sub-principals
    principal @10 :DebugTarget;  # debug target (Right.debug), §9.3
    screen    @11 :Text;         # "window:<atrium window id>": one still snapshot of a real-session window (Right.read), §14.5
    model     @12 :Text;         # "<provider>/<model>@<version>": re-approval of an agent session's model after drift (Right.use), §14.5
  }
}

struct DebugTarget {
  target  @0 :Text;              # "session:s-…" (a running session and its descendants) or "gen:fsv256:…" (any instance of a generation of the requesting human)
  scope   @1 :Scope;
  enum Scope { process @0; kernel @1; }   #! kernel: bpftrace-class tracing, presence-only, ≤ 900 s
}

enum Right { read @0; write @1; create @2; delete @3; exec @4; connect @5; bind @6; use @7; spend @8; spawn @9; stage @10; commit @11; delegate @12; debug @13; }

struct GrantRequest {
  resource     @0 :ResourceRef;
  rights       @1 :List(Right);
  reason       @2 :Text;         # shown to the human
  durationSecs @3 :UInt32;       # 0 = policy default
  persist      @4 :Bool;         # request a persistent grant (survives session and reboot; needs presence)
  onBehalfOf   @5 :C.PrincipalId; # informational only (vault, depot, strata, atrium via requestFor): the principal the service acts for;
                                  #! shown on the prompt and recorded in receipts; never used for authorization
}

struct GrantOutcome {
  union {
    granted @0 :C.Token;
    pending @1 :Approval;
    denied  @2 :Text;
  }
}

interface Approval {
  id      @0 () -> (id :Text);
  wait    @1 () -> (outcome :GrantOutcome);
  cancel  @2 () -> ();
  mandate @3 () -> (mandate :Data);   #! DSSE keylos.mandate/1 after approval; kl:not-found before or if denied
}

struct Handle {
  union {
    fd      @0 :C.Fd;            # file, dirfd (O_PATH), device, memfd
    socket  @1 :C.Fd;            # connected socket (usually to gate) or capwire socket to a service
    cap     @2 :Capability;      # service capability
  }
}

interface Broker {
  request     @0 (req :GrantRequest) -> (outcome :GrantOutcome);
  materialize @1 (token :C.Token, resource :ResourceRef, rights :List(Right)) -> (handle :Handle);
  attenuate   @2 (token :C.Token, checks :List(Text)) -> (token :C.Token);  #! Datalog checks, protocols §8.3
  delegate    @3 (tokens :List(C.Token), child :C.SessionId, checks :List(Text)) -> (tokens :List(C.Token));
  revoke      @4 (rootId :Data) -> ();
  inspect     @5 (token :C.Token) -> (facts :List(Text), expires :C.Timestamp, rootId :Data);
  label       @6 () -> (label :C.Label);
  raiseLabel  @7 (label :C.Label, reason :Text) -> (label :C.Label);  #! raises the CALLER's session label only; labels only go up
  powerbox    @8 (req :PowerboxRequest) -> (grants :List(PowerboxGrant));
  myGrants    @9 () -> (tokens :List(C.Token));
  debug       @10 (token :C.Token, debugger :C.Ref, entrypoint :Text, argv :List(Text), pty :C.Fd) -> (process :Capability);
      #! materialises a Right.debug grant through warden DebugAttach (§7.5.1); returns a warden.Process
}

struct PowerboxRequest {
  kind     @0 :Kind;
  title    @1 :Text;
  mimeTypes @2 :List(Text);
  multiple @3 :Bool;
  suggestedName @4 :Text;
  enum Kind { openFile @0; openDirectory @1; saveFile @2; }
}

struct PowerboxGrant {
  fd    @0 :C.Fd;        # opened file, or O_PATH dirfd usable in the holder's view (attached via GrantMounts, §7.5.1)
  token @1 :C.Token;     # token describing the grant (for persistence / delegation)
  displayName @2 :Text;
  viewPath @3 :Text;     # path of the grant inside the holder's view (/grants/<name>), for path-expecting code
}
```

**Directory grants and Landlock.** A Landlock domain cannot be widened after `restrict_self`. A directory granted at runtime is therefore made reachable by `warden` attaching a bind mount at `/grants/<name>` inside the holder's mount namespace (`GrantMounts.attachGrant`, §7.5.1), whose subtree is covered by the Landlock rule the view was built with (`/grants` is allowed at spawn with the access rights of the highest possible grant; actual access is bounded by mount flags and the attached tree). `materialize` of a path or dirFd grant returns an fd opened **through that mount**.

**Directory grant ceilings.** Every directory grant has an **exposure label** (its ceiling, §14.1). The broker raises the holder's session label to the ceiling **before** the mount is attached, and passes the ceiling to `attachGrant`; `warden` then refuses, for the grant's lifetime, every open of an object through that mount (and every read through an fd opened through it) whose label exceeds the ceiling or is malformed (§9.3). Grant trees are non-recursive bind mounts: mounts nested below the granted directory are not reachable through the grant.

**Single-file grants.** A file picked for a path-expecting client is never exposed by attaching its parent directory. It is exposed as a **single-file view** `/grants/<name>/<basename>`: a directory served by `portal-files` that contains only the selected file and the holder's own temporary files. Writes follow the granted rights (a read-only grant refuses every write); a safe-save `rename(<temporary> → <basename>)` is carried out by `portal-files` as an atomic replace of the selected file in its real parent, whose dirfd `portal-files` holds and never exposes; every other name is refused. Access to the parent or any sibling needs an explicit `openDirectory` consent. Remembered grants, re-materialization, revocation and drag-and-drop keep the same single-file scope.

#### 7.5.2 `broker-sys.capnp`

```capnp
@0xc7a1e5d3b2f40021;
using C = import "common.capnp";
using B = import "broker.capnp";
using P = import "prompt.capnp";

struct SessionReg {
  child    @0 :C.PrincipalId;
  parent   @1 :C.SessionId;        # empty for warden-originated system services
  offered  @2 :List(C.Token);
  onRevoke @3 :Text;               # "kill" | "freeze"
  budgets  @4 :List(B.Budget);     #! hard sub-budget ceilings for the child (VmPrincipal/ForkSpec budgets): the broker carves each from
                                   #! the matching offered root (GateMeterAdmin.carve) before issuing tokens; kl:budget if a parent meter is short
  attempt  @5 :C.AttemptBinding;   #! workflow attempt (§20.25): verified against the broker's workflow record (claimed epoch, attempt,
                                   #! allowed generation and spawner); the child's label and tokens then come from that record (§7.5.25)
}

struct SessionRegResult {
  tokens    @0 :List(C.Token);
  label     @1 :C.Label;
  tierFloor @2 :UInt8;             # 0..4 = t0..legacy
}

struct FlowCheck {
  session       @0 :C.SessionId;
  kind          @1 :Text;          # effect kind or "net"
  target        @2 :Text;
  payloadDigest @3 :C.Digest;
  rendered      @4 :List(P.RenderedEffect);
  provenance    @5 :List(P.ArgProvenance);
  flowProof     @6 :Data;          # optional DSSE keylos.flowproof/1 (§20.11)
  intent        @7 :Text;          # e-… id of the staged intent; empty for connect-time "net" checks
}

struct GrantResult {
  outcome @0 :B.GrantOutcome;
  mandate @1 :Data;                # DSSE keylos.mandate/1 when the outcome was decided by approval; empty otherwise.
                                   #! presence-signed when presence was required; otherwise signed by service/broker (§14.4)
}

struct PodAdmission {
  allowed   @0 :Bool;
  reasons   @1 :List(Text);        # forbid/permit policy ids and failed checks
  tierFloor @2 :UInt8;             # 1 = keylos-sealed allowed, 2 = keylos-vm required
  approval  @3 :Text;              # a-… when an @tier/@orgApproval permit applies (pods wait for it)
}

interface BrokerSystem {           # facet system
  registerSession    @0 (reg :SessionReg) -> (result :SessionRegResult);           # warden
  sessionEnded       @1 (session :C.SessionId, exitText :Text) -> ();              # warden
  checkFlow          @2 (check :FlowCheck) -> (result :GrantResult);               # gate: Rule of Two at stage/commit/connect
  requestFor         @3 (subject :C.SessionId, req :B.GrantRequest, intent :Text, idempotencyKey :Text,
                          intentSession :C.SessionId, decidedOnTrustedPath :Bool) -> (result :GrantResult);
      #! approval request on behalf of a subject session (intent = e-… id or empty). Allowed subjects per caller:
      #! gate → sessions that staged the intent (intentSession = the staging session when it differs from subject);
      #! aide → its agent sessions; strata, depot, vault, atrium → only their own session (atrium: device authorization).
      #! The broker deduplicates by (caller, idempotencyKey) for 24 h: a repeated call returns the same approval/result.
      #! decidedOnTrustedPath: atrium only (device authorization): the human already decided on atrium's trusted-path card;
      #! the broker evaluates policy, records approval.decide with channel "local" and returns the mandate without
      #! prompting again. MUST be false (else kl:invalid) for every other caller or when policy requires presence.
  registerApprover   @4 (publicKey :Data, alg :Text, channel :Text) -> ();         # atrium ("local") and vouchd ("phone"), once per boot
  registerSessionKey @5 (session :C.SessionId, publicKey :Data) -> ();             # aide: agent session key (flow proofs, commits)
  annotateRequest    @6 (session :C.SessionId, provenanceJson :Text) -> ();        # aide: provenance hints for the next request
  rootsChanged       @7 (fdkeys :List(Text)) -> ();                                # strata: re-open held roots after rollback
  revokeSession      @8 (session :C.SessionId, mode :Text) -> ();                  # hearth (lock/logout), warden
  loadPolicy         @9 (generation :C.Ref) -> ();                                 # config: activate a policy generation
  validatePolicy     @10 (tree :C.Fd) -> (ok :Bool, problems :List(Text));         # config: dry-run a candidate policy tree
  mintCaptive        @11 (session :C.SessionId) -> (token :C.Token);               # net: captive-portal token (§8.2 captive fact)
  admitPod           @12 (podSpecJson :Text, runtimeClass :Text) -> (admission :PodAdmission);
      #! cri: Cedar evaluation of action "admit" on a PodSpec entity (§16, §21.3); podSpecJson is the CRI PodSandboxConfig
      #! plus container configs, normalised by cri to keylos.podspec/1 (§21.3)
}

interface LabelAuthority {         # facet label-authority
  labelOf  @0 (session :C.SessionId) -> (label :C.Label);
  raiseFor @1 (session :C.SessionId, label :C.Label, reason :Text) -> (label :C.Label);   #! labels only go up; receipt label.raise
}
```

`registerApprover.publicKey` is a DER SubjectPublicKeyInfo; other encodings fail `kl:invalid`. A method whose receipt must be written before it replies (§19.3) answers `kl:unavailable` while the serving component's own `ledger.key.register` has not been appended; the broker registers its key before it serves facet `system`.


### A.14 protocols §7.3.4 — prompt.capnp (consumed: notify)

> Verbatim copy of `protocols/spec.md` lines 837–900 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.4 `prompt.capnp` (trusted path; implemented by `atrium`, used by `broker`, `hearth`, `vault`, `config`, `depot`, `fleet`, `vouch`)

```capnp
@0xc7a1e5d3b2f40004;
using C = import "common.capnp";

enum ApprovalTier { t0 @0; t1 @1; t2 @2; t3 @3; }

struct RenderedEffect {
  kind      @0 :Text;            # e.g. "email.send", "fs.merge", "config.apply"
  title     @1 :Text;
  body      @2 :Text;            # plain text or sanitized markdown
  mime      @3 :Text;            # "text/plain" | "text/markdown" | "text/x-diff" | "image/png"
  attachment @4 :C.Fd;           # optional large rendering (diff, preview)
  reversible @5 :Bool;
  review     @6 :Review;          #! required (default): approval is enabled only when this rendering was presented completely (§14.3)
  payloadDigest @7 :C.Digest;     #! digest of the mandate-draft effect this rendering presents (sha256)
  enum Review { required @0; decorative @1; }   #! decorative: optional preview; set only by gate or broker, never by a requester
}

struct ArgProvenance {
  argument @0 :Text;
  source   @1 :Text;             # e.g. "web:https://example.com/page", "file:/home/…", "user"
  label    @2 :C.Label;
}

struct ApprovalPrompt {
  id         @0 :Text;
  tier       @1 :ApprovalTier;
  principal  @2 :C.PrincipalId;
  summary    @3 :Text;
  effects    @4 :List(RenderedEffect);
  provenance @5 :List(ArgProvenance);
  mandateDraft @6 :Data;          # JCS payload of the mandate to be signed if approved
  requiresPresence @7 :Bool;      # FIDO2 touch required
  expires    @8 :C.Timestamp;
  channels   @9 :List(Text);      # approval channels allowed for this prompt ("local", "phone", "org"), §14.3; empty = ["local"]
  requester  @10 :Text;           # for family machines: the non-owner human on whose behalf an owner is asked (§14.3); empty otherwise
}

struct Decision {
  approved @0 :Bool;
  scope    @1 :Scope;
  mandate  @2 :Data;              # DSSE envelope (presence-signed when requiresPresence, else signed by the atrium approver key)
  note     @3 :Text;
  enum Scope { once @0; session @1; persistent @2; }
}

interface TrustedPrompt {
  approve  @0 (prompt :ApprovalPrompt) -> (decision :Decision);
  presence @1 (purpose :Text, payload :Data, rendering :List(RenderedEffect)) -> (envelope :Data);
      # DSSE signed by owner-presence (§5.3), rendered on the trusted path; rendering (optional) is shown
      # alongside the statement (for example a config plan diff) and its digests are displayed for cross-checking
  notify   @2 (title :Text, body :Text, severity :Severity) -> ();
  secret   @3 (title :Text, body :Text, confirm :Bool) -> (secret :C.Fd);
      #! secret entry on the trusted path (recovery key, trustee card, new PIN, passphrase); confirm = enter twice;
      #! the value is returned in the delivery format of §20.10; facet secret only
  enum Severity { info @0; warning @1; critical @2; }
}
```

**Required review material.** Every `RenderedEffect` is `review = required` unless `gate` or `broker` marked it `decorative`; a requester can never make a rendering optional, and an unknown or absent value means `required`. The trusted path (local prompts, presence cards, phone, org and quorum review) enables approval only when every required rendering was presented **completely**: its `payloadDigest` equals the digest of the mandate-draft effect it presents, it carries all required review details of its effect kind (§14.2), and nothing required is missing, malformed, unsupported or truncated beyond the channel's review limits. When a decoder or renderer crashes or times out, a canonical-text fallback produced by `gate` may replace the rendering only if it presents every required detail within the limits; otherwise the effect can only be denied or deferred. A title or a digest alone never substitutes for required details. A channel that cannot present the required material (for example a phone over its size limit) does not offer the approval: it stays pending for a capable channel or expires and is denied under its normal lifecycle (§14.3).

**Secret entry.** `TrustedPrompt.secret` (facet `secret`: `hearth` for recovery keys, trustee cards, new PINs and passphrases; `vault` for import passphrases) asks for a secret on the trusted path and returns it in the delivery format of §20.10; the value never passes through the requesting app.


### A.15 protocols §7.5.8 — devd-sys.capnp (consumed: PowerEvents)

> Verbatim copy of `protocols/spec.md` lines 2074–2141 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.5.8 `devd-sys.capnp`

```capnp
@0xc7a1e5d3b2f40027;
using C = import "common.capnp";

struct NodePlan {
  id @0 :Text; name @1 :Text; kind @2 :Kind; major @3 :UInt32; minor @4 :UInt32;
  enum Kind { char @0; block @1; }
}

struct PendingDevice {
  device    @0 :Text;              # dev:… id
  bus       @1 :Text;              # "usb" | "thunderbolt" | "pci"
  vendor    @2 :UInt16;
  product   @3 :UInt16;
  serial    @4 :Text;
  port      @5 :Text;              # physical port path
  classes   @6 :List(Text);        # interface classes, e.g. "hid", "mass-storage", "audio", "fido", "net"
  name      @7 :Text;              # descriptor strings, untrusted (rendered as untrusted text)
  hidSafety @8 :Text;              # "none" | "keyboard-like" (requires confirmation with an already-authorized input device)
}

interface DeviceAdmin {            # facets warden, broker (plan, revoke); authorize (atrium: authorize, deauthorize, pending)
  plan   @0 (principal :C.PrincipalId, tokens :List(C.Token)) -> (nodes :List(NodePlan));
  revoke @1 (rootId :Data) -> ();
  authorize   @2 (device :Text, persist :Bool, decisionEnvelope :Data) -> ();
      #! sets the kernel authorized flag (USB) or approves the Thunderbolt/USB4 domain; decisionEnvelope is the mandate
      #! atrium obtained through BrokerSystem.requestFor (resource device, §14.4): devd verifies only the service/broker
      #! or owner-presence signature and the device id; persist stores the identity (vendor, product, serial, port)
  deauthorize @3 (device :Text, forget :Bool) -> ();
  pending     @4 (watcher :C.Watcher(PendingDevice)) -> (cancel :C.Cancelable);
}

interface MediaAttach {            # facets bench, cri
  claimBlock @0 (device :Text, readOnly :Bool) -> (fd :C.Fd, info :Text);
      #! fd of the whole authorized removable block device for a media or pod VM; the host never mounts it (§9.5);
      #! info = JSON {sizeBytes, model, removable, partitions}
  claimVfio  @1 (pciAddress :Text) -> (groupFd :C.Fd, deviceFd :C.Fd);
      #! binds the device to vfio-pci (it must be listed for passthrough in config); the host driver is unbound
  release    @2 (device :Text) -> ();
}

struct PowerEvent { union { preSleep @0 :Text; postResume @1 :Text; battery @2 :Text; sensor @3 :Text; lid @4 :Bool; } }

interface PowerEvents {            # facet client (events), service (subscribe + ack: hearth, strata, atrium)
  subscribe @0 (watcher :C.Watcher(PowerEvent)) -> (cancel :C.Cancelable);
  ack       @1 (op :Text) -> ();
}

struct BtDevice { address @0 :Text; name @1 :Text; paired @2 :Bool; connected @3 :Bool; kind @4 :Text; battery @5 :Int8; }

interface Bluetooth {              # facet admin
  power      @0 (on :Bool) -> ();
  scan       @1 (watcher :C.Watcher(BtDevice)) -> (cancel :C.Cancelable);
  pair       @2 (address :Text) -> ();             # confirmation on the trusted path
  connect    @3 (address :Text) -> ();
  disconnect @4 (address :Text) -> ();
  forget     @5 (address :Text) -> ();
  devices    @6 () -> (list :List(BtDevice));
}

interface Backlight {              # facet atrium
  list @0 () -> (devices :List(Text));
  set  @1 (device :Text, permille :UInt16) -> ();
  get  @2 (device :Text) -> (permille :UInt16);
}
```


### A.16 protocols §9 — Confinement, code integrity, devices and removable media

> Verbatim copy of `protocols/spec.md` lines 2906–3052 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

## 9. Confinement and code-integrity contract

Owned by `warden` (confinement) and `boot` (code-integrity loading). These are the behaviours other components may rely on.

**What a reboot restores.** Reboot restores verified code and owner-approved configuration. Writable state may still contain hostile data and may require quarantine or recovery. Components MUST NOT claim more: persistent hostile data (for example a file that triggers a parser bug) survives reboot and can trigger compromise again. The recovery menu offers **safe start**: the session is not restored and nothing is reopened automatically, and app data units are quarantined read-only until the owner releases them or rolls them back to a snapshot (atrium, strata, warden specs).

### 9.1 Baseline for every non-kernel process except `warden` itself

1. `PR_SET_NO_NEW_PRIVS`.
2. Own cgroup, own dynamic UID (§10.3), no supplementary groups. Human-owned data and directory grants reach dynamic UIDs through **idmapped mounts** (§7.5.1); mapping-only user namespaces used for idmapping are held by `warden`, and no process ever runs inside them.
3. Landlock ruleset at the highest available ABI:
   - starts from deny-all for all handled access rights;
   - allows only the mount view (§10.1), `/grants` (runtime grant mounts) and explicitly granted fds/paths;
   - scopes `ABSTRACT_UNIX_SOCKET` and `SIGNAL`;
   - uses `RESTRICT_SELF_TSYNC` when available.
4. seccomp-bpf allowlist profile `baseline-1`, default action `ENOSYS`. Always denied:
   - `unshare`, `setns`, and namespace flags on `clone`/`clone3` (clone3 → `ENOSYS`, forcing the libc `clone` fallback, which is then flag-checked);
   - `io_uring_*`, `bpf`, `perf_event_open`, `userfaultfd`;
   - `keyctl`, `add_key`, `request_key`;
   - `kexec_*`, `init_module`, `finit_module`, `delete_module`;
   - `mount`, `umount2`, `pivot_root`, `chroot`, `fsopen`, `fsmount`, `fsconfig`, `move_mount`, `open_tree`, `mount_setattr`;
   - `ptrace`, `process_vm_readv`, `process_vm_writev`;
   - `personality` (except the default);
   - `acct`, `swapon`, `swapoff`, `reboot`, `settimeofday`, `clock_settime`, `clock_adjtime`, `adjtimex` (read-only calls included: seccomp cannot inspect `struct timex`, so both are denied with `EPERM`);
   - `ioctl` `TIOCSTI` and `TIOCLINUX`.
5. Namespaces created by `warden` without a user namespace: mount, pid, ipc, uts, cgroup; net unless the principal is a tier-0 service with `network: "host"` (or `"cluster"`, which joins the cri network namespace, §20.16). **Single exception to "only `warden` creates namespaces":** on `server-k8s`, `net` creates the cri network namespace and the per-pod network namespaces inside the cri network (network namespaces only, never user or mount namespaces; §21.5).
6. A fresh `/proc` (`hidepid=invisible,subset=pid`).
7. No controlling terminal unless one is given; `TIOCSTI` disabled system-wide (`dev.tty.legacy_tiocsti=0`).
8. `mseal` of the stack and libc read-only segments (done by the keylos libc startup shim where available); `PR_SET_MDWE` (W^X) unless the generation has `needs.jit`.
9. `RLIMIT_RTPRIO = 0` unless the generation has `needs.realtime` (then 20, with `RLIMIT_RTTIME = 200 000 µs`).

The only other seccomp profiles are `baseline-1+<digest>` (baseline-1 plus the tier-0 extras a service's `privileges.syscalls` and `privileges.socketFamilies` list in `services.json`, §20.16; `<digest>` is the lowercase hex SHA-256 of the extras' names, syscalls and socket families together, sorted by bytes, each followed by `\n`), used only for tier-0 services; `debug-1` (baseline-1 plus `ptrace`, `process_vm_readv`, `perf_event_open`) and `debug-1k` (`debug-1` plus `bpf`, for scope `kernel`), used exclusively for `DebugAttach` debuggers (§9.3); `openbroker-1` (baseline-1 plus `process_vm_readv`; `ptrace`, `process_vm_writev` and `pidfd_getfd` stay denied), used exclusively for `compat`'s per-app open-broker processes (§9.3); and `runtime-default` (baseline-1 ∩ the Kubernetes RuntimeDefault profile) for `keylos-sealed` pods.

### 9.2 Tiers

| Tier | Isolation | Code allowed |
|---|---|---|
| t0 | Baseline + service-specific allowances (system services) | Sealed only |
| t1 | Baseline (apps) | Sealed only |
| t2 | microVM (crosvm) managed by `bench`, display via Wayland proxy | Any (inside guest) |
| t3 | microVM workbench (dev environments, agent sessions) | Any (inside guest) |
| legacy | Baseline + a user namespace built by `warden` (child `user.max_user_namespaces=0`) + FHS view + seccomp user-notification open broker (`compat`). Only forge-built, reproducible legacy images signed by a trusted key run as tier L on the host; every imported image runs in t2 | Sealed legacy image |
| pod (`keylos-sealed`) | t1 baseline with `runtime-default` seccomp, in the pod network namespace inside the `cri` network (§21) | Sealed `container` generations signed by an org publisher |
| pod (`keylos-vm`) | t2-class microVM per pod sandbox managed by `bench` for `cri` | Any OCI image (inside guest) |

Media VMs (removable storage, §9.5), captive-portal browser VMs and agent desktops are tier-3 VMs with their own `VmSpec.purpose`.

### 9.3 Code integrity (host)

**Primary enforcement: the `kl-exec` BPF LSM.** `boot` loads `kl-exec` in the initrd before executing any file other than itself, and hands its maps and links to `warden` across `switch_root`. The program reads kernel structures at offsets the loader computes from the running kernel's BTF (`/sys/kernel/btf/vmlinux`) before load; a missing member fails the load.

| Hook | Decision |
|---|---|
| `bprm_check_security` | Allow if the file's superblock `s_dev` ∈ `kl_exec_allowed_sb`, or (phase INITRD and the file is on the initramfs). Else `-EACCES` |
| `bprm_creds_for_exec` with `bprm->is_check` set (`execveat(…, AT_EXECVE_CHECK)`) | Same rule as `bprm_check_security`. A check-only exec returns after this hook and never reaches `bprm_check_security`, so this row is what refuses an interpreter's check of an unregistered script. Regular execs are decided only by `bprm_check_security` (one event per denial) |
| `mmap_file` with `PROT_EXEC` | File-backed: same rule as exec. Anonymous: allow only if the task's cgroup ID ∈ `kl_exec_jit_cgroups`. Else `-EACCES` |
| `file_mprotect` adding `PROT_EXEC` | File-backed: same as exec. Anonymous or private-writable: allow only for JIT cgroups |
| `kernel_read_file` (firmware, modules, policy, X.509) | Allow if the file's sb ∈ allowed set or (phase INITRD and initramfs). kexec reads are always denied |
| `kernel_load_data` (`init_module`, firmware blobs) | Deny (modules load only via `finit_module` from verified files) |
| `bpf` (`BPF_PROG_LOAD`, `BPF_LINK_DETACH`, `BPF_PROG_DETACH`) | Allow for the `warden` core (thread-group ID recorded in `kl_exec_policy.warden_tgid` at hand-over) and for `boot` in phase INITRD. Allow for a debugger task whose cgroup has a `kl_debug_pairs` entry with scope `kernel`, for tracing program types only (kprobe, tracepoint, raw_tracepoint, perf_event), never LSM, cgroup or XDP types. Deny for every other task |
| `ptrace_access_check` | Allow only if the tracer's cgroup has an unexpired `kl_debug_pairs` entry whose target cgroup contains the tracee (or is an ancestor of it). Yama and the seccomp profile apply in addition. The hook also guards every other `ptrace_may_access` path (`/proc/<pid>/{mem,maps,environ,fd,ns/*,root,…}`, `kcmp`, `pidfd_getfd`, `setns` and `PIDFD_GET_*_NAMESPACE` on a pidfd, `process_vm_*`); no task is exempt, including the `warden` core. Checks with `PTRACE_MODE_NOAUDIT` are refused without an event |
| `perf_event_open` | Allow only for a task whose cgroup has an unexpired `kl_debug_pairs` entry (the hook sees only the `PERF_SECURITY_*` type, not the target) |
| `perf_event_alloc` (events created by a `perf_event_open(2)` call admitted above) | Scope `process`: allow only task events whose target task is in the target cgroup (or a descendant) and cgroup events on the target cgroup; CPU-wide events are refused. Scope `kernel`: allow system-wide events. Kernel-internal counters (watchdog, ptrace hardware breakpoints) are not `perf_event_open(2)` requests and are not checked |

**Map contract.** `boot` passes the map fds to `warden` as fds 3–7 in the order given by the kernel command line `keylos.execmapfds=3,4,5,6,7`:

| Map | Type | Key → value | Writer |
|---|---|---|---|
| `kl_exec_allowed_sb` | `BPF_MAP_TYPE_HASH`, 65 536 entries | `u32 s_dev` (kernel `dev_t`, below) → `u32 gen_index` | warden core only |
| `kl_exec_jit_cgroups` | `BPF_MAP_TYPE_HASH`, 4 096 entries | `u64 cgroup_id` → `u8 1` | warden core only |
| `kl_exec_policy` | `BPF_MAP_TYPE_ARRAY`, 1 entry | `u32 0` → `struct {u8 enforce; u8 audit_allow; u8 phase; u8 pad; u32 warden_tgid;}` | boot only, then frozen (`bpf_map_freeze`) after `warden_tgid` is written at hand-over |
| `kl_exec_events` | `BPF_MAP_TYPE_RINGBUF`, 1 MiB | denial events `{u64 cgroup_id; u32 pid; u32 hook; u32 s_dev; u64 ino;}` | warden core (reader) |
| `kl_debug_pairs` | `BPF_MAP_TYPE_HASH`, 256 entries | `u64 tracer_cgroup_id` → `struct {u64 target_cgroup_id; u64 expires_boottime_ns; u8 scope;}` (scope 0 = process, 1 = kernel) | warden core only (`DebugAttach`) |

Internal maps of the program (for example the LRU map that limits the `perf_event_alloc` check to `perf_event_open(2)` requests) are not handed over and are not part of this contract.

**Numeric values.** Decoders (`warden`, `journal`, tools) rely on these:
- `kl_exec_policy.phase`: INITRD = 0, SYSTEM = 1. `enforce` = 1 refuses denials; `enforce` = 0 is permissive (denials are logged and allowed; development only). `audit_allow` = 1 also logs allowed decisions.
- `kl_exec_events.hook` IDs: 1 `bprm_check_security`, 2 `mmap_file`, 3 `file_mprotect`, 4 `kernel_read_file`, 5 `kernel_load_data`, 6 `bpf`, 7 `ptrace_access_check`, 8 `perf_event_open`, 9 `bprm_creds_for_exec`, 10 `perf_event_alloc`; bit 31 set marks an audit-allow record. The C layout has 4 bytes of padding before `ino` (record size 32 bytes).
- File hooks carry the file's superblock `s_dev` and inode number (anonymous mappings: 0, 0). Other hooks reuse the two fields: `kernel_load_data` `s_dev` = the `kernel_load_data_id`; `bpf` `s_dev` = the command, `ino` = the program type for `BPF_PROG_LOAD`; `ptrace_access_check` `s_dev` = the mode, `ino` = the tracee's thread-group ID; `perf_event_open` `s_dev` = the `PERF_SECURITY_*` type; `perf_event_alloc` `s_dev` = 1 task event, 2 cgroup event, 3 CPU-wide event, `ino` = the target cgroup ID when known.
- `s_dev` everywhere is the **kernel** encoding of `super_block.s_dev` (`MKDEV`: `major << 20 | minor`), not the userspace `st_dev`/`makedev()` encoding. Registrants convert `statx`'s `stx_dev_major`/`stx_dev_minor`.

**Links.** The program's hooks are attached with `BPF_LINK_CREATE` links and live exactly as long as a link fd is open (no bpffs pins after `switch_root`). `boot` passes the ten link fds to `warden` as fds 9–18, one per hook row, in no particular order, with `keylos.execlinkfds=9,10,11,12,13,14,15,16,17,18` in `warden`'s argv (the boot report is fd 8, §20.1). The `warden` core MUST keep them open for its lifetime and never closes or passes them on; closing them detaches `kl-exec`.

**Registering a generation.** Before adding a mount's superblock to `kl_exec_allowed_sb`, the registrant (`boot` for the OS and bootstrap generations; `warden` for everything else, including mounts it makes on behalf of `bench` and `compat`) MUST:
1. obtain the tree from `depot.mount` (or mount it itself with `verity=require` from a digest-checked image, as `boot` does);
2. verify the generation statement (§20.7) DSSE signatures against the **boot trust set** (§20.1): release-stream keys for distro generations, publisher keys enabled in the config generation, and the owner-seal keys for owner-sealed generations;
3. check the generation is not listed `unlaunchable` in the current revocation list (§11.7);
4. read the superblock device with `statx(tree_fd, "", AT_EMPTY_PATH)` and convert it to the kernel `dev_t` (`stx_dev_major << 20 | stx_dev_minor`).

The decision is sound because the composefs overlay was mounted with `verity=require` from an image whose digest was checked, overlay superblocks are not shared across mounts from different images, and only `warden` can update the map. Writable mounts are always `noexec` in addition.

**Second layer: IPE.** IPE runs a policy signed by `kernel-policy/<stream>`:

```
policy_name=keylos policy_version=1.0.0
DEFAULT action=ALLOW
op=KEXEC_IMAGE action=DENY
op=KEXEC_INITRAMFS action=DENY
op=EXECUTE boot_verified=TRUE action=ALLOW
op=KERNEL_READ boot_verified=TRUE action=ALLOW
```

**Other code paths:**
- `module.sig_enforce=1`. Modules load only from the OS generation or from a **`kmod` generation** (§6.1), and every module MUST carry a signature by the release stream's module-signing key: only project-built, release-signed out-of-tree modules exist. Owner-sealed modules are impossible by design (lockdown enforces module signatures, and owners hold no module-signing key). `warden` registers a `kmod` generation's mount only if its manifest `kmod.kernel` equals the running kernel release.
- `vm.memfd_noexec=2`; `kernel.unprivileged_bpf_disabled=2`; signed BPF loaders only for `boot` and `warden`.
- **Service BPF programs.** Some tier-0 services need BPF programs (strata provenance, net firewall helpers, gate accounting). `warden` loads them only from the **OS generation**, from `/usr/lib/keylos/bpf/<service>/<program>.o` files listed for that service in `services.json` (§20.16), before starting the service; it attaches them and passes their map fds to the service as `KEYLOS_BPF_FDS` (§10.5). Services never call `bpf()` themselves.
- **Grant ceilings.** The warden core loads a label-ceiling LSM program (`kl-label`, separate from the `kl-exec` hand-over) that enforces the exposure label of directory grants (§7.3.3, §14.1): an `open` through a grant mount, and a read through an fd opened through one, fails with `-EACCES` when the object's `security.bpf.keylos.label` (§10.4) exceeds the grant's ceiling or is malformed. `kl-label` attaches `file_open` and `file_permission` (plus `mmap_file` for reads through a mapping), keyed by the grant mount's ID in its map `kl_grant_ceiling`, and reads kernel structures at BTF-computed offsets as `kl-exec` does. Unlabelled objects get their location default (§14.1), except that on kernels without the `bpf-init-inode-xattr` feature an unlabelled object created after the grant was attached counts as `secret/untrusted`. Where `warden` cannot enforce ceilings, `attachGrant` gets a null ceiling and the broker MUST raise the holder to `secret/untrusted`.
- **JIT.** Generations with `needs.jit: true` get their cgroup added to `kl_exec_jit_cgroups` by `warden` and no `PR_SET_MDWE`.
- **Interpreters.** Interpreters shipped in keylos generations MUST honour `AT_EXECVE_CHECK` and the `SECBIT_EXEC_RESTRICT_FILE` / `SECBIT_EXEC_DENY_INTERACTIVE` securebits. `warden` sets both securebits on every host principal **except** the **trusted-terminal tree**, which gets only `SECBIT_EXEC_RESTRICT_FILE`.
- **Trusted-terminal tree.** The tree is the process spawned through `TrustedSpawn.spawnTerminal` and every process that `kish` running in it spawns as a job (foreground or background, including REPLs started from the prompt). A process spawned by any *other* program in that tree (for example an editor that spawns a helper) is outside the tree and gets both securebits; `warden` decides by the spawning principal's actor kind (`shell` from the trusted terminal) and the `SpawnSpec` origin, not by process ancestry alone.
- **Core dumps.** The kernel `core_pattern` pipe helper (`|/usr/lib/keylos/journal/coredump %P %s %t`) is started by the kernel in the root cgroup. This is the one userspace exception to "only the warden core runs in the root cgroup": the helper is an OS-generation binary, installs its own seccomp filter before reading any input, and **moves itself** into `/keylos.slice/system.slice/journal-coredump.scope` before reading the dump (cgroup v2 delegation rules allow only a process in the root cgroup's domain with root credentials to make that move; `journal` cannot). `journal` verifies the move and refuses dumps from a helper still in the root cgroup. `kl-exec`'s `bpf` rule does not depend on cgroup membership, so the exception grants it nothing. The helper is not exempt from `ptrace_access_check` either: it reads only `/proc/%P/{cgroup,status}` (not ptrace-guarded) and takes the crashed process's file mappings from the core's `NT_FILE` note, never from `/proc/%P/maps`.
- **Supervising without ptrace access.** Because `ptrace_access_check` exempts no task, `warden` and every other component observe and control other processes only through operations the hook does not guard: pidfds (from `clone3(CLONE_PIDFD)` or `pidfd_open`) for signals (`pidfd_send_signal`) and exit (`waitid(P_PIDFD)`), `PIDFD_GET_INFO` for credentials and the cgroup ID, `/proc/<pid>/{cgroup,status}`, and cgroup files. A child's namespace fds are captured at spawn: the child opens its own `/proc/self/ns/*` (a task's access to itself is not checked) and passes them to the spawner before its start barrier, and a mapping helper passes its own user-namespace fd the same way. No keylos component opens another task's `/proc/<pid>/{ns/*,root,cwd,fd,maps,mem,environ}` or uses `PIDFD_GET_*_NAMESPACE`, `setns` on a pidfd, `pidfd_getfd`, `kcmp` or `process_vm_*` on another task, except a debugger or open broker within its `kl_debug_pairs` entry.
- **Known limitation (composefs `mprotect`).** For an overlay (composefs) file mapping the kernel passes the backing file to `file_mprotect`, whose superblock is not the registered overlay superblock, so adding `PROT_EXEC` to such a mapping with `mprotect` is refused outside JIT cgroups. `execve` and `mmap(PROT_EXEC)` see the overlay file and are unaffected; only text relocations and similar are refused. Generations needing them declare `needs.jit`.
- **Legacy open broker.** `compat` runs **one open-broker process per legacy app** (the `kl_debug_pairs` map holds one target per tracer). At `LegacySpawn` time (parameter `brokerSession`, §7.5.1) `warden` writes a `kl_debug_pairs` entry (scope `process`, no expiry while the app runs) from that open-broker process's cgroup to the legacy app's cgroup. For this pair `ptrace_access_check` permits `PTRACE_MODE_READ` and `PTRACE_MODE_ATTACH_REALCREDS` (the mode the kernel checks for `process_vm_readv`). The open broker runs with seccomp profile `openbroker-1`, which allows `process_vm_readv` and denies `ptrace`, `process_vm_writev` and `pidfd_getfd`, so the pairing yields read access to the app's memory for decoding seccomp-notification syscall arguments and nothing else.
- **Debugging (`Right.debug`).** A debug grant is minted only at tier T3 with presence, lasts at most 3 600 s (scope `process`) or 900 s (scope `kernel`), and is never minted to an agent principal unless the target session lies inside that agent's own session tree; agents never get scope `kernel` and never a `gen:` target. A request with `durationSecs = 0` resolves to the policy default before minting (default 900 s for `process`, 300 s for `kernel`). It is materialised by `Broker.debug` → `DebugAttach.attach` (§7.5.1): `warden` spawns the debugger generation (policy list `debug.debuggers`, e.g. gdb, lldb, perf, bpftrace) with seccomp profile `debug-1`, writes the `kl_debug_pairs` entry, and grants the debugger ambient capabilities: `CAP_SYS_PTRACE` and `CAP_PERFMON` for scope `process` (tracing another dynamic UID and opening cgroup-scoped perf events need them), plus `CAP_BPF` for scope `kernel`. `kl-exec`'s `ptrace_access_check`, `perf_event_open` and `bpf` hooks bound what those capabilities reach to the paired target. Receipts `debug.attach`/`debug.detach`. Inside workbench VMs debugging is unrestricted.

### 9.4 Confinement report

`Process.confinement` returns JCS JSON:

```json
{"schema":"keylos.confinement/1","tier":"t1","featureLevel":"KL2","landlockAbi":9,
 "namespaces":["mnt","pid","ipc","uts","cgroup","net"],"userns":false,
 "seccompProfile":"baseline-1","compensations":["udp-via-netns"],"jit":false,
 "tlsInterception":{"active":false,"hosts":[]},"grants":["/grants/thesis"]}
```

`seccompProfile` is one of the profile names of §9.1: `baseline-1`, `baseline-1+<digest>` (tier `t0` only), `debug-1`, `debug-1k`, `openbroker-1` or `runtime-default`. A kernel below KL1 is not a supported platform (§2), so a truthful report from one does not validate.

`tlsInterception` is filled from `gate` (`GateDebug.interception`, §7.5.12): when `gate` intercepts TLS for the principal (method filtering or credential injection), `active` is true and `hosts` lists the intercepted hosts.

### 9.5 Devices, removable media and DMA

- **USB authorization.** `devd` sets `authorized_default=0` on every USB host controller. A newly attached device stays unauthorized (no driver binds) until approved on the trusted path and authorized through `DeviceAdmin.authorize` (§7.5.8). Approvals are stored per device identity (vendor, product, serial, port) when the human ticks "remember".
  - Input devices present during installation are pre-authorized.
  - A new device exposing a HID keyboard-like interface (`hidSafety: "keyboard-like"`) can only be approved using an **already-authorized** input device; its own keystrokes are discarded until then (BadUSB keystroke-injection defence).
  - Policy MAY auto-authorize device classes (`devices.autoAuthorize`, e.g. `["audio", "fido"]`); class `hid`, `net` and `mass-storage` are never auto-authorized by default.
  - **Before `devd` runs.** The kernel command line sets `usbcore.authorized_default=2` (only devices on internal, hard-wired ports are authorized). The initrd's authorizer (`boot`) additionally authorizes external hubs and devices whose interfaces are **all** HID, so external keyboards work for VBU, the PIN and the recovery prompt; it never authorizes storage, network or composite devices with a non-HID interface. In the initrd, keystrokes reach only those prompts (the TPM dictionary-attack lockout bounds PIN guessing). After `switch_root`, `devd` re-evaluates every authorized external device: a device that is neither remembered nor listed in `/var/lib/keylos/devd/preauthorized.json` is deauthorized and becomes pending. The remaining window is residual risk R15 of the distribution.
  - `/var/lib/keylos/devd/preauthorized.json` (written by the installer: the input devices present at installation; read by `devd`): `{"schema":"keylos.preauth/1","devices":[{"vendor":"046d","product":"c52b","serial":"…","port":"usb1-2","classes":["hid"]}]}` (vendor/product as 4 lowercase hex digits; `serial` empty when the device has none).
- **Thunderbolt / USB4 / external PCIe.** The IOMMU is required (§2). Domains and devices are authorized by `devd` only after trusted-path approval; without an IOMMU they are never authorized. Pre-boot DMA protection relies on firmware; the boot report records whether the firmware declared it.
- **Removable storage is never mounted by host filesystem drivers.** Authorizing a mass-storage, SD, optical or MTP device makes its block device (or MTP endpoint) available only through `MediaAttach.claimBlock` to a **media VM** (`VmSpec.purpose = media`, image `io.keylos.bench.media`), started by `Bench.media`. The VM mounts the filesystem and serves files through `MediaBrowser` (§7.5.10).
  - Bytes read through `MediaBrowser.open` are labelled `public/untrusted`; `portal-files` shows the device as the location "USB: <label>".
  - Writing to the device is the effect `media.export` (§14.2): data is copied into the media VM, which writes it.
  - Exception: a disk whose LUKS2 header carries the keylos backup token (`keylos-backup`) and verifies against the machine's backup key is unlocked and mounted on the host by `strata` for backups only.
- **Fingerprint readers** may unlock the screen lock only. They never satisfy presence and never unlock the disk.
- **VFIO passthrough** (`needs.gpu: "passthrough"`, pod VMs): only devices listed in config `devices.passthrough` are bound to `vfio-pci` through `MediaAttach.claimVfio`; the host driver is unbound for the VM's lifetime.


### A.17 protocols §10 — Filesystem and system layout

> Verbatim copy of `protocols/spec.md` lines 3056–3232 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

## 10. Filesystem and system layout

### 10.1 Host layout

| Path | Content | Properties |
|---|---|---|
| `/` | OS generation (composefs, `verity=require`) | ro |
| `/usr` | Part of the OS generation | ro |
| `/etc` | Merged config generation (confext) | ro |
| `/var` | btrfs subvolume `@var` | rw, `nosuid,nodev,noexec` |
| `/home/<user>` | btrfs subvolume per user | rw, `nosuid,nodev,noexec` |
| `/home/<user>/.apps/<app-name>/{config,data,cache,state}` | Subvolume per app and user | the only writable paths in an app's view |
| `/store/objects/<2 hex>/<62 hex>` | Store objects, fs-verity enabled, mode 0444 | written only by `depot` |
| `/store/gens/<64 hex>.erofs` | Generation images | |
| `/store/evidence/` | Generation statements, attestations, consent records | `depot` |
| `/store/db/` | `depot` database | |
| `/store/rcpt/` | `ledger` data | |
| `/keystore` | btrfs subvolume `@keystore`, **excluded from all snapshots** | `vault`, `hearth`, `ledger`, `strata` key material (wrapped) |
| `/snapshots` | btrfs snapshot area, `strata` only | |
| `/run` | tmpfs | |
| `/run/keylos/svc/<svc>/` | Service socket directories | 0700 warden |
| `/run/keylos/boot/trust.json`, `report.json` | Boot trust set and boot report (§20.1) | 0444, written by `boot` |
| `/var/lib/keylos/<repo>/` | Each service's private state directory (other repos may read only the files listed in §10.7) | owned by the service's dynamic UID |
| `/var/lib/keylos/cri/images/` | OCI content store for `keylos-vm` pods (unsealed, never executed on the host) | `cri`; `noexec`; shared read-only into pod VMs |
| `/efi` | ESP | mounted only during updates (and by `boot` for `/efi/keylos/vbu-totp.sealed`) |

**App mount view** (what a tier-1 process sees):
- its app generation at `/` (with `/usr` from its runtime generation if it declares one);
- `/etc` filtered to the app-visible subset (`/etc/keylos/app-visible.list` in the config generation);
- its `.apps/<name>` subvolumes at `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `$XDG_CACHE_HOME`, `$XDG_STATE_HOME` (idmapped to its dynamic UID);
- `/run/user/<uid>/` with only its Wayland socket (security-context tagged) and its PipeWire remote if granted;
- `/grants/` (initially empty; runtime grants are attached here);
- `/tmp` as a private tmpfs;
- nothing else.

### 10.2 Disk layout

GPT:
1. ESP (1 GiB, FAT32).
2. `keylos-root`: LUKS2 with dm-integrity AEAD (`aegis128` where available, else `aes-gcm-random` + HMAC-SHA256 integrity), holding btrfs subvolumes `@store`, `@var`, `@home`, `@keystore`, `@snapshots`.
3. Optional `keylos-swap`: encrypted with an ephemeral random key at every boot. There is no hibernation (§2).

### 10.3 UIDs and cgroups

**UIDs:**

| Range | Use |
|---|---|
| 0 | Kernel threads, `warden` (PID 1). No other process. |
| 1000–59999 | Humans (allocated by `hearth`) |
| 0x00100000–0x0FFEFFFF | Dynamic principal UIDs, allocated by `warden` per running principal instance. Quarantined for 60 s after release. |
| 0x0FFF0000 | Reserved on-disk owner of `_cluster` data (pod volumes, cri state); reached by containers only through idmapped mounts; never allocated to a process |
| 0x0FFF0001–0x0FFFFFFF | Reserved |
| 0x10000000–0x7FFEFFFF | Legacy-tier user-namespace ranges, 65536-UID blocks, allocated by `warden` |

**cgroups:**

```
/keylos.slice/system.slice/<service>.scope
/keylos.slice/user-<uid>.slice/{shell,apps,agents,benches,legacy}.slice/<session>.scope
/keylos.slice/kube.slice/<pod-id>.slice/<container-or-vm>.scope      (cgroup subtree delegated to cri)
/keylos.slice/guest-<id>.slice/…                                    (ephemeral guest sessions, removed at logout)
```

### 10.4 Extended attributes

| xattr | Writer | Content |
|---|---|---|
| `security.bpf.keylos.prov` | BPF LSM at inode creation (`strata`) | CBOR `{p: principal, g: generation, x: transaction, t: time}` |
| `security.bpf.keylos.label` | `broker` / `strata` | 2 bytes: conf, integ (§14.1 ordinals) |
| `security.keylos.unit` | `strata` | Crypto-shred unit ID |
| `trusted.overlay.metacopy`, `trusted.overlay.redirect` | `depot` (composefs) | |

Names a BPF LSM program must read or stamp use the `security.bpf.` prefix: the kernel's BPF xattr kfuncs (`bpf_get_file_xattr`, `bpf_get_dentry_xattr`, `bpf_set_dentry_xattr`) accept only `user.*` (read) and `security.bpf.*` names, and are available to LSM program types only. From userspace, setting or removing any `security.*` name, `security.bpf.*` included, needs `CAP_SYS_ADMIN` in the user namespace that owns the filesystem; no keylos BPF program attaches `inode_xattr_skipcap`, so that check always applies. Principals never hold `CAP_SYS_ADMIN` and never own a filesystem's user namespace, so only the writers listed above can set these names. `security.keylos.unit` is read only by `strata` and keeps its name.

### 10.5 Environment conventions

Processes receive:
- `KEYLOS_PRINCIPAL` (text)
- `KEYLOS_SESSION`
- `KEYLOS_TIER`
- `KEYLOS_CAPWIRE_FDS`: a comma list of `name=fdnum` for passed service sockets, for example `broker=3,portal-files=4`. Names follow the route-name rule below.
- `KEYLOS_ARGFD_<argname>` and `KEYLOS_PIPE_IN` / `KEYLOS_PIPE_OUT` (§12)
- `KEYLOS_TXN`: the strata transaction ID when spawned with `SpawnSpec.transaction`
- `KEYLOS_AGENT_HOST`: `vsock:2:7002` inside agent workbenches
- `KEYLOS_GUEST_PORTALS`: `vsock:2:7004` inside tier-2 guests
- `KEYLOS_BPF_FDS`: `name=fdnum` list of BPF map fds `warden` loaded for a tier-0 service (§9.3)
- `KEYLOS_TPM_FD`: for services whose `services.json` entry has `privileges.tpm: true`, the number of an inherited fd of `/dev/tpmrm0` that `warden` opened for the service; services use it as their TPM (for example TCTI `device:/proc/self/fd/<n>`) and never open TPM devices by path
- XDG variables, with paths per §10.1

In tier-0 services fd 3 is the `warden` bootstrap socket (`Bootstrap`, §7.5.1) and is not listed in `KEYLOS_CAPWIRE_FDS`.

**Route names in `KEYLOS_CAPWIRE_FDS`:**

| Route | Name |
|---|---|
| `<svc>#client`, `<svc>#default` | `<svc>` |
| `broker#principal` | `broker` |
| `warden#client`, `warden#service` | `warden` |
| any other `<svc>#<facet>` | `<svc>#<facet>` |

**Adopting inherited descriptors.** Programs take ownership of fd 3 and of the descriptors named in `KEYLOS_CAPWIRE_FDS`, `KEYLOS_BPF_FDS` and `KEYLOS_TPM_FD` exactly once at start-up through the `keylos-capwire` inheritance helper (§18), which checks that each fd is open and sets `FD_CLOEXEC`; programs need no `unsafe` code of their own for it.

**Development knobs.** Names starting with `KEYLOS_DEV_` are reserved for development-only settings, for example `KEYLOS_DEV_TPM_TCTI` (a TPM TCTI string such as `swtpm:host=127.0.0.1,port=2321`, which replaces `KEYLOS_TPM_FD`). Production builds never read them, and `warden` never sets them; only the development supervisor of a development image may. Every other development knob of a keylos component uses this prefix. The registered knobs are:

| Knob | Read by | Effect (development builds only) |
|---|---|---|
| `KEYLOS_DEV_TPM_TCTI` | every TPM-using service (vault, hearth, ledger, broker, strata, courier, config) | TPM TCTI string that replaces `KEYLOS_TPM_FD` |
| `KEYLOS_DEV_LEDGER_SELF_PROVISION` | ledger | `1`: on a fresh store with the counter `0x01300100` absent, define it itself (`x-devProvision`) instead of waiting for `HearthTpm.defineSpace`; never after hearth genesis |
| `KEYLOS_DEV_LEDGER_SAMPLE_EXPORT` | ledger (tests) | Directory for sample exports written by the privacy test harness |
| `KEYLOS_DEV_HEARTH_SOFT_AUTHENTICATOR` | hearth | Use a software FIDO2 authenticator instead of a CTAP2 device |
| `KEYLOS_DEV_BROKER_IMPLICIT_SESSIONS` | broker | `1`: register an unregistered `broker#principal` peer implicitly instead of failing `kl:denied` |
| `KEYLOS_DEV_BROKER_POLICY_DIR` | broker | Directory that replaces the warden-mounted `/policy` generation |
| `KEYLOS_DEV_BROKER_GENERATION` | broker | Generation ref used for the broker's own principal when `ServiceHost.accept` and `policy.ref` give none |
| `KEYLOS_DEV_TIME_TRUSTED` | broker, loom | `1`: treat the system clock as trusted without a `NetWatch` `timeTrusted` event |
| `KEYLOS_DEV_WATCHDOG_SECS` | broker and every other daemon with a `watchdogSecs` of its own (it reads the knob itself; the `warden-svc` host reads none) | Watchdog interval that replaces the manifest's `watchdogSecs` |
| `KEYLOS_DEV_LOOM_FAULTS` | loom | Comma list of fault-injection points (`crash:<point>`, `fsync-fail:<point>`, `enospc:<point>`, points named in the loom spec) for the durability acceptance tests |
| `KEYLOS_DEV_LOOM_CLOCK_SKEW_SECS` | loom | Signed offset added to loom's view of trusted time, for timer, expiry and long-downtime tests |

A knob that is not listed here MUST NOT be read by any component; a new knob is registered here before use.

No secrets, ever. Names starting with `KEYLOS_` are reserved; `SpawnSpec.env` MUST NOT set them, with one exception: a `shell` principal MAY set `KEYLOS_ARGFD_*`, `KEYLOS_PIPE_IN` and `KEYLOS_PIPE_OUT` (§12); `warden` verifies that every fd named in `KEYLOS_ARGFD_*` is present in `SpawnSpec.fds`.

### 10.6 Log records

Processes write logs to the journal stream fd (fd 2 is connected to it by default) as:
- plain text lines, or
- **structured records**: a datagram whose first byte is `0x1E` followed by a CBOR map with keys `l` (level 0–7), `m` (message) and `f` (fields map), or
- **metrics records**: a datagram whose first byte is `0x1F` followed by a CBOR map with keys `n` (metric name), `t` (`"counter"` | `"gauge"` | `"histogram"`), `v` (number, or for histograms a map of bucket bound → count plus `sum` and `count`) and `l` (labels map).

### 10.7 Cross-repository files

A repository MAY read a file written by another repository **only if the file is listed here**; everything else is that repository's private state.

| Path | Format | Writer | Readers |
|---|---|---|---|
| `/run/keylos/boot/trust.json`, `report.json` | `keylos.boottrust/1`, `keylos.bootreport/1` (§20.1) | boot | any tier-0 service, `vouch` tooling |
| `/etc/keylos/services.json` | `keylos.services/1` (§20.16) | config | warden, boot, ledger |
| `/etc/keylos/policy.ref` | `keylos.policyref/1` (§20.17) | config | warden, broker |
| `/etc/keylos/owner-seal/<i>.spki` | DER SubjectPublicKeyInfo | config | boot |
| `/etc/keylos/publishers.json` | `keylos.publishers/1` (§20.20) | config | boot, depot |
| `/etc/keylos/exceptions/*.dsse` | `keylos.exception/1` envelopes (§20.9) | config | depot, ledger, warden (effective tiers) |
| `/etc/keylos/strata/snapshot-exclude.list` | newline-separated absolute paths | config | strata, vault |
| `/etc/keylos/app-visible.list` | newline-separated paths under `/etc` | config | warden |
| `/store/evidence/<hex>/statement.dsse` | `keylos.genstmt/1` envelope (§20.7), `<hex>` = generation digest | depot | boot, warden |
| `/store/revocations/<stream>.dsse` | `keylos.revocations/1` envelope (§11.7) | depot | boot, warden |
| `/var/lib/keylos/config/*.dsse` | `keylos.configgen/1` envelopes (§15) | config | boot |
| `/var/lib/keylos/hearth/owners.log` | owner registry (§20.3) | hearth (installer at genesis; installer's `rescue` in the recovery profile: `recover` and credential entries) | boot (replay in the initrd); `config-recover` and `rescue` (recovery profile only) |
| `/var/lib/keylos/fleet/wipe.dsse` | wipe bundle: the §20.23 wipe command plus an owner quorum envelope of purpose `boot.wipe` (§20.2) | fleet | `rescue` (recovery profile only) |
| `/var/lib/keylos/tpm/nv-auth/<index>.sealed` | `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` of the sealed authValue object (§19.6, "Sealed secrets"); `<index>` is `0x` + 8 lowercase hex digits, e.g. `0x01300100.sealed` | installer at genesis; hearth on (re)definition (`HearthTpm.defineSpace`); `rescue` (recovery profile) | the index's registered owner service only |
| `/var/lib/keylos/tpm/hierarchy-owner.sealed`, `hierarchy-endorsement.sealed` | TPM-sealed hierarchy authValues (§19.6) | installer at genesis; hearth on rotation | hearth |
| `/var/lib/keylos/tpm/hierarchy-owner.recovery` | HPKE (§4) ciphertext of the owner-hierarchy authValue to the recovery recipient (§20.21) | installer; hearth on rotation | recovery environment |
| `/var/lib/keylos/hearth/seal-gate-<i>.sealed` | quorum seal-gate blob (§19.6) | installer at genesis (quorum machines); hearth | hearth |
| `/var/lib/keylos/hearth/platform/<keyid>.blob` | assisted platform authenticator blob: JCS `{rpId, credentialId, cose, salt, key, hmacKey}` (§5.3) | installer (assisted credential enrolled at install); hearth | hearth |
| `/var/lib/keylos/recovery/recipient.pub` | 32-byte raw X25519 public key of the recovery recipient (§20.21) | installer | vault, hearth |
| `/var/lib/keylos/recovery/pending/<ULID>.dsse` | `keylos.pendingreceipt/1` (§20.22) | recovery environment (`rescue`, installer repo) | ledger (appends at the next normal boot, then deletes) |
| `/var/lib/keylos/devd/preauthorized.json` | `keylos.preauth/1` (§9.5) | installer | devd |
| `/etc/keylos/fleet/approvers.json` | `keylos.fleetapprovers/1` (§20.23); the only source of org approver keys | config (fleet module) | hearth, rescue (recovery environment), broker |
| `/keystore/ledger/signing.sealed` | TPM-sealed Ed25519 seed of the machine key | installer | ledger (MUST accept an existing key) |
| `/var/lib/keylos/firstboot/bundle.json` | `keylos.firstboot/1` (§20.13) | installer | the consumers listed in §20.13 |
| `/efi/keylos/vbu-totp.sealed` | sealed 20-byte TOTP secret (§20.5) | installer (`keylos-enrol vbu-totp`) | boot |
| `/usr/lib/keylos/bpf/<service>/*.o` | BPF ELF objects in the OS generation | pkgs (build) | warden |
| `/run/keylos/gate/ca.pem` (inside tier-L views) | PEM CA bundle of the principal's gate shim | gate | compat (sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`) |
| kernel command line `keylos.revocations=<serial>:<sha256>` | revocation list pin of the UKI's own release | release build (inside the signed UKI command line; `courier` only verifies it at staging) | boot |

**Per-service configuration files.** `/etc/keylos/<service>.json` and `/etc/<service>/*` are rendered by `config` and read only by that service; they need no row here, and their formats are defined in the service's own spec.

**Durable-execution state.** The durable records of §20.25 are private state of their owners (no other repository reads them); each lives in exactly one place, on persistent storage, behind a checked durability barrier:

| State | Owner | Location |
|---|---|---|
| Workflow store: enrollments, runs, steps, attempts, observations, timers, signals, tombstones, receipt outbox | loom | `/var/lib/keylos/loom/loom.db` (SQLite WAL, `synchronous=FULL`) and `/var/lib/keylos/loom/blobs/` |
| Workflow records (enrollment scope, epoch, label high-water mark, cancellation) and durable decisions | broker | `/var/lib/keylos/broker/workflows/`, `/var/lib/keylos/broker/decisions/` |
| Durable effect records and workflow budget accounts | gate | `/var/lib/keylos/gate/outbox.redb` (tables `effects`, `effects_by_workflow`), `/var/lib/keylos/gate/meter.redb` (table `accounts`) |
| Prepared-merge completion records | strata | strata's registry (strata spec) |

None of them may live in `warden`'s `FdStore`, under `/run`, in a diagnostic snapshot, or only in a ledger receipt.


### A.18 protocols §13.1, §13.4, §19.3 — Receipts, receipt privacy and receipt events

> Verbatim copy of `protocols/spec.md` lines 3374–3397, 3410–3421, 3941–3942, 3950, 3967 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 13.1 Receipt payload (`keylos.receipt/1`)

```json
{
  "schema": "keylos.receipt/1",
  "seq": 1042,
  "prev": "rcpt:sha256:…",
  "time": "2026-10-07T21:30:00.123456789Z",
  "writer": "service:broker:gen:fsv256:…@_system/s-…",
  "subject": "agent:gen:fsv256:…@alice/s-…",
  "event": "grant.issue",
  "data": {"rootId": "t-…", "rights": ["path:/home/alice/src/proj:read"], "expires": "…"},
  "label": {"conf": "private", "integ": "untrusted"},
  "approval": null
}
```

Rules:
- `seq` and `prev` are assigned by `ledger`. The writer signs the payload with `seq: 0` and `prev: null` (the **submitted form**); `ledger` fills them in, countersigns the final payload, and stores both signatures with the submitted form's digest. Verifiers reconstruct the submitted form (set `seq` to 0 and `prev` to null) to verify the writer's signature, and verify `service/ledger`'s signature over the final payload.
- **Signatures.** The stored envelope carries exactly two signatures, in this order: the writer's (over the PAE of the submitted form), then `service/ledger`'s (over the PAE of the final payload). They are told apart by `keyid`; signature objects carry no other members (no `scope`).
- **Ledger-originated receipts** (events the ledger writes itself, such as its own `ledger.key.register`, `ledger.alarm`, `ledger.redact` and `ledger.shred`): `writer` is the ledger's own principal and so is `subject`, except for replays of spooled receipts (§20.22), which keep the original subject and are sealed exactly when §13.4 requires it (a person's subject); a receipt whose subject is the ledger is never sealed. The envelope carries exactly one signature, `service/ledger`'s over the final payload; there is no submitted-form signature. `subject` is never empty: a writer whose event has no natural subject names its own principal. The first receipt of an empty ledger, and of every ledger epoch after an alarm, is the ledger's own `ledger.key.register {service: "ledger", spki, keyRef}`, so readers obtain the machine key through `Ledger.serviceKey("ledger")`. Verifiers (`keylos-formats`) accept both forms.
- **Time order.** `time` is non-decreasing in `seq`. The ledger orders each group commit by (`time`, arrival) before assigning sequence numbers, and refuses a submission whose `time` is earlier than the current head's with `kl:invalid` and a message containing `re-sign`. The writer then rebuilds the submitted form with a fresh `time`, signs it again and resubmits (writer libraries do this, with bounded retries). A resubmission is a new submission; the ledger does not deduplicate, and logical deduplication is the writer's responsibility. The rule keeps every month unit, retention cut and `since`/`until` range a contiguous `seq` range, so a late receipt can never land in a month that was already shredded or expired.
- Event names are registered in §19.3.
- Receipts with personal payloads carry `sealed` instead of clear `data` and `label` (§13.4).

### 13.4 Receipt privacy

- **Which receipts are sealed.** Every receipt whose `subject` has a human other than `_system` and `_cluster` is stored **sealed**: the final payload has `"data": null, "label": null` and
  `"sealed": {"unit": "ledger:<human>:<YYYY-MM>", "alg": "aes-256-gcm", "nonce": "<base64 12 bytes>", "ct": "<base64 of the JCS bytes of {\"data\":…, \"label\":…}>", "submitted": "sha256:<digest of the submitted form>"}`.
  The AEAD associated data is the UTF-8 bytes of `sealed.unit`, one `0x00` byte, then the UTF-8 bytes of `sealed.submitted`. Optional top-level `refs` (object; values only `rcpt:`/`gen:`/`drv:` refs and `e-`/`a-`/`wf-`/`wr-`/`ws-`/`fx-`/`dr-`/`ba-` IDs) is added by the ledger and is not part of the submitted form. `ledger.key.register` is never sealed. Final receipts start at `seq` 1 (`prev: null` exactly for `seq` 1); signatures follow §13.1. Replayed receipts carry a top-level `onBehalfOf`.
  The month is the receipt's `time` month (UTC). The unit key comes from `vault.dataKey` on facet `ledger`.
- **What stays in clear:** `schema`, `seq`, `prev`, `time`, `writer`, `subject`, `event`, `approval`, and reference values the event registry marks as `refs` (rcpt/gen/drv refs; intent, approval, workflow, run, step, effect, decision and budget-account IDs; never free text or paths). For `workflow.*` and for `effect.*`, `approval.*`, `grant.*` and `budget.*` receipts that name a workflow, the ledger copies `data.workflow`, `data.run`, `data.step`, `data.effect`, `data.decision` and `data.account` into `refs`, so cancellation and effect evidence stays readable after a month is shredded (§20.25).
- **Integrity.** The hash chain and `service/ledger`'s countersignature cover the final (sealed) payload, so shredding a month preserves chain integrity. The writer's signature covers the submitted (clear) form; it is verifiable while the unit key exists. After shredding, writer attribution rests on the ledger countersignature and `sealed.submitted`.
- **Shredding.** `LedgerAdmin.shred` (§7.5.5) destroys `ledger:<human>:<YYYY-MM>`; an automatic job shreds months older than `ledger.retentionMonths` (default 13, configurable, minimum 1). Event `ledger.shred`.
- **Readers** follow §7.3.5. `fleet` sees metadata only unless an owner exception of kind `fleet-receipt-access` lists the event types.
- **Backups and exports** contain the sealed form; `ledger export` produces a self-contained verifiable bundle (`keylos.ledger-export/1`) and decrypts payloads only for the exporting owner.
- **Returned form.** `Ledger.get`, `query` and `watch` return each receipt as the stored final DSSE envelope (JSON object). When the reader may decrypt a sealed payload, the returned object carries one extra top-level member `"clear": {"data": …, "label": …}` (JCS). Verifiers MUST remove `clear` before checking signatures and computing the `rcpt:` digest, and MUST check `sealed.submitted` against the submitted form rebuilt from the clear values when verifying the writer signature.

| Event | Writer |
|---|---|
| `txn.begin`, `txn.commit`, `txn.abort`, `txn.undo`, `snapshot.create`, `snapshot.delete`, `unit.create`, `unit.forget`, `backup.run`, `backup.restore-test`, `anchor.rollback-detected` | strata |

**Extension rule.** A repository MAY emit additional events named `x-<repo>.<event>` (for example `x-strata.replica.send`). They MUST be listed in that repository's spec, MUST be written only by that repository's services, and carry no semantics for other components. Events named without a prefix MUST appear in this table.


### A.19 protocols §14 — Labels, effects, approval tiers and mandates

> Verbatim copy of `protocols/spec.md` lines 3425–3554 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

## 14. Labels, effects and approval tiers

### 14.1 Labels

| Dimension | Values (lowest → highest) |
|---|---|
| Confidentiality | `public` (0) < `internal` (1) < `private` (2) < `secret` (3) |
| Integrity | `trusted` (0) < `user` (1) < `untrusted` (2). Higher means *less* trustworthy |

- **Objects:**
  - Files carry `security.bpf.keylos.label`. Files without one inherit the default for their location: home data `private/user`; downloads and web content `public/untrusted`; store objects `public/trusted`.
  - Sockets get a label per connection from `gate`: responses from hosts are `untrusted` unless the policy marks the host `user`.
- **Sessions:** each principal session has a label. On every broker-mediated read, `session.conf = max(session.conf, object.conf)` and `session.integ = max(session.integ, object.integ)`. Labels never decrease within a session.
- **Label authority:** services that hand data from one principal to another (gate, bench, portals, atrium, strata, aide, journal, warden) raise the receiver's label with `LabelAuthority.raiseFor` (§7.5.2) **before** handing the data over. `warden` reads live labels with `labelOf` for `ConnectionInfo.label`.
- **Removable media and discovery:** bytes from `MediaBrowser` and results from `Discovery.browse` are `public/untrusted`.
- **Rule of Two** (enforced by `broker` and `gate`): define three properties of a session:
  - **U** = `integ == untrusted`
  - **P** = `conf ≥ private`
  - **X** = holds or requests a capability with `Right.commit`, an `effect` resource, or egress to a host not marked `sink-safe`

  A session MUST NOT hold all three. Requesting the third turns into a **declassification** approval at tier T3, unless a policy-registered **flow proof** (§20.11) is accepted. A flow proof is accepted only from an `agent-template` whose manifest `agent.flowProof` is `"camel/1"` and whose harness runtime is in the policy's trusted list.
- **Directory grants** (ceilings). A directory exposed to a session through a grant has an **exposure label** *c*, and the label assumptions hold only if *c* bounds everything readable through the grant for its whole lifetime:
  - The receiver's session label is raised to *c* (`raiseFor`) **before** the directory is exposed, and the resulting policy decision (Rule of Two) is enforced at that point.
  - *c* is enforced by `warden` (§7.3.3, §9.3): objects labelled above *c*, or with a malformed label, are not readable through the grant, whenever they appeared. Unlabelled objects count at their location default.
  - The broker may choose *c* as the join of a **complete** assessment of the tree. A bounded or truncated walk never justifies anything lower than the location default; entries above *c* then stay unreadable through the grant and are reported as hidden.
  - Without enforcement (null ceiling) the exposure label is the lattice maximum `secret/untrusted`.
  - Writes, relabels and renames into the tree, retained handles and concurrent changes are covered because enforcement happens at every open and read through the grant, not at grant time. A retained fd loses read access as soon as its object's label rises above *c*.
  - Agent input SHOULD be an **immutable assessed view** (a transaction base snapshot or a bench share snapshot): its complete assessment is final, so its exposure label can be lower without losing workflows to the `secret` deny of agent policy.

### 14.2 Effect kinds

Registered kinds, with their default class:

| Kind | Class |
|---|---|
| `fs.merge` | compensable (undo snapshot; compensator `fs.undo`) |
| `git.push` | compensable for new branches; irreversible for force pushes, pushes to protected branches and any other push to an existing branch |
| `git.pr.open` | compensable |
| `email.send` | irreversible |
| `message.send` (chat) | irreversible |
| `http.post`, `http.put`, `http.patch` | irreversible unless the host policy registers a compensator |
| `http.delete` | irreversible |
| `payment.authorize` | irreversible (requires an AP2-style mandate in `data`) |
| `publish.package` | irreversible |
| `cloud.iam.change` | irreversible |
| `db.write.prod` | irreversible |
| `calendar.create` | compensable |
| `file.share` | compensable |
| `device.actuate` | irreversible |
| `net.listen` | compensable (close the port). Required for any port reachable from non-loopback addresses (scope `lan`/`any`); loopback-only listening needs no effect |
| `media.export` | compensable (delete the file on the device); counts as egress (property X) for the Rule of Two |
| `config.propose` | reversible (a proposal only; applying it is `config.apply`) |

Policy can register additional kinds (`x-…`), each optionally with an effect renderer component (§20.15). Classes can be raised, never lowered.

**Mandate-only kinds.** The broker records decisions that are not intents with these kinds in mandate `effects[]` (§14.4): `grant.<k>` for every resource kind *k* of §8.2 (`grant.path`, `grant.net`, `grant.device`, `grant.secret`, `grant.budget`, `grant.spawn`, `grant.service`, `grant.effect`, `grant.delegate`, `grant.principal`, `grant.screen`, `grant.model`), `grant.declassify`, `debug.attach`, `pod.admit`, and for durable workflows (§20.25) `workflow.enroll` (target `wf-…`, digest = SHA-256 of the JCS `EnrollRequest` JSON form `{"workflow", "definition": {"generation": <gen ref text>, "name", "digest": <digest text>}, "inputDigest": <digest text>, "scope": [<GrantRequest JSON forms>], "budgets": [{"unit", "amount"}], "resume": "manual" | "automatic", "runWhileLocked", "horizonSecs", "reason", "account"}`), `workflow.resume` (target `wf-…`) and `workflow.decide` (target the `ws-…` or `fx-…` the decision is about, digest = SHA-256 of the JCS question or resolution document). They are valid only in mandates, written only by `broker`, and never appear in manifests, command signatures, intents or `gate` intents.

**Required review details.** Approval of an effect requires that the trusted path presents at least these details of the exact payload (§7.3.4); a policy-registered kind's renderer declares its own, and a kind without a declaration requires the complete canonical payload:

| Kind | Required details |
|---|---|
| `email.send`, `message.send` | every recipient (to, cc, bcc), subject, complete body, attachment names, types and sizes |
| `http.*` | method, complete URL, request body (or its digest plus a complete canonical rendering for bodies over the channel limit) |
| `payment.authorize` | amount, currency, payee, mandate terms |
| `fs.merge` | the complete `keylos.fsmerge/2` manifest and the diff of every changed text file; binary changes by path, size and digest |
| `git.push`, `git.pr.open` | remote, refs (old → new), commits with titles; force flag |
| `publish.package`, `cloud.iam.change`, `db.write.prod`, `device.actuate` | target and the complete operation |
| `file.share`, `calendar.create`, `media.export`, `net.listen` | target (people, device or port and scope) and the object |
| `config.propose`, `config.apply` | the complete plan diff |
| `grant.*`, `debug.attach`, `pod.admit`, `grant.declassify` | resource, rights, duration, persistence, requesting principal and `onBehalfOf` |
| `workflow.enroll` | definition (name, version, generation, digest), every scope item as for `grant.*`, budget ceilings, resume policy (`automatic` stated as "runs again after restarts without asking"), `runWhileLocked`, horizon, the owner and the label the workflow starts with |
| `workflow.resume`, `workflow.decide` | workflow, definition, current step, the complete question or resolution document, and for `workflow.decide` on an effect the effect's own required details |

**Caller-executed effects.** For `media.export`, `device.actuate` and `config.propose`, `gate` stages, renders and decides the intent but does not perform it. A successful `Intent.commit` returns, in `IntentStatus.result`, the base64 delivered mandate (§14.4) bound to the payload digest, and `gate` writes `effect.commit` meaning "authorized". The executor (`bench` `MediaBrowser.export`/`ExportCompletion.finish`, the device's owning service, `config` for `propose`) MUST verify the mandate (owner-presence or `service/broker` signature, payload digest, expiry, single use) before acting, and writes its own completion receipt (`media.export` by `bench`). Stagers of `media.export` are `portal-files` and `atrium` on behalf of the requesting app. **Authorization is not completion**: an intent in `committed` state of a caller-executed kind, and an effect in `authorized` state (§20.26), say only that the effect may be performed; a workflow waits for the executor's authenticated completion (its receipt, `DurableEffects.complete`) before it treats the effect as done.

### 14.3 Approval tiers

| Tier | Covers | Interaction |
|---|---|---|
| T0 | Reads and overlay writes within grants | None, receipt only |
| T1 | Reversible egress to granted hosts | None; a classifier MAY escalate to T2/T3 |
| T2 | Compensable effects, new hosts, widening a sub-principal's scope | Batched review on the trusted path |
| T3 | Irreversible effects, declassification, budget overrun, merge of an agent overlay, config apply, seal, policy change | Synchronous trusted-path prompt with rendered effects and argument provenance. Presence (FIDO2 touch) is REQUIRED for config apply, seal, policy change, payment, persistent grants, and any effect whose policy says `presence` |

Rules:
- No automated component may lower a tier.
- A remote approval routed to a paired phone (`VouchLink.routeApproval`) or an org approval (`OrgDecider.decide`) MAY satisfy a T2/T3 approval only when the policy explicitly allows that channel for that effect kind, and **never** satisfies `requiresPresence`.
- **Channel selection.** The broker puts `"phone"` in `ApprovalPrompt.channels` only when the matching permit's `@channels` includes `phone` **and** a `vouchd` approver key is registered this boot (`registerApprover(…, "phone")`); `"org"` only for `@orgApproval` permits on fleet-enrolled machines. The mandate's `channel` records the channel that decided.
- **Family machines.** A non-owner human's request that needs an owner decision (config proposal, seal, persistent grant, policy change, install of an unreviewed app) becomes an approval prompt to the owners with `requester` set; it is shown on the next owner trusted-path session or routed to an owner's paired phone (never satisfying presence).
- **Quorum machines.** Wherever presence is required, a quorum presence envelope (§5.4) is required instead.
- **Headless machines without fleet.** On profiles without `atrium` that are not fleet-enrolled, every approval at T2 or above is escalated to a quorum presence request (`HearthQuorum.request`); there is no local trusted path. The resulting mandate has `channel: "quorum"`.
- **Guest sessions** never receive presence-class grants, agent sessions (unless `hearth.guest.agents` is true) or persistent grants.
- **Fail closed on rendering.** No channel may produce an approving decision for an effect whose required review details (§14.2) were not presented completely (§7.3.4). This holds for local prompts, presence cards, phone, org and quorum review alike; a channel that cannot present them leaves the approval pending for a capable channel, or it expires and is denied.
- **Org approver keys** come only from `/etc/keylos/fleet/approvers.json` (`keylos.fleetapprovers/1`, §20.23).
- **Durable decisions** (§20.25). An approval for a workflow is a durable decision record (`dr-…`) in the broker. Its prompt (`a-…`) is boot-local: a pending decision survives restarts and reboots and is presented again, with a new prompt ID, until it is decided or expires; `expires` is fixed when the decision is created (default 7 days, never beyond the workflow's horizon) and is never extended. Waiting never makes an earlier, incomplete rendering sufficient: each presentation needs the complete required material of that moment. A decided approval is used by a later attempt only through an explicit rebind (`BrokerWorkflow.rebind`), which re-checks current policy, revocation, expiry and presence; it never turns a historical approval into standing authority.

### 14.4 Mandates (`keylos.mandate/1`)

```json
{"schema":"keylos.mandate/1","approval":"a-…","principal":"…","tier":"t3",
 "effects":[{"kind":"email.send","target":"smtp:…","digest":"sha256:<payload digest>"}],
 "scope":"once","constraints":{"maxAmount":null,"expires":"…"},"decidedBy":"alice","presence":true,
 "channel":"local"}
```

- `channel`: `local` (atrium trusted path), `phone` (vouch), `org` (fleet approver), `quorum` (a quorum presence envelope, §5.4; `decidedBy` is `"quorum"`).
- `constraints.workflow` and `constraints.decision`: present exactly in mandates of durable decisions (§20.25): the `wf-…` the decision belongs to and its `dr-…`. A verifier acting for a workflow MUST require `constraints.workflow` to equal the effect's workflow; verifiers that do not know these members reject the mandate (unknown members, §5.1), so an older verifier fails closed.
- `constraints.channels`: the channels the broker allowed for this approval (§14.3, `ApprovalPrompt.channels`), a non-empty array of channel names without duplicates. The deciding `channel` MUST be one of them unless it is `quorum` (quorum presence replaces local presence on quorum machines).
- **Drafts.** `ApprovalPrompt.mandateDraft` is not a valid mandate: it carries placeholder `decidedBy` and `channel` values until the deciding channel fills them in and signs. Only a decided mandate is validated as `keylos.mandate/1`.
- **Extensions carry no authority.** `x-` members (§5.1) of a mandate are informational; no verifier may base an authorization decision on them.
- **Grant effects.** For a grant decision the broker writes one effect `{"kind": "grant.<k>", "target": <canonical resource string>, "digest": "sha256:" + SHA-256(JCS(R))}`, where R is the JSON form of the `GrantRequest`: `{"resource": {<union member>: v}, "rights": [Right enumerant names], "reason", "durationSecs", "persist", "onBehalfOf": <principal text or null>}`, with v = the text value for `path`, `device`, `secret`, `service`, `effect`, `screen`, `model` and `spawn`; `null` for `dirFd` and `delegate`; `{"host", "port", "proto", "methods"}` for `net`; `{"unit", "amount"}` for `budget`; `{"target", "scope"}` for `principal`. A service that asked for a confirmation through `requestFor` (vault: `grant.secret` with `{"secret": "<owner>/<name>"}`) verifies kind and digest.
- **Decision signatures** (inside the approval flow): presence-signed (§5.3) when `presence` is true; otherwise signed by the deciding channel's approver key: the atrium approver key or the `vouchd` phone key (both registered with `BrokerSystem.registerApprover`), or an `approver/<id>` key.
- **Mandates as delivered** (`Approval.mandate`, `GrantResult.mandate`): a presence-signed mandate is delivered as is; a non-presence mandate is re-signed by `service/broker` after the broker has verified the channel's decision signature. Relying services (gate, strata, bench, depot, devd) therefore verify only owner-presence keys (owner registry, via `HearthSystem.owners`) and the `service/broker` key (as registered with `ledger`, `Ledger.serviceKey`, §7.3.5); they never need approver keys.
- The `approval.decide` receipt carries `mandateDigest` (SHA-256 of the delivered mandate envelope).
- `gate` MUST NOT commit an irreversible intent without a mandate whose `effects[].digest` matches the intent payload digest.

### 14.5 Operating rules

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.


### A.20 protocols §19.2 — Facets served by strata and facets strata holds

> Verbatim copy of `protocols/spec.md` lines 3783–3786, 3791, 3798–3803, 3813, 3822, 3825, 3827, 3830, 3861–3871, 3879, 3882, 3888, 3905 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| strata | `user` | `shell`, apps with the route, kish | `begin`, `snapshot`/`snapshots`/`restore`/`undo` (own), `why`, `createUnit` (own home subtree); `StrataTxn` |
| strata | `cli` | the strata CLI under `shell` | as `user`, plus `forget` (own units, presence) |
| strata | `bench` | bench | `begin`; `StrataTxn` (including `preparedFor`); `TransactionExt.bindWorkflow` |
| strata | `aide` | aide | `begin`; `StrataTxn` (including `preparedFor`); `TransactionExt.bindWorkflow` |
| strata | `compat` | compat | `createUnit`, `forget` for `app/*` units of legacy apps |
| strata | `warden` | warden | `StrataAdmin.mountUnit` (lazy creation of app units); `StrataTxn` (to mount `SpawnSpec.transaction` views after the owner check) |
| strata | `hearth` | hearth | `StrataHomes`; `StrataAdmin.lockUnits`/`unlockUnits` |
| strata | `courier` | courier | `StrataAdmin.preUpdate` |
| strata | `gate` | gate | `Strata.undo` (fs.merge compensation only) |
| strata | `cri` | cri | `StrataVolumes` |
| strata | `admin` | config, owner `shell` | all; `StrataAdmin` |

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| warden | `client` | every principal | `Supervisor.spawn` (child of caller's session), `identify` |
| warden | `service` | tier-0 services | `Supervisor.spawn`, `identify`, `connectionInfo`; `FdStore`. `SpawnSpec.attempt` only from `loom` |
| warden | `strata` | strata | `PrincipalControl.events`, `mountView`, `fenceWriters` (`WriterFence`) |
| broker | `principal` | every principal | `Broker` |
| broker | `system` | warden, gate, aide, atrium, config, hearth, strata, net, depot, vault, vouch, cri | `BrokerSystem` (per-method callers as commented in §7.5.2; `requestFor` with the allowed-subject rule, atrium only for its own session (device authorization); `registerApprover`: atrium, vouch; `admitPod`: cri; `mintCaptive`: net); `Broker.inspect` |
| broker | `label-authority` | gate, bench, portal-*, atrium, strata, aide, journal, warden | `LabelAuthority` |
| broker | `workflow` | loom, gate, aide, strata, bench | `BrokerWorkflow` (§7.5.25): `enroll`, `claim`, `decide`, `rebind`, `resume`, `cancel`, `cancelDecision`, `record`, `raise`: loom; `authorizeEffect`, `verify`, `record`, `cancelDecision`: gate; `offer`, `verify`, `decide`, `rebind`: aide (its agent attempts); `verify`, `record`: strata, bench |
| ledger | `writer` | tier-0 services listed as writers in §19.3 | `Ledger` (all) |
| ledger | `reader` | every principal | `Ledger` except `append` (filtered, §7.3.5) |
| vault | `strata` | strata | `dataKey`, `forget` |
| hearth | `presence` | broker, config, depot, courier, ledger, vault, aide, strata | `presence`; `HearthQuorum.request`/`collect` |
| hearth | `system` | warden, devd, config, broker, gate, vouch, strata, bench, depot, ledger, loom | `HearthSystem` (gate, vouch, strata, bench, depot, ledger: `owners` only; loom: `owners`, `userState`, `watchUsers`) |
| hearth | `tpm` | courier, vault, strata, ledger, config, vouch, fleet | `HearthTpm` (`defineSpace`, `recreateKey`: the object's registered owner; `sbSign`, `sbAccepted`: courier; `activateCredential`: vouch, fleet) |
| gate | `client` | principals with net needs, portal-files, atrium (staging `media.export`) | `connect`, `stage` (own session), `intents` (own session tree, recursive), `intent` (own session tree), `meter` (own roots); `DurableEffects.prepare`, `complete`, `lookup`, `watch` (attempt sessions, own workflow) |
| devd | `client` | every principal | `list`, `watch` (filtered); `PowerEvents.subscribe` |
| devd | `service` | hearth, strata, atrium, portal-inhibit | `PowerEvents` (subscribe + ack) |
| journal | `client` | every principal | `writer`, `query`/`follow` (own), `Crashes` (own human), `Metrics` (own) |
| atrium | `notify` | tier-0 services, portal-notify | `TrustedPrompt.notify` |


### A.21 protocols §19.6 — TPM objects

> Verbatim copy of `protocols/spec.md` lines 4040–4120 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 19.6 TPM objects

All keylos NV indices live in the owner-hierarchy NV range block **0x01300100–0x013001FF**.

**Common NV attributes.** Every keylos NV index has `TPMA_NV_OWNERREAD | TPMA_NV_AUTHREAD | TPMA_NV_POLICYREAD`, `TPMA_NV_NO_DA` unless stated otherwise, and `TPMA_NV_PLATFORMCREATE` clear. Its authPolicy is `PolicyOR{PolicyCommandCode(TPM2_CC_NV_Read), <write policy>}` where the index has a write policy, else `PolicyCommandCode(TPM2_CC_NV_Read)` alone, so **anyone with TPM access can read** counters, floors and heads (their contents are integrity-relevant, not secret) while writes stay controlled. Exception: the two `vault-epoch` indices are secret: `AUTHREAD | AUTHWRITE | NO_DA`, `OWNERREAD` and `POLICYREAD` clear, and an **empty authPolicy**, so every read and write needs the index's authValue, which is sealed like the others (PCR11 `ready` ∧ PCR15). Services that write an index hold its authValue as a TPM-sealed secret (`/var/lib/keylos/tpm/nv-auth/0x<8 lowercase hex>.sealed`, §10.7) bound to the signed PCR11 `ready` phase and PCR15 (volume identity).

**Sealed secrets.** Every secret this section calls "sealed to PCR11 `ready` ∧ PCR15" (NV authValue files, hierarchy blobs, service keys, quorum seal-gate blobs, the vault system key) is a keyedHash **sealed data object** created under the SRK `0x81000001`: nameAlg SHA-256; attributes `fixedTPM | fixedParent | adminWithPolicy | noDA`, with `userWithAuth` and `sensitiveDataOrigin` clear; empty authValue; the secret as sensitive data. It is stored as `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` (each marshalled with its size prefix).
- **Production authPolicy:** `PolicyAuthorize(release-stream PCR11 key, the signed policy for phase "ready")` followed by `PolicyPCR(sha256:{15})`; the approved policy the release key signs is `PolicyPCR(sha256:{11})` at the `ready` value (§20.6).
- **Development fallback:** `PolicyPCR(sha256:{15})` alone, used only by development builds where no signed PCR11 policy exists. Readers identify the variant by comparing the object's authPolicy with both digests; production builds accept only the production digest.

NV authValue files are written by the installer at genesis, by `hearth` whenever it (re)defines an index (`HearthTpm.defineSpace`, §7.5.3), and by `rescue`; each is read only by the index's registered owner.

**Hierarchy authorization.**
- **Owner hierarchy:** set at install to a random 32-byte value, stored as a TPM-sealed blob for `hearth` (PCR11 `ready` ∧ PCR15, `/var/lib/keylos/tpm/hierarchy-owner.sealed`) and, for recovery, as an HPKE ciphertext to the recovery recipient (`hierarchy-owner.recovery`, §20.21); `hearth` rewrites both when it rotates the value. `hearth` is the sole userspace holder of owner-hierarchy operations and exposes the needed ones through `HearthTpm` (§7.5.3). `boot` reads NV in the initrd through the `PolicyCommandCode(NV_Read)` branch; it never needs owner auth.
- **Endorsement hierarchy:** set to a random value sealed like the owner auth (used only for AK/AK0 provisioning).
- **Lockout:** random value derived as HKDF-SHA256(recovery key, "keylos-lockout/1"); only the recovery environment uses it.

| NV index | Name | Type and size | Write authorization | Owner |
|---|---|---|---|---|
| `0x01300100` | ledger-counter | counter | AUTHWRITE, authValue sealed to `ledger` | ledger |
| `0x01300101` | config-counter | counter | AUTHWRITE, authValue sealed to `config` | config (read by boot) |
| `0x01300102` | os-floor | ordinary, 8 bytes, u64 big-endian (minimum bootable release `seq`); `POLICYWRITE`, empty authValue (public reads, including `PolicyNV`) | `PolicyAuthorize(release-stream key, policyRef "keylos/floor-write/1")` over **exact-target** approved policies ("Floor writes" below) | courier, installer (read by boot) |
| `0x01300103` | pcrlock-policy | ordinary, 34 bytes (TPM2B_DIGEST) | `PolicyAuthorize(release-stream key, "keylos/pcrlock-write/1")` or `PolicySecret(recovery auth object 0x81000105)`; the index authPolicy is the **flat** `PolicyOR{PolicyCommandCode(NV_Read), PolicyAuthorize(…), PolicySecret(…)}` (never nested) | courier, boot (recovery) |
| `0x01300104` | keystore-floor | counter | AUTHWRITE, authValue sealed to `vault` | vault |
| `0x01300105` | owner-registry-head | ordinary, 104 bytes: SHA-256(last registry line) ‖ u64 BE seq ‖ SHA-256(JCS owner-presence key set) ‖ SHA-256(JCS owner Secure Boot certificate set) | AUTHWRITE, authValue sealed to `hearth` (installer at genesis) | hearth (read by boot) |
| `0x01300106` | login-failure-counter | counter | AUTHWRITE, authValue sealed to `hearth` | hearth |
| `0x01300107` | strata-anchor-counter | counter | AUTHWRITE, authValue sealed to `strata` | strata |
| `0x01300108` | attestation-key-names | ordinary, 68 bytes: Name(AK) ‖ Name(AK0) | owner authorization at enrolment | installer, boot (read by vouch tooling) |
| `0x01300110` | vault-epoch/0 | ordinary, 40 bytes: epoch key (32) ‖ u64 BE epoch; an all-zero key means erased | authValue (`AUTHREAD | AUTHWRITE`, empty authPolicy; authValue sealed to PCR11 `ready` ∧ PCR15 in `nv-auth/0x01300110.sealed`) | vault |
| `0x01300111` | vault-epoch/1 | same as vault-epoch/0; the two alternate as active and candidate index (vault §4.5.1) | authValue (as vault-epoch/0, `nv-auth/0x01300111.sealed`) | vault |
| `0x01300140 + i` (i < 16) | seal-gate/i | ordinary, 1 byte, used for its authValue; common attributes (`OWNERREAD`, `AUTHREAD`, `POLICYREAD`) plus `POLICYWRITE`; NO_DA **not** set. authPolicy = `PolicyOR{PolicyCommandCode(NV_Read), PolicyCommandCode(NV_ChangeAuth) ∧ PolicyAuthValue}` | `PolicyCommandCode(NV_ChangeAuth) ∧ PolicyAuthValue` | hearth |

**Seal-gate salts.** The FIDO2 `hmac-secret` salts for owner *i*'s window *k* are `s_k = SHA-256("keylos-seal" ‖ u64_be(k))` (k encoded as 8 bytes, big-endian), and the assertion carries `(s_k, s_{k+1})`. On **quorum** machines (§5.4) the next authValue is held in a TPM-sealed blob `/var/lib/keylos/hearth/seal-gate-<i>.sealed` (PCR11 `ready` ∧ PCR15) and released by `hearth` only after a verified quorum envelope of purpose `seal.window`.

**Changing a seal gate's authValue.** `TPM2_NV_ChangeAuth` under the gate's policy and "undefine, then define again with the identical template and the new authValue" (owner authorization, after proving the current authValue) are equivalent: the NV Name excludes the authValue and a gate is never written, so its Name, and every `PolicySecret` binding to it, is unchanged. With the second method `hearth` seals the new authValue durably before the undefine, and a start that finds a registered gate absent defines it again with that pending value.

**Floor writes.** For every UKI it releases, the release stream signs exactly one approved policy for `keylos/floor-write/1`, bound to that UKI's measured PCR11 value and to exactly one target value *F*:
- OS UKI (phase `ready`): `PolicyPCR(sha256:{11})` ∧ `PolicyNV(0x01300102, operand u64_be(F), offset 0, TPM_EO_UNSIGNED_LE)` (current floor ≤ *F*) ∧ `PolicyCpHash(TPM2_NV_Write(authHandle 0x01300102, nvIndex 0x01300102, data u64_be(F), offset 0))`, with *F* = the release's `floor` (§20.6).
- Installer UKI and the cloud UKI's `seed` profile: `PolicyPCR(sha256:{11})` ∧ `PolicyNvWritten(NO)` ∧ `PolicyCpHash(…write F…)`: initialisation of a freshly defined index only.
Two releases MUST NOT carry different *F* for the same UKI digest. In one measured boot only one target is therefore writable: concurrent or stale policy sessions can only write the same *F*, an older release's policy does not match PCR11, and a write never lowers the floor because `PolicyNV` refuses it when the current value exceeds *F* (the guarantee assumes the release-stream key is not compromised). The value written is exactly *F*, never an intermediate one; a lost acknowledgment is answered by writing *F* again. A missing or unreadable `os-floor` after provisioning (TPM clear, interrupted write) is a recovery and re-enrolment condition, never silently reconstructed: the recovery environment defines the index again and initialises it with the floor of the signed release statement of the release being re-enrolled, and reports that hardware floor history was lost.

| Persistent handle | Hierarchy | Object | Registered owner |
|---|---|---|---|
| `0x81000001` | owner | SRK (ECC P-256, TCG standard template); its public key is pinned at enrolment | hearth (installer at genesis) |
| `0x81000101` | owner | Owner Secure Boot KEK signer (RSA-2048). Policy: with one owner, `PolicySecret(seal-gate/0)`; with two or more, `PolicyOR` over `PolicySecret(seal-gate/i)` of the enrolled owners (`PolicyOR` needs ≥ 2 branches). Adding or removing an owner re-creates both signers and re-enrols them in firmware (documented ceremony) | hearth (installer at genesis) |
| `0x81000102` | owner | Owner Secure Boot db signer (RSA-2048); same policy | hearth (installer at genesis) |
| `0x81000103` | owner | First-boot vault seed key: ECC P-256 decrypt key for HPKE DHKEM(P-256, HKDF-SHA256) (§4), sealed to the boot policy; evicted at first boot (`HearthTpm.evict`) | vault (`evict` only) |
| `0x81000105` | owner | Recovery auth object; authValue = HKDF-SHA256(recovery key, "keylos-recovery-auth/1") | hearth (installer at genesis) |
| `0x81000110` | owner | strata anchor HMAC key; policy `PolicyPCR(15) ∧ PolicyNV(0x01300107 ≥ 1)` | strata |
| `0x81000120` | owner | fleet device key (fleet-enrolled machines) | fleet |
| `0x81000140 + i` | owner | owner-seal/i (ECDSA P-256 signing; `userWithAuth` clear; policy `PolicySecret(0x01300140 + i)`) | hearth (installer at genesis) |
| `0x81010002` | endorsement | AK: restricted signing ECC P-256; runtime attestation (vouch, fleet, cluster join) | hearth (installer at genesis) |
| `0x81010003` | endorsement | AK0: restricted signing ECC P-256; pre-unlock VBU quotes (§20.5) | hearth (installer at genesis) |
| `0x81000180`–`0x81000183` | owner | Reserved staging handles for re-creating the owner Secure Boot KEK/db signers (`0x81000101`/`0x81000102`) when the owner set changes; empty outside that ceremony | hearth (installer at genesis) |

Only the registered owner of a handle may call `HearthTpm.recreateKey` (or, for `0x81000103`, `evict`) for it.

**AK and AK0 attributes:** `fixedTPM`, `fixedParent`, `sensitiveDataOrigin`, `userWithAuth`, `restricted`, `sign` set; `adminWithPolicy` clear; empty authValue; empty authPolicy (credential activation with the EK requires the admin role through the empty authValue). Quotes carry the PCR values; no PCR binding of the key is needed.

PCR usage (normative for boot, courier, vouch, fleet, cri):

| PCR | Content |
|---|---|
| 0–7 | Firmware, option ROMs, Secure Boot state (pcrlock policy, NV `0x01300103`) |
| 11 | UKI sections and boot phases; signed PCR11 policy |
| 12 | Kernel command line and credentials |
| 13 | System extensions (none in keylos; MUST be the "no extension" value; `kmod` generations are not system extensions) |
| 14 | shim/MOK state (shim fallback mode only) |
| 15 | Volume identity (LUKS volume key hash), extended by the initrd after unlock |

**PCR11 phases, in order** (each extended exactly once per boot by the named component):

| Phase | Extended by | When |
|---|---|---|
| `enter-initrd` | boot (`kl-initrd`, its first action) | before any other initrd step. systemd-stub measures the UKI sections into PCR11 but extends no phase string |
| `leave-initrd` | boot | after unlock, PCR15 extension, trust-set write and kl-exec load; immediately before `switch_root`. The disk-unseal policy is bound to `enter-initrd`, so the disk key is unavailable afterwards |
| `sysinit` | warden | after mounting `/var`, `/home`, `/store`, `/keystore` and taking over the kl-exec maps |
| `ready` | warden | immediately **before** starting the first tier-0 service (ledger and journal included). Secrets sealed to `ready` (service keys, NV authValues, hearth's hierarchy auth) are therefore available to tier-0 services and to nothing launched before this point |
| `enter-recovery` | boot | instead of `leave-initrd`, in the recovery profile; nothing sealed to `ready` is available afterwards |

No component extends PCR11 after `ready`.


### A.22 protocols §20.1, §20.3, §20.12 — Boot trust set, owner registry, merge manifest

> Verbatim copy of `protocols/spec.md` lines 4126–4158, 4181–4213, 4350–4367 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 20.1 Boot trust set and boot report

`/run/keylos/boot/trust.json` (mode 0444, JCS), written by `boot` before `switch_root`:

```json
{"schema":"keylos.boottrust/1","stream":"stable","seq":4211,
 "osGen":"gen:fsv256:…","configGen":"gen:fsv256:…","safeConfig":false,
 "keys":{
   "releaseStream":["key:sha256:…"],
   "ownerPresence":["key:sha256:…"],
   "ownerSeal":["key:sha256:…"],
   "publishers":["key:sha256:…"]},
 "spki":{"key:sha256:…":"<base64 DER>"},
 "revocationsSerial":1234,
 "bootstrapGens":{"journal":"gen:fsv256:…","ledger":"gen:fsv256:…","depot":"gen:fsv256:…"},
 "featureLevel":"KL2"}
```

- `releaseStream`: keys from the UKI (subscribed streams).
- `ownerPresence`: from the owner registry anchored in NV `0x01300105`.
- `ownerSeal`: from `/etc/keylos/owner-seal/*.spki` in the verified config generation.
- `publishers`: from `/etc/keylos/publishers.json` in the verified config generation. Adding a publisher therefore takes effect at the next boot.
- `bootstrapGens`: from `/etc/keylos/services.json`; `warden` mounts them itself before `depot` runs.

`/run/keylos/boot/report.json` (also passed to `warden` as fd 8; fds 3–7 are the kl-exec maps, §9.3):

```json
{"schema":"keylos.bootreport/1","timingsMs":{"initrd":412,"vbu":0,"pin":2910,"unseal":180,"mount":95},
 "vbu":"verified|skipped|not-enrolled","pcr11Phase":"leave-initrd","profile":"default",
 "unlock":"tpm2+pin|recovery","volumeIdentity":"ok","configCounter":57,"floor":4200,
 "secureBoot":"owner|shim|off","safeConfig":false,"integrity":"full",
 "dmaProtection":"firmware-declared|none","iommu":"active|none-virtual|none"}
```

### 20.3 Owner registry

`/var/lib/keylos/hearth/owners.log`: JSON Lines; each line is a DSSE envelope of `keylos.owners-entry/1`, presence-signed:

```json
{"schema":"keylos.owners-entry/1","seq":3,"prev":"sha256:<digest of previous envelope line bytes>","time":"…",
 "op":"enroll-credential","owner":"alice","ownerIndex":0,
 "credential":{"keyid":"key:sha256:…","cose":"<base64>","credentialId":"<base64>","label":"Spare key","aaguid":"…",
               "assisted":false,"seal":true},
 "sealKey":"<base64 SPKI DER of owner-seal/<ownerIndex>, on add-owner and genesis>",
 "secureBootCert":null,
 "policy":{"mode":"touch","quorum":1,"threshold":1}}
```

| `op` | Meaning | Signed by |
|---|---|---|
| `genesis` | First entry (installer): first owner, credentials, `recoverySigner` (Ed25519 key derived from the recovery key) | the new credentials |
| `add-owner`, `remove-owner` | Owner set changes | `policy.quorum` existing owners |
| `enroll-credential`, `remove-credential` | Credential changes | an existing credential of the same owner (or quorum) |
| `set-secureboot-certs` | Owner Secure Boot certificate set | quorum |
| `set-quorum` | Change `policy` (`mode` `touch`/`quorum`, `quorum` for owner-set changes, `threshold` for quorum presence) | the current `policy.quorum` owners |
| `recover` | Re-anchor after recovery | `recoverySigner` |

Fields:
- `ownerIndex` (0–15) selects the owner's seal gate `0x01300140 + ownerIndex` and owner-seal key `0x81000140 + ownerIndex`; assigned at `genesis`/`add-owner` and never reused while the owner exists.
- `sealKey`: SPKI of the owner's owner-seal key; `config` copies it to `/etc/keylos/owner-seal/<ownerIndex>.spki`.
- `credential.seal: true` marks the credential whose `hmac-secret` drives the owner's seal gate (`sealCredential`); exactly one per owner on `touch` machines.
- `credential.assisted: true` marks an assisted platform authenticator (§5.3).
- `policy.mode = "quorum"` switches the machine to quorum presence (§5.4) with `policy.threshold` distinct owners.
- `recoverySigner` (genesis and `recover` entries): `{"keyid": "key:sha256:…", "spki": "<base64 SPKI DER of the Ed25519 key>"}`.
- `HearthAdmin.setQuorumPolicy` appends a `set-quorum` entry; `policy.quorum` is a single number used for both adding and removing owners.

The NV head (`0x01300105`) is updated after every append. Verifiers replay the log from genesis and require the computed head to equal the NV value. `keylos.owners/1` is the export form: `{"schema", "entries": [<envelopes>], "head", "seq"}`.

### 20.12 Merge manifest (`keylos.fsmerge/2`)

```json
{"schema":"keylos.fsmerge/2","prepared":"pm-…","session":"s-…","share":"project",
 "targets":["/home/alice/src/proj"],"base":"snap-…","source":"snap-…",
 "changes":[{"target":0,"path":"src/main.rs","kind":"modified","expectedLive":"sha256:…","afterDigest":"sha256:…","mode":"0644","size":1834},
            {"target":0,"path":"README.md","kind":"added","expectedLive":"absent","afterDigest":"sha256:…","mode":"0644","size":210}]}
```

The manifest of a **prepared merge** (`TransactionExt.prepare`, §7.5.7), an immutable object that stores the exact result to be applied: conflicts are resolved and automatic three-way merges are done **before** the manifest exists. `BenchMerge.manifest` returns it for bench shares, and `strata` for every other merge. Its SHA-256 over the JCS is the payload digest of the `fs.merge` intent and is bound by the mandate; the rendered diff is derived from the same object.

- `share` is the bench share name or `null`; `targets` are the canonical live directories; `base` is the transaction's base snapshot, `source` the frozen snapshot of the working view the result was prepared from.
- `changes` is sorted by (`target`, `path` bytes) without duplicates. `kind` ∈ `added`, `modified`, `deleted`, `renamed` (with `from`), `meta`. `expectedLive` is the content digest the live path must still have at commit, or `"absent"` (required for `added`; every other kind needs a digest). `target` is the index of the change's entry in `targets`. `afterDigest` is `null` exactly for `deleted`; `mode` (4 octal digits) and `size` are required except for `deleted`.
- **Commit** (`PreparedMerge.commit`): the mandate's effect digest MUST equal the manifest digest; `strata` takes a writer fence (`PrincipalControl.fenceWriters`), checks every `expectedLive`, and applies exactly the stored operations. It never merges again and never reads the working view; a stale precondition fails `kl:conflict`, and a different result needs a new prepared merge and a new approval.

`keylos.fsmerge/1` (`{"schema":"keylos.fsmerge/1","session","share","base","snapshot","changes":[{path, kind, beforeDigest, afterDigest, mode, size}]}`) is superseded: it remains parseable, but no mandate is bound to it.

**Trust boundary.** `strata` holds the prepared object and enforces the commit rules above for every origin; `bench` maps its share manifests to the prepared object and calls its `commit`.


### A.23 protocols §2.3, §21.6 — Resource classes and cluster-node storage

> Verbatim copy of `protocols/spec.md` lines 96–106, 4759–4764 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 2.3 Resource classes

`bench` admission control and memory tuning follow the machine's **RAM class** (detected at boot, overridable in config):

| RAM | Class | Max concurrent VMs (workbench, agent, tier-2, media, pod) | Defaults |
|---|---|---|---|
| < 12 GiB | `small` | 2 | zram swap (ephemeral key), KSM on, compressed snapshots, agents queue |
| 12–24 GiB | `medium` | 6 | KSM on, free-page reporting |
| > 24 GiB | `large` | 16 | free-page reporting |

`server-k8s` nodes are exempt from the VM cap for pod VMs; kubelet `maxPods` bounds them instead. When the cap is reached, new agent sessions queue (`aide`), and other VM requests fail with `kl:unavailable`.

### 21.6 Storage

- `emptyDir` and local PersistentVolumes are `strata` subvolumes (`StrataVolumes`, §7.5.7); `configMap`, `secret`, `projected` and `downwardAPI` volumes are tmpfs filled by `cri` (Kubernetes secrets arrive from the API server and are never stored in `vault`).
- NFS, iSCSI and RBD volumes are mounted **inside pod VMs only** (`keylos-vm`).
- CSI drivers are supported only as `container` generations declaring `needs.csi`; their node plugins run in a pod VM, and block devices reach them through `MediaAttach.claimBlock` (devd facet `cri`).
- `hostPath` is denied by default policy except a read-only allowlist.


### A.24 protocols §7.3.12, §7.5.3 — hearth.capnp and hearth-sys.capnp (consumed: presence, owners, HearthTpm)

> Verbatim copy of `protocols/spec.md` lines 1170–1194, 1829–1903 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.12 `hearth.capnp`

```capnp
@0xc7a1e5d3b2f40012;
using C = import "common.capnp";

struct UserInfo { name @0 :Text; displayName @1 :Text; uid @2 :UInt32; owner @3 :Bool; locked @4 :Bool; }

interface Hearth {
  users     @0 () -> (list :List(UserInfo));
  login     @1 (user :Text, method :Text, response :Data) -> (session :C.SessionId);   # facet greeter
      #! methods: "password", "pin", "fido2"; "guest" (user and response empty: creates an ephemeral guest-… user and
      #! session, §3.3, §14.3); "kiosk" (kiosk profile only: autologin of the configured kiosk user, response empty)
  lock      @2 (session :C.SessionId) -> ();
  unlock    @3 (session :C.SessionId, method :Text, response :Data) -> ();
  presence  @4 (purpose :Text, payload :Data, assist :Data) -> (envelope :Data);   # FIDO2 assertion → DSSE presence envelope (§5.3)
      #! assist (facet atrium only): PIN or switch-access confirmation collected on the trusted path for an assisted
      #! platform authenticator (§5.3); empty for roaming authenticators and on every other facet
  enrollKey @5 (user :Text, kind :Text) -> (keyRef :Text);           # requires presence of an existing owner credential
  removeKey @6 (keyRef :Text) -> ();
}
```

- **Assisted presence.** The prompt id that binds an `assist` confirmation to its request is `sha256:<hex>` of the DSSE PAE of `payload`; atrium and hearth compute it independently.
- **`enrollKey`** of a kind that adds a vault slot (`fido2` login keys) requires the target user's vault key to be unlocked (`VaultUsers.addSlot`, §7.5.4) and fails `kl:unavailable:user-locked` until that user has logged in.

#### 7.5.3 `hearth-sys.capnp`

```capnp
@0xc7a1e5d3b2f40022;
using C = import "common.capnp";

interface HearthSystem {           # facet system
  validateSession @0 (session :C.SessionId) -> (user :Text, authenticatedAt :C.Timestamp, methods :List(Text), locked :Bool);
  owners          @1 () -> (registryJson :Text);            # keylos.owners/1 (§20.3)
  prepareSuspend  @2 () -> ();                              # devd before suspend; returns within 2 s
  resumed         @3 () -> ();
  exportPasswd    @4 () -> (passwd :Text, group :Text);     # for legacy views
  userState       @5 (user :Text) -> (locked :Bool, since :C.Timestamp);
      #! locked = the user has no authenticated, unlocked login session (logged out counts as locked); loom only
  watchUsers      @6 (watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);
      #! JCS {"user", "locked", "since", "deleted"} for every change of userState of any user and for user deletion; loom only
}

interface HearthSeal {             # facets seal (depot, forge)
  openWindow  @0 (windowJson :Text) -> (windowId :Text, presenceEnvelope :Data);   # keylos.seal-window/1 (§20.4); touch on trusted path
  sealSign    @1 (windowId :Text, statementJson :Text) -> (signature :Data, keyRef :Text);   # ECDSA P-256 DER by owner-seal/<i>
      #! any facet-seal holder may sign within a window another holder opened;
      #! statementJson MUST be keylos.seal/1 or keylos.genstmt/1 and its drv MUST be in the window's drvs, else kl:denied
  closeWindow @2 (windowId :Text) -> ();
}

interface HearthTpm {              # facet tpm (courier, vault, strata, ledger, config; vouch and fleet: activateCredential only)
  defineSpace @0 (index :UInt32) -> ();
      #! (re)defines an NV index listed in §19.6 with exactly its registry template; only the index's registered owner may call
  evict       @1 (handle :UInt32) -> ();
      #! evicts a persistent handle listed in §19.6 (e.g. 0x81000103 after first boot); presence required except for 0x81000103
  sbSign      @2 (which :Text, payload :Data, presenceEnvelope :Data) -> (signature :Data);
      #! which = "kek" | "db": signs an authenticated-variable update (PKCS#7 payload digest) with 0x81000101 / 0x81000102
      #! behind the seal gate; presenceEnvelope purpose "boot.sb-sign" covering SHA-256(payload); caller courier
  activateCredential @3 (akHandle :UInt32, credentialBlob :Data, encryptedSecret :Data) -> (secret :Data);
      #! TPM2_ActivateCredential with the EK (endorsement auth held by hearth) for AK 0x81010002 or AK0 0x81010003;
      #! used by vouch pairing and fleet enrolment to prove the AK lives in this TPM
  recreateKey        @4 (handle :UInt32, presenceEnvelope :Data) -> ();
      #! re-creates a persistent key listed in §19.6 from its registry template after a TPM clear or loss (e.g. the strata
      #! anchor HMAC key 0x81000110); only the key's registered owner may call; presence purpose "boot.recreate-key"
  sbAccepted         @5 (kekCert :C.Digest, dbCert :C.Digest) -> ();
      #! courier only: the firmware KEK and db variables (read back at boot) contain the new owner certificates with these
      #! SHA-256 digests; hearth then swaps the staged signers onto 0x81000101/0x81000102 (kl:conflict if nothing is staged)
}

interface HearthQuorum {           # facets presence (request, collect), quorum (submit: fleet), admin (list)
  request @0 (purpose :Text, payload :Data, rendering :List(Text)) -> (requestId :Text, requestEnvelope :Data);
      #! creates a keylos.quorum/1 request (§20.18), signed by service/hearth with its ledger key chain; expires ≤ 24 h
  submit  @1 (requestId :Text, signedEnvelope :Data) -> (have :UInt8, need :UInt8);
      #! adds approver signatures (each a §5.3 signature over the request's payload PAE) after verifying them
  collect @2 (requestId :Text) -> (envelope :Data);   #! kl:needs-approval until ≥ threshold distinct owners have signed
  list    @3 () -> (json :Text);
}

interface HearthFleet {            # facet fleet-lock (fleet)
  lockAll @0 (commandEnvelope :Data) -> ();
      #! verified keylos.fleet.command/1 "lock": locks every session, revokes every agent session (kill), requires owner unlock
}

interface HearthAdmin {            # facet admin
  createUser  @0 (name :Text, displayName :Text, owner :Bool) -> (uid :UInt32);   # presence
  disableUser @1 (name :Text, disabled :Bool) -> ();                                # presence
  deleteUser  @2 (name :Text, forgetData :Bool) -> ();                              # presence
  setPassword @3 (name :Text, secret :C.Fd) -> ();
  addOwner    @4 (name :Text) -> ();                                                # presence (quorum)
  removeOwner @5 (name :Text) -> ();
  setQuorum   @6 (addOwner :UInt8, remove :UInt8) -> ();   #! superseded before release: MUST return kl:unsupported
  registry    @7 () -> (json :Text);
  setQuorumPolicy @8 (mode :Text, quorum :UInt8, threshold :UInt8) -> ();
      #! appends a set-quorum owner-registry entry (§20.3): mode "touch" | "quorum"; quorum = owners required for
      #! owner-set changes; threshold = distinct owners for quorum presence (mode quorum)
}
```

**NV definition after genesis.** Once `hearth` holds the owner hierarchy authorization (installer genesis), every service that needs one of its registered NV indices (re)created obtains it through `HearthTpm.defineSpace`; no other service uses owner authorization. `defineSpace` defines the index from its registry template, generates a fresh authValue, and writes the sealed authValue file `nv-auth/0x<index>.sealed` (§19.6) before returning. `HearthQuorum` on facet `admin` serves `collect` and `list`; each `list` entry includes `requestEnvelope` (standard base64).


### A.25 protocols §7.5.25 — loom-sys.capnp (consumed: BrokerWorkflow.verify, record)

> Verbatim copy of `protocols/spec.md` lines 2659–2824 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.5.25 `loom-sys.capnp`

The system contracts of durable execution (§20.25, §20.26): durable effects and workflow budget accounts (gate), workflow records, claims and durable decisions (broker), agent attempts (aide) and attempt observations (loom).

```capnp
@0xc7a1e5d3b2f40039;
using C = import "common.capnp";
using B = import "broker.capnp";
using G = import "gate.capnp";
using P = import "prompt.capnp";
using L = import "loom.capnp";

enum RetryStrategy { transactional @0; downstreamIdempotency @1; reconciliation @2; noSafeRetry @3; }   #! §20.26

enum EffectState {                #! §20.26: authorized is not completion; only succeeded/failed are confirmed outcomes
  prepared @0; awaitingApproval @1; authorized @2; dispatching @3;
  succeeded @4; failed @5; outcomeUnknown @6; cancelled @7; compensated @8;
}

struct EffectSpec {
  effect  @0 :Text;                # fx-… from AttemptHost.effect
  binding @1 :C.AttemptBinding;    # the preparing attempt; MUST match the token's workflow fact (§8.2)
  intent  @2 :G.EffectIntent;      # kind, class, target, args, payload; idempotencyKey MUST be empty (the effect id is the key)
}

struct EffectRecord {
  effect        @0 :Text;            # fx-…
  workflow      @1 :Text;            # wf-…: the owner of the effect (never a session)
  state         @2 :EffectState;
  strategy      @3 :RetryStrategy;   #! declared by the executor, fixed at prepare (§20.26)
  kind          @4 :Text;
  target        @5 :Text;
  requestDigest @6 :C.Digest;        #! §20.26; a later prepare with the same effect id and another digest: kl:conflict
  payloadDigest @7 :C.Digest;
  decision      @8 :Text;            # dr-… when an approval was required
  intent        @9 :Text;            # e-… of gate's outbox intent
  epoch         @10 :UInt64;         # ownership epoch that last authorized or dispatched it
  dispatched    @11 :C.Timestamp;
  dedupUntil    @12 :C.Timestamp;    # end of the destination's deduplication window (downstreamIdempotency); 0 otherwise
  outcome       @13 :Text;           # JCS: executor result (succeeded, failed) or the reason (outcomeUnknown)
  receipts      @14 :List(Text);     # rcpt refs of the authorization and completion receipts
  retainUntil   @15 :C.Timestamp;    #! the dedup record is kept at least until then (§20.26)
}

interface DurableEffects {         # gate; facets client and aide: prepare, complete, lookup, watch; facet loom: all except prepare
  prepare   @0 (spec :EffectSpec, token :C.Token) -> (record :EffectRecord);
      #! stages the effect for its workflow (the token's principal is the attempt session); durable before return; idempotent
      #! per effect id with an equal request digest; a stale epoch: kl:conflict
  commit    @1 (effect :Text, binding :C.AttemptBinding) -> (record :EffectRecord);
      #! facet loom: authorizes with BrokerWorkflow.authorizeEffect (current policy, durable decision) and dispatches per strategy;
      #! returns the record when it is awaitingApproval, has a confirmed outcome, or is outcomeUnknown
  complete  @2 (effect :Text, receipt :Text) -> (record :EffectRecord);
      #! caller-executed kinds (§14.2): the executor's completion receipt (rcpt ref) is the authenticated outcome
  lookup    @3 (effect :Text) -> (record :EffectRecord);      #! durable lookup by effect id (facet client/aide: own workflow only)
  watch     @4 (effect :Text, watcher :C.Watcher(EffectRecord)) -> (cancel :C.Cancelable);
  cancel    @5 (effect :Text, reason :Text) -> (record :EffectRecord);
      #! prepared or awaitingApproval → cancelled; from authorized on it cannot be cancelled (record returned unchanged)
  reconcile @6 (effect :Text) -> (record :EffectRecord);      # run the executor's reconciliation now (strategy reconciliation)
  resolve   @7 (effect :Text, outcome :Text, mandate :Data) -> (record :EffectRecord);
      #! outcomeUnknown → succeeded | failed on the owner's decision (mandate kind workflow.decide bound to the record, §14.4)
  forget    @8 (workflow :Text) -> ();
      #! forgotten workflow: shreds its payloads (unit gate:<owner>:<wf-id>); keeps the minimal dedup records (§20.26)
}

struct BudgetEntry { key @0 :Text; state @1 :Text; amount @2 :List(B.Budget); }   # state "reserved" | "settled" | "released" | "unresolved"

interface WorkflowBudget {         # gate; facet broker: open, close, status; facet loom and facet aide: reserve, settle, release, status
  open    @0 (account :Text, workflow :Text, ceilings :List(B.Budget)) -> ();   #! idempotent; same account, other ceilings: kl:conflict
  reserve @1 (account :Text, key :Text, amount :List(B.Budget)) -> (entry :BudgetEntry);
      #! idempotent per (account, key); kl:budget when spent + reserved + unresolved + amount exceeds a ceiling
  settle  @2 (account :Text, key :Text, actual :List(B.Budget), outcome :Text) -> (entry :BudgetEntry);
      #! once per key: replaces the reservation by actual; outcome "unknown" keeps it as unresolved (still counted); a repeat with
      #! equal values returns the entry, with other values kl:conflict
  release @3 (account :Text, key :Text) -> (entry :BudgetEntry);   # drops an unsettled reservation; idempotent
  status  @4 (account :Text) -> (ceilings :List(B.Budget), reserved :List(B.Budget), spent :List(B.Budget), unresolved :List(B.Budget));
  close   @5 (account :Text) -> ();   # terminal workflow: no further reservations; spent amounts stay recorded
}

struct EnrollRequest {
  workflow       @0 :Text;            # wf-…
  definition     @1 :L.DefinitionRef;
  inputDigest    @2 :C.Digest;
  scope          @3 :List(B.GrantRequest);
  budgets        @4 :List(B.Budget);
  resume         @5 :L.ResumePolicy;
  runWhileLocked @6 :Bool;
  horizonSecs    @7 :UInt64;
  reason         @8 :Text;
  account        @9 :Text;            # ba-… the broker opens with WorkflowBudget.open when the enrollment is approved
}

struct DecisionRecord {
  id       @0 :Text;                  # dr-…
  workflow @1 :Text;
  key      @2 :Text;                  # logical operation, e.g. "enroll", "effect:fx-…", "grant:<name>", "decide:<ws-…>"
  digest   @3 :C.Digest;              #! sha256 of the JCS {workflow, key, requests, effects}: never a session or attempt (§20.25)
  state    @4 :Text;                  # "pending" | "approved" | "denied" | "expired" | "cancelled"
  approval @5 :Text;                  # boot-local a-… of the prompt currently shown; empty when none
  mandate  @6 :Data;                  # the delivered mandate (§14.4) when approved
  expires  @7 :C.Timestamp;           #! fixed when decided; never extended by a rebind or a later attempt
}

struct DecisionEffect { kind @0 :Text; target @1 :Text; digest @2 :C.Digest; rendered @3 :List(P.RenderedEffect); }

struct WorkflowRecordInfo {
  workflow       @0 :Text;
  owner          @1 :Text;
  state          @2 :Text;            # "enrolling" | "active" | "cancelled" | "forgotten"
  epoch          @3 :UInt64;          # highest claimed ownership epoch
  attempt        @4 :Text;            # wa-… of that claim
  label          @5 :C.Label;         # workflow label high-water mark
  horizon        @6 :C.Timestamp;
  account        @7 :Text;            # ba-…
  resume         @8 :L.ResumePolicy;
  runWhileLocked @9 :Bool;
  definition     @10 :L.DefinitionRef;
}

interface BrokerWorkflow {         # broker, facet workflow (holders per §19.2)
  enroll   @0 (subject :C.SessionId, req :EnrollRequest) -> (decision :DecisionRecord);
      #! loom: Cedar action enroll for the subject (the owner's session) plus every scope item as a persistent request (§20.25)
  claim    @1 (binding :C.AttemptBinding, generation :C.Ref, spawner :C.SessionId) -> (record :WorkflowRecordInfo);
      #! loom: binding.epoch MUST be record.epoch + 1 (else kl:conflict); persisted before return; revokes every root of
      #! earlier attempts; generation and spawner are the only ones allowed to register this attempt (SessionReg.attempt)
  verify   @2 (binding :C.AttemptBinding, session :C.SessionId) -> (record :WorkflowRecordInfo);
      #! gate, strata, bench, aide: binding is the current claim and session belongs to it; else kl:conflict (stale) or kl:revoked
  decide   @3 (binding :C.AttemptBinding, key :Text, requests :List(B.GrantRequest), effects :List(DecisionEffect)) -> (decision :DecisionRecord);
      #! durable logical request: deduplicated by (workflow, key) and the digest, never by session; persisted before any prompt
  rebind   @4 (decision :Text, binding :C.AttemptBinding, session :C.SessionId) -> (result :B.GrantOutcome);
      #! explicit use of an approved decision by a fresh attempt: revalidated against current policy, revocation and expiry;
      #! grants are minted for session; never extends expiry or presence
  authorizeEffect @5 (binding :C.AttemptBinding, effect :Text, kind :Text, target :Text, payloadDigest :C.Digest,
                      rendered :List(P.RenderedEffect)) -> (decision :DecisionRecord);
      #! gate: current authority for one workflow effect (record, policy, Rule of Two with the workflow label, epoch); approved
      #! immediately (no prompt, empty mandate) or through a durable decision with key "effect:<fx-…>"
  offer    @6 (binding :C.AttemptBinding) -> (tokens :List(C.Token));
      #! aide: path and net tokens of the workflow scope bound to aide's own session, expiring after 120 s, for building the
      #! shares and offered tokens of the attempt's VM (§20.25)
  resume   @7 (subject :C.SessionId, workflow :Text) -> (decision :DecisionRecord);   # loom: Cedar action resume for the subject
  cancel   @8 (subject :C.SessionId, workflow :Text, reason :Text, forget :Bool) -> (record :WorkflowRecordInfo);
      #! loom (subject = the cancelling session, Cedar action cancel; empty subject for loom's own forget of a deleted user's
      #! workflows, §20.25): durable cancellation and
      #! revocation record, persisted before return; revokes every root of the workflow; refuses every later claim
  record   @9 (workflow :Text) -> (record :WorkflowRecordInfo);   # loom, gate, strata
  raise    @10 (workflow :Text, label :C.Label, reason :Text) -> (label :C.Label);
      #! loom: raises the workflow label high-water mark (labels only go up), persisted before return
  cancelDecision @11 (decision :Text, reason :Text) -> (decision :DecisionRecord);
      #! loom, gate: withdraws one pending durable decision (its prompt is closed); idempotent; a decided one is returned unchanged
}

interface AgentWorkflowHost {      # aide, facet loom
  startAttempt @0 (binding :C.AttemptBinding, template :C.Ref, task :Text, input :C.Fd, label :C.Label) -> (session :C.SessionId);
      #! starts an agent session as the attempt (VmSpec.attempt); the harness reaches loom only through aide
  stopAttempt  @1 (binding :C.AttemptBinding, mode :Text) -> ();   # mode "cancel" | "fence" | "pause"
  status       @2 (binding :C.AttemptBinding) -> (json :Text);
}

interface LoomSystem {             # loom, facet aide
  attempt         @0 (binding :C.AttemptBinding, session :C.SessionId) -> (host :L.AttemptHost);
      #! the AttemptHost of an agent attempt aide started; aide records every model and host-tool observation through it
  ended           @1 (binding :C.AttemptBinding, reason :Text) -> ();
      #! the attempt ended without complete/fail: "crashed" | "paused" | "breaker" | "deadline" | "vm-lost"; never a cancellation
  cancelRequested @2 (binding :C.AttemptBinding, subject :C.SessionId, reason :Text) -> ();
      #! the human stopped the attached agent session (AgentSession.stop): loom treats it as Workflow.cancel by subject
}
```


### A.26 protocols §20.25, §20.26 — Durable execution and the effect executor contract

> Verbatim copy of `protocols/spec.md` lines 4569–4646, 4648–4675 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 20.25 Durable execution

A **workflow** is an enrolled, durable task: a pinned definition (§20.27) run by `loom` as a sequence of steps, each executed by one or more **attempts**. The central invariant is normative for every component named in this section:

> Workflow progress survives execution attempts. Authority is revalidated before every further effect, and persistence never resurrects revoked permissions or cancelled work.

Boot-scoped authority is unchanged: tokens, root keys, sessions and prompt IDs never outlive their boot (§8.1). What survives is the record of progress and of decisions, never the authority to act on it.

**Roles.**

| Component | Durable responsibility | Never |
|---|---|---|
| `loom` | Workflow store: enrollments, runs, steps, attempts, recorded observations, timers, signals, tombstones; scheduling, claims, cancellation; the receipt outbox | holds workflow authority, executes effects, decides approvals |
| `broker` | Workflow records (approved scope, ownership epoch, label high-water mark, cancellation), attempt authority at registration, durable decisions | trusts loom for anything but the identity of the next claim |
| `gate` | Durable effect records by effect ID, executor strategies, workflow budget accounts | executes an effect without current authorization |
| `warden` | A fresh session for every attempt process (`SpawnSpec.attempt`) | persists sessions or fds, interprets attempt bindings |
| `aide` | Agent sessions as attempts (`AgentWorkflowHost`); model and tool observations recorded through `loom` | resumes an agent session that is not an attempt of an enrolled workflow |
| `strata`, `bench` | Prepared merges and their completion records retained for the workflow's horizon, reachable by a fresh attempt | bind a prepared merge to a dead session only |
| `vault` | `loom:` unit keys (wrapped under the system key, forgettable) | enforce the owner-lock policy (loom does) |
| `ledger` | Signed evidence of decisions, transitions and outcomes | act as a workflow store or deduplicate submissions |
| `hearth` | The owner's lock state (`HearthSystem.userState`, `watchUsers`) | |

**Identities** (§3.5). `WorkflowId` (`wf-`) names the enrolled task, `RunId` (`wr-`) one run of it, `StepId` (`ws-`) one occurrence of one state in a run, `AttemptId` (`wa-`) one execution attempt, `EffectId` (`fx-`) one logical external or local operation shared by all retries, `OwnershipEpoch` the fence advanced by every claim, `DecisionId` (`dr-`) a durable approval, `BudgetAccountId` (`ba-`) the workflow's budget. Step and effect IDs are derived, so a replayed step finds the records of its earlier attempts. A session ID is never the identity of durable work: every attempt runs under fresh sessions, and loom records the attempt-to-session mapping. Old principals, bearer tokens, fds and prompt IDs are never stored as replay material; signatures and digests are stored as evidence and re-verified, never as a substitute for current policy.

**Status vocabulary.** `WorkflowInfo.status` (§7.3.16) and the `status` of `workflow.*` receipts take exactly these values; `detail` carries one of the listed codes.

| Status | Meaning | `detail` codes |
|---|---|---|
| `running` | An attempt is executing or a claim is scheduled | `step:<ws-…>` |
| `waiting` | No attempt is needed until an external event | `decision:<dr-…>`, `timer:<RFC 3339 time>`, `signal:<name>`, `effect:<fx-…>` (awaiting the executor's outcome), `enrollment:<dr-…>` |
| `paused` | Eligible work is held back by a pause condition | `user`, `locked` (owner locked), `awaiting-resume` (manual resume after a restart), `breaker`, `budget`, `time-untrusted`, `rollback-review`, `capacity` |
| `blocked-by-authority` | The next step needs authority that does not exist now | `revoked`, `policy`, `decision-denied:<dr-…>`, `decision-expired:<dr-…>`, `definition-revoked`, `horizon` |
| `outcome-unknown` | An effect's outcome cannot be established automatically | `effect:<fx-…>` |
| `completed`, `failed` | Terminal: the definition reached an `end` state (`failed` also for `history-lost`) | `end:<state>`, `error:<code>`, `history-lost` |
| `cancelled` | Terminal: durably cancelled | `by:<human>` |
| `forgotten` | Terminal: history crypto-shredded; only a tombstone remains | none |

**Enrollment.** Enrollment is the only way work becomes resumable; an agent, app or guest session never becomes durable by being paused, stopped or restarted.
1. A human's `shell` (or `atrium`) calls `Loom.enroll` on `loom#user`. loom checks the definition (§20.27): the generation is launchable and not revoked (`Depot.get`), its manifest lists the name in `provides.workflows`, and the file's digest equals `DefinitionRef.digest`; it validates the input against the definition's input schema, assigns the `wf-` ID, and commits an `enrolling` record (deduplicated by owner and `idempotencyKey`).
2. loom calls `BrokerWorkflow.enroll(<caller session>, EnrollRequest)`. The broker evaluates Cedar `enroll` (§16.1) and every scope item as a persistent request; the tier is the maximum, at least `t2`, with presence when `resume = automatic` or `runWhileLocked` (as for persistent grants); guest humans and non-`shell` subjects are denied by default policy. The decision is a durable decision (below) with key `enroll` and the mandate effects `workflow.enroll` plus one `grant.<k>` per scope item (§14.2).
3. When approved, the broker writes the workflow record `keylos.workflow-grant/1` (signed by `service/broker`, file and directory `fsync`ed), with the label baseline = the enrolling session's label at that moment, the horizon (`horizonSecs` capped by policy, default 30 days, maximum 400 days) and the budget account, which it opens with `WorkflowBudget.open` on `gate#broker`. Only then does the workflow leave `waiting` (`enrollment:<dr-…>`).
4. The enrolling session's tokens are never used by the workflow; the approved scope is the only authority later attempts can receive.

**Claims and ownership fencing.** loom executes every step through a **claim**: before an attempt, loom commits the claim (new `wa-`, epoch e + 1, the activity's generation, the spawner session) in its store, then calls `BrokerWorkflow.claim`. The broker accepts only epoch = its record's epoch + 1 (`kl:conflict` otherwise: a stale or second coordinator, or a restored store), persists it before replying, and revokes every root minted for earlier attempts of the workflow. Every consumer rejects a stale epoch where it can still prevent an action: loom's `AttemptHost` (every method), the broker at attempt registration and in `authorizeEffect`, `gate` in `DurableEffects` (binding versus the token's `workflow` fact and the current claim, `BrokerWorkflow.verify`), strata in `preparedFor` and `bindWorkflow`. A process that missed a cancellation or lost its coordinator may stay alive; it cannot act, because its roots are revoked and its epoch is stale. A cooperative stop or an expired lease alone never authorizes anything. A new fence cannot undo a request a remote system already accepted; such effects are settled by their effect ID (§20.26). One loom instance owns the store exclusively (SQLite exclusive locking plus a lock file); a second instance fails its first claim with `kl:conflict` and stops.

**Attempt authority.** An attempt is a fresh principal: a process spawned by loom (`SpawnSpec.attempt`, principal `<actor>@<owner>/<loom session>/<attempt session>`) or an agent VM started by `aide` (`VmSpec.attempt`). `warden` forwards the binding in `SessionReg.attempt` and uses `binding.owner` as the principal's human. At registration the broker requires the binding to be the current claim, the child's generation to be the claimed generation, its parent to be the claimed spawner and its human to be the record's owner; otherwise registration fails `kl:conflict` (stale) or `kl:revoked` (cancelled). It then, in this order:
1. sets the session label to the join of the default and the workflow's label high-water mark (labels before grants);
2. re-evaluates every scope item against current policy with the workflow principal entity (§16.1): `t0`/`t1` items are minted, `t2`/`t3` items only with the enrollment mandate, as for persistent grants; revoked, expired, cancelled or denied items are not minted;
3. mints fresh tokens for the attempt session with `workflow(<wf>, <epoch>)`, `budget_account(<ba>)` and `expires` no later than the horizon (§8.2).
The attempt process obtains these tokens like every principal, with `Broker.myGrants` on its `broker#principal` route; `warden` never passes the tokens of `SessionRegResult` to the process. An attempt therefore holds an effect token only for kinds in the enrolled scope: at `enroll`, loom refuses (`kl:invalid`) a scope that lacks an effect item for any kind an activity of the definition declares in `effects`, so `DurableEffects.prepare` always has a token to present. Offered tokens of the spawner are never delegated to an attempt. `BrokerWorkflow.offer` gives `aide` short-lived path and net tokens of the scope on its own session, only to build the attempt VM's shares, exactly as human-offered tokens are used today.

**Durable decisions.** `BrokerWorkflow.decide` creates or returns the durable decision of one logical operation. Its identity is (`workflow`, `key`) and its digest the SHA-256 of the JCS `{"workflow", "key", "requests": [<GrantRequest JSON forms, §14.4>], "effects": [{"kind", "target", "digest"}]}`; neither contains a session, attempt or prompt ID, so a fresh attempt finds the same decision. The same key with another digest fails `kl:conflict`. The broker persists the record before showing any prompt and persists the decision before replying to anyone (a crash between decision and reply loses nothing). Prompts are boot-local and re-presented after restarts (§14.3); `expires` is fixed at creation. A fresh attempt uses an approved grant decision only through `rebind`, which re-checks the record, current policy, revocation, expiry and presence and mints for the new session; an effect decision is consumed by `gate`, once per effect ID (§20.26). A trusted approval is always a decided mandate bound to the operation and payload, never a workflow signal. For a `decide` state (§20.27) the decision carries one `DecisionEffect` per option (kind `workflow.decide`, target `<ws-…>#<option>`, digest over the JCS `{"question", "option"}`); the human approves exactly one option, and the delivered mandate's `effects[]` holds only that entry, the one permitted difference from the draft. `BrokerWorkflow.cancelDecision` withdraws one pending decision (for example when its effect is cancelled).

**Effects.** loom never executes effects. An activity prepares an effect at `gate` with the effect ID loom assigned (`AttemptHost.effect`, `DurableEffects.prepare` with its token); loom commits it later with the current claim (`DurableEffects.commit` on `gate#loom`), and `gate` asks the broker for current authority (`authorizeEffect`) every time. The effect contract is §20.26.

**Labels.** The workflow label is a high-water mark kept by the broker (`BrokerWorkflow.raise`; the broker also raises it whenever an attempt session's label rises). loom stores every observation and result with its label; replayed observations keep their labels; `AttemptHost.task` returns the workflow label; a fresh attempt therefore never restarts at `public/trusted` after the workflow consumed more sensitive or less trusted data. The Rule of Two (§14.1) applies to workflow effects with the workflow label.

**Budgets.** Each workflow has one budget account (`ba-`) with the enrollment's ceilings, held by `gate` independently of token roots. Attempt tokens carry `budget_account`, so metered spending is charged to the account whatever root the attempt holds; new roots never reset spent amounts. Reservations are keyed (`reserve`, `settle`, `release` are idempotent per key): `gate` uses `<wa-…>:<request number>` for metered requests, loom and aide derive keys from step and observation keys. A reservation of an attempt that was fenced before settling is settled as `unresolved` (still counted against the ceiling) until the actual charge is known; a key is settled at most once with a final amount, so a duplicated completion message never double-charges. The account is closed when the workflow is terminal.

**Recorded observations and replay.** Orchestration is deterministic: the next state depends only on the definition and on recorded outcomes, results, signals and timer firings. Every non-deterministic observation that can influence a later decision (model responses, tool results, clock readings, randomness) is recorded through `AttemptHost.record` before the activity uses it. A later attempt of the same step obtains recorded observations by key (`AttemptHost.recorded`) instead of asking a model or tool again; it calls live only past the last recorded key. Observation keys are `<kind>:<n>` with a per-kind counter that starts at 0 in every step and counts in the order the activity makes the observations, so a deterministic replay reaches the same keys. An activity whose result was never recorded is retried, reconciled or reported per its declared semantics (§20.27); it is never treated as completed because it probably ran.

**Durability.** loom acknowledges an enrollment, transition, observation, result, signal, cancel or forget only after its SQLite transaction (WAL, `synchronous=FULL`) committed, every blob it references was written with `O_TMPFILE`, `fsync`ed, linked and its directory `fsync`ed, and, where a receipt is required, after the receipt is acknowledged. A failed `fsync`, a full disk or any other barrier failure aborts the transaction and is reported `kl:unavailable`; after an `fsync` failure the store is reopened and verified before the next write. A state transition and the messages it causes (claims, effect commits, receipts) are committed in the same transaction as outbox rows and delivered afterwards with stable IDs; deliveries are deduplicated by those IDs on the receiving side.

**Receipt outbox.** loom writes `workflow.*` receipts (§19.3) with `subject` = the principal that enrolled the workflow and `data` = `{workflow, run, n, …}` holding only IDs, states, epochs, digests and reason codes, never inputs, results or model and tool content; `n` is the per-workflow event number and (`workflow`, `n`) the stable logical event ID. Each receipt is an outbox row committed with its transition. Delivery: loom builds and signs the submitted form, persists its `time` and submitted-form digest in the row, then calls `Ledger.append`; on success it records the returned `seq`. A `re-sign` refusal (§13.1) is answered by persisting a new submitted form and resubmitting. **Reconciliation** after a restart: loom first appends `workflow.recover` (subject: loom itself) with a `time` later than every outstanding submission's `time`; once it is acknowledged, no outstanding submission can be appended any more (§13.1 time order), and each is settled by searching its submitted-form digest among loom's receipts after the last acknowledged `seq` (`Ledger.query`, `principalPrefix "service:loom:"`, §7.3.5): found → acknowledged with that `seq`; not found → it was never appended, and loom submits it again as a new submitted form. Each logical event therefore produces at most one receipt, and at least one once the ledger is reachable. The ledger itself never deduplicates; a coordinator+ledger atomic transaction is not claimed.

**Rollback detection.** loom's store records the ledger `seq` of its newest acknowledged receipt. After `workflow.recover` is acknowledged, every loom receipt between that `seq` and the recovery receipt must be an outstanding submission of the store; any other one, a store that is behind the ledger, or a ledger that is behind the store (an alarm epoch, §13.3) means an older store was restored. loom then writes `workflow.rollback-detected`, pauses every workflow (`rollback-review`) and re-applies the authoritative records: `workflow.cancel` and `workflow.forget` receipts after its anchor (their `refs` stay readable after shredding, §13.4) become tombstones; the broker's workflow records give the current epoch and cancellation state; `gate`'s effect records and budget accounts give effect outcomes and spent amounts; a workflow whose history the store no longer has becomes `failed` with `history-lost`, never restarted. Dispatch resumes only after the owner accepts with `loom rollback accept` (presence purpose `loom.rollback-accept`, §20.2). The broker's workflow and decision records and `gate`'s effect records and budget accounts are anchored the same way against their own receipts (`principalPrefix "service:broker:"`, `"service:gate:"`). The anchor rests on the ledger's own rollback protection (NV counter `0x01300100`, §13.3); no further NV index is used. Restoring an older store therefore cannot resurrect cancelled work, reset budgets or repeat effects; restoring the whole disk image is detected by the ledger's counter and leads to the same review.

**Cancellation.** `Workflow.cancel`: (1) loom commits a `cancelling` tombstone; (2) `BrokerWorkflow.cancel` writes the broker's durable cancellation record, revokes every root carrying the workflow fact and cancels the workflow's pending decisions; (3) loom terminates attempts (`Process.kill`, `AgentWorkflowHost.stopAttempt(…, "cancel")`), cancels prepared and awaiting effects (`DurableEffects.cancel`) and drops timers; (4) after `workflow.cancel` is acknowledged, `cancel` returns. Step 2 needs the subject's live session (the broker evaluates Cedar `cancel` for it). If loom restarts between steps 1 and 2 and that session no longer exists, the workflow stays non-runnable (the `cancelling` tombstone allows no claims and no attempts) and loom completes steps 2–4 when the broker's record shows the cancellation or when the owner calls `cancel` again; it never resumes the workflow. Effects already authorized or dispatched are not undone by cancellation: loom keeps resolving their outcomes (lookup, reconciliation) and records them. Cancellation runs no further workflow logic; compensation is a new authorized effect, run before cancelling through the definition's `abort` signal (§20.27). Recovery never re-enrolls a cancelled workflow: its tombstone, the broker's record and the ledger evidence each refuse it.

**Forgetting.** `Workflow.forget` cancels the workflow if it is not terminal, commits a `forgotten` tombstone, then destroys every copy of its private history: `vault.forget("loom:<owner>:<wf-…>")`, `DurableEffects.forget` (gate shreds the workflow's payload unit `gate:<owner>:<wf-…>`), discard of retained prepared merges, removal of `aide`'s attempt units and `Depot.unroot`. loom evicts cached keys and plaintext, and re-checks the tombstone after every asynchronous key or blob fetch before caching or delivering the result. What remains: loom's tombstone (`wf-`, run IDs, owner, terminal kind, time), the broker's cancellation record, `gate`'s minimal effect records (§20.26) and the ledger's ID-only receipts, which suffice to prevent recreation and contain no private data. Cryptographic erasure completes as the vault reports it (vault rotation). History that is deleted or expired is reported as `forgotten` or `history-lost`, never silently restarted.

**Owner lock.** Key wrapping does not decide execution: `loom:` units are wrapped under the vault's system key, so loom can keep recording outcomes of in-flight operations while the owner is locked. Execution follows an explicit lock policy: a workflow owned by a human pauses (`paused`, `locked`) while that human is locked (`HearthSystem.userState`: no authenticated, unlocked login session; logged out counts as locked), unless it was enrolled with `runWhileLocked` (presence-approved). While paused by the lock, loom makes no claims, dispatches nothing and decrypts no history for execution; overdue timers wait. When hearth is unreachable loom assumes the owner is locked. Workflows of `_system` never pause for a lock. When hearth reports a user deleted (`watchUsers`, `deleted`), loom forgets every workflow of that user.

**Restart and reboot.** At start loom runs the receipt reconciliation and the rollback check, then for each non-terminal workflow reads the broker's record (cancelled → finish the cancellation), looks up every effect that is not settled (`DurableEffects.lookup`), and treats every attempt of the previous run of loom as ended (its sessions are gone or fenced). A workflow with `resume = manual` becomes `paused` (`awaiting-resume`) until its owner calls `Workflow.resume` (Cedar `resume`); one with `resume = automatic` is claimed again without asking, still fully reauthorized by the broker. Steps whose activity result was not recorded continue per the activity's semantics (§20.27).

**Timers, signals and time.** Timers are stored rows; a timer fires only when trusted time (§3.6) has reached its due time, never early; while the clock is not trusted loom uses `max(now, time floor)` and pauses timer-driven work whose due time lies beyond the floor (`time-untrusted`). Decision expiry, horizons and deadlines are checked against trusted time. After a long downtime overdue work is caught up in due order at most `catchUpPerMinute` (default 6) claims per minute, a periodic timer fires once rather than once per missed period, and every overdue item re-checks cancellation, pause, lock, budget and horizon first. Signals are recorded with the sender's label, deduplicated by (name, key); a workflow past its horizon is `blocked-by-authority` (`horizon`): the broker refuses its claims.

**Retention.** History is kept until the workflow is forgotten, or `historyRetentionDays` (default 30) after it became terminal, when loom forgets it automatically. Decision records live until 30 days after the workflow is terminal; effect dedup records per §20.26; tombstones are never deleted. Replay retention is independent of the ledger's monthly audit retention: shredding a receipt month never removes history a live workflow needs, and forgetting a workflow leaves no decryptable copy of its history in any receipt.

### 20.26 Effect executor contract

Every workflow effect is a **durable effect record** in `gate` (`DurableEffects`, §7.5.25), owned by its workflow and identified by its effect ID, independent of the attempt sessions that prepare, authorize or observe it. Ordinary intents (§7.3.7) keep their own rules; a durable effect is also an outbox intent (`EffectRecord.intent`) and appears in `Gate.intents` of the preparing session.

**States.** `prepared` → (`awaitingApproval` →) `authorized` → `dispatching` → `succeeded` | `failed` | `outcomeUnknown`; `prepared` and `awaitingApproval` → `cancelled`; `succeeded` → `compensated` (compensable kinds). `authorized` means only that the effect may be performed now: it is recorded by `effect.commit` and is never reported as completion. Only `succeeded` and `failed` are confirmed outcomes (receipt `effect.complete`); `outcomeUnknown` (receipt `effect.unknown`) is an explicit state, not a failure. For caller-executed kinds (§14.2) gate moves the record to `authorized` and returns the mandate; the executor's own completion receipt, presented through `DurableEffects.complete`, is the authenticated outcome that moves it to `succeeded` or `failed`.

**Request digest.** `requestDigest` = SHA-256 of the JCS `{"effect", "workflow", "kind", "class", "target", "args": [{"name", "value", "source", "label": {"conf", "integ"}}…] (sorted by name, without `x-subject-token`), "payloadDigest", "compensator"}` (class and label values as their enumerant names; `compensator` `null` when empty). It binds the effect ID to exactly one request: `prepare` with an existing effect ID and an equal digest returns the existing record; with another digest it fails `kl:conflict`, so a payload can never change under an existing effect ID. The mandate binds the payload digest (§14.4) and `constraints.workflow` the workflow.

**Authorization at commit.** `DurableEffects.commit` (facet `loom`) requires the binding to be the workflow's current claim, then calls `BrokerWorkflow.authorizeEffect` with the record's kind, target, payload digest and gate's required renderings. The broker revalidates the workflow record (not cancelled, not past its horizon), the owner's eligibility, current policy and revocation, the Rule of Two with the workflow label, and the budget; it answers approved (no approval needed) or with the durable decision of key `effect:<fx-…>`. The record waits in `awaitingApproval` (`decision`) until the decision is approved; loom observes the decision only through `commit` and re-issues `DurableEffects.commit` with its current claim at its poll interval (and with a fresh claim after a restart) while the record waits (gate answers from its record, the broker returns the existing decision; `DurableEffects.watch` is optional). A denied or expired decision, or a policy denial by `authorizeEffect`, moves the record to `cancelled` with outcome `{"reason": "decision-denied" | "decision-expired" | "policy-denied"}`, which loom reports as the commit outcome `denied`; any other `cancelled` record is the commit outcome `cancelled`. Once the decision is approved, gate verifies the delivered mandate (§14.4, `constraints.workflow`, payload digest, expiry) and consumes it: the transition to `authorized`, the mandate's single use and the effect ID are committed atomically, so a decision is consumed at most once and an effect ID is authorized at most once.

**Retry strategies.** Every executor declares exactly one strategy for every (kind, target) it executes; gate records it at `prepare` and never changes it for an existing record. A missing or unverifiable declaration is `noSafeRetry`.

| Strategy | Requirement on the executor | After a crash or a lost reply in `dispatching` |
|---|---|---|
| `transactional` | The operation and its completion record commit atomically inside the executing service, keyed by a stable ID (for `fs.merge`: the prepared merge and its `PreparedMerge.status`, `BenchMerge.commitPrepared`) | Look up the completion record: present → its outcome; absent → the operation did not happen and may be dispatched again under the same effect ID |
| `downstreamIdempotency` | The destination enforces the effect ID as key together with payload identity for a documented window W; gate's configuration MUST declare that destination `verified` with W. Sending an `Idempotency-Key` header alone is not proof | Re-send with the same key while now < `dedupUntil` (first dispatch + W); afterwards → `outcomeUnknown`, never a blind repeat |
| `reconciliation` | A registered reconciler queries authoritative destination state by the effect ID or the payload digest (for example the remote ref equals the pushed commit); a view that is only eventually consistent, or absence from a sent folder, is never proof of non-execution | `present` → `succeeded`; authoritative `absent` → may dispatch again; anything else → `outcomeUnknown` |
| `noSafeRetry` | none | → `outcomeUnknown` |

Retries reuse the effect ID; a retry never happens after the record left `dispatching` for a confirmed outcome, and a record in `outcomeUnknown` is never dispatched again automatically, whatever the strategy, after its window expired.

**Resolving an unknown outcome.** `outcomeUnknown` ends only by reconciliation (`DurableEffects.reconcile`) or by the owner (`Workflow.resolve` → `DurableEffects.resolve` with a `workflow.decide` mandate bound to the record; presence for irreversible kinds). The resolution mandate's effect is `{"kind": "workflow.decide", "target": "<fx-…>", "digest": "sha256:" + SHA-256(JCS({"effect": "<fx-…>", "outcome": "succeeded" | "failed"}))}`. The owner's resolution records `succeeded` or `failed`; it never re-dispatches the effect ID. Repeating the operation needs a new step occurrence and therefore a new effect ID, with its own authorization.

**Cancellation and compensation.** `DurableEffects.cancel` cancels a `prepared` or `awaitingApproval` record (and its pending decision); from `authorized` on the record cannot be cancelled and its outcome is settled as above. Compensation of a succeeded effect is `Intent.compensate` for its intent where a compensator is registered, or a new effect with its own effect ID; neither is a rollback guarantee.

**Dedup retention.** Retention is part of correctness. gate keeps every record (effect ID, workflow, request and payload digests, strategy, state, outcome, receipts, `dedupUntil`) at least until the latest of: the workflow's horizon (from the broker's record), `dedupUntil`, and 30 days after the record reached a terminal state; a record that is not terminal is never deleted. Payload blobs are kept until the record is terminal plus 7 days, or until the workflow is forgotten (`DurableEffects.forget`), which shreds them and keeps the minimal record. A workflow never runs past its horizon (the broker refuses its claims), so no workflow can re-request an effect ID whose record was deleted.

**Executors behind gate.** gate's kind registry declares the strategy per executor: `BenchMerge.commitPrepared` (`fs.merge`) is `transactional`; HTTP replay is `downstreamIdempotency` only for destinations configured as `verified`, otherwise `reconciliation` where a reconciler is registered (`git.push`: the remote ref; `git.pr.open`: a search by head branch and the effect ID in the body), otherwise `noSafeRetry`; SMTP is `reconciliation` only with an IMAP rule whose provider is configured as strongly consistent, otherwise `noSafeRetry`; `net.listen` is `transactional`; caller-executed kinds are `noSafeRetry` unless the executor documents a completion lookup.
