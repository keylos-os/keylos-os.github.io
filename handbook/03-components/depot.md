# depot

> The content-addressed store. depot keeps every file as an fs-verity object and every installable unit as a composefs generation (an EROFS metadata image whose fs-verity digest is its identity).
> It installs, verifies, mounts and garbage-collects generations, computes capability diffs on update, attaches owner seals, and applies revocation lists.

**Status:** specified (v1.0) · **Spec:** [`depot/spec.md`](../../specs/depot/spec.md)

![Store and composefs](../images/store-composefs.svg)

## Responsibilities

- **Objects:** `/store/objects/<2>/<62>` with fs-verity enabled and mode 0444. One object store for the OS, runtimes, apps, agent templates, language packages and data.
- **Generations:** `/store/gens/<digest>.erofs`, each carrying `/.keylos/manifest.json` and optionally cmdsig, SBOM and provenance.
- **Install:**
  - from `oci://` (zstd:chunked partial fetch), `tuf:<stream>/<name>`, or a local path;
  - verify signatures, the realisation quorum and tlog inclusion;
  - compute the capability diff against the installed version;
  - require consent for any widening.
- **Mount:** `Depot.mount` returns an `fsmount` fd (composefs, `verity=require`), only for the warden, boot, bench and compat facets.
- **Seal:** attach a `keylos.seal/1` statement signed by the owner-seal key.
- **Launchability:** a generation is launchable when its generation statement (`keylos.genstmt/1`) verifies against the boot trust set (release stream, publisher or owner-seal keys), it is not revoked, and any capability widening has a consent record. warden then registers its mount with `kl-exec`.
- **GC:** roots per holder (profiles, running principals, courier pins). Count- and age-based retention.
- **Revocations:** apply `keylos.revocations/1` (`unlaunchable`, `evict`, `warn`).
- **Grafts:** emergency graft generations are marked `grafted` and replaced automatically when the real rebuild lands.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Depot` (`depot.capnp`) | Facets `user`, `mounter`, `forge`, `config`, `compat`, `courier`, `admin` |
| Consumes | courier `CourierResolver` (facet `depot`) | depot never speaks TUF itself |
| Consumes | hearth `HearthSeal` (facet `seal`) | Seal statements for owner-sealed generations |
| Consumes | `keylos-tlog` library | Inclusion proofs in provenance bundles |
| Consumes | gate | Registry and mirror fetches |
| Consumes | atrium `TrustedPrompt` | Capability-diff consent (`keylos.consent/1`) |
| Consumes | ledger (facet `writer`) | Receipts |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| depot | `user` | `shell`, atrium, aide, portal-openuri, portal-discovery, gate, any principal granted `depot#user` | `get`, `list`, `install`, `verify`, `revocations`, `revocationStatus`, `openObject` (closures the caller may spawn), `openPath` (`/.keylos/…` only) |
| depot | `mounter` | warden, bench, compat | `mount` (container generations only while rooted by `cri:pod:…`), `get`, `root`, `unroot`, `revocationStatus` |
| depot | `forge` | forge | `importTree`, `seal`, `get` |
| depot | `config` | config | `importTree` (kinds `config`, `policy`), `mount` (kind `config`), `get` |
| depot | `compat` | compat | `importTree` (kind `legacy-image`), `get`, `revocationStatus` |
| depot | `courier` | courier | `install`, `root`, `unroot`, `get`, `list`, `revocations` |
| depot | `cri` | cri | `install` (sources `oci+container://` and `tuf:`), `get`, `list`, `root`, `unroot` |
| depot | `admin` | config, owner `shell` (T3) | all incl. `gc` |
| depot | `loom` | loom | `get`, `openPath` (`/.keylos/manifest.json`, `/.keylos/workflows/*`), `revocationStatus`, `root`/`unroot` (holder prefix `loom:` only) |
<!-- /generated:facets -->

## Runs as

A t0 service with exclusive write access to `/store` (except `/store/rcpt`). It uses `FS_IOC_ENABLE_VERITY` and composefs image creation.

## State

| Path | Content |
|---|---|
| `/store/objects/` | Objects |
| `/store/gens/` | Generation images |
| `/store/db/` | Index: names, versions, roots, seals, consents, revocations |

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `gen.install`, `gen.seal`, `gen.revoke`, `gen.gc`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Key decisions

- [ADR-0007: composefs + fs-verity store](../11-decisions/adr-0007-composefs-fsverity-store.md)
- [ADR-0042: One store for language ecosystems](../11-decisions/adr-0042-one-store-for-language-ecosystems.md)
- [ADR-0043: Non-reproducible means tier 2](../11-decisions/adr-0043-non-reproducible-means-tier-2.md)
- [ADR-0018: Grafts are temporary](../11-decisions/adr-0018-grafts-are-temporary.md)

## Related

- [Manifest](../04-contracts/manifest.md)
- [Supply chain](../05-integrity/supply-chain.md)
- [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md)
