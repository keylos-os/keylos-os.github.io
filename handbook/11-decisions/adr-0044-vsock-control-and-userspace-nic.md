# ADR-0044: vsock for control, a userspace NIC for traffic

> A workbench or tier-2 VM has exactly one virtio-net device, terminated on the host by `bench-net`, a userspace network stack that turns every guest flow into a policy-checked `ShimEndpoint.connect` on gate. Host↔guest control runs as capwire over vsock without fd passing, on registered ports only: 1024 for bench control, 1025–1535 for bulk streams, and 7002 for aide's `AgentHost` in agent VMs.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Execution / networking | bench, gate, aide, net, protocols |

## Context

- Two drafts disagreed. The bench writer chose a userspace NIC, so ordinary guest software (package managers, browsers, language toolchains) works unmodified. The gate and aide writers assumed per-service vsock ports (7001 to gate, 7002 to aide), so every guest program would need a proxy shim speaking keylos protocols.
- capwire depends on `SCM_RIGHTS` fd passing, which doesn't cross a VM boundary. A guest is also untrusted: anything it says about its own identity is a claim.
- A tap device in a host network namespace would add host kernel networking surface (netfilter, bridge) per VM and move policy into nftables, which can't filter by host name or HTTP method.
- Every extra host-facing endpoint per VM is attack surface on the host side of the VM boundary.

## Decision

- **Traffic:** one virtio-net device per VM, served by `bench-net` (a vhost-user backend running as a confined host process). It holds the VM's network tokens and maps each guest TCP or UDP flow to `ShimEndpoint.connect` / `udpAssociate` on gate (facet `shim`). DNS from the guest is answered from `ShimEndpoint.resolve`, so only granted names resolve. There is no tap device and no host network namespace for the VM.
- **Control:** the **capwire-vsock profile** ([protocols §7.2.1](../../specs/protocols/spec.md#721-capwire-vsock-profile-host--guest)): Cap'n Proto RPC over `AF_VSOCK` `SOCK_SEQPACKET`, `Fd` fields forbidden, bulk data through `ByteStream`/`ByteSource` or announced bulk ports. The host identifies the VM by the CID bench assigned; guest claims are never trusted.
- **Ports** ([protocols §19.5](../../specs/protocols/spec.md#195-vsock-ports-host-cid-2)): 1024 bench control (`benchd`), 1025–1535 bulk streams, 7002 aide `AgentHost` (forwarded by bench for agent VMs only). There is no vsock path to gate or broker; grant requests from agent VMs go through aide (`GrantDelegate`).
- TLS interception, when a grant needs method filtering or credential injection, is disclosed in the confinement report; the session CA reaches the guest through a read-only `keylos-ca` share filled from `ShimEndpoint.caBundle`.

## Alternatives considered

| Option | Why not |
|---|---|
| Per-service vsock ports (gate 7001, broker 7003) | Every guest tool would need a keylos-aware proxy; more host endpoints per VM |
| Tap device in a host netns plus nftables | Host kernel networking surface per VM; policy can't see host names or methods |
| SLIRP-style NAT without gate | Bypasses grants, labels and receipts |
| capwire with fds over vsock | fds don't cross the VM boundary |

## Consequences

### Positive
- Unmodified guest software works; policy still applies per flow with host and method granularity.
- One small, well-defined set of host endpoints per VM.
- Agent VMs and tier-2 apps share one network path, so egress rules and receipts are uniform.

### Negative
- `bench-net` is a userspace TCP/IP stack on the host side of the boundary: trusted code that must be fuzzed and confined.
- Throughput for bulk downloads is lower than a kernel bridge; caches (store mounts, package caches) reduce how much traffic is needed.

## Related

- [Sessions and workbenches](../07-agents/sessions-and-workbenches.md)
- [Network egress](../06-security/network-egress.md)
- [Capwire](../04-contracts/capwire.md)
- [ADR-0009: Unsealed code runs in workbenches](adr-0009-unsealed-code-in-workbenches.md)
- [ADR-0010: crosvm as the single VMM](adr-0010-crosvm-single-vmm.md)
