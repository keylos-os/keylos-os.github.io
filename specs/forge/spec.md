# keylos/forge — hermetic builder, source rules and rebuilders

| | |
|---|---|
| Repository | `github.com/keylos-os/forge` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `forged` (tier-0 build coordinator service), `forge` (CLI), `forge-eval` and `forge-parse` (unprivileged subprocesses), `forge-guest` (PID 1 helper inside build VMs), `forge-rebuilder` (daemon for rebuilder operators), `forge-sign` (release and org-publisher signing tool for HSM hosts); crates `keylos-recipe` (Nickel recipe evaluation), `keylos-drv` (derivation computation), `keylos-lockxlate` (lockfile translators), `keylos-canon` (canonical tar and output canonicalisation); Nickel library `forge/lib.ncl`; guest sources for the `io.keylos.build-vm` and `io.keylos.bootstrap-vm` bench images |
| Depends on | `keylos-protocols 1.0`; `keylos-tlog-client 1.0` (from `github.com/keylos-os/tlog`); `keylos-oci-convert 1.0` (from `github.com/keylos-os/depot`, the `oci-convert/1` algorithm embedded in §4.18); services at runtime: `depot`, `bench`, `gate`, `hearth` (`HearthSeal`), `journal` |
| Provides | The recipe language (Nickel contracts); the derivation profile of `keylos.drv/1`; the build sandbox `keylos-build/1`; output canonicalisation rules; lockfile translators; `kmod` generation builds; publisher-side `container` conversion and statement signing; realisation attestations; the bootstrap and diverse double-compiling procedures; the forge-local `Forge` interface |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`forge` turns **recipes** plus **pinned sources** into **generations**, reproducibly and hermetically. It:

1. evaluates Nickel recipes into **derivations** (`drv:sha256:…`, protocols §11.1);
2. fetches sources under the **source rules** (git trees, tarball-vs-git diffs, regenerated build files, quarantined blobs, test isolation);
3. builds each derivation in a disposable **build VM** with no network, a fixed clock, a masked CPU model, and separate **build** and **check** VMs;
4. **canonicalises** outputs into trees and imports them into `depot` as `part` generations (`importTree`);
5. **composes** parts into launchable generations (`app` including installable web apps, `runtime`, `os`, `service`, `agent-template`, `bench-image`, `data`, `kmod`) without rewriting file contents, which makes **early cutoff** and **emergency grafts** cheap;
6. translates language lockfiles into fixed-output fetches so every ecosystem shares one store;
7. on user machines, **seals** builds inside an owner-presence sealing window (`forge seal`);
8. on rebuilder infrastructure, **rebuilds release candidates** and publishes **realisation attestations** to the realisation log;
9. defines and runs the **full-source bootstrap** and the **diverse double-compiling** check for toolchains;
10. produces detached release signatures (`forge-sign`) over verified reproducible inputs, including release-signed out-of-tree kernel modules;
11. for organisation publishers, computes the **`container` generation** of an OCI image with exactly the conversion `depot` performs on every node, and signs its generation statement (`forge container convert`, `forge-sign statement --org`).

### 1.1 Non-goals

- Choosing packages and versions (`pkgs`).
- Storing generations, launchability, installation (`depot`).
- Operating transparency logs (`tlog`) or TUF repositories (`keylos` release engineering).
- Executing build code on the host kernel. `forged` never runs recipe-controlled code on the host.

---

## 2. Context and embedded contracts

```
                 ┌───────────────────── host (tier 0) ──────────────────────┐
forge CLI ──────►│ forged ─ forge-eval (pure Nickel)                        │
 (forge#user)    │   │                                                      │
                 │   ├─ gate.connect ─► source hosts, registries            │
                 │   ├─ depot.importTree ─► part / compose / build-image    │
                 │   ├─ bench.start(purpose build, storeSet) ─► build VM   │
                 │   │                  forge-guest runs phases              │
                 │   ├─ HearthSeal.openWindow/sealSign (user machines)      │
                 │   └─ depot.seal                                          │
                 └──────────────────────────────────────────────────────────┘
rebuilder server: forge-rebuilder ─► local forged ─► same build VMs ─► attestation ─► realisation log (tlog)
release host:     forge-sign ─► detached signatures (PE, modules, generation statements)
org publisher:    forge container convert ─► generation digest ─► forge-sign statement --org ─► org TUF repo (fleet)
```

### 2.1 Embedded contracts

Every block below is copied verbatim from `keylos/protocols` 1.0.0 (final). If an embedded copy differs from protocols, protocols wins.

#### protocols §3.2 Typed references

```
ref         = kind ":" digest
kind        = "obj" / "gen" / "src" / "drv" / "rcpt" / "key"
```

| Kind | Meaning | Digest algo |
|---|---|---|
| `obj` | A store object (a regular file in the store) | `fsv256` |
| `gen` | A generation: an EROFS composefs metadata image | `fsv256` |
| `src` | A source input (git tree or archive) | `sha256` of the **canonical tar stream** defined in §11.2 (for git trees and for archives after normalisation) |
| `drv` | A build derivation (recipe + resolved inputs) | `sha256` of the canonical JSON derivation |
| `rcpt` | A ledger receipt | `sha256` of the DSSE envelope bytes |
| `key` | A public key | `sha256` of the SubjectPublicKeyInfo DER |

Example: `gen:fsv256:3f9a…c01e` (64 hex characters).

#### protocols §5.1 Envelope

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

#### protocols §5.2 Trust roots

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

#### protocols §6.1 Generation kinds

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

#### protocols §6.2 Layout

A generation is an EROFS image in composefs format:
- Every **non-empty** regular file is an overlay metacopy whose redirect names a store object, with the fs-verity digest of that object in `trusted.overlay.metacopy`.
- Zero-length regular files are stored inline in the EROFS image with no redirect.

The image root MUST contain `/.keylos/manifest.json`. It MAY contain:
- `/.keylos/cmdsig/<command>.json` (command signatures, §12)
- `/.keylos/sbom.spdx.json` (SPDX 2.3 or 3.0 JSON)
- `/.keylos/provenance.json` (the realisation attestations bundle, §11.3)
- `/.keylos/agent/` (agent templates only, §6.4)
- `/.keylos/l10n/<lang>.json` (localised strings, §6.3)

#### protocols §6.3 Manifest schema (`keylos.manifest/1`)

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

#### protocols §6.4 Agent templates

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

#### protocols §7.3.8 `depot.capnp` (consumed)

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

#### protocols §7.3.13 `bench.capnp` (consumed)

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

#### protocols §9.3 Code integrity (host) (consumed: `kmod` and service BPF rules)

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

#### protocols §7.5.3 `hearth-sys.capnp` (consumed: `HearthSeal`)

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

#### protocols §7.4 Versioning

