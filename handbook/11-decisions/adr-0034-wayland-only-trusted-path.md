# ADR-0034: Wayland only, with a compositor-owned trusted path

> atrium is a Wayland compositor built on Smithay. There is no host X server. Clients are tagged through the security-context protocol, privileged protocols (screencopy, data-control) are denied to sandboxed clients, and approvals, presence and secret prompts are drawn by the compositor on a trusted path that clients can't overlay or imitate.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Experience / security | atrium, portals, compat, broker, hearth |

## Context

- Any X11 client can keylog, inject input and take screenshots. An app with an X11 socket is unconfined.
- Wayland `wp_security_context_v1` lets a sandbox engine tag connections so the compositor can deny privileged protocols (https://wayland.app/protocols/security-context-v1).
- An approval prompt that an app can draw is worthless. A trusted path needs a compositor-owned surface, a secure-attention key and visible window provenance (Qubes-style coloured borders).
- Smithay is a mature Rust compositor library, used by COSMIC.

## Decision

- atrium is the only compositor. Every client connection carries a security context naming its principal and tier.
- Sandboxed clients can't use screencopy, data-control or input-injection protocols. Capture goes through `portal-screen` (PipeWire node).
- The trusted path renders `TrustedPrompt` UIs, the presence purpose and the lock screen. A secure-attention key always reaches atrium.
- Every window shows a tier and principal colour band drawn by atrium.
- X11 apps get a per-app nested Xwayland through compat.

## Alternatives considered

| Option | Why not |
|---|---|
| Host Xwayland for all | X11 semantics leak across apps |
| Existing compositors (GNOME, KDE) | Large C/C++ codebases; trusted-path integration would be bolted on |
| Prompts drawn by broker clients | Spoofable |

## Consequences

### Positive
- Approvals and presence prompts are unspoofable by apps. Screen and clipboard access are mediated.

### Negative
- A new desktop shell to build and maintain. Some X11 apps behave worse in nested Xwayland.

## Related

- [Trusted path](../06-security/trusted-path.md)
- [Desktop](../09-experience/desktop.md)
- [atrium](../03-components/atrium.md)
