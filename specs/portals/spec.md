# keylos/portals — fd-only portal services

| | |
|---|---|
| Repository | `github.com/keylos-os/portals` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | Service binaries `portal-files`, `portal-screen`, `portal-camera`, `portal-mic`, `portal-openuri`, `portal-notify`, `portal-print`, `portal-clipboard`, `portal-location`, `portal-a11y`, `portal-background`, `portal-shortcuts`, `portal-inhibit`, `portal-discovery`, `portal-scan`; the per-human `pipewire` service entry (upstream PipeWire + WirePlumber, sealed generation `io.keylos.portals.pipewire`); trusted UI client `portal-ui` (file chooser, print dialog, location and background confirmations); confined helpers `portal-print-render`, `portal-thumb`; generations `io.keylos.portals` (services) and `io.keylos.portals.ui` (trusted UI); compatibility shim `portal-xdg-shim` (inside app sandboxes, legacy tier only) |
| Depends on | `keylos-protocols 1.0.0 (final)` crates; runtime services `broker`, `warden`, `atrium` (`Screencast`, `ShortcutsHost`, `IndicatorHost`, `A11yGate`, `ClipboardHost`, `InhibitHost`), `devd`, `gate`, `depot`, `bench` (media VMs), `net` (`NetDiscovery`), `compat` (CUPS and SANE islands), `config`; external PipeWire, WirePlumber (session manager) |
| Provides | `portals.capnp` (`protocols §7.3.15`: `ScreenCapture`, `Camera`, `Microphone`, `OpenUri`, `Notify`/`NotifyHandler`, `Print`, `Clipboard`, `Location`, `Accessibility`, `Discovery`, `Scan`); removable-media locations in file pickers; `FilePicker` behind `Broker.powerbox` (`protocols §7.5.19`); `Background`, `GlobalShortcuts`, `Inhibit` (`protocols §7.5.20`) |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

Portals are the only way a sandboxed principal reaches shared desktop resources: user files (including removable media, through media VMs), screen, camera, microphone, location, printers, scanners, local-network service discovery, the clipboard outside Wayland, notifications, URI handlers, accessibility, background execution, global shortcuts and power inhibition. Each portal:

- runs as its **own tier-0 service**, so a bug in one portal does not expose the others' privileges;
- returns **file descriptors or capabilities, never paths**;
- opens files only with `openat2(RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS)` from held root dirfds, and never follows a path on behalf of a caller;
- relies on `broker` for consent and persistence. A portal's service capability is held only by principals the broker has granted it to. Pickers (files, screen, print) are the consent UI themselves.

### 1.1 Non-goals

- A D-Bus `org.freedesktop.portal.*` service on the host. Legacy apps get `portal-xdg-shim` *inside* their legacy sandbox (§4.15), translating xdg-desktop-portal calls to capwire.
- A FUSE document store. Path-expecting apps get granted directories bind-mounted under `/grants/<name>` by `warden` (`GrantMounts.attachGrant`, `protocols §7.5.1`).
- Remote desktop and input capture (out of scope for 1.0).
- Mounting or parsing removable media. Media VMs do that (`protocols §9.5`); `portal-files` only relays bytes through `MediaBrowser`.
- Raw multicast for apps. `portal-discovery` is the only mDNS/DNS-SD path.

---

## 2. Context and embedded contracts

### 2.1 Placement

```
app (t1/t2/legacy) ──Broker.request(service "portal-camera#default") → approval (atrium) → Handle.cap ──► portal-camera
app ──Broker.powerbox(req)──► broker ──FilePicker.pick (portal-files#broker)──► portal-files ──► portal-ui (trusted Wayland client)
portal-screen ──Screencast.start──► atrium (trusted source picker, PipeWire node)
portal-camera/mic ──PipeWire (privileged connection)──► restricted remote fd ──► app
portal-* ──IndicatorHost.show──► atrium keystrip
portal-files ──Bench.media / MediaBrowser──► media VM (removable storage)
portal-discovery ──NetDiscovery──► net (mDNS/DNS-SD responder)
portal-scan ──CompatIsland.islandSocket("sane")──► compat SANE island
portal-a11y / portal-clipboard / portal-inhibit ──A11yGate / ClipboardHost / InhibitHost──► atrium
bench-relay (tier-2 guests) ──as the VM principal──► portal-notify, portal-openuri, portal-print
```

### 2.2 Embedded contracts

Every contract below is copied verbatim into Appendix A by mechanical extraction from keylos-protocols 1.0.0 (final).

| Contract | Use | Appendix |
|---|---|---|
| `protocols §3.4` principals | Caller identity, session-chain checks | A.1 |
| `protocols §6.3` manifest (`provides.mimeTypes`, `uriSchemes`, entrypoint kinds `handler` and `notify-action`, `needs.services`) | Handler selection, static routes | A.2 |
| `protocols §7.1`, `§7.2` capwire, routes and facets | Every portal is a capwire server; `ServiceHost.accept` gives the caller | A.3, A.4 |
| `common.capnp` + errors | | A.5 |
| `warden.capnp` | `identify`, `connectionInfo`, `Supervisor.spawn` of confined helpers | A.6 |
| `broker.capnp` | `powerbox` (served via the picker), `request`/`materialize` (service grants), `PowerboxGrant` | A.7 |
| `prompt.capnp` | `TrustedPrompt.notify` for system-styled warnings | A.8 |
| `portals.capnp` | **Implemented** | A.9 |
| `warden-sys.capnp` | `UserSpawn` (open-uri handlers, notification actions, autostart), `GrantMounts` (portal-island and shim grants), `Bootstrap`/`ServiceHost` | A.10 |
| `broker-sys.capnp` | `LabelAuthority` (label propagation) | A.11 |
| `compat-sys.capnp` | `CompatIsland` (legacy CUPS island for print, SANE island for scan) | A.12 |
| `a11y.capnp` | `A11yGate.observer` (atrium facet `portal-a11y`); `A11yObserver` returned by `Accessibility.observe` | A.13 |
| `screencast.capnp` | `Screencast`, `ShortcutsHost`, `IndicatorHost`, `ClipboardHost`, `InhibitHost` on atrium | A.14 |
| `picker.capnp` | **Implemented** by `portal-files` | A.15 |
| `portals-extra.capnp` | **Implemented** by `portal-background`, `portal-shortcuts`, `portal-inhibit` | A.16 |
| `protocols §10.1` layout | User roots, `/grants/<name>` | A.17 |
| `protocols §14.1` labels | Label propagation for files, clipboard and open-uri | A.18 |
| `protocols §19.1`, `§19.2` | Portal service names and facets | A.19, A.20 |
| `bench.capnp` | `Bench.media` (media locations) | A.21 |
| `bench-sys.capnp` | `MediaBrowser` (list, open, export, exportSeekable, eject), `ExportCompletion` | A.22 |
| `net-sys.capnp` | `NetDiscovery` (portal-discovery) | A.23 |
| `devd-sys.capnp` | `PowerEvents` (portal-inhibit) | A.24 |
| `protocols §9.5` | Removable media are never mounted on the host | A.25 |
| `protocols §14.2`, `§14.5` | `media.export` effect; agent restrictions (no screen streams, observers or foreign clipboard for agents) | A.26, A.27 |
| `protocols §7.3.8` | `Depot.get`/`openPath` for handler and publish checks | A.28 |
| `gate.capnp` | `Gate.stage`, `Intent.commit`/`status` for `media.export` (portal-files) | A.29 |

---

## 3. Requirements

### 3.1 All portals

- **REQ-PORTALS-001** Each portal MUST run as a separate tier-0 service with its own dynamic UID and the minimal device and file grants listed in §6.2. Every portal is a `per-human` service instance (`protocols §19.1`): one process per portal per logged-in human.
- **REQ-PORTALS-002** A portal MUST identify the caller only through the identity `warden` delivers in `ServiceHost.accept` (or `Supervisor.connectionInfo`). It MUST NOT trust identity claims in arguments.
- **REQ-PORTALS-003** A portal MUST NOT accept paths from callers. File inputs arrive as fds; file outputs leave as fds.
- **REQ-PORTALS-004** Every file a portal opens on its own behalf MUST be opened with `openat2` relative to a held root dirfd, with `RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS`, and with `O_NOFOLLOW` on the final component unless the picker UI resolved and displayed the symlink target.
- **REQ-PORTALS-005** Portals that give access to sensors or content (camera, microphone capture, screen, location, accessibility) MUST be reachable only through broker-issued service capabilities (`ResourceRef.service = "<portal>#default"`, or `portal-mic#capture`). They MUST NOT appear as static routes, even if a manifest lists them.
- **REQ-PORTALS-006** Every active sensor session (camera, microphone, location, screen) and every principal running in the background MUST show an indicator in atrium's keystrip for its whole lifetime (`IndicatorHost.show`, or atrium's own indicator for screencasts).
- **REQ-PORTALS-007** Portals MUST propagate labels: before handing data to a caller, a portal MUST raise the caller's session label to the data's label with `LabelAuthority.raiseFor` on route `broker#label-authority` (`protocols §14.1`). Data a caller hands to a portal keeps the caller's label.
- **REQ-PORTALS-008** Facets MUST be exactly those of `protocols §19.2`: `default` (plus `capture`/`playback` on `portal-mic`, `broker`/`drop` on `portal-files`) and `ctl`. Methods not allowed on a facet fail with `kl:denied`.

### 3.2 Files

- **REQ-PORTALS-010** `portal-files` MUST implement `FilePicker.pick` (`protocols §7.5.19`) on facet `broker`, showing `portal-ui` as a trusted surface. It returns only entries the user selected. An empty result means the user cancelled.
- **REQ-PORTALS-011** Directory selections MUST be returned as `O_PATH | O_DIRECTORY` fds. File selections MUST be opened with the access requested by the `PowerboxRequest.kind` and the picker's edit toggle (§4.2.2).
- **REQ-PORTALS-012** Saving MUST create files with `O_CREAT | O_EXCL`, unless the user explicitly confirmed overwriting an existing file in the picker.
- **REQ-PORTALS-013** The picker MUST show, in its trusted header, the requesting principal's display name, tier, and the reason supplied in `PowerboxRequest.title`.
- **REQ-PORTALS-014** `FilePicker.confirmDrop` (facet `drop`, atrium only) MUST validate every presented token with the broker before re-opening its entry for the target, and MUST NOT return an fd for a token that does not verify.
- **REQ-PORTALS-015** `portal-files` MUST NOT mount, open or parse removable media on the host. Removable-media locations MUST be served only through `MediaBrowser` from `Bench.media` (`protocols §9.5`); bytes read from them MUST be returned as sealed memfd copies and MUST raise the caller's label to `public/untrusted`.
- **REQ-PORTALS-016** Writing to removable media MUST be the caller-executed effect `media.export` (`protocols §14.2`): `portal-files` MUST stage a `media.export` intent on `gate` (route `gate#client`) whose payload is the exact bytes (a sealed memfd), MUST commit it, and MUST pass only the mandate returned in `IntentStatus.result` to `MediaBrowser.export` or `ExportCompletion.finish`. It MUST NOT obtain `media.export` mandates from the broker directly.
- **REQ-PORTALS-017** A save to a media place MUST give the app a seekable, writable file: the `PickResult.fd` is the memfd from `MediaBrowser.exportSeekable(path, sizeLimit)`. The save is finished when the app calls `MediaSave.finish` (§4.2.6) or, for apps that do not, after the app's session exits or the memfd has not changed for `media.save_idle_secs`; only then does `portal-files` stage the intent for the memfd's final digest and call `ExportCompletion.finish`. A cancelled or denied save calls `ExportCompletion.abort`.
- **REQ-PORTALS-018** `portal-discovery` MUST read callers' manifests only through `Depot.get` on route `depot#user`, of which it is a registered holder (`protocols §19.2`).
- **REQ-PORTALS-019** A file selection (`openFile`, `saveFile`) MUST grant access to the selected object only. For path-expecting clients (portal island, legacy shim) `portal-files` MUST expose it as a **single-file view** (§4.2.5, `protocols` E32): a directory that contains only the selected file and the holder's own temporary files. The selected file's parent directory MUST NOT be attached, listed or opened for the holder, for fresh picks, remembered grants, re-materialization and drops alike.
- **REQ-PORTALS-019a** In a single-file view, writes MUST follow the granted rights (a read-only grant refuses every write, create, rename and truncate with `EROFS`/`EACCES`), and a safe save (`rename(tmp → <selected name>)`) MUST be executed by `portal-files` as an atomic replace of the selected destination in the real parent (`renameat2` on the parent dirfd that only `portal-files` holds). Any other name in the real parent MUST be unreachable. Directory access needs an explicit `openDirectory` selection.

### 3.3 Screen, camera, microphone

- **REQ-PORTALS-020** Screen capture MUST go through `Screencast.start`, whose trusted picker is the consent. There is no persistent "always allow capture".
- **REQ-PORTALS-021** Camera and microphone sessions MUST return a PipeWire remote whose client permissions are restricted to the granted node(s), and nothing else in the PipeWire graph.
- **REQ-PORTALS-022** Revoking the grant (broker revocation, lock, user stop from keystrip) MUST end the stream within 250 ms. The portal destroys the restricted client in PipeWire.
- **REQ-PORTALS-023** For a caller whose actor kind is `agent`, `ScreenCapture.start` MUST accept only `kind = "window-snapshot"` and only with a grant for `screen.window.snapshot` (`protocols §14.5`); it returns one still image as a single-frame stream. Every other kind MUST fail with `kl:denied` for agents.
- **REQ-PORTALS-024** Each human has exactly one `pipewire` service instance (`protocols §19.1`), reachable only on facet `pipewire#portals` by `portal-screen`, `portal-camera`, `portal-mic` and `atrium` (which creates the screencast video nodes, `protocols §19.2`). Apps never connect to it directly.

### 3.4 Open URI

- **REQ-PORTALS-030** `OpenUri.open` MUST route `http`/`https` URIs from callers whose session integrity is `untrusted` (or from tier t2 and legacy callers) to the configured **tier-2 browser**. Other URIs go to the default handler.
- **REQ-PORTALS-031** A URI-scheme handler that is not the system default MUST be confirmed by the user the first time per (caller, scheme), at T2.
- **REQ-PORTALS-032** `OpenUri.openFile` MUST pass the caller's fd to the handler as its file argument. The portal MUST NOT reopen the file by path.
- **REQ-PORTALS-033** Handlers MUST be spawned with `UserSpawn.spawnForHuman` (route `warden#handler`) with `initialLabel` = the caller's current label, so data cannot launder its label through a handler.

### 3.5 Clipboard, notifications, print, location, accessibility, background, shortcuts, inhibit

- **REQ-PORTALS-040** `Clipboard.read` MUST show a trusted confirmation card (via `portal-ui`) naming the caller and showing a preview of at most 200 characters, unless the caller's session already has an allowance from this card that has not expired (§4.8). The caller's label MUST be raised before data is returned.
- **REQ-PORTALS-041** `Notify.post` MUST be rate-limited (default 10 per minute per principal) and MUST be displayed with attribution derived from the verified manifest.
- **REQ-PORTALS-042** Print jobs MUST be rendered for preview in `portal-print-render`, a confined helper; the portal process never parses document bytes.
- **REQ-PORTALS-043** Location MUST default to **coarse** accuracy (rounded to a 5 km grid). Precise location needs a separate grant at T2.
- **REQ-PORTALS-044** `Accessibility.observe` MUST be served only to principals holding a persistent T3 grant for `service portal-a11y#default` (the `protocols §19.2` holders "assistive-technology principals only"), and only when an `A11yObserver` can be obtained from atrium (§4.10).
- **REQ-PORTALS-045** Background and autostart permission MUST be a broker persistent grant, visible and revocable in atrium's security centre, and every background principal MUST show the keystrip background indicator.
- **REQ-PORTALS-046** `portal-clipboard` MUST raise a reader's label to the source label that atrium reports through `ClipboardHost.source(offerId)`, and MUST refuse (`kl:denied`) a read by an `agent` principal when the selection's owner principal is not in that agent's own session tree (`protocols §14.5`).
- **REQ-PORTALS-047** `portal-a11y` MUST obtain observers only through `A11yGate.observer(consumer)` (facet `atrium#portal-a11y`) and MUST NOT serve `Accessibility.observe` to `agent` principals.
- **REQ-PORTALS-048** `portal-inhibit` MUST forward kinds `idle` and `logout` to `InhibitHost.inhibit` (facet `atrium#portal-inhibit`) and kinds `suspend` and `lid` to devd `PowerEvents`; it MUST NOT accept any other kind.

### 3.6 Discovery and scanning

- **REQ-PORTALS-050** `Discovery.browse` results MUST raise the caller's label integrity to `untrusted` before the first result is delivered, and service-instance strings MUST be passed through unchanged (they are untrusted data, never interpreted by the portal).
- **REQ-PORTALS-051** `Discovery.publish` MUST be refused unless the caller's verified manifest declares `needs.listen` for that port with scope `lan`, and the user has confirmed publishing for that (generation, service type) on a trusted card. Publishing is limited to the local link.
- **REQ-PORTALS-052** `Scan.scan` MUST show a trusted confirmation per scan naming the caller and the scanner. Scanner drivers MUST run only inside the compat SANE island; the portal process MUST NOT load SANE backends. The returned image MUST be labelled `public/user`.

## 4. Design

### 4.1 Common skeleton

Each portal binary links `portal-core`, which provides:

| Module | Content |
|---|---|
| `server` | Implements `ServiceHost` (`protocols §7.5.1`): registers with `Bootstrap.host` on fd 3, signals `ready`, and dispatches each `ServiceHost.accept(socket, connectionId, facet, peer, tier, generation)` to the portal's facet handler. The peer identity comes only from `accept` |
| `roots` | The human's home directory as an `O_PATH` dirfd, delivered by `warden` at spawn (service entry `privileges.paths: [{"path": "/home/{human}", "access": "readwrite"}]` for `portal-files`, `portal-openuri` and `portal-print`; read-only for `portal-print`). Removable media are never roots: they are `MediaBrowser` capabilities (§4.2.6) |
| `labels` | Client of `LabelAuthority` (`labelOf`, `raiseFor`) on route `broker#label-authority` |
| `indicators` | Client of `IndicatorHost` on the portal's own atrium facet (`atrium#portal-camera` and so on) |
| `ui` | A private capwire channel (repo-local schema `portal-ui.capnp`, file ID `@0xd5a0c3e1f7b20001`) to a `portal-ui` child this portal spawned, see below |
| `pw` | PipeWire helper: privileged connection, creating restricted clients for consumers |
| `limits` | Per-principal rate limits and concurrency limits |

**portal-ui.** Every portal surface (file chooser, print dialog, device and location choosers, background and clipboard cards, app notification toasts) is drawn by `portal-ui` (generation `io.keylos.portals.ui`). Each portal that needs UI spawns its own `portal-ui` child on demand with `Supervisor.spawn` (route `warden#service`, entrypoint `main`), passing one end of a socketpair as fd 10 (`SpawnSpec.fds`); the child exits after 60 s without surfaces. A `portal-ui` child is a Wayland client in atrium's `trusted` class (atrium spec §4.1.1: its generation is in `trusted_generations` and its parent session is a `service:portal-…` principal). No portal talks to another portal's UI; there are no cross-portal routes.

Portals keep no persistent state beyond caches, except `portal-background` (autostart registrations, §4.11) and the per-human preference files in `~/.apps/io.keylos.portals/` subvolumes. Remembered grants live in the broker; default handlers in the config generation.

**Instances.** Every portal runs one instance per logged-in human (`protocols §19.1`), started by `warden` on demand when the first route to it is wired (`instances: "per-human"` in the service set). Instances are tier 0 with dynamic UIDs; the principal's human is the logged-in human.

### 4.2 Files (`portal-files`)

#### 4.2.1 Flow

1. An app calls `Broker.powerbox(PowerboxRequest)`.
2. The broker evaluates policy (`Keylos::Action::"read"` and so on, on `Path` with root `user-home`). If allowed (normally T0: the picker is the consent), it calls `FilePicker.pick(request, requester, user)` on the human's `portal-files` (facet `broker`).
3. `portal-files` asks `portal-ui` to show the chooser with:
   - the trusted header (REQ-PORTALS-013);
   - places: home, recent for this app, bookmarks, and one "USB: <label>" place per authorized removable device (§4.2.6);
   - the file list from `getdents64` on dirfds;
   - thumbnails from `portal-thumb` (confined decoder, same profile as atrium-decode).
