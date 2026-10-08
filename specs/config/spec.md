# keylos/config — declarative, typed, signed system configuration

| | |
|---|---|
| Repository | `github.com/keylos-os/config` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `config` (tier-0 service daemon), `config-eval` (sealed evaluator binary, spawned per evaluation), `config` CLI, the core schema library (`schemas/*.ncl`), default profiles (`profiles/*.ncl`), Rust crates `config-model`, `config-render`, `config-plan` |
| Depends on | `keylos-protocols 1.0` (crates `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-presence`, `keylos-tpm-registry`); `nickel-lang-core` (embedded evaluator); runtime services `warden`, `depot`, `ledger`, `broker`, `atrium` (TrustedPrompt), `hearth` (owners, quorum presence, TPM), `strata`; TPM 2.0 |
| Provides | capwire interfaces `Config` and `Plan` (`config.capnp`, protocols §7.3.11) and `ConfigFleet` (`config-sys.capnp`, protocols §7.5.14); the Nickel module system `keylos.module/1`; the config-internal formats `keylos.rendered/1`, `keylos.module/1`, `keylos.drift/1`, `keylos.configlock/1`; config generations (protocols §6.1 kind `config`); policy generations (kind `policy`); configgen statements (protocols §15); the cross-repository files it writes (protocols §10.7): `/etc/keylos/services.json` (`keylos.services/1`), `/etc/keylos/policy.ref` (`keylos.policyref/1`), `/etc/keylos/owner-seal/<i>.spki`, `/etc/keylos/publishers.json` (`keylos.publishers/1`), `/etc/keylos/exceptions/*.dsse`, `/etc/keylos/strata/snapshot-exclude.list`, `/etc/keylos/app-visible.list`, `/etc/keylos/fleet/approvers.json` (`keylos.fleetapprovers/1`), `/var/lib/keylos/config/*.dsse`; per-service configuration files under the protocols §10.7 per-service rule; the recovery tool `config-recover`; the installation tool `config bootstrap` |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`config` turns a **Nickel source tree**, versioned in git, into:

1. a **config generation**: an EROFS composefs image mounted read-only at `/etc` (a confext);
2. a **policy generation**: the Cedar policy set and Biscuit authorizer templates evaluated by `broker`.

Both are bound by a **configgen statement** signed with the owner's FIDO2 presence key and anchored in a TPM NV monotonic counter. Nothing on a keylos machine changes persistent system configuration in any other way.

`config` is responsible for:
- the module system and the core schema library;
- evaluation in a sealed sandbox;
- rendering native configuration files;
- building generations;
- the **plan**: a human-readable rendering of effects, restarts and capability changes;
- obtaining presence;
- activation (switching `/etc`, reloading or restarting services through `warden`);
- history and revert;
- drift reporting;
- `adopt` for app-managed settings;
- agent proposals;
- multi-machine sources.

### 1.1 Non-goals

- User documents and app runtime state. Those belong to apps and `strata`. `config` only *declares defaults and locks* for app settings (§4.10).
- Package building. `config` selects generations by reference; `forge` builds them.
- Secrets storage. Config refers to `vault` items by name and never contains secret values (§4.9).
- Imperative changes. There is no `config set` that writes `/etc`. Every change is source → plan → presence → generation.

---

## 2. Context and embedded contracts

`config` is a tier-0 service. It serves two things on capwire:
- `Config` and `Plan` (`config.capnp`, protocols §7.3.11);
- the system interface `ConfigFleet` (`config-sys.capnp`, protocols §7.5.14).

Like every tier-0 service, it registers its `ServiceHost` with `warden` through `Bootstrap` on fd 3 (protocols §7.5.1).

### 2.1 Callers

| Caller | Facet (protocols §19.2) | Uses |
|---|---|---|
| The `config` CLI run by an owner's `shell` | `owner` | Everything, including `Plan.apply` |
| The `config` CLI run by a non-owner's `shell` | `user` | `current`, `history`, `drift`, `adopt` (own apps), `propose` (plans can't be applied by them) |
| `aide`, for agent sessions | `propose` | `propose` (with origin), `current` |
| `fleet` | `fleet` | `ConfigFleet`, `current`, `drift` |
| `courier`, `journal` | `read` | `current`, `history` |

`boot` does not call `config`. It reads the statements `config` writes (§4.7.4) and the config generation itself. The recovery environment runs `config-recover` (§4.7.6) from the OS generation.

### 2.2 Dependencies

| Service | Facets held | Used for |
|---|---|---|
| `warden` | `service`, `admin` | Spawning `config-eval`; `Supervisor.services` and `control` for reload and restart; `FdStore` |
| `atrium` | `presence`, `notify` | `TrustedPrompt.presence("config.apply", payload, rendering)` and `("exception", …)` on the trusted path; notifications |
| `hearth` | `system`, `presence`, `tpm` | `HearthSystem.owners` (owner registry: verifying presence signatures, deciding who is an owner, `sealKey` per owner); `exportPasswd` (legacy `/etc/passwd`); `HearthQuorum.request`/`collect` on quorum machines (§4.7.7); `HearthTpm.defineSpace(0x01300101)` on re-provisioning |
| `depot` | `config`, `admin` | `importTree` of config and policy generations; `mount` of config generations; `get`; `root`/`unroot`/`list` for history retention |
| `broker` | `system` | `BrokerSystem.validatePolicy` and `loadPolicy` |
| `strata` | `admin` | `snapshot` and `restore` of app config subvolumes for `adopt` and drift |
| `ledger` | `writer` | Receipts |
| TPM 2.0 | `/dev/tpmrm0` fd passed by `warden` | Config counter `0x01300101` (read through the public `NV_Read` branch; written with the authValue in `/var/lib/keylos/tpm/nv-auth/0x01300101.sealed`, protocols §10.7, §19.6) |

**Files read from other repositories** (protocols §10.7): `/run/keylos/boot/report.json` (`safeConfig`, §4.7.4) and `/var/lib/keylos/tpm/nv-auth/0x01300101.sealed`. The running `config` service takes owner-registry data from `HearthSystem.owners`, never from `owners.log`; only `config-recover`, in the recovery profile, replays `/var/lib/keylos/hearth/owners.log` itself (§4.7.6), as protocols §10.7 registers.

### 2.3 Embedded contracts

Appendix A holds a verbatim copy of every protocols contract `config` implements or consumes, so this file can be implemented with only the `keylos-protocols` 1.0.0 crates. If a copy differs from protocols, protocols wins.

| Contract | Use in config | Appendix |
|---|---|---|
| Principals and identifiers (protocols §3.4, §3.5) | `origin` of plans; plan IDs `p-…` | A.1 |
| Signed documents, trust roots, presence signatures (protocols §5) | Configgen statements and exceptions; verifying presence | A.2 |
| Generation kinds, layout, manifest (protocols §6.1–§6.3) | Building `config` and `policy` generations | A.3 |
| capwire model, routes and facets (protocols §7.1, §7.2) | Serving and calling every interface | A.4 |
| `common.capnp` and error codes (protocols §7.3.1) | Every call | A.5 |
| `config.capnp` (protocols §7.3.11) | **Implemented** | A.6 |
| `config-sys.capnp` (protocols §7.5.14) | **Implemented** | A.7 |
| `prompt.capnp` (protocols §7.3.4) | `presence`, `notify` | A.8 |
| `depot.capnp` (protocols §7.3.8) | Generations | A.9 |
| `warden.capnp`, `warden-sys.capnp` (protocols §7.3.2, §7.5.1) | Spawn, service control; `Bootstrap`, `ServiceHost` (implemented) | A.10 |
| `broker-sys.capnp` (protocols §7.5.2) | `validatePolicy`, `loadPolicy` | A.11 |
| `hearth.capnp`, `hearth-sys.capnp` (protocols §7.3.12, §7.5.3) | Owner registry, passwd export | A.12 |
| `strata.capnp`, `strata-sys.capnp` (protocols §7.3.10, §7.5.7) | `adopt`, drift | A.13 |
| `ledger.capnp` (protocols §7.3.5) | Receipts | A.14 |
| Code integrity (protocols §9.3) | Trust-set inputs carried by the config generation | A.15 |
| Host layout, environment and cross-repository files (protocols §10.1, §10.5, §10.7) | `/etc`, app-visible subset, files written and read | A.16 |
| Receipts, receipt privacy and the event registry (protocols §13.1, §13.4, §19.3) | Receipts emitted (§9.1) | A.17 |
| Effect kinds, approval tiers, mandates (protocols §14.2–§14.4) | Tier rules for policy compilation | A.18 |
| Config generation statement (protocols §15) | **Produced**; boot selection rule | A.19 |
| Cedar policy schema (protocols §16) | Policy compilation and validation | A.20 |
| Facets (protocols §19.2) | Facets served and held | A.21 |
| TPM objects (protocols §19.6) | Config counter, owner registry head, owner-seal keys | A.22 |
| Boot trust set, presence purposes, owner registry, owner exceptions (protocols §20.1–§20.3, §20.9) | Trust-set files, presence purposes, exceptions | A.23 |
| First-boot bundle (protocols §20.13) | Digest check of the installer's bundle; cloud-seed `config` statement installed by `config bootstrap install` (§4.14) | A.24 |
| Quorum presence and quorum requests (protocols §5.4, §20.18) | Quorum machines and `ConfigFleet.applyRemote` | A.25 |
| Service table and policy reference (protocols §20.16, §20.17), publishers (§20.20) | Rendered files | A.26 |
| Profiles and resource classes (protocols §2.2, §2.3) | Profiles, RAM-class option | A.27 |
| Org approvers (protocols §20.23) | Rendered `/etc/keylos/fleet/approvers.json` (REQ-CONFIG-037) | A.28 |

---

## 3. Requirements

### 3.1 Source and evaluation

- **REQ-CONFIG-001** The configuration source MUST be a git repository. The system copy lives at `/var/lib/keylos/config/src` (non-bare, owned by `config`). Every applied generation records the exact commit (`sourceRev`) it was built from.
- **REQ-CONFIG-002** Evaluation MUST run in `config-eval`, a sealed tier-0 binary spawned per evaluation with:
  - no network;
  - no `vault`, `broker` or `gate` access;
  - a read-only dirfd of the source checkout and of the schema library;
  - a memory limit of 2 GiB and a wall time of 120 s (configurable).

  Evaluation MUST be deterministic: there is no clock, randomness, environment, or filesystem access outside the passed dirfds. Nickel `import` resolution is restricted to those dirfds.
- **REQ-CONFIG-003** Evaluating the same source revision with the same schema library generation and compiler generation MUST produce a byte-identical rendered tree and therefore the same `gen:` digest.
- **REQ-CONFIG-004** Every option MUST be declared by a module with a Nickel contract. Setting an undeclared option MUST fail evaluation, with the path and the nearest known option names.
- **REQ-CONFIG-005** Secret values MUST NOT appear in source or output. Secrets are declared as `Secret` references (§4.9). The compiler MUST reject string values that match the secret detectors (§4.9.2) unless the option's contract is `NotSecret`.

### 3.2 Plans and apply

- **REQ-CONFIG-010** `propose` MUST produce a `Plan` without changing any system state except the plan cache. A plan is identified by `p-<ULID>` (protocols §3.5) and expires after 24 h or when the current generation changes.
- **REQ-CONFIG-011** A plan MUST render:
  - file changes as unified diffs per path;
  - service actions (reload, restart, reboot-required);
  - capability and policy changes in plain language (§4.6.3);
  - packages and generations added or removed;
  - the proposing principal and the source revision.
- **REQ-CONFIG-012** `Plan.apply` MUST, in this order (§4.7.1):
  1. read the NV config counter `c` (`0x01300101`, protocols §19.6) and build the `keylos.configgen/1` statement with `counter = c + 1`;
  2. obtain the owner's presence signature over the statement with `TrustedPrompt.presence("config.apply", JCS(statement), rendering)`, where `rendering` is the plan's effect rendering (protocols §7.3.4, §20.2); on quorum machines, obtain a quorum envelope instead (§4.7.7, protocols §5.4);
  3. verify the returned envelope with `keylos-presence` against the owner registry (protocols §5.3, §20.3), with user verification required (on quorum machines: ≥ `policy.threshold` signatures by distinct owners);
  4. import the config and policy generations into `depot` and check that their digests equal the plan's;
  5. write the signed statement durably;
  6. increment the NV counter;
  7. switch the current-statement pointer;
  8. activate (§4.7.2).

  If any step before step 6 fails, the system MUST remain on the previous generation and the NV counter MUST be unchanged.
- **REQ-CONFIG-013** The configgen `counter` MUST equal the NV counter value + 1 when presence is requested, and the NV counter MUST be incremented exactly once per applied generation, only after the signed statement and both generations are durably stored (protocols §15). If the NV counter changed between plan and apply (a concurrent apply), apply MUST fail with `kl:conflict`.
- **REQ-CONFIG-014** `Plan.apply` is served only on the facet `owner` (protocols §19.2). `config` MUST additionally check that the caller's human is an owner in the current owner registry (`HearthSystem.owners`). Plans proposed by agents are applied by an owner through the CLI or `atrium`; the agent's session never receives an applicable `Plan` capability (§4.8).
- **REQ-CONFIG-015** Activation MUST be atomic per mount: the new `/etc` replaces the old one with `MOVE_MOUNT_BENEATH` followed by unmounting the old top. Services receive their new view on reload or restart through `warden`.
- **REQ-CONFIG-016** If activation fails health checks (§4.7.3), `config` MUST re-activate the previous generation **at runtime**, without a new statement and without an NV change, write `/var/lib/keylos/config/activation-failed.json` (`{"generation", "counter", "failures": […]}`) and emit `config.activation-rollback` (protocols §15). `boot` never falls back automatically: it selects the highest-counter valid statement, so after a reboot the failed generation is activated again and the runtime fallback repeats until an owner applies a fix, applies a revert, or uses the recovery revert (§4.7.6).

### 3.3 History, revert, drift, adopt

- **REQ-CONFIG-020** `config` MUST retain at least the last 50 config generations and every generation referenced by a bootable OS entry as `depot` GC roots (holder `config:history`, through facet `admin`).
- **REQ-CONFIG-021** `revert(gen)` MUST produce a plan that re-applies the target generation's *rendered tree* under a **new** statement (new counter, `parent` = current). Reverting never decrements the NV counter.
- **REQ-CONFIG-022** `drift` MUST report:
  - whether `/etc` is the current generation (fs-verity digest of the mounted EROFS image);
  - services running a generation or config different from the plan;
  - app mutable layers that diverge from declared defaults;
  - presence of locally modified files in `/var/lib/keylos/config/src` not yet committed.
- **REQ-CONFIG-023** `adopt(app)` MUST produce a patch to the config source that lifts the app's current mutable settings into declarations, for the formats the app's schema can parse (§4.10). It never applies anything.

### 3.4 Boot integration

- **REQ-CONFIG-030** `config` MUST keep every applied statement as `/var/lib/keylos/config/statements/<counter>.dsse` for the retained generations, and maintain the pointers `current.dsse` and `previous.dsse` (written atomically). `boot` applies the selection rule of protocols §15 to the statements directory (§4.7.4).
- **REQ-CONFIG-031** Every config generation MUST carry the boot trust-set inputs of protocols §20.1:
  - `/etc/keylos/owner-seal/<ownerIndex>.spki`: the DER SubjectPublicKeyInfo of each owner's owner-seal key, copied from the `sealKey` field of the owner registry (protocols §20.3) as returned by `HearthSystem.owners()`;
  - `/etc/keylos/publishers.json` (`keylos.publishers/1`, protocols §20.20): the publishers the owner enabled (`store.publishers`), including org publishers on fleet-enrolled machines.

  The trust set is loaded by `boot` before `kl-exec` registration (protocols §9.3). There is no `.ipe` keyring.
- **REQ-CONFIG-032** Every config generation MUST carry `/etc/keylos/policy.ref` (`keylos.policyref/1`, protocols §20.17): JCS `{"schema": "keylos.policyref/1", "generation": "gen:fsv256:<P>", "digest": "sha256:<JCS digest of P's manifest>"}`, naming the policy generation it was applied with, so that the policy generation is bound by the configgen statement through the config generation's digest (protocols §20.7).
- **REQ-CONFIG-033** Every config generation MUST carry `/etc/keylos/services.json` (`keylos.services/1`, protocols §20.16), rendered by the `services` module (§4.4.4) and validated before signing: `network: "host"` only for `net` and `gate`; `network: "cluster"` only for `cri`, `kubelet` and `kube-proxy`, and only on the `server-k8s` profile (protocols §20.16, §21.5); `bpf` paths only under `/usr/lib/keylos/bpf/<service>/`; `writer: true` only for services that write events registered in protocols §19.3; every route's `service#facet` present in the protocols §19.2 registry (shipped as data in `keylos-schemas`); every non-protocols field prefixed `x-`.
- **REQ-CONFIG-034** `config` MUST write only the cross-repository files listed for it as writer in protocols §10.7, in exactly their registered formats, and MUST NOT render keylos-format files that no reader is registered for (in particular no `owners.json`).
- **REQ-CONFIG-035** On quorum machines (owner registry `policy.mode = "quorum"`, protocols §5.4), every presence-requiring step MUST use a quorum envelope (§4.7.7). `ConfigFleet.applyRemote` MUST accept only quorum envelopes whose signatures come from distinct owners in the registry current at the statement's `time`.
- **REQ-CONFIG-036** A configuration that fails to activate MUST be revertible from the recovery boot entry without a running `config` service (§4.7.6, protocols §15). The revert produces a new presence-signed (or quorum-signed) statement with `counter` greater than every existing statement; it never edits or deletes statements.
- **REQ-CONFIG-037** When the `fleet` module is enrolled and accepted, every config generation MUST carry `/etc/keylos/fleet/approvers.json` (`keylos.fleetapprovers/1`, protocols §20.23), rendered from the fleet module's `fleet.org`, `fleet.commandQuorum` and `fleet.approvers` options, which are locked by the organisation. Validation: `commandQuorum` ≥ 1 and ≤ the number of approvers; every approver has a unique `id` and `keyid`; `keyid` equals `key:sha256:` of the SPKI; `alg` is `fido2-es256` or `fido2-eddsa`. Without an accepted fleet module the file MUST be absent. A change to the approver set or `commandQuorum` MUST appear in the plan's capability-change rendering as "organisation approvers change".
- **REQ-CONFIG-038** Per-service configuration files (`/etc/keylos/<service>.json` and `/etc/<service>/*`) MUST be rendered only by that service's module, with `owner` set to that service, and MUST be readable only by that service in its mount view (`x-etcVisible` of exactly that service, §4.4.4). A module that renders a file for another service is an evaluation error (protocols §10.7, per-service rule).
- **REQ-CONFIG-039** `config bootstrap` (§4.14) MUST be the only way the first statement reaches `/var/lib/keylos/config/` on a new installation, both interactive (`installer`) and cloud seed (`keylos-seed`), so that `config` remains the only writer of `*.dsse` in that directory (protocols §10.7). At its first start, the `config` service MUST verify the installed statement against `HearthSystem.owners` (presence or quorum, protocols §5.3, §5.4) before treating it as current; a statement that fails verification leaves the machine in the `unverified` state (`config status`), refuses every `apply` except a revert, and raises a critical notification.

## 4. Design

### 4.1 Source repository layout

```
/var/lib/keylos/config/src/        (git; owner clones it into a workbench to edit)
  machine.ncl                      entry point for this machine (selects host)
  hosts/
    <hostname>.ncl                 per-machine settings
  common/
    *.ncl                          shared modules written by the owner
  apps.ncl                         installed apps and their persistent grants
  policy/
    *.cedar                        hand-written Cedar policies (validated against protocols §16)
    *.ncl                          structured policy (preferred; compiled to Cedar)
  secrets.ncl                      secret *references* only (vault item names)
  config.lock                      pins: schema library generation, compiler generation, fleet modules
```

`machine.ncl`:

```nickel
let host = import "hosts/atlas.ncl" in
let common = import "common/desktop.ncl" in
{
  profile = 'desktop,
} & common & host
```

`config.lock` (JSON, written by `config lock`):

```json
{"schema":"keylos.configlock/1",
 "schemas":"gen:fsv256:…",           // core schema library generation (shipped in OS gen, pinned)
 "compiler":"gen:fsv256:…",          // config-eval generation
 "fleet":[{"name":"org.example.base","gen":"gen:fsv256:…"}]}
```

If `config.lock` pins a schema library other than the one in the running OS generation, `config` uses the pinned one, if it is installed in `depot`. Otherwise it fails with `kl:not-found` and the hint `config lock --update`.

### 4.2 The module system (`keylos.module/1`)

A **module** is a Nickel file that evaluates to a record:

```nickel
{
  meta = {
    name = "net",                       # module id, unique
    version = "1.0.0",
    owner = "service:net",              # service responsible for the rendered files
    visibility = 'system,               # 'system | 'app_visible (rendered files listed in app-visible.list)
  },
  options = { … },                      # contract record: option declarations
  render = fun cfg => { … },            # cfg = the evaluated value at options' path
  actions = fun old new => { … },       # optional: service actions for a change (default per meta)
  policy = fun cfg => [ … ],            # optional: structured policy statements contributed
  effects = [ … ],                      # optional: effect kinds registered (x-… kinds, raise-only classes)
}
```

**Option declarations** are Nickel contracts with metadata:

```nickel
options = {
  net | {
    dns | {
      mode | [| 'dot, 'doh, 'plain |]
           | doc "Resolver transport. 'plain is allowed only on networks marked trusted."
           | default = 'dot,
    },
  },
}
```

**Merge semantics.** Nickel's native record merge (`&`) is used unchanged:
- Values merge recursively.
- Conflicts on equal-priority non-record values are errors.
- Priorities: `| default` (lowest), normal, `| priority N`, `| force` (highest).

`config` defines the priority conventions:

| Source | Priority |
|---|---|
| Schema defaults | `default` |
| Profile (`profiles/desktop.ncl` …) | `priority -10` |
| Fleet organisation modules | normal, but **locked** options use `force` (§4.11) |
| Owner `common/`, `hosts/` | normal |
| Explicit override in host file | `priority 10` |
| `force` | Fleet locks and emergency overrides only. The plan shows each `force` use |

**Evaluation algorithm** (in `config-eval`):

```
1. load schema library: every schemas/<m>.ncl → modules[m]
2. load profile per `profile` field (default 'desktop)
3. Options := merge_all [ modules[m].options for m ]              -- the global contract
4. user := import machine.ncl (with fleet modules merged per lock)
5. value := (profile & user) | Options                             -- contract application, forces defaults
6. check: no fields outside Options (record contracts are closed)
7. for each module m: files_m := modules[m].render (value.<m path>)
8. rendered := union of files_m; path collisions are errors unless both modules declare `shared = true` with equal content
9. policies := concat [ modules[m].policy (value.<m>) ] ++ compile(policy/*.ncl) ++ policy/*.cedar
10. output keylos.rendered/1 (§4.3) on stdout as CBOR
```

Nickel evaluation uses `nickel-lang-core`. The evaluator's import resolver is replaced with one that resolves only relative to the two provided dirfds (`openat2(RESOLVE_BENEATH)`), and only `.ncl`, `.json`, `.toml` and `.yaml` imports. The standard library is the version bundled with the compiler generation.

### 4.3 Rendered tree (`keylos.rendered/1`)

CBOR map:

```
{
  "schema": "keylos.rendered/1",
  "files": { "/etc/<path>": { "mode": 0o644, "owner": "root"|"<service>", "format": "toml"|"ini"|"json"|"yaml"|"keyfile"|"raw"|"cedar"|"list",
                               "content": <bytes>, "module": "<m>", "visibility": "system"|"app_visible" } },
  "services": { "<service>": { "onChange": "reload"|"restart"|"reboot"|"none", "files": ["/etc/…"] } },
  "generations": { "os": "gen:…"|null, "apps": ["gen:…"], "services": ["gen:…"], "agentTemplates": ["gen:…"] },
  "policies": [ { "id": "<stable id>", "cedar": "<text>", "tier": "t0|t1|t2|t3|null", "source": "<module or file>" } ],
  "policyData": { "hosts": […], "effects": […], "labels": […], "defaults": {…}, "flowproofRuntimes": […],
                  "orgApprovers": […], "classifier": {…}|null },                 // rendered into the policy generation, §4.6.1
  "trust": { "publishers": [ { "key": "key:sha256:…", "spki": "<base64 DER>", "name": "<publisher>" } ] },
  "exceptions": [ { "kind": "reproducibility", "name": "<generation name>", "publisher": "key:sha256:…",
                    "generation": "gen:…"|null, "reason": "<text>", "expires": "<RFC 3339>"|null } ],
  "secrets": [ { "name": "<vault item>", "consumers": ["service:net"], "kind": "<kind>" } ],
  "warnings": [ "<text>" ]
}
```

