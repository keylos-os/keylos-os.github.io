# keylos/sdk — developer kit for apps, services, tools and agent templates

| | |
|---|---|
| Repository | `github.com/keylos-os/sdk` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | CLI `kl-sdk`<br>Rust crates `keylos-sdk`, `keylos-sdk-macros`<br>C library `libkeylos` (shared + static, header `keylos.h`)<br>Language bindings: Python `keylos` (built as a store generation), Go module `keylos.org/sdk/go`, Node package `@keylos/sdk`<br>Simulator generation `io.keylos.sdk.sim`<br>GUI runtime add-on `io.keylos.runtime.portal-island`<br>Project templates<br>WIT package `keylos:effects@1.0.0` (byte-identical copy of `protocols §20.15`) |
| Depends on | `keylos-protocols 1.0.0 (final)` (all crates), `nickel-lang-core`, `wasmtime` (renderer test runner) |
| Runtime peers | `forge` (builds, sealing), `depot` (install), `bench` (hermetic builds and tests), `broker`, `portals`, `gate`, `vault`, `journal` (runtime clients), `aide` (agent host for harnesses) |
| Provides | The supported way to author manifests, command signatures, localisation files and agent templates; capwire client and service runtimes for every language; packaging, signing and publishing; a local test harness that simulates grants and approvals |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

The sdk is the developer-facing surface of keylos. Developers write ordinary programs in any language. The sdk turns them into keylos generations and gives them correct, convenient access to authority.

**The sdk provides:**
1. **Authoring.**
   - `package.ncl`: a Nickel description from which the sdk generates the generation manifest (`protocols §6.3`), the command signatures (`protocols §12`), localisation files (`/.keylos/l10n/`), agent-template files (`/.keylos/agent/`, `protocols §6.4`) and a `forge` recipe.
   - Derive macros for Rust CLIs, so signatures always match the parser.
2. **Runtime libraries.** They read the keylos process environment (`KEYLOS_CAPWIRE_FDS`, argument fds, pipe mode, `KEYLOS_AGENT_HOST`), connect to granted services, and offer idiomatic APIs for:
   - the powerbox
   - portals (including notification action callbacks and multi-stream screen capture)
   - effect staging
   - secrets (`protocols §20.10` delivery)
   - inbound listening sockets
   - typed records
   - structured logs and metrics
3. **Service runtime.** The `Bootstrap`/`ServiceHost` protocol every tier-0 service implements (`protocols §7.5.1`), facet dispatch, `FdStore`, health and reload.
4. **Harness runtime.** The agent-host client (`AgentHost`, `AgentHostExt`, `VmExec`) for agent harness authors, over the capwire-vsock profile.
5. **Build, run and test.**
   - Hermetic builds in a workbench.
   - Running unsealed builds in a workbench.
   - Sealing for host runs, through `forge`.
   - A simulator of keylos services, so grant and approval paths can be tested deterministically.
6. **Packaging and publishing.** OCI artifacts with a DSSE generation statement (`protocols §20.7`), SBOM and provenance; publisher onboarding into the TUF `publishers` role (hardware key or Sigstore identity, `protocols §11.8`); submission to the catalog (`keylos.catalog/1`), where `reviewed-reproducible` listings require rebuilder reproduction; org publishers signing `container` generations for `keylos-sealed` pods (`protocols §21.4`).
   **Special package kinds:** installable web apps (`webapp`), container generations for org clusters (`container`, with `needs.csi` for CSI node plugins), and project-built kernel modules (`kmod`, release maintainers only).
7. **Templates** for a GUI app, a CLI tool, a service, an agent template and an effect renderer component.
8. **Lint and docs.** Static checks for keylos rules, and man pages and reference docs generated from command signatures.

**Non-goals:**
- A UI toolkit: apps use GTK, Qt, Slint, egui, Flutter or anything else.
- An IDE.
- Language package managers: lockfiles are translated by `forge`.
- Any authority of its own: everything the sdk does at runtime, the program could do through the same capwire calls.

---

## 2. Context and embedded contracts

### 2.1 Embedded contracts

Every contract below is copied verbatim into Appendix A by mechanical extraction from keylos-protocols 1.0.0 (final).

| Contract | Use | Appendix |
|---|---|---|
| `protocols §3.3`, `§3.4` | Name rules for generations, services and facets; principal text forms | A.1, A.2 |
| `protocols §5.1` | DSSE envelopes for publishing | A.3 |
| `protocols §6.1`–`§6.4` | Generation kinds, layout, manifest, agent templates | A.4–A.7 |
| `protocols §7.1`, `§7.2`, `§7.2.1` | capwire, routes and facets, the vsock profile for harnesses | A.8–A.10 |
| `common.capnp` + errors | Error mapping in every binding | A.11 |
| `broker.capnp` | Powerbox, grants | A.12 |
| `vault.capnp` | Secrets | A.13 |
| `gate.capnp` | Network sockets, listen sockets, effect staging | A.14 |
| `aide.capnp` | `AgentHost` | A.15 |
| `portals.capnp` | Portal clients, `NotifyHandler` | A.16 |
| `warden-sys.capnp` | `Bootstrap`, `ServiceHost`, `FdStore` for the service runtime | A.17 |
| `aide-sys.capnp` | `AgentHostExt`, `VmExec` | A.18 |
| `portals-extra.capnp` | `Background`, `GlobalShortcuts`, `Inhibit` clients | A.19 |
| `protocols §10.5`, `§10.6` | Process environment; log and metrics records | A.20, A.21 |
| `protocols §12`, `§12.1`, `§12.2` | Command signatures, argument fds, pipes | A.22–A.24 |
| `protocols §14.2`, `§14.3` | Effect kinds and approval tiers | A.25, A.26 |
| `protocols §19.2` | The facet registry (lint KL011) | A.27 |
| `protocols §20.7` | Generation statement signed at publish | A.28 |
| `protocols §20.10` | Secret delivery from `Vault.open` | A.29 |
| `protocols §20.15` | Effect renderer WIT | A.30 |
| `protocols §7.3.7` (terminated HTTP mode) | Native HTTP clients for method-filtered `https` grants | A.14 |
| `protocols §11.8`, `§20.20` | Publisher onboarding, catalog format | A.31, A.32 |
| `protocols §21.2`, `§21.4` | `container` generations, deterministic conversion and org-publisher signing | A.33, A.34 |
| `protocols §14.5` | Model drift rule (`agent.models[].minVersion`, `weights`), agent desktops (`vm.desktop`) | A.35 |
| `protocols §9.3` | kmod rule: release-signed modules only | A.36 |

### 2.2 Rules this spec relies on (summary; the appendix is normative)

- A process can reach only the capabilities named in `KEYLOS_CAPWIRE_FDS` and those returned by calls on them; holding a capability is authority; there are no call-attached tokens (`protocols §7.1`).
- Names in `KEYLOS_CAPWIRE_FDS` are `service` or `service#facet` (`protocols §10.5`). `KEYLOS_*` names are reserved; programs never set them.
- Secrets are delivered as `memfd_secret` fds readable only through `mmap`, laid out as `u64 LE length ‖ value ‖ padding`, with a sealed-memfd fallback (`protocols §20.10`).
- Fields prefixed `x-` in a manifest carry no authority and are ignored by verifiers (`protocols §6.3`).
- Agent templates put their content under `/.keylos/agent/` and pin every tool and MCP server by digest (`protocols §6.4`).

---

## 3. Requirements

### 3.1 Authoring

