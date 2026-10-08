# tlog

> keylos's transparency logs and the library that verifies them. Two logs, realisations and releases, follow the C2SP tlog-tiles, tlog-checkpoint and tlog-cosignature specifications. Witnesses cosign checkpoints, and clients refuse anything that isn't included under a checkpoint with at least two witness cosignatures.
> This makes targeted backdoors and split views detectable.

**Status:** specified (v1.0) · **Spec:** [`tlog/spec.md`](../../specs/tlog/spec.md)

## Responsibilities

- **Log server:** append-only tile log (C2SP tlog-tiles) for:
  - `log.keylos.org/realisations`: DSSE realisation attestations from rebuilders;
  - `log.keylos.org/releases`: release statements binding stream, OS generation, UKI hash, PCR predictions and the revocation-list digest.
- **Checkpoints:** C2SP signed-note checkpoints, published at a fixed cadence.
- **Witness:** a witness implementation (C2SP tlog-cosignature) for independent operators, [fleet](fleet.md) and [vouch](vouch.md).
- **Client library (`keylos-tlog`):** inclusion and consistency proofs, witness-quorum checks, a local cache of the last seen checkpoint to detect rollback or split views.
- **Monitors:** a monitor mode that follows the logs and alerts on unexpected entries, for example a release for a stream signed outside the release process.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | HTTP tile API (C2SP tlog-tiles) | Static tiles plus checkpoint |
| Provides | Submission API | Authenticated rebuilder and release submission |
| Provides | `keylos-tlog` crate | Used by courier, depot, forge, vouch, fleet |
| Consumes | Witness endpoints | Cosignature collection |

## Runs as

Server components run on project infrastructure, outside keylos hosts. The client library runs inside courier, depot and vouch.

## State

Log tiles and checkpoints (server). Last verified checkpoint per log (client, inside `/var/lib/courier` and `/store/db`).

## Key decisions

- [ADR-0016: Rebuilder quorum and transparency logs](../11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md)
- [ADR-0017: TUF over OCI](../11-decisions/adr-0017-tuf-over-oci.md)

## Limitations

- A log shows that something was published; it doesn't show that it is benign. Source review is still required ([ADR-0019](../11-decisions/adr-0019-source-rules-after-xz.md)).

## Related

- [Transparency and rebuilders](../05-integrity/transparency-and-rebuilders.md)
- [Supply chain](../05-integrity/supply-chain.md)
- [Signed documents](../04-contracts/signed-documents.md)
