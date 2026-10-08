# Runbook: lost FIDO2 key

> One or both owner security keys are lost, broken or stolen. A stolen key alone is not enough to act as you: it still needs its own PIN or biometric. But it should be removed promptly, and a replacement enrolled.
> Status: **specified (v1.0)**.

## Symptoms

- A security key is missing or no longer responds.
- Presence prompts time out with "no authenticator".

## Immediate actions

| Situation | Do |
|---|---|
| One key lost, the other available | Remove the lost key today (below) |
| One key stolen | Remove it **now**; the thief also needs its FIDO2 PIN, but don't rely on that |
| Both keys lost | Go to "Both keys lost" below; you'll need the recovery key |

Do **not** reinstall to "fix" this. Your keys can be replaced without touching data.

## Recovery: one key remaining

1. Settings → Security keys, or `keylos-enrol fido2 remove "<label>"`. Touch the remaining key.
   - A new config generation is created without the lost key's presence public key.
   - The owner-seal key's policy is rebuilt without the lost key's authorisation object.
   - The lost key's FIDO2 disk-unlock slot (if any) is removed.
2. Enrol a replacement: `keylos-enrol fido2 add "<new label>"`. Touch the remaining key, then the new key.
3. If vouch or fleet is paired, nothing else is needed. They verify mandates against the keys in the config generation.

## Recovery: both keys lost

1. Reboot into the recovery environment (hold `r` at boot).
2. Choose **Re-enrol FIDO2**. Enter the recovery key.
3. With no FIDO2 key available, a **24-hour delay** starts. The greeter on the normal system shows a cancel banner during that time, and vouch is notified.
4. After 24 hours, return to recovery, enter the recovery key again and enrol two new keys.
5. A new config generation is signed by the new keys. Its counter continues from the TPM, so the old keys' generations can never be replayed.

## Diagnosis

- `ledger query --event key.enroll,key.remove,presence.assert --since 30d` shows every presence use.
- Check for presence assertions you didn't make. If there are any, follow [suspected compromise](suspected-compromise.md).

## Verification

- `keylos-enrol status` lists exactly the keys you hold.
- A test config change (for example toggling a harmless setting) succeeds with each key.
- `kish status` no longer shows "single key".

## Prevention

- Keep the second key somewhere separate from the first.
- Set a FIDO2 PIN on every key. keylos requires user verification, so keys without a PIN are refused.

## Related

- [Recovery](../recovery.md)
- [Key ceremonies](../key-ceremonies.md)
- [installer spec §4.13](../../../specs/installer/spec.md)
- [hearth spec](../../../specs/hearth/spec.md)
