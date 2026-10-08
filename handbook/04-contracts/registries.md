# Registries

> protocols §19 holds every name that more than one repository must agree on: service names, facets, receipt events, media types, vsock ports and TPM objects.
> This page summarises the registries and explains the rules. The spec tables are normative; the component pages carry the per-service excerpts, generated from the spec.

**Status:** specified (v1.0) · **Normative source:** [protocols §19](../../specs/protocols/spec.md#19-registries)

## Service names

| Service | Repo | Tier |
|---|---|---|
| `warden` | warden | PID 1 |
| `broker`, `ledger`, `vault`, `hearth`, `gate`, `net`, `aide`, `depot`, `courier`, `strata`, `config`, `bench`, `compat`, `devd`, `journal` | same name | t0 |
| `forge` | forge (`forged`; builds run in tier-3 build VMs) | t0 |
| `atrium` | atrium (compositor and trusted path) | t0 |
| `portal-files`, `portal-screen`, `portal-camera`, `portal-mic`, `portal-openuri`, `portal-notify`, `portal-print`, `portal-clipboard`, `portal-location`, `portal-a11y`, `portal-background`, `portal-shortcuts`, `portal-inhibit` | portals (one process per portal per logged-in human) | t0 |
| `fleet` | fleet (fleet-enrolled machines only) | t0 |
| `vouch` | vouch (machine-side `vouchd`, when a phone is paired) | t0 |
| `classifier` | a policy-named generation (optional approval-escalation classifier, facet `broker` only) | t0 |

## Facets

Every route names exactly one facet, written `service#facet`. A server implements exactly the registered facets, and refuses methods outside the caller's facet with `kl:denied`. Holders other than those listed are routed only when policy grants `right("service", "<svc>#<facet>", "use")`.

| Service | Facets |
|---|---|
| warden | `client`, `service`, `admin`, `broker`, `compat`, `bench`, `strata`, `hearth`, `portals`, `launcher`, `handler`, `trusted-terminal` |
| broker | `principal`, `system`, `label-authority` |
| ledger | `writer`, `reader`, `witness`, `admin`, `time` |
| vault | `app`, `admin`, `broker`, `gate`, `strata`, `ledger`, `aide`, `hearth`, `net`, `adapter` |
| hearth | `greeter`, `presence`, `atrium`, `admin`, `system`, `seal` |
| gate | `client`, `broker`, `shim`, `meter`, `aide`, `admin`, `debug` |
| net | `user`, `status`, `resolver`, `captive`, `plumbing` |
| aide | `user`, `host`, `admin`, `grant-delegate` |
| depot | `user`, `mounter`, `forge`, `config`, `compat`, `courier`, `admin` |
| courier | `client`, `admin`, `depot` |
| strata | `user`, `cli`, `bench`, `aide`, `compat`, `warden`, `hearth`, `courier`, `admin` |
| config | `owner`, `user`, `propose`, `fleet`, `read` |
| forge | `user`, `release` |
| devd | `client`, `broker`, `warden`, `service`, `atrium`, `admin` |
| journal | `client`, `admin`, `warden`, `fleet` |
| bench | `user`, `aide`, `compat`, `merge`, `admin` |
| compat | `user`, `service`, `adapter`, `admin` |
| atrium | `approve`, `presence`, `notify`, `display`, `settings`, `bridge`, `native`, `portal-screen`, `portal-shortcuts`, `portal-camera`, `portal-mic`, `portal-location`, `portal-background`, `ctl` |
| portal-* | `default`, `ctl`; portal-files also `broker`, `drop`; portal-mic `capture`, `playback` |
| fleet | `client`, `gate`, `decider` |
| vouch | `settings`, `approvals`, `announce` |

Old names that appeared in drafts map as follows: `spawn-user` → `warden#launcher`, `spawn-handler` → `warden#handler`, `spawn-trusted-terminal` → `warden#trusted-terminal`, `spawn-child` → `warden#client`, `grant-mount` → `warden#portals`, `depot#read` → `depot#user`, `vault#names` → `vault#app`, `gate#intents` → `gate#client`, `compat#run` → `compat#user`, `fleet-decider` → `fleet#decider`.

## Receipt events

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

**Extension rule.** A repository MAY emit `x-<repo>.<event>` events (for example `x-strata.replica.send`). They MUST be listed in that repository's spec, MUST be written only by its own services, and carry no meaning for anyone else. Unprefixed events MUST be in the registry.

## Media types and formats

Every signed document has a media type `application/vnd.keylos.<doc>+json; version=<major>` and a matching `schema` field `keylos.<doc>/<major>`.

| Owner | Formats |
|---|---|
| protocols (shared) | `manifest`, `agent-template`/`agent-tools`/`agent-policy`, `cmdsig`, `receipt`/`receipt-redacted`, `mandate`, `configgen`, `seal`, `revocations`, `drv`, `confinement`, `boottrust`/`bootreport`, `presence`, `owners-entry`/`owners`, `seal-window`, `release`, `genstmt`, `consent`, `exception`, `flowproof`, `fsmerge`, `firstboot`, `tlogproof` |
| broker | `grant` |
| hearth | `user` |
| config | `rendered`, `module`, `drift`, `configlock` |
| strata | `changeset`, `anchor`, `unitfs` |
| courier | `apprelease`, `logs`, `rebuilders` |
| tlog, forge | `logauth`, `candidates`, `mismatch` |
| compat | `compat` (the `legacy-image` manifest section) |
| keylos | `hwcert`, `governance`, `advisory` |
| installer | `pendingreceipt` |
| fleet | `fleet.command`, `fleet.attest` |
| bench | `bench.vm`, `bench.snapshot` |
| ledger | `ledger-export` |

Formats owned by a repository other than protocols MUST NOT be parsed by any other repository. `keylos.releaselog/1` no longer exists: release-log entries are the `keylos.release/1` statements themselves.

## vsock ports

| Port (host CID 2) | Direction | Service | Profile |
|---|---|---|---|
| 1024 | guest → host | bench control (`benchd`) | capwire-vsock |
| 1025–1535 | either | bench bulk streams announced in control messages | raw byte streams |
| 7002 | guest → host | aide `AgentHost`, forwarded by bench for agent VMs only | capwire-vsock |

All other guest traffic leaves through one virtio-net device terminated by `bench-net`, which maps each flow to `ShimEndpoint.connect` on gate. There is no vsock path to gate or broker.

## TPM objects

All NV indices live in the owner-hierarchy block **`0x01300100–0x013001FF`**. Services that write a counter hold its authValue as a TPM-sealed secret bound to the signed PCR11 `ready` phase and PCR15.

| NV index | Name | Owner |
|---|---|---|
| `0x01300100` | ledger-counter (checkpoint counter) | ledger |
| `0x01300101` | config-counter | config (read by boot) |
| `0x01300102` | os-floor (minimum bootable release `seq`, 8 bytes) | courier (read by boot) |
| `0x01300103` | pcrlock-policy (PCR0–7 policy digest) | courier, boot (recovery) |
| `0x01300104` | keystore-floor | vault |
| `0x01300105` | owner-registry-head (104 bytes) | hearth (read by boot) |
| `0x01300106` | login-failure-counter | hearth |
| `0x01300107` | strata-anchor-counter | strata |
| `0x01300108` | attestation-key names (AK, AK0) | installer, boot |
| `0x01300110` | vault-epoch/0 (alternates with /1) | vault |
| `0x01300111` | vault-epoch/1 (alternates with /0) | vault |
| `0x01300140 + i` | seal-gate/i (one per owner, i < 16) | hearth |

| Persistent handle | Object |
|---|---|
| `0x81000001` | SRK (pinned at enrolment) |
| `0x81000101`, `0x81000102` | Owner Secure Boot KEK and db signers |
| `0x81000103` | First-boot vault seed key (evicted at first boot) |
| `0x81000105` | Recovery auth object |
| `0x81000110` | strata anchor HMAC key |
| `0x81000120` | fleet device key |
| `0x81000140 + i` | owner-seal/i (policy `PolicySecret(seal-gate/i)`) |
| `0x81010002` | AK (runtime attestation) |
| `0x81010003` | AK0 (pre-unlock verify-before-unlock quotes) |

| PCR | Content |
|---|---|
| 0–7 | Firmware, option ROMs, Secure Boot state (pcrlock policy) |
| 11 | UKI sections and boot phases (signed PCR11 policy) |
| 12 | Kernel command line and credentials |
| 13 | System extensions: always the "no extension" value |
| 14 | shim/MOK state (shim fallback mode only) |
| 15 | Volume identity, extended after unlock |

## Related

- [System interfaces](system-interfaces.md)
- [Receipts](receipts.md)
- [Names, paths and IDs](../13-reference/names-paths-and-ids.md)
- [ADR-0045: Owner NV range and TPM registry](../11-decisions/adr-0045-owner-nv-range-and-tpm-registry.md)
