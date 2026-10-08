# Capwire

> capwire is keylos's only IPC mechanism: Cap'n Proto RPC over AF_UNIX `SOCK_SEQPACKET` sockets, with file descriptors carried as `SCM_RIGHTS` next to each message.
> There is no system bus. A process can call only the capabilities warden handed it at spawn and the ones those calls return.

**Status:** specified (v1.0) · **Normative source:** [protocols §7](../../specs/protocols/spec.md#7-capwire-the-ipc-protocol)

## Why this shape

| Requirement | How capwire meets it |
|---|---|
| Authority is a held reference, not a name lookup | Cap'n Proto is an object-capability RPC: interfaces are references that can be passed, but not forged |
| Resources travel as kernel objects | fds ride the same datagram as the message that references them |
| The caller's identity can't be spoofed | warden, which creates every connection, tells the server who the peer is in `ServiceHost.accept` |
| Low latency, no broker in the data path | Point-to-point sockets created by warden; no central daemon routes messages |
| Typed, evolvable contracts | Cap'n Proto schemas with ordinal-based compatible evolution |
| Pipelining for chatty flows | Promise pipelining (rpc.capnp level 1) cuts round trips such as `request → materialize` |

## Wire format

| Aspect | Rule |
|---|---|
| Socket | AF_UNIX, `SOCK_SEQPACKET` |
| Framing | One Cap'n Proto message (standard segment table) per datagram |
| Max datagram | 4 MiB. Larger data uses `ByteStream`/`ByteSource` or a passed fd |
| fds | `SCM_RIGHTS`, at most 64 per datagram. In-message `Fd { index }` points into that array |
| Unreferenced fds | Receiver MUST close them |
| Bad `Fd.index` | Receiver MUST reject the message |

An `Fd` is only meaningful together with the datagram that carried it. Implementations extract fds when decoding and attach them when encoding. The `keylos-capwire` crate does this so service code never touches ancillary data.

## Routes and facets

warden creates every connection. Routes come from manifests (`needs.services`) and policy:

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

Routes are written `service#facet`, for example `vault#app`.

- **Facet:** a restriction name chosen by the server. Every facet, its holders and the methods it allows are fixed by the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets), summarised in [Registries](registries.md)). Servers refuse other methods with `kl:denied`. Examples:

  | Service | Facet | Allows |
  |---|---|---|
  | vault | `app` | Only the caller's own items |
  | vault | `strata` | `dataKey` and `forget` |
  | vault | `gate` | `inject`, and `dataKey`/`forget` for `gate:` units |
  | depot | `mounter` | `mount` (warden, bench, compat) |
  | ledger | `writer` | `append` |
  | broker | `label-authority` | `LabelAuthority.labelOf`/`raiseFor` |

