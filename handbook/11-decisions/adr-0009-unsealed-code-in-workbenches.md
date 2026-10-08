# ADR-0009: Unsealed code runs only in workbenches

> Development builds, downloaded binaries, `pip install`, test runs and every AI agent session run inside crosvm microVM **workbenches** with their own guest kernel. A workbench receives only granted shares (often copy-on-write overlays), network through gate, and no host secrets.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Execution | bench, aide, forge, kish, compat |

## Context

- [ADR-0008](adr-0008-host-executes-only-sealed-code.md) forbids unsealed code on the host, but developers and agents run unsealed code all the time.
- Same-kernel sandboxes fall to one reachable kernel bug. Google's kCTF data showed that about 44% of submitted exploits needed unprivileged user namespaces (https://security.googleblog.com/2023/06/learnings-from-kctf-vrps-42-linux.html).
- MicroVMs are now fast enough. Firecracker reports about 125 ms to guest init with under 5 MiB VMM overhead (real cold paths +100–300 ms). E2B and Docker Sandboxes run one microVM per agent session in production (https://e2b.dev/index.md, https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/).
- Agent harness escapes in 2026 came from privileged harness code following paths or writing config on the sandbox's behalf (CVE-2026-25725, CVE-2026-39861, CVE-2026-55607). The kernel isolation itself wasn't broken.

## Decision

- Tier 3 (workbench) = a microVM managed by bench. Inside it, anything goes: compilers, package managers, Docker.
- Agent sessions are always tier 3. Project dev environments are tier 3, configured by `project.ncl`.
- Shares are virtio-fs with virtiofsd Landlocked. Agent shares are copy-on-write overlays. Merging back is a strata transaction approved at T3.
- The harness on the host is minimal and never follows paths for the guest.
- Target start time is 100–300 ms from a snapshot. Forks are cheap.

## Alternatives considered

| Option | Why not |
|---|---|
| Landlock + seccomp sandbox for dev/agents | Shared kernel; unsealed code on the host breaks I1 |
| gVisor | Good isolation, but 2–10x I/O slowdown on builds; another TCB |
| Containers | Namespaces aren't a boundary ([ADR-0025](adr-0025-namespaces-only-by-warden.md)) |
| Remote cloud sandboxes only | Latency, cost, data residency; keylos must work offline |

## Consequences

### Positive
- A kernel exploit inside a workbench compromises only a disposable VM.
- The workbench doubles as the natural dev environment: reproducible, forkable, snapshot-able.

### Negative
- About 100–300 ms start, 50–150 MB RAM per VM, and I/O overhead.
- KVM is required. Without it, workbenches refuse to run.
- GPU and ML work needs native-context GPU or VFIO passthrough.

## Related

- [Sessions and workbenches](../07-agents/sessions-and-workbenches.md)
- [Developer workbench](../09-experience/developer-workbench.md)
- [ADR-0010: crosvm as the single VMM](adr-0010-crosvm-single-vmm.md)
