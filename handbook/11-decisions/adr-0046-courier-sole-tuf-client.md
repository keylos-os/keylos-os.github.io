# ADR-0046: courier is the only TUF client

> courier is the only component that speaks TUF. depot resolves `tuf:<stream>/<name>` through `CourierResolver.resolve` and installs from an exact OCI reference plus expected generation digest, attestations, proofs and generation statement. Freshness, rollback and freeze protection therefore live in one place.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Supply chain | courier, depot, installer, protocols |

## Context

- The courier and depot drafts both specified a TUF client: courier for OS updates, depot for apps. Two clients mean two copies of TUF metadata, two sets of expiry and rollback state, and two places where a freeze attack could be missed.
- TUF's guarantees (freshness through timestamp expiry, anti-rollback through version numbers, threshold root rotation) depend on persisted client state. That state must be consistent across OS and app updates, and must respect the time floor before the first NTS sync.
- depot's real job is verification and storage: generation statements, rebuilder quorum, inclusion proofs, capability diffs, fs-verity objects.

## Decision

- courier holds all TUF metadata and state, for OS release streams and app channels alike.
- `CourierResolver` ([protocols §7.5.6](../../specs/protocols/spec.md#756-courier-syscapnp)), served on courier facet `depot`, turns `tuf:<stream>/<name>[@version]` into a `Resolution`: an `oci://<repository>@sha256:<manifest>` reference, the expected generation, a JCS bundle of realisation attestations with `keylos.tlogproof/1` proofs, the publisher key, the quorum and the generation statement.
- depot never fetches TUF metadata. It installs from `oci://…@sha256:…#gen=fsv256:…` and verifies everything in the resolution before the generation becomes launchable.
- courier also distributes the revocation list (`keylos.revocations/1`) as a TUF target; depot reads the current list through `Depot.revocations`.

## Alternatives considered

| Option | Why not |
|---|---|
| A TUF client in both courier and depot | Duplicate state; inconsistent freshness decisions |
| A shared TUF library with separate state | Same duplication, plus the risk of the two stores diverging after a crash |
| depot as the only TUF client | depot would also have to own OS release logic, boot entries and PCR predictions |

## Consequences

### Positive
- One freshness and rollback decision for everything installed.
- depot stays a verifier and store, easier to reason about.

### Negative
- App installs depend on courier being up. courier is a tier-0 service with boot-time availability, so this matches the existing update dependency.

## Related

- [Transparency and rebuilders](../05-integrity/transparency-and-rebuilders.md)
- [Updates and rollback](../10-operations/updates-and-rollback.md)
- [courier](../03-components/courier.md), [depot](../03-components/depot.md)
- [ADR-0017: TUF over OCI](adr-0017-tuf-over-oci.md)
