# atrium

> The Wayland compositor and desktop shell, built on Smithay. atrium owns the trusted path: approval prompts, presence prompts, secret prompts and the trusted terminal are drawn by the compositor in a way no client can overlay or imitate.
> It tags client connections with the security-context protocol, keeps privileged protocols away from sandboxed clients, and frames every window with its tier and principal.

**Status:** specified (v1.0) · **Spec:** [`atrium/spec.md`](../../specs/atrium/spec.md)

## Responsibilities

- **Compositor:**
  - Wayland only, with the security-context protocol;
  - screencopy and data-control protocols denied to sandboxed clients;
  - per-app nested Xwayland for legacy X11 apps (via [compat](compat.md));
  - Wayland proxying for tier-2 VMs.
- **Trusted path:** implements `TrustedPrompt`:
  - `approve` renders effects, diffs and provenance;
  - `presence` shows the purpose during a FIDO2 touch;
  - `notify`.
  A secure-attention key always reaches the compositor.
- **Window decoration:** a tier and principal colour band on every surface, so clients can't fake system UI.
- **Desktop shell:** greeter (hearth login facet), panels, launcher, notifications, lock screen, settings front-end (proposes config plans), agent console.
- **Trusted terminal:** the only terminal whose pty counts as interactive human input for host interpreters.
- **Accessibility:** the compositor-mediated a11y tree is exposed through the portals `Accessibility` interface to assistive-tech principals only.
- **Input:** input methods and keyboard layouts. Input injection is limited to authorised principals.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `TrustedPrompt` (`prompt.capnp`) | Facets `approve` (broker), `presence`, `notify` |
| Provides | `Display`, `A11yHost`/`A11yObserver`, `Screencast`/`ShortcutsHost`/`IndicatorHost` | protocols §7.5.16–§7.5.18 |
| Provides | Wayland, security-context tagged per client class | Apps, tier-2 proxies, per-app Xwayland |
| Consumes | hearth (facets `greeter`, `atrium`, `admin`) | Login, unlock, presence after a trusted prompt |
| Consumes | warden (facets `launcher`, `trusted-terminal`) | `UserSpawn`, `TrustedSpawn` |
| Consumes | broker `BrokerSystem.registerApprover`, `LabelAuthority` | Approver key; labels on drag-and-drop and clipboard hand-offs |
| Consumes | portal-files `FilePicker.confirmDrop` (facet `drop`) | Drag-and-drop grants |
| Consumes | vouch `VouchLink` (facets `settings`, `approvals`) | Phone pairing, routed approvals |
| Consumes | devd (facets `atrium`, `service`), net `NetCaptive` (`status`, `signIn`) | Backlight, power events, the "Sign in to network" action (net starts the captive VM) |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| atrium | `approve` | broker | `TrustedPrompt.approve` |
| atrium | `presence` | config, depot, courier, hearth, forge | `TrustedPrompt.presence` |
| atrium | `notify` | tier-0 services, portal-notify | `TrustedPrompt.notify` |
| atrium | `secret` | hearth, vault | `TrustedPrompt.secret` |
| atrium | `broker` | broker | `Display.windowOwner` |
| atrium | `display` | warden, bench, compat | `Display` (`xwaylandWm`: compat only) |
| atrium | `settings` | atrium settings app | `Display.outputs` |
| atrium | `bridge`, `native` | a11y bridge, AccessKit apps | `A11yHost` |
| atrium | `portal-screen`, `portal-shortcuts`, `portal-camera`, `portal-mic`, `portal-location`, `portal-background` | the corresponding portal | `Screencast` / `ShortcutsHost` / `IndicatorHost` |
| atrium | `portal-a11y` | portal-a11y | `A11yGate` |
| atrium | `portal-inhibit` | portal-inhibit | `InhibitHost` |
| atrium | `portal-clipboard` | portal-clipboard | `ClipboardHost` |
| atrium | `ctl` | atrium-ctl | atrium-local control |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`display.capnp`](../../specs/protocols/spec.md#7516-displaycapnp) | `0xc7a1e5d3b2f4002f` | `Display` |
| [`a11y.capnp`](../../specs/protocols/spec.md#7517-a11ycapnp) | `0xc7a1e5d3b2f40030` | `A11yApp`, `A11yHost`, `A11yObserver`, `A11yGate` |
| [`screencast.capnp`](../../specs/protocols/spec.md#7518-screencastcapnp) | `0xc7a1e5d3b2f40031` | `Screencast`, `ShortcutsHost`, `IndicatorHost`, `ClipboardHost`, `InhibitHost` |
<!-- /generated:sysif -->

## Runs as

A t0 service with DRM master and input device fds granted by devd. It uses the GPU through the host kernel driver.

## Key decisions

- [ADR-0034: Wayland-only, trusted path](../11-decisions/adr-0034-wayland-only-trusted-path.md)
- [ADR-0028: Approval tiers](../11-decisions/adr-0028-approval-tiers.md)

## Related

- [Desktop](../09-experience/desktop.md)
- [Trusted path](../06-security/trusted-path.md)
- [Approvals](../07-agents/approvals.md)
- [Accessibility and i18n](../09-experience/accessibility-and-i18n.md)
