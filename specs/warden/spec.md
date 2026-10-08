# keylos/warden: PID 1 and the supervisor

| | |
|---|---|
| Repository | `github.com/keylos-os/warden` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | Binaries `warden` (PID 1 core), `warden-supervisor`, `warden-spawner`, and the `warden` CLI (the same multicall binary as the core, selected by `argv[0]`). Seccomp profile compiler output `profiles/baseline-1.bpf.{x86_64,aarch64}` (generated at build time). Repo-local schema `schema/warden-local.capnp` (core ↔ supervisor diagnostics only) |
| Depends on | `keylos-protocols 1.0` (crates `keylos-ids`, `keylos-formats`, `keylos-presence`, `keylos-capwire`, `keylos-schemas`, `keylos-labels`, `keylos-tpm-registry`). Runtime services reached over capwire: `depot`, `broker`, `ledger`, `journal`, `strata`, `net`, `devd`, `gate` |
| Provides | `Supervisor` (protocols §7.3.2); every interface of `warden-sys.capnp` (protocols §7.5.1): `Bootstrap`, `ServiceHost` (as client), `GrantMounts`, `PrincipalControl`, `ServiceConnect`, `FdStore`, `LegacySpawn`, `UserSpawn`, `TrustedSpawn`, `DebugAttach`, `PodSpawn`; the confinement contract (protocols §9.1, §9.2, §9.4, §9.5 host side); `kl-exec` map maintenance including `kl_debug_pairs` (protocols §9.3); service BPF loading (protocols §9.3); PCR11 phases `sysinit` and `ready` (protocols §19.6); the principal ↔ (UID, cgroup) mapping |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`warden` is the first userspace process of a running keylos system. It is the only component that creates processes outside a principal's own confinement, namespaces, cgroups, mounts in principal views, and user IDs. It:

1. Receives control from the initrd (`boot`) as PID 1 after `switch_root`, mounts the bootstrap generations, starts tier-0 services in dependency order, and reaps every orphan.
2. Spawns every principal process from a **SpawnSpec**: a sealed generation, an explicit fd table, capability tokens registered with `broker`, a tier and limits. Nothing is inherited implicitly.
3. Applies the **confinement baseline** (protocols §9.1) to every process except itself: dynamic UID, own cgroup, namespaces created without a user namespace, a mount view built with the new mount API, Landlock, seccomp, securebits, `no_new_privs`.
4. Wires **routes** (protocols §7.2): creates the capwire socket pairs between principals and services, hands server ends to services through `ServiceHost.accept` and client ends to clients.
5. Maintains the authoritative **principal registry**: which running process (pidfd, cgroup, UID) belongs to which principal. It answers `Supervisor.identify` and publishes principal lifecycle events.
6. Attaches **runtime grant mounts** (`GrantMounts`) and **transaction views** (`SpawnSpec.transaction`) into principals' mount namespaces.
7. Maintains the `kl-exec` maps: it registers verified generation mounts, JIT cgroups and time-limited **debug pairs** (`DebugAttach`).
8. Loads the BPF programs that tier-0 services declare in `services.json` from the OS generation and hands their map fds to the services.
9. Spawns **sealed pod containers** for `cri` (`PodSpawn`) and the per-VM host processes of `bench` as the VM principal.
10. Extends PCR11 with the `sysinit` and `ready` boot phases, in the order of protocols §19.6.
11. Supervises tier-0 services (restart, health, ordering) and exposes service status for boot assessment by `courier`.
12. Shuts the system down cleanly.

**Non-goals:**
- **Authorisation decisions.** `broker` decides; `warden` enforces what `broker`, the config generation and manifests say.
- **Running microVMs.** Tier-2 and tier-3 workloads are started through `bench` by their requesters. `warden` refuses to start them on the host (REQ-WARDEN-005). `bench`'s own VMM and device-backend processes are spawned by `warden` like any other principal.
- **Building legacy views.** `compat` supplies the view description; `warden` builds the user namespace and mounts (§4.10).
- **Log storage** (`journal`), **device policy** (`devd`), **time synchronisation** (`net`), **transaction semantics** (`strata`).

---

## 2. Context and embedded contracts

`warden` sits directly above the kernel. Every other userspace component is its descendant.

```
boot (initrd) ──switch_root──► warden (PID 1 core)
                                  ├── warden-supervisor   (capwire server; process lifecycle policy)
                                  ├── warden-spawner      (single-threaded clone3 executor)
                                  └── every principal process (tier-0 services, apps, shells, VMM processes)
```

The contracts below are copied **verbatim** from `keylos/protocols` 1.0.0 (final). Section numbers and cross-references inside the excerpts (for example "§9.4") refer to protocols. If an excerpt differs from protocols, protocols wins.

### 2.1 Platform baseline (protocols §2)

| Item | Requirement |
|---|---|
| Architectures | x86-64 (x86-64-v2 minimum) and aarch64 (ARMv8.2+). Both are tier-1. |
| Firmware | UEFI 2.7+ with Secure Boot capable of custom keys, and TPM 2.0 (firmware or discrete, rev ≥ 1.38, which `PolicyAuthorizeNV` requires). Machines without a TPM can only run the `degraded` integrity profile. |
| Kernel | Linux ≥ 6.18 (LTS floor). The shipped kernel targets the current stable series (7.x). Features are detected at runtime; see §2.1. |
| Socket buffers | `net.core.wmem_max` and `net.core.rmem_max` ≥ 4 259 840 (4 MiB + 64 KiB), so capwire datagrams of 4 MiB fit (§7.1). |
| Kernel lockdown | `lockdown=integrity` at minimum. Consequently **hibernation is unsupported** on every profile (lockdown refuses it). Suspend-to-RAM is supported. |
| Virtualization | KVM required for workbench and tier-2 VMs. Without KVM, those workloads refuse to run; they never silently downgrade. |
| IOMMU | Required on every profile except `degraded`. Kernel command line `iommu=force` plus `intel_iommu=on` or `amd_iommu=force_isolation`; Thunderbolt/USB4 security level `secure` or `user`. Without an active IOMMU, external PCIe/Thunderbolt devices are never authorized (§9.5). On the `cloud` profile, a virtio-only instance type without an emulated IOMMU is accepted and recorded as `"iommu": "none-virtual"` in the boot report (§20.1): such instances expose no external DMA-capable bus, and VFIO passthrough and external device authorization are unavailable on them. |
| Implementation language | Rust (edition 2024, MSRV published per release) for every trusted-computing-base component. New C code MUST NOT be added to the TCB. Reused C components MUST run confined (tier 0 with a dedicated policy). |

**protocols §2.1 Kernel feature levels**

Components MUST probe for features and MUST pick behaviour by **feature level**, not by kernel version string.

| Level | Required kernel features | Typical kernel |
|---|---|---|
| `KL1` | Landlock ABI ≥ 7, BPF LSM (`lsm=` includes `bpf`), IPE, fs-verity, overlayfs `verity=require`, pidfd (`CLONE_PIDFD`, `pidfd_getfd`, `SO_PEERPIDFD`), `openat2`, new mount API, `MOVE_MOUNT_BENEATH`, idmapped mounts, `AT_EXECVE_CHECK`, `memfd_secret`, `mseal`, cgroup v2 (`cgroup.freeze`, `cgroup.kill`) | 6.18 |
| `KL2` | KL1 + Landlock ABI ≥ 9 (`FS_RESOLVE_UNIX`, `RESTRICT_SELF_TSYNC`) | 7.1 |
| `KL3` | KL2 + Landlock ABI ≥ 10 (UDP rules) | 7.2 |

On KL1 and KL2 there are no Landlock rules for pathname unix sockets or UDP. Components MUST compensate: the sandbox gets a private network namespace with only `lo`, and egress goes through `gate`; the mount view gives no access to pathname sockets. That compensation MUST be recorded in the process's confinement report (§9.4).

The LSM order on the kernel command line is `lsm=landlock,lockdown,yama,ipe,bpf`.

**protocols §2.2 Profiles and integrity profiles**

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

**protocols §2.3 Resource classes**

`bench` admission control and memory tuning follow the machine's **RAM class** (detected at boot, overridable in config):

| RAM | Class | Max concurrent VMs (workbench, agent, tier-2, media, pod) | Defaults |
|---|---|---|---|
| < 12 GiB | `small` | 2 | zram swap (ephemeral key), KSM on, compressed snapshots, agents queue |
| 12–24 GiB | `medium` | 6 | KSM on, free-page reporting |
| > 24 GiB | `large` | 16 | free-page reporting |

`server-k8s` nodes are exempt from the VM cap for pod VMs; kubelet `maxPods` bounds them instead. When the cap is reached, new agent sessions queue (`aide`), and other VM requests fail with `kl:unavailable`.

### 2.2 Principal identifiers (protocols §3.4)

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

### 2.3 Other identifiers (protocols §3.5)

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

### 2.4 Signed documents (protocols §5.1)

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

### 2.5 Presence signatures (protocols §5.3)

`warden` verifies owner exception records (§2.20), which are presence-signed, with `keylos-presence`.

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

### 2.6 Generation manifest (protocols §6.3)

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

### 2.7 capwire model (protocols §7.1)

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

### 2.8 Routes and facets (protocols §7.2)

`warden` wires services according to **routes** declared in service and app manifests plus policy.

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

- A **facet** is a server-defined restriction name. The registry of every facet, its holders and the methods it allows is §19.2. Servers MUST refuse methods their facet doesn't allow with `kl:denied`.
- Route references are written `service#facet` (for example `vault#app`).
- The server learns the facet of each connection from `ServiceHost.accept` (§7.5.1) or `Supervisor.connectionInfo`.
- Service sockets live under `/run/keylos/svc/<service>/` with mode `0700`, owned by `warden`'s UID. No other principal can `connect()` to them. Connections are created by `warden` (`socketpair` + hand-off through `ServiceHost.accept`).
- Dynamic routes (a service capability granted at runtime) are materialised by `broker` through `ServiceConnect.connectService` (§7.5.1).

### 2.9 `common.capnp` and errors (protocols §7.3.1)

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

### 2.10 `warden.capnp` (protocols §7.3.2, implemented by this repo)

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

### 2.11 Versioning (protocols §7.4)

