# hearth

> Users, homes and the owner's presence. hearth manages human accounts and their encrypted home subvolumes, login and lock, and FIDO2 credentials. It turns a physical touch into a DSSE envelope signed by the `owner-presence` key.
> Every action that must be the owner's own (config apply, seal, policy change, T3 mandates) ends at `Hearth.presence`.

**Status:** specified (v1.0) · **Spec:** [`hearth/spec.md`](../../specs/hearth/spec.md)

## Responsibilities

- **Accounts:** allocate human UIDs `1000–59999`, keep user records, and mark exactly which users are owners.
- **Homes:** a btrfs subvolume per user. Per-app subvolumes `.apps/<app>/{config,data,cache,state}` are created on first launch. Unlock keys come from TPM + password or FIDO2 `hmac-secret`.
- **Login and lock** (greeter facet used by [atrium](atrium.md)):
  - password (Argon2id), FIDO2, recovery key;
  - lock on suspend and idle;
  - keystore unwrap keys are dropped on lock.
- **Presence:**
  - Perform a FIDO2 assertion over `sha256(purpose || payload)` and return a DSSE envelope.
  - Run the owner seal gate: each sealing window takes one FIDO2 `hmac-secret` assertion with two salts, which unlocks the per-owner NV seal gate (`0x01300140+i`) whose auth satisfies the `PolicySecret` on the owner-seal key (`0x81000140+i`), and rotates the gate auth when the window closes.
  - Support sealing windows of at most 10 minutes, scoped to one project.
- **Enrolment:** add or remove FIDO2 credentials. Adding one requires presence from an existing owner key.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Hearth` (`hearth.capnp`) | Facets `greeter`, `presence`, `atrium`, `admin` |
| Provides | `HearthSystem`, `HearthSeal`, `HearthAdmin` (`hearth-sys`) | Facets `system`, `seal`, `admin` |
| Consumes | atrium `TrustedPrompt.presence` | The purpose is shown on the trusted path during a touch |
| Consumes | devd (FIDO2 hidraw) | Authenticators |
| Consumes | vault `VaultUsers` (facet `hearth`) | Per-user keystore slots |
| Consumes | strata `StrataHomes`, `StrataAdmin.lockUnits`/`unlockUnits` (facet `hearth`) | Homes and unit locking |
| Consumes | warden `PrincipalControl.terminate` (facet `hearth`) | Ending a human's sessions |
| Consumes | TPM NV `0x01300105`, `0x01300106`, `0x01300140+i`; keys `0x81000140+i` | Owner registry head, login failures, seal gates, owner-seal keys |
| Consumes | ledger (facet `writer`) | Receipts |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| hearth | `greeter` | atrium greeter and lock screen | `users`, `login`, `unlock`, `lock` |
| hearth | `presence` | broker, config, depot, courier, ledger, vault, aide, strata | `presence`; `HearthQuorum.request`/`collect` |
| hearth | `atrium` | atrium | `presence` (prompt already shown by atrium) |
| hearth | `admin` | owner `shell`, atrium settings | all `Hearth`; `HearthAdmin` (including `setQuorumPolicy`); `HearthQuorum.collect`, `list` |
| hearth | `system` | warden, devd, config, broker, gate, vouch, strata, bench, depot, ledger, loom | `HearthSystem` (gate, vouch, strata, bench, depot, ledger: `owners` only; loom: `owners`, `userState`, `watchUsers`) |
| hearth | `seal` | depot, forge | `HearthSeal` |
| hearth | `tpm` | courier, vault, strata, ledger, config, vouch, fleet | `HearthTpm` (`defineSpace`, `recreateKey`: the object's registered owner; `sbSign`, `sbAccepted`: courier; `activateCredential`: vouch, fleet) |
| hearth | `quorum` | fleet | `HearthQuorum.submit`, `list` |
| hearth | `fleet-lock` | fleet | `HearthFleet` |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`hearth-sys.capnp`](../../specs/protocols/spec.md#753-hearth-syscapnp) | `0xc7a1e5d3b2f40022` | `HearthSystem`, `HearthSeal`, `HearthAdmin`, `HearthTpm`, `HearthQuorum`, `HearthFleet` |
<!-- /generated:sysif -->

## Runs as

A t0 service with FIDO2 hidraw access granted by devd, a TPM handle, and the strata `admin` facet.

## State

| Path | Content |
|---|---|
| `/var/lib/hearth/users/` | User records (JSON, signed by the host key) |
| `/keystore/hearth/` | Wrapped home keys, credential IDs |

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `user.login`, `user.lock`, `user.create`, `user.delete`, `key.enroll`, `key.remove`, `presence.assert`, `seal.window`, `quorum.request`, `quorum.complete`, `guest.start`, `guest.end`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Key decisions

- [ADR-0011: Owner presence via FIDO2](../11-decisions/adr-0011-owner-presence-fido2.md)
- [ADR-0012: Sealing windows](../11-decisions/adr-0012-sealing-windows.md)
- [ADR-0023: No root, no setuid](../11-decisions/adr-0023-no-root-no-setuid.md)

## Related

- [Users and homes](../08-state/users-and-homes.md)
- [Principals and identity](../06-security/principals-and-identity.md)
- [Key ceremonies](../10-operations/key-ceremonies.md)
