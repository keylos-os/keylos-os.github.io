# devd

> The device manager. devd listens to kernel uevents, applies hwdb data and declarative rules, names devices with stable IDs, and hands out device fds only through [broker](broker.md)-issued tokens.
> It also handles power operations and the confined integration of Bluetooth (BlueZ in a D-Bus island) and audio (PipeWire).

**Status:** specified (v1.0) · **Spec:** [`devd/spec.md`](../../specs/devd/spec.md)

## Responsibilities

- **Enumeration:** netlink uevents, sysfs, hwdb, and stable IDs `dev:<subsystem>:<path>` (protocols §3.5).
- **Rules:** declarative rules from the config generation (no executable rule hooks). Device nodes are owned by devd and are not world-accessible.
- **Access:** `Devd.open(id, token, flags)` on the broker facet. Callers go through `Broker.materialize`. Opens are scoped with Landlock `IOCTL_DEV` where available.
- **Firmware:** kernel firmware loading is restricted to verified generations (`kl-exec` `kernel_read_file` hook) and the initramfs.
- **Power:** suspend, poweroff, reboot. Hibernation is unsupported (kernel lockdown refuses it); `power("hibernate")` returns `kl:unsupported`. Lock-on-suspend coordination with [hearth](hearth.md).
- **Subsystems:**
  - DRM/KMS and input for [atrium](atrium.md);
  - render nodes for apps with `needs.gpu = "render"`;
  - `/dev/kvm` for [bench](bench.md);
  - FIDO2 hidraw for hearth;
  - cameras and audio through PipeWire for [portals](portals.md);
  - USB with policy for new devices (USB authorisation on by default).
- **Bluetooth:** BlueZ in an island, bridged to capwire. Pairing goes through the trusted path.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Devd` (`devd.capnp`) | Facets `client`, `broker`, `admin` |
| Provides | `DeviceAdmin`, `PowerEvents`, `Bluetooth`, `Backlight` (`devd-sys`) | Facets `warden`, `broker`, `service`, `atrium`, `admin` |
| Consumes | broker | Device token checks |
| Consumes | hearth `HearthSystem.prepareSuspend`/`resumed` | Lock on suspend |
| Consumes | compat `CompatIsland` (facet `adapter`) | BlueZ in a D-Bus island |
| Consumes | ledger (facet `writer`) | Receipts |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

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
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`devd-sys.capnp`](../../specs/protocols/spec.md#758-devd-syscapnp) | `0xc7a1e5d3b2f40027` | `DeviceAdmin`, `PowerEvents`, `Bluetooth`, `Backlight`, `MediaAttach` |
<!-- /generated:sysif -->

## Runs as

A t0 service with uevent netlink, device-node management and USB authorisation privileges.

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `device.grant`, `device.authorize`, `device.deauthorize`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Key decisions

- [ADR-0035: fd-only portals and D-Bus islands](../11-decisions/adr-0035-fd-only-portals-dbus-islands.md)
- [ADR-0023: No root, no setuid](../11-decisions/adr-0023-no-root-no-setuid.md)

## Limitations

- GPU drivers stay a large kernel attack surface for tier-1 apps (accepted risk).

## Related

- [Capabilities and broker](../06-security/capabilities-and-broker.md)
- [Profiles and hardware](../01-overview/profiles-and-hardware.md)
