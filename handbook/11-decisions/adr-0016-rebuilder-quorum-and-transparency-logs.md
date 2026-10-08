# ADR-0016: Rebuilder quorum and transparency logs

> A build output is published only when at least k of n independent rebuilders (default 2-of-3, with different organisations and infrastructure) produce the same content-addressed output and sign realisation attestations. Attestations and release statements go into C2SP tile-based transparency logs. Clients accept only entries included under checkpoints cosigned by at least two witnesses.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Supply chain | forge, tlog, depot, courier, vouch, keylos |

## Context

- A binary-cache signature says "this cache vouches for this mapping", not "this source produced these bytes" (Nix narinfo signatures; https://docs.tvix.dev/rust/nix_compat/narinfo/index.html). Trustix proposed M-of-N builder logs but saw little deployment (https://tweag.io/blog/2020-12-16-trustix-announcement/).
- Reproducibility is feasible at scale:
  - Debian trixie is ≈96.5% reproducible, and since May 2026 Debian blocks migration of non-reproducible packages (https://lwn.net/Articles/1072314/);
  - Arch core is ≈95% (https://tests.reproducible-builds.org/archlinux/).
- Transparency logs make targeted backdoors detectable. Go's sumdb is the model (https://sum.golang.org). Rekor v2 moved to tile-based logs (https://blog.sigstore.dev/rekor-v2-ga/). C2SP specifies tiles, checkpoints and cosignatures.

## Decision

- forge rebuilder mode builds published derivations and signs in-toto realisation attestations (`https://keylos.org/realisation/v1`).
- The realisation log `log.keylos.org/realisations` and the release log `log.keylos.org/releases` follow C2SP tlog-tiles, tlog-checkpoint and tlog-cosignature.
- depot and courier require the quorum (default 2-of-3; the release policy can raise it) plus inclusion under a checkpoint with at least two witness cosignatures.
- Owners may add their own rebuilder as a required quorum member.
- Release statements bind stream, OS generation, UKI hash, PCR predictions and the revocation-list digest.

## Alternatives considered

| Option | Why not |
|---|---|
| Single build farm + signing key | One compromised builder or key backdoors everyone undetectably |
| Sigstore Rekor only | Logs signatures, not reproduction agreement; we still use Sigstore identities for publishers |
| Local rebuild of everything | Too expensive for most users; offered as an option |

## Consequences

### Positive
- One compromised builder or signing key can't silently ship a backdoor.
- Split views are detectable by witnesses, including the owner's phone.

### Negative
- Publication waits for the quorum. Emergency fixes may use temporary grafts ([ADR-0018](adr-0018-grafts-are-temporary.md)).
- Governance: who runs rebuilders and witnesses, and how collusion is made unlikely (different jurisdictions and funding).
- Doesn't detect malicious *source* ([ADR-0019](adr-0019-source-rules-after-xz.md)).

## Related

- [Transparency and rebuilders](../05-integrity/transparency-and-rebuilders.md)
- [tlog](../03-components/tlog.md)
- [forge](../03-components/forge.md)
