# ADR-0015: Verify before unlock

> Before the PIN prompt, the initrd shows a QR code carrying a TPM2 quote over PCR0–15 for a nonce from the owner's phone. The vouch app verifies the quote against release-log predictions and the enrolled firmware state, and shows green or red. Only then does the owner type the PIN.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Integrity | boot, vouch, tlog, installer, keylos |

## Context

- Secure Boot prevents unsigned code but doesn't tell *the human* the device is unmodified. An evil maid can replace the boot screen to phish the PIN.
- Measured boot only helps if someone checks the measurements before secrets are entered.
- TPM-TOTP (tpm2-totp, Heads) shows a code sealed to PCRs that the owner compares to their phone. That proves state, but isn't tied to published predictions.
- keylos publishes PCR predictions per release in the release log ([ADR-0016](adr-0016-rebuilder-quorum-and-transparency-logs.md)).

## Decision

- The initrd shows a request. vouch provides a nonce (QR, BLE or NFC). The initrd shows a QR code with the quote, signed by an AK certified by the EK. vouch verifies the EK chain, the nonce, and PCR values against: release-log predictions for the booted generation, the owner's enrolled firmware state, and the expected PCR15 after unlock (on the next quote).
- Fallback: a TOTP-style code sealed to PCRs, for machines or phones without a camera or radios.
- vouch shows the verdict with the generation version, and records it.

## Alternatives considered

| Option | Why not |
|---|---|
| Trust Secure Boot only | No human-visible evidence |
| TPM-TOTP only | Proves "same as at enrolment", not "matches published release" |
| Remote attestation server | Needs network in the initrd; privacy; an online dependency |

## Consequences

### Positive
- Defeats PIN phishing by a replaced boot screen and detects tampered boot chains.

### Negative
- The phone becomes part of the trust model. The EK CA chains of fTPM vendors are inconsistent.
- One more step at boot (optional per profile; on by default for desktops).

## Related

- [Attestation and vouch](../05-integrity/attestation-and-vouch.md)
- [vouch](../03-components/vouch.md)
- [ADR-0014: TPM+PIN and signed PCR policy](adr-0014-tpm-pin-signed-pcr-policy.md)
