# vouch

> The owner's phone companion. Before you type your disk PIN, vouch checks the laptop's TPM quote against the published release predictions and your enrolled state, and shows green or red.
> It also witnesses ledger checkpoints, receives approval requests the owner chose to route to the phone, and lets you verify a machine remotely.

**Status:** specified (v1.0) · **Spec:** [`vouch/spec.md`](../../specs/vouch/spec.md)

![Verify before unlock](../images/verify-before-unlock.svg)

## Responsibilities

- **Pairing:** done during the [installer](installer.md) ceremony. Stores the machine's EK chain, attestation key, machine identity key and enrolled pcrlock state.
- **Verify before unlock:**
  1. The initrd shows a QR code with a nonce request.
  2. vouch answers with a fresh nonce (QR, BLE or NFC).
  3. The initrd shows the TPM2 quote over PCR0–15.
  4. vouch verifies the AK certification, the nonce, and the PCR values against release-log predictions (via [tlog](tlog.md)) and the enrolled firmware state.
  5. vouch shows the result.
- **Fallback:** TOTP-style codes sealed to PCRs, for when no camera or radio is available.
- **Runtime attestation:** periodic quotes, including PCR10 integrity measurements, to detect persistence across reboots.
- **Witness:** cosign ledger checkpoints and alert on split views or counter regressions.
- **Remote approvals (optional):** T2/T3 prompts routed to the phone, presented as the effect rendering. Presence still requires a FIDO2 touch (phone passkey or security key).

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `VouchLink` (`vouch-sys`) on the machine-side `vouch` service | Facets `settings`, `approvals`, `announce` |
| Consumes | VBU protocol (protocols §20.5) from [boot](boot.md) | Offline QR exchange; AK0 quotes |
| Consumes | `keylos-tlog`, release statements (protocols §20.6) | PCR predictions and checkpoints |
| Consumes | ledger `LedgerWitness` (facet `witness`) | Checkpoint cosigning |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| vouch | `settings` | atrium settings, owner `shell` | `VouchLink` pairing methods, `phones`, `remove`, `inheritance` |
| vouch | `approvals` | atrium | `VouchLink.routeApproval` |
| vouch | `announce` | courier | `VouchLink.announce` |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`vouch-sys.capnp`](../../specs/protocols/spec.md#7522-vouch-syscapnp) | `0xc7a1e5d3b2f40035` | `VouchLink` |
<!-- /generated:sysif -->

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `vouch.pair`, `vouch.remove`, `vouch.witness.cosigned`, `vouch.witness.conflict`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Runs as

A mobile app for Android and iOS. The verifier core is a Rust library shared with [fleet](fleet.md).

## Key decisions

- [ADR-0015: Verify before unlock](../11-decisions/adr-0015-verify-before-unlock.md)
- [ADR-0031: Receipts ledger](../11-decisions/adr-0031-receipts-ledger.md)

## Limitations

- vouch trusts the TPM vendor's EK chain. fTPM certificate chains are inconsistent across vendors.

## Related

- [Attestation and vouch](../05-integrity/attestation-and-vouch.md)
- [Boot chain](../05-integrity/boot-chain.md)
