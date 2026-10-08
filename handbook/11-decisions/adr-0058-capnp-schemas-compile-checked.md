# ADR-0058: Cap'n Proto schemas are extracted from protocols and compiled in CI

> The Cap'n Proto schemas in protocols are normative text inside `spec.md`. Every change to protocols extracts each schema block into a file and compiles the set with the reference `capnp` compiler, plus a structural check for file IDs and ordinals. Every repo spec re-extracts its embedded excerpts mechanically, so a schema that doesn't compile can't reach an implementation.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Contracts / tooling | protocols, every repo spec, docs |

## Context

- protocols 1.0 defines 42 schema files (§7.3, §7.5) as fenced code blocks in `spec.md`. 30 repositories embed parts of them verbatim and generate bindings from the `keylos-schemas` crate.
- During the integration rounds, schemas were edited by hand many times: fields appended, interfaces moved between files, IDs renumbered (Appendix A–C). Prose review catches missing fields but not syntax errors, duplicate ordinals, or a reference to a struct that moved to another file.
- Cap'n Proto schemas fail at code-generation time, which is late: a broken schema would surface only when the first implementer runs `capnpc-rust`.
- Hand-copied excerpts drift. A repo spec that quotes an old struct is worse than one that quotes nothing, because it looks authoritative.

## Decision

- **Extraction.** `protocols/tools/extract-schemas` writes every `capnp` block of `spec.md` to `schema/<file>.capnp`, using the file ID line and the `# <name>.capnp` marker to name the file. The extracted files are the published `schema/` directory of the repo; there is no second source.
- **Compile gate.** CI runs `capnp compile -o-` (reference compiler 1.x) on all extracted files together. Any error fails the change.
- **Structural gate.** A checker verifies balanced braces, unique file IDs (all in `0xc7a1e5d3b2f4xxxx` for shared files), and unique, gap-free ordinals per struct, union and interface. Ordinals may only be appended (protocols §7.4).
- **Negative control.** The CI job also compiles one deliberately broken file and expects failure, so a misconfigured compiler can't pass silently.
- **Excerpts.** Repo specs embed protocols text only through markers that a script expands from the current `protocols/spec.md` (each repo ships `tools/embed.py`). CI in each repo re-runs the expansion and fails if the result differs from the committed spec.
- **Docs.** `make registry` regenerates the facet, interface and receipt blocks of the handbook's component pages from protocols §7.5, §19.2 and §19.3.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep schemas only in `.capnp` files and link them from the spec | Splits the normative text; repo specs could no longer be self-contained (ADR-0001) |
| Review-only process | Missed errors in practice; ordinal clashes are hard to see in a diff |
| Generate the spec from `.capnp` files | Schemas carry normative `#!` comments that belong next to prose; the spec stays the source |
| Compile only the schemas a repo uses | Cross-file imports break silently when a struct moves |

## Consequences

### Positive
- Every published schema compiles; implementers start from working bindings.
- Excerpts in the 30 repo specs can't drift from protocols without failing CI.

### Negative
- Protocols changes need the toolchain (`capnp` 1.x) in CI.
- Marker-based embedding constrains how repo specs quote protocols (whole sections or filtered rows, not free-form paraphrase).

### Follow-ups
- Run the extraction and compile gate on every protocols release candidate, and attach the extracted `schema/` tree to the release.

## Related

- [ADR-0001: Multi-repo, protocols as the only coupling](adr-0001-multi-repo-protocols-only-coupling.md)
- [ADR-0004: capwire, no system bus](adr-0004-capwire-no-system-bus.md)
- [Versioning](../04-contracts/versioning.md)
- [System interfaces](../04-contracts/system-interfaces.md)
