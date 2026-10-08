# ADR-0056: Defined behaviour for long offline periods

> When fresh metadata stops arriving, keylos keeps working but tightens: updates pause when TUF metadata expires; after 30 days without a fresh revocation list, new third-party installs need T3, imported legacy images go to tier 2, and agents need T2 to reach new hosts. Time comes from NTS or the ledger's time floor, never from an unauthenticated clock.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Supply chain / operations | courier, depot, broker, gate, aide, ledger, net, protocols |

## Context

- Freshness is a security property. TUF timestamps expire so a mirror can't freeze a client on old, vulnerable metadata ([ADR-0017](adr-0017-tuf-over-oci.md)). Revocation lists only help if they arrive.
- Machines do go offline for long periods: travel, air-gapped labs, ships, field work. Bricking them when metadata expires would be worse than the attack it prevents.
- Without authenticated time, expiry checks can be defeated by moving the clock. keylos takes time from NTS and never accepts a clock earlier than the ledger's last checkpoint ([ADR-0038](adr-0038-nts-time.md)).

## Decision

([protocols §14.5](../../specs/protocols/spec.md#145-operating-rules)) Let *revocation age* be the time since the newest verified revocation list, measured against trusted time.

| Condition | Behaviour |
|---|---|
| TUF timestamp expired | Updates pause; installed generations keep launching; status shows the revocation age |
| Revocation age > 30 days | Installing a new third-party generation needs T3; newly imported legacy images get tier ≥ 2; agent egress to hosts not contacted before by that template needs T2; `offline_days(n)` is available to policy |
| Any time | Generation statements with an `issued` time later than trusted time + 24 h are rejected |

- `ledger` provides the time floor (`LedgerAdmin.timeFloor`). `net` disciplines time by NTS.
- Policy may tighten further using `offline_days`, for example forbidding payments after 7 days offline.

## Alternatives considered

| Option | Why not |
|---|---|
| Refuse to launch anything once metadata expires | Bricks offline machines; users disable security to get work done |
| Ignore freshness when offline | Lets a freeze or replay attack keep a machine on revoked code indefinitely |
| Trust the local clock | Moving the clock defeats every expiry |

## Consequences

### Positive
- Offline machines remain usable, with risk increasing where it matters: new code and new destinations.
- Behaviour is predictable and visible in status.

### Negative
- After 30 days offline, routine installs need extra approval.
- Air-gapped deployments should ship revocation lists by sneakernet (signed TUF metadata on media) to reset the age.

## Related

- [Updates and rollback](../10-operations/updates-and-rollback.md)
- [Supply chain](../05-integrity/supply-chain.md)
- [ADR-0046: courier is the only TUF client](adr-0046-courier-sole-tuf-client.md)
