# ADR-0038: NTS-authenticated time

> The system clock is set only from NTS-authenticated sources (ntpd-rs). Until the first NTS sync after boot, components treat wall-clock time as untrusted and use the ledger checkpoint time as a floor.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Integrity | net, ledger, broker, gate, courier, depot |

## Context

- Many keylos decisions depend on time: token `expires`, TUF timestamp freshness, certificate validity, sealing windows, approval expiry.
- Unauthenticated NTP lets a network attacker move the clock, extending expired tokens or making a frozen TUF repository look fresh.
- NTS (RFC 8915) authenticates NTP. ntpd-rs is a Rust implementation with NTS support.

## Decision

- net runs ntpd-rs with NTS-only sources by default (configurable set, at least 3).
- Before the first NTS sync, expiry checks use `max(clock, ledger checkpoint time)`. Freshness-sensitive operations (TUF updates, new persistent grants) wait for sync or fail with `kl:unavailable`.
- Large backward steps are refused after sync. Forward steps beyond a threshold are recorded in receipts.

## Alternatives considered

| Option | Why not |
|---|---|
| Plain NTP | Spoofable |
| Roughtime | Good complement, smaller deployment; may be added as a cross-check |
| RTC only | Drift; CMOS reset attacks |

## Consequences

### Positive
- Time-based security decisions resist network attackers.

### Negative
- Offline machines run without a trusted clock. Freshness-sensitive operations pause.

## Related

- [net](../03-components/net.md)
- [Identifiers: Time](../04-contracts/identifiers.md)
