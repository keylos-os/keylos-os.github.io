# journal

> Structured logs, metrics and crash reports. warden connects every process's stderr to a journal stream, where it writes text lines or structured CBOR records. journal indexes the records by principal and session, enforces per-principal quotas, and serves queries and live follows.
> Logs are for operating the machine. Accountability lives in the [ledger](ledger.md).

**Status:** specified (v1.0) · **Spec:** [`journal/spec.md`](../../specs/journal/spec.md)

## Responsibilities

- **Ingest:** `Journal.writer` returns a `SOCK_SEQPACKET` stream. Records are plain text, or `0x1E` followed by a CBOR map `{l, m, f}` (protocols §10.6). The principal is stamped by journal from the peer identity, never trusted from the record.
- **Storage:** compressed segments with per-principal rate limits and quotas. Rotation by size and age. Secret-pattern redaction as a safety net.
- **Query:** filters by principal prefix, session, level, time and fields. `follow` for live tails.
- **Metrics:** counters and gauges exported by services (OpenMetrics text over a capwire stream), plus a local time series store with short retention.
- **Crashes:** core dumps captured by warden, stored encrypted in a crash-report unit (crypto-shreddable), and shared only by explicit user action.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Journal` (`journal.capnp`) | Facets `client`, `admin` |
| Provides | `JournalWarden`, `Crashes`, `Metrics` (`journal-sys`) | Facets `warden`, `client`, `admin`, `fleet` |
| Consumes | warden | Log streams attached per principal through `JournalWarden.attach` |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| journal | `client` | every principal | `writer`, `query`/`follow` (own), `Crashes` (own human), `Metrics` (own) |
| journal | `admin` | owner `shell` | all |
| journal | `warden` | warden | `JournalWarden` |
| journal | `fleet` | fleet | `Metrics` (aggregate, no user data) |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`journal-sys.capnp`](../../specs/protocols/spec.md#759-journal-syscapnp) | `0xc7a1e5d3b2f40028` | `JournalWarden`, `Crashes`, `Metrics` |
<!-- /generated:sysif -->

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `journal.segment`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Runs as

A t0 service owning `/var/log/journal/`.

## Key decisions

- [ADR-0031: Receipts ledger](../11-decisions/adr-0031-receipts-ledger.md) (why logs are not the audit trail)
- [ADR-0039: Secrets never in env](../11-decisions/adr-0039-secrets-never-in-env.md)

## Related

- [Observability](../10-operations/observability.md)
- [ledger](ledger.md)
