# Principals and identity

> A principal in keylos is an actor (app, service, agent, legacy image, workbench or shell) acting for a human in a session. Its identity comes from the kernel and from the generation it was launched from, never from what it claims.
> Every running principal gets its own UID and cgroup, so the kernel itself can tell principals apart.

**Status:** specified (v1.0). Grammar: [protocols §3.4](../../specs/protocols/spec.md). Allocation: warden. Humans: [hearth](../../specs/hearth/spec.md).

## Anatomy of a principal

```
agent:gen:fsv256:9e1f…c2@alice/s-01JB6Q8Z0RXQ4M3W9V2N7T5K1C/s-01JB6R2D…
└─actor──────────────────┘ └human┘ └session─────────────────┘ └child session┘
```

| Part | Values | Meaning |
|---|---|---|
| Actor | `app:<gen>`, `service:<name>:<gen>`, `agent:<gen>`, `legacy:<gen>`, `bench:<gen>`, `shell`, `kernel` | What is running, identified by the **digest of its sealed generation** |
| Human | Username, or `_system` | Who is accountable |
| Session chain | `s-<ULID>` … | Where it came from. Each delegation appends a session, and authority can only shrink along the chain |

Identity by generation digest means:
- An app's identity changes when its bytes change. ACLs and grants that should survive updates match on **name + publisher key** instead.
- Two copies of the same app run by different humans are different principals.
- A sub-agent started by an agent is a child principal with the parent's chain plus one session, and gets only attenuated authority.

## Kinds of principals

| Kind | Runs in | Typical authority | Notes |
|---|---|---|---|
| `shell` | Host, trusted terminal | The human's own scope; can ask for anything | The only principal that can type into host interpreters |
| `app` | Host tier t1, or VM tier t2 | Own data, powerbox grants, manifest-declared hosts | Identity = app generation |
| `service` | Host tier t0 | Routed capabilities from manifests | System services under `_system` |
| `agent` | Workbench VM (tier t3) | Attenuated grants from the launching human, staged effects, budgets | Never holds secret values; never signs as the human |
| `legacy` | Tier L view (host or VM) | Like apps, through the open broker | Unmodified Linux binaries |
| `bench` | Workbench VM | Project shares, network via gate | Developer environments |

## How a service knows who is calling

```
warden: socketpair; caller end → caller, service end → service
warden → service: ServiceHost.accept(socket, connectionId, facet, peer, tier, generation)
service (optional): Supervisor.connectionInfo(connectionId) → (peer, facet, tier, label, generation)
```

- Services MUST NOT ask the socket who the peer is: on a warden-created socketpair `SO_PEERPIDFD` and `SO_PEERCRED` name warden, not the caller. Nor do PIDs, executable paths or fields inside messages count ([protocols §7.1](../../specs/protocols/spec.md#71-model)). `SO_PEERPIDFD` is meaningful only for sockets the peer itself `connect()`ed, such as atrium's Wayland sockets.
- Inside a VM, guest processes are not host principals: the VM principal is the cgroup of its VMM process, and host endpoints identify the VM by its vsock CID.
- `warden` creates every connection and tags it with a **facet**: a server-defined restriction such as `vault#app` or `vault#admin`, registered in [protocols §19.2](../../specs/protocols/spec.md#192-facets). A principal cannot reach a facet it wasn't routed to.
- PID reuse cannot confuse anyone, because pidfds pin the process.

## UIDs and cgroups

| Range | Who |
|---|---|
| 0 | Kernel threads and `warden` only |
| 1000–59999 | Humans (`hearth`) |
| 0x00100000–0x0FFEFFFF | One dynamic UID per running principal instance (`warden`), quarantined 60 s after exit |
| 0x0FFF0000 | Reserved on-disk owner of `_cluster` data (pod volumes) |
| 0x10000000–0x7FFEFFFF | 65 536-UID blocks for legacy user namespaces |

Each principal also has its own cgroup:

```
/keylos.slice/system.slice/<service>.scope
/keylos.slice/user-<uid>.slice/{shell,apps,agents,benches,legacy}.slice/<session>.scope
```

That gives per-principal resource limits, kill and freeze, and an unforgeable mapping from process to principal ([ADR-0024](../11-decisions/adr-0024-dynamic-uids-per-principal.md)).

## Humans and owners

- Humans are created by `hearth`. Each has a record, a home subvolume and vault slots ([Users and homes](../08-state/users-and-homes.md)).
- **Owners** are humans whose FIDO2 credentials are in the **owner registry**. That is a hash-chained list anchored in a TPM NV index and carried in every config generation.
- Owners alone can apply configuration, seal code, approve persistent grants and change policy, each with a physical touch ([ADR-0011](../11-decisions/adr-0011-owner-presence-fido2.md)).
- Several owners are possible, with quorum rules for adding and removing owners.

There is **no root user** in userspace, no `sudo` and no setuid binaries ([ADR-0023](../11-decisions/adr-0023-no-root-no-setuid.md)). Administrative changes are transactions that an owner signs.

## Sessions

- `hearth.login` creates the human's root session after authentication. `warden` accepts that session ID for a `shell` principal only after `hearth` validates it.
- Every spawn creates a child session. The broker registers it with the parent's **label** (taint is inherited) and with tokens delegated from the parent.
- When a session ends, the broker revokes its non-persistent roots.

## Limitations

- Principal identity is only as strong as the kernel. A kernel exploit can forge anything until reboot.
- Identity says *what* is running, not whether it is benign. Benign-ness is the job of sealing, rebuild quorum and review.

## Related

- [Capabilities and the broker](capabilities-and-broker.md)
- [Confinement tiers](confinement-tiers.md)
- [Labels and the Rule of Two](labels-and-rule-of-two.md)
- [Users and homes](../08-state/users-and-homes.md)
- [hearth spec](../../specs/hearth/spec.md) · [broker spec](../../specs/broker/spec.md) · [protocols §3.4, §7.1](../../specs/protocols/spec.md)
