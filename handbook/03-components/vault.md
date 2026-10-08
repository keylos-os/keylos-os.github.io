# vault

> The secrets broker. vault stores secrets with per-item ACLs keyed to the caller's generation identity (never a PID, path or bus name). It hands secrets out as sealed `memfd_secret` fds, signs with keys that never leave it, runs a per-principal SSH agent, and holds the wrapped data keys that make crypto-shredding possible.
> Agents never see raw secret values: [gate](gate.md) injects credentials at the proxy.

**Status:** specified (v1.0) · **Spec:** [`vault/spec.md`](../../specs/vault/spec.md)

## Responsibilities

- Store items: name, kind, value, ACL (`actors`, `ops`, `prompt` policy `never|perSession|always|presence`).
- Identify callers through the peer warden names in `ServiceHost.accept` → generation digest. Facets limit what each caller sees (`app`, `admin`, `strata`, `gate`).
- Deliver: `open` returns a read-only, sealed `memfd_secret`. Values never travel in environment variables or argv.
- Sign: `sign` with Ed25519, P-256 or SSH key types. `sshAgent` returns a per-principal agent socket with per-host approval and no forwarding.
- Receipts and logs never contain secret values.
- Delivery: `open` returns a `memfd_secret` fd laid out as a u64 length prefix plus the value, readable only through `mmap`; a sealed memfd is the fallback (protocols §20.10).
- Inject: on the `gate` facet, `inject` returns an opaque handle so gate can add `Authorization` headers or SSH signatures for agents.
- Crypto-shred units: `dataKey` and `forget` (strata facet) manage per-unit data keys wrapped by the keystore key.
- Unwrap: the master keys come from the TPM (policy includes PCR15) plus the login secret, or from FIDO2 `hmac-secret`.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Vault` (`vault.capnp`) | Facets `app`, `admin`, `broker`, `gate`, `strata`, `ledger`, `aide`, `net`, `adapter` |
| Provides | `VaultUsers` (`vault-sys`) | Facet `hearth` |
| Consumes | `Supervisor.identify` | Caller identity |
| Consumes | atrium `TrustedPrompt` | Prompts and presence per ACL |
| Consumes | TPM NV `0x01300104` (keystore floor), `0x01300110`/`0x01300111` (epoch, two alternating indices); key `0x81000103` at first boot | Rollback protection; first-boot seed |
| Consumes | ledger (facet `writer`) | Receipts |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| vault | `app` | apps (per `needs.secrets`), `shell`, legacy, bench-relay (for its VM principal, §7.5.10 `GuestPortals.secret`) | `open`, `store`, `delete`, `list`, `sign`, `sshAgent` (own items) |
| vault | `admin` | owner `shell` | all `app` methods incl. ACL updates |
| vault | `broker` | broker | `open` on behalf of a principal |
| vault | `gate` | gate | `inject`, `open("inject:…")`, `dataKey`/`forget` for `gate:` units |
| vault | `strata` | strata | `dataKey`, `forget` |
| vault | `ledger` | ledger | `dataKey`, `forget` for `ledger:` units |
| vault | `aide` | aide | `store`/`delete`/`sign` of session keys; `dataKey`/`forget` for `aide:` units |
| vault | `hearth` | hearth | `VaultUsers` |
| vault | `net` | net | `open`/`store` of `_system` items of kinds `wifi` and `token` |
| vault | `adapter` | compat | `store` (import from legacy secret stores, on the human's behalf, with prompt) |
| vault | `journal` | journal | `dataKey`, `forget` for `journal:` units |
| vault | `loom` | loom | `dataKey`, `forget` for `loom:` units |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`vault-sys.capnp`](../../specs/protocols/spec.md#754-vault-syscapnp) | `0xc7a1e5d3b2f40023` | `VaultUsers` |
<!-- /generated:sysif -->

## Runs as

A t0 service with exclusive access to `/keystore`. It has a TPM handle and no network.

## State

| Path | Content |
|---|---|
| `/keystore/vault/` | Encrypted item store (AES-256-GCM, AAD = item name + owner) |
| `/keystore/units/` | Wrapped crypto-shred unit keys |

`/keystore` is the `@keystore` subvolume and is **excluded from all snapshots**.

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `secret.open`, `secret.store`, `secret.delete`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Key decisions

- [ADR-0039: Secrets never in env](../11-decisions/adr-0039-secrets-never-in-env.md)
- [ADR-0032: Crypto-shredding](../11-decisions/adr-0032-crypto-shredding.md)
- [ADR-0024: Dynamic UIDs per principal](../11-decisions/adr-0024-dynamic-uids-per-principal.md)

## Related

- [Secrets](../06-security/secrets.md)
- [Crypto-shredding](../08-state/crypto-shredding.md)
- [Network egress](../06-security/network-egress.md)
