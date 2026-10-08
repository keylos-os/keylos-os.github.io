# ADR-0065: Transactions on sealed units run on ciphertext clones

> Transactions dispatch by storage backend. For a sealed unit served through unitfs, strata clones the ciphertext backing, serves a transaction-specific plaintext view of only the granted subtree, and commits logical operations back through the encrypted format. No plaintext transaction artifact is ever stored.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | State / encryption | strata, warden, bench, aide, vault, protocols |

## Context

- strata accepted only btrfs transaction targets, but on kernels without btrfs fscrypt the plaintext of a sealed unit is a FUSE view (`keylos.unitfs/1`), and agent workspaces default to sealed units. The ciphertext being on btrfs does not make the plaintext directory a btrfs target (ISSUES.md ISS-007).
- Simply removing the filesystem check would put plaintext overlay uppers and undo copies in `/snapshots`, outside the unit's encryption and forget guarantees.

## Decision

- `Strata.begin` dispatches per target backend (protocols §7.3.10, E34): plain btrfs keeps the overlay path; a registered unitfs view is resolved through strata's own mount metadata to (unit, relative subtree).
- For unitfs: snapshot and clone the ciphertext backing; serve a transaction-specific unitfs view of the subtree only; compute diffs and prepared merges ([ADR-0061](adr-0061-prepared-merges-and-writer-fence.md)) on logical plaintext views; commit logical operations through the unitfs format writer into the live backing after quiesce and a writer fence.
- Base, working copy, prepared result, undo snapshot and journals all stay ciphertext under the unit key. `forget` aborts the unit's transactions, and every artifact is undecryptable anyway.
- Lock makes the views unavailable and commit returns `kl:unavailable`; after a restart views are served again after unlock.
- Mixed backends, nested units and cross-unit transactions are refused (`kl:unsupported`) in 1.0.

## Alternatives considered

| Option | Why not |
|---|---|
| Drop the btrfs check | Plaintext uppers and undo outside the encryption boundary |
| Overlay over the FUSE plaintext | Plaintext upper files on disk |
| Disable transactions for sealed units | Default agent workspaces would have no `try`/merge path |

## Consequences

### Positive
- Sealed agent workspaces get `try`, prepared merges and undo with their encryption and forget guarantees intact.

### Negative
- Transactions on sealed units run at unitfs speed and need a second unitfs server instance.

### Follow-ups
- Tests on a kernel without btrfs fscrypt: sealed-unit `try`, agent merge, encrypted undo, power-loss recovery, open handles across lock and restart, forget with pending and committed transactions, and a scan for plaintext artifacts.

## Related

- [Snapshots and transactions](../08-state/snapshots-and-transactions.md)
- [ADR-0032: Crypto-shredding](adr-0032-crypto-shredding.md)
- [strata spec](../../specs/strata/spec.md)
