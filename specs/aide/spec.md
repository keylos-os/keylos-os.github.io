# keylos/aide: agent sessions

| | |
|---|---|
| Repository | `github.com/keylos-os/aide` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | Service generation `io.keylos.aide` (processes `aide` and `aide-wasi`); CLI `aide`; guest agent `aide-guest` (an output packaged into `bench-image` generations by `pkgs`); crate `keylos-agent-harness` (SDK for harness authors); reference agent-template generation `io.keylos.agent.coder` and its harness generation; repo-local schema `schema/aide-local.capnp` |
| Depends on | `keylos-protocols 1.0` (final) — crates `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-biscuit`, `keylos-labels`; runtime: `warden`, `broker`, `bench`, `gate`, `vault`, `ledger`, `depot`, `config`, `atrium` (notifications), `loom` (workflow attempts) |
| Provides | `Aide`, `AgentSession`, `AgentHost` (protocols §7.3.14); `AgentHostExt`, `VmExec`, `AgentDesktop` relay (protocols §7.5.13); `GrantDelegate` (protocols §7.5.10, served to bench); `AgentWorkflowHost` (protocols §7.5.25, served to loom): agent sessions as attempts of durable workflows; session lifecycle with RAM-class queueing, review and merge, sub-agents, carved budgets, breakers, agent desktops (computer use), model-drift handling |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

aide makes AI agents **first-class principals**. For every agent session it:

1. Starts a principal `agent:<template-gen>@<human>/<session chain>` whose authority is an **attenuated subset** of what the launching human passes in. Sub-agents get further-attenuated child sessions.
2. Places the session in a **tier-3 workbench** (a crosvm microVM through `bench`). Writable project directories are copy-on-write overlay shares; the session has no home, no secrets and no host configuration.
3. Pins the harness, tools, MCP servers, prompt and policy by **digest** through the agent-template generation (protocols §6.4).
4. Mediates everything that crosses the VM boundary at the semantic level: host tools, model calls (metered by `gate`), remote MCP servers (credentials injected by `gate`), grant requests, effect staging and messages to the human.
5. Enforces **velocity breakers** and requests **hard budget carving** for sub-agents (broker carves, gate enforces).
6. Runs **agent desktops** for computer-use templates: the agent drives a nested desktop inside its own VM and never touches the human's real session (protocols §14.5).
7. Detects **model drift** and asks the human to re-approve (protocols §14.5).
8. Runs **review and merge**: overlays reach the real tree only through a T3 `fs.merge` intent at `gate`, executed by `bench` against a mandate bound to an immutable strata prepared merge (protocols E30).
9. **Queues** sessions when the machine's VM cap for its RAM class is reached (protocols §2.3).
10. Writes receipts `agent.start`, `agent.stop`, `agent.merge`, `model.change`.
11. Runs agent sessions as **attempts of durable workflows** for `loom` (protocols §20.25): each attempt is a fresh agent session registered with its `AttemptBinding`, whose label and authority the broker restores from the workflow record; every model response and host-tool result is recorded through loom before the harness sees it, and a later attempt replays recorded observations instead of asking the model again. Ordinary (non-workflow) sessions never become durable: an aide restart, a reboot or a pause never resumes them on its own.

### 1.1 Non-goals

- Enforcing network, label and effect policy: `gate` and `broker` do that. aide is not trusted to enforce it; a compromised aide cannot exceed the tokens broker minted.
- Running models: remote providers are reached through `gate`; local runtimes run inside the workbench VM.
- Being a harness: aide hosts harnesses. The reference harness is an ordinary generation with no special privileges.
- Changing system state: agents propose (merges, config plans); humans approve and sign ([ADR-0029](../../handbook/11-decisions/adr-0029-agents-propose-humans-sign.md)).

---

## 2. Context and embedded contracts

### 2.1 Position

```
 human (kish / atrium) ──aide#user──► aide (t0) ──broker#system / label-authority──► broker
                                        │  ├──bench#aide / bench#merge──► bench ──► crosvm VM
                                        │  ├──gate#aide / gate#meter──► gate
                                        │  ├──vault#aide──► vault        (session keys, aide: units)
                                        │  ├──config#propose──► config
                                        │  ├──depot#user──► depot        (templates)
                                        │  ├──ledger#writer──► ledger
                                        │  └──loom#aide──► loom          (attempt hosts: observations, results, ends)
                                        ▲ aide#loom (loom starts and stops agent attempts)
                                        ▲ aide#grant-delegate (bench callbacks for agent VMs)
                                        ▲ aide#host, capwire-vsock port 7002 (forwarded by bench)
                 ┌──────────── tier-3 workbench VM ──────────────────────────────────┐
                 │ aide-guest ─► harness ─► VM tools (bash, edit, git), cmd tools,       │
                 │ local MCP servers; virtio-net → bench-net → gate; virtio-fs shares    │
                 └──────────────────────────────────────────────────────────────────────┘
```

### 2.2 Routes

**Facets aide serves:** `user`, `host`, `admin`, `grant-delegate`, `loom` (protocols §19.2, embedded in §2.3.24).

**Routes aide holds:**