- Schemas evolve only by Cap'n Proto-compatible additions: new fields, new methods, new enumerants.
- Removal or renumbering needs a new file ID and a protocols major version.
- Every bootstrap capability implements `common.Extensible`; `version()` returns `(protocols, implementation)` version strings.
- Repo-local schemas (used only by a repository's own binaries) MUST use file IDs generated with `capnp id` outside the `0xc7a1e5d3b2f4xxxx` range reserved for this repository.

### 2.12 `warden-sys.capnp` (protocols §7.5.1, implemented by this repo)

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

### 2.13 Consumed interfaces

`warden` is a client of the following interfaces. Only the listed methods are called.

| Interface (protocols §) | Facet held by warden | Methods called |
|---|---|---|
| `BrokerSystem` (§7.5.2) | `broker#system` | `registerSession`, `sessionEnded`, `revokeSession` |
| `Broker` (§7.3.3) | `broker#system` (includes `Broker.inspect`) | `inspect` (VM principal parent resolution, §4.11, and diagnostics) |
| `LabelAuthority` (§7.5.2) | `broker#label-authority` | `labelOf` (for `ConnectionInfo.label`) |
| `Depot` (§7.3.8) | `depot#mounter` | `get`, `list` (kmod selection), `mount`, `root`, `unroot` |
| `Ledger` (§7.3.5) | `ledger#writer` | `append` |
| `LedgerAdmin` (§7.5.5) | `ledger#time` | `timeFloor` |
| `JournalWarden` (§7.5.9) | `journal#warden` | `attach`, `heartbeats` |
| `StrataTxn`, `TransactionExt` (§7.5.7), `Transaction` (§7.3.10) | `strata#warden` | `txnExt`, `TransactionExt.policy`, `TransactionExt.owner`, `Transaction.id`, `Transaction.view`; `StrataAdmin.mountUnit` |
| `NetPlumbing` (§7.5.11) | `net#plumbing` | `setEgressUids`, `setLocalLinkUids` |
| `DeviceAdmin` (§7.5.8) | `devd#warden` | `plan`, `revoke` |
| `GateDebug` (§7.5.12) | `gate#debug` | `interception` (confinement report) |
| `ServiceHost` (§7.5.1) | (implemented by every service) | `accept`, `stop`, `reload` |
| TPM (`/dev/tpmrm0`, not capwire) | — | `TPM2_PCR_Extend` of PCR11 for the phases `sysinit` and `ready` (§4.12) |

#### 2.13.1 `broker.capnp` (protocols §7.3.3)

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

#### 2.13.2 `broker-sys.capnp` (protocols §7.5.2)

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

#### 2.13.3 `ledger.capnp` (protocols §7.3.5)

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

#### 2.13.4 `ledger-sys.capnp` (protocols §7.5.5)

```capnp
@0xc7a1e5d3b2f40024;
using C = import "common.capnp";
using L = import "ledger.capnp";

interface LedgerWitness {          # facet witness (vouch, fleet)
  pending        @0 (afterTreeSize :UInt64) -> (checkpoint :L.Checkpoint, consistency :List(Data), fromSize :UInt64);
  addCosignature @1 (treeSize :UInt64, cosignatureLine :Text) -> ();
}

interface LedgerAdmin {            # facet admin (owner shell, warden for timeFloor)
  export           @0 (filterJson :Text, out :C.Fd) -> (bytes :UInt64);
  resetWriter      @1 (service :Text, presenceEnvelope :Data) -> ();
  timeFloor        @2 () -> (time :C.Timestamp);
  status           @3 () -> (json :Text);
  acknowledgeAlarm @4 (alarmId :Text, presenceEnvelope :Data) -> ();
  shred            @5 (human :Text, month :Text, presenceEnvelope :Data) -> (receipts :UInt64);
      #! month "YYYY-MM": destroys the ledger unit key ledger:<human>:<month> through vault.forget; writes ledger.shred.
      #! Without presence only months older than the configured retention (default 13) may be shredded (automatic job)
}
```

`timeFloor` is also served on facet `time` (net, warden). On facet `fleet-export`, `export` returns metadata-only receipts (sealed payloads omitted) unless an owner exception of kind `fleet-receipt-access` (§20.9) covers the event type.

#### 2.13.5 `depot.capnp` (protocols §7.3.8)

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

#### 2.13.6 `strata.capnp` (protocols §7.3.10)

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

#### 2.13.7 `strata-sys.capnp` (protocols §7.5.7)

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

#### 2.13.8 `devd-sys.capnp` (protocols §7.5.8)

```capnp
@0xc7a1e5d3b2f40027;
using C = import "common.capnp";

struct NodePlan {
  id @0 :Text; name @1 :Text; kind @2 :Kind; major @3 :UInt32; minor @4 :UInt32;
  enum Kind { char @0; block @1; }
}

struct PendingDevice {
  device    @0 :Text;              # dev:… id
  bus       @1 :Text;              # "usb" | "thunderbolt" | "pci"
  vendor    @2 :UInt16;
  product   @3 :UInt16;
  serial    @4 :Text;
  port      @5 :Text;              # physical port path
  classes   @6 :List(Text);        # interface classes, e.g. "hid", "mass-storage", "audio", "fido", "net"
  name      @7 :Text;              # descriptor strings, untrusted (rendered as untrusted text)
  hidSafety @8 :Text;              # "none" | "keyboard-like" (requires confirmation with an already-authorized input device)
}

interface DeviceAdmin {            # facets warden, broker (plan, revoke); authorize (atrium: authorize, deauthorize, pending)
  plan   @0 (principal :C.PrincipalId, tokens :List(C.Token)) -> (nodes :List(NodePlan));
  revoke @1 (rootId :Data) -> ();
  authorize   @2 (device :Text, persist :Bool, decisionEnvelope :Data) -> ();
      #! sets the kernel authorized flag (USB) or approves the Thunderbolt/USB4 domain; decisionEnvelope is the mandate
      #! atrium obtained through BrokerSystem.requestFor (resource device, §14.4): devd verifies only the service/broker
      #! or owner-presence signature and the device id; persist stores the identity (vendor, product, serial, port)
  deauthorize @3 (device :Text, forget :Bool) -> ();
  pending     @4 (watcher :C.Watcher(PendingDevice)) -> (cancel :C.Cancelable);
}

interface MediaAttach {            # facets bench, cri
  claimBlock @0 (device :Text, readOnly :Bool) -> (fd :C.Fd, info :Text);
      #! fd of the whole authorized removable block device for a media or pod VM; the host never mounts it (§9.5);
      #! info = JSON {sizeBytes, model, removable, partitions}
  claimVfio  @1 (pciAddress :Text) -> (groupFd :C.Fd, deviceFd :C.Fd);
      #! binds the device to vfio-pci (it must be listed for passthrough in config); the host driver is unbound
  release    @2 (device :Text) -> ();
}

struct PowerEvent { union { preSleep @0 :Text; postResume @1 :Text; battery @2 :Text; sensor @3 :Text; lid @4 :Bool; } }

interface PowerEvents {            # facet client (events), service (subscribe + ack: hearth, strata, atrium)
  subscribe @0 (watcher :C.Watcher(PowerEvent)) -> (cancel :C.Cancelable);
  ack       @1 (op :Text) -> ();
}

struct BtDevice { address @0 :Text; name @1 :Text; paired @2 :Bool; connected @3 :Bool; kind @4 :Text; battery @5 :Int8; }

interface Bluetooth {              # facet admin
  power      @0 (on :Bool) -> ();
  scan       @1 (watcher :C.Watcher(BtDevice)) -> (cancel :C.Cancelable);
  pair       @2 (address :Text) -> ();             # confirmation on the trusted path
  connect    @3 (address :Text) -> ();
  disconnect @4 (address :Text) -> ();
  forget     @5 (address :Text) -> ();
  devices    @6 () -> (list :List(BtDevice));
}

interface Backlight {              # facet atrium
  list @0 () -> (devices :List(Text));
  set  @1 (device :Text, permille :UInt16) -> ();
  get  @2 (device :Text) -> (permille :UInt16);
}
```

#### 2.13.9 `journal-sys.capnp` (protocols §7.5.9)

```capnp
@0xc7a1e5d3b2f40028;
using C = import "common.capnp";

interface JournalWarden {          # facet warden
  attach     @0 (principal :C.PrincipalId, session :C.SessionId, stream :C.Fd) -> ();   # journal-side end; warden keeps a dup
  heartbeats @1 (watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);   # service names emitting watchdog records
}

struct CrashInfo { id @0 :Text; principal @1 :C.PrincipalId; generation @2 :C.Ref; signal @3 :Int32;
                   time @4 :C.Timestamp; backtrace @5 :Text; coreKept @6 :Bool; }

interface Crashes {                # facets client (own human), admin
  list    @0 (limit :UInt32) -> (list :List(CrashInfo));
  core    @1 (id :Text) -> (core :C.Fd);         # decrypted core as sealed memfd; raises the reader's label to the crash's label
  forget  @2 (id :Text) -> ();
  setKeep @3 (generationName :Text, keep :Bool) -> ();
}

interface Metrics {                # facets client (own principals), admin, fleet
  scrape @0 (filterJson :Text) -> (openMetrics :Text);
}
```

#### 2.13.10 `net-sys.capnp` (protocols §7.5.11)

```capnp
@0xc7a1e5d3b2f4002a;
using C = import "common.capnp";

struct NetEvent {
  union {
    linkChanged      @0 :Text;      # JSON Link
    timeTrusted      @1 :Bool;
    captive          @2 :Bool;
    metered          @3 :Bool;
    vpnChanged       @4 :Text;      # JSON {profile, up}
    resolverInsecure @5 :Text;      # upstream id
  }
}

interface NetWatch {               # facets user, status, resolver, captive
  watch @0 (watcher :C.Watcher(NetEvent)) -> (cancel :C.Cancelable);
}

interface NetResolver {            # facet resolver (gate, tier-0 services)
  query @0 (wire :Data) -> (wire :Data, secure :Bool);   # RFC 1035 wire format, one question
}

struct ListenPort {
  port  @0 :UInt16;
  proto @1 :Proto;
  scope @2 :Scope;
  enum Proto { tcp @0; udp @1; }
  enum Scope { loopback @0; lan @1; any @2; }
}

interface NetPlumbing {            # facet plumbing
  setEgressUids    @0 (uids :List(UInt32)) -> ();                         # warden: UIDs allowed host-netns egress (gate, net helpers)
  setListenPorts   @1 (tcp :List(UInt16), udp :List(UInt16), ports :List(ListenPort)) -> ();
      #! gate: subset of config listenPorts; when ports is non-empty it supersedes tcp/udp (which then MUST be empty)
      #! and carries each port's scope (needs.listen scope, §6.3)
  setLocalLinkUids @2 (uids :List(UInt32)) -> ();                         # warden: UIDs allowed mDNS/IPP on local links (portal-print)
}

interface NetCaptive {             # facet captive (atrium)
  status @0 () -> (captive :Bool, ssid :Text, portalUrl :Text);
  admit  @1 (vmUid :UInt32) -> ();  #! superseded before release: MUST return kl:unsupported
  admitSession @2 (vmSession :C.SessionId) -> (expires :C.Timestamp);   #! superseded before release: MUST return kl:unsupported; use signIn
  portalUrl    @3 () -> (url :Text);  # the detected portal URL
  signIn       @4 () -> (expires :C.Timestamp);
      #! atrium ("Sign in to network"): net starts the captive VM itself through bench#net (purpose captive, image
      #! io.keylos.bench.captive-browser, display true, bootArgs captive.url), reads its session and cgroup with Vm.info,
      #! mints the captive token (BrokerSystem.mintCaptive), which the broker attaches to the VM session (bench-net reads it
      #! with Broker.myGrants), and allows that VM's bench-net direct egress on tcp/80, tcp/443 and udp+tcp/53 for at most
      #! 600 s while the network is captive. The window appears through atrium's Display like any tier-3 VM
  endSignIn    @5 () -> ();
      #! atrium (sign-in window closed): net stops the captive VM (Vm.stop) and revokes its direct egress immediately
}

interface NetPlumbingCluster {     # facet plumbing (clusterUplink: cri; clusterNetns: warden)
  clusterUplink @0 (configJson :Text) -> (netns :C.Fd);
      #! configJson is keylos.cri.uplink/1 (§21.5): op "uplink" configures the cri network namespace (pod CIDR routes,
      #! NAT, overlay) and returns it; op "podNetns" creates a pod network namespace attached to the cri bridge and
      #! returns it; op "release" deletes a pod namespace. cri holds CAP_NET_ADMIN only inside the cri namespace
  clusterNetns  @1 () -> (netns :C.Fd);
      #! warden: the cri network namespace, created by net at its own start on server-k8s from config cluster.*;
      #! warden starts services with services.json network "cluster" (crid, kubelet, kube-proxy) inside it
}

interface NetDiscovery {           # facet discovery (portal-discovery)
  browse  @0 (serviceType :Text, onLink :Text, watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);   # JSON ServiceInstance
  publish @1 (instance :Text, serviceType :Text, port :UInt16, txtJson :Text, forUid :UInt32) -> (handle :C.Cancelable);
}
```

#### 2.13.11 `gate-sys.capnp` (protocols §7.5.12)

```capnp
@0xc7a1e5d3b2f4002b;
using C = import "common.capnp";
using B = import "broker.capnp";

interface ShimEndpoint {           # facet shim: one endpoint per principal (tier L shim, bench-net per VM)
  connect      @0 (target :B.NetTarget, tokens :List(C.Token)) -> (socket :C.Fd);   # gate picks the first authorizing token
  udpAssociate @1 (target :B.NetTarget, tokens :List(C.Token)) -> (dgram :C.Fd);
  resolve      @2 (name :Text, qtype :UInt16) -> (answer :Data);   # DNS wire-format response, granted names only
  sshAgent     @3 () -> (socket :C.Fd);
  caBundle     @4 () -> (pem :Text);                               # session CA (if TLS interception is active)
}

interface GateDebug {              # facet debug (warden, atrium, owner shell)
  interception @0 (session :C.SessionId) -> (active :Bool, hosts :List(Text));   # fills the confinement report (§9.4)
  status       @1 () -> (json :Text);
}

interface GateMeterAdmin {         # facet broker
  meterFor @0 (rootId :Data) -> (spent :List(B.Budget), remaining :List(B.Budget), parent :Data);
  carve    @1 (parentRoot :Data, childRoot :Data, budget :List(B.Budget)) -> ();
      #! creates a hard sub-meter: every charge to childRoot is also charged to parentRoot; gate refuses a carve that
      #! would make the sum of the children's ceilings exceed the parent's remaining amount (kl:budget)
  release  @2 (childRoot :Data) -> ();   # returns the unspent remainder to the parent
}
```

#### 2.13.12 `bench.capnp` (protocols §7.3.13; `VmSpec` defines the VM principal that §4.11 registers)

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

#### 2.13.13 `loom.capnp` (protocols §7.3.16; `warden` routes facet `loom#attempt` to attempt processes)

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

#### 2.13.14 `loom-sys.capnp` (protocols §7.5.25; `BrokerWorkflow.claim` names the generation and spawner warden registers an attempt for)

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

### 2.14 Capability revocation (protocols §8.4)

- Revoking a root ID invalidates every token derived from it, including tokens whose `budget_parent` names it. Revocations are in-memory and persisted until the next reboot, when keys rotate anyway.
- **Workflow revocation is durable.** Cancelling or revoking a workflow (`BrokerWorkflow.cancel`, §20.25) writes a persistent cancellation record in the broker, revokes every root carrying that workflow's `workflow` fact, and makes every later claim and attempt registration of the workflow fail, across restarts and reboots; it is not undone by the per-boot key rotation.
- The broker MUST check revocation on every `materialize`, and `gate` on every `connect`, `stage` and `charge`.
- **Already-materialized fds cannot be pulled back from a process.** Revoking therefore also terminates or freezes holders through `PrincipalControl.terminate` (§7.5.1), according to the grant record's `onRevoke`: `kill` (default for agents) or `freeze` (default for apps; the user decides). Attached grant mounts are detached (`GrantMounts.detachGrant`).

### 2.15 Confinement and code-integrity contract (protocols §9)

Owned by `warden` (confinement) and `boot` (code-integrity loading). These are the behaviours other components may rely on.

**What a reboot restores.** Reboot restores verified code and owner-approved configuration. Writable state may still contain hostile data and may require quarantine or recovery. Components MUST NOT claim more: persistent hostile data (for example a file that triggers a parser bug) survives reboot and can trigger compromise again. The recovery menu offers **safe start**: the session is not restored and nothing is reopened automatically, and app data units are quarantined read-only until the owner releases them or rolls them back to a snapshot (atrium, strata, warden specs).

**protocols §9.1 Baseline for every non-kernel process except `warden` itself**

1. `PR_SET_NO_NEW_PRIVS`.
2. Own cgroup, own dynamic UID (§10.3), no supplementary groups. Human-owned data and directory grants reach dynamic UIDs through **idmapped mounts** (§7.5.1); mapping-only user namespaces used for idmapping are held by `warden`, and no process ever runs inside them.
3. Landlock ruleset at the highest available ABI:
   - starts from deny-all for all handled access rights;
   - allows only the mount view (§10.1), `/grants` (runtime grant mounts) and explicitly granted fds/paths;
   - scopes `ABSTRACT_UNIX_SOCKET` and `SIGNAL`;
   - uses `RESTRICT_SELF_TSYNC` when available.
4. seccomp-bpf allowlist profile `baseline-1`, default action `ENOSYS`. Always denied:
   - `unshare`, `setns`, and namespace flags on `clone`/`clone3` (clone3 → `ENOSYS`, forcing the libc `clone` fallback, which is then flag-checked);
   - `io_uring_*`, `bpf`, `perf_event_open`, `userfaultfd`;
   - `keyctl`, `add_key`, `request_key`;
   - `kexec_*`, `init_module`, `finit_module`, `delete_module`;
   - `mount`, `umount2`, `pivot_root`, `chroot`, `fsopen`, `fsmount`, `fsconfig`, `move_mount`, `open_tree`, `mount_setattr`;
   - `ptrace`, `process_vm_readv`, `process_vm_writev`;
   - `personality` (except the default);
   - `acct`, `swapon`, `swapoff`, `reboot`, `settimeofday`, `clock_settime`, `clock_adjtime`, `adjtimex` (read-only calls included: seccomp cannot inspect `struct timex`, so both are denied with `EPERM`);
   - `ioctl` `TIOCSTI` and `TIOCLINUX`.
5. Namespaces created by `warden` without a user namespace: mount, pid, ipc, uts, cgroup; net unless the principal is a tier-0 service with `network: "host"` (or `"cluster"`, which joins the cri network namespace, §20.16). **Single exception to "only `warden` creates namespaces":** on `server-k8s`, `net` creates the cri network namespace and the per-pod network namespaces inside the cri network (network namespaces only, never user or mount namespaces; §21.5).
6. A fresh `/proc` (`hidepid=invisible,subset=pid`).
7. No controlling terminal unless one is given; `TIOCSTI` disabled system-wide (`dev.tty.legacy_tiocsti=0`).
8. `mseal` of the stack and libc read-only segments (done by the keylos libc startup shim where available); `PR_SET_MDWE` (W^X) unless the generation has `needs.jit`.
9. `RLIMIT_RTPRIO = 0` unless the generation has `needs.realtime` (then 20, with `RLIMIT_RTTIME = 200 000 µs`).

The only other seccomp profiles are `baseline-1+<digest>` (baseline-1 plus the tier-0 extras a service's `privileges.syscalls` and `privileges.socketFamilies` list in `services.json`, §20.16; `<digest>` is the lowercase hex SHA-256 of the extras' names, syscalls and socket families together, sorted by bytes, each followed by `\n`), used only for tier-0 services; `debug-1` (baseline-1 plus `ptrace`, `process_vm_readv`, `perf_event_open`) and `debug-1k` (`debug-1` plus `bpf`, for scope `kernel`), used exclusively for `DebugAttach` debuggers (§9.3); `openbroker-1` (baseline-1 plus `process_vm_readv`; `ptrace`, `process_vm_writev` and `pidfd_getfd` stay denied), used exclusively for `compat`'s per-app open-broker processes (§9.3); and `runtime-default` (baseline-1 ∩ the Kubernetes RuntimeDefault profile) for `keylos-sealed` pods.

**protocols §9.2 Tiers**

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

**protocols §9.3 Code integrity (host)**

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

**protocols §9.4 Confinement report**

`Process.confinement` returns JCS JSON:

```json
{"schema":"keylos.confinement/1","tier":"t1","featureLevel":"KL2","landlockAbi":9,
 "namespaces":["mnt","pid","ipc","uts","cgroup","net"],"userns":false,
 "seccompProfile":"baseline-1","compensations":["udp-via-netns"],"jit":false,
 "tlsInterception":{"active":false,"hosts":[]},"grants":["/grants/thesis"]}
```

`seccompProfile` is one of the profile names of §9.1: `baseline-1`, `baseline-1+<digest>` (tier `t0` only), `debug-1`, `debug-1k`, `openbroker-1` or `runtime-default`. A kernel below KL1 is not a supported platform (§2), so a truthful report from one does not validate.

`tlsInterception` is filled from `gate` (`GateDebug.interception`, §7.5.12): when `gate` intercepts TLS for the principal (method filtering or credential injection), `active` is true and `hosts` lists the intercepted hosts.

**protocols §9.5 Devices, removable media and DMA**

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

### 2.16 Host layout (protocols §10.1)

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

### 2.17 UIDs and cgroups (protocols §10.3)

**UIDs:**

| Range | Use |
|---|---|
| 0 | Kernel threads, `warden` (PID 1). No other process. |
| 1000–59999 | Humans (allocated by `hearth`) |
| 0x00100000–0x0FFEFFFF | Dynamic principal UIDs, allocated by `warden` per running principal instance. Quarantined for 60 s after release. |
| 0x0FFF0000 | Reserved on-disk owner of `_cluster` data (pod volumes, cri state); reached by containers only through idmapped mounts; never allocated to a process |
| 0x0FFF0001–0x0FFFFFFF | Reserved |
| 0x10000000–0x7FFEFFFF | Legacy-tier user-namespace ranges, 65536-UID blocks, allocated by `warden` |

**cgroups:**

```
/keylos.slice/system.slice/<service>.scope
/keylos.slice/user-<uid>.slice/{shell,apps,agents,benches,legacy}.slice/<session>.scope
/keylos.slice/kube.slice/<pod-id>.slice/<container-or-vm>.scope      (cgroup subtree delegated to cri)
/keylos.slice/guest-<id>.slice/…                                    (ephemeral guest sessions, removed at logout)
```

### 2.18 Environment conventions and log records (protocols §10.5, §10.6)

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

Processes write logs to the journal stream fd (fd 2 is connected to it by default) as:
- plain text lines, or
- **structured records**: a datagram whose first byte is `0x1E` followed by a CBOR map with keys `l` (level 0–7), `m` (message) and `f` (fields map), or
- **metrics records**: a datagram whose first byte is `0x1F` followed by a CBOR map with keys `n` (metric name), `t` (`"counter"` | `"gauge"` | `"histogram"`), `v` (number, or for histograms a map of bucket bound → count plus `sum` and `count`) and `l` (labels map).

### 2.18a Cross-repository files (protocols §10.7)

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

### 2.19 Revocation list (protocols §11.7)

```json
{"schema":"keylos.revocations/1","stream":"stable","serial":1234,"issued":"…",
 "objects":[{"ref":"obj:fsv256:…","reason":"CVE-2026-XXXX","action":"evict"}],
 "generations":[{"ref":"gen:fsv256:…","reason":"…","action":"unlaunchable"}],
 "keys":[{"ref":"key:sha256:…","reason":"compromised","after":"…"}]}
```

- Distributed as a TUF target by `courier` and logged (its digest) in the release statement.
- Actions: `unlaunchable`, `evict`, `warn`.
- A `keys[]` entry for a `publisher/<id>` or `org-publisher/…` key makes every generation whose only authorising signature is by that key `unlaunchable` from `after` onwards; generations signed before `after` stay launchable only if their realisations reach the rebuilder quorum.

### 2.20 Receipts (protocols §13.1, §19.3)

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

### 2.21 Service names (protocols §19.1)

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

### 2.22 Facets (protocols §19.2)

`warden` is the route wirer, so the complete facet registry is normative input for it.

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

### 2.22a TPM objects, PCRs and PCR11 phases (protocols §19.6)

`warden` extends PCR11 phases `sysinit` and `ready` and reads nothing else from the TPM; the full registry is embedded because the phase order and the sealing consequences of `ready` are normative for the boot sequence (§4.12).

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

### 2.23 Boot trust set and report (protocols §20.1)

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

### 2.24 Generation statement (protocols §20.7)

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

### 2.25 Owner exception (protocols §20.9)

Presence-signed (purpose `exception`):

```json
{"schema":"keylos.exception/1","kind":"reproducibility","name":"org.example.Tool","publisher":"key:sha256:…",
 "generation":null,"reason":"vendor binary","scope":"machine","decidedBy":"alice","time":"…","expires":null}
```

`kind`:
- `reproducibility`: allows effective tier 1 for a non-reproducible or `unreviewed` generation. `generation` null matches all generations of `name` from `publisher`.
- `fleet-receipt-access`: `{"events": ["<event type>", …]}` in an extra field `events`; lets `fleet` read sealed payloads of those events (§13.4). `name`/`publisher` are null.

Exceptions are written by `config` to `/etc/keylos/exceptions/` (§10.7); `depot` and `ledger` read them from the booted config generation.

### 2.26 First-boot bundle (protocols §20.13, excerpt of the rule that concerns warden)

`warden` removes `/var/lib/keylos/firstboot/bundle.json` once every consumer listed in protocols §20.13 has reported its part done (§4.12.2).

### 2.26a Service table (protocols §20.16)

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

### 2.26b Policy reference (protocols §20.17)

`/etc/keylos/policy.ref` (JCS): `{"schema":"keylos.policyref/1","generation":"gen:fsv256:…","digest":"sha256:<JCS digest of the policy generation's manifest>"}`. `warden` mounts that `policy` generation read-only at `/policy` in `broker`'s view; `broker` refuses to start if the mounted generation's manifest digest differs. `BrokerSystem.loadPolicy` switches policy at runtime only to the generation named by the newly activated config generation's `policy.ref`.

### 2.26c Cluster nodes: boundary and runtime classes (protocols §21.1, §21.2)

- The `server-k8s` profile runs upstream `kubelet` and `kube-proxy` (sealed generations built by `forge`, packaged in `pkgs`) and the keylos `cri` service.
- `kubelet` reaches `cri` only through the route `cri#kubelet`: `warden` creates an `AF_UNIX` `SOCK_STREAM` socket pair and passes `kubelet` its end as `--container-runtime-endpoint=unix:///run/keylos/cri/cri.sock` (a path inside kubelet's view bound to that socket). This is the only non-capwire IPC in keylos (§7.1).
- `cri` implements CRI v1 (`runtime.v1.RuntimeService`, `runtime.v1.ImageService`) for the three most recent Kubernetes minor versions at release time.
- `kubelet` runs as a tier-1 service without root and without capabilities, in the cri network namespace (`services.json` `network: "cluster"`). It holds: the `cri#kubelet` route; the cgroup subtree `/keylos.slice/kube.slice` (delegated to `cri`, read-only to kubelet for stats); its state directory `/var/lib/keylos/cri/kubelet` (written by `cri`: certificates, kubeconfig). Volume mounts, networking and image handling are done by `cri`, never by kubelet.
- **Mount-free kubelet.** `pkgs` builds kubelet with the `keylos-mountless` patch set, which is part of this contract: kubelet never calls `mount`/`umount` (they are denied by seccomp anyway). Its volume plugins write configMap, secret, projected and downwardAPI contents into plain directories under `/var/lib/keylos/cri/kubelet/pods/<uid>/volumes/`, and every mount, unmount, and device-attach step is a no-op; `cri` turns those directories into `PodMount` trees (`tmpfsBytes > 0` for secret-bearing types, §7.5.1) or VM shares, and handles emptyDir, local, NFS/iSCSI/RBD and CSI volumes itself (§21.6).
- `kube-proxy` runs in nftables mode inside the `cri` network namespace with `CAP_NET_ADMIN` there only.

| RuntimeClass | Isolation | Images | Notes |
|---|---|---|---|
| `keylos-vm` (default) | One `bench` microVM per pod sandbox (`VmSpec.purpose = pod`); containers run inside the guest under `youki` driven by `benchd` | Any OCI image, pulled by `cri` into `/var/lib/keylos/cri/images` (via `gate` when `cluster.egressViaGate`), shared read-only into the VM | VM principal `pod:<ns>/<name>:oci:sha256:<first image>@_cluster/…`; GPU only by passthrough |
| `keylos-sealed` | t1 principals spawned by `warden` through `PodSpawn` (§7.5.1) | Only `container` generations (§6.1) with a generation statement signed by an `org-publisher` key enabled on the machine | One principal per container; seccomp `runtime-default`; no added capabilities ever |

### 2.26d Durable execution (protocols §20.25)

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

### 2.27 UID 0 rule

`warden` (PID 1 core), `warden-supervisor` and `warden-spawner` all run as UID 0, because they are one trusted component. Every other process runs under a dynamic UID, including tier-0 services.

---

## 3. Requirements

### 3.1 Process creation

- **REQ-WARDEN-001** `warden` MUST be the only userspace component that calls `clone`/`clone3` with namespace flags, `unshare`, `setns`, mount-family syscalls, `mknod`, `setuid`/`setgid` to a different identity, or writes to cgroupfs outside its own scope.
- **REQ-WARDEN-002** Every process other than the three warden processes MUST be created by `warden-spawner` from a validated **SpawnPlan** (§4.3). Principals MAY `clone` threads and child processes without namespace flags. Those inherit the parent's confinement and cgroup, and belong to the parent's principal.
- **REQ-WARDEN-003** `spawn` MUST reject a `SpawnSpec` that fails any of these checks, with the stated error code:
  - `generation` is not `kind gen`: `kl:invalid`;
  - the generation is not `launchable` according to `depot.get`: `kl:integrity`;
  - the generation is `revoked`, or listed `unlaunchable` in the current revocation list: `kl:revoked`;
  - its manifest `requiresFeatureLevel` exceeds the running feature level: `kl:unsupported`.
- **REQ-WARDEN-004** The **effective tier** MUST be the maximum of:
  - `manifest.tier`;
  - the config floor `apps.<name>.tierFloor` (§10);
  - `SessionRegResult.tierFloor` returned by `broker`;
  - the actor-kind floor: `agent`→t3, `legacy`→legacy, `bench`→t0, `service`→t0, `pod` (through `PodSpawn`)→t1, all others→t1;
  - t2, when the manifest has `reproducible: false` and no valid owner exception exists (protocols §20.9; verification in §4.3 step 4);
  - t2, when `GenerationInfo.launchReasons` contains `unreviewed-tier2` (catalog `unreviewed`, protocols §11.8) and no owner exception of kind `reproducibility` covers the generation.

  VM processes spawned through `VmSpawn.spawnVmm` (facet `bench`) are the exception: they run on the host as the VM principal at tier t0 confinement while the principal's *recorded* tier is the VM's tier (t2/t3, §4.11).
- **REQ-WARDEN-005** If the effective tier is t2 or t3, `warden` MUST NOT start the process on the host. `spawn`, `spawnForHuman`, `spawnTerminal` and `spawnLegacy` fail with `kl:unsupported:t2` or `kl:unsupported:t3` (the ref names the effective tier). Requesters (`kish`, `atrium`, `compat`, `aide`) start such workloads through `Bench.start`. `warden` never calls `bench`; this keeps the dependency graph acyclic (`bench` depends on `warden`).
- **REQ-WARDEN-006** Nothing MUST be inherited except:
  - the fds listed in `SpawnSpec.fds`;
  - the capwire sockets created for routes;
  - the journal stream at fd 2, and at fd 1 unless the spec maps fd 1;
  - for tier-0 services, the `Bootstrap` connection at fd 3 (§5.2).

  `close_range(3, ~0, 0)` MUST run before the explicit fds are installed.
- **REQ-WARDEN-007** Environment validation:
  - `env` entries whose name matches any pattern in the policy list `secretEnvPatterns` (§10) MUST be rejected with `kl:invalid`. Pod containers (`PodSpawn`) are exempt: their environment is the Kubernetes container environment that `BrokerSystem.admitPod` admitted (§4.16);
  - caller-supplied `KEYLOS_*` names MUST be rejected with `kl:invalid` (protocols §10.5), with one exception: when the caller's actor kind is `shell`, `KEYLOS_ARGFD_<argname>`, `KEYLOS_PIPE_IN` and `KEYLOS_PIPE_OUT` are accepted. For each `KEYLOS_ARGFD_*` value (a comma list of decimal fd numbers) every number MUST be the `target` of an entry in `SpawnSpec.fds`, else `kl:invalid`. `KEYLOS_PIPE_IN`/`KEYLOS_PIPE_OUT` MUST equal `cbor-seq` (protocols §12.2).
- **REQ-WARDEN-008** Before creating any kernel object for the child, `warden` MUST call `BrokerSystem.registerSession` with:
  - `child` = the child principal text;
  - `parent` = the caller's session (empty for services `warden` starts itself);
  - `offered` = `SpawnSpec.grants`;
  - `onRevoke` = `kill` for actor kinds `agent`, `service` and `bench`, and `freeze` for all others.

  A failed call (for example `kl:denied`, raised when the parent may not spawn the generation or offered tokens it does not hold) fails the spawn with the same code. `kl:unavailable` is the retryable answer of a broker that cannot yet write a receipt it owes (protocols §17 INV-7): for services and boot-time principals it starts itself `warden` retries it with backoff for up to 120 s, and for `Supervisor.spawn` callers for up to 10 s, before failing with `kl:unavailable`; a dropped registration would lock the principal out of `broker#principal`. The returned `tokens` are the child's capability set, the returned `label` its initial session label, and the returned `tierFloor` enters REQ-WARDEN-004.
- **REQ-WARDEN-009** The child session MUST be a fresh ULID unless the caller supplied one. A supplied session MUST NOT already be registered.
- **REQ-WARDEN-010** The caller's own principal becomes the **parent**. The child principal text MUST be `<actor>@<parent human>/<parent chain>/<child session>`. Exceptions:
  - service principals use `_system` and a single-session chain;
  - `UserSpawn.spawnForHuman` and `TrustedSpawn.spawnTerminal` children extend the named human's current `shell` session (§4.3.2);
  - `DebugAttach` debuggers extend the requesting human's current `shell` session (§4.17);
  - `PodSpawn` containers are `pod:<ns>/<name>:<gen>@_cluster/<cri session>/<child>` (protocols §3.4, §4.16);
  - VM principals created through `VmSpawn.register` take their parent session from `VmPrincipal.parentSession`, which every offered token must name as holder (§4.11).
- **REQ-WARDEN-011** Spawn authority is decided by `broker` in `registerSession`: action `spawn` on the child's generation for the parent principal. `warden` itself is authorised to start the services listed in the active `services.json` (§4.6.1).

### 3.2 Confinement

- **REQ-WARDEN-020** Every spawned host process MUST receive the full baseline of protocols §9.1, in the order given in §4.4.
- **REQ-WARDEN-021** The Landlock ruleset MUST:
  - handle every filesystem access right of the detected ABI;
  - handle `NET_BIND_TCP` and `NET_CONNECT_TCP` (ABI ≥ 4), and `NET_BIND_UDP` and `NET_CONNECT_SEND_UDP` (ABI ≥ 10);
  - set scopes `ABSTRACT_UNIX_SOCKET | SIGNAL` (ABI ≥ 6);
  - allow `/grants` with the access rights of the highest possible grant (protocols §7.3.3), so that `GrantMounts.attachGrant` can later make trees reachable without widening the domain.
- **REQ-WARDEN-022** The seccomp filter:
  - MUST be generated from the profile table in §4.5;
  - MUST be installed with `SECCOMP_FILTER_FLAG_TSYNC` after Landlock and immediately before `execveat`;
  - MUST default to `SECCOMP_RET_ERRNO(ENOSYS)`.
- **REQ-WARDEN-023** No process other than legacy-tier processes MUST run inside a user namespace. For legacy-tier processes, `warden` MUST write `0` to the child namespace's `user.max_user_namespaces` before the child executes. Mapping-only user namespaces used for idmapping (§4.7.3) contain no process.
- **REQ-WARDEN-024** `warden` MUST produce a confinement report (protocols §9.4) for every process. It MUST list:
  - every compensation applied for missing kernel features (§4.4.2);
  - every attached grant mount;
  - the `tlsInterception` state (§4.15).
- **REQ-WARDEN-025** Mount views:
  - The mount view MUST be built entirely from detached mount trees (`fsopen`/`fsmount`/`open_tree(OPEN_TREE_CLONE)`) assembled with `move_mount`.
  - Paths outside the generation, the declared data and the grants MUST NOT be reachable.
- **REQ-WARDEN-026** Mount flags:
  - all writable mounts in a view MUST carry `nosuid,nodev,noexec`;
  - all generation mounts MUST carry `nosuid,nodev` and `ro`.
- **REQ-WARDEN-027** Data directories owned by humans MUST be presented through **idmapped mounts** that map the owning human UID to the principal's dynamic UID (§4.7.3). Changing ownership on disk to a dynamic UID is forbidden.
- **REQ-WARDEN-028** A per-principal cgroup BPF device program (`BPF_PROG_TYPE_CGROUP_DEVICE`) MUST allow only the device numbers planned by `devd` (`DeviceAdmin.plan`) for that principal. With no planned devices it allows only `/dev/null`, `/dev/zero`, `/dev/full`, `/dev/random`, `/dev/urandom`, and `/dev/tty` when a terminal is passed.
- **REQ-WARDEN-029** Securebits (protocols §9.3):
  - every host principal MUST get `SECBIT_EXEC_RESTRICT_FILE` and `SECBIT_EXEC_DENY_INTERACTIVE` (both locked);
  - **except** the **trusted-terminal tree**, which gets only `SECBIT_EXEC_RESTRICT_FILE` (locked). A principal is in the tree if and only if (a) it was spawned through `TrustedSpawn.spawnTerminal`, or (b) it was spawned through `Supervisor.spawn` (facet `client`) by a principal that is in the tree **and** whose actor kind is `shell` (that is, a `kish` job, foreground or background, including REPLs started from the prompt). A principal spawned through `warden` by any other program in the tree (for example an editor started as a job that later asks `warden` to spawn a helper) is outside the tree and gets both bits. `warden` decides from the spawning principal's registry entry, never from process ancestry or caller claims (§4.3.3).
  - Processes a principal creates itself with `fork`/`exec` (no namespace flags, same cgroup) inherit its securebits through the kernel; they stay part of that principal and therefore of its tree membership.
- **REQ-WARDEN-029a** Resource limits (protocols §9.1 item 9): every principal MUST start with `RLIMIT_RTPRIO = 0`; a generation with `needs.realtime: true` gets `RLIMIT_RTPRIO = 20` and `RLIMIT_RTTIME = 200000` µs (soft = hard). Both are set in the child before `setresuid` (§4.4 step 9), so the principal cannot raise them.

### 3.3 Routes and identity

- **REQ-WARDEN-030** Route creation:
  - For every route a principal is entitled to (§4.8), `warden` MUST create one `SOCK_SEQPACKET` socket pair.
  - The server end, a fresh 64-bit `connectionId`, the facet, the peer principal, its tier and its generation go to the service instance through `ServiceHost.accept`.
  - The client end goes to the child at the next free fd ≥ 3 (≥ 4 for tier-0 services), recorded in `KEYLOS_CAPWIRE_FDS` under the route name of protocols §10.5: `<svc>` for facets `client` and `default` and for `broker#principal` and `warden#service`, otherwise `<svc>#<facet>`. This one rule also covers REQ-WARDEN-031 (`broker=<fd>`, `warden=<fd>`).
- **REQ-WARDEN-031** Every principal MUST receive a connection to `broker` (facet `principal`), listed as `broker=<fd>`, and a connection to `warden` (facet `client`, or `service` for tier-0 services), listed as `warden=<fd>`. Exceptions: sealed pod containers receive no capwire routes at all (§4.16), and helper processes of a VM principal receive only the routes their bench entrypoint declares (§4.11).
- **REQ-WARDEN-032** `identify(pidfd)` MUST resolve the principal from the pidfd's cgroup:
  - resolution path: `pidfd` → PID from `/proc/self/fdinfo/<fd>` (`Pid:` field) → cgroup path from `/proc/<pid>/cgroup` → registry lookup;
  - it MUST then re-check that the pidfd is still alive (`pidfd_send_signal(pidfd, 0)`) and that its `Pid:` is unchanged;
  - a dead pidfd yields `kl:not-found`;
  - a pidfd naming `warden` itself (core, supervisor or spawner, for example one obtained with `SO_PEERPIDFD` from a warden-created socketpair) yields `kl:invalid`; ancestry and cgroup resolution never resolve to `warden`, although `warden` is a registered principal.
- **REQ-WARDEN-033** `identify` for a process in a legacy-tier user namespace MUST return the legacy principal of its cgroup. It MUST NOT trust any UID mapping. For a VM principal, it returns the principal of the VMM cgroup (protocols §3.4).
- **REQ-WARDEN-034** `connectionInfo(id)` MUST be answered only for connections whose server end was delivered to the calling service; other callers get `kl:denied`.
- **REQ-WARDEN-035** On-demand services MUST be started when a route to them is first needed. The client end of the route MUST be usable immediately; datagrams queue in the socket until the service accepts.
- **REQ-WARDEN-036** `ServiceConnect.connectService(session, service, facet)` MUST:
  - be served only on facet `broker`;
  - create a route exactly like REQ-WARDEN-030 for the existing principal of `session`;
  - return the principal-side socket to `broker` (which hands it to the principal through `Broker.materialize`);
  - check that `service#facet` exists in the facet registry (protocols §19.2) and is served by a running or startable instance.

### 3.4 Principal lifecycle

- **REQ-WARDEN-040** Dynamic UIDs MUST be allocated from `0x00100000–0x0FFEFFFF` (protocols §10.3; `0x0FFF0000` is the reserved on-disk owner of `_cluster` data and is never allocated) and never reused within 60 s of the owning cgroup becoming empty and removed.
- **REQ-WARDEN-041** A principal instance ends when its cgroup is empty. At that point `warden` MUST:
  1. remove the cgroup;
  2. release the UID into quarantine;
  3. close every route server end it created for that principal (services observe EOF);
  4. detach its grant mounts;
  5. call `depot.unroot` for holder `warden:<session>`;
  6. call `BrokerSystem.sessionEnded`;
  7. emit `PrincipalEvent.exited`;
  8. write an `exit` receipt.
- **REQ-WARDEN-042** `PrincipalControl.terminate(session, mode)` MUST apply to the session and all descendant sessions:
  - `kill`: `cgroup.kill` on the session's scope;
  - `freeze`: `cgroup.freeze = 1`;
  - `thaw`: `cgroup.freeze = 0`.

  Each frozen or thawed session emits a `PrincipalEvent`.
- **REQ-WARDEN-043** `Process.kill` MUST write `1` to `cgroup.kill` of the process's session scope. `Process.signal` MUST deliver the signal to every process of that scope (iterating `cgroup.procs` with pidfds). `Process.freeze`/`thaw` write `cgroup.freeze`.
- **REQ-WARDEN-044** `PrincipalControl` facet scoping:
  - `hearth` may terminate only sessions whose human is the human it names in the call's session;
  - `strata` may call only `events`, `mountView` and `fenceWriters`;
  - `cri` may call only `terminate` and `events`, and only for sessions whose human is `_cluster` (pod sessions) — `events` delivers only pod-session events to it;
  - `broker` and `admin` may call every method.
- **REQ-WARDEN-045** `PrincipalEvent.cgroupId` MUST be the kernel cgroup ID (the inode number of the session scope directory) and MUST stay constant for the session's lifetime. Every event of one session carries the same value.
- **REQ-WARDEN-047** `PrincipalControl.events(watcher, replay)`: with `replay = true`, `warden` MUST first emit one `spawned` event for every currently running session visible to the caller's facet (in registry order, oldest first, each with its current `cgroupId`), and only then deliver live events; no live event for a session may precede its replayed `spawned` event. With `replay = false` only live events are delivered.
- **REQ-WARDEN-046** Guest humans (usernames `guest-…`, protocols §3.3) MUST be placed under `/keylos.slice/guest-<id>.slice/` instead of `user-<uid>.slice`. When `hearth` terminates the guest's last shell session (logout), `warden` MUST kill every remaining scope of that human, remove the slice and quarantine all of the guest's UIDs.

### 3.5 Services

- **REQ-WARDEN-050** Services are generations of kind `service`. Their lifecycle and privileges MUST come from the **service table** `/etc/keylos/services.json` (`keylos.services/1`, protocols §20.16) in the verified config generation (§4.6.1). The manifest's `x-keylos-service` block MAY provide lifecycle defaults (start mode, ordering, health), but per protocols §6.3 `x-` fields in manifests carry no authority: capabilities, syscalls, socket families, devices, paths, network mode, ports and BPF programs are taken **only** from `services.json`.
- **REQ-WARDEN-056** Service BPF programs (protocols §9.3): for every service whose entry lists `bpf`, the `warden` core MUST, before the service's first start in a boot:
  1. accept only paths under `/usr/lib/keylos/bpf/<service>/` that resolve (with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)`) to regular files on the **OS generation's** superblock (checked against `kl_exec_allowed_sb` with the OS `gen_index`); anything else rejects the whole service table;
  2. load every program in the object and attach it according to its section name (§4.6.5); program types outside the allowed list fail the load;
  3. keep every program, link and map fd in the core for the rest of the boot (programs are never pinned in bpffs and never detached while the boot lasts);
  4. pass to the service only the map fds of maps declared exportable (§4.6.5), as `KEYLOS_BPF_FDS=<name>=<fd>[,…]`, on every start and restart of the service.
- **REQ-WARDEN-057** Services MUST NOT call `bpf()`: `bpf` is never a permitted seccomp extra. Exported maps are therefore of types a holder can use without `bpf()` (`BPF_MAP_TYPE_RINGBUF`, or `BPF_MAP_TYPE_ARRAY` created with `BPF_F_MMAPABLE`), consumed through `mmap`.
- **REQ-WARDEN-058** `network: "cluster"` (protocols §20.16) MUST be accepted only for the services `cri`, `kubelet` and `kube-proxy` and only on the `server-k8s` profile; any other service table entry with it is rejected at load. Such services start only after `net` is ready and run in the netns from `NetPlumbingCluster.clusterNetns`; `warden` never creates that namespace itself (the documented exception of protocols §9.1 belongs to `net`).
- **REQ-WARDEN-059** TPM hand-over (protocols §10.5): for a service whose entry has `privileges.tpm: true`, `warden` MUST open `/dev/tpmrm0` (`O_RDWR`) itself, place the descriptor in the service's fd table at the next free fd and set `KEYLOS_TPM_FD=<n>`; the device node is not added to the view (the fd is the only TPM access). Services without `privileges.tpm` get neither. `KEYLOS_DEV_*` names (protocols §10.5) are development knobs: a production `warden` never sets them and keeps rejecting every `KEYLOS_*` name in `SpawnSpec.env`; only the development supervisor (`warden-lite`, `warden` repo) may set them from its development overlay.
- **REQ-WARDEN-051** Services MUST start in topological order of `after` only. Routes do not order starts: route cycles are normal (`broker` ⇄ `atrium`, `ledger` ⇄ `vault`, `hearth` ⇄ `vault`), and REQ-WARDEN-035 makes a client end usable before the server has called `host()`; server ends of routes to a service that has not yet called `host()` are queued and delivered through `ServiceHost.accept` once it has. A cycle in `after` MUST abort boot into the recovery path (§7).
- **REQ-WARDEN-052** Restart policy:
  - exponential backoff of 100 ms × 2^n, capped at 30 s;
  - after 10 failures within 5 minutes the service enters `failed`;
  - only `control(start)` or a new generation can then restart it.
- **REQ-WARDEN-053** `services()` MUST report every service in the active service table, including `inactive` on-demand services.
- **REQ-WARDEN-054** Every tier-0 service MUST receive fd 3 = a capwire connection whose bootstrap is `Bootstrap` (protocols §7.5.1). A service that has not called `host()` within 10 s of exec is considered failed to start.
- **REQ-WARDEN-055** `ServiceHost.reload()` MUST be called on a running service after a config generation change whose `/etc` view for that service differs. `warden` first rebuilds the service's `/etc` view in its mount namespace (§4.6.4). Services whose `services.json` entry says `"x-reload": "restart"` are restarted instead.

### 3.6 Boot, health and shutdown

- **REQ-WARDEN-060** Boot sequence and timing are in §4.12. The `boot` receipt MUST be written as soon as `ledger` is running. It MUST contain:
  - the OS generation and config generation;
  - the feature level and kernel release;
  - the boot entry identifier (EFI variable `LoaderEntrySelected`);
  - the boot report (protocols §20.1).
- **REQ-WARDEN-061** `warden` MUST expose boot health via `services()`. It MUST NOT itself mark a boot as good; `courier` performs boot assessment.
- **REQ-WARDEN-062** Shutdown is specified in §4.13:
  - every service MUST receive `ServiceHost.stop`, then `SIGTERM` via pidfd, then `SIGKILL` after its `stopTimeoutSecs` (default 10 s);
  - only after that may file systems be unmounted.
- **REQ-WARDEN-063** If the supervisor process crashes, the core MUST restart it within 200 ms with its registry intact. No principal process may be killed as a consequence.
- **REQ-WARDEN-064** PCR11 phases (protocols §19.6): `warden` MUST extend PCR11 exactly once per boot with `sysinit` (after mounting `/var`, `/home`, `/store` and `/keystore` and taking over the kl-exec maps) and exactly once with `ready` (immediately before starting the first tier-0 service, `journal` included). No tier-0 service, and no other principal, may be started before `ready` is extended. `warden` MUST NOT extend PCR11 at any other time; a failed extension stops the boot (§7).
- **REQ-WARDEN-065** `Supervisor.control("_system", poweroff|reboot)` (facet `admin` only) is the system power interface. Any other op on `_system`, or a power op on a real service name, fails with `kl:invalid`.

### 3.7 Code integrity maps

- **REQ-WARDEN-070** `warden` core MUST be the only holder of the `kl-exec` map fds after the initrd hands them over as fds 3–7 (`keylos.execmapfds=3,4,5,6,7`, protocols §9.3). The core MUST be the only long-running userspace task in the root cgroup; the kernel's core-dump pipe helper is the single exception: it moves itself out within 1 s and `journal` verifies the move (protocols §9.3). At takeover the core MUST verify that `kl_exec_policy` is frozen, that `warden_tgid == 1` (its own thread-group ID) and that `phase` is `SYSTEM` (1, protocols §9.3; the value `boot` writes at its step P15); any mismatch is fatal (§7). The core MUST adopt the ten hook link fds of `keylos.execlinkfds=9,…,18` and keep them open for its lifetime (closing them detaches `kl-exec`, protocols §9.3 "Links"); no other process ever holds them. When registering a superblock it writes the kernel `dev_t` (protocols §9.3), never `st_dev`. The core is subject to `kl-exec`'s `ptrace_access_check` like every task and supervises without ptrace access (§4.3 "No ptrace access").
- **REQ-WARDEN-071** Before adding a generation mount's superblock to `kl_exec_allowed_sb`, `warden` MUST perform the registration steps of protocols §9.3 ("Registering a generation"), as detailed in §4.9:
  - obtain the tree from `depot.mount`, or for bootstrap generations mount it itself with a digest check;
  - verify the generation statement against the boot trust set;
  - check the revocation list;
  - read `s_dev`.
- **REQ-WARDEN-072** For generations with `needs.jit: true`, `warden` MUST:
  - add the principal's cgroup ID to `kl_exec_jit_cgroups` before exec;
  - not set `PR_SET_MDWE`;
  - remove the entry when the cgroup is removed.
- **REQ-WARDEN-073** When a generation is revoked (a newer revocation list, or `GenerationInfo.revoked` observed on refresh), `warden` MUST:
  1. remove its superblock entries, so new exec and mmap from that generation fail;
  2. apply each affected principal's `onRevoke` through `PrincipalControl.terminate`.

  A `keys[]` revocation of a `publisher/<id>` or `org-publisher/…` key (protocols §11.7) makes every generation whose only authorising signature is by that key and whose statement `issued` is at or after `after` revoked in this sense; generations signed before `after` stay registered only if their realisations reached the rebuilder quorum (`GenerationInfo.launchReasons` does not contain `quorum-deferred`).
- **REQ-WARDEN-074** Generation statements whose `issued` time is later than trusted time plus 24 h (protocols §14.5) MUST be refused at registration (`kl:integrity`). Before the first NTS sync, trusted time is `LedgerAdmin.timeFloor` (protocols §3.6).
- **REQ-WARDEN-075** `kmod` generations (protocols §6.1): `warden` MUST register a `kmod` generation's mount in `kl_exec_allowed_sb` only if the manifest's `kmod.kernel` equals the running kernel release (`uname -r`); otherwise the generation is skipped and logged with reason `kernel-mismatch`. Modules are loaded only by the `warden` core with `finit_module` from files of a registered `kmod` mount or of the OS generation (§4.9.4).
- **REQ-WARDEN-076** Debug pairs (protocols §9.3): `warden` MUST write a `kl_debug_pairs` entry only through `DebugAttach.attach` (§4.17) or for the legacy open broker at `LegacySpawn` time (§4.10), MUST remove it when the debugger's cgroup is removed or the entry expires (whichever is first), and MUST NOT allow more than one entry per tracer cgroup.

### 3.8 Grant mounts and transactions

- **REQ-WARDEN-080** `GrantMounts.attachGrant(session, name, tree, readOnly, ceiling)` MUST:
  1. idmap `tree` to the holder's dynamic UID (unless it already is a warden-made idmapped tree);
  2. apply `MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC` (plus `MOUNT_ATTR_RDONLY` when `readOnly`);
  3. attach it at `/grants/<name>` inside the holder's mount namespace as a **non-recursive** bind (`open_tree(OPEN_TREE_CLONE)` without `AT_RECURSIVE`): mounts nested inside `tree` are never part of the grant;
  4. when `ceiling` is set, record the new mount's ID with that ceiling in the `kl_grant_ceiling` map before the mount becomes reachable (REQ-WARDEN-08D);
  5. return an `O_PATH` fd of the mount root opened through that namespace, together with the view path.

  `name` MUST match `[a-zA-Z0-9._-]{1,64}` and MUST NOT already be attached for that session.
- **REQ-WARDEN-08D** Grant ceilings (protocols §14.1, §7.5.1): through a grant mount with a ceiling `c`, `kl-label` (the label-ceiling BPF LSM program the core loads and keeps attached, separate from the `kl-exec` hand-over; protocols §9.3) MUST refuse with `EACCES` the `file_open` of any object whose effective label exceeds `c` in either dimension, and MUST refuse reads (`file_permission` with `MAY_READ`, `mmap` of the file) through fds opened via that mount when the object's label has since risen above `c`. The effective label is the object's `security.bpf.keylos.label` (read with `bpf_get_file_xattr`, which accepts only `user.*` and `security.bpf.*` names, protocols §10.4); an object without one has its location default (protocols §14.1); a malformed label is refused. `kl-label` attaches `file_open`, `file_permission` and `mmap_file`, keys its map `kl_grant_ceiling` by mount ID and reads `struct file`/`struct mount` at offsets computed from BTF at load, as `kl-exec` does; where the kernel offers `bpf_set_dentry_xattr` at inode creation (`bpf-init-inode-xattr`) it stamps new objects created through a ceiling mount with the mount's ceiling. On kernels without `bpf-init-inode-xattr` (no label stamping at create), an unlabelled object whose `ctime` is later than the grant's attach time counts as `secret/untrusted`. The ceiling is keyed by mount ID and therefore also covers renames and hard links into the tree. A null `ceiling` records nothing; the caller (broker) MUST then have raised the holder to `secret/untrusted` (protocols §7.5.1). Denials are logged with the mount, object and labels and counted in the confinement report (`grants[].ceilingDenials`).
- **REQ-WARDEN-08E** Single-file grants (protocols §7.3.3, §7.5.19): for a file pick, the `tree` passed by `portal-files` is its single-file view (a FUSE mount that contains only the selected file plus the holder's own temporary files); `warden` attaches that tree like any other grant and MUST NOT attach, open or bind the file's real parent directory for the holder. `viewPath` is `/grants/<name>` and the file appears as `/grants/<name>/<basename>`.
- **REQ-WARDEN-081** `detachGrant` MUST unmount `/grants/<name>` with `MNT_DETACH` in the holder's namespace. On revocation (protocols §8.4) `broker` calls it for every grant mount derived from the revoked root.
- **REQ-WARDEN-082** `SpawnSpec.transaction`, when set, MUST be resolved through `StrataTxn.txnExt` on facet `strata#warden`:
  1. `TransactionExt.owner()` gives the session that began the transaction. The **spawner's** session (the caller's, or for `spawnForHuman`/`spawnTerminal` the parent shell session) MUST equal it or descend from it in the registry's session tree; otherwise the spawn fails with `kl:denied` and no view is mounted (protocols §7.5.7);
  2. `TransactionExt.policy` gives the network policy and the overlay view paths;
  3. `warden` mounts each view over the corresponding base directory in the child's view (§4.7.5);
  4. the child's network follows the returned `NetworkPolicy` (`deny` → netns with only `lo`, no gate sockets; `gate` → as planned; `inherit` → the spawner's own netns mode);
  5. `KEYLOS_TXN` is set to the transaction ID.

  A transaction ID that `strata` refuses fails the spawn with the same error. For targets inside a sealed unit served by `keylos.unitfs/1` (protocols §7.3.10 storage backends), `Transaction.view()` returns the transaction-specific plaintext view that `strata` serves over the cloned ciphertext backing; `warden` mounts it like an overlay view and MUST NOT mount the live unit view or the backing subvolume for that target in the child's view.
