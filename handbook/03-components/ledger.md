# ledger

> The append-only receipt log. Tier-0 services submit signed receipts. ledger assigns sequence numbers, hash-chains them, countersigns them, and every minute publishes a C2SP checkpoint anchored to a TPM monotonic counter.
> It answers "what happened, who did it, and who approved it" for every grant, effect, transaction, seal and config change.

**Status:** specified (v1.0) · **Spec:** [`ledger/spec.md`](../../specs/ledger/spec.md)

## Responsibilities

- Accept DSSE receipt envelopes (`keylos.receipt/1`) only on the `writer` facet, and only from tier-0 principals.
- Check the writer's signature against its `service/<name>` key. Assign `seq` and `prev`. Countersign with `service/ledger`. Store the final envelope.
- Keep a Merkle tree (RFC 6962 hashing) over all receipts. Serve inclusion and consistency proofs.
- Emit a C2SP signed-note checkpoint (origin `keylos-ledger/<machine-id-key>`) at least every 60 s while there is activity and at shutdown. Each note carries the value of TPM NV counter `0x01300100`, which is incremented at most every 900 s, at shutdown and right after security-class events.
- Optionally submit checkpoints to owner-configured witnesses ([vouch](vouch.md), [fleet](fleet.md)).
- Answer queries (principal prefix, session, event types, time range) and stream new receipts to watchers.
- Provide the "monotonic floor" for time before NTS sync (protocols §3.6).

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Ledger` (`ledger.capnp`) | Facets `writer` (`append`), `reader` (everything else, filtered) |
| Provides | `LedgerWitness`, `LedgerAdmin` (`ledger-sys`) | Facets `witness`, `admin`, `time` (`timeFloor`) |
| Consumes | TPM NV counter `0x01300100`, service key | Counter incremented at most every 900 s plus security events |
| Consumes | vault (facet `ledger`) | Crypto-shred keys for personal payload fields |
| Consumes | witnesses (vouch, fleet) through `LedgerWitness` | Cosignatures |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| ledger | `writer` | tier-0 services listed as writers in §19.3 | `Ledger` (all) |
| ledger | `reader` | every principal | `Ledger` except `append` (filtered, §7.3.5) |
| ledger | `witness` | vouch, fleet | `LedgerWitness` |
| ledger | `admin` | owner `shell` | `LedgerAdmin` (including `shred`) |
| ledger | `time` | net, warden, depot | `LedgerAdmin.timeFloor` |
| ledger | `vouch-heartbeat` | vouch | `Ledger.query`/`watch` restricted to metadata (time, subject human) of `user.login` receipts of every human (§20.19) |
| ledger | `fleet-export` | fleet | `LedgerAdmin.export` (metadata only unless an owner `fleet-receipt-access` exception covers the event type) |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`ledger-sys.capnp`](../../specs/protocols/spec.md#755-ledger-syscapnp) | `0xc7a1e5d3b2f40024` | `LedgerWitness`, `LedgerAdmin` |
<!-- /generated:sysif -->

## Runs as

A t0 service with a TPM-resident `service/ledger` key and exclusive write access to `/store/rcpt/`. No network except witness submission through gate.

## State

| Path | Content |
|---|---|
| `/store/rcpt/` | Receipt segments, tree tiles, checkpoints |
| TPM NV `0x01300100` | Checkpoint counter |

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `ledger.key.register`, `ledger.redact`, `ledger.alarm`, `ledger.witness`, `ledger.export`, `ledger.shred`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Readers

| Reader | Use |
|---|---|
| [kish](kish.md) `why` / `effects` | Trace a file or effect to its session and approval |
| [aide](aide.md) | Session timelines |
| [vouch](vouch.md), [fleet](fleet.md) | Witness checkpoints, detect split views |
| Owners | Audit of everything agents did |

## Key decisions

- [ADR-0031: Receipts ledger](../11-decisions/adr-0031-receipts-ledger.md)
- [ADR-0016: Rebuilder quorum and transparency logs](../11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md)

## Limitations

- An attacker with runtime root can stop new receipts from being written, but cannot rewrite history past the last checkpoint without the counter and witnesses noticing.

## Related

- [Receipts](../04-contracts/receipts.md)
- [Observability](../10-operations/observability.md)
- [Attestation and vouch](../05-integrity/attestation-and-vouch.md)
