# keylos/compat — the legacy tier

| | |
|---|---|
| Repository | `github.com/keylos-os/compat` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | Service generation `io.keylos.compat`:<br>• `compatd`: the `compat` service, tier 0<br>• `compat-openbroker`: the seccomp user-notification open broker<br>• `compat-dbus-gate`: the D-Bus island filtering proxy<br>• the `compat` CLI<br><br>Runner generation `io.keylos.compat.runner`, used inside tier-2 VMs and import workers:<br>• `compat-run` (guest-side container setup)<br>• `compat-openbroker-guest`<br>• `compat-importer` (import pipelines)<br><br>Runtime generation `io.keylos.compat.x11`: Xwayland, `dbus-broker`, `compat-init`, and the fonts and cursors that legacy apps expect.<br><br>Rust crate `keylos-compat-manifest` (the `keylos.compat/1` object). |
| Depends on | `keylos-protocols 1.0.0 (final)`, `dbus-broker` (≥ 36, inside islands only), Xwayland (≥ 24.1, inside app sandboxes only) |
| Runtime peers | `warden` (`LegacySpawn`: user namespaces and FHS views), `bench` (tier-2 VMs and import workers), `depot` (generation import and mount), `strata` (per-app state units), `broker` (grants, powerbox), `portals` (bridged APIs), `atrium` (Wayland, Xwayland window management), `vault` (Secret Service bridge, legacy secret import), `ledger` (receipts) |
| Provides | `Compat` (`protocols §7.3.15`); `CompatIsland` (`protocols §7.5.15`); the `keylos.compat/1` manifest object (§5.4); import pipelines; the open broker; D-Bus islands |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

keylos-native software reaches resources through file handles, capwire capabilities and `/grants`. Most existing Linux software instead expects:
- an FHS tree,
- a home directory full of dotfiles,
- X11 or a plain Wayland socket,
- a session bus and a system bus,
- the freedom to open any path it can name.

compat runs that software **without giving it any of that ambient authority**.

**compat provides:**
1. **Import pipelines.** They turn OCI images, Flatpak refs and distribution root filesystems (Debian, Fedora, Arch) into `legacy-image` generations in the store. All parsing of foreign formats and all foreign package-manager runs happen inside a tier-3 workbench VM, never on the host.
2. **FHS views.** A legacy principal sees a complete-looking filesystem: its image at `/`, a generated `/etc`, a per-app home and private `/tmp` and `/var`. Behind that view it holds no access beyond its grants. On the host, `warden` builds the view through `LegacySpawn` (`protocols §7.5.1`); inside tier-2 VMs, `compat-run` builds the same view.
3. **The open broker.** A seccomp user-notification supervisor. When a legacy program opens a path it was not granted under a promptable location, the broker gets the file through the powerbox and injects the resulting fd. The program never resolves the path.
4. **X11 and D-Bus compatibility:**
   - a per-app nested Xwayland, whose window-manager connection atrium serves (`Display.xwaylandWm`);
   - per-app **D-Bus islands** (a private bus plus a filtering gate that maps well-known freedesktop APIs to keylos portals and vault);
   - islands for legacy system daemons (BlueZ, CUPS, SANE), reachable only by their keylos adapters through `CompatIsland.islandSocket`.
5. **Placement.** It decides where each legacy app runs:

   | Image | Placement |
   |---|---|
   | Built by `forge` from pinned sources, reproducible, with a generation statement signed by a release-stream or publisher key | Tier L on the host |
   | Imported from the internet | Always tier 2, in a VM |

**Non-goals:**
- Kernel-mode compatibility: proprietary kernel modules, anti-cheat drivers, DKMS.
- Running legacy software with real root on the host.
- A global session bus or system bus.
- X11 servers shared between apps.
- Making imported images host-executable. There is no "promote to host" path for internet-origin images.
- Secret Service inside tier-2 VMs (§4.8.2).

---

## 2. Context and embedded contracts

### 2.1 Position

```
 compat CLI / kish / atrium launcher ──► compatd (tier 0)
                                    │ import:  Bench.start (import worker VM, tier 3) ─► Depot.importTree (facet compat)
                                    │ run L:   LegacySpawn.spawnLegacy(spec, view, brokerSession) ─► (process, notifyFd) ─► compat-openbroker
                                    │            compat-init (inside the principal) ─► Broker.powerbox, Xwayland, island
                                    │ run 2:   Bench.start(display=true, shares) ─► compat-run in the guest
                                    │ islands: CompatIsland.islandSocket ◄── devd, portal-print, vault adapters
                                    └ Xwayland: Display.xwaylandWm ─► atrium
```

### 2.2 Embedded contracts

Every contract below is copied verbatim into Appendix A by mechanical extraction from keylos-protocols 1.0.0 (final).

| Contract | Use | Appendix |
|---|---|---|
| `protocols §3.4` principals | `legacy:<gen>` principals | A.1 |
| `protocols §6.1`, `§6.3` | `legacy-image` kind; the `compat` manifest field; `reproducible`, `tier` rules | A.2, A.3 |
| `protocols §7.1`, `§7.2` | capwire, routes and facets | A.4, A.5 |
| `common.capnp` + errors | Everywhere | A.6 |
| `warden.capnp` | `SpawnSpec`, `Process` | A.7 |
| `broker.capnp` | `request`, `materialize`, `powerbox`, `PowerboxGrant.viewPath` | A.8 |
| `vault.capnp` | Secret Service bridge (facet `app`), legacy secret import (facet `adapter`) | A.9 |
| `depot.capnp` | `importTree` (facet `compat`), `mount`/`get`/`root`/`unroot` (facet `mounter`) | A.10 |
| `strata.capnp` | `createUnit`, `forget` for `app/*` units (facet `compat`) | A.11 |
| `bench.capnp` | Import workers and tier-2 placement (facet `compat`) | A.12 |
| `portals.capnp`, `compat.capnp` | Bridged APIs; **implemented** `Compat` | A.13 |
| `warden-sys.capnp` | `LegacySpawn` (with `brokerSession`), `GrantMounts.idmappedDir` | A.14 |
| `compat-sys.capnp` | **Implemented** `CompatIsland` | A.15 |
| `display.capnp` | `Display.xwaylandWm` | A.16 |
| `protocols §9.1`, `§9.2` | Baseline confinement; tier L definition | A.17, A.18 |
| `protocols §10.3` | Legacy user-namespace UID ranges | A.19 |
| `protocols §19.2`, `§19.3` | Facets naming compat; `legacy.*` receipt events | A.20, A.21 |
| `protocols §9.3` | `kl_debug_pairs` pairing that scopes the open broker's memory reads (Legacy open broker rule) | A.22 |
| `protocols §10.7` | `/run/keylos/gate/ca.pem` in tier-L views; CA environment variables | A.23 |
| `bench-sys.capnp` | `GuestPortals` (tier-2 islands bridge to notifications, open-uri, print, secrets, powerbox) | A.24 |
| `protocols §10.5` | `KEYLOS_GUEST_PORTALS` inside tier-2 guests | A.25 |
| `protocols §14.5` | Offline operation: newly installed legacy images go to tier 2 when the revocation list is stale (REQ-COMPAT-036) | A.26 |

### 2.3 Rules this spec relies on (summary; the appendix is normative)

- Only forge-built, reproducible legacy images signed by a trusted key run as tier L on the host; every imported image runs in t2 (`protocols §9.2`).
- Tier L is the baseline plus a user namespace built by `warden` with nesting disabled, an FHS view, and the seccomp user-notification open broker (`protocols §9.2`). compat never creates namespaces on the host.
- `LegacySpawn.spawnLegacy(spec, view, brokerSession)` returns the process and the seccomp listener fd (`protocols §7.5.1`). At that moment `warden` writes a permanent `kl_debug_pairs` entry from the cgroup of the open broker named by `brokerSession` to the legacy app's cgroup, which is the only thing that lets the broker read the app's memory (`protocols §9.3`).
- Inside tier-L views, `gate` maintains `/run/keylos/gate/ca.pem` when it intercepts TLS for the principal, and compat points the usual CA environment variables at it (`protocols §10.7`).
- Tier-2 guests reach notifications, URI opening, printing, their own display capture, per-item secrets and the file picker through `GuestPortals` on vsock 7004 (`protocols §7.5.10`).
- A generation is executable on the host only after `warden` registers it with `kl-exec` against the boot trust set (`protocols §9.3`); `compat` does not register anything.
- `legacy-image` manifests carry a `keylos.compat/1` object in `compat`; this repository owns that format (`protocols §6.3`, `§19.4`).

---

## 3. Requirements

### 3.1 Import

- **REQ-COMPAT-001** Every import MUST run its fetching, unpacking, signature checking and foreign package-manager execution inside a tier-3 bench VM (the **import worker**). `compatd` MUST NOT parse tar, OSTree, RPM, deb or pacman archives on the host.
- **REQ-COMPAT-002** The import worker's network grants MUST be limited to the source registry, remote or mirror hosts named in the import source and the configured mirror list. Nothing else.
- **REQ-COMPAT-003** Imported generations MUST have `manifest.tier = 2`, `reproducible = false` and `compat.origin.internet = true`. compat MUST NOT offer any operation that lowers this.
- **REQ-COMPAT-004** The resulting tree MUST be normalised before import (§4.2):
  - all setuid/setgid bits cleared;
  - file capabilities (`security.capability`) dropped;
  - device nodes, FIFOs and sockets removed;
  - ownership kept within 0–65535 for the image's UID map;
  - hard links preserved;
  - absolute symlinks kept as written. They are resolved inside the view only.
- **REQ-COMPAT-005** OCI sources MUST be verified by manifest digest when pinned (`oci://reg/repo@sha256:…`). Tag references are resolved once, and the resolved digest is recorded in `compat.origin`. If a cosign signature or a Sigstore bundle is present and the import policy names an expected identity, it MUST be verified inside the worker.
- **REQ-COMPAT-006** Flatpak sources MUST be verified with the remote's GPG keys (the configured remote definition) inside the worker. Flatpak permissions MUST be translated per §4.4. `--filesystem=home`, `--filesystem=host*`, `--socket=session-bus`, `--socket=system-bus` and `--device=all` MUST NOT become grants.
- **REQ-COMPAT-007** Distribution sources (`distro:debian:<suite>`, `distro:fedora:<release>`, `distro:arch:rolling`) MUST use the distribution's own signature verification (`apt` with the archive keyring, `dnf` with GPG checks enforced, `pacman` with `SigLevel = Required`). Package lists come from the import request.
- **REQ-COMPAT-008** `compatd` MUST import the normalised tree with `Depot.importTree(tree, manifest)` on route `depot#compat`, which accepts only kind `legacy-image`.

### 3.2 Views and placement

