# Profiles and hardware

> A keylos machine runs exactly one **profile**, chosen at install, which decides what it is for. Every boot also derives exactly one **integrity profile**, which says how strong its chain of trust is, and shows it everywhere. This page lists both, the RAM classes that bound VM use, and the hardware keylos supports and certifies.
> Normative: [protocols §2](../../specs/protocols/spec.md#2-platform-baseline), [§2.2](../../specs/protocols/spec.md#22-profiles-and-integrity-profiles), [§2.3](../../specs/protocols/spec.md#23-resource-classes), [keylos distribution spec](../../specs/keylos/spec.md). Status: **specified (v1.0)**.

## Profiles

| Profile | For | Presence | Desktop | Notes |
|---|---|---|---|---|
| `desktop` | Workstations | FIDO2 touch | atrium | Agents, workbenches, tier-2 GPU apps |
| `laptop` | Portable machines | FIDO2 touch | atrium | `desktop` plus suspend handling and privacy-leaning network defaults |
| `server` | Headless machines | Quorum ([ADR-0048](../11-decisions/adr-0048-quorum-presence.md)) | none | Serial-console recovery with the recovery key |
| `server-k8s` | Kubernetes worker nodes | Quorum | none | `server` + `cri`, `kubelet`, `kube-proxy` ([Kubernetes nodes](../10-operations/kubernetes.md)) |
| `cloud` | VM images in public or private clouds | Quorum | none | Provider vTPM, confidential VMs, signed first-boot seed ([Servers and cloud](../10-operations/servers-and-cloud.md)) |
| `kiosk` | Single-app devices | Owner touch (admin only) | atrium kiosk mode | Autologin to one app principal; the trusted path is still present for owners |
| `appliance` | Fixed-function devices | Quorum | none | As `server`, without `bench` |

Changing profile is a presence-signed config change, plus a reinstall where the disk layout differs.

## Integrity profiles

| Integrity profile | Condition | Shown as |
|---|---|---|
| `full` | Owner Secure Boot keys (no Microsoft CAs in db), TPM 2.0, IOMMU, every check passes | Neutral |
| `shared-boot` | `secureboot.keepMicrosoftCAs = true` for dual boot ([ADR-0054](../11-decisions/adr-0054-dual-boot-option.md)) | Amber outline |
| `shim` | Booted through shim + MOK because custom Secure Boot keys aren't available | Amber outline |
| `cloud-vtpm` | `cloud` profile with a provider vTPM, no confidential-VM report | Neutral (cloud) |
| `cvm` | `cloud` profile in a confidential VM whose report is verified with the TPM quote | Neutral (cloud) |
| `degraded` | No TPM, or Secure Boot off: no sealing, no VBU, persistent warning | Amber, permanent |

The integrity profile appears in `kish status`, in the boot report and in the vouch verdict. No profile turns off code-integrity enforcement ([kl-exec](../05-integrity/exec-integrity-and-sealing.md)). Out-of-tree kernel modules come only as project-built, release-signed `kmod` generations, so there is no reduced-integrity profile for them ([ADR-0057](../11-decisions/adr-0057-oot-modules-project-signed-only.md)).

## RAM classes

`bench` admission control follows the machine's RAM class, detected at boot and overridable in config.

| RAM | Class | Max concurrent VMs | Defaults |
|---|---|---|---|
| < 12 GiB | `small` | 2 | zram swap with an ephemeral key, KSM on, compressed snapshots, agents queue |
| 12–24 GiB | `medium` | 6 | KSM on, free-page reporting |
| > 24 GiB | `large` | 16 | Free-page reporting |

The cap counts workbench, agent, tier-2, media and agent-desktop VMs. When it is reached, new agent sessions queue and other VM requests fail with `kl:unavailable`. `server-k8s` pod VMs are exempt; kubelet `maxPods` bounds them.

## Hardware support

keylos supports x86-64 (x86-64-v2 or newer) and aarch64 (ARMv8.2 or newer) machines with UEFI.

**Required for `full`:**

| Area | Requirement | Why |
|---|---|---|
| Firmware | UEFI 2.7+, custom Secure Boot keys via setup mode | Owner-controlled boot keys |
| TPM | TPM 2.0 revision ≥ 1.38 (`PolicyAuthorizeNV`, NV counters) | Sealed unlock, release floor, quotes |
| IOMMU | Active: `iommu=force` with `intel_iommu=on` or `amd_iommu=force_isolation`; Thunderbolt/USB4 security `secure` or `user` | DMA attacks ([Devices and media](../06-security/devices-and-media.md)) |
| Virtualization | KVM (VT-x/AMD-V or ARM VHE) | Workbenches, tier-2 apps, agents, media VMs |
| Kernel feature level | KL1 minimum (Linux ≥ 6.18); KL3 recommended | Landlock, BPF LSM (`kl-exec`), IPE, fs-verity |

The IOMMU is required on every profile except `degraded`. Without an active IOMMU, external PCIe and Thunderbolt devices are never authorized.

**Recommended:**
- A firmware TPM (Intel PTT, AMD fTPM, Pluton) rather than a discrete one, because of bus-sniffing attacks on discrete TPMs.
- A GPU whose upstream driver supports virtio-gpu native context (AMD, Intel Xe, Qualcomm, Mali), for tier-2 apps, IDEs and agent desktops.
- Two FIDO2 security keys with `hmac-secret` and user verification. Owners who can't use a roaming key can enrol hearth's assisted platform authenticator.

**Out-of-tree drivers.** NVIDIA GPUs use the open kernel modules, shipped as release-signed `kmod` generations that match the running kernel. Hardware that needs binary-only modules isn't supported.

## Kernel feature levels

| Level | Adds | Typical kernel | What changes on lower levels |
|---|---|---|---|
| KL1 | Landlock ABI 7, BPF LSM, IPE, fs-verity, pidfd, new mount API, idmapped mounts, exec checks, `cgroup.freeze`/`cgroup.kill` | 6.18 | Pathname unix sockets and UDP are confined by namespace and proxy instead of Landlock rules |
| KL2 | Landlock pathname unix sockets, thread-synchronised restriction | 7.1 | UDP confined by namespace and proxy |
| KL3 | Landlock UDP rules | 7.2 | — |

## Certification

A machine model is **certified** when it passes `keylos-hwcert` on a production unit and the signed report is published in the release log. The suite checks:

1. Owner Secure Boot key enrolment; whether the Microsoft CAs are absent (`full`) or deliberately kept (`shared-boot`).
2. PCR 0–7 stability across 10 reboots and pcrlock prediction accuracy.
3. TPM NV indices in the owner range, the public `NV_Read` policy branch, and EK certificate chain validation.
4. IOMMU active and Thunderbolt security level; USB authorization defaults.
5. Suspend and resume (50 cycles), Wi-Fi, GPU native context, camera and microphone through portals.
6. The [performance budgets](quality-attributes.md).

Machines that are not certified may still work. The installer shows the hardware check results and the resulting integrity profile before installing.

## Limitations

- Some GPUs and network cards need Microsoft-signed option ROMs. If the installer can't allow-list their hashes, the owner chooses `shared-boot` or accepts that the device won't initialise at boot.
- Hibernation is unsupported in every profile because kernel lockdown refuses it. Suspend-to-RAM works.
- Discrete TPMs are more exposed to bus sniffing. The PIN is the remaining defence.

## Related

- [keylos distribution spec](../../specs/keylos/spec.md)
- [Install and enrolment](../10-operations/install-and-enrolment.md)
- [Servers and cloud](../10-operations/servers-and-cloud.md)
- [Attestation and vouch](../05-integrity/attestation-and-vouch.md)
- [Threat model](threat-model.md)
