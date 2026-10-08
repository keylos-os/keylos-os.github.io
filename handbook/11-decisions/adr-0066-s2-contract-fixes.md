# ADR-0066: Contract fixes from the first authority-core implementation

> Implementing ledger, vault, hearth and broker exposed contract gaps. Broker mandates now use registered mandate-only effect kinds, receipt time is monotonic with re-sign on conflict, and development knobs live in a reserved `KEYLOS_DEV_*` namespace that production builds ignore.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Contracts | protocols, broker, ledger, vault, hearth, warden |

## Context

- The mandate validator accepted only §14.2 effect kinds or `x-…`, so the broker wrote `x-grant.*`, `x-debug.attach`, `x-pod.admit` and `constraints.x-channels`: authority expressed through extension members, which by design carry none (broker SPEC-NOTES N-1, N-2).
- The ledger required receipt `time` not earlier than the previous receipt. Concurrent writers whose later-signed receipt arrived first were refused, with no stated recovery (ledger SPEC-NOTES 7).
- The daemons read development variables (`KEYLOS_TPM_TCTI`, `KEYLOS_BROKER_POLICY_DIR`, `KEYLOS_HEARTH_SOFT_AUTHENTICATOR`) inside the reserved `KEYLOS_*` namespace, and there was no defined way to hand a service its TPM (warden SPEC-NOTES N5, N7).

## Decision

- **Mandate-only effect kinds** (protocols §14.2, §14.4, E2): `grant.<resource kind>`, `grant.declassify`, `debug.attach`, `pod.admit`, valid only in mandates written by the broker. `constraints.channels` records the permitted channels; the deciding channel must be in it unless it is `quorum`. A mandate draft is not a valid mandate until decided. `x-` members never carry authority.
- **Receipt time** (§13.1, E5): `time` never decreases along `seq`. The ledger sorts each group commit by time; an older submission fails `kl:invalid … re-sign` and the writer re-signs with a fresh time. Month units, shredding, retention and time filters stay contiguous ranges. Resubmission is a new receipt; logical deduplication belongs to the writer.
- **TPM hand-over and development knobs** (§10.5, E8): warden passes an open `/dev/tpmrm0` named in `KEYLOS_TPM_FD`. `KEYLOS_DEV_*` is reserved for development knobs (one TPM variable, `KEYLOS_DEV_TPM_TCTI`); production builds never read them and the real warden never sets them.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep `x-` kinds for broker mandates | Authority would hinge on extension members every verifier may ignore |
| Per-writer time monotonicity | A late receipt could land in an already shredded or past-retention month |
| Ledger-assigned time | The writer's signature covers `time`; the ledger can't change it |
| Let each daemon pick its own dev variables | Collides with the reserved namespace; no way for production warden to refuse them |

## Consequences

### Positive
- Relying services verify broker mandates with the shared validator.
- Receipt queries by time and month are exact.
- Development switches can't leak into production builds.

### Negative
- Writers must handle a re-sign retry.
- The S2 daemons need code changes ([S2 follow-ups](../publication-notes.md)).

### Follow-ups
- Drop the broker `x-` kinds, rename the daemons' development variables, add `fromSeq` paging to the ledger.

## Related

- [Receipts](../04-contracts/receipts.md)
- [Approvals](../07-agents/approvals.md)
- [ADR-0027: Effect outbox and mandates](adr-0027-effect-outbox-and-mandates.md)
- [ADR-0031: Receipts ledger](adr-0031-receipts-ledger.md)
- [protocols §14.4](../../specs/protocols/spec.md#144-mandates-keylosmandate1)
