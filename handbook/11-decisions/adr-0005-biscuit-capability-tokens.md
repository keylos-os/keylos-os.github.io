# ADR-0005: Biscuit capability tokens

> Authority is expressed as Biscuit v3 tokens: Ed25519-signed, offline-attenuable, with Datalog facts and checks from a fixed vocabulary. broker holds the root keys and turns tokens into kernel-enforced resources.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Security | broker, gate, warden, aide, devd, vault, sdk |

## Context

- Agents and apps need delegated, narrowable authority: "this repo, read-only network to these hosts, for 30 minutes, at most $5". Sub-agents must get strictly less.
- Macaroons support attenuation, but rely on a shared secret and HMAC chains, with weaker structure for policy. Biscuit uses public-key signed append-only blocks with Datalog checks that can only add caveats (https://www.biscuitsec.org/).
- 2025–2026 agent-identity drafts converge on attenuable tokens. Chained Biscuits cost about 340–380 bytes per hop (https://arxiv.org/pdf/2603.24775). UCAN explicitly offers no confinement and treats revocation as a last resort (https://github.com/ucan-wg/spec).
- OAuth token exchange (RFC 8693) records who acted, not the constraints at each hop. It is used only at the external boundary.

## Decision

- Biscuit v3, through `keylos-biscuit`.
- A fixed authority vocabulary (protocols §8.2): `principal`, `session`, `root_id`, `right(kind, resource, op)`, `path_root`, `net`, `budget`, `expires`, `tier_floor`, `max_depth`, `max_fanout`, `label_ceiling`, `persist`.
- Attenuation checks over ambient facts (protocols §8.3).
- Tokens are bearer-like but bound to a principal fact. broker and gate check `principal` against the caller's pidfd-derived identity, so a stolen token is useless to another principal.
- Tokens never outlive a boot ([ADR-0040](adr-0040-per-boot-token-keys.md)).
- External services get RFC 8693 / RFC 8707 down-scoped tokens minted at gate.

## Alternatives considered

| Option | Why not |
|---|---|
| Macaroons | Shared-secret verification; less expressive caveats |
| UCAN | No confinement; DID ecosystem is not needed locally |
| JWT with scopes | No offline attenuation; scope strings are not a policy language |
| Kernel-only capabilities (fds) | fds cover materialized resources but not budgets, delegation depth or host/method rules; tokens describe, fds enforce |

## Consequences

### Positive
- Delegation to sub-agents is cryptographically narrowing.
- Budgets, expiry and fan-out live in the same object as rights.

### Negative
- Datalog evaluation cost on every materialization (microseconds; cached per token and resource).
- Two representations of authority (token and fd) that must stay consistent. Revocation handles holders ([ADR-0041](adr-0041-revocation-kills-or-freezes.md)).

### Follow-ups
- Track the IETF agent-token drafts and keep an adapter layer for external interop.

## Related

- [Tokens](../04-contracts/tokens.md)
- [Capabilities and broker](../06-security/capabilities-and-broker.md)
- [ADR-0006: Cedar policy](adr-0006-cedar-policy.md)
