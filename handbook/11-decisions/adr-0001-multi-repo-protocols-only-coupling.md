# ADR-0001: Multi-repo, protocols is the only coupling

> keylos is 29 independent repositories. They share exactly one dependency, `protocols`, which defines every cross-repo contract. Each repository's `spec.md` copies the contracts it uses word for word, so it can be implemented from that file alone.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Architecture | All repositories |

## Context

- A full userland covers very different domains: boot and TPM, a store, a policy engine, a compositor, a VMM manager, an agent runtime. They have different release cadences, reviewers and risk profiles.
- The trusted computing base must stay small and auditable per component. Auditing "the OS" as one codebase is unrealistic. Auditing a 15k-line broker against a precise contract is not.
- Specs must be implementable independently and in parallel, by humans or by LLM-driven implementers that only see one repository's spec. Shared-understanding-by-osmosis does not survive that.
- Earlier operating-system efforts that grew as monorepos with implicit internal APIs (D-Bus interfaces defined by whichever daemon shipped first, ad-hoc files in `/etc`) accumulated ambient coupling that is now very hard to remove.

## Decision

1. One repository per component. 30 repos under (29 at the first draft; `cri` was added in the gaps round, ADR-0047) `github.com/keylos-os`.
2. `protocols` is the **only** shared dependency. It holds identifiers, capwire and all Cap'n Proto schemas, signed formats, token vocabulary, Cedar schema, labels, effects, layout and conformance vectors.
3. Every `spec.md` is self-contained: it embeds the protocol sections it uses verbatim, with citations. If an embedded copy and `protocols` disagree, `protocols` wins.
4. No repo links another repo's internals. Runtime interaction is only through capwire interfaces. Build-time interaction is only through published crates of `protocols` (and the SDK, which is itself a client of `protocols`).
5. Conformance vectors from `protocols` are mandatory in CI for every format a repo touches.

## Alternatives considered

| Option | Why not |
|---|---|
| Monorepo | Encourages calling internals; one review and release cadence for very different risk levels; harder to give each implementer a bounded scope |
| Multi-repo with shared "common" utility crates | Common crates become the real coupling and grow without contracts |
| Contracts in each provider's repo (provider owns its schema) | Consumers would need to read other repos' specs; cyclic version negotiation |
| Separate docs-only contract site | Not executable; no vectors; drifts |

## Consequences

### Positive
- Each component can be built, reviewed and fuzzed against a precise surface.
- Parallel implementation is possible from day one.
- Breaking changes are visible as protocols major versions.

### Negative
- Duplication: embedded contract copies must be refreshed when protocols changes. Mitigation: CI in each repo checks that its embedded blocks match the protocols version it pins (by hash).
- A contract mistake ripples to many repos. Mitigation: a strict review for protocols changes, and additive evolution only ([Versioning](../04-contracts/versioning.md)).

### Follow-ups
- A `protocols` tool that extracts and verifies embedded sections in other specs.

## Related

- [Contracts](../04-contracts/README.md)
- [Components](../03-components/README.md)
- [ADR-0004: capwire, no system bus](adr-0004-capwire-no-system-bus.md)
