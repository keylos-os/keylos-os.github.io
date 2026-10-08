# ADR-0059: Vault epoch rotation alternates between two TPM NV indices

> The vault keeps its epoch key in two separate NV indices that alternate as active and candidate. A rotation writes the candidate first, commits the re-wrapped database with an authenticated rotation record, advances the floor, and only then erases the previous key. A power cut at any step leaves a recoverable, specified state.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Secrets / recovery | vault, hearth, installer, protocols |

## Context

- Forgetting is real only because every wrap depends on the epoch key in TPM NV ([ADR-0032](adr-0032-crypto-shredding.md)). The first design committed rows wrapped under the new key **before** writing that key to NV, and kept the new key in a warden `FdStore` entry (`epoch-next`) for crash recovery.
- `FdStore` survives service restarts within one boot only. A power loss between the database commit and the NV write lost the only copy of the new key while committed rows needed it (ISSUES.md ISS-001).
- An interrupted TPM NV write may invalidate the index being written while other indices survive (TCG TPM 2.0 Architecture, revision 1.83, §37.7.1, https://trustedcomputinggroup.org/wp-content/uploads/TPM-2.0-1.83-Part-1-Architecture.pdf). Overwriting a single index in place is therefore never safe on its own.

## Decision

- Two indices with the identical template: `0x01300110` vault-epoch/0 and `0x01300111` vault-epoch/1 (protocols §19.6, E28). Both are vault-owned, defined only through `HearthTpm.defineSpace`, and each has its own sealed authValue. Content is `KE ‖ u64 BE epoch`; an all-zero key means erased.
- Rotation (vault spec §4.5.1), serialized with every other security-state mutation:
  1. write `KE' ‖ e+1` to the inactive index, read it back and verify it;
  2. in one database transaction, re-wrap (locked users get their documented pending wrap), switch `meta.active`, set `floor = n+1` and insert a rotation record binding the transaction, both epochs, the active index, the floor target and the digest of the candidate content, authenticated with a key derived from `KE'`;
  3. increment the keystore floor;
  4. erase the previous index (zero key, read back; an index left unreadable by an interrupted write counts as erased), then delete the record. Only now does a forget report completion.
- An index becomes a candidate again only after its erase completed.
- Startup reconciles database, both indices and the floor before serving. It never picks the highest epoch blindly: a candidate written before its transaction committed is ignored, a committed record is finished, a mismatched or unreadable active index puts the vault into locked-system mode.
- The `FdStore` `epoch-next` mechanism is removed.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep `FdStore` recovery | Lost on power loss; that is the bug |
| Encrypted disk journal of the new key plus overwrite of the single index | An interrupted write can destroy the sole index; the journal key would itself need a TPM anchor |
| Two fields inside one index | One interrupted write corrupts both |
| Old key stored under the new key for recovery | Defeats erasure of forgotten data |

## Consequences

### Positive
- Every reachable crash state has a specified outcome, and committed secrets stay readable after power loss.
- Forget completion is reported only after the old key is actually gone.

### Negative
- One more NV index and sealed authValue; each rotation costs two NV writes plus one increment.
- Erasure covers local copies only. Backups exported earlier stay decryptable with the recovery key.

### Follow-ups
- Implement in vaultd and hearth's allowlist ([S2 follow-ups](../publication-notes.md)).
- Validate with power-cut injection at every database, fsync, NV-write, floor and erase boundary under swtpm, including interrupted NV writes and stale database restores.

## Related

- [ADR-0032: Crypto-shredding](adr-0032-crypto-shredding.md)
- [ADR-0045: Owner NV range and one TPM registry](adr-0045-owner-nv-range-and-tpm-registry.md)
- [Secrets](../06-security/secrets.md)
- [vault spec](../../specs/vault/spec.md) · [protocols §19.6](../../specs/protocols/spec.md#196-tpm-objects)
