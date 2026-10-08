# ADR-0010: crosvm as the single VMM

> keylos uses one virtual machine monitor, crosvm, for workbenches (tier 3), untrusted app VMs (tier 2), legacy apps from the internet and build sandboxes. One VMM means one device-model attack surface to harden and audit.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Execution | bench, forge, compat, aide |

## Context

| VMM | Strength | Gap for keylos |
|---|---|---|
| crosvm | Rust; each virtio device in its own minijail+seccomp process; production in ChromeOS Crostini; virtio-gpu native context and Wayland proxying | Larger than Firecracker |
| Firecracker | Minimal, fastest cold path | No GPU, no display; headless only |
| Cloud Hypervisor | Rust; virtio-fs, VFIO, hotplug; Kata's choice | Weaker GPU/display story |
| libkrun | Library VMM, sub-second start, used on Asahi with muvm | Less hardened device model; ties VMM into the caller process |
| QEMU | Most complete | Large C attack surface |

- keylos needs GPU (native context, https://www.qemu.org/docs/master/system/devices/virtio/virtio-gpu.html) and display for tier-2 apps. Snapshots, forks and virtio-fs are needed for workbenches.

## Decision

- crosvm is the only VMM. bench wraps it with keylos confinement on top of crosvm's per-device sandboxing.
- Workbenches use snapshot/restore for fast start. Tier-2 apps use virtio-gpu native context where the host driver supports it (AMD and Freedreno first) and fall back to software rendering otherwise.
- virtiofsd runs as its own confined process per share.

## Alternatives considered

| Option | Why not |
|---|---|
| Firecracker for workbenches + crosvm for GUI | Two device models to harden; duplicated tooling |
| libkrun | Faster but weaker isolation of device emulation |
| Cloud Hypervisor | GPU/display gaps for tier 2 |
| QEMU | C attack surface |

## Consequences

### Positive
- One VMM to fuzz, patch and confine. ChromeOS production lineage.

### Negative
- Cold start is slower than Firecracker; mitigated by snapshots.
- Intel native-context GPU support lags (Mesa MR in review).

## Related

- [bench](../03-components/bench.md)
- [ADR-0009: Unsealed code in workbenches](adr-0009-unsealed-code-in-workbenches.md)
- [Confinement tiers](../06-security/confinement-tiers.md)
