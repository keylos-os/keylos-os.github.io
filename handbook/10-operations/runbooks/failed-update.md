# Runbook: failed update

> An update did not boot, rolled itself back, or booted but broke something you rely on. keylos updates are whole-generation switches with boot counting, so the previous state is always one step away.
> Status: **specified (v1.0)**. Normative spec: [courier](../../../specs/courier/spec.md).

## Symptoms

| Symptom | Likely state |
|---|---|
| Machine booted the old version after an update; status says "rolled back" | Boot counting exhausted (3 attempts) or a health check failed; the OS floor was **not** raised |
| New version boots, but an app or device misbehaves | Functional regression; boot health checks passed |
| Update stuck at "staging" | Download, verification, quorum or PCR prediction problem |

## Immediate actions

- Rolled back automatically: nothing urgent. You are on the previous, known-good generation.
- Regression after boot: roll back if the problem blocks you (below). The update is kept staged for later.
- Don't delete generations or clear the ESP by hand.

## Diagnosis

```
courier status                         staged generation, boot counter, last failure reason
ledger query --event update.stage,update.commit,update.rollback --since 7d
journal query 'principal=service:warden* level<=3' --boot -1   errors from the failed boot
```

| `courier status` reason | Meaning |
|---|---|
| `health:<service>` | A tier-0 service failed its health check on the new generation |
| `boot-counter-exhausted` | The new UKI did not reach the "ready" phase three times |
| `quorum` | Realisations for the update don't meet the stream's rebuilder quorum; it won't be staged |
| `log-inclusion` | Release statement not provably in the release log with 2 witness cosignatures |
| `pcr-prediction` | pcrlock couldn't predict firmware PCRs for the new boot; staging stops to avoid a TPM unseal failure |

## Recovery

**Roll back the OS:**

```
courier rollback          # previous generation becomes the default; one reboot
```

The OS floor is raised only after a new generation is confirmed healthy, so rolling back never conflicts with the TPM policy. One exception: a security release that deliberately raised the floor. Then the older UKI cannot unseal, and recovery offers the recovery key path. Avoid rolling back across a floor raise.

**Roll back config** (if the problem came from a config change made with the update):

```
config history
config revert <gen>       # needs a touch
```

**Stuck staging:**
- `quorum` / `log-inclusion`: wait, because rebuilders or witnesses are behind. Never override.
- `pcr-prediction`: firmware event log contains unrecognised entries. Run `courier stage --refresh-pcrlock`. If the firmware changed, accept the new baseline in vouch after the next boot.

## Verification

- `kish status` shows the expected OS generation and `full` integrity.
- vouch shows green on the next unlock.
- `courier status` shows no pending failure. The staged update stays pinned until a fixed release arrives.

## Prevention

- Stay on `stable`. `beta` releases soak for 7 days before reaching it.
- Keep at least two OS generations (`courier pin` the known-good one before a risky change).
- Report regressions with `courier status --json` and the failing journal excerpt.

## Related

- [Updates and rollback](../updates-and-rollback.md)
- [TPM unlock failure](tpm-unlock-failure.md)
- [courier spec](../../../specs/courier/spec.md)
