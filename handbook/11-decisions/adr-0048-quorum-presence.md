# ADR-0048: Quorum presence for headless and managed machines

> On machines nobody can touch (the `server`, `server-k8s`, `cloud` and `appliance` profiles, and managed machines), owner presence is an N-of-M quorum of signatures from distinct owners. Each owner signs remotely with their own FIDO2 credential, using the same WebAuthn-over-PAE construction as a local touch. The reduced guarantee is shown in status.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Identity | hearth, fleet, config, boot, installer, vouch, broker, protocols |

## Context

- Presence on desktops is a FIDO2 touch at the machine ([ADR-0011](adr-0011-owner-presence-fido2.md)). It signs config generations, seals, policy changes and other T3 decisions.
- Servers and cloud VMs have no human at the keyboard. Serial consoles and remote KVM pass keystrokes, not a security key. Without an answer, headless machines would need a weaker path, such as an admin password or a long-lived API key, which would become the system's weakest point.
- Distributed approval by several administrators already counters single-admin compromise in high-value operations (code signing, cloud root accounts). A quorum signature gives the same property cryptographically.
- The seal gate ([ADR-0012](adr-0012-sealing-windows.md)) depends on FIDO2 `hmac-secret` output, which only a locally present credential can produce.

## Decision

- **Owner registry policy.** `policy.mode = "quorum"` and `policy.threshold = N`, with M enrolled approver credentials ([protocols §5.4](../../specs/protocols/spec.md#54-quorum-presence), [§20.3](../../specs/protocols/spec.md#203-owner-registry)).
- **Quorum envelope.** A DSSE envelope over the payload with at least N §5.3 signatures from credentials of **distinct owners**. Verifiers count owners, not signatures.
- **Collection.**
  - `hearth` creates a `keylos.quorum/1` request, signed by the machine key, which expires within 24 h.
  - Approvers receive it through `fleet`, or as a file, and review the rendering on their own keylos machine.
  - They sign with `hearth presence --remote`.
  - Signatures return through `HearthQuorum.submit`.
- **Scope.**
  - On quorum machines, every presence purpose accepts a quorum envelope; wherever presence is required, a quorum is required instead.
  - On desktops, quorum envelopes count only for owner-registry changes marked `quorum`.
- **Seal gate.** The next gate authValue is held in a TPM-sealed blob (PCR11 `ready` ∧ PCR15). `hearth` releases it only after verifying a quorum envelope of purpose `seal.window`. `status` shows `sealing: quorum`.
- **Wipe.** A remote wipe command only locks the machine. The wipe completes at the next recovery entry after the recovery environment verifies a quorum of the machine's owners.

## Alternatives considered

| Option | Why not |
|---|---|
| Admin password over SSH | Phishable and reusable; one stolen credential controls the machine |
| Single remote FIDO2 signature | Removes the second-person check that a physical touch partly provides; one compromised workstation suffices |
| Fleet server signs on owners' behalf | Moves owner authority to a central service; fleet compromise becomes owner compromise |
| Disable presence-class actions on servers | Servers still need config changes, seals and recovery |

## Consequences

### Positive
- Headless machines keep "a person decided" semantics, strengthened to "N people decided".
- The verification code path is the same everywhere (`keylos-presence`), so there's no separate admin channel.
- Approvers review a rendering produced by their own machine's trusted path, not by the server.

### Negative
- For sealing, the guarantee drops from "a physical touch" to "N approvers signed and the machine runs a verified hearth". It is shown, not hidden.
- Operational latency: changes wait for N approvers, at most 24 h per request.
- Losing too many approver credentials locks owners out of presence actions until recovery with the recovery key.

## Related

- [Servers and cloud](../10-operations/servers-and-cloud.md)
- [Key ceremonies](../10-operations/key-ceremonies.md)
- [Users and homes](../08-state/users-and-homes.md)
- [ADR-0011: Owner presence via FIDO2](adr-0011-owner-presence-fido2.md)
- [ADR-0012: Sealing windows](adr-0012-sealing-windows.md)
