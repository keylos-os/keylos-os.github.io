# ADR-0035: fd-only portals, and D-Bus islands for legacy daemons

> Portals are small, separate, confined Rust services that hand out objects (file fds, restricted PipeWire remotes, sockets) and never paths. Daemons that only speak D-Bus (BlueZ, iwd, CUPS drivers) run in private D-Bus islands whose only other client is a keylos adapter that exposes capwire.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Experience / security | portals, devd, net, compat, atrium |

## Context

- Flatpak's sandbox escapes are mostly in trusted helper and portal code, through path handling and symlinks:
  - CVE-2024-32462 (RequestBackground argument injection);
  - CVE-2024-42472 (persistent-directory symlink);
  - CVE-2026-34078 (sandbox-expose symlink to an arbitrary host path, CVSS 9.3, https://cve.circl.lu/cve/CVE-2026-34078).
- Android SAF and the macOS powerbox show that grants work best as objects with explicit, revocable persistence.
- Rewriting BlueZ or CUPS isn't realistic for v1.0.

## Decision

- Each portal is its own t0 principal with a minimal allowance set. It works only on fds with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` and never resolves paths on a less-trusted principal's behalf (invariant I7).
- The user's choice in the portal UI is the grant. broker records it as a token, persistent or not.
- D-Bus islands: one private dbus-broker per legacy daemon, inside its own confined principal. An adapter translates a minimal capwire interface to the daemon's D-Bus API. No other principal can reach the island.

## Alternatives considered

| Option | Why not |
|---|---|
| xdg-desktop-portal as-is | D-Bus-based, path-oriented (document FUSE), large surface |
| A shared session bus with filtering | Ambient authority |
| Rewrite BlueZ/iwd/CUPS | Out of scope for v1.0 |

## Consequences

### Positive
- Small, auditable helpers; the class of bugs where a helper follows a path on a sandboxed app's behalf is removed by construction.

### Negative
- Apps written for xdg-desktop-portal need the SDK or a compat shim.
- Islands keep legacy C daemons in the system, confined.

## Related

- [Portals and powerbox](../09-experience/portals-and-powerbox.md)
- [portals](../03-components/portals.md)
- [ADR-0004: capwire, no system bus](adr-0004-capwire-no-system-bus.md)
