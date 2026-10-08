# Approvals

> keylos interrupts a human only at decisions that matter: irreversible effects, declassification, merges, budget overruns and anything that needs a presence touch. Each approval shows the rendered effect and where every argument came from.
> Approvals happen on the trusted path drawn by the compositor. Each decision becomes a signed mandate in the ledger.

**Status:** specified (v1.0). Components: [broker](../../specs/broker/spec.md) (policy, approval records), [gate](../../specs/gate/spec.md) (rendering, mandates), [atrium](../../specs/atrium/spec.md) (trusted path), [hearth](../../specs/hearth/spec.md) (presence).

## Tiers

| Tier | Covers | Human interaction |
|---|---|---|
| T0 | Reads and overlay writes within grants | None; receipt only |
| T1 | Reversible egress to granted hosts | None. A classifier may **escalate** to T2/T3. |
| T2 | Compensable effects, new hosts, widening a sub-agent's scope | Batched review |
| T3 | Irreversible effects, declassification, budget overrun, merging an agent overlay, config apply, seal, policy change | Synchronous prompt on the trusted path. FIDO2 presence is required for config, seal, policy, payments, and effects whose policy says `presence`. |

Policy assigns tiers with Cedar annotations. A `permit` with `@tier("t3")` means "permitted after T3 approval". No automated component can lower a tier: not a classifier, not a template, not an agent.

```cedar
@tier("t3")
permit (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { principal.kind == "agent" && resource.kind == "fs.merge" };
```

## Why so few prompts

When people see a permission prompt per command, they approve nearly all of them, and approval stops meaning anything. keylos does three things instead:

1. **Keep the safe case silent.** Anything inside the overlay and within grants is T0. Reading granted hosts is T1.
2. **Batch the compensable case.** T2 reviews group pending compensable intents per session, because each can be undone.
3. **Make the rare prompt informative.** T3 shows effects, not commands:

| Shown | Example |
|---|---|
| Rendered effect | The email as it will be sent; the diff to be merged; the cart total |
| Argument provenance | "Recipient: from your message"; "Body: from web page https://…" |
| Session label | U / P / X badges and when each was acquired |
| Context | Effects already committed in the session, budget spent, sub-agents |
| Scope | Once / this session / persistent |

## Required review details fail closed

An approval is only as good as what the human actually saw. Each effect kind has **required review details** (protocols §14.2), for example the recipients, subject, body and attachment names, sizes and types of an `email.send`; the method, URL and body of an `http.*`; amount, currency and payee of a payment; the complete manifest and diff of an `fs.merge`. Each `RenderedEffect` is marked `review: required` (the default) or `decorative`, and carries the `payloadDigest` of the mandate-draft effect it presents. Only gate or broker may mark a rendering decorative; a requester never can ([ADR-0064](../11-decisions/adr-0064-fail-closed-approval-rendering.md)).

| Situation | Approve button |
|---|---|
| Every required rendering presented completely | Enabled |
| Renderer crashed or timed out, gate's canonical-text fallback presents every required detail within limits | Enabled, marked "plain-text view" |
| A required detail is absent, malformed, unsupported or truncated beyond the review contract | Disabled: Deny or Defer only |
| Only a title or a hash is available | Disabled |

The rule is the same on every channel: local prompts, owner-presence cards, the vouch phone, org approvers and quorum review. A phone that can't show the required material leaves the request pending for a capable channel (or it expires and is denied); a truncation notice never counts as review.

## Declassification: the Rule of Two

A session that has read untrusted input (U) and private data (P) cannot also communicate outward (X) without a decision. When gate sees U ∧ P ∧ X, it opens a **declassification** prompt at T3, combined with the effect prompt if the X is an effect.

There are two ways through:

| Way | When |
|---|---|
| Human approval | Always available. The prompt explains which inputs tainted the session. |
| Flow proof (`camel/1`) | The agent template runs a trusted interpreter harness (a WASI component in aide) that tracks per-value provenance. It proves that untrusted data flows only into *data* fields (an email body) and never into *control* fields (recipient, URL, amount). The proof waives the declassification, never an irreversible-class mandate. |

## Mandates

