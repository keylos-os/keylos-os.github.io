# Desktop

> atrium is the keylos Wayland compositor and desktop shell. It admits each app as a known principal, offers it only the protocols its tier allows, draws every window's identity frame itself, and owns the trusted path for approvals, presence, login and lock.

Status: **specified (v1.0)**. Normative spec: [atrium/spec.md](../../specs/atrium/spec.md).

## Layout of the screen

```
┌ keystrip ─────────────────────────────────────────────────────────────────────────────┐
│ 🛡 integrity · ▣ Editor (t1) · ● camera: Meet · ⚑ 2 approvals · ◎ 1 agent · 14:32       │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ ┌─ Editor · notes.md ─────────────────────[internal/user]─ …K1C ┐  ┌─ Browser (VM) ──┐ │
│ │                                                               │  │  blue frame     │ │
│ │                                                               │  │                 │ │
│ └───────────────────────────────────────────────────────────────┘  └─────────────────┘ │
│ panel: launcher · windows · notifications                                             │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

- **Keystrip**: always visible, including over fullscreen apps. Status, the focused principal, capture indicators, pending approvals and agent activity. Clicking it opens trusted surfaces only.
- **Identity frames**: compositor-drawn. Tier colour, display name from the verified manifest, label badge, session chip. The app's own title is secondary text.
- **Panel and launcher**: trusted shell clients. The launcher lists installed app generations from depot.

## How an app gets on screen

![Process tree and tiers](../images/process-tree-and-tiers.svg)

1. `warden` spawns the app principal and asks atrium for a client socket bound to that principal.
2. atrium creates the socket, and `warden` binds it into the app's view as `/run/user/<uid>/wayland-0`.
3. On connect, atrium checks the peer's pidfd against the principal. A socket passed to another process is useless.
4. The client sees only the globals allowed for its class:

| Class | Who | Notable differences |
|---|---|---|
| trusted | atrium's own shell, terminal and portal UI | layer-shell, toplevel management |
| t1 | Native apps | Standard desktop protocols; clipboard focus-bound; no screencopy, data-control or virtual input |
| t2 | Apps in microVMs (via bench's cross-domain proxy) | Same as t1; content is labelled untrusted |
| legacy-x | Per-app Xwayland for X11 apps | xwayland-shell for that Xwayland only |
| assistive | Screen readers and similar (T3 grant) | Toplevel list |
| ime | Input-method engines | input-method and virtual-keyboard to the focused text field only |

## Trusted surfaces

Everything that asks for a decision is drawn by atrium itself. See [Trusted path](../06-security/trusted-path.md).

| Surface | Opens from |
|---|---|
| Greeter, lock | Boot, idle, lid, SAK |
| Secure overview | `Ctrl+Alt+Delete` |
| Approval and presence prompts | broker, config, depot, courier |
| Approvals centre | Keystrip badge |
| Agents panel | Keystrip agent indicator: sessions, progress, review |
| Security centre | Keystrip shield: grants, receipts, integrity status, devices, captures |

## Windows from other worlds

| Source | How it appears |
|---|---|
| Tier-2 VM apps | Through crosvm's cross-domain Wayland proxy; blue frame; GPU via virtio-gpu native context, so the VM imports buffers and the host shares no GPU state beyond buffer import |
| X11 apps | Per-app rootless Xwayland inside the legacy sandbox; amber frame; one X server per legacy principal, so X clients cannot snoop each other |
| Workbench consoles | `work` and agent sessions in atrium-term; violet frame |

## Clipboard and drag-and-drop

- Reads only by the focused window, within a second of your input.
- atrium proxies all data. Apps never receive each other's file descriptors.
- **Labels travel with the content:** pasting untrusted text into an app raises that app's session label. If that would complete the Rule of Two for an agent's console, the paste is refused.
- Pasting into the terminal shows a preview when the content is untrusted or contains newlines or control characters.
- Dropped files arrive as fds created by the file portal, never as paths.

## Settings

| Kind | Where it goes |
|---|---|
| Personal (wallpaper, theme, keyboard, displays, night light) | Your atrium settings subvolume; snapshotted, undoable |
| System (users, network, security policy, updates) | A config proposal → `Plan` → presence prompt → signed config generation |

## Performance targets

| Metric | Target |
|---|---|
| Frame composition p99 | ≤ 4 ms on integrated GPUs |
| Added input latency | ≤ 1 frame + 2 ms |
| Prompt visible | ≤ 100 ms |
| Lock | ≤ 150 ms |
| Greeter visible after service start | ≤ 1.5 s |

## Limitations

- No X11 server outside the legacy tier; window managers, panels and screenshot tools built for X11 or wlroots privileged protocols do not work.
- Apps that rely on screencopy or data-control (clipboard managers, some screenshot tools) need the portal path instead.
- One seat per machine in 1.0.
- GPU kernel drivers remain shared attack surface for tier-1 apps (see [Residual risks](../06-security/residual-risks.md)).

## Related

- [Trusted path](../06-security/trusted-path.md)
- [Portals and the powerbox](portals-and-powerbox.md)
- [Accessibility and internationalisation](accessibility-and-i18n.md)
- [Legacy apps](legacy-apps.md)
- [atrium spec](../../specs/atrium/spec.md)