- **REQ-COMPAT-010** A `legacy-image` generation with `tier = 2`, `reproducible = false`, or `compat.origin.internet = true` MUST run only inside a bench VM.
- **REQ-COMPAT-011** A `legacy-image` generation MAY run in tier L on the host only if `Depot.get` reports it launchable, its `sealedBy` includes a release-stream or publisher key, `reproducible = true` and `compat.origin.format = "forge"`. Owner seals do not qualify: an owner seal is for code the owner built natively.
- **REQ-COMPAT-012** On the host, compat MUST start tier-L principals only through `LegacySpawn.spawnLegacy(spec, view, brokerSession)` on route `warden#compat`, with `brokerSession` = the session of the app's own `compat-openbroker` process (REQ-COMPAT-026). `view.stateDir` MUST be the app's state directory (§4.5), `view.grants` the persistent directory grants mapped to their view paths, and `view.netMode` `"pasta"` when the app has network grants, else `"none"`. compat never creates namespaces.
- **REQ-COMPAT-013** The legacy home seen by the app (`/home/user`) MUST be the app's own state subvolume (`home/` in the `app/<name>` unit) plus bind views of granted directories under the paths the grants name. It MUST NOT be the human's real home.
- **REQ-COMPAT-014** Each legacy principal's user namespace maps exactly one 65536-UID block (`protocols §10.3`), built by `warden`; the app's UID 0 maps to the block base, which has no host privileges; nesting is disabled (`protocols §9.2`).

### 3.3 Open broker

- **REQ-COMPAT-020** For legacy principals whose `compat.openBroker` is `prompt` (the default for GUI apps), compat MUST supervise `open`, `openat`, `openat2` and `creat` (x86-64), plus the `openat`/`openat2` variants on aarch64, through the seccomp listener returned by `LegacySpawn`.
- **REQ-COMPAT-021** For a trapped open, the broker MUST decide in this order:

  | Path resolves to | Response |
  |---|---|
  | Within the view and not under a promptable prefix | `SECCOMP_USER_NOTIF_FLAG_CONTINUE`. Safe: the kernel enforces the view and Landlock, so no security decision is delegated to the broker |
  | Under a **promptable prefix** (§4.6) | Ask `compat-init` (inside the principal) for the file: it opens it beneath an existing grant, or obtains it through `Broker.powerbox`. The broker injects the returned fd with `SECCOMP_IOCTL_NOTIF_ADDFD` + `SECCOMP_ADDFD_FLAG_SEND` |
  | Anything else | `ENOENT` |

- **REQ-COMPAT-022** The broker MUST validate each notification with `SECCOMP_IOCTL_NOTIF_ID_VALID` after reading the path from target memory and before acting.
- **REQ-COMPAT-023** Prompts MUST be rate-limited: at most one outstanding prompt per app, and identical denied paths are not re-prompted for 10 minutes.
- **REQ-COMPAT-024** The broker MUST NOT answer `CONTINUE` for any path under a promptable prefix, so the kernel never resolves a prompt-prefix path on the app's behalf.
- **REQ-COMPAT-025** `compat-openbroker` MUST read target memory only through `process_vm_readv` on the paired legacy app, which `kl-exec` permits solely because `warden` wrote the pairing for exactly that (broker cgroup, app cgroup) at `LegacySpawn` time (`protocols §9.3`; the pair allows `PTRACE_MODE_READ` and `PTRACE_MODE_ATTACH_REALCREDS`). The broker MUST run with the seccomp profile `openbroker-1` (`protocols §9.1`: baseline plus `process_vm_readv`; `ptrace(2)`, `process_vm_writev` and `pidfd_getfd` denied), so the pairing can only ever be used to read.
- **REQ-COMPAT-026** compat MUST spawn exactly one `compat-openbroker` per legacy principal, in a cgroup of its own (so the pairing names one broker and one app), and MUST stop it when the app exits; `warden` removes the pairing when either side exits.

### 3.4 X11 and D-Bus

- **REQ-COMPAT-030** X11 apps MUST get a per-app nested Xwayland instance inside their own sandbox. It listens only on a pathname socket inside the view (`/tmp/.X11-unix/X0`) and connects to atrium as a Wayland client with the app's security context. Abstract X11 sockets MUST NOT be created. Its window-manager connection MUST be handed to atrium with `Display.xwaylandWm(principal, wm)` on route `atrium#display`.
- **REQ-COMPAT-031** Each legacy app that declares `compat.dbus.session = true`, and each native app with `needs.portalIsland = true`, MUST get its own private session bus (`dbus-broker`) inside its sandbox. That bus MUST be reachable only by the app's processes and the island's `compat-dbus-gate`.
- **REQ-COMPAT-032** `compat-dbus-gate` MUST forward only the names and methods on the island allowlist (§4.8) to keylos services. All other external names MUST be unavailable: `ServiceUnknown`.
- **REQ-COMPAT-033** Legacy system daemons (for example BlueZ, CUPS, SANE, ModemManager) MUST run as tier-L legacy services, each in its own island. A keylos adapter is the only other client of that island, connected through `CompatIsland.islandSocket(service)` on route `compat#adapter`. D-Bus daemons get a private system bus; `saned` gets a private stream socket speaking the SANE network protocol (§4.8.3).
- **REQ-COMPAT-034** When `/run/keylos/gate/ca.pem` exists in a tier-L view, `compat-init` MUST set `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS` to that path for the app (`protocols §10.7`). Inside tier-2 guests, `compat-run` MUST do the same with `/keylos/ca/ca.pem` when the VM's `keylos-ca` share is present (bench spec).
- **REQ-COMPAT-036** Before placing a `legacy-image` generation, compat MUST call `Depot.revocationStatus()` (route `depot#compat`). When the revocation age exceeds 30 days (`protocols §14.5`, offline operation) and the generation was installed after the newest verified revocation list was issued (`GenerationInfo.installed` later than `issued`), compat MUST place it on the tier-2 path even if it qualifies for tier L, and MUST say so in `compat permissions <name>`.
- **REQ-COMPAT-037** `CompatIsland.islandSocket(service)` MUST return a socket whose protocol depends on the island (`protocols §7.5.15`): `bluez`, `cups-dbus` and `secret-import` a filtered D-Bus proxy connection in adapter mode; `sane` a SANE network protocol (saned) stream; `cups` IPP over HTTP/1.1. An unknown service name fails with `kl:not-found`.
- **REQ-COMPAT-035** Inside tier-2 guests, `compat-dbus-gate` MUST bridge `org.freedesktop.Notifications`, `org.freedesktop.portal.OpenURI`, `org.freedesktop.portal.Print`, `org.freedesktop.portal.FileChooser`, `org.freedesktop.portal.Screenshot`/`ScreenCast` (own VM display only) and `org.freedesktop.secrets` to `GuestPortals` (`KEYLOS_GUEST_PORTALS`), and answer every other external name with `ServiceUnknown`.

### 3.5 Lifecycle and audit

- **REQ-COMPAT-040** compat MUST write receipts (route `ledger#writer`) for imports (`legacy.import`; `gen.install` is written by depot), for powerbox-mediated opens (`legacy.open`), and for island adapter calls that cross into vault or portals (`x-compat.bridge`, repo-local).
- **REQ-COMPAT-041** `compat rm` MUST remove the app's GC roots and, unless `--keep-data`, its state through `Strata.forget` of the unit `app/<name>` (route `strata#compat`), after confirmation.
- **REQ-COMPAT-042** `compat update` MUST show the capability diff `depot` computes and MUST NOT make the new generation launchable without consent.

---

## 4. Design

### 4.1 Import pipeline

```
compat import <source> ─► compatd
  1. parse source; choose worker image io.keylos.bench.guest + runner gen io.keylos.compat.runner
  2. request net grants for source hosts (Broker.request, T2 prompt, or pre-approved by policy for known registries)
  3. Bench.start(VmSpec{image, shares=[out (writable, direct, fresh empty dir in /var/lib/compat/import/<id>),
                                       runner (ro: Depot.mount(runner) on depot#mounter)], network=grants})
  4. vm.exec(["/work/runner/bin/compat-importer", <source>, "--out", "/work/out"])
       worker: fetch → verify → unpack/install → normalise (§4.2) → write /work/out/{rootfs/, meta.json}
  5. compatd: validate meta.json (schema), walk rootfs with openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS),
     re-checking normalisation invariants (defence in depth); build the manifest and keylos.compat/1 (§5.4)
  6. Depot.importTree(rootfs dirfd, manifest)              # route depot#compat
  7. vm.discard(); delete out dir
  8. receipt legacy.import {source, resolved, format, generation, result, warnings}
```

**`meta.json`**, written by the worker (repo-local format `keylos.compat.import/1`):

```json
{"schema":"keylos.compat.import/1","source":"oci://ghcr.io/org/app:1.2","resolved":"oci://ghcr.io/org/app@sha256:…",
 "format":"oci","arch":"x86_64","entrypoint":["/usr/bin/app"],"env":{"PATH":"/usr/bin:/bin"},
 "desktop":[{"id":"org.example.App","name":"App","exec":"/usr/bin/app %F","icon":"usr/share/icons/…","mime":["image/png"]}],
 "flatpakPermissions":null,"signature":{"verified":true,"identity":"https://github.com/org/app/.github/workflows/release.yml@refs/tags/v1.2"},
 "uidRange":{"min":0,"max":65535},"warnings":[]}
```

#### 4.1.1 Per-format worker steps

| Format | Steps inside the worker |
|---|---|
| OCI | Resolve the reference with `oci-client`; fetch the manifest for the host architecture; verify the digest; verify a cosign/Sigstore signature when `import.expected_signers` names the repository; apply layers in order with whiteout handling into `rootfs/`; take `Entrypoint`/`Cmd`/`Env`/`WorkingDir` from the image config |
| Flatpak | `flatpak --installation=<worker-local> remote-add` with the configured GPG key; `flatpak install --noninteractive <ref>` (pulls the app and its runtime); compose app over runtime into `rootfs/` (`/app` and `/usr`); read `metadata` for permissions (§4.4) and `.desktop` files |
| Debian | `mmdebstrap --variant=minbase --keyring=<archive keyring> <suite> rootfs <mirror>` plus the requested packages; `--skip=cleanup/apt` off so caches are removed |
| Fedora | `dnf --installroot=rootfs --releasever=<rel> --setopt=gpgcheck=1 --setopt=install_weak_deps=False install <packages>` |
| Arch | `pacstrap -C <pacman.conf with SigLevel = Required> rootfs <packages>` |
| rootfs | Copy the given directory share (read-only) into `rootfs/` with `cp --archive --no-preserve=links`; no network |

The worker writes nothing outside `/work/out` that the host reads. Its scratch disk is discarded with the VM.

#### 4.1.2 Updates

`compat update <name>` re-runs the import from the recorded `compat.origin.source` (a new tag resolution for unpinned sources). The new generation gets the same `name`, a version suffix `+import.<n>`, and `depot` computes the capability diff against the installed one; widening needs consent (`keylos.consent/1`) before it becomes launchable.

### 4.2 Normalisation

The import worker applies these rules, and `compatd` re-checks them on the host:

