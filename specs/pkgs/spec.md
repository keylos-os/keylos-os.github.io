# keylos/pkgs — the package collection

| | |
|---|---|
| Repository | `github.com/keylos-os/pkgs` |
| Version | 1.0.0 (collection schema); content is released per stream |
| Status | Normative |
| Artifacts | Recipe tree (Nickel) for parts, runtimes, apps, services, OS profiles, bench images and agent templates; policy files (source hosts, blob allowlist, no-git and regeneration exceptions, non-reproducible apps, tier-0 link budgets, JIT allowlist, exec-check upstream status); `pkgs.lock`; the `pkgs-ci` tool; the interpreter exec-check patch series; security advisories (`advisories/`) |
| Depends on | `keylos-protocols 1.0`; `keylos/forge 1.0` (recipe contracts `forge/lib.ncl`, CLI, build VMs); the `keylos` repository consumes this collection to assemble images |
| Provides | Every generation shipped in the `stable`, `beta` and `dev` streams; the interpreter patch set enforcing `AT_EXECVE_CHECK` and the exec securebits; the runtimes catalogue (including the webapp browser-shell runtime); the bench images (build, workbench, app, agent, agent-desktop, media, pod, captive-browser); the Kubernetes node generations (`kubelet`, `kube-proxy`, `youki` in the pod image); project-built `kmod` generations (NVIDIA open modules); the debugger generations for `Right.debug`; service BPF objects and the core-dump helper inside the OS generation; the island images (BlueZ, iwd, fwupd, ModemManager, CUPS, SANE); the security response process |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`pkgs` is the curated collection of recipes from which keylos is built. It defines:

1. the repository layout and evaluation entry point consumed by `forge`;
2. the **package set** for v1.0: base OS, toolchains, interpreters, runtimes, desktop and CLI applications, services, bench images and agent templates;
3. the **interpreter patches** that make every shipped interpreter honour `AT_EXECVE_CHECK` and the exec securebits exactly as protocols §9.3 requires, including the trusted-terminal split;
4. **policies** enforced by `forge` and CI: source hosts, blobs, regeneration and no-git exceptions, non-reproducible apps, tier-0 link budgets, JIT allowlist;
5. the **update cadence** per stream and the **security response** process (embargoes, grafts versus rebuilds);
6. **maintainer rules** (two-party review, signed commits, upstream health monitoring);
7. the **CI gates**.

### 1.1 Non-goals

- The build engine and recipe language (`forge`); image assembly, release statements and signing (`keylos`); distribution (`courier`, `depot`).
- Software that cannot be built from source: firmware blobs are packaged by `keylos` as `data` generations with vendor provenance; proprietary user applications run through `compat`.

---

## 2. Context and embedded contracts

```
pkgs (recipes, policy, lock) ──forge eval/build──► part generations ──compose──► launchable generations
       │                                                                   │
       └── pkgs-ci (gates) ──► candidates (keylos.candidates/1, via forge) ──► rebuilders ──► realisations log
keylos (image assembly, release statements) consumes os.<profile>, runtimes, the default app set, bench images
```

### 2.1 Embedded contracts

Every block below is copied verbatim from `keylos/protocols` 1.0.0 (final). If an embedded copy differs from protocols, protocols wins.

#### protocols §2.2 Profiles and integrity profiles

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

#### protocols §9.2 Tiers

| Tier | Isolation | Code allowed |
|---|---|---|
| t0 | Baseline + service-specific allowances (system services) | Sealed only |
| t1 | Baseline (apps) | Sealed only |
| t2 | microVM (crosvm) managed by `bench`, display via Wayland proxy | Any (inside guest) |
| t3 | microVM workbench (dev environments, agent sessions) | Any (inside guest) |
| legacy | Baseline + a user namespace built by `warden` (child `user.max_user_namespaces=0`) + FHS view + seccomp user-notification open broker (`compat`). Only forge-built, reproducible legacy images signed by a trusted key run as tier L on the host; every imported image runs in t2 | Sealed legacy image |
| pod (`keylos-sealed`) | t1 baseline with `runtime-default` seccomp, in the pod network namespace inside the `cri` network (§21) | Sealed `container` generations signed by an org publisher |
| pod (`keylos-vm`) | t2-class microVM per pod sandbox managed by `bench` for `cri` | Any OCI image (inside guest) |

Media VMs (removable storage, §9.5), captive-portal browser VMs and agent desktops are tier-3 VMs with their own `VmSpec.purpose`.

#### protocols §9.3 Code integrity (host)

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

#### protocols §9.5 Devices, removable media and DMA

- **USB authorization.** `devd` sets `authorized_default=0` on every USB host controller. A newly attached device stays unauthorized (no driver binds) until approved on the trusted path and authorized through `DeviceAdmin.authorize` (§7.5.8). Approvals are stored per device identity (vendor, product, serial, port) when the human ticks "remember".
  - Input devices present during installation are pre-authorized.
  - A new device exposing a HID keyboard-like interface (`hidSafety: "keyboard-like"`) can only be approved using an **already-authorized** input device; its own keystrokes are discarded until then (BadUSB keystroke-injection defence).
  - Policy MAY auto-authorize device classes (`devices.autoAuthorize`, e.g. `["audio", "fido"]`); class `hid`, `net` and `mass-storage` are never auto-authorized by default.
  - **Before `devd` runs.** The kernel command line sets `usbcore.authorized_default=2` (only devices on internal, hard-wired ports are authorized). The initrd's authorizer (`boot`) additionally authorizes external hubs and devices whose interfaces are **all** HID, so external keyboards work for VBU, the PIN and the recovery prompt; it never authorizes storage, network or composite devices with a non-HID interface. In the initrd, keystrokes reach only those prompts (the TPM dictionary-attack lockout bounds PIN guessing). After `switch_root`, `devd` re-evaluates every authorized external device: a device that is neither remembered nor listed in `/var/lib/keylos/devd/preauthorized.json` is deauthorized and becomes pending. The remaining window is residual risk R15 of the distribution.
  - `/var/lib/keylos/devd/preauthorized.json` (written by the installer: the input devices present at installation; read by `devd`): `{"schema":"keylos.preauth/1","devices":[{"vendor":"046d","product":"c52b","serial":"…","port":"usb1-2","classes":["hid"]}]}` (vendor/product as 4 lowercase hex digits; `serial` empty when the device has none).
- **Thunderbolt / USB4 / external PCIe.** The IOMMU is required (§2). Domains and devices are authorized by `devd` only after trusted-path approval; without an IOMMU they are never authorized. Pre-boot DMA protection relies on firmware; the boot report records whether the firmware declared it.
- **Removable storage is never mounted by host filesystem drivers.** Authorizing a mass-storage, SD, optical or MTP device makes its block device (or MTP endpoint) available only through `MediaAttach.claimBlock` to a **media VM** (`VmSpec.purpose = media`, image `io.keylos.bench.media`), started by `Bench.media`. The VM mounts the filesystem and serves files through `MediaBrowser` (§7.5.10).
  - Bytes read through `MediaBrowser.open` are labelled `public/untrusted`; `portal-files` shows the device as the location "USB: <label>".
  - Writing to the device is the effect `media.export` (§14.2): data is copied into the media VM, which writes it.
  - Exception: a disk whose LUKS2 header carries the keylos backup token (`keylos-backup`) and verifies against the machine's backup key is unlocked and mounted on the host by `strata` for backups only.
- **Fingerprint readers** may unlock the screen lock only. They never satisfy presence and never unlock the disk.
- **VFIO passthrough** (`needs.gpu: "passthrough"`, pod VMs): only devices listed in config `devices.passthrough` are bound to `vfio-pci` through `MediaAttach.claimVfio`; the host driver is unbound for the VM's lifetime.

#### protocols §10.7 Cross-repository files

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

#### protocols §19.1 Service names

