# ADR-0008: The host executes only sealed code

> On the host, `execve`, `mmap(PROT_EXEC)`, `mprotect` adding exec, firmware and module reads come only from composefs mounts of generations whose signatures were verified against the boot trust set, or from the verified initramfs. The mechanism is the `kl-exec` BPF LSM keyed to the superblocks of verified mounts; IPE is a second layer for the initramfs and kexec. Interpreters honour `AT_EXECVE_CHECK`. memfd execution is disabled.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted (revised in protocols 1.0 final) | 2026-10-07 | Integrity | boot, keylos, depot, warden, pkgs, kish, forge, hearth |

## Context

- If nothing unsealed ever runs on the host, persistence after a userspace compromise needs a kernel or firmware exploit, which makes "reboot heals" possible.
- composefs mounted with `verity=require` already makes one fs-verity digest commit to every file's content and metadata, checked lazily by the kernel on every open and page read. What is missing is a rule that **exec is allowed only from such mounts, and only for generations someone trusted signed**.
- IPE (6.12) can restrict execution to dm-verity or fs-verity-backed files under a signed policy (https://docs.kernel.org/6.12/admin-guide/LSM/ipe.html). The first draft of this ADR used it as the primary mechanism with a "`.ipe` keyring". Working through the specs showed three problems:
  - **IPE has no keyring of its own.** Trust in individual files would have to come from fs-verity builtin signatures checked against the kernel's `.fs-verity` keyring.
  - **The kernel can't verify Ed25519.** Every keylos signing root (release streams, publishers, owner seals) signs with Ed25519 or TPM-held P-256; per-file kernel signatures would need a second P-256 key per root and one signature per store object (millions). Builtin fs-verity signatures are also discouraged upstream in favour of userspace verification.
  - **IPE can't express provenance through a composefs mount**, that is "this file was reached through a verified mount of generation X". Its properties describe the file or the block device, not the overlay mount it was reached through.
- IMA appraisal has failed in practice because per-file signature xattrs get lost (tar, cp, overlay copy-up) and the policy language is hard.
- Interpreters bypass exec checks (`python x.py`). Kernel 6.14 added `AT_EXECVE_CHECK` and the `SECBIT_EXEC_RESTRICT_FILE` / `SECBIT_EXEC_DENY_INTERACTIVE` securebits (https://docs.kernel.org/userspace-api/check_exec.html), but no CPython or mainstream shell has adopted them upstream.

## Decision

- **`kl-exec`, a BPF LSM**, loaded by `kl-initrd` before it executes anything but itself ([protocols §9.3](../../specs/protocols/spec.md#93-code-integrity-host)):
  - `bprm_check_security`, file-backed `mmap_file` with `PROT_EXEC` and `file_mprotect` adding `PROT_EXEC`: allowed only if the file's superblock is in `kl_exec_allowed_sb`, or during the initrd phase from the initramfs.
  - Anonymous executable memory: only for cgroups in `kl_exec_jit_cgroups` (generations with `needs.jit: true`, shown at install; they also skip `PR_SET_MDWE`).
  - `kernel_read_file` (firmware, modules, policy): allowed mounts and the initramfs only; kexec always denied. `kernel_load_data` denied.
  - `bpf` load and detach: only from the root cgroup, where warden core is the only userspace task.
- **Registration.** Before a mount's superblock enters the allow map, the registrant (boot for the OS and bootstrap generations, warden for everything else) verifies the generation statement (`keylos.genstmt/1`) in userspace against the **boot trust set** (`/run/keylos/boot/trust.json`: release-stream keys from the UKI, owner-presence keys from the owner registry anchored in TPM NV, owner-seal and publisher keys from the verified config generation), checks the revocation list, and reads `s_dev` from the tree fd. Only warden core writes the map. Writable mounts are always `noexec` as well.
- **IPE as a second layer**, with a policy signed by `kernel-policy/<stream>`: allow `boot_verified` exec and kernel reads (the initramfs), deny kexec. No fs-verity builtin signatures and no `.fs-verity` keyring policy.
- Also: `vm.memfd_noexec=2`, `kernel.unprivileged_bpf_disabled=2`, signed BPF loaders only for boot and warden, `module.sig_enforce=1` with modules only inside the OS generation.
- All interpreters in [pkgs](../03-components/pkgs.md) are patched to honour `AT_EXECVE_CHECK`. warden sets `SECBIT_EXEC_RESTRICT_FILE` on every host principal and `SECBIT_EXEC_DENY_INTERACTIVE` on every host principal except the process tree spawned through `TrustedSpawn.spawnTerminal` (the human's trusted terminal in atrium).
- Everything unsealed runs in workbench VMs ([ADR-0009](adr-0009-unsealed-code-in-workbenches.md)). To run your own build on the host, you seal it ([ADR-0012](adr-0012-sealing-windows.md)).

## Alternatives considered

| Option | Why not |
|---|---|
| IPE as the primary mechanism with fs-verity builtin signatures | A kernel-verifiable signature per store object; no Ed25519 in the kernel, so a parallel P-256 key per signing root; builtin signatures discouraged upstream; can't express composefs-mount provenance |
| IPE with an "`.ipe` keyring" | IPE has no keyring |
| IMA appraisal | xattr signatures lost by tools; operational failure history |
| noexec mounts only | Bypassed by interpreters, `ld.so`, memfd |
| Allow unsealed code in tier-1 sandboxes | Breaks "reboot heals"; one sandbox bug becomes persistence |
| fapolicyd-style userspace allowlist | Racy, slower, bypassable by a compromised service |

## Consequences

### Positive
- "Reboot heals": persistence requires a kernel or firmware exploit, a parser re-trigger, or a social attack on sealing.
- One signature check per generation, in userspace, with any algorithm keylos uses. The kernel's job shrinks to "is this superblock registered".
- Dropped binaries in `/home` or `/var` can never execute.

### Negative
- `kl-exec` is keylos-specific kernel policy code. It is small, reviewed and covered by the `boottrust/` conformance vectors, but it is not an upstream LSM.
- The design relies on overlay superblocks never being shared across mounts of different images, and on warden being the only map writer. Both are stated invariants with tests.
- Developers must use workbenches for unsealed code; host tools need sealing.
- We carry interpreter patches until upstream adoption.
- JIT apps (browsers) are a known runtime-integrity hole, contained by tier.

## Related

- [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md)
- [Reboot heals](../05-integrity/reboot-heals.md)
- [Boot chain](../05-integrity/boot-chain.md)
- [ADR-0007: composefs and fs-verity store](adr-0007-composefs-fsverity-store.md)
- [ADR-0009: Unsealed code in workbenches](adr-0009-unsealed-code-in-workbenches.md)
