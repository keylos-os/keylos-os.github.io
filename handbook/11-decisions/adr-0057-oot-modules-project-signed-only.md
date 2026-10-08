# ADR-0057: Out-of-tree kernel modules are project-built and release-signed only

> Kernel modules load only from the OS generation or from a `kmod` generation, and every module must carry the release stream's module signature. Owners can't seal modules. Out-of-tree drivers, such as the NVIDIA open kernel modules, are built reproducibly by `forge`, signed at release, and registered only when their target kernel matches the running one.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Integrity / hardware | forge, pkgs, warden, keylos, compat, protocols |

## Context

- A kernel module is kernel code. Lockdown with `module.sig_enforce=1` lets only signed modules load. Owners hold no module-signing key, and giving them one would let any presence-authorised mistake (or an owner tricked into sealing) load arbitrary kernel code.
- Some hardware needs out-of-tree drivers. The most common case is NVIDIA GPUs, whose open kernel modules are outside mainline.
- Proprietary binary-only modules can't be reproduced or reviewed, which conflicts with the rebuilder quorum ([ADR-0016](adr-0016-rebuilder-quorum-and-transparency-logs.md)).
- The writer of the compat spec found that owner-sealed modules are impossible under lockdown, so a "compat profile" that loads arbitrary modules would contradict the integrity model.

## Decision

- **Sources** ([protocols §9.3](../../specs/protocols/spec.md#93-code-integrity-host)): the OS generation, or a `kmod` generation (§6.1). Every module is signed by the release stream's module-signing key.
- **Builds.** `forge` builds `kmod` generations reproducibly from source. Signing is a detached derivation over the reproduced output.
- **Registration.** `warden` registers a `kmod` mount with `kl-exec` only if its manifest `kmod.kernel` equals the running kernel release.
- **Userspace.** Proprietary userspace parts (for example GPU user-mode drivers) live in runtime generations and follow the normal app rules.
- **No owner-sealed modules and no unsigned-module profile.**

## Alternatives considered

| Option | Why not |
|---|---|
| Owner-sealed modules | Gives owners a kernel-code signing path; one mistake owns the kernel |
| A reduced-integrity profile allowing any signed module (MOK) | Recreates the shim/MOK trust sprawl; indistinguishable from compromise to attestation |
| DKMS-style local builds | Unsealed compilers on the host; non-reproducible kernels |
| No out-of-tree drivers | Excludes common GPUs and some Wi-Fi hardware |

## Consequences

### Positive
- The kernel's code is always traceable to reproducible, release-signed builds.
- Attestation can describe every loaded module by generation.

### Negative
- Hardware that needs binary-only modules isn't supported.
- Out-of-tree drivers follow the project's release cadence; a new kernel waits for matching `kmod` generations.

## Related

- [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md)
- [Profiles and hardware](../01-overview/profiles-and-hardware.md)
- [Devices and media](../06-security/devices-and-media.md)
- [ADR-0008: The host executes only sealed code](adr-0008-host-executes-only-sealed-code.md)
