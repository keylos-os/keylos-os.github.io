# net

> Host networking. net configures links, Wi-Fi (through a confined iwd), DNS with DoT/DoH and DNSSEC validation, WireGuard VPNs, the host firewall (nftables, generated) and NTS-authenticated time.
> It serves the host. Sandboxed principals never see the network directly; they reach it through [gate](gate.md).

**Status:** specified (v1.0) · **Spec:** [`net/spec.md`](../../specs/net/spec.md)

## Responsibilities

- **Links:** Ethernet, Wi-Fi and WWAN with DHCPv4/v6 and SLAAC. Metered-link detection. Captive-portal detection, with the portal shown in a tier-2 browser view.
- **Wi-Fi:** iwd runs confined in its own D-Bus island. Credentials are stored in [vault](vault.md). `wifiJoin` takes the credential as an fd.
- **DNS:** a stub resolver used only by gate and tier-0 services. DoT/DoH upstreams, DNSSEC validation, per-link search domains.
- **VPN:** WireGuard profiles from configuration. Keys are in vault.
- **Firewall:** an nftables ruleset generated from config: default deny inbound, egress only from gate and net. Per-principal egress is gate's job, not the firewall's.
- **Time:** ntpd-rs with NTS. Exposes `synced`, offset and source. Components treat the clock as untrusted until the first NTS sync (protocols §3.6).

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Net` (`net.capnp`) | Facets `user`, `status` |
| Provides | `NetWatch`, `NetResolver`, `NetPlumbing`, `NetCaptive` (`net-sys`) | Facets `status`, `resolver`, `plumbing`, `captive` |
| Consumes | vault (facet `net`) | Wi-Fi PSKs, WireGuard keys |
| Consumes | devd | Network devices, rfkill |
| Consumes | ledger `timeFloor` (facet `time`) | Time floor before the first NTS sync |
| Consumes | broker `BrokerSystem.mintCaptive` | Captive-portal token |
| Consumes | atrium `TrustedPrompt` | Joining new networks when policy requires it |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| net | `user` | owner `shell`, atrium | `Net` (all); `NetWatch` |
| net | `status` | tier 0; apps declaring `net-status` | `links` (redacted), `time`, `status`; `NetWatch` |
| net | `resolver` | gate, tier-0 services with network needs | `resolve`; `NetResolver`; `NetWatch` |
| net | `captive` | atrium | `NetCaptive` (`status`, `portalUrl`, `signIn`); `NetWatch` |
| net | `plumbing` | warden, gate, cri | `NetPlumbing` (`setEgressUids`, `setLocalLinkUids`: warden; `setListenPorts`: gate); `NetPlumbingCluster` (`clusterUplink`: cri; `clusterNetns`: warden) |
| net | `discovery` | portal-discovery | `NetDiscovery` |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`net-sys.capnp`](../../specs/protocols/spec.md#7511-net-syscapnp) | `0xc7a1e5d3b2f4002a` | `NetWatch`, `NetResolver`, `NetPlumbing`, `NetCaptive`, `NetPlumbingCluster`, `NetDiscovery` |
<!-- /generated:sysif -->

## Runs as

A t0 service with `CAP_NET_ADMIN` in the host network namespace (granted by warden as a service allowance), plus a confined iwd child in a D-Bus island.

## State

| Path | Content |
|---|---|
| `/etc/keylos/net/` | Rendered network config (from the config generation) |
| `/var/lib/net/` | Leases, known-network metadata (no secrets) |

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `net.change`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Key decisions

- [ADR-0038: NTS time](../11-decisions/adr-0038-nts-time.md)
- [ADR-0035: fd-only portals and D-Bus islands](../11-decisions/adr-0035-fd-only-portals-dbus-islands.md)

## Related

- [Network egress](../06-security/network-egress.md)
- [gate](gate.md)
- [Configuration generations](../08-state/config-generations.md)
