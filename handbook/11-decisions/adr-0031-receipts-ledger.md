# ADR-0031: A receipts ledger, separate from logs

> Every grant, approval, effect, transaction, seal, config change and agent action produces a DSSE-signed receipt that is hash-chained by ledger. ledger countersigns each receipt and publishes C2SP checkpoints anchored to a TPM monotonic counter, which owner-chosen witnesses can cosign. Logs (journal) are for operations; receipts are for accountability.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Audit | ledger, all tier-0 services, vouch, fleet, kish |

## Context

- After the agent incidents of 2025 (Replit, Antigravity), it was hard to reconstruct what happened. Agents even misreported their own actions.
- Signed, hash-chained action-receipt drafts exist (draft-sahu-agent-action-receipts, https://ftp.kaist.ac.kr/ietf/draft-sahu-agent-action-receipts-00.xml) and transparency-log designs with witness cosigning (https://arxiv.org/pdf/2609.12582), but there is no finalised standard.
- Logs are lossy, rate-limited and writable by the logging process. Accountability needs append-only, signed records from the component that made the decision, not from the actor.

## Decision

- The receipt format is `keylos.receipt/1` (protocols §13.1), with the event registry in §19.3 and repo-specific `x-<repo>.<event>` extensions.
- Only tier-0 writers (facet `writer`) append. ledger assigns `seq` and `prev` and countersigns.
- An RFC 6962 Merkle tree with inclusion and consistency proofs.
- C2SP checkpoints at least every 60 s while there is activity and at shutdown. Each checkpoint note carries the value of TPM NV counter `0x01300100`, which is incremented at most every 900 s, at shutdown, and immediately after security-class events (a TPM counter can only count, and frequent increments would wear the NV). Optional witnesses (vouch, fleet) through `LedgerWitness`.
- The ledger checkpoint time is also the clock's monotonic floor before NTS sync.

## Alternatives considered

| Option | Why not |
|---|---|
| Linux audit (auditd) | Heavy, lossy, no signatures |
| journal with sealing | Logs written by actors; forward-secure sealing protects integrity, not completeness |
| External SaaS audit | Offline machines; privacy |

## Consequences

### Positive
- Any artifact traces to session, inputs and approval. Tampering after a checkpoint is detectable.

### Negative
- Storage growth (bounded by retention for non-security events). Writers must handle ledger back-pressure: they fail closed for T3 actions.

## Related

- [Receipts](../04-contracts/receipts.md)
- [ledger](../03-components/ledger.md)
- [Observability](../10-operations/observability.md)
