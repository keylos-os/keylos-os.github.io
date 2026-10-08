# Transparency and rebuilders

> No single party can ship a keylos binary that nobody else can see. Independent rebuilders must reproduce every
> release bit-for-bit, their attestations go into public append-only logs, and witnesses cosign those logs so that a
> targeted release to one victim is detectable. This page explains the roles, the logs and what clients verify.

Status: specified (v1.0). Components: [tlog](../../specs/tlog/spec.md), [forge](../../specs/forge/spec.md) (`forge-rebuilder`), [depot](../../specs/depot/spec.md) (verification), [courier](../../specs/courier/spec.md), [vouch](../../specs/vouch/spec.md) (personal witness).

![Supply chain from source to execution](../images/supply-chain.svg)

## The problem this solves

A binary cache signature says "the cache vouches for this mapping from recipe to bytes". If the build farm or its key is compromised, every machine trusting the cache installs the backdoor, and nobody can tell. keylos replaces "trust the builder" with three checks:

| Check | Question answered | Mechanism |
|---|---|---|
| Rebuilder quorum | Do independent parties get the same bytes from the same source? | k-of-n realisation attestations from distinct operators |
| Transparency | Is what my machine was shown also visible to everyone else? | Entries in append-only logs with inclusion proofs |
| Witnessing | Is everyone shown the same log? | Checkpoints cosigned by a threshold of independent witnesses |

## Roles

| Role | Who | Holds | Does |
|---|---|---|---|
| Release engineering | keylos project | release-stream keys (HSM) | Publishes candidates, signs generation statements and release statements |
| Rebuilder | ≥ 3 independent operators (project + others) | Own HSM key, own hardware, own bootstrapped toolchain | Rebuilds every candidate from source, attests matches, reports mismatches |
| Log operator | keylos project | Log note keys (HSM) | Runs the realisation and release logs (C2SP tlog-tiles) |
| Witness | ≥ 3 independent organisations, plus each owner's phone | Witness keys | Cosigns checkpoints only after verifying consistency |
| Monitor | Anyone | Nothing | Follows logs, checks rules, raises alerts |

Rebuilder operators must be independent organisations on their own infrastructure. The set includes at least one x86-64 and one aarch64 operator independent of each other, and each bootstraps its compiler from the `hex0` seed and passes the diverse double-compiling check.

## The two logs

| Log | Entries | Read by |
|---|---|---|
| `log.keylos.org/realisations` | Realisation attestations (`drv` + output → generation digest, signed by a rebuilder), bootstrap and DDC attestations | `depot` (quorum), monitors |
| `log.keylos.org/releases` | Release statements (`keylos.release/1`: stream, `seq`, `floor`, per-profile OS generation, UKI hash and PCR11/PCR12 predictions, revocation-list serial and digest, rebuilder quorum) | `courier`, `vouch` (for verify-before-unlock), `installer`, monitors |

Both logs are static: tiles are immutable files served from object storage and CDNs. Rotating a log key means starting a new log with a new origin and freezing the old one.

## Release flow

```
candidate drvs (signed)  ──►  rebuilders rebuild  ──►  attestations ──► realisation log
                                                                          │
release engineering waits for k distinct operators ◄──────────────────────┘
        │
        ├─ signs generation statements (keylos.genstmt/1)
        ├─ appends the keylos.release/1 statement to the release log (witnessed)
        └─ publishes TUF targets (OCI artifacts + provenance referrers)
```

A mismatch from any rebuilder blocks the release and produces a public mismatch report with a diffoscope summary.

## What a client verifies

`courier`, the only TUF client, resolves a channel name into an OCI reference, the expected generation, the attestations with their proofs and the generation statement (`CourierResolver.resolve`). When `depot` installs the generation it checks, among other things:

1. at least `threshold` realisation attestations from distinct listed operators, all naming the generation's `drv` and digest;
2. an inclusion proof for each attestation, against a checkpoint carrying at least `witnessThreshold` witness cosignatures;
3. for OS generations, the release statement's inclusion in the release log.

Proofs travel with the artifact (`keylos.tlogproof/1` bundles), so verification also works offline and inside `.klb` bundles. Each machine stores the latest checkpoints it has seen and demands consistency proofs for newer ones, so a log cannot later present a history that contradicts what the machine already saw.

## Split views and the personal witness

A targeted attack would show one victim a log containing a malicious release while showing everyone else a clean log. Witnesses refuse to cosign two different roots for the same tree size and keep the conflicting checkpoints as public evidence.

The `vouch` phone app is a **personal witness**: it remembers the release-log checkpoints your machines have reported and the ones it fetched from the network, and alerts if they are inconsistent. Owners can also add their **own rebuilder** and require its attestation for every installed generation.

## What the logs do not do

- Logs do not judge content. A malicious but correctly signed entry is logged faithfully; detection is the job of monitors, rebuilders and reviewers.
- Logs do not provide availability for packages; TUF and OCI mirrors do.

## Limitations

- Collusion of k rebuilders and the release key can still ship a malicious build of benign source; the defence is operator independence and public scrutiny of the logs.
- Witness diversity depends on governance; a threshold of 2 from at least 4 operators is the v1.0 default.
- Embargoed security fixes are built privately and attested by pre-arranged rebuilders before publication, which concentrates trust in that window.

## Related

- [Supply chain](supply-chain.md)
- [vouch spec](../../specs/vouch/spec.md) (personal witness, verify-before-unlock)
- [tlog spec](../../specs/tlog/spec.md) · [forge spec](../../specs/forge/spec.md) · [depot spec](../../specs/depot/spec.md)
- [ADR-0016 rebuilder quorum and transparency logs](../11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md)
- [ADR-0017 TUF over OCI](../11-decisions/adr-0017-tuf-over-oci.md)
