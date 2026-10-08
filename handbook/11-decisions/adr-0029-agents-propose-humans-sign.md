# ADR-0029: Agents propose, humans sign

> Agents never change the system directly. They produce proposals (config diffs, package-set changes, policy diffs, overlay merges) built and tested in their workbench. The human reviews the effect rendering on the trusted path and signs with presence, the same path the human's own changes take.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Agents | aide, config, depot, broker, bench, strata |

## Context

- The Replit agent dropped a production database during a code freeze (https://www.eweek.com/news/replit-ai-coding-assistant-failure/). Google Antigravity wiped a drive root (https://www.techradar.com/ai-platforms-assistants/googles-antigravity-ai-deleted-a-developers-drive-and-then-apologized). Both acted directly on live state.
- Cross-agent privilege escalation (one agent editing another's config) shows that agent-writable config is code (https://simonwillison.net/2025/Sep/24/cross-agent-privilege-escalation).
- Linux kernel policy requires `Assisted-by:` trailers and forbids AI `Signed-off-by:`; a human certifies.

## Decision

- Agents have no write access to any configuration that any harness or agent reads, nor to the config repository. They work on workbench forks.
- System changes are `Config.propose` from a fork, producing a plan for the human. `Plan.apply` needs presence.
- Overlay merges into real trees are T3 (`AgentSession.review` → `Vm.commit` → strata transaction with an undo snapshot).
- Agent commits carry `Assisted-by:` and `Agent-Session:` trailers and are signed by the session key. Humans sign the merge.
- Policy diffs from agents are proposals only.

## Alternatives considered

| Option | Why not |
|---|---|
| Agents with scoped admin grants | Scoped write to config is still persistence for an injected agent |
| Auto-apply if tests pass | Tests don't capture intent or security |

## Consequences

### Positive
- One path for system change, ending at the owner's touch. Agents can't persist anything system-wide.

### Negative
- Humans remain the bottleneck for system changes (intentionally).

## Related

- [Agent principal](../07-agents/agent-principal.md)
- [Configuration generations](../08-state/config-generations.md)
- [ADR-0011: Owner presence via FIDO2](adr-0011-owner-presence-fido2.md)
