# courier

> The update agent. courier fetches signed OS generations through TUF over OCI, checks transparency-log inclusion and the rebuilder quorum, predicts the next boot's PCRs, stages an A/B boot entry with boot counting, and raises the TPM version floor only after the new generation proves healthy.
> Rollback is automatic when a boot fails, and manual through `Courier.rollback`.

**Status:** specified (v1.0) · **Spec:** [`courier/spec.md`](../../specs/courier/spec.md)

![Update flow](../images/update-flow.svg)

## Responsibilities

- Track release streams (`stable`, `beta`, `dev`) with a TUF client: freshness, anti-rollback, protection from freeze attacks, threshold root.
- Verify each OS generation:
  - release-stream signature;
  - release-log inclusion against a checkpoint cosigned by at least two witnesses;
  - realisation quorum (for example `3/3`);
  - not on the revocation list.
- Fetch through [depot](depot.md): only missing objects, using zstd:chunked TOCs.
- Predict PCR0–7 for both old and new components, and install the signed PCR11 policy shipped in the UKI.
- Stage the UKI on the ESP with a boot counter (`+3-0`). After a successful boot and health check, raise the NV version floor. Otherwise systemd-boot falls back.
- Firmware updates (fwupd/LVFS metadata) with PCR handling: use vendor predictions when present, otherwise the policy is temporarily relaxed and the next unlock requires PIN plus vouch verification.
- Stage dbx and SBAT revocations safely: update db first, test, then apply dbx.
- Show the capability diff and security flags of every update.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Courier` (`courier.capnp`) | Facets `client`, `admin` |
| Provides | `CourierResolver` (`courier-sys`) | Facet `depot`: courier is the **only TUF client**; it resolves `tuf:<stream>/<name>` for depot |
| Consumes | depot (facet `courier`) | `install` (`oci://…@sha256:…#gen=fsv256:…`), `root`/`unroot`, revocations |
| Consumes | `keylos-tlog` library | Release-log and realisation-log proofs, witness cosignatures |
| Consumes | strata `StrataAdmin.preUpdate` (facet `courier`) | Snapshot set before an update |
| Consumes | vouch `VouchLink.announce` (facet `announce`) | Release staged, firmware pending |
| Consumes | atrium `TrustedPrompt` | Consent and firmware prompts |
| Consumes | TPM NV `0x01300102` (os-floor), `0x01300103` (pcrlock-policy) | Version floor and PCR0–7 policy |
| Consumes | ledger (facet `writer`) | Receipts |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| courier | `client` | humans' `shell`s, atrium | `check`, `status` |
| courier | `admin` | owner `shell`, atrium settings, config | `Courier` (all) |
| courier | `depot` | depot | `CourierResolver` |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`courier-sys.capnp`](../../specs/protocols/spec.md#756-courier-syscapnp) | `0xc7a1e5d3b2f40025` | `CourierResolver` |
<!-- /generated:sysif -->

## Runs as

A t0 service with access to the ESP mount, TPM NV (version-floor index) and the depot facet `courier`. Network goes only through [gate](gate.md) to the configured mirrors.

## State

| Path | Content |
|---|---|
| `/var/lib/courier/tuf/` | TUF metadata cache |
| ESP `/EFI/Linux/` | UKIs with boot-counter suffixes |
| TPM NV version floor | Raised after a healthy boot |

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `update.stage`, `update.commit`, `update.rollback`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Key decisions

- [ADR-0017: TUF over OCI](../11-decisions/adr-0017-tuf-over-oci.md)
- [ADR-0014: TPM+PIN and signed PCR policy](../11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md)
- [ADR-0016: Rebuilder quorum and transparency logs](../11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md)
- [ADR-0018: Grafts are temporary](../11-decisions/adr-0018-grafts-are-temporary.md)

## Related

- [Updates and rollback](../10-operations/updates-and-rollback.md)
- [Supply chain](../05-integrity/supply-chain.md)
- [Boot chain](../05-integrity/boot-chain.md)
