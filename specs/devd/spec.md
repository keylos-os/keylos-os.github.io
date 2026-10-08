# keylos/devd: device manager, device authorization, power and hardware integration

| | |
|---|---|
| Repository | `github.com/keylos-os/devd` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | Service generation `io.keylos.devd` (binary `devd`, which includes the BlueZ adapter module `bt`); CLI `devctl`; compiled hardware database `hwdb.bin` (built at build time from upstream hwdb text data plus the pinned keylos lists for FIDO authenticators and fingerprint readers) |
| Depends on | `keylos-protocols 1.0`. Runtime services: `warden`, `broker`, `ledger`, `journal`, `hearth`, `atrium`, `compat` (the BlueZ island). Callers: `bench` and `cri` (`MediaAttach`). External: BlueZ ≥ 5.78, packaged by `pkgs` as a legacy service run by `compat` |
| Provides | `Devd` (protocols §7.3.15); `DeviceAdmin` (including USB and Thunderbolt authorization), `PowerEvents`, `Bluetooth`, `Backlight`, `MediaAttach` (protocols §7.5.8); the device capability catalogue; device-node ownership policy; power-button, lid and suspend handling; the rule that removable storage never reaches a host filesystem driver |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`devd` owns the kernel's device events and is the only process that opens raw device nodes on behalf of others. It:

1. Listens to kernel uevents, coldplugs at boot, and assigns **stable device IDs** (protocols §3.5).
2. Classifies devices with the hardware database, assigning each a **capability class**: `input`, `gpu-render`, `camera`, `audio`, `storage-removable`, `storage-backup`, `mtp`, `fido`, `fingerprint`, `serial`, `bluetooth`, `rfkill`, `sensor`, and so on.
3. **Authorizes USB, Thunderbolt/USB4 and external PCIe devices.** New devices stay unauthorized (no driver binds) until approved on the trusted path, remembered, or covered by a safe automatic rule (protocols §9.5).
4. Opens devices for principals that hold a broker-issued device token, and tells `warden` which device nodes to put into a principal's view (`DeviceAdmin.plan`).
5. Hands removable block devices, MTP endpoints and passthrough PCI devices **only** to VMs, through `MediaAttach` (`bench` media and pod VMs, `cri`). The host never mounts removable media; the one exception is a keylos backup disk, which only `strata` receives.
6. Implements power management:
   - suspend, poweroff and reboot requests;
   - the power button and lid switch;
   - battery and thermal status;
   - backlight;
   - locking all sessions and dropping key material before sleep;
   - best-effort suspend inhibition for `portal-inhibit`.
7. Provides the capwire `Bluetooth` interface, backed by BlueZ running in a `compat` D-Bus island.
8. Grants the per-human audio and camera daemon (the `pipewire` principal) the `audio` and `camera` class devices through ordinary broker device grants.

