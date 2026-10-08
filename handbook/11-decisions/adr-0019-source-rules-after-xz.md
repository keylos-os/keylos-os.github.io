# ADR-0019: Source rules after xz

> forge enforces source-level rules: pin sources by git tree hash; accept tarballs only with an explained diff against git; always regenerate build-system output; quarantine test fixtures from the build phase; enforce a dependency budget for privileged daemons; and raise review for risky maintainer signals.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Supply chain | forge, pkgs, keylos |

## Context

- The xz-utils backdoor (CVE-2024-3094):
  - lived in the **release tarball's** `build-to-host.m4`, which was not in git, and in binary "corrupt" test files (https://openwall.com/lists/oss-security/2024/03/29/4, https://securelist.com/xz-backdoor-story-part-1/112354/);
  - reached sshd through distro patches that linked libsystemd, and so liblzma;
  - used IFUNC resolvers to hook RSA functions at load time.
- Reproducible builds would not have caught it, because the malicious input reproduced faithfully.

## Decision

1. **S1:** inputs pinned by git tree hash (protocols §11.2). Tarballs only with a recorded, mechanically checked diff against the tagged tree, with each difference justified. Unexplained differences fail the build.
2. **S2:** generated build files (`configure`, `*.m4` output, `Makefile.in`) are deleted and regenerated.
3. **S3:** build and check are separate sandboxes. The build phase can't read `tests/`, fixtures or binary blobs. Blobs must be generated from source or quarantined with review.
4. **S4:** dependency budget for tier-0 services. Transitive linkage is reviewed. Optional codecs are `dlopen`ed. Builds use `-z now` and full RELRO.
5. **S5:** maintainer-health signals (new maintainer, bus factor of one, release-process changes) raise an update's review tier (SLSA source-track thinking, https://slsa.dev/spec/).

## Alternatives considered

| Option | Why not |
|---|---|
| Trust upstream tarballs | The exact vector of xz |
| Rely on reproducible builds | Reproduces malicious input faithfully |
| Full manual review of everything | Doesn't scale; review is focused by S5 |

## Consequences

### Positive
- Removes the tarball and fixture vectors and narrows the reach into privileged daemons.

### Negative
- Recipe maintenance is heavier (regenerating autotools, curating fixtures).
- Doesn't detect malicious code committed to git. Human review is still required.

## Related

- [Supply chain](../05-integrity/supply-chain.md)
- [forge](../03-components/forge.md)
- [Residual risks](../06-security/residual-risks.md)