Rendering of `format` values is done in Rust (`config-render`), not in Nickel. A module returns structured values; the compiler serializes them deterministically:

| Format | Serializer | Determinism rules |
|---|---|---|
| `toml` | `toml_edit` | Keys sorted; arrays as given |
| `ini` / `keyfile` | Built in | Sections sorted unless the module passes `ordered = true` with an explicit order |
| `json` | JCS (RFC 8785) | |
| `yaml` | `serde_yaml` | Block style, sorted keys |
| `raw` | Module supplies a string | |
| `list` | One item per line, sorted unique | |
| `cedar` | Formatted with the `cedar-policy` formatter | |

Every rendered file starts with a header comment where the format permits one: `# Generated by keylos config from <module>. Do not edit; this file is read-only.`

### 4.4 Core schema library

Shipped as `schemas/` in this repo and installed in the OS generation at `/usr/share/keylos/config/schemas/`. Each module's `render` targets the configuration format that the owning component's spec defines.

| Module | Owner | Covers |
|---|---|---|
| `system` | warden | Hostname, locale, keymap, timezone, profile (protocols §2.2), machine role, kernel sysctl overrides (allow-listed), feature-level floor, RAM-class override `system.ramClass` (protocols §2.3) |
| `boot` | boot | Extra kernel cmdline (allow-listed keys), PCR policy options, verify-before-unlock requirement, recovery entry |
| `updates` | courier | Stream, auto-stage, maintenance window, pinned generations, firmware update policy |
| `store` | depot | GC retention, revocation handling, substituters (TUF repositories), enabled publishers (rendered to `/etc/keylos/publishers.json`, `keylos.publishers/1`), owner exceptions (§4.13), catalog review policy |
| `users` | hearth | Humans, display names, login methods, lock policy, family settings. Owners and FIDO2 credentials are **not** configured here: they live in the owner registry, changed only by `hearth` ceremonies (protocols §20.3); `config` renders the owner-seal SPKIs from the registry's `sealKey` fields |
| `hearth` | hearth | Guest sessions (`hearth.guest.enabled`, `hearth.guest.agents`, protocols §14.3) |
| `net` | net | Links, Wi-Fi known networks (credentials as secret refs), DNS, VPN (WireGuard), host firewall, NTS servers |
| `strata` | strata | Snapshot retention, transactions, units, provenance, backup targets, replicas |
| `vault` | vault | Item ACL defaults, prompt policies, SSH agent policy |
| `gate` | gate | Host classifications (`sinkSafe`, `trusted`), proxy limits, effect kind registrations, compensators |
| `policy` | broker | Structured permits and forbids, approval-tier overrides, label defaults per location, Rule-of-Two settings, flow-proof runtimes |
| `agents` | aide | Allowed agent templates, default budgets, model endpoints, session limits, auto-approve scopes (never above T1) |
| `apps` | depot/warden | Installed app generations, per-app standing permits (§4.6.2), tier floors `apps.<name>.tierFloor` (raise only, protocols §6.3), app config defaults and locks |
| `services` | warden | Optional services enabled or disabled, resource limits overrides |
| `desktop` | atrium | Displays, input, keyboard layouts, theme, accessibility defaults, trusted-path appearance |
| `audio` | devd | PipeWire policy defaults |
| `devices` | devd | Device rules, power policy, Bluetooth, USB authorization class rules `devices.autoAuthorize`, passthrough list `devices.passthrough` (protocols §9.5), inhibitor delay |
| `printing` | portals | Printers (IPP Everywhere), default options |
| `journal` | journal | Retention, export, metrics |
| `compat` | compat | Legacy images, D-Bus islands enabled, X11 per-app allowance |
| `fleet` | fleet | Enrolment, witness endpoints, locked options (§4.11), cloud seed keys `fleet.seedKeys` (protocols §20.13), org approvers `fleet.org`, `fleet.commandQuorum`, `fleet.approvers` rendered to `/etc/keylos/fleet/approvers.json` (protocols §20.23, REQ-CONFIG-037) |
| `bench` | bench | Workbench defaults (vCPU, memory), GPU native context, image pins |
| `cluster` | cri | `server-k8s` profile: `cluster.egressViaGate`, `cluster.hostPathAllowlist`, pod CIDR, overlay mode, kubelet and kube-proxy generation pins (protocols §21) |
| `debug` | warden, broker | `debug.debuggers`: generation names allowed as debuggers (protocols §9.3) |
| `ledger` | ledger | `ledger.retentionMonths` (default 13, minimum 1, protocols §13.4) |
| `secureboot` | courier | `secureboot.keepMicrosoftCAs` (default false; true selects the `shared-boot` integrity profile, protocols §2.2) |
| `config` | config | `config.presence.assistedAllowed` (purposes for which assisted credentials count, protocols §5.3); evaluation limits; plan TTL (§10) |

#### 4.4.1 Example: `net` module (complete)

```nickel
# schemas/net.ncl
let Secret = import "lib/secret.ncl" in
let Host = std.contract.from_predicate (fun s => std.string.is_match "^[A-Za-z0-9.-]+(#[A-Za-z0-9.-]+)?$" s) in
{
  meta = { name = "net", version = "1.0.0", owner = "service:net", visibility = 'system },

  options = {
    net | {
      hostname | String | optional,
      links | { _ : {
        match | { name | String | optional, mac | String | optional, kind | [| 'ethernet, 'wifi, 'usb |] | optional },
        dhcp | [| 'v4, 'v6, 'both, 'none |] | default = 'both,
        addresses | Array String | default = [],
        metered | Bool | default = false,
        trusted | Bool | doc "Network on which plain DNS and LAN discovery are allowed." | default = false,
      } } | default = {},
      wifi | {
        backend | [| 'iwd |] | default = 'iwd,
        known | { _ : {
          ssid | String,
          security | [| 'wpa3, 'wpa2, 'wpa2_enterprise, 'open |] | default = 'wpa3,
          credential | Secret | optional,
          autoconnect | Bool | default = true,
          trusted | Bool | default = false,
          metered | Bool | default = false,
        } } | default = {},
        macRandomization | [| 'per_network, 'per_connection, 'off |] | default = 'per_network,
      },
      dns | {
        mode | [| 'dot, 'doh, 'plain |] | default = 'dot,
        servers | Array Host | default = ["1.1.1.1#cloudflare-dns.com", "9.9.9.9#dns.quad9.net"],
        dnssec | [| 'require, 'allow_downgrade, 'off |] | default = 'allow_downgrade,
        fallbackToDhcpOnTrusted | Bool | default = true,
      },
      vpn | { _ : {
        kind | [| 'wireguard |] | default = 'wireguard,
        privateKey | Secret,
        peers | Array { publicKey | String, endpoint | String, allowedIps | Array String, keepalive | Number | default = 25 },
        addresses | Array String,
        dns | Array String | default = [],
        autostart | Bool | default = false,
        killSwitch | Bool | default = false,
      } } | default = {},
      firewall | {
        inbound | [| 'deny, 'allow_lan_services |] | default = 'deny,
        allowInbound | Array { port | Number, proto | [| 'tcp, 'udp |], from | [| 'lan, 'any |] | default = 'lan, service | String } | default = [],
      },
      time | {
        nts | Array String | default = ["time.cloudflare.com", "nts.netnod.se", "ptbtime1.ptb.de"],
        minSources | Number | default = 2,
      },
    },
  },

  render = fun cfg => {
    "/etc/net/net.toml" = {
      format = 'toml, owner = "net", mode = 420,
      value = {
        hostname = std.record.get_or "hostname" "keylos" cfg,
        links = cfg.links,
        dns = cfg.dns,
        firewall = cfg.firewall,
        wifi = { backend = std.string.from_enum cfg.wifi.backend,
                 mac_randomization = std.string.from_enum cfg.wifi.macRandomization },
      },
    },
    "/etc/net/wifi-known.toml" = {
      format = 'toml, owner = "net", mode = 384,
      value = { networks = std.record.map (fun _k n => n & { credential = Secret.render n.credential }) cfg.wifi.known },
    },
    "/etc/net/vpn.toml" = {
      format = 'toml, owner = "net", mode = 384,
      value = { tunnels = std.record.map (fun _k v => v & { privateKey = Secret.render v.privateKey }) cfg.vpn },
    },
    "/etc/net/time.toml" = { format = 'toml, owner = "net", mode = 420, value = cfg.time },
  },

  actions = fun old new =>
    if old.time != new.time && old.dns == new.dns && old.links == new.links then { net = 'reload }
    else { net = 'reload },
}
```

`Secret.render` emits `{ vault = "<item name>" }`. The `net` service resolves it at runtime through `vault.open`. The item name is also collected into `rendered.secrets`, so the plan lists which services gain access to which secret names (the ACL change goes to `vault` through the `vault` module's policy output).

#### 4.4.2 Example: `strata` module

The full option schema is the one published in the `strata` spec §10. Its render, actions and policy functions:

```nickel
render = fun cfg => {
  "/etc/strata/strata.toml" = { format = 'toml, owner = "strata", mode = 420, value = cfg },
  # read by vault at start (it refuses to run unless @keystore is excluded from snapshots)
  # protocols §10.7: newline-separated absolute paths, read by strata and vault
  "/etc/keylos/strata/snapshot-exclude.list" = { format = 'list, owner = "strata", mode = 420,
    value = ["/keystore"] },
},
actions = fun _old _new => { strata = 'reload },
policy = fun cfg =>
  # backup and replica egress for the strata service
  (std.record.to_array cfg.backup.targets
   |> std.array.filter (fun e => (import "lib/uri.ncl").is_network e.value.uri)
   |> std.array.map (fun e => {
        id = "strata-backup-" ++ e.field,
        permit = { principal = { kind = "service", generationName = "io.keylos.strata" },
                   action = "connect", resource = { host = (import "lib/uri.ncl").host e.value.uri } },
        tier = 't1,
      }))
  # presence-gated strata operations (strata spec §6.2.3): strata requests them for its own session
  @ (std.array.map (fun k => {
        id = "strata-presence-" ++ k,
        permit = { principal = { kind = "service", generationName = "io.keylos.strata" },
                   action = "commit", resource = { effect = "x-strata." ++ k } },
        tier = 't3, presence = true,
      }) ["unit-forget", "unit-export", "anchor-reset", "backup-password", "backup-disk-init"]),
effects = [
  { kind = "x-strata.unit-forget", class = 'irreversible },
  { kind = "x-strata.unit-export", class = 'irreversible },
  { kind = "x-strata.anchor-reset", class = 'irreversible },
  { kind = "x-strata.backup-password", class = 'irreversible },
  { kind = "x-strata.backup-disk-init", class = 'irreversible },
],
```

The `policy` module turns `presence = true` into the `@presence("true")` annotation (protocols §16.2). The `effects` list is rendered into the policy generation's `/policy/effects.json`.

#### 4.4.3 Example: `policy` module (structured policy)

```nickel
# schemas/policy.ncl (excerpt of options)
options = {
  policy | {
    permits | Array {
      id | String,
      principal | { kind | String | optional, generationName | String | optional, human | String | optional },
      action | String,
      resource | { path | String | optional, host | String | optional, effect | String | optional,
                   device | String | optional, service | String | optional, budget | String | optional },
      tier | [| 't0, 't1, 't2, 't3 |] | default = 't1,
      presence | Bool | default = false,  # adds @presence("true")
      channels | Array [| 'local, 'phone, 'org |] | default = ['local],   # adds @channels(…) when not just 'local
      orgApproval | String | optional,     # approver group; adds @orgApproval("<group>") (fleet-enrolled machines)
      when | String | optional,          # Cedar condition expression, validated
      doc | String,
    } | default = [],
    forbids | Array {
      id | String, principal | { kind | String | optional, generationName | String | optional },
      action | String, resource | { path | String | optional, host | String | optional, effect | String | optional },
      when | String | optional, doc | String,
    } | default = [],
    effectTiers | { _ : [| 't2, 't3 |] } | default = {},       # raise-only overrides per effect kind
    labelDefaults | { _ : { conf | String, integ | String } } | default = {},  # path prefix → label
    sinkSafeHosts | Array String | default = [],
    flowProofRuntimes | Array String | default = [],              # agent-template generation names
  },
},
```

Compilation to Cedar:

| Structured entry | Compiled Cedar |
|---|---|
| A `permits` entry with `tier = 't3` | `@id("<id>") @tier("t3") permit (principal, action == Keylos::Action::"<action>", resource) when { <generated conditions> && <when> };` |
| `presence = true`, `channels`, `orgApproval` | Adds `@presence("true")`, `@channels("local,phone")`, `@orgApproval("<group>")` (protocols §16.2). `orgApproval` is an evaluation error unless the `fleet` module is enrolled |
| A `forbids` entry | `@id("<id>") forbid (…) when { … };` |

Conditions on attributes compile to `principal.kind == "agent"` and similar. Path prefixes compile to `resource.root == "<root>" && resource.rel like "<rel>*"`, using Cedar's `like`, with `*` escaped in literals.

Every compiled policy is validated with `cedar-policy` strict validation against the protocols §16 schema. Validation errors fail evaluation with the source location.

Two compiler rules:
- `effectTiers` may only raise the tier; a lowering is an evaluation error.
- An entry with `principal.kind == "agent"` and an `effect` resource whose protocol class is `irreversible` can't have `tier` below `t3`. The compiler enforces this, implementing protocols §14.3 "no automated component may lower a tier".

#### 4.4.4 The `services` module and `/etc/keylos/services.json`

The `services` module (owner `warden`) renders the service table of protocols §20.16. Its option defaults are generated from the service entries of the schema library generation that ships in the OS generation; the distribution builds that library from this repository's sources with the release's pinned generation references, so the defaults are a build input, not a runtime file of another repository.

```nickel
options = {
  services | {
    bootstrap | { journal | GenRef, ledger | GenRef, depot | GenRef },
    table | { _ : {
      generation | GenRef,
      entrypoint | String | default = "main",
      tier | [| 0, 1 |] | default = 0,
      perHuman | Bool | default = false,
      network | [| 'none, 'gate, 'host, 'cluster |] | default = 'none,
      writer | Bool | default = false,
      privileges | {
        capabilities | Array String | default = [],
        paths | Array { path | String, access | [| 'ro, 'rw |] } | default = [],   # may contain "{human}" when perHuman
        devices | Array String | default = [],
        tpm | Bool | default = false,
      },
      bpf | Array String | default = [],
      routes | Array { to | String, facet | String } | default = [],
      readiness | { timeoutSecs | Number | default = 30 },
      watchdogSecs | Number | default = 10,
      restart | [| 'always, 'on_failure, 'never |] | default = 'on_failure,
      etcVisible | Array String | default = [],     # rendered as warden-local "x-etcVisible"
      enabled | Bool | default = true,
      limits | { memoryMax | String | optional, cpuWeight | Number | optional } | default = {},
    } },
  },
},
render = fun cfg => {
  "/etc/keylos/services.json" = { format = 'json, owner = "warden", mode = 420,
    value = {
      schema = "keylos.services/1",
      bootstrapGens = cfg.bootstrap,
      services = cfg.table
        |> std.record.filter (fun _k s => s.enabled)
        |> std.record.map (fun _k s => (std.record.remove "etcVisible" (std.record.remove "enabled" (std.record.remove "limits" s)))
                                      & { "x-etcVisible" = s.etcVisible, "x-limits" = s.limits }),
    } },
},
```

Validation (REQ-CONFIG-033) runs in `config-render` after evaluation, against the facet registry and writer list compiled into `keylos-schemas`. A service whose `writer` flag changes appears in the plan as "service X becomes/stops being a ledger writer". `ledger` reads `writer`, `boot` reads `bootstrapGens`, `warden` reads the rest (protocols §10.7).

#### 4.4.5 Options introduced by protocols

| Option | Module | Consumer | Default |
|---|---|---|---|
| `system.ramClass` | system | bench, warden | detected (protocols §2.3) |
| `devices.autoAuthorize`, `devices.passthrough` | devices | devd | `[]`, `[]` |
| `debug.debuggers` | debug | warden (`DebugAttach`), broker | `["io.keylos.gdb", "io.keylos.lldb", "io.keylos.perf", "io.keylos.bpftrace"]` |
| `ledger.retentionMonths` | ledger | ledger | 13 |
| `secureboot.keepMicrosoftCAs` | secureboot | courier, boot | false |
| `hearth.guest.agents` | hearth | broker, aide | false |
| `config.presence.assistedAllowed` | config | hearth, broker (rendered into `/policy/defaults.json`) | every purpose |
| `fleet.seedKeys` | fleet | cloud first-boot stage (`installer`) | `[]` |
| `cluster.egressViaGate`, `cluster.hostPathAllowlist` | cluster | cri, broker (Cedar `admit`) | false, `[]` |
| `apps.<name>.tierFloor` | apps | warden, broker | none (raise only) |

### 4.5 Default profiles

`profiles/desktop.ncl` and `profiles/server.ncl` ship in the schema library.

| Setting | desktop | server |
|---|---|---|
| `system.profile` | `'desktop` | `'server` |
| atrium, portals, PipeWire, BlueZ island | enabled | disabled |
| `net.wifi` | iwd enabled | disabled unless a link matches |
| `updates.autoStage` | true, window 02:00–05:00 | true, window configurable, `rebootPolicy = 'manual` |
| `strata.retention.user.hourly` | 24 | 0 (daily only) |
| `agents.enabled` | true, with default templates allowed | false |
| `policy.permits` | Desktop defaults: shell read/write own home at T0; apps per manifest at install; agents read project dirs at T0, egress per template at T1, `fs.merge` at T3 | Minimal: shell only; services by route |
| `boot.verifyBeforeUnlock` | `'recommended` (prompt at enrolment) | `'off` (headless), with remote attestation through `fleet` if enrolled |
| `desktop.*` | Defaults | n/a |

Additional profiles (protocols §2.2):

| Setting | `laptop` | `server-k8s` | `cloud` | `kiosk` | `appliance` |
|---|---|---|---|---|---|
| Base | `desktop` + power and lid defaults | `server` + `cluster` module enabled; `cri`, `kubelet`, `kube-proxy` services | `server`, no Wi-Fi, serial console | `desktop` minus shell login; autologin to one app principal; atrium kiosk mode | `server` without `bench` |
| Presence | touch | quorum (§4.7.7) | quorum | touch (owner on the trusted path) | quorum |
| `hearth.guest.enabled` | false | false | false | false | false |
| `agents.enabled` | true | false | false | false | false |
| `updates.rebootPolicy` | `'window` | `'drain-then-reboot` (via `cri` drain) | `'manual` | `'window` | `'window` |

`profiles/appliance.ncl` is a fixed-function profile with no shell login; `profiles/kiosk.ncl` names its single app in `kiosk.app`.

### 4.6 Planning

#### 4.6.1 Pipeline

```
propose(source dirfd, origin)
 1. identify the caller from ServiceHost.accept (peer, facet) → caller principal; origin must equal the caller
    unless the facet is "propose" (aide), in which case origin is the agent principal named by aide
    and MUST be a descendant session of an agent spawned for the same human
 2. snapshot source: git worktree checkout of HEAD (or the working tree if --dirty) into
    /var/lib/keylos/config/plans/<plan>/src via reflink copy; compute sourceRev
       sourceRev = "git:sha1:<commit>" if clean, else "sha256:<SHA-256 of the canonical tar stream of the tree>"
       (canonical tar stream as in protocols §11.2)
 3. spawn config-eval (Supervisor.spawn on facet service, tier t0, no grants) with dirfds:
    plan src (ro), schema library (ro)
 4. read keylos.rendered/1 from its stdout pipe; validate (paths under /etc only; modes; owners known)
 5. build the policy generation tree in /var/lib/keylos/config/plans/<plan>/policy (layout owned by broker):
      /policy/policies.cedar (owner policies, concatenated, sorted by @id), /policy/org/*.cedar (fleet),
      /policy/schema.cedarschema (byte copy of protocols §16.1), /policy/hosts.json, /policy/effects.json,
      /policy/labels.json, /policy/defaults.json, /policy/classifier.json, /policy/flowproof-runtimes.json,
      /policy/org-approvers.json, /policy/strings/<lang>.json,
      /.keylos/manifest.json (kind policy, name io.keylos.policy.<hostname>, version <counter-to-be>)
    and compute its generation digest (P)
 6. BrokerSystem.validatePolicy(policy tree dirfd) → problems → fail the plan with kl:invalid if any
 7. build the config generation tree in /var/lib/keylos/config/plans/<plan>/tree:
      /etc/... rendered files
      /etc/keylos/app-visible.list
      /etc/keylos/services.json              keylos.services/1 from the services module (§4.4.4, REQ-CONFIG-033)
      /etc/keylos/policy.ref                 keylos.policyref/1 {schema, generation: P, digest: sha256 of P's manifest JCS}
      /etc/keylos/owner-seal/<ownerIndex>.spki   base64-decoded sealKey of each owner in HearthSystem.owners()
      /etc/keylos/publishers.json            keylos.publishers/1 from rendered.trust.publishers
      /etc/passwd, /etc/group                HearthSystem.exportPasswd() (legacy views; ordinary OS files)
      /etc/keylos/exceptions/<name>.dsse     presence-signed owner exceptions (§4.13)
      /etc/keylos/strata/snapshot-exclude.list
      /.keylos/manifest.json (kind config, name io.keylos.config.<hostname>, version <counter-to-be>)
 8. compute the config generation digest (C) locally (EROFS/composefs digest computation in config-plan,
    identical algorithm to depot's) without importing
 9. diff against current generation trees → file diffs; actions from modules' `actions`; capability diff (§4.6.3)
10. store the plan record; return a Plan capability bound to the caller's connection
```

#### 4.6.2 Standing permits

The `apps` module declares per-app **standing permits**: for example "Editor may read `~/Documents`", or "the backup target host is reachable by strata". They compile to Cedar `permit` policies at tier `t0`/`t1` (or higher, if declared) in the policy generation.

`config` never writes grant records. Persistent grants are created by `broker` alone, after an approval with presence, and stored in its own format (protocols §8.1). A standing permit means that when the app asks for the access (`Broker.request`, the powerbox, or install-time consent), `broker` grants it without a prompt.

#### 4.6.3 Capability-change rendering

The plan's `capabilityChanges()` produces sentences. Some examples:

- "**Editor** (`org.example.Editor`) will be able to **read** `~/Documents` without asking (new standing permit)."
- "Agents from template **coder** will be able to **connect** to `api.github.com` (GET, HEAD) at tier T1 (new)."
- "Effect `email.send` approval tier: T3 → T3 (unchanged; lowering is not allowed)."
- "Removed: standing permit of **Photos** for `~/Pictures`."
- "New publisher trusted: **Example Ltd** (`key:sha256:…`); its apps become launchable after the next boot."
- "New owner exception: **org.example.Tool** may run at tier 1 although it is not reproducible."
- "Service **net** gains access to secret `wifi/home` (new)."
- "Fleet-locked option `updates.stream` is set by organisation **Example Corp** and cannot be changed."

The algorithm compares the old and new standing permits, Cedar policy sets (by `@id`, plus semantic diff), trusted publishers, owner exceptions, secret consumer sets and app tier floors. Cedar semantic diff is done by evaluating a fixed probe matrix (every principal kind × action × representative resource) under old and new policies, and reporting decisions that changed, including tier changes.

### 4.7 Apply and activation

#### 4.7.1 Apply sequence

```
apply()                                           (facet owner only)
 1. caller human ∈ owners (HearthSystem.owners); else kl:denied
 2. read NV counter c (TPM2_NV_Read 0x01300101 through the public PolicyCommandCode(NV_Read) branch);
    statement.counter := max(c, highest retained statement counter) + 1
 3. statement := { schema: "keylos.configgen/1", generation: "gen:fsv256:<C>", sourceRev, parent (current gen),
                   counter, compiledBy (config-eval gen), proposedBy (plan origin), approvedBy (caller human), time }
    (the policy generation P is bound through /etc/keylos/policy.ref inside C, REQ-CONFIG-032)
 4. (owner exceptions were presence-signed when they were created, §4.13; nothing to sign here)
 5. touch machines: envelope := TrustedPrompt.presence("config.apply", JCS(statement), rendering)  (atrium facet presence)
       rendering = the plan's RenderedEffect list (file diffs as text/x-diff attachments, restarts,
       capability changes); atrium shows the statement (short generation digest, sourceRev, proposedBy,
       counter) next to the rendering and displays the rendering digests for cross-checking with the CLI
    quorum machines: §4.7.7 (HearthQuorum request; Plan.apply returns kl:needs-approval:q-… until collected)
 6. verify envelope with keylos-presence (protocols §5.3, §5.4): payloadType configgen, payload == JCS(statement),
    UV set, credentials enrolled in the owner registry at statement.time (HearthSystem.owners);
    quorum machines: ≥ policy.threshold signatures by distinct owners; else kl:integrity
 7. re-read NV counter; if != c → kl:conflict (another apply happened)
 8. depot.importTree(policy tree, manifest) and depot.importTree(config tree, manifest) (facet config)
    → infos; check digests equal P and C; else kl:integrity
 9. depot.root(C, "config:history") and depot.root(P, "config:history") (facet admin)
10. write /var/lib/keylos/config/statements/<c+1>.dsse (fsync file and directory)
11. unseal the counter authValue from /var/lib/keylos/tpm/nv-auth/0x01300101.sealed (TPM-sealed to the PCR11
    "ready" phase and PCR15, protocols §10.7, §19.6); TPM2_NV_Increment(0x01300101) until the value equals
    statement.counter (normally once; more after a recovery revert, §4.7.6); verify the new value
12. previous.dsse := current.dsse; current.dsse := statement envelope (atomic rename, fsync)
13. ledger.append(config.apply: {generation, policyGeneration, counter, sourceRev, parent, proposedBy})
14. activate (§4.7.2)
```

**Crash windows.**
- Before step 10, nothing is visible: the NV counter is `c` and no statement with counter `c+1` exists.
- Between steps 10 and 11, the statement `c+1` exists while NV is `c`. Its counter is ≥ NV and it is owner-signed, so `boot` selects it (protocols §15). The owner approved exactly this generation, so this is safe. At next start `config` notices that NV < `current.counter`, increments NV once, and repairs the pointers.
- Between steps 11 and 12, NV is `c+1` and the statement exists, so `boot` selects it. `config` repairs `current.dsse` at next start.

#### 4.7.2 Activation

1. `fd = depot.mount(C)` on facet `config`. This gives a detached composefs mount with `verity=require`, which `config` makes read-only and `nosuid,nodev,noexec` with `mount_setattr`.
2. `move_mount(fd, "", AT_FDCWD, "/etc", MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_BENEATH)`, then `umount2("/etc", MNT_DETACH)` of the old top. `/etc` in the host mount namespace now shows the new generation.
3. `BrokerSystem.loadPolicy(P)` (protocols §7.5.2). `broker` validates the generation and swaps atomically. It mounts `/policy` from the generation named by `/etc/keylos/policy.ref`.
4. For each service in `rendered.services` whose files changed, call `Supervisor.control(service, reload|restart)` per `onChange` (facet `admin`). On reload, `warden` rebuilds the service's `/etc` view and calls `ServiceHost.reload` (protocols §7.5.1). Services are processed in dependency order, which `warden` reports through `Supervisor.services`. Restarts run in parallel within the same order level.
5. If any module flags `reboot`, record `rebootRequired` and notify the owner through `TrustedPrompt.notify`.
6. Install or uninstall app generations listed in `rendered.generations.apps` through `depot` (install by reference, facet `admin`). Uninstalls happen only after their standing permits are removed in the new policy.

Trust-set changes (publishers, owner-seal keys, exceptions) take effect for `kl-exec` registration at the next boot, when `boot` rebuilds the boot trust set (protocols §20.1). The plan says so.

#### 4.7.3 Health checks and runtime fallback

After activation, `config` waits up to 60 s (configurable) for every restarted service to reach `running` and stay there for 10 s.

If a service fails, `config`:
1. re-activates the previous generation with the same mount procedure, at runtime only: no new statement and no NV change;
2. calls `BrokerSystem.loadPolicy` with the previous policy generation;
3. restarts the affected services;
4. emits `config.activation-rollback`;
5. writes `/var/lib/keylos/config/activation-failed.json`, JCS `{"generation": "gen:fsv256:…", "counter": <n>, "failures": [{"service": "<name>", "state": "failed", "restarts": <n>, "since": "<RFC 3339>", "reason": "<kl:… text>"}]}` (protocols §15), and raises a critical `TrustedPrompt.notify` that names the recovery revert (§4.7.6).

`current.dsse` keeps pointing to the new statement, because that is what `boot` will select (protocols §15: `boot` never falls back automatically). After a reboot, `config` sees `activation-failed.json` for the booted counter and repeats the fallback immediately after the health check fails again. The loop ends when an owner applies a fix or a revert, either of which creates a statement with a higher counter. A configuration that prevents login entirely is reverted from the recovery boot entry (§4.7.6).

#### 4.7.4 Boot selection (contract with `boot`)

`boot` applies protocols §15 (Appendix A.19):
- It reads every `/var/lib/keylos/config/statements/*.dsse` and NV `0x01300101`.
- It selects the highest-counter statement that verifies against the owner registry anchored in NV `0x01300105`, with `counter ≥` the NV value and its generation present in the store with a matching fs-verity digest.
- If none qualifies, it boots the safe config shipped in the OS generation and reports `safeConfig: true` in the boot report.

`config` reads the boot report at start. When `safeConfig` is true it emits `x-config.safe-boot` and notifies the owner.

#### 4.7.5 Revert

`revert(gen)` loads the target generation's rendered tree from `depot` (read through a `mount` of kind `config`) and builds a plan whose tree equals it, with these differences:
- `/etc/keylos/policy.ref` names a policy generation rebuilt from the target's policy tree;
- `owner-seal/*.spki` and `publishers.json` trust inputs are refreshed from the current owner registry and source, because owners are never reverted; `services.json` is taken from the target generation unless it references service generations no longer installed, which the plan lists as install effects.

Statement `parent` = current; `counter` = next. The plan rendering says "Revert to generation of <date> (<rev>)".

Revert covers configuration only. It does not revert app or OS generations unless the old tree's `rendered.generations` differ, in which case the plan lists the install and uninstall effects.

#### 4.7.6 Recovery revert (`config-recover`)

The recovery boot entry (the `recovery` profile of the UKI, PCR11 phase `enter-recovery`, protocols §19.6) runs the recovery environment, which offers "Revert to the previous configuration" when `/var/lib/keylos/config/activation-failed.json` exists, and "Revert to a chosen configuration" always. The action runs `config-recover`, a binary of this repository in the OS generation, with the decrypted root volume mounted and no `config` service, `hearth` or `atrium` running:

1. Read every `/var/lib/keylos/config/statements/*.dsse`, replay the owner registry from `/var/lib/keylos/hearth/owners.log` itself (protocols §10.7 registers `config-recover` as a reader in the recovery profile): each line's DSSE envelope is verified against the owners current before it (genesis first, per protocols §20.3), producing the owner set and `policy` used in step 5; an unverifiable line stops the replay at the last good entry and is reported. Read NV `0x01300101` through the public read branch.
2. Choose the target: the statement before the failed one (from `activation-failed.json`), or the one the owner picks from a list rendered with counter, time, source revision and approver. The target generation MUST be present in `/store/gens/` with a matching fs-verity digest.
3. Build the revert statement: `generation` = the target's generation digest (generation images are content-addressed, so the reverted content is exactly the target's), `parent` = the failed statement's generation, `counter` = 1 + the highest counter of any statement, `proposedBy` = `"recovery"`, `sourceRev` = the target's.
4. Obtain presence directly: `config-recover` drives the FIDO2 authenticator itself (CTAP2 over USB HID, rpId `keylos.owner`, UV required) with the §5.3 construction from `keylos-presence`, showing the statement on the recovery console. On quorum machines it prints the payload as a `keylos.quorum/1` request (QR and text) and accepts the signed envelope pasted or scanned from approvers (protocols §5.4).
5. Verify the envelope against the owner registry, write `statements/<counter>.dsse` and point `current.dsse` at it (fsync file and directory). The NV counter is **not** touched: its authValue is sealed to the PCR11 `ready` phase, which the recovery environment never reaches. `boot` selects the new statement because its counter is ≥ NV (protocols §15), and `config` raises NV to the statement's counter at the next normal start (§4.7.1 step 11, crash-window repair).
6. Remove `activation-failed.json` and hand the receipt payload `config.revert {generation, counter, revertedTo, approval: null, origin: "recovery"}` to the recovery environment, which spools it for `ledger` (`config.revert` is recovery-replayable, protocols §19.3).

