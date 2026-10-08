# ADR-0039: Secrets never in environment variables; agents never see raw secrets

> Secrets travel only as sealed `memfd_secret` fds from vault, as per-unit credentials for services, or as signing operations inside vault. warden rejects secret-like environment variables at spawn. For agents, gate injects credentials at the proxy, so the agent holds a handle, never the value.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Security | vault, gate, warden, aide, sdk |

## Context

- Environment variables leak through `/proc/<pid>/environ`, child processes, crash dumps and logs.
- The Nx "s1ngularity" attack leaked more than 2,000 secrets by having agents search local files and environments (https://www.wiz.io/fr-fr/blog/s1ngularitys-aftermath).
- Prompt injection can exfiltrate any secret value the model has seen.
- `memfd_secret` pages are removed from the kernel direct map (https://man7.org/linux/man-pages/man2/memfd_secret.2.html). systemd credentials give services per-unit, non-swappable secrets (https://man7.org/linux/man-pages/man1/systemd-creds.1.html).

## Decision

- `Vault.open` returns a read-only, sealed `memfd_secret`. Services get credentials in a private directory at start.
- warden rejects env names matching policy secret patterns (`*_TOKEN`, `*_KEY`, `*_SECRET`, `*PASSWORD*`, configurable).
- Agents: `Vault.inject` (gate facet) gives gate an opaque handle. gate adds `Authorization` headers or performs SSH signatures. The agent never receives the value.
- SSH: vault acts as the agent, with per-host approval and no forwarding.
- journal redacts secret patterns as a safety net.

## Alternatives considered

| Option | Why not |
|---|---|
| Env vars with care | Leaks are structural |
| Files with permissions | Same-UID reads, snapshots, backups |
| Give agents scoped tokens directly | Still exfiltratable values |

## Consequences

### Positive
- Secrets can't be exfiltrated by an injected agent that never saw them. Fewer leak paths everywhere.

### Negative
- Apps must use the SDK or file-based credentials, and some legacy tools need wrappers.

## Related

- [Secrets](../06-security/secrets.md)
- [vault](../03-components/vault.md)
- [Network egress](../06-security/network-egress.md)
