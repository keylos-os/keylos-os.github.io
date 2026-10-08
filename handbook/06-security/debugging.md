# Debugging

> On the host, ptrace, perf and BPF tracing are denied by default. Debugging a sealed host process takes a `Right.debug` grant: one target, T3 with presence, at most one hour (15 minutes for kernel tracing). `warden` spawns a sealed debugger, and the `kl-exec` BPF LSM allows exactly that tracer-to-target pair until it expires. Inside workbench VMs, debugging is unrestricted.
> Status: **specified (v1.0)**. Normative: [protocols §9.3](../../specs/protocols/spec.md#93-code-integrity-host), [§7.5.1](../../specs/protocols/spec.md#751-warden-syscapnp), [warden](../../specs/warden/spec.md).

## Where to debug

| Situation | Where | Restrictions |
|---|---|---|
| Your project's code, tests, services | Project workbench VM | None. The guest kernel is the boundary |
| A sealed host app or service misbehaving | Host, with a debug grant | One target, time-limited, presence |
| Performance of the whole host | Host, kernel-scope grant | 15 minutes, tracing BPF types only |
| An agent's own processes | Inside the agent's VM | The agent may debug only its own session tree |

## Getting a grant

```
$ debug attach --session s-01JC… --with gdb         # or --gen gen:fsv256:… for an app generation
T3 · presence required
  Debug org.example.Editor (session s-01JC…) with gdb for 60 min
  Allows: read and write its memory, set breakpoints
touch your key…
(gdb)
```

| Field | Values |
|---|---|
| Target | `session:s-…` (that session and its descendants) or `gen:fsv256:…` (any instance of that generation for the requesting human) |
| Scope | `process` (≤ 3 600 s) or `kernel` (≤ 900 s) |
| Debugger | A generation named in the policy list `debug.debuggers` (default: gdb, lldb, perf, bpftrace) |
| Who | The requesting human. Never an agent, unless the target is inside the agent's own session tree |

## How it is enforced

1. `Broker.debug` evaluates Cedar action `debug` on resource `DebugTarget` and requires T3 with presence.
2. `DebugAttach.attach` (warden) spawns the debugger as a child of the human's shell session, with seccomp profile `debug-1`.
3. warden writes a `kl_debug_pairs` entry: tracer cgroup → target cgroup, expiry, scope.
4. `kl-exec` checks every `ptrace_access_check`, `perf_event_open` and `perf_event_alloc` (the event's actual target) against the pair map. For scope `kernel` it allows BPF tracing program types only (kprobe, tracepoint, raw_tracepoint, perf_event), never LSM, cgroup or XDP programs. `CAP_BPF` and `CAP_PERFMON` are ambient only for scope `kernel`.
5. On expiry or exit, warden removes the pair and kills the debugger. Receipts `debug.attach` and `debug.detach` record the target, scope, debugger and duration.

Yama and the seccomp baseline still apply; the pair map only adds the one relation.

## The legacy open broker

`compat`'s open broker reads seccomp-notification syscall arguments from legacy apps. warden gives it a permanent `kl_debug_pairs` entry for the app's lifetime that allows only `PTRACE_MODE_READ` (for `process_vm_readv`), never attach.

## Limitations

- A touch per debugging session on the host.
- During the window, the debugger has full access to its target. Keep the debugger list short, and use workbenches for routine work.
- Core dumps of host processes are confidential: `journal` stores them encrypted to the human ([Observability](../10-operations/observability.md)).

## Related

- [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md)
- [Shell](../09-experience/shell.md)
- [Developer workbench](../09-experience/developer-workbench.md)
- [ADR-0049: Debug capability](../11-decisions/adr-0049-debug-capability.md)
