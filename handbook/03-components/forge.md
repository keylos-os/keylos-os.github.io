# forge

> The hermetic builder. forge turns recipes into derivations (`keylos.drv/1`), builds them with no network in disposable VMs, enforces the source rules learned from the xz backdoor, translates language lockfiles into fixed-output fetches, and in rebuilder mode produces signed realisation attestations for the transparency log.
> The same binary is the local build tool, the distribution builder and an independent rebuilder.

**Status:** specified (v1.0) · **Spec:** [`forge/spec.md`](../../specs/forge/spec.md)

![Supply chain](../images/supply-chain.svg)

## Responsibilities

- **Recipes:** Nickel recipes compile to canonical JSON derivations (protocols §11.1). The `drv:` ref is SHA-256 over the JCS bytes.
- **Sources:**
  - git sources pinned by the canonical tree hash (protocols §11.2);
  - archives only with a recorded tarball-vs-git diff, and an unexplained difference fails the build;
  - generated build files are always regenerated;
  - test fixtures are quarantined from the build phase.
- **Sandbox:** builds run in a [bench](bench.md) VM with no network. Fixed-output fetches happen before the build. The `check` phase runs separately with read access to tests.
- **Reproducibility:** `SOURCE_DATE_EPOCH`, path normalisation, detached signatures. Signing derivations are separate from builds.
- **Lockfile translators:** Cargo, npm, uv/pixi, Go modules and Maven lockfiles become fixed-output fetches into [depot](depot.md).
- **Outputs:** imported as generations through `Depot.importTree` (forge facet). Output identity is content-addressed, which gives early cutoff.
- **Rebuilder mode:** rebuild published derivations, compare output digests, sign in-toto realisation attestations, submit to [tlog](tlog.md).
- **Sealing:** `forge seal` rebuilds a project output hermetically and requests an owner seal (presence, sealing window).

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | forge-local build interface | Facets `user`, `release` (grafts) |
| Consumes | depot (facet `forge`) | `importTree`, `seal`, `get` |
| Consumes | hearth `HearthSeal` (facet `seal`) | Sealing windows and seal signatures |
| Consumes | bench | Tier-3 build VMs |
| Consumes | gate | Fixed-output fetches only |
| Produces | Realisation attestations | in-toto Statement v1, predicate `https://keylos.org/realisation/v1`, with an `output` field |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| forge | `user` | `shell` | forge-local build interface |
| forge | `release` | release-engineering principals only | forge-local graft operations |
<!-- /generated:facets -->

## Runs as

The CLI runs as a `shell` principal. The local build daemon is a t0 service that drives bench. Rebuilder operators run forge on dedicated infrastructure.

## State

| Path | Content |
|---|---|
| `/var/lib/forge/` | Derivation cache, build logs |
| Rebuilder | Signing key `rebuilder/<operator>` in an HSM |

## Key decisions

- [ADR-0019: Source rules after xz](../11-decisions/adr-0019-source-rules-after-xz.md)
- [ADR-0016: Rebuilder quorum and transparency logs](../11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md)
- [ADR-0042: One store for language ecosystems](../11-decisions/adr-0042-one-store-for-language-ecosystems.md)
- [ADR-0012: Sealing windows](../11-decisions/adr-0012-sealing-windows.md)

## Related

- [Supply chain](../05-integrity/supply-chain.md)
- [Transparency and rebuilders](../05-integrity/transparency-and-rebuilders.md)
- [Seal a tool](../12-guides/seal-a-tool.md)
- [Package an app](../12-guides/package-an-app.md)
