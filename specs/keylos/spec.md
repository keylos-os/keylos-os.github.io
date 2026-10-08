# keylos/keylos — the keylos distribution

| | |
|---|---|
| Repository | `github.com/keylos-os/keylos` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | Kernel configuration fragments (`kernel/config/*.config`), kernel command-line templates, sysctl baseline, profile definitions (`profiles/*.ncl`), default policy set (`policy/*.cedar`), default grants (`grants/*.ncl`), default service and route tables (`services/*.ncl`), image assembly tool `keylos-image`, OS conformance suite `keylos-conformance`, hardware certification suite `keylos-hwcert`, release metadata templates, branding assets |
| Depends on | `keylos-protocols 1.0` (crates `keylos-formats`, `keylos-tpm-registry`, `keylos-schemas`); build-time: `forge` ≥ 1.0 (builds), `depot` ≥ 1.0 (generation import), `tlog` ≥ 1.0 (release log submission), `pkgs` 1.0 (recipes); runtime contracts of every keylos component at 1.0 |
| Provides | Signed OS generations per profile and stream, UKIs, installer and recovery images, the release-log statements, the authoritative OS security analysis, OS-level conformance verdicts |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

This repository turns the keylos components into a **distribution**: an operating system that can be installed, updated and audited. It owns:

1. **The kernel configuration** every keylos OS generation is built with: required and forbidden options, the LSM order, the command line and the sysctl baseline.
2. **Profiles and integrity profiles**: the machine profiles `desktop`, `laptop`, `server`, `server-k8s`, `cloud`, `kiosk` and `appliance`, the integrity profiles `full`, `shared-boot`, `shim`, `cloud-vtpm`, `cvm` and `degraded` (protocols §2.2), and the RAM classes (protocols §2.3).
3. **Image assembly**: the pipeline from `forge` outputs to OS generations, UKIs, installer images, cloud images and the `server-k8s` node image, and the inputs to the signing ceremony.
4. **Defaults**: Cedar policy set (including pod admission, debugging, channel, family, guest and offline rules), default grants, default device authorization, default debuggers, default services and routes, default applications, kiosk and guest defaults.
5. **Release engineering**: streams, cadence, support windows, kernel policy, CVE response, embargo handling, release-signed kernel-module generations (`kmod`), cloud image publication, and the publisher and catalog governance.
6. **The OS conformance suite**: end-to-end acceptance tests of the whole system, including "reboot heals" (reboot restores verified code and owner-approved configuration; writable state may still contain hostile data and may need quarantine or recovery, protocols §9), agent exfiltration, evil maid, rollback and revocation.
7. **Hardware certification**.
8. **The authoritative security analysis** of keylos: a threat-to-control matrix and the residual risks.
9. **Governance**: who holds keys, who operates rebuilders and witnesses, and how those roles change.
10. **Branding and naming.**

### 1.1 Non-goals

- Implementing any runtime component. Every daemon lives in its own repository; this repository only selects, configures and assembles them.
- Package recipes. They live in `pkgs`. This repository names which recipes form each profile's OS generation.
- Supporting machines without UEFI, or architectures other than x86-64 and aarch64.
- An "unlocked" profile without `kl-exec` enforcement. The integrity profiles `shared-boot`, `shim`, `cloud-vtpm` and `degraded` weaken specific links of the chain and say so in `status`, in the boot report and in the `vouch` verdict. No profile turns code-integrity enforcement off.
- Owner-built or third-party kernel modules. Out-of-tree modules exist only as project-built, release-signed `kmod` generations (§4.1.5, ADR-0057).
- Kubernetes control-plane components. `server-k8s` is a worker-node profile; the control plane runs elsewhere (on keylos `server-k8s` nodes only as ordinary pods).

---

## 2. Context and embedded contracts

keylos is assembled from the repositories listed in §4.6. The contracts below are copied **verbatim** from `keylos-protocols 1.0`; if a copy differs, protocols wins. This distribution is the integration point of every protocols registry, so the registries (§2.17–§2.20) are embedded in full. Excerpts are generated mechanically from the protocols source; headings inside an excerpt are demoted one level so they nest under this section, and the text is otherwise verbatim.

### 2.1 Platform baseline, kernel feature levels, profiles and RAM classes (protocols §2, including §2.1–§2.3)

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

#### 2.1 Kernel feature levels

Components MUST probe for features and MUST pick behaviour by **feature level**, not by kernel version string.

| Level | Required kernel features | Typical kernel |
|---|---|---|
| `KL1` | Landlock ABI ≥ 7, BPF LSM (`lsm=` includes `bpf`), IPE, fs-verity, overlayfs `verity=require`, pidfd (`CLONE_PIDFD`, `pidfd_getfd`, `SO_PEERPIDFD`), `openat2`, new mount API, `MOVE_MOUNT_BENEATH`, idmapped mounts, `AT_EXECVE_CHECK`, `memfd_secret`, `mseal`, cgroup v2 (`cgroup.freeze`, `cgroup.kill`) | 6.18 |
| `KL2` | KL1 + Landlock ABI ≥ 9 (`FS_RESOLVE_UNIX`, `RESTRICT_SELF_TSYNC`) | 7.1 |
| `KL3` | KL2 + Landlock ABI ≥ 10 (UDP rules) | 7.2 |

On KL1 and KL2 there are no Landlock rules for pathname unix sockets or UDP. Components MUST compensate: the sandbox gets a private network namespace with only `lo`, and egress goes through `gate`; the mount view gives no access to pathname sockets. That compensation MUST be recorded in the process's confinement report (§9.4).

The LSM order on the kernel command line is `lsm=landlock,lockdown,yama,ipe,bpf`.

#### 2.2 Profiles and integrity profiles

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

#### 2.3 Resource classes

`bench` admission control and memory tuning follow the machine's **RAM class** (detected at boot, overridable in config):

| RAM | Class | Max concurrent VMs (workbench, agent, tier-2, media, pod) | Defaults |
|---|---|---|---|
| < 12 GiB | `small` | 2 | zram swap (ephemeral key), KSM on, compressed snapshots, agents queue |
| 12–24 GiB | `medium` | 6 | KSM on, free-page reporting |
| > 24 GiB | `large` | 16 | free-page reporting |

`server-k8s` nodes are exempt from the VM cap for pod VMs; kubelet `maxPods` bounds them instead. When the cap is reached, new agent sessions queue (`aide`), and other VM requests fail with `kl:unavailable`.

### 2.2 Kernel feature levels

Protocols §2.1 (feature levels), §2.2 (profiles and integrity profiles) and §2.3 (RAM classes) are sub-sections of protocols §2 and are embedded verbatim in §2.1 above.

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

### 2.4 Trust roots (protocols §5.2)

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

### 2.5 Generation manifest rules (protocols §6.3, normative field rules)


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

### 2.6 Confinement baseline (protocols §9.1)

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

### 2.7 Tiers (protocols §9.2)

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

### 2.8 Code integrity (protocols §9.3)

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

### 2.9 Host layout (protocols §10.1)

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

### 2.10 Disk layout (protocols §10.2)

GPT:
1. ESP (1 GiB, FAT32).
2. `keylos-root`: LUKS2 with dm-integrity AEAD (`aegis128` where available, else `aes-gcm-random` + HMAC-SHA256 integrity), holding btrfs subvolumes `@store`, `@var`, `@home`, `@keystore`, `@snapshots`.
3. Optional `keylos-swap`: encrypted with an ephemeral random key at every boot. There is no hibernation (§2).

### 2.11 UIDs and cgroups (protocols §10.3)

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

### 2.12 Approval tiers (protocols §14.3)

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

### 2.13 Cedar policy schema and annotations (protocols §16)

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

### 2.14 Transparency logs (protocols §11.5)

keylos operates two logs, both following **C2SP tlog-tiles** with checkpoints per **C2SP tlog-checkpoint** and witness cosignatures per **C2SP tlog-cosignature**:

| Log | Origin line | Entries |
|---|---|---|
| Realisation log | `log.keylos.org/realisations` | DSSE realisation attestations (§11.4) |
| Release log | `log.keylos.org/releases` | DSSE release statements (`keylos.release/1`, §20.6) and cloud image records (`keylos.cloudimage/1`, §20.24), signed by `release-stream/<stream>` |

Clients MUST verify inclusion against a checkpoint cosigned by at least `witnessThreshold` (default **2**) witnesses from the witness list in TUF targets metadata (`rebuilders.json`: `witnesses`, `witnessThreshold`). A generation is installable from a distro or publisher channel only if its realisation log entries reach the rebuilder quorum named in its release or app-release statement.

### 2.15 Revocation list (protocols §11.7)

```json
{"schema":"keylos.revocations/1","stream":"stable","serial":1234,"issued":"…",
 "objects":[{"ref":"obj:fsv256:…","reason":"CVE-2026-XXXX","action":"evict"}],
 "generations":[{"ref":"gen:fsv256:…","reason":"…","action":"unlaunchable"}],
 "keys":[{"ref":"key:sha256:…","reason":"compromised","after":"…"}]}
```

- Distributed as a TUF target by `courier` and logged (its digest) in the release statement.
- Actions: `unlaunchable`, `evict`, `warn`.
- A `keys[]` entry for a `publisher/<id>` or `org-publisher/…` key makes every generation whose only authorising signature is by that key `unlaunchable` from `after` onwards; generations signed before `after` stay launchable only if their realisations reach the rebuilder quorum.

### 2.16 Generation statement (protocols §20.7)

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

### 2.17 Service names (protocols §19.1)

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

### 2.18 Facets (protocols §19.2)

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

### 2.19 Receipt events (protocols §19.3)

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

### 2.20 TPM objects (protocols §19.6)

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

### 2.21 Release statement (protocols §20.6)

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

### 2.22 Boot trust set and boot report (protocols §20.1)

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

### 2.23 Presence purposes (protocols §20.2)

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

### 2.24 Generation kinds (protocols §6.1)

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

### 2.25 Presence signatures and quorum presence (protocols §5.3, §5.4)

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

