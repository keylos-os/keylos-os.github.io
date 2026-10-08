# Quality attributes

> The measurable budgets keylos v1.0 must meet on its reference hardware. Each spec turns the relevant rows into acceptance criteria.
> Security that is slow or brittle gets turned off, so these budgets are part of the security design.

## Reference hardware

| Class | Reference machine |
|---|---|
| Laptop | 8-core x86-64-v3 or ARMv8.2+, 16 GiB RAM, NVMe SSD (≥ 2 GB/s), firmware TPM 2.0, integrated GPU |
| Desktop | 12-core x86-64-v3, 32 GiB RAM, NVMe SSD, discrete or firmware TPM 2.0, AMD or Intel GPU |
| Server | 16+ cores, 64 GiB RAM, NVMe, discrete TPM 2.0, headless |
| Minimum supported | 4 cores, 8 GiB RAM, SSD, TPM 2.0, KVM (workbenches refuse to start without KVM) |

All figures are p95 on the laptop reference machine unless noted.

## Boot and unlock

| Attribute | Budget | Owner |
|---|---|---|
| Power-on to PIN prompt (firmware excluded) | ≤ 2.0 s | [boot](../../specs/boot/spec.md) |
| PIN entered to unlocked volume (TPM unseal + LUKS2 AEAD open) | ≤ 1.2 s | boot |
| Verify-before-unlock: QR shown to phone verdict | ≤ 3 s, including the log lookup with network; ≤ 1 s with cached predictions | [vouch](../../specs/vouch/spec.md) |
| Unlock to greeter | ≤ 2.5 s | [warden](../../specs/warden/spec.md), [atrium](../../specs/atrium/spec.md) |
| Login to usable desktop | ≤ 1.5 s | atrium, [hearth](../../specs/hearth/spec.md) |
| Resume from suspend to lock screen | ≤ 0.8 s | atrium, [devd](../../specs/devd/spec.md) |

## Process and app launch

| Attribute | Budget | Owner |
|---|---|---|
| `Supervisor.spawn` overhead for a tier-1 process (namespaces, Landlock, seccomp, cgroup, UID) | ≤ 8 ms | warden |
| Network namespace for a new principal (from the pre-created pool) | ≤ 2 ms | warden |
| Cold GUI app launch, extra cost versus an unconfined process | ≤ 20 ms | warden, [depot](../../specs/depot/spec.md) |
| `depot.mount` of an already-installed generation | ≤ 5 ms | depot |
| Broker `request` decided at T0/T1 (Cedar plus token mint) | ≤ 1 ms | [broker](../../specs/broker/spec.md) |
| Broker `materialize` (token check plus `openat2`) | ≤ 300 µs | broker |
| capwire round trip on the same host (small message, one fd) | ≤ 40 µs | [protocols](../../specs/protocols/spec.md) |
| Shell command dispatch with fd powerbox (kish) | ≤ 10 ms on top of the spawn | [kish](../../specs/kish/spec.md) |

## Workbenches and VMs

| Attribute | Budget | Owner |
|---|---|---|
| Workbench start from a warm snapshot | ≤ 300 ms to the first exec | [bench](../../specs/bench/spec.md) |
| Workbench cold boot (no snapshot) | ≤ 2 s | bench |
| `Vm.fork` of a running workbench | ≤ 500 ms | bench |
| Idle workbench memory (after free-page reporting) | ≤ 150 MiB | bench |
| Tier-2 GUI app VM start | ≤ 1 s to first frame | bench, atrium |
| virtio-fs read throughput versus host | ≥ 70% | bench |
| GPU (native context) frame rate versus host | ≥ 85% | bench |
| Media VM start to first directory listing (USB stick) | ≤ 1.5 s | bench, [devd](../../specs/devd/spec.md) |
| Agent desktop VM start to first screenshot | ≤ 2 s | bench, [aide](../../specs/aide/spec.md) |
| Concurrent VMs, by RAM class (small / medium / large) | 2 / 6 / 16; pod VMs bounded by kubelet `maxPods` | bench |
| `keylos-vm` pod sandbox ready (warm image cache) | ≤ 1 s | [cri](../../specs/cri/spec.md), bench |
| `keylos-sealed` container start | ≤ 150 ms | cri, warden |

