# ADR-0026: Labels and the Rule of Two, enforced by the OS

> Every object carries a `{confidentiality, integrity}` label and every session's label only rises as it reads. broker and gate enforce the Rule of Two: no session may combine untrusted input (U), private data (P) and external communication or irreversible change (X). Asking for the third property becomes a T3 declassification, unless a registered flow proof applies.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Security / agents | broker, gate, aide, strata, protocols |

## Context

- Prompt injection can't be reliably detected. "The Attacker Moves Second" broke 12 published defenses, most at over 90% attack success, with human red-teamers at 100% (https://arxiv.org/abs/2510.09023).
- Simon Willison's "lethal trifecta" (private data + untrusted content + exfiltration channel, https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) and Meta's "Agents Rule of Two" (https://simonw.substack.com/p/new-prompt-injection-papers-agents) describe the dangerous combination.
- CaMeL (https://arxiv.org/abs/2503.18813) and FIDES (https://arxiv.org/abs/2505.23643) give guarantees through information-flow control inside the agent runtime, but need labels that survive leaving the interpreter, and a reference monitor the model can't bypass.
- GitHub's MCP exfiltration (https://invariantlabs.ai/blog/mcp-github-vulnerability) is exactly U+P+X in one session.

## Decision

- Lattice: conf `public < internal < private < secret`; integ `trusted < user < untrusted` (protocols §14.1).
- Objects: files via `security.bpf.keylos.label`, with defaults by location. Connections are labelled by gate. Tool results are labelled by aide and broker.
- Sessions: `label = max(label, object)` on every broker-mediated read. Labels never decrease.
- Rule of Two: U = `integ == untrusted`; P = `conf ≥ private`; X = commit right, effect resource or egress to a host not marked `sink-safe`. All three together need T3 declassification or a flow proof (`keylos.flowproof/1`) from an agent template whose manifest has `agent.flowProof: "camel/1"` and whose harness runtime is on the policy's trusted list. Services that hand data across principals raise the receiver's label through `LabelAuthority.raiseFor` before the hand-off.
- Directory grants carry an enforced ceiling: the receiver is raised to the ceiling before exposure and the LSM refuses anything above it for the grant's lifetime; a bounded scan never lowers a ceiling ([ADR-0062](adr-0062-directory-label-ceilings.md), amending this record after ISS-004).
- The OS label is the backstop. Value-level IFC in the harness is recommended, not required.

## Alternatives considered

| Option | Why not |
|---|---|
| Classifier-based detection | Probabilistic; adaptive attacks break it |
| Per-byte taint tracking in the kernel | Too expensive and lossy (whole-system provenance costs 45%+ with 90%+ loss, https://arxiv.org/pdf/2608.11418) |
| Harness-only IFC | Bypassed if the harness is buggy or compromised |

## Consequences

### Positive
- The exfiltration pattern behind most agent incidents needs a human decision.

### Negative
- **Label creep:** most real tasks end up tainted. That pushes toward approvals; mitigated by `sink-safe` hosts and flow proofs.
- Covert channels through allowlisted hosts that accept user content (GitHub, registries) remain.

## Related

- [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md)
- [Approvals](../07-agents/approvals.md)
- [ADR-0028: Approval tiers](adr-0028-approval-tiers.md)
- [ADR-0062: Directory grants have enforced label ceilings](adr-0062-directory-label-ceilings.md)
