# ADR-0006: Cedar for policy

> Every authority decision is evaluated by broker against human-authored Cedar policies compiled into a signed `policy` generation. `forbid` always wins. A `permit` annotated `@tier("t2")` or `@tier("t3")` means "permitted after approval at that tier".

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Security | broker, gate, config, keylos (default policy) |

## Context

- Decisions must be deterministic, explainable, testable and evaluated outside every untrusted process. AWS Bedrock AgentCore evaluates Cedar at a gateway in front of every agent tool call, failing closed and logging decisions (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html).
- Cedar has a formally analysed semantics, a Rust implementation, schema validation and a policy analyser.
- OPA/Rego is more general, but slower to reason about for humans, and makes it easy to write policies that do I/O or depend on hidden data.
- The policy must map cleanly onto approval tiers. Interruptions should be rare and justified.

## Decision

- Policy language: Cedar with the `Keylos` schema (protocols §16): principals, paths, hosts, devices, secrets, effects, generations, services, budgets; actions `read`, `write`, `create`, `delete`, `exec`, `connect`, `bind`, `use`, `spend`, `spawn`, `stage`, `commit`, `delegate`.
- Decision mapping:
  - `forbid` → denied;
  - `permit` without annotation → T0/T1;
  - `permit @tier("t2"|"t3")` → approval at that tier;
  - no permit → denied.
- Policy is authored in the config repository, validated against the schema, compiled to a `policy` generation, and applied with owner presence ([ADR-0029](adr-0029-agents-propose-humans-sign.md)).
- Agents may propose policy diffs. They can't apply them.

## Alternatives considered

| Option | Why not |
|---|---|
| OPA/Rego | Powerful but harder to analyse and review; the general-purpose language invites complexity |
| Hand-written Rust rules | Not reviewable by owners; every change is a code release |
| SELinux/AppArmor policy | Kernel MAC is complementary, not a user-authorable decision engine for agents and effects |
| Only token caveats | Tokens carry grants; policy decides what may be granted |

## Consequences

### Positive
- Policies are small, reviewable and testable with the protocols `cedar/` vectors.
- One mechanism covers apps, agents, legacy software and effects.

### Negative
- Owners need good defaults. keylos ships a curated default policy, and writing custom policy is an advanced task ([Write policy](../12-guides/write-policy.md)).
- Context attributes (labels, depth) must be computed correctly by broker before evaluation.

## Related

- [Cedar policy](../04-contracts/cedar-policy.md)
- [Approvals](../07-agents/approvals.md)
- [ADR-0028: Approval tiers](adr-0028-approval-tiers.md)
