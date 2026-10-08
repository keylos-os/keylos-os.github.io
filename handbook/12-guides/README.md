# Guides

> Step-by-step instructions for the most common changes: packaging an app, writing a service, building an agent template, sealing a personal tool, porting legacy software, adding an effect kind and writing policy. Every command matches the v1.0 specs.

## Guides

| Guide | You will | Main tools |
|---|---|---|
| [Package an app](package-an-app.md) | Turn a program into a signed `app` generation, test it against simulated grants, publish it to the catalogue | `kl-sdk`, `work` |
| [Write a service](write-a-service.md) | Build a tier-0 or on-demand service with capwire interfaces, routes and receipts | `kl-sdk`, `config` |
| [Write an agent template](write-an-agent-template.md) | Package a harness, pinned tools, a prompt and a policy as an `agent-template` generation | `kl-sdk`, `aide` |
| [Seal a tool](seal-a-tool.md) | Build your own CLI in a workbench and seal it, so it runs on the host | `kl-sdk seal` |
| [Port a legacy app](port-a-legacy-app.md) | Run existing Linux software through compat, then move it to a native or forge-built package | `compat`, `kl-sdk` |
| [Add an effect kind](add-an-effect-kind.md) | Register a new staged effect with class, compensator and renderer | `kl-sdk`, `config` |
| [Write policy](write-policy.md) | Express who may do what in Cedar, with approval tiers | `config` |
| [Run a Kubernetes node](run-a-kubernetes-node.md) | Install `server-k8s`, set up quorum presence, attest and join, run pods in both runtime classes | `installer`, `config`, `cri`, `kubectl` |

## Conventions used in the guides

- `$` lines run in `kish` on the host. `work$` lines run inside a project workbench (`work` or `work run -- …`).
- Every unsealed build or test runs in a workbench. The host only runs sealed generations.
- Approvals marked **T2** or **T3** appear on the trusted path (atrium). **Presence** means a FIDO2 touch.
- Names such as `org.example.*` are placeholders. Use your own reverse-DNS prefix.

## Before you start

1. Create a publisher key once (hardware token recommended):

   ```sh
   $ kl-sdk keys new --fido2 --name "Example Org"
   ```

2. Make sure KVM works: `work status` in any directory with a `project.ncl` reports the VM state.

## Related

- [Developer workbench](../09-experience/developer-workbench.md)
- [Legacy apps](../09-experience/legacy-apps.md)
- [sdk spec](../../specs/sdk/spec.md)
- [bench spec](../../specs/bench/spec.md)
- [compat spec](../../specs/compat/spec.md)
