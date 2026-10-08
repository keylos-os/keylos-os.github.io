# Agent principal

> An agent session is a kernel-visible principal with its own UID, cgroup and token set. Its identity names the exact template it runs, the human it acts for, and its position in the delegation chain.
> Its authority is always a subset of what the launching human handed it. It can never hold a credential that is equivalent to a human signature.

**Status:** specified (v1.0). Components: [aide](../../specs/aide/spec.md), [broker](../../specs/broker/spec.md).

## Identity

```
agent:gen:fsv256:<template digest>@<human>/<session>[/<child session>…]
```

| Part | Meaning |
|---|---|
| `agent:gen:fsv256:…` | The agent-template generation, by content digest. A different tool list, prompt or harness is a different digest, and so a different principal. |
| `@<human>` | The accountable human. Every receipt the agent causes names them. |
| `/<session>` chain | Delegation path. A sub-agent's chain is its parent's plus one session. |

When a session's VM is running, `warden` maps the principal to a dynamic UID and a cgroup under `user-<uid>.slice/agents.slice/<session>.scope`. Peers learn the agent principal from warden (`ServiceHost.accept`), which created the connection, never by anything the agent claims.

## The agent template

A template is a generation of kind `agent-template`, installed and capability-diffed by `depot` like any app. Its manifest's `agent` field points at `/.keylos/agent/template.json`, next to `tools.json`, `prompt.md` and `policy.json` ([protocols §6.4](../../specs/protocols/spec.md#64-agent-templates)). It pins:

| Pinned | How |
|---|---|
| Harness (the agent loop) | Generation ref, or a WASI component inside the template |
| Workbench guest image | `bench-image` generation ref |
| Tools | `tools.json`, with a digest per tool and for the whole file |
| MCP servers | Local: generation refs. Remote: URL + `toolsDigest` of the server's tool list. |
| System prompt | Digest |
| Session policy defaults | Digest. These can only narrow authority. |
| Allowed models | Provider, host, model ID, max tokens |

A template **cannot grant authority**. It only describes what the agent is. Authority comes from the human who starts the session.

## Authority by delegation

When a human runs `aide start`, their principal (usually `shell@alice/s-…`) passes tokens in `SessionSpec.grants`, for example:
- the project directory they typed (the shell is the powerbox);
- `net("api.github.com", 443, "https", "GET")`;
- `effect("git.pr.open", stage)`.

aide calls `broker.delegate` to create the agent's tokens from those, adding caveats:

| Caveat | Default (template policy, capped by config) |
|---|---|
| `expires` | 4 hours |
| `max_depth` | 2 (sub-agents of sub-agents) |
| `max_fanout` | 4 children per session |
| `tier_floor` | 3 (only usable inside a workbench VM) |
| `budget` | `usd-micro:5000000`, `tokens:4000000`, `calls:2000` |

The tokens keep the human's root IDs, so revoking the human's grant revokes the agent's too. Mid-session, the agent can **request** more (`keylos.grant.request`). broker evaluates the request with Cedar, and it either stays within policy or becomes an approval on the trusted path.

![Authority flow](../images/authority-flow.svg)

## What an agent starts with

Nothing. Specifically:

- No home directory, no `~/.ssh`, no `~/.config`, no environment secrets.
- No Docker socket, no host sockets, no session bus (there is none).
- No write access to any configuration that another harness or agent reads. Closing this was the lesson of cross-agent privilege escalation.
- No raw credentials. Provider keys, MCP tokens and SSH keys are injected by gate on the wire.

What it gets:
- the project as a **copy-on-write overlay**;
- read-only shares for directories it was granted;
- network through gate for granted hosts;
- the `AgentHost` capability for host tools.

## What an agent can never hold

| Never | Why |
|---|---|
| The `owner-presence` key (FIDO2) | Presence signs config generations, seals and T3 mandates. A human touch is the point. |
| The `owner-seal` key | Promoting code to run on the host is an owner act |
| The human's SSH or signing keys | Commits by agents are signed with an ephemeral Ed25519 **session key**: aide creates it, stores it in vault (facet `aide`) and registers it with the broker (`BrokerSystem.registerSessionKey`); gate's SSH proxy signs commits with it and refuses it for SSH login. The human signs merges. |
| A DCO sign-off | Agents add `Assisted-by:` and `Agent-Session:` trailers. Humans certify. |
| Payment authentication | Payments need AP2-style mandates signed by the human |

## Labels

Each session carries a label `{confidentiality, integrity}` that only rises:

- reading private files raises confidentiality;
- reading web pages, untrusted MCP results, or files from untrusted sources raises integrity to `untrusted`.

bench raises labels on file opens through virtio-fs. gate raises them on network responses. aide raises them on remote tool results. The label decides whether the session may communicate outward (the Rule of Two); see [Approvals](approvals.md).

## Observed versus claimed

The harness reports its own actions (`emit`), but the harness is the agent, so these are **claims**. keylos also records **observed** facts from trusted components:

| Observed by | What |
|---|---|
| gate | Connections, intents, spending |
| bench and strata | File changes in overlays |
| broker | Grants, labels, approvals |

The session UI and `aide log` show both and flag discrepancies. Only observed facts are authoritative in review.

## Limitations

- An agent can still misuse authority it legitimately holds, for example by writing subtly wrong code into its overlay. Review is the backstop.
- Session labels are coarse: once a session reads one untrusted page, it is untrusted for the rest of its life. Fork a fresh session for unrelated work.

## Related

- [Sessions and workbenches](sessions-and-workbenches.md)
- [Approvals](approvals.md)
- [Tools and MCP](tools-and-mcp.md)
- [aide specification](../../specs/aide/spec.md)
- [ADR-0024 Dynamic UIDs per principal](../11-decisions/adr-0024-dynamic-uids-per-principal.md)
- [ADR-0005 Biscuit capability tokens](../11-decisions/adr-0005-biscuit-capability-tokens.md)
- [ADR-0029 Agents propose, humans sign](../11-decisions/adr-0029-agents-propose-humans-sign.md)