| Item | Rule |
|---|---|
| Regular file | Mode masked to `0755` or `0644` (keep exec bits for owner/group/other as a set); strip `security.*` and `trusted.*` xattrs; keep `user.*` xattrs ≤ 4 KiB |
| Directory | `0755` |
| Symlink | Kept verbatim (target text). Targets containing `..` above `/`, or absolute targets, are allowed: the view confines them |
| Hard link | Preserved as the same store object |
| Device, FIFO, socket | Removed; the view provides `/dev` |
| setuid/setgid | Cleared (and recorded as a warning in `compat.warnings`) |
| Ownership | `uid/gid` > 65535 cause rejection. Files keep their in-image UID/GID: composefs metadata stores them, and warden's user namespace maps them |
| Size | Total ≤ 64 GiB, ≤ 2,000,000 entries (configurable) |
| Path names | Valid UTF-8 not required. NUL-free, ≤ 4096 bytes, components ≤ 255 bytes |

### 4.3 Placement

```
run(generation):
  info = Depot.get(gen); m = info.manifest
  if m.kind != "legacy-image": fail invalid
  rev = Depot.revocationStatus()                       # route depot#compat (REQ-COMPAT-036)
  stale = rev.ageSecs > 30 days and info.installed > rev.issued
  if m.compat.origin.internet or m.tier == 2 or !m.reproducible or m.compat.origin.format != "forge" or stale:
       → tier-2 path
  elif info.launchable and info.sealedBy ∩ (release-stream keys ∪ publisher keys) ≠ ∅:
       → tier-L path
  else: fail denied ("legacy image is not built and signed for the host")
```

**Tier-L path:**
1. compat ensures the app's state unit exists (`Strata.createUnit(path, "app/<name>", policy)` on route `strata#compat`), with directories `home/`, `var/`, `etc-overlay/`, `machine-id`.
2. compat creates the private channel for `compat-init` (a socketpair; one end for `compat-init`, one for `compat-openbroker`) and, when X11 is needed, the Xwayland window-manager socketpair.
3. compat spawns `compat-openbroker` for the new principal (route `warden#compat`, `Supervisor.spawn` of its own entrypoint, in its own cgroup, waiting on its channel), then calls `LegacySpawn.spawnLegacy(spec, view, brokerSession = <the broker's session>)` on route `warden#compat` (§4.6, "Spawn ordering"):
   - `spec.actorKind = legacy`, `spec.generation = gen`, `spec.entrypoint = "compat-init"` of the runtime layered into the view, `spec.argv = ["--", <compat.entrypoints.main.exec>, args…]`;
   - `spec.fds`: the `compat-init` channel at fd 10, the Xwayland WM end at fd 11 when needed, then the caller's `fds`;
   - `spec.grants` = caller grants plus the app's persistent grants;
   - `view = LegacyView{image: gen, stateDir: <app state dirfd>, grants: [LegacyGrant{tree, target, readOnly}…], netMode}`.
4. `warden` returns `(process, notifyFd)` and has written the open-broker pairing. compat hands the broker `notifyFd`, the other end of the `compat-init` channel, and the app's pidfd over the broker's channel.
5. When X11 is needed, compat calls `Display.xwaylandWm(principal, wmFd)` on route `atrium#display` with the other WM socketpair end.
6. `compat-init` (from `io.keylos.compat.x11`, mounted at `/.compat`) runs inside the principal: it starts Xwayland and the D-Bus island when the manifest asks for them, then execs the app as UID 1000 inside the namespace.

**Tier-2 path:**
1. `Bench.start(VmSpec{image = io.keylos.bench.guest, shares = [...], display = true, gpu = m.needs.gpu != "none", network = grants for m.needs.network})` on route `bench#compat`. The shares are:
   - `legacy-root` (ro): the `Depot.mount(gen)` tree (route `depot#mounter`)
   - `runner` (ro): `Depot.mount(io.keylos.compat.runner)`
   - `x11` (ro): `Depot.mount(io.keylos.compat.x11)`
   - `state` (rw, direct): the app's state unit directory
   - one share per granted directory
2. `vm.exec(["/work/runner/bin/compat-run", "--root", "/work/legacy-root", "--state", "/work/state", "--", argv…], tty=false)`.
3. Inside the guest, `compat-run` builds a user-namespace container with the same view as tier L (the guest kernel is the boundary, so guest-side namespaces are unrestricted). It starts Xwayland, the D-Bus island and the guest open broker. The guest open broker gets prompted files through `GuestPortals.powerbox` (vsock 7004, `protocols §7.5.10`), which `bench-relay` serves with `Broker.powerbox` as the VM principal; a picked file appears in the VM's `grants` share, a picked directory is hot-plugged as a share (bench spec §4.15).
4. **VM groups.** Apps with the same `compat.vmGroup` value, set by the user (`compat group`), share one VM. Each app is a separate container inside it. Default: each app has its own VM.

### 4.4 Flatpak permission mapping

