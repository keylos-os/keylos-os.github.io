# Threat model

> Who keylos defends against, what they want, where the trust boundaries lie, and which control answers each threat.
> The model is centred on one owner, many pieces of software acting for them, and a hostile network.

## Assets

| Asset | Examples | Primary protection |
|---|---|---|
| Owner data | Documents, mail, source code, photos | Capabilities (no ambient access), labels, crypto-shredding, snapshots |
| Credentials | SSH keys, API tokens, cloud keys, payment authority | vault (handles, not values), proxy injection, FIDO2 |
| Integrity of the machine | Boot chain, OS, apps, configuration | Signed UKI, `kl-exec`, signed config generations, NV counters |
| External reputation and money | Emails sent, code pushed, payments, published packages | Effect outbox, mandates, budgets, Rule of Two |
| Accountability | What happened, who caused it | ledger receipts, provenance |
| Availability and recoverability | Booting, unlocking, restoring | A/B generations, boot counting, recovery key, backups |

## Attackers

| # | Attacker | Capability assumed | Goal |
|---|---|---|---|
| T1 | **Malicious or compromised app**, including a hostile update | Arbitrary code inside one app principal | Read other data, steal credentials, persist, spread |
| T2 | **Prompt-injected or over-eager AI agent** | Arbitrary tool calls within its grants, steered by attacker text | Exfiltrate private data, cause effects, widen its own authority |
| T3 | **Network attacker and malicious content** | Controls web pages, documents, issues, mail and DNS answers seen by the machine | Deliver T1/T2, exploit parsers, inject instructions |
| T4 | **Offline physical attacker** | Holds the device while it is off or suspended; can swap disks, flash firmware on unprotected boards, sniff discrete TPM buses | Read the disk, plant a bootkit, roll back state |
| T5 | **Compromised distribution channel** | Controls a mirror, a CDN, one builder, or one signing key | Ship a backdoored or rolled-back generation |
| T6 | **Persistent intruder** | Has gained code execution in userspace once | Survive reboot and updates |
| T7 | **Destructive mistakes** | The owner or an agent runs the wrong command | Data loss, broken system |

## Trust boundaries

```
 ┌──────────── firmware / CPU / TPM (trusted, unverifiable — out of scope) ────────────┐
 │  boot chain: owner Secure Boot keys → systemd-boot → signed UKI → initrd            │
 │  ┌──────────────── host kernel (TCB for tiers 0, 1, legacy) ─────────────────────┐  │
 │  │  warden · broker · ledger · vault · gate · depot · strata · …  (tier 0, Rust) │  │
 │  │  ─────────────── capability boundary (Landlock, seccomp, ns, UID) ─────────── │  │
 │  │  apps (t1)   shell   legacy (userns view)                                     │  │
 │  │  ─────────────── VM boundary (KVM + confined crosvm) ──────────────────────── │  │
 │  │  workbenches (t3) · untrusted app VMs (t2) — own guest kernels                │  │
 │  └───────────────────────────────────────────────────────────────────────────────┘  │
 └─────────────────────────────────────────────────────────────────────────────────────┘
   network: everything outside is untrusted; egress for non-human principals only via gate
```

| Boundary | Crossed by | Enforced by |
|---|---|---|
| Owner ↔ software | Trusted-path prompts, FIDO2 touch | atrium (compositor-owned surfaces), hearth |
| Principal ↔ principal | capwire calls, granted fds | Landlock, seccomp, namespaces, dynamic UIDs, broker |
| Host ↔ VM | virtio-fs shares, virtio-net into `bench-net`, vsock control (capwire-vsock, no fds), virtio-gpu | KVM, crosvm device sandboxes, bench, gate `ShimEndpoint` |
| Machine ↔ network | gate proxy, net | Network namespaces, Landlock net rules, gate policy |
| Machine ↔ distribution | TUF, OCI, logs | courier, depot, tlog verification |
| Boot ↔ runtime | PCR11 phase change, NV counters | TPM policy |

## Threats and controls

