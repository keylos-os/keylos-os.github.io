# Budgets

> Every agent session has hard ceilings on money, model tokens and calls, enforced by gate before spending starts, not reported after. Sub-agents get budgets carved from their parent, so fanning out cannot multiply spending.
> Model usage is metered from provider responses. Local GPU time is charged by aide at configured prices.

**Status:** specified (v1.0). Components: [gate](../../specs/gate/spec.md) (meter), [aide](../../specs/aide/spec.md) (carving, local charges), [broker](../../specs/broker/spec.md) (budget facts in tokens).

## Units

| Unit | Counts | Typical source |
|---|---|---|
| `usd-micro` | Millionths of a US dollar | Model API usage × price table; local GPU minutes; paid APIs with a price rule |
| `tokens` | Model input + output tokens | Model API usage |
| `calls` | Requests | Model API calls; any metered host |

A budget is a token fact `budget("usd-micro", 5000000)`: a ceiling, not a balance. Spending is tracked by gate, keyed by token root ID and session.

## Hard stops

| Step | What gate does |
|---|---|
| Pre-authorize | Before forwarding a model request, reserve the maximum possible cost: input estimated from body size (bytes / 3) × input price, plus `max_tokens` × output price. If `max_tokens` is absent, gate inserts the provider default so the reservation is finite. |
| Refuse | If any ceiling on any account in the chain would be exceeded: HTTP 402 / `kl:budget` |
| Settle | Replace the reservation with the actual usage parsed from the response |
| Stream cut | For streaming responses, keep a running total and end the stream with `keylos_budget_exhausted` when the account reaches zero |
| Overrun bound | At most one in-flight response's actual cost minus its estimate |
| After exhaustion | No further spending until a T3 budget-overrun approval raises the ceiling |

Alerts are not enforcement. Runaway agent loops that cost thousands of dollars happened because spending only raised alerts. In keylos the ceiling is in the token, and gate enforces it.

## Carving for sub-agents

```
root session  budget usd-micro: 5 000 000
 ├─ child A   carved ≤ remaining of root, e.g. 1 000 000
 │   └─ grandchild A1  ≤ remaining of A
 └─ child B   ≤ remaining of root after A's reservations
```

- Every charge is applied to the session's own account **and all ancestors**.
- A child cannot spend beyond its own ceiling, and the root cannot be exceeded by the sum of its children.
- Creating a child with a budget above the parent's remaining amount is refused.
- Carving is a hard sub-meter in gate: the broker calls `GateMeterAdmin.carve(parentRoot, childRoot, budget)` when it delegates, and the child's token carries `budget_parent(...)`. gate enforces parent ≥ sum of children, and writes `budget.carve`.

## Model metering

gate parses usage per provider adapter:

| Adapter | Usage fields |
|---|---|
| `anthropic` | `usage.input_tokens`, `output_tokens`, cache creation and read tokens; SSE `message_start` / `message_delta` |
| `openai` | `prompt_tokens` / `completion_tokens` or `input_tokens` / `output_tokens`; final SSE chunk with usage (gate requests it) |
| `google` | `usageMetadata` |
| `openai-compatible` | As `openai` |
| `bedrock` | Body usage or token-count headers |

Prices come from configuration, in micro-dollars per million tokens per model ID. A request for a model missing from the price table is refused while a `usd-micro` ceiling applies.

The same adapters record the provider's reported model identifier and version in the session's `budget.charge` and `effect.*` receipts. That record drives the **model-drift rule** ([Approvals](approvals.md#model-drift)).

## Local models

Local runtimes run inside the workbench VM with the GPU attached. aide charges `usd-micro` per minute of GPU attachment at a configured price (default 0), via `gate.charge`. The `tokens` and `calls` ceilings still apply, if the local runtime is reached through the metered path.

## Inspecting and raising

```bash
aide budget s-01JB…                 # spent / reserved / remaining per unit
gate meter t-…                      # by root id
aide budget s-01JB… --raise usd-micro:2000000   # T3 approval on the trusted path
```

Configuration caps the largest budget a root session can get without T3 (`aide.maxBudget`).

## Receipts

| Receipt | When |
|---|---|
| `budget.charge` | Per model request; aggregated per minute for other charges |
| `budget.exhausted` | When a ceiling is hit |

`agent.stop` records the total spent per unit.

## Limitations

- Pre-authorization uses an estimate for input tokens. A request much larger than its byte size suggests (rare tokenizers) can over-reserve, never under-charge.
- Spending on services gate cannot see (a paid API reached through opaque TLS) is not metered. Use intercepted grants with a price rule, or keep such hosts out of agent grants.

## Related

- [Sessions and workbenches](sessions-and-workbenches.md)
- [Approvals](approvals.md)
- [gate specification](../../specs/gate/spec.md)
- [ADR-0005 Biscuit capability tokens](../11-decisions/adr-0005-biscuit-capability-tokens.md)
