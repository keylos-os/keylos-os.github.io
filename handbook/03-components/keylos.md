# keylos

> The distribution repository. It fixes the kernel configuration and hardening sysctls, assembles OS, runtime and bench images from [pkgs](pkgs.md) via [forge](forge.md), defines the profiles (desktop, server, appliance), ships the default policy and configuration, runs release engineering (streams, signing ceremonies, release-log statements) and the system-wide conformance suite.

**Status:** specified (v1.0) · **Spec:** [`keylos/spec.md`](../../specs/keylos/spec.md)

## Responsibilities

- **Kernel:**
  - upstream stable configuration with lockdown=integrity, LSM order `landlock,lockdown,yama,ipe,bpf`, the `kl-exec` BPF LSM, IPE for initramfs and kexec, fs-verity, module signature or hash enforcement, no out-of-image modules;
  - hardening sysctls (`memfd_noexec=2`, `unprivileged_bpf_disabled`, `perf_event_paranoid`, `legacy_tiocsti=0`, Yama);
  - feature-level matrix KL1–KL3.
- **Images:** OS generation, UKI (systemd-stub, signed), default runtimes, bench guest image, installer and recovery images.
- **Profiles:**

  | Profile | Content |
  |---|---|
  | `desktop` | atrium, portals, apps |
  | `server` | Headless; bench and aide optional |
  | `appliance` | Fixed function, no workbench |

  Each boot derives an integrity profile: `full`, `shared-boot`, `shim`, `cloud-vtpm`, `cvm` or `degraded` ([Profiles and hardware](../01-overview/profiles-and-hardware.md)).
- **Default configuration:** Nickel defaults for every service, the default Cedar policy (approval tiers, effect classes, host categories), and the default agent policy.
- **Release engineering:**
  - streams `stable`, `beta`, `dev`;
  - TUF repository and roles;
  - offline signing ceremonies;
  - release statements in the release log;
  - PCR predictions;
  - revocation lists;
  - the rebuilder quorum requirement.
- **Conformance:** a system test suite covering boot verification, confinement reports per tier, the Rule of Two, effect mandates, rollback, recovery drills and restore tests.

## Runs as

A build and release repository. Nothing in it runs on hosts except the artifacts it assembles.

## Key decisions

- [ADR-0003: Stock kernel, feature levels](../11-decisions/adr-0003-stock-kernel-feature-levels.md)
- [ADR-0013: Owner Secure Boot keys](../11-decisions/adr-0013-owner-secure-boot-keys.md)
- [ADR-0016: Rebuilder quorum and transparency logs](../11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md)
- [ADR-0017: TUF over OCI](../11-decisions/adr-0017-tuf-over-oci.md)

## Related

- [Profiles and hardware](../01-overview/profiles-and-hardware.md)
- [Kernel config and sysctls](../13-reference/kernel-config-and-sysctls.md)
- [Key ceremonies](../10-operations/key-ceremonies.md)