4. The user selects. `portal-files` opens the selections (§4.2.2) and returns `PickResult` entries: `{fd, rootKey, relPath, displayName, kind, persist}`.
5. The broker mints tokens: `right("path", rel, op)` with `path_root(rootKey)`, plus `persist` if the user ticked "Remember access". A file token's `rel` names that file only (path rights match on component boundaries, so it never covers siblings). For directories it attaches the grant into the app's view with `GrantMounts.attachGrant` (with the directory's exposure-label `ceiling`, `protocols §14.1`, E31) and returns `PowerboxGrant{fd, token, displayName, viewPath}` (`protocols §7.3.3`). For files picked by path-expecting clients `viewPath` names the single-file view (§4.2.5).
6. Label: the broker raises the app's session label to the max label of the selected files (`security.bpf.keylos.label` or the location default), or to the directory grant's ceiling (`protocols §14.1`).

#### 4.2.2 Opening rules

| Kind | Open |
|---|---|
| `openFile` | `openat2(root, rel, O_RDONLY \| O_CLOEXEC, RESOLVE_BENEATH \| RESOLVE_NO_MAGICLINKS)`. When the user leaves the picker's **Allow editing** toggle on, `O_RDWR`. The toggle defaults to on when the file's MIME type is listed in the requester's manifest `provides.mimeTypes` (the app is an editor for it), otherwise off |
| `openDirectory` | `openat2(root, rel, O_PATH \| O_DIRECTORY \| O_CLOEXEC, RESOLVE_BENEATH \| RESOLVE_NO_MAGICLINKS)` |
| `saveFile` | Parent dir opened as above, then `openat2(parent, name, O_WRONLY \| O_CREAT \| O_EXCL \| O_CLOEXEC, 0644, RESOLVE_BENEATH \| RESOLVE_NO_SYMLINKS)`. On confirmed overwrite: `O_WRONLY \| O_TRUNC` on the existing regular file (`fstat` check: regular, same owner) |

The picker resolves and displays symlinks. Selecting a symlink whose target lies outside the root is shown as "outside your files" and is not selectable.

#### 4.2.3 Persistent grants and recents

- "Remember access" creates a broker persistent grant (re-minted per boot; `protocols §8.1`).
- On each launch, the app's persisted grants are re-materialised by the broker, which re-attaches directory grants under `/grants/<name>` for path-expecting apps and asks `portal-files` to re-create single-file views for file grants (never the parent directory, REQ-PORTALS-019). Both `/grants/` names and display names come from the picker.
- Recents per app (the last 50 entries) are stored by the broker as non-authoritative hints. The picker shows them; selecting one is a fresh grant.

#### 4.2.4 Drag and drop

atrium converts file drops into `FilePicker.confirmDrop(tokens, target)` calls on facet `drop` (`protocols §7.5.19`). `portal-files` validates each token with `Broker.inspect` (route `broker#principal`; the token's `path_root` must be one of the human's roots), re-opens the entries for the drop target, and returns fresh `PickResult`s. A dropped file reaches a path-expecting target as a single-file view (§4.2.5), never with its parent directory. When `tokens` is empty (a `file://` URI list from an app), it shows the picker preselected on the named entries; only what the user confirms is returned. No path ever crosses from app to app.

#### 4.2.5 Portal-island and legacy-shim grants

For apps running a portal island (`needs.portalIsland`) or the legacy shim (§4.15), a toolkit file chooser expects a **path**. The exposed scope is exactly the selection (REQ-PORTALS-019, `protocols` E32):

- **Chosen directory** (`openDirectory`): `portal-files` calls `GrantMounts.attachGrant(session, name, tree, readOnly, ceiling)` (route `warden#portals`) with the chosen directory as a non-recursive tree and the broker-chosen ceiling, and the shim returns `/grants/<name>`.
- **Chosen file** (`openFile`, `saveFile`): `portal-files` serves a **single-file view** `keylos.singlefile` — a small FUSE directory implemented by `portal-files` itself (crate `portal-files-view`, one FUSE connection per grant, no exec, same confinement as `portal-files`) — and attaches its detached mount with `attachGrant(session, name, <view>, readOnly, ceiling = the file's label)`. The shim returns `/grants/<name>/<basename>`.

**Single-file view semantics:**

| Operation in `/grants/<name>/` | Behaviour |
|---|---|
| `readdir` | Lists `<basename>` and the holder's own temporary files only |
| `open(<basename>)` | Passes through to the fd `portal-files` opened at pick time (§4.2.2, identity checked by `fstat` device and inode); `O_RDWR`/`O_TRUNC` only when the grant allows editing (`readOnly` false) |
| `create(<other name>)` | Allowed only on writable grants and only for temporary names (any name other than `<basename>`, at most 16 live files, size bounded by the grant's quota `files.single_view_tmp_bytes`, default 4 GiB). Temporary files live in a private scratch directory of `portal-files`, never in the real parent |
| `rename(tmp → <basename>)` | **Safe save**: `portal-files` copies (reflink) the temporary file into the real parent as `.portal-<ULID>.tmp`, `fsync`s it, and `renameat2(parent, tmp, parent, <basename>, 0)` atomically replaces the destination, after checking the destination is still the regular file the user selected (device/inode recorded at pick time, or absent for `created`). The new inode becomes the grant's object (its label: the holder's session label, raised to at least the old label). Receipt `grant.issue`-linked `x-portals.safe-save` |
| `rename` to any other name, `link`, `symlink`, `mkdir`, `unlink(<basename>)` | `EACCES` (unlinking the holder's own temporary files is allowed) |
| Anything on a read-only grant other than `open(O_RDONLY)`, `stat`, `readdir` | `EROFS` |
| Path replacement races (the real destination is swapped for a symlink or another inode by a third party) | Detected by the identity check; the save fails with `EIO`, nothing outside the destination is written, and the user gets a trusted notification "Not saved: the file was replaced" |

The real parent directory fd is held only inside `portal-files`; it is never attached, passed or listed. A save-as to a different name is a new `saveFile` pick.

**Same scope everywhere.** Remembered file grants (`persist`) re-materialise as the same single-file view at the next launch (§4.2.3); drag and drop (§4.2.4) of a file produces a single-file view for path-expecting targets; revoking the grant (`Broker.revoke`, or the security centre) detaches the view (`GrantMounts.detachGrant`) and closes the FUSE connection, so open fds through it return `ENOTCONN` and the scratch directory is deleted.

#### 4.2.6 Removable media locations

`portal-files` watches `Devd.watch("block")` and `Devd.watch("usb")` (route `devd#client`) for authorized removable devices (mass-storage, SD, optical, MTP). For each, when a picker opens, it calls `Bench.media(device)` on route `bench#user` (`protocols §7.3.13`), which starts or attaches to the device's media VM and returns a `MediaBrowser` (`protocols §7.5.10`). The browser is cached per device until the device is ejected or removed.

| Operation | Behaviour |
|---|---|
| Listing | `MediaBrowser.list(path)`; entry names are rendered as untrusted text; no thumbnails (the portal never decodes media files; `portal-thumb` sees only home files) |
| Open (`openFile`) | `MediaBrowser.open(path)` streams bytes into a new memfd (size limit `media.max_open_bytes`, default 4 GiB), which is sealed (`F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE | F_SEAL_SEAL`) and returned as the `PickResult.fd` with `kind = file`, `rootKey = "media:<device id>"`, `relPath` = the media path, `persist = false`. The caller's label is raised to `public/untrusted` first (REQ-PORTALS-015) |
| Open (`openDirectory`) | Not offered for media places in 1.0; the picker shows directories but only files are selectable |
| Save (`saveFile`) | The picker offers media places as targets. `portal-files` calls `MediaBrowser.exportSeekable(path, sizeLimit = media.max_export_bytes)` and returns the memfd as `PickResult.fd` (`kind = created`, `rootKey = "media:<device id>"`, `relPath` = the media path): a seekable, writable file, so apps save normally. Nothing reaches the device until the save is finished (REQ-PORTALS-017, below) |
| Save finished | When the app calls `MediaSave.finish(relPath)` (SDK `save.finish()`), when its session exits, or after `media.save_idle_secs` (default 10) without a change of the memfd's size or `st_mtime`: `portal-files` checks the app no longer holds a writable mapping it is still using (it seals the memfd with `F_SEAL_WRITE`, which fails with `EBUSY` while shared writable mappings exist, in which case it waits and retries), computes SHA-256, obtains the mandate (below) and calls `ExportCompletion.finish(mandate)` |
| Eject | From the picker's place menu: `MediaBrowser.eject()` |

**Mandate for `media.export`.** `portal-files` stages the effect on `gate` (route `gate#client`, REQ-PORTALS-016): `Gate.stage(EffectIntent{kind = "media.export", class = compensable, target = "media:<device id>:<path>", args = [{name: "app", value: <caller principal>, source: "portal-files"}, {name: "name", value: <file name>}, {name: "size", value: <bytes>}], idempotencyKey = "media:<device id>:<path>:<sha256>", compensator = "", payload = <the sealed memfd>})`, then calls `Intent.commit()`. `gate` renders the intent and decides it (T2 by default; the effect counts as egress for the Rule of Two, `protocols §14.2`, so a caller whose session holds untrusted input and private data gets the declassification prompt instead). While `commit` fails with `kl:needs-approval`, `portal-files` waits (`Intent.status` every 2 s, at most 120 s) and retries. On success `IntentStatus.result` carries the base64 delivered mandate, whose `effects[0].digest` must equal the memfd's SHA-256; `portal-files` checks that before calling `ExportCompletion.finish(mandate)`. bench verifies the mandate again and writes the `media.export` completion receipt; `gate` has written `effect.commit` ("authorized"). On denial `portal-files` calls `abort()` and posts "Not copied".

**`MediaSave` (`protocols §7.5.20`, `portals-extra.capnp`).** Native apps can end a media save explicitly: `Extensible.ext` on route `portal-files#default` returns `MediaSave` with `finish @0 (relPath :Text) -> ()` and `cancel @1 (relPath :Text) -> ()`, valid only for saves the same caller session received. The SDK calls it when the app closes the save stream.

### 4.3 Screen (`portal-screen`)

1. The caller holds a capability for `ScreenCapture` (broker grant on `service: portal-screen#default`, T1 by default, since the picker is the consent).
2. `ScreenCapture.start(kind)` calls `Screencast.start(CastRequest{consumer, kinds from kind, cursor = metadata, multiple = (kind == "multiple")})` on route `atrium#portal-screen`. atrium shows the trusted source picker and returns streams, a restricted PipeWire remote fd and a `Cancelable`.
3. The portal raises the caller's label to `private/user` (screen content may include anything the human sees), then returns `(streams, remote)`.
4. **Stop:** the caller closes the remote; or the user stops from the keystrip (atrium cancels); or on lock. The portal releases the `Cancelable`.

`kind` values: `"output"`, `"window"`, `"region"`, `"any"` (all three offered), `"multiple"` (all three, several sources), `"window-snapshot"` (one window, one frame).

**Agents** (REQ-PORTALS-023). For a caller with actor kind `agent`, only `"window-snapshot"` is accepted, and only when the broker grant carries the effect resource `screen.window.snapshot` (T3 per approval, `protocols §14.5`). `portal-screen` calls `Screencast.start` with `kinds = [window]`, `multiple = false`; atrium marks the stream single-frame (atrium spec) and stops it after the first frame. The returned remote therefore yields exactly one buffer. The grant is single-use: `portal-screen` revokes the token's root ID after the frame (`Broker.revoke`).

### 4.4 Camera and microphone (`portal-camera`, `portal-mic`)

1. **Grant:** broker `service: portal-camera#default` (`portal-mic#capture`). Default T2 at first use, persistable per app. Policy may require T3 for agents and for tier-2 VMs.
2. **Open:** the portal enumerates nodes through its privileged PipeWire connection. It selects the default device, or the device chosen in a trusted picker (`portal-ui`) when several exist and the grant has no device preference. It then:
   - creates a new PipeWire client connection for the consumer (a socketpair connected to the PipeWire daemon through the portal's privileged context);
   - sets that client's permissions with `pw_client_update_permissions`: `R` on the core, `R X` on the chosen node and its ports, `0` on everything else.
3. **Indicator:** `IndicatorHost.show("camera"|"microphone", consumer, deviceName)` on route `atrium#portal-camera` / `atrium#portal-mic`. Kept until the stream ends.
4. **Labels:** the caller's label is raised to `private/user` before the remote is returned.
5. **End:** when the consumer disconnects, or on revocation, lock or keystrip stop, the portal destroys the PipeWire client (`pw_registry_destroy` on the client object) and cancels the indicator.

**PipeWire service** (`pipewire`, `protocols §19.1`). One PipeWire daemon with WirePlumber per logged-in human runs as the **tier-1 per-human service** `pipewire` (generation `io.keylos.portals.pipewire`, the upstream daemons built by forge). Its service entry (`keylos.services/1`, `protocols §20.16`) declares:
- `perHuman: true`, `tier: 1`, `needs.realtime: true` (warden sets `RLIMIT_RTPRIO = 20`, `RLIMIT_RTTIME = 200 000 µs`; there is no rtkit);
- device grants for the human's seat: `sound/*` (ALSA) and `video4linux/*` (V4L2) via broker device tokens materialised at session registration;
- one facet, `portals`, held by `portal-screen`, `portal-camera` and `portal-mic` (REQ-PORTALS-024). warden connects those portals to the daemon's native-protocol socket; the daemon's own socket is never bind-mounted into any app view.

Apps never connect to PipeWire directly. The only routes into the graph are the restricted clients the portals create and the playback route below. Bluetooth audio reaches PipeWire through devd's Bluetooth island (devd spec), not through the session bus.

**Plain audio playback:** apps with audio output get the static route `portal-mic#playback` (`protocols §19.2`), whose `Microphone.open` returns a restricted client with permission to create output streams and link to the default sink only. Playback needs no consent and no indicator.

### 4.5 Open URI (`portal-openuri`)

#### 4.5.1 Handler resolution

| Input | Resolution |
|---|---|
| `http`, `https` from a caller with `integ = untrusted`, tier t2 or legacy | `defaults.browser_untrusted` (a tier-2 browser generation) |
| `http`, `https` otherwise | `defaults.browser` |
| `mailto:` and other schemes | Config `defaults.schemes[scheme]`, else installed generations whose `provides.uriSchemes` lists the scheme (one: use it; several: trusted chooser) |
| `file:` URIs | Rejected (`kl:invalid`): file opening goes through `openFile` with an fd |
| `openFile(fd)` | MIME type sniffed in `portal-thumb` (confined) from the first 4 KiB, plus the caller's display name; handler from `defaults.mime[type]` or `provides.mimeTypes` |

Generations are discovered with `Depot.list` (route `depot#user`; `portal-openuri` is a registered holder, `protocols §19.2`).

#### 4.5.2 Launch

- The portal calls `UserSpawn.spawnForHuman(spec, human, initialLabel)` (route `warden#handler`, `protocols §7.5.1`) for the handler generation:
  - entrypoint: the first manifest entrypoint of kind `handler`, else `main`;
  - `argv = [uri]`, or `["/dev/fd/3"]` with the file fd mapped at fd 3;
  - `initialLabel` = the caller's current label (`LabelAuthority.labelOf`), so data cannot launder its label through a handler (REQ-PORTALS-033).
- Single-instance apps forward to their running instance over their own capwire service if they provide one; the portal never injects into running processes.

### 4.6 Notifications (`portal-notify`)

- `post(title, body, actions, handler)`:
  - title limited to 128 characters and body to 1024 characters, plain text only (control characters stripped);
  - at most 3 actions, each label at most 32 characters;
  - icon taken from the manifest generation;
  - shown by `portal-ui` as a layer-shell toast (a `trusted`-class surface), attributed with the display name and tier colour; the notification list is kept by `portal-notify` for the panel.
- **Action activation** (`protocols §7.3.15`):
  - if the caller passed a `NotifyHandler`, `portal-notify` calls `handler.activated(id, action)`;
  - otherwise it spawns the app's `notify-action` entrypoint with `UserSpawn.spawnForHuman` (route `warden#handler`), `argv[1]` = the action id;
  - if the app has neither, activation only dismisses the toast.
- **Rate limits:** 10 posts per minute per principal; bursts of more than 3 within 1 s are coalesced. Do-not-disturb rules come from user settings.
- System notifications (`TrustedPrompt.notify`) are atrium's own and look different; `portal-notify` never uses that style for apps.

### 4.7 Print (`portal-print`)

1. `print(document fd, mime, optionsJson)`.
2. The portal hands the fd to `portal-print-render` (confined: no network, no files; input memfd, output memfd; 30 s CPU and 1 GiB memory limits), which produces page previews and, when needed, converts to PDF or PWG raster. Accepted input: PDF, PostScript (via the renderer's interpreter in the same confinement), PNG, JPEG, plain text.
3. `portal-ui` shows the trusted print dialog: printer, copies, pages, duplex, colour, media, and the preview.
4. **Printers:**
   - **Driverless (IPP Everywhere):** discovered by DNS-SD on the local link. `portal-print`'s service entry sets `privileges.localLink: true`, so `warden` includes its UID in `NetPlumbing.setLocalLinkUids` and `net` allows mDNS (224.0.0.251:5353, ff02::fb) and IPP (631/tcp, and 443 for ipps) towards link-local and private ranges only. Jobs are submitted with IPP/2.0 Print-Job (or Create-Job + Send-Document).
   - **Legacy drivers:** a CUPS installation inside a `compat` legacy service image (`io.keylos.legacy.cups`) in its own D-Bus island, granted only the printer's USB device or network endpoint. `portal-print` obtains a socket to it with `CompatIsland.islandSocket("cups")` on route `compat#adapter` (`protocols §7.5.15`) and speaks IPP over it.
5. Returns `jobId`. Job status is visible in the dialog's job list; there is no status callback in 1.0.

### 4.8 Clipboard (`portal-clipboard`)

- For principals without a Wayland connection: CLI commands in a terminal, headless apps.
- **Data path.** `portal-clipboard` reads and sets the Wayland selection through `portal-ui`, which as a `trusted`-class client may use `wl_data_device` without the focus rule. `portal-ui` reports the selection's offer ID (MIME type `application/x-keylos-offer-id`, offered only to the `trusted` class) with the data.
- **Read** (REQ-PORTALS-040): `portal-ui` shows a trusted card "<display name> wants to read the clipboard" with a preview of at most 200 characters (images as a thumbnail from `portal-thumb`), and **Allow once**, **Allow for this session (10 min)**, **Deny**. Deny is focused by default. A session allowance is keyed by the caller's session ID.
- **Labels.** Before returning data, `portal-clipboard` calls `ClipboardHost.source(offerId)` on route `atrium#portal-clipboard` (`protocols §7.5.18`) and raises the reader's label to the returned label (REQ-PORTALS-046). If atrium answers `kl:not-found` (the selection changed), the read is retried once with the new offer; on a second failure it fails with `kl:conflict`. Content atrium marks `secret` is never offered to `portal-ui`.
- **Agents.** A read by an `agent` principal is refused unless `source.owner`'s session chain lies inside the agent's own session tree (`protocols §14.5`).
- **Write:** allowed for any caller holding the route; `portal-ui` sets the selection and shows a 3 s toast "Copied by <display name>". `portal-ui` passes the writer's session ID in the offer metadata; atrium verifies it and records the writer's label (atrium spec §4.16), so content written through the portal carries its writer's label, not `portal-ui`'s.
- Size limit: 64 MiB per transfer. Data moves through a pipe fd.

### 4.9 Location (`portal-location`)

- **Sources:** GNSS receivers exposed by devd (NMEA serial or `gnss` class devices), as fds from broker device grants. Optional network geolocation, off by default, configurable to a provider URL reached through `gate` with a dedicated grant. No IP geolocation.
- **Accuracy levels:** `country` (rounded to 100 km), `city` (5 km, the default), `street` (100 m), `exact`. `street` and `exact` need a separate T2 grant with the attenuation check `check if operation("service", "use"), resource("service", "portal-location#default")` plus the broker grant reason `precise`; the portal reads the grant facts with `Broker.inspect`.
- The indicator (`atrium#portal-location`) stays while any subscription is active. One-shot reads hold the indicator for 10 s.
- The caller's label is raised to `private/user`.

### 4.10 Accessibility (`portal-a11y`)

1. The caller has the grant per REQ-PORTALS-044 and is not an `agent` principal (REQ-PORTALS-047).
2. The caller's label is raised to `private/user` first. Observed content may include anything on screen, so an assistive principal that also holds egress is a Rule-of-Two concern; the broker decides.
3. `observe()` calls `A11yGate.observer(consumer = caller principal)` on route `atrium#portal-a11y` (`protocols §7.5.17`) and returns the resulting `A11yObserver`. atrium checks that the consumer is an owner-listed assistive generation of the same human and filters passwords, trusted surfaces and tier-2 contents (atrium spec REQ-ATRIUM-061/-062).
4. While any observer is held, atrium shows its own "assistive tech active" indicator (it knows the observers it issued); `portal-a11y` holds no `IndicatorHost` facet. On lock, atrium revokes observers; screen readers reconnect after unlock.

### 4.11 Background and autostart (`portal-background`)

- `request(reason, autostart, entrypoint)`: `portal-ui` shows a T2 trusted card; on approval `portal-background` records the registration `{generation name, entrypoint, autostart}` in its per-human state (`~/.apps/io.keylos.portals/state/background.json`) and asks the broker for a persistent `spawn` grant for the caller's generation (`Broker.request` with `persist: true`, presence per policy). `granted` is true only when both succeed.
- **Autostart.** When `portal-background` starts for a human (at login, because warden starts per-human portals on the first route), it launches each `autostart: true` registration with `UserSpawn.spawnForHuman` on route `warden#handler`. `portal-background` is a registered holder of that facet (`protocols §19.2`).
- While a principal holding a background registration runs without any visible window, `IndicatorHost.show("background", …)` (route `atrium#portal-background`) adds it to the keystrip's background list.
- `status()` returns the caller's own registration.

### 4.12 Global shortcuts (`portal-shortcuts`)

Forwards to atrium's `ShortcutsHost` on route `atrium#portal-shortcuts` (`protocols §7.5.18`), passing the caller as `owner`. The first `bind` for a caller shows a trusted confirmation listing the requested triggers (drawn by atrium); the user can change them. Events come back as shortcut IDs through the caller's `Watcher`.

### 4.13 Inhibit (`portal-inhibit`)

`inhibit(kinds, reason)` with kinds `idle`, `suspend`, `logout`, `lid`:
- `suspend` and `lid`: `portal-inhibit` subscribes to `PowerEvents` (route `devd#service`, a registered holder) and delays its `ack("preSleep")` while an inhibitor is active, up to 30 minutes per inhibitor, renewable. `lid` inhibition needs a T2 grant. devd's ack timeout bounds the delay.
- `idle` and `logout`: forwarded to `InhibitHost.inhibit(owner = caller, kinds, reason)` on route `atrium#portal-inhibit` (`protocols §7.5.18`). atrium suppresses only idle locking and adds a logout confirmation; SAK, lid and suspend locks still happen (atrium spec §4.21). The returned handle is held by `portal-inhibit` and cancelled when the caller cancels or exits.

Returns a `Cancelable`. Inhibitors are listed in the security centre (`portalctl status`).

### 4.13a Discovery (`portal-discovery`)

- **Browse.** `Discovery.browse(serviceType, watcher)`: `serviceType` must match `_[a-z0-9-]{1,15}\._(tcp|udp)` (else `kl:invalid`). The portal first raises the caller's label integrity to `untrusted` (REQ-PORTALS-050), then calls `NetDiscovery.browse(serviceType, onLink = "", watcher')` on route `net#discovery` (`protocols §7.5.11`). Each JSON instance from net is validated (names ≤ 255 bytes, ≤ 32 TXT entries, each ≤ 255 bytes, addresses parsed as IP literals) and delivered as a `ServiceInstance`. Results never become grants: connecting to a discovered host still needs a `gate` grant.
- **Publish.** `Discovery.publish(instance, serviceType, port, txt)`: the portal reads the caller's manifest with `Depot.get` (route `depot#user`, registered holder) and refuses unless `needs.listen` contains `{port, scope: "lan"}`. The first publish per (generation, service type) shows a trusted card "<app> wants to announce '<instance>' on this network"; the choice is remembered in `~/.apps/io.keylos.portals/state/discovery.json`. It then calls `NetDiscovery.publish(instance, serviceType, port, txtJson, forUid = caller UID)`; net announces only on local links and only while the caller's listen port is open in the firewall (`net.listen`, granted through `gate`). The handle is cancelled when the caller exits.
- Agents may browse (results are untrusted) but never publish.

### 4.13b Scan (`portal-scan`)

- `scanners()` and `scan(scanner, options)` speak the SANE network protocol (saned, protocol version 3) over a socket from `CompatIsland.islandSocket("sane")` on route `compat#adapter` (`protocols §7.5.15`). The island is a `compat` legacy service image (`io.keylos.legacy.sane`) running `saned` with the backends; it holds only the scanner's USB device grant (authorized through devd) or a gate grant to the network scanner's address (eSCL/AirScan backends).
- Each `scan` shows a trusted card via `portal-ui` with the caller, the scanner name (untrusted text) and the options; Cancel is focused by default (REQ-PORTALS-052).
- The island returns raw frames; `portal-scan` hands them to `portal-print-render` (same confinement) to encode the requested `format` (`png`, `jpeg`, or `pdf` assembled from pages) into a memfd, which is sealed and returned. The caller's label is raised to `public/user`.
- Limits: 600 dpi maximum unless the config raises it; 2 GiB per scan; one active scan per scanner.

### 4.13c Tier-2 guests

Tier-2 VMs reach `portal-notify`, `portal-openuri` and `portal-print` through `bench-relay` (a registered `portal-*#default` holder for its VM principal, `protocols §19.2`), which serves `GuestPortals` to the guest (vsock 7004, `protocols §7.5.10`) and calls the portals **as the VM principal** (tier `t2`). The portals treat these calls like any tier-2 caller: `OpenUri.open` of web URIs goes to the untrusted browser (REQ-PORTALS-030), notifications are attributed to the VM's generation, and print documents are rendered in `portal-print-render`.

### 4.14 Grants and consent summary

| Portal | Route | Default consent tier | Persistable | Indicator |
|---|---|---|---|---|
| files | via `Broker.powerbox` | T0 (picker is consent) | yes (per selection) | — |
| screen | broker grant, `portal-screen#default` | T1 (picker is consent) | no | yes (atrium) |
| camera | broker grant, `portal-camera#default` | T2 | yes | yes |
| microphone (capture) | broker grant, `portal-mic#capture` | T2 | yes | yes |
| audio playback | static route `portal-mic#playback` | T0 | n/a | — |
| openuri | static route | T0 (T2 for non-default scheme handler, first time) | per (caller, scheme) | — |
| notify | static route | T0 | n/a | — |
| print | static route | T0 (dialog is consent) | n/a | — |
| clipboard | static route | read card per read or per 10-min session allowance | session only | toast on write |
| location | broker grant, `portal-location#default` | T2 (coarse), T2 + `precise` grant | yes | yes |
| accessibility | broker grant, `portal-a11y#default` | T3 | yes (required) | yes ("assistive tech active", drawn by atrium) |
| background | static route + broker `spawn` grant | T2 | yes | yes (background list) |
| shortcuts | static route | T2 at first bind | yes | — |
| inhibit | static route | T0 (lid: T2) | lid: yes | listed in security centre and keystrip (`idle`, `logout`) |
| discovery (browse) | static route | T0 (results untrusted) | n/a | — |
| discovery (publish) | static route + manifest `needs.listen` | trusted card per (generation, type) | yes | — |
| scan | static route | trusted card per scan | no | — |
| removable media (read) | via `Broker.powerbox` | T0 (picker) | no | — |
| removable media (write) | via `Broker.powerbox` + `media.export` intent on `gate` | T2 per export | no | — |

Agents (actor kind `agent`) default to **T3** for camera, microphone and location. They never receive screen streams (only `window-snapshot` per T3 grant), accessibility observers, discovery publishing, or clipboard data owned by principals outside their session tree (`protocols §14.5`). Policy may forbid the rest entirely for agents.

### 4.15 Legacy shim (`portal-xdg-shim`)

Inside legacy-tier sandboxes, `compat` starts a private D-Bus daemon (the app's D-Bus island) and `portal-xdg-shim`. The same shim is the portal part of the per-app portal island for native GTK/Qt apps (`needs.portalIsland`). The shim owns `org.freedesktop.portal.Desktop` on that private bus and translates:

| xdg interface | keylos |
|---|---|
| FileChooser | `Broker.powerbox`. Results become paths under `/grants/<name>` (§4.2.5; `PowerboxGrant.viewPath`) |
| OpenURI | `OpenUri` |
| Notification | `Notify` (with a `NotifyHandler` that emits the D-Bus `ActionInvoked` signal) |
| ScreenCast | `ScreenCapture` (PipeWire fd passed through the D-Bus fd-passing in the island) |
| Camera | `Camera` |
| Print | `Print` |
| Inhibit | `Inhibit` |
| Settings (read-only appearance) | Atrium user settings snapshot |

Unsupported interfaces return `org.freedesktop.DBus.Error.NotSupported`.

---

## 5. Interfaces

### 5.1 Capwire interfaces implemented

All schemas are in keylos-protocols 1.0.0 (final). Every bootstrap capability also implements `common.Extensible`.

| Service | Interface | Facets (`protocols §19.2`) | Appendix |
|---|---|---|---|
| portal-files | `FilePicker` | `broker` (`pick`), `drop` (`confirmDrop`) | A.15 |
| portal-files | `MediaSave` (`protocols §7.5.20`, obtained with `Extensible.ext`) | `default` (apps declaring `portal-files` in `needs.services`) | §4.2.6 |
| portal-screen | `ScreenCapture` | `default` | A.9 |
| portal-camera | `Camera` | `default` | A.9 |
| portal-mic | `Microphone` | `capture`, `playback` | A.9 |
| portal-openuri | `OpenUri` | `default` | A.9 |
| portal-notify | `Notify` (calls `NotifyHandler`) | `default` | A.9 |
| portal-print | `Print` | `default` | A.9 |
| portal-clipboard | `Clipboard` | `default` | A.9 |
| portal-location | `Location` | `default` | A.9 |
| portal-a11y | `Accessibility` | `default` | A.9 |
| portal-background | `Background` | `default` | A.16 |
| portal-shortcuts | `GlobalShortcuts` | `default` | A.16 |
| portal-inhibit | `Inhibit` | `default` | A.16 |
| portal-discovery | `Discovery` | `default` | A.9 |
| portal-scan | `Scan` | `default` | A.9 |
| pipewire | PipeWire native protocol (upstream) | `portals` | — |
| every portal | portal-local control (`portalctl`) | `ctl` | §5.3 |

### 5.2 Routes the portals hold

| Holder | Route | Use |
|---|---|---|
| every portal | `warden#service` | `FdStore`; spawning `portal-ui`, `portal-thumb`, `portal-print-render` |
| every portal | `broker#principal` | `Broker.inspect` (token validation), `Broker.request` (background `spawn` grant) |
| every portal | `broker#label-authority` | `LabelAuthority` |
| portal-files, portal-openuri | `warden#portals` | `GrantMounts.attachGrant`/`detachGrant` (§4.2.5) |
| portal-openuri, portal-notify | `warden#handler` | `UserSpawn` |
| portal-background | `warden#handler` | Autostart (§4.11) |
| portal-openuri | `depot#user` | Handler discovery |
| portal-screen | `atrium#portal-screen` | `Screencast`, `IndicatorHost` |
| portal-camera, portal-mic, portal-location, portal-background | `atrium#portal-camera`, `#portal-mic`, `#portal-location`, `#portal-background` | `IndicatorHost` |
| portal-shortcuts | `atrium#portal-shortcuts` | `ShortcutsHost` |
| portal-notify | `atrium#notify` | `TrustedPrompt.notify` for warnings about misbehaving apps |
| portal-print | `compat#adapter` | `CompatIsland.islandSocket("cups")` |
| portal-inhibit | `devd#service` | `PowerEvents` |
| portal-location | `devd#client` | GNSS device enumeration |
| portal-files | `devd#client`, `bench#user` | Removable-device watch; `Bench.media` (§4.2.6) |
| portal-files | `gate#client` | `Gate.stage`, `Intent.commit`/`status` for `media.export` (registered holder, `protocols §19.2`) |
| portal-a11y | `atrium#portal-a11y` | `A11yGate` |
| portal-clipboard | `atrium#portal-clipboard` | `ClipboardHost` |
| portal-inhibit | `atrium#portal-inhibit` | `InhibitHost` |
| portal-discovery | `net#discovery`; `depot#user` (registered holder) | `NetDiscovery`; manifest check for publish |
| portal-scan | `compat#adapter` | `CompatIsland.islandSocket("sane")` |
| portal-screen, portal-camera, portal-mic | `pipewire#portals` | The human's PipeWire daemon (atrium is the other registered holder) |

The schemas `display.capnp`, `screencast.capnp`, `picker.capnp` and `portals-extra.capnp` are in protocols; this repo defines only the repo-local schema `portal-ui.capnp` (§4.1). `MediaSave` (§4.2.6) is defined in `portals-extra.capnp` (`protocols §7.5.20`, Appendix A).

### 5.3 CLI: `portalctl`

```
portalctl status [--json]                 # running portal instances, active sessions (sensor, consumer), inhibitors
portalctl stop SESSION-ID                 # stop a sensor session (camera/mic/location/screen)
portalctl handlers [--json]               # resolved default handlers for schemes and MIME types
portalctl test-picker                     # debug images only: shows the picker for the calling user
```

Exit codes: 0 ok; 1 failed; 2 usage; 3 denied; 4 unavailable.

`portalctl` runs as the human's `shell` principal and holds the route `<portal>#ctl` on each portal service. Its actions are those the security centre offers.

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| App tricks the portal into opening a file outside the user's choice (symlink swap, `..`) | No caller paths; `openat2` beneath roots; final-component `O_NOFOLLOW` unless picker-resolved; fd returned is what the user saw |
| TOCTOU between picker display and open | The picker lists entries from the same dirfd it opens beneath. The open happens on the user's click from the parent dirfd; `fstat` identity (device and inode) is checked against the listing |
| App reads another app's camera stream | Restricted PipeWire clients see only their own node |
| Silent recording | Keystrip indicators driven by portals with lifetimes tied to sessions; no API to hide them |
| Clipboard snooping by background CLI tools | Every `Clipboard.read` needs a trusted card or a live 10-minute session allowance; the reader is raised to `private/untrusted` |
| Clipboard over-labelling | Writes through `portal-clipboard` are recorded by atrium with `portal-ui`'s label, which only grows during the child's life; this over-labels (never under-labels) pasted content. `portal-ui` children exit after 60 s idle, which resets it |
| Portal UI spoofing | `portal-ui` is a `trusted`-class client only when spawned by a portal service (atrium spec §4.1.1); an app cannot obtain that class |
| Untrusted web links opening in the user's main browser profile | Tier-2 browser routing (REQ-PORTALS-030) |
| Label laundering through handlers | Handler sessions get the caller's label (§4.5.2) |
| Malicious documents attacking the print or thumbnail path | Rendering only in confined helpers |
| Portal bugs as escape vectors | One portal per process; Rust; fd-only; fuzzing; each portal's privileges are minimal (§6.2) |
| Notification spoofing ("system update required") | Attribution and tier colour from the verified manifest; system notifications (`TrustedPrompt.notify`) have a distinct atrium style no app can request |
| Autostart persistence by malware | Autostart needs a T2 approval and a persistent broker grant, shown in the security centre, plus the background indicator at runtime; registrations of revoked or uninstalled generations are dropped at the next login |
| Malicious USB filesystem | Never parsed on the host; media VMs mount it; bytes reach apps as sealed memfd copies labelled `public/untrusted` (REQ-PORTALS-015) |
| Data exfiltration to a USB stick | Every write is the `media.export` effect with a T2 mandate bound to the exact bytes (REQ-PORTALS-016) |
| Spoofed or hostile mDNS answers | Results labelled `untrusted`, parsed with strict limits, never turned into grants (REQ-PORTALS-050) |
| App advertises itself on the LAN without consent | Publishing needs a manifest `needs.listen` declaration, a trusted card, and an open listen port granted through gate (REQ-PORTALS-051) |
| Scanner driver exploits | SANE backends run only in the compat island; the portal speaks the network protocol over a socket (REQ-PORTALS-052) |
| Agent spies on the screen or other apps' clipboard | Agents get only single window snapshots per T3 grant and their own clipboard data (REQ-PORTALS-023, -046, -047) |
| A single-file pick exposes sibling files (parent directory attached for path-expecting apps) | Single-file views contain only the selection; safe saves go through `portal-files` into the selected destination only (REQ-PORTALS-019, -019a) |
| Safe-save rename used to write elsewhere, or a destination swapped by a symlink race | The view refuses every other name; the replace runs on the portal-held parent dirfd with an identity check (§4.2.5) |

### 6.2 Confinement of each portal

All portals are tier-0 services with baseline confinement plus the following. Nothing else: no network, unless stated.

| Service | Extra grants and allowances |
|---|---|
| portal-files | The human's home root dirfd (read/write/create) from the service entry; Landlock rules for that root; `getdents64`, `openat2`, `fstatat`, `renameat2` (safe overwrite via temp + `RENAME_EXCHANGE` when the user selects "replace safely") |
| portal-screen | Routes to atrium only |
| portal-camera, portal-mic | Privileged PipeWire socket (route from warden to the per-human `pipewire` service); no device fds (PipeWire holds them) |
| portal-openuri | Home root dirfd read-only (MIME sniffing input only through caller fds; the root is used for `/grants` attachments); `warden#handler`; `portal-thumb` spawn |
| portal-notify | `warden#handler`; `atrium#notify` |
| portal-print | `privileges.localLink: true` (mDNS/IPP to link-local and private ranges only, §4.7); `compat#adapter`; `portal-print-render` spawn |
| portal-clipboard | Nothing beyond its `portal-ui` child |
| portal-location | GNSS device fds from broker device grants; optional gate grant to the configured geolocation provider |
| portal-a11y | `atrium#portal-a11y` |
| portal-background | `warden#handler`; state file in its per-human subvolume |
| portal-shortcuts | `atrium#portal-shortcuts` |
| portal-inhibit | `devd#service`; `atrium#portal-inhibit` |
| portal-files (media) | `bench#user`; staging subvolume `~/.apps/io.keylos.portals/cache/export/` (`O_TMPFILE` only) |
| portal-discovery | `net#discovery`; `depot#user` (registered holder); state file in its per-human subvolume |
| portal-scan | `compat#adapter`; spawns `portal-print-render` for encoding |
| pipewire | t1 per-human service: ALSA and V4L2 device fds from broker device grants; `RLIMIT_RTPRIO` 20; no network; no routes except its own socket (facet `portals`) |

**Helpers:**
- `portal-thumb` and `portal-print-render`: seccomp limited to read, write, mmap, munmap, mremap, brk, futex, exit_group, clock_gettime and rt_sigreturn; no `open*`; memfd input and output; CPU and memory limits as stated.
- `portal-ui`: tier-0 child of its portal, `trusted`-class Wayland client; no filesystem access except listing through dirfds its parent passes over the private channel; no routes except the Wayland socket and that channel.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| `portal-ui` crashes during a pick | `pick` returns an empty list (cancelled); the portal spawns a new child on the next request |
| PipeWire restart | Active camera, mic and screen sessions end; indicators are cancelled; callers see their remote closed |
| atrium unavailable | Screen, clipboard, shortcuts, toasts and indicators fail with `kl:unavailable`. Camera, mic and location **refuse** to start without the indicator (fail closed) |
| `warden#handler` route missing (misconfigured service table) | Autostart unavailable; `Background.request(…, autostart = true)` returns `granted = false` |
| Printer unreachable | The job stays queued in the dialog's job list for 10 minutes with retries, then fails |
| Broker label-authority unavailable | Clipboard reads and open-uri label propagation fail closed (`kl:unavailable`) |
| Handler generation not installed | `OpenUri.open` returns `kl:not-found` with a suggestion shown as a trusted notification ("No app for mailto:") |
| `bench` unavailable or VM cap reached | Media places show "Unavailable: too many VMs running"; nothing falls back to host mounting |
| Media device removed during export | `ExportCompletion.finish` fails; the memfd is discarded; the caller's writes had succeeded, and it gets a trusted notification "Copy to USB failed" |
| `media.export` intent denied or approval timed out | `ExportCompletion.abort`; notification "Not copied" |
| App keeps a shared writable mapping of the save memfd | Sealing fails with `EBUSY`; `portal-files` retries every 2 s for up to 5 min, then aborts with "Not copied: the app kept the file open" |
| `gate` unavailable | Media saves cannot finish; `abort` after 120 s; notification "Not copied: effect service unavailable" |
| `net` unavailable | `Discovery.browse` fails with `kl:unavailable`; publications end |
| SANE island crash | `Scan.scan` fails with `kl:unavailable`; compat restarts the island |
| `pipewire` crash | warden restarts it; active camera, mic and screen sessions end; callers reconnect |
| `portal-files` restarts while single-file views are attached | The views' FUSE connections end (`ENOTCONN`); `portal-files` re-creates the views of live grants on start (from the broker's grant list) and re-attaches them; unsaved temporary files are lost and the app sees its save fail |

---

## 8. Performance budgets

| Metric | Budget |
|---|---|
| Picker visible after `Broker.powerbox` | ≤ 150 ms (warm), ≤ 400 ms (cold `portal-ui`) |
| Listing a directory of 10,000 entries | ≤ 200 ms to first paint, incremental after that |
| Camera stream start after grant | ≤ 300 ms to the first frame (device permitting) |
| Revocation to stream end | ≤ 250 ms |
| `OpenUri.open` to handler spawn call | ≤ 20 ms |
| Clipboard read of 1 MiB | ≤ 10 ms |
| Memory per per-user portal instance (idle) | ≤ 8 MiB; `portal-ui` ≤ 60 MiB while shown |
| Media place listing (warm media VM, 1,000 entries) | ≤ 300 ms; cold media VM start ≤ 1.5 s (bench budget) |
| Media read throughput through `MediaBrowser.open` | ≥ 150 MiB/s on USB 3 |
| First discovery result after `browse` | ≤ 1.5 s on a LAN with responders |

---

## 9. Observability

- **Logs:** session start and stop per sensor (principal, kind, duration), picker outcomes (counts, never names), handler selections, denials.
- **Receipts:** portals emit no receipts directly. Grants are recorded by the broker (`grant.issue`, `grant.revoke`), and device access by devd (`device.grant`) where the portal triggers it.
- **Metrics:**
  - `portal_requests_total{portal,outcome}`
  - `portal_sessions_active{kind}`
  - `portal_picker_latency_seconds`
  - `portal_helper_kills_total{helper,reason}`

---

## 10. Configuration

```nickel
{
  PortalsConfig = {
    defaults = {
      browser | String | default = "org.mozilla.firefox",
      browser_untrusted | String | default = "io.keylos.browser.untrusted",
      schemes | { _ : String } | default = {},
      mime | { _ : String } | default = {},
    },
    notify = {
      per_minute | Number | default = 10,
      body_max_chars | Number | default = 1024,
    },
    clipboard = { session_allowance_secs | Number | default = 600, max_bytes | Number | default = 67108864, preview_chars | Number | default = 200 },
    ui = { idle_exit_secs | Number | default = 60 },
    inhibit = { max_suspend_minutes | Number | default = 30 },
    location = {
      default_accuracy | [| 'country, 'city, 'street, 'exact |] | default = 'city,
      network_provider | String | default = "",
    },
    print = { legacy_cups | Bool | default = false },
    scan = { enabled | Bool | default = false, max_dpi | Number | default = 600 },
    media = {
      max_open_bytes | Number | default = 4294967296,
      max_export_bytes | Number | default = 4294967296,
      save_idle_secs | Number | default = 10,     # end a media save without MediaSave.finish after this idle time
    },
    files = {
      single_view_tmp_bytes | Number | default = 4294967296,   # temporary-file quota of one single-file view (§4.2.5)
    },
    discovery = { publish_allowed | Bool | default = true },
    agents = {
      sensor_tier | [| 't2, 't3, 'forbid |] | default = 't3,
    },
  },
}
```

---

## 11. Testing and acceptance criteria

### 11.1 Unit tests

- Path handling: every open in §4.2.2 against a fixture tree with symlinks inside and outside roots, `..`, and renames racing the open (TOCTOU harness swaps an entry between listing and open; the `fstat` identity check must fail closed).
- Handler resolution table §4.5.1.
- Rate limiter behaviour.
- Clipboard session allowances (expiry, keyed by session ID, never inherited by child sessions).
- `confirmDrop` token validation (forged, expired, foreign-root tokens rejected).

### 11.2 Integration tests (keylos VM image)

1. An app with no camera grant calling `Camera.open` has no capability. A forged connection to the socket is impossible because there is no route (verify with `Process.confinement` and a socket scan).
2. With a grant, the PipeWire remote lists exactly one node; enumerating the registry shows nothing else.
3. Revoking the grant ends the stream in ≤ 250 ms, and the keystrip indicator disappears.
4. A powerbox `saveFile` on an existing name without overwrite confirmation fails; with it, the same inode is truncated.
5. `OpenUri.open("https://…")` from a principal labelled untrusted spawns the tier-2 browser generation.
6. `Clipboard.read` from a CLI job shows the trusted card; Deny returns `kl:denied`; Allow returns the data and the caller's label is `private/untrusted` afterwards (checked through the label-authority test double).
7. A malicious PDF crashing `portal-print-render` produces "Preview unavailable" while the portal stays up.
8. Legacy GTK app file dialog (via shim): the selected file appears at `/grants/<name>/<basename>` and is readable; `readdir` of `/grants/<name>` lists only it; opening, `stat`ing or guessing any sibling name fails (`ENOENT`); `..` from the view does not reach the real parent.
9. `Notify.post` with a `NotifyHandler`: activating an action calls `activated(id, action)`; without a handler, the `notify-action` entrypoint is spawned with the action id as `argv[1]` through `UserSpawn`.
10. `ScreenCapture.start("multiple")` returns one `CaptureStream` per source the user picked and a remote that can see exactly those nodes.
11. `OpenUri.open` from a principal labelled `private/untrusted` spawns the handler with that `initialLabel` (checked through `PrincipalControl` on the test warden).
12. With an approved autostart registration, `portal-background` spawns the entrypoint at the next login through `UserSpawn`; after the grant is revoked, the registration is dropped and nothing is spawned.
13. `Accessibility.observe` from a granted assistive principal calls `A11yGate.observer` with the caller as consumer and returns its observer; from an `agent` principal it fails with `kl:denied`.
14. `Inhibit.inhibit(["idle"], …)` calls `InhibitHost.inhibit` on the atrium test double; `["suspend"]` delays the `preSleep` ack on the devd test double; `["bogus"]` fails with `kl:invalid`.
15. Clipboard read: the reader's label equals the label returned by `ClipboardHost.source` for the current offer; an agent reading a selection owned by another principal's session gets `kl:denied`.
16. Media: an authorized mass-storage device appears as "USB: <label>"; opening a file returns a sealed memfd whose bytes equal the media VM's file; the caller's label is `public/untrusted`. No host mount appears in `/proc/self/mountinfo` of any host principal.
17. Media save: the returned fd is seekable; an app that writes, seeks back and rewrites gets the final contents on the device; `ExportCompletion.finish` is called only after the gate test double committed a `media.export` intent whose payload digest equals SHA-256 of those final bytes, and with exactly the mandate from `IntentStatus.result`; a mismatched mandate makes `portal-files` call `abort`. No `Broker.request` for `media.export` is made.
17a. `MediaSave.finish` from the saving session ends the save immediately; from another session it fails with `kl:denied`; without it, the save ends `save_idle_secs` after the last write.
18. Discovery: browse results raise the caller's label to integrity `untrusted`; publish without `needs.listen` scope `lan` fails with `kl:denied`; with it, the trusted card appears once per (generation, type).
19. Scan: each scan shows the card; the SANE island test double's frames are returned as a PNG memfd labelled `public/user`; the portal process has no SANE library mapped.
20. Screen for agents: `kind = "window"` fails with `kl:denied`; `"window-snapshot"` with the grant returns one frame and the grant's root ID is revoked afterwards.
21. pipewire: an app process cannot connect to the PipeWire socket (no route, no path in its view); portal-camera can.
22. A tier-2 guest's `GuestPortals.openUri("https://…")` relayed by bench-relay opens the untrusted browser.
23. Single-file view, writable grant: LibreOffice-style safe save (write `~lock`, temp file, `rename` over the selection) succeeds; the destination inode is replaced atomically (power cut during the save leaves the old or the new content); `rename` of the temp file to any other name, `link`, and `mkdir` fail with `EACCES`; nothing appears in the real parent except the replaced file.
24. Single-file view, read-only grant: `open(O_RDWR)`, `truncate`, `create` and `rename` fail with `EROFS`; reads succeed.
25. Race: between pick and save a third principal replaces the destination with a symlink to another file, then with a different regular file; the save fails, the other file is unchanged, and a trusted notification is shown.
26. Remembered file grant: after a reboot the app finds `/grants/<name>/<basename>` again as a single-file view; the parent is not attached (`PrincipalControl.mountView` shows only the FUSE view).
27. Revocation of a file grant while the app holds an open fd through the view: the view is detached, the fd returns `ENOTCONN`, the scratch files are deleted; a drag-and-drop of one file into a legacy app yields a single-file view with the same properties.

### 11.3 Fuzzing

PowerboxRequest and PickResult handling; MIME sniffing (`portal-thumb`); IPP response parsing; NMEA parsing; capwire message handling per portal.

### 11.4 Acceptance

All REQ-PORTALS requirements traced to tests. §8 budgets met. A privacy review checklist (indicators, revocation, labels) is signed off per release.

---

## 12. Implementation notes

### 12.1 Crates

| Crate | Use |
|---|---|
| `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas` 1.0.0 | Contracts, capwire, schema bindings |
| `tokio` 1, `rustix` 0.38 | Async, `openat2`, `getdents64` |
| `pipewire` 0.8 | PipeWire client and permissions |
| `ipp` | IPP client |
| `mdns-sd` | DNS-SD browsing |
| `nmea` | GNSS parsing |
| `zbus` | Only in `portal-xdg-shim` (inside legacy sandboxes) |
| `egui` or `iced` | `portal-ui` (trusted client) |
| `infer` | MIME sniffing (in `portal-thumb`) |
| `image`, `resvg` | Thumbnails (in `portal-thumb`) |

The PDF and PostScript renderer for `portal-print-render` comes from the pkgs set: MuPDF, built as a library and wrapped by a small Rust driver.

### 12.2 Layout

```
crates/portal-core/   crates/portal-files/   crates/portal-screen/   crates/portal-camera/
crates/portal-mic/    crates/portal-openuri/ crates/portal-notify/   crates/portal-print/
crates/portal-clipboard/ crates/portal-location/ crates/portal-a11y/ crates/portal-background/
crates/portal-shortcuts/ crates/portal-inhibit/ crates/portal-ui/ crates/portal-thumb/
crates/portal-print-render/ crates/portal-xdg-shim/ crates/portalctl/
schema/portal-ui.capnp          (repo-local; all shared schemas come from keylos-schemas)
seccomp/ config/portals.ncl tests/ fuzz/ pkg/
```

---

## 13. Decisions and alternatives

### 13.1 Decisions

| Decision | Alternatives | Reason | ADR |
|---|---|---|---|
| fd-only portals over capwire | xdg-desktop-portal over D-Bus; FUSE document portal | D-Bus is ambient authority; FUSE adds a path-based attack surface | [ADR-0035](../../handbook/11-decisions/adr-0035-fd-only-portals-dbus-islands.md) |
| Single-file views (one minimal FUSE directory per file grant, path-expecting clients only) with portal-executed safe saves (protocols E32, ISSUES ISS-005) | Attaching the parent directory (exposes siblings); a single-file bind mount (safe-save `rename` over a mount point fails); a general FUSE document portal (large path-based surface) | The grant covers exactly the selection, and legacy safe saves still work | [ADR-0035](../../handbook/11-decisions/adr-0035-fd-only-portals-dbus-islands.md) |
| One process per portal | One portal daemon | Privilege separation; contains bugs | [ADR-0002](../../handbook/11-decisions/adr-0002-rust-for-the-tcb.md) |
| Consent in broker, not portals | Portals prompting | One policy engine (Cedar), one approvals UI, one receipt trail | [ADR-0028](../../handbook/11-decisions/adr-0028-approval-tiers.md) |
| Untrusted links go to the tier-2 browser | Single browser | Web content is the most common untrusted input; VM containment for its renderer | [ADR-0043](../../handbook/11-decisions/adr-0043-non-reproducible-means-tier-2.md) |
| Labels propagate through clipboard and handlers | No labels for UI transfers | Otherwise copy-paste and "open with" launder untrusted or private data | [ADR-0026](../../handbook/11-decisions/adr-0026-labels-and-rule-of-two.md) |
| D-Bus only inside per-app islands (shim) | Host session bus for legacy | Keeps legacy compatibility without reintroducing a shared bus | [ADR-0035](../../handbook/11-decisions/adr-0035-fd-only-portals-dbus-islands.md) |

### 13.2 Dependencies and open protocol gaps

The portals use only interfaces, facets and formats of keylos-protocols 1.0.0 (final). `protocols §19.2` registers `portal-background` as a `warden#handler` holder, `portal-openuri` and `portal-discovery` as `depot#user` holders, `portal-inhibit` as a `devd#service` holder, `portal-files` as a `gate#client` holder and `bench-relay` as a `portal-*#default` holder, so no policy grant is needed. `media.export` is staged through `gate` and completed by bench (`protocols §14.2`), and seekable saves use `exportSeekable` with `ExportCompletion`; the end of a save is signalled by `MediaSave.finish` or detected as specified in §4.2.6.

`MediaSave`, called by apps through the SDK, is part of `portals-extra.capnp` (`protocols §7.5.20`); no repo-local schema crosses a repository boundary.

Facts the portals rely on from other components:
- The broker calls `FilePicker.pick` when serving `Broker.powerbox`, and attaches directory grants with `GrantMounts.attachGrant` (with a ceiling, `protocols` E31).
- `warden` attaches the detached mount of a `portal-files` single-file view through `GrantMounts.attachGrant` on facet `portals` like any other tree (`protocols` E32), and never attaches a picked file's parent.
- `warden` starts per-human portal instances, passes the home root dirfd per the service entry, and includes `portal-print` in `NetPlumbing.setLocalLinkUids` (`privileges.localLink: true`).
- atrium lists `io.keylos.portals.ui` in `trusted_generations` and treats a `portal-ui` whose parent is a portal service as `trusted`.

---

## Appendix A — Embedded contracts (verbatim)

Each block below is copied verbatim, by mechanical extraction, from `protocols/spec.md` of **keylos-protocols 1.0.0 (final)**. Only the section's own heading line is replaced by the `A.n` heading. Table excerpts keep the header rows and the rows relevant to this repository. If a copy differs from protocols, protocols wins.

### A.1 `protocols §3.4` — Principal identifiers

A principal is the tuple **(actor, human, session chain)**.

```
principal   = actor "@" human "/" session *( "/" session )
actor       = "app:" ref-gen
            / "service:" service-name ":" ref-gen
            / "agent:" ref-gen
            / "legacy:" ref-gen
            / "bench:" ref-gen
            / "pod:" pod-ns "/" pod-name ":" ref-gen-or-image
            / "shell"
            / "kernel"
human       = username / "_system" / "_cluster"
ref-gen-or-image = ref-gen / "oci:sha256:" 64HEXDIGLC   ; sealed container generation, or OCI image digest (keylos-vm pods)
session     = "s-" ULID          ; Crockford base32, 26 characters
ref-gen     = "gen:fsv256:" 64HEXDIGLC
```

Examples:
- `shell@alice/s-01JB6Q8Z0RXQ4M3W9V2N7T5K1C`
- `agent:gen:fsv256:9e1f…@alice/s-01JB6Q…/s-01JB6R…` (a sub-agent: the last session is the child)
- `service:vault:gen:fsv256:77aa…@_system/s-01JB5…`

Rules:
- The **session chain** records delegation. A child principal's chain is its parent's chain plus one new session. Its authority MUST be a subset of its parent's (§8).
- The **canonical key** for maps and log indexes is the full text form.
- Within a kernel, a running principal instance maps 1:1 to a **(UID, cgroup)** pair allocated by `warden` (§10.3). The mapping is published through `Supervisor.identify` (§7.3.2).
- A VM principal (tier 2 or 3) maps to the cgroup of its VMM process; processes inside the guest are not separate host principals.
- **Pod principals** (§21) always have human `_cluster`. A `keylos-vm` pod is one VM principal per pod sandbox whose actor names the pod's first container image; a `keylos-sealed` pod has one principal per container. The session chain starts at the `cri` service session.

### A.2 `protocols §6.3` — Manifest schema (`keylos.manifest/1`)

```json
{
  "schema": "keylos.manifest/1",
  "kind": "app",
  "name": "org.example.Editor",
  "version": "2.5.0",
  "summary": "A text editor",
  "publisher": "key:sha256:…",
  "derivation": "drv:sha256:…",
  "runtime": "gen:fsv256:…",
  "tier": 1,
  "entrypoints": {
    "main": {"exec": "/usr/bin/editor", "args": [], "kind": "gui"},
    "cli":  {"exec": "/usr/bin/editor-cli", "args": [], "kind": "cli"}
  },
  "needs": {
    "jit": false,
    "gpu": "render",
    "network": [{"host": "api.example.com", "ports": [443], "proto": "tcp", "methods": ["GET", "POST"], "why": "Sync"}],
    "listen": [],
    "devices": [],
    "services": ["portal-files", "portal-notify"],
    "secrets": [{"name": "sync-token", "why": "Account sync"}],
    "dataUnits": ["default"],
    "spawn": [],
    "portalIsland": false,
    "labels": {"readsUntrusted": true}
  },
  "provides": {
    "commands": ["editor"],
    "services": [],
    "mimeTypes": ["text/plain"],
    "uriSchemes": [],
    "agentTools": [],
    "workflows": []
  },
  "effects": [],
  "l10n": {"default": "en", "languages": ["en", "uk", "de"]},
  "compat": null,
  "agent": null,
  "webapp": null,
  "container": null,
  "kmod": null,
  "benchImage": null,
  "grafted": false,
  "requiresFeatureLevel": "KL1",
  "reproducible": true
}
```

Normative field rules:
- `kind`, `name`, `version` (SemVer 2.0), `schema` and `entrypoints` (except for kinds `config`, `policy`, `data`, `part`, `agent-template`, `container`, `kmod`) are REQUIRED. `benchImage` is REQUIRED for kind `bench-image`.
- `tier` for kind `container` is set by `cri` per runtime class (§21), never by the manifest; kind `kmod` has no tier.
- `tier`:
  - one of `0` (services only), `1`, `2`, `"L"`;
  - `bench-image`, `agent-template` and `part` omit it;
  - the **effective tier** is `max(manifest.tier, policy floor, token tier_floor)`. Policy floors are config options of the form `apps.<name>.tierFloor`. Policy can raise a tier, never lower it.
- `entrypoints.<name>.kind`: `gui`, `cli`, `service`, `harness`, `handler` (spawned by `portal-openuri` for URIs/MIME types), `notify-action` (spawned when a notification action is activated).
- `needs.gpu`: `"none"`, `"render"` (render node), `"display"` (compositor only, no GPU device) or `"passthrough"` (VFIO passthrough of a whole GPU into a VM; valid only for effective tier 2/3 and for pods, and only on machines whose config lists a passthrough GPU). If omitted, it is `"none"`.
- `needs.realtime: true` asks for realtime scheduling: `warden` sets `RLIMIT_RTPRIO = 20` and `RLIMIT_RTTIME = 200 000 µs` for the principal. Shown at install. There is no realtime broker daemon.
- `needs.csi` (kind `container` only): `{"driver": "<CSI driver name>", "nodePlugin": "<entrypoint>", "controller": false}` declares a CSI node plugin; such containers always run in a `keylos-vm` pod VM (§21).
- `webapp` (kind `app` only): `{"origin": "https://app.example.com", "scope": "/", "name": "…", "icons": ["/.keylos/icons/…"], "browserRuntime": "gen:fsv256:…"}`. The generation is an installable web app: it runs the sealed browser-shell runtime named by `browserRuntime`, restricted to `origin` through `gate` grants derived from `origin` and `needs.network`, with its own data unit and principal. A webapp generation MUST NOT declare `needs.jit` itself; the runtime generation declares it.
- `container` (kind `container` only): `{"image": "oci:sha256:<manifest digest>", "platform": "linux/amd64", "config": {"entrypoint": [], "cmd": [], "env": [], "user": "", "workingDir": ""}}`, copied from the OCI image config at conversion.
- `kmod` (kind `kmod` only): `{"kernel": "<uname -r>", "modules": ["nvidia", "nvidia-modeset", …], "firmware": []}`.
- `benchImage` (kind `bench-image` only): `{"purposes": ["workbench", "agent", …], "desktop": false}`. `purposes` lists the `VmSpec.Purpose` values (§7.3.13) the image supports; `bench` refuses other purposes. `desktop: true` marks an agent-desktop image (nested atrium) and is required for purpose `agentDesktop`.
- `needs.jit: true` lets the generation create executable anonymous memory (§9.3). It MUST be shown to the user at install.
- `needs.network[]` entries are **requests**. The broker turns them into grants at install time (after consent) or on first use, depending on policy.
- `needs.listen[]`: `{"port": N, "proto": "tcp"|"udp", "scope": "loopback"|"lan"|"any", "why": "…"}`. Inbound listening is granted only through `gate` (`listen:` targets, §7.3.7) and `net` firewall plumbing.
- `needs.portalIsland: true` asks `compat`/`warden` to run a per-app portal island (GTK/Qt portal shim) inside the app's own principal. It grants no authority.
- `effects[]` declares effect kinds the app can stage through `gate` (§14.2), for example `{"kind": "email.send", "class": "irreversible"}`.
- `provides.workflows[]` names the workflow definitions the generation ships, each at `/.keylos/workflows/<name>.json` (`keylos.workflow/1`, §20.27; names `[a-z][a-z0-9-]{0,62}`). `loom` enrolls only definitions listed here.
- `l10n`: default language and available translations in `/.keylos/l10n/<lang>.json` (`{"summary": …, "entrypoints": {"main": {"name": …}}, "needs": {"network": [{"why": …}]}}`). Display code MUST apply bidi isolation and confusable checks to localised strings.
- `compat`: `null` except for `legacy-image`, where it is an object conforming to `keylos.compat/1` (defined in the `compat` spec; consumed only by `compat`).
- `agent`: `null` except for `agent-template`, where it is `{"template": "/.keylos/agent/template.json", "flowProof": null | "camel/1"}` (§6.4).
- `grafted: true` marks a generation produced by an emergency graft (§11.1). Grafted generations are launchable but flagged in every UI and replaced automatically when the real rebuild lands.
- `reproducible: false` forces effective `tier ≥ 2` unless an owner exception record exists (`keylos.exception/1`, §20.9).
- Unknown fields MUST be rejected unless prefixed `x-`. Anything prefixed `x-` MUST be ignored by verifiers and MUST NOT carry authority.
- **Capability diff:** on update, `depot` computes the difference in `needs`, `tier`, `effects` and `provides.services` between the installed and the new manifest. Any widening needs consent (`keylos.consent/1`, §20.8) before the new generation becomes launchable.

The JSON Schema is `jsonschema/manifest-1.json`, shipped in this repo.

### A.3 `protocols §7.1` — Model

All keylos IPC between principals on one kernel uses **Cap'n Proto RPC (rpc.capnp, level 1 plus promise pipelining)** over **AF_UNIX `SOCK_SEQPACKET`** sockets.

- **There is no system bus.** A process can reach only the capabilities it was handed:
  - the bootstrap capability of each socket `warden` passed to it at spawn (listed in `KEYLOS_CAPWIRE_FDS`, §10.5),
  - capabilities returned by calls on those.
- **The one exception is the CRI boundary** (§21): the upstream `kubelet` speaks the Kubernetes CRI v1 gRPC API to `cri` over an `AF_UNIX` `SOCK_STREAM` socket that `warden` creates and passes to `kubelet` (route `cri#kubelet`). No other non-capwire IPC between keylos principals is allowed.
- **Holding is authority.** A capability or an fd received through capwire is itself the authority to use it. capwire has **no call-attached tokens**: methods that need token-based authority take an explicit `C.Token` parameter; otherwise the route facet or the held capability is the authority.
- **Framing:** one Cap'n Proto message (standard segment-table framing) per datagram.
  - Maximum datagram size: 4 MiB.
  - Larger data MUST use a `ByteStream`/`ByteSource` capability or a passed fd.
- **File descriptors** travel as `SCM_RIGHTS` ancillary data on the same datagram, at most 64 per datagram. Inside the message, an fd is referenced by an `Fd` struct whose `index` is its position in that datagram's fd array.
  - **No fd** is written as `index = 0xFFFF`, which is the struct default; a null `Fd` pointer also means "no fd". Senders SHOULD write `Fd` structs explicitly. A method that requires an fd fails with `kl:invalid` when it gets none.
  - An `Fd.index` that is out of range, or that a receiver resolves a second time, fails **that call** (or that result's processing) with `kl:invalid`; the connection stays up. The transport is schema-unaware, so an index is checked when the receiver resolves the field.
  - Every received fd that no field took is closed when the receiver releases the message (call parameters released, or the response dropped).
  - Fds can be attached to any parameter or result struct of a message built on a capwire connection, including structs with pointer fields only; a caller does not need to resolve a bootstrap promise before sending fds on it.
  - `ENOBUFS` and `ENOMEM` from `sendmsg` are transient: the sender retries with backoff for up to 1 s before it fails the connection.
- **Datagram rules** (violations are protocol errors that fail the **whole connection**, reported to the local side as `kl:invalid`): exactly one standard-framed message per datagram with no trailing bytes; size ≤ 4 MiB; ≤ 64 fds; ancillary data not truncated (`MSG_TRUNC`/`MSG_CTRUNC`); fds never on capwire-vsock. Senders MUST NOT send zero-length datagrams; a receiver reads a zero-byte datagram as end of connection. A sender whose own outgoing message would exceed 4 MiB fails the connection rather than leave the peer waiting.
- **Socket buffers.** `warden` (and any component that creates capwire sockets for others) sets `SO_SNDBUFFORCE` and `SO_RCVBUFFORCE` to at least 4 MiB + 64 KiB (4 259 840 bytes) on both ends of every capwire socketpair it creates, so 4 MiB datagrams fit; distributions set `net.core.wmem_max` and `net.core.rmem_max` ≥ 4 259 840 (§2). capwire-vsock endpoints set `SO_VM_SOCKETS_BUFFER_SIZE`/`_MAX_SIZE` to the same value.
- **Peer identity:**
  - Every capwire connection between principals is a `socketpair` created by `warden` (§7.2). For such sockets the kernel records the **creating** process (`warden`) as the peer of both ends, so `SO_PEERPIDFD` and `SO_PEERCRED` name `warden`, not the peer. Servers MUST take the peer's principal, tier, generation and facet **only** from `ServiceHost.accept` (§7.5.1), or from `Supervisor.connectionInfo` for a connection ID `warden` delivered.
  - `SO_PEERPIDFD` + `Supervisor.identify` MAY be used only for sockets the peer itself `connect()`ed to a listening socket (not used between keylos principals in 1.0; reserved for diagnostics and future listeners).
  - Servers MUST NOT use PIDs, executable paths, or claims inside messages to decide who the caller is.
- **Bootstrap:** the socket's bootstrap capability implements the service's root interface **and** `common.Extensible` (§7.3.1). It is already narrowed by `warden` to the route's facet (§7.2).

### A.4 `protocols §7.2` — Routes and facets

`warden` wires services according to **routes** declared in service and app manifests plus policy.

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

- A **facet** is a server-defined restriction name. The registry of every facet, its holders and the methods it allows is §19.2. Servers MUST refuse methods their facet doesn't allow with `kl:denied`.
- Route references are written `service#facet` (for example `vault#app`).
- The server learns the facet of each connection from `ServiceHost.accept` (§7.5.1) or `Supervisor.connectionInfo`.
- Service sockets live under `/run/keylos/svc/<service>/` with mode `0700`, owned by `warden`'s UID. No other principal can `connect()` to them. Connections are created by `warden` (`socketpair` + hand-off through `ServiceHost.accept`).
- Dynamic routes (a service capability granted at runtime) are materialised by `broker` through `ServiceConnect.connectService` (§7.5.1).

### A.5 `protocols §7.3.1` — `common.capnp`

```capnp
@0xc7a1e5d3b2f40001;

struct Digest {
  algo  @0 :Algo;
  bytes @1 :Data;            #! sha256/fsv256: 32 bytes; sha512: 64 bytes
  enum Algo { sha256 @0; sha512 @1; fsv256 @2; }
}

struct Ref {                 # typed reference, protocols §3.2
  kind   @0 :Kind;
  digest @1 :Digest;
  enum Kind { obj @0; gen @1; src @2; drv @3; rcpt @4; key @5; }
}

struct Fd { index @0 :UInt16 = 0xFFFF; }   #! index into the SCM_RIGHTS array of the carrying datagram; 0xFFFF (the default) and a null pointer mean "no fd"

struct Timestamp { unixNanos @0 :Int64; }

struct PrincipalId { text @0 :Text; }   #! canonical text form, protocols §3.4
struct SessionId   { text @0 :Text; }

struct Label {
  conf  @0 :Conf;
  integ @1 :Integ;
  enum Conf  { public @0; internal @1; private @2; secret @3; }
  enum Integ { trusted @0; user @1; untrusted @2; }
}

struct Token { biscuit @0 :Data; }      #! Biscuit v3 serialized token, protocols §8

struct KeyValue { key @0 :Text; value @1 :Text; }

struct AttemptBinding {          #! one execution attempt of a durable workflow (§20.25); epoch 0 (the default) = not an attempt
  workflow @0 :Text;             # wf-…
  attempt  @1 :Text;             # wa-…
  epoch    @2 :UInt64;           # ownership epoch of the claim (BrokerWorkflow.claim, §7.5.25)
  step     @3 :Text;             # ws-… the attempt executes
  owner    @4 :Text;             # the workflow's owning human; warden uses it as the attempt principal's human
}

interface ByteStream {
  write @0 (bytes :Data) -> stream;
  done  @1 ();
}

interface ByteSource {
  read @0 (maxBytes :UInt32) -> (bytes :Data, eof :Bool);
}

interface Cancelable { cancel @0 (); }

interface Watcher(T) {          # server-push subscription
  event @0 (event :T) -> stream;
}

interface Extensible {          #! implemented by every bootstrap capability
  ext     @0 (interfaceId :UInt64) -> (cap :Capability);   #! kl:denied if the facet does not allow that interface, or the server does not implement it
  version @1 () -> (protocols :Text, implementation :Text);   #! protocols: SemVer of this document ("1.0.0"); implementation: "<repo>/<SemVer>"
}
```

**Errors.** Methods signal failure with a Cap'n Proto exception of type `failed`. The exception `reason` string MUST start with `kl:<code>`, optionally followed by `:<ref>` (non-empty), then optionally a space and a human-readable message. Codes outside the table are a parse error. Root interfaces are not declared `extends(C.Extensible)`; clients obtain the `Extensible` view of a bootstrap capability by casting the same capability.

| Code | Meaning |
|---|---|
| `denied` | Policy refused. Not retryable without new authority. |
| `needs-approval` | `:<ref>` is an approval ID (`a-…`). Retry after the approval resolves, or use the returned `Approval`. |
| `not-found` | |
| `invalid` | Malformed request |
| `conflict` | State changed concurrently |
| `expired` | |
| `revoked` | |
| `budget` | Budget exhausted |
| `integrity` | Verification failure: signature, digest, fs-verity |
| `unavailable` | Transient; MAY retry with backoff |
| `unsupported` | Feature level or platform lacks support |
| `internal` | |

Example: `kl:needs-approval:a-01JB6R… Sending email requires approval`.

### A.6 `protocols §7.3.2` — `warden.capnp`

```capnp
@0xc7a1e5d3b2f40002;
using C = import "common.capnp";

enum Tier { t0 @0; t1 @1; t2 @2; t3 @3; legacy @4; }

struct FdMapping { target @0 :Int32; fd @1 :C.Fd; }

struct Limits {
  cpuWeight  @0 :UInt16 = 100;    # cgroup cpu.weight
  memoryMax  @1 :UInt64;          # bytes, 0 = inherit
  pidsMax    @2 :UInt32;          # 0 = inherit
  ioWeight   @3 :UInt16 = 100;
  wallSecs   @4 :UInt32;          # 0 = unlimited
}

struct SpawnSpec {
  generation  @0 :C.Ref;          #! kind gen; MUST be launchable (sealed, not revoked)
  entrypoint  @1 :Text;           # manifest entrypoint key, default "main"
  argv        @2 :List(Text);     # appended to entrypoint args
  env         @3 :List(C.KeyValue);  #! secrets MUST NOT be passed via env; warden rejects names matching policy secret patterns and reserved KEYLOS_* names;
                                     #! for actorKind pod the secret-pattern check is skipped (the admitted Kubernetes env may carry secrets, §21)
  fds         @4 :List(FdMapping);   # explicit fds; nothing else is inherited
  grants      @5 :List(C.Token);     # tokens attached to the new principal
  cwd         @6 :C.Fd;              # O_PATH dirfd; optional
  limits      @7 :Limits;
  terminal    @8 :C.Fd;              # pty secondary; optional; warden calls setsid+TIOCSCTTY
  session     @9 :C.SessionId;       # new child session id; warden generates if empty
  actorKind   @10 :ActorKind;
  transaction @11 :Text;             # optional strata transaction id (x-…); warden mounts the transaction views over the granted dirs
  enum ActorKind { app @0; service @1; agent @2; legacy @3; bench @4; shell @5; pod @6; }
  attempt     @12 :C.AttemptBinding; #! workflow attempt (§20.25): honoured only from service loom (facet service); warden forwards it
                                     #! unchanged in SessionReg.attempt and never interprets it; set by any other caller: kl:denied
}

struct ExitStatus {
  union {
    exited   @0 :Int32;
    signaled @1 :Int32;
    failedToStart @2 :Text;   # kl:<code> reason
  }
  cpuNanos @3 :UInt64;
  maxRss   @4 :UInt64;
}

interface Process {
  pidfd     @0 () -> (fd :C.Fd);             # kl:unsupported for VM processes
  principal @1 () -> (id :C.PrincipalId);
  wait      @2 () -> (status :ExitStatus);
  signal    @3 (signo :Int32) -> ();         #! delivered to every process of the principal's cgroup
  kill      @4 () -> ();                     # cgroup.kill
  confinement @5 () -> (report :Text);       # JSON confinement report, protocols §9.4
  freeze    @6 () -> ();                     # cgroup.freeze = 1
  thaw      @7 () -> ();                     # cgroup.freeze = 0
}

struct ConnectionInfo {
  peer   @0 :C.PrincipalId;
  facet  @1 :Text;
  tier   @2 :Tier;
  label  @3 :C.Label;          # current session label (from broker)
  generation @4 :C.Ref;
}

interface Supervisor {
  spawn          @0 (spec :SpawnSpec) -> (process :Process);   #! the child's session chain extends the caller's
  identify       @1 (pidfd :C.Fd) -> (id :C.PrincipalId, tier :Tier, generation :C.Ref);
  connectionInfo @2 (connectionId :UInt64) -> (info :ConnectionInfo);
  services       @3 () -> (list :List(ServiceStatus));
  control        @4 (service :Text, op :ServiceOp) -> (status :ServiceStatus);
      #! service "_system" is the pseudo-target for system power: ops poweroff/reboot (facet admin only)
  enum ServiceOp { start @0; stop @1; restart @2; reload @3; poweroff @4; reboot @5; }
}

struct ServiceStatus {
  name       @0 :Text;
  state      @1 :State;
  generation @2 :C.Ref;
  since      @3 :C.Timestamp;
  restarts   @4 :UInt32;
  enum State { inactive @0; starting @1; running @2; stopping @3; failed @4; }
}
```

### A.7 `protocols §7.3.3` — `broker.capnp`

```capnp
@0xc7a1e5d3b2f40003;
using C = import "common.capnp";

struct NetTarget {
  host    @0 :Text;            # DNS name or IP literal; "listen:<addr>" requests a listening socket (§7.3.7)
  port    @1 :UInt16;
  proto   @2 :Proto;
  methods @3 :List(Text);      # HTTP methods, empty = protocol-level grant only
  enum Proto { tcp @0; udp @1; https @2; }
}

struct Budget { unit @0 :Text; amount @1 :Int64; }   # unit: "usd-micro", "tokens", "calls"

struct ResourceRef {
  union {
    path      @0 :Text;          # resolved by broker with openat2(RESOLVE_BENEATH) from a held root
    dirFd     @1 :C.Fd;          # caller already holds it; request attenuation/annotation
    net       @2 :NetTarget;
    device    @3 :Text;          # device id, protocols §3.5
    secret    @4 :Text;          # vault item name (caller-scoped)
    budget    @5 :Budget;
    spawn     @6 :C.Ref;         # right to spawn a generation
    service   @7 :Text;          # "name#facet"
    effect    @8 :Text;          # effect kind, e.g. "email.send"
    delegate  @9 :Void;          # right to create sub-principals
    principal @10 :DebugTarget;  # debug target (Right.debug), §9.3
    screen    @11 :Text;         # "window:<atrium window id>": one still snapshot of a real-session window (Right.read), §14.5
    model     @12 :Text;         # "<provider>/<model>@<version>": re-approval of an agent session's model after drift (Right.use), §14.5
  }
}

struct DebugTarget {
  target  @0 :Text;              # "session:s-…" (a running session and its descendants) or "gen:fsv256:…" (any instance of a generation of the requesting human)
  scope   @1 :Scope;
  enum Scope { process @0; kernel @1; }   #! kernel: bpftrace-class tracing, presence-only, ≤ 900 s
}

enum Right { read @0; write @1; create @2; delete @3; exec @4; connect @5; bind @6; use @7; spend @8; spawn @9; stage @10; commit @11; delegate @12; debug @13; }

struct GrantRequest {
  resource     @0 :ResourceRef;
  rights       @1 :List(Right);
  reason       @2 :Text;         # shown to the human
  durationSecs @3 :UInt32;       # 0 = policy default
  persist      @4 :Bool;         # request a persistent grant (survives session and reboot; needs presence)
  onBehalfOf   @5 :C.PrincipalId; # informational only (vault, depot, strata, atrium via requestFor): the principal the service acts for;
                                  #! shown on the prompt and recorded in receipts; never used for authorization
}

struct GrantOutcome {
  union {
    granted @0 :C.Token;
    pending @1 :Approval;
    denied  @2 :Text;
  }
}

interface Approval {
  id      @0 () -> (id :Text);
  wait    @1 () -> (outcome :GrantOutcome);
  cancel  @2 () -> ();
  mandate @3 () -> (mandate :Data);   #! DSSE keylos.mandate/1 after approval; kl:not-found before or if denied
}

struct Handle {
  union {
    fd      @0 :C.Fd;            # file, dirfd (O_PATH), device, memfd
    socket  @1 :C.Fd;            # connected socket (usually to gate) or capwire socket to a service
    cap     @2 :Capability;      # service capability
  }
}

interface Broker {
  request     @0 (req :GrantRequest) -> (outcome :GrantOutcome);
  materialize @1 (token :C.Token, resource :ResourceRef, rights :List(Right)) -> (handle :Handle);
  attenuate   @2 (token :C.Token, checks :List(Text)) -> (token :C.Token);  #! Datalog checks, protocols §8.3
  delegate    @3 (tokens :List(C.Token), child :C.SessionId, checks :List(Text)) -> (tokens :List(C.Token));
  revoke      @4 (rootId :Data) -> ();
  inspect     @5 (token :C.Token) -> (facts :List(Text), expires :C.Timestamp, rootId :Data);
  label       @6 () -> (label :C.Label);
  raiseLabel  @7 (label :C.Label, reason :Text) -> (label :C.Label);  #! raises the CALLER's session label only; labels only go up
  powerbox    @8 (req :PowerboxRequest) -> (grants :List(PowerboxGrant));
  myGrants    @9 () -> (tokens :List(C.Token));
  debug       @10 (token :C.Token, debugger :C.Ref, entrypoint :Text, argv :List(Text), pty :C.Fd) -> (process :Capability);
      #! materialises a Right.debug grant through warden DebugAttach (§7.5.1); returns a warden.Process
}

struct PowerboxRequest {
  kind     @0 :Kind;
  title    @1 :Text;
  mimeTypes @2 :List(Text);
  multiple @3 :Bool;
  suggestedName @4 :Text;
  enum Kind { openFile @0; openDirectory @1; saveFile @2; }
}

struct PowerboxGrant {
  fd    @0 :C.Fd;        # opened file, or O_PATH dirfd usable in the holder's view (attached via GrantMounts, §7.5.1)
  token @1 :C.Token;     # token describing the grant (for persistence / delegation)
  displayName @2 :Text;
  viewPath @3 :Text;     # path of the grant inside the holder's view (/grants/<name>), for path-expecting code
}
```

**Directory grants and Landlock.** A Landlock domain cannot be widened after `restrict_self`. A directory granted at runtime is therefore made reachable by `warden` attaching a bind mount at `/grants/<name>` inside the holder's mount namespace (`GrantMounts.attachGrant`, §7.5.1), whose subtree is covered by the Landlock rule the view was built with (`/grants` is allowed at spawn with the access rights of the highest possible grant; actual access is bounded by mount flags and the attached tree). `materialize` of a path or dirFd grant returns an fd opened **through that mount**.

**Directory grant ceilings.** Every directory grant has an **exposure label** (its ceiling, §14.1). The broker raises the holder's session label to the ceiling **before** the mount is attached, and passes the ceiling to `attachGrant`; `warden` then refuses, for the grant's lifetime, every open of an object through that mount (and every read through an fd opened through it) whose label exceeds the ceiling or is malformed (§9.3). Grant trees are non-recursive bind mounts: mounts nested below the granted directory are not reachable through the grant.

**Single-file grants.** A file picked for a path-expecting client is never exposed by attaching its parent directory. It is exposed as a **single-file view** `/grants/<name>/<basename>`: a directory served by `portal-files` that contains only the selected file and the holder's own temporary files. Writes follow the granted rights (a read-only grant refuses every write); a safe-save `rename(<temporary> → <basename>)` is carried out by `portal-files` as an atomic replace of the selected file in its real parent, whose dirfd `portal-files` holds and never exposes; every other name is refused. Access to the parent or any sibling needs an explicit `openDirectory` consent. Remembered grants, re-materialization, revocation and drag-and-drop keep the same single-file scope.

### A.8 `protocols §7.3.4` — `prompt.capnp` (trusted path; implemented by `atrium`, used by `broker`, `hearth`, `vault`, `config`, `depot`, `fleet`, `vouch`)

```capnp
@0xc7a1e5d3b2f40004;
using C = import "common.capnp";

enum ApprovalTier { t0 @0; t1 @1; t2 @2; t3 @3; }

struct RenderedEffect {
  kind      @0 :Text;            # e.g. "email.send", "fs.merge", "config.apply"
  title     @1 :Text;
  body      @2 :Text;            # plain text or sanitized markdown
  mime      @3 :Text;            # "text/plain" | "text/markdown" | "text/x-diff" | "image/png"
  attachment @4 :C.Fd;           # optional large rendering (diff, preview)
  reversible @5 :Bool;
  review     @6 :Review;          #! required (default): approval is enabled only when this rendering was presented completely (§14.3)
  payloadDigest @7 :C.Digest;     #! digest of the mandate-draft effect this rendering presents (sha256)
  enum Review { required @0; decorative @1; }   #! decorative: optional preview; set only by gate or broker, never by a requester
}

struct ArgProvenance {
  argument @0 :Text;
  source   @1 :Text;             # e.g. "web:https://example.com/page", "file:/home/…", "user"
  label    @2 :C.Label;
}

struct ApprovalPrompt {
  id         @0 :Text;
  tier       @1 :ApprovalTier;
  principal  @2 :C.PrincipalId;
  summary    @3 :Text;
  effects    @4 :List(RenderedEffect);
  provenance @5 :List(ArgProvenance);
  mandateDraft @6 :Data;          # JCS payload of the mandate to be signed if approved
  requiresPresence @7 :Bool;      # FIDO2 touch required
  expires    @8 :C.Timestamp;
  channels   @9 :List(Text);      # approval channels allowed for this prompt ("local", "phone", "org"), §14.3; empty = ["local"]
  requester  @10 :Text;           # for family machines: the non-owner human on whose behalf an owner is asked (§14.3); empty otherwise
}

struct Decision {
  approved @0 :Bool;
  scope    @1 :Scope;
  mandate  @2 :Data;              # DSSE envelope (presence-signed when requiresPresence, else signed by the atrium approver key)
  note     @3 :Text;
  enum Scope { once @0; session @1; persistent @2; }
}

interface TrustedPrompt {
  approve  @0 (prompt :ApprovalPrompt) -> (decision :Decision);
  presence @1 (purpose :Text, payload :Data, rendering :List(RenderedEffect)) -> (envelope :Data);
      # DSSE signed by owner-presence (§5.3), rendered on the trusted path; rendering (optional) is shown
      # alongside the statement (for example a config plan diff) and its digests are displayed for cross-checking
  notify   @2 (title :Text, body :Text, severity :Severity) -> ();
  secret   @3 (title :Text, body :Text, confirm :Bool) -> (secret :C.Fd);
      #! secret entry on the trusted path (recovery key, trustee card, new PIN, passphrase); confirm = enter twice;
      #! the value is returned in the delivery format of §20.10; facet secret only
  enum Severity { info @0; warning @1; critical @2; }
}
```

**Required review material.** Every `RenderedEffect` is `review = required` unless `gate` or `broker` marked it `decorative`; a requester can never make a rendering optional, and an unknown or absent value means `required`. The trusted path (local prompts, presence cards, phone, org and quorum review) enables approval only when every required rendering was presented **completely**: its `payloadDigest` equals the digest of the mandate-draft effect it presents, it carries all required review details of its effect kind (§14.2), and nothing required is missing, malformed, unsupported or truncated beyond the channel's review limits. When a decoder or renderer crashes or times out, a canonical-text fallback produced by `gate` may replace the rendering only if it presents every required detail within the limits; otherwise the effect can only be denied or deferred. A title or a digest alone never substitutes for required details. A channel that cannot present the required material (for example a phone over its size limit) does not offer the approval: it stays pending for a capable channel or expires and is denied under its normal lifecycle (§14.3).

**Secret entry.** `TrustedPrompt.secret` (facet `secret`: `hearth` for recovery keys, trustee cards, new PINs and passphrases; `vault` for import passphrases) asks for a secret on the trusted path and returns it in the delivery format of §20.10; the value never passes through the requesting app.

### A.9 `protocols §7.3.15` — `net.capnp`, `devd.capnp`, `journal.capnp`, `portals.capnp`, `compat.capnp`

```capnp
@0xc7a1e5d3b2f40015;   # net.capnp
using C = import "common.capnp";
struct Link { name @0 :Text; kind @1 :Text; state @2 :Text; addresses @3 :List(Text); metered @4 :Bool; }
struct WifiNetwork { ssid @0 :Text; security @1 :Text; signal @2 :Int16; known @3 :Bool; }
interface Net {
  links     @0 () -> (list :List(Link));
  wifiScan  @1 () -> (list :List(WifiNetwork));
  wifiJoin  @2 (ssid :Text, credential :C.Fd) -> ();    #! facet user only; credential stored via vault
  vpnUp     @3 (profile :Text) -> ();                   #! facet user only
  vpnDown   @4 (profile :Text) -> ();                   #! facet user only
  resolve   @5 (name :Text) -> (addresses :List(Text), dnssec :Bool);
  time      @6 () -> (synced :Bool, offsetNanos :Int64, source :Text);
  status    @7 () -> (json :Text);
}
```

```capnp
@0xc7a1e5d3b2f40016;   # devd.capnp
using C = import "common.capnp";
struct Device { id @0 :Text; subsystem @1 :Text; name @2 :Text; properties @3 :List(C.KeyValue); }
interface Devd {
  list   @0 (subsystem :Text) -> (list :List(Device));
  open   @1 (id :Text, token :C.Token, flags :UInt32) -> (fd :C.Fd);   # facet broker; callers use broker.materialize
  watch  @2 (subsystem :Text, watcher :C.Watcher(Device)) -> (cancel :C.Cancelable);
  power  @3 (op :Text) -> ();                                         # "suspend" | "poweroff" | "reboot" (hibernate: kl:unsupported)
}
```

```capnp
@0xc7a1e5d3b2f40017;   # journal.capnp
using C = import "common.capnp";
struct Entry { time @0 :C.Timestamp; principal @1 :C.PrincipalId; level @2 :UInt8; message @3 :Text; fields @4 :List(C.KeyValue); }
interface Journal {
  writer @0 () -> (stream :C.Fd);                                  # SOCK_SEQPACKET, protocols §10.6 record format; attributed to the caller
  query  @1 (filterJson :Text, limit :UInt32) -> (entries :List(Entry), cursor :Text);
  follow @2 (filterJson :Text, watcher :C.Watcher(Entry)) -> (cancel :C.Cancelable);
}
```

```capnp
@0xc7a1e5d3b2f40018;   # portals.capnp
using C = import "common.capnp";
struct CaptureStream { nodeId @0 :UInt32; width @1 :UInt32; height @2 :UInt32; sourceDescription @3 :Text; }
interface ScreenCapture { start @0 (kind :Text) -> (streams :List(CaptureStream), remote :C.Fd); }   # remote = PipeWire remote fd restricted to the nodes
interface Camera        { open @0 () -> (remote :C.Fd); }
interface Microphone    { open @0 () -> (remote :C.Fd); }
interface OpenUri       { open @0 (uri :Text) -> (); openFile @1 (file :C.Fd) -> (); }
interface NotifyHandler { activated @0 (id :UInt32, action :Text) -> (); }
interface Notify        { post @0 (title :Text, body :Text, actions :List(Text), handler :NotifyHandler) -> (id :UInt32); close @1 (id :UInt32) -> (); }
  #! handler is optional; when null, activation spawns the app's "notify-action" entrypoint with the action id as argv[1]
interface Print         { print @0 (document :C.Fd, mime :Text, optionsJson :Text) -> (jobId :Text); }
interface Clipboard     { read @0 (mime :Text) -> (data :C.Fd); write @1 (mime :Text, data :C.Fd) -> (); }
interface Location      { current @0 (accuracy :Text) -> (lat :Float64, lon :Float64, accuracyM :Float64); }
interface Accessibility { observe @0 () -> (observer :Capability); }    # returns an A11yObserver (§7.5.17); assistive-tech principals only
struct ServiceInstance { name @0 :Text; type @1 :Text; host @2 :Text; port @3 :UInt16; addresses @4 :List(Text); txt @5 :List(C.KeyValue); }
interface Discovery {                                                    # portal-discovery (mDNS / DNS-SD)
  browse  @0 (serviceType :Text, watcher :C.Watcher(ServiceInstance)) -> (cancel :C.Cancelable);   #! results raise the caller's label to integ untrusted
  publish @1 (instance :Text, serviceType :Text, port :UInt16, txt :List(C.KeyValue)) -> (handle :C.Cancelable);
      #! requires a listen grant for port (needs.listen scope lan) and a publish grant; on the local link only
}
struct ScanOptions { resolutionDpi @0 :UInt16; mode @1 :Text; source @2 :Text; format @3 :Text; }   # mode: color|gray|lineart; format: png|pdf|jpeg
interface Scan {                                                         # portal-scan (SANE backends in a compat island)
  scanners @0 () -> (list :List(Text));
  scan     @1 (scanner :Text, options :ScanOptions) -> (image :C.Fd);    #! trusted-path confirmation per scan; result labelled public/user
}
```

```capnp
@0xc7a1e5d3b2f40019;   # compat.capnp
using C = import "common.capnp";
using W = import "warden.capnp";
interface Compat {
  importImage @0 (source :Text) -> (generation :C.Ref);   # "oci://…", "flatpak://remote/ref", "distro:<name>:<release>", "rootfs:<dirfd>"
  run         @1 (generation :C.Ref, argv :List(Text), fds :List(W.FdMapping), grants :List(C.Token)) -> (process :W.Process);
}
```

### A.10 `protocols §7.5.1` — `warden-sys.capnp`

```capnp
@0xc7a1e5d3b2f40020;
using C = import "common.capnp";
using W = import "warden.capnp";
using B = import "broker.capnp";

interface Bootstrap {                  #! bootstrap of fd 3 in every tier-0 service (connection to warden)
  host     @0 (host :ServiceHost) -> ();   # the service registers its ServiceHost; MUST be called first
  ready    @1 () -> ();                    # readiness signal
  watchdog @2 () -> ();                    # liveness ping (interval from the service manifest)
  status   @3 (text :Text) -> ();          # human-readable status line
}

interface ServiceHost {                #! implemented by every tier-0 service; warden is the only caller
  accept @0 (socket :C.Fd, connectionId :UInt64, facet :Text, peer :C.PrincipalId, tier :W.Tier, generation :C.Ref) -> ();
  stop   @1 (reason :Text) -> ();          # cooperative stop before SIGTERM
  reload @2 () -> ();                      # the config generation changed; warden has rebuilt the service's /etc view
}

interface GrantMounts {                # facets broker, bench, compat, portals, cri (idmappedDir only)
  attachGrant @0 (session :C.SessionId, name :Text, tree :C.Fd, readOnly :Bool, ceiling :C.Label) -> (inView :C.Fd, viewPath :Text);
      #! bind-mounts tree (non-recursive, idmapped to the holder's dynamic UID) at /grants/<name> in the holder's mount namespace;
      #! inView = O_PATH fd of the mount root opened through the holder's namespace;
      #! ceiling = the grant's exposure label (§14.1): objects labelled above it are never readable through the mount;
      #! a null ceiling means no enforcement (the caller MUST then have raised the holder to secret/untrusted)
  detachGrant @1 (session :C.SessionId, name :Text) -> ();
  idmappedDir @2 (dir :C.Fd, forPrincipal :C.PrincipalId, readOnly :Bool) -> (tree :C.Fd);
      #! detached idmapped clone (open_tree + mount_setattr MOUNT_ATTR_IDMAP); used by bench/compat for shares
}

enum TerminateMode { kill @0; freeze @1; thaw @2; }

struct PrincipalEvent {
  session   @0 :C.SessionId;
  principal @1 :C.PrincipalId;
  time      @2 :C.Timestamp;
  union {
    spawned @3 :W.Tier;
    exited  @4 :W.ExitStatus;
    frozen  @5 :Void;
    thawed  @6 :Void;
  }
  cgroupId  @7 :UInt64;          # kernel cgroup id of the principal's scope (stable for the session's lifetime)
}

interface PrincipalControl {           # facets broker, admin, hearth (terminate own humans' sessions), strata (events, mountView), cri (pod sessions)
  terminate @0 (session :C.SessionId, mode :TerminateMode) -> ();   #! applies to the session and all descendant sessions
  list      @1 (humanFilter :Text) -> (sessions :List(C.PrincipalId));
  events    @2 (watcher :C.Watcher(PrincipalEvent), replay :Bool) -> (cancel :C.Cancelable);
      #! replay = true: first emits one `spawned` event for every currently running session (visible to the facet), then live events
  mountView @3 (session :C.SessionId) -> (json :Text);               # JCS: [{target, source, flags, grant}]
  fenceWriters @4 (tree :C.Fd, exclude :List(C.SessionId)) -> (fence :WriterFence);
      #! facet strata: freezes every session (except exclude and their descendants) whose view can write inside tree,
      #! and returns once they are frozen; kl:conflict if a writer cannot be frozen (tier-0 service other than strata,
      #! kernel or network filesystem writer); released by WriterFence.release, when the capability is dropped, or after 30 s
}

interface WriterFence {
  sessions @0 () -> (list :List(C.SessionId));   # the frozen sessions
  release  @1 () -> ();                         # thaws them
}

interface ServiceConnect {             # facet broker
  connectService @0 (session :C.SessionId, service :Text, facet :Text) -> (socket :C.Fd);
      #! creates a route for an existing principal; returns the principal-side capwire socket
}

interface FdStore {                    # facet service (each service sees only its own keys)
  store @0 (key :Text, fd :C.Fd) -> ();    #! survives the service's restarts within one boot
  fetch @1 (key :Text) -> (fd :C.Fd);
  drop  @2 (key :Text) -> ();
}

struct LegacyGrant { tree @0 :C.Fd; target @1 :Text; readOnly @2 :Bool; }

struct LegacyView {
  image    @0 :C.Ref;                  # legacy-image generation
  stateDir @1 :C.Fd;                   # per-image writable state (overlay upper + work)
  grants   @2 :List(LegacyGrant);
  netMode  @3 :Text;                   # "none" | "pasta"
}

interface LegacySpawn {                # facet compat
  spawnLegacy @0 (spec :W.SpawnSpec, view :LegacyView, brokerSession :C.SessionId) -> (process :W.Process, notifyFd :C.Fd);
      #! user namespace with a 65 536-UID block, child user.max_user_namespaces=0;
      #! notifyFd = seccomp user-notification listener for the open broker (protocols §9.2);
      #! brokerSession = the per-app open-broker session that gets the read pairing to this app (§9.3)
}

interface UserSpawn {                  # facets launcher (atrium launcher), handler (portal-openuri, portal-notify, portal-background)
  spawnForHuman @0 (spec :W.SpawnSpec, human :Text, initialLabel :C.Label) -> (process :W.Process);
      #! new top-level session under the human's current shell session; label starts at max(default, initialLabel)
}

interface TrustedSpawn {               # facet trusted-terminal (atrium-term only)
  spawnTerminal @0 (spec :W.SpawnSpec, pty :C.Fd) -> (process :W.Process);
      #! actorKind MUST be shell; warden withholds SECBIT_EXEC_DENY_INTERACTIVE for exactly this process tree (§9.3)
}

interface DebugAttach {                # facet broker (materialises Right.debug, §9.3)
  attach @0 (target :Text, scope :Text, debugger :C.Ref, entrypoint :Text, argv :List(Text),
             pty :C.Fd, expiresSecs :UInt32, grantId :Text, requester :C.PrincipalId) -> (process :W.Process);
      #! target "session:s-…" | "gen:fsv256:…"; scope "process" | "kernel"; expiresSecs ≤ 3600 (process), ≤ 900 (kernel);
      #! debugger MUST be a launchable generation whose manifest name is in the policy list debug.debuggers;
      #! warden spawns it as a child of requester's shell session (the human the grant was minted to) with seccomp profile
      #! debug-1 and the ambient capabilities of §9.3, writes kl_debug_pairs, and on expiry or exit removes the pair,
      #! kills the debugger and writes debug.detach
}

struct PodMount {
  tree       @0 :C.Fd;
  target     @1 :Text;
  readOnly   @2 :Bool;
  tmpfsBytes @3 :UInt64;   # 0: bind tree at target; > 0: warden creates a tmpfs of that size at target and copies tree into it
                           #  (configMap, secret, projected and downwardAPI volumes, §21.6)
}

struct PodContext {
  podId        @0 :Text;               # pod-… (§3.5)
  namespace    @1 :Text;
  name         @2 :Text;
  uid          @3 :Text;               # Kubernetes pod UID (metadata)
  netns        @4 :C.Fd;               # pod network namespace created by cri inside the cri network
  sharePid     @5 :Bool;               # shareProcessNamespace
  mounts       @6 :List(PodMount);     # volumes, prepared by cri (strata volumes, projected tmpfs)
  cgroupParent @7 :Text;               # under /keylos.slice/kube.slice/
  seccomp      @8 :Text;               # "baseline-1" | "runtime-default" (baseline-1 ∩ the CRI RuntimeDefault profile)
  readOnlyRoot @9 :Bool;
  runAsUid     @10 :UInt32;            # container-visible UID; mapped through a per-pod mapping-only userns held by warden (idmapped rootfs)
}

interface PodSpawn {                   # facet cri (keylos-sealed runtime class only, §21)
  spawnContainer @0 (spec :W.SpawnSpec, pod :PodContext) -> (process :W.Process);
      #! spec.generation MUST be kind container with an org-publisher genstmt; actorKind pod; tier t1;
      #! the container joins pod.netns and (if sharePid) the pod's pid namespace; no added capabilities, ever;
      #! the root is read-only plus tmpfs at /tmp, /run, /var/tmp and /dev/shm (§21.8)
  execInContainer @1 (spec :W.SpawnSpec, container :C.SessionId) -> (process :W.Process);
      #! CRI Exec/ExecSync: a child session of the container's principal that joins its mount, pid, net, ipc and uts
      #! namespaces and its cgroup; spec.generation MUST equal the container's generation; no added capabilities
  egressShim      @2 (podId :Text) -> (shim :Capability);
      #! a gate-sys ShimEndpoint (§7.5.12) bound to the pod's principals, created by warden as for tier L; cri runs the
      #! pod's egress redirector with it when cluster.egressViaGate is set (§21.5)
}

struct VmPrincipal {
  session       @0 :C.SessionId;
  parentSession @1 :C.SessionId;      # session the VM descends from (agent: the aide-created chain; pod: cri's session)
  principalKind @2 :W.SpawnSpec.ActorKind;   # bench, agent, legacy or pod
  image         @3 :C.Ref;            # bench-image generation
  template      @4 :C.Ref;            # agent-template generation for agent VMs, else empty
  tier          @5 :W.Tier;           # t2 or t3
  offered       @6 :List(C.Token);    #! tokens held by parentSession (e.g. the launching human's), to be attenuated for the VM
  purpose       @7 :Text;             # VmSpec.Purpose enumerant name
  podId         @8 :Text;             # purpose pod only
  checks        @9 :List(Text);       #! Datalog checks (§8.3) the broker appends when attenuating `offered` for this VM (sub-agents: aide narrows the parent's grants)
  budgets       @10 :List(B.Budget);  #! hard sub-meters carved from the offered roots (GateMeterAdmin.carve, §7.5.12) for this VM principal
  attempt       @11 :C.AttemptBinding; #! from VmSpec.attempt / ForkSpec.attempt; forwarded unchanged in SessionReg.attempt
}

interface VmSpawn {                    # facet bench
  register   @0 (vm :VmPrincipal) -> (principal :C.PrincipalId, cgroupId :UInt64, tokens :List(C.Token));
      #! creates the VM principal (dynamic UID, cgroup scope, BrokerSystem.registerSession); the actor follows §3.4
      #! (agent: "agent:" + template; pod: "pod:…"; otherwise "<kind>:" + image); tokens are those the broker issued
  spawnVmm   @1 (session :C.SessionId, spec :W.SpawnSpec) -> (process :W.Process);
      #! spawns crosvm, its device processes, bench-net and bench-relay inside the VM principal's cgroup;
      #! spec.generation MUST be the bench generation; warden wires bench-net to gate#shim and bench-relay to
      #! aide#host (agent VMs), broker#principal, vault#app and portal-*#default for that principal
  unregister @2 (session :C.SessionId) -> ();   # after the last VMM process of the principal exited
}
```

### A.11 `protocols §7.5.2` — `broker-sys.capnp`

```capnp
@0xc7a1e5d3b2f40021;
using C = import "common.capnp";
using B = import "broker.capnp";
using P = import "prompt.capnp";

struct SessionReg {
  child    @0 :C.PrincipalId;
  parent   @1 :C.SessionId;        # empty for warden-originated system services
  offered  @2 :List(C.Token);
  onRevoke @3 :Text;               # "kill" | "freeze"
  budgets  @4 :List(B.Budget);     #! hard sub-budget ceilings for the child (VmPrincipal/ForkSpec budgets): the broker carves each from
                                   #! the matching offered root (GateMeterAdmin.carve) before issuing tokens; kl:budget if a parent meter is short
  attempt  @5 :C.AttemptBinding;   #! workflow attempt (§20.25): verified against the broker's workflow record (claimed epoch, attempt,
                                   #! allowed generation and spawner); the child's label and tokens then come from that record (§7.5.25)
}

struct SessionRegResult {
  tokens    @0 :List(C.Token);
  label     @1 :C.Label;
  tierFloor @2 :UInt8;             # 0..4 = t0..legacy
}

struct FlowCheck {
  session       @0 :C.SessionId;
  kind          @1 :Text;          # effect kind or "net"
  target        @2 :Text;
  payloadDigest @3 :C.Digest;
  rendered      @4 :List(P.RenderedEffect);
  provenance    @5 :List(P.ArgProvenance);
  flowProof     @6 :Data;          # optional DSSE keylos.flowproof/1 (§20.11)
  intent        @7 :Text;          # e-… id of the staged intent; empty for connect-time "net" checks
}

struct GrantResult {
  outcome @0 :B.GrantOutcome;
  mandate @1 :Data;                # DSSE keylos.mandate/1 when the outcome was decided by approval; empty otherwise.
                                   #! presence-signed when presence was required; otherwise signed by service/broker (§14.4)
}

struct PodAdmission {
  allowed   @0 :Bool;
  reasons   @1 :List(Text);        # forbid/permit policy ids and failed checks
  tierFloor @2 :UInt8;             # 1 = keylos-sealed allowed, 2 = keylos-vm required
  approval  @3 :Text;              # a-… when an @tier/@orgApproval permit applies (pods wait for it)
}

interface BrokerSystem {           # facet system
  registerSession    @0 (reg :SessionReg) -> (result :SessionRegResult);           # warden
  sessionEnded       @1 (session :C.SessionId, exitText :Text) -> ();              # warden
  checkFlow          @2 (check :FlowCheck) -> (result :GrantResult);               # gate: Rule of Two at stage/commit/connect
  requestFor         @3 (subject :C.SessionId, req :B.GrantRequest, intent :Text, idempotencyKey :Text,
                          intentSession :C.SessionId, decidedOnTrustedPath :Bool) -> (result :GrantResult);
      #! approval request on behalf of a subject session (intent = e-… id or empty). Allowed subjects per caller:
      #! gate → sessions that staged the intent (intentSession = the staging session when it differs from subject);
      #! aide → its agent sessions; strata, depot, vault, atrium → only their own session (atrium: device authorization).
      #! The broker deduplicates by (caller, idempotencyKey) for 24 h: a repeated call returns the same approval/result.
      #! decidedOnTrustedPath: atrium only (device authorization): the human already decided on atrium's trusted-path card;
      #! the broker evaluates policy, records approval.decide with channel "local" and returns the mandate without
      #! prompting again. MUST be false (else kl:invalid) for every other caller or when policy requires presence.
  registerApprover   @4 (publicKey :Data, alg :Text, channel :Text) -> ();         # atrium ("local") and vouchd ("phone"), once per boot
  registerSessionKey @5 (session :C.SessionId, publicKey :Data) -> ();             # aide: agent session key (flow proofs, commits)
  annotateRequest    @6 (session :C.SessionId, provenanceJson :Text) -> ();        # aide: provenance hints for the next request
  rootsChanged       @7 (fdkeys :List(Text)) -> ();                                # strata: re-open held roots after rollback
  revokeSession      @8 (session :C.SessionId, mode :Text) -> ();                  # hearth (lock/logout), warden
  loadPolicy         @9 (generation :C.Ref) -> ();                                 # config: activate a policy generation
  validatePolicy     @10 (tree :C.Fd) -> (ok :Bool, problems :List(Text));         # config: dry-run a candidate policy tree
  mintCaptive        @11 (session :C.SessionId) -> (token :C.Token);               # net: captive-portal token (§8.2 captive fact)
  admitPod           @12 (podSpecJson :Text, runtimeClass :Text) -> (admission :PodAdmission);
      #! cri: Cedar evaluation of action "admit" on a PodSpec entity (§16, §21.3); podSpecJson is the CRI PodSandboxConfig
      #! plus container configs, normalised by cri to keylos.podspec/1 (§21.3)
}

interface LabelAuthority {         # facet label-authority
  labelOf  @0 (session :C.SessionId) -> (label :C.Label);
  raiseFor @1 (session :C.SessionId, label :C.Label, reason :Text) -> (label :C.Label);   #! labels only go up; receipt label.raise
}
```

`registerApprover.publicKey` is a DER SubjectPublicKeyInfo; other encodings fail `kl:invalid`. A method whose receipt must be written before it replies (§19.3) answers `kl:unavailable` while the serving component's own `ledger.key.register` has not been appended; the broker registers its key before it serves facet `system`.

### A.12 `protocols §7.5.15` — `compat-sys.capnp`

```capnp
@0xc7a1e5d3b2f4002e;
using C = import "common.capnp";

interface CompatIsland {           # facet adapter (devd Bluetooth adapter, portal-print CUPS adapter, vault import island)
  islandSocket @0 (service :Text) -> (socket :C.Fd);
      #! connected socket to the island; the protocol depends on the island: "bluez", "cups-dbus" → filtered D-Bus proxy;
      #! "sane" → SANE network protocol (saned) stream; "cups" → IPP over HTTP/1.1; "secret-import" → filtered D-Bus proxy
}
```

### A.13 `protocols §7.5.17` — `a11y.capnp`

```capnp
@0xc7a1e5d3b2f40030;
using C = import "common.capnp";

struct A11yNode {
  id          @0 :UInt64;
  role        @1 :Text;              # ARIA role names
  name        @2 :Text;
  description @3 :Text;
  value       @4 :Text;
  states      @5 :List(Text);        # "focused","selected","checked","disabled","expanded",…
  bounds      @6 :Bounds;            # surface-local logical coordinates
  children    @7 :List(UInt64);
  actions     @8 :List(Text);        # "click","focus","increment","decrement","scroll-into-view",…
  textSel     @9 :TextSelection;
  struct Bounds { x @0 :Int32; y @1 :Int32; w @2 :Int32; h @3 :Int32; }
  struct TextSelection { anchor @0 :UInt32; focus @1 :UInt32; }
}

struct A11yUpdate { surfaceId @0 :UInt32; nodes @1 :List(A11yNode); removed @2 :List(UInt64); focus @3 :UInt64; }

interface A11yApp {                # implemented by the app or bridge; called by atrium
  doAction @0 (node :UInt64, action :Text) -> (ok :Bool);
}

interface A11yHost {               # atrium facets bridge, native
  attach @0 (app :A11yApp) -> (sink :C.Watcher(A11yUpdate));
}

interface A11yObserver {           # handed to assistive principals through the Accessibility portal
  tree       @0 () -> (updates :List(A11yUpdate));
  watch      @1 (watcher :C.Watcher(A11yUpdate)) -> (cancel :C.Cancelable);
  doAction   @2 (surfaceId :UInt32, node :UInt64, action :Text) -> (ok :Bool);
  speakFocus @3 () -> (text :Text);
}

interface A11yGate {               # facet portal-a11y (portal-a11y)
  observer @0 (consumer :C.PrincipalId) -> (observer :A11yObserver);
      #! consumer MUST be an assistive-technology principal (generation name in the owner-configured assistive list);
      #! the observer never exposes surfaces of the trusted path, password fields or tier-2 windows' contents
}
```

### A.14 `protocols §7.5.18` — `screencast.capnp`

```capnp
@0xc7a1e5d3b2f40031;
using C = import "common.capnp";

struct CastRequest {
  consumer @0 :C.PrincipalId;
  kinds    @1 :List(Kind);
  cursor   @2 :CursorMode;
  multiple @3 :Bool;
  enum Kind { output @0; window @1; region @2; }
  enum CursorMode { hidden @0; embedded @1; metadata @2; }
}

struct CastStream { nodeId @0 :UInt32; width @1 :UInt32; height @2 :UInt32; sourceDescription @3 :Text; }

interface Screencast {             # facet portal-screen
  start @0 (req :CastRequest) -> (streams :List(CastStream), remote :C.Fd, stop :C.Cancelable);
      #! shows the trusted picker; remote = PipeWire remote fd restricted to the returned nodes
}

interface ShortcutsHost {          # facet portal-shortcuts
  bind   @0 (owner :C.PrincipalId, shortcuts :List(C.KeyValue)) -> (bound :List(C.KeyValue));
  events @1 (owner :C.PrincipalId, watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);
  unbind @2 (owner :C.PrincipalId, ids :List(Text)) -> ();
}

interface IndicatorHost {          # facets portal-camera, portal-mic, portal-location, portal-background, portal-screen
  show @0 (kind :Text, consumer :C.PrincipalId, description :Text) -> (handle :C.Cancelable);
      #! kind: "camera" | "microphone" | "location" | "screen" | "background"; shown until handle.cancel
}

interface ClipboardHost {          # facet portal-clipboard
  source @0 (offerId :Text) -> (owner :C.PrincipalId, label :C.Label, mimeTypes :List(Text));
      #! the label atrium recorded for the principal that created the selection offer; portal-clipboard raises the
      #! reader's label to it (not to private/untrusted) before handing data over
}

interface InhibitHost {            # facet portal-inhibit
  inhibit @0 (owner :C.PrincipalId, kinds :List(Text), reason :Text) -> (handle :C.Cancelable);
      #! kinds "idle" | "logout" handled by atrium; "suspend" | "lid" are forwarded by portal-inhibit to devd PowerEvents
}
```

### A.15 `protocols §7.5.19` — `picker.capnp`

```capnp
@0xc7a1e5d3b2f40032;
using C = import "common.capnp";
using B = import "broker.capnp";

struct PickResult {
  fd          @0 :C.Fd;
  rootKey     @1 :Text;          # identifies the held root dirfd (matches the broker path_root fact)
  relPath     @2 :Text;          # path relative to root, normalised, no ".."
  displayName @3 :Text;
  kind        @4 :Kind;
  persist     @5 :Bool;          # user ticked "Remember access"
  enum Kind { file @0; directory @1; created @2; }
}

interface FilePicker {             # portal-files facets broker (pick), drop (atrium: confirmDrop)
  pick        @0 (req :B.PowerboxRequest, requester :C.PrincipalId, user :Text) -> (results :List(PickResult));
      #! empty list = user cancelled
  confirmDrop @1 (tokens :List(C.Token), target :C.PrincipalId) -> (results :List(PickResult));
}
```

### A.16 `protocols §7.5.20` — `portals-extra.capnp`

```capnp
@0xc7a1e5d3b2f40033;
using C = import "common.capnp";

interface Background {
  request @0 (reason :Text, autostart :Bool, entrypoint :Text) -> (granted :Bool);
  status  @1 () -> (granted :Bool, autostart :Bool);
}

interface GlobalShortcuts {
  bind   @0 (shortcuts :List(C.KeyValue)) -> (bound :List(C.KeyValue));
  events @1 (watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);
  unbind @2 (ids :List(Text)) -> ();
}

interface Inhibit {
  inhibit @0 (kinds :List(Text), reason :Text) -> (handle :C.Cancelable);   # kinds: "idle","suspend","logout","lid"
}

interface MediaSave {                    # portal-files, facet default (apps, via the SDK)
  finish @0 (relPath :Text) -> ();       # the caller finished a seekable save it received for removable media; portal-files completes the export
  cancel @1 (relPath :Text) -> ();       # discard the save (ExportCompletion.abort)
}
```

### A.17 `protocols §10.1` — Host layout

| Path | Content | Properties |
|---|---|---|
| `/` | OS generation (composefs, `verity=require`) | ro |
| `/usr` | Part of the OS generation | ro |
| `/etc` | Merged config generation (confext) | ro |
| `/var` | btrfs subvolume `@var` | rw, `nosuid,nodev,noexec` |
| `/home/<user>` | btrfs subvolume per user | rw, `nosuid,nodev,noexec` |
| `/home/<user>/.apps/<app-name>/{config,data,cache,state}` | Subvolume per app and user | the only writable paths in an app's view |
| `/store/objects/<2 hex>/<62 hex>` | Store objects, fs-verity enabled, mode 0444 | written only by `depot` |
| `/store/gens/<64 hex>.erofs` | Generation images | |
| `/store/evidence/` | Generation statements, attestations, consent records | `depot` |
| `/store/db/` | `depot` database | |
| `/store/rcpt/` | `ledger` data | |
| `/keystore` | btrfs subvolume `@keystore`, **excluded from all snapshots** | `vault`, `hearth`, `ledger`, `strata` key material (wrapped) |
| `/snapshots` | btrfs snapshot area, `strata` only | |
| `/run` | tmpfs | |
| `/run/keylos/svc/<svc>/` | Service socket directories | 0700 warden |
| `/run/keylos/boot/trust.json`, `report.json` | Boot trust set and boot report (§20.1) | 0444, written by `boot` |
| `/var/lib/keylos/<repo>/` | Each service's private state directory (other repos may read only the files listed in §10.7) | owned by the service's dynamic UID |
| `/var/lib/keylos/cri/images/` | OCI content store for `keylos-vm` pods (unsealed, never executed on the host) | `cri`; `noexec`; shared read-only into pod VMs |
| `/efi` | ESP | mounted only during updates (and by `boot` for `/efi/keylos/vbu-totp.sealed`) |

**App mount view** (what a tier-1 process sees):
- its app generation at `/` (with `/usr` from its runtime generation if it declares one);
- `/etc` filtered to the app-visible subset (`/etc/keylos/app-visible.list` in the config generation);
- its `.apps/<name>` subvolumes at `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `$XDG_CACHE_HOME`, `$XDG_STATE_HOME` (idmapped to its dynamic UID);
- `/run/user/<uid>/` with only its Wayland socket (security-context tagged) and its PipeWire remote if granted;
- `/grants/` (initially empty; runtime grants are attached here);
- `/tmp` as a private tmpfs;
- nothing else.

### A.18 `protocols §14.1` — Labels

| Dimension | Values (lowest → highest) |
|---|---|
| Confidentiality | `public` (0) < `internal` (1) < `private` (2) < `secret` (3) |
| Integrity | `trusted` (0) < `user` (1) < `untrusted` (2). Higher means *less* trustworthy |

- **Objects:**
  - Files carry `security.bpf.keylos.label`. Files without one inherit the default for their location: home data `private/user`; downloads and web content `public/untrusted`; store objects `public/trusted`.
  - Sockets get a label per connection from `gate`: responses from hosts are `untrusted` unless the policy marks the host `user`.
- **Sessions:** each principal session has a label. On every broker-mediated read, `session.conf = max(session.conf, object.conf)` and `session.integ = max(session.integ, object.integ)`. Labels never decrease within a session.
- **Label authority:** services that hand data from one principal to another (gate, bench, portals, atrium, strata, aide, journal, warden) raise the receiver's label with `LabelAuthority.raiseFor` (§7.5.2) **before** handing the data over. `warden` reads live labels with `labelOf` for `ConnectionInfo.label`.
- **Removable media and discovery:** bytes from `MediaBrowser` and results from `Discovery.browse` are `public/untrusted`.
- **Rule of Two** (enforced by `broker` and `gate`): define three properties of a session:
  - **U** = `integ == untrusted`
  - **P** = `conf ≥ private`
  - **X** = holds or requests a capability with `Right.commit`, an `effect` resource, or egress to a host not marked `sink-safe`

  A session MUST NOT hold all three. Requesting the third turns into a **declassification** approval at tier T3, unless a policy-registered **flow proof** (§20.11) is accepted. A flow proof is accepted only from an `agent-template` whose manifest `agent.flowProof` is `"camel/1"` and whose harness runtime is in the policy's trusted list.
- **Directory grants** (ceilings). A directory exposed to a session through a grant has an **exposure label** *c*, and the label assumptions hold only if *c* bounds everything readable through the grant for its whole lifetime:
  - The receiver's session label is raised to *c* (`raiseFor`) **before** the directory is exposed, and the resulting policy decision (Rule of Two) is enforced at that point.
  - *c* is enforced by `warden` (§7.3.3, §9.3): objects labelled above *c*, or with a malformed label, are not readable through the grant, whenever they appeared. Unlabelled objects count at their location default.
  - The broker may choose *c* as the join of a **complete** assessment of the tree. A bounded or truncated walk never justifies anything lower than the location default; entries above *c* then stay unreadable through the grant and are reported as hidden.
  - Without enforcement (null ceiling) the exposure label is the lattice maximum `secret/untrusted`.
  - Writes, relabels and renames into the tree, retained handles and concurrent changes are covered because enforcement happens at every open and read through the grant, not at grant time. A retained fd loses read access as soon as its object's label rises above *c*.
  - Agent input SHOULD be an **immutable assessed view** (a transaction base snapshot or a bench share snapshot): its complete assessment is final, so its exposure label can be lower without losing workflows to the `secret` deny of agent policy.

### A.19 `protocols §19.1` — Service names (excerpt: portal rows)

| Service | Repo | Tier | Notes |
|---|---|---|---|
| `portal-files`, `portal-screen`, `portal-camera`, `portal-mic`, `portal-openuri`, `portal-notify`, `portal-print`, `portal-clipboard`, `portal-location`, `portal-a11y`, `portal-background`, `portal-shortcuts`, `portal-inhibit` | portals | t0 (per-user instances) | One process per portal per logged-in human |
| `portal-discovery`, `portal-scan` | portals | t0 (per-user instances) | mDNS/DNS-SD; scanners through a compat SANE island |
| `pipewire` | portals | t1 (per-user instance) | The human's PipeWire daemon (upstream, sealed); reachable only by portals, which hand out restricted remotes |

### A.20 `protocols §19.2` — Facets (excerpt: rows naming portals)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| warden | `bench` | bench | `VmSpawn` (VM principals; `spawnVmm` for per-VM `crosvm` device processes, `bench-net` wired to `gate#shim`, `bench-relay` wired to `aide#host`, `broker#principal`, `vault#app` and `portal-*#default`); `GrantMounts.idmappedDir` |
| warden | `portals` | portal-files, portal-openuri | `GrantMounts.attachGrant`/`detachGrant` for portal-island grants and single-file views (§7.3.3) |
| warden | `handler` | portal-openuri, portal-notify, portal-background | `UserSpawn` |
| broker | `label-authority` | gate, bench, portal-*, atrium, strata, aide, journal, warden | `LabelAuthority` |
| gate | `client` | principals with net needs, portal-files, atrium (staging `media.export`) | `connect`, `stage` (own session), `intents` (own session tree, recursive), `intent` (own session tree), `meter` (own roots); `DurableEffects.prepare`, `complete`, `lookup`, `watch` (attempt sessions, own workflow) |
| net | `captive` | atrium | `NetCaptive` (`status`, `portalUrl`, `signIn`); `NetWatch` |
| net | `discovery` | portal-discovery | `NetDiscovery` |
| depot | `user` | `shell`, atrium, aide, portal-openuri, portal-discovery, gate, any principal granted `depot#user` | `get`, `list`, `install`, `verify`, `revocations`, `revocationStatus`, `openObject` (closures the caller may spawn), `openPath` (`/.keylos/…` only) |
| devd | `service` | hearth, strata, atrium, portal-inhibit | `PowerEvents` (subscribe + ack) |
| bench | `user` | kish, `work`, atrium, portal-files, forge | `project`, `start` (purposes workbench; build (forge only, `unsignedImageOk`); app (kish, atrium launcher: non-reproducible native apps at tier 2)), `snapshots`, `media` (atrium, portal-files), `reattach` (own VMs) |
| compat | `adapter` | devd, portal-print, portal-scan, vault | `CompatIsland` |
| atrium | `notify` | tier-0 services, portal-notify | `TrustedPrompt.notify` |
| atrium | `portal-screen`, `portal-shortcuts`, `portal-camera`, `portal-mic`, `portal-location`, `portal-background` | the corresponding portal | `Screencast` / `ShortcutsHost` / `IndicatorHost` |
| atrium | `portal-a11y` | portal-a11y | `A11yGate` |
| atrium | `portal-inhibit` | portal-inhibit | `InhibitHost` |
| atrium | `portal-clipboard` | portal-clipboard | `ClipboardHost` |
| portal-* | `default` | apps declaring the portal in `needs.services`; bench-relay (for its tier-2 VM principal, `GuestPortals`) | the portal's interface (§7.3.15, §7.5.20) |
| portal-files | `broker` | broker | `FilePicker.pick` |
| portal-files | `drop` | atrium | `FilePicker.confirmDrop` |
| portal-mic | `capture`, `playback` | apps with a microphone grant; apps with audio output | `Microphone` |
| portal-a11y | `default` | assistive-technology principals only | `Accessibility` |
| portal-* | `ctl` | portalctl | portal-local control |
| pipewire | `portals` | portal-screen, portal-camera, portal-mic, atrium (creates screencast video nodes) | PipeWire native protocol (upstream); the portals mint restricted remotes for apps |

### A.21 `protocols §7.3.13` — `bench.capnp`

```capnp
@0xc7a1e5d3b2f40013;
using C = import "common.capnp";
using W = import "warden.capnp";
using B = import "broker.capnp";

struct Share { name @0 :Text; dir @1 :C.Fd; writable @2 :Bool; overlay @3 :Bool; }

struct VmSpec {
  image     @0 :C.Ref;              # bench-image generation
  shares    @1 :List(Share);
  vcpus     @2 :UInt16;
  memoryMiB @3 :UInt32;
  gpu       @4 :Bool;               # virtio-gpu native context
  network   @5 :List(C.Token);      # net grants; all egress via bench-net → gate
  display   @6 :Bool;               # Wayland proxy to atrium (tier-2 apps, workbench apps such as IDEs, agent-desktop mirrors)
  fromSnapshot @7 :Text;
  session       @8 :C.SessionId;    # the VM principal's session; bench generates it if empty
  parentSession @9 :C.SessionId;    # session the VM principal descends from (agent: the aide-created session chain parent)
  principalKind @10 :W.SpawnSpec.ActorKind;   # bench (default), agent, legacy, pod
  storeSet      @11 :List(C.Ref);   # generations exposed read-only in the guest store (/store) in addition to the image closure
  unsignedImageOk @12 :Bool;        #! honoured only for facet user calls by service:forge with purpose build, tier 3
  purpose       @13 :Purpose;
  displayMode   @14 :DisplayMode;   # meaningful when display = true
  gpuPassthrough @15 :Text;         # PCI address of a VFIO-claimed GPU (needs.gpu "passthrough"); empty = none
  blockDevices  @16 :List(BlockDev);   # media VMs and pod VMs: block devices claimed through devd MediaAttach
  enum Purpose { workbench @0; agent @1; app @2; media @3; build @4; captive @5; pod @6; agentDesktop @7; }
  enum DisplayMode { interactive @0; readOnly @1; }   # readOnly: human watches an agent desktop; takeOver switches to interactive
  struct BlockDev { device @0 :Text; fd @1 :C.Fd; readOnly @2 :Bool; }
  bootArgs      @17 :List(C.KeyValue);  # delivered to the guest over benchd control at boot (e.g. "captive.url" for purpose captive)
  tap           @18 :C.Fd;              #! purpose pod only (facet cri): tap device created in the cri network namespace; index 0xFFFF = none
  tapConfig     @19 :TapConfig;
  podId         @20 :Text;              # purpose pod: pod-… (§3.5); bench places the VMM processes under the pod's cgroup
  struct TapConfig { ifname @0 :Text; mac @1 :Text; mtu @2 :UInt16; }
  attempt       @21 :C.AttemptBinding;  #! facet aide only (agent attempts of a workflow, §20.25); copied to VmPrincipal.attempt
}

struct ForkSpec {
  session       @0 :C.SessionId;    # session of the forked VM principal; bench generates it if empty
  parentSession @1 :C.SessionId;    # defaults to the source VM's parentSession
  principalKind @2 :W.SpawnSpec.ActorKind;   # aide forks: agent; default: the source VM's kind
  offered       @3 :List(C.Token);    #! tokens for the fork; default: the source VM principal's tokens (sub-agents: the parent agent's)
  checks        @4 :List(Text);       #! attenuation checks for the fork (copied to VmPrincipal.checks)
  budgets       @5 :List(B.Budget);   #! sub-budgets for the fork (copied to VmPrincipal.budgets)
  attempt       @6 :C.AttemptBinding; #! facet aide only: the fork is an attempt of a workflow (§20.25); copied to VmPrincipal.attempt
}

interface Vm {
  exec     @0 (argv :List(Text), env :List(C.KeyValue), fds :List(W.FdMapping), tty :Bool) -> (process :W.Process);
  snapshot @1 (name :Text) -> (id :Text);
  fork     @2 (spec :ForkSpec) -> (vm :Vm);         #! spec null = defaults; the fork is a new VM principal registered through VmSpawn
  changes  @3 () -> (shares :List(Text));          # per-share change summaries
  commit   @4 (share :Text) -> (transaction :Text); # human workbenches only; agent overlays merge via BenchMerge (§7.5.10)
  discard  @5 () -> ();
  stop     @6 () -> ();
  console  @7 () -> (pty :C.Fd);
  attachShare @8 (share :Share) -> ();             #! hot-plug: new virtio-fs export in the running VM; the guest sees /shares/<name>
  detachShare @9 (name :Text) -> ();               #! open guest files on the share get EIO afterwards
  desktop  @10 () -> (desktop :Capability);        #! purpose agentDesktop only: returns an aide-sys AgentDesktop (§7.5.13)
  takeOver @11 (interactive :Bool) -> ();          # agentDesktop: switch the human's mirror between readOnly and interactive
  info        @12 () -> (session :C.SessionId, cgroupId :UInt64, cid :UInt32, purpose :VmSpec.Purpose);
  attachBlock @13 (dev :VmSpec.BlockDev) -> ();    #! hot-plug a virtio-blk device (pod VMs: CSI volumes published after start)
  detachBlock @14 (device :Text) -> ();
}

interface Bench {
  start     @0 (spec :VmSpec) -> (vm :Vm);
  project   @1 (projectDir :C.Fd) -> (vm :Vm);     # start/attach project workbench per project.ncl
  snapshots @2 () -> (list :List(Text));
  media     @3 (device :Text) -> (vm :Vm, browser :Capability);
      #! starts (or attaches to) the media VM for an authorized removable block device; browser is a bench-sys MediaBrowser (§7.5.10)
  reattach  @4 (session :C.SessionId) -> (vm :Vm);
      #! a new Vm capability for a running VM started by the same caller principal (cri after a crid restart, aide).
      #! VMs of purposes pod, agent and agentDesktop outlive their Vm capability until Vm.stop, the end of their parent
      #! session, or a bench restart (which stops every VM)
}
```

### A.22 `protocols §7.5.10` — `bench-sys.capnp`

```capnp
@0xc7a1e5d3b2f40029;
using C = import "common.capnp";

interface BenchMerge {             # facet merge (gate fs.merge executor, aide for manifest/render)
  manifest    @0 (session :C.SessionId, share :Text) -> (manifestJson :Text, digest :C.Digest, snapshot :Text, prepared :Text);
      #! freezes a snapshot of the share's overlay and prepares the merge through strata (TransactionExt.prepare);
      #! manifestJson is that prepared merge's keylos.fsmerge/2 (§20.12), prepared its pm-… id
  render      @1 (session :C.SessionId, share :Text, snapshot :Text) -> (diff :C.Fd);   # unified diff
  commitShare @2 (session :C.SessionId, share :Text, manifestDigest :C.Digest, mandate :Data) -> (transaction :Text, undoSnapshot :Text);
      #! commits the prepared merge whose manifest digest is manifestDigest (PreparedMerge.commit); later agent writes are never included
  commitPrepared @3 (prepared :Text, manifestDigest :C.Digest, mandate :Data, binding :C.AttemptBinding) -> (transaction :Text, undoSnapshot :Text);
      #! gate only: commits a retained prepared merge by its pm-… id, independent of the session that prepared it (a fresh attempt
      #! of the owning workflow, §20.25; strata StrataTxn.preparedFor); idempotent: a committed prepared merge returns its
      #! stored completion record (PreparedMerge.status) instead of committing again
  preparedStatus @4 (prepared :Text) -> (state :Text, transaction :Text, undoSnapshot :Text);
      #! gate, aide: the prepared merge's durable completion record (PreparedMerge.status), for reconciliation by effect id
}

interface GrantDelegate {          # served by aide (facet grant-delegate), called by bench for agent VMs
  request @0 (vmSession :C.SessionId, kind :Text, detailJson :Text, reason :Text) -> (outcomeJson :Text);
      #! outcomeJson (JCS): {"outcome": "granted" | "denied" | "pending", "token": "<base64 Biscuit>" | null,
      #!                     "approval": "a-…" | null, "reason": "…"}
}

struct MediaEntry { name @0 :Text; kind @1 :Text; size @2 :UInt64; modified @3 :C.Timestamp; }   # kind: file | dir | symlink

interface MediaBrowser {           # returned by Bench.media; held by portal-files and atrium
  list   @0 (path :Text) -> (entries :List(MediaEntry));
  open   @1 (path :Text) -> (source :C.ByteSource, size :UInt64);    #! bytes are labelled public/untrusted
  export @2 (path :Text, data :C.Fd, mandate :Data) -> ();
      #! copies data into the media VM, which writes it to the device; requires a media.export mandate bound to the
      #! SHA-256 of data (caller-executed effect, §14.2); bench writes the receipt media.export
  eject  @3 () -> ();                 # unmount in the guest, release the device, stop the VM
  exportSeekable @4 (path :Text, sizeLimit :UInt64) -> (fd :C.Fd, done :ExportCompletion);
      #! a writable, seekable memfd for applications that must seek while saving; nothing reaches the device until
      #! done.finish with a media.export mandate bound to the SHA-256 of the final contents
}

interface ExportCompletion {
  finish @0 (mandate :Data) -> ();   # seals the memfd, verifies the mandate against its digest, writes it to the device
  abort  @1 () -> ();
}

interface GuestPortals {           # served by bench-relay to a tier-2 guest over capwire-vsock (port 7004)
  notify    @0 (title :Text, body :Text, actions :List(Text)) -> (id :UInt32);
  openUri   @1 (uri :Text) -> ();
  print     @2 (document :C.ByteSource, mime :Text, optionsJson :Text) -> (jobId :Text);
  capture   @3 () -> (stream :C.ByteSource);                  # this VM's own display only, never the host session
  secret    @4 (name :Text, purpose :Text) -> (value :Data);  #! vault facet app scoped to the VM principal; the value
                                                             #! crosses into the guest, so policy MUST allow it per item
  powerbox  @5 (kind :Text, title :Text, mimeTypes :List(Text)) -> (shareName :Text);
      #! host-side picker; the chosen file or directory is hot-plugged as a share (Vm.attachShare)
}
```

### A.23 `protocols §7.5.11` — `net-sys.capnp`

```capnp
@0xc7a1e5d3b2f4002a;
using C = import "common.capnp";

struct NetEvent {
  union {
    linkChanged      @0 :Text;      # JSON Link
    timeTrusted      @1 :Bool;
    captive          @2 :Bool;
    metered          @3 :Bool;
    vpnChanged       @4 :Text;      # JSON {profile, up}
    resolverInsecure @5 :Text;      # upstream id
  }
}

interface NetWatch {               # facets user, status, resolver, captive
  watch @0 (watcher :C.Watcher(NetEvent)) -> (cancel :C.Cancelable);
}

interface NetResolver {            # facet resolver (gate, tier-0 services)
  query @0 (wire :Data) -> (wire :Data, secure :Bool);   # RFC 1035 wire format, one question
}

struct ListenPort {
  port  @0 :UInt16;
  proto @1 :Proto;
  scope @2 :Scope;
  enum Proto { tcp @0; udp @1; }
  enum Scope { loopback @0; lan @1; any @2; }
}

interface NetPlumbing {            # facet plumbing
  setEgressUids    @0 (uids :List(UInt32)) -> ();                         # warden: UIDs allowed host-netns egress (gate, net helpers)
  setListenPorts   @1 (tcp :List(UInt16), udp :List(UInt16), ports :List(ListenPort)) -> ();
      #! gate: subset of config listenPorts; when ports is non-empty it supersedes tcp/udp (which then MUST be empty)
      #! and carries each port's scope (needs.listen scope, §6.3)
  setLocalLinkUids @2 (uids :List(UInt32)) -> ();                         # warden: UIDs allowed mDNS/IPP on local links (portal-print)
}

interface NetCaptive {             # facet captive (atrium)
  status @0 () -> (captive :Bool, ssid :Text, portalUrl :Text);
  admit  @1 (vmUid :UInt32) -> ();  #! superseded before release: MUST return kl:unsupported
  admitSession @2 (vmSession :C.SessionId) -> (expires :C.Timestamp);   #! superseded before release: MUST return kl:unsupported; use signIn
  portalUrl    @3 () -> (url :Text);  # the detected portal URL
  signIn       @4 () -> (expires :C.Timestamp);
      #! atrium ("Sign in to network"): net starts the captive VM itself through bench#net (purpose captive, image
      #! io.keylos.bench.captive-browser, display true, bootArgs captive.url), reads its session and cgroup with Vm.info,
      #! mints the captive token (BrokerSystem.mintCaptive), which the broker attaches to the VM session (bench-net reads it
      #! with Broker.myGrants), and allows that VM's bench-net direct egress on tcp/80, tcp/443 and udp+tcp/53 for at most
      #! 600 s while the network is captive. The window appears through atrium's Display like any tier-3 VM
  endSignIn    @5 () -> ();
      #! atrium (sign-in window closed): net stops the captive VM (Vm.stop) and revokes its direct egress immediately
}

interface NetPlumbingCluster {     # facet plumbing (clusterUplink: cri; clusterNetns: warden)
  clusterUplink @0 (configJson :Text) -> (netns :C.Fd);
      #! configJson is keylos.cri.uplink/1 (§21.5): op "uplink" configures the cri network namespace (pod CIDR routes,
      #! NAT, overlay) and returns it; op "podNetns" creates a pod network namespace attached to the cri bridge and
      #! returns it; op "release" deletes a pod namespace. cri holds CAP_NET_ADMIN only inside the cri namespace
  clusterNetns  @1 () -> (netns :C.Fd);
      #! warden: the cri network namespace, created by net at its own start on server-k8s from config cluster.*;
      #! warden starts services with services.json network "cluster" (crid, kubelet, kube-proxy) inside it
}

interface NetDiscovery {           # facet discovery (portal-discovery)
  browse  @0 (serviceType :Text, onLink :Text, watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);   # JSON ServiceInstance
  publish @1 (instance :Text, serviceType :Text, port :UInt16, txtJson :Text, forUid :UInt32) -> (handle :C.Cancelable);
}
```

### A.24 `protocols §7.5.8` — `devd-sys.capnp`

```capnp
@0xc7a1e5d3b2f40027;
using C = import "common.capnp";

struct NodePlan {
  id @0 :Text; name @1 :Text; kind @2 :Kind; major @3 :UInt32; minor @4 :UInt32;
  enum Kind { char @0; block @1; }
}

struct PendingDevice {
  device    @0 :Text;              # dev:… id
  bus       @1 :Text;              # "usb" | "thunderbolt" | "pci"
  vendor    @2 :UInt16;
  product   @3 :UInt16;
  serial    @4 :Text;
  port      @5 :Text;              # physical port path
  classes   @6 :List(Text);        # interface classes, e.g. "hid", "mass-storage", "audio", "fido", "net"
  name      @7 :Text;              # descriptor strings, untrusted (rendered as untrusted text)
  hidSafety @8 :Text;              # "none" | "keyboard-like" (requires confirmation with an already-authorized input device)
}

interface DeviceAdmin {            # facets warden, broker (plan, revoke); authorize (atrium: authorize, deauthorize, pending)
  plan   @0 (principal :C.PrincipalId, tokens :List(C.Token)) -> (nodes :List(NodePlan));
  revoke @1 (rootId :Data) -> ();
  authorize   @2 (device :Text, persist :Bool, decisionEnvelope :Data) -> ();
      #! sets the kernel authorized flag (USB) or approves the Thunderbolt/USB4 domain; decisionEnvelope is the mandate
      #! atrium obtained through BrokerSystem.requestFor (resource device, §14.4): devd verifies only the service/broker
      #! or owner-presence signature and the device id; persist stores the identity (vendor, product, serial, port)
  deauthorize @3 (device :Text, forget :Bool) -> ();
  pending     @4 (watcher :C.Watcher(PendingDevice)) -> (cancel :C.Cancelable);
}

interface MediaAttach {            # facets bench, cri
  claimBlock @0 (device :Text, readOnly :Bool) -> (fd :C.Fd, info :Text);
      #! fd of the whole authorized removable block device for a media or pod VM; the host never mounts it (§9.5);
      #! info = JSON {sizeBytes, model, removable, partitions}
  claimVfio  @1 (pciAddress :Text) -> (groupFd :C.Fd, deviceFd :C.Fd);
      #! binds the device to vfio-pci (it must be listed for passthrough in config); the host driver is unbound
  release    @2 (device :Text) -> ();
}

struct PowerEvent { union { preSleep @0 :Text; postResume @1 :Text; battery @2 :Text; sensor @3 :Text; lid @4 :Bool; } }

interface PowerEvents {            # facet client (events), service (subscribe + ack: hearth, strata, atrium)
  subscribe @0 (watcher :C.Watcher(PowerEvent)) -> (cancel :C.Cancelable);
  ack       @1 (op :Text) -> ();
}

struct BtDevice { address @0 :Text; name @1 :Text; paired @2 :Bool; connected @3 :Bool; kind @4 :Text; battery @5 :Int8; }

interface Bluetooth {              # facet admin
  power      @0 (on :Bool) -> ();
  scan       @1 (watcher :C.Watcher(BtDevice)) -> (cancel :C.Cancelable);
  pair       @2 (address :Text) -> ();             # confirmation on the trusted path
  connect    @3 (address :Text) -> ();
  disconnect @4 (address :Text) -> ();
  forget     @5 (address :Text) -> ();
  devices    @6 () -> (list :List(BtDevice));
}

interface Backlight {              # facet atrium
  list @0 () -> (devices :List(Text));
  set  @1 (device :Text, permille :UInt16) -> ();
  get  @2 (device :Text) -> (permille :UInt16);
}
```

### A.25 `protocols §9.5` — Devices, removable media and DMA

- **USB authorization.** `devd` sets `authorized_default=0` on every USB host controller. A newly attached device stays unauthorized (no driver binds) until approved on the trusted path and authorized through `DeviceAdmin.authorize` (§7.5.8). Approvals are stored per device identity (vendor, product, serial, port) when the human ticks "remember".
  - Input devices present during installation are pre-authorized.
  - A new device exposing a HID keyboard-like interface (`hidSafety: "keyboard-like"`) can only be approved using an **already-authorized** input device; its own keystrokes are discarded until then (BadUSB keystroke-injection defence).
  - Policy MAY auto-authorize device classes (`devices.autoAuthorize`, e.g. `["audio", "fido"]`); class `hid`, `net` and `mass-storage` are never auto-authorized by default.
  - **Before `devd` runs.** The kernel command line sets `usbcore.authorized_default=2` (only devices on internal, hard-wired ports are authorized). The initrd's authorizer (`boot`) additionally authorizes external hubs and devices whose interfaces are **all** HID, so external keyboards work for VBU, the PIN and the recovery prompt; it never authorizes storage, network or composite devices with a non-HID interface. In the initrd, keystrokes reach only those prompts (the TPM dictionary-attack lockout bounds PIN guessing). After `switch_root`, `devd` re-evaluates every authorized external device: a device that is neither remembered nor listed in `/var/lib/keylos/devd/preauthorized.json` is deauthorized and becomes pending. The remaining window is residual risk R15 of the distribution.
  - `/var/lib/keylos/devd/preauthorized.json` (written by the installer: the input devices present at installation; read by `devd`): `{"schema":"keylos.preauth/1","devices":[{"vendor":"046d","product":"c52b","serial":"…","port":"usb1-2","classes":["hid"]}]}` (vendor/product as 4 lowercase hex digits; `serial` empty when the device has none).
- **Thunderbolt / USB4 / external PCIe.** The IOMMU is required (§2). Domains and devices are authorized by `devd` only after trusted-path approval; without an IOMMU they are never authorized. Pre-boot DMA protection relies on firmware; the boot report records whether the firmware declared it.
- **Removable storage is never mounted by host filesystem drivers.** Authorizing a mass-storage, SD, optical or MTP device makes its block device (or MTP endpoint) available only through `MediaAttach.claimBlock` to a **media VM** (`VmSpec.purpose = media`, image `io.keylos.bench.media`), started by `Bench.media`. The VM mounts the filesystem and serves files through `MediaBrowser` (§7.5.10).
  - Bytes read through `MediaBrowser.open` are labelled `public/untrusted`; `portal-files` shows the device as the location "USB: <label>".
  - Writing to the device is the effect `media.export` (§14.2): data is copied into the media VM, which writes it.
  - Exception: a disk whose LUKS2 header carries the keylos backup token (`keylos-backup`) and verifies against the machine's backup key is unlocked and mounted on the host by `strata` for backups only.
- **Fingerprint readers** may unlock the screen lock only. They never satisfy presence and never unlock the disk.
- **VFIO passthrough** (`needs.gpu: "passthrough"`, pod VMs): only devices listed in config `devices.passthrough` are bound to `vfio-pci` through `MediaAttach.claimVfio`; the host driver is unbound for the VM's lifetime.

### A.26 `protocols §14.2` — Effect kinds

Registered kinds, with their default class:

| Kind | Class |
|---|---|
| `fs.merge` | compensable (undo snapshot; compensator `fs.undo`) |
| `git.push` | compensable for new branches; irreversible for force pushes, pushes to protected branches and any other push to an existing branch |
| `git.pr.open` | compensable |
| `email.send` | irreversible |
| `message.send` (chat) | irreversible |
| `http.post`, `http.put`, `http.patch` | irreversible unless the host policy registers a compensator |
| `http.delete` | irreversible |
| `payment.authorize` | irreversible (requires an AP2-style mandate in `data`) |
| `publish.package` | irreversible |
| `cloud.iam.change` | irreversible |
| `db.write.prod` | irreversible |
| `calendar.create` | compensable |
| `file.share` | compensable |
| `device.actuate` | irreversible |
| `net.listen` | compensable (close the port). Required for any port reachable from non-loopback addresses (scope `lan`/`any`); loopback-only listening needs no effect |
| `media.export` | compensable (delete the file on the device); counts as egress (property X) for the Rule of Two |
| `config.propose` | reversible (a proposal only; applying it is `config.apply`) |

Policy can register additional kinds (`x-…`), each optionally with an effect renderer component (§20.15). Classes can be raised, never lowered.

**Mandate-only kinds.** The broker records decisions that are not intents with these kinds in mandate `effects[]` (§14.4): `grant.<k>` for every resource kind *k* of §8.2 (`grant.path`, `grant.net`, `grant.device`, `grant.secret`, `grant.budget`, `grant.spawn`, `grant.service`, `grant.effect`, `grant.delegate`, `grant.principal`, `grant.screen`, `grant.model`), `grant.declassify`, `debug.attach`, `pod.admit`, and for durable workflows (§20.25) `workflow.enroll` (target `wf-…`, digest = SHA-256 of the JCS `EnrollRequest` JSON form `{"workflow", "definition": {"generation": <gen ref text>, "name", "digest": <digest text>}, "inputDigest": <digest text>, "scope": [<GrantRequest JSON forms>], "budgets": [{"unit", "amount"}], "resume": "manual" | "automatic", "runWhileLocked", "horizonSecs", "reason", "account"}`), `workflow.resume` (target `wf-…`) and `workflow.decide` (target the `ws-…` or `fx-…` the decision is about, digest = SHA-256 of the JCS question or resolution document). They are valid only in mandates, written only by `broker`, and never appear in manifests, command signatures, intents or `gate` intents.

**Required review details.** Approval of an effect requires that the trusted path presents at least these details of the exact payload (§7.3.4); a policy-registered kind's renderer declares its own, and a kind without a declaration requires the complete canonical payload:

| Kind | Required details |
|---|---|
| `email.send`, `message.send` | every recipient (to, cc, bcc), subject, complete body, attachment names, types and sizes |
| `http.*` | method, complete URL, request body (or its digest plus a complete canonical rendering for bodies over the channel limit) |
| `payment.authorize` | amount, currency, payee, mandate terms |
| `fs.merge` | the complete `keylos.fsmerge/2` manifest and the diff of every changed text file; binary changes by path, size and digest |
| `git.push`, `git.pr.open` | remote, refs (old → new), commits with titles; force flag |
| `publish.package`, `cloud.iam.change`, `db.write.prod`, `device.actuate` | target and the complete operation |
| `file.share`, `calendar.create`, `media.export`, `net.listen` | target (people, device or port and scope) and the object |
| `config.propose`, `config.apply` | the complete plan diff |
| `grant.*`, `debug.attach`, `pod.admit`, `grant.declassify` | resource, rights, duration, persistence, requesting principal and `onBehalfOf` |
| `workflow.enroll` | definition (name, version, generation, digest), every scope item as for `grant.*`, budget ceilings, resume policy (`automatic` stated as "runs again after restarts without asking"), `runWhileLocked`, horizon, the owner and the label the workflow starts with |
| `workflow.resume`, `workflow.decide` | workflow, definition, current step, the complete question or resolution document, and for `workflow.decide` on an effect the effect's own required details |

**Caller-executed effects.** For `media.export`, `device.actuate` and `config.propose`, `gate` stages, renders and decides the intent but does not perform it. A successful `Intent.commit` returns, in `IntentStatus.result`, the base64 delivered mandate (§14.4) bound to the payload digest, and `gate` writes `effect.commit` meaning "authorized". The executor (`bench` `MediaBrowser.export`/`ExportCompletion.finish`, the device's owning service, `config` for `propose`) MUST verify the mandate (owner-presence or `service/broker` signature, payload digest, expiry, single use) before acting, and writes its own completion receipt (`media.export` by `bench`). Stagers of `media.export` are `portal-files` and `atrium` on behalf of the requesting app. **Authorization is not completion**: an intent in `committed` state of a caller-executed kind, and an effect in `authorized` state (§20.26), say only that the effect may be performed; a workflow waits for the executor's authenticated completion (its receipt, `DurableEffects.complete`) before it treats the effect as done.

### A.27 `protocols §14.5` — Operating rules

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.

### A.28 `protocols §7.3.8` — `depot.capnp`

```capnp
@0xc7a1e5d3b2f40008;
using C = import "common.capnp";

struct GenerationInfo {
  ref       @0 :C.Ref;
  kind      @1 :Text;
  name      @2 :Text;
  version   @3 :Text;
  manifest  @4 :Data;         # manifest JSON bytes
  launchable @5 :Bool;
  sealedBy  @6 :List(Text);   # key refs whose signatures over the generation statement verified
  grafted   @7 :Bool;
  revoked   @8 :Bool;
  installed @9 :C.Timestamp;
  launchReasons @10 :List(Text);   # why launchable is false: "no-authorising-signature", "revoked:<reason>", "needs-consent",
                                   # "quorum-deferred", "unreviewed-tier2", "offline-install-needs-t3", "kernel-mismatch" (kmod)
}

interface Depot {
  get        @0 (ref :C.Ref) -> (info :GenerationInfo);
  list       @1 (kind :Text, name :Text) -> (list :List(GenerationInfo));
  install    @2 (source :Text) -> (info :GenerationInfo, capabilityDiff :Text);  # "oci://…[#gen=fsv256:…]", "tuf:<stream>/<name>", ".klb" bundle fd path via powerbox
  mount      @3 (ref :C.Ref) -> (tree :C.Fd);          #! facet mounter (warden, bench, compat) and config (kind config only); fsmount fd (composefs, verity=require)
  openObject @4 (ref :C.Ref) -> (fd :C.Fd);            # read-only fd of store object
  importTree @5 (tree :C.Fd, manifest :Data) -> (info :GenerationInfo);   # facets forge (all kinds), config (config, policy), compat (legacy-image)
  seal       @6 (ref :C.Ref, statement :Data) -> (info :GenerationInfo);  # attach owner seal (DSSE seal statement signed via HearthSeal)
  root       @7 (ref :C.Ref, holder :Text) -> ();      # GC root
  unroot     @8 (ref :C.Ref, holder :Text) -> ();
  gc         @9 (dryRun :Bool) -> (freedBytes :UInt64, removed :List(C.Ref));
  verify     @10 (ref :C.Ref) -> (ok :Bool, problems :List(Text));
  revocations @11 () -> (listEnvelope :Data);
  openPath   @12 (ref :C.Ref, path :Text) -> (fd :C.Fd);
      #! read-only fd of a regular file inside a generation, resolved in the generation's own tree (no symlink escape).
      #! facet user: only paths under /.keylos/ (manifest.json, cmdsig/*, l10n/*, agent/*, icons/*, sbom.spdx.json,
      #! provenance.json, workflows/*) of generations the caller may spawn, agent templates, or catalog entries; facet mounter: any path;
      #! facet loom: /.keylos/manifest.json and /.keylos/workflows/* of any installed generation
  revocationStatus @13 () -> (serial :UInt64, issued :C.Timestamp, ageSecs :UInt64);
      #! facets user, mounter, compat: the newest verified revocation list; ageSecs measured against trusted time (§3.6, §14.5)
}
```

**GC roots** are named `<holder>:<purpose>:<id>`. Registered holder prefixes: `loom:workflow:<wf-id>` (the pinned definition generation of every workflow that is not yet terminal, and of a terminal one until it is forgotten; §20.25), `warden:running:<session>` (every generation `warden` mounted; `warden` calls `unroot` when the last principal using that mount exits, so `depot` needs no unmount notification), `cri:pod:<pod-id>` (container generations and images of a pod), `courier:os:<seq>` (bootable OS generations), `courier:kmod:<kernel-release>` (kmod generations for an installed kernel). Other prefixes are repo-local.

**Container mounts.** `mount` of a `container` generation succeeds only while it is rooted by a `cri:pod:<pod-id>` holder; `cri` roots it before calling `PodSpawn` (§21.4).

`install("tuf:<stream>/<name>")` and `install("tuf:org:<org>/<name>")` are resolved through `CourierResolver.resolve` (§7.5.6), which also returns the catalog review status; `depot` is never a TUF client. Revocation lists reach `depot` the same way: `courier` resolves `tuf:<stream>/revocations` and `depot` takes the DSSE list from `Resolution.revocations` (§7.5.6). Source form `oci+container://<registry>/<repo>@sha256:<manifest>` (facet `cri` only) converts an OCI image into a `container` generation (§21.4). `courier` installs OS generations with the source form `oci://<registry>/<repo>@sha256:<manifest>#gen=fsv256:<hex>`, which `depot` MUST accept (the fragment pins the expected generation digest).

### A.29 `protocols §7.3.7` — `gate.capnp`

```capnp
@0xc7a1e5d3b2f40007;
using C = import "common.capnp";
using B = import "broker.capnp";

enum EffectClass { reversible @0; compensable @1; irreversible @2; }

struct EffectArg { name @0 :Text; value @1 :Text; source @2 :Text; label @3 :C.Label; }

struct EffectIntent {
  kind        @0 :Text;            # registered effect kind, protocols §14.2
  class       @1 :EffectClass;
  target      @2 :Text;            # e.g. "smtp:mail.example.com", "https://api.github.com/repos/o/r/pulls"
  args        @3 :List(EffectArg);
  idempotencyKey @4 :Text;
  compensator @5 :Text;            # registered compensator kind, empty if none
  payload     @6 :C.Fd;            # full request body / message
}

struct IntentStatus {
  id     @0 :Text;
  state  @1 :State;
  result @2 :Text;
  receipt @3 :Text;                # rcpt ref
  enum State { staged @0; approved @1; committed @2; failed @3; canceled @4; compensated @5; }
}

interface Intent {
  status   @0 () -> (status :IntentStatus);
  dryRun   @1 () -> (rendered :List(Text));
  commit   @2 () -> (status :IntentStatus);          # may throw kl:needs-approval
  cancel   @3 () -> ();
  compensate @4 () -> (status :IntentStatus);
}

interface Gate {
  connect   @0 (target :B.NetTarget, token :C.Token) -> (socket :C.Fd);   # proxied, policy-checked stream; target.host "listen:<addr>" returns a listening socket
  stage     @1 (intent :EffectIntent) -> (intent :Intent);
  intents   @2 (session :C.SessionId) -> (list :List(IntentStatus));
      #! facet client: the named session MUST be the caller's own session or a descendant; returns intents of that session
      #! and all its descendant sessions, recursively
  meter     @3 (rootId :Data) -> (spent :List(B.Budget), remaining :List(B.Budget));
  charge    @4 (rootId :Data, amount :B.Budget, reason :Text) -> ();      # facet meter only
  intent    @5 (id :Text) -> (intent :Intent);
      #! facet client: only intents staged by the caller's session or its descendants (kish `effects` commit/cancel)
}
```

**Terminated HTTP mode.** For `https` grants that need method filtering or credential injection, a native client does not get an end-to-end TLS stream: `connect` returns a socket on which the client speaks **plain HTTP/1.1** to `gate`, which terminates the request, applies method checks and credential injection, and performs TLS to the real host itself. Clients detect this from the token's `net` fact (`$method` ≠ `"*"`). Legacy and VM clients use the TLS-interception path instead (§9.4). SDKs MUST support the terminated mode.

**Acting for a subject.** On facet `aide`, `stage` acts for the agent session whose token is carried in the intent arg `x-subject-token` (base64 Biscuit); `gate` stages for that token's `principal` after verifying `right("effect", kind, "stage")`. On facet `broker`, `connect` acts for the token's `principal`. On every other facet the subject is the caller.
