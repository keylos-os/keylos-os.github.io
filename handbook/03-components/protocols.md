# protocols

> The only coupling allowed between keylos repositories. It defines identifiers, the capwire IPC protocol and every Cap'n Proto interface (including the tier-0 system interfaces), signed document formats and presence signatures, the capability-token vocabulary, the Cedar schema, labels, effects, the code-integrity contract, the registries and the shared formats.
> Every other spec copies the parts it uses word for word and cites the section.

**Status:** specified (v1.0) · **Spec:** [`protocols/spec.md`](../../specs/protocols/spec.md)

## Role

`protocols` is a contract repository. It ships no daemon. It produces:

| Artifact | Content |
|---|---|
| `schema/*.capnp` | Normative Cap'n Proto schemas for all inter-component interfaces (§7.3) and system interfaces (§7.5) |
| `wit/keylos-effects` | WIT package for effect renderer components (§20.15) |
| `jsonschema/*.json` | JSON Schemas for manifest, cmdsig, receipt, mandate, seal, configgen, revocations, drv |
| `vectors/` | Conformance vectors: ids, dsse, presence, manifest, biscuit, capwire, labels, cedar, receipts, boottrust, release, vbu, the §20 formats, tpm (§17) |
| `keylos-ids` | Identifier parsing and formatting, ULIDs, fs-verity digest computation |
| `keylos-formats` | JCS, DSSE sign and verify, typed document structs with validation |
| `keylos-capwire` | Cap'n Proto `VatNetwork` over `SOCK_SEQPACKET` with SCM_RIGHTS fd sidecars |
| `keylos-schemas` | Generated Rust bindings |
| `keylos-biscuit` | Token vocabulary builders and authorizer helpers |
| `keylos-labels` | Label lattice and Rule-of-Two evaluator |
| `keylos-presence` | Presence signature construction and verification, owner-registry replay |
| `keylos-tpm-registry` | Constants and templates for every TPM object in §19.6 |

## What it fixes

| Area | Section | Summary |
|---|---|---|
| Platform baseline | §2 | x86-64-v2 and aarch64, UEFI + TPM 2.0, kernel feature levels KL1–KL3, LSM order, lockdown (no hibernation), KVM, Rust TCB |
| Identifiers | §3 | `sha256:`/`fsv256:` digests, typed refs (`obj`, `gen`, `src`, `drv`, `rcpt`, `key`), principal grammar, ULID-based IDs, time |
| Cryptography | §4 | Ed25519, ECDSA P-256 for TPM/HSM, `fido2-es256`/`fido2-eddsa` presence signatures, SHA-256, AES-256-GCM / XChaCha20-Poly1305, Argon2id, rustls; no in-kernel signature checks of store content |
| Signed documents | §5 | DSSE envelopes over JCS payloads, trust roots, presence signatures over the DSSE PAE hash (rpId `keylos.owner`) |
| Manifest | §6 | `keylos.manifest/1`, generation kinds (including `part`), capability diff, agent templates |
| capwire | §7 | Wire protocol, routes and facets, capwire-vsock profile, all interfaces, system interfaces (§7.5), errors, `Extensible` versioning |
| Tokens | §8 | Biscuit v3 authority vocabulary, attenuation checks, revocation |
| Confinement | §9 | Baseline, tiers, `kl-exec` code integrity and its map contract, IPE second layer, confinement report |
| Layout | §10 | Host and disk layout, UIDs, cgroups, xattrs, environment, log records |
| Supply chain | §11 | Derivations, source refs, realisation attestations, transparency logs, owner seal, revocations |
| Commands | §12 | `keylos.cmdsig/1`, argument fd passing, pipe protocol |
| Receipts | §13 | Receipt payload, submitted-form signatures, checkpoints and the NV counter |
| Labels and effects | §14 | Label lattice, Rule of Two, effect kinds, approval tiers, mandates |
| Config statement | §15 | `keylos.configgen/1` and the anti-rollback counter |
| Policy | §16 | Cedar schema, decision mapping, `@tier`, `@presence`, `@orgApproval`, `@channels` |
| Registries | §19 | Service names, facets, receipt events, media types, vsock ports, TPM objects ([Registries](../04-contracts/registries.md)) |
| Shared formats | §20 | Boot trust set, presence purposes, owner registry, seal window, VBU, release, generation statement, consent, exception, secret delivery, flow proof, merge manifest, first-boot bundle, proof bundle, renderer WIT |

## Interfaces

`protocols` defines interfaces but implements none of them. The owners are:

| Schema | Interface | Implemented by |
|---|---|---|
| `warden.capnp` | `Supervisor`, `Process` | [warden](warden.md) |
| `broker.capnp` | `Broker`, `Approval` | [broker](broker.md) |
| `prompt.capnp` | `TrustedPrompt` | [atrium](atrium.md) |
| `ledger.capnp` | `Ledger` | [ledger](ledger.md) |
| `vault.capnp` | `Vault` | [vault](vault.md) |
| `gate.capnp` | `Gate`, `Intent` | [gate](gate.md) |
| `depot.capnp` | `Depot` | [depot](depot.md) |
| `courier.capnp` | `Courier` | [courier](courier.md) |
| `strata.capnp` | `Strata`, `Transaction` | [strata](strata.md) |
| `config.capnp` | `Config`, `Plan` | [config](config.md) |
| `hearth.capnp` | `Hearth` | [hearth](hearth.md) |
| `bench.capnp` | `Bench`, `Vm` | [bench](bench.md) |
| `aide.capnp` | `Aide`, `AgentSession`, `AgentHost` | [aide](aide.md) |
| `net.capnp` | `Net` | [net](net.md) |
| `devd.capnp` | `Devd` | [devd](devd.md) |
| `journal.capnp` | `Journal` | [journal](journal.md) |
| `portals.capnp` | `ScreenCapture`, `Camera`, `Microphone`, `OpenUri`, `Notify`, `Print`, `Clipboard`, `Location`, `Accessibility` | [portals](portals.md) |
| `compat.capnp` | `Compat` | [compat](compat.md) |

The 22 system-interface files of §7.5 (`warden-sys` … `vouch-sys`) are listed in [System interfaces](../04-contracts/system-interfaces.md) and on each serving component's page.

## Rules

- A change to a schema is a protocols release. Additions are minor versions. Removals or renumbering need a new file ID and a major version ([Versioning](../04-contracts/versioning.md)).
- If an embedded copy in another spec disagrees with `protocols`, `protocols` wins.
- Every repo states the protocols version it conforms to and runs the relevant vectors in CI.
- All crates are `#![forbid(unsafe_code)]`, except the ancillary-data handling in `keylos-capwire`.

## Key decisions

- [ADR-0001: Multi-repo, protocols is the only coupling](../11-decisions/adr-0001-multi-repo-protocols-only-coupling.md)
- [ADR-0004: capwire, no system bus](../11-decisions/adr-0004-capwire-no-system-bus.md)
- [ADR-0005: Biscuit capability tokens](../11-decisions/adr-0005-biscuit-capability-tokens.md)
- [ADR-0006: Cedar policy](../11-decisions/adr-0006-cedar-policy.md)

## Related

- [Contracts](../04-contracts/README.md)
- [Capwire](../04-contracts/capwire.md)
- [Identifiers](../04-contracts/identifiers.md)
- [Signed documents](../04-contracts/signed-documents.md)
- [Versioning](../04-contracts/versioning.md)
- [System interfaces](../04-contracts/system-interfaces.md)
- [Registries](../04-contracts/registries.md)
