# Agents

> In keylos, AI agents are principals with their own identity, attenuated authority, a disposable workbench, metered budgets and signed receipts. They are not features of an app.
> An agent can do anything inside its overlay. Everything that leaves the overlay (merging files, sending, paying, pushing) is staged, rendered as an effect, and committed only under policy or a human's signed approval.

**Status:** specified (v1.0). Components: [aide](../../specs/aide/spec.md) (sessions), [gate](../../specs/gate/spec.md) (effects, egress, budgets), [broker](../../specs/broker/spec.md) (tokens, labels, approvals), [bench](../../specs/bench/spec.md) (workbench VMs).

![An agent session end to end](../images/agent-session.svg)

## Why agents need an OS-level design

The incidents that shaped this design follow four patterns:

| Pattern | Example class | keylos answer |
|---|---|---|
| Destructive over-eagerness | Dropped production databases, wiped drives | Work happens in a copy-on-write overlay; merging is a T3 effect; irreversible effects need mandates |
| Exfiltration through injected content | Private repo data copied into a public PR via a malicious issue | Labels plus the Rule of Two at gate; unsafe requests become rendered intents |
| Tool rug-pulls | An MCP server that starts BCC-ing every email | Tools and MCP tool lists pinned by digest in the agent template |
| Confused-deputy harness escapes | Harnesses that followed sandbox symlinks or ran sandbox-written config as hooks | Nothing host-side reads guest files as config or follows guest paths; the harness runs inside the VM |

Detection-based prompt-injection defences fail against adaptive attackers. Users approve the large majority of permission prompts. So keylos **bounds what any behaviour can do**, and interrupts the human rarely, showing effects rather than commands.

## Pages

| Page | What it covers |
|---|---|
| [Agent principal](agent-principal.md) | Identity, templates, authority by delegation, what an agent can never hold |
| [Sessions and workbenches](sessions-and-workbenches.md) | Lifecycle, placement in tier-3 VMs, overlays, forks, sub-agents, breakers |
| [Effects and the outbox](effects-and-outbox.md) | Effect classes, staging, implicit staging over HTTP, mandates, compensation |
| [Approvals](approvals.md) | Tiers T0–T3, declassification, flow proofs, what the human sees |
| [Budgets](budgets.md) | Money, token and call budgets, carving for sub-agents, model metering |
| [Tools and MCP](tools-and-mcp.md) | Tool kinds, pinning, remote and local MCP servers, credentials |
| [Computer use](computer-use.md) | Agent desktops in VMs, read-only mirrors and take-over, single-window snapshots |
| [Harness API](harness-api.md) | `AgentHost` for harness authors, provenance reporting, the SDK |

## The short version

1. A human starts a session from an **agent template**: a signed generation that pins the harness, tools, MCP servers, prompt and policy.
2. aide **delegates** a narrowed subset of the human's authority to a new principal `agent:<template>@<human>/<session>`, with expiry, depth, fan-out and budget caveats.
3. The session runs in a **crosvm microVM**. The project is a copy-on-write overlay. There is no home, no secrets and no host configuration.
4. All network goes through **gate**: granted hosts only, credentials injected, the Rule of Two enforced, unsafe requests staged.
5. **Effects** (push, email, payment, merge) become outbox intents. Irreversible ones need a **mandate**: a signed approval bound to the exact payload digest.
6. **Review** stages an `fs.merge` intent. The human sees the diff on the trusted path and approves with a FIDO2 touch. The merge can be undone.
7. Everything is in the **ledger**: grants, labels, connections, intents, approvals, merges.

## Related

- [Network egress](../06-security/network-egress.md)
- [aide specification](../../specs/aide/spec.md)
- [gate specification](../../specs/gate/spec.md)
- [ADR-0029 Agents propose, humans sign](../11-decisions/adr-0029-agents-propose-humans-sign.md)
- [ADR-0030 Pinned agent tools](../11-decisions/adr-0030-pinned-agent-tools.md)
