# Contracts

> keylos repositories are coupled only through the contracts in [protocols](../../specs/protocols/spec.md): identifiers, the capwire IPC protocol and its Cap'n Proto interfaces, the system interfaces, signed document formats, the token vocabulary, the Cedar schema, labels and effects, the registries and the shared formats.
> The pages in this section explain those contracts and why they are shaped the way they are. The spec is normative; these pages are companions.

## Pages

| Page | Explains | Spec section |
|---|---|---|
| [Capwire](capwire.md) | Cap'n Proto RPC over `SOCK_SEQPACKET` with fd passing, routes, facets, peer identity, errors | [§7](../../specs/protocols/spec.md#7-capwire-the-ipc-protocol) |
| [Identifiers](identifiers.md) | Digests, typed refs, names, principal IDs, session and other IDs, time | [§3](../../specs/protocols/spec.md#3-identifiers) |
| [Signed documents](signed-documents.md) | DSSE over JCS, media types, algorithms, trust roots | [§4](../../specs/protocols/spec.md#4-cryptography), [§5](../../specs/protocols/spec.md#5-signed-documents) |
| [Manifest](manifest.md) | The `keylos.manifest/1` generation manifest and capability diffs | [§6](../../specs/protocols/spec.md#6-generation-manifest) |
| [Tokens](tokens.md) | Biscuit v3 vocabulary, attenuation checks, revocation | [§8](../../specs/protocols/spec.md#8-capability-tokens) |
| [Cedar policy](cedar-policy.md) | The `Keylos` Cedar schema and decision mapping to approval tiers | [§16](../../specs/protocols/spec.md#16-cedar-policy-schema) |
| [Receipts](receipts.md) | Receipt payloads, submitted-form signatures, checkpoints | [§13](../../specs/protocols/spec.md#13-receipts), [§19.3](../../specs/protocols/spec.md#193-receipt-events) |
| [Command signatures and pipes](cmdsig-and-pipes.md) | `keylos.cmdsig/1`, argument fd passing, record pipes | [§12](../../specs/protocols/spec.md#12-command-signatures-keyloscmdsig1) |
| [System interfaces](system-interfaces.md) | The 22 schema files tier-0 services use with each other | [§7.5](../../specs/protocols/spec.md#75-system-interfaces) |
| [Registries](registries.md) | Service names, facets, receipt events, media types, vsock ports, TPM objects | [§19](../../specs/protocols/spec.md#19-registries) |
| [Versioning](versioning.md) | How contracts evolve, conformance vectors, compatibility promises | [§7.4](../../specs/protocols/spec.md#74-versioning), [§17](../../specs/protocols/spec.md#17-conformance) |

## Contract rules

| Rule | Why |
|---|---|
| Every cross-repo contract lives in `protocols` | One place to review, version and test |
| Repo-local interfaces and formats are allowed only when no other repo consumes them | Anything consumed across repos belongs in `protocols` |
| Other specs embed the parts they use **verbatim**, citing the section | Each repo can be implemented from its own `spec.md` alone |
| If an embedded copy disagrees with `protocols`, `protocols` wins | No silent forks of a contract |
| Each repo runs the conformance vectors for every format it parses or produces | Interoperability is tested, not assumed |
| Identity comes from the kernel (pidfd → warden), never from message contents | Messages can lie; the kernel can't be told to |

## Related

- [protocols component](../03-components/protocols.md)
- [Dependency rules](../02-architecture/dependency-rules.md)
- [ADR-0001: Multi-repo, protocols is the only coupling](../11-decisions/adr-0001-multi-repo-protocols-only-coupling.md)
