# keylos/depot — content-addressed store and generations

| | |
|---|---|
| Repository | `github.com/keylos-os/depot` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `depotd` (tier-0 service), `depot` (CLI), `depot-parse` (parser subprocess), `depot-mount-helper` (initrd-safe library and binary used by `boot`), crates `keylos-depot-client`, `keylos-composefs` (EROFS/composefs writer and reader), `keylos-objpack` (objects-pack reader/writer), `keylos-oci-convert` (deterministic OCI image → `container` generation conversion, §4.19; also used by `forge` for publisher-side parity) |
| Depends on | `keylos-protocols 1.0` (crates `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-biscuit`, `keylos-presence`); Linux ≥ 6.18 (feature level KL1) with fs-verity, EROFS, overlayfs (`metacopy`, `redirect_dir`, data-only lower layers, `verity=require`) |
| Provides | `Depot` (protocols §7.3.8) on facets `user`, `mounter`, `forge`, `config`, `compat`, `courier`, `cri`, `admin`; the on-disk store under `/store`; the OCI artifact layout for keylos generations; the `.klb` offline bundle format; the `container` conversion algorithm; launchability decisions and `launchReasons` |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`depot` owns every byte of code and static data that keylos can mount. It:

1. stores **objects** (regular files), each identified by its fs-verity digest (`obj:fsv256:…`) and each with fs-verity enabled, so the kernel verifies every page on read;
2. stores **generations**: composefs EROFS metadata images identified by their fs-verity digest (`gen:fsv256:…`), plus their **evidence** (generation statements and their signatures, seal statements, provenance and realisation attestations, transparency-log proofs, consent records, owner exceptions);
3. **installs** generations from distribution channels (sources resolved by `courier`, which is the only TUF client), directly from OCI references pinned by digest, from offline bundles (`.klb`), from local imports (`forge`, `config`, `compat`), and converts OCI container images into `container` generations for `cri` (`oci+container://`);
4. decides **launchability** from signed evidence, recomputed at every start, so the database is only a cache, and explains every negative decision through `GenerationInfo.launchReasons`;
5. **mounts** generations as composefs overlays with `verity=require` and returns detached mount fds to the principals allowed to mount them;
6. computes **capability diffs** on install and update and records **consent**;
7. enforces **revocations** (stream and org lists, publisher-key revocations), applies the **catalog review** tier floor and the **offline-operation** install rules, maintains **GC roots** and **retention**, and reports **dedup** accounting;
8. writes receipts for every state change.

`depot` does **not** decide what executes on the host. The `kl-exec` BPF LSM does (protocols §9.3): `warden` registers a mount's superblock only after it has itself verified the generation statement against the boot trust set. `depot`'s launchability is the second, independent gate: it refuses to hand a mount of a non-launchable generation to `warden`.

### 1.1 Non-goals

- Building software (`forge`), choosing package versions (`pkgs`), choosing which OS generation boots (`courier`, `boot`).
- Talking TUF. `courier` is the single TUF client; `depot` consumes its `Resolution`s (protocols §7.5.6).
- Running anything. `depot` never executes store content and never registers anything in `kl-exec`.
- Storing user data, configuration source, secrets or logs.
- Operating transparency logs (`tlog`) or repositories (release engineering in `keylos`).
- Signing anything except consent records (`service/depot`) and receipts. Owner-seal signatures are made by `hearth`.

---

## 2. Context and embedded contracts

`depotd` is a tier-0 service. `warden` mounts the bootstrap generation of `depotd` itself (listed in the boot trust set `bootstrapGens`) and starts it after `ledger` and before any app. In the initrd, `boot` uses `depot-mount-helper` (no service, no capwire) to mount the OS and config generations before `warden` starts.

```
forge ──importTree/seal (depot#forge)──►┐
config ─importTree/mount (depot#config)►│
compat ─importTree (depot#compat)──────►│           ┌─ mount ──► warden (host spawn and cri PodSpawn; kl-exec registration by warden)
courier ─install/root (depot#courier)──►│  depotd ──┤─ mount ──► bench, compat (VM shares; unsealed OK)
cri ─install oci+container:// (depot#cri)►│         ├─ openObject / openPath ─► principals allowed to spawn the closure
kish/atrium ─install/list (depot#user)─►│           └─ launchReasons ─► warden (effective tier), CLIs
                                        │
            CourierResolver.resolve ◄───┤  (tuf: sources, org sources, catalog entries, revocation lists)
            gate.connect (OCI egress) ◄─┤
            hearth HearthSeal.sealSign ◄┤  (owner-sealed generation statements)
            broker BrokerSystem.requestFor ◄┤  (consent approvals, offline installs)
            ledger.append / query ◄─────┘  (receipts; seal.window windowDigest check)
```

### 2.1 Embedded contracts

Every block below is copied verbatim from `keylos/protocols` 1.0.0 (final). If an embedded copy differs from protocols, protocols wins.

#### protocols §2.1 Kernel feature levels

Components MUST probe for features and MUST pick behaviour by **feature level**, not by kernel version string.

| Level | Required kernel features | Typical kernel |
|---|---|---|
| `KL1` | Landlock ABI ≥ 7, BPF LSM (`lsm=` includes `bpf`), IPE, fs-verity, overlayfs `verity=require`, pidfd (`CLONE_PIDFD`, `pidfd_getfd`, `SO_PEERPIDFD`), `openat2`, new mount API, `MOVE_MOUNT_BENEATH`, idmapped mounts, `AT_EXECVE_CHECK`, `memfd_secret`, `mseal`, cgroup v2 (`cgroup.freeze`, `cgroup.kill`) | 6.18 |
| `KL2` | KL1 + Landlock ABI ≥ 9 (`FS_RESOLVE_UNIX`, `RESTRICT_SELF_TSYNC`) | 7.1 |
| `KL3` | KL2 + Landlock ABI ≥ 10 (UDP rules) | 7.2 |

On KL1 and KL2 there are no Landlock rules for pathname unix sockets or UDP. Components MUST compensate: the sandbox gets a private network namespace with only `lo`, and egress goes through `gate`; the mount view gives no access to pathname sockets. That compensation MUST be recorded in the process's confinement report (§9.4).

The LSM order on the kernel command line is `lsm=landlock,lockdown,yama,ipe,bpf`.

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

#### protocols §3.1 Digests

```
digest      = algo ":" hex
algo        = "sha256" / "sha512" / "fsv256"
hex         = 64HEXDIGLC / 128HEXDIGLC   ; exactly 64 for sha256/fsv256, 128 for sha512
```

- `sha256:` is the SHA-256 of a byte string. It is used for sources, documents and blobs that are not files in the store.
- `fsv256:` is the **fs-verity file digest** with SHA-256, a 4096-byte Merkle block size and no salt. It is computed exactly as the kernel's `FS_IOC_MEASURE_VERITY` returns it. It is used for every file in the store and every generation image.
- Binary form: the Cap'n Proto struct `Digest` (§7.3.1).

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

#### protocols §3.3 Names

- **Generation names** use reverse-DNS: `org.example.Editor`. The pattern is `^[a-z][a-z0-9-]*(\.[a-zA-Z0-9-]+){2,}$`, at most 255 characters. The prefixes `io.keylos.` and `org.keylos.` are reserved for the project.
- **Service names** are `[a-z][a-z0-9-]{0,62}` (for example `vault`, `portal-files`). The registry is §19.1.
- **Facet names** are `[a-z][a-z0-9-]{0,31}`. The registry is §19.2.
- **Usernames** are `[a-z_][a-z0-9_-]{0,31}`. `_system` and `_cluster` are reserved, and the prefix `guest-` is reserved for ephemeral guest sessions (`guest-<8 lowercase base32>`, created and destroyed by `hearth`).
- **Kubernetes names**: `pod-ns` and `pod-name` follow Kubernetes DNS-1123 label / subdomain rules (`[a-z0-9]([-a-z0-9]*[a-z0-9])?`, ≤ 63 and ≤ 253 characters).

#### protocols §3.6 Time

- On the wire: `Timestamp { unixNanos :Int64 }` in UTC.
- In documents: RFC 3339 with `Z` and at most nanosecond precision.
- The system clock MUST be disciplined by NTS-authenticated time (owned by the `net` repo).
- Components that check expiry (tokens, TUF, certificates) MUST treat the clock as **untrusted until the first NTS sync after boot**. Until then they use the **time floor**: the time of the newest ledger checkpoint (`LedgerAdmin.timeFloor`, §7.5.5). `net` steps the clock forward to the time floor at boot if the RTC is earlier. The RTC is never trusted to move time backwards past the floor.

#### protocols §4 Cryptography

| Use | Algorithm |
|---|---|
| Signatures (software keys) | Ed25519 (RFC 8032), `alg = "ed25519"` |
| Signatures (TPM, HSM keys) | ECDSA P-256 with SHA-256 (DER signatures), `alg = "ecdsa-p256-sha256"` |
| Presence signatures (FIDO2 authenticators) | `alg = "fido2-es256"` (COSE −7) or `"fido2-eddsa"` (COSE −8), §5.3 |
| Hashing | SHA-256; SHA-512 only where an external format requires it |
| Symmetric AEAD | AES-256-GCM with hardware AES, otherwise XChaCha20-Poly1305 |
| Key agreement (software keys) | X25519 |
| Key agreement (TPM-resident keys) | ECDH P-256; hybrid encryption to a TPM key uses HPKE (RFC 9180) mode base, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM (TPMs have no Curve25519) |
| Hybrid encryption to software keys (recovery recipient, trustees, inheritance) | HPKE (RFC 9180) mode base, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM; `info` = `keylos-recovery-copy/1:<object>` for recovery copies (§20.2), otherwise the media type of the protected object |
| Secret sharing (trustee shares) | Shamir over GF(2^8), per-byte, as in SLIP-0039's field arithmetic, with the share format of §20.19 |
| Password KDF | Argon2id (m=256 MiB, t=3, p=4 minimum on desktop profiles) |
| Data-key wrapping | AES-256-GCM key wrap with a 96-bit random nonce and AAD = unit ID |
| TLS | rustls; TLS 1.3 only for keylos-operated endpoints; TLS 1.2+ allowed in `gate` for third-party hosts |

**Key identifiers** are `key:sha256:<hex of SPKI DER>`. For FIDO2 credentials the SPKI is derived from the credential's COSE public key.

**Algorithm agility.** Every signature record carries `keyid` and an explicit `alg`. Verifiers MUST reject unknown algorithms. New algorithms (for example ML-DSA-65) are added only in a protocols minor version, alongside both old and new signatures.

**No in-kernel signature verification of store content.** keylos does not use fs-verity builtin signatures or a `.fs-verity` keyring policy. Generation signatures are DSSE envelopes verified in userspace (§9.3); the kernel enforces "exec only from verified mounts" through `kl-exec`.

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

#### protocols §5.3 Presence signatures

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

#### protocols §7.1 capwire model

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

#### protocols §7.2 Routes and facets

`warden` wires services according to **routes** declared in service and app manifests plus policy.

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

- A **facet** is a server-defined restriction name. The registry of every facet, its holders and the methods it allows is §19.2. Servers MUST refuse methods their facet doesn't allow with `kl:denied`.
- Route references are written `service#facet` (for example `vault#app`).
- The server learns the facet of each connection from `ServiceHost.accept` (§7.5.1) or `Supervisor.connectionInfo`.
- Service sockets live under `/run/keylos/svc/<service>/` with mode `0700`, owned by `warden`'s UID. No other principal can `connect()` to them. Connections are created by `warden` (`socketpair` + hand-off through `ServiceHost.accept`).
- Dynamic routes (a service capability granted at runtime) are materialised by `broker` through `ServiceConnect.connectService` (§7.5.1).

#### protocols §7.3.1 `common.capnp`

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

#### protocols §7.3.3 `broker.capnp` (consumed: grant and approval types)

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

#### protocols §7.3.8 `depot.capnp` (implemented)

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

#### protocols §7.5.2 `broker-sys.capnp` (consumed: `BrokerSystem.requestFor` for consent and offline installs)

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

#### protocols §7.5.6 `courier-sys.capnp` (consumed: `CourierResolver`)

```capnp
@0xc7a1e5d3b2f40025;
using C = import "common.capnp";

struct Resolution {
  oci          @0 :Text;           # "oci://<repository>@sha256:<manifest>"
  expectedGen  @1 :C.Ref;
  attestations @2 :Data;           # JCS bundle: realisation DSSEs + keylos.tlogproof/1 proofs
  publisher    @3 :Text;           # key ref
  quorum       @4 :Text;           # "k/n" or "none"; authoritative for depot's quorum decision
  statement    @5 :Data;           # DSSE generation statement (§20.7)
  revocations  @6 :Data;           # DSSE keylos.revocations/1 (only for source "tuf:<stream>/revocations"; other fields empty)
  review       @7 :Text;           # catalog review status of the resolved generation: "reviewed-reproducible" | "unreviewed" | "" (not a catalog app)
  catalogEntry @8 :Data;           # JCS catalog entry (§20.20) when the generation is listed; empty otherwise
}

interface CourierResolver {        # facet depot
  resolve @0 (source :Text) -> (resolution :Resolution);
      #! source grammar:
      #!   "tuf:<stream>/<name>[@<version>]"       distro or publisher generation
      #!   "tuf:org:<org>/<name>[@<version>]"     org generation from the enrolled fleet's TUF repository
      #!   "tuf:<stream>/revocations"             revocation list (only `revocations` is set)
      #!   "tuf:catalog/<name>[@<version>]"       catalog lookup only (only `review` and `catalogEntry` are set)
}
```

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

#### protocols §10.1 Host layout

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

#### protocols §10.4 Extended attributes

| xattr | Writer | Content |
|---|---|---|
| `security.bpf.keylos.prov` | BPF LSM at inode creation (`strata`) | CBOR `{p: principal, g: generation, x: transaction, t: time}` |
| `security.bpf.keylos.label` | `broker` / `strata` | 2 bytes: conf, integ (§14.1 ordinals) |
| `security.keylos.unit` | `strata` | Crypto-shred unit ID |
| `trusted.overlay.metacopy`, `trusted.overlay.redirect` | `depot` (composefs) | |

Names a BPF LSM program must read or stamp use the `security.bpf.` prefix: the kernel's BPF xattr kfuncs (`bpf_get_file_xattr`, `bpf_get_dentry_xattr`, `bpf_set_dentry_xattr`) accept only `user.*` (read) and `security.bpf.*` names, and are available to LSM program types only. From userspace, setting or removing any `security.*` name, `security.bpf.*` included, needs `CAP_SYS_ADMIN` in the user namespace that owns the filesystem; no keylos BPF program attaches `inode_xattr_skipcap`, so that check always applies. Principals never hold `CAP_SYS_ADMIN` and never own a filesystem's user namespace, so only the writers listed above can set these names. `security.keylos.unit` is read only by `strata` and keeps its name.

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

