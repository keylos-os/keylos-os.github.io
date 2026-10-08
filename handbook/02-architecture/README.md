# Architecture

> The shape of keylos: six layers of components on a stock kernel, coupled only through protocols. Two paths run through it: authority flows down from humans and policy, and evidence flows into the ledger.
> Start with system context and layers, then follow one request end to end.

![Layers and components](../images/layers-and-components.svg)

## Pages

| Page | Contents |
|---|---|
| [System context and layers](system-context-and-layers.md) | The machine and its outside world; the six layers and the 31 repositories; what each layer owns |
| [Dependency rules](dependency-rules.md) | Which component may call which interface and facet; tier-0 writers; forbidden directions |
| [Process tree and tiers](process-tree-and-tiers.md) | What runs under warden, in which tier, with which isolation |
| [Boot to desktop](boot-to-desktop.md) | From firmware to a logged-in desktop, step by step |
| [Authority flow](authority-flow.md) | From a request to a file descriptor: policy, approval, token, materialize |
| [Agent session flow](agent-session-flow.md) | An end-to-end worked example: an agent fixes a bug and opens a pull request |

## Architectural invariants

These seven invariants hold everywhere. Every other rule follows from them.

| ID | Invariant | Enforced by |
|---|---|---|
| I1 | The host kernel executes only code whose bytes are committed to by a signed root | `kl-exec` BPF LSM (verified composefs mounts only), composefs `verity=require`, boot trust set, IPE for initramfs and kexec, `memfd_noexec=2`, signed BPF |
| I2 | No process has ambient authority; every resource is reached through a broker-granted handle | Landlock, seccomp, namespaces built by warden, fd passing |
| I3 | Every persistent state change is a transaction with an author principal; system and config transactions need owner presence | Generations, presence key, TPM monotonic counters |
| I4 | Unsealed code runs only in a workbench: a microVM with its own kernel and only granted authority | bench (crosvm) |
| I5 | Effects outside the machine by non-human principals go through gate, which classifies, stages and logs them | Network namespaces, gate, outbox |
| I6 | Every grant, approval, transaction and effect produces a hash-chained, signed receipt | ledger, TPM-anchored checkpoints |
| I7 | Trusted helpers never resolve paths for less-trusted principals; they work on fds with `openat2(RESOLVE_BENEATH\|RESOLVE_NO_SYMLINKS)` | Code rules, fuzzing, review |

## Related

- [Overview](../01-overview/README.md)
- [Components](../03-components/README.md)
- [Contracts](../04-contracts/README.md)
- [protocols spec](../../specs/protocols/spec.md)
