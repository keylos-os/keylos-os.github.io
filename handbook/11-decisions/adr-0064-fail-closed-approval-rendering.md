# ADR-0064: Approvals fail closed when required details can't be shown

> Each effect kind defines the details a human must see. A prompt can be approved only when every required rendering was presented completely, on every channel. A title or a hash never substitutes for them.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Agents / trusted path | atrium, gate, broker, vouch, hearth, fleet, protocols |

## Context

- atrium allowed Approve after an `atrium-decode` crash or timeout as long as the effect title was non-empty. A title does not establish the content, destination, amount or authority being approved (ISSUES.md ISS-006).
- vouch truncates attachments for phone delivery; a truncation notice must not count as review.
- Nothing in `RenderedEffect` distinguished essential from decorative material, so a requester could imply that details were optional.

## Decision

- `RenderedEffect.review` is `required` (the default) or `decorative`, and `payloadDigest` binds each rendering to the mandate-draft effect it presents (protocols §7.3.4, E33). Only gate and broker may mark a rendering decorative.
- protocols §14.2 lists the required review details per effect kind (recipients, subject, body and attachments for email; method, URL and body for HTTP; amount, currency and payee for payments; full manifest and diff for merges; remote, refs and commits for pushes; the plan diff for config apply; device and action for actuation).
- Approve is enabled only when every required rendering was presented completely. After a renderer failure, gate's canonical-text fallback is used if it presents all required details within limits; otherwise only Deny and Defer remain.
- The same rule applies to local prompts, owner-presence cards, the phone, org approvers and quorum review. A channel that can't present the material leaves the request pending for a capable channel, or it expires and is denied.

## Alternatives considered

| Option | Why not |
|---|---|
| Allow approval with a warning | The human approves what they did not see |
| Require the full rich rendering always | A decoder crash would block every approval; canonical text is enough when complete |
| Let the requester mark optional parts | An untrusted requester would decide what the human sees |

## Consequences

### Positive
- No approved mandate can come from a prompt that hid essential details.
- One rule across all channels.

### Negative
- Some phone approvals stay pending until the owner is at a capable device.

### Follow-ups
- Tests: decoder crashes and timeouts, unsupported MIME types, missing attachments, malformed or truncated details, valid text fallback, cross-channel consistency.

## Related

- [Approvals](../07-agents/approvals.md)
- [ADR-0028: Approval tiers](adr-0028-approval-tiers.md)
- [ADR-0034: Wayland-only with a trusted path](adr-0034-wayland-only-trusted-path.md)
- [protocols §7.3.4](../../specs/protocols/spec.md#73-interfaces)
