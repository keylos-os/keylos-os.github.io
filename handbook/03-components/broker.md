# broker

> The capability broker, the centre of keylos authority. broker mints and checks Biscuit tokens, evaluates Cedar policy, runs the powerbox and approvals, tracks session labels and enforces the Rule of Two, and turns tokens into fds.
> No process can reach a file, host, device, secret or service without a token that broker issued, or a capability derived from one.

**Status:** specified (v1.0) · **Spec:** [`broker/spec.md`](../../specs/broker/spec.md)

![Authority flow](../images/authority-flow.svg)

## Responsibilities

- **Tokens:** mint Biscuit v3 tokens using the protocols §8 vocabulary, with a per-boot root key. Re-mint persistent grants from grant records at boot. Attenuate, delegate (depth and fan-out limits) and revoke by root ID.
- **Policy:** evaluate every request against the Cedar policy generation. `@tier` annotations map to approval tiers. `forbid` always wins.
- **Materialization:** resolve paths with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` from held root dirfds, open devices through [devd](devd.md), sockets through [gate](gate.md), secrets through [vault](vault.md), and service capabilities through routes.
- **Powerbox:** `Broker.powerbox` asks [atrium](atrium.md)/[portals](portals.md) for a user choice. The choice itself is the grant.
- **Approvals:** build `ApprovalPrompt`s with rendered effects and argument provenance, call `TrustedPrompt.approve`, and record mandates.
- **Labels:** keep each session's `{conf, integ}` label. Raise it on every mediated read. Enforce the Rule of Two: a request that would complete U+P+X becomes a T3 declassification unless a registered flow proof applies.
- **Revocation:** invalidate the token tree, then kill or freeze holders according to the grant record's `onRevoke`.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Broker`, `Approval` (`broker.capnp`) | Facet `principal`: `request`, `materialize`, `attenuate`, `delegate`, `revoke`, `inspect`, `label`, `raiseLabel` (own session), `powerbox`, `myGrants`; `Approval.mandate` |
| Provides | `BrokerSystem`, `LabelAuthority` (`broker-sys`) | Facets `system`, `label-authority` |
| Consumes | atrium `TrustedPrompt.approve` (facet `approve`), hearth `presence` | T2/T3 approvals, presence-class decisions |
| Consumes | portal-files `FilePicker.pick` (facet `broker`) | Powerbox |
| Consumes | warden (facet `broker`) | `GrantMounts`, `PrincipalControl`, `ServiceConnect`, `FdStore` |
| Consumes | devd, gate, vault (facet `broker` each) | Materialisation back ends |
| Consumes | fleet `OrgDecider` (facet `decider`) | `@orgApproval` permits on enrolled machines |
| Consumes | ledger (facet `writer`) | Receipts |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| broker | `principal` | every principal | `Broker` |
| broker | `system` | warden, gate, aide, atrium, config, hearth, strata, net, depot, vault, vouch, cri | `BrokerSystem` (per-method callers as commented in §7.5.2; `requestFor` with the allowed-subject rule, atrium only for its own session (device authorization); `registerApprover`: atrium, vouch; `admitPod`: cri; `mintCaptive`: net); `Broker.inspect` |
| broker | `label-authority` | gate, bench, portal-*, atrium, strata, aide, journal, warden | `LabelAuthority` |
| broker | `workflow` | loom, gate, aide, strata, bench | `BrokerWorkflow` (§7.5.25): `enroll`, `claim`, `decide`, `rebind`, `resume`, `cancel`, `cancelDecision`, `record`, `raise`: loom; `authorizeEffect`, `verify`, `record`, `cancelDecision`: gate; `offer`, `verify`, `decide`, `rebind`: aide (its agent attempts); `verify`, `record`: strata, bench |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`broker-sys.capnp`](../../specs/protocols/spec.md#752-broker-syscapnp) | `0xc7a1e5d3b2f40021` | `BrokerSystem`, `LabelAuthority` |
| [`loom-sys.capnp`](../../specs/protocols/spec.md#7525-loom-syscapnp) | `0xc7a1e5d3b2f40039` | `DurableEffects`, `WorkflowBudget`, `BrokerWorkflow`, `AgentWorkflowHost`, `LoomSystem` |
<!-- /generated:sysif -->

## Runs as

A t0 service holding root dirfds for `/home` and the store view. It has no network.

## State

| Path | Content |
|---|---|
| `/var/lib/broker/grants/` | Persistent grant records (signed by the owner-presence key when they come from a T3 approval) |
| Memory only | Per-boot Biscuit root key, revocation set, session labels |
| `security.bpf.keylos.label` xattrs | Object labels it sets on writes it mediates |

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `grant.issue`, `grant.attenuate`, `grant.delegate`, `grant.revoke`, `grant.deny`, `label.raise`, `approval.request`, `approval.decide`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Key decisions

- [ADR-0005: Biscuit capability tokens](../11-decisions/adr-0005-biscuit-capability-tokens.md)
- [ADR-0006: Cedar policy](../11-decisions/adr-0006-cedar-policy.md)
- [ADR-0026: Labels and the Rule of Two](../11-decisions/adr-0026-labels-and-rule-of-two.md)
- [ADR-0028: Approval tiers](../11-decisions/adr-0028-approval-tiers.md)
- [ADR-0040: Per-boot token keys](../11-decisions/adr-0040-per-boot-token-keys.md)
- [ADR-0041: Revocation kills or freezes](../11-decisions/adr-0041-revocation-kills-or-freezes.md)

## Related

- [Capabilities and broker](../06-security/capabilities-and-broker.md)
- [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md)
- [Authority flow](../02-architecture/authority-flow.md)
- [Tokens](../04-contracts/tokens.md)
- [Cedar policy](../04-contracts/cedar-policy.md)
