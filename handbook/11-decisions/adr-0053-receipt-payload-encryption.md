# ADR-0053: Receipt payloads are sealed per human per month

> Receipts about a human's activity store their `data` and `label` fields encrypted with a unit key per human per month. The hash chain covers the ciphertext, so destroying a month's key forgets the details without breaking the chain. Metadata stays readable. Months older than the retention period (13 by default) are shredded automatically.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Audit / privacy | ledger, vault, fleet, strata, config, protocols |

## Context

- The ledger records every grant, effect, approval, transaction and agent action ([ADR-0031](adr-0031-receipts-ledger.md)). Over months it becomes a detailed record of a person's life: which files they opened through the powerbox, which hosts they reached, which emails agents sent.
- The ledger is append-only and hash-chained, so receipts can't simply be deleted without breaking verification.
- Backups and fleet exports multiply copies. Deletion must work on every copy, which is the reason for crypto-shredding ([ADR-0032](adr-0032-crypto-shredding.md)).
- Audit value is mostly in metadata (who, when, which event, which refs) plus recent payloads.

## Decision

- **Sealed form** ([protocols §13.4](../../specs/protocols/spec.md#134-receipt-privacy)). Every receipt whose subject's human is not `_system` or `_cluster` stores `data: null, label: null` plus `sealed`:
  - unit `ledger:<human>:<YYYY-MM>`;
  - AES-256-GCM nonce and ciphertext of the clear fields;
  - `submitted`: the digest of the submitted clear form.
  The unit key comes from `vault.dataKey` on facet `ledger`.
- **In clear:** schema, seq, prev, time, writer, subject, event, approval, and registry-marked refs (rcpt, gen and drv refs, intent and approval IDs). Never free text or paths.
- **Integrity.** The chain and the ledger's countersignature cover the sealed payload. The writer's signature covers the clear form, which can be verified while the key exists.
- **Shredding.** `LedgerAdmin.shred` destroys a month's key (with presence for months inside retention). An automatic job shreds months older than `ledger.retentionMonths` (default 13, minimum 1). Event `ledger.shred`.
- **Readers.** Humans read their own receipts, agents their own session chain, services what their facet allows. `fleet` sees metadata only, unless an owner exception of kind `fleet-receipt-access` names event types.
- **Exports and backups** carry the sealed form. `ledger export` decrypts only for the exporting owner.

## Alternatives considered

| Option | Why not |
|---|---|
| Delete old receipts (truncate the log) | Breaks the hash chain and the TPM-anchored checkpoints |
| Encrypt everything with one key | All-or-nothing: no selective forgetting by month or human |
| Per-receipt keys | Key-store growth of millions of entries; shredding becomes unbounded work |
| Keep everything forever in clear | Turns an audit log into a surveillance archive; conflicts with deletion rights |

## Consequences

### Positive
- Verifiable audit history without permanent personal detail.
- One key destruction forgets a month everywhere, including backups and exports.
- Organisations get accountability metadata without reading employees' activity by default.

### Negative
- After shredding, investigations see only metadata for those months; writer attribution rests on the ledger countersignature.
- Readers need vault access for current months, so reading is slower than plain JSON.
- Free-text fields must never move into the clear part; the registry marks refs explicitly.

## Related

- [Receipt privacy](../08-state/receipt-privacy.md)
- [Receipts](../04-contracts/receipts.md)
- [Crypto-shredding](../08-state/crypto-shredding.md)
