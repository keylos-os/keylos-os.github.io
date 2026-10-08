# Runbook: TPM unlock failure

> The machine asks for a FIDO2 key or the recovery key instead of accepting your PIN. This means the TPM refused to release the disk key. That is either a legitimate change, such as firmware updated or the TPM cleared, or exactly the protection working against tampering. Find out which before you unlock.
> Status: **specified (v1.0)**.

## Symptoms

- After entering the PIN: "The TPM did not release the disk key" with options FIDO2 unlock, recovery key, recovery environment.
- Or the PIN is refused with "too many attempts" (dictionary-attack lockout).

## Immediate actions

1. **Verify with vouch first** (if paired). Open vouch → Verify, type the challenge, scan the QR.
   - **Green**: the boot chain is genuine. The cause is on the policy side; continue below.
   - **Amber "firmware changed"** after an update you installed: expected. Continue below.
   - **Red**: stop. Do not type the PIN, recovery key or FIDO2 PIN. Follow [suspected compromise](suspected-compromise.md).
2. If you have no phone paired, check that the machine has been in your control. If unsure, treat it as suspected compromise.

## Diagnosis

| Cause | Typical sign |
|---|---|
| Firmware update not predicted by pcrlock | vouch amber "firmware changed"; recent fwupd activity |
| BIOS setting change (Secure Boot toggled, TPM settings, boot order with option ROMs) | vouch shows PCR 7 or PCR 1 changed |
| TPM cleared (firmware "Clear TPM", motherboard swap) | vouch red "TPM identity changed"; the AK is gone |
| Booted an older UKI below the OS floor | Boot menu shows an old entry selected; vouch green but the floor refuses |
| PIN lockout | "too many attempts"; wait 10 minutes per attempt, or use the recovery key |
| Disk swapped (partition-swap attack) | The initrd stops with "volume identity mismatch" even after unlock; treat as compromise |

## Recovery

**Firmware or BIOS change (genuine boot):**
1. Unlock with a FIDO2 key (if the FIDO2 slots are enrolled) or the recovery key.
2. Once booted, run `keylos-enrol tpm` and touch a FIDO2 key. pcrlock records the new firmware state and reseals the disk token.
3. In vouch, accept the new firmware baseline when prompted.

**TPM cleared:**
1. Boot the recovery environment → **Re-enrol TPM**. Enter the recovery key and touch a FIDO2 key.
2. NV counters are recreated and initialised from the last witnessed ledger checkpoint, so they never go backwards.
3. Re-pair vouch (the AK changed).

**Old UKI selected:** pick the newest entry in the boot menu. Older entries are kept only for rollback within the same floor.

**PIN lockout:** wait for the lockout to decay, or use the recovery key. The lockout itself is the TPM protecting you from guessing.

## Verification

- The next boot unlocks with the PIN alone.
- vouch shows green.
- `ledger query --event key.enroll --since 1d` shows the TPM re-enrolment receipt (marked `recovery: true` if done from recovery).

## Prevention

- Install firmware updates through keylos (`courier` + fwupd). keylos announces them to vouch and pre-computes PCR predictions when vendors publish measurement data.
- Don't change Secure Boot or TPM settings in firmware unless a runbook asks you to.
- Enrol the FIDO2 disk slots (default on laptops), so you rarely need the recovery key.

## Related

- [Recovery](../recovery.md)
- [Attestation and vouch](../../05-integrity/attestation-and-vouch.md)
- [Boot chain](../../05-integrity/boot-chain.md)
- [boot spec](../../../specs/boot/spec.md)
