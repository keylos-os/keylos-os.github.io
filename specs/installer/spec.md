# keylos/installer: installation, enrolment and recovery

| | |
|---|---|
| Repository | `github.com/keylos-os/installer` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `installer` (live-session tier-0 service), `installer-ui` (atrium client for the live session), `installer-tui` (text/serial UI), `keylos-seed` (first-boot provisioning stage of `cloud` images), `rescue` (PID 1 of the recovery generation), `keylos-enrol` (re-enrolment tool shared by `rescue` and the main system), recipes for the installer image and the recovery generation (consumed by `keylos` image assembly) |
| Depends on | `keylos-protocols 1.0` (crates `keylos-ids`, `keylos-formats`, `keylos-presence`, `keylos-tpm-registry`, `keylos-capwire`, `keylos-schemas`); `vouch` 1.0 crate `vouch-proto` (pairing); `config` 1.0 CLI `config bootstrap`; `depot` 1.0 CLI `depot import-closure`; `libcryptsetup` ≥ 2.7, `tpm2-tss` ≥ 4.1, `libfido2` ≥ 1.15 |
| Provides | Installed keylos systems in a fully enrolled state (interactive, unattended, and cloud first-boot seeding); the first-boot bundle (`keylos.firstboot/1`); the genesis owner registry entries for touch and quorum machines; recovery-key trustee share cards; the recovery environment, including completion of organisation wipes; re-enrolment after TPM, firmware or FIDO2 loss |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

The installer takes a machine from bare metal to a keylos system with:
- encrypted storage (LUKS2 with AEAD integrity, btrfs subvolumes);
- owner-controlled Secure Boot keys, or the shim fallback;
- TPM-sealed unlock with a PIN;
- on interactive profiles, two enrolled owner credentials (two roaming FIDO2 keys by default, or one roaming key plus an assisted platform credential) and a genesis owner registry in `touch` mode; on headless profiles (`server`, `server-k8s`, `cloud`, `appliance`), a remotely enrolled owner set in `quorum` mode (protocols §5.4);
- a per-owner seal gate and owner-seal key;
- the TPM owner and endorsement hierarchy authorizations sealed for `hearth`, and the lockout authorization derived from the recovery key (protocols §19.6);
- every TPM object of protocols §19.6, created with the `keylos-tpm-registry` templates;
- a recovery key, shown once and confirmed;
- a first presence-signed config generation;
- an optional `vouch` pairing.

It also provides the **recovery environment**: the recovery generation whose PID 1 is `rescue`, started by `boot`'s recovery profile after the recovery key unlocks the disk. From it the owner can inspect, roll back, re-enrol the TPM or FIDO2 credentials, reinstall while keeping `/home`, or factory-reset the machine. The same `rescue` program also runs from the installer media, for machines whose installed store is unusable.

### 1.1 In scope

- Live installer session: graphical through `atrium` live mode; text mode on serial consoles and for the `server` profile.
- Hardware checks and profile selection.
- Disk partitioning, LUKS2 with AEAD integrity, btrfs subvolumes.
- Copying the OS generation, the recovery generation and the default applications into the target store.
- TPM provisioning: SRK pinning, every NV index and persistent object of protocols §19.6, the sealed unlock token, sealed authorization values for the services that own NV counters.
- Owner FIDO2 enrolment (two credentials by default), the genesis owner-registry entry, the owner's seal gate and owner-seal key.
- Owner Secure Boot key enrolment (setup mode, option-ROM allow-listing), optionally keeping the Microsoft CAs for dual boot (`secureboot.keepMicrosoftCAs`, integrity profile `shared-boot`), or shim+MOK fallback.
- Quorum-mode owner enrolment for headless profiles, with pre-signed genesis entries.
- Cloud first-boot seeding from a fleet-signed bundle (`keylos-seed`, protocols §20.13 "Cloud seed").
- Recovery-key trustee share cards (protocols §20.19).
- Recovery key generation and confirmation.
- First config generation creation and signing.
- `vouch` pairing.
- Unattended installation for `appliance` and fleet deployments.
- Reinstall preserving `/home`; migration of home data from another Linux installation.
- The recovery environment (`rescue`), including completion of organisation wipes (protocols §14.5), and owner-run re-enrolment (`keylos-enrol`).

### 1.2 Non-goals

- Dual boot in the `full` integrity profile. Owner-key Secure Boot without Microsoft CAs boots only keylos-signed loaders. Dual boot is supported by keeping the Microsoft Windows and third-party UEFI CAs in `db` (`secureboot.keepMicrosoftCAs = true`), which makes the integrity profile `shared-boot` (protocols §2.2); other loaders are then started from the firmware boot menu.
- Resizing foreign partitions. The installer uses free space or whole disks.
- Installing without a display or serial console. Unattended mode still needs a console for the recovery-key confirmation unless a fleet escrow is configured (§4.12).
- Hibernation. Kernel lockdown refuses it (protocols §2); the installer never configures it.

---

## 2. Context and embedded contracts

The installer writes on-disk and in-TPM state that other components read at first boot and later. Every shared contract below is copied **verbatim** from `keylos-protocols 1.0`; if a copy differs from protocols, protocols wins.

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

### 2.2 Disk layout (protocols §10.2)

GPT:
1. ESP (1 GiB, FAT32).
2. `keylos-root`: LUKS2 with dm-integrity AEAD (`aegis128` where available, else `aes-gcm-random` + HMAC-SHA256 integrity), holding btrfs subvolumes `@store`, `@var`, `@home`, `@keystore`, `@snapshots`.
3. Optional `keylos-swap`: encrypted with an ephemeral random key at every boot. There is no hibernation (§2).

### 2.3 Host layout (protocols §10.1)

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

### 2.4 UIDs and cgroups (protocols §10.3)

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

### 2.5 Cryptography (protocols §4)

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

### 2.6 Trust roots (protocols §5.2)

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

### 2.7 Presence signatures (protocols §5.3)

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

### 2.7a Quorum presence (protocols §5.4)

