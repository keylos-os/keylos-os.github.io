# User experience

> How people use keylos: a typed shell that acts as a powerbox, a Wayland desktop with a trusted path, portals that hand out file descriptors instead of paths, development workbenches, and a compatibility tier for existing Linux software. The security model is part of the interface, not a layer of prompts on top of it.

## Principles

| # | Principle | Consequence |
|---|---|---|
| X1 | **Choosing is granting.** Typing a path, picking a file or dropping a folder is the permission | Few prompts; no "allow access to your files?" dialogs |
| X2 | **Show effects, not commands.** Approvals render what will happen (a diff, an email, a total) | Decisions people can actually make |
| X3 | **Identity is drawn by the system.** Window frames, the keystrip and prompts come from verified data | Apps cannot pretend to be other apps or the system |
| X4 | **Undo is normal.** `try`, `undo`, snapshots and agent forks are everyday tools | Experiments are cheap; mistakes are recoverable |
| X5 | **Compatibility without ambient authority.** Legacy apps run, in views that contain only what was granted | Existing software works without reopening the holes |

## Pages

| Page | Contents |
|---|---|
| [Shell](shell.md) | kish: typed pipelines, fd powerbox, transactions, jobs without process groups, sealed scripts |
| [Desktop](desktop.md) | atrium: compositor, keystrip, identity frames, greeter and lock, shell components, VM and Xwayland windows |
| [Portals and the powerbox](portals-and-powerbox.md) | File picker, screen, camera, microphone, open-uri, print, clipboard, location, background, consent summary |
| [Accessibility and internationalisation](accessibility-and-i18n.md) | Accessibility tree, assistive principals, built-in aids, locales, input methods, fonts |
| [Developer workbench](developer-workbench.md) | Project workbenches, sealing your own tools, agents in projects |
| [IDEs](ides.md) | Full IDEs as workbench apps, host editors, the optional remote-development split |
| [Legacy apps](legacy-apps.md) | Running unmodified Linux software: FHS views, Xwayland, D-Bus islands, the POSIX shell |

## Components

| Component | Role | Spec |
|---|---|---|
| kish | Shell and script language | [kish/spec.md](../../specs/kish/spec.md) |
| atrium | Compositor, desktop shell, trusted path, trusted terminal | [atrium/spec.md](../../specs/atrium/spec.md) |
| portals | fd-only access to shared desktop resources | [portals/spec.md](../../specs/portals/spec.md) |
| bench | Workbench and tier-2 VMs | [bench/spec.md](../../specs/bench/spec.md) |
| compat | Legacy tier | [compat/spec.md](../../specs/compat/spec.md) |

## A day in keylos

1. Boot. The phone confirms the machine's measurements ([verify before unlock](../05-integrity/attestation-and-vouch.md)); the user types the PIN and logs in at atrium's greeter.
2. The user opens a terminal (`atrium-term`) and runs `work ~/src/app`, which attaches to the project's workbench VM.
3. In the workbench they build and test freely; nothing built there runs on the host.
4. They start an agent on the project: `agent start --template coder --task "fix flaky test"`. The agent works in a fork of the workbench.
5. The agents panel shows progress. When the agent finishes, "Review" opens a trusted diff.
6. The user approves the merge (T3). The change lands as a transaction they can `undo`.
7. Later the agent wants to open a pull request. The effect is staged; the approvals centre shows the PR title, body and target repository; the user approves.
8. In the desktop, the user saves an invoice from the browser. The save dialog is the portal's picker; the browser receives one file descriptor.

## Related

- [Architecture overview](../02-architecture/README.md)
- [Trusted path](../06-security/trusted-path.md)
- [Agents](../07-agents/README.md)
