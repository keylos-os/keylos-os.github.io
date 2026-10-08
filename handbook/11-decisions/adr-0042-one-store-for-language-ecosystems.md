# ADR-0042: One store for language ecosystems

> Language package managers keep their resolvers, but their lockfiles are translated into fixed-output fetches into the one keylos store. Cargo, npm, uv/pixi, Go modules and Maven lockfiles already contain content hashes, so no ecosystem gets its own trust root, cache or global install location.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Supply chain | forge, depot, bench, sdk, pkgs |

## Context

- Modern lockfiles already carry content hashes: Cargo.lock checksums, npm `integrity`, uv `hash`, pixi sha256. Nix ingests them (`importCargoLock`, crane, `buildNpmPackage`, uv2nix; https://wiki.nixos.org/wiki/Language_specific_Package_Helpers).
- A common *resolver* across ecosystems isn't realistic. A common *fetch-and-verify substrate* is, and that is what Nix fixed-output derivations, Bazel's repository cache and OCI blobs converge on.
- Hard parts: git dependencies, build scripts that fetch (`build.rs`, node-gyp, sdists), wheels that assume FHS paths, and granularity (eval time vs sharing).

## Decision

- forge translators convert lockfiles to fixed-output fetches (url + hash) into depot objects with fs-verity.
- Builds run with no network. Fetch-at-build scripts must be satisfied by pre-fetched inputs or the package is tier 2 / workbench-only.
- Granularity: one store object per upstream artifact (crate, tarball, wheel); per-project derivations for builds. Sharing happens at the artifact level.
- Inside workbenches, ecosystem tools (cargo, npm, uv) are configured to use the store as their cache and registry mirror through gate.

## Alternatives considered

| Option | Why not |
|---|---|
| Each ecosystem's own cache | Many trust roots and caches; no integrity |
| One universal resolver | Unrealistic |
| Per-package derivations for everything (nixpkgs style) | Eval-time explosion |

## Consequences

### Positive
- One integrity and GC model. Offline builds from the store. Dedup across projects.

### Negative
- Translator maintenance per ecosystem. Native extensions with FHS assumptions need patching or the legacy tier.

## Related

- [forge](../03-components/forge.md)
- [Developer workbench](../09-experience/developer-workbench.md)
- [ADR-0007: composefs + fs-verity store](adr-0007-composefs-fsverity-store.md)
