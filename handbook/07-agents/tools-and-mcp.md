# Tools and MCP

> An agent's tools are part of its identity. The template pins every tool definition and every MCP server's tool list by digest, so a tool that silently changes stops working instead of silently changing behaviour.
> Tools run inside the workbench where possible. Host-side tools are few and are mediated by aide. Remote MCP servers are reached through gate with injected, audience-bound credentials.

**Status:** specified (v1.0). Components: [aide](../../specs/aide/spec.md), [gate](../../specs/gate/spec.md).

## Tool kinds

| Kind | Runs | Examples | Mediated by |
|---|---|---|---|
| `vm` | Inside the VM, by the harness | `bash`, `edit`, `read`, `test` | Nothing on the host. Effects are caught at the VM boundary (gate, overlay). |
| `cmd` | Inside the VM | Any keylos command with a command signature (`rg`, `fd`, `jq`) | The tool schema is generated from the command's cmdsig |
| `mcp` (local) | Inside the VM, over stdio | Documentation search, code index | Pinned generation; started by aide-guest |
| `mcp` (remote) | Host side, by aide | Issue trackers, SaaS APIs | gate (egress, credentials, metering) |
| `host` | Host side, by aide | `keylos.effect.stage`, `keylos.grant.request`, `keylos.human.ask`, `keylos.subagent.spawn`, `keylos.powerbox.open` | broker, gate, atrium |

## Pinning

| Pinned | Digest |
|---|---|
| Each tool definition | `sha256` of the JCS form without the `digest` field |
| The whole `tools.json` | `sha256` of the JCS form, recorded in `template.json` |
| Local MCP server | Generation ref (content-addressed, signed), plus `toolsDigest` of the tools it reports |
| Remote MCP server | `toolsDigest` = `sha256` over its `tools/list` (`name`, `description`, `inputSchema`; sorted by name) |

At session start, and on reconnect, aide fetches each remote server's tool list and compares digests:

| Template says | Mismatch → |
|---|---|
| `optional: true` | That server's tools are disabled for the session; event `mcpPinMismatch` |
| `optional: false` | The session fails with `kl:integrity` |

Accepting new tool definitions means building a new template generation. A new template goes through depot's capability diff and consent like any app update. This stops "rug-pull" attacks, where a server that behaved for months changes its tool description or behaviour.

## Models are pinned too, as far as possible

Tools and MCP servers are pinned by digest. Remote models can't be: a provider can change behaviour behind the same model ID. Templates therefore declare each model as `{provider, model, minVersion}` (remote) or `{runtime, weights}` (local, pinned by the weights data generation).

| Model kind | Pinned by | If it changes |
|---|---|---|
| Local | The weights generation digest | It can't change without a new template |
| Remote | Provider, model ID and minimum version; the observed version is recorded by gate | `model.change`; the session's T1 actions become T2 until re-approved ([Approvals](approvals.md#model-drift)) |

## Remote MCP servers

| Aspect | Design |
|---|---|
| Transport | MCP Streamable HTTP via `gate.connect` |
| Network grant | The server's host:443, delegated to the session |
| Authorization | gate's `oauth-exchange` injection rule. The refresh token stays in vault. Access tokens are short-lived, down-scoped by token exchange (RFC 8693) where supported, and audience-bound to the server URL (RFC 8707). The agent never sees them. |
| Result labels | `untrusted` by default; `user` only if both the template and system policy mark the server trusted. Confidentiality = the server's declared level (default `internal`). |
| Audit | Calls are logged in the session's event log. Connections are in gate receipts. |

## Local MCP servers

Local servers ship as generations, so they are reproducible, signed and capability-diffed. aide-guest starts them inside the VM from read-only mounts, and they talk stdio to the harness. They have exactly the VM's authority, nothing more.

## Command tools from cmdsig

keylos commands describe themselves with `keylos.cmdsig/1`: arguments, flags, typed inputs and outputs, effects and network needs. aide turns a cmdsig into a JSON Schema tool definition, so any native command can become an agent tool without hand-written schemas. Typed `records` output gives the model structured results instead of text to parse.

## Host tools

Host tools are the agent's only way to ask for something new from outside the VM:

| Tool | Does |
|---|---|
| `keylos.grant.request` | Asks broker for a resource (a directory, a host, a device). Policy decides, or it becomes an approval. |
| `keylos.powerbox.open` | Asks the human to pick a file or directory on the trusted path. The pick is the grant. |
| `keylos.effect.stage` / `.status` | Stages an effect with argument provenance and checks it |
| `keylos.human.ask` | Asks the human a question. The answer is labelled `user`. |
| `keylos.subagent.spawn` / `.status` / `.wait` | Delegates to a child session |
| `keylos.labels.current` | Reads the session label, so a harness can plan around the Rule of Two |

## Writing tools well

- Prefer `cmd` tools with typed outputs over `bash` for routine operations. They give the model structured data and give reviewers a clearer log.
- Report provenance for every argument you pass to `keylos.effect.stage` ([Harness API](harness-api.md)). It is what the human sees when deciding.
- Mark remote MCP servers `optional` unless the agent cannot work without them.

## Limitations

- `vm` tools that execute arbitrary code (`bash`) make the harness's own claims unreliable. The observed log (gate, overlay) is what counts.
- MCP servers that legitimately change their tool lists often require frequent template updates. That cost is intended.

## Related

- [Harness API](harness-api.md)
- [Agent principal](agent-principal.md)
- [aide specification](../../specs/aide/spec.md)
- [ADR-0030 Pinned agent tools](../11-decisions/adr-0030-pinned-agent-tools.md)
- [ADR-0036 Typed pipes via cmdsig](../11-decisions/adr-0036-typed-pipes-via-cmdsig.md)
