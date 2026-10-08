# ADR-0027: Effect outbox and payload-bound mandates

> Effects outside the machine by non-human principals are classified as reversible, compensable or irreversible. Irreversible effects are staged as intents in gate's outbox, with a dry-run rendering, argument provenance and an idempotency key. They commit only with a `keylos.mandate/1` whose effect digest matches the exact payload.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Effects | gate, aide, broker, atrium, protocols |

## Context

- Sent emails, settled payments, published packages and production writes can't be undone. Practitioner consensus is prevention over compensation: dry-run, reserve, then commit, with irreversible pivots last and a human gate (https://tianpan.co/blog/2026/07/05/the-compensating-transaction-your-agent-never-runs).
- No agent runtime ships a general effect ledger. Claude Code checkpoints don't cover bash side effects or remote state (https://code.claude.com/docs/en/checkpointing).
- AP2 payment mandates (signed intent/cart, bounded amounts) show bounded, staged external effects (https://www.spark.money/research/google-ap2-agent-payment-protocol).
- Approving a *description* of an action is weaker than approving the *exact payload*. A mandate bound to a digest prevents bait-and-switch.

## Decision

- Effect kinds and default classes in protocols §14.2. Classes can be raised, never lowered.
- `Gate.stage(EffectIntent)` → `Intent` with states `staged → approved → committed`, or `failed`, `canceled`, `compensated`. `dryRun` renders the effect.
- Irreversible intents need a mandate whose `effects[].digest` equals the payload digest. Compensable ones may auto-commit within policy, with a registered compensator. Reversible ones run inside the transaction.
- Commits are idempotent by idempotency key. Pivots are ordered last.
- Payloads are stored under a per-session crypto-shred unit.

## Alternatives considered

| Option | Why not |
|---|---|
| Approve commands (`curl -X POST …`) | Users can't evaluate commands; arguments change after approval |
| Compensation only (sagas) | Many effects have no compensator |
| Block all external effects for agents | Removes most of the value of agents |

## Consequences

### Positive
- An injected agent can't send, pay or publish without a human seeing the exact effect.
- A complete receipt trail for every external effect.

### Negative
- Integrations must express effects as intents. Raw sockets to arbitrary hosts are T1/T2 egress, not effects; their limits are host allowlists plus labels.
- More latency for irreversible actions (by design).

## Related

- [Effects and outbox](../07-agents/effects-and-outbox.md)
- [gate](../03-components/gate.md)
- [Add an effect kind](../12-guides/add-an-effect-kind.md)
