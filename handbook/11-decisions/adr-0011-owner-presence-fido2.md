# ADR-0011: Owner presence via FIDO2

> Actions that must be the owner's own are signed by `owner-presence`, a FIDO2 credential that requires a physical touch, displayed through the trusted path. These actions are: applying a config generation, sealing code for the host, changing policy, T3 mandates for irreversible effects, enrolling keys, and payments. Malware with full userspace control can't produce these signatures.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Identity | hearth, atrium, config, broker, depot, forge, installer, vouch |

## Context

- Users accept almost everything: 93% of manual permission prompts are approved (https://anthropic.com/engineering/claude-code-auto-mode). Prompts alone don't create a meaningful decision.
- A password or PIN typed into a compromised session can be replayed. A FIDO2 assertion needs user presence on separate hardware, and the private key never leaves the authenticator.
- "Reboot heals" needs persistent changes (config, sealed code, policy) to require something malware can't do. A touch on an external authenticator is that thing.
- The authenticator shows nothing about what it signs. The trusted path (compositor-drawn, not spoofable) shows the purpose and the rendered payload.
- **A FIDO2 authenticator can't sign arbitrary bytes.** It signs `authenticatorData ‖ clientDataHash`. A presence signature therefore has to be built around a WebAuthn-style assertion, and verifiers need their own algorithm IDs for it.
- **A FIDO2 assertion can't satisfy a TPM `PolicySigned`.** The TPM would have to verify the assertion's signature over authenticator data, which it can't. The first draft of this ADR assumed it could; the owner-seal key needs a different gate.

## Decision

- **Presence signatures** ([protocols §5.3](../../specs/protocols/spec.md#53-presence-signatures)): `Hearth.presence(purpose, payload)` builds a DSSE payload whose `schema` matches the purpose ([protocols §20.2](../../specs/protocols/spec.md#202-presence-purposes)), computes `clientDataHash = SHA-256(DSSE-PAE(payloadType, payload))`, and asks the authenticator for an assertion with rpId `keylos.owner`, user presence, and user verification where the purpose requires it. The DSSE signature object carries `alg` `fido2-es256` (COSE −7) or `fido2-eddsa` (COSE −8) and a CBOR map of authenticator data, signature and credential ID.
- Verifiers (crate `keylos-presence`) check the rpId hash, the UP/UV flags, that the credential was enrolled in the **owner registry** (a presence-signed log anchored in TPM NV `0x01300105`) at the payload's time, and the signature. hearth also tracks `signCount`.
- Presence is REQUIRED for: config apply, seal (per sealing window), policy change, key enrolment and removal, payment effects, and any effect whose policy says `presence`.
- At least two FIDO2 credentials (primary and backup) are enrolled at install. A phone passkey (via vouch) may be one of them.
- **The owner-seal key is gated by a seal gate, not by `PolicySigned`.** Each owner *i* has a TPM-resident P-256 owner-seal key (`0x81000140+i`) whose only policy is `PolicySecret` on an NV seal gate (`0x01300140+i`). hearth rotates the gate's auth value every sealing window with the FIDO2 `hmac-secret` extension: one assertion with two salts yields the current auth and the next one; at window close hearth runs `TPM2_NV_ChangeAuth` to the next value and zeroizes both. No seal signature is possible without a fresh touch, and a captured auth value is useless after the window ([ADR-0012](adr-0012-sealing-windows.md)).
- Phone approvals (vouch) and org approvals (fleet) can satisfy some T2/T3 approvals when policy allows that channel, but **never** a presence requirement.

## Alternatives considered

| Option | Why not |
|---|---|
| Password/PIN confirmation | Replayable by malware in the session |
| TPM-only key with PIN | Malware can drive the TPM once the PIN has been observed |
| Separate admin account | Ambient root-like authority; social engineering |
| No presence (prompt only) | Approval fatigue; not malware-proof |
| Owner-seal key under `PolicySigned` by the FIDO2 credential | The TPM can't verify a WebAuthn assertion |
| Per-credential TPM objects combined with `PolicyOR` | More TPM objects per owner, and an auth value that doesn't rotate per window |

## Consequences

### Positive
- Persistent system changes need an act malware can't perform.
- One mental model: "touch means I own this decision".

### Negative
- Hardware requirement (security key or phone passkey). Seal gates need authenticators with the `hmac-secret` extension, which every current FIDO2 security key supports.
- Lost keys need recovery ceremonies ([Recovery](../10-operations/recovery.md)).
- Too many touches would recreate fatigue, so presence is reserved for T3 and persistent changes.

## Related

- [hearth](../03-components/hearth.md)
- [Trusted path](../06-security/trusted-path.md)
- [Key ceremonies](../10-operations/key-ceremonies.md)
- [ADR-0012: Sealing windows](adr-0012-sealing-windows.md)
