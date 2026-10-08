# keylos/protocols: shared contracts of the keylos operating system

| | |
|---|---|
| Repository | `github.com/keylos-os/protocols` |
| Version | 1.0.0 (final) |
| Status | Normative |
| Artifacts | Rust crates `keylos-ids`, `keylos-capwire`, `keylos-schemas`, `keylos-formats`, `keylos-biscuit`, `keylos-labels`, `keylos-presence`, `keylos-tpm-registry`; Cap'n Proto schema files `schema/*.capnp`; WIT package `wit/keylos-effects`; JSON Schemas `jsonschema/*.json`; conformance test vectors `vectors/` |
| Depends on | nothing inside keylos |
| Depended on by | every other keylos repository |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose

keylos is a Linux userland built on three primitives:

1. A content-addressed, fs-verity-sealed store.
2. Capabilities as the only form of authority.
3. Signed, versioned state transactions.

It treats humans, applications, services and AI agents as distinct principals.

This repository defines **every contract that crosses a repository boundary**:
- identifiers
- cryptographic algorithms and signed document formats, including presence signatures
- the IPC wire protocol (capwire), its vsock profile, and every inter-component interface, including the **system interfaces** that tier-0 services use with each other (§7.5)
- the registries of service names, facets, receipt events, media types, vsock ports and TPM objects (§19)
- the capability-token vocabulary and the Cedar schema
- label, effect and approval semantics
- the confinement and code-integrity contract, including the `kl-exec` map contract and the boot trust set
- the filesystem layout and the platform baseline
- the shared document formats consumed by more than one repository (§20)
- the cluster-node contract: the CRI v1 boundary to the upstream `kubelet` and the pod principal model (§21)

Other keylos specs embed the parts they use **verbatim**, citing `protocols §N`. If an embedded copy differs from this document, this document wins. A repository MAY define **repo-local** interfaces and formats that only its own binaries use. Those MUST NOT be consumed by any other repository; anything another repository consumes belongs here.