| Threat | Attack | Control | Where |
|---|---|---|---|
| T1 | App reads `~/.ssh` or other apps' data | No ambient filesystem access; per-app data subvolumes; powerbox | [Capabilities and the broker](../06-security/capabilities-and-broker.md) |
| T1 | App connects anywhere | Per-app network namespace; egress only through granted sockets | [Network egress](../06-security/network-egress.md) |
| T1 | Update quietly widens authority | Capability diff on install; consent before launchable | [depot spec](../../specs/depot/spec.md) |
| T1 | App reads secrets from another app | vault ACLs keyed to generation digest, identity via pidfd | [Secrets](../06-security/secrets.md) |
| T1 | Kernel exploit from an app | seccomp removes userns, io_uring, bpf and mount paths; untrusted apps in tier 2 VMs | [Confinement tiers](../06-security/confinement-tiers.md) |
| T2 | Injected agent exfiltrates private data | Labels and the Rule of Two; declassification at T3 | [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md) |
| T2 | Agent sends email or pays | Irreversible effects staged; mandate bound to payload digest | [Effects and the outbox](../07-agents/effects-and-outbox.md) |
| T2 | Agent widens its own authority | Attenuation-only delegation; cannot write any config a harness reads; proposals need the owner's touch | [Agent principal](../07-agents/agent-principal.md) |
| T2 | Tool or MCP server rug-pull | Tools pinned by digest in the agent template | [Tools and MCP](../07-agents/tools-and-mcp.md) |
| T2 | Runaway cost | Budget caveats with hard stops; fan-out and depth limits | [Budgets](../07-agents/budgets.md) |
| T3 | Malicious document exploits a parser | Parsers run sandboxed in their app; untrusted apps in tier 2 | [Confinement tiers](../06-security/confinement-tiers.md) |
| T3 | DNS or time manipulation | DNSSEC and DoT/DoH; NTS-authenticated time; clock floor from the ledger checkpoint | [net spec](../../specs/net/spec.md) |
| T4 | Disk theft | LUKS2 with AEAD; TPM2 + PIN; keys never leave the TPM unsealed outside the initrd | [Boot chain](../05-integrity/boot-chain.md) |
| T4 | Evil maid / bootkit | Owner Secure Boot keys; measured boot; verify-before-unlock on the phone | [Attestation and vouch](../05-integrity/attestation-and-vouch.md) |
| T4 | Partition swap to trick TPM unlock | PCR15 volume identity checked before leaving the initrd | [Boot chain](../05-integrity/boot-chain.md) |
| T4 | Rollback of state or downgrade of boot | TPM NV counters for config generations, boot version floor and ledger checkpoints | [Reboot heals](../05-integrity/reboot-heals.md) |
| T5 | Backdoored binary from one builder | k-of-n independent rebuilders; realisation log with witnesses | [Transparency and rebuilders](../05-integrity/transparency-and-rebuilders.md) |
| T5 | Freeze or rollback of updates | TUF timestamp and snapshot roles; release log | [Supply chain](../05-integrity/supply-chain.md) |
| T5 | Malicious upstream source (xz class) | Source rules: git trees, regenerated build files, build cannot read tests, dependency budget for daemons | [Supply chain](../05-integrity/supply-chain.md) |
| T6 | Drop a binary and run it at boot | `kl-exec`: no exec from writable storage or unverified mounts; signed config only | [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md) |
| T6 | Persist through configuration | Read-only `/etc` from signed confext; counter-protected | [Config generations](../08-state/config-generations.md) |
| T6 | Trick the owner into sealing | Seal prompt shows source, diff and provenance; scoped sealing window | [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md) |
| T1 | Malicious USB device types commands (BadUSB) | USB devices unauthorized until trusted-path approval; keyboard-like devices approved only with an already-authorized input device | [Devices and media](../06-security/devices-and-media.md) |
| T3 | Malicious filesystem image on a USB stick exploits a kernel parser | Removable storage is never mounted on the host; a media VM parses it; files labelled untrusted | [Devices and media](../06-security/devices-and-media.md) |
| T2 | GUI agent sees or clicks the human's real session | Agents never get capture, accessibility or input on a real session; agent desktops in VMs | [Computer use](../07-agents/computer-use.md) |
| T2 | Remote model changes behaviour behind the same model ID | `model.change` escalates the session's T1 actions to T2 until re-approved | [Approvals](../07-agents/approvals.md) |
| T1 | A debugger or tracer reads another app's memory | ptrace/perf denied by default; `Right.debug` is T3 with presence, one target, time-limited | [Debugging](../06-security/debugging.md) |
| T5 | Machine kept offline to keep it on revoked code | Revocation age tracked; after 30 days new installs need T3 and new agent destinations need T2 | [Updates and rollback](../10-operations/updates-and-rollback.md) |
| T4 | DMA through Thunderbolt or external PCIe | IOMMU required; domains authorized only after approval | [Devices and media](../06-security/devices-and-media.md) |
| T1 | A container image escapes on a Kubernetes node | Pods run in microVMs by default; admission forbids privileged pods and host namespaces | [Kubernetes nodes](../10-operations/kubernetes.md) |
| T7 | `rm -rf` the wrong tree | Transactions, snapshots, `undo` | [Snapshots and transactions](../08-state/snapshots-and-transactions.md) |
| T7 | Broken update or config | A/B generations, boot counting, `config revert` | [Updates and rollback](../10-operations/updates-and-rollback.md) |

## Out of scope

| Out of scope | Why | What keylos still does |
|---|---|---|
| Firmware, ME/PSP, EC, microcode and silicon bugs | Cannot be verified from software | Measures firmware into PCR0–7; supports fwupd with vendor manifests; detects change through attestation |
| Side channels between co-resident principals | No general fix on shared hardware | Standard mitigations; untrusted work on separate VMs |
| A coerced owner | Social, not technical | Receipts make coerced actions visible afterwards |
| Kernel 0-days in tiers 0, 1 and legacy | The kernel is the shared TCB | Minimal reachable surface, fast updates, persistence detected after reboot |
| Physical attacks on a running, unlocked machine (cold boot) | Hardware-dependent | IOMMU required and Thunderbolt authorization, lock on suspend, `memfd_secret` for secrets |

## Related

- [Principles](principles.md)
- [Residual risks](../06-security/residual-risks.md)
- [Security](../06-security/README.md)
- [Integrity](../05-integrity/README.md)
