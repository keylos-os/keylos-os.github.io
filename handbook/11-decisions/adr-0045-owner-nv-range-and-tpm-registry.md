# ADR-0045: Owner NV range and one TPM registry

> Every TPM object keylos uses is listed once, in protocols §19.6. NV indices live in the owner-hierarchy block `0x01300100–0x013001FF`; persistent handles use the TCG ranges for their hierarchy (`0x8100xxxx` owner, `0x8101xxxx` endorsement). Components read the constants from the `keylos-tpm-registry` crate.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Boot / integrity | boot, courier, installer, hearth, vault, ledger, strata, config, fleet, vouch, protocols |

## Context

- The draft placed NV indices at `0x01C1xxxx`. The TCG handle registry reserves the `0x01C0xxxx` block for platform and TCG-assigned uses; owner-defined indices belong in the owner range.
- Four spec writers independently assigned overlapping indices: `0x01C10102` meant the boot release floor in one spec, the strata anchor counter in another and the owner-registry head in a third. Persistent handles also collided (`0x81018xxx` vs `0x81C1xxxx`).
- A TPM collision isn't a build error. It shows up as a machine that can't unseal its disk, or a counter that silently belongs to someone else.

## Decision

- One registry, [protocols §19.6](../../specs/protocols/spec.md#196-tpm-objects), with every NV index, its type, size, write authorization and owning component, and every persistent handle with its hierarchy and policy. Summary in [Registries](../04-contracts/registries.md#tpm-objects).
- NV indices: `0x01300100` ledger counter, `0x01300101` config counter, `0x01300102` os-floor, `0x01300103` pcrlock policy, `0x01300104` keystore floor, `0x01300105` owner-registry head, `0x01300106` login-failure counter, `0x01300107` strata anchor counter, `0x01300108` attestation-key names, `0x01300110`/`0x01300111` vault epoch (two alternating indices since [ADR-0059](adr-0059-two-index-vault-epoch-rotation.md)), `0x01300140 + i` seal gate per owner.
- Persistent handles: `0x81000001` SRK, `0x81000101`/`0x81000102` owner Secure Boot signers, `0x81000103` first-boot vault seed, `0x81000105` recovery auth object, `0x81000110` strata anchor HMAC key, `0x81000120` fleet device key, `0x81000140 + i` owner-seal keys, `0x81010002` AK, `0x81010003` AK0.
- Counters that services write are `AUTHWRITE` with the auth value sealed to that service under the signed PCR11 `ready` phase and PCR15. Write rates are bounded (the ledger counter at most every 900 s plus security events).
- The `keylos-tpm-registry` crate holds the constants and templates; the `tpm/` conformance vectors check every TPM-using component against it.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep `0x01C1xxxx` | Inside a TCG-reserved block |
| Let each repo allocate its own indices | Already produced collisions in the drafts |
| Allocate indices dynamically at install and record them | The initrd and the phone need fixed, verifiable locations; dynamic allocation adds state that can itself be rolled back |

## Consequences

### Positive
- No collisions, one place to review TPM usage, machine-checkable conformance.
- Firstboot bundles name the registry version instead of listing handles.

### Negative
- A new TPM object needs a protocols minor release.
- Machines installed with a pre-release draft would need re-enrolment; v1.0 has no such machines.

## Related

- [Boot chain](../05-integrity/boot-chain.md)
- [Names, paths and IDs](../13-reference/names-paths-and-ids.md)
- [ADR-0014: TPM+PIN with signed PCR policy](adr-0014-tpm-pin-signed-pcr-policy.md)