#### protocols §11.7 Revocation list

```json
{"schema":"keylos.revocations/1","stream":"stable","serial":1234,"issued":"…",
 "objects":[{"ref":"obj:fsv256:…","reason":"CVE-2026-XXXX","action":"evict"}],
 "generations":[{"ref":"gen:fsv256:…","reason":"…","action":"unlaunchable"}],
 "keys":[{"ref":"key:sha256:…","reason":"compromised","after":"…"}]}
```

- Distributed as a TUF target by `courier` and logged (its digest) in the release statement.
- Actions: `unlaunchable`, `evict`, `warn`.
- A `keys[]` entry for a `publisher/<id>` or `org-publisher/…` key makes every generation whose only authorising signature is by that key `unlaunchable` from `after` onwards; generations signed before `after` stay launchable only if their realisations reach the rebuilder quorum.

#### protocols §11.8 Publishers and catalog

- **Onboarding.** A publisher is added to the TUF `publishers` delegated role (signed by `distro-root` delegation keys) with either an Ed25519 key held in hardware or a Sigstore identity (OIDC issuer + subject) and an accepted publisher policy version. Org publishers are delegated from a fleet's TUF repository (`org-publishers` role) and are trusted only on machines enrolled in that fleet.
- **Enabling.** A machine trusts a publisher only after the owner enables it in config (`/etc/keylos/publishers.json`, §20.20); it then enters the boot trust set at the next boot.
- **Catalog.** `keylos.catalog/1` (§20.20) is a TUF target signed by the `catalog` role. A listing is `reviewed-reproducible` only if its generations' realisations reach the rebuilder quorum and the catalog review passed; otherwise it is `unreviewed`. Installing an `unreviewed` app sets its effective tier floor to 2 unless the owner records an exception (`keylos.exception/1`, kind `reproducibility`).

#### protocols §13.1 Receipt payload

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

#### protocols §14.3 Approval tiers

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

#### protocols §14.5 Operating rules

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.

#### protocols §19.2 Facets (rows served by depot)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| depot | `user` | `shell`, atrium, aide, portal-openuri, portal-discovery, gate, any principal granted `depot#user` | `get`, `list`, `install`, `verify`, `revocations`, `revocationStatus`, `openObject` (closures the caller may spawn), `openPath` (`/.keylos/…` only) |
| depot | `mounter` | warden, bench, compat | `mount` (container generations only while rooted by `cri:pod:…`), `get`, `root`, `unroot`, `revocationStatus` |
| depot | `forge` | forge | `importTree`, `seal`, `get` |
| depot | `config` | config | `importTree` (kinds `config`, `policy`), `mount` (kind `config`), `get` |
| depot | `compat` | compat | `importTree` (kind `legacy-image`), `get`, `revocationStatus` |
| depot | `courier` | courier | `install`, `root`, `unroot`, `get`, `list`, `revocations` |
| depot | `cri` | cri | `install` (sources `oci+container://` and `tuf:`), `get`, `list`, `root`, `unroot` |
| depot | `admin` | config, owner `shell` (T3) | all incl. `gc` |
| depot | `loom` | loom | `get`, `openPath` (`/.keylos/manifest.json`, `/.keylos/workflows/*`), `revocationStatus`, `root`/`unroot` (holder prefix `loom:` only) |

#### protocols §19.2 Facets (rows held by depot on other services)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| broker | `system` | warden, gate, aide, atrium, config, hearth, strata, net, depot, vault, vouch, cri | `BrokerSystem` (per-method callers as commented in §7.5.2; `requestFor` with the allowed-subject rule, atrium only for its own session (device authorization); `registerApprover`: atrium, vouch; `admitPod`: cri; `mintCaptive`: net); `Broker.inspect` |
| ledger | `time` | net, warden, depot | `LedgerAdmin.timeFloor` |
| hearth | `presence` | broker, config, depot, courier, ledger, vault, aide, strata | `presence`; `HearthQuorum.request`/`collect` |
| hearth | `system` | warden, devd, config, broker, gate, vouch, strata, bench, depot, ledger, loom | `HearthSystem` (gate, vouch, strata, bench, depot, ledger: `owners` only; loom: `owners`, `userState`, `watchUsers`) |
| hearth | `seal` | depot, forge | `HearthSeal` |
| depot | `user` | `shell`, atrium, aide, portal-openuri, portal-discovery, gate, any principal granted `depot#user` | `get`, `list`, `install`, `verify`, `revocations`, `revocationStatus`, `openObject` (closures the caller may spawn), `openPath` (`/.keylos/…` only) |
| courier | `depot` | depot | `CourierResolver` |
| atrium | `presence` | config, depot, courier, hearth, forge | `TrustedPrompt.presence` |

#### protocols §19.3 Receipt events (rows written by depot)

| Event | Writer |
|---|---|
| `gen.install`, `gen.seal`, `gen.revoke`, `gen.gc` | depot |

Extension rule (protocols §19.3): a repository MAY emit additional events named `x-<repo>.<event>`; they MUST be listed in that repository's spec.

#### protocols §20.1 Boot trust set and boot report

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

#### protocols §20.8 Consent record (`keylos.consent/1`)

Signed by `service/depot` after the human approves a capability set:

```json
{"schema":"keylos.consent/1","generation":"gen:fsv256:…","name":"org.example.Editor",
 "capabilities":"sha256:<JCS digest of capability set>","approval":"a-…","mandate":"rcpt:sha256:…",
 "scope":"machine","decidedBy":"alice","time":"…"}
```

A consent record covers every later generation of the same `name` and publisher whose capability set is a subset of the consented set. Consent never makes code launchable on its own; launchability requires an authorising signature (§20.7). The broker consults consent records when minting install-time grants.

#### protocols §20.9 Owner exception (`keylos.exception/1`)

Presence-signed (purpose `exception`):

```json
{"schema":"keylos.exception/1","kind":"reproducibility","name":"org.example.Tool","publisher":"key:sha256:…",
 "generation":null,"reason":"vendor binary","scope":"machine","decidedBy":"alice","time":"…","expires":null}
```

`kind`:
- `reproducibility`: allows effective tier 1 for a non-reproducible or `unreviewed` generation. `generation` null matches all generations of `name` from `publisher`.
- `fleet-receipt-access`: `{"events": ["<event type>", …]}` in an extra field `events`; lets `fleet` read sealed payloads of those events (§13.4). `name`/`publisher` are null.

Exceptions are written by `config` to `/etc/keylos/exceptions/` (§10.7); `depot` and `ledger` read them from the booted config generation.

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

#### protocols §21.2 Runtime classes

| RuntimeClass | Isolation | Images | Notes |
|---|---|---|---|
| `keylos-vm` (default) | One `bench` microVM per pod sandbox (`VmSpec.purpose = pod`); containers run inside the guest under `youki` driven by `benchd` | Any OCI image, pulled by `cri` into `/var/lib/keylos/cri/images` (via `gate` when `cluster.egressViaGate`), shared read-only into the VM | VM principal `pod:<ns>/<name>:oci:sha256:<first image>@_cluster/…`; GPU only by passthrough |
| `keylos-sealed` | t1 principals spawned by `warden` through `PodSpawn` (§7.5.1) | Only `container` generations (§6.1) with a generation statement signed by an `org-publisher` key enabled on the machine | One principal per container; seccomp `runtime-default`; no added capabilities ever |

#### protocols §21.4 Images

- `keylos-vm`: OCI images are pulled by `cri` with digest pinning; tags are resolved once and recorded. They are never executed on the host (`noexec` store) and never registered with `kl-exec`.
- `keylos-sealed`: `cri` calls `Depot.install("oci+container://<registry>/<repo>@sha256:<manifest>")` (facet `cri`). `depot` converts the image with **`oci-convert/1`** into a `container` generation and makes it launchable only if a `keylos.genstmt/1` for that generation digest, signed by an enabled `org-publisher` key, is available from the org TUF repository (`courier`). `cri` roots the generation as `cri:pod:<pod-id>` before `PodSpawn`; `depot` mounts container generations only while so rooted.
- **`oci-convert/1`** (normative; implemented only by crate `keylos-oci-convert`, §18): layers applied in manifest order; OCI whiteouts (`.wh.<name>`) and opaque markers (`.wh..wh..opq`) resolved; hardlinks kept; device nodes, sockets and FIFOs dropped (the runtime provides `/dev`); numeric uid/gid and mode bits kept; setuid/setgid bits cleared; `security.capability` and all `security.*`/`trusted.*` xattrs dropped (no file capabilities, ever); `user.*` xattrs kept; timestamps zeroed; entries sorted by path bytes; the result is built into a composefs generation exactly as `depot` builds any generation, with `/.keylos/manifest.json` of kind `container` whose `container` section copies the OCI config.
- **Identity** of a converted generation: `name` = `oci.` + the registry host's labels reversed + `.` + the repository path segments, joined by `.`, with every character outside `[a-z0-9-]` replaced by `-`; `version` = `0.0.0+oci.<first 16 hex digits of the manifest digest>`; `derivation` (and the genstmt `drv`) = `drv:sha256:<SHA-256 of the JCS bytes of the conversion descriptor>`, where the descriptor is `{"schema":"keylos.ociconv/1","algorithm":"oci-convert/1","image":"oci:sha256:<manifest>","platform":"linux/amd64","config":"sha256:<config blob>","layers":["sha256:…"]}`. For kind `container`, `drv` names this descriptor, not a `keylos.drv/1` derivation. `layers` lists the **compressed layer blob digests exactly as they appear in the image manifest, in manifest order** (not uncompressed `diff_id`s); `platform` is the platform selected from an image index (or the manifest's config platform).

---

## 3. Requirements

### 3.1 Store integrity

- **REQ-DEPOT-001** Every file in `/store/objects` MUST have fs-verity enabled with SHA-256, Merkle block size 4096 and no salt, and no fs-verity builtin signature. `depot` MUST NOT depend on `fs.verity.require_signatures` or on any kernel keyring.
- **REQ-DEPOT-002** The object path MUST be `/store/objects/<first 2 hex of fsv256>/<remaining 62 hex>`. `depot` MUST measure (`FS_IOC_MEASURE_VERITY`) every object after enabling verity and MUST delete it if the measured digest differs from its name.
- **REQ-DEPOT-003** Every generation image `/store/gens/<hex>.erofs` MUST have fs-verity enabled, and its measured fs-verity digest MUST equal `<hex>`.
- **REQ-DEPOT-004** `depot` MUST NOT write to an object or image after verity is enabled. Objects and images are mode `0444`, owned by the depot UID; their parent directories are `0755` and writable only by the depot UID.
- **REQ-DEPOT-005** Signatures over generations MUST be verified in userspace from DSSE envelopes (protocols §4, §20.7). `depot` MUST NOT treat the presence of a file in `/store`, a database flag, or a filesystem attribute as evidence of authorisation.

### 3.2 Generations

- **REQ-DEPOT-010** A generation image MUST be a valid composefs EROFS image (§4.3) whose `/.keylos/manifest.json` passes protocols §6.3 validation for its kind.
- **REQ-DEPOT-011** Every non-empty regular file in a generation MUST be a metacopy redirect to an existing store object whose fs-verity digest equals the `trusted.overlay.metacopy` value. Zero-length regular files MUST be stored inline with no redirect (protocols §6.2).
- **REQ-DEPOT-012** Generations MUST NOT contain device nodes, FIFOs, sockets, setuid/setgid/sticky bits, `security.*` xattrs, or xattrs outside `user.*` and the composefs `trusted.overlay.*` set. The only exception is kind `container`, whose conversion rules (§4.19) keep recorded ownership, permission bits and the sticky bit on directories, and strip everything else listed here.
- **REQ-DEPOT-013** `depot` MUST compute, for every generation, its **closure** (the set of objects referenced, plus the closures of the `runtime` generation it names) and record it in the database.
- **REQ-DEPOT-014** `depot` MUST accept every kind in protocols §6.1 (including `part`, `container` and `kmod`) and MUST apply the kind rules of §4.5 (which kinds are launchable, mountable by whom, and what authorises them).

### 3.3 Launchability

- **REQ-DEPOT-020** A generation is **launchable** iff all of the following hold (algorithm in §4.6):
  1. its kind is one of `os`, `runtime`, `app`, `service`, `agent-template`, `bench-image`, `legacy-image`, `data`, `container`, `kmod`;
  2. its image and every object in its closure are present and verified (REQ-DEPOT-001..003);
  3. it has a valid **generation statement** (`keylos.genstmt/1`) whose `generation`, `kind`, `name`, `version`, `manifestDigest` and `objects` match the image, signed by an **authorising key** for its origin (protocols §20.7) that is present in the boot trust set (§4.7);
  4. for owner-sealed generations: a valid seal statement (`keylos.seal/1`, §4.11) exists for the generation;
  5. it is not listed `unlaunchable` in the effective revocation list, none of its authorising signatures is by a key revoked for its `issued` time, and no object in its closure is listed `evict` or `unlaunchable`;
  6. for kinds `app`, `service`, `agent-template`, `bench-image`, `legacy-image`, `runtime`, `data` that declare authority in their manifest: a consent record (protocols §20.8) covers its capability set (§4.9);
  7. for distribution-channel generations with `reproducible: true`: the realisation quorum recorded at install is satisfied (§4.8), and every owner-required rebuilder attested;
  8. its `requiresFeatureLevel` is ≤ the running kernel's feature level;
  9. kind `container`: the authorising key is an **org-publisher** key, i.e. a key in `trust.keys.publishers` whose `/etc/keylos/publishers.json` entry has scope `org:<org>` (protocols §20.20), and the machine is enrolled in that org's fleet (the same file lists the org only when enrolled);
  10. kind `kmod`: the authorising key is a `release-stream/<stream>` key (publisher, org-publisher and owner-seal signatures never authorise a `kmod`), and `manifest.kmod.kernel` equals the running kernel release (`uname -r`); otherwise reason `kernel-mismatch`;
  11. for third-party publisher generations (kinds `app`, `runtime`, `agent-template`, `data`) the catalog review status is `reviewed-reproducible`, or an owner exception of kind `reproducibility` covers it; otherwise the generation is launchable **only in VMs** and carries reason `unreviewed-tier2` (§4.21);
  12. it was not installed under the offline rule of §4.22 without the required T3 approval (reason `offline-install-needs-t3`).
