# Receipts

> Every act of authority in keylos leaves a receipt: grants, approvals, effects, spawns, config changes, seals and transactions. A receipt is a signed record, chained to the one before it and committed to a per-machine Merkle log.
> Receipts answer "what happened, who did it, and who allowed it". They stay verifiable even after their private content is forgotten.

**Status:** specified (v1.0). Format: [protocols §13](../../specs/protocols/spec.md). Log: [ledger](../../specs/ledger/spec.md).

## Shape of a receipt

A receipt is a DSSE envelope carrying a canonical (JCS) JSON payload:

```json
{
  "schema": "keylos.receipt/1",
  "seq": 1042,
  "prev": "rcpt:sha256:…",
  "time": "2026-10-07T21:30:00.123456789Z",
  "writer": "service:broker:gen:fsv256:…@_system/s-…",
  "subject": "agent:gen:fsv256:…@alice/s-…",
  "event": "grant.issue",
  "data": {"rootId": "t-…", "rights": ["path:/home/alice/src/proj:read"], "expires": "…"},
  "label": {"conf": "private", "integ": "untrusted"},
  "approval": null
}
```

| Field | Set by | Meaning |
|---|---|---|
| `writer` | Writer; checked against capwire identity | The tier-0 service reporting the event |
| `subject` | Writer | The principal the event is about |
| `event` | Writer | Registered event name |
| `seq`, `prev` | Ledger | Position in the chain, link to the previous receipt |
| `time` | Writer (checked by the ledger) | When the event happened; never earlier than the previous receipt |
| `data` | Writer | Event-specific details |
| `label` | Writer | Subject's session label at the time |
| `approval` | Writer | Approval ID when a human decided |

**Two signatures.** The writer signs what it submitted (with `seq` 0 and `prev` null). The ledger signs the completed receipt. The stored envelope carries the writer's signature first and the ledger's second, told apart by key ID. A verifier reconstructs the submitted form by resetting those two fields and checks both signatures. For sealed receipts the encryption binds the unit and the submitted-form digest (`unit ‖ 0x00 ‖ submitted`); `seq` and `prev` are bound by the ledger signature and the hash chain.

**Ledger-originated receipts.** Receipts the ledger writes about itself (its own key registration, alarms, redactions) name the ledger as both writer and subject, are never sealed and carry only the ledger's signature. The first receipt of every ledger and of every ledger epoch registers the ledger's own key, so readers get the machine key through `Ledger.serviceKey("ledger")`.

**Time only moves forward.** Receipt `time` never decreases along `seq`, so month units, retention and `since`/`until` queries are contiguous ranges. Concurrent submissions are sorted by time within each group commit; a submission older than the head is refused with `kl:invalid … re-sign`, and the writer re-signs it with a fresh time and resubmits. A resubmission is a new receipt: the ledger does not deduplicate, so writers that need exactly-once evidence keep their own logical IDs ([ADR-0066](../11-decisions/adr-0066-s2-contract-fixes.md)).

## Who writes what