#### 4.7.7 Quorum presence (headless and managed machines)

When the owner registry's `policy.mode` is `quorum` (profiles `server`, `server-k8s`, `cloud`, `appliance`, protocols §5.4), every place that needs presence uses a quorum envelope:

```
Plan.apply (or ConfigExt.collect)
 1–4. as §4.7.1
 5'. (requestId, requestEnvelope) := HearthQuorum.request("config.apply", JCS(statement), rendering texts)   (hearth facet presence)
     record requestId in the plan; Plan.apply fails with kl:needs-approval:<requestId>
     approvers receive the keylos.quorum/1 request through fleet (or as a file) and sign the payload's PAE on their own machines
 5''. config plan collect <plan> → HearthQuorum.collect(requestId) → envelope (kl:needs-approval until ≥ threshold distinct owners)
 6–14. as §4.7.1, verifying ≥ policy.threshold distinct owners
```

The request expires after at most 24 h (protocols §20.18); an expired request makes the plan re-request on the next `apply`. Exceptions (§4.13) use the same path with purpose `exception`.

### 4.8 Agent proposals

- `aide` calls `propose(source, origin = <agent principal>)` with facet `"propose"`. The source is a dirfd of the agent's **workbench overlay** of the config repo, which the agent edited inside its VM.
- `config` evaluates it and stores the plan with `origin`. It returns a `Plan` capability **with `apply` disabled**: calling it raises `kl:denied` on this facet.
- `config` also records the plan as pending and notifies the owner: "Agent *coder* proposes a configuration change", with a link to `config plan show <plan>`.
- The owner reviews with `config plan show`, then runs `config plan apply <plan>`. That re-checks the source digest and triggers the presence prompt. The statement records `proposedBy` = the agent principal.
- Agents cannot propose a change that grants their own template or session more authority without the plan highlighting it. The capability diff tags such changes as **self-escalation**, and the prompt shows them first, in a warning style.

### 4.9 Secrets references

#### 4.9.1 Declaration

`lib/secret.ncl`:

```nickel
{
  Secret = std.contract.custom (fun label value =>
    if std.is_record value && std.record.has_field "vault" value && std.record.fields value == ["vault"]
       && std.string.is_match "^[a-z0-9][a-z0-9._/-]{0,127}$" value.vault
    then 'Ok value
    else 'Error { message = "secret values must be references: { vault = \"<item name>\" }" }),
  ref = fun name => { vault = name },
  render = fun s => s,
}
```

In source: `credential = secret.ref "wifi/home"`.

To create the secret itself, the owner runs `vault store wifi/home`. This is interactive and happens outside config; config never handles the value. `config` holds no `vault` facet, so it cannot check that the item exists. The plan lists every referenced item name with its consuming services, and the consuming service reports a missing item at start (`kl:not-found`, surfaced by `config drift`).

#### 4.9.2 Detectors

The compiler scans every rendered string value and fails on:
- PEM private-key headers;
- strings matching common token formats (AWS `AKIA[0-9A-Z]{16}`, GitHub `gh[pousr]_[A-Za-z0-9]{36,}`, Slack `xox[abpr]-`, JWT-like three base64url segments with an `alg` header, `-----BEGIN OPENSSH PRIVATE KEY-----`);
- high-entropy strings (Shannon entropy ≥ 4.5 bits per character over ≥ 32 characters) in options not declared `NotSecret`.

An option contract `NotSecret` (for example for public keys) exempts it.

### 4.10 App settings: defaults, locks and `adopt`

**Declaring.** The `apps` module accepts per-app setting declarations:

```nickel
apps.settings."org.example.Editor" = {
  format = 'json, file = "settings.json",          # relative to the app's config subvolume
  defaults = { theme = "dark", tabSize = 4 },
  locked = { telemetry = false },
}
```

**Rendering.** These render to `/etc/keylos/apps/<app>/defaults.<ext>` and `locked.<ext>`, visible to the app (`app_visible`). The keylos SDK's settings library (see `sdk`) merges `defaults` < user file < `locked`. Apps using dconf get a rendered dconf system database and locks (`/etc/dconf/db/keylos.d/…`, compiled at render time with a Rust implementation of the GVDB format).

**`adopt(app)`:**
1. Read the app's mutable config subvolume through a read-only snapshot. On the `strata` facet `admin`, `config` calls `Strata.snapshot` on `~/.apps/<app>/config` and then `Strata.restore(snapshot, "", target)` into a scratch directory `/var/lib/keylos/config/adopt/<app>/` it owns. The scratch copy is deleted after the patch is produced.
2. Parse the files declared in the app's schema (or in `apps.settings.<app>.format`): JSON, TOML, INI/keyfile, or dconf keyfile export.
3. Compute the structural difference against the declared defaults, ignoring keys in the app manifest's `x-volatileSettings`.
4. Emit a Nickel patch:

   ```nickel
   # adopt org.example.Editor (from snapshot snap-…)
   apps.settings."org.example.Editor".defaults = { theme = "solarized", fontSize = 13 },
   ```

   Unparseable files are emitted as raw file overrides with sha256 and a comment.