- Schemas evolve only by Cap'n Proto-compatible additions: new fields, new methods, new enumerants.
- Removal or renumbering needs a new file ID and a protocols major version.
- Every bootstrap capability implements `common.Extensible`; `version()` returns `(protocols, implementation)` version strings.
- Repo-local schemas (used only by a repository's own binaries) MUST use file IDs generated with `capnp id` outside the `0xc7a1e5d3b2f4xxxx` range reserved for this repository.

#### protocols §11.1 Recipes and derivations

Defined in full by `forge`. The cross-repo contract is the **derivation** JSON (`keylos.drv/1`), which `depot`, `tlog` and rebuilders consume:

```json
{"schema":"keylos.drv/1","name":"zlib","version":"1.3.1","system":"x86_64-linux",
 "inputs":{"src":"src:sha256:…","deps":{"stdenv":"gen:fsv256:…"},"vendor":{"cargo":"src:sha256:…"}},
 "builder":"gen:fsv256:…","args":["build"],"env":{"SOURCE_DATE_EPOCH":"1700000000"},
 "outputs":["out","dev"],"sandbox":"keylos-build/1","phases":["build","check"],
 "checkSeparate":true}
```

- The `drv:` ref is SHA-256 over the JCS bytes.
- Outputs are generations (`gen:`). Their identity is content-addressed.
- `inputs.vendor` maps an ecosystem to a fixed-output source produced by a lockfile translation.
- Fields prefixed `x-` are forge-local and MUST be included in the hash.
- **Emergency grafts.** A graft is a derivation whose builder rewrites references of an existing output to a replacement of identical length and ABI. Its outputs carry `grafted: true` in their manifests and MUST be superseded by a real rebuild; `depot` lists grafted generations in `status` until then.

#### protocols §11.2 Source references

- **Canonical tar stream:** POSIX ustar, entries sorted by path bytes, mtime 0, uid/gid 0, uname/gname empty, mode 0644 for regular files and 0755 for executables and directories, symlinks preserved, no other file types.
- Git sources are pinned by the commit's tree, expressed as `src:sha256:<SHA-256 of the canonical tar stream of the tree>`. The tag and commit are recorded as metadata.
- Archive sources record `src:sha256:` of the canonical tar stream of the unpacked archive, plus a **tarball-vs-git diff** record: a list of paths that differ and a justification. An unexplained difference fails the build (`forge`).

#### protocols §11.3 Generation provenance

An in-toto Statement v1 bundle containing:
- SLSA Provenance v1 (buildType `https://keylos.org/forge/v1`),
- one realisation attestation per rebuilder (§11.4), and
- one `keylos.tlogproof/1` inclusion proof per attestation (§20.14).

#### protocols §11.4 Realisation attestation

An in-toto Statement v1 with:
- `subject` = the output generation: `name` = `<name>-<version>.<output>`, `digest: {"fsv256": hex}`;
- `predicateType` = `https://keylos.org/realisation/v1`;
- predicate = `{"drv": "drv:sha256:…", "output": "out", "builder": "<operator id>", "buildHost": {"arch":…, "kernel":…, "forgeVersion":…}, "started":…, "finished":…}`.

It is signed by `rebuilder/<operator>` and logged in the **realisation log** (§11.5).

#### protocols §11.5 Transparency logs

keylos operates two logs, both following **C2SP tlog-tiles** with checkpoints per **C2SP tlog-checkpoint** and witness cosignatures per **C2SP tlog-cosignature**:

| Log | Origin line | Entries |
|---|---|---|
| Realisation log | `log.keylos.org/realisations` | DSSE realisation attestations (§11.4) |
| Release log | `log.keylos.org/releases` | DSSE release statements (`keylos.release/1`, §20.6) and cloud image records (`keylos.cloudimage/1`, §20.24), signed by `release-stream/<stream>` |

Clients MUST verify inclusion against a checkpoint cosigned by at least `witnessThreshold` (default **2**) witnesses from the witness list in TUF targets metadata (`rebuilders.json`: `witnesses`, `witnessThreshold`). A generation is installable from a distro or publisher channel only if its realisation log entries reach the rebuilder quorum named in its release or app-release statement.

#### protocols §11.6 Owner seal

A **seal statement** (`keylos.seal/1`):

```json
{"schema":"keylos.seal/1","generation":"gen:fsv256:…","drv":"drv:sha256:…",
 "sourceTree":"src:sha256:…","sealedAt":"…","machine":"key:sha256:<machine key>",
 "window":"w-…","windowDigest":"sha256:<digest of the presence-signed seal-window envelope>"}
```

**Owner-seal keys** (one per owner *i*, §19.6):
- A TPM-resident, non-duplicable ECDSA P-256 signing key under the owner hierarchy at handle `0x81000140 + i`, with `userWithAuth` cleared and policy `PolicySecret(NV seal gate 0x01300140 + i)`.
- The seal gate's auth value is rotated by `hearth` every sealing window through a FIDO2 `hmac-secret` chain: one assertion with two salts yields the current auth `o_k` and the next auth `o_{k+1}`; at window close `hearth` performs `TPM2_NV_ChangeAuth(gate, o_{k+1})` and zeroizes both. The full algorithm is in the `hearth` spec; it MUST satisfy: (a) no seal signature without a fresh touch-authorized window, (b) a captured auth value is useless after the window closes.
- **Sealing window:** one presence assertion authorizes a window of at most 600 s, limited to one project directory and a list of `drv`s (`keylos.seal-window/1`, §20.4). Seal statements are signed only through `HearthSeal.sealSign` (§7.5.3).
- The owner-seal public keys are part of the **boot trust set** (§20.1); the config generation carries them in `/etc/keylos/owner-seal/<i>.spki`.
- The `seal.window` receipt (hearth) carries `windowDigest`, so relying parties that never see the presence-signed window (depot) can check a seal statement's `windowDigest` against the ledger.

#### protocols §12 Command signatures (`keylos.cmdsig/1`)

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

### 12.1 Argument fd passing

For each `file` or `dir` argument, the shell passes an fd and replaces the argument text with `/dev/fd/<n>`. It also sets `KEYLOS_ARGFD_<argname>=<n>[,<n>…]`.

Native programs SHOULD use the fd environment variables. Legacy programs simply open `/dev/fd/<n>`.

### 12.2 Pipe protocol

Pipes negotiate their format **statically**: the shell knows both ends' signatures.
- If the producer's `output.type` is `records` and the consumer's `input.type` is `records` (or `any`), the shell sets `KEYLOS_PIPE_OUT=cbor-seq` on the producer and `KEYLOS_PIPE_IN=cbor-seq` on the consumer.
- In that mode, records are an RFC 8742 CBOR sequence of maps that conform to the declared schema.
- In every other case the pipe carries bytes, and records are rendered as text by the producer's text formatter (TSV for `records` unless `--format` is given).

#### protocols §19.2 Facets (rows served by forge)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| forge | `user` | `shell` | forge-local build interface |
| forge | `release` | release-engineering principals only | forge-local graft operations |

#### protocols §19.2 Facets (rows held by forge on other services)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| hearth | `seal` | depot, forge | `HearthSeal` |
| depot | `forge` | forge | `importTree`, `seal`, `get` |
| bench | `user` | kish, `work`, atrium, portal-files, forge | `project`, `start` (purposes workbench; build (forge only, `unsignedImageOk`); app (kish, atrium launcher: non-reproducible native apps at tier 2)), `snapshots`, `media` (atrium, portal-files), `reattach` (own VMs) |
| atrium | `presence` | config, depot, courier, hearth, forge | `TrustedPrompt.presence` |

#### protocols §19.4 Media types (rows owned by forge)

| Schema | Media type | Owner (full definition) | Purpose |
|---|---|---|---|
| `keylos.logauth/1`, `keylos.candidates/1`, `keylos.mismatch/1` | (tlog/forge-internal) | tlog, forge | Log operator and rebuilder formats |

#### protocols §20.4 Seal window

```json
{"schema":"keylos.seal-window/1","owner":"alice","project":"/home/alice/Projects/tool","drvs":["drv:sha256:…"],
 "opened":"…","expires":"…","machine":"key:sha256:<machine key>","id":"w-…"}
```

`expires − opened ≤ 600 s`. A seal statement is accepted only if its `drv` is in `drvs` and its `sealedAt` lies inside the window.

#### protocols §20.7 Generation statement (`keylos.genstmt/1`)

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

#### protocols §20.20 Publishers and catalog

`/etc/keylos/publishers.json` (`keylos.publishers/1`, rendered by `config`): `{"schema", "publishers": [{"id": "…", "keys": ["key:sha256:…"], "sigstore": [{"issuer": "…", "subject": "…"}], "spki": {"key:sha256:…": "<base64 DER>"}, "scope": "distro" | "org:<org>"}]}`.

`keylos.catalog/1` (TUF target signed by the `catalog` role):

```json
{"schema":"keylos.catalog/1","issued":"…","expires":"…",
 "entries":[{"name":"org.example.Editor","publisher":"example","summary":"…","categories":["development"],
             "latest":{"version":"2.5.0","generation":"gen:fsv256:…","statement":"sha256:<genstmt envelope digest>"},
             "review":"reviewed-reproducible" | "unreviewed","quorum":"3/3","capabilities":"sha256:<JCS digest>",
             "icons":["https://…"],"homepage":"https://…"}]}
```

#### protocols §21.4 Images

- `keylos-vm`: OCI images are pulled by `cri` with digest pinning; tags are resolved once and recorded. They are never executed on the host (`noexec` store) and never registered with `kl-exec`.
- `keylos-sealed`: `cri` calls `Depot.install("oci+container://<registry>/<repo>@sha256:<manifest>")` (facet `cri`). `depot` converts the image with **`oci-convert/1`** into a `container` generation and makes it launchable only if a `keylos.genstmt/1` for that generation digest, signed by an enabled `org-publisher` key, is available from the org TUF repository (`courier`). `cri` roots the generation as `cri:pod:<pod-id>` before `PodSpawn`; `depot` mounts container generations only while so rooted.
- **`oci-convert/1`** (normative; implemented only by crate `keylos-oci-convert`, §18): layers applied in manifest order; OCI whiteouts (`.wh.<name>`) and opaque markers (`.wh..wh..opq`) resolved; hardlinks kept; device nodes, sockets and FIFOs dropped (the runtime provides `/dev`); numeric uid/gid and mode bits kept; setuid/setgid bits cleared; `security.capability` and all `security.*`/`trusted.*` xattrs dropped (no file capabilities, ever); `user.*` xattrs kept; timestamps zeroed; entries sorted by path bytes; the result is built into a composefs generation exactly as `depot` builds any generation, with `/.keylos/manifest.json` of kind `container` whose `container` section copies the OCI config.
- **Identity** of a converted generation: `name` = `oci.` + the registry host's labels reversed + `.` + the repository path segments, joined by `.`, with every character outside `[a-z0-9-]` replaced by `-`; `version` = `0.0.0+oci.<first 16 hex digits of the manifest digest>`; `derivation` (and the genstmt `drv`) = `drv:sha256:<SHA-256 of the JCS bytes of the conversion descriptor>`, where the descriptor is `{"schema":"keylos.ociconv/1","algorithm":"oci-convert/1","image":"oci:sha256:<manifest>","platform":"linux/amd64","config":"sha256:<config blob>","layers":["sha256:…"]}`. For kind `container`, `drv` names this descriptor, not a `keylos.drv/1` derivation. `layers` lists the **compressed layer blob digests exactly as they appear in the image manifest, in manifest order** (not uncompressed `diff_id`s); `platform` is the platform selected from an image index (or the manifest's config platform).

#### protocols §20.14 Transparency-log proof bundle (`keylos.tlogproof/1`)

```json
{"schema":"keylos.tlogproof/1",
 "origin":"log.keylos.org/realisations",
 "index":123456,
 "entry":"<base64 of entry bytes>",
 "checkpoint":"<full signed note text including cosignature lines>",
 "inclusion":["<base64 hash>"]}
```

Verification: verify the log signature on the checkpoint with the origin's key (TUF `logs.json`); verify ≥ `witnessThreshold` cosignatures from distinct listed witnesses; compute the RFC 6962 leaf hash of `entry` and verify inclusion at `index`; update the persisted last-seen checkpoint (consistency-checked) when online.

---

## 3. Requirements

### 3.1 Evaluation

- **REQ-FORGE-001** Recipes MUST be Nickel programs that evaluate to records satisfying the `Recipe`, `Compose` or `Fetch` contracts (§4.2). Evaluation MUST be pure: no file reads outside the recipe repository root, no environment, no network, no clock.
- **REQ-FORGE-002** Evaluation MUST be bounded: 2 GiB memory and 60 s per evaluation by default; exceeding fails with `kl:invalid`.
- **REQ-FORGE-003** The derivation JSON MUST be produced by the algorithm in §4.4; identical inputs MUST yield identical `drv:` refs on every architecture and every forge version of the same major.

### 3.2 Sources

- **REQ-FORGE-010** Git sources MUST be fetched by commit and pinned by `src:sha256:` of the canonical tar stream of the tree (protocols §11.2). A recipe naming a tag MUST also name the commit; mismatches fail.
- **REQ-FORGE-011** Archive sources MUST name the upstream git reference (repository + commit) unless the recipe sets `noGit = { reason }` and `pkgs` policy accepts it. `forge` MUST compute the tarball-vs-git diff (§4.5.2) and fail on any difference not listed in `tarballDiff` with a justification.
- **REQ-FORGE-012** Generated build-system files MUST be deleted before the build and regenerated (§4.5.3) unless `regenerate = 'none` is justified and accepted by `pkgs` policy.
- **REQ-FORGE-013** Binary blobs in the source tree (§4.5.4) MUST either be generated during the build or be listed in `blobs` with path, SHA-256, justification and reviewer; unlisted blobs fail the build.
- **REQ-FORGE-014** Paths in `testPaths` (default: `tests`, `test`, `testdata`, `t`, `spec`, `__tests__` when present at the source root) MUST NOT be visible during the `prepare`, `configure`, `build` and `install` phases.

### 3.3 Build sandbox

- **REQ-FORGE-020** Every derivation build MUST run in a fresh tier-3 build VM started through `bench.start` on its `bench#user` route with `VmSpec.purpose = build`, image = the release-signed `io.keylos.build-vm` for the recipe's `system` (or, for bootstrap stages and recipes with `buildImage`, a locally composed unsigned image with `unsignedImageOk = true`), `storeSet` = the build inputs (§4.6), **no network device**, read-only source and dependency trees, a writable output share, and a scratch disk discarded after the build.
- **REQ-FORGE-021** The guest MUST see a CPU model masked to the baseline for `system` (`x86_64-linux`: x86-64-v2; `x86_64-v3-linux`: x86-64-v3; `aarch64-linux`: ARMv8.2-A with no optional features beyond the baseline).
- **REQ-FORGE-022** The guest clock MUST start at `SOURCE_DATE_EPOCH`. Hostname `forge`, user `build` (uid 1000), umask `0022`, `LANG=C.UTF-8`, `TZ=UTC`, `HOME=/build/home`, `TMPDIR=/build/tmp`, `nproc` = recipe `parallelism` (default 8).
- **REQ-FORGE-023** When `checkSeparate` is true (default) the `check` phase MUST run in a second VM that sees the full source (including test paths) and the outputs read-only. A failing check fails the derivation unless `check.allowFailure = { reason }` is set and accepted by `pkgs` policy.
- **REQ-FORGE-024** `forged` MUST NOT execute recipe-controlled code, interpret build outputs as code, or follow symlinks inside outputs on the host.

### 3.4 Outputs