| Service | Repo | Tier | Notes |
|---|---|---|---|
| `warden` | warden | PID 1 | Serves `Supervisor` and `warden-sys` |
| `broker` | broker | t0 | |
| `ledger` | ledger | t0 | |
| `vault` | vault | t0 | |
| `hearth` | hearth | t0 | |
| `gate` | gate | t0 | Also per-principal shim endpoints (facet `shim`) |
| `net` | net | t0 | |
| `aide` | aide | t0 | |
| `depot` | depot | t0 | |
| `courier` | courier | t0 | |
| `strata` | strata | t0 | |
| `config` | config | t0 | |
| `forge` | forge | t0 | `forged`; builds run in tier-3 build VMs |
| `atrium` | atrium | t0 | Compositor and trusted path; serves `prompt`, `display`, `a11y`, `screencast` interfaces |
| `portal-files`, `portal-screen`, `portal-camera`, `portal-mic`, `portal-openuri`, `portal-notify`, `portal-print`, `portal-clipboard`, `portal-location`, `portal-a11y`, `portal-background`, `portal-shortcuts`, `portal-inhibit` | portals | t0 (per-user instances) | One process per portal per logged-in human |
| `bench` | bench | t0 | |
| `compat` | compat | t0 | |
| `devd` | devd | t0 | |
| `journal` | journal | t0 | |
| `fleet` | fleet | t0 | Present only on fleet-enrolled machines |
| `vouch` | vouch | t0 | Machine-side `vouchd`; present when a phone is paired |
| `classifier` | (policy-named generation) | t0 | Optional approval-escalation classifier (`classifier.capnp`, §7.5.24); facet `broker` only |
| `loom` | loom | t0 | Durable workflow coordinator (§20.25); orchestrates only: it holds no workflow authority of its own, and `broker` and `gate` authorize every attempt and effect |
| `portal-discovery`, `portal-scan` | portals | t0 (per-user instances) | mDNS/DNS-SD; scanners through a compat SANE island |
| `pipewire` | portals | t1 (per-user instance) | The human's PipeWire daemon (upstream, sealed); reachable only by portals, which hand out restricted remotes |
| `cri` | cri | t0 | CRI v1 server; `server-k8s` profile only (§21) |
| `kubelet` | pkgs (upstream, sealed) | t1 service | Holds no root; route `cri#kubelet`; `server-k8s` only |
| `kube-proxy` | pkgs (upstream, sealed) | t1 service | `CAP_NET_ADMIN` only inside the cri network namespace; `server-k8s` only |
| `_system` | — | — | Pseudo-target of `Supervisor.control` for `poweroff`/`reboot`; has no socket and no facets |

#### protocols §21.1 Boundary (cluster nodes)

