# ADR-0004: capwire, with no system bus

> All IPC between principals is Cap'n Proto RPC over `SOCK_SEQPACKET` unix sockets with `SCM_RIGHTS` fd passing ("capwire"). There is no system bus and no session bus. Each process can reach only the capabilities warden connected for it.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Architecture | All runtime components |

## Context

- The D-Bus session bus is ambient authority. Any process on it can call any service by name: systemd-run, gvfs, keyrings. Once a collection is unlocked, the Secret Service API lets any session-bus client read every secret (CVE-2018-19358, https://gitlab.gnome.org/GNOME/gnome-keyring/issues/5).
- Flatpak works around this with `xdg-dbus-proxy` filtering, which has been a recurring source of bugs and only filters by name.
- A capability system needs references that can be passed but not forged, plus the ability to move kernel objects (fds) alongside calls.
- Cap'n Proto RPC is an object-capability protocol with promise pipelining. It is mature in Rust (capnp-rust). Varlink (systemd's choice) is simpler but name-addressed, not capability-based.

## Decision

- Transport: AF_UNIX `SOCK_SEQPACKET`, one Cap'n Proto message per datagram (at most 4 MiB), fds as `SCM_RIGHTS` (at most 64 per datagram), referenced in-message by `Fd { index }`.
- Protocol: rpc.capnp level 1 with promise pipelining.
- Connections are created only by warden (`socketpair` and hand-off), according to routes in manifests and policy. Service sockets are mode 0700 under warden's UID.
- Peer identity: delivered by warden with each connection (`ServiceHost.accept`). Never PIDs, paths or message claims (see Addendum).
- Facets let one service expose different restricted root capabilities to different callers.
- Legacy D-Bus daemons (BlueZ, iwd) live in private D-Bus islands bridged to capwire ([ADR-0035](adr-0035-fd-only-portals-dbus-islands.md)).

## Alternatives considered

| Option | Why not |
|---|---|
| D-Bus with policy (dbus-broker + filtering) | Name-addressed ambient bus; filtering by names is coarse and proxies are bug-prone |
| Varlink | Simple and good, but not capability-based; no fd-in-message model |
| gRPC over unix sockets | No capabilities; HTTP/2 overhead; no fd passing |
| Custom protocol | Reinventing schemas, evolution and pipelining |
| Binder (Android) | Kernel driver available, but semantics and tooling are tied to Android userspace |

## Consequences

### Positive
- No ambient IPC surface: a compromised app can't even name services it wasn't given.
- fds travel with calls, so resources are passed as objects (powerbox, devices, sockets).
- Typed, versioned interfaces in one place ([protocols](../03-components/protocols.md)).

### Negative
- Desktop software expecting D-Bus needs portals, islands or adaptation.
- RPC level 1 lacks three-party handoff, so some capabilities are proxied.
- Debugging needs tooling (a capwire recorder in the SDK).

### Follow-ups
- Evaluate level-3 RPC (three-party handoff) for capwire 2.

## Addendum (implementation round S1)

Implementing capwire showed that `SO_PEERPIDFD` cannot identify peers here. Every connection is a `socketpair` that warden creates and hands out, and for socketpairs the kernel records the creating process (warden) as the peer of both ends. A test in `keylos-capwire` demonstrates it. protocols §7.1 (change D2) therefore makes warden's `ServiceHost.accept` arguments, or `Supervisor.connectionInfo`, the only identity source for capwire connections. `SO_PEERPIDFD` stays valid only for sockets the peer itself `connect()`ed. The same round found that AF_UNIX seqpacket datagrams are capped near 416 KiB with the default `net.core.wmem_max`. warden now forces 4 MiB + 64 KiB socket buffers on every pair it creates (D3).

## Related

- [Capwire](../04-contracts/capwire.md)
- [Authority flow](../02-architecture/authority-flow.md)
- [ADR-0035: fd-only portals and D-Bus islands](adr-0035-fd-only-portals-dbus-islands.md)
