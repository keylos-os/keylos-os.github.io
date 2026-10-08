# Signed documents

> Every signed keylos document is a DSSE envelope over a JCS-canonical JSON payload, with an explicit algorithm on each signature.
> One format covers manifests, receipts, mandates, seals, generation and release statements, config generation statements, revocation lists and in-toto attestations, so one verifier library checks them all. Owner presence signatures are FIDO2 assertions over the hash of the DSSE PAE encoding.

**Status:** specified (v1.0) · **Normative source:** [protocols §4](../../specs/protocols/spec.md#4-cryptography), [§5](../../specs/protocols/spec.md#5-signed-documents)

## Envelope

```json
{"payloadType": "application/vnd.keylos.receipt+json; version=1",
 "payload": "<base64 of JCS bytes>",
 "signatures": [{"keyid": "key:sha256:…", "sig": "<base64>", "alg": "ed25519"}]}
```

| Rule | Reason |
|---|---|
| Sign the DSSE PAE encoding | Binds the payload type, which prevents type confusion |
| Payload MUST be RFC 8785 JCS. Verifiers re-canonicalise and reject any mismatch | One byte form per document, so digests and dedup are stable |
| `alg` is explicit per signature | Algorithm agility without guessing |
| Unknown `alg` is rejected | No downgrade by unknown algorithms |
| Every payload has a `schema` field matching its media type | A document can't be replayed as another type |

## Document types

| Document | Media type | Signed by |
|---|---|---|
| Generation manifest | `application/vnd.keylos.manifest+json; version=1` | (inside the generation; authorised by the generation statement) |
| Generation statement | `application/vnd.keylos.genstmt+json; version=1` | Release stream, publisher, or owner-seal key |
| Release statement | `application/vnd.keylos.release+json; version=1` | Release stream (also the release-log entry) |
| Consent record | `application/vnd.keylos.consent+json; version=1` | `service/depot` |
| Owner exception | `application/vnd.keylos.exception+json; version=1` | Owner presence |
| Owner registry entry | `application/vnd.keylos.owners-entry+json; version=1` | Owner presence (quorum rules) |
| Seal window | `application/vnd.keylos.seal-window+json; version=1` | Owner presence |
| Flow proof | `application/vnd.keylos.flowproof+json; version=1` | Agent session key |
| Command signature | `application/vnd.keylos.cmdsig+json; version=1` | (inside the signed generation) |
| Receipt | `application/vnd.keylos.receipt+json; version=1` | Writer service + ledger |
| Approval mandate | `application/vnd.keylos.mandate+json; version=1` | Owner presence when `presence` is true; otherwise the atrium approver key, the vouch phone key or an org approver key |
| Realisation attestation | `application/vnd.in-toto+json` (predicate `https://keylos.org/realisation/v1`) | Rebuilder |
| Config generation statement | `application/vnd.keylos.configgen+json; version=1` | Owner presence |
| Seal statement | `application/vnd.keylos.seal+json; version=1` | Owner-seal TPM key, through `HearthSeal.sealSign` |
| Revocation list | `application/vnd.keylos.revocations+json; version=1` | Release stream |

## Algorithms

| Use | Algorithm |
|---|---|
| Software keys | Ed25519 (`ed25519`) |
| TPM and HSM keys | ECDSA P-256/SHA-256 (`ecdsa-p256-sha256`) |
| Presence (FIDO2 authenticators) | `fido2-es256` (COSE −7) or `fido2-eddsa` (COSE −8) |
| Hash | SHA-256 |
| AEAD | AES-256-GCM (hardware AES), otherwise XChaCha20-Poly1305 |
| Key agreement | X25519 |
| Password KDF | Argon2id (≥ 256 MiB, t=3, p=4 on desktops) |
| TLS | rustls; TLS 1.3 to keylos endpoints, 1.2+ to third parties through gate |

No signature over store content is checked in the kernel: keylos uses no fs-verity builtin signatures and no `.fs-verity` keyring policy. Generation statements are verified in userspace against the boot trust set, and the `kl-exec` BPF LSM enforces "execute only from verified mounts" ([Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md)).

Post-quantum signatures (for example ML-DSA-65) arrive in a protocols minor version by **adding** a signature alongside the existing one, never by replacing it.

## Trust roots

| Root | Holder | Signs |
|---|---|---|
| `distro-root` | Project, offline, 3-of-5 (TUF root) | Delegations, stream keys |
| `release-stream/<stream>` | Project HSM (Ed25519) | Release statements, OS and distro generation statements, PCR policies, revocations |
| `kernel-policy/<stream>` | Project HSM (RSA-3072, X.509 in the kernel's secondary keyring) | The IPE policy |
| `rebuilder/<operator>` | Independent operators | Realisations |
| `log/<origin>`, `witness/<name>` | Log and witness operators (C2SP note keys) | Checkpoints, cosignatures |
| `owner-presence` | Owners' FIDO2 credentials | Config generation statements, seal windows, T3 mandates, owner-registry entries, policy changes |
| `owner-seal/<i>` | One TPM-resident P-256 key per owner, `PolicySecret` on the owner's seal gate | Seal and generation statements of owner-sealed generations |
| `service/<name>` | TPM-sealed Ed25519 key per tier-0 service, created at first boot | Receipts, consent and grant records |
| `session/<id>` | Ephemeral Ed25519 key per agent session, held in vault, created by aide | Agent git commits, flow proofs |
| `publisher/<id>` | Third-party publishers (TUF delegation or Sigstore identity) | App generation statements |
| `approver/<id>` | Org approvers registered by fleet (FIDO2 or vouch phone key) | Org-approval mandates |

## Presence signatures

A FIDO2 authenticator can't sign arbitrary bytes; it signs `authenticatorData ‖ clientDataHash`. keylos therefore sets `clientDataHash = SHA-256(DSSE-PAE(payloadType, payload))` and asks for an assertion with rpId `keylos.owner` and user presence (plus user verification where the purpose requires it, [protocols §20.2](../../specs/protocols/spec.md#202-presence-purposes)). The signature object carries `alg` `fido2-es256` or `fido2-eddsa` and a CBOR map of authenticator data, signature and credential ID. Verifiers (crate `keylos-presence`) check the rpId hash, the UP/UV flags, that the credential was enrolled in the owner registry at the payload's time, and the signature ([protocols §5.3](../../specs/protocols/spec.md#53-presence-signatures)).

## Related

- [Identifiers](identifiers.md)
- [Receipts](receipts.md)
- [Supply chain](../05-integrity/supply-chain.md)
- [Key ceremonies](../10-operations/key-ceremonies.md)
