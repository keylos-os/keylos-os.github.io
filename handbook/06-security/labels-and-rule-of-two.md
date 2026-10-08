# Labels and the Rule of Two

> keylos tracks what each session has read, using a confidentiality label and an integrity label. Labels only go up.
> A session must not hold all three of untrusted input, private data and a way to act outside. Completing that set is a declassification that needs a human, or an accepted flow proof for reversible flows.

**Status:** specified (v1.0). Semantics: [protocols §14.1](../../specs/protocols/spec.md). Enforcement: [broker §4.6–4.7](../../specs/broker/spec.md) and [gate](../../specs/gate/spec.md).

## Why

Prompt injection cannot be filtered reliably. Published defenses have been broken by adaptive attacks. What keylos can do is **bound the consequences**: an agent that read attacker-controlled text must not be able to exfiltrate private data or take irreversible action without a human seeing it. This is the "lethal trifecta" idea, enforced by the OS instead of hoped for in the model ([ADR-0026](../11-decisions/adr-0026-labels-and-rule-of-two.md)).

![Labels and the Rule of Two](../images/labels-rule-of-two.svg)

## The labels

| Dimension | Levels (low → high) | Rises when the session reads… |
|---|---|---|
| Confidentiality | `public` < `internal` < `private` < `secret` | Personal files (`private`), secret values (`secret`) |
| Integrity | `trusted` < `user` < `untrusted` | Web responses, downloads, content written by other principals (`untrusted`) |

Higher integrity means *less* trustworthy. Labels are stored on files as the `security.bpf.keylos.label` xattr. The `security.bpf.` prefix matters: it is the only namespace (besides `user.*`, which any file owner can write) whose xattrs a BPF LSM program can read, so warden's `kl-label` program can enforce grant ceilings; setting it needs `CAP_SYS_ADMIN`, which no principal holds ([ADR-0069](../11-decisions/adr-0069-s3-execution-core-contract-fixes.md)). Without the xattr, location defaults apply:

| Location | Default |
|---|---|
| Home data | `private/user` |
| `~/Downloads`, caches | `public/untrusted` |
| An app's own data | `private/user` |
| Removable media | `internal/untrusted` |
| Store (sealed code and data) | `public/trusted` |
| Response from a host | `public/untrusted`, or `public/user` for hosts policy marks trusted |
| Secrets | `secret/user` |

## How sessions get tainted

- The broker raises a session's label **when it hands out a handle**:
  - a file raises it to the file's label;
  - a directory raises it to the grant's **ceiling** (its exposure label; see [Directory grant ceilings](labels-and-rule-of-two.md#directory-grant-ceilings));
  - a network socket raises integrity to the host's response label.
- Child sessions start with their parent's label.
- Harnesses and apps can raise their own label (`Broker.raiseLabel`) when they know they took in untrusted data some other way.
- **Label authority.** Services that hand data from one principal to another (gate, bench, portals, atrium, strata, aide) raise the receiver's label with `LabelAuthority.raiseFor` **before** the hand-off: gate for responses, bench when a guest opens a file on a virtio-fs share, portal-clipboard and atrium for pastes and drops, portal-openuri for opened files.
- Labels never go down within a session. A new session starts clean.

## Directory grant ceilings

A directory is not one object: it can hold files nobody has looked at, and new files can arrive after the grant. A bounded scan can therefore never prove a low label. keylos makes the ceiling true by enforcement instead (protocols §14.1, [ADR-0062](../11-decisions/adr-0062-directory-label-ceilings.md)):

| Rule | Effect |
|---|---|
| Every directory grant has a ceiling *c* | The receiver is raised to *c* **before** the directory is exposed |
| Nothing above *c* is readable through the grant, for the grant's lifetime | warden's BPF LSM `kl-label` refuses `open` of objects labelled above *c* (and reads through fds opened via the grant mount), and of objects with a malformed label |
| Choosing *c* | The join of a complete walk when it finishes within bounds; a truncated walk never lowers *c* below the location default, and entries above *c* are simply hidden (shown as "hidden: higher label") |
| No enforcement available | A grant without a ceiling is labelled `secret/untrusted`, the top of the lattice |
| Unlabelled objects | Get their location default; on kernels without `bpf-init-inode-xattr`, unlabelled objects created after the grant count as `secret/untrusted` |
| Nested mounts | Grant trees are non-recursive bind mounts, so a mount inside the tree is not reachable |

Relabels, renames into the tree and retained handles follow the same rule: what matters is the object's current label, checked on open and on read.

**Agents.** Agent input should be an immutable, completely assessed snapshot: a bench share or a strata transaction base is a read-only snapshot, so its ceiling is exact and can't drift. Live directories with a lower ceiling stay possible for apps, because the LSM keeps the ceiling true.

## The rule

| Property | Holds when |
|---|---|
| **U** — untrusted input | integrity = `untrusted` |
| **P** — private data | confidentiality ≥ `private` |
| **X** — a way out | the session holds or requests: a `commit` right, any effect right, or egress to a host not marked **sink-safe** |

**A session may hold at most two of U, P and X.** The broker checks this when granting, when materializing, and when `gate` stages or commits an effect. The request that would complete the set becomes a **declassification**.

| Session so far | Then requests | Outcome |
|---|---|---|
| Read a web page (U) | Open private notes (P) | Allowed, as long as it holds no X |
| U + P | POST to a third-party API (X) | T3 declassification prompt |
| P + X (holds a mail-send right) | Fetch a web page (U) | T3 declassification prompt |
| U + X | Read public docs | Allowed (not private) |

**Sink-safe hosts** are hosts the owner marks as unable to pass data to third parties, such as the owner's own servers. The default is `localhost` only.

## Declassification

The T3 prompt shows:
- the session's label and **which inputs raised it** (for example "untrusted: https://example.com/issue/42");
- the effect or egress requested, rendered (the email as it will be sent, the request body);
- for each argument, **where its value came from** ("recipient came from web page X").

If the human approves, the resulting mandate binds the exact payload digest, or for raw egress a short-lived (5-minute) host grant.

## Flow proofs

Some agent harnesses track provenance per value, in the style of CaMeL: they can show that control flow and critical arguments came only from the user. Such a harness can attach a `keylos.flowproof/1` to a request. The broker accepts the proof instead of a prompt only when:

1. the agent template's manifest has `agent.flowProof: "camel/1"` (which requires a `wasi` harness placement);
2. its harness runtime generation is on the owner's trusted-runtime list;
3. every control source has integrity `user` or better;
4. the proof binds the exact payload digest, and is signed by the session key aide registered with `BrokerSystem.registerSessionKey`;
5. the effect is **not irreversible**. Irreversible effects always reach a human.

## Limitations

- **Granularity.** Labels are per session, not per value. Long, mixed tasks tend to become fully tainted, so split work into sessions (sub-agents) on purpose.
- **Directory ceilings hide or taint.** A grant either hides higher-labelled entries or, when the owner asks for them, takes their label; one untrusted file a session must read taints that session.
- **Covert channels remain.** Data can leak through allowed hosts that accept user content (a code host, a package registry), and through timing. Mark such hosts as not sink-safe and keep agent egress narrow.

## Related

- [Capabilities and the broker](capabilities-and-broker.md)
- [Network egress](network-egress.md)
- [Agents](../07-agents/README.md)
- [Residual risks](residual-risks.md)
- [ADR-0026](../11-decisions/adr-0026-labels-and-rule-of-two.md), [ADR-0062](../11-decisions/adr-0062-directory-label-ceilings.md)
- [broker spec](../../specs/broker/spec.md) · [protocols §14](../../specs/protocols/spec.md)
