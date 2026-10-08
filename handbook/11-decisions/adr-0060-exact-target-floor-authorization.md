# ADR-0060: The OS floor is written only to one exact, release-signed target

> The TPM os-floor index can be written only under a release-signed policy that binds the booted UKI, the exact new value and the condition "current floor ≤ new value". A compromised writer can therefore never lower the floor, even with raw TPM commands.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Boot / updates | boot, courier, installer, keylos, protocols |

## Context

- The floor (`0x01300102`) is the minimum release `seq` that can unlock the disk ([ADR-0014](adr-0014-tpm-pin-signed-pcr-policy.md)). Its write policy authorized `TPM2_NV_Write` in the release's `ready` phase but did not bind the value written. An application-level `max(current, target)` does not stop a compromised caller issuing raw TPM commands (ISSUES.md ISS-002).
- NV counters can't replace it: the floor is a release sequence number that jumps, and courier must be able to hold it below a pinned release.
- `PolicyNV` is a check before the write, not a compare-and-swap; `PolicyCpHash` binds command parameters but not monotonicity (https://tpm2-tools.readthedocs.io/en/latest/man/tpm2_policycphash.1/). Each alone is insufficient.

## Decision

- The index is `POLICYWRITE`, publicly readable (empty authValue for reads, including `PolicyNV`), with authPolicy `PolicyOR{NV_Read branch, PolicyAuthorize(release-stream key, "keylos/floor-write/1")}` (protocols §19.6, E29).
- Release tooling signs, per UKI, exactly one approved policy: PCR11 at that UKI's `ready` ∧ `PolicyNV(floor ≤ F)` ∧ `PolicyCpHash(NV_Write of F at offset 0)`, where F is that release's declared `floor`. Two releases never carry different F for the same UKI digest.
- Within one measured boot only one target is writable, so concurrent or stale sessions can only write the same F; older releases' policies need their own PCR11 and fail.
- courier writes exactly F after a healthy boot. A pin below F keeps the current floor; there are no intermediate values. A lost acknowledgment is retried by writing F again.
- Initialisation (installer UKI, cloud `seed` profile) uses `PolicyNvWritten(NO)`, valid only on a never-written index.
- A missing or unreadable floor after provisioning is a recovery and re-enrolment condition; the new baseline comes from the signed release statement being re-enrolled. A TPM clear destroys the history, and keylos says so.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep the unbound write policy | A compromised authorized writer can lower the floor |
| Monotonic counter as the floor | Different semantics (jumps, pins); a separate security-epoch counter remains a possible later design |
| `PolicyNV` only | Check-before-write; does not bind the value |
| `PolicyCpHash` only | Binds the value but not monotonicity |

## Consequences

### Positive
- "The floor cannot decrease" holds against callers that bypass courier.
- Pins and interrupted writes have explicit outcomes.

### Negative
- Release tooling signs one floor policy per UKI, and courier can no longer choose a floor between releases.
- An interrupted floor write that corrupts the index forces a recovery boot.

### Follow-ups
- Adversarial swtpm vectors: lower, wrong-index, wrong-offset, wrong-value and partial writes; stale and concurrent sessions; power loss during the write.

## Related

- [ADR-0014: TPM+PIN with a signed PCR policy](adr-0014-tpm-pin-signed-pcr-policy.md)
- [Boot chain](../05-integrity/boot-chain.md#the-release-floor)
- [Updates and rollback](../10-operations/updates-and-rollback.md)
- [protocols §19.6](../../specs/protocols/spec.md#196-tpm-objects)