- **REQ-WARDEN-08F** Writer fence (protocols §7.5.1 `PrincipalControl.fenceWriters`, facet `strata` only): `warden` MUST resolve `tree` to its (superblock, subtree) and compute the fence set: every live session (except `exclude` and their descendants) whose mount view contains a writable mount whose source overlaps the subtree (home and data mounts, grant mounts, idmapped data mounts, transaction views over it), plus every session holding an open writable fd or a shared writable mapping on an inode of the subtree as reported by the kernel. It MUST freeze each such session (`cgroup.freeze = 1`, waiting for `cgroup.events frozen 1`) and return only when all are frozen. If a would-be writer cannot be frozen (a tier-0 service other than `strata`, `warden` itself, a kernel or network-filesystem writer, or a VM principal whose virtio-fs share maps the subtree writable while its VMM cannot be frozen), `fenceWriters` MUST thaw what it froze and fail with `kl:conflict` naming the writer. The fence ends at `WriterFence.release`, when the capability is dropped or the `strata` connection ends, or 30 s after it was taken, whichever is first; at the end `warden` thaws exactly the sessions it froze (sessions that were already frozen for another reason stay frozen). Each fence emits `PrincipalEvent.frozen`/`thawed` for its sessions and is recorded in the `spawn`-independent receipt `x-warden.fence {tree, sessions, durationMs, outcome}`.

### 3.8a Debugging, pods and VM principals