This repo ships:
- Rust crates implementing everything here (parsers, serializers, the capwire transport, generated Cap'n Proto bindings, presence verification, the TPM registry constants).
- Language-neutral schema files.
- Test vectors. Every implementation MUST pass them.

---

## 2. Platform baseline

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

### 2.1 Kernel feature levels

Components MUST probe for features and MUST pick behaviour by **feature level**, not by kernel version string.

| Level | Required kernel features | Typical kernel |
|---|---|---|
| `KL1` | Landlock ABI ≥ 7, BPF LSM (`lsm=` includes `bpf`), IPE, fs-verity, overlayfs `verity=require`, pidfd (`CLONE_PIDFD`, `pidfd_getfd`, `SO_PEERPIDFD`), `openat2`, new mount API, `MOVE_MOUNT_BENEATH`, idmapped mounts, `AT_EXECVE_CHECK`, `memfd_secret`, `mseal`, cgroup v2 (`cgroup.freeze`, `cgroup.kill`) | 6.18 |
| `KL2` | KL1 + Landlock ABI ≥ 9 (`FS_RESOLVE_UNIX`, `RESTRICT_SELF_TSYNC`) | 7.1 |
| `KL3` | KL2 + Landlock ABI ≥ 10 (UDP rules) | 7.2 |

On KL1 and KL2 there are no Landlock rules for pathname unix sockets or UDP. Components MUST compensate: the sandbox gets a private network namespace with only `lo`, and egress goes through `gate`; the mount view gives no access to pathname sockets. That compensation MUST be recorded in the process's confinement report (§9.4).

The LSM order on the kernel command line is `lsm=landlock,lockdown,yama,ipe,bpf`.

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

---

## 3. Identifiers

All identifiers have a canonical **text form** (ASCII, no whitespace) and a canonical **binary form**. Text forms are case-sensitive and use lowercase hex.

### 3.1 Digests

```
digest      = algo ":" hex
algo        = "sha256" / "sha512" / "fsv256"
hex         = 64HEXDIGLC / 128HEXDIGLC   ; exactly 64 for sha256/fsv256, 128 for sha512
```

- `sha256:` is the SHA-256 of a byte string. It is used for sources, documents and blobs that are not files in the store.
- `fsv256:` is the **fs-verity file digest** with SHA-256, a 4096-byte Merkle block size and no salt. It is computed exactly as the kernel's `FS_IOC_MEASURE_VERITY` returns it. It is used for every file in the store and every generation image.
- Binary form: the Cap'n Proto struct `Digest` (§7.3.1).

### 3.2 Typed references

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

### 3.3 Names

- **Generation names** use reverse-DNS: `org.example.Editor`. The pattern is `^[a-z][a-z0-9-]*(\.[a-zA-Z0-9-]+){2,}$`, at most 255 characters. The prefixes `io.keylos.` and `org.keylos.` are reserved for the project.
- **Service names** are `[a-z][a-z0-9-]{0,62}` (for example `vault`, `portal-files`). The registry is §19.1.
- **Facet names** are `[a-z][a-z0-9-]{0,31}`. The registry is §19.2.
- **Usernames** are `[a-z_][a-z0-9_-]{0,31}`. `_system` and `_cluster` are reserved, and the prefix `guest-` is reserved for ephemeral guest sessions (`guest-<8 lowercase base32>`, created and destroyed by `hearth`).
- **Kubernetes names**: `pod-ns` and `pod-name` follow Kubernetes DNS-1123 label / subdomain rules (`[a-z0-9]([-a-z0-9]*[a-z0-9])?`, ≤ 63 and ≤ 253 characters).

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

### 3.6 Time

- On the wire: `Timestamp { unixNanos :Int64 }` in UTC.
- In documents: RFC 3339 with `Z` and at most nanosecond precision.
- The system clock MUST be disciplined by NTS-authenticated time (owned by the `net` repo).
- Components that check expiry (tokens, TUF, certificates) MUST treat the clock as **untrusted until the first NTS sync after boot**. Until then they use the **time floor**: the time of the newest ledger checkpoint (`LedgerAdmin.timeFloor`, §7.5.5). `net` steps the clock forward to the time floor at boot if the RTC is earlier. The RTC is never trusted to move time backwards past the floor.

---

## 4. Cryptography

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

---

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

---

## 6. Generation manifest

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

### 6.4 Agent templates

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

---

## 7. capwire: the IPC protocol

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

### 7.2.1 capwire-vsock profile (host ↔ guest)

Between a VM guest and the host, capwire runs over **`AF_VSOCK` `SOCK_SEQPACKET`** with these differences:
1. **No fd passing.** `Fd` fields MUST NOT appear in messages on this profile; receivers MUST reject them.
2. Bulk data uses `ByteStream`/`ByteSource` capabilities, or dedicated vsock stream connections on the bulk port range (§19.5) announced in messages.
3. **Authentication.** The host identifies the VM by its vsock CID, which `bench` assigns uniquely per running VM (CID ≥ 3). The guest is never trusted for identity claims; every host-side endpoint is bound to exactly one VM principal.
4. Ports are registered in §19.5. The guest initiates every connection to host CID 2.

### 7.3 Interfaces

Each schema file has a fixed file ID. The schemas below are **normative**. Implementations MUST use these exact IDs, ordinals and types. Comments starting with `#!` are normative constraints.

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

#### 7.3.3 `broker.capnp`

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

#### 7.3.6 `vault.capnp`

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

#### 7.3.7 `gate.capnp`

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

#### 7.3.9 `courier.capnp`

```capnp
@0xc7a1e5d3b2f40009;
using C = import "common.capnp";

struct UpdateInfo {
  stream   @0 :Text;
  current  @1 :C.Ref;
  available @2 :C.Ref;
  version  @3 :Text;
  notes    @4 :Text;
  capabilityDiff @5 :Text;
  security @6 :Bool;
  rebuilderQuorum @7 :Text;   # e.g. "3/3"
}

interface Courier {
  check    @0 () -> (updates :List(UpdateInfo));
  stage    @1 (target :C.Ref) -> ();          # download, verify, predict PCRs, install boot entry
  status   @2 () -> (state :Text, staged :C.Ref, bootCounter :Text);
  rollback @3 () -> ();                       # make previous generation default
  pin      @4 (ref :C.Ref) -> ();             # keep this generation bootable
}
```

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

#### 7.3.13 `bench.capnp`

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

#### 7.3.14 `aide.capnp`

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

#### 7.3.15 `net.capnp`, `devd.capnp`, `journal.capnp`, `portals.capnp`, `compat.capnp`

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

#### 7.3.16 `loom.capnp`

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

### 7.4 Versioning

- Schemas evolve only by Cap'n Proto-compatible additions: new fields, new methods, new enumerants.
- Removal or renumbering needs a new file ID and a protocols major version.
- Every bootstrap capability implements `common.Extensible`; `version()` returns `(protocols, implementation)` version strings.
- Repo-local schemas (used only by a repository's own binaries) MUST use file IDs generated with `capnp id` outside the `0xc7a1e5d3b2f4xxxx` range reserved for this repository.

### 7.5 System interfaces

System interfaces are the contracts between tier-0 services (and a few privileged apps such as `atrium`). They are obtained either as the bootstrap capability of a route (when the route's facet names the interface as primary) or through `Extensible.ext(interfaceId)` on the service's bootstrap capability. Which facet may obtain which interface is fixed by §19.2.

| § | File | File ID | Interfaces | Server |
|---|---|---|---|---|
| 7.5.1 | `warden-sys.capnp` | `0xc7a1e5d3b2f40020` | `Bootstrap`, `ServiceHost`, `GrantMounts`, `PrincipalControl`, `ServiceConnect`, `FdStore`, `LegacySpawn`, `UserSpawn`, `TrustedSpawn`, `DebugAttach`, `PodSpawn`, `VmSpawn` | warden (`ServiceHost`: every service) |
| 7.5.2 | `broker-sys.capnp` | `0xc7a1e5d3b2f40021` | `BrokerSystem`, `LabelAuthority` | broker |
| 7.5.3 | `hearth-sys.capnp` | `0xc7a1e5d3b2f40022` | `HearthSystem`, `HearthSeal`, `HearthAdmin`, `HearthTpm`, `HearthQuorum`, `HearthFleet` | hearth |
| 7.5.4 | `vault-sys.capnp` | `0xc7a1e5d3b2f40023` | `VaultUsers` | vault |
| 7.5.5 | `ledger-sys.capnp` | `0xc7a1e5d3b2f40024` | `LedgerWitness`, `LedgerAdmin` | ledger |
| 7.5.6 | `courier-sys.capnp` | `0xc7a1e5d3b2f40025` | `CourierResolver` | courier |
| 7.5.7 | `strata-sys.capnp` | `0xc7a1e5d3b2f40026` | `StrataTxn`, `TransactionExt`, `StrataAdmin`, `StrataHomes`, `StrataVolumes` | strata |
| 7.5.8 | `devd-sys.capnp` | `0xc7a1e5d3b2f40027` | `DeviceAdmin`, `PowerEvents`, `Bluetooth`, `Backlight`, `MediaAttach` | devd |
| 7.5.9 | `journal-sys.capnp` | `0xc7a1e5d3b2f40028` | `JournalWarden`, `Crashes`, `Metrics` | journal |
| 7.5.10 | `bench-sys.capnp` | `0xc7a1e5d3b2f40029` | `BenchMerge`, `GrantDelegate`, `MediaBrowser`, `ExportCompletion`, `GuestPortals` | bench (`GrantDelegate`: aide) |
| 7.5.11 | `net-sys.capnp` | `0xc7a1e5d3b2f4002a` | `NetWatch`, `NetResolver`, `NetPlumbing`, `NetCaptive`, `NetPlumbingCluster`, `NetDiscovery` | net |
| 7.5.12 | `gate-sys.capnp` | `0xc7a1e5d3b2f4002b` | `ShimEndpoint`, `GateDebug`, `GateMeterAdmin` | gate |
| 7.5.13 | `aide-sys.capnp` | `0xc7a1e5d3b2f4002c` | `AgentHostExt`, `VmExec`, `AgentDesktop` | aide (`AgentDesktop`: served by bench to aide, by aide to the harness) |
| 7.5.14 | `config-sys.capnp` | `0xc7a1e5d3b2f4002d` | `ConfigFleet` | config |
| 7.5.15 | `compat-sys.capnp` | `0xc7a1e5d3b2f4002e` | `CompatIsland` | compat |
| 7.5.16 | `display.capnp` | `0xc7a1e5d3b2f4002f` | `Display` | atrium |
| 7.5.17 | `a11y.capnp` | `0xc7a1e5d3b2f40030` | `A11yApp`, `A11yHost`, `A11yObserver`, `A11yGate` | atrium |
| 7.5.18 | `screencast.capnp` | `0xc7a1e5d3b2f40031` | `Screencast`, `ShortcutsHost`, `IndicatorHost`, `ClipboardHost`, `InhibitHost` | atrium |
| 7.5.19 | `picker.capnp` | `0xc7a1e5d3b2f40032` | `FilePicker` | portal-files |
| 7.5.20 | `portals-extra.capnp` | `0xc7a1e5d3b2f40033` | `Background`, `GlobalShortcuts`, `Inhibit` | portal-background, portal-shortcuts, portal-inhibit |
| 7.5.21 | `fleet-sys.capnp` | `0xc7a1e5d3b2f40034` | `FleetCompliance`, `OrgDecider`, `FleetCluster` | fleet |
| 7.5.22 | `vouch-sys.capnp` | `0xc7a1e5d3b2f40035` | `VouchLink` | vouch (machine-side `vouchd`) |
| 7.5.23 | `cri-sys.capnp` | `0xc7a1e5d3b2f40036` | `CriAdmin` | cri |
| 7.5.24 | `classifier.capnp` | `0xc7a1e5d3b2f40037` | `Classifier` | the policy-named classifier service |
| 7.3.16 | `loom.capnp` | `0xc7a1e5d3b2f40038` | `Loom`, `Workflow`, `AttemptHost` | loom |
| 7.5.25 | `loom-sys.capnp` | `0xc7a1e5d3b2f40039` | `DurableEffects`, `WorkflowBudget`, `BrokerWorkflow`, `AgentWorkflowHost`, `LoomSystem` | gate (`DurableEffects`, `WorkflowBudget`), broker (`BrokerWorkflow`), aide (`AgentWorkflowHost`), loom (`LoomSystem`) |

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

#### 7.5.4 `vault-sys.capnp`

```capnp
@0xc7a1e5d3b2f40023;
using C = import "common.capnp";

struct SlotSpec { kind @0 :Text; factor @1 :C.Fd; params @2 :Text; }
  # kind: password | fido2 | recovery. recovery: factor absent (index 0xFFFF); vault wraps the user key with HPKE to the
  # recovery recipient public key (§20.21), so the slot can be created without knowing the recovery key

interface VaultUsers {             # facet hearth
  createUser @0 (user :Text, slots :List(SlotSpec)) -> (slotIds :List(Text));
  unlockUser @1 (user :Text, slotId :Text, factor :C.Fd) -> ();
  lockUser   @2 (user :Text) -> ();
  addSlot    @3 (user :Text, slot :SlotSpec) -> (slotId :Text);
  removeSlot @4 (user :Text, slotId :Text) -> ();
  deleteUser @5 (user :Text) -> ();
  slots      @6 (user :Text) -> (json :Text);
}
```

**Slots.**
- `SlotSpec.params` is JCS JSON; binary members are standard base64 (§5.1). `password`: `{"alg": "argon2id", "m", "t", "p", "salt", "prehashed"}`, where `prehashed: true` is allowed only at creation (the factor is then the 32-byte raw Argon2id output, as at first boot); every later password or PIN factor is the raw UTF-8 secret and the vault runs Argon2id with the stored parameters. `fido2`: `{"credentialId", "rpId": "keylos.login", "salt1"}`, factor = the `hmac-secret` output. `recovery`: `{}` from `hearth` (the vault adds `ephemeralPublic`).
- The vault creates a recovery slot only when `slots` contains a `recovery` SlotSpec; `hearth` adds one according to its `hearth.recoverySlots` setting (`owners` by default, `all`, `none`).
- A guest user (`guest-…`, §3.3) is created with an empty slot list, exactly.
- `addSlot` and `removeSlot` require the user unlocked (`kl:unavailable:user-locked`).

#### 7.5.5 `ledger-sys.capnp`

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

#### 7.5.6 `courier-sys.capnp`

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

#### 7.5.8 `devd-sys.capnp`

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

#### 7.5.9 `journal-sys.capnp`

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

#### 7.5.10 `bench-sys.capnp`

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

#### 7.5.11 `net-sys.capnp`

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

#### 7.5.12 `gate-sys.capnp`

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

#### 7.5.13 `aide-sys.capnp`

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

#### 7.5.15 `compat-sys.capnp`

```capnp
@0xc7a1e5d3b2f4002e;
using C = import "common.capnp";

interface CompatIsland {           # facet adapter (devd Bluetooth adapter, portal-print CUPS adapter, vault import island)
  islandSocket @0 (service :Text) -> (socket :C.Fd);
      #! connected socket to the island; the protocol depends on the island: "bluez", "cups-dbus" → filtered D-Bus proxy;
      #! "sane" → SANE network protocol (saned) stream; "cups" → IPP over HTTP/1.1; "secret-import" → filtered D-Bus proxy
}
```

#### 7.5.16 `display.capnp`

```capnp
@0xc7a1e5d3b2f4002f;
using C = import "common.capnp";
using W = import "warden.capnp";

enum ClientClass { trusted @0; t1 @1; t2 @2; legacyX @3; assistive @4; ime @5; }

interface Display {                # facets warden, bench, compat (xwaylandWm), settings (outputs)
  clientSocket @0 (principal :C.PrincipalId, tier :W.Tier, generation :C.Ref, process :W.Process)
                -> (socketDir :C.Fd, name :Text, cls :ClientClass);
      #! socketDir: O_PATH dirfd containing the listening socket `name`; the binding lives until process.wait resolves
  xwaylandWm   @1 (principal :C.PrincipalId, wm :C.Fd) -> ();
      #! facet compat only; wm = socketpair end connected to Xwayland's -wm fd
  outputs      @2 () -> (json :Text);
  windowOwner  @3 (window :Text) -> (principal :C.PrincipalId, human :Text, app :Text);
      #! facet broker only: owner of "window:<id>" (ResourceRef.screen); app = the generation name; kl:not-found if unknown
}
```

#### 7.5.17 `a11y.capnp`

```capnp
@0xc7a1e5d3b2f40030;
using C = import "common.capnp";

struct A11yNode {
  id          @0 :UInt64;
  role        @1 :Text;              # ARIA role names
  name        @2 :Text;
  description @3 :Text;
  value       @4 :Text;
  states      @5 :List(Text);        # "focused","selected","checked","disabled","expanded",…
  bounds      @6 :Bounds;            # surface-local logical coordinates
  children    @7 :List(UInt64);
  actions     @8 :List(Text);        # "click","focus","increment","decrement","scroll-into-view",…
  textSel     @9 :TextSelection;
  struct Bounds { x @0 :Int32; y @1 :Int32; w @2 :Int32; h @3 :Int32; }
  struct TextSelection { anchor @0 :UInt32; focus @1 :UInt32; }
}

struct A11yUpdate { surfaceId @0 :UInt32; nodes @1 :List(A11yNode); removed @2 :List(UInt64); focus @3 :UInt64; }

interface A11yApp {                # implemented by the app or bridge; called by atrium
  doAction @0 (node :UInt64, action :Text) -> (ok :Bool);
}

interface A11yHost {               # atrium facets bridge, native
  attach @0 (app :A11yApp) -> (sink :C.Watcher(A11yUpdate));
}

interface A11yObserver {           # handed to assistive principals through the Accessibility portal
  tree       @0 () -> (updates :List(A11yUpdate));
  watch      @1 (watcher :C.Watcher(A11yUpdate)) -> (cancel :C.Cancelable);
  doAction   @2 (surfaceId :UInt32, node :UInt64, action :Text) -> (ok :Bool);
  speakFocus @3 () -> (text :Text);
}

interface A11yGate {               # facet portal-a11y (portal-a11y)
  observer @0 (consumer :C.PrincipalId) -> (observer :A11yObserver);
      #! consumer MUST be an assistive-technology principal (generation name in the owner-configured assistive list);
      #! the observer never exposes surfaces of the trusted path, password fields or tier-2 windows' contents
}
```

#### 7.5.18 `screencast.capnp`

```capnp
@0xc7a1e5d3b2f40031;
using C = import "common.capnp";

struct CastRequest {
  consumer @0 :C.PrincipalId;
  kinds    @1 :List(Kind);
  cursor   @2 :CursorMode;
  multiple @3 :Bool;
  enum Kind { output @0; window @1; region @2; }
  enum CursorMode { hidden @0; embedded @1; metadata @2; }
}

struct CastStream { nodeId @0 :UInt32; width @1 :UInt32; height @2 :UInt32; sourceDescription @3 :Text; }

interface Screencast {             # facet portal-screen
  start @0 (req :CastRequest) -> (streams :List(CastStream), remote :C.Fd, stop :C.Cancelable);
      #! shows the trusted picker; remote = PipeWire remote fd restricted to the returned nodes
}

interface ShortcutsHost {          # facet portal-shortcuts
  bind   @0 (owner :C.PrincipalId, shortcuts :List(C.KeyValue)) -> (bound :List(C.KeyValue));
  events @1 (owner :C.PrincipalId, watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);
  unbind @2 (owner :C.PrincipalId, ids :List(Text)) -> ();
}

interface IndicatorHost {          # facets portal-camera, portal-mic, portal-location, portal-background, portal-screen
  show @0 (kind :Text, consumer :C.PrincipalId, description :Text) -> (handle :C.Cancelable);
      #! kind: "camera" | "microphone" | "location" | "screen" | "background"; shown until handle.cancel
}

interface ClipboardHost {          # facet portal-clipboard
  source @0 (offerId :Text) -> (owner :C.PrincipalId, label :C.Label, mimeTypes :List(Text));
      #! the label atrium recorded for the principal that created the selection offer; portal-clipboard raises the
      #! reader's label to it (not to private/untrusted) before handing data over
}

interface InhibitHost {            # facet portal-inhibit
  inhibit @0 (owner :C.PrincipalId, kinds :List(Text), reason :Text) -> (handle :C.Cancelable);
      #! kinds "idle" | "logout" handled by atrium; "suspend" | "lid" are forwarded by portal-inhibit to devd PowerEvents
}
```

#### 7.5.19 `picker.capnp`

```capnp
@0xc7a1e5d3b2f40032;
using C = import "common.capnp";
using B = import "broker.capnp";

struct PickResult {
  fd          @0 :C.Fd;
  rootKey     @1 :Text;          # identifies the held root dirfd (matches the broker path_root fact)
  relPath     @2 :Text;          # path relative to root, normalised, no ".."
  displayName @3 :Text;
  kind        @4 :Kind;
  persist     @5 :Bool;          # user ticked "Remember access"
  enum Kind { file @0; directory @1; created @2; }
}

interface FilePicker {             # portal-files facets broker (pick), drop (atrium: confirmDrop)
  pick        @0 (req :B.PowerboxRequest, requester :C.PrincipalId, user :Text) -> (results :List(PickResult));
      #! empty list = user cancelled
  confirmDrop @1 (tokens :List(C.Token), target :C.PrincipalId) -> (results :List(PickResult));
}
```

#### 7.5.20 `portals-extra.capnp`

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

#### 7.5.21 `fleet-sys.capnp`

```capnp
@0xc7a1e5d3b2f40034;
using C = import "common.capnp";
using P = import "prompt.capnp";

interface FleetCompliance {        # facets gate (complianceToken), client (status)
  status          @0 () -> (json :Text);
  complianceToken @1 (audience :Text) -> (envelope :Data);   # DSSE compliance assertion for org services
}

interface OrgDecider {             # facet decider (broker)
  decide @0 (prompt :P.ApprovalPrompt, group :Text) -> (decision :P.Decision);
      #! for permits annotated @orgApproval("<group>"); the mandate is signed by an approver/<id> key
}

interface FleetCluster {           # facet cluster (cri)
  joinAttested @0 (quote :Data, eventLog :Data, cvmReport :Data, challenge :Data) -> (joinJson :Text);
      #! fleet verifies the TPM quote (AK, §19.6; qualifyingData = SHA-256("keylos-join/1" ‖ challenge ‖ machine key))
      #! against the release log and, for cvm, the confidential-VM report; challenge MUST come from joinChallenge and be
      #! unexpired; returns the cluster API endpoint, CA bundle and a bootstrap token bound to the node identity
  kubeletCertificate @1 (csrDer :Data) -> (chainPem :Text, expires :C.Timestamp);   # = clusterCertificate("kubelet", …)
  joinChallenge      @2 () -> (challenge :Data, expires :C.Timestamp);   # 32 random bytes, valid ≤ 300 s, single use
  clusterCertificate @3 (role :Text, csrDer :Data) -> (chainPem :Text, expires :C.Timestamp);
      #! role "kubelet" | "kube-proxy" | "cri" (cri's own cluster credential: NetworkPolicy and Pod watches, drain);
      #! issued only to attested nodes; renewed by cri before expiry; private keys stay in the cri state directory
}
```

#### 7.5.22 `vouch-sys.capnp`

```capnp
@0xc7a1e5d3b2f40035;
using C = import "common.capnp";
using P = import "prompt.capnp";

struct Phone { id @0 :Text; label @1 :Text; platform @2 :Text; lastSeen @3 :C.Timestamp; witness @4 :Bool; approvals @5 :Bool; pending @6 :Bool; }

interface VouchLink {              # facets settings (atrium), approvals (atrium), announce (courier), witness (ledger bridge)
  phones        @0 () -> (list :List(Phone));
  pairStart     @1 () -> (qr :Text, expires :C.Timestamp);
  pairCode      @2 (words :List(Text)) -> ();
  pairWait      @3 () -> (phone :Phone);
  remove        @4 (id :Text) -> ();
  routeApproval @5 (prompt :P.ApprovalPrompt) -> (decision :P.Decision);   #! never satisfies requiresPresence (§14.3)
  announce      @6 (kind :Text, detailJson :Text) -> ();                    # "release-staged" | "firmware-pending" | "baseline-update"
  inheritance   @7 (configJson :Text) -> ();
      #! facet settings: configures the optional dead-man timer (§20.19): after N days without an owner login heartbeat,
      #! the paired phone releases the owner's encrypted inheritance note to the listed trustees. Never a key.
}
```

#### 7.5.23 `cri-sys.capnp`

```capnp
@0xc7a1e5d3b2f40036;
using C = import "common.capnp";

struct PodInfo {
  podId        @0 :Text;
  namespace    @1 :Text;
  name         @2 :Text;
  runtimeClass @3 :Text;            # "keylos-vm" | "keylos-sealed"
  state        @4 :Text;            # "admitting" | "pending-approval" | "ready" | "notready" | "denied"
  principals   @5 :List(C.PrincipalId);
  admission    @6 :Text;            # JSON of the BrokerSystem.admitPod result
}

interface CriAdmin {               # facets admin (owner shell), status (fleet, atrium)
  pods     @0 () -> (list :List(PodInfo));
  node     @1 () -> (json :Text);   # attestation state, kubelet version, runtime classes, capacity
  drain    @2 (reason :Text) -> ();  # admin only: cordon + evict through the API server using cri's cluster credential (role "cri")
  images   @3 () -> (json :Text);   # cached OCI images (keylos-vm) and container generations (keylos-sealed)
}
```

#### 7.5.24 `classifier.capnp`

```capnp
@0xc7a1e5d3b2f40037;
using C = import "common.capnp";

struct ClassifyRequest {
  principal @0 :C.PrincipalId;
  kind      @1 :Text;              # request kind: "grant.<resource kind>", an effect kind, or "net"
  summary   @2 :Text;              # request summary (resource and rights as text; never data)
  label     @3 :C.Label;           # current session label
  recent    @4 :List(Text);        # summaries of at most the last 20 receipts of the session
  tier      @5 :UInt8;             # tier the broker decided (0..3)
}

struct ClassifyResult {
  escalate @0 :Escalate;
  reason   @1 :Text;
  enum Escalate { none @0; t2 @1; t3 @2; }   #! can only raise the tier; failure, timeout or malformed output raises by one level
}

interface Classifier {             # facet broker (holder broker only)
  classify @0 (request :ClassifyRequest) -> (result :ClassifyResult);
}
```

#### 7.5.25 `loom-sys.capnp`

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

---

## 8. Capability tokens

### 8.1 Format

Tokens are **Biscuit v3** tokens:
- Ed25519 root key; the broker holds the root keys.
- Datalog blocks; attenuation is offline and append-only.

There is one root keypair per boot per machine, rotated at reboot. **Persistent grants** are stored by the broker as **grant records** (broker-local format `keylos.grant/1`) and re-minted on each boot. Tokens never outlive a boot.

### 8.2 Authority block vocabulary

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

### 8.3 Attenuation checks

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

### 8.4 Revocation

- Revoking a root ID invalidates every token derived from it, including tokens whose `budget_parent` names it. Revocations are in-memory and persisted until the next reboot, when keys rotate anyway.
- **Workflow revocation is durable.** Cancelling or revoking a workflow (`BrokerWorkflow.cancel`, §20.25) writes a persistent cancellation record in the broker, revokes every root carrying that workflow's `workflow` fact, and makes every later claim and attempt registration of the workflow fail, across restarts and reboots; it is not undone by the per-boot key rotation.
- The broker MUST check revocation on every `materialize`, and `gate` on every `connect`, `stage` and `charge`.
- **Already-materialized fds cannot be pulled back from a process.** Revoking therefore also terminates or freezes holders through `PrincipalControl.terminate` (§7.5.1), according to the grant record's `onRevoke`: `kill` (default for agents) or `freeze` (default for apps; the user decides). Attached grant mounts are detached (`GrantMounts.detachGrant`).

---

## 9. Confinement and code-integrity contract

Owned by `warden` (confinement) and `boot` (code-integrity loading). These are the behaviours other components may rely on.

**What a reboot restores.** Reboot restores verified code and owner-approved configuration. Writable state may still contain hostile data and may require quarantine or recovery. Components MUST NOT claim more: persistent hostile data (for example a file that triggers a parser bug) survives reboot and can trigger compromise again. The recovery menu offers **safe start**: the session is not restored and nothing is reopened automatically, and app data units are quarantined read-only until the owner releases them or rolls them back to a snapshot (atrium, strata, warden specs).

### 9.1 Baseline for every non-kernel process except `warden` itself

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

### 9.2 Tiers

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

### 9.4 Confinement report

`Process.confinement` returns JCS JSON:

```json
{"schema":"keylos.confinement/1","tier":"t1","featureLevel":"KL2","landlockAbi":9,
 "namespaces":["mnt","pid","ipc","uts","cgroup","net"],"userns":false,
 "seccompProfile":"baseline-1","compensations":["udp-via-netns"],"jit":false,
 "tlsInterception":{"active":false,"hosts":[]},"grants":["/grants/thesis"]}
```

`seccompProfile` is one of the profile names of §9.1: `baseline-1`, `baseline-1+<digest>` (tier `t0` only), `debug-1`, `debug-1k`, `openbroker-1` or `runtime-default`. A kernel below KL1 is not a supported platform (§2), so a truthful report from one does not validate.

`tlsInterception` is filled from `gate` (`GateDebug.interception`, §7.5.12): when `gate` intercepts TLS for the principal (method filtering or credential injection), `active` is true and `hosts` lists the intercepted hosts.

### 9.5 Devices, removable media and DMA

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

---

## 10. Filesystem and system layout

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

### 10.2 Disk layout

GPT:
1. ESP (1 GiB, FAT32).
2. `keylos-root`: LUKS2 with dm-integrity AEAD (`aegis128` where available, else `aes-gcm-random` + HMAC-SHA256 integrity), holding btrfs subvolumes `@store`, `@var`, `@home`, `@keystore`, `@snapshots`.
3. Optional `keylos-swap`: encrypted with an ephemeral random key at every boot. There is no hibernation (§2).

### 10.3 UIDs and cgroups

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

### 10.4 Extended attributes

| xattr | Writer | Content |
|---|---|---|
| `security.bpf.keylos.prov` | BPF LSM at inode creation (`strata`) | CBOR `{p: principal, g: generation, x: transaction, t: time}` |
| `security.bpf.keylos.label` | `broker` / `strata` | 2 bytes: conf, integ (§14.1 ordinals) |
| `security.keylos.unit` | `strata` | Crypto-shred unit ID |
| `trusted.overlay.metacopy`, `trusted.overlay.redirect` | `depot` (composefs) | |

Names a BPF LSM program must read or stamp use the `security.bpf.` prefix: the kernel's BPF xattr kfuncs (`bpf_get_file_xattr`, `bpf_get_dentry_xattr`, `bpf_set_dentry_xattr`) accept only `user.*` (read) and `security.bpf.*` names, and are available to LSM program types only. From userspace, setting or removing any `security.*` name, `security.bpf.*` included, needs `CAP_SYS_ADMIN` in the user namespace that owns the filesystem; no keylos BPF program attaches `inode_xattr_skipcap`, so that check always applies. Principals never hold `CAP_SYS_ADMIN` and never own a filesystem's user namespace, so only the writers listed above can set these names. `security.keylos.unit` is read only by `strata` and keeps its name.

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

### 10.6 Log records

Processes write logs to the journal stream fd (fd 2 is connected to it by default) as:
- plain text lines, or
- **structured records**: a datagram whose first byte is `0x1E` followed by a CBOR map with keys `l` (level 0–7), `m` (message) and `f` (fields map), or
- **metrics records**: a datagram whose first byte is `0x1F` followed by a CBOR map with keys `n` (metric name), `t` (`"counter"` | `"gauge"` | `"histogram"`), `v` (number, or for histograms a map of bucket bound → count plus `sum` and `count`) and `l` (labels map).

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

---

## 11. Supply-chain formats

### 11.1 Recipes and derivations

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

### 11.2 Source references

- **Canonical tar stream:** POSIX ustar, entries sorted by path bytes, mtime 0, uid/gid 0, uname/gname empty, mode 0644 for regular files and 0755 for executables and directories, symlinks preserved, no other file types.
- Git sources are pinned by the commit's tree, expressed as `src:sha256:<SHA-256 of the canonical tar stream of the tree>`. The tag and commit are recorded as metadata.
- Archive sources record `src:sha256:` of the canonical tar stream of the unpacked archive, plus a **tarball-vs-git diff** record: a list of paths that differ and a justification. An unexplained difference fails the build (`forge`).

### 11.3 Generation provenance (`/.keylos/provenance.json`)

An in-toto Statement v1 bundle containing:
- SLSA Provenance v1 (buildType `https://keylos.org/forge/v1`),
- one realisation attestation per rebuilder (§11.4), and
- one `keylos.tlogproof/1` inclusion proof per attestation (§20.14).

### 11.4 Realisation attestation

An in-toto Statement v1 with:
- `subject` = the output generation: `name` = `<name>-<version>.<output>`, `digest: {"fsv256": hex}`;
- `predicateType` = `https://keylos.org/realisation/v1`;
- predicate = `{"drv": "drv:sha256:…", "output": "out", "builder": "<operator id>", "buildHost": {"arch":…, "kernel":…, "forgeVersion":…}, "started":…, "finished":…}`.

It is signed by `rebuilder/<operator>` and logged in the **realisation log** (§11.5).

### 11.5 Transparency logs

keylos operates two logs, both following **C2SP tlog-tiles** with checkpoints per **C2SP tlog-checkpoint** and witness cosignatures per **C2SP tlog-cosignature**:

| Log | Origin line | Entries |
|---|---|---|
| Realisation log | `log.keylos.org/realisations` | DSSE realisation attestations (§11.4) |
| Release log | `log.keylos.org/releases` | DSSE release statements (`keylos.release/1`, §20.6) and cloud image records (`keylos.cloudimage/1`, §20.24), signed by `release-stream/<stream>` |

Clients MUST verify inclusion against a checkpoint cosigned by at least `witnessThreshold` (default **2**) witnesses from the witness list in TUF targets metadata (`rebuilders.json`: `witnesses`, `witnessThreshold`). A generation is installable from a distro or publisher channel only if its realisation log entries reach the rebuilder quorum named in its release or app-release statement.

### 11.6 Owner seal

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

### 11.7 Revocation list

```json
{"schema":"keylos.revocations/1","stream":"stable","serial":1234,"issued":"…",
 "objects":[{"ref":"obj:fsv256:…","reason":"CVE-2026-XXXX","action":"evict"}],
 "generations":[{"ref":"gen:fsv256:…","reason":"…","action":"unlaunchable"}],
 "keys":[{"ref":"key:sha256:…","reason":"compromised","after":"…"}]}
```

- Distributed as a TUF target by `courier` and logged (its digest) in the release statement.
- Actions: `unlaunchable`, `evict`, `warn`.
- A `keys[]` entry for a `publisher/<id>` or `org-publisher/…` key makes every generation whose only authorising signature is by that key `unlaunchable` from `after` onwards; generations signed before `after` stay launchable only if their realisations reach the rebuilder quorum.

### 11.8 Publishers and catalog

- **Onboarding.** A publisher is added to the TUF `publishers` delegated role (signed by `distro-root` delegation keys) with either an Ed25519 key held in hardware or a Sigstore identity (OIDC issuer + subject) and an accepted publisher policy version. Org publishers are delegated from a fleet's TUF repository (`org-publishers` role) and are trusted only on machines enrolled in that fleet.
- **Enabling.** A machine trusts a publisher only after the owner enables it in config (`/etc/keylos/publishers.json`, §20.20); it then enters the boot trust set at the next boot.
- **Catalog.** `keylos.catalog/1` (§20.20) is a TUF target signed by the `catalog` role. A listing is `reviewed-reproducible` only if its generations' realisations reach the rebuilder quorum and the catalog review passed; otherwise it is `unreviewed`. Installing an `unreviewed` app sets its effective tier floor to 2 unless the owner records an exception (`keylos.exception/1`, kind `reproducibility`).

---

## 12. Command signatures (`keylos.cmdsig/1`)

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

---

## 13. Receipts

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

### 13.2 Event registry

Moved to §19.3.

### 13.3 Checkpoints

- `ledger` emits a **C2SP signed-note checkpoint** (origin `keylos-ledger/<machine key>`) at least every 60 s while there is activity, and on shutdown.
- The TPM NV counter `0x01300100` (§19.6) is incremented at most once per 900 s while there is activity, at shutdown, and immediately after security-class events (`grant.revoke`, `config.apply`, `gen.seal`, `update.commit`, `key.enroll`, `key.remove`, `ledger.alarm`). Every checkpoint note carries the extension line `counter <n>` with the current counter value, binding the tree size and root hash in the signed note to the counter. A ledger whose newest checkpoint counter is below the NV value has been rolled back.
- Checkpoints MAY be submitted to owner-configured witnesses (`LedgerWitness`, §7.5.5: the `vouch` phone, a fleet witness).
- `ledger.key.register` receipts are never sealed; their `data` is `{"service": "<name>", "spki": "<base64 DER>", "keyRef": "key:sha256:…"}`. `Ledger.serviceKey` (§7.3.5) answers from them.

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

---

## 14. Labels, effects and approval tiers

### 14.1 Labels

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

### 14.5 Operating rules

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.

---

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

---

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

---

## 17. Conformance

This repo ships `vectors/`:

| Suite | Contents |
|---|---|
| `ids/` | Valid and invalid identifiers of every kind |
| `dsse/` | Envelopes with valid and invalid signatures, and non-JCS payloads that must be rejected |
| `presence/` | FIDO2 presence envelopes (ES256, EdDSA) with valid, wrong-rpId, missing-UP, missing-UV, removed-credential cases |
| `manifest/` | Manifests that must pass or fail validation (including agent and compat sections), plus capability-diff cases |
| `biscuit/` | Tokens with the §8 vocabulary, and authorizer cases with expected allow/deny |
| `capwire/` | Recorded datagram sequences, including fd-index edge cases and capwire-vsock fd rejection |
| `labels/` | Label propagation and Rule-of-Two cases |
| `cedar/` | Policy, request and expected decision (including tier, presence, orgApproval and channels annotations) |
| `receipts/` | Hash-chain, submitted-form reconstruction and checkpoint/counter verification cases |
| `boottrust/` | Trust sets and generation statements with expected allow/deny for kl-exec registration |
| `release/` | Release statements, release-log proofs, floor semantics |
| `vbu/` | VBU QR payloads (CBOR), quotes from swtpm with good/bad nonce, PCR mismatch, AK0 mismatch |
| `firstboot/`, `consent/`, `seal/`, `flowproof/`, `fsmerge/`, `tlogproof/` | Format validation cases for §20 |
| `tpm/` | The §19.6 registry as machine-readable JSON, checked by every TPM-using component |
| `quorum/` | Quorum requests and multi-signature envelopes: threshold met, duplicate owner, removed credential, expired request |
| `trustee/` | Shamir share sets (k-of-n reconstruction, wrong share, checksum failure) for §20.19 |
| `catalog/`, `publishers/` | Catalog and publisher-list validation (§20.20) |
| `services/`, `policyref/` | `keylos.services/1` and `keylos.policyref/1` validation (§20.16, §20.17) |
| `recoverykey/` | Recovery key text encoding and CRC-8 checks (§20.21) |
| `podspec/` | `keylos.podspec/1` normalisation and Cedar `admit` decisions (§21.3) |
| `debug/` | Debug grant minting constraints (agents, tiers, durations) |
| `receipts-sealed/` | Sealed receipts: encryption, chain verification after shredding, submitted-form digest, `clear` returned form |
| `ociconv/` | `oci-convert/1` conversions (§21.4): OCI layouts with whiteouts, hardlinks, device nodes, file capabilities; expected `keylos.ociconv/1` descriptors and generation digests |
| `uplink/` | `keylos.cri.uplink/1` validation (§21.5) |
| `pendingreceipt/`, `fleetcommand/`, `cloudimage/`, `preauth/` | Format validation for §20.22–§20.24 and §9.5 |
| `workflow/` | Durable execution (§20.25–§20.27): workflow, run, step, attempt, effect, decision and budget-account IDs (including effect-ID derivation from step IDs), `keylos.workflow/1` definitions that must pass or fail validation, effect request digests, decision digests, the status vocabulary and the receipt-outbox reconciliation table |

Every keylos component MUST run the suites for the formats it parses or produces in CI. A release of any repo MUST state which protocols version it conforms to.

**Cross-component invariants.** Format vectors check one component at a time. The guarantees below span several components, so each is owned by the sections listed, and each MUST have an **integration acceptance test that runs the real components** across their actual boundaries (in the `warden` conformance harness, as the S2 exit test does), not test doubles that each assume the other side's behaviour:

| ID | Invariant | Sections |
|---|---|---|
| INV-1 | An effect is executed only with a mandate whose effect digest equals the digest of exactly the content that was presented and approved (prepared merges, required renderings) | §7.3.4, §14.2–§14.4, §20.12 |
| INV-2 | A file grant exposes exactly the granted object or subtree (single-file views; no parent, siblings or nested mounts) | §7.3.3, §7.5.1, §7.5.19 |
| INV-3 | A session is raised to a label that bounds everything it can read through a grant, before exposure, for the grant's lifetime | §7.3.3, §9.3, §14.1 |
| INV-4 | A revoked token cannot be materialised again, and holders of materialised fds are terminated or frozen | §8.4, §7.5.1 |
| INV-5 | A peer's identity comes only from `warden` (`ServiceHost.accept`, `connectionInfo`), across restarts and route changes | §7.1, §7.5.1 |
| INV-6 | Power loss at any point leaves every committed state recoverable and every completed erasure irreversible (vault epochs, OS floor, strata commits, ledger appends) | §13, §19.6, §20.6, vault and strata specs |
| INV-7 | A component that must write a receipt before replying does not reply success without it (`kl:unavailable` while it cannot) | §13.1, §7.5.2 |
| INV-8 | Workflow progress survives execution attempts, and persistence never resurrects cancelled or forgotten work: after a durable cancel, forget or workflow revocation no claim, attempt registration, token, dispatch or effect of that workflow happens again, across loom and broker restarts, reboots and restores of an older loom store | §8.4, §20.25, loom, broker |
| INV-9 | Authority is revalidated before every further effect: every attempt and every workflow effect is authorized by current policy with fresh boot-scoped authority, and a stale owner (lower ownership epoch) can neither register, dispatch, record nor complete anything | §8, §20.25, §7.5.25, loom, broker, gate, warden |
| INV-10 | An effect ID is executed at most as its executor's declared strategy allows: no automatic repetition after an unknown outcome except under verified downstream idempotency within its window or after authoritative reconciliation; otherwise the effect is `outcomeUnknown` until resolved; authorization is never reported as completion | §14.2, §20.26, gate, executors, loom |
| INV-11 | Workflow labels and budgets never reset across attempts: every attempt starts at the workflow's label high-water mark, the budget account's spent and unresolved amounts never decrease, and each reservation key is settled at most once | §8.2, §14.1, §20.25, broker, gate, aide, loom |
| INV-12 | A durable-execution acknowledgment (enroll, transition, record, complete, cancel, forget, decision, effect prepare) is given only after the owning store's durability barrier and, where a receipt is required, after the receipt is acknowledged; a failed barrier (fsync error, full store) is never acknowledged as success | §10.7, §13.1, §20.25, loom, broker, gate |

The integration tests for INV-8 to INV-12 run in the `warden` conformance harness with real `loom`, `broker`, `ledger` and `vault`; until `gate`, `aide`, `strata` and `bench` exist (stages S6, S7), the effect and agent sides use the documented `gate` test double of the loom spec, and those tests are rerun against the real components when they land.

**Changing a contract.** A shared format or interface whose meaning changes gets a new name or version (for example `keylos.fsmerge/2`) or, before release, an explicit "superseded" rule (`kl:unsupported`) for the old method; its meaning never changes silently. Contract excerpts in other repositories' specs are generated mechanically from this document and checked for equality; requirement IDs, algorithm order, failure tables, recovery rules and acceptance tests of the owning component specs change together with the contract. The excerpt generator and its equality check currently run from workspace tooling outside the repositories; until they move into this repository's `xtask`, a release MUST record that check's result.

---

## 18. Crates

| Crate | Content |
|---|---|
| `keylos-ids` | Parsing and formatting of §3, ULIDs, digest helpers (including fs-verity digest computation in userspace for files and byte strings) |
| `keylos-formats` | JCS, DSSE sign/verify (Ed25519, P-256), and typed models with validation for every format in this document |
| `keylos-presence` | Presence signature construction helpers and verification (§5.3), owner-registry replay (§20.3) |
| `keylos-capwire` | A Cap'n Proto `VatNetwork` over `SOCK_SEQPACKET` with SCM_RIGHTS fd sidecars and over `AF_VSOCK` (capwire-vsock profile); the `Fd` extraction/injection API; peer pidfd retrieval; `Extensible` helpers; the inheritance helper that adopts fd 3 and the `KEYLOS_CAPWIRE_FDS`, `KEYLOS_BPF_FDS` and `KEYLOS_TPM_FD` descriptors once per process (§10.5); async on tokio |
| `keylos-schemas` | Generated Rust bindings for all `.capnp` files in §7 |
| `keylos-biscuit` | Thin layer over `biscuit-auth` with the §8 vocabulary builders and authorizer helpers |
| `keylos-labels` | The label lattice and Rule-of-Two evaluator |
| `keylos-tpm-registry` | Constants and attribute templates for every TPM object in §19.6 |

The `oci-convert/1` algorithm (§21.4) is implemented solely by the crate `keylos-oci-convert`, published from the **depot** repository; `forge`, `fleet` and the `sdk` MUST use that crate.

All crates are `#![forbid(unsafe_code)]`, except `keylos-capwire` (ancillary-data handling, adoption of inherited descriptors), whose `unsafe` blocks MUST each carry a safety comment and be covered by Miri where possible. Licence: Apache-2.0 OR MIT.

---

## 19. Registries

### 19.1 Service names

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

### 19.2 Facets

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

### 19.3 Receipt events

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

### 19.4 Media types and formats

| Schema | Media type | Owner (full definition) | Purpose |
|---|---|---|---|
| `keylos.manifest/1` | `application/vnd.keylos.manifest+json; version=1` | protocols §6.3 | Generation manifest |
| `keylos.agent-template/1`, `keylos.agent-tools/1`, `keylos.agent-policy/1` | (files inside generations) | protocols §6.4 | Agent templates |
| `keylos.cmdsig/1` | `application/vnd.keylos.cmdsig+json; version=1` | protocols §12 | Command signatures |
| `keylos.receipt/1`, `keylos.receipt-redacted/1` | `application/vnd.keylos.receipt+json; version=1` | protocols §13, ledger | Receipts |
| `keylos.mandate/1` | `application/vnd.keylos.mandate+json; version=1` | protocols §14.4 | Approval mandates |
| `keylos.configgen/1` | `application/vnd.keylos.configgen+json; version=1` | protocols §15 | Config generation statements |
| `keylos.seal/1` | `application/vnd.keylos.seal+json; version=1` | protocols §11.6 | Seal statements |
| `keylos.revocations/1` | `application/vnd.keylos.revocations+json; version=1` | protocols §11.7 | Revocation lists |
| `keylos.drv/1` | (hashed JSON, unsigned) | protocols §11.1 | Derivations |
| `keylos.confinement/1` | (JSON reply) | protocols §9.4 | Confinement reports |
| `keylos.boottrust/1`, `keylos.bootreport/1` | (files under `/run/keylos/boot`) | protocols §20.1 | Boot trust set and report |
| `keylos.presence/1` | `application/vnd.keylos.presence+json; version=1` | protocols §20.2 | Generic presence payload |
| `keylos.owners-entry/1`, `keylos.owners/1` | `application/vnd.keylos.owners-entry+json; version=1` | protocols §20.3 | Owner registry |
| `keylos.seal-window/1` | `application/vnd.keylos.seal-window+json; version=1` | protocols §20.4 | Sealing windows |
| `keylos.release/1` | `application/vnd.keylos.release+json; version=1` | protocols §20.6 | Release statements (release-log entries) |
| `keylos.genstmt/1` | `application/vnd.keylos.genstmt+json; version=1` | protocols §20.7 | Generation statements |
| `keylos.consent/1` | `application/vnd.keylos.consent+json; version=1` | protocols §20.8 | Capability consent records |
| `keylos.exception/1` | `application/vnd.keylos.exception+json; version=1` | protocols §20.9 | Owner exceptions |
| `keylos.flowproof/1` | `application/vnd.keylos.flowproof+json; version=1` | protocols §20.11 | Flow proofs |
| `keylos.fsmerge/2` | (JCS JSON, digest-bound by mandates) | protocols §20.12 | Prepared merge manifests (strata, bench, gate) |
| `keylos.fsmerge/1` | (JCS JSON) | protocols §20.12 | Superseded by `keylos.fsmerge/2`; never bound by new mandates |
| `keylos.firstboot/1` | (file, disk-encrypted, digest in config) | protocols §20.13 | First-boot enrolment bundle |
| `keylos.tlogproof/1` | (JSON bundle) | protocols §20.14 | Transparency-log proof bundles |
| `keylos.compat/1` | (manifest section) | compat | Legacy image description |
| `keylos.grant/1` | `application/vnd.keylos.grant+json; version=1` | broker | Persistent grant records |
| `keylos.user/1` | `application/vnd.keylos.user+json; version=1` | hearth | User records |
| `keylos.rendered/1`, `keylos.module/1`, `keylos.drift/1`, `keylos.configlock/1` | (config-internal) | config | Config compiler formats |
| `keylos.changeset/1`, `keylos.anchor/1`, `keylos.unitfs/1` | (strata-internal) | strata | Transaction change sets, anchors, unit encryption |
| `keylos.apprelease/1`, `keylos.logs/1`, `keylos.rebuilders/1` | (TUF targets) | courier | App releases, log and rebuilder/witness lists |
| `keylos.logauth/1`, `keylos.candidates/1`, `keylos.mismatch/1` | (tlog/forge-internal) | tlog, forge | Log operator and rebuilder formats |
| `keylos.hwcert/1`, `keylos.governance/1`, `keylos.advisory/1` | (distribution documents) | keylos | Hardware certification, governance, advisories |
| `keylos.pendingreceipt/1` | `application/vnd.keylos.pendingreceipt+json; version=1` | protocols §20.22 | Receipts spooled by the recovery environment |
| `keylos.fleet.command/1`, `keylos.fleetapprovers/1` | `application/vnd.keylos.fleet.command+json; version=1`; (config file) | protocols §20.23 | Fleet commands; org approver keys |
| `keylos.fleet.attest/1` | (fleet protocol) | fleet | Attestation results |
| `keylos.cloudimage/1` | `application/vnd.keylos.cloudimage+json; version=1` | protocols §20.24 | Published cloud image records |
| `keylos.preauth/1` | (installer file) | protocols §9.5 | Input devices pre-authorized at installation |
| `keylos.ociconv/1` | (hashed JSON, unsigned) | protocols §21.4 | OCI-to-container conversion descriptor |
| `keylos.cri.uplink/1` | (JCS JSON, `NetPlumbingCluster`) | protocols §21.5 | cri network plumbing requests |
| `keylos.bench.vm/1`, `keylos.bench.snapshot/1` | (bench-internal) | bench | VM and snapshot records |
| `keylos.ledger-export/1` | (export file) | ledger | Ledger exports |
| `keylos.quorum/1` | `application/vnd.keylos.quorum+json; version=1` | protocols §20.18 | Quorum presence requests |
| `keylos.trustee/1` | (printed share cards, QR) | protocols §20.19 | Recovery-key trustee shares |
| `keylos.inheritance/1` | (encrypted note held by vouch) | protocols §20.19 | Inheritance note metadata |
| `keylos.catalog/1`, `keylos.publishers/1` | (TUF target; config file) | protocols §20.20 | App catalog; enabled publishers |
| `keylos.services/1` | (config file `/etc/keylos/services.json`) | protocols §20.16 | Service table |
| `keylos.policyref/1` | (config file `/etc/keylos/policy.ref`) | protocols §20.17 | Active policy generation |
| recovery key text | (printed) | protocols §20.21 | Recovery key encoding |
| `keylos.podspec/1` | (JCS JSON, Cedar input) | protocols §21.3 | Normalised pod admission input |
| `keylos.tpmregistry/1` | (`vectors/tpm/registry.json`) | protocols §19.6, crate `keylos-tpm-registry` | Machine-readable TPM registry: camelCase keys, indices and handles as `0x%08x` text plus numeric values, 64-bit salts as decimal strings |
| `keylos.cri.state/1` | (cri-internal) | cri | Pod and image state |
| `keylos.workflow/1` | (file `/.keylos/workflows/<name>.json` inside generations) | protocols §20.27 | Workflow definitions (explicit versioned state machines) |
| `keylos.workflow-grant/1`, `keylos.decision/1` | `application/vnd.keylos.workflow-grant+json; version=1`; (broker-internal) | broker | Workflow records and durable decision records |
| `keylos.loom.export/1` | (export file) | loom | Workflow history export for the owner |

Formats owned by a repository other than protocols MUST NOT be parsed by any other repository.

### 19.5 vsock ports (host CID 2)

| Port | Direction | Service | Profile |
|---|---|---|---|
| 1024 | guest → host | `bench` (benchd control: `HostControl` / `Guest`) | capwire-vsock |
| 1025–1535 | either | `bench` bulk streams announced in control messages | raw byte streams |
| 7002 | guest → host | `aide` `AgentHost` (forwarded by `bench-relay` for agent VMs only) | capwire-vsock |
| 7004 | guest → host | `bench-relay` `GuestPortals` (tier-2 app VMs, agent desktops; never workbenches) | capwire-vsock |

All other guest network traffic leaves through the VM's single virtio-net device, terminated on the host by `bench-net`, which maps each flow to a `ShimEndpoint.connect` call on `gate` (§7.5.12).

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

---

## 20. Shared formats

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

### 20.4 Seal window

```json
{"schema":"keylos.seal-window/1","owner":"alice","project":"/home/alice/Projects/tool","drvs":["drv:sha256:…"],
 "opened":"…","expires":"…","machine":"key:sha256:<machine key>","id":"w-…"}
```

`expires − opened ≤ 600 s`. A seal statement is accepted only if its `drv` is in `drvs` and its `sealedAt` lies inside the window.

### 20.5 Verify-before-unlock (VBU) protocol

Shared by `boot` (initrd side) and `vouch` (phone side).

**Keys.** AK0 (`0x81010003`) signs pre-unlock quotes. The phone stores AK0's public key, the EK certificate chain fingerprint, the machine key, the stream and the TUF root of the stream at pairing time.

**Flow:**

```
initrd                                   phone (vouch)
  │ QR1 = KLV1 + CBOR{1:v=1, 2:t="vbu-hello", 3:machine-key, 4:stream, 5:seq, 6:osGen}
  │──────────────── scan ─────────────────►│
  │                                         │ challenge N = 8 Crockford base32 characters (40 bits), shown; expires after 120 s
  │◄──────────── user types N ─────────────│
  │ qualifyingData = SHA-256("keylos-vbu/1" ‖ N ‖ machine-key)
  │ TPM2_Quote(AK0, sha256 PCRs 0–15, qualifyingData)
  │ QR2 = KLV1 + CBOR{1:v, 2:t="vbu-quote", 7:TPMS_ATTEST, 8:TPMT_SIGNATURE, 9:{pcr→value}, 10:event-log digest,
  │                   11:{resetCount, restartCount}, 12:UKI sha256, 13:{stream, seq}}
  │──────────────── scan ─────────────────►│ verify → VERIFIED / FIRMWARE CHANGED / NOT VERIFIED (+ reason)
  │ prompt: continue to PIN / power off / recovery
```

**Phone verification:**
1. The signature on `TPMS_ATTEST` verifies with AK0; `magic = TPM_GENERATED_VALUE`; `type = TPM_ST_ATTEST_QUOTE`; `extraData = qualifyingData` computed from the phone's own N.
2. `pcrDigest` equals SHA-256 over the reported PCR values for the quoted selection.
3. PCR11 equals the `enter-initrd` prediction for (stream, seq, profile) in a `keylos.release/1` statement the phone holds with a `keylos.tlogproof/1` proof cosigned by ≥ `witnessThreshold` witnesses.
4. PCR12 equals the release statement's `pcr12`; PCR13 is the "no extension" value; PCR15 is all zeros (not yet unlocked).
5. PCRs 0, 2, 4, 7 (and 14 in shim mode) equal an accepted firmware baseline (amber "firmware changed" when a pending firmware update was announced via `VouchLink.announce`).
6. `seq` ≥ the highest `seq` seen for this machine; `resetCount` did not increase unexpectedly.

**QR encoding:** CBOR (RFC 8949 deterministic) with the integer keys above, prefixed by the 4-byte magic `KLV1`; binary-mode QR, error correction M. Payloads over 1 000 bytes are split into a rotating sequence (400 ms) prefixed `KLV1<idx>/<total>`.

**TOTP fallback:** a 20-byte HMAC secret sealed under `PolicyPCR(0,2,4,7,11=enter-initrd)`, stored at `/efi/keylos/vbu-totp.sealed` (created by the installer's `keylos-enrol vbu-totp`); the initrd shows a 6-digit RFC 6238 code (SHA-1, 30 s).

### 20.6 Release statement (`keylos.release/1`)

DSSE-signed by `release-stream/<stream>`; it is both the TUF target for the OS update and the release-log entry.

```json
{"schema":"keylos.release/1","stream":"stable","seq":4211,"version":"1.4.2","arch":"x86_64",
 "released":"2026-10-01T12:00:00Z","floor":4150,"security":true,
 "profiles":{
   "desktop":{"osGen":"gen:fsv256:…","osDrv":"drv:sha256:…",
              "uki":{"sha256":"…","size":98304000,"ociBlob":"sha256:…"},
              "pcr11":{"enter-initrd":"sha256:…","leave-initrd":"sha256:…","sysinit":"sha256:…","ready":"sha256:…","enter-recovery":"sha256:…"},
              "pcr12":"sha256:…","pcrlock":"sha256:<pcrlock component bundle>",
              "recoveryGen":"gen:fsv256:<recovery environment generation inside the UKI>"},
   "laptop":{"…":"…"}},
 "oci":{"repository":"oci.keylos.org/os/stable","manifest":"sha256:…"},
 "installer":{"iso":"sha256:…","uki":"sha256:…"},
 "kernel":{"uname":"7.2.4-keylos1","featureLevel":"KL3"},
 "revocations":{"serial":1235,"digest":"sha256:…"},
 "rebuilders":{"required":"2-of-3","attested":["op-a","op-b","op-c"]},
 "ceremony":{"transcript":"sha256:…","holders":["key:sha256:…","key:sha256:…"]},
 "policyDefaultsDiff":"","newServices":[],"firmwareNotes":"","notes":"…"}
```

- There is no separate recovery UKI: the recovery environment is the `recovery` profile inside each profile's UKI (PCR11 phase `enter-recovery`); `recoveryGen` names the generation it runs.
- The `cloud` profile's UKI carries an additional `seed` profile (the first-boot seed stage, §20.13) whose PCR11 phase predictions are listed under `pcr11Seed` in that profile's object.
- `kmod` generations for a release's kernel are TUF targets at `kmod/<kernel-release>/<name>` in the same stream; `courier` installs those listed for the machine and roots them as `courier:kmod:<kernel-release>`.
- `seq` strictly increases per stream. `floor` ≤ `seq` is the minimum release `seq` that may still unseal; `courier` writes exactly this value to NV `0x01300102` after the release is assessed healthy, under the exact-target policy of §19.6 ("Floor writes"), and writes nothing while a pin holds the machine below it.
- Consumers: `courier` (staging), `boot` (PCR policies), `installer` (floor initialisation), `vouch` (PCR predictions), `tlog` monitors (serial and quorum rules).

### 20.7 Generation statement (`keylos.genstmt/1`)

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

### 20.8 Consent record (`keylos.consent/1`)

Signed by `service/depot` after the human approves a capability set:

```json
{"schema":"keylos.consent/1","generation":"gen:fsv256:…","name":"org.example.Editor",
 "capabilities":"sha256:<JCS digest of capability set>","approval":"a-…","mandate":"rcpt:sha256:…",
 "scope":"machine","decidedBy":"alice","time":"…"}
```

A consent record covers every later generation of the same `name` and publisher whose capability set is a subset of the consented set. Consent never makes code launchable on its own; launchability requires an authorising signature (§20.7). The broker consults consent records when minting install-time grants.

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

### 20.10 Secret delivery (`Vault.open`)

- **Primary:** a `memfd_secret(FD_CLOEXEC)` fd of the value's length plus 8, rounded up to the page size, laid out as `u64 little-endian length ‖ value ‖ zero padding`. secretmem fds are readable only through `mmap`; recipients map them `PROT_READ`, read the length, use the bytes, and zeroize and unmap on drop (`keylos-vault-client::SecretBuf`).
- **Fallback** (when `memfd_secret` is unavailable): a `memfd_create(MFD_CLOEXEC|MFD_ALLOW_SEALING|MFD_NOEXEC_SEAL)` fd with the same layout, sealed `F_SEAL_WRITE|F_SEAL_SHRINK|F_SEAL_GROW|F_SEAL_SEAL`. The receipt records `data.delivery = "memfd-sealed"`.

### 20.11 Flow proof (`keylos.flowproof/1`)

DSSE, signed by the agent session key registered with `BrokerSystem.registerSessionKey`:

```json
{"schema":"keylos.flowproof/1","session":"s-…","intent":"e-…","payloadDigest":"sha256:…",
 "runtime":"gen:fsv256:<harness runtime generation>","policy":"camel/1",
 "controlSources":[{"source":"user","label":{"conf":"private","integ":"user"}}],
 "dataSources":[{"argument":"body","source":"file:/home/…","label":{"conf":"private","integ":"user"}}],
 "claims":["control-flow-independent-of-untrusted","recipients-from-user"]}
```

It is attached to a staged intent as the arg `x-flow-proof` (base64 DSSE) and passed by `gate` to `BrokerSystem.checkFlow`. The broker accepts it instead of a prompt only if: the template's `agent.flowProof` is `"camel/1"`; the runtime is listed in the policy's `flowproof-runtimes.json`; every `controlSources[].label.integ ≤ user`; and the payload digest matches.

### 20.12 Merge manifest (`keylos.fsmerge/2`)

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

### 20.14 Transparency-log proof bundle (`keylos.tlogproof/1`)

```json
{"schema":"keylos.tlogproof/1",
 "origin":"log.keylos.org/realisations",
 "index":123456,
 "entry":"<base64 of entry bytes>",
 "checkpoint":"<full signed note text including cosignature lines>",
 "inclusion":["<base64 hash>"]}
```

Verification: verify the log signature on the checkpoint with the origin's key (TUF `logs.json`); verify ≥ `witnessThreshold` cosignatures from distinct listed witnesses; compute the RFC 6962 leaf hash of `entry` and verify inclusion at `index`; update the persisted last-seen checkpoint (consistency-checked) when online.

### 20.15 Effect renderer components

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

### 20.19 Trustee shares and inheritance

**Trustee shares** split the 32-byte recovery key secret (§20.21) into *n* shares with threshold *k* (2 ≤ k ≤ n ≤ 16) using Shamir over GF(2^8) per byte. Splitting needs presence (purpose `trustee.split`).

```json
{"schema":"keylos.trustee/1","set":"<base32 8 chars>","machine":"key:sha256:…","k":2,"n":3,"index":1,
 "share":"<base32 of 32 bytes>","check":"<first 8 hex of SHA-256(recovery secret)>","created":"…"}
```

The printed card carries this JSON as a QR (binary mode, error correction Q) and the `share` in 8-character groups. Reconstruction (recovery environment or `hearth`) verifies `check` before use. A new split invalidates nothing cryptographically; owners revoke old shares by rotating the recovery key.

**Inheritance note** (`keylos.inheritance/1`, optional): a note encrypted with HPKE to each listed trustee's public key, held by the owner's paired `vouch` phone. If the dead-man timer (`VouchLink.inheritance`) sees no owner login heartbeat for the configured number of days (≥ 30), the phone releases the encrypted note to the trustees. The note never contains a key; trustees still need *k* shares.

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

### 20.21 Recovery key

- **Secret:** 32 random bytes generated by the installer.
- **Text form:** 64 lowercase hex digits in 8 groups of 8; each group is followed by a 2-hex-digit CRC-8 (polynomial 0x07, init 0x00) of that group's 4 bytes; groups are separated by `-`: `xxxxxxxxcc-xxxxxxxxcc-…`. The CRC lets the recovery environment point at a mistyped group. Input is case-insensitive and ignores spaces.
- **LUKS2 recovery keyslot:** passphrase = the 64 hex digits without separators and CRCs; LUKS2 applies Argon2id (m = 1 GiB, t = 4, p = 4).
- **Derivations** (HKDF-SHA256 over the 32-byte secret, salt empty, info strings): `"keylos-recovery-auth/1"` (TPM recovery auth object `0x81000105`), `"keylos-lockout/1"` (TPM lockout auth), `"keylos-recovery-signer/1"` (Ed25519 seed of the owner-registry `recoverySigner`), `"keylos-escrow/1"` (optional backup-escrow wrapping key), `"keylos-recovery-recipient/1"` (X25519 private key of the **recovery recipient**; its public half is stored at `/var/lib/keylos/recovery/recipient.pub` and in the first-boot bundle, and running services encrypt recovery copies to it with HPKE (§4): the owner-hierarchy auth and vault `recovery` slots), `"keylos-sb-pk/1"` (seed of the owner Secure Boot **PK**: an RSA-2048 key generated deterministically with HMAC-DRBG-SHA256 seeded by this output, per FIPS 186-5 appendix B.3.3, so the recovery environment can re-create it to sign KEK updates; the PK is never stored).
- `hearth`, `boot`, `installer` and the trustee tooling MUST use exactly this format.

### 20.22 Pending receipts (`keylos.pendingreceipt/1`)

The recovery environment (`rescue`, installer repository) cannot reach `ledger`. It writes each receipt it owes as `/var/lib/keylos/recovery/pending/<ULID>.dsse`:

```json
{"schema":"keylos.pendingreceipt/1","event":"key.enroll","onBehalfOf":"rescue","time":"…","bootId":"<recovery boot id>",
 "seq":1,"subject":"shell@alice/s-…","data":{},"label":null,"attested":true}
```

- `event` MUST be recovery-replayable (§19.3).
- Signed with the owner-registry `recoverySigner` (§20.21) when the recovery key was entered in that session (`attested: true`); otherwise (for example a fleet wipe completed with a quorum envelope) unsigned and `attested: false`.
- At the next normal boot `ledger` verifies each file, appends a receipt with `writer = service:ledger`, `data.onBehalfOf`, `data.attested` and `data.pendingSeq`, then deletes the file. Files with an invalid signature are kept, reported by `ledger.alarm`, and never appended.

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

### 20.24 Cloud image records (`keylos.cloudimage/1`)

DSSE-signed by `release-stream/<stream>`, published as TUF targets `cloud/<provider>/<region>/<seq>.json` and logged in the release log next to the release statement:

```json
{"schema":"keylos.cloudimage/1","stream":"stable","seq":4211,"provider":"aws","region":"eu-central-1",
 "imageId":"ami-…","arch":"x86_64","osGen":"gen:fsv256:…","ukiSha256":"…","published":"…"}
```

`fleet` uses these records to check that a cloud node booted a published image before attesting it.

### 20.25 Durable execution

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

### 20.26 Effect executor contract

Every workflow effect is a **durable effect record** in `gate` (`DurableEffects`, §7.5.25), owned by its workflow and identified by its effect ID, independent of the attempt sessions that prepare, authorize or observe it. Ordinary intents (§7.3.7) keep their own rules; a durable effect is also an outbox intent (`EffectRecord.intent`) and appears in `Gate.intents` of the preparing session.

**States.** `prepared` → (`awaitingApproval` →) `authorized` → `dispatching` → `succeeded` | `failed` | `outcomeUnknown`; `prepared` and `awaitingApproval` → `cancelled`; `succeeded` → `compensated` (compensable kinds). `authorized` means only that the effect may be performed now: it is recorded by `effect.commit` and is never reported as completion. Only `succeeded` and `failed` are confirmed outcomes (receipt `effect.complete`); `outcomeUnknown` (receipt `effect.unknown`) is an explicit state, not a failure. For caller-executed kinds (§14.2) gate moves the record to `authorized` and returns the mandate; the executor's own completion receipt, presented through `DurableEffects.complete`, is the authenticated outcome that moves it to `succeeded` or `failed`.

**Request digest.** `requestDigest` = SHA-256 of the JCS `{"effect", "workflow", "kind", "class", "target", "args": [{"name", "value", "source", "label": {"conf", "integ"}}…] (sorted by name, without `x-subject-token`), "payloadDigest", "compensator"}` (class and label values as their enumerant names; `compensator` `null` when empty). It binds the effect ID to exactly one request: `prepare` with an existing effect ID and an equal digest returns the existing record; with another digest it fails `kl:conflict`, so a payload can never change under an existing effect ID. The mandate binds the payload digest (§14.4) and `constraints.workflow` the workflow.

**Authorization at commit.** `DurableEffects.commit` (facet `loom`) requires the binding to be the workflow's current claim, then calls `BrokerWorkflow.authorizeEffect` with the record's kind, target, payload digest and gate's required renderings. The broker revalidates the workflow record (not cancelled, not past its horizon), the owner's eligibility, current policy and revocation, the Rule of Two with the workflow label, and the budget; it answers approved (no approval needed) or with the durable decision of key `effect:<fx-…>`. The record waits in `awaitingApproval` (`decision`) until the decision is approved; loom observes the decision only through `commit` and re-issues `DurableEffects.commit` with its current claim at its poll interval (and with a fresh claim after a restart) while the record waits (gate answers from its record, the broker returns the existing decision; `DurableEffects.watch` is optional). A denied or expired decision, or a policy denial by `authorizeEffect`, moves the record to `cancelled` with outcome `{"reason": "decision-denied" | "decision-expired" | "policy-denied"}`, which loom reports as the commit outcome `denied`; any other `cancelled` record is the commit outcome `cancelled`. Once the decision is approved, gate verifies the delivered mandate (§14.4, `constraints.workflow`, payload digest, expiry) and consumes it: the transition to `authorized`, the mandate's single use and the effect ID are committed atomically, so a decision is consumed at most once and an effect ID is authorized at most once.

**Retry strategies.** Every executor declares exactly one strategy for every (kind, target) it executes; gate records it at `prepare` and never changes it for an existing record. A missing or unverifiable declaration is `noSafeRetry`.

| Strategy | Requirement on the executor | After a crash or a lost reply in `dispatching` |
|---|---|---|
| `transactional` | The operation and its completion record commit atomically inside the executing service, keyed by a stable ID (for `fs.merge`: the prepared merge and its `PreparedMerge.status`, `BenchMerge.commitPrepared`) | Look up the completion record: present → its outcome; absent → the operation did not happen and may be dispatched again under the same effect ID |
| `downstreamIdempotency` | The destination enforces the effect ID as key together with payload identity for a documented window W; gate's configuration MUST declare that destination `verified` with W. Sending an `Idempotency-Key` header alone is not proof | Re-send with the same key while now < `dedupUntil` (first dispatch + W); afterwards → `outcomeUnknown`, never a blind repeat |
| `reconciliation` | A registered reconciler queries authoritative destination state by the effect ID or the payload digest (for example the remote ref equals the pushed commit); a view that is only eventually consistent, or absence from a sent folder, is never proof of non-execution | `present` → `succeeded`; authoritative `absent` → may dispatch again; anything else → `outcomeUnknown` |
| `noSafeRetry` | none | → `outcomeUnknown` |

Retries reuse the effect ID; a retry never happens after the record left `dispatching` for a confirmed outcome, and a record in `outcomeUnknown` is never dispatched again automatically, whatever the strategy, after its window expired.

**Resolving an unknown outcome.** `outcomeUnknown` ends only by reconciliation (`DurableEffects.reconcile`) or by the owner (`Workflow.resolve` → `DurableEffects.resolve` with a `workflow.decide` mandate bound to the record; presence for irreversible kinds). The resolution mandate's effect is `{"kind": "workflow.decide", "target": "<fx-…>", "digest": "sha256:" + SHA-256(JCS({"effect": "<fx-…>", "outcome": "succeeded" | "failed"}))}`. The owner's resolution records `succeeded` or `failed`; it never re-dispatches the effect ID. Repeating the operation needs a new step occurrence and therefore a new effect ID, with its own authorization.

**Cancellation and compensation.** `DurableEffects.cancel` cancels a `prepared` or `awaitingApproval` record (and its pending decision); from `authorized` on the record cannot be cancelled and its outcome is settled as above. Compensation of a succeeded effect is `Intent.compensate` for its intent where a compensator is registered, or a new effect with its own effect ID; neither is a rollback guarantee.

**Dedup retention.** Retention is part of correctness. gate keeps every record (effect ID, workflow, request and payload digests, strategy, state, outcome, receipts, `dedupUntil`) at least until the latest of: the workflow's horizon (from the broker's record), `dedupUntil`, and 30 days after the record reached a terminal state; a record that is not terminal is never deleted. Payload blobs are kept until the record is terminal plus 7 days, or until the workflow is forgotten (`DurableEffects.forget`), which shreds them and keeps the minimal record. A workflow never runs past its horizon (the broker refuses its claims), so no workflow can re-request an effect ID whose record was deleted.

**Executors behind gate.** gate's kind registry declares the strategy per executor: `BenchMerge.commitPrepared` (`fs.merge`) is `transactional`; HTTP replay is `downstreamIdempotency` only for destinations configured as `verified`, otherwise `reconciliation` where a reconciler is registered (`git.push`: the remote ref; `git.pr.open`: a search by head branch and the effect ID in the body), otherwise `noSafeRetry`; SMTP is `reconciliation` only with an IMAP rule whose provider is configured as strongly consistent, otherwise `noSafeRetry`; `net.listen` is `transactional`; caller-executed kinds are `noSafeRetry` unless the executor documents a completion lookup.

### 20.27 Workflow definitions (`keylos.workflow/1`)

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

---

## 21. Cluster nodes (CRI)

### 21.1 Boundary

- The `server-k8s` profile runs upstream `kubelet` and `kube-proxy` (sealed generations built by `forge`, packaged in `pkgs`) and the keylos `cri` service.
- `kubelet` reaches `cri` only through the route `cri#kubelet`: `warden` creates an `AF_UNIX` `SOCK_STREAM` socket pair and passes `kubelet` its end as `--container-runtime-endpoint=unix:///run/keylos/cri/cri.sock` (a path inside kubelet's view bound to that socket). This is the only non-capwire IPC in keylos (§7.1).
- `cri` implements CRI v1 (`runtime.v1.RuntimeService`, `runtime.v1.ImageService`) for the three most recent Kubernetes minor versions at release time.
- `kubelet` runs as a tier-1 service without root and without capabilities, in the cri network namespace (`services.json` `network: "cluster"`). It holds: the `cri#kubelet` route; the cgroup subtree `/keylos.slice/kube.slice` (delegated to `cri`, read-only to kubelet for stats); its state directory `/var/lib/keylos/cri/kubelet` (written by `cri`: certificates, kubeconfig). Volume mounts, networking and image handling are done by `cri`, never by kubelet.
- **Mount-free kubelet.** `pkgs` builds kubelet with the `keylos-mountless` patch set, which is part of this contract: kubelet never calls `mount`/`umount` (they are denied by seccomp anyway). Its volume plugins write configMap, secret, projected and downwardAPI contents into plain directories under `/var/lib/keylos/cri/kubelet/pods/<uid>/volumes/`, and every mount, unmount, and device-attach step is a no-op; `cri` turns those directories into `PodMount` trees (`tmpfsBytes > 0` for secret-bearing types, §7.5.1) or VM shares, and handles emptyDir, local, NFS/iSCSI/RBD and CSI volumes itself (§21.6).
- `kube-proxy` runs in nftables mode inside the `cri` network namespace with `CAP_NET_ADMIN` there only.

### 21.2 Runtime classes

| RuntimeClass | Isolation | Images | Notes |
|---|---|---|---|
| `keylos-vm` (default) | One `bench` microVM per pod sandbox (`VmSpec.purpose = pod`); containers run inside the guest under `youki` driven by `benchd` | Any OCI image, pulled by `cri` into `/var/lib/keylos/cri/images` (via `gate` when `cluster.egressViaGate`), shared read-only into the VM | VM principal `pod:<ns>/<name>:oci:sha256:<first image>@_cluster/…`; GPU only by passthrough |
| `keylos-sealed` | t1 principals spawned by `warden` through `PodSpawn` (§7.5.1) | Only `container` generations (§6.1) with a generation statement signed by an `org-publisher` key enabled on the machine | One principal per container; seccomp `runtime-default`; no added capabilities ever |

### 21.3 Admission

`RunPodSandbox` carries no container configs, so `cri` admits against the **API server's Pod object** (read with its cluster credential, matched by pod UID); it normalises the Pod into `keylos.podspec/1` (the attributes of the Cedar `PodSpec` entity, §16.1, as JCS JSON) and calls `BrokerSystem.admitPod`. The broker evaluates action `admit` with principal `service:kubelet`. A denial makes `RunPodSandbox` fail with gRPC `PermissionDenied` and the reasons; an `@tier`/`@orgApproval` permit makes `cri` hold the sandbox in `pending-approval` until the approval resolves. `CreateContainer` re-admits when the container config adds anything the admitted Pod object did not contain (image, capability, mount, device). Receipts `pod.admit`/`pod.deny` (cri).

### 21.4 Images

- `keylos-vm`: OCI images are pulled by `cri` with digest pinning; tags are resolved once and recorded. They are never executed on the host (`noexec` store) and never registered with `kl-exec`.
- `keylos-sealed`: `cri` calls `Depot.install("oci+container://<registry>/<repo>@sha256:<manifest>")` (facet `cri`). `depot` converts the image with **`oci-convert/1`** into a `container` generation and makes it launchable only if a `keylos.genstmt/1` for that generation digest, signed by an enabled `org-publisher` key, is available from the org TUF repository (`courier`). `cri` roots the generation as `cri:pod:<pod-id>` before `PodSpawn`; `depot` mounts container generations only while so rooted.
- **`oci-convert/1`** (normative; implemented only by crate `keylos-oci-convert`, §18): layers applied in manifest order; OCI whiteouts (`.wh.<name>`) and opaque markers (`.wh..wh..opq`) resolved; hardlinks kept; device nodes, sockets and FIFOs dropped (the runtime provides `/dev`); numeric uid/gid and mode bits kept; setuid/setgid bits cleared; `security.capability` and all `security.*`/`trusted.*` xattrs dropped (no file capabilities, ever); `user.*` xattrs kept; timestamps zeroed; entries sorted by path bytes; the result is built into a composefs generation exactly as `depot` builds any generation, with `/.keylos/manifest.json` of kind `container` whose `container` section copies the OCI config.
- **Identity** of a converted generation: `name` = `oci.` + the registry host's labels reversed + `.` + the repository path segments, joined by `.`, with every character outside `[a-z0-9-]` replaced by `-`; `version` = `0.0.0+oci.<first 16 hex digits of the manifest digest>`; `derivation` (and the genstmt `drv`) = `drv:sha256:<SHA-256 of the JCS bytes of the conversion descriptor>`, where the descriptor is `{"schema":"keylos.ociconv/1","algorithm":"oci-convert/1","image":"oci:sha256:<manifest>","platform":"linux/amd64","config":"sha256:<config blob>","layers":["sha256:…"]}`. For kind `container`, `drv` names this descriptor, not a `keylos.drv/1` derivation. `layers` lists the **compressed layer blob digests exactly as they appear in the image manifest, in manifest order** (not uncompressed `diff_id`s); `platform` is the platform selected from an image index (or the manifest's config platform).

### 21.5 Networking

- `net` creates the **cri network namespace** at its own start on `server-k8s` (veth uplink to the host, bridge `kl-cri0`), from config `cluster.*`. `warden` obtains it with `NetPlumbingCluster.clusterNetns` and starts `crid`, `kubelet` and `kube-proxy` in it. `cri` configures it dynamically with `clusterUplink` (the pod CIDR assigned through the Node object, NAT, overlay) and obtains per-pod network namespaces from `net` with op `podNetns`. This is the single exception to "only `warden` creates namespaces" (§9.1): network namespaces only.
- **`keylos.cri.uplink/1`** (JCS JSON passed to `clusterUplink`):
  - `{"schema":"keylos.cri.uplink/1","op":"uplink","podCidr":"10.244.3.0/24","clusterCidrs":["10.244.0.0/16"],"serviceCidr":"10.96.0.0/12","mtu":1450,"nat":true,"overlay":{"mode":"none" | "vxlan","vni":4242,"peers":[{"node":"…","ip":"…","podCidr":"…"}]}}` → returns the cri namespace;
  - `{"schema":"keylos.cri.uplink/1","op":"podNetns","podId":"pod-…","ip":"10.244.3.17","mac":"…","mtu":1450}` → returns a new pod namespace with a veth attached to `kl-cri0`;
  - `{"schema":"keylos.cri.uplink/1","op":"release","podId":"pod-…"}` → deletes it (returns no fd: `Fd.index` 0xFFFF).
- Pod VMs attach a **tap** device to a bridge inside the cri namespace. This is the only use of tap devices in keylos; workbench and tier-2 VMs never get one. Sealed pods get a veth pair into the same bridge.
- IPAM is host-local per pod CIDR; cross-node connectivity is direct routing or a VXLAN overlay configured by `cri`. Third-party CNI plugins are not supported; eBPF-based CNIs are not supported on the host.
- NetworkPolicy objects (watched by `cri` through the node's credential) are compiled to nftables in the cri namespace.
- With `cluster.egressViaGate = true`, pod egress to addresses outside the cluster CIDRs is redirected to a per-pod `gate` shim endpoint (`PodSpawn.egressShim`, §7.5.1; `keylos-vm` pods use their VM's `bench-net`) and is subject to gate policy. The broker attaches the pod principals' tokens at `registerSession` from policy `cluster.egress`.

### 21.6 Storage

- `emptyDir` and local PersistentVolumes are `strata` subvolumes (`StrataVolumes`, §7.5.7); `configMap`, `secret`, `projected` and `downwardAPI` volumes are tmpfs filled by `cri` (Kubernetes secrets arrive from the API server and are never stored in `vault`).
- NFS, iSCSI and RBD volumes are mounted **inside pod VMs only** (`keylos-vm`).
- CSI drivers are supported only as `container` generations declaring `needs.csi`; their node plugins run in a pod VM, and block devices reach them through `MediaAttach.claimBlock` (devd facet `cri`).
- `hostPath` is denied by default policy except a read-only allowlist.

### 21.7 Node attestation and credentials

- Before kubelet starts, `cri` performs `FleetCluster.joinAttested` with an AK quote (and a confidential-VM report on `cvm`); `fleet` verifies it against the release log. Only then does `cri` obtain kubelet client certificates (`FleetCluster.kubeletCertificate`) and write the kubelet kubeconfig.
- Certificates are renewed by `cri` before expiry; a failed re-attestation (for example after an unapproved firmware change) stops renewal and the node drops out of the cluster when its certificate expires.

### 21.8 Not supported

Privileged pods; `hostNetwork`, `hostPID`, `hostIPC`; added Linux capabilities; DaemonSets that need host access (node agents ship as sealed tier-0 services instead); Windows containers; GPU sharing other than whole-device passthrough into pod VMs; a writable container root filesystem in `keylos-sealed` pods (the root is read-only, with tmpfs at `/tmp`, `/run`, `/var/tmp` and `/dev/shm`, because a writable overlay would be an unregistered superblock from which nothing could execute; use `keylos-vm` for images that write to their root).

---

## 22. Normative clarifications (implementation rounds S1, S2 and S3)

These rules were fixed while implementing the protocols crates (§22.1–§22.5), the S2 authority-core daemons (§22.6) and the S3 execution core (§22.7). Each refines the section it names; where a section already states a rule in place, this list does not repeat it.

### 22.1 Identifiers (§3)

- Guest usernames are `guest-` + 8 characters of **lowercase Crockford base32** (`0-9a-z` without `i l o u`); any other `guest-…` username is invalid. `_system` and `_cluster` are not usernames, only human values.
- Principal chains never repeat a session; every actor kind, including `kernel`, has at least one session. Only pod actors are bound to `_cluster`.
- Pod actor parsing splits at the first `/` and the first `:` after it; pod images are `oci:sha256:` or `gen:` refs.
- ULID-based IDs use only the canonical uppercase form; ULID generators increment the random part within one millisecond and when the clock moves backwards, and fail only on 80-bit overflow.
- Device IDs: subsystem `[a-z0-9_-]+`, stable path non-empty printable ASCII without whitespace.
- Document timestamps: `YYYY-MM-DDTHH:MM:SS[.d{1,9}]Z` with uppercase `T`/`Z`, no `:60`, within the Int64-nanosecond range (1677–2262); trailing fraction zeros are accepted and never re-normalised.
- fs-verity digests follow the kernel's `fsverity_descriptor` (version 1, SHA-256, `log_blocksize` 12, no salt, 256-byte descriptor, all-zero root for empty files); conformance vectors are checked against the kernel's `FS_IOC_MEASURE_VERITY`.

### 22.2 Signed documents and formats (§5, §6, §11, §12, §15, §20, §21)

- JCS: integers beyond ±2^53 are non-canonical; duplicate member names are rejected; ECMAScript's tie-to-even shortest-digit rule applies.
- A missing nullable member equals `null`.
- Manifests: `bench-image` requires `entrypoints`. `tier` is optional for app-like kinds and forbidden for `bench-image`, `agent-template`, `part`, `container`, `kmod`; `tier: 0` only for kind `service`. `needs.gpu: "passthrough"` requires `tier: 2` or kind `container`. `needs.devices`, `needs.spawn` and `provides.agentTools` are opaque JSON compared structurally (JCS). `needs.services` entries may be `service#facet`. `webapp.origin` is `https://host[:port]` without a path. MCP `trust` uses the integrity label names.
- **Capability diff** (§6.3): privilege order `2 < 1 < L < 0`; booleans turning on widen; GPU `none < display < render < passthrough`; network widens per (host, port, proto, method) tuple not covered by the old grant (absent `methods` = all); listen widens unless the same port/proto with an equal or wider scope existed; new devices, services, secrets (by name), data units and spawn targets widen; any change of `labels` or `csi` widens; a new effect kind or a changed class widens; a new provided service or workflow widens; `why` and `x-` members never widen; `portalIsland` false→true widens. The **capability set** hashed for consent is the JCS of `{"effects","needs","provides":{"services","workflows"},"tier"}` with absent members as `[]`/`{}`/`null`, except that `provides.workflows` is included only when non-empty (so capability sets of generations without workflows are unchanged).
- cmdsig composite types: `list<T>`, `record{name: T, …}`, `enum[a, b]` with lowercase identifiers; `effects[]` are kind strings or `{kind}`; exit keys `"0"`–`"255"`; `access` is required exactly for `file`/`dir` (and lists of them); only the last argument may be variadic; `records` output needs a schema. `KEYLOS_PIPE_*` takes only `cbor-seq`; `KEYLOS_ARGFD_*` fds must be in `SpawnSpec.fds`.
- Generation authorisation by key class: `os`, `service` and `kmod` only by release-stream keys; `config` and `policy` only through `keylos.configgen/1`; every other kind by release-stream, enabled-publisher or owner-seal keys. A release-stream statement's optional `stream` must equal the trust set's stream.
- Revocation (§11.7): a revoked key's signature counts only if `now < after`, or if the statement was issued before `after` and the realisation quorum is met. `warn` entries never block.
- Boot trust set: every listed key has exactly one matching `spki` entry; owner-seal keys are P-256. Boot report: `profile` ∈ {`default`, `recovery`, `seed`} ∪ machine profiles; `unlock` ∈ {`tpm2+pin`, `tpm2`, `recovery`}; `volumeIdentity` ∈ {`ok`, `mismatch`}; Secure Boot off ⇒ `degraded`; shim ⇒ `shim` or `degraded`; `iommu: none` ⇒ `degraded`; `none-virtual` ⇒ a cloud integrity profile.
- Release statements: profile keys are machine profiles; `pcr11` has exactly the five §19.6 phases; `pcr11Seed` is present exactly for `cloud`; `uki.sha256` is bare hex; `rebuilders.required` is `k-of-n`. Unseal is allowed iff `seq ≥ NV floor`; successors need strictly increasing `seq` and non-decreasing `floor`; the floor written is exactly the release's `floor`, and only when the current value does not exceed it (§19.6).
- Generation statements remove duplicate object digests (sorted unique list). Config generations: `sourceRev` is `git:sha1:<40 hex>` or `sha256:<64 hex>`; the first `parent` is `null`; `approvedBy` is a username or `quorum`; selection takes the highest counter ≥ the NV counter.
- Seals and windows: `opened ≤ sealedAt ≤ expires` inclusive; `0 < expires − opened ≤ 600 s`.
- Mandates: `channel: quorum` ⇔ `decidedBy: "quorum"`; `phone` and `org` never carry `presence: true`; `constraints.localDecision` only with `org`; `maxAmount` is `null`, an integer or a string.
- Consent and exceptions: `scope` ∈ {`machine`, `user`}; consent covers a candidate with the same name and publisher and no widening; `fleet-receipt-access` exceptions have null `name`/`publisher`/`generation` and a non-empty registered `events` list; `expires > time`.
- fsmerge/1: kinds `added`/`modified`/`deleted`; `mode` (4 octal digits) and `size` required except for `deleted`; normalised relative paths sorted by bytes without duplicates. fsmerge/2 rules are in §20.12.
- First-boot bundles carry exactly one of `owner` (interactive) or `owners` + `config` (cloud seed); `keepMicrosoftCAs` with owner mode implies `shared-boot`; seal gates `0x01300140`–`0x0130014f`; owner UID 1000–59999.
- tlogproof: the log key's note name equals the bundle `origin`; cosignatures follow C2SP tlog-cosignature v1; duplicate witness lines count once.
- services.json: `tier` 0 or 1; `uid` only `dynamic`; `restart` ∈ {`on-failure`, `always`, `never`}; BPF objects directly under `/usr/lib/keylos/bpf/<service>/`.
- Quorum requests (§20.18): `payloadDigest` is SHA-256 of the PAE; `threshold ≤ len(approvers)`; the key chain's `ledger.key.register` receipt must carry the request machine key's countersignature.
- Trustee shares (§20.19): GF(2^8) with polynomial 0x11B; the secret at x = 0 and share *i* at x = *i*; `set` is 8 uppercase Crockford characters (40 bits), `share` 52 uppercase Crockford characters, `check` the first 8 hex digits of SHA-256(secret).
- Recovery key text (§20.21): `-` separators optional on input, spaces ignored, case-insensitive; CRC-8 is poly 0x07, init 0, unreflected, no final XOR (CRC-8/SMBUS).
- Pending receipts (§20.22): "unsigned" is a DSSE envelope with an empty `signatures` array; `attested: false` with signatures is invalid; `seq` starts at 1.
- Fleet approvers (§20.23): `alg` ∈ {`fido2-es256`, `fido2-eddsa`, `ed25519`, `ecdsa-p256-sha256`} matching the key; `0 < expires − issued ≤ 24 h`; FIDO2 approvers need UP and UV.
- Publishers need a key or a Sigstore identity (https issuer); catalog `quorum` is `k/n`; URLs are https; `unreviewed` implies tier floor 2.
- `keylos.preauth/1` device classes: `hid`, `audio`, `fido`, `video`, `net`, `mass-storage`, `printer`, `smartcard`, `bluetooth`, `hub`, `serial`; every pre-authorised device includes `hid`.
- `boot.wipe` details are exactly `{command, commandDigest}` with a valid `wipe` command.
- `keylos.owners/1` export: `head` is lowercase hex of the 104-byte NV head; `entries` are envelope objects whose JCS is the log line.
- podspec (§21.3): sets are sorted, duplicate-free arrays; `allImagesSealed` equals "every image is `gen:`"; `hostPathsReadOnly` is `true` when there are no host paths; hostPaths are allowed only when every host path is in the allowlist **and** `hostPathsReadOnly`.
- OCI-converted names (§21.4): the registry port stays part of the host (`:` → `-`); uppercase letters become `-` (no lowercasing).
- Uplink (§21.5): MTU 576–9216; CIDRs without host bits; VNI 1–2^24−1 required for `vxlan` and absent for `none`; members unused by the op are rejected.
- Confinement report (§9.4): `tier` ∈ {`t0`…`t3`, `tL`}; Landlock ABI ≥ 7/9/10 for KL1/KL2/KL3; `userns` only for `tL`; KL1/KL2 reports with a private netns record `udp-via-netns`.

### 22.3 Presence and owner registry (§5.3, §5.4, §20.3)

- Payloads without a `time` (mandates) are checked against the verifier's trusted time; seal windows use `opened`. A credential is valid at *T* iff `enrolled ≤ T < removed`; a removed owner's credentials are removed.
- The CBOR `credentialId` must equal the registered credential ID; the signature `alg` must match the credential's COSE algorithm; non-FIDO2 signatures never count as presence. `signCount` must increase unless it is 0.
- `uv_required` may be waived by policy only for purposes marked "per policy" (`mandate`, `grant.persist`).
- The presence payload is validated as its typed document; for `keylos.presence/1` the inner `purpose` must equal the requested purpose.
- Quorum envelopes are counted against the registry's **current** threshold (a back-dated payload cannot use an older, lower threshold).
- Owner registry: genesis is `seq` 0 with `prev: null`, presence-signed by its own credential, with `quorum = threshold = 1`; every entry carries at most one `credential`; entry times never decrease; a key ID is never enrolled twice; an owner has **at most one** seal credential (rotation = remove the old seal credential, then enrol a fresh credential with `seal: true`; an enrolled credential is never re-marked as the seal credential); the last credential of an owner and the last owner cannot be removed; `ownerIndex` is unique among active owners; `quorum` and `threshold` never exceed the owner count; `policy` changes only through `set-quorum` or `recover`; `recover` may enrol a credential for an existing owner, replace `recoverySigner` and set `policy`. NV-head key set = JCS of the sorted active credential key IDs; certificate set = JCS of the sorted base64 DER certificates.

### 22.4 Labels, effects and tokens (§8, §14)

- Socket (connection) labels have confidentiality `public`.
- Property X counts every `net` capability to a host not marked `sink-safe`, including listening grants.
- A session already holding U, P and X is a violation that cannot be approved; a request that would supply the third property is a declassification (T3).
- A malformed `security.bpf.keylos.label` xattr is an error, never replaced by the location default.
- Unregistered `x-` effect kinds (`x-` + `[a-z0-9._-]+`) default to irreversible. Effect classes map to tiers reversible → T1, compensable → T2, irreversible → T3.
- `@orgApproval` on a headless, fleet-enrolled machine is decided remotely; on headless machines that are not fleet-enrolled every T2+ approval becomes a quorum request.

### 22.5 TPM registry (§19.6)

- `vault-epoch/0` and `vault-epoch/1` are NO_DA with an empty authPolicy (reads and writes by authValue only; defined by hearth through `HearthTpm.defineSpace`); `attestation-key-names` is written once with owner authorization at enrolment and then write-locked (`WRITEDEFINE` + `NV_WriteLock`).
- AUTHWRITE indices' authPolicy is the `PolicyCommandCode(NV_Read)` branch alone.
- `owner-seal/i` handles `0x81000140 + i` use the same bound `i < 16` as seal gates.
- Staging handles `0x81000180`–`0x81000183` hold RSA-2048 KEK/db signers; the fleet device key is ECC P-256 sign-only under the owner hierarchy; the strata anchor HMAC key uses SHA-256.
- In the recovery profile `enter-recovery` takes the position of `leave-initrd`, and `sysinit`/`ready` are never extended.

### 22.6 Implementation round S2 (ledger, vault, hearth, broker, warden)

- **Receipts (§13).** Every receipt names a non-empty `subject`. Writer and ledger signatures follow §13.1 (writer first, no `scope`). Replayed pending receipts (§20.22) carry the component name from `keylos.pendingreceipt/1` as top-level `onBehalfOf`. A receipt whose unit key is gone is reported by vault as `kl:revoked`; the ledger records every unit it shredded and never asks for its key again.
- **Ledger time and order (§13.1).** The `re-sign` refusal is `kl:invalid`; writers retry with a fresh `time`. Clean shutdown publishes a checkpoint carrying the incremented counter value, so a ledger restarted on its own is not mistaken for a rollback.
- **Mandates (§14.4).** Mandate-only kinds and `constraints.channels` per §14.2/§14.4; `x-` members of any keylos document never authorize anything.
- **TPM (§19.6).** Sealed secrets use the one object template and policy of §19.6 ("Sealed secrets"); services that need an NV index after genesis use `HearthTpm.defineSpace`; the TPM is handed to services as `KEYLOS_TPM_FD`; development TPMs are reached only through `KEYLOS_DEV_TPM_TCTI` in development builds.
- **Development builds (§10.5).** Every development-only knob of every component is a `KEYLOS_DEV_*` variable or an `x-` member of that component's own configuration; production builds ignore both for security decisions.
- **capwire (§7.1).** `OutFds` anchors on the first `Fd` written when the anchor struct has no data section (keylos-capwire SPEC-NOTES item 21); `ENOBUFS`/`ENOMEM` on send are retried for up to 1 s.
- **Receipt before reply (§17 INV-7).** A component answers `kl:unavailable` while it cannot write a receipt it must write before replying (for example before its own `ledger.key.register`).
- **Vault slots (§7.5.4)** and **hearth enrolment (§7.3.12)** per the prose after those schemas; `assist` prompt ids per §7.3.12.
- **Tokens (§8.2).** `model` facts are ground facts written in the block; a token whose rules derive `model` is invalid.
- **Approval IDs (§3.5).** hearth-minted `a-` IDs appear only in hearth's own mandates and receipts.

### 22.7 Implementation round S3 (warden, boot, journal, loom)

The code-integrity changes of this round (§9.3 hook rows, numeric values, links, `ptrace` without exemptions, supervision without ptrace access), the xattr names of §10.4, the seccomp profile names of §9.1/§9.4 and the durable-execution rules of §20.25–§20.27 are stated in place. In addition:

- **Service children (§7.3.2, §19.2).** `Supervisor.spawn` with `actorKind = service` is accepted only on `warden#service`, only from a tier-0 service, and only for an entrypoint of the caller's **own** generation (for example `journal`'s unwinder); otherwise `kl:denied`. The child is the principal `service:<svc>:<gen>@_system/<caller chain>/<new session>`, tier t0, with seccomp profile `baseline-1` and none of the service's `services.json` privileges, no routes other than those its parent passes as fds, and `onRevoke kill`.
- **Unit keys of forgotten units (§7.3.6).** `Vault.dataKey`/`open` of a forgotten unit answers `kl:revoked` (the name stays tombstoned, §22.6); consumers treat it as "unit gone", delete what the unit encrypted and drop later data for it. `kl:not-found` means a unit that never existed.
- **Ledger filter (§7.3.5).** `Filter.principalPrefix` matches a receipt whose `subject` **or** `writer` starts with the prefix. A writer that reconciles its own submissions (loom, broker, gate; §20.25) additionally checks that `writer` is itself.
- **Workflow history (§7.3.16).** `Workflow.history` returns one `WorkflowEvent` per `workflow.*` receipt, with `seq` = the receipt's `n`: `workflow.claim` → `attempt`, `workflow.step` → `step`, `workflow.enroll` → `decision`, the status events → `status`, `workflow.resolve` → `effect`, any other → `note`. Status changes that write no receipt (for example `running`) appear in no history event.
- **Watchdog (§7.5.1).** `Bootstrap.watchdog` proves that the service's event loop runs. A host library MAY call it from that loop; a service whose liveness means more calls it from its work path and its host library MUST then not call it on its own.
- **Mandate drafts (§14.4).** A broker's mandate draft leaves `decidedBy` and `channel` for the trusted path to fill and is not a valid `keylos.mandate/1` until decided (E2); a reviewer's fail-closed check reads the draft's `effects[]` only and validates the decided mandate in full before signing.
- **Session registration retries (§7.5.2).** `registerSession` answering `kl:unavailable` (INV-7) is retried by `warden` for the services and boot-time principals it starts (up to 120 s) and for `Supervisor.spawn` callers (up to 10 s) before the spawn fails `kl:unavailable`.
- **Repo-local CLI interfaces (§1).** A component MAY serve a repo-local interface for its own CLI through `Extensible.ext` on its own facets (as `VaultCli`, `LoomAdmin`, `JournalCli`); it is listed in that repository's spec, uses a `capnp id` outside the reserved range and is consumed by no other repository.

---

## Appendix A. Change log from the draft

| # | Change | Reason (originating conflict) |
|---|---|---|
| A1 | §9.3 rewritten: host exec integrity is enforced by the `kl-exec` BPF LSM keyed by verified composefs superblocks plus a boot trust set; IPE kept for initramfs and kexec; no `.ipe` keyring | IPE has no keyring and cannot express "reached through a verified composefs mount" (boot, warden, depot) |
| A2 | Removed per-file fs-verity builtin signatures and P-256 `*/fsverity` keys; generation signatures verified in userspace (§4, §20.7) | Kernel cannot verify Ed25519; per-object signatures impractical (depot vs boot) |
| A3 | TPM NV indices moved to the owner range block `0x01300100–0x013001FF`, with one registry (§19.6); persistent handles moved to TCG hierarchy ranges | Draft used the TCG-reserved `0x01C1xxxx` range; F1, F2, F5, F8 assigned overlapping indices |
| A4 | Owner-seal keys: per-owner TPM keys with `PolicySecret` on an `hmac-secret`-rotated NV seal gate (§11.6) | FIDO2 assertions cannot satisfy `PolicySigned` (hearth vs installer vs depot) |
| A5 | Presence signatures `fido2-es256` / `fido2-eddsa` with rpId `keylos.owner` (§4, §5.3) | FIDO2 cannot sign arbitrary payloads (hearth) |
| A6 | `Vault.open` delivery: mmap-only, u64-length-prefixed secretmem; sealed memfd fallback (§20.10) | secretmem fds cannot be sealed or read(2) (vault) |
| A7 | Ledger NV counter cadence: ≤ once per 900 s plus security events; counter in each checkpoint note (§13.3) | Counters cannot store hashes; 60 s increments wear NV (ledger) |
| A8 | Receipt submitted-form rule (§13.1) | Writer signatures broke when ledger filled `seq`/`prev` (ledger) |
| A9 | `courier` is the only TUF client; `CourierResolver`; `oci://…#gen=` source form (§7.3.8, §7.5.6) | depot and courier both specified TUF clients |
| A10 | Workbench connectivity: single virtio-net via `bench-net` → `gate` `ShimEndpoint`; vsock ports 1024, 1025–1535, 7002 (§7.2.1, §19.5) | bench (userspace NIC) vs gate/aide (vsock 7001/7002) |
| A11 | `LabelAuthority` facet (§7.5.2, §14.1) | gate, portals and atrium each invented ways to raise another session's label |
| A12 | System interfaces canonicalised (§7.5): warden-sys merges warden-ext, SupervisorBroker, attachGrant, notifyListener (now `LegacySpawn`), spawn facets; broker-sys merges BrokerSystem, requestFor, label authority, captive minting, policy load/validate | Writers defined overlapping local extensions |
| A13 | `Extensible` bootstrap interface replaces the implicit `@65535` method (§7.3.1) | Cap'n Proto dispatch is per interface ID; implicit methods are not expressible |
| A14 | Facet registry (§19.2) with aliases resolved (`spawn-user`→`launcher`, `spawn-handler`→`handler`, `spawn-trusted-terminal`→`trusted-terminal`, `spawn-child`→`client`, `grant-mount`→`portals`, `spawner`→`bench`/`compat`, broker `service`/`gate`→`principal`/`system`, `depot#read`→`user`, `vault#names`→`app`, `gate#intents`→`client`, `compat#run`→`user`, `fleet-decider`→`fleet#decider`) | Unregistered facets across specs |
| A15 | Receipt event registry with extension rule `x-<repo>.<event>` (§19.3); many writer events promoted to core | Writers used ad-hoc `x-` events |
| A16 | Media-type registry; shared formats fully defined in §20 (boottrust, bootreport, presence, owners, seal-window, VBU, release, genstmt, consent, exception, flowproof, fsmerge, firstboot, tlogproof, renderer WIT) | Formats consumed by several repos were defined (sometimes differently) in one |
| A17 | One `keylos.release/1` (§20.6) merging courier's and the distribution's shapes; release-log entries are the release statements (`keylos.releaselog/1` removed) | courier vs keylos vs vouch release formats |
| A18 | VBU protocol fixed (§20.5): AK0 pre-unlock key, 8-character base32 challenge, `KLV1` CBOR QR, PCRs 0–15 | boot vs vouch (digits, AK handle, QR prefix) |
| A19 | `src:` digest = canonical tar stream (§3.2, §11.2) | §3.2 contradicted §11.2 (forge) |
| A20 | Manifest: kind `part`; fields `grafted`, `l10n`, `agent`, `compat`, `needs.listen`, `needs.portalIsland`; entrypoint kinds `handler`, `notify-action`; agent template layout (§6) | sdk/aide/atrium/compat used `x-` fields |
| A21 | `keylos.exception/1` (§20.9) for reproducibility exceptions | No format existed (F10) |
| A22 | `Strata.begin` takes `NetworkPolicy` enum; `SpawnSpec.transaction`; `KEYLOS_TXN` (§7.3.10, §7.3.2, §10.5) | Free-form text; no transaction-to-spawn link (strata) |
| A23 | `Process.freeze`/`thaw`; `Process.signal` targets the cgroup (§7.3.2) | kish job control, broker revocation |
| A24 | `Approval.mandate`; `GrantResult` with mandate (§7.3.3, §7.5.2) | gate could not obtain mandates |
| A25 | `AgentEvent.rich` (§7.3.14) | aide used in-band text prefixes |
| A26 | `ScreenCapture.start` returns a stream list; `Notify` action callbacks (§7.3.15) | portals |
| A27 | `captive($bool)` token fact (§8.2) | net/gate captive portal flow |
| A28 | Confinement report `tlsInterception`, `grants` (§9.4) | gate |
| A29 | Runtime directory grants via `/grants/<name>` mounts (`GrantMounts`, §7.3.3) | Landlock domains cannot be widened (F9, broker) |
| A30 | Hibernation unsupported; swap keyed per boot (§2, §10.2) | Kernel lockdown refuses hibernation (keylos distribution) |
| A31 | Journal metrics record type `0x1F` (§10.6) | journal |
| A32 | Cedar annotations `@presence`, `@orgApproval`, `@channels`; context `channel`, `approver`; mandate `channel` (§14.4, §16.2) | fleet, vouch |
| A33 | Ledger read-access rule and `reader`/`time` facets (§7.3.5, §19.2) | Unspecified (F9) |
| A34 | capwire has no call-attached tokens; holding a capability or fd is authority (§7.1) | strata assumed call-attached tokens |

## Appendix B. Change log: gaps round

| # | Change | Origin |
|---|---|---|
| B1 | Profiles (`server`, `server-k8s`, `cloud`, `kiosk`, `appliance`) and integrity profiles (`full`, `shared-boot`, `shim`, `cloud-vtpm`, `cvm`, `degraded`) (§2.2); IOMMU requirement (§2) | G2, G7, G9 |
| B2 | RAM classes and VM admission caps (§2.3) | G14 |
| B3 | Actor `pod:`, human `_cluster`, guest usernames, new ID prefixes `q-`, `dbg-`, `pod-`, `med-` (§3) | G1, G13 |
| B4 | HPKE DHKEM(P-256) for TPM-resident keys; Shamir shares (§4) | G19#37, G12 |
| B5 | Trust roots `org-publisher`, `catalog`, broker mandate role (§5.2) | G1, G17, G19#5 |
| B6 | Assisted presence; quorum presence §5.4; separate login rpId `keylos.login` | G11, G2, G19#43 |
| B7 | Generation kinds `container`, `kmod`; manifest `needs.gpu: "passthrough"`, `needs.realtime`, `needs.csi`, `webapp`, `container`, `kmod`; template `models[].minVersion`/`weights`, `vm.desktop` (§6) | G1, G7, G10, G15, G6 |
| B8 | CRI v1 gRPC over a stream socket as the single non-capwire IPC (§7.1, §21) | G1 |
| B9 | `ActorKind.pod`; `Supervisor.control("_system", poweroff\|reboot)` | G1, G19#20 |
| B10 | `Right.debug`, `ResourceRef.principal`/`DebugTarget`, `Broker.debug`; `DebugAttach`; `kl_debug_pairs` map and `ptrace_access_check`/`perf_event_open` hooks; seccomp profile `debug-1` (§7.3.3, §7.5.1, §9.3) | G4 |
| B11 | `ApprovalPrompt.channels`/`requester`; `TrustedPrompt.presence` takes a rendering (§7.3.4) | G19#6, #26, G13 |
| B12 | `Gate.intent(id)`; `GateDebug`, `GateMeterAdmin` (carve, hard sub-meters); terminated HTTP mode documented (§7.3.7, §7.5.12) | G19#25, #19, #7, #32 |
| B13 | `GenerationInfo.launchReasons`, `Depot.openPath`, `oci+container://` source, warden GC roots for mounts (§7.3.8) | G19#18, #33, #53, G1 |
| B14 | `VmSpec` session/parent/kind/storeSet/unsignedImageOk/purpose/displayMode/gpuPassthrough/blockDevices; `Vm.attachShare`/`detachShare`/`desktop`/`takeOver`; `Bench.media` (§7.3.13) | G19#1, #2, G5, G6, G7 |
| B15 | Portals `Discovery` and `Scan` (§7.3.15) | G3, G7 |
| B16 | warden-sys `PrincipalEvent.cgroupId`, `DebugAttach`, `PodSpawn`; broker-sys `requestFor` idempotency and allowed subjects, `registerApprover` channel, `admitPod`, non-presence mandates re-signed by `service/broker` | G19#4, #5, #22, G1 |
| B17 | hearth-sys `HearthSeal` window rule, `HearthTpm`, `HearthQuorum`, `HearthFleet` | G19#9, #17, #41, G2 |
| B18 | ledger-sys `LedgerAdmin.shred`; `fleet-export` facet; receipt privacy §13.4 | G8 |
| B19 | courier-sys `Resolution.revocations` | G19#15 |
| B20 | strata-sys `TransactionExt.owner`, warden owner check, `StrataHomes.createEphemeralHome`, `StrataVolumes`, `strata#gate` undo | G19#22, #29, G13, G1 |
| B21 | devd-sys `DeviceAdmin.authorize`/`deauthorize`/`pending`, `MediaAttach`; §9.5 devices, media and DMA | G7 |
| B22 | bench-sys `GrantDelegate` outcome JSON, `MediaBrowser`, `GuestPortals` (vsock 7004) | G19#58, #56, G7 |
| B23 | net-sys `NetCaptive.admitSession`/`portalUrl` (`admit` superseded), `NetPlumbingCluster`, `NetDiscovery` | G19#3, G1, G3 |
| B24 | aide-sys `AgentDesktop`, `AgentHostExt.desktop` | G6 |
| B25 | config-sys `ConfigFleet.applyRemote` | G19#39 |
| B26 | a11y `A11yGate`; screencast-file `ClipboardHost`, `InhibitHost` | G19#51, #52 |
| B27 | fleet-sys `FleetCluster`; vouch-sys `VouchLink.inheritance`; new `cri-sys.capnp` (`CriAdmin`) | G1, G12 |
| B28 | Token facts `debug_scope`, `model`, `budget_parent`; ambient `offline_days` (§8) | G4, G15, G19#7, G16 |
| B29 | §9.3: bpf rule by warden thread-group ID (not cgroup); service BPF from the OS generation per `services.json`; trusted-terminal tree definition; core-dump helper exception; kmod modules release-signed only (ADR-0057); legacy open-broker read-only ptrace pairing | G19#21, #22, #24, #50, #57 |
| B30 | §10: per-service state dirs, cri image store, cgroups for pods and guests, env `KEYLOS_GUEST_PORTALS`, `KEYLOS_BPF_FDS`, shell exception for `KEYLOS_ARGFD_*`/`KEYLOS_PIPE_*`; §10.7 cross-repository file registry | G19#13, #23, #35 |
| B31 | §11.7 publisher-key revocation semantics; §11.8 publishers and catalog | G17 |
| B32 | §14: label-authority holders journal and warden; effect kinds `net.listen`, `media.export`, `config.propose`; channel, family, quorum and guest rules; mandate signing model; §14.5 agent desktops, model drift, offline operation, remote lock/wipe | G6, G15, G16, G19#5, #19, #40, #55, G13 |
| B33 | §15 activation failure handled by recovery revert, never automatic fallback | G19#14 |
| B34 | §16 Cedar `PodSpec`/`admit`, `DebugTarget`/`debug`, `Human.guest`, context fields; default pod forbids; evaluation order `@tier` before `@orgApproval` | G1, G4, G19#48 |
| B35 | §19 registries: services `cri`, `kubelet`, `kube-proxy`, `portal-discovery`, `portal-scan`, `pipewire`, `_system`; all new facets and holders; events `pod.*`, `debug.*`, `device.authorize`/`deauthorize`, `media.attach`/`eject`, `ledger.shred`, `model.change`, `quorum.*`, `guest.*`, `budget.carve`; recovery-replayable events; media types; vsock 7004 | G1–G18, G19 |
| B36 | §19.6 TPM: common NV attributes with a public NV_Read policy branch, hierarchy authorizations (owner auth sealed to hearth, lockout from the recovery key), floor approvals cover the installer UKI, seal-gate salt encoding, quorum seal-gate blob, single-owner KEK/db policy, vault seed P-256, AK/AK0 attributes, PCR11 phase table and ordering | G19#9, #12, #34, #37, #38, #42, #49 |
| B37 | §20: owner registry fields `ownerIndex`, `sealKey`, `credential.seal`, `credential.assisted`, op `set-quorum`, `policy.mode/threshold`; VBU TOTP location; no separate recovery UKI; exception kind `fleet-receipt-access`; firstboot `keepMicrosoftCAs` and cloud seed; new §20.16 services, §20.17 policy.ref, §20.18 quorum, §20.19 trustee shares and inheritance, §20.20 publishers and catalog, §20.21 recovery key | G19#8, #11, #10, #36, #45, #46, G2, G8, G9, G12, G17 |
| B38 | §21 cluster nodes: boundary, runtime classes, admission, images, networking (tap only in the cri netns), storage, attestation, unsupported features | G1 |

## Appendix C. Change log: round 3

| # | Change | Origin |
|---|---|---|
| C1 | Process-scope debugging grants `CAP_SYS_PTRACE` and `CAP_PERFMON` (kernel scope adds `CAP_BPF`), bounded by `kl_debug_pairs`; `DebugAttach.attach` gains `requester` (§9.3, §7.5.1) | keylos distribution, warden |
| C2 | Cedar `Principal` gains `human`, `humanOwner`, `humanGuest`; `PodSpec.allImagesSealed`; entities `Screen`, `Model`; action `snapshot`; `use` covers `Model` (§16.1) | keylos distribution, gate |
| C3 | The UKI command-line revocation pin belongs to the UKI's own release; `courier` only verifies it (§10.7) | keylos distribution, courier |
| C4 | `iommu: none-virtual` accepted on the `cloud` profile; boot report fields `integrity`, `dmaProtection`, `iommu` (§2, §20.1) | keylos distribution, warden |
| C5 | `keylos.cloudimage/1` defined (§20.24); release log also carries cloud image records (§11.5) | keylos distribution |
| C6 | USB before `devd`: `usbcore.authorized_default=2`, the initrd authorizes only external hubs and all-HID devices, `devd` re-evaluates after `switch_root`; `keylos.preauth/1` (§9.5) | keylos distribution, devd |
| C7 | §10.7 registers recovery spool, recovery recipient, hierarchy blobs, seal-gate blobs, platform authenticator blobs, preauth list, fleet approvers; per-service config file rule; `warden` reads exceptions; `config-recover` reads `owners.log` | ledger, vault, installer, hearth, devd, config |
| C8 | Recovery recipient (HPKE to an X25519 key derived from the recovery key) replaces raw-secret recovery slots and a separate hierarchy recovery key; HKDF labels `keylos-recovery-recipient/1`, `keylos-sb-pk/1`; firstboot `recovery.recipient` (§5.2, §7.5.4, §19.6, §20.13, §20.21) | ledger, vault, installer, hearth. The suggested label `keylos-owner-hierarchy/1` is not used: the recovery copy is encrypted to the recipient instead |
| C9 | Decrypted sealed receipts are returned with a top-level `clear` member that verifiers strip (§13.4) | ledger |
| C10 | Mandate channel `quorum`; headless machines without fleet escalate T2+ approvals to quorum (§14.3, §14.4) | broker |
| C11 | `BrokerSystem.requestFor` gains `intentSession`; `GrantRequest.onBehalfOf` (informational); atrium may call `requestFor` for itself (device authorization) | broker, vault, atrium |
| C12 | `Resolution.review`, `catalogEntry`; `CourierResolver` source grammar incl. `tuf:org:` and `tuf:catalog/` (§7.5.6) | depot, fleet |
| C13 | `oci-convert/1` and `keylos.ociconv/1` normative; converted-generation identity; crate `keylos-oci-convert` published by depot (§21.4, §18) | depot, forge, fleet, sdk |
| C14 | GC root naming; container generations mountable only while rooted `cri:pod:…`; `courier:kmod:<kernel-release>` (§7.3.8, §20.6) | depot, cri, courier |
| C15 | `Depot.revocationStatus`; holders: `ledger#time` adds depot, `depot#user` adds gate and portal-discovery (§7.3.8, §19.2) | depot, gate, compat, portals |
| C16 | Captive portal: atrium calls `NetCaptive.signIn`; `net` starts the captive VM through the new `bench#net` facet, reads `Vm.info`, mints the token the broker attaches to the VM session; `admitSession` superseded (§7.5.11, §7.3.13) | net, bench, atrium, pkgs |
| C17 | Boot report on `warden` fd 8 (§20.1) | handbook, warden |
| C18 | `VmSpec.bootArgs`, `tap`, `tapConfig`, `podId`; `Vm.info`, `attachBlock`, `detachBlock`; `Vm.fork(ForkSpec)`; `Bench.reattach` (§7.3.13) | cri, bench, aide |
| C19 | `keylos.cri.uplink/1`; `net` creates the cri and pod network namespaces (the only namespace-creation exception); `NetPlumbingCluster.clusterNetns`; services.json `network: "cluster"` (§21.5, §9.1, §20.16) | cri, net, warden |
| C20 | Admission against the API server Pod object; `CreateContainer` re-admission; mount-free kubelet patch set is part of the contract; `PodMount.tmpfsBytes` (§21.1, §21.3, §7.5.1) | cri, pkgs |
| C21 | `PodSpawn.execInContainer`, `PodSpawn.egressShim`; broker attaches pod tokens from policy `cluster.egress` (§7.5.1, §21.5) | cri, gate, warden |
| C22 | `FleetCluster.joinChallenge`, `joinAttested(…, challenge)`, `clusterCertificate(role)`; `CriAdmin.drain` uses cri's cluster credential (§7.5.21, §7.5.23) | cri, fleet |
| C23 | `AgentSession.takeOver`; `Hearth.presence(…, assist)`; hearth login methods `guest`, `kiosk` (§7.3.14, §7.3.12) | atrium, aide, hearth |
| C24 | Holders: `pipewire#portals` adds atrium; `portal-*#default` and `vault#app` add bench-relay; `gate#client` adds portal-files and atrium; `bench#user` purpose `app` for kish and the atrium launcher; `hearth#system` adds vouch, strata, bench, depot; `hearth#tpm` adds vouch, fleet (§19.2) | atrium, bench, portals, gate, vouch |
| C25 | devd verifies device decisions as broker- or presence-signed mandates (§7.5.8, §14.4) | atrium, devd |
| C26 | Caller-executed effects (`media.export`, `device.actuate`, `config.propose`): `gate` authorizes, the executor verifies the mandate and writes the completion receipt; `media.export` receipt by bench; `MediaBrowser.exportSeekable` + `ExportCompletion` (§14.2, §19.3, §7.5.10) | gate, bench, portals |
| C27 | `LegacySpawn` gains `brokerSession`; one open broker per legacy app; the pairing allows `PTRACE_MODE_READ` and `PTRACE_MODE_ATTACH_REALCREDS`; seccomp profile `openbroker-1` (§7.5.1, §9.1, §9.3) | compat, warden |
| C28 | `CompatIsland.islandSocket` protocol per island (D-Bus, SANE, IPP) (§7.5.15) | compat, portals |
| C29 | Manifest `benchImage` section (`purposes`, `desktop`) (§6.3) | sdk, bench, pkgs |
| C30 | `ledger.key.register` data `{service, spki, keyRef}`; `Ledger.serviceKey`; relying services take `service/broker` from ledger. The suggested boot-trust-set `serviceKeys` field is not adopted: service keys are created after boot, and the ledger answers over a warden-authenticated route (§7.3.5, §13.3, §14.4) | gate, strata, devd |
| C31 | `NetPlumbing.setListenPorts` gains `ports` with per-port scope; `ListenPort` (§7.5.11) | net, gate |
| C32 | `ResourceRef.screen` and `ResourceRef.model`; right kinds `screen`, `model` (§7.3.3, §8.2, §14.5) | gate, aide |
| C33 | `Gate.intents` on facet client covers the session tree recursively (§7.3.7, §19.2) | kish |
| C34 | `VmSpawn` (`register`, `spawnVmm`, `unregister`) in warden-sys replaces bench's use of `Supervisor.spawn` and the fd-1001 descriptor workaround (§7.5.1, §19.2) | warden, bench, aide |
| C35 | PCR11 `enter-initrd` is extended by `kl-initrd`, not systemd-stub (§19.6) | boot |
| C36 | Release statement `recoveryGen`, cloud `seed` profile with `pcr11Seed`, kmod TUF target path; floor-write approval covers the seed profile (§20.6, §19.6) | courier, installer |
| C37 | Sealed pods have a read-only root plus tmpfs; writable container roots unsupported (§21.8, §7.5.1) | warden, cri |
| C38 | Pod principals skip the env secret-pattern check (§7.3.2) | warden |
| C39 | `HearthTpm.activateCredential`, `HearthTpm.recreateKey` (§7.5.3) | vouch, fleet, strata |
| C40 | Quorum requests signed by `service/hearth` with `keyChain` (§20.18) | hearth |
| C41 | `keylos.fleet.command/1` and `keylos.fleetapprovers/1` moved into §20.23; `keylos.pendingreceipt/1` moved into §20.22; recovery events `recovery.enter`, `recovery.delay`, `recovery.wipe` (recovery-replayable) | hearth, installer, ledger, fleet |
| C42 | `HearthAdmin.setQuorumPolicy` (single `quorum` number); `setQuorum` superseded; `recoverySigner` encoding (§7.5.3, §20.3) | hearth, installer |
| C43 | NV auth file names `0x<8 lowercase hex>.sealed` (§10.7, §19.6) | installer, hearth, ledger, vault, strata, config |
| C44 | Family inbox ID prefix `fi-`; fleet command ID prefix `fc-` (§3.5) | hearth, fleet |
| C45 | Reserved staging handles `0x81000180`–`0x81000183` (§19.6) | hearth |
| C46 | `_cluster` on-disk owner UID `0x0FFF0000`; dynamic UID range ends at `0x0FFEFFFF` (§10.3) | strata, cri |
| C47 | `PrincipalControl.events(…, replay)` (§7.5.1) | strata |
| C48 | Core-dump helper moves itself out of the root cgroup; journal verifies (§9.3) | journal |
| C49 | Cloud seed bundle carries `owners` and `config`; UKI `seed` profile (§20.13) | installer, boot |
| C50 | `keylos.ociconv/1` `layers` = compressed manifest blob digests in manifest order (§21.4) | depot, forge |
| C51 | `hearth#system` adds ledger (`owners` only) for `recoverySigner` verification of pending receipts (§19.2) | ledger, hearth |
| C52 | HPKE suite for software recipients: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM with purpose `info` strings (§4) | installer, hearth, vault, vouch |
| C53 | Sub-agent narrowing: `VmPrincipal.checks`/`budgets` and `ForkSpec.offered`/`checks`/`budgets`; broker attenuates offered tokens with the checks and carves the budgets as hard sub-meters (§7.3.13, §7.5.1) | aide, bench, warden, broker, gate |
| C54 | `NetCaptive.endSignIn`; `MediaSave` moved into portals-extra (§7.5.20); `requestFor(…, decidedOnTrustedPath)` for atrium device decisions (§7.5.2, §7.5.11) | net, atrium, portals, sdk, broker |
| C55 | §10.7: `rescue` reads/appends `owners.log` and rewrites `nv-auth/*.sealed` in the recovery profile; `/var/lib/keylos/fleet/wipe.dsse` registered; `boot.wipe` details; HPKE recovery-copy `info` strings fixed (§4, §20.2) | installer, fleet, hearth, vault |
| C56 | `SessionReg.budgets`: warden forwards VmPrincipal budgets to the broker, which carves them as hard sub-meters at registration (§7.5.2) | warden, broker, aide, bench |

## Appendix D. Change log: implementation round S1

| # | Change | Raised by |
|---|---|---|
| D1 | `common.Fd.index` defaults to `0xFFFF`; a null `Fd` pointer also means "no fd" (pre-release default change) | keylos-capwire |
| D2 | §7.1 peer identity: warden-created socketpairs report warden as peer; identity only from `ServiceHost.accept` / `Supervisor.connectionInfo`; `SO_PEERPIDFD` only for `connect()`ed sockets | keylos-capwire |
| D3 | §7.1 socket buffers: `SO_SNDBUFFORCE`/`SO_RCVBUFFORCE` ≥ 4 259 840 on warden-created sockets; vsock buffer sizes; §2 `net.core.wmem_max`/`rmem_max` ≥ 4 259 840 | keylos-capwire |
| D4 | §7.1 rejection points: fd-index errors fail the call; datagram violations fail the connection; duplicate index = `kl:invalid`; unreferenced fds closed on message release; zero-length datagrams forbidden (read as end of connection); oversized outgoing message fails the connection | keylos-capwire |
| D5 | §7.3.1 `Extensible.ext` returns `kl:denied` for unimplemented interfaces; `version()` string forms; error string grammar (empty message allowed, non-empty ref, unknown codes are parse errors); root interfaces not `extends(Extensible)` | keylos-capwire |
| D6 | §8.2 resource text per right kind (path `<fdkey>:<rel>`, net = host + `net` facts, delegate `*`); `path_root` linkage; absolute `max_depth`; `label_ceiling` bounds session and object; fact multiplicity | keylos-biscuit |
| D7 | §8.3 limit facts in attenuation blocks, most-restrictive-across-blocks rule, inclusive `expires`; ambient facts `proto`, `object_label`, `requested_debug_scope`, `process_tier`, `captive_network` | keylos-biscuit |
| D8 | §8.4 revocation covers `budget_parent` descendants | keylos-biscuit |
| D9 | §9.3 debug: agents never get kernel scope or `gen:` targets; `durationSecs = 0` resolves to defaults (900 s / 300 s) | keylos-biscuit |
| D10 | §3.1 exact digest lengths; §3.5 `t-` = uppercase Crockford base32, canonical uppercase ULIDs | keylos-ids |
| D11 | §5.1 envelope bytes = JCS of the envelope; canonical base64; unknown `alg` never counts; `schema` rule only for keylos media types; `x-` rule for every document | keylos-formats |
| D12 | §13.4 sealed-receipt AAD = `unit ‖ 0x00 ‖ submitted`; `refs` member; receipt numbering and signature layout; top-level `onBehalfOf` | keylos-formats |
| D13 | §14.2 `net.listen` row completed; pushes to existing branches irreversible | keylos-labels |
| D14 | §16.2 multi-permit combination (most restrictive); unannotated permit tier (T1 connect, T0 otherwise); annotation value sets; presence prompts whatever the tier; `@orgApproval` without `@tier`; `@id` annotation | keylos-labels |
| D15 | §19.6 seal gates follow the common NV attributes (`POLICYREAD` + `NV_Read` branch; changes hearth's authPolicy digest); pcrlock-policy authPolicy is a flat `PolicyOR` | keylos-tpm-registry |
| D16 | §19.4 registers `keylos.tpmregistry/1` | keylos-tpm-registry |
| D17 | §22 normative clarifications for identifiers, formats, presence, owner registry, labels and the TPM registry | all S1 crates |

## Appendix E. Change log: implementation rounds S2 and S3

Rows E1–E52 come from round S2 (and the durable-execution embedding), rows E53 onwards from round S3.

| # | Change | Raised by |
|---|---|---|
| E1 | §19.6 `vault-epoch`: `AUTHREAD \| AUTHWRITE \| NO_DA`, empty authPolicy, authValue sealed to PCR11 `ready` ∧ PCR15 (the template was incomplete, so hearth could not define it) | warden (S2 exit test), vault, hearth |
| E2 | §14.2, §14.4 mandate-only effect kinds (`grant.<k>`, `grant.declassify`, `debug.attach`, `pod.admit`); `constraints.channels`; mandate drafts are not mandates until decided; `x-` members carry no authority (keylos-formats) | broker N-1, N-2 |
| E3 | §14.4 JSON form of a `GrantRequest` for grant-effect digests; vault confirmations verify `grant.secret` kind and digest | vault 8, broker |
| E4 | §13.1, §13.4 signature layout (writer, then ledger; no `scope`); ledger-originated receipts with one ledger signature, verified by keylos-formats; non-empty `subject`; the ledger's own `ledger.key.register` first in every epoch | ledger 1, 2, 4, 5, 26 |
| E5 | §13.1 `time` non-decreasing in `seq`: group commits sorted, earlier submissions refused `kl:invalid … re-sign`, writers re-sign and resubmit | ledger 7 |
| E6 | §7.3.5 `Filter.fromSeq` and the `query` continuation rule | ledger 8 |
| E7 | §19.6 "Sealed secrets": one sealed-object template under the SRK, production policy PolicyAuthorize(PCR11 `ready`) ∧ PolicyPCR(15), development fallback PolicyPCR(15), blob `TPM2B_PRIVATE ‖ TPM2B_PUBLIC`; §7.5.3 NV indices after genesis only through `defineSpace`, which writes the nv-auth file (keylos-tpm-registry) | warden P4, O2; hearth; vault 3; ledger 30 |
| E8 | §10.5 `KEYLOS_TPM_FD` hand-over; reserved `KEYLOS_DEV_*` namespace, never read by production builds; one development TCTI variable `KEYLOS_DEV_TPM_TCTI` | warden N5, N7, O6; vault 12 |
| E9 | §5.3, §10.7 platform authenticator keys: `userWithAuth` clear, PolicyPCR(15) ∧ PolicyAuthValue; blob format | hearth H1, H14 |
| E10 | §19.6 seal-gate authValue change: undefine and redefine with the identical template is equivalent to `NV_ChangeAuth` | hearth I1 |
| E11 | §7.5.4 slot rules (params encodings, password factor, recovery slots on request per `hearth.recoverySlots`, guests with empty slot lists, unlocked user for slot changes); §7.3.12 `enrollKey` needs the user unlocked | hearth X1–X3; vault 18; warden (S2 exit test) |
| E12 | §7.3.12 `assist` prompt id = `sha256:` of the payload PAE | hearth H2 |
| E13 | §3.5 hearth may mint `a-` IDs for its own mandates | hearth H5 |
| E14 | §8.2 path rights: resource `<rel>` under the token's `path_root`; at most one `path_root` per broker token (corrects the D6 text to what keylos-biscuit implements) | broker N-6 |
| E15 | §8.2, §14.5 several `model` facts (approved set); model re-approval mints a new root linked to the session's original root (keylos-biscuit) | broker N-8, N-10 |
| E16 | §10.5 route names in `KEYLOS_CAPWIRE_FDS`; fd 3; inheritance helper in keylos-capwire, so binaries need no `unsafe` (§18) | warden N1; broker N-11; hearth I5; ledger 33 |
| E17 | §7.1 fds on pointer-only structs and unresolved bootstraps (keylos-capwire SPEC-NOTES 21); `ENOBUFS`/`ENOMEM` retried for up to 1 s (keylos-capwire) | warden O3, P3 |
| E18 | §7.5.2 `registerApprover.publicKey` is DER SPKI; `kl:unavailable` until the component's own ledger key is registered | warden P1, O4 |
| E19 | §7.3.4 `TrustedPrompt.secret`; facet `atrium#secret` (hearth, vault) | hearth H3 |
| E20 | §7.5.3 `HearthTpm.sbAccepted`: courier reports firmware acceptance of the new KEK/db certificates | hearth H7 |
| E21 | §7.5.16 `Display.windowOwner`; facet `atrium#broker` | broker N-13 |
| E22 | §7.5.24 `classifier.capnp` (file ID `0xc7a1e5d3b2f40037`); facet `classifier#broker` | broker N-14 |
| E23 | §7.5.2 `FlowCheck.intent` | broker N-7 |
| E24 | §19.2, §7.5.3 `HearthQuorum.collect`/`list` on facet `admin`; `list` includes `requestEnvelope` | hearth H11 |
| E25 | §19.6 registered owner of every persistent handle (keylos-tpm-registry) | hearth H6 |
| E26 | §22.3 seal-credential rotation: remove the old, then enrol a fresh credential; never re-mark | hearth H4, P3 |
| E27 | §10.7, §14.3 org approver keys only from `/etc/keylos/fleet/approvers.json` | broker N-25 |
| E28 | §19.6 two vault epoch indices `0x01300110`/`0x01300111` (vault-epoch/0, /1) for a power-loss-safe rotation state machine (vault §4.5.1) (keylos-tpm-registry) | ISSUES.md ISS-001; vault 13 |
| E29 | §19.6 "Floor writes", §20.6, §22.2: exact-target floor authorization (PolicyNV ≤ F ∧ PolicyCpHash(write F), PolicyNvWritten for initialisation), one target per measured boot, no intermediate values, missing floor = re-enrolment (keylos-tpm-registry) | ISS-002 |
| E30 | §7.5.7 `TransactionExt.prepare`, `PreparedMerge`, `StrataTxn.prepared`, `commitWithMandate` superseded; §7.5.1 `PrincipalControl.fenceWriters`/`WriterFence`; §7.5.10 `BenchMerge` on prepared merges; §20.12 `keylos.fsmerge/2`; §3.5 `pm-` (keylos-formats, keylos-ids) | ISS-003 |
| E31 | §7.3.3, §9.3, §14.1 directory grant ceilings: label raised before exposure, `attachGrant(…, ceiling)`, enforcement by warden's `kl-label` LSM, truncated walks never lower the ceiling, null ceiling = `secret/untrusted` | ISS-004 |
| E32 | §7.3.3 single-file views served by portal-files; safe-save through the portal; no parent-directory exposure | ISS-005 |
| E33 | §7.3.4 `RenderedEffect.review`/`payloadDigest`; required review material; §14.2 required details per kind; §14.3 fail closed on every channel | ISS-006 |
| E34 | §7.3.10 transaction storage backends: unitfs transactions over ciphertext clones, no plaintext artifacts | ISS-007 |
| E35 | §9 "What a reboot restores"; safe start | ISS-008 |
| E36 | §17 cross-component invariants INV-1–INV-7 with real-component integration acceptance; contract versioning; excerpt-check status | ISS-009 |
| E37 | §22.6 normative clarifications of implementation round S2 | ledger, vault, hearth, broker, warden |
| E38 | §3.5 identifiers `wf-` (workflow), `wr-` (run), `ws-` (step with occurrence, derived), `wa-` (attempt), `fx-` (effect, derived from the step ID), `oe-` (ownership epoch), `dr-` (durable decision), `ba-` (budget account) (keylos-ids) | durable execution proposal (`DURABLE_EXECUTION_IDEA.md`) |
| E39 | §20.25 durable execution: the normative invariant, roles, status vocabulary, enrollment, claims and ownership fencing, attempt authority from broker workflow records, durable decisions, labels, budgets, recorded observations, durability barriers, cancellation, forgetting, owner lock, restart, timers and trusted time, retention | durable execution proposal (`DURABLE_EXECUTION_IDEA.md`) |
| E40 | §7.3.16 `loom.capnp` (`0xc7a1e5d3b2f40038`: `Loom`, `Workflow`, `AttemptHost`) and §7.5.25 `loom-sys.capnp` (`0xc7a1e5d3b2f40039`: `DurableEffects`, `WorkflowBudget`, `BrokerWorkflow`, `AgentWorkflowHost`, `LoomSystem`), a new negotiated interface rather than optional fields older executors would ignore | durable execution proposal (`DURABLE_EXECUTION_IDEA.md`) |
| E41 | §7.3.1 `AttemptBinding`; `SpawnSpec.attempt` (loom only), `VmSpec.attempt`, `ForkSpec.attempt`, `VmPrincipal.attempt`, `SessionReg.attempt`, `AgentSession.attempt`: fresh sessions per attempt, labels restored before grants, attempt tokens minted from the broker's workflow record | durable execution proposal (`DURABLE_EXECUTION_IDEA.md`) |
| E42 | §20.26 effect executor contract: durable effect records owned by the workflow, `authorized` separate from completion, exact request-digest binding, the four retry strategies, `outcomeUnknown` and its resolution, dedup retention covering the workflow horizon; §14.2 completion rule; §19.3 `effect.complete`, `effect.unknown`, `effect.resolve` | durable execution proposal (`DURABLE_EXECUTION_IDEA.md`); gate spec |
| E43 | §8.2 token facts `workflow($wf, $epoch)` and `budget_account($ba)`; §8.4 durable workflow revocation; workflow-lifetime budget accounts with idempotent reserve, settle and release (`WorkflowBudget`); §19.3 `budget.open`, `budget.settle`, `budget.close` | durable execution proposal (`DURABLE_EXECUTION_IDEA.md`) |
| E44 | §16.1 Cedar entity `Workflow`, actions `enroll`, `resume`, `cancel`, context `workflow`, `epoch`, and the default-policy rules; §14.2 mandate-only kinds `workflow.enroll`, `workflow.resume`, `workflow.decide` with required review details; §14.3 durable decisions separate from boot-local prompt IDs; §14.4 `constraints.workflow`, `constraints.decision` (keylos-formats) | durable execution proposal (`DURABLE_EXECUTION_IDEA.md`) |
| E45 | §20.25 receipt outbox with a reconciliation rule built on the §13.1 time order, and ledger-anchored rollback detection of the loom, broker-workflow and gate-effect stores (no new NV index); §7.3.5 writer services read their own receipts across boots; §13.4 workflow IDs in clear `refs`; §19.3 `workflow.*` events (writer loom); §20.2 presence purposes `loom.<op>` (keylos-formats) | durable execution proposal (`DURABLE_EXECUTION_IDEA.md`) |
| E46 | §20.27 `keylos.workflow/1` definitions (explicit versioned state machines, activity semantics, pinning, revocation and explicit migration); §6.3 `provides.workflows` (capability sets of generations without workflows unchanged); §7.3.8 `openPath` of `/.keylos/workflows/*`, GC root prefix `loom:workflow:` (keylos-formats) | durable execution proposal (`DURABLE_EXECUTION_IDEA.md`) |
| E47 | §7.5.3 `HearthSystem.userState`, `watchUsers`; the owner-lock execution policy, independent of key wrapping (`loom:` units system-wrapped; user-owned workflows pause while the owner is locked unless enrolled `runWhileLocked` with presence); §7.3.6, §19.2 vault facet `loom` | durable execution proposal (`DURABLE_EXECUTION_IDEA.md`); vault, hearth |
| E48 | §7.5.7 `TransactionExt.bindWorkflow`, `PreparedMerge.status`, `StrataTxn.preparedFor`; §7.5.10 `BenchMerge.commitPrepared`, `preparedStatus`: a fresh attempt reaches a retained prepared merge (E30) and its idempotent completion record | durable execution proposal (`DURABLE_EXECUTION_IDEA.md`); ISS-003 |
| E49 | §19.1 service `loom`; §19.2 facets `loom#user`, `admin`, `attempt`, `aide`, `broker#workflow`, `gate#loom`, `aide#loom`, `vault#loom`, `depot#loom`, holder `loom` of `hearth#system`, `SpawnSpec.attempt` on `warden#service`; §10.7 durable-execution state ownership | durable execution proposal (`DURABLE_EXECUTION_IDEA.md`) |
| E50 | §10.5 registered development knobs (`KEYLOS_DEV_TPM_TCTI`, `KEYLOS_DEV_LEDGER_SELF_PROVISION`, `KEYLOS_DEV_LEDGER_SAMPLE_EXPORT`, `KEYLOS_DEV_HEARTH_SOFT_AUTHENTICATOR`, `KEYLOS_DEV_BROKER_IMPLICIT_SESSIONS`, `KEYLOS_DEV_BROKER_POLICY_DIR`, `KEYLOS_DEV_BROKER_GENERATION`, `KEYLOS_DEV_TIME_TRUSTED`, `KEYLOS_DEV_WATCHDOG_SECS`, `KEYLOS_DEV_LOOM_FAULTS`, `KEYLOS_DEV_LOOM_CLOCK_SKEW_SECS`); unlisted knobs are not read | S2 follow-ups (E8 renames); loom |
| E51 | §17 cross-component invariants INV-8 to INV-12 for durable execution and the `vectors/workflow/` suite | durable execution proposal (`DURABLE_EXECUTION_IDEA.md`); ISS-009 |
| E52 | §13.1 sealed ledger-originated replays: spooled replays keep the original subject and are sealed when it is a person (one ledger signature; `sealed.submitted` checked against the clear values); keylos-formats `EVENTS` completed with the E42/E43/E45 events and checked against §19.3 by a test | ledger (S2-fix notes 1, 2) |
| E53 | §10.4, §9.3, §14.1, §22.4 label and provenance xattrs renamed `security.bpf.keylos.label` and `security.bpf.keylos.prov` (BPF LSM programs can read and stamp only `user.*`/`security.bpf.*` names); setting them needs `CAP_SYS_ADMIN` in the filesystem's user namespace (no keylos program attaches `inode_xattr_skipcap`); `kl-label` hooks keyed by mount ID (keylos-labels `XATTR_NAME`) | warden W1 |
| E54 | §9.3 hook row `bprm_creds_for_exec` for check-only execs (`AT_EXECVE_CHECK` never reaches `bprm_check_security`) | boot S3-1 |
| E55 | §9.3 `perf_event_open` admits paired tasks, `perf_event_alloc` checks the event's target; internal program maps are not handed over | boot S3-4 |
| E56 | §9.3 numeric values: `phase` (INITRD 0, SYSTEM 1), `enforce`/`audit_allow`, hook IDs 1–10, the audit-allow bit, the event detail fields, 32-byte event layout; `s_dev` is the kernel `dev_t` (registration step 4 converts `statx`) | boot S3-3, S3-5 |
| E57 | §9.3 hook links created with `BPF_LINK_CREATE`, passed as fds 9–18 with `keylos.execlinkfds=`, held open by the `warden` core for its lifetime | boot S3-2 |
| E58 | §9.3 `ptrace_access_check` exempts no task, the `warden` core included; supervision without ptrace access (pidfds, `PIDFD_GET_INFO`, namespace fds captured by the child at spawn); the core-dump helper takes mappings from `NT_FILE` | boot S3-6, S3-11; warden W5; journal S3-4 |
| E59 | §9.3 kernel-structure offsets computed from BTF at load; the keylos kernel configuration requires `CONFIG_DEBUG_INFO_BTF` and, for BPF trampolines on arm64, `CONFIG_FUNCTION_TRACER`, `CONFIG_DYNAMIC_FTRACE`, `CONFIG_DYNAMIC_FTRACE_WITH_DIRECT_CALLS` | boot S3-8, S3-9 |
| E60 | §9.3 known limitation: `mprotect(PROT_EXEC)` of a composefs file mapping is refused outside JIT cgroups (the hook sees the backing file) | boot S3-7 |
| E61 | §9.1, §9.4 `adjtimex`/`clock_adjtime` denied including read-only calls; profiles `baseline-1+<digest>` (digest of the sorted extras) and `debug-1k`; the report's profile list (keylos-formats) | warden W6, W7 |
| E62 | §20.16 `privileges.paths[].access` is `ro` or `rw` | warden W9 |
| E63 | §22.7 `Supervisor.spawn` with `actorKind service`: children of the caller's own generation only | warden W4; journal S3-5 |
| E64 | §20.27 `DefinitionRef.digest` = SHA-256 of the shipped canonical file bytes, never of a re-serialized definition (keylos-formats `WorkflowDefinition::file_digest`; vector `definition-digest` corrected) | loom S3-1 |
| E65 | §20.25 attempt processes obtain their tokens with `Broker.myGrants`; the enrollment scope must cover every effect kind the definition's activities declare | loom S3-3 |
| E66 | §20.26 loom observes a pending effect decision by re-issuing `commit`; denied, expired and policy-denied effects end `cancelled` with a reason and are the commit outcome `denied` | loom S3-4, S3-5 |
| E67 | §20.25 a cancellation interrupted before `BrokerWorkflow.cancel` keeps the workflow non-runnable until the broker record or the owner completes it | loom S3-6 |
| E68 | §22.7 `Filter.principalPrefix` matches subject or writer; `Workflow.history` event mapping; `kl:revoked` for forgotten unit keys; watchdog meaning (and the §10.5 readers of `KEYLOS_DEV_WATCHDOG_SECS`); mandate drafts; `registerSession` retries; repo-local CLI interfaces | loom S3-7, S3-10; journal S3-1, S3-2; warden W11, F7, F8, F10 |
| E69 | §22.7 normative clarifications of implementation round S3 | warden, boot, journal, loom |