- **REQ-FORGE-030** Outputs MUST be canonicalised by the rules in §4.7 before import. Canonicalisation failures fail the build.
- **REQ-FORGE-031** Each output becomes a **`part`** generation (§4.8). Composed generations (§4.9) are unions of parts plus metadata; composition MUST NOT rewrite file contents.
- **REQ-FORGE-032** `forge` MUST perform **early cutoff**: when a rebuilt part has the same generation digest as before, derivations depending on it resolve to unchanged `drv:` refs and MUST NOT be rebuilt.
- **REQ-FORGE-033** Every composed generation MUST contain `/.keylos/provenance.json` with SLSA Provenance v1 for the local build (protocols §11.3); realisation attestations and their log proofs are added by release engineering before publishing.
- **REQ-FORGE-034** Manifests written by `forge` MUST validate against protocols §6.3. Forge-local information goes only into the `x-forge` field, which carries no authority.
- **REQ-FORGE-035** A `Compose` of kind `app` with a `webapp` section MUST name a `runtime` generation in `webapp.browserRuntime`, MUST NOT set `needs.jit`, and MUST derive `needs.network` entries for `webapp.origin` (scheme host, port 443, methods `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`) unless the recipe lists narrower ones.

### 3.5 Lockfiles

- **REQ-FORGE-040** `forge` MUST translate the lockfile formats of §4.10 into fixed-output fetches whose expected digest comes from the lockfile; entries without a content hash MUST be rejected unless the recipe pins them explicitly.
- **REQ-FORGE-041** Language tools MUST run offline inside the build VM against the vendored fetches.

### 3.6 Grafts

- **REQ-FORGE-050** `forge graft` MUST only replace a part with an ABI-compatible part (§4.12), MUST set `grafted: true` in the manifests of the resulting generations (protocols §6.3, §11.1), and MUST record the graft in `x-forge.graft` with an expiry ≤ 30 days.
- **REQ-FORGE-051** Grafts MUST be performed only on facet `release`. Rebuilders attest grafts by re-performing them deterministically from the same inputs.

### 3.7 Seals (user machines)

- **REQ-FORGE-060** `forge seal` MUST build locally in build VMs, import outputs with `depot.importTree`, open a sealing window with `HearthSeal.openWindow` covering exactly the project directory and the `drv`s computed before the prompt, sign one `keylos.seal/1` statement per sealed generation with `HearthSeal.sealSign`, call `depot.seal` with each DSSE seal statement, and close the window with `HearthSeal.closeWindow` only after every `depot.seal` call has returned. `depot` signs each generation statement with `HearthSeal.sealSign` inside the window `forge` opened (any `hearth#seal` holder may sign within an open window; `hearth` checks that the statement's `drv` is in the window's `drvs`), so the window MUST stay open until `depot` has finished.
- **REQ-FORGE-061** A sealing window MUST NOT exceed 600 s (protocols §20.4); seals not completed in time fail with `kl:expired`.

### 3.7a Kernel-module generations