- **REQ-WARDEN-083** `DebugAttach.attach` (facet `broker` only) MUST implement protocols §9.3 "Debugging": the debugger generation's manifest `name` MUST be in the policy list `debug.debuggers` (config, §10), `expiresSecs` MUST be ≤ 3 600 (scope `process`) or ≤ 900 (scope `kernel`), and the debugger is spawned with seccomp profile `debug-1` as a child of the shell session of `requester` (the principal the grant was minted to, protocols §7.5.1) (§4.17). `requester` MUST be a live principal whose human owns the target (or, for an agent target, owns the agent's session tree); otherwise `kl:denied`. Violations fail with `kl:invalid`; a target that is not live fails with `kl:not-found`.
- **REQ-WARDEN-084** Debugger capabilities (protocols §9.3): scope `process` gets ambient `CAP_SYS_PTRACE` and `CAP_PERFMON`; scope `kernel` additionally gets `CAP_BPF`. Every other capability is dropped from the bounding set. Access is further limited by the `kl-exec` `ptrace_access_check`, `perf_event_open` and `bpf` hooks keyed by the debugger's `kl_debug_pairs` entry.
- **REQ-WARDEN-08C** Seccomp profile `openbroker-1` (protocols §9.1): `baseline-1` with `process_vm_readv` moved to the allowed list; `ptrace`, `process_vm_writev` and `pidfd_getfd` stay denied. `warden` MUST apply it to every `compat`-spawned process with entrypoint `open-broker`, and to no other process. `process_vm_readv` is never accepted as a `privileges.syscalls` extra.
- **REQ-WARDEN-085** On debugger exit or expiry `warden` MUST, in this order: delete the `kl_debug_pairs` entry, `cgroup.kill` the debugger scope, and write `debug.detach` with the reason (`exit`, `expired`, `revoked`).
- **REQ-WARDEN-086** `PodSpawn.spawnContainer` (facet `cri` only) MUST refuse (`kl:invalid`) a spec whose generation is not kind `container`, whose `actorKind` is not `pod`, or whose `pod.cgroupParent` is not below `/keylos.slice/kube.slice/`; and MUST refuse (`kl:integrity`) a generation whose statement is not signed by an `org-publisher` key present in the boot trust set's `publishers` with scope `org:<org>`. The container never receives a capability, a user namespace or a writable root (§4.16).
- **REQ-WARDEN-088** `PodSpawn.execInContainer(spec, container)` (facet `cri`) MUST: refuse (`kl:invalid`) when `container` is not a live pod-container session spawned by `spawnContainer`, or when `spec.generation` differs from that container's generation; create a child session of the container's principal; join the container's mount, pid, net, ipc and uts namespaces (through pidfds of the container's init, `setns` performed by the `warden` spawner) and place the process in a leaf scope `<container>.scope/exec-<n>.scope`; apply the container's Landlock, seccomp (`runtime-default`) and securebits; grant no capability. The exec process sees the container's live filesystem state (its tmpfs mounts and writable volumes).
- **REQ-WARDEN-089** `PodSpawn.egressShim(podId)` (facet `cri`) MUST return a `gate-sys` `ShimEndpoint` bound to the pod's principals, created exactly as for tier-L shims (§4.10, route `gate#shim` with the pod principal as peer), at most one per `podId`, revoked when the pod's last container exits.
- **REQ-WARDEN-08A** `PodMount.tmpfsBytes > 0`: `warden` MUST create a tmpfs of exactly that size (`size=`, `nr_inodes` = size / 4 KiB, `noexec,nosuid,nodev`, mode 0755 owned by the container's dynamic UID) at `target`, copy the tree into it (regular files, directories and symlinks only; symlinks are not followed; device nodes and sockets are skipped and logged), and then apply `readOnly`. A tree larger than `tmpfsBytes` fails the spawn with `kl:invalid`. `tmpfsBytes = 0` binds the tree as before.
- **REQ-WARDEN-087** VM principals (§4.11) are created only through `VmSpawn` (facet `bench`, protocols §7.5.1): `register` creates the principal, `spawnVmm` spawns its host processes, `unregister` ends it. Every process `spawnVmm` spawns for one VM MUST run in that VM principal's single cgroup scope, under its dynamic UID, and `identify` on any of them MUST return the VM principal. `Supervisor.spawn` on facet `bench` MUST refuse a `SpawnSpec.session` that names a registered VM principal (`kl:invalid`): VM helpers are spawned only through `spawnVmm`.
- **REQ-WARDEN-08B** `VmSpawn.register(vm)` MUST: require `vm.session` fresh; require every token in `vm.offered` to name `vm.parentSession` as holder (`Broker.inspect` on `broker#system`) and `vm.parentSession` to be live; require `principalKind` ∈ {`bench`, `agent`, `legacy`, `pod`} and, for `pod`, `parentSession` = the `cri` service session; derive the actor per protocols §3.4 (`agent:` + `template`, `pod:<ns>/<name>:` + image for pods, else `<kind>:` + `image`); allocate a dynamic UID and the scope (§4.11); call `BrokerSystem.registerSession(child, parent, offered)`; return the principal, its `cgroupId` and the tokens the broker issued. Violations fail with `kl:invalid`; a non-live parent with `kl:not-found`.

### 3.8b Workflow attempts (durable execution)

These requirements implement protocols §20.25 ("Attempt authority", "Claims and ownership fencing") on the `warden` side. `warden` gives every attempt a fresh principal and forwards the binding; it never decides whether an attempt is current. That decision is the broker's, at `registerSession`.

- **REQ-WARDEN-094** `SpawnSpec.attempt` with a non-zero `epoch` MUST be honoured only when the caller is the service `loom` on facet `service` (peer from `ServiceHost.accept`/registry, never from the message). Any other caller that sets it fails with `kl:denied` and nothing is created. An `attempt` with `epoch = 0` is the same as no attempt.
- **REQ-WARDEN-095** For an attempt spawn `warden` MUST: require `SpawnSpec.session` to be empty (else `kl:invalid`) and generate a fresh session; build the child principal as `<actor>@<attempt.owner>/<loom's chain>/<new session>`, where `attempt.owner` MUST be a valid username or `_system` (else `kl:invalid`); pass `attempt` unchanged in `SessionReg.attempt` (REQ-WARDEN-008) with `offered` empty (`SpawnSpec.grants` non-empty fails `kl:invalid`: a spawner's tokens are never delegated to an attempt); use `onRevoke = kill`; and place the scope under the owner's `user-<uid>.slice/apps.slice/` (`system.slice/` for `_system`). A `registerSession` refusal (`kl:conflict` for a stale or foreign binding, `kl:revoked` for a cancelled workflow) fails the spawn with the same code before any kernel object exists. `warden` interprets no other member of the binding.
- **REQ-WARDEN-096** **Fresh sessions.** `warden` MUST refuse (`kl:invalid`) any caller-supplied session ID (`SpawnSpec.session`, `VmPrincipal.session`, `ForkSpec.session` relayed by bench) that it has registered at any time during the current boot, live or ended, and every ID it generates MUST be a new ULID (protocols §3.5). Session IDs are never reused across attempts, restarts of the caller or reboots.
- **REQ-WARDEN-097** `VmSpawn.register` with `VmPrincipal.attempt` (non-zero epoch) MUST forward it unchanged in `SessionReg.attempt`, use `attempt.owner` as the VM principal's human (instead of the parent's human), keep `vm.parentSession` (the spawner, `aide`'s session) as the parent of the chain, and place the scope under the owner's `agents.slice` (agent kind) or the slice of REQ-WARDEN-095. The other `register` checks (REQ-WARDEN-08B) are unchanged.
- **REQ-WARDEN-098** **Attempt routes.** A principal spawned with an attempt binding MUST get the route `loom#attempt` (route name `loom#attempt`) when its generation declares it in `needs.services`; its server end is delivered to `loom` through `ServiceHost.accept` with that principal as peer, so `loom` binds the connection to the attempt session. `warden` MUST NOT route `loom#attempt` to any principal without an attempt binding.
- **REQ-WARDEN-099** **No durable workflow state in warden.** `warden` keeps no workflow state that survives a boot: `FdStore` content (also for `loom`) is dropped at shutdown (§5.2), the diagnostic snapshot `/run/keylos/warden/state.json` is never read back as authority or replayed, and the registry is rebuilt empty at boot (protocols §10.7 "Durable-execution state").
- **REQ-WARDEN-09A** When the `loom` service instance that spawned attempts ends (exit, crash or stop), `warden` MUST `cgroup.kill` every live attempt session it spawned for that instance before restarting `loom`. This is cleanup only; the guarantee that stale attempts cannot act is the broker's fencing (protocols §20.25).
- **REQ-WARDEN-09B** The `loom` service table entry (protocols §20.16) is validated like any service: tier 0, `writer: true`, `network: "none"`, no TPM, no capabilities; routes `warden#service`, `broker#workflow`, `gate#loom`, `vault#loom`, `ledger#writer`, `hearth#system`, `aide#loom`, `depot#loom`, `atrium#notify`; facets served `user`, `admin`, `attempt`, `aide` (protocols §19.2). `warden` grants the routes listed there and nothing else.

### 3.9 Receipts and audit

- **REQ-WARDEN-092** Every capwire socket `warden` creates for others (route pairs, `ServiceConnect.connectService`, the fd-3 bootstrap pair, `FdStore` hand-backs) MUST have `SO_SNDBUFFORCE` and `SO_RCVBUFFORCE` set to at least 4 259 840 bytes on both ends before either end is handed out, so 4 MiB datagrams fit whatever `net.core.wmem_max` is (protocols §7.1, §2). `warden` MUST deliver the peer's principal, tier, generation and facet in `ServiceHost.accept` and keep them answerable through `Supervisor.connectionInfo(connectionId)`; it MUST NOT answer `Supervisor.identify` for a pidfd obtained with `SO_PEERPIDFD` from a warden-created socketpair (that pidfd is warden's own, and `identify` on warden's pidfd fails with `kl:invalid`).
- **REQ-WARDEN-090** Receipts:
  - every successful spawn MUST produce a `spawn` receipt, and every principal end an `exit` receipt (§9.2);
  - failed spawns that passed `registerSession` produce a `spawn` receipt with `data.failed` set;
  - every `DebugAttach` produces `debug.attach`, and its end `debug.detach`;
  - the `spawn` receipt of an attempt (REQ-WARDEN-095, REQ-WARDEN-097) carries `data.attempt = {workflow, attempt, epoch}`; nothing else of the workflow is recorded by `warden`.
- **REQ-WARDEN-093** Safe start (protocols §9): when the boot report (fd 8) carries `x-safeStart: true` (the owner chose "safe start" at the `kl-initrd` prompt, boot spec §4.12), `warden` MUST mount every app data unit (`/home/<human>/.apps/<app>/{config,data,state}`) read-only in app views until the owner releases an app (`warden` CLI `safe-start release <app>`, facet `admin`), and record `safeStart: true` in the `boot` receipt; `atrium` reads the same flag to suppress session restore and automatic reopening. The flag only restricts: code and configuration are verified exactly as on a normal boot, and safe start changes only how writable state is exposed.
- **REQ-WARDEN-091** Receipt delivery:
  - receipts MUST be submitted asynchronously, in the submitted form of protocols §13.1;
  - the in-memory queue is bounded at 65 536 entries and is persisted to `/var/lib/keylos/warden/receipt-spool` when `ledger` is unavailable;
  - if the spool reaches 64 MiB, new spawns of `agent` principals MUST be refused with `kl:unavailable`; other spawns continue.

---

## 4. Design

### 4.1 Process architecture

| Process | UID | Threads | Role | Restart |
|---|---|---|---|---|
| `warden` (core, PID 1) | 0 | 2 (main and reaper) | Holds the registry, the kl-exec map fds, the service BPF programs, links and maps (the only task allowed `BPF_PROG_LOAD` after hand-over, protocols §9.3), and the `kmod` module loads; reaps; owns shutdown; restarts the supervisor and spawner | Kernel panic on exit (`panic=10` reboots) |
| `warden-supervisor` | 0 | tokio multi-thread, 4 workers | capwire server for `Supervisor` and `warden-sys`; route wiring; service state machine; client of `depot`, `broker`, `ledger`, `journal`, `strata`, `net`, `devd` | Restarted by the core; state is reloaded from the core |
| `warden-spawner` | 0 | 1 (strictly single-threaded) | Executes SpawnPlans (`clone3`, child setup sequence, `execveat`) and namespace operations (attach/detach grant mounts, build mapping namespaces) | Restarted by the core |

The core is deliberately small (target under 8 000 lines of Rust):
- It never parses capwire.
- It talks to the supervisor over a private `SOCK_SEQPACKET` pair with a fixed binary protocol of length-prefixed, postcard-encoded `CoreMsg` values (§4.1.1).
- All untrusted input (capwire from principals) is handled by the supervisor.

**Why the spawner is a separate process.** A multi-threaded tokio process cannot safely run arbitrary code between `clone` and `exec`. The spawner is single-threaded, allocation-free on the child path, and receives fully resolved SpawnPlans: all fds already opened, all strings already validated.

#### 4.1.1 Core ↔ supervisor protocol

| Message | Direction | Content |
|---|---|---|
| `Register{session, principal, uid, cgroup_id, cgroup_path, pidfd, tier, gen, jit, on_revoke, trusted_terminal}` | sup → core | Adds a principal instance; the pidfd travels via SCM_RIGHTS |
| `Unregister{session}` | core → sup | The cgroup became empty (the core watches `cgroup.events` `populated 0` via inotify) |
| `ExecMap{op: AddSb\|DelSb\|AddJit\|DelJit\|AddDebug\|DelDebug, key, value}` | sup → core | kl-exec map updates; the core performs `bpf(BPF_MAP_UPDATE_ELEM / DELETE_ELEM)`. `AddDebug` carries `{tracer_cgroup_id, target_cgroup_id, expires_boottime_ns, scope}` and fails if the tracer already has an entry |
| `LoadServiceBpf{service, paths}` / `ServiceBpfLoaded{service, maps: [(name, fd)]}` | sup → core / core → sup | Loads and attaches a service's BPF objects (§4.6.5); map fds of exportable maps travel back via SCM_RIGHTS |
| `LoadKmod{gen_index, paths, params}` / `KmodResult{per_module_errno}` | sup → core / core → sup | `finit_module` of release-signed modules from a registered `kmod` mount (§4.9.4) |
| `PcrExtend{phase}` / `PcrExtended{phase, ok}` | sup → core / core → sup | PCR11 phase extension through `/dev/tpmrm0` (§4.12); refused if the phase was already extended this boot or out of order |
| `MntNs{session, fd}` | sup → core | The mount-namespace fd of a principal (kept by the core for `attachGrant`, `mountView` and `/etc` rebuilds) |
| `Snapshot` / `SnapshotReply{registry, services, uid_allocator, mntns_fds, journal_dups}` | sup ↔ core | Full state, sent to a restarted supervisor |
| `Shutdown{kind: poweroff\|reboot}` | sup → core | Starts the shutdown sequence |
| `SpawnerFd{fd}` | core → sup | The control socket of a newly (re)started spawner |

### 4.2 Data structures

```rust
struct PrincipalInstance {
    principal: PrincipalId,        // canonical text
    session: SessionId,            // last element of the chain
    parent: Option<SessionId>,
    actor: ActorKind,
    human: Username,               // "_system" for services
    uid: u32,                      // dynamic
    cgroup_path: String,           // relative to /sys/fs/cgroup
    cgroup_id: u64,                // inode number of the cgroup dir
    leader: PidFd,
    mntns: OwnedFd,                // mount namespace of the principal (for grant mounts)
    tier: Tier,
    generation: GenRef,
    gen_name: String,
    feature_level: FeatureLevel,
    routes: Vec<RouteEnd>,         // server ends handed out, for cleanup
    grant_mounts: Vec<GrantMount>, // attached /grants/<name>
    tokens_roots: Vec<TokenRootId>,// root IDs of the child's tokens (from registerSession)
    label: Label,                  // initial label (current label is owned by broker)
    transaction: Option<String>,   // strata transaction id
    confinement: ConfinementReport,
    started: Timestamp,
    on_revoke: OnRevoke,           // Kill | Freeze
    trusted_terminal: bool,        // member of the trusted-terminal tree (REQ-WARDEN-029)
    recorded_tier: Tier,           // the principal's tier as reported by identify (t2/t3 for VM principals)
    vm: Option<VmBinding>,         // set for VM principals created on facet bench (§4.11)
    pod: Option<PodBinding>,       // set for pod principals (§4.16)
    debug: Option<DebugBinding>,   // set for DebugAttach debuggers (§4.17)
}

struct VmBinding { image: GenRef, purpose: VmPurpose, helpers: Vec<PidFd> }      // all helpers share one scope
struct PodBinding { pod_id: String, namespace: String, name: String, pidns: Option<OwnedFd> }
struct DebugBinding { grant_id: String, target_cgroup_id: u64, scope: DebugScope, expires: Instant }

struct RouteEnd { connection_id: u64, service: ServiceName, facet: String }
struct GrantMount { name: String, read_only: bool, source_dev_ino: (u64, u64) }

struct UidAllocator {             // bitmap over 0x00100000..=0x0FFEFFFF (0x0FFF0000 reserved, protocols §10.3), lazily allocated in 64 KiB chunks
    next_hint: u32,
    quarantine: VecDeque<(u32, Instant)>,
}
```

The registry is keyed by session (`HashMap<SessionId, PrincipalInstance>`), with secondary indexes by `cgroup_id`, by `uid` and by human. The core and the supervisor both hold copies; the core's copy is authoritative for crash recovery.

### 4.3 Spawn pipeline

`Supervisor.spawn(spec)` (and the `UserSpawn`, `TrustedSpawn` and `LegacySpawn` variants) run the steps below. Steps 1–11 run in the supervisor; steps 12–13 run in the spawner and its child.

1. **Caller identity.** Resolve the caller from the connection (the registered peer principal). The caller becomes the parent (REQ-WARDEN-010).
2. **Validate the spec.** Check:
   - the generation ref kind;
   - the env names (REQ-WARDEN-007);
   - the fd mapping targets: unique, ≥ 0, `target` ≤ 1023, and not colliding with route fds;
   - the session (REQ-WARDEN-009);
   - that `entrypoint` (default `main`) exists in the manifest;
   - for `SpawnSpec.transaction`, the syntax `x-<ULID>`.
3. **Resolve the generation.** Call `depot.get(gen)`, parse the manifest with `keylos-formats` (protocols §6.3 validation), and check `launchable`, `revoked`, the revocation list (§4.9.3) and `requiresFeatureLevel`. When `launchable` is false, the spawn fails with `kl:integrity` and the error text lists `launchReasons` (for example `needs-consent`, `quorum-deferred`, `kernel-mismatch`).
4. **Reproducibility exception.** If `reproducible: false`, or `launchReasons` contains `unreviewed-tier2`, look for records of kind `reproducibility` matching `name` and `publisher` (and `generation`, when not null) in `/etc/keylos/exceptions/*.dsse` of the booted config generation (protocols §20.9; `warden` is a listed reader in protocols §10.7). Verify each with `keylos-presence` against the owner-presence keys of the boot trust set (quorum envelopes on quorum machines), then check `expires` against trusted time. Without a valid record, the t2 floor applies.
5. **Register the session** (REQ-WARDEN-008): `BrokerSystem.registerSession`. On error, return the same error. Keep `tokens`, `label` and `tierFloor`. If `SpawnSpec.transaction` is set, the owner check of REQ-WARDEN-082 step 1 runs before this step, so a foreign transaction never reaches `broker`.
6. **Effective tier** (REQ-WARDEN-004). If t2 or t3, call `BrokerSystem.sessionEnded(session, "kl:unsupported:t<n>")` and fail with `kl:unsupported:t<n>` (REQ-WARDEN-005).
7. **Allocate.** Allocate the UID, create the cgroup directory (§4.6.3), write limits, and obtain the device plan with `DeviceAdmin.plan(principal, tokens)`. Attach the device program (§4.7.4).
8. **Mounts.**
   - Obtain the generation tree with `depot.mount(gen)` and, if declared, the runtime tree; `depot.root(gen, "warden:running:<session>")` for each (protocols §7.3.8). The matching `unroot` happens when the last principal using that mount exits (REQ-WARDEN-041).
   - Register the superblocks in kl-exec (§4.9).
   - Build the **view plan** (§4.7): the list of detached trees and their target paths.
   - If `transaction` is set, resolve the views (REQ-WARDEN-082).
9. **Routes** (§4.8). For each permitted route:
   - create a socket pair;
   - deliver the server end via `ServiceHost.accept`;
   - record the client end.

   Add the `broker` and `warden` routes (REQ-WARDEN-031).
10. **Journal.** Create the journal stream pair, keep a duplicate of the journal-side end in the core registry, and hand it over with `JournalWarden.attach(principal, session, stream)`. After a journal restart, the supervisor re-attaches every live stream from the core's duplicates.
11. **Network.** Choose the netns:
    - from the pool (§4.14);
    - the host netns for tier-0 services with `network: "host"`, after including their UID in `NetPlumbing.setEgressUids`;
    - the cri network namespace for services with `network: "cluster"`: `warden` calls `NetPlumbingCluster.clusterNetns()` (route `net#plumbing`) once per boot after `net` is ready, keeps the returned netns fd, and `setns`es each such service into it; on a profile other than `server-k8s`, or if `net` returns an error, those services fail to start with `kl:unavailable` (REQ-WARDEN-058);
    - `deny` mode for transactions with `NetworkPolicy.deny`.

    Services listed in `services.json` with `localLink: true` (portal-print) have their UIDs included in `NetPlumbing.setLocalLinkUids`.
12. **Hand the SpawnPlan to the spawner.** The plan contains:
    - all fds (generation tree, runtime tree, data trees, transaction views, routes, journal, terminal, cwd, explicit fds, Bootstrap for services);
    - the namespace set;
    - the precompiled seccomp program, from the cache keyed by tier, arch and extras;
    - the Landlock rule list;
    - UID/GID;
    - ambient capabilities (tier 0 from `services.json`; debuggers per REQ-WARDEN-084; none otherwise);
    - securebits (REQ-WARDEN-029);
    - rlimits (`RLIMIT_RTPRIO`/`RLIMIT_RTTIME` per REQ-WARDEN-029a);
    - for tier-0 services, the `KEYLOS_BPF_FDS` map fds (REQ-WARDEN-056);
    - the argv/envp byte arrays;
    - the netns fd.
13. **Spawner.**
    - It runs `clone3` with `CLONE_PIDFD | CLONE_INTO_CGROUP | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWCGROUP`, plus `CLONE_NEWUSER` for legacy only (§4.10); `exit_signal = SIGCHLD`; `cgroup = <cgroup dir fd>`.
    - The child runs the setup sequence of §4.4.
    - The spawner returns the pidfd, the child's mount-namespace fd (opened by the child itself as `/proc/self/ns/mnt` after step 2 of §4.4 and sent to the spawner with `SCM_RIGHTS` at the start barrier; the spawner never opens `/proc/<pid>/ns/*` of another task), and a status-pipe result. The pipe is `O_CLOEXEC`, so EOF means a successful exec; otherwise the child writes a setup error.
14. **Register.** Send `Register` and `MntNs` to the core, emit `PrincipalEvent.spawned`, write the `spawn` receipt, and return a `Process` capability.

**No ptrace access.** `kl-exec`'s `ptrace_access_check` exempts no task (protocols §9.3), so the core, the supervisor and the spawner never use ptrace-guarded paths on other tasks: no `/proc/<pid>/{ns/*,root,cwd,fd,maps,mem,environ}`, no `PIDFD_GET_*_NAMESPACE`, no `setns` on a pidfd, no `pidfd_getfd`, `kcmp` or `process_vm_*`. They use pidfds (`pidfd_send_signal`, `waitid(P_PIDFD)`), `PIDFD_GET_INFO` (credentials, cgroup ID), `/proc/<pid>/{cgroup,status}` and cgroup files, and namespace fds the child or a mapping helper sends at spawn (§4.4 step 16, §4.7.3, §4.10). Writing a helper's `uid_map`/`gid_map` from the spawner is not ptrace-guarded and stays allowed.

If anything fails after step 5, `warden` rolls back:
- kill the cgroup and remove it;
- quarantine the UID;
- close the route server ends (`ServiceHost` sees EOF);
- unroot the generation;
- call `BrokerSystem.sessionEnded` with the failure code.

#### 4.3.1 Variants

| Entry point | Facet | Differences |
|---|---|---|
| `Supervisor.spawn` | `client`, `service`, `admin`, `compat` | Parent = caller. On facet `compat`, only entrypoints of generations whose manifest `name` is `io.keylos.compat*` may be spawned (its helper processes, including the per-app `open-broker`, §4.10) |
| `Supervisor.spawn` with `actorKind = service` | `service` | **Service children** (protocols §22.7): only from a tier-0 service and only for an entrypoint of the caller's **own** generation (`kl:denied` otherwise); for example `journal`'s unwinder. The child is `service:<svc>:<gen>@_system/<caller chain>/<new session>`, tier t0, seccomp `baseline-1` with none of the service's `services.json` privileges (no capabilities, extras, paths, devices or TPM), no routes other than the fds its parent passes, and `onRevoke kill`; it ends with its parent |
| `Supervisor.spawn` | `bench` | Only entrypoints of `io.keylos.bench*` generations. Creates or extends a **VM principal** (§4.11) instead of a child of bench |
| `UserSpawn.spawnForHuman(spec, human, initialLabel)` | `launcher`, `handler` | Parent = the human's current top-level `shell` session (§4.3.2); the initial label is raised to `max(registered label, initialLabel)` with `LabelAuthority` semantics through `registerSession` (`offered` tokens come from the spec) |
| `TrustedSpawn.spawnTerminal(spec, pty)` | `trusted-terminal` | `actorKind` MUST be `shell`; parent = the human's shell session; `pty` becomes the controlling terminal; the principal is the root of a trusted-terminal tree (REQ-WARDEN-029) |
| `LegacySpawn.spawnLegacy(spec, view)` | `compat` | §4.10 |
| `DebugAttach.attach(…)` | `broker` | §4.17 |
| `PodSpawn.spawnContainer(spec, pod)` | `cri` | §4.16 |

#### 4.3.3 Trusted-terminal tree membership

`trusted_terminal` is set on a new principal instance, and only then, when:
- the entry point is `TrustedSpawn.spawnTerminal`; or
- the entry point is `Supervisor.spawn` on facet `client`, the caller's registry entry has `trusted_terminal = true`, **and** the caller's actor kind is `shell`.

Every other entry point (including `Supervisor.spawn` by an app, service or legacy principal that is itself in the tree) produces `trusted_terminal = false`. The flag is never inherited by registry ancestry alone and cannot be requested in a `SpawnSpec`. The spawner sets the securebits from the flag (§4.4 step 9).

#### 4.3.2 The human's shell session

At login, `hearth` causes `atrium` (or the console login) to spawn the human's first `shell` principal through `TrustedSpawn` or `UserSpawn`. `warden` records it as the human's **current shell session**: the oldest live `shell` session of that human. `UserSpawn` and `TrustedSpawn` children extend that chain. If no shell session exists, `spawnForHuman` fails with `kl:not-found`.

### 4.4 Child setup sequence (inside the clone3 child, before exec)

The child is PID 1 of its new PID namespace. It still has full capabilities in the initial user namespace (except for legacy children, §4.10). The order below is normative.

1. **Parent-death signal.** `prctl(PR_SET_PDEATHSIG, SIGKILL)` relative to the spawner. If the spawner already died, `_exit(127)`.
2. **Mount namespace:**
   - make the inherited tree `MS_PRIVATE | MS_REC`;
   - create a tmpfs staging root with `fsopen("tmpfs")` (`mode=0755,size=64k`) and attach the generation tree with `move_mount(gen_fd, "", AT_FDCWD, "/newroot", MOVE_MOUNT_F_EMPTY_PATH)`;
   - `move_mount` each planned subtree: the runtime at `/usr`, the `/etc` tree, data trees, transaction views (§4.7.5), the `/tmp` tmpfs, the `/run/user/<uid>` tmpfs, the `/dev` tmpfs, and an empty `/grants` tmpfs (`mode=0755,size=4k`, propagation `MS_PRIVATE`);
   - `pivot_root` into the staging root, then detach the old root with `umount2(old, MNT_DETACH)`.
3. **`/proc`.** `fsopen("proc")`, `fsconfig(hidepid=invisible)`, `fsconfig(subset=pid)`, `fsmount`, `move_mount` to `/proc`. This works because the child is already in the new PID namespace.
4. **`/dev`.** A tmpfs `mode=0755,size=64k`:
   - `mknod` the allowed devices: null, zero, full, random, urandom, tty (if a terminal is given), plus the nodes from the devd plan, with owner = the dynamic UID and mode 0600;
   - create the symlinks `fd → /proc/self/fd` and `stdin`/`stdout`/`stderr`;
   - then `mount_setattr(MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NOEXEC)` on `/dev`.
5. **Network namespace.** `setns(netns_fd, CLONE_NEWNET)` with the chosen namespace, or keep the parent's for tier-0 services with `network: "host"`.
6. **Hostname.** `sethostname(gen_name_sanitised)`, at most 64 bytes.
7. **fds.** `close_range(3, ~0U, CLOSE_RANGE_UNSHARE)`, keeping only the plan fds, which the spawner placed at ≥ 1024 before `clone`. Then `dup3` each one to its target and close the originals.
8. **Terminal** (if given). `setsid()`, `ioctl(fd, TIOCSCTTY, 0)`, then `dup3` to 0/1/2 unless explicit mappings override.
9. **Credentials:**
   - `setrlimit(RLIMIT_RTPRIO)` and, for `needs.realtime`, `setrlimit(RLIMIT_RTTIME)` per REQ-WARDEN-029a, while still privileged;
   - `setgroups(0, NULL)`, then `setresgid(uid, uid, uid)` (the GID equals the dynamic UID);
   - set securebits `SECBIT_NOROOT | SECBIT_NOROOT_LOCKED | SECBIT_NO_SETUID_FIXUP | SECBIT_NO_SETUID_FIXUP_LOCKED | SECBIT_KEEP_CAPS_LOCKED | SECBIT_NO_CAP_AMBIENT_RAISE | SECBIT_NO_CAP_AMBIENT_RAISE_LOCKED | SECBIT_EXEC_RESTRICT_FILE | SECBIT_EXEC_RESTRICT_FILE_LOCKED`;
   - add `SECBIT_EXEC_DENY_INTERACTIVE | SECBIT_EXEC_DENY_INTERACTIVE_LOCKED` unless the plan is marked `trusted_terminal` (REQ-WARDEN-029);
   - for tier-0 services with capabilities in `services.json`, and for debuggers (REQ-WARDEN-084), omit `SECBIT_NO_CAP_AMBIENT_RAISE` until step 11;
   - then `setresuid(uid, uid, uid)`.
10. **Bounding set.** Drop every capability not in the declared ambient set: a `prctl(PR_CAPBSET_DROP)` loop over 0..=CAP_LAST_CAP.
11. **Ambient capabilities** (tier-0 services with declared capabilities, and debuggers): `capset` permitted and inheritable, then `PR_CAP_AMBIENT_RAISE` for each. Then lock `SECBIT_NO_CAP_AMBIENT_RAISE`.
12. `prctl(PR_SET_NO_NEW_PRIVS, 1)`.
13. **Landlock** (§4.4.1):
    - `landlock_create_ruleset` with the plan's handled rights and scopes;
    - `landlock_add_rule` for each `PATH_BENEATH` rule (the parent fds are the view mount roots, opened `O_PATH` after step 2) and each `NET_PORT` rule;
    - `landlock_restrict_self(ruleset, flags)`, where flags include `LANDLOCK_RESTRICT_SELF_TSYNC` when ABI ≥ 8, plus the `LOG_*` flags per the policy audit setting.
14. **W^X.** `prctl(PR_SET_MDWE, PR_MDWE_REFUSE_EXEC_GAIN)` unless `jit`.
15. **seccomp.** `seccomp(SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, prog)` with the plan's profile: `baseline-1` (or a tier-0 `baseline-1+<extras>` variant), `debug-1` for debuggers, `runtime-default` for sealed pod containers, the compat service's `baseline-1+<extras>` profile for compat's open-broker helper (§4.10). The filter is never installed with `SECCOMP_FILTER_FLAG_SPEC_ALLOW`.
16. **Start barrier.** Send the spawner the child's own namespace fds (`/proc/self/ns/mnt`, opened after step 2; a task's access to itself is not ptrace-checked) over the setup socket, signal readiness on the status pipe's companion eventfd and wait for "go". This lets the spawner record the mount namespace without opening `/proc/<pid>/ns/*` and, for legacy, write the user namespace maps first.
17. **Exec.** `execveat(entry_dirfd, entry_basename, argv, envp, 0)`. The status-pipe write end is `O_CLOEXEC`. On failure the child writes `{step, errno}` to the pipe and calls `_exit(127)`.

`execveat` and every later `mmap(PROT_EXEC)` are checked by `kl-exec` (protocols §9.3). The entrypoint file lives on an allowed overlay superblock.

#### 4.4.1 Landlock construction

```
handled_access_fs  = all FS rights of the detected ABI
handled_access_net = BIND_TCP|CONNECT_TCP (ABI≥4) | BIND_UDP|CONNECT_SEND_UDP (ABI≥10)
scoped             = SCOPE_ABSTRACT_UNIX_SOCKET|SCOPE_SIGNAL (ABI≥6)

rules (PATH_BENEATH):
  /           EXECUTE|READ_FILE|READ_DIR                      (generation + runtime, read-only mounts)
  /etc        READ_FILE|READ_DIR
  /proc       READ_FILE|READ_DIR
  /dev        READ_FILE|WRITE_FILE|IOCTL_DEV (ABI≥5) on planned device nodes only;
              READ_FILE|WRITE_FILE on null/zero/full/random/urandom/tty
  /tmp, /run/user/<uid>, $XDG_* dirs, /var/lib/<service> (services):
              READ_FILE|READ_DIR|WRITE_FILE|REMOVE_FILE|REMOVE_DIR|MAKE_DIR|MAKE_REG|MAKE_SYM|MAKE_SOCK|
              MAKE_FIFO|TRUNCATE|REFER|RESOLVE_UNIX(ABI≥9)
  /grants     READ_FILE|READ_DIR|WRITE_FILE|TRUNCATE|MAKE_REG|MAKE_DIR|MAKE_SYM|REMOVE_FILE|REMOVE_DIR|REFER
              (the highest possible grant; actual access is bounded by mount flags (ro) and by what is attached)
  transaction views: the rights of the base directory's rule
rules (NET_PORT):
  none for t1 apps (sockets arrive connected from gate)
  t0 services: per services.json privileges.ports (for example net: bind UDP 68, 546)
```

`EXECUTE` is granted only beneath read-only generation mounts. Writable directories never get `EXECUTE`, and are additionally mounted `noexec`.

#### 4.4.2 Compensations

| Missing feature | Compensation | Report entry |
|---|---|---|
| Landlock ABI < 9 (`RESOLVE_UNIX`) | The view contains no pathname sockets except those `warden` created; `/run/user/<uid>` is built fresh per principal | `unix-path-via-view` |
| Landlock ABI < 10 (UDP) | Private netns with only `lo`; all egress via `gate` sockets | `udp-via-netns` |
| Landlock ABI < 8 (TSYNC) | The spawner child is single-threaded at `restrict_self`, so no compensation is needed for the initial thread; recorded for audit | `tsync-single-thread` |
| No `PR_SET_MDWE` | The kl-exec anonymous-exec hook still enforces W^X | `wx-via-lsm` |

### 4.5 seccomp profile `baseline-1`

The profile is defined as data (`profiles/baseline-1.toml`) and compiled at build time into classic BPF for x86_64 and aarch64 with `seccompiler`. Architectures other than the native one are killed (`SECCOMP_RET_KILL_PROCESS` on `arch` mismatch), which also blocks the x32 ABI on x86_64.

**Allowed without argument filtering:**

| Category | Syscalls |
|---|---|
| I/O | `read write readv writev pread64 pwrite64 preadv pwritev preadv2 pwritev2 lseek sendfile splice tee copy_file_range fsync fdatasync sync_file_range fallocate fadvise64 ftruncate truncate` |
| Files | `openat openat2 close close_range fstat newfstatat statx faccessat faccessat2 getdents64 getcwd chdir fchdir mkdirat unlinkat renameat2 linkat symlinkat readlinkat fchmod fchmodat fchmodat2 fchown fchownat utimensat flock fcntl umask getxattr lgetxattr fgetxattr listxattr flistxattr llistxattr setxattr fsetxattr lsetxattr removexattr fremovexattr inotify_init1 inotify_add_watch inotify_rm_watch` |
| Memory | `mmap munmap mprotect mremap madvise msync mincore mlock mlock2 munlock mlockall munlockall brk membarrier memfd_create memfd_secret mseal` |
| Processes | `exit exit_group wait4 waitid getpid getppid gettid getpgid getpgrp getsid setpgid setsid getuid geteuid getgid getegid getresuid getresgid getgroups capget prlimit64 getrlimit getrusage times sched_yield sched_getaffinity sched_setaffinity sched_getparam sched_getscheduler sched_get_priority_max sched_get_priority_min getpriority setpriority execve execveat set_tid_address set_robust_list get_robust_list rseq pidfd_open pidfd_send_signal kill tgkill tkill` |
| Signals and time | `rt_sigaction rt_sigprocmask rt_sigreturn rt_sigsuspend rt_sigtimedwait rt_sigqueueinfo rt_tgsigqueueinfo sigaltstack nanosleep clock_nanosleep clock_gettime clock_getres gettimeofday time alarm getitimer setitimer timer_create timer_settime timer_gettime timer_getoverrun timer_delete timerfd_create timerfd_settime timerfd_gettime` |
| Events | `poll ppoll select pselect6 epoll_create1 epoll_ctl epoll_wait epoll_pwait epoll_pwait2 eventfd2 signalfd4 futex futex_waitv futex_wake futex_wait futex_requeue` |
| fds | `dup dup2 dup3 pipe2` |
| IPC | `shmget shmat shmdt shmctl semget semop semtimedop semctl msgget msgsnd msgrcv msgctl mq_open mq_unlink mq_timedsend mq_timedreceive mq_notify mq_getsetattr` (contained by the IPC namespace) |
| Sockets | `socketpair connect bind listen accept accept4 getsockname getpeername sendto recvfrom sendmsg recvmsg sendmmsg recvmmsg shutdown setsockopt getsockopt` |
| Misc | `uname sysinfo getrandom getcpu landlock_create_ruleset landlock_add_rule landlock_restrict_self restart_syscall`; `seccomp` (adding filters and `SECCOMP_GET_*` only) |
| x86_64 only | `arch_prctl` (`ARCH_SET_FS`, `ARCH_GET_FS`, `ARCH_SET_GS`, `ARCH_GET_GS`, `ARCH_GET_CPUID`, `ARCH_SET_CPUID`, `ARCH_REQ_XCOMP_PERM`); the legacy-numbered `access stat lstat open creat rename mkdir rmdir unlink link symlink readlink chmod chown lchown utime utimes poll select pipe dup2 epoll_wait epoll_create alarm getpgrp vfork fork` (same semantics) |

**Allowed with argument filters:**

| Syscall | Filter | Otherwise |
|---|---|---|
| `clone` | flags must not contain any of `CLONE_NEWNS CLONE_NEWUTS CLONE_NEWIPC CLONE_NEWUSER CLONE_NEWPID CLONE_NEWNET CLONE_NEWCGROUP CLONE_NEWTIME CLONE_INTO_CGROUP` | `EPERM` |
| `clone3` | always | `ENOSYS` (libc falls back to `clone`) |
| `socket` | domain ∈ {`AF_UNIX`, `AF_INET`, `AF_INET6`} | `EAFNOSUPPORT` |
| `ioctl` | request ∉ {`TIOCSTI` (0x5412), `TIOCLINUX` (0x541C), `TIOCSETD` (0x5423), `TIOCCONS` (0x541D)} | `EPERM` |
| `prctl` | option ∈ {`PR_SET_NAME PR_GET_NAME PR_SET_PDEATHSIG PR_GET_PDEATHSIG PR_SET_NO_NEW_PRIVS PR_GET_NO_NEW_PRIVS PR_GET_DUMPABLE PR_SET_DUMPABLE(0 only) PR_SET_VMA PR_SET_MDWE PR_GET_MDWE PR_CAPBSET_READ PR_GET_SECUREBITS PR_SET_TIMERSLACK PR_GET_TIMERSLACK PR_SET_THP_DISABLE PR_GET_THP_DISABLE PR_GET_TID_ADDRESS PR_SET_CHILD_SUBREAPER PR_GET_CHILD_SUBREAPER PR_PAC_RESET_KEYS PR_SET_TAGGED_ADDR_CTRL PR_GET_TAGGED_ADDR_CTRL PR_SVE_SET_VL PR_SVE_GET_VL PR_SET_SHADOW_STACK_STATUS PR_GET_SHADOW_STACK_STATUS PR_LOCK_SHADOW_STACK_STATUS`} | `EPERM` |
| `personality` | arg ∈ {`0`, `0xffffffff` (query)} | `EPERM` |
| `memfd_create` | flags must contain `MFD_NOEXEC_SEAL` or not contain `MFD_EXEC` | `EPERM` (defence in depth; `vm.memfd_noexec=2` also applies) |
| `mmap`/`mprotect` | `PROT_EXEC` allowed; kl-exec decides per file and per anonymous mapping | — |
| `setrlimit`/`prlimit64` | may only lower limits (enforced by the kernel without `CAP_SYS_RESOURCE`) | — |

**Explicitly denied with `EPERM`**, so that programs see a permission error rather than "not implemented":

`adjtimex clock_adjtime` (protocols §9.1: read-only calls too, since seccomp cannot inspect `struct timex`) `unshare setns mount umount2 pivot_root chroot fsopen fsmount fsconfig fspick move_mount open_tree mount_setattr open_tree_attr ptrace process_vm_readv process_vm_writev pidfd_getfd kcmp bpf perf_event_open userfaultfd keyctl add_key request_key kexec_load kexec_file_load init_module finit_module delete_module acct swapon swapoff reboot settimeofday clock_settime syslog quotactl quotactl_fd name_to_handle_at open_by_handle_at lookup_dcookie fanotify_init fanotify_mark iopl ioperm vhangup setuid setgid setreuid setregid setresuid setresgid setfsuid setfsgid setgroups capset mknod mknodat sethostname setdomainname io_uring_setup io_uring_enter io_uring_register vmsplice process_madvise move_pages migrate_pages mbind set_mempolicy set_mempolicy_home_node get_mempolicy nfsservctl uselib ustat sysfs _sysctl modify_ldt`

Every syscall not listed returns `ENOSYS`.

**Tier-0 extras:**
- A service entry in `services.json` may list additional syscalls in `privileges.syscalls`. They are compiled into a per-service profile `baseline-1+<digest>` and cached; `<digest>` is the lowercase hex SHA-256 of the extras' names (syscalls and `privileges.socketFamilies` entries together), sorted by bytes, each followed by `\n` (protocols §9.1; `keylos_formats::confinement::baseline_extras_profile`).
- Extras MUST NOT include `bpf`, `kexec_*`, `*_module`, `ptrace`, `process_vm_writev`, `io_uring_*`, `perf_event_open`, or any namespace or mount syscall. `warden` rejects such entries at service-table load. `process_vm_readv` is never accepted as an extra; the open broker gets it only through profile `openbroker-1` (below).
- Socket families beyond the baseline are requested with `privileges.socketFamilies` (for example `["AF_NETLINK:NETLINK_ROUTE", "AF_PACKET"]`). The compiler turns them into argument filters on `socket(domain, type, protocol)`.
- `warden` itself is not subject to `baseline-1` (§6.2).

**Profile `debug-1`** (protocols §9.1): `baseline-1` with `ptrace`, `process_vm_readv` and `perf_event_open` moved from the deny list to the allowed list, plus `bpf` for scope `kernel` only (`debug-1k`, compiled separately). The `ptrace` request argument is not filtered; the `kl-exec` `ptrace_access_check` hook bounds the target set.

**Profile `openbroker-1`** (protocols §9.1): `baseline-1` with `process_vm_readv` moved to the allowed list; `ptrace`, `process_vm_writev` and `pidfd_getfd` remain denied. Applied only to `compat`'s open-broker processes (REQ-WARDEN-08C). Without a `kl_debug_pairs` entry, which `warden` writes only at `LegacySpawn` (§4.10), `process_vm_readv` fails `EPERM` on every target.

**Profile `runtime-default`** (protocols §9.1, sealed pods): the intersection of `baseline-1` with the Kubernetes `RuntimeDefault` profile as shipped by the container runtime reference (the containerd/moby default list pinned at release time and recorded as `profiles/runtime-default.toml`). Every syscall in the intersection behaves as in `baseline-1`; syscalls allowed by `RuntimeDefault` but denied by `baseline-1` (for example `unshare`, `setns`, `mount`) stay denied with `EPERM`. A pod requesting `seccompProfile = "unconfined"` never reaches `warden` (default policy forbids it, protocols §16.1); a request for a localhost profile is mapped to `runtime-default`.

### 4.6 Services

#### 4.6.1 Service table (`/etc/keylos/services.json`)

The service table (`keylos.services/1`, protocols §20.16) is part of the verified config generation (rendered by `config`; the distribution's defaults ship in the default config modules and in the safe config of the OS generation). `warden` reads it at boot and on every config generation change. It is the only source of service privileges (REQ-WARDEN-050). Fields that protocols §20.16 does not list are `warden`-local and carry the `x-` prefix.

```json
{
  "schema": "keylos.services/1",
  "bootstrapGens": {"journal": "gen:fsv256:…", "ledger": "gen:fsv256:…", "depot": "gen:fsv256:…"},
  "services": {
    "net": {
      "generation": "gen:fsv256:…", "entrypoint": "main", "tier": 0, "perHuman": false,
      "uid": "dynamic", "network": "host", "writer": true,
      "privileges": {
        "capabilities": ["CAP_NET_ADMIN", "CAP_NET_BIND_SERVICE", "CAP_NET_RAW"],
        "paths": [{"path": "/sys/class/net", "access": "ro"}],
        "devices": ["dev:rfkill:*"], "tpm": false,
        "x-syscalls": [],
        "x-socketFamilies": ["AF_NETLINK:NETLINK_ROUTE", "AF_NETLINK:NETLINK_GENERIC", "AF_PACKET"],
        "x-ports": [{"proto": "udp", "bind": 68}, {"proto": "udp", "bind": 546}]
      },
      "bpf": ["/usr/lib/keylos/bpf/net/firewall.o"],
      "routes": [{"to": "vault", "facet": "net"}, {"to": "ledger", "facet": "writer"}],
      "readiness": {"timeoutSecs": 30}, "watchdogSecs": 0, "restart": "always",
      "x-start": "boot", "x-after": ["journal", "ledger"], "x-requires": ["ledger"],
      "x-reload": "call", "x-stopTimeoutSecs": 10,
      "x-health": {"kind": "capwire-probe", "intervalSecs": 15, "timeoutSecs": 3},
      "x-state": {"subvolume": "@var/lib/keylos/net"},
      "x-limits": {"memoryMax": "256M", "pidsMax": 256, "cpuWeight": 100},
      "x-localLink": false, "x-exclusive": false
    },
    "portal-files": {"generation": "gen:fsv256:…", "perHuman": true, "network": "none",
      "privileges": {"paths": [{"path": "/home/{human}", "access": "rw"}]}, "…": "…"}
  }
}
```

Field rules:

| Field | Values | Default |
|---|---|---|
| `bootstrapGens` | exactly `journal`, `ledger`, `depot`; MUST equal the boot trust set's `bootstrapGens` (protocols §20.1) | required |
| `entrypoint` | manifest entrypoint key | `main` |
| `tier` | `0` for every service except `pipewire`, `kubelet`, `kube-proxy` (`1`, protocols §19.1) | `0` |
| `perHuman` | `true`: one instance per logged-in human (principal human = that human; portals, `pipewire`) | `false` |
| `uid` | `dynamic` (the only value in 1.0) | `dynamic` |
| `network` | `none` (pooled netns with `lo`), `gate` (pooled netns, egress through gate sockets), `host` (host netns; only `net` and `gate`, protocols §20.16), `cluster` (the cri network namespace obtained from `NetPlumbingCluster.clusterNetns`; only `cri`, `kubelet`, `kube-proxy`, `server-k8s` only) | `none` |
| `writer` | `true` registers the service key as a ledger writer (read by `ledger`) | `false` |
| `privileges.capabilities` | ambient capabilities; `CAP_SYS_ADMIN`, `CAP_BPF`, `CAP_PERFMON`, `CAP_SYS_MODULE`, `CAP_SYS_PTRACE`, `CAP_SYS_RAWIO`, `CAP_MAC_ADMIN` are allowed only for services listed in the distribution's allowlist table (`/usr/lib/keylos/warden/capability-allowlist.json` in the OS generation) | `[]` |
| `privileges.paths` | bind-cloned host paths; `{human}` is substituted per instance for `perHuman` services (protocols §20.16) | `[]` |
| `privileges.devices` | device ID patterns planned through `devd` | `[]` |
| `privileges.tpm` | `true`: `warden` opens `/dev/tpmrm0` and passes the fd as `KEYLOS_TPM_FD` (REQ-WARDEN-059); the node itself is not in the view | `false` |
| `bpf` | BPF objects under `/usr/lib/keylos/bpf/<service>/` (REQ-WARDEN-056) | `[]` |
| `routes` | services this service itself calls, as `{to, facet}` pairs; each MUST name a facet that lists the service as holder in protocols §19.2, or be explicitly granted by policy | `[]` |
| `readiness.timeoutSecs` | time to `Bootstrap.ready` | 30 |
| `watchdogSecs` | `Bootstrap.watchdog` interval; 0 = none. The watchdog proves that the service's event loop runs (protocols §22.7): a host library such as `warden-svc` may ping from that loop; a service that needs work-level liveness pings from its work path and its host then does not ping on its own | 0 |
| `restart` | `always`, `on-failure`, `never` | `on-failure` |
| `x-start` | `boot`, `on-demand`, `manual` | `on-demand` |
| `x-after`, `x-requires` | ordering and hard dependencies (service names) | `[]` |
| `x-reload` | `call` (`ServiceHost.reload`), `restart` | `call` |
| `x-health.kind` | `capwire-probe` (the supervisor calls `Extensible.version` on a dedicated health connection), `watchdog` (the service calls `Bootstrap.watchdog`, or emits structured records with field `watchdog=1`, which `journal` reports through `JournalWarden.heartbeats`), `none` | `capwire-probe` |
| `x-state.subvolume` | service state directory (idmapped `_system` subvolume) | `@var/lib/keylos/<service>` |
| `x-limits` | `memoryMax`, `pidsMax`, `cpuWeight`, `ioWeight` | slice defaults |
| `privileges.x-syscalls`, `privileges.x-socketFamilies`, `privileges.x-ports` | seccomp extras (§4.5), socket families, Landlock port rules | `[]` |
| `x-localLink` | include the service's UID in `NetPlumbing.setLocalLinkUids` (portal-print, portal-discovery helpers) | `false` |
| `x-exclusive` | stop the old instance before a live generation swap | `false` |

Unknown non-`x-` fields are rejected, as are `x-` fields not in this table. A service table that fails validation is refused as a whole, and the previous one stays active.

#### 4.6.2 Service state machine

```
inactive ──start──► starting ──(Bootstrap.ready and first health OK, or 5 s with health kind none)──► running
running ──exit (restart policy)──► starting (after backoff)
running ──stop──► stopping ──(cgroup empty | timeout → cgroup.kill)──► inactive
starting|running ──10 failures / 5 min──► failed
failed ──control(start) | new generation──► starting
```

- `control(reload)` calls `ServiceHost.reload()`, or restarts the service when `reload` is `restart`.
- **Live generation swap.** When the service table names a new generation for a running service, `warden` starts the new instance, waits for health, routes new connections to it, and stops the old one with `ServiceHost.stop`. Services whose entry declares `"x-exclusive": true` (state ownership) are stopped first.

#### 4.6.3 cgroup layout and controllers

```
/sys/fs/cgroup/keylos.slice/
  system.slice/<service>.scope                       (single-instance services)
  system.slice/<service>@<human>.scope               (per-human services)
  user-<uid>.slice/
    shell.slice/<session>.scope
    apps.slice/<session>.scope[/<child-session>.scope ...]   (tier-2 app VM principals also live here)
    agents.slice/<session>.scope/...                 (agent VM principals and aide host-side helpers)
    benches.slice/<session>.scope                    (tier-3 workbench, media, captive and build VM principals)
    legacy.slice/<session>.scope
  guest-<id>.slice/…                                 (same sub-slices for an ephemeral guest human; removed at logout)
  kube.slice/<pod-id>.slice/<container-or-vm>.scope  (pods; subtree delegated to cri, §4.16)
```

A VM principal's scope holds every host process of that VM (crosvm, device backends, `bench-net`, `bench-relay`, `bench-gpu`), each in a leaf sub-scope `<session>.scope/<helper>.scope` so that `cgroup.kill` and `cgroup.freeze` on the VM session apply to all of them (§4.11).

- Enabled controllers: `cpu io memory pids cpuset`.
- Every scope gets `memory.oom.group=1`, `memory.max`, `pids.max`, `cpu.weight` and `io.weight` from `Limits` (or the service entry), clamped by per-slice ceilings from the config (§10).
- A child spawned by a principal becomes a nested scope under its parent's scope. That makes `cgroup.kill` and `cgroup.freeze` on a session apply to its sub-sessions (REQ-WARDEN-042).
- `wallSecs > 0` arms a timer that kills the scope when it expires.

#### 4.6.4 `/etc` rebuild on config change

1. `warden` computes each running service's new `/etc` view (§4.7.1 rules) from the new confext.
2. If the view differs from the current one, it builds the new tree detached, then swaps it in the service's mount namespace with `move_mount(new, "", mntns-relative "/etc", MOVE_MOUNT_BENEATH)` followed by `umount2(old, MNT_DETACH)`.
3. It then calls `ServiceHost.reload()` (REQ-WARDEN-055).

Apps keep their `/etc` view until they restart.

#### 4.6.5 Service BPF programs

Run by the core (`LoadServiceBpf`), once per service per boot, before that service's first start (REQ-WARDEN-056):

1. **Resolve.** Each path in the entry's `bpf` list is opened with `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)` beneath `/usr/lib/keylos/bpf/<service>/`. `fstat` MUST show a regular file whose `st_dev` is the OS generation's registered superblock.
2. **Parse.** The ELF object is parsed with `aya-obj`. Each program section name selects the program type and attachment:

   | Section prefix | Program type | Attachment |
   |---|---|---|
   | `lsm/<hook>` | `BPF_PROG_TYPE_LSM` | BPF LSM hook `<hook>` (for example strata's `lsm/inode_init_security` provenance program) |
   | `cgroup_skb/ingress`, `cgroup_skb/egress` | `CGROUP_SKB` | the service's own scope, or `/keylos.slice` when the object's `.keylos` section says `attach: "slice"` (gate accounting, net firewall helpers) |
   | `cgroup/connect4`, `cgroup/connect6`, `cgroup/sendmsg4`, `cgroup/sendmsg6`, `cgroup/sock_create` | `CGROUP_SOCK_ADDR` / `CGROUP_SOCK` | as above |
   | `tracepoint/<cat>/<name>` | `TRACEPOINT` | the tracepoint |

   Any other section (XDP, kprobe, fentry, struct_ops, `cgroup/dev`, `sk_*`, `lsm_cgroup` on other services' cgroups) fails the load and the service does not start.
3. **Maps.** Maps are created by the loader. A map is **exportable** if the object's `.keylos` section lists it under `export` and its type is `BPF_MAP_TYPE_RINGBUF` or a `BPF_MAP_TYPE_ARRAY` with `BPF_F_MMAPABLE` (REQ-WARDEN-057). Non-exportable maps stay inside the core.
4. **Load and attach.** `BPF_PROG_LOAD` and `BPF_LINK_CREATE` by the core (thread-group ID 1, allowed by `kl-exec`'s `bpf` rule). Link fds are kept; nothing is pinned in bpffs.
5. **Hand-off.** Exportable map fds go to the supervisor (`ServiceBpfLoaded`), which places them in the service's fd table at the next free fds and sets `KEYLOS_BPF_FDS=<map name>=<fd>[,…]`. The same map fds are handed to every later instance of the service in this boot.

Programs stay attached until shutdown. A BPF load failure fails the service's start (`failed` state, critical log) without affecting other services.

### 4.7 Mount views

#### 4.7.1 View plan for tier-1 apps

| Target | Source | Flags |
|---|---|---|
| `/` | `depot.mount(app gen)` | ro, nosuid, nodev (exec permission comes from kl-exec; noexec is not set) |
| `/usr` | `depot.mount(runtime gen)` if declared, attached with plain `move_mount` | ro, nosuid, nodev |
| `/etc` | tmpfs with bind-clones of each file listed in `/etc/keylos/app-visible.list` (`open_tree(OPEN_TREE_CLONE)` per file) | ro, nosuid, nodev, noexec |
| `/tmp` | `fsopen("tmpfs")`, `size=` per policy (default 1 GiB), `mode=1777` | nosuid, nodev, noexec |
| `/run/user/<uid>` | tmpfs `mode=0700`, uid = the dynamic UID; contains `wayland-0` (bind-clone of the socket inode prepared by `atrium` through `Display`) and `pipewire-0` if granted | nosuid, nodev, noexec |
| `$XDG_CONFIG_HOME` etc. | idmapped clones of `/home/<human>/.apps/<name>/{config,data,cache,state}` | nosuid, nodev, noexec, idmap human → dynamic |
| `/grants` | empty tmpfs; grants are attached at runtime (§4.7.6) | nosuid, nodev, noexec |
| `/dev` | tmpfs with device nodes (§4.4 step 4) | ro after population |
| `/proc` | procfs `hidepid=invisible,subset=pid` | nosuid, nodev, noexec |
| `/sys` | absent; a service needing sysfs declares `privileges.paths` for `/sys/...` subtrees, which are bind-cloned read-only | — |

XDG variables: `XDG_CONFIG_HOME=/home/app/config`, `XDG_DATA_HOME=/home/app/data`, `XDG_CACHE_HOME=/home/app/cache`, `XDG_STATE_HOME=/home/app/state`, `HOME=/home/app`, `XDG_RUNTIME_DIR=/run/user/<uid>`. `/home/app` is a tmpfs mount point that holds the four bind mounts.

When a unit of `strata` crypto-shredding covers the app's data subvolume, the source tree is obtained with `StrataAdmin.mountUnit(unit)` (facet `strata#warden`) instead of a plain `open_tree`, and then idmapped.

#### 4.7.2 Views for other actor kinds

| Actor | Differences from the app view |
|---|---|
| `service` | `/var/lib/keylos/<name>` from `x-state.subvolume` (an idmapped `_system`-owned subvolume → dynamic UID, protocols §10.1). No `/home` (per-human services see `/home/<human>` only through `privileges.paths` with `{human}`). `privileges.paths` bind-clones. The netns follows `network`. `/run/keylos/svc` is never visible. `/etc` is the full confext, read-only |
| `shell` | Like an app, plus the human's whole home as an idmapped mount at `/home/<human>` (rw, noexec). The OS generation is at `/` instead of an app generation (the shell runs from the OS or the `kish` generation). `/grants` is populated per command by `kish` through broker grants |
| `legacy` | §4.10 |
| `bench` (VMM and device-backend processes) | Service-like view, plus `/dev/kvm` and the shares passed as fds; the device plan comes from `devd` like any other |
| `agent` helper processes on the host | Same as app; agents' main execution is inside `bench` |

#### 4.7.3 Idmapped data mounts (`GrantMounts.idmappedDir`)

Files in human data directories are owned on disk by the human UID (1000–59999). Principals run under dynamic UIDs. `warden` presents the data through an idmapped detached tree:

1. `open_tree(dirfd, "", OPEN_TREE_CLONE | AT_EMPTY_PATH)` (non-recursive) of the source directory. The kernel clones only mounts of the caller's own mount namespace, and `dirfd` was opened in the requester's view (broker, bench, compat, cri), so the spawner runs this step in a helper that `setns`es into the **requester's** mount namespace (from the fd `warden` captured at the requester's spawn) and passes the detached tree back; the spawner itself stays in the host namespace.
2. Create, or reuse from the cache keyed by (from, to), a **mapping user namespace**. The spawner forks a helper with `clone(CLONE_NEWUSER)`; the helper sends its own user-namespace fd (`/proc/self/ns/user`) back over a socket pair; `warden` writes `uid_map` `<from> <to> 1` and the same for `gid_map` (the kernel maps an on-disk ID through a mount idmapping from the first column to the second, so files owned by `<from>` appear owned by `<to>`), and kills the helper. The userns fd is held only by `warden`; no process runs inside it (REQ-WARDEN-023).
3. `mount_setattr(tree, "", AT_EMPTY_PATH, {attr_set: MOUNT_ATTR_IDMAP | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC [| MOUNT_ATTR_RDONLY], userns_fd})`.
4. Return the tree fd.

`idmappedDir(dir, forPrincipal, readOnly)` (facets `broker`, `bench`, `compat`) runs these steps for the principal's dynamic UID. Files created through an idmapped mount by the dynamic UID are stored on disk as owned by the human UID, so on-disk ownership stays stable across principal instances.

#### 4.7.4 Devices

- `DeviceAdmin.plan(principal, tokens)` returns the `NodePlan` list (stable ID, canonical name, kind, major, minor) for the devices the principal's tokens grant.
- Nodes are created in the view's `/dev` under the canonical name (for example `/dev/dri/renderD128`).
- The cgroup device program allows exactly those numbers with `rw`; `m` (mknod) is denied.
- `needs.gpu: "render"` is planned by `devd` from the corresponding broker-issued device token (granted at install consent).

#### 4.7.5 Transaction views

For `SpawnSpec.transaction = x-…` (REQ-WARDEN-082):

1. Call `StrataTxn.txnExt(id)` to get `(Transaction, TransactionExt)`. Call `TransactionExt.owner()` and apply the ownership check of REQ-WARDEN-082 (the spawner's session equals the owner or descends from it in the registry). Then call `TransactionExt.policy()` to get `(networkPolicy, views)`, where `views[i]` is the canonical live path (host path) of the i-th target directory the transaction was begun with.
2. Call `Transaction.view()` to get the overlay `O_PATH` dirfds in the same order. For each `i`, `open_tree(viewfd_i, "", OPEN_TREE_CLONE | AT_EMPTY_PATH)`.
3. **Target selection.** For each `i`, if `views[i]` lies at or below a path that the child's planned view maps 1:1 from the host (for a `shell`, `/home/<human>` is such a path), the overlay tree is mounted at `views[i]` in the child's view. The child then sees the transaction view exactly where it would otherwise see the real directory. Otherwise the tree is attached at `/grants/txn-<i>`, and the mapping is listed in the confinement report.
4. Apply `MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC` and an idmap to the dynamic UID.
5. `strata` answers `txnExt` on facet `warden` only for transactions in state `Open`. Any other answer fails the spawn.

#### 4.7.6 Runtime grant mounts (`GrantMounts.attachGrant` / `detachGrant`)

```
attachGrant(session, name, tree, readOnly, ceiling):
  p   = registry[session]                                      (kl:not-found otherwise)
  t   = tree is warden-idmapped for p.uid ? tree : idmappedDir(tree, p.principal, readOnly)   (OPEN_TREE_CLONE, never AT_RECURSIVE)
  mount_setattr(t, ATTR_NOSUID|NODEV|NOEXEC [|RDONLY])
  if ceiling: kl_grant_ceiling[mnt_id(t)] = ceiling           (before move_mount, REQ-WARDEN-08D)
  spawner: setns(p.mntns) in a dedicated helper thread (CLONE_FS unshared);
           move_mount(t, "", AT_FDCWD, "/grants/<name>", MOVE_MOUNT_F_EMPTY_PATH)   (mkdir /grants/<name> on the tmpfs first)
           inView = open("/grants/<name>", O_PATH|O_DIRECTORY|O_CLOEXEC)            (through the holder's namespace)
  record GrantMount; update the confinement report "grants"
  return (inView, "/grants/<name>")
```

`detachGrant` reverses this with `umount2("/grants/<name>", MNT_DETACH)` and `rmdir` inside the holder's namespace, and removes the mount's `kl_grant_ceiling` entry after the unmount (fds opened through it stay subject to the ceiling check until closed, because the read check is keyed by the mount the file was opened through). Grant mounts are attached at runtime, so the holder's Landlock rule for `/grants` (REQ-WARDEN-021) already covers them. Mount flags bound the actual access.

### 4.8 Route wiring

For each `needs.services` entry and each route that policy grants this principal:

1. **Facet check.** Determine the facet: `default` for portal services, `client` for services that define it, and otherwise the facet named in the route. Check that protocols §19.2 lists the principal's actor kind or service name as a holder, or that the principal holds `right("service", "<svc>#<facet>", "use")` (verified through the tokens returned by `registerSession`). Denied routes are omitted and listed in the confinement report as `routes.denied`.
2. **Instance.** If the target service is single-instance, use its running instance or start it (REQ-WARDEN-035). If it is per-human, use the instance for the child's human.
3. **Socket pair.** `socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC)`, then `SO_SNDBUFFORCE` and `SO_RCVBUFFORCE` of 4 259 840 bytes on **both** ends (REQ-WARDEN-092; `keylos-capwire` `route_pair`). Send the server end with `ServiceHost.accept(socket, connectionId, facet, peer, tier, generation)`. Those arguments are the **only** identity the server has for the connection: on a warden-created socketpair `SO_PEERPIDFD` names `warden` itself (protocols §7.1).
4. **Client end.** Place it in the child's fd table and append `<name>=<fd>` to `KEYLOS_CAPWIRE_FDS`, where `<name>` follows the route-name table of protocols §10.5 (`<service>` for facets `client`/`default`, `broker#principal` and `warden#service`; otherwise `<service>#<facet>`). Services adopt these fds, fd 3, `KEYLOS_BPF_FDS` and `KEYLOS_TPM_FD` with the `keylos-capwire` inherited-fd helper, so no binary needs `unsafe` for it.

`connectionId` is a 64-bit counter starting at a random value per boot. `Supervisor.connectionInfo` answers from the registry; its `label` field follows §5.1.

### 4.9 kl-exec integration

`boot` loads the `kl-exec` BPF LSM program in the initrd and hands its five maps to `warden` as fds 3–7 across `switch_root`, in the order given by the command line `keylos.execmapfds=3,4,5,6,7` (`kl_exec_allowed_sb`, `kl_exec_jit_cgroups`, `kl_exec_policy`, `kl_exec_events`, `kl_debug_pairs`; protocols §9.3). The map contract is protocols §9.3 (§2.15 above). `boot` writes `warden_tgid = 1` (PID 1 keeps its thread-group ID across `switch_root` and `execve`) and freezes `kl_exec_policy` before the hand-over; `warden` only verifies it (REQ-WARDEN-070).

#### 4.9.1 Registering a generation

For every generation tree `warden` mounts or obtains from `depot` (apps, runtimes, services, `bench` and `compat` helpers, legacy images):

1. **Tree.** Obtain the tree from `depot.mount(gen)`. For the bootstrap generations (`journal`, `ledger`, `depot`, listed in `trust.json` `bootstrapGens`), mount it as in §4.12.1, checking the image digest.
2. **Statement.** Read the generation statement envelope from `/store/evidence/<64 hex>/statement.dsse` (protocols §10.7; the DSSE envelope carries every authorising signature). Verify (protocols §20.7):
   - the DSSE payload is a `keylos.genstmt/1` whose `generation` equals the ref and whose `kind` equals the manifest kind;
   - `issued` ≤ trusted time + 24 h (REQ-WARDEN-074);
   - at least one signature verifies with a key from the boot trust set (`/run/keylos/boot/trust.json`), using the key class required for the generation's origin: `releaseStream` for distro generations (kinds `os`, `runtime`, `service`, `bench-image`, `agent-template`, `kmod`, distro `app`s), `publishers` for publisher apps and org-publisher `container` generations (the publisher entry's `scope` MUST be `org:<org>` for kind `container`), `ownerSeal` for owner-sealed generations (accompanied by a valid `keylos.seal/1` statement, protocols §11.6);
   - no authorising key is listed in the revocation list's `keys[]` with `after` ≤ `issued` (protocols §11.7), unless another authorising signature by a non-revoked key also verifies.
3. **Revocations.** Check the generation is not `unlaunchable` in the current revocation list (§4.9.3).
4. **Superblock.** `statx(tree_fd, "", AT_EMPTY_PATH, STATX_BASIC_STATS)` gives `stx_dev_major` and `stx_dev_minor`. Send `ExecMap{AddSb, s_dev, gen_index}`, where `gen_index` is a dense per-boot index into the supervisor's generation table.

Verification results are cached per generation digest for the boot. A cache entry is dropped when a revocation list changes.

Kind-specific rules: a `kmod` generation is registered only when `kmod.kernel` equals the running release (REQ-WARDEN-075); a `container` generation only when the registration is requested for `PodSpawn` (§4.16); `config` and `policy` generations are never registered (they contain no executable content and are mounted `noexec`).

#### 4.9.2 Denial events

`kl-exec` denial events are read from the ring buffer, written to the journal at level `warning` with the principal resolved from the cgroup, and counted in metrics. With `kl_exec_policy.audit_allow = 1` (debug builds only), allowed events are logged too.

#### 4.9.3 Revocation list source

- Before `depot` runs, `warden` reads `/store/revocations/<stream>.dsse` (stream from `trust.json`; protocols §10.7). It verifies the signature against `trust.json` `keys.releaseStream` and requires `serial ≥ trust.json.revocationsSerial`.
- After `depot` is healthy, `warden` refreshes from `depot.revocations()` every 60 s and on `PrincipalEvent`-independent triggers (`depot` closing and reopening the mounter connection). A list is accepted only if its serial is ≥ the current one.

#### 4.9.4 Out-of-tree kernel modules (`kmod` generations)

- The enabled `kmod` **names** are listed in `/etc/keylos/warden.json` (`kmods`, §10), written by `config` from the owner's selection (for example the NVIDIA open modules, ADR-0057). Names, not generation refs, are configured so that an OS update to a new kernel needs no config change: `courier` installs the matching `kmod` generation while staging.
- At boot, after `depot` is healthy and before `devd` starts, the supervisor picks for each name the newest installed, launchable `kmod` generation (`depot.list("kmod", name)`) whose manifest `kmod.kernel` equals the running release, mounts it (`depot.mount`), registers it (REQ-WARDEN-075, §4.9.1) and asks the core to load its modules in `kmod.modules` order (`LoadKmod`). A name without a matching generation is logged as `kmod-missing` and skipped.
- The core opens each `/lib/modules/<uname>/extra/<module>.ko` inside the mount with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` and calls `finit_module(fd, params, 0)`. The kernel enforces the release stream's module signature (`module.sig_enforce=1`); `kl-exec`'s `kernel_read_file` hook requires the file's superblock to be registered. A module that fails is logged with its errno and the remaining modules of that generation are skipped; the boot continues.
- Firmware listed in `kmod.firmware` is reachable to the kernel's firmware loader only through the registered mounts: `warden` builds one read-only overlay at `/run/keylos/kmod/firmware` whose lower layers are the `lib/firmware` trees of the enabled `kmod` generations, registers that overlay's superblock as well, and writes the path once to `/sys/module/firmware_class/parameters/path` before loading any module.

### 4.10 Legacy tier

`compat` calls `LegacySpawn.spawnLegacy(spec, view, brokerSession)` (facet `compat`). `view` is a `LegacyView`: the `legacy-image` generation, a per-image state directory, grant trees and the network mode. Differences from §4.4:

- **User namespace.** `clone3` adds `CLONE_NEWUSER`. The spawner writes `uid_map`/`gid_map` from a 65 536-UID block allocated in `0x10000000–0x7FFEFFFF`; container UID 0 maps to the block base. After the spawner wrote the maps at the start barrier, the child itself writes `0` to `/proc/sys/user/max_user_namespaces` (its own user namespace's limit; it still holds `CAP_SYS_RESOURCE` there) before dropping capabilities (REQ-WARDEN-023); the spawner never reaches into the child through `/proc/<pid>/root`.
- **Mount view.** The legacy image (ro, registered in kl-exec), an overlay upper and work directory on `view.stateDir` (rw; noexec on the host side, and the same noexec applies inside the namespace), and the `view.grants` trees attached at their `target` paths, idmapped from the human UID to the container's "user" UID (block base + 1000).
- **seccomp.** `baseline-1`, plus a **user-notification filter** on `openat`, `openat2`, `open`, `creat`, `execve` and `execveat`. The notification filter is installed **after** the deny filter, so denied syscalls never reach the listener. The listener fd is returned as `notifyFd` to `compat`, which runs the open broker.
- **Open-broker pairing** (protocols §9.3). `compat` runs one `open-broker` helper per legacy app, spawned through `Supervisor.spawn` on facet `compat` before `spawnLegacy`, each in its own scope and always with seccomp profile `openbroker-1` (`warden` applies it to every process `compat` spawns with entrypoint `open-broker`; REQ-WARDEN-08C). `spawnLegacy`'s `brokerSession` names that helper's session; it MUST be a live session spawned by `compat`, not already paired, or the call fails with `kl:invalid`. At spawn `warden` writes a `kl_debug_pairs` entry `{tracer = open-broker cgroup, target = legacy app cgroup, scope = process, expires = u64::MAX, mode = read}`; for that pair `kl-exec`'s `ptrace_access_check` permits `PTRACE_MODE_READ` and `PTRACE_MODE_ATTACH_REALCREDS` (the mode the kernel uses for `process_vm_readv`), while `openbroker-1` keeps `ptrace`, `process_vm_writev` and `pidfd_getfd` denied, so the pairing yields read-only memory access. The entry is deleted when either cgroup is removed. One open broker serves exactly one legacy app, because the map holds one target per tracer (REQ-WARDEN-076).
- **Landlock.** As §4.4.1, with the view roots.
- **Capabilities.** A legacy process MUST NOT have any `CAP_*` in the initial user namespace. It may be root inside its own namespace, but the seccomp deny list still blocks mount and namespace syscalls, so namespace root gains no access to the risky kernel paths.
- **Network.** `netMode = "none"`: pooled netns with only `lo`. `"pasta"`: pooled netns where `compat`'s pasta helper (spawned by `compat` through `Supervisor.spawn` on facet `compat`) forwards to a `gate` `ShimEndpoint`.
- **Tier.** Per protocols §9.2, only forge-built reproducible legacy images signed by a trusted key run on the host. `spawnLegacy` fails with `kl:unsupported:t2` for any other image.

### 4.11 Tier-2 and tier-3 requests and VM principals

`warden` never starts a t2 or t3 workload's code on the host (REQ-WARDEN-005). The error tells the requester to use `bench`:

| Requester | Path for t2/t3 |
|---|---|
| `atrium` launcher | `Bench.start` on `bench#user` with `display = true` |
| `kish` | `Bench.start` or `Bench.project` on `bench#user` |
| `compat` | `Bench.start` on `bench#compat` |
| `aide` | `Bench.start` on `bench#aide` |
| `cri` | `Bench.start` on `bench#cri` (purpose `pod`) |

**VM principals** (protocols §3.4, §7.5.1 `VmSpawn`). Every VM is a principal of its own. `bench` creates it and its host processes only through `VmSpawn` (facet `bench`):

1. **`register(vm :VmPrincipal)`** (REQ-WARDEN-08B):
   - **parent and human:** `vm.parentSession` MUST be live; every token in `vm.offered` MUST name it as holder. The principal is `<actor>@<parent's human>/<parent's chain>/<vm.session>`. For `principalKind = pod`, the parent MUST be the `cri` service session and the human is `_cluster`. `aide` and the atrium launcher therefore offer tokens held by the launching human's (or the agent chain's) session, never tokens pre-delegated to the not-yet-registered VM session.
   - **actor text:** `agent:` + `vm.template` for `agent`; `pod:<ns>/<name>:` + `vm.image` for `pod` (pod identity from the `cri` session's pod registration, keyed by `vm.podId`); `<kind>:` + `vm.image` otherwise.
   - **recorded tier:** `vm.tier` (`t2` for purposes `app` and `pod`, `t3` otherwise; a mismatch with `vm.purpose` fails with `kl:invalid`). `identify` and `ConnectionInfo.tier` report it; host confinement of the helper processes is the t0 baseline plus the bench entry's privileges.
   - **cgroup:** `user-<uid>.slice/apps.slice` (t2 apps), `agents.slice` (agent), `benches.slice` (other t3), or `kube.slice/<pod-id>.slice` (pod), under the parent's human; scope `<vm.session>.scope`; a dynamic UID is allocated.
   - **narrowing:** when `vm.checks` is non-empty, warden appends them to every token of `vm.offered` as one Biscuit attenuation block (offline, `keylos-biscuit`; protocols §7.5.1, §8.3) before registration, so the VM principal can never hold more than the narrowed tokens. `vm.budgets` are forwarded unchanged in `SessionReg.budgets` (protocols §7.5.2); the broker carves them as hard sub-meters before issuing the VM's tokens, and warden aborts the registration if the broker returns `kl:budget`.
   - `BrokerSystem.registerSession(child = VM principal, parent = vm.parentSession, offered = <vm.offered, narrowed>)`; `onRevoke` is `kill` for `agent` and `pod`, `freeze` otherwise. The returned tokens are those the broker issued to the VM principal.
2. **`spawnVmm(session, spec)`:** `spec.generation` MUST be the `bench` generation and `session` a principal registered by this `bench` instance. Each process (crosvm, `bench-fs`, `bench-net`, `bench-relay`, `bench-gpu`) is placed in a new leaf scope `<session>.scope/<entrypoint>-<n>.scope`, runs under the VM principal's dynamic UID, and gets no new `registerSession`. `warden` wires routes for that principal by entrypoint: `bench-net` → `gate#shim`; `bench-relay` → `broker#principal`, `vault#app`, `portal-*#default` (every portal service of the parent's human) and, for agent VMs, `aide#host`. Each route's `ServiceHost.accept` names the VM principal as the peer.
3. **`unregister(session)`:** allowed only after the scope has no processes; ends the principal as REQ-WARDEN-041. If the scope empties without `unregister`, `warden` ends the principal anyway after 5 s and logs `vm-unregister-missing`.
4. `Vm.fork(ForkSpec)` and `Bench.reattach` (protocols §7.3.13) are `bench`'s; a fork is a new `register` with `parentSession` = the forked VM's parent, its own fresh session, and `offered`/`checks`/`budgets` copied from the `ForkSpec` (empty `offered` = the source VM principal's tokens, which warden reads from its session record).

`bench`'s own service process (`benchd-host`) is an ordinary tier-0 service; it holds no VM authority.

### 4.12 Boot sequence

1. **Hand-off.** The initrd (`boot`) executes `/usr/lib/keylos/warden` as PID 1 after `switch_root` (phase `leave-initrd` already extended by `boot`). The map-fd order is read from `keylos.execmapfds=` in `/proc/cmdline` (protocols §9.3) and MUST equal the argv copy; a mismatch is fatal. `warden` receives:
   - fds 3–7 = kl-exec maps (`keylos.execmapfds=3,4,5,6,7`);
   - fd 8 = the boot report pipe (`keylos.bootreport/1`, protocols §20.1; §13.1 note N3);
   - the btrfs subvolumes already mounted by `boot`: `/store` (read-only), `/var`, `/home`, `/keystore`, `/snapshots` (all `nosuid,nodev,noexec`);
   - argv `["warden", "keylos.execmapfds=3,4,5,6,7", "keylos.bootreportfd=8"]`.
2. **Core setup.**
   - Verify the kl-exec policy map (REQ-WARDEN-070).
   - Mount `/run` (if not moved), `/sys/fs/cgroup` (cgroup2, `nsdelegate,memory_recursiveprot`) and `/sys/fs/bpf`.
   - Verify (by `statx` and `/proc/self/mountinfo`) that `/var`, `/home`, `/store`, `/keystore` and `/snapshots` are btrfs mounts of the unlocked volume with `nosuid,nodev,noexec`; remount `/store` read-write with `mount_setattr` (only `depot` and the bootstrap mounts write there). A missing or wrongly flagged mount is fatal (§7).
   - Set the runtime sysctls listed by the `keylos` distribution spec that are not on the command line.
   - Create `keylos.slice`. The core stays in the root cgroup; the supervisor and spawner go to `keylos.slice/warden.scope`.
   - **Extend PCR11 `sysinit`** (`PcrExtend`), REQ-WARDEN-064.
   - Start the spawner and the supervisor.
3. **Load configuration.** The supervisor reads `/run/keylos/boot/trust.json`, the service table `/etc/keylos/services.json` (§4.6.1), `/etc/keylos/policy.ref` and `/etc/keylos/warden.json`. If the boot report says `safeConfig: true`, the service table comes from the safe config of the OS generation. The service table's `bootstrapGens` MUST equal `trust.json`'s; a mismatch is fatal (§7).
4. **Bootstrap mounts and BPF.** Mount the three bootstrap generations itself (§4.12.1) using the digests in `bootstrapGens`, register them in kl-exec after statement verification (§4.9.1), and load the service BPF programs of the bootstrap services (§4.6.5).
5. **Extend PCR11 `ready`** (`PcrExtend`), REQ-WARDEN-064. From here on no component extends PCR11; secrets sealed to `ready` become available to the tier-0 services `warden` starts next and to nothing that ran before this point.
6. **Bootstrap services.** Start them in this fixed order; each waits for health before the next starts:
   1. `journal` (with its log directory);
   2. `ledger`;
   3. `depot`.
7. **Remaining services.** Load the service BPF programs of every other service (§4.6.5), mount and load the enabled `kmod` generations (§4.9.4), then start the remaining `x-start: "boot"` services in topological order with maximal parallelism. In the default service table the order is: `broker`, `vault`, `hearth`, `strata`, `devd`, `net`, `gate`, `courier`, `config`, the portals, `atrium` (graphical profiles), `bench`, `compat`, `aide`, and on `server-k8s` `cri`, `kubelet`, `kube-proxy`. `broker` is a hard dependency for every principal spawn: until `broker` is running, only services that `warden` starts itself can start, and `registerSession` calls for them are replayed once `broker` is up. The policy generation named by `policy.ref` is mounted read-only at `/policy` in `broker`'s view, and `broker`'s start fails if the mounted generation's manifest digest differs from `policy.ref` (protocols §20.17).
8. **Late wiring.**
   - After `net` is healthy, call `NetPlumbing.setEgressUids` and `setLocalLinkUids` with the UIDs of the current host-network and local-link services.
   - After `ledger` is healthy, write the `boot` receipt (spooled before).
9. **Login.** In graphical profiles (`desktop`, `laptop`, `kiosk`), `atrium` starts the greeter (or kiosk autologin). In headless profiles (`server`, `server-k8s`, `cloud`, `appliance`), `hearth` enables console login per config.

The recovery profile does not run `warden`: `boot` extends `enter-recovery` instead of `leave-initrd` and starts the recovery environment's own PID 1 (protocols §19.6).

#### 4.12.1 Bootstrap composefs mount (without depot)

```
fd_img  = open("/store/gens/<hex>.erofs", O_RDONLY)
check   FS_IOC_MEASURE_VERITY(fd_img) == <hex>             (else refuse: kl:integrity)
fs_ero  = fsopen("erofs"); fsconfig(source=/proc/self/fd/<fd_img>); fsconfig(ro); m_ero = fsmount()
fs_ovl  = fsopen("overlay")
fsconfig(fs_ovl, FSCONFIG_SET_FD, "lowerdir+", m_ero)
fsconfig(fs_ovl, FSCONFIG_SET_STRING, "datadir+", "/store/objects")
fsconfig(fs_ovl, "metacopy", "on"); fsconfig("redirect_dir","follow"); fsconfig("verity","require")
m_ovl   = fsmount(fs_ovl, 0, MOUNT_ATTR_RDONLY|MOUNT_ATTR_NOSUID|MOUNT_ATTR_NODEV)
```

#### 4.12.2 First boot

When `/var/lib/keylos/firstboot/bundle.json` exists, `warden` waits for each consumer named in protocols §20.13 (hearth, vault, ledger, courier, config, strata, vouch, fleet) to report its part done. A consumer reports by calling `Bootstrap.status("firstboot:done")`. Once every present consumer has reported (absent services count as done), `warden` deletes the file with `unlinkat` followed by `fsync` of the directory. Until then, the greeter shows "Finishing setup".

### 4.13 Shutdown

1. A shutdown is requested by `Supervisor.control("_system", poweroff)` or `Supervisor.control("_system", reboot)` on facet `admin` (protocols §7.3.2, §19.1), from the CLI, `devd` power handling or `atrium`. `_system` is the registered pseudo-target; it cannot collide with service names, which start with `[a-z]`. Every other op on `_system` fails with `kl:invalid` (REQ-WARDEN-065).
2. Stop new spawns: they fail with `kl:unavailable`.
3. Freeze, then kill, the principal scopes in this order: `kube.slice` (pods; `cri` is asked to stop pods first through its `ServiceHost.stop`), then in each `user-*.slice` and `guest-*.slice`: agents, benches, legacy, apps, shell. Each gets `SIGTERM` to the cgroup, a 5 s grace period and `cgroup.kill`. Debugger pairs are removed before their scopes are killed.
4. Stop services in reverse topological order: `ServiceHost.stop(reason)`, then `SIGTERM`, then `cgroup.kill` after `stopTimeoutSecs`.
5. Write the `shutdown` receipt. `ledger` is stopped last among services, after `strata`. Then stop `ledger`, `depot` and `journal`.
6. Core teardown:
   - `sync()`;
   - unmount every non-root mount in reverse order (lazy for busy ones);
   - close the LUKS mappings via device-mapper ioctls (`DM_DEV_SUSPEND`, then `DM_DEV_REMOVE`);
   - `reboot(LINUX_REBOOT_CMD_POWER_OFF | RESTART)`.

   kexec is never used: the IPE policy denies it (protocols §9.3).

Total budget: 30 s. Overrunning it escalates to an immediate `cgroup.kill` of every remaining scope.

### 4.14 Network namespace pool

- The spawner maintains a pool of `netnsPoolSize` (default 8) network namespaces:
  - created with `unshare(CLONE_NEWNET)` in a helper thread;
  - `lo` brought up via `rtnetlink`;
  - their fds held by the spawner.
- A namespace is consumed per principal and never reused. When the pool falls below half, it is refilled asynchronously.
- Tier-0 services with `network: "host"` share the host namespace. Those with `network: "gate"` get a pooled namespace and their sockets from `gate`.

### 4.15 Confinement report assembly

The report (protocols §9.4) is assembled at spawn and updated on `attachGrant` and `detachGrant`. `tlsInterception` is filled on every `Process.confinement` call from `GateDebug.interception(session)` on route `gate#debug` (protocols §7.5.12). If `gate` is unavailable or does not answer within 200 ms, `tlsInterception` is `{"active": false, "hosts": []}` and `compensations` gets the entry `tls-state-unknown`.

Other fields: `tier` is the recorded tier (VM principals report t2/t3); `seccompProfile` names the installed profile (`baseline-1`, `baseline-1+<digest>` for tier-0 services, `debug-1`, `debug-1k`, `openbroker-1`, `runtime-default`; protocols §9.4); on a development kernel below KL1 the report states the truth (for example `landlockAbi` 6) and therefore does not validate, which is expected (protocols §9.4); `grants` lists the attached `/grants/<name>` paths and transaction views; pods add `"pod": {"id", "namespace", "name"}` and debuggers `"debug": {"grant", "scope", "expires"}` as `x-` extension fields (`x-pod`, `x-debug`).

### 4.16 Sealed pod containers (`PodSpawn`)

`cri` calls `PodSpawn.spawnContainer(spec, pod)` on facet `cri` for the `keylos-sealed` runtime class (protocols §21.2). `keylos-vm` pods never reach this path; they are VM principals (§4.11).

1. **Checks** (REQ-WARDEN-086): generation kind `container`, actor kind `pod`, `cgroupParent` below `/keylos.slice/kube.slice/`, the generation statement signed by an enabled `org-publisher` key (§4.9.1). `spec.env` is taken as the container environment (the secret-pattern check is skipped for `actorKind = pod`, protocols §7.3.2, REQ-WARDEN-007; reserved `KEYLOS_*` names are still rejected).
2. **Principal.** `pod:<pod.namespace>/<pod.name>:<gen>@_cluster/<cri session>/<new session>` registered with `parent` = the `cri` service session and `onRevoke = kill`.
3. **Pod namespaces.** The first container spawned for a `podId` creates the pod's **IPC and UTS namespaces** (hostname = `pod.name`) and, when `sharePid` is true, the pod's PID namespace; `warden` keeps their fds in `PodBinding` until the pod's last container exits. Later containers of the same pod join them; without `sharePid` each container gets its own PID namespace. The network namespace is always `pod.netns` (provided by `cri`, inside the cri network). No user namespace is ever created for a container process.
4. **cgroup.** `<cgroupParent>/<session>.scope`. The subtree `/keylos.slice/kube.slice` is delegated to `cri`: `warden` creates it at boot owned by `cri`'s dynamic UID (cgroup v2 delegation: `cgroup.procs`, `cgroup.subtree_control`, `cgroup.threads` writable by `cri`), and `kubelet` gets read-only access for stats. `warden` still creates every container scope itself so that `PrincipalEvent`s and `cgroup.kill` stay authoritative.
5. **Mount view.** The container generation at `/` (ro); `pod.mounts` attached at their `target` paths (`MOUNT_ATTR_NOSUID|NODEV|NOEXEC`, plus `RDONLY` when requested), idmapped to the container's dynamic UID; `/proc` (`hidepid=invisible,subset=pid`), `/dev` (baseline nodes plus any devd-planned nodes), and `/dev/shm`, `/tmp`, `/run`, `/var/tmp` as noexec tmpfs. The root is always read-only (protocols §21.8): `readOnlyRoot = false` is honoured only by those tmpfs mounts. `PodMount.tmpfsBytes > 0` volumes (configMap, secret, projected, downwardAPI) are materialised as sized tmpfs copies (REQ-WARDEN-08A).
6. **Identity.** The container process runs as a dynamic UID. `pod.runAsUid` is the UID the image's files are owned by: the rootfs and `pod.mounts` are idmapped so that files owned by `runAsUid` (and by 0) appear owned by the process's dynamic UID. `getuid()` returns the dynamic UID.
7. **Confinement.** Landlock as for apps (the container root `EXECUTE|READ_*`, tmpfs and writable volumes read-write without `EXECUTE`), seccomp `runtime-default`, no capabilities, `no_new_privs`, both exec securebits, kl-exec registration of the container generation's superblock. No capwire routes are installed (`KEYLOS_CAPWIRE_FDS` is empty); `KEYLOS_PRINCIPAL`, `KEYLOS_SESSION` and `KEYLOS_TIER` are set.
8. **Exec.** CRI `Exec`/`ExecSync` reach `warden` as `PodSpawn.execInContainer` (REQ-WARDEN-088): a child session of the container principal that joins all the container's namespaces and its cgroup, so it sees the container's tmpfs and volume state.
9. **Egress shim.** With `cluster.egressViaGate`, `cri` obtains the pod's `ShimEndpoint` with `PodSpawn.egressShim(podId)` (REQ-WARDEN-089) and runs its egress redirector with it.
10. **Lifecycle.** `cri` observes exits through `Process.wait` and `PrincipalControl.events` (pod sessions only) and kills containers with `Process.kill` or `PrincipalControl.terminate`. Receipts `spawn`/`exit` are written by `warden` with `actorKind = pod`; pod admission receipts are `cri`'s.

### 4.17 Debug attach (`DebugAttach`)

`broker` calls `DebugAttach.attach(target, scope, debugger, entrypoint, argv, pty, expiresSecs, grantId, requester)` after minting a `Right.debug` grant (T3 with presence, protocols §9.3).

1. **Validate** (REQ-WARDEN-083): scope and duration limits; `debugger` launchable and its manifest `name` in `debug.debuggers`.
2. **Requesting human.** `requester` names the principal the grant was minted to; its human is the requesting human and its shell session (the nearest `shell` ancestor in the registry) becomes the debugger's parent. The `pty` MUST be a pty secondary owned by that human's UID (`fstat`); a non-live requester fails with `kl:not-found`, a foreign pty with `kl:invalid`.
3. **Target.**
   - `session:s-…`: the session MUST be live and belong to the requesting human (or to an agent session tree owned by that human); the target cgroup is that session's scope.
   - `gen:fsv256:…`: the newest live session of the requesting human running that generation; none → `kl:not-found`. The grant covers later instances, so the human can attach again.
4. **Spawn** the debugger as a child of the human's current shell session (actor kind `app`, tier t1), with `pty` as its controlling terminal, seccomp `debug-1` (scope `process`) or `debug-1k` (scope `kernel`), ambient capabilities per REQ-WARDEN-084, and a view that adds the target's generation tree read-only at `/debug/target` (symbols, sources) next to the debugger generation.
5. **Pair.** Before the debugger is released from the start barrier, the core writes `kl_debug_pairs[debugger cgroup] = {target cgroup, now + expiresSecs (CLOCK_BOOTTIME), scope}` (`ExecMap AddDebug`). Pairs never outlive the boot.
6. **Expiry.** A timer at `expiresSecs` runs REQ-WARDEN-085. Revocation of the grant (`PrincipalControl.terminate` on the debugger session by `broker`) does the same with reason `revoked`.
7. **Receipts.** `debug.attach` (`data`: `grant`, `target`, `targetCgroupId`, `scope`, `debugger`, `expires`) and `debug.detach` (`data`: `grant`, `reason`, `durationMs`).

### 4.18 Workflow attempts

```
loom (service, facet warden#service)
  1 BrokerWorkflow.claim(binding{wf, wa, epoch e, step, owner}, generation G, spawner = loom's session)   # loom → broker
  2 Supervisor.spawn(SpawnSpec{generation G, entrypoint, session "", grants [], attempt binding})        # loom → warden
warden
  3 REQ-WARDEN-094: caller is service loom on facet service, else kl:denied
  4 REQ-WARDEN-096: generate S (fresh ULID, never seen this boot)
  5 principal := <actor of G>@<binding.owner>/<loom chain>/S
  6 BrokerSystem.registerSession{child, parent = loom session, offered [], onRevoke kill, attempt = binding}
       broker: binding is the current claim, G and the parent match the claim, owner matches the record;
       label := join(default, workflow label) → tokens minted from the workflow record   (protocols §20.25)
       refusal → spawn fails with the broker's code; no cgroup, UID or mount exists
  7 normal spawn pipeline (§4.3) with the returned tokens and label; route loom#attempt bound to S (REQ-WARDEN-098)
  8 spawn receipt with data.attempt
```

Agent attempts follow the same rule through `VmSpawn.register` (REQ-WARDEN-097): `aide` sets `VmSpec.attempt`, `bench` copies it into `VmPrincipal.attempt`, and `warden` forwards it.

A stale attempt process that is still alive (it missed a cancellation or its `loom` connection) keeps its cgroup until the broker's revocation of its roots terminates it (`PrincipalControl.terminate`, `onRevoke = kill`) or REQ-WARDEN-09A kills it; neither its tokens nor its `loom#attempt` connection let it act after a newer claim.

**Development supervisor (`warden-lite`, stages S2 and S3).** `warden-lite` has no automatic service restart (`ServiceStatus.restarts` is always 0) and no confinement. It implements REQ-WARDEN-094 to REQ-WARDEN-098 for the durability proof of stage S3 (Phase B of durable execution): the `conformance/s3-loom` harness tears down the whole process stack and relaunches it against the same persistent stores (`/var/lib/keylos/{loom,broker,ledger,vault,hearth}`) with new sessions and a new broker root key, which stands in for a service restart and a reboot until the full `warden` restarts services itself.

## 5. Interfaces

### 5.1 `Supervisor` (protocols §7.3.2)

Facets and holders are fixed by protocols §19.2 (§2.22):

| Facet | Methods served |
|---|---|
| `client` | `spawn` (child of the caller's session), `identify` |
| `service` | `spawn`, `identify`, `connectionInfo`; `FdStore` (via `Extensible.ext`) |
| `admin` | all `Supervisor` methods (including `control("_system", poweroff\|reboot)`); `PrincipalControl` |
| `broker` | `GrantMounts`, `PrincipalControl`, `ServiceConnect`, `DebugAttach` |
| `compat` | `spawn` (compat generation entrypoints only), `LegacySpawn`, `GrantMounts.idmappedDir` |
| `bench` | `spawn` (bench generation entrypoints only; VM principals, §4.11), `GrantMounts.idmappedDir` |
| `strata` | `PrincipalControl.events`, `mountView`, `fenceWriters` |
| `hearth` | `PrincipalControl.terminate` (sessions of the locking human, REQ-WARDEN-044) |
| `portals` | `GrantMounts.attachGrant`/`detachGrant` (portal-island grants) |
| `launcher`, `handler` | `UserSpawn` |
| `trusted-terminal` | `TrustedSpawn` |
| `cri` | `PodSpawn`; `GrantMounts.idmappedDir`; `PrincipalControl.terminate`/`events` (pod sessions only) |

Method semantics beyond protocols:
- `spawn`: §4.3. Latency budgets are in §8.
- `identify`: REQ-WARDEN-032; cached in the supervisor and invalidated on `Unregister`.
- `connectionInfo`: REQ-WARDEN-034. `label` is the live session label from `LabelAuthority.labelOf(session)` on `broker#label-authority` (`warden` is a registered holder, protocols §19.2), cached for at most 1 s; if `broker` is unavailable the last known label is returned. Before a session's first successful `registerSession` there is no known label; the placeholder is the lattice bottom `public/trusted`, which is reachable only for services `warden` starts itself while no `broker` is running (S2-style tables without broker, and the first services of a boot before `broker`).
- `services`, `control`: §4.6; `control("_system", poweroff|reboot)` is shutdown (§4.13).
- `Process.pidfd` returns `kl:unsupported` for processes that are not on the host (never the case for processes `warden` spawned).

### 5.2 `warden-sys` interfaces (protocols §7.5.1)

| Interface | Facet(s) | Notes |
|---|---|---|
| `Bootstrap` | fd 3 of every tier-0 service | `host` MUST be first; `ready` moves the service to `running` (with health); `watchdog` resets the watchdog timer; `status(text)` updates the status line (and reports first-boot completion, §4.12.2) |
| `ServiceHost` | (client side) | §4.8; `reload` per REQ-WARDEN-055; `stop` before `SIGTERM` |
| `GrantMounts` | `broker` (all), `portals` (`attachGrant`/`detachGrant` for portal-island grants), `bench`, `compat` and `cri` (`idmappedDir`) | §4.7.3, §4.7.6 |
| `PrincipalControl` | `broker`, `admin` (all; `events(…, replay)` per REQ-WARDEN-047); `hearth` (`terminate` of its human's sessions); `strata` (`events`, `mountView`, `fenceWriters`, REQ-WARDEN-08F); `cri` (`terminate`, `events` for pod sessions) | `mountView` returns JCS `[{target, source, flags, grant}]`, where `source` is a human-readable description (`gen:fsv256:…`, `home:alice/.apps/x/config`, `grant:<name>`, `txn:x-…`). `events` carries `cgroupId` (REQ-WARDEN-045) |
| `ServiceConnect` | `broker` | REQ-WARDEN-036 |
| `FdStore` | `service` | Keys are scoped per service name; at most 64 fds per service; all are dropped at shutdown; they survive service restarts within one boot only, so no service may rely on them across power loss or reboot (`vault` no longer does: its epoch rotation uses two NV indices, protocols §19.6) |
| `LegacySpawn` | `compat` | §4.10 (`brokerSession`, `openbroker-1`) |
| `UserSpawn` | `launcher`, `handler` | §4.3.1 |
| `TrustedSpawn` | `trusted-terminal` | §4.3.1, §4.3.3 |
| `DebugAttach` | `broker` | §4.17 |
| `PodSpawn` | `cri` | §4.16 (`spawnContainer`, `execInContainer`, `egressShim`) |
| `VmSpawn` | `bench` | §4.11 (`register`, `spawnVmm`, `unregister`) |

**Service control socket.** Every tier-0 service receives fd 3: a capwire connection to `warden-supervisor` whose bootstrap capability is `Bootstrap` (REQ-WARDEN-054). The service MUST call `host()`, then `ready()` once it can serve. Its other `warden` facets (`service`, plus `broker`, `compat`, `bench`, `strata`, `hearth`, `portals`, `launcher`, `handler`, `trusted-terminal`, `cri` or `admin` as listed for it in protocols §19.2) arrive as additional routes in `KEYLOS_CAPWIRE_FDS` under the names `warden` (facets `client` and `service`) or `warden#<facet>` (protocols §10.5).

### 5.3 CLI `warden`

The CLI is the multicall binary invoked as `warden` by a process that is not PID 1. It talks to the supervisor through the `warden#admin` or `warden` (client) route in `KEYLOS_CAPWIRE_FDS`.

| Command | Description | Exit codes |
|---|---|---|
| `warden status` | Feature level, boot ID, uptime, OS and config generations, counts per tier | 0 ok, 2 unreachable |
| `warden services [--json] [--all]` | Table of services (name, state, generation, since, restarts) | 0 |
| `warden start\|stop\|restart\|reload <service>` | `control` | 0 ok, 1 denied, 3 not found, 4 failed state |
| `warden ps [--tree] [--human <name>] [--tier t0\|t1\|legacy] [--json]` | Principals with session, UID, cgroup, tier, generation name and memory | 0 |
| `warden inspect <session\|pid>` | Confinement report, routes, grant mounts, token root IDs and limits | 0, 3 not found |
| `warden view <session>` | `PrincipalControl.mountView` | 0, 1, 3 |
| `warden kill\|freeze\|thaw <session>` | `PrincipalControl.terminate` | 0, 1 denied, 3 not found |
| `warden spawn <gen-ref\|name> [--entry E] [-- args…]` | Spawn with the caller's grants (diagnostics) | Child exit code; 125 spawn failure; 126 tier requires bench |
| `warden exec-denials [--since T]` | Recent kl-exec denials | 0 |
| `warden poweroff\|reboot` | `control("_system", poweroff\|reboot)` (requires the `admin` facet) | 0 |
| `warden debug-pairs` | Live `kl_debug_pairs` entries with tracer, target, scope and remaining time | 0 |
| `warden bpf [--service S]` | Service BPF programs, links and exported maps (§4.6.5) | 0 |
| `warden pods` | Sealed pod containers and their pod bindings | 0 |
| `warden version` | Versions (`Extensible.version`) | 0 |

Common flags: `--json` (JCS machine output) and `--quiet`. Exit code 2 means the supervisor is unreachable; 64 means a usage error.

### 5.4 Files and sockets

| Path | Owner | Purpose |
|---|---|---|
| `/run/keylos/svc/<service>/` | warden, 0700 | Reserved directory per service (protocols §7.2); `warden` places no pathname sockets there in 1.0 |
| `/run/keylos/warden/state.json` | warden, 0600 | Diagnostic snapshot, written every 10 s |
| `/run/keylos/boot/trust.json`, `report.json` | boot | Boot trust set and report (read) |
| `/store/evidence/<64 hex>/statement.dsse` | depot | Generation statements (read, §4.9.1; protocols §10.7) |
| `/store/revocations/<stream>.dsse` | depot | Revocation list before `depot` runs (read, §4.9.3; protocols §10.7) |
| `/etc/keylos/exceptions/*.dsse` | config | Owner exceptions (read, §4.3 step 4) |
| `/etc/keylos/policy.ref` | config | Policy generation mounted for `broker` (read; protocols §10.7) |
| `/usr/lib/keylos/bpf/<service>/*.o` | pkgs (OS generation) | Service BPF objects (read; protocols §10.7) |
| `/usr/lib/keylos/warden/capability-allowlist.json` | OS generation (this repo) | Services allowed sensitive ambient capabilities (§4.6.1) |
| `/run/keylos/kmod/firmware` | warden | Read-only overlay of `kmod` firmware trees (§4.9.4) |
| `/var/lib/keylos/warden/receipt-spool/` | warden | Spooled receipts |
| `/var/lib/keylos/firstboot/bundle.json` | installer | First-boot bundle (deleted by warden, §4.12.2) |
| `/etc/keylos/services.json` | config | Service table (§4.6.1) |
| `/etc/keylos/warden.json` | config | Rendered warden configuration (§10) |
| `/etc/keylos/app-visible.list` | config | `/etc` files visible to apps (protocols §10.7) |

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| A principal escalates by creating namespaces (userns kernel attack surface) | seccomp denies every namespace syscall and flag; only `warden` creates namespaces; legacy userns has `max_user_namespaces=0` |
| A confused deputy in route wiring gives a principal a service it should not reach | Facets come only from the protocols registry or explicit `service` rights; facets are fixed by `warden` and reported to servers via `ServiceHost.accept` |
| A confused deputy in grant mounts (a symlink swap redirects a grant) | `attachGrant` takes a tree fd, never a path; the holder-side path is created on warden's own tmpfs |
| PID-reuse races in identity | All identity goes through pidfds and cgroup IDs; `identify` re-validates liveness |
| A malicious SpawnSpec (env injection, fd confusion) | Env name validation; reserved `KEYLOS_*`; explicit fd table; `close_range` |
| Exec of dropped binaries | kl-exec allows only registered superblocks of verified generations; writable mounts are noexec; W^X via MDWE plus the LSM |
| Interpreters fed code by non-humans | `SECBIT_EXEC_RESTRICT_FILE` everywhere and `SECBIT_EXEC_DENY_INTERACTIVE` everywhere except the trusted terminal tree (REQ-WARDEN-029) |
| Self-declared privileges in a service manifest | Privileges only from the owner-signed service table (REQ-WARDEN-050) |
| Escape via `/proc` | Fresh procfs per PID namespace with `hidepid=invisible,subset=pid`; no `/sys` for apps |
| TTY injection | `legacy_tiocsti=0`; seccomp denies `TIOCSTI` and `TIOCLINUX`; a new session per job |
| Device abuse | Device nodes only from the `devd` plan, plus the cgroup device program and Landlock `IOCTL_DEV` |
| Supervisor compromise via crafted capwire | Rust with no `unsafe` outside `keylos-capwire`; fuzzing (§11); the core/supervisor split |
| A compromised supervisor | The supervisor is UID 0, so a compromise is equivalent to root. Its attack surface is minimised: it accepts capwire only from registered principals, and parsing is bounded (4 MiB per message, 64 fds) |
| The spawner exploited by plan data | Plans come only from the supervisor over a private socketpair; the spawner validates lengths and counts |
| Denial of service by spawning | `pidsMax` per slice; a per-human spawn rate limit (default 50/s, burst 200); per-human UID quotas (default 65 536 concurrent) |
| A debugger outlives its grant or reaches other principals | One `kl_debug_pairs` entry per tracer cgroup, bounded by `expires`; removal before kill; `ptrace_access_check`/`perf_event_open`/`bpf` hooks key on the pair; `debug-1` only via `DebugAttach` |
| A service smuggles its own BPF program | Services never get `bpf()`; programs load only from the OS generation path listed in the owner-signed service table, by the core |
| A sealed pod escalates through Kubernetes features | No capabilities, no userns, read-only root, `runtime-default` seccomp, admission forbids in `broker` (protocols §16.1); `PodSpawn` refuses non-`container` generations and unsigned images |
| A bench helper impersonates another VM | VM principals exist only through `VmSpawn.register` (facet `bench`); helpers of one VM share that principal's scope and UID; `Supervisor.spawn` refuses sessions of registered VM principals |
| PCR11 manipulated after `ready` | `warden` extends only `sysinit` and `ready`, in order, once each; no principal gets a `/dev/tpmrm0` fd unless its service entry has `privileges.tpm`, and none gets the device node |

### 6.2 Self-confinement

- **`warden` core.** seccomp filter `warden-core`:
  - process and signal syscalls;
  - cgroupfs file operations;
  - `bpf` for map operations only (`BPF_MAP_UPDATE_ELEM`, `BPF_MAP_DELETE_ELEM`, `BPF_MAP_LOOKUP_ELEM`, `BPF_MAP_LOOKUP_AND_DELETE_ELEM` for the ring buffer, via an argument filter on `cmd`);
  - mount-family syscalls (used only during shutdown);
  - `reboot`, inotify, epoll, read/write;
  - no socket families other than `AF_UNIX`.
- **`warden-supervisor`.** No Landlock, because it needs `/store`, `/run`, `/sys/fs/cgroup` and `/etc`. seccomp profile `warden-supervisor`: `baseline-1` plus cgroupfs-relevant file operations; no namespace or mount syscalls. It holds full capabilities but cannot mount or create namespaces; only the spawner can.
- **`warden` core TPM access.** The core opens `/dev/tpmrm0` only for the two PCR11 extensions (§4.12) and closes it after `ready`.
- **`warden-spawner`.** seccomp profile `warden-spawner`: namespace and mount syscalls, `clone3`, credential syscalls, `pivot_root` and `mknod` are allowed; `bpf` is denied; no sockets except `AF_UNIX` and `AF_NETLINK:NETLINK_ROUTE` (for netns setup).

### 6.3 Privileges held

UID 0 with full capabilities in the initial user namespace. Creating namespaces, cgroups, UIDs, mounts and device nodes for every principal requires it. No other userspace component holds `CAP_SYS_ADMIN`.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| Core panic | Kernel panic, then reboot after 10 s. systemd-boot boot counting falls back after 3 failed tries (`courier`) |
| Supervisor crash | The core restarts it within 200 ms; registry state comes from `Snapshot`. Clients see disconnects of their `warden` connections; services keep their fd-3 `Bootstrap` socket, which the core holds a duplicate of and passes back to the new supervisor, so services need not restart |
| Spawner crash | The core restarts it. In-flight spawns fail with `kl:unavailable`; pooled netns are lost and recreated; mapping namespaces are recreated on demand |
| `depot` unavailable | No new generation mounts. Spawns of already-mounted generations continue: the cache holds mount fds per generation for 60 s after last use |
| `broker` unavailable | Spawns fail with `kl:unavailable`, except services `warden` starts itself (their `registerSession` is replayed later) |
| `ledger` unavailable | Receipts are spooled (REQ-WARDEN-091) |
| `journal` unavailable | fd 2 of new principals is connected to a pipe that the core drains to `/dev/kmsg` (rate-limited to 100 lines/s) until `journal` returns; existing streams are re-attached |
| `strata` unavailable | Spawns with `transaction` fail with `kl:unavailable`; units protected by crypto-shredding cannot be mounted (the spawn fails) |
| `devd` unavailable | Spawns that need devices fail with `kl:unavailable`; device-less spawns proceed |
| Invalid service table | Keep the previous service table; boot falls back to the safe config's service table if none is valid |
| Service dependency cycle | Boot into recovery: start only `journal`, `ledger`, `depot`, `hearth` and `atrium` (or a console login), with a critical notification |
| UID space exhausted | `kl:unavailable` for that human; a critical log entry is written |
| kl-exec maps not received | Boot refuses to continue: the core panics with the message `kl-exec missing`. The initrd guarantees the maps on KL1+ |
| Revocation list unreadable at boot | Bootstrap generations are mounted only if `trust.json.revocationsSerial` is 0; otherwise boot stops with a recovery prompt |
| PCR11 extension fails (`sysinit` or `ready`) | Fatal: the core logs to `/dev/kmsg` and powers off after 30 s (a boot whose PCR11 does not match the release predictions must not run tier-0 services that unseal secrets) |
| kl-exec policy not frozen or `warden_tgid ≠ 1` | Fatal, as above |
| Service BPF load fails | That service enters `failed`; dependants of it are not started; a critical notification is shown |
| `kmod` load fails | Logged with errno; boot continues; `devd` reports devices without drivers |
| `bootstrapGens` mismatch between `trust.json` and `services.json` | Fatal: boot stops with a recovery prompt |
| Debugger expiry timer missed (supervisor restart) | On restart the supervisor rescans `kl_debug_pairs` and applies REQ-WARDEN-085 to every expired entry within 1 s |
| `strata` dies holding a writer fence | The fence's capability is dropped with the connection; `warden` thaws the fenced sessions at once (REQ-WARDEN-08F); `strata` rolls the interrupted commit back from its journal on restart |
| Writer fence times out (30 s) | `warden` thaws the sessions; `strata`'s `PreparedMerge.commit` fails with `kl:unavailable` and rolls back if its journal had not reached `applied` |
| `loom` dies with attempts running | REQ-WARDEN-09A kills the attempt sessions it spawned, then `loom` restarts per its `restart` policy; the new instance claims fresh attempts (protocols §20.25) |
| `broker` refuses an attempt registration (`kl:conflict`, `kl:revoked`) | The attempt spawn fails with that code; nothing is created; `loom` handles the stale or cancelled workflow |
| `cri` dies with pods running | Sealed pod containers keep running; `cri` re-adopts them through `PrincipalControl.events`/`list` after restart |

---

## 8. Performance budgets

On the reference hardware (8-core x86-64 at 3 GHz, NVMe):

| Operation | Budget |
|---|---|
| `spawn` of a t1 app (mount fd cached, warm page cache) | p50 ≤ 8 ms, p99 ≤ 25 ms from call to `execveat` |
| `spawn` with a cold generation mount and statement verification | p50 ≤ 30 ms |
| `attachGrant` | p99 ≤ 3 ms |
| `PodSpawn.spawnContainer` (generation mounted, warm cache) | p50 ≤ 15 ms, p99 ≤ 40 ms |
| `DebugAttach.attach` | p99 ≤ 50 ms to debugger exec |
| Service BPF load (per object) | ≤ 20 ms |
| VM principal first spawn (descriptor + `registerSession`) | p99 ≤ 20 ms |
| `identify` (cached) | p99 ≤ 50 µs |
| Route creation | ≤ 200 µs per route |
| Boot: `switch_root` → bootstrap services healthy | ≤ 400 ms |
| Boot: `switch_root` → all boot services running (graphical) | ≤ 2.0 s |
| Shutdown | ≤ 5 s typical, ≤ 30 s hard limit |
| Memory | core ≤ 4 MiB RSS; supervisor ≤ 48 MiB at 2 000 principals; spawner ≤ 8 MiB |
| seccomp filter | ≤ 400 BPF instructions for `baseline-1`, evaluated through a binary-search tree on the syscall number |

---

## 9. Observability

### 9.1 Logs

Structured records (protocols §10.6) with fields `session`, `principal`, `gen`, `tier`, `step` (spawn step), `errno` and `service`. Levels:
- spawn failures: `warning`;
- service failures: `err`;
- kl-exec denials: `warning`;
- boot timings: `info`.

### 9.2 Receipts

`warden` writes `boot`, `shutdown`, `spawn`, `exit`, `debug.attach`, `debug.detach` (protocols §19.3) and the repo-local `x-warden.fence`, signed by `service/warden` in the submitted form.

| Event | `data` fields |
|---|---|
| `boot` | `osGen`, `configGen`, `featureLevel`, `kernel`, `bootEntry`, `report` (the boot report object), `safeStart` (REQ-WARDEN-093) |
| `shutdown` | `kind`, `reason`, `durationMs` |
| `spawn` | `generation`, `name`, `entrypoint`, `tier`, `actorKind`, `parent`, `grantRoots`, `routes` (`service#facet` list), `transaction`, `confinementDigest` (`sha256:` of the JCS report), `failed` (optional `kl:<code>`) |
| `exit` | `status` (exited or signaled), `cpuNanos`, `maxRss`, `durationMs` |
| `debug.attach` | `grant`, `target`, `targetCgroupId`, `scope`, `debugger`, `expires` |
| `debug.detach` | `grant`, `reason` (`exit`, `expired`, `revoked`), `durationMs` |
| `x-warden.fence` | `tree` (canonical path), `sessions`, `durationMs`, `outcome` (`released`, `dropped`, `timeout`, `conflict`) |

`spawn` receipts of VM principals add `vm` (`purpose`, `image`, recorded `tier`); of pod containers add `pod` (`id`, `namespace`, `name`).

### 9.3 Metrics

Exported as `0x1F` metrics records (protocols §10.6) on warden's journal stream:

`warden_spawn_total{tier,actor,result}` (counter), `warden_debug_pairs` (gauge), `warden_bpf_programs{service}` (gauge), `warden_pod_containers` (gauge), `warden_spawn_duration_seconds{tier}` (histogram), `warden_principals{tier}` (gauge), `warden_service_restarts_total{service}`, `warden_service_state{service,state}`, `warden_exec_denials_total`, `warden_grant_mounts`, `warden_uid_allocated`, `warden_netns_pool_size`, `warden_receipt_spool_bytes`.

---

## 10. Configuration

The `config` module `keylos.warden` (Nickel) renders `/etc/keylos/warden.json`. App tier floors (`apps.<name>.tierFloor`, protocols §6.3) are read from the same file.

```nickel
{
  warden | {
    secretEnvPatterns | Array String
      | default = ["*TOKEN*", "*SECRET*", "*PASSWORD*", "*PASSWD*", "*_KEY", "*API_KEY*", "AWS_*", "*CREDENTIAL*"],
    netnsPoolSize | Number | default = 8,
    spawnRate | { perSecond | Number | default = 50, burst | Number | default = 200 },
    tmpSizeMiB | Number | default = 1024,
    sliceCeilings | {
      apps | { memoryMax | String | default = "80%" },
      agents | { memoryMax | String | default = "50%" },
      benches | { memoryMax | String | default = "70%" },
      legacy | { memoryMax | String | default = "60%" },
    },
    landlockAudit | [| 'off, 'denials, 'all |] | default = 'denials,
    shutdownTimeoutSecs | Number | default = 30,
    kmods | Array String | default = [],              # enabled kmod names (manifest name of kind kmod), §4.9.4
  },
  debug | {
    debuggers | Array String
      | default = ["io.keylos.debug.gdb", "io.keylos.debug.lldb", "io.keylos.debug.perf", "io.keylos.debug.bpftrace"],
  },
  apps | { _ : { tierFloor | [| 't1, 't2, 't3, 'legacy |] | optional } } | default = {},
}
```

The service table (`services.json`, §4.6.1) is rendered by the `config` module `keylos.services`; `policy.ref` by the policy module. `debug.debuggers` is the policy list of protocols §9.3. Changing any of them requires a config generation apply, which is a T3 action with presence (quorum on headless profiles).

---

## 11. Testing and acceptance criteria

### 11.1 Unit

- UID allocator: quarantine timing, exhaustion, fairness.
- Plan validation: env patterns, fd targets, reserved names, transaction ID syntax.
- Effective tier computation: a property test over every combination of manifest tier, config floor, broker floor, actor kind and reproducibility exception.
- seccomp profile compiler: golden BPF per arch, plus an interpreter-based test that runs every syscall number through the compiled program and compares the result with the table.
- Service-set validation: unknown fields, forbidden extras, cycles, routes naming unregistered facets.
- Route facet resolution against the protocols §19.2 registry.
- Generation statement verification with the `boottrust/` conformance vectors, including `issued` beyond trusted time + 24 h and revoked publisher keys.
- Trusted-terminal membership (§4.3.3): every combination of entry point, caller flag and caller actor kind.
- `KEYLOS_ARGFD_*` validation: shell vs non-shell callers, fd numbers absent from `SpawnSpec.fds`.
- Service-table validation against `services/` vectors: non-`x-` unknown fields, `network: "host"` for an unlisted service, `bpf` paths outside `/usr/lib/keylos/bpf/<service>/`, forbidden extras.
- `VmSpawn.register` validation and VM principal derivation (token holder sessions, parent liveness, pod parent rule, tier/purpose mismatch, reused session).
- `events(replay)` ordering: replayed `spawned` events precede any live event of the same session.
- `PodMount.tmpfsBytes` copy (size limit, symlink and device-node handling).
- Debug grant limits against the `debug/` vectors (durations per scope, debugger allowlist).

### 11.2 Integration

VM-based, run under qemu or crosvm for each of the KL1, KL2 and KL3 kernels.

**Escape suite**, run as a t1 app. Every case MUST fail with the stated result:

| Test | Expected |
|---|---|
| `unshare(CLONE_NEWUSER)` | `EPERM` |
| `clone3` with any flags | `ENOSYS` |
| `ptrace(PTRACE_ATTACH, <sibling>)` | `EPERM` |
| `mount("tmpfs", …)` | `EPERM` |
| Connect to an abstract socket `@/tmp/.X11-unix/X0` created by another principal | `EPERM` (ABI ≥ 6) or `ECONNREFUSED` (netns) |
| `kill(<other principal's pid>)` | `ESRCH` (invisible) or `EPERM` |
| `ioctl(0, TIOCSTI, "x")` | `EPERM` |
| Read `/proc/1/environ` | `ENOENT` |
| Exec `/tmp/a.out` (copied from an allowed generation) | `EACCES` (kl-exec) |
| `mmap(PROT_EXEC)` of a memfd | `EACCES` or `EPERM` |
| `mprotect(anon, PROT_EXEC)` without jit | `EACCES` |
| `python3 -c 'print(1)'` from a generation interpreter (non-terminal principal) | refused by the interpreter (`SECBIT_EXEC_DENY_INTERACTIVE`) |
| Open `/home/<human>/.ssh/id_ed25519` | `ENOENT` (not in the view) |
| `socket(AF_NETLINK, …)` | `EAFNOSUPPORT` |
| `bpf(BPF_PROG_LOAD)` | `EPERM` |
| `io_uring_setup` | `EPERM` |
| Open `/dev/sda` | `ENOENT` |
| UDP `sendto 8.8.8.8:53` (no grant) | `ENETUNREACH` (KL1/2) or `EACCES` (KL3) |

**Other integration tests:**
1. Boot to graphical in ≤ 2.0 s (reference VM: 4 vCPU, virtio-blk on a tmpfs-backed image).
2. Supervisor crash while 100 principals run: none die, and `identify` works within 300 ms.
3. Revoking a running app's generation: new exec fails, and `freeze` is applied according to `onRevoke`.
4. Idmapped data mount: a file created by the app appears on disk owned by the human UID.
5. `attachGrant` into a running app: the app can list `/grants/<name>` at once; after `detachGrant`, access returns `ENOENT`; the app's Landlock domain was never changed.
6. `SpawnSpec.transaction`: a child writes to its home through the transaction view; the real home is unchanged until `Transaction.commit`; with `NetworkPolicy.deny`, `connect` fails.
7. The trusted terminal: an interactive `kish` started via `TrustedSpawn` accepts typed commands; the same binary started via `Supervisor.spawn` refuses interactive input.
8. A t2-tier spawn returns `kl:unsupported:t2` and creates no cgroup.
9. A service-set entry adding `bpf` to syscalls is rejected; the previous service table stays active.
10. First boot: the bundle file is deleted after the last consumer reports done.
11. PCR11 phases: on swtpm, after boot the PCR11 value equals the release's `ready` prediction; a sealed test secret bound to `ready` is unsealable by the first tier-0 service and not by a process the test injects before `ready` (simulated by delaying `journal`).
12. Service BPF: a service table entry with a `bpf` object under `/usr/lib/keylos/bpf/<svc>/` loads, attaches and passes a ringbuf fd in `KEYLOS_BPF_FDS`; the service's own `bpf()` call fails with `EPERM`; an object with an XDP section is refused.
13. DebugAttach: with `requester` = the human's shell session, a `process`-scope debugger (ambient `CAP_SYS_PTRACE`, `CAP_PERFMON`) attaches with ptrace to the target, opens a per-task perf event on it, and fails (`EPERM`) on a sibling of the target; a `requester` that is not live fails with `kl:not-found`; after `expiresSecs` the pair is gone, the debugger is killed and `debug.detach` reason `expired` is written; a `kernel`-scope debugger may load a tracepoint program and is refused an LSM program.
14. PodSpawn: a `container` generation signed by an enabled org publisher runs with read-only root, `runtime-default`, no capabilities, joins the pod netns; an unsigned one fails with `kl:integrity`; a second container of the same pod with `sharePid` sees the first container's processes.
15. VM principal: bench calls `VmSpawn.register` with tokens held by the human's session, then `spawnVmm` for `bench-net` and `bench-relay`; `identify` on either returns the VM principal; `ServiceHost.accept` at `gate#shim`, `vault#app` and `portal-files#default` names the VM principal; `PrincipalControl.terminate(kill)` on the VM session kills all helpers; `Supervisor.spawn` with the VM session fails with `kl:invalid`; offered tokens held by another session fail `register` with `kl:invalid`.
16. Transaction ownership: a principal that did not begin transaction `x-…` (and does not descend from its owner) gets `kl:denied` when spawning with it.
17. Realtime: a generation with `needs.realtime` can `sched_setscheduler(SCHED_FIFO, 20)`; priority 21 fails; a generation without it cannot use `SCHED_FIFO` at all.
18. kmod: a `kmod` generation whose `kmod.kernel` differs from `uname -r` is skipped with `kernel-mismatch`; a matching one loads; an unsigned module in it fails with `EKEYREJECTED`.
19. Guest session: after the guest's logout, the `guest-<id>.slice` is gone and every guest UID is in quarantine.
20. Open broker: compat's open-broker helper (profile `openbroker-1`, named by `brokerSession`) can `process_vm_readv` the paired legacy app and gets `EPERM` for any other process; its `ptrace(PTRACE_ATTACH)`, `process_vm_writev` and `pidfd_getfd` fail; a second `spawnLegacy` naming the same `brokerSession` fails with `kl:invalid`.
21. Pod exec: `execInContainer` into a running sealed container sees a file the container wrote to `/tmp` after start; a mismatched generation fails with `kl:invalid`; the exec process has no capabilities.
22. Pod projected volume: a `PodMount` with `tmpfsBytes = 1 MiB` holding a 2 MiB tree fails with `kl:invalid`; a 512 KiB tree appears at the target as a noexec tmpfs copy.
23. Pod egress shim: `egressShim(podId)` returns a `ShimEndpoint`; gate's `ServiceHost.accept` names the pod principal; after the pod's last container exits the shim is revoked.
24. Cluster network: on `server-k8s`, `kubelet` with `network: "cluster"` runs in the netns returned by `clusterNetns` (same netns inode as `crid`); the same entry on the `desktop` profile is rejected at service-table load.
25. Event replay: a `strata`-facet watcher started with `replay = true` while 50 sessions run receives exactly 50 `spawned` events before any live event; each carries the session's current `cgroupId`.
26. UID range: after exhausting a test allocator window, no allocation returns `0x0FFF0000` or any UID above `0x0FFEFFFF`.
27. VM narrowing: `register` with `checks = ["check if operation(\"path\", $op), [\"read\"].contains($op)"]` — every token passed to the broker test double's `registerSession` carries an extra attenuation block with that check; with `budgets = [usd-micro:1000000]` the `SessionReg` passed to `registerSession` carries the same `budgets` list, and a broker double that answers `kl:budget` makes `register` fail with no principal created.
28. Route buffers: on a VM with `net.core.wmem_max = 212992`, a route pair created by warden carries a 4 MiB − 4 KiB capwire call in both directions; `getsockopt(SO_SNDBUF)` on each end reports ≥ 4 259 840.
29. Identity hand-off: a test service records the `peer` from `ServiceHost.accept` and, separately, the result of `Supervisor.identify(SO_PEERPIDFD)` on the same socket; the former names the spawned child, the latter fails with `kl:invalid`.
30. Route names: a principal with routes to `broker#principal`, `warden#service`, `vault#app`, `portal-files#default` and `hearth#tpm` gets `KEYLOS_CAPWIRE_FDS` names `broker`, `warden`, `vault#app`, `portal-files` and `hearth#tpm`; a test binary built on the `keylos-capwire` inherited-fd helper adopts them, fd 3 and `KEYLOS_TPM_FD` with no `unsafe` block, and a second adoption call fails.
31. Start order: a service table with a route cycle (`a → b#x`, `b → a#y`) and no `after` cycle boots, both services reach `running`, and the first call from each side completes once the other has called `host()`; an `after` cycle aborts into recovery.
32. Label placeholder: with no broker in the table, `connectionInfo` for a warden-started service returns `public/trusted`; once broker runs, the live label replaces it.
33. TPM hand-over: a service with `privileges.tpm` gets a working TPM through `KEYLOS_TPM_FD` (a `TPM2_GetCapability` succeeds) while `/dev/tpmrm0` is absent from its view; a service without it gets neither; a production build given `KEYLOS_DEV_TPM_TCTI` in `SpawnSpec.env` rejects the spawn with `kl:invalid`.
34. Grant ceiling: a directory granted with ceiling `private/user` containing `a.txt` (`private/user`), `b.html` (`public/untrusted`) and `c.key` (`secret/user`): the holder opens `a.txt`, gets `EACCES` for `b.html` and `c.key`; a file another principal renames into the tree with label `secret/untrusted` is refused; after relabelling `a.txt` to `secret/user`, a `read` on the fd opened before fails with `EACCES`; a mount nested inside the granted tree on the host is not visible through the grant; on a kernel without `bpf-init-inode-xattr`, an unlabelled file created after attach is refused.
35. Single-file grant: after a file pick, `/grants/<name>` lists only the selected file; `open("../<sibling>")` and any `openat` of a sibling name fail; the real parent directory never appears in `mountView`.
36. Writer fence: with an app holding a writable fd inside `~/proj` and a shell writing to it, `fenceWriters(~/proj)` freezes both and returns; their writes resume after `release`; a fence on a subtree a tier-0 service writes fails `kl:conflict` with nothing left frozen; a fence not released is lifted after 30 s; killing the `strata` test client lifts it at once.
37. Sealed-unit transaction: spawning with a transaction over a directory in a unitfs-sealed unit mounts the transaction-specific plaintext view; the live unit view and the ciphertext backing are absent from the child's `mountView`.
38. Safe start: with `x-safeStart: true` in the boot report, an app's `.apps/<app>/data` is read-only in its view (`EROFS` on write) and the boot receipt carries `safeStart: true`; the same generation's code still launches.
39. Attempt spawn: `loom` spawns with `SpawnSpec.attempt{owner alice, epoch 3}`; the child principal is `app:<gen>@alice/<loom chain>/<new s->`, the broker test double receives `SessionReg.attempt` unchanged with empty `offered`, and the `spawn` receipt carries `data.attempt`. The same spec from a non-loom service fails `kl:denied`; with `SpawnSpec.session` set or `grants` non-empty it fails `kl:invalid`.
40. Stale attempt: the broker double answers `registerSession` with `kl:conflict`; the spawn fails with `kl:conflict` and no cgroup, UID or route exists afterwards.
41. Session reuse: re-spawning with a session ID that ended earlier in the boot fails `kl:invalid`; 10 000 generated attempt sessions are pairwise distinct.
42. Attempt route: an attempt principal whose generation declares `loom#attempt` gets it and `loom`'s `ServiceHost.accept` names that principal; a non-attempt principal declaring it gets no such route.
43. Agent attempt: `VmSpawn.register` with `VmPrincipal.attempt{owner alice}` and `parentSession` = `aide`'s session registers `agent:<template>@alice/<aide chain>/<vm session>` with the binding forwarded.
44. `loom` crash: killing `loom` with two attempt processes running kills both attempt scopes before `loom` is started again.
45. No durable state: after a reboot of the test VM, `FdStore.fetch` of a key `loom` stored before returns `kl:not-found`, and `state.json` is not read at boot (its content is ignored even when edited).

### 11.3 Fuzzing

`cargo-fuzz` targets, each run for 24 h of CI fuzzing per release with zero crashes:
- capwire dispatch for `Supervisor` and every `warden-sys` interface, with arbitrary fd counts;
- the SpawnSpec validator;
- the service-set parser;
- the core↔supervisor protocol decoder.

### 11.4 Conformance

**Durable-execution harness (`conformance/s3-loom`, stage S3).** Runs under `warden-lite` with real `ledger`, `vault`, `hearth`, `broker` and `loom`, the scripted `dev-prompt` approver, and two documented doubles that are part of this repository's conformance tree: `gate-double` (serves `DurableEffects` and `WorkflowBudget` on `gate#loom`, `gate#client` for the test kind `x-loom.test-write`, with a configurable retry strategy, a stable-key destination and fault switches for lost replies and an ignored idempotency key) and `loom-test-activity` (a deterministic activity generation that records an observation, registers one effect and completes). The harness kills and relaunches the stack between steps (no automatic restart exists in `warden-lite`) and runs the loom spec's Phase B acceptance tests. It proves local persistence and contract behaviour, not confinement, a real machine reboot or remote exactly-once execution; the INV-8 to INV-12 tests are rerun against the real `gate`, `aide`, `strata` and `bench` when they exist (protocols §17).

`keylos-protocols` vectors: `ids/` (including the workflow attempt IDs), `workflow/` (attempt bindings), `manifest/`, `capwire/`, `receipts/`, `boottrust/`, `presence/` (exception verification), `tpm/` (not used directly; checked for the absence of conflicts).

### 11.5 Acceptance criteria (release gate)

1. Every test in §11.2 passes on KL1, KL2 and KL3, for x86_64 and aarch64.
2. Every confinement report validates against the `keylos.confinement/1` shape, and its compensations match the kernel level.
3. 10 000 spawn/exit cycles with grant attaches leak no UIDs, cgroups, netns, mapping namespaces or fds (measured by `/proc/self/fd` count and cgroupfs listing).
4. Every budget in §8 is met at p99.

---

## 12. Implementation notes

### 12.1 Crates

| Crate | Use |
|---|---|
| `tokio` 1 | async runtime |
| `rustix` 0.38 | mount API, pidfd, fs |
| `nix` 0.29 | gaps only |
| `landlock` 0.4 | Landlock |
| `seccompiler` 0.4 | seccomp |
| `capnp` 0.19, `capnp-rpc` 0.19 | capwire |
| `postcard` 1, `serde` 1 | core protocol |
| `serde_json` 1 | JSON |
| `ulid` 1 | session IDs |
| `tracing` 1 | logging, with a journal sink |
| `aya` 0.13 | BPF map fds and ring buffer only; the programs are owned by `boot` |
| `caps` 0.5 | capabilities |
| `rtnetlink` 0.14 | bringing `lo` up in a netns |
| `aya-obj` 0.2 | parsing service BPF objects in the core |
| `tss-esapi` 7 | PCR11 extension (core only) |

### 12.2 Repository layout

```
warden/
  Cargo.toml (workspace)
  crates/
    warden-core/          PID 1
    warden-supervisor/
    warden-spawner/
    warden-plan/          SpawnPlan types (no_std-compatible subset shared with the spawner)
    warden-seccomp/       profile table + compiler (build.rs emits profiles/*.bpf)
    warden-landlock/
    warden-views/         mount-view planner (apps, services, shells, transactions, grants)
    warden-services/      service-set model and validation
    warden-cli/
  schema/warden-local.capnp   (repo-local diagnostics; file ID outside the protocols range)
  profiles/baseline-1.toml
  tests/vm/               escape suite and boot tests (crosvm/qemu)
  fuzz/
```

### 12.3 Build

- `cargo build --release` with `panic = "abort"` for the core and spawner, and `panic = "unwind"` for the supervisor (caught at task boundaries).
- The core and spawner are linked statically with musl, so PID 1 has no dynamic loader dependency. The supervisor uses glibc.
- The build is reproducible: `SOURCE_DATE_EPOCH`, `--remap-path-prefix`, and `codegen-units = 1` for release.

---

## 13. Decisions and alternatives

| Decision | Alternatives rejected | Reference |
|---|---|---|
| keylos-native PID 1 instead of systemd | systemd as PID 1 offers mature service management, but its D-Bus-centred model and ambient system bus conflict with capwire-only IPC and the per-principal UID model | [ADR-0004](../../handbook/11-decisions/adr-0004-capwire-no-system-bus.md), [ADR-0002](../../handbook/11-decisions/adr-0002-rust-for-the-tcb.md) |
| Three-process split (core, supervisor, spawner) | A single process would put capwire parsing inside PID 1; fork-from-tokio is unsafe | — |
| Namespaces only from warden; no userns for native principals | Unprivileged userns per app (Flatpak/bwrap style) reopens the kernel attack surface | [ADR-0025](../../handbook/11-decisions/adr-0025-namespaces-only-by-warden.md) |
| Dynamic UID per principal instance, plus idmapped data | Static per-app UIDs (Android) make cross-instance isolation of agent sessions impossible; chown on disk breaks snapshots | [ADR-0024](../../handbook/11-decisions/adr-0024-dynamic-uids-per-principal.md) |
| BPF LSM `kl-exec` keyed by overlay superblock, registered after userspace statement verification | IPE alone cannot express "reached through a composefs mount of an allowed generation"; per-object fs-verity builtin signatures are impractical | [ADR-0008](../../handbook/11-decisions/adr-0008-host-executes-only-sealed-code.md) |
| Runtime grants as mounts under `/grants` | Widening Landlock domains is impossible; passing dirfds opened outside the view fails on the first `openat` | [ADR-0025](../../handbook/11-decisions/adr-0025-namespaces-only-by-warden.md) |
| Service privileges from the owner-signed service table, never from manifests | Self-declared privileges let a publisher grant itself capabilities | [ADR-0022](../../handbook/11-decisions/adr-0022-read-only-etc-confext.md) |
| t2/t3 requests go to `bench` directly, not through `warden` | Forwarding from `warden` creates a `warden ↔ bench` dependency cycle | [ADR-0009](../../handbook/11-decisions/adr-0009-unsealed-code-in-workbenches.md) |
| No root, no setuid | sudo/polkit flows give ambient escalation | [ADR-0023](../../handbook/11-decisions/adr-0023-no-root-no-setuid.md) |
| Revocation kills or freezes | Leaving processes running with already-materialised fds would make revocation cosmetic | [ADR-0041](../../handbook/11-decisions/adr-0041-revocation-kills-or-freezes.md) |
| Service BPF loaded by `warden` from the OS generation; services consume maps through `mmap` | Letting services call `bpf()` would hand every BPF-using service the kernel's largest attack surface and make `kl-exec`'s `bpf` rule meaningless | protocols §9.3 |
| Debuggers as warden-spawned principals with a time-limited `kl_debug_pairs` entry | Global `ptrace_scope=0` or a root shell for debugging | [ADR-0049](../../handbook/11-decisions/adr-0049-debug-capability.md) |
| Sealed pods as host principals; `keylos-vm` pods as VM principals | A container runtime (runc, containerd) with root and its own namespace logic would duplicate `warden` and need `CAP_SYS_ADMIN` | [ADR-0047](../../handbook/11-decisions/adr-0047-cri-microvm-pods.md) |
| `warden` extends PCR11 `sysinit`/`ready` itself | Leaving it to a service would let something run before `ready` | protocols §19.6 |

### 13.1 Notes on cross-repository contracts

All earlier interim mechanisms (VM descriptor, pty-derived debug requester, exception readers, open-broker extras) are replaced by the protocols 1.0.0 (final) contracts used above: `VmSpawn`, `DebugAttach.requester`, the §10.7 reader rows, `LegacySpawn.brokerSession` and profile `openbroker-1`. One clarification remains:

- **N4. VM budgets at registration.** Resolved by protocols C56: warden forwards `VmPrincipal.budgets` in `SessionReg.budgets`; `checks` are applied offline by warden and need no broker field.
- **N3. Boot report fd.** Per protocols §20.1 the boot report is passed to `warden` as fd 8 (fds 3–7 are the kl-exec maps); `warden` reads it from there.
- **S2 feedback (protocols Appendix E).** Route fd names follow protocols §10.5 (E16); TPM access is the `KEYLOS_TPM_FD` hand-over and `KEYLOS_DEV_*` is the development-knob namespace (E8, REQ-WARDEN-059); grant ceilings (E31, REQ-WARDEN-08D), single-file views (E32, REQ-WARDEN-08E), the writer fence (E30, REQ-WARDEN-08F), unitfs transaction views (E34) and safe start (E35, REQ-WARDEN-093) are warden's parts of the ISSUES.md resolutions.
- **Durable execution (protocols E38–E51).** `SpawnSpec.attempt` and `VmPrincipal.attempt` are forwarded in `SessionReg.attempt` (E41, REQ-WARDEN-094 to REQ-WARDEN-098); routes and facets of `loom` (E49, REQ-WARDEN-09B); no durable workflow state in warden (protocols §10.7, REQ-WARDEN-099).
- **Development supervisor.** `warden-lite` (this repo, stage S2) has no mount namespaces: it answers `GrantMounts` with `kl:unsupported`, and `broker` then returns the granted dirfd from `Broker.materialize` directly. This mode exists only in development builds; production `warden` always uses `GrantMounts` (§4.7.6).
