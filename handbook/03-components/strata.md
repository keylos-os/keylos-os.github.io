# strata

> State management. strata owns the btrfs subvolumes, scheduled and on-demand snapshots, overlay transactions for commands and agents, crypto-shred units, creation-time provenance, and backup and sync orchestration.
> It makes "undo for files, a receipt for everything else" real.

**Status:** specified (v1.0) · **Spec:** [`strata/spec.md`](../../specs/strata/spec.md)

![Transaction](../images/transaction-try.svg)

## Responsibilities

- **Subvolumes:** `@var`, `@home`, a subvolume per user and per app/user `.apps/<app>/{config,data,cache,state}`, `@keystore` (never snapshotted), `@snapshots`.
- **Snapshots:**
  - scheduled, and around every transaction and update;
  - count- and age-based retention, never qgroups;
  - browse and restore files.
- **Transactions:**
  - `Strata.begin` builds overlay views (`index=on`, `redirect_dir=on`, `xino=on`, reflink copy-up) of the granted directories;
  - network policy is enforced, and the transaction runs in its own cgroup;
  - conflicts are detected: files open elsewhere, SQLite WAL pairs, locks;
  - three-way merge for text;
  - commit by snapshot swap, which returns the undo snapshot.
- **Crypto-shredding:** `createUnit` assigns a unit key (from [vault](vault.md)). `forget` destroys it, so every copy in snapshots and backups becomes unreadable.
- **Provenance:** a BPF LSM hook at inode creation writes `security.bpf.keylos.prov`. `why` reads it back.
- **Backup and sync:** btrfs send/receive replicas, restic-compatible off-site backup from read-only snapshots, and periodic restore tests.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Strata`, `Transaction` (`strata.capnp`) | Facets `user`, `cli`, `bench`, `aide`, `compat`; `begin` takes a `NetworkPolicy` enum |
| Provides | `StrataTxn`, `TransactionExt`, `StrataAdmin`, `StrataHomes` (`strata-sys`) | Facets `warden`, `hearth`, `courier`, `admin` |
| Consumes | vault (facet `strata`) | `dataKey`, `forget` |
| Consumes | warden `PrincipalControl.events`, `mountView` (facet `strata`) | Following transaction views into spawned processes |
| Consumes | broker `BrokerSystem.rootsChanged`, `LabelAuthority` | Held roots after a rollback; labels |
| Consumes | TPM NV `0x01300107`, key `0x81000110` | Data-anchor counter and HMAC key |
| Consumes | gate | Off-site backup egress |
| Consumes | ledger (facet `writer`) | Receipts |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

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
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`strata-sys.capnp`](../../specs/protocols/spec.md#757-strata-syscapnp) | `0xc7a1e5d3b2f40026` | `StrataTxn`, `TransactionExt`, `StrataAdmin`, `StrataHomes`, `StrataVolumes` |
<!-- /generated:sysif -->

## Runs as

A t0 service with btrfs ioctl privileges on the data filesystem, overlay mount rights (granted by warden as a service allowance), and the provenance BPF program (signed loader).

## State

| Path | Content |
|---|---|
| `/snapshots/` | Snapshot area |
| `/var/lib/strata/` | Transaction metadata, retention state, backup config |

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `txn.begin`, `txn.commit`, `txn.abort`, `txn.undo`, `snapshot.create`, `snapshot.delete`, `unit.create`, `unit.forget`, `backup.run`, `backup.restore-test`, `anchor.rollback-detected`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Key decisions

- [ADR-0020: btrfs on LUKS2 AEAD](../11-decisions/adr-0020-btrfs-luks2-aead.md)
- [ADR-0032: Crypto-shredding](../11-decisions/adr-0032-crypto-shredding.md)
- [ADR-0033: Creation-time provenance](../11-decisions/adr-0033-creation-time-provenance.md)

## Limitations

- Shared mmap and live databases opened outside a transaction are refused, not merged.

## Related

- [Snapshots and transactions](../08-state/snapshots-and-transactions.md)
- [Crypto-shredding](../08-state/crypto-shredding.md)
- [Provenance](../08-state/provenance.md)
- [Backup and sync](../08-state/backup-and-sync.md)