| Route | Used for |
|---|---|
| `warden#service` | `Supervisor.identify`; `FdStore` |
| `broker#principal` | `attenuate` (top-level sessions), `inspect` |
| `broker#system` | `registerSessionKey`, `annotateRequest`, `requestFor` (grant requests on behalf of agent sessions) |
| `broker#workflow` | `BrokerWorkflow.offer` (share-building tokens of an agent attempt), `verify`, `decide` and `rebind` (durable grant decisions of agent attempts) (protocols §7.5.25) |
| `loom#aide` | `LoomSystem.attempt` (the attempt's `AttemptHost`), `ended`, `cancelRequested` (protocols §7.5.25) |
| `broker#label-authority` | `labelOf`, `raiseFor` |
| `bench#aide` | `Bench.start` (including `VmSpec.attempt`), `Bench.project`, `Bench.reattach`, `Vm.*` (including `fork(ForkSpec)` with `attempt`, `attachShare`, `desktop`, `takeOver`, `info`) |
| `strata#aide` | `TransactionExt.bindWorkflow` and `StrataTxn.preparedFor` for prepared merges of agent attempts (protocols §7.5.7) |
| `bench#merge` | `BenchMerge.manifest`, `render`, `preparedStatus` |
| `gate#aide` | `connect` (model and remote MCP traffic), `stage` (with `x-subject-token`), `intents`, `meter`; `DurableEffects.prepare`, `lookup` (workflow effects of agent attempts, protocols §20.26); `WorkflowBudget.reserve`, `settle`, `status` (local GPU time of attempts) |
| `gate#meter` | `charge` (local GPU time) |
| `vault#aide` | `store`/`delete`/`sign` of session keys; `dataKey`/`forget` for `aide:` units |
| `config#propose` | `Config.propose` with `origin` = the agent principal |
| `depot#user` | `get`, `list`, `openPath` (`/.keylos/agent/*`, `/.keylos/manifest.json`) of agent-template generations |
| `ledger#writer` | `agent.*` and `model.change` receipts; `watch`/`query` for `label.raise`, `effect.commit`, `grant.revoke`, `budget.charge` (model identity), `vm.stop` (queue capacity) |
| `atrium#notify` | `TrustedPrompt.notify` (breaker trips, finished sessions) |

### 2.3 Embedded contracts (verbatim from `keylos-protocols 1.0`)

#### 2.3.0 protocols §2.3 Resource classes

`bench` admission control and memory tuning follow the machine's **RAM class** (detected at boot, overridable in config):

| RAM | Class | Max concurrent VMs (workbench, agent, tier-2, media, pod) | Defaults |
|---|---|---|---|
| < 12 GiB | `small` | 2 | zram swap (ephemeral key), KSM on, compressed snapshots, agents queue |
| 12–24 GiB | `medium` | 6 | KSM on, free-page reporting |
| > 24 GiB | `large` | 16 | free-page reporting |

`server-k8s` nodes are exempt from the VM cap for pod VMs; kubelet `maxPods` bounds them instead. When the cap is reached, new agent sessions queue (`aide`), and other VM requests fail with `kl:unavailable`.

#### 2.3.0a protocols §3.3 Names (guest usernames)

- **Generation names** use reverse-DNS: `org.example.Editor`. The pattern is `^[a-z][a-z0-9-]*(\.[a-zA-Z0-9-]+){2,}$`, at most 255 characters. The prefixes `io.keylos.` and `org.keylos.` are reserved for the project.
- **Service names** are `[a-z][a-z0-9-]{0,62}` (for example `vault`, `portal-files`). The registry is §19.1.
- **Facet names** are `[a-z][a-z0-9-]{0,31}`. The registry is §19.2.
- **Usernames** are `[a-z_][a-z0-9_-]{0,31}`. `_system` and `_cluster` are reserved, and the prefix `guest-` is reserved for ephemeral guest sessions (`guest-<8 lowercase base32>`, created and destroyed by `hearth`).
- **Kubernetes names**: `pod-ns` and `pod-name` follow Kubernetes DNS-1123 label / subdomain rules (`[a-z0-9]([-a-z0-9]*[a-z0-9])?`, ≤ 63 and ≤ 253 characters).

#### 2.3.1 protocols §3.4 Principal identifiers

A principal is the tuple **(actor, human, session chain)**.

```
principal   = actor "@" human "/" session *( "/" session )
actor       = "app:" ref-gen
            / "service:" service-name ":" ref-gen
            / "agent:" ref-gen
            / "legacy:" ref-gen
            / "bench:" ref-gen
            / "pod:" pod-ns "/" pod-name ":" ref-gen-or-image
            / "shell"
            / "kernel"
human       = username / "_system" / "_cluster"
ref-gen-or-image = ref-gen / "oci:sha256:" 64HEXDIGLC   ; sealed container generation, or OCI image digest (keylos-vm pods)
session     = "s-" ULID          ; Crockford base32, 26 characters
ref-gen     = "gen:fsv256:" 64HEXDIGLC
```

Examples:
- `shell@alice/s-01JB6Q8Z0RXQ4M3W9V2N7T5K1C`
- `agent:gen:fsv256:9e1f…@alice/s-01JB6Q…/s-01JB6R…` (a sub-agent: the last session is the child)
- `service:vault:gen:fsv256:77aa…@_system/s-01JB5…`

Rules:
- The **session chain** records delegation. A child principal's chain is its parent's chain plus one new session. Its authority MUST be a subset of its parent's (§8).
- The **canonical key** for maps and log indexes is the full text form.
- Within a kernel, a running principal instance maps 1:1 to a **(UID, cgroup)** pair allocated by `warden` (§10.3). The mapping is published through `Supervisor.identify` (§7.3.2).
- A VM principal (tier 2 or 3) maps to the cgroup of its VMM process; processes inside the guest are not separate host principals.
- **Pod principals** (§21) always have human `_cluster`. A `keylos-vm` pod is one VM principal per pod sandbox whose actor names the pod's first container image; a `keylos-sealed` pod has one principal per container. The session chain starts at the `cri` service session.

#### 2.3.2 protocols §3.5 Other identifiers

| Identifier | Form |
|---|---|
| Session | `s-` + ULID, created by the spawner. ULIDs are unique and monotonic in time; only the canonical uppercase text form is valid. |
| Token root ID | 16 random bytes; text form `t-` + the 26-character **uppercase Crockford base32** encoding of the 128-bit big-endian value (the ULID codec; first character `0`–`7`). |
| Grant record ID | `g-` + ULID (persistent grant records, broker) |
| Effect intent ID | `e-` + ULID |
| Transaction ID | `x-` + ULID |
| Approval ID | `a-` + ULID. Minted by `broker` for the approvals it runs, and by `hearth` for the mandates of its own presence-confirmed effects (`x-hearth.*` kinds, never sent to `broker`) |
| Snapshot ID | `snap-` + ULID |
| Plan ID (config) | `p-` + ULID |
| Seal window ID | `w-` + ULID |
| Prepared merge ID | `pm-` + ULID (strata, §7.5.7, §20.12) |
| Quorum request ID | `q-` + ULID |
| Debug grant ID | `dbg-` + ULID |
| Pod sandbox ID (cri) | `pod-` + ULID (the Kubernetes pod UID is kept as metadata) |
| Media session ID (bench) | `med-` + ULID |
| Family inbox item ID (hearth) | `fi-` + ULID (a non-owner request waiting for an owner; never an approval ID, which is `a-…` and broker-issued) |
| Fleet command ID | `fc-` + ULID (§20.23) |
| Workflow ID | `wf-` + ULID. The persistent identity of one enrolled workflow (§20.25); minted by `loom`, never reused |
| Run ID | `wr-` + ULID. One run of a workflow (a fresh run after a migration, §20.27) |
| Step ID | `ws-` + the 26-character ULID of the run ID + `.` + state name (`[a-z][a-z0-9-]{0,31}`) + `.` + occurrence (decimal, no leading zeros, `0` for the first entry of that state in the run), e.g. `ws-01JB6Q8Z0RXQ4M3W9V2N7T5K1C.test.2`. Deterministic: the same run, state and occurrence always give the same step ID |
| Attempt ID | `wa-` + ULID. One execution attempt of a step; fresh for every claim, mapped to fresh runtime sessions |
| Effect ID | `fx-` + 26 uppercase Crockford base32 characters of the first 16 bytes of SHA-256(`"keylos-effect/1"` ‖ `0x00` ‖ step ID text ‖ `0x00` ‖ effect name) (the `t-` codec; first character `0`–`7`). Deterministic: every attempt of a step derives the same ID for the same named effect (§20.25) |
| Ownership epoch | `oe-` + decimal (≥ 1, no leading zeros) in documents; `UInt64` on the wire. Advanced by one at every claim of a workflow (§20.25) |
| Decision ID | `dr-` + ULID. A durable logical approval request and its decision (broker, §20.25); distinct from the boot-local prompt ID `a-…` |
| Budget account ID | `ba-` + ULID. A workflow-lifetime budget account held by `gate` (§20.25) |
| Catalog entry ID | reverse-DNS generation name (§3.3) |
| Device ID | `dev:` + subsystem + `:` + stable path, e.g. `dev:video4linux:pci-0000:00:14.0-usb-0:5:1.0` |
| Machine identity key | `key:sha256:…` of the machine's ledger signing key (the "machine key") |

#### 2.3.3 protocols §6.1 Generation kinds

| Kind | Content | Mounted by |
|---|---|---|
| `os` | Base OS tree (`/usr`, plus the initial `/` skeleton) | `boot` (initrd) |
| `runtime` | Shared library/runtime tree used by apps | `warden` (in app views) |
| `app` | A desktop or CLI application | `warden` |
| `service` | A system service | `warden` |
| `agent-template` | Harness, tool definitions, prompt and policy for an agent (§6.4) | `aide` → `bench` |
| `bench-image` | Guest OS image for workbenches and tier-2 VMs | `bench` |
| `legacy-image` | Imported foreign rootfs (OCI, Flatpak, distro); format in the `compat` spec (`keylos.compat/1`) | `compat` → `bench`/`warden` |
| `config` | Rendered configuration tree (a confext) | `boot` |
| `policy` | Cedar policy set + Biscuit authorizer templates | `broker` |
| `data` | A static data set (fonts, models, datasets) | `warden` (read-only bind) |
| `part` | A build intermediate (a derivation output that is not itself launchable: libraries, headers, toolchain parts) | `forge`, `bench` (store mounts) |
| `container` | An OCI container image converted deterministically into a generation, signed by an org publisher (§21); runnable only by `cri` in the `keylos-sealed` runtime class | `warden` (for `cri`) |
| `kmod` | Out-of-tree kernel modules built by the project for one exact kernel release (`/lib/modules/<uname>/extra/*.ko`, each module signed with the release stream's module-signing key) | `boot`, `warden` (module path only) |

#### 2.3.4 protocols §6.3 Manifest schema

```json
{
  "schema": "keylos.manifest/1",
  "kind": "app",
  "name": "org.example.Editor",
  "version": "2.5.0",
  "summary": "A text editor",
  "publisher": "key:sha256:…",
  "derivation": "drv:sha256:…",
  "runtime": "gen:fsv256:…",
  "tier": 1,
  "entrypoints": {
    "main": {"exec": "/usr/bin/editor", "args": [], "kind": "gui"},
    "cli":  {"exec": "/usr/bin/editor-cli", "args": [], "kind": "cli"}
  },
  "needs": {
    "jit": false,
    "gpu": "render",
    "network": [{"host": "api.example.com", "ports": [443], "proto": "tcp", "methods": ["GET", "POST"], "why": "Sync"}],
    "listen": [],
    "devices": [],
    "services": ["portal-files", "portal-notify"],
    "secrets": [{"name": "sync-token", "why": "Account sync"}],
    "dataUnits": ["default"],
    "spawn": [],
    "portalIsland": false,
    "labels": {"readsUntrusted": true}
  },
  "provides": {
    "commands": ["editor"],
    "services": [],
    "mimeTypes": ["text/plain"],
    "uriSchemes": [],
    "agentTools": [],
    "workflows": []
  },
  "effects": [],
  "l10n": {"default": "en", "languages": ["en", "uk", "de"]},
  "compat": null,
  "agent": null,
  "webapp": null,
  "container": null,
  "kmod": null,
  "benchImage": null,
  "grafted": false,
  "requiresFeatureLevel": "KL1",
  "reproducible": true
}
```

Normative field rules:
- `kind`, `name`, `version` (SemVer 2.0), `schema` and `entrypoints` (except for kinds `config`, `policy`, `data`, `part`, `agent-template`, `container`, `kmod`) are REQUIRED. `benchImage` is REQUIRED for kind `bench-image`.
- `tier` for kind `container` is set by `cri` per runtime class (§21), never by the manifest; kind `kmod` has no tier.
- `tier`:
  - one of `0` (services only), `1`, `2`, `"L"`;
  - `bench-image`, `agent-template` and `part` omit it;
  - the **effective tier** is `max(manifest.tier, policy floor, token tier_floor)`. Policy floors are config options of the form `apps.<name>.tierFloor`. Policy can raise a tier, never lower it.
- `entrypoints.<name>.kind`: `gui`, `cli`, `service`, `harness`, `handler` (spawned by `portal-openuri` for URIs/MIME types), `notify-action` (spawned when a notification action is activated).
- `needs.gpu`: `"none"`, `"render"` (render node), `"display"` (compositor only, no GPU device) or `"passthrough"` (VFIO passthrough of a whole GPU into a VM; valid only for effective tier 2/3 and for pods, and only on machines whose config lists a passthrough GPU). If omitted, it is `"none"`.
- `needs.realtime: true` asks for realtime scheduling: `warden` sets `RLIMIT_RTPRIO = 20` and `RLIMIT_RTTIME = 200 000 µs` for the principal. Shown at install. There is no realtime broker daemon.
- `needs.csi` (kind `container` only): `{"driver": "<CSI driver name>", "nodePlugin": "<entrypoint>", "controller": false}` declares a CSI node plugin; such containers always run in a `keylos-vm` pod VM (§21).
- `webapp` (kind `app` only): `{"origin": "https://app.example.com", "scope": "/", "name": "…", "icons": ["/.keylos/icons/…"], "browserRuntime": "gen:fsv256:…"}`. The generation is an installable web app: it runs the sealed browser-shell runtime named by `browserRuntime`, restricted to `origin` through `gate` grants derived from `origin` and `needs.network`, with its own data unit and principal. A webapp generation MUST NOT declare `needs.jit` itself; the runtime generation declares it.
- `container` (kind `container` only): `{"image": "oci:sha256:<manifest digest>", "platform": "linux/amd64", "config": {"entrypoint": [], "cmd": [], "env": [], "user": "", "workingDir": ""}}`, copied from the OCI image config at conversion.
- `kmod` (kind `kmod` only): `{"kernel": "<uname -r>", "modules": ["nvidia", "nvidia-modeset", …], "firmware": []}`.
- `benchImage` (kind `bench-image` only): `{"purposes": ["workbench", "agent", …], "desktop": false}`. `purposes` lists the `VmSpec.Purpose` values (§7.3.13) the image supports; `bench` refuses other purposes. `desktop: true` marks an agent-desktop image (nested atrium) and is required for purpose `agentDesktop`.
- `needs.jit: true` lets the generation create executable anonymous memory (§9.3). It MUST be shown to the user at install.
- `needs.network[]` entries are **requests**. The broker turns them into grants at install time (after consent) or on first use, depending on policy.
- `needs.listen[]`: `{"port": N, "proto": "tcp"|"udp", "scope": "loopback"|"lan"|"any", "why": "…"}`. Inbound listening is granted only through `gate` (`listen:` targets, §7.3.7) and `net` firewall plumbing.
- `needs.portalIsland: true` asks `compat`/`warden` to run a per-app portal island (GTK/Qt portal shim) inside the app's own principal. It grants no authority.
- `effects[]` declares effect kinds the app can stage through `gate` (§14.2), for example `{"kind": "email.send", "class": "irreversible"}`.
- `provides.workflows[]` names the workflow definitions the generation ships, each at `/.keylos/workflows/<name>.json` (`keylos.workflow/1`, §20.27; names `[a-z][a-z0-9-]{0,62}`). `loom` enrolls only definitions listed here.
- `l10n`: default language and available translations in `/.keylos/l10n/<lang>.json` (`{"summary": …, "entrypoints": {"main": {"name": …}}, "needs": {"network": [{"why": …}]}}`). Display code MUST apply bidi isolation and confusable checks to localised strings.
- `compat`: `null` except for `legacy-image`, where it is an object conforming to `keylos.compat/1` (defined in the `compat` spec; consumed only by `compat`).
- `agent`: `null` except for `agent-template`, where it is `{"template": "/.keylos/agent/template.json", "flowProof": null | "camel/1"}` (§6.4).
- `grafted: true` marks a generation produced by an emergency graft (§11.1). Grafted generations are launchable but flagged in every UI and replaced automatically when the real rebuild lands.
- `reproducible: false` forces effective `tier ≥ 2` unless an owner exception record exists (`keylos.exception/1`, §20.9).
- Unknown fields MUST be rejected unless prefixed `x-`. Anything prefixed `x-` MUST be ignored by verifiers and MUST NOT carry authority.
- **Capability diff:** on update, `depot` computes the difference in `needs`, `tier`, `effects` and `provides.services` between the installed and the new manifest. Any widening needs consent (`keylos.consent/1`, §20.8) before the new generation becomes launchable.

The JSON Schema is `jsonschema/manifest-1.json`, shipped in this repo.

#### 2.3.5 protocols §6.4 Agent templates

An `agent-template` generation contains:

```
/.keylos/manifest.json            kind "agent-template", agent.template = "/.keylos/agent/template.json"
/.keylos/agent/template.json      keylos.agent-template/1
/.keylos/agent/prompt.md          system prompt (UTF-8, ≤ 256 KiB)
/.keylos/agent/tools.json         keylos.agent-tools/1
/.keylos/agent/policy.json        keylos.agent-policy/1
/.keylos/agent/harness/…          harness component when placement = "wasi"
```

`template.json`:

```json
{
  "schema": "keylos.agent-template/1",
  "name": "io.keylos.agent.coder",
  "version": "1.0.0",
  "harness": {"placement": "vm", "generation": "gen:fsv256:…", "entrypoint": "main", "wasiComponent": null},
  "benchImage": "gen:fsv256:…",
  "vm": {"vcpus": 4, "memoryMiB": 8192, "gpu": false, "desktop": false},
  "models": [
    {"provider": "anthropic", "host": "api.anthropic.com", "model": "claude-opus-5-5", "minVersion": null, "maxTokens": 32000},
    {"provider": "local", "runtime": "gen:fsv256:…", "weights": "gen:fsv256:<data generation>", "model": "qwen-coder-32b", "maxTokens": 8192}
  ],
  "tools": {"file": "/.keylos/agent/tools.json", "digest": "sha256:…"},
  "mcp": [
    {"name": "issues", "kind": "remote", "url": "https://mcp.example.com/mcp", "toolsDigest": "sha256:…",
     "trust": "untrusted", "optional": true, "injection": "example-mcp-oauth"},
    {"name": "docs", "kind": "local", "generation": "gen:fsv256:…", "entrypoint": "main", "toolsDigest": "sha256:…",
     "trust": "user", "optional": false}
  ],
  "prompt": {"file": "/.keylos/agent/prompt.md", "digest": "sha256:…"},
  "policy": {"file": "/.keylos/agent/policy.json", "digest": "sha256:…"},
  "flowProof": null
}
```

`tools.json` (`keylos.agent-tools/1`): `{"schema", "tools": [{"name", "kind": "vm"|"cmd"|"host", "description", "inputSchema", "exec", "command", "cmdsig", "digest"}]}`. Host tools have reserved names `keylos.effect.stage`, `keylos.grant.request`, `keylos.human.ask`, `keylos.subagent.spawn`, `keylos.powerbox.open`.

`policy.json` (`keylos.agent-policy/1`): `{"schema", "maxDepth", "maxFanout", "defaultDurationSecs", "budgetDefaults": ["unit:amount"…], "effectKinds": {"stage": […], "commit": […]}, "breakers": {…}, "retainOverlayDays"}`. It can only narrow the grants the launching human passes.

**Pinning rules:**
- Each tool's `digest` = SHA-256 over the JCS form of the tool object with `digest` removed.
- `tools.digest` = SHA-256 over the JCS bytes of `tools.json`.
- A remote MCP server's `toolsDigest` = SHA-256 over the JCS form of its `tools/list` result `tools` array, each tool reduced to `{name, description, inputSchema}` and sorted by name.
- Any change to a pinned digest produces a new template generation, which needs consent.
- `flowProof: "camel/1"` requires `harness.placement = "wasi"`.
- `vm.desktop: true` makes the session an agent desktop (§14.5): the VM is started with purpose `agentDesktop` and `AgentHostExt.desktop` is available.
- **Model identity.** Remote models are identified by `(provider, model, minVersion)`; local models by the `weights` data generation digest, which pins them exactly. The model-drift rule is §14.5.

#### 2.3.6 protocols §7.1 Model

All keylos IPC between principals on one kernel uses **Cap'n Proto RPC (rpc.capnp, level 1 plus promise pipelining)** over **AF_UNIX `SOCK_SEQPACKET`** sockets.

- **There is no system bus.** A process can reach only the capabilities it was handed:
  - the bootstrap capability of each socket `warden` passed to it at spawn (listed in `KEYLOS_CAPWIRE_FDS`, §10.5),
  - capabilities returned by calls on those.
- **The one exception is the CRI boundary** (§21): the upstream `kubelet` speaks the Kubernetes CRI v1 gRPC API to `cri` over an `AF_UNIX` `SOCK_STREAM` socket that `warden` creates and passes to `kubelet` (route `cri#kubelet`). No other non-capwire IPC between keylos principals is allowed.
- **Holding is authority.** A capability or an fd received through capwire is itself the authority to use it. capwire has **no call-attached tokens**: methods that need token-based authority take an explicit `C.Token` parameter; otherwise the route facet or the held capability is the authority.
- **Framing:** one Cap'n Proto message (standard segment-table framing) per datagram.
  - Maximum datagram size: 4 MiB.
  - Larger data MUST use a `ByteStream`/`ByteSource` capability or a passed fd.
- **File descriptors** travel as `SCM_RIGHTS` ancillary data on the same datagram, at most 64 per datagram. Inside the message, an fd is referenced by an `Fd` struct whose `index` is its position in that datagram's fd array.
  - **No fd** is written as `index = 0xFFFF`, which is the struct default; a null `Fd` pointer also means "no fd". Senders SHOULD write `Fd` structs explicitly. A method that requires an fd fails with `kl:invalid` when it gets none.
  - An `Fd.index` that is out of range, or that a receiver resolves a second time, fails **that call** (or that result's processing) with `kl:invalid`; the connection stays up. The transport is schema-unaware, so an index is checked when the receiver resolves the field.
  - Every received fd that no field took is closed when the receiver releases the message (call parameters released, or the response dropped).
  - Fds can be attached to any parameter or result struct of a message built on a capwire connection, including structs with pointer fields only; a caller does not need to resolve a bootstrap promise before sending fds on it.
  - `ENOBUFS` and `ENOMEM` from `sendmsg` are transient: the sender retries with backoff for up to 1 s before it fails the connection.
- **Datagram rules** (violations are protocol errors that fail the **whole connection**, reported to the local side as `kl:invalid`): exactly one standard-framed message per datagram with no trailing bytes; size ≤ 4 MiB; ≤ 64 fds; ancillary data not truncated (`MSG_TRUNC`/`MSG_CTRUNC`); fds never on capwire-vsock. Senders MUST NOT send zero-length datagrams; a receiver reads a zero-byte datagram as end of connection. A sender whose own outgoing message would exceed 4 MiB fails the connection rather than leave the peer waiting.
- **Socket buffers.** `warden` (and any component that creates capwire sockets for others) sets `SO_SNDBUFFORCE` and `SO_RCVBUFFORCE` to at least 4 MiB + 64 KiB (4 259 840 bytes) on both ends of every capwire socketpair it creates, so 4 MiB datagrams fit; distributions set `net.core.wmem_max` and `net.core.rmem_max` ≥ 4 259 840 (§2). capwire-vsock endpoints set `SO_VM_SOCKETS_BUFFER_SIZE`/`_MAX_SIZE` to the same value.
- **Peer identity:**
  - Every capwire connection between principals is a `socketpair` created by `warden` (§7.2). For such sockets the kernel records the **creating** process (`warden`) as the peer of both ends, so `SO_PEERPIDFD` and `SO_PEERCRED` name `warden`, not the peer. Servers MUST take the peer's principal, tier, generation and facet **only** from `ServiceHost.accept` (§7.5.1), or from `Supervisor.connectionInfo` for a connection ID `warden` delivered.
  - `SO_PEERPIDFD` + `Supervisor.identify` MAY be used only for sockets the peer itself `connect()`ed to a listening socket (not used between keylos principals in 1.0; reserved for diagnostics and future listeners).
  - Servers MUST NOT use PIDs, executable paths, or claims inside messages to decide who the caller is.
- **Bootstrap:** the socket's bootstrap capability implements the service's root interface **and** `common.Extensible` (§7.3.1). It is already narrowed by `warden` to the route's facet (§7.2).

#### 2.3.7 protocols §7.2 Routes and facets

`warden` wires services according to **routes** declared in service and app manifests plus policy.

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

- A **facet** is a server-defined restriction name. The registry of every facet, its holders and the methods it allows is §19.2. Servers MUST refuse methods their facet doesn't allow with `kl:denied`.
- Route references are written `service#facet` (for example `vault#app`).
- The server learns the facet of each connection from `ServiceHost.accept` (§7.5.1) or `Supervisor.connectionInfo`.
- Service sockets live under `/run/keylos/svc/<service>/` with mode `0700`, owned by `warden`'s UID. No other principal can `connect()` to them. Connections are created by `warden` (`socketpair` + hand-off through `ServiceHost.accept`).
- Dynamic routes (a service capability granted at runtime) are materialised by `broker` through `ServiceConnect.connectService` (§7.5.1).

#### 2.3.8 protocols §7.2.1 capwire-vsock profile

Between a VM guest and the host, capwire runs over **`AF_VSOCK` `SOCK_SEQPACKET`** with these differences:
1. **No fd passing.** `Fd` fields MUST NOT appear in messages on this profile; receivers MUST reject them.
2. Bulk data uses `ByteStream`/`ByteSource` capabilities, or dedicated vsock stream connections on the bulk port range (§19.5) announced in messages.
3. **Authentication.** The host identifies the VM by its vsock CID, which `bench` assigns uniquely per running VM (CID ≥ 3). The guest is never trusted for identity claims; every host-side endpoint is bound to exactly one VM principal.
4. Ports are registered in §19.5. The guest initiates every connection to host CID 2.

#### 2.3.9 protocols §7.3.1 `common.capnp`

```capnp
@0xc7a1e5d3b2f40001;

struct Digest {
  algo  @0 :Algo;
  bytes @1 :Data;            #! sha256/fsv256: 32 bytes; sha512: 64 bytes
  enum Algo { sha256 @0; sha512 @1; fsv256 @2; }
}

struct Ref {                 # typed reference, protocols §3.2
  kind   @0 :Kind;
  digest @1 :Digest;
  enum Kind { obj @0; gen @1; src @2; drv @3; rcpt @4; key @5; }
}

struct Fd { index @0 :UInt16 = 0xFFFF; }   #! index into the SCM_RIGHTS array of the carrying datagram; 0xFFFF (the default) and a null pointer mean "no fd"

struct Timestamp { unixNanos @0 :Int64; }

struct PrincipalId { text @0 :Text; }   #! canonical text form, protocols §3.4
struct SessionId   { text @0 :Text; }

struct Label {
  conf  @0 :Conf;
  integ @1 :Integ;
  enum Conf  { public @0; internal @1; private @2; secret @3; }
  enum Integ { trusted @0; user @1; untrusted @2; }
}

struct Token { biscuit @0 :Data; }      #! Biscuit v3 serialized token, protocols §8

struct KeyValue { key @0 :Text; value @1 :Text; }

struct AttemptBinding {          #! one execution attempt of a durable workflow (§20.25); epoch 0 (the default) = not an attempt
  workflow @0 :Text;             # wf-…
  attempt  @1 :Text;             # wa-…
  epoch    @2 :UInt64;           # ownership epoch of the claim (BrokerWorkflow.claim, §7.5.25)
  step     @3 :Text;             # ws-… the attempt executes
  owner    @4 :Text;             # the workflow's owning human; warden uses it as the attempt principal's human
}

interface ByteStream {
  write @0 (bytes :Data) -> stream;
  done  @1 ();
}

interface ByteSource {
  read @0 (maxBytes :UInt32) -> (bytes :Data, eof :Bool);
}

interface Cancelable { cancel @0 (); }

interface Watcher(T) {          # server-push subscription
  event @0 (event :T) -> stream;
}

interface Extensible {          #! implemented by every bootstrap capability
  ext     @0 (interfaceId :UInt64) -> (cap :Capability);   #! kl:denied if the facet does not allow that interface, or the server does not implement it
  version @1 () -> (protocols :Text, implementation :Text);   #! protocols: SemVer of this document ("1.0.0"); implementation: "<repo>/<SemVer>"
}
```

**Errors.** Methods signal failure with a Cap'n Proto exception of type `failed`. The exception `reason` string MUST start with `kl:<code>`, optionally followed by `:<ref>` (non-empty), then optionally a space and a human-readable message. Codes outside the table are a parse error. Root interfaces are not declared `extends(C.Extensible)`; clients obtain the `Extensible` view of a bootstrap capability by casting the same capability.

| Code | Meaning |
|---|---|
| `denied` | Policy refused. Not retryable without new authority. |
| `needs-approval` | `:<ref>` is an approval ID (`a-…`). Retry after the approval resolves, or use the returned `Approval`. |
| `not-found` | |
| `invalid` | Malformed request |
| `conflict` | State changed concurrently |
| `expired` | |
| `revoked` | |
| `budget` | Budget exhausted |
| `integrity` | Verification failure: signature, digest, fs-verity |
| `unavailable` | Transient; MAY retry with backoff |
| `unsupported` | Feature level or platform lacks support |
| `internal` | |

Example: `kl:needs-approval:a-01JB6R… Sending email requires approval`.

#### 2.3.10 protocols §7.3.3 `broker.capnp`

```capnp
@0xc7a1e5d3b2f40003;
using C = import "common.capnp";

struct NetTarget {
  host    @0 :Text;            # DNS name or IP literal; "listen:<addr>" requests a listening socket (§7.3.7)
  port    @1 :UInt16;
  proto   @2 :Proto;
  methods @3 :List(Text);      # HTTP methods, empty = protocol-level grant only
  enum Proto { tcp @0; udp @1; https @2; }
}

struct Budget { unit @0 :Text; amount @1 :Int64; }   # unit: "usd-micro", "tokens", "calls"

struct ResourceRef {
  union {
    path      @0 :Text;          # resolved by broker with openat2(RESOLVE_BENEATH) from a held root
    dirFd     @1 :C.Fd;          # caller already holds it; request attenuation/annotation
    net       @2 :NetTarget;
    device    @3 :Text;          # device id, protocols §3.5
    secret    @4 :Text;          # vault item name (caller-scoped)
    budget    @5 :Budget;
    spawn     @6 :C.Ref;         # right to spawn a generation
    service   @7 :Text;          # "name#facet"
    effect    @8 :Text;          # effect kind, e.g. "email.send"
    delegate  @9 :Void;          # right to create sub-principals
    principal @10 :DebugTarget;  # debug target (Right.debug), §9.3
    screen    @11 :Text;         # "window:<atrium window id>": one still snapshot of a real-session window (Right.read), §14.5
    model     @12 :Text;         # "<provider>/<model>@<version>": re-approval of an agent session's model after drift (Right.use), §14.5
  }
}

struct DebugTarget {
  target  @0 :Text;              # "session:s-…" (a running session and its descendants) or "gen:fsv256:…" (any instance of a generation of the requesting human)
  scope   @1 :Scope;
  enum Scope { process @0; kernel @1; }   #! kernel: bpftrace-class tracing, presence-only, ≤ 900 s
}

enum Right { read @0; write @1; create @2; delete @3; exec @4; connect @5; bind @6; use @7; spend @8; spawn @9; stage @10; commit @11; delegate @12; debug @13; }

struct GrantRequest {
  resource     @0 :ResourceRef;
  rights       @1 :List(Right);
  reason       @2 :Text;         # shown to the human
  durationSecs @3 :UInt32;       # 0 = policy default
  persist      @4 :Bool;         # request a persistent grant (survives session and reboot; needs presence)
  onBehalfOf   @5 :C.PrincipalId; # informational only (vault, depot, strata, atrium via requestFor): the principal the service acts for;
                                  #! shown on the prompt and recorded in receipts; never used for authorization
}

struct GrantOutcome {
  union {
    granted @0 :C.Token;
    pending @1 :Approval;
    denied  @2 :Text;
  }
}

interface Approval {
  id      @0 () -> (id :Text);
  wait    @1 () -> (outcome :GrantOutcome);
  cancel  @2 () -> ();
  mandate @3 () -> (mandate :Data);   #! DSSE keylos.mandate/1 after approval; kl:not-found before or if denied
}

struct Handle {
  union {
    fd      @0 :C.Fd;            # file, dirfd (O_PATH), device, memfd
    socket  @1 :C.Fd;            # connected socket (usually to gate) or capwire socket to a service
    cap     @2 :Capability;      # service capability
  }
}

interface Broker {
  request     @0 (req :GrantRequest) -> (outcome :GrantOutcome);
  materialize @1 (token :C.Token, resource :ResourceRef, rights :List(Right)) -> (handle :Handle);
  attenuate   @2 (token :C.Token, checks :List(Text)) -> (token :C.Token);  #! Datalog checks, protocols §8.3
  delegate    @3 (tokens :List(C.Token), child :C.SessionId, checks :List(Text)) -> (tokens :List(C.Token));
  revoke      @4 (rootId :Data) -> ();
  inspect     @5 (token :C.Token) -> (facts :List(Text), expires :C.Timestamp, rootId :Data);
  label       @6 () -> (label :C.Label);
  raiseLabel  @7 (label :C.Label, reason :Text) -> (label :C.Label);  #! raises the CALLER's session label only; labels only go up
  powerbox    @8 (req :PowerboxRequest) -> (grants :List(PowerboxGrant));
  myGrants    @9 () -> (tokens :List(C.Token));
  debug       @10 (token :C.Token, debugger :C.Ref, entrypoint :Text, argv :List(Text), pty :C.Fd) -> (process :Capability);
      #! materialises a Right.debug grant through warden DebugAttach (§7.5.1); returns a warden.Process
}

struct PowerboxRequest {
  kind     @0 :Kind;
  title    @1 :Text;
  mimeTypes @2 :List(Text);
  multiple @3 :Bool;
  suggestedName @4 :Text;
  enum Kind { openFile @0; openDirectory @1; saveFile @2; }
}

struct PowerboxGrant {
  fd    @0 :C.Fd;        # opened file, or O_PATH dirfd usable in the holder's view (attached via GrantMounts, §7.5.1)
  token @1 :C.Token;     # token describing the grant (for persistence / delegation)
  displayName @2 :Text;
  viewPath @3 :Text;     # path of the grant inside the holder's view (/grants/<name>), for path-expecting code
}
```

**Directory grants and Landlock.** A Landlock domain cannot be widened after `restrict_self`. A directory granted at runtime is therefore made reachable by `warden` attaching a bind mount at `/grants/<name>` inside the holder's mount namespace (`GrantMounts.attachGrant`, §7.5.1), whose subtree is covered by the Landlock rule the view was built with (`/grants` is allowed at spawn with the access rights of the highest possible grant; actual access is bounded by mount flags and the attached tree). `materialize` of a path or dirFd grant returns an fd opened **through that mount**.

**Directory grant ceilings.** Every directory grant has an **exposure label** (its ceiling, §14.1). The broker raises the holder's session label to the ceiling **before** the mount is attached, and passes the ceiling to `attachGrant`; `warden` then refuses, for the grant's lifetime, every open of an object through that mount (and every read through an fd opened through it) whose label exceeds the ceiling or is malformed (§9.3). Grant trees are non-recursive bind mounts: mounts nested below the granted directory are not reachable through the grant.

**Single-file grants.** A file picked for a path-expecting client is never exposed by attaching its parent directory. It is exposed as a **single-file view** `/grants/<name>/<basename>`: a directory served by `portal-files` that contains only the selected file and the holder's own temporary files. Writes follow the granted rights (a read-only grant refuses every write); a safe-save `rename(<temporary> → <basename>)` is carried out by `portal-files` as an atomic replace of the selected file in its real parent, whose dirfd `portal-files` holds and never exposes; every other name is refused. Access to the parent or any sibling needs an explicit `openDirectory` consent. Remembered grants, re-materialization, revocation and drag-and-drop keep the same single-file scope.

#### 2.3.11 protocols §7.3.7 `gate.capnp`

```capnp
@0xc7a1e5d3b2f40007;
using C = import "common.capnp";
using B = import "broker.capnp";

enum EffectClass { reversible @0; compensable @1; irreversible @2; }

struct EffectArg { name @0 :Text; value @1 :Text; source @2 :Text; label @3 :C.Label; }

struct EffectIntent {
  kind        @0 :Text;            # registered effect kind, protocols §14.2
  class       @1 :EffectClass;
  target      @2 :Text;            # e.g. "smtp:mail.example.com", "https://api.github.com/repos/o/r/pulls"
  args        @3 :List(EffectArg);
  idempotencyKey @4 :Text;
  compensator @5 :Text;            # registered compensator kind, empty if none
  payload     @6 :C.Fd;            # full request body / message
}

struct IntentStatus {
  id     @0 :Text;
  state  @1 :State;
  result @2 :Text;
  receipt @3 :Text;                # rcpt ref
  enum State { staged @0; approved @1; committed @2; failed @3; canceled @4; compensated @5; }
}

interface Intent {
  status   @0 () -> (status :IntentStatus);
  dryRun   @1 () -> (rendered :List(Text));
  commit   @2 () -> (status :IntentStatus);          # may throw kl:needs-approval
  cancel   @3 () -> ();
  compensate @4 () -> (status :IntentStatus);
}

interface Gate {
  connect   @0 (target :B.NetTarget, token :C.Token) -> (socket :C.Fd);   # proxied, policy-checked stream; target.host "listen:<addr>" returns a listening socket
  stage     @1 (intent :EffectIntent) -> (intent :Intent);
  intents   @2 (session :C.SessionId) -> (list :List(IntentStatus));
      #! facet client: the named session MUST be the caller's own session or a descendant; returns intents of that session
      #! and all its descendant sessions, recursively
  meter     @3 (rootId :Data) -> (spent :List(B.Budget), remaining :List(B.Budget));
  charge    @4 (rootId :Data, amount :B.Budget, reason :Text) -> ();      # facet meter only
  intent    @5 (id :Text) -> (intent :Intent);
      #! facet client: only intents staged by the caller's session or its descendants (kish `effects` commit/cancel)
}
```

**Terminated HTTP mode.** For `https` grants that need method filtering or credential injection, a native client does not get an end-to-end TLS stream: `connect` returns a socket on which the client speaks **plain HTTP/1.1** to `gate`, which terminates the request, applies method checks and credential injection, and performs TLS to the real host itself. Clients detect this from the token's `net` fact (`$method` ≠ `"*"`). Legacy and VM clients use the TLS-interception path instead (§9.4). SDKs MUST support the terminated mode.

**Acting for a subject.** On facet `aide`, `stage` acts for the agent session whose token is carried in the intent arg `x-subject-token` (base64 Biscuit); `gate` stages for that token's `principal` after verifying `right("effect", kind, "stage")`. On facet `broker`, `connect` acts for the token's `principal`. On every other facet the subject is the caller.

#### 2.3.12 protocols §7.3.8 `depot.capnp`

```capnp
@0xc7a1e5d3b2f40008;
using C = import "common.capnp";

struct GenerationInfo {
  ref       @0 :C.Ref;
  kind      @1 :Text;
  name      @2 :Text;
  version   @3 :Text;
  manifest  @4 :Data;         # manifest JSON bytes
  launchable @5 :Bool;
  sealedBy  @6 :List(Text);   # key refs whose signatures over the generation statement verified
  grafted   @7 :Bool;
  revoked   @8 :Bool;
  installed @9 :C.Timestamp;
  launchReasons @10 :List(Text);   # why launchable is false: "no-authorising-signature", "revoked:<reason>", "needs-consent",
                                   # "quorum-deferred", "unreviewed-tier2", "offline-install-needs-t3", "kernel-mismatch" (kmod)
}

interface Depot {
  get        @0 (ref :C.Ref) -> (info :GenerationInfo);
  list       @1 (kind :Text, name :Text) -> (list :List(GenerationInfo));
  install    @2 (source :Text) -> (info :GenerationInfo, capabilityDiff :Text);  # "oci://…[#gen=fsv256:…]", "tuf:<stream>/<name>", ".klb" bundle fd path via powerbox
  mount      @3 (ref :C.Ref) -> (tree :C.Fd);          #! facet mounter (warden, bench, compat) and config (kind config only); fsmount fd (composefs, verity=require)
  openObject @4 (ref :C.Ref) -> (fd :C.Fd);            # read-only fd of store object
  importTree @5 (tree :C.Fd, manifest :Data) -> (info :GenerationInfo);   # facets forge (all kinds), config (config, policy), compat (legacy-image)
  seal       @6 (ref :C.Ref, statement :Data) -> (info :GenerationInfo);  # attach owner seal (DSSE seal statement signed via HearthSeal)
  root       @7 (ref :C.Ref, holder :Text) -> ();      # GC root
  unroot     @8 (ref :C.Ref, holder :Text) -> ();
  gc         @9 (dryRun :Bool) -> (freedBytes :UInt64, removed :List(C.Ref));
  verify     @10 (ref :C.Ref) -> (ok :Bool, problems :List(Text));
  revocations @11 () -> (listEnvelope :Data);
  openPath   @12 (ref :C.Ref, path :Text) -> (fd :C.Fd);
      #! read-only fd of a regular file inside a generation, resolved in the generation's own tree (no symlink escape).
      #! facet user: only paths under /.keylos/ (manifest.json, cmdsig/*, l10n/*, agent/*, icons/*, sbom.spdx.json,
      #! provenance.json, workflows/*) of generations the caller may spawn, agent templates, or catalog entries; facet mounter: any path;
      #! facet loom: /.keylos/manifest.json and /.keylos/workflows/* of any installed generation
  revocationStatus @13 () -> (serial :UInt64, issued :C.Timestamp, ageSecs :UInt64);
      #! facets user, mounter, compat: the newest verified revocation list; ageSecs measured against trusted time (§3.6, §14.5)
}
```

**GC roots** are named `<holder>:<purpose>:<id>`. Registered holder prefixes: `loom:workflow:<wf-id>` (the pinned definition generation of every workflow that is not yet terminal, and of a terminal one until it is forgotten; §20.25), `warden:running:<session>` (every generation `warden` mounted; `warden` calls `unroot` when the last principal using that mount exits, so `depot` needs no unmount notification), `cri:pod:<pod-id>` (container generations and images of a pod), `courier:os:<seq>` (bootable OS generations), `courier:kmod:<kernel-release>` (kmod generations for an installed kernel). Other prefixes are repo-local.

**Container mounts.** `mount` of a `container` generation succeeds only while it is rooted by a `cri:pod:<pod-id>` holder; `cri` roots it before calling `PodSpawn` (§21.4).

`install("tuf:<stream>/<name>")` and `install("tuf:org:<org>/<name>")` are resolved through `CourierResolver.resolve` (§7.5.6), which also returns the catalog review status; `depot` is never a TUF client. Revocation lists reach `depot` the same way: `courier` resolves `tuf:<stream>/revocations` and `depot` takes the DSSE list from `Resolution.revocations` (§7.5.6). Source form `oci+container://<registry>/<repo>@sha256:<manifest>` (facet `cri` only) converts an OCI image into a `container` generation (§21.4). `courier` installs OS generations with the source form `oci://<registry>/<repo>@sha256:<manifest>#gen=fsv256:<hex>`, which `depot` MUST accept (the fragment pins the expected generation digest).

#### 2.3.13 protocols §7.3.11 `config.capnp`

```capnp
@0xc7a1e5d3b2f40011;
using C = import "common.capnp";

interface Plan {
  diff    @0 () -> (rendered :Text);               # human-readable effect rendering
  files   @1 () -> (changes :List(Text));
  restarts @2 () -> (services :List(Text));
  capabilityChanges @3 () -> (rendered :Text);
  apply   @4 () -> (generation :C.Ref);            # requires owner-presence via TrustedPrompt
}

interface Config {
  propose  @0 (source :C.Fd, origin :C.PrincipalId) -> (plan :Plan);   # source: dirfd of config repo checkout
  current  @1 () -> (generation :C.Ref, sourceRev :Text);
  history  @2 (limit :UInt32) -> (list :List(C.Ref));
  revert   @3 (generation :C.Ref) -> (plan :Plan);
  adopt    @4 (appName :Text) -> (patch :Text);     # diff from mutable app layer to declaration
  drift    @5 () -> (report :Text);
}
```

#### 2.3.14 protocols §7.3.13 `bench.capnp`

```capnp
@0xc7a1e5d3b2f40013;
using C = import "common.capnp";
using W = import "warden.capnp";
using B = import "broker.capnp";

struct Share { name @0 :Text; dir @1 :C.Fd; writable @2 :Bool; overlay @3 :Bool; }

struct VmSpec {
  image     @0 :C.Ref;              # bench-image generation
  shares    @1 :List(Share);
  vcpus     @2 :UInt16;
  memoryMiB @3 :UInt32;
  gpu       @4 :Bool;               # virtio-gpu native context
  network   @5 :List(C.Token);      # net grants; all egress via bench-net → gate
  display   @6 :Bool;               # Wayland proxy to atrium (tier-2 apps, workbench apps such as IDEs, agent-desktop mirrors)
  fromSnapshot @7 :Text;
  session       @8 :C.SessionId;    # the VM principal's session; bench generates it if empty
  parentSession @9 :C.SessionId;    # session the VM principal descends from (agent: the aide-created session chain parent)
  principalKind @10 :W.SpawnSpec.ActorKind;   # bench (default), agent, legacy, pod
  storeSet      @11 :List(C.Ref);   # generations exposed read-only in the guest store (/store) in addition to the image closure
  unsignedImageOk @12 :Bool;        #! honoured only for facet user calls by service:forge with purpose build, tier 3
  purpose       @13 :Purpose;
  displayMode   @14 :DisplayMode;   # meaningful when display = true
  gpuPassthrough @15 :Text;         # PCI address of a VFIO-claimed GPU (needs.gpu "passthrough"); empty = none
  blockDevices  @16 :List(BlockDev);   # media VMs and pod VMs: block devices claimed through devd MediaAttach
  enum Purpose { workbench @0; agent @1; app @2; media @3; build @4; captive @5; pod @6; agentDesktop @7; }
  enum DisplayMode { interactive @0; readOnly @1; }   # readOnly: human watches an agent desktop; takeOver switches to interactive
  struct BlockDev { device @0 :Text; fd @1 :C.Fd; readOnly @2 :Bool; }
  bootArgs      @17 :List(C.KeyValue);  # delivered to the guest over benchd control at boot (e.g. "captive.url" for purpose captive)
  tap           @18 :C.Fd;              #! purpose pod only (facet cri): tap device created in the cri network namespace; index 0xFFFF = none
  tapConfig     @19 :TapConfig;
  podId         @20 :Text;              # purpose pod: pod-… (§3.5); bench places the VMM processes under the pod's cgroup
  struct TapConfig { ifname @0 :Text; mac @1 :Text; mtu @2 :UInt16; }
  attempt       @21 :C.AttemptBinding;  #! facet aide only (agent attempts of a workflow, §20.25); copied to VmPrincipal.attempt
}

struct ForkSpec {
  session       @0 :C.SessionId;    # session of the forked VM principal; bench generates it if empty
  parentSession @1 :C.SessionId;    # defaults to the source VM's parentSession
  principalKind @2 :W.SpawnSpec.ActorKind;   # aide forks: agent; default: the source VM's kind
  offered       @3 :List(C.Token);    #! tokens for the fork; default: the source VM principal's tokens (sub-agents: the parent agent's)
  checks        @4 :List(Text);       #! attenuation checks for the fork (copied to VmPrincipal.checks)
  budgets       @5 :List(B.Budget);   #! sub-budgets for the fork (copied to VmPrincipal.budgets)
  attempt       @6 :C.AttemptBinding; #! facet aide only: the fork is an attempt of a workflow (§20.25); copied to VmPrincipal.attempt
}

interface Vm {
  exec     @0 (argv :List(Text), env :List(C.KeyValue), fds :List(W.FdMapping), tty :Bool) -> (process :W.Process);
  snapshot @1 (name :Text) -> (id :Text);
  fork     @2 (spec :ForkSpec) -> (vm :Vm);         #! spec null = defaults; the fork is a new VM principal registered through VmSpawn
  changes  @3 () -> (shares :List(Text));          # per-share change summaries
  commit   @4 (share :Text) -> (transaction :Text); # human workbenches only; agent overlays merge via BenchMerge (§7.5.10)
  discard  @5 () -> ();
  stop     @6 () -> ();
  console  @7 () -> (pty :C.Fd);
  attachShare @8 (share :Share) -> ();             #! hot-plug: new virtio-fs export in the running VM; the guest sees /shares/<name>
  detachShare @9 (name :Text) -> ();               #! open guest files on the share get EIO afterwards
  desktop  @10 () -> (desktop :Capability);        #! purpose agentDesktop only: returns an aide-sys AgentDesktop (§7.5.13)
  takeOver @11 (interactive :Bool) -> ();          # agentDesktop: switch the human's mirror between readOnly and interactive
  info        @12 () -> (session :C.SessionId, cgroupId :UInt64, cid :UInt32, purpose :VmSpec.Purpose);
  attachBlock @13 (dev :VmSpec.BlockDev) -> ();    #! hot-plug a virtio-blk device (pod VMs: CSI volumes published after start)
  detachBlock @14 (device :Text) -> ();
}

interface Bench {
  start     @0 (spec :VmSpec) -> (vm :Vm);
  project   @1 (projectDir :C.Fd) -> (vm :Vm);     # start/attach project workbench per project.ncl
  snapshots @2 () -> (list :List(Text));
  media     @3 (device :Text) -> (vm :Vm, browser :Capability);
      #! starts (or attaches to) the media VM for an authorized removable block device; browser is a bench-sys MediaBrowser (§7.5.10)
  reattach  @4 (session :C.SessionId) -> (vm :Vm);
      #! a new Vm capability for a running VM started by the same caller principal (cri after a crid restart, aide).
      #! VMs of purposes pod, agent and agentDesktop outlive their Vm capability until Vm.stop, the end of their parent
      #! session, or a bench restart (which stops every VM)
}
```

#### 2.3.15 protocols §7.3.14 `aide.capnp` (implemented by this repo)

```capnp
@0xc7a1e5d3b2f40014;
using C = import "common.capnp";

struct AgentEvent {
  time    @0 :C.Timestamp;
  session @1 :C.SessionId;
  union {
    message   @2 :Text;            # agent → human text
    toolCall  @3 :Text;            # JSON {tool, args}
    toolResult @4 :Text;
    approval  @5 :Text;            # approval id pending
    effect    @6 :Text;            # intent id
    label     @7 :C.Label;
    budget    @8 :Text;
    finished  @9 :Text;
    rich      @10 :Text;           # JCS JSON {"type": "state"|"question"|"breaker"|"mcpPinMismatch"|"discrepancy"|"grant"|"modelChange"|"desktop", …}
  }
}

interface AgentSession {
  id       @0 () -> (id :C.SessionId);
  send     @1 (text :Text) -> ();                      # human → agent
  events   @2 (watcher :C.Watcher(AgentEvent)) -> (cancel :C.Cancelable);
  changes  @3 () -> (summary :Text);
  review   @4 () -> (prompt :Text);                    # stages fs.merge intents; opens T3 review on trusted path
  stop     @5 () -> ();
  fork     @6 () -> (session :AgentSession);
  takeOver @7 (interactive :Bool) -> ();             # human: switch the agent-desktop mirror (relayed to Vm.takeOver)
  attempt  @8 () -> (binding :C.AttemptBinding);     # the workflow attempt this session executes (§20.25); epoch 0 if none
}

struct SessionSpec {
  template  @0 :C.Ref;               # agent-template generation
  task      @1 :Text;
  grants    @2 :List(C.Token);       # attenuated from the human's authority
  project   @3 :C.Fd;                # optional project dirfd
  budget    @4 :List(Text);          # e.g. "usd-micro:5000000"
  deadlineSecs @5 :UInt32;
}

interface Aide {
  start    @0 (spec :SessionSpec) -> (session :AgentSession);
  sessions @1 () -> (list :List(C.SessionId));
  attach   @2 (id :C.SessionId) -> (session :AgentSession);
}

interface AgentHost {                 # served by aide to the harness inside the workbench (vsock port 7002)
  tools     @0 () -> (json :Text);     # pinned tool definitions
  callTool  @1 (name :Text, argsJson :Text, provenanceJson :Text) -> (resultJson :Text, label :C.Label);
  model     @2 (requestJson :Text) -> (responseJson :Text);   # model API via gate (metered)
  emit      @3 (event :AgentEvent) -> ();
  requestGrant @4 (reasonJson :Text) -> (outcomeJson :Text);
}
```

#### 2.3.15a protocols §7.5.1 `warden-sys.capnp` (`VmSpawn`, `VmPrincipal`: how agent VM principals are registered)

```capnp
@0xc7a1e5d3b2f40020;
using C = import "common.capnp";
using W = import "warden.capnp";
using B = import "broker.capnp";

interface Bootstrap {                  #! bootstrap of fd 3 in every tier-0 service (connection to warden)
  host     @0 (host :ServiceHost) -> ();   # the service registers its ServiceHost; MUST be called first
  ready    @1 () -> ();                    # readiness signal
  watchdog @2 () -> ();                    # liveness ping (interval from the service manifest)
  status   @3 (text :Text) -> ();          # human-readable status line
}

interface ServiceHost {                #! implemented by every tier-0 service; warden is the only caller
  accept @0 (socket :C.Fd, connectionId :UInt64, facet :Text, peer :C.PrincipalId, tier :W.Tier, generation :C.Ref) -> ();
  stop   @1 (reason :Text) -> ();          # cooperative stop before SIGTERM
  reload @2 () -> ();                      # the config generation changed; warden has rebuilt the service's /etc view
}

interface GrantMounts {                # facets broker, bench, compat, portals, cri (idmappedDir only)
  attachGrant @0 (session :C.SessionId, name :Text, tree :C.Fd, readOnly :Bool, ceiling :C.Label) -> (inView :C.Fd, viewPath :Text);
      #! bind-mounts tree (non-recursive, idmapped to the holder's dynamic UID) at /grants/<name> in the holder's mount namespace;
      #! inView = O_PATH fd of the mount root opened through the holder's namespace;
      #! ceiling = the grant's exposure label (§14.1): objects labelled above it are never readable through the mount;
      #! a null ceiling means no enforcement (the caller MUST then have raised the holder to secret/untrusted)
  detachGrant @1 (session :C.SessionId, name :Text) -> ();
  idmappedDir @2 (dir :C.Fd, forPrincipal :C.PrincipalId, readOnly :Bool) -> (tree :C.Fd);
      #! detached idmapped clone (open_tree + mount_setattr MOUNT_ATTR_IDMAP); used by bench/compat for shares
}

enum TerminateMode { kill @0; freeze @1; thaw @2; }

struct PrincipalEvent {
  session   @0 :C.SessionId;
  principal @1 :C.PrincipalId;
  time      @2 :C.Timestamp;
  union {
    spawned @3 :W.Tier;
    exited  @4 :W.ExitStatus;
    frozen  @5 :Void;
    thawed  @6 :Void;
  }
  cgroupId  @7 :UInt64;          # kernel cgroup id of the principal's scope (stable for the session's lifetime)
}

interface PrincipalControl {           # facets broker, admin, hearth (terminate own humans' sessions), strata (events, mountView), cri (pod sessions)
  terminate @0 (session :C.SessionId, mode :TerminateMode) -> ();   #! applies to the session and all descendant sessions
  list      @1 (humanFilter :Text) -> (sessions :List(C.PrincipalId));
  events    @2 (watcher :C.Watcher(PrincipalEvent), replay :Bool) -> (cancel :C.Cancelable);
      #! replay = true: first emits one `spawned` event for every currently running session (visible to the facet), then live events
  mountView @3 (session :C.SessionId) -> (json :Text);               # JCS: [{target, source, flags, grant}]
  fenceWriters @4 (tree :C.Fd, exclude :List(C.SessionId)) -> (fence :WriterFence);
      #! facet strata: freezes every session (except exclude and their descendants) whose view can write inside tree,
      #! and returns once they are frozen; kl:conflict if a writer cannot be frozen (tier-0 service other than strata,
      #! kernel or network filesystem writer); released by WriterFence.release, when the capability is dropped, or after 30 s
}

interface WriterFence {
  sessions @0 () -> (list :List(C.SessionId));   # the frozen sessions
  release  @1 () -> ();                         # thaws them
}

interface ServiceConnect {             # facet broker
  connectService @0 (session :C.SessionId, service :Text, facet :Text) -> (socket :C.Fd);
      #! creates a route for an existing principal; returns the principal-side capwire socket
}

interface FdStore {                    # facet service (each service sees only its own keys)
  store @0 (key :Text, fd :C.Fd) -> ();    #! survives the service's restarts within one boot
  fetch @1 (key :Text) -> (fd :C.Fd);
  drop  @2 (key :Text) -> ();
}

struct LegacyGrant { tree @0 :C.Fd; target @1 :Text; readOnly @2 :Bool; }

struct LegacyView {
  image    @0 :C.Ref;                  # legacy-image generation
  stateDir @1 :C.Fd;                   # per-image writable state (overlay upper + work)
  grants   @2 :List(LegacyGrant);
  netMode  @3 :Text;                   # "none" | "pasta"
}

interface LegacySpawn {                # facet compat
  spawnLegacy @0 (spec :W.SpawnSpec, view :LegacyView, brokerSession :C.SessionId) -> (process :W.Process, notifyFd :C.Fd);
      #! user namespace with a 65 536-UID block, child user.max_user_namespaces=0;
      #! notifyFd = seccomp user-notification listener for the open broker (protocols §9.2);
      #! brokerSession = the per-app open-broker session that gets the read pairing to this app (§9.3)
}

interface UserSpawn {                  # facets launcher (atrium launcher), handler (portal-openuri, portal-notify, portal-background)
  spawnForHuman @0 (spec :W.SpawnSpec, human :Text, initialLabel :C.Label) -> (process :W.Process);
      #! new top-level session under the human's current shell session; label starts at max(default, initialLabel)
}

interface TrustedSpawn {               # facet trusted-terminal (atrium-term only)
  spawnTerminal @0 (spec :W.SpawnSpec, pty :C.Fd) -> (process :W.Process);
      #! actorKind MUST be shell; warden withholds SECBIT_EXEC_DENY_INTERACTIVE for exactly this process tree (§9.3)
}

interface DebugAttach {                # facet broker (materialises Right.debug, §9.3)
  attach @0 (target :Text, scope :Text, debugger :C.Ref, entrypoint :Text, argv :List(Text),
             pty :C.Fd, expiresSecs :UInt32, grantId :Text, requester :C.PrincipalId) -> (process :W.Process);
      #! target "session:s-…" | "gen:fsv256:…"; scope "process" | "kernel"; expiresSecs ≤ 3600 (process), ≤ 900 (kernel);
      #! debugger MUST be a launchable generation whose manifest name is in the policy list debug.debuggers;
      #! warden spawns it as a child of requester's shell session (the human the grant was minted to) with seccomp profile
      #! debug-1 and the ambient capabilities of §9.3, writes kl_debug_pairs, and on expiry or exit removes the pair,
      #! kills the debugger and writes debug.detach
}

struct PodMount {
  tree       @0 :C.Fd;
  target     @1 :Text;
  readOnly   @2 :Bool;
  tmpfsBytes @3 :UInt64;   # 0: bind tree at target; > 0: warden creates a tmpfs of that size at target and copies tree into it
                           #  (configMap, secret, projected and downwardAPI volumes, §21.6)
}

struct PodContext {
  podId        @0 :Text;               # pod-… (§3.5)
  namespace    @1 :Text;
  name         @2 :Text;
  uid          @3 :Text;               # Kubernetes pod UID (metadata)
  netns        @4 :C.Fd;               # pod network namespace created by cri inside the cri network
  sharePid     @5 :Bool;               # shareProcessNamespace
  mounts       @6 :List(PodMount);     # volumes, prepared by cri (strata volumes, projected tmpfs)
  cgroupParent @7 :Text;               # under /keylos.slice/kube.slice/
  seccomp      @8 :Text;               # "baseline-1" | "runtime-default" (baseline-1 ∩ the CRI RuntimeDefault profile)
  readOnlyRoot @9 :Bool;
  runAsUid     @10 :UInt32;            # container-visible UID; mapped through a per-pod mapping-only userns held by warden (idmapped rootfs)
}

interface PodSpawn {                   # facet cri (keylos-sealed runtime class only, §21)
  spawnContainer @0 (spec :W.SpawnSpec, pod :PodContext) -> (process :W.Process);
      #! spec.generation MUST be kind container with an org-publisher genstmt; actorKind pod; tier t1;
      #! the container joins pod.netns and (if sharePid) the pod's pid namespace; no added capabilities, ever;
      #! the root is read-only plus tmpfs at /tmp, /run, /var/tmp and /dev/shm (§21.8)
  execInContainer @1 (spec :W.SpawnSpec, container :C.SessionId) -> (process :W.Process);
      #! CRI Exec/ExecSync: a child session of the container's principal that joins its mount, pid, net, ipc and uts
      #! namespaces and its cgroup; spec.generation MUST equal the container's generation; no added capabilities
  egressShim      @2 (podId :Text) -> (shim :Capability);
      #! a gate-sys ShimEndpoint (§7.5.12) bound to the pod's principals, created by warden as for tier L; cri runs the
      #! pod's egress redirector with it when cluster.egressViaGate is set (§21.5)
}

struct VmPrincipal {
  session       @0 :C.SessionId;
  parentSession @1 :C.SessionId;      # session the VM descends from (agent: the aide-created chain; pod: cri's session)
  principalKind @2 :W.SpawnSpec.ActorKind;   # bench, agent, legacy or pod
  image         @3 :C.Ref;            # bench-image generation
  template      @4 :C.Ref;            # agent-template generation for agent VMs, else empty
  tier          @5 :W.Tier;           # t2 or t3
  offered       @6 :List(C.Token);    #! tokens held by parentSession (e.g. the launching human's), to be attenuated for the VM
  purpose       @7 :Text;             # VmSpec.Purpose enumerant name
  podId         @8 :Text;             # purpose pod only
  checks        @9 :List(Text);       #! Datalog checks (§8.3) the broker appends when attenuating `offered` for this VM (sub-agents: aide narrows the parent's grants)
  budgets       @10 :List(B.Budget);  #! hard sub-meters carved from the offered roots (GateMeterAdmin.carve, §7.5.12) for this VM principal
  attempt       @11 :C.AttemptBinding; #! from VmSpec.attempt / ForkSpec.attempt; forwarded unchanged in SessionReg.attempt
}

interface VmSpawn {                    # facet bench
  register   @0 (vm :VmPrincipal) -> (principal :C.PrincipalId, cgroupId :UInt64, tokens :List(C.Token));
      #! creates the VM principal (dynamic UID, cgroup scope, BrokerSystem.registerSession); the actor follows §3.4
      #! (agent: "agent:" + template; pod: "pod:…"; otherwise "<kind>:" + image); tokens are those the broker issued
  spawnVmm   @1 (session :C.SessionId, spec :W.SpawnSpec) -> (process :W.Process);
      #! spawns crosvm, its device processes, bench-net and bench-relay inside the VM principal's cgroup;
      #! spec.generation MUST be the bench generation; warden wires bench-net to gate#shim and bench-relay to
      #! aide#host (agent VMs), broker#principal, vault#app and portal-*#default for that principal
  unregister @2 (session :C.SessionId) -> ();   # after the last VMM process of the principal exited
}
```

#### 2.3.15b protocols §7.3.16 `loom.capnp` (`AttemptHost` consumed through `LoomSystem.attempt`)

The durable workflow coordinator's public interface (served by `loom`, §20.25) and the attempt interface its activity workers use.

```capnp
@0xc7a1e5d3b2f40038;
using C = import "common.capnp";
using B = import "broker.capnp";

enum WorkflowStatus {             #! text forms (§20.25): running, waiting, paused, blocked-by-authority, outcome-unknown,
                                  #! completed, failed, cancelled, forgotten
  running @0; waiting @1; paused @2; blockedByAuthority @3; outcomeUnknown @4;
  completed @5; failed @6; cancelled @7; forgotten @8;
}

enum ResumePolicy { manual @0; automatic @1; }   #! automatic: loom resumes after restart and reboot without asking (§20.25)

struct DefinitionRef {
  generation @0 :C.Ref;           # generation whose manifest lists the definition in provides.workflows (§6.3)
  name       @1 :Text;            # /.keylos/workflows/<name>.json
  digest     @2 :C.Digest;        #! sha256 of the definition's JCS bytes (keylos.workflow/1, §20.27); a mismatch: kl:integrity
}

struct EnrollSpec {
  definition     @0 :DefinitionRef;
  input          @1 :C.Fd;                  # JCS input document (≤ 1 MiB), validated against the definition's input schema
  scope          @2 :List(B.GrantRequest);  # authority the workflow's attempts may receive, approved once at enrollment
  budgets        @3 :List(B.Budget);        # workflow-lifetime ceilings: one durable budget account (§20.25)
  resume         @4 :ResumePolicy;
  runWhileLocked @5 :Bool;                  #! keeps executing while the owner is locked; requires presence at enrollment
  horizonSecs    @6 :UInt64;                # lifetime bound; 0 = policy default; capped by policy
  reason         @7 :Text;                  # shown on the enrollment prompt
  idempotencyKey @8 :Text;                  # a repeated enroll by the same owner with the same key returns the same workflow
}

struct WorkflowInfo {
  id             @0 :Text;          # wf-…
  run            @1 :Text;          # wr-…
  definition     @2 :DefinitionRef;
  owner          @3 :Text;          # the owning human (_system for system workflows)
  status         @4 :WorkflowStatus;
  detail         @5 :Text;          # status detail code (§20.25), e.g. "decision:dr-…", "locked", "effect:fx-…"
  step           @6 :Text;          # current ws-…
  epoch          @7 :UInt64;        # current ownership epoch
  label          @8 :C.Label;       # accumulated workflow label
  resume         @9 :ResumePolicy;
  runWhileLocked @10 :Bool;
  created        @11 :C.Timestamp;
  updated        @12 :C.Timestamp;
  horizon        @13 :C.Timestamp;
  budget         @14 :Text;         # ba-…
  spent          @15 :List(B.Budget);
  remaining      @16 :List(B.Budget);
}

struct WorkflowEvent {
  seq      @0 :UInt64;              # per-workflow event number (the n of the workflow.* receipts, §20.25)
  time     @1 :C.Timestamp;
  workflow @2 :Text;
  union {
    status   @3 :WorkflowStatus;
    step     @4 :Text;              # ws-… entered
    attempt  @5 :C.AttemptBinding;  # a claim
    decision @6 :Text;              # dr-… requested or resolved
    effect   @7 :Text;              # JCS {"effect": "fx-…", "state": "<EffectState>"}
    label    @8 :C.Label;           # the workflow label rose
    note     @9 :Text;
  }
}

interface Workflow {
  info    @0 () -> (info :WorkflowInfo);
  history @1 (fromSeq :UInt64, limit :UInt32) -> (events :List(WorkflowEvent), next :UInt64);
  watch   @2 (watcher :C.Watcher(WorkflowEvent)) -> (cancel :C.Cancelable);
  pause   @3 (reason :Text) -> (info :WorkflowInfo);
  resume  @4 () -> (info :WorkflowInfo);             #! Cedar action resume (§16.1) evaluated for the caller
  cancel  @5 (reason :Text) -> (info :WorkflowInfo);
      #! durable: returns only after the broker's cancellation record, loom's tombstone and the workflow.cancel receipt (§20.25)
  forget  @6 () -> ();                                #! cancels first when needed, then crypto-shreds the history (§20.25)
  signal  @7 (name :Text, key :Text, payload :C.Fd) -> (seq :UInt64);
      #! external input, labelled with the caller's session label; deduplicated by (name, key); same key, other bytes: kl:conflict
  resolve @8 (effect :Text, outcome :Text, note :Text) -> (info :WorkflowInfo);
      #! owner resolution of an outcome-unknown effect: outcome "succeeded" | "failed" (§20.26); never re-dispatches the effect
  migrate @9 (to :DefinitionRef) -> (info :WorkflowInfo);
      #! explicit migration to a definition whose migrateFrom names the pinned one (§20.27); a new run; needs approval
}

interface Loom {
  enroll    @0 (spec :EnrollSpec) -> (workflow :Workflow, info :WorkflowInfo);
      #! the workflow is waiting ("decision:dr-…") until the broker's enrollment decision; it never runs before it
  workflows @1 (owner :Text, includeTerminal :Bool) -> (list :List(WorkflowInfo));
  open      @2 (id :Text) -> (workflow :Workflow);   #! kl:not-found for workflows the caller may not see
}

struct Observation {
  kind    @0 :Text;                 # "model" | "tool" | "clock" | "random" | "signal" | "other"
  key     @1 :Text;                 # deterministic position within the step, e.g. "model:3"; unique per step
  request @2 :C.Digest;             # sha256 of the request that produced it (absent for clock and random)
  body    @3 :C.Fd;                 # the observed bytes (≤ 64 MiB)
  label   @4 :C.Label;              # label of the observed data
}

interface AttemptHost {             # facet attempt (bound to the attempt session warden registered), and via LoomSystem.attempt
  task      @0 () -> (binding :C.AttemptBinding, activity :Text, input :C.Fd, label :C.Label, deadline :C.Timestamp);
  recorded  @1 (key :Text) -> (found :Bool, obs :Observation);
      #! replay: the observation an earlier attempt of the same step recorded under key
  record    @2 (obs :Observation) -> (seq :UInt64);
      #! durable before return; the workflow label rises to obs.label; same key with other bytes: kl:conflict
  effect    @3 (name :Text, requestDigest :C.Digest) -> (effect :Text);
      #! registers the step's named effect and returns its EffectId (§3.5), durable before return; same name with another
      #! request digest: kl:conflict
  complete  @4 (result :C.Fd, label :C.Label) -> ();   #! durable before return; ends the attempt
  fail      @5 (error :Text, retryable :Bool) -> ();
  heartbeat @6 () -> ();                               #! kl:conflict once a newer epoch is claimed; kl:revoked once cancelled
}
```

Every method of `AttemptHost` fails `kl:conflict` when the caller's attempt is not the workflow's current claim (a stale epoch), so a stale worker can neither record nor complete anything (§20.25).

#### 2.3.16 protocols §7.5.2 `broker-sys.capnp`

```capnp
@0xc7a1e5d3b2f40021;
using C = import "common.capnp";
using B = import "broker.capnp";
using P = import "prompt.capnp";

struct SessionReg {
  child    @0 :C.PrincipalId;
  parent   @1 :C.SessionId;        # empty for warden-originated system services
  offered  @2 :List(C.Token);
  onRevoke @3 :Text;               # "kill" | "freeze"
  budgets  @4 :List(B.Budget);     #! hard sub-budget ceilings for the child (VmPrincipal/ForkSpec budgets): the broker carves each from
                                   #! the matching offered root (GateMeterAdmin.carve) before issuing tokens; kl:budget if a parent meter is short
  attempt  @5 :C.AttemptBinding;   #! workflow attempt (§20.25): verified against the broker's workflow record (claimed epoch, attempt,
                                   #! allowed generation and spawner); the child's label and tokens then come from that record (§7.5.25)
}

struct SessionRegResult {
  tokens    @0 :List(C.Token);
  label     @1 :C.Label;
  tierFloor @2 :UInt8;             # 0..4 = t0..legacy
}

struct FlowCheck {
  session       @0 :C.SessionId;
  kind          @1 :Text;          # effect kind or "net"
  target        @2 :Text;
  payloadDigest @3 :C.Digest;
  rendered      @4 :List(P.RenderedEffect);
  provenance    @5 :List(P.ArgProvenance);
  flowProof     @6 :Data;          # optional DSSE keylos.flowproof/1 (§20.11)
  intent        @7 :Text;          # e-… id of the staged intent; empty for connect-time "net" checks
}

struct GrantResult {
  outcome @0 :B.GrantOutcome;
  mandate @1 :Data;                # DSSE keylos.mandate/1 when the outcome was decided by approval; empty otherwise.
                                   #! presence-signed when presence was required; otherwise signed by service/broker (§14.4)
}

struct PodAdmission {
  allowed   @0 :Bool;
  reasons   @1 :List(Text);        # forbid/permit policy ids and failed checks
  tierFloor @2 :UInt8;             # 1 = keylos-sealed allowed, 2 = keylos-vm required
  approval  @3 :Text;              # a-… when an @tier/@orgApproval permit applies (pods wait for it)
}

interface BrokerSystem {           # facet system
  registerSession    @0 (reg :SessionReg) -> (result :SessionRegResult);           # warden
  sessionEnded       @1 (session :C.SessionId, exitText :Text) -> ();              # warden
  checkFlow          @2 (check :FlowCheck) -> (result :GrantResult);               # gate: Rule of Two at stage/commit/connect
  requestFor         @3 (subject :C.SessionId, req :B.GrantRequest, intent :Text, idempotencyKey :Text,
                          intentSession :C.SessionId, decidedOnTrustedPath :Bool) -> (result :GrantResult);
      #! approval request on behalf of a subject session (intent = e-… id or empty). Allowed subjects per caller:
      #! gate → sessions that staged the intent (intentSession = the staging session when it differs from subject);
      #! aide → its agent sessions; strata, depot, vault, atrium → only their own session (atrium: device authorization).
      #! The broker deduplicates by (caller, idempotencyKey) for 24 h: a repeated call returns the same approval/result.
      #! decidedOnTrustedPath: atrium only (device authorization): the human already decided on atrium's trusted-path card;
      #! the broker evaluates policy, records approval.decide with channel "local" and returns the mandate without
      #! prompting again. MUST be false (else kl:invalid) for every other caller or when policy requires presence.
  registerApprover   @4 (publicKey :Data, alg :Text, channel :Text) -> ();         # atrium ("local") and vouchd ("phone"), once per boot
  registerSessionKey @5 (session :C.SessionId, publicKey :Data) -> ();             # aide: agent session key (flow proofs, commits)
  annotateRequest    @6 (session :C.SessionId, provenanceJson :Text) -> ();        # aide: provenance hints for the next request
  rootsChanged       @7 (fdkeys :List(Text)) -> ();                                # strata: re-open held roots after rollback
  revokeSession      @8 (session :C.SessionId, mode :Text) -> ();                  # hearth (lock/logout), warden
  loadPolicy         @9 (generation :C.Ref) -> ();                                 # config: activate a policy generation
  validatePolicy     @10 (tree :C.Fd) -> (ok :Bool, problems :List(Text));         # config: dry-run a candidate policy tree
  mintCaptive        @11 (session :C.SessionId) -> (token :C.Token);               # net: captive-portal token (§8.2 captive fact)
  admitPod           @12 (podSpecJson :Text, runtimeClass :Text) -> (admission :PodAdmission);
      #! cri: Cedar evaluation of action "admit" on a PodSpec entity (§16, §21.3); podSpecJson is the CRI PodSandboxConfig
      #! plus container configs, normalised by cri to keylos.podspec/1 (§21.3)
}

interface LabelAuthority {         # facet label-authority
  labelOf  @0 (session :C.SessionId) -> (label :C.Label);
  raiseFor @1 (session :C.SessionId, label :C.Label, reason :Text) -> (label :C.Label);   #! labels only go up; receipt label.raise
}
```

`registerApprover.publicKey` is a DER SubjectPublicKeyInfo; other encodings fail `kl:invalid`. A method whose receipt must be written before it replies (§19.3) answers `kl:unavailable` while the serving component's own `ledger.key.register` has not been appended; the broker registers its key before it serves facet `system`.

#### 2.3.17 protocols §7.5.10 `bench-sys.capnp` (`GrantDelegate` implemented by this repo)

```capnp
@0xc7a1e5d3b2f40029;
using C = import "common.capnp";

interface BenchMerge {             # facet merge (gate fs.merge executor, aide for manifest/render)
  manifest    @0 (session :C.SessionId, share :Text) -> (manifestJson :Text, digest :C.Digest, snapshot :Text, prepared :Text);
      #! freezes a snapshot of the share's overlay and prepares the merge through strata (TransactionExt.prepare);
      #! manifestJson is that prepared merge's keylos.fsmerge/2 (§20.12), prepared its pm-… id
  render      @1 (session :C.SessionId, share :Text, snapshot :Text) -> (diff :C.Fd);   # unified diff
  commitShare @2 (session :C.SessionId, share :Text, manifestDigest :C.Digest, mandate :Data) -> (transaction :Text, undoSnapshot :Text);
      #! commits the prepared merge whose manifest digest is manifestDigest (PreparedMerge.commit); later agent writes are never included
  commitPrepared @3 (prepared :Text, manifestDigest :C.Digest, mandate :Data, binding :C.AttemptBinding) -> (transaction :Text, undoSnapshot :Text);
      #! gate only: commits a retained prepared merge by its pm-… id, independent of the session that prepared it (a fresh attempt
      #! of the owning workflow, §20.25; strata StrataTxn.preparedFor); idempotent: a committed prepared merge returns its
      #! stored completion record (PreparedMerge.status) instead of committing again
  preparedStatus @4 (prepared :Text) -> (state :Text, transaction :Text, undoSnapshot :Text);
      #! gate, aide: the prepared merge's durable completion record (PreparedMerge.status), for reconciliation by effect id
}

interface GrantDelegate {          # served by aide (facet grant-delegate), called by bench for agent VMs
  request @0 (vmSession :C.SessionId, kind :Text, detailJson :Text, reason :Text) -> (outcomeJson :Text);
      #! outcomeJson (JCS): {"outcome": "granted" | "denied" | "pending", "token": "<base64 Biscuit>" | null,
      #!                     "approval": "a-…" | null, "reason": "…"}
}

struct MediaEntry { name @0 :Text; kind @1 :Text; size @2 :UInt64; modified @3 :C.Timestamp; }   # kind: file | dir | symlink

interface MediaBrowser {           # returned by Bench.media; held by portal-files and atrium
  list   @0 (path :Text) -> (entries :List(MediaEntry));
  open   @1 (path :Text) -> (source :C.ByteSource, size :UInt64);    #! bytes are labelled public/untrusted
  export @2 (path :Text, data :C.Fd, mandate :Data) -> ();
      #! copies data into the media VM, which writes it to the device; requires a media.export mandate bound to the
      #! SHA-256 of data (caller-executed effect, §14.2); bench writes the receipt media.export
  eject  @3 () -> ();                 # unmount in the guest, release the device, stop the VM
  exportSeekable @4 (path :Text, sizeLimit :UInt64) -> (fd :C.Fd, done :ExportCompletion);
      #! a writable, seekable memfd for applications that must seek while saving; nothing reaches the device until
      #! done.finish with a media.export mandate bound to the SHA-256 of the final contents
}

interface ExportCompletion {
  finish @0 (mandate :Data) -> ();   # seals the memfd, verifies the mandate against its digest, writes it to the device
  abort  @1 () -> ();
}

interface GuestPortals {           # served by bench-relay to a tier-2 guest over capwire-vsock (port 7004)
  notify    @0 (title :Text, body :Text, actions :List(Text)) -> (id :UInt32);
  openUri   @1 (uri :Text) -> ();
  print     @2 (document :C.ByteSource, mime :Text, optionsJson :Text) -> (jobId :Text);
  capture   @3 () -> (stream :C.ByteSource);                  # this VM's own display only, never the host session
  secret    @4 (name :Text, purpose :Text) -> (value :Data);  #! vault facet app scoped to the VM principal; the value
                                                             #! crosses into the guest, so policy MUST allow it per item
  powerbox  @5 (kind :Text, title :Text, mimeTypes :List(Text)) -> (shareName :Text);
      #! host-side picker; the chosen file or directory is hot-plugged as a share (Vm.attachShare)
}
```

#### 2.3.18 protocols §7.5.13 `aide-sys.capnp` (implemented by this repo)

```capnp
@0xc7a1e5d3b2f4002c;
using C = import "common.capnp";

struct AgentBootstrap {
  session      @0 :C.SessionId;
  principal    @1 :C.PrincipalId;
  templateJson @2 :Text;
  gitName      @3 :Text;
  gitEmail     @4 :Text;
  trailers     @5 :List(Text);
  env          @6 :List(C.KeyValue);   # proxy settings, KEYLOS_* (no secrets)
  localMcp     @7 :List(Text);         # JSON per local MCP server
}

interface AgentHostExt {           # obtained via Extensible.ext on the AgentHost connection (vsock 7002)
  bootstrap   @0 () -> (bootstrap :AgentBootstrap);
  modelStream @1 (requestJson :Text) -> (stream :C.ByteSource);
  heartbeat   @2 () -> ();
  desktop     @3 () -> (desktop :AgentDesktop);   #! only when the template sets vm.desktop: true; else kl:unsupported
}

interface VmExec {                 # used by WASI harnesses (camel/1) to run VM tools
  run @0 (argv :List(Text), stdin :Data, timeoutSecs :UInt32) -> (exit :Int32, stdout :Data, stderr :Data);
}

interface AgentDesktop {           # computer-use agents (§14.5); served by bench (Vm.desktop) to aide and by aide to the harness
  screenshot @0 () -> (png :Data, width :UInt32, height :UInt32);
  input      @1 (eventsJson :Text) -> ();
      # JCS list of {"type": "move"|"click"|"down"|"up"|"scroll"|"key"|"text", …}; delivered to the nested desktop only
  a11yTree   @2 () -> (json :Text);                         # A11yUpdate list of the nested desktop, as JSON
  launch     @3 (appName :Text) -> ();                      # start an app inside the agent desktop VM
  status     @4 () -> (watchedBy :List(Text), takenOver :Bool);   # takenOver: the human controls input; agent input is refused
}
```

#### 2.3.18a protocols §7.5.25 `loom-sys.capnp` (`AgentWorkflowHost` implemented by this repo)

The system contracts of durable execution (§20.25, §20.26): durable effects and workflow budget accounts (gate), workflow records, claims and durable decisions (broker), agent attempts (aide) and attempt observations (loom).

```capnp
@0xc7a1e5d3b2f40039;
using C = import "common.capnp";
using B = import "broker.capnp";
using G = import "gate.capnp";
using P = import "prompt.capnp";
using L = import "loom.capnp";

enum RetryStrategy { transactional @0; downstreamIdempotency @1; reconciliation @2; noSafeRetry @3; }   #! §20.26

enum EffectState {                #! §20.26: authorized is not completion; only succeeded/failed are confirmed outcomes
  prepared @0; awaitingApproval @1; authorized @2; dispatching @3;
  succeeded @4; failed @5; outcomeUnknown @6; cancelled @7; compensated @8;
}

struct EffectSpec {
  effect  @0 :Text;                # fx-… from AttemptHost.effect
  binding @1 :C.AttemptBinding;    # the preparing attempt; MUST match the token's workflow fact (§8.2)
  intent  @2 :G.EffectIntent;      # kind, class, target, args, payload; idempotencyKey MUST be empty (the effect id is the key)
}

struct EffectRecord {
  effect        @0 :Text;            # fx-…
  workflow      @1 :Text;            # wf-…: the owner of the effect (never a session)
  state         @2 :EffectState;
  strategy      @3 :RetryStrategy;   #! declared by the executor, fixed at prepare (§20.26)
  kind          @4 :Text;
  target        @5 :Text;
  requestDigest @6 :C.Digest;        #! §20.26; a later prepare with the same effect id and another digest: kl:conflict
  payloadDigest @7 :C.Digest;
  decision      @8 :Text;            # dr-… when an approval was required
  intent        @9 :Text;            # e-… of gate's outbox intent
  epoch         @10 :UInt64;         # ownership epoch that last authorized or dispatched it
  dispatched    @11 :C.Timestamp;
  dedupUntil    @12 :C.Timestamp;    # end of the destination's deduplication window (downstreamIdempotency); 0 otherwise
  outcome       @13 :Text;           # JCS: executor result (succeeded, failed) or the reason (outcomeUnknown)
  receipts      @14 :List(Text);     # rcpt refs of the authorization and completion receipts
  retainUntil   @15 :C.Timestamp;    #! the dedup record is kept at least until then (§20.26)
}

interface DurableEffects {         # gate; facets client and aide: prepare, complete, lookup, watch; facet loom: all except prepare
  prepare   @0 (spec :EffectSpec, token :C.Token) -> (record :EffectRecord);
      #! stages the effect for its workflow (the token's principal is the attempt session); durable before return; idempotent
      #! per effect id with an equal request digest; a stale epoch: kl:conflict
  commit    @1 (effect :Text, binding :C.AttemptBinding) -> (record :EffectRecord);
      #! facet loom: authorizes with BrokerWorkflow.authorizeEffect (current policy, durable decision) and dispatches per strategy;
      #! returns the record when it is awaitingApproval, has a confirmed outcome, or is outcomeUnknown
  complete  @2 (effect :Text, receipt :Text) -> (record :EffectRecord);
      #! caller-executed kinds (§14.2): the executor's completion receipt (rcpt ref) is the authenticated outcome
  lookup    @3 (effect :Text) -> (record :EffectRecord);      #! durable lookup by effect id (facet client/aide: own workflow only)
  watch     @4 (effect :Text, watcher :C.Watcher(EffectRecord)) -> (cancel :C.Cancelable);
  cancel    @5 (effect :Text, reason :Text) -> (record :EffectRecord);
      #! prepared or awaitingApproval → cancelled; from authorized on it cannot be cancelled (record returned unchanged)
  reconcile @6 (effect :Text) -> (record :EffectRecord);      # run the executor's reconciliation now (strategy reconciliation)
  resolve   @7 (effect :Text, outcome :Text, mandate :Data) -> (record :EffectRecord);
      #! outcomeUnknown → succeeded | failed on the owner's decision (mandate kind workflow.decide bound to the record, §14.4)
  forget    @8 (workflow :Text) -> ();
      #! forgotten workflow: shreds its payloads (unit gate:<owner>:<wf-id>); keeps the minimal dedup records (§20.26)
}

struct BudgetEntry { key @0 :Text; state @1 :Text; amount @2 :List(B.Budget); }   # state "reserved" | "settled" | "released" | "unresolved"

interface WorkflowBudget {         # gate; facet broker: open, close, status; facet loom and facet aide: reserve, settle, release, status
  open    @0 (account :Text, workflow :Text, ceilings :List(B.Budget)) -> ();   #! idempotent; same account, other ceilings: kl:conflict
  reserve @1 (account :Text, key :Text, amount :List(B.Budget)) -> (entry :BudgetEntry);
      #! idempotent per (account, key); kl:budget when spent + reserved + unresolved + amount exceeds a ceiling
  settle  @2 (account :Text, key :Text, actual :List(B.Budget), outcome :Text) -> (entry :BudgetEntry);
      #! once per key: replaces the reservation by actual; outcome "unknown" keeps it as unresolved (still counted); a repeat with
      #! equal values returns the entry, with other values kl:conflict
  release @3 (account :Text, key :Text) -> (entry :BudgetEntry);   # drops an unsettled reservation; idempotent
  status  @4 (account :Text) -> (ceilings :List(B.Budget), reserved :List(B.Budget), spent :List(B.Budget), unresolved :List(B.Budget));
  close   @5 (account :Text) -> ();   # terminal workflow: no further reservations; spent amounts stay recorded
}

struct EnrollRequest {
  workflow       @0 :Text;            # wf-…
  definition     @1 :L.DefinitionRef;
  inputDigest    @2 :C.Digest;
  scope          @3 :List(B.GrantRequest);
  budgets        @4 :List(B.Budget);
  resume         @5 :L.ResumePolicy;
  runWhileLocked @6 :Bool;
  horizonSecs    @7 :UInt64;
  reason         @8 :Text;
  account        @9 :Text;            # ba-… the broker opens with WorkflowBudget.open when the enrollment is approved
}

struct DecisionRecord {
  id       @0 :Text;                  # dr-…
  workflow @1 :Text;
  key      @2 :Text;                  # logical operation, e.g. "enroll", "effect:fx-…", "grant:<name>", "decide:<ws-…>"
  digest   @3 :C.Digest;              #! sha256 of the JCS {workflow, key, requests, effects}: never a session or attempt (§20.25)
  state    @4 :Text;                  # "pending" | "approved" | "denied" | "expired" | "cancelled"
  approval @5 :Text;                  # boot-local a-… of the prompt currently shown; empty when none
  mandate  @6 :Data;                  # the delivered mandate (§14.4) when approved
  expires  @7 :C.Timestamp;           #! fixed when decided; never extended by a rebind or a later attempt
}

struct DecisionEffect { kind @0 :Text; target @1 :Text; digest @2 :C.Digest; rendered @3 :List(P.RenderedEffect); }

struct WorkflowRecordInfo {
  workflow       @0 :Text;
  owner          @1 :Text;
  state          @2 :Text;            # "enrolling" | "active" | "cancelled" | "forgotten"
  epoch          @3 :UInt64;          # highest claimed ownership epoch
  attempt        @4 :Text;            # wa-… of that claim
  label          @5 :C.Label;         # workflow label high-water mark
  horizon        @6 :C.Timestamp;
  account        @7 :Text;            # ba-…
  resume         @8 :L.ResumePolicy;
  runWhileLocked @9 :Bool;
  definition     @10 :L.DefinitionRef;
}

interface BrokerWorkflow {         # broker, facet workflow (holders per §19.2)
  enroll   @0 (subject :C.SessionId, req :EnrollRequest) -> (decision :DecisionRecord);
      #! loom: Cedar action enroll for the subject (the owner's session) plus every scope item as a persistent request (§20.25)
  claim    @1 (binding :C.AttemptBinding, generation :C.Ref, spawner :C.SessionId) -> (record :WorkflowRecordInfo);
      #! loom: binding.epoch MUST be record.epoch + 1 (else kl:conflict); persisted before return; revokes every root of
      #! earlier attempts; generation and spawner are the only ones allowed to register this attempt (SessionReg.attempt)
  verify   @2 (binding :C.AttemptBinding, session :C.SessionId) -> (record :WorkflowRecordInfo);
      #! gate, strata, bench, aide: binding is the current claim and session belongs to it; else kl:conflict (stale) or kl:revoked
  decide   @3 (binding :C.AttemptBinding, key :Text, requests :List(B.GrantRequest), effects :List(DecisionEffect)) -> (decision :DecisionRecord);
      #! durable logical request: deduplicated by (workflow, key) and the digest, never by session; persisted before any prompt
  rebind   @4 (decision :Text, binding :C.AttemptBinding, session :C.SessionId) -> (result :B.GrantOutcome);
      #! explicit use of an approved decision by a fresh attempt: revalidated against current policy, revocation and expiry;
      #! grants are minted for session; never extends expiry or presence
  authorizeEffect @5 (binding :C.AttemptBinding, effect :Text, kind :Text, target :Text, payloadDigest :C.Digest,
                      rendered :List(P.RenderedEffect)) -> (decision :DecisionRecord);
      #! gate: current authority for one workflow effect (record, policy, Rule of Two with the workflow label, epoch); approved
      #! immediately (no prompt, empty mandate) or through a durable decision with key "effect:<fx-…>"
  offer    @6 (binding :C.AttemptBinding) -> (tokens :List(C.Token));
      #! aide: path and net tokens of the workflow scope bound to aide's own session, expiring after 120 s, for building the
      #! shares and offered tokens of the attempt's VM (§20.25)
  resume   @7 (subject :C.SessionId, workflow :Text) -> (decision :DecisionRecord);   # loom: Cedar action resume for the subject
  cancel   @8 (subject :C.SessionId, workflow :Text, reason :Text, forget :Bool) -> (record :WorkflowRecordInfo);
      #! loom (subject = the cancelling session, Cedar action cancel; empty subject for loom's own forget of a deleted user's
      #! workflows, §20.25): durable cancellation and
      #! revocation record, persisted before return; revokes every root of the workflow; refuses every later claim
  record   @9 (workflow :Text) -> (record :WorkflowRecordInfo);   # loom, gate, strata
  raise    @10 (workflow :Text, label :C.Label, reason :Text) -> (label :C.Label);
      #! loom: raises the workflow label high-water mark (labels only go up), persisted before return
  cancelDecision @11 (decision :Text, reason :Text) -> (decision :DecisionRecord);
      #! loom, gate: withdraws one pending durable decision (its prompt is closed); idempotent; a decided one is returned unchanged
}

interface AgentWorkflowHost {      # aide, facet loom
  startAttempt @0 (binding :C.AttemptBinding, template :C.Ref, task :Text, input :C.Fd, label :C.Label) -> (session :C.SessionId);
      #! starts an agent session as the attempt (VmSpec.attempt); the harness reaches loom only through aide
  stopAttempt  @1 (binding :C.AttemptBinding, mode :Text) -> ();   # mode "cancel" | "fence" | "pause"
  status       @2 (binding :C.AttemptBinding) -> (json :Text);
}

interface LoomSystem {             # loom, facet aide
  attempt         @0 (binding :C.AttemptBinding, session :C.SessionId) -> (host :L.AttemptHost);
      #! the AttemptHost of an agent attempt aide started; aide records every model and host-tool observation through it
  ended           @1 (binding :C.AttemptBinding, reason :Text) -> ();
      #! the attempt ended without complete/fail: "crashed" | "paused" | "breaker" | "deadline" | "vm-lost"; never a cancellation
  cancelRequested @2 (binding :C.AttemptBinding, subject :C.SessionId, reason :Text) -> ();
      #! the human stopped the attached agent session (AgentSession.stop): loom treats it as Workflow.cancel by subject
}
```

#### 2.3.19 protocols §8 Capability tokens

**8.1 Format**

Tokens are **Biscuit v3** tokens:
- Ed25519 root key; the broker holds the root keys.
- Datalog blocks; attenuation is offline and append-only.

There is one root keypair per boot per machine, rotated at reboot. **Persistent grants** are stored by the broker as **grant records** (broker-local format `keylos.grant/1`) and re-minted on each boot. Tokens never outlive a boot.

**8.2 Authority block vocabulary**

The broker MUST write the authority block using only these facts. Other components MUST understand all of them.

| Fact | Meaning |
|---|---|
| `principal($p)` | Holder principal text |
| `session($s)` | Holder session |
| `root_id($r)` | Root ID (bytes) |
| `right($kind, $resource, $op)` | Resource text by kind: `path` — `<rel>`, a normalised relative path (no leading `/`, no `.`/`..`, no trailing `/`, `""` = the whole root) naming a subtree matched on component boundaries, under the root named by the token's `path_root` fact; `net` — the host (or `listen:<addr>`), with the `net(...)` facts for that host carrying port, proto and method (a net right without a `net` fact for its host is invalid; a grant with only specific methods does not authorise a protocol-level connect, `"*"` does); `delegate` — `"*"`. `$kind` ∈ {"path", "net", "device", "secret", "budget", "spawn", "service", "effect", "delegate", "principal", "screen", "model"}; `$op` is a `Right` enumerant name. Kind `principal` (resource `session:s-…` or `gen:fsv256:…`) carries only `debug`; kind `screen` (resource `window:<id>`) only `read`, single use; kind `model` (resource `<provider>/<model>@<version>`) only `use` |
| `debug_scope($scope)` | `"process"` or `"kernel"` for a `debug` right; absent means `process` |
| `path_root($fdkey)` | Declares a broker-held root dirfd `$fdkey`; a path right applies under every `path_root` of the authority block. The broker mints at most one `path_root` per token |
| `net($host, $port, $proto, $method)` | `$method` is "*" for no HTTP restriction; `$host` "listen:<addr>" for listening grants |
| `budget($unit, $amount)` | Ceiling per charge in the authorizer (`amount ≤ ceiling`); cumulative spending is tracked by `gate` keyed by root_id |
| `expires($time)` | |
| `tier_floor($n)` | Minimum confinement tier for any process using this token |
| `max_depth($n)` | Maximum **absolute** delegation depth (the root holder is depth 0) |
| `max_fanout($n)` | Maximum number of child sessions |
| `label_ceiling($conf)` | Highest confidentiality the holder may read under this token: bounds both the session label and, when supplied, the object label |
| `persist($grantId)` | Token re-minted from persistent grant `$grantId` |
| `captive($bool)` | Captive-portal token: valid only for the captive-browser VM while `net` reports a captive network (minted by `BrokerSystem.mintCaptive`, ≤ 10 min, `tier_floor` ≥ 2) |
| `model($provider, $model, $version)` | A model identity approved for an agent session (§14.5); the authority block may list several (the approved set). An observed model must match a `model` fact of every block that has one; `gate` compares observed model versions against them |
| `budget_parent($rootId)` | The token's budget is a hard sub-meter of `$rootId` (`GateMeterAdmin.carve`) |
| `workflow($wf, $epoch)` | The token was minted for an attempt of workflow `$wf` (`wf-…`) at ownership epoch `$epoch` (§20.25). Verifiers that act for workflows (`gate` `DurableEffects`) MUST compare `$epoch` with the binding they are given and with the current claim; the fact never authorizes anything by itself |
| `budget_account($ba)` | Spending under this token is charged to the durable workflow budget account `$ba` (`ba-…`, `WorkflowBudget`, §7.5.25) in addition to the root meter, so a fresh attempt's new root never resets spent amounts |

**Fact multiplicity.** The authority block has exactly one `principal`, `session` and `root_id`, and at most one each of `expires`, `tier_floor`, `max_depth`, `max_fanout`, `label_ceiling`, `persist`, `captive`, `debug_scope` (per right), `budget_parent`, `workflow` and `budget_account`; `model` may occur several times. `persist`, `workflow` and `budget_account` are trusted only in the authority block.

**8.3 Attenuation checks**

Attenuation blocks MAY contain any Datalog check over the authorizer's ambient facts. Delegation helpers MAY also append limit facts (`expires`, `max_depth`, `max_fanout`, `label_ceiling`, `tier_floor`, `budget_parent`, `model`, `debug_scope`, `captive`) to attenuation blocks; Biscuit scoping hides them from other blocks, so the authorizer MUST read every block's limit facts and enforce the **most restrictive** value across blocks (minimum for limits, maximum for floors, any-true for restrictions). Limits can therefore only narrow. `expires` is inclusive (`time ≤ expires`), with one-second resolution.

| Ambient fact | Meaning |
|---|---|
| `time($t)` | Now (trusted time, §3.6) |
| `operation($kind, $op)` | Requested operation |
| `resource($kind, $resource)` | Requested resource |
| `path_under($root, $rel)` | Path relation |
| `host($h)`, `port($p)`, `method($m)` | Network attributes |
| `depth($n)` | Current delegation depth |
| `session_label($conf, $integ)` | Current session label |
| `principal_kind($k)` | Actor kind |
| `amount($unit, $n)` | Amount being spent |
| `offline_days($n)` | Days since the last fresh revocation list (§14.5) |
| `proto($p)` | Requested network protocol (`tcp`, `udp`, `https`) |
| `object_label($conf, $integ)` | Label of the object being read (enforces `label_ceiling`) |
| `requested_debug_scope($s)` | Scope of a requested `debug` operation (enforces `debug_scope`) |
| `process_tier($n)` | Confinement tier of the process that will use the materialised resource (enforces `tier_floor`; legacy counts as 1, t2 as 2, t3 as 3) |
| `captive_network($b)` | Whether `net` currently reports a captive network (enforces `captive`) |

Examples:

```
check if time($t), $t <= 2026-10-07T21:30:00Z;
check if operation("path", $op), ["read"].contains($op);
check if resource("net", $r), host($h), ["api.github.com"].contains($h), method($m), ["GET","HEAD"].contains($m);
check if depth($d), $d <= 1;
```

**8.4 Revocation**

- Revoking a root ID invalidates every token derived from it, including tokens whose `budget_parent` names it. Revocations are in-memory and persisted until the next reboot, when keys rotate anyway.
- **Workflow revocation is durable.** Cancelling or revoking a workflow (`BrokerWorkflow.cancel`, §20.25) writes a persistent cancellation record in the broker, revokes every root carrying that workflow's `workflow` fact, and makes every later claim and attempt registration of the workflow fail, across restarts and reboots; it is not undone by the per-boot key rotation.
- The broker MUST check revocation on every `materialize`, and `gate` on every `connect`, `stage` and `charge`.
- **Already-materialized fds cannot be pulled back from a process.** Revoking therefore also terminates or freezes holders through `PrincipalControl.terminate` (§7.5.1), according to the grant record's `onRevoke`: `kill` (default for agents) or `freeze` (default for apps; the user decides). Attached grant mounts are detached (`GrantMounts.detachGrant`).

#### 2.3.20 protocols §10.5 Environment conventions

Processes receive:
- `KEYLOS_PRINCIPAL` (text)
- `KEYLOS_SESSION`
- `KEYLOS_TIER`
- `KEYLOS_CAPWIRE_FDS`: a comma list of `name=fdnum` for passed service sockets, for example `broker=3,portal-files=4`. Names follow the route-name rule below.
- `KEYLOS_ARGFD_<argname>` and `KEYLOS_PIPE_IN` / `KEYLOS_PIPE_OUT` (§12)
- `KEYLOS_TXN`: the strata transaction ID when spawned with `SpawnSpec.transaction`
- `KEYLOS_AGENT_HOST`: `vsock:2:7002` inside agent workbenches
- `KEYLOS_GUEST_PORTALS`: `vsock:2:7004` inside tier-2 guests
- `KEYLOS_BPF_FDS`: `name=fdnum` list of BPF map fds `warden` loaded for a tier-0 service (§9.3)
- `KEYLOS_TPM_FD`: for services whose `services.json` entry has `privileges.tpm: true`, the number of an inherited fd of `/dev/tpmrm0` that `warden` opened for the service; services use it as their TPM (for example TCTI `device:/proc/self/fd/<n>`) and never open TPM devices by path
- XDG variables, with paths per §10.1

In tier-0 services fd 3 is the `warden` bootstrap socket (`Bootstrap`, §7.5.1) and is not listed in `KEYLOS_CAPWIRE_FDS`.

**Route names in `KEYLOS_CAPWIRE_FDS`:**

| Route | Name |
|---|---|
| `<svc>#client`, `<svc>#default` | `<svc>` |
| `broker#principal` | `broker` |
| `warden#client`, `warden#service` | `warden` |
| any other `<svc>#<facet>` | `<svc>#<facet>` |

**Adopting inherited descriptors.** Programs take ownership of fd 3 and of the descriptors named in `KEYLOS_CAPWIRE_FDS`, `KEYLOS_BPF_FDS` and `KEYLOS_TPM_FD` exactly once at start-up through the `keylos-capwire` inheritance helper (§18), which checks that each fd is open and sets `FD_CLOEXEC`; programs need no `unsafe` code of their own for it.

**Development knobs.** Names starting with `KEYLOS_DEV_` are reserved for development-only settings, for example `KEYLOS_DEV_TPM_TCTI` (a TPM TCTI string such as `swtpm:host=127.0.0.1,port=2321`, which replaces `KEYLOS_TPM_FD`). Production builds never read them, and `warden` never sets them; only the development supervisor of a development image may. Every other development knob of a keylos component uses this prefix. The registered knobs are:

| Knob | Read by | Effect (development builds only) |
|---|---|---|
| `KEYLOS_DEV_TPM_TCTI` | every TPM-using service (vault, hearth, ledger, broker, strata, courier, config) | TPM TCTI string that replaces `KEYLOS_TPM_FD` |
| `KEYLOS_DEV_LEDGER_SELF_PROVISION` | ledger | `1`: on a fresh store with the counter `0x01300100` absent, define it itself (`x-devProvision`) instead of waiting for `HearthTpm.defineSpace`; never after hearth genesis |
| `KEYLOS_DEV_LEDGER_SAMPLE_EXPORT` | ledger (tests) | Directory for sample exports written by the privacy test harness |
| `KEYLOS_DEV_HEARTH_SOFT_AUTHENTICATOR` | hearth | Use a software FIDO2 authenticator instead of a CTAP2 device |
| `KEYLOS_DEV_BROKER_IMPLICIT_SESSIONS` | broker | `1`: register an unregistered `broker#principal` peer implicitly instead of failing `kl:denied` |
| `KEYLOS_DEV_BROKER_POLICY_DIR` | broker | Directory that replaces the warden-mounted `/policy` generation |
| `KEYLOS_DEV_BROKER_GENERATION` | broker | Generation ref used for the broker's own principal when `ServiceHost.accept` and `policy.ref` give none |
| `KEYLOS_DEV_TIME_TRUSTED` | broker, loom | `1`: treat the system clock as trusted without a `NetWatch` `timeTrusted` event |
| `KEYLOS_DEV_WATCHDOG_SECS` | broker and every other daemon with a `watchdogSecs` of its own (it reads the knob itself; the `warden-svc` host reads none) | Watchdog interval that replaces the manifest's `watchdogSecs` |
| `KEYLOS_DEV_LOOM_FAULTS` | loom | Comma list of fault-injection points (`crash:<point>`, `fsync-fail:<point>`, `enospc:<point>`, points named in the loom spec) for the durability acceptance tests |
| `KEYLOS_DEV_LOOM_CLOCK_SKEW_SECS` | loom | Signed offset added to loom's view of trusted time, for timer, expiry and long-downtime tests |

A knob that is not listed here MUST NOT be read by any component; a new knob is registered here before use.

No secrets, ever. Names starting with `KEYLOS_` are reserved; `SpawnSpec.env` MUST NOT set them, with one exception: a `shell` principal MAY set `KEYLOS_ARGFD_*`, `KEYLOS_PIPE_IN` and `KEYLOS_PIPE_OUT` (§12); `warden` verifies that every fd named in `KEYLOS_ARGFD_*` is present in `SpawnSpec.fds`.

#### 2.3.21 protocols §12 Command signatures

Every native command ships `/.keylos/cmdsig/<name>.json`. `kish`, `aide` (tool definitions) and the SDK consume them.

```json
{
  "schema": "keylos.cmdsig/1",
  "name": "ls",
  "summary": "List directory entries",
  "args": [{"name": "dirs", "type": "dir", "access": "read", "variadic": true, "default": "."}],
  "flags": [{"name": "all", "short": "a", "type": "bool", "summary": "Include hidden entries"}],
  "input": {"type": "none"},
  "output": {"type": "records", "schema": {"name": "text", "size": "int", "kind": "text", "modified": "time"}},
  "effects": [],
  "net": [],
  "exit": {"0": "ok", "1": "partial", "2": "error"}
}
```

**Types:**

| Category | Values |
|---|---|
| Scalars | `bool`, `int`, `float`, `text`, `bytes`, `time`, `duration`, `size` |
| Filesystem | `path` (no access), `file`, `dir` (both with `access`: `read` / `write` / `create` / `readwrite`) |
| Network | `host`, `url` |
| Composite | `list<T>`, `record{...}`, `enum[...]`, `secret-ref` |

The shell opens `file` and `dir` arguments according to `access` and passes them as fds (§12.1).

**12.1 Argument fd passing**

For each `file` or `dir` argument, the shell passes an fd and replaces the argument text with `/dev/fd/<n>`. It also sets `KEYLOS_ARGFD_<argname>=<n>[,<n>…]`.

Native programs SHOULD use the fd environment variables. Legacy programs simply open `/dev/fd/<n>`.

**12.2 Pipe protocol**

Pipes negotiate their format **statically**: the shell knows both ends' signatures.
- If the producer's `output.type` is `records` and the consumer's `input.type` is `records` (or `any`), the shell sets `KEYLOS_PIPE_OUT=cbor-seq` on the producer and `KEYLOS_PIPE_IN=cbor-seq` on the consumer.
- In that mode, records are an RFC 8742 CBOR sequence of maps that conform to the declared schema.
- In every other case the pipe carries bytes, and records are rendered as text by the producer's text formatter (TSV for `records` unless `--format` is given).

#### 2.3.22 protocols §13.1 Receipt payload

```json
{
  "schema": "keylos.receipt/1",
  "seq": 1042,
  "prev": "rcpt:sha256:…",
  "time": "2026-10-07T21:30:00.123456789Z",
  "writer": "service:broker:gen:fsv256:…@_system/s-…",
  "subject": "agent:gen:fsv256:…@alice/s-…",
  "event": "grant.issue",
  "data": {"rootId": "t-…", "rights": ["path:/home/alice/src/proj:read"], "expires": "…"},
  "label": {"conf": "private", "integ": "untrusted"},
  "approval": null
}
```

Rules:
- `seq` and `prev` are assigned by `ledger`. The writer signs the payload with `seq: 0` and `prev: null` (the **submitted form**); `ledger` fills them in, countersigns the final payload, and stores both signatures with the submitted form's digest. Verifiers reconstruct the submitted form (set `seq` to 0 and `prev` to null) to verify the writer's signature, and verify `service/ledger`'s signature over the final payload.
- **Signatures.** The stored envelope carries exactly two signatures, in this order: the writer's (over the PAE of the submitted form), then `service/ledger`'s (over the PAE of the final payload). They are told apart by `keyid`; signature objects carry no other members (no `scope`).
- **Ledger-originated receipts** (events the ledger writes itself, such as its own `ledger.key.register`, `ledger.alarm`, `ledger.redact` and `ledger.shred`): `writer` is the ledger's own principal and so is `subject`, except for replays of spooled receipts (§20.22), which keep the original subject and are sealed exactly when §13.4 requires it (a person's subject); a receipt whose subject is the ledger is never sealed. The envelope carries exactly one signature, `service/ledger`'s over the final payload; there is no submitted-form signature. `subject` is never empty: a writer whose event has no natural subject names its own principal. The first receipt of an empty ledger, and of every ledger epoch after an alarm, is the ledger's own `ledger.key.register {service: "ledger", spki, keyRef}`, so readers obtain the machine key through `Ledger.serviceKey("ledger")`. Verifiers (`keylos-formats`) accept both forms.
- **Time order.** `time` is non-decreasing in `seq`. The ledger orders each group commit by (`time`, arrival) before assigning sequence numbers, and refuses a submission whose `time` is earlier than the current head's with `kl:invalid` and a message containing `re-sign`. The writer then rebuilds the submitted form with a fresh `time`, signs it again and resubmits (writer libraries do this, with bounded retries). A resubmission is a new submission; the ledger does not deduplicate, and logical deduplication is the writer's responsibility. The rule keeps every month unit, retention cut and `since`/`until` range a contiguous `seq` range, so a late receipt can never land in a month that was already shredded or expired.
- Event names are registered in §19.3.
- Receipts with personal payloads carry `sealed` instead of clear `data` and `label` (§13.4).

#### 2.3.23 protocols §14 Labels, effects and approval tiers

**14.1 Labels**

| Dimension | Values (lowest → highest) |
|---|---|
| Confidentiality | `public` (0) < `internal` (1) < `private` (2) < `secret` (3) |
| Integrity | `trusted` (0) < `user` (1) < `untrusted` (2). Higher means *less* trustworthy |

- **Objects:**
  - Files carry `security.bpf.keylos.label`. Files without one inherit the default for their location: home data `private/user`; downloads and web content `public/untrusted`; store objects `public/trusted`.
  - Sockets get a label per connection from `gate`: responses from hosts are `untrusted` unless the policy marks the host `user`.
- **Sessions:** each principal session has a label. On every broker-mediated read, `session.conf = max(session.conf, object.conf)` and `session.integ = max(session.integ, object.integ)`. Labels never decrease within a session.
- **Label authority:** services that hand data from one principal to another (gate, bench, portals, atrium, strata, aide, journal, warden) raise the receiver's label with `LabelAuthority.raiseFor` (§7.5.2) **before** handing the data over. `warden` reads live labels with `labelOf` for `ConnectionInfo.label`.
- **Removable media and discovery:** bytes from `MediaBrowser` and results from `Discovery.browse` are `public/untrusted`.
- **Rule of Two** (enforced by `broker` and `gate`): define three properties of a session:
  - **U** = `integ == untrusted`
  - **P** = `conf ≥ private`
  - **X** = holds or requests a capability with `Right.commit`, an `effect` resource, or egress to a host not marked `sink-safe`

  A session MUST NOT hold all three. Requesting the third turns into a **declassification** approval at tier T3, unless a policy-registered **flow proof** (§20.11) is accepted. A flow proof is accepted only from an `agent-template` whose manifest `agent.flowProof` is `"camel/1"` and whose harness runtime is in the policy's trusted list.
- **Directory grants** (ceilings). A directory exposed to a session through a grant has an **exposure label** *c*, and the label assumptions hold only if *c* bounds everything readable through the grant for its whole lifetime:
  - The receiver's session label is raised to *c* (`raiseFor`) **before** the directory is exposed, and the resulting policy decision (Rule of Two) is enforced at that point.
  - *c* is enforced by `warden` (§7.3.3, §9.3): objects labelled above *c*, or with a malformed label, are not readable through the grant, whenever they appeared. Unlabelled objects count at their location default.
  - The broker may choose *c* as the join of a **complete** assessment of the tree. A bounded or truncated walk never justifies anything lower than the location default; entries above *c* then stay unreadable through the grant and are reported as hidden.
  - Without enforcement (null ceiling) the exposure label is the lattice maximum `secret/untrusted`.
  - Writes, relabels and renames into the tree, retained handles and concurrent changes are covered because enforcement happens at every open and read through the grant, not at grant time. A retained fd loses read access as soon as its object's label rises above *c*.
  - Agent input SHOULD be an **immutable assessed view** (a transaction base snapshot or a bench share snapshot): its complete assessment is final, so its exposure label can be lower without losing workflows to the `secret` deny of agent policy.

**14.2 Effect kinds**

Registered kinds, with their default class:

| Kind | Class |
|---|---|
| `fs.merge` | compensable (undo snapshot; compensator `fs.undo`) |
| `git.push` | compensable for new branches; irreversible for force pushes, pushes to protected branches and any other push to an existing branch |
| `git.pr.open` | compensable |
| `email.send` | irreversible |
| `message.send` (chat) | irreversible |
| `http.post`, `http.put`, `http.patch` | irreversible unless the host policy registers a compensator |
| `http.delete` | irreversible |
| `payment.authorize` | irreversible (requires an AP2-style mandate in `data`) |
| `publish.package` | irreversible |
| `cloud.iam.change` | irreversible |
| `db.write.prod` | irreversible |
| `calendar.create` | compensable |
| `file.share` | compensable |
| `device.actuate` | irreversible |
| `net.listen` | compensable (close the port). Required for any port reachable from non-loopback addresses (scope `lan`/`any`); loopback-only listening needs no effect |
| `media.export` | compensable (delete the file on the device); counts as egress (property X) for the Rule of Two |
| `config.propose` | reversible (a proposal only; applying it is `config.apply`) |

Policy can register additional kinds (`x-…`), each optionally with an effect renderer component (§20.15). Classes can be raised, never lowered.

**Mandate-only kinds.** The broker records decisions that are not intents with these kinds in mandate `effects[]` (§14.4): `grant.<k>` for every resource kind *k* of §8.2 (`grant.path`, `grant.net`, `grant.device`, `grant.secret`, `grant.budget`, `grant.spawn`, `grant.service`, `grant.effect`, `grant.delegate`, `grant.principal`, `grant.screen`, `grant.model`), `grant.declassify`, `debug.attach`, `pod.admit`, and for durable workflows (§20.25) `workflow.enroll` (target `wf-…`, digest = SHA-256 of the JCS `EnrollRequest` JSON form `{"workflow", "definition": {"generation": <gen ref text>, "name", "digest": <digest text>}, "inputDigest": <digest text>, "scope": [<GrantRequest JSON forms>], "budgets": [{"unit", "amount"}], "resume": "manual" | "automatic", "runWhileLocked", "horizonSecs", "reason", "account"}`), `workflow.resume` (target `wf-…`) and `workflow.decide` (target the `ws-…` or `fx-…` the decision is about, digest = SHA-256 of the JCS question or resolution document). They are valid only in mandates, written only by `broker`, and never appear in manifests, command signatures, intents or `gate` intents.

**Required review details.** Approval of an effect requires that the trusted path presents at least these details of the exact payload (§7.3.4); a policy-registered kind's renderer declares its own, and a kind without a declaration requires the complete canonical payload:

| Kind | Required details |
|---|---|
| `email.send`, `message.send` | every recipient (to, cc, bcc), subject, complete body, attachment names, types and sizes |
| `http.*` | method, complete URL, request body (or its digest plus a complete canonical rendering for bodies over the channel limit) |
| `payment.authorize` | amount, currency, payee, mandate terms |
| `fs.merge` | the complete `keylos.fsmerge/2` manifest and the diff of every changed text file; binary changes by path, size and digest |
| `git.push`, `git.pr.open` | remote, refs (old → new), commits with titles; force flag |
| `publish.package`, `cloud.iam.change`, `db.write.prod`, `device.actuate` | target and the complete operation |
| `file.share`, `calendar.create`, `media.export`, `net.listen` | target (people, device or port and scope) and the object |
| `config.propose`, `config.apply` | the complete plan diff |
| `grant.*`, `debug.attach`, `pod.admit`, `grant.declassify` | resource, rights, duration, persistence, requesting principal and `onBehalfOf` |
| `workflow.enroll` | definition (name, version, generation, digest), every scope item as for `grant.*`, budget ceilings, resume policy (`automatic` stated as "runs again after restarts without asking"), `runWhileLocked`, horizon, the owner and the label the workflow starts with |
| `workflow.resume`, `workflow.decide` | workflow, definition, current step, the complete question or resolution document, and for `workflow.decide` on an effect the effect's own required details |

**Caller-executed effects.** For `media.export`, `device.actuate` and `config.propose`, `gate` stages, renders and decides the intent but does not perform it. A successful `Intent.commit` returns, in `IntentStatus.result`, the base64 delivered mandate (§14.4) bound to the payload digest, and `gate` writes `effect.commit` meaning "authorized". The executor (`bench` `MediaBrowser.export`/`ExportCompletion.finish`, the device's owning service, `config` for `propose`) MUST verify the mandate (owner-presence or `service/broker` signature, payload digest, expiry, single use) before acting, and writes its own completion receipt (`media.export` by `bench`). Stagers of `media.export` are `portal-files` and `atrium` on behalf of the requesting app. **Authorization is not completion**: an intent in `committed` state of a caller-executed kind, and an effect in `authorized` state (§20.26), say only that the effect may be performed; a workflow waits for the executor's authenticated completion (its receipt, `DurableEffects.complete`) before it treats the effect as done.

**14.3 Approval tiers**

| Tier | Covers | Interaction |
|---|---|---|
| T0 | Reads and overlay writes within grants | None, receipt only |
| T1 | Reversible egress to granted hosts | None; a classifier MAY escalate to T2/T3 |
| T2 | Compensable effects, new hosts, widening a sub-principal's scope | Batched review on the trusted path |
| T3 | Irreversible effects, declassification, budget overrun, merge of an agent overlay, config apply, seal, policy change | Synchronous trusted-path prompt with rendered effects and argument provenance. Presence (FIDO2 touch) is REQUIRED for config apply, seal, policy change, payment, persistent grants, and any effect whose policy says `presence` |

Rules:
- No automated component may lower a tier.
- A remote approval routed to a paired phone (`VouchLink.routeApproval`) or an org approval (`OrgDecider.decide`) MAY satisfy a T2/T3 approval only when the policy explicitly allows that channel for that effect kind, and **never** satisfies `requiresPresence`.
- **Channel selection.** The broker puts `"phone"` in `ApprovalPrompt.channels` only when the matching permit's `@channels` includes `phone` **and** a `vouchd` approver key is registered this boot (`registerApprover(…, "phone")`); `"org"` only for `@orgApproval` permits on fleet-enrolled machines. The mandate's `channel` records the channel that decided.
- **Family machines.** A non-owner human's request that needs an owner decision (config proposal, seal, persistent grant, policy change, install of an unreviewed app) becomes an approval prompt to the owners with `requester` set; it is shown on the next owner trusted-path session or routed to an owner's paired phone (never satisfying presence).
- **Quorum machines.** Wherever presence is required, a quorum presence envelope (§5.4) is required instead.
- **Headless machines without fleet.** On profiles without `atrium` that are not fleet-enrolled, every approval at T2 or above is escalated to a quorum presence request (`HearthQuorum.request`); there is no local trusted path. The resulting mandate has `channel: "quorum"`.
- **Guest sessions** never receive presence-class grants, agent sessions (unless `hearth.guest.agents` is true) or persistent grants.
- **Fail closed on rendering.** No channel may produce an approving decision for an effect whose required review details (§14.2) were not presented completely (§7.3.4). This holds for local prompts, presence cards, phone, org and quorum review alike; a channel that cannot present them leaves the approval pending for a capable channel, or it expires and is denied.
- **Org approver keys** come only from `/etc/keylos/fleet/approvers.json` (`keylos.fleetapprovers/1`, §20.23).
- **Durable decisions** (§20.25). An approval for a workflow is a durable decision record (`dr-…`) in the broker. Its prompt (`a-…`) is boot-local: a pending decision survives restarts and reboots and is presented again, with a new prompt ID, until it is decided or expires; `expires` is fixed when the decision is created (default 7 days, never beyond the workflow's horizon) and is never extended. Waiting never makes an earlier, incomplete rendering sufficient: each presentation needs the complete required material of that moment. A decided approval is used by a later attempt only through an explicit rebind (`BrokerWorkflow.rebind`), which re-checks current policy, revocation, expiry and presence; it never turns a historical approval into standing authority.

**14.4 Mandates (`keylos.mandate/1`)**

```json
{"schema":"keylos.mandate/1","approval":"a-…","principal":"…","tier":"t3",
 "effects":[{"kind":"email.send","target":"smtp:…","digest":"sha256:<payload digest>"}],
 "scope":"once","constraints":{"maxAmount":null,"expires":"…"},"decidedBy":"alice","presence":true,
 "channel":"local"}
```

- `channel`: `local` (atrium trusted path), `phone` (vouch), `org` (fleet approver), `quorum` (a quorum presence envelope, §5.4; `decidedBy` is `"quorum"`).
- `constraints.workflow` and `constraints.decision`: present exactly in mandates of durable decisions (§20.25): the `wf-…` the decision belongs to and its `dr-…`. A verifier acting for a workflow MUST require `constraints.workflow` to equal the effect's workflow; verifiers that do not know these members reject the mandate (unknown members, §5.1), so an older verifier fails closed.
- `constraints.channels`: the channels the broker allowed for this approval (§14.3, `ApprovalPrompt.channels`), a non-empty array of channel names without duplicates. The deciding `channel` MUST be one of them unless it is `quorum` (quorum presence replaces local presence on quorum machines).
- **Drafts.** `ApprovalPrompt.mandateDraft` is not a valid mandate: it carries placeholder `decidedBy` and `channel` values until the deciding channel fills them in and signs. Only a decided mandate is validated as `keylos.mandate/1`.
- **Extensions carry no authority.** `x-` members (§5.1) of a mandate are informational; no verifier may base an authorization decision on them.
- **Grant effects.** For a grant decision the broker writes one effect `{"kind": "grant.<k>", "target": <canonical resource string>, "digest": "sha256:" + SHA-256(JCS(R))}`, where R is the JSON form of the `GrantRequest`: `{"resource": {<union member>: v}, "rights": [Right enumerant names], "reason", "durationSecs", "persist", "onBehalfOf": <principal text or null>}`, with v = the text value for `path`, `device`, `secret`, `service`, `effect`, `screen`, `model` and `spawn`; `null` for `dirFd` and `delegate`; `{"host", "port", "proto", "methods"}` for `net`; `{"unit", "amount"}` for `budget`; `{"target", "scope"}` for `principal`. A service that asked for a confirmation through `requestFor` (vault: `grant.secret` with `{"secret": "<owner>/<name>"}`) verifies kind and digest.
- **Decision signatures** (inside the approval flow): presence-signed (§5.3) when `presence` is true; otherwise signed by the deciding channel's approver key: the atrium approver key or the `vouchd` phone key (both registered with `BrokerSystem.registerApprover`), or an `approver/<id>` key.
- **Mandates as delivered** (`Approval.mandate`, `GrantResult.mandate`): a presence-signed mandate is delivered as is; a non-presence mandate is re-signed by `service/broker` after the broker has verified the channel's decision signature. Relying services (gate, strata, bench, depot, devd) therefore verify only owner-presence keys (owner registry, via `HearthSystem.owners`) and the `service/broker` key (as registered with `ledger`, `Ledger.serviceKey`, §7.3.5); they never need approver keys.
- The `approval.decide` receipt carries `mandateDigest` (SHA-256 of the delivered mandate envelope).
- `gate` MUST NOT commit an irreversible intent without a mandate whose `effects[].digest` matches the intent payload digest.

**14.5 Operating rules**

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.

#### 2.3.24 protocols §19.2 Facets (aide and the routes aide holds)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| warden | `service` | tier-0 services | `Supervisor.spawn`, `identify`, `connectionInfo`; `FdStore`. `SpawnSpec.attempt` only from `loom` |
| broker | `principal` | every principal | `Broker` |
| broker | `system` | warden, gate, aide, atrium, config, hearth, strata, net, depot, vault, vouch, cri | `BrokerSystem` (per-method callers as commented in §7.5.2; `requestFor` with the allowed-subject rule, atrium only for its own session (device authorization); `registerApprover`: atrium, vouch; `admitPod`: cri; `mintCaptive`: net); `Broker.inspect` |
| broker | `label-authority` | gate, bench, portal-*, atrium, strata, aide, journal, warden | `LabelAuthority` |
| broker | `workflow` | loom, gate, aide, strata, bench | `BrokerWorkflow` (§7.5.25): `enroll`, `claim`, `decide`, `rebind`, `resume`, `cancel`, `cancelDecision`, `record`, `raise`: loom; `authorizeEffect`, `verify`, `record`, `cancelDecision`: gate; `offer`, `verify`, `decide`, `rebind`: aide (its agent attempts); `verify`, `record`: strata, bench |
| ledger | `writer` | tier-0 services listed as writers in §19.3 | `Ledger` (all) |
| ledger | `reader` | every principal | `Ledger` except `append` (filtered, §7.3.5) |
| vault | `aide` | aide | `store`/`delete`/`sign` of session keys; `dataKey`/`forget` for `aide:` units |
| gate | `meter` | aide, configured model clients | `charge`, `meter` |
| gate | `aide` | aide | `connect`, `stage` for agent sessions (§7.3.7), `intents`, `meter`; `DurableEffects.prepare`, `complete`, `lookup`, `watch` and `WorkflowBudget.reserve`, `settle`, `release`, `status` for agent attempt sessions |
| aide | `user` | human `shell`s, atrium | `Aide` (own human's sessions) |
| aide | `host` | one per agent VM (vsock 7002 forward by bench-relay) | `AgentHost`, `AgentHostExt` (incl. `desktop`), `VmExec` |
| aide | `admin` | owner `shell` | `Aide` (all humans, read), aide-local admin |
| aide | `grant-delegate` | bench | `GrantDelegate` |
| aide | `loom` | loom | `AgentWorkflowHost` (§7.5.25) |
| depot | `user` | `shell`, atrium, aide, portal-openuri, portal-discovery, gate, any principal granted `depot#user` | `get`, `list`, `install`, `verify`, `revocations`, `revocationStatus`, `openObject` (closures the caller may spawn), `openPath` (`/.keylos/…` only) |
| strata | `aide` | aide | `begin`; `StrataTxn` (including `preparedFor`); `TransactionExt.bindWorkflow` |
| config | `propose` | aide | `propose` (with origin), `current` |
| bench | `aide` | aide | all (including `fork` with `ForkSpec`, `reattach`); VMs get actor kind `agent` |
| bench | `merge` | gate, aide | `BenchMerge` (`commitShare`, `commitPrepared`: gate only; `preparedStatus`: gate, aide) |
| atrium | `notify` | tier-0 services, portal-notify | `TrustedPrompt.notify` |
| loom | `aide` | aide | `LoomSystem` (§7.5.25) for agent attempts aide started |

#### 2.3.25 protocols §19.3 Receipt events

| Event | Writer |
|---|---|
| `boot`, `shutdown`, `spawn`, `exit`, `debug.attach`, `debug.detach` | warden |
| `grant.issue`, `grant.attenuate`, `grant.delegate`, `grant.revoke`, `grant.deny`, `label.raise`, `approval.request`, `approval.decide` | broker |
| `effect.stage`, `effect.commit`, `effect.fail`, `effect.cancel`, `effect.compensate`, `effect.complete`, `effect.unknown`, `effect.resolve`, `net.connect` (sampled per policy), `net.listen`, `budget.charge`, `budget.exhausted`, `budget.carve`, `budget.open`, `budget.settle`, `budget.close` | gate (for caller-executed kinds, §14.2, and for every durable effect, `effect.commit` means "authorized"; `effect.complete` records a confirmed outcome and `effect.unknown` an unknown one, §20.26; the executor of a caller-executed kind writes its own completion receipt) |
| `secret.open`, `secret.store`, `secret.delete` | vault |
| `gen.install`, `gen.seal`, `gen.revoke`, `gen.gc` | depot |
| `update.stage`, `update.commit`, `update.rollback` | courier |
| `config.plan`, `config.apply`, `config.revert`, `config.activation-rollback` | config |
| `txn.begin`, `txn.commit`, `txn.abort`, `txn.undo`, `snapshot.create`, `snapshot.delete`, `unit.create`, `unit.forget`, `backup.run`, `backup.restore-test`, `anchor.rollback-detected` | strata |
| `agent.start`, `agent.stop`, `agent.merge`, `model.change` | aide |
| `workflow.enroll`, `workflow.claim`, `workflow.step`, `workflow.wait`, `workflow.pause`, `workflow.resume`, `workflow.outcome-unknown`, `workflow.resolve`, `workflow.migrate`, `workflow.complete`, `workflow.fail`, `workflow.cancel`, `workflow.forget`, `workflow.recover`, `workflow.rollback-detected` | loom (§20.25: minimal transition metadata, never model or tool content) |
| `user.login`, `user.lock`, `user.create`, `user.delete`, `key.enroll`, `key.remove`, `presence.assert`, `seal.window`, `quorum.request`, `quorum.complete`, `guest.start`, `guest.end` | hearth |
| `device.grant`, `device.authorize`, `device.deauthorize` | devd |
| `net.change` | net |
| `vm.start`, `vm.stop`, `vm.snapshot`, `vm.fork`, `vm.commit`, `vm.discard`, `media.attach`, `media.eject`, `media.export` | bench |
| `recovery.enter`, `recovery.delay`, `recovery.wipe` | recovery environment (`rescue`), spooled (§20.22) and appended by ledger |
| `legacy.import`, `legacy.open` | compat |
| `journal.segment` | journal |
| `ledger.key.register`, `ledger.redact`, `ledger.alarm`, `ledger.witness`, `ledger.export`, `ledger.shred` | ledger |
| `fleet.enrol`, `fleet.unenrol`, `fleet.policy.apply`, `fleet.command`, `fleet.attest` | fleet |
| `vouch.pair`, `vouch.remove`, `vouch.witness.cosigned`, `vouch.witness.conflict` | vouch |
| `pod.admit`, `pod.deny`, `pod.start`, `pod.stop` | cri |

**Recovery-replayable events.** The recovery environment cannot reach `ledger`; it spools receipts (`keylos.pendingreceipt/1`), which `ledger` appends at the next normal boot with `writer = service:ledger` and an extra field `onBehalfOf` naming the original writer. Only these events are recovery-replayable: `key.enroll`, `key.remove`, `presence.assert`, `config.revert`, `config.apply`, `update.rollback`, `user.create`, `recovery.enter`, `recovery.delay`, `recovery.wipe`.

**Extension rule.** A repository MAY emit additional events named `x-<repo>.<event>` (for example `x-strata.replica.send`). They MUST be listed in that repository's spec, MUST be written only by that repository's services, and carry no semantics for other components. Events named without a prefix MUST appear in this table.

#### 2.3.26 protocols §19.5 vsock ports

| Port | Direction | Service | Profile |
|---|---|---|---|
| 1024 | guest → host | `bench` (benchd control: `HostControl` / `Guest`) | capwire-vsock |
| 1025–1535 | either | `bench` bulk streams announced in control messages | raw byte streams |
| 7002 | guest → host | `aide` `AgentHost` (forwarded by `bench-relay` for agent VMs only) | capwire-vsock |
| 7004 | guest → host | `bench-relay` `GuestPortals` (tier-2 app VMs, agent desktops; never workbenches) | capwire-vsock |

All other guest network traffic leaves through the VM's single virtio-net device, terminated on the host by `bench-net`, which maps each flow to a `ShimEndpoint.connect` call on `gate` (§7.5.12).

#### 2.3.27 protocols §20.11 Flow proof

DSSE, signed by the agent session key registered with `BrokerSystem.registerSessionKey`:

```json
{"schema":"keylos.flowproof/1","session":"s-…","intent":"e-…","payloadDigest":"sha256:…",
 "runtime":"gen:fsv256:<harness runtime generation>","policy":"camel/1",
 "controlSources":[{"source":"user","label":{"conf":"private","integ":"user"}}],
 "dataSources":[{"argument":"body","source":"file:/home/…","label":{"conf":"private","integ":"user"}}],
 "claims":["control-flow-independent-of-untrusted","recipients-from-user"]}
```

It is attached to a staged intent as the arg `x-flow-proof` (base64 DSSE) and passed by `gate` to `BrokerSystem.checkFlow`. The broker accepts it instead of a prompt only if: the template's `agent.flowProof` is `"camel/1"`; the runtime is listed in the policy's `flowproof-runtimes.json`; every `controlSources[].label.integ ≤ user`; and the payload digest matches.

#### 2.3.28 protocols §20.12 Merge manifest

```json
{"schema":"keylos.fsmerge/2","prepared":"pm-…","session":"s-…","share":"project",
 "targets":["/home/alice/src/proj"],"base":"snap-…","source":"snap-…",
 "changes":[{"target":0,"path":"src/main.rs","kind":"modified","expectedLive":"sha256:…","afterDigest":"sha256:…","mode":"0644","size":1834},
            {"target":0,"path":"README.md","kind":"added","expectedLive":"absent","afterDigest":"sha256:…","mode":"0644","size":210}]}
```

The manifest of a **prepared merge** (`TransactionExt.prepare`, §7.5.7), an immutable object that stores the exact result to be applied: conflicts are resolved and automatic three-way merges are done **before** the manifest exists. `BenchMerge.manifest` returns it for bench shares, and `strata` for every other merge. Its SHA-256 over the JCS is the payload digest of the `fs.merge` intent and is bound by the mandate; the rendered diff is derived from the same object.

- `share` is the bench share name or `null`; `targets` are the canonical live directories; `base` is the transaction's base snapshot, `source` the frozen snapshot of the working view the result was prepared from.
- `changes` is sorted by (`target`, `path` bytes) without duplicates. `kind` ∈ `added`, `modified`, `deleted`, `renamed` (with `from`), `meta`. `expectedLive` is the content digest the live path must still have at commit, or `"absent"` (required for `added`; every other kind needs a digest). `target` is the index of the change's entry in `targets`. `afterDigest` is `null` exactly for `deleted`; `mode` (4 octal digits) and `size` are required except for `deleted`.
- **Commit** (`PreparedMerge.commit`): the mandate's effect digest MUST equal the manifest digest; `strata` takes a writer fence (`PrincipalControl.fenceWriters`), checks every `expectedLive`, and applies exactly the stored operations. It never merges again and never reads the working view; a stale precondition fails `kl:conflict`, and a different result needs a new prepared merge and a new approval.

`keylos.fsmerge/1` (`{"schema":"keylos.fsmerge/1","session","share","base","snapshot","changes":[{path, kind, beforeDigest, afterDigest, mode, size}]}`) is superseded: it remains parseable, but no mandate is bound to it.

**Trust boundary.** `strata` holds the prepared object and enforces the commit rules above for every origin; `bench` maps its share manifests to the prepared object and calls its `commit`.

#### 2.3.29 protocols §20.25 Durable execution

A **workflow** is an enrolled, durable task: a pinned definition (§20.27) run by `loom` as a sequence of steps, each executed by one or more **attempts**. The central invariant is normative for every component named in this section:

> Workflow progress survives execution attempts. Authority is revalidated before every further effect, and persistence never resurrects revoked permissions or cancelled work.

Boot-scoped authority is unchanged: tokens, root keys, sessions and prompt IDs never outlive their boot (§8.1). What survives is the record of progress and of decisions, never the authority to act on it.

**Roles.**

| Component | Durable responsibility | Never |
|---|---|---|
| `loom` | Workflow store: enrollments, runs, steps, attempts, recorded observations, timers, signals, tombstones; scheduling, claims, cancellation; the receipt outbox | holds workflow authority, executes effects, decides approvals |
| `broker` | Workflow records (approved scope, ownership epoch, label high-water mark, cancellation), attempt authority at registration, durable decisions | trusts loom for anything but the identity of the next claim |
| `gate` | Durable effect records by effect ID, executor strategies, workflow budget accounts | executes an effect without current authorization |
| `warden` | A fresh session for every attempt process (`SpawnSpec.attempt`) | persists sessions or fds, interprets attempt bindings |
| `aide` | Agent sessions as attempts (`AgentWorkflowHost`); model and tool observations recorded through `loom` | resumes an agent session that is not an attempt of an enrolled workflow |
| `strata`, `bench` | Prepared merges and their completion records retained for the workflow's horizon, reachable by a fresh attempt | bind a prepared merge to a dead session only |
| `vault` | `loom:` unit keys (wrapped under the system key, forgettable) | enforce the owner-lock policy (loom does) |
| `ledger` | Signed evidence of decisions, transitions and outcomes | act as a workflow store or deduplicate submissions |
| `hearth` | The owner's lock state (`HearthSystem.userState`, `watchUsers`) | |

**Identities** (§3.5). `WorkflowId` (`wf-`) names the enrolled task, `RunId` (`wr-`) one run of it, `StepId` (`ws-`) one occurrence of one state in a run, `AttemptId` (`wa-`) one execution attempt, `EffectId` (`fx-`) one logical external or local operation shared by all retries, `OwnershipEpoch` the fence advanced by every claim, `DecisionId` (`dr-`) a durable approval, `BudgetAccountId` (`ba-`) the workflow's budget. Step and effect IDs are derived, so a replayed step finds the records of its earlier attempts. A session ID is never the identity of durable work: every attempt runs under fresh sessions, and loom records the attempt-to-session mapping. Old principals, bearer tokens, fds and prompt IDs are never stored as replay material; signatures and digests are stored as evidence and re-verified, never as a substitute for current policy.

**Status vocabulary.** `WorkflowInfo.status` (§7.3.16) and the `status` of `workflow.*` receipts take exactly these values; `detail` carries one of the listed codes.

| Status | Meaning | `detail` codes |
|---|---|---|
| `running` | An attempt is executing or a claim is scheduled | `step:<ws-…>` |
| `waiting` | No attempt is needed until an external event | `decision:<dr-…>`, `timer:<RFC 3339 time>`, `signal:<name>`, `effect:<fx-…>` (awaiting the executor's outcome), `enrollment:<dr-…>` |
| `paused` | Eligible work is held back by a pause condition | `user`, `locked` (owner locked), `awaiting-resume` (manual resume after a restart), `breaker`, `budget`, `time-untrusted`, `rollback-review`, `capacity` |
| `blocked-by-authority` | The next step needs authority that does not exist now | `revoked`, `policy`, `decision-denied:<dr-…>`, `decision-expired:<dr-…>`, `definition-revoked`, `horizon` |
| `outcome-unknown` | An effect's outcome cannot be established automatically | `effect:<fx-…>` |
| `completed`, `failed` | Terminal: the definition reached an `end` state (`failed` also for `history-lost`) | `end:<state>`, `error:<code>`, `history-lost` |
| `cancelled` | Terminal: durably cancelled | `by:<human>` |
| `forgotten` | Terminal: history crypto-shredded; only a tombstone remains | none |

**Enrollment.** Enrollment is the only way work becomes resumable; an agent, app or guest session never becomes durable by being paused, stopped or restarted.
1. A human's `shell` (or `atrium`) calls `Loom.enroll` on `loom#user`. loom checks the definition (§20.27): the generation is launchable and not revoked (`Depot.get`), its manifest lists the name in `provides.workflows`, and the file's digest equals `DefinitionRef.digest`; it validates the input against the definition's input schema, assigns the `wf-` ID, and commits an `enrolling` record (deduplicated by owner and `idempotencyKey`).
2. loom calls `BrokerWorkflow.enroll(<caller session>, EnrollRequest)`. The broker evaluates Cedar `enroll` (§16.1) and every scope item as a persistent request; the tier is the maximum, at least `t2`, with presence when `resume = automatic` or `runWhileLocked` (as for persistent grants); guest humans and non-`shell` subjects are denied by default policy. The decision is a durable decision (below) with key `enroll` and the mandate effects `workflow.enroll` plus one `grant.<k>` per scope item (§14.2).
3. When approved, the broker writes the workflow record `keylos.workflow-grant/1` (signed by `service/broker`, file and directory `fsync`ed), with the label baseline = the enrolling session's label at that moment, the horizon (`horizonSecs` capped by policy, default 30 days, maximum 400 days) and the budget account, which it opens with `WorkflowBudget.open` on `gate#broker`. Only then does the workflow leave `waiting` (`enrollment:<dr-…>`).
4. The enrolling session's tokens are never used by the workflow; the approved scope is the only authority later attempts can receive.

**Claims and ownership fencing.** loom executes every step through a **claim**: before an attempt, loom commits the claim (new `wa-`, epoch e + 1, the activity's generation, the spawner session) in its store, then calls `BrokerWorkflow.claim`. The broker accepts only epoch = its record's epoch + 1 (`kl:conflict` otherwise: a stale or second coordinator, or a restored store), persists it before replying, and revokes every root minted for earlier attempts of the workflow. Every consumer rejects a stale epoch where it can still prevent an action: loom's `AttemptHost` (every method), the broker at attempt registration and in `authorizeEffect`, `gate` in `DurableEffects` (binding versus the token's `workflow` fact and the current claim, `BrokerWorkflow.verify`), strata in `preparedFor` and `bindWorkflow`. A process that missed a cancellation or lost its coordinator may stay alive; it cannot act, because its roots are revoked and its epoch is stale. A cooperative stop or an expired lease alone never authorizes anything. A new fence cannot undo a request a remote system already accepted; such effects are settled by their effect ID (§20.26). One loom instance owns the store exclusively (SQLite exclusive locking plus a lock file); a second instance fails its first claim with `kl:conflict` and stops.

**Attempt authority.** An attempt is a fresh principal: a process spawned by loom (`SpawnSpec.attempt`, principal `<actor>@<owner>/<loom session>/<attempt session>`) or an agent VM started by `aide` (`VmSpec.attempt`). `warden` forwards the binding in `SessionReg.attempt` and uses `binding.owner` as the principal's human. At registration the broker requires the binding to be the current claim, the child's generation to be the claimed generation, its parent to be the claimed spawner and its human to be the record's owner; otherwise registration fails `kl:conflict` (stale) or `kl:revoked` (cancelled). It then, in this order:
1. sets the session label to the join of the default and the workflow's label high-water mark (labels before grants);
2. re-evaluates every scope item against current policy with the workflow principal entity (§16.1): `t0`/`t1` items are minted, `t2`/`t3` items only with the enrollment mandate, as for persistent grants; revoked, expired, cancelled or denied items are not minted;
3. mints fresh tokens for the attempt session with `workflow(<wf>, <epoch>)`, `budget_account(<ba>)` and `expires` no later than the horizon (§8.2).
The attempt process obtains these tokens like every principal, with `Broker.myGrants` on its `broker#principal` route; `warden` never passes the tokens of `SessionRegResult` to the process. An attempt therefore holds an effect token only for kinds in the enrolled scope: at `enroll`, loom refuses (`kl:invalid`) a scope that lacks an effect item for any kind an activity of the definition declares in `effects`, so `DurableEffects.prepare` always has a token to present. Offered tokens of the spawner are never delegated to an attempt. `BrokerWorkflow.offer` gives `aide` short-lived path and net tokens of the scope on its own session, only to build the attempt VM's shares, exactly as human-offered tokens are used today.

**Durable decisions.** `BrokerWorkflow.decide` creates or returns the durable decision of one logical operation. Its identity is (`workflow`, `key`) and its digest the SHA-256 of the JCS `{"workflow", "key", "requests": [<GrantRequest JSON forms, §14.4>], "effects": [{"kind", "target", "digest"}]}`; neither contains a session, attempt or prompt ID, so a fresh attempt finds the same decision. The same key with another digest fails `kl:conflict`. The broker persists the record before showing any prompt and persists the decision before replying to anyone (a crash between decision and reply loses nothing). Prompts are boot-local and re-presented after restarts (§14.3); `expires` is fixed at creation. A fresh attempt uses an approved grant decision only through `rebind`, which re-checks the record, current policy, revocation, expiry and presence and mints for the new session; an effect decision is consumed by `gate`, once per effect ID (§20.26). A trusted approval is always a decided mandate bound to the operation and payload, never a workflow signal. For a `decide` state (§20.27) the decision carries one `DecisionEffect` per option (kind `workflow.decide`, target `<ws-…>#<option>`, digest over the JCS `{"question", "option"}`); the human approves exactly one option, and the delivered mandate's `effects[]` holds only that entry, the one permitted difference from the draft. `BrokerWorkflow.cancelDecision` withdraws one pending decision (for example when its effect is cancelled).

**Effects.** loom never executes effects. An activity prepares an effect at `gate` with the effect ID loom assigned (`AttemptHost.effect`, `DurableEffects.prepare` with its token); loom commits it later with the current claim (`DurableEffects.commit` on `gate#loom`), and `gate` asks the broker for current authority (`authorizeEffect`) every time. The effect contract is §20.26.

**Labels.** The workflow label is a high-water mark kept by the broker (`BrokerWorkflow.raise`; the broker also raises it whenever an attempt session's label rises). loom stores every observation and result with its label; replayed observations keep their labels; `AttemptHost.task` returns the workflow label; a fresh attempt therefore never restarts at `public/trusted` after the workflow consumed more sensitive or less trusted data. The Rule of Two (§14.1) applies to workflow effects with the workflow label.

**Budgets.** Each workflow has one budget account (`ba-`) with the enrollment's ceilings, held by `gate` independently of token roots. Attempt tokens carry `budget_account`, so metered spending is charged to the account whatever root the attempt holds; new roots never reset spent amounts. Reservations are keyed (`reserve`, `settle`, `release` are idempotent per key): `gate` uses `<wa-…>:<request number>` for metered requests, loom and aide derive keys from step and observation keys. A reservation of an attempt that was fenced before settling is settled as `unresolved` (still counted against the ceiling) until the actual charge is known; a key is settled at most once with a final amount, so a duplicated completion message never double-charges. The account is closed when the workflow is terminal.

**Recorded observations and replay.** Orchestration is deterministic: the next state depends only on the definition and on recorded outcomes, results, signals and timer firings. Every non-deterministic observation that can influence a later decision (model responses, tool results, clock readings, randomness) is recorded through `AttemptHost.record` before the activity uses it. A later attempt of the same step obtains recorded observations by key (`AttemptHost.recorded`) instead of asking a model or tool again; it calls live only past the last recorded key. Observation keys are `<kind>:<n>` with a per-kind counter that starts at 0 in every step and counts in the order the activity makes the observations, so a deterministic replay reaches the same keys. An activity whose result was never recorded is retried, reconciled or reported per its declared semantics (§20.27); it is never treated as completed because it probably ran.

**Durability.** loom acknowledges an enrollment, transition, observation, result, signal, cancel or forget only after its SQLite transaction (WAL, `synchronous=FULL`) committed, every blob it references was written with `O_TMPFILE`, `fsync`ed, linked and its directory `fsync`ed, and, where a receipt is required, after the receipt is acknowledged. A failed `fsync`, a full disk or any other barrier failure aborts the transaction and is reported `kl:unavailable`; after an `fsync` failure the store is reopened and verified before the next write. A state transition and the messages it causes (claims, effect commits, receipts) are committed in the same transaction as outbox rows and delivered afterwards with stable IDs; deliveries are deduplicated by those IDs on the receiving side.

**Receipt outbox.** loom writes `workflow.*` receipts (§19.3) with `subject` = the principal that enrolled the workflow and `data` = `{workflow, run, n, …}` holding only IDs, states, epochs, digests and reason codes, never inputs, results or model and tool content; `n` is the per-workflow event number and (`workflow`, `n`) the stable logical event ID. Each receipt is an outbox row committed with its transition. Delivery: loom builds and signs the submitted form, persists its `time` and submitted-form digest in the row, then calls `Ledger.append`; on success it records the returned `seq`. A `re-sign` refusal (§13.1) is answered by persisting a new submitted form and resubmitting. **Reconciliation** after a restart: loom first appends `workflow.recover` (subject: loom itself) with a `time` later than every outstanding submission's `time`; once it is acknowledged, no outstanding submission can be appended any more (§13.1 time order), and each is settled by searching its submitted-form digest among loom's receipts after the last acknowledged `seq` (`Ledger.query`, `principalPrefix "service:loom:"`, §7.3.5): found → acknowledged with that `seq`; not found → it was never appended, and loom submits it again as a new submitted form. Each logical event therefore produces at most one receipt, and at least one once the ledger is reachable. The ledger itself never deduplicates; a coordinator+ledger atomic transaction is not claimed.

**Rollback detection.** loom's store records the ledger `seq` of its newest acknowledged receipt. After `workflow.recover` is acknowledged, every loom receipt between that `seq` and the recovery receipt must be an outstanding submission of the store; any other one, a store that is behind the ledger, or a ledger that is behind the store (an alarm epoch, §13.3) means an older store was restored. loom then writes `workflow.rollback-detected`, pauses every workflow (`rollback-review`) and re-applies the authoritative records: `workflow.cancel` and `workflow.forget` receipts after its anchor (their `refs` stay readable after shredding, §13.4) become tombstones; the broker's workflow records give the current epoch and cancellation state; `gate`'s effect records and budget accounts give effect outcomes and spent amounts; a workflow whose history the store no longer has becomes `failed` with `history-lost`, never restarted. Dispatch resumes only after the owner accepts with `loom rollback accept` (presence purpose `loom.rollback-accept`, §20.2). The broker's workflow and decision records and `gate`'s effect records and budget accounts are anchored the same way against their own receipts (`principalPrefix "service:broker:"`, `"service:gate:"`). The anchor rests on the ledger's own rollback protection (NV counter `0x01300100`, §13.3); no further NV index is used. Restoring an older store therefore cannot resurrect cancelled work, reset budgets or repeat effects; restoring the whole disk image is detected by the ledger's counter and leads to the same review.

**Cancellation.** `Workflow.cancel`: (1) loom commits a `cancelling` tombstone; (2) `BrokerWorkflow.cancel` writes the broker's durable cancellation record, revokes every root carrying the workflow fact and cancels the workflow's pending decisions; (3) loom terminates attempts (`Process.kill`, `AgentWorkflowHost.stopAttempt(…, "cancel")`), cancels prepared and awaiting effects (`DurableEffects.cancel`) and drops timers; (4) after `workflow.cancel` is acknowledged, `cancel` returns. Step 2 needs the subject's live session (the broker evaluates Cedar `cancel` for it). If loom restarts between steps 1 and 2 and that session no longer exists, the workflow stays non-runnable (the `cancelling` tombstone allows no claims and no attempts) and loom completes steps 2–4 when the broker's record shows the cancellation or when the owner calls `cancel` again; it never resumes the workflow. Effects already authorized or dispatched are not undone by cancellation: loom keeps resolving their outcomes (lookup, reconciliation) and records them. Cancellation runs no further workflow logic; compensation is a new authorized effect, run before cancelling through the definition's `abort` signal (§20.27). Recovery never re-enrolls a cancelled workflow: its tombstone, the broker's record and the ledger evidence each refuse it.

**Forgetting.** `Workflow.forget` cancels the workflow if it is not terminal, commits a `forgotten` tombstone, then destroys every copy of its private history: `vault.forget("loom:<owner>:<wf-…>")`, `DurableEffects.forget` (gate shreds the workflow's payload unit `gate:<owner>:<wf-…>`), discard of retained prepared merges, removal of `aide`'s attempt units and `Depot.unroot`. loom evicts cached keys and plaintext, and re-checks the tombstone after every asynchronous key or blob fetch before caching or delivering the result. What remains: loom's tombstone (`wf-`, run IDs, owner, terminal kind, time), the broker's cancellation record, `gate`'s minimal effect records (§20.26) and the ledger's ID-only receipts, which suffice to prevent recreation and contain no private data. Cryptographic erasure completes as the vault reports it (vault rotation). History that is deleted or expired is reported as `forgotten` or `history-lost`, never silently restarted.

**Owner lock.** Key wrapping does not decide execution: `loom:` units are wrapped under the vault's system key, so loom can keep recording outcomes of in-flight operations while the owner is locked. Execution follows an explicit lock policy: a workflow owned by a human pauses (`paused`, `locked`) while that human is locked (`HearthSystem.userState`: no authenticated, unlocked login session; logged out counts as locked), unless it was enrolled with `runWhileLocked` (presence-approved). While paused by the lock, loom makes no claims, dispatches nothing and decrypts no history for execution; overdue timers wait. When hearth is unreachable loom assumes the owner is locked. Workflows of `_system` never pause for a lock. When hearth reports a user deleted (`watchUsers`, `deleted`), loom forgets every workflow of that user.

**Restart and reboot.** At start loom runs the receipt reconciliation and the rollback check, then for each non-terminal workflow reads the broker's record (cancelled → finish the cancellation), looks up every effect that is not settled (`DurableEffects.lookup`), and treats every attempt of the previous run of loom as ended (its sessions are gone or fenced). A workflow with `resume = manual` becomes `paused` (`awaiting-resume`) until its owner calls `Workflow.resume` (Cedar `resume`); one with `resume = automatic` is claimed again without asking, still fully reauthorized by the broker. Steps whose activity result was not recorded continue per the activity's semantics (§20.27).

**Timers, signals and time.** Timers are stored rows; a timer fires only when trusted time (§3.6) has reached its due time, never early; while the clock is not trusted loom uses `max(now, time floor)` and pauses timer-driven work whose due time lies beyond the floor (`time-untrusted`). Decision expiry, horizons and deadlines are checked against trusted time. After a long downtime overdue work is caught up in due order at most `catchUpPerMinute` (default 6) claims per minute, a periodic timer fires once rather than once per missed period, and every overdue item re-checks cancellation, pause, lock, budget and horizon first. Signals are recorded with the sender's label, deduplicated by (name, key); a workflow past its horizon is `blocked-by-authority` (`horizon`): the broker refuses its claims.

**Retention.** History is kept until the workflow is forgotten, or `historyRetentionDays` (default 30) after it became terminal, when loom forgets it automatically. Decision records live until 30 days after the workflow is terminal; effect dedup records per §20.26; tombstones are never deleted. Replay retention is independent of the ledger's monthly audit retention: shredding a receipt month never removes history a live workflow needs, and forgetting a workflow leaves no decryptable copy of its history in any receipt.

#### 2.3.30 protocols §20.27 Workflow definitions

A workflow definition is an explicit, versioned state machine shipped in a generation at `/.keylos/workflows/<name>.json` and listed in the manifest's `provides.workflows` (§6.3). `loom` interprets it; definitions contain no code. Activities run as separate attempts with their own principals and confinement. The file MUST be canonical JCS JSON; `DefinitionRef.digest` (what a workflow pins) is the SHA-256 of the file's bytes exactly as shipped. Defaults a validator fills in (for example an absent `effects` member read as `[]`) are never part of the digest, so a definition is never re-serialized for hashing.

```json
{"schema":"keylos.workflow/1","name":"coding-task","version":"1.0.0","stateVersion":1,
 "summary":"Change code, test it, merge the exact reviewed result, publish",
 "input":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["task"],
          "properties":{"task":{"type":"string"}}},
 "activities":{
   "edit":{"kind":"agent","template":"gen:fsv256:…","timeoutSecs":7200,"semantics":"replayable",
           "retry":{"max":3,"backoffSecs":[30,300,1800]},"effects":["merge"]},
   "test":{"kind":"process","entrypoint":"run-tests","timeoutSecs":1800,"semantics":"idempotent",
           "retry":{"max":2,"backoffSecs":[10]}},
   "publish":{"kind":"process","entrypoint":"publish","timeoutSecs":600,"semantics":"at-most-once","effects":["push"]}},
 "start":"edit",
 "states":{
   "edit":{"run":"edit","next":{"ok":"test","failed":"failed"}},
   "test":{"run":"test","next":{"ok":"merge","failed":"edit"}},
   "merge":{"commit":{"state":"edit","effect":"merge"},"next":{"succeeded":"publish","failed":"edit","denied":"failed","cancelled":"failed"}},
   "publish":{"run":"publish","next":{"ok":"push","failed":"failed"}},
   "push":{"commit":{"state":"publish","effect":"push"},"next":{"succeeded":"done","failed":"failed","denied":"failed","cancelled":"failed"}},
   "done":{"end":"completed"},
   "failed":{"end":"failed"}},
 "signals":{"abort":{"schema":{"type":"object"},"goto":"failed"}},
 "limits":{"maxTransitions":10000,"maxOccurrences":100},
 "migrateFrom":[]}
```

**Rules** (loom refuses a definition that breaks any of them, `kl:invalid`):
- `name` matches `[a-z][a-z0-9-]{0,62}` and equals the file name; `version` is SemVer; `stateVersion` is a positive integer that changes whenever the state set or the meaning of recorded results changes.
- `input` is a JSON Schema 2020-12 document without remote references; the enrollment input MUST validate against it.
- Activities: `kind` `process` (an entrypoint of the definition's own generation, spawned by loom with `SpawnSpec.attempt`, reaching loom on `loom#attempt`) or `agent` (an agent session of the pinned `template` generation, started by `aide` through `AgentWorkflowHost`); `timeoutSecs` ≤ 86 400; `retry.max` ≤ 10, `backoffSecs` non-decreasing; `effects` lists the effect names the activity may register with `AttemptHost.effect`. `semantics` is one of `idempotent` (an attempt that ended without a recorded result is retried), `replayable` (retried, with the recorded observations replayed by key) and `at-most-once` (an attempt that ended without a recorded result makes the workflow `outcome-unknown` until the owner resolves it).
- States: every state has exactly one of `run` (an activity; outcomes `ok`, `failed`), `commit` (`{state, effect}`: commits the effect that the most recent occurrence of `state` registered under `effect`; outcomes `succeeded`, `failed`, `denied` (decision denied or expired) and `cancelled`; an unknown outcome makes the workflow `outcome-unknown` until it is resolved, then the resolved outcome's `next` is taken), `wait` (`{"afterSecs": n}` or `{"at": "<JSON pointer into the input or a recorded result>"}` with outcome `timer`, or `{"signal": "<name>", "timeoutSecs": n}` with outcomes `signal` and `timeout`), `decide` (`{"question": "<JSON pointer>", "options": ["…"]}`: a durable decision of kind `workflow.decide`, outcomes the option names and `denied`), `choice` (a list of `{"if": {"pointer", "equals" | "exists"}, "next"}` over recorded results and the input, plus `default`) and `end` (`completed` or `failed`). `next` maps every outcome of the state to a state; there are no other transitions.
- Determinism: the next state is a function of the state, its outcome and recorded data only. JSON pointers address `/input/…` and `/steps/<state>/result/…` (the most recent occurrence). There are no clocks, randomness or external lookups in definitions.
- `signals` names the signals the workflow accepts, each with a JSON Schema and an optional `goto` taken from any non-terminal state (for example `abort`, which runs compensating effects as ordinary authorized effects before the workflow ends).
- `limits.maxTransitions` (≤ 100 000) bounds a run and `limits.maxOccurrences` (≤ 10 000) every state; exceeding either fails the workflow (`error:limits`).
- **Pinning and upgrades.** A workflow runs the definition it pinned for its whole run; a new version of the generation never changes a running workflow. The pinned generation stays rooted (`loom:workflow:<wf-…>`, §7.3.8). If the generation is revoked or no longer launchable, the workflow becomes `blocked-by-authority` (`definition-revoked`) before its next claim; pinning never bypasses revocation. `Workflow.migrate` moves it to another definition only when that definition's `migrateFrom` lists the pinned `(version, stateVersion)` with a `states` map from every non-terminal old state to a new state; it needs a new enrollment decision for the target (the same `wf-` ID, a new `wr-` run) and replays no old history under new code.

### 2.4 How aide applies the shared contracts

| Topic | Rule |
|---|---|
| Session principal | The VM principal created through `bench#aide` is the agent session principal (`actor kind agent`, protocols §3.4: a VM principal maps to its VMM cgroup). aide sets `VmSpec.session = S`, `VmSpec.parentSession` = the last session of the launching human's chain and `VmSpec.principalKind = agent`, so the VM principal is `agent:<template>@<human>/<chain>/S` (§4.3). Sub-agent VMs set `parentSession` = the parent agent session. |
| Acting for a session | aide never impersonates a session on `broker#principal`. Grant requests for a session go through `BrokerSystem.requestFor(session, req, "", idempotencyKey)` (aide's allowed subjects are its agent sessions, protocols §7.5.2); staging goes through `gate#aide` with the session token as `x-subject-token`; model and MCP traffic goes through `gate#aide` `connect` with the session's net token. |
| Budgets | Sub-agent budgets are **hard sub-meters**: aide puts the child's budget in `ForkSpec.budgets`; bench copies it to `VmPrincipal.budgets`, and broker mints the child root with `budget_parent(<parent root>)` and calls `GateMeterAdmin.carve` when the fork is registered (protocols §7.3.13, §7.5.1, §7.5.12, §8.2). aide never carves itself. |
| Template files | Read through `Depot.openPath(template, "/.keylos/agent/…")` on `depot#user` (protocols §7.3.8); never from the VM. |
| GrantDelegate outcome | Exactly the JCS shape of protocols §7.5.10: `{"outcome": "granted"\|"denied"\|"pending", "token": <base64 Biscuit>\|null, "approval": "a-…"\|null, "reason": "…"}`. |
| Agent desktops | Templates with `vm.desktop: true` get a VM with purpose `agentDesktop`; aide relays `Vm.desktop()`'s `AgentDesktop` to the harness through `AgentHostExt.desktop` (protocols §6.4, §7.5.13, §14.5). |
| Model drift | gate records provider-reported model identities and escalates the session; aide writes `model.change`, emits `rich {"type": "modelChange"}` and shows the re-approval (protocols §14.5). |
| VM capacity | When `Bench.start` fails with `kl:unavailable` because the RAM-class VM cap is reached (protocols §2.3), aide queues the session instead of failing. |
| Guests | Sessions for humans whose name starts with `guest-` (protocols §3.3) are refused unless config `guestAgents = true` (rendered from `hearth.guest.agents`, protocols §14.3). |
| Labels | aide raises the session label with `LabelAuthority.raiseFor` **before** returning any host-tool or MCP result with a higher label (protocols §14.1). |
| Rich events | Events richer than the union are emitted as `AgentEvent.rich` (protocols §7.3.14); aide never encodes them inside `message`. |
| Session keys | The `session/<id>` key (protocols §5.2) is generated by aide, stored in vault as kind `git-signing`, registered with `BrokerSystem.registerSessionKey`, and used only through `Vault.sign` (flow proofs) and gate's SSH agent (commits). |
| Workflow attempts | An agent activity of a workflow (protocols §20.27, kind `agent`) is one agent session per attempt, started by `loom` through `AgentWorkflowHost.startAttempt` on `aide#loom`. aide sets `VmSpec.attempt` (or `ForkSpec.attempt`) to the binding; bench, warden and the broker register the VM principal `agent:<template>@<owner>/<aide session>/S` with that binding, restore the workflow label and mint the attempt's tokens from the workflow record (protocols §20.25). aide never offers a human's tokens to an attempt. |
| Recorded observations | For an attempt, aide is the recording point: every model response and every host-tool or remote-MCP result is recorded with `AttemptHost.record` (obtained with `LoomSystem.attempt`) before the harness receives it, and replayed by key on later attempts (§4.18). |
| Version probe | Every bootstrap capability implements `common.Extensible`; `version()` returns `("1.0.0", "aide <semver>")`. |

### 2.5 Repo-local definitions

`schema/aide-local.capnp` (file ID `@0xb6f1d2c3a4958e01`, generated with `capnp id`) is used only by aide and its own CLI, through `Extensible.ext` on the `user` and `admin` bootstrap capabilities.

```capnp
@0xb6f1d2c3a4958e01;
using C = import "/keylos/common.capnp";

interface AideUser {                       # facet user: the human's own sessions
  provide  @0 (session :C.SessionId, file :C.Fd, name :Text) -> (guestPath :Text);   # answer a powerbox request
  budget   @1 (session :C.SessionId) -> (json :Text);
  pause    @2 (session :C.SessionId) -> ();
  resume   @3 (session :C.SessionId) -> ();
  discard  @4 (session :C.SessionId) -> ();
  log      @5 (session :C.SessionId, kind :Text) -> (cbor :C.Fd);                   # "observed" | "claimed" | "all"
}

interface AideAdmin {                      # facet admin
  pause   @0 (session :C.SessionId) -> ();
  resume  @1 (session :C.SessionId) -> ();
  retain  @2 (session :C.SessionId, days :UInt16) -> ();
  purge   @3 (session :C.SessionId) -> ();          # discard overlays and snapshots now; forget the aide: unit
  list    @4 (human :Text) -> (json :Text);
}
```

---

## 3. Requirements

### 3.1 Templates

- **REQ-AIDE-001** aide MUST start sessions only from `agent-template` generations that `depot` reports `launchable` and not `revoked`.
- **REQ-AIDE-002** aide MUST read template files only through `Depot.openPath` and MUST verify, at session start and on every resume, all pinning rules of protocols §6.4: tool digests, `tools.digest`, prompt and policy digests, harness, bench-image and local MCP generation refs, and remote MCP `toolsDigest` (at first connection). A remote MCP mismatch disables that server's tools and emits `rich {"type":"mcpPinMismatch"}`; if the server is not `optional`, the session fails with `kl:integrity`.
- **REQ-AIDE-003** A template MUST NOT grant authority. Authority comes only from `SessionSpec.grants` (attenuated) and from approvals during the session. `policy.json` may only narrow.
- **REQ-AIDE-004** `flowProof: "camel/1"` templates MUST have `harness.placement = "wasi"` and the manifest field `agent.flowProof = "camel/1"`; otherwise aide refuses to start them with `kl:invalid`.

### 3.2 Sessions

- **REQ-AIDE-010** `Aide.start` MUST perform the start algorithm of §4.3 and MUST return only after the VM is running and `agent.start` is written, or after the session entered `Queued` (§4.15), or fail without leaving a VM, token delegation or vault item behind.
- **REQ-AIDE-011** The agent VM MUST receive:
  - the project (if any) only as an **overlay** share;
  - read-only shares only for directory tokens the human passed;
  - network tokens only from the delegated set;
  - nothing else. aide MUST NOT share the human's home, `.ssh`, `.config`, `.apps`, any harness configuration another principal reads, or any vault item.
- **REQ-AIDE-012** A session principal MUST be routed only to `aide#host` for its own VM. A session MUST NOT be able to attach to, steer or inspect other sessions.
- **REQ-AIDE-013** `AgentSession.stop` MUST stop the VM, cancel pending approvals and intents of the session (`Intent.cancel`), revoke the session's root tokens (`Broker.revoke`), delete the session key item, and write `agent.stop`. Overlays are retained until merged, discarded, or `retainOverlayDays` passes.
- **REQ-AIDE-014** `AgentSession.fork` MUST create a sibling session from `Vm.fork(ForkSpec{session: <new>, parentSession: <the original's parent>, principalKind: agent})`, with the same template, copy-on-write overlay state at fork time, tokens the broker issued at the fork's registration (carved from the parent's budget), and a new session key.
- **REQ-AIDE-015** Session metadata (no secrets) MUST persist so that after an aide restart `sessions` and `attach` work, VMs keep running, and `aide-guest` reconnects with backoff. After a restart aide MUST obtain a new `Vm` capability for every running session with `Bench.reattach(S)` (protocols §7.3.13) before serving `review`, `fork`, `stop` or `takeOver` for it.
- **REQ-AIDE-016** `SessionSpec.deadlineSecs` MUST be enforced; at the deadline the session stops (REQ-AIDE-013). Time spent `Queued` counts against the deadline.
- **REQ-AIDE-017** The VM of every agent session MUST be started with `VmSpec.session`, `parentSession` and `principalKind = agent` set (§2.4), so the VM principal's session chain is the human's chain plus S (or the parent agent's chain plus C for sub-agents).
- **REQ-AIDE-018** When `Bench.start` fails with `kl:unavailable` and bench's status reports the RAM-class cap (protocols §2.3), the session MUST enter `Queued`; queued sessions MUST start in FIFO order per human, round-robin across humans, as capacity frees (§4.15).
- **REQ-AIDE-019** aide MUST refuse `Aide.start` for guest humans (`guest-` prefix) unless config `guestAgents = true`.

### 3.3 Tools and routing

- **REQ-AIDE-020** `AgentHost.tools` MUST return exactly the template's pinned tool set plus enabled remote MCP tools, each with its digest.
- **REQ-AIDE-021** `AgentHost.callTool` MUST be used only for host tools and remote MCP tools; unknown names fail with `kl:not-found`. VM, cmd and local MCP tools run inside the VM.
- **REQ-AIDE-022** Every `callTool` result MUST carry a label (§4.6) and aide MUST raise the session label before returning it.
- **REQ-AIDE-023** `provenanceJson` from the harness MUST be forwarded unchanged into `EffectArg.source`/`label` and `BrokerSystem.annotateRequest`. aide MUST additionally record its own observed provenance for values it supplied earlier in the session (exact string inclusion) as `EffectArg` entries named `x-observed-source:<arg>`.

### 3.4 Models

- **REQ-AIDE-030** `AgentHost.model` and `AgentHostExt.modelStream` MUST forward requests to a provider listed in the template's `models`, through `gate#aide` `connect` with the session's net token for the provider host. Credentials are injected by gate. aide MUST NOT read or hold provider keys.
- **REQ-AIDE-031** aide MUST reject requests whose `model` is not in the template's `models`, or whose `max_tokens` exceeds the template limit (`kl:denied`).
- **REQ-AIDE-032** Local models run inside the VM (template `models[].provider = "local"`, `vm.gpu = true`). aide MUST charge GPU time with `Gate.charge(rootId, {unit: "usd-micro", amount}, "local-gpu")` once per minute of VM wall time with the GPU attached, priced by config. Local models MUST be pinned by their `weights` data generation, which bench exposes read-only through `VmSpec.storeSet`; they cannot drift.
- **REQ-AIDE-033** On a model-identity mismatch reported by gate for a session (a `budget.charge` receipt with `data.drift`, §4.16), aide MUST write `model.change {session, provider, expected, observed, approval}`, emit `rich {"type":"modelChange", …}`, and keep the session usable only through the escalated (T2) path until the human approves or stops it.

### 3.5 Sub-agents, budgets, breakers

- **REQ-AIDE-040** `keylos.subagent.spawn` MUST create the child with `Vm.fork(ForkSpec{session: C, parentSession: P, principalKind: agent, offered: [] , checks, budgets})` on the parent's VM (protocols §7.3.13): empty `offered` makes the fork's tokens derive from the **calling session's** VM principal tokens, never the human's; `checks` carries the narrowing (deadline, depth decrement, effect and label limits); the broker attenuates them at `VmSpawn.register` (protocols §7.5.1). aide never holds or delegates the parent's tokens itself. aide MUST refuse when the remaining depth is 0 or `max_fanout` is reached (`kl:denied`).
- **REQ-AIDE-041** A sub-agent's budget MUST be a hard sub-meter carved from the parent's root: aide passes the requested budget in `ForkSpec.budgets`; the broker mints the child root with `budget_parent(<parent root>)` and calls `GateMeterAdmin.carve` during registration; a refusal fails the fork with `kl:budget`. gate charges the child and every ancestor.
- **REQ-AIDE-042** aide MUST implement the velocity breakers of §4.9. On a trip aide MUST pause the session subtree and notify the human; resuming requires an explicit human action.
- **REQ-AIDE-043** A child's results reach its parent only as data (§4.8); a child never merges into the real tree.

### 3.5a Agent desktops (computer use)

- **REQ-AIDE-045** A template with `vm.desktop: true` MUST get a VM with `VmSpec.purpose = agentDesktop`, `display = true`, `displayMode = readOnly` (the human's mirror), and its own nested desktop image. `AgentHostExt.desktop()` MUST return the bench-served `AgentDesktop` capability (wrapped by aide, §4.17) for such sessions and `kl:unsupported` for all others.
- **REQ-AIDE-046** aide MUST NOT give any agent session access to `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, another principal's clipboard data or input injection on a human's real session (protocols §14.5). The only real-session observation is the host tool `keylos.screen.window` (§4.7.2), which yields one still image per T3 approval.
- **REQ-AIDE-047** While the human has taken over the agent desktop (`Vm.takeOver(true)`), aide MUST refuse `AgentDesktop.input` from the harness (`kl:denied`) and emit `rich {"type":"desktop","takenOver":true}`.
- **REQ-AIDE-054** aide MUST implement `AgentSession.takeOver(interactive)` (protocols §7.3.14) for the session's own human only (callers on `aide#user` whose human is the session's human; `kl:denied` otherwise) by relaying to `Vm.takeOver`, and MUST record the switch in the observed log and as `rich {"type":"desktop","takenOver":<bool>}`.
- **REQ-AIDE-055** aide MUST NOT delegate the human's tokens to an agent session before the VM principal exists: top-level grants are passed as offered tokens (held by the human's session, attenuated offline with `Broker.attenuate`) in `VmSpec.network`, and the broker issues the session's tokens at `VmSpawn` registration (protocols §7.5.1).
- **REQ-AIDE-048** Every `screenshot` returned to the harness MUST be recorded in the observed log as its SHA-256 and size (not the pixels); every `input` call as its event count and kinds.

### 3.6 Review, merge and proposals

- **REQ-AIDE-050** `AgentSession.review` MUST, for each writable overlay share: freeze it with `BenchMerge.manifest`, stage one `fs.merge` intent through `gate#aide` whose payload is the manifest JSON, and return the approval prompt reference. The real tree is changed only by gate's executor (`BenchMerge.commitShare`) after a T3 mandate.
- **REQ-AIDE-051** After the merge commits (ledger `effect.commit` for the intent), aide MUST write `agent.merge` with the intent ID, the transaction ID and the undo snapshot.
- **REQ-AIDE-052** aide MUST NOT stage a merge for a manifest computed before the share's last change; `BenchMerge.manifest` freezes a snapshot, strata prepares an immutable merge of it (protocols §7.5.7 `PreparedMerge`, `keylos.fsmerge/2`) and the digest binds that prepared merge.
- **REQ-AIDE-053** `keylos.config.propose` MUST call `Config.propose(projectDir, origin = <agent principal>)` only after a merge of that project has committed, and MUST return the plan rendering. aide MUST NOT call `Plan.apply`.
- **REQ-AIDE-056** **Replacement approvals.** When the reviewed result changes — the agent writes again after `review`, conflicts are resolved, or `commitShare` fails `kl:conflict` because the live tree changed after `prepare` — aide MUST cancel the pending `fs.merge` intent (or record its failure), call `BenchMerge.manifest` again (a new prepared merge with a new `pm-…` ID and digest) and stage a **new** `fs.merge` intent with a new idempotency key, which needs a new approval. aide MUST NOT reuse a mandate across prepared merges and MUST NOT present an earlier rendering for a new digest.

### 3.7 Attribution

- **REQ-AIDE-060** Git commits created in the VM MUST carry `Assisted-by: <template name>/<template version> (<model id>)` and `Agent-Session: <s-id>` trailers (installed by aide-guest as a `prepare-commit-msg` hook) and MUST be signed with the session key through `SSH_AUTH_SOCK` (gate's agent via bench).
- **REQ-AIDE-061** aide MUST NOT hold or use any `owner-presence`, `owner-seal` or human key.

### 3.8 Workflow attempts (protocols §20.25)

- **REQ-AIDE-070** aide MUST serve `AgentWorkflowHost` (protocols §7.5.25) on facet `loom` to the holder `loom` only. `startAttempt(binding, template, task, input, label)` MUST verify the binding with `BrokerWorkflow.verify(binding, <empty>)`, read and pin-check the template (§4.1, REQ-AIDE-002), and start the agent session per §4.18 with `VmSpec.attempt = binding` (or `ForkSpec.attempt` for project sessions), `VmSpec.parentSession` = aide's own service session and no human-offered tokens. It MUST return only after the VM principal is registered and `agent.start` (with `data.workflow`, `data.attempt`, `data.epoch`) is written, or fail leaving no VM behind.
- **REQ-AIDE-071** Share dirfds and offered network tokens of an attempt VM MUST come only from `BrokerWorkflow.offer(binding)`; aide MUST use them only to build that VM's `VmSpec` (shares, `network`) and MUST drop them when `Bench.start` returns or after 120 s. The attempt session's own tokens are minted by the broker at registration.
- **REQ-AIDE-072** The persisted session record of an attempt MUST carry the binding; `AgentSession.attempt()` MUST return it (epoch 0 for ordinary sessions). A session MUST be attached to at most one workflow attempt for its whole life.
- **REQ-AIDE-073** For an attempt, every model response (`AgentHost.model`, `AgentHostExt.modelStream`, complete stream bytes) and every host-tool and remote-MCP result MUST be recorded with `AttemptHost.record` under the deterministic key `model:<n>` / `tool:<n>` (n = 0, 1, … per kind within the attempt's step, in harness call order) with the request's SHA-256 and the result's label, and the record MUST be acknowledged before the response reaches the harness. A failed record (`kl:unavailable`) MUST fail the harness call; it MUST NOT be delivered unrecorded.
- **REQ-AIDE-074** **Replay.** In an attempt of a step that earlier attempts already started, aide MUST answer the harness's n-th model or tool call from `AttemptHost.recorded(<key>)` when an observation exists for that key and its request digest equals the SHA-256 of the new request, without calling gate, MCP servers or tools; the first missing key or digest mismatch switches the attempt to live calls for every later call of that kind. Replayed observations raise the session label to their recorded label (`LabelAuthority.raiseFor`) before delivery; replay never charges budget.
- **REQ-AIDE-075** aide MUST NOT lower an attempt session's label and MUST NOT re-mint or carry tokens across attempts. Budget of an attempt is the workflow account named by the token's `budget_account` fact; local GPU time is reserved and settled on it with keys `gpu:<wa-…>:<minute>` (`WorkflowBudget` on `gate#aide`) in addition to `Gate.charge`.
- **REQ-AIDE-076** **Prepared merge as a workflow effect.** For an attempt whose activity declares the effect `merge`, `review` (and the harness's completion) MUST: freeze and prepare with `BenchMerge.manifest`, bind the transaction to the workflow (`TransactionExt.bindWorkflow(binding)` on `strata#aide`), register the effect with `AttemptHost.effect("merge", requestDigest)` (protocols §20.26 digest of the `fs.merge` request), and prepare it with `DurableEffects.prepare` on `gate#aide` with the attempt token, never `Gate.stage`. aide MUST NOT commit workflow effects; loom commits them. The prepared merge ID, manifest digest and effect ID go into the attempt's result (`AttemptHost.complete`).
- **REQ-AIDE-077** **Cancellation versus failure.** `AgentSession.stop` called by the session's human on `aide#user` for an attached session MUST be reported to loom as `LoomSystem.cancelRequested(binding, <caller session>, reason)` (a durable user cancellation of the workflow, decided by loom and the broker) before the VM is stopped. A VM crash, lost heartbeats, a breaker trip, a deadline, a bench restart or a pause MUST be reported as `LoomSystem.ended(binding, reason)` with reason `crashed`, `vm-lost`, `breaker`, `deadline` or `paused`, and MUST NOT be reported or treated as a cancellation.
- **REQ-AIDE-078** `stopAttempt(binding, mode)` MUST stop the attempt's VM (`cancel`: discard overlays not needed by a prepared effect; `fence`: a newer epoch was claimed, stop without reporting `ended`; `pause`: snapshot first and keep the snapshot ID in the attempt's last recorded observation `other:snapshot`), revoke nothing itself (the broker already revoked the attempt's roots at the claim or cancellation), and write `agent.stop{workflow, attempt, mode}`. A request for a stale binding MUST succeed idempotently.
- **REQ-AIDE-079** **Explicit auto-resume.** After an aide restart or a reboot aide MUST NOT start, resume or reattach-and-continue any ordinary session whose VM is gone; such sessions stay `Paused` until the human resumes them. aide MUST NOT start an attempt on its own: attempts are started only by `loom` (`startAttempt`), which does so after a restart only for workflows enrolled with `resume = automatic` or resumed by their owner. Pausing or stopping an ordinary session never enrolls it.
- **REQ-AIDE-080** When `AttemptHost.heartbeat` or any `AttemptHost` call fails `kl:conflict` (stale epoch) or `kl:revoked` (cancelled), aide MUST stop the attempt's VM within 1 s and stop serving its `AgentHost` (the harness's next call fails `kl:revoked`).

---

## 4. Design

### 4.1 Reading templates

1. `Depot.get(template)` → `GenerationInfo`; require `kind = "agent-template"`, `launchable`, `!revoked`; parse the manifest; require `agent.template = "/.keylos/agent/template.json"`.
2. `Depot.openPath(template, "/.keylos/agent/template.json")` on `depot#user` (protocols §7.3.8: facet `user` may open `/.keylos/agent/*` of agent templates). depot resolves the path inside the generation's own tree (no symlink escape) and returns a read-only fd of the verified store object.
3. Open `tools.json`, `policy.json` and `prompt.md` the same way, at the paths named in `template.json` (each MUST start with `/.keylos/agent/`, else `kl:invalid`). Size limits: `template.json`, `tools.json`, `policy.json` ≤ 1 MiB each; `prompt.md` ≤ 256 KiB, UTF-8.
4. Parse with JCS-canonical checks, compute the protocols §6.4 digests, compare with the pins.
5. Cache the parsed template by generation ref for the life of the aide process.

aide never parses EROFS images and never reads template files from inside a VM.

### 4.2 Session lifecycle

```
 start() ──► Queued ──capacity freed──► Provisioning ──fail──► Failed
   │            │ stop()/deadline            │ VM running, aide-guest bootstrapped
   │            ▼                            ▼
   └──────────────────────────────────────► Running ◄──resume()── Paused ◄── breaker / budget.exhausted /
   (capacity available)                       │  ▲                            human pause / VM crash / heartbeat lost
                                              │  │ continue()
                     harness finished or      ▼  │
                     human review() ──────► Reviewing ──fs.merge committed──► Merged
                                              │ discard()
                                              ▼
                                           Discarded ──fork()──► (new sibling session, start())

 any state ──stop() / deadline / template revoked / human revoked the session's tokens──► Stopped
```

| Transition | Actions |
|---|---|
| start → Queued | §4.3 step 6 failed with the VM cap (§4.15); tokens and session key already exist; `rich {"type":"state","state":"queued","position":n}` |
| Queued → Provisioning | Capacity freed; §4.3 continues from step 6 |
| start → Provisioning | §4.3 steps 1–9 |
| Provisioning → Running | `agent.start` written; `rich {"type":"state","state":"running"}` |
| Running → Paused | `Vm.snapshot("pause-<n>")`, `Vm.stop()`; stop serving `AgentHost` for the session; store the snapshot ID |
| Paused → Running | `Bench.start(VmSpec{…stored spec, fromSnapshot})` (or `Bench.project` + fork for project sessions), re-verify the template, re-bootstrap aide-guest |
| Running → Reviewing | §4.10 |
| Reviewing → Merged | Ledger `effect.commit` for every staged `fs.merge` intent |
| Reviewing → Reviewing | Result changed (late agent write, resolution, or a stale `commitShare`): new prepared merge and a new intent replace the old one (REQ-AIDE-056) |
| Merged → Running | `continue()`: the overlay now diverges from the merged tree; a new review covers only later changes |
| any → Stopped | REQ-AIDE-013 |
| (attempt) start → Provisioning | `AgentWorkflowHost.startAttempt` (§4.18); no queueing beyond §4.15 (loom sees `capacity` while queued) |
| (attempt) Running → Stopped by loom | `stopAttempt(cancel \| fence)`; `agent.stop{mode}`; for `fence` nothing is reported to loom |
| (attempt) Running → ended | VM crash, heartbeat loss, breaker, deadline → `LoomSystem.ended(reason)`; the VM is stopped; loom claims a new attempt per the activity's retry policy |
| (attempt) human stop | `LoomSystem.cancelRequested` first, then stop (REQ-AIDE-077) |

**Persisted record** `/var/lib/keylos/aide/sessions/<s-id>.json` (JCS, no secrets): `{id, parent, principal, template, human, state, created, updated, queuedAt?, vmSpec, snapshotIds, shares, rootIds, budget, sessionKeyPub, approvals, intents, merges, breakerTrips, deadline, model: {expected, observed, approval?}, desktop: {takenOver}, attempt: {workflow, attempt, epoch, step, owner}?, replay: {model, tool}?}` (`attempt` only for workflow attempts; `replay` = the next key per kind, written before each live call).

### 4.3 Start algorithm

```
start(spec) on facet user, caller = shell or atrium of human H with session chain Ch (last session h):
 0  if H starts with "guest-" ∧ !config.guestAgents: fail kl:denied               # REQ-AIDE-019
 1  T := read_template(spec.template)                                           # §4.1
 2  S := "s-" + ULID()
 3  checks := policy_checks(T.policy, spec, config)                             # §4.5
 4  offered := [Broker.attenuate(t, checks) for t in spec.grants]                # tokens held by the human's session h,
                                                                                 # narrowed offline (no delegation to S yet)
 5  key := Ed25519 keygen; Vault.store("aide/session/"+S, "git-signing", memfd(key),
           acl{actors: ["agent:"+T.gen+"@"+H+"/"+Ch+"/"+S], ops: [use], prompt: never})
    BrokerSystem.registerSessionKey(S, key.public)
 6  vm := spec.project ∧ project has project.ncl
          ? Bench.project(spec.project).fork(ForkSpec{session: S, parentSession: h, principalKind: agent})
          : Bench.start(VmSpec{image: T.benchImage, shares: build_shares(spec, T), vcpus, memoryMiB,
                               gpu: T.vm.gpu ∧ config, network: offered,
                               display: T.vm.desktop, displayMode: readOnly,
                               fromSnapshot: warm(T.benchImage),
                               session: S, parentSession: h, principalKind: agent,
                               purpose: T.vm.desktop ? agentDesktop : agent,
                               storeSet: local_model_weights(T) ∪ local_mcp_gens(T) ∪ cmd_tool_gens(T)})
    on kl:unavailable with reason "vm-cap": state := Queued; persist; return AgentSession(S)       # §4.15
    # bench registers the VM principal agent:<T.gen>@H/<Ch>/S with VmSpawn.register(VmPrincipal{session S, parentSession h,
    #   principalKind agent, template T.gen, offered}); the broker attenuates the offered tokens for S at registerSession
    #   and carves the budget sub-meter (budget_parent, GateMeterAdmin.carve); bench routes vsock 7002 to aide#host
    grantsSummary := Broker.inspect over the offered tokens (aide records what was offered; the tokens the broker
              issued for S are held by the VM principal, never by aide)
 7  wait for aide-guest's AgentHostExt.bootstrap() (≤ 30 s) → deliver AgentBootstrap (§4.4)
 8  Ledger.append(agent.start {template, version, models, placement, grantsSummary, budget, sessionKey, parent: null, vm, desktop})
 9  return AgentSession(S)
 on any failure after step 6 (other than queueing): Vm.discard() (bench unregisters the principal; broker revokes its roots);
   Vault.delete(key item); fail
```

**Project sessions** (a project with `project.ncl`, whose toolchains only bench understands): step 6 forks the project workbench with `Vm.fork(ForkSpec{session: S, parentSession: h, principalKind: agent})` (protocols §7.3.13). bench registers the fork as a new VM principal through `VmSpawn` with the source VM's offered tokens narrowed by the broker to the `agent` kind; aide then adds the template-specific read-only shares with `Vm.attachShare` (`build_shares`). Network grants beyond the fork's inherited set arrive through `GrantDelegate` on first use (§4.12).

The VM cap applies to `fork(ForkSpec)` as to `start` (queueing per §4.15).

`build_shares` (non-project VMs):
- `project`: `Share{name: "project", dir: spec.project, writable: true, overlay: true}`;
- read-only directory tokens among `spec.grants`: `Broker.materialize(token, ResourceRef.path, [read])` → dirfd → `Share{writable: false, overlay: false}`;
- nothing else (template files are delivered by aide-guest from `AgentBootstrap.templateJson` and the prompt over `AgentHost`).

### 4.4 Guest bootstrap

`aide-guest` is started by the bench-image init when the kernel command line carries `keylos.agent=1`. It:
1. Connects to host CID 2 port 7002 (capwire-vsock profile).
2. Calls `AgentHostExt.bootstrap()` and receives `AgentBootstrap`: session, principal, `templateJson`, git identity (`gitName = <template name>`, `gitEmail = <s-id>@<config git.emailDomain>`), trailers, `env` (proxy settings, `KEYLOS_AGENT_HOST=vsock:2:7002`, `KEYLOS_SESSION`), and local MCP server descriptors.
3. Installs `/etc/gitconfig` (signing with `gpg.format=ssh`, `user.signingkey` = the session key's public key, `commit.gpgsign=true`) and the `prepare-commit-msg` hook adding the trailers.
4. Starts local MCP servers from their generations (mounted by bench at `/opt/keylos/mcp/<name>`) over stdio pipes owned by the harness.
5. Launches the harness (`harness.generation` entrypoint, mounted at `/opt/keylos/harness`) with the bootstrap environment.
6. Calls `AgentHostExt.heartbeat()` every 10 s; aide treats 3 missed heartbeats as a harness crash (session `Paused`, `rich {"type":"state","state":"crashed"}`).

### 4.5 Attenuation and budget carving

`policy_checks` produces the Datalog statements aide appends to the offered tokens with `Broker.attenuate` (top-level sessions) or passes in `ForkSpec.checks` (sub-agents, §4.8):

| Source | Statements |
|---|---|
| Deadline | `check if time($t), $t <= <now + min(spec.deadlineSecs, policy.defaultDurationSecs)>;` |
| Depth / fanout | `max_depth(<policy.maxDepth>)`, `max_fanout(<policy.maxFanout>)`; `check if depth($d), $d <= <policy.maxDepth>;` |
| Tier | `tier_floor(3)` |
| Budgets | the requested budget `B = min(spec.budget, policy.budgetDefaults, config.maxBudget)` per unit, as a check on the offered tokens (top level) or in `ForkSpec.budgets` (sub-agents); broker mints the child root with `budget(unit, B)` and `budget_parent(<parent root>)` at `VmSpawn` registration, and calls `GateMeterAdmin.carve` (protocols §7.5.12) |
| Model | `model("<provider>", "<model>", "<minVersion or empty>")` per template model, so gate can detect drift (protocols §8.2) |
| Effects | `check if operation("effect", $op), resource("effect", $k), <allowed (op, k) pairs from policy.effectKinds>;` |
| Label | `label_ceiling(<config.labelCeiling, default "private">)` |

broker writes the authority facts of the child tokens (protocols §8.2). A child's budget is a **hard sub-meter**: gate charges the child account and every ancestor account on each spend, and refuses a carve that exceeds the parent's remaining amount after earlier carves (`kl:budget`, surfaced by `Vm.fork`). For the top-level session the parent root is the human's delegated budget token; for sub-agents it is the parent session's root.

### 4.6 Labels

| Source | Label raised to (via `LabelAuthority.raiseFor`) |
|---|---|
| Remote MCP result | integ `untrusted` (or `user` when the template marks the server `trust: "user"` **and** policy lists it); conf of the server (`internal` by default) |
| `keylos.human.ask` reply | integ `user`; conf unchanged |
| A file provided through `AideUser.provide` | The file's `security.bpf.keylos.label` (read with `fgetxattr`; default for its location per protocols §14.1) |
| Sub-agent results (§4.8) | The child's current label (`labelOf(child)`) |
| Model responses | No raise (model output reflects context already in the label) |
| Reads in the VM through shares | Raised by bench on virtio-fs opens |
| Network responses | Raised by gate |

aide streams `label` events by watching ledger `label.raise` receipts whose subject is the session (`Ledger.watch`, filter on `sessionId`).

### 4.7 AgentHost semantics

| Method | Semantics |
|---|---|
| `tools()` | `tools.json` content plus enabled remote MCP tools as `{name: "mcp.<server>.<tool>", kind: "mcp", inputSchema, digest}` |
| `callTool(name, argsJson, provenanceJson)` | Dispatch per §4.7.1; arguments validated against the tool's `inputSchema` (JSON Schema 2020-12) |
| `model(requestJson)` | REQ-AIDE-030/031. aide opens `Gate.connect({host, port 443, proto https, methods ["POST"]}, sessionNetToken)` on `gate#aide`; the grant is method-filtered and injected, so the socket is in gate's terminated mode: aide sends plaintext HTTP/1.1 `POST` with the body unchanged except `max_tokens` inserted when absent. Response JSON returned as-is |
| `emit(event)` | Harness-reported `message`, `toolCall`, `toolResult`, `finished`, `rich` events: recorded as **claimed** and forwarded to watchers |
| `requestGrant(reasonJson)` | `{resource, rights, reason, durationSecs}` → `BrokerSystem.annotateRequest(S, provenance)` then `BrokerSystem.requestFor(S, req, "", "grant:"+S+":"+sha256(reasonJson))`. Returns the same JCS shape as `GrantDelegate` (§4.12). Granted net tokens are handed to bench through the next `GrantDelegate` exchange or used by aide itself for host-side tools |
| `AgentHostExt.modelStream` | As `model`, returning SSE bytes as a `ByteSource` |
| `VmExec.run` | For WASI harnesses: `Vm.exec(argv, …)` with stdin/stdout/stderr pipes, ≤ 3 MiB each, timeout ≤ 600 s |
| `AgentHostExt.desktop()` | Only for `vm.desktop: true` sessions: the aide-wrapped `AgentDesktop` (§4.17); otherwise `kl:unsupported` |

#### 4.7.1 Tool routing

| Tool kind | Where it runs | Path |
|---|---|---|
| `vm` | In the VM, by the harness | No aide involvement; the harness emits toolCall/toolResult (claimed) |
| `cmd` | In the VM, from `/opt/keylos/cmd/<gen>` (store mounts by bench) | The harness converts the cmdsig (protocols §12) to an input schema; `file`/`dir` args resolve inside shares |
| `mcp` (local) | In the VM | MCP over stdio to servers started by aide-guest |
| `mcp` (remote) | Host side, by aide | MCP Streamable HTTP via `Gate.connect` with the session token; gate's `oauth-exchange` injection rule named in the template's `injection`; result labelled per §4.6 |
| `host` | Host side, by aide | §4.7.2 |

#### 4.7.2 Host tools

| Tool | Input | Behaviour |
|---|---|---|
| `keylos.effect.stage` | `{kind, target, args:[{name,value,source,label}], payloadBase64, idempotencyKey, compensator?, flowProof?}` | Payload ≤ 3 MiB (vsock message limit); larger payloads are read from the VM with `Vm.exec(["aide-guest","read-file",<path>])` streaming to a memfd (≤ 64 MiB). aide builds `EffectIntent` with `x-subject-token` = session token and `x-flow-proof` when given, calls `Gate.stage`, emits `effect`, returns `{intent, state, approval?}` |
| `keylos.effect.status` | `{intent}` | `Intent.status` via `Gate.intents(S)` |
| `keylos.grant.request` | as `requestGrant` | as `requestGrant` |
| `keylos.human.ask` | `{question, choices?, timeoutSecs?}` | Emits `rich {"type":"question","id","question","choices"}`; blocks until `AgentSession.send` answers (reply prefixed `answer:<id> `) or the timeout (default 3 600 s) |
| `keylos.subagent.spawn` | `{template?, task, checks?:[…], budget:[…], deadlineSecs}` | §4.8 |
| `keylos.subagent.status` / `wait` / `result` | `{session}` | Child state, wait for finish, result per §4.8 |
| `keylos.powerbox.open` | `{title, mimeTypes, kind: "file"\|"directory"}` | Emits `rich {"type":"grant","outcome":"pending","resource":"powerbox","title"}`. The human answers with `aide provide <s-id> <file>` or `aide provide <s-id> --dir <dir>` (the shell opens what the human typed and passes the fd; `AideUser.provide`). aide raises the label (§4.6). A **file** is written into the VM at `/run/keylos/aide/inbox/<name>` with `Vm.exec(["aide-guest","write-file",…])`. A **directory** is hot-plugged read-only with `Vm.attachShare(Share{name: "inbox-<n>", dir, writable: false, overlay: false})` (protocols §7.3.13) and appears at `/shares/inbox-<n>`; `--rw` makes it a writable overlay share that reaches the real tree only through review. Returns `{path}` |
| `keylos.screen.window` | `{reason}` | The only real-session observation (protocols §14.5). aide calls `BrokerSystem.requestFor(S, GrantRequest{resource: {effect: "screen.window.snapshot"}, rights: [use], reason}, "", "screen:"+S+":"+n)`; the T3 prompt asks the human to pick **one** window on the trusted path. The human captures it with atrium's screenshot tool and answers with `aide provide <s-id> <png>`; aide raises the session label to the image's label and writes it to the inbox. One still per approval; no continuous capture exists |
| `keylos.desktop.status` | `{}` | For agent desktops: watchers and whether the human has taken over |
| `keylos.config.propose` | `{}` | REQ-AIDE-053; returns `{plan: Plan.diff(), capabilityChanges: Plan.capabilityChanges()}` |
| `keylos.labels.current` | `{}` | `LabelAuthority.labelOf(S)` |

### 4.8 Sub-agents

1. Input: parent session P, task, narrowing checks, budget B'. A sub-agent runs P's template: `ForkSpec` carries no template (protocols §7.3.13), so a sub-agent with a different template is not supported in 1.0 (`kl:unsupported`).
2. Checks: P's remaining depth > 0 (`Broker.inspect` facts), P's live children < `max_fanout`, B' ≤ P's remaining (`Gate.meter`).
3. `checks := narrowing ∪ {check if time($t), $t <= P.expires} ∪ depth decrement`; `budgets := [B']`.
4. VM: `P.vm.fork(ForkSpec{session: C, parentSession: P, principalKind: agent, offered: [], checks, budgets})` (inherits P's overlay at fork time); bench registers `agent:…/P/C` with `VmPrincipal.checks`/`budgets` and the broker issues C's tokens attenuated from P's VM principal tokens. A child fork that hits the VM cap queues like any session (§4.15) and counts against the parent's deadline.
5. Results: `keylos.subagent.result` returns `{summary, diff}` where `diff` is `BenchMerge.render(C, share, snapshot)` of the child's overlay (unified diff, ≤ 3 MiB inline, else written into P's VM at `/run/keylos/aide/children/<C>.diff`). Before returning, aide raises P's label to C's label. The parent harness applies the diff inside its own overlay (an ordinary VM write). No privileged merge exists for children.
6. The child is stopped when the parent stops, deadlines expire, or the parent's tokens are revoked.

### 4.9 Velocity breakers

| Breaker | Default (`policy.breakers`) | Measured from |
|---|---|---|
| Identical calls | > 5 per 60 s with the same `(name, sha256(argsJson))` | callTool, claimed toolCall |
| Tool call rate | > 600 per hour | callTool + claimed toolCalls |
| Errors in a row | > 20 | toolResult with `isError` |
| Spend rate | > 10% of a budget ceiling per minute | `Gate.meter` deltas (polled every 10 s) |
| Context growth | model request body grows > 2 MB versus the previous call | `model` |
| Sub-agent storm | > `max_fanout` spawn attempts per 10 min | spawn tool |

On a trip: pause the subtree bottom-up (§4.2), emit `rich {"type":"breaker","name","value","threshold"}`, `TrustedPrompt.notify` (warning), record `breakerTrips`. Resume: `AgentSession.send` from the human or `aide resume`.

### 4.10 Review and merge

1. For each writable overlay share `sh`: `(manifestJson, digest, snapshot, prepared) := BenchMerge.manifest(S, sh)`; `diff := BenchMerge.render(S, sh, snapshot)` (used for the change summary). `manifestJson` is the `keylos.fsmerge/2` manifest of the strata prepared merge `prepared`; strata already applied clean automatic merges against the live tree inside it, so the rendering shows the exact content that would be committed. For sealed agent workspaces (`u-agent-<session>`, strata §4.7.1) the transaction uses strata's unitfs backend (strata §4.5.10); nothing changes for aide.
2. Stage:

```
EffectIntent{kind: "fs.merge", class: compensable, target: "fs:<display path of the share target>",
  args: [{name: "share", value: sh, source: "aide", label: labelOf(S)},
         {name: "changes", value: "<N files, +A −D>", source: "aide", label: labelOf(S)},
         {name: "x-subject-token", value: <base64 session token>, source: "aide", label: labelOf(S)}],
  idempotencyKey: "fs.merge:" + S + ":" + prepared, compensator: "fs.undo", payload: memfd(manifestJson)}
```

   via `Gate.stage` on `gate#aide`. Policy makes agent overlay merges T3; gate renders the prompt (file list, diff, session label history, committed effects, budget used).
3. `AgentSession.review` returns `"<intent id>[,…]"`; the human approves on the trusted path (presence as policy requires). gate's executor calls `BenchMerge.commitShare(S, sh, digest, mandate)`; bench commits exactly the prepared merge (`PreparedMerge.commit`: writer fence, revalidation, stored operations only). A `kl:conflict` (stale prepared merge) fails the intent; aide re-runs steps 1–3 with a new prepared merge and a new approval (REQ-AIDE-056).
4. On the ledger `effect.commit` for the intent, aide writes `agent.merge {intent, share, transaction, undoSnapshot, files}` (transaction and undo snapshot from the `effect.commit` receipt data).
5. Undo is human-performed: `strata undo <x-id>`; `aide undo <s-id>` prints that command.
6. Conflicts (the real tree changed since session start in ways strata cannot merge cleanly) make `manifest` fail `kl:conflict` with the conflict list; the human can stage a merge of the non-conflicting subset (`aide review <s-id> --only-clean`, which keeps the live version of every conflicting path in the prepared merge) or resolve inside the workbench. Agent writes after step 1 are never part of the staged merge.

### 4.11 Flow proofs (camel/1)

- The harness is a WASI 0.3 component run by `aide-wasi` (Wasmtime with the Pulley interpreter, fuel and 512 MiB memory limits, no filesystem or network imports). Its imports are the aide host tools, `VmExec`, model calls and `sign`.
- `sign` is implemented with `Vault.sign("aide/session/<S>", "ed25519", pae)`; the key never enters `aide-wasi` memory.
- The component's interpreter produces `keylos.flowproof/1` documents (protocols §20.11); aide wraps them in DSSE and attaches them to staged intents as `x-flow-proof`.
- Acceptance is decided by broker (`checkFlow`); aide does not judge proofs.

### 4.12 GrantDelegate (bench callbacks)

bench calls `GrantDelegate.request(vmSession, kind, detailJson, reason)` on `aide#grant-delegate` when an agent VM needs authority it lacks:

| `kind` | `detailJson` | aide behaviour |
|---|---|---|
| `net` | `{host, port, proto}` | If the session's delegated tokens already cover the target (project-fork sessions, step 4 above), return `granted` with that token and no prompt. Otherwise deny if the template policy forbids new hosts (`policy.effectKinds` has no egress kinds and config `askForHosts = false`); else `requestFor(S, GrantRequest{net}, "", "gd-net:"+S+":"+host+":"+port)` with reason "Agent wants <host>" |
| `share` | `{path}` | Always denied: agents get directories only at start or through `keylos.powerbox.open` |
| other | — | Denied with reason `unsupported` |

**Outcome JSON** (JCS, exactly protocols §7.5.10):

```json
{"outcome":"granted","token":"<base64 Biscuit>","approval":null,"reason":"granted by policy"}
{"outcome":"pending","token":null,"approval":"a-01JB…","reason":"waiting for the human"}
{"outcome":"denied","token":null,"approval":null,"reason":"template policy forbids new hosts"}
```

All four keys are always present. For `pending`, bench retries the same request after the approval resolves; aide answers from broker's deduplicated result (same idempotency key) with the final outcome.

Every decision emits `rich {"type":"grant","outcome","resource"}`.

### 4.13 Model providers and MCP

- **Remote models:** §4.7; credentials injected by gate (rule `principals: ["agent:*"]`); usage metered by gate.
- **Local models:** the runtime generation runs inside the VM with `gpu = true`; the harness talks to it on guest localhost; GPU minutes charged per REQ-AIDE-032.
- **Remote MCP:** MCP Streamable HTTP (revisions 2025-11-25 and 2026-07-28) through `Gate.connect`; authorization by gate's `oauth-exchange` (RFC 8693, RFC 8707 audience binding); on first connection aide fetches `tools/list` and checks `toolsDigest` (REQ-AIDE-002); prompts and resources are fetched only on explicit harness calls and labelled like tool results.

### 4.14 Observed versus claimed

Every session keeps two logs in `/var/lib/keylos/aide/events/<s-id>.cbor` (CBOR sequence, encrypted with `Vault.dataKey("aide:<s-id>")`):
- **observed:** facts aide or the ledger witnessed — host tool calls, gate receipts (`net.connect`, `effect.*`, `budget.*`), broker grants, merges;
- **claimed:** harness `emit`s.

A discrepancy (for example a claimed "no network" while gate shows connections) emits `rich {"type":"discrepancy","claimed","observed"}`. The review prompt and `aide log` show observed facts first.

### 4.15 Queueing at the VM cap

- bench admits VMs per the machine's RAM class (protocols §2.3: `small` 2, `medium` 6, `large` 16 concurrent VMs). When `Bench.start` fails with `kl:unavailable` whose reason contains `vm-cap`, aide puts the session into `Queued`.
- **Order:** one FIFO per human; aide serves humans round-robin. Sub-agents queue behind their own human's earlier sessions; a parent that is `Queued` cannot have running children.
- **Wake-up:** aide watches ledger `vm.stop`/`vm.discard` receipts and also retries every 5 s; on each opportunity it starts the head of the next human's queue (§4.3 from step 6).
- **Limits:** at most `queue.maxPerHuman` (default 8) queued sessions per human; beyond that `Aide.start` fails with `kl:unavailable`. Deadlines keep running while queued (REQ-AIDE-016).
- **Visibility:** `rich {"type":"state","state":"queued","position":n,"ahead":m}` on every position change; `aide ls` shows `queued(n)`.

### 4.16 Model drift

1. aide puts `model(provider, model, minVersion)` facts into the session tokens (§4.5); for local models the weights generation pins the identity and no fact is needed.
2. gate records the provider-reported identity in every `budget.charge` receipt and, on a mismatch, requests a `model.change` approval for the session and escalates its T1 actions to T2 (gate spec; protocols §14.5).
3. aide watches `budget.charge` receipts for its sessions. On the first receipt with `data.drift` for a session it writes `model.change {session, provider, expected, observed, approval}`, emits `rich {"type":"modelChange","provider","expected","observed","approval"}` and notifies the human (`TrustedPrompt.notify`, warning).
4. The approval is the one gate requested (`ResourceRef.model = "<provider>/<model>@<version>"`, right `use`, Cedar entity `Model`, T2 by default policy; protocols §7.3.3, §16). When it is granted, gate clears the escalation; aide emits `rich {"type":"modelChange","approved":true}`. When denied, the session stays escalated; aide offers `aide stop`.
5. The harness sees model calls fail with `kl:needs-approval` while escalated; the reference harness waits and retries.

### 4.17 Agent desktops (computer use)

```
harness ──AgentHostExt.desktop()──► aide wrapper ──► AgentDesktop (bench, Vm.desktop()) ──► nested atrium in the VM
human   ──AgentSession.takeOver(interactive) (atrium button, or aide desktop --take-over|--release)──► aide ──► Vm.takeOver(interactive)
          mirror window drawn by atrium (readOnly until taken over)
```

- The VM is started with purpose `agentDesktop`, `display = true`, `displayMode = readOnly`: atrium shows a read-only mirror window with a tier-3 border labelled with the agent session.
- The wrapper aide hands to the harness forwards `screenshot`, `input`, `a11yTree`, `launch`, `status` to bench's `AgentDesktop` with these additions:
  - `input` is refused (`kl:denied`) while `status().takenOver` is true (REQ-AIDE-047);
  - rate limits: `screenshot` ≤ 4 per second, `input` ≤ 50 events per second, `a11yTree` ≤ 2 per second;
  - every call is recorded in the observed log (REQ-AIDE-048) and counted by the velocity breakers (§4.9).
- Content reaches the nested desktop only through the VM's shares and its gate-mediated network; it leaves only through effects (protocols §14.5). The nested desktop has no clipboard, screen or input path to the host session.
- Take-over: the human calls `AgentSession.takeOver(true)` (atrium's "Take over" button on facet `aide#user`, or `aide desktop <s-id> --take-over`); aide checks that the caller is the session's human (a `shell` or atrium of H) and relays it to `Vm.takeOver(true)`; the mirror becomes interactive for the human. `takeOver(false)` (or `--release`) hands input back. On a session that is not an agent desktop it fails `kl:unsupported`.

### 4.18 Agent sessions as workflow attempts

```
startAttempt(b, template, task, input, label) on facet loom:
 1  BrokerWorkflow.verify(b, "") ?→ kl:conflict | kl:revoked
 2  T := read_template(template)                                              # §4.1, pins verified
 3  host := LoomSystem.attempt(b, "")                                         # AttemptHost of this attempt (task, recorded, record, …)
 4  offer := BrokerWorkflow.offer(b)                                          # path/net tokens on aide's session, ≤ 120 s
    shares := build_shares from offer (project path as overlay share; read-only paths)        # §4.3
 5  S := "s-" + ULID(); session key as §4.3 step 5 (ACL actor agent:<T.gen>@<b.owner>/<aide session>/S)
 6  vm := Bench.start(VmSpec{…as §4.3, network: net tokens of offer, session: S, parentSession: <aide session>,
                             principalKind: agent, attempt: b})
       # bench → VmSpawn.register(VmPrincipal{attempt: b}) → BrokerSystem.registerSession{attempt: b}:
       # the broker restores the workflow label, mints S's tokens from the workflow record (workflow, budget_account facts)
    drop offer tokens
 7  bootstrap aide-guest (§4.4) with task + input; record attempt binding in the session record
 8  agent.start {…, workflow: b.workflow, attempt: b.attempt, epoch: b.epoch, step: b.step}; return S
```

**Recording and replay.** aide keeps per attempt the counters `model` and `tool`. For each harness call of that kind with request bytes q:

```
k := "<kind>:" + counter; counter += 1; persist counter in the session record
(found, obs) := host.recorded(k)
found ∧ obs.request == sha256(q) ∧ !live[kind]   → raiseFor(S, obs.label); return obs.body          # replay
otherwise                                         → live[kind] := true
     r := live call (gate connect / MCP / host tool)
     host.record(Observation{kind, key: k, request: sha256(q), body: r, label: label(r)})       # acknowledged first
     return r
```

The first attempt of a step has nothing recorded and is live from the start. A replayed session continues the agent's work from the last recorded response: the harness re-sends its requests, receives the identical recorded responses, and reaches the first unrecorded request, which goes live. Tool calls inside the VM (`vm`, `cmd`, local MCP) are not recorded by aide; their effect on the overlay is preserved by the overlay snapshot the previous attempt left (`pause`) or recomputed by the harness.

**Results and effects.** When the harness finishes (`emit(finished)`) aide performs REQ-AIDE-076 for every declared effect, then `host.complete(result, labelOf(S))`, where the result is JCS `{summary, effects: {<name>: {effect: "fx-…", prepared: "pm-…", digest}}, snapshot}`, and stops the VM. A harness that reports failure leads to `host.fail(error, retryable)`.

**Ends and cancellation.** §4.2 transitions for attempts; REQ-AIDE-077. aide sends `AttemptHost.heartbeat` every 10 s for each running attempt and applies REQ-AIDE-080 on `kl:conflict`/`kl:revoked`.

**After an aide restart.** Attempt sessions whose VMs survived are reattached (`Bench.reattach`) and their `AttemptHost` re-obtained with `LoomSystem.attempt`; a stale binding stops them (REQ-AIDE-080). Attempt sessions whose VMs are gone are reported with `LoomSystem.ended(b, "vm-lost")`; aide starts nothing new on its own (REQ-AIDE-079).

---

## 5. Interfaces

### 5.1 Facets served

| Facet | Holders | Interfaces |
|---|---|---|
| `user` | human `shell`s, atrium | `Aide` limited to the caller's human; `AideUser` via `Extensible.ext` |
| `host` | one per agent VM (vsock 7002 forward by bench-relay) | `AgentHost`, `AgentHostExt` (including `desktop`), `VmExec`, bound to that VM's session |
| `admin` | owner `shell` | `Aide` for all humans (read); `AideAdmin` |
| `grant-delegate` | bench | `GrantDelegate` |
| `loom` | loom | `AgentWorkflowHost` (§4.18) |

`AgentEvent.rich` types (JCS JSON, protocols §7.3.14):

| `type` | Fields |
|---|---|
| `state` | `state` (`queued`, `running`, `paused`, `crashed`, `reviewing`, `merged`, `stopped`), `detail`, `position?`, `ahead?` |
| `question` | `id`, `question`, `choices` |
| `breaker` | `name`, `value`, `threshold` |
| `mcpPinMismatch` | `server`, `expected`, `actual` |
| `discrepancy` | `claimed`, `observed` |
| `grant` | `outcome`, `resource`, `title?` |
| `modelChange` | `provider`, `expected`, `observed`, `approval`, `approved?` |
| `desktop` | `takenOver`, `watchers` |

### 5.2 CLI: `aide`

| Command | Description | Exit codes |
|---|---|---|
| `aide start <template> [--project DIR] [--ro DIR]… [--task TEXT \| --task-file F] [--grant SPEC]… [--budget unit:amount]… [--deadline DUR] [--attach]` | Starts a session; `DIR` arguments are opened by the shell (powerbox) and passed as fds; `--grant` uses kish grant syntax | 0 (prints the session ID), 4 denied, 2 error |
| `aide ls [--all]` | Records: id, template, state, label, spent, created | 0 |
| `aide attach <s-id>` | Streams events; stdin lines are sent as messages | 0, 130 |
| `aide send <s-id> <text>` | | 0, 1 |
| `aide provide <s-id> <file> [--name N]` / `aide provide <s-id> --dir <dir> [--rw]` | Answers a powerbox request (files copied to the inbox; directories hot-plugged as shares) | 0, 1 |
| `aide desktop <s-id> [--take-over \| --release]` | Opens the read-only mirror of an agent desktop; take over or release input | 0, 1 not a desktop session |
| `aide queue` | Queued sessions with positions | 0 |
| `aide changes <s-id>` | Change summary per share | 0 |
| `aide review <s-id> [--only-clean]` | Stages merge intents; waits for the decision | 0 merged, 3 pending, 4 denied |
| `aide discard <s-id>` | Discards overlays | 0 |
| `aide undo <s-id>` | Prints the `strata undo` command for the last merge | 0 |
| `aide fork <s-id>` | | 0 |
| `aide pause <s-id>` / `aide resume <s-id>` / `aide stop <s-id>` | | 0 |
| `aide budget <s-id>` | Spent, reserved, remaining | 0 |
| `aide effects <s-id>` | Intents of the session | 0 |
| `aide log <s-id> [--observed\|--claimed\|--receipts]` | Session log | 0 |
| `aide templates` | Installed agent templates | 0 |
| `aide attempts [--workflow wf-…]` | Agent sessions that are workflow attempts: session, workflow, attempt, epoch, step, state | 0 |
| `aide verify <template>` | All pinned digests including a live remote MCP fetch | 0 ok, 6 mismatch |

All commands accept `--format text|json|records`.

### 5.3 Files

| Path | Purpose |
|---|---|
| `/var/lib/keylos/aide/sessions/<s-id>.json` | Session record |
| `/var/lib/keylos/aide/events/<s-id>.cbor` | Encrypted event logs |
| `/etc/keylos/aide/aide.json` | Rendered config |
| Guest `/run/keylos/aide/` | aide-guest state, hooks, inbox, child diffs |

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| Prompt-injected agent acts beyond its task | Authority is only delegated tokens; effects staged at gate; Rule of Two via broker; T3 merge |
| Escape through harness config, hooks or symlinks read by host code | Nothing in the VM is read by host code as configuration. aide reads only the pinned template from depot; overlays are handled only by bench as data; aide never resolves guest paths on the host |
| Tool or MCP rug-pull | Digest pinning (REQ-AIDE-002); changed tools need a new template generation and consent |
| Sub-agent escalation | Delegation only narrows; depth, fanout and budget carving; children never merge |
| Runaway cost | Hard budgets at gate; breakers |
| Forged harness events | Claimed vs observed (§4.14) |
| Malicious template | Templates are signed generations, capability-diffed at install, pinned; they cannot grant authority |
| aide compromise | aide cannot mint authority beyond the human's delegated tokens, cannot sign mandates, cannot merge without a T3 mandate verified by gate and bench |
| Session key misuse | Ephemeral vault item usable only for commit/tag signatures and flow proofs, deleted at session end; public key in `agent.start` |
| Credential exposure | Provider keys and MCP tokens are injected by gate; aide never holds them |
| Hostile guest input to aide | All `AgentHost` inputs are size-limited and schema-validated; capwire-vsock rejects fds; fuzzed (§11.2) |
| Computer-use agent watches or drives the human's real session | No path exists: the agent drives only a nested desktop in its own VM; real-session stills need a T3 approval per image (§4.17, REQ-AIDE-046) |
| Agent keeps acting while the human controls its desktop | `input` refused while taken over (REQ-AIDE-047) |
| Provider swaps the model under a running session | gate escalates the session; aide surfaces `model.change` and the re-approval (§4.16) |
| Sub-agent fan-out amplifies spend | Hard sub-meters carved by broker and enforced by gate (§4.5) |
| Queue flooding by one human | Per-human queue cap and round-robin service (§4.15) |
| A paused or crashed session silently keeps running in the background after a reboot | Only workflow attempts are restarted, only by loom, only for workflows enrolled with automatic resume (REQ-AIDE-079) |
| A fresh attempt restarts at a clean label after reading private or untrusted data | The broker restores the workflow label at registration; replayed observations raise to their recorded labels (REQ-AIDE-074) |
| Replay feeds a model response that was never really received | Observations are written by aide only from live responses and served only for an equal request digest |
| A stale attempt keeps acting after a newer claim | Its roots are revoked at the claim; `AttemptHost` refuses it; aide stops it (REQ-AIDE-080) |
| A VM crash is mistaken for the human cancelling (or the reverse) | Separate paths: `cancelRequested` only from the human's `AgentSession.stop`, `ended` for every other end (REQ-AIDE-077) |

### 6.2 Residual risks

- Injection inside granted authority remains: an injected agent can still write wrong code into its overlay. Review is the backstop.
- Approval fatigue at T3 merges, mitigated by rendering effects and provenance.
- Claimed events can be fabricated by a compromised harness; only observed events are authoritative.
- A computer-use agent can still misuse whatever it can reach inside its own nested desktop (its shares and granted hosts).

### 6.3 Confinement of aide itself

| Aspect | `aide` | `aide-wasi` |
|---|---|---|
| Tier | t0 | t0 (one process per WASI session) |
| Network namespace | private, `lo` only | private |
| Capabilities | none | none |
| Landlock | rw `/var/lib/keylos/aide`; ro own generation | ro own generation |
| JIT | no | no (Pulley interpreter) |
| Routes | §2.2 | aide only |

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| aide restart | VMs keep running; aide-guest reconnects (0.5 s → 10 s backoff); sessions reload; pending approvals are re-attached through `Gate.intents(S)` |
| bench restart | bench stops every VM (protocols §7.3.13); sessions go `Paused` with their last snapshot and resume through `start` from that snapshot when the human resumes them |
| aide restart with running VMs | `Bench.reattach(S)` per session (REQ-AIDE-015); a session whose VM is gone goes `Paused` |
| gate unavailable | `model`, staging and remote MCP fail `kl:unavailable`; the harness retries; breakers count errors |
| broker unavailable | No new sessions, sub-agents or grants; existing tokens keep working until expiry |
| Remote MCP server down | Tool calls return error results |
| Budget exhausted | Session `Paused` (budget); raising needs a T3 approval (`aide budget <s> --raise unit:amount` → `requestFor` with a budget resource) |
| VM crash | Session `Paused` with the last snapshot (bench snapshots every 10 min and at each review) |
| Template revoked mid-session | aide stops the session, keeps overlays, notifies the human |
| aide-guest heartbeat lost | Session `Paused`, `state: crashed` |
| aide restart with queued sessions | Queue order restored from session records (`queuedAt`); wake-up resumes |
| bench refuses because of the VM cap | Session `Queued` (§4.15), not failed |
| Model drift detected | Session escalated by gate; aide keeps it running and waits for the human (§4.16) |
| loom unavailable during an attempt | `AttemptHost.record` fails, so model and tool calls fail `kl:unavailable` (REQ-AIDE-073); after 60 s without loom aide pauses the VM (snapshot) and reports `ended(paused)` when loom returns |
| Attempt fenced or workflow cancelled | VM stopped within 1 s (REQ-AIDE-080) |
| Reboot with attempt sessions | VMs are gone; loom claims new attempts (automatic resume) or waits for the owner; aide reports `vm-lost` for any record it finds |

---

## 8. Performance budgets

| Metric | Budget |
|---|---|
| `Aide.start` → harness running (warm snapshot) | ≤ 1.5 s p50, ≤ 4 s p99 |
| `callTool` overhead for host tools | ≤ 2 ms p99 |
| `model` added latency over a direct gate connection | ≤ 3 ms p50 |
| Concurrent sessions per host | ≥ 32 (bounded by RAM) |
| `review` manifest computation | ≤ 2 s for 10 000 changed files |
| aide RSS | ≤ 128 MiB + 1 MiB per active session |
| Queued → Provisioning after capacity frees | ≤ 1 s (ledger watch) or ≤ 5 s (polling fallback) |
| `AgentDesktop` relay overhead | ≤ 2 ms per call excluding the screenshot encode |

---

## 9. Observability

**Receipts** (protocols §19.3, writer `aide`):

| Event | `data` |
|---|---|
| `agent.start` | `{template, version, models, placement, grants, budget, sessionKey, parent, vm}`, plus `{workflow, attempt, epoch, step}` for attempts |
| `agent.stop` | `{reason, spent, intents, merges, breakerTrips, durationSecs}`, plus `{workflow, attempt, mode}` for attempts (`mode` `cancel`, `fence`, `pause`, `ended`) |
| `agent.merge` | `{intent, share, transaction, undoSnapshot, files}` |
| `model.change` | `{session, provider, expected, observed, approval}` |

**Logs:** session state transitions (info), breaker trips (warning), pin mismatches (warning), guest connection errors (notice).

**Metrics** (`0x1F` records): `aide_sessions{state}`, `aide_queue_depth`, `aide_queue_wait_seconds`, `aide_tool_calls_total{kind}`, `aide_model_calls_total{provider}`, `aide_model_drift_total`, `aide_desktop_calls_total{method}`, `aide_breaker_trips_total{breaker}`, `aide_merge_total{result}`, `aide_session_start_seconds`.

---

## 10. Configuration

```nickel
# module keylos.aide → /etc/keylos/aide/aide.json
{
  aide | {
    maxConcurrentSessions | Number | default = 16,
    vmCaps | { vcpus | Number | default = 8, memoryMiB | Number | default = 16384, gpu | Bool | default = true } | default = {},
    defaultBudget | Array String | default = ["usd-micro:5000000", "tokens:4000000", "calls:2000"],
    maxBudget | Array String | default = ["usd-micro:100000000"],
    retainOverlayDays | Number | default = 14,
    localGpuPriceUsdMicroPerMinute | Number | default = 0,
    templatesAllowed | Array String | default = ["*"],
    askForHosts | Bool | default = true,                          # GrantDelegate net requests go to the human
    labelCeiling | [| 'internal, 'private, 'secret |] | default = 'private,
    git | { emailDomain | String | default = "agents.invalid" } | default = {},
    guestAgents | Bool | default = false,                       # rendered from hearth.guest.agents
    queue | { maxPerHuman | Number | default = 8, pollSeconds | Number | default = 5 } | default = {},
    desktop | { screenshotsPerSecond | Number | default = 4, inputEventsPerSecond | Number | default = 50,
                a11yPerSecond | Number | default = 2 } | default = {},
  }
}
```

**Default policy** (Cedar, shipped by the distribution in the `policy` generation):

```cedar
@tier("t3")
permit (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { principal.kind == "agent" && resource.kind == "fs.merge" };

forbid (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { principal.kind == "agent" && resource.class == "irreversible" && context.approvalTier != "t3" };

@tier("t2")
permit (principal, action == Keylos::Action::"use", resource is Keylos::Model)
when { principal.kind == "agent" };                         // model re-approval after drift (protocols §14.5)

@tier("t3")
permit (principal, action == Keylos::Action::"use", resource is Keylos::Effect)
when { principal.kind == "agent" && resource.kind == "screen.window.snapshot" };
```

---

## 11. Testing and acceptance

### 11.1 Unit

- Template parsing and pinning per protocols §6.4 (vectors `manifest/` agent cases).
- Tool-schema generation from cmdsig.
- Breakers with a simulated clock; budget carving arithmetic.
- State machine property tests: every termination writes `agent.stop`; no path merges without `effect.commit`.
- Replay engine: key sequencing, digest mismatch switches to live, label raise before delivery, no response delivered before its record is acknowledged; `ended` versus `cancelRequested` classification for every end cause.

### 11.2 Fuzz

`fuzz_template_json`, `fuzz_tools_json`, `fuzz_mcp_tools_list`, `fuzz_agent_event_cbor`, `fuzz_harness_rpc` (hostile `AgentHost` inputs over capwire-vsock), `fuzz_desktop_input_json` (hostile `AgentDesktop.input` event lists).

### 11.3 Integration (real bench, gate, broker, vault, ledger in nested KVM; fake model providers)

| ID | Scenario | Expected |
|---|---|---|
| AT-1 | Coder template on a git repo; agent edits and runs tests | Real tree unchanged until review; approve with presence → merged; `agent.merge`; `strata undo` restores |
| AT-2 | Agent reads a private file (P) and a web page (U), then stages `email.send` | `checkFlow` declassification + irreversible → T3 with mandate; nothing sent without approval |
| AT-3 | MCP server changes a tool description after pinning | Tools disabled; `mcpPinMismatch`; non-optional → `kl:integrity` |
| AT-4 | 6 sub-agents with `max_fanout = 4` | Fifth refused; storm breaker trips |
| AT-5 | Sub-agent budget > parent remaining | `kl:budget` |
| AT-6 | Agent loops on one tool | Paused after 5 calls/60 s; `aide resume` continues |
| AT-7 | Guest writes settings-like files, host-pointing symlinks, a crafted `.git` | No host code reads them; merge treats them as content; symlinks stay symlinks |
| AT-8 | Kill aide mid-session | Session reattaches; events continue; pending approval still valid |
| AT-9 | `git commit` in the guest | Trailers present; signature verifies with the `agent.start` key; after stop signing fails |
| AT-10 | camel/1 WASI harness sends email (recipient from user, body from web) | Flow proof attached; declassification waived by broker; mandate still required |
| AT-11 | Guest connects to an ungranted host | bench → `GrantDelegate`; with `askForHosts` the human sees a T2 prompt; granted token used by bench-net |
| AT-12 | `keylos.powerbox.open` + `aide provide` | File appears in the guest inbox; session label raised to the file's label |
| AT-13 | Agent edits the config repo; merge; `keylos.config.propose` | Plan returned with origin = agent; `Plan.apply` impossible from aide |
| AT-14 | Child sub-agent result | Parent label raised to child label; diff applied inside the parent overlay only |
| AT-15 | `small` RAM class with 2 running VMs; start a third session | Session `Queued(1)`; stopping one VM starts it within 1 s; its deadline counted from start |
| AT-16 | Start a session; inspect the VM principal | `agent:<tpl>@alice/<alice chain>/S`; a sub-agent VM is `…/S/C` |
| AT-17 | Fake provider changes the reported model mid-session | `model.change` receipt and rich event; model calls fail `kl:needs-approval` until the human approves; then succeed |
| AT-18 | `vm.desktop` template: harness takes screenshots and clicks; human takes over | Calls work in the nested desktop; after take-over `input` → `kl:denied`; release restores; no host-session capture possible |
| AT-19 | `keylos.screen.window` | T3 prompt; the human provides one PNG; a second still needs a new approval |
| AT-20 | `keylos.powerbox.open` with a directory | Hot-plugged read-only share appears at `/shares/inbox-1`; writes fail; `--rw` makes it an overlay reviewed at merge |
| AT-21 | Guest human starts an agent with `guestAgents = false` | `kl:denied` |
| AT-22 | Sub-agent budgets: parent 5 USD, two children of 3 USD | Second carve → `kl:budget`; a child's spend reduces the parent's remaining |
| AT-23 | `GrantDelegate` for an ungranted host | JCS with all four keys; pending then granted after the human approves |
| AT-24 | Atrium "Take over" on an agent-desktop session; harness sends input; release | `AgentSession.takeOver(true)` relays to `Vm.takeOver`; harness `input` → `kl:denied`; after `takeOver(false)` input works; another human's shell → `kl:denied` |
| AT-25 | Restart aide with two running sessions; restart bench with one running | aide: `Bench.reattach` gives new `Vm` capabilities, `review` works; bench restart: session `Paused`, resumes from its snapshot |
| AT-26 | Project session start | VM created by `fork(ForkSpec{session S, parentSession h, agent})`; principal is `agent:<T>@H/<Ch>/S`; no token was delegated to S before `VmSpawn.register` (broker receipts show the grant issued at registration) |
| AT-27 | Model drift | Approval request carries `ResourceRef.model`; Cedar permit on `Model` at T2 applies; `model.change` receipt written |
| AT-28 | `keylos.subagent.spawn` with checks `[read-only paths]` and budget usd-micro 1000000 | `Vm.fork` called with `ForkSpec{offered: [], checks, budgets}`; no `Broker.delegate`/`attenuate` call by aide; the child's tokens carry the checks and `budget_parent`; a budget above the parent's remaining fails the fork with `kl:budget` |
| AT-30 | Workflow agent attempt: kill the VM after 3 recorded model responses, during the 4th model call | loom claims a new attempt; aide replays the 3 recorded responses (no provider requests, no budget charge), the 4th goes live; observed log shows replay keys; one charge per live response |
| AT-31 | Attempt: the human runs `aide stop` on the attached session; separately, crash another attempt's VM | First: `LoomSystem.cancelRequested` → the workflow becomes `cancelled`, no new attempt; second: `LoomSystem.ended(crashed)` → loom retries per the activity's retry policy, the workflow is not cancelled |
| AT-32 | Workflow enrolled with automatic resume and an attempt that read a `private/untrusted` file; reboot the machine | A new attempt runs under a new session with new tokens (old tokens rejected by gate and broker); its label is `private/untrusted` from registration; an ordinary paused session of the same human stays `Paused` |
| AT-33 | Attempt finishes with a `merge` effect | `bindWorkflow` called; `DurableEffects.prepare` on `gate#aide` with the attempt token (no `Gate.stage`); the result carries `fx-…` and `pm-…`; aide never calls `commit` |
| AT-34 | loom claims a newer epoch while an attempt runs | The old attempt's `heartbeat` fails `kl:conflict`; its VM stops within 1 s; its harness calls fail `kl:revoked` |
| AT-29 | Review; the agent writes another file; a host edit changes a merged file after approval | The first intent is replaced by a new prepared merge, digest and approval (REQ-AIDE-056); the approved digest commits only its own content; after the host edit `commitShare` fails `kl:conflict` and aide stages a fresh intent; no mandate is reused |

### 11.4 Acceptance criteria

AT-1…AT-23 and AT-29…AT-34 pass (AT-30…AT-34 with real `loom`, protocols §17 INV-8…INV-11); §8 budgets met; zero fuzz crashes.

---

## 12. Implementation notes

| Crate | Use |
|---|---|
| `tokio` 1.x, `keylos-capwire`, `keylos-schemas`, `keylos-biscuit`, `keylos-labels`, `keylos-formats` | |
| `wasmtime` (component model, WASI 0.3, Pulley interpreter) | `aide-wasi` |
| `rmcp` (Rust MCP SDK) or an in-repo client over hyper | Remote MCP |
| `jsonschema` 0.2x | Tool input validation |
| `ed25519-dalek` 2.x, `ssh-key` 0.6 | Session keys (stored as OpenSSH Ed25519 private keys in vault) |
| `serde_json`, `ciborium` | |


**Repository layout:**

```
aide/
  crates/aide/                  service: Aide, AgentSession, AgentHost, GrantDelegate servers; session manager; breakers
  crates/aide-wasi/             WASI harness host (camel/1)
  crates/aide-guest/            guest agent (static musl)
  crates/aide-cli/
  crates/keylos-agent-harness/  SDK: AgentHost client, tool helpers, provenance and flow-proof builders
  harness/coder/                reference harness → generation
  templates/coder/              template.json, tools.json, prompt.md, policy.json
  schema/aide-local.capnp
  fuzz/  tests/it/
```

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reason |
|---|---|---|
| Agents are principals in tier-3 VMs ([ADR-0009](../../handbook/11-decisions/adr-0009-unsealed-code-in-workbenches.md), [ADR-0010](../../handbook/11-decisions/adr-0010-crosvm-single-vmm.md)) | Namespace sandboxes on the host | Agent-run code is unsealed; the host executes only sealed code |
| Merge approval bound to an immutable strata prepared merge; any change of the result means a new prepared merge and a new approval (protocols E30, ISSUES ISS-003) | Approve a manifest and let strata merge against the live tree at commit | The human approves exactly the content that lands |
| Pinned templates ([ADR-0030](../../handbook/11-decisions/adr-0030-pinned-agent-tools.md)) | Live tool discovery | Rug-pull attacks on MCP servers and tools |
| Agents propose, humans sign ([ADR-0029](../../handbook/11-decisions/adr-0029-agents-propose-humans-sign.md)) | Direct write access | Reversibility and accountability |
| Merges as gate intents ([ADR-0027](../../handbook/11-decisions/adr-0027-effect-outbox-and-mandates.md), [ADR-0028](../../handbook/11-decisions/adr-0028-approval-tiers.md)) | A dedicated merge API in aide | One approval and mandate path for every effect |
| Session keys in vault, signing at gate and vault ([ADR-0039](../../handbook/11-decisions/adr-0039-secrets-never-in-env.md)) | Keys inside the VM | Keys never enter the VM; deletion at session end is enforceable |
| camel/1 only for WASI harnesses ([ADR-0026](../../handbook/11-decisions/adr-0026-labels-and-rule-of-two.md)) | Proofs from VM harnesses | A VM harness that runs model-chosen code cannot keep provenance honest |
| Budget carving ([ADR-0005](../../handbook/11-decisions/adr-0005-biscuit-capability-tokens.md)) | Independent child budgets | Prevents spend amplification through fan-out |
| Children return data, not merges | Child→parent overlay merge | No privileged merge path besides the T3 one |
| Agent desktops in tier-3 VMs ([ADR-0051](../../handbook/11-decisions/adr-0051-agent-desktops.md)) | Screen capture and input injection on the real session | A computer-use agent with real-session access holds all of the human's authority |
| Queue at the VM cap | Fail the start | Small machines stay usable; sessions wait instead of being lost |
| Template files through `Depot.openPath` | Parse EROFS images in aide | depot already verifies and resolves generation paths; aide carries no image parser |
| Drift escalation at gate, surfaced by aide | Pin model versions only | Providers change models behind stable IDs; the human decides whether a changed model may keep acting |
| Agent attempts of durable workflows are fresh sessions whose authority and label the broker restores from the workflow record ([ADR-0068](../../handbook/11-decisions/adr-0068-durable-workflows-loom.md)) | Persist and resume agent VMs and tokens; make paused sessions resumable | Tokens and sessions are boot-scoped; resuming needs current authority, and pausing must not become background permission |
| Record model and tool observations before delivery and replay them by key | Ask the model again after a crash | A model does not reproduce earlier choices; replay keeps the workflow deterministic and avoids paying twice |
| Human stop of an attached session is a workflow cancellation; crashes are not | One "stopped" signal | A crash must be retried, a cancellation must never be |
| aide prepares workflow effects, loom commits them | aide commits after approval as for ordinary sessions | Authority is revalidated by broker when loom commits, independent of the attempt that prepared |