- The server learns the facet of each connection from `ServiceHost.accept` (protocols §7.5.1), or from `Supervisor.connectionInfo`, and narrows its bootstrap capability accordingly.
- Service sockets live in `/run/keylos/svc/<service>/` (mode 0700, warden's UID), so nothing but warden can `connect()`. warden hands each new connection to the service through `ServiceHost.accept`.
- Dynamic routes, for a service capability granted at runtime, are created by broker through `ServiceConnect.connectService`.

## Holding is authority

capwire has **no call-attached tokens**. A capability or fd received through capwire is itself the authority to use it. Methods that need token-based authority take an explicit `Token` parameter; otherwise the route facet or the held capability decides.

## Extensible bootstrap

Every bootstrap capability also implements `common.Extensible`:

| Method | Use |
|---|---|
| `ext(interfaceId)` | Obtain another interface on the same connection, such as a [system interface](system-interfaces.md). Returns `kl:denied` when the facet doesn't allow it |
| `version()` | `(protocols, implementation)` version strings |

## capwire over vsock

Between a VM guest and the host, capwire runs over `AF_VSOCK` `SOCK_SEQPACKET` (the **capwire-vsock profile**, [protocols §7.2.1](../../specs/protocols/spec.md#721-capwire-vsock-profile-host--guest)):

| Rule | Detail |
|---|---|
| No fds | `Fd` fields are forbidden and rejected |
| Bulk data | `ByteStream`/`ByteSource`, or vsock streams on ports 1025–1535 announced in control messages |
| Identity | The host identifies the VM by the CID bench assigned; guest claims are never trusted |
| Ports | 1024 bench control (`benchd`), 7002 aide `AgentHost` (agent VMs only); the guest always connects to host CID 2 |

All other guest network traffic leaves through one virtio-net device, terminated on the host by `bench-net`, which turns each flow into a `ShimEndpoint.connect` on gate.

## Who is calling?

1. warden creates every connection as a `socketpair` and hands the server end over with `ServiceHost.accept(socket, connectionId, facet, peer, tier, generation)`.
2. Those arguments (or `Supervisor.connectionInfo(connectionId)` later) are the server's **only** source of the caller's principal, tier, generation and facet.
3. The server never asks the socket. On a warden-created socketpair the kernel records the *creating* process as the peer of both ends, so `SO_PEERPIDFD` and `SO_PEERCRED` name warden itself ([protocols §7.1](../../specs/protocols/spec.md#71-model), ADR-0004 addendum). PIDs, executable paths and claims inside messages never count either.
4. warden forces 4 MiB + 64 KiB socket buffers on both ends of every pair, so 4 MiB datagrams fit regardless of `net.core.wmem_max`.

Because warden records the peer when it creates the pair, and principals have dedicated UIDs and cgroups (protocols §10.3), this identity can't race or be impersonated by another process of the same human.

## Errors

Failures are Cap'n Proto `failed` exceptions whose reason starts with `kl:<code>`:

| Code | Caller action |
|---|---|
| `denied` | Stop; new authority needed |
| `needs-approval` | Wait on the approval ID (`kl:needs-approval:a-…`) and retry |
| `not-found`, `invalid`, `conflict` | Fix the request |
| `expired`, `revoked` | Request a new grant |
| `budget` | Budget exhausted; ask the human |
| `integrity` | Verification failed; treat as a security event |
| `unavailable` | Retry with backoff |
| `unsupported` | Feature level or platform lacks support |
| `internal` | Bug; report |

## Interfaces at a glance

| Schema | Main interfaces | Implemented by |
|---|---|---|
| `common.capnp` | `Digest`, `Ref`, `Fd`, `Label`, `Token`, `ByteStream`, `Watcher(T)` | (types) |
| `warden.capnp` | `Supervisor`, `Process` | warden |
| `broker.capnp` | `Broker`, `Approval` | broker |
| `prompt.capnp` | `TrustedPrompt` | atrium |
| `ledger.capnp` | `Ledger` | ledger |
| `vault.capnp` | `Vault` | vault |
| `gate.capnp` | `Gate`, `Intent` | gate |
| `depot.capnp` | `Depot` | depot |
| `courier.capnp` | `Courier` | courier |
| `strata.capnp` | `Strata`, `Transaction` | strata |
| `config.capnp` | `Config`, `Plan` | config |
| `hearth.capnp` | `Hearth` | hearth |
| `bench.capnp` | `Bench`, `Vm` | bench |
| `aide.capnp` | `Aide`, `AgentSession`, `AgentHost` | aide |
| `net.capnp`, `devd.capnp`, `journal.capnp`, `portals.capnp`, `compat.capnp` | `Net`, `Devd`, `Journal`, portals, `Compat` | net, devd, journal, portals, compat |
| 22 system-interface files (`warden-sys` … `vouch-sys`) | `ServiceHost`, `GrantMounts`, `BrokerSystem`, `LabelAuthority`, `HearthSeal`, `StrataTxn`, `ShimEndpoint`, … | See [System interfaces](system-interfaces.md) |

## Limitations

- Cap'n Proto RPC level 1 has no three-party handoff, so a capability passed from A to C through B is proxied by B. Interfaces are designed so that handles which matter for performance are fds, which the kernel passes directly.
- Inside a capwire peer, the 4 MiB datagram limit and the 64-fd limit are hard. Bulk transfer uses fds.

## Related

- [Identifiers](identifiers.md)
- [Versioning](versioning.md)
- [System interfaces](system-interfaces.md)
- [Registries](registries.md)
- [ADR-0044: vsock control and a userspace NIC](../11-decisions/adr-0044-vsock-control-and-userspace-nic.md)
- [Authority flow](../02-architecture/authority-flow.md)
- [ADR-0004: capwire, no system bus](../11-decisions/adr-0004-capwire-no-system-bus.md)
