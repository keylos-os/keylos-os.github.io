# ADR-0030: Agent tools and MCP servers are pinned by digest

> An agent template is a sealed generation containing the harness, tool definitions, MCP server generations, prompt and policy. Tools are pinned by digest. A changed tool or MCP server means a new template generation, which needs re-approval with a capability diff.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Agents | aide, depot, sdk, broker |

## Context

- postmark-mcp: after 15 clean versions, 1.0.16 silently BCC'd all mail to an attacker, a classic rug pull (https://koi.ai/blog/postmark-mcp-npm-malicious-backdoor-email-theft).
- The Amazon Q VS Code extension shipped a wiper prompt merged from an untrusted PR (https://www.scworld.com/news/amazon-q-extension-for-vs-code-reportedly-injected-with-wiper-prompt).
- In the Nx "s1ngularity" attack, malware drove locally installed agent CLIs with permissive flags to hunt secrets (https://www.wiz.io/fr-fr/blog/s1ngularitys-aftermath).
- Tool *descriptions* are part of the prompt, so they are code.

## Decision

- `agent-template` generations contain everything that shapes agent behaviour. Their manifest lists tool definitions and MCP server generations by `gen:` digest.
- aide exposes only pinned tools through `AgentHost.tools`. MCP servers run as their own principals in the workbench, never with host authority.
- Template updates go through depot with a capability diff (new tools, new hosts, new effects), shown for consent.
- Agent CLIs on the host have no "yolo" mode. Authority comes only from attenuated tokens.

## Alternatives considered

| Option | Why not |
|---|---|
| Version-range dependencies for MCP servers | Rug-pull vector |
| Runtime tool discovery | Unbounded capability growth |

## Consequences

### Positive
- Supply-chain changes to agent behaviour are visible and consented to.

### Negative
- Tool updates need template releases, with some friction for agent developers. The SDK automates rebuilding templates.

## Related

- [Tools and MCP](../07-agents/tools-and-mcp.md)
- [Write an agent template](../12-guides/write-an-agent-template.md)
- [aide](../03-components/aide.md)
