# ADR-0028: Approval tiers T0–T3

> Every authority decision maps to one of four tiers: T0 silent, T1 logged, T2 batched review, T3 synchronous trusted-path approval with rendered effects and argument provenance (and presence where required). Automated components, including classifiers, can only escalate a tier, never lower one.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Security / UX | broker, gate, atrium, aide, config, depot |

## Context

- Users accept 93% of manual permission prompts. Claude Code's auto-mode classifier still misses 17% of real over-eager actions (https://anthropic.com/engineering/claude-code-auto-mode).
- UI that gives "Continue" more weight than "See more" trains blind approval (https://github.com/github/github-mcp-server/issues/844).
- Meaningful approval is rare, shows *effects* not commands, shows where the inputs came from, and groups related actions.

## Decision

| Tier | Covers | Interaction |
|---|---|---|
| T0 | Reads and overlay writes within grants | None, receipt only |
| T1 | Reversible egress to granted hosts | None; may be escalated |
| T2 | Compensable effects, new hosts, widening a sub-principal's scope | Batched review on the trusted path |
| T3 | Irreversible effects, declassification, budget overrun, agent overlay merge, config apply, seal, policy change | Synchronous prompt with rendered effects and argument provenance. Presence REQUIRED for config apply, seal, policy change, payment, and policy-marked effects |

- Tiers come from Cedar `@tier` annotations, effect classes and the Rule of Two.
- Classifiers may escalate. No component may lower.
- Velocity breakers (repeated identical calls, fan-out, context growth) kill session subtrees.

## Alternatives considered

| Option | Why not |
|---|---|
| Prompt for everything | Fatigue; 93% acceptance |
| Classifier decides | Probabilistic; misses |
| Never prompt (allowlist only) | Can't handle novel irreversible effects |

## Consequences

### Positive
- Interruptions concentrate where they matter, and each one is meaningful and recorded.

### Negative
- Policy quality determines friction. Default policies must be curated.
- T2 batching adds latency to compensable actions.

## Related

- [Approvals](../07-agents/approvals.md)
- [Trusted path](../06-security/trusted-path.md)
- [ADR-0006: Cedar policy](adr-0006-cedar-policy.md)
