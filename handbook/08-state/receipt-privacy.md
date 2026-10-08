# Receipt privacy

> The ledger records what every principal did, so it is also a record of a person's life. keylos stores the details of each human's receipts encrypted under a key per human per month. Metadata stays readable, the hash chain stays intact, and old months are forgotten by destroying their key.
> Status: **specified (v1.0)**. Normative: [protocols §13.4](../../specs/protocols/spec.md#134-receipt-privacy), [ledger](../../specs/ledger/spec.md).

## What is sealed

| Receipt subject | Stored as |
|---|---|
| A principal of a human (`…@alice/…`) | Sealed: `data` and `label` encrypted |
| `_system` and `_cluster` principals | Clear |

A sealed receipt keeps these in clear:
- `schema`, `seq`, `prev`, `time`, `writer`, `subject`, `event`, `approval`;
- reference values the event registry marks as refs: rcpt, gen and drv refs, intent and approval IDs.

It never keeps free text or paths in clear.

```json
{"schema":"keylos.receipt/1","seq":88213,"time":"2026-10-08T09:14:02Z",
 "writer":"service:gate:…","subject":"agent:…@alice/s-…","event":"effect.commit",
 "data":null,"label":null,
 "sealed":{"unit":"ledger:alice:2026-10","alg":"aes-256-gcm","nonce":"…","ct":"…","submitted":"sha256:…"}}
```

## Keys and integrity

| Property | How |
|---|---|
| Unit key | `ledger:<human>:<YYYY-MM>` from `vault.dataKey` (facet `ledger`), the month of the receipt's `time` in UTC |
| Chain | The hash chain and `service/ledger`'s countersignature cover the sealed payload |
| Writer signature | Covers the submitted clear form; verifiable while the unit key exists |
| After shredding | Attribution rests on the countersignature and `sealed.submitted` |

## Retention and shredding

- **Automatic:** months older than `ledger.retentionMonths` (default 13, minimum 1) are shredded by a job, which writes `ledger.shred`.
- **Manual:** `ledger shred --human alice --month 2026-03` destroys a month's key. Inside the retention window it needs presence.
- Shredding is final. Backups, replicas and exports contain only the sealed form, so they forget too.

```
$ ledger status                         # retention, oldest readable month, shred history
$ ledger query --since 30d --event effect.commit
$ ledger export --month 2026-09 > audit.bundle   # self-contained, verifiable; decrypted for the exporting owner
```

## Who reads what

| Reader | Sees |
|---|---|
| A human | Their own receipts (clear while the month's key exists) |
| An agent | Only its own session chain |
| A service | What its facet allows (§7.3.5) |
| `fleet` | Metadata only, unless an owner exception of kind `fleet-receipt-access` lists event types |

Organisations get accountability (who, when, what kind of event) without reading an employee's activity by default.

## Limitations

- Investigations into shredded months see metadata only.
- Reading current-month details needs vault, so queries are slower than plain logs.
- Free text must never be added to the clear part. The registry marks refs explicitly and conformance vectors check it.

## Related

- [Receipts](../04-contracts/receipts.md)
- [Crypto-shredding](crypto-shredding.md)
- [Backup and sync](backup-and-sync.md)
- [Fleet](../10-operations/fleet.md)
- [ADR-0053: Receipt payloads sealed per human per month](../11-decisions/adr-0053-receipt-payload-encryption.md)
