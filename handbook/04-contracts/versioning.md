# Versioning

> Contracts evolve by compatible additions. Breaking changes need a new schema file ID and a protocols major version.
> Every keylos service reports which protocols version it implements, and every repo proves conformance with the shared test vectors.

**Status:** specified (v1.0) · **Normative source:** [protocols §7.4](../../specs/protocols/spec.md#74-versioning), [§17](../../specs/protocols/spec.md#17-conformance)

## What may change

| Change | Allowed in | Notes |
|---|---|---|
| New struct field (next ordinal) | Minor | Old readers ignore it; give it a safe default |
| New method (next ordinal) | Minor | Old servers return `unimplemented`, which callers must handle |
| New enumerant | Minor | Readers MUST treat unknown enumerants as "unknown", not as a crash |
| New document field | Minor, only with an `x-` prefix or a schema bump | Strict validation rejects unknown non-`x-` fields |
| New effect kind, event type, facet, media type, vsock port, TPM object or Biscuit fact | Minor | Registries ([protocols §19](../../specs/protocols/spec.md#19-registries)) are additive |
| Repo-local schema or event | No protocols release | Repo-local schemas use file IDs outside the reserved `0xc7a1e5d3b2f4xxxx` range; repo-local events are named `x-<repo>.<event>` and listed in the repo spec. Nothing outside the repo may consume them |
| Rename, renumber, remove, change a type | Major | New file ID for the schema |
| Change in canonicalisation or signing rules | Major | Affects every signature |

Documents carry their version in the media type (`version=1`) and in `schema` (`keylos.manifest/1`). A v2 document type coexists with v1 for at least one stable release.

## Version discovery

Every bootstrap capability implements `common.Extensible`, whose `version()` returns `(protocols, implementation)`. Clients use it to:
- avoid calling methods the server doesn't have;
- show versions in `kish` diagnostics;
- fail closed with `kl:unsupported` instead of guessing.

## Conformance vectors

`protocols/vectors/` holds the shared suites:

| Suite | Checks |
|---|---|
| `ids/` | Identifier parsing |
| `dsse/` | Signature verification and JCS rejection |
| `presence/` | FIDO2 presence envelopes: valid, wrong rpId, missing UP/UV, removed credential |
| `manifest/` | Validation (including agent and compat sections) and capability diffs |
| `biscuit/` | Vocabulary and authorizer decisions |
| `capwire/` | Datagram and fd-index handling; fd rejection on the vsock profile |
| `labels/` | Propagation and the Rule of Two |
| `cedar/` | Decisions including `@tier`, `@presence`, `@orgApproval` and `@channels` |
| `receipts/` | Hash chain, submitted-form reconstruction, checkpoints and the NV counter |
| `boottrust/` | Trust sets and generation statements for `kl-exec` registration |
| `release/` | Release statements, release-log proofs, floor semantics |
| `vbu/` | Verify-before-unlock QR payloads and quotes |
| `firstboot/`, `consent/`, `seal/`, `flowproof/`, `fsmerge/`, `tlogproof/` | The shared formats of protocols §20 |
| `tpm/` | The TPM registry as machine-readable JSON |

Each repo runs the suites for the formats it touches in CI, and states its protocols version in its release notes.

## Release cadence

- `protocols` releases first. Other repos bump their dependency when they need new contracts.
- The [keylos](../03-components/keylos.md) distribution pins one protocols version per OS generation, and its system conformance suite runs across all components at that version.

## Related

- [Capwire](capwire.md)
- [Contracts](README.md)
- [ADR-0001: Multi-repo, protocols is the only coupling](../11-decisions/adr-0001-multi-repo-protocols-only-coupling.md)
