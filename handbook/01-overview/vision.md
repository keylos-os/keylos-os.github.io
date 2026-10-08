# Vision

> AI agents now act with their user's full authority on an operating system designed for trusted people at terminals.
> keylos rebuilds the Linux userland so that every actor holds exactly the authority it was given. Changes become reversible or receipted, and verified code is what runs after every boot.

## The problem

The Unix authority model has two kinds of subject, a user and root. Anything a user runs can do anything that user can do: read `~/.ssh`, write `~/.bashrc`, open any socket, spend any credential found in an environment variable. That was a reasonable model for people sharing a minicomputer. It is the wrong model for 2026, where the actors on a personal machine are:

| Actor | What it needs | What Unix gives it |
|---|---|---|
| A text editor | The files you open, a sync endpoint | Your whole home, every network host, your credentials |
| A package's install script | Its own build directory | Everything you can do, once, at install time |
| A coding agent | One repository, a test runner, one forge API, a budget | Your shell, your tokens, your other repositories, unlimited egress |
| A compromised dependency | Nothing | Everything the above can do |

The failures are already happening:

- Agents have dropped production databases, wiped drives during cleanup, and copied private repository contents into public pull requests after reading a malicious issue.
- MCP servers have been rug-pulled: a clean history followed by one version that blind-copied every email to an attacker.
- Agent harnesses have been escaped. The escapes came through the trusted helper following a symlink or writing a configuration file, not through the kernel.
- Detection does not solve this. Published prompt-injection defenses were broken at over 90% attack success, and people approve almost every permission prompt they are shown.

No model will behave perfectly. The operating system has to bound what any behaviour can do.

## Why now

| Change | Since | Why it matters |
|---|---|---|
| Landlock reaches ABI 7–10: filesystem, TCP and UDP, ioctl, signal and socket scopes, audit, thread sync | 6.15–7.2 | Unprivileged, stackable, deny-by-default confinement for every process |
| BPF LSM, fs-verity, composefs with `verity=require` (and IPE for the initramfs) | 6.6–6.12 | Execute only verified bytes, at file granularity, with dedup |
| `AT_EXECVE_CHECK` and exec securebits | 6.14 | Interpreters can enforce the same exec policy as the kernel |
| pidfds, `SO_PEERPIDFD`, the new mount API, `MOVE_MOUNT_BENEATH` | 5.x–6.5 | Race-free process identity and namespace construction |
| microVMs start in about 100–300 ms from a snapshot; virtio-gpu native context | 2024–2026 | Untrusted code and agents can get their own kernel at interactive speed |
| Signed PCR policies, pcrlock, UKIs; the 2026 UEFI CA rotation | 2023–2026 | TPM-bound disks that survive updates, and a reason to take back the Secure Boot keys |
| Reproducible builds at distribution scale, C2SP transparency logs, Rekor v2 | 2024–2026 | Binaries can be verified by independent parties, not just trusted |
| Agents as everyday software | 2025–2026 | The cost of ambient authority is now paid daily |

The kernel pieces exist. Nobody has assembled a userland on top of them that treats authority, integrity and reversibility as one design.

## What keylos is

- **A complete Linux userland** on a stock, upstream kernel: boot, init and supervision, store and packages, configuration, identity, authority, networking, devices, shell, desktop, developer workbenches, a legacy compatibility tier and agent runtime. It ships as signed images in desktop, laptop, server and appliance profiles.
- **A capability system.** The broker turns policy and the owner's choices into Biscuit tokens and then into file descriptors. Nothing else confers authority.
- **A verified system.** The host runs only sealed code. Updates are verified against a TUF repository, a quorum of independent rebuilders and transparency logs. The owner can check the boot state on their phone before typing a PIN.
- **A reversible system.** Generations for system, apps and configuration; snapshots and transactions for data; an outbox and mandates for effects that cannot be undone.
- **A home for agents.** An agent session is a principal with attenuated authority, a budget, labels and a workbench of its own. It proposes; the owner signs.

## What keylos is not

| Not | Because |
|---|---|
| A new kernel | The upstream kernel already has the primitives; a new kernel would cost a decade of drivers |
| POSIX-conformant in its native tier | Ambient paths, setuid and fork-inherits-everything are what it removes. The legacy tier runs unmodified POSIX software inside a confined view |
| A multi-user timesharing system first | Multiple humans are supported, but the threat it designs against is software acting for one human |
| A container platform | Containers run inside workbenches. The host's unit of isolation is the principal, not the container |
| A model or an agent | keylos is the runtime that makes any harness and any model safe to run unattended |
| A promise against kernel or firmware 0-days | Those are reduced and detected, not eliminated. See [Residual risks](../06-security/residual-risks.md) |

## The pitch

> **keylos** is a Linux userland where every program and agent gets exactly the authority you give it. Every change is reversible or receipted, and a reboot puts the machine back on verified code.

| Audience | What keylos gives them |
|---|---|
| A developer running coding agents | Agents in a workbench fork of the repository, a budget, a reviewed merge, and a staged pull request instead of a surprise push |
| Someone who just wants a safe laptop | Apps that cannot read what they were not given, updates that cannot brick the machine, and undo for mistakes |
| A security team | Every grant, effect and approval is a signed receipt; machines can be attested; policy is code |
| An organisation deploying agents | Delegation that narrows at every hop, hard budgets, and declassification that needs a human |

## Related

- [Principles](principles.md)
- [Threat model](threat-model.md)
- [Architecture](../02-architecture/README.md)
- [Agents](../07-agents/README.md)
- [Sources](../13-reference/sources.md)
