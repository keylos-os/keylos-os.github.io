# ADR-0043: Non-reproducible means tier 2

> A generation whose manifest says `reproducible: false`, or that the rebuilder quorum couldn't reproduce, runs in tier 2 (a microVM) by default. The owner may record a per-generation exception, which is shown in status and attestation.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Supply chain / execution | depot, warden, bench, compat, pkgs, broker |

## Context

- Reproducibility is what lets independent rebuilders confirm that binaries come from source ([ADR-0016](adr-0016-rebuilder-quorum-and-transparency-logs.md)).
- Some software won't reproduce in v1.0 (proprietary binaries, PGO without committed profiles, some JVM and Go edge cases). Debian is around 96% reproducible, not 100%.
- Excluding all of it blocks adoption. Treating it the same as verified software weakens the guarantee.

## Decision

- depot marks such generations `reproducible: false`. The effective tier is `max(manifest.tier, 2)` unless an owner exception exists.
- An owner exception is a presence-signed `keylos.exception/1` record (kind `reproducibility`), scoped to a generation name and publisher (or one generation), stored by depot in `/store/evidence/exceptions/`, and shown in status, in the update UI and in attestation reports.
- Legacy images from the internet are treated the same way.
- The base OS image must be 100% reproducible to be released.

## Alternatives considered

| Option | Why not |
|---|---|
| Refuse non-reproducible software | Blocks common apps |
| Treat equally | Undermines the quorum guarantee |

## Consequences

### Positive
- The reproducibility guarantee keeps its meaning. Unverifiable code is contained by a VM boundary.

### Negative
- Overhead for affected apps (VM start, GPU limitations). Some friction for owners who need exceptions.

## Related

- [Supply chain](../05-integrity/supply-chain.md)
- [Confinement tiers](../06-security/confinement-tiers.md)
- [depot](../03-components/depot.md)
