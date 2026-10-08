# ADR-0003: Stock upstream kernel with feature levels

> keylos ships an unmodified upstream Linux kernel inside its signed image and chooses behaviour by probed **feature levels** (KL1–KL3), not by version strings. The LTS floor is 6.18 (KL1); the target is the current 7.x stable series (KL3).

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Platform | keylos, warden, boot, all confinement users |

## Context

- The security primitives keylos needs all landed upstream between 2021 and 2026:
  - Landlock ABIs 1–10, including TCP (ABI 4), IPC scoping (ABI 6), audit (ABI 7), thread sync (ABI 8), pathname unix sockets (ABI 9) and UDP (ABI 10) (https://kernel.org/doc/html/v7.2/userspace-api/landlock.html);
  - IPE (6.12) (https://docs.kernel.org/6.12/admin-guide/LSM/ipe.html);
  - `AT_EXECVE_CHECK` (6.14) (https://docs.kernel.org/userspace-api/check_exec.html);
  - pidfd, `openat2`, the new mount API, `mseal`, `memfd_secret`.
- Out-of-tree patches (grsecurity-style) give more, but make reproducible builds, rapid security updates and hardware support much harder.
- Users on LTS kernels lack the newest Landlock rules. 6.12 LTS gives Landlock ABI 6; 6.18 LTS gives ABI 7.

## Decision

- Ship the current upstream stable kernel in the signed OS generation. Users never mix a keylos userland with an arbitrary kernel on the integrity profile.
- Define feature levels:

  | Level | Requires | Typical kernel |
  |---|---|---|
  | KL1 | Landlock ≥ 7, IPE, fs-verity, overlay `verity=require`, pidfd family, `openat2`, new mount API, `MOVE_MOUNT_BENEATH`, `AT_EXECVE_CHECK`, `memfd_secret`, `mseal`, cgroup v2, BPF LSM | 6.18 |
  | KL2 | KL1 + Landlock ≥ 9 (pathname unix sockets, TSYNC) | 7.1 |
  | KL3 | KL2 + Landlock ≥ 10 (UDP) | 7.2 |

- Components probe at runtime and record **compensations**. For example, on KL1/KL2 UDP is controlled by a private network namespace plus gate instead of Landlock UDP rules. The compensation is visible in the confinement report.
- Carry no out-of-tree kernel patches. Wanted features go upstream. Hash-based module integrity is adopted when it merges (https://lwn.net/Articles/1012946).

## Alternatives considered

| Option | Why not |
|---|---|
| Patched hardened kernel | Maintenance burden, reproducibility and update lag; fragmenting from upstream |
| Require the newest kernel only (KL3) | Excludes LTS users and appliance builders |
| Version-string checks | Backports make version numbers lie |
| A different kernel (seL4, Fuchsia) | Loses Linux hardware support and the application ecosystem |

## Consequences

### Positive
- Upstream security fixes flow quickly. Vendors can build on keylos without kernel forks.
- Behaviour is explicit per feature level and testable.

### Negative
- The monolithic kernel stays in the TCB for every non-VM tier ([Residual risks](../06-security/residual-risks.md)).
- Some protections are weaker on KL1 (compensated, but with more moving parts).

### Follow-ups
- Track the Landlock POSIX mqueue scope and other pending series. Add KL4 when they merge.

## Related

- [Kernel config and sysctls](../13-reference/kernel-config-and-sysctls.md)
- [Confinement tiers](../06-security/confinement-tiers.md)
- [keylos distribution](../03-components/keylos.md)
