# Effects and the outbox

> An effect is anything a principal does to the world outside its overlay: push, email, pay, publish, merge. keylos classifies every effect, stages it as an intent in gate's durable outbox, and executes it only when policy allows. Irreversible effects also need a mandate signed for the exact bytes.
> The outbox gives undo for what can be undone, and a receipt for everything else.

**Status:** specified (v1.0). Component: [gate](../../specs/gate/spec.md).

![Effect outbox](../images/effect-outbox.svg)

## Classes

| Class | Meaning | Default handling |
|---|---|---|
| Reversible | No lasting external change (GET to granted hosts, overlay writes) | Runs inside the session; receipt only |
| Compensable | Can be undone by a registered compensator (open PR → close PR; create branch → delete branch; merge → strata undo) | Auto-commit within policy; T2 batch review for agents |
| Irreversible | Cannot be undone (send email, pay, force-push, publish a package, change IAM, write a prod DB) | Never executed directly. Needs a **mandate**: T3, with presence where policy says so. |

The registered kinds include `fs.merge`, `git.push`, `git.pr.open`, `email.send`, `message.send`, `http.post/put/patch/delete`, `payment.authorize`, `publish.package`, `cloud.iam.change`, `db.write.prod`, `calendar.create`, `file.share` and `device.actuate`. Policy may add `x-…` kinds. A class can be raised, never lowered. A force-push or a push to a protected branch is raised from compensable to irreversible automatically.

## Two ways to stage

| Path | Who uses it | How |
|---|---|---|
| Explicit | Agents (host tool `keylos.effect.stage`), apps using the SDK | `Gate.stage(EffectIntent)` with kind, target, args with provenance, idempotency key, payload fd |
| Implicit | Unmodified tools (`git push`, `curl -X POST`) on intercepted hosts | gate turns an unsafe HTTP request into an intent when the principal may stage but not commit that kind. It answers `428 Precondition Required` with `Keylos-Intent: e-…`. |

Implicit staging lets ordinary tools take part in approval flows without modification. On commit, gate **replays** the stored request with credentials injected at that moment. Git's receive-pack old-object check makes a stale replay fail safely rather than overwrite.

## The outbox state machine

```
stage → Staged → (AwaitingApproval) → Approved → Committing → Committed → (Compensating → Compensated)
                     └─denied/expired→ Canceled          └─fail→ Failed
```

| Property | Guarantee |
|---|---|
| Durability | An intent acknowledged by `stage` survives crash and power loss (fsync) |
| Immutability | Payloads are stored content-addressed and encrypted with a per-session key. The digest is fixed at stage time. |
| Exactly-once | Idempotency keys per principal. HTTP replays carry `Idempotency-Key`. An intent interrupted in `Committing` is **not** re-run blindly; it becomes `Failed: outcome unknown`. |
| Crypto-shredding | Forgetting the session destroys its payload key |
| Receipts | One per transition: `effect.stage`, `effect.commit`, `effect.fail`, `effect.cancel`, `effect.compensate` |

## Mandates

A mandate is the signed record of a human decision (`keylos.mandate/1`, a DSSE envelope). gate commits an irreversible intent only if a mandate:

1. is signed by an owner-presence key (FIDO2), or, when presence isn't required, by atrium's approver key or a phone or org approver key on a channel the policy allows;
2. names this principal, or an ancestor session with session or persistent scope;
3. contains an effect entry whose **kind, target and payload sha256** match the intent exactly;
4. is unexpired, with constraints (such as the maximum payment amount) satisfied;
5. for `scope: once`, has not been used before.

Because the digest covers the whole payload, nothing can change between what you saw and what is sent. That rules out a swapped recipient, an edited body, or a different amount.

## What you see

Each kind has a renderer that produces the effect, not the command:

| Kind | Rendered as |
|---|---|
| `git.push` | Ref updates old → new, commit list with subjects and authors, force and protected flags |
| `git.pr.open` | Title, base ← head, body |
| `email.send` | From, To, Cc, Bcc, Subject, the first 4 KiB of the body, attachments with sizes and digests |
| `http.*` | Method, URL, headers (credentials redacted), pretty JSON body or size and digest |
| `payment.authorize` | Merchant, amount, currency, cart items, recurring flag |
| `fs.merge` | File list with change kinds, plus a unified diff attachment |

Each argument also shows its **provenance**: "recipient came from user input", "body came from web page X". That is where injection shows up.

## Compensation

`gate intents compensate <e-id>` (or `aide undo` for merges) runs the registered compensator once. Built-in compensators:

| Effect | Compensator |
|---|---|
| New branch pushed | Delete the branch |
| PR opened | Close the PR |
| Calendar event created | Delete the event |
| File shared | Revoke the share |
| Overlay merged | strata undo snapshot |

Compensation is itself an effect, with a receipt.

## For app developers

Apps that want effects to be reviewable:
1. declare them in their manifest (`effects: [{"kind": "email.send", "class": "irreversible"}]`);
2. stage through `keylos-gate-client`.

The capability diff at install time shows which effect kinds an app can stage.

## Limitations

- Implicit staging confuses non-agent clients that do not understand `428`. Apps in tier 1 usually get commit rights per policy instead.
- Executors that are not idempotent (some SMTP providers) can leave the outcome unknown after a crash mid-commit. The intent says so, rather than guessing.
- SMTP traffic is never intercepted. Email effects are staged explicitly, or through a provider HTTP API rule.

## Related

- [Approvals](approvals.md)
- [Network egress](../06-security/network-egress.md)
- [gate specification](../../specs/gate/spec.md)
- [ADR-0027 Effect outbox and mandates](../11-decisions/adr-0027-effect-outbox-and-mandates.md)
- [ADR-0031 Receipts ledger](../11-decisions/adr-0031-receipts-ledger.md)
