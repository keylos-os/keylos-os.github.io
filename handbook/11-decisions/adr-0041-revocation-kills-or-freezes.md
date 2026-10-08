# ADR-0041: Revocation kills or freezes holders

> Revoking a token root invalidates every token derived from it. fds that were already handed out can't be taken back from a process, so revocation also acts on the holders: by default it kills agent sessions and freezes apps (cgroup freezer) until the user decides.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Security | broker, warden, gate, aide |

## Context

- Capability systems on Linux combine tokens (descriptions) with fds (kernel handles). An fd keeps working after the token that justified it is revoked.
- Linux can't revoke an open fd in another process in general. It can close a whole process or cgroup, or freeze it.
- Revocation is most needed in emergencies: a misbehaving agent, a compromised app, a lost device grant.

## Decision

- Grant records carry `onRevoke`: `kill` (default for agents, workbenches and legacy) or `freeze` (default for apps).
- `Broker.revoke(rootId)`: mark the root revoked, refuse all materialisation and gate operations for it, then signal warden to kill or freeze every principal holding tokens from that root (tracked per materialisation).
- Frozen apps show in atrium with "resume without the grant" (restart) or "kill".
- gate closes proxied connections immediately (gate holds the other end).

## Alternatives considered

| Option | Why not |
|---|---|
| Revoke tokens only | Materialised fds stay usable |
| Proxy every file access through broker | Too slow |
| Kernel fd revocation | Not available generally |

## Consequences

### Positive
- Revocation actually stops the holder.

### Negative
- Apps can lose unsaved state when frozen grants end in a kill. The user decides for apps.

## Related

- [Capabilities and broker](../06-security/capabilities-and-broker.md)
- [ADR-0040: Per-boot token keys](adr-0040-per-boot-token-keys.md)
