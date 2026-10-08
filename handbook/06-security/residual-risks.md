# Residual risks

> What keylos does not solve, solves only partly, or solves at a cost the owner should know about. Each risk names what reduces it and what remains.
> Read this together with the [threat model](../01-overview/threat-model.md). A security design is only as honest as its list of what it does not do.

## Platform and kernel

| # | Risk | What reduces it | What remains |
|---|---|---|---|
| R1 | **The host kernel is the TCB** for tiers 0, 1 and legacy. One reachable kernel bug defeats Landlock, seccomp and namespaces | seccomp removes user namespaces, io_uring, bpf, perf, userfaultfd and mount paths; untrusted apps and all unsealed code run in VMs; kernel updates ship through courier within days; `lockdown=integrity` | An in-memory kernel exploit is undetected until reboot. After a reboot, attestation and `kl-exec` return the host to verified code |
| R2 | **Firmware, ME/PSP, EC and microcode** are trusted and unverifiable | Measured into PCR0–7 and checked by vouch; owner Secure Boot keys; IOMMU forced | A malicious or buggy firmware is out of reach |
| R3 | **GPU drivers** are a large ioctl surface reachable from tier-1 apps and, through native context, from VMs | Tier-1 apps are sealed and reviewed; untrusted apps run in tier 2; `needs.gpu` is declared and shown at install | No fine-grained DRM ioctl mediation exists on Linux |
| R4 | **Hardware side channels** between co-resident principals | Standard mitigations; separate VMs for untrusted work | No general fix on shared cores and caches |
| R5 | **Kernel feature lag** on the LTS floor (KL1): no Landlock rules for pathname unix sockets or UDP | Network namespaces with only `lo`, egress via gate, views without socket files; the compensation appears in confinement reports | Slightly larger kernel surface for networking on KL1 |

## Trusted components

| # | Risk | What reduces it | What remains |
|---|---|---|---|
| R6 | **Trusted helpers become escape paths** (broker, portals, gate, bench/crosvm, virtiofsd, atrium) | Invariant I7 (fd-only, no path following); Rust; each helper confined in tier 0 with its own Landlock and seccomp; continuous fuzzing | These components are the new TCB; their bugs are the most valuable to attackers |
| R7 | **JIT runtimes** (browsers, JVMs) need executable anonymous memory, which `kl-exec` cannot vouch for | `needs.jit` declared and shown; BPF LSM exception scoped to the cgroup; browsers in tier 1 at minimum, tier 2 offered | A JIT bug gives code execution inside that app's confinement |
| R8 | **Interpreter patches** for `AT_EXECVE_CHECK` are carried by keylos until upstreams adopt them | Patches are small and tested in [pkgs](../../specs/pkgs/spec.md); unpatched interpreters run only in workbenches | Divergence from upstream interpreters |
| R9 | **Reused C components** (iwd, BlueZ, PipeWire, CUPS drivers, Mesa) | Each runs confined in tier 0 or a D-Bus island with a dedicated policy | Memory-safety bugs inside them remain possible within their confinement |

## Agents and approvals

| # | Risk | What reduces it | What remains |
|---|---|---|---|
| R10 | **Injection inside granted authority**: an agent misuses authority it legitimately holds, with poisoned arguments | Rule of Two; staged effects with rendered argument provenance; narrow grants; budgets | An approved effect with a subtly poisoned argument the owner did not notice |
| R11 | **Label creep**: most real tasks end up `private/untrusted`, pushing toward more T3 prompts or broad declassification policies | Per-effect classes; sink-safe hosts; optional flow proofs from CaMeL-style harnesses | Policy authors can over-declassify |
| R12 | **Covert channels** through allowlisted hosts that accept user content (GitHub, package registries), DNS and timing | Method and path restrictions on hosts; gate sampling and anomaly receipts; DNS through net only | Low-bandwidth exfiltration is possible to any host the agent may write to |
| R13 | **The human is the last line** at T3 | Rare, effect-rendered, batched prompts with provenance; presence for the riskiest actions | A tired owner can approve a bad effect |
| R14 | **Classifier misses** (over-eager actions read as consented) | Classifiers can only escalate a tier; policy is the floor | Their absence or failure never weakens policy, but they do not catch everything |

## State, keys and recovery

