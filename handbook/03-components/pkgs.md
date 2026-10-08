# pkgs

> The package recipe collection. pkgs holds Nickel recipes for the base set (toolchains, libraries, interpreters patched for `AT_EXECVE_CHECK`, system services' dependencies) and for desktop and developer applications, together with their manifests and cmdsigs.
> Everything in pkgs builds hermetically with [forge](forge.md) and must reproduce bit for bit before it can be published as tier 1.

**Status:** specified (v1.0) · **Spec:** [`pkgs/spec.md`](../../specs/pkgs/spec.md)

## Responsibilities

- **Base set:** the bootstrap chain from a full-source seed (hex0 / live-bootstrap lineage), GCC and LLVM toolchains, Rust, libc, core libraries, and the runtimes apps share.
- **Interpreters:** Python, Perl, Lua, Ruby, Node.js and a POSIX sh for the legacy tier, all patched to honour `AT_EXECVE_CHECK` and the exec securebits. The patches are carried until upstreams adopt them.
- **Applications:** desktop apps (browser with `needs.jit`, office, media), CLI tools with cmdsigs for typed pipes, developer tools for workbenches.
- **Manifests:** each generation's `keylos.manifest/1` with least-privilege `needs`. Capability changes are reviewed like code.
- **Reproducibility gate:** non-reproducible packages are tier 2 by default, unless a recorded owner exception applies.
- **Security metadata:** CVE tracking, revocation candidates, graft requests.

## Interfaces

pkgs is data. It is consumed by forge (builds), [depot](depot.md) (manifests), and [keylos](keylos.md) (image composition).

## Runs as

Not a runtime component.

## Key decisions

- [ADR-0043: Non-reproducible means tier 2](../11-decisions/adr-0043-non-reproducible-means-tier-2.md)
- [ADR-0019: Source rules after xz](../11-decisions/adr-0019-source-rules-after-xz.md)
- [ADR-0008: Host executes only sealed code](../11-decisions/adr-0008-host-executes-only-sealed-code.md)

## Related

- [Package an app](../12-guides/package-an-app.md)
- [Supply chain](../05-integrity/supply-chain.md)
- [forge](forge.md)
