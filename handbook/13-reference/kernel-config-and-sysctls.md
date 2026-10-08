# Kernel configuration and sysctls

> The kernel options, command-line parameters and sysctls keylos depends on, with the component that requires each and why.
> The `keylos` distribution spec is normative for the full kernel `.config`. This page is the readable reference.

**Status:** specified (v1.0). Requirements come from [boot](../../specs/boot/spec.md), [warden](../../specs/warden/spec.md), [journal](../../specs/journal/spec.md) and the [keylos distribution](../../specs/keylos/spec.md).

## Feature levels

| Level | Kernel | Adds |
|---|---|---|
| KL1 | ≥ 6.18 (LTS floor) | Landlock ABI 7, BPF LSM, IPE, fs-verity, overlayfs `verity=require`, pidfd family (`SO_PEERPIDFD`), `openat2`, new mount API, `MOVE_MOUNT_BENEATH`, idmapped mounts, `AT_EXECVE_CHECK`, `memfd_secret`, `mseal`, cgroup v2 (`cgroup.freeze`, `cgroup.kill`) |
| KL2 | ≥ 7.1 | Landlock ABI 9: pathname unix socket rules, thread sync |
| KL3 | ≥ 7.2 | Landlock ABI 10: UDP rules |

Components probe features at runtime and act by level, never by version string.

## Required kernel options

| Option | Value | Required by | Why |
|---|---|---|---|
| `CONFIG_SECURITY_LANDLOCK` | y | warden | Baseline confinement |
| `CONFIG_SECURITY_IPE` | y | boot | Initramfs and kexec policy |
| `CONFIG_BPF_LSM` | y | boot | `kl-exec` |
| `CONFIG_DEBUG_INFO_BTF` | y | boot, warden | `kl-exec` and `kl-label` compute kernel-structure offsets from BTF at load |
| `CONFIG_FUNCTION_TRACER`, `CONFIG_DYNAMIC_FTRACE`, `CONFIG_DYNAMIC_FTRACE_WITH_DIRECT_CALLS` | y | boot | BPF trampolines attach through ftrace on arm64 (tracefs stays unmounted) |
| `CONFIG_HIBERNATION` | n | — | Lockdown refuses hibernation; keylos supports suspend-to-RAM only |
| `CONFIG_LSM` | `landlock,lockdown,yama,ipe,bpf` | boot | LSM order (also set on the cmdline) |
| `CONFIG_SECURITY_LOCKDOWN_LSM` | y | boot | `lockdown=integrity` |
| `CONFIG_SECURITY_YAMA` | y | warden | ptrace restrictions |
| `CONFIG_FS_VERITY`, `CONFIG_FS_VERITY_BUILTIN_SIGNATURES` | y, n | depot, boot | Store objects; signatures are handled by keylos, not the kernel keyring |
| `CONFIG_OVERLAY_FS` | y | boot, depot | composefs |
| `CONFIG_EROFS_FS` | y | boot, depot | Generation images |
| `CONFIG_BTRFS_FS` | y | strata | Data subvolumes |
| `CONFIG_DM_CRYPT`, `CONFIG_DM_INTEGRITY`, `CONFIG_CRYPTO_AEGIS128` | y | boot | LUKS2 AEAD |
| `CONFIG_TCG_TPM`, `CONFIG_TCG_CRB`, `CONFIG_TCG_TIS` | y | boot | TPM 2.0 |
| `CONFIG_MODULE_SIG_FORCE` | y | boot | Signed modules only |
| `CONFIG_KEXEC`, `CONFIG_KEXEC_FILE` | n | boot | kexec is never used |
| `CONFIG_USER_NS` | y | warden | Legacy tier and idmapped mapping namespaces only |
| `CONFIG_CGROUP_BPF`, `CONFIG_CGROUP_DEVICE` | y | warden | Per-principal device programs |
| `CONFIG_KVM` | y (m) | bench | Workbenches and t2 VMs |
| `CONFIG_IO_URING` | y | — | Built in, but denied to every principal by seccomp; available only to `bench`'s VMM processes when declared |
| `CONFIG_MEMFD_SECRET` (`secretmem.enable=1`) | y | vault | Secret delivery |
| `CONFIG_DEBUG_FS` | n | — | Attack surface |
| `CONFIG_DEVMEM`, `CONFIG_DEVPORT` | n | — | Attack surface |
| `CONFIG_LEGACY_TIOCSTI` | n | warden | TTY injection |
| `CONFIG_INIT_ON_ALLOC_DEFAULT_ON`, `CONFIG_INIT_ON_FREE_DEFAULT_ON` | y | — | Memory hygiene |
| `CONFIG_RANDOMIZE_KSTACK_OFFSET_DEFAULT` | y | — | Exploit hardening |
| `CONFIG_SLAB_FREELIST_HARDENED`, `CONFIG_SLAB_BUCKETS` | y | — | Heap hardening |
| `CONFIG_STATIC_USERMODEHELPER` | n | journal | `core_pattern` pipe helper |

