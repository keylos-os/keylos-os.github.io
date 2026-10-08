# IDEs

> Full IDEs run inside the project's workbench VM, next to the toolchains and caches they drive, and their windows appear on the host desktop like any other app. Language servers, debuggers, extensions and test runners never execute on the host. Quick edits can use sealed host editors that run no project code.
> Status: **specified (v1.0)**. Normative: [bench](../../specs/bench/spec.md), [atrium](../../specs/atrium/spec.md), [protocols §7.3.13](../../specs/protocols/spec.md#7313-benchcapnp).

## Why the IDE lives in the workbench

An IDE executes project-controlled code all the time:
- language servers and build-tool integrations;
- tasks and launch configurations from the repository;
- test runners and debuggers;
- extensions from a marketplace.

On the host that would mean unsealed code next to the user's data. In the workbench it runs where everything else unsealed runs ([ADR-0009](../11-decisions/adr-0009-unsealed-code-in-workbenches.md)).

## Declaring workbench apps

```nickel
# project.ncl
{
  toolchains = ["rust-stable", "node-22"],
  projectApps = [
    { name = "code", generation = "io.keylos.bench.app.vscode", gpu = true },
    { name = "idea", generation = "io.keylos.bench.app.intellij" },
  ],
}
```

```
$ work ~/src/app          # attach to the workbench
$ work app code           # start VS Code inside it; the window opens on the host
```

| Aspect | Behaviour |
|---|---|
| Display | `VmSpec.display = true`; Wayland cross-domain proxy to atrium |
| GPU | virtio-gpu native context where the host driver supports it, otherwise software rendering |
| Window identity | atrium draws a tier-3 frame with the project name; the window can't pose as a host app |
| Files | The same project overlay the shell and agents in that workbench see; commit with `work commit` (`Vm.commit`) |
| Network | bench-net through gate, with the workbench's grants |
| Host services | Notifications, open-uri, print and secrets through the guest portal bridge (vsock 7004) |
| Extensions | Installed inside the VM, per project; never on the host |

## Remote-development split

IDEs with a remote mode may run a thin UI on the host (a sealed generation) and the backend in the workbench, connected over capwire-vsock bulk ports. This is optional and IDE-specific. The full-IDE-in-workbench mode works for every Linux IDE.

## Host editors

Sealed editors that never execute project code (no language servers, no tasks) can edit files on the host through the powerbox. They are for quick changes. Opening a project directory in them does not grant them the workbench.

## Agents and IDEs together

Agent sessions are forks of the project workbench. The IDE shows the human's overlay. Agent changes arrive only when the human merges a reviewed `fs.merge` intent, after which the IDE sees them like any file change.

## Limitations

- Startup includes attaching to the workbench (around 100–300 ms from a warm snapshot, longer cold).
- GPU-heavy IDE features depend on native-context support; Intel support is the newest.
- Host keychains and dialogs are reached through the guest bridge, so some IDE integrations need configuration.

## Related

- [Developer workbench](developer-workbench.md)
- [Desktop](desktop.md)
- [Sessions and workbenches](../07-agents/sessions-and-workbenches.md)
- [ADR-0050: IDEs in workbenches](../11-decisions/adr-0050-ides-in-workbenches.md)
