# Runbooks

> Step-by-step responses to the incidents a keylos owner or fleet administrator is most likely to meet. Each runbook says how to recognise the situation, what to do first, how to recover, and how to confirm you're done.
> Status: **specified (v1.0)**.

## Format

Every runbook has the same sections:

| Section | Contents |
|---|---|
| Symptoms | What you see |
| Immediate actions | What to do in the first minutes, and what **not** to do |
| Diagnosis | How to find the cause, usually from receipts and status |
| Recovery | The fix |
| Verification | How you know it worked |
| Prevention | What reduces the chance next time |

## Runbooks

| Runbook | When |
|---|---|
| [Lost FIDO2 key](lost-fido2-key.md) | One or both owner security keys are lost, broken or stolen |
| [Failed update](failed-update.md) | An update did not boot, rolled back, or broke something after booting |
| [TPM unlock failure](tpm-unlock-failure.md) | The machine asks for the recovery key or FIDO2 instead of accepting the PIN |
| [Revoked generation](revoked-generation.md) | An app or tool refuses to start with "revoked", or the OS warns about a revocation |
| [Agent runaway](agent-runaway.md) | An agent session is looping, spending, fanning out or asking for things it shouldn't |
| [Suspected compromise](suspected-compromise.md) | vouch shows red, the witness reports a conflict, or you see receipts you can't explain |

## General rules

1. **Don't type secrets into a machine you don't trust.** If vouch shows red, stop before the PIN.
2. **Receipts first.** `ledger query` and `why <file>` usually answer "what happened" faster than anything else.
3. **Prefer rollback over repair.** Every OS and config state is a generation. Switching back is safe and leaves a receipt.
4. **Recovery key last.** Most recoveries need only a FIDO2 key. Use the recovery key when a runbook says so.

## Related

- [Operations](../README.md)
- [Recovery](../recovery.md)
- [Attestation and vouch](../../05-integrity/attestation-and-vouch.md)
