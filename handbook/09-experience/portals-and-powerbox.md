# Portals and the powerbox

> Portals are the only way an app reaches shared desktop resources: your files, the screen, camera, microphone, printers, location, the clipboard and URI handlers. Each portal is its own small service and returns file descriptors, never paths. Picking something is the permission.

Status: **specified (v1.0)**. Normative spec: [portals/spec.md](../../specs/portals/spec.md).

## The powerbox

A **powerbox** is a trusted chooser that turns a human selection into a capability. keylos has two:

| Powerbox | Used by | Produces |
|---|---|---|
| kish arguments | Commands in the shell | fds plus attenuated tokens for typed paths |
| The file picker (`portal-files`) | Apps (open, save, choose folder) | `PowerboxGrant`: fd, token, display name |

![The powerbox flow](../images/powerbox.svg)

### File picker flow

1. The app calls `Broker.powerbox` with the kind (open file, open directory, save file), MIME types and a title.
2. The broker checks policy and calls the user's `portal-files` through `FilePicker.pick` ([protocols §7.5.19](../../specs/protocols/spec.md#7519-pickercapnp), portal-files facet `broker`).
3. `portal-ui`, a trusted Wayland client, shows the chooser with a header naming the requesting app, its tier and its reason.
4. The user selects. `portal-files` opens the selection beneath the user's root with `openat2(RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS)`, and checks that the opened inode is the one listed.
5. The broker mints a token (persistent if "Remember access" was ticked) and raises the app's label to the file's label. Persistent grants need presence.
6. The app receives the fd in a `PowerboxGrant`. For directories, warden also attaches the grant at `/grants/<name>` (`GrantMounts.attachGrant`, with the grant's label ceiling); `PowerboxGrant.viewPath` names it.
7. For a single file picked by a path-expecting app, the view is a **single-file view** `/grants/<name>/<basename>`: a directory served by `portal-files` that contains only the selected file plus the app's own temporary files. The parent directory is never attached, so siblings are neither listed nor readable ([ADR-0063](../11-decisions/adr-0063-single-file-grant-views.md)).

Drag-and-drop works the same way: atrium hands the dragged items to `FilePicker.confirmDrop` (facet `drop`), and the drop target receives grants, never paths.

Saving creates files with `O_CREAT | O_EXCL`. Overwriting needs an explicit confirmation in the picker.

**Safe saves in a single-file view.** Editors that save by writing a temporary file and renaming it over the original keep working: `portal-files` executes `rename(tmp → basename)` as an atomic replace in the real parent directory, whose dirfd it holds and never exposes. Every other name is refused, and a read-only grant refuses all writes. Remembered grants, re-materialization after reboot, revocation and drag-and-drop keep the same single-file scope. An app that needs the folder must ask for it with "open directory", which is a separate consent.

## Portal catalogue

| Portal | What it gives | Consent | Indicator |
|---|---|---|---|
| Files | fds for picked files and folders | Picking (T0); persistent if remembered | — |
| Screen | PipeWire streams of user-picked outputs, windows or regions (`ScreenCapture.start` returns a list) | atrium's trusted picker, every time | Keystrip, red frame dot |
| Camera | Restricted PipeWire remote with one camera node | T2 first use, persistable; T3 for agents | Keystrip |
| Microphone | Same for capture; playback-only apps get a playback route without consent | T2 / T3 for agents | Keystrip |
| Open URI | Launches the handler entrypoint (`kind: handler`) with a URI or an fd, raising the handler's label to the content's (`LabelAuthority.raiseFor`); untrusted links open in a tier-2 browser | Default handlers silent; other scheme handlers T2 first time | — |
| Notify | Attributed notifications; actions call back through a `NotifyHandler`, or launch the app's `notify-action` entrypoint | None (rate-limited) | — |
| Print | Trusted print dialog with preview; IPP Everywhere, or legacy CUPS in an island | The dialog | — |
| Clipboard | For CLI and headless apps | Focus and recent-input rule | — |
| Location | Coarse (5 km) by default; precise with a separate grant | T2 | Keystrip |
| Accessibility | The accessibility tree, for assistive technology | T3, persistent | "Assistive tech active" |
| Background | Run without windows, autostart at login | T2 | Background list |
| Global shortcuts | Shortcuts confirmed and rebindable by the user | T2 at first bind | — |
| Inhibit | Idle, suspend or logout inhibition | None (lid close: T2) | Security centre |
| Discovery | mDNS/DNS-SD browse and publish on the local link (`portal-discovery`); results raise the caller's label to integrity `untrusted` | Publishing needs a listen grant for the port | — |
| Scan | Scanners through SANE backends in a compat island (`portal-scan`); result labelled `public/user` | Trusted-path confirmation per scan | Keystrip |
| Removable media | Files from USB sticks and SD cards through the media VM ("USB: <label>" in the picker), labelled `public/untrusted` | Device authorization; writing is the `media.export` effect | — |

## Design rules

| Rule | Why |
|---|---|
| One process per portal, each with minimal grants | A bug in the print portal cannot read your camera |
| No paths from callers; fds out | Path re-resolution is where portal escapes historically come from |
| Consent lives in the broker | One policy engine, one approvals UI, one receipt trail |
| Sensors only through broker-issued capabilities | No static route can be smuggled into a manifest |
| Indicators tied to session lifetime, fail closed without atrium | You always see when a sensor is on |
| Labels propagate | Copy-paste and "open with" cannot launder untrusted or private data |
| Untrusted web links open in the tier-2 browser | Web content is the most common untrusted input |
| Parsing untrusted documents happens in confined helpers | Thumbnails and print previews are classic exploit targets |

## Legacy apps

Inside legacy sandboxes, a shim provides `org.freedesktop.portal.Desktop` on the app's private D-Bus (its D-Bus island) and translates file chooser, open URI, notifications, screencast, camera, print and inhibit calls to keylos portals. GTK and Qt apps get native dialogs that are really the keylos picker. See [Legacy apps](legacy-apps.md).

## Agents and portals

Agents run in workbenches, so they reach portals only through grants delegated by the human. Sensor portals default to T3 for agents, and policy can forbid them entirely. Any portal output an agent receives raises its session label, which feeds the Rule of Two.

## Limitations

- The picker cannot express "every file matching a pattern in this folder" except by granting the folder.
- No remote desktop or input capture in 1.0.
- Apps that insist on scanning `$HOME` (some media libraries) need a folder grant; they cannot discover files on their own.
- Notification actions have no callback channel in protocols 1.0. Activation launches the app's declared action entrypoint, or raises its window.

## Related

- [Devices and media](../06-security/devices-and-media.md)

- [Desktop](desktop.md)
- [Shell](shell.md)
- [Trusted path](../06-security/trusted-path.md)
- [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md)
- [portals spec](../../specs/portals/spec.md)
- [ADR-0035 fd-only portals and D-Bus islands](../11-decisions/adr-0035-fd-only-portals-dbus-islands.md)
- [ADR-0063 Single-file grant views](../11-decisions/adr-0063-single-file-grant-views.md)