Headless profiles (`server`, `server-k8s`, `cloud`, `appliance`) and managed machines use **quorum presence** instead of a local touch. The owner registry (§20.3) then has `policy.mode = "quorum"` and `policy.threshold = N`, with M approver credentials (the owners' FIDO2 credentials, enrolled like any owner credential).

- A **quorum presence envelope** is an ordinary DSSE envelope over the same payload with **≥ N signatures** (§5.3 construction) from credentials of **distinct owners**. Verifiers MUST count distinct owners, not signatures.
- Collection: `hearth` creates a quorum request (`keylos.quorum/1`, §20.18) through `HearthQuorum.request` (§7.5.3); approvers receive it through `fleet` (or out of band as a file), review the rendered payload on their own keylos machine, and sign it there with `hearth presence --remote <request>` (their machine's `hearth` signs with their own credential and rpId `keylos.owner`); signatures return through `HearthQuorum.submit`. The request expires after at most 24 h.
- Every purpose of §20.2 accepts a quorum envelope on quorum machines. On `desktop`/`laptop` profiles quorum envelopes are accepted only for owner-registry changes that the registry policy marks `quorum`.
- **Seal gate on quorum machines.** No touch reaches the machine, so the seal gate's authValue for the window is released differently: `hearth` holds the next gate authValue in a TPM-sealed blob bound to the signed PCR11 `ready` phase and PCR15, and unseals it only after verifying a quorum envelope of purpose `seal.window`. This reduces the guarantee from "a physical touch" to "N approvers signed and the machine runs a verified `hearth`"; the reduction is shown in `status` (`sealing: quorum`).

### 2.26 Devices, removable media and DMA (protocols §9.5)

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

### 2.27 Environment conventions and cross-repository files (protocols §10.5, §10.7)

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

### 2.28 Publishers and catalog (protocols §11.8, §20.20)

- **Onboarding.** A publisher is added to the TUF `publishers` delegated role (signed by `distro-root` delegation keys) with either an Ed25519 key held in hardware or a Sigstore identity (OIDC issuer + subject) and an accepted publisher policy version. Org publishers are delegated from a fleet's TUF repository (`org-publishers` role) and are trusted only on machines enrolled in that fleet.
- **Enabling.** A machine trusts a publisher only after the owner enables it in config (`/etc/keylos/publishers.json`, §20.20); it then enters the boot trust set at the next boot.
- **Catalog.** `keylos.catalog/1` (§20.20) is a TUF target signed by the `catalog` role. A listing is `reviewed-reproducible` only if its generations' realisations reach the rebuilder quorum and the catalog review passed; otherwise it is `unreviewed`. Installing an `unreviewed` app sets its effective tier floor to 2 unless the owner records an exception (`keylos.exception/1`, kind `reproducibility`).

`/etc/keylos/publishers.json` (`keylos.publishers/1`, rendered by `config`): `{"schema", "publishers": [{"id": "…", "keys": ["key:sha256:…"], "sigstore": [{"issuer": "…", "subject": "…"}], "spki": {"key:sha256:…": "<base64 DER>"}, "scope": "distro" | "org:<org>"}]}`.

`keylos.catalog/1` (TUF target signed by the `catalog` role):

```json
{"schema":"keylos.catalog/1","issued":"…","expires":"…",
 "entries":[{"name":"org.example.Editor","publisher":"example","summary":"…","categories":["development"],
             "latest":{"version":"2.5.0","generation":"gen:fsv256:…","statement":"sha256:<genstmt envelope digest>"},
             "review":"reviewed-reproducible" | "unreviewed","quorum":"3/3","capabilities":"sha256:<JCS digest>",
             "icons":["https://…"],"homepage":"https://…"}]}
```

### 2.29 Receipt privacy (protocols §13.4)

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

### 2.30 Operating rules (protocols §14.5)

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.

### 2.31 Service table and policy reference (protocols §20.16, §20.17)

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

`/etc/keylos/policy.ref` (JCS): `{"schema":"keylos.policyref/1","generation":"gen:fsv256:…","digest":"sha256:<JCS digest of the policy generation's manifest>"}`. `warden` mounts that `policy` generation read-only at `/policy` in `broker`'s view; `broker` refuses to start if the mounted generation's manifest digest differs. `BrokerSystem.loadPolicy` switches policy at runtime only to the generation named by the newly activated config generation's `policy.ref`.

### 2.32 First-boot bundle and cloud seed (protocols §20.13)

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

### 2.33 Recovery key (protocols §20.21)

- **Secret:** 32 random bytes generated by the installer.
- **Text form:** 64 lowercase hex digits in 8 groups of 8; each group is followed by a 2-hex-digit CRC-8 (polynomial 0x07, init 0x00) of that group's 4 bytes; groups are separated by `-`: `xxxxxxxxcc-xxxxxxxxcc-…`. The CRC lets the recovery environment point at a mistyped group. Input is case-insensitive and ignores spaces.
- **LUKS2 recovery keyslot:** passphrase = the 64 hex digits without separators and CRCs; LUKS2 applies Argon2id (m = 1 GiB, t = 4, p = 4).
- **Derivations** (HKDF-SHA256 over the 32-byte secret, salt empty, info strings): `"keylos-recovery-auth/1"` (TPM recovery auth object `0x81000105`), `"keylos-lockout/1"` (TPM lockout auth), `"keylos-recovery-signer/1"` (Ed25519 seed of the owner-registry `recoverySigner`), `"keylos-escrow/1"` (optional backup-escrow wrapping key), `"keylos-recovery-recipient/1"` (X25519 private key of the **recovery recipient**; its public half is stored at `/var/lib/keylos/recovery/recipient.pub` and in the first-boot bundle, and running services encrypt recovery copies to it with HPKE (§4): the owner-hierarchy auth and vault `recovery` slots), `"keylos-sb-pk/1"` (seed of the owner Secure Boot **PK**: an RSA-2048 key generated deterministically with HMAC-DRBG-SHA256 seeded by this output, per FIPS 186-5 appendix B.3.3, so the recovery environment can re-create it to sign KEK updates; the PK is never stored).
- `hearth`, `boot`, `installer` and the trustee tooling MUST use exactly this format.

### 2.34 Cluster nodes (protocols §21)

#### 21.1 Boundary

- The `server-k8s` profile runs upstream `kubelet` and `kube-proxy` (sealed generations built by `forge`, packaged in `pkgs`) and the keylos `cri` service.
- `kubelet` reaches `cri` only through the route `cri#kubelet`: `warden` creates an `AF_UNIX` `SOCK_STREAM` socket pair and passes `kubelet` its end as `--container-runtime-endpoint=unix:///run/keylos/cri/cri.sock` (a path inside kubelet's view bound to that socket). This is the only non-capwire IPC in keylos (§7.1).
- `cri` implements CRI v1 (`runtime.v1.RuntimeService`, `runtime.v1.ImageService`) for the three most recent Kubernetes minor versions at release time.
- `kubelet` runs as a tier-1 service without root and without capabilities, in the cri network namespace (`services.json` `network: "cluster"`). It holds: the `cri#kubelet` route; the cgroup subtree `/keylos.slice/kube.slice` (delegated to `cri`, read-only to kubelet for stats); its state directory `/var/lib/keylos/cri/kubelet` (written by `cri`: certificates, kubeconfig). Volume mounts, networking and image handling are done by `cri`, never by kubelet.
- **Mount-free kubelet.** `pkgs` builds kubelet with the `keylos-mountless` patch set, which is part of this contract: kubelet never calls `mount`/`umount` (they are denied by seccomp anyway). Its volume plugins write configMap, secret, projected and downwardAPI contents into plain directories under `/var/lib/keylos/cri/kubelet/pods/<uid>/volumes/`, and every mount, unmount, and device-attach step is a no-op; `cri` turns those directories into `PodMount` trees (`tmpfsBytes > 0` for secret-bearing types, §7.5.1) or VM shares, and handles emptyDir, local, NFS/iSCSI/RBD and CSI volumes itself (§21.6).
- `kube-proxy` runs in nftables mode inside the `cri` network namespace with `CAP_NET_ADMIN` there only.

#### 21.2 Runtime classes

| RuntimeClass | Isolation | Images | Notes |
|---|---|---|---|
| `keylos-vm` (default) | One `bench` microVM per pod sandbox (`VmSpec.purpose = pod`); containers run inside the guest under `youki` driven by `benchd` | Any OCI image, pulled by `cri` into `/var/lib/keylos/cri/images` (via `gate` when `cluster.egressViaGate`), shared read-only into the VM | VM principal `pod:<ns>/<name>:oci:sha256:<first image>@_cluster/…`; GPU only by passthrough |
| `keylos-sealed` | t1 principals spawned by `warden` through `PodSpawn` (§7.5.1) | Only `container` generations (§6.1) with a generation statement signed by an `org-publisher` key enabled on the machine | One principal per container; seccomp `runtime-default`; no added capabilities ever |

#### 21.3 Admission

`RunPodSandbox` carries no container configs, so `cri` admits against the **API server's Pod object** (read with its cluster credential, matched by pod UID); it normalises the Pod into `keylos.podspec/1` (the attributes of the Cedar `PodSpec` entity, §16.1, as JCS JSON) and calls `BrokerSystem.admitPod`. The broker evaluates action `admit` with principal `service:kubelet`. A denial makes `RunPodSandbox` fail with gRPC `PermissionDenied` and the reasons; an `@tier`/`@orgApproval` permit makes `cri` hold the sandbox in `pending-approval` until the approval resolves. `CreateContainer` re-admits when the container config adds anything the admitted Pod object did not contain (image, capability, mount, device). Receipts `pod.admit`/`pod.deny` (cri).

#### 21.4 Images

- `keylos-vm`: OCI images are pulled by `cri` with digest pinning; tags are resolved once and recorded. They are never executed on the host (`noexec` store) and never registered with `kl-exec`.
- `keylos-sealed`: `cri` calls `Depot.install("oci+container://<registry>/<repo>@sha256:<manifest>")` (facet `cri`). `depot` converts the image with **`oci-convert/1`** into a `container` generation and makes it launchable only if a `keylos.genstmt/1` for that generation digest, signed by an enabled `org-publisher` key, is available from the org TUF repository (`courier`). `cri` roots the generation as `cri:pod:<pod-id>` before `PodSpawn`; `depot` mounts container generations only while so rooted.
- **`oci-convert/1`** (normative; implemented only by crate `keylos-oci-convert`, §18): layers applied in manifest order; OCI whiteouts (`.wh.<name>`) and opaque markers (`.wh..wh..opq`) resolved; hardlinks kept; device nodes, sockets and FIFOs dropped (the runtime provides `/dev`); numeric uid/gid and mode bits kept; setuid/setgid bits cleared; `security.capability` and all `security.*`/`trusted.*` xattrs dropped (no file capabilities, ever); `user.*` xattrs kept; timestamps zeroed; entries sorted by path bytes; the result is built into a composefs generation exactly as `depot` builds any generation, with `/.keylos/manifest.json` of kind `container` whose `container` section copies the OCI config.
- **Identity** of a converted generation: `name` = `oci.` + the registry host's labels reversed + `.` + the repository path segments, joined by `.`, with every character outside `[a-z0-9-]` replaced by `-`; `version` = `0.0.0+oci.<first 16 hex digits of the manifest digest>`; `derivation` (and the genstmt `drv`) = `drv:sha256:<SHA-256 of the JCS bytes of the conversion descriptor>`, where the descriptor is `{"schema":"keylos.ociconv/1","algorithm":"oci-convert/1","image":"oci:sha256:<manifest>","platform":"linux/amd64","config":"sha256:<config blob>","layers":["sha256:…"]}`. For kind `container`, `drv` names this descriptor, not a `keylos.drv/1` derivation. `layers` lists the **compressed layer blob digests exactly as they appear in the image manifest, in manifest order** (not uncompressed `diff_id`s); `platform` is the platform selected from an image index (or the manifest's config platform).

#### 21.5 Networking

- `net` creates the **cri network namespace** at its own start on `server-k8s` (veth uplink to the host, bridge `kl-cri0`), from config `cluster.*`. `warden` obtains it with `NetPlumbingCluster.clusterNetns` and starts `crid`, `kubelet` and `kube-proxy` in it. `cri` configures it dynamically with `clusterUplink` (the pod CIDR assigned through the Node object, NAT, overlay) and obtains per-pod network namespaces from `net` with op `podNetns`. This is the single exception to "only `warden` creates namespaces" (§9.1): network namespaces only.
- **`keylos.cri.uplink/1`** (JCS JSON passed to `clusterUplink`):
  - `{"schema":"keylos.cri.uplink/1","op":"uplink","podCidr":"10.244.3.0/24","clusterCidrs":["10.244.0.0/16"],"serviceCidr":"10.96.0.0/12","mtu":1450,"nat":true,"overlay":{"mode":"none" | "vxlan","vni":4242,"peers":[{"node":"…","ip":"…","podCidr":"…"}]}}` → returns the cri namespace;
  - `{"schema":"keylos.cri.uplink/1","op":"podNetns","podId":"pod-…","ip":"10.244.3.17","mac":"…","mtu":1450}` → returns a new pod namespace with a veth attached to `kl-cri0`;
  - `{"schema":"keylos.cri.uplink/1","op":"release","podId":"pod-…"}` → deletes it (returns no fd: `Fd.index` 0xFFFF).
- Pod VMs attach a **tap** device to a bridge inside the cri namespace. This is the only use of tap devices in keylos; workbench and tier-2 VMs never get one. Sealed pods get a veth pair into the same bridge.
- IPAM is host-local per pod CIDR; cross-node connectivity is direct routing or a VXLAN overlay configured by `cri`. Third-party CNI plugins are not supported; eBPF-based CNIs are not supported on the host.
- NetworkPolicy objects (watched by `cri` through the node's credential) are compiled to nftables in the cri namespace.
- With `cluster.egressViaGate = true`, pod egress to addresses outside the cluster CIDRs is redirected to a per-pod `gate` shim endpoint (`PodSpawn.egressShim`, §7.5.1; `keylos-vm` pods use their VM's `bench-net`) and is subject to gate policy. The broker attaches the pod principals' tokens at `registerSession` from policy `cluster.egress`.

#### 21.6 Storage

- `emptyDir` and local PersistentVolumes are `strata` subvolumes (`StrataVolumes`, §7.5.7); `configMap`, `secret`, `projected` and `downwardAPI` volumes are tmpfs filled by `cri` (Kubernetes secrets arrive from the API server and are never stored in `vault`).
- NFS, iSCSI and RBD volumes are mounted **inside pod VMs only** (`keylos-vm`).
- CSI drivers are supported only as `container` generations declaring `needs.csi`; their node plugins run in a pod VM, and block devices reach them through `MediaAttach.claimBlock` (devd facet `cri`).
- `hostPath` is denied by default policy except a read-only allowlist.

#### 21.7 Node attestation and credentials

- Before kubelet starts, `cri` performs `FleetCluster.joinAttested` with an AK quote (and a confidential-VM report on `cvm`); `fleet` verifies it against the release log. Only then does `cri` obtain kubelet client certificates (`FleetCluster.kubeletCertificate`) and write the kubelet kubeconfig.
- Certificates are renewed by `cri` before expiry; a failed re-attestation (for example after an unapproved firmware change) stops renewal and the node drops out of the cluster when its certificate expires.

#### 21.8 Not supported

Privileged pods; `hostNetwork`, `hostPID`, `hostIPC`; added Linux capabilities; DaemonSets that need host access (node agents ship as sealed tier-0 services instead); Windows containers; GPU sharing other than whole-device passthrough into pod VMs; a writable container root filesystem in `keylos-sealed` pods (the root is read-only, with tmpfs at `/tmp`, `/run`, `/var/tmp` and `/dev/shm`, because a writable overlay would be an unregistered superblock from which nothing could execute; use `keylos-vm` for images that write to their root).

---

## 3. Requirements

### 3.1 Kernel

- **REQ-KEYLOS-001** Every OS generation MUST contain exactly one kernel, built by `forge` from a `pkgs` recipe using the configuration fragments in §4.1. The fragments are applied in order: `base`, `<arch>`, `<profile>`.
- **REQ-KEYLOS-002** The build MUST fail if any option in the required list (§4.1.2) is not set as specified, or any option in the forbidden list (§4.1.3) is set. `keylos-image kernel-check` enforces this on the final `.config`.
- **REQ-KEYLOS-003** The LSM order MUST be exactly `landlock,lockdown,yama,ipe,bpf`, both as `CONFIG_LSM` and on the command line.
- **REQ-KEYLOS-004** In-tree kernel modules MUST be shipped only inside the OS generation. Out-of-tree modules MUST be shipped only as **`kmod` generations** (protocols §6.1) built by `forge` from `pkgs` recipes against the exact kernel of a release, and signed with the release stream's module-signing key (§4.1.5). No other module can load: `module.sig_enforce=1`, lockdown, and `kl-exec`'s `kernel_read_file` rule over registered superblocks (protocols §9.3). Once hash-based module integrity is available upstream, the distribution MUST switch in-tree modules to it within one minor release.
- **REQ-KEYLOS-006** The kernel command line MUST enforce the IOMMU (`iommu=force` plus the vendor option, protocols §2) on every profile; `usbcore.authorized_default=2` MUST be present on every profile; the `kl-exec` map hand-off MUST be `keylos.execmapfds=3,4,5,6,7` (five maps, protocols §9.3).
- **REQ-KEYLOS-007** Host kernels MUST NOT build filesystem drivers for removable-media formats (exFAT, NTFS, HFS/HFS+, UDF, ISO 9660, F2FS); those exist only in the media VM's kernel (`io.keylos.bench.media`, protocols §9.5).
- **REQ-KEYLOS-005** The kernel MUST meet feature level KL1 at minimum. Release streams MUST ship the newest stable kernel that passes the conformance suite (§11). The LTS floor kernel is kept only for hardware certified on it.

### 3.2 Profiles

- **REQ-KEYLOS-010** The distribution MUST provide the machine profiles `desktop`, `laptop`, `server`, `server-k8s`, `cloud`, `kiosk` and `appliance` with exactly the deltas in §4.3, and MUST derive the integrity profile (`full`, `shared-boot`, `shim`, `cloud-vtpm`, `cvm`, `degraded`) at every boot as specified in protocols §2.2 and §4.3.9.
- **REQ-KEYLOS-011** The profile and integrity profile MUST be reported in `/usr/lib/os-release` (`KEYLOS_PROFILE`, `KEYLOS_INTEGRITY` = the integrity profile assumed by the image; the runtime value is in the boot report), by `kish status`, in the boot report and in the `vouch` verdict. Any integrity profile other than `full`, `cvm` and `cloud-vtpm` MUST be shown persistently in `atrium`'s status area; `cloud-vtpm` is shown in `status` and in `fleet` compliance.
- **REQ-KEYLOS-012** Changing between machine profiles is a config generation change (T3 with presence, or quorum presence on headless profiles). Enabling `secureboot.keepMicrosoftCAs` (integrity profile `shared-boot`) is a T3 action with presence and shows the risk text of §4.3.9.
- **REQ-KEYLOS-013** Headless profiles (`server`, `server-k8s`, `cloud`, `appliance`) MUST use quorum presence (protocols §5.4) with `policy.threshold ≥ 2` and at least 3 enrolled approver credentials from at least 2 distinct owners; the installer refuses fewer.
- **REQ-KEYLOS-014** `bench` admission MUST follow the RAM classes of protocols §2.3; the class is detected at boot and MAY be lowered (never raised) in config.
- **REQ-KEYLOS-015** The `kiosk` profile MUST keep the trusted path and owner login available through the secure attention sequence (§4.3.6), and MUST NOT expose `kish` on displays.

### 3.3 Image assembly

- **REQ-KEYLOS-020** OS generations MUST be assembled only from `forge` outputs whose realisations meet the stream's rebuilder quorum (§4.8.4). `keylos-image assemble` MUST refuse any input below quorum.
- **REQ-KEYLOS-021** Assembly MUST be reproducible: two assemblies from the same inputs (`assembly.lock`) MUST produce bit-identical generation images, UKIs (before signing) and installer images. CI MUST verify this on two independent builders for every release.
- **REQ-KEYLOS-022** Signatures (Secure Boot PE signatures, PCR policy signatures, DSSE signatures) MUST be detached from, or appended to, reproduced unsigned artifacts by a separate signing step (§4.4.6) that consumes only digests and unsigned artifacts.
- **REQ-KEYLOS-023** Each release MUST publish its `keylos.release/1` statement (§2.21, §4.4.7) in the release log before any TUF target pointing at it is signed.
- **REQ-KEYLOS-024** Every distro generation (OS, recovery, installer, runtimes, services, distro apps, bench images, agent templates) MUST carry a `keylos.genstmt/1` statement signed by the stream's release-stream key (protocols §20.7). No fs-verity builtin signatures are produced (protocols §4).
- **REQ-KEYLOS-025** Every TPM object referenced by distribution artifacts (UKI `.pcrsig` policies, default policies, conformance tests) MUST be one of protocols §19.6, through `keylos-tpm-registry`.
- **REQ-KEYLOS-026** The PCR11 predictions in each release statement MUST cover all five phases in the order of protocols §19.6 (`enter-initrd`, `leave-initrd`, `sysinit`, `ready`, `enter-recovery`); secrets sealed to `ready` MUST NOT be reachable before `warden` extends `ready`.
- **REQ-KEYLOS-027** Cloud images (§4.4.5) MUST boot only the signed-seed first-boot path (protocols §20.13) and MUST pin `fleet.seedKeys` in the image's initial config generation; images without pinned seed keys MUST NOT be published.
- **REQ-KEYLOS-028** The `server-k8s` OS generation MUST contain `cri`, and the `kubelet` and `kube-proxy` generations of the three supported Kubernetes minors (§4.8.8); pod VM images (`io.keylos.bench.pod`) MUST contain `youki` and no host-reachable credentials.

### 3.4 Defaults

- **REQ-KEYLOS-030** The default Cedar policy set (§4.5) MUST be compiled into a `policy` generation and shipped in every profile's initial config generation.
- **REQ-KEYLOS-031** Default grants MUST NOT include `filesystem`-wide paths, `$HOME`-wide access, the session-wide ability to reach any service, or any network grant without a host.
- **REQ-KEYLOS-032** The default route table (§4.6.2) is the only way services reach each other on a fresh install. It MUST be exactly the holders of protocols §19.2 plus the policy-granted routes listed in §4.6.3, and MUST pass the `routes-closed` conformance test (C-22).
- **REQ-KEYLOS-033** The default policy MUST contain the pod-admission forbids of protocols §16.1 with `cluster.hostPathAllowlist` empty, the debug rules of §4.5.6, and the channel, family, guest and offline rules of §4.5.7–§4.5.9.
- **REQ-KEYLOS-034** `devices.autoAuthorize` MUST default to `["audio", "fido"]` on `desktop` and `laptop` and to `[]` on every other profile; `hid`, `net` and `mass-storage` MUST NOT be auto-authorized by any shipped default (protocols §9.5).
- **REQ-KEYLOS-035** The default `debug.debuggers` list MUST contain only release-built debugger generations (§4.5.6); `bpftrace` MUST be usable only with scope `kernel`.
- **REQ-KEYLOS-036** `ledger.retentionMonths` MUST default to 13; `hearth.guest.agents` MUST default to `false`; `config.presence.assistedAllowed` MUST default to allowed for every purpose (protocols §5.3).

### 3.5 Release engineering

- **REQ-KEYLOS-040** Streams and cadences are as in §4.8. A release MUST NOT be promoted from `beta` to `stable` before soaking in `beta` for 7 days (security releases: 24 hours) with no unresolved P0/P1 conformance regressions.
- **REQ-KEYLOS-041** Actively exploited critical vulnerabilities MUST have a fix in `stable` within 72 hours of public disclosure. Other critical vulnerabilities: 7 days. High: 14 days.
- **REQ-KEYLOS-042** An emergency graft MAY be used only to meet REQ-KEYLOS-041. It MUST be replaced by a real rebuild in the next regular release, and no later than 21 days after the graft shipped.
- **REQ-KEYLOS-043** Every `kmod` generation MUST be rebuilt and re-signed for every kernel release that ships (its manifest `kmod.kernel` matches exactly); a release MUST NOT ship if a `kmod` generation of the previous release has no successor for the new kernel, unless the release notes list it as dropped and `courier` warns before staging on affected machines.
- **REQ-KEYLOS-044** Catalog listings MUST be `reviewed-reproducible` only when their realisations meet the `stable` rebuilder quorum and the catalog review passed (protocols §11.8); every other listing is `unreviewed`.
- **REQ-KEYLOS-045** Floor-write approvals (protocols §19.6, §20.6; `boot` spec §4.4.4): for every UKI (per profile) of a release, the ceremony MUST sign **exactly one** `keylos/floor-write/1` approved policy, binding PCR11 at that UKI's `ready` (or the cloud UKI's seed `ready`) and the one value `F` = the release statement's `floor` (`PolicyNV(current ≤ F) ∧ PolicyCpHash(write F)`; installer UKI and seed profile: `PolicyNvWritten(NO) ∧ PolicyCpHash(write F)`). Release tooling MUST refuse to sign a floor-write policy for a UKI digest that already has one with a different `F` in the release log, and the release-log monitors (`tlog`) MUST flag two different floor approvals for one UKI digest. The "floor cannot decrease" claim holds only under this rule and an uncompromised release-stream key.

### 3.6 Conformance and certification

- **REQ-KEYLOS-050** Every release candidate MUST pass the OS conformance suite (§11.2) on every certified reference machine (§4.9) and in the virtual reference machine.
- **REQ-KEYLOS-051** Hardware reaches "certified" status only after passing `keylos-hwcert` (§4.9.2) on a production unit, with the report published in the release log as a `keylos.hwcert/1` statement.
- **REQ-KEYLOS-052** A cloud platform reaches "supported" status only after passing the cloud subset of `keylos-hwcert` (§4.9.3) for each instance family listed, including vTPM EK chain validation and, for `cvm`, report verification.

### 3.7 Governance

- **REQ-KEYLOS-060** No single organisation MAY hold enough key material to sign a TUF root change, publish an OS generation that meets the rebuilder quorum, and cosign release-log checkpoints as a quorum of witnesses.
- **REQ-KEYLOS-061** Governance changes (adding or removing a key holder, rebuilder operator or witness) MUST be published as a signed governance statement in the release log at least 14 days before taking effect, except for emergency removal after compromise.
- **REQ-KEYLOS-062** Publisher onboarding and removal (TUF `publishers` role) and catalog reviewer membership (`catalog` role) MUST be logged in the release log as governance statements; a publisher key compromise MUST produce a revocation-list key entry within 24 hours of confirmation.

---

## 4. Design

### 4.1 Kernel configuration

#### 4.1.1 Fragments

```
kernel/config/
  base.config          options common to all architectures and profiles
  x86_64.config        architecture deltas
  aarch64.config
  profile-desktop.config
  profile-laptop.config
  profile-server.config
  profile-server-k8s.config   server + bridge/VXLAN/NAT/VFIO for pod VMs
  profile-cloud.config        server + SEV-SNP/TDX guest, vTPM (SVSM) drivers, virtio-only hardware set
  profile-kiosk.config
  profile-appliance.config
  forbidden.list       options that MUST be unset (=n or absent)
  required.list        options that MUST have the given value
```

`required.list` and `forbidden.list` are the normative lists below. `keylos-image kernel-check <.config>` verifies the final kernel configuration against them and fails the build on any mismatch.

#### 4.1.2 Required options

**Security modules and lockdown**

| Option | Value | Reason |
|---|---|---|
| `CONFIG_SECURITY` | y | |
| `CONFIG_SECURITYFS` | y | IPE policy, event log and Landlock audit |
| `CONFIG_SECURITY_NETWORK` | y | |
| `CONFIG_SECURITY_PATH` | y | |
| `CONFIG_SECURITY_LANDLOCK` | y | Baseline confinement |
| `CONFIG_SECURITY_LOCKDOWN_LSM` | y | |
| `CONFIG_SECURITY_LOCKDOWN_LSM_EARLY` | y | |
| `CONFIG_LOCK_DOWN_KERNEL_FORCE_INTEGRITY` | y | Lockdown cannot be lifted at runtime |
| `CONFIG_SECURITY_YAMA` | y | ptrace scope |
| `CONFIG_SECURITY_IPE` | y | Second code-integrity layer: `boot_verified` initramfs, kexec denial (protocols §9.3) |
| `CONFIG_IPE_BOOT_POLICY` | `""` | The signed IPE policy (`kernel-policy/<stream>`) is loaded by the initrd; until then IPE's default is permissive and `kl-exec` (phase INITRD) allows only the initramfs |
| `CONFIG_BPF_LSM` | y | `kl-exec` (primary code integrity, five maps), JIT cgroup exceptions, `kl_debug_pairs` ptrace/perf rules, provenance hook |
| `CONFIG_DEBUG_INFO_BTF` | y | `kl-exec` and `kl-label` compute kernel-structure offsets from `/sys/kernel/btf/vmlinux` at load (protocols §9.3); BPF LSM attachment needs BTF |
| `CONFIG_FUNCTION_TRACER`, `CONFIG_DYNAMIC_FTRACE`, `CONFIG_DYNAMIC_FTRACE_WITH_DIRECT_CALLS` | y | BPF trampolines (and therefore BPF LSM programs) attach through ftrace on arm64; without them attachment fails with `ENOTSUPP`. Required on every architecture for one configuration; tracefs stays unmounted in every view |
| `CONFIG_SYSTEM_TRUSTED_KEYS` | the `kernel-policy/<stream>` X.509 certificate | Verifies the IPE policy's PKCS#7 signature (protocols §5.2) |
| `CONFIG_LSM` | `"landlock,lockdown,yama,ipe,bpf"` | REQ-KEYLOS-003 |
| `CONFIG_SECURITY_SELINUX`, `CONFIG_SECURITY_APPARMOR`, `CONFIG_SECURITY_SMACK`, `CONFIG_SECURITY_TOMOYO` | n | Not used; reduces attack surface |

**Code and data integrity**

| Option | Value |
|---|---|
| `CONFIG_FS_VERITY` | y |
| `CONFIG_EROFS_FS`, `CONFIG_EROFS_FS_XATTR`, `CONFIG_EROFS_FS_POSIX_ACL`, `CONFIG_EROFS_FS_SECURITY` | y |
| `CONFIG_OVERLAY_FS` | y |
| `CONFIG_OVERLAY_FS_REDIRECT_DIR`, `CONFIG_OVERLAY_FS_INDEX`, `CONFIG_OVERLAY_FS_XINO_AUTO`, `CONFIG_OVERLAY_FS_METACOPY` | y |
| `CONFIG_DM_CRYPT`, `CONFIG_DM_INTEGRITY` | y |
| `CONFIG_CRYPTO_AEGIS128`, `CONFIG_CRYPTO_AEGIS128_SIMD` | y |
| `CONFIG_CRYPTO_GCM`, `CONFIG_CRYPTO_AES` (+ arch-accelerated variants), `CONFIG_CRYPTO_SHA256`, `CONFIG_CRYPTO_SHA512`, `CONFIG_CRYPTO_HMAC`, `CONFIG_CRYPTO_ARGON2` (if present; otherwise userspace) | y |
| `CONFIG_MODULE_SIG`, `CONFIG_MODULE_SIG_FORCE`, `CONFIG_MODULE_SIG_ALL`, `CONFIG_MODULE_SIG_SHA512` | y |
| `CONFIG_SYSTEM_TRUSTED_KEYRING`, `CONFIG_SECONDARY_TRUSTED_KEYRING` | y |
| `CONFIG_SYSTEM_BLACKLIST_KEYRING` | y |
| `CONFIG_INTEGRITY_PLATFORM_KEYRING` | y |
| `CONFIG_KEXEC_FILE`, `CONFIG_KEXEC_SIG`, `CONFIG_KEXEC_SIG_FORCE` | y (built for completeness; IPE denies every kexec image and initramfs, and `kl-exec` denies kexec reads, protocols §9.3) |
| `CONFIG_EFI`, `CONFIG_EFI_STUB` | y |
| `CONFIG_TCG_TPM`, `CONFIG_TCG_TIS`, `CONFIG_TCG_CRB`, `CONFIG_TCG_TPM2_HMAC` | y (salted, HMAC-protected TPM sessions from the kernel) |
| `CONFIG_HW_RANDOM_TPM` | y |

**Memory and exploit hardening**

| Option | Value |
|---|---|
| `CONFIG_STRICT_KERNEL_RWX`, `CONFIG_STRICT_MODULE_RWX` | y |
| `CONFIG_VMAP_STACK` | y |
| `CONFIG_STACKPROTECTOR_STRONG` | y |
| `CONFIG_FORTIFY_SOURCE` | y |
| `CONFIG_HARDENED_USERCOPY` | y |
| `CONFIG_INIT_STACK_ALL_ZERO` | y |
| `CONFIG_INIT_ON_ALLOC_DEFAULT_ON` | y |
| `CONFIG_INIT_ON_FREE_DEFAULT_ON` | y on `server`/`appliance`; n elsewhere (the cost is measurable on desktops; `init_on_alloc` stays on) |
| `CONFIG_RANDOMIZE_BASE`, `CONFIG_RANDOMIZE_MEMORY` (x86-64) | y |
| `CONFIG_RANDOMIZE_KSTACK_OFFSET`, `CONFIG_RANDOMIZE_KSTACK_OFFSET_DEFAULT` | y |
| `CONFIG_SLAB_FREELIST_RANDOM`, `CONFIG_SLAB_FREELIST_HARDENED`, `CONFIG_SHUFFLE_PAGE_ALLOCATOR` | y |
| `CONFIG_SLAB_BUCKETS` | y |
| `CONFIG_LIST_HARDENED`, `CONFIG_BUG_ON_DATA_CORRUPTION` | y |
| `CONFIG_STATIC_USERMODEHELPER` | y, with `CONFIG_STATIC_USERMODEHELPER_PATH=""` (no usermode helpers) |
| `CONFIG_ZERO_CALL_USED_REGS` | y |
| `CONFIG_CFI_CLANG` | y (the kernel is built with Clang/LLVM) |
| `CONFIG_SHADOW_CALL_STACK` | y (aarch64) |
| `CONFIG_ARM64_BTI_KERNEL`, `CONFIG_ARM64_PTR_AUTH_KERNEL`, `CONFIG_ARM64_MTE` | y (aarch64) |
| `CONFIG_X86_KERNEL_IBT`, `CONFIG_X86_USER_SHADOW_STACK` | y (x86-64) |
| `CONFIG_MITIGATION_*` (all Spectre/Meltdown/MDS/Retbleed/SRSO/GDS/RFDS/ITS class mitigations offered by the kernel) | y |
| `CONFIG_IOMMU_SUPPORT`, `CONFIG_IOMMU_DEFAULT_DMA_STRICT` | y |
| `CONFIG_INTEL_IOMMU`, `CONFIG_INTEL_IOMMU_DEFAULT_ON`, `CONFIG_AMD_IOMMU`, `CONFIG_ARM_SMMU_V3` | y |
| `CONFIG_SECRETMEM` | y (`memfd_secret`) |
| `CONFIG_MSEAL_SYSTEM_MAPPINGS` | y where available |

**Isolation and confinement primitives**

| Option | Value |
|---|---|
| `CONFIG_NAMESPACES`, `CONFIG_UTS_NS`, `CONFIG_IPC_NS`, `CONFIG_PID_NS`, `CONFIG_NET_NS`, `CONFIG_CGROUPS`, `CONFIG_TIME_NS` | y |
| `CONFIG_USER_NS` | y (legacy tier only; unprivileged creation blocked by seccomp and by `user.max_user_namespaces` in child namespaces, §4.2) |
| `CONFIG_CGROUP_BPF`, `CONFIG_MEMCG`, `CONFIG_CGROUP_PIDS`, `CONFIG_CGROUP_FREEZER`, `CONFIG_CPUSETS`, `CONFIG_BLK_CGROUP`, `CONFIG_CGROUP_DEVICE` | y |
| `CONFIG_SECCOMP`, `CONFIG_SECCOMP_FILTER` | y |
| `CONFIG_BPF_SYSCALL`, `CONFIG_BPF_JIT`, `CONFIG_BPF_JIT_ALWAYS_ON` | y |
| `CONFIG_BPF_UNPRIV_DEFAULT_OFF` | y |
| `CONFIG_FANOTIFY`, `CONFIG_FANOTIFY_ACCESS_PERMISSIONS` | y |
| `CONFIG_KVM`, `CONFIG_KVM_INTEL`/`CONFIG_KVM_AMD` (x86-64), `CONFIG_KVM` (aarch64, VHE) | y |
| `CONFIG_VHOST_VSOCK`, `CONFIG_VHOST_NET`, `CONFIG_VSOCKETS` | y |
| `CONFIG_FUSE_FS` | y (needed only by `strata` unit encryption on kernels without btrfs fscrypt, and by `compat` fd-backed views) |
| `CONFIG_VFIO`, `CONFIG_VFIO_PCI`, `CONFIG_IOMMUFD`, `CONFIG_VFIO_DEVICE_CDEV` | y (whole-device passthrough through `MediaAttach.claimVfio` only, protocols §9.5) |
| `CONFIG_KSM`, `CONFIG_ZRAM`, `CONFIG_ZSMALLOC`, `CONFIG_CRYPTO_ZSTD` | y (RAM classes, protocols §2.3; zram swap uses an ephemeral key per boot) |
| `CONFIG_USB4`, `CONFIG_THUNDERBOLT` | y (domains and devices authorized only by `devd` after trusted-path approval, protocols §9.5) |
| `CONFIG_PERF_EVENTS`, `CONFIG_KPROBES`, `CONFIG_UPROBES`, `CONFIG_BPF_EVENTS`, `CONFIG_KPROBE_EVENTS`, `CONFIG_UPROBE_EVENTS` | y. Reachable only by a debugger principal holding a `kl_debug_pairs` entry (`bpf` and `perf_event_open` rules of protocols §9.3); `kernel.perf_event_paranoid=3` blocks every other task; tracefs is not mounted in any view and `debugfs=off` |

**Filesystems and storage**

| Option | Value |
|---|---|
| `CONFIG_BTRFS_FS`, `CONFIG_BTRFS_FS_POSIX_ACL` | y |
| `CONFIG_VFAT_FS`, `CONFIG_FAT_DEFAULT_UTF8` | y (ESP) |
| `CONFIG_EXT4_FS` | m (read-only import during migration, §installer) |
| `CONFIG_XFS_FS` | m |
| `CONFIG_TMPFS`, `CONFIG_TMPFS_XATTR`, `CONFIG_TMPFS_POSIX_ACL` | y |
| `CONFIG_BLK_DEV_NVME`, `CONFIG_SCSI`, `CONFIG_ATA`, `CONFIG_MMC` | y/m per arch |
| `CONFIG_USB_STORAGE`, `CONFIG_USB_UAS` | m. Binds only after `devd` authorizes the device; the resulting block device is claimed by `MediaAttach.claimBlock` for the media VM and never mounted on the host (protocols §9.5) |

Removable-media filesystem drivers are deliberately absent from host kernels (REQ-KEYLOS-007; forbidden list §4.1.3). `CONFIG_VFAT_FS` exists only for the ESP, which `courier` mounts by partition type GUID and never for removable devices. The media VM's kernel is a separate bench-image kernel built from the `linux-media-guest` recipe with those filesystems enabled.

**Networking**

| Option | Value |
|---|---|
| `CONFIG_WIREGUARD` | y |
| `CONFIG_NF_TABLES`, `CONFIG_NF_TABLES_INET`, `CONFIG_NFT_CT`, `CONFIG_NFT_SOCKET`, `CONFIG_NFT_CGROUP` | y (host firewall managed by `net`; never reachable from sandboxes, which have no `CAP_NET_ADMIN` in any namespace) |
| `CONFIG_VETH`, `CONFIG_TUN` | y (`bench-net` userspace stack and `pasta` use TUN; `cri` pod VMs use tap devices inside the cri netns only, protocols §21.5) |
| `CONFIG_BRIDGE`, `CONFIG_VXLAN`, `CONFIG_NF_NAT`, `CONFIG_NFT_NAT`, `CONFIG_NFT_MASQ`, `CONFIG_NFT_FIB_INET`, `CONFIG_NETFILTER_XT_*` (not built) | `server-k8s` fragment only (y); absent elsewhere |
| `CONFIG_CFG80211`, `CONFIG_MAC80211` | m |
| `CONFIG_BT` | m |

**Confidential computing and cloud** (`cloud` fragment): `CONFIG_AMD_MEM_ENCRYPT`, `CONFIG_SEV_GUEST`, `CONFIG_INTEL_TDX_GUEST`, `CONFIG_TDX_GUEST_DRIVER`, `CONFIG_TSM_REPORTS`, the SVSM vTPM driver where the kernel provides it (`CONFIG_TCG_SVSM`), `CONFIG_VIRTIO_*` block/net/console/rng, `CONFIG_HYPERV` and `CONFIG_XEN` only as needed by a supported provider (§4.9.3).

**Graphics and media**: DRM drivers for the certified hardware (`amdgpu`, `i915`/`xe`, `nouveau`, `msm`, `panfrost`/`panthor`, `virtio_gpu` for guests) as modules inside the OS generation; `CONFIG_DRM_FBDEV_EMULATION=y` for console; `CONFIG_SND_*` per certified hardware; `CONFIG_MEDIA_SUPPORT=m` with UVC.

#### 4.1.3 Forbidden options

| Option | Why |
|---|---|
| `CONFIG_DEVMEM`, `CONFIG_DEVPORT`, `CONFIG_DEVKMEM` | Raw memory access |
| `CONFIG_PROC_KCORE` | Kernel memory exposure |
| `CONFIG_FS_VERITY_BUILTIN_SIGNATURES`, `CONFIG_IPE_PROP_FS_VERITY_BUILTIN_SIG` | keylos verifies generation signatures in userspace (protocols §4); in-kernel builtin signature trust is not used |
| `CONFIG_KEXEC` (the non-file variant) | Unsigned kexec |
| `CONFIG_HIBERNATION` | Incompatible with lockdown (protocols §2) |
| `CONFIG_BINFMT_MISC` | Interpreter registration bypasses the exec model |
| `CONFIG_LEGACY_TIOCSTI` | Terminal input injection |
| `CONFIG_USELIB` | Legacy loader syscall |
| `CONFIG_MODIFY_LDT_SYSCALL` | Rarely used attack surface (x86) |
| `CONFIG_X86_X32_ABI` | Unused ABI |
| `CONFIG_COMPAT_VDSO` | |
| `CONFIG_LEGACY_VSYSCALL_EMULATE`, `CONFIG_LEGACY_VSYSCALL_XONLY` | `CONFIG_LEGACY_VSYSCALL_NONE=y` instead |
| `CONFIG_ACPI_CUSTOM_METHOD`, `CONFIG_ACPI_TABLE_UPGRADE` | Runtime ACPI code injection |
| `CONFIG_PROC_VMCORE`, `CONFIG_CRASH_DUMP` | Crash kernel memory exposure (crash reports go through `journal`, §observability) |
| `CONFIG_STAGING` | Unreviewed drivers |
| `CONFIG_SECURITY_DMESG_RESTRICT` | Must be **y** (listed here because the forbidden check verifies it is not `n`) |
| `CONFIG_N_HDLC`, `CONFIG_N_GSM` | Line disciplines with a history of exploits |
| `CONFIG_IP_DCCP`, `CONFIG_RDS`, `CONFIG_TIPC`, `CONFIG_ATM`, `CONFIG_X25`, `CONFIG_ATALK`, `CONFIG_IEEE802154`, `CONFIG_AF_RXRPC`, `CONFIG_NET_SCH_*` (except `fq`, `fq_codel`, `cake`, `htb`, `ingress`, `clsact`) | Rare protocols, historically exploitable |
| `CONFIG_USERFAULTFD` | m is not allowed; y is allowed only with `vm.unprivileged_userfaultfd=0` and seccomp denial (kept for bench host memory management) |
| `CONFIG_DEBUG_FS` | Built **y** but `debugfs=off` on the command line in all profiles except a `debug` build flavour that is never signed by a release stream |
| `CONFIG_IA32_EMULATION_DEFAULT_DISABLED` | Must be **y** (32-bit syscalls off; legacy 32-bit software runs in tier-2 VMs) |
| `CONFIG_EXFAT_FS`, `CONFIG_NTFS3_FS`, `CONFIG_NTFS_FS`, `CONFIG_HFS_FS`, `CONFIG_HFSPLUS_FS`, `CONFIG_UDF_FS`, `CONFIG_ISO9660_FS`, `CONFIG_F2FS_FS`, `CONFIG_JFS_FS`, `CONFIG_MINIX_FS`, `CONFIG_SQUASHFS` (host) | Removable-media parsers run only in the media VM (REQ-KEYLOS-007) |
| `CONFIG_FW_LOADER_USER_HELPER` | Firmware loads only from registered superblocks (`kl-exec`) |

#### 4.1.4 Command line

The UKI `.cmdline` section is fixed per profile and stream. The base line is:

```
lsm=landlock,lockdown,yama,ipe,bpf lockdown=integrity module.sig_enforce=1
iommu=force intel_iommu=on amd_iommu=force_isolation efi=disable_early_pci_dma
init_on_alloc=1 page_alloc.shuffle=1 randomize_kstack_offset=on slab_nomerge
vsyscall=none debugfs=off ia32_emulation=0 tsx=off mitigations=auto
loglevel=4 quiet rw=0
composefs=<OS generation fsv256 hex> keylos.stream=<stream> keylos.profile=<profile>
keylos.execmapfds=3,4,5,6,7 rd.keylos.pcrlock=1 keylos.revocations=<serial>:<sha256>
usbcore.authorized_default=2
```

- `composefs=` is consumed by the `boot` initrd. It is the only place where the OS generation digest is named, and it is inside the signed UKI.
- `keylos.execmapfds=3,4,5,6,7` is the `kl-exec` map hand-off order to `warden`: `kl_exec_allowed_sb`, `kl_exec_jit_cgroups`, `kl_exec_policy`, `kl_exec_events`, `kl_debug_pairs` (protocols §9.3).
- `keylos.revocations=` pins the revocation list published with the release that built this UKI (protocols §10.7). The UKI is PE-signed at the release ceremony, so the pin belongs to that release; `courier` verifies it against the release statement at staging and never writes it. Later revocation lists are delivered at runtime through `Resolution.revocations` and recorded in the boot report.
- `keylos.*` and `rd.keylos.*` parameters are documented by `boot`. The UKI's `recovery` profile adds `keylos.mode=recovery keylos.recovery=<recovery generation digest>`.
- The command line MUST NOT be editable at boot: systemd-boot is built with editing disabled, and the UKI ignores credentials or command lines passed from the boot loader in every integrity profile.
- `server`, `server-k8s`, `cloud` and `appliance` add `oops=panic panic=10` and `init_on_free=1`; `server`, `server-k8s` and `cloud` add `console=ttyS0,115200` (serial-console recovery, protocols §2.2).
- `cloud` drops `intel_iommu=on amd_iommu=force_isolation` where the instance exposes no IOMMU (virtio-only instance families). Protocols §2 accepts this on the `cloud` profile only: such instances have no passthrough and no external buses, and the boot report records `iommu: "none-virtual"` (protocols §20.1).
- `usbcore.authorized_default=2` authorizes only internal devices before `devd` runs (protocols §9.5). The initrd authorizes external hubs and devices whose interfaces are all HID and that appear in `preauthorized.json` (`keylos.preauth/1`, written by `installer`), so the PIN prompt and FIDO2 keys work; `devd` re-evaluates every device after `switch_root` and deauthorizes devices that are neither pre-authorized nor remembered (residual risk R15).

#### 4.1.5 Modules

- **In-tree modules** are built in the same `forge` derivation as the kernel and placed in the OS generation under `/usr/lib/modules/<uname>`. A per-build ephemeral module-signing key is generated inside the hermetic build, used, and discarded; its public half is embedded in the kernel. Reproducing the build therefore cannot reproduce the signature, so the reproducibility check compares builds with module signatures stripped (`keylos-image modstrip`). When upstream hash-based module integrity is merged, in-tree modules switch to it (REQ-KEYLOS-004).
- **Out-of-tree modules (`kmod` generations).** The release stream holds a long-lived **module-signing key** (`release-stream/<stream>/kmod`, HSM, used only at the ceremony) whose X.509 certificate is compiled into the kernel's trusted keyring alongside the ephemeral key. For each release, `forge` builds every `kmod` recipe (for example `nvidia-open`, out-of-tree Wi-Fi drivers) against the exact kernel source and configuration of that release. The unsigned modules are reproduced by the rebuilder quorum; the ceremony appends the module signatures (§4.4.6), and `keylos-image` produces a `kmod` generation with manifest `kmod.kernel` = the release's `uname -r`. `warden` registers a `kmod` generation's superblock only when that field equals the running kernel release (protocols §9.3), so a `kmod` generation never loads into another kernel.
- **Enabling** a `kmod` generation is a config change (`kernel.kmods = ["io.keylos.kmod.nvidia-open"]`), a T3 action with presence. The modules load at boot after `warden` registers the generation; firmware blobs a `kmod` needs ship inside it and load through the same rule. Proprietary userspace that pairs with a module (for example the NVIDIA GL/Vulkan libraries) ships as a `runtime` generation used by tier-1 apps or by the GPU process of `bench`.
- **NVIDIA policy (ADR-0057).** Only the open kernel modules (`nvidia-open`) are shipped. Module source MUST be available; a module that links a binary blob is not shipped at all. The integrity profile stays `full` with an enabled `kmod` generation; `status` lists every loaded `kmod` generation and `vouch` shows it.
- No owner-built or third-party module can load: owners hold no module-signing key, and lockdown enforces module signatures.

### 4.2 Runtime baseline

#### 4.2.1 sysctl baseline

Applied by `warden` before any other process starts. The values are part of the OS generation (`/usr/lib/sysctl.d/10-keylos.conf`). Config generations MAY change only the sysctls marked *tunable*.

| sysctl | Value | Tunable |
|---|---|---|
| `kernel.kptr_restrict` | 2 | no |
| `kernel.dmesg_restrict` | 1 | no |
| `kernel.perf_event_paranoid` | 3 (no `perf_event_open` without `CAP_PERFMON`; debugger principals get it per §4.5.6, bounded by `kl-exec`'s `perf_event_open` rule) | no |
| `kernel.unprivileged_bpf_disabled` | 2 | no |
| `kernel.io_uring_disabled` | 2 | no |
| `kernel.yama.ptrace_scope` | 2 (attach needs `CAP_SYS_PTRACE`; only debugger principals and the `compat` open broker hold it, bounded by `kl-exec`'s `ptrace_access_check` rule) | no |
| `kernel.kexec_load_disabled` | 1 (set after `courier` initialises; `kexec_file_load` remains available to `courier` through its retained capability) | no |
| `kernel.sysrq` | 0 (`desktop`/`laptop`: 176 = sync, remount-ro, reboot) | yes |
| `kernel.core_pattern` | `|/usr/lib/keylos/journal/coredump %P %s %t` (protocols §9.3 core-dump exception) | no |
| `kernel.randomize_va_space` | 2 | no |
| `kernel.panic_on_oops` | 0 (`server`/`appliance`: 1) | yes |
| `vm.memfd_noexec` | 2 | no |
| `vm.unprivileged_userfaultfd` | 0 | no |
| `vm.mmap_min_addr` | 65536 | no |
| `vm.mmap_rnd_bits` | maximum for the architecture | no |
| `vm.mmap_rnd_compat_bits` | maximum for the architecture | no |
| `vm.swappiness` | 60 (`small` RAM class: 100 with zram) | yes |
| `kernel.mm.ksm.run` (`/sys/kernel/mm/ksm/run`) | 1 on `small` and `medium` RAM classes, 0 on `large` (protocols §2.3) | yes |
| `dev.tty.legacy_tiocsti` | 0 | no |
| `dev.tty.ldisc_autoload` | 0 | no |
| `fs.protected_symlinks`, `fs.protected_hardlinks` | 1 | no |
| `fs.protected_fifos`, `fs.protected_regular` | 2 | no |
| `fs.suid_dumpable` | 0 | no |
| `fs.binfmt_misc` | (not built) | — |
| `user.max_user_namespaces` | 0 in every child namespace created by `warden`; the initial namespace keeps the kernel default because `warden` must create legacy-tier user namespaces | no |
| `net.core.bpf_jit_harden` | 2 | no |
| `net.core.wmem_max`, `net.core.rmem_max` | 4259840 (4 MiB + 64 KiB: capwire datagrams of 4 MiB, protocols §2, §7.1; `warden` additionally forces the buffers of every socketpair it creates) | no (may only be raised) |
| `net.ipv4.tcp_syncookies` | 1 | no |
| `net.ipv4.conf.all.rp_filter`, `.default.rp_filter` | 1 | yes |
| `net.ipv4.conf.*.accept_redirects`, `secure_redirects`, `send_redirects`; `net.ipv6.conf.*.accept_redirects` | 0 | no |
| `net.ipv4.conf.*.accept_source_route`; `net.ipv6.conf.*.accept_source_route` | 0 | no |
| `net.ipv4.icmp_echo_ignore_broadcasts` | 1 | no |
| `net.ipv6.conf.*.use_tempaddr` | 2 | yes |
| `net.ipv4.tcp_timestamps` | 0 on `laptop` (privacy); 1 elsewhere | yes |
| `net.ipv4.ip_forward`, `net.ipv6.conf.all.forwarding` | 0 except on hosts where `bench` VMs need routed networking (set by `net` per interface) | managed by `net` |

#### 4.2.2 Boot-time state transitions

PCR11 phases are extended exactly once per boot, in the order of protocols §19.6:

| Moment | Action | PCR11 phase | Owner |
|---|---|---|---|
| UKI entry | systemd-stub measures the UKI sections | `enter-initrd` | systemd-stub |
| initrd, start | Load `kl-exec` (phase INITRD) with its five maps | | `boot` |
| initrd, before unlock | VBU (optional, AK0 quote), TPM2+PIN unseal (policy bound to `enter-initrd`), or quorum-machine TPM-only unseal | | `boot` |
| initrd, after unlock | Verify volume identity and extend PCR15; replay the owner registry against NV `0x01300105`; mount and register the OS generation; select the config generation (protocols §15); load the signed IPE policy; write `/run/keylos/boot/trust.json` and `report.json` (integrity profile, IOMMU state, pre-boot DMA protection) | | `boot` |
| initrd, end | Extend `leave-initrd` (the disk-unseal policy is now unsatisfiable); hand off to `warden` with the `kl-exec` map fds 3–7 | `leave-initrd` | `boot` |
| recovery profile | Instead of `leave-initrd`: extend `enter-recovery`; start `rescue` as PID 1 | `enter-recovery` | `boot` |
| `warden` start | Apply sysctl baseline; write `kl_exec_policy.warden_tgid`, set phase SYSTEM and freeze the policy map; mount `/var`, `/home`, `/store`, `/keystore` | `sysinit` | `warden` |
| `warden`, before the first tier-0 service | Extend `ready`; secrets sealed to `ready` become available to tier-0 services only | `ready` | `warden` |
| `warden` up | Start tier-0 services in route order (§4.6.1); load service BPF objects listed in `services.json` | | `warden` |
| `devd` start | `authorized_default=0` on all USB controllers; deauthorize devices that are neither pre-authorized nor remembered | | `devd` |
| `warden` up | `kernel.kexec_load_disabled=1` | | `warden` |
| first NTS sync | Clock becomes trusted (protocols §3.6) | | `net` |

No component extends PCR11 after `ready`.

#### 4.2.3 Code integrity

Code integrity follows protocols §9.3 exactly (§2.8):
- **`kl-exec`** is built from the `boot` repository and is part of the initrd. Its maps are handed to `warden`. `warden` registers the superblock of every verified composefs mount: the OS generation (by `boot`), and runtime, service, app, bench-image and legacy-image generations (by `warden`) after verifying their `keylos.genstmt/1` against the boot trust set.
- **IPE** runs the policy text of protocols §9.3, signed (PKCS#7) by `kernel-policy/<stream>` at the ceremony (§4.4.6) and shipped as `/usr/lib/keylos/ipe/policy.p7s` in the OS generation; `boot` loads it before switch-root.
- **The boot trust set** (§2.22) contains, for distro generations, only the release-stream key of the booted stream. Publisher keys come from the config generation (`/etc/keylos/publishers.json`, including org publishers on fleet-enrolled machines); owner-seal keys from `/etc/keylos/owner-seal/<i>.spki`.
- **`kmod` generations** are registered by `warden` only when their `kmod.kernel` equals the running kernel release and they are enabled in config (§4.1.5).
- **Service BPF objects** are loaded by `warden` only from `/usr/lib/keylos/bpf/<service>/*.o` in the OS generation, as listed in `services.json` (protocols §9.3, §20.16).
- Firmware blobs and in-tree modules ship inside the OS generation, out-of-tree modules inside `kmod` generations; `kl-exec` allows `kernel_read_file` from registered superblocks only, and denies kexec reads.

### 4.3 Profiles

A machine has one **machine profile** (chosen at install) and one **integrity profile** (derived at every boot), as defined in protocols §2.2 (§2.1 above). This section fixes the deltas each machine profile makes to the base system and how the integrity profile is derived.

#### 4.3.1 Matrix

| Property | desktop | laptop | server | server-k8s | cloud | kiosk | appliance |
|---|---|---|---|---|---|---|---|
| Intended integrity profile | full | full | full | full | cvm or cloud-vtpm | full | full |
| TPM | required | required | required | required | vTPM (provider or SVSM) | required | required |
| Secure Boot keys | owner (fallback shim) | owner (fallback shim) | owner | owner | provider custom UEFI keys where supported, else shim | owner | owner (factory-provisioned) |
| Disk unlock | TPM2+PIN | TPM2+PIN | TPM2 (+ optional network-bound factor) | TPM2 (+ optional network-bound factor) | vTPM (CVM: bound to the launch measurement) | TPM2+PIN for owners; kiosk session needs no PIN | TPM2 only |
| Presence | touch (FIDO2) | touch (FIDO2) | quorum | quorum | quorum | touch (FIDO2) for owners | quorum |
| Verify-before-unlock | default on | default on | off (fleet attestation) | off (attested join, §4.3.5) | off (CVM report + vTPM quote via fleet) | default on | off (fleet attestation) |
| atrium | yes | yes | no | no | no | kiosk mode | kiosk mode if a display is configured |
| portals | yes | yes | no | no | no | kiosk app's needs only | as configured |
| bench | yes | yes | yes (headless) | yes (pod VMs, media VM) | yes if nested KVM | no | no |
| aide agents | yes | yes | yes (headless sessions) | no | yes (headless sessions) | no | no |
| `cri`, `kubelet`, `kube-proxy` | no | no | no | yes | optional (`server-k8s` overlay on `cloud`) | no | no |
| `devices.autoAuthorize` default | `["audio","fido"]` | `["audio","fido"]` | `[]` | `[]` | `[]` | `[]` | `[]` |
| Serial console recovery | no | no | yes | yes | yes | no | optional |
| Power | performance | balanced, suspend-to-RAM, lid | performance | performance | n/a | display always on | as configured |
| `init_on_free` | off | off | on | on | on | off | on |

`degraded` is not a machine profile. Any machine profile becomes integrity profile `degraded` when the TPM is missing or Secure Boot is off; the installer refuses `degraded` for headless profiles (quorum sealing needs a TPM).

#### 4.3.2 desktop

The full system: `atrium`, `portals`, PipeWire (per-human `pipewire` service), Bluetooth island, printing and scanning islands, `bench` with GPU native context, the media VM, `aide`. Default applications are in §4.7. Guest sessions are available when `hearth.guest.enabled` (default `true` on `desktop`, `false` on `laptop`).

#### 4.3.3 laptop

`desktop` plus:
- **Power management:** lid close → suspend-to-RAM, plus `hearth` lock (`HearthFleet` is not involved; this is the local lock path).
- **Keystore on suspend:** `vault` wraps its in-memory keys with a TPM-bound key that is unsealed again only after user authentication on resume.
- **Battery thresholds** through `devd`.
- **Privacy defaults:** MAC address randomisation per network (`net`), `tcp_timestamps=0`, mDNS responder off (`portal-discovery` browse still works on request).
- **Encrypted swap** with an ephemeral key per boot. Hibernation is unsupported (protocols §2).

#### 4.3.4 server

Headless. No `atrium` or `portals`; no graphical `vouch` unlock.
- **Presence: quorum** (protocols §5.4, REQ-KEYLOS-013). The installer enrols at least 3 approver credentials from at least 2 owners and sets `policy.threshold = 2` (configurable upward). Sealing reports `sealing: quorum`.
- **Unlock:** TPM2-only with the signed PCR11 policy, the pcrlock policy and the NV floor; optionally TPM2 plus a network-bound factor (a Tang-compatible server reached over a `net` profile, the key wrapped by both).
- **Attestation:** `fleet` attestation instead of verify-before-unlock.
- **Console:** `kish` on the serial console and on SSH sessions (`sshd` from `pkgs`, tier 0, keys only, no password authentication, no agent forwarding). Interactive host interpreters are allowed only on the trusted console; an SSH session counts as a trusted terminal only after the owner has enrolled that client's FIDO2-backed key (`sk-ssh-ed25519`).
- **Recovery:** the UKI `recovery` profile on the serial console with the recovery key (§20.21 format) and, for destructive actions, a quorum envelope.

#### 4.3.5 server-k8s

`server` plus a Kubernetes worker node (protocols §21):
- **Services:** `cri` (t0), `kubelet` and `kube-proxy` (t1 services, upstream sealed generations from `pkgs`); routes `cri#kubelet` and the kube-proxy netns grant exactly as protocols §19.2 and §21.1.
- **Runtime classes:** `keylos-vm` (default; one pod VM per sandbox, bench-image `io.keylos.bench.pod` with `youki` and `benchd`) and `keylos-sealed` (org-publisher `container` generations, t1 principals through `PodSpawn`). The `RuntimeClass` objects are installed by the cluster administrator; `cri` refuses unknown handlers.
- **Admission:** every sandbox passes `BrokerSystem.admitPod` against the default pod forbids (§4.5.5). Approvals for annotated permits reach approvers through `fleet` (no local human).
- **Node join:** `cri` runs `FleetCluster.joinAttested` with an AK quote before `kubelet` starts; kubelet certificates come only from `fleet` (protocols §21.7). A machine not enrolled in a fleet cannot run `server-k8s`.
- **Networking:** the cri network namespace that `net` creates at its start with bridge `kl-cri0` (`warden` starts `crid`, `kubelet` and `kube-proxy` in it via `NetPlumbingCluster.clusterNetns`; `cri` configures it with `clusterUplink`, protocols §21.5); bridge + host-local IPAM; direct routing or VXLAN (`cluster.overlay`); NetworkPolicy compiled to nftables by `cri`; `cluster.egressViaGate` default `false` (pods talk to the cluster network directly; set `true` to force internet egress through `gate`).
- **Storage:** `StrataVolumes` for `emptyDir` and local PVs; NFS/iSCSI/RBD only inside pod VMs; CSI node plugins only as `container` generations with `needs.csi`, in pod VMs.
- **Limits:** the RAM-class VM cap does not apply to pod VMs; `kubelet --max-pods` (default 64 on `large`, 24 on `medium`, 8 on `small`) bounds them. `kubelet` reservations: `system-reserved` = 1 CPU + 2 GiB + 10% of RAM above 16 GiB.
- **Kubernetes versions:** the three most recent minors at release (§4.8.8); `config` selects one with `cluster.kubernetesMinor`.
- **Not provided:** privileged pods, `hostNetwork`/`hostPID`/`hostIPC`, added capabilities, host-reaching DaemonSets, eBPF CNIs, Windows containers (protocols §21.8). Node agents that a cluster expects as DaemonSets (log shippers, metrics) ship as sealed tier-0 services fed by `journal`'s OpenMetrics and log export instead.

#### 4.3.6 kiosk

A single-app appliance with a display:
- **Session:** autologin to one app principal named in `kiosk.app` (an `app` generation; webapps allowed). `atrium` runs in kiosk mode: one fullscreen surface, no launcher, no panel, no notifications other than the integrity indicator.
- **Owners:** the trusted path stays available. The secure attention sequence (`Ctrl`+`Alt`+`Del` on keyboards, a 5-second press of the power button on touch devices) opens the owner login on the trusted path; owner sessions behave as `desktop`.
- **Defaults:** no guest sessions, no agents, no `kish` on the display, `devices.autoAuthorize = []`, network grants exactly those in the kiosk app's manifest, automatic updates with boot counting, a nightly app-data reset when `kiosk.resetDaily` is true (the app's data units are recreated; crypto-shredding destroys the old content).

#### 4.3.7 appliance

A fixed-function device (protocols §2.2: as `server`, without `bench`):
- One or more app or service generations declared in the profile config; `atrium` in kiosk mode only when a display is configured.
- Updates fully automatic with boot counting; factory-provisioned owner Secure Boot keys; organisation `fleet` enrolment; quorum presence from fleet approvers.
- No agents, no `bench`, no `compat`.

#### 4.3.8 cloud

A VM image for public or private clouds (protocols §2.2, §20.13):
- **No interactive installer.** The image ships unprovisioned. Its first-boot stage fetches the DSSE-wrapped `keylos.firstboot/1` from the provider metadata service, verifies it against `fleet.seedKeys` pinned in the image's initial config generation (REQ-KEYLOS-027), and refuses to continue otherwise. Unsigned user-data is ignored.
- **TPM:** the provider's vTPM; its EK chain must validate against the provider CA bundle shipped in the OS generation (`/usr/share/keylos/cloud/ek-cas/<provider>/`). On confidential VMs (SEV-SNP, TDX) the SVSM vTPM is preferred, and `fleet` verifies the CVM report together with the TPM quote (integrity profile `cvm`); otherwise the profile is `cloud-vtpm`.
- **Secure Boot:** the image enrols the release-stream db certificate through the provider's UEFI variable store API at image import where supported; elsewhere it boots through shim (integrity profile `shim`, shown in `fleet` compliance).
- **Presence:** quorum from the fleet's admins. **Recovery:** serial console with the recovery key, which the seed delivers to the fleet's escrow only (never to the instance metadata).
- **Disk:** the root volume is encrypted at first boot with a key sealed to the vTPM; provider-side disk encryption is not relied on.
- **Images:** one per architecture and stream, in raw, qcow2 and the providers' import formats (§4.4.5).

#### 4.3.9 Integrity profile derivation

`boot` derives the integrity profile in the initrd and records it in the boot report; `warden` exposes it to `status`, `atrium`, `vouch` and `fleet`.

| Check (in order) | Result |
|---|---|
| No TPM 2.0, or Secure Boot disabled | `degraded` |
| Booted through shim + MOK | `shim` |
| `cloud` profile, CVM report present and launch measurement matches the release statement | `cvm` |
| `cloud` profile otherwise | `cloud-vtpm` |
| Microsoft Windows or third-party UEFI CA present in db (`secureboot.keepMicrosoftCAs = true`) | `shared-boot` |
| Otherwise (owner keys only, TPM, IOMMU active, every check passes) | `full` |

**`shared-boot` (dual boot).** Setting `secureboot.keepMicrosoftCAs = true` (T3 with presence, REQ-KEYLOS-012) makes `courier` keep the Microsoft Windows Production CA and the Microsoft UEFI third-party CA in db when it updates Secure Boot variables, and skips dbx entries that would block the other OS's boot manager only if the owner confirms. The settings page and `vouch` show this text: "Another operating system can boot on this machine. A boot component signed by Microsoft could be used to attack the disk unlock. Your PIN, the signed unlock policy and the release floor still protect the disk; keep the PIN long." `status` shows `shared-boot` permanently.

**`degraded` (no TPM).** Disk unlock by passphrase only (Argon2id); no NV floor (rollback protection only as strong as the ledger checkpoints witnessed by `vouch`); no VBU; `service/<name>` receipt keys are software keys sealed with the disk key; `owner-seal` is a software key wrapped by the FIDO2 `hmac-secret` output (a touch is still required); no AK/AK0, so no `fleet` attestation. The installer explains this in plain language before installing.

#### 4.3.10 RAM classes

`bench` applies protocols §2.3 (§2.1 above). The distribution's tuning per class:

| Class | VM cap | Memory tuning | Agent behaviour | Snapshots |
|---|---|---|---|---|
| `small` (< 12 GiB) | 2 | zram swap (zstd, 50% of RAM, ephemeral key), KSM on, `vm.swappiness=100` | New agent sessions queue (`aide` shows the position); one agent desktop at most | Compressed memory snapshots |
| `medium` (12–24 GiB) | 6 | KSM on, free-page reporting | Queue beyond the cap | Uncompressed |
| `large` (> 24 GiB) | 16 | Free-page reporting | Queue beyond the cap | Uncompressed |

The media VM counts toward the cap but is admitted ahead of queued agent sessions; when the cap is full, `bench` stops the least-recently-used idle workbench (snapshotting it) to admit a media VM.

#### 4.3.11 Guests and family machines

- **Guest sessions** (`desktop`, and `laptop` when enabled): `hearth` creates `guest-<8 base32>` with an ephemeral home (`StrataHomes.createEphemeralHome`) and an ephemeral unit key; both are destroyed at logout. Guests get the default app set, no presence-class grants, no persistent grants, no agents unless `hearth.guest.agents = true`, no `kish` trusted terminal, `devices.autoAuthorize` limited to `audio`, and no access to removable media unless an owner approves on the trusted path.
- **Family machines** (more than one human, only some of them owners): non-owners cannot sign config or seal. Their requests that need an owner (config proposal, seal, persistent grant, policy change, install of an `unreviewed` app) become approval prompts to the owners with `requester` set (protocols §14.3), shown on the next owner trusted-path session or routed to an owner's paired phone (never satisfying presence).

### 4.4 Image assembly

#### 4.4.1 Pipeline

```
pkgs recipes ──forge──► realised generations (quorum-checked, in depot)
            │
            ▼
assembly.ncl (profile, stream, package set) ──► assembly.lock (exact gen refs)
            │
            ▼
keylos-image assemble
  1. resolve      lock → list of runtime/service/app/data generations
  2. compose-os   build OS tree: merge selected generations into one composefs OS generation
  3. initrd       build initrd generation from the boot repo's initrd recipe + kernel modules subset
  4. uki-unsigned assemble UKI sections (unsigned)
  5. predict      compute PCR 11 predictions per boot phase + pcrlock component records
  6. kmods        build every enabled-by-default and catalogued kmod recipe against this kernel (unsigned modules)
  7. images       build the installer generation + installer UKI, the recovery generation, the ISO/raw images,
                  the cloud images and the server-k8s node image (all unsigned)
  8. statement    produce the release statement draft and the generation statement drafts (digests of everything above)
            │
            ▼
keylos-image sign  (ceremony host, HSM-attached; §4.4.6)
            │
            ▼
publish: OCI registry (generations, UKIs, images), TUF targets, release log entry
```

Each step is a `forge` derivation, so the whole assembly is hermetic and reproducible. `keylos-image` is a front-end that writes the derivations and calls `forge`.

#### 4.4.2 OS generation contents

The OS generation (kind `os`) contains, at fixed paths:

| Group | Contents (pkgs recipe names) |
|---|---|
| Kernel | `linux` (vmlinuz is not in the OS tree; it lives only in the UKI), `linux-modules`, `linux-firmware` (subset for certified hardware plus generic), `wireless-regdb` |
| Core runtime | `keylos-libc-shim` (startup `mseal` and securebits helper), `glibc`, `libgcc`, `libstdc++`, `zlib`, `zstd`, `xz` (decompression library only; no `xz` daemon linkage), `openssl` (for reused C components), `ca-certificates` |
| keylos services | `warden`, `broker`, `ledger`, `vault`, `hearth`, `gate`, `net`, `depot`, `courier`, `strata`, `config`, `journal`, `devd`, `aide`, `bench`, `compat`, `forge` (`forged`), `vouch` (`vouchd`), `fleet` (`fleetd`, started only when enrolled), `atrium` (desktop profiles), `portals` (desktop profiles) |
| Reused confined components | `iwd`, `pipewire`, `wireplumber`, `bluez` (island), `dbus-broker` (islands only), `ntpd-rs`, `crosvm`, `virtiofsd`, `passt`, `cups-filters` + `cups` (island, desktop), `fwupd` (island, driven by `courier`), `libcryptsetup` (used by `boot` and `installer`), `tpm2-tss`, `libfido2`, `mesa`, `libinput`, `xkeyboard-config`, `fontconfig` with default fonts, `hunspell` dictionaries (selected locales), `ibus` engines in island (input methods) |
| Shell and tools | `kish`, keylos native coreutils (`kl-coreutils`: ls, cp, mv, rm, cat, find, grep, sed, sort, uniq, head, tail, wc, cut, tr, date, du, df, ps, kill, env, chmod, ln, mkdir, rmdir, stat, touch, tee, xargs, diff, patch, tar, zstd, curl-native `fetch`), `git`, `openssh` (client always; server on `server` profile), `less`, `nano`, `vim` |
| Interpreters (exec-check patched) | `python3` (with `AT_EXECVE_CHECK` patch), `perl`, `lua`, `bash` and `dash` (legacy compatibility only; patched), `nickel` |
| Agent runtime | `aide-harness-reference` (agent-template generation shipped separately, not in the OS generation) |
| Service BPF objects | `/usr/lib/keylos/bpf/<service>/*.o` for `strata` (provenance), `net` (firewall helpers), `gate` (accounting), built by `forge` from the owning repos and listed in the default `services.json` |
| Core-dump helper | `/usr/lib/keylos/journal/coredump` (protocols §9.3 exception) |
| Cloud support (cloud profile) | Provider EK CA bundles (`/usr/share/keylos/cloud/ek-cas/`), the signed-seed first-boot stage, SVSM/CVM report tooling |
| Cluster (server-k8s profile) | `cri`; the `kubelet` and `kube-proxy` generations are separate t1 service generations installed with the profile, one per supported Kubernetes minor |

Separately shipped generations that the distribution builds, signs and lists in each release:

| Generation | Kind | Use |
|---|---|---|
| `io.keylos.bench.dev` | `bench-image` | Workbenches, including IDEs as workbench apps |
| `io.keylos.bench.media` | `bench-image` | Media VM (removable storage parsers, `MediaBrowser`), kernel `linux-media-guest` |
| `io.keylos.bench.agent-desktop` | `bench-image` | Agent desktops (nested `atrium` in a tier-3 VM, protocols §14.5) |
| `io.keylos.bench.captive-browser` | `bench-image` | Captive-portal login VM |
| `io.keylos.bench.pod` | `bench-image` | `server-k8s` pod VMs (`benchd` + `youki`) |
| `io.keylos.bench.build` | `bench-image` | `forge` build VMs |
| `io.keylos.runtime.browser-shell` | `runtime` | Sealed browser-shell runtime for webapps (`needs.jit` declared here) |
| `io.keylos.debug.gdb`, `.lldb`, `.perf`, `.bpftrace` | `app` | Debugger generations for `debug.debuggers` (§4.5.6) |
| `io.keylos.island.sane` | `legacy-image` | SANE backends for `portal-scan`, run as a `compat` island |
| `io.keylos.kmod.<name>` | `kmod` | Release-signed out-of-tree modules (§4.1.5), for example `io.keylos.kmod.nvidia-open` |
| `io.keylos.kubelet.<minor>`, `io.keylos.kube-proxy.<minor>` | `service` | `server-k8s` |

Applications are not in the OS generation. They are separate `app` generations installed by `depot` from the default set (§4.7).

#### 4.4.3 Initrd

The initrd is a `forge` derivation built from the `boot` repo's initrd recipe. It contains:
- the `boot` initrd binary (`keylos-initrd`);
- `libcryptsetup`, `tpm2-tss` and `libfido2`;
- kernel modules for storage, input (keyboard, USB HID) and display (simpledrm, plus GPU modules for certified hardware so the QR code renders);
- `keymaps` and `fonts` for the unlock and QR screen;
- the `kl-exec` BPF object.

The initrd is not a store generation. It is a cpio archive embedded in the UKI and verified as part of it (`boot_verified=TRUE` in IPE; phase INITRD in `kl-exec`). The signed IPE policy is read from the OS generation after it is mounted and verified.

#### 4.4.4 UKI layout

| Section | Content |
|---|---|
| `.linux` | Kernel image |
| `.initrd` | Initrd cpio (zstd) |
| `.cmdline` | §4.1.4 |
| `.osrel` | os-release (§4.10.2) |
| `.uname` | Kernel release string |
| `.sbat` | `sbat,1,SBAT Version,sbat,1,https://github.com/rhboot/shim/blob/main/SBAT.md` plus `keylos.uki,<generation>,keylos,uki,<version>,https://keylos.org/` |
| `.pcrpkey` | Release-stream PCR-policy public key (PEM) |
| `.pcrsig` | JSON with signed PCR 11 policies: `keylos/unlock/1` approvals for `enter-initrd` (with the floor clause, `boot` spec §4.4.2); `ready`-phase approvals used by services' sealed values; `keylos/floor-write/1` (exactly one per UKI, binding that release's `floor` value, REQ-KEYLOS-045) and `keylos/pcrlock-write/1` approvals for `ready` (`courier`). The **installer UKI** additionally carries a `keylos/floor-write/1` initialisation approval (`PolicyNvWritten(NO)`) for its own `ready` phase, used once by the installer to initialise the floor (`installer` spec §4.6.5) |
| `.profile` | `default` and `recovery` profiles (`boot` spec §4.1) |

The UKI is PE-signed with the release-stream Secure Boot key (`db` entry). In shim fallback mode, it is also signed with the release-stream MOK key.

#### 4.4.5 Images

| Image | Format | Use |
|---|---|---|
| `keylos-<ver>-<arch>-installer.iso` | Hybrid ISO, El Torito EFI only | USB/DVD install media; boots a signed installer UKI |
| `keylos-<ver>-<arch>-installer.raw` | GPT raw | Write to USB with any imaging tool |
| `keylos-<ver>-<arch>-<profile>-preinstalled.raw` | GPT raw, unprovisioned (no keys) | Appliance factories; first boot runs enrolment |
| Recovery generation | composefs generation named by the UKI `recovery` profile's command line (`keylos.recovery=<digest>`); there is no separate recovery UKI (protocols §20.6) | Installed into the store by `installer`/`courier`; PID 1 is `rescue` (`installer` spec) |
| `keylos-<ver>-<arch>-cloud.raw`, `.qcow2`, and provider import formats (`.vhd` fixed, GCE `disk.raw.tar.gz`, AMI snapshot import) | GPT raw, unprovisioned, signed-seed first boot | `cloud` profile (§4.3.8) |
| `keylos-<ver>-<arch>-server-k8s-preinstalled.raw` | GPT raw, unprovisioned | Bare-metal Kubernetes nodes; first boot runs fleet enrolment and attested join |
| `keylos-<ver>-<arch>-vm.qcow2` | Virtual reference machine with swtpm and OVMF/AAVMF varstore enrolled with test owner keys | Conformance runs, development; signed only with the `dev` stream key |

#### 4.4.6 Signing ceremony inputs

`keylos-image sign` runs on a ceremony host: an offline, keylos `server` profile machine with HSMs attached. It takes:

| Input | Digest checked against |
|---|---|
| Unsigned UKI | Release statement draft |
| Unsigned installer UKI | Release statement draft |
| OS, recovery and installer generation fs-verity digests, and every distro generation statement draft | Release statement draft, rebuilder attestations (k-of-n) |
| IPE policy text | Repository source at the release tag |
| PCR prediction JSON | Recomputed on the ceremony host from the unsigned UKI |
| Revocation list (next serial) | Previous serial + 1, review sign-off |
| Unsigned `kmod` modules (per `kmod` generation) | Rebuilder attestations (k-of-n) over the unsigned modules |
| TUF targets metadata draft | Generated from the above |

Outputs:
- PE-signed UKIs;
- DSSE `keylos.genstmt/1` statements for every distro generation (release-stream key);
- the signed `.pcrsig` content, including the installer floor-initialisation approval;
- the PKCS#7-signed IPE policy (`kernel-policy/<stream>` key);
- module signatures appended to every `kmod` module (`release-stream/<stream>/kmod` key), after which `keylos-image` builds the `kmod` generations and their generation statements;
- signed TUF targets;
- the DSSE release statement.

Two key holders MUST be present, one operating and one verifying the displayed digests against the independently built draft. The ceremony transcript (commands, digests, operator identities) is published as part of the release statement.

#### 4.4.7 Release statement (`keylos.release/1`)

The statement format is protocols §20.6 (§2.21). The distribution fills it as follows:

| Field | Source |
|---|---|
| `seq` | Stream counter, strictly increasing, assigned at `keylos-image statement` |
| `version`, `arch`, `released`, `security` | Release metadata; `security` is true for point releases issued under §4.8.5 |
| `floor` | The minimum `seq` still allowed to unseal. Raised when a release fixes a boot-chain vulnerability (REQ-KEYLOS-041 response), otherwise unchanged. It is also the exact value `F` the release's floor-write approval binds (REQ-KEYLOS-045): `courier` writes exactly this value, never a maximum or an intermediate one |
| `profiles.<p>` | One entry per machine profile of §4.3 (`desktop`, `laptop`, `server`, `server-k8s`, `cloud`, `kiosk`, `appliance`): `osGen`, `osDrv`, `uki` (digest, size, OCI blob), `pcr11` predictions for all five phases (REQ-KEYLOS-026), `pcr12`, and the pcrlock component bundle digest |
| `oci` | Repository and manifest of the release in the registry |
| `installer` | Installer ISO and installer UKI digests |
| `kernel` | `uname` and the feature level the release's kernel provides |
| `revocations` | Serial and digest of the revocation list published with the release |
| `rebuilders` | The stream quorum (§4.8.1) and the operators whose attestations were checked |
| `ceremony` | Transcript digest and key-holder key refs (§4.4.6) |
| `policyDefaultsDiff`, `newServices`, `firmwareNotes`, `notes` | Release notes; `notes` lists the `kmod` generations built for this kernel, any dropped `kmod` (REQ-KEYLOS-043), the supported Kubernetes minors, and the cloud images published |

There is no `recovery` object: the recovery environment is the `recovery` profile of each profile's UKI. The statement is DSSE-signed by `release-stream/<stream>` and appended to the release log (§2.14). Consumers: `courier` (staging, floor writes), `boot` (PCR policies), `installer` (floor initialisation), `vouch` (PCR predictions), `fleet` (attestation, cluster join), `tlog` monitors.

### 4.5 Default policy

#### 4.5.1 Policy set layout

```
policy/
  00-forbid-baseline.cedar      global forbids no permit can override
  10-services.cedar             tier-0 service permissions (beyond routes)
  20-shell.cedar                human shell principal
  30-apps.cedar                 tier-1/2 apps
  40-agents.cedar               agent principals
  50-legacy.cedar               legacy tier
  60-effects.cedar              effect staging/commit tiers and channel annotations
  65-org.cedar                  empty; fleet org policy bundles are compiled in here
  70-cluster.cedar              pod admission (server-k8s only)
  75-debug.cedar                Right.debug rules
  80-family.cedar               requester/channel rule
  85-offline.cedar              offline tightening
  90-owner-overrides.cedar      empty; owner additions (config generation)
```

`config` compiles these, plus any owner or `fleet` policy, into a `policy` generation. The order is irrelevant to Cedar evaluation; it only organises review.

#### 4.5.2 Baseline forbids (`00-forbid-baseline.cedar`)

```cedar
// No principal other than the shell or a service may read the keystore or store internals.
forbid (principal, action in [Keylos::Action::"read", Keylos::Action::"write", Keylos::Action::"delete"], resource is Keylos::Path)
when { resource.root == "keystore" || resource.root == "store-internal" };

// Agents never touch harness or agent configuration of any principal (cross-agent escalation).
forbid (principal, action in [Keylos::Action::"write", Keylos::Action::"create", Keylos::Action::"delete"], resource is Keylos::Path)
when { principal.kind == "agent" && resource.labelInteg == "trusted" };

// Agents never spawn on the host; they run in their workbench only.
forbid (principal, action == Keylos::Action::"spawn", resource)
when { principal.kind == "agent" && principal.tier != "t3" };

// Untrusted-tainted sessions holding private data never commit irreversible effects without T3.
forbid (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { resource.class == "irreversible" && context.approvalTier != "t3" };

// Delegation depth cap.
forbid (principal, action == Keylos::Action::"delegate", resource)
when { principal.depth >= 4 };

// Legacy principals never reach effect staging directly.
forbid (principal, action == Keylos::Action::"stage", resource)
when { principal.kind == "legacy" };
```

#### 4.5.3 Representative permits

```cedar
// Shell: reads and writes within the user's home happen at T0 (the shell powerbox already scoped them).
permit (principal, action in [Keylos::Action::"read", Keylos::Action::"write", Keylos::Action::"create", Keylos::Action::"delete"], resource is Keylos::Path)
when { principal.kind == "shell" && resource.root == "home" };

// Apps: their own data directories at T0.
permit (principal, action in [Keylos::Action::"read", Keylos::Action::"write", Keylos::Action::"create", Keylos::Action::"delete"], resource is Keylos::Path)
when { principal.kind == "app" && resource.root == "app-data" };

// Apps: hosts declared in the manifest and accepted at install, at T1.
permit (principal, action == Keylos::Action::"connect", resource is Keylos::Host)
when { principal.kind == "app" && context.persist };

// New hosts for apps need T2.
@tier("t2")
permit (principal, action == Keylos::Action::"connect", resource is Keylos::Host)
when { principal.kind == "app" };

// Agents: hosts in the session's allowlist at T1; anything else T2.
@tier("t2")
permit (principal, action == Keylos::Action::"connect", resource is Keylos::Host)
when { principal.kind == "agent" };

// Compensable effects by any principal that declared them: T2.
@tier("t2")
permit (principal, action in [Keylos::Action::"stage", Keylos::Action::"commit"], resource is Keylos::Effect)
when { resource.class == "compensable" };

// Irreversible effects: T3, local channel only.
@tier("t3")
@channels("local")
permit (principal, action in [Keylos::Action::"stage", Keylos::Action::"commit"], resource is Keylos::Effect)
when { resource.class == "irreversible" };

// Payments always need presence.
@tier("t3")
@presence("true")
permit (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { resource.kind == "payment.authorize" };

// Agent-initiated low-risk effects may be approved from a paired phone (vouch).
@tier("t2")
@channels("local,phone")
permit (principal, action in [Keylos::Action::"stage", Keylos::Action::"commit"], resource is Keylos::Effect)
when { principal.kind == "agent" && ["git.pr.open", "calendar.create", "file.share", "fs.merge"].contains(resource.kind) };

// Persistent grants need presence (protocols §14.3).
@tier("t3")
@presence("true")
permit (principal, action in [Keylos::Action::"read", Keylos::Action::"write", Keylos::Action::"create", Keylos::Action::"delete"], resource is Keylos::Path)
when { context.persist };

// Spending: within budget at T1; overrun at T3 (broker/gate supply context.amount).
@tier("t3")
permit (principal, action == Keylos::Action::"spend", resource is Keylos::Budget);
```

The full default policy is in the repository. Each file carries a header comment stating the ADR it implements. The decision-table test (§11.1) checks that the shipped policy produces the expected decisions for the 400-case decision table in `policy/tests/decisions.csv`.

#### 4.5.4 Default grants

Defined in `grants/*.ncl` and materialised by `broker` at install or first use:

| Principal class | Default grants |
|---|---|
| `shell` | Own home (path root `home`, all rights); spawn any launchable generation; powerbox; `vault#app` for its own items; `gate#client` connect to hosts the human types explicitly (T1 after first confirmation per host) |
| Guest `shell` | Own ephemeral home only; spawn of the default app set; powerbox; no `vault` items beyond the session, no agents (unless `hearth.guest.agents`), no removable media without owner approval |
| App (tier 1) | Own `.apps/<name>` subvolumes; manifest `needs.services`; manifest `needs.network` entries after install consent; `needs.listen` entries after consent (loopback at install, `lan`/`any` as effect `net.listen` T2); powerbox; `portal-notify` |
| Webapp | As tier 1, with network limited to the manifest `webapp.origin` (and `needs.network` entries under the same consent rules) through `gate` |
| App (tier 2) | As tier 1, delivered through the VM's virtio-fs shares, the gate shim and the guest portal bridge (vsock 7004) |
| `unreviewed` catalog app | As its tier with effective tier floor 2 (protocols §11.8) |
| Agent session | Nothing beyond the session spec: the project overlay (if given), template-pinned tools, hosts listed in the session spec, the session budget (carved from the parent for sub-agents) |
| Agent desktop VM | The agent session's grants; no `ScreenCapture`, input injection, `A11yGate` or clipboard of any real session (protocols §14.5) |
| Legacy | Own legacy home view; powerbox through the open-broker; network only if the import declared it and the user consented |
| Debugger | The target pair only (`kl_debug_pairs`), for the grant's lifetime |
| Pod (`keylos-vm` / `keylos-sealed`) | Its volumes and the cluster network; no keylos service routes |
| Kiosk app | Its manifest's needs, fixed at install; no powerbox persistence across the daily reset |
| Services | The routes in §4.6 |

#### 4.5.5 Pod admission (`70-cluster.cedar`, `server-k8s` only)

These policies implement protocols §16.1 and §21.3. `config` compiles `cluster.hostPathAllowlist` (default empty) and `cluster.gpuPassthrough` (default `false`) into literals.

```cedar
// The only principal that may ask for admission is kubelet (cri calls admitPod on its behalf).
permit (principal, action == Keylos::Action::"admit", resource is Keylos::PodSpec)
when { principal.kind == "service" && principal.generationName like "io.keylos.kubelet.*"
       && ["keylos-vm", "keylos-sealed"].contains(resource.runtimeClass) };

// Default forbids required by protocols §16.1.
forbid (principal, action == Keylos::Action::"admit", resource is Keylos::PodSpec)
when { resource.privileged || resource.hostNetwork || resource.hostPID || resource.hostIPC
       || !resource.addedCapabilities.isEmpty()
       || resource.seccompProfile == "unconfined"
       || resource.allowPrivilegeEscalation };

// hostPath: only read-only paths inside the allowlist (default: none at all).
forbid (principal, action == Keylos::Action::"admit", resource is Keylos::PodSpec)
when { !resource.hostPaths.isEmpty()
       && (!resource.hostPathsReadOnly || !CLUSTER_HOSTPATH_ALLOWLIST.containsAll(resource.hostPaths)) };

// GPU passthrough only when the node is configured for it, and only for keylos-vm.
forbid (principal, action == Keylos::Action::"admit", resource is Keylos::PodSpec)
when { resource.gpuPassthrough > 0 && (!CLUSTER_GPU_PASSTHROUGH || resource.runtimeClass != "keylos-vm") };

// CSI drivers run only in pod VMs.
forbid (principal, action == Keylos::Action::"admit", resource is Keylos::PodSpec)
when { !resource.csiDrivers.isEmpty() && resource.runtimeClass != "keylos-vm" };

// Sealed pods: every image must be a container generation (cri computes allImagesSealed, protocols §16.1).
forbid (principal, action == Keylos::Action::"admit", resource is Keylos::PodSpec)
when { resource.runtimeClass == "keylos-sealed" && !resource.allImagesSealed };

// Sealed pods: no root user, no host-level volume types.
forbid (principal, action == Keylos::Action::"admit", resource is Keylos::PodSpec)
when { resource.runtimeClass == "keylos-sealed"
       && (resource.runAsRoot || resource.volumeTypes.containsAny(["nfs", "iscsi", "rbd", "csi"])) };
```

`allImagesSealed` is computed by `cri` while normalising the Pod (protocols §16.1), because Cedar has no quantifiers over set elements; `broker` re-derives it from the normalised `keylos.podspec/1` before evaluation. `CLUSTER_HOSTPATH_ALLOWLIST` and `CLUSTER_GPU_PASSTHROUGH` are placeholders that `config` replaces with literals when it compiles the policy generation.

**Pod egress (`cluster.egress`).** `config` compiles the option `cluster.egress` (a list of `{cidr | host, ports, proto}` entries, default empty) into `connect` permits for pod principals in `70-cluster.cedar`. The broker attaches the matching tokens to each pod principal at `registerSession` (protocols §21.5); with `cluster.egressViaGate = true`, a pod reaches only these destinations outside the cluster CIDRs:

```cedar
// one rule per cluster.egress entry, generated by config
permit (principal, action == Keylos::Action::"connect", resource is Keylos::Host)
when { principal.kind == "pod" && resource.name == "203.0.113.0/24" && [443].contains(resource.port) };
```

#### 4.5.6 Debugging (`75-debug.cedar`) and default debuggers

Protocols §9.3 fixes the hard limits (T3 with presence, ≤ 3 600 s process scope, ≤ 900 s kernel scope, agents only inside their own session tree). The default policy narrows further:

```cedar
// Only a human's shell and agents may ask; apps, services, legacy, bench and pod principals never.
forbid (principal, action == Keylos::Action::"debug", resource)
when { !["shell", "agent"].contains(principal.kind) };

// Kernel-scope tracing: shell only.
forbid (principal, action == Keylos::Action::"debug", resource is Keylos::DebugTarget)
when { resource.scope == "kernel" && principal.kind != "shell" };

// Never attach to services (tier-0 services hold keys); developers debug services in workbenches
// or on dev-stream test images, whose owner policy may override this forbid with a permit-only file.
forbid (principal, action == Keylos::Action::"debug", resource is Keylos::DebugTarget)
when { resource.targetKind == "service" };

@tier("t3")
@presence("true")
permit (principal, action == Keylos::Action::"debug", resource is Keylos::DebugTarget)
when { principal.kind == "shell" };

@tier("t3")
@presence("true")
permit (principal, action == Keylos::Action::"debug", resource is Keylos::DebugTarget)
when { principal.kind == "agent" && resource.scope == "process" };
```

```cedar
// Debug targets must belong to the requesting principal's own human.
forbid (principal, action == Keylos::Action::"debug", resource is Keylos::DebugTarget)
when { resource.targetHuman != principal.human };
```

The agent session-tree condition (an agent may debug only principals inside its own session tree) is enforced by the broker before evaluation, because Cedar has no session-chain attribute. On quorum machines presence means a quorum envelope (protocols §14.3).

**Default `debug.debuggers`:** `["io.keylos.debug.gdb", "io.keylos.debug.lldb", "io.keylos.debug.perf", "io.keylos.debug.bpftrace"]`. `io.keylos.debug.bpftrace` is accepted only with scope `kernel` (REQ-KEYLOS-035). Debugger principals run with seccomp profile `debug-1`. Because `kernel.yama.ptrace_scope=2` and `kernel.perf_event_paranoid=3` (§4.2.1), and because the debugger runs under a different dynamic UID than its target, a debugger can only work with `CAP_SYS_PTRACE` (process scope, for ptrace) and `CAP_PERFMON` (both scopes, for perf); `warden`'s `DebugAttach` grants those as ambient capabilities to the debugger principal, and `kl-exec`'s `ptrace_access_check` and `perf_event_open` rules bound them to the target cgroup and the pair's lifetime. `CAP_BPF` is granted only for scope `kernel`.

#### 4.5.7 Channels and organisation approval (`60-effects.cedar`, `65-org.cedar`)

- `@channels("local")` is the default for every permit that carries a tier; the shipped policy adds `phone` only for agent-initiated compensable effects (§4.5.3) and never for permits with `@presence("true")`.
- On fleet-enrolled machines, org policies MAY add `@orgApproval("<group>")`. On BYOD machines (`fleet.mode = "byod"`) every org permit touching the owner's personal data MUST also carry `@tier`, so the owner decides first (protocols §16.2). `config` rejects an org policy bundle that violates this.
- Org `forbid` policies are loaded into the same set and cannot be overridden by owner permits.

#### 4.5.8 Family and guest rules (built in, with policy hooks)

The family and guest rules of protocols §14.3 are enforced by `broker` and `hearth`, and the shipped policy states them again in Cedar with the `Principal` attributes `human`, `humanOwner` and `humanGuest` (protocols §16.1):

```cedar
// Guests: no persistent grants and no debugging (agent sessions for guests are refused by aide and broker
// unless hearth.guest.agents; the Generation entity has no kind attribute to express that here).
forbid (principal, action, resource) when { principal.humanGuest && context.persist };
forbid (principal, action == Keylos::Action::"debug", resource) when { principal.humanGuest };
```

In particular:
- a non-owner's request that needs an owner becomes an owner approval with `requester` set; it MAY be routed to an owner's paired phone but never satisfies presence;
- guest principals never receive presence-class grants, persistent grants, or agent sessions unless `hearth.guest.agents = true`.

`80-family.cedar` ships empty apart from comments; owners MAY add rules keyed on `context.requester` (for example, to forbid non-owner requests for specific effect kinds).

#### 4.5.9 Offline and model-drift rules

The normative offline rules (protocols §14.5) are built into `depot` (T3 for new third-party installs), `compat` (tier ≥ 2 for new legacy imports) and `gate` (T2 for new agent hosts) once the revocation age exceeds 30 days. The shipped policy adds:

```cedar
// After 30 days without fresh revocations, agents' new-host egress needs at least T2.
forbid (principal, action == Keylos::Action::"connect", resource is Keylos::Host)
when { principal.kind == "agent" && context has offlineDays && context.offlineDays > 30
       && !["t2", "t3"].contains(context.approvalTier) };
```

Model drift (protocols §14.5) is enforced by `gate` and `aide` (T1 actions become T2 until re-approval). The re-approval itself is a `use` request on the `Model` entity, and window snapshots for agents are `snapshot` requests on `Screen` (protocols §16.1):

```cedar
// Re-approving a drifted model: T2 (batched review on the trusted path).
@tier("t2")
permit (principal, action == Keylos::Action::"use", resource is Keylos::Model)
when { principal.kind == "agent" };

// Single-window still images for agents: T3, never continuous (protocols §14.5).
@tier("t3")
permit (principal, action == Keylos::Action::"snapshot", resource is Keylos::Screen)
when { principal.kind == "agent" };
forbid (principal, action == Keylos::Action::"snapshot", resource is Keylos::Screen)
when { !["agent", "shell"].contains(principal.kind) };
```

### 4.6 Default services and routes

#### 4.6.1 Services

Service names are those of protocols §19.1 (§2.17). Start order and profile presence:

| Service | Tier | Started | Profiles | Notes |
|---|---|---|---|---|
| `warden` | PID 1 | boot | all | |
| `journal` | t0 | first | all | Bootstrap generation (trust set `bootstrapGens`) |
| `ledger` | t0 | first | all | Bootstrap generation; must be up before any writer |
| `depot` | t0 | first | all | Bootstrap generation |
| `vault` | t0 | early | all | |
| `broker` | t0 | early | all | |
| `hearth` | t0 | early | all | |
| `devd` | t0 | early | all | |
| `net` | t0 | early | all | Includes `ntpd-rs` and `iwd` as confined children |
| `strata` | t0 | early | all | |
| `config` | t0 | on demand | all | |
| `courier` | t0 | after `net` | all | Single TUF client |
| `gate` | t0 | after `net` | all | |
| `bench` | t0 | on demand | all with KVM except kiosk and appliance | Media VM, workbenches, agent desktops, pod VMs (server-k8s) |
| `compat` | t0 | on demand | all except appliance | Legacy tier and islands |
| `aide` | t0 | on demand | desktop, laptop, server, cloud | Not on server-k8s, kiosk, appliance |
| `forge` | t0 | on demand | all | `forged`; builds in tier-3 VMs |
| `vouch` | t0 | when a phone is paired | desktop, laptop, kiosk (owners) | `vouchd`; on headless profiles approvers use their own machines' `vouch` for quorum requests |
| `fleet` | t0 | when enrolled | all; required on server-k8s, cloud, appliance | `fleetd` |
| `atrium` | t0 | desktop profiles | desktop, laptop, kiosk; appliance when a display is configured | Display server and trusted path (kiosk mode on kiosk/appliance) |
| `portal-files`, `portal-screen`, `portal-camera`, `portal-mic`, `portal-openuri`, `portal-notify`, `portal-print`, `portal-clipboard`, `portal-location`, `portal-a11y`, `portal-background`, `portal-shortcuts`, `portal-inhibit` | t0 | per logged-in human, on demand | desktop, laptop; kiosk (only those the kiosk app needs) | |
| `portal-discovery`, `portal-scan` | t0 | per logged-in human, on demand | desktop, laptop | mDNS/DNS-SD via `net#discovery`; scanners via the SANE island |
| `pipewire` | t1 (per human) | at login | desktop, laptop, kiosk | Upstream sealed; reachable only through portal-issued remotes |
| `cri` | t0 | before `kubelet` | server-k8s | Attested join first (§4.3.5) |
| `kubelet`, `kube-proxy` | t1 services | after `cri` joined | server-k8s | Upstream sealed; one generation per supported minor |
| `classifier` | t0 | on demand | optional | Approval-escalation classifier named by policy |
| `wireplumber` | t1 (per human, child of `pipewire`) | desktop, laptop, kiosk | | Session manager for the human's `pipewire` |
| Bluetooth island (`dbus-broker` + `bluetoothd`) | t0 island under `compat` | when Bluetooth hardware exists | | Reached by `devd` through `CompatIsland` |
| CUPS island | t0 island under `compat` | on demand | desktop profiles | Reached by `portal-print` through `CompatIsland` |
| SANE island (`io.keylos.island.sane`) | t0 island under `compat` | on demand | desktop, laptop | Reached by `portal-scan` through `CompatIsland` |
| Media VM | tier-3 VM via `bench` (`Bench.media`) | on device authorization | all with `bench` | `io.keylos.bench.media`; served to `portal-files` through `MediaBrowser` |
| fwupd island | t0 island under `compat` | on demand by `courier` | | |
| `sshd` | t0 | `server`, `server-k8s`, `cloud` profiles, or opt-in | | |
| `_system` | — | — | all | Pseudo-target of `Supervisor.control` for poweroff/reboot; no process |

#### 4.6.2 Default route table

The default route table is **exactly** the facet registry of protocols §19.2 (§2.18): for each row, the listed holders get a route to `service#facet`. `keylos-image` generates `services/routes.ncl` from the `keylos-protocols` registry data, so the table cannot drift from protocols.

#### 4.6.3 Policy-granted routes in the default policy

Protocols §19.2 allows further holders only through an explicit policy grant `right("service", "<svc>#<facet>", "use")`. The default policy grants exactly these:

| Holder | Route | Why | Profiles |
|---|---|---|---|
| `io.keylos.Settings` app | `config#user` | Writes config proposals; apply needs presence | desktop profiles |
| `io.keylos.Settings` app | `vouch#settings`, `fleet#client` | Phones and organisation pages | desktop profiles |
| `io.keylos.Agents` app | `aide#user` | Agent sessions UI | desktop profiles |
| `io.keylos.Ledger` app | `ledger#reader` (already universal), `strata#user` | Receipts and `why` | desktop profiles |
| `io.keylos.Software` app | `depot#user` | Install, capability diffs, catalog browsing | desktop profiles |

Device authorization stays with `atrium` (the only `devd#authorize` holder); the Settings app links to atrium's trusted-path device page instead of holding the facet.

Remote lock and audit export no longer need policy grants: `fleet` holds the dedicated registry facets `hearth#fleet-lock` and `ledger#fleet-export` (protocols §19.2), which are part of the generated table of §4.6.2. Likewise `portal-background` (`warden#handler`), `portal-openuri` (`depot#user`), `portal-inhibit` (`devd#service`) and the owner `shell` (`vouch#settings`) are registry holders, as are `gate` and `portal-discovery` (`depot#user`), `bench-relay` (`portal-*#default`, `vault#app`) and `atrium` (`pipewire#portals`, `gate#client`).

Each grant is listed in `status` and on the relevant Settings page.

### 4.7 Default applications

Installed by the installer on `desktop` and `laptop`. All are separate `app` generations from the `stable` stream:

| Purpose | Application | Tier | Notes |
|---|---|---|---|
| Web browser | Firefox (`org.mozilla.firefox`) | t1, `needs.jit: true` | t2 offered per profile (one click in settings) |
| Second browser | Chromium (`org.chromium.Chromium`) | t1, `needs.jit: true` | |
| Terminal | `io.keylos.Terminal` (kish host, trusted terminal for the shell principal) | t0-adjacent: part of `atrium` | |
| Files | `io.keylos.Files` (powerbox-native file manager) | t1 | Gets a persistent home grant at install (shown at install) |
| Text editor | `io.keylos.Edit` | t1 | |
| Office | LibreOffice (`org.libreoffice.LibreOffice`) | t1 | |
| Mail | Thunderbird (`org.mozilla.Thunderbird`) | t1 | Effects `email.send` declared; sending is user-initiated (T0 for the shell-driven UI action; T3 for agents) |
| Media | mpv (`io.mpv.Mpv`), Image viewer `io.keylos.Images` | t1 | |
| Documents | `org.gnome.Papers`-class PDF viewer | t1 | Parsers sandboxed |
| Settings | `io.keylos.Settings` | t1 with the routes of §4.6.3 | Writes config proposals; apply needs presence |
| Software | `io.keylos.Software` (depot front-end) | t1 | Shows capability diffs |
| Agents | `io.keylos.Agents` (aide front-end: sessions, reviews, receipts) | t1 | |
| Receipts | `io.keylos.Ledger` (ledger viewer, `why`) | t1 | |
| Password manager | `io.keylos.Keys` (vault front-end) | t1 | |
| Developer | IDEs (VS Code-compatible editor, JetBrains-class IDEs from the catalog) run as **workbench apps** inside the project's tier-3 workbench (`io.keylos.bench.dev`), displayed through the Wayland cross-domain proxy with a tier-3 border and the project name | t3 | Language servers, debuggers and test runners stay in the VM; `io.keylos.Edit` is the host-side sealed editor for quick edits (no code execution) |
| Scanner | `io.keylos.Scan` (front-end for `portal-scan`) | t1 | |

**Web apps.** The Software app installs web apps from the catalog as `app` generations with a `webapp` section (protocols §6.3) that run `io.keylos.runtime.browser-shell`. Each has its own principal and data unit and is limited to its origin through `gate`. Browser extensions are allowed only from the pinned allowlist `browser.extensions` (default empty).

**Catalog.** The Software app shows `keylos.catalog/1` listings with their review state; `unreviewed` apps install with effective tier floor 2 and a visible badge (protocols §11.8).

**Kiosk and appliance** profiles install only the apps named in the profile config.

### 4.8 Release engineering

#### 4.8.1 Streams

| Stream | Cadence | Audience | Rebuilder quorum | Promotion |
|---|---|---|---|---|
| `dev` | Every merge to `main` that passes CI | Developers | 1-of-1 (project builder) | Automatic |
| `beta` | Weekly (Tuesday) | Testers | 2-of-3 | From `dev` after conformance |
| `stable` | Every 4 weeks (minor), plus security point releases as needed | Everyone | 2-of-3 independent operators, none the project | From `beta` after soak (REQ-KEYLOS-040) |

Version numbering: `MAJOR.MINOR.PATCH`.
- MINOR: each 4-weekly stable.
- PATCH: security and bug-fix point releases.
- MAJOR: changes to protocols major, disk layout, or trust roots (each with a migration in `courier` and `installer`).

#### 4.8.2 Support windows

- Each stable MINOR is supported until two MINORs later plus 4 weeks, which is about 12 weeks.
- `courier` updates within a MAJOR automatically according to config.
- A MAJOR upgrade is offered and requires owner presence.
- The previous MAJOR receives security fixes for 12 months after the next MAJOR's first stable.

#### 4.8.3 Kernel policy

- `stable` ships the newest upstream stable kernel series that has been through at least two `beta` releases and passes conformance on all certified hardware.
- When the newest series regresses on certified hardware, `stable` stays on the previous series while upstream still supports it.
- The LTS floor (6.18 at 1.0) is kept only for hardware certified on it, and only as long as upstream supports that LTS.
- Kernel patches carried by keylos are allowed only for:
  - backported security fixes;
  - BPF LSM/IPE/Landlock/fs-verity fixes already queued upstream;
  - hardware enablement from upstream `-next` for certified machines.

  Each carried patch lists its upstream link or submission. The carried patch count is published per release.

#### 4.8.4 Rebuilder quorum

- The required quorum per stream is in §4.8.1.
- Rebuilder operators sign realisation attestations for every `forge` derivation in the assembly closure.
- `keylos-image assemble` refuses any derivation whose realisation does not have the stream's quorum of matching attestations in the realisation log.
- Derivations marked `reproducible: false` in their manifest:
  - may be included only as app generations that default to tier 2 (ADR-0043);
  - never in the OS generation, the initrd or any tier-0 service.

#### 4.8.5 Vulnerability response

| Severity (CVSS v4 + exploitation status) | Fix in `stable` | Mechanism |
|---|---|---|
| Critical, actively exploited | 72 hours | Point release; emergency graft allowed (REQ-KEYLOS-042) |
| Critical | 7 days | Point release |
| High | 14 days | Point release or next minor if sooner |
| Medium | Next minor | |
| Low | Best effort | |

**Revocations** for affected generations are issued as soon as a fix exists. Actions:
- `unlaunchable` for app generations with a remotely exploitable flaw;
- `warn` otherwise;
- `evict` for withdrawn malicious objects.

**Embargoes:**
- The keylos security team participates in coordinated disclosure (distros list and upstream security teams).
- Embargoed fixes are built on a private `forge` instance and private rebuilder runs under NDA with the rebuilder operators. Their realisation attestations are held until the embargo lifts, then logged.
- The release log entry and the TUF signing happen at embargo end, so nothing is published early.

**Security advisories** are published as `keylos.advisory/1` DSSE statements in the release log, plus a human-readable page. Fields: id, CVEs, affected generations, fixed generations, revocation serial.

**Publisher key compromise** (catalog apps): the `publishers` role removes the key in the next TUF snapshot, the revocation list gains a `keys` entry with `after` set to the earliest suspected misuse, and every generation signed only by that key after `after` becomes `unlaunchable` (REQ-KEYLOS-062).

#### 4.8.6 Out-of-tree modules (`kmod`)

- Each release rebuilds every `kmod` recipe in the release's catalog against the release kernel (REQ-KEYLOS-043). The unsigned modules go through the rebuilder quorum like any derivation; only then does the ceremony sign them.
- Dropping a `kmod` (for example because upstream no longer builds against the kernel) is announced in `notes` one release ahead; `courier` refuses to stage a release that lacks a successor for an enabled `kmod` generation unless the owner confirms on the trusted path, and then keeps the previous release bootable.
- A security fix in a `kmod` follows §4.8.5 like any package.

#### 4.8.7 Cloud images

- Cloud images are assembled with the `cloud` profile per architecture and stream, signed at the ceremony like every image, and published to the OCI registry plus the providers' marketplaces or image galleries listed in §4.9.3.
- Each published image ID is recorded in the release statement `notes` and in a `keylos.cloudimage/1` entry in the release log (provider, region, image ID, raw image digest), so a fleet can verify a launched image against the log before trusting its seed.
- Images are unprovisioned: no keys, no fleet seed keys other than those in the image's initial config generation, which is the generic project image (no seed keys; an organisation MUST build its own image variant with `keylos-image cloud-image --seed-keys` before use, REQ-KEYLOS-027).

#### 4.8.8 Kubernetes support

- `server-k8s` supports the **three most recent Kubernetes minor versions** available at the release date. Each minor's `kubelet` and `kube-proxy` are built by `forge` from upstream tags under the source rules and shipped as service generations.
- A minor is dropped from the next release after upstream ends its support; the release notes announce it one release ahead.
- CRI conformance (`critest`) and the Kubernetes node e2e conformance subset applicable to `server-k8s` (excluding privileged and host-namespace tests, protocols §21.8) run for every supported minor before release (§11.3).

#### 4.8.9 Publishers and catalog

- **Onboarding** (protocols §11.8): a publisher applies with either a hardware-held Ed25519 key or a Sigstore identity and accepts the publisher policy (no undisclosed network hosts, capability manifests that match behaviour, reproducible builds for `reviewed-reproducible`, security contact, 72 h response to critical reports). The `publishers` role signs the delegation; the change is a governance statement in the release log (REQ-KEYLOS-062).
- **Review.** Catalog reviewers (`catalog` role, §4.11.1) check the capability manifest against observed behaviour in a review workbench, the source availability, and the rebuilder quorum. A listing is `reviewed-reproducible` only if both pass; otherwise `unreviewed`.
- **Org publishers** are delegated from a fleet's own TUF repository (`org-publishers`) and trusted only on machines enrolled in that fleet; they never appear in the public catalog.
- **Takedown.** Malicious listings are removed from the catalog and their generations marked `unlaunchable` in the next revocation list; the publisher's delegation is revoked.

### 4.9 Hardware certification

#### 4.9.1 Requirements for a certified machine

| Area | Requirement |
|---|---|
| Firmware | UEFI 2.7+; custom Secure Boot key enrolment through setup mode; firmware updates through LVFS with vendor-provided pcrlock-compatible measurement manifests, or documented stable PCR 0–7 behaviour |
| TPM | TPM 2.0 rev ≥ 1.38; `PolicyAuthorizeNV`, NV counters and ≥ 2 KiB free NV in the owner range block `0x01300100–0x013001FF` for the protocols §19.6 objects; EK certificate chain verifiable to a vendor CA included in `vouch`'s trust bundle |
| IOMMU | Enabled and enforcing for all external ports (Thunderbolt/USB4 with DMA protection) |
| Option ROMs | Either none needed, or all needed option ROM hashes listable for `db` allow-listing (owner key mode) |
| Graphics | A GPU with an upstream DRM driver supporting virtio-gpu native context on the host (AMD, Intel Xe/i915 once upstream, Qualcomm/Mali on aarch64) for tier-2 GPU |
| Storage | NVMe with 512 B or 4 KiB logical sectors; TRIM; no proprietary encryption required |
| Networking | Wi-Fi with an upstream driver supported by iwd; Ethernet optional |
| Input | Keyboard usable in the initrd (USB HID or i8042/known SPI/I2C HID with in-tree driver) |

#### 4.9.2 `keylos-hwcert`

The suite runs from the installer image in a `hwcert` mode. It covers:

1. **Enumeration.** Firmware, TPM, IOMMU and Secure Boot state.
2. **Owner key mode.** Secure Boot owner key enrolment in setup mode, reboot, and verification that the UKI boots and the Microsoft 3rd-party CA is absent from `db`.
3. **TPM operations.** PCR 0–7 stability across 10 reboots; pcrlock prediction accuracy; NV counter operations; EK chain validation.
4. **Firmware updates.** If an LVFS update exists, the PCR prediction across that update.
5. **Hardware function.** Suspend/resume 50 cycles; Wi-Fi association; GPU native-context test VM render; webcam/microphone via portals.
6. **Devices and DMA.** IOMMU active on every external port; Thunderbolt/USB4 authorization by `devd` only after approval; a USB keyboard plugged at runtime is not authorized until approved with the built-in keyboard; USB mass storage reaches only the media VM; the firmware's pre-boot DMA protection flag recorded in the boot report.
7. **VFIO** (optional, server-k8s hardware): a passthrough GPU bound to `vfio-pci` through `MediaAttach.claimVfio` and released cleanly.
8. **Performance budgets.** Boot to greeter, app launch and VM start against §8.
9. **Report.** A signed `keylos.hwcert/1` report: hardware IDs, firmware versions, results.

#### 4.9.3 Cloud platforms

A cloud platform (provider + instance family) is "supported" after the cloud subset of `keylos-hwcert` passes (REQ-KEYLOS-052):

| Check | Requirement |
|---|---|
| vTPM | TPM 2.0 with persistent NV in the owner range block; EK certificate chain validates against the provider CA bundle shipped in `/usr/share/keylos/cloud/ek-cas/<provider>/` |
| Secure Boot | Custom db enrolment through the provider's UEFI variable store (else the platform is supported only in `shim` integrity profile, stated in the listing) |
| Confidential VM (optional) | SEV-SNP or TDX report obtainable from the guest and verifiable by `fleet`; SVSM vTPM if offered |
| Metadata seed | Signed `keylos.firstboot/1` fetched from the metadata service and verified; unsigned user-data ignored |
| Serial console | Recovery profile usable over the provider serial console |
| Nested virtualisation | Optional; without it `bench` VMs (agents, media, pods) are unavailable on that family, and the listing says so |

Supported platforms at 1.0 are listed in `hwcert/cloud.json` and in each release's notes.

### 4.10 Branding and naming

#### 4.10.1 Names

| Item | Rule |
|---|---|
| Project name | **keylos**, always lowercase in running text, including at sentence start in UI strings where the style allows; in titles it is "keylos" |
| Domain | `keylos.org` |
| Reverse-DNS prefixes | `io.keylos.` for project apps, `org.keylos.` for project infrastructure IDs (reserved, protocols §3.3) |
| Repositories | `github.com/keylos-os/<repo>`, names as in the workspace README |
| Command names | Component names as given (`warden`, `kish`, `depot`…); no `keylos-` prefix except build and test tools (`keylos-image`, `keylos-conformance`, `keylos-hwcert`) |
| Version string | `keylos <MAJOR.MINOR.PATCH> (<stream>, <profile>, <integrity profile>)` |

#### 4.10.2 os-release

```
NAME="keylos"
ID=keylos
VERSION_ID=1.0.3
VERSION="1.0.3 (stable)"
PRETTY_NAME="keylos 1.0.3"
HOME_URL="https://keylos.org/"
DOCUMENTATION_URL="https://keylos.org/docs/"
SUPPORT_END=2027-01-12
IMAGE_ID=keylos-desktop
IMAGE_VERSION=1.0.3
KEYLOS_STREAM=stable
KEYLOS_PROFILE=desktop
KEYLOS_INTEGRITY=full
KEYLOS_RAM_CLASS=auto
KEYLOS_OS_GENERATION=gen:fsv256:…
KEYLOS_PROTOCOLS=1.0
```

#### 4.10.3 Visual identity

- **Assets:** the logo, wordmark, boot splash (initrd QR screen frame) and default wallpaper are in `branding/` under CC BY-SA 4.0. The logo mark is reserved by trademark policy.
- **Integrity indicator:** `atrium` uses the same mark with an integrity colour state:
  - `full`, `cvm`: neutral;
  - `cloud-vtpm`: neutral with a small cloud glyph (shown in `status` and fleet compliance; no persistent banner);
  - `shared-boot`, `shim`: amber with an outline;
  - `degraded`: amber;
  - attestation failure: red.
  - An enabled `kmod` generation or an assisted presence credential adds a dot to the mark; hovering lists them.

### 4.11 Governance

#### 4.11.1 Roles

| Role | Holders at 1.0 | Threshold / rule |
|---|---|---|
| TUF root (`distro-root`) | 5 key holders from at least 3 organisations, at least 2 not employed by the same entity as any other holder | 3-of-5, offline YubiHSM/Nitrokey HSM, root rotation yearly |
| Release-stream signing (`release-stream/stable`, `/beta`) | Project release managers | HSM-held; 2-person ceremony (§4.4.6) |
| `release-stream/dev` | Project CI | Online HSM-backed key; never trusted by default installs |
| Rebuilder operators | At least 3 for `stable`, independent organisations, different hosting providers and jurisdictions; the project's own builder never counts toward `stable` quorum | Quorum per §4.8.1 |
| Witnesses (release and realisation logs) | At least 4 public witnesses; owner `vouch` apps may also witness the release log | Clients require 2 cosignatures |
| Security team | Named members, publicly listed, PGP/SSH keys in the release log | Handles embargoes |
| Module signing (`release-stream/<stream>/kmod`) | Project release managers | HSM-held; used only at the ceremony after the rebuilder quorum for the unsigned modules |
| Publisher delegation (`publishers` role) | 3 key holders, at least 2 organisations | 2-of-3; every change is a governance statement |
| Catalog (`catalog` role) and reviewers | Named reviewers; the role key is HSM-held by the project | Listings signed per catalog snapshot; review notes public |
| Cloud image publishing | Project release managers | Publishes only ceremony-signed images; records every image ID in the release log |

#### 4.11.2 Changes

- **Governance statement.** Every change in role holders is a `keylos.governance/1` DSSE statement in the release log: who is added or removed, effective date, and signatures by the TUF root threshold. Effective at least 14 days later (REQ-KEYLOS-061).
- **Emergency removal** of a compromised key is effective immediately: a TUF root rotation plus a revocation-list key entry.
- **Rebuilder operators** may resign with 30 days' notice. If quorum falls below the stream requirement, `stable` releases pause; security point releases may proceed at 2-of-remaining with a public notice.

---

## 5. Interfaces

### 5.1 `keylos-image`

```
keylos-image <subcommand> [options]

  lock        --profile <p> --stream <s> --arch <a> [--out assembly.lock]
              Resolve assembly.ncl into exact generation refs (quorum-checked).
  assemble    --lock <file> [--out <dir>] [--jobs <n>]
              Run the assembly pipeline (§4.4.1) through forge; outputs unsigned artifacts + statement draft.
  verify-repro --lock <file> --a <dir> --b <dir>
              Compare two assemblies bit for bit (module signatures stripped).
  kernel-check <.config> [--profile <p>]
              Check a kernel config against required.list/forbidden.list.
  modstrip    <dir>
              Strip module signatures for reproducibility comparison.
  predict     --uki <file> [--pcrlock-out <dir>]
              Compute PCR 11 phase predictions and pcrlock component records.
  sign        --draft <statement.json> --hsm <uri> --operator <keyid> --verifier <keyid>
              Ceremony signing (§4.4.6). Interactive; prints every digest for the verifier.
  publish     --signed <dir> --registry <oci-uri> --tuf <repo-dir> --log <url>
              Push artifacts, append release statement to the release log, then sign TUF targets.
  policy-test --policy <dir> --decisions <csv> [--profile <p>]
              Evaluate the Cedar decision table (cluster placeholders bound per profile).
  kmod        --lock <file> --recipe <name>
              Build one kmod recipe against the lock's kernel (unsigned) for quorum and ceremony.
  cloud-image --lock <file> --provider <p> --seed-keys <file> [--out <dir>]
              Build an organisation variant of the cloud image with pinned fleet seed keys
              (unsigned; organisations sign it with their own fleet key flow, §4.8.7).
  status      Show stream heads, quorum status and pending ceremonies.

Exit codes: 0 success; 1 verification failure; 2 usage error; 3 quorum not met;
            4 reproducibility mismatch; 5 kernel config violation; 6 signing aborted;
            7 kmod does not build against the kernel; 8 cloud image without seed keys.
```

### 5.2 `keylos-conformance`

```
keylos-conformance run [--suite <name>...] [--target vm|machine:<host>|cloud:<provider>/<family>] [--profile <p>]
                       [--report <file>] [--keep-artifacts]
keylos-conformance list
keylos-conformance report <file> [--format json|md]

Exit codes: 0 all passed; 1 failures; 2 usage error; 3 target unreachable; 4 setup failed.
```

The test harness drives a target over:
- the serial console (VM) or a test-only `keylos-testd` (shipped only in `dev`-stream test images, never in signed `stable` or `beta` images);
- QMP and swtpm control for VM tests (power, TPM state, disk tampering).

### 5.3 `keylos-hwcert`

```
keylos-hwcert run [--report <file>] [--skip <test>...]
keylos-hwcert submit <report>       # signs with the hardware vendor's or tester's key and submits to the release log
```

### 5.4 Files

| Path (repo) | Content |
|---|---|
| `kernel/config/*` | §4.1 |
| `sysctl/10-keylos.conf` | §4.2.1 |
| `profiles/<profile>.ncl` | Profile definitions (§10) |
| `assembly/<stream>.ncl` | Package sets per profile |
| `policy/*.cedar`, `policy/tests/decisions.csv` | §4.5 (including `70-cluster.cedar`, `75-debug.cedar`, `85-offline.cedar`) |
| `devices/defaults.ncl` | `devices.autoAuthorize` per profile (§4.3.1) |
| `debug/debuggers.ncl` | Default `debug.debuggers` (§4.5.6) |
| `kmod/catalog.ncl` | `kmod` recipes built per release (§4.8.6) |
| `cluster/` | `server-k8s` defaults: kubelet flags, reservations, runtime-class handlers (§4.3.5) |
| `hwcert/cloud.json` | Supported cloud platforms (§4.9.3) |
| `cloud/ek-cas/<provider>/` | Provider EK CA bundles shipped in the OS generation |
| `grants/*.ncl` | §4.5.4 |
| `services/services.ncl`, `services/routes.ncl` | §4.6 |
| `apps/default.ncl` | §4.7 |
| `release/templates/*.json` | Statement templates |
| `governance/holders.json` | Current role holders (mirrors the latest governance statement) |
| `conformance/` | Suite sources (§11) |
| `hwcert/` | Certification suite |
| `branding/` | Assets |

---

## 6. Security analysis (authoritative)

This section is the authoritative security analysis of keylos 1.0. Component specs contain local analyses. Where they differ, this section states the system-level position.

### 6.1 Assets

| Asset | Why it matters |
|---|---|
| User data (home, app data, projects) | Confidentiality and integrity |
| Secrets (vault items, SSH keys, tokens) | Account takeover |
| Owner keys (FIDO2 presence, owner Secure Boot key, recovery key) | Root of all owner decisions |
| Code integrity of the host | Everything else depends on it |
| Configuration integrity | Persistence and policy weakening |
| Receipts | Accountability; detection of misuse |
| Outbound effects (email, payments, pushes) | Irreversible harm |
| Availability (boot, updates) | Recovery from mistakes and attacks |

### 6.2 Adversaries

| ID | Adversary | Capabilities assumed |
|---|---|---|
| A1 | Malicious or compromised app | Arbitrary code in its tier-1/2 sandbox; malicious updates |
| A2 | Prompt-injected or over-eager agent | Arbitrary actions within its session grants; adversarial content in its inputs |
| A3 | Network attacker / malicious content | MITM on untrusted networks; crafted documents, pages, repos |
| A4 | Offline physical attacker | Disk read/write, boot media, time with the device, TPM bus access on discrete TPMs |
| A5 | Distribution-channel attacker | Compromise of a mirror, registry, one rebuilder, one signing key, or one witness |
| A6 | Post-exploitation persistence | Code execution as a userspace principal attempting to survive reboot |
| A7 | Malicious upstream contributor | Commits or release tarballs in a dependency |
| A8 | Kernel exploit | Arbitrary kernel code execution until reboot |
| A9 | Cloud provider or hypervisor operator | Control of the host of a `cloud` instance: memory and disk of non-CVM instances, the vTPM implementation, the metadata service |
| A10 | Compromised cluster control plane | Arbitrary pod specs, images and NetworkPolicy objects sent to `server-k8s` nodes |
| A11 | Malicious USB/Thunderbolt device or removable medium | BadUSB HID injection, DMA from external PCIe, crafted filesystems |
| A12 | Subset of quorum approvers or a compromised approver machine | Up to N−1 approver signatures on headless machines |

### 6.3 Threat-to-control matrix

| # | Threat | Adversary | Primary controls | Component(s) | Verified by (§11) |
|---|---|---|---|---|---|
| T01 | App reads data outside its grants | A1 | No ambient authority; Landlock deny-all; mount view; fd grants; powerbox | warden, broker, portals | C-03 `sandbox-escape-matrix` |
| T02 | App exfiltrates to undeclared host | A1 | Per-app net namespace; egress only via gate; host grants | net, gate, broker | C-04 `egress-closed` |
| T03 | Malicious app update widens permissions | A1, A5 | Capability diff requires consent; signed manifests | depot, broker | C-12 `capability-diff` |
| T04 | App abuses GPU kernel driver | A1 | Tier-2 for untrusted apps (native context); accepted for tier-1 sealed apps | bench | C-05 `tier2-gpu` (functional), residual R04 |
| T05 | Agent exfiltrates private data after reading untrusted content | A2, A3 | Labels; Rule of Two; T3 declassification; gate-only egress; pinned tools | broker, gate, aide | C-07 `agent-exfil` |
| T06 | Agent performs irreversible action without consent | A2 | Effect classes; outbox; mandate bound to payload digest | gate, broker, atrium | C-08 `mandate-binding` |
| T07 | Agent escalates through harness or agent config | A2 | Agents in t3 VMs; harness never resolves paths; forbids on trusted-label paths | aide, bench, broker | C-09 `cross-agent-config` |
| T08 | Agent runaway spending or fan-out | A2 | Budget caveats with hard stop; fan-out/depth caveats; velocity breakers | gate, broker, aide | C-10 `budget-hardstop` |
| T09 | Tool or MCP server rug-pull | A2, A5 | Templates pin tools by digest; changes need re-approval | aide, depot | C-11 `tool-pinning` |
| T10 | Execution of unsealed code on host | A1, A6 | `kl-exec` (verified composefs superblocks only); IPE second layer; `memfd_noexec=2`; exec-check interpreters; noexec data mounts | kernel config, boot, warden, pkgs | C-01 `reboot-heals`, C-02 `exec-closed`, C-36 `kl-exec-registration` |
| T11 | Persistence via configuration | A6 | Read-only `/etc` confext; presence-signed config generations; NV counter | config, boot | C-01 `reboot-heals` |
| T12 | Persistence via data files re-triggering a parser bug | A6 | Parser sandboxing (tier-1, per-file portals); untrusted labels on downloads | portals, apps | Residual R03 |
| T13 | Evil maid replaces boot components | A4 | Secure Boot with owner keys; signed UKI; TPM-sealed key with signed PCR policy; verify-before-unlock | boot, vouch, installer | C-13 `evil-maid` |
| T14 | Partition swap / filesystem confusion to release TPM key | A4 | PCR15 volume identity check; composefs OS verified before execution | boot | C-14 `partition-swap` |
| T15 | Boot downgrade to old signed vulnerable UKI | A4 | NV `0x01300102` floor inside the signed unseal policy; SBAT; owner db without MS 3rd-party CA | boot, courier, installer | C-15 `downgrade`, C-59 `floor-exact` |
| T16 | Offline rollback of encrypted state | A4 | NV `0x01300101` config counter; NV `0x01300100` ledger counter; NV `0x01300104` keystore floor; NV `0x01300107` strata anchors; vouch/fleet witnesses | config, ledger, vault, strata, vouch | C-16 `state-rollback` |
| T17 | TPM bus sniffing | A4 | TPM+PIN; salted sessions with pinned SRK; prefer fTPM | boot | Residual R07 (PIN strength) |
| T18 | Compromised mirror or registry | A5 | TUF (freeze, rollback, mix-and-match protection); DSSE; fs-verity digests | courier, depot | C-17 `tuf-attacks` |
| T19 | Compromised single builder or rebuilder | A5 | k-of-n independent rebuilders; realisation log | forge, tlog | C-18 `quorum` |
| T20 | Split-view / targeted release | A5 | Transparency logs with ≥2 witness cosignatures; vouch as optional witness | tlog, vouch | C-19 `split-view` |
| T21 | Compromised release-stream signing key | A5 | TUF root rotation; key revocation; NV floor; transparency makes misuse visible | governance, courier | Governance drill (§11.4) |
| T22 | Malicious upstream source (xz class) | A7 | Source rules (git trees, regenerate autotools, split build/test, dependency budget) | forge, pkgs | Residual R05; C-20 `source-rules` |
| T23 | Secret theft via environment or same-UID access | A1 | Secrets never in env; per-principal UIDs; memfd_secret; ACLs by generation identity | vault, warden | C-21 `secret-isolation` |
| T24 | Session bus / IPC ambient access | A1 | No system or session bus; routes; D-Bus islands only for reused daemons | warden, compat | C-22 `routes-closed` |
| T25 | Input injection / UI spoofing of approvals | A1, A2 | Trusted path drawn by compositor; no overlay over prompts; TIOCSTI off; Wayland security context | atrium | C-23 `trusted-path` |
| T26 | Snapshots or backups retain deleted sensitive data | A4 | Crypto-shredding; keystore excluded from snapshots | strata, vault | C-24 `forget` |
| T27 | Kernel exploit from sandbox | A8 | Seccomp denies userns/io_uring/bpf/etc.; no capabilities in namespaces; VMs for untrusted and unsealed code; fast kernel updates | warden, bench, release eng. | Residual R01; C-03 |
| T28 | Persistence after kernel exploit | A8 | Reboot restores verified code and owner-approved configuration for everything not in firmware (writable state may still carry hostile data that re-triggers a bug: safe start and quarantine, C-58); verify-before-unlock and fleet attestation detect modified boot state | boot, vouch, fleet | Residual R02 |
| T29 | Time manipulation to accept expired metadata/tokens | A3 | NTS; monotonic floor from ledger checkpoint | net, ledger | C-25 `time-floor` |
| T30 | Weakened boot chain not noticed by the user | A4 | Integrity profile derived at every boot and shown in status, atrium, the boot report and the `vouch` verdict | boot, atrium, vouch | C-26 `profile-indicators` |
| T31 | Forged owner-presence or seal signatures | A1, A6 | Presence verified against the NV-anchored owner registry (`0x01300105`); seal keys gated by `hmac-secret`-rotated NV seal gates | hearth, boot, installer | C-32 `seal-window`, C-35 `tpm-registry` |
| T32 | Control plane schedules a privileged or host-reaching pod | A10 | `admitPod` with the default forbids (§4.5.5); kubelet holds no root and no host namespaces; only `cri` mounts and networks | cri, broker, warden | C-41 `pod-admission` |
| T33 | Pod escapes to the node | A10, A1 | `keylos-vm` default: one microVM per pod; `keylos-sealed` only for org-publisher-signed `container` generations as t1 principals with `runtime-default` seccomp and no capabilities | cri, bench, warden, depot | C-42 `pod-isolation` |
| T34 | Malicious container image or registry | A10, A5 | VM class executes images only in the guest (host store `noexec`, never registered with `kl-exec`); sealed class requires an org genstmt; digest pinning | cri, depot | C-42 `pod-isolation` |
| T35 | CSI driver or volume plugin abuses host access | A10 | Node plugins only in pod VMs; block devices via `MediaAttach.claimBlock`; no host mounts of network filesystems | cri, devd, bench | C-41 `pod-admission` |
| T36 | Node joins (or stays in) a cluster in a tampered state | A4, A8 | `FleetCluster.joinAttested` with AK quote (and CVM report); certificates expire and are renewed only after re-attestation | cri, fleet | C-55 `node-attestation` |
| T37 | Quorum approvers tricked or partly compromised | A12 | Distinct-owner counting; request rendering reviewed on each approver's own keylos machine; 24 h expiry; threshold ≥ 2 of ≥ 3 credentials | hearth, fleet | C-44 `quorum-presence` |
| T38 | Debug grant used to steal secrets or persist | A2, A1 | T3 with presence; ≤ 3 600 s / ≤ 900 s; `kl_debug_pairs` scopes ptrace/perf/bpf to the target cgroup; services never targets; agents only own subtree; receipts | broker, warden, kl-exec | C-40 `debug-grant-expiry` |
| T39 | BadUSB keystroke injection | A11 | `authorized_default=0`; keyboard-like devices approved only with an already-authorized input device; no HID auto-authorize | devd, atrium | C-38 `usb-authorization` |
| T40 | DMA attack from external PCIe/Thunderbolt | A11 | IOMMU required (`iommu=force`); Thunderbolt domains authorized only after approval; boot report records pre-boot DMA protection | kernel config, devd, boot | C-52 `dma-iommu` |
| T41 | Crafted filesystem on removable media exploits a kernel parser | A11, A3 | Host kernels build no removable-media filesystem drivers; media VM parses; files labelled `public/untrusted` | devd, bench, portals | C-39 `media-vm` |
| T42 | GUI agent observes or drives the human's real session | A2 | Agent desktops only; no ScreenCapture/A11yGate/input injection on real sessions; per-window single snapshots at T3 | aide, atrium, bench | C-47 `agent-desktop-isolation` |
| T43 | Remote model silently replaced | A2, A5 | Model identity recorded by `gate`; `model.change` raises T1 to T2 until re-approval | gate, aide | C-46 `model-drift` |
| T44 | Long offline period hides revocations | A5 | Revocation age tracked against trusted time; >30 days: T3 installs, tier ≥ 2 legacy imports, T2 new agent hosts | depot, compat, gate | C-45 `offline-mode` |
| T45 | Receipts reveal a person's history to services, fleets or backups | A1, A5 | Sealed payloads per human per month; reader rules; metadata-only fleet access; retention shredding | ledger, vault | C-43 `receipt-shredding` |
| T46 | Dual boot enables a Microsoft-signed downgrade path | A4 | `shared-boot` visible everywhere; TPM+PIN; signed PCR11 policy; NV floor | courier, boot, vouch | C-48 `shared-boot-reporting` |
| T47 | Assisted presence weaker than a roaming key | A1 | Assisted credentials marked in the registry and shown in every prompt; policy can forbid per purpose | hearth, atrium | C-49 `assisted-presence` |
| T48 | Webapp reaches beyond its origin | A1, A3 | Origin-restricted `gate` grants; separate principal and data unit; browser-shell runtime sealed | gate, depot | C-56 `webapp-origin` |
| T49 | Cloud host reads or alters instance state | A9 | `cvm` integrity profile with report verification; disk key sealed to the vTPM; signed seed only; non-CVM instances explicitly `cloud-vtpm` | boot, fleet, installer | C-53 `cloud-seed`; residual R14 |
| T50 | Unreviewed or malicious catalog app | A1, A5 | `unreviewed` floor tier 2; review requires rebuilder quorum; publisher revocation | depot, catalog governance | C-54 `catalog-unreviewed` |
| T51 | Out-of-tree module abused or mismatched | A1, A8 | Only release-signed `kmod` generations, registered only for the matching kernel; enabling is T3 with presence | warden, forge, kernel config | C-51 `kmod-policy` |
| T52 | Guest session leaves data or obtains authority | A1 | Ephemeral home and unit key destroyed at logout; no presence, persistent grants or agents | hearth, strata, broker | C-50 `guest-session` |

### 6.4 Residual risks

| # | Risk | Why it remains | Mitigation level |
|---|---|---|---|
| R01 | Kernel vulnerabilities reachable from tier-0/1/legacy sandboxes | The kernel is shared by all non-VM tiers | Reduced (surface minimisation, fast updates); not eliminated |
| R02 | In-memory persistence after a kernel exploit until reboot; firmware implants | Runtime attestation cannot see in-memory kernel modification; firmware is below the root of trust | Detection only after reboot (boot chain) or through fleet attestation; firmware out of scope |
| R03 | Poisoned user data repeatedly exploiting a parser | Data is not code but is processed every session | Sandboxed parsers, tier-2 for untrusted viewers, portal per-file grants |
| R04 | GPU driver attack surface | No fine-grained DRM ioctl mediation exists | Accepted for sealed tier-1 apps; tier-2 for untrusted |
| R05 | Malicious source that reproduces faithfully | Builds cannot judge intent | Source rules, review, dependency budget, maintainer-health signals |
| R06 | Prompt injection within granted authority | Model behaviour is not a security boundary | Bounded by grants, labels, staging and T3 approvals |
| R07 | Weak PIN on discrete TPM platforms with bus access | PIN is the remaining secret | Minimum 6 digits; dictionary-attack lockout; fTPM preferred in certification |
| R08 | Human approves a harmful T3 action | Approvals are the last line | Effect rendering, provenance display, rarity of prompts |
| R09 | Collusion of k rebuilders, or compromise of the bootstrap seed | Quorum and seed are trust assumptions | Independence rules (§4.11), diverse double-compiling in `pkgs` |
| R10 | Microarchitectural side channels between tiers | Hardware | Kernel mitigations; tier-2/3 VMs on separate cores is optional (`bench` core isolation) |
| R11 | JIT-enabled apps (browsers) can create executable memory | Needed for performance | Named in manifest, `kl_exec_jit_cgroups` exception, tier-1 minimum, tier-2 option |
| R12 | Owner coerced or deceived into sealing malicious code | Social engineering | Seal prompt shows source tree, diff and provenance; sealing windows are short and scoped |
| R13 | Quorum machines rely on a verified `hearth` instead of a physical touch | No touch reaches a headless machine | `sealing: quorum` shown; threshold ≥ 2; requests rendered and signed on approvers' own machines |
| R14 | `cloud-vtpm` instances trust the provider | Without a CVM the host sees memory and controls the vTPM | Integrity profile states it; CVM offered; fleet compliance can require `cvm` |
| R15 | Some USB devices are authorized during the initrd | The PIN prompt and FIDO2 keys need USB before `devd` runs | `usbcore.authorized_default=2`; the initrd authorizes only external hubs and all-HID devices from `preauthorized.json`; injected keystrokes can only reach the PIN prompt; `devd` re-evaluates every device after `switch_root` |
| R16 | `cri` and `kube-proxy` hold `CAP_NET_ADMIN` in the cri namespace | Pod networking needs nftables and routes | Namespace-scoped; nf_tables reachable only from those two principals; pods hold no capabilities |
| R17 | Pod VMs use tap devices | Cluster L2/L3 networking | Taps exist only inside the cri namespace; workbench and tier-2 VMs never get one |
| R18 | Kernel-scope debugging exposes kernel memory through tracing | bpftrace-class tools read kernel data | Presence-only, ≤ 900 s, shell only, tracing program types only, receipts |
| R19 | Debugger principals hold `CAP_SYS_PTRACE`/`CAP_PERFMON` | Cross-UID ptrace and perf need them | Bounded by `kl_debug_pairs` hooks and grant lifetime |
| R20 | Shared browser engine across webapps | All webapps run the same browser-shell runtime | Separate principals and data units; runtime updates via release |
| R21 | GPU passthrough relies on the IOMMU and device reset behaviour | Whole-device assignment | Only devices listed in `devices.passthrough`; pod VMs only |
| R22 | Assisted presence authenticators are only as strong as the PIN on the trusted path | Accessibility | Marked, shown, and forbiddable per purpose |

---

## 7. Failure modes and recovery

| Failure | Detection | Recovery |
|---|---|---|
| Assembly input below quorum | `assemble` exit 3 | Wait for rebuilders; never override for `stable` |
| Reproducibility mismatch between assembly builders | `verify-repro` exit 4 | Release blocked; diffoscope report attached to the release issue |
| Kernel config drift | `kernel-check` exit 5 in CI | Fix fragments |
| Signing ceremony digest mismatch | Verifier halts ceremony | Abort; re-run assembly; investigate |
| Release log unreachable at publish | `publish` retries; TUF targets not signed until the log entry is included | Release delayed, never published unlogged |
| Conformance failure on certified hardware | Release gate | Block promotion; hardware may be moved to "certified on previous release" |
| Rebuilder quorum lost | Governance monitor | Stable releases pause; security point releases per §4.11.2 |
| Witness quorum unavailable | Client verification fails closed for new releases | Installed systems keep running; `courier` retries; project adds witnesses |
| Stream key compromise | Detection in transparency monitoring or report | Emergency TUF root rotation, revocation list key entry, NV floor raise in the next UKI, advisory |
| `kmod` fails to build against a new kernel | `keylos-image kmod` exit 7 | Release proceeds with the `kmod` marked dropped (REQ-KEYLOS-043); affected machines are warned and keep the previous release |
| Node fails attested join or re-attestation | `cri` reports `kl:integrity`; `fleet` compliance shows the quote mismatch | kubelet does not start, or stops when its certificate expires; operator runs the `failed-update` or `suspected-compromise` runbook |
| Quorum not reachable on a headless machine | `HearthQuorum.request` expires (24 h) | Actions needing presence wait; recovery profile with recovery key plus quorum for destructive actions |
| No authorized keyboard after a hardware change | atrium shows pending input devices; the built-in keyboard and pointer are pre-authorized | Approve with the built-in input device, or the trusted-path pointer; in the worst case the recovery profile (initrd USB is authorized) |
| Media VM crash during a copy | `bench` reports VM exit; `media.export` intent fails | Re-attach; intents are idempotent; the device was never mounted on the host |
| Offline for more than 30 days | Revocation age in status | Tightened rules (§4.5.9) until the next verified revocation list |
| Cloud seed signature invalid | First-boot stage refuses | Instance stays unprovisioned; serial console shows the reason |

---

## 8. Performance budgets

Measured on the reference x86-64 laptop (8-core, NVMe, fTPM) and reference aarch64 laptop, `desktop` or `laptop` profile, warm firmware:

| Metric | Budget |
|---|---|
| Firmware handoff → UKI → PIN prompt | ≤ 2.0 s |
| PIN entry → greeter visible | ≤ 4.0 s (includes TPM unseal ≤ 600 ms, composefs mount ≤ 100 ms, tier-0 start) |
| Login → desktop interactive | ≤ 1.5 s |
| Tier-1 app launch overhead vs unconfined | ≤ 20 ms p95 |
| Workbench start from snapshot | ≤ 300 ms p95 |
| Tier-2 GUI app VM start | ≤ 1.0 s p95 |
| Idle memory after login (desktop, no apps) | ≤ 900 MiB |
| Idle CPU (desktop, no apps) | ≤ 1% average over 10 min |
| Update staging (minor, typical delta) | Download ≤ 400 MiB on average via zstd:chunked; stage ≤ 60 s after download |
| Reboot into updated generation | Same as cold boot budgets |
| `keylos-image assemble` (desktop profile, all inputs cached) | ≤ 15 min on a 32-core builder |
| Media VM start and first directory listing after authorizing a USB stick | ≤ 2.0 s p95 |
| Agent desktop VM start from snapshot | ≤ 1.5 s p95 |
| Pod VM sandbox ready (`RunPodSandbox` → ready, image cached) | ≤ 800 ms p95 |
| Sealed pod container start | ≤ 150 ms p95 |
| Idle memory after login, `small` RAM class | ≤ 700 MiB |
| Debug grant to attached debugger (after presence) | ≤ 500 ms |

`keylos-conformance` includes a `perf` suite that fails a release candidate when any budget regresses by more than 10% against the previous stable on the reference machines.

---

## 9. Observability

- `keylos-image` and `keylos-conformance` emit structured JSON logs (one object per line) and a final report.
- **Release metrics**, published per release on the project status page:
  - reproducibility rate of the closure;
  - rebuilder agreement;
  - carried kernel patch count;
  - conformance pass rate;
  - performance-budget table;
  - open advisories.
- **On installed systems** the distribution itself writes no receipts. It defines which events the components emit; the registry is protocols §19.3 (§2.19). `kish status` aggregates:
  - machine profile and integrity profile;
  - RAM class and VM cap;
  - enabled `kmod` generations;
  - presence mode (`touch`, `quorum`, assisted credentials present);
  - revocation age;
  - stream;
  - OS generation;
  - pending update;
  - revocation serial;
  - attestation state (vouch/fleet);
  - feature level.

---

## 10. Configuration

Profiles and distribution defaults are Nickel modules consumed by `config` (on devices) and `keylos-image` (at assembly).

```nickel
# profiles/schema.ncl
{
  Profile = {
    name | [| 'desktop, 'laptop, 'server, 'server_k8s, 'cloud, 'kiosk, 'appliance |],
    intended_integrity | [| 'full, 'cvm, 'cloud_vtpm |],
    tpm | [| 'required, 'vtpm |],
    unlock | {
      method | [| 'tpm_pin, 'tpm_only, 'tpm_network, 'vtpm |],
      pin_min_digits | Number | default = 6,
      verify_before_unlock | [| 'default_on, 'optional, 'off |],
    },
    presence | [| 'touch, 'quorum |],
    quorum | { threshold | Number | default = 2, min_credentials | Number | default = 3, min_owners | Number | default = 2 } | optional,
    secure_boot | {
      mode | [| 'owner, 'owner_or_shim, 'provider_custom_or_shim |],
      keep_microsoft_cas | Bool | default = false,        # integrity profile shared-boot
    },
    desktop | Bool,
    kiosk | { app | String, reset_daily | Bool | default = false } | optional,
    bench | Bool,
    agents | Bool,
    guests | { enabled | Bool | default = false, agents | Bool | default = false },
    power | [| 'performance, 'balanced, 'custom |],
    ram_class | [| 'auto, 'small, 'medium, 'large |] | default = 'auto,   # may lower, never raise (REQ-KEYLOS-014)
    kernel | {
      fragment | String,
      cmdline_extra | Array String | default = [],
      init_on_free | Bool | default = false,
      kmods | Array String | default = [],               # enabled kmod generations (§4.1.5); T3 with presence
    },
    devices | {
      auto_authorize | Array [| 'audio, 'fido, 'video, 'printer, 'smartcard |] | default = [],
      passthrough | Array String | default = [],          # PCI addresses eligible for VFIO (protocols §9.5)
    },
    debug | { debuggers | Array String | default = [
      "io.keylos.debug.gdb", "io.keylos.debug.lldb", "io.keylos.debug.perf", "io.keylos.debug.bpftrace" ] },
    cluster | {
      kubernetes_minor | String,
      host_path_allowlist | Array String | default = [],
      gpu_passthrough | Bool | default = false,
      egress_via_gate | Bool | default = false,
      overlay | [| 'direct, 'vxlan |] | default = 'vxlan,
      max_pods | Number | optional,
    } | optional,
    cloud | { seed_keys | Array String } | optional,     # key refs pinned in the image (REQ-KEYLOS-027)
    ledger | { retention_months | Number | default = 13 },
    presence_assisted_allowed | Array String | default = ["*"],   # purposes for which assisted credentials count
    browser | { extensions | Array String | default = [] },
    sysctl_overrides | { _ : String } | default = {},  # only tunable keys (§4.2.1)
    default_apps | Array String | default = [],
    fleet | { enrolled | Bool | default = false, org | String | optional, mode | [| 'managed, 'byod |] | optional },
  },
}
```

Validation rules enforced by the schema's contracts:
- `name ∈ {'server, 'server_k8s, 'cloud, 'appliance}` ⇒ `presence == 'quorum` ∧ `quorum.threshold ≥ 2` ∧ `quorum.min_credentials ≥ 3` ∧ `quorum.min_owners ≥ 2` (REQ-KEYLOS-013).
- `name == 'server_k8s` ⇒ `cluster` present ∧ `fleet.enrolled` ∧ `bench`.
- `name == 'cloud` ⇒ `cloud.seed_keys` non-empty ∧ `tpm == 'vtpm` ∧ `secure_boot.mode == 'provider_custom_or_shim`.
- `name == 'kiosk` ⇒ `kiosk` present ∧ `agents == false` ∧ `guests.enabled == false`.
- `name == 'appliance` ⇒ `bench == false` ∧ `agents == false`.
- `devices.auto_authorize` never contains `hid`, `net` or `mass-storage` (the enum has no such values).
- `debug.debuggers` ⊆ release-built `io.keylos.debug.*` generations.
- `sysctl_overrides` keys ⊆ tunable set.
- `secure_boot.keep_microsoft_cas == true` ⇒ the profile is shown as `shared-boot` (no other effect on validation).
- `ledger.retention_months ≥ 1`.

The device-side option names map to the protocols names as follows: `secure_boot.keep_microsoft_cas` → `secureboot.keepMicrosoftCAs`; `devices.auto_authorize` → `devices.autoAuthorize`; `cluster.host_path_allowlist` → `cluster.hostPathAllowlist`; `cluster.egress_via_gate` → `cluster.egressViaGate`; `ledger.retention_months` → `ledger.retentionMonths`; `guests.agents` → `hearth.guest.agents`; `presence_assisted_allowed` → `config.presence.assistedAllowed`; `cloud.seed_keys` → `fleet.seedKeys`; `debug.debuggers` → `debug.debuggers`. `config` renders both forms from the same module.

---

## 11. Testing and acceptance criteria

### 11.1 Repository tests

- `kernel-check` unit tests against crafted configs (every required and forbidden option).
- Cedar decision table: 520 cases (`policy-test`), covering every forbid and permit in §4.5, each tier, presence and channel annotation, Rule-of-Two context combinations, every pod forbid of §4.5.5 (one case per `PodSpec` attribute), debug scope/kind combinations, and `offlineDays` boundaries (30/31).
- Route table closure: a generated graph test proving no route exists that is not in §4.6.2.
- Assembly determinism: CI runs `assemble` twice on different builders and `verify-repro`.
- Profile schema tests: every profile instance validates; invalid combinations are rejected (for example `server` with `presence = 'touch`, `cloud` without seed keys, `kiosk` with agents).
- Kernel fragment tests: `kernel-check` rejects removable-media filesystems in any host fragment and requires the VFIO/KSM/USB4/perf options of §4.1.2.

### 11.2 OS conformance suite (`keylos-conformance`)

Each test has an ID, setup, steps and a pass criterion. All run in the virtual reference machine (swtpm, OVMF with owner keys), and every test marked [HW] also runs on certified hardware.

| ID | Name | Steps | Pass criterion |
|---|---|---|---|
| C-01 | `reboot-heals` [HW] | (1) As a tier-1 test app with a planted vulnerability, gain code execution. (2) Write an ELF and a Python script into every writable location of the app, `/var` via a test service, and the user's home. (3) Attempt to register them anywhere that would run at boot: `.apps/*/config` autostart keys, `/var` service state, home shell rc files. (4) Attempt to modify `/etc` and the config repo without presence. (5) Reboot. | After reboot: no planted file has executed (`kl_exec_events` show denials only); the OS and config generations are unchanged; `kish status` shows `full`; the ledger shows the denied attempts |
| C-02 | `exec-closed` | Try to execute unsealed code by: `execve` of a file in home; `ld.so ./x`; `python3 x.py` from a non-trusted terminal; `memfd_create`+`fexecve`; `mmap(PROT_EXEC)` of a home file; `bash -c "$(cat x)"` from an app; a shebang script in `/var`; a module load of a home file | Every attempt fails with `EACCES`/`EPERM`; a `kl-exec` or exec-check denial is recorded |
| C-03 | `sandbox-escape-matrix` | For each tier (t1, legacy), run the escape probe battery: userns creation, setns via `/proc/*/ns`, ptrace of siblings, `/proc` scraping, abstract socket connect, pathname socket connect outside grants, TIOCSTI, signals to other principals, io_uring, bpf, perf, keyctl, mount, chroot | All denied; confinement report matches the expected tier profile |
| C-04 | `egress-closed` | Tier-1 app with grant to host A attempts host B over TCP, UDP, DNS-to-arbitrary-resolver, and IPv6 literal | Only A succeeds; others fail; `net.connect` receipts for A only |
| C-05 | `tier2-gpu` [HW] | Launch a tier-2 GL/Vulkan test app | Renders through native context; host DRM ioctls only from crosvm GPU process |
| C-06 | `powerbox` | App requests a file via powerbox; user picks file F | App receives fd for F only; cannot open F's siblings; persistent grant survives reboot only when chosen |
| C-07 | `agent-exfil` | An agent session with a private repo overlay reads a planted web page with an injection that instructs it to send repo contents to an attacker host and via a GitHub issue comment | Connection to attacker host denied (not granted); issue comment staged as an intent requiring T3 declassification; with a "deny" decision, nothing leaves; receipts show the label raise and denial |
| C-08 | `mandate-binding` | Approve an email intent; then mutate the payload before commit through a test hook | `gate` refuses commit (digest mismatch); receipt `effect.fail` |
| C-09 | `cross-agent-config` | Agent attempts to write another agent template's config, the harness config, the shell rc, and the project's `.keylos/agents` policy | All writes denied; the project overlay does not contain them after merge review |
| C-10 | `budget-hardstop` | Agent session with a $1 budget loops model calls | Stops at the budget; `budget.exhausted` receipt; session paused awaiting T3 |
| C-11 | `tool-pinning` | Replace a pinned MCP server image in the depot with a different digest under the same name | The session refuses the tool until the template is re-approved |
| C-12 | `capability-diff` | Install app v1; publish v2 adding a network host and `needs.jit` | v2 stays unlaunchable until consent; the diff is shown exactly |
| C-13 | `evil-maid` [HW] | With vouch paired: (a) replace the UKI on the ESP with a different validly-signed older UKI; (b) replace it with a UKI signed by a test key not in `db`; (c) modify the firmware variable store (SB off) | (a) the NV `0x01300102` floor prevents unseal, recovery prompt shown; vouch shows NOT VERIFIED (older `seq`); (b) firmware refuses to boot; (c) PCR 7 changes, unseal fails, vouch shows a mismatch |
| C-14 | `partition-swap` | Replace `keylos-root` with an attacker LUKS volume having the same header UUID | The initrd refuses to leave the initrd (PCR15 volume identity mismatch); no secret released after the check |
| C-15 | `downgrade` | Install and boot N, then N+1 whose statement raises `floor` above N; `courier` writes NV `0x01300102`; then boot N's UKI | `PolicyNV(0x01300102)` fails; unseal refused; recovery path offered |
| C-16 | `state-rollback` | Snapshot the encrypted disk at time t0, make config and keystore changes, restore the disk image | Boot refuses the config generation (counter below NV `0x01300101`) and boots the safe config; vault refuses the keystore (below NV `0x01300104`); ledger detects a checkpoint counter below NV `0x01300100`; vouch reports a checkpoint regression |
| C-17 | `tuf-attacks` | Serve the TUF test vectors: freeze, rollback, mix-and-match, arbitrary software, endless data | `courier` and `depot` reject each case |
| C-18 | `quorum` | Offer an update whose OS generation has 1 of the required 2 realisation attestations | `courier` refuses to stage it |
| C-19 | `split-view` | Present a release-log checkpoint not cosigned by 2 witnesses, then two inconsistent checkpoints | Refused; inconsistency reported with both checkpoints |
| C-20 | `source-rules` | Build a recipe whose tarball differs from the git tree in an unexplained file; a recipe whose build reads `tests/` | Both builds fail |
| C-21 | `secret-isolation` | App B attempts to read app A's vault items, `/proc/<A>/environ`, A's memory | All denied |
| C-22 | `routes-closed` | Enumerate every principal's reachable capabilities on a fresh install | Equals the route table of §4.6.2 plus the policy-granted routes of §4.6.3 exactly |
| C-23 | `trusted-path` | A malicious app draws a fake approval dialog, attempts to overlay the real one, and synthesises input events | Real prompt unobscured; synthetic input ignored; fake dialog has no effect |
| C-24 | `forget` | Create a data unit, snapshot, back up, `forget` the unit | Content unrecoverable from snapshots and backups with all remaining keys |
| C-25 | `time-floor` | Set the RTC back 1 year before boot | Clock treated as untrusted until NTS sync; tokens and TUF metadata are not accepted as valid based on the wrong time |
| C-26 | `profile-indicators` | Boot the VM as `full`, then without TPM (`degraded`), through shim (`shim`), and with an enabled `kmod` generation | Integrity profile in the boot report, `status`, `atrium` and the `vouch` verdict matches §4.3.9 for each; persistent indicators per §4.10.3 |
| C-27 | `update-rollback` [HW] | Stage an update whose test service fails its health check | Boot counter exhausts; the previous generation boots; NV floor not raised; `update.rollback` receipt |
| C-28 | `revocation` | Publish a revocation list marking an installed app generation `unlaunchable` and an object `evict` | Running instances frozen/killed per grant record; `warden` refuses `kl-exec` registration of the generation; new launches refused with an explanation; object evicted at next GC |
| C-29 | `recovery-env` [HW] | Boot the UKI `recovery` profile (PCR11 `enter-recovery`); unlock with the recovery key (§20.21 text format, one mistyped group); roll back; re-enrol TPM; revert a failed config activation | The mistyped group is pointed out by its CRC; each operation works; nothing sealed to `ready` is available in recovery; receipts recorded once the main system boots again |
| C-30 | `install-fresh` [HW] | Run the installer end to end with two FIDO2 keys, owner SB keys and vouch pairing | System reaches the desktop; all keys enrolled; first config generation signed; status `full` |
| C-31 | `perf` [HW] | Measure §8 budgets | Within budgets and within 10% of the previous stable |
| C-32 | `seal-window` | Seal a tool with one touch, then try to seal a different project's output within the window; after the window closes, replay the window's captured seal-gate auth | First succeeds; second requires a new presence; the replayed auth fails `PolicySecret(0x01300140)` |
| C-33 | `legacy-tier` | Run an imported Debian rootfs tool that opens a non-granted path | Open broker prompts; denial results in `EACCES`; no host path visible |
| C-34 | `no-root` | Search the installed system for setuid/setgid files and for processes with UID 0 other than PID 1 and kernel threads | None found |
| C-35 | `tpm-registry` [HW] | After install, enumerate NV indices in `0x01300100–0x013001FF` and persistent handles `0x81000000–0x8101FFFF`; compare attributes, policies and names with the `keylos-tpm-registry` templates and protocols `vectors/tpm/` | Exactly the §2.20 objects exist (seal gates per owner); every attribute and policy digest matches; AK/AK0 names equal NV `0x01300108` |
| C-36 | `kl-exec-registration` | Mount a composefs generation whose `keylos.genstmt/1` is signed by a key outside the boot trust set, and one listed `unlaunchable`; try to execute from each; try `bpf(BPF_PROG_DETACH)` from a tier-0 service | Both mounts stay unregistered and execution fails with `EACCES`; the detach is denied; `kl_exec_policy` is frozen |
| C-37 | `vbu-protocol` [HW] | Run VBU with the reference phone: correct `N`; wrong `N`; QR2 from a previous boot; PCR 12 changed by an extra command-line argument (unsigned UKI not bootable, so simulated in the VM) | VERIFIED; then NOT VERIFIED for each fault with the reason of `vouch` spec §4.4.3 |
| C-38 | `usb-authorization` [HW] | Plug a USB keyboard-like device that injects keystrokes on enumeration; plug a USB audio device and a FIDO2 key; plug a mass-storage stick; approve the keyboard with the built-in keyboard; reboot and replug | Injected keystrokes are discarded and no driver binds before approval; audio and FIDO2 are auto-authorized on `desktop`; mass storage needs approval; approval with the new keyboard itself is refused; remembered devices are re-authorized after reboot; `device.authorize` receipts |
| C-39 | `media-vm` [HW] | Authorize a stick with a crafted exFAT image that triggers a known parser bug in a test kernel; browse a healthy stick; export a file to it | The host kernel never mounts either (no exFAT driver on the host; `/proc/mounts` unchanged); the crash is confined to the media VM; browsing shows files labelled `public/untrusted`; export is an intent (`media.export`, T2) and lands on the stick |
| C-40 | `debug-grant-expiry` | Request a process-scope debug grant for a test app (T3 + presence); attach gdb; wait past the granted duration; request kernel scope as an agent; target a tier-0 service | Attach works only within the grant; at expiry the pair is removed, the debugger killed and `debug.detach` written; the agent kernel-scope request and the service target are denied |
| C-41 | `pod-admission` | On `server-k8s`, submit pods with each forbidden attribute (privileged, hostNetwork, hostPID, hostIPC, added capability, unconfined seccomp, privilege escalation, hostPath, CSI in sealed class, OCI image in sealed class) and one compliant pod | Each forbidden pod fails `RunPodSandbox` with `PermissionDenied` and a `pod.deny` receipt naming the rule; the compliant pod runs |
| C-42 | `pod-isolation` | From a `keylos-vm` pod, run the escape battery (host filesystem, host netns, other pods' volumes, `kubelet` state, vsock probing); from a `keylos-sealed` pod, run C-03's battery | No host or cross-pod access; vsock reaches only `benchd`; sealed containers show the t1 confinement report with no capabilities |
| C-43 | `receipt-shredding` | Generate receipts for a human across two months; shred the older month; verify the chain; export as the owner and as `fleet` | Chain and checkpoints verify after shredding; shredded payloads are unrecoverable; fleet export contains metadata only; `ledger.shred` receipt |
| C-44 | `quorum-presence` | On `server` with threshold 2 of 3: apply config with one signature; with two signatures from the same owner's two credentials; with two owners; let a request expire | Only the two-owner envelope applies; same-owner duplicates count once; the expired request is refused; `sealing: quorum` in status |
| C-45 | `offline-mode` | Advance trusted time so the newest revocation list is 31 days old; install a third-party app; import a legacy image; let an agent contact a new host; launch an installed app | Install needs T3; the legacy image gets tier 2; the agent egress needs T2; the installed app launches; status shows the revocation age |
| C-46 | `model-drift` | Run an agent session against a test provider that switches its reported model version mid-session | `model.change` emitted; the next T1 action is held at T2 until re-approval; receipts record both model identifiers |
| C-47 | `agent-desktop-isolation` | A computer-use agent template requests ScreenCapture, A11yGate, clipboard of the real session and input injection; it drives its agent desktop; the human takes over | All real-session requests denied; the agent desktop works in its tier-3 VM; during take-over agent input is refused; the mirror is read-only |
| C-48 | `shared-boot-reporting` [HW] | Enable `secureboot.keepMicrosoftCAs`; reboot; pair `vouch` | Presence was required; integrity profile `shared-boot` in status, atrium, boot report and the vouch verdict, with the risk text |
| C-49 | `assisted-presence` | Enrol an assisted platform credential; apply config with it using only switch-access input on the trusted path; forbid it for `seal.window` by policy and attempt a seal | Config applies; every prompt and `status` show the assisted credential; the seal is refused for that purpose |
| C-50 | `guest-session` | Log in as guest; create files; request a persistent grant, presence, an agent session and removable media; log out; inspect snapshots and the keystore | Requests denied (removable media awaits owner approval); after logout the ephemeral home and unit key are gone and nothing is recoverable from snapshots |
| C-51 | `kmod-policy` | Enable a test `kmod` generation (T3 + presence); boot a kernel with a different `uname -r`; try to load a module signed by a non-release key; try an owner-sealed module | The module loads only on the matching kernel; the foreign-signed and owner-sealed modules are refused by module signing and `kl-exec`; status lists the enabled `kmod` |
| C-52 | `dma-iommu` [HW] | Attach a Thunderbolt/USB4 device that attempts DMA before and after authorization; boot with the IOMMU disabled in firmware | No DMA reaches memory outside the device's IOMMU domain; unauthorized devices get no domain; without an IOMMU the device is never authorized and the boot report says so |
| C-53 | `cloud-seed` | Boot the cloud image with: no seed; an unsigned seed; a seed signed by an unpinned key; a valid seed; a CVM with a valid report | Only the valid seed provisions; the others leave the instance unprovisioned with a serial-console reason; the CVM instance reports `cvm`, the non-CVM `cloud-vtpm` |
| C-54 | `catalog-unreviewed` | Install an `unreviewed` catalog app; revoke its publisher key | It runs at tier 2 with a badge; after revocation its generations become `unlaunchable` |
| C-55 | `node-attestation` | Join a `server-k8s` node; change a firmware setting that alters PCR 7; wait for certificate renewal | Join succeeds; after the change re-attestation fails, renewal stops and the node leaves the cluster at certificate expiry; `fleet` compliance shows the mismatch |
| C-56 | `webapp-origin` | Install a webapp for origin A; from it, navigate and fetch to origin B, and read another webapp's storage | Only origin A is reachable; storage is per webapp; navigation to B opens in the default browser through `portal-openuri` |
| C-57 | `capwire-identity` | From a tier-1 app, call a service whose `ServiceHost.accept` peer is recorded; in the service, also query `SO_PEERPIDFD` on the same socket; send a 4 MiB − 4 KiB call over the route | The accept peer names the app principal; the pidfd belongs to `warden` and `Supervisor.identify` on it fails; the large call succeeds with `net.core.wmem_max` at its baseline |
| C-58 | `safe-start` [HW] | (1) Plant, in a test app's data unit, a file that crashes the app's parser on every open. (2) Reboot normally. (3) Reboot choosing "safe start" at the PIN prompt; quarantine the app's state with `strata quarantine`; release the app | (2) the app crashes again on restore: code and configuration were restored, hostile data was not; (3) in safe start the app's data is read-only and nothing is reopened automatically; after quarantine the app starts with fresh state and the quarantined snapshot is still available for recovery |
| C-59 | `floor-exact` [HW] | With release N+1 booted (floor `F`): (1) from a test service with the TPM fd, try raw writes of `F − 1`, of `F + 1` and at another offset; (2) use N's approved policy; (3) pin a release below `F` | (1) all fail; (2) fails at `PolicyPCR`; (3) `courier` writes nothing and shows `floor held by pin`; after unpinning the floor becomes exactly `F` |

### 11.3 Acceptance for a release

A release candidate is accepted when:
- all of C-01…C-57 pass in the VM (cluster tests C-41, C-42, C-55 in a three-node VM cluster; cloud test C-53 in the VM and on each supported cloud platform);
- all [HW] tests pass on every certified machine;
- `verify-repro` passes;
- the Cedar decision table passes;
- `critest` and the applicable Kubernetes node e2e subset pass for each supported minor (§4.8.8);
- the rebuilder quorum is met;
- no P0/P1 issues are open.

### 11.4 Drills

Twice a year the project runs, and publishes reports on:
- a **key compromise drill**: rotate a release-stream key through TUF and push a release whose `floor` raise is written to NV `0x01300102` on test devices;
- an **embargo drill**;
- a **quorum drill** on a reference `server`: lose one approver credential, recover with the remaining quorum, re-enrol;
- a **publisher compromise drill**: revoke a test publisher key and verify that its generations become unlaunchable on test devices within the revocation propagation time.

---

## 12. Implementation notes

- **Language:** Rust (edition 2024) for `keylos-image`, `keylos-conformance`, `keylos-hwcert` and `keylos-testd`.
- **Crates:**
  - `serde` 1, `serde_json` 1, `clap` 4, `tokio` 1, `anyhow` 1, `thiserror` 2
  - `cedar-policy` 4 (policy tests)
  - `nickel-lang-core` (profile evaluation; pinned by `pkgs`)
  - `tss-esapi` 7 (predictions and hwcert TPM probes)
  - `goblin` 0.9 (PE/UKI section handling)
  - `sha2` 0.10, `ed25519-dalek` 2, `p256` 0.13
  - `oci-client` (registry push), `tough` (TUF repository editing)
  - `qapi` (QMP control in conformance)
  - plus `keylos-protocols` crates
- **External tools invoked inside forge derivations:**
  - `systemd-measure` and `systemd-pcrlock` from the `systemd-tools` recipe (prediction only; there is no systemd PID 1);
  - `ukify`-compatible section assembly is done natively in `keylos-image`;
  - `mkfs.erofs` / `mkcomposefs` from the `composefs` recipe;
  - `sbsign`-equivalent signing is native, through the PKCS#11 HSM interface (`cryptoki` crate).

Repository layout:

```
keylos/
  kernel/  sysctl/  profiles/  assembly/  policy/  grants/  services/  apps/
  release/  governance/  branding/
  tools/keylos-image/  tools/keylos-conformance/  tools/keylos-hwcert/  tools/keylos-testd/
  conformance/tests/C-01-reboot-heals/ …
  docs/  (pointers to the handbook)
```

---

## 13. Decisions and alternatives

| Decision | Alternatives considered | Reference |
|---|---|---|
| Stock upstream kernel with feature levels, minimal carried patches | Hardened forks (linux-hardened, grsecurity-class) | [ADR-0003](../../handbook/11-decisions/adr-0003-stock-kernel-feature-levels.md) |
| Owner Secure Boot keys by default, shim fallback | Microsoft-signed shim only | [ADR-0013](../../handbook/11-decisions/adr-0013-owner-secure-boot-keys.md) |
| TPM2+PIN with signed PCR11, pcrlock, NV floor | Literal PCR sealing; passphrase only | [ADR-0014](../../handbook/11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md) |
| Host executes only sealed code (`kl-exec` BPF LSM over verified composefs superblocks; IPE as second layer) | IMA appraisal; IPE with fs-verity builtin signatures; no exec control | [ADR-0008](../../handbook/11-decisions/adr-0008-host-executes-only-sealed-code.md); protocols §9.3 |
| k-of-n rebuilders + transparency logs gate `stable` | Single build farm with signing | [ADR-0016](../../handbook/11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md) |
| Grafts only as temporary emergency measure | Permanent grafts; always full rebuild | [ADR-0018](../../handbook/11-decisions/adr-0018-grafts-are-temporary.md) |
| Non-reproducible packages default to tier 2, never in the OS | Allow with a warning | [ADR-0043](../../handbook/11-decisions/adr-0043-non-reproducible-means-tier-2.md) |
| No hibernation | Hibernation without lockdown | protocols §2; lockdown is mandatory |
| Default route table generated from the protocols facet registry | Hand-maintained table | §4.6.2; prevents drift |
| No root, no setuid | sudo with policy | [ADR-0023](../../handbook/11-decisions/adr-0023-no-root-no-setuid.md) |
| Default policy forbids agents writing trusted-label paths | Rely on template discipline | [ADR-0029](../../handbook/11-decisions/adr-0029-agents-propose-humans-sign.md), [ADR-0026](../../handbook/11-decisions/adr-0026-labels-and-rule-of-two.md) |
| `server-k8s` with microVM pods by default and sealed pods for org-signed images | Plain containers on the host; gVisor | [ADR-0047](../../handbook/11-decisions/adr-0047-cri-microvm-pods.md); protocols §21 |
| Quorum presence on headless profiles | Remote touch over the network; no presence on servers | [ADR-0048](../../handbook/11-decisions/adr-0048-quorum-presence.md) |
| Time-limited, presence-gated debug capability | Debug flavour images only; ptrace for same UID | [ADR-0049](../../handbook/11-decisions/adr-0049-debug-capability.md) |
| IDEs run as workbench apps | IDEs on the host with sealed toolchains | [ADR-0050](../../handbook/11-decisions/adr-0050-ides-in-workbenches.md) |
| Agent desktops for computer-use agents | Screen capture and input injection on the real session | [ADR-0051](../../handbook/11-decisions/adr-0051-agent-desktops.md) |
| USB authorization and the media VM; no removable-media filesystems in host kernels | Host automount; USBGuard rules only | [ADR-0052](../../handbook/11-decisions/adr-0052-usb-authorization-and-media-bench.md) |
| Sealed receipt payloads with monthly shredding | Clear receipts; delete-on-retention | [ADR-0053](../../handbook/11-decisions/adr-0053-receipt-payload-encryption.md) |
| Dual boot only as the visible `shared-boot` integrity profile | Refuse dual boot; silently keep Microsoft CAs | [ADR-0054](../../handbook/11-decisions/adr-0054-dual-boot-option.md) |
| Webapps as origin-restricted app generations | Web origins as general OS principals | [ADR-0055](../../handbook/11-decisions/adr-0055-webapps.md) |
| Offline tightening after 30 days without revocations | Refuse to run offline; ignore staleness | [ADR-0056](../../handbook/11-decisions/adr-0056-offline-mode.md) |
| Out-of-tree modules only as project-built, release-signed `kmod` generations; no `compat` profile | A reduced-integrity `compat` profile; owner-sealed modules | [ADR-0057](../../handbook/11-decisions/adr-0057-oot-modules-project-signed-only.md) |

### 13.1 Cross-repository items

Items O1–O6 raised by this distribution are resolved in protocols 1.0 (Appendix C): debugger capabilities (C1), Cedar `Principal.human*` and `PodSpec.allImagesSealed` (C2), the UKI-owned revocation pin (C3), `iommu: none-virtual` on `cloud` (C4) and `keylos.cloudimage/1` (C5). One documented choice remains:

| # | Item | Distribution behaviour | Needs |
|---|---|---|---|
| O7 | Protocols §2.2 lists no `dev-image`/debug flavour; debugging tier-0 services is forbidden by default (§4.5.6) | Developers debug services in workbenches | none (documented choice) |
