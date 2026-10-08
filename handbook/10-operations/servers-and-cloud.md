# Servers and cloud

> keylos runs headless as well as on desktops. The `server`, `server-k8s`, `cloud` and `appliance` profiles have no compositor and replace the local FIDO2 touch with **quorum presence**: N of M owners sign remotely. Cloud images use the provider's vTPM, support confidential VMs, and take their first-boot configuration only from a signed bundle.
> Status: **specified (v1.0)**. Normative: [protocols §2.2](../../specs/protocols/spec.md#22-profiles-and-integrity-profiles), [§5.4](../../specs/protocols/spec.md#54-quorum-presence), [§20.13](../../specs/protocols/spec.md#2013-first-boot-bundle-keylosfirstboot1), [§20.18](../../specs/protocols/spec.md#2018-quorum-request-keylosquorum1).

## Profiles

| Profile | Use | Presence | Recovery |
|---|---|---|---|
| `server` | Bare-metal headless | Quorum | Serial console with the recovery key |
| `server-k8s` | Kubernetes worker ([Kubernetes nodes](kubernetes.md)) | Quorum | As `server` |
| `cloud` | VM image in a public or private cloud | Quorum | Provider serial console with the recovery key |
| `appliance` | Fixed-function device | Quorum | As `server`; no `bench` |

Integrity profiles shown in status: `full` on bare metal with owner Secure Boot keys, `cloud-vtpm` with a provider vTPM, `cvm` in a verified confidential VM, `shim` where custom Secure Boot keys aren't available.

## Quorum presence

On headless profiles the owner registry has `policy.mode = "quorum"` with a threshold N and M enrolled owner credentials.

1. An action needs presence: a config apply, seal window, policy change, persistent grant or owner-registry change.
2. `hearth` creates a `keylos.quorum/1` request. It is signed by the machine key and expires within 24 h, and it carries the payload and a rendering such as a config diff.
3. Approvers receive it through `fleet`, or as a file. Each one reviews it on their **own** keylos machine and signs with `hearth presence --remote <request>`, using their own FIDO2 credential.
4. Signatures return through `HearthQuorum.submit`. Once N **distinct owners** have signed, `HearthQuorum.collect` returns the quorum envelope and the action proceeds.

```
$ config propose ./infra-config                  # on the server, via SSH-less fleet tooling or the serial console
quorum request q-01JC… needs 2 of 3 owners (expires in 24 h)
# on alice's laptop
$ hearth presence --remote q-01JC…               # shows the rendered diff on alice's trusted path, touch
```

**Sealing.** No touch reaches a server, so the seal gate's next authValue sits in a TPM-sealed blob, bound to the signed PCR11 `ready` phase and PCR15. `hearth` releases it only after verifying a quorum envelope of purpose `seal.window`. Status shows `sealing: quorum`: the guarantee is "N approvers signed and the machine runs a verified hearth", not "a physical touch".

## Cloud images

| Topic | Behaviour |
|---|---|
| TPM | Provider vTPM. The provider's EK certificate chains are in the attestation trust store |
| Confidential VMs | SEV-SNP and TDX supported, SVSM vTPM preferred. `fleet` verifies the CVM report together with the TPM quote (integrity profile `cvm`) |
| Secure Boot | Custom keys where the provider supports UEFI variable stores; otherwise shim mode, reported as `shim` |
| First boot | A signed `keylos.firstboot/1` bundle fetched from the metadata service, signed by a fleet seed key (`fleet.seedKeys`). Unsigned user-data is ignored; there is no cloud-init |
| Recovery | Provider serial console; the recovery environment asks for the recovery key |
| Remote lock and wipe | `lock` takes effect at once; `wipe` locks and completes at the next recovery entry after a quorum of owners is verified |

## Day-two operations

```
kish status                 profile, integrity profile, sealing mode, revocation age
hearth quorum list          open quorum requests and signatures collected
courier status              staged update, boot counter
fleet status                enrolment, compliance, last attestation
cri node                    (server-k8s) attestation and kubelet state
```

Updates follow the normal flow ([Updates and rollback](updates-and-rollback.md)). Boot counting and the NV floor protect unattended reboots.

## Limitations

- Every presence-class change waits for N approvers. Plan quorum sizes so routine changes can complete within the 24 h request lifetime.
- Cloud providers without custom UEFI keys run in `shim` mode, with weaker boot guarantees.
- Losing more than M − N approver credentials blocks presence actions until recovery with the recovery key.

## Related

- [Kubernetes nodes](kubernetes.md)
- [Fleet](fleet.md)
- [Install and enrolment](install-and-enrolment.md)
- [Key ceremonies](key-ceremonies.md)
- [ADR-0048: Quorum presence](../11-decisions/adr-0048-quorum-presence.md)
