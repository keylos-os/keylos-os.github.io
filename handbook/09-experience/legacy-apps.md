# Legacy apps

> keylos runs unmodified Linux software (OCI images, Flatpaks, packages from Debian, Fedora or Arch) in the legacy tier. Each app gets a normal-looking FHS filesystem but no ambient authority. Its home is private, and files outside it arrive through a prompt. X11 and D-Bus are per-app islands. Anything imported from the internet runs in a VM.

**Status:** specified (v1.0) in [compat](../../specs/compat/spec.md).

![Confinement stack](../images/confinement-stack.svg)

## Two placements

| Placement | Which images | Isolation | Start overhead |
|---|---|---|---|
| **Tier L (host)** | Built by `forge` from pinned sources, reproducible, signed by a release or publisher key (for example the legacy collection in `pkgs`) | Baseline sandbox + user namespace (65 536-UID block, nesting disabled) built by warden through `LegacySpawn`, FHS view, seccomp-notify open broker in compat | ~40 ms (+80 ms with Xwayland) |
| **Tier 2 (VM)** | Everything imported: OCI images, Flatpaks, distro installs | crosvm microVM, with the same view built inside the guest | ~600 ms to first window |

There is no way to move an imported image to the host. The host runs only code whose source and build are known ([ADR-0043](../11-decisions/adr-0043-non-reproducible-means-tier-2.md)).

## Importing

```sh
compat import flatpak://flathub/app/org.gnome.TextEditor/x86_64/stable
compat import oci://ghcr.io/example/tool@sha256:4be1…
compat import distro:debian:trixie --packages libreoffice,gimp --name office
compat ls
```

All downloading, signature checking, unpacking and package-manager runs happen in a throwaway workbench VM. The host only receives a plain, normalised tree:
- setuid bits are cleared;
- device nodes are removed;
- file capabilities are dropped.

compat then turns that tree into a `legacy-image` generation in the store. You see the capability requests before the app can launch.

## What the app sees

| Path | Contents |
|---|---|
| `/` | Its own image (read-only) |
| `/home/user` | Its own private home (`~/.apps/<name>/data/home`), not yours |
| `/home/user/Documents/…` | Only files and folders you granted |
| `/etc` | Image `/etc` plus generated `passwd`, `resolv.conf`, `machine-id`, system CA store |
| `/tmp`, `/dev/shm` | Private |
| `/dev` | Minimal, plus the GPU render node if granted |

## Opening your files

When a legacy app opens a path under one of your document folders (Documents, Downloads, Pictures, Music, Videos, Desktop, removable media), the **open broker** intercepts the call:

1. Inside the view and allowed by its rules: the open proceeds normally.
2. In a promptable folder you haven't granted: a powerbox prompt on the trusted path shows "Text Editor wants to open report.odt". You can approve, deny, or pick a different file.
3. Anywhere else (for example `~/.ssh`): the file does not exist as far as the app knows.

The broker opens the file itself and hands the app an already-open descriptor, so the app never resolves your real path. GTK and Qt "Open…" dialogs reach the same powerbox through the app's D-Bus island.

| Mode | Behaviour | Default for |
|---|---|---|
| `prompt` | As above | GUI apps |
| `deny` | No prompts; only the view and existing grants | CLI tools, services |
| `off` | No interception (zero overhead) | Opt-in per app |

```sh
compat open-broker office deny
```

## X11 and D-Bus

- **X11:** each X11 app gets its own nested Xwayland, which connects to atrium as that app. An X11 app can capture or inject input only into its own windows.
- **Session D-Bus:** each app that needs it gets its own private bus. A gate on that bus bridges a fixed set of APIs to keylos services:

| Bridged API | Goes to |
|---|---|
| Notifications | portals Notify |
| File chooser, open URI, screenshot, screencast, camera, print, settings | broker powerbox and portals |
| Secret Service | vault, scoped to this app's own items |
| MPRIS media controls | atrium |

Everything else on the bus is visible only inside the app.

- **System daemons** such as BlueZ and CUPS run as legacy services inside their own **D-Bus islands**. A keylos adapter is the only other client of each island bus.

## Flatpak permissions

| Flatpak asks for | keylos gives |
|---|---|
| `--share=network` | A first-launch prompt: any host, or ask per host |
| `--socket=x11` | Nested Xwayland |
| `--socket=wayland`, `--device=dri` | Display; GPU render node |
| `--filesystem=home` / `host` | Nothing; the open broker prompts instead |
| `--socket=session-bus` / `system-bus` | Nothing; the per-app island only |
| `--talk-name=org.freedesktop.secrets` | Vault, app-scoped |
| `--device=all`, `--device=kvm` | Nothing |

Run `compat permissions <app>` to see the mapping for an installed app.

## Games

Steam and Proton run as a tier-2 legacy image with the GPU passed through as virtio-gpu native context. Expect 85–95% of native frame rate on AMD and Intel GPUs. The `games` VM profile raises vCPU and memory defaults. Kernel-level anti-cheat cannot work and is not supported.

## VM groups

By default each tier-2 app has its own VM. To save memory, put related apps into one VM; they share a guest kernel but still run in separate containers inside it:

```sh
compat group office work-apps
compat group gimp work-apps
```

## Limitations

- Tier-2 apps cost ~0.3–1 s to start and ~100–250 MB of memory each, unless grouped.
- Software that needs kernel modules, raw device access, or a system-wide bus cannot work.
- The open broker adds ~15–50 µs to each `open` call in `prompt` mode.
- Apps that store data outside their home (for example writing into `/opt` at run time) keep it only in their private overlay.
- Drag and drop between legacy apps and native apps works for files only through the powerbox path.

## Related

- [compat spec](../../specs/compat/spec.md)
- [bench spec](../../specs/bench/spec.md)
- [Developer workbench](developer-workbench.md)
- [Port a legacy app](../12-guides/port-a-legacy-app.md)
- [ADR-0037 Legacy tier with FHS views](../11-decisions/adr-0037-legacy-tier-fhs-views.md)
- [ADR-0035 fd-only portals and D-Bus islands](../11-decisions/adr-0035-fd-only-portals-dbus-islands.md)
- [ADR-0025 Namespaces only by warden](../11-decisions/adr-0025-namespaces-only-by-warden.md)
