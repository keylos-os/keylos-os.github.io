# keylos/atrium — compositor, desktop shell and trusted path

| | |
|---|---|
| Repository | `github.com/keylos-os/atrium` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `atrium` (Wayland compositor + trusted-path UI, tier-0 service `atrium`); `atrium-term` (trusted terminal); `atrium-panel`, `atrium-launcher`, `atrium-settings` (trusted shell clients); `atrium-a11y-bridge` (per-app accessibility bridge); `atrium-decode` (sandboxed image/document decoder for prompts); `atrium-ctl` (CLI); generations `io.keylos.atrium`, `io.keylos.atrium.shell`, `io.keylos.atrium.term` |
| Depends on | `keylos-protocols 1.0.0 (final)` crates; runtime services `warden`, `broker`, `hearth`, `devd`, `depot`, `config`, `courier`, `aide`, `ledger` (reader), `vouch` (optional phone approvals), `portals` (consumer of screencast, shortcuts and indicators); external components Smithay, libinput, libxkbcommon, Mesa (GBM/EGL), PipeWire |
| Provides | The display server for every GUI principal; `TrustedPrompt` (`protocols §7.3.4`); the system interfaces `Display`, `A11yHost`/`A11yObserver`/`A11yGate`, `Screencast`, `ShortcutsHost`, `IndicatorHost`, `ClipboardHost` and `InhibitHost` (`protocols §7.5.16`–`§7.5.18`); the trusted terminal; greeter, guest sessions, kiosk mode and lock screen; the keystrip with the integrity-profile indicator; approvals centre and security centre; the device authorization UI; removable-media locations; agent-desktop mirrors; the accessibility aggregator |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

atrium is the only display server in keylos and the owner of the **trusted path**: the screen region, input path and prompts that no application can draw over, imitate or read. Every approval (T2/T3), every owner-presence request, login, lock, sealing and config apply is shown by atrium. Its job is to make a human decision mean what the human saw.

### 1.1 In scope

- A Wayland compositor built on Smithay: DRM/KMS output, libinput input, GLES rendering, multi-GPU, multi-monitor, HiDPI and fractional scaling.
- Client admission by principal, with a per-tier protocol allowlist.
- Server-side identity frames with tier colours, and the keystrip (always-on trusted status bar).
- The secure attention key (SAK) and the secure overview.
- `TrustedPrompt` (approve, presence, notify) with rendering of effects, diffs and provenance.
- Greeter, lock screen, user switching.
- Desktop shell: panel, launcher, notification centre, approvals centre, agents panel, security centre, settings.
- The trusted terminal `atrium-term`.
- Integration of tier-2 VM windows and per-app Xwayland for the legacy tier.
- Screencast sources for `portal-screen`.
- The clipboard and drag-and-drop with labels.
- The accessibility aggregator, magnifier and on-screen keyboard, and the `A11yGate` that hands observers to `portal-a11y`.
- Idle and logout inhibition (`InhibitHost`) and clipboard source labels for `portal-clipboard` (`ClipboardHost`).
- The trusted UI for USB, Thunderbolt and USB4 device authorization (`protocols §9.5`), and removable-media locations backed by media VMs.
- Read-only mirrors of agent desktops, with take-over (`protocols §14.5`), and the disposable network sign-in (captive portal) window.
- Guest sessions, the kiosk profile, and family-machine approvals that name the requesting non-owner (`protocols §14.3`).
- The integrity-profile indicator (`protocols §2.2`).

### 1.2 Non-goals

- An X11 server. X11 clients run under per-app rootless Xwayland started by `compat` (§4.13).
- A widget toolkit for applications. Apps use GTK, Qt, Iced, SDL and so on, unchanged.
- Remote desktop servers. A remote-desktop portal may build on the screencast and input-capture paths in a later protocols version. atrium 1.0 exposes no remote input injection.
- Window rules or scripting in arbitrary code. Configuration is Nickel data.

---

## 2. Context and embedded contracts

### 2.1 Where atrium sits

```
devd ──(DRM, input, hidraw fds via broker grants)──► atrium (tier-0 service, DRM master for the seat)
                                                    │
     warden ──Display.clientSocket(principal)──────►│◄── Wayland clients: t1 apps, t2 VM proxies (bench), legacy Xwayland (compat),
                                                    │    trusted shell clients (atrium-panel/-launcher/-settings/-term)
broker, hearth, config, depot, courier ──────────► TrustedPrompt (prompt.capnp)
portals (portal-screen) ──Screencast──────────────► PipeWire video nodes
assistive principals ──Accessibility portal──────► A11y aggregator ◄── atrium-a11y-bridge (one per GUI app)
portal-a11y / portal-clipboard / portal-inhibit ─► A11yGate / ClipboardHost / InhibitHost
devd ──DeviceAdmin.pending──► device authorization cards ──DeviceAdmin.authorize──► devd
bench ──Bench.media / MediaBrowser, agent-desktop and captive VM windows──► atrium
```

### 2.2 Embedded contracts

Every contract below is copied verbatim into Appendix A by mechanical extraction from keylos-protocols 1.0.0 (final).

| Contract | Use | Appendix |
|---|---|---|
| `protocols §3.4` principals | Admission, frames, prompts | A.1 |
| `protocols §5.3` presence signatures | What `Hearth.presence` returns for presence prompts | A.2 |
| `protocols §6.3` manifest | Display names, `l10n`, entrypoint kinds for the launcher | A.3 |
| `protocols §7.1`, `§7.2` capwire, routes and facets | Service connections | A.4, A.5 |
| `common.capnp` + errors | Everywhere | A.6 |
| `warden.capnp` | `identify`, `connectionInfo`, `Supervisor.spawn` of `atrium-decode` | A.7 |
| `broker.capnp` | `Approval`, `label`, `myGrants`, `revoke`, `powerbox` (security centre, `atrium-ctl`) | A.8 |
| `prompt.capnp` | **Implemented** by atrium | A.9 |
| `ledger.capnp` | Approvals history and receipts in the security centre (facet `reader`) | A.10 |
| `depot.capnp` | Launcher (installed app generations, facet `user`) | A.11 |
| `courier.capnp` | Integrity and update status (facet `client`) | A.12 |
| `config.capnp` | Settings proposals (facets `owner`, `user`) | A.13 |
| `hearth.capnp` | `users`, `login` (methods `password`, `pin`, `fido2`, `guest`, `kiosk`), `lock`, `unlock` (facet `greeter`), `presence` with `assist` (facet `atrium`) | A.14 |
| `aide.capnp` | Agents panel (facet `user`) | A.15 |
| `devd.capnp`, `portals.capnp` | Device enumeration and hotplug; `Accessibility` | A.16 |
| `warden-sys.capnp` | `UserSpawn` (session components, launcher), `TrustedSpawn` (atrium-term), `PrincipalControl` (kill focused app, logout) | A.17 |
| `broker-sys.capnp` | `BrokerSystem.registerApprover`, `LabelAuthority` (clipboard, drag-and-drop, terminal banner) | A.18 |
| `devd-sys.capnp` | `PowerEvents` (lock on suspend and lid close), `Backlight`, `DeviceAdmin.authorize` (with the broker-delivered mandate)/`deauthorize`/`pending` (facet `authorize`) | A.19 |
| `display.capnp`, `a11y.capnp` (incl. `A11yGate`), `screencast.capnp` (incl. `ClipboardHost`, `InhibitHost`) | **Implemented** by atrium | A.20–A.22 |
| `picker.capnp` | `FilePicker.confirmDrop` for file drag-and-drop | A.23 |
| `vouch-sys.capnp` | `VouchLink.routeApproval` (optional phone approvals) | A.24 |
| `protocols §9.3` | Trusted terminal rule for interactive interpreters | A.25 |
| `protocols §10.1` | `/run/user/<uid>/` contents of app views | A.26 |
| `protocols §14.1`, `§14.3`, `§14.4` | Labels, approval tiers, mandates | A.27–A.29 |
| `protocols §19.2` | The facets atrium serves and holds | A.30 |
| `protocols §20.2` | Presence purposes | A.31 |
| `protocols §2.2` | Profiles and integrity profiles (keystrip indicator, kiosk) | A.32 |
| `bench.capnp` | `Bench.media` (media locations), `Bench.start` with purpose `app` (launcher: non-reproducible native apps) | A.33 |
| `bench-sys.capnp` | `MediaBrowser.eject` and mandated `export` for media locations | A.34 |
| `aide-sys.capnp` | `AgentDesktop` semantics of mirrored agent desktops | A.35 |
| `protocols §9.5` | USB/Thunderbolt authorization and removable media | A.36 |
| `protocols §14.5` | Agent desktops, `screen.window.snapshot` | A.37 |
| `net-sys.capnp` | `NetWatch` captive-portal events, `NetCaptive.status`, `signIn` (route `net#captive`) | A.38 |
| `protocols §10.7` | `/run/keylos/boot/report.json` (integrity profile) is a registered cross-repo file | A.39 |
| `gate.capnp` | `Gate.stage`, `Intent.commit` for `media.export` (REQ-ATRIUM-095) | A.40 |
| `protocols §14.2` | Effect kinds; caller-executed `media.export` | A.41 |

---

## 3. Requirements

### 3.1 Admission and isolation

