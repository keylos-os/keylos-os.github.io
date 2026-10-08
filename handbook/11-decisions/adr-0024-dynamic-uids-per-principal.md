# ADR-0024: Dynamic UIDs per principal instance

> warden gives every running principal instance (each app, service, agent session and legacy process tree) its own UID from `0x00100000–0x0FFEFFFF` and its own cgroup. UIDs are quarantined for 60 seconds after release. Same-human apps can't ptrace, signal or read each other.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Security | warden, broker, vault, journal, strata |

## Context

- In classic Unix, all of a user's apps share one UID. Same-UID ptrace, `/proc/pid/mem`, LD_PRELOAD and file access defeat per-app secret ACLs (the Secret Service problem).
- Android uses one UID per app. systemd `DynamicUser` allocates transient UIDs for services.
- Peer identity must be derivable from the kernel: pidfd → cgroup → principal.

## Decision

- warden allocates a UID per principal instance and records the (UID, cgroup) ↔ principal mapping. `Supervisor.identify` exposes it.
- Human UIDs `1000–59999` are used only for file ownership in homes and for `shell` sessions. App processes run as their dynamic UID. Access to their `.apps/<name>` subvolumes uses idmapped mounts or ACLs set by strata.
- 60-second quarantine after release prevents identity confusion from UID reuse.
- Legacy user-namespace blocks are separate (`0x10000000+`, 65536 each).

## Alternatives considered

| Option | Why not |
|---|---|
| One UID per human | Same-UID attacks |
| Static UID per app name | Collisions across versions and instances; no per-session isolation for agents |
| LSM labels only, same UID | Works, but UID separation gives defence in depth for free |

## Consequences

### Positive
- The kernel enforces isolation between apps of the same human.
- Identity for capwire peers is unambiguous.

### Negative
- File ownership mapping needs idmapped mounts or ACL management.
- Tools that assume `getuid()` = human need adaptation (handled by the legacy tier).

## Related

- [Principals and identity](../06-security/principals-and-identity.md)
- [Names, paths and IDs](../13-reference/names-paths-and-ids.md)
- [ADR-0025: Namespaces only by warden](adr-0025-namespaces-only-by-warden.md)
