# fleet

> Optional organisation management. A fleet server distributes signed policy and configuration overlays to enrolled machines, collects attestation quotes and ledger checkpoints (acting as a witness), and reports compliance.
> It never gets root-equivalent control: the machine owner's presence still signs every applied config generation, unless the owner delegates that role to an organisation key at enrolment, which is recorded and visible.

**Status:** specified (v1.0) · **Spec:** [`fleet/spec.md`](../../specs/fleet/spec.md)

## Responsibilities

- **Enrolment:** a machine joins with an EK-certified attestation key and a machine identity key. The owner chooses a delegation mode:

  | Mode | Who signs config generations |
  |---|---|
  | `advisory` | The owner, after reviewing org proposals |
  | `delegated` | The org key may sign config generations within a scoped schema subset, recorded in the configgen statement |
- **Policy distribution:** Cedar policy fragments and Nickel overlays as signed bundles, applied through [config](config.md) proposals.
- **Attestation:** periodic TPM quotes over PCR0–15 checked against release-log predictions. Alerts on unknown generations or PCR drift.
- **Witnessing:** cosign ledger checkpoints and detect split views.
- **Reporting:** generations in use, update status, revocation compliance, agent budget usage (aggregated).

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | Fleet server HTTPS API | Enrolment, policy bundles, quotes, checkpoints |
| Provides | `FleetCompliance`, `OrgDecider` (`fleet-sys`) | Machine-side `fleet` service; facets `client`, `gate`, `decider` |
| Consumes | config `ConfigFleet` (facet `fleet`) | Fleet policy modules (effective after an owner-signed apply) |
| Consumes | ledger `LedgerWitness` (facet `witness`), journal `Metrics` (facet `fleet`) | Checkpoint witnessing; aggregate metrics without user data |
| Consumes | `keylos-tlog` | Witness protocol |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| fleet | `client` | owner `shell`, atrium | `FleetCompliance.status` |
| fleet | `gate` | gate | `FleetCompliance.complianceToken` |
| fleet | `decider` | broker | `OrgDecider` |
| fleet | `cluster` | cri | `FleetCluster` (`joinChallenge`, `joinAttested`, `clusterCertificate`, `kubeletCertificate`) |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`fleet-sys.capnp`](../../specs/protocols/spec.md#7521-fleet-syscapnp) | `0xc7a1e5d3b2f40034` | `FleetCompliance`, `OrgDecider`, `FleetCluster` |
<!-- /generated:sysif -->

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `fleet.enrol`, `fleet.unenrol`, `fleet.policy.apply`, `fleet.command`, `fleet.attest`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Runs as

The server runs on organisation infrastructure. The agent is a t0 service whose network goes through [gate](gate.md).

## Key decisions

- [ADR-0011: Owner presence via FIDO2](../11-decisions/adr-0011-owner-presence-fido2.md)
- [ADR-0031: Receipts ledger](../11-decisions/adr-0031-receipts-ledger.md)
- [ADR-0015: Verify before unlock](../11-decisions/adr-0015-verify-before-unlock.md)

## Related

- [Fleet](../10-operations/fleet.md)
- [Attestation and vouch](../05-integrity/attestation-and-vouch.md)