Headless profiles (`server`, `server-k8s`, `cloud`, `appliance`) and managed machines use **quorum presence** instead of a local touch. The owner registry (§20.3) then has `policy.mode = "quorum"` and `policy.threshold = N`, with M approver credentials (the owners' FIDO2 credentials, enrolled like any owner credential).

- A **quorum presence envelope** is an ordinary DSSE envelope over the same payload with **≥ N signatures** (§5.3 construction) from credentials of **distinct owners**. Verifiers MUST count distinct owners, not signatures.
- Collection: `hearth` creates a quorum request (`keylos.quorum/1`, §20.18) through `HearthQuorum.request` (§7.5.3); approvers receive it through `fleet` (or out of band as a file), review the rendered payload on their own keylos machine, and sign it there with `hearth presence --remote <request>` (their machine's `hearth` signs with their own credential and rpId `keylos.owner`); signatures return through `HearthQuorum.submit`. The request expires after at most 24 h.
- Every purpose of §20.2 accepts a quorum envelope on quorum machines. On `desktop`/`laptop` profiles quorum envelopes are accepted only for owner-registry changes that the registry policy marks `quorum`.
- **Seal gate on quorum machines.** No touch reaches the machine, so the seal gate's authValue for the window is released differently: `hearth` holds the next gate authValue in a TPM-sealed blob bound to the signed PCR11 `ready` phase and PCR15, and unseals it only after verifying a quorum envelope of purpose `seal.window`. This reduces the guarantee from "a physical touch" to "N approvers signed and the machine runs a verified `hearth`"; the reduction is shown in `status` (`sealing: quorum`).

### 2.8 Owner seal (protocols §11.6)

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

### 2.9 Presence purposes (protocols §20.2)

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

### 2.10 Owner registry (protocols §20.3)

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

### 2.11 Seal window (protocols §20.4)

```json
{"schema":"keylos.seal-window/1","owner":"alice","project":"/home/alice/Projects/tool","drvs":["drv:sha256:…"],
 "opened":"…","expires":"…","machine":"key:sha256:<machine key>","id":"w-…"}
```

`expires − opened ≤ 600 s`. A seal statement is accepted only if its `drv` is in `drvs` and its `sealedAt` lies inside the window.

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

### 2.13 TPM objects (protocols §19.6)

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

### 2.14 Release statement (protocols §20.6)

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

### 2.15 Boot trust set and boot report (protocols §20.1)

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

### 2.16 First-boot bundle (protocols §20.13)

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

### 2.16a Quorum request, trustee shares, recovery key (protocols §20.18, §20.19, §20.21)

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

**Trustee shares** split the 32-byte recovery key secret (§20.21) into *n* shares with threshold *k* (2 ≤ k ≤ n ≤ 16) using Shamir over GF(2^8) per byte. Splitting needs presence (purpose `trustee.split`).

```json
{"schema":"keylos.trustee/1","set":"<base32 8 chars>","machine":"key:sha256:…","k":2,"n":3,"index":1,
 "share":"<base32 of 32 bytes>","check":"<first 8 hex of SHA-256(recovery secret)>","created":"…"}
```

The printed card carries this JSON as a QR (binary mode, error correction Q) and the `share` in 8-character groups. Reconstruction (recovery environment or `hearth`) verifies `check` before use. A new split invalidates nothing cryptographically; owners revoke old shares by rotating the recovery key.

**Inheritance note** (`keylos.inheritance/1`, optional): a note encrypted with HPKE to each listed trustee's public key, held by the owner's paired `vouch` phone. If the dead-man timer (`VouchLink.inheritance`) sees no owner login heartbeat for the configured number of days (≥ 30), the phone releases the encrypted note to the trustees. The note never contains a key; trustees still need *k* shares.

- **Secret:** 32 random bytes generated by the installer.
- **Text form:** 64 lowercase hex digits in 8 groups of 8; each group is followed by a 2-hex-digit CRC-8 (polynomial 0x07, init 0x00) of that group's 4 bytes; groups are separated by `-`: `xxxxxxxxcc-xxxxxxxxcc-…`. The CRC lets the recovery environment point at a mistyped group. Input is case-insensitive and ignores spaces.
- **LUKS2 recovery keyslot:** passphrase = the 64 hex digits without separators and CRCs; LUKS2 applies Argon2id (m = 1 GiB, t = 4, p = 4).
- **Derivations** (HKDF-SHA256 over the 32-byte secret, salt empty, info strings): `"keylos-recovery-auth/1"` (TPM recovery auth object `0x81000105`), `"keylos-lockout/1"` (TPM lockout auth), `"keylos-recovery-signer/1"` (Ed25519 seed of the owner-registry `recoverySigner`), `"keylos-escrow/1"` (optional backup-escrow wrapping key), `"keylos-recovery-recipient/1"` (X25519 private key of the **recovery recipient**; its public half is stored at `/var/lib/keylos/recovery/recipient.pub` and in the first-boot bundle, and running services encrypt recovery copies to it with HPKE (§4): the owner-hierarchy auth and vault `recovery` slots), `"keylos-sb-pk/1"` (seed of the owner Secure Boot **PK**: an RSA-2048 key generated deterministically with HMAC-DRBG-SHA256 seeded by this output, per FIPS 186-5 appendix B.3.3, so the recovery environment can re-create it to sign KEK updates; the PK is never stored).
- `hearth`, `boot`, `installer` and the trustee tooling MUST use exactly this format.

### 2.16b Cross-repository files (protocols §10.7)

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

### 2.16c Operating rules: remote lock and wipe, offline (protocols §14.5)

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.

### 2.16d Pending receipts (protocols §20.22)

The recovery environment (`rescue`, installer repository) cannot reach `ledger`. It writes each receipt it owes as `/var/lib/keylos/recovery/pending/<ULID>.dsse`:

```json
{"schema":"keylos.pendingreceipt/1","event":"key.enroll","onBehalfOf":"rescue","time":"…","bootId":"<recovery boot id>",
 "seq":1,"subject":"shell@alice/s-…","data":{},"label":null,"attested":true}
```

- `event` MUST be recovery-replayable (§19.3).
- Signed with the owner-registry `recoverySigner` (§20.21) when the recovery key was entered in that session (`attested: true`); otherwise (for example a fleet wipe completed with a quorum envelope) unsigned and `attested: false`.
- At the next normal boot `ledger` verifies each file, appends a receipt with `writer = service:ledger`, `data.onBehalfOf`, `data.attested` and `data.pendingSeq`, then deletes the file. Files with an invalid signature are kept, reported by `ledger.alarm`, and never appended.

### 2.16e Fleet commands and org approvers (protocols §20.23)

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

### 2.16f Cloud image records (protocols §20.24)

DSSE-signed by `release-stream/<stream>`, published as TUF targets `cloud/<provider>/<region>/<seq>.json` and logged in the release log next to the release statement:

```json
{"schema":"keylos.cloudimage/1","stream":"stable","seq":4211,"provider":"aws","region":"eu-central-1",
 "imageId":"ami-…","arch":"x86_64","osGen":"gen:fsv256:…","ukiSha256":"…","published":"…"}
```

`fleet` uses these records to check that a cloud node booted a published image before attesting it.

### 2.16g Removable and DMA-capable devices, pre-authorized input devices (protocols §9.5)

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

### 2.17 Code integrity (protocols §9.3)

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

### 2.18 Labels (protocols §14.1)

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

### 2.19 Receipt events (protocols §19.3, rows used by recovery)

| Event | Writer |
|---|---|
| `boot`, `shutdown`, `spawn`, `exit`, `debug.attach`, `debug.detach` | warden |
| `update.stage`, `update.commit`, `update.rollback` | courier |
| `config.plan`, `config.apply`, `config.revert`, `config.activation-rollback` | config |
| `txn.begin`, `txn.commit`, `txn.abort`, `txn.undo`, `snapshot.create`, `snapshot.delete`, `unit.create`, `unit.forget`, `backup.run`, `backup.restore-test`, `anchor.rollback-detected` | strata |
| `user.login`, `user.lock`, `user.create`, `user.delete`, `key.enroll`, `key.remove`, `presence.assert`, `seal.window`, `quorum.request`, `quorum.complete`, `guest.start`, `guest.end` | hearth |
| `recovery.enter`, `recovery.delay`, `recovery.wipe` | recovery environment (`rescue`), spooled (§20.22) and appended by ledger |
| `ledger.key.register`, `ledger.redact`, `ledger.alarm`, `ledger.witness`, `ledger.export`, `ledger.shred` | ledger |

**Recovery-replayable events.** The recovery environment cannot reach `ledger`; it spools receipts (`keylos.pendingreceipt/1`), which `ledger` appends at the next normal boot with `writer = service:ledger` and an extra field `onBehalfOf` naming the original writer. Only these events are recovery-replayable: `key.enroll`, `key.remove`, `presence.assert`, `config.revert`, `config.apply`, `update.rollback`, `user.create`, `recovery.enter`, `recovery.delay`, `recovery.wipe`.

### 2.20 Contracts with other repositories that are not in protocols

These are consumed by exactly one other repository each and are stated here so the installer can be implemented from this file alone. The consuming repository's spec is authoritative for its side.

| Contract | Consumer | Definition |
|---|---|---|
| LUKS2 token `keylos-tpm2` | `boot` (`kl-initrd`), `courier` (re-seal) | Field set of `boot` spec §4.4.1; values the installer writes are in §4.6.3 |
| Unlock policy composition | `boot` | `boot` spec §4.4.2; the installer computes the same digest (§4.6.4) |
| PIN-to-auth derivation | `boot` | `HKDF-SHA256(ikm = PIN (UTF-8, NFKC), salt = pin_salt, info = "keylos-tpm2-pin/1")`, first 32 bytes |
| Recovery-key unlock | `boot` | Keyslot 0, Argon2id `m = 1 GiB, t = 4, p = 4`; key text format protocols §20.21 |
| Seal-gate salt chain | `hearth` | `hearth` spec §4.6; initial state in §4.5.4 |
| Assisted platform credential key derivation and blob layout | `hearth` | `hearth` spec §4.4.5; created per §4.5.2a (the file path is protocols §10.7) |
| HPKE parameters of the owner-hierarchy recovery copy | `hearth` (writer after rotation), `rescue` (reader) | Mode base, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, recipient = the recovery recipient (protocols §20.21), `info = "keylos-recovery-copy/1:hierarchy-owner"`, empty AAD; file = `enc` (32 bytes) ‖ ciphertext (48 bytes) |
| Wipe bundle `/var/lib/keylos/fleet/wipe.dsse` | `fleet` (writer), `rescue` (reader) | JSON Lines of two DSSE envelopes: the `keylos.fleet.command/1` `wipe` command (protocols §20.23), then an owner quorum envelope (protocols §5.4) of purpose `boot.wipe` over `keylos.presence/1` with `details = {"command": <the keylos.fleet.command/1 object>, "commandDigest": "sha256:<digest of its JCS bytes>"}` (protocols §20.2). The path is a protocols §10.7 row; `rescue wipe import` from removable media is a fallback used only when the file is absent |
| Pairing exchange | `vouch` | `vouch-proto` crate; `vouch` spec §4.3 |

Every other file the installer writes for another repository (sealed NV authorization values, hierarchy blobs, quorum seal-gate blobs, platform authenticator blobs, the recovery recipient, the pre-authorized device list, the machine key, the first-boot bundle, the VBU TOTP secret, pending receipts) is a protocols §10.7 row, embedded in §2.16b; the installer writes exactly the format listed there.

---

## 3. Requirements

### 3.1 General

- **REQ-INSTALLER-001** The installer MUST run only from a signed installer UKI booted under Secure Boot, or under the shim fallback. It MUST refuse to install from an unverified image. Its own root is the installer generation, registered in `kl-exec` by `boot` like any OS generation.
- **REQ-INSTALLER-002** Every step MUST be recorded in an install journal (§4.2). The journal MUST let an interrupted install either resume from the last committed step or roll back to "no changes".
- **REQ-INSTALLER-003** Before any destructive action, the installer MUST show a summary: target disks, partitions to be erased, profile, integrity profile, Secure Boot mode (and `keepMicrosoftCAs`), the number of presence touches still to come. It MUST require explicit confirmation.
- **REQ-INSTALLER-004** The installer MUST write a first-boot bundle conforming exactly to `keylos.firstboot/1` (protocols §20.13). It MUST NOT add fields to it. Its SHA-256 MUST be recorded in the first config generation as `firstbootBundleDigest`.
- **REQ-INSTALLER-005** Every TPM object the installer creates MUST use the handle, attributes and authorization policy of protocols §19.6, taken from the `keylos-tpm-registry` crate templates (protocols §18). The installer MUST NOT create keylos TPM objects at any other handle.

### 3.2 Hardware checks and profiles

- **REQ-INSTALLER-010** The installer MUST probe and display: architecture level, UEFI version, Secure Boot state (enabled, SetupMode, AuditMode, DeployedMode), TPM presence and revision, `PolicyAuthorizeNV` support, free NV space in the owner range block, IOMMU state, KVM availability, and kernel feature level (protocols §2.1).
- **REQ-INSTALLER-011** If no usable TPM 2.0 (rev ≥ 1.38) is present, the installer MUST explain, in plain words, which protections are lost, and the machine's integrity profile is `degraded` (protocols §2.2). No profile is offered that needs quorum presence or sealing.
- **REQ-INSTALLER-012** Choosing `secureboot.keepMicrosoftCAs = true` (dual boot) MUST show the `shared-boot` statement (bitpixie-class downgrade risk, mitigated by TPM+PIN, the signed PCR11 policy and the NV floor) and require a second confirmation.
- **REQ-INSTALLER-013** The profile MUST be one of protocols §2.2 (`desktop`, `laptop`, `server`, `server-k8s`, `kiosk`, `appliance`; `cloud` images are provisioned by `keylos-seed`, §4.15). The integrity profile is derived, never chosen, and shown before confirmation.

### 3.3 Storage

- **REQ-INSTALLER-020** The installer MUST create the layout of protocols §10.2 exactly.
- **REQ-INSTALLER-021** `keylos-root` MUST use LUKS2 with dm-integrity AEAD: `aegis128-random` when the CPU has AES instructions; otherwise `aes-gcm-random` with HMAC-SHA256 integrity, as protocols §10.2 allows. The chosen mode MUST be recorded in the bundle (`storage.luks.cipher`) and shown in `status`.
- **REQ-INSTALLER-022** The disk MUST be formatted with a full-device integrity initialisation. "Wipe free space only" is not offered.
- **REQ-INSTALLER-023** btrfs MUST be created with `-O block-group-tree,free-space-tree`, checksum `xxhash` (the AEAD already authenticates; xxhash is for fast scrubs), and **without quotas**.
- **REQ-INSTALLER-024** `@keystore` MUST be a separate top-level subvolume. The installer MUST set the xattr `user.keylos.snapshot=never` on its root. No snapshot of any other subvolume contains it, because btrfs snapshots do not descend into nested subvolumes and `@keystore` is never nested.
- **REQ-INSTALLER-025** `keylos-swap`, when created, MUST be set up for an ephemeral random key at every boot. The installer MUST NOT write any persistent swap key.

### 3.4 Keys and enrolment

- **REQ-INSTALLER-030** On interactive (`touch`) profiles the first owner MUST enrol **two** owner credentials bound to rpId `keylos.owner` (protocols §5.3): by default two roaming FIDO2 authenticators with user verification and the `hmac-secret` extension; alternatively one roaming key plus an **assisted** platform credential (§4.5.2a, protocols §5.3 "Accepted authenticators"), or two assisted credentials when the owner cannot operate a roaming key. With only one credential, the installer requires the owner to type "I understand that losing this key requires the recovery key", records the acknowledgement in the install journal and in `owners.ncl` (`singleKey = true`), and `status` then shows a permanent warning.
- **REQ-INSTALLER-031** The installer MUST generate the 32-byte recovery secret, display the recovery key in the text form of protocols §20.21 and as a QR code, and require the owner to re-type two randomly chosen groups before continuing.
- **REQ-INSTALLER-032** The TPM unlock token MUST be sealed under exactly the policy composition of the `boot` spec §4.4.2, using NV `0x01300102` (os-floor) and NV `0x01300103` (pcrlock-policy), the PIN auth value, and the SRK at `0x81000001` for the salted session. In the `server` and `server-k8s` profiles the PIN step is omitted; in the `appliance` profile it is omitted and the profile records `unlock = 'tpm_only`.
- **REQ-INSTALLER-033** The installer MUST pin the SRK: it records the SRK public area (`TPM2_ReadPublic 0x81000001`, created from the TCG standard template if absent) in the token field `srk_pub`.
- **REQ-INSTALLER-034** For each initial owner *i* the installer MUST create the seal gate NV `0x01300140 + i` and the owner-seal key `0x81000140 + i` per protocols §11.6 and §19.6. On `touch` machines the first owner's gate starts from the seal credential's `hmac-secret` chain (§4.5.4, salts per protocols §19.6) and that credential is marked `credential.seal = true`; the installer MUST run one sealing self-test that leaves the gate rotated to the next value. On `quorum` machines each gate starts from a random authValue sealed to `hearth` (§4.17).
- **REQ-INSTALLER-035** The installer MUST write the genesis owner-registry entry (`op = genesis`, protocols §20.3) with `ownerIndex`, `sealKey`, `recoverySigner` and `policy`, followed on `touch` machines by an `enroll-credential` entry for the second credential, each presence-signed as §4.5.3 specifies, and MUST write the registry head to NV `0x01300105` after the entries are durable on the target disk.
- **REQ-INSTALLER-036** Owner Secure Boot mode: when the firmware is in SetupMode, the installer MUST:
  - generate the owner PK;
  - create the owner KEK signer (`0x81000101`) and owner db signer (`0x81000102`) in the TPM with the §19.6 policy;
  - enrol `db` with the release-stream Secure Boot certificate, the owner db certificate, and the SHA-256 Authenticode hashes of every option ROM measured in the current boot's TCG event log, plus, only when `keepMicrosoftCAs` is chosen, the Microsoft Windows Production PCA and Microsoft UEFI CA certificates (2011 and 2023);
  - enrol `dbx` with the current UEFI revocation list shipped in the installer image;
  - enrol `KEK`, then `PK` last.
- **REQ-INSTALLER-037** If the firmware is not in SetupMode, the installer MUST offer (a) instructions to enter SetupMode for the detected vendor (§4.8.4), then reboot back into the installer, or (b) shim fallback mode (§4.8.5). It MUST NOT silently fall back.
- **REQ-INSTALLER-038** The first config generation MUST be signed by an owner-presence assertion (purpose `config.apply`) during installation, with `counter: 1`. The installer MUST increment NV `0x01300101` to 1 only after the target disk durably holds the signed generation.
- **REQ-INSTALLER-039** The initial value of NV `0x01300102` (os-floor) MUST be exactly the `floor` `F` of the installed release statement, written once into a freshly defined, never-written index (REQ-INSTALLER-06A). When the index already exists and is written, the installer MUST NOT write it (the TPM would refuse anyway); a reinstall over an existing TPM keeps the existing floor, and an installed release below it is refused before any disk change.

### 3.5 Recovery environment

- **REQ-INSTALLER-040** The recovery generation named on the command line of the UKI's `recovery` profile (`keylos.recovery=<gen>`; there is no separate recovery UKI, protocols §20.6) MUST be installed into the target store and rooted (`depot` GC root holder `recovery`). `boot`'s recovery profile starts it as PID 1 after the recovery key unlocks the disk.
- **REQ-INSTALLER-041** The recovery environment MUST NOT be able to unseal the disk token or any PCR11-bound secret: PCR11 holds `enter-recovery` (protocols §19.6 PCR table).
- **REQ-INSTALLER-042** Every recovery operation that changes keys, counters, generations or the owner registry MUST write a pending receipt exactly per protocols §20.22 (`/var/lib/keylos/recovery/pending/<ULID>.dsse`, `onBehalfOf = "rescue"`, signed with the `recoverySigner` and `attested: true` when the recovery key was entered in that recovery session, otherwise unsigned with `attested: false`), using only the recovery-replayable events of protocols §19.3. Entering the recovery environment, starting or cancelling the delayed path, and completing a wipe MUST be recorded as `recovery.enter`, `recovery.delay` and `recovery.wipe`. The main system's `ledger` ingests the files at the next boot.
- **REQ-INSTALLER-043** `rescue` MUST NOT execute any file from the target disk. Target mounts are `noexec,nosuid,nodev`, and `rescue` never registers a target superblock in `kl-exec`.
- **REQ-INSTALLER-044** An organisation wipe MUST be completed by `rescue` only after verifying, from the wipe bundle (§2.20; read from `/var/lib/keylos/fleet/wipe.dsse`, protocols §10.7; a bundle imported from removable media is accepted only when that file is absent): (a) the `keylos.fleet.command/1` envelope against the target's `/etc/keylos/fleet/approvers.json` (≥ `commandQuorum` distinct approvers, `machine` = the machine key, `command = "wipe"`, `issued ≤ time floor < expires`, `expires − issued ≤ 24 h`, protocols §20.23) and (b) the owner quorum envelope of purpose `boot.wipe` against the replayed owner registry (≥ `policy.threshold` distinct owners; `details.command` equal to the command object of (a) and `details.commandDigest` = `sha256:` of its JCS bytes, protocols §5.4, §14.5, §20.2). A command alone never wipes. A consumed command `id` is recorded in the `recovery.wipe` pending receipt and in the recovery log, and a bundle whose `id` is already recorded is refused.
- **REQ-INSTALLER-045** After a configuration activation failure (protocols §15), `rescue` MUST offer "revert to the previous configuration" and "revert to a chosen configuration". It MUST perform both by running `config-recover` (a binary of the `config` repository, shipped in the OS generation, `config` spec §4.7.6) with the decrypted root mounted; `rescue` itself reads no `config`-owned file, builds no config generation and never writes the config counter. `config-recover` produces a **new** generation with `counter = NV(0x01300101) + 1` and collects presence (or a quorum envelope) itself; `rescue` spools the resulting `config.revert` pending receipt from `config-recover`'s exit report.

### 3.6 Migration and reinstall

- **REQ-INSTALLER-050** Imported data from another OS MUST be labelled `private/untrusted` (`security.bpf.keylos.label`, protocols §10.4 and §14.1) and placed under `/home/<user>/Imported/<source-id>/`. Imported dotfiles MUST NOT be applied as configuration.
- **REQ-INSTALLER-051** Reinstall-preserving-home MUST keep `@home` byte-for-byte, MUST re-wrap `@keystore` contents only after recovery-key authentication, and MUST create new `@store`, `@var` and `@snapshots`.

### 3.7 Hierarchies, quorum, cloud and trustees

- **REQ-INSTALLER-060** The installer MUST set the owner and endorsement hierarchy authorizations to random 32-byte values, seal them for `hearth` (`/var/lib/keylos/tpm/hierarchy-owner.sealed`, `hierarchy-endorsement.sealed`, protocols §10.7) as sealed objects with the common template and production policy of protocols §19.6 (`PolicyAuthorize(stream PCR11 key, "ready") ∧ PolicyPCR(15)`, §4.6.6), write the recovery copy of the owner authorization (`/var/lib/keylos/tpm/hierarchy-owner.recovery`: HPKE to the recovery recipient, §2.20), and set the lockout authorization to `HKDF-SHA256(recovery secret, "keylos-lockout/1")` (protocols §19.6, §20.21).
- **REQ-INSTALLER-061** Every keylos NV index the installer defines MUST be defined from the `keylos-tpm-registry` template, including the public `PolicyCommandCode(TPM2_CC_NV_Read)` read branch (protocols §19.6, "Common NV attributes"). The installer does **not** define the two vault-epoch indices `0x01300110`/`0x01300111` (vault-epoch/0 and /1): they are secret (no public read branch) and are defined by `hearth` through `HearthTpm.defineSpace` when `vault` first starts, which also writes their sealed authValue files (protocols §19.6, E1/E28).
- **REQ-INSTALLER-062** On headless profiles (`server`, `server-k8s`, `appliance`) the owner registry MUST start in `quorum` mode with `threshold ≥ 2` (configurable, minimum 2 unless the answers file sets `quorum.threshold = 1` with an explicit acknowledgement), and the genesis entry and first config generation MUST be pre-signed by the listed owners (§4.17).
- **REQ-INSTALLER-063** `keylos-seed` MUST accept only a DSSE-wrapped `keylos.firstboot/1` verified against a fleet key pinned in the image's config (`fleet.seedKeys`), MUST ignore unsigned user-data entirely, and MUST refuse to continue on any verification failure (protocols §20.13 "Cloud seed").
- **REQ-INSTALLER-064** When the owner asks for trustee shares, the installer MUST produce `keylos.trustee/1` cards exactly per protocols §20.19 from the recovery secret it generated, render them only into the recovery kit, and store neither the shares nor the secret.
- **REQ-INSTALLER-065** The installer MUST derive the **recovery recipient** X25519 private key as `HKDF-SHA256(recovery secret, salt = empty, info = "keylos-recovery-recipient/1")` (protocols §20.21), write only its 32-byte raw public key to `/var/lib/keylos/recovery/recipient.pub` and to the bundle's `recovery.recipient`, and zeroize the private key. Every recovery copy the installer writes (the owner-hierarchy authorization) MUST be HPKE-encrypted to it (§2.20). Vault `recovery` slots are created by `vault` from the same public key at first boot (protocols §7.5.4); the installer hands no recovery secret to the running system.
- **REQ-INSTALLER-066** The installer MUST write `/var/lib/keylos/devd/preauthorized.json` (`keylos.preauth/1`, protocols §9.5) listing exactly the USB input devices present during the installation whose interfaces are all HID (keyboards, pointing devices, FIDO authenticators used for enrolment) and the external hubs they are attached through, with vendor and product as 4 lowercase hex digits, the serial (empty when the device has none), the port path and the interface classes. Storage, network and composite devices with a non-HID interface MUST NOT be listed.
- **REQ-INSTALLER-067** Every sealed NV authorization file MUST be named `0x` + 8 lowercase hex digits + `.sealed` and MUST contain exactly `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` (marshalled, each with its size prefix) of a keyedHash sealed data object created under the SRK `0x81000001` with the protocols §19.6 sealed-object template: nameAlg SHA-256, `fixedTPM | fixedParent | adminWithPolicy | noDA`, `userWithAuth` and `sensitiveDataOrigin` clear, empty authValue, sensitive data = the 32-byte NV authValue, and the production authPolicy `PolicyAuthorize(release-stream PCR11 key, signed "ready" policy) ∧ PolicyPCR(sha256:{15})` (protocols §10.7, §19.6). The installer never uses the development fallback policy (`PolicyPCR(15)` alone).
- **REQ-INSTALLER-068** The owner Secure Boot **PK** MUST be the RSA-2048 key generated deterministically from `HKDF-SHA256(recovery secret, "keylos-sb-pk/1")` with HMAC-DRBG-SHA256 per FIPS 186-5 appendix B.3.3 (protocols §20.21). The installer MUST NOT store the PK private key anywhere (disk, recovery kit or TPM); `rescue` re-derives it from the recovery key when it must sign a KEK update or clear the PK.
- **REQ-INSTALLER-069** On the `cloud` profile `keylos-seed` MUST take the presigned owner-registry lines from the bundle's `owners` part and the first config generation from its `config` part (protocols §20.13), MUST verify each owner entry's own presence signatures and the quorum-signed config statement before writing anything, and MUST initialise the os-floor under the stream-signed approval of the UKI's `seed` profile (protocols §19.6).
- **REQ-INSTALLER-06A** The initial os-floor write MUST use the release's approved initialisation policy (`PolicyPCR(11 ready) ∧ PolicyNvWritten(NO) ∧ PolicyCpHash(write F)`, protocols §19.6, §4.6.5); a floor index that is already written is never rewritten by the installer.

---

## 4. Design

### 4.1 Components

| Component | Runs where | Role |
|---|---|---|
| `installer` | Live image, tier-0 service | Orchestrates the install journal; holds block-device, TPM, efivars and mount privileges in the live session only |
| `installer-ui` | Live image, tier-1 app under `atrium` live mode | UI; speaks capwire to `installer` (repo-local facet `ui`) |
| `installer-tui` | Live image, serial or text console | Text UI for `server` and serial installs |
| `rescue` | PID 1 of the recovery generation; also a live-image program | Recovery operations (§4.13) |
| `keylos-enrol` | Recovery environment and main system (owner-run) | TPM and FIDO2 re-enrolment primitives shared with `rescue` |
| `installer-tpm` crate | Linked into all of the above | NV definition, sealing, policy digests, built on `keylos-tpm-registry` |

The live image is the `keylos` installer image: an installer generation booted read-only with `/var` and `/home` on tmpfs. Its own config generation (part of the image, signed by the release stream) contains the route table that grants `installer` the privileges of §6.3. Those privileges exist only in that config generation.

### 4.2 Install journal

The journal is stored:
- in tmpfs at `/run/installer/journal.jsonl`;
- once the target is unlocked, mirrored to `@var/lib/installer/journal.jsonl`.

Entries:

```json
{"step":"luks-format","state":"begin","time":"…","data":{"disk":"/dev/nvme0n1","part":2}}
{"step":"luks-format","state":"commit","time":"…","data":{"uuid":"…"}}
```

Each step is idempotent or reversible:

| Step | Idempotent | Undo on abort |
|---|---|---|
| `partition` | yes (re-checks GPT) | restore backup GPT (saved first to tmpfs) |
| `luks-format` | no | wipe LUKS header and both header copies |
| `btrfs-create` | yes | — |
| `store-copy` | yes (content-addressed) | — |
| `tpm-provision` | yes per object (checks existing handles against §19.6 templates) | undefine/evict objects created in this install (journal lists them) |
| `fido2-enrol` | yes | discard credential records (authenticator credentials remain; harmless) |
| `owner-registry` | yes (genesis written once) | delete `owners.log` and reset NV `0x01300105` |
| `seal-gate` | no (rotates the gate) | undefine `0x01300140`, evict `0x81000140` |
| `config-first` | yes | — |
| `esp-install` | yes | remove keylos entries |
| `bundle-write` | yes | — |
| `secureboot-enrol` | no (firmware) | the owner can reset to setup mode from firmware; the installer shows instructions |
| `finalize` | — | — |

**Abort semantics:**
- Before `luks-format` commits, an abort leaves the machine unchanged except for the GPT, which is restored.
- After it, an abort leaves an unbootable but harmless partition, which the next installer run detects and offers to wipe.
- Secure Boot enrolment is deliberately the **second-to-last** step, so an abort before it never leaves firmware keys pointing at a missing system.

### 4.3 Flow

```
 1 welcome            language, keyboard, accessibility (screen reader, high contrast)
 2 hardware-check     REQ-INSTALLER-010; integrity profile preview
 3 profile            desktop | laptop | kiosk | server | server-k8s | appliance
 4 disk               target selection; summary of erasure
 5 owner              username, display name, login method (password + FIDO2, FIDO2-only, or assisted)
                      headless profiles: owner set from the answers file or remote enrolment (§4.17)
 6 fido2              register credential 1, register credential 2 (roaming or assisted), or single-key acknowledgement
 7 pin                TPM PIN (≥ 6 digits; laptop/desktop default 8), confirm
 8 secureboot         owner mode (setup mode detected) [keep Microsoft CAs for dual boot?] | instructions | shim fallback
 9 network            optional: Wi-Fi/Ethernet for "install latest" and vouch pairing
10 vouch              optional pairing (§4.10)
11 recovery-key       display + QR + confirm groups; optional trustee cards (§4.16)
12 summary            REQ-INSTALLER-003 confirmation
13 execute            partition → luks-format → btrfs-create → store-copy → tpm-provision
                      → fido2 records → owner-registry (touches) → seal-gate → config-first (touch)
                      → esp-install → bundle-write → secureboot-enrol → finalize
14 done               remove media; reboot (test boot, §4.8.3 step 7)
```

**Presence touches** (the UI announces the count before step 13):

| # | Credential | Purpose | Combined with |
|---|---|---|---|
| 1 | credential 1 | `makeCredential` | — |
| 2 | credential 2 | `makeCredential` | — |
| 3 | credential 1 (seal credential) | genesis registry entry (presence, purpose `owners.entry`) | `hmac-secret` salts `s_0`, `s_1` for the seal gate (§4.5.4) |
| 4 | credential 1 | `enroll-credential` entry for credential 2 (purpose `owners.entry`) | — |
| 5 | credential 2 | first config generation (purpose `config.apply`); proves credential 2 works | — |

An assisted credential's "touch" is the confirmation action and PIN in the installer's own trusted prompt (§4.5.2a).

### 4.4 Disk preparation

**Partitioning.** GPT with:
- ESP: 1 GiB, type `C12A7328-F81F-11D2-BA4B-00A0C93EC93B`, label `KEYLOS-ESP`.
- `keylos-root`: the rest minus swap, type `4F68BCE3-E8CD-4DB1-96E7-FBCAF984B709` (Discoverable Partitions "root x86-64"; `B921B045-1DF0-41C3-AF44-4C6F280D3FAE` on aarch64), label `keylos-root`.
- Optional `keylos-swap`: size = min(RAM, 16 GiB) on laptops, 0 by default on desktops and servers, type `0657FD6D-A4AB-43C4-84E5-0933C84B4F4F`. It is never used for hibernation.

**LUKS2 format** via `libcryptsetup`:
- `--type luks2 --integrity <REQ-INSTALLER-021 mode>`
- `--sector-size 4096` when the device reports a 4096-byte logical sector, otherwise 512
- `--label keylos-root`
- Keyslot 0 is the recovery keyslot (Argon2id `m = 1 GiB, t = 4, p = 4`), with the recovery key text as passphrase.
- Keyslot 1 is the TPM keyslot: a random 64-byte passphrase, sealed in the `keylos-tpm2` token (§4.6.3), Argon2id `m = 64 MiB, t = 3, p = 1` (the passphrase is high-entropy; the KDF cost only needs to stay bounded).
- No other keyslots exist on machines with a TPM (`boot` tries no others). Without a TPM (integrity profile `degraded`) the installer adds keyslot 2: a user passphrase, Argon2id `m = 1 GiB, t = 4, p = 4`.

**btrfs creation** (REQ-INSTALLER-023), subvolumes:
- `@store`
- `@var`
- `@home`, with `@home/<owner>` created through the same layout `strata` uses for homes (`StrataHomes.createHome` semantics: one subvolume per user; `.apps` is a plain directory whose per-app subvolumes are created on first launch)
- `@keystore`
- `@snapshots`

Mount options used by the installer and recorded for `boot`:

| Mount | Options |
|---|---|
| `/var`, `/home` | `noatime,nosuid,nodev,noexec,compress=zstd:1` |
| `/store` | `noatime,nosuid,nodev,compress=zstd:1` |
| `/keystore` | `noatime,nosuid,nodev,noexec` |

`/store` is not `noexec`, because composefs mounts read their backing objects from it. Executability is governed by `kl-exec` (protocols §9.3): only superblocks of verified composefs mounts are in `kl_exec_allowed_sb`, and the `/store` btrfs superblock never is, so no file is executable through `/store` directly.

### 4.5 Owner identity and FIDO2

#### 4.5.1 Owner account

- **UID:** the first owner gets UID 1000 (protocols §10.3 human range).
- **Login methods:**
  - **FIDO2-only:** touch + FIDO2 PIN/biometric at the greeter.
  - **Password + FIDO2:** password at the greeter; FIDO2 required only for presence-class actions.
  - **Assisted:** password or PIN at the greeter; presence through the assisted platform credential (§4.5.2a).

  Default: password + FIDO2 on `desktop`/`laptop`/`kiosk`; FIDO2-only and assisted offered. Headless profiles have no local login at install (§4.17).
- **Password hashing:** Argon2id with the protocols §4 parameters (`m = 256 MiB, t = 3, p = 4`), placed in the bundle (`owner.passwordHash`) for `hearth`, which hands it to `vault` slot creation and then discards it.

#### 4.5.2 FIDO2 registration

For each authenticator, through `libfido2`:

1. `makeCredential`:
   - rpId `keylos.owner` (protocols §5.3), rp name "keylos";
   - user handle = SHA-256(owner username ‖ machine key ref);
   - algorithms ES256 (preferred) or EdDSA;
   - extensions `hmac-secret: true`, `credProtect: userVerificationRequired`;
   - user verification required;
   - resident key not required (non-discoverable credentials keep authenticator slots free).
2. Refuse authenticators that do not return `hmac-secret` support or that cannot perform UV.
3. Record: credential ID, COSE public key, SPKI and `keyRef` (`key:sha256:` of the SPKI, protocols §4), AAGUID, algorithm, the owner-chosen label ("blue key", "backup key"). The attestation statement is shown for information only and not trusted.

#### 4.5.2a Assisted platform credential

When the owner chooses assisted presence, the installer creates the credential exactly as `hearth` does (`hearth` spec §4.4.5, protocols §5.3): an ECC P-256 signing key under the SRK with `userWithAuth` **clear**, authValue = `HKDF-SHA256(PIN (UTF-8, NFKC), salt = 16 random bytes, info = "keylos-platform-authn/1")`, authPolicy `PolicyPCR(sha256:{15} = expected) ∧ PolicyAuthValue` (PCR15 alone never suffices; the PIN-derived authValue is always required), plus the platform seal key (TPM keyed-hash HMAC object with the same authValue and policy) when it is the seal credential. The blob `@var/lib/keylos/hearth/platform/<keyid>.blob` (protocols §10.7: writer installer and `hearth`, reader `hearth`) is the JCS object `{"rpId", "credentialId", "cose", "salt", "key", "hmacKey"}` with standard base64 members, where `key` and `hmacKey` are `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` (`hmacKey` empty when the credential is not the seal credential) (protocols §5.3, §10.7). The credential is recorded with `assisted: true`. The installer's prompt for user presence is a confirmation action (pointer, keyboard or switch access) in its full-screen trusted UI, and user verification is the PIN.

#### 4.5.3 Genesis registry entry

After registration, the installer builds the genesis entry (protocols §20.3):

```json
{"schema":"keylos.owners-entry/1","seq":0,"prev":"sha256:0000000000000000000000000000000000000000000000000000000000000000","time":"…",
 "op":"genesis","owner":"ada","ownerIndex":0,
 "credential":{"keyid":"key:sha256:…","cose":"<base64>","credentialId":"<base64>","label":"blue key","aaguid":"…",
               "assisted":false,"seal":true},
 "sealKey":"<base64 SPKI DER of owner-seal/0>",
 "recoverySigner":{"keyid":"key:sha256:<SPKI digest>","spki":"<base64 DER>"},
 "secureBootCert":"<base64 DER of the owner db certificate, or null in shim mode>",
 "policy":{"mode":"touch","quorum":1,"threshold":1}}
```

followed by the second credential's entry:

```json
{"schema":"keylos.owners-entry/1","seq":1,"prev":"sha256:<digest of the genesis envelope line bytes>","time":"…",
 "op":"enroll-credential","owner":"ada",
 "credential":{"keyid":"key:sha256:…","cose":"<base64>","credentialId":"<base64>","label":"backup key","aaguid":"…",
               "assisted":false,"seal":false}}
```

- The genesis payload is presence-signed (protocols §5.3) by credential 1 (touch 3), purpose `owners.entry`, with UV. The `enroll-credential` payload is presence-signed by credential 1 (touch 4).
- `recoverySigner` is the Ed25519 key derived with `info = "keylos-recovery-signer/1"` (protocols §20.21), written in the object form the `hearth` spec defines.
- Both DSSE envelopes are written as the first two lines of `@var/lib/keylos/hearth/owners.log`.
- NV `0x01300105` is then written with the 104-byte head of protocols §19.6: SHA-256(last line bytes) ‖ u64 BE `1` ‖ SHA-256(JCS of the owner-presence key set) ‖ SHA-256(JCS of the owner Secure Boot certificate set), with the key-set encoding of the `hearth` spec §4.5.2.

#### 4.5.4 Seal gate and owner-seal key (owner 0)

The construction is the one `hearth` operates (protocols §11.6; `hearth` spec §4.6). The installer creates the initial state:

1. **Salts.** `s_k = SHA-256("keylos-seal" ‖ u64_be(k))`, k encoded as 8 bytes big-endian (protocols §19.6). For an assisted seal credential, `o_k = HMAC-SHA256(platform seal key, s_k)` computed in the TPM (`hearth` spec §4.4.5).
2. **Touch 3** (credential 1) is a single `getAssertion` that carries the genesis presence signature and the `hmac-secret` extension with `salt1 = s_0`, `salt2 = s_1`. It yields `o_0` and `o_1` (32 bytes each).
3. **Seal gate.** `TPM2_NV_DefineSpace` of `0x01300140` with the §19.6 attributes (`POLICYWRITE`, `AUTHREAD`, NO_DA clear, 1 byte), `authPolicy = PolicyCommandCode(NV_ChangeAuth) ∧ PolicyAuthValue`, and `auth = o_0`. The index is never written; it exists only for its authValue, which `PolicySecret` and `NV_ChangeAuth` use.
4. **Owner-seal key.** An ordinary (non-primary) key under the SRK: ECC P-256 signing, `fixedTPM | fixedParent | sensitiveDataOrigin | sign`, `userWithAuth` clear, `adminWithPolicy` set, `authPolicy = PolicySecret(0x01300140)`. Persisted with `TPM2_EvictControl` at `0x81000140`.
5. **Self-test** (a sealing window that seals nothing): policy session → `PolicySecret(0x01300140)` with auth `o_0` → `TPM2_Sign` over SHA-256("keylos-seal-selftest/1" ‖ machine key ref) → verify with the public key.
6. **Rotate.** `TPM2_NV_ChangeAuth(0x01300140, o_1)` in a policy session `PolicyCommandCode(NV_ChangeAuth) ∧ PolicyAuthValue` with auth `o_0`. Zeroize `o_0` and `o_1`.
7. **Record** the state for `hearth` in the bundle: `owner.sealGate = {"index": "0x01300140", "saltCounter": 1}`. The credential that set the gate is the one marked `credential.seal = true` in the genesis entry (credential 1).
8. The owner-seal SPKI is written into the first config generation as `/etc/keylos/owner-seal/0.spki`, which makes it part of the boot trust set from the first boot (protocols §20.1).

After step 6 a captured `o_0` is useless. The next window needs a touch of credential 1 (salt `s_1`, `s_2`); `hearth` handles credential changes per its spec.

#### 4.5.5 Owner-presence public keys

The owner-presence key set is the set of credentials in the owner registry. The first config generation does not list them: `boot` takes them from the registry anchored in NV `0x01300105` (protocols §20.1, `ownerPresence`).

### 4.6 TPM provisioning and disk unlock

#### 4.6.1 Steps

1. `TPM2_GetCapability`: revision, algorithms, NV space, PCR banks. Require an active SHA-256 PCR bank and rev ≥ 1.38.
2. Ensure the SRK exists at `0x81000001` (ECC P-256, TCG standard template). Record its public area (REQ-INSTALLER-033).
3. Hierarchy authorizations (REQ-INSTALLER-060):
   - If the owner, endorsement or lockout authorization is set and unknown, the TPM must be cleared from firmware; the installer explains this and shows vendor instructions.
   - `TPM2_HierarchyChangeAuth(TPM_RH_OWNER, ownerAuth)` and `(TPM_RH_ENDORSEMENT, endorsementAuth)` with 32 random bytes each; `TPM2_HierarchyChangeAuth(TPM_RH_LOCKOUT, HKDF-SHA256(recovery secret, "keylos-lockout/1"))`.
   - After the volume identity is known (§4.6.2), seal `ownerAuth` and `endorsementAuth` for `hearth` into `/var/lib/keylos/tpm/hierarchy-owner.sealed` and `hierarchy-endorsement.sealed` (protocols §10.7; same object format and seal policy as §4.6.6).
   - Write the recovery copy `/var/lib/keylos/tpm/hierarchy-owner.recovery`: `ownerAuth` HPKE-encrypted to the recovery recipient (REQ-INSTALLER-065) with the parameters of §2.20. `hearth` re-encrypts the copy to the same public key (`/var/lib/keylos/recovery/recipient.pub`) after every rotation (`hearth` spec §4.7.1).
   - The installer keeps the hierarchy authorizations in `memfd_secret` memory until provisioning ends, then zeroizes them.
4. Recovery auth object `0x81000105`: a keyed-hash object with no sensitive payload, `userWithAuth` set, `authValue = HKDF-SHA256(recovery key, "keylos-recovery-auth/1")` (protocols §19.6; §4.7), persisted.
5. Define every NV index of §19.6 from the `keylos-tpm-registry` templates (common attributes `OWNERREAD | AUTHREAD | POLICYREAD` and the public `PolicyCommandCode(TPM2_CC_NV_Read)` read branch ORed with the write policy, REQ-INSTALLER-061), in this order: `0x01300100` ledger-counter, `0x01300101` config-counter, `0x01300102` os-floor (`POLICYWRITE`, `AUTHREAD` with an empty authValue, protocols §19.6), `0x01300103` pcrlock-policy, `0x01300104` keystore-floor, `0x01300105` owner-registry-head, `0x01300106` login-failure-counter, `0x01300107` strata-anchor-counter, `0x01300108` attestation-key-names. The vault-epoch indices `0x01300110`/`0x01300111` are not defined here (REQ-INSTALLER-061). Each AUTHWRITE index gets a fresh random 32-byte authValue (§4.6.6). Counters are incremented once so that they are written (`TPMA_NV_WRITTEN`).
6. Initial values:
   - `0x01300102` os-floor: the release statement's `floor`, written as u64 big-endian (REQ-INSTALLER-039, §4.6.5).
   - `0x01300103` pcrlock-policy: the digest computed in §4.6.4, written through the `PolicySecret(0x81000105)` branch of its write policy with the recovery auth value.
   - `0x01300105`: after the genesis entry (§4.5.3).
   - `0x01300108`: Name(AK) ‖ Name(AK0) after step 8.
   - `0x01300110`/`0x01300111`: not defined by the installer; `vault` obtains them through `HearthTpm.defineSpace` at its first start.
7. Seal the TPM keyslot passphrase under the unlock policy (§4.6.4) into the `keylos-tpm2` token (§4.6.3).
8. Attestation keys, both restricted ECC P-256 signing keys under the endorsement hierarchy (endorsement authorization from step 3), with exactly the protocols §19.6 attributes: `fixedTPM`, `fixedParent`, `sensitiveDataOrigin`, `userWithAuth`, `restricted`, `sign` set; `adminWithPolicy` clear; empty authValue; empty authPolicy:
   - AK at `0x81010002` (runtime attestation: `vouch`, `fleet`, cluster join);
   - AK0 at `0x81010003` (pre-unlock VBU quotes, protocols §20.5).
   Quotes carry the PCR values, so no PCR binding of the key is needed; verifiers check PCR 15 in the quote. `TPM2_ActivateCredential` (ADMIN role), which `vouch` and `fleet` use to prove the keys share a TPM with the EK, is authorised by the empty authValue.
   The expected PCR15 value is computed from the LUKS volume key exactly as `kl-initrd` extends it (`boot` spec §4.5).
9. First-boot vault seed key `0x81000103`: an ECC P-256 decryption key (`decrypt`, ECDH) used with HPKE DHKEM(P-256, HKDF-SHA256) (protocols §4, §19.6), with policy `PolicyAuthorize(stream PCR key, "keylos/unlock/1")` approved part ∧ `PolicyPCR(15)`, persisted. `vault` imports the bundle's vault items at first boot and then has it evicted through `HearthTpm.evict(0x81000103)`.
10. Owner seal gates and owner-seal keys (§4.5.4 on `touch` machines; §4.17 on `quorum` machines).
11. Owner Secure Boot signers `0x81000101`/`0x81000102` (§4.8.2), when owner mode is chosen.
12. Recovery auth object `0x81000105` (step 4) and the lockout authorization (step 3) are the only TPM authorizations derivable from the recovery key; the owner hierarchy is reachable from recovery only through the recovery copy of step 3.

#### 4.6.2 Volume identity

The installer computes the values `kl-initrd` checks and measures after unlock (`boot` spec §4.5), so that every PCR15-bound policy can be created before first boot:

```
id_key   = HKDF-SHA256(ikm = volume key, salt = LUKS2 UUID bytes, info = "keylos-volume-identity/1")
identity = SHA-256("keylos-volume/1" ‖ LUKS2 UUID (16 bytes) ‖ id_key)          → token.volume_identity
machine  = 16 random bytes, written to @var/lib/machine-id
PCR15    = extend(extend(0³², SHA-256("keylos-volume/1" ‖ identity)), SHA-256("keylos-machine/1" ‖ machine))
```

where `extend(p, d) = SHA-256(p ‖ d)`. That PCR15 value is used in the AK policy (§4.6.1 step 8), the vault seed key policy (step 9), the sealed NV authorization values (§4.6.6) and the machine key (§4.6.7).

#### 4.6.3 LUKS2 token `keylos-tpm2`

Field set defined by the `boot` spec §4.4.1. The installer writes:

```json
{"type":"keylos-tpm2","keyslots":["1"],"version":1,
 "srk_pub":"<base64 TPM2B_PUBLIC>","srk_handle":2164260865,
 "blob":"<base64 TPM2B_PRIVATE||TPM2B_PUBLIC>",
 "policy":"<hex final policy digest>",
 "stream_key":"<hex sha256 of .pcrpkey SPKI>","stream_ref":"keylos/unlock/1",
 "pcrlock_nv":"0x01300103","floor_nv":"0x01300102",
 "pin":true,"pin_salt":"<base64 16 bytes>",
 "volume_identity":"<hex>","enrolled":"<RFC 3339>",
 "pcrlock_branches":null}
```

- The sealed data is the keyslot-1 passphrase (64 random bytes).
- `pin_salt` is 16 random bytes; the PIN auth value is derived as in §2.20.
- `server`, `server-k8s` and `appliance` profiles: `"pin": false`, and step 6 of the policy (PolicyAuthValue) is omitted.

#### 4.6.4 Policy digests

The installer computes, with the same algorithm as the `boot` spec §4.4.2–§4.4.3:
- `D_start = PolicyAuthorize(name(stream PCR key), "keylos/unlock/1")`;
- `D_pcr = PolicyPCR(D_start, sha256:{0,2,4,7}, predicted values)`, where the predictions come from the release statement's `pcrlock` component bundle plus the current event log. PCRs whose event logs contain records the predictor does not recognise are dropped from the selection, and the report lists which PCRs are covered (`tpm.pcrlockCoveredPcrs` in the bundle). In shim mode PCR 14 is added.
- NV `0x01300103` ← `D_pcr`.
- The sealed object's `authPolicy` = the full composition (PolicyAuthorize part, PolicyAuthorizeNV, PolicyAuthValue, PolicyCommandCode(Unseal)).

The installer does **not** need to satisfy the policy at install time; it only computes it. The first unseal happens at first boot.

#### 4.6.5 Initial floor write

NV `0x01300102` is written only through `PolicyAuthorize(release-stream key, "keylos/floor-write/1")` (protocols §19.6). The installer satisfies it with the **installer floor authorization** shipped in the installer UKI's `.pcrsig` (`keylos` spec): the stream-signed approved policy

```
PolicyPCR(sha256:{11} = installer-UKI PCR11 at phase "ready")
∧ PolicyNvWritten(writtenSet = NO)                                  the index has never been written
∧ PolicyCpHash(TPM2_NV_Write(0x01300102, 0x01300102, u64_be(F), offset 0))
```

with `F` = the installed release statement's `floor`. Only the genuine installer UKI of that release, once its live session has reached `ready`, can therefore write the floor, only the value `F`, and only into an index that has never been written, so the installer cannot lower an initialised floor. The installer:
1. defines the index (step 5) if it is absent; if it exists and is written, skips the write (REQ-INSTALLER-039);
2. starts a policy session, satisfies the approved policy, and writes `u64_be(F)` at offset 0;
3. reads back and checks the value; a lost acknowledgment is handled by reading back (a written index with value `F` is success).

#### 4.6.6 Sealed NV authorization values

Each AUTHWRITE index of §19.6 has a random authValue known to its owning service only. The installer seals each value for its owner:

| NV | Owner | File |
|---|---|---|
| `0x01300100` ledger-counter | `ledger` | `/var/lib/keylos/tpm/nv-auth/0x01300100.sealed` |
| `0x01300101` config-counter | `config` | `/var/lib/keylos/tpm/nv-auth/0x01300101.sealed` |
| `0x01300104` keystore-floor | `vault` | `/var/lib/keylos/tpm/nv-auth/0x01300104.sealed` |
| `0x01300105` owner-registry-head | `hearth` | `/var/lib/keylos/tpm/nv-auth/0x01300105.sealed` |
| `0x01300106` login-failure-counter | `hearth` | `/var/lib/keylos/tpm/nv-auth/0x01300106.sealed` |
| `0x01300107` strata-anchor-counter | `strata` | `/var/lib/keylos/tpm/nv-auth/0x01300107.sealed` |

File names use the index as `0x` + 8 lowercase hex digits (protocols §10.7). Later re-provisioning of an index, and the first definition of the vault-epoch indices `0x01300110`/`0x01300111`, is done by `hearth` through `HearthTpm.defineSpace` (`hearth` spec §4.7.2), which writes the same file format; after genesis no service defines an NV index itself (protocols §19.6).

- Each file is a keyed-hash sealed object under the SRK, stored as the raw bytes `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` with no wrapper (protocols §10.7, REQ-INSTALLER-067). The hierarchy blobs of §4.6.1 step 3 use the same format.
- Object template (protocols §19.6, REQ-INSTALLER-067): keyedHash sealed data object, nameAlg SHA-256, `fixedTPM | fixedParent | adminWithPolicy | noDA`, `userWithAuth` and `sensitiveDataOrigin` clear, empty authValue.
- Seal policy (production, the only one the installer uses): `PolicyAuthorize(stream PCR key, …)` satisfied by the stream-signed PCR11 prediction for phase `ready` (approved policy `PolicyPCR(sha256:{11})` at `ready`, the `.pcrsig` entry the `boot` spec defines for that phase), followed by `PolicyPCR(sha256:{15} = expected)`. This is the binding protocols §19.6 requires ("sealed secret bound to the signed PCR11 `ready` phase and PCR15"); readers recognise the production variant by its authPolicy digest.
- Files are mode 0400, owned by the service's static file owner as set by `warden` at first start (the installer writes them owned by UID 0, and `warden` fixes ownership when it allocates the service's state directory).
- The installer zeroizes every authValue after sealing, except the config-counter value, which it keeps until REQ-INSTALLER-038 completes.

#### 4.6.7 Machine key

The machine identity key (protocols §3.5) is `ledger`'s signing key. The installer generates it, because the bundle, the seal self-test, the first config generation and the vouch pairing all name it before first boot:
- Ed25519 key pair generated in the installer process.
- The private key is sealed under the same policy as §4.6.6 and written to `/keystore/ledger/signing.sealed` in the format the `ledger` spec defines. `ledger` finds an existing key at first boot and does not generate a new one.
- `machine.machineKey` in the bundle = `key:sha256:` of its SPKI.

### 4.7 Recovery key

- **Recovery key:** the 32-byte secret of protocols §20.21, from the OS CSPRNG.
- **Text form:** exactly protocols §20.21 (64 lowercase hex digits in 8 groups of 8, each group followed by a 2-hex-digit CRC-8, polynomial 0x07, init 0x00, of its 4 bytes; groups separated by `-`). It is keyboard-layout independent and detects typos per group.
- **QR:** `KEYLOS-RECOVERY:` followed by the text form.
- **Derived values** (HKDF-SHA256, IKM = the 32-byte recovery key, empty salt):

| `info` | Use | Defined by |
|---|---|---|
| (none: the 64 hex digits without separators and CRCs) | LUKS keyslot 0 passphrase | protocols §20.21 |
| `keylos-recovery-auth/1` | authValue of the recovery auth object `0x81000105` | protocols §20.21 |
| `keylos-lockout/1` | TPM lockout authorization | protocols §20.21 |
| `keylos-recovery-signer/1` | Ed25519 seed of the owner-registry `recoverySigner` | protocols §20.21 |
| `keylos-escrow/1` | Optional backup-escrow wrapping key | protocols §20.21 |
| `keylos-recovery-recipient/1` | X25519 private key of the recovery recipient; only its public key is stored (REQ-INSTALLER-065) | protocols §20.21 |
| `keylos-sb-pk/1` | Seed of the owner Secure Boot PK (RSA-2048, HMAC-DRBG-SHA256 per FIPS 186-5 B.3.3); the PK is never stored (REQ-INSTALLER-068) | protocols §20.21 |

Vault `recovery` slots need no secret from the installer: `vault` wraps each user key with HPKE to the recovery recipient public key when it creates the user (protocols §7.5.4); `rescue` derives the recipient private key from the recovery key to open them.

- **Confirmation:** the installer asks for two random groups (REQ-INSTALLER-031).
- **Recovery kit.** The installer offers a PDF (rendered locally) written only to a removable medium the owner picks through the powerbox, never to the target disk. It contains: the key and its QR; the machine name and machine key fingerprint; the install date; the enrolled credential labels; the vouch pairing fingerprint; the owner Secure Boot PK certificate fingerprint (the PK itself is re-derived from the recovery key, REQ-INSTALLER-068); and, when requested, one page per trustee share card (§4.16).

### 4.8 Secure Boot enrolment

#### 4.8.1 Modes

| Mode | When | Trust anchor in firmware | Integrity profile (protocols §2.2) |
|---|---|---|---|
| Owner | Firmware in SetupMode | Owner PK/KEK; `db` = release-stream cert + owner db cert + option ROM hashes | `full` |
| Owner, keep Microsoft CAs (`keepMicrosoftCAs = true`) | Dual boot, or option ROMs that are only Microsoft-signed with no Authenticode hash in the event log | As above + Microsoft Windows Production PCA and Microsoft UEFI CA (2011, 2023) in `db` | `shared-boot` (REQ-INSTALLER-012) |
| Shim fallback | Firmware cannot enter SetupMode, or the owner declines | Vendor/Microsoft keys; keylos shim (signed by Microsoft UEFI CA 2023) + MOK = release-stream cert | `shim`; vouch shows it; PCR 14 is in the pcrlock selection |

#### 4.8.2 Owner keys

| Key | Algorithm | Private part | Use |
|---|---|---|---|
| Owner PK | RSA-2048 (firmware compatibility) | Not stored: derived deterministically from the recovery key (`keylos-sb-pk/1`, REQ-INSTALLER-068); the installer derives it, enrols its certificate and zeroizes it | Changing KEK or clearing PK from the recovery environment; rarely used |
| Owner KEK signer | RSA-2048 | TPM `0x81000101`, policy per §19.6 (`PolicySecret` of the owners' seal gates; with one owner the policy is `PolicySecret(0x01300140)` alone, because `PolicyOR` needs at least two branches) | Signing authenticated variable updates to `db`/`dbx` (`courier`, during updates that rotate release-stream certs or apply `dbx`), inside a sealing window |
| Owner db signer | RSA-2048 | TPM `0x81000102`, same policy | Signing owner-built EFI binaries (rare) |

RSA-2048 is used because many firmware implementations accept only RSA-2048 for PK, KEK and db certificates. Adding an owner later changes the policy set; `hearth`'s add-owner flow recreates both signers and re-enrols their certificates through a KEK-signed update (see `hearth` and `courier` specs).

#### 4.8.3 Enrolment sequence (owner mode)

1. Verify `SetupMode = 1` and that `PK` is empty.
2. Read the TCG event log. Collect the PCR 2 `EV_EFI_BOOT_SERVICES_DRIVER` and `EV_EFI_PLATFORM_FIRMWARE_BLOB*` digests for option ROMs.
   - For each option ROM measured with an Authenticode hash, add an `EFI_CERT_SHA256` entry to `db`.
   - If an option ROM appears only as a raw blob digest, the installer warns, names the device by PCI ID, and offers `keepMicrosoftCAs` (integrity profile `shared-boot`) or to continue without it (the device's option ROM then will not run).
3. Build the `db` update: release-stream Secure Boot certificate, owner db certificate, option ROM hashes (+ the Microsoft CAs when `keepMicrosoftCAs`).
4. Build the `dbx` update from the installer image's bundled revocation list (UEFI forum dbx + SBAT revocations).
5. Write `db`, `dbx` and `KEK` as setup-mode writes.
6. Write `PK` last. The firmware leaves SetupMode and enters UserMode.
7. Read the variables back. Set `BootNext` to the installed UKI and reboot (**test boot**). The first-boot path writes a `boot-ok` marker; only then does the installer media, if booted again, report success.

If firmware rejects any write, the installer stops before `PK`, explains, and offers shim fallback.

#### 4.8.4 Vendor setup-mode instructions

A data file `secureboot-vendors.json` in the installer image maps `DMI sys_vendor` / `product_family` to steps for entering setup mode ("Reset to Setup Mode", "Delete all Secure Boot keys"), with screenshots where available. Unknown vendors get generic guidance.

#### 4.8.5 Shim fallback

- ESP: `\EFI\BOOT\BOOTX64.EFI` = keylos shim (Microsoft UEFI CA 2023-signed, SBAT-compliant), `\EFI\keylos\mmx64.efi` (MokManager), systemd-boot signed with the release-stream key.
- A MOK enrolment request for the release-stream certificate, protected by a one-time password the installer displays.
- On the next boot the owner confirms in MokManager. The installer explains the MokManager screen beforehand.
- The owner KEK/db signers are not created in shim mode.

### 4.9 Store population and first config

#### 4.9.1 Store copy

- `depot import-closure --from /run/installer/media/store --to /mnt/target/store --roots <os-gen>,<recovery-gen>,<default-app-gens…>` copies objects, generation images and their evidence (generation statements, realisation attestations, tlog proofs) into `/store/evidence/`. It enables fs-verity on each object; there are no per-file signatures (protocols §4).
- Verification: every object's measured fs-verity digest must equal its name; every generation image's digest must equal its ref; every generation statement must verify against the release-stream key of the installer's stream (protocols §20.7).
- **Install latest:** when network is available and the owner chose it, the installer resolves the stream head with the `courier` TUF client library (`courier-tuf` crate, the same code `courier` runs) and verifies it exactly as an update: TUF, release-log inclusion with witness cosignatures (protocols §11.5), rebuilder quorum. The release statement used for the floor and PCR predictions, and the UKI (whose recovery profile names the recovery generation), are the ones fetched.

#### 4.9.2 First config generation

1. Generate the Nickel source tree in `/mnt/target/var/lib/config/repo/` (a git repository with one commit authored "installer"):
   - `profile.ncl`: the selected profile from the `keylos` profiles;
   - `owners.ncl`: owner username, `singleKey`, owner Secure Boot mode, `secureboot.keepMicrosoftCAs`, `firstbootBundleDigest`;
   - `owner-seal/<ownerIndex>.spki`: each initial owner's owner-seal public key (rendered to `/etc/keylos/owner-seal/<ownerIndex>.spki`, protocols §10.7);
   - `publishers.ncl`: empty (rendered to `/etc/keylos/publishers.json`);
   - `locale.ncl`: locale, keyboard, timezone;
   - `network.ncl`: known networks, with credentials referenced as vault items (written to the bundle, never into the repo);
   - `apps.ncl`: the default apps;
   - `vouch.ncl`: the paired phone's public keys and witness settings;
   - `fleet.ncl`: if enrolled;
   - `policy/`: empty owner overrides.
2. Run `config bootstrap --source <repo> --out <dir> --counter 1 --parent none` using the `config` binary of the **target** OS generation. The live session's `warden` mounts that generation through `depot` and registers it in `kl-exec` only after verifying its generation statement against the release-stream key (protocols §9.3). This compiles the confext generation and outputs the unsigned `keylos.configgen/1` payload.
3. Touch 5: presence signature (purpose `config.apply`, UV) through the installer's FIDO2 client, producing the DSSE envelope of protocols §5.3. On `quorum` machines the statement is pre-signed by the owners (§4.17).
4. Import the config generation and its statement into the target store (`depot import-closure`) and record it as the current config generation.
5. Increment `0x01300101` to 1 with its authValue, then seal and zeroize that value (REQ-INSTALLER-038, §4.6.6).

### 4.10 vouch pairing

Pairing uses `vouch-proto` (`vouch` spec §4.2). The installer acts as the machine role:
1. Displays the pairing QR.
2. Waits for the phone on the local network (direct connection to the address in the QR) or, without a network, accepts the phone's 12-word commitment code typed by the owner.
3. Performs the EK → AK0/AK credential activation exchange with the TPM objects created in §4.6.1 step 8.
4. Stores the phone's witness and approval public keys in `vouch.ncl` and the bundle's `vouch` part.

Pairing can be skipped and done later from Settings.

### 4.11 First-boot bundle

The installer writes `/mnt/target/var/lib/keylos/firstboot/bundle.json` (mode 0600) exactly as protocols §20.13 defines it (§2.16). Field sources:

| Field | Source |
|---|---|
| `machine.name` | Owner-chosen hostname |
| `machine.machineKey` | §4.6.7 |
| `machine.srkPublic` | §4.6.1 step 2 |
| `machine.ekCertChain` | EK certificate from NV `0x01C00002`/`0x01C0000A` plus the vendor chain if the TPM provides it |
| `profile`, `integrity` | Profile step |
| `storage` | §4.4 |
| `secureBoot` | §4.8: `mode` (`owner` \| `shim`), `keepMicrosoftCAs`, `optionRomHashes` |
| `tpm.registry` | `keylos-tpm-registry` version string, e.g. `keylos-tpm-registry/1.0` |
| `tpm.pcrlockCoveredPcrs` | §4.6.4 |
| `owner.*` | §4.5; `owner.sealGate` per §4.5.4 (`touch` machines; omitted fields on `quorum` machines are as protocols §20.13 allows: the owner of a headless machine has no local login) |
| `vault.items` | Wi-Fi credentials and imported secrets, each encrypted (HPKE base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM) to the public key of `0x81000103` |
| `vouch` | §4.10 |
| `recovery.recipient` | Base64 of the 32-byte recovery recipient public key (REQ-INSTALLER-065) |
| `owners`, `config` | `null` for interactive and unattended installs; set only in cloud seeds (§4.15, protocols §20.13) |
| `fleet` | Answers file (§4.12) or `null` |
| `imports` | §4.13.8 |
| `installer` | Version, installer generation ref, SHA-256 of the final journal |

Integrity is anchored by `firstbootBundleDigest` in the first config generation. The bundle is inside the encrypted disk. Each consumer listed in protocols §20.13 deletes its part; `warden` removes the file when all have reported done.

#### 4.11.1 Pre-authorized input devices

Just before the final summary, the installer enumerates `/sys/bus/usb/devices` and writes `/mnt/target/var/lib/keylos/devd/preauthorized.json` (REQ-INSTALLER-066):

```json
{"schema":"keylos.preauth/1","devices":[
  {"vendor":"046d","product":"c52b","serial":"","port":"usb1-2","classes":["hid"]},
  {"vendor":"1050","product":"0407","serial":"","port":"usb1-3","classes":["hid"]},
  {"vendor":"05e3","product":"0610","serial":"","port":"usb2-1","classes":["hub"]}]}
```

- A device is listed when every interface has class `0x03` (HID); FIDO authenticators are HID-class and are listed. Hubs (`0x09`) are listed only when a listed device is attached through them.
- Devices on internal, hard-wired ports (`removable = fixed`) are omitted: the kernel authorizes them with `usbcore.authorized_default=2` (protocols §9.5).
- The summary screen shows the list ("These input devices will keep working after reboot") so the owner can unplug anything unexpected and re-scan.

### 4.12 Unattended installation

`installer --answers <file.ncl>` reads an answers file (§10) with every interactive choice:
- disk selector by stable path or size predicate;
- profile;
- owner data;
- FIDO2 handling:
  - `interactive`: as §4.5;
  - `deferred_firstboot`: no credential at install; the machine boots into a "pending enrolment" state in which `hearth` performs genesis at first login and no presence-class action is possible before it (the installer writes no `owners.log`, no seal gate and no config signature; the first config generation is the profile's **safe config** shipped in the OS generation, which `boot` uses when no signed config qualifies, protocols §15);
  - `fleet_delegated` (or `quorum` without a fleet): headless profiles, and `kiosk` when managed; the owner set at genesis is the credentials listed in the answers file (COSE keys and credential IDs, one or more per owner), the registry starts in `quorum` mode, and the genesis entry and first config generation are pre-signed remotely by the listed owners (§4.17);
- Secure Boot mode;
- recovery key escrow: the `fleet` escrow public key; the recovery key is encrypted to it (HPKE base mode) and uploaded by `fleet` at first connection;
- `fleet` enrolment token.

Unattended runs still print the summary on the console and wait `--confirm-timeout` seconds (default 30) for an abort key, unless `--yes` is given together with a fleet-signed answers file (DSSE, signed by the org key named in the answers file and pinned in the installer image's appliance config).

### 4.13 Recovery environment

#### 4.13.1 Boot

- The UKI's `recovery` profile (`boot` spec §4.12) adds `keylos.mode=recovery keylos.recovery=<recovery generation digest>` to the command line.
- `kl-initrd` asks for the recovery key, unlocks keyslot 0, extends PCR11 with `enter-recovery`, verifies the volume identity, mounts the recovery generation (registered in `kl-exec`) and starts `rescue` as PID 1.
- PCR11 differs from every normal phase, so no TPM-sealed secret of the main system unseals (REQ-INSTALLER-041).
- Target subvolumes are mounted `noexec,nosuid,nodev` (REQ-INSTALLER-043).
- The same `rescue` can run from the installer media (`installer rescue`) when the installed store is unusable; it then unlocks the disk itself with the recovery key.

#### 4.13.2 Authentication available in recovery

| Factor | How `rescue` uses it |
|---|---|
| Recovery key | Already proven by the unlock; `rescue` asks for it again to derive the values of §4.7, because `kl-initrd` does not hand it over |
| Owner FIDO2 credential | `getAssertion` with rpId `keylos.owner`, UV, presence purpose per operation (`boot.<op>`, `update.<op>`, `owners.entry`, `config.apply`); verified with `keylos-presence` against the registry replayed from `owners.log`. Assisted credentials work through `rescue`'s own trusted prompt |
| Quorum envelope | On `quorum` machines, presence-class operations need a quorum envelope (protocols §5.4) collected out of band: `rescue` shows the `keylos.quorum/1` request as a QR sequence or writes it to removable media, and accepts signed envelopes the same way |
| Owner hierarchy | `ownerAuth` decrypted from `/var/lib/keylos/tpm/hierarchy-owner.recovery` with the recovery recipient private key derived from the recovery key (`keylos-recovery-recipient/1`, §2.20) |
| Secure Boot PK | Re-derived from the recovery key (`keylos-sb-pk/1`, REQ-INSTALLER-068) |
| Lockout | `HKDF-SHA256(recovery key, "keylos-lockout/1")`; used only to reset dictionary-attack lockout (`TPM2_DictionaryAttackLockReset`) |
| Recovery auth object | `0x81000105`, satisfies the pcrlock-policy write branch |

#### 4.13.3 Operations

| Operation | Authentication | Effect |
|---|---|---|
| Inspect | Recovery key (unlock) | Show the ESP boot entries and their boot-counting state, the recovery log, pending receipts, and the output of the `depot verify` and `config-recover --list` tools of the OS generation (each repository's tool reads its own state; `rescue` reads no other repository's private files, protocols §10.7) |
| Roll back OS | Unlock | Make the previous OS UKI the systemd-boot default through the systemd-boot EFI variable `LoaderEntryDefault` (no `courier` file is written); spool `update.rollback`; `courier` reconciles its own state from the boot report at the next boot |
| Roll back config, revert a failed activation | Unlock + owner presence (`config.apply`), or a quorum envelope, both collected by `config-recover` | Run `config-recover [--to <counter>]` (`config` spec §4.7.6), which builds a new generation equal to an older one with `counter = NV(0x01300101) + 1` and never writes the counter: `boot` accepts `counter ≥` the NV value and `config` increments the counter at the next normal boot (protocols §15; REQ-INSTALLER-045). `rescue` reads its JSON exit report and spools `config.revert` |
| Re-enrol TPM | Unlock + owner presence (`boot.reenrol-tpm`), or recovery key alone after the 24-hour delay (§4.13.4) | Recompute the pcrlock policy from the current event log and write NV `0x01300103` through the recovery auth branch; reseal the disk token; if the TPM was cleared, recreate every §19.6 object the installer defines (counters re-created and advanced to max(last value seen in the newest ledger checkpoint, 0) + 1; the floor re-initialised per §4.13.5 from the signed release statement of the release being re-enrolled, verified against the release-stream keys; vault-epoch indices left to `vault restore`) |
| Re-enrol credentials | Unlock + an existing credential (or quorum), or the recovery key alone after the 24-hour delay | Append `enroll-credential` / `remove-credential` entries (signed by an existing credential), or a `recover` entry signed by the recovery signer; rewrite NV `0x01300105` (§4.13.5); reset the seal gate from a new credential (§4.13.5) |
| Reconstruct the recovery key from trustee cards | Cards (K of N) | `rescue trustee combine` (§4.16); then any recovery-key operation |
| Reset TPM dictionary-attack lockout | Recovery key | `TPM2_DictionaryAttackLockReset` with the lockout authorization |
| Reset Secure Boot to setup mode | Owner PK (re-derived from the recovery key) | Clears PK so the installer can re-enrol, or switch to shim fallback |
| Reinstall keeping /home | Unlock + owner presence, or the delayed path | §4.14 |
| Factory reset | Recovery key | Crypto-erase: overwrite both LUKS2 header areas and keyslots, undefine every keylos NV index and evict every keylos persistent object, reset Secure Boot to vendor defaults where the firmware allows |
| Export data | Unlock | Copy chosen files to removable media through the recovery powerbox |
| Organisation wipe | The wipe bundle (§2.20): `/var/lib/keylos/fleet/wipe.dsse` written by `fleet` (protocols §10.7); only when that file is absent, the same bundle imported with `rescue wipe import` from removable media | Performed on entering recovery when a bundle is present (REQ-INSTALLER-044): verify the command against `/etc/keylos/fleet/approvers.json` of the target's current config generation (≥ `commandQuorum` distinct approvers) and the owner quorum envelope against the replayed owner registry (≥ `policy.threshold` distinct owners), check the time window against the time floor and the `id` against the recovery log, then factory reset and spool `recovery.wipe`; a bundle that fails verification is shown and ignored |

#### 4.13.4 Delayed recovery-key-only path

When no owner credential is available, operations that would otherwise need presence accept the recovery key alone after a **24-hour delay** shown on screen. During the delay:
- `rescue` spools a `recovery.delay` pending receipt (`data.phase = "started"`, `data.operation`, `data.until`) and records the same in the recovery log (`@var/log/installer/recovery.jsonl`, §9);
- the machine must stay in the recovery environment for the whole delay (a reboot restarts the countdown), so the owner notices an unexpected recovery screen;
- the countdown is cancellable by any existing owner credential, which spools `recovery.delay` with `data.phase = "cancelled"`;
- the key changes that follow are written as replayable pending receipts (`key.enroll`, `key.remove`, with `data.recovery.delayed = true`), and `vouch` (if paired) is notified of the recovery operations at its next contact.

This makes a stolen recovery key less useful to an attacker who also has physical access but no FIDO2 credential.

#### 4.13.5 TPM writes from recovery

PCR11 holds `enter-recovery`, so the services' sealed authValues (§4.6.6) and the hierarchy blobs do not unseal. `rescue` uses the owner authorization from the recovery copy (§4.13.2):
- **Owner-registry head / login-failure counter:** `TPM2_NV_UndefineSpace` with `ownerAuth`, then re-define from the registry template with a new random authValue, write the required value (the head: the new 104-byte head; the counter: increment past the last value seen), re-seal the new authValue for `hearth` (`/var/lib/keylos/tpm/nv-auth/<index>.sealed`; sealing needs no policy session), zeroize.
- **Config counter:** never written from recovery (REQ-INSTALLER-045).
- **Seal gate (`touch` machine):** undefine `0x01300140 + i` and re-define it with `auth = o_0` from the replacement credential (one touch, salts `s_0`, `s_1`), then rotate as in §4.5.4. The NV Name does not depend on the authValue, so the owner-seal key's `PolicySecret(0x01300140 + i)` keeps working; the key is not recreated. `hearth` resets its salt counter for that owner from the `recover` entry at the next normal boot.
- **Seal gate (`quorum` machine):** undefine and re-define with a new random authValue, re-seal it into `/var/lib/keylos/hearth/seal-gate-<i>.sealed`.
- **Floor:** never lowered. Re-initialised only when the index is absent or unreadable (TPM clear, or an interrupted floor write): an explicit re-enrolment step (owner presence or the delayed recovery-key path) that re-defines `0x01300102` with `ownerAuth` and writes the `floor` of the signed release statement of the release being re-enrolled under that UKI's initialisation policy (`kl-boot floor init`, boot spec §4.12). The baseline is never reconstructed from ordinary disk state, and the pending receipt records `floorHistoryReset: true` (the TPM clear destroyed the earlier history).
- **Vault-epoch indices:** never touched by `rescue`; after a TPM clear `vault` re-provisions them through `HearthTpm.defineSpace` during `vault restore` (vault spec §4.9).
- After any of these, `hearth` rotates the owner authorization at the next normal boot (`hearth` spec §4.7.1), so the value recovery used is no longer valid.

#### 4.13.6 Pending receipts

Recovery writes each receipt it owes as `/var/lib/keylos/recovery/pending/<ULID>.dsse`, exactly protocols §20.22 (embedded in §2.16d):

```json
{"schema":"keylos.pendingreceipt/1","event":"key.enroll","onBehalfOf":"rescue","time":"…","bootId":"<recovery boot id>",
 "seq":3,"subject":"shell@ada/s-…","data":{"keyid":"key:sha256:…","op":"enroll-credential","presence":"sha256:<envelope digest>"},
 "label":null,"attested":true}
```

- `bootId` is the recovery boot's `/proc/sys/kernel/random/boot_id`; `seq` starts at 1 per recovery boot.
- When the recovery key was entered in this recovery session (every session that unlocked with it), the payload is DSSE-signed with the `recoverySigner` (Ed25519 from `keylos-recovery-signer/1`) and `attested: true`. A session that did not prove the recovery key (a wipe completed from the installer media with only the bundle) writes unsigned files with `attested: false`.
- Events MUST be recovery-replayable (protocols §19.3): `key.enroll`, `key.remove`, `presence.assert`, `config.revert`, `config.apply`, `update.rollback`, `user.create`, `recovery.enter`, `recovery.delay`, `recovery.wipe`.
- `recovery.enter` is the first file of every recovery boot (`data.via = "uki-recovery" | "installer-media"`); `recovery.wipe` is written after a factory reset succeeds (`data.command = "<fc-id>"`; written to the fresh `@var` that the reset recreates, so the next install or boot ingests it).
- At the next normal boot `ledger` verifies, appends with `writer = service:ledger`, `data.onBehalfOf`, `data.attested` and `data.pendingSeq`, and deletes the files (protocols §20.22). Other recovery activity is recorded only in the recovery log (§9).

#### 4.13.7 UI

`rescue` runs a minimal `atrium` session (no apps) or a text UI on serial. Every operation shows its exact effect before it runs, rendered like a T3 prompt. The recovery environment has no network by default. Network can be enabled for downloading a fresh OS generation, verified exactly like an update.

#### 4.13.8 Migration from another Linux

1. The "Import data" step lists partitions with recognised filesystems: ext4, btrfs, xfs, LUKS1/LUKS2 (passphrase prompt), LVM.
2. The source is mounted **read-only** with `nosuid,nodev,noexec` in a private mount namespace of the `installer` service.
3. The owner selects home directories and folders to import. The default selection is user files: Documents, Pictures, Music, Videos, Desktop, Downloads, source trees. Dotfiles are listed separately and are not selected by default.
4. Files are copied with `copy_file_range`. Each gets `security.bpf.keylos.label = private/untrusted` (2 bytes, protocols §10.4). Executable bits are kept; they are harmless because `/home` is `noexec` and `kl-exec` never registers it.
5. **Recognised items** are offered for import into `vault` (each named, each optional):
   - SSH keys (`~/.ssh/id_*`), as vault items of kind `ssh-key`;
   - `~/.netrc` entries and browser password exports, as items of kind `password`.
   GnuPG keys are not imported by the installer; `compat`'s vault import island can do it after first boot.
6. Selected dotfiles are copied into `Imported/<id>/dotfiles/`, never into live config locations. After first boot, `config adopt` can offer to translate them.

### 4.14 Reinstall preserving /home

1. Unlock with the recovery key. Obtain owner presence with any credential, or take the delayed path.
2. Snapshot `@home` read-only as `@snapshots/pre-reinstall-<ulid>`.
3. Delete and recreate `@store`, `@var` and `@snapshots` (except the pre-reinstall snapshot).
4. `@keystore`:
   - unwrap its contents with the old keys (TPM objects if still valid; otherwise through `vault`'s `recovery` slots, opened with the recovery recipient private key derived from the recovery key, per the `vault` spec);
   - re-wrap under the new TPM objects.
5. Populate the store, provision the TPM (preserving the owner registry: the new genesis is replaced by a `recover` entry appended to the preserved `owners.log`) and create a new first config generation with `counter = NV + 1`.
6. Keep users, UIDs and `.apps` data.
7. Write pending receipts for the whole operation.

### 4.15 Cloud first-boot seeding (`keylos-seed`)

`cloud` images have no interactive installer (protocols §2.2, §20.13 "Cloud seed"). The `keylos` distribution builds them with an unprovisioned disk: the GPT and partitions exist, `keylos-root` is a LUKS2 volume whose only keyslot is an **image keyslot** with a well-known passphrase, and the store holds the OS generation, the recovery generation and `keylos-seed`.

1. **Seed boot.** The UKI's `seed` profile (`keylos.mode=seed`) boots the installer generation from the image store with `keylos-seed` as its main service. Its config generation is the image's signed seed config (release-stream signed), which pins `fleet.seedKeys`.
2. **Fetch.** `keylos-seed` reads `keylos/firstboot` from the provider metadata service (instance user-data or metadata attributes; providers supported: those listed in the `keylos` spec), through `gate`'s seed-only egress grant to the link-local metadata address.
3. **Verify** (REQ-INSTALLER-063): the value is a DSSE envelope of `keylos.firstboot/1` signed by a key in `fleet.seedKeys`; otherwise stop with a serial-console error and power off after 10 minutes. Unsigned user-data is never read further.
4. **Provision.** With the bundle's `profile = "cloud"`:
   - TPM: the provider vTPM (or SVSM vTPM on confidential VMs); provisioning as §4.6.1, except that the EK chain comes from the provider (`machine.ekCertChain` filled from the vTPM's NV EK certificate);
   - storage: add the TPM keyslot (TPM-only, no PIN, as `server`), add the recovery keyslot from a recovery secret the seed stage generates, and **remove the image keyslot**; then re-key the volume key with `cryptsetup reencrypt` so the well-known image key protects nothing;
   - recovery secret: encrypted to the fleet escrow key named in the bundle's `fleet` part (HPKE base mode, X25519), never displayed; the escrow record is uploaded by `fleet` at first connection; the recovery recipient is derived and written as REQ-INSTALLER-065;
   - owner registry: the bundle's `owners` part (protocols §20.13: presigned owner-registry lines, genesis first, `quorum` mode, §4.17); each line carries the owners' own presence signatures, which `keylos-seed` verifies before writing `owners.log` and the NV head (REQ-INSTALLER-069);
   - first config generation: the bundle's `config` part (`statement`: the quorum-signed `keylos.configgen/1` envelope; `source`: `oci://…#gen=fsv256:…`), verified against the registry just written, fetched and imported as §4.9.2 step 4;
   - os-floor: initialised as §4.6.5, using the stream-signed approval for the `seed` profile's `ready` phase (`pcr11Seed` in the release statement, protocols §19.6, §20.6);
   - write the remaining bundle parts as `/var/lib/keylos/firstboot/bundle.json`.
5. **Integrity profile.** `cloud-vtpm`, or `cvm` when the confidential-VM report is available and verifies (the fleet verifies it again at enrolment).
6. Spool no receipts (the seed stage is not recovery); the first normal boot's `ledger` writes the genesis receipts from the bundle. Reboot into the normal UKI profile. The seed profile refuses to run again once `owners.log` exists.

Secure Boot custom keys are enrolled when the provider exposes a writable UEFI variable store; otherwise the image boots through shim and the integrity profile records `shim`.

### 4.16 Trustee share cards

After the recovery key is confirmed (§4.3 step 11), the owner may choose "Give shares to trustees":
1. The owner picks *k* and *n* (2 ≤ k ≤ n ≤ 16) and optional trustee labels.
2. The installer splits the 32-byte secret per protocols §20.19 (Shamir over GF(2^8), SLIP-0039 field arithmetic, coefficients from the OS CSPRNG), with a common random `set` and `check` = first 8 hex of SHA-256(secret).
3. Each `keylos.trustee/1` card goes into the recovery kit PDF as its own page: the JSON as a QR code (binary mode, error correction Q), the `share` in 8-character groups, the trustee label, the machine name and the instructions "Any *k* of these cards reconstruct the recovery key; one card reveals nothing."
4. Presence is not required at install (the owner is enrolling); after install, `hearth trustee split` requires presence (purpose `trustee.split`).
5. Nothing is written to the target disk. The recovery environment reconstructs from cards with `rescue trustee combine`, which verifies `set`, `machine`, `k`, `n` and `check`.

### 4.17 Quorum-mode owners (headless profiles)

Applies to `server`, `server-k8s`, `appliance`, managed `kiosk`, and `cloud` (through §4.15).

1. **Owner set.** The answers file (or seed bundle) lists the owners: for each owner a name and one or more `keylos.owner` credentials exported from the owners' own keylos machines (`hearth credential export`) or from `fleet-ctl` (COSE key, credential ID, AAGUID, label), plus `quorum.threshold` (REQ-INSTALLER-062).
2. **Genesis entries.** The installer builds the genesis entry for owner 0 (`policy = {"mode": "quorum", "quorum": N, "threshold": N}`, `ownerIndex` 0, `sealKey`, `recoverySigner`, no `seal` credential), followed by `add-owner` entries for owners 1…M−1 (each with its `ownerIndex` and `sealKey`). The owner-seal keys and seal gates are created first (step 4), so the `sealKey`s are known.
3. **Signatures.** Each entry must carry the signatures required by protocols §20.3 and the `hearth` spec §4.5.1 (quorum column): the answers file's `presigned.registry` contains the entries already signed remotely (`hearth presence --remote` on the owners' machines, or `fleet-ctl`). The installer verifies them with `keylos-presence` and refuses on any mismatch with the entries it built (field-by-field JCS comparison; the installer fixes `time`, `prev` and `sealKey` only after the owners have signed a draft produced by `installer plan --registry-draft`, so in practice the draft is produced first and signed, then the install runs).
4. **Seal gates.** For each owner *i*: define `0x01300140 + i` with a random 32-byte authValue `A_0`, create `0x81000140 + i`, and seal `A_0` for `hearth` into `/var/lib/keylos/hearth/seal-gate-<i>.sealed` (PCR11 `ready` ∧ PCR15). No self-test is run (no window can be opened without a quorum envelope); `hearth` verifies the gate at first start with a policy-session dry run that does not sign.
5. **First config generation** is likewise presigned (`presigned.config`, a quorum envelope over the `keylos.configgen/1` payload of the draft).
6. **Recovery key.** Shown on the console and, when configured, escrowed to the fleet (§4.12); trustee cards may be produced (§4.16).

---

## 5. Interfaces

### 5.1 capwire: `installer.capnp` (repo-local)

Used only between `installer-ui`/`installer-tui` and `installer`. The file ID is outside the protocols range (protocols §7.4).

```capnp
@0xd4e1a5c3b2f40101;
using C = import "/keylos/common.capnp";

struct HardwareReport {
  arch @0 :Text; archLevel @1 :Text; uefi @2 :Text;
  secureBoot @3 :Text;       # "user" | "setup" | "audit" | "deployed" | "disabled"
  tpm @4 :Text;              # "2.0 rev 1.59, fTPM AMD" | "none"
  policyAuthorizeNV @5 :Bool;
  iommu @6 :Bool; kvm @7 :Bool; featureLevel @8 :Text;
  optionRoms @9 :List(Text); warnings @10 :List(Text);
  nvFreeBytes @11 :UInt32;
}

struct Disk { path @0 :Text; model @1 :Text; sizeBytes @2 :UInt64; logicalSector @3 :UInt32; removable @4 :Bool; partitions @5 :List(Text); }

struct Plan {
  profile @0 :Text; disk @1 :Text; swapBytes @2 :UInt64;
  owner @3 :Text; login @4 :Text; secureBootMode @5 :Text;
  vouch @6 :Bool; imports @7 :List(Text); erasure @8 :List(Text);
  touchesRemaining @9 :UInt8;
}

struct Progress { step @0 :Text; state @1 :Text; fraction @2 :Float32; message @3 :Text; touchRequested @4 :Text; }

interface Installer {
  hardware   @0 () -> (report :HardwareReport);
  disks      @1 () -> (list :List(Disk));
  setProfile @2 (profile :Text) -> (integrity :Text, notes :List(Text));
  setOwner   @3 (name :Text, displayName :Text, login :Text, password :C.Fd) -> ();   # password in a sealed memfd
  enrolFido2 @4 (label :Text) -> (keyRef :Text);            # blocks for touch
  setPin     @5 (pin :C.Fd) -> ();                          # PIN in a sealed memfd
  secureBootOptions @6 () -> (modes :List(Text), instructions :Text);
  chooseSecureBoot  @7 (mode :Text, includeMicrosoftCa :Bool) -> ();
  pairVouch  @8 () -> (qrPayload :Text, code :Text);        # returns when paired or canceled
  recoveryKey @9 () -> (groups :List(Text), qr :Text);
  confirmRecovery @10 (positions :List(UInt8), groups :List(Text)) -> (ok :Bool);
  sources    @11 () -> (list :List(Text));                  # migration sources
  selectImports @12 (paths :List(Text)) -> ();
  plan       @13 () -> (plan :Plan);
  execute    @14 (watcher :C.Watcher(Progress)) -> ();      # REQ-INSTALLER-003 confirmed by calling this
  abort      @15 () -> ();
  finish     @16 (reboot :Bool) -> ();
}
```

### 5.2 CLI

```
installer [--tui] [--answers <file.ncl>] [--yes] [--confirm-timeout <s>] [--log <file>]
installer hwcheck [--json]
installer plan --answers <file.ncl> --registry-draft <out>   # quorum profiles: emit the unsigned registry entries and
                                                            # config statement drafts for the owners to sign (§4.17)
installer resume                 # resume an interrupted install from the journal
installer abort                  # roll back an interrupted install
installer rescue                 # run rescue from the installer media

rescue                           # PID 1 of the recovery generation; interactive menu
rescue inspect [--json]
rescue rollback os|config [--to <gen>]
rescue reenrol tpm|fido2
rescue reinstall --keep-home
rescue factory-reset
rescue export <paths…>           # destination chosen through the recovery powerbox
rescue revert-config [--to <counter>]   # runs config-recover (config repository) after an activation failure (REQ-INSTALLER-045)
rescue trustee combine           # reconstruct the recovery key from K trustee cards (§4.16)
rescue quorum export|import      # quorum machines: carry keylos.quorum/1 requests and signed envelopes by QR or media
rescue wipe import <file>        # import a wipe bundle (command + owner quorum envelope) from removable media
rescue da-reset                  # reset TPM dictionary-attack lockout with the lockout authorization

keylos-seed                      # cloud images: first-boot provisioning stage (§4.15); runs only in the seed profile

keylos-enrol tpm                 # main system, owner shell: reseal disk token + rewrite pcrlock (T3, presence)
keylos-enrol fido2 add|remove <label>
keylos-enrol vbu-totp            # create the sealed VBU TOTP secret at /efi/keylos/vbu-totp.sealed (protocols §20.5)
keylos-enrol recovery-key        # rotate the recovery key (presence): new LUKS keyslot 0, recovery auth object,
                                 # lockout auth, recovery signer (recover entry), recovery recipient
                                 # (recipient.pub; hearth re-encrypts the owner-auth copy and vault re-wraps
                                 # recovery slots), owner Secure Boot PK (KEK re-signed by the new PK)
keylos-enrol status [--json]

Exit codes: 0 ok; 1 failed; 2 usage; 3 aborted by user; 4 hardware unsupported;
            5 authentication failed; 6 TPM error; 7 firmware variable write refused;
            8 delay not elapsed.
```

### 5.3 Files

| Path | Writer | Consumer |
|---|---|---|
| ESP `\EFI\BOOT\BOOTX64.EFI` / `BOOTAA64.EFI` | installer | firmware (systemd-boot signed by the release-stream key, or shim) |
| ESP `\EFI\Linux\keylos-<version>-<gen-prefix>+3-0.efi` | installer, courier | systemd-boot (boot counting suffix) |
| ESP `\loader\loader.conf` | installer | systemd-boot: `timeout 0`, `editor no`, `auto-entries no`, `auto-firmware yes`, `default keylos-*` |
| `@var/lib/keylos/firstboot/bundle.json` | installer | protocols §20.13 consumers |
| `@var/lib/keylos/hearth/owners.log` | installer (genesis), rescue | hearth, boot |
| `@var/lib/keylos/tpm/nv-auth/<index>.sealed` | installer, rescue | the index's owner (ledger, config, vault, hearth, strata) |
| `@var/lib/keylos/tpm/hierarchy-owner.sealed`, `hierarchy-endorsement.sealed` | installer (then hearth) | hearth |
| `@var/lib/keylos/tpm/hierarchy-owner.recovery` | installer (then hearth) | `rescue` |
| `@var/lib/keylos/recovery/recipient.pub` | installer, `keylos-enrol recovery-key` | vault, hearth |
| `@var/lib/keylos/hearth/seal-gate-<i>.sealed` | installer (quorum machines), rescue | hearth |
| `@var/lib/keylos/hearth/platform/<keyid>.blob` | installer (assisted credentials) | hearth |
| `@var/lib/keylos/devd/preauthorized.json` | installer | devd |
| `/efi/keylos/vbu-totp.sealed` | `keylos-enrol vbu-totp` | boot |
| `@keystore/ledger/signing.sealed` | installer | ledger |
| `@var/lib/config/repo/` | installer | config |
| `@var/lib/installer/journal.jsonl` | installer | owner (status, export); `ledger` reads only its SHA-256 from the bundle (`installer.journal`), never the file |
| `@var/lib/keylos/recovery/pending/<ULID>.dsse` | rescue | ledger |
| `@var/log/installer/recovery.jsonl` | rescue | owner (status, export); not read by other services |

---

## 6. Security

### 6.1 Threats

| Threat | Mitigation |
|---|---|
| Tampered installer media | Installer UKI verified by Secure Boot (release-stream cert trusted by firmware via shim, or by a `db` entry from a previous owner-mode install); the installer shows its own UKI hash and, when online, the release-log inclusion status |
| Attacker-pre-set firmware variables (PK already set) | The installer shows current PK/KEK/db subjects and refuses owner mode unless SetupMode is entered by the owner |
| Recovery key shoulder-surfing | Shown once; confirmation by groups; never stored on the target in clear |
| Weak PIN | Minimum 6 digits (8 on laptop by default); TPM dictionary-attack lockout (32 tries, 1 per 10 min recovery) |
| Single FIDO2 credential loss | Two credentials by default; delayed recovery path |
| Install interrupted, leaving partial trust state | Journal; Secure Boot enrolment second-to-last; test boot |
| Imported malware in home data | `private/untrusted` labels; `/home` `noexec` and never registered in `kl-exec`; dotfiles not applied |
| Forged unattended answers | `--yes` requires a DSSE-signed answers file from the pinned org key |
| Thief with the recovery key | FIDO2 still needed for presence-class recovery actions; the delayed path is visible and cancellable; pending receipts make it auditable |
| Floor downgrade during install | Only the genuine installer can write the floor (§4.6.5) and it never lowers it |
| Captured seal-gate auth from the install session | Rotated to `o_1` before the installer exits; `o_0`, `o_1` zeroized |
| Malicious code reading service NV authValues | Sealed to the signed `ready` phase and PCR15; never present in the live image after zeroization |
| Cloud image with a well-known disk key | The image keyslot is removed and the volume re-encrypted during seeding (§4.15) |
| Forged cloud seed or user-data | Only a DSSE seed signed by a pinned fleet key is read; registry entries carry the owners' own signatures |
| Pre-signed headless genesis altered by the installer host | The installer refuses entries that differ from the signed drafts; `boot` and `hearth` verify the signatures again |
| Trustee cards stolen individually | One card reveals nothing; *k* cards are needed; rotating the recovery key invalidates all cards |
| Owner hierarchy authorization exposure | Sealed for `hearth` only; recovery copy HPKE-encrypted to the recovery recipient, whose private key exists only while the recovery key is typed; rotated by `hearth` after recovery |
| Malicious USB device present during installation gains standing authorization | Only all-HID devices and their hubs are pre-authorized, the list is shown before confirmation, and `devd` re-evaluates every device after the first `switch_root` (protocols §9.5) |
| Theft of a stored Secure Boot PK | The PK is never stored; it exists only while the recovery key is entered |

### 6.2 Data handled

The installer process handles secrets: the volume key, the TPM keyslot passphrase, the recovery key, the PIN, the password, the owner hierarchy auth, NV authValues, `hmac-secret` outputs and the machine signing key.
- They are kept in `memfd_secret` regions and zeroized after use.
- They are never written to disk except in the documented sealed or wrapped forms.
- They are never logged. Logs record step names and non-secret metadata only.
- PIN and password arrive from the UI as sealed memfds, not as capwire text.

### 6.3 Confinement of the installer itself

The installer runs as a tier-0 service **only in the live image**, under a route table that exists only in the live image's config generation.

| Privilege | Why |
|---|---|
| Raw block device fds for the selected disk (from `devd`, materialised by `broker` from a live-image grant) | Partitioning and LUKS |
| `/dev/tpmrm0` | TPM provisioning |
| `efivarfs` write access (an fd to `/sys/firmware/efi/efivars` mounted rw in its mount namespace by `warden`) | Secure Boot enrolment, `BootNext` |
| Detached fsmount fds for the target subvolumes, provided by `warden` | Target mounts (the installer never calls `mount` itself) |
| FIDO2 hidraw devices (via `devd`) | Enrolment and presence |
| Network: only through `gate`, with `courier-tuf` host grants and the vouch pairing listener | Install latest, pairing |

Landlock (applied after setup):
- read: the installer media mount;
- read/write: the target mounts and `/run/installer`;
- nothing else.

seccomp allowances beyond `baseline-1`: `ioctl` on block devices (`BLKPG`, `BLKGETSIZE64`, `BLKSSZGET`, `BLKDISCARD`), `ioctl` on `/dev/tpmrm0`, `ioctl` on hidraw.

`keylos-seed` has the installer's privileges in the `seed` profile, with network restricted by `gate` to the provider metadata address and, for "install latest", the TUF hosts; it never listens.

`rescue` has the same privileges in the recovery environment, minus network unless enabled. As PID 1 of the recovery generation it is the only process besides helpers it spawns from the recovery generation.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| Power loss during install | The next boot of the installer media detects the journal (in the ESP-adjacent GPT backup before LUKS exists; on the target after `btrfs-create`) and offers resume or wipe |
| NV space exhausted | Show free space; offer to remove keylos objects from a previous install (identified by the §19.6 handles and templates); otherwise stop |
| A §19.6 handle is occupied by a non-keylos object | Stop; explain; offer a TPM clear from firmware |
| Firmware refuses `db`/`PK` write | Stop before `PK`; offer shim fallback; firmware left in setup mode with instructions |
| Test boot does not reach first boot | The next normal boot returns to the installer media (only `BootNext` was set), which detects the failed test, shows diagnostics and offers shim fallback or re-enrolment |
| FIDO2 authenticator without `hmac-secret` or UV | Refuse that authenticator with a clear message; list compatible ones |
| pcrlock prediction excludes PCRs | Proceed; show covered PCRs; `status` displays coverage |
| No network during install | Offline install from media; vouch pairing by typed code |
| Seal-gate self-test fails | Undefine the gate and evict the key; retry once with a new touch; on a second failure stop and report the TPM error |

---

## 8. Performance budgets

| Operation | Budget (reference laptop, NVMe 3 GB/s) |
|---|---|
| Installer boot to welcome screen | ≤ 25 s from USB 3 |
| Hardware check | ≤ 3 s |
| LUKS2 integrity format (1 TB) | Dominated by the device; the installer shows an ETA; target ≤ 6 min |
| Store copy (desktop default set, ~6 GiB) | ≤ 90 s |
| TPM provisioning (all §19.6 objects, excluding touches) | ≤ 20 s |
| First config compile + sign | ≤ 20 s excluding the touch |
| Total unattended install on 512 GB NVMe | ≤ 10 min |
| Recovery: PIN-less unlock to `rescue` menu | ≤ 10 s after the recovery key is entered |

---

## 9. Observability

- **Install journal** (§4.2), plus `installer.log` (structured, no secrets) copied to `@var/log/installer/`.
- **Receipts** emitted at first boot by `ledger` from the first-boot bundle (`machine`, `installer.journal` digest; protocols §20.13) (protocols §19.3 events):
  - `boot` (first);
  - `key.enroll` (each FIDO2 credential, owner-seal key, KEK/db signers);
  - `config.apply` (counter 1);
  - `user.create` (first owner).
- **Recovery** writes pending receipts (§4.13.6) only with the recovery-replayable core events: `key.enroll`, `key.remove`, `presence.assert`, `config.revert`, `config.apply`, `update.rollback`, `user.create`, `recovery.enter`, `recovery.delay`, `recovery.wipe`. Everything else is recorded in the **recovery log** `@var/log/installer/recovery.jsonl` (JSON Lines, one record per action, hash-chained with SHA-256 of the previous line, never containing secrets), which `status` and `hearth status` surface after the next boot:

| Record | Meaning |
|---|---|
| `recovery.enter`, `recovery.delay` | Mirrors of the pending receipts of the same name |
| `tpm.reenrol` | TPM objects re-created or disk token resealed |
| `reinstall` | Reinstall preserving `/home` |
| `wipe.verified`, `wipe.rejected` | Organisation wipe bundle handling (with the command `id`, used for single-use checks) |
| `config.revert-built` | Revert generation built after an activation failure |

- **Metrics:** none persistent. The installer UI shows timing per step.

---

## 10. Configuration

The answers file schema (`installer/answers.ncl`):

```nickel
{
  Answers = {
    disk | { by_path | String | optional, min_size_gib | Number | optional, wipe_all | Bool | default = false },
    profile | [| 'desktop, 'laptop, 'kiosk, 'server, 'server_k8s, 'appliance |],
    owner | {
      name | String,
      display_name | String | default = name,
      login | [| 'password_fido2, 'fido2_only, 'assisted, 'deferred, 'none_headless |],
      password_hash | String | optional,
    },
    fido2 | [| 'interactive, 'deferred_firstboot, 'fleet_delegated, 'quorum |] | default = 'interactive,
    owners | Array {                        # fleet_delegated / quorum: the initial owner set (§4.17)
      name | String,
      credentials | Array { label | String, cose | String, credential_id | String, aaguid | String | optional },
    } | default = [],
    quorum | { threshold | Number | default = 2, allow_single | Bool | default = false } | optional,
    presigned | {
      registry | String,                    # JSON Lines of owner-registry envelopes, signed per hearth §4.5.1 (quorum column)
      config | String,                      # DSSE configgen, quorum-signed by the owners
    } | optional,
    pin | [| 'interactive, 'none_server |] | default = 'interactive,
    secure_boot | [| 'owner, 'owner_keep_microsoft, 'shim |] | default = 'owner,   # 'owner_keep_microsoft → shared-boot
    trustees | { k | Number, n | Number, labels | Array String | default = [] } | optional,
    swap_gib | Number | default = 0,
    recovery | { escrow_to_fleet | Bool | default = false, escrow_key | String | optional },
    fleet | { enrol_token | String, org_key | String } | optional,
    locale | { lang | String | default = "en_US.UTF-8", keymap | String | default = "us", timezone | String | default = "UTC" },
    network | Array { ssid | String, psk_ref | String } | default = [],
    apps | Array String | optional,
    vouch | Bool | default = false,
  },
}
```

Contracts:
- `fido2 ∈ {'fleet_delegated, 'quorum}` ⇒ `owners` non-empty ∧ `presigned` present ∧ (`quorum.threshold ≥ 2` ∨ `quorum.allow_single`) ∧ `quorum.threshold ≤ length(owners)`;
- `profile ∈ {'server, 'server_k8s, 'appliance}` ⇒ `fido2 ∈ {'fleet_delegated, 'quorum}` (headless machines use quorum presence, REQ-INSTALLER-062);
- `pin == 'none_server` ⇒ `profile ∈ {'server, 'server_k8s, 'appliance}`;
- `trustees` present ⇒ `2 ≤ trustees.k ≤ trustees.n ≤ 16`.

---

## 11. Testing and acceptance criteria

**Unit tests:**
- recovery key encode/decode, CRC-8 per group, group confirmation, HKDF derivations against fixed vectors;
- LUKS2 token JSON round trip against the `boot` spec field set;
- TPM policy digests (unlock policy, pcrlock NV content, seal gate, owner-seal key, NV write policies) compared against vectors computed with `tpm2-tools` sessions and against `keylos-tpm-registry` templates (protocols `vectors/tpm/`);
- genesis entry construction and verification with `keylos-presence` (protocols `vectors/presence/`);
- `keylos.firstboot/1` output validated against protocols `vectors/firstboot/` (no extra fields);
- event-log option-ROM extraction, using captured event logs from 20 machines in `tests/eventlogs/`;
- answers-file validation.

**Integration (VM with swtpm + OVMF in setup mode, soft FIDO2 authenticators with `hmac-secret`):**
1. Interactive install in owner mode with two credentials → first boot reaches the greeter; every bundle consumer reports success; receipts present; `boot` report shows `vbu`, `unlock = tpm2+pin`, `configCounter = 1`, `floor` = release floor.
2. Every §19.6 object exists with the template attributes; no other keylos-range objects exist.
3. Seal gate: after install, `o_0` no longer satisfies `PolicySecret(0x01300140)`; `o_1` does; the owner-seal key signs only with it.
4. Install with OVMF not in setup mode → shim fallback → MokManager confirmation (scripted) → boot; PCR 14 in the pcrlock selection.
5. Interrupt at each journal step (kill power) → resume and abort both work.
6. Recovery: swtpm reset → `rescue reenrol tpm` with recovery key + presence → normal boot; counters ≥ previous values.
7. Recovery: both credentials removed → delayed path → after the (test-shortened) delay a new credential is enrolled with a `recover` entry; the cancel path also tested.
8. Reinstall keeping /home: files and `.apps` data identical (hash comparison); keystore items still readable by their apps; `owners.log` preserved.
9. Migration from an ext4 home: labels set; dotfiles not applied; SSH key imported into vault on request.
10. Unattended appliance install with a fleet-signed answers file and `--yes`.
11. Floor: installing release N on a TPM whose floor is already N+1's floor refuses to lower it; on a fresh TPM the floor is written exactly once with `F` under the `PolicyNvWritten(NO)` approval, and a second write attempt with the installer approval fails because the index is written; a write of any value other than `F` fails the `PolicyCpHash` check.
12. TPM registry: every NV index the installer defines is readable without authorization through the `NV_Read` branch; the vault-epoch indices are absent after installation and appear only after `vault`'s first `HearthTpm.defineSpace`; every `nv-auth/*.sealed` and hierarchy blob has the §19.6 sealed-object template and the production authPolicy digest (never the development fallback); AK and AK0 have exactly the §19.6 attributes; owner and endorsement authorizations are non-empty and unseal only at PCR11 `ready` with the enrolled PCR15; lockout authorization equals `HKDF(recovery, "keylos-lockout/1")`.
13. Dual boot: owner mode with `keepMicrosoftCAs` → `db` contains the Microsoft CAs; boot report and `vouch` show `shared-boot`; without it a Microsoft-signed loader is refused by firmware.
14. Assisted install: one roaming key plus an assisted credential → genesis and `enroll-credential` verify; `assisted: true` recorded; seal self-test passes with the platform seal key.
15. Headless quorum install (`server`, threshold 2 of 3) from presigned drafts → first boot reaches `ready`; `hearth status` shows `sealing: quorum`; a draft altered after signing is refused before any disk change.
16. Cloud seed: an image booted with no user-data powers off; with unsigned user-data powers off; with a valid seed → image keyslot gone, volume re-keyed (the old key no longer opens it), integrity profile `cloud-vtpm`; on a confidential VM `cvm`.
17. Trustee cards 2-of-3 printed in the kit; any two reconstruct the key in `rescue`; one alone is refused.
18. Organisation wipe: a bundle whose command is signed by 2 of 3 approvers of `approvers.json` and whose `boot.wipe` quorum envelope is signed by 2 of 3 owners → factory reset on entering recovery and a `recovery.wipe` receipt at the next boot; command signed by 1 → shown and ignored; quorum envelope missing or bound to another command digest → ignored; expired → ignored; the same bundle imported again from media after the reset → refused (`id` already recorded).
18a. Wipe bundle path and details: with `/var/lib/keylos/fleet/wipe.dsse` present, `rescue` reads it and ignores removable media; a `boot.wipe` envelope whose `details.command` is only the command `id` (not the object) or whose `commandDigest` does not equal `sha256:` of the command's JCS bytes is refused; with the file absent, `rescue wipe import` of a valid bundle completes the wipe.
19. Activation failure: a config that fails readiness three times → `rescue revert-config` runs `config-recover`, which builds counter NV+1 without writing NV; the next boot selects it and `config` then increments the counter; `rescue` opened no file under `/var/lib/keylos/config/` (checked with the Landlock audit log); a `config.revert` pending receipt is ingested.
20. Pending receipts: after recovery FIDO2 re-enrolment, `ledger` shows `recovery.enter` and `key.enroll` with `writer = service:ledger`, `data.onBehalfOf = "rescue"`, `data.attested = true`; a pending file with a corrupted signature is kept and reported by `ledger.alarm`; no `x-installer` receipts exist.
21. Recovery recipient: `recipient.pub` and the bundle's `recovery.recipient` equal the public key derived from the recovery key; the hierarchy recovery copy decrypts in `rescue` with that key; no private recipient key exists on disk.
22. Pre-authorized devices: with a USB keyboard, a FIDO key and a USB stick attached during install, `preauthorized.json` lists the keyboard, the FIDO key and their hub, not the stick; it validates against protocols `vectors/preauth/`.
23. NV authorization files: every `0x0130010x.sealed` and `hierarchy-*.sealed` is exactly `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` and unseals for its owner service at `ready`.
24. Secure Boot PK: deriving the PK twice from the same recovery key yields identical keys; the enrolled PK certificate matches; `rescue` clears PK with the re-derived key; no PK file exists on the target or in the kit.
25. Cloud seed parts: a seed whose `owners` line has a forged signature, or whose `config.statement` lacks the threshold, is refused before any disk change; a valid seed writes the floor under the `seed`-profile approval.
26. Assisted platform credential: the created signing and HMAC keys have `userWithAuth` clear and the authPolicy digest of `PolicyPCR(15) ∧ PolicyAuthValue`; a policy session satisfying only `PolicyPCR(15)` cannot sign; the blob parses as the §4.5.2a JCS object.
27. Floor re-initialisation in recovery: after a swtpm clear, the re-enrolment step re-defines `0x01300102` and writes exactly the signed release statement's `floor`; a hand-edited release statement on disk is refused (signature check); the pending receipt carries `floorHistoryReset: true`.

**Fuzz targets:** answers-file parser; TCG event log parser; LUKS2 token JSON parser; `vouch-proto` pairing messages (shared target in `vouch`).

**Acceptance:** OS conformance tests C-29 `recovery-env` and C-30 `install-fresh` (`keylos` spec §11.2) pass on all certified hardware.

---

## 12. Implementation notes

**Language:** Rust 2024.

**Crates:**
- `libcryptsetup-rs` 0.11 (LUKS2)
- `tss-esapi` 7 (TPM), with templates from `keylos-tpm-registry`
- `libfido2` through an in-repo FFI crate (`installer-fido2`), or the CTAP2 client crate shared with `hearth`
- `gpt` 4 (partitioning)
- direct efivarfs I/O (authenticated variable building in-repo)
- `goblin` 0.9 (PE/Authenticode hashing)
- `x509-cert` 0.2 and `rsa` 0.9 (owner certificates, TPM-backed signing through `tss-esapi`)
- `hkdf` 0.12, `sha2` 0.10, `aes-gcm` 0.10, `hpke` 0.12, `ed25519-dalek` 2, `x25519-dalek` 2
- `keylos-shamir` (from the `hearth` repository's published crate) for trustee cards
- `qrcode` 0.14, `printpdf` 0.7 (recovery kit)
- `argon2` 0.5, `crc` 3
- `zeroize` 1, `secrecy` 0.10
- `serde` 1, `serde_json` 1, `tokio` 1, `clap` 4
- `keylos-ids`, `keylos-formats`, `keylos-presence`, `keylos-tpm-registry`, `keylos-capwire`, `keylos-schemas`

**Repository layout:**

```
installer/
  crates/installer-core/       journal, steps, plan
  crates/installer-tpm/        NV definitions, sealing, policy digests (shared with rescue, keylos-enrol)
  crates/installer-secureboot/ event log, variable building, signing
  crates/installer-storage/    GPT, LUKS2, btrfs
  crates/installer-fido2/      registration, presence, hmac-secret
  crates/installer-migrate/
  bins/installer/  bins/installer-tui/  bins/rescue/  bins/keylos-enrol/
  ui/installer-ui/             atrium client
  data/secureboot-vendors.json  data/dbx/
  recipes/                     forge recipes for the installer image and the recovery generation
  tests/
```

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reference |
|---|---|---|
| Owner Secure Boot keys with option ROM hash allow-listing by default | Keep the Microsoft 3rd-party CA; shim only | [ADR-0013](../../handbook/11-decisions/adr-0013-owner-secure-boot-keys.md) |
| TPM2 + PIN with signed PCR11, pcrlock NV policy and floor inside the signed part | Literal PCR values; TPM-only | [ADR-0014](../../handbook/11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md) |
| Two FIDO2 credentials by default | One credential + recovery key | [ADR-0011](../../handbook/11-decisions/adr-0011-owner-presence-fido2.md) |
| Seal gate rotated through `hmac-secret` (hearth's construction), created by the installer with a self-test | `PolicySigned` (FIDO2 assertions cannot satisfy it); per-credential authorization objects | [ADR-0012](../../handbook/11-decisions/adr-0012-sealing-windows.md), protocols §11.6 |
| All TPM objects from `keylos-tpm-registry` templates | Each component defining its own objects | protocols §19.6 |
| Installer generates the machine key | `ledger` generating it at first boot | The bundle, seal self-test, config and pairing need it before first boot |
| Initial floor written through an installer-phase stream-signed authorization | Leave the floor unwritten (first unseal would fail); add an owner-write path (changes the NV Name and every policy using it) | §4.6.5 |
| No FIDO2 LUKS keyslots | FIDO2 keyslots for TPM-failure unlock | `boot` tries only the TPM token and the recovery keyslot |
| Recovery key derivations exactly as protocols §20.21, including the recovery recipient and the deterministic Secure Boot PK | Separate secrets for each; storing the PK wrapped | Fewer artifacts for the owner to keep; no PK at rest |
| Owner and endorsement hierarchy authorizations sealed for `hearth`; recovery copy encrypted to the recovery recipient | Wrapping the owner auth in the LUKS token | `hearth` can rotate it after recovery without ever holding the recovery key |
| Headless machines in quorum mode with presigned genesis | A device-local key acting as owner | One presence model (protocols §5.4) |
| Cloud seeding by a signed metadata bundle, with the image keyslot removed and the volume re-keyed | cloud-init; shipping images with per-instance keys | No unsigned input; no shared disk key survives first boot |
| Dual boot through `keepMicrosoftCAs` and the `shared-boot` integrity profile | Refusing dual boot | Honest, visible reduction instead of a hidden one |
| 24-hour delayed recovery with the recovery key alone | Immediate; or impossible without FIDO2 | Balances theft against lockout |
| AEAD integrity on LUKS2 | Plain XTS | [ADR-0020](../../handbook/11-decisions/adr-0020-btrfs-luks2-aead.md) |
| First-boot bundle consumed once, in the exact protocols format | Installer writing each service's internal database directly | Keeps service storage formats private to each service |
| No hibernation | Hibernation with a TPM-sealed key | Lockdown forbids hibernation (protocols §2) |
