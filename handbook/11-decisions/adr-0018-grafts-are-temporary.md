# ADR-0018: Grafts are temporary

> Security fixes deep in the dependency graph normally ship as real rebuilds, made cheaper by content-addressed early cutoff. For an actively exploited bug, an **emergency graft** may rewrite references to a patched library. Grafted generations are marked, shown in status, and replaced automatically when the real rebuild lands.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Supply chain | forge, depot, courier, pkgs |

## Context

- Hermetic stores face "rebuild the world" for core library fixes (openssl, glibc).
- Guix grafts rewrite store references (including inside binaries) to a patched replacement, with constraints (same name length, same ABI). Downsides: the deployed bytes are not the output of any source build; ungrafted outputs must still be built first; grafts accumulate (https://guix.gnu.org/manual/en/html_node/Security-Updates.html, https://guix.gnu.org/blog/2020/grafts-continued).
- Content-addressed outputs give early cutoff: dependents whose bytes don't change aren't rebuilt.

## Decision

- Default: a real rebuild with early cutoff. Releases go out once the rebuilder quorum agrees.
- Emergency graft: allowed only for a CVE marked actively exploited by the release security team.
  - The generation manifest carries `grafted: true` (a core manifest field) and depot lists the generation as grafted in `status`.
  - Graft generations need the same quorum; rebuilders reproduce the graft step.
  - status, update UI and attestation show "grafted".
  - courier replaces them as soon as the real rebuild is published, and a graft can't outlive two release cycles.

## Alternatives considered

| Option | Why not |
|---|---|
| Permanent grafts (Guix-style) | Pile-up; breaks "derivation = what runs" |
| Always full rebuild | Hours to days of exposure for actively exploited bugs |
| Stable-ABI shared libraries updated in place | Breaks content addressing and integrity |

## Consequences

### Positive
- Fast response to exploited bugs without permanently weakening reproducibility.

### Negative
- Two code paths in forge and depot. Graft correctness relies on ABI compatibility.

## Related

- [Supply chain](../05-integrity/supply-chain.md)
- [depot](../03-components/depot.md)
- [ADR-0016: Rebuilder quorum and transparency logs](adr-0016-rebuilder-quorum-and-transparency-logs.md)
