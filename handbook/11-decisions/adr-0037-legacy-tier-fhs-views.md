# ADR-0037: Legacy tier with FHS views and an open-broker

> Unmodified Linux software runs in the legacy tier: a warden-built user namespace (nesting disabled) with an FHS view composed from store objects and an idmapped home view of granted directories only. A seccomp user-notify open-broker turns `open()` of ungranted paths into powerbox prompts. Anything downloaded from the internet or not reproducible runs in tier 2.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Compatibility | compat, warden, bench, broker, atrium |

## Context

- Without compatibility, nobody adopts a new userland. CloudABI died without an ecosystem (https://github.com/NuxiNL/cloudabi), and the Capsicum Linux port stalled (https://github.com/google/capsicum-linux).
- Nix's `buildFHSEnv` and bubblewrap show that FHS views from a store work.
- Flatpak's static `filesystem=home` is an escape: an app can write `~/.bashrc` (https://discussion.fedoraproject.org/t/flatpak-home-access-allows-trivial-privilege-escalation-what-to-do-instead/112651).
- seccomp user-notify with `ADDFD` can broker `open()` safely if the supervisor does the open itself and returns the fd. "Check then continue" is a TOCTOU risk (https://man7.org/linux/man-pages/man2/seccomp_unotify.2.html).

## Decision

- `Compat.importImage` converts OCI, Flatpak or rootfs into `legacy-image` generations (composefs).
- `Compat.run`:
  - warden builds the user namespace (65536-UID block, child `max_user_namespaces=0`), the FHS view and the idmapped granted-home view;
  - the Landlock and seccomp baseline applies;
  - X11 apps get a per-app Xwayland.
- Open-broker: unotify on `open`/`openat`/`openat2` for paths outside the view. The broker resolves with `openat2(RESOLVE_BENEATH)` from broker-held roots after a powerbox decision, and injects the fd with `ADDFD`. It never answers with CONTINUE.
- Placement: internet-sourced or non-reproducible legacy images go to tier 2 (VM).

## Alternatives considered

| Option | Why not |
|---|---|
| Static home access | Escape vector |
| Containers with unprivileged userns | Kernel surface ([ADR-0025](adr-0025-namespaces-only-by-warden.md)) |
| No legacy support | No adoption |

## Consequences

### Positive
- Existing software runs confined. Users grant access by choosing files, not by editing manifests.

### Negative
- About 10–50 µs per intercepted open. Some software breaks on missing paths or root assumptions.

## Related

- [Legacy apps](../09-experience/legacy-apps.md)
- [compat](../03-components/compat.md)
- [Port a legacy app](../12-guides/port-a-legacy-app.md)
