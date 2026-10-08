# Write an agent template

> An agent template is a sealed generation that bundles a harness, a system prompt, a model choice, a Cedar policy and a list of tools pinned by digest. `aide` starts sessions from it in a workbench fork. Changing any tool changes the template's digest, so users approve it again.

**Applies to:** `kind = agent-template`. Specified in [sdk](../../specs/sdk/spec.md) §4.1 and [aide](../../specs/aide/spec.md).

![Agent session](../images/agent-session.svg)

## 1. Create the project

```sh
$ kl-sdk init agent-template ~/src/release-agent --name org.example.agent.Release
```

## 2. Describe the template

```nickel
{
  name = "org.example.agent.Release", version = "1.0.0", kind = 'agent-template,
  summary = "Prepares release notes and opens a draft PR", license = "Apache-2.0",
  build = { language = 'python, lockfiles = ["uv.lock"] },
  entrypoints = { harness = { exec = "/usr/bin/release-harness", kind = 'harness } },
  agent = {
    harness = "harness",
    prompt_file = "/usr/share/release-agent/prompt.md",
    model = { provider = "anthropic", model = "claude-sonnet-5-5" },
    tools = [
      { name = "git", generation = "org.git-scm.git@2.47", command = "git" },
      { name = "gh-pr", generation = "io.keylos.tools.github@1.2", mcp = true },
    ],
    policy = "/usr/share/release-agent/policy.cedar",
    default_grants = ["project:readwrite-overlay", "net:api.github.com:443:GET"],
    budget = { usd = 2 },
  },
} | (import "keylos/package@1").PackageSchema
```

`kl-sdk pack` resolves each `tools[].generation` to a `gen:fsv256:` ref and writes the template layout of [protocols §6.4](../../specs/protocols/spec.md#64-agent-templates): `/.keylos/agent/template.json` (`keylos.agent-template/1`), `tools.json` (`keylos.agent-tools/1`, a digest per tool and for the file), `prompt.md` and `policy.json` (`keylos.agent-policy/1`, which can only narrow authority), and sets the manifest's `agent` field (`{"template": "/.keylos/agent/template.json", "flowProof": null}`). That pinning is the defence against tool rug-pulls; any change to a pinned digest is a new generation that needs consent.

## 3. Write the harness against `AgentHost`

The harness runs inside the workbench guest. It reaches the outside only through `AgentHost`:

```python
from keylos import App
host = App.from_env().agent_host()
tools = host.tools()                                   # pinned definitions
resp = host.model({"messages": [...], "tools": tools}) # metered by gate against the session budget
result, label = host.call_tool("git", '{"args":["log","--oneline","-20"]}', provenance='{"from":"plan"}')
host.emit({"message": "Draft notes ready for review"})
```

| You call | `aide` / gate does |
|---|---|
| `model()` | Sends the request through gate; charges the budget; returns `budget` when exhausted |
| `call_tool()` | Runs the pinned tool; labels the result (for example `untrusted` for web or issue content) |
| `requestGrant()` | Asks for more authority: T2/T3 prompt to the human |

## 4. Constrain it with policy

`policy.cedar` attenuates whatever the human grants. It can only narrow:

```cedar
@tier("t3")
permit (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { resource.kind == "git.pr.open" };

forbid (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { resource.kind == "git.push" };
```

## 5. Test with scripted approvals

```nickel
{
  seed = 1,
  grants = { network = ["api.github.com:443/https"] },
  approvals = [{ match_kind = "git.pr.open", decide = 'approve, scope = 'once }],
  expect = { effects_committed = [{ kind = "git.pr.open", target = "https://api.github.com/repos/example/app/pulls" }] },
}
```

```sh
$ kl-sdk test
```

## 6. Ship it

```sh
$ kl-sdk build && kl-sdk publish --to oci://ghcr.io/example/release-agent --sigstore
$ aide start org.example.agent.Release --project ~/src/app --task "Prepare 2.4 release notes"
```

The first start shows the template's tools, model, policy and default grants for approval.

## What the template cannot do

| It cannot | Because |
|---|---|
| Write your real tree | Writable shares are overlays; merging is a T3 review |
| Read raw credentials | gate injects them into requests |
| Change system configuration | It can only produce proposals that you sign |
| Hold untrusted input, private data and egress at once | The Rule of Two turns that into a T3 declassification |

## Related

- [aide spec](../../specs/aide/spec.md)
- [sdk spec](../../specs/sdk/spec.md)
- [Add an effect kind](add-an-effect-kind.md)
- [Write policy](write-policy.md)
- [ADR-0030 Pinned agent tools](../11-decisions/adr-0030-pinned-agent-tools.md)
- [ADR-0026 Labels and the Rule of Two](../11-decisions/adr-0026-labels-and-rule-of-two.md)
- [ADR-0029 Agents propose, humans sign](../11-decisions/adr-0029-agents-propose-humans-sign.md)
