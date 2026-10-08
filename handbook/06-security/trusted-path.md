# Trusted path

> Every decision that matters in keylos (approvals, owner presence, login, unlock, sealing, configuration) happens on a screen region and input path that no application can draw over, imitate or read. atrium renders all of it in its own process, behind a key that always reaches it.

Status: **specified (v1.0)**, implemented by [atrium](../../specs/atrium/spec.md); used by [broker](../../specs/broker/spec.md), [hearth](../../specs/hearth/spec.md), [config](../../specs/config/spec.md), [depot](../../specs/depot/spec.md) and [courier](../../specs/courier/spec.md).

## What the trusted path protects

An approval is only as good as the human's understanding of what they approved. keylos makes three guarantees about every approval screen:

1. **It is real.** No application can produce a lookalike that the human would mistake for it.
2. **It is accurate.** The identity of the requester and the effect shown come from verified data (manifests, broker-rendered effects), not from the requester.
3. **It is deliberate.** Clicks and keys that started before the prompt existed cannot approve it.

## Elements

| Element | What it is | Why it cannot be spoofed |
|---|---|---|
| **Keystrip** | A 28 px bar on top of every output: integrity status, focused principal, capture indicators, pending approvals, agent activity, clock | Client surfaces are laid out below it, including fullscreen ones; no protocol lets a client draw there |
| **Secure attention key** (`Ctrl+Alt+Delete`, tablet power button) | Opens the secure overview: lock, switch user, approvals, security centre, agents, kill focused app | Never delivered to clients; cannot be inhibited; virtual input devices are ignored |
| **Identity frames** | Server-side frame on every app window: tier colour, verified display name, label badge, session chip | Drawn by atrium from the verified manifest; the client title appears only as secondary text |
| **Prompts** | Approval and presence cards | Rendered in-process, dim everything else, extend the keystrip with a badge, show the personal security phrase and image |
| **Greeter and lock** | Login and unlock | In-process; authenticate only through hearth; restart always lands here |

### Tier colours

| Colour | Meaning |
|---|---|
| Slate | Native app (t1) |
| Blue | App in a microVM (t2) |
| Amber | Legacy app (FHS view / Xwayland) |
| Violet | Workbench console (t3: development environments, agent sessions) |
| Green | Trusted UI; only atrium can use it |

## Anatomy of an approval

