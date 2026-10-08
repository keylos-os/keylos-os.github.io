# ADR-0014: TPM2+PIN with signed PCR policy, prediction, NV floor and PCR15

> The disk key is sealed in the TPM. To unseal it, all of these must hold: a PIN; PCR11 matching a policy signed by the release-stream key; PCR0–7 matching pcrlock-compatible predictions; a TPM NV version counter at or above the floor. Before leaving the initrd, the unlocked volume's identity is verified and measured into PCR15. A recovery key is always enrolled.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Boot | boot, courier, installer, vault, hearth |

## Context

- Sealing to literal PCR values breaks on every update. systemd's signed PCR11 policies (`systemd-measure`, PolicyAuthorize) fix the UKI part. pcrlock predicts firmware PCRs, but is still marked experimental (https://man.archlinux.org/man/systemd-pcrlock.8.en).
- Known attacks on TPM-only unlock:
  - partition swap / filesystem confusion releases the key to attacker code (https://forge.fedoraproject.org/security/tickets/issues/7, CVE-2026-32606);
  - bus sniffing on discrete TPMs (https://blog.scrt.ch/2024/10/28/privilege-escalation-through-tpm-sniffing-when-bitlocker-pin-is-enabled/);
  - downgrades to old signed components (bitpixie).
- "Anything signed by key X unlocks" also accepts old, vulnerable signed UKIs.

## Decision

- Unseal policy = PIN ∧ PolicyAuthorize(PCR11, release-stream key) ∧ PolicyAuthorizeNV(PCR0–7 predictions in NV `0x01300103`) ∧ release `seq` ≥ the os-floor in NV `0x01300102`.
- **All keylos NV indices live in the owner-hierarchy NV block `0x01300100–0x013001FF`**, and persistent handles in the TCG ranges for their hierarchy (`0x8100xxxx` owner, `0x8101xxxx` endorsement). The single registry is [protocols §19.6](../../specs/protocols/spec.md#196-tpm-objects) ([ADR-0045](adr-0045-owner-nv-range-and-tpm-registry.md)).
- The os-floor is an ordinary 8-byte index holding the minimum bootable release `seq`, written only under `PolicyAuthorize` by the release-stream key. The pcrlock-policy index is written under `PolicyOR{PolicyAuthorize(release-stream key), PolicySecret(recovery auth object 0x81000105)}`, so recovery can repair it after an unannounced firmware change.
- courier predicts PCR0–7 (old and new) before each reboot and raises the NV floor only after the new generation boots healthily. If a PCR can't be predicted, it is dropped from the policy, never guessed.
- The initrd measures the LUKS volume-key identity into PCR15 before leaving. Later secrets (vault master, home keys) include PCR15 in their policies.
- Salted sessions bound to an SRK pinned at enrolment. Dictionary-attack lockout through the PIN.
- A recovery key is always enrolled and printed. It also stores the TPM lockout auth.

## Alternatives considered

| Option | Why not |
|---|---|
| TPM-only unlock | Bus sniffing, confusion attacks, no user factor |
| Literal PCR binding | Breaks on every update; users disable it |
| Passphrase only | No platform-state binding; weak against evil maid |
| FIDO2-only disk unlock | Good, offered as an alternative factor; doesn't bind platform state |

## Consequences

### Positive
- Updates don't break unlock, and old signed images are refused once the floor is raised.
- Volume swap attacks fail.

### Negative
- A PIN at every boot.
- Firmware with odd event logs reduces policy strength (fewer PCRs).
- TPM NV wear: the floor is written only when a release is assessed healthy, and counters are incremented at bounded rates (the ledger counter at most every 900 s plus security events).

## Related

- [Boot chain](../05-integrity/boot-chain.md)
- [Updates and rollback](../10-operations/updates-and-rollback.md)
- [ADR-0015: Verify before unlock](adr-0015-verify-before-unlock.md)