- **REQ-FORGE-065** `kmod` generations MUST be built only from project recipes against the kernel headers part of the exact kernel release they target (`kmod.kernel` = that release's `uname -r`), and composed only on facet `release` from a **signed modules part** produced by `forge-sign modules` (§5.4). `forge build` on a user machine MAY build the unsigned module part (for testing inside VMs) but MUST refuse to compose a `kmod` generation from unsigned modules (`kmod-unsigned`).
- **REQ-FORGE-066** `forge seal` MUST refuse targets of kind `kmod` and `container` (`kl:denied`): owner seals never authorise them (protocols §9.3, §21.4).

### 3.7b Container conversion (org publishers)

- **REQ-FORGE-067** `forge container convert` MUST implement `oci-convert/1` (§4.18) bit-for-bit: for the same source digest and platform it MUST yield the same generation digest, synthesized manifest and `drv` as `depot` on a node. It MUST pass every vector in `depot`'s `vectors/container-convert/`.
- **REQ-FORGE-069** Compositions of kind `bench-image` MUST write the manifest `benchImage` section (protocols §6.3) from the recipe's `benchImage` record and MUST fail when it is absent or inconsistent (§4.9 step 6a). Compositions of other kinds MUST NOT contain `benchImage`. `forge` MUST NOT write `x-bench` manifest fields.
- **REQ-FORGE-073** `forge container convert` MUST emit the `keylos.ociconv/1` descriptor (protocols §21.4) next to the generation, and the genstmt draft's `drv` MUST be `drv:sha256:` of its JCS bytes.
- **REQ-FORGE-068** `forge-sign statement --org <org>` MUST sign `keylos.genstmt/1` statements for `container` generations only with an `org-publisher/<org>/<id>` key held in an HSM or FIDO2 device, with `stream = "org:<org>"`, `kind = "container"`, and `drv` = the conversion descriptor digest (§4.18).

### 3.8 Rebuilders

- **REQ-FORGE-070** `forge-rebuilder` MUST rebuild every candidate derivation published for its streams, compare each output's generation digest with the claimed digest, and publish a realisation attestation only on bit-identical match.
- **REQ-FORGE-071** A rebuilder MUST build from sources it fetched itself (verifying `src:` digests) with its own bootstrapped toolchain (§4.15), and MUST NOT use binary inputs except outputs it has itself attested or bootstrapped.
- **REQ-FORGE-072** Attestations MUST be signed with the operator key in an HSM and submitted to the realisation log; the rebuilder MUST store and serve the `keylos.tlogproof/1` for each.

---

## 4. Design

### 4.1 Components

| Component | Where | Role |
|---|---|---|
| `forge` CLI | host (`shell` principal), rebuilder and release hosts | User interface; talks to `forged` through `Forge` (§5.1) |
| `forged` | host, tier 0 | Schedules evaluation, fetches sources via `gate`, starts build VMs via `bench`, canonicalises outputs, imports into `depot`, drives seals |
| `forge-eval` | subprocess of `forged` | Pure Nickel evaluation with a read-only dirfd of the recipe repository |
| `forge-parse` | subprocess of `forged` | Archive unpacking, lockfile parsing, ELF inspection |
| `forge-guest` | inside build VMs (PID 1 helper) | Mounts inputs, runs phases as `build`, streams logs, reports exit codes |
| `forge-rebuilder` | rebuilder servers (keylos `server` profile) | Watches candidates, schedules rebuilds on the local `forged`, signs and submits attestations |
| `forge-sign` | release signing hosts | Detached signatures from verified unsigned inputs (§5.4) |

### 4.2 Recipe language

Recipes live in a recipe repository (`pkgs`, or a project directory) as `.ncl` files and import `forge/lib.ncl`, shipped and versioned by this repository.

```nickel
let Ref = std.contract.from_predicate (fun s => std.string.is_match "^(gen|src|drv|obj):(sha256|fsv256):[0-9a-f]{64}$" s) in
let System = std.contract.from_predicate (fun s => std.array.elem s ["x86_64-linux", "x86_64-v3-linux", "aarch64-linux"]) in

let GitSource = {
  git | String,                       # https URL
  commit | String,                    # 40 or 64 hex
  tag | String | optional,
  tree | String,                      # src:sha256:… of the canonical tar stream
  submodules | Bool | default = false,
} in

let ArchiveSource = {
  url | String,
  hash | String,                      # src:sha256:… of the canonical tar stream of the unpacked archive
  archiveSha256 | String,             # sha256 of the archive bytes as downloaded
  upstreamGit | GitSource | optional, # REQUIRED unless noGit
  noGit | { reason | String } | optional,
  tarballDiff | Array { path | String, why | String } | default = [],
  stripComponents | Number | default = 1,
} in

let Blob = { path | String, sha256 | String, why | String, reviewer | String } in

let Phase = String in                 # POSIX sh script, run with `set -eu`

let Fetch = {
  url | String,
  expect | String,                    # SRI (sha256-…, sha512-…) or src:sha256:…
  name | String | optional,
  unpack | Bool | default = false,
} in

let Recipe = {
  name | String,
  version | String,
  systems | Array System | default = ["x86_64-linux", "aarch64-linux"],
  source | [| 'git GitSource, 'archive ArchiveSource, 'none |],
  vendor | { _ : Fetch } | default = {},
  patches | Array String | default = [],        # paths relative to the recipe dir, applied with `patch -p1` in order
  blobs | Array Blob | default = [],
  testPaths | Array String | optional,
  regenerate | [| 'autotools, 'meson, 'cmake, 'none |] | default = 'autotools,
  buildDeps | Array Ref | default = [],         # parts visible at build time under /usr
  hostDeps | Array Ref | default = [],          # tools run at build time
  runtimeDeps | Array Ref | default = [],       # parts co-composed with this part
  outputs | Array String | default = ["out"],
  outputFilter | { _ : Array String } | default = {},
  env | { _ : String } | default = {},
  parallelism | Number | default = 8,
  memoryMiB | Number | default = 8192,
  phases | {
    prepare | Phase | default = "",
    configure | Phase | default = "",
    build | Phase,
    install | Phase,
    check | Phase | default = "",
  },
  checkSeparate | Bool | default = true,
  check | { allowFailure | { reason | String } | optional } | default = {},
  reproducible | Bool | default = true,
  disallowedStrings | Array String | default = ["/build/", "/src/"],
  keepXattrs | Array String | default = [],
  linkBudget | Array String | optional,         # allowed DT_NEEDED sonames for tier-0 service parts
  buildImage | Ref | optional,                  # bench-image to build in instead of io.keylos.build-vm
                                                # (bootstrap stages, special toolchains); unsigned allowed
  meta | {
    license | Array String,                     # SPDX ids
    homepage | String | optional,
    cpe | String | optional,
    maintainers | Array String,
    upstreamContacts | Array String | default = [],
  },
} in

let Entrypoint = { exec | String, args | Array String | default = [], kind | [| 'gui, 'cli, 'service, 'harness, 'handler, 'notify-action |] } in

let Compose = {
  kind | [| 'app, 'runtime, 'os, 'service, 'agent-template, 'bench-image, 'data, 'legacy-image, 'kmod |],
  name | String,
  version | String,
  parts | Array Ref,
  runtime | Ref | optional,
  manifest | { .. },                  # keylos.manifest/1 fields other than the computed ones
  cmdsig | { _ : { .. } } | default = {},
  files | { _ : String } | default = {},
  agent | { template | { .. }, tools | { .. }, policy | { .. }, prompt | String } | optional,
  webapp | { origin | String, scope | String | default = "/", name | String,
             icons | Array String | default = [], browserRuntime | Ref } | optional,   # kind 'app only
  kmod | { kernel | String, modules | Array String, firmware | Array String | default = [] } | optional,
                                    # kind 'kmod only; parts MUST be signed module parts (§4.17)
  benchImage | { purposes | Array [| 'workbench, 'agent, 'agentDesktop, 'app, 'build, 'media, 'captive, 'pod |],
                 desktop | Bool | default = false } | optional,
                                    # kind 'bench-image only (REQUIRED there); protocols §6.3
} in
{ Ref, System, GitSource, ArchiveSource, Blob, Fetch, Recipe, Entrypoint, Compose }
```

Example part recipe:

```nickel
let forge = import "forge/lib.ncl" in
{
  name = "zlib",
  version = "1.3.1",
  source = 'git {
    git = "https://github.com/madler/zlib",
    commit = "51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf",
    tag = "v1.3.1",
    tree = "src:sha256:5b1f2c…",
  },
  regenerate = 'none,
  buildDeps = [ deps.stdenv ],
  outputs = ["out", "dev"],
  outputFilter = { dev = ["usr/include/**", "usr/lib/pkgconfig/**", "usr/lib/*.a"] },
  phases = {
    configure = "./configure --prefix=/usr",
    build = "make -j\"$NPROC\"",
    install = "make install DESTDIR=\"$OUT\"",
    check = "make test",
  },
  meta = { license = ["Zlib"], maintainers = ["@keylos/core"] },
} | forge.Recipe
```

`deps` is the dependency record provided by the repository's top-level evaluation; each value is a `gen:` ref after resolution (§4.3).

### 4.3 Evaluation and scheduling

```
recipes (.ncl) ──forge-eval (pure)──► records with symbolic deps
      │
      ▼
resolve(target):
  rec := records[target]
  for d in rec.buildDeps ∪ rec.hostDeps ∪ rec.runtimeDeps: g_d := resolve(d)      # depth-first, memoised
  drv := derivation(rec, {g_d})                                                   # §4.4
  if index[drv] exists: return index[drv]                                         # local realisation index
  if cache.lookup(drv) gives an attested output that depot already holds or can install: return it
  return build(drv)                                                               # §4.6
```

**Scheduler.** The resolved graph is executed with at most `maxParallelBuilds` VMs (default 2) and a host memory budget (`Σ memoryMiB ≤ 75 % of RAM`). Ready derivations are ordered by critical-path length (longest remaining chain first). A failed derivation cancels its dependents; independent branches continue unless `--fail-fast`.

**Realisation index.** `/var/lib/forge/index.redb` maps `(drv, output)` → `gen` for every output built or installed on this machine. Entries are added only after `depot.importTree` or `depot.install` succeeded. The index is a cache; `forge index rebuild` reconstructs it from `depot.list("part", "")` manifests (`derivation` + `x-forge.output`).

**Project cache.** `GET https://cache.keylos.org/realisations/<drv hex>` returns `{"drv", "outputs": {"out": {"gen": …, "oci": …}}}`. Results are hints only: `forged` installs the referenced generation through `depot.install("oci://…#gen=…")`, and the generation is usable as a build input only when `depot` reports a valid release-stream generation statement for it.

### 4.4 Derivation computation

The derivation is the protocols §11.1 JSON with the following **profile** (all fields REQUIRED unless stated):

| Field | Value |
|---|---|
| `schema` | `"keylos.drv/1"` |
| `name`, `version` | From the recipe |
| `system` | One of the System values |
| `inputs.src` | `src:` ref of the main source; omitted for `'none` |
| `inputs.vendor` | Map name → `src:` ref of every `Fetch` (lockfile translations use `"<eco>/<name>@<version>"`) and every patch file (`"patch/<file>"`, `src:sha256:` of the file bytes). Omitted when empty |
| `inputs.deps` | Map `"build:<name>"` / `"host:<name>"` / `"runtime:<name>"` → `gen:` ref |
| `builder` | `gen:` ref of the `io.keylos.build-vm` bench image for `system` |
| `args` | `["build"]` for parts, `["compose"]` for compositions, `["graft"]` for grafts, `["fetch"]` for source imports |
| `env` | Recipe `env` plus `SOURCE_DATE_EPOCH`, `NPROC`; keys sorted |
| `outputs` | Output names in recipe order |
| `sandbox` | `"keylos-build/1"` |
| `phases` | Names of non-empty phases in the order `prepare`, `configure`, `build`, `install`, `check` |
| `checkSeparate` | Bool |
| `x-script` | `sha256:` of the JCS of the `phases` record (scripts by name) |
| `x-policy` | `{"regenerate", "testPaths", "blobs": [sha256…], "disallowedStrings", "linkBudget", "keepXattrs", "memoryMiB"}` |
| `x-outputFilter` | The recipe's `outputFilter` |

`x-` fields are forge-local and included in the hash (protocols §11.1).

`SOURCE_DATE_EPOCH` is the committer time of `source.commit` (git), of `upstreamGit.commit` (archives with git), or the recipe's explicit `env.SOURCE_DATE_EPOCH` (`noGit` archives).

`drv ref = "drv:sha256:" + hex(SHA-256(JCS(drv)))`.

**Multi-output derivations.** Each output is a separate part generation. The realisation attestation for output `o` names the subject `<name>-<version>.<o>` and sets `predicate.output = "o"` (protocols §11.4).

### 4.5 Sources

#### 4.5.1 Fetching

- All fetches go through `gate.connect` with `forged`'s tokens; hosts are limited to `pkgs` policy `policy/source-hosts.ncl` plus `forge.allowedSourceHosts`.
- Git: fetch exactly `commit` (`gix`, depth 1; submodules by their recorded commits when `submodules = true`). The canonical tar stream (§4.5.5) of the tree is computed and compared with `tree`.
- Archives: download, compare `archiveSha256`, unpack in `forge-parse` (formats: tar, tar.gz, tar.xz, tar.zst, tar.bz2, zip), normalise into the canonical tar stream, compare `hash`.
- Mirrors: `forge.sourceMirrors` are tried in order after the primary URL fails; every fetch is digest-verified, so mirrors need no trust.
- Imported sources are stored in `depot` as `part` generations (`args = ["fetch"]`) with `x-forge.src = "src:sha256:…"`, so they dedup and are garbage-collected like everything else. They are unsigned on user machines and are used only as VM inputs.

#### 4.5.2 Tarball-vs-git diff

For archive sources with `upstreamGit`:

1. unpack the archive (with `stripComponents`) into a scratch tree in `forge-parse`;
2. produce the canonical tree of `upstreamGit.commit`;
3. compute paths only in the archive, only in git, and paths whose bytes or modes differ;
4. remove paths that the recipe's `regenerate` mode deletes and regenerates anyway (§4.5.3);
5. every remaining path MUST appear in `tarballDiff` with a `why`; otherwise fail with the full list (rule `tarball-diff`).

`forge srcdiff <target>` prints the diff report; `forge srcdiff <target> --since <old-version>` adds an upstream change summary for reviews.

#### 4.5.3 Regeneration

| Mode | Deleted before the build | Regenerated by |
|---|---|---|
| `'autotools` | `configure`, `aclocal.m4`, every `Makefile.in`, `config.h.in`, `build-aux/*` except listed hand-written scripts, generated macro copies in `m4/` (`libtool.m4`, `lt*.m4`, gnulib copies matched by known header lines), `ltmain.sh`, `config.guess`, `config.sub`, `install-sh`, `missing`, `depcomp`, `compile`, `ar-lib`, `test-driver` | `autoreconf -fi` with autoconf, automake, libtool, gettext and gnulib from `hostDeps` |
| `'meson` | nothing; `meson dist` artifacts listed in `tarballDiff` are rejected | — |
| `'cmake` | nothing | — |
| `'none` | nothing; requires a `pkgs` policy entry | — |

#### 4.5.4 Blob detection

A file is a **blob** if any holds:
- it is not valid UTF-8;
- its Shannon entropy over the first 64 KiB exceeds 7.5 bits/byte;
- its magic matches a compressed, archive or executable format (`xz`, `lzma`, `gzip`, `bzip2`, `zstd`, `zip`, ELF, PE, Mach-O, Java class, `.pyc`, wasm).

Files under `testPaths` are reported but need listing only if the build phase reads them (detected because the build fails without them).

#### 4.5.5 Canonical tar stream

`keylos-canon` produces the protocols §11.2 stream deterministically:

| Field | Value |
|---|---|
| Format | POSIX ustar; names > 100 bytes use the ustar prefix field; names that do not fit fail with `path-too-long` (pax headers are not used) |
| Order | Entries sorted by path bytes; directories before their contents (sorting by full path achieves this when directory entries end in `/`) |
| Regular file | mode `0644`, or `0755` when any execute bit is set |
| Directory | mode `0755`; empty directories kept |
| Symlink | target byte-exact |
| Other types | rejected (`bad-type`) |
| uid/gid, uname/gname | 0, 0, empty, empty |
| mtime | 0 |
| Padding | two 512-byte zero blocks at the end; no extra padding to a record size |

`src:sha256:` is SHA-256 over this stream.

### 4.6 Build VMs and the `keylos-build/1` sandbox

**Build images.** The bench image `io.keylos.build-vm` (composed by `pkgs` from this repository's guest sources) contains a minimal guest kernel, `forge-guest` as PID 1, uutils coreutils, `dash` with the exec-check patch, `patch`, and nothing else. Every tool a recipe needs arrives through `buildDeps` and `hostDeps`.

`bench` exports read-only generations into a VM from `VmSpec.storeSet` (protocols §7.3.13), in addition to the image's own closure. `forged` starts every build with:

```
VmSpec {
  image           = io.keylos.build-vm for system (release-signed bench-image)
                    | recipe.buildImage (bootstrap stages, special toolchains; may be an unsigned local part composition)
  storeSet        = sorted(buildDeps ∪ hostDeps ∪ source import ∪ vendor imports)   # gen refs
  purpose         = build
  unsignedImageOk = (image is not launchable)        # honoured by bench only for service:forge, purpose build, tier 3
  shares          = [out-<output> rw for each output]  (check VM: ro)
  vcpus, memoryMiB, gpu = false, network = [], display = false, fromSnapshot = ""
  session         = "" (bench generates), principalKind = bench
}
```

`forged` reaches `bench` on its registered `bench#user` route (protocols §19.2). Unsigned build images are possible only because build VMs are tier 3 and never touch the host's `kl-exec`; `bench` refuses `unsignedImageOk` for any other caller or purpose.

**Guest layout:**

| Guest path | Source | Mode |
|---|---|---|
| `/` | build image root | ro |
| `/keylos/gens/<hex>` | store set (dependency parts, source and vendor imports), exported by `bench` | ro |
| `/usr` | union of `buildDeps ∪ hostDeps` part trees, assembled by `forge-guest` with overlayfs inside the guest from `/keylos/gens/*` | ro |
| `/src` | source tree without `testPaths` (build VM) or full source (check VM), from its `/keylos/gens/<hex>` | ro |
| `/vendor/<name>` | vendored fetches, from `/keylos/gens/<hex>` | ro |
| `/out/<output>` | share `out-<output>` (host directory under `/var/lib/forge/out/<build ULID>/<output>`) | rw (build VM), ro (check VM) |
| `/build` | scratch disk (ext4, discarded) | rw |

**VmSpec sizing:** `vcpus = parallelism` (capped at host CPUs), `memoryMiB = recipe.memoryMiB`; build VMs boot cold from the image, or from a per-image boot snapshot when `bench` offers one for the same image digest. Build VMs count against the machine's RAM-class VM cap (protocols §2.3); when `bench` returns `kl:unavailable`, the build stays `queued` and retries with backoff.

**Phase execution.** `forge-guest` verifies that only `lo` exists (aborts otherwise), assembles `/usr`, creates `/build/src` as an overlay of `/src` with a writable upper on `/build`, applies `patches`, runs the regeneration step (§4.5.3), then each phase as `sh -eu -c "<script>"` as user `build` with:

```
OUT=/out/out  OUT_<NAME>=/out/<name>  SRC=/build/src  NPROC=<parallelism>
SOURCE_DATE_EPOCH=<epoch>  PATH=/usr/bin  LANG=C.UTF-8  TZ=UTC  HOME=/build/home  TMPDIR=/build/tmp
PKG_CONFIG_PATH=/usr/lib/pkgconfig:/usr/share/pkgconfig  KEYLOS_SYSTEM=<system>
```

plus the recipe `env`. Logs stream to `forged` over the VM's control channel and into the journal (`forge.<drv short>`).

**Determinism controls** beyond REQ-FORGE-021/022:
- ASLR stays on; compilers get `-ffile-prefix-map=/build/src=.` and `-fdebug-prefix-map` through the `stdenv` wrappers.
- The scratch filesystem is ext4 with a fixed `hash_seed` and `-E hash_seed=…` so directory iteration order is the same on every builder; output order is fixed by canonicalisation anyway.
- `getrandom` is not faked; builds that embed random data fail reproducibility checks.

**Build state machine:**

```
queued ─inputs ready─► preparing (build image, shares) ─► running(build VM) ─exit 0─► canonicalising ─► importing
   │                        │ error                        │ exit≠0 / timeout                │ rule failure     │
   ▼                        ▼                              ▼                                 ▼                  ▼
canceled                 failed                         failed                            failed            imported
imported ─checkSeparate─► running(check VM) ─exit 0─► done
                                            └─exit≠0 (no allowFailure)─► failed(check)
```

Timeout per phase: recipe `x-timeout` or 6 h. A VM crash is retried once (`vm-crash`).

### 4.7 Output canonicalisation

After `install`, `forged` walks each `/var/lib/forge/out/<build>/<name>` with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS)` and builds the tree description passed to `depot.importTree`:

| Rule | Action |
|---|---|
| Regular file | Content kept; mode `0555` if any execute bit was set or the file is ELF or starts with `#!`, else `0444` |
| Directory | Mode `0555`; empty directories kept |
| Symlink | Target byte-exact; absolute targets allowed only under `/usr/`, `/etc/`, `/run/`, `/var/`, `/dev/`, `/proc/`, `/sys/`; relative targets that escape the output root after normalisation fail (`symlink-escape`) |
| Hard links | Broken into independent entries |
| setuid / setgid / sticky | Build failure (`no-setuid`) |
| Device, FIFO, socket | Build failure (`bad-type`) |
| xattrs | All dropped except `user.*` names in `keepXattrs`; `security.capability` → build failure (`file-caps`) |
| Ownership | 0:0 |
| Timestamps | 0 |
| Path encoding | Valid UTF-8 without control characters; otherwise build failure (`bad-path`) |
| Disallowed strings | Each regular file scanned for every `disallowedStrings` entry; a hit fails the build (`build-path-leak`) |
| `.la` files | Removed |
| Output filter | Files assigned to outputs by `outputFilter` globs (first match in declaration order; unmatched → `out`) |
| Link budget | If `linkBudget` is set, every ELF `DT_NEEDED` must be in it (`link-budget`, §4.14) |
| Reserved paths | `/.keylos/` in a part output fails (`reserved-path`); only composition writes it |

### 4.8 Parts

A **part** is the generation of one derivation output. Its manifest:

```json
{"schema":"keylos.manifest/1","kind":"part","name":"part.zlib.out","version":"1.3.1",
 "derivation":"drv:sha256:…","reproducible":true,
 "x-forge":{"output":"out","runtimeDeps":["gen:fsv256:…"],"sonames":["libz.so.1"],
            "symbols":"sha256:<digest of the exported symbol list>","license":["Zlib"]}}
```

Parts are never launchable (protocols §6.1). Their files sit at their final paths (`/usr/lib/libz.so.1`), not under hash-named prefixes: there are no store paths inside binaries, and the same bytes are valid in every composition.

`x-forge.symbols` is SHA-256 over the sorted lines `<soname>\t<symbol>@<version>` of every dynamic symbol exported by every ELF shared object in the part (used by the graft ABI check).

### 4.9 Composition

A `Compose` record produces a generation of its kind:

1. closure := transitive closure of `parts` over `x-forge.runtimeDeps`;
2. union of all part trees; a path present in two parts with different content, mode or type fails (`compose-conflict`); identical entries merge;
3. add `files`, `/.keylos/manifest.json` (from `manifest` plus computed `kind`, `name`, `version`, `derivation`, `reproducible` = AND over parts, `runtime`, `grafted: false`), `/.keylos/cmdsig/*.json`, `/.keylos/sbom.spdx.json` (from parts' `meta`), `/.keylos/provenance.json`, `/.keylos/l10n/*.json` when given;
4. for `agent-template`: write `/.keylos/agent/template.json`, `tools.json`, `policy.json`, `prompt.md` from `agent` and compute every pinned digest per protocols §6.4 (tool digests, `tools.digest`, `prompt.digest`, `policy.digest`); `manifest.agent = {"template": "/.keylos/agent/template.json", "flowProof": …}`;
5. for `app` with `webapp`: write the `webapp` manifest section, set `runtime` = `webapp.browserRuntime`, derive `needs.network` for the origin (REQ-FORGE-035), and fail (`webapp-jit`) if `needs.jit` is requested;
6. for `kmod`: §4.17;
6a. for `bench-image`: write `manifest.benchImage = {"purposes": [...], "desktop": …}` from the `benchImage` record (protocols §6.3), purposes sorted and de-duplicated; fail `bench-image-purposes` if the record is missing or `purposes` is empty, if `desktop = true` without purpose `agentDesktop`, or if purpose `agentDesktop` is listed with `desktop = false`; `benchImage` on any other kind fails `bench-image-field`. No `x-bench` fields are ever written;
7. derivation `args = ["compose"]`, `inputs.deps` = the parts.

Composition is metadata-only (objects are shared), so recomposing costs milliseconds.

For kind `app` with a `runtime`, the app's parts MUST NOT contain paths the runtime also contains (`runtime-shadow`), so the app view is unambiguous.

### 4.10 Lockfile translators

`forge translate <lockfile>` and the recipe helper `vendor = forge.lock "<path>"` produce `Fetch` records:

| Ecosystem | Lockfile | Hash source | Offline configuration in the VM |
|---|---|---|---|
| Rust | `Cargo.lock` v3/v4 | `checksum` (SHA-256 of `.crate`); git deps by commit → canonical tree | `cargo vendor` layout at `/vendor/cargo` with `.cargo/config.toml` source replacement; `CARGO_NET_OFFLINE=true` |
| npm | `package-lock.json` v2/v3 | `integrity` (SRI sha512) | npm cache populated from vendored tarballs; `npm ci --offline` |
| pnpm | `pnpm-lock.yaml` v6/v9 | `resolution.integrity` | `pnpm install --offline --frozen-lockfile` with a store from `/vendor` |
| Yarn | `yarn.lock` (berry) | `checksum` | Offline mirror `/vendor/yarn` |
| Python | `uv.lock`, `pylock.toml` (PEP 751) | `hashes.sha256` of wheels and sdists | `uv sync --offline`, or `pip install --no-index --find-links /vendor/py --require-hashes` |
| Go | `go.sum` + `go.mod` | `h1:` dirhash verified against the module zip; forge records `src:sha256:` of the zip | `GOFLAGS=-mod=mod GOPROXY=file:///vendor/go GOSUMDB=off` (hashes already verified by forge) |
| Ruby | `Gemfile.lock` with `CHECKSUMS` | gem SHA-256 | `bundle install --local` with `vendor/cache` |
| Conda | `pixi.lock` | `sha256` | `pixi install --frozen --offline` with a channel mirror from `/vendor` |

Rules:
- Entries lacking a hash fail translation (REQ-FORGE-040), with a message naming the lockfile setting that adds hashes.
- Each fetch becomes `inputs.vendor["<eco>/<name>@<version>"] = src:sha256:<SHA-256 of the canonical tar stream of the fetched artifact unpacked, or of the single file wrapped as a one-entry stream>`; the lockfile's own expectation is checked at fetch time, and the mapping is recorded in `forge.lock` next to the recipe for review.
- Registries are reached through `gate` with host grants for the ecosystem registries listed in `pkgs` policy (`static.crates.io`, `registry.npmjs.org`, `files.pythonhosted.org`, `proxy.golang.org`, `rubygems.org`, `conda.anaconda.org`, conda-forge mirrors).
- Each fetched artifact becomes a `part` generation with `x-forge.src`, shared by every project using the same version.

### 4.11 Early cutoff

`inputs.deps` refers to dependency **generation digests**, so a dependency rebuilt to identical bytes leaves every dependent `drv` unchanged, and the realisation index answers without building. The cutoff is per output: a change confined to the `dev` output of a part does not change the `out` part's digest, and dependents that only use `out` are not rebuilt.

### 4.12 Grafts

`forge graft --stream <s> --replace <old-part> --with <new-part> [--in <gen>…] --advisory <KLSA-…>` (facet `release`):

1. **ABI check.** For every ELF shared object in `old-part`, `new-part` MUST contain a file at the same path with the same `DT_SONAME`, and its exported dynamic symbol set (name + version) MUST be a superset. Data-only files are compared by path set. Static archives (`.a`) or C/C++ headers in the replaced part disable grafting (`graft-static`), because dependents may have inlined the vulnerable code.
2. For each target generation containing `old-part` in its closure: recompose with `new-part` substituted. The derivation has `args = ["graft"]` and `inputs.deps = {"base": <old gen>, "replace:<old-part>": <new-part>}`.
3. The manifest gets `grafted: true` and `"x-forge": {"graft": {"replaced": [{"old": "gen:…", "new": "gen:…"}], "advisory": "KLSA-…", "expires": "<≤ 30 days>"}}`.
4. Release engineering MUST schedule the full rebuild; when it ships, the grafted generation is superseded. After `expires`, `pkgs` CI fails the stream until the rebuild ships.

### 4.13 Realisation attestations

```json
{"_type":"https://in-toto.io/Statement/v1",
 "subject":[{"name":"zlib-1.3.1.out","digest":{"fsv256":"…"}}],
 "predicateType":"https://keylos.org/realisation/v1",
 "predicate":{"drv":"drv:sha256:…","output":"out","builder":"rebuilder-a",
   "buildHost":{"arch":"x86_64","kernel":"7.2.3","forgeVersion":"1.0.4","cpu":"AMD EPYC 9354"},
   "started":"2026-10-01T10:00:00Z","finished":"2026-10-01T10:03:12Z"}}
```

Wrapped in DSSE (`payloadType: application/vnd.in-toto+json`), signed with `rebuilder/<operator>` (Ed25519 in an HSM), and submitted to the realisation log. The rebuilder stores the returned `keylos.tlogproof/1` and serves it.

Bootstrap and DDC results use the same statement shape with predicate types `https://keylos.org/bootstrap/v1` and `https://keylos.org/ddc/v1` (§4.15).

### 4.14 Tier-0 dependency budgets

Parts that compose into tier-0 `service` generations MUST set `linkBudget`. `pkgs` keeps the budget file `policy/tier0-links.ncl`; adding a soname requires two security-team approvals. Compression and codec libraries in tier-0 services MUST be loaded with `dlopen` behind a feature check, not linked.

### 4.15 Bootstrap and diverse double-compiling

**Bootstrap chain** (once per toolchain major bump, and by every rebuilder operator at onboarding):

| Stage | Input | Output |
|---|---|---|
| 0 | `hex0` seed (357 bytes, `stage0-posix`), the bootstrap VM kernel | `hex1` → `hex2` → `M0` → `cc_x86`/`cc_aarch64` |
| 1 | M2-Planet, mes, `tcc` per `live-bootstrap` steps | `tcc` |
| 2 | `tcc` → gcc 4.7 → gcc 10 → gcc 15, binutils, glibc | bootstrap `stdenv` parts |
| 3 | bootstrap `stdenv` | keylos `stdenv` parts (compared with the release `stdenv` by digest) |
| 4 | keylos `stdenv` | rustc via `mrustc` → rustc chain; LLVM; Go via the C bootstrap chain |

Stages run in `io.keylos.bootstrap-vm` (guest kernel + `forge-guest`; the seed and the stage sources are the only inputs). Each stage's outputs are recorded in a bootstrap attestation logged in the realisation log.

**DDC check.** Compile gcc (stage 3) twice: with the bootstrapped compiler (path A) and with clang built from the independent LLVM chain (path B); use each result to compile gcc again; the two final outputs MUST be bit-identical. The result is a DDC attestation. A failure blocks the stream's toolchain update.

### 4.16 Seal flow on user machines

```
forge seal [--project DIR] [TARGET…]
 1. evaluate project recipes (project.ncl `forge.seal` targets) → drvs D1..Dn (deterministic, before any prompt)
 2. build everything in build VMs; importTree each output and each composition → G1..Gm (unsigned)
 3. window := {schema "keylos.seal-window/1", owner, project: DIR, drvs: [D…], opened, expires: opened+≤600 s,
               machine: <machine key>}
 4. (windowId, presenceEnvelope) := HearthSeal.openWindow(JCS(window))     # touch on the trusted path
 5. for each launchable-kind generation G with drv D:
      stmt := {schema "keylos.seal/1", generation: G, drv: D, sourceTree, sealedAt: now, machine,
               window: windowId, windowDigest: sha256(presenceEnvelope)}
      (sig, keyRef) := HearthSeal.sealSign(windowId, JCS(stmt))
      depot.seal(G, DSSE{payloadType seal, payload stmt, signatures [{keyid: keyRef, alg: "ecdsa-p256-sha256", sig}]})
 6. HearthSeal.closeWindow(windowId)        # only after every depot.seal returned: depot signs each generation
                                          # statement with HearthSeal.sealSign inside this same window
 7. print the sealed generations; a window that expires first makes the remaining seals fail kl:expired
 targets of kind kmod or container are rejected before step 3 (REQ-FORGE-066)
```

The trusted-path prompt shown for `openWindow` lists the project directory, the source tree digest, each generation with name, kind and rendered capability set, and whether any has `reproducible: false` (effective tier ≥ 2).

`sourceTree` is `src:sha256:` of the canonical tar stream of the project directory as built (excluding paths ignored by `.gitignore` when the project is a git checkout, recorded in `x-forge.srcFilter`).

### 4.17 Kernel-module (`kmod`) builds

Out-of-tree modules are built by the project only (protocols §9.3: release-signed modules only, ADR-0057). A `kmod` is produced in four steps, all reproducible except the signature, which is detached:

| Step | Facet | Output |
|---|---|---|
| 1. Build | any (`forge build`) | Unsigned module part: `/lib/modules/<kernel>/extra/<name>/*.ko`, built in a build VM against the `kernel-headers` part of the exact kernel release (`hostDeps`), with `KBUILD_BUILD_TIMESTAMP`, `KBUILD_BUILD_USER=keylos`, `KBUILD_BUILD_HOST=forge` and `-ffile-prefix-map`; rebuilders reproduce this part |
| 2. Sign | release host | `forge-sign modules` appends a PKCS#7 module signature (the stream's module-signing key, the same key the kernel trusts) to each `.ko`, producing a **signed module part** whose provenance names the unsigned part; verifiers strip the signature trailer and compare with the reproduced unsigned bytes |
| 3. Compose | `release` | `Compose { kind = 'kmod, parts = [signed module part, firmware parts], kmod = { kernel, modules, firmware } }`; composition checks that every `.ko` carries a signature trailer, that `modules[]` names exactly the `.ko` files present, and that no path lies outside `/lib/modules/<kernel>/extra/` and `/lib/firmware/` |
| 4. Statement | release host | `forge-sign statement` signs the `kmod` generation with `release-stream/<stream>`; `depot` accepts no other signer for `kmod` |

The `kmod` derivation inputs include the kernel generation's digest, so a kernel update yields a new `kmod` derivation (one per supported kernel release). Composition of a `kmod` outside facet `release`, or from unsigned modules, fails with `kmod-unsigned`. Example: `io.keylos.kmod.nvidia-open` (pkgs) for every kernel release in a stream.

### 4.18 Container conversion for org publishers (`oci-convert/1`)

Organisations that run `keylos-sealed` pods sign the generation each node will compute from an OCI image. `forge container convert oci+container://<registry>/<repository>@sha256:<digest> --platform linux/amd64|linux/arm64` runs the conversion below **inside a build VM** (purpose `build`, `storeSet` empty, the image fetched by `forged` through `gate` and passed as a read-only share), writes the resulting tree through `depot.importTree` (facet `forge`, kind `container`), and prints the generation digest, the synthesized manifest, the conversion descriptor and a `keylos.genstmt/1` draft. `forge-sign statement --org <org>` then signs that draft (§5.4). Both `depot` and `forge` use the crate `keylos-oci-convert` from the `depot` repository; the algorithm below is a normative copy of `depot` spec §4.19, and `forge` CI runs `depot`'s `vectors/container-convert/`.

**Normative copy (depot spec §4.19, `oci-convert/1`).** Where it says `depot`, read "the converter"; steps 7–10 (store, root, statement lookup, receipt) are `depot`'s and are replaced in `forge` by `importTree` and the printed statement draft.

`install("oci+container://<registry>/<repository>@sha256:<digest>")` (facet `cri`) runs the conversion below. The algorithm is versioned `oci-convert/1`; any change to it is a new version and changes generation digests. `forge container convert` (publisher side) MUST implement exactly this algorithm through the same crate, so that an org publisher can sign the generation statement for the digest every node will compute.

**Inputs.** Source reference `R = <registry>/<repository>`, source digest `D` (`sha256:<hex>`), node platform `P` = `linux/amd64` on x86-64 or `linux/arm64` on aarch64.

```
convert(R, D, P):
 1. M0 := GET /v2/<repository>/manifests/<D> via gate; require sha256(M0) = D
    if M0 is an image index (application/vnd.oci.image.index.v1+json or Docker manifest list):
        pick the entry with platform.os = "linux", architecture = P.arch (arm64: variant absent or "v8");
        none → kl:unsupported (depot REQ-DEPOT-083); several → the first in index order
        M := GET manifest by that entry's digest; require its sha256
    else M := M0
 2. C := GET config blob; require sha256; require C.os = "linux" and C.architecture = P.arch
 3. for i, layer in M.layers (≤ 128):
        B := GET blob; require sha256(B) = layer.digest
        U := decompress by media type: tar (none), tar+gzip, tar+zstd; anything else → kl:unsupported
        require sha256(U) = C.rootfs.diff_ids[i]
        apply(U) to the tree model T (below), streaming file bytes into the object write path (depot spec §4.15)
 4. reject if T contains /.keylos (any entry) → kl:invalid
 5. synthesize /.keylos/manifest.json (below) as a regular file, mode 0444, uid 0, gid 0
 6. image := composefs(T) with the container exceptions (below); G := fsv256(image)
 7. write image to gens/, evidence/<G>/ {manifest.json, conversion.json, source.json}
 8. root(G, "cri:image:<D hex>")
 9. for each org O with scope org:O in /etc/keylos/publishers.json (sorted by org id):
        Res := CourierResolver.resolve("tuf:org:<O>/<name>@<version>")
        if Res.statement verifies (depot REQ-DEPOT-020.9) and its generation = G: store as statement.dsse; break
10. recompute launch(G); Ledger.append(gen.install {source: "oci+container://…", kind: "container", …})
```

**Applying a layer** (`apply(U)`), entries in tar order (POSIX ustar, GNU and PAX headers accepted; PAX `path`, `linkpath`, `size`, `uid`, `gid`, `SCHILY.xattr.*` honoured; everything else ignored):

| Entry | Rule |
|---|---|
| Path | Strip leading `./` and `/`; reject `..` components, NUL, empty names and paths > 4096 bytes (`kl:invalid`) |
| `.wh.<name>` | Remove `<name>` (and its subtree) from the same directory of T; the whiteout itself is not added |
| `.wh..wh..opq` | Remove every entry of the directory that came from earlier layers |
| Directory | Create or update: mode = header mode & `0o1777`, uid/gid from header |
| Regular file | Replace any entry at the path; content → object (empty files inline); mode = header mode & `0o777` |
| Hard link | Copy the target entry (which MUST exist in T at that point) to the new path; same object, same metadata |
| Symlink | Replace any entry at the path; target kept verbatim (≤ 4095 bytes) |
| Char/block device, FIFO, socket | Dropped; recorded in `conversion.json.dropped` |
| setuid / setgid bits | Stripped from files and directories; recorded in `conversion.json.stripped` |
| Sticky bit | Kept on directories; stripped from files |
| uid / gid | Kept numerically (`uname`/`gname` ignored) |
| mtime, atime, ctime | Ignored (all zero in the image) |
| xattrs | Keep `user.*` only; drop `security.*` (including file capabilities), `trusted.*`, `system.*` (ACLs); recorded |
| Parent directories missing | Created with mode `0755`, uid 0, gid 0 |

A non-directory entry replacing a directory removes the directory's subtree; a directory entry over an existing directory keeps its children.

**Synthesized manifest** (JCS, the only `/.keylos` content of a `container` generation):

```json
{"schema":"keylos.manifest/1","kind":"container","name":"<name>","version":"<version>",
 "container":{"image":"oci:sha256:<D hex>","platform":"<P>",
              "config":{"entrypoint":[…],"cmd":[…],"env":[…],"user":"…","workingDir":"…"}},
 "derivation":"drv:sha256:<hex>","grafted":false,"requiresFeatureLevel":"KL1","reproducible":true}
```

- `name` = `oci.` + the registry host's DNS labels in reverse order (a port is appended to the first emitted label as `-p<port>`) + `.` + the repository path segments, all lowercased, characters outside `[a-z0-9-]` replaced by `-`, joined with `.` (e.g. `ghcr.io/acme/web-api` → `oci.io.ghcr.acme.web-api`). The result always has ≥ 3 components (protocols §3.3); names longer than 255 bytes fail with `kl:invalid`.
- `version` = `0.0.0+oci.<first 16 hex of D>` (SemVer 2.0 build metadata).
- `container.config` copies `Entrypoint`, `Cmd`, `Env`, `User`, `WorkingDir` from `C.config` (absent → empty), nothing else.
- `derivation` = `drv:sha256:` of the JCS bytes of the **conversion descriptor** (`keylos.ociconv/1`, protocols §21.4) `{"schema":"keylos.ociconv/1","algorithm":"oci-convert/1","image":"oci:sha256:<D hex>","platform":"<P>","config":"sha256:<config blob digest>","layers":["sha256:<layer digest>",…]}` (layers in manifest order, as compressed-blob digests from the platform manifest, never uncompressed `diff_id`s; protocols §21.4 C50). Org publishers put the same value in the generation statement's `drv` field. For kind `container`, `drv` names this descriptor, never a `keylos.drv/1` derivation.

**composefs with container exceptions.** As depot spec §4.3, except: ownership is the recorded uid/gid; directory modes keep `0o1777` bits and file modes `0o777` bits; files and directories need not be `0444`/`0555`. Timestamps are zero and entries are sorted exactly as depot spec §4.3.

**Limits.** ≤ 128 layers, ≤ 32 GiB uncompressed in total, ≤ 2 000 000 entries, compressed blob ≤ 8 GiB; exceeding any limit fails with `kl:invalid`. Tar and JSON parsing runs in `depot-parse` (depot spec §6.3).

**`conversion.json`** (depot-local evidence, not signed): `{"converter":"oci-convert/1","source":"oci+container://…","indexDigest":"sha256:…"|null,"platformManifest":"sha256:…","config":"sha256:…","layers":[…],"dropped":[{"path","type"}],"stripped":[{"path","bits"}],"xattrsDropped":[{"path","name"}],"generation":"gen:fsv256:…","descriptor":"drv:sha256:…"}`. The descriptor bytes are stored next to it as `evidence/<G>/ociconv.json`.

**composefs rules referenced above (depot spec §4.3), restated for the converter:** EROFS block size 4096, no compression, no device table; directory entries sorted by byte-wise name comparison with `.` and `..`; regular files of size > 0 are metacopy redirects with `trusted.overlay.metacopy` = `0x00 0x24 0x00 0x01` ‖ 32-byte fs-verity digest and `trusted.overlay.redirect` = `/<first 2 hex>/<remaining 62 hex>`; empty files inline; symlinks inline; all timestamps zero; no hard links; identical xattr sets share one xattr table entry; whiteout-named files escaped exactly as the composefs reference writer does. The same input description yields a byte-identical image.

**Statement draft** printed by `forge container convert`:

```json
{"schema":"keylos.genstmt/1","generation":"gen:fsv256:<G>","kind":"container","name":"<name>",
 "version":"<version>","manifestDigest":"sha256:<JCS manifest digest>","drv":"<conversion descriptor drv>",
 "stream":"org:<org>","objects":"sha256:<sorted object list digest>","issued":"<now>"}
```

The org publishes the signed statement in its fleet TUF repository as the target for `tuf:org:<org>/<name>@<version>`, where `courier` resolves it for `depot` (`depot` spec §4.19 step 9).

---

## 5. Interfaces

### 5.1 `Forge` (forge-local capwire interface, served by `forged`)

Only the `forge` CLI uses this interface; it is repo-local (protocols §7.4).

```capnp
@0xa8f3d26b4c1e9071;
using C = import "common.capnp";

struct BuildRequest {
  repo       @0 :C.Fd;            # O_PATH dirfd of the recipe repository or project root
  targets    @1 :List(Text);      # attribute paths, e.g. "parts.zlib", "apps.\"org.example.Editor\""
  system     @2 :Text;
  keepFailed @3 :Bool;
  check      @4 :Bool;            # run check phases (default true)
  failFast   @5 :Bool;
}

struct BuildResult {
  target  @0 :Text;
  drv     @1 :Text;
  outputs @2 :List(C.KeyValue);   # output name → gen ref
  cached  @3 :Bool;
  log     @4 :Text;               # journal cursor
  error   @5 :Text;               # rule or phase failure, empty on success
}

interface Forge {                 # facet user (shell); graft and sign-prep on facet release
  build      @0 (req :BuildRequest, progress :C.Watcher(Text)) -> (results :List(BuildResult));
  eval       @1 (repo :C.Fd, target :Text) -> (json :Text);
  drv        @2 (repo :C.Fd, target :Text) -> (drv :Text, json :Text);
  translate  @3 (lockfile :C.Fd, kind :Text) -> (ncl :Text);
  srcdiff    @4 (repo :C.Fd, target :Text, since :Text) -> (report :Text);
  checkRepro @5 (repo :C.Fd, target :Text, rounds :UInt8) -> (identical :Bool, report :Text);
  seal       @6 (project :C.Fd, targets :List(Text)) -> (sealed :List(Text));
  graft      @7 (stream :Text, oldPart :C.Ref, newPart :C.Ref, targets :List(C.Ref), advisory :Text) -> (results :List(Text));   # facet release
  lock       @8 (repo :C.Fd, targets :List(Text)) -> (changed :List(Text));
  containerConvert @9 (source :Text, platform :Text) -> (generation :C.Ref, manifest :Text, descriptor :Text, statementDraft :Text);
      # oci-convert/1 (§4.18); facets user and release
}
```

### 5.2 CLI `forge`

Global flags: `--repo DIR` (default: nearest ancestor containing `forge.ncl` or `project.ncl`), `--system S`, `--json`, `-v`. Exit codes: `0` success, `1` build failed, `2` usage, `3` denied, `4` needs approval, `5` integrity or source-rule failure, `6` unavailable, `7` reproducibility mismatch.

| Command | Description |
|---|---|
| `forge build <target…> [--no-check] [--keep-failed] [--fail-fast]` | Build targets; print output generation refs |
| `forge eval <target>` | Evaluated recipe JSON |
| `forge drv <target>` | Derivation JSON and `drv:` ref |
| `forge lock [<target…>]` | Fetch and record source and vendor digests in `forge.lock` |
| `forge translate <lockfile> [--kind cargo\|npm\|pnpm\|yarn\|uv\|pylock\|go\|bundler\|pixi]` | Emit a Nickel `vendor` record |
| `forge srcdiff <target> [--since VERSION]` | Tarball-vs-git diff and upstream change report |
| `forge check-repro <target> [--rounds N]` | Build N times (default 2) with different scratch layouts and VM CPU counts; compare digests |
| `forge why-different <genA> <genB>` | Run `diffoscope` in a build VM over two part trees |
| `forge seal [--project DIR] [<target…>]` | Build and owner-seal (§4.16); refuses `kmod` and `container` targets |
| `forge container convert <oci+container://…> [--platform P] [--out DIR]` | Compute the `container` generation and a statement draft (§4.18); `--out` writes `statement.json`, `manifest.json`, `conversion.json` |
| `forge kmod <target> --kernel <uname>` | Build the unsigned module part for one kernel release (§4.17 step 1); composition is release-only |
| `forge graft …` | Release engineering only (facet `release`) |
| `forge bootstrap [--verify]` | Run the bootstrap chain |
| `forge ddc` | Run the DDC check |
| `forge index rebuild` | Rebuild the realisation index from `depot` |
| `forge rebuilder …` | Delegates to `forge-rebuilder` (server profile) |

### 5.3 `forge-rebuilder`

1. Poll `https://candidates.keylos.org/<stream>/index.json` every 60 s. The document is a DSSE envelope signed by `release-stream/<stream>` with payload `keylos.candidates/1`:
   ```json
   {"schema":"keylos.candidates/1","stream":"stable","serial":812,
    "items":[{"drv":"drv:sha256:…","drvJson":"<base64 JCS>","claimed":{"out":"gen:fsv256:…"}}]}
   ```
2. For each item not yet attested: check `SHA-256(drvJson)` = `drv`; materialise inputs (sources fetched by the rebuilder itself; dependencies MUST be generations the rebuilder has itself attested or bootstrapped); build; compare each output digest with `claimed`.
3. On match: sign the attestation, submit it to the realisation log (`POST /add`, tlog), store the proof, publish `https://<operator host>/attestations/<drv hex>.json` (array of `{output, attestation DSSE, tlogproof}`).
4. On mismatch: publish a mismatch report to the stream's inbox and alert the operator; no attestation is produced:
   ```json
   {"schema":"keylos.mismatch/1","drv":"drv:sha256:…","output":"out","claimed":"gen:fsv256:…",
    "obtained":"gen:fsv256:…","operator":"rebuilder-a","diffoscope":"sha256:<report digest>","time":"…"}
   ```

**Rebuilder state machine per candidate:** `new → fetching → building → compared → (attested | mismatched)`; `failed` after 3 attempts with a reason (`input-unavailable`, `build-failed`, `timeout`). Backlog and lag are published as metrics.

**Operator requirements** (normative for listing in the stream's rebuilder policy): independent organisation; own HSM-backed key; own hardware (no cloud account shared with the project); bootstrapped toolchain; at least one x86-64 and one aarch64 rebuilder in the set independent of each other; published uptime and backlog.

`keylos.candidates/1` and `keylos.mismatch/1` are forge-owned formats (protocols §19.4); only `forge` components and release tooling built from this repository read them.

### 5.4 `forge-sign`

Runs on air-gapped or HSM-attached release hosts. Input: an unsigned generation whose realisation quorum is met. Outputs are detached; inputs are never modified in place.

| Mode | Output |
|---|---|
| `statement` | `keylos.genstmt/1` statements (protocols §20.7) signed by `release-stream/<stream>` (Ed25519, HSM). The tool recomputes `manifestDigest` and `objects` from the generation before signing |
| `pe` | Authenticode signatures for the UKI and systemd-boot; the signed PE is a new part whose provenance names the unsigned part and the signature. Verifiers strip the PE certificate table and compare with the reproduced unsigned bytes |
| `modules` | Kernel module signatures in `scripts/sign-file` format (PKCS#7, `id_type = PKEY_ID_PKCS7`), appended to each `.ko` of an unsigned module part, producing the signed module part used by `kmod` composition (§4.17); the unsigned modules part is what rebuilders reproduce |
| `statement --org <org>` | `keylos.genstmt/1` for `container` generations signed by an `org-publisher/<org>/<id>` key (HSM or FIDO2), `stream = "org:<org>"`; the tool re-runs `oci-convert/1` from the pinned digest and refuses to sign if the generation digest differs from the draft |

There is no fs-verity signing mode: keylos uses no in-kernel signatures for store content (protocols §4).

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| Malicious release tarball (xz class) | Git-tree pinning, tarball-vs-git diff with justification, regeneration of generated files |
| Malicious test fixtures used during the build | `testPaths` invisible during the build; blob listing with a reviewer |
| Build reaches the network | No network device; `forge-guest` aborts if any interface besides `lo` exists |
| Build depends on host CPU or time | Masked CPU model, fixed clock, `SOURCE_DATE_EPOCH` |
| Build code attacks the host | Runs only in VMs; `forged` never executes recipe code; outputs walked with `openat2` without following symlinks |
| Compromised project build farm | Releases require k-of-n independent rebuilders |
| Compromised compiler (trusting trust) | Full-source bootstrap and DDC |
| Lockfile tampering | Hash expectations from the lockfile; `forge.lock` reviewed |
| Recipe evaluation DoS | `forge-eval` bounded |
| Graft used to smuggle changes | Facet `release` only; ABI check; expiry; graft derivations attested by rebuilders |
| Owner seal abuse | Windows need a touch; `drv`s fixed before the prompt; `hearth` signs only inside the window and only for statements whose `drv` is in the window; `kmod` and `container` never sealable |
| Malicious or unsigned kernel module reaching a host | `kmod` composition only from release-signed module parts on facet `release`; `depot` accepts only release-stream statements; the kernel enforces signatures |
| Org signs a container generation different from what nodes compute | `forge-sign statement --org` re-runs `oci-convert/1` and refuses on mismatch; shared vectors with `depot` |

### 6.2 Self-confinement of `forged`

| Aspect | Setting |
|---|---|
| Tier | t0 service, dynamic UID |
| Landlock | rw: `/var/lib/forge` (index, out directories, logs metadata); ro: repositories only through passed dirfds |
| Capabilities | none |
| Network | `gate` sockets for source hosts and registries only |
| Routes held | `depot#forge`, `hearth#seal`, `gate#client`, `journal#client`, `atrium#presence`, `bench#user` (registered holder, protocols §19.2; purpose `build` with `unsignedImageOk`) |
| Subprocesses | `forge-eval` (no capabilities, read-only repository dirfd, 2 GiB), `forge-parse` (no capabilities, scratch dirfd only) |

### 6.3 Residual risks

- Reproducibility proves binary = source, not that source is benign (xz). Only source rules and review (`pkgs`) address that.
- k colluding rebuilders can attest a malicious build of benign source; operator diversity is a governance control.
- The bootstrap seed, the build VM kernel and the hypervisor are trusted.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| Source host unreachable | Mirrors tried in order; all digest-verified |
| VM crash mid-build | Build failed `vm-crash`; retried once |
| Non-determinism (`check-repro`) | Exit 7; diffoscope report saved under `/var/lib/forge/reports/` |
| Canonicalisation failure | Build fails with the rule name and offending paths |
| `depot` unavailable | Builds finish in VMs; import retried for 10 min, then `kl:unavailable`; outputs kept for `keepFailedHours` |
| Window expired during seal | Remaining seals fail; completed seals stay; rerun |
| `hearth` refuses `sealSign` (drv not in window) | `kl:denied`; indicates a bug or a changed recipe; rerun |
| `bench` at its VM cap | Builds stay `queued`; retried with backoff; `forge build` shows `waiting for VM capacity` |
| Container conversion digest differs from `depot`'s | Release blocker for `keylos-oci-convert`; vectors catch it in CI |
| `kmod` composition from unsigned modules | Fails `kmod-unsigned` |
| Rebuilder backlog | Releases wait for quorum; quorum lag published |

---

## 8. Performance budgets

| Item | Budget |
|---|---|
| Recipe evaluation, full `pkgs` (≈ 2 600 recipes) | ≤ 20 s, ≤ 2 GiB |
| Build VM start (cold, minimal image) | ≤ 1.5 s; ≤ 400 ms from a boot snapshot |
| Canonicalisation + import | ≥ 300 MB/s |
| Composition of an app (5 000 files) | ≤ 300 ms |
| Lockfile translation (Cargo.lock with 600 crates, excluding downloads) | ≤ 2 s |
| Overhead vs a bare build on the same machine | ≤ 15 % wall time |
| Seal, excluding the touch | ≤ 1 s for 10 generations |

---

## 9. Observability

- Logs per phase with fields `drv`, `phase`, `system`, `vm`, `rule`.
- Metrics: `forge_builds_total{result}`, `forge_build_seconds` (histogram), `forge_cache_hits_total`, `forge_cutoff_total`, `forge_repro_mismatch_total`, `forge_rebuilder_backlog`, `forge_rebuilder_attested_total`, `forge_rebuilder_lag_seconds`.
- Receipts: `forged` writes none; imports and seals produce `x-depot.import` and `gen.seal` receipts in `depot`; rebuilder actions are recorded in the realisation log.

---

## 10. Configuration

```nickel
{
  forge | {
    maxParallelBuilds | Number | default = 2,
    hostMemoryShare | Number | default = 0.75,
    cacheUrl | String | default = "https://cache.keylos.org",
    sourceMirrors | Array String | default = ["https://sources.keylos.org"],
    allowedSourceHosts | Array String | default = [],
    keepFailedHours | Number | default = 24,
    phaseTimeoutHours | Number | default = 6,
    rebuilder | {
      enabled | Bool | default = false,
      operatorId | String | optional,
      streams | Array String | default = ["stable"],
      candidatesUrl | String | default = "https://candidates.keylos.org",
      hsm | { module | String, slot | Number, keyLabel | String } | optional,
      logUrl | String | default = "https://log.keylos.org/realisations",
      publishBase | String | optional,
    } | default = {},
  }
}
```

---

## 11. Testing and acceptance

### 11.1 Unit

- Canonical tar stream vs a reference implementation over 1 000 random git trees and edge cases (long paths, symlinks, empty directories).
- Derivation JCS stability: golden vectors `vectors/drv/`.
- Tarball-vs-git diff on crafted cases, including an xz-style injected `build-to-host.m4`.
- Every lockfile translator against official example lockfiles and edge cases (git deps, missing hashes).
- Agent-template pinning digests vs protocols §6.4 vectors.
- `oci-convert/1` vectors from `depot` (`vectors/container-convert/`).
- Module signature trailer construction and stripping round-trips.

### 11.2 Integration

| # | Scenario | Expected |
|---|---|---|
| 1 | Build `zlib` on two hosts (AMD and Intel) | identical generation digests |
| 2 | Build script runs `curl` | fails (no network) |
| 3 | Build phase reads `tests/` | fails |
| 4 | Archive with an unlisted modified `configure.ac` | fails `tarball-diff`; with justification passes |
| 5 | setuid bit in an output | fails `no-setuid` |
| 6 | Change confined to the `dev` output | `out` digest unchanged; dependents not rebuilt |
| 7 | Graft of a patched libpng into three apps | ABI check passes; manifests `grafted: true`; graft with a removed symbol fails |
| 8 | `forge seal` of a small Rust CLI | touch; seal; the binary executes on the host; a copy in `/home` cannot execute (kl-exec) |
| 9 | Rebuilder with a tampered claimed digest | mismatch report; no attestation |
| 10 | Bootstrap from hex0 to stdenv | completes; DDC bit-identical |
| 11 | Seal after the window expires | `kl:expired`; earlier seals intact |
| 12 | Build with a dependency set of 40 parts | `VmSpec.storeSet` lists exactly those 40 refs (sorted); no per-derivation bench image is created |
| 13 | Bootstrap stage with an unsigned local `buildImage` | VM starts with `unsignedImageOk = true`; the same request from another principal is refused by `bench` |
| 14 | `kmod` for the running kernel: build, `forge-sign modules`, compose on facet `release`, sign | `depot` accepts it; `warden` registers it; `modprobe` succeeds under `module.sig_enforce=1` |
| 15 | Compose `kmod` on facet `user` or from the unsigned part | `kmod-unsigned` |
| 16 | `forge seal` with a `kmod` or `container` target | `kl:denied` before any prompt |
| 17 | `forge container convert` over `depot`'s 40 conversion vectors | identical generation digests, manifests and `conversion.json` |
| 18 | `forge-sign statement --org` with a tampered draft | refuses (digest mismatch) |
| 19 | Seal of three generations; window closed only after the third `depot.seal` | all three launchable; closing early makes `depot`'s `sealSign` fail and the remaining seals fail |
| 20 | Webapp compose with `needs.jit = true` | fails `webapp-jit` |
| 21 | Compose `io.keylos.bench.media` with `benchImage = {purposes = ['media]}` | manifest has `"benchImage":{"desktop":false,"purposes":["media"]}`; `bench` accepts purpose `media` and refuses `workbench` (REQ-FORGE-069) |
| 22 | Compose a `bench-image` without `benchImage`, and an `app` with `benchImage` | `bench-image-purposes`; `bench-image-field` |
| 23 | `forge container convert` of a vector image | `ociconv.json` written; its JCS digest equals the genstmt draft `drv` and `depot`'s `manifest.derivation` (REQ-FORGE-073) |

### 11.3 Fuzz targets

`ncl_eval_sandbox` (malicious recipes), `tar_canon`, `git_tree_canon`, `archive_unpack`, `oci_convert_layers`, `ko_trailer`, `lock_cargo`, `lock_npm`, `lock_pnpm`, `lock_yarn`, `lock_uv`, `lock_pylock`, `lock_gosum`, `lock_bundler`, `lock_pixi`, `elf_dynsym`.

### 11.4 Acceptance

- ≥ 99 % of the `pkgs` base set builds bit-identically on two independent rebuilders.
- Every REQ-FORGE requirement covered by an automated test listed in `tests/REQUIREMENTS.md`.

---

## 12. Implementation notes

| Need | Crate |
|---|---|
| Nickel | `nickel-lang-core` (pinned release) |
| Git | `gix` |
| HTTP over gate sockets | `hyper` 1.x + `rustls` 0.23 |
| Tar | `tar` 0.4 |
| ELF parsing | `goblin` 0.9 / `object` 0.36 |
| Archives (in `forge-parse` only) | `flate2`, `xz2`, `zstd`, `bzip2`, `zip` |
| Lockfiles | `toml` 0.8, `serde_yml`, `serde_json` |
| JSON/JCS/DSSE | `keylos-formats` |
| PKCS#11 (rebuilder, forge-sign) | `cryptoki` |
| Authenticode | `authenticode` crate family or an in-repo PE writer (signing only on release hosts) |
| capwire | `keylos-capwire`, `keylos-schemas` |

Layout:

```
forge/
  lib/forge/lib.ncl           recipe contracts (versioned with forge)
  crates/forged/ forge-cli/ forge-guest/ forge-rebuilder/ forge-sign/
  crates/keylos-recipe/ keylos-drv/ keylos-lockxlate/ keylos-canon/ forge-parse/ forge-eval/
  guest/                      build-vm and bootstrap-vm composition recipes
  vectors/drv/ vectors/canon/ vectors/lock/
  fuzz/
```

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reference |
|---|---|---|
| Builds only in VMs, no network | Namespace sandbox on the host (host executes unsealed code) | [ADR-0009](../../handbook/11-decisions/adr-0009-unsealed-code-in-workbenches.md) |
| Files at final paths; composition by union; no store paths in binaries | Hashed prefixes with reference scanning | [ADR-0007](../../handbook/11-decisions/adr-0007-composefs-fsverity-store.md) |
| Content-addressed outputs and early cutoff; rebuilder quorum | Input-addressed only; single build farm | [ADR-0016](../../handbook/11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md) |
| Grafts as ABI-checked recomposition, flagged `grafted`, expiring | Binary patching of paths; permanent grafts | [ADR-0018](../../handbook/11-decisions/adr-0018-grafts-are-temporary.md) |
| Git trees, tarball diffs, regeneration, test isolation | Trust release tarballs | [ADR-0019](../../handbook/11-decisions/adr-0019-source-rules-after-xz.md) |
| Lockfile translation into one store | Per-ecosystem caches | [ADR-0042](../../handbook/11-decisions/adr-0042-one-store-for-language-ecosystems.md) |
| Nickel recipes | Nix language; Starlark | [ADR-0021](../../handbook/11-decisions/adr-0021-nickel-configuration.md) |
| Sealing windows signed by `hearth` | A touch per object or build; seal keys in `forge` | [ADR-0012](../../handbook/11-decisions/adr-0012-sealing-windows.md) |
| Build inputs passed as `VmSpec.storeSet`; unsigned build images only for `service:forge` purpose `build` | Per-derivation unsigned bench images carrying the store set in `x-` fields | [ADR-0009](../../handbook/11-decisions/adr-0009-unsealed-code-in-workbenches.md) |
| `kmod` only from release-signed module parts; never owner-sealed | DKMS on the host; owner-signed modules (impossible under lockdown) | [ADR-0057](../../handbook/11-decisions/adr-0057-oot-modules-project-signed-only.md) |
| Publisher-side container conversion shares `depot`'s crate and vectors | Org publishers signing OCI manifests; nodes trusting a publisher-supplied tree | [ADR-0047](../../handbook/11-decisions/adr-0047-cri-microvm-pods.md) |
| No fs-verity signing in `forge-sign`; generation statements only | Per-object PKCS#7 signatures | [ADR-0008](../../handbook/11-decisions/adr-0008-host-executes-only-sealed-code.md) |