```
┌──────────────────────────── keystrip ─────────────── ⚠ Approval requested by "Coding agent" ──┐
│ [security image] "blue heron at dawn"                                     T3 · irreversible     │
│ Send email                                                                                      │
│ Requested by: Coding agent (io.example.agent 1.4.0 · publisher Example Labs · t3 · …K1C)        │
│ ┌ Effect: email.send ─────────────────────────────────────────────────────────────────────────┐ │
│ │ To: ops@example.com   Subject: Weekly report     (rendered body…)                           │ │
│ └─────────────────────────────────────────────────────────────────────────────────────────────┘ │
│ Where the arguments came from                                                                   │
│   recipient  ← web:https://example.com/contact     untrusted   ⚠ came from untrusted content    │
│   body       ← file:~/reports/week41.md            private                                      │
│ Scope: (•) once ( ) this session                                [ Deny ]  [ Approve + touch key ]│
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Effects are rendered by the requesting service**, not by the agent or app. The broker and gate build `RenderedEffect` cards from the staged intent payload. atrium only displays them, decoding images, markdown and diffs in a confined helper.
- **Argument provenance** shows where each value came from, and highlights untrusted sources. This is the human's main defence against prompt injection: "the recipient came from a web page" is visible at the moment of decision.
- **The mandate** is the signed record of the decision:
  - For presence prompts, hearth signs the broker's mandate draft with the owner's FIDO2 key: a WebAuthn-style assertion over the SHA-256 of the DSSE PAE encoding, rpId `keylos.owner`, `alg` `fido2-es256` or `fido2-eddsa` ([Signed documents](../04-contracts/signed-documents.md#presence-signatures)). atrium passes the envelope through unchanged.
  - Otherwise atrium signs with its per-boot approver key; phone and org approvals carry `channel` `phone` or `org` and never satisfy a presence requirement.
  - `gate` refuses to commit an irreversible effect unless the mandate's payload digest matches the staged intent.

## Anti-spoofing measures

| Measure | Defends against |
|---|---|
| Keystrip is never covered; real prompts extend it | Fullscreen fake dialogs |
| Personal security phrase and image (from enrolment, held by hearth) | Pixel-perfect fakes |
| SAK: real prompts survive it, fakes do not | Any doubt about a prompt |
| Dimming plus input blocking of all clients while a prompt is shown | Overlay and focus-stealing tricks |
| 750 ms enable delay, fresh input required, Deny focused by default | Clickjacking and key-repeat approvals |
| Trusted surfaces excluded from screen capture | An app recording, or relaying to a remote attacker, the prompt and the security image |
| Prompts tied to the requesting user's session; denied on lock, user switch or SAK "deny all" | Approvals happening while the user is away |
| Per-principal prompt rate limit | Prompt fatigue attacks |

## Trusted terminal

`atrium-term` is the terminal emulator that hosts kish. It is part of the trusted path for typed commands:

- Shells are spawned only through `TrustedSpawn.spawnTerminal` on warden's `trusted-terminal` facet, which only atrium-term holds. Only that process tree runs without `SECBIT_EXEC_DENY_INTERACTIVE`. Everything else in the system that tries to feed an interpreter commands (`curl … | sh`-style) is refused by the kernel-enforced securebit and the interpreter's checks.
- Dangerous escape sequences are filtered: OSC 52 clipboard writes, file-transfer sequences, report sequences that echo data back as input.
- Pasting content that is untrusted, or contains control characters or newlines, shows a preview first.

## New uses of the trusted path

| Use | What the human sees | Interface |
|---|---|---|
| USB and Thunderbolt authorization | Device classes, port, descriptor strings marked as untrusted; keyboard-like devices must be confirmed with an already-authorized input device | `devd#authorize` (`DeviceAdmin.authorize`) |
| Assisted presence | PIN entry and a pointer, keyboard or switch-access confirm inside the atrium-drawn prompt, for owners who can't use a roaming key | hearth platform authenticator (`assisted: true`) |
| Presence with a rendering | The plan diff or rendered effect the presence signature covers, not only the statement | `TrustedPrompt.presence(…, rendering)` |
| Phone and family channels | Which channels may decide (`ApprovalPrompt.channels`) and, on family machines, the requesting human (`requester`) | `TrustedPrompt.approve` |
| Debug grants | Target, scope, debugger and duration | `Broker.debug` → T3 with presence |
| Agent desktop take-over | A mirror window framed as the agent; "Take over" switches it to interactive | `Vm.takeOver` |

## Relationship to approval tiers

| Tier | Trusted-path interaction |
|---|---|
| T0 | None; receipt only |
| T1 | None; a classifier may escalate |
| T2 | Batched review in the approvals centre (trusted UI) |
| T3 | Synchronous prompt as above; presence (FIDO2 touch, or a quorum on headless profiles) for config apply, seal, policy change, payment, persistent grants, debug grants and policy-marked effects |

See [Approval tiers](../07-agents/approvals.md) and [ADR-0028](../11-decisions/adr-0028-approval-tiers.md).

## Limitations

- A human who ignores the provenance warning and approves anyway is not protected. The trusted path makes the decision informed, not automatic.
- The security image protects against fakes, not against a compromised atrium or kernel. Those are covered by sealed code and [reboot heals](../05-integrity/reboot-heals.md).
- Assistive technology (screen readers) can read prompts. That is required for accessibility, and gated by a T3, persistent grant.
- On machines without a physical keyboard, the SAK falls back to the power button; devices with neither cannot offer a SAK.

## Related

- [Desktop](../09-experience/desktop.md)
- [Labels and the Rule of Two](labels-and-rule-of-two.md)
- [Approvals](../07-agents/approvals.md)
- [atrium spec](../../specs/atrium/spec.md)
- [ADR-0034 Wayland only, trusted path](../11-decisions/adr-0034-wayland-only-trusted-path.md)
