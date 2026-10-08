# Fleet

> Fleet lets an organisation manage keylos machines without taking away the device's own enforcement. The organisation can add forbids, raise approval tiers, require extra approvers and check attestation. It cannot grant authority or read user data.
> Status: **specified (v1.0)**, optional component. Normative spec: [fleet](../../specs/fleet/spec.md).

## Two modes

| | BYOD (`member`) | Managed |
|---|---|---|
| Owner | The person | The organisation |
| Org policy changes | Shown as a plain-language diff; the owner touches to apply | Applied with an org admin mandate |
| Remote lock / wipe | Never | Yes, with a quorum of admin signatures (default 2) |
| Recovery key escrow | Opt-in | Yes |
| Unenrol | Owner, any time, one touch | Admin quorum |
| App inventory sent | Opt-in | Yes |

## What an organisation can do

| Capability | How |
|---|---|
| Forbid things | Cedar `forbid` rules in an org policy generation (for example: agents may only reach `*.corp.example`) |
| Raise approval tiers | `@tier("t3")` on actions keylos would allow at T1/T2 |
| Require an org approver | `@orgApproval("<group>")`: the commit also needs a mandate from someone in that group |
| Require configuration properties | Nickel contracts in `org.ncl` (for example integrity profile `full`, security updates automatic, screen lock ≤ 10 min) |
| Publish apps | Normal app generations through the org's TUF repository, with the same depot checks |
| Verify devices | Periodic TPM quotes against the release log; compliance tokens for org SSO |
| Detect log tampering | The server cosigns ledger checkpoints after checking consistency |

An org policy that tries to **grant** something (a `permit` that does not only raise a tier) is rejected by `fleet-ctl policy validate`. The device's `config` also refuses any owner config that deletes org forbids while enrolled.

## Distribution

Org content comes through the org's **own TUF repository**, pinned in the device's config at enrolment. There are separate targets for:
- the policy generation;
- the contracts module;
- admin and approver keys;
- org apps;
- org revocations.

`courier` fetches them, and `fleetd` turns them into a config proposal.

## Attestation and compliance

Every 60 minutes by default, `fleetd` sends:
- a TPM quote over PCR 0–15 with a server nonce;
- the event log;
- the booted release reference;
- the config counter;
- the current ledger checkpoint.

| State | Meaning |
|---|---|
| `compliant` | Quote valid, PCR 11 matches a logged release, firmware matches baseline, checkpoint consistent, integrity allowed |
| `noncompliant:<reasons>` | For example `integrity-degraded`, `stale-os`, `policy-pending`, `firmware-changed`, `checkpoint-regression` |
| `unknown` | No attestation within two intervals |

**Compliance tokens.** Org services check compliance through short-lived compliance tokens (`FleetCompliance.complianceToken`, fleet facet `gate`), which `gate` injects into requests to the org's SSO. The SSO never has to talk to the fleet server, and apps never see the token.

## Privacy boundaries

| Data | BYOD | Managed |
|---|---|---|
| Hardware, OS generation, profile, integrity, update state | sent | sent |
| Quotes, event logs, checkpoint sizes and roots | sent | sent |
| App names and versions | opt-in | sent |
| Receipt contents | never | only listed event types (audit export, shown in status) |
| Files, vault items, agent transcripts, browsing | never | never |
| Recovery key | opt-in escrow | escrowed |

The device shows exactly this table, filled in, under Settings → Organisation.

## Organisation approvals

When a policy marks an effect with `@orgApproval`, for example payments over a limit or pushes to release branches:
1. The user approves locally as usual.
2. The broker calls `OrgDecider.decide` on the machine-side `fleet` service (facet `decider`), which sends a redacted rendering and the payload digest to the fleet server.
3. An approver in the named group approves on their own keylos machine (`fleet-approve`) or phone (vouch), signing a mandate over the same digest with their `approver/<id>` key (`channel: "org"`).
4. `gate` commits only with both mandates. An org approval never satisfies a presence requirement.

## Remote actions (managed only)

Commands are signed by a quorum of admins and verified on the device against the admin keys in the current org policy:

| Command | Effect |
|---|---|
| `lock` | All sessions locked; unlocking needs org approval + user auth |
| `wipe` | Locks every session at once (`HearthFleet.lockAll`); the wipe itself completes only at the next recovery entry, after the recovery environment verifies a quorum of the machine's owners. A command alone never wipes a machine |
| `unenrol` | Org policy removed; ownership passes to a local owner at next boot |
| `rotate-escrow` | Recovery key re-encrypted to a new escrow key |

## Clusters and quorum approvals

| Function | How |
|---|---|
| Kubernetes node join | `cri` gets a single-use `FleetCluster.joinChallenge` and calls `joinAttested` with an AK quote over it (and a CVM report on confidential VMs); fleet verifies it against the release log and issues cluster certificates (`clusterCertificate`, roles `kubelet`, `kube-proxy`, `cri`) only to attested nodes ([Kubernetes nodes](kubernetes.md)) |
| Quorum presence relay | fleet carries `keylos.quorum/1` requests to approvers and returns their signatures (`HearthQuorum.submit`); approvers sign on their own machines |
| Remote config | `ConfigFleet.applyRemote` applies a config statement with approver presence envelopes on managed machines |
| Org publishers | The org TUF repository's `org-publishers` role signs `container` generations and org apps, trusted only on enrolled machines |
| Cloud seeds | fleet seed keys sign first-boot bundles for `cloud` images |
| Receipts | `ledger#fleet-export` gives metadata only; payloads only for event types an owner exception (`fleet-receipt-access`) lists ([Receipt privacy](../08-state/receipt-privacy.md)) |

## Limitations

- Fleet cannot see in-memory compromise between attestations. Like vouch, it attests boot state.
- A BYOD owner can always unenrol. The organisation's recourse is revoking access through compliance tokens.
- Approvers are people. Org approvals add to the local decision; they do not replace it.

## Related

- [fleet spec](../../specs/fleet/spec.md)
- [Attestation and vouch](../05-integrity/attestation-and-vouch.md)
- [Install and enrolment](install-and-enrolment.md)
- [ADR-0028: Approval tiers](../11-decisions/adr-0028-approval-tiers.md)