An approved T3 decision is a **mandate** (`keylos.mandate/1`). Broker-built mandates use the real effect kinds of the request: an intent's own kind, or a mandate-only kind for grants and other broker decisions (`grant.<resource kind>`, `grant.declassify`, `debug.attach`, `pod.admit`), and they record the permitted channels in `constraints.channels`. `x-` members never carry authority. The draft shown on the prompt is not yet a valid mandate; it becomes one when the decider fills in who decided and on which channel. It is signed:
- by the owner's FIDO2 key when presence is required (a presence signature over the DSSE PAE hash, `alg` `fido2-es256`/`fido2-eddsa`);
- otherwise by atrium's per-boot approver key, registered with the broker through `BrokerSystem.registerApprover`;
- or, when a policy permit lists the channel with `@channels`, by the vouch phone approval key (`channel: "phone"`) or an org approver key through fleet's `OrgDecider` (`channel: "org"`). Those channels never satisfy a presence requirement.

**What relying services verify.** A presence-signed mandate is delivered as is. A non-presence mandate (atrium, phone or org) is re-signed by `service/broker` after the broker has checked the deciding channel's signature, so gate, strata, bench and depot only ever verify owner-presence keys and the broker key. The `approval.decide` receipt carries the mandate's digest (`mandateDigest`).

**Channel selection.** `ApprovalPrompt.channels` lists who may decide. `phone` appears only when the matching permit's `@channels` includes it **and** a vouch approver key is registered this boot; `org` only for `@orgApproval` permits on fleet-enrolled machines. When a permit has both `@tier` and `@orgApproval`, the local approval comes first and both are required.

It binds the kind, target and **sha256 of the exact payload**, a scope, and constraints such as expiry and maximum amount. gate refuses to commit irreversible intents without a matching mandate, and a `once` mandate cannot be replayed.

gate obtains the mandate directly from the decision: it asks for approval on behalf of the session that staged the intent with `BrokerSystem.requestFor`, and the returned `GrantResult` carries the mandate (apps waiting on an `Approval` read `Approval.mandate`). The mandate is also recorded in the `approval.decide` receipt. Anyone auditing later can verify what was approved, by whom, and whether the bytes sent match.

## The trusted path

Prompts are drawn by `atrium`, the compositor, in a surface that no client can overlay, cover or imitate:
- a dimmed desktop;
- a fixed frame colour per principal tier;
- the principal's identity, taken from broker, never from the app.

Presence prompts ask for a touch of the enrolled FIDO2 key. Keyboard input into prompts comes only from physical input devices. Synthetic input from clients cannot reach the trusted path.

## Scopes and persistence

| Scope | Lasts |
|---|---|
| `once` | One intent; the mandate digest is consumed |
| `session` | All matching intents in this session (and its children, if allowed by policy) until the session ends |
| `persistent` | Stored as a grant record by broker and re-minted each boot. Not available for irreversible effects of agents by default. |

## Model drift

Agent templates name their models as `(provider, model, minVersion)`, and the session token carries a `model(...)` fact. gate records the model and version each provider reports. When the observed pair differs from the token's, aide writes `model.change`, and **every T1 action of that session is treated as T2** until the human re-approves the session. Local models are pinned by their weights generation and can't drift ([protocols §14.5](../../specs/protocols/spec.md#145-operating-rules)).

## Family and quorum machines

- On family machines, a non-owner's request that needs an owner becomes a prompt to the owners with `requester` set.
- On quorum machines, every presence requirement becomes a quorum requirement ([ADR-0048](../11-decisions/adr-0048-quorum-presence.md)).
- Guest sessions never receive presence-class grants, persistent grants or (by default) agent sessions.

## Classifiers

A distribution or user may run a classifier on T1 traffic (for example an "over-eagerness" model on agent tool calls). It can only **escalate**: T1 → T2/T3. It never sees secrets, and it cannot approve.

## Limitations

- At T3 the human is the last line. A plausible-looking malicious diff can still be approved.
- Session-level labels are coarse. Long sessions accumulate taint and hit declassification more often. Forking clean sessions keeps prompts rare.
- Flow proofs cover only values that pass through the trusted interpreter. VM-side tools are outside the proof.

## Related

- [Effects and the outbox](effects-and-outbox.md)
- [Network egress](../06-security/network-egress.md)
- [ADR-0028 Approval tiers](../11-decisions/adr-0028-approval-tiers.md)
- [ADR-0064 Fail-closed approval rendering](../11-decisions/adr-0064-fail-closed-approval-rendering.md)
- [ADR-0066 S2 contract fixes](../11-decisions/adr-0066-s2-contract-fixes.md)
- [ADR-0026 Labels and the Rule of Two](../11-decisions/adr-0026-labels-and-rule-of-two.md)
- [ADR-0011 Owner presence with FIDO2](../11-decisions/adr-0011-owner-presence-fido2.md)
- [ADR-0034 Wayland-only with a trusted path](../11-decisions/adr-0034-wayland-only-trusted-path.md)