- **REQ-DEPOT-021** `depot` MUST recompute launchability for every generation at service start from evidence on disk and the current boot trust set, MUST NOT trust a launchability flag stored in the database, and MUST finish the recomputation before answering `mount` on facet `mounter` for callers other than `bench` and `compat`.
- **REQ-DEPOT-022** `mount` for `warden` MUST refuse non-launchable generations with `kl:integrity` (verification failure), `kl:revoked`, `kl:needs-approval:<a-…>` (consent or offline approval pending) or `kl:unsupported` (feature level, kernel mismatch). A generation whose only reason is `unreviewed-tier2` is **not** refused for `warden`: `GenerationInfo.launchable` is false (it is not host-launchable) and `warden` uses `launchReasons` to apply the effective tier floor 2 (protocols §11.8), routing the spawn to `bench`. `mount` for `bench` and `compat` is unaffected by catalog review.
- **REQ-DEPOT-023** `verify(ref)` MUST return, in `problems`, every launchability reason code (§4.6) that applies, so CLIs can show why a generation is not launchable.
- **REQ-DEPOT-024** Every `GenerationInfo` that `depot` returns MUST carry `launchReasons` = the reason codes of the latest evaluation (§4.6), empty iff `launchable` is true. The codes defined by protocols §7.3.8 (`no-authorising-signature`, `revoked:<reason>`, `needs-consent`, `quorum-deferred`, `unreviewed-tier2`, `offline-install-needs-t3`, `kernel-mismatch`) MUST be used for those conditions; `depot` adds the depot-local codes of §4.10 for the remaining conditions.
- **REQ-DEPOT-025** `depot` MUST reject any generation statement whose `issued` time is later than trusted time plus 24 h (protocols §14.5), with reason `no-authorising-signature` and problem `statement-from-future`.

### 3.4 Install

- **REQ-DEPOT-030** `install` MUST accept the sources:
  - `tuf:<stream>/<name>[@<version>]` and `tuf:publisher/<id>/<name>[@<version>]`, resolved only through `CourierResolver.resolve` (protocols §7.5.6);
  - `tuf:<stream>/revocations` (revocation-list hand-off, §4.14);
  - `tuf:org:<org>/<name>[@<version>]` and `tuf:org:<org>/revocations` (org channels of an enrolled fleet, resolved by `courier`);
  - `oci://<registry>/<repository>@sha256:<manifest>[#gen=fsv256:<hex>]`;
  - `oci+container://<registry>/<repository>@sha256:<manifest>` on facet `cri` only (conversion to a `container` generation, §4.19);
  - `klb:fd:<n>` naming a `.klb` bundle passed as an fd obtained through the powerbox (§4.12).
  Any other source, and `oci+container://` on any facet other than `cri`, MUST fail with `kl:invalid`.
- **REQ-DEPOT-031** `depot` MUST NOT open sockets itself and MUST NOT implement a TUF client. All network fetches MUST go through `gate.connect` with the depot's tokens.
- **REQ-DEPOT-032** Network installs MUST verify, in this order:
  1. the OCI manifest digest equals the pinned digest;
  2. the EROFS image's fs-verity digest equals the expected generation (`#gen=` fragment, `Resolution.expectedGen`, or the OCI config's `generation`);
  3. the generation statement's signatures against the boot trust set (REQ-DEPOT-020.3);
  4. manifest validation and statement/manifest consistency;
  5. per-object fs-verity digests as each object is written.
  Any failure aborts with `kl:integrity` and leaves no new state except objects whose digests verified, which become garbage for the next GC.
- **REQ-DEPOT-033** `depot` MUST fetch only objects not already present (partial pull, §4.4).
- **REQ-DEPOT-034** On install or update, `depot` MUST compute the **capability diff** (§4.9). If the diff widens authority, `depot` MUST request approval with `BrokerSystem.requestFor` for its own session (T2; T3 when the diff adds `needs.jit`, `needs.realtime`, `needs.gpu: "passthrough"`, an `irreversible` effect, `devices`, `needs.listen` with scope `any`, or lowers `tier`) with an idempotency key derived from the generation and the capability digest, and MUST return `kl:needs-approval:<a-…>` until approved. The objects and image stay stored; the generation stays non-launchable (reason `needs-consent`).
- **REQ-DEPOT-035** `install` MUST be idempotent: installing an already-present generation only adds evidence, consent and roots.
- **REQ-DEPOT-036** Offline bundles (`.klb`) MUST be verifiable without network (§4.12). A bundle-installed distribution generation whose realisation quorum cannot be confirmed offline MUST stay non-launchable (reason `quorum-deferred`) until `courier` confirms it through `CourierResolver.resolve` at the next online refresh.
- **REQ-DEPOT-037** When the **revocation age** (protocols §14.5) exceeds 30 days, installing a third-party generation (publisher, org-publisher or `container` origin) that has never been installed on this machine (no earlier generation of the same `name` and publisher) MUST require a T3 approval through `BrokerSystem.requestFor` before the generation becomes launchable (reason `offline-install-needs-t3`). Distribution-stream generations and owner-sealed generations are exempt. A later fresh revocation list does not lift a pending requirement; the approval does.
- **REQ-DEPOT-038** `depot` MUST obtain the catalog review status of every third-party publisher generation it installs from `courier` (§4.21) and MUST record it with the generation's evidence.

### 3.5 Local imports and seals

- **REQ-DEPOT-040** `importTree` MUST write the tree's files as objects (verity enabled), build the composefs image and write it to `/store/gens/`, record the manifest, and return a `GenerationInfo` with `launchable=false`, `sealedBy=[]`. The kinds accepted depend on the facet: `forge` all kinds; `config` kinds `config` and `policy`; `compat` kind `legacy-image`.
- **REQ-DEPOT-041** `seal` (facet `forge`) MUST verify that `statement` is a DSSE envelope of `keylos.seal/1` signed by an `owner-seal/<i>` key from the boot trust set, that `statement.generation` equals the ref, that `statement.machine` equals this machine's key, that `statement.window` and `statement.windowDigest` are present, and that `sealedAt` is within ±600 s of trusted time. It MUST then obtain an owner-seal signature over the generation statement through `HearthSeal.sealSign` within the same window (any `hearth#seal` holder may sign within a window another holder opened, protocols §7.5.3), store both, and recompute launchability. Owner seals MUST be refused for kinds `kmod` and `container` (`kl:denied`).
- **REQ-DEPOT-043** **Window digest check.** Before accepting a seal, `depot` MUST find the `seal.window` receipt (hearth) for `statement.window` through `Ledger.query` on its `ledger#reader` route and MUST verify that the receipt's `windowDigest` equals `statement.windowDigest`. If no such receipt exists yet, `seal` fails with `kl:conflict` (retryable); if the digests differ, `seal` fails with `kl:integrity`. The receipt reference is stored as evidence (`seal-window.rcpt`) so later recomputations do not query the ledger.
- **REQ-DEPOT-042** An owner-sealed generation with `reproducible: false` MUST remain marked so; its effective tier is computed by `warden` (protocols §6.3). `depot` MUST read owner exceptions (protocols §20.9) from `/etc/keylos/exceptions/*.dsse` of the booted config generation (protocols §10.7), MUST accept only presence-signed exceptions whose signing credential is in the boot trust set's `ownerPresence` keys, MUST copy accepted envelopes under `/store/evidence/exceptions/` (§4.18), and MUST ignore exceptions of kind `fleet-receipt-access` (they concern `ledger`).

### 3.6 Mount

- **REQ-DEPOT-050** `mount` MUST return an `fsmount` fd (not attached to any namespace) of an overlayfs with the generation's EROFS image as the metadata lower layer and `/store/objects` as the data-only lower layer, options `metacopy=on,redirect_dir=on,verity=require`, attributes `MOUNT_ATTR_RDONLY|MOUNT_ATTR_NOSUID|MOUNT_ATTR_NODEV`. `MOUNT_ATTR_NOEXEC` MUST NOT be set; host execution is governed by `kl-exec`.
- **REQ-DEPOT-051** Mount authorisation by facet and caller (§4.5):
  - facet `mounter`, caller `warden`: launchable generations of launchable kinds only;
  - facet `mounter`, callers `bench` and `compat`: any generation whose objects verify, including non-launchable ones (unsigned local imports, parts, imported legacy images), because they are exported only into VMs;
  - facet `mounter`, caller `warden` for `container` generations: only when `warden` mounts them for a `PodSpawn` requested by `cri` (the `MountRecord` records the pod session);
  - facet `mounter`, caller `warden` for `kmod` generations: only when `manifest.kmod.kernel` equals the running kernel release;
  - facet `config`: kind `config` only.
- **REQ-DEPOT-052** Each `mount` call MUST produce a **new overlay superblock**. `depot` MUST NOT hand the same overlay superblock to two callers, so that `kl-exec` registration by superblock identifies exactly one verified generation (protocols §9.3).
- **REQ-DEPOT-053** `depot-mount-helper` MUST implement the same mount procedure without `depotd` for use by `boot`, and MUST verify the image's fs-verity digest against a digest supplied by the caller.

### 3.7 Roots, GC, revocation

