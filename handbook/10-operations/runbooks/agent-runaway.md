# Runbook: agent runaway

> An agent session loops, burns through its budget, spawns too many sub-agents, or keeps asking for authority it shouldn't need. keylos bounds what any session can do: budgets are hard stops, fan-out and depth are capped, and irreversible effects wait in the outbox. This runbook is about stopping it cleanly and understanding why.
> Status: **specified (v1.0)**. Normative specs: [aide](../../../specs/aide/spec.md), [gate](../../../specs/gate/spec.md), [broker](../../../specs/broker/spec.md).

## Symptoms

| Symptom | Mechanism that fired |
|---|---|
| "Budget exhausted — session paused" | `gate` meter hit the budget caveat (hard stop) |
| "Velocity breaker tripped" | Repeated identical calls or runaway context growth killed the session subtree |
| Many approval prompts in a row from one session | The agent keeps requesting T2/T3 actions, possibly after reading injected content |
| "Fan-out limit reached" | The session tried to create more sub-sessions than its token allows |
| Unexpected label raise (`untrusted`) followed by declassification requests | The Rule of Two is blocking an exfiltration-shaped flow |

## Immediate actions

1. **Stop the session:** Agents app → session → **Stop**, or `aide stop <session>`. This kills the workbench VM subtree. Staged intents stay in the outbox, uncommitted.
2. **Deny pending prompts** from that session. Don't approve anything "just to make it stop".
3. If the agent's inputs may be hostile, for example it read a web page or an issue right before the requests began, keep the session for review instead of discarding it.

## Diagnosis

```
aide sessions                                     sessions and state
ledger query --session <id>                       every grant, label change, tool call, effect, approval
gate intents <session>                            staged intents and their rendered effects
gate meter <rootId>                               spent vs remaining budget
```

Questions to answer from the receipts:
- **Which input raised the label** (`label.raise` with source)? Untrusted content immediately before a burst of requests suggests prompt injection.
- **Which tool calls repeated?** A loop with identical arguments points to a harness or tool bug. Varying arguments chasing a goal point to the task or prompt.
- **Did anything commit?** `effect.commit` receipts list every external effect, with its mandate.

## Recovery

- **Nothing committed:** discard the session (`aide` → Discard). The overlay is dropped and the outbox intents are cancelled.
- **Compensable effects committed** (a draft PR, a calendar hold): `gate` lists their compensators; run them from the intent (`compensate`).
- **Irreversible effects committed:** each has a T3 mandate you approved. Handle them at the destination (recall the email if the provider supports it, close the issue). Then review why the approval looked acceptable; the mandate shows what was rendered.
- **Changes in the workbench overlay** you want to keep: use review and merge. Merging is a T3 action showing the diff.
- **Repeated injection from a source:** add a forbid for that host in your policy, or remove it from the template's allowed hosts. Both are config changes that need a touch.

## Verification

- `aide sessions` shows the session stopped or discarded.
- `gate intents <session>` shows no staged intents.
- The budget meter reflects the final spend. No `effect.commit` receipts appear after the stop time.

## Prevention

- Give sessions small budgets and short deadlines. Raise them per task, not globally.
- Keep sub-agent fan-out and depth caveats at the defaults.
- Pin tool and MCP server digests (templates do this by default). Treat a re-approval request for a changed tool as suspicious.
- Prefer templates whose harness declares a flow-proof runtime; they need fewer declassification approvals.

## Related

- [Suspected compromise](suspected-compromise.md)
- [aide spec](../../../specs/aide/spec.md)
- [gate spec](../../../specs/gate/spec.md)
- [ADR-0027: Effect outbox and mandates](../../11-decisions/adr-0027-effect-outbox-and-mandates.md)