| Flatpak permission | keylos mapping |
|---|---|
| `--share=network` | `needs.network = [{"host":"*","ports":[80,443],"proto":"tcp","why":"Flatpak network"}]`. A wildcard host request is never auto-granted: it becomes a T2 prompt at first launch with the choices "allow any host" (recorded as a persistent grant) or "ask per host" |
| `--share=ipc` | Dropped (no shared IPC namespace) |
| `--socket=wayland` | `needs.gpu ≥ "display"` |
| `--socket=x11` / `fallback-x11` | `compat.x11 = true` (nested Xwayland) |
| `--socket=pulseaudio` | Playback: `needs.services += ["portal-mic"]` with the static `playback` route. Capture: broker grant for `portal-mic#capture` (prompt on use) |
| `--socket=ssh-auth` | `needs.secrets += [{"name":"ssh","why":"SSH agent"}]`, mapped to `Vault.sshAgent` (tier L) or the gate SSH agent (tier 2) |
| `--socket=pcsc`, `--socket=cups` | `needs.services += ["portal-print"]` for CUPS; pcsc dropped |
| `--device=dri` | `needs.gpu = "render"` |
| `--device=kvm`, `--device=all`, `--device=shm` | `kvm` and `all` dropped (warning); `shm`: private `/dev/shm` |
| `--filesystem=home`, `host`, `host-os`, `host-etc` | Dropped; the open broker prompts instead |
| `--filesystem=xdg-download` and other XDG dirs | `compat.view.promptPrefixes += ["~/Downloads"]` (prompt, not an automatic grant) |
| `--filesystem=<path>:ro`/`:rw` outside home | Dropped |
| `--talk-name=org.freedesktop.Notifications` | Island allowlist entry (§4.8) |
| `--talk-name=org.freedesktop.portal.*` | Island allowlist entries mapped to keylos portals |
| `--talk-name=org.freedesktop.secrets` | Island allowlist entry mapped to the vault bridge (tier L only) |
| Other `--talk-name`, `--own-name` | Allowed inside the private bus only (the app's own processes); never bridged |
| `--system-talk-name=*` | Dropped |
| `--env=VAR=…` | Copied unless the name matches the secret pattern `(?i)(key\|token\|secret\|passw\|credential)` |
| `--persist=<dir>` | Becomes part of the app's `home/` state |

### 4.5 FHS view composition (`compat.view`)

The view below is what `warden` builds for tier L from `LegacyView`, and what `compat-run` builds inside the guest for tier 2:

| Path in view | Source | Mode |
|---|---|---|
| `/` | The legacy-image generation (composefs mount) | ro |
| `/etc` | Overlay: lower = image `/etc`, upper = `state/etc-overlay`, plus generated files (below) | rw (upper only) |
| `/etc/passwd`, `/etc/group` | Generated: `root:0`, `user:1000` (named after the human), `nobody:65534` | ro |
| `/etc/resolv.conf` | `nameserver 127.0.0.53` (tier L: forwarded by `pasta` to the gate shim's resolver; tier 2: bench synthetic DNS) | ro |
| `/etc/machine-id` | Per-app stable random ID (stored in state) | ro |
| `/etc/localtime`, `/etc/hosts`, `/etc/ssl/certs` | From the keylos runtime (system trust store) | ro |
| `/run/keylos/gate/ca.pem` | Tier L: written by `gate` when it intercepts TLS for this principal (`protocols §10.7`); tier 2: `/keylos/ca/ca.pem` from bench's `keylos-ca` share | ro |
| `/home/user` | `state/home` | rw |
| `/home/user/<granted>` | Bind of each granted directory at the path its `LegacyGrant.target` names (default `~/Documents/<name>`) | per grant |
| `/tmp`, `/var/tmp`, `/dev/shm` | Private tmpfs (tier L: 1 GiB cap) | rw |
| `/var` | Overlay with upper `state/var` | rw |
| `/run/user/1000` | Wayland socket (security-context tagged), PipeWire remote | — |
| `/dev` | Minimal: `null`, `zero`, `full`, `random`, `urandom`, `tty`, `pts/`, `ptmx`, plus the GPU render node if granted | — |
| `/proc` | Fresh, `hidepid=invisible,subset=pid` | — |
| `/sys` | Read-only, filtered to `/sys/devices/system/cpu`, and `/sys/class/drm` only if a GPU is granted | ro |
| `/.compat` | `io.keylos.compat.x11` runtime (Xwayland, dbus-broker, `compat-init`) | ro |

**State directory layout** (`stateDir`, one strata unit `app/<name>` per human):

```
home/          the app's home (rw)
var/           overlay upper for /var
etc-overlay/   overlay upper for /etc
machine-id     32 hex characters
grants.json    view-path ↔ persistent grant id map (written by compat-init)
```

### 4.6 Open broker

**Listener delivery (tier L).** `LegacySpawn.spawnLegacy` installs the seccomp filter with `SECCOMP_FILTER_FLAG_NEW_LISTENER` during the principal's setup and returns the listener as `notifyFd` (`protocols §7.5.1`). compat passes it to a dedicated `compat-openbroker` process for that principal. That process runs as compat's service principal in a sub-session associated 1:1 with the legacy principal.

**Memory access.** To read the path argument the broker reads target memory with `process_vm_readv` on the target pid. Access is granted by the **open-broker pairing** (`protocols §9.3`, "Legacy open broker"):
1. compat spawns `compat-openbroker` for the principal in its own cgroup `…/system.slice/compat.service/openbroker-<session>.scope` (REQ-COMPAT-026) and passes its process to `LegacySpawn` through the spawn ordering below.
2. At `LegacySpawn.spawnLegacy`, `warden` writes a `kl_debug_pairs` entry keyed by the broker's cgroup ID, targeting the legacy app's cgroup, scope `process`, with no expiry while the app runs. `kl-exec`'s `ptrace_access_check` hook then allows that broker, and only that broker, ptrace-mode access to processes in that cgroup; every other `ptrace_access_check` from the broker fails.
3. The broker holds the capability the kernel's own check requires for a cross-UID read (`CAP_SYS_PTRACE`, ambient, granted by warden for the `compat-openbroker` entrypoint only). The pairing narrows it to one target cgroup; seccomp (REQ-COMPAT-025) removes `ptrace(2)`, `process_vm_writev` and `pidfd_getfd`, so the broker can read memory but never attach, write or steal fds. Yama `ptrace_scope ≥ 1` stays in force for everything else.

**Spawn ordering.** compat first spawns `compat-openbroker` (waiting on its channel; entrypoint seccomp profile `openbroker-1`), then calls `LegacySpawn.spawnLegacy(spec, view, brokerSession)` with that broker's session, so that warden can resolve the broker's cgroup for the pairing, then hands `notifyFd` to the broker over the channel. One broker serves exactly one legacy app, because `kl_debug_pairs` holds one target per tracer (`protocols §9.3`).

**The `compat-init` channel.** `compat-init` runs inside the legacy principal and holds its routes (`broker#principal` like every principal). It keeps the app's grants: persistent grants re-materialised at start (`Broker.myGrants`, `Broker.materialize`) and session grants obtained by powerbox. Over the private channel (repo-local schema `compat-init.capnp`, file ID `@0xb3c4d5e6f7090002`), the broker asks it `openUnder(viewPath, flags) -> (fd | none)` and `pick(kind, title, suggestedName) -> fd`. Whatever `compat-init` returns is something the app's own principal could open, so a subverted `compat-init` gains nothing.

**Decision algorithm** for each notification `n`:

```
path = read_cstring(target, n.data.args[path_arg], max=4096)        # process_vm_readv
if !ID_VALID(n.id): drop
base = view-relative name of the *at dirfd (or of the cwd for AT_FDCWD), see "Target cwd" below
abs = normalise(path, base)                                         # lexical; '..' clamped at view root
if abs is inside the view and not under a promptable prefix: respond CONTINUE
if abs is under promptable prefix P:
     fd = compat-init.openUnder(abs, flags)                         # opens beneath a grant, RESOLVE_BENEATH|RESOLVE_NO_MAGICLINKS
     if none: fd = compat-init.pick(openFile|saveFile per flags, "<App> wants to open <basename>", basename)
              (the user may pick a different file; the injected fd is what the user picked)
     if fd: ADDFD(n.id, fd, SEND, O_CLOEXEC from flags); receipt legacy.open
     else: respond ENOENT
else: respond ENOENT
```

**Target cwd.** `*at` calls with `AT_FDCWD` and relative paths, and calls with an explicit dirfd, are resolved by reading `/proc/<pid>/fd/<n>` and `/proc/<pid>/cwd` link text **as names within the view**. Those names are only used to classify the path. The broker never opens through them.

**Promptable prefixes**, default and configurable per app:

| View path | User real location |
|---|---|
| `/home/user/Documents`, `/home/user/Downloads`, `/home/user/Pictures`, `/home/user/Music`, `/home/user/Videos`, `/home/user/Desktop` | The XDG directories of the human (through the powerbox) |
| `/media`, `/run/media/user` | Removable media through `devd` and the powerbox |

Everything else outside the view is `ENOENT`, as if it did not exist.

**Modes** (`compat.openBroker`):

| Mode | Behaviour |
|---|---|
| `prompt` | Default for GUI apps |
| `deny` | No prompts: the app sees only its view and grants. Default for CLI tools and services |
| `off` | No seccomp trap: zero overhead, the same visibility as `deny` |

**Legacy services** (`compat.openBroker = "off"` always): tier-L legacy service generations run without a broker; their grants are fixed in the service set.

### 4.7 Xwayland

- `compat-init` starts `Xwayland :0 -rootless -noreset -nolisten tcp -nolisten local -listenfd <fd> -wm 11` with `WAYLAND_DISPLAY` set to the app's tagged socket (§4.3 step 5 hands the other WM end to atrium).
- Clipboard between X11 and Wayland goes through Xwayland's normal bridge, so it is subject to atrium's focused-client clipboard and label policy.
- XAUTHORITY: a per-instance cookie in the app's private `/tmp`.

### 4.8 D-Bus islands

#### 4.8.1 Session island

Per app:
- `dbus-broker` runs as the app's UID inside its sandbox, at `unix:path=/run/user/1000/bus`.
- `compat-dbus-gate` is a bus client that **owns** the bridged well-known names and translates calls to keylos capwire services, using the routes of the app's own principal.

| Bridged name and interface | keylos target | Notes |
|---|---|---|
| `org.freedesktop.Notifications` (Notify, CloseNotification, GetCapabilities, GetServerInformation) | `portal-notify` `Notify` | Actions mapped through a `NotifyHandler` that emits `ActionInvoked` |
| `org.freedesktop.portal.Desktop` → `org.freedesktop.portal.FileChooser` (OpenFile, SaveFile) | `Broker.powerbox` | Tier L: the gate returns the picked file's **view path** under a promptable prefix (for example `/home/user/Documents/report.odt`) and records a session grant in `compat-init`. When the app opens that path, the open broker finds the grant and injects the fd without a second prompt. Native apps with a portal island use `PowerboxGrant.viewPath` (`/grants/<name>/…`) instead |
| `org.freedesktop.portal.OpenURI` | `portal-openuri` `OpenUri` | |
| `org.freedesktop.portal.ScreenCast` / `Screenshot` | `portal-screen` `ScreenCapture` | PipeWire node via the remote fd |
| `org.freedesktop.portal.Camera` | `portal-camera` `Camera` | |
| `org.freedesktop.portal.Print` | `portal-print` `Print` | |
| `org.freedesktop.portal.Settings` (read-only appearance keys) | Static values from the config generation | |
| `org.freedesktop.secrets` (Secret Service API subset: OpenSession plain/dh-ietf1024, SearchItems, GetSecrets, CreateItem) | `vault` (facet `app`, items namespaced `compat/<app>/…`) | Tier L only. The app only sees its own items; this fixes CVE-2018-19358 for legacy apps |
| `org.mpris.MediaPlayer2.*` | Exported to atrium (media controls) | Read-only properties plus PlayPause/Next/Previous |

Island policy (`/.compat/etc/dbus-gate/allowlist.json`) is part of the runtime generation. Per-app additions come only from the manifest's `compat.dbus.bridge` list, which may name only entries present in the system allowlist.

#### 4.8.2 Tier-2 islands

Inside VMs the same gate runs and bridges to `GuestPortals` (REQ-COMPAT-035), which `bench-relay` serves on vsock 7004 as the VM principal:

| D-Bus API (guest) | `GuestPortals` method | Notes |
|---|---|---|
| `org.freedesktop.Notifications.Notify` | `notify` | Actions are dropped (no activation path into the guest in 1.0); the notification is attributed to the VM's generation |
| `org.freedesktop.portal.OpenURI` | `openUri` | Web URIs open in the untrusted browser on the host |
| `org.freedesktop.portal.Print` | `print` | The document is streamed from the guest |
| `org.freedesktop.portal.FileChooser` | `powerbox` | Files land in the `grants` share, directories as hot-plugged shares; the gate returns the guest path |
| `org.freedesktop.portal.Screenshot`, `ScreenCast` | `capture` | Frames of this VM's own display only |
| `org.freedesktop.secrets` | `secret` | Read-only lookups by item name; items must be ACL'd to the VM's generation in vault; writes stay in an in-guest store |

#### 4.8.3 System daemon islands

- A legacy service (for example BlueZ) is packaged by `pkgs` as a tier-L `legacy-image` service generation with `compat.dbus.system = true`, started by `warden` through compat's `service` facet (`Compat.run` of tier-L legacy services).
- `compat-init` starts a private `dbus-broker --scope system` inside that service's sandbox, then starts the daemon.
- The keylos adapter (devd's Bluetooth adapter, portal-print's CUPS adapter, vault's legacy-keyring import) calls `CompatIsland.islandSocket(service)` on route `compat#adapter`. `compatd` returns a socket connected to the island's `compat-dbus-gate` in **adapter mode**: it forwards the whole system-bus API of that daemon to the adapter and nothing else.
- No other principal can reach the island.

| Island `service` | Image | Adapter (holder of `compat#adapter`) |
|---|---|---|
| `bluez` | `io.keylos.legacy.bluez` | devd |
| `cups` | `io.keylos.legacy.cups` | portal-print |
| `sane` | `io.keylos.legacy.sane` | portal-scan |

**SANE island.** `io.keylos.legacy.sane` runs `saned` (SANE network protocol version 3) with the scanner backends, inside its own tier-L service sandbox. It is not a D-Bus island: for `islandSocket("sane")`, `compatd` returns a stream socket connected to `saned`'s inetd-style listener inside the island (one connection per call, the island accepts only connections from compat). The island holds only the scanner's authorized USB device (granted through devd and the broker) and, for network scanners (eSCL/AirScan backends), gate grants to the configured scanner addresses. `portal-scan` speaks the SANE protocol over the socket and never loads backends itself.
| `secret-import` | (no daemon; a one-shot reader of legacy keyring files the user picked) | vault |

### 4.9 Legacy secret import

`compat import-secrets` lets a human move secrets from a legacy keyring file (GNOME Keyring `*.keyring`, KWallet `*.kwl`, `pass` store) into `vault`:
1. The user picks the file through the powerbox in the CLI.
2. compat parses it **inside an import worker VM** (never on the host) and returns a list of entries with names only.
3. For each entry the user confirms, compat calls `Vault.store` on route `vault#adapter` with an ACL limited to the app the user names; vault prompts on the trusted path per its own rules.
4. Receipts: `x-compat.bridge` with the count (never names or values).

### 4.10 Games and Steam

- Steam runs as a tier-2 legacy image (Flatpak `com.valvesoftware.Steam` or OCI import), with `needs.gpu = "render"`, the GPU in a VM through native context, Proton inside the guest, and controllers through `devd` USB HID grants passed into the VM (uhid via virtio-input).
- Expected performance with native context on AMD and Intel: 85–95% of native frame rate.
- Kernel-level anti-cheat is unsupported.
- The game library lives in a dedicated large `state` share (configurable location).
- VM memory defaults are raised by the `games` profile (`compat.vmProfile = "games"`: 8 vCPUs, 16 GiB, hugepages when available).

---

## 5. Interfaces

### 5.1 capwire

compat implements `Compat` (`protocols §7.3.15`) and `CompatIsland` (`protocols §7.5.15`). Every bootstrap capability also implements `common.Extensible`. Facets are exactly those of `protocols §19.2`:

| Facet | Callers | Allowed |
|---|---|---|
| `user` | `kish`, atrium launcher | `importImage` (the human approves the network grants), `run` for the caller's apps |
| `service` | `warden` routes for legacy services | `run` of tier-L legacy services |
| `adapter` | devd, portal-print, portal-scan, vault | `CompatIsland.islandSocket` |
| `admin` | owner `shell` (the `compat` CLI) | All, plus `CompatAdmin` below |

`CompatAdmin` is repo-local (file ID outside the protocols range), obtained with `Extensible.ext` on facet `admin`:

```capnp
@0xb3c4d5e6f7090001;
using C = import "common.capnp";
interface CompatAdmin {
  apps          @0 () -> (json :Text);                         # installed legacy apps with placement, grants, vmGroup
  remove        @1 (generation :C.Ref, keepData :Bool) -> ();
  setGroup      @2 (appName :Text, vmGroup :Text) -> ();
  setOpenBroker @3 (appName :Text, mode :Text) -> ();          # prompt | deny | off
  permissions   @4 (appName :Text) -> (json :Text);            # mapped needs + persisted grants
  importSecrets @5 (file :C.Fd, format :Text) -> (json :Text); # §4.9; returns entry names only
}
```

### 5.2 Routes compat holds

| Holder | Route | Use |
|---|---|---|
| `compatd` | `warden#compat` | `LegacySpawn.spawnLegacy` (with `brokerSession`); `GrantMounts.idmappedDir`; `Supervisor.spawn` of compat entrypoints (`compat-openbroker`, seccomp profile `openbroker-1`) |
| `compatd` | `bench#compat` | Import workers and tier-2 VMs |
| `compatd` | `depot#compat`, `depot#mounter` | `importTree`, `get`, `revocationStatus`; `mount`, `root`, `unroot` |
| `compatd` | `strata#compat` | `createUnit`, `forget` for `app/*` units |
| `compatd` | `broker#principal` | `request` (import network grants), `materialize` |
| `compatd` | `vault#adapter` | `store` during secret import |
| `compatd` | `atrium#display` | `Display.xwaylandWm` |
| `compatd` | `ledger#writer` | Receipts |
| `compat-init`, `compat-dbus-gate` (inside the app principal) | the app's own routes (`broker#principal`, `vault#app`, the portals in `needs.services`) | Powerbox, bridged APIs |

### 5.3 CLI `compat`

| Command | Effect | Exit |
|---|---|---|
| `compat import <source> [--name n] [--packages p1,p2] [--arch a] [--yes-network]` | Import from `oci://…`, `flatpak://<remote>/<ref>`, `distro:debian:<suite>`, `distro:fedora:<rel>`, `distro:arch:rolling`, or `rootfs:<dir>` (a directory given on the command line, passed as an fd) | 0; 2 denied; 3 verification failed; 4 normalisation rejected |
| `compat ls` | List legacy apps: name, version, origin, placement (L/2), VM group, data size | 0 |
| `compat run <name\|gen> [-- args…]` | Run | The app's exit code; 125 compat error |
| `compat info <name>` | Manifest, compat object, warnings, provenance | 0 |
| `compat permissions <name>` | Mapped needs, grants, open-broker mode, D-Bus bridges | 0 |
| `compat group <name> <group\|--none>` | Set the VM group | 0 |
| `compat open-broker <name> prompt\|deny\|off` | Set the mode | 0 |
| `compat update <name>` | Re-import from the recorded source (new tag resolution); shows the capability diff | 0; 2 consent refused |
| `compat rm <name> [--keep-data]` | Remove | 0 |
| `compat import-secrets <file> --format gnome\|kwallet\|pass --for <app>` | §4.9 | 0; 2 denied |
| `compat remotes` / `compat remote add <name> <url> --gpg-key <file>` | Manage Flatpak remotes and distro mirrors (config proposals; applied through `config`) | 0 |

All commands ship `cmdsig` files; list outputs are `records`.

### 5.4 The `compat` manifest object (`keylos.compat/1`)

This fills the `compat` field of `protocols §6.3` for `kind = legacy-image`. This repository owns the format (`protocols §19.4`).

```json
{
  "schema": "keylos.compat/1",
  "origin": {"format": "oci|flatpak|distro|rootfs|forge", "source": "…", "resolved": "…",
             "internet": true, "signature": {"verified": true, "identity": "…"}},
  "entrypoints": {"main": {"exec": "/usr/bin/app", "args": [], "env": {}, "workdir": "/home/user"}},
  "desktop": [{"id": "org.example.App", "name": "App", "exec": "main", "icon": "/usr/share/icons/hicolor/256x256/apps/app.png", "mime": []}],
  "view": {"homeName": "user", "promptPrefixes": ["~/Documents", "~/Downloads"], "extraTmpfs": [], "shm": true},
  "openBroker": "prompt",
  "x11": false,
  "dbus": {"session": true, "system": false, "bridge": ["org.freedesktop.Notifications"]},
  "service": null,
  "vmGroup": null,
  "vmProfile": "default|games|small",
  "userns": {"blocks": 1},
  "warnings": ["setuid bit removed from /usr/bin/x"]
}
```

Field rules:
- `origin.internet` is `true` for every import; only `forge`-built images have `false`.
- `service`: `null`, or for legacy service images `{"name": "bluez", "island": true, "devices": ["dev:bluetooth:*"], "restart": "on-failure"}`.
- `userns.blocks` is always 1 in 1.0.
- `dbus.bridge` entries MUST be a subset of the system allowlist.
- Unknown fields are rejected, except `x-` fields, which carry no meaning.

Validation: the JSON Schema `jsonschema/compat-1.json` ships in this repository.

---

## 6. Security

### 6.1 Threats and mitigations

| # | Threat | Mitigation |
|---|---|---|
| C1 | Malicious image exploits a parser on the host (tar bombs, path traversal, OSTree bugs) | All parsing in the import worker VM (REQ-COMPAT-001). The host re-validates only a plain directory tree with `openat2` (no symlink following) |
| C2 | setuid or file capabilities give in-sandbox privilege | Stripped at import (REQ-COMPAT-004); the user namespace maps UID 0 to an unprivileged block; `no_new_privs` |
| C3 | Legacy app reads user files | The view contains only its own state and grants; ungranted opens get `ENOENT` or a prompt |
| C4 | Open-broker TOCTOU (a path changed after the check) | The broker never answers `CONTINUE` under promptable prefixes (REQ-COMPAT-024); files there are opened beneath grants by `compat-init` and injected; `NOTIF_ID_VALID` |
| C5 | Prompt spam or spoofed prompts | Rate limits; prompts rendered by atrium on the trusted path with the app's tier badge; titles composed by compat, not the app |
| C6 | X11 keylogging and screenshots of other apps | Nested Xwayland per app: an X client can only see windows of its own app |
| C7 | D-Bus as ambient authority | Private bus per app; the gate bridges only allowlisted APIs to capability-checked services; no session or system bus exists on keylos |
| C8 | Secret Service leaks other apps' secrets | Bridged to vault with app-scoped items |
| C9 | Kernel attack surface from a legacy app on the host (tier L) | Only forge-built, reproducible, release- or publisher-signed images run in tier L; seccomp baseline still applies; the user namespace is created by `warden` with nesting disabled and owns no network namespace with admin power |
| C10 | Compromised `compat-openbroker` abuses `CAP_SYS_PTRACE` | BPF LSM restricts ptrace targets to its associated legacy cgroup; the broker holds no grant fds at all |
| C11 | Flatpak manifest overreach | Permissions translated as requests; dangerous ones dropped (§4.4); the capability diff is shown at import and update |
| C12 | Subverted `compat-init` returns a wrong fd | It runs as the app principal and can only return what that principal could open anyway |
| C13 | Island socket handed to the wrong adapter | `islandSocket` is served only on facet `adapter`, whose holders are fixed by `protocols §19.2`; each `service` name maps to one island and one adapter |
| C14 | Open broker's memory access abused against other processes | The `kl_debug_pairs` pairing names one broker cgroup and one app cgroup; seccomp denies `ptrace`, `process_vm_writev` and `pidfd_getfd` (REQ-COMPAT-025) |
| C15 | Malicious scanner backend or network scanner | SANE backends run only in the island; `portal-scan` parses only the SANE wire protocol with size limits |
| C16 | Tier-2 app uses guest portals to reach host data | `bench-relay` calls portals as the VM principal (tier 2), so portal rules and labels apply; secrets only for items whose vault ACL names the VM generation |

### 6.2 Confinement of compat itself

| Process | Tier | Holds | Extra allowances |
|---|---|---|---|
| `compatd` | 0 | The routes of §5.2; a dirfd for `/var/lib/compat` | None beyond baseline |
| `compat-openbroker` | 0 (sub-session per app, own cgroup) | The listener fd, the target pidfd, the `compat-init` channel | Seccomp profile `openbroker-1`: `process_vm_readv` (paired target only, `kl_debug_pairs`), ambient `CAP_SYS_PTRACE` narrowed by the pairing, `ioctl(SECCOMP_IOCTL_NOTIF_*)`; denied: `ptrace`, `process_vm_writev`, `pidfd_getfd` |
| `compat-init`, `compat-dbus-gate` | Inside the app principal (tier L) or the guest (tier 2) | The app's own routes, bus socket | Baseline of the app |

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| Import network failure | Worker exits non-zero; `compat import` exits 2 or 3 with the worker log; nothing imported |
| Signature verification failure | Exit 3; the worker's output is discarded; receipt `legacy.import` with `result: "rejected"` |
| Normalisation rejection (UID > 65535, too large) | Exit 4 with the offending path |
| Open broker crash | Trapped opens fail with `ENOSYS`, which the kernel returns when the listener closes. compat kills the principal (`Process.kill`): a legacy app without its broker is not supported. atrium shows a notification |
| `compat-init` killed by the app | Prompt-prefix opens fail with `ENOENT` (fail closed); the app keeps running |
| Xwayland crash | `compat-init` restarts it once; the X11 app will usually exit |
| Island adapter unavailable | Bridged calls return `org.freedesktop.DBus.Error.ServiceUnknown` |
| Open-broker pairing missing (warden did not write it) | `process_vm_readv` fails with `EPERM`; the broker answers every trapped open with `EACCES` and compat kills the principal with a notification (fail closed) |
| `GuestPortals` unavailable in a tier-2 guest | Bridged APIs answer `ServiceUnknown`; the app keeps running |
| SANE island crash | `islandSocket("sane")` returns a socket that closes; compat restarts the island once per minute |
| Tier-2 VM fails to start (no KVM) | `kl:unsupported`; never falls back to tier L |
| `compatd` restart | Running legacy principals keep running; their open brokers are separate processes. compat re-adopts them from `/var/lib/compat/running.json` |

---

## 8. Performance budgets

| Operation | Budget |
|---|---|
| Tier-L legacy app launch overhead versus a native tier-1 app | ≤ 40 ms (user namespace + view + `compat-init`), plus ≤ 80 ms when Xwayland is needed |
| Tier-2 app launch (VM restore from the per-group base snapshot) | ≤ 600 ms p95 to first window, excluding the app's own startup |
| Trapped open, `CONTINUE` path | ≤ 15 µs p50, ≤ 50 µs p99 added latency |
| Trapped open, granted (persisted) path | ≤ 120 µs p99 (includes the `compat-init` round trip) |
| OCI import of a 500 MiB image (cached layers excluded) | Network-bound + ≤ 20 s processing |
| D-Bus bridge call (Notify) | ≤ 5 ms p95 |

---

## 9. Observability

**Logs:** fields `app`, `gen`, `placement`, `op`.

**Receipts** (route `ledger#writer`):

| Event | Kind | `data` |
|---|---|---|
| `legacy.import` | core (`protocols §19.3`) | source, resolved, format, generation, result, warnings count |
| `legacy.open` | core | app, view path, grant id or `picked`, result |
| `x-compat.bridge` | repo-local | app, D-Bus name and method, target service, result (secret import: count only) |

**Metrics:**

| Metric | Type |
|---|---|
| `compat_apps{placement}` | gauge |
| `compat_openbroker_notifications_total{result=continue\|granted\|prompted\|denied}` | counter |
| `compat_openbroker_latency_seconds` | histogram |
| `compat_import_seconds{format}` | histogram |
| `compat_bridge_calls_total{name}` | counter |

---

## 10. Configuration

Nickel module `keylos/config/compat@1`:

```nickel
{
  compat | {
    enabled | Bool | default = true,
    import | {
      registries | Array String | default = ["ghcr.io", "docker.io", "quay.io", "registry.fedoraproject.org"],
      flatpak_remotes | { _ : { url | String, gpg_key | String } } | default = { flathub = { url = "https://dl.flathub.org/repo/", gpg_key = "flathub.gpg" } },
      distro_mirrors | { debian | Array String | default = ["deb.debian.org"], fedora | Array String | default = ["dl.fedoraproject.org"], arch | Array String | default = ["geo.mirror.pkgbuild.com"] },
      max_size_gib | Number | default = 64,
      max_entries | Number | default = 2000000,
      expected_signers | { _ : String } | default = {},     # oci repo → Sigstore identity regex
    } | default = {},
    open_broker | {
      default_gui | [| 'prompt, 'deny, 'off |] | default = 'prompt,
      default_cli | [| 'prompt, 'deny, 'off |] | default = 'deny,
      prompt_prefixes | Array String | default = ["~/Documents", "~/Downloads", "~/Pictures", "~/Music", "~/Videos", "~/Desktop"],
      reprompt_secs | Number | default = 600,
    } | default = {},
    dbus_bridge_allowlist | Array String | default = [
      "org.freedesktop.Notifications", "org.freedesktop.portal.FileChooser", "org.freedesktop.portal.OpenURI",
      "org.freedesktop.portal.ScreenCast", "org.freedesktop.portal.Screenshot", "org.freedesktop.portal.Camera",
      "org.freedesktop.portal.Print", "org.freedesktop.portal.Settings", "org.freedesktop.secrets", "org.mpris.MediaPlayer2" ],
    islands | { _ : { image | String, adapter | [| 'devd, 'portal-print, 'portal-scan, 'vault |] } } | default = {
      bluez = { image = "io.keylos.legacy.bluez", adapter = 'devd },
      cups = { image = "io.keylos.legacy.cups", adapter = 'portal-print },
      sane = { image = "io.keylos.legacy.sane", adapter = 'portal-scan } },
    vm_profiles | { _ : { vcpus | Number, memory_gib | Number, hugepages | Bool | default = false } } | default = {
      default = { vcpus = 2, memory_gib = 2 }, small = { vcpus = 1, memory_gib = 1 }, games = { vcpus = 8, memory_gib = 16, hugepages = true } },
  }
}
```

---

## 11. Testing and acceptance

**Unit tests:**
- Flatpak permission mapping table (every row of §4.4).
- Normalisation rules.
- Open-broker path classification (lexical normalisation, clamping, prefix mapping).
- Placement decision table (§4.3) for every combination of `origin.format`, `internet`, `tier`, `reproducible` and `sealedBy`.
- `keylos.compat/1` schema validation.

**Fuzz targets:**

| Target | Input |
|---|---|
| `fuzz_meta_json` | The import worker output |
| `fuzz_tree_walk` | Adversarial directory trees (symlink loops, deep nesting) fed to the host re-validator |
| `fuzz_openbroker_paths` | Arbitrary path bytes and cwd combinations |
| `fuzz_dbus_gate` | Arbitrary D-Bus messages into the gate |
| `fuzz_compat_init_channel` | Arbitrary messages on the `compat-init` channel |

**Conformance:** protocols vectors `manifest/` (including the compat section), `capwire/`, `ids/`.

**Acceptance tests:**

| ID | Test | Pass criterion |
|---|---|---|
| AT-COMPAT-01 | Import `oci://docker.io/library/alpine@sha256:<pinned>` | Generation created, `tier = 2`; the host never opened a tar (fanotify on the host shows no reads of layer blobs by compatd) |
| AT-COMPAT-02 | Import Flathub `org.gnome.TextEditor` | `filesystem=home` dropped; app runs in a VM; File → Open shows the powerbox; the picked file is editable; other home files invisible |
| AT-COMPAT-03 | Tier-L forge-built legacy app does `cat ~/.ssh/id_ed25519` | `ENOENT`; no prompt (`~/.ssh` is not a promptable prefix) |
| AT-COMPAT-04 | Same app opens `~/Documents/report.odt` | Prompt; on approval it opens; receipt `legacy.open` |
| AT-COMPAT-05 | X11 app runs `xwd -root` | Captures only its own windows |
| AT-COMPAT-06 | Legacy app calls `org.freedesktop.secrets` GetSecrets for another app's item | Not found |
| AT-COMPAT-07 | Image with a setuid binary | Bit cleared; warning recorded |
| AT-COMPAT-08 | Attempt to lower an imported image to tier L via the CLI or API | No such operation; a crafted manifest is rejected because the generation is not signed by a release or publisher key |
| AT-COMPAT-09 | BlueZ island: devd adapter pairs a device | Works; no other principal can obtain the island socket (`islandSocket` on any other facet → `kl:denied`) |
| AT-COMPAT-10 | Open-broker overhead: `find / -type f \| xargs cat > /dev/null` in a tier-L CLI app with mode `prompt` versus `off` | ≤ 25% slower |
| AT-COMPAT-11 | Kill `compat-init` in a running tier-L app, then open `~/Documents/x` | `ENOENT`; no prompt; app keeps running |
| AT-COMPAT-12 | `LegacySpawn` returns `notifyFd`; check `Process.confinement` | `userns: true`, `seccompProfile` includes the user-notification filter, no other namespaces owned |
| AT-COMPAT-13 | `compat import-secrets` with a GNOME keyring file | Parsing happens in a worker VM; only confirmed entries reach `Vault.store`; receipt contains counts only |
| AT-COMPAT-14 | Open broker reads a trapped path | Succeeds via the pairing; the same broker calling `process_vm_readv` on another legacy app's process gets `EPERM`; `ptrace(PTRACE_ATTACH)` is killed by seccomp |
| AT-COMPAT-15 | Tier-L app with gate TLS interception active | `SSL_CERT_FILE` and the three other variables point at `/run/keylos/gate/ca.pem`; `curl https://granted.host` succeeds; without interception the variables are unset |
| AT-COMPAT-16 | Tier-2 Flatpak app sends a notification and opens a link | The notification appears attributed to the app; the link opens in the untrusted browser |
| AT-COMPAT-17 | SANE island | `portal-scan` obtains a socket only through facet `adapter`; a scan returns an image; no other principal can reach `saned` |
| AT-COMPAT-18 | Two legacy apps started | Two `compat-openbroker` processes, each in its own cgroup; warden's trace shows `spawnLegacy` with each broker's `brokerSession`; broker A's `process_vm_readv` on app B fails `EPERM`; `Process.confinement` of each broker reports `seccompProfile: openbroker-1` |
| AT-COMPAT-19 | Revocation age fixture of 31 days and a forge-built legacy image installed after the list was issued | Placed on the tier-2 path; `compat permissions` shows the offline reason; with a fresh list it runs in tier L |
| AT-COMPAT-20 | `islandSocket` for `cups`, `cups-dbus`, `sane`, `bogus` | IPP over HTTP, D-Bus proxy, SANE stream, `kl:not-found` respectively |

---

## 12. Implementation notes

| Crate | Use |
|---|---|
| `tokio` 1, `keylos-capwire`, `keylos-schemas` 1.0.0 | Services |
| `libseccomp` 0.3 (`libseccomp-rs`) | User-notification structures; the filter itself is installed by `warden` |
| `nix` 0.29, `rustix` 0.38 | `process_vm_readv`, `pidfd`, `openat2` |
| `zbus` 4 | `compat-dbus-gate` (talks to the private dbus-broker) |
| `oci-spec` 0.7, `oci-client` 0.12 | Import worker (OCI) |
| `flatpak` CLI, `mmdebstrap`, `dnf`, `pacstrap` | Import worker (inside the VM only) |
| `serde_json`, `jsonschema` 0.18 | Validation |

**Repository layout:**

```
compat/
  crates/compatd/  crates/openbroker/  crates/openbroker-guest/  crates/dbus-gate/
  crates/compat-run/ crates/compat-init/ crates/compat-importer/ crates/cli/
  crates/keylos-compat-manifest/
  schema/compat-admin.capnp schema/compat-init.capnp     (repo-local)
  jsonschema/compat-1.json
  allowlists/dbus-gate.json
  recipes/          forge recipes for io.keylos.compat, io.keylos.compat.runner, io.keylos.compat.x11
  tests/
```

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reason |
|---|---|---|
| Legacy tier with FHS views ([ADR-0037](../../handbook/11-decisions/adr-0037-legacy-tier-fhs-views.md)) | Require native ports; full container runtime | Adoption needs unmodified software; views keep authority explicit |
| Imported images always tier 2 ([ADR-0043](../../handbook/11-decisions/adr-0043-non-reproducible-means-tier-2.md), [ADR-0008](../../handbook/11-decisions/adr-0008-host-executes-only-sealed-code.md)) | Owner "promote" to the host | Keeps "host executes only sealed, reproducible code" true; an owner seal is meant for code the owner built, not blobs |
| Parsing in VMs | Host-side `umoci`/`ostree` | Foreign formats are a classic parser attack surface |
| Open broker injects fds obtained by the app's own `compat-init` | `CONTINUE` after check; broker holding grant roots; FUSE document portal | TOCTOU-free; the privileged broker holds no file authority at all; no FUSE attack surface |
| Per-app D-Bus islands with a bridge ([ADR-0035](../../handbook/11-decisions/adr-0035-fd-only-portals-dbus-islands.md)) | Session bus with an xdg-dbus-proxy-style filter | No ambient bus at all; a bridge to capability-checked services |
| Per-app nested Xwayland | Shared Xwayland | X11 has no intra-server isolation |
| User namespaces only here ([ADR-0025](../../handbook/11-decisions/adr-0025-namespaces-only-by-warden.md)) | User namespaces everywhere | Legacy software is the only consumer that needs UID remapping |

### 13.1 Dependencies and open points

compat uses only interfaces, facets and formats of keylos-protocols 1.0.0 (final). It relies on:
- `warden` writing the open-broker `kl_debug_pairs` entry at `LegacySpawn` time and granting ambient `CAP_SYS_PTRACE` only to the `compat-openbroker` entrypoint (`protocols §9.3`).
- `bench` serving `GuestPortals` on vsock 7004 for tier-2 VMs through `bench-relay`.
- `pkgs` packaging `io.keylos.legacy.bluez`, `io.keylos.legacy.cups` and `io.keylos.legacy.sane` as tier-L legacy service images.
- `gate` writing `/run/keylos/gate/ca.pem` into tier-L views when it intercepts TLS.

The earlier open points (how warden learns the broker's cgroup, the pairing's access modes, the `islandSocket` protocol per island) are resolved by protocols 1.0.0 (final): `LegacySpawn.spawnLegacy(…, brokerSession)`, the `PTRACE_MODE_READ` + `PTRACE_MODE_ATTACH_REALCREDS` pairing with seccomp profile `openbroker-1`, and the per-island protocol list in `protocols §7.5.15`. No open protocol gaps remain.

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

### A.2 `protocols §6.1` — Generation kinds

| Kind | Content | Mounted by |
|---|---|---|
| `os` | Base OS tree (`/usr`, plus the initial `/` skeleton) | `boot` (initrd) |
| `runtime` | Shared library/runtime tree used by apps | `warden` (in app views) |
| `app` | A desktop or CLI application | `warden` |
| `service` | A system service | `warden` |
| `agent-template` | Harness, tool definitions, prompt and policy for an agent (§6.4) | `aide` → `bench` |
| `bench-image` | Guest OS image for workbenches and tier-2 VMs | `bench` |
| `legacy-image` | Imported foreign rootfs (OCI, Flatpak, distro); format in the `compat` spec (`keylos.compat/1`) | `compat` → `bench`/`warden` |
| `config` | Rendered configuration tree (a confext) | `boot` |
| `policy` | Cedar policy set + Biscuit authorizer templates | `broker` |
| `data` | A static data set (fonts, models, datasets) | `warden` (read-only bind) |
| `part` | A build intermediate (a derivation output that is not itself launchable: libraries, headers, toolchain parts) | `forge`, `bench` (store mounts) |
| `container` | An OCI container image converted deterministically into a generation, signed by an org publisher (§21); runnable only by `cri` in the `keylos-sealed` runtime class | `warden` (for `cri`) |
| `kmod` | Out-of-tree kernel modules built by the project for one exact kernel release (`/lib/modules/<uname>/extra/*.ko`, each module signed with the release stream's module-signing key) | `boot`, `warden` (module path only) |

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

### A.9 `protocols §7.3.6` — `vault.capnp`

```capnp
@0xc7a1e5d3b2f40006;
using C = import "common.capnp";

struct ItemAcl {
  actors  @0 :List(Text);        # actor patterns, e.g. "app:gen:fsv256:…", "app:name=org.example.Editor"
  ops     @1 :List(Op);
  prompt  @2 :PromptPolicy;
  enum Op { read @0; use @1; update @2; delete @3; }
  enum PromptPolicy { never @0; perSession @1; always @2; presence @3; }
}

struct ItemInfo { name @0 :Text; kind @1 :Text; created @2 :C.Timestamp; acl @3 :ItemAcl; }

interface Vault {
  open    @0 (name :Text, purpose :Text) -> (secret :C.Fd);       #! delivery format §20.10 (memfd_secret, mmap-only, length-prefixed)
  store   @1 (name :Text, kind :Text, value :C.Fd, acl :ItemAcl) -> ();   # value.index 0xFFFF = ACL-only update
  delete  @2 (name :Text) -> ();
  list    @3 () -> (items :List(ItemInfo));
  sign    @4 (name :Text, alg :Text, data :Data) -> (signature :Data);   # key never leaves vault
  sshAgent @5 () -> (socket :C.Fd);                                     # per-principal SSH agent protocol socket
  dataKey @6 (unit :Text) -> (key :C.Fd);                                # crypto-shred unit key (facets strata, ledger, gate, aide, journal, loom; each only for its own unit prefix)
  forget  @7 (unit :Text) -> ();                                         # destroy unit key (same facets)
  inject  @8 (name :Text, target :Text) -> (handle :Data);              # facet gate only: opaque handle for credential injection
}
```

An injection handle is redeemed by `gate` with `open("inject:<hex handle>", purpose)` on facet `gate`.

### A.10 `protocols §7.3.8` — `depot.capnp`

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

### A.11 `protocols §7.3.10` — `strata.capnp`

```capnp
@0xc7a1e5d3b2f40010;
using C = import "common.capnp";

enum NetworkPolicy { deny @0; gate @1; inherit @2; }
  #! deny: processes in the transaction get no network; gate: egress only via gate with the caller's tokens; inherit: the spawner's own policy

struct Change { path @0 :Text; kind @1 :Kind; enum Kind { added @0; modified @1; deleted @2; renamed @3; meta @4; } from @2 :Text; }

struct Conflict { path @0 :Text; reason @1 :Text; }

interface Transaction {
  id      @0 () -> (id :Text);
  view    @1 () -> (dirs :List(C.Fd));         # O_PATH dirfds of the overlay views (same order as begin)
  changes @2 () -> (changes :List(Change));
  diff    @3 (path :Text) -> (diff :C.Fd);
  conflicts @4 () -> (conflicts :List(Conflict));
  commit  @5 () -> (snapshot :Text);           # returns pre-commit snapshot id (undo point)
  abort   @6 () -> ();
}

struct Provenance {
  principal   @0 :C.PrincipalId;
  generation  @1 :C.Ref;
  transaction @2 :Text;
  created     @3 :C.Timestamp;
  label       @4 :C.Label;
}

struct SnapshotInfo { id @0 :Text; subvolume @1 :Text; created @2 :C.Timestamp; reason @3 :Text; pinned @4 :Bool; }

interface Strata {
  begin     @0 (dirs :List(C.Fd), networkPolicy :NetworkPolicy) -> (txn :Transaction);   #! holding the dirfds is the authority
  snapshot  @1 (subvolume :Text, reason :Text) -> (info :SnapshotInfo);
  snapshots @2 (subvolume :Text) -> (list :List(SnapshotInfo));
  restore   @3 (snapshot :Text, path :Text, target :C.Fd) -> ();
  undo      @4 (transaction :Text) -> ();
  why       @5 (file :C.Fd) -> (provenance :Provenance);
  forget    @6 (unit :Text) -> ();             # crypto-shred a data unit
  createUnit @7 (path :C.Fd, unit :Text, policy :Text) -> ();
}
```

**Transaction storage backends.** `begin` dispatches each target dirfd to a registered backend. A plain btrfs directory uses the snapshot and overlay path. A plaintext view of a sealed unit served over FUSE (`keylos.unitfs/1`) is resolved through `strata`'s own mount records to (unit, relative subtree); `strata` clones the unit's ciphertext backing subvolume (a read-only base and a writable working clone) and serves a transaction-specific plaintext view of that subtree only. Changes and prepared merges are computed on the logical plaintext views; commit applies the logical operations to the live backing through the unit format, after quiescing the unit and fencing its writers. No plaintext upper layer, undo copy or journal content of a sealed unit is ever stored outside its encrypted backing; undo uses a ciphertext pre-commit snapshot, and `forget` of the unit aborts its transactions and leaves every transaction artifact undecryptable. While the unit is locked its transaction views are unavailable and commits fail `kl:unavailable`. Mixed backends in one transaction, nested units and cross-unit transactions fail `kl:unsupported`.

### A.12 `protocols §7.3.13` — `bench.capnp`

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

### A.13 `protocols §7.3.15` — `net.capnp`, `devd.capnp`, `journal.capnp`, `portals.capnp`, `compat.capnp`

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

### A.14 `protocols §7.5.1` — `warden-sys.capnp`

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

### A.15 `protocols §7.5.15` — `compat-sys.capnp`

```capnp
@0xc7a1e5d3b2f4002e;
using C = import "common.capnp";

interface CompatIsland {           # facet adapter (devd Bluetooth adapter, portal-print CUPS adapter, vault import island)
  islandSocket @0 (service :Text) -> (socket :C.Fd);
      #! connected socket to the island; the protocol depends on the island: "bluez", "cups-dbus" → filtered D-Bus proxy;
      #! "sane" → SANE network protocol (saned) stream; "cups" → IPP over HTTP/1.1; "secret-import" → filtered D-Bus proxy
}
```

### A.16 `protocols §7.5.16` — `display.capnp`

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

### A.17 `protocols §9.1` — Baseline for every non-kernel process except `warden` itself

1. `PR_SET_NO_NEW_PRIVS`.
2. Own cgroup, own dynamic UID (§10.3), no supplementary groups. Human-owned data and directory grants reach dynamic UIDs through **idmapped mounts** (§7.5.1); mapping-only user namespaces used for idmapping are held by `warden`, and no process ever runs inside them.
3. Landlock ruleset at the highest available ABI:
   - starts from deny-all for all handled access rights;
   - allows only the mount view (§10.1), `/grants` (runtime grant mounts) and explicitly granted fds/paths;
   - scopes `ABSTRACT_UNIX_SOCKET` and `SIGNAL`;
   - uses `RESTRICT_SELF_TSYNC` when available.
4. seccomp-bpf allowlist profile `baseline-1`, default action `ENOSYS`. Always denied:
   - `unshare`, `setns`, and namespace flags on `clone`/`clone3` (clone3 → `ENOSYS`, forcing the libc `clone` fallback, which is then flag-checked);
   - `io_uring_*`, `bpf`, `perf_event_open`, `userfaultfd`;
   - `keyctl`, `add_key`, `request_key`;
   - `kexec_*`, `init_module`, `finit_module`, `delete_module`;
   - `mount`, `umount2`, `pivot_root`, `chroot`, `fsopen`, `fsmount`, `fsconfig`, `move_mount`, `open_tree`, `mount_setattr`;
   - `ptrace`, `process_vm_readv`, `process_vm_writev`;
   - `personality` (except the default);
   - `acct`, `swapon`, `swapoff`, `reboot`, `settimeofday`, `clock_settime`, `clock_adjtime`, `adjtimex` (read-only calls included: seccomp cannot inspect `struct timex`, so both are denied with `EPERM`);
   - `ioctl` `TIOCSTI` and `TIOCLINUX`.
5. Namespaces created by `warden` without a user namespace: mount, pid, ipc, uts, cgroup; net unless the principal is a tier-0 service with `network: "host"` (or `"cluster"`, which joins the cri network namespace, §20.16). **Single exception to "only `warden` creates namespaces":** on `server-k8s`, `net` creates the cri network namespace and the per-pod network namespaces inside the cri network (network namespaces only, never user or mount namespaces; §21.5).
6. A fresh `/proc` (`hidepid=invisible,subset=pid`).
7. No controlling terminal unless one is given; `TIOCSTI` disabled system-wide (`dev.tty.legacy_tiocsti=0`).
8. `mseal` of the stack and libc read-only segments (done by the keylos libc startup shim where available); `PR_SET_MDWE` (W^X) unless the generation has `needs.jit`.
9. `RLIMIT_RTPRIO = 0` unless the generation has `needs.realtime` (then 20, with `RLIMIT_RTTIME = 200 000 µs`).

The only other seccomp profiles are `baseline-1+<digest>` (baseline-1 plus the tier-0 extras a service's `privileges.syscalls` and `privileges.socketFamilies` list in `services.json`, §20.16; `<digest>` is the lowercase hex SHA-256 of the extras' names, syscalls and socket families together, sorted by bytes, each followed by `\n`), used only for tier-0 services; `debug-1` (baseline-1 plus `ptrace`, `process_vm_readv`, `perf_event_open`) and `debug-1k` (`debug-1` plus `bpf`, for scope `kernel`), used exclusively for `DebugAttach` debuggers (§9.3); `openbroker-1` (baseline-1 plus `process_vm_readv`; `ptrace`, `process_vm_writev` and `pidfd_getfd` stay denied), used exclusively for `compat`'s per-app open-broker processes (§9.3); and `runtime-default` (baseline-1 ∩ the Kubernetes RuntimeDefault profile) for `keylos-sealed` pods.

### A.18 `protocols §9.2` — Tiers

| Tier | Isolation | Code allowed |
|---|---|---|
| t0 | Baseline + service-specific allowances (system services) | Sealed only |
| t1 | Baseline (apps) | Sealed only |
| t2 | microVM (crosvm) managed by `bench`, display via Wayland proxy | Any (inside guest) |
| t3 | microVM workbench (dev environments, agent sessions) | Any (inside guest) |
| legacy | Baseline + a user namespace built by `warden` (child `user.max_user_namespaces=0`) + FHS view + seccomp user-notification open broker (`compat`). Only forge-built, reproducible legacy images signed by a trusted key run as tier L on the host; every imported image runs in t2 | Sealed legacy image |
| pod (`keylos-sealed`) | t1 baseline with `runtime-default` seccomp, in the pod network namespace inside the `cri` network (§21) | Sealed `container` generations signed by an org publisher |
| pod (`keylos-vm`) | t2-class microVM per pod sandbox managed by `bench` for `cri` | Any OCI image (inside guest) |

Media VMs (removable storage, §9.5), captive-portal browser VMs and agent desktops are tier-3 VMs with their own `VmSpec.purpose`.

### A.19 `protocols §10.3` — UIDs and cgroups

**UIDs:**

| Range | Use |
|---|---|
| 0 | Kernel threads, `warden` (PID 1). No other process. |
| 1000–59999 | Humans (allocated by `hearth`) |
| 0x00100000–0x0FFEFFFF | Dynamic principal UIDs, allocated by `warden` per running principal instance. Quarantined for 60 s after release. |
| 0x0FFF0000 | Reserved on-disk owner of `_cluster` data (pod volumes, cri state); reached by containers only through idmapped mounts; never allocated to a process |
| 0x0FFF0001–0x0FFFFFFF | Reserved |
| 0x10000000–0x7FFEFFFF | Legacy-tier user-namespace ranges, 65536-UID blocks, allocated by `warden` |

**cgroups:**

```
/keylos.slice/system.slice/<service>.scope
/keylos.slice/user-<uid>.slice/{shell,apps,agents,benches,legacy}.slice/<session>.scope
/keylos.slice/kube.slice/<pod-id>.slice/<container-or-vm>.scope      (cgroup subtree delegated to cri)
/keylos.slice/guest-<id>.slice/…                                    (ephemeral guest sessions, removed at logout)
```

### A.20 `protocols §19.2` — Facets (excerpt: rows naming compat)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| warden | `compat` | compat | `LegacySpawn`; `GrantMounts.idmappedDir`; `Supervisor.spawn` (compat generation entrypoints only) |
| vault | `adapter` | compat | `store` (import from legacy secret stores, on the human's behalf, with prompt) |
| depot | `mounter` | warden, bench, compat | `mount` (container generations only while rooted by `cri:pod:…`), `get`, `root`, `unroot`, `revocationStatus` |
| depot | `compat` | compat | `importTree` (kind `legacy-image`), `get`, `revocationStatus` |
| strata | `compat` | compat | `createUnit`, `forget` for `app/*` units of legacy apps |
| bench | `compat` | compat | `start` with `display=true` for tier-2 legacy apps |
| compat | `user` | kish, atrium launcher | `importImage`, `run` (own apps) |
| compat | `service` | warden routes for legacy services | `run` of tier-L legacy services |
| compat | `adapter` | devd, portal-print, portal-scan, vault | `CompatIsland` |
| compat | `admin` | owner `shell` | all, compat-local admin |
| atrium | `display` | warden, bench, compat | `Display` (`xwaylandWm`: compat only) |

### A.21 `protocols §19.3` — Receipt events (excerpt: compat row)

| Event | Writer |
|---|---|
| `legacy.import`, `legacy.open` | compat |

### A.22 `protocols §9.3` — Code integrity (host)

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

### A.23 `protocols §10.7` — Cross-repository files (excerpt: gate CA bundle row)

| Path | Format | Writer | Readers |
|---|---|---|---|
| `/run/keylos/gate/ca.pem` (inside tier-L views) | PEM CA bundle of the principal's gate shim | gate | compat (sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`) |
| State | Owner | Location |
|---|---|---|

### A.24 `protocols §7.5.10` — `bench-sys.capnp`

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

### A.25 `protocols §10.5` — Environment conventions

Processes receive:
- `KEYLOS_PRINCIPAL` (text)
- `KEYLOS_SESSION`
- `KEYLOS_TIER`
- `KEYLOS_CAPWIRE_FDS`: a comma list of `name=fdnum` for passed service sockets, for example `broker=3,portal-files=4`. Names follow the route-name rule below.
- `KEYLOS_ARGFD_<argname>` and `KEYLOS_PIPE_IN` / `KEYLOS_PIPE_OUT` (§12)
- `KEYLOS_TXN`: the strata transaction ID when spawned with `SpawnSpec.transaction`
- `KEYLOS_AGENT_HOST`: `vsock:2:7002` inside agent workbenches
- `KEYLOS_GUEST_PORTALS`: `vsock:2:7004` inside tier-2 guests
- `KEYLOS_BPF_FDS`: `name=fdnum` list of BPF map fds `warden` loaded for a tier-0 service (§9.3)
- `KEYLOS_TPM_FD`: for services whose `services.json` entry has `privileges.tpm: true`, the number of an inherited fd of `/dev/tpmrm0` that `warden` opened for the service; services use it as their TPM (for example TCTI `device:/proc/self/fd/<n>`) and never open TPM devices by path
- XDG variables, with paths per §10.1

In tier-0 services fd 3 is the `warden` bootstrap socket (`Bootstrap`, §7.5.1) and is not listed in `KEYLOS_CAPWIRE_FDS`.

**Route names in `KEYLOS_CAPWIRE_FDS`:**

| Route | Name |
|---|---|
| `<svc>#client`, `<svc>#default` | `<svc>` |
| `broker#principal` | `broker` |
| `warden#client`, `warden#service` | `warden` |
| any other `<svc>#<facet>` | `<svc>#<facet>` |

**Adopting inherited descriptors.** Programs take ownership of fd 3 and of the descriptors named in `KEYLOS_CAPWIRE_FDS`, `KEYLOS_BPF_FDS` and `KEYLOS_TPM_FD` exactly once at start-up through the `keylos-capwire` inheritance helper (§18), which checks that each fd is open and sets `FD_CLOEXEC`; programs need no `unsafe` code of their own for it.

**Development knobs.** Names starting with `KEYLOS_DEV_` are reserved for development-only settings, for example `KEYLOS_DEV_TPM_TCTI` (a TPM TCTI string such as `swtpm:host=127.0.0.1,port=2321`, which replaces `KEYLOS_TPM_FD`). Production builds never read them, and `warden` never sets them; only the development supervisor of a development image may. Every other development knob of a keylos component uses this prefix. The registered knobs are:

| Knob | Read by | Effect (development builds only) |
|---|---|---|
| `KEYLOS_DEV_TPM_TCTI` | every TPM-using service (vault, hearth, ledger, broker, strata, courier, config) | TPM TCTI string that replaces `KEYLOS_TPM_FD` |
| `KEYLOS_DEV_LEDGER_SELF_PROVISION` | ledger | `1`: on a fresh store with the counter `0x01300100` absent, define it itself (`x-devProvision`) instead of waiting for `HearthTpm.defineSpace`; never after hearth genesis |
| `KEYLOS_DEV_LEDGER_SAMPLE_EXPORT` | ledger (tests) | Directory for sample exports written by the privacy test harness |
| `KEYLOS_DEV_HEARTH_SOFT_AUTHENTICATOR` | hearth | Use a software FIDO2 authenticator instead of a CTAP2 device |
| `KEYLOS_DEV_BROKER_IMPLICIT_SESSIONS` | broker | `1`: register an unregistered `broker#principal` peer implicitly instead of failing `kl:denied` |
| `KEYLOS_DEV_BROKER_POLICY_DIR` | broker | Directory that replaces the warden-mounted `/policy` generation |
| `KEYLOS_DEV_BROKER_GENERATION` | broker | Generation ref used for the broker's own principal when `ServiceHost.accept` and `policy.ref` give none |
| `KEYLOS_DEV_TIME_TRUSTED` | broker, loom | `1`: treat the system clock as trusted without a `NetWatch` `timeTrusted` event |
| `KEYLOS_DEV_WATCHDOG_SECS` | broker and every other daemon with a `watchdogSecs` of its own (it reads the knob itself; the `warden-svc` host reads none) | Watchdog interval that replaces the manifest's `watchdogSecs` |
| `KEYLOS_DEV_LOOM_FAULTS` | loom | Comma list of fault-injection points (`crash:<point>`, `fsync-fail:<point>`, `enospc:<point>`, points named in the loom spec) for the durability acceptance tests |
| `KEYLOS_DEV_LOOM_CLOCK_SKEW_SECS` | loom | Signed offset added to loom's view of trusted time, for timer, expiry and long-downtime tests |

A knob that is not listed here MUST NOT be read by any component; a new knob is registered here before use.

No secrets, ever. Names starting with `KEYLOS_` are reserved; `SpawnSpec.env` MUST NOT set them, with one exception: a `shell` principal MAY set `KEYLOS_ARGFD_*`, `KEYLOS_PIPE_IN` and `KEYLOS_PIPE_OUT` (§12); `warden` verifies that every fd named in `KEYLOS_ARGFD_*` is present in `SpawnSpec.fds`.

### A.26 `protocols §14.5` — Operating rules

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.