- **REQ-ATRIUM-001** atrium MUST accept a Wayland connection only on a socket it created for a specific principal (§4.3). On accept, it MUST resolve the peer with `SO_PEERPIDFD` and `Supervisor.identify` (valid here because the client itself `connect()`s to atrium's listening socket; protocols §7.1 forbids this only for warden-created socketpairs), and close the connection if the result differs from the socket's principal (the same principal with a descendant session chain is allowed).
- **REQ-ATRIUM-002** Every connection MUST be classified as one of `trusted`, `t1`, `t2`, `legacy-x`, `assistive`, `ime`, and MUST be offered only the globals allowed for that class (§4.4). Hidden globals MUST NOT be advertised at all.
- **REQ-ATRIUM-003** Clients MUST NOT be able to read pixels of other clients, the keystrip, prompts, the lock screen or the greeter, except through the `portal-screen` screencast path after user selection in trusted UI.
- **REQ-ATRIUM-004** Clients MUST NOT receive input events unless their surface has keyboard focus or pointer focus, and never while a trusted surface holds the input grab.
- **REQ-ATRIUM-005** Clients MUST NOT synthesise input for other clients. No virtual-keyboard or virtual-pointer protocol is available to any class except `ime` (virtual keyboard only, delivering to the focused surface) and atrium's own on-screen keyboard.

### 3.2 Trusted path

- **REQ-ATRIUM-010** atrium MUST draw the keystrip on every output at all times, outside the area any client surface can occupy, including fullscreen surfaces (§4.6.1).
- **REQ-ATRIUM-011** The secure attention key (`Ctrl+Alt+Delete` on a physical keyboard, and the power-button short press on tablets) MUST always reach atrium. No protocol (including keyboard-shortcuts-inhibit) can inhibit it, and it MUST never be delivered to clients.
- **REQ-ATRIUM-012** Trusted surfaces (keystrip, prompts, greeter, lock, secure overview, approvals centre, security centre) MUST be rendered by the atrium process itself, never by a client.
- **REQ-ATRIUM-013** Every trusted prompt MUST show the user's **security phrase and image** (chosen in a trusted surface at first login and held by atrium, §4.6.3), the requesting principal's identity derived from verified data (generation name, publisher, tier and session), and the effect renderings supplied by the requesting service.
- **REQ-ATRIUM-014** While a prompt is shown, all other surfaces MUST be dimmed and receive no input. Approve controls MUST stay disabled for 750 ms after the prompt appears and after any change of prompt content, and MUST require a fresh key press or pointer press that started after enabling.
- **REQ-ATRIUM-015** Prompts with `requiresPresence` MUST obtain the presence envelope through `Hearth.presence` (route `hearth#atrium`, purpose `mandate`) and MUST return it unmodified in `Decision.mandate`.
- **REQ-ATRIUM-016** atrium MUST NOT approve on behalf of the user. Prompts expire at `ApprovalPrompt.expires` with `approved = false`, and on lock, user switch or SAK.
- **REQ-ATRIUM-017** Mandates for approvals without presence MUST be signed with atrium's **approver key**: an Ed25519 key generated in memory at each atrium start and registered once per boot with `BrokerSystem.registerApprover` (`protocols §14.4`). The key MUST NOT be written to disk. If atrium restarts, it generates and registers a new key.
- **REQ-ATRIUM-018** A prompt MAY be routed to a paired phone (`VouchLink.routeApproval`) only when `ApprovalPrompt.channels` contains `"phone"`, the prompt does not require presence, and the seat is locked or idle (§4.7.3). An empty `channels` list means `["local"]`. atrium MUST NOT route any other prompt off the machine, and MUST NOT act on the `"org"` channel (the broker routes org approvals itself).
- **REQ-ATRIUM-019** When `ApprovalPrompt.requester` is non-empty (family machines, `protocols §14.3`), the prompt MUST be shown only in an owner's session and MUST name the requesting non-owner human in the header, separately from the requesting principal.
- **REQ-ATRIUM-019a** `TrustedPrompt.presence` MUST render every `RenderedEffect` of its `rendering` argument on the presence card, together with the SHA-256 digest (first 16 hex characters) of each effect's `body` and of the payload, so that a CLI showing the same digests can be cross-checked (§4.7.4).
- **REQ-ATRIUM-019b** **Fail closed on required review material** (`protocols §14.3`, E33). Approve (and "Approve and touch key", and the presence card's confirm action) MUST be enabled only when every `RenderedEffect` with `review = required` was presented completely: its body (and attachment, when present) decoded and laid out without error, truncation or omission, and its `payloadDigest` equal to the digest of an effect in `mandateDraft` (approval prompts) or to SHA-256 of the payload's PAE-covered statement it renders (presence cards). Every effect in `mandateDraft` MUST have at least one required rendering bound to its digest. A `title`, a summary or a digest alone MUST NOT satisfy a required rendering. Renderings with `review = decorative` MAY fail without blocking Approve; atrium treats a `decorative` mark as valid only on prompts from `broker` (which carries gate's renderings) and treats it as `required` on every other caller's renderings.
- **REQ-ATRIUM-019c** When a required rendering cannot be presented (decoder crash or timeout, unsupported MIME type, missing or unreadable attachment, malformed content, body beyond the paging limits), atrium MUST try the **canonical-text fallback**: if the same prompt carries a `text/plain` rendering with `review = required` and the same `payloadDigest` (gate's canonical text renderer, gate spec), it is shown instead; otherwise Approve stays disabled, the card says "The details of this request cannot be shown, so it cannot be approved here", and only Deny and **Defer** (leave the request pending; it returns to the queue and may be completed on a capable channel or expire) are offered.

### 3.3 Identity frames

- **REQ-ATRIUM-020** Every toplevel of a non-trusted client MUST have a compositor-drawn identity frame showing the tier colour, the generation display name from the verified manifest, and the label badge. Client-provided titles appear only as secondary text.
- **REQ-ATRIUM-021** The `xdg-decoration` mode MUST be forced to server-side for the identity frame. Client-side decorations inside the frame are allowed.

### 3.4 Session

- **REQ-ATRIUM-030** The greeter and lock screen MUST authenticate only through `Hearth.login` and `Hearth.unlock`.
- **REQ-ATRIUM-031** On lock, atrium MUST call `Hearth.lock`, stop all screencasts, blank outputs to the lock surface, and deny all pending prompts.
- **REQ-ATRIUM-032** On user switch, the previous user's clients MUST receive no input or frame callbacks, and their surfaces MUST NOT be composited, until that user unlocks.
- **REQ-ATRIUM-033** If atrium restarts, the seat MUST come up locked (greeter or lock screen); it MUST fail closed.
- **REQ-ATRIUM-034** **Safe start** (`protocols §9`, E35: reboot restores verified code and owner-approved configuration; writable state may still contain hostile data and may require quarantine or recovery). When the boot report carries `x-safeStart: true` (`/run/keylos/boot/report.json`; chosen at the `kl-initrd` PIN prompt, boot spec), atrium MUST NOT restore the previous session's windows, MUST NOT run autostart entries (it tells `portal-background` to skip them) and MUST NOT auto-open recent documents or files offered by apps at startup; the keystrip shows "Safe start". The security centre lists the apps whose data units `strata` has quarantined (strata REQ-STRATA-098/099) with Release and Roll back actions, which `atrium-settings` performs as the owner's `shell` principal (route `strata#admin`, owner sessions only).

### 3.5 Clipboard and data transfer

- **REQ-ATRIUM-040** Selection reads (`wl_data_device`, primary selection) MUST be honoured only for the client with keyboard focus, and only within 1 s of a user input event delivered to that client.
- **REQ-ATRIUM-041** atrium MUST record the label of the source principal when content is offered, and MUST raise the receiving principal's label on transfer (§4.16).
- **REQ-ATRIUM-042** Pasting into `atrium-term` content that has label integrity `untrusted`, or that contains control characters or newlines, MUST show an inline paste preview requiring confirmation.
- **REQ-ATRIUM-043** atrium MUST assign every selection offer an opaque offer ID (128 random bits, base32) and MUST answer `ClipboardHost.source(offerId)` (facet `portal-clipboard`) with the owner principal, the recorded source label and the offered MIME types, for offers that are still current or were current within the last 60 s. Unknown or expired IDs MUST fail with `kl:not-found`.
- **REQ-ATRIUM-044** The offer ID MUST be visible only to the `trusted` class (as the MIME type `application/x-keylos-offer-id` on the offer), never to other clients.

### 3.6 Trusted terminal

- **REQ-ATRIUM-050** `atrium-term` MUST spawn shells only through `TrustedSpawn.spawnTerminal` on the route `warden#trusted-terminal` (§4.8), so that `warden` withholds `SECBIT_EXEC_DENY_INTERACTIVE` for exactly those shells (`protocols §9.3`).
- **REQ-ATRIUM-051** `atrium-term` MUST ignore OSC 52 (clipboard write) and OSC 1337/legacy file transfer sequences. It MUST render title changes (OSC 0/2) only inside the frame's secondary text, and MUST route OSC 8 hyperlinks through the `OpenUri` portal on explicit click.

### 3.7 Accessibility

- **REQ-ATRIUM-060** All trusted surfaces MUST expose an accessibility tree to the aggregator.
- **REQ-ATRIUM-061** The aggregator MUST hand `A11yObserver` capabilities only through `A11yGate.observer(consumer)` on facet `portal-a11y` (`protocols §7.5.17`), which only `portal-a11y` holds. atrium MUST refuse (`kl:denied`) a consumer whose generation name is not in `classes.assistive_generations`, whose actor kind is `agent`, or whose human differs from the human of the calling `portal-a11y` instance.
- **REQ-ATRIUM-062** An observer MUST NOT expose: any trusted surface, any node with role `password` or the `protected` state (its `value` and `name` are replaced by `"•"` runs of equal length), and the contents of tier-2 and agent-desktop windows (only the toplevel node with the frame's display name is shown).

### 3.8 Devices, removable media and inhibition

- **REQ-ATRIUM-070** atrium MUST subscribe to `DeviceAdmin.pending` (route `devd#authorize`) while any human session is unlocked and MUST show a trusted authorization card for each pending device (§4.19). Descriptor strings from the device MUST be rendered as untrusted text.
- **REQ-ATRIUM-071** For a pending device with `hidSafety = "keyboard-like"`, atrium MUST accept the Allow action only from an input event whose libinput device is already authorized and is not the pending device; Allow MUST stay disabled otherwise.
- **REQ-ATRIUM-072** atrium MUST obtain every device decision through `BrokerSystem.requestFor` for its own session (resource `device`, right `use`, `onBehalfOf` = the deciding human's shell principal; route `broker#system`, `protocols §7.5.2`) with `decidedOnTrustedPath = true` (the device card is the trusted-path decision, so the broker MUST NOT prompt again; when policy requires presence the broker refuses the flag and atrium retries without it) and MUST pass the delivered mandate from `GrantResult.mandate` (signed by `service/broker`) unmodified to `DeviceAdmin.authorize` (§4.19). It MUST NOT sign device decisions with its approver key and MUST NOT authorize any device without a decision, except devices whose class is listed in the machine's `devices.autoAuthorize` policy, which `devd` handles without atrium.
- **REQ-ATRIUM-073** atrium MUST NOT mount, read or parse removable media. For an authorized mass-storage, SD, optical or MTP device, atrium MAY start its media VM with `Bench.media` (route `bench#user`) to show the location "USB: <label>" with an Eject action and as a drop target for exports (REQ-ATRIUM-095); contents are browsed only through `portal-files`.
- **REQ-ATRIUM-074** `InhibitHost.inhibit` (facet `portal-inhibit`) MUST suppress only idle locking (`idle`) and the logout confirmation (`logout`). It MUST NOT suppress locking on SAK, lid close, suspend or `atrium-ctl lock`, and every active inhibition MUST be listed in the keystrip's capture indicator area with the owning principal.

### 3.9 Session variants

- **REQ-ATRIUM-080** The keystrip MUST show the machine's integrity profile (`protocols §2.2`) as read from `/run/keylos/boot/report.json` at session start and after every `courier` status change: `full` and `cvm` green; `shared-boot`, `shim` and `cloud-vtpm` amber with the profile name; `degraded` red. It MUST also show whether the owner's presence credentials include an assisted authenticator.
- **REQ-ATRIUM-081** Guest sessions (usernames `guest-*`, `protocols §3.3`) MUST be marked in the keystrip with a "Guest" badge and a reminder that all data is deleted at logout. atrium MUST NOT show presence prompts to a guest session and MUST NOT route guest prompts to a phone.
- **REQ-ATRIUM-082** On the `kiosk` profile, atrium MUST start the configured kiosk app fullscreen without panel or launcher, and MUST keep the keystrip, SAK and the lock screen. Leaving kiosk mode MUST require an owner login on the trusted path.

### 3.10 Agent desktops and disposable windows

- **REQ-ATRIUM-090** Windows of a VM principal with actor kind `agent` (agent-desktop mirrors, `protocols §14.5`) MUST carry a violet frame labelled "Agent desktop" with the template display name and the state `watching` or `taken over`. atrium MUST NOT deliver keyboard, pointer, touch, text-input or clipboard data to such a window unless the human has taken it over (§4.20).
- **REQ-ATRIUM-091** atrium MUST start network sign-in only by calling `NetCaptive.signIn` (route `net#captive`, `protocols §7.5.11`) after a human action on a trusted notification; atrium MUST NOT start captive VMs itself. The sign-in window (VM purpose `captive`, started by `net`) MUST be framed as "Network sign-in (disposable)"; closing it MUST call `NetCaptive.endSignIn()`, which makes `net` stop the VM and revoke its direct egress immediately; otherwise `net` stops the VM once the portal is passed or after 10 minutes.
- **REQ-ATRIUM-093** The agent-desktop frame's "Take over" and "Hand back" controls MUST call `AgentSession.takeOver(true|false)` on route `aide#user` (`protocols §7.3.14`) for the session whose VM the window shows, and only for agent sessions of the human logged in at the seat. atrium MUST keep blocking input until bench reports `displayMode = interactive` for that VM (through the `Display` client socket state), even after the call returns.
- **REQ-ATRIUM-094** For an owner whose presence credential is assisted (`protocols §5.3`), atrium MUST collect the PIN and the confirmation action on the trusted presence card and pass them as the `assist` argument of `Hearth.presence` (route `hearth#atrium`), encoded as JCS `{"pin": "…", "confirmed": true, "method": "pointer" | "keyboard" | "switch", "promptId": "sha256:<hex>"}` (prompt ID per §4.7.4). For roaming FIDO2 credentials `assist` MUST be empty. The PIN buffer MUST be a `memfd_secret` region zeroed after the call.
- **REQ-ATRIUM-095** atrium MUST stage a `media.export` intent on `gate` (route `gate#client`, `protocols §14.2`) for every file a human drops onto a media location chip, with the file contents as payload and the dragging app as the `app` argument, and MUST call `MediaBrowser.export` only with the mandate returned in `IntentStatus.result` after `Intent.commit`. atrium MUST NOT write to removable media by any other path.
- **REQ-ATRIUM-096** The launcher MUST start non-reproducible native app generations (effective tier 2, `protocols §6.3`) with `Bench.start` purpose `app` on route `bench#user`, and reproducible ones with `UserSpawn.spawnForHuman`; legacy images go through `Compat.run`.
- **REQ-ATRIUM-097** `TrustedPrompt.secret(title, body, confirm)` (facet `atrium#secret`, holders `hearth` and `vault`, `protocols §7.3.4`, E19) MUST show a trusted secret-entry card (security phrase, requesting service, `title`, `body`), collect the value into a `memfd_secret` region (never into a client-visible buffer, never into clipboard history), ask for it twice when `confirm` is true and refuse a mismatch, and return it in the delivery format of `protocols §20.10`, zeroizing its own copy. Cancel fails `kl:denied`; lock, user switch and SAK fail it `kl:unavailable`. Pasting into the field is refused.
- **REQ-ATRIUM-098** `Display.windowOwner(window)` (facet `atrium#broker`, holder `broker`, `protocols §7.5.16`, E21) MUST return the principal, human and generation name of the toplevel identified by `"window:<id>"` as recorded at client admission (§4.3), never client-supplied titles or app IDs; unknown or closed windows fail `kl:not-found`.
- **REQ-ATRIUM-092** For a `Screencast.start` whose consumer's actor kind is `agent` (a `screen.window.snapshot` grant, `protocols §14.5`), atrium MUST offer only `window` sources, MUST deliver exactly one frame and then stop the stream, and MUST show the picker each time.

---

## 4. Design

### 4.1 Process architecture

| Process | Principal | Tier | Role |
|---|---|---|---|
| `atrium` | `service:atrium:<gen>@_system/<s>` | t0 | Compositor, renderer, input, trusted surfaces, `TrustedPrompt`, `Display`, `Screencast`, a11y aggregator, clipboard |
| `atrium-decode` | child service, one per decode job pool | t0 (strict profile) | Decodes PNG/JPEG/WebP/SVG previews, markdown and diffs for prompts into RGBA buffers or layout runs |
| `atrium-panel`, `atrium-launcher` | `shell@<user>/<s>` (trusted shell client, §4.1.1) | t1 | Panel, task switcher, launcher, notification tray |
| `atrium-settings` | `shell@<user>/<s>` (trusted shell client) | t1 | Settings UI; produces config proposals; output layout |
| `atrium-security` | `shell@<user>/<s>` (trusted shell client) | t1 | Security centre: grants, receipts, integrity, devices, phones |
| `atrium-term` | `shell@<user>/<s>` (trusted shell client) holding `warden#trusted-terminal` | t1 | Trusted terminal emulator |
| `atrium-a11y-bridge` | Started by `warden` inside each GUI app's principal when accessibility is on | same as app | Translates the app's AT-SPI (private D-Bus inside the app sandbox) to `a11y.capnp` (`A11yHost` facet `bridge`) |
| `atrium-osk` | Internal client | trusted | On-screen keyboard |

#### 4.1.1 Trusted shell clients

The panel, launcher, settings, security centre and terminal are separate processes, so a bug in them cannot corrupt the compositor. They act for the human directly, so atrium spawns them with `UserSpawn.spawnForHuman` (route `warden#launcher`) and `SpawnSpec.actorKind = shell`. They are therefore `shell` principals of that human and hold the routes listed for `owner shell` / human `shell` holders in `protocols §19.2` (for example `ledger#reader`, `courier#client`, `config#owner` for owners, `hearth#admin` and `devd#admin` for the settings app).

A client is in the `trusted` class (§4.4) only if all of these hold:
1. its generation name is in `classes.trusted_generations` (§10);
2. its generation statement verifies against a `release-stream` key of the boot trust set (`depot` reports this in `GenerationInfo.sealedBy`);
3. its parent session (the second-to-last session of its chain, `protocols §3.4`) belongs to atrium itself, or to a `service:portal-…` principal (for `io.keylos.portals.ui`). atrium resolves the parent's principal from the sessions it spawned, or with `PrincipalControl.list` (route `warden#admin`).

Trusted shell clients talk to the compositor over the repo-local Wayland protocol `atrium_trusted_v1` (§5.6), which atrium advertises only to the `trusted` class.

The compositor process runs one async main loop (calloop, as Smithay uses) for the seat. Rendering happens on the main thread. Capwire servers run on a separate tokio runtime thread and communicate with the main loop through channels. Trusted-surface rendering uses an immediate-mode UI (egui on Smithay's GLES renderer) inside the compositor process.

### 4.2 Backends, devices and seats

- **Seat.** One `atrium` instance per seat. keylos 1.0 supports one seat per machine, plus headless instances for tests.
- **Device fds.** atrium enumerates devices with `Devd.list` and `Devd.watch` (route `devd#client`). It never calls `Devd.open`, which only the broker may call. Its service manifest declares `needs.devices: ["drm/card*", "input/event*"]`; the broker mints the matching device tokens when warden registers the session (`BrokerSystem.registerSession`), and atrium turns each token into an fd with `Broker.materialize(token, ResourceRef.device = <device id>)`.
- **DRM.** atrium becomes DRM master on the card fds. Atomic modesetting is required. Multi-GPU: render on the primary GPU, scan out on others with DMA-BUF import, or CPU copy as a fallback.
- **Input.** Evdev fds go to libinput's path backend (`libinput_path_add_device` on the received fd via an open-restricted callback that returns the pre-opened fds). Hotplug comes from `Devd.watch("input")`. Keyboards use xkbcommon keymaps from user settings.
- **Power events.** atrium subscribes to `PowerEvents` (route `devd#service`): `preSleep` locks the session before acking (§4.9); `lid` follows `lock.on_lid_close`. `Backlight` (route `devd#atrium`) drives brightness keys and the settings slider.
- **Hidraw** devices are never opened by atrium. FIDO2 is `hearth`'s job.
- **VT switching** is not used. The kernel console is disabled on the integrity profile (`fbcon` unbound after atrium takes over). A crash of atrium returns to a fixed recovery console only on debug images.

### 4.3 Client admission (`Display` interface)

1. When `warden` spawns a principal whose manifest entrypoint has `kind: "gui"`, or whose `needs.gpu` is `display`/`render`, it calls `Display.clientSocket(principal, tier, generation, process)` on route `atrium#display` (`protocols §7.5.16`).
2. atrium creates a listening `AF_UNIX` socket in its runtime dir `/run/keylos/atrium/c/<n>`, wraps it with `wp_security_context_v1` semantics, and records the binding:
   - `sandbox_engine = "io.keylos.warden"`
   - `app_id = <generation name>`
   - `instance_id = <principal text>`
3. It returns an `O_PATH` fd to the socket's directory. `warden` bind-mounts the socket into the app view at `/run/user/<uid>/wayland-0` and sets `WAYLAND_DISPLAY=wayland-0`.
4. On each accept, atrium performs the peer check of REQ-ATRIUM-001 and creates a client with the stored class.
5. The binding is removed when `warden` reports the principal exited (the `Process` capability passed in `clientSocket` resolves `wait`).

Tier-2 VM clients connect through `bench`'s crosvm cross-domain Wayland proxy. `bench` calls `Display.clientSocket` (route `atrium#display`) with the **VM principal** and `tier = t2`; the connecting process is the VM's `bench-gpu` backend, which runs as that VM principal, so the peer check holds. Legacy X clients connect through a per-principal Xwayland (§4.13), class `legacyX`.

`Display.clientSocket` returns `cls`, atrium's classification:

| `cls` | Condition |
|---|---|
| `trusted` | §4.1.1 |
| `assistive` | Generation name in `classes.assistive_generations` (owner config, §10) |
| `ime` | Generation name in `classes.ime_generations` (owner config) |
| `legacyX` | Set later, when `compat` hands over the Xwayland window-manager connection for this principal |
| `t2` | `tier` is `t2` or `t3` (tier-2 apps, workbench apps such as IDEs, agent-desktop mirrors, the captive sign-in VM) |
| `t1` | Everything else |

Membership in `assistive_generations` and `ime_generations` changes only through a presence-signed config generation, so no app can promote itself.

### 4.4 Protocol allowlist

Globals by class (✓ advertised, — hidden):

| Global | trusted | t1 | t2 | legacy-x | assistive | ime |
|---|---|---|---|---|---|---|
| wl_compositor, wl_subcompositor, wl_shm, wl_output, wl_seat | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| xdg_wm_base, xdg-decoration-v1 (server-side forced) | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| linux-dmabuf-v1, linux-drm-syncobj-v1 | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| wp_viewporter, wp_fractional_scale_v1, wp_presentation, wp_single_pixel_buffer, wp_alpha_modifier, wp_content_type, wp_tearing_control (honoured only for fullscreen) | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| wp_cursor_shape_v1, pointer-gestures | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| wl_data_device_manager, primary-selection | ✓ | ✓ (focus-bound) | ✓ (focus-bound) | ✓ (focus-bound) | ✓ | — |
| xdg_activation_v1 (tokens only from user input) | ✓ | ✓ | ✓ | ✓ | — | — |
| text-input-v3 | ✓ | ✓ | ✓ | ✓ | — | — |
| zwp_pointer_constraints, zwp_relative_pointer | ✓ | ✓ (fullscreen or after user click) | ✓ | ✓ | — | — |
| keyboard-shortcuts-inhibit (SAK never inhibited) | ✓ | ✓ (fullscreen only) | ✓ (fullscreen only) | — | — | — |
| idle-inhibit | ✓ | — (via Inhibit portal) | — | — | — | — |
| xdg-dialog-v1, xdg-toplevel-icon-v1 | ✓ | ✓ | ✓ | ✓ | — | — |
| wp_color_management_v1 | ✓ | ✓ | ✓ | — | — | — |
| tablet-v2 | ✓ | ✓ | ✓ | ✓ | — | — |
| xwayland-shell-v1 | — | — | — | ✓ (only the Xwayland client) | — | — |
| input-method-v2, virtual-keyboard-v1 | — | — | — | — | — | ✓ |
| layer-shell | ✓ | — | — | — | — | — |
| foreign-toplevel-list, foreign-toplevel-management | ✓ | — | — | — | ✓ (list only) | — |
| ext-session-lock | — (lock is in-process) | — | — | — | — | — |
| data-control (wlr and ext), screencopy (wlr), ext-image-copy-capture, export-dmabuf, virtual-pointer, output-management, gamma-control, security-context-v1 | — | — | — | — | — | — |

- **Classes** are assigned as in §4.3. `atrium_trusted_v1` (§5.6) is advertised to `trusted` only.
- **Unknown or new protocols** are hidden from all non-trusted classes until this table is updated in a release.

### 4.5 Identity frames

The frame is drawn outside the client's window geometry. Its height is 24 logical px at the top, plus a 2 px border on the other sides.

| Element | Source |
|---|---|
| Tier colour (border and top bar accent) | t1 neutral slate; t2 blue; legacy-x amber; tier-3 workbench windows (consoles, IDEs) violet with the project name; agent-desktop mirrors violet with a hatched border and the badge "Agent desktop" (§4.20); the captive sign-in VM blue with the badge "Network sign-in (disposable)"; trusted green (only trusted surfaces) |
| Primary text | Display name (§4.5.1) |
| Secondary text | Client title (`xdg_toplevel.set_title`), truncated, never styled like primary text |
| Label badge | `[conf/integ]` shown when not `internal/user`; red for `untrusted`, amber for `private`, red fill for `secret` |
| Principal chip | Short session ID (last 6 characters of the session ULID), with a tooltip showing the full principal |
| Capture indicator | Red dot when this window is being captured |

- **Fullscreen:** the frame is hidden. The keystrip shows `Fullscreen: <display name>` and the tier colour, and stays on top (§4.6.1).
- **Text safety:** every app-provided string (titles, localised names from the manifest `l10n` files) is wrapped in a Unicode bidi isolate, and bidi control characters are stripped from display names (`protocols §6.3` requires bidi isolation and confusable checks). Display names are compared, using UTS #39 confusable skeletons, against the names of installed generations and keylos components. A name that mixes scripts, or is confusable with another installed name, gets a warning badge in the frame and in prompts.
- **Popups and subsurfaces** of a client are clipped to that client's frame area plus at most 32 px for tooltips. Popups cannot extend over the keystrip.

#### 4.5.1 Display names

The display name of a generation comes only from verified data:

1. The **launcher index**: `atrium-launcher` builds it from `Depot.list("app", "")` and `Depot.list("legacy-image", "")` on route `depot#user`. For each generation it records the manifest `name`, `summary`, `publisher` and `l10n`. The launcher sends the index to atrium over `atrium_trusted_v1`; atrium trusts it because the launcher is a `trusted` client. atrium also calls `Depot.get` itself (route `depot#user`) for generations missing from the index.
2. The display name is the last label of the reverse-DNS `name` (for example `Editor` for `org.example.Editor`), with the publisher domain in secondary text and the manifest `summary` as the tooltip.
3. **Localised names.** The localised `entrypoints.<name>.name` lives in `/.keylos/l10n/<lang>.json` inside the generation. The launcher reads it with `Depot.openPath(gen, "/.keylos/l10n/<lang>.json")` on route `depot#user` (`protocols §7.3.8`; that facet allows `/.keylos/…` paths only), for the user's language and then the manifest `l10n.default`. The file is parsed by the launcher (a size limit of 64 KiB, JSON only), bidi-isolated and confusable-checked (§4.5) before it enters the index; a localised name that is confusable with another installed generation's name is replaced by the step-2 name with a warning badge. atrium's own trusted surfaces are localised from atrium's own generation.

In every case the name shown is derived from the verified manifest, never from client data.

### 4.6 Trusted path

#### 4.6.1 Keystrip

- A 28-logical-px bar at the top of every output. Client surfaces, including fullscreen ones and layer-shell surfaces of trusted shell clients, are laid out in the remaining area. Only atrium's own overlays (prompts, secure overview) can cover the keystrip, and they extend it visually.
- **Content, left to right:**
  1. integrity status: the integrity profile from `/run/keylos/boot/report.json` (`protocols §2.2`, §10.7) as a shield with the profile name on hover. `full` and `cvm` green; `shared-boot` (dual boot with the Microsoft CAs), `shim` and `cloud-vtpm` amber with the profile name always visible; `degraded` red. A rollback pending or a verification failure reported by `boot`/`courier` turns any profile red. A small key glyph appears when an owner credential is an assisted platform authenticator (`protocols §5.3`). On guest sessions a "Guest" badge follows the shield (REQ-ATRIUM-081);
  2. the current principal of the focused window (tier colour and display name);
  3. capture indicators (screen, camera, microphone, location, background; each is a red icon with the principal list on hover). Screen indicators come from atrium's own screencasts; the others come from portals through `IndicatorHost` (`protocols §7.5.18`). Active idle/logout inhibitions (`InhibitHost`, §4.21) show as a grey moon icon with the inhibiting principals;
  3a. pending device authorizations (a USB/Thunderbolt glyph with a count, §4.19) and mounted media locations ("USB: <label>" chips with Eject);
  4. pending approvals count;
  5. active agent sessions count with a progress pulse;
  6. clock.
- **Clicks on the keystrip** open trusted surfaces only: the approvals centre, the security centre, the agents panel.

#### 4.6.2 Secure attention key and secure overview

The SAK opens the secure overview, an in-process full-screen surface offering:
- Lock
- Switch user
- Approvals centre
- Security centre
- Agents panel
- Kill focused app (`PrincipalControl.terminate(session, kill)` on route `warden#admin`, for the focused client's session)
- Devices (pending authorizations, authorized devices with "Forget", media locations with Eject)
- Power (`Devd.power` on route `devd#admin`; `hibernate` is not offered, `protocols §2`)

SAK presses are recognised from physical keyboard devices only. Devices marked virtual by devd (uinput) are excluded. While the greeter or lock is showing, SAK focuses the password field.

#### 4.6.3 Anti-spoofing

- **Security phrase and image:** chosen by the user in a trusted surface at first login (a phrase of 2–6 words from a 7,776-word list, plus one of 256 built-in images), changeable from the secure overview after re-authentication. atrium stores them per user in `/var/lib/keylos/atrium/phrase/<user>.cbor` (mode 0600, atrium's own state; the disk is encrypted at rest). They are kept outside the home directory so the greeter can show them before unlock. No other principal can read them: atrium exposes them through no interface. Shown in the top-left of every prompt, the greeter (after the user is selected) and the lock screen.
- **Dimming:** while a prompt is active, all client surfaces are dimmed by 60% and desaturated. Clients receive no input.
- **Not capturable:** trusted surfaces are excluded from every screencast stream. In captured streams they appear as a solid grey rectangle labelled "Protected".
- **Input timing:** enable delay and fresh-input rule (REQ-ATRIUM-014). Keyboard approval needs `Enter` while the Approve button has focus. Initial focus is always on Deny.
- **Fake prompt detection:** a client window cannot cover the keystrip. Real prompts always extend the keystrip with a prompt badge ("Approval requested by …"). The user can confirm a prompt is real by pressing SAK at any time: real prompts survive SAK, fake ones do not.

### 4.7 `TrustedPrompt` implementation

#### 4.7.1 Queue

- One prompt is visible per seat. Pending prompts queue by tier (T3 first) and then FIFO.
- `approve` calls block (return a promise) until a decision.
- On lock, user switch or SAK "deny all", every pending prompt resolves `approved = false`, `note = "dismissed"`.
- Prompts for a principal of user A are never shown in user B's session. They wait, up to `expires`, for A's session to be active.

#### 4.7.2 Rendering

| Element | Rendering |
|---|---|
| Header | Tier badge (T2/T3); title from `summary`; requesting principal: display name, publisher (`key:` ref shortened plus the publisher name from depot), tier, session chip; on family machines a separate line "Requested by <requester> (not an owner)" when `requester` is set (REQ-ATRIUM-019) |
| Effects | One card per `RenderedEffect`: `title`; `body` rendered by `mime`; a "not reversible" warning when `reversible = false`. Required renderings (`review = required`) are shown in full (paged, never cut); a decorative rendering that fails shows "Preview unavailable" and does not block (REQ-ATRIUM-019b). Each card shows the first 16 hex characters of its `payloadDigest`, which matches the mandate draft effect it presents |
| `text/plain` | Monospace, wrapped, control characters shown as escapes |
| `text/markdown` | CommonMark subset: headings, paragraphs, lists, code, emphasis, tables. **No** images, HTML or clickable links; links are shown as text with the URL in full |
| `text/x-diff` | Unified diff viewer: per-file collapsible sections, syntax colouring for common languages, word-level highlights. Large diffs (> 2 MiB) come via `attachment` and are paged |
| `image/png` | Decoded by `atrium-decode`; size-limited to 8192×8192 |
| Provenance | Table of `ArgProvenance`: argument, source, label. Rows with `integ = untrusted` are highlighted red with the text "came from untrusted content" |
| Footer | The scope from the mandate draft (once / session / persistent), shown read-only; Deny (default focus); Approve; for presence prompts "Approve and touch key" (or "Approve and confirm" when the owner's credential is assisted, §4.7.4); for phone-routed prompts the line "Also sent to <phone label>"; the allowed channels from `channels` as small chips (local, phone, org) |

- **Decoding** of `body` and `attachment` content happens in `atrium-decode`:
  - a tier-0 child with a strict seccomp profile: read, write, mmap, munmap, exit, futex, brk only;
  - it receives input via memfd and returns RGBA via memfd;
  - it has a 2 s CPU limit and a 256 MiB memory limit per job.

  The compositor process never parses untrusted image or markdown bytes itself.

- **Approve gating.** Before enabling Approve, atrium checks REQ-ATRIUM-019b: the set of required renderings covers every `mandateDraft` effect digest, and each was decoded completely. The 750 ms enable delay (REQ-ATRIUM-014) starts only after the last required rendering finished; a decode result that arrives later (or a fallback switch) restarts it.

#### 4.7.3 Decision and mandate

1. On **Approve without presence**, atrium signs `mandateDraft` (the JCS bytes received) as a DSSE envelope (`application/vnd.keylos.mandate+json; version=1`) with its **approver key** (REQ-ATRIUM-017), `alg = "ed25519"`. It returns `Decision{approved: true, scope, mandate: envelope, note: ""}`.
2. On **Approve with presence**, atrium calls `Hearth.presence(purpose = "mandate", payload = mandateDraft, assist)` on route `hearth#atrium` (`assist` per REQ-ATRIUM-094). It shows "Touch your security key" within the prompt, with a 60 s timeout. It returns hearth's envelope unmodified.
3. On **Deny**, it returns `Decision{approved: false, scope: once, mandate: empty, note}`.

atrium never edits `mandateDraft`. `Decision.scope` always equals the draft's `scope`; a user who wants a different scope denies and lets the requester ask again.

**Defer.** When required material cannot be shown (REQ-ATRIUM-019c), Defer closes the card without a decision: the `approve` call stays pending, the prompt moves to the approvals centre marked "details unavailable", and it can be reopened (atrium retries decoding) until it is decided on another channel or `expires`, when it resolves `approved = false`.

**Phone routing.** When REQ-ATRIUM-018 allows it (`channels` contains `"phone"`, no presence required, seat locked or idle for more than `prompts.phone_after_idle_secs`), atrium calls `VouchLink.routeApproval(prompt)` on route `vouch#approvals` **in addition to** queuing the local prompt. The first decision wins: a phone decision cancels the local prompt, and a local decision is returned even if the phone answers later. The phone's `Decision.mandate` (signed by the phone approval key, `channel: "phone"`) is returned unmodified. If `vouch` is not running, routing is skipped silently. `vouch` itself declines prompts whose required renderings it cannot present (vouch spec); the local prompt is unaffected.

#### 4.7.4 `presence`

`TrustedPrompt.presence(purpose, payload, rendering)` is served on facet `atrium#presence` to `config`, `depot`, `courier`, `hearth` and `forge` (`protocols §19.2`) for owner-presence signatures without an approval card. atrium:
1. checks that `purpose` is a registered presence purpose (`protocols §20.2`) and that the payload's `schema` matches it;
2. shows a compact trusted card with the purpose text (§4.7.5), a payload summary derived from the payload fields listed in §4.7.5, the payload digest (first 16 hex characters of SHA-256), and the requesting service;
3. renders each `RenderedEffect` in `rendering` below the summary with the same renderers as approval prompts (§4.7.2), each with the first 16 hex characters of SHA-256 over its `body` (or its attachment bytes). A config plan diff therefore appears next to the statement, and the digests match the ones the `config` CLI prints (REQ-ATRIUM-019a). An empty `rendering` shows only the summary. The confirm action is gated exactly like Approve (REQ-ATRIUM-019b/019c): a required rendering that cannot be presented disables it;
4. calls `Hearth.presence(purpose, payload, assist)` on route `hearth#atrium` (`assist` empty except for assisted credentials, REQ-ATRIUM-094) and returns the envelope unmodified.

On quorum machines (`protocols §5.4`) presence is collected remotely and never reaches atrium; a `presence` call there fails with `kl:unsupported`. Quorum approvers review requests with `hearth presence --remote`, which applies the same required-rendering rule (hearth spec, `protocols §14.3`).

**Assist prompt ID** (`protocols §7.3.12`, E12). For an assisted credential the `assist` confirmation is bound to the card the owner saw by its prompt ID `sha256:<hex>` = SHA-256 of the DSSE PAE of `payload` (payload type of the presence statement, `protocols §5.1`); atrium computes it, shows its first 16 hex characters on the card, and includes it in `assist` as `"promptId"` (REQ-ATRIUM-094); hearth recomputes it and refuses a mismatch. For an owner whose credential is an **assisted platform authenticator**, user presence is the confirmation inside this atrium-drawn card (pointer, keyboard or switch-access action) and user verification is the PIN entered in the card's PIN field; atrium passes both to hearth in the `assist` argument of `Hearth.presence` (REQ-ATRIUM-094).

A payload whose `schema` does not match the purpose is refused with `kl:invalid` before anything is shown.

#### 4.7.5 Purpose strings

| Purpose (`protocols §20.2`) | Shown as | Summary fields shown |
|---|---|---|
| `mandate` | (inside approval prompts) | — |
| `config.apply` | "Apply configuration change" | `generation` (short), `counter`, `proposedBy` |
| `seal.window` | "Allow sealing code from <project> for 10 minutes" | `project`, `drvs` count, `expires` |
| `owners.entry` | "Change owners or security keys" | `op`, `owner`, credential `label` |
| `grant.persist` | "Remember this permission" | `principal`, effects |
| `exception` | "Allow a non-reproducible app outside a VM" | `name`, `publisher`, `reason` |
| `debug.grant` | "Allow debugging of <target> for <duration>" | effects (target principal, scope `process`/`kernel`, expiry) |
| `ledger.shred` | "Permanently delete receipt contents for <months>" | `details` |
| `trustee.split` | "Split the recovery key among trustees" | `details` (k, n, trustee labels) |
| `ledger.reset-writer:<svc>` | "Reset the receipt signer of <svc>" | `requestedBy` |
| `ledger.ack-alarm` | "Acknowledge a receipt-log alarm" | `details` |
| `vault.<op>` | "Secrets: <op>" | `details` |
| `update.<op>` | "Update: <op>" | `details` |
| `boot.<op>` | "Boot settings: <op>" | `details` |
| anything else | Refused (`kl:invalid`) | — |

#### 4.7.6 `notify`

System notifications (`TrustedPrompt.notify`) appear with a keystrip-attached style that app notifications cannot use. `critical` notifications stay until dismissed.

### 4.8 Trusted terminal (`atrium-term`)

- **Emulator:** VT parsing via `alacritty_terminal`; GPU text rendering in a Wayland client (class `trusted`).
- **Spawning:** `atrium-term` is a trusted shell client (§4.1.1) holding the route `warden#trusted-terminal`. For each tab, it:
  1. opens a pty pair (`/dev/ptmx`; the pty multiplexer is in its view);
  2. calls `TrustedSpawn.spawnTerminal(spec, pty)` with `spec.generation` = the configured shell generation, `spec.actorKind = shell`, `spec.terminal` = the pty secondary.

  The shell generation MUST be listed in `terminal.shell_generations` (§10, owner config); atrium-term refuses any other. warden gives that process tree `SECBIT_EXEC_RESTRICT_FILE` only, so it can run interactive commands (`protocols §9.3`).
- **Escape filtering:** REQ-ATRIUM-051. Also: no DECRQSS/terminal-report responses that echo attacker-controlled data back as input; bracketed paste always on; OSC 7 cwd hints honoured only for tab titles.
- **Paste protection:** REQ-ATRIUM-042.
- **Label banner:** atrium-term reports each tab's shell session ID (from `Process.principal`) to the compositor over `atrium_trusted_v1`. The compositor polls `LabelAuthority.labelOf(session)` (route `broker#label-authority`) every 2 s and on focus, and draws a coloured top line on the tab when the label is above `internal/user`. The banner is drawn by the compositor, so the shell cannot hide it.

### 4.9 Greeter, lock and sessions

| Surface | Behaviour |
|---|---|
| Greeter | Lists `Hearth.users` on route `hearth#greeter` (display names; hidden users omitted). Methods: password, PIN, FIDO2, or combinations per user policy. Calls `Hearth.login(user, method, response)` and gets a `SessionId` |
| First login | If the user has no security phrase yet, atrium shows the trusted phrase-and-image chooser before the desktop (§4.6.3) |
| Guest session | When `greeter.guest_button` is true, the greeter shows "Guest". It calls `Hearth.login("guest", "guest", <empty>)`; hearth creates the ephemeral `guest-<id>` user, home and unit key (`protocols §3.3`, §7.5.7) and returns the session. Guests have no security phrase: their prompts show the fixed text "Guest session" in the phrase slot and never include presence (REQ-ATRIUM-081). Logout destroys the session's data; atrium asks for confirmation with that warning |
| Kiosk | On the `kiosk` profile (§4.22), the greeter is replaced by an automatic `Hearth.login(kiosk.user, "kiosk", <empty>)` at seat start |
| Safe start | REQ-ATRIUM-034: no window/session restore, no autostart, no auto-open; "Safe start" on the keystrip; quarantined app data listed in the security centre |
| Session start | atrium spawns the trusted shell clients with `UserSpawn.spawnForHuman` (route `warden#launcher`, `actorKind = shell`): `atrium-panel`, `atrium-launcher`. `warden` starts the per-user portal instances itself (portals spec). Autostart is owned by `portal-background` (portals spec). kish is started only when a terminal opens |
| Lock | Triggered by SAK menu, idle timeout, lid close, `PowerEvents.preSleep` or `atrium-ctl lock`. In-process surface; calls `Hearth.lock(session)`, which makes `vault` drop unlocked keys for that user. Screencasts stop. Prompts are denied |
| Unlock | `Hearth.unlock`; then compositing resumes |
| User switch | Lock the current session, show the greeter. A second user's clients get their own sockets; the first user's surfaces are not composited, receive no input, and get no frame callbacks |
| Logout | `PrincipalControl.list(user)` then `PrincipalControl.terminate(session, kill)` for each top-level session of the user (route `warden#admin`; terminate covers descendants), wait up to 5 s for exits, then return to the greeter |

### 4.10 Desktop shell components

| Component | Implementation | Data sources |
|---|---|---|
| Panel | `atrium-panel` (layer-shell, trusted shell client) | Toplevel list (foreign-toplevel-list), system notification summary |
| Launcher | `atrium-launcher` (trusted shell client) | `Depot.list` on `depot#user` (§4.5.1); apps with `gui` entrypoints are launched by asking the compositor over `atrium_trusted_v1`, which calls `UserSpawn.spawnForHuman` (route `warden#launcher`, `actorKind = app`) for reproducible generations and `Bench.start` with purpose `app` (route `bench#user`) for non-reproducible ones (effective tier 2, REQ-ATRIUM-096); legacy images are launched through `Compat.run` (route `compat#user`) |
| System notifications | In-process | `TrustedPrompt.notify` (facet `atrium#notify`) from tier-0 services and `portal-notify`; rendered in the keystrip-attached system style |
| App notifications | `portal-ui` (portals spec) | Rendered by the portals' trusted client as layer-shell toasts with app attribution; atrium only composites them |
| Approvals centre | In-process | Pending T2 batches and T3 prompts (internal queue) |
| Agents panel | In-process | `Aide.sessions`, `Aide.attach`, `AgentSession.events` (route `aide#user`); "Review" calls `AgentSession.review`, which raises a T3 prompt |
| Security centre | `atrium-security` (trusted shell client) | Grants (`Broker.myGrants`, `Broker.revoke` on `broker#principal`); receipts and approvals history (`Ledger.query` on `ledger#reader`); integrity status (`Courier.status` on `courier#client`, `/run/keylos/boot/report.json`); devices (`Devd.list`); paired phones (`VouchLink.phones` on `vouch#settings`); active captures (from the compositor over `atrium_trusted_v1`) |
| Settings | `atrium-settings` (trusted shell client) | User settings write to atrium's user config subvolume. Output layout via `Display.outputs` (facet `atrium#settings`). System settings produce a Nickel patch and call `Config.propose` (route `config#owner` or `config#user`), which leads to a `Plan` and a presence prompt. Users and keys via `hearth#admin`; Bluetooth and power via `devd#admin`; phone pairing via `vouch#settings` |

### 4.11 Outputs and rendering

- **Rendering:** GLES 3.0+ via Smithay's GlesRenderer. Damage tracking per output. Direct scanout of fullscreen client buffers when the formats allow. Hardware cursor planes.
- **Scaling:** per-output integer and fractional scale (`wp_fractional_scale_v1`); 120-based scale denominators per the protocol.
- **Timing:** VRR when supported and a fullscreen client opts in through content-type `game`/`video`. Tearing control only for fullscreen.
- **Colour:** colour management through `wp_color_management_v1`. SDR composition in sRGB/BT.709; HDR10 passthrough for fullscreen surfaces when the connector supports HDR metadata.
- **Night light:** via the DRM gamma LUT.
- **Hotplug:** output layout is restored per connector EDID identity from user settings.
- **Mirroring and presentation mode** are available from settings and the SAK overview.

### 4.12 Input

- **Keyboard:** layouts and options via xkbcommon, per user; compose; key repeat settings.
- **Pointer and touchpad:** acceleration and gestures (3- and 4-finger swipes for workspaces and overview); touch and tablet.
- **Input methods:** an IME engine runs as a principal with the `ime` class (for example fcitx5 packaged with a D-Bus island inside its own sandbox). It talks `input-method-v2` and `virtual-keyboard-v1`. Its text reaches only the focused `text-input-v3` surface. IME engines get no access to trusted surfaces: trusted text fields use atrium's built-in xkb input plus its own compose.
- **Global shortcuts:** apps register through the `GlobalShortcuts` portal (`portal-shortcuts`), which forwards to atrium's `ShortcutsHost` (facet `atrium#portal-shortcuts`, `protocols §7.5.18`). atrium shows a trusted confirmation the first time; the user can rebind. Global shortcuts never fire while a trusted surface has focus.

### 4.13 Legacy X11 (per-app Xwayland)

1. `compat` starts rootless Xwayland *inside the legacy principal's sandbox* for each legacy app that needs X11 (runtime generation `io.keylos.compat.x11`). It passes `-wm <fd>` with one end of a socketpair and `-listenfd` for the X socket inside the app's view.
2. `compat` calls `Display.xwaylandWm(principal, wmFd)` on route `atrium#display` to hand the other end to atrium. atrium accepts `xwaylandWm` only from the `compat` service principal, and only for a principal that already has a client socket; that principal's class becomes `legacyX`.
3. atrium runs Smithay's X11 window-manager logic on that connection and maps X windows to Wayland surfaces through `xwayland-shell-v1`.

Each X server serves exactly one legacy principal. X clients of one principal therefore cannot see others'. X11 selections are bridged to atrium's clipboard with the focus-bound and label rules (§4.16).

### 4.14 Tier-2 VM windows

- Surfaces from crosvm's cross-domain Wayland proxy (`bench`) are class `t2`, with the VM principal. They are shown with the blue tier frame and the display name of the generation passed in `Display.clientSocket` (the legacy image or app generation the VM runs).
- Window titles from inside the VM are secondary text.
- Clipboard transfers into and out of the VM follow §4.16. Content from the VM carries `integ = untrusted`.
- **GPU:** VM rendering uses virtio-gpu native context. atrium sees ordinary DMA-BUFs from the proxy. No GPU state is shared beyond buffer import.

### 4.15 Screencast production

- `portal-screen` calls `Screencast.start(CastRequest{consumer, kinds, cursor, multiple})` on facet `atrium#portal-screen` (`protocols §7.5.18`). atrium shows a trusted **source picker**: outputs, windows, a region (only the kinds requested; several sources when `multiple`). The picker lists only the consumer's human's own windows; trusted surfaces are excluded.
- After the user picks, atrium creates one PipeWire video node per source (DMA-BUF with SHM fallback). It returns `streams` (one `CastStream` per node), a PipeWire remote fd restricted to those nodes, and a `Cancelable` that stops all of them. atrium connects to PipeWire as a privileged client and sets the per-client permissions for the consumer.
- While a capture is active:
  - the keystrip shows a red capture indicator naming the consumer principal;
  - the captured window's frame shows the capture dot;
  - stopping happens from the keystrip, the consumer's `Cancelable`, or on lock.
- Cursor metadata is embedded per the PipeWire metadata spec when requested.
- **Agent consumers** (`screen.window.snapshot`, `protocols §14.5`). When the consumer's actor kind is `agent`, the picker offers only windows of the agent's human, shows "An agent asks for one still image of a window" in its title, and the stream delivers exactly one frame before atrium stops it (REQ-ATRIUM-092). The picker is shown for every request; there is no "remember".
- **Inside agent desktops** the nested atrium serves its own screencasts; the host atrium never exports host windows into an agent desktop.

### 4.16 Clipboard, drag-and-drop and labels

1. When a client sets a selection or starts a drag, atrium records the **source label**: it calls `LabelAuthority.labelOf(sourceSession)` on route `broker#label-authority` (`protocols §7.5.2`) and stores the result with the offer. Content from `t2` and `legacyX` clients is additionally marked `integ = untrusted`. atrium also assigns the offer an **offer ID** (REQ-ATRIUM-043) and adds the MIME type `application/x-keylos-offer-id` (value: the ID) to the offer as seen by `trusted`-class clients only (REQ-ATRIUM-044).
1a. **Non-Wayland readers.** `portal-clipboard` serves `Clipboard.read` to principals without a Wayland connection (CLI tools in the trusted terminal). It reads the current selection through its trusted `portal-ui` Wayland client, takes the offer ID, and calls `ClipboardHost.source(offerId)` on facet `atrium#portal-clipboard` (`protocols §7.5.18`). atrium answers with the owner principal, the recorded label and the MIME types; `portal-clipboard` then raises the reader's label to that label before handing data over (portals spec). Selections set by `portal-ui` on behalf of a writer are recorded with the writer's label, which `portal-clipboard` passes in the offer's metadata and atrium verifies against `LabelAuthority.labelOf(writerSession)` before storing it.
2. When a client receives data:
   - the transfer is allowed only for the focused client within the input window (REQ-ATRIUM-040);
   - atrium calls `LabelAuthority.raiseFor(receiverSession, sourceLabel, "clipboard")` **before** the receiving fd gets any byte (`protocols §14.1`);
   - if the broker refuses the raise (for example an agent workbench console holding private data while the source is untrusted, which would complete the Rule of Two), the transfer is refused with a trusted notification.
3. **Data path:** atrium proxies transfers through its own pipes; clients never receive each other's fds. For drag-and-drop of files, the payload is a **file grant**, not a path:
   - a drag from a source holding file grants carries those tokens; on drop, atrium calls `FilePicker.confirmDrop(tokens, target)` on route `portal-files#drop` (`protocols §7.5.19`), which re-opens the entries for the target and returns fds; a path-expecting target receives a dropped file as a single-file view, never with its parent directory (portals §4.2.5, `protocols` E32);
   - `text/uri-list` drops of `file://` URIs from apps carry no authority: atrium turns them into a `confirmDrop` with no tokens, which shows the trusted picker preselected on those names.
4. **Clipboard history** exists only in trusted UI, keeps at most 20 entries, keeps no `secret`-labelled entries, and is in memory only.

### 4.17 Accessibility

- **Aggregator:** atrium keeps a per-seat accessibility tree whose roots are the toplevels. Each app's subtree comes from its `atrium-a11y-bridge` through `A11yHost.attach` (facet `atrium#bridge`, `protocols §7.5.17`). Trusted surfaces provide their own subtrees (egui's AccessKit integration).
- **Bridge:** for apps whose toolkit speaks AT-SPI2 (GTK, Qt), `warden` starts `atrium-a11y-bridge` inside the app's principal with a private D-Bus daemon socket in the app's runtime dir (a D-Bus island of one app). The bridge reads the app's AT-SPI tree and translates it. Apps that use AccessKit natively attach on facet `atrium#native`.
- **Assistive principals** (screen readers, switch control) receive an `A11yObserver` through `Accessibility.observe` on `portal-a11y`, which needs a persistent T3 grant (portals spec). `portal-a11y` obtains each observer from atrium with `A11yGate.observer(consumer)` on facet `atrium#portal-a11y` (`protocols §7.5.17`). atrium checks REQ-ATRIUM-061 and returns an observer bound to that consumer: it filters every update per REQ-ATRIUM-062, refuses `doAction` on filtered nodes and on trusted surfaces (`ok = false`), and is revoked when the consumer exits or the session locks. Their generation must also be listed in `classes.assistive_generations` to get the `assistive` Wayland class. `portal-a11y` raises their label to `private` when it hands over the observer.
- **Agents** never receive an observer (`protocols §14.5`); agent desktops expose their own nested accessibility tree through `AgentDesktop.a11yTree`, served inside the agent's VM.
- **Built-in features:** magnifier (compositor zoom with pointer and focus tracking), high-contrast and large-text themes for trusted UI, reduced motion, cursor size, sticky and slow keys (implemented in the input pipeline), and the on-screen keyboard `atrium-osk` (trusted).

### 4.18 Crash and restart

- `warden` restarts `atrium` on crash, with backoff 1 s, 2 s, 4 s, and a maximum of 5 restarts in 2 minutes. After that, the recovery console on debug images or a hard reboot on production images.
- Wayland clients lose their connections and normally exit. User sessions continue with background principals still running.
- After restart, atrium shows the lock screen for a logged-in user, or the greeter (REQ-ATRIUM-033).

### 4.19 Device authorization and media locations

`devd` keeps every new USB device unauthorized and every Thunderbolt/USB4 domain unapproved until a trusted-path decision (`protocols §9.5`). atrium is the only holder of `devd#authorize`.

1. **Pending stream.** While a human session is unlocked, atrium holds `DeviceAdmin.pending(watcher)`. Each `PendingDevice` becomes a queued **device card**; when the seat is locked or at the greeter, cards wait (a keystrip count still shows them after unlock). Devices pre-authorized at install, devices whose identity was remembered, and auto-authorized classes (`devices.autoAuthorize`) never reach atrium.
2. **Card.** The card is a trusted surface (same anti-spoofing as prompts, §4.6.3) showing: bus, port (as "left USB-C port" when the port path is in the machine's port names table, else the path), vendor and product IDs with names from atrium's own hwdb copy, the device's descriptor `name` rendered as untrusted text in quotes, the interface classes as icons with words ("keyboard", "storage", "network adapter"), and, for `hidSafety = "keyboard-like"`, the warning "This device can type. Only allow it if you just plugged in a keyboard." Buttons: Block (default focus), Allow once, Allow and remember.
3. **HID safety.** For keyboard-like devices, the Allow buttons react only to input whose libinput device ID maps to an already-authorized devd device (REQ-ATRIUM-071). The pending device is unauthorized, so its own events never reach atrium; this rule also covers composite devices that expose a second, already-authorized interface.
4. **Decision.** The card is the trusted prompt of a broker approval. When the human presses Allow (subject to the HID-safety rule), atrium calls
   `BrokerSystem.requestFor(subject = atrium's own session, req = GrantRequest{resource = device(<device id>), rights = [use], reason = "<card summary>", persist = <Allow and remember>, onBehalfOf = <the deciding human's shell principal>}, intent = "", idempotencyKey = "dev:<device id>:<attachment counter>", intentSession = <empty>, decidedOnTrustedPath = true)` on route `broker#system` (REQ-ATRIUM-072).
   The broker evaluates policy (device decisions are T2); because `decidedOnTrustedPath` is true it does not send a prompt back to atrium, records `approval.decide` with channel `local`, and returns the mandate signed by `service/broker` in `GrantResult.mandate`, whose `effects` contain `{kind: "device.authorize", target: "<device id>", digest: "sha256:<SHA-256 of the JCS PendingDevice JSON>"}` (`protocols §7.5.2`). If policy requires presence, the broker refuses `decidedOnTrustedPath` (`kl:invalid`) and atrium repeats the call with `decidedOnTrustedPath = false`, which yields the normal presence prompt.
   atrium then calls `DeviceAdmin.authorize(device, persist, mandate)` with `persist = true` only for "Allow and remember". On Block, it calls nothing; devd keeps the device unauthorized, and the card does not reappear for that attachment.
5. **Thunderbolt/USB4.** The same card is used with bus `thunderbolt`; the text adds "This device can access memory directly. The IOMMU protects this machine" when the boot report says the IOMMU is active. Without an IOMMU devd never offers the device (`protocols §9.5`), so atrium never shows a card.
6. **Forget.** The security centre lists authorized devices from `Devd.list`; "Forget" calls `DeviceAdmin.deauthorize(device, forget = true)`.
7. **Media locations.** After an authorized device exposes a mass-storage, SD, optical or MTP interface, atrium calls `Bench.media(device)` on route `bench#user` (`protocols §7.3.13`). It keeps the returned `MediaBrowser` only for `eject` and mandated `export` (step 8); it never calls `list` or `open` (REQ-ATRIUM-073). The keystrip and the panel show the chip "USB: <label>" (label from the browser's root entry, rendered as untrusted text). Eject calls `MediaBrowser.eject()`. `portal-files` obtains its own browser for the same device to show the location in file pickers (portals spec).
8. **Exports to media.** Dropping a file onto a media chip stages a `media.export` intent on `gate` (REQ-ATRIUM-095): `Gate.stage(EffectIntent{kind = "media.export", class = compensable, target = "media:<device id>:<path>", args = [{name: "app", value: <dragging principal>}, {name: "device", value: <label>}], idempotencyKey, payload = <sealed memfd with the file bytes>})`. `gate` renders and decides it (a T2 approval shown by atrium like any other), and `Intent.commit` returns the delivered mandate in `IntentStatus.result`. atrium passes the same memfd and that mandate to `MediaBrowser.export(path, data, mandate)`; bench verifies the mandate and writes the `media.export` completion receipt.

### 4.20 Agent desktops and the network sign-in window

- **Agent desktops** (`protocols §14.5`). When an agent template sets `vm.desktop: true`, `bench` starts the agent's VM with purpose `agentDesktop` and `displayMode = readOnly`, and calls `Display.clientSocket` with the VM principal (actor kind `agent`, tier `t3`). atrium shows the nested desktop as one window with the agent-desktop frame (§4.5). The frame shows "watching" while read-only.
- **Input.** atrium delivers no input, text input, selection or drag data to an agent-desktop window while it is read-only (REQ-ATRIUM-090). The frame's "Take over" button is a trusted control; it calls `AgentSession.takeOver(true)` on route `aide#user` (REQ-ATRIUM-093), which aide relays to `Vm.takeOver`; "Hand back" calls `takeOver(false)`. `bench` is the enforcement point on its side as well: its display proxy drops input while the VM's `displayMode` is `readOnly` (bench spec). After take-over the frame says "taken over"; the agent's own `AgentDesktop.input` calls are refused by bench until the human hands control back.
- **Labels.** Content dragged or pasted out of a taken-over agent desktop carries the VM principal's label (§4.16). Nothing is pasted into an agent desktop unless it is taken over, and then only with the label raise on the agent's session.
- **Network sign-in.** atrium watches `NetWatch` on route `net#captive`. When `net` reports a captive network, atrium posts a trusted notification "Sign in to <ssid>". On click it calls `NetCaptive.signIn()` on route `net#captive` (REQ-ATRIUM-091); `net` starts the captive VM through `bench#net` with the portal URL in `bootArgs`, admits it and mints its token (`protocols §7.5.11`). The window arrives through `Display.clientSocket` like any tier-3 VM; atrium recognises it by the VM's purpose and frames it per REQ-ATRIUM-091. `net` stops the VM when the network is no longer captive or after 10 minutes; closing the window makes atrium call `NetCaptive.endSignIn()` (`protocols §7.5.11`); `net` stops the VM and revokes its direct egress, and atrium shows "Sign-in closed". Nothing from that VM can be dragged or pasted out.

### 4.21 Idle and logout inhibition

`portal-inhibit` forwards app requests of kinds `idle` and `logout` to `InhibitHost.inhibit(owner, kinds, reason)` on facet `atrium#portal-inhibit` (`protocols §7.5.18`); kinds `suspend` and `lid` go to devd and never reach atrium.

| Kind | Effect while an inhibition is held |
|---|---|
| `idle` | The idle lock timer and display blanking do not start. Locking on SAK, lid close, suspend and `atrium-ctl lock` still happen (REQ-ATRIUM-074). An inhibition older than `inhibit.idle_max_secs` (default 4 h) expires with a notification |
| `logout` | Logout shows "<app> is preventing logout: <reason>" with "Log out anyway" and "Cancel" |

Each inhibition is listed in the keystrip (§4.6.1) and released when the handle is cancelled, the owner principal exits or the session locks (for `idle`, a lock caused by SAK or lid close does not cancel it; it resumes after unlock).

### 4.22 Kiosk, guest and family sessions

- **Kiosk** (profile `kiosk`, `protocols §2.2`). Config `kiosk.app` (generation name), `kiosk.entrypoint` and `kiosk.user` select the app and the kiosk user. At seat start atrium logs in the kiosk user (§4.9) and spawns the app with `UserSpawn.spawnForHuman` (route `warden#launcher`, `actorKind = app`) fullscreen on every output. Panel, launcher, notifications from apps, global shortcuts and drag-and-drop are disabled. The keystrip remains (REQ-ATRIUM-082); its menu offers only "Owner login". When the app exits, atrium restarts it after 2 s (at most 5 times per minute, then shows "Out of service"). SAK opens the secure overview restricted to Lock and Owner login; an owner login switches to a normal owner session, and logging out returns to kiosk mode.
- **Guest** sessions follow §4.9 and REQ-ATRIUM-081. The panel shows "Guest" and a "Delete my data and log out" action. Agent sessions are offered only if `hearth.guest.agents` is true (atrium shows the agents panel based on `Aide.sessions` succeeding).
- **Family machines.** Prompts with `requester` set are queued for owners only (REQ-ATRIUM-019). When an owner's session is active, the approvals centre shows them in a separate "Requests from <requester>" group; the non-owner sees "Waiting for an owner" in their own session's approvals centre, with no approve controls.

---

## 5. Interfaces

### 5.1 Capwire interfaces implemented

All schemas are in keylos-protocols 1.0.0 (final); atrium defines no capwire schema of its own. Facets are exactly those of `protocols §19.2` (Appendix A.30).

| Interface | Facet | Callers | Appendix |
|---|---|---|---|
| `TrustedPrompt.approve` | `approve` | broker | A.9 |
| `TrustedPrompt.presence` | `presence` | config, depot, courier, hearth, forge | A.9 |
| `TrustedPrompt.notify` | `notify` | tier-0 services, portal-notify | A.9 |
| `TrustedPrompt.secret` | `secret` | hearth, vault (REQ-ATRIUM-097) | A.9 |
| `Display.windowOwner` | `broker` | broker (REQ-ATRIUM-098) | A.20 |
| `Display.clientSocket`, `xwaylandWm` | `display` | warden, bench, compat (`xwaylandWm`: compat only) | A.20 |
| `Display.outputs` | `settings` | atrium-settings | A.20 |
| `A11yHost` | `bridge`, `native` | atrium-a11y-bridge, AccessKit apps | A.21 |
| `Screencast` | `portal-screen` | portal-screen | A.22 |
| `ShortcutsHost` | `portal-shortcuts` | portal-shortcuts | A.22 |
| `IndicatorHost` | `portal-camera`, `portal-mic`, `portal-location`, `portal-background`, `portal-screen` | the corresponding portal | A.22 |
| `A11yGate` | `portal-a11y` | portal-a11y | A.21 |
| `ClipboardHost` | `portal-clipboard` | portal-clipboard | A.22 |
| `InhibitHost` | `portal-inhibit` | portal-inhibit | A.22 |
| atrium-local control (`atrium-ctl`) | `ctl` | atrium-ctl | §5.3 |

Every bootstrap capability also implements `common.Extensible` (`protocols §7.3.1`).

### 5.2 Routes atrium holds

| Route | Use |
|---|---|
| `warden#client`, `warden#service` | `identify`, `connectionInfo`, `Supervisor.spawn` of `atrium-decode` |
| `warden#launcher` | `UserSpawn.spawnForHuman` for trusted shell clients and app launches |
| `warden#admin` | `PrincipalControl.terminate`/`list` (kill focused app, logout) |
| `broker#principal` | `Broker.materialize` of device tokens; `Broker.label` |
| `broker#system` | `BrokerSystem.registerApprover` (once per boot) |
| `broker#label-authority` | `LabelAuthority.labelOf`/`raiseFor` (clipboard, drag-and-drop, terminal banner) |
| `hearth#greeter`, `hearth#atrium` | Greeter and lock; presence for approvals |
| `devd#client`, `devd#service`, `devd#atrium`, `devd#admin` | Device enumeration, power events, backlight, power actions |
| `devd#authorize` | `DeviceAdmin.pending`, `authorize`, `deauthorize` (§4.19) |
| `bench#user` | `Bench.media` (media locations); `Bench.start` with purpose `app` for non-reproducible native apps (REQ-ATRIUM-096) |
| `aide#user` | `AgentSession.takeOver` for agent-desktop mirrors (REQ-ATRIUM-093) |
| `gate#client` | `Gate.stage`, `Intent.commit` for `media.export` (REQ-ATRIUM-095) |
| `pipewire#portals` | PipeWire native protocol for creating screencast video nodes (§4.15) |
| `net#captive` | `NetWatch`, `NetCaptive.status`, `signIn` (§4.20) |
| `depot#user` | Display names and localised names via `openPath` (§4.5.1) |
| `aide#user` | Agents panel |
| `courier#client` | Keystrip integrity status |
| `portal-files#drop` | `FilePicker.confirmDrop` |
| `vouch#approvals` | `VouchLink.routeApproval` (when a phone is paired) |

The trusted shell clients (§4.1.1) hold the human-`shell` routes listed in §4.10, not these.

### 5.3 CLI: `atrium-ctl`

```
atrium-ctl lock
atrium-ctl outputs [--json]
atrium-ctl screenshot [--output NAME | --window | --region]   # trusted picker; result saved via powerbox save dialog
atrium-ctl reload-config
atrium-ctl approvals [--json]                                  # list only; decisions only in UI
atrium-ctl a11y (on|off|status)
atrium-ctl debug (damage|fps|protocols) (on|off)               # debug images only
```

Exit codes: 0 ok; 1 failed; 2 usage error; 3 refused by policy; 4 service unavailable.

`atrium-ctl` runs as the human's `shell` principal (it is a CLI started from the trusted terminal) and holds the route `atrium#ctl`. Its `screenshot` result is written only through `Broker.powerbox(saveFile)`, never to a path it chose.

### 5.4 `atrium` service command line

```
atrium [--seat seat0] [--headless WIDTHxHEIGHT[,…]] [--config /etc/keylos/atrium.ncl]
atrium-term [--shell GENERATION-NAME]   # spawned by atrium via UserSpawn (actorKind shell)
```

The service is started by `warden` from the service manifest; it has no other entry points.

### 5.5 Files

| Path | Content |
|---|---|
| `/etc/keylos/atrium.ncl` | System config (config generation) |
| `~/.apps/io.keylos.atrium/config/settings.ncl` | User settings (data) |
| `~/.apps/io.keylos.atrium/state/outputs.cbor` | Per-EDID output layouts |
| `/run/keylos/atrium/c/<n>` | Per-principal client sockets |
| `/run/keylos/atrium/pw` | PipeWire connection socket for route `pipewire#portals` (atrium is a registered holder, `protocols §19.2`) |
| `/var/lib/keylos/atrium/phrase/<user>.cbor` | Security phrase and image per user (§4.6.3); mode 0600; atrium only |

### 5.6 Repo-local Wayland protocol `atrium_trusted_v1`

A Wayland protocol (XML in `protocol/atrium-trusted-v1.xml`) advertised only to the `trusted` class. It is not a capwire interface and no other repository consumes it.

| Request / event | Direction | Meaning |
|---|---|---|
| `launcher_index(fd)` | client → atrium | A sealed memfd with the launcher index (JCS JSON array of `{name, generation, summary, publisher, entrypoints, l10n}`), §4.5.1 |
| `launch(generation, entrypoint, argv)` | client → atrium | Ask atrium to spawn an app for the human (`UserSpawn`); atrium checks the generation is in its current index |
| `terminal_tab(surface, session)` | client → atrium | Associates a terminal tab surface with the shell session running in it (label banner, §4.8) |
| `captures` | atrium → client | Current screencast and indicator list for the security centre |
| `focus_info(surface)` | atrium → client | Principal and tier of the focused toplevel, for the panel |

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| App draws a fake approval dialog | Apps cannot cover the keystrip; real prompts extend the keystrip, show the personal security phrase and image, and survive SAK (§4.6.3) |
| App keylogs or injects input into other apps | Input only to the focused surface; no virtual input protocols for normal classes; IME output only to the focused text input |
| App screenshots other apps | No screencopy or data-control globals; screencast only via the trusted picker and portal; trusted surfaces never captured |
| Clickjacking an approval | Enable delay, fresh input requirement, Deny focused by default, overlay dims and blocks other input |
| Clipboard sniffing | Focus-bound reads within the input window; labels raised on transfer; no clipboard managers for normal classes |
| Pastejacking into the terminal | Paste preview for untrusted or control-character content (REQ-ATRIUM-042) |
| Terminal escape abuse | OSC 52 ignored; reports disabled; titles only as secondary text |
| Malicious images or markdown in prompts | Decoded in the strictly confined `atrium-decode`; compositor never parses them |
| Malicious client protocol messages | Smithay protocol parsing in Rust; per-client resource limits (max 10,000 objects, 256 MiB of SHM pools, 64 pending frame callbacks); clients exceeding them are disconnected |
| GPU driver attack via client buffers | Only DMA-BUF import of validated formats and modifiers; untrusted apps run in t2 VMs (native context) |
| Wrong identity in frames | Names come from verified manifests via `Supervisor.identify` → `Depot.get` and the trusted launcher index, never from client data |
| Stolen approver key | The approver key exists only in atrium's memory for one boot and signs only non-presence mandates; presence-class decisions always need a FIDO2 touch (`protocols §14.3`) |
| Phone-routed approval abused | Only drafts the broker marks `channel: "phone"` are routed; never presence-class; the local prompt stays visible and the first decision wins (REQ-ATRIUM-018) |
| Prompt flooding | Per-principal prompt rate limit (5 per minute; the broker is expected to batch); excess prompts are auto-denied with a receipt via the broker |
| BadUSB keystroke injection | New USB devices stay unauthorized until a trusted-path decision made with an already-authorized input device (REQ-ATRIUM-071); descriptor strings are shown as untrusted text |
| Malicious media filesystem | atrium never mounts or parses removable media; media VMs do (REQ-ATRIUM-073) |
| Agent drives the human's real desktop | Agents get no observer, screencast stream (except a single still per T3 grant) or input path to the real session; agent-desktop mirrors receive no input until take-over (REQ-ATRIUM-090, -092) |
| Screen reader used as a spyware channel | Observers only for owner-listed assistive generations, never for agents, with password fields and trusted surfaces filtered (REQ-ATRIUM-061, -062) |
| Captive-portal page phishing the user | The sign-in page runs in a disposable VM with a distinct frame; nothing can be dragged or pasted out of it (§4.20) |
| App keeps the screen unlocked forever | Inhibitions block idle locking only, are listed in the keystrip and expire (§4.21) |
| Kiosk escape | Panel, launcher and shortcuts disabled; leaving kiosk mode needs an owner login on the trusted path (REQ-ATRIUM-082) |

### 6.2 Confinement of atrium

- **Tier** t0 service, dynamic UID, sealed generation.
- **Privileges:** DRM master on the seat's cards (fds via devd); no Linux capabilities. Input devices only as passed fds; `EVIOCGRAB` is not used, since atrium is the sole reader by Landlock and devd policy.
- **seccomp allowances** beyond baseline:
  - `ioctl` on DRM fds (`DRM_IOCTL_*` mode-setting and GEM/PRIME subset as listed in the service profile file `seccomp/atrium.toml`);
  - evdev ioctls (`EVIOCG*`);
  - `memfd_create`, `memfd_secret` (presence payload buffers);
  - `eventfd2`, `timerfd_*`, `signalfd4`;
  - `sched_setattr` for the render thread (SCHED_RR priority 2, for the KMS commit thread only).
- **Landlock:** read/write `/run/keylos/atrium/` and `/var/lib/keylos/atrium/`; read its own generation; write `~/.apps/io.keylos.atrium/*` of logged-in users through fds passed by `warden` at session start; nothing else.
- **Network:** none.
- **Child processes:** `atrium-decode` via `Supervisor.spawn` on route `warden#service`. Trusted shell clients and apps via `UserSpawn.spawnForHuman` on route `warden#launcher`.
- **Code integrity:** atrium and every trusted shell client are sealed distro generations; `kl-exec` (`protocols §9.3`) applies to them like any other host principal. atrium has no JIT (`needs.jit: false`), so `PR_SET_MDWE` is set.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| GPU reset or driver hang | Smithay context loss detection, renderer recreation, full damage. Clients keep their buffers. Trusted surfaces are re-rendered first |
| `hearth` unavailable | Greeter shows "Authentication service unavailable", with retry; no bypass |
| `broker` unavailable | Clipboard transfers that need a label raise are refused; prompts cannot arrive anyway. On broker restart atrium registers a fresh approver key |
| `vouch` unavailable | Phone routing is skipped; prompts stay local |
| `atrium-decode` crash or timeout | Decorative rendering: "Preview unavailable", Approve unaffected. Required rendering: the canonical-text fallback is shown if the prompt carries one for the same `payloadDigest`; otherwise Approve stays disabled and only Deny and Defer are offered (REQ-ATRIUM-019b/019c). A non-empty `title` never re-enables Approve |
| Unsupported MIME type, missing attachment, malformed or truncated required rendering, or an effect of `mandateDraft` with no bound required rendering | Same as a failed required rendering (REQ-ATRIUM-019c) |
| PipeWire down | Screencast, camera and microphone indicators show unavailable; `Screencast.start` fails with `kl:unavailable` |
| Output hotplug during a prompt | The prompt moves to the primary output; the enable delay restarts |
| Client exceeds resource limits | Disconnect; notification "<app> was disconnected for misbehaving" |
| `devd` unavailable | No device cards; new devices stay unauthorized (fail closed); keystrip shows "Device service unavailable" |
| `bench` unavailable or VM cap reached (`kl:unavailable`, `protocols §2.3`) | Media chip shows "Cannot open: too many VMs running" with Retry; captive sign-in shows the same; nothing falls back to host mounting |
| `portal-a11y` restart | All observers are revoked; screen readers reconnect through the portal |
| Kiosk app crash loop | "Out of service" screen after 5 restarts per minute; owner login still available |

---

## 8. Performance budgets

Reference hardware: Intel Iris Xe or AMD Radeon 780M integrated GPU, 2560×1600 at 60 Hz and 3840×2160 at 60 Hz.

| Metric | Budget |
|---|---|
| Composite frame time, typical desktop (10 windows), p99 | ≤ 4 ms |
| Input-to-photon added by atrium (pointer move, direct scanout off) | ≤ 1 frame + 2 ms |
| Prompt appearance after `approve` call (no decode) | ≤ 100 ms |
| Prompt with 1 MiB diff (decode + layout) | ≤ 400 ms |
| Lock on SAK or command | ≤ 150 ms to the lock surface on all outputs |
| Service start to greeter visible | ≤ 1.5 s |
| Resident memory, compositor, 1 user with 10 windows | ≤ 200 MiB |
| `atrium-term` keystroke-to-glyph | ≤ 6 ms p99 |
| Screencast start after user pick | ≤ 300 ms to first frame |
| Device card shown after `PendingDevice` arrives | ≤ 150 ms |
| `ClipboardHost.source` answer | ≤ 2 ms p99 |
| `A11yGate.observer` until first `tree` reply (1,000-node desktop) | ≤ 50 ms |

---

## 9. Observability

- **Logs** (journal): client admission (principal, class), protocol violations, resource-limit disconnects, GPU resets, prompt lifecycle (id, tier, principal, outcome, latency; **never** prompt content), lock and unlock.
- **Receipts:** atrium writes none in the protocols registry. Prompt outcomes are recorded by the broker (`approval.decide`), presence by hearth (`presence.assert`), captures by `portal-screen` (it records `device.grant`-style receipts through the broker; see the portals spec).
- **Metrics:**
  - `atrium_frame_time_seconds{output}` (histogram)
  - `atrium_clients{class}`
  - `atrium_prompts_total{tier,outcome}`
  - `atrium_prompt_latency_seconds`
  - `atrium_protocol_errors_total{global}`
  - `atrium_captures_active`
  - `atrium_gpu_resets_total`
  - `atrium_device_cards_total{bus,outcome}`
  - `atrium_inhibitions_active{kind}`
  - `atrium_a11y_observers_active`

---

## 10. Configuration

System config contract (`/etc/keylos/atrium.ncl`, part of the config generation):

```nickel
{
  AtriumConfig = {
    sak | { keys | String | default = "Ctrl+Alt+Delete", tablet_power_button | Bool | default = true },
    prompts = {
      enable_delay_ms | Number | default = 750,
      max_per_minute_per_principal | Number | default = 5,
      default_focus | [| 'deny |] | default = 'deny,
      phone_after_idle_secs | Number | default = 120,       # REQ-ATRIUM-018
    },
    lock = {
      idle_secs | Number | default = 300,
      on_lid_close | Bool | default = true,
      on_suspend | Bool | default = true,
    },
    clipboard = {
      read_window_ms | Number | default = 1000,
      history_entries | Number | default = 20,
    },
    classes = {
      trusted_generations | Array String | default = ["io.keylos.atrium.shell", "io.keylos.atrium.term", "io.keylos.portals.ui"],
      assistive_generations | Array String | default = [],     # owner adds screen readers here (presence-signed config)
      ime_generations | Array String | default = [],           # owner adds input-method engines here
    },
    frames = {
      colors | { t1 | String, t2 | String, legacy | String, workbench | String, trusted | String }
        | default = { t1 = "#64748b", t2 = "#2563eb", legacy = "#d97706", workbench = "#7c3aed", trusted = "#16a34a" },
    },
    tearing_allowed | Bool | default = true,
    vrr | [| 'off, 'fullscreen, 'always |] | default = 'fullscreen,
    terminal = {
      shell_generation | String | default = "io.keylos.kish",
      shell_generations | Array String | default = ["io.keylos.kish", "io.keylos.legacy.bash"],   # allowed for TrustedSpawn
    },
    a11y = { enabled | Bool | default = false },
    greeter = { guest_button | Bool | default = false },
    kiosk = {
      app | String | optional,              # generation name; required on the kiosk profile
      entrypoint | String | default = "main",
      user | String | default = "kiosk",
    },
    inhibit = { idle_max_secs | Number | default = 14400 },
    devices = {
      port_names | { _ : String } | default = {},      # physical port path -> human name shown on device cards
      remember_default | Bool | default = false,       # initial state of "Allow and remember"
    },
  },
}
```

User settings (`settings.ncl`, data): wallpaper (a file grant token reference), theme, keyboard layouts, pointer settings, per-output layout, night light, magnifier, notification do-not-disturb rules.

---

## 11. Testing and acceptance criteria

### 11.1 Unit tests

- Protocol allowlist table (§4.4) as data, tested against every class.
- Frame text derivation (manifest name vs title).
- Prompt queue ordering and expiry.
- Focus-bound clipboard timing.
- Escape filtering in atrium-term (OSC 52, 1337, DECRQSS).

### 11.2 Integration tests (headless backend + test clients)

1. A t1 client binding `zwlr_data_control_manager_v1` or `ext_image_copy_capture` fails: the global is not advertised.
2. A client positioning a surface over y < 28 gets a configure clamping it; screenshot comparison shows the keystrip intact.
3. A fullscreen client still has the keystrip and the SAK works.
4. Peer check: a process from principal B connecting to A's socket is disconnected.
5. A clipboard read without a preceding input event within 1 s yields no data.
6. Label raise on paste is called on the broker test double; a refusal blocks the transfer.
7. Prompt enable delay: a synthetic click at 500 ms does nothing; at 800 ms after a fresh press, it approves.
8. A presence prompt returns the hearth test double's envelope byte-identical.
9. Lock denies pending prompts and stops a screencast (PipeWire test node gets EOS).
10. After an atrium restart, the seat is locked.
11. Xwayland: two legacy principals' X clients cannot see each other's windows (`xwininfo -root -tree` from each).
12. atrium-term: `printf '\e]52;c;aGk=\a'` does not change the clipboard.
13. A non-presence approval returns a mandate whose DSSE signature verifies with the key passed to the `BrokerSystem.registerApprover` test double; after an atrium restart a new key is registered.
14. A presence request with purpose `config.apply` and a payload whose `schema` is `keylos.seal-window/1` is refused with `kl:invalid` and nothing is shown.
15. A t1 client whose generation is in `trusted_generations` but whose parent session is an ordinary app gets class `t1`, not `trusted`.
16. A prompt whose draft `channel` is `phone`, with the seat locked: the vouch test double receives `routeApproval`; its decision resolves the prompt and cancels the local card.
17. `TrustedSpawn.spawnTerminal` is called only with generations from `terminal.shell_generations`; another generation is refused before any warden call.
18. Drag of a granted file into another app calls `FilePicker.confirmDrop` with the source's tokens; the target never receives the source's fd.
19. `A11yGate.observer` for a consumer outside `assistive_generations`, or with actor kind `agent`, fails with `kl:denied`; for an allowed consumer, a password field's value appears as `•` runs and no trusted-surface node appears.
20. `ClipboardHost.source` with a current offer ID returns the recorded label; with an unknown ID `kl:not-found`; the offer-ID MIME type is not offered to a `t1` client.
21. `InhibitHost.inhibit(["idle"])` keeps the idle timer from locking; SAK still locks; cancelling the handle restores the timer.
22. Device cards: a pending device with `hidSafety = "keyboard-like"` cannot be allowed with input from the test double's pending device; allowed from an authorized keyboard, atrium calls `BrokerSystem.requestFor` for its own session with resource `device` and `onBehalfOf` = the human, and `DeviceAdmin.authorize` receives exactly the `GrantResult.mandate` of the broker test double (signed by `service/broker`, binding the JCS digest of the `PendingDevice`); atrium's approver key never signs a device decision that reaches devd; the call carries `decidedOnTrustedPath = true` and the broker test double sends no `TrustedPrompt.approve` back to atrium (no second card, no auto-answer).
23. Block leaves `DeviceAdmin.authorize` uncalled; "Allow and remember" passes `persist = true`.
24. A mass-storage device after authorization: `Bench.media` is called; atrium never calls `MediaBrowser.list` or `open`; Eject calls `eject`.
24a. Dropping a file on the media chip stages a `media.export` intent on the gate test double with the file's bytes as payload; `MediaBrowser.export` is called only after `Intent.commit`, with the mandate from `IntentStatus.result`; a denied intent leaves `export` uncalled.
25. Agent-desktop mirror: keyboard and pointer events are not delivered to the window while read-only; a paste into it is refused.
25a. "Take over" calls `AgentSession.takeOver(true)` on the aide test double; input stays blocked until the display state reports `interactive`; "Hand back" calls `takeOver(false)`; another human's agent session shows no Take over control.
26. A screencast request from an agent consumer offers only windows, delivers one frame and stops.
27. Captive: a `NetWatch` captive event shows the notification; accepting calls `NetCaptive.signIn` on the net test double; atrium never calls `Bench.start` with purpose `captive`; the window delivered for a captive VM gets the "Network sign-in (disposable)" frame; closing it calls `NetCaptive.endSignIn` exactly once.
28. Kiosk profile: the app is spawned fullscreen, the panel is absent, SAK offers only Lock and Owner login.
29. Guest session: a presence request for the guest's human is refused; the keystrip shows "Guest".
30. Family: a prompt with `requester` set is shown only in an owner session, with the requester line.
31. Presence with a `rendering` list shows each effect with its digest prefix; the digest equals SHA-256 of the effect body.
32. Keystrip integrity: report fixtures for each integrity profile produce the specified colour and text.
33. Localised name: a `l10n` file whose name is confusable with another installed app's name is replaced by the manifest-derived name with a warning.
34. Assisted presence: for an owner whose credential fixture is assisted, the presence card shows a PIN field and a confirm action; `Hearth.presence` receives `assist` with the JCS shape of REQ-ATRIUM-094; for a roaming credential `assist` is empty.
35. Launcher: a non-reproducible native app generation is started with `Bench.start` purpose `app` on the bench test double; a reproducible one with `UserSpawn.spawnForHuman`.
36. Screencast nodes are created over the `pipewire#portals` route; no other PipeWire socket is opened (strace on the test instance).
37. Rendering fail-closed: for a prompt with one required `image/png` rendering, kill `atrium-decode` mid-job, then make it time out: Approve stays disabled (synthetic presses after 1 s, 5 s do nothing), only Deny/Defer work; the broker test double never receives an approved `Decision`.
38. Same prompt with an additional required `text/plain` canonical rendering bound to the same `payloadDigest`: after the decoder failure the text is shown and Approve enables after the delay; with a different `payloadDigest` it does not.
39. Unsupported MIME type, missing attachment fd, a body cut at the paging limit, malformed markdown that the decoder rejects, and a `mandateDraft` effect without any bound required rendering: Approve disabled in every case; a decorative rendering failing alone does not disable it; a `decorative` mark on a presence-card rendering from `config` is treated as required.
40. Presence card with a required rendering that fails to decode: the confirm action is disabled and `Hearth.presence` is never called. Defer leaves the `approve` call pending; it resolves `approved = false` at `expires`.
41. Cross-channel: the same prompt routed to the vouch test double that answers "cannot present"; the local card behaves per REQ-ATRIUM-019b and the phone decision never arrives; a phone decision for a prompt whose required renderings exceed the phone limits is never requested.
42. Safe start: with the boot-report fixture `x-safeStart: true`, no previous windows are restored, `portal-background` receives "skip autostart", the keystrip shows "Safe start", and quarantined units appear in the security centre; Release calls the strata test double.
43. `TrustedPrompt.secret` with `confirm = true`: mismatched entries are refused; the returned fd has the §20.10 layout; a paste into the field is refused; a caller on any facet other than `secret` gets `kl:denied`.
44. `Display.windowOwner("window:<id>")` on facet `broker` returns the admitted principal and generation name even when the client set a spoofed title and app ID; on facet `display` it fails `kl:denied`; a closed window gives `kl:not-found`.
45. Assisted presence: the `assist` JCS carries `promptId` = SHA-256 of the PAE of the payload; a hearth test double recomputing it rejects a card shown for a different payload.

### 11.3 Fuzzing

- Wayland message parsing (Smithay plus atrium handlers) with a protocol-aware fuzzer driving a headless instance.
- `atrium-decode` inputs (PNG, JPEG, WebP, SVG, markdown, diff).
- `a11y.capnp` update streams.

### 11.4 Acceptance

Every REQ-ATRIUM requirement has a passing test in `tests/traceability.toml`. §8 budgets are met on both reference GPUs. A manual review checklist (spoofing, capture, clipboard, terminal) is signed off per release.

---

## 12. Implementation notes

### 12.1 Crates

| Crate | Use |
|---|---|
| `smithay` (pinned git revision recorded in `Cargo.lock`) | Compositor framework: DRM, GBM, EGL, GLES renderer, libinput, xwayland, wayland protocols |
| `wayland-server`, `wayland-protocols` 0.31/0.32 | Via smithay |
| `calloop` | Event loop (via smithay) |
| `xkbcommon` | Keymaps |
| `egui`, `egui_glow`, `accesskit` | Trusted UI rendering and accessibility trees |
| `alacritty_terminal` | VT emulation in atrium-term |
| `pipewire` 0.8 | Screencast nodes and permissions |
| `pulldown-cmark` | Markdown (in atrium-decode only) |
| `image`, `resvg` | Decoding (in atrium-decode only) |
| `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-presence` 1.0.0 | Contracts, capwire, schema bindings (display, a11y, screencast, prompt), presence envelope checks |
| `ed25519-dalek` 2 | Approver key (REQ-ATRIUM-017) |
| `tokio` 1 | Capwire servers |

### 12.2 Repository layout

```
crates/atrium/            compositor binary
crates/atrium-core/       state, focus, classes, frames, keystrip, clipboard, prompt queue
crates/atrium-render/     renderer integration, damage, screencast export
crates/atrium-trusted/    trusted UI (egui) surfaces: prompts, greeter, lock, overview, centres
crates/atrium-term/       trusted terminal
crates/atrium-shell/      panel, launcher, settings
crates/atrium-decode/     sandboxed decoder
crates/atrium-a11y/       aggregator + bridge
crates/atrium-ctl/
protocol/                 atrium-trusted-v1.xml (repo-local Wayland protocol, §5.6)
seccomp/                  per-binary profiles
config/atrium.ncl
tests/ fuzz/ pkg/
```

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reason | ADR |
|---|---|---|---|
| Wayland only, Smithay-based compositor | Extend an existing compositor (wlroots-based) | Rust TCB, protocol allowlist and trusted path need deep integration | [ADR-0034](../../handbook/11-decisions/adr-0034-wayland-only-trusted-path.md) |
| Trusted surfaces in-process | Trusted surfaces as privileged clients | A client can be impersonated, delayed or crashed; in-process rendering keeps the trusted path within one component | [ADR-0034](../../handbook/11-decisions/adr-0034-wayland-only-trusted-path.md) |
| Per-principal sockets with peer check | One shared socket plus security-context only | Socket-level binding plus pidfd verification makes identity unforgeable even if a socket leaks | [ADR-0024](../../handbook/11-decisions/adr-0024-dynamic-uids-per-principal.md) |
| Per-app Xwayland | One shared Xwayland | A shared X server lets every X client snoop the others | [ADR-0037](../../handbook/11-decisions/adr-0037-legacy-tier-fhs-views.md) |
| Clipboard proxied with labels | Direct fd passing between clients | Labels and the Rule of Two need a mediator; direct fds also leak timing and identity | [ADR-0026](../../handbook/11-decisions/adr-0026-labels-and-rule-of-two.md) |
| Portal-only capture | Allow screencopy for "trusted" apps | Every exception becomes the attack path; the picker makes intent explicit | [ADR-0035](../../handbook/11-decisions/adr-0035-fd-only-portals-dbus-islands.md) |
| Personal security phrase and image | No anti-spoof secret | A cheap, well-understood defence against pixel-perfect fakes when combined with the keystrip | [ADR-0028](../../handbook/11-decisions/adr-0028-approval-tiers.md) |
| Approval fails closed when required review material cannot be presented; canonical-text fallback only when it presents every required detail (protocols E33, ISSUES ISS-006) | Allow Approve on a non-empty title after a decoder failure | A title does not establish content, destination, amount or authority | [ADR-0028](../../handbook/11-decisions/adr-0028-approval-tiers.md) |
| Safe start without session restore or autostart, with quarantined app data (protocols E35, ISSUES ISS-008) | Automatic reopening after every reboot | Reboot restores code and configuration, not the trustworthiness of writable state | — |

### 13.1 Dependencies and open protocol gaps

atrium uses only interfaces, facets and formats of keylos-protocols 1.0.0 (final). The earlier gaps (take-over from the trusted UI, assisted presence input, PipeWire access, device-decision signatures, guest and kiosk login methods, captive VM start) are resolved by protocols 1.0.0 (final): `AgentSession.takeOver`, `Hearth.presence(…, assist)`, `pipewire#portals` holder atrium, broker-delivered device mandates through `requestFor`, the registered login methods, `NetCaptive.signIn`/`endSignIn` and `requestFor(…, decidedOnTrustedPath)`. The S2 feedback pass added `TrustedPrompt.secret` (E19), `Display.windowOwner` (E21), the assist prompt ID (E12) and the required/decorative rendering contract `RenderedEffect.review`/`payloadDigest` (E33). No open protocol gaps remain.

Facts atrium relies on from other components:
- `warden` calls `Display.clientSocket` for GUI spawns and honours `TrustedSpawn` and `UserSpawn` as in `protocols §7.5.1`.
- `devd` flags virtual input devices with the device property `virtual=1`, which excludes them from SAK detection.

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

### A.2 `protocols §5.3` — Presence signatures

A FIDO2 authenticator cannot sign arbitrary bytes: it signs `authenticatorData ‖ clientDataHash`. A presence signature over a DSSE payload is constructed as follows:

```
pae := DSSE-PAE(payloadType, payload)
cdh := SHA-256(pae)
assertion := CTAP2 authenticatorGetAssertion(rpId = "keylos.owner", clientDataHash = cdh,
                                              allowList = enrolled credentials, options = {up: true, uv: per purpose})
sigObj := {"keyid": "key:sha256:<SPKI of credential>", "alg": "fido2-es256" | "fido2-eddsa",
           "sig": base64(CBOR{1: authenticatorData, 2: signature, 3: credentialId})}
```

Verification (crate `keylos-presence`; every verifier MUST use it or an equivalent conforming implementation):
1. Check the payload is JCS-canonical and its `schema` matches the expected purpose (§20.2).
2. Decode the CBOR map. Check `authenticatorData.rpIdHash == SHA-256("keylos.owner")`.
3. Check the UP flag is set, and the UV flag when the purpose requires it.
4. Look up the credential by `keyid` in the **owner registry** (§20.3) state current at the payload's `time`. The credential MUST NOT have been removed before that time.
5. Verify `signature` over `authenticatorData ‖ cdh` with the credential's COSE key.

Stateful verifiers (`hearth`) SHOULD track `signCount`. Stateless verifiers (`boot`) skip it.

Login assertions (screen unlock, greeter) use the separate rpId `keylos.login` and are never accepted as presence signatures; presence always uses `keylos.owner`.

The FIDO2 `hmac-secret` extension is used only by `hearth` for the seal gate (§11.6). Its outputs never leave `hearth`.

**Accepted authenticators.** Any FIDO2 authenticator with user verification counts, roaming or platform. `hearth` includes a TPM-backed platform authenticator for owners who cannot operate a roaming key: user presence is a confirmation on the trusted path (a pointer, keyboard or switch-access action inside the atrium-drawn prompt), user verification is the owner's PIN entered there. Such a credential is enrolled with `"assisted": true` in its owner-registry entry (§20.3); `status`, the `vouch` verdict and every presence prompt show it. The platform authenticator's TPM signing key and its `hmac-secret` key are created under the SRK `0x81000001` with `userWithAuth` **clear** and authPolicy `PolicyPCR(sha256:{15}) ∧ PolicyAuthValue`, whose authValue `hearth` derives from the owner's PIN; PCR15 alone never authorizes a signature. Their blob `/var/lib/keylos/hearth/platform/<keyid>.blob` (§10.7) is the JCS object `{"rpId", "credentialId", "cose", "salt", "key", "hmacKey"}`, binary members in standard base64, `key` and `hmacKey` each `TPM2B_PRIVATE ‖ TPM2B_PUBLIC`. Policy MAY forbid assisted credentials for specific purposes (`config.presence.assistedAllowed`, default: allowed for every purpose).

### A.3 `protocols §6.3` — Manifest schema (`keylos.manifest/1`)

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

### A.4 `protocols §7.1` — Model

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

### A.5 `protocols §7.2` — Routes and facets

`warden` wires services according to **routes** declared in service and app manifests plus policy.

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

- A **facet** is a server-defined restriction name. The registry of every facet, its holders and the methods it allows is §19.2. Servers MUST refuse methods their facet doesn't allow with `kl:denied`.
- Route references are written `service#facet` (for example `vault#app`).
- The server learns the facet of each connection from `ServiceHost.accept` (§7.5.1) or `Supervisor.connectionInfo`.
- Service sockets live under `/run/keylos/svc/<service>/` with mode `0700`, owned by `warden`'s UID. No other principal can `connect()` to them. Connections are created by `warden` (`socketpair` + hand-off through `ServiceHost.accept`).
- Dynamic routes (a service capability granted at runtime) are materialised by `broker` through `ServiceConnect.connectService` (§7.5.1).

### A.6 `protocols §7.3.1` — `common.capnp`

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

### A.7 `protocols §7.3.2` — `warden.capnp`

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

### A.8 `protocols §7.3.3` — `broker.capnp`

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

### A.9 `protocols §7.3.4` — `prompt.capnp` (trusted path; implemented by `atrium`, used by `broker`, `hearth`, `vault`, `config`, `depot`, `fleet`, `vouch`)

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

### A.10 `protocols §7.3.5` — `ledger.capnp`

```capnp
@0xc7a1e5d3b2f40005;
using C = import "common.capnp";

struct ReceiptRef { seq @0 :UInt64; digest @1 :C.Digest; }

struct Checkpoint { note @0 :Text; }   #! C2SP signed-note checkpoint text, protocols §13.3

struct Filter {
  principalPrefix @0 :Text;
  sessionId  @1 :Text;
  eventTypes @2 :List(Text);
  since      @3 :C.Timestamp;
  until      @4 :C.Timestamp;
  limit      @5 :UInt32;
  fromSeq    @6 :UInt64;          # 0 = from the start; only receipts with seq ≥ fromSeq (continuation: fromSeq = query's next)
}

interface Ledger {
  append     @0 (envelope :Data) -> (ref :ReceiptRef);     #! facet "writer" only
  get        @1 (seq :UInt64) -> (envelope :Data);
  query      @2 (filter :Filter) -> (envelopes :List(Data), next :UInt64);
  checkpoint @3 () -> (checkpoint :Checkpoint);
  prove      @4 (seq :UInt64, treeSize :UInt64) -> (hashes :List(Data));   # RFC 6962 inclusion proof
  consistency @5 (from :UInt64, to :UInt64) -> (hashes :List(Data));
  watch      @6 (filter :Filter, watcher :C.Watcher(Data)) -> (cancel :C.Cancelable);
  serviceKey @7 (service :Text) -> (spki :Data, keyRef :Text, registered :C.Timestamp);
      #! facet reader: the currently registered key of service/<service> (from ledger.key.register); kl:not-found if none.
      #! Relying services use it to verify service-signed records, e.g. non-presence mandates signed by service/broker (§14.4)
}
```

**Read access** (facet `reader`; `writer` includes it): a principal sees receipts whose `subject` or `writer` is itself or a descendant session; a `shell` principal sees every receipt whose subject's human is its human; agent principals see only their own session chain; tier-0 services see receipts per their facet entry in §19.2, and every writer service sees every receipt whose `writer` actor is its own service name under any session and generation (`service:<name>:…`, also from earlier boots), so it can reconcile its own submissions (§20.25); `fleet` (facet `fleet-export`) sees metadata only, unless an owner exception of kind `fleet-receipt-access` (§20.9) lists the event type. Sealed payloads (§13.4) are decrypted for a reader only if the reader may read the receipt **and** the unit key still exists; receipts of crypto-shredded units are returned redacted (`keylos.receipt-redacted/1`). The returned form of a decrypted sealed receipt is defined in §13.4. `query` returns matching visible receipts in increasing `seq`, at most `limit`; `next` is the `seq` of the first matching visible receipt that was not returned (0 = none), and a client continues with the same filter and `fromSeq = next`. `watch` ignores `fromSeq`. Facet `vouch-heartbeat` (vouchd) sees only the metadata (time, subject human) of `user.login` receipts of every human, for the inheritance dead-man timer (§20.19).

### A.11 `protocols §7.3.8` — `depot.capnp`

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

### A.12 `protocols §7.3.9` — `courier.capnp`

```capnp
@0xc7a1e5d3b2f40009;
using C = import "common.capnp";

struct UpdateInfo {
  stream   @0 :Text;
  current  @1 :C.Ref;
  available @2 :C.Ref;
  version  @3 :Text;
  notes    @4 :Text;
  capabilityDiff @5 :Text;
  security @6 :Bool;
  rebuilderQuorum @7 :Text;   # e.g. "3/3"
}

interface Courier {
  check    @0 () -> (updates :List(UpdateInfo));
  stage    @1 (target :C.Ref) -> ();          # download, verify, predict PCRs, install boot entry
  status   @2 () -> (state :Text, staged :C.Ref, bootCounter :Text);
  rollback @3 () -> ();                       # make previous generation default
  pin      @4 (ref :C.Ref) -> ();             # keep this generation bootable
}
```

### A.13 `protocols §7.3.11` — `config.capnp`

```capnp
@0xc7a1e5d3b2f40011;
using C = import "common.capnp";

interface Plan {
  diff    @0 () -> (rendered :Text);               # human-readable effect rendering
  files   @1 () -> (changes :List(Text));
  restarts @2 () -> (services :List(Text));
  capabilityChanges @3 () -> (rendered :Text);
  apply   @4 () -> (generation :C.Ref);            # requires owner-presence via TrustedPrompt
}

interface Config {
  propose  @0 (source :C.Fd, origin :C.PrincipalId) -> (plan :Plan);   # source: dirfd of config repo checkout
  current  @1 () -> (generation :C.Ref, sourceRev :Text);
  history  @2 (limit :UInt32) -> (list :List(C.Ref));
  revert   @3 (generation :C.Ref) -> (plan :Plan);
  adopt    @4 (appName :Text) -> (patch :Text);     # diff from mutable app layer to declaration
  drift    @5 () -> (report :Text);
}
```

### A.14 `protocols §7.3.12` — `hearth.capnp`

```capnp
@0xc7a1e5d3b2f40012;
using C = import "common.capnp";

struct UserInfo { name @0 :Text; displayName @1 :Text; uid @2 :UInt32; owner @3 :Bool; locked @4 :Bool; }

interface Hearth {
  users     @0 () -> (list :List(UserInfo));
  login     @1 (user :Text, method :Text, response :Data) -> (session :C.SessionId);   # facet greeter
      #! methods: "password", "pin", "fido2"; "guest" (user and response empty: creates an ephemeral guest-… user and
      #! session, §3.3, §14.3); "kiosk" (kiosk profile only: autologin of the configured kiosk user, response empty)
  lock      @2 (session :C.SessionId) -> ();
  unlock    @3 (session :C.SessionId, method :Text, response :Data) -> ();
  presence  @4 (purpose :Text, payload :Data, assist :Data) -> (envelope :Data);   # FIDO2 assertion → DSSE presence envelope (§5.3)
      #! assist (facet atrium only): PIN or switch-access confirmation collected on the trusted path for an assisted
      #! platform authenticator (§5.3); empty for roaming authenticators and on every other facet
  enrollKey @5 (user :Text, kind :Text) -> (keyRef :Text);           # requires presence of an existing owner credential
  removeKey @6 (keyRef :Text) -> ();
}
```

- **Assisted presence.** The prompt id that binds an `assist` confirmation to its request is `sha256:<hex>` of the DSSE PAE of `payload`; atrium and hearth compute it independently.
- **`enrollKey`** of a kind that adds a vault slot (`fido2` login keys) requires the target user's vault key to be unlocked (`VaultUsers.addSlot`, §7.5.4) and fails `kl:unavailable:user-locked` until that user has logged in.

### A.15 `protocols §7.3.14` — `aide.capnp`

```capnp
@0xc7a1e5d3b2f40014;
using C = import "common.capnp";

struct AgentEvent {
  time    @0 :C.Timestamp;
  session @1 :C.SessionId;
  union {
    message   @2 :Text;            # agent → human text
    toolCall  @3 :Text;            # JSON {tool, args}
    toolResult @4 :Text;
    approval  @5 :Text;            # approval id pending
    effect    @6 :Text;            # intent id
    label     @7 :C.Label;
    budget    @8 :Text;
    finished  @9 :Text;
    rich      @10 :Text;           # JCS JSON {"type": "state"|"question"|"breaker"|"mcpPinMismatch"|"discrepancy"|"grant"|"modelChange"|"desktop", …}
  }
}

interface AgentSession {
  id       @0 () -> (id :C.SessionId);
  send     @1 (text :Text) -> ();                      # human → agent
  events   @2 (watcher :C.Watcher(AgentEvent)) -> (cancel :C.Cancelable);
  changes  @3 () -> (summary :Text);
  review   @4 () -> (prompt :Text);                    # stages fs.merge intents; opens T3 review on trusted path
  stop     @5 () -> ();
  fork     @6 () -> (session :AgentSession);
  takeOver @7 (interactive :Bool) -> ();             # human: switch the agent-desktop mirror (relayed to Vm.takeOver)
  attempt  @8 () -> (binding :C.AttemptBinding);     # the workflow attempt this session executes (§20.25); epoch 0 if none
}

struct SessionSpec {
  template  @0 :C.Ref;               # agent-template generation
  task      @1 :Text;
  grants    @2 :List(C.Token);       # attenuated from the human's authority
  project   @3 :C.Fd;                # optional project dirfd
  budget    @4 :List(Text);          # e.g. "usd-micro:5000000"
  deadlineSecs @5 :UInt32;
}

interface Aide {
  start    @0 (spec :SessionSpec) -> (session :AgentSession);
  sessions @1 () -> (list :List(C.SessionId));
  attach   @2 (id :C.SessionId) -> (session :AgentSession);
}

interface AgentHost {                 # served by aide to the harness inside the workbench (vsock port 7002)
  tools     @0 () -> (json :Text);     # pinned tool definitions
  callTool  @1 (name :Text, argsJson :Text, provenanceJson :Text) -> (resultJson :Text, label :C.Label);
  model     @2 (requestJson :Text) -> (responseJson :Text);   # model API via gate (metered)
  emit      @3 (event :AgentEvent) -> ();
  requestGrant @4 (reasonJson :Text) -> (outcomeJson :Text);
}
```

### A.16 `protocols §7.3.15` — `net.capnp`, `devd.capnp`, `journal.capnp`, `portals.capnp`, `compat.capnp`

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

### A.17 `protocols §7.5.1` — `warden-sys.capnp`

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

### A.18 `protocols §7.5.2` — `broker-sys.capnp`

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

### A.19 `protocols §7.5.8` — `devd-sys.capnp`

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

### A.20 `protocols §7.5.16` — `display.capnp`

```capnp
@0xc7a1e5d3b2f4002f;
using C = import "common.capnp";
using W = import "warden.capnp";

enum ClientClass { trusted @0; t1 @1; t2 @2; legacyX @3; assistive @4; ime @5; }

interface Display {                # facets warden, bench, compat (xwaylandWm), settings (outputs)
  clientSocket @0 (principal :C.PrincipalId, tier :W.Tier, generation :C.Ref, process :W.Process)
                -> (socketDir :C.Fd, name :Text, cls :ClientClass);
      #! socketDir: O_PATH dirfd containing the listening socket `name`; the binding lives until process.wait resolves
  xwaylandWm   @1 (principal :C.PrincipalId, wm :C.Fd) -> ();
      #! facet compat only; wm = socketpair end connected to Xwayland's -wm fd
  outputs      @2 () -> (json :Text);
  windowOwner  @3 (window :Text) -> (principal :C.PrincipalId, human :Text, app :Text);
      #! facet broker only: owner of "window:<id>" (ResourceRef.screen); app = the generation name; kl:not-found if unknown
}
```

### A.21 `protocols §7.5.17` — `a11y.capnp`

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

### A.22 `protocols §7.5.18` — `screencast.capnp`

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

### A.23 `protocols §7.5.19` — `picker.capnp`

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

### A.24 `protocols §7.5.22` — `vouch-sys.capnp`

```capnp
@0xc7a1e5d3b2f40035;
using C = import "common.capnp";
using P = import "prompt.capnp";

struct Phone { id @0 :Text; label @1 :Text; platform @2 :Text; lastSeen @3 :C.Timestamp; witness @4 :Bool; approvals @5 :Bool; pending @6 :Bool; }

interface VouchLink {              # facets settings (atrium), approvals (atrium), announce (courier), witness (ledger bridge)
  phones        @0 () -> (list :List(Phone));
  pairStart     @1 () -> (qr :Text, expires :C.Timestamp);
  pairCode      @2 (words :List(Text)) -> ();
  pairWait      @3 () -> (phone :Phone);
  remove        @4 (id :Text) -> ();
  routeApproval @5 (prompt :P.ApprovalPrompt) -> (decision :P.Decision);   #! never satisfies requiresPresence (§14.3)
  announce      @6 (kind :Text, detailJson :Text) -> ();                    # "release-staged" | "firmware-pending" | "baseline-update"
  inheritance   @7 (configJson :Text) -> ();
      #! facet settings: configures the optional dead-man timer (§20.19): after N days without an owner login heartbeat,
      #! the paired phone releases the owner's encrypted inheritance note to the listed trustees. Never a key.
}
```

### A.25 `protocols §9.3` — Code integrity (host)

**Primary enforcement: the `kl-exec` BPF LSM.** `boot` loads `kl-exec` in the initrd before executing any file other than itself, and hands its maps and links to `warden` across `switch_root`. The program reads kernel structures at offsets the loader computes from the running kernel's BTF (`/sys/kernel/btf/vmlinux`) before load; a missing member fails the load.

| Hook | Decision |
|---|---|
| `bprm_check_security` | Allow if the file's superblock `s_dev` ∈ `kl_exec_allowed_sb`, or (phase INITRD and the file is on the initramfs). Else `-EACCES` |
| `bprm_creds_for_exec` with `bprm->is_check` set (`execveat(…, AT_EXECVE_CHECK)`) | Same rule as `bprm_check_security`. A check-only exec returns after this hook and never reaches `bprm_check_security`, so this row is what refuses an interpreter's check of an unregistered script. Regular execs are decided only by `bprm_check_security` (one event per denial) |
| `mmap_file` with `PROT_EXEC` | File-backed: same rule as exec. Anonymous: allow only if the task's cgroup ID ∈ `kl_exec_jit_cgroups`. Else `-EACCES` |
| `file_mprotect` adding `PROT_EXEC` | File-backed: same as exec. Anonymous or private-writable: allow only for JIT cgroups |
| `kernel_read_file` (firmware, modules, policy, X.509) | Allow if the file's sb ∈ allowed set or (phase INITRD and initramfs). kexec reads are always denied |
| `kernel_load_data` (`init_module`, firmware blobs) | Deny (modules load only via `finit_module` from verified files) |
| `bpf` (`BPF_PROG_LOAD`, `BPF_LINK_DETACH`, `BPF_PROG_DETACH`) | Allow for the `warden` core (thread-group ID recorded in `kl_exec_policy.warden_tgid` at hand-over) and for `boot` in phase INITRD. Allow for a debugger task whose cgroup has a `kl_debug_pairs` entry with scope `kernel`, for tracing program types only (kprobe, tracepoint, raw_tracepoint, perf_event), never LSM, cgroup or XDP types. Deny for every other task |
| `ptrace_access_check` | Allow only if the tracer's cgroup has an unexpired `kl_debug_pairs` entry whose target cgroup contains the tracee (or is an ancestor of it). Yama and the seccomp profile apply in addition. The hook also guards every other `ptrace_may_access` path (`/proc/<pid>/{mem,maps,environ,fd,ns/*,root,…}`, `kcmp`, `pidfd_getfd`, `setns` and `PIDFD_GET_*_NAMESPACE` on a pidfd, `process_vm_*`); no task is exempt, including the `warden` core. Checks with `PTRACE_MODE_NOAUDIT` are refused without an event |
| `perf_event_open` | Allow only for a task whose cgroup has an unexpired `kl_debug_pairs` entry (the hook sees only the `PERF_SECURITY_*` type, not the target) |
| `perf_event_alloc` (events created by a `perf_event_open(2)` call admitted above) | Scope `process`: allow only task events whose target task is in the target cgroup (or a descendant) and cgroup events on the target cgroup; CPU-wide events are refused. Scope `kernel`: allow system-wide events. Kernel-internal counters (watchdog, ptrace hardware breakpoints) are not `perf_event_open(2)` requests and are not checked |

**Map contract.** `boot` passes the map fds to `warden` as fds 3–7 in the order given by the kernel command line `keylos.execmapfds=3,4,5,6,7`:

| Map | Type | Key → value | Writer |
|---|---|---|---|
| `kl_exec_allowed_sb` | `BPF_MAP_TYPE_HASH`, 65 536 entries | `u32 s_dev` (kernel `dev_t`, below) → `u32 gen_index` | warden core only |
| `kl_exec_jit_cgroups` | `BPF_MAP_TYPE_HASH`, 4 096 entries | `u64 cgroup_id` → `u8 1` | warden core only |
| `kl_exec_policy` | `BPF_MAP_TYPE_ARRAY`, 1 entry | `u32 0` → `struct {u8 enforce; u8 audit_allow; u8 phase; u8 pad; u32 warden_tgid;}` | boot only, then frozen (`bpf_map_freeze`) after `warden_tgid` is written at hand-over |
| `kl_exec_events` | `BPF_MAP_TYPE_RINGBUF`, 1 MiB | denial events `{u64 cgroup_id; u32 pid; u32 hook; u32 s_dev; u64 ino;}` | warden core (reader) |
| `kl_debug_pairs` | `BPF_MAP_TYPE_HASH`, 256 entries | `u64 tracer_cgroup_id` → `struct {u64 target_cgroup_id; u64 expires_boottime_ns; u8 scope;}` (scope 0 = process, 1 = kernel) | warden core only (`DebugAttach`) |

Internal maps of the program (for example the LRU map that limits the `perf_event_alloc` check to `perf_event_open(2)` requests) are not handed over and are not part of this contract.

**Numeric values.** Decoders (`warden`, `journal`, tools) rely on these:
- `kl_exec_policy.phase`: INITRD = 0, SYSTEM = 1. `enforce` = 1 refuses denials; `enforce` = 0 is permissive (denials are logged and allowed; development only). `audit_allow` = 1 also logs allowed decisions.
- `kl_exec_events.hook` IDs: 1 `bprm_check_security`, 2 `mmap_file`, 3 `file_mprotect`, 4 `kernel_read_file`, 5 `kernel_load_data`, 6 `bpf`, 7 `ptrace_access_check`, 8 `perf_event_open`, 9 `bprm_creds_for_exec`, 10 `perf_event_alloc`; bit 31 set marks an audit-allow record. The C layout has 4 bytes of padding before `ino` (record size 32 bytes).
- File hooks carry the file's superblock `s_dev` and inode number (anonymous mappings: 0, 0). Other hooks reuse the two fields: `kernel_load_data` `s_dev` = the `kernel_load_data_id`; `bpf` `s_dev` = the command, `ino` = the program type for `BPF_PROG_LOAD`; `ptrace_access_check` `s_dev` = the mode, `ino` = the tracee's thread-group ID; `perf_event_open` `s_dev` = the `PERF_SECURITY_*` type; `perf_event_alloc` `s_dev` = 1 task event, 2 cgroup event, 3 CPU-wide event, `ino` = the target cgroup ID when known.
- `s_dev` everywhere is the **kernel** encoding of `super_block.s_dev` (`MKDEV`: `major << 20 | minor`), not the userspace `st_dev`/`makedev()` encoding. Registrants convert `statx`'s `stx_dev_major`/`stx_dev_minor`.

**Links.** The program's hooks are attached with `BPF_LINK_CREATE` links and live exactly as long as a link fd is open (no bpffs pins after `switch_root`). `boot` passes the ten link fds to `warden` as fds 9–18, one per hook row, in no particular order, with `keylos.execlinkfds=9,10,11,12,13,14,15,16,17,18` in `warden`'s argv (the boot report is fd 8, §20.1). The `warden` core MUST keep them open for its lifetime and never closes or passes them on; closing them detaches `kl-exec`.

**Registering a generation.** Before adding a mount's superblock to `kl_exec_allowed_sb`, the registrant (`boot` for the OS and bootstrap generations; `warden` for everything else, including mounts it makes on behalf of `bench` and `compat`) MUST:
1. obtain the tree from `depot.mount` (or mount it itself with `verity=require` from a digest-checked image, as `boot` does);
2. verify the generation statement (§20.7) DSSE signatures against the **boot trust set** (§20.1): release-stream keys for distro generations, publisher keys enabled in the config generation, and the owner-seal keys for owner-sealed generations;
3. check the generation is not listed `unlaunchable` in the current revocation list (§11.7);
4. read the superblock device with `statx(tree_fd, "", AT_EMPTY_PATH)` and convert it to the kernel `dev_t` (`stx_dev_major << 20 | stx_dev_minor`).

The decision is sound because the composefs overlay was mounted with `verity=require` from an image whose digest was checked, overlay superblocks are not shared across mounts from different images, and only `warden` can update the map. Writable mounts are always `noexec` in addition.

**Second layer: IPE.** IPE runs a policy signed by `kernel-policy/<stream>`:

```
policy_name=keylos policy_version=1.0.0
DEFAULT action=ALLOW
op=KEXEC_IMAGE action=DENY
op=KEXEC_INITRAMFS action=DENY
op=EXECUTE boot_verified=TRUE action=ALLOW
op=KERNEL_READ boot_verified=TRUE action=ALLOW
```

**Other code paths:**
- `module.sig_enforce=1`. Modules load only from the OS generation or from a **`kmod` generation** (§6.1), and every module MUST carry a signature by the release stream's module-signing key: only project-built, release-signed out-of-tree modules exist. Owner-sealed modules are impossible by design (lockdown enforces module signatures, and owners hold no module-signing key). `warden` registers a `kmod` generation's mount only if its manifest `kmod.kernel` equals the running kernel release.
- `vm.memfd_noexec=2`; `kernel.unprivileged_bpf_disabled=2`; signed BPF loaders only for `boot` and `warden`.
- **Service BPF programs.** Some tier-0 services need BPF programs (strata provenance, net firewall helpers, gate accounting). `warden` loads them only from the **OS generation**, from `/usr/lib/keylos/bpf/<service>/<program>.o` files listed for that service in `services.json` (§20.16), before starting the service; it attaches them and passes their map fds to the service as `KEYLOS_BPF_FDS` (§10.5). Services never call `bpf()` themselves.
- **Grant ceilings.** The warden core loads a label-ceiling LSM program (`kl-label`, separate from the `kl-exec` hand-over) that enforces the exposure label of directory grants (§7.3.3, §14.1): an `open` through a grant mount, and a read through an fd opened through one, fails with `-EACCES` when the object's `security.bpf.keylos.label` (§10.4) exceeds the grant's ceiling or is malformed. `kl-label` attaches `file_open` and `file_permission` (plus `mmap_file` for reads through a mapping), keyed by the grant mount's ID in its map `kl_grant_ceiling`, and reads kernel structures at BTF-computed offsets as `kl-exec` does. Unlabelled objects get their location default (§14.1), except that on kernels without the `bpf-init-inode-xattr` feature an unlabelled object created after the grant was attached counts as `secret/untrusted`. Where `warden` cannot enforce ceilings, `attachGrant` gets a null ceiling and the broker MUST raise the holder to `secret/untrusted`.
- **JIT.** Generations with `needs.jit: true` get their cgroup added to `kl_exec_jit_cgroups` by `warden` and no `PR_SET_MDWE`.
- **Interpreters.** Interpreters shipped in keylos generations MUST honour `AT_EXECVE_CHECK` and the `SECBIT_EXEC_RESTRICT_FILE` / `SECBIT_EXEC_DENY_INTERACTIVE` securebits. `warden` sets both securebits on every host principal **except** the **trusted-terminal tree**, which gets only `SECBIT_EXEC_RESTRICT_FILE`.
- **Trusted-terminal tree.** The tree is the process spawned through `TrustedSpawn.spawnTerminal` and every process that `kish` running in it spawns as a job (foreground or background, including REPLs started from the prompt). A process spawned by any *other* program in that tree (for example an editor that spawns a helper) is outside the tree and gets both securebits; `warden` decides by the spawning principal's actor kind (`shell` from the trusted terminal) and the `SpawnSpec` origin, not by process ancestry alone.
- **Core dumps.** The kernel `core_pattern` pipe helper (`|/usr/lib/keylos/journal/coredump %P %s %t`) is started by the kernel in the root cgroup. This is the one userspace exception to "only the warden core runs in the root cgroup": the helper is an OS-generation binary, installs its own seccomp filter before reading any input, and **moves itself** into `/keylos.slice/system.slice/journal-coredump.scope` before reading the dump (cgroup v2 delegation rules allow only a process in the root cgroup's domain with root credentials to make that move; `journal` cannot). `journal` verifies the move and refuses dumps from a helper still in the root cgroup. `kl-exec`'s `bpf` rule does not depend on cgroup membership, so the exception grants it nothing. The helper is not exempt from `ptrace_access_check` either: it reads only `/proc/%P/{cgroup,status}` (not ptrace-guarded) and takes the crashed process's file mappings from the core's `NT_FILE` note, never from `/proc/%P/maps`.
- **Supervising without ptrace access.** Because `ptrace_access_check` exempts no task, `warden` and every other component observe and control other processes only through operations the hook does not guard: pidfds (from `clone3(CLONE_PIDFD)` or `pidfd_open`) for signals (`pidfd_send_signal`) and exit (`waitid(P_PIDFD)`), `PIDFD_GET_INFO` for credentials and the cgroup ID, `/proc/<pid>/{cgroup,status}`, and cgroup files. A child's namespace fds are captured at spawn: the child opens its own `/proc/self/ns/*` (a task's access to itself is not checked) and passes them to the spawner before its start barrier, and a mapping helper passes its own user-namespace fd the same way. No keylos component opens another task's `/proc/<pid>/{ns/*,root,cwd,fd,maps,mem,environ}` or uses `PIDFD_GET_*_NAMESPACE`, `setns` on a pidfd, `pidfd_getfd`, `kcmp` or `process_vm_*` on another task, except a debugger or open broker within its `kl_debug_pairs` entry.
- **Known limitation (composefs `mprotect`).** For an overlay (composefs) file mapping the kernel passes the backing file to `file_mprotect`, whose superblock is not the registered overlay superblock, so adding `PROT_EXEC` to such a mapping with `mprotect` is refused outside JIT cgroups. `execve` and `mmap(PROT_EXEC)` see the overlay file and are unaffected; only text relocations and similar are refused. Generations needing them declare `needs.jit`.
- **Legacy open broker.** `compat` runs **one open-broker process per legacy app** (the `kl_debug_pairs` map holds one target per tracer). At `LegacySpawn` time (parameter `brokerSession`, §7.5.1) `warden` writes a `kl_debug_pairs` entry (scope `process`, no expiry while the app runs) from that open-broker process's cgroup to the legacy app's cgroup. For this pair `ptrace_access_check` permits `PTRACE_MODE_READ` and `PTRACE_MODE_ATTACH_REALCREDS` (the mode the kernel checks for `process_vm_readv`). The open broker runs with seccomp profile `openbroker-1`, which allows `process_vm_readv` and denies `ptrace`, `process_vm_writev` and `pidfd_getfd`, so the pairing yields read access to the app's memory for decoding seccomp-notification syscall arguments and nothing else.
- **Debugging (`Right.debug`).** A debug grant is minted only at tier T3 with presence, lasts at most 3 600 s (scope `process`) or 900 s (scope `kernel`), and is never minted to an agent principal unless the target session lies inside that agent's own session tree; agents never get scope `kernel` and never a `gen:` target. A request with `durationSecs = 0` resolves to the policy default before minting (default 900 s for `process`, 300 s for `kernel`). It is materialised by `Broker.debug` → `DebugAttach.attach` (§7.5.1): `warden` spawns the debugger generation (policy list `debug.debuggers`, e.g. gdb, lldb, perf, bpftrace) with seccomp profile `debug-1`, writes the `kl_debug_pairs` entry, and grants the debugger ambient capabilities: `CAP_SYS_PTRACE` and `CAP_PERFMON` for scope `process` (tracing another dynamic UID and opening cgroup-scoped perf events need them), plus `CAP_BPF` for scope `kernel`. `kl-exec`'s `ptrace_access_check`, `perf_event_open` and `bpf` hooks bound what those capabilities reach to the paired target. Receipts `debug.attach`/`debug.detach`. Inside workbench VMs debugging is unrestricted.

### A.26 `protocols §10.1` — Host layout

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

### A.27 `protocols §14.1` — Labels

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

### A.28 `protocols §14.3` — Approval tiers

| Tier | Covers | Interaction |
|---|---|---|
| T0 | Reads and overlay writes within grants | None, receipt only |
| T1 | Reversible egress to granted hosts | None; a classifier MAY escalate to T2/T3 |
| T2 | Compensable effects, new hosts, widening a sub-principal's scope | Batched review on the trusted path |
| T3 | Irreversible effects, declassification, budget overrun, merge of an agent overlay, config apply, seal, policy change | Synchronous trusted-path prompt with rendered effects and argument provenance. Presence (FIDO2 touch) is REQUIRED for config apply, seal, policy change, payment, persistent grants, and any effect whose policy says `presence` |

Rules:
- No automated component may lower a tier.
- A remote approval routed to a paired phone (`VouchLink.routeApproval`) or an org approval (`OrgDecider.decide`) MAY satisfy a T2/T3 approval only when the policy explicitly allows that channel for that effect kind, and **never** satisfies `requiresPresence`.
- **Channel selection.** The broker puts `"phone"` in `ApprovalPrompt.channels` only when the matching permit's `@channels` includes `phone` **and** a `vouchd` approver key is registered this boot (`registerApprover(…, "phone")`); `"org"` only for `@orgApproval` permits on fleet-enrolled machines. The mandate's `channel` records the channel that decided.
- **Family machines.** A non-owner human's request that needs an owner decision (config proposal, seal, persistent grant, policy change, install of an unreviewed app) becomes an approval prompt to the owners with `requester` set; it is shown on the next owner trusted-path session or routed to an owner's paired phone (never satisfying presence).
- **Quorum machines.** Wherever presence is required, a quorum presence envelope (§5.4) is required instead.
- **Headless machines without fleet.** On profiles without `atrium` that are not fleet-enrolled, every approval at T2 or above is escalated to a quorum presence request (`HearthQuorum.request`); there is no local trusted path. The resulting mandate has `channel: "quorum"`.
- **Guest sessions** never receive presence-class grants, agent sessions (unless `hearth.guest.agents` is true) or persistent grants.
- **Fail closed on rendering.** No channel may produce an approving decision for an effect whose required review details (§14.2) were not presented completely (§7.3.4). This holds for local prompts, presence cards, phone, org and quorum review alike; a channel that cannot present them leaves the approval pending for a capable channel, or it expires and is denied.
- **Org approver keys** come only from `/etc/keylos/fleet/approvers.json` (`keylos.fleetapprovers/1`, §20.23).
- **Durable decisions** (§20.25). An approval for a workflow is a durable decision record (`dr-…`) in the broker. Its prompt (`a-…`) is boot-local: a pending decision survives restarts and reboots and is presented again, with a new prompt ID, until it is decided or expires; `expires` is fixed when the decision is created (default 7 days, never beyond the workflow's horizon) and is never extended. Waiting never makes an earlier, incomplete rendering sufficient: each presentation needs the complete required material of that moment. A decided approval is used by a later attempt only through an explicit rebind (`BrokerWorkflow.rebind`), which re-checks current policy, revocation, expiry and presence; it never turns a historical approval into standing authority.

### A.29 `protocols §14.4` — Mandates (`keylos.mandate/1`)

```json
{"schema":"keylos.mandate/1","approval":"a-…","principal":"…","tier":"t3",
 "effects":[{"kind":"email.send","target":"smtp:…","digest":"sha256:<payload digest>"}],
 "scope":"once","constraints":{"maxAmount":null,"expires":"…"},"decidedBy":"alice","presence":true,
 "channel":"local"}
```

- `channel`: `local` (atrium trusted path), `phone` (vouch), `org` (fleet approver), `quorum` (a quorum presence envelope, §5.4; `decidedBy` is `"quorum"`).
- `constraints.workflow` and `constraints.decision`: present exactly in mandates of durable decisions (§20.25): the `wf-…` the decision belongs to and its `dr-…`. A verifier acting for a workflow MUST require `constraints.workflow` to equal the effect's workflow; verifiers that do not know these members reject the mandate (unknown members, §5.1), so an older verifier fails closed.
- `constraints.channels`: the channels the broker allowed for this approval (§14.3, `ApprovalPrompt.channels`), a non-empty array of channel names without duplicates. The deciding `channel` MUST be one of them unless it is `quorum` (quorum presence replaces local presence on quorum machines).
- **Drafts.** `ApprovalPrompt.mandateDraft` is not a valid mandate: it carries placeholder `decidedBy` and `channel` values until the deciding channel fills them in and signs. Only a decided mandate is validated as `keylos.mandate/1`.
- **Extensions carry no authority.** `x-` members (§5.1) of a mandate are informational; no verifier may base an authorization decision on them.
- **Grant effects.** For a grant decision the broker writes one effect `{"kind": "grant.<k>", "target": <canonical resource string>, "digest": "sha256:" + SHA-256(JCS(R))}`, where R is the JSON form of the `GrantRequest`: `{"resource": {<union member>: v}, "rights": [Right enumerant names], "reason", "durationSecs", "persist", "onBehalfOf": <principal text or null>}`, with v = the text value for `path`, `device`, `secret`, `service`, `effect`, `screen`, `model` and `spawn`; `null` for `dirFd` and `delegate`; `{"host", "port", "proto", "methods"}` for `net`; `{"unit", "amount"}` for `budget`; `{"target", "scope"}` for `principal`. A service that asked for a confirmation through `requestFor` (vault: `grant.secret` with `{"secret": "<owner>/<name>"}`) verifies kind and digest.
- **Decision signatures** (inside the approval flow): presence-signed (§5.3) when `presence` is true; otherwise signed by the deciding channel's approver key: the atrium approver key or the `vouchd` phone key (both registered with `BrokerSystem.registerApprover`), or an `approver/<id>` key.
- **Mandates as delivered** (`Approval.mandate`, `GrantResult.mandate`): a presence-signed mandate is delivered as is; a non-presence mandate is re-signed by `service/broker` after the broker has verified the channel's decision signature. Relying services (gate, strata, bench, depot, devd) therefore verify only owner-presence keys (owner registry, via `HearthSystem.owners`) and the `service/broker` key (as registered with `ledger`, `Ledger.serviceKey`, §7.3.5); they never need approver keys.
- The `approval.decide` receipt carries `mandateDigest` (SHA-256 of the delivered mandate envelope).
- `gate` MUST NOT commit an irreversible intent without a mandate whose `effects[].digest` matches the intent payload digest.

### A.30 `protocols §19.2` — Facets (excerpt: rows naming atrium)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| warden | `admin` | owner `shell`, config, courier, devd, atrium | all `Supervisor` (including `control("_system", poweroff\|reboot)`); `PrincipalControl` |
| warden | `launcher` | atrium launcher | `UserSpawn` |
| warden | `trusted-terminal` | atrium-term | `TrustedSpawn` |
| broker | `system` | warden, gate, aide, atrium, config, hearth, strata, net, depot, vault, vouch, cri | `BrokerSystem` (per-method callers as commented in §7.5.2; `requestFor` with the allowed-subject rule, atrium only for its own session (device authorization); `registerApprover`: atrium, vouch; `admitPod`: cri; `mintCaptive`: net); `Broker.inspect` |
| broker | `label-authority` | gate, bench, portal-*, atrium, strata, aide, journal, warden | `LabelAuthority` |
| hearth | `greeter` | atrium greeter and lock screen | `users`, `login`, `unlock`, `lock` |
| hearth | `atrium` | atrium | `presence` (prompt already shown by atrium) |
| hearth | `admin` | owner `shell`, atrium settings | all `Hearth`; `HearthAdmin` (including `setQuorumPolicy`); `HearthQuorum.collect`, `list` |
| gate | `client` | principals with net needs, portal-files, atrium (staging `media.export`) | `connect`, `stage` (own session), `intents` (own session tree, recursive), `intent` (own session tree), `meter` (own roots); `DurableEffects.prepare`, `complete`, `lookup`, `watch` (attempt sessions, own workflow) |
| gate | `admin` | owner `shell`, atrium | `intents`, `meter` (any session) |
| gate | `debug` | warden, atrium, owner `shell` | `GateDebug` |
| net | `user` | owner `shell`, atrium | `Net` (all); `NetWatch` |
| net | `captive` | atrium | `NetCaptive` (`status`, `portalUrl`, `signIn`); `NetWatch` |
| aide | `user` | human `shell`s, atrium | `Aide` (own human's sessions) |
| depot | `user` | `shell`, atrium, aide, portal-openuri, portal-discovery, gate, any principal granted `depot#user` | `get`, `list`, `install`, `verify`, `revocations`, `revocationStatus`, `openObject` (closures the caller may spawn), `openPath` (`/.keylos/…` only) |
| courier | `client` | humans' `shell`s, atrium | `check`, `status` |
| courier | `admin` | owner `shell`, atrium settings, config | `Courier` (all) |
| devd | `service` | hearth, strata, atrium, portal-inhibit | `PowerEvents` (subscribe + ack) |
| devd | `atrium` | atrium | `Backlight` |
| devd | `authorize` | atrium | `DeviceAdmin.authorize`, `deauthorize`, `pending` |
| devd | `admin` | atrium settings, owner `shell` | all incl. `power`; `Bluetooth` |
| bench | `user` | kish, `work`, atrium, portal-files, forge | `project`, `start` (purposes workbench; build (forge only, `unsignedImageOk`); app (kish, atrium launcher: non-reproducible native apps at tier 2)), `snapshots`, `media` (atrium, portal-files), `reattach` (own VMs) |
| compat | `user` | kish, atrium launcher | `importImage`, `run` (own apps) |
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
| portal-files | `drop` | atrium | `FilePicker.confirmDrop` |
| pipewire | `portals` | portal-screen, portal-camera, portal-mic, atrium (creates screencast video nodes) | PipeWire native protocol (upstream); the portals mint restricted remotes for apps |
| fleet | `client` | owner `shell`, atrium | `FleetCompliance.status` |
| vouch | `settings` | atrium settings, owner `shell` | `VouchLink` pairing methods, `phones`, `remove`, `inheritance` |
| vouch | `approvals` | atrium | `VouchLink.routeApproval` |
| cri | `status` | fleet, atrium | `CriAdmin.pods`, `node`, `images` |
| loom | `user` | human `shell`s, atrium | `Loom`, `Workflow` (own human's workflows; `enroll` with the caller as owner) |

### A.31 `protocols §20.2` — Presence purposes

| `purpose` | Payload `schema` | UV required |
|---|---|---|
| `mandate` | `keylos.mandate/1` | per policy (default true) |
| `config.apply` | `keylos.configgen/1` | true |
| `seal.window` | `keylos.seal-window/1` | true |
| `owners.entry` | `keylos.owners-entry/1` | true |
| `grant.persist` | `keylos.mandate/1` | per policy |
| `exception` | `keylos.exception/1` | true |
| `debug.grant` | `keylos.mandate/1` | true |
| `ledger.reset-writer:<svc>`, `ledger.ack-alarm`, `ledger.shred`, `vault.<op>`, `update.<op>`, `boot.<op>` (including `boot.sb-sign`), `trustee.split`, `loom.<op>` (including `loom.rollback-accept`, §20.25), `gate.<op>` (including `gate.rollback-accept`), `broker.<op>` (including `broker.workflow-rollback-accept`) | `keylos.presence/1` | true |

`boot.wipe` details: `{"command": <the keylos.fleet.command/1 object>, "commandDigest": "sha256:<digest of its JCS bytes>"}`. HPKE `info` for recovery copies (§4) is `keylos-recovery-copy/1:<object>` with `<object>` ∈ {`hierarchy-owner`, `vault-slot:<username>`}.

Generic payload:

```json
{"schema":"keylos.presence/1","purpose":"ledger.reset-writer:gate","requestedBy":"<principal>","details":{},"nonce":"<base64 16 bytes>","time":"…"}
```

### A.32 `protocols §2.2` — Profiles and integrity profiles

A machine runs exactly one **profile** (chosen at install, recorded in the first-boot bundle and the boot report) and has exactly one **integrity profile** (derived at every boot, shown in status, in the boot report and in the `vouch` verdict).

| Profile | Use | Notes |
|---|---|---|
| `desktop`, `laptop` | Interactive machines | atrium, portals, presence by touch |
| `server` | Headless | No atrium; presence by **quorum** (§5.4); serial-console recovery with the recovery key |
| `server-k8s` | Kubernetes node | `server` + `cri`, `kubelet`, `kube-proxy` (§21) |
| `cloud` | VM image in a public or private cloud | vTPM (provider EK chains in the attestation trust store); confidential VMs (SEV-SNP, TDX) supported, SVSM vTPM preferred; first-boot bundle from the metadata service (§20.13); quorum presence |
| `kiosk` | Single-app appliance | Autologin to one app principal; atrium kiosk mode; trusted path still present for owners |
| `appliance` | Fixed-function device | As `server`, without `bench` |

| Integrity profile | Condition |
|---|---|
| `full` | Owner-controlled Secure Boot keys (no Microsoft CAs in db), TPM 2.0, IOMMU, every check passes |
| `shared-boot` | `secureboot.keepMicrosoftCAs = true` (dual boot): the Microsoft Windows and third-party UEFI CAs are in db. Bitpixie-class downgrade risk is mitigated by TPM+PIN, the signed PCR11 policy and the NV release floor, and is documented |
| `shim` | Booted through shim + MOK (no custom-key Secure Boot available) |
| `cloud-vtpm` | `cloud` profile with a provider vTPM and no confidential-VM report |
| `cvm` | `cloud` profile in a confidential VM whose report is verified together with the TPM quote |
| `degraded` | No TPM, or Secure Boot off; no sealing, no VBU, persistent warning |

### A.33 `protocols §7.3.13` — `bench.capnp`

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

### A.34 `protocols §7.5.10` — `bench-sys.capnp`

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

### A.35 `protocols §7.5.13` — `aide-sys.capnp`

```capnp
@0xc7a1e5d3b2f4002c;
using C = import "common.capnp";

struct AgentBootstrap {
  session      @0 :C.SessionId;
  principal    @1 :C.PrincipalId;
  templateJson @2 :Text;
  gitName      @3 :Text;
  gitEmail     @4 :Text;
  trailers     @5 :List(Text);
  env          @6 :List(C.KeyValue);   # proxy settings, KEYLOS_* (no secrets)
  localMcp     @7 :List(Text);         # JSON per local MCP server
}

interface AgentHostExt {           # obtained via Extensible.ext on the AgentHost connection (vsock 7002)
  bootstrap   @0 () -> (bootstrap :AgentBootstrap);
  modelStream @1 (requestJson :Text) -> (stream :C.ByteSource);
  heartbeat   @2 () -> ();
  desktop     @3 () -> (desktop :AgentDesktop);   #! only when the template sets vm.desktop: true; else kl:unsupported
}

interface VmExec {                 # used by WASI harnesses (camel/1) to run VM tools
  run @0 (argv :List(Text), stdin :Data, timeoutSecs :UInt32) -> (exit :Int32, stdout :Data, stderr :Data);
}

interface AgentDesktop {           # computer-use agents (§14.5); served by bench (Vm.desktop) to aide and by aide to the harness
  screenshot @0 () -> (png :Data, width :UInt32, height :UInt32);
  input      @1 (eventsJson :Text) -> ();
      # JCS list of {"type": "move"|"click"|"down"|"up"|"scroll"|"key"|"text", …}; delivered to the nested desktop only
  a11yTree   @2 () -> (json :Text);                         # A11yUpdate list of the nested desktop, as JSON
  launch     @3 (appName :Text) -> ();                      # start an app inside the agent desktop VM
  status     @4 () -> (watchedBy :List(Text), takenOver :Bool);   # takenOver: the human controls input; agent input is refused
}
```

### A.36 `protocols §9.5` — Devices, removable media and DMA

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

### A.37 `protocols §14.5` — Operating rules

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.

### A.38 `protocols §7.5.11` — `net-sys.capnp`

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

### A.39 `protocols §10.7` — Cross-repository files (excerpt: boot report row)

| Path | Format | Writer | Readers |
|---|---|---|---|
| `/run/keylos/boot/trust.json`, `report.json` | `keylos.boottrust/1`, `keylos.bootreport/1` (§20.1) | boot | any tier-0 service, `vouch` tooling |
| State | Owner | Location |
|---|---|---|

### A.40 `protocols §7.3.7` — `gate.capnp`

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

### A.41 `protocols §14.2` — Effect kinds

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
