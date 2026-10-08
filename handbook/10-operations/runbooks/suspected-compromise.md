# Runbook: suspected compromise

> vouch shows red, a witness reports a checkpoint conflict, the initrd reports a volume identity mismatch, or you find receipts you can't explain. keylos's design means most compromises either can't persist past a reboot or leave evidence. This runbook preserves that evidence and gets you back to a verified state.
> Status: **specified (v1.0)**.

## Symptoms and severity

| Signal | Severity | Most likely meaning |
|---|---|---|
| vouch **red** before unlock | High | Boot chain is not what it should be: tampering, an unknown UKI, firmware modified, or a different TPM |
| Initrd "volume identity mismatch" | High | Disk swapped or tampered (partition-swap attack) |
| Witness conflict (phone or fleet) | High | Ledger rolled back or forked: disk restored from an old image, or split view |
| Unexplained `presence.assert`, `config.apply` or `gen.seal` receipts | High | Someone used a FIDO2 key, or a bug |
| Unexplained effects (`effect.commit`) | Medium–High | An agent or app acted beyond what you expected |
| `kl-exec` denial bursts in the journal (`warden exec-denials`) | Medium | Something tried to run unsealed code; the denial is the protection working |

## Immediate actions

1. **Before unlock (red verdict or identity mismatch): do not enter the PIN, the recovery key, or any FIDO2 PIN.** Power off. Keep the machine as it is.
2. **While running (receipts or witness conflict):**
   - Don't reboot yet if you want to capture runtime state.
   - Disconnect the network (`net` → airplane mode) to stop further effects.
3. Export evidence from vouch: Alerts → Share evidence. This includes conflicting signed checkpoints and the quote details.
4. From a trusted device, remove any FIDO2 key you suspect: [lost FIDO2 key](lost-fido2-key.md). Rotate secrets the machine held if the receipts suggest exfiltration.

## Diagnosis

**Boot-chain red.** Request detail in vouch (animated QR). It names the changed component:

| vouch detail | Interpretation |
|---|---|
| "Kernel/UKI not a keylos release" | Someone placed a different UKI; with owner Secure Boot keys this requires your KEK or a firmware attack |
| "Secure Boot variables changed" | `db`/`KEK`/`PK` modified: firmware attack, or someone with physical access in setup mode |
| "Boot loader changed" | systemd-boot replaced |
| "Option ROM changed" | New or modified PCIe device firmware |
| "TPM identity changed" | Different TPM: motherboard swap or a software TPM |

**Witness conflict.** Compare the two signed checkpoints. A smaller tree means rollback (restored disk image). The same size with a different root means a fork. Neither can happen in normal operation.

**Receipts.**

```
ledger query --since <t> --event presence.assert,config.apply,gen.seal,key.enroll,effect.commit
ledger prove <seq> <treeSize>         inclusion proof against a witnessed checkpoint
why <file>                            provenance of an unexpected file
```

Receipts are signed by the writing service and countersigned by the ledger. A witnessed checkpoint fixes them in history.

## Recovery

**Boot chain compromised, data intact:**
1. Boot the **installer media**, verified against the release log from another device, into recovery mode.
2. Check firmware Secure Boot variables against your enrolment (`rescue inspect`).
3. Re-enrol Secure Boot owner keys if they changed.
4. Reinstall keeping home ([Recovery](../recovery.md)). The store and OS are rebuilt from verified sources, and home data stays labelled as it was.
5. Rotate the recovery key afterwards.

**Ledger rollback or fork:** the disk was restored from an older image or edited offline.
1. Treat everything since the rollback point as unknown.
2. Recover from a verified backup.
3. Re-pair witnesses.

**Unexplained presence use:**
1. Remove the key, then enrol a new one.
2. Revert config generations created by it (`config revert`).
3. Un-seal suspicious tools (`depot unroot` + `depot gc`).

**Runtime compromise suspected (`kl-exec` denials, odd effects, no boot-chain change):**
1. Reboot. Reboot restores verified code and owner-approved configuration; only kernel or firmware persistence survives it as code.
2. Verify with vouch.
3. Review receipts for what happened before the reboot.
4. If the symptoms return after the reboot, suspect hostile data in writable state: reboot into **safe start** from the boot menu, which suppresses session restore and keeps app data quarantined read-only, then release or restore each app's data unit from a snapshot ([Reboot heals](../../05-integrity/reboot-heals.md#safe-start-and-quarantine)).

## Verification

- vouch green on two consecutive boots.
- Witness cosigns new checkpoints without conflict.
- `kish status`: `full`, expected OS and config generations, no unknown sealed generations (`depot list --sealed`).
- `keylos-conformance run --suite reboot-heals` (from the installer media's tool set) passes, if you want certainty.

## Prevention

- Use verify-before-unlock on every boot where the machine was out of your sight.
- Keep a second witness (fleet, or a second phone).
- Keep FIDO2 keys and the recovery key physically separate from the machine.

## Related

- [Attestation and vouch](../../05-integrity/attestation-and-vouch.md)
- [Reboot heals](../../05-integrity/reboot-heals.md)
- [Recovery](../recovery.md)
- [keylos security analysis](../../../specs/keylos/spec.md)
