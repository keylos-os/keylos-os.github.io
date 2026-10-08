# Runbook: revoked generation

> keylos can withdraw trust in a specific app, tool or store object after release, for example because of an exploited vulnerability or a malicious update. Revocations come in signed lists through TUF and are logged in the release log. This runbook covers what you see and what to do.
> Status: **specified (v1.0)**. Normative specs: [depot](../../../specs/depot/spec.md), [protocols §11.7](../../../specs/protocols/spec.md).

## Symptoms

| Message | Revocation action | Meaning |
|---|---|---|
| "This app version was withdrawn (unlaunchable)" when starting an app | `unlaunchable` | The generation must not run. A fixed version is usually available |
| A running app was frozen or closed with a revocation notice | `unlaunchable` + grant record `onRevoke` | Running instances are frozen (apps) or killed (agents) |
| "Security warning" badge on an app | `warn` | Runs, but is affected by a known issue |
| Store objects disappear at garbage collection | `evict` | Withdrawn content (for example a malicious file) is removed from the store |
| Publisher key revoked | `keys` entry | Every generation signed only by that key becomes unlaunchable after the stated time |

## Immediate actions

1. Read the notice. It links the advisory: `ledger query --event gen.revoke` shows the reason and the revocation serial.
2. Update the app: Software → Updates, or `depot install tuf:stable/<name>`. A fixed version clears the block.
3. For a frozen app, choose **Close** unless the advisory says the issue is harmless for your use. Unfrozen work may be saved through the powerbox only.

## Diagnosis

```
depot get <gen>                     shows revoked=true and the reason
depot revocations                   current revocation list (serial, issued)
ledger query --event gen.revoke,gen.install --since 30d
why <file>                          for a file you suspect came from a withdrawn generation
```

If an `evict` revocation concerns something you used, check `why` on its outputs, and review receipts for its sessions.

## Recovery

- **Fixed version exists:** install it. Grants carry over if the capability diff is empty. Otherwise you are asked to consent to the differences.
- **No fixed version yet:**
  - Use an alternative app, or wait.
  - Overriding `unlaunchable` is **not** possible for project-stream revocations.
  - For an owner-sealed tool, rebuild from fixed sources and seal again.
- **Publisher key revoked:** reinstall from the publisher's new key once they publish under it. The capability diff is shown as for any install.

## Verification

- The app launches without a warning.
- `depot list app <name>` shows the new generation as current and the old one unrooted.
- `depot gc --dry-run` shows evicted objects gone or pending.

## Prevention

- Keep automatic security updates on (default).
- Prefer reproducible apps. They are verified by the rebuilder quorum, and non-reproducible ones run in tier 2 by default.

## Related

- [Failed update](failed-update.md)
- [Suspected compromise](suspected-compromise.md)
- [depot spec](../../../specs/depot/spec.md)
- [keylos spec §4.8.5](../../../specs/keylos/spec.md)
