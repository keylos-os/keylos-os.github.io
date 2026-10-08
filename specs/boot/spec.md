# keylos/boot: UKI, initrd, unlock and early integrity

| | |
|---|---|
| Repository | `github.com/keylos-os/boot` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `kl-initrd` (the initrd's PID 1, a static Rust binary); `kl-exec` (BPF LSM program, Rust/aya); `kl-uki` (UKI assembly and PCR-prediction tool, used at build time by the `keylos` distribution and at enrolment by `installer`); `kl-boot` (CLI); `kl-boot-tpm` (Rust library crate with the TPM policy, NV and quote helpers, linked by `courier`, `installer` and the machine-side `vouch` daemon); initrd content list `initrd.toml`; IPE policy `policy/keylos.ipe` |
| Depends on | `keylos-protocols 1.0` (`keylos-ids`, `keylos-formats`, `keylos-presence`, `keylos-tpm-registry`). Reused external components: systemd-boot and systemd-stub (≥ 257, built from source in `pkgs`), libcryptsetup (≥ 2.7, via `libcryptsetup-rs`), `tss-esapi` (TPM2) |
| Provides | The boot chain from firmware to `warden`; the TPM unlock policy; the volume identity check; the `kl-exec` program (all hooks of protocols §9.3, including the debug and `bpf` rules) and its five maps; the IPE policy; the boot trust set and boot report (protocols §20.1); the initrd side of verify-before-unlock (protocols §20.5); the recovery boot entry and the recovery unlock path; the integrity-profile determination (protocols §2.2) |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`boot` turns powered-on hardware into a running `warden` with these guarantees:

1. The kernel, initrd and command line are exactly a release-stream-signed UKI. Secure Boot verifies the signature, and measured boot records it.
2. The TPM releases the disk secret only when all of these hold:
   - the UKI is genuine, of the expected release series;
   - its release `seq` is at or above the TPM version floor;
   - the system is in the initrd phase;
   - the firmware state matches the pcrlock policy;
   - the owner has typed their PIN.
3. The unlocked volume is the enrolled volume (volume identity, PCR15).
4. The root filesystem is the OS generation named in the signed command line, verified file by file by composefs and fs-verity.
5. The config generation is authorised by the owner registry (presence-signed, or quorum-signed on quorum machines) and is not older than the TPM config counter (protocols §15). There is never an automatic fallback to an older config generation.
6. From the first exec onward, the host executes only code from registered generations (`kl-exec`, protocols §9.3).
7. Before the PIN is typed, the owner can verify the boot with their phone (VBU, protocols §20.5).

**Non-goals:**
- **Updating boot entries, the pcrlock NV policy and the floor.** `courier` does that, using `kl-boot-tpm`.
- **First enrolment of keys, NV indices and the owner registry.** `installer` does that, using `kl-uki`, `kl-boot` and `kl-boot-tpm`.
- **The recovery environment's userland.** `installer` provides it (including the "revert to the previous configuration" flow of protocols §15); `boot` provides the recovery boot entry and the recovery unlock path.
- **PCR11 phases after `switch_root`.** `warden` extends `sysinit` and `ready` (protocols §19.6).
- **Out-of-tree kernel modules.** `boot` loads only in-tree modules listed in `initrd.toml`; `kmod` generations are loaded by `warden` after `depot` runs.
- **Runtime maintenance of `kl-exec` maps.** `warden` maintains them after `switch_root`.

---

## 2. Context and embedded contracts

```
UEFI firmware (Secure Boot: owner PK/KEK/db, or shim fallback)
  └─ systemd-boot (signed, in ESP)                         measured by firmware → PCR4
       └─ UKI keylos_<seq>+<tries>.efi  (signed)           PE measured → PCR4; sections → PCR11 by systemd-stub
            ├─ kernel (lockdown=integrity, IPE, BPF LSM)
            └─ initrd → kl-initrd (PID 1 in initramfs)
                  ├─ PCR11 "enter-initrd"; load kl-exec (BPF LSM); activate IPE policy
                  ├─ VBU (optional) → PIN → TPM unseal → LUKS2 open
                  ├─ volume identity → PCR15
                  ├─ mount composefs OS generation; replay owner registry; select config generation
                  ├─ write /run/keylos/boot/{trust.json,report.json}; kl_exec_policy {SYSTEM, warden_tgid=1}; freeze
                  └─ PCR11 "leave-initrd" → switch_root → warden (fds 3–7 maps, fd 8 report)
                                                    └─ warden: PCR11 "sysinit", then "ready" before the first tier-0 service
```

The contracts below are copied **verbatim** from `keylos/protocols` 1.0.0 (final). Section numbers and cross-references inside the excerpts refer to protocols. If an excerpt differs from protocols, protocols wins.

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

### 2.2 Digests (protocols §3.1)

```
digest      = algo ":" hex
algo        = "sha256" / "sha512" / "fsv256"
hex         = 64HEXDIGLC / 128HEXDIGLC   ; exactly 64 for sha256/fsv256, 128 for sha512
```

- `sha256:` is the SHA-256 of a byte string. It is used for sources, documents and blobs that are not files in the store.
- `fsv256:` is the **fs-verity file digest** with SHA-256, a 4096-byte Merkle block size and no salt. It is computed exactly as the kernel's `FS_IOC_MEASURE_VERITY` returns it. It is used for every file in the store and every generation image.
- Binary form: the Cap'n Proto struct `Digest` (§7.3.1).

### 2.3 Cryptography (protocols §4)

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

### 2.5 Trust roots (protocols §5.2)

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

### 2.6 Presence signatures (protocols §5.3)

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

### 2.7 Generation layout (protocols §6.2)

A generation is an EROFS image in composefs format:
- Every **non-empty** regular file is an overlay metacopy whose redirect names a store object, with the fs-verity digest of that object in `trusted.overlay.metacopy`.
- Zero-length regular files are stored inline in the EROFS image with no redirect.

The image root MUST contain `/.keylos/manifest.json`. It MAY contain:
- `/.keylos/cmdsig/<command>.json` (command signatures, §12)
- `/.keylos/sbom.spdx.json` (SPDX 2.3 or 3.0 JSON)
- `/.keylos/provenance.json` (the realisation attestations bundle, §11.3)
- `/.keylos/agent/` (agent templates only, §6.4)
- `/.keylos/l10n/<lang>.json` (localised strings, §6.3)

### 2.8 Code integrity (protocols §9.3)

`boot` loads `kl-exec`, writes `kl_exec_policy`, registers the OS generation, and activates the IPE policy.

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

### 2.9 Host and disk layout (protocols §10.1, §10.2)

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

GPT:
1. ESP (1 GiB, FAT32).
2. `keylos-root`: LUKS2 with dm-integrity AEAD (`aegis128` where available, else `aes-gcm-random` + HMAC-SHA256 integrity), holding btrfs subvolumes `@store`, `@var`, `@home`, `@keystore`, `@snapshots`.
3. Optional `keylos-swap`: encrypted with an ephemeral random key at every boot. There is no hibernation (§2).

### 2.10 Owner seal (protocols §11.6)

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

### 2.11 Revocation list (protocols §11.7)

```json
{"schema":"keylos.revocations/1","stream":"stable","serial":1234,"issued":"…",
 "objects":[{"ref":"obj:fsv256:…","reason":"CVE-2026-XXXX","action":"evict"}],
 "generations":[{"ref":"gen:fsv256:…","reason":"…","action":"unlaunchable"}],
 "keys":[{"ref":"key:sha256:…","reason":"compromised","after":"…"}]}
```

- Distributed as a TUF target by `courier` and logged (its digest) in the release statement.
- Actions: `unlaunchable`, `evict`, `warn`.
- A `keys[]` entry for a `publisher/<id>` or `org-publisher/…` key makes every generation whose only authorising signature is by that key `unlaunchable` from `after` onwards; generations signed before `after` stay launchable only if their realisations reach the rebuilder quorum.

### 2.12 Config generation statement (protocols §15)

```json
{"schema":"keylos.configgen/1","generation":"gen:fsv256:…","sourceRev":"git:sha1:…|sha256:…",
 "parent":"gen:fsv256:…","counter":57,"compiledBy":"gen:fsv256:<config compiler gen>",
 "proposedBy":"agent:…@alice/s-…","approvedBy":"alice","time":"…"}
```

- Signed by `owner-presence` (§5.3).
- `counter` MUST equal the TPM NV config counter (`0x01300101`, §19.6) + 1 at the time of signing. `config` increments the NV counter only after the signed generation is durably in the store. `boot` refuses a config generation whose counter is below the NV value. That is the anti-rollback rule.
- `boot` selects the highest-counter statement that verifies against the owner registry anchored in NV `0x01300105`, with `counter ≥` the NV value; if none qualifies, it boots the safe config shipped in the OS generation.
- **Activation failure.** `boot` never falls back automatically to an older config generation (that would be a rollback below the NV value). If a newly applied generation fails to activate (a tier-0 service fails its readiness check three times), `config` writes `/var/lib/keylos/config/activation-failed.json` (`{"generation", "counter", "failures": […]}`) and receipt `config.activation-rollback`; the **recovery boot entry** offers "revert to the previous configuration", which produces a **new** config generation with the previous content and counter + 1, signed with presence (or quorum) in the recovery environment.

### 2.13 TPM objects and PCRs (protocols §19.6)

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

### 2.14 Boot trust set and boot report (protocols §20.1)

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

### 2.15 Owner registry (protocols §20.3)

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

### 2.16 Verify-before-unlock (protocols §20.5)

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

### 2.17 Release statement (protocols §20.6)

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

### 2.18 Generation statement (protocols §20.7)

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

### 2.19 Cross-repository files (protocols §10.7)

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

### 2.20 Quorum presence (protocols §5.4) and presence purposes (protocols §20.2)

Headless profiles (`server`, `server-k8s`, `cloud`, `appliance`) and managed machines use **quorum presence** instead of a local touch. The owner registry (§20.3) then has `policy.mode = "quorum"` and `policy.threshold = N`, with M approver credentials (the owners' FIDO2 credentials, enrolled like any owner credential).

- A **quorum presence envelope** is an ordinary DSSE envelope over the same payload with **≥ N signatures** (§5.3 construction) from credentials of **distinct owners**. Verifiers MUST count distinct owners, not signatures.
- Collection: `hearth` creates a quorum request (`keylos.quorum/1`, §20.18) through `HearthQuorum.request` (§7.5.3); approvers receive it through `fleet` (or out of band as a file), review the rendered payload on their own keylos machine, and sign it there with `hearth presence --remote <request>` (their machine's `hearth` signs with their own credential and rpId `keylos.owner`); signatures return through `HearthQuorum.submit`. The request expires after at most 24 h.
- Every purpose of §20.2 accepts a quorum envelope on quorum machines. On `desktop`/`laptop` profiles quorum envelopes are accepted only for owner-registry changes that the registry policy marks `quorum`.
- **Seal gate on quorum machines.** No touch reaches the machine, so the seal gate's authValue for the window is released differently: `hearth` holds the next gate authValue in a TPM-sealed blob bound to the signed PCR11 `ready` phase and PCR15, and unseals it only after verifying a quorum envelope of purpose `seal.window`. This reduces the guarantee from "a physical touch" to "N approvers signed and the machine runs a verified `hearth`"; the reduction is shown in `status` (`sealing: quorum`).

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

### 2.21 Service table (protocols §20.16)

`boot` reads only `bootstrapGens` from the service table.

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

### 2.22 Recovery key (protocols §20.21)

- **Secret:** 32 random bytes generated by the installer.
- **Text form:** 64 lowercase hex digits in 8 groups of 8; each group is followed by a 2-hex-digit CRC-8 (polynomial 0x07, init 0x00) of that group's 4 bytes; groups are separated by `-`: `xxxxxxxxcc-xxxxxxxxcc-…`. The CRC lets the recovery environment point at a mistyped group. Input is case-insensitive and ignores spaces.
- **LUKS2 recovery keyslot:** passphrase = the 64 hex digits without separators and CRCs; LUKS2 applies Argon2id (m = 1 GiB, t = 4, p = 4).
- **Derivations** (HKDF-SHA256 over the 32-byte secret, salt empty, info strings): `"keylos-recovery-auth/1"` (TPM recovery auth object `0x81000105`), `"keylos-lockout/1"` (TPM lockout auth), `"keylos-recovery-signer/1"` (Ed25519 seed of the owner-registry `recoverySigner`), `"keylos-escrow/1"` (optional backup-escrow wrapping key), `"keylos-recovery-recipient/1"` (X25519 private key of the **recovery recipient**; its public half is stored at `/var/lib/keylos/recovery/recipient.pub` and in the first-boot bundle, and running services encrypt recovery copies to it with HPKE (§4): the owner-hierarchy auth and vault `recovery` slots), `"keylos-sb-pk/1"` (seed of the owner Secure Boot **PK**: an RSA-2048 key generated deterministically with HMAC-DRBG-SHA256 seeded by this output, per FIPS 186-5 appendix B.3.3, so the recovery environment can re-create it to sign KEK updates; the PK is never stored).
- `hearth`, `boot`, `installer` and the trustee tooling MUST use exactly this format.

---

## 3. Requirements

### 3.1 UKI and boot loader

- **REQ-BOOT-001** Every boot entry MUST be a UKI with these sections:
  - `.linux`, `.initrd`, `.cmdline`, `.osrel`, `.uname`, `.sbat`, `.pcrsig`, `.pcrpkey`;
  - on profile-capable stubs, `.profile` sections for the `default` and `recovery` profiles (§4.1).
- **REQ-BOOT-002** Signing:
  - The UKI MUST be signed for Secure Boot. In owner-key mode the signature is by the release-stream Secure Boot signing key, whose certificate is in the owner's `db`. In shim mode it is the vendor key trusted by shim.
  - The kernel and initrd inside MUST NOT be separately loadable.
- **REQ-BOOT-003** The `.cmdline` of the `default` profile MUST contain at least (the `recovery` and `seed` profiles carry the same set plus `keylos.seed=<64 hex>` for `seed`):
  - identity and integrity: `composefs=<64 hex>` (the OS generation fs-verity digest), `keylos.stream=<stream>`, `keylos.seq=<u64 release seq>`, `keylos.revocations=<serial>:<sha256 hex>` (the revocation-list pin of the UKI's **own** release, protocols §10.7: set at release build inside the signed command line; `courier` only verifies it at staging and never writes it), `keylos.recovery=<64 hex>` (recovery generation digest, equal to the release statement's `recoveryGen`, protocols §20.6);
  - kernel policy: `lockdown=integrity`, `module.sig_enforce=1`, `lsm=landlock,lockdown,yama,ipe,bpf`, `ipe.enforce=1`, `ipe.success_audit=0`;
  - the kl-exec hand-over order `keylos.execmapfds=3,4,5,6,7` (protocols §9.3; also passed in `warden`'s argv);
  - initrd entry: `rdinit=/kl-initrd`, `rd.keylos.root=PARTLABEL=keylos-root`;
  - hardening: `slab_nomerge`, `init_on_alloc=1`, `init_on_free=1`, `page_alloc.shuffle=1`, `randomize_kstack_offset=on`, `vsyscall=none`, `debugfs=off`, `oops=panic`, `panic=10`;
  - DMA protection: `iommu=force` (x86: `intel_iommu=on amd_iommu=force_isolation`), `efi=disable_early_pci_dma`;
  - USB before `devd` (protocols §9.5): `usbcore.authorized_default=2` (only devices on internal, hard-wired ports are authorized by the kernel);
  - sysctls: `sysctl.vm.memfd_noexec=2`, `sysctl.dev.tty.legacy_tiocsti=0`, `sysctl.kernel.unprivileged_bpf_disabled=2`, `sysctl.kernel.yama.ptrace_scope=2`.

  `kl-uki` reads the full template from the `keylos` distribution's kernel configuration and MUST refuse a template missing any of these.
- **REQ-BOOT-004** The `.cmdline` MUST NOT be overridable. systemd-boot MUST be built with `editor=no` and the cmdline-override paths disabled. With Secure Boot active, systemd-stub ignores a passed cmdline when `.cmdline` exists; the build also compiles that path out.

### 3.2 Measurement and unlock

- **REQ-BOOT-010** PCR11 phases:
  - `kl-initrd` MUST extend PCR11 with `enter-initrd` at its start (default profile) or `enter-recovery` (recovery profile), and with `leave-initrd` immediately before `switch_root` (default profile only).
  - `sysinit` and `ready` are extended by `warden` after `switch_root` (protocols §19.6). No `boot` tool extends PCR11 after the initrd.
  - The strings, the hash algorithm (SHA-256 bank) and the encoding MUST be byte-identical to systemd-pcrphase, so that predictions made with systemd-measure-compatible tooling hold.
- **REQ-BOOT-011** The disk unlock secret MUST be sealed under the composite policy of §4.4. In the default profile no other unlock mechanism may exist besides the recovery key (§4.12).
- **REQ-BOOT-012** `kl-initrd` MUST NOT try any LUKS keyslot other than the `keylos-tpm2` token's keyslot (default profile) or the recovery keyslot (recovery profile). Empty-passphrase probing, keyfile search and fallback chains are forbidden.
- **REQ-BOOT-013** TPM sessions MUST be salted with the SRK (`0x81000001`). The SRK public key MUST match the value pinned at enrolment (the token field `srk_pub`). A mismatch MUST abort unlock with a visible "TPM identity mismatch" error.
- **REQ-BOOT-014** After unlocking, `kl-initrd` MUST verify volume identity (§4.5) and extend PCR15 before mounting anything from the volume.
- **REQ-BOOT-015** `kl-initrd` MUST extend PCR11 with `leave-initrd` before executing anything from the root filesystem. After that, the disk unlock policy is unsatisfiable.

### 3.3 Root and configuration

- **REQ-BOOT-020** The OS generation MUST be mounted with the procedure of §4.6. Its EROFS image's `FS_IOC_MEASURE_VERITY` digest MUST equal the `composefs=` value. On a mismatch or a missing image, `kl-initrd` MUST offer only the boot-menu fallback (reboot with the boot counter decremented) or recovery.
- **REQ-BOOT-021** The owner registry (protocols §20.3) MUST be replayed from `/var/lib/keylos/hearth/owners.log`, and its computed head MUST equal NV `0x01300105` (§4.7.1). If it does not, `kl-initrd` MUST treat the owner-presence key set as empty, which forces the safe config.
- **REQ-BOOT-022** The config generation MUST be chosen per protocols §15: the highest-counter `keylos.configgen/1` statement that verifies against the owner-presence keys of the replayed registry, with `counter ≥` NV `0x01300101`. If none qualifies, boot MUST continue with the **safe config** shipped in the OS generation (`/usr/share/keylos/safe-config/`) and set `safeConfig: true` in the trust set and boot report. `atrium` shows the condition as a critical warning.
- **REQ-BOOT-023** `/etc` MUST be the merged confext of the selected config generation, mounted read-only, `nosuid,nodev,noexec`, with `verity=require`.

### 3.4 Code integrity

- **REQ-BOOT-030** `kl-initrd` MUST load and attach the `kl-exec` BPF LSM program before it executes any file other than itself. The program is embedded in the `kl-initrd` binary.
- **REQ-BOOT-031** Before `switch_root`, `kl-initrd` MUST:
  1. register the OS generation's overlay superblock in `kl_exec_allowed_sb`, after the registration steps of protocols §9.3: the image digest check, the generation statement verified against the release-stream keys, and the revocation list check (§4.9.2);
  2. set `kl_exec_policy` to `{enforce: 1, audit_allow: 0, phase: SYSTEM, warden_tgid: 1}` (PID 1 keeps thread-group ID 1 across `switch_root` and `execve`, so `warden` core inherits it);
  3. freeze `kl_exec_policy`.
- **REQ-BOOT-032** `kl-initrd` MUST write the boot trust set (protocols §20.1) with keys from exactly the sources protocols names:
  - stream keys from the UKI (`.pcrpkey` and the embedded release-stream list, §4.1);
  - owner-presence keys from the replayed owner registry;
  - owner-seal keys from `/etc/keylos/owner-seal/*.spki` of the selected config generation;
  - publisher keys from `/etc/keylos/publishers.json` of the selected config generation;
  - `bootstrapGens` from `/etc/keylos/services.json` (`bootstrapGens`, protocols §20.16).
- **REQ-BOOT-033** The IPE policy of protocols §9.3 MUST be activated before `switch_root`.
- **REQ-BOOT-034** The five `kl-exec` map fds MUST be passed to `warden` as fds 3–7 in the order `kl_exec_allowed_sb`, `kl_exec_jit_cgroups`, `kl_exec_policy`, `kl_exec_events`, `kl_debug_pairs`, with `keylos.execmapfds=3,4,5,6,7` in `warden`'s argv; the boot report is fd 8 (`keylos.bootreportfd=8`, protocols §20.1); the ten hook link fds are fds 9–18 (`keylos.execlinkfds=9,10,11,12,13,14,15,16,17,18`, protocols §9.3 "Links"). `kl-initrd` MUST create the links with `BPF_LINK_CREATE` and MUST NOT pin anything in bpffs, so no pin exists after `switch_root`.
- **REQ-BOOT-035** The `kl-exec` program MUST implement every hook row of protocols §9.3, including `bprm_creds_for_exec` for check-only execs (`AT_EXECVE_CHECK`), `ptrace_access_check` without exemptions, and `perf_event_open` plus `perf_event_alloc` keyed by `kl_debug_pairs`, with the numeric values of protocols §9.3 (phase, hook IDs, event fields, kernel `dev_t`), the debugger tracing exception of the `bpf` hook, and the open-broker pair rule of protocols §9.3: for a pair created by `LegacySpawn`, `PTRACE_MODE_READ` and `PTRACE_MODE_ATTACH_REALCREDS` are permitted (the latter is what `process_vm_readv` checks), every other mode is denied (§4.9.1).
- **REQ-BOOT-036** `kl-initrd` MUST NOT read any TPM NV index with owner-hierarchy authorization. It reads counters, the floor, the owner-registry head and the attestation-key names through the public `PolicyCommandCode(TPM2_CC_NV_Read)` branch of each index's authPolicy (protocols §19.6).

### 3.5 Verify-before-unlock and recovery

- **REQ-BOOT-040** When VBU is enrolled, `kl-initrd` MUST offer VBU (protocols §20.5) before the PIN prompt. With `vbu = "required"`, the PIN prompt MUST NOT appear until either:
  - the owner confirms on the keyboard that the phone showed VERIFIED; or
  - the owner explicitly chooses "skip verification", which is recorded in the boot report as `vbu: "skipped"`.
- **REQ-BOOT-041** The recovery profile MUST:
  - unlock only with the recovery key (text format of protocols §20.21, CRC-checked per group before any KDF work);
  - extend PCR11 with `enter-recovery` instead of `leave-initrd`, so no PCR11-bound TPM secret is releasable;
  - start the recovery generation named by `keylos.recovery=` as PID 1 in place of `warden`.

  There is no separate recovery UKI (protocols §20.6): the recovery environment is the `recovery` profile of each UKI.
- **REQ-BOOT-043** The default profile MUST never select a config generation whose counter is below NV `0x01300101`, even when the newest generation's activation failed (protocols §15). Activation failure is handled only by the recovery environment, which creates a **new** generation with the previous content and counter + 1.
- **REQ-BOOT-044** `kl-initrd` MUST determine the **integrity profile** (protocols §2.2) at every boot and record it in the boot report (`integrity`, §4.10): `full`, `shared-boot` (owner keys plus the Microsoft Windows or third-party UEFI CA in `db`), `shim` (booted through shim, PCR14 non-empty), `cloud-vtpm` / `cvm` (cloud profile; `cvm` when a confidential-VM platform is detected and its report is available), or `degraded` (no TPM, or Secure Boot off).
- **REQ-BOOT-045** Initrd USB authorizer (protocols §9.5). Before any prompt (P6/P7), `kl-initrd` MUST authorize, by writing `1` to `/sys/bus/usb/devices/<dev>/authorized`, exactly: external USB hubs, and external devices **all** of whose interfaces have `bInterfaceClass = 0x03` (HID). It MUST NOT authorize storage, network, audio, video, vendor-specific or composite devices with any non-HID interface, and it MUST NOT read `preauthorized.json` (that is `devd`'s, after `switch_root`). It records every device it authorized (`vendor:product:serial:port`) in the boot report's `x-initrdUsb` list so `devd` can re-evaluate them. Keystrokes in the initrd reach only the VBU, PIN and recovery-key prompts.
- **REQ-BOOT-046** `seed` profile (cloud UKIs only; protocols §20.6, §20.13). When booted with the `seed` profile, `kl-initrd` MUST:
  1. extend PCR11 `enter-initrd` (P1) exactly as the default profile;
  2. refuse to continue (halt with "machine already provisioned") if a `PARTLABEL=keylos-root` LUKS2 volume with a `keylos-tpm2` token exists, so a provisioned machine can never be re-seeded;
  3. perform P2–P5 and the USB authorizer, skip P6–P13 (there is no disk to unlock yet), mount the seed generation named by `keylos.seed=<64 hex>` in that profile's command line with the same registration steps as the OS generation (§4.9.2), and write a trust set with `safeConfig: true` and no owner keys;
  4. extend PCR11 `leave-initrd` and start the seed generation (`installer`'s `keylos-seed`) as PID 1 with fds 3–8, exactly as `warden` would be started.

  The seed stage then extends `sysinit` and `ready` itself (its predictions are the release's `pcr11Seed`), which is what lets it initialise the floor under the floor-write approval. After provisioning it makes the `default` profile the persistent boot entry and reboots; `kl-initrd` never selects the `seed` profile on its own.
- **REQ-BOOT-042** Hibernation is unsupported (protocols §2). `kl-initrd` MUST NOT look for, or resume from, a hibernation image. Any swap partition is opened with a fresh random key every boot.

---

## 4. Design

### 4.1 UKI layout

| Section | Content | Measured into PCR11 by systemd-stub |
|---|---|---|
| `.linux` | Kernel image | yes |
| `.osrel` | `ID=keylos`, `VERSION_ID=<semver>`, `IMAGE_ID=keylos-<stream>`, `IMAGE_VERSION=<seq>` | yes |
| `.cmdline` | REQ-BOOT-003 | yes |
| `.initrd` | `cpio` archive (newc, zstd) containing: `kl-initrd`; the kernel modules needed to reach the root (NVMe, AHCI, virtio, USB HID for PIN entry, simpledrm where required); firmware for those; the IPE policy (PKCS#7); `release-keys.json`, the release-stream public keys of the subscribed streams; nothing else | yes |
| `.uname` | Kernel release | yes |
| `.sbat` | `sbat,1`, `systemd-stub,1`, `keylos,1`, `keylos-uki,<sbat generation>` | yes |
| `.pcrpkey` | DER SubjectPublicKeyInfo of the release-stream PCR-signing key (ECC P-256) | yes |
| `.pcrsig` | JSON with the signed PCR11 policies (§4.4): for phase `enter-initrd` the unlock policy (`keylos/unlock/1`), for phase `ready` the floor-write (`keylos/floor-write/1`) and pcrlock-write (`keylos/pcrlock-write/1`) policies, in the systemd `.pcrsig` JSON format (`{"sha256": [{"pcrs": [11], "pkfp": "<hex>", "pol": "<hex>", "sig": "<base64>", "ref": "<policyRef>"}]}`) | no (excluded by the stub) |
| `.profile` | Two profiles: `default` (`ID=default`) and `recovery` (`ID=recovery`, whose `.cmdline` adds `keylos.mode=recovery`) | per profile |

- **Filename on the ESP:** `/EFI/Linux/keylos_<seq>+<tries-left>-<tries-done>.efi` (systemd boot counting). `courier` owns these files.
- **`kl-uki build`** assembles the UKI from a kernel, an initrd and the cmdline template. It computes the expected PCR11 and PCR12 values for every phase and profile, and emits:
  - `uki.efi` (unsigned);
  - `pcr11.json` (per phase and profile) and `pcr12.json`;
  - `policy-unlock.digest`, `policy-floor.digest` and `policy-pcrlock.digest`, the approved-policy digests to be signed by the stream PCR key;
  - `release-pcr.json`, the `profiles.<p>.pcr11` and `pcr12` fragments of the release statement (protocols §20.6).
- **Signing** is a separate derivation (signatures are always detached): `kl-uki sign` inserts `.pcrsig` and produces the Authenticode signature.

### 4.2 PCR usage

Normative assignments are in protocols §19.6. This table adds how `boot` uses them.

| PCR | Measured by | Content | Used in |
|---|---|---|---|
| 0, 2, 4, 7 (14 in shim mode) | Firmware (shim) | Firmware, option ROMs, boot loader and UKI images, Secure Boot state | pcrlock branch selection (NV `0x01300103`) |
| 1, 3, 5 | Firmware | Configuration, GPT | not used (too volatile) |
| 9 | Kernel | initrd (LoadFile2) | not used (covered by PCR11 `.initrd`) |
| 11 | systemd-stub, `kl-initrd`, `courier` | UKI sections; phases | Signed policies (§4.4) |
| 12 | systemd-stub | Kernel command line, credentials | VBU check (release `pcr12`); not in the unlock policy |
| 13 | systemd-stub | System extensions (none) | VBU check ("no extension" value) |
| 15 | `kl-initrd` | Volume identity | Policies of later secrets (vault, hearth, ledger, strata, AK) |

### 4.3 `kl-initrd` program

`kl-initrd` is a static musl Rust binary. Phases:

```
P0  early:       mount /proc /sys /dev(devtmpfs) /run(tmpfs) /sys/fs/bpf; set console; parse cmdline
P1  measure:     extend PCR11 "enter-initrd" (every profile)
P2  kl-exec:     load (offsets from /sys/kernel/btf/vmlinux) + attach BPF LSM (embedded ELF) with BPF_LINK_CREATE links,
                 kl_exec_policy {enforce:1, audit_allow:0, phase:INITRD}
P3  ipe:         load + activate the IPE policy (PKCS#7, kernel-policy key in the secondary keyring)
P4  modules:     load modules listed in initrd.toml (kernel enforces signatures)
P4a usb:         initrd USB authorizer (REQ-BOOT-045): authorize external hubs and all-HID devices only
P5  devices:     wait for root device (PARTLABEL=keylos-root), max 30 s (uevent netlink)
P6  vbu:         if enrolled → §4.11
P7  pin:         prompt PIN (text console or simpledrm framebuffer renderer; keyboard via evdev)
P8  unseal:      §4.4 → keyslot passphrase
P9  open:        LUKS2 activate (dm-integrity AEAD + dm-crypt) as /dev/mapper/keylos-root
P10 identity:    §4.5 → extend PCR15
P11 mount:       btrfs subvolumes @store,@var,@home,@keystore,@snapshots; composefs OS generation at /sysroot (§4.6)
P12 registry:    replay owner registry (NV read via the public NV_Read branch), check NV head (§4.7.1)
P13 config:      select + verify config generation (§4.7.2), mount confext at /sysroot/etc
P14 integrity:   revocation list (§4.9.2); register OS gen superblock in kl_exec_allowed_sb; write trust.json (§4.10)
P15 finalize:    kl_exec_policy {enforce:1, audit_allow:0, phase:SYSTEM, warden_tgid:1}; bpf_map_freeze; write report.json
P16 leave:       extend PCR11 "leave-initrd" (recovery profile: "enter-recovery"); move /run,/proc,/sys,/dev into /sysroot;
                 switch_root (MS_MOVE + chroot);
                 execve("/usr/lib/keylos/warden", ["warden","keylos.execmapfds=3,4,5,6,7","keylos.bootreportfd=8",
                        "keylos.execlinkfds=9,10,11,12,13,14,15,16,17,18"])
                 with fds 3..7 = maps, fd 8 = report pipe, fds 9..18 = hook links
```

- **P1.** `enter-initrd` is extended by `kl-initrd` itself as its first action, byte-identical to systemd-pcrphase (protocols §19.6 names `kl-initrd` as its extender). systemd-stub measures only the UKI sections. The recovery profile also extends `enter-initrd` at P1, and extends `enter-recovery` at P16 instead of `leave-initrd`. The `seed` profile follows REQ-BOOT-046.
- **P4a.** The authorizer runs after module loading so that `usbhid`/`hid-generic` are present, re-scans when new devices appear until P8 completes, and is idempotent. Devices it does not authorize stay unbound until `devd` decides about them.
- **P0–P15.** `kl_exec_policy.phase = INITRD` allows execution from the initramfs superblock only, and `kl-initrd` executes nothing; it is the only process. P2 runs before any other exec.
- **P7 safe start.** The PIN prompt offers "Safe start" (a key shown on the prompt). It changes nothing in measurement or unlock; it only sets `x-safeStart: true` in the boot report, which makes `warden` expose app data read-only and `atrium` skip session restore (§4.12, protocols §9).
- **Display.** `kl-initrd` renders prompts with a built-in bitmap font (`font8x16`) to the simpledrm or efifb framebuffer, through DRM dumb buffers or `/dev/fb0`. No GPU driver is loaded in the initrd unless `initrd.toml` lists one for the platform.

### 4.4 Unlock policy

#### 4.4.1 Sealed object and token

The LUKS2 header carries a token of type `keylos-tpm2` (a format local to this repository; written by `kl-boot enroll-tpm`):

```json
{"type":"keylos-tpm2","keyslots":["1"],"version":1,
 "srk_pub":"<base64 TPM2B_PUBLIC>","srk_handle":2164260865,
 "blob":"<base64 TPM2B_PRIVATE||TPM2B_PUBLIC>",
 "policy":"<hex final policy digest>",
 "stream_key":"<hex sha256 of .pcrpkey SPKI>","stream_ref":"keylos/unlock/1",
 "pcrlock_nv":"0x01300103","floor_nv":"0x01300102",
 "pcrlock_branches":[{"sel":[0,2,4,7],"values":{"0":"<hex>","2":"<hex>","4":"<hex>","7":"<hex>"}}],
 "pin":true,"pin_salt":"<base64 16 bytes>",
 "volume_identity":"<hex>","machine_key":"key:sha256:<hex>",
 "ui":{"vbu":"optional","pinAttemptsPerBoot":5,"console":{"keymap":"us","font":"font8x16"}},
 "enrolled":"<RFC 3339>"}
```

- The sealed data is a KEYEDHASH object holding a 64-byte random passphrase for the dedicated keyslot 1, not the volume key itself.
- The PIN's TPM auth value is `HKDF-SHA256(ikm = PIN (UTF-8, NFKC), salt = pin_salt, info = "keylos-tpm2-pin/1")`, truncated to 32 bytes. The TPM's dictionary-attack protection applies: lockout after 32 failures, recovery of one failure per 10 minutes, as configured at enrolment.
- `machine_key` is the machine identity key ref (protocols §3.5). VBU needs it before unlock (QR1 key 3).
- `pcrlock_branches` is written by `courier` (through `kl-boot-tpm`) alongside every NV `0x01300103` update. It tells `kl-initrd` which PCR selection and branch values to submit.

#### 4.4.2 Policy composition

The object's `authPolicy` is the digest of this sequence, evaluated in a salted policy session:

```
1.  TPM2_PolicyPCR(sel = sha256:{11}, digest = expected PCR11 at enter-initrd)              ┐ stream-signed part,
2.  TPM2_PolicyNV(nvIndex = 0x01300102, operandB = <seq as u64 BE>, offset 0, op = UNSIGNED_LE) │ approved per release
3.  TPM2_PolicyAuthorize(approvedPolicy = digest(1..2), policyRef = "keylos/unlock/1",      ┘
                         keySign = stream PCR-signing key, checkTicket = TPM2_VerifySignature(.pcrsig))
4.  TPM2_PolicyPCR(sel = sha256:{0,2,4,7[,14]} minus unpredictable, digest = current values) ┐ machine-specific part,
    [TPM2_PolicyOR(branches) when the NV holds an OR composition]                              │ maintained by courier
5.  TPM2_PolicyAuthorizeNV(nvIndex = 0x01300103)                                              ┘
6.  TPM2_PolicyAuthValue()                                                                     PIN
7.  TPM2_PolicyCommandCode(TPM2_CC_Unseal)
```

Semantics:
- **Steps 1–3.** Only a UKI whose PCR11 matches a stream-signed prediction can proceed. Step 2 checks `NV(floor) ≤ seq`. Once the floor (the release statement's `floor`, written by `courier`, protocols §20.6) exceeds `seq`, every signed policy for release `seq` is invalid. The floor check sits inside the signed part, so the sealed object never needs re-sealing when the floor moves.
- **Steps 4–5.** After step 3, the session digest is the constant `H(TPM2_CC_PolicyAuthorize ‖ keyName ‖ policyRef)`. Step 4 extends it, and step 5 requires the result to equal the NV-stored digest. `courier` (and `installer` at enrolment) compute that NV digest from the constant start digest and the predicted PCR values (§4.4.3).
- **Unpredictable PCRs.** If a PCR cannot be predicted (unrecognised event log records), it is dropped from the selection in step 4. The NV policy encodes the selection, so a policy update suffices.

#### 4.4.3 pcrlock NV policy content

NV `0x01300103` holds a TPM2B_DIGEST equal to:

```
D_start = PolicyAuthorize start digest for (streamKey, "keylos/unlock/1")   (constant per stream key)
D_pcr   = H(D_start ‖ TPM2_CC_PolicyPCR ‖ TPML_PCR_SELECTION ‖ H(concat PCR values))
NV      = D_pcr, or D_or = PolicyOR(D_pcr_a, D_pcr_b, …) with up to 8 branches
```

When several states are allowed (old and new firmware during an update, or rollback entries), steps 4–5 become `PolicyPCR` → `PolicyOR(branches)` → `PolicyAuthorizeNV`.

**Write authorization** (protocols §19.6): `PolicyOR{PolicyAuthorize(release-stream key, "keylos/pcrlock-write/1"), PolicySecret(recovery auth object 0x81000105)}`.
- The stream key signs, per release, the approved policy `PolicyPCR(sha256:{11} = expected PCR11 at "ready") ∧ PolicyCommandCode(TPM2_CC_NV_Write)`. That signature is carried in the UKI's `.pcrsig`.
- The recovery branch lets the recovery environment rewrite the policy after unlocking with the recovery key (§4.12).

#### 4.4.4 Floor write policy

NV `0x01300102` (protocols §19.6) is `POLICYWRITE` with an empty authValue and `AUTHREAD` (so anyone can read it, including through `TPM2_PolicyNV`); its authPolicy is `PolicyOR{PolicyCommandCode(TPM2_CC_NV_Read), PolicyAuthorize(release-stream key, "keylos/floor-write/1")}`. The stream key signs **exactly one** approved floor-write policy per UKI, binding one exact target `F` = that release's `floor` (protocols §20.6):

```
OS UKI (phase ready):
  1. TPM2_PolicyPCR(sha256:{11} = expected PCR11 of this UKI at "ready")
  2. TPM2_PolicyNV(nvIndex = 0x01300102, operandB = u64_be(F), offset 0, op = TPM_EO_UNSIGNED_LE)   current ≤ F
  3. TPM2_PolicyCpHash(cpHash = H(TPM2_CC_NV_Write ‖ Name(0x01300102) ‖ Name(0x01300102) ‖ TPM2B(u64_be(F)) ‖ u16 offset 0))
Installer UKI (phase ready) and cloud UKI seed profile (seed ready):
  1. TPM2_PolicyPCR(sha256:{11} = expected PCR11 at ready / seed ready)
  2. TPM2_PolicyNvWritten(writtenSet = NO)                                                           initialisation only
  3. TPM2_PolicyCpHash(write of u64_be(F) at offset 0, as above)
```

Consequences, and the exact claim:
- Only a genuine UKI of the release, after reaching `ready`, can write the floor, and only the value `F` of that release. PCR11 at `ready` is unique to the measured UKI, so during one boot every policy session (stale, concurrent or replayed) can satisfy only the one approved policy of the running UKI and can only write the same `F`; the `PolicyNV` check is not an atomic compare-and-swap, but because every satisfiable write in a boot writes the same value it cannot be used to decrease the floor.
- Older releases' approved policies need their own PCR11 and are unsatisfiable. A write of another value, another offset, a partial write or a write to another index does not match the `cpHash` and fails.
- **Claim:** the floor cannot decrease, provided that (a) the release-stream key is not compromised and (b) release tooling never signs two floor-write policies with different `F` for the same UKI digest (keylos spec; the release log makes a violation detectable). A malicious tier-0 process with TPM access can at worst write the running release's own `F`, which `courier` would write anyway.
- The installer and seed policies work only on an index that has never been written (`PolicyNvWritten(NO)`), so they cannot lower an initialised floor.
- **Missing or unreadable floor after provisioning** (index absent after a TPM clear, or reads failing after an interrupted write): the unlock policy's step 2 fails, so the default profile cannot unlock. This is a recovery and re-enrolment condition (§4.12), never silently repaired: the TPM history is gone, and the new baseline is the `floor` of the signed release statement of the release being re-enrolled, written by the installer path of the recovery environment after it re-defines the index with the owner authorization.

#### 4.4.5 Unseal procedure

1. Read the token. Load the SRK public area (`ReadPublic 0x81000001`) and compare it with `srk_pub`. On a mismatch, abort with "TPM identity mismatch".
2. Start a salted, encrypted policy session: salt key = SRK, symmetric AES-128-CFB, parameter encryption on.
3. Execute steps 1–7. Step 3 uses the `.pcrsig` signature for phase `enter-initrd` with `ref = "keylos/unlock/1"`, verified via `TPM2_VerifySignature` against the external public key loaded from `.pcrpkey`. Step 4 uses the branch from `pcrlock_branches` that matches the current PCR values.
4. `TPM2_Unseal` with the PIN auth value. The response parameters are encrypted.
5. On `TPM_RC_AUTH_FAIL` (wrong PIN), re-prompt: at most `pinAttemptsPerBoot` attempts (default 5), then offer reboot or recovery. On `TPM_RC_LOCKOUT`, display the time until the next try and offer recovery.
6. On `TPM_RC_POLICY_FAIL`:
   - at step 2, display "This release is older than the minimum allowed. Boot a newer entry." and return to the boot menu with the counter decremented;
   - at steps 4–5, display "Firmware or boot configuration changed", with the summary of PCRs differing from every branch, and offer recovery.

### 4.5 Volume identity

After activation:

```
id_key   = HKDF-SHA256(ikm = volume key (libcryptsetup volume_key_get with the unsealed passphrase),
                       salt = LUKS2 UUID bytes, info = "keylos-volume-identity/1")
identity = SHA-256("keylos-volume/1" ‖ LUKS2 UUID (16 bytes) ‖ id_key)
check    identity == token.volume_identity          (constant-time)
extend   PCR15 ← SHA-256("keylos-volume/1" ‖ identity)
```

- **Mismatch.** A mismatch means the unsealed secret opened a *different* volume, which is impossible without an attacker who controls a keyslot equal to the sealed passphrase. `kl-initrd` closes the mapping, wipes key material, and halts with "Volume identity mismatch: this disk is not the enrolled disk".
- **Later secrets.** These include `PolicyPCR(15 = expected)`, with the expected value computed at enrolment: the vault keystore wrapping key, hearth's keys, the ledger signing key, the strata anchor HMAC key (`0x81000110`) and the AK (`0x81010002`).
- **Pre-unlock state.** PCR15 is all zeros before unlock; VBU checks that (protocols §20.5 step 4).

### 4.6 Mounting the OS generation

```
mount btrfs subvol=@store  → /sysroot/store           (ro at this stage; warden remounts rw for depot)
fd = open("/sysroot/store/gens/<hex>.erofs", O_RDONLY)
assert FS_IOC_MEASURE_VERITY(fd) == fsv256 <hex>                   (REQ-BOOT-020)
ero  = fsopen("erofs");   fsconfig(source, "/proc/self/fd/<fd>"); fsconfig(ro); m_ero = fsmount(ero)
ovl  = fsopen("overlay")
fsconfig(ovl, FSCONFIG_SET_FD,     "lowerdir+", m_ero)
fsconfig(ovl, FSCONFIG_SET_STRING, "datadir+",  "/sysroot/store/objects")
fsconfig(ovl, FSCONFIG_SET_STRING, "metacopy",  "on")
fsconfig(ovl, FSCONFIG_SET_STRING, "redirect_dir", "follow")
fsconfig(ovl, FSCONFIG_SET_STRING, "verity",    "require")
m_root = fsmount(ovl, 0, MOUNT_ATTR_RDONLY|MOUNT_ATTR_NOSUID|MOUNT_ATTR_NODEV)
move_mount(m_root, "", AT_FDCWD, "/sysroot", MOVE_MOUNT_F_EMPTY_PATH)
mount @var → /sysroot/var (nosuid,nodev,noexec); @home → /sysroot/home (nosuid,nodev,noexec);
      @keystore → /sysroot/keystore (nosuid,nodev,noexec, mode 0700); @snapshots → /sysroot/snapshots (same)
```

- `verity=require` makes overlayfs refuse to open any non-empty data file whose fs-verity digest does not match the metacopy xattr.
- Together with the image digest check, every byte of `/` is bound to the cmdline digest. Zero-length files are inline in the EROFS image (protocols §6.2), so they are covered by the image digest.

### 4.7 Owner registry and config generation

#### 4.7.1 Owner registry replay

1. Read NV `0x01300105` (104 bytes): `H_line ‖ seq ‖ H_keys ‖ H_sbcerts`, through the index's public `PolicyCommandCode(TPM2_CC_NV_Read)` policy branch (REQ-BOOT-036).
2. Read `/sysroot/var/lib/keylos/hearth/owners.log` (bounded at 4 MiB and 4 096 lines). Each line is a presence-signed DSSE of `keylos.owners-entry/1`.
3. Replay from `genesis`, checking for each entry:
   - `seq` increments by 1 and `prev` equals the SHA-256 of the previous line's bytes;
   - the signature satisfies protocols §5.3 (rpId `keylos.owner`, UP set, UV set) against the credential set **as of the previous entry**; signatures are stateless-verified (no `signCount` check);
   - for `add-owner`, `remove-owner`, `set-secureboot-certs` and `set-quorum`, signatures by at least `policy.quorum` **distinct owners** (protocols §5.4 counting rule) of the policy in force before the entry;
   - for `enroll-credential` and `remove-credential`, a signature by an existing credential of the same owner, or a quorum;
   - for `recover`, the signature is by `recoverySigner`;
   - `ownerIndex` is 0–15 and unique among live owners; `sealKey`, when present, parses as a P-256 SPKI;
   - the state machine tracks `policy.mode` (`touch` or `quorum`) and `policy.threshold`, and the `assisted` and `seal` flags of each credential.
4. Require `SHA-256(last line bytes) = H_line`, `seq = seq_NV`, `SHA-256(JCS(owner-presence key set)) = H_keys` and `SHA-256(JCS(owner Secure Boot certificate set)) = H_sbcerts`.
5. The resulting owner-presence key set (with each key's owner) and the registry policy feed `trust.json` `keys.ownerPresence` and config verification. On any failure, the key set is empty (REQ-BOOT-021).

#### 4.7.2 Config generation selection

1. Read NV `0x01300101`, the config counter `C`, through the public NV_Read branch (REQ-BOOT-036).
2. Collect candidate statements from `/sysroot/var/lib/keylos/config/*.dsse` (protocols §10.7), at most 4 096, newest first by file time.
3. Verify each `keylos.configgen/1` envelope: with registry `policy.mode = "touch"`, a presence signature (protocols §5.3, purpose `config.apply`, UV required) by a key in the replayed owner-presence set; with `policy.mode = "quorum"`, signatures by at least `policy.threshold` distinct owners (protocols §5.4).
4. Take the statement with the highest `counter` where `counter ≥ C`.
5. Mount its generation as a confext:
   - check the image digest with `FS_IOC_MEASURE_VERITY`;
   - EROFS plus overlay at `/sysroot/etc`, with `verity=require`, `nosuid`, `nodev`, `noexec`.
6. If none qualifies, use the safe config: set `safeConfig: true` and mount `/usr/share/keylos/safe-config/` (part of the OS generation) as `/sysroot/etc`.

The confext provides `/etc/keylos/owner-seal/<i>.spki`, `/etc/keylos/publishers.json` and `/etc/keylos/services.json`, which feed the trust set (REQ-BOOT-032).

### 4.8 IPE policy

IPE is a second, independent layer; `kl-exec` is the primary enforcement after `switch_root`.
- The policy text is fixed by protocols §9.3. It is signed (PKCS#7) by `kernel-policy/<stream>`, whose X.509 certificate is built into the kernel's secondary keyring at build time.
- It is loaded through `/sys/kernel/security/ipe/new_policy`, then activated by writing `1` to `/sys/kernel/security/ipe/policies/keylos/active`.
- kexec is disabled; `warden` performs only full reboots.

### 4.9 kl-exec BPF LSM program

#### 4.9.1 Program

The program is written in Rust with `aya-ebpf`, compiled to BPF bytecode at build time, and embedded in `kl-initrd`. The hooks, decisions, numeric values, map contract and link hand-over are protocols §9.3. Each hook is attached with a `BPF_LSM_MAC` link created by `BPF_LINK_CREATE`; nothing is pinned in bpffs. An attachment lives as long as a link fd is open, so `kl-initrd` passes the ten link fds to `warden` as fds 9–18 (REQ-BOOT-034) and `warden` keeps them for its lifetime (closing them detaches `kl-exec`).

Implementation rules:
- The **initramfs superblock** is identified at P2 by `statx("/", …)` of the initramfs root and stored, as the kernel `dev_t` (`major << 20 | minor`, protocols §9.3), in the program's read-only `.rodata` before load.
- **No CO-RE.** `aya-ebpf` has no field relocations, so the program reads kernel structures at offsets the loader computes from `/sys/kernel/btf/vmlinux` and writes into `.rodata` (`KL_OFFSETS`) before load. The object is independent of one kernel build's layout; a missing member fails the load (and `kl-initrd` halts). The kernel MUST have BTF (`CONFIG_DEBUG_INFO_BTF`) and, on arm64, the ftrace options BPF trampolines need (`keylos` kernel configuration).
- **`bprm_creds_for_exec`** applies the exec rule only when `bprm->is_check` is set (`AT_EXECVE_CHECK`); regular execs are decided in `bprm_check_security`, so each denial logs once.
- Each denial pushes `{cgroup_id, pid, hook, s_dev, ino}` into `kl_exec_events` (a 1 MiB ring buffer) with the hook IDs and detail fields of protocols §9.3; with `audit_allow = 1`, allowed decisions are pushed too with bit 31 of `hook` set. `PTRACE_MODE_NOAUDIT` probes are refused without an event, so `/proc` field filtering cannot flood the ring buffer.
- **`bpf` hook.** `BPF_PROG_LOAD`, `BPF_LINK_DETACH` and `BPF_PROG_DETACH` are allowed for: the task whose thread-group ID equals `kl_exec_policy.warden_tgid` (1); any task while `phase = INITRD` (`kl-initrd` is then the only process); and a task whose cgroup has an unexpired `kl_debug_pairs` entry with scope `kernel`, for program types `KPROBE`, `TRACEPOINT`, `RAW_TRACEPOINT` and `PERF_EVENT` only. Everything else is `-EPERM`. The decision does not depend on cgroup membership, so the core-dump helper's brief stay in the root cgroup grants it nothing (protocols §9.3).
- **`ptrace_access_check` hook.** No task is exempt, the `warden` core included (protocols §9.3: `warden` supervises through pidfds and clone-time namespace fds). Allowed only if the tracer's cgroup ID has an unexpired `kl_debug_pairs` entry and the tracee's cgroup is the entry's target cgroup or a descendant of it (ancestor walk on the tracee's cgroup, at most 8 levels). For entries whose `expires` is `u64::MAX` (open-broker pairs, protocols §9.3) only checks with mode `PTRACE_MODE_READ` or `PTRACE_MODE_ATTACH_REALCREDS` pass (the latter is the check the kernel performs for `process_vm_readv`); the open broker's seccomp profile `openbroker-1` denies `ptrace`, `process_vm_writev` and `pidfd_getfd`, so `process_vm_readv` is the only path that reaches the attach-mode check. Every other mode is refused. A `PTRACE_ATTACH` call by the open broker would pass the same `PTRACE_MODE_ATTACH_REALCREDS` check; only `openbroker-1` stops it, as protocols §9.3 states. Expired entries are treated as absent; deletion is `warden`'s job.
- **`perf_event_open` and `perf_event_alloc` hooks.** `perf_event_open` sees only the `PERF_SECURITY_*` type (a cgroup event also raises `CPU`), so it admits only tasks with an unexpired `kl_debug_pairs` entry and records the request in an internal LRU map (`kl_perf_open`, not handed over). `perf_event_alloc` then checks only events of recorded requests: scope `process` permits task events whose `hw.target` is inside the target cgroup and cgroup events on the target cgroup, and refuses CPU-wide events; scope `kernel` permits system-wide events. Kernel-internal counters (watchdog, ptrace hardware breakpoints) are never recorded and pass. Everything else is `-EACCES`.
- **`kernel_load_data`** is denied in every phase, INITRD included.
- **`file_mprotect` on composefs mappings** is refused outside JIT cgroups (the hook sees the backing file, protocols §9.3 "Known limitation"); revisit when the kernel offers the overlay file to the hook.
- `kl_exec_policy` is written once at P2 (`phase: INITRD`, `warden_tgid: 0`) and once at P15 (`phase: SYSTEM`, `warden_tgid: 1`), then frozen with `bpf_map_freeze`.
- `kl_debug_pairs` is created empty (256 entries) at P2; the initrd never writes it.

Soundness of the "allowed superblock" decision:
1. The composefs overlay was mounted with `verity=require` from an image whose digest was checked (by `kl-initrd`, or by `depot` and `warden`).
2. Overlay superblocks are not shared across mounts made from other images.
3. Only the `warden` core holds the map fds after hand-over, and only `warden_tgid` can load or detach programs.

Bind clones of the same mount share the superblock, and therefore the decision.

#### 4.9.2 OS generation registration

Before adding the OS generation's `s_dev`, `kl-initrd`:
1. reads `/sysroot/store/evidence/<os hex>/statement.dsse` and verifies it as `keylos.genstmt/1` for the OS generation, signed by a key in `release-keys.json`;
2. reads `/sysroot/store/revocations/<stream>.dsse` and verifies it with the same keys;
   - it requires `serial ≥ <serial>` of `keylos.revocations=`, and when the serials are equal, `SHA-256(envelope bytes) = <sha256>`;
   - it requires that the OS generation is not listed `unlaunchable`;
   - if the file is missing or its serial is lower, it records `revocationsSerial` as the cmdline serial and treats the list as empty, which is safe because the UKI's own floor makes the release current and the staged list was checked by `courier`; a file with an equal serial but a different digest is tampering and halts with a recovery prompt;
3. records the serial in `trust.json.revocationsSerial`.

A failed statement verification halts with a recovery prompt. That cannot happen for a correctly staged release, since `courier` stages only verified releases.

### 4.10 Boot trust set and report

`/run/keylos/boot/trust.json` and `report.json` follow protocols §20.1 exactly. Field sources:

| Field | Source |
|---|---|
| `stream`, `seq` | cmdline `keylos.stream`, `keylos.seq` |
| `osGen` | cmdline `composefs=` |
| `configGen`, `safeConfig` | §4.7.2 |
| `keys.releaseStream` | `release-keys.json` in the initrd, plus `.pcrpkey` |
| `keys.ownerPresence` | §4.7.1 |
| `keys.ownerSeal` | `/etc/keylos/owner-seal/*.spki` |
| `keys.publishers` | `/etc/keylos/publishers.json` |
| `spki` | DER of every key above |
| `revocationsSerial` | §4.9.2 |
| `bootstrapGens` | `/etc/keylos/services.json` `bootstrapGens` (protocols §20.16) |
| `featureLevel` | runtime probe: Landlock ABI, BPF LSM, IPE, idmapped mounts |

`report.json` is also passed to `warden` as fd 8 (protocols §20.1; fds 3–7 are the kl-exec maps), from which `warden` includes it in the `boot` receipt.

**Report fields from protocols §20.1** that `boot` computes: `integrity` (REQ-BOOT-044); `dmaProtection` (`"firmware-declared"` when the firmware declared pre-boot DMA protection in the ACPI DMAR/IVRS tables or the DT, else `"none"`); `iommu` (`"active"` when an IOMMU group exists for every PCI device, `"none-virtual"` on the `cloud` profile when the instance exposes only virtio devices and no IOMMU, `"none"` otherwise — `none` on any non-`degraded`, non-`cloud` profile is reported as a critical condition by `atrium`). `boot`-local extensions: `x-activationFailed`, `x-initrdUsb` (REQ-BOOT-045), `x-safeStart` (§4.12; restricts only, so it needs no authority). `secureBoot` is `owner` (owner PK, with or without Microsoft CAs in `db`), `shim` or `off`.

### 4.11 VBU: initrd side

The protocol is protocols §20.5. The initrd implementation:

1. **QR1.** Show QR1 with CBOR keys 1 (`v=1`), 2 (`t="vbu-hello"`), 3 (machine key, from the token's `machine_key`), 4 (stream), 5 (seq) and 6 (osGen), prefixed `KLV1`.
2. **Challenge.** Prompt for the 8-character Crockford base32 challenge `N`, case-insensitive, with `I`, `L` and `O` normalised to `1`, `1` and `0`. Reject other characters.
3. **Quote.** Compute `qualifyingData = SHA-256("keylos-vbu/1" ‖ N ‖ machine-key text bytes)`. Run `TPM2_Quote(AK0 = 0x81010003, sha256 PCRs 0–15, qualifyingData)` in a salted session.
4. **QR2.** Build QR2 with these keys, encoded per protocols §20.5 (rotating sequence above 1 000 bytes):
   - 7: `TPMS_ATTEST`;
   - 8: `TPMT_SIGNATURE`;
   - 9: PCR values 0–15;
   - 10: SHA-256 of the raw TCG event log (`/sys/kernel/security/tpm0/binary_bios_measurements`);
   - 11: `{resetCount, restartCount}` from `TPMS_ATTEST.clockInfo`;
   - 12: SHA-256 of the running UKI, read from the ESP path named by the EFI variable `LoaderEntrySelected` (ESP mounted read-only, `vfat`, `nosuid,nodev,noexec`, then unmounted);
   - 13: `{stream, seq}`.
5. **Verdict.** Prompt "Phone says VERIFIED? [y] continue to PIN / [n] power off / [r] recovery". Record the outcome in the boot report (`vbu: "verified"`, or `"skipped"` on an explicit skip).

**TOTP fallback** (protocols §20.5). A 20-byte HMAC secret sealed under `PolicyPCR(0,2,4,7,11=enter-initrd)` is stored at `/efi/keylos/vbu-totp.sealed` (protocols §10.7; created by the installer's `keylos-enrol vbu-totp`, which uses `kl-boot-tpm`). At P6, with `vbu = 'totp`, `kl-initrd` mounts the ESP read-only (`vfat`, `nosuid,nodev,noexec`), loads the blob (TPM2B_PRIVATE ‖ TPM2B_PUBLIC under the SRK), unseals it in a salted session, unmounts the ESP, and shows the 6-digit RFC 6238 code (SHA-1, 30 s steps) computed from the RTC. A firmware change makes the unseal fail, and the initrd then says "TOTP unavailable: firmware state changed".

**Enrolment** (performed by `installer` with `kl-boot enroll-vbu`, or later with presence):
- **AK0** (`0x81010003`) and **AK** (`0x81010002`): restricted signing ECC P-256 keys under the endorsement hierarchy with exactly the attributes of protocols §19.6 (`fixedTPM`, `fixedParent`, `sensitiveDataOrigin`, `userWithAuth`, `restricted`, `sign`; `adminWithPolicy` clear; empty authValue; empty authPolicy). AK0 signs pre-unlock VBU quotes; AK signs runtime quotes for `vouch`, `fleet` and cluster join. Neither key is bound to PCRs: quotes carry the PCR values, and verifiers check them.
- Both Names are written to NV `0x01300108` (68 bytes: `Name(AK) ‖ Name(AK0)`) with owner authorization at enrolment.
- The phone proves AK0 shares the TPM with the EK through `MakeCredential`/`ActivateCredential`. In this exchange, the pairing QR carries AK0's public area and the EK certificate chain, and the phone returns a credential blob that `kl-boot` activates and displays as a code.

### 4.12 Recovery

- **Boot entry.** The `recovery` profile of the current UKI is listed by systemd-boot as "keylos (recovery)".
- **Unlock.** A 256-bit recovery key, shown at enrolment as 64 hex digits in groups of 8 with a CRC-8 per group, unlocks LUKS keyslot 0 via Argon2id (`m=1 GiB, t=4, p=4`). PCR11 receives `enter-recovery`, so no PCR11-bound TPM secret is released.
- **Recovery key entry.** The prompt accepts the text form of protocols §20.21 (case-insensitive, spaces ignored). Each group's CRC-8 is checked as it is typed, and a mistyped group is pointed out before any Argon2id work. The LUKS passphrase is the 64 hex digits without separators and CRCs.
- **Recovery generation.** It is mounted like an OS generation; its digest comes from `keylos.recovery=`. `kl-initrd` registers it in kl-exec, writes `trust.json` with `safeConfig: true`, extends PCR11 `enter-recovery`, and starts it as PID 1 in place of `warden` (with the same fds 3–8). The recovery environment is specified by `installer`.
- **Safe start.** Reboot restores verified code and owner-approved configuration; writable state may still contain hostile data (protocols §9). For a suspected poisoned state the owner chooses "Safe start" at the PIN prompt (P7): the boot is the normal default-profile boot with `x-safeStart: true` in the report, so app data units are mounted read-only and nothing is reopened automatically until the owner releases each app; quarantine of suspect app state (snapshot and detach) is `strata quarantine` (strata spec).
- **Activation failure.** When `/sysroot/var/lib/keylos/config/activation-failed.json` exists (written by `config`, protocols §15), the default profile still boots the selected generation (REQ-BOOT-043) and the boot report says `x-activationFailed: true` (`kl-initrd` only tests the file's existence; it does not parse it), and `warden`/`atrium` surface a critical notice pointing at the recovery entry. The revert itself is a recovery-environment action (table below).
- **Actions** available to the recovery environment through `kl-boot`:

  | Action | Mechanism |
  |---|---|
  | Re-enrol the TPM | New sealed blob in a new token; the SRK pin is refreshed |
  | Reset the pcrlock policy | Write NV `0x01300103` through the `PolicySecret(0x81000105)` branch; the recovery auth value is `HKDF-SHA256(recovery key, "keylos-recovery-auth/1")` (protocols §19.6) |
  | Floor | Cannot be lowered. If every installed release is below the floor, the recovery environment installs a newer release from media (`courier stage --from-media`) |
  | Floor missing or unreadable | After a TPM clear or an interrupted floor write: an explicit re-enrolment (presence or quorum, recovery key): `kl-boot floor init` re-defines the index and writes the `floor` of the signed release statement of the release being re-enrolled, then the TPM is re-enrolled. The receipt and boot report say the floor history was reset |
  | Config counter | Cannot be rolled back. Recovery can only produce a new config generation with counter `NV + 1` (for example "revert to the previous configuration": the previous generation's content, re-signed), with presence or, on quorum machines, a quorum envelope |
  | TPM lockout | `TPM2_DictionaryAttackLockReset` with the lockout auth `HKDF-SHA256(recovery key, "keylos-lockout/1")` (protocols §19.6) |
  | Owner registry | A `recover` entry signed by `recoverySigner` (protocols §20.3) re-anchors the registry; the recovery environment writes it and updates NV `0x01300105` |

### 4.13 Degraded profile (no TPM)

Without a TPM 2.0, `installer` sets the profile `degraded`:
- a passphrase (Argon2id) unlocks LUKS;
- there are no PCR policies, no floor, no config counter and no VBU;
- kl-exec, IPE, composefs and confext still apply;
- config selection uses only the presence signatures (highest counter wins, without the NV bound).

`atrium` permanently shows a "Reduced integrity" indicator, and the boot report has `unlock: "passphrase"`.

---

## 5. Interfaces

### 5.1 `kl-boot` CLI

`kl-boot` is a tool, not a service. Read-only commands that only read `/run/keylos/boot/*` work for any principal whose view includes `/run/keylos/boot` (the owner's `shell` view). Commands that need the TPM run only where `/dev/tpmrm0` is granted: inside `courier`, `installer`, the recovery environment, or the machine-side `vouch` daemon, which link `kl-boot-tpm` and invoke the same code paths. Mutating commands require presence, obtained by the hosting service.

| Command | Description | Exit |
|---|---|---|
| `kl-boot status [--json]` | Secure Boot mode, stream, seq, floor, config counter, VBU state, profile, volume identity (from `report.json` and `trust.json`) | 0 |
| `kl-boot trust [--json]` | Print `trust.json` | 0 |
| `kl-boot pcrs [--predict <uki>] [--json]` | Current PCR values and, with `--predict`, the expected values for a UKI (TPM) | 0, 5 |
| `kl-boot enroll-tpm --pin` | Seal a new keyslot passphrase under the §4.4 policy (installer, recovery) | 0, 1, 5 |
| `kl-boot enroll-vbu` | §4.11 AK/AK0 enrolment and EK credential activation (installer) | 0, 1, 5 |
| `kl-boot recovery-key --regenerate` | New recovery key (presence, plus the current recovery key or TPM unlock) | 0, 1 |
| `kl-boot pcrlock update --branches <file>` | Write NV `0x01300103` and the token's `pcrlock_branches` (used by `courier`) | 0, 1, 5 |
| `kl-boot pcrlock reset --recovery-key <file>` | Recovery branch write (recovery environment only) | 0, 1, 5 |
| `kl-boot floor show` | Read NV `0x01300102` | 0, 5 |
| `kl-boot floor write` | Write the running release's exact floor `F` at phase `ready` under its approved policy (§4.4.4; used by `courier`); no value argument: any other value is unauthorised by the TPM. Exit 3 when the current floor is already above `F` (the `PolicyNV` step fails) | 0, 1, 3 |
| `kl-boot floor init` | Recovery and installer only: define `0x01300102` (owner authorization) and write the release's `F` under the `PolicyNvWritten(NO)` policy | 0, 1, 3 |
| `kl-boot quote --nonce <hex> [--ak runtime\|vbu]` | TPM quote with AK or AK0 (runtime attestation by `vouch` and `fleet`) | 0, 5 |
| `kl-boot eventlog [--json]` | Parsed TCG event log | 0 |

Exit codes: 0 ok, 1 denied, 2 unreachable, 3 invalid state, 5 TPM error, 64 usage.

### 5.2 `kl-uki` (build-time tool)

| Command | Description |
|---|---|
| `kl-uki build --kernel K --initrd I --cmdline-template T --osrel O --profiles P --release-keys R --os-gen G --recovery-gen RG --seq N --floor F --revocations <serial>:<sha256> [--installer] --out DIR` | Assemble the unsigned UKI with the identity pins of REQ-BOOT-003 filled in; emit `pcr11.json`, `pcr12.json`, the three policy digests and `release-pcr.json`. The floor-write digest binds exactly `F` (the release statement's `floor`, §4.4.4). `--installer` builds the installer UKI, whose `ready`-phase floor-write approval (`PolicyNvWritten(NO)` form) the release ceremony also signs (protocols §19.6: the installer initialises the floor) |
| `kl-uki sign --uki U --pe-cert C --pe-key-uri K --pcr-key-uri K2 --out S` | Insert `.pcrsig` (signatures over the policy digests per phase and profile) and Authenticode-sign. Key URIs are PKCS#11 (HSM) |
| `kl-uki verify --uki S --trust T` | Check the signature, sections and `.pcrsig` (used by `courier` before staging) |
| `kl-uki initrd --manifest initrd.toml --modules-from GEN --out I` | Build the initrd reproducibly (sorted cpio, mtime 0, owner 0) |

### 5.3 `kl-boot-tpm` crate

The library API used by `courier`, `installer`, the recovery environment and `vouchd`:
- policy digest computation;
- `PolicyAuthorize` ticket handling from `.pcrsig`;
- pcrlock branch construction and NV writes;
- floor read and write;
- quote generation;
- event-log parsing;
- the `keylos-tpm2` token model.

It uses the handles and NV indices of protocols §19.6 exclusively (through `keylos-tpm-registry`).

### 5.4 Files

| Path | Writer | Content |
|---|---|---|
| ESP `/EFI/systemd/systemd-bootx64.efi` (or `aa64`) | courier, installer | Signed boot loader |
| ESP `/EFI/Linux/keylos_<seq>+<l>-<d>.efi` | courier | UKIs |
| ESP `/loader/loader.conf` | courier | `timeout 0`, `editor no`, `auto-entries no`, `auto-firmware yes`, `default keylos_*` |
| `/run/keylos/boot/trust.json`, `report.json` | kl-initrd | protocols §20.1 |
| LUKS2 token `keylos-tpm2` | kl-boot | §4.4.1 |
| ESP `/efi/keylos/vbu-totp.sealed` | installer (`keylos-enrol vbu-totp`) | Sealed TOTP secret (read at P6, protocols §10.7) |

---

## 6. Security

| Threat | Mitigation |
|---|---|
| Evil maid replaces the boot loader or UKI | Secure Boot with owner keys rejects unsigned images; PCR4/PCR11 change, so the unseal fails; VBU shows NOT VERIFIED |
| Downgrade to an old signed UKI with a known bug (bitpixie class) | Floor check inside the signed policy (§4.4.2); kexec denied; shim and the Microsoft CA absent in owner-key mode |
| Partition swap or filesystem confusion | No fallback keyslots (REQ-BOOT-012); volume identity check (§4.5); root is the cmdline-pinned composefs digest, so attacker files are never executed |
| TPM bus sniffing | Salted, encrypted sessions bound to the pinned SRK; the PIN is required, so a sniffed unseal needs the PIN as well |
| PIN brute force | TPM dictionary-attack lockout (32 tries, then one per 10 minutes); at most 5 tries per boot in the UI |
| Malicious cmdline | `.cmdline` is signed and measured; stub overrides are compiled out |
| Initrd tampering | It is inside the signed UKI and measured |
| Runtime code injection | `kl-exec` from the first userspace instruction; IPE for kexec |
| A userspace process loads its own BPF program (an LSM detach, an `fentry` hook) | `kl-exec`'s `bpf` rule: only thread-group ID 1 after hand-over, and debugger tracing types under a live `kernel`-scope pair |
| A debugger reaches beyond its target | `ptrace_access_check` and `perf_event_open` require a `kl_debug_pairs` entry whose target cgroup contains the tracee; entries expire on `CLOCK_BOOTTIME` |
| Dual boot weakens Secure Boot | Reported as integrity profile `shared-boot` in the boot report, `status` and the `vouch` verdict; the floor and signed PCR11 policy still bind unlock to current releases |
| Rollback of the config generation | NV config counter (protocols §15) |
| Forged owner registry entries (an attacker with disk access appends an entry) | Replay must match NV `0x01300105`, which only `hearth` (with its PCR11-ready/PCR15-sealed auth) can write |
| Replay of a captured VBU quote | Phone-generated challenge per attempt, bound in `qualifyingData` together with the machine key |
| A forged quote from a software TPM | AK0 is bound to the EK by credential activation at enrolment |
| A compromised stream signing key | `distro-root` rotates it via TUF; the floor is raised past the compromised releases; new UKIs carry the new `.pcrpkey`. Owner-key Secure Boot `db` updates need the owner's presence (`courier`) |

**Self-confinement.** `kl-initrd` is the only process in the initramfs and runs with full privilege (required for unlock and mounting). It parses only these inputs, each bounded:

| Input | Bound |
|---|---|
| LUKS2 header | via libcryptsetup |
| Token JSON | 16 KiB |
| DSSE statements | 64 KiB each, at most 4 096 |
| Owner registry | 4 MiB |
| Revocation list | 1 MiB |
| TPM responses | — |

On the running system, `kl-boot-tpm` runs inside its host services, with their confinement.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| TPM absent or broken | Degraded profile if enrolled so; otherwise an error screen offering the recovery key |
| PCR policy failure after a firmware update that `courier` did not predict | "Firmware changed" screen, then the recovery key. After unlock, `courier` re-runs pcrlock and rewrites the NV policy |
| Floor above the entry's seq | Message and return to the menu; boot counting falls back to a newer entry if one exists |
| OS generation image missing or corrupt | Boot fails before mount; try the next entry (boot counting) or recovery |
| OS generation statement does not verify | Halt with a recovery prompt (§4.9.2) |
| Owner registry replay fails | Safe config, with a critical notice (REQ-BOOT-021) |
| No config generation qualifies | Safe config, with a critical notice (REQ-BOOT-022) |
| Volume identity mismatch | Halt. No recovery is offered automatically, since recovery would unlock the wrong disk too; the message instructs the user to check disks |
| kl-exec fails to load (kernel without BPF LSM) | Halt: KL1 is a hard requirement |
| PIN lockout | Display the time remaining; offer the recovery key (the recovery environment can reset the dictionary-attack counter with the lockout auth) |
| NV read through the public branch fails (index absent or attributes wrong) | Treat as tampering: safe config and empty owner set for the registry head; refuse unlock for the floor (the unlock policy step 2 fails anyway); a missing or unreadable floor leads to the re-enrolment path of §4.12, never to a reconstructed value |
| VBU TOTP blob missing or unsealable | Show "TOTP unavailable"; offer quote-mode VBU if enrolled, else continue per `vbu` setting |

---

## 8. Performance budgets

| Step | Budget (reference laptop, fTPM) |
|---|---|
| Firmware → kl-initrd | out of scope (firmware) |
| kl-initrd P0–P5 | ≤ 250 ms |
| Unseal (policy session + unseal) | ≤ 400 ms (fTPM), ≤ 900 ms (dTPM) |
| LUKS2 activate (keyslot 1 uses PBKDF2 with 1 000 iterations because the passphrase is 512-bit random) | ≤ 50 ms |
| Owner registry replay (≤ 64 entries) | ≤ 30 ms |
| Mount OS generation and config generation | ≤ 100 ms |
| kl-initrd total, excluding user input | ≤ 950 ms |
| VBU quote, including the UKI hash | ≤ 1.5 s |

---

## 9. Observability

- **Boot report.** Protocols §20.1; `warden` includes it in the `boot` receipt.
- **Logs.** The initrd logs to `/dev/kmsg` with the prefix `kl-initrd:`; `journal` imports them after boot.
- **Receipts.** `boot` writes none itself. `courier` writes `update.*`; `hearth` writes `key.enroll` for VBU phones. `kl-boot` mutating commands are receipted by their hosting service.
- **Metrics.** Emitted by `courier` from the boot report: `boot_unlock_seconds`, `boot_initrd_seconds`, `boot_vbu_result{result}`, `boot_pin_failures_total`.

---

## 10. Configuration

Nickel module `keylos.boot`, rendered into `/etc/keylos/boot.json` of the config generation. `kl-boot` and `courier` read all of it.

The initrd needs `vbu`, `pinAttemptsPerBoot` and `console` *before* unlock, when the confext is not mounted. `courier` therefore copies those three keys into the `ui` field of the `keylos-tpm2` token (through `kl-boot-tpm`) whenever the active config generation changes them. The token copy is advisory: it influences only prompts, never the unlock policy.

```nickel
{
  boot | {
    vbu | [| 'off, 'optional, 'required, 'totp |] | default = 'optional,
    pinAttemptsPerBoot | Number | default = 5,
    console | { keymap | String | default = "us", font | String | default = "font8x16" },
    pcrlock | {
      dropUnpredictable | Bool | default = true,
      maxBranches | Number | default = 4,
    },
    secureBootMode | [| 'owner, 'shim |] | default = 'owner,
    degradedAllowed | Bool | default = false,
  }
}
```

---

## 11. Testing and acceptance criteria

**Unit:**
- policy digest computation against TPM reference vectors (`tpm2-tools` `policy*` outputs recorded as golden files);
- CBOR QR encoding round trips against the `vbu/` conformance vectors;
- token JSON parsing (bounded);
- PCR11 phase hashing matching systemd-pcrphase golden values;
- owner-registry replay against the `presence/` vectors and crafted logs (a broken chain, a missing quorum, a removed credential signing);
- generation-statement and revocation-list verification against the `boottrust/` and `release/` vectors.

**Integration** (swtpm + OVMF in qemu, and real fTPM hardware in the lab):
1. Golden boot: unlock with the PIN in ≤ 950 ms, excluding input.
2. Tampered cmdline (unsigned UKI): Secure Boot rejects it.
3. Old UKI after the floor is raised: `POLICY_FAIL` at the floor step, then menu fallback.
4. Firmware variable change (simulated PCR7 change): firmware-changed screen; `kl-boot pcrlock update` with branches restores unlock.
5. Partition swap with a LUKS volume that has an empty-passphrase keyslot: no unlock attempt beyond the token (REQ-BOOT-012).
6. Cloned header plus a different data area: volume identity mismatch halt.
7. Executing a binary copied into `/var`: `EACCES`, and the event is recorded.
8. Config generation with counter < NV: ignored; safe config if no other qualifies.
9. Owner registry with an appended forged entry: replay mismatch, then safe config.
10. VBU: the phone emulator verifies a good quote, and rejects a quote with PCR4 changed, a wrong challenge, a seq lower than seen, and PCR15 non-zero.
11. Recovery profile: PCR11 is `enter-recovery`, so the disk policy unseal fails as expected; the pcrlock reset through the recovery branch succeeds.
12. No hibernation: a `resume=` parameter added to a test cmdline is ignored, and swap opens with a random key.
13. Hand-over: `warden` receives exactly fds 3–8; `kl_exec_policy` reads back `{1, 0, SYSTEM, 1}` and is frozen (`BPF_MAP_UPDATE_ELEM` returns `EPERM`).
14. kl-exec debug rules: with no `kl_debug_pairs` entry, `ptrace(PTRACE_ATTACH)` from a test task with `CAP_SYS_PTRACE` fails with `EPERM`; with a scope-`process` entry it succeeds on a task in the target cgroup and fails on a task outside it; after expiry it fails again; a `kernel`-scope task can load a tracepoint program but not an LSM program.
15. NV reads: the initrd reads NV `0x01300101`, `0x01300102`, `0x01300105` and `0x01300108` with no owner authorization set on the session (owner auth deliberately unknown in the test).
16. Quorum registry: a `set-quorum` entry signed by fewer distinct owners than `policy.quorum` breaks the replay; a `config.apply` statement with two signatures from one owner on a threshold-2 machine is rejected.
17. Integrity profile: owner `db` with the Microsoft UEFI CA added reports `shared-boot`; shim boot reports `shim`.
18. Recovery key entry: a single mistyped group is reported by group number before any KDF; the corrected key unlocks.
19. Initrd USB authorizer: with `usbcore.authorized_default=2`, an emulated external USB keyboard (all-HID) is authorized and types the PIN; an emulated USB mass-storage device and a composite HID+storage device stay `authorized=0` through `switch_root`; both appear in the boot report's `x-initrdUsb` only if authorized (the keyboard only).
20. Boot report: on a `cloud` profile VM with only virtio devices, `iommu` is `none-virtual`; on the reference laptop it is `active` and `dmaProtection` is `firmware-declared`.
21. Seed profile: on a fresh cloud test image the `seed` profile starts the seed generation as PID 1 with fds 3–8 and PCR11 = `enter-initrd`‖`leave-initrd`; after provisioning, booting the `seed` profile again halts with "machine already provisioned".
22. Revocation pin: a UKI whose `keylos.revocations=` serial is above the on-disk list's serial refuses to register the OS generation (`kl:integrity`); `courier` staging never changes the UKI.
23. Floor policy (swtpm, adversarial): with the floor at `F`, raw `TPM2_NV_Write` of `F − 1`, a 4-byte partial write, a write at offset 4 and a write of `F` to another index all fail under the running UKI's approved policy; a policy session of an older release's approval fails at `PolicyPCR`; two concurrent sessions of the running UKI both succeed only with `F`; the installer policy fails on a written index; with the index undefined the default profile refuses unlock and offers recovery.
24. Safe start: choosing "safe start" at the PIN prompt yields `x-safeStart: true` in the boot report; PCR11 and the unlock path are unchanged.

**Fuzzing:** the LUKS2 token JSON, configgen and genstmt DSSE parsing, owner registry lines, the QR CBOR decoder and the TCG event log parser.

**Acceptance:** all integration tests on x86_64 (OVMF + swtpm, and two reference laptops) and aarch64 (QEMU virt + swtpm, and one reference board).

---

## 12. Implementation notes

**Crates:**
- `tss-esapi` 7 (TPM2), `libcryptsetup-rs` 0.9 (LUKS2)
- `aya` 0.14 and `aya-ebpf` 0.2 (kl-exec), built with a pinned nightly toolchain and `bpf-linker` 0.11 (LLVM 23) for the eBPF crate only; `rustix` 0.38 (mount API)
- `ciborium` 0.2 (CBOR), `qrcodegen` 1 (QR)
- `p256` 0.13, `ed25519-dalek` 2, `sha2` 0.10, `hkdf` 0.12
- `goblin` 0.8 (PE parsing in kl-uki), `object` 0.36
- `serde_json` 1, `keylos-formats`, `keylos-presence`, `keylos-tpm-registry`

**Repository layout:**

```
boot/
  crates/kl-initrd/  crates/kl-exec-ebpf/  crates/kl-exec-common/  crates/kl-uki/  crates/kl-boot/
  crates/kl-boot-tpm/   (policy composition, digest calculation, session helpers, NV, quotes, token model)
  policy/keylos.ipe
  initrd.toml
  tests/qemu/  fuzz/
```

**Build:** `kl-initrd` is static (musl, `panic=abort`) and at most 6 MiB. The BPF object is built with `bpf-linker` and embedded via `include_bytes!`.

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reference |
|---|---|---|
| Owner Secure Boot keys by default | MS CA plus shim everywhere keeps the old-shim downgrade risk | [ADR-0013](../../handbook/11-decisions/adr-0013-owner-secure-boot-keys.md) |
| TPM + PIN, with a signed PCR11 policy, pcrlock NV, and the floor inside the signed part | Literal PCR sealing breaks on updates; TPM-only unlock enables sniffing and confusion attacks | [ADR-0014](../../handbook/11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md) |
| Volume identity via PCR15 | Trusting any volume that unlocks is what the confusion attacks exploit | [ADR-0014](../../handbook/11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md) |
| VBU with a typed challenge and AK0 | TOTP only (a shoulder-surfed code can be replayed within the window); a USB attestation token (extra hardware) | [ADR-0015](../../handbook/11-decisions/adr-0015-verify-before-unlock.md) |
| kl-exec BPF LSM keyed by overlay superblock, IPE as a second layer | IPE fs-verity signatures per object (millions of signatures, overlay inode semantics); IMA appraisal (xattr loss, operational pain) | [ADR-0008](../../handbook/11-decisions/adr-0008-host-executes-only-sealed-code.md) |
| Owner registry replay in the initrd | Trusting an unanchored key file on disk | [ADR-0011](../../handbook/11-decisions/adr-0011-owner-presence-fido2.md) |
| Reuse systemd-boot and systemd-stub | A custom boot loader is new TCB code for no gain | [ADR-0002](../../handbook/11-decisions/adr-0002-rust-for-the-tcb.md) |
| No kexec, no hibernation | kexec bypasses firmware measurement and re-enables downgrade paths; lockdown refuses hibernation | [ADR-0014](../../handbook/11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md) |

### 13.1 Notes on cross-repository contracts

Earlier interim notes (who extends `enter-initrd`, the report fd and fields, the open-broker ptrace mode) are now protocols 1.0.0 (final) text. One repository-local clarification remains:

- **N4. `pcrlock_branches` placement.** The LUKS2 token's `pcrlock_branches` (§4.4.1) is written by `courier` through `kl-boot-tpm`; the token format is local to this repository, and `courier` uses it only through the `kl-boot-tpm` crate, never by parsing it itself.
