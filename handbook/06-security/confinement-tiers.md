# Confinement tiers

> Every keylos process gets the same confinement baseline and then lands in one of five tiers by risk: system services, apps, untrusted apps, workbenches and legacy binaries.
> This page lists exactly what the baseline contains, how each tier differs, and what each costs.

**Status:** specified (v1.0). Enforced by [warden](../../specs/warden/spec.md); VM tiers by [bench](../../specs/bench/spec.md); legacy by [compat](../../specs/compat/spec.md).

![Confinement stack](../images/confinement-stack.svg)

## The baseline

Applied by `warden` to every process except itself, in this order, between `clone3` and `execveat`:

| # | Layer | What it does |
|---|---|---|
| 1 | Namespaces (mount, PID, IPC, UTS, cgroup, network) | A private view: only the generation, its data and its grants exist |
| 2 | Fresh `/proc` (`hidepid=invisible,subset=pid`) | No view of other processes, no `/proc/sys` |
| 3 | Private `/dev` | Only null, zero, full, random, urandom, tty (if given) and granted devices |
| 4 | Dynamic UID, no supplementary groups | Per-instance identity; human files are reached through idmapped mounts |
| 5 | Securebits locked, capabilities dropped | No route back to privilege |
| 6 | `no_new_privs` | No setuid or file capabilities can apply |
| 7 | Landlock (highest ABI) | Filesystem rights only beneath the view and grants; TCP/UDP port rules; abstract socket and signal scoping |
| 8 | `PR_SET_MDWE` (unless JIT) | No writable-then-executable memory |
| 9 | seccomp allowlist `baseline-1` | Default `ENOSYS`; namespace, mount, ptrace, bpf, io_uring, keyring, module and time-setting syscalls denied; `clone` flags and `socket` families filtered; `TIOCSTI`/`TIOCLINUX` denied |
| 10 | cgroup device program and limits | Only granted device numbers; memory, PIDs and CPU limits |
| 11 | `kl-exec` (system-wide) | Exec and `mmap(PROT_EXEC)` only from mounts of verified generations |
| 12 | Securebits `SECBIT_EXEC_RESTRICT_FILE` and `SECBIT_EXEC_DENY_INTERACTIVE` | Interpreters refuse unsealed scripts and interactive code; only the trusted-terminal tree (`TrustedSpawn`) keeps interactive input |

Kernel-wide settings that support the baseline: `dev.tty.legacy_tiocsti=0`, `kernel.yama.ptrace_scope=2`, `kernel.unprivileged_bpf_disabled=2`, `vm.memfd_noexec=2`, `kernel.perf_event_paranoid=3`, `kernel.kptr_restrict=2`, `kernel.dmesg_restrict=1`. See [Kernel config and sysctls](../13-reference/kernel-config-and-sysctls.md).

## The tiers

| Tier | Who | On top of the baseline | Cost |
|---|---|---|---|
| **t0** | System services | Declared privileges from release-signed manifests only: capabilities, extra syscalls, socket families, device classes, sysfs paths, host network | ≈ 0 |
| **t1** | Apps, shells | Wayland socket tagged with the security-context protocol; portals for files, camera and screen; network only through `gate` | < 1% CPU, +5–20 ms launch |
| **t2** | Untrusted apps | microVM (crosvm), virtio-gpu native context, Wayland proxy, virtio-fs only for grants | 0.3–1 s start, 100–250 MB RAM |
| **t3** | Workbenches and agent sessions | microVM with snapshot and fork; shares as copy-on-write overlays; one virtio-net NIC terminated by `bench-net` into gate's `ShimEndpoint`; control over capwire-vsock | 100–300 ms from snapshot |
| **legacy** | Unmodified Linux binaries from forge-built, reproducible legacy images signed by a trusted key | User namespace with a 65 536-UID block created by `warden` through `LegacySpawn` (child `user.max_user_namespaces=0`), FHS view, seccomp user-notify open broker in compat that turns ungranted `open()` calls into prompts. Every **imported** image (OCI, Flatpak, distro rootfs) runs in t2 instead | ≈ 15 ms; 10–50 µs per intercepted call |

### What goes where

| Workload | Tier | Why |
|---|---|---|
| `vault`, `broker`, `net`, `devd` | t0 | Trusted, sealed, need specific privileges |
| Text editor, file manager, music player from the keylos repo | t1 | Sealed, reproducible |
| Browser | t1 (t2 offered) | Sealed but JIT and huge attack surface |
| A proprietary chat app with no reproducible build | t2 | `reproducible: false` |
| A game from an external store | t2 (GPU native context) | Untrusted, needs the GPU |
| `cargo build`, `pytest`, `npm install` | t3 (project workbench) | Unsealed code |
| An AI agent working on a repo | t3 (agent workbench forked from the project) | Untrusted behaviour, unsealed code |
| A Debian `.deb` tool imported as a legacy image | legacy (or t2 if from the internet) | Expects FHS and root-like paths |
| An IDE (VS Code, JetBrains) | t3 (workbench app in the project VM) | Runs language servers, tasks and extensions from the repository |
| Files on a USB stick | media VM (t3, `purpose: media`) | The host never parses removable filesystems |
| A computer-use agent | t3 agent desktop (`purpose: agentDesktop`) | Needs a GUI without touching the real session |
| A Kubernetes pod | pod VM (`keylos-vm`) or t1 (`keylos-sealed`) | Untrusted images in VMs; signed org images on the host |
| A debugger attached to a host app | t1 with a `kl_debug_pairs` entry | Time-limited `Right.debug` grant |

## Compensations on older kernels

| Missing kernel feature | Compensation |
|---|---|
| Landlock UDP rules (before ABI 10) | Private network namespace with only `lo`; all egress through `gate` |
| Landlock pathname unix socket rules (before ABI 9) | The view contains no foreign pathname sockets |
| Landlock thread sync (before ABI 8) | The spawner child is single-threaded when it restricts itself |

Each process's confinement report (`warden inspect <session>`) lists the compensations applied.

## Limitations

- t0, t1 and legacy share the host kernel. A reachable kernel bug defeats them. That is why untrusted code goes to t2 or t3.
- GPU drivers are reachable from t1 apps that declare `needs.gpu`.
- Landlock cannot restrict some metadata operations (for example `stat`, `chmod` beneath allowed paths). The view and the idmapped mounts limit what those can touch.
- Microarchitectural side channels between tiers are mitigated only by standard kernel mitigations.

## Related

- [Process tree and tiers](../02-architecture/process-tree-and-tiers.md)
- [Namespaces](namespaces.md)
- [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md)
- [warden spec](../../specs/warden/spec.md) §4.4–§4.5 (exact sequence and seccomp profile)
- [ADR-0025 Namespaces only by warden](../11-decisions/adr-0025-namespaces-only-by-warden.md), [ADR-0010 crosvm as the single VMM](../11-decisions/adr-0010-crosvm-single-vmm.md)
