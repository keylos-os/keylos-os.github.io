# ADR-0023: No root in userspace, no setuid, no sudo

> Only warden (PID 1) runs with UID 0. Tier-0 services get narrow, declared kernel capabilities and fds, never root. There are no setuid or setgid binaries (the store refuses those mode bits) and no `sudo`. Administrative change is a transaction a human signs with presence.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Security | warden, depot, config, hearth, all services |

## Context

- `sudo` and setuid binaries are a decades-long source of local privilege escalation and grant all-or-nothing authority.
- Root is ambient authority over everything, including other users' data and keys.
- In keylos, what admins do is change config, install generations, grant capabilities and manage devices. Each of these is already a specific, auditable operation on a service.

## Decision

- UID 0 is used only by kernel threads and warden.
- Tier-0 services run as dynamic UIDs with declared allowances: specific capabilities (for example `CAP_NET_ADMIN` for net), device fds and facets.
- depot rejects files with the setuid/setgid bits or file capabilities (`security.capability` xattrs) when building generations. Mounts use `nosuid` everywhere.
- Administrative actions: `config` plans (presence), `depot install` (consent and capability diff), broker grants (tiers), `courier` updates.
- Time-limited elevated grants are capability tokens with `expires`, never a root shell.

## Alternatives considered

| Option | Why not |
|---|---|
| sudo with policy | Still root; policy files are another config to compromise |
| polkit | D-Bus-based ambient authority; complex JS rules |
| doas / run0 | Smaller, but still root |

## Consequences

### Positive
- Removes a whole class of local privilege escalation. Every privileged act is specific and receipted.

### Negative
- Legacy tools expecting root work only inside legacy user namespaces or workbenches.
- Recovery needs the recovery environment, not "boot to root shell".

## Related

- [Principals and identity](../06-security/principals-and-identity.md)
- [warden](../03-components/warden.md)
- [ADR-0024: Dynamic UIDs per principal](adr-0024-dynamic-uids-per-principal.md)
