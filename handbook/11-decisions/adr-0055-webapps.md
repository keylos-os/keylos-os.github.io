# ADR-0055: Installable web apps are app generations bound to one origin

> A web app is installed as an `app` generation with a `webapp` section naming its origin and scope. It runs the sealed browser-shell runtime, has its own principal and data unit, and can reach only its origin (plus declared hosts) through `gate`. Web origins are not general OS principals in v1.0. Browsers themselves are tier-1 apps with `needs.jit`, with extensions only from a pinned allowlist.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Experience / apps | depot, gate, warden, pkgs, sdk, atrium, protocols |

## Context

- For most people the browser is the main app, and web origins are the real apps: mail, documents, chat, banking.
- In one browser profile, every origin shares a process family, a cookie jar per site, and the same OS principal. The OS can't tell "the bank tab" from "a random page", and can't give the mail app a file without giving it to the whole browser.
- Browsers need JIT, which is a deliberate runtime-integrity exception ([protocols §9.3](../../specs/protocols/spec.md#93-code-integrity-host)).
- Browser extensions run code with access to every page and are a frequent supply-chain target.
- Making every origin an OS principal would need deep browser changes and break web compatibility.

## Decision

- **Browsers** are tier-1 apps with `needs.jit`. Each browser profile is a separate app data unit. Downloads are labelled `untrusted`.
- **Extensions** are allowed only from a pinned allowlist in config.
- **Web apps** ([protocols §6.3](../../specs/protocols/spec.md#63-manifest-schema-keylosmanifest1)): an `app` generation with `webapp {origin, scope, name, icons, browserRuntime}`.
  - It runs the sealed browser-shell runtime named by `browserRuntime`, restricted to `origin` through gate grants derived from `origin` and `needs.network`.
  - It has its own principal, data unit and window identity.
  - It must not declare `needs.jit`; the runtime generation does.
- The sdk packages web apps (`kl-sdk webapp`), and publishers sign them like any app.

## Alternatives considered

| Option | Why not |
|---|---|
| Every origin as an OS principal inside the browser | Requires a forked browser architecture; breaks compatibility; too large for v1.0 |
| Browser-managed PWAs only | The OS can't grant files, secrets or devices per web app; one principal for all |
| One browser instance per origin, ad hoc | No signed identity, no pinned runtime, no capability manifest |

## Consequences

### Positive
- Important web apps get OS-level separation: their own data, grants, egress limits and receipts.
- The runtime is shared and sealed, so a web app adds little storage.

### Negative
- Origins used inside an ordinary browser profile still share that profile's principal.
- Web apps that load many third-party origins need those hosts declared in `needs.network`.

## Related

- [Desktop](../09-experience/desktop.md)
- [Manifest](../04-contracts/manifest.md)
- [Network egress](../06-security/network-egress.md)
