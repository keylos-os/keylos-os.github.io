# Security

> keylos has one authority model for every actor: a principal holds only the capabilities it was handed, every handle is enforced by the kernel, and every grant, approval and effect leaves a receipt.
> This section explains who the principals are, how authority is created and confined, how information flow is tracked, and what stays out of reach on a stock Linux kernel.

**Status:** specified (v1.0).

## The model in one picture

![Authority flow: request, decide, mint, materialize](../images/authority-flow.svg)

1. **Identity.** Comes from `warden`, which creates every connection and names the peer in `ServiceHost.accept`. A message's claims never count ([Principals and identity](principals-and-identity.md)).
2. **Decision.** Cedar policy plus approval tiers, evaluated by `broker` ([Capabilities and the broker](capabilities-and-broker.md)).
3. **Token.** Biscuit, attenuable offline, re-minted every boot ([Capability tokens](../04-contracts/tokens.md)).
4. **Handle.** An fd, a socket or a capwire capability. It is the only thing the kernel and services honour.
5. **Confinement.** Landlock, seccomp and namespaces, with microVMs for unsealed code ([Confinement tiers](confinement-tiers.md), [Namespaces](namespaces.md)).
6. **Flow.** Session labels and the Rule of Two ([Labels and the Rule of Two](labels-and-rule-of-two.md)).
7. **Evidence.** Receipts in the ledger ([Receipts](../04-contracts/receipts.md)).

## Pages

| Page | Contents |
|---|---|
| [Principals and identity](principals-and-identity.md) | Humans, actors and sessions; principal IDs; dynamic UIDs; how a service knows who is calling |
| [Capabilities and the broker](capabilities-and-broker.md) | Request pipeline, approvals, materialization, powerbox, delegation, revocation, persistent grants |
| [Confinement tiers](confinement-tiers.md) | The baseline sandbox; tiers t0–t3 and legacy; what each costs |
| [Namespaces](namespaces.md) | Which namespaces exist and why only `warden` creates them; user namespaces only for legacy |
| [Labels and the Rule of Two](labels-and-rule-of-two.md) | Confidentiality and integrity labels, taint propagation, declassification, flow proofs |
| [Secrets](secrets.md) | The vault: ACLs by generation identity, delivery without env vars, injection for agents, forgetting |
| [Network egress](network-egress.md) | `gate` as the only path out, host policy, credential injection, metering |
| [Devices and media](devices-and-media.md) | USB authorization, BadUSB defence, IOMMU and Thunderbolt, the media VM for removable storage, other devices |
| [Debugging](debugging.md) | `Right.debug`: time-limited, presence-approved ptrace and perf on the host; unrestricted debugging in workbenches |
| [Trusted path](trusted-path.md) | Prompts that apps cannot spoof; presence (FIDO2) for owner acts |
| [Residual risks](residual-risks.md) | What keylos does not solve on stock Linux, and how each risk is narrowed |

## Security invariants

| ID | Invariant | Enforced by |
|---|---|---|
| I1 | The host executes only sealed code | `kl-exec` BPF LSM keyed to verified composefs mounts, composefs `verity=require`, the boot trust set; IPE for initramfs and kexec |
| I2 | No ambient authority; everything is a granted handle | Landlock, seccomp, namespaces, broker |
| I3 | Persistent state changes are transactions; system and config changes need owner presence | config, hearth, depot, TPM counters |
| I4 | Unsealed code runs only in workbench VMs | bench |
| I5 | External effects of non-human principals go through `gate` | Network namespace and egress proxy |
| I6 | Every grant, approval and effect produces a signed receipt | ledger |
| I7 | Trusted helpers never resolve paths for less-trusted callers | `openat2` rules, code review, fuzzing |

## Principles for security decisions

- **Fail closed.** If the ledger, trusted path or policy is unavailable, authority is not created.
- **Escalate, never de-escalate.** No automated component lowers an approval tier.
- **Effects, not commands.** Approvals show what will happen (a diff, a rendered email, a total), not the command that does it.
- **Owner acts need a touch.** Config, seals, persistent approvals and policy changes are signed by a FIDO2 assertion over the exact document.
- **Reboot heals.** Reboot restores verified code and owner-approved configuration; without a kernel or firmware exploit, malware cannot persist as code. Writable state may still hold hostile data and may need quarantine or recovery.

## Related

- [Contracts: tokens](../04-contracts/tokens.md), [Cedar policy](../04-contracts/cedar-policy.md), [receipts](../04-contracts/receipts.md)
- [Integrity](../05-integrity/README.md)
- [Agents](../07-agents/README.md)
- [Decisions](../11-decisions/README.md)
