# aide

> The agent runtime. aide starts agent sessions from sealed `agent-template` generations and places each one in a disposable [bench](bench.md) workbench forked from the project. It gives the harness inside a narrow `AgentHost` API with pinned tools, a metered model API and grant requests, and it drives review and merge on the trusted path.
> Agents propose; humans approve and sign.

**Status:** specified (v1.0) · **Spec:** [`aide/spec.md`](../../specs/aide/spec.md)

![Agent session](../images/agent-session.svg)

## Responsibilities

- **Sessions:**
  - `Aide.start(SessionSpec)` creates principal `agent:<template>@<human>/<session>`;
  - attaches tokens attenuated from the human's authority;
  - sets budget and deadline caveats;
  - starts a workbench whose shares are copy-on-write overlays of the granted directories.
- **Templates:**
  - verify the template generation;
  - expose only its pinned tool definitions and MCP server generations (by digest);
  - a changed tool means a new template, which needs re-approval.
- **Harness API:** `AgentHost` with `tools`, `callTool` (results labelled), `model` (through [gate](gate.md) metering), `emit`, `requestGrant`.
- **Labels:** report label changes to [broker](broker.md). The Rule of Two can turn a tool call into a T3 declassification.
- **Effects:** the agent's external actions become [gate](gate.md) intents. Irreversible ones wait for mandates.
- **Sub-agents:** `fork` creates a child session whose tokens are delegated and attenuated. Depth and fan-out are bounded, and the budget is carved from the parent's.
- **Review and merge:**
  - `review` opens a T3 prompt with the overlay diff and effect list;
  - `Vm.commit` merges through [strata](strata.md);
  - commits carry `Assisted-by:` and `Agent-Session:` trailers.
- **Velocity breakers:** repeated identical calls, runaway fan-out or context growth kill the session subtree.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Aide`, `AgentSession` (`aide.capnp`) | Facet `user`: `start`, `sessions`, `attach`; sessions `send`, `events`, `changes`, `review`, `stop`, `fork` |
| Provides | `AgentHost` + `AgentHostExt`, `VmExec` (`aide-sys`) | Facet `host`: the harness inside the VM, over vsock 7002 |
| Provides | `GrantDelegate` (`bench-sys`) | Facet `grant-delegate`: grant requests bench forwards from agent VMs |
| Consumes | bench `Bench` (facet `aide`), `BenchMerge` (facet `merge`) | Workbench VMs; merge manifests and renders |
| Consumes | gate (facets `aide`, `meter`) | Staging intents for agent sessions; metered model calls |
| Consumes | broker `BrokerSystem` (`registerSessionKey`, `annotateRequest`), `LabelAuthority` | Session keys, provenance hints, labels of tool results |
| Consumes | strata (facet `aide`), `StrataTxn` | Overlay transactions |
| Consumes | vault (facet `aide`) | Session signing keys |
| Consumes | config (facet `propose`) | Agent proposals; humans sign |
| Consumes | ledger (facet `writer`) | Receipts |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| aide | `user` | human `shell`s, atrium | `Aide` (own human's sessions) |
| aide | `host` | one per agent VM (vsock 7002 forward by bench-relay) | `AgentHost`, `AgentHostExt` (incl. `desktop`), `VmExec` |
| aide | `admin` | owner `shell` | `Aide` (all humans, read), aide-local admin |
| aide | `grant-delegate` | bench | `GrantDelegate` |
| aide | `loom` | loom | `AgentWorkflowHost` (§7.5.25) |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`aide-sys.capnp`](../../specs/protocols/spec.md#7513-aide-syscapnp) | `0xc7a1e5d3b2f4002c` | `AgentHostExt`, `VmExec`, `AgentDesktop` |
| [`loom-sys.capnp`](../../specs/protocols/spec.md#7525-loom-syscapnp) | `0xc7a1e5d3b2f40039` | `DurableEffects`, `WorkflowBudget`, `BrokerWorkflow`, `AgentWorkflowHost`, `LoomSystem` |
<!-- /generated:sysif -->

## Runs as

A t0 service. It never runs agent code itself; all of that runs in tier-3 VMs.

## State

| Path | Content |
|---|---|
| `/var/lib/aide/sessions/` | Session metadata, event transcripts (crypto-shred unit per session) |

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `agent.start`, `agent.stop`, `agent.merge`, `model.change`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Key decisions

- [ADR-0029: Agents propose, humans sign](../11-decisions/adr-0029-agents-propose-humans-sign.md)
- [ADR-0030: Pinned agent tools](../11-decisions/adr-0030-pinned-agent-tools.md)
- [ADR-0009: Unsealed code in workbenches](../11-decisions/adr-0009-unsealed-code-in-workbenches.md)
- [ADR-0026: Labels and the Rule of Two](../11-decisions/adr-0026-labels-and-rule-of-two.md)

## Related

- [Agents](../07-agents/README.md)
- [Agent principal](../07-agents/agent-principal.md)
- [Harness API](../07-agents/harness-api.md)
- [Agent session flow](../02-architecture/agent-session-flow.md)
