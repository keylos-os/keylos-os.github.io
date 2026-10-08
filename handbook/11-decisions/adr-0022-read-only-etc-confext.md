# ADR-0022: Read-only /etc via signed confext generations

> `/etc` is the read-only merge of a config generation. A config generation is a composefs image built from Nickel source, signed by owner presence with a `keylos.configgen/1` statement whose counter must equal the TPM NV config counter plus one. boot refuses config generations below the NV value.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | State / integrity | config, boot, warden, all services |

## Context

- Mutable `/etc` is how malware persists and how configs drift. With [ADR-0008](adr-0008-host-executes-only-sealed-code.md), configuration is the main remaining persistence vector after code.
- systemd-confext merges `/etc` images over overlayfs and makes `/etc` read-only while merged (https://uapi-group.org/specifications/specs/extension_image/).
- Authenticated encryption doesn't stop an offline attacker restoring an older valid config. A monotonic counter does.

## Decision

- Each config generation is a composefs image with a `keylos.configgen/1` statement signed by owner presence.
- `counter = NV(0x01300101) + 1` at signing. config increments the NV counter only after the signed generation is durably in the store. boot selects the highest-counter statement with `counter ≥` the NV value that verifies against the owner registry, and otherwise boots the safe config shipped in the OS generation.
- `/var` holds only small, schema-checked, non-executable runtime state.
- Revert creates a *new* generation with the old content and the next counter, so history moves forward.

## Alternatives considered

| Option | Why not |
|---|---|
| Mutable /etc + drift detection | Detection after the fact; persistence possible |
| Config inside the OS image | Every config change becomes an OS release |
| Signing without a counter | Rollback to old, weaker configs |

## Consequences

### Positive
- Runtime root can't make persistent config changes. Reboot restores the signed config.

### Negative
- Every persistent config change needs a touch.
- Apps that write their own config get mutable per-app layers ([config adopt](../08-state/config-generations.md)).

## Related

- [Reboot heals](../05-integrity/reboot-heals.md)
- [Config apply diagram](../08-state/config-generations.md)
- [ADR-0021: Nickel configuration](adr-0021-nickel-configuration.md)
