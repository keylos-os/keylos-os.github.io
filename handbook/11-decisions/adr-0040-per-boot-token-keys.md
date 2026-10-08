# ADR-0040: Per-boot token keys; persistent grants are re-minted

> broker generates a fresh Biscuit root keypair at every boot. Tokens never outlive a boot. Persistent grants are stored as grant records (signed when they come from T3 approvals) and re-minted into new tokens at boot, after re-evaluating the current policy.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Security | broker, gate, aide, devd, vault |

## Context

- Long-lived bearer tokens accumulate, leak and are hard to revoke.
- Policy changes should apply to existing persistent grants. A grant made under an old policy shouldn't survive a stricter one.
- Reboot is already the point where "reboot heals" restores integrity, so tokens should follow.

## Decision

- The root key exists in broker memory only, created at boot.
- Grant records live in `/var/lib/broker/grants/`: resource, rights, caveats, origin approval, `onRevoke`. At boot, broker re-evaluates each record against current policy and re-mints the ones that still pass.
- Revocations are in-memory and persisted until the next boot (protocols §8.4).
- Services that cache tokens must handle `kl:expired` and `kl:revoked` after restart.

## Alternatives considered

| Option | Why not |
|---|---|
| Long-lived root key | Larger blast radius; revocation lists grow forever |
| Per-session keys | Too many keys for cross-session delegation |

## Consequences

### Positive
- Automatic expiry of all authority at reboot. Policy changes take effect on persistent grants.

### Negative
- Apps must re-acquire tokens after reboot (the SDK does it transparently from grant records).

## Related

- [Tokens](../04-contracts/tokens.md)
- [broker](../03-components/broker.md)
- [ADR-0041: Revocation kills or freezes](adr-0041-revocation-kills-or-freezes.md)