**Non-goals:**
- **Device access decisions for principals:** `broker` decides; `devd` enforces the token. (Authorizing a device to exist on the bus is `devd`'s decision, made on the trusted path.)
- **Input event routing to apps:** `atrium` owns all input devices through `libinput`.
- **Mounting filesystems:** never on the host for removable media; media VMs (`bench`) mount them; `strata` mounts keylos backup disks.
- **Firmware updates:** `courier`.
- **Network devices:** `net`.
- **Hibernation:** unsupported (protocols §2).

---

## 2. Context and embedded contracts

```
kernel ──uevent netlink──► devd ──Devd.open(id, token)──► broker ──► principal (fd)
                             │──DeviceAdmin.plan──► warden (view /dev nodes + cgroup device program)
                             │──DeviceAdmin.pending──► atrium (trusted-path prompt) ──authorize──► devd ──► sysfs authorized=1
                             │──MediaAttach.claimBlock / claimVfio──► bench (media VM, pod VM), cri
                             ├──input fds (via broker grants)──► atrium (libinput)
                             ├──audio/camera fds (via broker grants)──► pipewire principal ──restricted remotes──► portals/apps
                             └──CompatIsland.islandSocket("bluez")──► BlueZ island bus ◄─► bluetoothd (legacy service in compat)
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

### 2.2 Identifiers (protocols §3.5)

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

### 2.3 `common.capnp` and errors (protocols §7.3.1)

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

### 2.4 `devd.capnp` (protocols §7.3.15, the `devd.capnp` block; implemented)

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

### 2.5 `devd-sys.capnp` (protocols §7.5.8, implemented)

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

### 2.6 Devices, removable media and DMA (protocols §9.5)

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

### 2.7 Consumed interfaces

| Interface (protocols §) | Facet held by devd | Methods called |
|---|---|---|
| `Broker` (§7.3.3) | `broker#principal` | `inspect` (re-check of tokens passed to `open` and `plan`); `request` (Bluetooth pairing confirmation, §4.7) |
| `HearthSystem` (§7.5.3) | `hearth#system` | `prepareSuspend`, `resumed`; `owners` (owner-presence keys for verifying presence-signed device mandates, §4.9.4) |
| `PrincipalControl`, `Supervisor` (§7.5.1, §7.3.2) | `warden#admin` | `PrincipalControl.terminate` (freeze/thaw the user slices around sleep; revocation actions), `PrincipalControl.list`, `PrincipalControl.events` (auto-release of `MediaAttach` claims), `Supervisor.control("_system", poweroff \| reboot)` |
| `FdStore` (§7.5.1) | `warden#service` | Revocation bookkeeping and claimed device fds across `devd` restarts |
| `CompatIsland` (§7.5.15) | `compat#adapter` | `islandSocket("bluez")` |
| `TrustedPrompt` (§7.3.4) | `atrium#notify` | `notify` |
| `Ledger` (§7.3.5) | `ledger#writer` (includes `reader`) | `append`; `serviceKey("broker")` (the `service/broker` key for verifying device mandates, §4.9.4) |

#### 2.7.1 `broker.capnp` (protocols §7.3.3)

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

#### 2.7.2 `hearth-sys.capnp` (protocols §7.5.3)

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

#### 2.7.3 `warden.capnp` and `warden-sys.capnp` (protocols §7.3.2, §7.5.1)

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

#### 2.7.4 `compat-sys.capnp` (protocols §7.5.15)

```capnp
@0xc7a1e5d3b2f4002e;
using C = import "common.capnp";

interface CompatIsland {           # facet adapter (devd Bluetooth adapter, portal-print CUPS adapter, vault import island)
  islandSocket @0 (service :Text) -> (socket :C.Fd);
      #! connected socket to the island; the protocol depends on the island: "bluez", "cups-dbus" → filtered D-Bus proxy;
      #! "sane" → SANE network protocol (saned) stream; "cups" → IPP over HTTP/1.1; "secret-import" → filtered D-Bus proxy
}
```

#### 2.7.5 `prompt.capnp` (protocols §7.3.4)

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

#### 2.7.6 `ledger.capnp` (protocols §7.3.5)

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

### 2.8 Capability tokens (protocols §8.2, §8.4)

Device grants use `right("device", "<device id or pattern>", "use")`. Patterns are `dev:<subsystem>:*` or `class:<capability class>` (§4.3).

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

- Revoking a root ID invalidates every token derived from it, including tokens whose `budget_parent` names it. Revocations are in-memory and persisted until the next reboot, when keys rotate anyway.
- **Workflow revocation is durable.** Cancelling or revoking a workflow (`BrokerWorkflow.cancel`, §20.25) writes a persistent cancellation record in the broker, revokes every root carrying that workflow's `workflow` fact, and makes every later claim and attempt registration of the workflow fail, across restarts and reboots; it is not undone by the per-boot key rotation.
- The broker MUST check revocation on every `materialize`, and `gate` on every `connect`, `stage` and `charge`.
- **Already-materialized fds cannot be pulled back from a process.** Revoking therefore also terminates or freezes holders through `PrincipalControl.terminate` (§7.5.1), according to the grant record's `onRevoke`: `kill` (default for agents) or `freeze` (default for apps; the user decides). Attached grant mounts are detached (`GrantMounts.detachGrant`).

### 2.9 Mandates (protocols §14.4)

The trusted-path decision that authorizes a device arrives as a mandate envelope that `atrium` obtained from `broker` through `BrokerSystem.requestFor` (resource `device`). It is either presence-signed or re-signed by `service/broker`; `devd` verifies exactly those two key kinds and never an approver key (§4.9.4).

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

### 2.10 Receipts (protocols §13.1, §19.3)

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
| `device.grant`, `device.authorize`, `device.deauthorize` | devd |

**Extension rule.** A repository MAY emit additional events named `x-<repo>.<event>` (for example `x-strata.replica.send`). They MUST be listed in that repository's spec, MUST be written only by that repository's services, and carry no semantics for other components. Events named without a prefix MUST appear in this table.

`devd` writes the core events `device.grant`, `device.authorize`, `device.deauthorize`, plus the repository events `x-devd.claim` and `x-devd.release` (§9).

### 2.11 Facets (protocols §19.2, `devd` rows)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| devd | `client` | every principal | `list`, `watch` (filtered); `PowerEvents.subscribe` |
| devd | `broker` | broker | `open`; `DeviceAdmin` |
| devd | `warden` | warden | `DeviceAdmin` |
| devd | `service` | hearth, strata, atrium, portal-inhibit | `PowerEvents` (subscribe + ack) |
| devd | `atrium` | atrium | `Backlight` |
| devd | `authorize` | atrium | `DeviceAdmin.authorize`, `deauthorize`, `pending` |
| devd | `bench` | bench | `MediaAttach` |
| devd | `cri` | cri | `MediaAttach` |
| devd | `admin` | atrium settings, owner `shell` | all incl. `power`; `Bluetooth` |

### 2.12 Files read from other repositories

`devd` reads exactly the cross-repository files listed for it in protocols §10.7:

| Path | Format | Writer | Readers |
|---|---|---|---|
| `/var/lib/keylos/devd/preauthorized.json` | `keylos.preauth/1` (§9.5) | installer | devd |

The format of `/var/lib/keylos/devd/preauthorized.json` (`keylos.preauth/1`) is defined in protocols §9.5 (embedded in §2.6). Its configuration arrives as the rendered file `/etc/devd/devd.toml`, whose format this spec defines (§10) and which `config` renders from the `devices` module, under the per-service file rule:

**Per-service configuration files.** `/etc/keylos/<service>.json` and `/etc/<service>/*` are rendered by `config` and read only by that service; they need no row here, and their formats are defined in the service's own spec.

---

## 3. Requirements

### 3.1 Device database

- **REQ-DEVD-001** `devd` MUST subscribe to `NETLINK_KOBJECT_UEVENT` (group 1, kernel events only) before coldplug. It MUST coldplug by walking `/sys/devices` and synthesising `add` events. Uevents from userspace senders (group 2) MUST be ignored.
- **REQ-DEVD-002** Each device node MUST receive a stable ID per protocols §3.5. The stable path comes from the `ID_PATH` algorithm (bus topology: PCI address, USB port chain, platform path). USB devices with serial numbers MUST also carry `ID_SERIAL` as a property, and policy MAY match on it.
- **REQ-DEVD-003** Every device node under `/dev` MUST be owned by UID 0, GID 0, mode 0600, except `null`, `zero`, `full`, `random`, `urandom`, `tty` and `ptmx` (0666). No group-based device access exists: there are no `video`, `audio` or `input` groups.
- **REQ-DEVD-004** `devd` MUST classify every device into exactly one capability class (§4.3). Unclassified devices get class `other` and can be granted only to tier-0 services whose service-set entry lists them.
- **REQ-DEVD-005** The hardware database MUST be compiled at build time from the upstream hwdb text sources and the keylos lists (FIDO authenticators, fingerprint readers), all pinned by `src:` digest. There is no runtime hwdb compilation.

### 3.2 Opening, planning and granting

- **REQ-DEVD-010** `Devd.open(id, token, flags)` MUST be served only on facet `broker`. The token is the requesting principal's token. `devd` MUST re-check it with `Broker.inspect`, and the token MUST:
  - contain `right("device", P, "use")` where P matches the device;
  - not be expired or revoked.
- **REQ-DEVD-011** The only flags allowed in `open` are `O_RDONLY`, `O_WRONLY`, `O_RDWR`, `O_NONBLOCK` and `O_CLOEXEC`. `O_PATH` is forbidden; everything else is masked.
- **REQ-DEVD-012** `DeviceAdmin.plan(principal, tokens)` MUST return the `NodePlan` of every device that the tokens grant to that principal and that is path-accessed (GPU render nodes, `/dev/snd/*`, granted serial and hidraw nodes). Each token's `principal` fact must equal `principal`. `warden` uses the plan to create view nodes and the cgroup device program.
- **REQ-DEVD-013** Class `input` devices (evdev) MUST be planned or opened only for the `atrium` principal, and only for devices whose USB ancestor is **input-approved** (§4.9.5). Exception: class `input-dedicated` devices (game controllers and drawing tablets, marked by hwdb `ID_INPUT_JOYSTICK=1` or `ID_INPUT_TABLET_PAD=1`) MAY be granted to apps; the minimum approval tier is T2.
- **REQ-DEVD-014** Class `fido` devices (hidraw with FIDO usage page `0xF1D0`) are granted to `hearth` by default. Apps (browsers) MAY receive a FIDO device per session; the minimum approval tier is T2, and each request names the device and the app on the trusted path.
- **REQ-DEVD-015** Every successful `open` or `plan` entry for a principal that is not tier 0 MUST write a `device.grant` receipt.
- **REQ-DEVD-016** Device removal and revocation:
  - On device removal, `devd` MUST notify watchers. Open fds become invalid by kernel semantics (`ENODEV`).
  - On token revocation, `broker` calls `DeviceAdmin.revoke(rootId)`. `devd` MUST then revoke the open fds it handed out under that root:
    - evdev: `EVIOCREVOKE`;
    - hidraw and usbfs: device unbind/rebind is not used. Instead `devd` calls `PrincipalControl.terminate(session, mode)` with the grant's `onRevoke` mode (protocols §8.4), because those fds cannot be revoked in place.
- **REQ-DEVD-017** Classes `storage-removable`, `mtp`, `optical` and `storage-fixed` MUST NOT be opened or planned through `Devd.open`/`DeviceAdmin.plan` for any principal, whatever tokens it holds. They reach VMs only through `MediaAttach` (§4.11). Class `storage-backup` is opened or planned only for the `strata` service.

### 3.3 Power

- **REQ-DEVD-020** `power("suspend")` MUST, in order:
  1. emit `PowerEvent.preSleep("suspend:<reason>")` to `PowerEvents` subscribers, with `<reason>` ∈ `user`, `power-button`, `lid`, `idle`, `battery`;
  2. call `HearthSystem.prepareSuspend()`, which returns within 2 s. `hearth` locks every human session and causes key material to be dropped;
  3. wait for `PowerEvents.ack("suspend")` from the core `service`-facet subscribers (`hearth`, `strata`, `atrium`), with a 3 s timeout, after which suspend proceeds and a warning is logged; inhibitor handling is REQ-DEVD-026;
  4. freeze every `user-*.slice` and `guest-*.slice` session through `PrincipalControl.terminate(session, freeze)`;
  5. write `mem` to `/sys/power/state`, with `mem_sleep` set to `s2idle` or `deep` per config.
- **REQ-DEVD-021** `power("hibernate")` MUST fail with `kl:unsupported` (protocols §2).
- **REQ-DEVD-022** `power("poweroff")` and `power("reboot")` MUST be forwarded to `warden` as `Supervisor.control("_system", poweroff)` and `Supervisor.control("_system", reboot)` respectively (protocols §7.3.2, §19.1). `devd` does not shut down itself.
- **REQ-DEVD-023** Power button and lid:
  - a short press of the power button triggers `suspend` by default (configurable to `poweroff`, `ignore`, or `ask`, which shows an `atrium` dialog); a long press of ≥ 4 s is handled by firmware;
  - lid close triggers `suspend`, unless an external display is connected and `lidCloseDocked = 'ignore`.
- **REQ-DEVD-024** Critical battery (≤ `criticalBattery.percent` and discharging) MUST trigger `poweroff` after a 60 s critical notification. Inhibitors are ignored.
- **REQ-DEVD-025** `power` may be called on facet `admin` only: the owner's `shell` and `atrium` settings (protocols §19.2). Agents never hold it.
- **REQ-DEVD-026** Inhibitors. `portal-inhibit` holds the `service` facet and acknowledges `preSleep` late while an app holds a `suspend` or `lid` inhibition (protocols §7.5.18 `InhibitHost`). `devd` waits for `portal-inhibit`'s ack only for reasons `lid` and `idle`, for at most `inhibitMaxDelaySecs` (default 30, at most 120); for `user`, `power-button` and `battery` it does not wait for `portal-inhibit` at all. Inhibition is therefore a bounded delay, never a veto.

### 3.4 Bluetooth and audio

- **REQ-DEVD-030** BlueZ:
  - `bluetoothd` MUST run only as a `compat` legacy service inside its own D-Bus island (`compat` defines the island);
  - `devd` is the only adapter: it obtains the island bus socket with `CompatIsland.islandSocket("bluez")`;
  - no other principal reaches BlueZ's D-Bus API;
  - pairing MUST be confirmed through a broker approval rendered on the trusted path (§4.7); agents cannot pair, because `Bluetooth` is served only on facet `admin`.
- **REQ-DEVD-031** The per-human `pipewire` principal (owned by `portals`) receives the `audio` and `camera` class devices of the seat through broker device grants and `DeviceAdmin.plan`, like any other principal. Apps reach audio and cameras only through restricted PipeWire remotes created by `portals`.

### 3.5 USB authorization

- **REQ-DEVD-040** Before coldplug completes, `devd` MUST write `0` to `authorized_default` of every USB root hub (`/sys/bus/usb/devices/usb*/authorized_default`) and keep doing so for root hubs that appear later. New devices therefore stay unauthorized: the kernel reads their descriptors but binds no driver.
- **REQ-DEVD-041** At start (after `switch_root`), `devd` MUST re-evaluate every USB device that is already authorized. Before `devd` runs, the kernel command line `usbcore.authorized_default=2` authorizes only devices on internal, hard-wired ports, and the initrd's authorizer (`boot`) additionally authorizes external hubs and all-HID devices for the PIN, VBU and recovery prompts (protocols §9.5). An external device that is neither covered by a rule of REQ-DEVD-043 nor listed in `preauthorized.json` MUST be de-authorized (`authorized = 0`) and reported as pending. The re-evaluation MUST complete before `devd` reports ready to `warden`, so no human session starts while an initrd-authorized external device is still bound.
- **REQ-DEVD-042** For each unauthorized device `devd` MUST build a `PendingDevice` (protocols §7.5.8) from sysfs: `idVendor`, `idProduct`, `serial`, the port path, the descriptor strings (rendered as untrusted text), and the interface classes parsed from the raw `descriptors` attribute (§4.9.2). It MUST deliver it to every `DeviceAdmin.pending` watcher (facet `authorize`, held by `atrium`).
- **REQ-DEVD-043** Automatic authorization is allowed only for:
  1. **Remembered identities**: an approval persisted with `persist = true` whose identity (vendor, product, serial, port; port mandatory when the serial is empty) matches exactly;
  2. **Hubs**: devices whose interfaces are all hub class (`0x09`);
  3. **Internal devices**: devices on a port whose `connect_type` is `hardwired` (or `fixed` with `removable = fixed`), when `autoAuthorizeInternal` is true (default);
  4. **Class rules**: devices with **no** HID interface whose every interface class is listed in `devices.autoAuthorize` (protocols §9.5); classes `hid`, `net` and `mass-storage` are never in the default list, and `hid` can never be listed;
  5. **Pre-authorized at installation**: devices whose identity matches an entry of `/var/lib/keylos/devd/preauthorized.json` (`keylos.preauth/1`, written by the installer: the input devices present during installation; protocols §9.5), when their interface classes are a subset of the entry's `classes`. They are authorized, input-approved, and persisted as `preauthorized` on first match.
  Everything else MUST wait for a trusted-path approval.
- **REQ-DEVD-044** `DeviceAdmin.authorize(device, persist, decisionEnvelope)` MUST be served only on facet `authorize`. It MUST verify the decision envelope (§4.9.4): a DSSE `keylos.mandate/1` signed either by an owner-presence key from `HearthSystem.owners` or by the `service/broker` key from `Ledger.serviceKey("broker")`; any other signer, including an approver key, MUST be refused with `kl:integrity`. Then it writes `1` to the device's `authorized` attribute, persists the identity when `persist` is true, and writes a `device.authorize` receipt carrying the mandate digest and the signer kind (`presence` or `broker`).
- **REQ-DEVD-048** `preauthorized.json` MUST be parsed strictly (`keylos.preauth/1`, vendor and product as 4 lowercase hex digits, unknown fields refused). A malformed or unreadable file MUST be treated as empty and reported (`devctl status`, critical notification), never as "authorize all". Entries are consumed once: after a device matches, its identity moves to the authorization store as `preauthorized`, and later changes to the file have no effect on it.
- **REQ-DEVD-049** `devd` MUST refresh the `service/broker` key with `Ledger.serviceKey` at start and whenever verification fails with an unknown key ID (key rotation), at most once per 10 s, and MUST refresh the owner set with `HearthSystem.owners` on every `authorize` call that carries a presence signature (owners change rarely; the call is cheap).
- **REQ-DEVD-045** HID safety. A device whose `hidSafety` is `keyboard-like` MUST only be authorized with a decision envelope whose `constraints.confirmedWith` names an input device that is already authorized and input-approved, and that is not the device being authorized. After authorization, the device's evdev nodes are input-approved (§4.9.5). Until approval, the device has no driver, so its keystrokes do not exist.
- **REQ-DEVD-046** `DeviceAdmin.deauthorize(device, forget)` MUST write `0` to `authorized` (the kernel unbinds every driver), revoke the device's outstanding grants (REQ-DEVD-016), release any `MediaAttach` claim on it, and with `forget = true` delete the persisted identity. Receipt `device.deauthorize`.
- **REQ-DEVD-047** An approval that is not persisted lasts until the device is unplugged.

### 3.6 Thunderbolt, USB4 and external PCIe

- **REQ-DEVD-050** `devd` MUST read every Thunderbolt/USB4 domain's `security` level at start. Levels `user` and `secure` are gated by `devd`. Levels `dponly`, `usbonly` and `nopcie` tunnel no PCIe and need no gate. Level `none` cannot be gated; `devd` MUST report it in `devctl status` and through a critical notification at every boot, and it relies on the IOMMU alone.
- **REQ-DEVD-051** A Thunderbolt device MUST be authorized only after a trusted-path approval (or a remembered `unique_id`), and only if the domain's `iommu_dma_protection` is `1` and the kernel IOMMU is active. Otherwise `authorize` fails with `kl:unsupported` and the device stays unauthorized (protocols §9.5).
- **REQ-DEVD-052** On `secure` domains `devd` MUST use challenge-response: at first approval it writes a fresh 32-byte random key to the device's `key` attribute and `1` to `authorized`; on later connections of a remembered device it writes the stored key and `2`. A failed challenge leaves the device unauthorized and raises a critical notification ("device identity changed").

### 3.7 Removable storage and `MediaAttach`

- **REQ-DEVD-060** `MediaAttach.claimBlock(device, readOnly)` MUST be served only on facets `bench` and `cri`, and only for:
  - an **authorized** device of class `storage-removable`, `optical` or `mtp` (facet `bench`); or
  - a block device listed in `devices.passthrough` (facet `cri`, and facet `bench` for pod VMs).
- **REQ-DEVD-061** `claimBlock` MUST open the whole device exclusively (`O_EXCL` for block devices), set it read-only with `BLKROSET` when `readOnly` is true, and return the fd with `info` JSON `{sizeBytes, model, removable, partitions, kind}` (`kind` ∈ `block`, `optical`, `mtp`). For MTP devices the fd is the usbfs node `/dev/bus/usb/BBB/DDD`, for passthrough into the media VM.
- **REQ-DEVD-062** Exactly one claim per device. A claim is released by `release`, by device removal, by the claimant's connection closing, or by the exit of the claimant principal's session (`PrincipalControl.events(watcher, replay = true)`; after a `devd` restart, claims restored from `FdStore` whose session is absent from the replayed set are released at once). `x-devd.claim` and `x-devd.release` receipts are written.
- **REQ-DEVD-063** `storage-backup` detection: a removable block device whose LUKS2 header carries a token of type `keylos-backup` (§4.11.2) is classified `storage-backup`. `devd` performs no cryptography; `strata` verifies the token against the machine's backup key before unlocking (protocols §9.5).

### 3.8 VFIO passthrough

- **REQ-DEVD-070** `MediaAttach.claimVfio(pciAddress)` MUST refuse with `kl:denied` unless the device is listed in `devices.passthrough`, and with `kl:conflict` unless every member of its IOMMU group is listed, is a PCIe bridge or root port, or is already bound to `vfio-pci`.
- **REQ-DEVD-071** It MUST refuse the primary display GPU (`boot_vga = 1`, or the card `atrium` drives) unless `devices.passthroughAllowPrimary` is true.
- **REQ-DEVD-072** On claim, `devd` unbinds the host driver, sets `driver_override = vfio-pci`, triggers `drivers_probe`, and returns the group fd (`/dev/vfio/<group>`) and the device cdev fd (`/dev/vfio/devices/vfioN`, `CONFIG_VFIO_DEVICE_CDEV`). On release it clears `driver_override` and re-probes the host driver.

### 3.9 Fingerprint readers

- **REQ-DEVD-075** Class `fingerprint` devices (hwdb `ID_KEYLOS_FINGERPRINT=1`) MUST be grantable only to `hearth`, which may use them to unlock the screen lock only. They never satisfy presence and never unlock the disk (protocols §9.5).

---

## 4. Design

### 4.1 Processes

| Process | Tier | Purpose |
|---|---|---|
| `devd` | t0 | uevents, database, authorization, open, plan, media claims, VFIO, power, backlight, sensors, the Bluetooth adapter module |
| `bluetoothd` (BlueZ) | legacy service, run by `compat` | The Bluetooth host stack inside the `bluez` island |

### 4.2 Event pipeline

```
uevent socket ─► parse (KEY=VALUE\0…) ─► enrich (sysfs attrs, hwdb lookup, ID_PATH, ID_SERIAL, connect_type)
             ─► authorization gate (USB/Thunderbolt: §4.9, §4.10)
             ─► classify ─► database update (in-memory, with /run/keylos/devd/db.json snapshot)
             ─► actions: fix host /dev node owner/mode 0600 (devtmpfs creates nodes)
                        notify watchers (Devd.watch, DeviceAdmin.pending)
```

- `devd` runs no helper programs on events (there is no udev `RUN`).
- Firmware loading is done by the kernel directly from the OS generation's `/usr/lib/firmware`, which the `kl-exec` `kernel_read_file` hook permits (protocols §9.3).
- Plans are pull-only. `warden` calls `DeviceAdmin.plan` at spawn. A device that appears later reaches a running principal only through `Broker.materialize` (an fd).

### 4.3 Capability classes

| Class | Match (first match wins) | Default holders | Minimum tier for apps |
|---|---|---|---|
| `input` | `SUBSYSTEM=input`, `ID_INPUT_KEYBOARD\|MOUSE\|TOUCHPAD\|TOUCHSCREEN=1` | atrium (input-approved devices only) | never |
| `input-dedicated` | `ID_INPUT_JOYSTICK=1` or `ID_INPUT_TABLET_PAD=1` | atrium | T2 |
| `gpu-render` | `SUBSYSTEM=drm`, `DEVNAME=dri/renderD*` | atrium, bench (VMM device backends) | install consent (manifest `needs.gpu = "render"`) |
| `gpu-card` | `SUBSYSTEM=drm`, `DEVNAME=dri/card*` | atrium only | never |
| `camera` | `SUBSYSTEM=video4linux`, `ID_V4L_CAPABILITIES=:capture:` | pipewire (per human) | via portals only |
| `audio` | `SUBSYSTEM=sound` | pipewire (per human) | via portals only |
| `fido` | `SUBSYSTEM=hidraw`, HID report descriptor usage page `0xF1D0` | hearth | T2 per session |
| `fingerprint` | USB device with hwdb `ID_KEYLOS_FINGERPRINT=1` (usbfs node) | hearth (screen unlock only) | never |
| `hid-generic` | `SUBSYSTEM=hidraw` (not FIDO) | none | T2 |
| `usb-generic` | `SUBSYSTEM=usb`, `DEVTYPE=usb_device` (usbfs node) | none | T2 |
| `serial` | `SUBSYSTEM=tty`, `ID_BUS=usb`, or `DEVNAME=ttyS*` with a real UART | none | T2 |
| `mtp` | USB device with an interface `06/01/01` (PTP/MTP) or hwdb `ID_MTP_DEVICE=1` | none on the host; `MediaAttach` (bench) | never (media VM only) |
| `storage-backup` | `SUBSYSTEM=block`, removable, LUKS2 header with a `keylos-backup` token (§4.11.2) | strata | never |
| `storage-removable` | `SUBSYSTEM=block`, `ID_BUS=usb`, `ID_BUS=mmc`/`DEVTYPE=disk` on an SD reader, or `removable=1` | none on the host; `MediaAttach` (bench) | never (media VM only) |
| `optical` | `SUBSYSTEM=block`, `DEVNAME=sr*` | none on the host; `MediaAttach` (bench) | never (media VM only) |
| `storage-fixed` | `SUBSYSTEM=block`, otherwise | none (strata reaches the root volume through `warden`'s mounts); `MediaAttach` (cri) when listed in `devices.passthrough` | never |
| `bluetooth` | `SUBSYSTEM=bluetooth` | the `bluez` legacy service | never |
| `rfkill` | `/dev/rfkill` | devd, net | never |
| `kvm` | `/dev/kvm` | bench | never |
| `vfio` | `/dev/vfio/*` | none (handed out only by `claimVfio`) | never |
| `tpm` | `/dev/tpmrm0` | vault, hearth, ledger, courier, strata, config, vouch, fleet, cri | never |
| `sensor` | `SUBSYSTEM=iio` | devd (exposes orientation and ambient light as events) | never |
| `backlight` | `SUBSYSTEM=backlight` (sysfs only) | devd | never |
| `printer-usb` | `SUBSYSTEM=usbmisc`, `ID_USB_INTERFACES=:0701*:` | the print island (portals) | never |
| `scanner-usb` | USB device with hwdb `libsane_matched=yes` | the SANE island (portal-scan) | never |
| `other` | — | tier 0 by explicit service-set entry only | never |

The last column is the minimum approval tier that broker policy uses when such a grant is requested for an app. Policy can forbid, never lower. "Default holders" are granted by the distribution's default policy and service set. Every USB and Thunderbolt device in this table exists only after it was authorized (§4.9, §4.10).

### 4.4 Stable IDs and names

- `ID_PATH` follows the systemd path_id algorithm:
  - PCI: `pci-<domain:bus:dev.fn>`;
  - USB: `usb-<bus>:<port chain>:<config>.<interface>`;
  - platform: `platform-<name>`;
  - Thunderbolt: `thunderbolt-<domain>-<route>`.
- The device ID is `dev:<subsystem>:<ID_PATH>[-<suffix>]`. The suffix disambiguates multiple nodes of one parent, for example `-render`, `-card`, `-event3`.
- The canonical node name is `DEVNAME` from the uevent (for example `dri/renderD128`). `warden` reproduces it in views.
- The **authorization identity** of a USB device is `(idVendor, idProduct, serial, port)`, where `port` is the physical port chain (`1-3.2`). A Thunderbolt device's identity is its `unique_id`.

### 4.5 Open and plan paths

**`open`:**
1. Check the facet is `broker`.
2. `Broker.inspect(token)`. Match `right("device", P, "use")`, where P equals the device ID, the pattern `dev:<subsystem>:*`, or `class:<class>`.
3. Check the class against §4.3 and the principal kind (REQ-DEVD-013/014/017/075).
4. `openat(devfd, DEVNAME, flags | O_CLOEXEC | O_NOCTTY)`.
5. For class `input-dedicated`, grab exclusively through `atrium` coordination: `atrium` stops reading that device while the app holds it.
6. Return the fd. Record `(root_id, device, principal, fd kind)` in the grant table used for revocation.

**`plan`:**
1. Inspect each token as above.
2. Collect the matching path-accessed devices, excluding the classes of REQ-DEVD-017.
3. Return `NodePlan` entries: stable ID, canonical name, kind, major, minor.
4. Record them in the grant table.

### 4.6 Power and session locking

```
power(op) ─► facet admin ─► PowerEvent.preSleep("suspend:<reason>") to subscribers
          ─► HearthSystem.prepareSuspend() ─► await PowerEvents.ack from hearth, strata, atrium (3 s)
          ─► [reason lid|idle] await portal-inhibit ack (≤ inhibitMaxDelaySecs)
          ─► PrincipalControl.terminate(<each user and guest session>, freeze)
          ─► write /sys/power/state ─► (resume) ─► terminate(…, thaw) ─► HearthSystem.resumed()
          ─► PowerEvent.postResume(op) ─► atrium shows the lock screen
```

- `bench` reacts to `preSleep` (as a `client`-facet subscriber) by pausing VMs. `net` re-checks links on `postResume`.
- `vault` drops unwrapped keys when `hearth` locks the humans.
- Idle suspend is requested by `atrium` settings (facet `admin`) with reason `idle`; the lid switch and power button are handled inside `devd` (reasons `lid`, `power-button`).

#### 4.6.1 Battery and thermal

- `/sys/class/power_supply/*` is polled every 30 s, or on uevent.
- Status is published through `Devd.watch("power_supply")` and `PowerEvent.battery` (a JCS `{percent, status, timeToEmptySecs}`).
- Critical battery: REQ-DEVD-024.

#### 4.6.2 Shutdown requests

`warden` serves the pseudo-service name `_system` (protocols §19.1) for `Supervisor.control`: op `poweroff` powers off and op `reboot` reboots. `devd` calls them on its `warden#admin` facet. `_system` cannot collide with real service names, because service names start with `[a-z]` (protocols §3.3).

### 4.7 Bluetooth (adapter module `bt`)

| Element | Detail |
|---|---|
| Island | `compat` runs `bluetoothd` as a legacy service with its own private bus (the `bluez` island). Its devices (the `bluetooth` class plus `rfkill`) and its socket family `AF_BLUETOOTH` are granted to that legacy service by the distribution's service set and policy. USB Bluetooth controllers are internal on most machines and authorized by REQ-DEVD-043 rule 3; external dongles need a trusted-path approval like any device |
| Adapter | `devd`'s `bt` module obtains the island bus socket with `CompatIsland.islandSocket("bluez")`. It speaks the BlueZ D-Bus API (`org.bluez.Adapter1`, `Device1`, `AgentManager1`, `Battery1`) through `zbus` over that socket |
| Interface | `Bluetooth` (protocols §7.5.8) on facet `admin` |
| Pairing | The module registers a BlueZ `Agent1`. On `RequestConfirmation`/`DisplayPasskey`/`RequestPasskey`, it calls `Broker.request` for resource `device: "dev:bluetooth:<address>"`, right `use`, with a reason naming the device, the passkey and the profiles it offers ("keyboard", "audio", …). The default policy annotates this with `@tier("t2")`, so broker renders it on the trusted path. Approved means confirm; anything else means reject. A Bluetooth keyboard is input-approved only by this pairing decision |
| Audio | BlueZ exposes `MediaEndpoint1` to PipeWire. The `pipewire` principal gets a second filtered connection to the island through `compat` (the island proxy allows only the `org.bluez.Media1`, `MediaTransport1` and `MediaEndpoint1` paths); `compat` and `portals` define that route |
| HID over GATT | Input devices appear as uhid/evdev and are handled like other `input` devices (atrium) |

### 4.8 Backlight and sensors

- **Backlight.** `Backlight.set(device, permille)` writes `/sys/class/backlight/<dev>/brightness` scaled to `max_brightness`. It is served only on facet `atrium`.
- **Sensors.** IIO accelerometer orientation and ambient light are read in `devd` and published as `PowerEvent.sensor`, a JCS `{kind, value}`.

### 4.9 USB authorization

#### 4.9.1 State machine

```
            add uevent (authorized=0)
                    │
                    ▼
   ┌──────────── Pending ──────────────┐
   │   auto rule (REQ-DEVD-043)        │ authorize(decision)            deauthorize / unplug
   ▼                                   ▼                                       │
Authorized(mode=remembered|hub|internal|class|preauthorized)   Authorized(mode=manual) ──┘
   │                                                       │
   └──────────── driver binds; classify interfaces ────────┘
                    │
       HID evdev nodes ─► input-approved? (§4.9.5) ─► planned/opened for atrium
```

Pending devices are kept in memory with their `PendingDevice` record and delivered to new `pending` watchers on subscription. A pending device that is unplugged is dropped.

#### 4.9.2 Descriptor parsing

The kernel reads the device and configuration descriptors before authorization and exposes them in the binary sysfs attribute `descriptors` (device descriptor followed by every configuration descriptor). `devd` parses it with a bounded parser:
- device descriptor: 18 bytes, `bDescriptorType = 1`;
- each configuration: `wTotalLength` bounds the walk; each sub-descriptor needs `bLength ≥ 2` and fits inside the bound; interface descriptors (`bDescriptorType = 4`, `bLength = 9`) contribute `(bInterfaceClass, bInterfaceSubClass, bInterfaceProtocol)`;
- at most 8 configurations and 256 interfaces; anything else is a parse error, which makes the device pending with `classes = ["unparseable"]`.

Class mapping for `PendingDevice.classes`:

| Interface class | Name |
|---|---|
| `0x01` | `audio` |
| `0x02`, `0x0a` with CDC-ACM | `serial` |
| `0x02`, `0x0a` with ECM/NCM/EEM, `0xe0/01/03` (RNDIS) | `net` |
| `0x03` | `hid` |
| `0x06/01/01` | `mtp` |
| `0x07` | `printer` |
| `0x08` | `mass-storage` |
| `0x09` | `hub` |
| `0x0b` | `smartcard` |
| `0x0e` | `video` |
| `0xe0/01/01` | `bluetooth` |
| `0xff` | `vendor` |
| other | `other-<hex>` |

The hwdb adds `fido` to `classes` when `(idVendor, idProduct)` is on the pinned FIDO authenticator list, and `fingerprint` when it is on the fingerprint list. These hints only affect rendering and class rules; they never bypass HID safety.

`hidSafety` is `keyboard-like` if any interface has class `0x03`, else `none`. A HID report descriptor (which would distinguish a FIDO key from a keyboard) is unavailable before a driver binds, so every HID interface is treated as a potential keyboard.

#### 4.9.3 Automatic rules

Evaluated in order at every add event and at start (REQ-DEVD-041):

1. Identity matches a persisted approval → authorize (`mode = remembered`).
2. All interfaces are `hub` → authorize (`hub`). Devices behind the hub are new devices and are gated individually.
3. The port's `connect_type` is `hardwired`, or `fixed` with `removable = fixed`, and `autoAuthorizeInternal` → authorize (`internal`).
4. No `hid` class and every class ∈ `devices.autoAuthorize` → authorize (`class`).
5. Identity matches an entry of `preauthorized.json` and classes ⊆ the entry's `classes` → authorize and persist (`preauthorized`), input-approved.
6. Otherwise → pending.

Rule 4 never applies to a device with a HID interface, so an audio headset with volume buttons, or a FIDO key with a keyboard OTP interface, always needs one approval. With "remember", that is a one-time cost per device.

#### 4.9.4 Decision envelopes

`atrium` shows the pending device on the trusted path, renders its descriptor strings as untrusted text, and for `keyboard-like` devices requires the confirming click or key press to come from an already-authorized, input-approved device. It requests the decision from `broker` with `BrokerSystem.requestFor` (resource `device`, `rights = [use]`, the `PendingDevice` digest and the constraints in the request), receives the mandate in `GrantResult.mandate` (presence-signed as is, or re-signed by `service/broker`, protocols §14.4), and calls `authorize(device, persist, decisionEnvelope)` with it. The mandate payload is:

```json
{"schema":"keylos.mandate/1","approval":"a-…","principal":"shell@alice/s-…","tier":"t2",
 "effects":[{"kind":"device.authorize","target":"dev:usb:pci-0000:00:14.0-usb-0:3.2",
             "digest":"sha256:<SHA-256 of the JCS PendingDevice record>"}],
 "scope":"once","constraints":{"persist":true,"confirmedWith":"dev:input:platform-i8042-serio-0-event0","expires":"…"},
 "decidedBy":"alice","presence":false,"channel":"local"}
```

`devd` checks:
1. the call arrives on facet `authorize` (held only by `atrium`, protocols §19.2), **and** the DSSE envelope verifies under exactly one of: an owner-presence credential from `HearthSystem.owners` (`alg` `fido2-es256` / `fido2-eddsa`, protocols §5.3, with `presence: true` in the payload), or the current `service/broker` key from `Ledger.serviceKey("broker")` (`ed25519`, with `presence: false`). Approver keys are never accepted;
2. the payload is JCS-canonical `keylos.mandate/1` with exactly one effect of kind `device.authorize` whose `target` is `device` and whose `digest` matches the device's current `PendingDevice` record (a different device on the same port gets a different digest);
3. `constraints.expires` is in the future (trusted time) and `constraints.persist` equals `persist`;
4. for `keyboard-like` devices, `constraints.confirmedWith` names an authorized, input-approved input device other than `device`.

The envelope digest and the signer kind are recorded in the `device.authorize` receipt. Because `broker` verified the channel's decision signature before re-signing, `devd` needs neither the atrium approver key nor the phone key.

#### 4.9.5 Input approval

`devd` keeps an `inputApproved` flag per authorized USB device: true for modes `manual` with HID safety satisfied, `remembered` (if the remembered approval was input-approved), `internal` and `preauthorized`; false for `hub` and `class`. An `input` class evdev node is planned or opened for `atrium` only if its USB ancestor is input-approved. Bluetooth HID devices are input-approved by their pairing decision; platform devices (i8042, I²C touchpads) are always input-approved.

#### 4.9.6 Authorization store

`/var/lib/keylos/devd/authorized.json` (mode 0600, rewritten atomically):

```json
{"schema":"keylos.devd.authorized/1",
 "usb":[{"vendor":"046d","product":"c52b","serial":"","port":"1-3.2","classes":["hid"],"inputApproved":true,
         "mode":"manual","approval":"a-…","added":"…"}],
 "thunderbolt":[{"uniqueId":"…","name":"…","added":"…","approval":"a-…"}]}
```

Thunderbolt challenge keys are kept separately in `/var/lib/keylos/devd/tb-keys.json` (mode 0600; on the encrypted root volume). The store is created at the end of the first coldplug. Rule 5 depends only on `preauthorized.json`, never on the store's absence, so deleting the store does not re-open a first-boot window.

### 4.10 Thunderbolt, USB4 and external PCIe

- At start `devd` reads `/sys/bus/thunderbolt/devices/domain*/security` and `iommu_dma_protection`, and checks that `/sys/class/iommu/` is non-empty.
- New devices (`/sys/bus/thunderbolt/devices/<domain>-<route>`) appear with `authorized = 0` on `user`/`secure` domains. `devd` builds a `PendingDevice` with `bus = "thunderbolt"`, `serial = unique_id`, `port = <domain>-<route>`, `classes = ["pcie-tunnel"]`, and the vendor and device names as untrusted strings.
- Authorization (REQ-DEVD-051/052) then lets PCIe devices behind the tunnel enumerate; their drivers bind with DMA confined by the IOMMU.
- Removal: the kernel removes the tunnel; remembered identities stay.

### 4.11 Removable storage, media VMs and passthrough

#### 4.11.1 Classification

When an authorized USB mass-storage, SD, optical or MTP device produces block devices or a usbfs node, `devd` classifies them (§4.3) and emits `Devd.watch` events (`storage-removable`, `optical`, `mtp`, `storage-backup`). Nothing mounts them. `atrium` or `portal-files` then calls `Bench.media(device)` (protocols §7.3.13), and `bench` calls `MediaAttach.claimBlock`.

The kernel itself parses partition tables of new block devices (it creates `sdX1`, … nodes). That parser stays in the host's attack surface; filesystem parsers do not, because no filesystem on removable media is mounted on the host.

#### 4.11.2 Backup disk detection

For each new removable whole-disk block device, `devd` reads at most the first 4 MiB:
1. LUKS2 binary header at offset 0: magic `LUKS\xba\xbe`, version 2, `hdr_size` ∈ [16 KiB, 4 MiB].
2. The JSON area (`hdr_size − 4096` bytes from offset 4096), parsed with a size-bounded JSON parser (depth ≤ 16, 4 MiB).
3. If `tokens.*.type == "keylos-backup"` exists, the class is `storage-backup`.

No key material is involved; a forged token only causes the device to be offered to `strata`, which verifies the token's MAC against the machine's backup key and releases the device on failure.

#### 4.11.3 Claims

```
claimBlock(device, readOnly)
  1. facet bench|cri; class/listing check (REQ-DEVD-060)
  2. fd := openat(devfd, DEVNAME, O_RDWR|O_EXCL|O_CLOEXEC)   (O_RDONLY|O_EXCL when readOnly)
     mtp: fd := open usbfs node (no O_EXCL; exclusivity by the claim table)
  3. readOnly → ioctl(fd, BLKROSET, 1)
  4. claims[device] := {claimant connection, claimant session, readOnly, since}
  5. receipt x-devd.claim {device, claimant, readOnly, kind}
  6. return (fd, info)
release(device) | removal | connection closed | claimant session exited
  → drop the claim (BLKROSET 0 if devd set it), receipt x-devd.release {device, reason}
```

Claimed fds are also stored with `FdStore` (key `claim:<device>`) so that a restarted `devd` keeps the claim table consistent; the claimant keeps its own fd in any case.

#### 4.11.4 VFIO

```
claimVfio(pci)
  1. facet bench|cri; pci ∈ devices.passthrough; not primary GPU (REQ-DEVD-071)
  2. group := readlink /sys/bus/pci/devices/<pci>/iommu_group; check every member (REQ-DEVD-070)
  3. for each member that is an endpoint: write <pci> to driver/unbind; write "vfio-pci" to driver_override;
     write <pci> to /sys/bus/pci/drivers_probe
  4. groupFd := open /dev/vfio/<group>; deviceFd := open /dev/vfio/devices/vfio<N> (from vfio-dev/vfio<N>)
  5. claims[pci] := …; receipt x-devd.claim {device: "dev:pci:<pci>", kind: "vfio"}
release(pci) → close; clear driver_override; drivers_probe (host driver rebinds); x-devd.release
```

---

## 5. Interfaces

### 5.1 Facets

| Facet | Holders (protocols §19.2) | Served |
|---|---|---|
| `client` | every principal | `list` and `watch`, filtered to devices whose class is grantable to the caller, with properties reduced to `ID_MODEL`, `ID_VENDOR`, `NAME` and the class; `PowerEvents.subscribe` |
| `broker` | broker | `open`; `DeviceAdmin.plan`, `revoke` |
| `warden` | warden | `DeviceAdmin.plan`, `revoke` |
| `service` | hearth, strata, atrium, portal-inhibit | `PowerEvents` (`subscribe` and `ack`) |
| `atrium` | atrium | `Backlight` |
| `authorize` | atrium | `DeviceAdmin.authorize`, `deauthorize`, `pending` |
| `bench` | bench | `MediaAttach` |
| `cri` | cri | `MediaAttach` (passthrough-listed block devices and VFIO only) |
| `admin` | atrium settings, owner `shell` | every `Devd` method including `power`; `Bluetooth`; `DeviceAdmin.deauthorize` and the authorization listing (§5.2) |

`DeviceAdmin`, `PowerEvents`, `Bluetooth`, `Backlight` and `MediaAttach` are obtained through `Extensible.ext(interfaceId)` on the bootstrap capability, or as the primary interface of their facet.

### 5.2 CLI `devctl`

| Command | Description | Exit |
|---|---|---|
| `devctl list [--class C] [--subsystem S] [--json]` | Devices visible to the caller | 0 |
| `devctl info <id>` | Properties (filtered for non-admin callers) | 0, 3 |
| `devctl monitor [--class C]` | Stream events | 0 |
| `devctl grants [--principal P]` | Active device grants (admin) | 0 |
| `devctl usb pending` | Devices waiting for authorization (admin; approval itself happens on the trusted path) | 0 |
| `devctl usb authorized [--json]` | Remembered and current authorizations with their modes | 0 |
| `devctl usb deauthorize <id> [--forget]` | De-authorize a device (admin) | 0, 1, 3 |
| `devctl thunderbolt` | Domains, security levels, IOMMU state, authorized devices | 0 |
| `devctl claims` | Current `MediaAttach` claims (admin) | 0 |
| `devctl status` | Integrity warnings (Thunderbolt `none`, no IOMMU), counts | 0, 4 |
| `devctl suspend\|poweroff\|reboot` | Power operations | 0, 1 |
| `devctl hibernate` | Always refused | 4 |
| `devctl bt power on\|off`, `devctl bt scan`, `devctl bt pair\|connect\|disconnect\|forget <addr>`, `devctl bt list` | Bluetooth | 0, 1, 3, 7 declined |
| `devctl backlight [<permille>]` | Backlight (`atrium` route or admin) | 0, 1 |
| `devctl hwdb <modalias>` | hwdb lookup (diagnostics) | 0 |

Exit codes: 0 ok, 1 denied, 2 unreachable, 3 not found, 4 refused, unsupported or an integrity warning is present, 7 declined, 64 usage.

---

## 6. Security

| Threat | Mitigation |
|---|---|
| Apps sniffing keyboards (evdev) | `input` is never granted outside `atrium` (REQ-DEVD-013) |
| Camera or microphone access without consent | Device nodes go only to the `pipewire` principal; apps get only restricted remotes created by portals after consent |
| BadUSB keystroke injection | Default-deny authorization (REQ-DEVD-040/041); HID interfaces never auto-authorized by class; keyboard-like devices approved only with another, already-approved input device (REQ-DEVD-045); no driver binds before approval |
| A device impersonating a remembered one (spoofed VID/PID/serial) | Identity includes the physical port when the serial is empty; HID safety still applies to any HID interface it exposes, because only an input-approved identity is remembered as input-approved; Thunderbolt `secure` challenge-response (REQ-DEVD-052) |
| DMA attacks over Thunderbolt/PCIe | IOMMU required; authorization only with `iommu_dma_protection = 1`; level `none` reported every boot |
| Malicious filesystems on USB sticks attacking the host kernel | No host mount of removable media (REQ-DEVD-017); filesystems are parsed only inside media VMs; exclusive claims keep the host from opening the device elsewhere |
| A forged `keylos-backup` token | Classification only routes the disk to `strata`, which verifies the token cryptographically |
| Passthrough of a device sharing an IOMMU group with a host device | IOMMU group check (REQ-DEVD-070) |
| Raw USB access abuse | T2 per session, scoped to one device ID; a receipt is written; revocation terminates the holder |
| BlueZ vulnerabilities | Island confinement in `compat` (only `bluetoothd` has `AF_BLUETOOTH`); the narrow `bt` adapter API; pairing on the trusted path |
| Forged uevents | Kernel-only netlink group (REQ-DEVD-001) |
| Malformed descriptors attacking `devd` | Bounded parsers (§4.9.2, §4.11.2), fuzzed |
| devd compromise | devd can open root-owned device nodes and authorize devices, but it cannot create namespaces or spawn other principals; authorization decisions arrive only on the `authorize` facet and are receipted |

**Self-confinement** (service-set entry): t0, dynamic UID, `network: "none"`.

| Aspect | Setting |
|---|---|
| Paths | `/dev` (rw), `/sys` (ro), plus rw for exactly the entries in `sysfsWritable` (§10) and the authorization attributes (`/sys/bus/usb/devices/*/authorized`, `authorized_default`, `/sys/bus/thunderbolt/devices/*/{authorized,key}`, `/sys/bus/pci/devices/*/driver_override`, `/sys/bus/pci/drivers/*/unbind`, `/sys/bus/pci/drivers_probe`); `/var/lib/keylos/devd` (rw) |
| Extra seccomp | `socket(AF_NETLINK, NETLINK_KOBJECT_UEVENT)`; `ioctl` `BLKROSET`, `EVIOCREVOKE` |
| Capabilities | `CAP_DAC_OVERRIDE` (open 0600 nodes), `CAP_FOWNER` and `CAP_CHOWN` (fix node ownership), `CAP_SYS_ADMIN` only for `BLKROSET` and sysfs authorization/driver attributes that require it |

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| devd crash | `warden` restarts it. Coldplug is replayed, existing fds stay valid, and the grant table is rebuilt from `/run/keylos/devd/grants.json` (written on every change). Revocation bookkeeping and claimed fds are kept with `FdStore`. Pending devices stay unauthorized in the kernel and are re-announced |
| uevent buffer overflow (`ENOBUFS`) | Full re-coldplug, diffed against the database |
| Authorization store unreadable or corrupt | `devd` treats every device as non-remembered (no first-boot rule, because a corrupt store is not an absent store) and raises a critical notification; the owner re-approves devices |
| `atrium` unavailable (headless profiles) | No trusted path: only automatic rules apply; new external devices stay unauthorized. Owners de-authorize with `devctl` |
| Suspend ack timeout | Proceed and log a warning. A component that failed to ack is listed in the critical notices after resume if it was `hearth` or `strata` |
| BlueZ island down | `Bluetooth` methods fail with `kl:unavailable`. `compat` restarts the island; paired-device keys persist in the island's state |
| `hearth` unreachable before suspend | Suspend is refused with `kl:unavailable` and a critical notification; sessions are never left unlocked across sleep |
| VFIO host-driver rebind fails | Device left bound to `vfio-pci`; critical notification naming the device |

---

## 8. Performance budgets

| Operation | Budget |
|---|---|
| Coldplug (typical laptop, about 1 500 sysfs devices) | ≤ 150 ms |
| uevent → watchers notified | ≤ 5 ms p99 |
| USB add → `PendingDevice` delivered | ≤ 20 ms p99 |
| `authorize` → driver bound (kernel time excluded) | ≤ 5 ms |
| `open` (token cached) | ≤ 1 ms p99 |
| `plan` for 4 devices | ≤ 2 ms p99 |
| `claimBlock` | ≤ 10 ms |
| Suspend request → `/sys/power/state` write | ≤ 1.5 s (with acks, no inhibitor) |
| Memory | ≤ 24 MiB RSS (hwdb about 8 MiB mapped) |

---

## 9. Observability

- **Receipts:**
  - `device.grant`: `{device, class, principal, rootId, flags, via: "open"|"plan"}`;
  - `device.authorize`: `{device, bus, identity: {vendor, product, serial, port} | {uniqueId}, classes, mode: "manual"|"remembered"|"hub"|"internal"|"class"|"preauthorized", persist, inputApproved, decisionDigest, signer: "presence"|"broker"|null}`;
  - `device.deauthorize`: `{device, forget, reason: "manual"|"store-reset"|"start-reevaluation"}`;
  - `x-devd.claim`: `{device, claimant, readOnly, kind}`; `x-devd.release`: `{device, reason}`.
- **Logs:** device add/remove at `debug`; class decisions at `info` for grantable classes; authorization decisions and power transitions at `notice`.
- **Metrics** (`0x1F` records): `devd_devices{class}`, `devd_pending_devices`, `devd_authorize_total{mode}`, `devd_open_total{class,result}`, `devd_claims{kind}`, `devd_suspend_total{result}`, `devd_suspend_ack_seconds{component}`, `devd_battery_percent`, `devd_bt_devices{state}`.

---

## 10. Configuration

`config` renders `/etc/devd/devd.toml` from the `devices` module (option paths as named in protocols §9.5):

```nickel
{
  devices | {
    autoAuthorize | Array [| 'audio, 'video, 'printer, 'smartcard, 'serial, 'net, 'mass-storage, 'mtp, 'bluetooth, 'vendor |]
      | default = [],                           # 'hid is not a member of the enum; class rules never apply to HID
    autoAuthorizeInternal | Bool | default = true,
    passthrough | Array String | default = [],  # PCI addresses ("0000:03:00.0") and block device ids for VFIO / pod VMs
    passthroughAllowPrimary | Bool | default = false,
    inhibitMaxDelaySecs | Number | default = 30,   # ≤ 120
    power | {
      powerButton | [| 'suspend, 'poweroff, 'ignore, 'ask |] | default = 'suspend,
      lidClose | [| 'suspend, 'ignore |] | default = 'suspend,
      lidCloseDocked | [| 'suspend, 'ignore |] | default = 'ignore,
      memSleep | [| 's2idle, 'deep |] | default = 's2idle,
      criticalBattery | { percent | Number | default = 3 },
    },
    bluetooth | { enabled | Bool | default = true, networkProfiles | Bool | default = false },
    deviceRules | Array { match | { _ : String }, class | String, minimumTier | String } | default = [],
    sysfsWritable | Array String
      | default = ["/sys/power/state", "/sys/power/mem_sleep", "/sys/class/backlight/*/brightness", "/sys/class/leds/*/brightness"],
  }
}
```

The `server`, `server-k8s` and `cloud` profiles (protocols §2.2) have no trusted path; their profile sets `autoAuthorizeInternal = true` and leaves every external device unauthorized unless listed in `passthrough` or authorized by an owner through `devctl` on a machine with `atrium`.

---

## 11. Testing and acceptance criteria

**Unit:**
- uevent parser (malformed input, oversize, NUL handling);
- USB `descriptors` parser (truncated, looping `bLength = 0`, oversize `wTotalLength`, too many interfaces);
- LUKS2 header and token probe (bad magic, oversize JSON, deep nesting);
- `ID_PATH` derivation golden tests from sysfs snapshots of the reference machines;
- class matcher table tests; automatic rule table (§4.9.3) with every combination of classes and modes;
- decision envelope checks (wrong digest, wrong target, expired, `confirmedWith` equal to the device, `confirmedWith` not input-approved; signed by the atrium approver key → `kl:integrity`; signed by an unknown key → refresh then `kl:integrity`; valid `service/broker` signature; valid presence signature; broker key rotated between two calls);
- `keylos.preauth/1` parser (unknown fields, uppercase hex, oversize list, empty `serial`);
- hwdb compiler round trip against the upstream text;
- token matching (exact ID, subsystem pattern, class pattern, expired or wrong principal).

**Integration** (VM with emulated USB (QEMU `usb-host` and `usb-kbd`/`usb-storage`), HID, v4l2loopback, snd-dummy, emulated Thunderbolt where available):
1. An app without a grant cannot see `/dev/video0`: it is absent from its view. After portal consent it receives only a PipeWire restricted remote.
2. A raw USB grant at T2 produces a receipt. Revoking it terminates the holder (`onRevoke = kill`).
3. Suspend: `hearth` locks, `strata` acks, resume shows the lock screen, and user slices are thawed.
4. **BadUSB:** plugging an emulated keyboard while unlocked produces a pending device; its keystrokes never reach `atrium`. Approving it with the same keyboard (`confirmedWith` = itself) is refused; approving with the built-in keyboard succeeds; `device.authorize` receipt with `mode = manual`.
5. **Remember:** unplug and replug the approved keyboard on the same port → authorized automatically (`remembered`); on another port with an empty serial → pending again.
6. **Start re-evaluation:** a USB stick authorized by the kernel default before `devd` starts is de-authorized at `devd` start and becomes pending.
7. **Media:** an authorized USB stick is never mounted on the host (no host `mount` of its filesystem in `/proc/self/mountinfo` of any host process); `Bench.media` → `claimBlock` succeeds once; a second claim fails with `kl:conflict`; stopping the media VM releases it (`x-devd.release`).
8. **Backup disk:** a stick with a LUKS2 `keylos-backup` token is classified `storage-backup` and plannable only for `strata`; `Devd.open` for any other principal fails.
9. **VFIO:** `claimVfio` of a device not in `passthrough` → `kl:denied`; of a device whose IOMMU group contains an unlisted endpoint → `kl:conflict`; of a listed NIC → bound to `vfio-pci` and rebound on release.
10. A BlueZ pairing request is shown on the trusted path through `broker`. An agent principal calling `Bluetooth.pair` gets `kl:denied`, because it has no `admin` facet.
11. `power("hibernate")` returns `kl:unsupported`.
12. `power("poweroff")` reaches `warden` as `control("_system", poweroff)`.
13. **Mandate signers:** `authorize` with a mandate re-signed by `service/broker` succeeds; the same payload signed only by the atrium approver key fails with `kl:integrity` and the device stays pending; a presence-signed mandate from a registered owner succeeds; one from a removed owner fails.
14. **Pre-authorization:** with an installer-written `preauthorized.json` listing the built-in keyboard and an external USB keyboard, both are authorized and input-approved at the first start; a USB stick plugged at install time (not listed) is pending; a malformed file yields no automatic authorization and a critical notification.
15. **After `switch_root`:** boot the VM with `usbcore.authorized_default=2` and an external emulated keyboard plus an emulated storage device; the initrd authorizer binds the keyboard only; at `devd` start the keyboard is de-authorized unless remembered or pre-authorized, and `devd` reports ready only after re-evaluation.
13. Inhibition: with a `suspend` inhibition held through `portal-inhibit`, lid-close suspend is delayed by at most `inhibitMaxDelaySecs`; a user-requested suspend is not delayed.
14. Thunderbolt `none` level (emulated): `devctl status` exit 4 and a critical notification at boot.

**Fuzzing:** uevent messages, USB `descriptors` blobs, LUKS2 headers, HID report descriptors (FIDO detection), sysfs attribute parsers, decision envelopes, and BlueZ D-Bus replies in the `bt` module.

**Acceptance:** all integration tests pass; every class in §4.3 is exercised on at least one reference machine; the BadUSB test (4) passes on real hardware with a programmable USB HID device.

---

## 12. Implementation notes

**Crates:** `tokio` 1, `rustix` 0.38 (netlink sockets, ioctls), `zbus` 4 (the `bt` module, over the island socket), `evdev` 0.12 (classification probes), `capnp-rpc` 0.19, `serde_json` 1 (with a depth-limited reader for LUKS2 JSON), `globset` 0.4, `getrandom` 0.2 (Thunderbolt keys).

**hwdb:** the build step parses `hwdb.d/*.hwdb` (pinned upstream sources) and the keylos lists into a sorted, mmap-able table (`hwdb.bin`): modalias glob → properties, plus a trie for prefix lookups.

**Repository layout:**

```
devd/
  crates/devd/ (modules: uevent, db, classify, usbauth, tbauth, media, vfio, open, plan, power, backlight, sensors, bt)
  crates/devctl/  crates/hwdb-compile/  crates/usb-descriptors/  crates/luks2-probe/
  data/fido-authenticators.hwdb  data/fingerprint-readers.hwdb
  tests/vm/  fuzz/
```

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reference |
|---|---|---|
| No device groups; devd opens on behalf of principals | udev plus group membership (ambient access for every process of a user) | [ADR-0024](../../handbook/11-decisions/adr-0024-dynamic-uids-per-principal.md) |
| Default-deny USB and Thunderbolt authorization on the trusted path | USBGuard-style rule files only (no trusted-path UX); kernel default authorize-all | [ADR-0052](../../handbook/11-decisions/adr-0052-usb-authorization-and-media-bench.md) |
| Removable media only inside media VMs | Host `udisks`-style automount (every filesystem parser in the host kernel's attack surface) | [ADR-0052](../../handbook/11-decisions/adr-0052-usb-authorization-and-media-bench.md) |
| BlueZ in a `compat` D-Bus island, adapter inside devd | Reimplementing a Bluetooth host stack; BlueZ on a system bus | [ADR-0035](../../handbook/11-decisions/adr-0035-fd-only-portals-dbus-islands.md) |
| Audio and camera devices only to the per-human PipeWire principal; restricted remotes for apps | A shared system PipeWire socket | [ADR-0035](../../handbook/11-decisions/adr-0035-fd-only-portals-dbus-islands.md) |
| Input devices only to the compositor | Per-app evdev (enables keyloggers) | [ADR-0034](../../handbook/11-decisions/adr-0034-wayland-only-trusted-path.md) |
| No hibernation | Hibernation with a TPM-sealed swap key (refused by kernel lockdown) | protocols §2 |

### 13.1 Notes on cross-repository contracts

- **N1.** Device mandates are verified against owner-presence keys and the `service/broker` key only (protocols §14.4); the earlier reliance on the `authorize` facet alone is gone.
- **N2.** Pre-authorization uses the installer-written `preauthorized.json` (protocols §9.5, §10.7); there is no first-coldplug heuristic.
- **N3.** The pre-`devd` window is bounded by `usbcore.authorized_default=2` and the initrd's all-HID authorizer (protocols §9.5); keystrokes from an external keyboard can reach only the initrd prompts. The remaining window is residual risk R15 of the distribution.
