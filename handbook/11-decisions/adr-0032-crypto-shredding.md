# ADR-0032: Crypto-shredding for deletion

> Data that must be forgettable (per app, project, chat, contact, crash report or agent session) is encrypted with its own data key, wrapped by vault and stored in `@keystore`, which is never snapshotted. `forget` destroys the wrapped key, so every copy in snapshots, replicas and backups becomes permanently unreadable ciphertext.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | State / privacy | strata, vault, gate, aide, journal |

## Context

- Reversibility (snapshots, replicas, backups) works against deletion. Removing a block from every snapshot and replica isn't practical.
- SSD wear levelling and TRIM don't guarantee physical erasure.
- btrfs fscrypt (per-directory keys inside a shared, snapshot-able filesystem) is not merged (v7 series, experimental).
- Content-defined-chunking backups (restic, kopia, borg) share one repository key, which defeats per-unit deletion unless data is encrypted beforehand.

## Decision

- A unit is a directory subtree or object set with a unit ID in `security.keylos.unit`.
- Each unit has a random data key, wrapped (AES-256-GCM, AAD = unit ID) by the keystore key. Wrapped keys live in `/keystore/units/`.
- Until btrfs fscrypt lands, units are encrypted in userspace (per-file AEAD containers managed by strata). Afterwards they move to fscrypt policies.
- Backups contain unit ciphertext. The keystore has its own backup with its own retention and escrow.
- `Strata.forget(unit)` → `Vault.forget` destroys the key and writes a `unit.forget` receipt.
- Defaults: each agent session's transcripts and outbox payloads, crash reports and app caches are units.

## Alternatives considered

| Option | Why not |
|---|---|
| Delete from every snapshot | Expensive, error-prone; replicas and backups escape |
| No snapshots of personal data | Loses reversibility |
| Rely on SSD secure erase | Not selective; not guaranteed |

## Consequences

### Positive
- A real, verifiable "forget" that coexists with snapshots and backups.

### Negative
- Losing the keystore and its backup loses the data. Escrow is essential.
- Userspace encryption overhead until fscrypt is available.

## Related

- [Crypto-shredding](../08-state/crypto-shredding.md)
- [vault](../03-components/vault.md)
- [ADR-0020: btrfs on LUKS2 AEAD](adr-0020-btrfs-luks2-aead.md)