- The `server-k8s` profile runs upstream `kubelet` and `kube-proxy` (sealed generations built by `forge`, packaged in `pkgs`) and the keylos `cri` service.
- `kubelet` reaches `cri` only through the route `cri#kubelet`: `warden` creates an `AF_UNIX` `SOCK_STREAM` socket pair and passes `kubelet` its end as `--container-runtime-endpoint=unix:///run/keylos/cri/cri.sock` (a path inside kubelet's view bound to that socket). This is the only non-capwire IPC in keylos (§7.1).
- `cri` implements CRI v1 (`runtime.v1.RuntimeService`, `runtime.v1.ImageService`) for the three most recent Kubernetes minor versions at release time.
- `kubelet` runs as a tier-1 service without root and without capabilities, in the cri network namespace (`services.json` `network: "cluster"`). It holds: the `cri#kubelet` route; the cgroup subtree `/keylos.slice/kube.slice` (delegated to `cri`, read-only to kubelet for stats); its state directory `/var/lib/keylos/cri/kubelet` (written by `cri`: certificates, kubeconfig). Volume mounts, networking and image handling are done by `cri`, never by kubelet.
- **Mount-free kubelet.** `pkgs` builds kubelet with the `keylos-mountless` patch set, which is part of this contract: kubelet never calls `mount`/`umount` (they are denied by seccomp anyway). Its volume plugins write configMap, secret, projected and downwardAPI contents into plain directories under `/var/lib/keylos/cri/kubelet/pods/<uid>/volumes/`, and every mount, unmount, and device-attach step is a no-op; `cri` turns those directories into `PodMount` trees (`tmpfsBytes > 0` for secret-bearing types, §7.5.1) or VM shares, and handles emptyDir, local, NFS/iSCSI/RBD and CSI volumes itself (§21.6).
- `kube-proxy` runs in nftables mode inside the `cri` network namespace with `CAP_NET_ADMIN` there only.

#### protocols §21.2 Runtime classes

| RuntimeClass | Isolation | Images | Notes |
|---|---|---|---|
| `keylos-vm` (default) | One `bench` microVM per pod sandbox (`VmSpec.purpose = pod`); containers run inside the guest under `youki` driven by `benchd` | Any OCI image, pulled by `cri` into `/var/lib/keylos/cri/images` (via `gate` when `cluster.egressViaGate`), shared read-only into the VM | VM principal `pod:<ns>/<name>:oci:sha256:<first image>@_cluster/…`; GPU only by passthrough |
| `keylos-sealed` | t1 principals spawned by `warden` through `PodSpawn` (§7.5.1) | Only `container` generations (§6.1) with a generation statement signed by an `org-publisher` key enabled on the machine | One principal per container; seccomp `runtime-default`; no added capabilities ever |

---

## 3. Requirements

- **REQ-PKGS-001** Every shipped generation MUST be produced from recipes in this repository by `forge`, at a commit that passed all CI gates (§4.11).
- **REQ-PKGS-002** Every recipe MUST pin its sources by git commit and canonical tree digest, or by archive digest with `upstreamGit` and an explained tarball diff (forge source rules). `noGit` archives MUST be listed in `policy/no-git.ncl` with a reviewer.
- **REQ-PKGS-003** Every part in the `os` generation of every profile, every `runtime`, every tier-0 `service` and every `bench-image` MUST be reproducible (`reproducible = true`) and MUST reach the realisation quorum before release.
- **REQ-PKGS-004** Apps with `reproducible = false` MAY ship only with manifest `tier: 2`, MUST be listed in `policy/non-reproducible.ncl` with a tracking issue and an expiry review date, and MUST NOT be in the default app set.
- **REQ-PKGS-005** Every interpreter in §4.5 MUST carry the exec-check patch with the behaviour specified there; CI MUST run the conformance suite of §11.2 for each.
- **REQ-PKGS-006** Every tier-0 service part MUST declare a `linkBudget` matching `policy/tier0-links.ncl`.
- **REQ-PKGS-007** Every app and service generation MUST ship command signatures for every command it puts on `PATH` and MUST declare a complete, minimal `needs` set; CI MUST run each app in its declared tier and fail if the smoke script needs an access the manifest does not declare, or passes with a declared access removed (minimality probe, §4.11).
- **REQ-PKGS-008** Recipe changes MUST have two approvals from distinct maintainers, at least one from the owning team (CODEOWNERS), and every commit MUST be signed (SSH or gitsign) by a key registered in `MAINTAINERS.ncl`.
- **REQ-PKGS-009** Security fixes MUST follow §4.10, including the target response times.
- **REQ-PKGS-010** Each stream MUST be rebuildable entirely from source by an independent party using only this repository at the release commit, `forge`, and network access to the pinned source hosts or the project's source mirror.
- **REQ-PKGS-011** Only generations listed in `policy/jit.ncl` MAY declare `needs.jit: true`.
- **REQ-PKGS-012** Build intermediates MUST be `part` generations; only `Compose` recipes produce launchable kinds.
- **REQ-PKGS-013** Reused daemons that require D-Bus MUST be packaged as islands (§4.8); no generation may ship a system or session bus configuration for general use.
- **REQ-PKGS-014** Out-of-tree kernel modules MUST ship only as `kmod` generations built by `forge` from recipes in this repository for each kernel release of the stream, with modules signed by the stream's module-signing key (protocols §9.3, forge §4.17). No recipe may ship DKMS, module build scripts for the host, or unsigned `.ko` files in any launchable generation.
- **REQ-PKGS-015** Service BPF programs MUST be built from source in this repository (or the owning service repository) with `clang -target bpf`, MUST be installed only at `/usr/lib/keylos/bpf/<service>/<program>.o` in the `os` generation, and MUST be listed for their service in the default `services.json` table assembled by `keylos` (protocols §9.3, §20.16). No other generation may contain BPF ELF objects.
- **REQ-PKGS-016** Upstream `kubelet` and `kube-proxy` MUST be built from source (Go toolchain bootstrapped through the C chain) for the three most recent Kubernetes minor versions at release, with reproducible flags (`-trimpath`, `-buildvcs=false`, fixed `-ldflags` version stamps), and shipped as sealed tier-1 `service` generations used only by the `server-k8s` profile.
- **REQ-PKGS-017** Debugger generations (gdb, lldb, perf, bpftrace) MUST be `app` generations with `tier: 1`, no `needs` beyond those required to talk to `warden`'s `DebugAttach`, and MUST NOT appear on any profile's default `PATH`; they are spawned only through `DebugAttach` (protocols §9.3).
- **REQ-PKGS-018** Every bench image MUST declare the `VmSpec.purpose` values it supports in the manifest **`benchImage`** section (`{"purposes": [...], "desktop": …}`, protocols §6.3) through the recipe's `benchImage` record (forge §4.9); `bench` refuses other purposes. `desktop: true` is set exactly on `io.keylos.bench.agent-desktop`. Bench images MUST NOT carry `x-pkgs.purpose` or any `x-bench` field, and MUST NOT rely on `x-` manifest fields for their store set: store sets are passed by callers in `VmSpec.storeSet` (protocols §7.3.13).
- **REQ-PKGS-019** `io.k8s.kubelet` MUST be built with the **`keylos-mountless`** patch set (protocols §21.1), which is part of the cluster contract: kubelet never calls `mount`/`umount`/`umount2`, never opens `/dev/loop*` or block devices, and never runs mount helpers. Its in-tree volume plugins for `configMap`, `secret`, `projected` and `downwardAPI` write their contents into plain directories under `/var/lib/keylos/cri/kubelet/pods/<uid>/volumes/<plugin>/<name>/`; every `SetUp`/`TearDown`/`MountDevice`/`UnmountDevice`/attach/detach step of every other plugin (emptyDir, local, hostPath, NFS, iSCSI, RBD, CSI) is a no-op that records the request for `cri` (§4.2.11). The patch set is maintained in `patches/kubelet/keylos-mountless/` per supported minor and MUST apply without fuzz.
- **REQ-PKGS-020** `io.keylos.bench.captive-browser` MUST read the portal URL only from the VM boot arguments (`VmSpec.bootArgs` key `captive.url`, delivered by `benchd`, protocols §7.3.13) and MUST NOT accept URLs from any other channel; `net` starts the VM itself through `bench#net` (`NetCaptive.signIn`, protocols §7.5.11).

---

## 4. Design

### 4.1 Repository layout

```
pkgs/
  default.ncl               entry point: { parts, runtimes, apps, services, os, benchImages, agentTemplates, data, legacyImages, deps }
  pkgs.lock                 resolved digests (sources, vendor fetches) maintained by `forge lock`
  MAINTAINERS.ncl           people, teams, keys, areas, onboarding dates
  CODEOWNERS
  SECURITY.md               disclosure contacts and embargo policy (summary of §4.10)
  parts/<category>/<name>/recipe.ncl [patches/*.patch] [files/*]
  runtimes/<name>/runtime.ncl
  apps/<app-id>/app.ncl     compose recipes (manifest, cmdsig, desktop entries, l10n)
  services/<name>/service.ncl
  os/<profile>.ncl          desktop, laptop, server, appliance, installer, recovery
  bench-images/<name>.ncl   build-vm, bootstrap-vm, workbench-base, workbench-dev, app-vm, agent-vm, captive-browser
  agent-templates/<name>/template.ncl
  legacy-images/<name>.ncl  forge-built, reproducible legacy images (tier L)
  data/<name>/data.ncl      fonts, icon themes, timezone database, CA bundle, hwdb, firmware wrappers
  policy/
    source-hosts.ncl        allowed fetch hosts and mirrors
    blobs.ncl               global blob allowlist
    no-git.ncl              archives without git, with reasons and reviewers
    regenerate-none.ncl     recipes exempt from regeneration, with reasons
    non-reproducible.ncl    exceptions (apps only, tier 2)
    tier0-links.ncl         dependency budgets for tier-0 services
    jit.ncl                 generations allowed needs.jit
    exec-check-upstream.ncl upstreaming status of the interpreter patches
  advisories/YYYY/KLSA-YYYY-NNNN.ncl
  ci/                       pkgs-ci configuration and sources
  tests/                    interpreter conformance, smoke scripts, minimality probes
```

`default.ncl` builds `deps` (name → part ref) by evaluating parts in dependency order; `forge` resolves refs lazily by building or by looking up realisations.

### 4.2 Package set overview (v1.0)

Counts are targets for the v1.0 `stable` stream (±10 %).

| Category | Recipes | Section |
|---|---|---|
| Bootstrap and stdenv | 40 | §4.2.1 |
| Base libraries | 220 | §4.2.2 |
| Kernel, firmware and boot | 15 | §4.2.3 |
| keylos system services | 30 | §4.2.4 |
| Reused system components | 40 | §4.2.5 |
| Toolchains and interpreters | 120 | §4.2.6 |
| Developer CLI | 180 | §4.2.7 |
| Desktop libraries and toolkits | 260 | §4.2.8 |
| Desktop apps | 160 | §4.2.9 |
| Language ecosystem parts (vendored crates, wheels, npm packages, Go modules) | 1 300 | §4.2.10 |
| Kubernetes node | 6 | §4.2.11 |
| Kernel modules (`kmod`) | 1 per kernel release | §4.2.3 |
| Debugger generations | 4 | §4.14 |
| Runtimes | 9 | §4.3 |
| Bench images | 10 | §4.4 |
| Agent templates | 5 | §4.4 |
| Islands | 6 | §4.8 |
| OS profiles | 9 | §4.6 |
| Total | ≈ 2 600 | |

#### 4.2.1 Bootstrap and stdenv

| Group | Contents |
|---|---|
| Seed chain | `stage0-posix` (hex0, hex1, hex2, M0, M2-Planet), `mes`, `mescc-tools`, `tcc` (live-bootstrap steps) |
| Compilers | gcc 4.7 (bootstrap bridge), gcc 10 (bridge), gcc 15 (final) |
| Core | binutils 2.45, glibc 2.42, linux-headers, make 4.4, gawk, sed, grep, diffutils, patch, findutils, uutils coreutils, dash 0.5.12 (exec-check), tar, gzip, xz, zstd, bzip2, file |
| stdenv wrappers | compiler wrappers adding `-ffile-prefix-map`, `-fdebug-prefix-map`, `-fstack-protector-strong`, `-D_FORTIFY_SOURCE=3`, `-fstack-clash-protection`, `-fcf-protection=full` (x86-64), `-mbranch-protection=standard` (aarch64), PIE, `-Wl,-z,relro,-z,now,-z,noexecstack` |

#### 4.2.2 Base libraries

| Group | Contents |
|---|---|
| Compression | zlib-ng (zlib-compat API), xz/liblzma (dlopen-only in tier 0), zstd, bzip2, lz4, brotli |
| Crypto and TLS | OpenSSL 3.5 LTS (for compat consumers), rustls-ffi, libsodium, nettle, gnutls (compat consumers only) |
| Core utilities | libffi, ncurses, readline, pcre2 (JIT disabled), libxml2, libxslt, expat, json-c, yajl |
| Data and archives | sqlite, libarchive, lmdb |
| Networking | curl (rustls backend), nghttp2, nghttp3, ngtcp2, c-ares, libpsl |
| System | libuuid (util-linux), libcap-ng, libseccomp, libbpf, elfutils, libmount, libblkid, kmod (inspection only), libinput, libevdev, libudev-compat shim over devd |
| i18n and text | icu, gettext runtime, fribidi, harfbuzz, freetype, fontconfig |
| Graphics | cairo, pixman, pango, libpng, libjpeg-turbo, libwebp, libavif, dav1d, libjxl, libtiff, lcms2, librsvg (Rust), libxkbcommon |
| Audio and video | libogg, libvorbis, opus, flac, libsndfile, libva, libvpx, aom (encoder), SVT-AV1 |

#### 4.2.3 Kernel, firmware and boot

| Part | Notes |
|---|---|
| `linux` | Built by `keylos` from this recipe with the distribution kernel configuration; modules ship inside the OS generation only |
| `linux-firmware-<vendor>` | Split into per-vendor `data` generations (amdgpu, i915/xe, iwlwifi, ath, rtw, mediatek, brcm, qcom, nvidia-gsp) with vendor provenance |
| `intel-ucode`, `amd-ucode` | `data` generations loaded by the early microcode loader |
| `wireless-regdb` | `data`, signed database checked by the kernel |
| `systemd-boot`, `systemd-stub` | Built from systemd sources as standalone parts (§4.2.5) |
| `kl-boot` initrd parts | From the `boot` repository's sources |
| `kernel-headers` | Part for each kernel release of the stream; build input of every `kmod` recipe |
| `kmod.nvidia-open` | `kmod` generation `io.keylos.kmod.nvidia-open` per kernel release: NVIDIA open GPU kernel modules (`nvidia`, `nvidia-modeset`, `nvidia-drm`, `nvidia-uvm`), built against `kernel-headers`, release-signed (forge §4.17); `nvidia-gsp` firmware referenced from the firmware data generation |
| `kmod` policy | Only listed in `policy/kmods.ncl` with a maintainer team and security review; every kernel release in a stream gets a matching `kmod` generation in the same release, otherwise the stream CI fails (`kmod-coverage`) |

#### 4.2.4 keylos system services

`warden`, `broker`, `ledger`, `vault`, `hearth`, `gate`, `net`, `aide`, `depot`, `courier`, `strata`, `config`, `forge` (`forged`), `atrium`, `portals` (one recipe per portal service, including `portal-discovery` and `portal-scan`), `bench`, `compat`, `devd`, `journal`, `fleet`, `vouch` (machine side), `cri` (`server-k8s` only), `kish`, plus the client crates' CLIs. Each is a `service` (or `app` for `kish` and `atrium` clients) composition with a `linkBudget` (§4.9).

**Files placed in the `os` generation by service recipes:**

| Path | Built from | Rule |
|---|---|---|
| `/usr/lib/keylos/bpf/strata/provenance.o` | `strata` BPF sources | REQ-PKGS-015 |
| `/usr/lib/keylos/bpf/net/*.o` | `net` firewall helper BPF sources | REQ-PKGS-015 |
| `/usr/lib/keylos/bpf/gate/*.o` | `gate` accounting BPF sources | REQ-PKGS-015 |
| `/usr/lib/keylos/journal/coredump` | `journal` sources | The kernel `core_pattern` pipe helper (protocols §9.3 core-dump exception): statically linked Rust binary that installs its own seccomp filter before reading input |
| `kl-exec` BPF object | `boot` sources | Inside the initrd only, loaded by `boot` (protocols §9.3) |

#### 4.2.5 Reused system components

| Component | Packaging | Consumer |
|---|---|---|
| systemd-boot, systemd-stub, systemd-measure, systemd-pcrlock | Standalone parts built from systemd sources (no PID 1, no journald) | `boot`, `courier`, `keylos` |
| libcryptsetup | Library part | `boot`, `installer` |
| tpm2-tss | Library part | `boot`, `hearth`, `vault`, `courier`, `ledger` |
| iwd | Island service | `net` |
| wpa_supplicant | Island service (enterprise Wi-Fi fallback) | `net` |
| PipeWire, WirePlumber | Service and client libraries | `portals`, apps |
| BlueZ | Island service | `devd` |
| dbus-broker | Islands only | islands |
| ntpd-rs | Service part (NTS client) | `net` |
| fwupd | Island service | `courier` |
| CUPS, cups-filters, ipp-usb | Legacy island | `portals` (print) |
| ModemManager | Island service | `net` |
| crosvm, virtiofsd | Service parts | `bench` |
| Wasmtime | Library part | `gate` (renderers), `aide` (WASI harnesses) |
| Smithay-based compositor libraries | Library parts | `atrium` |

#### 4.2.6 Toolchains and interpreters

| Toolchain | Versions | Notes |
|---|---|---|
| GCC | 15 | Default C/C++ compiler |
| Clang/LLVM | 21 | Also built through the independent chain for DDC (forge §4.15) |
| Rust | stable N, N−1 | rustc + cargo + clippy + rustfmt |
| Go | N, N−1 | Bootstrapped through the C chain |
| Python | 3.13, 3.14 | Exec-check patched (§4.5) |
| Node.js | LTS 22, 24 | Exec-check patched; JIT |
| OpenJDK | 21, 25 | JIT |
| .NET SDK | 9 | Tier 2 (non-reproducible until upstream fixes) |
| Zig | 0.15 | |
| Ruby | 3.4 | Exec-check patched |
| Perl | 5.42 | Exec-check patched |
| Lua / LuaJIT | 5.4 / 2.1 | Exec-check patched; LuaJIT JIT |
| PHP | 8.4 | Exec-check patched (CLI SAPI) |
| Erlang/OTP, Elixir | 28, 1.19 | Workbench images |
| GHC | 9.10 | Workbench images only |
| Build tools | CMake, Meson, Ninja, autoconf, automake, libtool, gettext, pkgconf, bison, flex, gperf, swig | |

#### 4.2.7 Developer CLI

git, git-lfs, gh, jq, yq, ripgrep, fd, fzf, bat, delta, helix, neovim, vim, emacs (nox), tmux, zellij, htop and btop (namespace-aware builds), rsync, openssh client (vault-backed agent socket), age, gnupg (vault-backed agent), sqlite CLI, postgres client, httpie, curl, wget2, shellcheck, hyperfine, just, direnv-equivalent `work` integration (from `bench`), and the keylos CLIs. Container tools (`podman`, `buildah`, `skopeo`) and `strace` ship only in workbench images, because the host baseline denies namespace creation and `ptrace` (protocols §9.1). Host debugging uses the **debugger generations** of §4.14, spawned only through `DebugAttach` under a time-limited `Right.debug` grant.

#### 4.2.8 Desktop libraries and toolkits

GTK 4 + libadwaita, GTK 3 (compat runtime), Qt 6 + a KDE Frameworks 6 subset, SDL3, Mesa (radeonsi, radv, iris, anv, nouveau/NVK, freedreno, panfrost, llvmpipe), Vulkan loader, libdrm, Wayland, wayland-protocols, xkeyboard-config, Xwayland (compat), GStreamer with plugins (good, bad, ugly-free), FFmpeg (LGPL build), libva drivers (intel-media-driver, mesa VA), fonts (Noto, Cantarell, Inter, JetBrains Mono, Adwaita fonts), icon themes, AccessKit, the a11y bridge.

#### 4.2.9 Desktop apps

| App | Tier | JIT | Runtime | Main `needs` | Notes |
|---|---|---|---|---|---|
| Firefox ESR and release | 1 | yes | gtk | network `*:80,443`, portals files/notify/screen/camera/mic/print/openuri, gpu render | default browser |
| Chromium | 1 | yes | gtk | as Firefox | |
| Thunderbird | 1 | yes | gtk | IMAP/SMTP hosts per account (granted at setup), portals | |
| LibreOffice | 1 | no | gtk | portal-files, portal-print | |
| GIMP, Inkscape, Krita | 1 | no | gtk / qt | portal-files, gpu render | |
| Blender | 1 | yes | — | gpu render, portal-files | Python + OSL JIT |
| darktable | 1 | no | gtk | portal-files, gpu render | |
| Kdenlive, OBS Studio | 1 | no | qt | portal-files, portal-screen (OBS), gpu render | |
| Audacity | 1 | no | gtk | portal-mic, portal-files | |
| mpv, VLC | 1 | no | media | portal-files, gpu render | |
| Papers (PDF), Loupe (images), Text editor, Calculator, Calendar, Contacts, Maps, Weather, Files | 1 | no | gtk | per app | atrium-integrated GNOME-style apps |
| KeePassXC | 1 | no | qt | vault (import), portal-files | |
| Signal Desktop | 2 | yes | electron | network to Signal hosts | upstream builds not reproducible |
| Element | 1 | yes | electron | homeserver host from setup | |
| Zed | 1 | no | — | gpu render, portal-files | |
| VS Code OSS | workbench app (3) | yes | electron | runs inside the project workbench VM with `display: true` (IDE decision, G5) | language servers, debuggers and test runners are unsealed code and stay in the VM |
| JetBrains IDEs (Community editions built from source) | workbench app (3) | yes | jvm | as VS Code | |
| Steam | 2 | yes | — | legacy image through `compat` | games run inside the VM |
| Installable web apps (`webapp` generations) | 1 | via runtime | browser-shell | network restricted to the origin | one generation per origin; see §4.3 and protocols §6.3 `webapp` |

#### 4.2.10 Language ecosystem parts

Vendored crates, wheels, npm packages and Go modules are imported by `forge` lockfile translators as `part` generations with `x-forge.src` (forge §4.10). They are shared across every recipe and project that pins the same version. `pkgs` lists the registries and mirrors allowed for them in `policy/source-hosts.ncl`.

#### 4.2.11 Kubernetes node

| Generation | Kind | Notes |
|---|---|---|
| `io.k8s.kubelet` (one per supported minor, e.g. 1.34, 1.35, 1.36) | `service`, tier 1 | Upstream `kubelet` built from source with the `keylos-mountless` patch set (REQ-PKGS-019); no root, no capabilities; `services.json` `network: "cluster"`; route `cri#kubelet`; `--container-runtime-endpoint=unix:///run/keylos/cri/cri.sock` (protocols §21.1) |
| `io.k8s.kube-proxy` (same minors) | `service`, tier 1 | nftables mode only; `CAP_NET_ADMIN` inside the cri network namespace only |
| `io.keylos.cri` | `service`, tier 0 | From the `cri` repository |
| `youki` | part | Rust OCI runtime, included in `io.keylos.bench.pod`; never installed on the host |
| `cni-none` | — | No CNI plugins are shipped: `cri` implements pod networking itself (protocols §21.5) |
| `crictl` | — | Not shipped: node administration uses `CriAdmin` through the `cri` CLI |

**`keylos-mountless` patch set** (per minor, REQ-PKGS-019): (1) `mount-utils` replaced by a recorder that never execs `mount`/`umount` and returns success; (2) the `configMap`, `secret`, `projected` and `downwardAPI` plugins write atomically (temp dir + rename, as upstream's atomic writer) into the plain volume directory instead of a tmpfs mount; (3) emptyDir, local, hostPath, NFS, iSCSI, RBD and CSI plugins become no-ops whose volume paths `cri` provides as `PodMount` trees or VM shares (protocols §21.6); (4) the kubelet's `--experimental-mounter-path`, `--containerized` style flags and the `nsenter` mounter are removed; (5) node status reports `volumes.kubernetes.io/controller-managed-attach-detach=true` so attach/detach stays in the control plane. The CI check `k8s-mountless` runs kubelet under a seccomp profile that kills on `mount`, `umount2`, `fsopen`, `move_mount` and `open_tree` while the node e2e volume subset passes.

The `server-k8s` profile config selects one Kubernetes minor; the other minors stay installable for upgrades. A minor is dropped from the stream 30 days after upstream end of life.

### 4.3 Runtimes

A runtime is a `runtime` generation mounted as `/usr` underneath an app's tree. Apps declare exactly one runtime or none.

| Runtime | Contents | Typical users |
|---|---|---|
| `io.keylos.runtime.base` | glibc, libstdc++, libgcc_s, OpenSSL, zlib-ng, libffi, CA certificates, tzdata, fontconfig base, keylos libc startup shim (mseal, MDWE), capwire client libraries | CLI tools |
| `io.keylos.runtime.gtk` | base + GTK 4, libadwaita, GLib, Pango, Cairo, Mesa client libraries, PipeWire client, capwire portal client, GStreamer core, AccessKit | GTK apps |
| `io.keylos.runtime.qt` | base + Qt 6 (Wayland platform only), KF6 subset, Mesa client libraries, portal client | Qt/KDE apps |
| `io.keylos.runtime.media` | gtk + FFmpeg, GStreamer plugins, codecs, libva | Media apps |
| `io.keylos.runtime.electron` | base + shared Chromium content libraries for Electron apps (JIT) | Electron apps |
| `io.keylos.runtime.python` | base + CPython 3.13 (exec-check), stdlib | Python apps |
| `io.keylos.runtime.node` | base + Node.js LTS (exec-check, JIT) | Node CLI apps |
| `io.keylos.runtime.jvm` | base + OpenJDK 21 runtime (JIT) | Java apps |
| `io.keylos.runtime.browser-shell` | gtk + a Chromium-based single-origin browser shell (`needs.jit` declared by this runtime), no extensions, no address bar, origin pinned from the webapp manifest | `webapp` generations (protocols §6.3) |

Runtime policy: each runtime has two supported major versions at any time; a runtime major lives at least 24 months; apps are rebuilt against the newest compatible runtime monthly; runtimes are GC'd by `depot` when no installed app references them.

### 4.4 Bench images and agent templates

| Bench image | `benchImage.purposes` | Contents | Typical `VmSpec.storeSet` passed by the caller |
|---|---|---|---|
| `io.keylos.build-vm` | `build` | Guest kernel, `forge-guest`, uutils coreutils, exec-check `dash`, `patch` | build inputs (forge §4.6) |
| `io.keylos.bootstrap-vm` | `build` | Guest kernel, `forge-guest`, bootstrap seed | none |
| `io.keylos.workbench-base` | `workbench` | Guest kernel, `benchd`, base userland | base runtime |
| `io.keylos.workbench-dev` | `workbench` | base + toolchains, debuggers, podman, Wayland client stack for workbench apps (IDEs with `display: true`) | toolchain parts, IDE generations |
| `io.keylos.app-vm` | `app` | Guest for tier-2 apps (Wayland cross-domain client, guest portal bridge on vsock 7004) | the app's runtime |
| `io.keylos.agent-vm` | `agent` | Guest for agent harnesses (`aide`) | base, Python and Node runtimes |
| `io.keylos.bench.agent-desktop` | `agentDesktop` (`desktop: true`) | agent-vm + a nested headless `atrium` session, AccessKit tree export and the apps the template lists, driven through `AgentDesktop` (protocols §14.5) | gtk runtime, listed apps |
| `io.keylos.bench.media` | `media` | Guest kernel with filesystem drivers (exFAT, NTFS3, FAT, ext4, btrfs, ISO 9660, UDF, F2FS), MTP (libmtp), `benchd` serving `MediaBrowser`; no network | none |
| `io.keylos.bench.pod` | `pod` | Guest kernel, `benchd` pod agent, `youki` (Rust OCI runtime), NFS/iSCSI/RBD clients, CSI node-plugin host | none (images are shared read-only from `cri`'s store) |
| `io.keylos.bench.captive-browser` | `captive` | Minimal Wayland session with Firefox in kiosk mode, no persistent profile | gtk runtime |

`io.keylos.bench.captive-browser` has no portals other than display and a launcher that opens the portal URL from its boot arguments (`bootArgs` key `captive.url`, REQ-PKGS-020); `net` starts the VM itself through `bench#net` when `atrium` calls `NetCaptive.signIn` (purpose `captive`, `display: true`) and attaches the captive token to the VM session. `io.keylos.bench.media` has no NIC and exports files read-only; writes happen only through `media.export`. All bench images are reproducible and release-signed.

| Agent template | Purpose |
|---|---|
| `io.keylos.agent.coding` | Reference coding harness (VM placement) |
| `io.keylos.agent.desktop` | GUI-operating agent (`vm.desktop: true`, image `io.keylos.bench.agent-desktop`) |
| `io.keylos.agent.research` | Read-mostly web research |
| `io.keylos.agent.ops` | System change proposals (`config#propose`) |
| `io.keylos.agent.minimal` | Bare harness for custom tools |

Agent templates are composed with forge's `agent` section; every tool, MCP server, prompt and policy digest is pinned per protocols §6.4. Changing any pinned digest produces a new template generation.

### 4.5 Interpreter exec-check patches

**Securebit model** (protocols §9.3): `warden` sets `SECBIT_EXEC_RESTRICT_FILE` and `SECBIT_EXEC_DENY_INTERACTIVE` on every host principal, **except** the process tree spawned through `TrustedSpawn.spawnTerminal` (the human's trusted terminal), which gets only `SECBIT_EXEC_RESTRICT_FILE`. Inside VMs (tiers 2 and 3) the guest kernel and guest policy apply; the patches behave the same and the securebits are normally unset there.

**Common behaviour** (all interpreters):

- **E1 (entry-file check).** When the interpreter is about to execute code from a file it opened itself (main script, a sourced, required or imported file, a startup file), it MUST open the file, call `execveat(fd, "", NULL, NULL, AT_EMPTY_PATH | AT_EXECVE_CHECK)`, and then read the code **from that same fd**.
- **E2 (restrict file).** If the check fails and `SECBIT_EXEC_RESTRICT_FILE` is set, the interpreter MUST refuse: exit status 126 for shells, or the language's error type, with the message `kl: execution of <path> denied by exec check`. If the bit is not set, the interpreter proceeds; the check still runs so the kernel records it.
- **E3 (deny interactive).** If `SECBIT_EXEC_DENY_INTERACTIVE` is set, the interpreter MUST refuse inline code flags (`-c`, `-e`, `-E`, `-p`, `--eval`), code from stdin, and interactive REPLs (exit status 126 / language error). In the trusted terminal tree this bit is not set, so the human's interactive shells and REPLs work there, while E1/E2 still forbid running unsealed script files.
- **E4 (no second read).** Patches MUST NOT re-open the file by path after a successful check and MUST NOT check one fd and read another.
- **E5 (residual).** Evaluation of strings built at runtime (`eval`, `exec(str)`, `Function()`, `load(string)`) is not covered; the residual is documented in the handbook.

Effective behaviour by context:

| Context | Signed script file | Unsigned script file (e.g. `/home/u/x.py`) | Inline code / stdin / REPL |
|---|---|---|---|
| Host principal (app, service, agent harness host-side tool) | runs | refused (E2) | refused (E3) |
| Trusted terminal tree (`shell` via `TrustedSpawn`) | runs | refused (E2) | runs |
| Workbench / tier-2 VM guest | runs | runs (bits unset in guest) | runs |

Per interpreter:

| Interpreter | Covered entry points (E1) | E3 inline/interactive | Mechanism |
|---|---|---|---|
| bash 5.3 | script argument, `source`/`.`, `BASH_ENV`, `--rcfile`, `~/.bashrc` and profile files | `-c`, stdin (`bash < f`, `bash -s`), interactive mode | patch in `shell.c` (`open_shell_script`), `builtins/source.def`, startup-file handling in `variables.c`/`shell.c` |
| dash 0.5.12 | script argument, `.`, `ENV` file | `-c`, stdin, interactive | patch in `main.c` (`setinputfile`) and the `.` builtin |
| CPython 3.13 / 3.14 | main script, `-m` module file, every `.py`/`.pyc` loaded by file-based loaders, `.pth` files, `PYTHONSTARTUP`, `sitecustomize`/`usercustomize` | `-c`, stdin, REPL, `-i` | a C `PyFile_SetOpenCodeHook` hook installed during `Py_Initialize` (PEP 578 `io.open_code`) that opens, checks (E1) and returns the file object; `pymain_run_python` patched for E3 |
| Perl 5.42 | script, `require`/`use`/`do FILE`, `-M`/`-m` modules, `PERL5OPT` modules | `-e`, `-E`, stdin, `perl -de0` | patch in `perl.c` (`open_script`) and `pp_ctl.c` (`S_doopen_pm`) |
| Ruby 3.4 | script, `require`/`require_relative`/`load`, `-r`, `RUBYOPT` libraries | `-e`, stdin; `irb` refuses under E3 | patch in `ruby.c` (`load_file`) and `load.c` (`rb_load_internal`) |
| Lua 5.4 / LuaJIT 2.1 | script, `dofile`, `loadfile`, `require` file searchers | `-e`, stdin, interactive | patch in `lua.c` and `lauxlib.c` (`luaL_loadfilex`) |
| Node.js LTS | main module, CommonJS `require` of files, ESM `import` of `file:` URLs, `--require`/`--import` preloads | `-e`, `-p`, stdin, REPL | patch in `lib/internal/modules/cjs/loader.js` and the ESM loader via a native binding `internalBinding('keylos').checkExec(fd)` called on the read path; reads use the checked fd |
| PHP 8.4 CLI | script, `include`/`require` of files, `auto_prepend_file` | `-r`, stdin, `-a` | patch in `main/fopen_wrappers.c` (`php_fopen_primary_script`) and the plain-files stream opener for includes |

Additional rules:
- `#!` scripts executed through `execve` are checked by the kernel already (`kl-exec` `bprm_check_security`); the patches cover direct invocation with a path.
- Direct loader invocation (`ld.so ./binary`) is covered by `kl-exec`: mapping a file executable from a superblock that is not registered fails in `mmap_file`.
- Tier-0 services run with `SECBIT_EXEC_DENY_INTERACTIVE`, so `system(3)`/`popen(3)` (which run `sh -c`) fail by design. Tier-0 parts MUST NOT shell out; CI greps for `system(`, `popen(` and `Command::new("sh")` in tier-0 sources and fails unless allowlisted.
- Patches are maintained as a series per interpreter under `parts/lang/<name>/patches/exec-check/`, with upstreaming status in `policy/exec-check-upstream.ncl`; when upstream adopts equivalent behaviour, the patch is dropped after CI shows equivalence.

### 4.6 OS profiles

| Profile | Contents beyond the common base | Target size (objects) |
|---|---|---|
| Common base (every profile) | Kernel and modules, firmware data generations, `kl-boot` parts, `warden`, `broker`, `ledger`, `vault`, `hearth`, `gate`, `net`, `depot`, `courier`, `strata`, `config`, `devd`, `journal`, `kish`, base runtime, CA bundle, tzdata, hwdb | — |
| `desktop` | `atrium`, `portals`, `bench`, `compat`, `aide`, `forge` (`forged`), PipeWire, BlueZ island, iwd island, fwupd island, gtk/qt/media runtimes, fonts, default apps (Firefox, Files, Text editor, Papers, Loupe, Calculator, Settings) | ≤ 3.5 GiB |
| `laptop` | desktop + power profiles, ModemManager island | ≤ 3.6 GiB |
| `server` | `bench` (workbenches for operations), `compat` (headless), `forge`, quorum-presence tooling | ≤ 900 MiB |
| `server-k8s` | `server` + `cri`, `kubelet`, `kube-proxy` (three Kubernetes minors as separate generations; config selects one), `io.keylos.bench.pod` | ≤ 1.1 GiB |
| `cloud` | `server` + cloud seed fetcher (metadata service client for the signed first-boot bundle), vTPM and confidential-VM attestation helpers, serial-console recovery prompt | ≤ 950 MiB |
| `kiosk` | Common base + `atrium` (kiosk mode), `portals`, the kiosk app; no `bench`, no `aide` | ≤ 1.5 GiB |
| `appliance` | Common base only plus the appliance's service generations; no `kish` on the console by default; no `bench` | ≤ 400 MiB |
| `installer` | `installer` live environment, `atrium` minimal, disk tools | ≤ 1.2 GiB |
| `recovery` | The recovery environment generation; `keylos` embeds it in **every** profile's UKI as the `recovery` profile (PCR11 phase `enter-recovery`). There is no separate recovery UKI and no `recovery` object in release statements (protocols §20.6) | ≤ 250 MiB |

Profiles are `os` compositions in `os/<profile>.ncl`; the `keylos` repository assembles UKIs and release statements from them.

### 4.7 JIT allowlist

`policy/jit.ncl` lists the generations allowed `needs.jit: true`: Firefox, Chromium, Thunderbird, the Electron runtime and apps built on it, the browser-shell runtime (webapps never declare JIT themselves), the JVM runtime and Java apps, the Node runtime, .NET apps (tier 2), LuaJIT-based apps, Wasmtime-embedding apps (Cranelift), Blender. Adding an entry needs security-team approval. Libraries that can run without JIT (PCRE2, regex engines, some interpreters) are built with JIT disabled.

### 4.8 Islands

Reused daemons that need D-Bus (BlueZ, fwupd, ModemManager, CUPS, SANE's `saned`-less backend host, iwd where its D-Bus API is used) are packaged as **islands**: a `service` generation containing the daemon, a private `dbus-broker` instance with a filtering policy that admits only the daemon and its adapter, and a keylos-native adapter that exposes the daemon's function through capwire to the owning keylos service (`devd` for BlueZ, `net` for iwd and ModemManager, `courier` for fwupd, `portals` for CUPS and SANE through `compat`'s `CompatIsland`). The SANE island (`io.keylos.island.sane`) contains `sane-backends` with the USB and network scanner backends, scans only devices `devd` authorized, and serves `portal-scan`; network scanners are reached through `net`'s local-link rules. The island manifest declares only the devices and sockets the daemon needs.

### 4.9 Tier-0 link budgets

`policy/tier0-links.ncl` maps each tier-0 service part to its allowed `DT_NEEDED` sonames. Rules:
- Compression and codec libraries are loaded with `dlopen` behind feature checks, never linked (xz lesson).
- Adding a soname needs two security-team approvals and a written justification.
- `pkgs-ci links` fails when a service part's ELF files need a soname outside its budget.

### 4.10 Streams, cadence and security response

| Stream | Content | OS releases | App updates |
|---|---|---|---|
| `stable` | Release branch `stable-YY.MM` | Monthly minor; yearly major (`YY.04`) | Weekly batch |
| `beta` | Next stable branch | Weekly | Weekly |
| `dev` | `main` | Daily | Daily |

A stable major is supported 18 months, overlapping the next by 6 months. Toolchain majors change only in yearly majors (except for security).

| Severity (CVSS v4 + exploitation) | Target to a fixed generation in `stable` | Mechanism |
|---|---|---|
| Critical, exploited, reachable from network or untrusted content | 24 h | Emergency graft (forge §4.12) if ABI-compatible, manifests `grafted: true`; full rebuild within 7 days |
| Critical, not exploited | 72 h | Full rebuild preferred; graft if the rebuild takes > 72 h |
| High | 7 days | Full rebuild |
| Medium / Low | Next weekly batch | Full rebuild |

Process:
1. **Intake:** `security@keylos.org` (published PGP and age keys), upstream notifications, coordinated-disclosure lists.
2. **Embargo:** work in a private fork with a private build cluster; private builds are not submitted to public logs before disclosure. At least `threshold` rebuilder operators get confidential access in advance; the realisation quorum is never skipped. On disclosure, rebuilders attest and the release is published.
3. **Advisory** `KLSA-YYYY-NNNN.ncl`: affected parts and versions, fixed generations, CVEs, graft status; published as a TUF target by release engineering and rendered on the website.
4. **Revocation:** objects that must never run again (for example exploited in the wild) are listed `evict` or `unlaunchable` in the stream's revocation list after the fix ships; the next release statement binds the list.

### 4.11 CI gates (`pkgs-ci`)

| Gate | Check |
|---|---|
| `eval` | Whole collection evaluates under forge limits |
| `lock` | `pkgs.lock` matches recipes; no unpinned fetch |
| `source-rules` | Tarball diffs justified; no unlisted blobs; regeneration rules |
| `build` | All changed derivations and dependents build for `x86_64-linux` and `aarch64-linux` |
| `repro` | Changed parts built on two CI builders with different CPU vendors; digests match (except listed non-reproducible apps) |
| `canon` | No setuid, file capabilities or devices; no build-path leaks |
| `manifest` | Manifests valid (protocols §6.3); kinds correct (`part` for intermediates); cmdsig present for each `PATH` command |
| `needs` | Smoke test under declared `needs` in the declared tier; minimality probe removes each declared access in turn and expects the smoke script to fail or degrade as documented |
| `links` | Tier-0 link budgets |
| `exec-check` | Interpreter conformance suite (§11.2) |
| `jit` | Only `policy/jit.ncl` generations declare JIT |
| `licenses` | SPDX ids valid; license compatibility for each composed generation |
| `size` | Profile size budgets (§4.6) |
| `graft-expiry` | No `x-forge.graft.expires` in the past for generations in the stream |
| `maintainer-signals` | Upstream health signals acknowledged (§4.12) |
| `islands` | Island bus policies admit only daemon and adapter |
| `kmod` | Every `kmod` composition: modules signed (trailer present), `kmod.kernel` matches a kernel part in the stream, paths limited to `/lib/modules/<kernel>/extra/` and `/lib/firmware/` |
| `kmod-coverage` | Every kernel release in the stream has a matching generation for every entry of `policy/kmods.ncl` |
| `bpf` | BPF ELF objects appear only under `/usr/lib/keylos/bpf/<service>/` in `os` generations and each is listed for its service in the default service table |
| `k8s` | kubelet/kube-proxy reproducible; each supported minor passes the CRI conformance smoke (`critest` subset) against `cri` in a CI VM |
| `bench-purpose` | Every bench image has a manifest `benchImage` section with non-empty `purposes` matching §4.4; `desktop: true` only on `io.keylos.bench.agent-desktop`; no bench image uses `x-pkgs.purpose` or `x-bench.*` fields |
| `k8s-mountless` | The `keylos-mountless` patch set applies without fuzz to every supported kubelet minor; kubelet passes the node e2e volume subset under a seccomp profile that kills on mount-family syscalls (REQ-PKGS-019) |

### 4.12 Maintainer rules and upstream health

- `MAINTAINERS.ncl` lists maintainers with keys, teams, areas and onboarding date. New maintainers have **elevated review** for 6 months: their changes need two approvals from established maintainers.
- `pkgs-ci upstream-watch` monitors each recipe's upstream for new maintainers with commit or release rights, release-process changes (tarball generation, CI changes, new binary files), ownership transfers and signing-key changes. A signal opens an issue that blocks version bumps of that recipe until two maintainers acknowledge it.
- Version bumps of recipes linked into tier-0 services or any `os` generation need an upstream diff review (`forge srcdiff --since <old>`) attached to the merge request.

### 4.13 Recipe conventions

| Topic | Rule |
|---|---|
| Part names | `part.<recipe>.<output>` in manifests; recipe names are lowercase `[a-z0-9-]+`, matching the upstream project name where possible |
| Categories | `parts/<category>/` with categories `bootstrap`, `core`, `libs`, `lang`, `devtools`, `desktop`, `media`, `net`, `system`, `fonts`, `ecosystem` |
| Outputs | `out` (runtime files), `dev` (headers, pkg-config, static libraries), `doc` (manuals), `debug` (split debug info, shipped only to workbench images and crash tooling) |
| Generation names | Launchable generations use reverse-DNS names (`org.mozilla.Firefox`, `io.keylos.runtime.gtk`); `io.keylos.` is reserved for project-built generations |
| Versions | Upstream version; keylos-specific rebuilds append `+kl<N>` (SemVer build metadata) |
| Patches | One concern per patch, `NNNN-<topic>.patch` with an upstream status header (`Upstream: submitted <url>` / `not-needed` / `keylos-only <reason>`) |
| Licences | Every recipe states SPDX ids; composed generations list the union in the SBOM |
| `meta.cpe` | Required for every part that has a CPE, so advisories match automatically |
| Maintainers | Every recipe names at least one maintainer team present in `MAINTAINERS.ncl` |

### 4.14 Debugger generations

| Generation | Tools | Scope |
|---|---|---|
| `io.keylos.debug.gdb` | gdb with the keylos pretty-printers | `process` |
| `io.keylos.debug.lldb` | lldb (Rust, C, C++) | `process` |
| `io.keylos.debug.perf` | `perf` (record, report, top, stat) | `process` (cgroup-scoped events) or `kernel` |
| `io.keylos.debug.bpftrace` | `bpftrace` with tracing program types only | `kernel` |

These generations are the default contents of the config list `debug.debuggers`. `warden`'s `DebugAttach` spawns them with seccomp profile `debug-1` after a presence-approved `Right.debug` grant (protocols §9.3); they are never on `PATH` and carry no `needs` of their own. `kish`'s `debug` builtin and atrium's debug UI are their only launchers. Debug symbols come from the `debug` outputs of parts, mounted read-only into the debugger's view by `warden`.

**Checklist for adding a package** (enforced by gates where possible): sources pinned and mirrored; tarball diff justified; regeneration chosen; blobs listed; outputs split; `disallowedStrings` clean; reproducible on two builders; for apps: tier, `needs`, cmdsig, smoke script, l10n; for tier-0 services: link budget; for JIT: allowlist entry approved.

---

## 5. Interfaces

### 5.1 Evaluation entry point

`default.ncl` exports:

```nickel
{
  parts : { _ : Recipe },
  runtimes : { _ : Compose },
  apps : { _ : Compose },
  services : { _ : Compose },
  os : { desktop : Compose, laptop : Compose, server : Compose, server-k8s : Compose, cloud : Compose, kiosk : Compose,
         appliance : Compose, installer : Compose, recovery : Compose },
  benchImages : { _ : Compose },
  kmods : { _ : { _ : Compose } },   # module set → kernel release → kmod composition
  cluster : { _ : Compose },          # kubelet and kube-proxy per minor, cri
  debuggers : { _ : Compose },
  islands : { _ : Compose },
  agentTemplates : { _ : Compose },
  legacyImages : { _ : Compose },
  data : { _ : Compose },
  deps : { _ : String },        # resolved part refs by name (filled during evaluation)
}
```

Targets are addressed as attribute paths: `parts.zlib`, `apps."org.mozilla.Firefox"`, `os.desktop`, `benchImages."io.keylos.bench.captive-browser"`.

### 5.2 CLI `pkgs-ci`

Exit codes: `0` pass, `1` gate failed, `2` usage, `6` unavailable.

| Command | Description |
|---|---|
| `pkgs-ci run [--gates G,…] [--changed-since REV]` | Run gates |
| `pkgs-ci affected <rev>` | List derivations affected by a change |
| `pkgs-ci candidates --stream S -o FILE` | Produce the `keylos.candidates/1` payload for rebuilders (signed by release engineering with `forge-sign`) |
| `pkgs-ci upstream-watch` | Run upstream health checks |
| `pkgs-ci advisory new` | Scaffold an advisory |
| `pkgs-ci graft-plan <advisory>` | Graft feasibility (ABI check) for affected generations |
| `pkgs-ci needs-probe <app>` | Run the minimality probe for one app |

### 5.3 Example compose recipes

App:

```nickel
let forge = import "forge/lib.ncl" in
{
  kind = 'app,
  name = "org.mozilla.Firefox",
  version = "143.0.1",
  runtime = runtimes."io.keylos.runtime.gtk".ref,
  parts = [ deps.firefox, deps.firefox-l10n ],
  manifest = {
    summary = "Web browser",
    tier = 1,
    entrypoints = { main = { exec = "/usr/lib/firefox/firefox", kind = 'gui } },
    needs = {
      jit = true,
      gpu = "render",
      network = [ { host = "*", ports = [80, 443], proto = "tcp", methods = ["*"], why = "Browsing" } ],
      services = ["portal-files", "portal-notify", "portal-screen", "portal-camera", "portal-mic", "portal-print", "portal-openuri"],
      secrets = [],
      dataUnits = ["profile"],
      labels = { readsUntrusted = true },
    },
    provides = { mimeTypes = ["text/html", "application/pdf"], uriSchemes = ["http", "https"] },
    l10n = { default = "en", languages = ["en", "de", "fr", "uk", "es", "pt", "ja", "zh"] },
    reproducible = true,
  },
} | forge.Compose
```

Bench image:

```nickel
{
  kind = 'bench-image,
  name = "io.keylos.bench.captive-browser",
  version = "1.0.0",
  parts = [ deps.guest-kernel, deps.guest-init, deps.firefox, deps.kiosk-session ],
  manifest = {
    summary = "Disposable browser for captive-portal sign-in",
    reproducible = true,
  },
  benchImage = { purposes = ['captive], desktop = false },
} | forge.Compose
```

The caller (`net`, through `bench#net`) passes the gtk runtime in `VmSpec.storeSet` and the portal URL in `VmSpec.bootArgs` (`captive.url`).

Kernel-module generation (composed on facet `release` from the signed module part, forge §4.17):

```nickel
{
  kind = 'kmod,
  name = "io.keylos.kmod.nvidia-open",
  version = "580.82.07+k7.2.4-keylos1",
  parts = [ deps."nvidia-open-modules-signed-7.2.4-keylos1" ],
  kmod = { kernel = "7.2.4-keylos1",
           modules = ["nvidia", "nvidia-modeset", "nvidia-drm", "nvidia-uvm"],
           firmware = ["nvidia/580.82.07/gsp_ga10x.bin", "nvidia/580.82.07/gsp_tu10x.bin"] },
  manifest = { summary = "NVIDIA open GPU kernel modules", reproducible = true },
} | forge.Compose
```

Installable web app:

```nickel
{
  kind = 'app,
  name = "com.example.Mail",
  version = "1.0.0",
  parts = [ deps.example-mail-icons ],
  webapp = { origin = "https://mail.example.com", name = "Example Mail",
             icons = ["/.keylos/icons/mail.svg"], browserRuntime = runtimes."io.keylos.runtime.browser-shell".ref },
  manifest = { summary = "Example Mail as an app", tier = 1, needs = { dataUnits = ["default"] }, reproducible = true },
} | forge.Compose
```

---

## 6. Security

| Threat | Control |
|---|---|
| Malicious upstream change (xz class) | Forge source rules, upstream-watch, elevated review, diff review for TCB packages |
| Malicious maintainer | Two-party review, signed commits, CODEOWNERS, reproducible builds verified by independent rebuilders |
| Over-broad app permissions | `needs` gate with minimality probe; manifest review; capability diff on update |
| Vulnerable code lingering | Advisories, revocation lists, graft expiry |
| Interpreter bypass of `kl-exec` | Exec-check patches with conformance tests; residual documented |
| D-Bus daemons with broad access | Islands with private buses and adapters |
| JIT as a code-integrity hole | Allowlist; JIT-capable libraries built without JIT when possible |
| Out-of-tree modules | Only release-signed `kmod` generations from reviewed recipes; `kmod-coverage` keeps them in step with kernels |
| BPF programs as hidden kernel code | Only `os`-generation objects under `/usr/lib/keylos/bpf/<service>/`, built from source, loaded by `warden` |
| Debuggers as an escalation path | Separate generations, never on `PATH`, spawned only by `DebugAttach` with a presence-approved, time-limited grant |
| Removable media parsers | Filesystem drivers for removable media run only inside `io.keylos.bench.media` |

Residual: string evaluation in interpreters; JIT apps; non-reproducible apps (tier 2 only); reviewer fatigue.

---

## 7. Failure modes and recovery

| Failure | Response |
|---|---|
| Upstream source disappears | Project source mirror (`sources.keylos.org`) keeps every pinned source; digests make mirrors trustless |
| Recipe becomes non-reproducible | `repro` gate fails; maintainers fix it, or (apps only) add a time-limited exception with tier 2 |
| Rebuilder disagreement | Release blocked; mismatch report investigated |
| Graft expiry reached | Stream CI red; release managers ship the rebuild or extend once with security-team approval (max +14 days) |
| Interpreter upstream changes break a patch | `exec-check` gate fails; the version bump waits for a ported patch |

---

## 8. Performance budgets

| Item | Budget |
|---|---|
| Full collection rebuild on the project cluster (256 cores) | ≤ 36 h |
| Typical merge-request CI (changed leaf app) | ≤ 30 min |
| Security graft pipeline (intake → signed generation) | ≤ 6 h |
| Desktop OS generation size | ≤ 3.5 GiB objects |
| Server OS generation size | ≤ 900 MiB objects |
| Captive-browser VM cold start | ≤ 2 s to a rendered page |
| Media VM ready (device authorized → files listed) | ≤ 3 s |
| `server-k8s` OS generation size | ≤ 1.1 GiB objects |

---

## 9. Observability

- Public dashboards: reproducibility per stream, rebuilder quorum lag, open advisories, graft count and age, exec-check conformance, `needs` probe results.
- CI emits JSON reports per gate; release commits archive them.
- Receipts: none (pkgs is a repository, not a machine service).

---

## 10. Configuration

`ci/config.ncl`:

```nickel
{
  ci | {
    systems | Array String | default = ["x86_64-linux", "aarch64-linux"],
    reproBuilders | Array String,           # CI builder pools with distinct CPU vendors
    smokeTimeoutSecs | Number | default = 120,
    sizeBudgets | { desktop | Number, laptop | Number, server | Number, server-k8s | Number, cloud | Number, kiosk | Number,
                    appliance | Number, installer | Number, recovery | Number },
    kubernetesMinors | Array String | default = ["1.34", "1.35", "1.36"],
    graftMaxDays | Number | default = 30,
    elevatedReviewMonths | Number | default = 6,
  }
}
```

---

## 11. Testing and acceptance

### 11.1 Collection tests

- Evaluate, build and boot every OS profile in CI VMs; the boot test asserts: `kl-exec` loaded with `kl_exec_policy.enforce = 1`; IPE policy active; `vm.memfd_noexec = 2`; every tier-0 service running; an unsigned binary copied to `/home` fails to execute; the captive-browser image boots and renders a test portal.
- `server-k8s`: the node joins a test cluster (kind-style control plane in a CI VM), runs a `keylos-vm` pod and a `keylos-sealed` pod (org-signed test container generation) and passes the `critest` subset for each supported minor; a pod with configMap, secret and emptyDir volumes starts while `kubelet` runs under the mount-kill seccomp profile (REQ-PKGS-019).
- Captive portal: `NetCaptive.signIn` in a CI VM with a fake captive network starts `io.keylos.bench.captive-browser`, which opens exactly the `captive.url` boot argument; a URL injected through any other channel is ignored (REQ-PKGS-020).
- Bench images: `bench.start` with a purpose not listed in an image's `benchImage.purposes` fails with `kl:invalid` for every shipped bench image (REQ-PKGS-018).
- `kmod`: on the NVIDIA CI runner, `io.keylos.kmod.nvidia-open` for the booted kernel loads under `module.sig_enforce=1`; a modified `.ko` fails to load.
- Media VM: a USB mass-storage test image with exFAT and NTFS partitions is browsed through `MediaBrowser`; the host never mounts it.
- Agent desktop: `io.keylos.agent.desktop` drives a test app through `AgentDesktop`; the human mirror is read-only until take-over.
- Debuggers: `gdb` attaches to a test app only after a `Right.debug` grant and is detached at expiry.
- Core dumps: a crashing tier-1 app produces a confidential core through `/usr/lib/keylos/journal/coredump`; the helper leaves the root cgroup within 1 s.

### 11.2 Interpreter conformance suite (`tests/exec-check/`)

For each interpreter, in a CI VM with an unsigned file `/home/u/x.<ext>` and a signed file inside a sealed test generation:

| Case | No securebits | RESTRICT_FILE only (trusted terminal) | RESTRICT_FILE + DENY_INTERACTIVE (host principal) |
|---|---|---|---|
| Run signed script by path | runs | runs | runs |
| Run unsigned script by path | runs | refused 126 | refused 126 |
| Source/require/import unsigned file from a signed script | runs | refused | refused |
| Inline code flag | runs | runs | refused |
| Code on stdin | runs | runs | refused |
| REPL | starts | starts | refused |
| Replace the file between check and read (race harness) | n/a | never executes replaced content | never executes replaced content |

### 11.3 Acceptance

- 100 % of `os`, `runtime`, tier-0 `service` and `bench-image` parts reproducible with quorum.
- ≥ 98 % of all recipes reproducible.
- Every app passes smoke and minimality under its declared `needs`.
- The suite of §11.2 passes for every interpreter on x86-64 and aarch64.

---

## 12. Implementation notes

- `pkgs-ci` is a Rust binary built from `ci/pkgs-ci`, using `keylos-recipe`, `keylos-drv`, `keylos-canon`, `keylos-tlog-client`, `goblin` (ELF), `gix`.
- Interpreter patches are unified diffs in quilt-style series files; every patch has a test in `tests/exec-check/`.
- The build cluster and rebuilders run the keylos `server` profile.

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reference |
|---|---|---|
| Curated, reproducible-first collection | Import a large existing collection wholesale | [ADR-0043](../../handbook/11-decisions/adr-0043-non-reproducible-means-tier-2.md) |
| Interpreter exec-check patches carried by keylos, with the trusted-terminal split | Wait for upstream; strip interpreters | [ADR-0008](../../handbook/11-decisions/adr-0008-host-executes-only-sealed-code.md) |
| Grafts only for exploited criticals, flagged and expiring | Grafts as routine updates | [ADR-0018](../../handbook/11-decisions/adr-0018-grafts-are-temporary.md) |
| D-Bus islands for reused daemons | System bus; rewrite daemons | [ADR-0035](../../handbook/11-decisions/adr-0035-fd-only-portals-dbus-islands.md) |
| Source rules and upstream health monitoring | Trust the upstream release process | [ADR-0019](../../handbook/11-decisions/adr-0019-source-rules-after-xz.md) |
| Shared vendored ecosystems | Per-app vendoring without dedup | [ADR-0042](../../handbook/11-decisions/adr-0042-one-store-for-language-ecosystems.md) |
| Container tools only in workbench images; host debuggers only as `DebugAttach` generations | Host debugging capabilities without grants | [ADR-0049](../../handbook/11-decisions/adr-0049-debug-capability.md) |
| NVIDIA and other out-of-tree modules only as release-signed `kmod` generations | DKMS; owner-signed modules | [ADR-0057](../../handbook/11-decisions/adr-0057-oot-modules-project-signed-only.md) |
| Upstream kubelet and kube-proxy as sealed tier-1 services; pods in microVMs by default | Running kubelet as root with containerd/runc | [ADR-0047](../../handbook/11-decisions/adr-0047-cri-microvm-pods.md) |
| IDEs as workbench apps | IDEs on the host with debuggers and language servers | [ADR-0050](../../handbook/11-decisions/adr-0050-ides-in-workbenches.md) |
| Agent desktops as a separate bench image | Agents driving the human's session | [ADR-0051](../../handbook/11-decisions/adr-0051-agent-desktops.md) |
| Removable-media filesystems only in the media bench image | Host automount | [ADR-0052](../../handbook/11-decisions/adr-0052-usb-authorization-and-media-bench.md) |
| Webapps on a pinned browser-shell runtime | Web origins as general OS principals | [ADR-0055](../../handbook/11-decisions/adr-0055-webapps.md) |
