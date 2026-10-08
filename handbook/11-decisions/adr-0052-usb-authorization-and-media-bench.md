# ADR-0052: USB authorization, mandatory IOMMU and a media VM for removable storage

> New USB devices stay unauthorized until a human approves them on the trusted path. Keyboard-like devices can only be approved with an input device that is already trusted. Thunderbolt and USB4 need an active IOMMU and approval. Removable storage is never mounted by host filesystem drivers: a media VM mounts it and serves files labelled untrusted.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Hardware / security | devd, bench, portals, atrium, strata, keylos, protocols |

## Context

- **BadUSB.** A USB device can present itself as a keyboard and type commands the moment it is plugged in. Generic Linux binds drivers on attach with no user decision.
- **DMA.** Thunderbolt/USB4 and external PCIe devices can read and write host memory unless the IOMMU confines them. Pre-boot DMA protection depends on firmware.
- **Filesystem parsers.** In-kernel filesystem drivers parsing attacker-controlled images are a common kernel bug source. Malformed images of ext4, btrfs, NTFS and others regularly produce memory-safety bugs found by fuzzing. Automounting a found USB stick hands the kernel an attacker-chosen image.
- keylos already keeps unsealed code and untrusted data in VMs ([ADR-0009](adr-0009-unsealed-code-in-workbenches.md)). The same approach fits removable media.

## Decision

- **USB** ([protocols §9.5](../../specs/protocols/spec.md#95-devices-removable-media-and-dma)):
  - The kernel command line sets `usbcore.authorized_default=2` (internal devices only). The initrd authorizes only external hubs and all-HID devices listed in `preauthorized.json` (`keylos.preauth/1`), so the PIN and FIDO2 key work. After `switch_root`, `devd` sets `authorized_default=0`, re-evaluates every device, and binds no driver until `DeviceAdmin.authorize` with a trusted-path decision: a mandate re-signed by `service/broker` or signed by owner presence, which `devd` verifies.
  - "Remember" stores the device identity (vendor, product, serial, port). Input devices present at install are pre-authorized.
  - A device with `hidSafety: "keyboard-like"` is approved only with an already-authorized input device. Its keystrokes are discarded until then.
  - `devices.autoAuthorize` may allow classes such as audio or FIDO. `hid`, `net` and `mass-storage` are never auto-authorized by default.
- **DMA.** The IOMMU is required on every profile except `degraded` ([protocols §2](../../specs/protocols/spec.md#2-platform-baseline)). Thunderbolt/USB4 domains are authorized only after approval, and never without an active IOMMU.
- **Removable storage.**
  - An authorized mass-storage, SD, optical or MTP device is handed only to a **media VM** (`purpose: media`, image `io.keylos.bench.media`) through `MediaAttach.claimBlock`.
  - The VM mounts the filesystem and serves `MediaBrowser`. Bytes read through it are labelled `public/untrusted`, and `portal-files` shows a location "USB: &lt;label&gt;".
  - Writing is the effect `media.export`.
  - The one exception: keylos backup disks, whose LUKS2 header carries a `keylos-backup` token verified against the machine's backup key. These are mounted by `strata` for backups only.
- **Fingerprint readers** unlock the screen lock only, never presence or the disk.
- **VFIO passthrough** only for devices listed in `devices.passthrough`.

## Alternatives considered

| Option | Why not |
|---|---|
| USBGuard-style allowlist without trusted-path approval | Rules edited by a compromised user session; no keystroke-injection defence |
| Mount removable media read-only on the host | The kernel still parses the attacker's filesystem image |
| FUSE filesystems on the host | Moves the parser to userspace but onto the host, outside a VM boundary; many drivers exist only in the kernel |
| No removable media support | Unusable for ordinary users and for transferring files to offline machines |

## Consequences

### Positive
- Plugging in a device does nothing until a human decides, and a fake keyboard cannot approve itself.
- Filesystem parser bugs in USB images are confined to a disposable VM.
- Files from removable media enter with an untrusted label, so the Rule of Two applies to them.

### Negative
- Copying to and from a stick takes an extra step (the export effect) and a VM start.
- External GPUs and docks need explicit approval on first use, and on machines without an IOMMU they can't be used at all.
- Approval UX must handle docks with many child devices; devd groups them by port.

## Related

- [Devices and media](../06-security/devices-and-media.md)
- [Portals and the powerbox](../09-experience/portals-and-powerbox.md)
- [Profiles and hardware](../01-overview/profiles-and-hardware.md)
