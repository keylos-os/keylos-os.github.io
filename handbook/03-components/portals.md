# portals

> Small fd-only services that mediate access to user-facing resources: files (the powerbox UI), screen capture, camera, microphone, URI and file opening, notifications, printing, clipboard, location and accessibility.
> Each portal hands out an object (an fd or a restricted PipeWire remote), never a path, and runs confined itself.

**Status:** specified (v1.0) · **Spec:** [`portals/spec.md`](../../specs/portals/spec.md)

![Powerbox](../images/powerbox.svg)

## Responsibilities

| Portal service | Interface | Returns |
|---|---|---|
| `portal-files` | Powerbox UI for `Broker.powerbox` | Opened file fds or `O_PATH` dirfds plus a token |
| `portal-screen` | `ScreenCapture` | PipeWire node and a remote fd restricted to that node |
| `portal-camera` | `Camera` | Restricted PipeWire remote |
| `portal-mic` | `Microphone` | Restricted PipeWire remote |
| `portal-open` | `OpenUri` | Launches the handler app with the file as an fd |
| `portal-notify` | `Notify` | Notification IDs |
| `portal-print` | `Print` | Job ID (IPP Everywhere; driver-based printing through a compat island) |
| `portal-clipboard` | `Clipboard` | Data fd; reads only by focused or permitted principals |
| `portal-location` | `Location` | Coarse or precise fix, per grant |
| `portal-a11y` | `Accessibility` | a11y socket, assistive-tech principals only |

Rules for every portal:
- Work only on fds, with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)`. Never follow paths on a less-trusted principal's behalf (invariant I7).
- Ask [broker](broker.md) for a decision. The user's choice in the portal UI *is* the grant.
- Run confined (t0 with a minimal allowance set), each in its own principal.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `portals.capnp` interfaces | Facet `default` per portal, routed per manifest `needs.services` |
| Provides | `FilePicker` (`picker`), `Background`, `GlobalShortcuts`, `Inhibit` (`portals-extra`) | Facets `broker`, `drop`, `default` |
| Consumes | broker (facet `principal`), `LabelAuthority` | Grants; labels on clipboard and open-uri hand-offs |
| Consumes | warden (facets `portals`, `handler`) | Grant mounts for portal islands, handler spawns |
| Consumes | atrium (`Screencast`, `ShortcutsHost`, `IndicatorHost` facets) | Trusted pickers and sensor indicators |
| Consumes | compat `CompatIsland` (facet `adapter`) | CUPS island for legacy printer drivers |
| Consumes | PipeWire, devd | Media streams and devices |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| portal-* | `default` | apps declaring the portal in `needs.services`; bench-relay (for its tier-2 VM principal, `GuestPortals`) | the portal's interface (§7.3.15, §7.5.20) |
| portal-files | `broker` | broker | `FilePicker.pick` |
| portal-files | `drop` | atrium | `FilePicker.confirmDrop` |
| portal-mic | `capture`, `playback` | apps with a microphone grant; apps with audio output | `Microphone` |
| portal-a11y | `default` | assistive-technology principals only | `Accessibility` |
| portal-* | `ctl` | portalctl | portal-local control |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`picker.capnp`](../../specs/protocols/spec.md#7519-pickercapnp) | `0xc7a1e5d3b2f40032` | `FilePicker` |
| [`portals-extra.capnp`](../../specs/protocols/spec.md#7520-portals-extracapnp) | `0xc7a1e5d3b2f40033` | `Background`, `GlobalShortcuts`, `Inhibit` |
<!-- /generated:sysif -->

## Runs as

One t0 principal per portal service.

## Key decisions

- [ADR-0035: fd-only portals and D-Bus islands](../11-decisions/adr-0035-fd-only-portals-dbus-islands.md)
- [ADR-0034: Wayland-only, trusted path](../11-decisions/adr-0034-wayland-only-trusted-path.md)

## Limitations

- The focused client can still read data the user pastes into it. The clipboard is mediated, not eliminated.

## Related

- [Portals and powerbox](../09-experience/portals-and-powerbox.md)
- [Capabilities and broker](../06-security/capabilities-and-broker.md)
