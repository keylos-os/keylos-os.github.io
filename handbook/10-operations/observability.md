# Observability

> keylos has three separate records: **logs** for diagnosis, **metrics** for health, and **receipts** for accountability. Each has its own owner, retention and trust level.
> Logs and metrics are attributed by connection, never by content. Logs are encrypted per human and can be forgotten. Receipts are signed and permanent.

**Status:** specified (v1.0). Logs, metrics and crash reports by [journal](../../specs/journal/spec.md); receipts by [ledger](../../specs/ledger/spec.md).

## Three records

| | Logs | Metrics | Receipts |
|---|---|---|---|
| Purpose | Debugging | Health, capacity | Who did what, with which authority |
| Owner | `journal` | `journal` | `ledger` |
| Attribution | Per-principal stream created by `warden` | Same | Writer service signature + subject principal |
| Integrity | Sealed segment hashes recorded in the ledger | None | Hash chain, signatures, TPM-anchored checkpoints |
| Confidentiality | Per-human encryption, crypto-shreddable | Labels hashed for non-owners | Minimal data, readable by the subject's human and the owner |
| Retention | 30 days / 2 GiB default | 7 days at 1-minute resolution | Permanent (pruning only by explicit owner action) |

## Logs

Every process's stderr (and stdout, unless redirected) is a `SOCK_SEQPACKET` stream to `journal`, created by `warden` at spawn and attributed to the principal. Programs can write:
- plain text lines (an optional `<N>` prefix sets the level), or
- structured records: byte `0x1E` followed by a CBOR map `{l, m, f}`.

| Task | Command |
|---|---|
| Follow your session's logs | `journal -f` |
| An app's warnings since boot | `journal --app org.example.Editor --level 4 --boot 0` |
| Everything an agent session did | `journal --session s-01JB…` (includes sub-sessions) |
| Kernel messages (owner) | `journal kernel` |
| Verify sealed log segments against the ledger | `journal verify --boot -1` |

Access is by principal:
- you read your own human scope;
- apps read only their own entries;
- agents read only their session subtree;
- the owner reads everything.

Reading private entries raises your session label like any other private read.

## Metrics

Programs emit metrics as records starting with byte `0x1F` (counters, gauges, histograms) on the same stream. `journal metrics` prints OpenMetrics text. A fleet scraper reaches it only through an explicit `gate` grant.

Key system metrics:

| Metric | From |
|---|---|
| `warden_spawn_duration_seconds{tier}` | warden |
| `warden_exec_denials_total` | warden (kl-exec) |
| `courier_metadata_expiry_seconds`, `courier_floor` | courier |
| `boot_unlock_seconds`, `boot_vbu_result` | boot via courier |
| `devd_suspend_ack_seconds{component}` | devd |
| `journal_dropped_total{reason}` | journal |

## Crash reports

- **Default:** a symbolised backtrace of the crashing thread. **No core file is kept.**
- **Opt in:** `journal keep-cores <app> on` keeps cores for 7 days, encrypted with your key.
- **Never kept:** cores of sessions labelled `secret`.
- **Parsing:** cores are parsed in a separate sandboxed worker, because a crashed program may be malicious.
- **Notification:** crash notifications are grouped, at most once per app per hour.

## Receipts

Receipts are covered in the ledger pages. From an operations perspective:

| Question | Command |
|---|---|
| What happened to this file? | `why <file>` (provenance) |
| What did this session do? | `ledger query --session s-…` |
| Which updates were applied? | `ledger query --event update.commit` |
| Was anything spawned outside normal patterns? | `ledger query --event spawn --since …` |

## Remote shipping

Off by default. When configured, `journal` forwards the `_system` scope and opted-in human scopes to syslog-over-TLS or OTLP sinks through `gate`. Entries labelled private or higher are never forwarded unless the sink is marked safe for that data in policy.

## Limitations

- Logs are not evidence: an attacker who compromises a service can write misleading log lines under that service's name. Use receipts for accountability.
- While a human is locked, their log entries are buffered in memory (8 MiB) and written when they unlock. Overflow is counted and dropped.

## Related

- [Updates and rollback](updates-and-rollback.md)
- [journal spec](../../specs/journal/spec.md), [ledger spec](../../specs/ledger/spec.md)
- [ADR-0031 Receipts ledger](../11-decisions/adr-0031-receipts-ledger.md), [ADR-0032 Crypto-shredding](../11-decisions/adr-0032-crypto-shredding.md)