The event registry is [protocols §19.3](../../specs/protocols/spec.md#193-receipt-events) (table in [Registries](registries.md#receipt-events)). Every event name without a prefix must be registered there.

| Writer | Events |
|---|---|
| warden | `boot`, `shutdown`, `spawn`, `exit` |
| broker | `grant.issue`, `grant.attenuate`, `grant.delegate`, `grant.revoke`, `grant.deny`, `label.raise`, `approval.request`, `approval.decide` |
| gate | `effect.stage`, `effect.commit`, `effect.fail`, `effect.cancel`, `effect.compensate`, `net.connect` (sampled), `net.listen`, `budget.charge`, `budget.exhausted` |
| vault | `secret.open`, `secret.store`, `secret.delete` |
| depot | `gen.install`, `gen.seal`, `gen.revoke`, `gen.gc` |
| courier | `update.stage`, `update.commit`, `update.rollback` |
| config | `config.plan`, `config.apply`, `config.revert`, `config.activation-rollback` |
| strata | `txn.begin`, `txn.commit`, `txn.abort`, `txn.undo`, `snapshot.create`, `snapshot.delete`, `unit.create`, `unit.forget`, `backup.run`, `backup.restore-test`, `anchor.rollback-detected` |
| aide | `agent.start`, `agent.stop`, `agent.merge` |
| hearth | `user.login`, `user.lock`, `user.create`, `user.delete`, `key.enroll`, `key.remove`, `presence.assert`, `seal.window` |
| devd | `device.grant` |
| net | `net.change` |
| bench | `vm.start`, `vm.stop`, `vm.snapshot`, `vm.fork`, `vm.commit`, `vm.discard` |
| compat | `legacy.import`, `legacy.open` |
| journal | `journal.segment` |
| ledger | `ledger.key.register`, `ledger.redact`, `ledger.alarm`, `ledger.witness`, `ledger.export` |
| fleet | `fleet.enrol`, `fleet.unenrol`, `fleet.policy.apply`, `fleet.command`, `fleet.attest` |
| vouch | `vouch.pair`, `vouch.remove`, `vouch.witness.cosigned`, `vouch.witness.conflict` |

A repository may also write **extension events** named `x-<repo>.<event>` (for example `x-strata.replica.send`). They are listed in that repository's spec, written only by its own services, and carry no meaning for other components.

**Fail closed.** If the ledger cannot accept a receipt, the writer refuses the action. No grant, approval or effect happens without its receipt.

## The log

- **Merkle tree.** The ledger commits each receipt as a leaf of an RFC 6962 tree, stored as C2SP tlog-tiles.
- **Checkpoints.** At least every 60 s while active and at shutdown, the ledger signs a C2SP checkpoint note: tree size, root hash and a `counter <n>` line with the current TPM counter value.
- **Proofs.** Any receipt can be proven included in a checkpoint, and any two checkpoints proven consistent.
- **TPM binding.** The TPM NV counter `0x01300100` is incremented at most once per 900 s while active, at shutdown, and immediately after security-class events (`grant.revoke`, `config.apply`, `gen.seal`, `update.commit`, `key.enroll`, `key.remove`, `ledger.alarm`). A TPM counter can only count, so the checkpoint note carries its value next to the root hash. A ledger whose newest checkpoint counter is below the NV value has been rolled back, which is detected at the next start.
- **Witnesses.** These cosign checkpoints so a compromised running system cannot rewrite history without detection. Examples are your phone running `vouch` and a fleet witness.

## Privacy: verifiable but forgettable

A receipt can mention paths, hosts and other personal details. So:

- **Leaves** hold only metadata: seq, digest of the full receipt, time, writer, subject, event.
- **Bodies** (full receipts) are encrypted with a per-human, per-month key held by `vault`.
- **Forgetting** a human or a month destroys the key. The bodies become unreadable, the leaves and proofs still verify, and a `ledger.redact` receipt records the act.

The price is that the *fact* that an event of type X happened at time T stays visible. The *content* does not ([ADR-0032](../11-decisions/adr-0032-crypto-shredding.md)).

## Who can read receipts

Facet `reader` ([protocols §7.3.5](../../specs/protocols/spec.md#735-ledgercapnp)): a principal sees receipts whose subject or writer is itself or a descendant session; a human's `shell` sees every receipt about that human; agents see only their own session chain; tier-0 services see what their facet allows. Receipts of crypto-shredded units come back redacted (`keylos.receipt-redacted/1`).

## Using receipts

| Task | Command |
|---|---|
| What is happening now | `ledger tail -f` |
| Everything an agent session did, including sub-agents | `ledger why <session>` |
| Find all approvals today | `ledger query --event approval.* --since today` (results are paged: repeat the same filter with `fromSeq` = the returned `next`) |
| Verify the log against the TPM | `ledger verify` |
| Hand evidence to someone else | `ledger export --from … --to … --out case.klx`, then `ledger-verify case.klx` on any OS |

## Limitations

- An attacker with runtime root can append false receipts while in control. Without a witness, they can also fork history from that point until reboot.
- High-volume events (file opens through grants, sampled network connects) are summarized, not recorded one by one.

## Related

- [Capability tokens](tokens.md)
- [Cedar policy](cedar-policy.md)
- [Secrets](../06-security/secrets.md)
- [ADR-0031 Receipts ledger](../11-decisions/adr-0031-receipts-ledger.md)
- [ledger spec](../../specs/ledger/spec.md) · [protocols §13](../../specs/protocols/spec.md#13-receipts)
- [Registries](registries.md)