- **REQ-SDK-001** `kl-sdk` MUST generate `manifest.json`, all `cmdsig/*.json`, `l10n/*.json` and, for agent templates, `agent/{template,tools,policy}.json` and `agent/prompt.md` from `package.ncl`. Generated files MUST validate against the protocols JSON Schemas (`manifest-1.json`, and the cmdsig and agent-template schemas in `keylos-formats`).
- **REQ-SDK-002** For Rust CLIs, `#[derive(keylos_sdk::Command)]` on a `clap` 4 parser MUST produce the cmdsig at build time. The derive MUST fail compilation when a field type cannot be mapped (§4.3).
- **REQ-SDK-003** `kl-sdk lint` MUST implement the rules of §4.9 and exit non-zero on any `error`-level finding.
- **REQ-SDK-004** The sdk MUST refuse to generate a manifest with `tier = 0` for `kind = app`, with `needs.jit = true` without a non-empty `jit_reason`, with `needs.network[*].why` empty, or with `needs.listen[*].why` empty. `jit_reason` is emitted as the informational field `x-jitReason`, which carries no authority.
- **REQ-SDK-005** For agent templates, `kl-sdk` MUST compute every digest exactly as `protocols §6.4` defines (tool digests, `tools.digest`, `prompt.digest`, `policy.digest`, MCP `toolsDigest`) and MUST refuse to pack a template whose remote MCP servers have no pinned `toolsDigest`.
- **REQ-SDK-006** Localised strings MUST be written only to `/.keylos/l10n/<lang>.json`, and the manifest `l10n` field MUST list exactly the languages present. Generated strings MUST NOT contain bidi control characters (`protocols §6.3`).
- **REQ-SDK-007** For `kind = 'app` with a `webapp` section, `kl-sdk` MUST emit the manifest `webapp` object (`protocols §6.3`), MUST resolve `browser_runtime` to a `gen:` ref, MUST NOT emit `needs.jit` for the webapp generation, and MUST derive one `needs.network` request for the origin's host (port 443, `https`) plus any extra hosts the author lists, each with a non-empty `why`.
- **REQ-SDK-008** `needs.gpu = 'passthrough` MUST be accepted only when the effective tier is 2 or the kind is `container`; `needs.csi` only for `kind = 'container`; `needs.realtime` for any app or service, and the sdk MUST show it in `kl-sdk inspect` as an install-time disclosure.
- **REQ-SDK-009** `kind = 'kmod` packages MUST be refused unless `kl-sdk` runs inside the release pipeline of a project stream (`--release-stream <stream>` with the stream's module-signing key available to `forge`); third-party module packages are impossible by design (`protocols §9.3`).

### 3.2 Runtime libraries

- **REQ-SDK-010** The runtime MUST parse `KEYLOS_CAPWIRE_FDS` once, take ownership of those fds, mark them `O_CLOEXEC`, and expose named connections lazily, accepting both `service` and `service#facet` names.
- **REQ-SDK-011** The runtime MUST NOT read secrets from environment variables. `secret(name, purpose)` reads only through `Vault.open`, maps the fd `PROT_READ` per `protocols §20.10`, copies the value into memory that is locked (`mlock`) and zeroised on drop, and unmaps and closes the fd immediately.
- **REQ-SDK-012** File arguments MUST be exposed as already-open handles (`KEYLOS_ARGFD_<name>`). The runtime MUST provide `dir.open_beneath(rel)`, implemented with `openat2(RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS)`.
- **REQ-SDK-013** Record I/O MUST implement `protocols §12.2` exactly. With `KEYLOS_PIPE_OUT=cbor-seq` it writes an RFC 8742 CBOR sequence; otherwise TSV, or the format chosen by `--format text|tsv|json|cbor`.
- **REQ-SDK-014** The C ABI MUST be stable within a major version, and all handles MUST be opaque. Every function MUST return a `kl_status` and fill an optional `kl_error*`. No function may abort the process.
- **REQ-SDK-015** Every binding (Python, Go, Node) MUST pass the same API test suite against `kl-sim`.
- **REQ-SDK-016** The runtime MUST call `Extensible.version` on first use of each service and fail with `unsupported` when the service reports a protocols major version other than 1.
- **REQ-SDK-018** The `net` module MUST support **terminated HTTP mode** (`protocols §7.3.7`): when the authorizing token's `net` fact names a method other than `"*"`, `app.http()` MUST speak plain HTTP/1.1 over the socket from `Gate.connect` (absolute-form request target `https://host/path`, `Host` header set, no TLS) and MUST NOT attempt a TLS handshake on it; otherwise it performs TLS end to end. `app.connect()` on such a grant MUST fail with `unsupported` and a hint to use `app.http()`.
- **REQ-SDK-017** The service runtime MUST implement `ServiceHost` and the `Bootstrap` sequence of `protocols §7.5.1`: call `host` first, then `ready` once the service can serve, `watchdog` at the interval of the service manifest, and honour `stop` and `reload`. It MUST dispatch each accepted connection by the facet `warden` passes and MUST reject methods the facet does not allow with `kl:denied`.

### 3.3 Build, run, seal, test

- **REQ-SDK-020** `kl-sdk build` MUST build through `forge` inside a tier-3 workbench with networking disabled, after `forge` has fetched the fixed-output inputs. The result is a generation in the local store (unsealed, launchable only in workbenches).
- **REQ-SDK-021** `kl-sdk run` MUST default to running inside the project workbench. `--host` MUST require the generation to be launchable on the host (sealed or signed); `kl-sdk seal` asks `forge` to seal it, which opens an owner sealing window (`protocols §11.6`).
- **REQ-SDK-022** `kl-sdk test` MUST run the app with `io.keylos.sdk.sim` serving every capwire interface the manifest needs. Scenario files (§4.7) determine approvals, powerbox selections, network responses, notification actions and vault contents. Simulation MUST be deterministic for a given scenario and seed.
- **REQ-SDK-023** `kl-sdk test --tiers` MUST run the test suite under each tier the app may run in (1, and 2 when `reproducible = false`), and report confinement differences.

### 3.4 Publishing

- **REQ-SDK-030** `kl-sdk publish` MUST:
  - push the generation as an OCI artifact in the depot distribution format (§4.11);
  - sign a `keylos.genstmt/1` statement (`protocols §20.7`) as a DSSE envelope with the publisher key (or a Sigstore identity named in the publisher's TUF delegation);
  - attach the envelope, an SPDX SBOM and the forge provenance as OCI referrers;
  - print the `gen:` ref.
- **REQ-SDK-031** `kl-sdk catalog submit` MUST send only the recipe and source references, never binaries. Catalogue listing requires the rebuilder quorum to reproduce the generation digest.
- **REQ-SDK-032** Publisher keys created by `kl-sdk keys new` MUST default to a hardware token (FIDO2 or PKCS#11). File keys require `--insecure-file-key` and are encrypted with Argon2id + XChaCha20-Poly1305.
- **REQ-SDK-033** `kl-sdk publisher onboard` MUST produce a publisher delegation request (§4.13) containing either an Ed25519 public key held in hardware or a Sigstore identity (OIDC issuer + subject), the accepted publisher-policy version, and a proof of possession (a DSSE envelope over the request signed by the key or by a Sigstore certificate for the identity). It MUST NOT upload private material.
- **REQ-SDK-035** For `kind = 'bench-image`, `kl-sdk gen` MUST emit the manifest `benchImage` section from `bench_image` and MUST refuse a package without it; `desktop = true` MUST be accompanied by the purpose `'agentDesktop`, and `'agentDesktop` by `desktop = true`.
- **REQ-SDK-036** `app.save_file` (and `kl_save_file`) MUST end a save whose `PickResult.rootKey` starts with `media:` by calling `MediaSave.finish(relPath)` on route `portal-files#default` (obtained with `Extensible.ext`) when the app closes the returned file, and `MediaSave.cancel` when the app drops it after an error; for other saves it does nothing extra.
- **REQ-SDK-034** `kl-sdk container sign` MUST compute the `container` generation digest with exactly the conversion `oci-convert/1` that `depot` uses (`protocols §21.4`, crate `keylos-oci-convert`), MUST sign a `keylos.genstmt/1` for it with an `org-publisher/<org>/<id>` key, and MUST refuse when the conversion it ran differs from a second, independent run (reproducibility self-check).

---

## 4. Design

### 4.1 `package.ncl`

The schema is published as the Nickel module `keylos/package@1`.

```nickel
{
  PackageSchema = {
    name | String,                                   # reverse-DNS, protocols §3.3
    version | String,                                # SemVer
    kind | [| 'app, 'service, 'agent-template, 'runtime, 'data, 'bench-image, 'container, 'kmod |],
    summary | String,
    license | String,                                # SPDX expression
    homepage | String | optional,
    tier | [| 't1, 't2 |] | default = 't1,           # apps; services are always t0 (set by the sdk)
    runtime | String | default = "io.keylos.runtime.base",
    build | {
      language | [| 'rust, 'go, 'python, 'node, 'c-meson, 'c-cmake, 'zig, 'custom |],
      source | { git | String, rev | String } | optional,   # default: the current repository at HEAD
      lockfiles | Array String | default = [],              # auto-detected if empty
      features | Array String | default = [],
      check | Array String | default = [],                   # commands run in the separate check sandbox
      custom | { builder | String, args | Array String } | optional,
    },
    entrypoints | { _ : {
        exec | String,
        args | Array String | default = [],
        kind | [| 'gui, 'cli, 'service, 'harness, 'handler, 'notify-action |],
      } },
    needs | {
      jit | Bool | default = false,
      jit_reason | String | optional,
      gpu | [| 'none, 'render, 'display, 'passthrough |] | default = 'none,   # 'passthrough: tier 2 apps and containers only
      realtime | Bool | default = false,              # RLIMIT_RTPRIO 20 / RLIMIT_RTTIME 200 ms (protocols §6.3)
      csi | { driver | String, node_plugin | String, controller | Bool | default = false } | optional,   # kind = 'container only
      network | Array { host | String, ports | Array Number, proto | [| 'tcp, 'udp, 'https |] | default = 'https, methods | Array String | default = [], why | String } | default = [],
      listen | Array { port | Number, proto | [| 'tcp, 'udp |] | default = 'tcp, scope | [| 'loopback, 'lan, 'any |] | default = 'loopback, why | String } | default = [],
      devices | Array String | default = [],
      services | Array String | default = [],
      secrets | Array { name | String, why | String } | default = [],
      data_units | Array String | default = ["default"],
      spawn | Array String | default = [],
      reads_untrusted | Bool | default = false,
      portal_island | Bool | default = false,         # GTK/Qt apps that speak xdg portals over D-Bus
    } | default = {},
    provides | {
      commands | Array String | default = [],
      services | Array String | default = [],
      mime_types | Array String | default = [],
      uri_schemes | Array String | default = [],
      agent_tools | Array String | default = [],
    } | default = {},
    effects | Array { kind | String, class | [| 'reversible, 'compensable, 'irreversible |], compensator | String | optional, renderer | String | optional } | default = [],
    l10n | { default | String | default = "en", strings | { _ : L10nStrings } | default = {} } | default = {},
    commands | { _ : CmdSig } | default = {},          # for non-Rust CLIs; Rust uses the derive
    agent | AgentTemplate | optional,                  # kind = 'agent-template
    service | ServiceSpec | optional,                  # kind = 'service
    webapp | {                                         # kind = 'app: installable web app (protocols §6.3)
        origin | String,                               # "https://app.example.com"
        scope | String | default = "/",
        name | String,
        icons | Array String | default = [],           # paths in the package, copied to /.keylos/icons/
        browser_runtime | String | default = "io.keylos.runtime.browser-shell",
        extra_hosts | Array { host | String, why | String } | default = [],
      } | optional,
    container | {                                      # kind = 'container (org publishers, protocols §21.4)
        image | String,                                # "oci://<registry>/<repo>@sha256:<manifest>"
        platform | String | default = "linux/amd64",
      } | optional,
    kmod | {                                           # kind = 'kmod (release pipeline only, protocols §9.3)
        kernel | String,                               # exact uname -r
        modules | Array String,
        firmware | Array String | default = [],
      } | optional,
    bench_image | {                                    # kind = 'bench-image: REQUIRED (protocols §6.3)
        purposes | Array [| 'workbench, 'agent, 'app, 'media, 'build, 'captive, 'pod, 'agentDesktop |],
        desktop | Bool | default = false,              # true: agent-desktop image (nested atrium); required for 'agentDesktop
      } | optional,
  },
}
```

**Mapping to the manifest** (`protocols §6.3`):

| `package.ncl` | Manifest |
|---|---|
| Snake-case keys | Camel-case manifest keys (`data_units` → `dataUnits`, `mime_types` → `mimeTypes`, `uri_schemes` → `uriSchemes`, `agent_tools` → `agentTools`, `reads_untrusted` → `labels.readsUntrusted`) |
| `tier` `'t1` / `'t2` | `1` / `2` |
| `needs.portal_island = true` | `needs.portalIsland = true`; adds the runtime add-on `io.keylos.runtime.portal-island` to the generation and wraps GUI entrypoints with `kl-island-exec` (§4.5.2) |
| `needs.listen` | `needs.listen` (`{port, proto, scope, why}`) |
| `entrypoints.*.kind` `'notify-action` | `"notify-action"` |
| `needs.jit_reason` | `x-jitReason` (informational) |
| `l10n` | Manifest `l10n: {default, languages}`; each language's strings to `/.keylos/l10n/<lang>.json` |
| `agent` | Manifest `agent: {template: "/.keylos/agent/template.json", flowProof}` and the files of §4.1.3 |
| `reproducible` | Set by `forge` after the build, never by the author |
| `derivation`, `runtime`, `publisher` | Filled in by `kl-sdk pack` / `publish` |
| `grafted` | Always `false` from the sdk; only forge emergency grafts set it |
| `needs.realtime` | `needs.realtime` |
| `needs.gpu = 'passthrough` | `"passthrough"` |
| `needs.csi` | `needs.csi` (`{driver, nodePlugin, controller}`) |
| `webapp` | Manifest `webapp: {origin, scope, name, icons, browserRuntime}`; `needs.network` gains the origin host (§4.15); no entrypoints of its own beyond `main`, which `kl-sdk` sets to the runtime's webapp launcher |
| `container` | Manifest `container` filled by `kl-sdk container sign` from the OCI image config (§4.14); `tier` omitted |
| `kmod` | Manifest `kmod: {kernel, modules, firmware}`; no `tier`, no entrypoints |
| `bench_image` | Manifest `benchImage: {purposes, desktop}` (purpose names as the `VmSpec.Purpose` enumerants); `kind = 'bench-image` without it is refused (KL027) |

#### 4.1.1 Localisation (`L10nStrings`)

```nickel
L10nStrings = {
  summary | String | optional,
  entrypoints | { _ : { name | String } } | default = {},
  needs | { network | Array { why | String } | default = [], listen | Array { why | String } | default = [],
            secrets | Array { why | String } | default = [] } | default = {},
}
```

`kl-sdk gen` writes one JCS JSON file per language, `{"summary", "entrypoints": {"main": {"name"}}, "needs": {"network": [{"why"}]}}`, keeping array positions aligned with the manifest's `needs` arrays. It rejects strings containing U+202A–U+202E, U+2066–U+2069 or other bidi controls (REQ-SDK-006).

#### 4.1.2 `ServiceSpec` (for `kind = 'service`)

```nickel
ServiceSpec = {
  start | [| 'boot, 'on-demand, 'manual |] | default = 'on-demand,
  instances | [| 'single, 'per-human |] | default = 'single,
  routes | Array { to | String, facet | String } | default = [],      # facet REQUIRED; must list this service as holder in protocols §19.2 (lint KL011)
  serves | Array { facet | String, interfaces | Array String } | default = [],   # capnp interface names served per facet
  restart | [| 'always, 'on-failure, 'never |] | default = 'on-failure,
  health | [| 'capwire-probe, 'watchdog, 'none |] | default = 'capwire-probe,
  watchdog_secs | Number | default = 30,
  limits | { memory_mib | Number | optional, pids | Number | optional } | default = {},
  state | Bool | default = true,                      # /var/lib/<service> dirfd passed by warden
}
```

The sdk turns `ServiceSpec` into the service generation's manifest entrypoint (`kind: "service"`) and into the service-set fragment that the distribution's `services.json` merges (owned by `warden`/`keylos`; the sdk only emits the fragment for review).

#### 4.1.3 `AgentTemplate` (for `kind = 'agent-template`)

```nickel
AgentTemplate = {
  harness | {
    placement | [| 'vm, 'wasi |] | default = 'vm,
    generation | String,                              # harness generation name or gen ref
    entrypoint | String | default = "main",
    wasi_component | String | optional,               # path in this package when placement = 'wasi
  },
  bench_image | String | default = "io.keylos.bench.guest",
  vm | { vcpus | Number | default = 4, memory_mib | Number | default = 8192, gpu | Bool | default = false,
         desktop | Bool | default = false } | default = {},     # desktop: computer-use agent desktop (protocols §6.4, §14.5)
  models | Array {
      provider | String, model | String, max_tokens | Number | default = 8192,
      host | String | optional,                       # remote providers
      min_version | String | optional,                # remote providers: model drift baseline (protocols §14.5)
      runtime | String | optional,                    # local providers: runtime generation
      weights | String | optional,                    # local providers: data generation with the weights (pins the model exactly)
    },
  tools | Array {
      name | String,
      kind | [| 'vm, 'cmd, 'host |],
      description | String,
      input_schema | { .. } | optional,
      exec | String | optional,                       # 'vm: argv[0] inside the workbench
      command | String | optional,                    # 'cmd: a command with a cmdsig
      generation | String | optional,                 # generation providing the command (pinned at pack)
    } | default = [],
  mcp | Array {
      name | String,
      kind | [| 'remote, 'local |],
      url | String | optional,                        # remote
      generation | String | optional,                 # local
      entrypoint | String | default = "main",
      trust | [| 'trusted, 'user, 'untrusted |] | default = 'untrusted,
      optional | Bool | default = true,
      injection | String | optional,                  # gate credential injection name
    } | default = [],
  prompt_file | String,                               # path in the package
  policy | {
      max_depth | Number | default = 1,
      max_fanout | Number | default = 4,
      default_duration_secs | Number | default = 3600,
      budget_defaults | Array String | default = ["usd-micro:5000000"],
      effect_kinds | { stage | Array String | default = [], commit | Array String | default = [] } | default = {},
      breakers | { .. } | default = {},
      retain_overlay_days | Number | default = 7,
    } | default = {},
  flow_proof | [| 'none, 'camel-1 |] | default = 'none,
}
```

During `kl-sdk pack`:
1. Every generation given by name (`harness.generation`, `bench_image`, tool `generation`, local MCP `generation`, model `runtime`) is resolved to a `gen:fsv256:` ref through `Depot.list` (route `depot#user`).
2. `tools.json` (`keylos.agent-tools/1`) is written with each tool's `digest` = SHA-256 over the JCS form of the tool object without `digest` (`protocols §6.4`). `cmd` tools embed their cmdsig.
3. For each remote MCP server, the `toolsDigest` comes from `kl-sdk pin-mcp <name>` (§5.1), which fetches `tools/list` through `Gate.connect` with the developer's grant, reduces each tool to `{name, description, inputSchema}`, sorts by name, and hashes the JCS array. A missing pin fails the pack (REQ-SDK-005).
4. `template.json` (`keylos.agent-template/1`), `policy.json` (`keylos.agent-policy/1`) and `prompt.md` are written with their digests; `flowProof: "camel/1"` requires `harness.placement = 'wasi` (`protocols §6.4`).
5. Any change of a pinned digest produces a new template generation, which `aide` treats as needing consent.
6. `vm.desktop = true` is emitted as `vm.desktop` in `template.json`; the pack requires `bench_image` to resolve to an agent-desktop image, that is a `bench-image` generation whose manifest has `benchImage.desktop: true` and lists the purpose `agentDesktop` (`protocols §6.3`), and refuses otherwise. Without `vm.desktop`, the image must list the purpose `agent`.
7. `min_version` is emitted as `minVersion`; a local model's `weights` is resolved to a `gen:` ref of kind `data` and becomes the model's identity. Lint warns about remote models without `min_version` (KL022).

### 4.2 Command signatures for non-Rust programs

```nickel
CmdSig = {
  summary | String,
  args | Array { name | String, type | String, access | [| 'read, 'write, 'create, 'readwrite |] | optional, variadic | Bool | default = false, default | String | optional } | default = [],
  flags | Array { name | String, short | String | optional, type | String, summary | String } | default = [],
  input | { type | [| 'none, 'bytes, 'text, 'records, 'any |], schema | { _ : String } | optional } | default = { type = 'none },
  output | { type | [| 'none, 'bytes, 'text, 'records |], schema | { _ : String } | optional },
  effects | Array String | default = [],
  net | Array String | default = [],
  exit | { _ : String } | default = { "0" = "ok" },
}
```

`kl-sdk` converts each entry to `cmdsig/<name>.json`, with `schema: "keylos.cmdsig/1"` and the command name added (`protocols §12`).

### 4.3 Rust derive

```rust
use keylos_sdk::{Command, records::Record};

#[derive(clap::Parser, keylos_sdk::Command)]
#[keylos(summary = "Count lines per file", output = "records")]
struct Args {
    /// Files to count
    #[keylos(file, access = "read")]
    files: Vec<keylos_sdk::FileArg>,
    /// Include blank lines
    #[arg(short, long)]
    blank: bool,
}

#[derive(serde::Serialize, Record)]
struct Row { file: String, lines: u64 }

fn main() -> keylos_sdk::Result<()> {
    let app = keylos_sdk::App::from_env()?;
    let args = Args::parse_keylos(&app)?;          // binds FileArg to KEYLOS_ARGFD_files
    let mut out = app.records_out::<Row>()?;      // cbor-seq or TSV per protocols §12.2
    for f in args.files { out.write(&Row { file: f.display_name(), lines: count(f.reader()?, args.blank)? })?; }
    Ok(())
}
```

**Type mapping:**

| Rust | cmdsig |
|---|---|
| `bool` | `bool` |
| integer types | `int` |
| `f32`, `f64` | `float` |
| `String` | `text` |
| `Vec<u8>` | `bytes` |
| `FileArg` | `file` (with `access`) |
| `DirArg` | `dir` |
| `PathBuf` | `path` |
| `Url` | `url` |
| `Host` | `host` |
| `Duration` (humantime) | `duration` |
| `ByteSize` | `size` |
| `SystemTime` | `time` |
| `Vec<T>` | variadic or `list<T>` |
| `ValueEnum` | `enum[...]` |
| `SecretRef` | `secret-ref` |

Anything else is a compile error with a hint. The derive emits cmdsig JSON into `$OUT_DIR/keylos-cmdsig/<name>.json`; the forge Rust builder collects it into `/.keylos/cmdsig/`.

**Record type mapping** (`#[derive(Record)]`):

| Rust | Record schema type | CBOR | TSV |
|---|---|---|---|
| `String` | `text` | text string | escaped (`\t`, `\n`, `\\`) |
| integers | `int` | integer | decimal |
| `f64` | `float` | float64 | shortest round-trip |
| `bool` | `bool` | simple value | `true`/`false` |
| `SystemTime` | `time` | tag 1 (epoch, float) | RFC 3339 |
| `Duration` | `duration` | integer nanoseconds | humantime |
| `ByteSize` | `size` | integer bytes | IEC suffix |
| `Vec<u8>` | `bytes` | byte string | base64 |
| `Option<T>` | as `T`, nullable | null | empty field |

### 4.4 Runtime library structure (`keylos-sdk`)

| Module | API (Rust) | Notes |
|---|---|---|
| `app` | `App::from_env()`, `app.principal()`, `app.tier()`, `app.session()` | Parses env; owns capwire fds |
| `services` | `app.broker()`, `app.gate()`, `app.vault()`, `app.portal::<P>()`, `app.service::<T>("name#facet")` | Lazy capwire clients; `unsupported` if not routed; version check (REQ-SDK-016) |
| `files` | `FileArg`, `DirArg`, `DirArg::open_beneath`, `app.pick_file(PickOptions)`, `app.pick_dir`, `app.save_file` | Powerbox via `Broker.powerbox`; returns `std::fs::File` / `OwnedFd`; `PowerboxGrant.viewPath` exposed for path-expecting libraries |
| `records` | `RecordsOut<T>`, `RecordsIn<T>` | CBOR seq (`ciborium`) / TSV / JSON |
| `log` | `keylos_sdk::log` (a `tracing` subscriber writing `protocols §10.6` records) | |
| `metrics` | `counter!`, `gauge!`, `histogram!` macros writing `0x1F` records (`protocols §10.6`) | Batched, at most 1 record per metric per second |
| `effects` | `app.stage(EffectBuilder)` → `Intent`; `intent.dry_run()`, `intent.commit()` | Handles `kl:needs-approval` by waiting on the approval when `wait_approval(true)` |
| `secrets` | `app.secret(name, purpose) -> SecretBytes` | §4.4.1 |
| `net` | `app.connect(host, port)` → `TcpStream`-like over the fd from `Gate.connect`; `app.http()` (a `reqwest`-compatible connector using gate sockets; switches to terminated HTTP mode per REQ-SDK-018); `app.listen(port)` → listener from `Gate.connect(NetTarget{host: "listen:<addr>"…})` | Tokens from `Broker.myGrants`, matched locally on `net` facts; the matched token's `net($host,$port,$proto,$method)` decides end-to-end TLS (`$method = "*"`) or terminated mode |
| `grants` | `app.request_grant(GrantRequest)` | |
| `notify` | `app.notify(title, body).action("open", "Open").on_action(|id, action| …)` | Implements `NotifyHandler`; falls back to the `notify-action` entrypoint when the process is gone |
| `screen` | `app.capture(kind)` → `Vec<CaptureStream>` + PipeWire remote | Multiple streams (`protocols §7.3.15`) |
| `background` | `app.request_background(reason, autostart)` | `Background` portal |
| `agent` | Harness client (§4.6) | Available when `KEYLOS_AGENT_HOST` is set |
| `service` | Service runtime (§4.5.1) | For `kind = 'service` |

**Errors:** `keylos_sdk::Error { code: ErrorCode, reference: Option<String>, message: String }`, parsed from the `kl:<code>[:<ref>]` exception reasons (`protocols §7.3.1`).

#### 4.4.1 Secrets

`app.secret(name, purpose)`:
1. `Vault.open(name, purpose)` returns an fd (`protocols §20.10`).
2. `mmap(fd, PROT_READ, MAP_SHARED)` of at least one page; read the `u64` little-endian length `n`; map again if `8 + n` exceeds the first mapping.
3. Copy bytes `8 .. 8+n` into an `mlock`ed buffer owned by `SecretBytes`.
4. `munmap`, `close`. On drop, `SecretBytes` zeroises and `munlock`s.

Both the `memfd_secret` primary and the sealed-memfd fallback are read the same way, so callers never see the difference. The sdk never offers an API that returns secrets as `String` or puts them into environment variables.

### 4.5 Service and island runtimes

#### 4.5.1 Service runtime

`keylos_sdk::service::run(impl ServiceImpl)`:
1. Takes fd 3 as the `Bootstrap` connection (`protocols §7.5.1`); implements `ServiceHost`; calls `Bootstrap.host(serviceHost)`.
2. Opens state (`FdStore.fetch` for keys the service stored before a restart, and the `/var/lib/<service>` dirfd).
3. Calls `ServiceImpl::init`, then `Bootstrap.ready()`.
4. For each `ServiceHost.accept(socket, connectionId, facet, peer, tier, generation)`, starts a capwire server on `socket` whose bootstrap capability is `ServiceImpl::bootstrap_for(facet, peer)` wrapped with `Extensible` (the runtime answers `version` and routes `ext(interfaceId)` through the facet's allowed-interface table).
5. Sends `Bootstrap.watchdog()` every `watchdog_secs / 2` when health is `watchdog`.
6. On `reload`, calls `ServiceImpl::reload`; on `stop(reason)`, stops accepting, drains for up to the service's stop timeout, then exits.

`#[keylos_sdk::facets]` generates the facet table from an attribute on the service struct, so a method called on a facet that does not allow it fails with `kl:denied` before user code runs.

#### 4.5.2 Portal island for GTK and Qt apps

Native GUI toolkits reach the file chooser, notifications and screenshots through xdg-desktop-portal over D-Bus, and keylos has no session bus. Packages that set `needs.portal_island = true` (manifest `needs.portalIsland`) get:
- the runtime add-on `io.keylos.runtime.portal-island`, containing `dbus-broker`, `compat-dbus-gate` and `portal-xdg-shim` built from the `compat` and `portals` repositories, and `kl-island-exec`;
- GUI entrypoints wrapped as `kl-island-exec -- <exec>`.

`kl-island-exec` runs **inside the app's own principal**:
1. Start a private `dbus-broker` at `$XDG_RUNTIME_DIR/bus` and the gate, with the portal subset of the allowlist (FileChooser, OpenURI, Notifications, ScreenCast, Screenshot, Camera, Print, Settings).
2. Export `DBUS_SESSION_BUS_ADDRESS`, `GTK_USE_PORTAL=1` and `QT_QPA_PLATFORMTHEME=xdgdesktopportal`.
3. `exec` the app.

The island adds no authority: the gate calls the same keylos services the app could call directly, with the app's own routes. File-chooser results are paths under `/grants/<name>` (`PowerboxGrant.viewPath`).

### 4.6 Harness runtime (agent templates)

`keylos_sdk::agent` is for harness authors. Inside an agent workbench, `KEYLOS_AGENT_HOST=vsock:2:7002` (`protocols §10.5`):

| API | capwire call | Notes |
|---|---|---|
| `AgentClient::connect()` | `AF_VSOCK` `SOCK_SEQPACKET` to CID 2 port 7002, capwire-vsock profile (`protocols §7.2.1`) | No fds ever; bulk data as `ByteSource` |
| `client.bootstrap()` | `AgentHostExt.bootstrap` (obtained with `Extensible.ext`) | Session, principal, template JSON, git identity and trailers, local MCP servers |
| `client.tools()` | `AgentHost.tools` | Pinned tool definitions |
| `client.call_tool(name, args, provenance)` | `AgentHost.callTool` | Returns result JSON and the result's label |
| `client.model(request)` / `client.model_stream(request)` | `AgentHost.model` / `AgentHostExt.modelStream` | Metered by `gate` |
| `client.emit(event)` | `AgentHost.emit` | Structured events use `AgentEvent.rich` (JCS JSON) |
| `client.request_grant(reason)` | `AgentHost.requestGrant` | |
| `client.heartbeat()` | `AgentHostExt.heartbeat` | Called every 10 s by the runtime |
| `vm_exec(argv, stdin, timeout)` | `VmExec.run` | Only for WASI harnesses (`flowProof: "camel/1"`) |

Provenance helpers record, for every value passed to a tool, where it came from (`user`, `tool:<name>`, `file:<path>`, `web:<url>`) so `callTool`'s `provenanceJson` is filled consistently.

### 4.7 Simulator and scenarios

`io.keylos.sdk.sim` is a generation containing `kl-sim`, which implements:
- `Broker`, `Gate`, `Vault` (with `protocols §20.10` delivery), all `portals` interfaces including `NotifyHandler` callbacks and `portals-extra`, `Journal`, `Ledger` (in-memory), `TrustedPrompt` (scripted) and `AgentHost`/`AgentHostExt`;
- a minimal `Supervisor.spawn`, which starts processes inside the workbench guest with the given fds;
- the `Bootstrap` side of `warden-sys` for service tests (`ready`, `watchdog`, `stop`, `reload`, `FdStore`).

**Scenario file** `tests/<name>.scenario.ncl`:

```nickel
{
  seed = 42,
  grants = { network = ["api.example.com:443/https"], listen = ["8080/tcp/loopback"], secrets = { "sync-token" = "dGVzdA==" } },
  powerbox = [ { expect_kind = 'openFile, pick = "fixtures/report.txt" } ],
  approvals = [ { match_kind = "email.send", decide = 'approve, scope = 'once } ],
  notifications = [ { match_title = "Sync done", activate = "open" } ],
  network = { "api.example.com:443" = { kind = 'http, routes = [ { method = "GET", path = "/v1/items", status = 200, body_file = "fixtures/items.json" } ] } },
  labels = { start = { conf = 'internal, integ = 'trusted } },
  service = { facet = "default", peer = "app:gen:fsv256:…@alice/s-…", reload_after_ms = 500 },
  expect = {
    receipts = ["grant.issue", "effect.stage", "effect.commit"],
    effects_committed = [{ kind = "email.send", target = "smtp:mail.example.com" }],
    exit = 0,
  },
}
```

**Simulation rules:**
- Network: the sim's `Gate.connect` returns a socketpair end served by an in-sim HTTP/TLS responder. TLS uses a test CA injected into the guest trust store, inside the workbench only.
- Approvals: unmatched prompts fail the test with `UnexpectedPrompt`.
- Notifications: `activate` calls the app's `NotifyHandler`, or spawns its `notify-action` entrypoint when no handler is live.
- Receipts: the sim's ledger records receipts; `expect.receipts` is a subsequence match.
- Determinism: the sim controls time (starting at 2026-01-01T00:00:00Z, advancing only on explicit `sleep` hooks or I/O waits) and RNG (seeded).

### 4.8 Effect renderer components

Apps or policies that register an `x-…` effect kind MAY supply a **renderer** (`protocols §20.15`): a WASI 0.2 component that `gate` runs in Wasmtime to turn an intent into the rendering shown at approval time. The WIT package `keylos:effects@1.0.0` is copied verbatim in Appendix A.30; the sdk ships it as `wit/keylos-effects.wit`, byte-identical to the protocols file (checked in CI).

The renderer MUST respect, and `gate` enforces: fuel 50 million instructions; memory 64 MiB; no WASI filesystem, network or clock imports; body ≤ 256 KiB; attachment ≤ 8 MiB.

`kl-sdk test-renderer <component.wasm> <intent.json>` runs a renderer under those same limits. The `effect-renderer` template builds a Rust component with `cargo component`.

### 4.9 Lint rules

| ID | Level | Rule |
|---|---|---|
| KL001 | error | `env` or `project.ncl`/`package.ncl` env names matching `(?i)(key\|token\|secret\|passw\|credential)` |
| KL002 | error | `needs.network[].why` empty, or host `*` in a native app |
| KL003 | error | `needs.jit = true` without `jit_reason` |
| KL004 | error | CLI entrypoint without a cmdsig |
| KL005 | warn | Binary contains hard-coded `$HOME`-relative paths outside XDG (heuristic string scan of the built ELF: `/.config/`, `/.local/share/` of other apps, `/home/`) |
| KL006 | warn | Uses `std::env::var("…TOKEN…")` or equivalents (static scan for known patterns in Rust, Go, Python, JS sources) |
| KL007 | error | `effects[]` lists a kind whose class is lower than the protocol default (`protocols §14.2`) |
| KL008 | warn | `needs.services` contains a portal that the code never calls (from sdk call-site analysis in Rust; skipped elsewhere) |
| KL009 | error | Agent template tool, MCP server or harness without a resolvable generation or pinned digest |
| KL010 | warn | GUI app links `libX11` without `portal_island` or Wayland support |
| KL011 | error | Service `routes` naming a facet that does not list this service (or its actor kind) as holder in `protocols §19.2`, unless the package documents the policy grant it relies on |
| KL012 | warn | Lockfile missing for the language (non-hermetic fetch would fail in forge) |
| KL013 | error | Entrypoint of kind `handler` without `provides.mime_types` or `provides.uri_schemes` |
| KL014 | error | `x-` manifest fields whose names suggest authority (`x-*grant*`, `x-*tier*`, `x-*trust*`): `x-` fields carry none (`protocols §6.3`) |
| KL015 | warn | `needs.listen` with `scope = 'any` |
| KL016 | error | Localised strings containing bidi control characters (REQ-SDK-006) |
| KL017 | error | `flow_proof = 'camel-1` with `harness.placement = 'vm` |
| KL018 | error | `webapp` present together with `needs.jit`, or `webapp.origin` not an `https` origin |
| KL019 | error | `needs.gpu = 'passthrough` on a `'t1` app or on any kind other than `app` and `container` |
| KL020 | error | `needs.csi` on a kind other than `container` |
| KL021 | warn | `needs.realtime = true` on a GUI app (realtime is meant for audio and media pipelines) |
| KL022 | warn | Remote model in an agent template without `min_version` (drift detection then compares only the model name) |
| KL023 | error | `vm.desktop = true` with a `bench_image` that is not an agent-desktop image |
| KL024 | warn | The program links a TLS client stack and calls `Gate.connect` directly for a host whose declared `needs.network` entry has `methods` (terminated HTTP mode required, REQ-SDK-018) |
| KL025 | error | `kind = 'kmod` outside the release pipeline |
| KL026 | error | Service `routes` or `serves` using a facet name that does not appear in `protocols §19.2` (old names such as `warden#spawn`, `gate#intents`, `depot#read`, `vault#names`, `compat#run`, `net#captive` for anything but atrium, and `bench#user` purpose `captive` included) |
| KL027 | error | `kind = 'bench-image` without `bench_image`, or `desktop` and `'agentDesktop` not set together (REQ-SDK-035) |

### 4.10 Packaging, building and sealing

**Pack.** `kl-sdk pack` writes `.keylos/out/recipe.ncl` in the forge recipe format (`keylos/recipe@1`, owned by `forge`):

```nickel
{
  name = "org.example.Linecount", version = "1.0.0",
  source = { git = "https://github.com/example/linecount", rev = "<commit>", tree = "src:sha256:…" },
  builder = 'rust, lockfiles = ["Cargo.lock"],
  outputs = ["out"],
  install = { manifest = ".keylos/out/manifest.json", cmdsig_dir = ".keylos/out/cmdsig",
              l10n_dir = ".keylos/out/l10n", agent_dir = ".keylos/out/agent" },
  check = { separate = true, run = [["cargo", "test", "--release"]] },
}
```

**Build.** `kl-sdk build`:
1. Starts or attaches the project workbench (`Bench.project`, route `bench#user`).
2. Runs `forge build .keylos/out/recipe.ncl --local` inside it. forge produces the output tree and derivation.
3. Imports the generation into the local depot through forge's import path.
4. The generation is launchable only in workbenches until sealed or published.

**Seal.** `kl-sdk seal` calls `forge seal <drv>` (route `forge#user`). forge opens an owner sealing window through `HearthSeal.openWindow` (one FIDO2 touch on the trusted path, at most 600 s, one project directory, listed derivations; `protocols §11.6`, `§20.4`), signs the seal statement with `HearthSeal.sealSign`, and attaches it with `Depot.seal`. Further `kl-sdk seal` calls within the window need no new touch. The generation then runs on the host after the next registration by `warden` (`protocols §9.3`).

### 4.11 Publishing

`kl-sdk publish --to oci://<registry>/<repo>`:
1. Encode the generation as an OCI artifact:
   - artifactType `application/vnd.keylos.generation.v1`;
   - config blob = the manifest JSON;
   - layer 1 = the EROFS metadata image;
   - layer 2..n = store objects, packed zstd:chunked with a per-file TOC keyed by `fsv256` digest.
2. Build `keylos.genstmt/1` (`protocols §20.7`): `generation`, `kind`, `name`, `version`, `manifestDigest`, `drv`, `stream` (the catalogue stream or `"publisher"`), `objects` (SHA-256 over the newline-terminated, sorted, lowercase hex fs-verity digests of the closure), `issued`.
3. Sign it as a DSSE envelope (`protocols §5.1`) with the publisher key (`ed25519`), or with Sigstore keyless when the publisher's TUF delegation names that identity.
4. Attach the envelope, the SBOM (SPDX 3.0 JSON) and the provenance as referrers.
5. Push through `Gate.connect` with the developer's registry grants (route `gate#client`).

**Catalog.** `kl-sdk catalog submit --catalog apps.keylos.org`:
- Submits `{recipe, source tree ref, publisher id, expected gen, categories, summary, icons, homepage}` as a DSSE envelope signed by the publisher key (§4.13).
- The catalog role lists it as `unreviewed` at once, and as `reviewed-reproducible` only after the rebuilder quorum reproduces `expected gen` and review passes (`protocols §11.8`). `kl-sdk catalog status` shows the listing's `review`, `quorum` and the `capabilities` digest of the listed manifest.
- Machines install `unreviewed` apps with an effective tier floor of 2 unless the owner records an exception; the sdk prints this consequence on submit.

### 4.13 Publisher onboarding

1. `kl-sdk keys new --fido2` (or `--pkcs11`) creates the publisher's Ed25519 key in hardware; or the publisher chooses a Sigstore identity (`--sigstore --issuer <url> --subject <id>`).
2. `kl-sdk publisher onboard --id <publisher-id> --policy-version <v>` writes `.keylos/out/publisher-request.json`:
   ```json
   {"schema":"keylos.publisher-request/1","id":"example","displayName":"Example Ltd","contact":"security@example.com",
    "keys":["key:sha256:…"],"sigstore":[{"issuer":"https://token.actions.githubusercontent.com","subject":"repo:example/app:ref:refs/heads/main"}],
    "spki":{"key:sha256:…":"<base64 DER>"},"policyVersion":"1.0","time":"…"}
   ```
   and a DSSE envelope over it signed by the key (or by a Sigstore certificate for the identity) as proof of possession (REQ-SDK-033).
3. The publisher submits both files to the project's onboarding process (out of band); on acceptance, the TUF `publishers` delegation names the key or identity and the publisher appears in `keylos.publishers/1` candidates that owners can enable in config (`protocols §20.20`).
4. **Org publishers** follow the same flow against their fleet's TUF repository (`org-publishers` role); `kl-sdk publisher onboard --org <org>` writes the request with `scope: "org:<org>"`.

`keylos.publisher-request/1` is an sdk-owned format consumed only by the onboarding tooling shipped in this repository.

### 4.14 Container generations (org publishers)

For the `keylos-sealed` runtime class, an org publisher signs the generation that `depot` will produce from an OCI image (`protocols §21.4`):
1. `kl-sdk container sign oci://<registry>/<repo>@sha256:<manifest> --key org-publisher/<org>/<id>` pulls the image through `Gate.connect` (developer's registry grants) into a workbench.
2. Inside the workbench it runs `kl-container-convert`, a thin CLI over crate `keylos-oci-convert` (published by `depot`, the only implementation of `oci-convert/1`, `protocols §21.4` and §18), so both sides compute identical digests: layers applied in manifest order, whiteouts and opaque markers resolved, device nodes dropped, setuid/setgid bits and `security.*`/`trusted.*` xattrs removed, timestamps zeroed, output built as a composefs generation with manifest `kind: "container"` and `container: {image, platform, config}` from the OCI config. The generation's identity is computed as `protocols §21.4` states: `name = oci.<reversed registry host>.<repository path>`, `version = 0.0.0+oci.<first 16 hex of the manifest digest>`, `drv` = SHA-256 of the JCS `keylos.ociconv/1` descriptor. It runs the conversion twice in fresh directories and compares digests (REQ-SDK-034).
3. It signs `keylos.genstmt/1` for the resulting digest with the org-publisher key and pushes the envelope to the org TUF repository staging area (`--publish-to <fleet repo>`), from which `courier` serves it to nodes.
4. CSI node plugins declare `needs.csi` in a `package.ncl` with `kind = 'container`; `kl-sdk gen` writes it into the manifest that the conversion embeds. Such containers always run in `keylos-vm` pod VMs.

### 4.15 Web apps

`kind = 'app` with a `webapp` section produces an installable web app generation:
- No binaries of its own: the generation contains the manifest, icons and l10n. `entrypoints.main` is set to the browser-shell runtime's webapp launcher (`/usr/libexec/webapp-launch` in `browser_runtime`), with the manifest's `webapp.origin` as its argument.
- `needs.network` gets `{host: <origin host>, ports: [443], proto: "https", why: "The web app's own site"}` plus `extra_hosts`. The broker turns these into origin-scoped gate grants at install (`protocols §6.3`).
- Each web app has its own data unit and principal; cookies and storage never mix with the user's main browser profile.
- Lint KL018 refuses `needs.jit` on a webapp (the runtime generation declares it).

### 4.16 Kernel modules (`kmod`)

`kind = 'kmod` exists for the project's own release pipeline (`pkgs`), for out-of-tree modules such as the NVIDIA open modules (`protocols §6.1`, ADR-0057). `kl-sdk gen` validates `kmod.kernel` against the stream's kernel release list and hands the build to `forge` with `--release-stream`, which signs each module with the stream's module-signing key. Outside that pipeline the sdk refuses the kind (REQ-SDK-009); there is no owner-sealed or publisher-signed module path.

### 4.12 C ABI (`libkeylos`)

```c
typedef struct kl_app kl_app;
typedef struct kl_error { int code; char reference[64]; char message[512]; } kl_error;
typedef enum kl_status { KL_OK = 0, KL_ERR = -1 } kl_status;
typedef void (*kl_notify_cb)(void *user, uint32_t id, const char *action);

kl_status kl_app_from_env(kl_app **out, kl_error *err);
void      kl_app_free(kl_app *app);
kl_status kl_pick_file(kl_app *app, const char *title, const char *const *mime, size_t nmime, int multiple,
                       int *fds_out, size_t *nfds_inout, kl_error *err);
kl_status kl_save_file(kl_app *app, const char *title, const char *suggested, int *fd_out, kl_error *err);
kl_status kl_connect(kl_app *app, const char *host, uint16_t port, int *fd_out, kl_error *err);
kl_status kl_listen(kl_app *app, const char *addr, uint16_t port, int *fd_out, kl_error *err);
kl_status kl_secret(kl_app *app, const char *name, const char *purpose, uint8_t **buf, size_t *len, kl_error *err);
void      kl_secret_free(uint8_t *buf, size_t len);         /* zeroises and munlocks */
kl_status kl_notify(kl_app *app, const char *title, const char *body, const char *const *actions, size_t nactions,
                    kl_notify_cb cb, void *user, uint32_t *id_out, kl_error *err);
kl_status kl_stage_effect(kl_app *app, const char *intent_json, int payload_fd, char **intent_id_out, kl_error *err);
kl_status kl_commit_effect(kl_app *app, const char *intent_id, int wait_approval, char **status_json_out, kl_error *err);
kl_status kl_records_writer(kl_app *app, int fd, int *mode_out /* 0 text, 1 cbor-seq */, kl_error *err);
kl_status kl_log(kl_app *app, int level, const char *message, const char *fields_json, kl_error *err);
kl_status kl_metric(kl_app *app, const char *name, const char *type, double value, const char *labels_json, kl_error *err);
void      kl_string_free(char *s);
```

**Semantics:**
- Calls are synchronous; the library owns an internal tokio runtime thread. `kl_notify_cb` is called on that thread.
- Fds returned to the caller are owned by the caller.
- Thread-safe: `kl_app` may be shared between threads.
- `code` values are the protocols error codes, in table order starting at 1 (`denied` = 1 … `internal` = 12).
- The constant `KL_SDK_ABI` (integer) is exported; `kl_app_from_env` fails with `unsupported` on a mismatch.

**Bindings:**
- **Python** (`keylos`, PyO3 directly on `keylos-sdk`): `App.from_env()`, `app.pick_file()` returns `io.FileIO`, `app.records_out()`, `app.secret()` returns a `SecretBytes` with a context manager that zeroises.
- **Go** (cgo over `libkeylos`): `sdk.App`, `os.File` wrapping.
- **Node** (napi-rs over `keylos-sdk`): async API.

All bindings share `tests/api/*.yaml` behaviour cases run against `kl-sim`.

---

## 5. Interfaces

### 5.1 CLI `kl-sdk`

| Command | Purpose | Key flags | Exit |
|---|---|---|---|
| `kl-sdk init <template> [dir]` | Create a project from a template: `gui-rust`, `gui-gtk-portal`, `cli-rust`, `cli-python`, `cli-go`, `service-rust`, `agent-template`, `effect-renderer` | `--name`, `--publisher` | 0 |
| `kl-sdk gen` | Generate manifest, cmdsig, l10n, agent files and recipe from `package.ncl` into `.keylos/out/` | `--check` (fail if outputs would change) | 0; 2 schema error |
| `kl-sdk lint` | Run §4.9 rules | `--deny warnings`, `--json` | 0; 1 errors |
| `kl-sdk build` | Hermetic build in the workbench | `--release`, `--target x86_64\|aarch64` | 0; 3 build failed |
| `kl-sdk run [entrypoint] [-- args]` | Run in the workbench (default) or on the host | `--host`, `--tier 1\|2`, `--scenario <file>` | App's code |
| `kl-sdk test` | Unit tests plus scenarios under `kl-sim` | `--tiers`, `--scenario <glob>`, `--seed`, `--report junit\|json` | 0; 4 failures |
| `kl-sdk test-renderer <wasm> <intent.json>` | Run an effect renderer | `--fuel` | 0; 4 |
| `kl-sdk pin-mcp <name>` | Fetch and pin a remote MCP server's `toolsDigest` (§4.1.3) | `--show` | 0; 6 network refused |
| `kl-sdk seal` | Seal the last build for host runs through `forge` (owner presence; sealing window) | | 0; 5 presence refused |
| `kl-sdk pack` | Produce `recipe.ncl` and source refs | | 0 |
| `kl-sdk publish` | Push the OCI artifact, sign the generation statement, attach referrers | `--to`, `--key <ref>`, `--sigstore`, `--dry-run` | 0; 6 signing failed |
| `kl-sdk catalog submit` / `status` | Submit to, or query, the catalogue | `--catalog` | 0 |
| `kl-sdk keys new\|list\|export-pub` | Publisher keys | `--fido2`, `--pkcs11 <uri>`, `--insecure-file-key` | 0 |
| `kl-sdk docs` | Man pages (`.1`) and Markdown reference from cmdsig | `--out` | 0 |
| `kl-sdk conform` | Run protocols vectors relevant to the package (manifest, cmdsig, records, agent templates) | | 0; 4 |
| `kl-sdk inspect <gen\|oci-ref>` | Show manifest, capability summary (including `needs.realtime`, passthrough GPU, listen ports, web-app origin), signatures, provenance | `--json` | 0 |
| `kl-sdk publisher onboard` | Write a publisher delegation request and its proof of possession (§4.13) | `--id`, `--org`, `--policy-version`, `--sigstore` | 0; 6 signing failed |
| `kl-sdk container sign <oci-ref>` | Convert deterministically and sign a `container` generation statement (§4.14) | `--key`, `--platform`, `--publish-to` | 0; 3 conversion mismatch; 6 signing failed |

`kl-sdk` ships cmdsig files for every subcommand.

### 5.2 Files

| Path (project) | Meaning |
|---|---|
| `package.ncl` | Package description (§4.1) |
| `l10n/<lang>.ncl` | Optional per-language strings imported into `package.ncl` |
| `project.ncl` | Workbench description (owned by `bench`, `keylos/project@1`); `kl-sdk init` writes one |
| `.keylos/out/` | Generated `manifest.json`, `cmdsig/`, `l10n/`, `agent/`, `recipe.ncl` (committed to version control so reviewers see capability changes) |
| `tests/*.scenario.ncl` | Simulator scenarios |
| `renderers/*.wasm` (or source) | Effect renderer components |

### 5.3 Routes `kl-sdk` holds

`kl-sdk` runs as the human's `shell` principal and uses that principal's routes: `bench#user`, `depot#user`, `forge#user`, `broker#principal`, `gate#client` (publishing and MCP pinning with the developer's grants).

---

## 6. Security

| # | Threat | Mitigation |
|---|---|---|
| S1 | A developer accidentally ships a secret in env or config | KL001, KL006; the runtime never reads env secrets; `kl-sdk publish` scans the generation for high-entropy strings and known key formats (gitleaks-compatible rules) and refuses on a hit unless `--allow-secret-scan-findings` is given with a justification recorded in the provenance |
| S2 | A tampered build machine | Builds are hermetic in a workbench; catalogue listing requires an independent rebuilder quorum; the publisher signature alone never makes an app installable from the catalogue |
| S3 | Agent tool or MCP rug-pull | Tools, harness and MCP tool lists are pinned by digest at pack time (`protocols §6.4`); a digest change produces a new template generation that `aide` treats as needing consent |
| S4 | Malicious renderer | It runs in Wasmtime without imports, with fuel and memory limits; output is treated as untrusted text (atrium escapes markup) |
| S5 | Publisher key theft | Hardware keys by default; TUF delegation lets the catalogue revoke a key; revocations listed in `protocols §11.7` lists |
| S6 | Simulator test CA leaks into production | The test CA is generated per test run and injected only into the workbench guest trust store; never written to a generation |
| S7 | Secrets lingering in process memory | `SecretBytes` is `mlock`ed and zeroised; the secret fd is unmapped and closed immediately (§4.4.1) |
| S8 | Localised strings used for spoofing | Bidi controls rejected at generation (KL016); display code applies isolation and confusable checks (`protocols §6.3`) |
| S9 | Publisher key stolen from a developer laptop | Keys default to hardware (REQ-SDK-032); onboarding proves possession; revocation through the TUF `publishers` role and revocation lists (`protocols §11.7`) |
| S10 | An org publisher signs a container generation that differs from what depot will produce | Same conversion code and conformance vectors; double-conversion self-check before signing (REQ-SDK-034) |
| S11 | A web app escapes its origin | Origin-derived grants only; the browser-shell runtime enforces the scope; no JIT declared by the webapp itself (KL018) |
| S12 | Clients bypass gate method filtering by speaking TLS on a terminated socket | gate terminates and refuses non-HTTP bytes on terminated sockets; the sdk never sends a ClientHello there (REQ-SDK-018) |

**sdk tools confinement:**
- `kl-sdk` runs as the `shell` principal on the host and is sealed as part of the sdk generation.
- Every build, test and renderer execution happens in workbenches (bench).

---

## 7. Failure modes

| Failure | Behaviour |
|---|---|
| Lockfile missing or out of date | `kl-sdk build` exits 3, with a hint to run the language tool in the workbench (`work run -- cargo generate-lockfile`) |
| Seal refused (no presence) | Exit 5; the build stays workbench-only |
| MCP server unreachable during `pin-mcp` | Exit 6; the template cannot be packed until pinned |
| Rebuilder mismatch after catalogue submission | Catalogue status `diverged`, with both digests; `kl-sdk catalog status` shows the diffoscope report link |
| A sim scenario hits an unexpected prompt | Test fails with the prompt rendered |
| Binding ABI mismatch | `kl_app_from_env` returns `KL_ERR` with code `unsupported` and the expected/actual ABI versions |
| Service started without fd 3 | The service runtime exits with status 78 (configuration error) and a log record |

---

## 8. Performance budgets

| Item | Budget |
|---|---|
| `App::from_env()` | ≤ 1 ms (lazy connections) |
| `pick_file` round trip, excluding human time | ≤ 30 ms |
| `secret()` | ≤ 2 ms excluding any prompt |
| `records_out` throughput (CBOR seq, small records) | ≥ 1M records/s/core |
| `kl-sdk gen` for a typical package | ≤ 300 ms |
| `kl-sdk test` overhead per scenario (sim start + app spawn) in a warm workbench | ≤ 400 ms |
| Service runtime: `accept` to first dispatched call | ≤ 1 ms |

---

## 9. Observability

- The runtime emits structured logs (`protocols §10.6`) for capwire errors at level warning, with `service` and `method` fields, and metrics records (`0x1F`) for its own call latencies when the developer sets `KLSDK_METRICS=1` at test time (never in production manifests; `KEYLOS_*` names are reserved).
- `kl-sdk` writes no receipts itself. Seals, grants and effects are receipted by depot, broker and gate.
- `kl-sdk test --report junit|json` writes test reports including the receipt subsequence observed.

---

## 10. Configuration

The sdk reads `~/.apps/io.keylos.sdk/config/sdk.ncl` (user scope):

```nickel
{
  sdk | {
    default_publisher_key | String | optional,       # key:sha256:…
    registries | { _ : { url | String, sigstore | Bool | default = false } } | default = {},
    catalog | String | default = "apps.keylos.org",
    build | { jobs | Number | optional, target | [| 'native, 'x86_64, 'aarch64 |] | default = 'native },
    lint | { deny_warnings | Bool | default = false },
    publisher | { id | String | optional, org | String | optional, sigstore | { issuer | String, subject | String } | optional } | default = {},
    container | { default_platform | String | default = "linux/amd64", org_repo | String | optional } | default = {},
  }
}
```

---

## 11. Testing and acceptance

**Unit tests:**
- `package.ncl` → manifest mapping, including `needs.portalIsland`, `needs.listen`, `l10n`, `agent` and entrypoint kinds (golden files).
- Agent template digests against the `manifest/` agent vectors of protocols.
- Rust derive → cmdsig (golden files).
- Lint rules (positive and negative fixtures).
- Records encoding (cbor-seq, TSV escaping).
- Secret delivery reader against both layouts (`memfd_secret` and sealed memfd), including values that span pages.

**API suite:** `tests/api/*.yaml` run against `kl-sim` for Rust, C, Python, Go and Node.

**Fuzz targets:**

| Target | Input |
|---|---|
| `fuzz_records_in` | CBOR sequences against schemas |
| `fuzz_package_ncl` | Package descriptions |
| `fuzz_env_parse` | `KEYLOS_CAPWIRE_FDS` / `KEYLOS_ARGFD_*` values |
| `fuzz_secret_layout` | Arbitrary memfd contents for the secret reader |

**Conformance:** protocols vectors `manifest/`, `ids/`, `dsse/` (signing), `capwire/` (client side, including the vsock profile).

**Acceptance tests:**

| ID | Test | Pass criterion |
|---|---|---|
| AT-SDK-01 | `kl-sdk init cli-rust && kl-sdk build && kl-sdk run -- --help` | Works in a fresh workbench with networking only for the declared registries |
| AT-SDK-02 | The generated cmdsig for the template CLI, used by `kish` | `kish` passes an fd for a `file` argument; the program reads it without a path |
| AT-SDK-03 | Pipe `tool-a \| tool-b` where both declare `records` | `KEYLOS_PIPE_*=cbor-seq` set; records round-trip with typed values |
| AT-SDK-04 | A scenario with an `email.send` effect approved | The receipts subsequence matches; the committed effect is in the sim outbox |
| AT-SDK-05 | `kl-sdk publish --dry-run` with an env var named `API_TOKEN` in package.ncl | Lint error KL001; exit 1 |
| AT-SDK-06 | `gui-gtk-portal` template file open | The GTK file chooser opens the keylos powerbox through the island; the app receives a path under `/grants/` |
| AT-SDK-07 | Agent template pack with a tool given by name | `tools.json` contains the resolved `gen:` ref and per-tool digest; changing the tool changes the template digest |
| AT-SDK-08 | Renderer exceeding fuel | `test-renderer` exits 4 with `fuel exhausted` |
| AT-SDK-09 | Scenario with `notifications.activate` | The app's `on_action` callback runs with the action id |
| AT-SDK-10 | `service-rust` template under the sim | `Bootstrap.host` then `ready`; a call on a facet that does not allow it fails `kl:denied`; `reload` reaches `ServiceImpl::reload` |
| AT-SDK-11 | Agent template with a remote MCP server and no pin | `kl-sdk pack` fails; after `pin-mcp`, the `toolsDigest` matches the `protocols §6.4` rule |
| AT-SDK-12 | `kl-sdk seal` twice within one window | One presence touch on the trusted path; both generations sealed |
| AT-SDK-13 | `package.ncl` with `webapp = {origin = "https://app.example.com", …}` | Manifest has `webapp`, no `needs.jit`, a `needs.network` entry for `app.example.com:443`; KL018 fires when `needs.jit` is added |
| AT-SDK-14 | `needs.gpu = 'passthrough` on a `'t1` app | KL019 error; accepted with `tier = 't2` |
| AT-SDK-15 | Agent template with `vm.desktop = true` and the default `bench_image` | Pack fails (KL023: the image's `benchImage.desktop` is false); with an image whose manifest has `benchImage {purposes: [agentDesktop], desktop: true}` it succeeds and `template.json` has `vm.desktop: true`; the image's name plays no part |
| AT-SDK-16 | Remote model with `min_version`; local model with `weights` | `template.json` has `minVersion` and the `weights` `gen:` ref; a model without `min_version` gives KL022 |
| AT-SDK-17 | `app.http()` against a sim grant whose `net` fact has `$method = "GET"` | The sim gate receives plain HTTP/1.1 with an absolute-form target; no TLS ClientHello is sent; with `$method = "*"` a TLS handshake happens |
| AT-SDK-18 | `kl-sdk publisher onboard --fido2` | Request JSON and a DSSE proof that verifies with the hardware key; no private key material in the output directory |
| AT-SDK-19 | `kl-sdk catalog submit` | Envelope signed by the publisher key; `catalog status` against the sim shows `unreviewed` then `reviewed-reproducible` after the sim quorum |
| AT-SDK-20 | `kl-sdk container sign` on a fixture image | Two conversions produce the same digest, equal to depot's conformance vector; the genstmt verifies with the org-publisher key |
| AT-SDK-21 | `kind = 'kmod` outside the release pipeline | Refused (KL025, REQ-SDK-009) |
| AT-SDK-22 | Service `routes` with `warden#spawn` | KL026 error naming the registered replacement facet |
| AT-SDK-23 | `kind = 'bench-image` package with `bench_image = {purposes = ['media]}` | Manifest `benchImage: {purposes: ["media"], desktop: false}`; without `bench_image` KL027 |
| AT-SDK-24 | `kl-sdk container sign` on a fixture OCI image | The `name`, `version` and `drv` equal those `keylos-oci-convert` and depot compute for the same image (protocols conversion vectors); `container` digest identical across two runs |
| AT-SDK-25 | A GUI app saves to a media place through `app.save_file` under the sim | On close the sim's portal-files receives `MediaSave.finish(relPath)`; on a write error it receives `cancel` |

---

## 12. Implementation notes

| Crate | Use |
|---|---|
| `clap` 4 + `syn` 2 / `quote` 1 | Derive |
| `ciborium` 0.2 | CBOR |
| `tracing` 0.1 | Logging |
| `zeroize` 1, `memsec` 0.7 | Secrets |
| `reqwest` 0.12 | Custom connector |
| `pyo3` 0.22, `napi` 2 | Bindings |
| `cbindgen` 0.27 | C header |
| `wasmtime` 25 | Renderer runner |
| `oci-client` 0.12, `sigstore` 0.10 | Publish |
| `nickel-lang-core` 0.9 | Package evaluation |
| `tokio-vsock` 0.5 | Harness client |
| `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-biscuit` 1.0.0 | Contracts |

**Repository layout:**

```
sdk/
  crates/keylos-sdk/  crates/keylos-sdk-macros/  crates/libkeylos/  crates/kl-sdk/  crates/kl-sim/
  bindings/python/  bindings/go/  bindings/node/
  nickel/package.ncl  nickel/scenario.ncl
  templates/{gui-rust,gui-gtk-portal,cli-rust,cli-python,cli-go,service-rust,agent-template,effect-renderer}/
  wit/keylos-effects.wit       (byte-identical to protocols §20.15)
  tests/api/  tests/golden/
  recipes/            forge recipes for the sdk, sim and portal-island generations
```

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reason |
|---|---|---|
| Nickel `package.ncl` as the single source ([ADR-0021](../../handbook/11-decisions/adr-0021-nickel-configuration.md)) | Hand-written JSON manifests; TOML | Typed contracts, one language with system config, and generated manifests can't drift |
| Signatures derived from the argument parser ([ADR-0036](../../handbook/11-decisions/adr-0036-typed-pipes-via-cmdsig.md)) | Separate hand-maintained cmdsig | Correctness: the shell's fd passing depends on it |
| Builds always in workbenches ([ADR-0009](../../handbook/11-decisions/adr-0009-unsealed-code-in-workbenches.md)) | Host builds | Build tools are unsealed code |
| Catalogue requires rebuilder reproduction ([ADR-0016](../../handbook/11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md)) | Publisher signature only | A single compromised builder or publisher machine cannot ship |
| Tools and MCP lists pinned in templates ([ADR-0030](../../handbook/11-decisions/adr-0030-pinned-agent-tools.md)) | Tools resolved at run time | Prevents rug-pulls |
| Portal island inside the app principal ([ADR-0035](../../handbook/11-decisions/adr-0035-fd-only-portals-dbus-islands.md)) | Patch every toolkit | Works with unmodified GTK/Qt with zero extra authority |
| Effect renderers as WASI components | Renderers in gate's codebase | Extensible effect kinds without growing the TCB with native code |
| Sealing delegated to `forge` | The sdk calling `HearthSeal` itself | Only `depot` and `forge` hold `hearth#seal` (`protocols §19.2`); the sdk stays an unprivileged client |

### 13.1 Dependencies and open points

- `depot` publishes the crate `keylos-oci-convert` implementing `oci-convert/1` (`protocols §21.4`, §18); `kl-sdk container sign` depends on it so org publishers and depot compute identical digests.
- The publisher-onboarding request (`keylos.publisher-request/1`) is consumed only by onboarding tooling in this repository; how the project's onboarding process receives it is operational, not a protocol.
- Agent-desktop images are recognised by the manifest marker `benchImage.desktop: true` (`protocols §6.3`), never by name.
- Media saves (REQ-SDK-036) end with `portal-files`' `MediaSave` from `portals-extra.capnp` (`protocols §7.5.20`, Appendix A); the SDK uses the generated `keylos-schemas` binding.

---

## Appendix A — Embedded contracts (verbatim)

Each block below is copied verbatim, by mechanical extraction, from `protocols/spec.md` of **keylos-protocols 1.0.0 (final)**. Only the section's own heading line is replaced by the `A.n` heading. Table excerpts keep the header rows and the rows relevant to this repository. If a copy differs from protocols, protocols wins.

### A.1 `protocols §3.3` — Names

- **Generation names** use reverse-DNS: `org.example.Editor`. The pattern is `^[a-z][a-z0-9-]*(\.[a-zA-Z0-9-]+){2,}$`, at most 255 characters. The prefixes `io.keylos.` and `org.keylos.` are reserved for the project.
- **Service names** are `[a-z][a-z0-9-]{0,62}` (for example `vault`, `portal-files`). The registry is §19.1.
- **Facet names** are `[a-z][a-z0-9-]{0,31}`. The registry is §19.2.
- **Usernames** are `[a-z_][a-z0-9_-]{0,31}`. `_system` and `_cluster` are reserved, and the prefix `guest-` is reserved for ephemeral guest sessions (`guest-<8 lowercase base32>`, created and destroyed by `hearth`).
- **Kubernetes names**: `pod-ns` and `pod-name` follow Kubernetes DNS-1123 label / subdomain rules (`[a-z0-9]([-a-z0-9]*[a-z0-9])?`, ≤ 63 and ≤ 253 characters).

### A.2 `protocols §3.4` — Principal identifiers

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

### A.3 `protocols §5.1` — Envelope

Every signed keylos document is a **DSSE envelope** (Dead Simple Signing Envelope v1.0):

```json
{"payloadType": "<media type>", "payload": "<base64>", "signatures": [{"keyid": "key:sha256:…", "sig": "<base64>", "alg": "ed25519"}]}
```

Rules:
- `alg` is a keylos extension field inside each signature object. DSSE verifiers that ignore unknown fields stay compatible.
- **Payloads** are JSON canonicalized with RFC 8785 (JCS), UTF-8 encoded.
- Media types have the form `application/vnd.keylos.<doc>+json; version=<major>`. The registry is §19.4.
- Signers MUST sign the DSSE PAE encoding. Verifiers MUST recompute the JCS form of the decoded payload and reject if it differs from the payload bytes. That rule forbids non-canonical payloads.
- Every `application/vnd.keylos.*` payload has a `schema` field of the form `keylos.<doc>/<major>` matching its media type (in-toto statements, §11.4, carry none).
- Base64 is the standard alphabet with canonical padding; non-canonical encodings are rejected.
- **Envelope bytes.** Wherever this document hashes "the envelope" (`rcpt:` refs, owner-registry `prev`, `windowDigest`, `mandateDigest`), the bytes are the **JCS** of `{"payloadType","payload","signatures":[{"keyid","alg","sig", …}]}`; stored envelopes (e.g. `owners.log` lines) MUST be in that form.
- **Unknown algorithms.** A signature with an unknown `alg` never counts; an envelope verifies when enough known-algorithm signatures by distinct keys verify (§4).
- Unknown members of every keylos document (any nesting level) are rejected unless prefixed `x-`.

### A.4 `protocols §6.1` — Generation kinds

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

### A.5 `protocols §6.2` — Layout

A generation is an EROFS image in composefs format:
- Every **non-empty** regular file is an overlay metacopy whose redirect names a store object, with the fs-verity digest of that object in `trusted.overlay.metacopy`.
- Zero-length regular files are stored inline in the EROFS image with no redirect.

The image root MUST contain `/.keylos/manifest.json`. It MAY contain:
- `/.keylos/cmdsig/<command>.json` (command signatures, §12)
- `/.keylos/sbom.spdx.json` (SPDX 2.3 or 3.0 JSON)
- `/.keylos/provenance.json` (the realisation attestations bundle, §11.3)
- `/.keylos/agent/` (agent templates only, §6.4)
- `/.keylos/l10n/<lang>.json` (localised strings, §6.3)

### A.6 `protocols §6.3` — Manifest schema (`keylos.manifest/1`)

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

### A.7 `protocols §6.4` — Agent templates

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

### A.8 `protocols §7.1` — Model

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

### A.9 `protocols §7.2` — Routes and facets

`warden` wires services according to **routes** declared in service and app manifests plus policy.

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

- A **facet** is a server-defined restriction name. The registry of every facet, its holders and the methods it allows is §19.2. Servers MUST refuse methods their facet doesn't allow with `kl:denied`.
- Route references are written `service#facet` (for example `vault#app`).
- The server learns the facet of each connection from `ServiceHost.accept` (§7.5.1) or `Supervisor.connectionInfo`.
- Service sockets live under `/run/keylos/svc/<service>/` with mode `0700`, owned by `warden`'s UID. No other principal can `connect()` to them. Connections are created by `warden` (`socketpair` + hand-off through `ServiceHost.accept`).
- Dynamic routes (a service capability granted at runtime) are materialised by `broker` through `ServiceConnect.connectService` (§7.5.1).

### A.10 `protocols §7.2.1` — capwire-vsock profile (host ↔ guest)

Between a VM guest and the host, capwire runs over **`AF_VSOCK` `SOCK_SEQPACKET`** with these differences:
1. **No fd passing.** `Fd` fields MUST NOT appear in messages on this profile; receivers MUST reject them.
2. Bulk data uses `ByteStream`/`ByteSource` capabilities, or dedicated vsock stream connections on the bulk port range (§19.5) announced in messages.
3. **Authentication.** The host identifies the VM by its vsock CID, which `bench` assigns uniquely per running VM (CID ≥ 3). The guest is never trusted for identity claims; every host-side endpoint is bound to exactly one VM principal.
4. Ports are registered in §19.5. The guest initiates every connection to host CID 2.

### A.11 `protocols §7.3.1` — `common.capnp`

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

### A.12 `protocols §7.3.3` — `broker.capnp`

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

### A.13 `protocols §7.3.6` — `vault.capnp`

```capnp
@0xc7a1e5d3b2f40006;
using C = import "common.capnp";

struct ItemAcl {
  actors  @0 :List(Text);        # actor patterns, e.g. "app:gen:fsv256:…", "app:name=org.example.Editor"
  ops     @1 :List(Op);
  prompt  @2 :PromptPolicy;
  enum Op { read @0; use @1; update @2; delete @3; }
  enum PromptPolicy { never @0; perSession @1; always @2; presence @3; }
}

struct ItemInfo { name @0 :Text; kind @1 :Text; created @2 :C.Timestamp; acl @3 :ItemAcl; }

interface Vault {
  open    @0 (name :Text, purpose :Text) -> (secret :C.Fd);       #! delivery format §20.10 (memfd_secret, mmap-only, length-prefixed)
  store   @1 (name :Text, kind :Text, value :C.Fd, acl :ItemAcl) -> ();   # value.index 0xFFFF = ACL-only update
  delete  @2 (name :Text) -> ();
  list    @3 () -> (items :List(ItemInfo));
  sign    @4 (name :Text, alg :Text, data :Data) -> (signature :Data);   # key never leaves vault
  sshAgent @5 () -> (socket :C.Fd);                                     # per-principal SSH agent protocol socket
  dataKey @6 (unit :Text) -> (key :C.Fd);                                # crypto-shred unit key (facets strata, ledger, gate, aide, journal, loom; each only for its own unit prefix)
  forget  @7 (unit :Text) -> ();                                         # destroy unit key (same facets)
  inject  @8 (name :Text, target :Text) -> (handle :Data);              # facet gate only: opaque handle for credential injection
}
```

An injection handle is redeemed by `gate` with `open("inject:<hex handle>", purpose)` on facet `gate`.

### A.14 `protocols §7.3.7` — `gate.capnp`

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

### A.15 `protocols §7.3.14` — `aide.capnp`

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

### A.16 `protocols §7.3.15` — `net.capnp`, `devd.capnp`, `journal.capnp`, `portals.capnp`, `compat.capnp`

```capnp
@0xc7a1e5d3b2f40015;   # net.capnp
using C = import "common.capnp";
struct Link { name @0 :Text; kind @1 :Text; state @2 :Text; addresses @3 :List(Text); metered @4 :Bool; }
struct WifiNetwork { ssid @0 :Text; security @1 :Text; signal @2 :Int16; known @3 :Bool; }
interface Net {
  links     @0 () -> (list :List(Link));
  wifiScan  @1 () -> (list :List(WifiNetwork));
  wifiJoin  @2 (ssid :Text, credential :C.Fd) -> ();    #! facet user only; credential stored via vault
  vpnUp     @3 (profile :Text) -> ();                   #! facet user only
  vpnDown   @4 (profile :Text) -> ();                   #! facet user only
  resolve   @5 (name :Text) -> (addresses :List(Text), dnssec :Bool);
  time      @6 () -> (synced :Bool, offsetNanos :Int64, source :Text);
  status    @7 () -> (json :Text);
}
```

```capnp
@0xc7a1e5d3b2f40016;   # devd.capnp
using C = import "common.capnp";
struct Device { id @0 :Text; subsystem @1 :Text; name @2 :Text; properties @3 :List(C.KeyValue); }
interface Devd {
  list   @0 (subsystem :Text) -> (list :List(Device));
  open   @1 (id :Text, token :C.Token, flags :UInt32) -> (fd :C.Fd);   # facet broker; callers use broker.materialize
  watch  @2 (subsystem :Text, watcher :C.Watcher(Device)) -> (cancel :C.Cancelable);
  power  @3 (op :Text) -> ();                                         # "suspend" | "poweroff" | "reboot" (hibernate: kl:unsupported)
}
```

```capnp
@0xc7a1e5d3b2f40017;   # journal.capnp
using C = import "common.capnp";
struct Entry { time @0 :C.Timestamp; principal @1 :C.PrincipalId; level @2 :UInt8; message @3 :Text; fields @4 :List(C.KeyValue); }
interface Journal {
  writer @0 () -> (stream :C.Fd);                                  # SOCK_SEQPACKET, protocols §10.6 record format; attributed to the caller
  query  @1 (filterJson :Text, limit :UInt32) -> (entries :List(Entry), cursor :Text);
  follow @2 (filterJson :Text, watcher :C.Watcher(Entry)) -> (cancel :C.Cancelable);
}
```

```capnp
@0xc7a1e5d3b2f40018;   # portals.capnp
using C = import "common.capnp";
struct CaptureStream { nodeId @0 :UInt32; width @1 :UInt32; height @2 :UInt32; sourceDescription @3 :Text; }
interface ScreenCapture { start @0 (kind :Text) -> (streams :List(CaptureStream), remote :C.Fd); }   # remote = PipeWire remote fd restricted to the nodes
interface Camera        { open @0 () -> (remote :C.Fd); }
interface Microphone    { open @0 () -> (remote :C.Fd); }
interface OpenUri       { open @0 (uri :Text) -> (); openFile @1 (file :C.Fd) -> (); }
interface NotifyHandler { activated @0 (id :UInt32, action :Text) -> (); }
interface Notify        { post @0 (title :Text, body :Text, actions :List(Text), handler :NotifyHandler) -> (id :UInt32); close @1 (id :UInt32) -> (); }
  #! handler is optional; when null, activation spawns the app's "notify-action" entrypoint with the action id as argv[1]
interface Print         { print @0 (document :C.Fd, mime :Text, optionsJson :Text) -> (jobId :Text); }
interface Clipboard     { read @0 (mime :Text) -> (data :C.Fd); write @1 (mime :Text, data :C.Fd) -> (); }
interface Location      { current @0 (accuracy :Text) -> (lat :Float64, lon :Float64, accuracyM :Float64); }
interface Accessibility { observe @0 () -> (observer :Capability); }    # returns an A11yObserver (§7.5.17); assistive-tech principals only
struct ServiceInstance { name @0 :Text; type @1 :Text; host @2 :Text; port @3 :UInt16; addresses @4 :List(Text); txt @5 :List(C.KeyValue); }
interface Discovery {                                                    # portal-discovery (mDNS / DNS-SD)
  browse  @0 (serviceType :Text, watcher :C.Watcher(ServiceInstance)) -> (cancel :C.Cancelable);   #! results raise the caller's label to integ untrusted
  publish @1 (instance :Text, serviceType :Text, port :UInt16, txt :List(C.KeyValue)) -> (handle :C.Cancelable);
      #! requires a listen grant for port (needs.listen scope lan) and a publish grant; on the local link only
}
struct ScanOptions { resolutionDpi @0 :UInt16; mode @1 :Text; source @2 :Text; format @3 :Text; }   # mode: color|gray|lineart; format: png|pdf|jpeg
interface Scan {                                                         # portal-scan (SANE backends in a compat island)
  scanners @0 () -> (list :List(Text));
  scan     @1 (scanner :Text, options :ScanOptions) -> (image :C.Fd);    #! trusted-path confirmation per scan; result labelled public/user
}
```

```capnp
@0xc7a1e5d3b2f40019;   # compat.capnp
using C = import "common.capnp";
using W = import "warden.capnp";
interface Compat {
  importImage @0 (source :Text) -> (generation :C.Ref);   # "oci://…", "flatpak://remote/ref", "distro:<name>:<release>", "rootfs:<dirfd>"
  run         @1 (generation :C.Ref, argv :List(Text), fds :List(W.FdMapping), grants :List(C.Token)) -> (process :W.Process);
}
```

### A.17 `protocols §7.5.1` — `warden-sys.capnp`

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

### A.18 `protocols §7.5.13` — `aide-sys.capnp`

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

### A.19 `protocols §7.5.20` — `portals-extra.capnp`

```capnp
@0xc7a1e5d3b2f40033;
using C = import "common.capnp";

interface Background {
  request @0 (reason :Text, autostart :Bool, entrypoint :Text) -> (granted :Bool);
  status  @1 () -> (granted :Bool, autostart :Bool);
}

interface GlobalShortcuts {
  bind   @0 (shortcuts :List(C.KeyValue)) -> (bound :List(C.KeyValue));
  events @1 (watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);
  unbind @2 (ids :List(Text)) -> ();
}

interface Inhibit {
  inhibit @0 (kinds :List(Text), reason :Text) -> (handle :C.Cancelable);   # kinds: "idle","suspend","logout","lid"
}

interface MediaSave {                    # portal-files, facet default (apps, via the SDK)
  finish @0 (relPath :Text) -> ();       # the caller finished a seekable save it received for removable media; portal-files completes the export
  cancel @1 (relPath :Text) -> ();       # discard the save (ExportCompletion.abort)
}
```

### A.20 `protocols §10.5` — Environment conventions

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

### A.21 `protocols §10.6` — Log records

Processes write logs to the journal stream fd (fd 2 is connected to it by default) as:
- plain text lines, or
- **structured records**: a datagram whose first byte is `0x1E` followed by a CBOR map with keys `l` (level 0–7), `m` (message) and `f` (fields map), or
- **metrics records**: a datagram whose first byte is `0x1F` followed by a CBOR map with keys `n` (metric name), `t` (`"counter"` | `"gauge"` | `"histogram"`), `v` (number, or for histograms a map of bucket bound → count plus `sum` and `count`) and `l` (labels map).

### A.22 `protocols §12` — Command signatures (`keylos.cmdsig/1`)

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

### A.23 `protocols §12.1` — Argument fd passing

For each `file` or `dir` argument, the shell passes an fd and replaces the argument text with `/dev/fd/<n>`. It also sets `KEYLOS_ARGFD_<argname>=<n>[,<n>…]`.

Native programs SHOULD use the fd environment variables. Legacy programs simply open `/dev/fd/<n>`.

### A.24 `protocols §12.2` — Pipe protocol

Pipes negotiate their format **statically**: the shell knows both ends' signatures.
- If the producer's `output.type` is `records` and the consumer's `input.type` is `records` (or `any`), the shell sets `KEYLOS_PIPE_OUT=cbor-seq` on the producer and `KEYLOS_PIPE_IN=cbor-seq` on the consumer.
- In that mode, records are an RFC 8742 CBOR sequence of maps that conform to the declared schema.
- In every other case the pipe carries bytes, and records are rendered as text by the producer's text formatter (TSV for `records` unless `--format` is given).

### A.25 `protocols §14.2` — Effect kinds

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

### A.26 `protocols §14.3` — Approval tiers

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

### A.27 `protocols §19.2` — Facets

Every route names exactly one facet. Servers MUST implement exactly these facets; holders other than those listed are routed only when policy explicitly grants `right("service", "<svc>#<facet>", "use")`.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| warden | `client` | every principal | `Supervisor.spawn` (child of caller's session), `identify` |
| warden | `service` | tier-0 services | `Supervisor.spawn`, `identify`, `connectionInfo`; `FdStore`. `SpawnSpec.attempt` only from `loom` |
| warden | `admin` | owner `shell`, config, courier, devd, atrium | all `Supervisor` (including `control("_system", poweroff\|reboot)`); `PrincipalControl` |
| warden | `broker` | broker | `GrantMounts`, `PrincipalControl`, `ServiceConnect`, `DebugAttach` |
| warden | `compat` | compat | `LegacySpawn`; `GrantMounts.idmappedDir`; `Supervisor.spawn` (compat generation entrypoints only) |
| warden | `bench` | bench | `VmSpawn` (VM principals; `spawnVmm` for per-VM `crosvm` device processes, `bench-net` wired to `gate#shim`, `bench-relay` wired to `aide#host`, `broker#principal`, `vault#app` and `portal-*#default`); `GrantMounts.idmappedDir` |
| warden | `strata` | strata | `PrincipalControl.events`, `mountView`, `fenceWriters` (`WriterFence`) |
| warden | `hearth` | hearth | `PrincipalControl.terminate` (sessions of the locking human) |
| warden | `portals` | portal-files, portal-openuri | `GrantMounts.attachGrant`/`detachGrant` for portal-island grants and single-file views (§7.3.3) |
| warden | `launcher` | atrium launcher | `UserSpawn` |
| warden | `handler` | portal-openuri, portal-notify, portal-background | `UserSpawn` |
| warden | `trusted-terminal` | atrium-term | `TrustedSpawn` |
| warden | `cri` | cri | `PodSpawn`; `GrantMounts.idmappedDir`; `PrincipalControl.terminate`/`events` (pod sessions only) |
| broker | `principal` | every principal | `Broker` |
| broker | `system` | warden, gate, aide, atrium, config, hearth, strata, net, depot, vault, vouch, cri | `BrokerSystem` (per-method callers as commented in §7.5.2; `requestFor` with the allowed-subject rule, atrium only for its own session (device authorization); `registerApprover`: atrium, vouch; `admitPod`: cri; `mintCaptive`: net); `Broker.inspect` |
| broker | `label-authority` | gate, bench, portal-*, atrium, strata, aide, journal, warden | `LabelAuthority` |
| broker | `workflow` | loom, gate, aide, strata, bench | `BrokerWorkflow` (§7.5.25): `enroll`, `claim`, `decide`, `rebind`, `resume`, `cancel`, `cancelDecision`, `record`, `raise`: loom; `authorizeEffect`, `verify`, `record`, `cancelDecision`: gate; `offer`, `verify`, `decide`, `rebind`: aide (its agent attempts); `verify`, `record`: strata, bench |
| ledger | `writer` | tier-0 services listed as writers in §19.3 | `Ledger` (all) |
| ledger | `reader` | every principal | `Ledger` except `append` (filtered, §7.3.5) |
| ledger | `witness` | vouch, fleet | `LedgerWitness` |
| ledger | `admin` | owner `shell` | `LedgerAdmin` (including `shred`) |
| ledger | `time` | net, warden, depot | `LedgerAdmin.timeFloor` |
| ledger | `vouch-heartbeat` | vouch | `Ledger.query`/`watch` restricted to metadata (time, subject human) of `user.login` receipts of every human (§20.19) |
| ledger | `fleet-export` | fleet | `LedgerAdmin.export` (metadata only unless an owner `fleet-receipt-access` exception covers the event type) |
| vault | `app` | apps (per `needs.secrets`), `shell`, legacy, bench-relay (for its VM principal, §7.5.10 `GuestPortals.secret`) | `open`, `store`, `delete`, `list`, `sign`, `sshAgent` (own items) |
| vault | `admin` | owner `shell` | all `app` methods incl. ACL updates |
| vault | `broker` | broker | `open` on behalf of a principal |
| vault | `gate` | gate | `inject`, `open("inject:…")`, `dataKey`/`forget` for `gate:` units |
| vault | `strata` | strata | `dataKey`, `forget` |
| vault | `ledger` | ledger | `dataKey`, `forget` for `ledger:` units |
| vault | `aide` | aide | `store`/`delete`/`sign` of session keys; `dataKey`/`forget` for `aide:` units |
| vault | `hearth` | hearth | `VaultUsers` |
| vault | `net` | net | `open`/`store` of `_system` items of kinds `wifi` and `token` |
| vault | `adapter` | compat | `store` (import from legacy secret stores, on the human's behalf, with prompt) |
| vault | `journal` | journal | `dataKey`, `forget` for `journal:` units |
| vault | `loom` | loom | `dataKey`, `forget` for `loom:` units |
| hearth | `greeter` | atrium greeter and lock screen | `users`, `login`, `unlock`, `lock` |
| hearth | `presence` | broker, config, depot, courier, ledger, vault, aide, strata | `presence`; `HearthQuorum.request`/`collect` |
| hearth | `atrium` | atrium | `presence` (prompt already shown by atrium) |
| hearth | `admin` | owner `shell`, atrium settings | all `Hearth`; `HearthAdmin` (including `setQuorumPolicy`); `HearthQuorum.collect`, `list` |
| hearth | `system` | warden, devd, config, broker, gate, vouch, strata, bench, depot, ledger, loom | `HearthSystem` (gate, vouch, strata, bench, depot, ledger: `owners` only; loom: `owners`, `userState`, `watchUsers`) |
| hearth | `seal` | depot, forge | `HearthSeal` |
| hearth | `tpm` | courier, vault, strata, ledger, config, vouch, fleet | `HearthTpm` (`defineSpace`, `recreateKey`: the object's registered owner; `sbSign`, `sbAccepted`: courier; `activateCredential`: vouch, fleet) |
| hearth | `quorum` | fleet | `HearthQuorum.submit`, `list` |
| hearth | `fleet-lock` | fleet | `HearthFleet` |
| gate | `client` | principals with net needs, portal-files, atrium (staging `media.export`) | `connect`, `stage` (own session), `intents` (own session tree, recursive), `intent` (own session tree), `meter` (own roots); `DurableEffects.prepare`, `complete`, `lookup`, `watch` (attempt sessions, own workflow) |
| gate | `broker` | broker | `connect` and `stage` for the token holder; `GateMeterAdmin`; `WorkflowBudget.open`, `close`, `status` |
| gate | `shim` | per-principal endpoints created by warden (tier L) and bench (bench-net per VM) | `ShimEndpoint` |
| gate | `meter` | aide, configured model clients | `charge`, `meter` |
| gate | `aide` | aide | `connect`, `stage` for agent sessions (§7.3.7), `intents`, `meter`; `DurableEffects.prepare`, `complete`, `lookup`, `watch` and `WorkflowBudget.reserve`, `settle`, `release`, `status` for agent attempt sessions |
| gate | `admin` | owner `shell`, atrium | `intents`, `meter` (any session) |
| gate | `debug` | warden, atrium, owner `shell` | `GateDebug` |
| gate | `loom` | loom | `DurableEffects` (all except `prepare`), `WorkflowBudget` (`reserve`, `settle`, `release`, `status`) (§7.5.25) |
| net | `user` | owner `shell`, atrium | `Net` (all); `NetWatch` |
| net | `status` | tier 0; apps declaring `net-status` | `links` (redacted), `time`, `status`; `NetWatch` |
| net | `resolver` | gate, tier-0 services with network needs | `resolve`; `NetResolver`; `NetWatch` |
| net | `captive` | atrium | `NetCaptive` (`status`, `portalUrl`, `signIn`); `NetWatch` |
| net | `plumbing` | warden, gate, cri | `NetPlumbing` (`setEgressUids`, `setLocalLinkUids`: warden; `setListenPorts`: gate); `NetPlumbingCluster` (`clusterUplink`: cri; `clusterNetns`: warden) |
| net | `discovery` | portal-discovery | `NetDiscovery` |
| aide | `user` | human `shell`s, atrium | `Aide` (own human's sessions) |
| aide | `host` | one per agent VM (vsock 7002 forward by bench-relay) | `AgentHost`, `AgentHostExt` (incl. `desktop`), `VmExec` |
| aide | `admin` | owner `shell` | `Aide` (all humans, read), aide-local admin |
| aide | `grant-delegate` | bench | `GrantDelegate` |
| aide | `loom` | loom | `AgentWorkflowHost` (§7.5.25) |
| depot | `user` | `shell`, atrium, aide, portal-openuri, portal-discovery, gate, any principal granted `depot#user` | `get`, `list`, `install`, `verify`, `revocations`, `revocationStatus`, `openObject` (closures the caller may spawn), `openPath` (`/.keylos/…` only) |
| depot | `mounter` | warden, bench, compat | `mount` (container generations only while rooted by `cri:pod:…`), `get`, `root`, `unroot`, `revocationStatus` |
| depot | `forge` | forge | `importTree`, `seal`, `get` |
| depot | `config` | config | `importTree` (kinds `config`, `policy`), `mount` (kind `config`), `get` |
| depot | `compat` | compat | `importTree` (kind `legacy-image`), `get`, `revocationStatus` |
| depot | `courier` | courier | `install`, `root`, `unroot`, `get`, `list`, `revocations` |
| depot | `cri` | cri | `install` (sources `oci+container://` and `tuf:`), `get`, `list`, `root`, `unroot` |
| depot | `admin` | config, owner `shell` (T3) | all incl. `gc` |
| depot | `loom` | loom | `get`, `openPath` (`/.keylos/manifest.json`, `/.keylos/workflows/*`), `revocationStatus`, `root`/`unroot` (holder prefix `loom:` only) |
| courier | `client` | humans' `shell`s, atrium | `check`, `status` |
| courier | `admin` | owner `shell`, atrium settings, config | `Courier` (all) |
| courier | `depot` | depot | `CourierResolver` |
| strata | `user` | `shell`, apps with the route, kish | `begin`, `snapshot`/`snapshots`/`restore`/`undo` (own), `why`, `createUnit` (own home subtree); `StrataTxn` |
| strata | `cli` | the strata CLI under `shell` | as `user`, plus `forget` (own units, presence) |
| strata | `bench` | bench | `begin`; `StrataTxn` (including `preparedFor`); `TransactionExt.bindWorkflow` |
| strata | `aide` | aide | `begin`; `StrataTxn` (including `preparedFor`); `TransactionExt.bindWorkflow` |
| strata | `compat` | compat | `createUnit`, `forget` for `app/*` units of legacy apps |
| strata | `warden` | warden | `StrataAdmin.mountUnit` (lazy creation of app units); `StrataTxn` (to mount `SpawnSpec.transaction` views after the owner check) |
| strata | `hearth` | hearth | `StrataHomes`; `StrataAdmin.lockUnits`/`unlockUnits` |
| strata | `courier` | courier | `StrataAdmin.preUpdate` |
| strata | `gate` | gate | `Strata.undo` (fs.merge compensation only) |
| strata | `cri` | cri | `StrataVolumes` |
| strata | `admin` | config, owner `shell` | all; `StrataAdmin` |
| config | `owner` | owner `shell` | all, incl. `Plan.apply` |
| config | `user` | non-owner `shell`s | `current`, `history`, `drift`, `adopt` (own apps), `propose` |
| config | `propose` | aide | `propose` (with origin), `current` |
| config | `fleet` | fleet | `ConfigFleet`, `current`, `drift` |
| config | `read` | courier, journal | `current`, `history` |
| forge | `user` | `shell` | forge-local build interface |
| forge | `release` | release-engineering principals only | forge-local graft operations |
| devd | `client` | every principal | `list`, `watch` (filtered); `PowerEvents.subscribe` |
| devd | `broker` | broker | `open`; `DeviceAdmin` |
| devd | `warden` | warden | `DeviceAdmin` |
| devd | `service` | hearth, strata, atrium, portal-inhibit | `PowerEvents` (subscribe + ack) |
| devd | `atrium` | atrium | `Backlight` |
| devd | `authorize` | atrium | `DeviceAdmin.authorize`, `deauthorize`, `pending` |
| devd | `bench` | bench | `MediaAttach` |
| devd | `cri` | cri | `MediaAttach` |
| devd | `admin` | atrium settings, owner `shell` | all incl. `power`; `Bluetooth` |
| journal | `client` | every principal | `writer`, `query`/`follow` (own), `Crashes` (own human), `Metrics` (own) |
| journal | `admin` | owner `shell` | all |
| journal | `warden` | warden | `JournalWarden` |
| journal | `fleet` | fleet | `Metrics` (aggregate, no user data) |
| bench | `user` | kish, `work`, atrium, portal-files, forge | `project`, `start` (purposes workbench; build (forge only, `unsignedImageOk`); app (kish, atrium launcher: non-reproducible native apps at tier 2)), `snapshots`, `media` (atrium, portal-files), `reattach` (own VMs) |
| bench | `net` | net | `start` (purpose captive only), `Vm.info`, `Vm.stop` |
| bench | `aide` | aide | all (including `fork` with `ForkSpec`, `reattach`); VMs get actor kind `agent` |
| bench | `compat` | compat | `start` with `display=true` for tier-2 legacy apps |
| bench | `merge` | gate, aide | `BenchMerge` (`commitShare`, `commitPrepared`: gate only; `preparedStatus`: gate, aide) |
| bench | `cri` | cri | `start` (purpose pod), `reattach`, `Vm` (all, including `attachShare`/`detachShare`, `attachBlock`/`detachBlock`, `info`) |
| bench | `admin` | owner `shell`, config | all, bench-local admin |
| compat | `user` | kish, atrium launcher | `importImage`, `run` (own apps) |
| compat | `service` | warden routes for legacy services | `run` of tier-L legacy services |
| compat | `adapter` | devd, portal-print, portal-scan, vault | `CompatIsland` |
| compat | `admin` | owner `shell` | all, compat-local admin |
| atrium | `approve` | broker | `TrustedPrompt.approve` |
| atrium | `presence` | config, depot, courier, hearth, forge | `TrustedPrompt.presence` |
| atrium | `notify` | tier-0 services, portal-notify | `TrustedPrompt.notify` |
| atrium | `secret` | hearth, vault | `TrustedPrompt.secret` |
| atrium | `broker` | broker | `Display.windowOwner` |
| atrium | `display` | warden, bench, compat | `Display` (`xwaylandWm`: compat only) |
| atrium | `settings` | atrium settings app | `Display.outputs` |
| atrium | `bridge`, `native` | a11y bridge, AccessKit apps | `A11yHost` |
| atrium | `portal-screen`, `portal-shortcuts`, `portal-camera`, `portal-mic`, `portal-location`, `portal-background` | the corresponding portal | `Screencast` / `ShortcutsHost` / `IndicatorHost` |
| atrium | `portal-a11y` | portal-a11y | `A11yGate` |
| atrium | `portal-inhibit` | portal-inhibit | `InhibitHost` |
| atrium | `portal-clipboard` | portal-clipboard | `ClipboardHost` |
| atrium | `ctl` | atrium-ctl | atrium-local control |
| portal-* | `default` | apps declaring the portal in `needs.services`; bench-relay (for its tier-2 VM principal, `GuestPortals`) | the portal's interface (§7.3.15, §7.5.20) |
| portal-files | `broker` | broker | `FilePicker.pick` |
| portal-files | `drop` | atrium | `FilePicker.confirmDrop` |
| portal-mic | `capture`, `playback` | apps with a microphone grant; apps with audio output | `Microphone` |
| portal-a11y | `default` | assistive-technology principals only | `Accessibility` |
| portal-* | `ctl` | portalctl | portal-local control |
| pipewire | `portals` | portal-screen, portal-camera, portal-mic, atrium (creates screencast video nodes) | PipeWire native protocol (upstream); the portals mint restricted remotes for apps |
| fleet | `client` | owner `shell`, atrium | `FleetCompliance.status` |
| fleet | `gate` | gate | `FleetCompliance.complianceToken` |
| fleet | `decider` | broker | `OrgDecider` |
| fleet | `cluster` | cri | `FleetCluster` (`joinChallenge`, `joinAttested`, `clusterCertificate`, `kubeletCertificate`) |
| vouch | `settings` | atrium settings, owner `shell` | `VouchLink` pairing methods, `phones`, `remove`, `inheritance` |
| vouch | `approvals` | atrium | `VouchLink.routeApproval` |
| vouch | `announce` | courier | `VouchLink.announce` |
| cri | `kubelet` | kubelet | CRI v1 gRPC (`RuntimeService`, `ImageService`) over the `AF_UNIX` stream socket (§21) |
| cri | `admin` | owner `shell` | `CriAdmin` (all) |
| cri | `status` | fleet, atrium | `CriAdmin.pods`, `node`, `images` |
| classifier | `broker` | broker | `Classifier` (§7.5.24) |
| loom | `user` | human `shell`s, atrium | `Loom`, `Workflow` (own human's workflows; `enroll` with the caller as owner) |
| loom | `admin` | owner `shell` | `Loom`, `Workflow` for every human (read, `pause`, `cancel`, `forget`); loom-local admin (rollback review) |
| loom | `attempt` | attempt sessions spawned by loom (`SpawnSpec.attempt`) | `AttemptHost`, bound to the connecting attempt session |
| loom | `aide` | aide | `LoomSystem` (§7.5.25) for agent attempts aide started |

### A.28 `protocols §20.7` — Generation statement (`keylos.genstmt/1`)

```json
{"schema":"keylos.genstmt/1","generation":"gen:fsv256:…","kind":"app","name":"org.example.Editor",
 "version":"2.5.0","manifestDigest":"sha256:…","drv":"drv:sha256:…","stream":"stable",
 "objects":"sha256:<digest of sorted object list>","issued":"2026-10-01T00:00:00Z"}
```

`objects` is SHA-256 over the newline-terminated, sorted, lowercase hex fs-verity digests of the closure. Authorising signatures:

| Origin | Signer |
|---|---|
| Distro (OS, runtimes, distro apps, services, bench images, agent templates) | `release-stream/<stream>` |
| Third-party publisher | `publisher/<id>` |
| Owner-sealed | `owner-seal/<i>` (via `HearthSeal.sealSign`), accompanied by a `keylos.seal/1` statement |
| Config and policy | `owner-presence` over `keylos.configgen/1` (the configgen statement is the authorising statement) |

### A.29 `protocols §20.10` — Secret delivery (`Vault.open`)

- **Primary:** a `memfd_secret(FD_CLOEXEC)` fd of the value's length plus 8, rounded up to the page size, laid out as `u64 little-endian length ‖ value ‖ zero padding`. secretmem fds are readable only through `mmap`; recipients map them `PROT_READ`, read the length, use the bytes, and zeroize and unmap on drop (`keylos-vault-client::SecretBuf`).
- **Fallback** (when `memfd_secret` is unavailable): a `memfd_create(MFD_CLOEXEC|MFD_ALLOW_SEALING|MFD_NOEXEC_SEAL)` fd with the same layout, sealed `F_SEAL_WRITE|F_SEAL_SHRINK|F_SEAL_GROW|F_SEAL_SEAL`. The receipt records `data.delivery = "memfd-sealed"`.

### A.30 `protocols §20.15` — Effect renderer components

Policies or apps that register an `x-…` effect kind MAY supply a renderer: a WASI 0.2 component that `gate` runs in Wasmtime with no imports beyond this WIT, fuel 50 million instructions, 64 MiB memory, no filesystem/network/clock, body ≤ 256 KiB, attachment ≤ 8 MiB.

```wit
package keylos:effects@1.0.0;

interface types {
  record arg { name: string, value: string, source: string, conf: u8, integ: u8 }
  record intent { kind: string, class: string, target: string, args: list<arg>, payload: list<u8> }
  record rendering { title: string, body: string, mime: string, attachment: option<list<u8>>, reversible: bool, warnings: list<string> }
  variant render-error { unsupported(string), invalid(string) }
}

world renderer {
  use types.{intent, rendering, render-error};
  export render: func(i: intent) -> result<rendering, render-error>;
}
```

### A.31 `protocols §11.8` — Publishers and catalog

- **Onboarding.** A publisher is added to the TUF `publishers` delegated role (signed by `distro-root` delegation keys) with either an Ed25519 key held in hardware or a Sigstore identity (OIDC issuer + subject) and an accepted publisher policy version. Org publishers are delegated from a fleet's TUF repository (`org-publishers` role) and are trusted only on machines enrolled in that fleet.
- **Enabling.** A machine trusts a publisher only after the owner enables it in config (`/etc/keylos/publishers.json`, §20.20); it then enters the boot trust set at the next boot.
- **Catalog.** `keylos.catalog/1` (§20.20) is a TUF target signed by the `catalog` role. A listing is `reviewed-reproducible` only if its generations' realisations reach the rebuilder quorum and the catalog review passed; otherwise it is `unreviewed`. Installing an `unreviewed` app sets its effective tier floor to 2 unless the owner records an exception (`keylos.exception/1`, kind `reproducibility`).

### A.32 `protocols §20.20` — Publishers and catalog

`/etc/keylos/publishers.json` (`keylos.publishers/1`, rendered by `config`): `{"schema", "publishers": [{"id": "…", "keys": ["key:sha256:…"], "sigstore": [{"issuer": "…", "subject": "…"}], "spki": {"key:sha256:…": "<base64 DER>"}, "scope": "distro" | "org:<org>"}]}`.

`keylos.catalog/1` (TUF target signed by the `catalog` role):

```json
{"schema":"keylos.catalog/1","issued":"…","expires":"…",
 "entries":[{"name":"org.example.Editor","publisher":"example","summary":"…","categories":["development"],
             "latest":{"version":"2.5.0","generation":"gen:fsv256:…","statement":"sha256:<genstmt envelope digest>"},
             "review":"reviewed-reproducible" | "unreviewed","quorum":"3/3","capabilities":"sha256:<JCS digest>",
             "icons":["https://…"],"homepage":"https://…"}]}
```

### A.33 `protocols §21.2` — Runtime classes

| RuntimeClass | Isolation | Images | Notes |
|---|---|---|---|
| `keylos-vm` (default) | One `bench` microVM per pod sandbox (`VmSpec.purpose = pod`); containers run inside the guest under `youki` driven by `benchd` | Any OCI image, pulled by `cri` into `/var/lib/keylos/cri/images` (via `gate` when `cluster.egressViaGate`), shared read-only into the VM | VM principal `pod:<ns>/<name>:oci:sha256:<first image>@_cluster/…`; GPU only by passthrough |
| `keylos-sealed` | t1 principals spawned by `warden` through `PodSpawn` (§7.5.1) | Only `container` generations (§6.1) with a generation statement signed by an `org-publisher` key enabled on the machine | One principal per container; seccomp `runtime-default`; no added capabilities ever |

### A.34 `protocols §21.4` — Images

- `keylos-vm`: OCI images are pulled by `cri` with digest pinning; tags are resolved once and recorded. They are never executed on the host (`noexec` store) and never registered with `kl-exec`.
- `keylos-sealed`: `cri` calls `Depot.install("oci+container://<registry>/<repo>@sha256:<manifest>")` (facet `cri`). `depot` converts the image with **`oci-convert/1`** into a `container` generation and makes it launchable only if a `keylos.genstmt/1` for that generation digest, signed by an enabled `org-publisher` key, is available from the org TUF repository (`courier`). `cri` roots the generation as `cri:pod:<pod-id>` before `PodSpawn`; `depot` mounts container generations only while so rooted.
- **`oci-convert/1`** (normative; implemented only by crate `keylos-oci-convert`, §18): layers applied in manifest order; OCI whiteouts (`.wh.<name>`) and opaque markers (`.wh..wh..opq`) resolved; hardlinks kept; device nodes, sockets and FIFOs dropped (the runtime provides `/dev`); numeric uid/gid and mode bits kept; setuid/setgid bits cleared; `security.capability` and all `security.*`/`trusted.*` xattrs dropped (no file capabilities, ever); `user.*` xattrs kept; timestamps zeroed; entries sorted by path bytes; the result is built into a composefs generation exactly as `depot` builds any generation, with `/.keylos/manifest.json` of kind `container` whose `container` section copies the OCI config.
- **Identity** of a converted generation: `name` = `oci.` + the registry host's labels reversed + `.` + the repository path segments, joined by `.`, with every character outside `[a-z0-9-]` replaced by `-`; `version` = `0.0.0+oci.<first 16 hex digits of the manifest digest>`; `derivation` (and the genstmt `drv`) = `drv:sha256:<SHA-256 of the JCS bytes of the conversion descriptor>`, where the descriptor is `{"schema":"keylos.ociconv/1","algorithm":"oci-convert/1","image":"oci:sha256:<manifest>","platform":"linux/amd64","config":"sha256:<config blob>","layers":["sha256:…"]}`. For kind `container`, `drv` names this descriptor, not a `keylos.drv/1` derivation. `layers` lists the **compressed layer blob digests exactly as they appear in the image manifest, in manifest order** (not uncompressed `diff_id`s); `platform` is the platform selected from an image index (or the manifest's config platform).

### A.35 `protocols §14.5` — Operating rules

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.

### A.36 `protocols §9.3` — Code integrity (host)

**Primary enforcement: the `kl-exec` BPF LSM.** `boot` loads `kl-exec` in the initrd before executing any file other than itself, and hands its maps and links to `warden` across `switch_root`. The program reads kernel structures at offsets the loader computes from the running kernel's BTF (`/sys/kernel/btf/vmlinux`) before load; a missing member fails the load.

| Hook | Decision |
|---|---|
| `bprm_check_security` | Allow if the file's superblock `s_dev` ∈ `kl_exec_allowed_sb`, or (phase INITRD and the file is on the initramfs). Else `-EACCES` |
| `bprm_creds_for_exec` with `bprm->is_check` set (`execveat(…, AT_EXECVE_CHECK)`) | Same rule as `bprm_check_security`. A check-only exec returns after this hook and never reaches `bprm_check_security`, so this row is what refuses an interpreter's check of an unregistered script. Regular execs are decided only by `bprm_check_security` (one event per denial) |
| `mmap_file` with `PROT_EXEC` | File-backed: same rule as exec. Anonymous: allow only if the task's cgroup ID ∈ `kl_exec_jit_cgroups`. Else `-EACCES` |
| `file_mprotect` adding `PROT_EXEC` | File-backed: same as exec. Anonymous or private-writable: allow only for JIT cgroups |
| `kernel_read_file` (firmware, modules, policy, X.509) | Allow if the file's sb ∈ allowed set or (phase INITRD and initramfs). kexec reads are always denied |
| `kernel_load_data` (`init_module`, firmware blobs) | Deny (modules load only via `finit_module` from verified files) |
| `bpf` (`BPF_PROG_LOAD`, `BPF_LINK_DETACH`, `BPF_PROG_DETACH`) | Allow for the `warden` core (thread-group ID recorded in `kl_exec_policy.warden_tgid` at hand-over) and for `boot` in phase INITRD. Allow for a debugger task whose cgroup has a `kl_debug_pairs` entry with scope `kernel`, for tracing program types only (kprobe, tracepoint, raw_tracepoint, perf_event), never LSM, cgroup or XDP types. Deny for every other task |
| `ptrace_access_check` | Allow only if the tracer's cgroup has an unexpired `kl_debug_pairs` entry whose target cgroup contains the tracee (or is an ancestor of it). Yama and the seccomp profile apply in addition. The hook also guards every other `ptrace_may_access` path (`/proc/<pid>/{mem,maps,environ,fd,ns/*,root,…}`, `kcmp`, `pidfd_getfd`, `setns` and `PIDFD_GET_*_NAMESPACE` on a pidfd, `process_vm_*`); no task is exempt, including the `warden` core. Checks with `PTRACE_MODE_NOAUDIT` are refused without an event |
| `perf_event_open` | Allow only for a task whose cgroup has an unexpired `kl_debug_pairs` entry (the hook sees only the `PERF_SECURITY_*` type, not the target) |
| `perf_event_alloc` (events created by a `perf_event_open(2)` call admitted above) | Scope `process`: allow only task events whose target task is in the target cgroup (or a descendant) and cgroup events on the target cgroup; CPU-wide events are refused. Scope `kernel`: allow system-wide events. Kernel-internal counters (watchdog, ptrace hardware breakpoints) are not `perf_event_open(2)` requests and are not checked |

**Map contract.** `boot` passes the map fds to `warden` as fds 3–7 in the order given by the kernel command line `keylos.execmapfds=3,4,5,6,7`:

| Map | Type | Key → value | Writer |
|---|---|---|---|
| `kl_exec_allowed_sb` | `BPF_MAP_TYPE_HASH`, 65 536 entries | `u32 s_dev` (kernel `dev_t`, below) → `u32 gen_index` | warden core only |
| `kl_exec_jit_cgroups` | `BPF_MAP_TYPE_HASH`, 4 096 entries | `u64 cgroup_id` → `u8 1` | warden core only |
| `kl_exec_policy` | `BPF_MAP_TYPE_ARRAY`, 1 entry | `u32 0` → `struct {u8 enforce; u8 audit_allow; u8 phase; u8 pad; u32 warden_tgid;}` | boot only, then frozen (`bpf_map_freeze`) after `warden_tgid` is written at hand-over |
| `kl_exec_events` | `BPF_MAP_TYPE_RINGBUF`, 1 MiB | denial events `{u64 cgroup_id; u32 pid; u32 hook; u32 s_dev; u64 ino;}` | warden core (reader) |
| `kl_debug_pairs` | `BPF_MAP_TYPE_HASH`, 256 entries | `u64 tracer_cgroup_id` → `struct {u64 target_cgroup_id; u64 expires_boottime_ns; u8 scope;}` (scope 0 = process, 1 = kernel) | warden core only (`DebugAttach`) |

Internal maps of the program (for example the LRU map that limits the `perf_event_alloc` check to `perf_event_open(2)` requests) are not handed over and are not part of this contract.

**Numeric values.** Decoders (`warden`, `journal`, tools) rely on these:
- `kl_exec_policy.phase`: INITRD = 0, SYSTEM = 1. `enforce` = 1 refuses denials; `enforce` = 0 is permissive (denials are logged and allowed; development only). `audit_allow` = 1 also logs allowed decisions.
- `kl_exec_events.hook` IDs: 1 `bprm_check_security`, 2 `mmap_file`, 3 `file_mprotect`, 4 `kernel_read_file`, 5 `kernel_load_data`, 6 `bpf`, 7 `ptrace_access_check`, 8 `perf_event_open`, 9 `bprm_creds_for_exec`, 10 `perf_event_alloc`; bit 31 set marks an audit-allow record. The C layout has 4 bytes of padding before `ino` (record size 32 bytes).
- File hooks carry the file's superblock `s_dev` and inode number (anonymous mappings: 0, 0). Other hooks reuse the two fields: `kernel_load_data` `s_dev` = the `kernel_load_data_id`; `bpf` `s_dev` = the command, `ino` = the program type for `BPF_PROG_LOAD`; `ptrace_access_check` `s_dev` = the mode, `ino` = the tracee's thread-group ID; `perf_event_open` `s_dev` = the `PERF_SECURITY_*` type; `perf_event_alloc` `s_dev` = 1 task event, 2 cgroup event, 3 CPU-wide event, `ino` = the target cgroup ID when known.
- `s_dev` everywhere is the **kernel** encoding of `super_block.s_dev` (`MKDEV`: `major << 20 | minor`), not the userspace `st_dev`/`makedev()` encoding. Registrants convert `statx`'s `stx_dev_major`/`stx_dev_minor`.

**Links.** The program's hooks are attached with `BPF_LINK_CREATE` links and live exactly as long as a link fd is open (no bpffs pins after `switch_root`). `boot` passes the ten link fds to `warden` as fds 9–18, one per hook row, in no particular order, with `keylos.execlinkfds=9,10,11,12,13,14,15,16,17,18` in `warden`'s argv (the boot report is fd 8, §20.1). The `warden` core MUST keep them open for its lifetime and never closes or passes them on; closing them detaches `kl-exec`.

**Registering a generation.** Before adding a mount's superblock to `kl_exec_allowed_sb`, the registrant (`boot` for the OS and bootstrap generations; `warden` for everything else, including mounts it makes on behalf of `bench` and `compat`) MUST:
1. obtain the tree from `depot.mount` (or mount it itself with `verity=require` from a digest-checked image, as `boot` does);
2. verify the generation statement (§20.7) DSSE signatures against the **boot trust set** (§20.1): release-stream keys for distro generations, publisher keys enabled in the config generation, and the owner-seal keys for owner-sealed generations;
3. check the generation is not listed `unlaunchable` in the current revocation list (§11.7);
4. read the superblock device with `statx(tree_fd, "", AT_EMPTY_PATH)` and convert it to the kernel `dev_t` (`stx_dev_major << 20 | stx_dev_minor`).

The decision is sound because the composefs overlay was mounted with `verity=require` from an image whose digest was checked, overlay superblocks are not shared across mounts from different images, and only `warden` can update the map. Writable mounts are always `noexec` in addition.

**Second layer: IPE.** IPE runs a policy signed by `kernel-policy/<stream>`:

```
policy_name=keylos policy_version=1.0.0
DEFAULT action=ALLOW
op=KEXEC_IMAGE action=DENY
op=KEXEC_INITRAMFS action=DENY
op=EXECUTE boot_verified=TRUE action=ALLOW
op=KERNEL_READ boot_verified=TRUE action=ALLOW
```

**Other code paths:**
- `module.sig_enforce=1`. Modules load only from the OS generation or from a **`kmod` generation** (§6.1), and every module MUST carry a signature by the release stream's module-signing key: only project-built, release-signed out-of-tree modules exist. Owner-sealed modules are impossible by design (lockdown enforces module signatures, and owners hold no module-signing key). `warden` registers a `kmod` generation's mount only if its manifest `kmod.kernel` equals the running kernel release.
- `vm.memfd_noexec=2`; `kernel.unprivileged_bpf_disabled=2`; signed BPF loaders only for `boot` and `warden`.
- **Service BPF programs.** Some tier-0 services need BPF programs (strata provenance, net firewall helpers, gate accounting). `warden` loads them only from the **OS generation**, from `/usr/lib/keylos/bpf/<service>/<program>.o` files listed for that service in `services.json` (§20.16), before starting the service; it attaches them and passes their map fds to the service as `KEYLOS_BPF_FDS` (§10.5). Services never call `bpf()` themselves.
- **Grant ceilings.** The warden core loads a label-ceiling LSM program (`kl-label`, separate from the `kl-exec` hand-over) that enforces the exposure label of directory grants (§7.3.3, §14.1): an `open` through a grant mount, and a read through an fd opened through one, fails with `-EACCES` when the object's `security.bpf.keylos.label` (§10.4) exceeds the grant's ceiling or is malformed. `kl-label` attaches `file_open` and `file_permission` (plus `mmap_file` for reads through a mapping), keyed by the grant mount's ID in its map `kl_grant_ceiling`, and reads kernel structures at BTF-computed offsets as `kl-exec` does. Unlabelled objects get their location default (§14.1), except that on kernels without the `bpf-init-inode-xattr` feature an unlabelled object created after the grant was attached counts as `secret/untrusted`. Where `warden` cannot enforce ceilings, `attachGrant` gets a null ceiling and the broker MUST raise the holder to `secret/untrusted`.
- **JIT.** Generations with `needs.jit: true` get their cgroup added to `kl_exec_jit_cgroups` by `warden` and no `PR_SET_MDWE`.
- **Interpreters.** Interpreters shipped in keylos generations MUST honour `AT_EXECVE_CHECK` and the `SECBIT_EXEC_RESTRICT_FILE` / `SECBIT_EXEC_DENY_INTERACTIVE` securebits. `warden` sets both securebits on every host principal **except** the **trusted-terminal tree**, which gets only `SECBIT_EXEC_RESTRICT_FILE`.
- **Trusted-terminal tree.** The tree is the process spawned through `TrustedSpawn.spawnTerminal` and every process that `kish` running in it spawns as a job (foreground or background, including REPLs started from the prompt). A process spawned by any *other* program in that tree (for example an editor that spawns a helper) is outside the tree and gets both securebits; `warden` decides by the spawning principal's actor kind (`shell` from the trusted terminal) and the `SpawnSpec` origin, not by process ancestry alone.
- **Core dumps.** The kernel `core_pattern` pipe helper (`|/usr/lib/keylos/journal/coredump %P %s %t`) is started by the kernel in the root cgroup. This is the one userspace exception to "only the warden core runs in the root cgroup": the helper is an OS-generation binary, installs its own seccomp filter before reading any input, and **moves itself** into `/keylos.slice/system.slice/journal-coredump.scope` before reading the dump (cgroup v2 delegation rules allow only a process in the root cgroup's domain with root credentials to make that move; `journal` cannot). `journal` verifies the move and refuses dumps from a helper still in the root cgroup. `kl-exec`'s `bpf` rule does not depend on cgroup membership, so the exception grants it nothing. The helper is not exempt from `ptrace_access_check` either: it reads only `/proc/%P/{cgroup,status}` (not ptrace-guarded) and takes the crashed process's file mappings from the core's `NT_FILE` note, never from `/proc/%P/maps`.
- **Supervising without ptrace access.** Because `ptrace_access_check` exempts no task, `warden` and every other component observe and control other processes only through operations the hook does not guard: pidfds (from `clone3(CLONE_PIDFD)` or `pidfd_open`) for signals (`pidfd_send_signal`) and exit (`waitid(P_PIDFD)`), `PIDFD_GET_INFO` for credentials and the cgroup ID, `/proc/<pid>/{cgroup,status}`, and cgroup files. A child's namespace fds are captured at spawn: the child opens its own `/proc/self/ns/*` (a task's access to itself is not checked) and passes them to the spawner before its start barrier, and a mapping helper passes its own user-namespace fd the same way. No keylos component opens another task's `/proc/<pid>/{ns/*,root,cwd,fd,maps,mem,environ}` or uses `PIDFD_GET_*_NAMESPACE`, `setns` on a pidfd, `pidfd_getfd`, `kcmp` or `process_vm_*` on another task, except a debugger or open broker within its `kl_debug_pairs` entry.
- **Known limitation (composefs `mprotect`).** For an overlay (composefs) file mapping the kernel passes the backing file to `file_mprotect`, whose superblock is not the registered overlay superblock, so adding `PROT_EXEC` to such a mapping with `mprotect` is refused outside JIT cgroups. `execve` and `mmap(PROT_EXEC)` see the overlay file and are unaffected; only text relocations and similar are refused. Generations needing them declare `needs.jit`.
- **Legacy open broker.** `compat` runs **one open-broker process per legacy app** (the `kl_debug_pairs` map holds one target per tracer). At `LegacySpawn` time (parameter `brokerSession`, §7.5.1) `warden` writes a `kl_debug_pairs` entry (scope `process`, no expiry while the app runs) from that open-broker process's cgroup to the legacy app's cgroup. For this pair `ptrace_access_check` permits `PTRACE_MODE_READ` and `PTRACE_MODE_ATTACH_REALCREDS` (the mode the kernel checks for `process_vm_readv`). The open broker runs with seccomp profile `openbroker-1`, which allows `process_vm_readv` and denies `ptrace`, `process_vm_writev` and `pidfd_getfd`, so the pairing yields read access to the app's memory for decoding seccomp-notification syscall arguments and nothing else.
- **Debugging (`Right.debug`).** A debug grant is minted only at tier T3 with presence, lasts at most 3 600 s (scope `process`) or 900 s (scope `kernel`), and is never minted to an agent principal unless the target session lies inside that agent's own session tree; agents never get scope `kernel` and never a `gen:` target. A request with `durationSecs = 0` resolves to the policy default before minting (default 900 s for `process`, 300 s for `kernel`). It is materialised by `Broker.debug` → `DebugAttach.attach` (§7.5.1): `warden` spawns the debugger generation (policy list `debug.debuggers`, e.g. gdb, lldb, perf, bpftrace) with seccomp profile `debug-1`, writes the `kl_debug_pairs` entry, and grants the debugger ambient capabilities: `CAP_SYS_PTRACE` and `CAP_PERFMON` for scope `process` (tracing another dynamic UID and opening cgroup-scoped perf events need them), plus `CAP_BPF` for scope `kernel`. `kl-exec`'s `ptrace_access_check`, `perf_event_open` and `bpf` hooks bound what those capabilities reach to the paired target. Receipts `debug.attach`/`debug.detach`. Inside workbench VMs debugging is unrestricted.