## Kernel command line (in the signed UKI)

| Parameter | Purpose |
|---|---|
| `composefs=<digest>` | Pins the OS generation |
| `keylos.stream=<s> keylos.seq=<n>` | Release identity |
| `lockdown=integrity` | No kernel modification from userspace |
| `module.sig_enforce=1` | Signed modules |
| `lsm=landlock,lockdown,yama,ipe,bpf` | LSM order |
| `ipe.enforce=1 ipe.success_audit=0` | IPE in enforcing mode (second layer: initramfs and kexec rules) |
| `keylos.execmapfds=3,4,5,6,7` | fd numbers under which boot hands the `kl-exec` maps to warden (an argument of warden's `execve`, not of the kernel command line) |
| `keylos.execlinkfds=9,…,18` | fd numbers of the ten `kl-exec` hook links warden keeps open (warden argv) |
| `init_on_alloc=1 init_on_free=1 page_alloc.shuffle=1 slab_nomerge randomize_kstack_offset=on vsyscall=none` | Hardening |
| `debugfs=off oops=panic panic=10` | Fail closed, reboot (boot counting falls back) |
| `iommu=force`, `intel_iommu=on` / `amd_iommu=force_isolation`, `efi=disable_early_pci_dma` | DMA protection |
| `sysctl.vm.memfd_noexec=2 sysctl.dev.tty.legacy_tiocsti=0 sysctl.kernel.unprivileged_bpf_disabled=2 sysctl.kernel.yama.ptrace_scope=2` | Set before userspace starts |

## Sysctls (set by warden at boot or on the cmdline)

| Sysctl | Value | Why |
|---|---|---|
| `vm.memfd_noexec` | 2 | No executable memfds |
| `dev.tty.legacy_tiocsti` | 0 | No TTY input injection |
| `kernel.yama.ptrace_scope` | 2 | ptrace only with `CAP_SYS_PTRACE` (nobody holds it) |
| `kernel.unprivileged_bpf_disabled` | 2 | No unprivileged BPF |
| `kernel.perf_event_paranoid` | 3 | No perf for principals |
| `kernel.kptr_restrict` | 2 | Hide kernel pointers |
| `kernel.dmesg_restrict` | 1 | Kernel log only through `journal` (owner) |
| `kernel.kexec_load_disabled` | 1 | kexec off |
| `kernel.core_pattern` | `\|/usr/lib/keylos/journal-coredump %P %i %s %t %c %h %d %F` | Confidential crash reports |
| `kernel.core_pipe_limit` | 4 | Bound concurrent crash handling |
| `fs.suid_dumpable` | 0 | No cores of privileged processes |
| `fs.protected_symlinks`, `fs.protected_hardlinks` | 1 | Link attack protection |
| `fs.protected_fifos`, `fs.protected_regular` | 2 | Same |
| `net.core.bpf_jit_harden` | 2 | JIT spraying |
| `user.max_user_namespaces` | default in the init namespace; 0 inside every legacy namespace | Only warden creates user namespaces |
| `kernel.panic_on_oops` | 1 | Fail closed |
| `vm.unprivileged_userfaultfd` | 0 | userfaultfd is also denied by seccomp |
| `net.ipv4.conf.all.rp_filter` | 1 | Set by `net` |

## Related

- [Confinement tiers](../06-security/confinement-tiers.md)
- [Boot chain](../05-integrity/boot-chain.md)
- [keylos distribution spec](../../specs/keylos/spec.md), [boot spec](../../specs/boot/spec.md), [warden spec](../../specs/warden/spec.md)
- [ADR-0003 Stock kernel and feature levels](../11-decisions/adr-0003-stock-kernel-feature-levels.md)
