# ADR-0049: Debugging host processes is a time-limited capability

> ptrace, perf and BPF tracing are denied on the host by default. A human can grant themselves `Right.debug` for one target session or generation, at tier T3 with presence, for at most one hour (15 minutes for kernel tracing). `warden` materialises it by spawning a sealed debugger and adding a pairing to the `kl-exec` BPF LSM, which then allows exactly that tracer-to-target relation.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Security / developers | warden, broker, kish, pkgs, keylos, protocols |

## Context

- ptrace and `process_vm_readv` let a process read another's memory and inject code. They are a standard path for same-user credential theft and for bypassing every per-app sandbox. The baseline seccomp profile denies them, and Yama is set to at least 1 ([protocols §9.1](../../specs/protocols/spec.md#91-baseline-for-every-non-kernel-process-except-warden-itself)).
- `perf_event_open` and unprivileged BPF have a long history of kernel exploits, and expose side channels.
- Developers still need to debug and profile sealed host apps: an app that crashes only on the host, or a performance issue in a desktop app. Inside workbench VMs debugging is unrestricted, because the guest kernel is the boundary.
- A permanent "developer mode" switch would be left on and would become ambient authority.

## Decision

- **New right.** `Right.debug` on `ResourceRef.principal = DebugTarget`, where the target is `session:s-…` (and its descendants) or `gen:fsv256:…` (any instance of that generation for the requesting human). Scope is `process` or `kernel`.
- **Minting** ([protocols §9.3](../../specs/protocols/spec.md#93-code-integrity-host)): T3 with presence, through `Broker.debug`. It lasts at most 3 600 s for `process` and 900 s for `kernel`. It is never granted to an agent unless the target lies in the agent's own session tree. Cedar action `debug` on entity `DebugTarget`.
- **Materialisation.** `DebugAttach.attach` (warden):
  - spawns the debugger generation, which must be in the policy list `debug.debuggers` (gdb, lldb, perf, bpftrace), with seccomp profile `debug-1`;
  - writes a `kl_debug_pairs` entry from the debugger cgroup to the target cgroup;
  - grants `CAP_BPF`/`CAP_PERFMON` as ambient capabilities only for scope `kernel`.
- **Enforcement.** `kl-exec` hooks `ptrace_access_check` and `perf_event_open` and allows only unexpired pairs.
  - Kernel-scope BPF allows tracing program types only (kprobe, tracepoint, raw_tracepoint, perf_event), never LSM, cgroup or XDP programs.
- **Expiry and receipts.** On expiry or exit, warden removes the pair and kills the debugger. Receipts `debug.attach` and `debug.detach`.
- **Shell.** `kish` has a `debug` builtin that requests the grant and opens the debugger in the trusted terminal.

## Alternatives considered

| Option | Why not |
|---|---|
| Global developer mode | Ambient authority that stays on; malware benefits as much as the developer |
| Yama `ptrace_scope=1` alone | Any process can still trace its descendants; launched helpers become a path |
| Debug only in workbenches | Can't reproduce host-only issues of sealed apps |
| Allow root-like `CAP_SYS_PTRACE` to the shell | Shell compromise becomes full memory access to every app |

## Consequences

### Positive
- Debugging is possible on the host without a standing hole. Each session of debugging is a decision with a receipt.
- Kernel tracing exists for performance work, bounded to 15 minutes and to tracing program types.

### Negative
- A touch and a T3 prompt before each debugging session adds friction for host debugging; workbenches stay friction-free.
- A malicious debugger generation would have full access to its target during the window, so the debugger list is policy and the debuggers are sealed generations.

## Related

- [Debugging](../06-security/debugging.md)
- [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md)
- [Shell](../09-experience/shell.md)
- [ADR-0008: The host executes only sealed code](adr-0008-host-executes-only-sealed-code.md)