| # | Risk | What reduces it | What remains |
|---|---|---|---|
| R15 | **Overlay transactions** cannot handle shared mmap, live databases or files held open outside the transaction | Detection and refusal; serialisation for known databases | Some commands cannot run transactionally and say so |
| R16 | **Deletion versus history**: snapshots and backups keep data | Crypto-shredding per unit; keystore never snapshotted; encrypt before backup | Data outside a shred unit is deleted only when its snapshots and backups expire |
| R17 | **btrfs fscrypt not merged**: per-unit keys are implemented in userspace containers until it lands | strata abstracts the mechanism | Per-unit encryption costs more CPU until native support |
| R18 | **Loss of all owner keys** (FIDO2 primary and backup, recovery key) | Setup explains it; backups with an escrowed key | Data loss by design |
| R19 | **TPM weaknesses**: discrete-bus sniffing, fTPM side channels, firmware PCR prediction gaps | TPM + PIN; salted sessions with a pinned SRK; unpredictable PCRs are dropped rather than failing; recovery key | Odd firmware event logs reduce how many PCRs are bound |
| R20 | **Rollback protection for user data** is checkpoint-level, not per write | TPM NV counter bound to Merkle checkpoints of snapshots | An offline attacker can roll back data between checkpoints |

## Supply chain

| # | Risk | What reduces it | What remains |
|---|---|---|---|
| R21 | **Malicious upstream source** (xz class) | Source rules S1–S5; separate build and test; dependency budgets; review tiers raised on maintainer-health signals | Needs human review; reproducible builds cannot catch it |
| R22 | **Rebuilder collusion** (k of n operators) | Independent organisations, jurisdictions and infrastructure; the owner may add a personal rebuilder to the quorum | k colluding operators can still agree on a bad build |
| R23 | **Bootstrap seed trust** | Full-source bootstrap from a hex0 seed; diverse double-compiling of the C toolchain | The seed and the bootstrap interpreter remain trusted |
| R24 | **Standards churn** for agent identity and authorization (OAuth/WIMSE drafts, MCP authorization) | Adapters in gate and aide; the internal model is Biscuit and Cedar | Interop shims need maintenance |

## Gaps-round risks

| # | Risk | What reduces it | What remains |
|---|---|---|---|
| R28 | **Quorum presence is weaker than a touch** for sealing on headless machines | N distinct owners must sign; the seal-gate blob is bound to PCR11 `ready` and PCR15; status shows `sealing: quorum` | Trust shifts to "N approvers and a verified hearth"; colluding approvers can seal |
| R29 | **`shared-boot` machines** keep Microsoft-signed components trusted | TPM+PIN, signed PCR11 policy, pcrlock, NV floor; integrity profile visible | Vulnerable signed boot components until revoked in dbx |
| R30 | **Debug windows** give one debugger full access to its target | T3 with presence, one target, ≤ 1 h (≤ 15 min kernel scope), sealed debugger list, receipts | A malicious or exploited debugger during the window |
| R31 | **Pod VMs share the host kernel's KVM and virtio surface** | crosvm device sandboxes, tap only in the cri netns, admission forbids host access | VM-escape bugs in KVM or device backends |
| R32 | **Media VMs** still pass bytes from untrusted media to apps | Labelled `public/untrusted`; the Rule of Two applies; host never parses the filesystem | App-level parser bugs in the receiving app |
| R33 | **Agent desktops** still render attacker-controlled pages to the agent | Isolation in a VM; effects staged through gate; take-over | Visual prompt injection steering actions inside the VM |
| R34 | **Long offline periods** delay revocations | Revocation age tracked; stricter approvals after 30 days | A machine offline for weeks may run code revoked in the meantime |
| R35 | **Shredded receipt months** leave only metadata | Retention configurable; exports before shredding | Investigations can't recover shredded payloads (by design) |

## Usability risks that become security risks

| # | Risk | Mitigation |
|---|---|---|
| R25 | Owners disable verify-before-unlock because it is slow | Budget of ≤ 1 s with cached predictions; TOTP fallback; never mandatory on every boot in the laptop profile, required in the server profile |
| R26 | Owners grant "always allow" to escape prompts | Persistent grants are listed and revocable in one place; T3 effects cannot be made persistent for irreversible classes |
| R27 | Developers find the host/workbench split too slow | Warm snapshots, project workbenches that stay up, sealing windows for tools they build often |

## Related

- [Threat model](../01-overview/threat-model.md)
- [Security](README.md)
- [Quality attributes](../01-overview/quality-attributes.md)
- [Decisions](../11-decisions/README.md)
