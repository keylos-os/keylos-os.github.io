# ADR-0067: Reboot restores code and configuration; hostile data needs safe start

> "Reboot heals" is a claim about code and owner-approved configuration, not about writable state. A safe-start boot option suppresses session restore and quarantines app data so the owner can recover from data that keeps re-triggering a compromise.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Integrity / recovery | docs, atrium, strata, boot, protocols |

## Context

- The handbook said malware without a kernel or firmware exploit cannot survive a reboot, while the same page listed poisoned data that triggers a parser bug on every boot (ISSUES.md ISS-008).
- Restoring code integrity does not make resuming a workload over hostile state safe: session restore and automatic reopening parse that state again.

## Decision

- The claim is stated precisely (protocols §9, E35): "Reboot restores verified code and owner-approved configuration. Writable state may still contain hostile data and may require quarantine or recovery."
- The boot menu offers **safe start**: the normal verified boot, but atrium does not restore the session or reopen documents, and apps start with their data units quarantined (snapshotted and mounted read-only) until the owner releases, restores or exports them.
- Quarantine never deletes data.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep the broad claim | Overstates the guarantee |
| Wipe app state on suspicion | Loses useful data |
| Re-verify all data at boot | Data has no signature to verify against |

## Consequences

### Positive
- The integrity claim matches what the mechanisms guarantee.
- A recurring data-borne compromise has a recovery path that keeps the owner's data.

### Negative
- Product descriptions carry a longer claim.

### Follow-ups
- Acceptance that demonstrates the difference: code and configuration restored after a compromise, and a hostile-data re-trigger contained by safe start.

## Related

- [Reboot heals](../05-integrity/reboot-heals.md)
- [ADR-0008: The host executes only sealed code](adr-0008-host-executes-only-sealed-code.md)
- [Recovery](../10-operations/recovery.md)
