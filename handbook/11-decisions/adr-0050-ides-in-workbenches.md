# ADR-0050: Full IDEs run inside project workbenches

> IDEs such as VS Code and JetBrains run as **workbench apps**: inside the project's tier-3 workbench VM, with their windows shown on the host desktop through the Wayland cross-domain proxy and GPU native context. Language servers, debuggers and test runners live with them in the VM. The host keeps only sealed editors that never execute project code.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Experience / developers | bench, atrium, sdk, pkgs |

## Context

- Modern IDEs execute project code all the time:
  - language servers and build-tool integrations;
  - test runners and debuggers;
  - extension marketplaces running arbitrary JavaScript, Python or JVM code;
  - task runners that read configuration from the repository.
- Repositories are untrusted input. Repository-controlled IDE configuration (tasks, workspace settings, extension recommendations) is a known code-execution vector, which is why editors added "trusted workspace" prompts.
- keylos runs unsealed code only in workbench VMs ([ADR-0009](adr-0009-unsealed-code-in-workbenches.md)). An IDE on the host would need constant sealing or a broad exception.
- Remote-development splits (UI on one machine, backend in a container or VM) are an established IDE pattern, but not every IDE supports one.

## Decision

- **Workbench apps.** `project.ncl` lists `projectApps`. `bench` starts them inside the project workbench with `VmSpec.display = true`. Windows appear on the host through the Wayland cross-domain proxy, with GPU via virtio-gpu native context where available.
- **Identity on screen.** atrium draws workbench-app windows with a tier-3 frame and the project name ([protocols §7.3.13](../../specs/protocols/spec.md#7313-benchcapnp)), so they can't pose as host apps.
- **Same overlay.** The IDE sees the same project overlay as the shell and agents in that workbench. Commits to the real tree go through `Vm.commit`.
- **Host editors.** Sealed host editors that execute no project code are allowed for quick edits.
- **Remote-dev split** (thin host UI plus VM backend) is allowed for IDEs that support it, over capwire-vsock bulk ports. It is never required.

## Alternatives considered

| Option | Why not |
|---|---|
| IDE on the host with a "trusted workspace" exception | Unsealed code on the host; one malicious repository compromises the user |
| Seal the IDE plus all its extensions | Extensions and language servers are installed per project and change daily |
| Run only remote-dev IDEs | Excludes IDEs without a remote mode |
| Run the IDE as a tier-2 app VM per IDE | Separates the IDE from the project's toolchains and caches; duplicates VMs |

## Consequences

### Positive
- Repository-controlled tooling runs where it can do least harm, next to the code it serves.
- One VM per project holds the IDE, toolchains, caches and agent forks, so resources are shared.
- Unchanged IDE builds work, since the guest is an ordinary Linux.

### Negative
- Window latency and GPU performance depend on cross-domain Wayland and native-context support; Intel native context is newest.
- IDE start time includes the workbench start (around 100–300 ms from a warm snapshot).
- Host integrations (system keychain, host file dialogs) go through the guest portal bridge.

## Related

- [IDEs](../09-experience/ides.md)
- [Developer workbench](../09-experience/developer-workbench.md)
- [ADR-0044: vsock for control, a userspace NIC for traffic](adr-0044-vsock-control-and-userspace-nic.md)
