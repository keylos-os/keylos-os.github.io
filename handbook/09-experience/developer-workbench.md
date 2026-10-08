# Developer workbench

> A workbench is a microVM per project in which every unsealed build, test, package install and agent session runs. `work` gets you a shell in it in about a quarter of a second, with the project's toolchains already mounted from the store. Changes reach the host only through shares, and agent changes reach it only through reviewed commits.

**Status:** specified (v1.0) in [bench](../../specs/bench/spec.md).

![Process tree and tiers](../images/process-tree-and-tiers.svg)

## Why a VM per project

On the host, keylos executes only sealed code ([ADR-0008](../11-decisions/adr-0008-host-executes-only-sealed-code.md)). Development is the opposite: compilers emit fresh binaries, package managers download and run install scripts, and tests execute whatever was just built. A workbench gives that work a whole Linux kernel of its own, so none of it needs an exception to the host rule ([ADR-0009](../11-decisions/adr-0009-unsealed-code-in-workbenches.md)).

| Concern | How the workbench handles it |
|---|---|
| Unsealed code | Runs freely inside the guest; the host kernel never maps it executable |
| Toolchains | Store generations mounted read-only at `/keylos/gens/<digest>`: the same verified bytes the host uses, available instantly |
| Network | Every flow goes through `gate` with a host-name grant; first use of a new host asks you once |
| Secrets | Never in the guest environment; `gate` injects credentials into requests that need them |
| Start time | Restores from a per-project memory snapshot (~120 ms typical) |
| Agents | Each agent session is a fork of your workbench with overlay-only shares |

## Getting started

```sh
cd ~/src/payments-api
work init --template rust        # writes project.ncl
work                             # first start: cold boot (~1 s), setup hooks, base snapshot
work                             # later starts: ~250 ms to a prompt
```

`project.ncl` describes the workbench:

```nickel
let P = import "keylos/project@1" in
{
  name = "payments-api",
  toolchains = ["org.rust-lang.rustc@1.90", "org.postgresql.server@17"],
  setup = [{ run = ["cargo", "fetch"] }],
  services = { db = { run = ["postgres", "-D", "/var/lib/pg"], ports = [5432] } },
  caches = { cargo = { path = "/home/work/.cargo/registry" } },
  network = { registries = ['crates-io], allow = ["api.stripe.com:443/https"] },
  agents = { default_template = "io.keylos.agent.coder", budget_usd = 10 },
} | P.ProjectSchema
```

The base snapshot is keyed by the evaluated configuration, the guest image and the store set. Changing a toolchain version causes one cold boot, then fast starts again.

## What is where

| Guest path | Contents | Persists? |
|---|---|---|
| `/work/<project>` | Your project directory (direct share for humans) | Yes: it is your real directory |
| `/keylos/gens/…` | Toolchains and packages from the store | Read-only |
| `/cache/<name>` | Declared caches (cargo registry, npm cache) | Yes, per project, labelled untrusted |
| `/home/work`, `/var`, `/tmp` | Guest scratch disk | Until `work reset` or a config change |
| `/etc` | Guest image plus overlay | Same as scratch |

Anything you need to keep belongs in the project directory or a cache. The scratch disk is disposable by design.

## Network inside the workbench

The guest has an ordinary network interface, but on the host side it is terminated by a userspace stack (`bench-net`). DNS answers are synthetic addresses, so every connection maps back to an exact host name. That host name is checked against your workbench's grants and sent through `gate`.

| You do | What happens |
|---|---|
| `cargo build` with `registries = ['crates-io]` | Connections to `crates.io` and `static.crates.io` succeed |
| `curl https://example.com` (not granted) | The connection is reset; atrium shows "workbench payments-api wants example.com:443"; approve once, for the session, or for a period |
| Connect to a literal IP | Refused unless a grant names that IP |
| `work allow api.example.com --for 8h` | Request a grant explicitly |

## Daily commands

| Command | Use |
|---|---|
| `work` | Shell in the workbench |
| `work run -- cargo test` | One command, same exit code |
| `work status` | State, snapshot, shares, toolchains, grants, resource use |
| `work fork` | Experimental copy: writable shares become overlays |
| `work diff` / `work commit` / `work discard` | Review and apply or drop a fork's changes |
| `work snapshot <name>` / `work restore <name>` | Named checkpoints of the whole VM |
| `work reset` | Throw away the scratch state and base snapshot |
| `work gc` | Remove old snapshots and caches of this project |

## Agents in your workbench

When you start an agent on a project, `aide` asks bench for a **fork** of your workbench. The fork:
- shares your warm toolchains and caches (caches as copy-on-write snapshots);
- sees the project through an **overlay**: its writes never touch your tree;
- has only the network grants its session holds, and asks `aide` for more;
- ends with a **merge review**: a diff you approve on the trusted path (tier T3), committed through strata with an undo snapshot.

![Agent session](../images/agent-session.svg)

## IDEs

Full IDEs run inside the workbench as **workbench apps**, displayed on the host desktop. Declare them in `project.ncl` (`projectApps`) and start them with `work app <name>`. See [IDEs](ides.md).

## Debugging

Inside the workbench, debuggers and profilers work without restriction. Debugging a sealed **host** app needs a time-limited debug grant ([Debugging](../06-security/debugging.md)).

## GPU work

Set `resources.gpu = true` for CUDA-free GPU work (Vulkan, OpenCL via Mesa, ML inference through Vulkan back ends). bench uses virtio-gpu native context on AMD, Intel and Qualcomm hosts, or Venus, or no GPU (recorded in `work status`). Agents get no GPU unless policy allows it.

## Limitations

- KVM is required. Without it, `work` refuses to run; it never falls back to running unsealed code on the host.
- GPU state cannot be snapshotted. Workbenches with a GPU take their base snapshot before the GPU is attached, and forks of GPU workbenches are slower.
- Native-context GPU still reaches the host kernel GPU driver: an accepted risk, disabled for agents by default.
- Metadata-heavy operations on very large trees are about 2–3× slower over virtio-fs than on the host.
- Proprietary GPU compute stacks (CUDA) are not supported in workbenches.

## Related

- [IDEs](ides.md)

- [bench spec](../../specs/bench/spec.md)
- [Legacy apps](legacy-apps.md)
- [Seal a tool](../12-guides/seal-a-tool.md)
- [Package an app](../12-guides/package-an-app.md)
- [ADR-0009 Unsealed code in workbenches](../11-decisions/adr-0009-unsealed-code-in-workbenches.md)
- [ADR-0010 crosvm as the single VMM](../11-decisions/adr-0010-crosvm-single-vmm.md)
- [ADR-0029 Agents propose, humans sign](../11-decisions/adr-0029-agents-propose-humans-sign.md)