- **REQ-DEPOT-060** Roots are `(ref, holder)` pairs. Holders are named `<holder>:<purpose>:<id>` (protocols §7.3.8) and namespaced by the caller's service. Registered prefixes: `warden:running:<session>`, `cri:pod:<pod-id>`, `courier:os:<seq>`, `courier:kmod:<kernel-release>`; repo-local prefixes: `courier:good:<seq>` (last known-good OS generation), `user:<human>:installed`, `config:gen:<counter>`, `aide:template:<name>`, `bench:image:<name>`, `forge:part:<drv>`, `compat:image:<name>`, `cri:image:<manifest digest hex>`. A caller MAY only add or remove roots in its own namespace (`user:` for facet `user`, with `<human>` = the caller's human).
- **REQ-DEPOT-065** **Mount roots from `warden`.** `warden` holds a root `warden:running:<session>` for every generation mounted for a running principal and calls `unroot` when the last principal using the mount exits (protocols §7.3.8). `depot` MUST treat the removal of the last `warden:running:*` root of a generation as the release of every `warden` mount of it (no separate unmount notification exists) and MUST then drop its EROFS mount after 60 s (§4.16).
- **REQ-DEPOT-061** `gc` MUST delete every generation that is not reachable from a root and is older than the retention grace (default 24 h), and every object not referenced by a remaining generation and older than 1 h.
- **REQ-DEPOT-062** `depot` MUST NOT collect a generation that has an open mount (tracked by `warden:running:*` roots and by `depot`'s own mount table).
- **REQ-DEPOT-063** The effective revocation list for a stream is the highest-serial valid list delivered by `courier` in `Resolution.revocations` (§4.14). On a new list, `depot` MUST recompute launchability, MUST write a `gen.revoke` receipt for each generation that became non-launchable, and MUST evict `evict` objects at the next GC regardless of roots.
- **REQ-DEPOT-064** Revocation lists MUST be accepted only if signed by the stream's `release-stream/<stream>` key from the boot trust set (for org lists `tuf:org:<org>/revocations`: an org-publisher key of that org) and with `serial` strictly greater than the current one for that stream.
- **REQ-DEPOT-066** **Publisher-key revocation.** A `keys[]` entry naming a `publisher/<id>` or `org-publisher/…` key with `after = T` MUST make every generation whose *only* authorising signature is by that key `revoked:key-compromised` for statements issued at or after `T`; generations whose statements were issued before `T` stay launchable only if their realisation quorum is satisfied (§4.8), otherwise they get reason `revoked:key-compromised` too (protocols §11.7).

### 3.8 Receipts

- **REQ-DEPOT-070** `depot` MUST write `gen.install`, `gen.seal`, `gen.revoke` and `gen.gc` receipts (protocols §19.3) through `Ledger.append` before reporting success, and the extension events of §9.2.
- **REQ-DEPOT-071** If `ledger` is unavailable, every mutating method MUST fail with `kl:unavailable` and leave no committed state change.

### 3.9 Container generations (for `cri`)

- **REQ-DEPOT-080** `install("oci+container://<registry>/<repository>@sha256:<manifest>")` on facet `cri` MUST fetch the OCI image manifest pinned by digest (tags are never accepted), its config and layers through `gate`, and convert them with the deterministic algorithm of §4.19 into a `container` generation. Two conversions of the same manifest digest and platform MUST produce the same generation digest on every machine and in `forge container convert`.
- **REQ-DEPOT-081** The converted generation is launchable only if a `keylos.genstmt/1` for exactly that generation digest, signed by an enabled org-publisher key of an org the machine is enrolled in, is obtained from `courier` (`CourierResolver.resolve("tuf:org:<org>/<name>@<version>")`, §4.19 step 9). Without it, the generation is stored with reason `no-authorising-signature` and `install` returns normally (so that `cri` can report a precise error).
- **REQ-DEPOT-082** `depot` MUST NOT run any image content during conversion and MUST NOT interpret image configuration beyond copying it into `manifest.container.config` (protocols §6.3).
- **REQ-DEPOT-083** Images for the `keylos-vm` runtime class are not `depot`'s concern: `cri` stores them itself in `/var/lib/keylos/cri/images` (protocols §21.4). `depot` MUST refuse `oci+container://` sources whose image index lacks a manifest for the requested platform (`kl:unsupported`).

### 3.10 Kernel-module generations

- **REQ-DEPOT-085** A `kmod` generation MUST contain only `/.keylos/…` metadata and `/lib/modules/<kmod.kernel>/extra/**/*.ko` files plus optional `/lib/firmware/**` files listed in `kmod.firmware`. Any other path fails install with `kl:invalid`.
- **REQ-DEPOT-086** Every `.ko` object MUST end with the kernel module signature trailer (`~Module signature appended~\n` magic preceded by a `module_signature` structure with `id_type = PKEY_ID_PKCS7`). `depot` checks the trailer's presence and structure only; the kernel verifies the signature (`module.sig_enforce=1`, protocols §9.3). A missing or malformed trailer fails install with `kl:integrity`.
- **REQ-DEPOT-087** `kmod` generations are authorised only by `release-stream/<stream>` generation statements (REQ-DEPOT-020.10) and never by owner seals (REQ-DEPOT-041).

### 3.11 Reading inside generations

- **REQ-DEPOT-090** `openPath(ref, path)` MUST resolve `path` inside the generation's own tree from the generation's EROFS root with `openat2(RESOLVE_IN_ROOT|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV)` and MUST return a read-only fd of a regular file; directories, symlinks resolving outside the tree, and non-regular files fail with `kl:invalid`.
- **REQ-DEPOT-091** On facet `user`, `openPath` MUST accept only paths under `/.keylos/` matching `manifest.json`, `cmdsig/*.json`, `l10n/*.json`, `agent/**`, `icons/**`, `sbom.spdx.json` or `provenance.json`, and only for generations the caller may spawn (as for `openObject`), agent templates, or generations named in the current catalog (§4.21). On facet `mounter` any path is allowed. All other facets get `kl:denied`.
- **REQ-DEPOT-092** `openPath` and `openObject` MUST return fds that are not writable, not executable through `execveat` (the store is `noexec`), and opened with `O_NOFOLLOW`.

**Revocation status, trusted time and catalog lookups**

- **REQ-DEPOT-093** `revocationStatus()` (facets `user`, `mounter`, `compat`) MUST return the `serial` and `issued` of the newest *verified* revocation list over all subscribed streams and enrolled orgs, and `ageSecs = trusted_now − issued` (§4.22). With no list ever accepted it MUST return `serial = 0`, `issued = 0` and `ageSecs` = seconds since the booted OS generation's release statement `issued`. It MUST NOT fail while `ledger` is unavailable; it then uses the last cached time floor.
- **REQ-DEPOT-094** `depot` MUST compute **trusted time** as `max(CLOCK_REALTIME, LedgerAdmin.timeFloor())` over its `ledger#time` route (protocols §3.6), refreshed at most every 60 s and cached in memory. It MUST NOT derive trusted time from `Ledger.checkpoint` or from the RTC alone.
- **REQ-DEPOT-095** The catalog review status MUST be taken from `Resolution.review` and the entry from `Resolution.catalogEntry` of `CourierResolver.resolve("tuf:catalog/<name>@<version>")` (protocols §7.5.6). An empty `review` means "not a catalog app" and is treated as `unreviewed` for third-party publisher generations. `depot` MUST verify that the entry's `name` and `review` match the resolution and that the entry names the generation (§4.21); a mismatch is recorded as problem `catalog-mismatch` and yields `unreviewed`.
- **REQ-DEPOT-096** For kind `container`, `manifest.derivation` and the authorising genstmt `drv` MUST equal `drv:sha256:` of the JCS bytes of the `keylos.ociconv/1` descriptor computed by `oci-convert/1` (protocols §21.4). A genstmt whose `drv` differs is not authorising (problem `drv-mismatch`).
- **REQ-DEPOT-097** `depot` MUST verify non-presence mandates with the `service/broker` public key obtained from `Ledger.serviceKey("broker")` (cached per boot, re-fetched once on a key-id miss) and presence-signed mandates against `HearthSystem.owners` (protocols §14.4). It MUST NOT accept approver-channel keys.

---

## 4. Design

### 4.1 Process structure

`depotd` is one process with these modules:

| Module | Responsibility |
|---|---|
| `api` | capwire server for `Depot`; facet dispatch per §5.1; per-caller identity from `ServiceHost.accept` |
| `objects` | object write path: write → fsync → digest → enable verity → measure → rename |
| `images` | composefs EROFS writer and reader (`keylos-composefs`) |
| `evidence` | write-once evidence files: statements, seals, provenance, proofs, consent, exceptions |
| `trust` | boot trust set loading, statement verification, launchability evaluation, revocations |
| `fetch` | OCI client and objects-pack partial fetch over `gate` sockets |
| `resolve` | `CourierResolver` client |
| `consent` | capability diff and approvals through `broker` |
| `seal` | seal verification and owner-seal generation statements through `HearthSeal` |
| `db` | metadata cache (redb) |
| `gc` | roots, retention, mark and sweep |
| `mounts` | fsmount construction and the private EROFS mount table |
| `receipts` | receipt construction and `Ledger.append` |
| `parse` | client of the `depot-parse` subprocess |
| `convert` | `oci+container://` conversion (`keylos-oci-convert`, §4.19) |
| `catalog` | catalog review status from `courier` and the effective tier-floor reason (§4.21) |
| `offline` | revocation age and the offline install rule (§4.22) |

Concurrency: tokio multi-threaded runtime with at most 4 worker threads; hashing and verity enabling run on a bounded blocking pool (`min(4, ncpu)`). A store-wide **mutation lock** (async RwLock) serialises GC against installs: installs, imports and seals take it shared; `gc` takes it exclusively.

### 4.2 On-disk layout

```
/store/                              btrfs subvolume @store (excluded from strata schedules, §6.4)
  objects/<aa>/<62 hex>              objects (0444, fs-verity)
  gens/<64 hex>.erofs                generation images (0444, fs-verity)
  evidence/<64 hex>/                 per-generation evidence (files written once, 0444)
      manifest.json                  copy of /.keylos/manifest.json (for evidence-only checks)
      statement.dsse                 generation statement with all authorising signatures known so far
                                     (path registered in protocols §10.7: read by boot and warden)
      seal-window.rcpt               rcpt ref of the hearth seal.window receipt checked at seal time (owner-sealed only)
      catalog.json                   catalog entry and review status from courier (third-party publisher generations, §4.21)
      conversion.json                container conversion record (kind container, §4.19)
      offline.json                   offline-install record and approval (§4.22)
      seal.dsse                      owner seal statement (owner-sealed only)
      resolution.json                Resolution from courier (tuf: and courier-installed oci: sources)
      provenance.json                copy of /.keylos/provenance.json, if present
      proofs/<n>.json                keylos.tlogproof/1 documents not inside provenance
      consent -> ../../consent/<64 hex>.dsse   (symlink to the consent record covering it)
      source.json                    {"source": …, "installedBy": principal, "time": …}
  evidence/exceptions/<ULID>.dsse    owner exceptions (keylos.exception/1)
  consent/<64 hex>.dsse              consent records, named by SHA-256 of the envelope
  revocations/<stream>.dsse          current revocation list per stream (path registered in protocols §10.7: read by
                                     boot and warden); org lists are stored as revocations/org:<org>.dsse
  journal/<op ULID>.json             in-flight operation journal (§4.15)
  incoming/<op ULID>/                temporary files of in-flight operations
  quarantine/<64 hex>                objects that failed re-measurement
  db/depot.redb                      metadata cache
  db/LOCK                            flock held by depotd
```

`/store` is mounted `nosuid,nodev,noexec`. Generations are exposed only through overlay mounts made by `depot`; the overlay mount itself is not `noexec`, and `kl-exec` decides execution by overlay superblock.

### 4.3 composefs image format

`depot` writes images compatible with `mkcomposefs` (composefs format version 1) and the overlayfs data-only lower layer model.

| Aspect | Requirement |
|---|---|
| Filesystem | EROFS, block size 4096, no device table, compact inodes where possible, no compression |
| Root | Inode for `/`, mode `0555`, uid 0, gid 0 |
| Directory order | Entries sorted by byte-wise comparison of names; `.` and `..` present |
| Regular file, size > 0 | `i_size` = object size, no data blocks; xattrs `trusted.overlay.metacopy` = `0x00 0x24 0x00 0x01` ‖ 32-byte fs-verity digest (overlayfs metacopy v1 with digest) and `trusted.overlay.redirect` = `/<aa>/<62 hex>` |
| Regular file, size 0 | Inline empty inode, no xattrs, no redirect |
| Symlink | Inline target, ≤ 4095 bytes |
| Directory mode | `0555` |
| File mode | `0444` or `0555`; any other mode is rejected on import |
| Ownership | uid 0, gid 0 everywhere |
| Timestamps | `mtime = 0`, `mtime_nsec = 0` everywhere |
| Hard links | Not emitted; identical content dedups at the object level |
| xattrs | Only those permitted by REQ-DEPOT-012; sorted; shared xattr table for identical sets |
| Whiteout-named files | Escaped with the overlay whiteout escape xattrs exactly as the composefs reference writer does |

**Determinism.** The same input description (paths, modes, symlink targets, object digests and sizes, permitted xattrs) MUST produce a byte-identical image. `keylos-composefs` MUST pass the cross-check vectors in §11.4 against `mkcomposefs --digest-store` output.

**Input description (`TreeEntry`).** Image building never reads file bytes, only digests:

```rust
pub enum TreeEntry {
    Dir  { path: Utf8Path, mode: u16, xattrs: Vec<(Vec<u8>, Vec<u8>)> },
    File { path: Utf8Path, mode: u16, size: u64, digest: Option<[u8; 32]>, xattrs: Vec<(Vec<u8>, Vec<u8>)> }, // None iff size == 0
    Link { path: Utf8Path, target: Vec<u8> },
}
```

### 4.4 Distribution format (OCI)

A keylos generation is an OCI image manifest (image-spec 1.1) with `artifactType: application/vnd.keylos.generation.v1`:

| Part | Media type | Content |
|---|---|---|
| `config` | `application/vnd.keylos.generation.config.v1+json` | `{"generation":"gen:fsv256:…","kind":…,"name":…,"version":…,"objects":<count>,"objectBytes":<sum>,"runtime":"gen:fsv256:…"|null}` |
| layer 0 | `application/vnd.keylos.erofs.v1` | The EROFS image bytes |
| layer 1 | `application/vnd.keylos.objpack.v1.tar+zstd` | Objects pack |
| annotations | `org.keylos.generation`, `org.keylos.drv`, `org.opencontainers.image.version` | |

**Objects pack.** A tar stream compressed as **zstd:chunked** (each tar entry starts a new zstd frame; a skippable-frame footer points to a TOC). Entries are `objects/<64 hex>` (object bytes), sorted by digest. The TOC is the zstd:chunked JSON TOC (`version: 1`; entries with `name`, `type`, `size`, `offset`, `endOffset`, `digest` = SHA-256 of the uncompressed entry). Objects larger than 4 MiB are split into chunk entries (`chunkSize`). The pack carries no signatures.

**Partial pull.**
1. Fetch the TOC with an HTTP range request on the blob tail (footer: last 64 bytes; TOC length from the footer).
2. Intersect the TOC object list with present objects.
3. Coalesce the missing ranges (ranges closer than 256 KiB merge; ≤ 32 ranges per request; ≤ 8 requests in flight).
4. Registries without range support: fetch the whole blob and skip present objects while streaming.

**Referrers** (OCI 1.1 Referrers API, `subject` = the generation manifest):

| artifactType | Content |
|---|---|
| `application/vnd.keylos.genstmt.v1+dsse` | Generation statement DSSE (protocols §20.7), possibly multiple signatures |
| `application/vnd.keylos.provenance.v1+json` | Provenance bundle (protocols §11.3) |
| `application/spdx+json` | SBOM |
| `application/vnd.dev.sigstore.bundle.v0.3+json` | Sigstore bundle for publishers using keyless identities (the delegation names the identity; `courier` verifies it) |

### 4.5 Kind rules

| Kind | Launchable | Authorising evidence | `mount` callers | Consent | Quorum |
|---|---|---|---|---|---|
| `os` | yes | genstmt by `release-stream/<stream>` | warden (bootstrap re-mounts), bench, compat; `boot` via helper | no (stream subscription in config) | yes (via courier) |
| `runtime`, `app`, `service`, `agent-template`, `bench-image`, `data` | yes | genstmt by release-stream, publisher, or owner-seal + seal statement | warden (launchable only), bench, compat | yes, when `needs` grants authority | yes for channel generations with `reproducible: true` |
| `legacy-image` | yes when signed (tier L); imported images are not | genstmt by release-stream or owner-seal; imported images have none | warden (launchable only), bench, compat | yes | as above |
| `part` | no | — (build intermediates; may carry a release-stream genstmt for caching) | bench, compat | no | no |
| `container` | yes, only for `warden` spawning a `cri` pod (`PodSpawn`) | genstmt by an enabled org-publisher key (REQ-DEPOT-020.9) | warden (pod spawns only), bench (pod VMs) | no (pod admission by `broker`, protocols §21.3) | no |
| `kmod` | yes, module path only, when `kmod.kernel` = running kernel | genstmt by `release-stream/<stream>` only | warden (module path), `boot` via helper | no | yes (distribution channel) |
| `config` | no (authorised by `keylos.configgen/1`, checked by `boot`) | — | facet `config`; `boot` via helper | no | no |
| `policy` | no (loaded by `broker` through `config`) | — | none (read through `openObject` by holders of `depot#user` routed by policy) | no | no |

Generation statements for `part` generations from distribution channels are kept as evidence but never make a part launchable.

### 4.6 Launchability evaluation

```
launch(G):
  r := []                                                         # reason codes (§4.10)
  if kind(G) ∉ LAUNCHABLE_KINDS:                 r += "kind-not-launchable"
  if !present(image(G)) or !verified(image(G)):  r += "missing-image"
  for o in closure(G): if !present(o):           r += "missing-object"
  S := statement(G)
  if S is none:                                  r += "no-authorising-signature"
  else:
    if S.generation≠G or S.manifestDigest≠sha256(manifest(G)) or S.objects≠objdigest(closure(G)) or S.kind≠kind(G):
                                                 r += "statement-mismatch"
    if S.issued > trusted_now + 24 h:            r += "no-authorising-signature"        # problem statement-from-future
    K := authorising_keys(origin(G), kind(G), trust)              # §4.7: kmod → release-stream only;
                                                                  #        container → enabled org-publisher keys only
    if no signature of S verifies with a key in K:
       if signature verifies with a key not yet in trust: r += "key-pending-reboot"
       else:                                     r += "no-authorising-signature"
    if origin(G) = owner-seal and !valid_seal(G): r += "no-seal"
  if revoked_gen(G):                             r += "revoked:" + reason
  if key_revoked(verifying_sig(S)) per §4.7:      r += "revoked:key-compromised"
  if any o ∈ closure(G) listed evict|unlaunchable: r += "revoked:object"
  if needs_consent(G) and !consent_covers(G):     r += "needs-consent"
  if channel(G) and reproducible(G) and !quorum_ok(G): r += "no-quorum" | "quorum-deferred"
  if featureLevel(G) > running_level:            r += "feature-level"
  if kind(G) = kmod and manifest(G).kmod.kernel ≠ uname_r: r += "kernel-mismatch"
  if third_party(G) and review(G) ≠ reviewed-reproducible and !exception(G, "reproducibility"):
                                                 r += "unreviewed-tier2"                # §4.21
  if offline_pending(G):                         r += "offline-install-needs-t3"        # §4.22
  if runtime(G) and !launch(runtime(G)).ok:      r += "runtime-not-launchable"
  return (r = [], r)
```

`unreviewed-tier2` alone does not make `mount` refuse `warden` (REQ-DEPOT-022): it tells `warden` to apply tier floor 2. All other codes make the generation non-launchable for `warden`.

**Webapps.** For a generation with a `webapp` section, `runtime(G)` is `webapp.browserRuntime` (and the manifest's `runtime`, if any); both must be launchable. Install rejects (`kl:invalid`) a webapp generation that declares `needs.jit: true` or whose `browserRuntime` is not a `runtime` generation (protocols §6.3).

`objdigest(closure)` is the SHA-256 over the newline-terminated, sorted, lowercase hex fs-verity digests of the closure objects (protocols §20.7). The closure here is the generation's own objects; a `runtime` generation's objects are checked as part of the runtime's own launchability, and `launch(G)` additionally requires `launch(runtime(G))`.

Recomputation at start reads evidence only. It does not re-hash objects: fs-verity makes every read of a tampered object fail with `EIO`, and `verify --deep` re-measures on demand.

### 4.7 Boot trust set and authorising keys

At start and on every `ServiceHost.reload`, `depot` reads `/run/keylos/boot/trust.json` (protocols §20.1). The trust set changes only across reboots.

| Origin of G | `K` (authorising keys) |
|---|---|
| Distribution stream (`source.json` stream, or statement `stream` field) | `keys.releaseStream` |
| Publisher (`Resolution.publisher` or bundle metadata naming a publisher) | `keys.publishers` ∩ {`Resolution.publisher`} ∩ {keys whose `publishers.json` entry has scope `distro`} |
| Org publisher (`tuf:org:<org>/…` sources, `container` generations) | `keys.publishers` ∩ {keys whose `publishers.json` entry has scope `org:<org>`} |
| Owner-sealed | `keys.ownerSeal` |

Kind restrictions apply on top: `kmod` accepts only `keys.releaseStream`; `container` accepts only org-publisher keys; `os`, `bench-image`, `agent-template` from the distribution accept only `keys.releaseStream`. `depot` reads the scope of each publisher key from `/etc/keylos/publishers.json` (protocols §10.7, §20.20); the key itself MUST also be in the boot trust set.

Keys are looked up by `keyid` in `spki`. Ed25519 and ECDSA P-256 are verified with `keylos-formats`. A signature by a key that verifies but is not in the trust set gives reason `key-pending-reboot` when the key is a configured publisher or an enrolled owner-seal key not yet in the trust set (read from `/etc/keylos/publishers.json` and `/etc/keylos/owner-seal/*.spki` in the running config generation); otherwise `bad-signature`.

A key listed in an effective revocation list with `after = T` invalidates signatures whose statement `issued` (or seal `sealedAt`) is ≥ T. A revocation entry without `after` invalidates all its signatures; release engineering then re-signs affected generations with a new key, which `depot` picks up as an additional signature in `statement.dsse` at the next install of the same generation (REQ-DEPOT-035).

**Publisher and org-publisher keys** (protocols §11.7): for a revoked `publisher/<id>` or `org-publisher/…` key with `after = T`, a generation whose only verifying authorising signature is by that key is:
- `revoked:key-compromised` if its statement `issued` ≥ T;
- still launchable if `issued` < T **and** its realisation quorum is satisfied (`quorum_ok`, §4.8; container generations have no quorum and are therefore always revoked);
- `revoked:key-compromised` otherwise.
An org list (`tuf:org:<org>/revocations`) may revoke only keys and generations of its own org; entries naming anything else are ignored and logged.

### 4.8 Realisation quorum

Quorum policy (rebuilder operators, thresholds, witness keys) lives in TUF metadata, which only `courier` reads. Division of work:

| Check | Done by | When |
|---|---|---|
| ≥ k attestations from distinct operators named in the stream or publisher policy, same `drv` and generation digest, each with a log inclusion proof cosigned by ≥ `witnessThreshold` witnesses | `courier` | at `resolve` (`Resolution.quorum` = `"k/n"`, `"none"` for channels without quorum) |
| Every attestation in `Resolution.attestations` names this generation (`subject[].digest.fsv256`), the manifest's `derivation` in `predicate.drv`, and an `output` | `depot` | at install and at every recompute |
| `Resolution.quorum` is not `"none"` when `reproducible: true` and the channel requires quorum | `depot` | at install and at every recompute |
| Owner-required rebuilders (`store.requireOperators`): an attestation signed by a key listed for that operator in `store.ownerRebuilders` verifies | `depot` | at install and at every recompute |

`quorum_ok(G)` is true iff all `depot` rows hold. For generations installed from a `.klb` bundle, `depot` holds the attestations but no `Resolution`; `quorum_ok` is false with reason `quorum-deferred` until `depot` obtains a `Resolution` for the same generation at the next online refresh (`courier` triggers it through `install("tuf:…")`, or `depot verify --online`).

### 4.9 Capability diff and consent

The **capability set** of a manifest is the tuple
`(tier, needs.jit, needs.gpu, needs.realtime, needs.csi, needs.network[], needs.listen[], needs.devices[], needs.services[], needs.secrets[], needs.spawn[], needs.portalIsland, effects[], provides.services[], provides.agentTools[], webapp.origin)`,
canonicalised as JCS with every array sorted. Its digest is `sha256:` of the JCS bytes (`consent.capabilities`).

| Field | Widening if |
|---|---|
| `tier` | `B.tier` is less isolated than `A.tier` in the order `2` > `"L"` > `1` > `0` |
| `needs.jit` | false → true |
| `needs.gpu` | `none` < `display` < `render` < `passthrough` increases |
| `needs.realtime` | false → true |
| `needs.csi` | absent → present, or `driver` changes |
| `webapp.origin` | any change (a different origin is a different app) |
| `needs.network[]` | any `(host, port, proto, method)` in B not covered by A (`*.example.com` covers subdomains; `*` covers all) |
| `needs.listen[]` | any new `(port, proto)`, or scope widened `loopback` < `lan` < `any` |
| `needs.devices[]`, `needs.services[]`, `needs.secrets[]`, `needs.spawn[]` | any new element |
| `needs.portalIsland` | false → true (shown, never widening authority, but listed as `~`) |
| `effects[]` | any new kind, or class lowered for an existing kind |
| `provides.services[]`, `provides.agentTools[]` | any new element |

The diff is rendered one line per change, prefixed `+` (widening), `-` (narrowing), `~` (neutral):

```
+ network: api.analytics.example.com:443/tcp GET,POST  (why: "Usage analytics")
+ jit: true
- services: portal-camera
~ portal island: on
```

**Approval request.** For a widening diff, `depot` calls `BrokerSystem.requestFor` on its `broker#system` route with `subject` = depot's own session (the only subject `depot` may name, protocols §7.5.2), `intent` = empty, `idempotencyKey` = `depot.consent:<gen hex>:<capability digest hex>`, and:

```
GrantRequest {
  resource = ResourceRef.spawn(<generation ref>),
  rights   = [spawn],
  reason   = JCS {"kind":"depot.consent","generation":…,"name":…,"publisher":…,
                  "diff":"<rendered diff>","requestedBy":"<installing principal>","tier":"t2"|"t3"},
  durationSecs = 0, persist = false }
```

The default `keylos` policy annotates `spawn` requests from `service:depot` with `@tier("t2")`, and `@tier("t3")` when the reason's `tier` is `t3`. The approval is rendered on the trusted path to the installing principal's human (on family machines with `requester` set, protocols §14). When `GrantResult.outcome` is `pending`, `depot` returns `kl:needs-approval:<a-…>` and keeps the `Approval` capability; a repeated call with the same idempotency key (for example after a `depotd` restart) returns the same approval. When the approval resolves to `granted`, `depot` takes the mandate from `GrantResult.mandate` (or `Approval.mandate`), verifies it is signed by owner-presence (owner registry from `HearthSystem.owners` on `hearth#system`) or by `service/broker` (public key from `Ledger.serviceKey("broker")` on `ledger#reader`, cached per boot; protocols §14.4), finds the `approval.decide` receipt carrying its `mandateDigest`, and writes the consent record:

```json
{"schema":"keylos.consent/1","generation":"gen:fsv256:…","name":"org.example.Editor",
 "capabilities":"sha256:…","approval":"a-…","mandate":"rcpt:sha256:<approval.decide receipt>",
 "scope":"machine","decidedBy":"alice","time":"…"}
```

signed by `service/depot` (protocols §20.8), stored in `/store/consent/` and linked from the generation's evidence. Consent covers every later generation of the same `name` and publisher whose capability set is a subset (`consent_covers`). A capability set is a subset when every field of B is narrower or equal per the table above.

Generations whose manifest declares no authority (empty `needs`, no `effects`, no `provides.services`, `tier` ≥ 1) need no consent. Kinds `os`, `config`, `policy`, `part` never need consent.

Consent alone never makes code launchable: launchability also requires an authorising signature (§4.6). Consent only records which authority the broker may grant at install time.

**Owner-sealed generations** carry implicit consent: the presence-signed seal window shows the capability sets; `depot` writes a consent record with `approval` = the seal window ID and `mandate` = the `seal.window` receipt.

### 4.10 Database

`depot` uses **redb** (pure-Rust embedded ACID store). The database is a cache: deleting `depot.redb` MUST be recoverable by rescanning `/store/evidence`, `/store/gens` and `/store/consent` (`depot verify --rebuild-db`, also run automatically when redb fails to open).

| Table | Key | Value |
|---|---|---|
| `gens` | gen digest (32 B) | `GenRecord { kind, name, version, manifest_digest, installed, image_size, closure_len, closure_bytes, grafted, origin, source }` |
| `by_name` | `(kind, name, version)` | gen digest |
| `closure` | `(gen, obj)` | `()` |
| `objref` | obj digest | `(refcount u32, size u64)` |
| `roots` | `(gen, holder)` | `RootRecord { created, by_principal }` |
| `launch` | gen digest | `LaunchState { launchable, reasons[], computed_boot_id }` |
| `consent_idx` | `(name, publisher)` | list of consent envelope digests |
| `mounts` | mount ID (u64) | `MountRecord { gen, caller, session, created }` |
| `stats` | `"objects"`, `"bytes"`, `"gens"` | counters |

**Reason codes** (`GenerationInfo.launchReasons`, `verify().problems`):

| Code | Defined by | Meaning |
|---|---|---|
| `no-authorising-signature` | protocols §7.3.8 | No statement, or no signature by a key authorised for the origin and kind; problem detail `bad-signature`, `no-statement` or `statement-from-future` |
| `revoked:<reason>` | protocols §7.3.8 | Generation listed `unlaunchable` (`<reason>` from the list), `revoked:object` (closure object listed), `revoked:key-compromised` (§4.7) |
| `needs-consent` | protocols §7.3.8 | Capability widening not yet approved |
| `quorum-deferred` | protocols §7.3.8 | Bundle install awaiting an online `Resolution` |
| `unreviewed-tier2` | protocols §7.3.8 | Third-party generation without `reviewed-reproducible` catalog status and without an exception; VM-only |
| `offline-install-needs-t3` | protocols §7.3.8 | §4.22 approval pending |
| `kernel-mismatch` | protocols §7.3.8 | `kmod` built for another kernel release |
| `kind-not-launchable` | depot | `part`, `config`, `policy` |
| `missing-image`, `missing-object` | depot | Store content absent or quarantined |
| `statement-mismatch` | depot | Statement fields differ from the image |
| `key-pending-reboot` | depot | Signed by a configured key that enters the trust set at the next boot |
| `no-seal` | depot | Owner-sealed origin without a valid seal statement or window digest |
| `no-quorum` | depot | Channel generation without the required realisation quorum |
| `feature-level` | depot | `requiresFeatureLevel` above the running level |
| `runtime-not-launchable` | depot | The named runtime generation is not launchable |

### 4.11 Owner seal

Seals are produced on user machines by `forge` (facet `forge`) inside a sealing window opened by `forge` through `HearthSeal.openWindow` (protocols §7.5.3, §20.4).

```
forge ─importTree(tree, manifest)──────────────────────────────► depotd  → G (launchable=false)
forge ─HearthSeal.openWindow(window: project, drvs)─► hearth     → windowId, presenceEnvelope (touch on trusted path)
forge ─HearthSeal.sealSign(windowId, keylos.seal/1 JSON)─► hearth → signature, keyRef (owner-seal/<i>)
forge ─seal(G, DSSE(keylos.seal/1, sig))──────────────────────► depotd
  0. kind(G) ∉ {kmod, container} else kl:denied
  1. verify the DSSE: payloadType seal, JCS, one signature by an owner-seal key in trust.keys.ownerSeal
     (or a configured owner-seal key not yet in the trust set → accepted, reason key-pending-reboot)
  2. statement.generation = G; statement.machine = this machine key; |statement.sealedAt − trusted now| ≤ 600 s;
     statement.drv = manifest(G).derivation; statement.window and windowDigest present
  2a. W := Ledger.query({eventTypes:["seal.window"], …}) on ledger#reader, select the receipt whose data.window =
      statement.window; none → kl:conflict (retry); W.data.windowDigest ≠ statement.windowDigest → kl:integrity;
      store rcpt ref of W as evidence seal-window.rcpt
  3. build genstmt(G) = {schema genstmt, generation, kind, name, version, manifestDigest, drv, stream:"owner",
                         objects, issued: statement.sealedAt}
  4. HearthSeal.sealSign(statement.window, JCS(genstmt))  → signature by the same owner-seal key
  5. write evidence: seal.dsse, statement.dsse; consent record (implicit, §4.9)
  6. recompute launchability
  7. Ledger.append(gen.seal {generation, drv, window, keyRef, objects})
```

`depot` relies on `hearth` refusing `sealSign` for statements whose `drv` is not in the window's `drvs` (both for `keylos.seal/1` and `keylos.genstmt/1` payloads) or whose time lies outside the window (protocols §7.5.3, §11.6 (a)). The window may have been opened by `forge` while `depot` signs the generation statement in step 4: any `hearth#seal` holder may sign within an open window. The `seal.window` receipt check (step 2a) binds the seal statement to the presence-signed window that `depot` never sees; at later recomputations `depot` re-reads the stored receipt by its ref (`Ledger.get`) and treats a missing or mismatching receipt as reason `no-seal`.

An owner-sealed generation is launchable without reboot as long as the owner-seal key is in the current boot trust set, which is the case for every owner enrolled before the current boot.

### 4.12 `.klb` offline bundle

A `.klb` file is an uncompressed POSIX tar of an **OCI image layout** plus keylos evidence:

```
oci-layout                         {"imageLayoutVersion":"1.0.0"}
index.json                         one manifest per generation (annotation org.keylos.generation) and every referrer manifest
blobs/sha256/<hex>                 manifests, configs, EROFS images, objects packs, referrer artifacts
keylos/bundle.json                 {"schema":"keylos.bundle/1","created":…,"generations":[{"ref","source","stream"|"publisher"}],"revocations":[<stream>…]}
keylos/revocations/<stream>.dsse   newest revocation list known to the bundler (keylos.revocations/1)
```

Rules:
- Tar entries MUST be in the order above, regular files only, relative paths without `..`, each ≤ 8 GiB.
- `depot` streams the tar from the fd it was given (it never extracts to a path); every blob is verified by SHA-256 while streaming; manifests are parsed in `depot-parse`.
- Referrers MUST be included as manifests listed in `index.json` with a `subject` field.
- `depot bundle export --against <ref…>` writes objects packs containing only objects missing from the given generations' closures.
- Bundled revocation lists are applied when their serial is higher than the current one and their signature verifies (REQ-DEPOT-064).
- `keylos.bundle/1` is depot-local: only `depot` writes and reads it.

### 4.13 Install state machine

```
            ┌─────────────┐  resolve/parse ok   ┌──────────┐  image + statement ok   ┌────────────┐
 request ──►│  resolving  │───────────────────►│ fetching │───────────────────────►│ verifying  │
            └─────┬───────┘                     └────┬─────┘                         └─────┬──────┘
                  │ error                            │ error                               │ error
                  ▼                                  ▼                                     ▼
            ┌───────────┐ ◄──────────────────────────┴─────────────────────────────────────┘
            │  failed   │   journal cleaned; verified objects kept as garbage
            └───────────┘
 verifying ─ok─► ┌───────────┐ diff narrowing/equal ─► ┌───────────┐ ─receipt─► done (launchable per §4.6)
                 │ consent?  │                         │ committed │
                 └────┬──────┘                         └───────────┘
                      │ widening
                      ▼
                 ┌───────────────┐ granted ─► consent record ─► committed
                 │ awaiting-     │ denied/expired ─► committed (non-launchable, reason no-consent)
                 │ approval      │
                 └───────────────┘
```

**Network install sequence (`tuf:` source, including `tuf:publisher/…` and `tuf:org:<org>/…`):**

```
caller ─install("tuf:stable/org.example.Editor")─► depotd (facet user)
 1. journal: op = install, source
 2. R := CourierResolver.resolve(source)           # courier: TUF lookup, quorum and log verification
 3. M := GET OCI manifest R.oci via gate; sha256(M) = pinned digest
 4. I := GET layer 0; fsv256(I) = R.expectedGen
 5. S := R.statement; verify against trust set (§4.7); statement fields match I and M's config
 6. parse I (depot-parse) → manifest, tree entries, closure; validate manifest (protocols §6.3)
 7. attestations(R) name G and manifest.derivation (§4.8)
 8. missing := closure − present; partial pull of objects pack; object write path for each (§4.15)
 9. write I to gens/ (verity), evidence/ (manifest, statement, resolution, provenance, source)
 9a. third-party publisher generation: C := CourierResolver.resolve("tuf:catalog/<name>@<version>") → catalog.json (§4.21)
 9b. offline rule (§4.22): revocation age > 30 d and first install of (name, publisher) → requestFor T3
10. diff := capability_diff(installed(name), manifest)  ; widening → broker approval (§4.9)
11. recompute launch(G); root(G, "user:<human>:installed" or caller-supplied holder)
12. Ledger.append(gen.install)
13. return (info, rendered diff)
```

`oci://…#gen=` sources skip step 2; the statement comes from the referrer artifact (`application/vnd.keylos.genstmt.v1+dsse`); the quorum comes from `Resolution` only when `courier` is the caller (it calls `resolve` itself and then `install` with the pinned `oci://` form; `depot` asks `CourierResolver.resolve("tuf:…")` for the same generation to obtain the attestations when `source.json` names a channel). An `oci://` install of a reproducible channel generation without a resolvable channel stays `no-quorum`.

### 4.14 Revocation hand-off

`courier` fetches revocation lists (protocols §11.7) and hands them to `depot` by calling `install("tuf:<stream>/revocations")` (or `install("tuf:org:<org>/revocations")` for an enrolled org) on facet `courier`. `depot` then calls `CourierResolver.resolve` with the same source and reads the DSSE revocation list from **`Resolution.revocations`** (protocols §7.5.6; all other `Resolution` fields are empty for this source). `depot`:

1. verifies the signature with `trust.keys.releaseStream` (org lists: an org-publisher key of that org) and `serial` > current (REQ-DEPOT-064);
2. writes `/store/revocations/<stream>.dsse` (org lists: `org:<org>.dsse`; new file, `renameat2`), the path `boot` and `warden` read (protocols §10.7);
3. recomputes launchability for every generation;
4. writes a `gen.revoke` receipt for each generation that became non-launchable (`data: {generation, reason, serial}`); `warden` follows `gen.revoke` receipts through `Ledger.watch` and stops or freezes running instances per policy;
5. marks `evict` objects in the database; the next `gc` deletes them even when rooted, which makes every generation containing them `revoked-object`;
6. returns a `GenerationInfo` with an empty ref, `kind = "revocations"`, `version = <serial>`, `launchable = false`, and `capabilityDiff` = a rendered summary (`- unlaunchable: org.example.Tool 1.2.0 (CVE-…)`).

`revocations()` returns the effective list for the first subscribed stream (`store.streams[0]`); `depot revocations --stream S` reads others.

### 4.15 Object write path and crash consistency

```
write(source bytes or fd, expected digest d or none):
  1. tmp := /store/incoming/<op>/<random>           (O_TMPFILE when supported, else a named temp)
  2. copy bytes (copy_file_range / FICLONE when the source is on the same btrfs)
  3. fsync(tmp)
  4. d' := fsverity_digest_userspace(tmp)           (keylos-ids: SHA-256, block 4096, no salt)
  5. if d given and d' ≠ d: abort kl:integrity
  6. if /store/objects/<d'> exists: unlink tmp; return d'      (dedup)
  7. reopen tmp O_RDONLY; FS_IOC_ENABLE_VERITY {hash=SHA256, block=4096, salt=none, sig=none}
  8. FS_IOC_MEASURE_VERITY = d' else abort kl:integrity
  9. fchmod 0444; link into /store/objects/<aa>/<rest> (linkat AT_EMPTY_PATH for O_TMPFILE, else renameat2 RENAME_NOREPLACE)
 10. fsync(/store/objects/<aa>)
```

**Operation journal.** Every mutating operation writes `/store/journal/<op>.json` (`{"op","kind","source","started","state"}`) before its first side effect and deletes it after its receipt is appended. On start, `depotd` replays the journal:

| Journal state | Recovery |
|---|---|
| `fetching`, `verifying` | Delete `incoming/<op>`; objects already in `objects/` stay (they verified) and become garbage unless referenced |
| `committed` without receipt | Re-append the receipt (receipts are idempotent by `data.op`) |
| `sealing` | Re-run steps 3–7 of §4.11 if the window is still open; otherwise leave the generation unsealed and report |

Images are written by the same path into `gens/`. Evidence files are written to a temp name and `renameat2`'d into place; `statement.dsse` is replaced (new file + rename) when new signatures are added, never edited in place.

### 4.16 Mount sequence

```
warden ─mount(G)─► depotd (facet mounter)
  1. caller warden: require launch(G) reasons ⊆ {unreviewed-tier2} (computed this boot); else kl:<reason code>
       kind container: additionally require a root holder cri:pod:<pod-id> on G (cri roots the generation for
         the pod before warden's PodSpawn mounts it; no such root → kl:denied)
       kind kmod: additionally require manifest.kmod.kernel = uname -r (else kl:unsupported kernel-mismatch)
     caller bench/compat: require image(G) present and closure present
  2. e := erofs mount of /store/gens/<G>.erofs (fsopen "erofs", source=file, ro), shared per G inside
     depot's private mount namespace at /run/depot/erofs/<G>, reference-counted
  3. fsfd := fsopen("overlay", FSOPEN_CLOEXEC)
     fsconfig(fsfd, SET_STRING, "lowerdir+", "/run/depot/erofs/<G>")
     fsconfig(fsfd, SET_STRING, "datadir+",  "/store/objects")
     fsconfig(fsfd, SET_STRING, "metacopy", "on"); "redirect_dir" "on"; "verity" "require"
     fsconfig(fsfd, CMD_CREATE)
  4. mfd := fsmount(fsfd, FSMOUNT_CLOEXEC, MOUNT_ATTR_RDONLY|MOUNT_ATTR_NOSUID|MOUNT_ATTR_NODEV)
  5. record MountRecord; return mfd via SCM_RIGHTS
```

Every call creates a new overlay superblock (REQ-DEPOT-052). The EROFS mount is unmounted 60 s after the last overlay over it is released; `depot` learns releases from `warden:running:*` root removals and from `PrincipalControl`-driven `unroot` calls by `warden`, `bench` and `compat`.

### 4.17 Garbage collection

```
gc(dryRun):
  take mutation lock exclusively
  live := ∅
  for (g, holder) in roots: mark(g)        # mark(g): live += g; mark(runtime(g)); for parts named in
                                           # the manifest's x-forge.parts (informational) nothing is followed
                                           # roots include warden:running:<session> (mounted generations),
                                           # cri:image:<digest> and cri:pod:<pod-id> (container generations)
  for g in gens: if g ∉ live and age(g) > unrootedGrace: remove image, evidence, db rows
  for o in objects: if refcount(o) = 0 and age(o) > 1 h: remove
  for o in evict list: remove (even if referenced); mark referencing gens revoked-object
  write gen.gc receipt {removedGenerations, removedObjects, freedBytes, evicted}
```

Retention (config `store.retention`) adds automatic roots: the newest `osGenerations` OS generations booted, the newest `configGenerations` config generations, and every generation mounted during the last `recentlyUsedDays` days.

### 4.18 Owner exceptions

Owner exceptions (`keylos.exception/1`, protocols §20.9) are created by `config` with a presence signature (purpose `exception`) and shipped in the config generation as `/etc/keylos/exceptions/<name>.dsse` (protocols §10.7). On start and on `ServiceHost.reload`, `depot`:

1. verifies each envelope: JCS payload, presence signature (protocols §5.3) by a credential in `trust.keys.ownerPresence`, `kind = "reproducibility"` (envelopes of kind `fleet-receipt-access` are skipped silently: they are `ledger`'s), `expires` null or in the future;
2. copies verified envelopes to `/store/evidence/exceptions/<SHA-256 of the envelope>.dsse` (write-once);
3. ignores (and logs) envelopes that fail verification.

An exception **matches** a generation G when `exception.name = manifest(G).name`, `exception.publisher` equals the key ref of G's verifying authorising signature, and `exception.generation` is null or equals G. A matching `reproducibility` exception clears both the `reproducible: false` tier floor (applied by `warden`) and the `unreviewed-tier2` reason (§4.21).

`warden` reads the exceptions it needs for effective-tier computation from `/etc/keylos/exceptions/` itself; `depot`'s copies are the long-term evidence that survives config rollbacks, and `depot show` lists the exception that applies to a generation.

### 4.19 Container conversion (`oci-convert/1`)

`install("oci+container://<registry>/<repository>@sha256:<digest>")` (facet `cri`) runs the conversion below. The algorithm is versioned `oci-convert/1`; any change to it is a new version and changes generation digests. `forge container convert` (publisher side) MUST implement exactly this algorithm through the same crate, so that an org publisher can sign the generation statement for the digest every node will compute.

**Inputs.** Source reference `R = <registry>/<repository>`, source digest `D` (`sha256:<hex>`), node platform `P` = `linux/amd64` on x86-64 or `linux/arm64` on aarch64.

```
convert(R, D, P):
 1. M0 := GET /v2/<repository>/manifests/<D> via gate; require sha256(M0) = D
    if M0 is an image index (application/vnd.oci.image.index.v1+json or Docker manifest list):
        pick the entry with platform.os = "linux", architecture = P.arch (arm64: variant absent or "v8");
        none → kl:unsupported (REQ-DEPOT-083); several → the first in index order
        M := GET manifest by that entry's digest; require its sha256
    else M := M0
 2. C := GET config blob; require sha256; require C.os = "linux" and C.architecture = P.arch
 3. for i, layer in M.layers (≤ 128):
        B := GET blob; require sha256(B) = layer.digest
        U := decompress by media type: tar (none), tar+gzip, tar+zstd; anything else → kl:unsupported
        require sha256(U) = C.rootfs.diff_ids[i]
        apply(U) to the tree model T (below), streaming file bytes into the object write path (§4.15)
 4. reject if T contains /.keylos (any entry) → kl:invalid
 5. synthesize /.keylos/manifest.json (below) as a regular file, mode 0444, uid 0, gid 0
 6. image := composefs(T) with the container exceptions (below); G := fsv256(image)
 7. write image to gens/, evidence/<G>/ {manifest.json, conversion.json, source.json}
 8. root(G, "cri:image:<D hex>")
 9. for each org O with scope org:O in /etc/keylos/publishers.json (sorted by org id):
        Res := CourierResolver.resolve("tuf:org:<O>/<name>@<version>")
        if Res.statement verifies (REQ-DEPOT-020.9) and its generation = G: store as statement.dsse; break
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

**composefs with container exceptions.** As §4.3, except: ownership is the recorded uid/gid; directory modes keep `0o1777` bits and file modes `0o777` bits; files and directories need not be `0444`/`0555`. Timestamps are zero and entries are sorted exactly as §4.3.

**Limits.** ≤ 128 layers, ≤ 32 GiB uncompressed in total, ≤ 2 000 000 entries, compressed blob ≤ 8 GiB; exceeding any limit fails with `kl:invalid`. Tar and JSON parsing runs in `depot-parse` (§6.3).

**`conversion.json`** (depot-local evidence, not signed): `{"converter":"oci-convert/1","source":"oci+container://…","indexDigest":"sha256:…"|null,"platformManifest":"sha256:…","config":"sha256:…","layers":[…],"dropped":[{"path","type"}],"stripped":[{"path","bits"}],"xattrsDropped":[{"path","name"}],"generation":"gen:fsv256:…","descriptor":"drv:sha256:…"}`. The descriptor bytes are stored next to it as `evidence/<G>/ociconv.json`.

### 4.20 Kernel-module generations

`kmod` generations (protocols §6.1) are built by `forge` from project recipes and published on a distribution stream like any other generation; `courier` installs them (`tuf:<stream>/<name>`), for example `io.keylos.kmod.nvidia-open` for the running kernel.

| Step | Rule |
|---|---|
| Install | Path allowlist (REQ-DEPOT-085); every `.ko` has a module-signature trailer (REQ-DEPOT-086); `manifest.kmod.modules[]` each names exactly one `<module>.ko` present in the tree; `kmod.firmware[]` paths exist under `/lib/firmware/` |
| Authorisation | Generation statement by `release-stream/<stream>` only (REQ-DEPOT-087) |
| Launchability | Additionally `kmod.kernel = uname -r`; otherwise `kernel-mismatch` (the generation stays stored so that a kernel rollback finds it) |
| Mount | Facet `mounter`, caller `warden` (module path only) and `boot` via `depot-mount-helper`; never `bench` or `compat` |
| GC | Rooted by `courier` (`courier:kmod:<kernel>`) for each kernel release kept bootable; unrooted when that kernel release leaves the retained OS generations |

`depot` never loads modules; `warden` registers the mount with `kl-exec` and the kernel verifies each module signature at `finit_module` (protocols §9.3).

### 4.21 Catalog review status

Third-party publisher generations (origin `publisher/<id>` with scope `distro`, kinds `app`, `runtime`, `agent-template`, `data`) have a **review status** from the catalog (protocols §11.8, §20.20). The catalog is a TUF target, so only `courier` reads it.

```
review(G):
  Res := CourierResolver.resolve("tuf:catalog/<manifest(G).name>@<manifest(G).version>")
                                                      # only Res.review and Res.catalogEntry are set (protocols §7.5.6)
  if Res.review = "": return "unreviewed"             # not a catalog app
  E := JCS-parse(Res.catalogEntry)                    # the keylos.catalog/1 entry (§20.20), authenticated by courier
                                                      # through the TUF catalog role
  require E.name = name(G); E.latest.generation = G or the entry's version history names G
  require E.review = Res.review
  return Res.review                                   # "reviewed-reproducible" | "unreviewed"
```

- `depot` stores `{entry, review, resolvedAt}` as `evidence/<G>/catalog.json` at install, and refreshes it on `verify --online` and whenever `courier` installs a newer generation of the same name.
- No entry, `courier` unavailable, or a malformed entry: the status is `unreviewed` until a later refresh succeeds.
- `unreviewed` (and no matching `reproducibility` exception, §4.18) adds reason `unreviewed-tier2`: the generation is VM-only. `warden` reads `launchReasons` and applies the effective tier floor 2.
- Distribution-stream, org-publisher, owner-sealed and `container` generations have no review status and never get `unreviewed-tier2`.

### 4.22 Offline install rule

```
revocation_age := trusted_now − max(issued of the current revocation list of each subscribed stream)
trusted_now    := max(CLOCK_REALTIME, LedgerAdmin.timeFloor() on ledger#time)   # protocols §3.6

on install of G with origin ∈ {publisher, org-publisher, container}:
  if revocation_age > 30 days and no generation of (name(G), publisher(G)) was ever installed here:
      r := BrokerSystem.requestFor(self session,
              GrantRequest{resource = spawn(G), rights = [spawn],
                           reason = JCS {"kind":"depot.offline-install","generation":…,"name":…,
                                         "publisher":…,"revocationAgeDays":n,"tier":"t3"}},
              intent = "", idempotencyKey = "depot.offline:<G hex>")
      write evidence offline.json {revocationAgeDays, approval: a-…, state}
      G gets reason offline-install-needs-t3 until r resolves to granted
```

- The default policy annotates `depot.offline-install` requests with `@tier("t3")`. A denial leaves the generation stored with the reason; `depot uninstall` removes it.
- Distribution-stream generations and owner-sealed generations are exempt; `forge` and `compat` imports are not third-party installs.
- When revocation age returns below 30 days, pending requirements stay until resolved (REQ-DEPOT-037). The newest revocation list's age is shown by `depot revocations` and in `status`.
- `compat` applies the companion rule for imported legacy images (effective tier ≥ 2) itself; `depot` reports the revocation age to it, to `gate` and to every `depot#user`/`mounter` holder through **`Depot.revocationStatus`** (protocols §7.3.8): `serial` and `issued` of the newest verified list over all subscribed streams, and `ageSecs` = `trusted_now − issued`. There is no revocation pseudo-generation.

---

## 5. Interfaces

### 5.1 `Depot` method semantics

| Method | Facets | Semantics |
|---|---|---|
| `get(ref)` | all | `GenerationInfo` for one generation, with `launchReasons` (REQ-DEPOT-024); `kl:not-found` |
| `list(kind, name)` | user, courier, cri, admin | Filter by kind and name (empty = any); facet `cri` sees only kind `container` |
| `install(source)` | user, courier, cri, admin | §4.13, §4.14, §4.19; source forms per REQ-DEPOT-030 (`oci+container://` on `cri` only); may throw `kl:needs-approval:<a-…>` after storing |
| `mount(ref)` | mounter, config | §4.16, REQ-DEPOT-051 |
| `openObject(ref)` | user, admin | Read-only fd of a store object, only if the object is in the closure of a generation the caller may spawn (`right("spawn", gen, "spawn")` in one of the caller's tokens, or a generation rooted under `user:<caller human>:*`) |
| `openPath(ref, path)` | user (`/.keylos/…` allowlist), mounter (any path) | REQ-DEPOT-090..092; used by `atrium` for `l10n` and icons, `aide` for agent template files, `kish` for `cmdsig` |
| `importTree(tree, manifest)` | forge, config, compat | REQ-DEPOT-040; `tree` is an O_PATH dirfd opened by the caller; `depot` walks it with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS)` |
| `seal(ref, statement)` | forge | §4.11 |
| `root(ref, holder)`, `unroot(ref, holder)` | mounter, courier, cri (`cri:` namespace), admin; user (own `user:` namespace) | REQ-DEPOT-060, REQ-DEPOT-065 |
| `gc(dryRun)` | admin | §4.17 |
| `verify(ref)` | user, admin | Recompute launchability for `ref`; `problems` = reason codes plus `deep:` findings when the CLI asked for a deep check (re-measure every object) |
| `revocations()` | user, courier, admin | Effective revocation list DSSE (§4.14) |
| `revocationStatus()` | user, mounter, compat | Newest verified list `serial`, `issued`, `ageSecs` against trusted time (REQ-DEPOT-093) |

### 5.2 CLI `depot`

The CLI talks to `depotd` through the socket listed in `KEYLOS_CAPWIRE_FDS` (`depot` or `depot#<facet>`). Global flags: `--json`, `--quiet`. Exit codes: `0` ok, `1` negative result, `2` usage, `3` denied, `4` needs approval (prints the approval ID), `5` integrity failure, `6` unavailable, `7` not found.

| Command | Description |
|---|---|
| `depot list [--kind K] [--name N] [--launchable]` | List generations |
| `depot show <ref\|name[@version]>` | Manifest, signatures, seal, quorum, consent, catalog review, offline approval, roots, `launchReasons` |
| `depot cat <ref> <path>` | Print a `/.keylos/…` file of a generation through `openPath` |
| `depot catalog <name>[@version]` | Show the stored catalog entry and review status; `--refresh` asks `courier` again |
| `depot containers` | List `container` generations with their source image, org signer and `cri:` roots (facet admin) |
| `depot kmods` | List `kmod` generations with their kernel release and whether it matches the running kernel |
| `depot install <source> [--root HOLDER]` | Install from `tuf:…` or `oci://…` |
| `depot install --bundle FILE` | Install from a `.klb`; the file is opened through the powerbox |
| `depot uninstall <name\|ref>` | Remove the caller's `user:<human>:installed` root |
| `depot diff <refA> <refB>` | Capability diff and file-level diff (paths added, removed, changed) |
| `depot verify [<ref>…] [--all] [--deep] [--online] [--rebuild-db]` | Recompute launchability; `--deep` re-measures objects; `--online` asks courier for deferred quorums |
| `depot gc [--dry-run]` | Run GC (facet admin) |
| `depot roots [<ref>]` | Show roots |
| `depot du [<ref>…]` | Dedup accounting: unique, shared and closure bytes |
| `depot revocations [--stream S]` | Show the effective revocation list |
| `depot exceptions` | List owner exceptions |
| `depot bundle export <ref…> -o FILE [--against REF…]` | Write a `.klb` |
| `depot bundle inspect FILE` | Verify a bundle without installing |
| `depot object <obj-ref> [-o FILE]` | Copy an object out through `openObject` |

### 5.3 Files, sockets, library

- capwire socket directory `/run/keylos/svc/depot/` (managed by `warden`).
- Private mount namespace of `depotd` for EROFS mounts under `/run/depot/erofs/`.
- `depot-mount-helper`: a Rust `cdylib` and binary with one entry point for `boot`:
  `int kl_depot_mount_gen(int store_dirfd, const uint8_t digest[32], int *out_mfd)` → `0` or `-errno`. It enables nothing, writes nothing, verifies the image's measured fs-verity digest equals `digest`, mounts EROFS and the overlay exactly as §4.16 steps 2–4, and returns the fsmount fd. Statement verification and `kl-exec` registration are `boot`'s responsibility.

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| Network attacker serves malicious bytes | Digest pinning by `courier` (TUF) or by `#gen=`; OCI digest; fs-verity digests; DSSE generation statements against the boot trust set |
| Compromised mirror freezes or rolls back metadata | TUF freshness in `courier`; `depot` never consumes unsigned metadata |
| Single compromised builder | Realisation quorum of distinct operators (verified by `courier`), owner-required rebuilders (verified by `depot`) |
| Targeted (split-view) release | Witness-cosigned checkpoints verified by `courier`; `vouch` personal witness |
| Compromised `depotd` writes a malicious object | Objects are named by digest; composefs `verity=require` checks every open against the digest in the signed image; a forged image cannot be registered in `kl-exec` because `warden` verifies the statement itself |
| Compromised `depotd` forges launchability | `warden` re-verifies statements before `kl-exec` registration (protocols §9.3); `depot` recomputes from evidence at each start |
| Compromised `depotd` reuses an overlay superblock for a different image | New superblock per mount (REQ-DEPOT-052); `warden` registers superblocks only for mounts it received for a verified generation |
| Malicious bundle (path traversal, bombs) | Streaming parse in `depot-parse`, entry allowlist, sizes checked against OCI config `objectBytes` (±1 %) and TOC sizes |
| Capability creep on update | Capability diff + consent through `broker` |
| Revoked vulnerable library still present | `evict` objects; every generation containing them becomes non-launchable |
| Owner-seal abuse by malware | Seals need a presence-authorised window (`hearth`); `depot` cannot sign seals itself; the window digest is checked against hearth's receipt (REQ-DEPOT-043) |
| Malicious container image (path tricks, setuid, file capabilities, device nodes) | Conversion in `depot-parse` with path normalisation; setuid/setgid stripped, devices dropped, `security.*` xattrs dropped (§4.19); only org-signed conversions are launchable on the host; unsealed images never reach the host (`keylos-vm` images stay in `cri`'s store) |
| Container image swap after signing | Conversion is deterministic from the pinned manifest digest; the org statement names the generation digest, so any byte difference yields a different, unsigned generation |
| Out-of-tree module from an untrusted source | `kmod` accepted only with a release-stream statement; kernel enforces module signatures; owner seals refused for `kmod` |
| Unreviewed third-party app gets host access | Catalog review status from `courier`; `unreviewed-tier2` makes it VM-only unless an owner exception |
| Long offline period hides revocations | Offline install rule (§4.22): new third-party installs need T3 when revocation age > 30 days; statements issued in the future are refused |
| Publisher key compromise | `keys[]` revocation semantics of §4.7 (quorum-backed generations stay usable, others are revoked) |

### 6.2 Self-confinement

| Aspect | Setting |
|---|---|
| Tier | t0, dynamic UID reserved by `warden` for `depot` (stable across boots) |
| Privileges | `CAP_SYS_ADMIN` and `CAP_FOWNER` in the user-less private mount namespace `warden` creates for it (fsopen/fsmount, EROFS mounts, enabling verity on its own files) |
| Landlock | rw: `/store`; ro: `/run/keylos/boot/trust.json`, `/etc/keylos/publishers.json`, `/etc/keylos/owner-seal/`, `/etc/keylos/exceptions/`, `/etc/keylos/depot.json`; nothing else |
| seccomp beyond baseline | `fsopen`, `fsconfig`, `fsmount`, `mount` (erofs only, inside its namespace), `umount2`, `ioctl` (`FS_IOC_ENABLE_VERITY`, `FS_IOC_MEASURE_VERITY`, `FS_IOC_READ_VERITY_METADATA`, `FICLONE`, `FICLONERANGE`), `copy_file_range`, `linkat` |
| Network | none; `gate` sockets only |
| Routes held | `ledger#writer`, `ledger#reader`, `ledger#time` (`timeFloor`), `broker#system` (`requestFor` for its own session only), `hearth#seal`, `hearth#system` (`owners` only), `courier#depot`, `gate#client`, `journal#client` |
| TPM | none |

### 6.3 Parsing hardening

EROFS reading, tar streaming, zstd:chunked TOC parsing, OCI JSON, DSSE parsing and manifest validation run in **`depot-parse`**: a subprocess with no capabilities, an empty Landlock ruleset, a seccomp profile allowing only `read`/`write`/`close`/`mmap`/`munmap`/`exit_group` on passed fds, and a 512 MiB memory limit. It returns validated structures over a pipe as length-prefixed CBOR. A crash or timeout (30 s per item) fails the operation with `kl:invalid`.

### 6.4 Snapshots and backups

`/store` is excluded from `strata` periodic snapshots and from backups: it is content-addressed and reproducible from evidence and the network. Rollback is done with generations, not filesystem snapshots. Owner-sealed generations are the exception for backups: `depot bundle export` of all `owner` generations is offered to `strata` as a backup source.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| Power loss during write | Journal replay (§4.15); objects appear atomically |
| Object fails re-measurement (`verify --deep`) | Object moved to `/store/quarantine/`; dependent generations get `missing-object`; next install of any of them re-fetches it |
| Overlay read returns `EIO` | Logged by the kernel; `depot verify --deep` locates the object; same as above |
| db corruption | `depot verify --rebuild-db` (also automatic when redb fails to open) |
| Disk full | Install aborts before writing the image (`kl:unavailable disk full; need N bytes`); GC suggested |
| `courier` unavailable | `tuf:` installs and revocation hand-offs fail `kl:unavailable`; installed generations stay launchable |
| `ledger` unavailable | Mutating calls fail `kl:unavailable` (receipts are mandatory); `mount` and reads continue |
| `broker` unavailable | Installs store data but remain `no-consent` until approval |
| `hearth` unavailable during seal | `seal` fails `kl:unavailable`; the generation stays unsealed; rerun inside a new window |
| Trust set missing (`/run/keylos/boot/trust.json` absent) | Every generation `bad-signature` except via `bench`/`compat` mounts; `depot` logs critical |
| Revocation evicts an object of the booted OS | `depot` reports; `courier` stages a fixed release; the running OS keeps running until reboot (`boot` checks revocations serial) |
| Corrupt `.klb` | Install fails `kl:invalid`; nothing committed |
| Container conversion fails mid-way (blob 404, digest mismatch, limit) | `kl:integrity` / `kl:unavailable` / `kl:invalid`; verified objects stay as garbage; `cri` retries with backoff |
| No org statement for a converted container | Generation stored, `no-authorising-signature`; `cri` fails the container with `CreateContainerError` naming the reason |
| Kernel updated, `kmod` for the old release only | Old `kmod` gets `kernel-mismatch`; `courier` installs the matching `kmod` with the OS update; until then `warden` cannot register it and the driver is absent |
| Catalog unreachable | Review stays `unreviewed` (VM-only) until refreshed; already reviewed generations keep their stored status |
| Seal window receipt not yet visible | `seal` returns `kl:conflict`; `forge` retries within the window |
| Offline approval denied | Generation stays stored with `offline-install-needs-t3`; `depot uninstall` removes it |

---

## 8. Performance budgets

Reference machine: 8-core x86-64-v3, NVMe, 100 Mbit/s.

| Operation | Budget |
|---|---|
| Start-up launchability recomputation (500 generations, 400 000 objects) | ≤ 300 ms (evidence-only; signature checks cached per statement digest within one boot) |
| `mount`, EROFS already mounted | ≤ 5 ms p99 |
| `mount`, first use of a generation | ≤ 30 ms p99 |
| Object ingest | ≥ 400 MB/s digest + verity; ≤ 2 ms overhead per small object |
| `importTree` of a 5 000-file tree, all objects present | ≤ 400 ms |
| Install 500 MB app, 30 % already present | ≤ 45 s wall at 100 Mbit/s |
| Seal (excluding the human touch) | ≤ 200 ms per generation |
| Container conversion of a 1 GiB (uncompressed) image, nothing present | ≤ 20 s CPU on the reference machine plus transfer time; ≤ 5 s when all objects are present (layers re-read only for digests) |
| `openPath` | ≤ 2 ms p99 |
| GC over 400 000 objects | ≤ 10 s |
| Memory | ≤ 128 MiB RSS steady state; `depot-parse` ≤ 512 MiB |

---

## 9. Observability

### 9.1 Logs and metrics

- Structured log records (protocols §10.6) with fields `op`, `gen`, `obj`, `source`, `reason`, `caller`.
- Metrics records: `depot_objects_total`, `depot_bytes_total`, `depot_dedup_ratio`, `depot_install_seconds` (histogram), `depot_fetch_bytes_total`, `depot_mounts_active`, `depot_launchable_total{kind}`, `depot_nonlaunchable_total{reason}`, `depot_gc_freed_bytes_total`.

### 9.2 Receipts

| Event | `data` |
|---|---|
| `gen.install` | `{op, generation, kind, name, version, source, origin, capabilityDiff, consent, quorum, launchable, reasons}` |
| `gen.seal` | `{op, generation, drv, window, keyRef, objects}` |
| `gen.revoke` | `{generation, reason, serial, stream}` |
| `gen.gc` | `{removedGenerations, removedObjects, freedBytes, evicted}` |
| `x-depot.import` | `{op, generation, kind, name, facet}` (local `importTree`) |
| `x-depot.consent` | `{generation, name, approval, capabilities}` |
| `x-depot.revocations` | `{stream, serial, unlaunchable, evict}` |
| `x-depot.convert` | `{source, platform, generation, dropped, stripped, org}` (container conversion, before `gen.install`) |
| `x-depot.catalog` | `{generation, name, review}` (review status changed) |
| `x-depot.offline` | `{generation, revocationAgeDays, approval, outcome}` |

`gen.install` data additionally carries `kind`, `review` (third-party publisher generations), `offline` (approval ID or null) and, for `container`, `image` and `org`; for `kmod`, `kernel`.

---

## 10. Configuration

Config module `store` (Nickel), rendered to `/etc/keylos/depot.json`:

```nickel
{
  store | {
    streams | Array String | default = ["stable"],
    registryMirrors | Array String | default = [],          # OCI mirrors, digest-pinned so untrusted
    ownerRebuilders | Array { id | String, keys | Array String } | default = [],
    requireOperators | Array String | default = [],         # ids from ownerRebuilders that MUST have attested
    retention | {
      osGenerations | Number | default = 3,
      configGenerations | Number | default = 20,
      unrootedGraceHours | Number | default = 24,
      recentlyUsedDays | Number | default = 14,
    } | default = {},
    maxParallelFetches | Number | default = 8,
    parseMemoryMiB | Number | default = 512,
    container | {
      maxLayers | Number | default = 128,
      maxUncompressedGiB | Number | default = 32,
      maxEntries | Number | default = 2000000,
    } | default = {},                                       # limits may only be lowered below the §4.19 values
    catalogRefreshHours | Number | default = 24,           # refresh stored review status through courier
  }
}
```

Publisher keys are configured in the `publishers` module, which renders `/etc/keylos/publishers.json` for `boot`; `depot` reads it (protocols §10.7) to classify `key-pending-reboot`, to learn each key's scope (`distro` or `org:<org>`) and to enumerate enrolled orgs for container statements. The 30-day offline threshold and the 24 h future-statement bound are fixed by protocols §14.5 and are not configurable.

---

## 11. Testing and acceptance

### 11.1 Unit

- fs-verity digest computation vs the kernel (`FS_IOC_MEASURE_VERITY`) on 10 000 random files, including sizes 0, 1, 4095, 4096, 4097 and 1 GiB.
- composefs writer determinism and canonical ordering; zero-length inline files.
- Capability diff table tests for every field, wildcard host coverage, listen scopes.
- Launchability evaluation: every reason code reachable; revocation `after` semantics.
- Consent subset relation (property tests).

### 11.2 Integration (VM-based CI with a keylos kernel)

| # | Scenario | Expected |
|---|---|---|
| 1 | Install a release-stream-signed app from a local test registry via a test courier | launchable; `warden` mount; exec succeeds |
| 2 | Same image, statement signed by an unknown key | `bad-signature`; `mount` for warden refused |
| 3 | Overwrite one object byte bypassing depot (test hook) | overlay read `EIO`; `verify --deep` quarantines; generation `missing-object` |
| 4 | Unsigned `importTree` generation | `mount` refused for warden, allowed for bench |
| 5 | Widening update | `kl:needs-approval`; after approval launchable; consent file written |
| 6 | Revocation hand-off with `unlaunchable` for a running app | `gen.revoke` receipt within 1 s; `evict` object removed at GC though rooted |
| 7 | `.klb` install offline | stored; `quorum-deferred`; after online `verify --online` launchable |
| 8 | Seal inside window | launchable without reboot; seal and genstmt evidence present |
| 9 | Seal with a statement for a different generation | `kl:invalid` |
| 10 | Kill `depotd` at 30 random points during install, import, seal and GC | restart consistent; `verify --all` clean |
| 11 | Delete `depot.redb` | rebuild gives identical launch states |
| 12 | Two `mount(G)` calls | two distinct `s_dev` values |
| 13 | `install("oci+container://…")` on facet `cri` for a multi-arch index | platform entry selected; generation digest equals the vector produced by `forge container convert` for the same digest and platform |
| 14 | Same, without an org statement | stored; `launchReasons = ["no-authorising-signature"]`; `mount` for warden refused |
| 15 | Same, with an org statement served by a test courier | launchable; `mount` for warden succeeds only after `root(G, "cri:pod:<id>")` |
| 16 | Container image containing a setuid binary, a device node, a `security.capability` xattr and a `/.keylos` path | first three stripped/dropped and recorded in `conversion.json`; the `/.keylos` case fails `kl:invalid` |
| 17 | `oci+container://` on facet `user` | `kl:invalid` |
| 18 | `kmod` for the running kernel, release-stream signed | launchable; mountable by warden; owner `seal` refused `kl:denied` |
| 19 | `kmod` with one unsigned `.ko` | install fails `kl:integrity` |
| 20 | `kmod` built for another kernel release | `kernel-mismatch`; stays stored |
| 21 | Publisher app with catalog `unreviewed` | `launchReasons = ["unreviewed-tier2"]`; `mount` by warden allowed; after an owner `reproducibility` exception, reasons empty |
| 22 | Clock and revocation list such that revocation age is 31 days; first install of a publisher app | `kl:needs-approval`; reason `offline-install-needs-t3` until the T3 approval; a second version of the same app later needs no approval |
| 23 | Revocation hand-off via `Resolution.revocations`, org list revoking an org-publisher key with `after` | org container generations signed after `after` revoked; earlier ones revoked (no quorum); distro generations unaffected |
| 24 | Seal whose `windowDigest` differs from the `seal.window` receipt | `kl:integrity`; no seal evidence written |
| 25 | `openPath(G, "/.keylos/l10n/de.json")` on facet user; `openPath(G, "/usr/bin/x")` on facet user; path with `..` escaping | fd; `kl:denied`; `kl:invalid` |
| 26 | Generation statement with `issued` 2 days in the future | `no-authorising-signature` (problem `statement-from-future`) |
| 27 | `warden` removes the last `warden:running:*` root | EROFS mount dropped after 60 s; GC may then collect the generation if unrooted |
| 28 | `revocationStatus()` on facets `user`, `mounter`, `compat` after a list with `issued` = now − 10 d; same on facet `forge` | `ageSecs` ≈ 864 000 on the three facets; `kl:denied` on `forge` (REQ-DEPOT-093) |
| 29 | Test ledger returns a time floor 3 days ahead of `CLOCK_REALTIME` | revocation age and statement-from-future checks use the floor (REQ-DEPOT-094) |
| 30 | Test courier returns `review = "reviewed-reproducible"` but a `catalogEntry` naming another generation | stored review `unreviewed`, problem `catalog-mismatch`, reason `unreviewed-tier2` (REQ-DEPOT-095) |
| 31 | Container genstmt whose `drv` is a `keylos.drv/1` derivation instead of the `keylos.ociconv/1` descriptor digest | `no-authorising-signature`, problem `drv-mismatch` (REQ-DEPOT-096) |
| 32 | Consent mandate re-signed by a key that is not `Ledger.serviceKey("broker")` | consent not written; generation stays `needs-consent` (REQ-DEPOT-097) |
| 33 | `root(G, "courier:os:12")` from facet `cri` | `kl:denied` (namespace); from facet `courier` accepted (REQ-DEPOT-060) |

### 11.3 Fuzz targets (cargo-fuzz, ≥ 24 h per release)

`erofs_read`, `composefs_write_roundtrip`, `objpack_toc`, `tar_stream`, `oci_manifest`, `oci_index`, `dsse_verify`, `genstmt_parse`, `seal_parse`, `klb_bundle`, `capability_diff`, `oci_convert_layers` (whiteouts, hard links, PAX headers), `kmod_trailer`, `catalog_entry`, `openpath_resolve`, `ociconv_descriptor`.

### 11.4 Conformance vectors

- protocols `vectors/ids`, `vectors/dsse`, `vectors/manifest`, `vectors/consent`, `vectors/seal`, `vectors/tlogproof`.
- depot-owned `vectors/composefs/`: 50 trees with expected EROFS bytes produced by `mkcomposefs` 1.0.x.
- depot-owned `vectors/objpack/`: TOC parsing cases, chunked large objects.
- depot-owned `vectors/launch/`: evidence sets with expected reason codes (including every protocols §7.3.8 code).
- depot-owned `vectors/container-convert/`: 40 OCI images (single and multi-arch, gzip/zstd/uncompressed layers, whiteouts, opaque dirs, hard links, setuid, devices, xattrs, sticky dirs) with the expected generation digest, synthesized manifest and `conversion.json`; `forge` runs the same vectors.

### 11.5 Acceptance criteria

- All of §11.2 pass on KL1, KL2 and KL3 kernels, on x86-64 and aarch64.
- Performance budgets of §8 met on the reference machine.
- No `unsafe` outside the ioctl/mount wrappers of `keylos-composefs` and `depotd::mounts`; each block justified and covered by tests.
- Every REQ-DEPOT requirement mapped to at least one test in `tests/REQUIREMENTS.md`.

---

## 12. Implementation notes

| Need | Crate |
|---|---|
| Async runtime | `tokio` 1.x |
| Syscalls (fsopen, ioctl, openat2) | `rustix` 1.x (`fs`, `mount` features) |
| Database | `redb` 2.x |
| Hashing | `sha2` 0.10 |
| Ed25519 / P-256 | `ed25519-dalek` 2.x, `p256` 0.13 (through `keylos-formats`) |
| OCI types | `oci-spec` 0.7 |
| HTTP over gate sockets | `hyper` 1.x, `rustls` 0.23 |
| zstd | `zstd` 0.13 |
| tar | `tar` 0.4 (streaming read only) |
| CBOR | `ciborium` 0.2 |
| capwire | `keylos-capwire`, `keylos-schemas` |
| JSON/JCS | `serde`, `serde_json`, `keylos-formats` |

Repository layout:

```
depot/
  crates/depotd/              service
  crates/depot-cli/           CLI
  crates/depot-parse/         parser subprocess
  crates/keylos-composefs/    EROFS writer/reader, composefs semantics
  crates/keylos-objpack/      objects pack + zstd:chunked TOC
  crates/depot-mount-helper/  initrd mount library (cdylib + bin)
  crates/keylos-depot-client/ client helpers
  vectors/  fuzz/  tests/vm/
```

---

## 13. Decisions and alternatives

| Decision | Alternatives considered | Reference |
|---|---|---|
| composefs + fs-verity objects; generation = EROFS image digest | OSTree hardlink checkouts (no runtime verification); dm-verity per app (no dedup) | [ADR-0007](../../handbook/11-decisions/adr-0007-composefs-fsverity-store.md) |
| No in-kernel signatures; DSSE statements verified in userspace; `kl-exec` keyed by verified superblocks | Per-object fs-verity builtin signatures (kernel cannot verify Ed25519; one signature per object; keyring management); IMA appraisal | [ADR-0008](../../handbook/11-decisions/adr-0008-host-executes-only-sealed-code.md) |
| Launchability recomputed from evidence each start | Trusting a database flag | [ADR-0008](../../handbook/11-decisions/adr-0008-host-executes-only-sealed-code.md) |
| `courier` is the only TUF client; `depot` consumes `Resolution`s | Two TUF clients with diverging freshness state | [ADR-0017](../../handbook/11-decisions/adr-0017-tuf-over-oci.md) |
| Quorum verified at resolve time, re-checked structurally by `depot` | `depot` parsing TUF quorum policy itself | [ADR-0016](../../handbook/11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md) |
| redb cache; evidence files as truth | SQLite (C in the TCB) | [ADR-0002](../../handbook/11-decisions/adr-0002-rust-for-the-tcb.md) |
| Grafted generations flagged by `grafted: true` and replaced | Permanent grafts | [ADR-0018](../../handbook/11-decisions/adr-0018-grafts-are-temporary.md) |
| Non-reproducible ⇒ effective tier ≥ 2 unless an owner exception | Allow with a warning | [ADR-0043](../../handbook/11-decisions/adr-0043-non-reproducible-means-tier-2.md) |
| One store for language ecosystems | Per-ecosystem caches | [ADR-0042](../../handbook/11-decisions/adr-0042-one-store-for-language-ecosystems.md) |
| Sealed pods use deterministically converted, org-signed `container` generations; unsealed images stay in `cri`'s VM-only store | Running OCI images on the host through a container runtime; signing OCI manifests instead of generations | [ADR-0047](../../handbook/11-decisions/adr-0047-cri-microvm-pods.md) |
| Out-of-tree modules only as release-signed `kmod` generations | Owner-sealed or DKMS-built modules (impossible under lockdown) | [ADR-0057](../../handbook/11-decisions/adr-0057-oot-modules-project-signed-only.md) |
| New third-party installs need T3 after 30 days without fresh revocations | Refuse installs offline; ignore staleness | [ADR-0056](../../handbook/11-decisions/adr-0056-offline-mode.md) |
| Catalog review status supplied by `courier`; unreviewed apps VM-only | A second TUF client in depot; trusting publishers without review | [ADR-0046](../../handbook/11-decisions/adr-0046-courier-sole-tuf-client.md) |