## Approvals and agents

| Attribute | Budget | Owner |
|---|---|---|
| Trusted-path prompt on screen after the request | ≤ 150 ms | atrium |
| Approval round trip excluding human time (decision to mandate in gate) | ≤ 50 ms | broker, [gate](../../specs/gate/spec.md) |
| T3 prompts per hour in a typical coding-agent session | ≤ 3 (target 1: the final merge and push) | [aide](../../specs/aide/spec.md), policy defaults in [keylos](../../specs/keylos/spec.md) |
| gate proxy overhead per HTTPS request | ≤ 3 ms p95 | gate |
| Budget enforcement latency: overrun to stop | ≤ 1 request | gate |
| Receipt append (broker → ledger, countersigned) | ≤ 2 ms | [ledger](../../specs/ledger/spec.md) |
| Quorum presence: request created to envelope complete (excluding human time) | ≤ 5 s after the last signature | [hearth](../../specs/hearth/spec.md) |
| USB device approval prompt after attach | ≤ 300 ms | devd, atrium |
| Debug grant to debugger attached (excluding the touch) | ≤ 500 ms | warden, broker |

## Updates and storage

| Attribute | Budget | Owner |
|---|---|---|
| Typical security update download (zstd:chunked, per-object delta) | ≤ 5% of the full OS generation size | [courier](../../specs/courier/spec.md), depot |
| Staging an update (download excluded): verify, predict PCRs, write UKI | ≤ 30 s | courier |
| Reboot into a new generation, including health checks and blessing | ≤ 1.5× a normal boot | courier, warden |
| Automatic rollback after a failed update | ≤ 3 boot attempts, no human action | courier, boot |
| Transaction begin (overlay set-up) for a project tree | ≤ 50 ms | [strata](../../specs/strata/spec.md) |
| Transaction commit for ≤ 1,000 changed files | ≤ 1 s | strata |
| Snapshot of a data subvolume | ≤ 100 ms | strata |
| Store overhead for fs-verity Merkle trees | ≤ 1% of object bytes | depot |
| Dedup between OS, runtimes and apps | 100% file-level for identical objects | depot |

## Resource overhead

| Attribute | Budget |
|---|---|
| Resident memory of all tier-0 services at an idle desktop | ≤ 350 MiB |
| CPU at an idle desktop (all keylos services) | ≤ 0.5% of one core |
| Battery life versus an unconfined distribution on the same hardware | ≥ 95% |
| Disk I/O overhead of LUKS2 AEAD with dm-integrity | ≤ 15% throughput, documented per profile |
| Provenance capture (creation-time only) | ≤ 2% on file-create-heavy benchmarks |

## Recoverability and availability

| Attribute | Budget |
|---|---|
| Machines that cannot boot any generation after any single failed update | 0 by construction (A/B with boot counting, previous generation pinned) |
| Recovery environment availability | Always present on the ESP; reachable from the boot menu with the recovery key |
| Restore of a full machine from declaration plus backups | Documented and tested monthly in CI in a VM; ≤ 1 h for 100 GiB on 1 Gbit/s |
| Loss of the primary FIDO2 key | Recoverable with the backup key, or with the recovery key and a re-enrolment ceremony |

## Security quality targets

| Target | Measure |
|---|---|
| Processes with ambient filesystem access in the native tiers | 0 (checked by `Process.confinement` reports in CI) |
| Host executables not covered by `kl-exec` | 0 outside declared JIT exceptions |
| Base-image reproducibility | 100% bit-for-bit across ≥ 3 rebuilders |
| Tier-0 code in memory-unsafe languages, new | 0 lines |
| Fuzzing | Every parser of untrusted input in tier 0 has a continuous fuzz target |

## Related

- [Principles](principles.md)
- [Profiles and hardware](profiles-and-hardware.md)
- [Observability](../10-operations/observability.md)
- [Status](../13-reference/status.md)
