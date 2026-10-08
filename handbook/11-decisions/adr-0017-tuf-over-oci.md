# ADR-0017: TUF over OCI for distribution

> OS and app generations are distributed as OCI artifacts (zstd:chunked layers with per-file TOCs, signatures and attestations attached through the Referrers API). Freshness, anti-rollback and key management come from TUF metadata. Clients verify TUF, then signatures, then transparency-log inclusion and quorum.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Supply chain | courier, depot, keylos, sdk |

## Context

- OCI registries are mirrored everywhere and content-addressed. OCI 1.1 Referrers attach signatures, SBOMs and attestations as separate manifests (https://www.redhat.com/en/blog/announcing-open-container-initiativereferrers-api-quayio-step-towards-enhanced-security-and-compliance).
- zstd:chunked adds a per-file TOC with chunk digests, so clients fetch only missing files, with up to ~90% savings on pulls (https://fedoraproject.org/wiki/Changes/zstd:chunked). That maps directly onto composefs objects.
- Signatures alone don't defend against rollback or freeze attacks. TUF's timestamp and snapshot roles and threshold root do.

## Decision

- Transport: OCI registries (any compliant mirror). Artifacts carry per-file TOCs mapped to `fsv256` objects.
- Metadata: a TUF repository per stream (`stable`, `beta`, `dev`). Root 3-of-5 offline, targets delegated per stream and per publisher, online timestamp and snapshot roles.
- Client order: TUF (fresh, not rolled back) → release-stream or publisher signature → tlog inclusion + witness quorum → rebuilder quorum → not revoked.
- Revocation lists are TUF targets.

## Alternatives considered

| Option | Why not |
|---|---|
| OSTree repos | Separate format from apps; GPG-centric; no TUF |
| Plain HTTPS + signatures | No freshness or rollback protection |
| Nix binary caches | No TUF; narinfo trust model |

## Consequences

### Positive
- Any registry can mirror keylos. Delta fetch is per file.
- Compromised mirrors can't roll back or freeze clients.

### Negative
- Running TUF and offline key ceremonies ([Key ceremonies](../10-operations/key-ceremonies.md)).
- Image-ID consistency issues with zstd:chunked tooling need care.

## Related

- [courier](../03-components/courier.md)
- [Updates and rollback](../10-operations/updates-and-rollback.md)
- [ADR-0016: Rebuilder quorum and transparency logs](adr-0016-rebuilder-quorum-and-transparency-logs.md)