5. `config adopt` prints the patch or writes it to `common/apps/<app>.ncl` with `--write` (in the owner's workbench checkout, not in the system source).

### 4.11 Multi-machine and fleet

- One source repository can serve many machines. `machine.ncl` selects `hosts/<hostname>.ncl` by the hostname recorded at installation (`/var/lib/keylos/config/host`), or by machine key ID through `hosts/by-key/<keyid>.ncl` when present.
- `config` can evaluate a plan for another host (`config plan --host <name>`) for review, but applies only to the local machine.
- **Fleet modules** (provided by `fleet`) are generations of kind `data` containing `.ncl` modules.
  - Their options may be **locked**: `fleet.locks = ["updates.stream", "policy.forbids", …]`.
  - The evaluator applies locked values with `force` priority. A local attempt to set a locked option produces an evaluation error naming the organisation.
  - Fleet policy `forbids` are always included, rendered to `/policy/org/*.cedar`, and cannot be overridden by owner permits (protocols §16.2).
  - Fleet-provided permits are included only if the owner accepted the fleet enrolment.
- **`ConfigFleet`** (protocols §7.5.14, facet `fleet`):
  - `installFleetModule(gen)` records the module generation as *pending*. It becomes part of the evaluation input (pinned in `config.lock` under `fleet`) only after an owner applies a plan that accepts the enrolment: the plan shows the organisation, its locks and permits, and the apply is presence-signed like any other. Until then the module has no effect.
  - `removeFleetModule()` removes the pending or accepted module. The removal takes effect at the next apply, which `config` proposes automatically and notifies the owner about; org forbids stay active until that apply.
  - **Org approvers.** The accepted fleet module sets `fleet.org`, `fleet.commandQuorum` and `fleet.approvers` (locked). The `fleet` module of the schema library renders them as `/etc/keylos/fleet/approvers.json` (REQ-CONFIG-037), read by `hearth` (fleet commands), the recovery environment's `rescue` (wipe completion) and `broker` (org approvals), protocols §20.23. `config` does not interpret fleet commands itself.
  - `applyRemote(statement, approverEnvelopes)` applies a plan on a **managed** machine whose owners are org admins (protocols §5.4, §7.5.14):
    1. `statement` MUST be byte-identical to the statement of a **pending plan** on this machine: the JCS payload `config` put into that plan's quorum request (§4.7.7), which `fleet` relays to the approvers. Its `generation` equals the plan's config generation digest and its `counter` the plan's counter-to-be. Plans on managed machines come from `installFleetModule` auto-proposals or from an owner's `config plan`. `applyRemote` is the path for signatures collected outside `HearthQuorum` (for example by an org approval workflow that signs many machines' statements).
    2. Each envelope MUST be a DSSE envelope over that payload carrying §5.3 presence signatures. `config` collects all signatures, discards duplicates per owner and signatures by credentials not enrolled at the statement's `time` (`HearthSystem.owners`), and requires ≥ `policy.threshold` **distinct owners**.
    3. It merges them into one quorum envelope (protocols §5.4) and continues with §4.7.1 steps 6–14, exactly like `Plan.apply`. The statement's `approvedBy` is the comma-joined list of approving owners.
    4. Any failure returns `kl:integrity` (bad signatures), `kl:needs-approval` (below threshold) or `kl:conflict` (stale counter or no matching plan) and changes nothing.

### 4.12 Drift

`drift()` returns JSON:

```json
{"schema":"keylos.drift/1",
 "etc":{"expected":"gen:fsv256:…","mounted":"gen:fsv256:…","ok":true},
 "policy":{"expected":"gen:…","loaded":"gen:…","ok":true},
 "services":[{"name":"net","expectedGen":"gen:…","runningGen":"gen:…","state":"running","configAge":"…","ok":true}],
 "apps":[{"app":"org.example.Editor","changedKeys":["theme","fontSize"],"adoptable":true}],
 "source":{"uncommitted":false,"aheadOfApplied":2},
 "activationFailed":false}
```

- `/etc` integrity is checked by measuring the fs-verity digest of the backing EROFS image of the mount at `/etc` (via `depot.get` of the mounted ref, plus `FS_IOC_MEASURE_VERITY` on the image file), and comparing it to `current.dsse`.
- App drift uses the same parser as `adopt`, without emitting a patch.

### 4.13 Owner exceptions

An owner exception (`keylos.exception/1`, protocols §20.9) lets a non-reproducible generation run at effective tier 1.

1. `config exception add <name> --publisher <key> [--generation <gen>] --reason <text> [--expires <date>]` (kind `reproducibility`) or `config exception add <name> --kind fleet-receipt-access --events <type,…> --reason <text>` (facet `owner`) builds the payload and asks for presence: `TrustedPrompt.presence("exception", JCS(payload), rendering)` (protocols §20.2, §20.9), or a quorum envelope on quorum machines (§4.7.7). User verification is required.
2. `config` verifies the envelope (protocols §5.3) and writes it into the system source as `exceptions/<name>.dsse`, committing it with the message `exception: <name>`.
3. The next plan copies every `exceptions/*.dsse` from the source into the config generation at `/etc/keylos/exceptions/<name>.dsse`, after re-verifying each signature against the current owner registry. An invalid envelope fails the plan with `kl:integrity`.
4. `depot` (reproducibility exceptions) and `ledger` (`fleet-receipt-access` exceptions) read `/etc/keylos/exceptions/*.dsse` from the booted config generation (protocols §10.7, §20.9); `config` never calls them about exceptions.

`config exception remove <name>` deletes the source file; the exception disappears with the next applied generation.

### 4.14 Installation: `config bootstrap`

`config` is the only writer of `/var/lib/keylos/config/*.dsse` (protocols §10.7), including on a new machine, where no `config` service runs yet. The `config` binary of the **target** OS generation therefore provides two installation subcommands, run by `installer` (interactive installation) and by `keylos-seed` (cloud seed, protocols §20.13) inside their own sandboxes:

1. **`config bootstrap --source <repo> --out <dir> --counter 1 --parent none`** evaluates and compiles the source exactly like a plan (§4.6.1, same pinned compiler and schema library), writes the confext and policy generation trees to `<dir>` for import by the caller (`depot import-closure`), and prints the unsigned JCS `keylos.configgen/1` payload with `counter = 1`, `parent = null`, `proposedBy = "installer"`. It has no network access, reads no file outside `<repo>` and the OS generation, and never touches the TPM.
2. **`config bootstrap install --root <mnt> --statement <file> --gen <ref>`** takes the **signed** statement (presence-signed by the owner in the interactive case; presigned, quorum-signed in the cloud-seed bundle's `config.statement`) and:
   1. checks that the payload is JCS-canonical `keylos.configgen/1` with `counter = 1`, `parent = null`, and `generation` equal to `<ref>`;
   2. checks that `<mnt>/store/gens/<hex>.erofs` exists and its fs-verity digest equals `<ref>`;
   3. checks the envelope's signature *structure* (protocols §5.3 or §5.4: algorithms, PAE, distinct credential IDs); it does **not** decide whether the signers are owners, because at installation time no `hearth` runs and `config` may read no owner-registry file outside the recovery profile;
   4. writes `<mnt>/var/lib/keylos/config/statements/1.dsse` and `current.dsse` (fsync file and directory) and `host`, refusing if any statement already exists.
3. **First start.** `config` (REQ-CONFIG-039) verifies `current.dsse` against `HearthSystem.owners`: for `policy.mode = presence`, one signature by an owner credential; for `quorum`, ≥ `policy.threshold` distinct owners (protocols §5.4). On success it records the statement as current and runs the crash-window repair (§4.7.1 step 11), which raises NV `0x01300101` to 1 if `installer` has not already done so. On failure the machine enters `unverified`. `boot` independently verifies the statement against its own owner-registry replay before selecting it (protocols §15), so an unverifiable statement never activates.
4. **Source on seeded machines.** A cloud-seed statement arrives without a system source repository (its `config.source` names the generation, not git). `config` initialises `/var/lib/keylos/config/src/` empty with a `SEEDED` marker. `config clone` returns an empty repository whose README records the seeded `sourceRev`. The first `config push` must contain a source whose evaluation reproduces the current generation digest, or the plan shows the full difference as a change from the seeded generation.

---

## 5. Interfaces

### 5.1 capwire facets

`config` implements exactly the facets listed for it in protocols §19.2 (Appendix A.21) and refuses other methods with `kl:denied`:

| Facet | Holders | Methods |
|---|---|---|
| `owner` | owner `shell` (the `config` CLI) | All, including `Plan.apply`; the repo-local `ConfigExt` (§5.2) |
| `user` | non-owner `shell`s | `current`, `history`, `drift`, `adopt` (own apps), `propose` (an owner must apply); `ConfigExt.plans`, `plan`, `evaluate`, `schemaDoc` |
| `propose` | `aide` | `propose` (with origin), `current` |
| `fleet` | `fleet` | `ConfigFleet` (§4.11), `current`, `drift` |
| `read` | `courier`, `journal` | `current`, `history` |

### 5.2 Repo-local interface (`config-ext.capnp`)

Only the `config` CLI uses this interface; no other repository consumes it (protocols §1). The CLI gets it with `Extensible.ext(interfaceId)` on the `owner` or `user` facet.

```capnp
@0xd3a7f1c5e9b20201;
using C = import "/keylos/common.capnp";
using P = import "/keylos/config.capnp";

struct PlanInfo { id @0 :Text; origin @1 :C.PrincipalId; sourceRev @2 :Text; created @3 :C.Timestamp; expires @4 :C.Timestamp; selfEscalation @5 :Bool; applicable @6 :Bool;
                 quorumRequest @7 :Text; statement @8 :Data; }   # quorumRequest q-… on quorum machines; statement = JCS configgen to be signed

struct ExceptionInfo { name @0 :Text; kind @1 :Text; publisher @2 :Text; generation @3 :Text; reason @4 :Text; expires @5 :C.Timestamp; inCurrent @6 :Bool; }

interface ConfigExt {
  plans      @0 () -> (list :List(PlanInfo));
  plan       @1 (id :Text) -> (plan :P.Plan, info :PlanInfo);
  discard    @2 (id :Text) -> ();
  evaluate   @3 (source :C.Fd, host :Text) -> (renderedCbor :C.Fd, warnings :List(Text));   # no plan; for CLI `config eval`
  schemaDoc  @4 (module :Text) -> (markdown :Text);
  sourceRepo @5 () -> (dir :C.Fd);                                                         # owner: O_PATH dirfd of system source (read-only)
  push       @6 (bundle :C.Fd) -> (plan :P.Plan);                                          # owner: git bundle → fast-forward system source → propose
  addException    @7 (payloadJson :Text) -> (name :Text);                                  # owner: §4.13 (presence on the trusted path)
  removeException @8 (name :Text) -> ();                                                   # owner
  exceptions      @9 () -> (list :List(ExceptionInfo));
  collect         @10 (id :Text) -> (generation :C.Ref);                                   # owner: quorum machines, finish apply (§4.7.7)
}
```

### 5.3 CLI: `config`

| Command | Description |
|---|---|
| `config status` | Current generation, counter, source rev, pending plans, activation state, drift summary |
| `config clone <dir>` | Clone the system source into `<dir>` (a workbench or home directory) |
| `config eval [<dir>] [--host H] [--json]` | Evaluate and print the rendered tree summary or JSON; no plan |
| `config check [<dir>]` | Evaluate and run linters (secret detectors, policy validation, unused options); exit 0 if clean |
| `config plan [<dir>] [--dirty] [--host H]` | Create a plan from `<dir>` (default: the system source) and show it |
| `config plan show <plan>` | Show diff, restarts, capability changes |
| `config plan apply <plan>` | Apply (presence prompt; on quorum machines prints the quorum request ID) |
| `config plan show <plan> --statement` | Print the JCS configgen statement that will be signed |
| `config plan collect <plan>` | Quorum machines: collect approver signatures (`HearthQuorum.collect`) and finish the apply |
| `config plan discard <plan>` | |
| `config plans` | List pending plans, including agent proposals |
| `config apply [<dir>]` | `plan` + `apply` in one step, after showing the plan |
| `config push <dir>` | Bundle the commits from a working clone, fast-forward the system source, then plan |
| `config history [--limit N]` | Generations with counter, time, rev, proposer, approver |
| `config show <path> [--gen G]` | Print a rendered file from the current or a given generation |
| `config diff <genA> <genB>` | Diff two generations |
| `config revert <gen>` | Plan a revert, then apply with confirmation |
| `config drift [--json]` | Drift report |
| `config adopt <app> [--write <file>]` | Produce an adopt patch |
| `config schema [<module>]` | List modules, or show a module's option documentation |
| `config lock [--update]` | Write or update `config.lock` |
| `config hosts` | List hosts in source, mark the local one |
| `config exception add <name> --publisher <key> [--generation <gen>] --reason <text> [--expires <date>]` | Create a presence-signed owner exception (§4.13) |
| `config exception list` | List exceptions in source and in the current generation |
| `config exception remove <name>` | Remove an exception from the source |
| `config fleet pending` | Show a pending fleet module (organisation, locks, permits) awaiting acceptance |
| `config services [--json]` | Show the rendered service table (`/etc/keylos/services.json`) with validation notes |
| `config-recover [--to <counter>]` | Recovery environment only: revert to a previous configuration (§4.7.6) |
| `config bootstrap --source <repo> --out <dir> --counter 1 --parent none` | Installer only: evaluate and compile the first config generation, print the unsigned `keylos.configgen/1` payload (§4.14) |
| `config bootstrap install --root <mnt> --statement <file> --gen <ref>` | Installer and `keylos-seed` only: verify and install the first signed statement into `<mnt>/var/lib/keylos/config/` (§4.14) |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Failure |
| 2 | Usage error |
| 3 | Denied |
| 4 | Conflict (counter moved, plan stale) |
| 5 | Not found |
| 6 | Approval declined |
| 7 | Integrity failure |
| 10 | Evaluation error (with Nickel diagnostics on stderr) |
| 11 | Lint failure (`check`) |

### 5.4 Files

| Path | Content |
|---|---|
| `/var/lib/keylos/config/src/` | System source (git) |
| `/var/lib/keylos/config/statements/<counter>.dsse` | Every retained configgen statement (read by `boot`, §4.7.4) |
| `/var/lib/keylos/config/current.dsse`, `previous.dsse` | Pointers (copies) of the current and previous statements |
| `/var/lib/keylos/config/activation-failed.json` | Failed activation (§4.7.3, protocols §15); read by `config` and `config-recover`, not by `boot` |
| `/var/lib/keylos/tpm/nv-auth/0x01300101.sealed` | TPM-sealed authValue of NV `0x01300101`; written by `installer`/`hearth`, read by `config` only (protocols §10.7) |
| `/var/lib/keylos/config/adopt/<app>/` | Scratch restore for `adopt` (§4.10) |
| `/var/lib/keylos/config/plans/<plan>/` | Plan workspace (source copy, trees, record) |
| `/var/lib/keylos/config/host` | Hostname selection |
| `/usr/share/keylos/config/schemas/`, `profiles/`, `lib/` | Schema library (in the OS generation) |
| `/etc/keylos/{services.json, policy.ref, owner-seal/<i>.spki, publishers.json, exceptions/*.dsse, strata/snapshot-exclude.list, app-visible.list}` | Cross-repository files in the config generation, in the formats and with the readers of protocols §10.7 |
| `/etc/keylos/fleet/approvers.json` | `keylos.fleetapprovers/1` (protocols §20.23), only when a fleet module is accepted (REQ-CONFIG-037) |
| `/etc/keylos/<service>.json`, `/etc/<service>/…` (for example `/etc/net/net.toml`, `/etc/strata/strata.toml`, `/etc/devd/devd.toml`) | Each service's own configuration, in the format its repository's spec defines, rendered only by that service's module and visible only to that service (protocols §10.7 per-service rule, REQ-CONFIG-038) |
| `/etc/passwd`, `/etc/group` | Ordinary OS files for legacy views |

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| Malware with runtime root-equivalent access persists through config | `/etc` is a read-only verity-protected generation. A new generation requires an owner-presence signature, which needs a physical FIDO2 touch. `boot` refuses unsigned or rolled-back generations ("reboot heals") |
| A malicious Nickel source exploits the evaluator | `config-eval` is sealed, has no capabilities and no network, uses resolver-restricted imports, runs in a 2 GiB/120 s sandbox, and outputs only CBOR. `config` validates its output |
| An agent sneaks an escalation into a proposal | Apply is disabled for agent-origin plans. Self-escalation is detected and highlighted. Presence is required |
| Plan/apply TOCTOU (the source changes after review) | The plan stores a reflink copy of the source and the trees with computed digests. Apply imports exactly those trees and re-verifies the digests |
| Replay of an old signed statement | NV counter rule (protocols §15, §4.7.4); `parent` chain |
| The presence prompt shows less than the plan | The trusted-path prompt renders the statement (generation digest, source revision, proposer, counter). The CLI shows the same values next to the full plan, so the owner can match what was reviewed with what is signed. The signed generation digest commits to every file |
| Secret leakage into `/etc` (world-readable inside service views) | Secret references only, detectors, plus per-file modes and owners |
| Lowering approval tiers through config | The compiler forbids lowering. `broker` independently refuses policies that lower protocol-mandated tiers, as defence in depth |
| A fleet organisation over-reaches | Fleet permits apply only with owner acceptance. Locks are visible in plans. Fleet modules are signed generations from an enrolled publisher key |

### 6.2 Self-confinement

`config` is tier 0 with these allowances:

| Allowance | Why |
|---|---|
| seccomp: `move_mount`, `umount2`, `mount_setattr` | `/etc` swap only; mount fds come from `depot` |
| TPM access (`/dev/tpmrm0` fd from `warden`) | NV counter `0x01300101`: read through the public `NV_Read` branch, incremented with the authValue unsealed from `/var/lib/keylos/tpm/nv-auth/0x01300101.sealed` (bound to the PCR11 `ready` phase and PCR15, protocols §19.6). No owner-hierarchy operations: re-defining the counter goes through `HearthTpm.defineSpace` |
| Landlock: rw `/var/lib/keylos/config`; ro `/usr/share/keylos/config`, `/etc`; no exec except its own generation | |
| Capabilities: `CAP_SYS_ADMIN` (mount operations in the host mount namespace) | Ambient in its cgroup only |
| Network | None |

`config-eval` is tier 0 with the plain baseline, no extra allowances, no capabilities, and only the passed dirfds plus stdout.

`config-recover` runs only in the recovery profile: read-only access to `/var/lib/keylos/hearth/owners.log` (protocols §10.7), read-write to `/var/lib/keylos/config`, read-only to `/store/gens`, the FIDO2 hidraw node, the console; no network, no TPM writes. `config bootstrap` runs inside the installer's or `keylos-seed`'s sandbox with read access to the passed source dirfd and the OS generation, write access only to `<dir>` (compile) or `<mnt>/var/lib/keylos/config` (install), and no network or TPM.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| Evaluation error | Plan not created; diagnostics returned (exit 10) |
| Presence declined or timed out | `kl:denied`; plan stays valid until expiry |
| TPM unavailable | `apply` fails with `kl:unavailable`. The machine continues on the current generation. Recovery is possible through the recovery environment with the recovery key (see `installer`) |
| `depot` import fails | Apply aborts before the NV increment. No state change |
| Crash during apply | §4.7.1 crash windows: the statement is always written before the NV increment, so `boot` never sees a counter without a statement; `config` repairs the pointers at next start |
| Service health failure after activation | Automatic re-activation of the previous generation (§4.7.3) |
| `broker` rejects the new policy generation | `BrokerSystem.validatePolicy` runs at plan time (§4.6.1 step 6), so a rejected policy never reaches apply. If `loadPolicy` still fails at activation, `config` performs the runtime fallback of §4.7.3 and reports `kl:invalid` with the broker's diagnostics |
| Owner key lost | The recovery ceremony of `hearth`/`installer` adds new owner-presence credentials to the owner registry (op `recover`, protocols §20.3). The next statement is signed with a new credential and verifies against the updated registry |
| A configuration prevents login or breaks the desktop | Recovery boot entry → `config-recover` (§4.7.6): a presence-signed revert statement with a higher counter; NV raised at the next normal start |
| Quorum request expires before enough approvers sign | `Plan.apply` re-requests on the next call; the plan itself stays valid until its own expiry |
| NV counter below the newest valid statement (crash window, recovery revert) | At start, `config` increments NV to the statement's counter and repairs the pointers (§4.7.1) |

---

## 8. Performance budgets

| Operation | Budget |
|---|---|
| Evaluate the desktop default config (about 2,000 options) | ≤ 3 s, ≤ 1 GiB RSS |
| Plan (eval + trees + digests + diff) | ≤ 6 s |
| Apply excluding the human prompt | ≤ 4 s to activation start |
| `/etc` swap | ≤ 50 ms |
| `drift` | ≤ 2 s |
| `config` daemon idle RSS | ≤ 30 MiB |

---

## 9. Observability

### 9.1 Receipts

| Event | Data |
|---|---|
| `config.apply` | `{generation, policyGeneration, counter, sourceRev, parent, proposedBy, approval}` |
| `config.revert` | Same fields plus `revertedTo` and `origin` (`"owner"` or `"recovery"`; recovery reverts are spooled by the recovery environment and replayed by `ledger`, protocols §19.3) |
| `config.plan` | `{plan, origin, sourceRev, selfEscalation}`. Emitted for agent-origin plans and for plans that change trust inputs (publishers, exceptions, fleet acceptance) |
| `config.activation-rollback` | `{failed, services, counter}`; written together with `activation-failed.json` (protocols §15) |
| `x-config.safe-boot` | `{bootReport}`: `boot` used the safe config of the OS generation (§4.7.4) |
| `x-config.exception` | `{name, kind, publisher, op: "add"\|"remove"}` |

`config` holds the `ledger` facet `writer`. Core events are those registered for `config` in protocols §19.3 (Appendix A.17). `x-config.*` events follow the protocols extension rule.

### 9.2 Metrics

| Metric | Type |
|---|---|
| `config_eval_seconds` | histogram |
| `config_plan_total{origin_kind}` | counter |
| `config_apply_total{result}` | counter |
| `config_activation_rollback_total` | counter |
| `config_generation_counter` | gauge |
| `config_drift_items` | gauge |

### 9.3 Logs

Structured, with fields `plan`, `generation`, `module`, `service`.

---

## 10. Configuration

`config` configures itself through its own module `config` (rendered to `/etc/config/config.toml`; `presence.assistedAllowed` is also rendered into the policy generation's `/policy/defaults.json` for `broker` and `hearth`):

```nickel
{
  config | {
    eval | { memoryMiB | Number | default = 2048, timeoutSecs | Number | default = 120 },
    planTtlHours | Number | default = 24,
    keepGenerations | Number | default = 50,
    activation | { healthTimeoutSecs | Number | default = 60, stableSecs | Number | default = 10 },
    allowDirtyPlans | Bool | default = true,
    notifyOnAgentProposal | Bool | default = true,
    presence | {
      # purposes (protocols §20.2) for which an assisted platform credential (protocols §5.3) counts as presence
      assistedAllowed | Array String | default = ["*"],
    },
  }
}
```

---

## 11. Testing and acceptance criteria

### 11.1 Unit tests

- The module merge and priority table: every row in §4.2, including `force` from fleet locks.
- Contract errors for undeclared options, with suggestions.
- Renderer determinism: golden files for each format; byte identity across 100 runs and across x86-64/aarch64.
- Secret detectors: positive and negative corpora.
- Cedar compilation from structured policy, strict validation, and tier-lowering rejection.
- Capability-diff probe matrix: old/new policy pairs with expected sentences.

### 11.2 Integration tests (VM)

| ID | Scenario | Pass condition |
|---|---|---|
| IT-01 | Apply a change to `net.dns`; service reloads | `/etc/net/net.toml` updated; `net` reloaded; `config.apply` receipt; NV counter +1 |
| IT-02 | Apply where a service fails to start | Runtime re-activation of the previous generation; `config.activation-rollback` receipt; after reboot the new generation is selected again and the fallback repeats; applying a fix ends the loop |
| IT-03 | Power cut injected at each apply step (§4.7.1) | `boot` selects a valid owner-signed generation with counter ≥ NV; never an unsigned one; `config` repairs pointers at next start |
| IT-04 | Replace the statements directory with an older copy from backup (rollback attempt) | No statement has counter ≥ NV: `boot` uses the safe config; `x-config.safe-boot` receipt |
| IT-05 | Agent proposes a change granting its own template a new host | Plan flagged self-escalation; apply via the agent facet denied; owner apply works with presence |
| IT-06 | Source containing an inline private key | `config check` exit 11; plan refused |
| IT-07 | Fleet-locked option overridden locally | Evaluation error naming the organisation |
| IT-08 | `adopt` for a JSON-settings app after user edits | Patch reproduces the edits; applying it and resetting the app layer yields identical effective settings |
| IT-09 | Determinism: same source on two machines | Identical `gen:` digests |
| IT-10 | Concurrent applies from two shells | One succeeds, the other gets `kl:conflict` |
| IT-11 | `config exception add` for a non-reproducible app; apply; reboot | Envelope presence-verified; present in `/etc/keylos/exceptions/`; app launches at tier 1 after `depot` imports it |
| IT-12 | `ConfigFleet.installFleetModule` without owner acceptance | Module pending; evaluation unchanged; after an owner apply that accepts it, locks apply |
| IT-13 | Plan with a policy that lowers a protocol-mandated tier | Compiler error; `validatePolicy` would also reject |
| IT-14 | Rendered `/etc/keylos/services.json` with `network: "host"` for an app service; with a route to an unregistered facet; with a `bpf` path outside `/usr/lib/keylos/bpf/<service>/` | Each fails validation with the offending service named; a correct table passes the protocols `services/` vectors |
| IT-15 | `policy.ref` | Equals `keylos.policyref/1` of the plan's policy generation; `broker` starts with it and refuses a generation with a different manifest digest |
| IT-16 | Owner-seal SPKIs | `/etc/keylos/owner-seal/<i>.spki` equals the registry's `sealKey` for every owner; adding an owner adds a file at the next apply |
| IT-17 | Quorum machine (threshold 2 of 3): apply with one approver; then with two approvers of the same owner; then two distinct owners | `kl:needs-approval`; still `kl:needs-approval`; applied, `approvedBy` lists both |
| IT-18 | `ConfigFleet.applyRemote` with a statement not matching any pending plan; with a correct statement and threshold signatures | `kl:conflict`; applied exactly like `Plan.apply` |
| IT-19 | A generation whose service never becomes ready; reboot; recovery boot entry → `config-recover` with a touch | Runtime fallback and `activation-failed.json`; after reboot the failure repeats; the recovery revert writes a higher-counter statement; the next normal boot activates the reverted content and raises NV |
| IT-20 | `config exception add --kind fleet-receipt-access` | Presence-signed envelope lands in `/etc/keylos/exceptions/`; `ledger` honours it after apply |
| IT-21 | Accept a fleet module with two approvers and `commandQuorum` 2; then a module with `commandQuorum` 3 | `/etc/keylos/fleet/approvers.json` validates against the protocols `fleetcommand/` vectors and `hearth` accepts a 2-of-2 `lock` command; the second module fails validation; removing the fleet module removes the file at the next apply |
| IT-22 | `services.json` with `network: "cluster"` for `crid` on `server-k8s`; the same on `desktop`; `network: "host"` for `cri` | Passes; fails (wrong profile); fails (host not allowed for cri) |
| IT-23 | A module rendering `/etc/strata/strata.toml` from the `net` module | Evaluation error naming both modules (REQ-CONFIG-038) |
| IT-24 | `config-recover` with an `owners.log` whose last line has a bad signature | Replay stops at the last good entry; the line is reported; a revert signed by an owner present in the good prefix succeeds |
| IT-25 | Cloud seed: `keylos-seed` calls `config bootstrap install` with a quorum-signed seed statement; first normal boot | Statement installed as `statements/1.dsse` and `current.dsse`; `config` verifies it against `HearthSystem.owners` (quorum of presigned owners) and raises NV to 1; a seed statement with one signature short of threshold leaves `config status` at `unverified` |

### 11.3 Fuzzing

- `fuzz_rendered_cbor`: the parser of evaluator output.
- `fuzz_nickel_import_resolver`: path containment.
- `fuzz_adopt_parsers`: JSON, TOML, INI and dconf parsers.

### 11.4 Conformance

`config` MUST pass protocols suites `dsse/`, `presence/`, `manifest/`, `cedar/`, `receipts/`, `ids/` and `tpm/`.

### 11.5 Acceptance for 1.0

IT-01 to IT-20 pass on both architectures; §8 budgets are met; every core schema module has documentation and at least one golden render test.

---

## 12. Implementation notes

### 12.1 Crates

| Need | Crate |
|---|---|
| Nickel | `nickel-lang-core` (pinned version; its import resolver is wrapped) |
| Cedar | `cedar-policy` 4.x |
| Git | `gix` (gitoxide) 0.6x |
| TOML | `toml_edit` 0.22 |
| YAML | `serde_yaml` 0.9 (or a maintained fork, pinned) |
| JSON/JCS | `serde_json` + `keylos-formats` JCS |
| CBOR | `ciborium` |
| TPM | `tss-esapi` 7.x, constants from `keylos-tpm-registry` |
| Presence verification | `keylos-presence` 1.0 |
| Diff | `similar` 2.x (unified diffs) |
| EROFS/composefs building | `composefs` Rust crate if suitable, otherwise `mkcomposefs` invoked inside `depot`; `config` only computes digests using `keylos-ids` fs-verity helpers plus the EROFS layout writer shared with `depot` (crate `keylos-erofs` published by `depot`) |

### 12.2 Layout

```
config/
  crates/config-model/      rendered tree types, plan types, statement building
  crates/config-render/     serializers, dconf GVDB writer
  crates/config-plan/       diffing, capability diff, probe matrix
  crates/config-eval/       evaluator binary (nickel embedding, restricted resolver)
  crates/config/            daemon (capwire server)
  crates/config-cli/        `config` CLI
  schemas/                  core modules (*.ncl)
  profiles/                 desktop.ncl, server.ncl, appliance.ncl
  lib/                      secret.ncl, uri.ncl, helpers
  schema/config-ext.capnp
  tests/
```

### 12.3 Packaging

- Generation `io.keylos.config` (tier 0) with entrypoints `main` and `eval`.
- Generation `io.keylos.config-schemas` (kind `data`), included in the OS generation.
- `reproducible: true`.

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reference |
|---|---|---|
| Nickel as the configuration language | Pkl (JVM/GraalVM toolchain, weaker merge model); CUE (Go; unification fits validation but not layered defaults); the Nix language (evaluator cost, ecosystem coupling); plain TOML (no types or merges) | [ADR-0021](../../handbook/11-decisions/adr-0021-nickel-configuration.md) |
| Read-only `/etc` from signed confext generations | Mutable `/etc` with drift detection (malware can persist); Augeas-managed files (no integrity) | [ADR-0022](../../handbook/11-decisions/adr-0022-read-only-etc-confext.md) |
| Owner presence (FIDO2) for every apply | Password or polkit prompt (spoofable, phishable); no prompt for small changes (persistence path) | [ADR-0011](../../handbook/11-decisions/adr-0011-owner-presence-fido2.md) |
| Agents propose, humans sign | Agents with scoped config rights (no safe subset of system configuration) | [ADR-0029](../../handbook/11-decisions/adr-0029-agents-propose-humans-sign.md) |
| Cedar for policy, compiled from structured Nickel | Cedar text only (harder to merge and lock); OPA/Rego (less analyzable) | [ADR-0006](../../handbook/11-decisions/adr-0006-cedar-policy.md) |
| TPM NV counter for anti-rollback | Timestamps (the clock is untrusted offline); none | [ADR-0014](../../handbook/11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md) |
| Rendering in Rust, values in Nickel | String templating in Nickel (non-deterministic formatting, escaping bugs) | — |
| Approval tiers can only be raised by config | Freely configurable tiers (lets policy undo the agent safety model) | [ADR-0028](../../handbook/11-decisions/adr-0028-approval-tiers.md) |
| Quorum presence on headless and managed machines | A single remote owner key (one stolen key changes configuration); no presence on servers | [ADR-0048](../../handbook/11-decisions/adr-0048-quorum-presence.md) |
| Recovery revert instead of automatic boot fallback | Automatic fallback to the previous generation (a rollback below the NV floor that an attacker could provoke by breaking a service) | protocols §15 |

### 13.1 Notes on cross-repository contracts

- **N1.** `config-recover` replays `owners.log` itself in the recovery profile, as protocols §10.7 registers (§4.7.6).
- **N2.** The recovery environment spools receipts in `keylos.pendingreceipt/1`, a format owned by `installer`; `config-recover` hands it the receipt payload and never writes the spool itself (protocols §19.4: formats owned by another repository are not parsed or produced elsewhere).

---

## Appendix A — Embedded contracts (verbatim)

### A.1 protocols §3.4, §3.5 — Principals and identifiers

> Verbatim copy of `protocols/spec.md` lines 152–182, 184–214 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 3.4 Principal identifiers

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

### 3.5 Other identifiers

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


### A.2 protocols §5 — Signed documents, trust roots, presence signatures

> Verbatim copy of `protocols/spec.md` lines 250–326 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

## 5. Signed documents

### 5.1 Envelope

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

### 5.2 Trust roots

| Root | Holder | Signs |
|---|---|---|
| `distro-root` | The keylos project: offline, 3-of-5 threshold, as the TUF root role | TUF delegations, release-stream keys |
| `release-stream/<stream>` | Project, HSM (Ed25519) | Release statements (§20.6), OS and distro generation statements, PCR policies, revocations for that stream (`stable`, `beta`, `dev`) |
| `kernel-policy/<stream>` | Project, HSM (RSA-3072, X.509 in the kernel's secondary keyring at build time) | The IPE policy (PKCS#7) |
| `rebuilder/<operator>` | Independent rebuilder operators (Ed25519) | Realisation attestations |
| `log/<origin>` and `witness/<name>` | Log and witness operators (Ed25519, C2SP note keys) | Checkpoints, cosignatures |
| `owner-presence` | The machine owners' FIDO2 credentials (§5.3) | Config generation statements, seal windows, T3 mandates, owner-registry entries, policy changes |
| `owner-seal/<i>` | One TPM-resident P-256 key per owner *i* (§11.6, §19.6) | Seal statements and generation statements of owner-sealed generations |
| `service/<name>` | Each tier-0 service; TPM-sealed Ed25519 key created at first boot. Public keys are registered with `ledger` (receipt `ledger.key.register`, whose clear data is `{service, spki}`, countersigned by the machine key) and served by `Ledger.serviceKey` (§7.3.5) | Receipts it writes; service-issued records (consent, grant records, quorum requests by `hearth`) |
| `recovery-recipient` | X25519 key derived from the recovery key (§20.21); only its public half is stored on the machine (`/var/lib/keylos/recovery/recipient.pub`) | Nothing (encryption only): HPKE recovery copies (owner-hierarchy auth, vault `recovery` slots) |
| `session/<id>` | Ephemeral Ed25519 key per agent session, held in `vault` (created by `aide`) | Agent git commits, flow proofs |
| `publisher/<id>` | Third-party app publishers, onboarded through the TUF `publishers` delegated role: an Ed25519 hardware-held key, or a Sigstore identity (OIDC issuer + subject) named in the delegation (§20.20) | App generation statements |
| `org-publisher/<org>/<id>` | Organisation publishers delegated by a fleet's TUF repository (fleet-enrolled machines only) | Generation statements of org apps and of `container` generations for `keylos-sealed` pods (§21) |
| `catalog` | Project, HSM (Ed25519), TUF delegated role `catalog` | The catalog (`keylos.catalog/1`, §20.20) |
| `approver/<id>` | Org approvers' keys registered by `fleet` (FIDO2 or the `vouch` phone approval key) | Org-approval mandates (§16.2) |
| `service/broker` (mandate role) | The broker's service key | Non-presence mandates (§14.4) |

### 5.3 Presence signatures

A FIDO2 authenticator cannot sign arbitrary bytes: it signs `authenticatorData ‖ clientDataHash`. A presence signature over a DSSE payload is constructed as follows:

```
pae := DSSE-PAE(payloadType, payload)
cdh := SHA-256(pae)
assertion := CTAP2 authenticatorGetAssertion(rpId = "keylos.owner", clientDataHash = cdh,
                                              allowList = enrolled credentials, options = {up: true, uv: per purpose})
sigObj := {"keyid": "key:sha256:<SPKI of credential>", "alg": "fido2-es256" | "fido2-eddsa",
           "sig": base64(CBOR{1: authenticatorData, 2: signature, 3: credentialId})}
```

Verification (crate `keylos-presence`; every verifier MUST use it or an equivalent conforming implementation):
1. Check the payload is JCS-canonical and its `schema` matches the expected purpose (§20.2).
2. Decode the CBOR map. Check `authenticatorData.rpIdHash == SHA-256("keylos.owner")`.
3. Check the UP flag is set, and the UV flag when the purpose requires it.
4. Look up the credential by `keyid` in the **owner registry** (§20.3) state current at the payload's `time`. The credential MUST NOT have been removed before that time.
5. Verify `signature` over `authenticatorData ‖ cdh` with the credential's COSE key.

Stateful verifiers (`hearth`) SHOULD track `signCount`. Stateless verifiers (`boot`) skip it.

Login assertions (screen unlock, greeter) use the separate rpId `keylos.login` and are never accepted as presence signatures; presence always uses `keylos.owner`.

The FIDO2 `hmac-secret` extension is used only by `hearth` for the seal gate (§11.6). Its outputs never leave `hearth`.

**Accepted authenticators.** Any FIDO2 authenticator with user verification counts, roaming or platform. `hearth` includes a TPM-backed platform authenticator for owners who cannot operate a roaming key: user presence is a confirmation on the trusted path (a pointer, keyboard or switch-access action inside the atrium-drawn prompt), user verification is the owner's PIN entered there. Such a credential is enrolled with `"assisted": true` in its owner-registry entry (§20.3); `status`, the `vouch` verdict and every presence prompt show it. The platform authenticator's TPM signing key and its `hmac-secret` key are created under the SRK `0x81000001` with `userWithAuth` **clear** and authPolicy `PolicyPCR(sha256:{15}) ∧ PolicyAuthValue`, whose authValue `hearth` derives from the owner's PIN; PCR15 alone never authorizes a signature. Their blob `/var/lib/keylos/hearth/platform/<keyid>.blob` (§10.7) is the JCS object `{"rpId", "credentialId", "cose", "salt", "key", "hmacKey"}`, binary members in standard base64, `key` and `hmacKey` each `TPM2B_PRIVATE ‖ TPM2B_PUBLIC`. Policy MAY forbid assisted credentials for specific purposes (`config.presence.assistedAllowed`, default: allowed for every purpose).

### 5.4 Quorum presence

Headless profiles (`server`, `server-k8s`, `cloud`, `appliance`) and managed machines use **quorum presence** instead of a local touch. The owner registry (§20.3) then has `policy.mode = "quorum"` and `policy.threshold = N`, with M approver credentials (the owners' FIDO2 credentials, enrolled like any owner credential).

- A **quorum presence envelope** is an ordinary DSSE envelope over the same payload with **≥ N signatures** (§5.3 construction) from credentials of **distinct owners**. Verifiers MUST count distinct owners, not signatures.
- Collection: `hearth` creates a quorum request (`keylos.quorum/1`, §20.18) through `HearthQuorum.request` (§7.5.3); approvers receive it through `fleet` (or out of band as a file), review the rendered payload on their own keylos machine, and sign it there with `hearth presence --remote <request>` (their machine's `hearth` signs with their own credential and rpId `keylos.owner`); signatures return through `HearthQuorum.submit`. The request expires after at most 24 h.
- Every purpose of §20.2 accepts a quorum envelope on quorum machines. On `desktop`/`laptop` profiles quorum envelopes are accepted only for owner-registry changes that the registry policy marks `quorum`.
- **Seal gate on quorum machines.** No touch reaches the machine, so the seal gate's authValue for the window is released differently: `hearth` holds the next gate authValue in a TPM-sealed blob bound to the signed PCR11 `ready` phase and PCR15, and unseals it only after verifying a quorum envelope of purpose `seal.window`. This reduces the guarantee from "a physical touch" to "N approvers signed and the machine runs a verified `hearth`"; the reduction is shown in `status` (`sealing: quorum`).


### A.3 protocols §6.1–§6.3 — Generation kinds, layout, manifest

> Verbatim copy of `protocols/spec.md` lines 332–348, 350–361, 363–444 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 6.1 Generation kinds

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

### 6.2 Layout

A generation is an EROFS image in composefs format:
- Every **non-empty** regular file is an overlay metacopy whose redirect names a store object, with the fs-verity digest of that object in `trusted.overlay.metacopy`.
- Zero-length regular files are stored inline in the EROFS image with no redirect.

The image root MUST contain `/.keylos/manifest.json`. It MAY contain:
- `/.keylos/cmdsig/<command>.json` (command signatures, §12)
- `/.keylos/sbom.spdx.json` (SPDX 2.3 or 3.0 JSON)
- `/.keylos/provenance.json` (the realisation attestations bundle, §11.3)
- `/.keylos/agent/` (agent templates only, §6.4)
- `/.keylos/l10n/<lang>.json` (localised strings, §6.3)

### 6.3 Manifest schema (`keylos.manifest/1`)

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


### A.4 protocols §7.1, §7.2 — capwire model, routes and facets

> Verbatim copy of `protocols/spec.md` lines 503–527, 529–541 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 7.1 Model

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

### 7.2 Routes and facets

`warden` wires services according to **routes** declared in service and app manifests plus policy.

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

- A **facet** is a server-defined restriction name. The registry of every facet, its holders and the methods it allows is §19.2. Servers MUST refuse methods their facet doesn't allow with `kl:denied`.
- Route references are written `service#facet` (for example `vault#app`).
- The server learns the facet of each connection from `ServiceHost.accept` (§7.5.1) or `Supervisor.connectionInfo`.
- Service sockets live under `/run/keylos/svc/<service>/` with mode `0700`, owned by `warden`'s UID. No other principal can `connect()` to them. Connections are created by `warden` (`socketpair` + hand-off through `ServiceHost.accept`).
- Dynamic routes (a service capability granted at runtime) are materialised by `broker` through `ServiceConnect.connectService` (§7.5.1).


### A.5 protocols §7.3.1 — common.capnp and error codes

> Verbatim copy of `protocols/spec.md` lines 555–636 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.1 `common.capnp`

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


### A.6 protocols §7.3.11 — config.capnp (implemented)

> Verbatim copy of `protocols/spec.md` lines 1146–1168 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.11 `config.capnp`

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


### A.7 protocols §7.5.14 — config-sys.capnp (implemented)

> Verbatim copy of `protocols/spec.md` lines 2366–2379 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.5.14 `config-sys.capnp`

```capnp
@0xc7a1e5d3b2f4002d;
using C = import "common.capnp";

interface ConfigFleet {            # facet fleet
  installFleetModule @0 (gen :C.Ref) -> ();   #! effective only after an owner-signed config apply accepts the enrolment
  removeFleetModule  @1 () -> ();
  applyRemote        @2 (statement :Data, approverEnvelopes :List(Data)) -> (generation :C.Ref);
      #! managed machines: statement is keylos.configgen/1; approverEnvelopes carry presence signatures of org admins who are
      #! owners of this machine; config merges them into one quorum envelope (§5.4) and applies like Plan.apply
}
```


### A.8 protocols §7.3.4 — prompt.capnp (consumed: presence, notify)

> Verbatim copy of `protocols/spec.md` lines 837–900 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.4 `prompt.capnp` (trusted path; implemented by `atrium`, used by `broker`, `hearth`, `vault`, `config`, `depot`, `fleet`, `vouch`)

```capnp
@0xc7a1e5d3b2f40004;
using C = import "common.capnp";

enum ApprovalTier { t0 @0; t1 @1; t2 @2; t3 @3; }

struct RenderedEffect {
  kind      @0 :Text;            # e.g. "email.send", "fs.merge", "config.apply"
  title     @1 :Text;
  body      @2 :Text;            # plain text or sanitized markdown
  mime      @3 :Text;            # "text/plain" | "text/markdown" | "text/x-diff" | "image/png"
  attachment @4 :C.Fd;           # optional large rendering (diff, preview)
  reversible @5 :Bool;
  review     @6 :Review;          #! required (default): approval is enabled only when this rendering was presented completely (§14.3)
  payloadDigest @7 :C.Digest;     #! digest of the mandate-draft effect this rendering presents (sha256)
  enum Review { required @0; decorative @1; }   #! decorative: optional preview; set only by gate or broker, never by a requester
}

struct ArgProvenance {
  argument @0 :Text;
  source   @1 :Text;             # e.g. "web:https://example.com/page", "file:/home/…", "user"
  label    @2 :C.Label;
}

struct ApprovalPrompt {
  id         @0 :Text;
  tier       @1 :ApprovalTier;
  principal  @2 :C.PrincipalId;
  summary    @3 :Text;
  effects    @4 :List(RenderedEffect);
  provenance @5 :List(ArgProvenance);
  mandateDraft @6 :Data;          # JCS payload of the mandate to be signed if approved
  requiresPresence @7 :Bool;      # FIDO2 touch required
  expires    @8 :C.Timestamp;
  channels   @9 :List(Text);      # approval channels allowed for this prompt ("local", "phone", "org"), §14.3; empty = ["local"]
  requester  @10 :Text;           # for family machines: the non-owner human on whose behalf an owner is asked (§14.3); empty otherwise
}

struct Decision {
  approved @0 :Bool;
  scope    @1 :Scope;
  mandate  @2 :Data;              # DSSE envelope (presence-signed when requiresPresence, else signed by the atrium approver key)
  note     @3 :Text;
  enum Scope { once @0; session @1; persistent @2; }
}

interface TrustedPrompt {
  approve  @0 (prompt :ApprovalPrompt) -> (decision :Decision);
  presence @1 (purpose :Text, payload :Data, rendering :List(RenderedEffect)) -> (envelope :Data);
      # DSSE signed by owner-presence (§5.3), rendered on the trusted path; rendering (optional) is shown
      # alongside the statement (for example a config plan diff) and its digests are displayed for cross-checking
  notify   @2 (title :Text, body :Text, severity :Severity) -> ();
  secret   @3 (title :Text, body :Text, confirm :Bool) -> (secret :C.Fd);
      #! secret entry on the trusted path (recovery key, trustee card, new PIN, passphrase); confirm = enter twice;
      #! the value is returned in the delivery format of §20.10; facet secret only
  enum Severity { info @0; warning @1; critical @2; }
}
```

**Required review material.** Every `RenderedEffect` is `review = required` unless `gate` or `broker` marked it `decorative`; a requester can never make a rendering optional, and an unknown or absent value means `required`. The trusted path (local prompts, presence cards, phone, org and quorum review) enables approval only when every required rendering was presented **completely**: its `payloadDigest` equals the digest of the mandate-draft effect it presents, it carries all required review details of its effect kind (§14.2), and nothing required is missing, malformed, unsupported or truncated beyond the channel's review limits. When a decoder or renderer crashes or times out, a canonical-text fallback produced by `gate` may replace the rendering only if it presents every required detail within the limits; otherwise the effect can only be denied or deferred. A title or a digest alone never substitutes for required details. A channel that cannot present the required material (for example a phone over its size limit) does not offer the approval: it stays pending for a capable channel or expires and is denied under its normal lifecycle (§14.3).

**Secret entry.** `TrustedPrompt.secret` (facet `secret`: `hearth` for recovery keys, trustee cards, new PINs and passphrases; `vault` for import passphrases) asks for a secret on the trusted path and returns it in the delivery format of §20.10; the value never passes through the requesting app.


### A.9 protocols §7.3.8 — depot.capnp (consumed)

> Verbatim copy of `protocols/spec.md` lines 1023–1071 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.8 `depot.capnp`

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


### A.10 protocols §7.3.2, §7.5.1 — warden.capnp and warden-sys.capnp (consumed; ServiceHost implemented)

> Verbatim copy of `protocols/spec.md` lines 638–722, 1573–1744 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.2 `warden.capnp`

```capnp
@0xc7a1e5d3b2f40002;
using C = import "common.capnp";

enum Tier { t0 @0; t1 @1; t2 @2; t3 @3; legacy @4; }

struct FdMapping { target @0 :Int32; fd @1 :C.Fd; }

struct Limits {
  cpuWeight  @0 :UInt16 = 100;    # cgroup cpu.weight
  memoryMax  @1 :UInt64;          # bytes, 0 = inherit
  pidsMax    @2 :UInt32;          # 0 = inherit
  ioWeight   @3 :UInt16 = 100;
  wallSecs   @4 :UInt32;          # 0 = unlimited
}

struct SpawnSpec {
  generation  @0 :C.Ref;          #! kind gen; MUST be launchable (sealed, not revoked)
  entrypoint  @1 :Text;           # manifest entrypoint key, default "main"
  argv        @2 :List(Text);     # appended to entrypoint args
  env         @3 :List(C.KeyValue);  #! secrets MUST NOT be passed via env; warden rejects names matching policy secret patterns and reserved KEYLOS_* names;
                                     #! for actorKind pod the secret-pattern check is skipped (the admitted Kubernetes env may carry secrets, §21)
  fds         @4 :List(FdMapping);   # explicit fds; nothing else is inherited
  grants      @5 :List(C.Token);     # tokens attached to the new principal
  cwd         @6 :C.Fd;              # O_PATH dirfd; optional
  limits      @7 :Limits;
  terminal    @8 :C.Fd;              # pty secondary; optional; warden calls setsid+TIOCSCTTY
  session     @9 :C.SessionId;       # new child session id; warden generates if empty
  actorKind   @10 :ActorKind;
  transaction @11 :Text;             # optional strata transaction id (x-…); warden mounts the transaction views over the granted dirs
  enum ActorKind { app @0; service @1; agent @2; legacy @3; bench @4; shell @5; pod @6; }
  attempt     @12 :C.AttemptBinding; #! workflow attempt (§20.25): honoured only from service loom (facet service); warden forwards it
                                     #! unchanged in SessionReg.attempt and never interprets it; set by any other caller: kl:denied
}

struct ExitStatus {
  union {
    exited   @0 :Int32;
    signaled @1 :Int32;
    failedToStart @2 :Text;   # kl:<code> reason
  }
  cpuNanos @3 :UInt64;
  maxRss   @4 :UInt64;
}

interface Process {
  pidfd     @0 () -> (fd :C.Fd);             # kl:unsupported for VM processes
  principal @1 () -> (id :C.PrincipalId);
  wait      @2 () -> (status :ExitStatus);
  signal    @3 (signo :Int32) -> ();         #! delivered to every process of the principal's cgroup
  kill      @4 () -> ();                     # cgroup.kill
  confinement @5 () -> (report :Text);       # JSON confinement report, protocols §9.4
  freeze    @6 () -> ();                     # cgroup.freeze = 1
  thaw      @7 () -> ();                     # cgroup.freeze = 0
}

struct ConnectionInfo {
  peer   @0 :C.PrincipalId;
  facet  @1 :Text;
  tier   @2 :Tier;
  label  @3 :C.Label;          # current session label (from broker)
  generation @4 :C.Ref;
}

interface Supervisor {
  spawn          @0 (spec :SpawnSpec) -> (process :Process);   #! the child's session chain extends the caller's
  identify       @1 (pidfd :C.Fd) -> (id :C.PrincipalId, tier :Tier, generation :C.Ref);
  connectionInfo @2 (connectionId :UInt64) -> (info :ConnectionInfo);
  services       @3 () -> (list :List(ServiceStatus));
  control        @4 (service :Text, op :ServiceOp) -> (status :ServiceStatus);
      #! service "_system" is the pseudo-target for system power: ops poweroff/reboot (facet admin only)
  enum ServiceOp { start @0; stop @1; restart @2; reload @3; poweroff @4; reboot @5; }
}

struct ServiceStatus {
  name       @0 :Text;
  state      @1 :State;
  generation @2 :C.Ref;
  since      @3 :C.Timestamp;
  restarts   @4 :UInt32;
  enum State { inactive @0; starting @1; running @2; stopping @3; failed @4; }
}
```

#### 7.5.1 `warden-sys.capnp`

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


### A.11 protocols §7.5.2 — broker-sys.capnp (consumed: loadPolicy, validatePolicy)

> Verbatim copy of `protocols/spec.md` lines 1746–1827 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.5.2 `broker-sys.capnp`

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


### A.12 protocols §7.3.12, §7.5.3 — hearth.capnp and hearth-sys.capnp (consumed)

> Verbatim copy of `protocols/spec.md` lines 1170–1194, 1829–1903 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.12 `hearth.capnp`

```capnp
@0xc7a1e5d3b2f40012;
using C = import "common.capnp";

struct UserInfo { name @0 :Text; displayName @1 :Text; uid @2 :UInt32; owner @3 :Bool; locked @4 :Bool; }

interface Hearth {
  users     @0 () -> (list :List(UserInfo));
  login     @1 (user :Text, method :Text, response :Data) -> (session :C.SessionId);   # facet greeter
      #! methods: "password", "pin", "fido2"; "guest" (user and response empty: creates an ephemeral guest-… user and
      #! session, §3.3, §14.3); "kiosk" (kiosk profile only: autologin of the configured kiosk user, response empty)
  lock      @2 (session :C.SessionId) -> ();
  unlock    @3 (session :C.SessionId, method :Text, response :Data) -> ();
  presence  @4 (purpose :Text, payload :Data, assist :Data) -> (envelope :Data);   # FIDO2 assertion → DSSE presence envelope (§5.3)
      #! assist (facet atrium only): PIN or switch-access confirmation collected on the trusted path for an assisted
      #! platform authenticator (§5.3); empty for roaming authenticators and on every other facet
  enrollKey @5 (user :Text, kind :Text) -> (keyRef :Text);           # requires presence of an existing owner credential
  removeKey @6 (keyRef :Text) -> ();
}
```

- **Assisted presence.** The prompt id that binds an `assist` confirmation to its request is `sha256:<hex>` of the DSSE PAE of `payload`; atrium and hearth compute it independently.
- **`enrollKey`** of a kind that adds a vault slot (`fido2` login keys) requires the target user's vault key to be unlocked (`VaultUsers.addSlot`, §7.5.4) and fails `kl:unavailable:user-locked` until that user has logged in.

#### 7.5.3 `hearth-sys.capnp`

```capnp
@0xc7a1e5d3b2f40022;
using C = import "common.capnp";

interface HearthSystem {           # facet system
  validateSession @0 (session :C.SessionId) -> (user :Text, authenticatedAt :C.Timestamp, methods :List(Text), locked :Bool);
  owners          @1 () -> (registryJson :Text);            # keylos.owners/1 (§20.3)
  prepareSuspend  @2 () -> ();                              # devd before suspend; returns within 2 s
  resumed         @3 () -> ();
  exportPasswd    @4 () -> (passwd :Text, group :Text);     # for legacy views
  userState       @5 (user :Text) -> (locked :Bool, since :C.Timestamp);
      #! locked = the user has no authenticated, unlocked login session (logged out counts as locked); loom only
  watchUsers      @6 (watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);
      #! JCS {"user", "locked", "since", "deleted"} for every change of userState of any user and for user deletion; loom only
}

interface HearthSeal {             # facets seal (depot, forge)
  openWindow  @0 (windowJson :Text) -> (windowId :Text, presenceEnvelope :Data);   # keylos.seal-window/1 (§20.4); touch on trusted path
  sealSign    @1 (windowId :Text, statementJson :Text) -> (signature :Data, keyRef :Text);   # ECDSA P-256 DER by owner-seal/<i>
      #! any facet-seal holder may sign within a window another holder opened;
      #! statementJson MUST be keylos.seal/1 or keylos.genstmt/1 and its drv MUST be in the window's drvs, else kl:denied
  closeWindow @2 (windowId :Text) -> ();
}

interface HearthTpm {              # facet tpm (courier, vault, strata, ledger, config; vouch and fleet: activateCredential only)
  defineSpace @0 (index :UInt32) -> ();
      #! (re)defines an NV index listed in §19.6 with exactly its registry template; only the index's registered owner may call
  evict       @1 (handle :UInt32) -> ();
      #! evicts a persistent handle listed in §19.6 (e.g. 0x81000103 after first boot); presence required except for 0x81000103
  sbSign      @2 (which :Text, payload :Data, presenceEnvelope :Data) -> (signature :Data);
      #! which = "kek" | "db": signs an authenticated-variable update (PKCS#7 payload digest) with 0x81000101 / 0x81000102
      #! behind the seal gate; presenceEnvelope purpose "boot.sb-sign" covering SHA-256(payload); caller courier
  activateCredential @3 (akHandle :UInt32, credentialBlob :Data, encryptedSecret :Data) -> (secret :Data);
      #! TPM2_ActivateCredential with the EK (endorsement auth held by hearth) for AK 0x81010002 or AK0 0x81010003;
      #! used by vouch pairing and fleet enrolment to prove the AK lives in this TPM
  recreateKey        @4 (handle :UInt32, presenceEnvelope :Data) -> ();
      #! re-creates a persistent key listed in §19.6 from its registry template after a TPM clear or loss (e.g. the strata
      #! anchor HMAC key 0x81000110); only the key's registered owner may call; presence purpose "boot.recreate-key"
  sbAccepted         @5 (kekCert :C.Digest, dbCert :C.Digest) -> ();
      #! courier only: the firmware KEK and db variables (read back at boot) contain the new owner certificates with these
      #! SHA-256 digests; hearth then swaps the staged signers onto 0x81000101/0x81000102 (kl:conflict if nothing is staged)
}

interface HearthQuorum {           # facets presence (request, collect), quorum (submit: fleet), admin (list)
  request @0 (purpose :Text, payload :Data, rendering :List(Text)) -> (requestId :Text, requestEnvelope :Data);
      #! creates a keylos.quorum/1 request (§20.18), signed by service/hearth with its ledger key chain; expires ≤ 24 h
  submit  @1 (requestId :Text, signedEnvelope :Data) -> (have :UInt8, need :UInt8);
      #! adds approver signatures (each a §5.3 signature over the request's payload PAE) after verifying them
  collect @2 (requestId :Text) -> (envelope :Data);   #! kl:needs-approval until ≥ threshold distinct owners have signed
  list    @3 () -> (json :Text);
}

interface HearthFleet {            # facet fleet-lock (fleet)
  lockAll @0 (commandEnvelope :Data) -> ();
      #! verified keylos.fleet.command/1 "lock": locks every session, revokes every agent session (kill), requires owner unlock
}

interface HearthAdmin {            # facet admin
  createUser  @0 (name :Text, displayName :Text, owner :Bool) -> (uid :UInt32);   # presence
  disableUser @1 (name :Text, disabled :Bool) -> ();                                # presence
  deleteUser  @2 (name :Text, forgetData :Bool) -> ();                              # presence
  setPassword @3 (name :Text, secret :C.Fd) -> ();
  addOwner    @4 (name :Text) -> ();                                                # presence (quorum)
  removeOwner @5 (name :Text) -> ();
  setQuorum   @6 (addOwner :UInt8, remove :UInt8) -> ();   #! superseded before release: MUST return kl:unsupported
  registry    @7 () -> (json :Text);
  setQuorumPolicy @8 (mode :Text, quorum :UInt8, threshold :UInt8) -> ();
      #! appends a set-quorum owner-registry entry (§20.3): mode "touch" | "quorum"; quorum = owners required for
      #! owner-set changes; threshold = distinct owners for quorum presence (mode quorum)
}
```

**NV definition after genesis.** Once `hearth` holds the owner hierarchy authorization (installer genesis), every service that needs one of its registered NV indices (re)created obtains it through `HearthTpm.defineSpace`; no other service uses owner authorization. `defineSpace` defines the index from its registry template, generates a fresh authValue, and writes the sealed authValue file `nv-auth/0x<index>.sealed` (§19.6) before returning. `HearthQuorum` on facet `admin` serves `collect` and `list`; each `list` entry includes `requestEnvelope` (standard base64).


### A.13 protocols §7.3.10, §7.5.7 — strata.capnp and strata-sys.capnp (consumed by adopt)

> Verbatim copy of `protocols/spec.md` lines 1099–1144, 1986–2072 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.10 `strata.capnp`

```capnp
@0xc7a1e5d3b2f40010;
using C = import "common.capnp";

enum NetworkPolicy { deny @0; gate @1; inherit @2; }
  #! deny: processes in the transaction get no network; gate: egress only via gate with the caller's tokens; inherit: the spawner's own policy

struct Change { path @0 :Text; kind @1 :Kind; enum Kind { added @0; modified @1; deleted @2; renamed @3; meta @4; } from @2 :Text; }

struct Conflict { path @0 :Text; reason @1 :Text; }

interface Transaction {
  id      @0 () -> (id :Text);
  view    @1 () -> (dirs :List(C.Fd));         # O_PATH dirfds of the overlay views (same order as begin)
  changes @2 () -> (changes :List(Change));
  diff    @3 (path :Text) -> (diff :C.Fd);
  conflicts @4 () -> (conflicts :List(Conflict));
  commit  @5 () -> (snapshot :Text);           # returns pre-commit snapshot id (undo point)
  abort   @6 () -> ();
}

struct Provenance {
  principal   @0 :C.PrincipalId;
  generation  @1 :C.Ref;
  transaction @2 :Text;
  created     @3 :C.Timestamp;
  label       @4 :C.Label;
}

struct SnapshotInfo { id @0 :Text; subvolume @1 :Text; created @2 :C.Timestamp; reason @3 :Text; pinned @4 :Bool; }

interface Strata {
  begin     @0 (dirs :List(C.Fd), networkPolicy :NetworkPolicy) -> (txn :Transaction);   #! holding the dirfds is the authority
  snapshot  @1 (subvolume :Text, reason :Text) -> (info :SnapshotInfo);
  snapshots @2 (subvolume :Text) -> (list :List(SnapshotInfo));
  restore   @3 (snapshot :Text, path :Text, target :C.Fd) -> ();
  undo      @4 (transaction :Text) -> ();
  why       @5 (file :C.Fd) -> (provenance :Provenance);
  forget    @6 (unit :Text) -> ();             # crypto-shred a data unit
  createUnit @7 (path :C.Fd, unit :Text, policy :Text) -> ();
}
```

**Transaction storage backends.** `begin` dispatches each target dirfd to a registered backend. A plain btrfs directory uses the snapshot and overlay path. A plaintext view of a sealed unit served over FUSE (`keylos.unitfs/1`) is resolved through `strata`'s own mount records to (unit, relative subtree); `strata` clones the unit's ciphertext backing subvolume (a read-only base and a writable working clone) and serves a transaction-specific plaintext view of that subtree only. Changes and prepared merges are computed on the logical plaintext views; commit applies the logical operations to the live backing through the unit format, after quiescing the unit and fencing its writers. No plaintext upper layer, undo copy or journal content of a sealed unit is ever stored outside its encrypted backing; undo uses a ciphertext pre-commit snapshot, and `forget` of the unit aborts its transactions and leaves every transaction artifact undecryptable. While the unit is locked its transaction views are unavailable and commits fail `kl:unavailable`. Mixed backends in one transaction, nested units and cross-unit transactions fail `kl:unsupported`.

#### 7.5.7 `strata-sys.capnp`

```capnp
@0xc7a1e5d3b2f40026;
using C = import "common.capnp";
using S = import "strata.capnp";

enum Choice { ours @0; theirs @1; merged @2; }

interface TransactionExt {
  policy            @0 () -> (networkPolicy :S.NetworkPolicy, views :List(Text));   # view paths for warden mounting
  resolve           @1 (path :Text, choice :Choice, merged :C.Fd) -> ();
  changeSet         @2 () -> (jcs :C.Fd, digest :C.Digest);                         # keylos.changeset/1
  commitWithMandate @3 (mandate :Data) -> (snapshot :Text);                         #! superseded before release by prepare + PreparedMerge.commit: MUST return kl:unsupported
  pin               @4 (pinned :Bool) -> ();
  owner             @5 () -> (session :C.SessionId);                                # session that began the transaction
  prepare           @6 () -> (prepared :PreparedMerge);
      #! freezes the views, captures the live state of every affected path, applies recorded resolutions and clean three-way
      #! merges, and stores the result as an immutable prepared merge (§20.12 keylos.fsmerge/2); kl:conflict while conflicts remain
  bindWorkflow      @7 (binding :C.AttemptBinding) -> ();
      #! facets bench, aide: the transaction (and every prepared merge of it) is owned by binding.workflow from now on (§20.25);
      #! strata verifies the binding for the transaction's owner session with BrokerWorkflow.verify; idempotent; kl:conflict if
      #! the transaction is already bound to another workflow
}

interface PreparedMerge {
  id       @0 () -> (id :Text);                                  # pm-… (§3.5)
  manifest @1 () -> (jcs :C.Fd, digest :C.Digest);               # keylos.fsmerge/2; digest = the fs.merge payload digest
  diff     @2 (path :Text) -> (diff :C.Fd);                      # unified diff of the stored result ("" = whole merge)
  commit   @3 (mandate :Data) -> (snapshot :Text);
      #! verifies the mandate binds digest, takes a writer fence (PrincipalControl.fenceWriters), revalidates every expectedLive
      #! entry and applies exactly the stored operations (no new merge, no overlay read); stale live state → kl:conflict
  discard  @4 () -> ();
  status   @5 () -> (state :Text, transaction :Text, snapshot :Text);
      #! durable completion record: state "prepared" | "committed" | "discarded" | "stale"; for "committed" the commit's
      #! transaction id and pre-commit (undo) snapshot. Retained at least until the owning workflow's horizon (§20.25)
}

interface StrataTxn {              # facets user, bench, aide, cli, warden
  txnExt @0 (id :Text) -> (txn :S.Transaction, ext :TransactionExt);
      #! user/bench/aide/cli: only transactions begun by the caller (or its session ancestors).
      #! warden: any; warden MUST check that the spawner's session equals owner() or descends from it before mounting views
  prepared @1 (id :Text) -> (prepared :PreparedMerge);
      #! user/bench/aide/cli: prepared merges of the caller's own transactions (same ownership rule as txnExt); not on facet warden
  preparedFor @2 (id :Text, binding :C.AttemptBinding) -> (prepared :PreparedMerge);
      #! facets bench, aide: a prepared merge of a transaction bound to binding.workflow (bindWorkflow), for a fresh attempt of that
      #! workflow that does not descend from the session that prepared it; strata verifies the binding is current
      #! (BrokerWorkflow.verify); a stale or foreign binding: kl:not-found
}

struct UnitInfo { id @0 :Text; alias @1 :Text; mode @2 :Text; subvolumes @3 :List(Text); mounted @4 :Bool; backend @5 :Text; }
struct SubvolInfo { uuid @0 :Text; path @1 :Text; kind @2 :Text; human @3 :Text; owner @4 :Text; unit @5 :Text; snapshotClass @6 :Text; backupClass @7 :Text; }
struct BackupStatus { target @0 :Text; lastRun @1 :C.Timestamp; lastResult @2 :Text; lastRestoreTest @3 :C.Timestamp; nextRun @4 :C.Timestamp; }

interface StrataAdmin {            # facet admin; mountUnit also on facet warden; lockUnits/unlockUnits also on facet hearth; preUpdate also on facet courier
  subvolumes      @0 (human :Text) -> (list :List(SubvolInfo));
  createSubvolume @1 (parent :C.Fd, name :Text, kind :Text, owner :Text) -> (info :SubvolInfo);
  deleteSubvolume @2 (uuid :Text) -> ();
  units           @3 () -> (list :List(UnitInfo));
  mountUnit       @4 (unit :Text) -> (view :C.Fd);       # detached mount fd of the plaintext view
  lockUnits       @5 (human :Text) -> ();
  unlockUnits     @6 (human :Text) -> ();
  pin             @7 (snapshot :Text, pinned :Bool) -> ();
  deleteSnapshot  @8 (snapshot :Text) -> ();
  backupNow       @9 (target :Text) -> (run :Text);
  backups         @10 () -> (list :List(BackupStatus));
  status          @11 () -> (json :Text);
  preUpdate       @12 (reason :Text) -> (set :Text);      # snapshot set before an OS update
}

interface StrataHomes {            # facet hearth
  createHome @0 (user :Text, uid :UInt32) -> (info :SubvolInfo);
  deleteHome @1 (user :Text, forget :Bool) -> ();
  createEphemeralHome @2 (user :Text, uid :UInt32) -> (info :SubvolInfo);   # guest sessions: not snapshotted, ephemeral unit key
}

interface StrataVolumes {          # facet cri
  create  @0 (podId :Text, name :Text, kind :Text, sizeBytes :UInt64) -> (dir :C.Fd);
      #! kind "emptyDir" (subvolume, deleted with the pod) | "local" (local PersistentVolume, kept until release);
      #! dir is an O_PATH fd; sizeBytes is enforced without qgroups: strata scans usage every 30 s and reports
      #! over-limit volumes in usage(), and cri evicts the pod (Kubernetes ephemeral-storage semantics)
  release @1 (podId :Text, name :Text) -> ();
  usage   @2 (podId :Text) -> (json :Text);
}
```

On facet `gate`, strata serves `Strata.undo` only, for transactions that were committed by an `fs.merge` intent whose compensation `gate` executes (§14.2).


### A.14 protocols §7.3.5 — ledger.capnp (consumed)

> Verbatim copy of `protocols/spec.md` lines 902–936 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.5 `ledger.capnp`

```capnp
@0xc7a1e5d3b2f40005;
using C = import "common.capnp";

struct ReceiptRef { seq @0 :UInt64; digest @1 :C.Digest; }

struct Checkpoint { note @0 :Text; }   #! C2SP signed-note checkpoint text, protocols §13.3

struct Filter {
  principalPrefix @0 :Text;
  sessionId  @1 :Text;
  eventTypes @2 :List(Text);
  since      @3 :C.Timestamp;
  until      @4 :C.Timestamp;
  limit      @5 :UInt32;
  fromSeq    @6 :UInt64;          # 0 = from the start; only receipts with seq ≥ fromSeq (continuation: fromSeq = query's next)
}

interface Ledger {
  append     @0 (envelope :Data) -> (ref :ReceiptRef);     #! facet "writer" only
  get        @1 (seq :UInt64) -> (envelope :Data);
  query      @2 (filter :Filter) -> (envelopes :List(Data), next :UInt64);
  checkpoint @3 () -> (checkpoint :Checkpoint);
  prove      @4 (seq :UInt64, treeSize :UInt64) -> (hashes :List(Data));   # RFC 6962 inclusion proof
  consistency @5 (from :UInt64, to :UInt64) -> (hashes :List(Data));
  watch      @6 (filter :Filter, watcher :C.Watcher(Data)) -> (cancel :C.Cancelable);
  serviceKey @7 (service :Text) -> (spki :Data, keyRef :Text, registered :C.Timestamp);
      #! facet reader: the currently registered key of service/<service> (from ledger.key.register); kl:not-found if none.
      #! Relying services use it to verify service-signed records, e.g. non-presence mandates signed by service/broker (§14.4)
}
```

**Read access** (facet `reader`; `writer` includes it): a principal sees receipts whose `subject` or `writer` is itself or a descendant session; a `shell` principal sees every receipt whose subject's human is its human; agent principals see only their own session chain; tier-0 services see receipts per their facet entry in §19.2, and every writer service sees every receipt whose `writer` actor is its own service name under any session and generation (`service:<name>:…`, also from earlier boots), so it can reconcile its own submissions (§20.25); `fleet` (facet `fleet-export`) sees metadata only, unless an owner exception of kind `fleet-receipt-access` (§20.9) lists the event type. Sealed payloads (§13.4) are decrypted for a reader only if the reader may read the receipt **and** the unit key still exists; receipts of crypto-shredded units are returned redacted (`keylos.receipt-redacted/1`). The returned form of a decrypted sealed receipt is defined in §13.4. `query` returns matching visible receipts in increasing `seq`, at most `limit`; `next` is the `seq` of the first matching visible receipt that was not returned (0 = none), and a client continues with the same filter and `fromSeq = next`. `watch` ignores `fromSeq`. Facet `vouch-heartbeat` (vouchd) sees only the metadata (time, subject human) of `user.login` receipts of every human, for the inheritance dead-man timer (§20.19).


### A.15 protocols §9.3 — Code integrity (host)

> Verbatim copy of `protocols/spec.md` lines 2953–3021 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 9.3 Code integrity (host)

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


### A.16 protocols §10.1, §10.5, §10.7 — Host layout, environment and cross-repository files

> Verbatim copy of `protocols/spec.md` lines 3058–3089, 3131–3177, 3186–3232 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 10.1 Host layout

| Path | Content | Properties |
|---|---|---|
| `/` | OS generation (composefs, `verity=require`) | ro |
| `/usr` | Part of the OS generation | ro |
| `/etc` | Merged config generation (confext) | ro |
| `/var` | btrfs subvolume `@var` | rw, `nosuid,nodev,noexec` |
| `/home/<user>` | btrfs subvolume per user | rw, `nosuid,nodev,noexec` |
| `/home/<user>/.apps/<app-name>/{config,data,cache,state}` | Subvolume per app and user | the only writable paths in an app's view |
| `/store/objects/<2 hex>/<62 hex>` | Store objects, fs-verity enabled, mode 0444 | written only by `depot` |
| `/store/gens/<64 hex>.erofs` | Generation images | |
| `/store/evidence/` | Generation statements, attestations, consent records | `depot` |
| `/store/db/` | `depot` database | |
| `/store/rcpt/` | `ledger` data | |
| `/keystore` | btrfs subvolume `@keystore`, **excluded from all snapshots** | `vault`, `hearth`, `ledger`, `strata` key material (wrapped) |
| `/snapshots` | btrfs snapshot area, `strata` only | |
| `/run` | tmpfs | |
| `/run/keylos/svc/<svc>/` | Service socket directories | 0700 warden |
| `/run/keylos/boot/trust.json`, `report.json` | Boot trust set and boot report (§20.1) | 0444, written by `boot` |
| `/var/lib/keylos/<repo>/` | Each service's private state directory (other repos may read only the files listed in §10.7) | owned by the service's dynamic UID |
| `/var/lib/keylos/cri/images/` | OCI content store for `keylos-vm` pods (unsealed, never executed on the host) | `cri`; `noexec`; shared read-only into pod VMs |
| `/efi` | ESP | mounted only during updates (and by `boot` for `/efi/keylos/vbu-totp.sealed`) |

**App mount view** (what a tier-1 process sees):
- its app generation at `/` (with `/usr` from its runtime generation if it declares one);
- `/etc` filtered to the app-visible subset (`/etc/keylos/app-visible.list` in the config generation);
- its `.apps/<name>` subvolumes at `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `$XDG_CACHE_HOME`, `$XDG_STATE_HOME` (idmapped to its dynamic UID);
- `/run/user/<uid>/` with only its Wayland socket (security-context tagged) and its PipeWire remote if granted;
- `/grants/` (initially empty; runtime grants are attached here);
- `/tmp` as a private tmpfs;
- nothing else.

### 10.5 Environment conventions

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

### 10.7 Cross-repository files

A repository MAY read a file written by another repository **only if the file is listed here**; everything else is that repository's private state.

| Path | Format | Writer | Readers |
|---|---|---|---|
| `/run/keylos/boot/trust.json`, `report.json` | `keylos.boottrust/1`, `keylos.bootreport/1` (§20.1) | boot | any tier-0 service, `vouch` tooling |
| `/etc/keylos/services.json` | `keylos.services/1` (§20.16) | config | warden, boot, ledger |
| `/etc/keylos/policy.ref` | `keylos.policyref/1` (§20.17) | config | warden, broker |
| `/etc/keylos/owner-seal/<i>.spki` | DER SubjectPublicKeyInfo | config | boot |
| `/etc/keylos/publishers.json` | `keylos.publishers/1` (§20.20) | config | boot, depot |
| `/etc/keylos/exceptions/*.dsse` | `keylos.exception/1` envelopes (§20.9) | config | depot, ledger, warden (effective tiers) |
| `/etc/keylos/strata/snapshot-exclude.list` | newline-separated absolute paths | config | strata, vault |
| `/etc/keylos/app-visible.list` | newline-separated paths under `/etc` | config | warden |
| `/store/evidence/<hex>/statement.dsse` | `keylos.genstmt/1` envelope (§20.7), `<hex>` = generation digest | depot | boot, warden |
| `/store/revocations/<stream>.dsse` | `keylos.revocations/1` envelope (§11.7) | depot | boot, warden |
| `/var/lib/keylos/config/*.dsse` | `keylos.configgen/1` envelopes (§15) | config | boot |
| `/var/lib/keylos/hearth/owners.log` | owner registry (§20.3) | hearth (installer at genesis; installer's `rescue` in the recovery profile: `recover` and credential entries) | boot (replay in the initrd); `config-recover` and `rescue` (recovery profile only) |
| `/var/lib/keylos/fleet/wipe.dsse` | wipe bundle: the §20.23 wipe command plus an owner quorum envelope of purpose `boot.wipe` (§20.2) | fleet | `rescue` (recovery profile only) |
| `/var/lib/keylos/tpm/nv-auth/<index>.sealed` | `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` of the sealed authValue object (§19.6, "Sealed secrets"); `<index>` is `0x` + 8 lowercase hex digits, e.g. `0x01300100.sealed` | installer at genesis; hearth on (re)definition (`HearthTpm.defineSpace`); `rescue` (recovery profile) | the index's registered owner service only |
| `/var/lib/keylos/tpm/hierarchy-owner.sealed`, `hierarchy-endorsement.sealed` | TPM-sealed hierarchy authValues (§19.6) | installer at genesis; hearth on rotation | hearth |
| `/var/lib/keylos/tpm/hierarchy-owner.recovery` | HPKE (§4) ciphertext of the owner-hierarchy authValue to the recovery recipient (§20.21) | installer; hearth on rotation | recovery environment |
| `/var/lib/keylos/hearth/seal-gate-<i>.sealed` | quorum seal-gate blob (§19.6) | installer at genesis (quorum machines); hearth | hearth |
| `/var/lib/keylos/hearth/platform/<keyid>.blob` | assisted platform authenticator blob: JCS `{rpId, credentialId, cose, salt, key, hmacKey}` (§5.3) | installer (assisted credential enrolled at install); hearth | hearth |
| `/var/lib/keylos/recovery/recipient.pub` | 32-byte raw X25519 public key of the recovery recipient (§20.21) | installer | vault, hearth |
| `/var/lib/keylos/recovery/pending/<ULID>.dsse` | `keylos.pendingreceipt/1` (§20.22) | recovery environment (`rescue`, installer repo) | ledger (appends at the next normal boot, then deletes) |
| `/var/lib/keylos/devd/preauthorized.json` | `keylos.preauth/1` (§9.5) | installer | devd |
| `/etc/keylos/fleet/approvers.json` | `keylos.fleetapprovers/1` (§20.23); the only source of org approver keys | config (fleet module) | hearth, rescue (recovery environment), broker |
| `/keystore/ledger/signing.sealed` | TPM-sealed Ed25519 seed of the machine key | installer | ledger (MUST accept an existing key) |
| `/var/lib/keylos/firstboot/bundle.json` | `keylos.firstboot/1` (§20.13) | installer | the consumers listed in §20.13 |
| `/efi/keylos/vbu-totp.sealed` | sealed 20-byte TOTP secret (§20.5) | installer (`keylos-enrol vbu-totp`) | boot |
| `/usr/lib/keylos/bpf/<service>/*.o` | BPF ELF objects in the OS generation | pkgs (build) | warden |
| `/run/keylos/gate/ca.pem` (inside tier-L views) | PEM CA bundle of the principal's gate shim | gate | compat (sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`) |
| kernel command line `keylos.revocations=<serial>:<sha256>` | revocation list pin of the UKI's own release | release build (inside the signed UKI command line; `courier` only verifies it at staging) | boot |

**Per-service configuration files.** `/etc/keylos/<service>.json` and `/etc/<service>/*` are rendered by `config` and read only by that service; they need no row here, and their formats are defined in the service's own spec.

**Durable-execution state.** The durable records of §20.25 are private state of their owners (no other repository reads them); each lives in exactly one place, on persistent storage, behind a checked durability barrier:

| State | Owner | Location |
|---|---|---|
| Workflow store: enrollments, runs, steps, attempts, observations, timers, signals, tombstones, receipt outbox | loom | `/var/lib/keylos/loom/loom.db` (SQLite WAL, `synchronous=FULL`) and `/var/lib/keylos/loom/blobs/` |
| Workflow records (enrollment scope, epoch, label high-water mark, cancellation) and durable decisions | broker | `/var/lib/keylos/broker/workflows/`, `/var/lib/keylos/broker/decisions/` |
| Durable effect records and workflow budget accounts | gate | `/var/lib/keylos/gate/outbox.redb` (tables `effects`, `effects_by_workflow`), `/var/lib/keylos/gate/meter.redb` (table `accounts`) |
| Prepared-merge completion records | strata | strata's registry (strata spec) |

None of them may live in `warden`'s `FdStore`, under `/run`, in a diagnostic snapshot, or only in a ledger receipt.


### A.17 protocols §13.1, §13.4, §19.3 — Receipts, receipt privacy and receipt events

> Verbatim copy of `protocols/spec.md` lines 3374–3397, 3410–3421, 3941–3942, 3949, 3967 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 13.1 Receipt payload (`keylos.receipt/1`)

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

### 13.4 Receipt privacy

- **Which receipts are sealed.** Every receipt whose `subject` has a human other than `_system` and `_cluster` is stored **sealed**: the final payload has `"data": null, "label": null` and
  `"sealed": {"unit": "ledger:<human>:<YYYY-MM>", "alg": "aes-256-gcm", "nonce": "<base64 12 bytes>", "ct": "<base64 of the JCS bytes of {\"data\":…, \"label\":…}>", "submitted": "sha256:<digest of the submitted form>"}`.
  The AEAD associated data is the UTF-8 bytes of `sealed.unit`, one `0x00` byte, then the UTF-8 bytes of `sealed.submitted`. Optional top-level `refs` (object; values only `rcpt:`/`gen:`/`drv:` refs and `e-`/`a-`/`wf-`/`wr-`/`ws-`/`fx-`/`dr-`/`ba-` IDs) is added by the ledger and is not part of the submitted form. `ledger.key.register` is never sealed. Final receipts start at `seq` 1 (`prev: null` exactly for `seq` 1); signatures follow §13.1. Replayed receipts carry a top-level `onBehalfOf`.
  The month is the receipt's `time` month (UTC). The unit key comes from `vault.dataKey` on facet `ledger`.
- **What stays in clear:** `schema`, `seq`, `prev`, `time`, `writer`, `subject`, `event`, `approval`, and reference values the event registry marks as `refs` (rcpt/gen/drv refs; intent, approval, workflow, run, step, effect, decision and budget-account IDs; never free text or paths). For `workflow.*` and for `effect.*`, `approval.*`, `grant.*` and `budget.*` receipts that name a workflow, the ledger copies `data.workflow`, `data.run`, `data.step`, `data.effect`, `data.decision` and `data.account` into `refs`, so cancellation and effect evidence stays readable after a month is shredded (§20.25).
- **Integrity.** The hash chain and `service/ledger`'s countersignature cover the final (sealed) payload, so shredding a month preserves chain integrity. The writer's signature covers the submitted (clear) form; it is verifiable while the unit key exists. After shredding, writer attribution rests on the ledger countersignature and `sealed.submitted`.
- **Shredding.** `LedgerAdmin.shred` (§7.5.5) destroys `ledger:<human>:<YYYY-MM>`; an automatic job shreds months older than `ledger.retentionMonths` (default 13, configurable, minimum 1). Event `ledger.shred`.
- **Readers** follow §7.3.5. `fleet` sees metadata only unless an owner exception of kind `fleet-receipt-access` lists the event types.
- **Backups and exports** contain the sealed form; `ledger export` produces a self-contained verifiable bundle (`keylos.ledger-export/1`) and decrypts payloads only for the exporting owner.
- **Returned form.** `Ledger.get`, `query` and `watch` return each receipt as the stored final DSSE envelope (JSON object). When the reader may decrypt a sealed payload, the returned object carries one extra top-level member `"clear": {"data": …, "label": …}` (JCS). Verifiers MUST remove `clear` before checking signatures and computing the `rcpt:` digest, and MUST check `sealed.submitted` against the submitted form rebuilt from the clear values when verifying the writer signature.

| Event | Writer |
|---|---|
| `config.plan`, `config.apply`, `config.revert`, `config.activation-rollback` | config |

**Extension rule.** A repository MAY emit additional events named `x-<repo>.<event>` (for example `x-strata.replica.send`). They MUST be listed in that repository's spec, MUST be written only by that repository's services, and carry no semantics for other components. Events named without a prefix MUST appear in this table.


### A.18 protocols §14.2–§14.4 — Effect kinds, approval tiers, mandates

> Verbatim copy of `protocols/spec.md` lines 3454–3498, 3500–3519, 3521–3539 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 14.2 Effect kinds

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

### 14.3 Approval tiers

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

### 14.4 Mandates (`keylos.mandate/1`)

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


### A.19 protocols §15 — Config generation statement

> Verbatim copy of `protocols/spec.md` lines 3558–3569 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

## 15. Config generation statement (`keylos.configgen/1`)

```json
{"schema":"keylos.configgen/1","generation":"gen:fsv256:…","sourceRev":"git:sha1:…|sha256:…",
 "parent":"gen:fsv256:…","counter":57,"compiledBy":"gen:fsv256:<config compiler gen>",
 "proposedBy":"agent:…@alice/s-…","approvedBy":"alice","time":"…"}
```

- Signed by `owner-presence` (§5.3).
- `counter` MUST equal the TPM NV config counter (`0x01300101`, §19.6) + 1 at the time of signing. `config` increments the NV counter only after the signed generation is durably in the store. `boot` refuses a config generation whose counter is below the NV value. That is the anti-rollback rule.
- `boot` selects the highest-counter statement that verifies against the owner registry anchored in NV `0x01300105`, with `counter ≥` the NV value; if none qualifies, it boots the safe config shipped in the OS generation.
- **Activation failure.** `boot` never falls back automatically to an older config generation (that would be a rollback below the NV value). If a newly applied generation fails to activate (a tier-0 service fails its readiness check three times), `config` writes `/var/lib/keylos/config/activation-failed.json` (`{"generation", "counter", "failures": […]}`) and receipt `config.activation-rollback`; the **recovery boot entry** offers "revert to the previous configuration", which produces a **new** config generation with the previous content and counter + 1, signed with presence (or quorum) in the recovery environment.


### A.20 protocols §16 — Cedar policy schema

> Verbatim copy of `protocols/spec.md` lines 3573–3662 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

## 16. Cedar policy schema

### 16.1 Schema

Namespace `Keylos`. Policies are authored in config and compiled into `policy` generations. The `broker` evaluates every request with:
- principal = `Keylos::Principal`
- action = `Keylos::Action::"<op>"`
- resource = one of the entity types below
- context = request context

```
namespace Keylos {
  entity Human = { owner: Bool, guest: Bool };
  entity Principal in [Human] = {
    kind: String,              // app | service | agent | legacy | bench | shell | pod
    human: String,             // the principal's human ("_system", "_cluster" or a username)
    humanOwner: Bool,
    humanGuest: Bool,
    generationName: String,
    generation: String,
    tier: String,
    depth: Long,
    label: { conf: String, integ: String },
  };
  entity Path = { root: String, rel: String, labelConf: String, labelInteg: String };
  entity Host = { name: String, port: Long, sinkSafe: Bool, trusted: Bool };
  entity Device = { subsystem: String };
  entity Secret = { owner: String };
  entity Effect = { kind: String, class: String };
  entity Generation = { name: String, publisher: String, reproducible: Bool };
  entity Service = { name: String, facet: String };
  entity Budget = { unit: String };
  entity DebugTarget = { target: String, scope: String, targetHuman: String, targetKind: String };
  entity PodSpec = {
    namespace: String, name: String, runtimeClass: String,
    serviceAccount: String, labels: Set<String>,                    // Kubernetes labels as "key=value" strings
    images: Set<String>,                                            // "oci:sha256:…" or "gen:fsv256:…"
    privileged: Bool, hostNetwork: Bool, hostPID: Bool, hostIPC: Bool,
    hostPaths: Set<String>, hostPathsReadOnly: Bool,
    addedCapabilities: Set<String>, seccompProfile: String, appArmorProfile: String,
    runAsRoot: Bool, allowPrivilegeEscalation: Bool,
    gpuPassthrough: Long, csiDrivers: Set<String>, volumeTypes: Set<String>,
    cpuMillis: Long, memoryBytes: Long,
    allImagesSealed: Bool,                                          // every image is a gen: container generation (computed by cri)
  };
  entity Screen = { window: String, app: String };
  entity Model = { provider: String, model: String, version: String };
  entity Workflow = {
    definitionName: String, definition: String,                    // workflow name, "gen:fsv256:…" of its generation
    owner: String,                                                  // the owning human
    autoResume: Bool, runWhileLocked: Bool, horizonSecs: Long,
    scopeKinds: Set<String>,                                        // resource kinds of the enrollment scope ("path", "net", …)
    effectKinds: Set<String>,                                       // effect kinds the definition may commit
  };

  action "read", "write", "create", "delete", "exec" appliesTo { principal: Principal, resource: Path, context: Ctx };
  action "connect", "bind" appliesTo { principal: Principal, resource: Host, context: Ctx };
  action "use" appliesTo { principal: Principal, resource: [Device, Secret, Service, Model], context: Ctx };
  action "snapshot" appliesTo { principal: Principal, resource: Screen, context: Ctx };
  action "spend" appliesTo { principal: Principal, resource: Budget, context: Ctx };
  action "spawn" appliesTo { principal: Principal, resource: Generation, context: Ctx };
  action "stage", "commit" appliesTo { principal: Principal, resource: Effect, context: Ctx };
  action "delegate" appliesTo { principal: Principal, resource: Principal, context: Ctx };
  action "debug" appliesTo { principal: Principal, resource: DebugTarget, context: Ctx };
  action "admit" appliesTo { principal: Principal, resource: PodSpec, context: Ctx };   // principal = service:kubelet / cri
  action "enroll", "resume", "cancel" appliesTo { principal: Principal, resource: Workflow, context: Ctx };   // §20.25
  type Ctx = { time: Long, persist: Bool, durationSecs: Long, reason: String, approvalTier: String,
               amount?: Long, channel?: String, approver?: String,
               offlineDays?: Long, profile?: String, integrityProfile?: String, requester?: String,
               workflow?: String, epoch?: Long };            // workflow: the wf-… a request is decided for (§20.25); epoch: its claim
}
```

The distribution's default policy MUST contain at least these `admit` forbids: `privileged`, `hostNetwork`, `hostPID`, `hostIPC`, non-empty `addedCapabilities`, `seccompProfile == "unconfined"`, `allowPrivilegeEscalation`, and any `hostPaths` outside the read-only allowlist `cluster.hostPathAllowlist` (default empty). `runtimeClass == "keylos-sealed"` additionally requires `allImagesSealed` (every image is a `gen:` reference to a `container` generation; `cri` computes the attribute because Cedar has no quantifiers over sets). Policies about the same human (debug targets, family and guest rules) compare `principal.human` with `resource.targetHuman` or `context.requester`.

**Workflow decisions** (§20.25). `enroll`, `resume` and `cancel` are evaluated with the requesting session as principal and the `Workflow` entity as resource. Requests decided for a workflow without a live requesting session (attempt grants at registration, `BrokerWorkflow.authorizeEffect`, `decide`) are evaluated with a principal entity built from the workflow record: `kind` = the actor kind of the definition's generation (`app`, `service`, or `agent` for agent activities), `human` = the owner, `generationName`/`generation` of the activity's generation, `depth` = 1, `label` = the workflow label high-water mark, and `context.workflow`/`context.epoch` set. The default policy MUST contain: `enroll` only by a non-guest owner-or-user `shell` (or `atrium` for it) for workflows the human owns, with tier ≥ t2, and presence when `autoResume` or `runWhileLocked`; `resume` by the owner's `shell` at t0; `cancel` by the owner's `shell` (also when `aide` relays the owner's `AgentSession.stop`, `LoomSystem.cancelRequested`) and by owner `shell`s of the machine, at t0. Enrollment scope items are evaluated as persistent requests (`context.persist = true`).

### 16.2 Decision mapping and annotations

- `forbid` wins.
- `permit` with annotation `@tier("t2")` or `@tier("t3")` means "permitted after approval at that tier".
- `permit` with `@presence("true")` requires presence regardless of tier.
- `permit` with `@orgApproval("<group>")` means "permitted after an approval decided by `OrgDecider.decide` for that approver group" (fleet-enrolled machines only); `context.channel` is `"org"` and `context.approver` the approver key ref during evaluation of the resulting mandate.
- **Evaluation order** when a permit carries both `@tier` and `@orgApproval`: the local tier approval (trusted path, or phone if allowed) is obtained **first**; only after it is granted is `OrgDecider.decide` called. Both decisions are required, and the delivered mandate records both (`channel: "org"`, with the local decision's digest in `constraints.localDecision`). On BYOD fleet machines org policies MUST use this form for effects that touch the owner's personal data.
- `permit` with `@channels("local,phone")` lists the approval channels allowed for that permit (default `local`).
- A `permit` without a tier annotation means **T1 for action `connect`** and **T0 otherwise**.
- **Several matching permits** combine to the most restrictive requirement: the highest `@tier`, presence if any permit requires it, every `@orgApproval` group, and the intersection of the `@channels` sets (an empty intersection denies). `phone` never satisfies presence and is dropped when presence is required; on quorum machines presence is satisfied through the `quorum` channel.
- Annotation values: `@tier` ∈ `t0`…`t3`; `@presence` ∈ `"true"`/`"false"`; `@channels` a comma-separated subset of `local`, `phone`; anything else fails closed (deny). `@presence("true")` requires a synchronous trusted-path prompt with presence whatever the tier. `@orgApproval` without `@tier` needs no local interaction; on machines that are not fleet-enrolled such permits are ignored. Policies carry an `@id("<name>")` annotation, used in receipts and diagnostics.
- No matching `permit` means `denied`.
- On fleet-enrolled machines, org `forbid` policies are loaded into the same policy set and cannot be overridden by owner `permit`s.


### A.21 protocols §19.2 — Facets served by config and facets config holds

> Verbatim copy of `protocols/spec.md` lines 3783–3787, 3798–3799, 3802–3803, 3822, 3825, 3827, 3852, 3856, 3859, 3871–3876, 3879, 3888, 3898, 3904–3905 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| config | `owner` | owner `shell` | all, incl. `Plan.apply` |
| config | `user` | non-owner `shell`s | `current`, `history`, `drift`, `adopt` (own apps), `propose` |
| config | `propose` | aide | `propose` (with origin), `current` |
| config | `fleet` | fleet | `ConfigFleet`, `current`, `drift` |
| config | `read` | courier, journal | `current`, `history` |

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| warden | `client` | every principal | `Supervisor.spawn` (child of caller's session), `identify` |
| warden | `service` | tier-0 services | `Supervisor.spawn`, `identify`, `connectionInfo`; `FdStore`. `SpawnSpec.attempt` only from `loom` |
| warden | `admin` | owner `shell`, config, courier, devd, atrium | all `Supervisor` (including `control("_system", poweroff\|reboot)`); `PrincipalControl` |
| broker | `principal` | every principal | `Broker` |
| broker | `system` | warden, gate, aide, atrium, config, hearth, strata, net, depot, vault, vouch, cri | `BrokerSystem` (per-method callers as commented in §7.5.2; `requestFor` with the allowed-subject rule, atrium only for its own session (device authorization); `registerApprover`: atrium, vouch; `admitPod`: cri; `mintCaptive`: net); `Broker.inspect` |
| ledger | `writer` | tier-0 services listed as writers in §19.3 | `Ledger` (all) |
| ledger | `reader` | every principal | `Ledger` except `append` (filtered, §7.3.5) |
| hearth | `presence` | broker, config, depot, courier, ledger, vault, aide, strata | `presence`; `HearthQuorum.request`/`collect` |
| hearth | `system` | warden, devd, config, broker, gate, vouch, strata, bench, depot, ledger, loom | `HearthSystem` (gate, vouch, strata, bench, depot, ledger: `owners` only; loom: `owners`, `userState`, `watchUsers`) |
| hearth | `tpm` | courier, vault, strata, ledger, config, vouch, fleet | `HearthTpm` (`defineSpace`, `recreateKey`: the object's registered owner; `sbSign`, `sbAccepted`: courier; `activateCredential`: vouch, fleet) |
| depot | `config` | config | `importTree` (kinds `config`, `policy`), `mount` (kind `config`), `get` |
| depot | `admin` | config, owner `shell` (T3) | all incl. `gc` |
| courier | `admin` | owner `shell`, atrium settings, config | `Courier` (all) |
| strata | `admin` | config, owner `shell` | all; `StrataAdmin` |
| devd | `client` | every principal | `list`, `watch` (filtered); `PowerEvents.subscribe` |
| journal | `client` | every principal | `writer`, `query`/`follow` (own), `Crashes` (own human), `Metrics` (own) |
| bench | `admin` | owner `shell`, config | all, bench-local admin |
| atrium | `presence` | config, depot, courier, hearth, forge | `TrustedPrompt.presence` |
| atrium | `notify` | tier-0 services, portal-notify | `TrustedPrompt.notify` |


### A.22 protocols §19.6 — TPM objects

> Verbatim copy of `protocols/spec.md` lines 4040–4120 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 19.6 TPM objects

All keylos NV indices live in the owner-hierarchy NV range block **0x01300100–0x013001FF**.

**Common NV attributes.** Every keylos NV index has `TPMA_NV_OWNERREAD | TPMA_NV_AUTHREAD | TPMA_NV_POLICYREAD`, `TPMA_NV_NO_DA` unless stated otherwise, and `TPMA_NV_PLATFORMCREATE` clear. Its authPolicy is `PolicyOR{PolicyCommandCode(TPM2_CC_NV_Read), <write policy>}` where the index has a write policy, else `PolicyCommandCode(TPM2_CC_NV_Read)` alone, so **anyone with TPM access can read** counters, floors and heads (their contents are integrity-relevant, not secret) while writes stay controlled. Exception: the two `vault-epoch` indices are secret: `AUTHREAD | AUTHWRITE | NO_DA`, `OWNERREAD` and `POLICYREAD` clear, and an **empty authPolicy**, so every read and write needs the index's authValue, which is sealed like the others (PCR11 `ready` ∧ PCR15). Services that write an index hold its authValue as a TPM-sealed secret (`/var/lib/keylos/tpm/nv-auth/0x<8 lowercase hex>.sealed`, §10.7) bound to the signed PCR11 `ready` phase and PCR15 (volume identity).

**Sealed secrets.** Every secret this section calls "sealed to PCR11 `ready` ∧ PCR15" (NV authValue files, hierarchy blobs, service keys, quorum seal-gate blobs, the vault system key) is a keyedHash **sealed data object** created under the SRK `0x81000001`: nameAlg SHA-256; attributes `fixedTPM | fixedParent | adminWithPolicy | noDA`, with `userWithAuth` and `sensitiveDataOrigin` clear; empty authValue; the secret as sensitive data. It is stored as `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` (each marshalled with its size prefix).
- **Production authPolicy:** `PolicyAuthorize(release-stream PCR11 key, the signed policy for phase "ready")` followed by `PolicyPCR(sha256:{15})`; the approved policy the release key signs is `PolicyPCR(sha256:{11})` at the `ready` value (§20.6).
- **Development fallback:** `PolicyPCR(sha256:{15})` alone, used only by development builds where no signed PCR11 policy exists. Readers identify the variant by comparing the object's authPolicy with both digests; production builds accept only the production digest.

NV authValue files are written by the installer at genesis, by `hearth` whenever it (re)defines an index (`HearthTpm.defineSpace`, §7.5.3), and by `rescue`; each is read only by the index's registered owner.

**Hierarchy authorization.**
- **Owner hierarchy:** set at install to a random 32-byte value, stored as a TPM-sealed blob for `hearth` (PCR11 `ready` ∧ PCR15, `/var/lib/keylos/tpm/hierarchy-owner.sealed`) and, for recovery, as an HPKE ciphertext to the recovery recipient (`hierarchy-owner.recovery`, §20.21); `hearth` rewrites both when it rotates the value. `hearth` is the sole userspace holder of owner-hierarchy operations and exposes the needed ones through `HearthTpm` (§7.5.3). `boot` reads NV in the initrd through the `PolicyCommandCode(NV_Read)` branch; it never needs owner auth.
- **Endorsement hierarchy:** set to a random value sealed like the owner auth (used only for AK/AK0 provisioning).
- **Lockout:** random value derived as HKDF-SHA256(recovery key, "keylos-lockout/1"); only the recovery environment uses it.

| NV index | Name | Type and size | Write authorization | Owner |
|---|---|---|---|---|
| `0x01300100` | ledger-counter | counter | AUTHWRITE, authValue sealed to `ledger` | ledger |
| `0x01300101` | config-counter | counter | AUTHWRITE, authValue sealed to `config` | config (read by boot) |
| `0x01300102` | os-floor | ordinary, 8 bytes, u64 big-endian (minimum bootable release `seq`); `POLICYWRITE`, empty authValue (public reads, including `PolicyNV`) | `PolicyAuthorize(release-stream key, policyRef "keylos/floor-write/1")` over **exact-target** approved policies ("Floor writes" below) | courier, installer (read by boot) |
| `0x01300103` | pcrlock-policy | ordinary, 34 bytes (TPM2B_DIGEST) | `PolicyAuthorize(release-stream key, "keylos/pcrlock-write/1")` or `PolicySecret(recovery auth object 0x81000105)`; the index authPolicy is the **flat** `PolicyOR{PolicyCommandCode(NV_Read), PolicyAuthorize(…), PolicySecret(…)}` (never nested) | courier, boot (recovery) |
| `0x01300104` | keystore-floor | counter | AUTHWRITE, authValue sealed to `vault` | vault |
| `0x01300105` | owner-registry-head | ordinary, 104 bytes: SHA-256(last registry line) ‖ u64 BE seq ‖ SHA-256(JCS owner-presence key set) ‖ SHA-256(JCS owner Secure Boot certificate set) | AUTHWRITE, authValue sealed to `hearth` (installer at genesis) | hearth (read by boot) |
| `0x01300106` | login-failure-counter | counter | AUTHWRITE, authValue sealed to `hearth` | hearth |
| `0x01300107` | strata-anchor-counter | counter | AUTHWRITE, authValue sealed to `strata` | strata |
| `0x01300108` | attestation-key-names | ordinary, 68 bytes: Name(AK) ‖ Name(AK0) | owner authorization at enrolment | installer, boot (read by vouch tooling) |
| `0x01300110` | vault-epoch/0 | ordinary, 40 bytes: epoch key (32) ‖ u64 BE epoch; an all-zero key means erased | authValue (`AUTHREAD | AUTHWRITE`, empty authPolicy; authValue sealed to PCR11 `ready` ∧ PCR15 in `nv-auth/0x01300110.sealed`) | vault |
| `0x01300111` | vault-epoch/1 | same as vault-epoch/0; the two alternate as active and candidate index (vault §4.5.1) | authValue (as vault-epoch/0, `nv-auth/0x01300111.sealed`) | vault |
| `0x01300140 + i` (i < 16) | seal-gate/i | ordinary, 1 byte, used for its authValue; common attributes (`OWNERREAD`, `AUTHREAD`, `POLICYREAD`) plus `POLICYWRITE`; NO_DA **not** set. authPolicy = `PolicyOR{PolicyCommandCode(NV_Read), PolicyCommandCode(NV_ChangeAuth) ∧ PolicyAuthValue}` | `PolicyCommandCode(NV_ChangeAuth) ∧ PolicyAuthValue` | hearth |

**Seal-gate salts.** The FIDO2 `hmac-secret` salts for owner *i*'s window *k* are `s_k = SHA-256("keylos-seal" ‖ u64_be(k))` (k encoded as 8 bytes, big-endian), and the assertion carries `(s_k, s_{k+1})`. On **quorum** machines (§5.4) the next authValue is held in a TPM-sealed blob `/var/lib/keylos/hearth/seal-gate-<i>.sealed` (PCR11 `ready` ∧ PCR15) and released by `hearth` only after a verified quorum envelope of purpose `seal.window`.

**Changing a seal gate's authValue.** `TPM2_NV_ChangeAuth` under the gate's policy and "undefine, then define again with the identical template and the new authValue" (owner authorization, after proving the current authValue) are equivalent: the NV Name excludes the authValue and a gate is never written, so its Name, and every `PolicySecret` binding to it, is unchanged. With the second method `hearth` seals the new authValue durably before the undefine, and a start that finds a registered gate absent defines it again with that pending value.

**Floor writes.** For every UKI it releases, the release stream signs exactly one approved policy for `keylos/floor-write/1`, bound to that UKI's measured PCR11 value and to exactly one target value *F*:
- OS UKI (phase `ready`): `PolicyPCR(sha256:{11})` ∧ `PolicyNV(0x01300102, operand u64_be(F), offset 0, TPM_EO_UNSIGNED_LE)` (current floor ≤ *F*) ∧ `PolicyCpHash(TPM2_NV_Write(authHandle 0x01300102, nvIndex 0x01300102, data u64_be(F), offset 0))`, with *F* = the release's `floor` (§20.6).
- Installer UKI and the cloud UKI's `seed` profile: `PolicyPCR(sha256:{11})` ∧ `PolicyNvWritten(NO)` ∧ `PolicyCpHash(…write F…)`: initialisation of a freshly defined index only.
Two releases MUST NOT carry different *F* for the same UKI digest. In one measured boot only one target is therefore writable: concurrent or stale policy sessions can only write the same *F*, an older release's policy does not match PCR11, and a write never lowers the floor because `PolicyNV` refuses it when the current value exceeds *F* (the guarantee assumes the release-stream key is not compromised). The value written is exactly *F*, never an intermediate one; a lost acknowledgment is answered by writing *F* again. A missing or unreadable `os-floor` after provisioning (TPM clear, interrupted write) is a recovery and re-enrolment condition, never silently reconstructed: the recovery environment defines the index again and initialises it with the floor of the signed release statement of the release being re-enrolled, and reports that hardware floor history was lost.

| Persistent handle | Hierarchy | Object | Registered owner |
|---|---|---|---|
| `0x81000001` | owner | SRK (ECC P-256, TCG standard template); its public key is pinned at enrolment | hearth (installer at genesis) |
| `0x81000101` | owner | Owner Secure Boot KEK signer (RSA-2048). Policy: with one owner, `PolicySecret(seal-gate/0)`; with two or more, `PolicyOR` over `PolicySecret(seal-gate/i)` of the enrolled owners (`PolicyOR` needs ≥ 2 branches). Adding or removing an owner re-creates both signers and re-enrols them in firmware (documented ceremony) | hearth (installer at genesis) |
| `0x81000102` | owner | Owner Secure Boot db signer (RSA-2048); same policy | hearth (installer at genesis) |
| `0x81000103` | owner | First-boot vault seed key: ECC P-256 decrypt key for HPKE DHKEM(P-256, HKDF-SHA256) (§4), sealed to the boot policy; evicted at first boot (`HearthTpm.evict`) | vault (`evict` only) |
| `0x81000105` | owner | Recovery auth object; authValue = HKDF-SHA256(recovery key, "keylos-recovery-auth/1") | hearth (installer at genesis) |
| `0x81000110` | owner | strata anchor HMAC key; policy `PolicyPCR(15) ∧ PolicyNV(0x01300107 ≥ 1)` | strata |
| `0x81000120` | owner | fleet device key (fleet-enrolled machines) | fleet |
| `0x81000140 + i` | owner | owner-seal/i (ECDSA P-256 signing; `userWithAuth` clear; policy `PolicySecret(0x01300140 + i)`) | hearth (installer at genesis) |
| `0x81010002` | endorsement | AK: restricted signing ECC P-256; runtime attestation (vouch, fleet, cluster join) | hearth (installer at genesis) |
| `0x81010003` | endorsement | AK0: restricted signing ECC P-256; pre-unlock VBU quotes (§20.5) | hearth (installer at genesis) |
| `0x81000180`–`0x81000183` | owner | Reserved staging handles for re-creating the owner Secure Boot KEK/db signers (`0x81000101`/`0x81000102`) when the owner set changes; empty outside that ceremony | hearth (installer at genesis) |

Only the registered owner of a handle may call `HearthTpm.recreateKey` (or, for `0x81000103`, `evict`) for it.

**AK and AK0 attributes:** `fixedTPM`, `fixedParent`, `sensitiveDataOrigin`, `userWithAuth`, `restricted`, `sign` set; `adminWithPolicy` clear; empty authValue; empty authPolicy (credential activation with the EK requires the admin role through the empty authValue). Quotes carry the PCR values; no PCR binding of the key is needed.

PCR usage (normative for boot, courier, vouch, fleet, cri):

| PCR | Content |
|---|---|
| 0–7 | Firmware, option ROMs, Secure Boot state (pcrlock policy, NV `0x01300103`) |
| 11 | UKI sections and boot phases; signed PCR11 policy |
| 12 | Kernel command line and credentials |
| 13 | System extensions (none in keylos; MUST be the "no extension" value; `kmod` generations are not system extensions) |
| 14 | shim/MOK state (shim fallback mode only) |
| 15 | Volume identity (LUKS volume key hash), extended by the initrd after unlock |

**PCR11 phases, in order** (each extended exactly once per boot by the named component):

| Phase | Extended by | When |
|---|---|---|
| `enter-initrd` | boot (`kl-initrd`, its first action) | before any other initrd step. systemd-stub measures the UKI sections into PCR11 but extends no phase string |
| `leave-initrd` | boot | after unlock, PCR15 extension, trust-set write and kl-exec load; immediately before `switch_root`. The disk-unseal policy is bound to `enter-initrd`, so the disk key is unavailable afterwards |
| `sysinit` | warden | after mounting `/var`, `/home`, `/store`, `/keystore` and taking over the kl-exec maps |
| `ready` | warden | immediately **before** starting the first tier-0 service (ledger and journal included). Secrets sealed to `ready` (service keys, NV authValues, hearth's hierarchy auth) are therefore available to tier-0 services and to nothing launched before this point |
| `enter-recovery` | boot | instead of `leave-initrd`, in the recovery profile; nothing sealed to `ready` is available afterwards |

No component extends PCR11 after `ready`.


### A.23 protocols §20.1–§20.3, §20.9 — Boot trust set, presence purposes, owner registry, owner exceptions

> Verbatim copy of `protocols/spec.md` lines 4126–4158, 4160–4179, 4181–4213, 4316–4329 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 20.1 Boot trust set and boot report

`/run/keylos/boot/trust.json` (mode 0444, JCS), written by `boot` before `switch_root`:

```json
{"schema":"keylos.boottrust/1","stream":"stable","seq":4211,
 "osGen":"gen:fsv256:…","configGen":"gen:fsv256:…","safeConfig":false,
 "keys":{
   "releaseStream":["key:sha256:…"],
   "ownerPresence":["key:sha256:…"],
   "ownerSeal":["key:sha256:…"],
   "publishers":["key:sha256:…"]},
 "spki":{"key:sha256:…":"<base64 DER>"},
 "revocationsSerial":1234,
 "bootstrapGens":{"journal":"gen:fsv256:…","ledger":"gen:fsv256:…","depot":"gen:fsv256:…"},
 "featureLevel":"KL2"}
```

- `releaseStream`: keys from the UKI (subscribed streams).
- `ownerPresence`: from the owner registry anchored in NV `0x01300105`.
- `ownerSeal`: from `/etc/keylos/owner-seal/*.spki` in the verified config generation.
- `publishers`: from `/etc/keylos/publishers.json` in the verified config generation. Adding a publisher therefore takes effect at the next boot.
- `bootstrapGens`: from `/etc/keylos/services.json`; `warden` mounts them itself before `depot` runs.

`/run/keylos/boot/report.json` (also passed to `warden` as fd 8; fds 3–7 are the kl-exec maps, §9.3):

```json
{"schema":"keylos.bootreport/1","timingsMs":{"initrd":412,"vbu":0,"pin":2910,"unseal":180,"mount":95},
 "vbu":"verified|skipped|not-enrolled","pcr11Phase":"leave-initrd","profile":"default",
 "unlock":"tpm2+pin|recovery","volumeIdentity":"ok","configCounter":57,"floor":4200,
 "secureBoot":"owner|shim|off","safeConfig":false,"integrity":"full",
 "dmaProtection":"firmware-declared|none","iommu":"active|none-virtual|none"}
```

### 20.2 Presence purposes

| `purpose` | Payload `schema` | UV required |
|---|---|---|
| `mandate` | `keylos.mandate/1` | per policy (default true) |
| `config.apply` | `keylos.configgen/1` | true |
| `seal.window` | `keylos.seal-window/1` | true |
| `owners.entry` | `keylos.owners-entry/1` | true |
| `grant.persist` | `keylos.mandate/1` | per policy |
| `exception` | `keylos.exception/1` | true |
| `debug.grant` | `keylos.mandate/1` | true |
| `ledger.reset-writer:<svc>`, `ledger.ack-alarm`, `ledger.shred`, `vault.<op>`, `update.<op>`, `boot.<op>` (including `boot.sb-sign`), `trustee.split`, `loom.<op>` (including `loom.rollback-accept`, §20.25), `gate.<op>` (including `gate.rollback-accept`), `broker.<op>` (including `broker.workflow-rollback-accept`) | `keylos.presence/1` | true |

`boot.wipe` details: `{"command": <the keylos.fleet.command/1 object>, "commandDigest": "sha256:<digest of its JCS bytes>"}`. HPKE `info` for recovery copies (§4) is `keylos-recovery-copy/1:<object>` with `<object>` ∈ {`hierarchy-owner`, `vault-slot:<username>`}.

Generic payload:

```json
{"schema":"keylos.presence/1","purpose":"ledger.reset-writer:gate","requestedBy":"<principal>","details":{},"nonce":"<base64 16 bytes>","time":"…"}
```

### 20.3 Owner registry

`/var/lib/keylos/hearth/owners.log`: JSON Lines; each line is a DSSE envelope of `keylos.owners-entry/1`, presence-signed:

```json
{"schema":"keylos.owners-entry/1","seq":3,"prev":"sha256:<digest of previous envelope line bytes>","time":"…",
 "op":"enroll-credential","owner":"alice","ownerIndex":0,
 "credential":{"keyid":"key:sha256:…","cose":"<base64>","credentialId":"<base64>","label":"Spare key","aaguid":"…",
               "assisted":false,"seal":true},
 "sealKey":"<base64 SPKI DER of owner-seal/<ownerIndex>, on add-owner and genesis>",
 "secureBootCert":null,
 "policy":{"mode":"touch","quorum":1,"threshold":1}}
```

| `op` | Meaning | Signed by |
|---|---|---|
| `genesis` | First entry (installer): first owner, credentials, `recoverySigner` (Ed25519 key derived from the recovery key) | the new credentials |
| `add-owner`, `remove-owner` | Owner set changes | `policy.quorum` existing owners |
| `enroll-credential`, `remove-credential` | Credential changes | an existing credential of the same owner (or quorum) |
| `set-secureboot-certs` | Owner Secure Boot certificate set | quorum |
| `set-quorum` | Change `policy` (`mode` `touch`/`quorum`, `quorum` for owner-set changes, `threshold` for quorum presence) | the current `policy.quorum` owners |
| `recover` | Re-anchor after recovery | `recoverySigner` |

Fields:
- `ownerIndex` (0–15) selects the owner's seal gate `0x01300140 + ownerIndex` and owner-seal key `0x81000140 + ownerIndex`; assigned at `genesis`/`add-owner` and never reused while the owner exists.
- `sealKey`: SPKI of the owner's owner-seal key; `config` copies it to `/etc/keylos/owner-seal/<ownerIndex>.spki`.
- `credential.seal: true` marks the credential whose `hmac-secret` drives the owner's seal gate (`sealCredential`); exactly one per owner on `touch` machines.
- `credential.assisted: true` marks an assisted platform authenticator (§5.3).
- `policy.mode = "quorum"` switches the machine to quorum presence (§5.4) with `policy.threshold` distinct owners.
- `recoverySigner` (genesis and `recover` entries): `{"keyid": "key:sha256:…", "spki": "<base64 SPKI DER of the Ed25519 key>"}`.
- `HearthAdmin.setQuorumPolicy` appends a `set-quorum` entry; `policy.quorum` is a single number used for both adding and removing owners.

The NV head (`0x01300105`) is updated after every append. Verifiers replay the log from genesis and require the computed head to equal the NV value. `keylos.owners/1` is the export form: `{"schema", "entries": [<envelopes>], "head", "seq"}`.

### 20.9 Owner exception (`keylos.exception/1`)

Presence-signed (purpose `exception`):

```json
{"schema":"keylos.exception/1","kind":"reproducibility","name":"org.example.Tool","publisher":"key:sha256:…",
 "generation":null,"reason":"vendor binary","scope":"machine","decidedBy":"alice","time":"…","expires":null}
```

`kind`:
- `reproducibility`: allows effective tier 1 for a non-reproducible or `unreviewed` generation. `generation` null matches all generations of `name` from `publisher`.
- `fleet-receipt-access`: `{"events": ["<event type>", …]}` in an extra field `events`; lets `fleet` read sealed payloads of those events (§13.4). `name`/`publisher` are null.

Exceptions are written by `config` to `/etc/keylos/exceptions/` (§10.7); `depot` and `ledger` read them from the booted config generation.


### A.24 protocols §20.13 — First-boot bundle

> Verbatim copy of `protocols/spec.md` lines 4369–4410 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 20.13 First-boot bundle (`keylos.firstboot/1`)

Written by `installer` to `/var/lib/keylos/firstboot/bundle.json` (mode 0600, inside the encrypted disk); its SHA-256 is in the first config generation (`firstbootBundleDigest`). Each consumer deletes its part; `warden` removes the file when all have reported done.

```json
{
  "schema": "keylos.firstboot/1",
  "machine": {"name": "laptop-ada", "machineKey": "key:sha256:…", "srkPublic": "<base64>", "ekCertChain": ["<base64 DER>"]},
  "profile": "laptop", "integrity": "full",
  "storage": {"luks": {"cipher": "aegis128-random", "sectorSize": 4096, "uuid": "…"}, "btrfs": {"uuid": "…"}},
  "secureBoot": {"mode": "owner", "keepMicrosoftCAs": false, "optionRomHashes": ["sha256:…"]},
  "tpm": {"registry": "keylos-tpm-registry/1.0", "pcrlockCoveredPcrs": [0, 2, 4, 7]},
  "owner": {"name": "ada", "displayName": "Ada", "uid": 1000, "login": "password+fido2",
            "passwordHash": "$argon2id$v=19$m=262144,t=3,p=4$…",
            "fido2": [{"label": "blue key", "credentialId": "<base64>", "publicKey": "<base64 SPKI>", "alg": "ES256",
                       "aaguid": "…", "keyRef": "key:sha256:…"}],
            "sealGate": {"index": "0x01300140", "saltCounter": 1}},
  "vault": {"items": [{"name": "wifi/home", "kind": "wifi-psk", "value": "<base64, encrypted to 0x81000103>"}]},
  "vouch": {"paired": true, "phoneWitnessKey": "key:sha256:…", "phoneApprovalKey": "key:sha256:…"},
  "recovery": {"recipient": "<base64 32-byte X25519 public key>"},
  "owners": null,
  "config": null,
  "fleet": null,
  "imports": [{"source": "ext4:UUID=…", "path": "/home/ada/Imported/old-laptop", "label": "private/untrusted", "files": 18234}],
  "installer": {"version": "1.0.0", "media": "gen:fsv256:…", "journal": "sha256:…"}
}
```

| Consumer | Part |
|---|---|
| hearth | `owner`, `machine.name`, `recovery.recipient`, `owners` (cloud seed) |
| vault | `vault`, `machine.machineKey`, `recovery.recipient` |
| ledger | `machine`, `installer.journal` (genesis receipts) |
| courier | `secureBoot`, `tpm.pcrlockCoveredPcrs` |
| config | digest check; `config` (cloud seed) |
| strata | `storage`, `imports` |
| vouch | `vouch` |
| fleet | `fleet` |

All TPM handles are those of §19.6; the bundle names the registry version instead of listing handles.

**Cloud seed.** On the `cloud` profile there is no interactive installer. The image boots a first-boot stage that fetches a DSSE-wrapped `keylos.firstboot/1` from the provider metadata service (path `keylos/firstboot` under the instance user-data or metadata attributes), verifies it against the fleet key pinned in the image's config (`fleet.seedKeys`), and refuses to continue on failure. Unsigned user-data is ignored entirely. Owners on cloud machines are fleet admins enrolled with quorum presence (§5.4). A seed bundle carries `owners` (the presigned owner-registry lines, genesis first, as JSON strings) and `config` (`{"statement": "<base64 presence/quorum-signed keylos.configgen/1 envelope>", "source": "oci://…#gen=fsv256:…"}`) instead of the interactive `owner` part; the seed stage runs in the UKI's `seed` profile (§20.6).


### A.25 protocols §5.4, §20.18 — Quorum presence and quorum requests

> Verbatim copy of `protocols/spec.md` lines 319–326, 4476–4489 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 5.4 Quorum presence

Headless profiles (`server`, `server-k8s`, `cloud`, `appliance`) and managed machines use **quorum presence** instead of a local touch. The owner registry (§20.3) then has `policy.mode = "quorum"` and `policy.threshold = N`, with M approver credentials (the owners' FIDO2 credentials, enrolled like any owner credential).

- A **quorum presence envelope** is an ordinary DSSE envelope over the same payload with **≥ N signatures** (§5.3 construction) from credentials of **distinct owners**. Verifiers MUST count distinct owners, not signatures.
- Collection: `hearth` creates a quorum request (`keylos.quorum/1`, §20.18) through `HearthQuorum.request` (§7.5.3); approvers receive it through `fleet` (or out of band as a file), review the rendered payload on their own keylos machine, and sign it there with `hearth presence --remote <request>` (their machine's `hearth` signs with their own credential and rpId `keylos.owner`); signatures return through `HearthQuorum.submit`. The request expires after at most 24 h.
- Every purpose of §20.2 accepts a quorum envelope on quorum machines. On `desktop`/`laptop` profiles quorum envelopes are accepted only for owner-registry changes that the registry policy marks `quorum`.
- **Seal gate on quorum machines.** No touch reaches the machine, so the seal gate's authValue for the window is released differently: `hearth` holds the next gate authValue in a TPM-sealed blob bound to the signed PCR11 `ready` phase and PCR15, and unseals it only after verifying a quorum envelope of purpose `seal.window`. This reduces the guarantee from "a physical touch" to "N approvers signed and the machine runs a verified `hearth`"; the reduction is shown in `status` (`sealing: quorum`).

### 20.18 Quorum request (`keylos.quorum/1`)

DSSE-signed by `service/hearth`; `keyChain` carries the `ledger.key.register` receipt for `hearth` (countersigned by the ledger with the machine key, §3.5), so a remote approver who knows the machine key verifies the hearth key without access to this machine's ledger:

```json
{"schema":"keylos.quorum/1","id":"q-…","machine":"key:sha256:…","purpose":"config.apply",
 "payloadType":"application/vnd.keylos.configgen+json; version=1","payload":"<base64 JCS payload>",
 "payloadDigest":"sha256:<digest of the DSSE PAE>","rendering":[{"title":"…","body":"…","mime":"text/x-diff"}],
 "threshold":2,"approvers":["key:sha256:…","key:sha256:…","key:sha256:…"],
 "created":"…","expires":"…","keyChain":"<base64 DSSE ledger.key.register receipt>"}
```

- Approvers verify the key chain and the hearth signature, review `rendering` and sign the **payload's** PAE (not the request) with §5.3; the resulting quorum envelope is the payload with ≥ `threshold` signatures by distinct owners.
- `expires − created ≤ 24 h`. `approvers` lists the credentials allowed by the owner registry at `created`.


### A.26 protocols §20.16, §20.17, §20.20 — Service table, policy reference, publishers

> Verbatim copy of `protocols/spec.md` lines 4445–4470, 4472–4474, 4504–4516 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 20.16 Service table (`keylos.services/1`)

`/etc/keylos/services.json` (JCS), rendered by `config`, read by `warden`, `boot` and `ledger`:

```json
{"schema":"keylos.services/1",
 "bootstrapGens":{"journal":"gen:fsv256:…","ledger":"gen:fsv256:…","depot":"gen:fsv256:…"},
 "services":{
   "strata":{"generation":"gen:fsv256:…","entrypoint":"main","tier":0,"perHuman":false,
             "uid":"dynamic","network":"none","writer":true,
             "privileges":{"capabilities":["CAP_SYS_ADMIN"],"paths":[{"path":"/snapshots","access":"rw"}],
                           "devices":[],"tpm":false},
             "bpf":["/usr/lib/keylos/bpf/strata/provenance.o"],
             "routes":[{"to":"vault","facet":"strata"},{"to":"warden","facet":"strata"}],
             "readiness":{"timeoutSecs":30},"watchdogSecs":10,"restart":"on-failure"},
   "portal-files":{"generation":"gen:fsv256:…","perHuman":true,
             "privileges":{"paths":[{"path":"/home/{human}","access":"rw"}]}, "…":"…"}
 }}
```

- `bootstrapGens` are mounted by `warden` before `depot` runs (§20.1).
- `writer: true` registers the service's key as a ledger writer (`ledger` reads this field).
- `privileges.paths` MAY use the placeholder `{human}` for per-human services; `warden` substitutes it per instance. Each entry's `access` is `ro` or `rw`.
- `bpf`: BPF objects `warden` loads for the service (§9.3); only paths under `/usr/lib/keylos/bpf/<service>/`.
- `network`: `"none"` (private netns with `lo`), `"gate"` (egress via gate only), `"host"` (host netns; listed services only: `net`, `gate`), `"cluster"` (the cri network namespace from `NetPlumbingCluster.clusterNetns`; `server-k8s` only: `cri`, `kubelet`, `kube-proxy`).
- Fields not listed here are `warden`-local and MUST be prefixed `x-`.

### 20.17 Policy reference (`keylos.policyref/1`)

`/etc/keylos/policy.ref` (JCS): `{"schema":"keylos.policyref/1","generation":"gen:fsv256:…","digest":"sha256:<JCS digest of the policy generation's manifest>"}`. `warden` mounts that `policy` generation read-only at `/policy` in `broker`'s view; `broker` refuses to start if the mounted generation's manifest digest differs. `BrokerSystem.loadPolicy` switches policy at runtime only to the generation named by the newly activated config generation's `policy.ref`.

### 20.20 Publishers and catalog

`/etc/keylos/publishers.json` (`keylos.publishers/1`, rendered by `config`): `{"schema", "publishers": [{"id": "…", "keys": ["key:sha256:…"], "sigstore": [{"issuer": "…", "subject": "…"}], "spki": {"key:sha256:…": "<base64 DER>"}, "scope": "distro" | "org:<org>"}]}`.

`keylos.catalog/1` (TUF target signed by the `catalog` role):

```json
{"schema":"keylos.catalog/1","issued":"…","expires":"…",
 "entries":[{"name":"org.example.Editor","publisher":"example","summary":"…","categories":["development"],
             "latest":{"version":"2.5.0","generation":"gen:fsv256:…","statement":"sha256:<genstmt envelope digest>"},
             "review":"reviewed-reproducible" | "unreviewed","quorum":"3/3","capabilities":"sha256:<JCS digest>",
             "icons":["https://…"],"homepage":"https://…"}]}
```


### A.27 protocols §2.2, §2.3 — Profiles and resource classes

> Verbatim copy of `protocols/spec.md` lines 74–94, 96–106 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 2.2 Profiles and integrity profiles

A machine runs exactly one **profile** (chosen at install, recorded in the first-boot bundle and the boot report) and has exactly one **integrity profile** (derived at every boot, shown in status, in the boot report and in the `vouch` verdict).

| Profile | Use | Notes |
|---|---|---|
| `desktop`, `laptop` | Interactive machines | atrium, portals, presence by touch |
| `server` | Headless | No atrium; presence by **quorum** (§5.4); serial-console recovery with the recovery key |
| `server-k8s` | Kubernetes node | `server` + `cri`, `kubelet`, `kube-proxy` (§21) |
| `cloud` | VM image in a public or private cloud | vTPM (provider EK chains in the attestation trust store); confidential VMs (SEV-SNP, TDX) supported, SVSM vTPM preferred; first-boot bundle from the metadata service (§20.13); quorum presence |
| `kiosk` | Single-app appliance | Autologin to one app principal; atrium kiosk mode; trusted path still present for owners |
| `appliance` | Fixed-function device | As `server`, without `bench` |

| Integrity profile | Condition |
|---|---|
| `full` | Owner-controlled Secure Boot keys (no Microsoft CAs in db), TPM 2.0, IOMMU, every check passes |
| `shared-boot` | `secureboot.keepMicrosoftCAs = true` (dual boot): the Microsoft Windows and third-party UEFI CAs are in db. Bitpixie-class downgrade risk is mitigated by TPM+PIN, the signed PCR11 policy and the NV release floor, and is documented |
| `shim` | Booted through shim + MOK (no custom-key Secure Boot available) |
| `cloud-vtpm` | `cloud` profile with a provider vTPM and no confidential-VM report |
| `cvm` | `cloud` profile in a confidential VM whose report is verified together with the TPM quote |
| `degraded` | No TPM, or Secure Boot off; no sealing, no VBU, persistent warning |

### 2.3 Resource classes

`bench` admission control and memory tuning follow the machine's **RAM class** (detected at boot, overridable in config):

| RAM | Class | Max concurrent VMs (workbench, agent, tier-2, media, pod) | Defaults |
|---|---|---|---|
| < 12 GiB | `small` | 2 | zram swap (ephemeral key), KSM on, compressed snapshots, agents queue |
| 12–24 GiB | `medium` | 6 | KSM on, free-page reporting |
| > 24 GiB | `large` | 16 | free-page reporting |

`server-k8s` nodes are exempt from the VM cap for pod VMs; kubelet `maxPods` bounds them instead. When the cap is reached, new agent sessions queue (`aide`), and other VM requests fail with `kl:unavailable`.


### A.28 protocols §20.23 — Fleet commands and org approvers (rendered: approvers.json)

> Verbatim copy of `protocols/spec.md` lines 4539–4556 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 20.23 Fleet commands (`keylos.fleet.command/1`) and org approvers (`keylos.fleetapprovers/1`)

`/etc/keylos/fleet/approvers.json` (rendered by `config` from the fleet module; read by `hearth`, `rescue` and `broker`):

```json
{"schema":"keylos.fleetapprovers/1","org":"example-corp","commandQuorum":2,
 "approvers":[{"id":"ops-1","keyid":"key:sha256:…","spki":"<base64 DER>","alg":"fido2-es256"}]}
```

A fleet command is a DSSE envelope signed by at least `commandQuorum` distinct org approvers (§5.3 construction for FIDO2 approver keys, rpId `keylos.owner` of the approver's own machine):

```json
{"schema":"keylos.fleet.command/1","id":"fc-…","org":"example-corp","machine":"key:sha256:<machine key>",
 "command":"lock" | "wipe" | "unlock-org" | "unenrol","reason":"…","issued":"…","expires":"…","nonce":"<base64 16 bytes>"}
```

- `machine` MUST equal the receiving machine key; `expires − issued ≤ 24 h`; each `id` is accepted once (`hearth` keeps the ids of the last 30 days).
- `lock`: executed at once by `HearthFleet.lockAll`. `wipe`: locks at once; completed only at the next recovery entry after `rescue` also verifies an owner quorum envelope (§14.5). `unlock-org`: lifts an org lock (owner unlock still required). `unenrol`: starts unenrolment; effective only after an owner-signed config apply removes the fleet module.
