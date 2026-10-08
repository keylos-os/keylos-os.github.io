# keylos/hearth — users, homes, login and owner presence

| | |
|---|---|
| Repository | `github.com/keylos-os/hearth` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `hearthd` (tier-0 service generation `io.keylos.hearth`), `hearth` (CLI generation `io.keylos.hearth-cli`), crate `keylos-ctap` (CTAP 2.1 client over `hidraw`, `hmac-secret`, `credProtect`) |
| Depends on | `keylos-protocols 1.0` (`keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-presence`, `keylos-tpm-registry`) |
| Runtime peers | `warden` (`Bootstrap`, `ServiceHost`, `FdStore`, TPM fd; `warden#hearth`: `PrincipalControl.terminate`), `vault` (`vault#hearth`: `VaultUsers`), `strata` (`strata#hearth`: `StrataHomes`, `StrataAdmin.lockUnits`/`unlockUnits`), `broker` (`broker#system`: `revokeSession`; `broker#principal`: device grants), `atrium` (`atrium#presence`: `TrustedPrompt.presence`; `atrium#notify`), `devd` (`devd#service`: `PowerEvents`; FIDO `hidraw` devices through broker grants), `ledger` (`ledger#writer`, `ledger#reader`), `fleet` (caller of `hearth#quorum` and `hearth#fleet-lock`), `gate` (caller of `HearthSystem.owners`) |
| Provides | `Hearth` (protocols §7.3.12) on facets `greeter`, `presence`, `atrium`, `admin`; `HearthSystem`, `HearthSeal`, `HearthAdmin`, `HearthTpm`, `HearthQuorum`, `HearthFleet` (protocols §7.5.3) on facets `system`, `seal`, `admin`, `tpm`, `presence`/`quorum`, `fleet-lock`; the owner registry (protocols §20.3); quorum presence (protocols §5.4); `keylos.user/1` records; the `owner-presence` and `owner-seal/<i>` signing roles (protocols §5.2); sole userspace custody of the TPM owner and endorsement hierarchy authorizations (protocols §19.6); recovery-key trustee shares (protocols §20.19) |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as described in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`hearth` is where humans exist in keylos. It:

1. **Manages users:** creates, updates, disables and removes human accounts, allocates human UIDs (1000–59999), and creates home subvolumes through `strata`.
2. **Authenticates:** login, unlock and lock with password, PIN and FIDO2 authenticators (roaming keys and the hearth platform authenticator), guest and kiosk sessions. It unlocks and locks the user's vault slots and locks on suspend. Recovery-key use happens only in the recovery environment (`rescue`, installer spec), where `hearth` does not run.
3. **Provides owner presence:** turns a FIDO2 user-presence assertion into a DSSE presence signature (protocols §5.3) over the exact document being approved: config generations, seal windows, mandates, owner-registry entries, policy changes.
4. **Guards the owner-seal keys:** runs sealing windows (one touch authorizes up to 600 s of sealing for one project), enforced by a per-owner TPM NV seal gate whose authorization rotates through a FIDO2 `hmac-secret` chain (protocols §11.6).
5. **Maintains the owner registry:** a hash-chained, presence-signed log of owners, credentials and owner Secure Boot certificates, anchored in TPM NV `0x01300105` (protocols §20.3).
6. **Runs key ceremonies:** credential enrolment and removal, owner changes, recovery, recovery-key trustee splits.
7. **Holds the TPM owner hierarchy:** it is the only userspace holder of the owner and endorsement hierarchy authorizations and performs the few owner-hierarchy operations other services need through `HearthTpm` (protocols §19.6).
8. **Runs quorum presence** on headless and managed machines: N-of-M owner signatures collected remotely replace the local touch (protocols §5.4).
9. **Hosts guest and family use:** ephemeral guest sessions, and routing of non-owner requests to owners.
10. **Executes organisation locks** (`HearthFleet.lockAll`) on fleet-enrolled managed machines.

**Non-goals**

- `hearth` draws no UI. `atrium` renders the greeter, lock screen and presence prompts; `hearth` supplies state and performs authentication.
- No network identity (LDAP, Kerberos, OIDC). Fleet-managed identity maps onto local `hearth` users (`fleet` spec).
- No PAM and no editable `/etc/passwd`. `/etc/passwd` and `/etc/group` are generated read-only into the config generation from `HearthSystem.exportPasswd` for legacy-tier compatibility.

---

## 2. Context and embedded contracts

### 2.1 Position

```
atrium greeter/lock ──(hearth#greeter)──────┐
atrium presence relay ──(hearth#atrium)──────┤
broker, config, depot, courier, ledger, vault, aide, strata ─(hearth#presence)──► hearthd ──► CTAP2 over hidraw (roaming keys)
owner shell `hearth` CLI, atrium settings ─(hearth#admin)┤                  │──► TPM platform authenticator (assisted presence)
warden, devd, config, broker, gate, vouch, strata, bench, depot ─(hearth#system)┤                  │──► vault#hearth (VaultUsers)
depot, forge ──(hearth#seal)──────────────────────────────┤                  │──► strata#hearth (homes, guest homes, unit locks)
courier, vault, strata, ledger, config, vouch, fleet ─(hearth#tpm)┤                  │──► warden#hearth (freeze/terminate sessions)
fleet ──(hearth#quorum, hearth#fleet-lock)───────────────┘                  │──► broker#system (revokeSession)
                                                                             │──► atrium#presence, atrium#notify
                                                                             │──► TPM: owner + endorsement hierarchy auth (sole holder);
                                                                             │         NV 0x01300105, 0x01300106, 0x01300140+i;
                                                                             │         keys 0x81000140+i, 0x81000101/0x81000102
                                                                             └──► ledger#writer (receipts), ledger#reader
```

### 2.2 Embedded contracts (verbatim from `keylos-protocols 1.0.0`)

The following blocks are copied mechanically from `protocols/spec.md`. If anything here disagrees with protocols, protocols wins.

#### 2.2.1 Identifiers, cryptography and signed documents

<!-- BEGIN protocols §3.4 (verbatim) -->
> **protocols 3.4 Principal identifiers**

A principal is the tuple **(actor, human, session chain)**.

```
principal   = actor "@" human "/" session *( "/" session )
actor       = "app:" ref-gen
            / "service:" service-name ":" ref-gen
            / "agent:" ref-gen
            / "legacy:" ref-gen
            / "bench:" ref-gen
            / "pod:" pod-ns "/" pod-name ":" ref-gen-or-image
            / "shell"
            / "kernel"
human       = username / "_system" / "_cluster"
ref-gen-or-image = ref-gen / "oci:sha256:" 64HEXDIGLC   ; sealed container generation, or OCI image digest (keylos-vm pods)
session     = "s-" ULID          ; Crockford base32, 26 characters
ref-gen     = "gen:fsv256:" 64HEXDIGLC
```

Examples:
- `shell@alice/s-01JB6Q8Z0RXQ4M3W9V2N7T5K1C`
- `agent:gen:fsv256:9e1f…@alice/s-01JB6Q…/s-01JB6R…` (a sub-agent: the last session is the child)
- `service:vault:gen:fsv256:77aa…@_system/s-01JB5…`

Rules:
- The **session chain** records delegation. A child principal's chain is its parent's chain plus one new session. Its authority MUST be a subset of its parent's (§8).
- The **canonical key** for maps and log indexes is the full text form.
- Within a kernel, a running principal instance maps 1:1 to a **(UID, cgroup)** pair allocated by `warden` (§10.3). The mapping is published through `Supervisor.identify` (§7.3.2).
- A VM principal (tier 2 or 3) maps to the cgroup of its VMM process; processes inside the guest are not separate host principals.
- **Pod principals** (§21) always have human `_cluster`. A `keylos-vm` pod is one VM principal per pod sandbox whose actor names the pod's first container image; a `keylos-sealed` pod has one principal per container. The session chain starts at the `cri` service session.
<!-- END protocols §3.4 -->

<!-- BEGIN protocols §3.5 (verbatim) -->
> **protocols 3.5 Other identifiers**

| Identifier | Form |
|---|---|
| Session | `s-` + ULID, created by the spawner. ULIDs are unique and monotonic in time; only the canonical uppercase text form is valid. |
| Token root ID | 16 random bytes; text form `t-` + the 26-character **uppercase Crockford base32** encoding of the 128-bit big-endian value (the ULID codec; first character `0`–`7`). |
| Grant record ID | `g-` + ULID (persistent grant records, broker) |
| Effect intent ID | `e-` + ULID |
| Transaction ID | `x-` + ULID |
| Approval ID | `a-` + ULID. Minted by `broker` for the approvals it runs, and by `hearth` for the mandates of its own presence-confirmed effects (`x-hearth.*` kinds, never sent to `broker`) |
| Snapshot ID | `snap-` + ULID |
| Plan ID (config) | `p-` + ULID |
| Seal window ID | `w-` + ULID |
| Prepared merge ID | `pm-` + ULID (strata, §7.5.7, §20.12) |
| Quorum request ID | `q-` + ULID |
| Debug grant ID | `dbg-` + ULID |
| Pod sandbox ID (cri) | `pod-` + ULID (the Kubernetes pod UID is kept as metadata) |
| Media session ID (bench) | `med-` + ULID |
| Family inbox item ID (hearth) | `fi-` + ULID (a non-owner request waiting for an owner; never an approval ID, which is `a-…` and broker-issued) |
| Fleet command ID | `fc-` + ULID (§20.23) |
| Workflow ID | `wf-` + ULID. The persistent identity of one enrolled workflow (§20.25); minted by `loom`, never reused |
| Run ID | `wr-` + ULID. One run of a workflow (a fresh run after a migration, §20.27) |
| Step ID | `ws-` + the 26-character ULID of the run ID + `.` + state name (`[a-z][a-z0-9-]{0,31}`) + `.` + occurrence (decimal, no leading zeros, `0` for the first entry of that state in the run), e.g. `ws-01JB6Q8Z0RXQ4M3W9V2N7T5K1C.test.2`. Deterministic: the same run, state and occurrence always give the same step ID |
| Attempt ID | `wa-` + ULID. One execution attempt of a step; fresh for every claim, mapped to fresh runtime sessions |
| Effect ID | `fx-` + 26 uppercase Crockford base32 characters of the first 16 bytes of SHA-256(`"keylos-effect/1"` ‖ `0x00` ‖ step ID text ‖ `0x00` ‖ effect name) (the `t-` codec; first character `0`–`7`). Deterministic: every attempt of a step derives the same ID for the same named effect (§20.25) |
| Ownership epoch | `oe-` + decimal (≥ 1, no leading zeros) in documents; `UInt64` on the wire. Advanced by one at every claim of a workflow (§20.25) |
| Decision ID | `dr-` + ULID. A durable logical approval request and its decision (broker, §20.25); distinct from the boot-local prompt ID `a-…` |
| Budget account ID | `ba-` + ULID. A workflow-lifetime budget account held by `gate` (§20.25) |
| Catalog entry ID | reverse-DNS generation name (§3.3) |
| Device ID | `dev:` + subsystem + `:` + stable path, e.g. `dev:video4linux:pci-0000:00:14.0-usb-0:5:1.0` |
| Machine identity key | `key:sha256:…` of the machine's ledger signing key (the "machine key") |
<!-- END protocols §3.5 -->

<!-- BEGIN protocols §4 (verbatim) -->
> **protocols 4. Cryptography**

| Use | Algorithm |
|---|---|
| Signatures (software keys) | Ed25519 (RFC 8032), `alg = "ed25519"` |
| Signatures (TPM, HSM keys) | ECDSA P-256 with SHA-256 (DER signatures), `alg = "ecdsa-p256-sha256"` |
| Presence signatures (FIDO2 authenticators) | `alg = "fido2-es256"` (COSE −7) or `"fido2-eddsa"` (COSE −8), §5.3 |
| Hashing | SHA-256; SHA-512 only where an external format requires it |
| Symmetric AEAD | AES-256-GCM with hardware AES, otherwise XChaCha20-Poly1305 |
| Key agreement (software keys) | X25519 |
| Key agreement (TPM-resident keys) | ECDH P-256; hybrid encryption to a TPM key uses HPKE (RFC 9180) mode base, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM (TPMs have no Curve25519) |
| Hybrid encryption to software keys (recovery recipient, trustees, inheritance) | HPKE (RFC 9180) mode base, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM; `info` = `keylos-recovery-copy/1:<object>` for recovery copies (§20.2), otherwise the media type of the protected object |
| Secret sharing (trustee shares) | Shamir over GF(2^8), per-byte, as in SLIP-0039's field arithmetic, with the share format of §20.19 |
| Password KDF | Argon2id (m=256 MiB, t=3, p=4 minimum on desktop profiles) |
| Data-key wrapping | AES-256-GCM key wrap with a 96-bit random nonce and AAD = unit ID |
| TLS | rustls; TLS 1.3 only for keylos-operated endpoints; TLS 1.2+ allowed in `gate` for third-party hosts |

**Key identifiers** are `key:sha256:<hex of SPKI DER>`. For FIDO2 credentials the SPKI is derived from the credential's COSE public key.

**Algorithm agility.** Every signature record carries `keyid` and an explicit `alg`. Verifiers MUST reject unknown algorithms. New algorithms (for example ML-DSA-65) are added only in a protocols minor version, alongside both old and new signatures.

**No in-kernel signature verification of store content.** keylos does not use fs-verity builtin signatures or a `.fs-verity` keyring policy. Generation signatures are DSSE envelopes verified in userspace (§9.3); the kernel enforces "exec only from verified mounts" through `kl-exec`.
<!-- END protocols §4 -->

<!-- BEGIN protocols §5.1 (verbatim) -->
> **protocols 5.1 Envelope**

Every signed keylos document is a **DSSE envelope** (Dead Simple Signing Envelope v1.0):

```json
{"payloadType": "<media type>", "payload": "<base64>", "signatures": [{"keyid": "key:sha256:…", "sig": "<base64>", "alg": "ed25519"}]}
```

Rules:
- `alg` is a keylos extension field inside each signature object. DSSE verifiers that ignore unknown fields stay compatible.
- **Payloads** are JSON canonicalized with RFC 8785 (JCS), UTF-8 encoded.
- Media types have the form `application/vnd.keylos.<doc>+json; version=<major>`. The registry is §19.4.
- Signers MUST sign the DSSE PAE encoding. Verifiers MUST recompute the JCS form of the decoded payload and reject if it differs from the payload bytes. That rule forbids non-canonical payloads.
- Every `application/vnd.keylos.*` payload has a `schema` field of the form `keylos.<doc>/<major>` matching its media type (in-toto statements, §11.4, carry none).
- Base64 is the standard alphabet with canonical padding; non-canonical encodings are rejected.
- **Envelope bytes.** Wherever this document hashes "the envelope" (`rcpt:` refs, owner-registry `prev`, `windowDigest`, `mandateDigest`), the bytes are the **JCS** of `{"payloadType","payload","signatures":[{"keyid","alg","sig", …}]}`; stored envelopes (e.g. `owners.log` lines) MUST be in that form.
- **Unknown algorithms.** A signature with an unknown `alg` never counts; an envelope verifies when enough known-algorithm signatures by distinct keys verify (§4).
- Unknown members of every keylos document (any nesting level) are rejected unless prefixed `x-`.
<!-- END protocols §5.1 -->

<!-- BEGIN protocols §5.2 (verbatim) -->
> **protocols 5.2 Trust roots**

| Root | Holder | Signs |
|---|---|---|
| `distro-root` | The keylos project: offline, 3-of-5 threshold, as the TUF root role | TUF delegations, release-stream keys |
| `release-stream/<stream>` | Project, HSM (Ed25519) | Release statements (§20.6), OS and distro generation statements, PCR policies, revocations for that stream (`stable`, `beta`, `dev`) |
| `kernel-policy/<stream>` | Project, HSM (RSA-3072, X.509 in the kernel's secondary keyring at build time) | The IPE policy (PKCS#7) |
| `rebuilder/<operator>` | Independent rebuilder operators (Ed25519) | Realisation attestations |
| `log/<origin>` and `witness/<name>` | Log and witness operators (Ed25519, C2SP note keys) | Checkpoints, cosignatures |
| `owner-presence` | The machine owners' FIDO2 credentials (§5.3) | Config generation statements, seal windows, T3 mandates, owner-registry entries, policy changes |
| `owner-seal/<i>` | One TPM-resident P-256 key per owner *i* (§11.6, §19.6) | Seal statements and generation statements of owner-sealed generations |
| `service/<name>` | Each tier-0 service; TPM-sealed Ed25519 key created at first boot. Public keys are registered with `ledger` (receipt `ledger.key.register`, whose clear data is `{service, spki}`, countersigned by the machine key) and served by `Ledger.serviceKey` (§7.3.5) | Receipts it writes; service-issued records (consent, grant records, quorum requests by `hearth`) |
| `recovery-recipient` | X25519 key derived from the recovery key (§20.21); only its public half is stored on the machine (`/var/lib/keylos/recovery/recipient.pub`) | Nothing (encryption only): HPKE recovery copies (owner-hierarchy auth, vault `recovery` slots) |
| `session/<id>` | Ephemeral Ed25519 key per agent session, held in `vault` (created by `aide`) | Agent git commits, flow proofs |
| `publisher/<id>` | Third-party app publishers, onboarded through the TUF `publishers` delegated role: an Ed25519 hardware-held key, or a Sigstore identity (OIDC issuer + subject) named in the delegation (§20.20) | App generation statements |
| `org-publisher/<org>/<id>` | Organisation publishers delegated by a fleet's TUF repository (fleet-enrolled machines only) | Generation statements of org apps and of `container` generations for `keylos-sealed` pods (§21) |
| `catalog` | Project, HSM (Ed25519), TUF delegated role `catalog` | The catalog (`keylos.catalog/1`, §20.20) |
| `approver/<id>` | Org approvers' keys registered by `fleet` (FIDO2 or the `vouch` phone approval key) | Org-approval mandates (§16.2) |
| `service/broker` (mandate role) | The broker's service key | Non-presence mandates (§14.4) |
<!-- END protocols §5.2 -->

<!-- BEGIN protocols §5.3 (verbatim) -->
> **protocols 5.3 Presence signatures**

A FIDO2 authenticator cannot sign arbitrary bytes: it signs `authenticatorData ‖ clientDataHash`. A presence signature over a DSSE payload is constructed as follows:

```
pae := DSSE-PAE(payloadType, payload)
cdh := SHA-256(pae)
assertion := CTAP2 authenticatorGetAssertion(rpId = "keylos.owner", clientDataHash = cdh,
                                              allowList = enrolled credentials, options = {up: true, uv: per purpose})
sigObj := {"keyid": "key:sha256:<SPKI of credential>", "alg": "fido2-es256" | "fido2-eddsa",
           "sig": base64(CBOR{1: authenticatorData, 2: signature, 3: credentialId})}
```

Verification (crate `keylos-presence`; every verifier MUST use it or an equivalent conforming implementation):
1. Check the payload is JCS-canonical and its `schema` matches the expected purpose (§20.2).
2. Decode the CBOR map. Check `authenticatorData.rpIdHash == SHA-256("keylos.owner")`.
3. Check the UP flag is set, and the UV flag when the purpose requires it.
4. Look up the credential by `keyid` in the **owner registry** (§20.3) state current at the payload's `time`. The credential MUST NOT have been removed before that time.
5. Verify `signature` over `authenticatorData ‖ cdh` with the credential's COSE key.

Stateful verifiers (`hearth`) SHOULD track `signCount`. Stateless verifiers (`boot`) skip it.

Login assertions (screen unlock, greeter) use the separate rpId `keylos.login` and are never accepted as presence signatures; presence always uses `keylos.owner`.

The FIDO2 `hmac-secret` extension is used only by `hearth` for the seal gate (§11.6). Its outputs never leave `hearth`.

**Accepted authenticators.** Any FIDO2 authenticator with user verification counts, roaming or platform. `hearth` includes a TPM-backed platform authenticator for owners who cannot operate a roaming key: user presence is a confirmation on the trusted path (a pointer, keyboard or switch-access action inside the atrium-drawn prompt), user verification is the owner's PIN entered there. Such a credential is enrolled with `"assisted": true` in its owner-registry entry (§20.3); `status`, the `vouch` verdict and every presence prompt show it. The platform authenticator's TPM signing key and its `hmac-secret` key are created under the SRK `0x81000001` with `userWithAuth` **clear** and authPolicy `PolicyPCR(sha256:{15}) ∧ PolicyAuthValue`, whose authValue `hearth` derives from the owner's PIN; PCR15 alone never authorizes a signature. Their blob `/var/lib/keylos/hearth/platform/<keyid>.blob` (§10.7) is the JCS object `{"rpId", "credentialId", "cose", "salt", "key", "hmacKey"}`, binary members in standard base64, `key` and `hmacKey` each `TPM2B_PRIVATE ‖ TPM2B_PUBLIC`. Policy MAY forbid assisted credentials for specific purposes (`config.presence.assistedAllowed`, default: allowed for every purpose).
<!-- END protocols §5.3 -->

<!-- BEGIN protocols §5.4 (verbatim) -->
> **protocols 5.4 Quorum presence**

Headless profiles (`server`, `server-k8s`, `cloud`, `appliance`) and managed machines use **quorum presence** instead of a local touch. The owner registry (§20.3) then has `policy.mode = "quorum"` and `policy.threshold = N`, with M approver credentials (the owners' FIDO2 credentials, enrolled like any owner credential).

- A **quorum presence envelope** is an ordinary DSSE envelope over the same payload with **≥ N signatures** (§5.3 construction) from credentials of **distinct owners**. Verifiers MUST count distinct owners, not signatures.
- Collection: `hearth` creates a quorum request (`keylos.quorum/1`, §20.18) through `HearthQuorum.request` (§7.5.3); approvers receive it through `fleet` (or out of band as a file), review the rendered payload on their own keylos machine, and sign it there with `hearth presence --remote <request>` (their machine's `hearth` signs with their own credential and rpId `keylos.owner`); signatures return through `HearthQuorum.submit`. The request expires after at most 24 h.
- Every purpose of §20.2 accepts a quorum envelope on quorum machines. On `desktop`/`laptop` profiles quorum envelopes are accepted only for owner-registry changes that the registry policy marks `quorum`.
- **Seal gate on quorum machines.** No touch reaches the machine, so the seal gate's authValue for the window is released differently: `hearth` holds the next gate authValue in a TPM-sealed blob bound to the signed PCR11 `ready` phase and PCR15, and unseals it only after verifying a quorum envelope of purpose `seal.window`. This reduces the guarantee from "a physical touch" to "N approvers signed and the machine runs a verified `hearth`"; the reduction is shown in `status` (`sealing: quorum`).
<!-- END protocols §5.4 -->

#### 2.2.2 capwire

<!-- BEGIN protocols §7.1 (verbatim) -->
> **protocols 7.1 Model**

All keylos IPC between principals on one kernel uses **Cap'n Proto RPC (rpc.capnp, level 1 plus promise pipelining)** over **AF_UNIX `SOCK_SEQPACKET`** sockets.

- **There is no system bus.** A process can reach only the capabilities it was handed:
  - the bootstrap capability of each socket `warden` passed to it at spawn (listed in `KEYLOS_CAPWIRE_FDS`, §10.5),
  - capabilities returned by calls on those.
- **The one exception is the CRI boundary** (§21): the upstream `kubelet` speaks the Kubernetes CRI v1 gRPC API to `cri` over an `AF_UNIX` `SOCK_STREAM` socket that `warden` creates and passes to `kubelet` (route `cri#kubelet`). No other non-capwire IPC between keylos principals is allowed.
- **Holding is authority.** A capability or an fd received through capwire is itself the authority to use it. capwire has **no call-attached tokens**: methods that need token-based authority take an explicit `C.Token` parameter; otherwise the route facet or the held capability is the authority.
- **Framing:** one Cap'n Proto message (standard segment-table framing) per datagram.
  - Maximum datagram size: 4 MiB.
  - Larger data MUST use a `ByteStream`/`ByteSource` capability or a passed fd.
- **File descriptors** travel as `SCM_RIGHTS` ancillary data on the same datagram, at most 64 per datagram. Inside the message, an fd is referenced by an `Fd` struct whose `index` is its position in that datagram's fd array.
  - **No fd** is written as `index = 0xFFFF`, which is the struct default; a null `Fd` pointer also means "no fd". Senders SHOULD write `Fd` structs explicitly. A method that requires an fd fails with `kl:invalid` when it gets none.
  - An `Fd.index` that is out of range, or that a receiver resolves a second time, fails **that call** (or that result's processing) with `kl:invalid`; the connection stays up. The transport is schema-unaware, so an index is checked when the receiver resolves the field.
  - Every received fd that no field took is closed when the receiver releases the message (call parameters released, or the response dropped).
  - Fds can be attached to any parameter or result struct of a message built on a capwire connection, including structs with pointer fields only; a caller does not need to resolve a bootstrap promise before sending fds on it.
  - `ENOBUFS` and `ENOMEM` from `sendmsg` are transient: the sender retries with backoff for up to 1 s before it fails the connection.
- **Datagram rules** (violations are protocol errors that fail the **whole connection**, reported to the local side as `kl:invalid`): exactly one standard-framed message per datagram with no trailing bytes; size ≤ 4 MiB; ≤ 64 fds; ancillary data not truncated (`MSG_TRUNC`/`MSG_CTRUNC`); fds never on capwire-vsock. Senders MUST NOT send zero-length datagrams; a receiver reads a zero-byte datagram as end of connection. A sender whose own outgoing message would exceed 4 MiB fails the connection rather than leave the peer waiting.
- **Socket buffers.** `warden` (and any component that creates capwire sockets for others) sets `SO_SNDBUFFORCE` and `SO_RCVBUFFORCE` to at least 4 MiB + 64 KiB (4 259 840 bytes) on both ends of every capwire socketpair it creates, so 4 MiB datagrams fit; distributions set `net.core.wmem_max` and `net.core.rmem_max` ≥ 4 259 840 (§2). capwire-vsock endpoints set `SO_VM_SOCKETS_BUFFER_SIZE`/`_MAX_SIZE` to the same value.
- **Peer identity:**
  - Every capwire connection between principals is a `socketpair` created by `warden` (§7.2). For such sockets the kernel records the **creating** process (`warden`) as the peer of both ends, so `SO_PEERPIDFD` and `SO_PEERCRED` name `warden`, not the peer. Servers MUST take the peer's principal, tier, generation and facet **only** from `ServiceHost.accept` (§7.5.1), or from `Supervisor.connectionInfo` for a connection ID `warden` delivered.
  - `SO_PEERPIDFD` + `Supervisor.identify` MAY be used only for sockets the peer itself `connect()`ed to a listening socket (not used between keylos principals in 1.0; reserved for diagnostics and future listeners).
  - Servers MUST NOT use PIDs, executable paths, or claims inside messages to decide who the caller is.
- **Bootstrap:** the socket's bootstrap capability implements the service's root interface **and** `common.Extensible` (§7.3.1). It is already narrowed by `warden` to the route's facet (§7.2).
<!-- END protocols §7.1 -->

<!-- BEGIN protocols §7.2 (verbatim) -->
> **protocols 7.2 Routes and facets**

`warden` wires services according to **routes** declared in service and app manifests plus policy.

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

- A **facet** is a server-defined restriction name. The registry of every facet, its holders and the methods it allows is §19.2. Servers MUST refuse methods their facet doesn't allow with `kl:denied`.
- Route references are written `service#facet` (for example `vault#app`).
- The server learns the facet of each connection from `ServiceHost.accept` (§7.5.1) or `Supervisor.connectionInfo`.
- Service sockets live under `/run/keylos/svc/<service>/` with mode `0700`, owned by `warden`'s UID. No other principal can `connect()` to them. Connections are created by `warden` (`socketpair` + hand-off through `ServiceHost.accept`).
- Dynamic routes (a service capability granted at runtime) are materialised by `broker` through `ServiceConnect.connectService` (§7.5.1).
<!-- END protocols §7.2 -->

<!-- BEGIN protocols §7.3.1 (verbatim) -->
> **protocols 7.3.1 `common.capnp`**

```capnp
@0xc7a1e5d3b2f40001;

struct Digest {
  algo  @0 :Algo;
  bytes @1 :Data;            #! sha256/fsv256: 32 bytes; sha512: 64 bytes
  enum Algo { sha256 @0; sha512 @1; fsv256 @2; }
}

struct Ref {                 # typed reference, protocols §3.2
  kind   @0 :Kind;
  digest @1 :Digest;
  enum Kind { obj @0; gen @1; src @2; drv @3; rcpt @4; key @5; }
}

struct Fd { index @0 :UInt16 = 0xFFFF; }   #! index into the SCM_RIGHTS array of the carrying datagram; 0xFFFF (the default) and a null pointer mean "no fd"

struct Timestamp { unixNanos @0 :Int64; }

struct PrincipalId { text @0 :Text; }   #! canonical text form, protocols §3.4
struct SessionId   { text @0 :Text; }

struct Label {
  conf  @0 :Conf;
  integ @1 :Integ;
  enum Conf  { public @0; internal @1; private @2; secret @3; }
  enum Integ { trusted @0; user @1; untrusted @2; }
}

struct Token { biscuit @0 :Data; }      #! Biscuit v3 serialized token, protocols §8

struct KeyValue { key @0 :Text; value @1 :Text; }

struct AttemptBinding {          #! one execution attempt of a durable workflow (§20.25); epoch 0 (the default) = not an attempt
  workflow @0 :Text;             # wf-…
  attempt  @1 :Text;             # wa-…
  epoch    @2 :UInt64;           # ownership epoch of the claim (BrokerWorkflow.claim, §7.5.25)
  step     @3 :Text;             # ws-… the attempt executes
  owner    @4 :Text;             # the workflow's owning human; warden uses it as the attempt principal's human
}

interface ByteStream {
  write @0 (bytes :Data) -> stream;
  done  @1 ();
}

interface ByteSource {
  read @0 (maxBytes :UInt32) -> (bytes :Data, eof :Bool);
}

interface Cancelable { cancel @0 (); }

interface Watcher(T) {          # server-push subscription
  event @0 (event :T) -> stream;
}

interface Extensible {          #! implemented by every bootstrap capability
  ext     @0 (interfaceId :UInt64) -> (cap :Capability);   #! kl:denied if the facet does not allow that interface, or the server does not implement it
  version @1 () -> (protocols :Text, implementation :Text);   #! protocols: SemVer of this document ("1.0.0"); implementation: "<repo>/<SemVer>"
}
```

**Errors.** Methods signal failure with a Cap'n Proto exception of type `failed`. The exception `reason` string MUST start with `kl:<code>`, optionally followed by `:<ref>` (non-empty), then optionally a space and a human-readable message. Codes outside the table are a parse error. Root interfaces are not declared `extends(C.Extensible)`; clients obtain the `Extensible` view of a bootstrap capability by casting the same capability.

| Code | Meaning |
|---|---|
| `denied` | Policy refused. Not retryable without new authority. |
| `needs-approval` | `:<ref>` is an approval ID (`a-…`). Retry after the approval resolves, or use the returned `Approval`. |
| `not-found` | |
| `invalid` | Malformed request |
| `conflict` | State changed concurrently |
| `expired` | |
| `revoked` | |
| `budget` | Budget exhausted |
| `integrity` | Verification failure: signature, digest, fs-verity |
| `unavailable` | Transient; MAY retry with backoff |
| `unsupported` | Feature level or platform lacks support |
| `internal` | |

Example: `kl:needs-approval:a-01JB6R… Sending email requires approval`.
<!-- END protocols §7.3.1 -->

#### 2.2.3 Interfaces implemented

<!-- BEGIN protocols §7.3.12 (verbatim) -->
> **protocols 7.3.12 `hearth.capnp`**

```capnp
@0xc7a1e5d3b2f40012;
using C = import "common.capnp";

struct UserInfo { name @0 :Text; displayName @1 :Text; uid @2 :UInt32; owner @3 :Bool; locked @4 :Bool; }

interface Hearth {
  users     @0 () -> (list :List(UserInfo));
  login     @1 (user :Text, method :Text, response :Data) -> (session :C.SessionId);   # facet greeter
      #! methods: "password", "pin", "fido2"; "guest" (user and response empty: creates an ephemeral guest-… user and
      #! session, §3.3, §14.3); "kiosk" (kiosk profile only: autologin of the configured kiosk user, response empty)
  lock      @2 (session :C.SessionId) -> ();
  unlock    @3 (session :C.SessionId, method :Text, response :Data) -> ();
  presence  @4 (purpose :Text, payload :Data, assist :Data) -> (envelope :Data);   # FIDO2 assertion → DSSE presence envelope (§5.3)
      #! assist (facet atrium only): PIN or switch-access confirmation collected on the trusted path for an assisted
      #! platform authenticator (§5.3); empty for roaming authenticators and on every other facet
  enrollKey @5 (user :Text, kind :Text) -> (keyRef :Text);           # requires presence of an existing owner credential
  removeKey @6 (keyRef :Text) -> ();
}
```

- **Assisted presence.** The prompt id that binds an `assist` confirmation to its request is `sha256:<hex>` of the DSSE PAE of `payload`; atrium and hearth compute it independently.
- **`enrollKey`** of a kind that adds a vault slot (`fido2` login keys) requires the target user's vault key to be unlocked (`VaultUsers.addSlot`, §7.5.4) and fails `kl:unavailable:user-locked` until that user has logged in.
<!-- END protocols §7.3.12 -->

<!-- BEGIN protocols §7.5.3 (verbatim) -->
> **protocols 7.5.3 `hearth-sys.capnp`**

```capnp
@0xc7a1e5d3b2f40022;
using C = import "common.capnp";

interface HearthSystem {           # facet system
  validateSession @0 (session :C.SessionId) -> (user :Text, authenticatedAt :C.Timestamp, methods :List(Text), locked :Bool);
  owners          @1 () -> (registryJson :Text);            # keylos.owners/1 (§20.3)
  prepareSuspend  @2 () -> ();                              # devd before suspend; returns within 2 s
  resumed         @3 () -> ();
  exportPasswd    @4 () -> (passwd :Text, group :Text);     # for legacy views
  userState       @5 (user :Text) -> (locked :Bool, since :C.Timestamp);
      #! locked = the user has no authenticated, unlocked login session (logged out counts as locked); loom only
  watchUsers      @6 (watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);
      #! JCS {"user", "locked", "since", "deleted"} for every change of userState of any user and for user deletion; loom only
}

interface HearthSeal {             # facets seal (depot, forge)
  openWindow  @0 (windowJson :Text) -> (windowId :Text, presenceEnvelope :Data);   # keylos.seal-window/1 (§20.4); touch on trusted path
  sealSign    @1 (windowId :Text, statementJson :Text) -> (signature :Data, keyRef :Text);   # ECDSA P-256 DER by owner-seal/<i>
      #! any facet-seal holder may sign within a window another holder opened;
      #! statementJson MUST be keylos.seal/1 or keylos.genstmt/1 and its drv MUST be in the window's drvs, else kl:denied
  closeWindow @2 (windowId :Text) -> ();
}

interface HearthTpm {              # facet tpm (courier, vault, strata, ledger, config; vouch and fleet: activateCredential only)
  defineSpace @0 (index :UInt32) -> ();
      #! (re)defines an NV index listed in §19.6 with exactly its registry template; only the index's registered owner may call
  evict       @1 (handle :UInt32) -> ();
      #! evicts a persistent handle listed in §19.6 (e.g. 0x81000103 after first boot); presence required except for 0x81000103
  sbSign      @2 (which :Text, payload :Data, presenceEnvelope :Data) -> (signature :Data);
      #! which = "kek" | "db": signs an authenticated-variable update (PKCS#7 payload digest) with 0x81000101 / 0x81000102
      #! behind the seal gate; presenceEnvelope purpose "boot.sb-sign" covering SHA-256(payload); caller courier
  activateCredential @3 (akHandle :UInt32, credentialBlob :Data, encryptedSecret :Data) -> (secret :Data);
      #! TPM2_ActivateCredential with the EK (endorsement auth held by hearth) for AK 0x81010002 or AK0 0x81010003;
      #! used by vouch pairing and fleet enrolment to prove the AK lives in this TPM
  recreateKey        @4 (handle :UInt32, presenceEnvelope :Data) -> ();
      #! re-creates a persistent key listed in §19.6 from its registry template after a TPM clear or loss (e.g. the strata
      #! anchor HMAC key 0x81000110); only the key's registered owner may call; presence purpose "boot.recreate-key"
  sbAccepted         @5 (kekCert :C.Digest, dbCert :C.Digest) -> ();
      #! courier only: the firmware KEK and db variables (read back at boot) contain the new owner certificates with these
      #! SHA-256 digests; hearth then swaps the staged signers onto 0x81000101/0x81000102 (kl:conflict if nothing is staged)
}

interface HearthQuorum {           # facets presence (request, collect), quorum (submit: fleet), admin (list)
  request @0 (purpose :Text, payload :Data, rendering :List(Text)) -> (requestId :Text, requestEnvelope :Data);
      #! creates a keylos.quorum/1 request (§20.18), signed by service/hearth with its ledger key chain; expires ≤ 24 h
  submit  @1 (requestId :Text, signedEnvelope :Data) -> (have :UInt8, need :UInt8);
      #! adds approver signatures (each a §5.3 signature over the request's payload PAE) after verifying them
  collect @2 (requestId :Text) -> (envelope :Data);   #! kl:needs-approval until ≥ threshold distinct owners have signed
  list    @3 () -> (json :Text);
}

interface HearthFleet {            # facet fleet-lock (fleet)
  lockAll @0 (commandEnvelope :Data) -> ();
      #! verified keylos.fleet.command/1 "lock": locks every session, revokes every agent session (kill), requires owner unlock
}

interface HearthAdmin {            # facet admin
  createUser  @0 (name :Text, displayName :Text, owner :Bool) -> (uid :UInt32);   # presence
  disableUser @1 (name :Text, disabled :Bool) -> ();                                # presence
  deleteUser  @2 (name :Text, forgetData :Bool) -> ();                              # presence
  setPassword @3 (name :Text, secret :C.Fd) -> ();
  addOwner    @4 (name :Text) -> ();                                                # presence (quorum)
  removeOwner @5 (name :Text) -> ();
  setQuorum   @6 (addOwner :UInt8, remove :UInt8) -> ();   #! superseded before release: MUST return kl:unsupported
  registry    @7 () -> (json :Text);
  setQuorumPolicy @8 (mode :Text, quorum :UInt8, threshold :UInt8) -> ();
      #! appends a set-quorum owner-registry entry (§20.3): mode "touch" | "quorum"; quorum = owners required for
      #! owner-set changes; threshold = distinct owners for quorum presence (mode quorum)
}
```

**NV definition after genesis.** Once `hearth` holds the owner hierarchy authorization (installer genesis), every service that needs one of its registered NV indices (re)created obtains it through `HearthTpm.defineSpace`; no other service uses owner authorization. `defineSpace` defines the index from its registry template, generates a fresh authValue, and writes the sealed authValue file `nv-auth/0x<index>.sealed` (§19.6) before returning. `HearthQuorum` on facet `admin` serves `collect` and `list`; each `list` entry includes `requestEnvelope` (standard base64).
<!-- END protocols §7.5.3 -->

#### 2.2.4 Interfaces consumed

<!-- BEGIN protocols §7.3.2 (verbatim) -->
> **protocols 7.3.2 `warden.capnp`**

```capnp
@0xc7a1e5d3b2f40002;
using C = import "common.capnp";

enum Tier { t0 @0; t1 @1; t2 @2; t3 @3; legacy @4; }

struct FdMapping { target @0 :Int32; fd @1 :C.Fd; }

struct Limits {
  cpuWeight  @0 :UInt16 = 100;    # cgroup cpu.weight
  memoryMax  @1 :UInt64;          # bytes, 0 = inherit
  pidsMax    @2 :UInt32;          # 0 = inherit
  ioWeight   @3 :UInt16 = 100;
  wallSecs   @4 :UInt32;          # 0 = unlimited
}

struct SpawnSpec {
  generation  @0 :C.Ref;          #! kind gen; MUST be launchable (sealed, not revoked)
  entrypoint  @1 :Text;           # manifest entrypoint key, default "main"
  argv        @2 :List(Text);     # appended to entrypoint args
  env         @3 :List(C.KeyValue);  #! secrets MUST NOT be passed via env; warden rejects names matching policy secret patterns and reserved KEYLOS_* names;
                                     #! for actorKind pod the secret-pattern check is skipped (the admitted Kubernetes env may carry secrets, §21)
  fds         @4 :List(FdMapping);   # explicit fds; nothing else is inherited
  grants      @5 :List(C.Token);     # tokens attached to the new principal
  cwd         @6 :C.Fd;              # O_PATH dirfd; optional
  limits      @7 :Limits;
  terminal    @8 :C.Fd;              # pty secondary; optional; warden calls setsid+TIOCSCTTY
  session     @9 :C.SessionId;       # new child session id; warden generates if empty
  actorKind   @10 :ActorKind;
  transaction @11 :Text;             # optional strata transaction id (x-…); warden mounts the transaction views over the granted dirs
  enum ActorKind { app @0; service @1; agent @2; legacy @3; bench @4; shell @5; pod @6; }
  attempt     @12 :C.AttemptBinding; #! workflow attempt (§20.25): honoured only from service loom (facet service); warden forwards it
                                     #! unchanged in SessionReg.attempt and never interprets it; set by any other caller: kl:denied
}

struct ExitStatus {
  union {
    exited   @0 :Int32;
    signaled @1 :Int32;
    failedToStart @2 :Text;   # kl:<code> reason
  }
  cpuNanos @3 :UInt64;
  maxRss   @4 :UInt64;
}

interface Process {
  pidfd     @0 () -> (fd :C.Fd);             # kl:unsupported for VM processes
  principal @1 () -> (id :C.PrincipalId);
  wait      @2 () -> (status :ExitStatus);
  signal    @3 (signo :Int32) -> ();         #! delivered to every process of the principal's cgroup
  kill      @4 () -> ();                     # cgroup.kill
  confinement @5 () -> (report :Text);       # JSON confinement report, protocols §9.4
  freeze    @6 () -> ();                     # cgroup.freeze = 1
  thaw      @7 () -> ();                     # cgroup.freeze = 0
}

struct ConnectionInfo {
  peer   @0 :C.PrincipalId;
  facet  @1 :Text;
  tier   @2 :Tier;
  label  @3 :C.Label;          # current session label (from broker)
  generation @4 :C.Ref;
}

interface Supervisor {
  spawn          @0 (spec :SpawnSpec) -> (process :Process);   #! the child's session chain extends the caller's
  identify       @1 (pidfd :C.Fd) -> (id :C.PrincipalId, tier :Tier, generation :C.Ref);
  connectionInfo @2 (connectionId :UInt64) -> (info :ConnectionInfo);
  services       @3 () -> (list :List(ServiceStatus));
  control        @4 (service :Text, op :ServiceOp) -> (status :ServiceStatus);
      #! service "_system" is the pseudo-target for system power: ops poweroff/reboot (facet admin only)
  enum ServiceOp { start @0; stop @1; restart @2; reload @3; poweroff @4; reboot @5; }
}

struct ServiceStatus {
  name       @0 :Text;
  state      @1 :State;
  generation @2 :C.Ref;
  since      @3 :C.Timestamp;
  restarts   @4 :UInt32;
  enum State { inactive @0; starting @1; running @2; stopping @3; failed @4; }
}
```
<!-- END protocols §7.3.2 -->

<!-- BEGIN protocols §7.5.1 (verbatim) -->
> **protocols 7.5.1 `warden-sys.capnp`**

```capnp
@0xc7a1e5d3b2f40020;
using C = import "common.capnp";
using W = import "warden.capnp";
using B = import "broker.capnp";

interface Bootstrap {                  #! bootstrap of fd 3 in every tier-0 service (connection to warden)
  host     @0 (host :ServiceHost) -> ();   # the service registers its ServiceHost; MUST be called first
  ready    @1 () -> ();                    # readiness signal
  watchdog @2 () -> ();                    # liveness ping (interval from the service manifest)
  status   @3 (text :Text) -> ();          # human-readable status line
}

interface ServiceHost {                #! implemented by every tier-0 service; warden is the only caller
  accept @0 (socket :C.Fd, connectionId :UInt64, facet :Text, peer :C.PrincipalId, tier :W.Tier, generation :C.Ref) -> ();
  stop   @1 (reason :Text) -> ();          # cooperative stop before SIGTERM
  reload @2 () -> ();                      # the config generation changed; warden has rebuilt the service's /etc view
}

interface GrantMounts {                # facets broker, bench, compat, portals, cri (idmappedDir only)
  attachGrant @0 (session :C.SessionId, name :Text, tree :C.Fd, readOnly :Bool, ceiling :C.Label) -> (inView :C.Fd, viewPath :Text);
      #! bind-mounts tree (non-recursive, idmapped to the holder's dynamic UID) at /grants/<name> in the holder's mount namespace;
      #! inView = O_PATH fd of the mount root opened through the holder's namespace;
      #! ceiling = the grant's exposure label (§14.1): objects labelled above it are never readable through the mount;
      #! a null ceiling means no enforcement (the caller MUST then have raised the holder to secret/untrusted)
  detachGrant @1 (session :C.SessionId, name :Text) -> ();
  idmappedDir @2 (dir :C.Fd, forPrincipal :C.PrincipalId, readOnly :Bool) -> (tree :C.Fd);
      #! detached idmapped clone (open_tree + mount_setattr MOUNT_ATTR_IDMAP); used by bench/compat for shares
}

enum TerminateMode { kill @0; freeze @1; thaw @2; }

struct PrincipalEvent {
  session   @0 :C.SessionId;
  principal @1 :C.PrincipalId;
  time      @2 :C.Timestamp;
  union {
    spawned @3 :W.Tier;
    exited  @4 :W.ExitStatus;
    frozen  @5 :Void;
    thawed  @6 :Void;
  }
  cgroupId  @7 :UInt64;          # kernel cgroup id of the principal's scope (stable for the session's lifetime)
}

interface PrincipalControl {           # facets broker, admin, hearth (terminate own humans' sessions), strata (events, mountView), cri (pod sessions)
  terminate @0 (session :C.SessionId, mode :TerminateMode) -> ();   #! applies to the session and all descendant sessions
  list      @1 (humanFilter :Text) -> (sessions :List(C.PrincipalId));
  events    @2 (watcher :C.Watcher(PrincipalEvent), replay :Bool) -> (cancel :C.Cancelable);
      #! replay = true: first emits one `spawned` event for every currently running session (visible to the facet), then live events
  mountView @3 (session :C.SessionId) -> (json :Text);               # JCS: [{target, source, flags, grant}]
  fenceWriters @4 (tree :C.Fd, exclude :List(C.SessionId)) -> (fence :WriterFence);
      #! facet strata: freezes every session (except exclude and their descendants) whose view can write inside tree,
      #! and returns once they are frozen; kl:conflict if a writer cannot be frozen (tier-0 service other than strata,
      #! kernel or network filesystem writer); released by WriterFence.release, when the capability is dropped, or after 30 s
}

interface WriterFence {
  sessions @0 () -> (list :List(C.SessionId));   # the frozen sessions
  release  @1 () -> ();                         # thaws them
}

interface ServiceConnect {             # facet broker
  connectService @0 (session :C.SessionId, service :Text, facet :Text) -> (socket :C.Fd);
      #! creates a route for an existing principal; returns the principal-side capwire socket
}

interface FdStore {                    # facet service (each service sees only its own keys)
  store @0 (key :Text, fd :C.Fd) -> ();    #! survives the service's restarts within one boot
  fetch @1 (key :Text) -> (fd :C.Fd);
  drop  @2 (key :Text) -> ();
}

struct LegacyGrant { tree @0 :C.Fd; target @1 :Text; readOnly @2 :Bool; }

struct LegacyView {
  image    @0 :C.Ref;                  # legacy-image generation
  stateDir @1 :C.Fd;                   # per-image writable state (overlay upper + work)
  grants   @2 :List(LegacyGrant);
  netMode  @3 :Text;                   # "none" | "pasta"
}

interface LegacySpawn {                # facet compat
  spawnLegacy @0 (spec :W.SpawnSpec, view :LegacyView, brokerSession :C.SessionId) -> (process :W.Process, notifyFd :C.Fd);
      #! user namespace with a 65 536-UID block, child user.max_user_namespaces=0;
      #! notifyFd = seccomp user-notification listener for the open broker (protocols §9.2);
      #! brokerSession = the per-app open-broker session that gets the read pairing to this app (§9.3)
}

interface UserSpawn {                  # facets launcher (atrium launcher), handler (portal-openuri, portal-notify, portal-background)
  spawnForHuman @0 (spec :W.SpawnSpec, human :Text, initialLabel :C.Label) -> (process :W.Process);
      #! new top-level session under the human's current shell session; label starts at max(default, initialLabel)
}

interface TrustedSpawn {               # facet trusted-terminal (atrium-term only)
  spawnTerminal @0 (spec :W.SpawnSpec, pty :C.Fd) -> (process :W.Process);
      #! actorKind MUST be shell; warden withholds SECBIT_EXEC_DENY_INTERACTIVE for exactly this process tree (§9.3)
}

interface DebugAttach {                # facet broker (materialises Right.debug, §9.3)
  attach @0 (target :Text, scope :Text, debugger :C.Ref, entrypoint :Text, argv :List(Text),
             pty :C.Fd, expiresSecs :UInt32, grantId :Text, requester :C.PrincipalId) -> (process :W.Process);
      #! target "session:s-…" | "gen:fsv256:…"; scope "process" | "kernel"; expiresSecs ≤ 3600 (process), ≤ 900 (kernel);
      #! debugger MUST be a launchable generation whose manifest name is in the policy list debug.debuggers;
      #! warden spawns it as a child of requester's shell session (the human the grant was minted to) with seccomp profile
      #! debug-1 and the ambient capabilities of §9.3, writes kl_debug_pairs, and on expiry or exit removes the pair,
      #! kills the debugger and writes debug.detach
}

struct PodMount {
  tree       @0 :C.Fd;
  target     @1 :Text;
  readOnly   @2 :Bool;
  tmpfsBytes @3 :UInt64;   # 0: bind tree at target; > 0: warden creates a tmpfs of that size at target and copies tree into it
                           #  (configMap, secret, projected and downwardAPI volumes, §21.6)
}

struct PodContext {
  podId        @0 :Text;               # pod-… (§3.5)
  namespace    @1 :Text;
  name         @2 :Text;
  uid          @3 :Text;               # Kubernetes pod UID (metadata)
  netns        @4 :C.Fd;               # pod network namespace created by cri inside the cri network
  sharePid     @5 :Bool;               # shareProcessNamespace
  mounts       @6 :List(PodMount);     # volumes, prepared by cri (strata volumes, projected tmpfs)
  cgroupParent @7 :Text;               # under /keylos.slice/kube.slice/
  seccomp      @8 :Text;               # "baseline-1" | "runtime-default" (baseline-1 ∩ the CRI RuntimeDefault profile)
  readOnlyRoot @9 :Bool;
  runAsUid     @10 :UInt32;            # container-visible UID; mapped through a per-pod mapping-only userns held by warden (idmapped rootfs)
}

interface PodSpawn {                   # facet cri (keylos-sealed runtime class only, §21)
  spawnContainer @0 (spec :W.SpawnSpec, pod :PodContext) -> (process :W.Process);
      #! spec.generation MUST be kind container with an org-publisher genstmt; actorKind pod; tier t1;
      #! the container joins pod.netns and (if sharePid) the pod's pid namespace; no added capabilities, ever;
      #! the root is read-only plus tmpfs at /tmp, /run, /var/tmp and /dev/shm (§21.8)
  execInContainer @1 (spec :W.SpawnSpec, container :C.SessionId) -> (process :W.Process);
      #! CRI Exec/ExecSync: a child session of the container's principal that joins its mount, pid, net, ipc and uts
      #! namespaces and its cgroup; spec.generation MUST equal the container's generation; no added capabilities
  egressShim      @2 (podId :Text) -> (shim :Capability);
      #! a gate-sys ShimEndpoint (§7.5.12) bound to the pod's principals, created by warden as for tier L; cri runs the
      #! pod's egress redirector with it when cluster.egressViaGate is set (§21.5)
}

struct VmPrincipal {
  session       @0 :C.SessionId;
  parentSession @1 :C.SessionId;      # session the VM descends from (agent: the aide-created chain; pod: cri's session)
  principalKind @2 :W.SpawnSpec.ActorKind;   # bench, agent, legacy or pod
  image         @3 :C.Ref;            # bench-image generation
  template      @4 :C.Ref;            # agent-template generation for agent VMs, else empty
  tier          @5 :W.Tier;           # t2 or t3
  offered       @6 :List(C.Token);    #! tokens held by parentSession (e.g. the launching human's), to be attenuated for the VM
  purpose       @7 :Text;             # VmSpec.Purpose enumerant name
  podId         @8 :Text;             # purpose pod only
  checks        @9 :List(Text);       #! Datalog checks (§8.3) the broker appends when attenuating `offered` for this VM (sub-agents: aide narrows the parent's grants)
  budgets       @10 :List(B.Budget);  #! hard sub-meters carved from the offered roots (GateMeterAdmin.carve, §7.5.12) for this VM principal
  attempt       @11 :C.AttemptBinding; #! from VmSpec.attempt / ForkSpec.attempt; forwarded unchanged in SessionReg.attempt
}

interface VmSpawn {                    # facet bench
  register   @0 (vm :VmPrincipal) -> (principal :C.PrincipalId, cgroupId :UInt64, tokens :List(C.Token));
      #! creates the VM principal (dynamic UID, cgroup scope, BrokerSystem.registerSession); the actor follows §3.4
      #! (agent: "agent:" + template; pod: "pod:…"; otherwise "<kind>:" + image); tokens are those the broker issued
  spawnVmm   @1 (session :C.SessionId, spec :W.SpawnSpec) -> (process :W.Process);
      #! spawns crosvm, its device processes, bench-net and bench-relay inside the VM principal's cgroup;
      #! spec.generation MUST be the bench generation; warden wires bench-net to gate#shim and bench-relay to
      #! aide#host (agent VMs), broker#principal, vault#app and portal-*#default for that principal
  unregister @2 (session :C.SessionId) -> ();   # after the last VMM process of the principal exited
}
```
<!-- END protocols §7.5.1 -->

<!-- BEGIN protocols §7.3.3 (verbatim) -->
> **protocols 7.3.3 `broker.capnp`**

```capnp
@0xc7a1e5d3b2f40003;
using C = import "common.capnp";

struct NetTarget {
  host    @0 :Text;            # DNS name or IP literal; "listen:<addr>" requests a listening socket (§7.3.7)
  port    @1 :UInt16;
  proto   @2 :Proto;
  methods @3 :List(Text);      # HTTP methods, empty = protocol-level grant only
  enum Proto { tcp @0; udp @1; https @2; }
}

struct Budget { unit @0 :Text; amount @1 :Int64; }   # unit: "usd-micro", "tokens", "calls"

struct ResourceRef {
  union {
    path      @0 :Text;          # resolved by broker with openat2(RESOLVE_BENEATH) from a held root
    dirFd     @1 :C.Fd;          # caller already holds it; request attenuation/annotation
    net       @2 :NetTarget;
    device    @3 :Text;          # device id, protocols §3.5
    secret    @4 :Text;          # vault item name (caller-scoped)
    budget    @5 :Budget;
    spawn     @6 :C.Ref;         # right to spawn a generation
    service   @7 :Text;          # "name#facet"
    effect    @8 :Text;          # effect kind, e.g. "email.send"
    delegate  @9 :Void;          # right to create sub-principals
    principal @10 :DebugTarget;  # debug target (Right.debug), §9.3
    screen    @11 :Text;         # "window:<atrium window id>": one still snapshot of a real-session window (Right.read), §14.5
    model     @12 :Text;         # "<provider>/<model>@<version>": re-approval of an agent session's model after drift (Right.use), §14.5
  }
}

struct DebugTarget {
  target  @0 :Text;              # "session:s-…" (a running session and its descendants) or "gen:fsv256:…" (any instance of a generation of the requesting human)
  scope   @1 :Scope;
  enum Scope { process @0; kernel @1; }   #! kernel: bpftrace-class tracing, presence-only, ≤ 900 s
}

enum Right { read @0; write @1; create @2; delete @3; exec @4; connect @5; bind @6; use @7; spend @8; spawn @9; stage @10; commit @11; delegate @12; debug @13; }

struct GrantRequest {
  resource     @0 :ResourceRef;
  rights       @1 :List(Right);
  reason       @2 :Text;         # shown to the human
  durationSecs @3 :UInt32;       # 0 = policy default
  persist      @4 :Bool;         # request a persistent grant (survives session and reboot; needs presence)
  onBehalfOf   @5 :C.PrincipalId; # informational only (vault, depot, strata, atrium via requestFor): the principal the service acts for;
                                  #! shown on the prompt and recorded in receipts; never used for authorization
}

struct GrantOutcome {
  union {
    granted @0 :C.Token;
    pending @1 :Approval;
    denied  @2 :Text;
  }
}

interface Approval {
  id      @0 () -> (id :Text);
  wait    @1 () -> (outcome :GrantOutcome);
  cancel  @2 () -> ();
  mandate @3 () -> (mandate :Data);   #! DSSE keylos.mandate/1 after approval; kl:not-found before or if denied
}

struct Handle {
  union {
    fd      @0 :C.Fd;            # file, dirfd (O_PATH), device, memfd
    socket  @1 :C.Fd;            # connected socket (usually to gate) or capwire socket to a service
    cap     @2 :Capability;      # service capability
  }
}

interface Broker {
  request     @0 (req :GrantRequest) -> (outcome :GrantOutcome);
  materialize @1 (token :C.Token, resource :ResourceRef, rights :List(Right)) -> (handle :Handle);
  attenuate   @2 (token :C.Token, checks :List(Text)) -> (token :C.Token);  #! Datalog checks, protocols §8.3
  delegate    @3 (tokens :List(C.Token), child :C.SessionId, checks :List(Text)) -> (tokens :List(C.Token));
  revoke      @4 (rootId :Data) -> ();
  inspect     @5 (token :C.Token) -> (facts :List(Text), expires :C.Timestamp, rootId :Data);
  label       @6 () -> (label :C.Label);
  raiseLabel  @7 (label :C.Label, reason :Text) -> (label :C.Label);  #! raises the CALLER's session label only; labels only go up
  powerbox    @8 (req :PowerboxRequest) -> (grants :List(PowerboxGrant));
  myGrants    @9 () -> (tokens :List(C.Token));
  debug       @10 (token :C.Token, debugger :C.Ref, entrypoint :Text, argv :List(Text), pty :C.Fd) -> (process :Capability);
      #! materialises a Right.debug grant through warden DebugAttach (§7.5.1); returns a warden.Process
}

struct PowerboxRequest {
  kind     @0 :Kind;
  title    @1 :Text;
  mimeTypes @2 :List(Text);
  multiple @3 :Bool;
  suggestedName @4 :Text;
  enum Kind { openFile @0; openDirectory @1; saveFile @2; }
}

struct PowerboxGrant {
  fd    @0 :C.Fd;        # opened file, or O_PATH dirfd usable in the holder's view (attached via GrantMounts, §7.5.1)
  token @1 :C.Token;     # token describing the grant (for persistence / delegation)
  displayName @2 :Text;
  viewPath @3 :Text;     # path of the grant inside the holder's view (/grants/<name>), for path-expecting code
}
```

**Directory grants and Landlock.** A Landlock domain cannot be widened after `restrict_self`. A directory granted at runtime is therefore made reachable by `warden` attaching a bind mount at `/grants/<name>` inside the holder's mount namespace (`GrantMounts.attachGrant`, §7.5.1), whose subtree is covered by the Landlock rule the view was built with (`/grants` is allowed at spawn with the access rights of the highest possible grant; actual access is bounded by mount flags and the attached tree). `materialize` of a path or dirFd grant returns an fd opened **through that mount**.

**Directory grant ceilings.** Every directory grant has an **exposure label** (its ceiling, §14.1). The broker raises the holder's session label to the ceiling **before** the mount is attached, and passes the ceiling to `attachGrant`; `warden` then refuses, for the grant's lifetime, every open of an object through that mount (and every read through an fd opened through it) whose label exceeds the ceiling or is malformed (§9.3). Grant trees are non-recursive bind mounts: mounts nested below the granted directory are not reachable through the grant.

**Single-file grants.** A file picked for a path-expecting client is never exposed by attaching its parent directory. It is exposed as a **single-file view** `/grants/<name>/<basename>`: a directory served by `portal-files` that contains only the selected file and the holder's own temporary files. Writes follow the granted rights (a read-only grant refuses every write); a safe-save `rename(<temporary> → <basename>)` is carried out by `portal-files` as an atomic replace of the selected file in its real parent, whose dirfd `portal-files` holds and never exposes; every other name is refused. Access to the parent or any sibling needs an explicit `openDirectory` consent. Remembered grants, re-materialization, revocation and drag-and-drop keep the same single-file scope.
<!-- END protocols §7.3.3 -->

<!-- BEGIN protocols §7.5.2 (verbatim) -->
> **protocols 7.5.2 `broker-sys.capnp`**

```capnp
@0xc7a1e5d3b2f40021;
using C = import "common.capnp";
using B = import "broker.capnp";
using P = import "prompt.capnp";

struct SessionReg {
  child    @0 :C.PrincipalId;
  parent   @1 :C.SessionId;        # empty for warden-originated system services
  offered  @2 :List(C.Token);
  onRevoke @3 :Text;               # "kill" | "freeze"
  budgets  @4 :List(B.Budget);     #! hard sub-budget ceilings for the child (VmPrincipal/ForkSpec budgets): the broker carves each from
                                   #! the matching offered root (GateMeterAdmin.carve) before issuing tokens; kl:budget if a parent meter is short
  attempt  @5 :C.AttemptBinding;   #! workflow attempt (§20.25): verified against the broker's workflow record (claimed epoch, attempt,
                                   #! allowed generation and spawner); the child's label and tokens then come from that record (§7.5.25)
}

struct SessionRegResult {
  tokens    @0 :List(C.Token);
  label     @1 :C.Label;
  tierFloor @2 :UInt8;             # 0..4 = t0..legacy
}

struct FlowCheck {
  session       @0 :C.SessionId;
  kind          @1 :Text;          # effect kind or "net"
  target        @2 :Text;
  payloadDigest @3 :C.Digest;
  rendered      @4 :List(P.RenderedEffect);
  provenance    @5 :List(P.ArgProvenance);
  flowProof     @6 :Data;          # optional DSSE keylos.flowproof/1 (§20.11)
  intent        @7 :Text;          # e-… id of the staged intent; empty for connect-time "net" checks
}

struct GrantResult {
  outcome @0 :B.GrantOutcome;
  mandate @1 :Data;                # DSSE keylos.mandate/1 when the outcome was decided by approval; empty otherwise.
                                   #! presence-signed when presence was required; otherwise signed by service/broker (§14.4)
}

struct PodAdmission {
  allowed   @0 :Bool;
  reasons   @1 :List(Text);        # forbid/permit policy ids and failed checks
  tierFloor @2 :UInt8;             # 1 = keylos-sealed allowed, 2 = keylos-vm required
  approval  @3 :Text;              # a-… when an @tier/@orgApproval permit applies (pods wait for it)
}

interface BrokerSystem {           # facet system
  registerSession    @0 (reg :SessionReg) -> (result :SessionRegResult);           # warden
  sessionEnded       @1 (session :C.SessionId, exitText :Text) -> ();              # warden
  checkFlow          @2 (check :FlowCheck) -> (result :GrantResult);               # gate: Rule of Two at stage/commit/connect
  requestFor         @3 (subject :C.SessionId, req :B.GrantRequest, intent :Text, idempotencyKey :Text,
                          intentSession :C.SessionId, decidedOnTrustedPath :Bool) -> (result :GrantResult);
      #! approval request on behalf of a subject session (intent = e-… id or empty). Allowed subjects per caller:
      #! gate → sessions that staged the intent (intentSession = the staging session when it differs from subject);
      #! aide → its agent sessions; strata, depot, vault, atrium → only their own session (atrium: device authorization).
      #! The broker deduplicates by (caller, idempotencyKey) for 24 h: a repeated call returns the same approval/result.
      #! decidedOnTrustedPath: atrium only (device authorization): the human already decided on atrium's trusted-path card;
      #! the broker evaluates policy, records approval.decide with channel "local" and returns the mandate without
      #! prompting again. MUST be false (else kl:invalid) for every other caller or when policy requires presence.
  registerApprover   @4 (publicKey :Data, alg :Text, channel :Text) -> ();         # atrium ("local") and vouchd ("phone"), once per boot
  registerSessionKey @5 (session :C.SessionId, publicKey :Data) -> ();             # aide: agent session key (flow proofs, commits)
  annotateRequest    @6 (session :C.SessionId, provenanceJson :Text) -> ();        # aide: provenance hints for the next request
  rootsChanged       @7 (fdkeys :List(Text)) -> ();                                # strata: re-open held roots after rollback
  revokeSession      @8 (session :C.SessionId, mode :Text) -> ();                  # hearth (lock/logout), warden
  loadPolicy         @9 (generation :C.Ref) -> ();                                 # config: activate a policy generation
  validatePolicy     @10 (tree :C.Fd) -> (ok :Bool, problems :List(Text));         # config: dry-run a candidate policy tree
  mintCaptive        @11 (session :C.SessionId) -> (token :C.Token);               # net: captive-portal token (§8.2 captive fact)
  admitPod           @12 (podSpecJson :Text, runtimeClass :Text) -> (admission :PodAdmission);
      #! cri: Cedar evaluation of action "admit" on a PodSpec entity (§16, §21.3); podSpecJson is the CRI PodSandboxConfig
      #! plus container configs, normalised by cri to keylos.podspec/1 (§21.3)
}

interface LabelAuthority {         # facet label-authority
  labelOf  @0 (session :C.SessionId) -> (label :C.Label);
  raiseFor @1 (session :C.SessionId, label :C.Label, reason :Text) -> (label :C.Label);   #! labels only go up; receipt label.raise
}
```

`registerApprover.publicKey` is a DER SubjectPublicKeyInfo; other encodings fail `kl:invalid`. A method whose receipt must be written before it replies (§19.3) answers `kl:unavailable` while the serving component's own `ledger.key.register` has not been appended; the broker registers its key before it serves facet `system`.
<!-- END protocols §7.5.2 -->

<!-- BEGIN protocols §7.3.4 (verbatim) -->
> **protocols 7.3.4 `prompt.capnp` (trusted path; implemented by `atrium`, used by `broker`, `hearth`, `vault`, `config`, `depot`, `fleet`, `vouch`)**

```capnp
@0xc7a1e5d3b2f40004;
using C = import "common.capnp";

enum ApprovalTier { t0 @0; t1 @1; t2 @2; t3 @3; }

struct RenderedEffect {
  kind      @0 :Text;            # e.g. "email.send", "fs.merge", "config.apply"
  title     @1 :Text;
  body      @2 :Text;            # plain text or sanitized markdown
  mime      @3 :Text;            # "text/plain" | "text/markdown" | "text/x-diff" | "image/png"
  attachment @4 :C.Fd;           # optional large rendering (diff, preview)
  reversible @5 :Bool;
  review     @6 :Review;          #! required (default): approval is enabled only when this rendering was presented completely (§14.3)
  payloadDigest @7 :C.Digest;     #! digest of the mandate-draft effect this rendering presents (sha256)
  enum Review { required @0; decorative @1; }   #! decorative: optional preview; set only by gate or broker, never by a requester
}

struct ArgProvenance {
  argument @0 :Text;
  source   @1 :Text;             # e.g. "web:https://example.com/page", "file:/home/…", "user"
  label    @2 :C.Label;
}

struct ApprovalPrompt {
  id         @0 :Text;
  tier       @1 :ApprovalTier;
  principal  @2 :C.PrincipalId;
  summary    @3 :Text;
  effects    @4 :List(RenderedEffect);
  provenance @5 :List(ArgProvenance);
  mandateDraft @6 :Data;          # JCS payload of the mandate to be signed if approved
  requiresPresence @7 :Bool;      # FIDO2 touch required
  expires    @8 :C.Timestamp;
  channels   @9 :List(Text);      # approval channels allowed for this prompt ("local", "phone", "org"), §14.3; empty = ["local"]
  requester  @10 :Text;           # for family machines: the non-owner human on whose behalf an owner is asked (§14.3); empty otherwise
}

struct Decision {
  approved @0 :Bool;
  scope    @1 :Scope;
  mandate  @2 :Data;              # DSSE envelope (presence-signed when requiresPresence, else signed by the atrium approver key)
  note     @3 :Text;
  enum Scope { once @0; session @1; persistent @2; }
}

interface TrustedPrompt {
  approve  @0 (prompt :ApprovalPrompt) -> (decision :Decision);
  presence @1 (purpose :Text, payload :Data, rendering :List(RenderedEffect)) -> (envelope :Data);
      # DSSE signed by owner-presence (§5.3), rendered on the trusted path; rendering (optional) is shown
      # alongside the statement (for example a config plan diff) and its digests are displayed for cross-checking
  notify   @2 (title :Text, body :Text, severity :Severity) -> ();
  secret   @3 (title :Text, body :Text, confirm :Bool) -> (secret :C.Fd);
      #! secret entry on the trusted path (recovery key, trustee card, new PIN, passphrase); confirm = enter twice;
      #! the value is returned in the delivery format of §20.10; facet secret only
  enum Severity { info @0; warning @1; critical @2; }
}
```

**Required review material.** Every `RenderedEffect` is `review = required` unless `gate` or `broker` marked it `decorative`; a requester can never make a rendering optional, and an unknown or absent value means `required`. The trusted path (local prompts, presence cards, phone, org and quorum review) enables approval only when every required rendering was presented **completely**: its `payloadDigest` equals the digest of the mandate-draft effect it presents, it carries all required review details of its effect kind (§14.2), and nothing required is missing, malformed, unsupported or truncated beyond the channel's review limits. When a decoder or renderer crashes or times out, a canonical-text fallback produced by `gate` may replace the rendering only if it presents every required detail within the limits; otherwise the effect can only be denied or deferred. A title or a digest alone never substitutes for required details. A channel that cannot present the required material (for example a phone over its size limit) does not offer the approval: it stays pending for a capable channel or expires and is denied under its normal lifecycle (§14.3).

**Secret entry.** `TrustedPrompt.secret` (facet `secret`: `hearth` for recovery keys, trustee cards, new PINs and passphrases; `vault` for import passphrases) asks for a secret on the trusted path and returns it in the delivery format of §20.10; the value never passes through the requesting app.
<!-- END protocols §7.3.4 -->

<!-- BEGIN protocols §7.3.5 (verbatim) -->
> **protocols 7.3.5 `ledger.capnp`**

```capnp
@0xc7a1e5d3b2f40005;
using C = import "common.capnp";

struct ReceiptRef { seq @0 :UInt64; digest @1 :C.Digest; }

struct Checkpoint { note @0 :Text; }   #! C2SP signed-note checkpoint text, protocols §13.3

struct Filter {
  principalPrefix @0 :Text;
  sessionId  @1 :Text;
  eventTypes @2 :List(Text);
  since      @3 :C.Timestamp;
  until      @4 :C.Timestamp;
  limit      @5 :UInt32;
  fromSeq    @6 :UInt64;          # 0 = from the start; only receipts with seq ≥ fromSeq (continuation: fromSeq = query's next)
}

interface Ledger {
  append     @0 (envelope :Data) -> (ref :ReceiptRef);     #! facet "writer" only
  get        @1 (seq :UInt64) -> (envelope :Data);
  query      @2 (filter :Filter) -> (envelopes :List(Data), next :UInt64);
  checkpoint @3 () -> (checkpoint :Checkpoint);
  prove      @4 (seq :UInt64, treeSize :UInt64) -> (hashes :List(Data));   # RFC 6962 inclusion proof
  consistency @5 (from :UInt64, to :UInt64) -> (hashes :List(Data));
  watch      @6 (filter :Filter, watcher :C.Watcher(Data)) -> (cancel :C.Cancelable);
  serviceKey @7 (service :Text) -> (spki :Data, keyRef :Text, registered :C.Timestamp);
      #! facet reader: the currently registered key of service/<service> (from ledger.key.register); kl:not-found if none.
      #! Relying services use it to verify service-signed records, e.g. non-presence mandates signed by service/broker (§14.4)
}
```

**Read access** (facet `reader`; `writer` includes it): a principal sees receipts whose `subject` or `writer` is itself or a descendant session; a `shell` principal sees every receipt whose subject's human is its human; agent principals see only their own session chain; tier-0 services see receipts per their facet entry in §19.2, and every writer service sees every receipt whose `writer` actor is its own service name under any session and generation (`service:<name>:…`, also from earlier boots), so it can reconcile its own submissions (§20.25); `fleet` (facet `fleet-export`) sees metadata only, unless an owner exception of kind `fleet-receipt-access` (§20.9) lists the event type. Sealed payloads (§13.4) are decrypted for a reader only if the reader may read the receipt **and** the unit key still exists; receipts of crypto-shredded units are returned redacted (`keylos.receipt-redacted/1`). The returned form of a decrypted sealed receipt is defined in §13.4. `query` returns matching visible receipts in increasing `seq`, at most `limit`; `next` is the `seq` of the first matching visible receipt that was not returned (0 = none), and a client continues with the same filter and `fromSeq = next`. `watch` ignores `fromSeq`. Facet `vouch-heartbeat` (vouchd) sees only the metadata (time, subject human) of `user.login` receipts of every human, for the inheritance dead-man timer (§20.19).
<!-- END protocols §7.3.5 -->

<!-- BEGIN protocols §7.5.4 (verbatim) -->
> **protocols 7.5.4 `vault-sys.capnp`**

```capnp
@0xc7a1e5d3b2f40023;
using C = import "common.capnp";

struct SlotSpec { kind @0 :Text; factor @1 :C.Fd; params @2 :Text; }
  # kind: password | fido2 | recovery. recovery: factor absent (index 0xFFFF); vault wraps the user key with HPKE to the
  # recovery recipient public key (§20.21), so the slot can be created without knowing the recovery key

interface VaultUsers {             # facet hearth
  createUser @0 (user :Text, slots :List(SlotSpec)) -> (slotIds :List(Text));
  unlockUser @1 (user :Text, slotId :Text, factor :C.Fd) -> ();
  lockUser   @2 (user :Text) -> ();
  addSlot    @3 (user :Text, slot :SlotSpec) -> (slotId :Text);
  removeSlot @4 (user :Text, slotId :Text) -> ();
  deleteUser @5 (user :Text) -> ();
  slots      @6 (user :Text) -> (json :Text);
}
```

**Slots.**
- `SlotSpec.params` is JCS JSON; binary members are standard base64 (§5.1). `password`: `{"alg": "argon2id", "m", "t", "p", "salt", "prehashed"}`, where `prehashed: true` is allowed only at creation (the factor is then the 32-byte raw Argon2id output, as at first boot); every later password or PIN factor is the raw UTF-8 secret and the vault runs Argon2id with the stored parameters. `fido2`: `{"credentialId", "rpId": "keylos.login", "salt1"}`, factor = the `hmac-secret` output. `recovery`: `{}` from `hearth` (the vault adds `ephemeralPublic`).
- The vault creates a recovery slot only when `slots` contains a `recovery` SlotSpec; `hearth` adds one according to its `hearth.recoverySlots` setting (`owners` by default, `all`, `none`).
- A guest user (`guest-…`, §3.3) is created with an empty slot list, exactly.
- `addSlot` and `removeSlot` require the user unlocked (`kl:unavailable:user-locked`).
<!-- END protocols §7.5.4 -->

<!-- BEGIN protocols §7.5.7 (verbatim) -->
> **protocols 7.5.7 `strata-sys.capnp`**

```capnp
@0xc7a1e5d3b2f40026;
using C = import "common.capnp";
using S = import "strata.capnp";

enum Choice { ours @0; theirs @1; merged @2; }

interface TransactionExt {
  policy            @0 () -> (networkPolicy :S.NetworkPolicy, views :List(Text));   # view paths for warden mounting
  resolve           @1 (path :Text, choice :Choice, merged :C.Fd) -> ();
  changeSet         @2 () -> (jcs :C.Fd, digest :C.Digest);                         # keylos.changeset/1
  commitWithMandate @3 (mandate :Data) -> (snapshot :Text);                         #! superseded before release by prepare + PreparedMerge.commit: MUST return kl:unsupported
  pin               @4 (pinned :Bool) -> ();
  owner             @5 () -> (session :C.SessionId);                                # session that began the transaction
  prepare           @6 () -> (prepared :PreparedMerge);
      #! freezes the views, captures the live state of every affected path, applies recorded resolutions and clean three-way
      #! merges, and stores the result as an immutable prepared merge (§20.12 keylos.fsmerge/2); kl:conflict while conflicts remain
  bindWorkflow      @7 (binding :C.AttemptBinding) -> ();
      #! facets bench, aide: the transaction (and every prepared merge of it) is owned by binding.workflow from now on (§20.25);
      #! strata verifies the binding for the transaction's owner session with BrokerWorkflow.verify; idempotent; kl:conflict if
      #! the transaction is already bound to another workflow
}

interface PreparedMerge {
  id       @0 () -> (id :Text);                                  # pm-… (§3.5)
  manifest @1 () -> (jcs :C.Fd, digest :C.Digest);               # keylos.fsmerge/2; digest = the fs.merge payload digest
  diff     @2 (path :Text) -> (diff :C.Fd);                      # unified diff of the stored result ("" = whole merge)
  commit   @3 (mandate :Data) -> (snapshot :Text);
      #! verifies the mandate binds digest, takes a writer fence (PrincipalControl.fenceWriters), revalidates every expectedLive
      #! entry and applies exactly the stored operations (no new merge, no overlay read); stale live state → kl:conflict
  discard  @4 () -> ();
  status   @5 () -> (state :Text, transaction :Text, snapshot :Text);
      #! durable completion record: state "prepared" | "committed" | "discarded" | "stale"; for "committed" the commit's
      #! transaction id and pre-commit (undo) snapshot. Retained at least until the owning workflow's horizon (§20.25)
}

interface StrataTxn {              # facets user, bench, aide, cli, warden
  txnExt @0 (id :Text) -> (txn :S.Transaction, ext :TransactionExt);
      #! user/bench/aide/cli: only transactions begun by the caller (or its session ancestors).
      #! warden: any; warden MUST check that the spawner's session equals owner() or descends from it before mounting views
  prepared @1 (id :Text) -> (prepared :PreparedMerge);
      #! user/bench/aide/cli: prepared merges of the caller's own transactions (same ownership rule as txnExt); not on facet warden
  preparedFor @2 (id :Text, binding :C.AttemptBinding) -> (prepared :PreparedMerge);
      #! facets bench, aide: a prepared merge of a transaction bound to binding.workflow (bindWorkflow), for a fresh attempt of that
      #! workflow that does not descend from the session that prepared it; strata verifies the binding is current
      #! (BrokerWorkflow.verify); a stale or foreign binding: kl:not-found
}

struct UnitInfo { id @0 :Text; alias @1 :Text; mode @2 :Text; subvolumes @3 :List(Text); mounted @4 :Bool; backend @5 :Text; }
struct SubvolInfo { uuid @0 :Text; path @1 :Text; kind @2 :Text; human @3 :Text; owner @4 :Text; unit @5 :Text; snapshotClass @6 :Text; backupClass @7 :Text; }
struct BackupStatus { target @0 :Text; lastRun @1 :C.Timestamp; lastResult @2 :Text; lastRestoreTest @3 :C.Timestamp; nextRun @4 :C.Timestamp; }

interface StrataAdmin {            # facet admin; mountUnit also on facet warden; lockUnits/unlockUnits also on facet hearth; preUpdate also on facet courier
  subvolumes      @0 (human :Text) -> (list :List(SubvolInfo));
  createSubvolume @1 (parent :C.Fd, name :Text, kind :Text, owner :Text) -> (info :SubvolInfo);
  deleteSubvolume @2 (uuid :Text) -> ();
  units           @3 () -> (list :List(UnitInfo));
  mountUnit       @4 (unit :Text) -> (view :C.Fd);       # detached mount fd of the plaintext view
  lockUnits       @5 (human :Text) -> ();
  unlockUnits     @6 (human :Text) -> ();
  pin             @7 (snapshot :Text, pinned :Bool) -> ();
  deleteSnapshot  @8 (snapshot :Text) -> ();
  backupNow       @9 (target :Text) -> (run :Text);
  backups         @10 () -> (list :List(BackupStatus));
  status          @11 () -> (json :Text);
  preUpdate       @12 (reason :Text) -> (set :Text);      # snapshot set before an OS update
}

interface StrataHomes {            # facet hearth
  createHome @0 (user :Text, uid :UInt32) -> (info :SubvolInfo);
  deleteHome @1 (user :Text, forget :Bool) -> ();
  createEphemeralHome @2 (user :Text, uid :UInt32) -> (info :SubvolInfo);   # guest sessions: not snapshotted, ephemeral unit key
}

interface StrataVolumes {          # facet cri
  create  @0 (podId :Text, name :Text, kind :Text, sizeBytes :UInt64) -> (dir :C.Fd);
      #! kind "emptyDir" (subvolume, deleted with the pod) | "local" (local PersistentVolume, kept until release);
      #! dir is an O_PATH fd; sizeBytes is enforced without qgroups: strata scans usage every 30 s and reports
      #! over-limit volumes in usage(), and cri evicts the pod (Kubernetes ephemeral-storage semantics)
  release @1 (podId :Text, name :Text) -> ();
  usage   @2 (podId :Text) -> (json :Text);
}
```

On facet `gate`, strata serves `Strata.undo` only, for transactions that were committed by an `fs.merge` intent whose compensation `gate` executes (§14.2).
<!-- END protocols §7.5.7 -->

<!-- BEGIN protocols §7.3.15 (verbatim) -->
> **protocols 7.3.15 `net.capnp`, `devd.capnp`, `journal.capnp`, `portals.capnp`, `compat.capnp`**

```capnp
@0xc7a1e5d3b2f40015;   # net.capnp
using C = import "common.capnp";
struct Link { name @0 :Text; kind @1 :Text; state @2 :Text; addresses @3 :List(Text); metered @4 :Bool; }
struct WifiNetwork { ssid @0 :Text; security @1 :Text; signal @2 :Int16; known @3 :Bool; }
interface Net {
  links     @0 () -> (list :List(Link));
  wifiScan  @1 () -> (list :List(WifiNetwork));
  wifiJoin  @2 (ssid :Text, credential :C.Fd) -> ();    #! facet user only; credential stored via vault
  vpnUp     @3 (profile :Text) -> ();                   #! facet user only
  vpnDown   @4 (profile :Text) -> ();                   #! facet user only
  resolve   @5 (name :Text) -> (addresses :List(Text), dnssec :Bool);
  time      @6 () -> (synced :Bool, offsetNanos :Int64, source :Text);
  status    @7 () -> (json :Text);
}
```

```capnp
@0xc7a1e5d3b2f40016;   # devd.capnp
using C = import "common.capnp";
struct Device { id @0 :Text; subsystem @1 :Text; name @2 :Text; properties @3 :List(C.KeyValue); }
interface Devd {
  list   @0 (subsystem :Text) -> (list :List(Device));
  open   @1 (id :Text, token :C.Token, flags :UInt32) -> (fd :C.Fd);   # facet broker; callers use broker.materialize
  watch  @2 (subsystem :Text, watcher :C.Watcher(Device)) -> (cancel :C.Cancelable);
  power  @3 (op :Text) -> ();                                         # "suspend" | "poweroff" | "reboot" (hibernate: kl:unsupported)
}
```

```capnp
@0xc7a1e5d3b2f40017;   # journal.capnp
using C = import "common.capnp";
struct Entry { time @0 :C.Timestamp; principal @1 :C.PrincipalId; level @2 :UInt8; message @3 :Text; fields @4 :List(C.KeyValue); }
interface Journal {
  writer @0 () -> (stream :C.Fd);                                  # SOCK_SEQPACKET, protocols §10.6 record format; attributed to the caller
  query  @1 (filterJson :Text, limit :UInt32) -> (entries :List(Entry), cursor :Text);
  follow @2 (filterJson :Text, watcher :C.Watcher(Entry)) -> (cancel :C.Cancelable);
}
```

```capnp
@0xc7a1e5d3b2f40018;   # portals.capnp
using C = import "common.capnp";
struct CaptureStream { nodeId @0 :UInt32; width @1 :UInt32; height @2 :UInt32; sourceDescription @3 :Text; }
interface ScreenCapture { start @0 (kind :Text) -> (streams :List(CaptureStream), remote :C.Fd); }   # remote = PipeWire remote fd restricted to the nodes
interface Camera        { open @0 () -> (remote :C.Fd); }
interface Microphone    { open @0 () -> (remote :C.Fd); }
interface OpenUri       { open @0 (uri :Text) -> (); openFile @1 (file :C.Fd) -> (); }
interface NotifyHandler { activated @0 (id :UInt32, action :Text) -> (); }
interface Notify        { post @0 (title :Text, body :Text, actions :List(Text), handler :NotifyHandler) -> (id :UInt32); close @1 (id :UInt32) -> (); }
  #! handler is optional; when null, activation spawns the app's "notify-action" entrypoint with the action id as argv[1]
interface Print         { print @0 (document :C.Fd, mime :Text, optionsJson :Text) -> (jobId :Text); }
interface Clipboard     { read @0 (mime :Text) -> (data :C.Fd); write @1 (mime :Text, data :C.Fd) -> (); }
interface Location      { current @0 (accuracy :Text) -> (lat :Float64, lon :Float64, accuracyM :Float64); }
interface Accessibility { observe @0 () -> (observer :Capability); }    # returns an A11yObserver (§7.5.17); assistive-tech principals only
struct ServiceInstance { name @0 :Text; type @1 :Text; host @2 :Text; port @3 :UInt16; addresses @4 :List(Text); txt @5 :List(C.KeyValue); }
interface Discovery {                                                    # portal-discovery (mDNS / DNS-SD)
  browse  @0 (serviceType :Text, watcher :C.Watcher(ServiceInstance)) -> (cancel :C.Cancelable);   #! results raise the caller's label to integ untrusted
  publish @1 (instance :Text, serviceType :Text, port :UInt16, txt :List(C.KeyValue)) -> (handle :C.Cancelable);
      #! requires a listen grant for port (needs.listen scope lan) and a publish grant; on the local link only
}
struct ScanOptions { resolutionDpi @0 :UInt16; mode @1 :Text; source @2 :Text; format @3 :Text; }   # mode: color|gray|lineart; format: png|pdf|jpeg
interface Scan {                                                         # portal-scan (SANE backends in a compat island)
  scanners @0 () -> (list :List(Text));
  scan     @1 (scanner :Text, options :ScanOptions) -> (image :C.Fd);    #! trusted-path confirmation per scan; result labelled public/user
}
```

```capnp
@0xc7a1e5d3b2f40019;   # compat.capnp
using C = import "common.capnp";
using W = import "warden.capnp";
interface Compat {
  importImage @0 (source :Text) -> (generation :C.Ref);   # "oci://…", "flatpak://remote/ref", "distro:<name>:<release>", "rootfs:<dirfd>"
  run         @1 (generation :C.Ref, argv :List(Text), fds :List(W.FdMapping), grants :List(C.Token)) -> (process :W.Process);
}
```
<!-- END protocols §7.3.15 -->

#### 2.2.5 Profiles, approval rules, owner seal, config statements and layout

<!-- BEGIN protocols §2.2 (verbatim) -->
> **protocols 2.2 Profiles and integrity profiles**

A machine runs exactly one **profile** (chosen at install, recorded in the first-boot bundle and the boot report) and has exactly one **integrity profile** (derived at every boot, shown in status, in the boot report and in the `vouch` verdict).

| Profile | Use | Notes |
|---|---|---|
| `desktop`, `laptop` | Interactive machines | atrium, portals, presence by touch |
| `server` | Headless | No atrium; presence by **quorum** (§5.4); serial-console recovery with the recovery key |
| `server-k8s` | Kubernetes node | `server` + `cri`, `kubelet`, `kube-proxy` (§21) |
| `cloud` | VM image in a public or private cloud | vTPM (provider EK chains in the attestation trust store); confidential VMs (SEV-SNP, TDX) supported, SVSM vTPM preferred; first-boot bundle from the metadata service (§20.13); quorum presence |
| `kiosk` | Single-app appliance | Autologin to one app principal; atrium kiosk mode; trusted path still present for owners |
| `appliance` | Fixed-function device | As `server`, without `bench` |

| Integrity profile | Condition |
|---|---|
| `full` | Owner-controlled Secure Boot keys (no Microsoft CAs in db), TPM 2.0, IOMMU, every check passes |
| `shared-boot` | `secureboot.keepMicrosoftCAs = true` (dual boot): the Microsoft Windows and third-party UEFI CAs are in db. Bitpixie-class downgrade risk is mitigated by TPM+PIN, the signed PCR11 policy and the NV release floor, and is documented |
| `shim` | Booted through shim + MOK (no custom-key Secure Boot available) |
| `cloud-vtpm` | `cloud` profile with a provider vTPM and no confidential-VM report |
| `cvm` | `cloud` profile in a confidential VM whose report is verified together with the TPM quote |
| `degraded` | No TPM, or Secure Boot off; no sealing, no VBU, persistent warning |
<!-- END protocols §2.2 -->

<!-- BEGIN protocols §10.7 (verbatim) -->
> **protocols 10.7 Cross-repository files**

A repository MAY read a file written by another repository **only if the file is listed here**; everything else is that repository's private state.

| Path | Format | Writer | Readers |
|---|---|---|---|
| `/run/keylos/boot/trust.json`, `report.json` | `keylos.boottrust/1`, `keylos.bootreport/1` (§20.1) | boot | any tier-0 service, `vouch` tooling |
| `/etc/keylos/services.json` | `keylos.services/1` (§20.16) | config | warden, boot, ledger |
| `/etc/keylos/policy.ref` | `keylos.policyref/1` (§20.17) | config | warden, broker |
| `/etc/keylos/owner-seal/<i>.spki` | DER SubjectPublicKeyInfo | config | boot |
| `/etc/keylos/publishers.json` | `keylos.publishers/1` (§20.20) | config | boot, depot |
| `/etc/keylos/exceptions/*.dsse` | `keylos.exception/1` envelopes (§20.9) | config | depot, ledger, warden (effective tiers) |
| `/etc/keylos/strata/snapshot-exclude.list` | newline-separated absolute paths | config | strata, vault |
| `/etc/keylos/app-visible.list` | newline-separated paths under `/etc` | config | warden |
| `/store/evidence/<hex>/statement.dsse` | `keylos.genstmt/1` envelope (§20.7), `<hex>` = generation digest | depot | boot, warden |
| `/store/revocations/<stream>.dsse` | `keylos.revocations/1` envelope (§11.7) | depot | boot, warden |
| `/var/lib/keylos/config/*.dsse` | `keylos.configgen/1` envelopes (§15) | config | boot |
| `/var/lib/keylos/hearth/owners.log` | owner registry (§20.3) | hearth (installer at genesis; installer's `rescue` in the recovery profile: `recover` and credential entries) | boot (replay in the initrd); `config-recover` and `rescue` (recovery profile only) |
| `/var/lib/keylos/fleet/wipe.dsse` | wipe bundle: the §20.23 wipe command plus an owner quorum envelope of purpose `boot.wipe` (§20.2) | fleet | `rescue` (recovery profile only) |
| `/var/lib/keylos/tpm/nv-auth/<index>.sealed` | `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` of the sealed authValue object (§19.6, "Sealed secrets"); `<index>` is `0x` + 8 lowercase hex digits, e.g. `0x01300100.sealed` | installer at genesis; hearth on (re)definition (`HearthTpm.defineSpace`); `rescue` (recovery profile) | the index's registered owner service only |
| `/var/lib/keylos/tpm/hierarchy-owner.sealed`, `hierarchy-endorsement.sealed` | TPM-sealed hierarchy authValues (§19.6) | installer at genesis; hearth on rotation | hearth |
| `/var/lib/keylos/tpm/hierarchy-owner.recovery` | HPKE (§4) ciphertext of the owner-hierarchy authValue to the recovery recipient (§20.21) | installer; hearth on rotation | recovery environment |
| `/var/lib/keylos/hearth/seal-gate-<i>.sealed` | quorum seal-gate blob (§19.6) | installer at genesis (quorum machines); hearth | hearth |
| `/var/lib/keylos/hearth/platform/<keyid>.blob` | assisted platform authenticator blob: JCS `{rpId, credentialId, cose, salt, key, hmacKey}` (§5.3) | installer (assisted credential enrolled at install); hearth | hearth |
| `/var/lib/keylos/recovery/recipient.pub` | 32-byte raw X25519 public key of the recovery recipient (§20.21) | installer | vault, hearth |
| `/var/lib/keylos/recovery/pending/<ULID>.dsse` | `keylos.pendingreceipt/1` (§20.22) | recovery environment (`rescue`, installer repo) | ledger (appends at the next normal boot, then deletes) |
| `/var/lib/keylos/devd/preauthorized.json` | `keylos.preauth/1` (§9.5) | installer | devd |
| `/etc/keylos/fleet/approvers.json` | `keylos.fleetapprovers/1` (§20.23); the only source of org approver keys | config (fleet module) | hearth, rescue (recovery environment), broker |
| `/keystore/ledger/signing.sealed` | TPM-sealed Ed25519 seed of the machine key | installer | ledger (MUST accept an existing key) |
| `/var/lib/keylos/firstboot/bundle.json` | `keylos.firstboot/1` (§20.13) | installer | the consumers listed in §20.13 |
| `/efi/keylos/vbu-totp.sealed` | sealed 20-byte TOTP secret (§20.5) | installer (`keylos-enrol vbu-totp`) | boot |
| `/usr/lib/keylos/bpf/<service>/*.o` | BPF ELF objects in the OS generation | pkgs (build) | warden |
| `/run/keylos/gate/ca.pem` (inside tier-L views) | PEM CA bundle of the principal's gate shim | gate | compat (sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`) |
| kernel command line `keylos.revocations=<serial>:<sha256>` | revocation list pin of the UKI's own release | release build (inside the signed UKI command line; `courier` only verifies it at staging) | boot |

**Per-service configuration files.** `/etc/keylos/<service>.json` and `/etc/<service>/*` are rendered by `config` and read only by that service; they need no row here, and their formats are defined in the service's own spec.

**Durable-execution state.** The durable records of §20.25 are private state of their owners (no other repository reads them); each lives in exactly one place, on persistent storage, behind a checked durability barrier:

| State | Owner | Location |
|---|---|---|
| Workflow store: enrollments, runs, steps, attempts, observations, timers, signals, tombstones, receipt outbox | loom | `/var/lib/keylos/loom/loom.db` (SQLite WAL, `synchronous=FULL`) and `/var/lib/keylos/loom/blobs/` |
| Workflow records (enrollment scope, epoch, label high-water mark, cancellation) and durable decisions | broker | `/var/lib/keylos/broker/workflows/`, `/var/lib/keylos/broker/decisions/` |
| Durable effect records and workflow budget accounts | gate | `/var/lib/keylos/gate/outbox.redb` (tables `effects`, `effects_by_workflow`), `/var/lib/keylos/gate/meter.redb` (table `accounts`) |
| Prepared-merge completion records | strata | strata's registry (strata spec) |

None of them may live in `warden`'s `FdStore`, under `/run`, in a diagnostic snapshot, or only in a ledger receipt.
<!-- END protocols §10.7 -->

<!-- BEGIN protocols §10.3 (verbatim) -->
> **protocols 10.3 UIDs and cgroups**

**UIDs:**

| Range | Use |
|---|---|
| 0 | Kernel threads, `warden` (PID 1). No other process. |
| 1000–59999 | Humans (allocated by `hearth`) |
| 0x00100000–0x0FFEFFFF | Dynamic principal UIDs, allocated by `warden` per running principal instance. Quarantined for 60 s after release. |
| 0x0FFF0000 | Reserved on-disk owner of `_cluster` data (pod volumes, cri state); reached by containers only through idmapped mounts; never allocated to a process |
| 0x0FFF0001–0x0FFFFFFF | Reserved |
| 0x10000000–0x7FFEFFFF | Legacy-tier user-namespace ranges, 65536-UID blocks, allocated by `warden` |

**cgroups:**

```
/keylos.slice/system.slice/<service>.scope
/keylos.slice/user-<uid>.slice/{shell,apps,agents,benches,legacy}.slice/<session>.scope
/keylos.slice/kube.slice/<pod-id>.slice/<container-or-vm>.scope      (cgroup subtree delegated to cri)
/keylos.slice/guest-<id>.slice/…                                    (ephemeral guest sessions, removed at logout)
```
<!-- END protocols §10.3 -->

<!-- BEGIN protocols §10.5 (verbatim) -->
> **protocols 10.5 Environment conventions**

Processes receive:
- `KEYLOS_PRINCIPAL` (text)
- `KEYLOS_SESSION`
- `KEYLOS_TIER`
- `KEYLOS_CAPWIRE_FDS`: a comma list of `name=fdnum` for passed service sockets, for example `broker=3,portal-files=4`. Names follow the route-name rule below.
- `KEYLOS_ARGFD_<argname>` and `KEYLOS_PIPE_IN` / `KEYLOS_PIPE_OUT` (§12)
- `KEYLOS_TXN`: the strata transaction ID when spawned with `SpawnSpec.transaction`
- `KEYLOS_AGENT_HOST`: `vsock:2:7002` inside agent workbenches
- `KEYLOS_GUEST_PORTALS`: `vsock:2:7004` inside tier-2 guests
- `KEYLOS_BPF_FDS`: `name=fdnum` list of BPF map fds `warden` loaded for a tier-0 service (§9.3)
- `KEYLOS_TPM_FD`: for services whose `services.json` entry has `privileges.tpm: true`, the number of an inherited fd of `/dev/tpmrm0` that `warden` opened for the service; services use it as their TPM (for example TCTI `device:/proc/self/fd/<n>`) and never open TPM devices by path
- XDG variables, with paths per §10.1

In tier-0 services fd 3 is the `warden` bootstrap socket (`Bootstrap`, §7.5.1) and is not listed in `KEYLOS_CAPWIRE_FDS`.

**Route names in `KEYLOS_CAPWIRE_FDS`:**

| Route | Name |
|---|---|
| `<svc>#client`, `<svc>#default` | `<svc>` |
| `broker#principal` | `broker` |
| `warden#client`, `warden#service` | `warden` |
| any other `<svc>#<facet>` | `<svc>#<facet>` |

**Adopting inherited descriptors.** Programs take ownership of fd 3 and of the descriptors named in `KEYLOS_CAPWIRE_FDS`, `KEYLOS_BPF_FDS` and `KEYLOS_TPM_FD` exactly once at start-up through the `keylos-capwire` inheritance helper (§18), which checks that each fd is open and sets `FD_CLOEXEC`; programs need no `unsafe` code of their own for it.

**Development knobs.** Names starting with `KEYLOS_DEV_` are reserved for development-only settings, for example `KEYLOS_DEV_TPM_TCTI` (a TPM TCTI string such as `swtpm:host=127.0.0.1,port=2321`, which replaces `KEYLOS_TPM_FD`). Production builds never read them, and `warden` never sets them; only the development supervisor of a development image may. Every other development knob of a keylos component uses this prefix. The registered knobs are:

| Knob | Read by | Effect (development builds only) |
|---|---|---|
| `KEYLOS_DEV_TPM_TCTI` | every TPM-using service (vault, hearth, ledger, broker, strata, courier, config) | TPM TCTI string that replaces `KEYLOS_TPM_FD` |
| `KEYLOS_DEV_LEDGER_SELF_PROVISION` | ledger | `1`: on a fresh store with the counter `0x01300100` absent, define it itself (`x-devProvision`) instead of waiting for `HearthTpm.defineSpace`; never after hearth genesis |
| `KEYLOS_DEV_LEDGER_SAMPLE_EXPORT` | ledger (tests) | Directory for sample exports written by the privacy test harness |
| `KEYLOS_DEV_HEARTH_SOFT_AUTHENTICATOR` | hearth | Use a software FIDO2 authenticator instead of a CTAP2 device |
| `KEYLOS_DEV_BROKER_IMPLICIT_SESSIONS` | broker | `1`: register an unregistered `broker#principal` peer implicitly instead of failing `kl:denied` |
| `KEYLOS_DEV_BROKER_POLICY_DIR` | broker | Directory that replaces the warden-mounted `/policy` generation |
| `KEYLOS_DEV_BROKER_GENERATION` | broker | Generation ref used for the broker's own principal when `ServiceHost.accept` and `policy.ref` give none |
| `KEYLOS_DEV_TIME_TRUSTED` | broker, loom | `1`: treat the system clock as trusted without a `NetWatch` `timeTrusted` event |
| `KEYLOS_DEV_WATCHDOG_SECS` | broker and every other daemon with a `watchdogSecs` of its own (it reads the knob itself; the `warden-svc` host reads none) | Watchdog interval that replaces the manifest's `watchdogSecs` |
| `KEYLOS_DEV_LOOM_FAULTS` | loom | Comma list of fault-injection points (`crash:<point>`, `fsync-fail:<point>`, `enospc:<point>`, points named in the loom spec) for the durability acceptance tests |
| `KEYLOS_DEV_LOOM_CLOCK_SKEW_SECS` | loom | Signed offset added to loom's view of trusted time, for timer, expiry and long-downtime tests |

A knob that is not listed here MUST NOT be read by any component; a new knob is registered here before use.

No secrets, ever. Names starting with `KEYLOS_` are reserved; `SpawnSpec.env` MUST NOT set them, with one exception: a `shell` principal MAY set `KEYLOS_ARGFD_*`, `KEYLOS_PIPE_IN` and `KEYLOS_PIPE_OUT` (§12); `warden` verifies that every fd named in `KEYLOS_ARGFD_*` is present in `SpawnSpec.fds`.
<!-- END protocols §10.5 -->

<!-- BEGIN protocols §11.6 (verbatim) -->
> **protocols 11.6 Owner seal**

A **seal statement** (`keylos.seal/1`):

```json
{"schema":"keylos.seal/1","generation":"gen:fsv256:…","drv":"drv:sha256:…",
 "sourceTree":"src:sha256:…","sealedAt":"…","machine":"key:sha256:<machine key>",
 "window":"w-…","windowDigest":"sha256:<digest of the presence-signed seal-window envelope>"}
```

**Owner-seal keys** (one per owner *i*, §19.6):
- A TPM-resident, non-duplicable ECDSA P-256 signing key under the owner hierarchy at handle `0x81000140 + i`, with `userWithAuth` cleared and policy `PolicySecret(NV seal gate 0x01300140 + i)`.
- The seal gate's auth value is rotated by `hearth` every sealing window through a FIDO2 `hmac-secret` chain: one assertion with two salts yields the current auth `o_k` and the next auth `o_{k+1}`; at window close `hearth` performs `TPM2_NV_ChangeAuth(gate, o_{k+1})` and zeroizes both. The full algorithm is in the `hearth` spec; it MUST satisfy: (a) no seal signature without a fresh touch-authorized window, (b) a captured auth value is useless after the window closes.
- **Sealing window:** one presence assertion authorizes a window of at most 600 s, limited to one project directory and a list of `drv`s (`keylos.seal-window/1`, §20.4). Seal statements are signed only through `HearthSeal.sealSign` (§7.5.3).
- The owner-seal public keys are part of the **boot trust set** (§20.1); the config generation carries them in `/etc/keylos/owner-seal/<i>.spki`.
- The `seal.window` receipt (hearth) carries `windowDigest`, so relying parties that never see the presence-signed window (depot) can check a seal statement's `windowDigest` against the ledger.
<!-- END protocols §11.6 -->

<!-- BEGIN protocols §15 (verbatim) -->
> **protocols 15. Config generation statement (`keylos.configgen/1`)**

```json
{"schema":"keylos.configgen/1","generation":"gen:fsv256:…","sourceRev":"git:sha1:…|sha256:…",
 "parent":"gen:fsv256:…","counter":57,"compiledBy":"gen:fsv256:<config compiler gen>",
 "proposedBy":"agent:…@alice/s-…","approvedBy":"alice","time":"…"}
```

- Signed by `owner-presence` (§5.3).
- `counter` MUST equal the TPM NV config counter (`0x01300101`, §19.6) + 1 at the time of signing. `config` increments the NV counter only after the signed generation is durably in the store. `boot` refuses a config generation whose counter is below the NV value. That is the anti-rollback rule.
- `boot` selects the highest-counter statement that verifies against the owner registry anchored in NV `0x01300105`, with `counter ≥` the NV value; if none qualifies, it boots the safe config shipped in the OS generation.
- **Activation failure.** `boot` never falls back automatically to an older config generation (that would be a rollback below the NV value). If a newly applied generation fails to activate (a tier-0 service fails its readiness check three times), `config` writes `/var/lib/keylos/config/activation-failed.json` (`{"generation", "counter", "failures": […]}`) and receipt `config.activation-rollback`; the **recovery boot entry** offers "revert to the previous configuration", which produces a **new** config generation with the previous content and counter + 1, signed with presence (or quorum) in the recovery environment.
<!-- END protocols §15 -->

<!-- BEGIN protocols §14.3 (verbatim) -->
> **protocols 14.3 Approval tiers**

| Tier | Covers | Interaction |
|---|---|---|
| T0 | Reads and overlay writes within grants | None, receipt only |
| T1 | Reversible egress to granted hosts | None; a classifier MAY escalate to T2/T3 |
| T2 | Compensable effects, new hosts, widening a sub-principal's scope | Batched review on the trusted path |
| T3 | Irreversible effects, declassification, budget overrun, merge of an agent overlay, config apply, seal, policy change | Synchronous trusted-path prompt with rendered effects and argument provenance. Presence (FIDO2 touch) is REQUIRED for config apply, seal, policy change, payment, persistent grants, and any effect whose policy says `presence` |

Rules:
- No automated component may lower a tier.
- A remote approval routed to a paired phone (`VouchLink.routeApproval`) or an org approval (`OrgDecider.decide`) MAY satisfy a T2/T3 approval only when the policy explicitly allows that channel for that effect kind, and **never** satisfies `requiresPresence`.
- **Channel selection.** The broker puts `"phone"` in `ApprovalPrompt.channels` only when the matching permit's `@channels` includes `phone` **and** a `vouchd` approver key is registered this boot (`registerApprover(…, "phone")`); `"org"` only for `@orgApproval` permits on fleet-enrolled machines. The mandate's `channel` records the channel that decided.
- **Family machines.** A non-owner human's request that needs an owner decision (config proposal, seal, persistent grant, policy change, install of an unreviewed app) becomes an approval prompt to the owners with `requester` set; it is shown on the next owner trusted-path session or routed to an owner's paired phone (never satisfying presence).
- **Quorum machines.** Wherever presence is required, a quorum presence envelope (§5.4) is required instead.
- **Headless machines without fleet.** On profiles without `atrium` that are not fleet-enrolled, every approval at T2 or above is escalated to a quorum presence request (`HearthQuorum.request`); there is no local trusted path. The resulting mandate has `channel: "quorum"`.
- **Guest sessions** never receive presence-class grants, agent sessions (unless `hearth.guest.agents` is true) or persistent grants.
- **Fail closed on rendering.** No channel may produce an approving decision for an effect whose required review details (§14.2) were not presented completely (§7.3.4). This holds for local prompts, presence cards, phone, org and quorum review alike; a channel that cannot present them leaves the approval pending for a capable channel, or it expires and is denied.
- **Org approver keys** come only from `/etc/keylos/fleet/approvers.json` (`keylos.fleetapprovers/1`, §20.23).
- **Durable decisions** (§20.25). An approval for a workflow is a durable decision record (`dr-…`) in the broker. Its prompt (`a-…`) is boot-local: a pending decision survives restarts and reboots and is presented again, with a new prompt ID, until it is decided or expires; `expires` is fixed when the decision is created (default 7 days, never beyond the workflow's horizon) and is never extended. Waiting never makes an earlier, incomplete rendering sufficient: each presentation needs the complete required material of that moment. A decided approval is used by a later attempt only through an explicit rebind (`BrokerWorkflow.rebind`), which re-checks current policy, revocation, expiry and presence; it never turns a historical approval into standing authority.
<!-- END protocols §14.3 -->

<!-- BEGIN protocols §14.5 (verbatim) -->
> **protocols 14.5 Operating rules**

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.
<!-- END protocols §14.5 -->

<!-- BEGIN protocols §16.1 (verbatim) -->
> **protocols 16.1 Schema**

Namespace `Keylos`. Policies are authored in config and compiled into `policy` generations. The `broker` evaluates every request with:
- principal = `Keylos::Principal`
- action = `Keylos::Action::"<op>"`
- resource = one of the entity types below
- context = request context

```
namespace Keylos {
  entity Human = { owner: Bool, guest: Bool };
  entity Principal in [Human] = {
    kind: String,              // app | service | agent | legacy | bench | shell | pod
    human: String,             // the principal's human ("_system", "_cluster" or a username)
    humanOwner: Bool,
    humanGuest: Bool,
    generationName: String,
    generation: String,
    tier: String,
    depth: Long,
    label: { conf: String, integ: String },
  };
  entity Path = { root: String, rel: String, labelConf: String, labelInteg: String };
  entity Host = { name: String, port: Long, sinkSafe: Bool, trusted: Bool };
  entity Device = { subsystem: String };
  entity Secret = { owner: String };
  entity Effect = { kind: String, class: String };
  entity Generation = { name: String, publisher: String, reproducible: Bool };
  entity Service = { name: String, facet: String };
  entity Budget = { unit: String };
  entity DebugTarget = { target: String, scope: String, targetHuman: String, targetKind: String };
  entity PodSpec = {
    namespace: String, name: String, runtimeClass: String,
    serviceAccount: String, labels: Set<String>,                    // Kubernetes labels as "key=value" strings
    images: Set<String>,                                            // "oci:sha256:…" or "gen:fsv256:…"
    privileged: Bool, hostNetwork: Bool, hostPID: Bool, hostIPC: Bool,
    hostPaths: Set<String>, hostPathsReadOnly: Bool,
    addedCapabilities: Set<String>, seccompProfile: String, appArmorProfile: String,
    runAsRoot: Bool, allowPrivilegeEscalation: Bool,
    gpuPassthrough: Long, csiDrivers: Set<String>, volumeTypes: Set<String>,
    cpuMillis: Long, memoryBytes: Long,
    allImagesSealed: Bool,                                          // every image is a gen: container generation (computed by cri)
  };
  entity Screen = { window: String, app: String };
  entity Model = { provider: String, model: String, version: String };
  entity Workflow = {
    definitionName: String, definition: String,                    // workflow name, "gen:fsv256:…" of its generation
    owner: String,                                                  // the owning human
    autoResume: Bool, runWhileLocked: Bool, horizonSecs: Long,
    scopeKinds: Set<String>,                                        // resource kinds of the enrollment scope ("path", "net", …)
    effectKinds: Set<String>,                                       // effect kinds the definition may commit
  };

  action "read", "write", "create", "delete", "exec" appliesTo { principal: Principal, resource: Path, context: Ctx };
  action "connect", "bind" appliesTo { principal: Principal, resource: Host, context: Ctx };
  action "use" appliesTo { principal: Principal, resource: [Device, Secret, Service, Model], context: Ctx };
  action "snapshot" appliesTo { principal: Principal, resource: Screen, context: Ctx };
  action "spend" appliesTo { principal: Principal, resource: Budget, context: Ctx };
  action "spawn" appliesTo { principal: Principal, resource: Generation, context: Ctx };
  action "stage", "commit" appliesTo { principal: Principal, resource: Effect, context: Ctx };
  action "delegate" appliesTo { principal: Principal, resource: Principal, context: Ctx };
  action "debug" appliesTo { principal: Principal, resource: DebugTarget, context: Ctx };
  action "admit" appliesTo { principal: Principal, resource: PodSpec, context: Ctx };   // principal = service:kubelet / cri
  action "enroll", "resume", "cancel" appliesTo { principal: Principal, resource: Workflow, context: Ctx };   // §20.25
  type Ctx = { time: Long, persist: Bool, durationSecs: Long, reason: String, approvalTier: String,
               amount?: Long, channel?: String, approver?: String,
               offlineDays?: Long, profile?: String, integrityProfile?: String, requester?: String,
               workflow?: String, epoch?: Long };            // workflow: the wf-… a request is decided for (§20.25); epoch: its claim
}
```

The distribution's default policy MUST contain at least these `admit` forbids: `privileged`, `hostNetwork`, `hostPID`, `hostIPC`, non-empty `addedCapabilities`, `seccompProfile == "unconfined"`, `allowPrivilegeEscalation`, and any `hostPaths` outside the read-only allowlist `cluster.hostPathAllowlist` (default empty). `runtimeClass == "keylos-sealed"` additionally requires `allImagesSealed` (every image is a `gen:` reference to a `container` generation; `cri` computes the attribute because Cedar has no quantifiers over sets). Policies about the same human (debug targets, family and guest rules) compare `principal.human` with `resource.targetHuman` or `context.requester`.

**Workflow decisions** (§20.25). `enroll`, `resume` and `cancel` are evaluated with the requesting session as principal and the `Workflow` entity as resource. Requests decided for a workflow without a live requesting session (attempt grants at registration, `BrokerWorkflow.authorizeEffect`, `decide`) are evaluated with a principal entity built from the workflow record: `kind` = the actor kind of the definition's generation (`app`, `service`, or `agent` for agent activities), `human` = the owner, `generationName`/`generation` of the activity's generation, `depth` = 1, `label` = the workflow label high-water mark, and `context.workflow`/`context.epoch` set. The default policy MUST contain: `enroll` only by a non-guest owner-or-user `shell` (or `atrium` for it) for workflows the human owns, with tier ≥ t2, and presence when `autoResume` or `runWhileLocked`; `resume` by the owner's `shell` at t0; `cancel` by the owner's `shell` (also when `aide` relays the owner's `AgentSession.stop`, `LoomSystem.cancelRequested`) and by owner `shell`s of the machine, at t0. Enrollment scope items are evaluated as persistent requests (`context.persist = true`).
<!-- END protocols §16.1 -->

#### 2.2.6 Registries and shared formats

<!-- BEGIN protocols §19.2 rows=^\| hearth \| (verbatim) -->
> **protocols 19.2 Facets** (rows for this repository)

Every route names exactly one facet. Servers MUST implement exactly these facets; holders other than those listed are routed only when policy explicitly grants `right("service", "<svc>#<facet>", "use")`.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| hearth | `greeter` | atrium greeter and lock screen | `users`, `login`, `unlock`, `lock` |
| hearth | `presence` | broker, config, depot, courier, ledger, vault, aide, strata | `presence`; `HearthQuorum.request`/`collect` |
| hearth | `atrium` | atrium | `presence` (prompt already shown by atrium) |
| hearth | `admin` | owner `shell`, atrium settings | all `Hearth`; `HearthAdmin` (including `setQuorumPolicy`); `HearthQuorum.collect`, `list` |
| hearth | `system` | warden, devd, config, broker, gate, vouch, strata, bench, depot, ledger, loom | `HearthSystem` (gate, vouch, strata, bench, depot, ledger: `owners` only; loom: `owners`, `userState`, `watchUsers`) |
| hearth | `seal` | depot, forge | `HearthSeal` |
| hearth | `tpm` | courier, vault, strata, ledger, config, vouch, fleet | `HearthTpm` (`defineSpace`, `recreateKey`: the object's registered owner; `sbSign`, `sbAccepted`: courier; `activateCredential`: vouch, fleet) |
| hearth | `quorum` | fleet | `HearthQuorum.submit`, `list` |
| hearth | `fleet-lock` | fleet | `HearthFleet` |
<!-- END protocols §19.2 rows=^\| hearth \| -->

<!-- BEGIN protocols §19.3 rows=\| hearth \|$ (verbatim) -->
> **protocols 19.3 Receipt events** (rows for this repository)

| Event | Writer |
|---|---|
| `user.login`, `user.lock`, `user.create`, `user.delete`, `key.enroll`, `key.remove`, `presence.assert`, `seal.window`, `quorum.request`, `quorum.complete`, `guest.start`, `guest.end` | hearth |
<!-- END protocols §19.3 rows=\| hearth \|$ -->

<!-- BEGIN protocols §19.6 (verbatim) -->
> **protocols 19.6 TPM objects**

All keylos NV indices live in the owner-hierarchy NV range block **0x01300100–0x013001FF**.

**Common NV attributes.** Every keylos NV index has `TPMA_NV_OWNERREAD | TPMA_NV_AUTHREAD | TPMA_NV_POLICYREAD`, `TPMA_NV_NO_DA` unless stated otherwise, and `TPMA_NV_PLATFORMCREATE` clear. Its authPolicy is `PolicyOR{PolicyCommandCode(TPM2_CC_NV_Read), <write policy>}` where the index has a write policy, else `PolicyCommandCode(TPM2_CC_NV_Read)` alone, so **anyone with TPM access can read** counters, floors and heads (their contents are integrity-relevant, not secret) while writes stay controlled. Exception: the two `vault-epoch` indices are secret: `AUTHREAD | AUTHWRITE | NO_DA`, `OWNERREAD` and `POLICYREAD` clear, and an **empty authPolicy**, so every read and write needs the index's authValue, which is sealed like the others (PCR11 `ready` ∧ PCR15). Services that write an index hold its authValue as a TPM-sealed secret (`/var/lib/keylos/tpm/nv-auth/0x<8 lowercase hex>.sealed`, §10.7) bound to the signed PCR11 `ready` phase and PCR15 (volume identity).

**Sealed secrets.** Every secret this section calls "sealed to PCR11 `ready` ∧ PCR15" (NV authValue files, hierarchy blobs, service keys, quorum seal-gate blobs, the vault system key) is a keyedHash **sealed data object** created under the SRK `0x81000001`: nameAlg SHA-256; attributes `fixedTPM | fixedParent | adminWithPolicy | noDA`, with `userWithAuth` and `sensitiveDataOrigin` clear; empty authValue; the secret as sensitive data. It is stored as `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` (each marshalled with its size prefix).
- **Production authPolicy:** `PolicyAuthorize(release-stream PCR11 key, the signed policy for phase "ready")` followed by `PolicyPCR(sha256:{15})`; the approved policy the release key signs is `PolicyPCR(sha256:{11})` at the `ready` value (§20.6).
- **Development fallback:** `PolicyPCR(sha256:{15})` alone, used only by development builds where no signed PCR11 policy exists. Readers identify the variant by comparing the object's authPolicy with both digests; production builds accept only the production digest.

NV authValue files are written by the installer at genesis, by `hearth` whenever it (re)defines an index (`HearthTpm.defineSpace`, §7.5.3), and by `rescue`; each is read only by the index's registered owner.

**Hierarchy authorization.**
- **Owner hierarchy:** set at install to a random 32-byte value, stored as a TPM-sealed blob for `hearth` (PCR11 `ready` ∧ PCR15, `/var/lib/keylos/tpm/hierarchy-owner.sealed`) and, for recovery, as an HPKE ciphertext to the recovery recipient (`hierarchy-owner.recovery`, §20.21); `hearth` rewrites both when it rotates the value. `hearth` is the sole userspace holder of owner-hierarchy operations and exposes the needed ones through `HearthTpm` (§7.5.3). `boot` reads NV in the initrd through the `PolicyCommandCode(NV_Read)` branch; it never needs owner auth.
- **Endorsement hierarchy:** set to a random value sealed like the owner auth (used only for AK/AK0 provisioning).
- **Lockout:** random value derived as HKDF-SHA256(recovery key, "keylos-lockout/1"); only the recovery environment uses it.

| NV index | Name | Type and size | Write authorization | Owner |
|---|---|---|---|---|
| `0x01300100` | ledger-counter | counter | AUTHWRITE, authValue sealed to `ledger` | ledger |
| `0x01300101` | config-counter | counter | AUTHWRITE, authValue sealed to `config` | config (read by boot) |
| `0x01300102` | os-floor | ordinary, 8 bytes, u64 big-endian (minimum bootable release `seq`); `POLICYWRITE`, empty authValue (public reads, including `PolicyNV`) | `PolicyAuthorize(release-stream key, policyRef "keylos/floor-write/1")` over **exact-target** approved policies ("Floor writes" below) | courier, installer (read by boot) |
| `0x01300103` | pcrlock-policy | ordinary, 34 bytes (TPM2B_DIGEST) | `PolicyAuthorize(release-stream key, "keylos/pcrlock-write/1")` or `PolicySecret(recovery auth object 0x81000105)`; the index authPolicy is the **flat** `PolicyOR{PolicyCommandCode(NV_Read), PolicyAuthorize(…), PolicySecret(…)}` (never nested) | courier, boot (recovery) |
| `0x01300104` | keystore-floor | counter | AUTHWRITE, authValue sealed to `vault` | vault |
| `0x01300105` | owner-registry-head | ordinary, 104 bytes: SHA-256(last registry line) ‖ u64 BE seq ‖ SHA-256(JCS owner-presence key set) ‖ SHA-256(JCS owner Secure Boot certificate set) | AUTHWRITE, authValue sealed to `hearth` (installer at genesis) | hearth (read by boot) |
| `0x01300106` | login-failure-counter | counter | AUTHWRITE, authValue sealed to `hearth` | hearth |
| `0x01300107` | strata-anchor-counter | counter | AUTHWRITE, authValue sealed to `strata` | strata |
| `0x01300108` | attestation-key-names | ordinary, 68 bytes: Name(AK) ‖ Name(AK0) | owner authorization at enrolment | installer, boot (read by vouch tooling) |
| `0x01300110` | vault-epoch/0 | ordinary, 40 bytes: epoch key (32) ‖ u64 BE epoch; an all-zero key means erased | authValue (`AUTHREAD | AUTHWRITE`, empty authPolicy; authValue sealed to PCR11 `ready` ∧ PCR15 in `nv-auth/0x01300110.sealed`) | vault |
| `0x01300111` | vault-epoch/1 | same as vault-epoch/0; the two alternate as active and candidate index (vault §4.5.1) | authValue (as vault-epoch/0, `nv-auth/0x01300111.sealed`) | vault |
| `0x01300140 + i` (i < 16) | seal-gate/i | ordinary, 1 byte, used for its authValue; common attributes (`OWNERREAD`, `AUTHREAD`, `POLICYREAD`) plus `POLICYWRITE`; NO_DA **not** set. authPolicy = `PolicyOR{PolicyCommandCode(NV_Read), PolicyCommandCode(NV_ChangeAuth) ∧ PolicyAuthValue}` | `PolicyCommandCode(NV_ChangeAuth) ∧ PolicyAuthValue` | hearth |

**Seal-gate salts.** The FIDO2 `hmac-secret` salts for owner *i*'s window *k* are `s_k = SHA-256("keylos-seal" ‖ u64_be(k))` (k encoded as 8 bytes, big-endian), and the assertion carries `(s_k, s_{k+1})`. On **quorum** machines (§5.4) the next authValue is held in a TPM-sealed blob `/var/lib/keylos/hearth/seal-gate-<i>.sealed` (PCR11 `ready` ∧ PCR15) and released by `hearth` only after a verified quorum envelope of purpose `seal.window`.

**Changing a seal gate's authValue.** `TPM2_NV_ChangeAuth` under the gate's policy and "undefine, then define again with the identical template and the new authValue" (owner authorization, after proving the current authValue) are equivalent: the NV Name excludes the authValue and a gate is never written, so its Name, and every `PolicySecret` binding to it, is unchanged. With the second method `hearth` seals the new authValue durably before the undefine, and a start that finds a registered gate absent defines it again with that pending value.

**Floor writes.** For every UKI it releases, the release stream signs exactly one approved policy for `keylos/floor-write/1`, bound to that UKI's measured PCR11 value and to exactly one target value *F*:
- OS UKI (phase `ready`): `PolicyPCR(sha256:{11})` ∧ `PolicyNV(0x01300102, operand u64_be(F), offset 0, TPM_EO_UNSIGNED_LE)` (current floor ≤ *F*) ∧ `PolicyCpHash(TPM2_NV_Write(authHandle 0x01300102, nvIndex 0x01300102, data u64_be(F), offset 0))`, with *F* = the release's `floor` (§20.6).
- Installer UKI and the cloud UKI's `seed` profile: `PolicyPCR(sha256:{11})` ∧ `PolicyNvWritten(NO)` ∧ `PolicyCpHash(…write F…)`: initialisation of a freshly defined index only.
Two releases MUST NOT carry different *F* for the same UKI digest. In one measured boot only one target is therefore writable: concurrent or stale policy sessions can only write the same *F*, an older release's policy does not match PCR11, and a write never lowers the floor because `PolicyNV` refuses it when the current value exceeds *F* (the guarantee assumes the release-stream key is not compromised). The value written is exactly *F*, never an intermediate one; a lost acknowledgment is answered by writing *F* again. A missing or unreadable `os-floor` after provisioning (TPM clear, interrupted write) is a recovery and re-enrolment condition, never silently reconstructed: the recovery environment defines the index again and initialises it with the floor of the signed release statement of the release being re-enrolled, and reports that hardware floor history was lost.

| Persistent handle | Hierarchy | Object | Registered owner |
|---|---|---|---|
| `0x81000001` | owner | SRK (ECC P-256, TCG standard template); its public key is pinned at enrolment | hearth (installer at genesis) |
| `0x81000101` | owner | Owner Secure Boot KEK signer (RSA-2048). Policy: with one owner, `PolicySecret(seal-gate/0)`; with two or more, `PolicyOR` over `PolicySecret(seal-gate/i)` of the enrolled owners (`PolicyOR` needs ≥ 2 branches). Adding or removing an owner re-creates both signers and re-enrols them in firmware (documented ceremony) | hearth (installer at genesis) |
| `0x81000102` | owner | Owner Secure Boot db signer (RSA-2048); same policy | hearth (installer at genesis) |
| `0x81000103` | owner | First-boot vault seed key: ECC P-256 decrypt key for HPKE DHKEM(P-256, HKDF-SHA256) (§4), sealed to the boot policy; evicted at first boot (`HearthTpm.evict`) | vault (`evict` only) |
| `0x81000105` | owner | Recovery auth object; authValue = HKDF-SHA256(recovery key, "keylos-recovery-auth/1") | hearth (installer at genesis) |
| `0x81000110` | owner | strata anchor HMAC key; policy `PolicyPCR(15) ∧ PolicyNV(0x01300107 ≥ 1)` | strata |
| `0x81000120` | owner | fleet device key (fleet-enrolled machines) | fleet |
| `0x81000140 + i` | owner | owner-seal/i (ECDSA P-256 signing; `userWithAuth` clear; policy `PolicySecret(0x01300140 + i)`) | hearth (installer at genesis) |
| `0x81010002` | endorsement | AK: restricted signing ECC P-256; runtime attestation (vouch, fleet, cluster join) | hearth (installer at genesis) |
| `0x81010003` | endorsement | AK0: restricted signing ECC P-256; pre-unlock VBU quotes (§20.5) | hearth (installer at genesis) |
| `0x81000180`–`0x81000183` | owner | Reserved staging handles for re-creating the owner Secure Boot KEK/db signers (`0x81000101`/`0x81000102`) when the owner set changes; empty outside that ceremony | hearth (installer at genesis) |

Only the registered owner of a handle may call `HearthTpm.recreateKey` (or, for `0x81000103`, `evict`) for it.

**AK and AK0 attributes:** `fixedTPM`, `fixedParent`, `sensitiveDataOrigin`, `userWithAuth`, `restricted`, `sign` set; `adminWithPolicy` clear; empty authValue; empty authPolicy (credential activation with the EK requires the admin role through the empty authValue). Quotes carry the PCR values; no PCR binding of the key is needed.

PCR usage (normative for boot, courier, vouch, fleet, cri):

| PCR | Content |
|---|---|
| 0–7 | Firmware, option ROMs, Secure Boot state (pcrlock policy, NV `0x01300103`) |
| 11 | UKI sections and boot phases; signed PCR11 policy |
| 12 | Kernel command line and credentials |
| 13 | System extensions (none in keylos; MUST be the "no extension" value; `kmod` generations are not system extensions) |
| 14 | shim/MOK state (shim fallback mode only) |
| 15 | Volume identity (LUKS volume key hash), extended by the initrd after unlock |

**PCR11 phases, in order** (each extended exactly once per boot by the named component):

| Phase | Extended by | When |
|---|---|---|
| `enter-initrd` | boot (`kl-initrd`, its first action) | before any other initrd step. systemd-stub measures the UKI sections into PCR11 but extends no phase string |
| `leave-initrd` | boot | after unlock, PCR15 extension, trust-set write and kl-exec load; immediately before `switch_root`. The disk-unseal policy is bound to `enter-initrd`, so the disk key is unavailable afterwards |
| `sysinit` | warden | after mounting `/var`, `/home`, `/store`, `/keystore` and taking over the kl-exec maps |
| `ready` | warden | immediately **before** starting the first tier-0 service (ledger and journal included). Secrets sealed to `ready` (service keys, NV authValues, hearth's hierarchy auth) are therefore available to tier-0 services and to nothing launched before this point |
| `enter-recovery` | boot | instead of `leave-initrd`, in the recovery profile; nothing sealed to `ready` is available afterwards |

No component extends PCR11 after `ready`.
<!-- END protocols §19.6 -->

<!-- BEGIN protocols §20.1 (verbatim) -->
> **protocols 20.1 Boot trust set and boot report**

`/run/keylos/boot/trust.json` (mode 0444, JCS), written by `boot` before `switch_root`:

```json
{"schema":"keylos.boottrust/1","stream":"stable","seq":4211,
 "osGen":"gen:fsv256:…","configGen":"gen:fsv256:…","safeConfig":false,
 "keys":{
   "releaseStream":["key:sha256:…"],
   "ownerPresence":["key:sha256:…"],
   "ownerSeal":["key:sha256:…"],
   "publishers":["key:sha256:…"]},
 "spki":{"key:sha256:…":"<base64 DER>"},
 "revocationsSerial":1234,
 "bootstrapGens":{"journal":"gen:fsv256:…","ledger":"gen:fsv256:…","depot":"gen:fsv256:…"},
 "featureLevel":"KL2"}
```

- `releaseStream`: keys from the UKI (subscribed streams).
- `ownerPresence`: from the owner registry anchored in NV `0x01300105`.
- `ownerSeal`: from `/etc/keylos/owner-seal/*.spki` in the verified config generation.
- `publishers`: from `/etc/keylos/publishers.json` in the verified config generation. Adding a publisher therefore takes effect at the next boot.
- `bootstrapGens`: from `/etc/keylos/services.json`; `warden` mounts them itself before `depot` runs.

`/run/keylos/boot/report.json` (also passed to `warden` as fd 8; fds 3–7 are the kl-exec maps, §9.3):

```json
{"schema":"keylos.bootreport/1","timingsMs":{"initrd":412,"vbu":0,"pin":2910,"unseal":180,"mount":95},
 "vbu":"verified|skipped|not-enrolled","pcr11Phase":"leave-initrd","profile":"default",
 "unlock":"tpm2+pin|recovery","volumeIdentity":"ok","configCounter":57,"floor":4200,
 "secureBoot":"owner|shim|off","safeConfig":false,"integrity":"full",
 "dmaProtection":"firmware-declared|none","iommu":"active|none-virtual|none"}
```
<!-- END protocols §20.1 -->

<!-- BEGIN protocols §20.2 (verbatim) -->
> **protocols 20.2 Presence purposes**

| `purpose` | Payload `schema` | UV required |
|---|---|---|
| `mandate` | `keylos.mandate/1` | per policy (default true) |
| `config.apply` | `keylos.configgen/1` | true |
| `seal.window` | `keylos.seal-window/1` | true |
| `owners.entry` | `keylos.owners-entry/1` | true |
| `grant.persist` | `keylos.mandate/1` | per policy |
| `exception` | `keylos.exception/1` | true |
| `debug.grant` | `keylos.mandate/1` | true |
| `ledger.reset-writer:<svc>`, `ledger.ack-alarm`, `ledger.shred`, `vault.<op>`, `update.<op>`, `boot.<op>` (including `boot.sb-sign`), `trustee.split`, `loom.<op>` (including `loom.rollback-accept`, §20.25), `gate.<op>` (including `gate.rollback-accept`), `broker.<op>` (including `broker.workflow-rollback-accept`) | `keylos.presence/1` | true |

`boot.wipe` details: `{"command": <the keylos.fleet.command/1 object>, "commandDigest": "sha256:<digest of its JCS bytes>"}`. HPKE `info` for recovery copies (§4) is `keylos-recovery-copy/1:<object>` with `<object>` ∈ {`hierarchy-owner`, `vault-slot:<username>`}.

Generic payload:

```json
{"schema":"keylos.presence/1","purpose":"ledger.reset-writer:gate","requestedBy":"<principal>","details":{},"nonce":"<base64 16 bytes>","time":"…"}
```
<!-- END protocols §20.2 -->

<!-- BEGIN protocols §20.3 (verbatim) -->
> **protocols 20.3 Owner registry**

`/var/lib/keylos/hearth/owners.log`: JSON Lines; each line is a DSSE envelope of `keylos.owners-entry/1`, presence-signed:

```json
{"schema":"keylos.owners-entry/1","seq":3,"prev":"sha256:<digest of previous envelope line bytes>","time":"…",
 "op":"enroll-credential","owner":"alice","ownerIndex":0,
 "credential":{"keyid":"key:sha256:…","cose":"<base64>","credentialId":"<base64>","label":"Spare key","aaguid":"…",
               "assisted":false,"seal":true},
 "sealKey":"<base64 SPKI DER of owner-seal/<ownerIndex>, on add-owner and genesis>",
 "secureBootCert":null,
 "policy":{"mode":"touch","quorum":1,"threshold":1}}
```

| `op` | Meaning | Signed by |
|---|---|---|
| `genesis` | First entry (installer): first owner, credentials, `recoverySigner` (Ed25519 key derived from the recovery key) | the new credentials |
| `add-owner`, `remove-owner` | Owner set changes | `policy.quorum` existing owners |
| `enroll-credential`, `remove-credential` | Credential changes | an existing credential of the same owner (or quorum) |
| `set-secureboot-certs` | Owner Secure Boot certificate set | quorum |
| `set-quorum` | Change `policy` (`mode` `touch`/`quorum`, `quorum` for owner-set changes, `threshold` for quorum presence) | the current `policy.quorum` owners |
| `recover` | Re-anchor after recovery | `recoverySigner` |

Fields:
- `ownerIndex` (0–15) selects the owner's seal gate `0x01300140 + ownerIndex` and owner-seal key `0x81000140 + ownerIndex`; assigned at `genesis`/`add-owner` and never reused while the owner exists.
- `sealKey`: SPKI of the owner's owner-seal key; `config` copies it to `/etc/keylos/owner-seal/<ownerIndex>.spki`.
- `credential.seal: true` marks the credential whose `hmac-secret` drives the owner's seal gate (`sealCredential`); exactly one per owner on `touch` machines.
- `credential.assisted: true` marks an assisted platform authenticator (§5.3).
- `policy.mode = "quorum"` switches the machine to quorum presence (§5.4) with `policy.threshold` distinct owners.
- `recoverySigner` (genesis and `recover` entries): `{"keyid": "key:sha256:…", "spki": "<base64 SPKI DER of the Ed25519 key>"}`.
- `HearthAdmin.setQuorumPolicy` appends a `set-quorum` entry; `policy.quorum` is a single number used for both adding and removing owners.

The NV head (`0x01300105`) is updated after every append. Verifiers replay the log from genesis and require the computed head to equal the NV value. `keylos.owners/1` is the export form: `{"schema", "entries": [<envelopes>], "head", "seq"}`.
<!-- END protocols §20.3 -->

<!-- BEGIN protocols §20.4 (verbatim) -->
> **protocols 20.4 Seal window**

```json
{"schema":"keylos.seal-window/1","owner":"alice","project":"/home/alice/Projects/tool","drvs":["drv:sha256:…"],
 "opened":"…","expires":"…","machine":"key:sha256:<machine key>","id":"w-…"}
```

`expires − opened ≤ 600 s`. A seal statement is accepted only if its `drv` is in `drvs` and its `sealedAt` lies inside the window.
<!-- END protocols §20.4 -->

<!-- BEGIN protocols §20.13 (verbatim) -->
> **protocols 20.13 First-boot bundle (`keylos.firstboot/1`)**

Written by `installer` to `/var/lib/keylos/firstboot/bundle.json` (mode 0600, inside the encrypted disk); its SHA-256 is in the first config generation (`firstbootBundleDigest`). Each consumer deletes its part; `warden` removes the file when all have reported done.

```json
{
  "schema": "keylos.firstboot/1",
  "machine": {"name": "laptop-ada", "machineKey": "key:sha256:…", "srkPublic": "<base64>", "ekCertChain": ["<base64 DER>"]},
  "profile": "laptop", "integrity": "full",
  "storage": {"luks": {"cipher": "aegis128-random", "sectorSize": 4096, "uuid": "…"}, "btrfs": {"uuid": "…"}},
  "secureBoot": {"mode": "owner", "keepMicrosoftCAs": false, "optionRomHashes": ["sha256:…"]},
  "tpm": {"registry": "keylos-tpm-registry/1.0", "pcrlockCoveredPcrs": [0, 2, 4, 7]},
  "owner": {"name": "ada", "displayName": "Ada", "uid": 1000, "login": "password+fido2",
            "passwordHash": "$argon2id$v=19$m=262144,t=3,p=4$…",
            "fido2": [{"label": "blue key", "credentialId": "<base64>", "publicKey": "<base64 SPKI>", "alg": "ES256",
                       "aaguid": "…", "keyRef": "key:sha256:…"}],
            "sealGate": {"index": "0x01300140", "saltCounter": 1}},
  "vault": {"items": [{"name": "wifi/home", "kind": "wifi-psk", "value": "<base64, encrypted to 0x81000103>"}]},
  "vouch": {"paired": true, "phoneWitnessKey": "key:sha256:…", "phoneApprovalKey": "key:sha256:…"},
  "recovery": {"recipient": "<base64 32-byte X25519 public key>"},
  "owners": null,
  "config": null,
  "fleet": null,
  "imports": [{"source": "ext4:UUID=…", "path": "/home/ada/Imported/old-laptop", "label": "private/untrusted", "files": 18234}],
  "installer": {"version": "1.0.0", "media": "gen:fsv256:…", "journal": "sha256:…"}
}
```

| Consumer | Part |
|---|---|
| hearth | `owner`, `machine.name`, `recovery.recipient`, `owners` (cloud seed) |
| vault | `vault`, `machine.machineKey`, `recovery.recipient` |
| ledger | `machine`, `installer.journal` (genesis receipts) |
| courier | `secureBoot`, `tpm.pcrlockCoveredPcrs` |
| config | digest check; `config` (cloud seed) |
| strata | `storage`, `imports` |
| vouch | `vouch` |
| fleet | `fleet` |

All TPM handles are those of §19.6; the bundle names the registry version instead of listing handles.

**Cloud seed.** On the `cloud` profile there is no interactive installer. The image boots a first-boot stage that fetches a DSSE-wrapped `keylos.firstboot/1` from the provider metadata service (path `keylos/firstboot` under the instance user-data or metadata attributes), verifies it against the fleet key pinned in the image's config (`fleet.seedKeys`), and refuses to continue on failure. Unsigned user-data is ignored entirely. Owners on cloud machines are fleet admins enrolled with quorum presence (§5.4). A seed bundle carries `owners` (the presigned owner-registry lines, genesis first, as JSON strings) and `config` (`{"statement": "<base64 presence/quorum-signed keylos.configgen/1 envelope>", "source": "oci://…#gen=fsv256:…"}`) instead of the interactive `owner` part; the seed stage runs in the UKI's `seed` profile (§20.6).
<!-- END protocols §20.13 -->

<!-- BEGIN protocols §20.18 (verbatim) -->
> **protocols 20.18 Quorum request (`keylos.quorum/1`)**

DSSE-signed by `service/hearth`; `keyChain` carries the `ledger.key.register` receipt for `hearth` (countersigned by the ledger with the machine key, §3.5), so a remote approver who knows the machine key verifies the hearth key without access to this machine's ledger:

```json
{"schema":"keylos.quorum/1","id":"q-…","machine":"key:sha256:…","purpose":"config.apply",
 "payloadType":"application/vnd.keylos.configgen+json; version=1","payload":"<base64 JCS payload>",
 "payloadDigest":"sha256:<digest of the DSSE PAE>","rendering":[{"title":"…","body":"…","mime":"text/x-diff"}],
 "threshold":2,"approvers":["key:sha256:…","key:sha256:…","key:sha256:…"],
 "created":"…","expires":"…","keyChain":"<base64 DSSE ledger.key.register receipt>"}
```

- Approvers verify the key chain and the hearth signature, review `rendering` and sign the **payload's** PAE (not the request) with §5.3; the resulting quorum envelope is the payload with ≥ `threshold` signatures by distinct owners.
- `expires − created ≤ 24 h`. `approvers` lists the credentials allowed by the owner registry at `created`.
<!-- END protocols §20.18 -->

<!-- BEGIN protocols §20.19 (verbatim) -->
> **protocols 20.19 Trustee shares and inheritance**

**Trustee shares** split the 32-byte recovery key secret (§20.21) into *n* shares with threshold *k* (2 ≤ k ≤ n ≤ 16) using Shamir over GF(2^8) per byte. Splitting needs presence (purpose `trustee.split`).

```json
{"schema":"keylos.trustee/1","set":"<base32 8 chars>","machine":"key:sha256:…","k":2,"n":3,"index":1,
 "share":"<base32 of 32 bytes>","check":"<first 8 hex of SHA-256(recovery secret)>","created":"…"}
```

The printed card carries this JSON as a QR (binary mode, error correction Q) and the `share` in 8-character groups. Reconstruction (recovery environment or `hearth`) verifies `check` before use. A new split invalidates nothing cryptographically; owners revoke old shares by rotating the recovery key.

**Inheritance note** (`keylos.inheritance/1`, optional): a note encrypted with HPKE to each listed trustee's public key, held by the owner's paired `vouch` phone. If the dead-man timer (`VouchLink.inheritance`) sees no owner login heartbeat for the configured number of days (≥ 30), the phone releases the encrypted note to the trustees. The note never contains a key; trustees still need *k* shares.
<!-- END protocols §20.19 -->

<!-- BEGIN protocols §20.21 (verbatim) -->
> **protocols 20.21 Recovery key**

- **Secret:** 32 random bytes generated by the installer.
- **Text form:** 64 lowercase hex digits in 8 groups of 8; each group is followed by a 2-hex-digit CRC-8 (polynomial 0x07, init 0x00) of that group's 4 bytes; groups are separated by `-`: `xxxxxxxxcc-xxxxxxxxcc-…`. The CRC lets the recovery environment point at a mistyped group. Input is case-insensitive and ignores spaces.
- **LUKS2 recovery keyslot:** passphrase = the 64 hex digits without separators and CRCs; LUKS2 applies Argon2id (m = 1 GiB, t = 4, p = 4).
- **Derivations** (HKDF-SHA256 over the 32-byte secret, salt empty, info strings): `"keylos-recovery-auth/1"` (TPM recovery auth object `0x81000105`), `"keylos-lockout/1"` (TPM lockout auth), `"keylos-recovery-signer/1"` (Ed25519 seed of the owner-registry `recoverySigner`), `"keylos-escrow/1"` (optional backup-escrow wrapping key), `"keylos-recovery-recipient/1"` (X25519 private key of the **recovery recipient**; its public half is stored at `/var/lib/keylos/recovery/recipient.pub` and in the first-boot bundle, and running services encrypt recovery copies to it with HPKE (§4): the owner-hierarchy auth and vault `recovery` slots), `"keylos-sb-pk/1"` (seed of the owner Secure Boot **PK**: an RSA-2048 key generated deterministically with HMAC-DRBG-SHA256 seeded by this output, per FIPS 186-5 appendix B.3.3, so the recovery environment can re-create it to sign KEK updates; the PK is never stored).
- `hearth`, `boot`, `installer` and the trustee tooling MUST use exactly this format.
<!-- END protocols §20.21 -->

<!-- BEGIN protocols §20.23 (verbatim) -->
> **protocols 20.23 Fleet commands (`keylos.fleet.command/1`) and org approvers (`keylos.fleetapprovers/1`)**

`/etc/keylos/fleet/approvers.json` (rendered by `config` from the fleet module; read by `hearth`, `rescue` and `broker`):

```json
{"schema":"keylos.fleetapprovers/1","org":"example-corp","commandQuorum":2,
 "approvers":[{"id":"ops-1","keyid":"key:sha256:…","spki":"<base64 DER>","alg":"fido2-es256"}]}
```

A fleet command is a DSSE envelope signed by at least `commandQuorum` distinct org approvers (§5.3 construction for FIDO2 approver keys, rpId `keylos.owner` of the approver's own machine):

```json
{"schema":"keylos.fleet.command/1","id":"fc-…","org":"example-corp","machine":"key:sha256:<machine key>",
 "command":"lock" | "wipe" | "unlock-org" | "unenrol","reason":"…","issued":"…","expires":"…","nonce":"<base64 16 bytes>"}
```

- `machine` MUST equal the receiving machine key; `expires − issued ≤ 24 h`; each `id` is accepted once (`hearth` keeps the ids of the last 30 days).
- `lock`: executed at once by `HearthFleet.lockAll`. `wipe`: locks at once; completed only at the next recovery entry after `rescue` also verifies an owner quorum envelope (§14.5). `unlock-org`: lifts an org lock (owner unlock still required). `unenrol`: starts unenrolment; effective only after an owner-signed config apply removes the fleet module.
<!-- END protocols §20.23 -->

### 2.3 Interpretation notes (normative for this repo)

1. **Owner index.** `ownerIndex` (protocols §20.3) is assigned at `genesis` (0) and at each `add-owner` (the lowest index never used on this machine). It is never reused, even after `remove-owner`, so a machine can have at most 16 owners over its lifetime (`i < 16`, protocols §19.6). Exceeding it needs a reinstall.
2. **Seal credential.** At most one credential per owner carries `credential.seal = true` on `touch` machines (protocols §20.3, §22.3); a touch-machine owner normally has exactly one, and none only transiently while it is replaced (§4.6.5: remove the old seal credential, then enrol a fresh one with `seal: true`; an existing credential is never re-marked, protocols E26); its `hmac-secret` chain drives the owner's seal gate. On `quorum` machines no credential carries it (the gate is driven by the quorum blob, §4.6.4).
3. **Quorum policy.** `HearthAdmin.setQuorumPolicy(mode, quorum, threshold)` is the only way to change `policy` (protocols §7.5.3, §20.3); it appends a `set-quorum` entry. The superseded `HearthAdmin.setQuorum` always fails `kl:unsupported`.
4. **Presence rendering.** Every presence prompt is rendered by `atrium`. For callers on facet `presence`, `hearth` calls `TrustedPrompt.presence(purpose, payload, rendering)` on `atrium#presence`; `atrium` renders and calls back `Hearth.presence` on `hearth#atrium`, where `hearth` performs the CTAP exchange without prompting again. Calls on `hearth#atrium` never call `atrium` (no recursion). Callers that need a rich rendering (a config plan diff) hold `atrium#presence` themselves and call `atrium` directly.
5. **Sealed NV authorization files.** `/var/lib/keylos/tpm/nv-auth/<index>.sealed` (protocols §10.7, §19.6) names files by index in the form `0x` + 8 lowercase hex digits, for example `/var/lib/keylos/tpm/nv-auth/0x01300105.sealed`. The file content is exactly `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` of the sealed object, with no wrapper. Every nv-auth file — `hearth`'s own and those it writes for other services (`vault`'s `0x01300104`/`0x01300110`/`0x01300111`, `ledger`'s `0x01300100`, …) — uses the one object template and policy of protocols §19.6 (E7): a keyedHash sealed data object under the SRK `0x81000001`, `fixedTPM|fixedParent|adminWithPolicy|noDA`, production policy `PolicyAuthorize(PCR11 ready) ∧ PolicyPCR(15)`, development fallback `PolicyPCR(15)` (development builds only; the reader recognises the variant from the object's authPolicy). The same template and policy apply to `hearth`'s hierarchy blobs, service key, quorum gate blobs and kiosk factor.
6. **Hierarchy authorization blobs.** The owner and endorsement hierarchy authorizations (protocols §19.6) are TPM-sealed objects at `/var/lib/keylos/tpm/hierarchy-owner.sealed` and `/var/lib/keylos/tpm/hierarchy-endorsement.sealed` (protocols §10.7; same `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` format as note 5), written by `installer` at genesis and by `hearth` on rotation, read only by `hearth`. The owner authorization's recovery copy is `/var/lib/keylos/tpm/hierarchy-owner.recovery` (§4.7.1). The quorum seal-gate blobs are `/var/lib/keylos/hearth/seal-gate-<i>.sealed`, and the assisted platform authenticator blobs are `/var/lib/keylos/hearth/platform/<keyid>.blob` (protocols §10.7).
7. **Signing quorum requests.** A quorum request is DSSE-signed by `service/hearth`, and its payload's `keyChain` field carries the `ledger.key.register` receipt in which the ledger (countersigned by the machine key) registered the `service/hearth` key (protocols §20.18). Approvers verify the receipt with the machine key, then the request with the registered key.
8. **Fleet commands.** `HearthFleet.lockAll` receives a `keylos.fleet.command/1` envelope (protocols §20.23) and applies the commands that concern sessions: `lock`, the lock part of `wipe`, and `unlock-org`. It verifies the signatures against `/etc/keylos/fleet/approvers.json` (`keylos.fleetapprovers/1`, protocols §10.7: ≥ `commandQuorum` distinct approvers) and accepts each command `id` once, keeping the ids of the last 30 days (§4.9). It never reads `fleet`-local files.
9. **Organisation unlock.** An org lock is lifted by a verified `unlock-org` command (note 8) or, when the organisation cannot be reached, by an owner decision: a presence envelope of purpose `mandate` over a `keylos.mandate/1` with effect `{"kind": "x-hearth.org-unlock", "target": "<user>"}` (a repo-local effect kind, protocols §14.2 `x-` rule) (quorum presence on quorum machines). Either way each user then unlocks their own session with normal authentication (protocols §20.23).
10. **Login methods.** `Hearth.login` accepts exactly the methods of protocols §7.3.12: `password`, `pin`, `fido2`, `guest`, `kiosk`. The hearth platform authenticator (§4.4.5) is a FIDO2 authenticator: a login credential of `kind: platform` is used with method `fido2` and the PIN as `response`. There is no recovery login: the recovery environment (`rescue`, installer spec) opens vault `recovery` slots itself (note 11), and `hearth` does not run there.
11. **Recovery recipient.** Vault `recovery` slots and the owner-authorization recovery copy are encrypted to the recovery recipient (protocols §5.2, §20.21), whose 32-byte public key is `/var/lib/keylos/recovery/recipient.pub` (protocols §10.7). `hearth` never holds the recovery secret: it asks `vault` for a `recovery` slot (`SlotSpec.kind = recovery`, factor absent, protocols §7.5.4) when it creates a user, and re-encrypts the hierarchy copy to the recipient after every rotation.
12. **TPM access and development knobs.** `hearth` uses the `/dev/tpmrm0` fd named by `KEYLOS_TPM_FD` (protocols §10.5, E8); development builds may use `KEYLOS_DEV_TPM_TCTI` instead and the software CTAP device `KEYLOS_DEV_HEARTH_SOFT_AUTHENTICATOR`. Production builds ignore every `KEYLOS_DEV_*` name.
13. **Approval IDs of hearth mandates.** Mandates for `hearth`'s own presence-confirmed effects (`x-hearth.*` kinds, §4.4.1) carry a fresh `a-` ULID minted by `hearth` (protocols §3.5, E13); it is never sent to the broker.
14. **Requesting human** of a service acting for a human (`_system` callers, §4.4.3) is taken from the payload: mandate `principal`, presence `requestedBy`, configgen `proposedBy`, seal-window `owner`; otherwise every owner's credentials are allowed.
15. **Secret entry on the trusted path.** Recovery-key entry (trustee split), card entry (trustee combine), new-PIN entry (platform enrolment) and passphrase entry use `TrustedPrompt.secret(title, body, confirm)` on `atrium#secret` (protocols §7.3.4, E19); the value arrives in the protocols §20.10 delivery format. `hearth trustee combine --card FILE…` also works offline. Until atrium serves `secret`, development builds read `hearth passwd` input from stdin.
16. **Mode changes.** Switching `policy.mode` from `touch` to `quorum` does not convert existing `hmac-secret`-driven seal gates; they stay touch-driven until the owner's gate is re-provisioned (`rescue` or re-enrolment). Quorum-genesis machines are blob-driven from the start.
17. **Repo-local methods.** The owner org-unlock decision and logout have no protocols method; they are `HearthCli.orgUnlock @14` and `HearthCli.logout @15` (§5.3).

---

## 3. Requirements

### 3.1 Users

- **REQ-HEARTH-001** Each human MUST have a `keylos.user/1` record (§4.1) and a home subvolume created with `StrataHomes.createHome`. Guest sessions use `StrataHomes.createEphemeralHome` and have no persistent record (§4.10).
- **REQ-HEARTH-002** Human UIDs MUST be allocated from 1000–58999 and never reused while a record or tombstone exists. Tombstones are kept for 1 year. UIDs 59000–59999 are reserved for guest sessions and MAY be reused 60 s after the guest session ends.
- **REQ-HEARTH-003** Creating, disabling or deleting a user, and changing owners or the presence policy, MUST require owner presence (`HearthAdmin` methods marked "presence" in protocols §7.5.3); on quorum machines, a quorum presence envelope (protocols §5.4).
- **REQ-HEARTH-004** `exportPasswd` MUST produce `passwd`/`group` content with home `/home/<name>`, shell `/usr/bin/kish` and password field `x`, including active guest sessions.
- **REQ-HEARTH-005** Usernames MUST match protocols §3.3; `_system`, `_cluster` and the `guest-` prefix MUST be refused for ordinary users.

### 3.2 Authentication

- **REQ-HEARTH-010** Login methods MUST be exactly those of protocols §7.3.12 (§2.3 note 10): `password` (passphrase), `pin` (≥ 6 digits, only on machines with the TPM failure counter, §4.3), `fido2` (a roaming security key with UV, rpId `keylos.login`, empty `response`; or the hearth TPM platform authenticator, §4.4.5, with the PIN as `response`), `guest` (only when guest sessions are enabled; `user` and `response` empty) and `kiosk` (only on the `kiosk` profile; `user` empty or the configured kiosk user, `response` empty). Any other method MUST fail `kl:invalid`.
- **REQ-HEARTH-011** Successful authentication MUST unlock the user's vault slot (`VaultUsers.unlockUser`), unlock the user's crypto-shred units (`StrataAdmin.unlockUnits`), and return a new session ID (`s-` ULID) recorded as authenticated for `validateSession`.
- **REQ-HEARTH-012** Failed attempts MUST be rate-limited per user: waits of 1, 2, 4, 8 and 16 s after failures 1–5, then 300 s after every further failure, persisted against rollback with the TPM NV counter `0x01300106` (§4.3); a rolled-back `attempts.json` (NV counter ahead) imposes 300 s from detection until a successful login.
- **REQ-HEARTH-013** `lock(session)` MUST mark the session locked and notify `atrium`. With `lockOnSuspend = vault` (laptop default) it additionally locks the vault slot and the user's units and freezes the user's agent sessions with `PrincipalControl.terminate(session, freeze)`. `unlock` reverses these (`thaw`), except for sessions locked by an organisation lock (§4.9).
- **REQ-HEARTH-014** Passwords and PINs MUST arrive only on facet `greeter` from `atrium`'s trusted greeter or lock surface. They are verified through the vault slot. `hearth` stores no password hash.
- **REQ-HEARTH-015** `login(user, "kiosk", empty)` MUST be accepted only on the `kiosk` profile, only for the user named in `hearth.kiosk.user` (an empty `user` means that user), and only from `atrium`'s greeter at session start; it unlocks the user's vault slot with the kiosk slot factor sealed for `hearth` (PCR11 `ready` ∧ PCR15), so the kiosk user needs no secret. Owners MUST NOT be kiosk users.

- **REQ-HEARTH-016** **User lock state.** `HearthSystem.userState(user)` (protocols §7.5.3) MUST return `locked = false` exactly when `user` has at least one login session that is authenticated and not locked, and `locked = true` otherwise (no session, every session locked, logged out, or the user disabled, org-locked or deleted); `since` is the time of the last change of that value (the user's creation time if it never changed). It is served on facet `system` to `loom` only (protocols §19.2); other `system` holders get `kl:denied`. An unknown user returns `locked = true`.
- **REQ-HEARTH-017** `HearthSystem.watchUsers(watcher)` (facet `system`, holder `loom` only) MUST deliver one JCS event `{"user", "locked", "since", "deleted"}` for every change of a user's `userState` (login, unlock, lock, logout, suspend lock, org lock and unlock, disable) and one with `"deleted": true` when a user is deleted, in the order the changes took effect, before the corresponding call returns to its caller; `deleted` is `false` otherwise. A new watcher first receives no backlog (callers read `userState` for initial state). Lock state changes MUST be delivered within 200 ms. Durable workflows of a locked owner pause on these events (protocols §20.25); hearth enforces nothing about workflows itself.

### 3.3 Presence

- **REQ-HEARTH-020** `presence(purpose, payload)` MUST validate that `payload` is JCS-canonical with the `schema` registered for `purpose` (protocols §20.2), obtain a FIDO2 assertion (rpId `keylos.owner`, UP always, UV per purpose) from an enrolled owner credential over `clientDataHash = SHA-256(DSSE-PAE(payloadType, payload))`, and return the DSSE envelope of protocols §5.3.
- **REQ-HEARTH-021** Presence requests on facet `presence` MUST be rendered on the trusted path through `atrium` (§2.3 note 4) before the assertion is collected.
- **REQ-HEARTH-022** Each assertion MUST produce a `presence.assert` receipt with `purpose`, payload digest, credential key ID, the UV flag and `assisted`.
- **REQ-HEARTH-023** `signCount` MUST be checked for monotonicity when the authenticator returns a non-zero counter. A regression raises a critical alarm and rejects the assertion.
- **REQ-HEARTH-024** An assisted credential (protocols §5.3, `credential.assisted`) MUST be refused for a purpose the policy excludes (`config.presence.assistedAllowed`), and every prompt that may use one MUST say so.
- **REQ-HEARTH-027** `presence(purpose, payload, assist)` MUST accept a non-empty `assist` only on facet `atrium` and only when the assertion is made with an assisted platform credential; `assist` then carries the trusted-path confirmation and the PIN (§4.4.5). A non-empty `assist` on any other facet, or for a roaming authenticator, MUST fail `kl:invalid`.
- **REQ-HEARTH-025** On quorum machines (`policy.mode = "quorum"`), `presence` MUST NOT perform a local assertion. It MUST create a quorum request (§4.8) and fail `kl:needs-approval:<q-id>`; callers obtain the envelope with `HearthQuorum.collect`.
- **REQ-HEARTH-026** A presence request whose requesting principal's human is not an owner (family machines) MUST be queued for the owners and fail `kl:needs-approval:<fi-id>` with a family inbox ID (`fi-` ULID, protocols §3.5; never an `a-` approval ID) (§4.11); it MUST NOT be shown to the non-owner as a touch prompt.

### 3.4 Owner registry

- **REQ-HEARTH-030** The owner registry MUST follow protocols §20.3 exactly: JSON Lines of presence-signed `keylos.owners-entry/1` DSSE envelopes with only the ops and fields listed there.
- **REQ-HEARTH-031** After every append, `hearth` MUST write the 104-byte head to NV `0x01300105` (protocols §19.6). On start it MUST read the NV value through the `PolicyCommandCode(NV_Read)` branch, recompute the head from the log and compare; a mismatch raises an owner-registry alarm (§7).
- **REQ-HEARTH-032** `HearthSystem.owners` MUST return the `keylos.owners/1` export on facet `system` to `config` (which copies `sealKey`s to `/etc/keylos/owner-seal/<ownerIndex>.spki`), `broker`, `warden`, `devd` and to the `owners`-only holders `gate`, `vouch`, `strata`, `bench` and `depot` (presence and mandate verification, owner display); `owners`-only holders MUST be refused every other `HearthSystem` method (protocols §19.2).
- **REQ-HEARTH-033** Policy changes (`mode`, `quorum`, `threshold`) MUST be made only through `HearthAdmin.setQuorumPolicy` and written as `set-quorum` entries signed by `policy.quorum` current owners; `quorum` is a single number used for both adding and removing owners (protocols §20.3). `HearthAdmin.setQuorum` MUST fail `kl:unsupported`. Switching to `mode = "quorum"` MUST require `threshold ≤` the number of owners with at least one credential.
- **REQ-HEARTH-034** On quorum machines, owner-set and credential changes MUST be signed by `policy.threshold` distinct owners, and a new owner's own credential signature (produced remotely, §4.8.5) MUST be included in `add-owner` and `enroll-credential` entries. Adding a further credential for an existing owner on a quorum machine has no flow in 1.0 (`kl:unsupported`); remote `add-owner` is supported.

### 3.5 Sealing windows

- **REQ-HEARTH-040** `HearthSeal.openWindow(windowJson)` MUST require a fresh presence touch over the `keylos.seal-window/1` payload (purpose `seal.window`), with `expires − opened ≤ 600 s`, one project and a `drvs` list. On quorum machines it MUST require a quorum envelope of purpose `seal.window` instead.
- **REQ-HEARTH-041** `sealSign` MUST sign only `keylos.seal/1` or `keylos.genstmt/1` statements whose `drv` is in the window's `drvs`; seal statements MUST additionally have `sealedAt` inside the window and `window`/`windowDigest` naming this window. Any `hearth#seal` holder MAY sign within a window another holder opened (protocols §7.5.3). After expiry, `closeWindow`, or the first out-of-scope request, the window closes and the gate authorization rotates (§4.6).
- **REQ-HEARTH-042** At most one window per owner may be open at a time.
- **REQ-HEARTH-043** The seal mechanism MUST satisfy protocols §11.6 (a) and (b): no seal signature without a fresh touch-authorized (or quorum-authorized) window; a captured auth value is useless after the window closes.
- **REQ-HEARTH-044** The `seal.window` receipt MUST carry `windowDigest` (SHA-256 of the presence-signed window envelope bytes) at open (protocols §11.6).
- **REQ-HEARTH-045** The `hmac-secret` salts MUST be `s_k = SHA-256("keylos-seal" ‖ u64_be(k))` with the assertion carrying `(s_k, s_{k+1})` (protocols §19.6).

### 3.6 TPM owner hierarchy

- **REQ-HEARTH-050** `hearth` MUST be the only userspace process that holds the owner and endorsement hierarchy authorizations (protocols §19.6). It MUST NOT expose them, and MUST perform owner-hierarchy operations for other services only through `HearthTpm`.
- **REQ-HEARTH-051** `HearthTpm.defineSpace(index)` MUST accept only indices listed in protocols §19.6 and only from the index's registered owner service (the connection's peer principal), MUST (re)define the index exactly from the `keylos-tpm-registry` template, MUST generate a fresh random 32-byte authValue for AUTHWRITE indices (including `vault-epoch/0` and `vault-epoch/1`, `0x01300110`/`0x01300111`, protocols E1, E28) and seal it to `/var/lib/keylos/tpm/nv-auth/<index>.sealed` in the nv-auth format and policy of protocols §19.6 (§2.3 note 5), and MUST write a `key.enroll` receipt with `data.nv = <index>`. After genesis it is the only way any service obtains an NV index (protocols E7).
- **REQ-HEARTH-052** `HearthTpm.evict(handle)` MUST accept only handles listed in protocols §19.6. It MUST require owner presence (purpose `boot.tpm-evict`) except for `0x81000103`, which only `vault` may evict and only once (first boot).
- **REQ-HEARTH-053** `HearthTpm.sbSign(which, payload, presenceEnvelope)` MUST accept only `courier` as caller, verify the presence envelope (purpose `boot.sb-sign`, `details.payloadDigest = SHA-256(payload)`) and sign with `0x81000101` (`kek`) or `0x81000102` (`db`) through a seal-gate policy session that rotates the gate afterwards.
- **REQ-HEARTH-054** Adding or removing an owner MUST re-create the KEK and db signers with the new policy (protocols §19.6) and stage the firmware re-enrolment of their certificates through `courier` (§4.7.4).
- **REQ-HEARTH-055** `hearth` MUST rotate the owner hierarchy authorization when an owner is removed and after every recovery (`recover` entry), re-sealing the hierarchy blob and re-encrypting the recovery copy to the recovery recipient (§4.7.1).
- **REQ-HEARTH-056** `HearthTpm.activateCredential(akHandle, credentialBlob, encryptedSecret)` MUST accept only `vouch` and `fleet` as callers and only `akHandle` ∈ {`0x81010002`, `0x81010003`} (protocols §7.5.3), MUST run `TPM2_ActivateCredential` with the EK as key handle under `PolicySecret(TPM_RH_ENDORSEMENT)`, MUST return only the recovered secret, and MUST write a `key.enroll` receipt with `data.activation = {akHandle, caller}`. Malformed blobs fail `kl:invalid`; a TPM refusal fails `kl:integrity`.
- **REQ-HEARTH-057** `HearthTpm.recreateKey(handle, presenceEnvelope)` MUST accept only persistent handles listed in protocols §19.6 whose registered owner is the caller (owner column, protocols E25: `0x81000110` strata, `0x81000120` fleet; `0x81000103` vault may only `evict`; every other handle is hearth's and is not re-creatable through `HearthTpm`), MUST verify a presence envelope of purpose `boot.recreate-key` with `details.handle = <handle>` (a quorum envelope on quorum machines), MUST refuse if the handle currently holds an object whose public area matches the template (`kl:conflict`), and MUST re-create the key from the `keylos-tpm-registry` template with the owner hierarchy authorization, writing `key.enroll{handle, reason: "recreate"}`.
- **REQ-HEARTH-059** `HearthTpm.sbAccepted(kekCert, dbCert)` (protocols §7.5.3, E20) MUST accept only `courier`, MUST check that the digests equal the certificates of the staged signers (`kl:conflict` if nothing is staged or they differ), and then MUST perform the swap of §4.7.4 and write the `set-secureboot-certs` entry.
- **REQ-HEARTH-058** The staging handles `0x81000180`–`0x81000183` (protocols §19.6) MUST be used only during the KEK/db signer re-creation ceremony (§4.7.4) and MUST be empty outside it. At start, `hearth` MUST treat an occupied staging handle as an interrupted ceremony and resume or roll it back (§4.7.4).

### 3.7 Quorum presence

- **REQ-HEARTH-060** `HearthQuorum.request` MUST produce a `keylos.quorum/1` request (protocols §20.18), DSSE-signed by `service/hearth`, with `keyChain` = the `ledger.key.register` receipt for `hearth`, `threshold = policy.threshold`, `approvers` = the credentials the registry allows at creation, and `expires − created ≤ 24 h`, and write a `quorum.request` receipt.
- **REQ-HEARTH-061** `submit` MUST verify each signature with `keylos-presence` against the payload PAE (not the request), the credential's presence in `approvers`, and the owner registry state at the request's `created` time. Signatures by a second credential of an owner already counted MUST be stored but not counted (protocols §5.4: distinct owners).
- **REQ-HEARTH-062** `collect` MUST return `kl:needs-approval:<q-id>` until `threshold` distinct owners have signed, then return the quorum envelope (the payload with the collected signatures) and write `quorum.complete`.
- **REQ-HEARTH-063** Expired requests MUST be refused by `submit` and `collect` (`kl:expired`) and purged after 7 days.
- **REQ-HEARTH-064** On quorum machines the seal gate authValue MUST be released only after verifying a quorum envelope of purpose `seal.window` (or `boot.sb-sign` for KEK/db signing) and MUST be rotated and re-sealed at window close.
- **REQ-HEARTH-065** `hearth presence --remote <request>` (§4.8.4) MUST verify the request's signature chain and render its `rendering` on the trusted path before the local credential signs.
- **REQ-HEARTH-066** `status` MUST show `sealing: quorum` and the threshold on quorum machines (protocols §5.4).

### 3.8 Organisation lock

- **REQ-HEARTH-070** `HearthFleet.lockAll` MUST accept only a `keylos.fleet.command/1` envelope (protocols §20.23) with `command` ∈ {`lock`, `wipe`, `unlock-org`}, `machine` = the machine key, `org` = the `org` of `/etc/keylos/fleet/approvers.json`, `issued ≤ now < expires` and `expires − issued ≤ 24 h` (trusted time, protocols §3.6), an `id` not accepted in the last 30 days, and signatures by ≥ `commandQuorum` distinct approvers of `approvers.json` (each verified with `keylos-presence` against the approver's `spki`). On a machine without `approvers.json` (not fleet-enrolled) it MUST fail `kl:denied`. `unenrol` commands are not session commands and MUST be refused by `lockAll` (`kl:invalid`).
- **REQ-HEARTH-071** On acceptance `hearth` MUST lock every human session, revoke every agent session with `BrokerSystem.revokeSession(s, "kill")`, mark the sessions `orgLocked`, and write `user.lock{reason: "org"}`.
- **REQ-HEARTH-072** An `orgLocked` session MUST NOT unlock with ordinary authentication alone; the org lock must first be lifted by a verified `unlock-org` command or an owner decision (§2.3 note 9), followed by the user's normal authentication.

### 3.9 Guests and family machines

- **REQ-HEARTH-080** Guest sessions MUST be offered only when `hearth.guest.enabled` is true. A guest session MUST use a `guest-<8 lowercase base32>` username, a UID from 59000–59999, an ephemeral home (`StrataHomes.createEphemeralHome`) and an ephemeral vault user; all MUST be destroyed at logout, and `guest.start`/`guest.end` receipts written.
- **REQ-HEARTH-081** Guests MUST never receive presence prompts, owner functions, persistent grants, or agent sessions unless `hearth.guest.agents` is true (protocols §14.3).
- **REQ-HEARTH-082** A non-owner's request needing an owner (config proposal applied, seal window, persistent grant, policy change, user administration) MUST be queued in the owner inbox (§4.11) and shown on the next owner trusted-path session with `requester` set, or routed to an owner's paired phone only as a notification (never satisfying presence).

### 3.10 Recovery key and trustees

- **REQ-HEARTH-090** Recovery key text MUST be parsed and validated exactly per protocols §20.21 (64 hex digits in 8 groups of 8, each with a CRC-8); a group with a bad CRC MUST be reported by position.
- **REQ-HEARTH-091** The recovery signer MUST be derived as the Ed25519 seed `HKDF-SHA256(recovery secret, salt = empty, info = "keylos-recovery-signer/1")`; `recover` entries are written only by the recovery environment (`rescue`, installer spec); on replay `hearth` MUST accept a `recover` entry only when signed by that key, and MUST refuse to append one itself.
- **REQ-HEARTH-092** `hearth trustee split` MUST require presence (purpose `trustee.split`), MUST obtain the recovery secret from the owner on the trusted path, MUST verify it against the registry's `recoverySigner`, and MUST produce `keylos.trustee/1` shares per protocols §20.19 without storing the secret or the shares.
- **REQ-HEARTH-093** Reconstruction from shares (recovery environment or `hearth trustee combine`) MUST verify each share's `check` and `set` before use.
- **REQ-HEARTH-094** `hearth` MUST give every owner a vault `recovery` slot at user creation (`SlotSpec.kind = recovery`, factor absent, `params = {}`; `vault` wraps the user key to the recovery recipient and creates a recovery slot only when one is requested, protocols §7.5.4, E11), non-owners too when `hearth.recoverySlots = 'all`, and nobody with `'none` (default `'owners`). When the recovery recipient changes (`keylos-enrol recovery-key`, installer spec), `hearth` MUST replace every `recovery` slot (`addSlot` then `removeSlot`) and re-encrypt the hierarchy copy (§4.12.3).

---

## 4. Design

### 4.1 User records (`keylos.user/1`)

Stored at `/var/lib/keylos/hearth/users/<name>.dsse`, DSSE-signed by `service/hearth`:

```json
{
  "schema": "keylos.user/1",
  "name": "alice",
  "uid": 1000,
  "displayName": "Alice Example",
  "owner": true,
  "ownerIndex": 0,
  "created": "2026-10-07T21:30:00Z",
  "disabled": false,
  "locale": "en_GB.UTF-8",
  "timezone": "Europe/London",
  "methods": ["password", "fido2"],
  "loginCredentials": [
    {"keyid": "key:sha256:…", "credentialId": "<base64url>", "cose": "<base64 COSE_Key>", "rpId": "keylos.login",
     "label": "Blue key", "uv": true, "transports": ["usb", "nfc"], "vaultSlot": "slot-01JB…", "kind": "roaming"}
  ],
  "vaultSlots": ["slot-01JB…", "slot-01JB…", "slot-01JB…"],
  "slots": [{"slotId": "slot-01JB…", "kind": "password|pin|kiosk|fido2|recovery", "salt1": "<base64>", "keyid": "key:sha256:…"}],
  "mustEnroll": false,                     // the next login must enrol a new credential or password (after recovery)
  "vaultRecovery": true,                   // a recovery slot exists (REQ-HEARTH-094)
  "lockOnSuspend": "vault",
  "agentDefaults": {"maxConcurrentSessions": 4}
}
```

- **The `service/hearth` key** is an Ed25519 key sealed under the SRK `0x81000001` with policy `PolicyAuthorize(release-stream PCR11 key, phase "ready") ∧ PolicyPCR(15)` (`/keystore/hearth/service-key.sealed`). It signs receipts, user records and quorum requests. HMAC keys for `attempts.json`, `seal-salts.json`, `inbox.json` and `fleet-commands.json` are derived from it with HKDF (`info` = file name).
- Owner credentials (rpId `keylos.owner`) live only in the owner registry. Each enrolment of a roaming FIDO2 authenticator creates **two** credentials on it: one for `keylos.owner` (presence and seal gate) when the user is an owner, and one for `keylos.login` (login and vault slot).
- `kind` is `roaming` (CTAP device) or `platform` (the hearth TPM platform authenticator, §4.4.5).
- `slots` records which vault slot is the password, PIN, kiosk, FIDO2 or recovery slot and the FIDO2 `salt1` (the S2 implementation's `x-slotKinds`, `x-slotSalts`, `x-mustEnroll` become these members; the provisioning markers `x-vaultPending`/`x-pendingSalt` stay repo-local state, not authority). `loginCredentials[].credentialId` is base64url here, while `SlotSpec.params` for vault carry standard base64 (protocols §7.5.4, E11).

### 4.2 Home creation and deletion

`HearthAdmin.createUser(name, displayName, owner)` (presence: the `add-owner` registry entry for owners, purpose `owners.entry`; a mandate for non-owners, purpose `mandate`, §4.4.1):
1. Presence (or quorum presence).
2. Allocate the UID.
3. `StrataHomes.createHome(name, uid)`: the `/home/<name>` subvolume owned by the UID, mode 0700, with `.apps/`.
4. Credential ceremony on the trusted path (FIDO2 `makeCredential` for `keylos.login`, and for `keylos.owner` when owner; password if chosen). On quorum machines the owner credential is provided remotely (§4.8.5).
5. `VaultUsers.createUser(name, slots)` with the password or FIDO2 login slots and, for owners (or all users with `hearth.recoverySlots = 'all`), a `recovery` slot with no factor (§2.3 note 11).
6. For owners: an `add-owner` registry entry (§4.5) with the next `ownerIndex`, the new owner's seal gate and owner-seal key (§4.6.1), `sealKey`, and re-creation of the KEK/db signers (§4.7.4).
7. Write the record; receipts `user.create` and one `key.enroll` per credential.

`deleteUser(name, forgetData)`: presence; refuse for the last owner and for any removal that would leave fewer owners than `policy.threshold` on quorum machines; `BrokerSystem.revokeSession(kill)` for all the user's sessions; `VaultUsers.deleteUser`; `StrataHomes.deleteHome(name, forget = forgetData)`; for owners a `remove-owner` entry, undefinition of the seal gate and eviction of the owner-seal key (the public key stays in the registry history so earlier seals remain verifiable), re-creation of the KEK/db signers and rotation of the owner hierarchy authorization; tombstone; receipt `user.delete`.

**Home layout:**

```
/home/<name>/                    subvolume, nosuid,nodev,noexec
  .apps/<app-name>/{config,data,cache,state}   subvolumes created lazily by strata
  Documents/ Downloads/ Projects/ Pictures/ Music/ Videos/ Desktop/   (plain dirs; localized names via XDG user-dirs in config)
```

At-rest protection of plain home files is LUKS2; per-user unit encryption and locking are `strata`'s (`StrataAdmin.lockUnits`).

### 4.3 Authentication flows

**Password/PIN.** `atrium`'s greeter collects the secret and calls `login(user, "password", secret)` on facet `greeter`. `hearth` passes the raw passphrase or PIN bytes to `VaultUsers.unlockUser(user, passwordSlot, fd)` in a delivery-format fd (the vault runs Argon2id with the slot's parameters, protocols §7.5.4); success means the password is correct. Zeroize.

**FIDO2.** `login(user, "fido2", empty)`:
1. Enumerate FIDO HID devices (`Devd.list("hidraw")`, usage page `0xF1D0`) and open them with `Broker.materialize` of the device grant `hearth` holds (§4.14).
2. `authenticatorGetAssertion(rpId = "keylos.login", allowList = user's login credentials, uv = required, hmac-secret{salt1 = slot salt})`.
3. Verify the assertion with the stored COSE key; the `hmac-secret` output is the vault slot factor. FIDO2 slot params are `{"credentialId", "rpId": "keylos.login", "salt1"}` in standard base64.

**Platform authenticator.** `login(user, "fido2", pin)` when the user's login credential is the hearth TPM platform authenticator (`kind: platform`, §4.4.5): rpId `keylos.login`; the PIN is entered on the greeter.

**Recovery.** `hearth` does not run in the recovery environment (its service key is sealed to PCR11 `ready`). Vault `recovery` slots are opened there by `rescue` with the recovery recipient private key derived from the recovery key (installer spec). After a recovery that re-anchored the registry, the next normal boot forces the affected owner to enrol a new credential or password before their session proceeds.

**Kiosk.** `login("", "kiosk", empty)` (REQ-HEARTH-015): the configured kiosk user's session, unlocked with its sealed kiosk slot factor.

**Guest.** `login("", "guest", empty)` on facet `greeter`, when enabled (§4.10).

**Rate limiting.**
- Per-user failure counters in `/var/lib/keylos/hearth/attempts.json` (HMAC'd).
- NV `0x01300106` (counter, `AUTHWRITE` with the authValue sealed at `/var/lib/keylos/tpm/nv-auth/0x01300106.sealed`, `NO_DA`) is incremented on every failure and recorded in the file. Its value is read through the `PolicyCommandCode(NV_Read)` branch. If the file's recorded value is below the NV value, the file was rolled back and the maximum backoff applies until a successful login.
- PIN logins require the counter; without a TPM (degraded profile) passphrases of ≥ 12 characters are required.

**Sessions.** `login` returns `s-<ULID>`. `validateSession` returns `{user, authenticatedAt, methods, locked}`; `warden` calls it before accepting a `shell` principal for that session. Multiple sessions per user are allowed.

### 4.4 Presence envelopes

#### 4.4.1 Purposes

Exactly protocols §20.2. Mapping of `hearth`'s own operations:

| Operation | Purpose | Payload |
|---|---|---|
| Owner-set, credential, Secure Boot certificate and policy changes, recovery re-anchor | `owners.entry` | `keylos.owners-entry/1` |
| Open a seal window | `seal.window` | `keylos.seal-window/1` |
| Create, disable or delete a non-owner user; organisation unlock | `mandate` | `keylos.mandate/1` with effect `{kind: "x-hearth.user-<op>", target: "<name>", digest}` (`<op>` ∈ `create`, `disable`, `delete`; `x-hearth.org-unlock`; repo-local kinds, protocols §14.2) |
| Evict a persistent TPM handle | `boot.tpm-evict` | `keylos.presence/1` with `details.handle` |
| Owner Secure Boot signing (verified, produced by `courier`'s flow) | `boot.sb-sign` | `keylos.presence/1` with `details.payloadDigest` |
| Trustee split | `trustee.split` | `keylos.presence/1` with `details.k`, `details.n`, `details.set` |

#### 4.4.2 Construction

Exactly protocols §5.3, using `keylos-presence` helpers. `allowList` = the owner credentials of the requesting human if that human is an owner, else every owner's credentials (family routing, §4.11). The envelope's single signature object carries `alg` `fido2-es256` or `fido2-eddsa`.

#### 4.4.3 Flow on facet `presence` (touch machines)

```
caller → Hearth.presence(purpose, payload, empty)                  [hearth#presence]
  hearth: validate schema/purpose; check registry alarm state; resolve requesting human
  if requester is not an owner → queue in owner inbox, fail kl:needs-approval:fi-… (§4.11)
  hearth → atrium TrustedPrompt.presence(purpose, payload, rendering)   [atrium#presence]
     atrium renders the payload on the trusted path
     atrium → Hearth.presence(purpose, payload, assist)             [hearth#atrium]
        (assist empty for roaming keys; confirmation + PIN for an assisted credential, REQ-HEARTH-027)
        hearth: CTAP getAssertion (touch, UV per purpose) → envelope; receipt presence.assert
     atrium ← envelope
  hearth ← envelope (verify with keylos-presence before returning)
caller ← envelope
```

Timeout: `hearth.presence.timeoutSecs` (default 120 s) → `kl:expired`.

#### 4.4.4 Flow on quorum machines

`Hearth.presence(purpose, payload)` calls `HearthQuorum.request(purpose, payload, rendering = [])` internally and fails `kl:needs-approval:q-…`. The caller waits for `quorum.complete` (watching `ledger` or retrying) and calls `HearthQuorum.collect(q-…)` on facet `presence`. `atrium` is not involved; there may be no display.

#### 4.4.5 Assisted presence: the TPM platform authenticator

For owners who cannot operate a roaming key (protocols §5.3, "Accepted authenticators"):
- **Credential.** An ECC P-256 signing key created under the SRK, `userWithAuth` **clear**, authValue = `HKDF-SHA256(PIN (UTF-8, NFKC), salt = 16 random bytes stored with the key, info = "keylos-platform-authn/1")`, authPolicy `PolicyPCR(sha256:{15}) ∧ PolicyAuthValue` (protocols §5.3, E9): the PIN-derived authValue is always required, PCR15 alone never suffices. Dictionary-attack protection of the TPM applies (NO_DA clear).
- **Blob.** `/var/lib/keylos/hearth/platform/<keyid>.blob` (protocols §10.7; written by `installer` for credentials enrolled at install, by `hearth` otherwise) is JCS `{"rpId", "credentialId", "cose", "salt", "key", "hmacKey"}` with standard base64 members; `key` and `hmacKey` are `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` of the signing key and the platform seal (HMAC) key.
- **Assertion.** `hearth` builds `authenticatorData` exactly as a CTAP2 authenticator would: `rpIdHash` (`keylos.owner` or `keylos.login`), flags `UP | UV` (UP after the confirmation action, UV after the PIN), `signCount` (a per-credential counter in `/var/lib/keylos/hearth/platform-counters.json`, HMAC'd), and signs `authenticatorData ‖ clientDataHash` with the TPM key. The AAGUID is the fixed keylos platform AAGUID `6b6c7973-6865-6172-7468-706c61746631`.
- **User presence** is an explicit confirmation inside the atrium-drawn trusted prompt: a pointer click, the Enter key, or a switch-access action, never a timeout. **User verification** is the owner's PIN typed in that prompt. `atrium` passes both to `Hearth.presence` on `hearth#atrium` as `assist` = CBOR `{1: "confirm" | "switch" | "key", 2: <PIN UTF-8>, 3: <prompt id>}`; `hearth` checks the prompt id against the prompt it asked `atrium` to show and zeroizes the PIN after deriving the authValue. The prompt id is `sha256:<hex>` of the DSSE PAE of `payload` (protocols §7.3.12, E12), which `atrium` and `hearth` compute independently.
- **Enrolment** is an `enroll-credential` entry with `credential.assisted = true`, signed by an existing credential of the owner (or quorum). It is shown in `status`, in the `vouch` verdict and in every presence prompt that may use it (REQ-HEARTH-024).
- An assisted credential MAY be the owner's seal credential: its seal-gate chain then uses `hmac-secret`-equivalent outputs `o_k = HMAC-SHA256(platform seal key, s_k)`, where the platform seal key is a TPM keyed-hash object with the same authValue, `userWithAuth` clear and policy as the signing key.

#### 4.4.6 Signing for another machine (`hearth presence --remote`)

An owner of a remote machine (typically a headless quorum machine) signs on their own keylos machine:
1. `hearth presence --remote <request file | quorum id via fleet>` loads a `keylos.quorum/1` envelope.
2. `hearth` verifies the request's `keyChain` receipt with the remote machine key and the request signature with the registered `service/hearth` key (§2.3 note 7), checks `expires`, and verifies that one of the local owner's credentials is in `approvers`.
3. It renders the request's `rendering` and the decoded payload on the local trusted path (`atrium`), naming the remote machine by the machine key fingerprint and the name in the payload. The remote machine's SPKI comes from the fleet/vouch pairing in production; the S2 development store is `/etc/keylos/hearth/machines/<hex>.spki`.
4. One `getAssertion` with rpId `keylos.owner` over `clientDataHash = SHA-256(PAE(payloadType, payload))`, `allowList` = the local owner's credentials listed in `approvers`.
5. Output: the signed envelope (`payload` with one signature), written to a file or returned through `fleet` (`HearthQuorum.submit` on the remote machine).
6. Local receipt `presence.assert` with `data.remote = <machine key>` and `data.quorum = <q-id>`.

### 4.5 Owner registry

#### 4.5.1 Format and ops

File `/var/lib/keylos/hearth/owners.log`, format, fields and ops exactly protocols §20.3. `hearth`'s use of the ops:

| `op` | Fields written | Signed by (touch machines) | Signed by (quorum machines) |
|---|---|---|---|
| `genesis` | `owner`, `ownerIndex` = 0, `credential` (first; further credentials of the genesis owner follow as `enroll-credential` entries with `seq` 1…), `recoverySigner`, `sealKey`, `secureBootCert`, `policy` | The new credentials (installer) | Every listed owner's credential (installer or cloud seed, §4.8.6) |
| `add-owner` | `owner`, `ownerIndex`, `credential` (`seal: true` on touch machines), `sealKey`, `policy` (unchanged) | `policy.quorum` existing owners and the new credential | `policy.threshold` distinct existing owners and the new credential |
| `remove-owner` | `owner` | Quorum, with credentials other than the removed owner's | Threshold |
| `enroll-credential` | `owner`, `credential` (with `assisted`, `seal`) | An existing credential of the same owner | Threshold and the new credential |
| `remove-credential` | `owner`, `credential.keyid`; a following `enroll-credential` sets the new `seal` credential if the removed one carried it | Another credential of the same owner, or quorum | Threshold |
| `set-secureboot-certs` | `secureBootCert` (array of base64 DER certificates for the owner PK/KEK/db entries) | Quorum | Threshold |
| `set-quorum` | `policy` (`mode`, `quorum`, `threshold`) | `policy.quorum` current owners | `policy.threshold` current owners |
| `recover` | `owner`, `credential` (new, `seal: true`), optional new `recoverySigner`, `sealKey` when the seal key is re-created | `recoverySigner`, only in recovery mode | `recoverySigner`, only in recovery mode |

`recoverySigner` is the Ed25519 public key derived per REQ-HEARTH-091, written as `{"keyid": "key:sha256:<SPKI digest>", "spki": "<base64 DER>"}` (protocols §20.3). Earlier `sealKey` values of the same `ownerIndex` are **retired keys**: seal statements signed by a retired key remain valid only if their `sealedAt` precedes the entry that replaced it.

#### 4.5.2 NV anchoring

NV `0x01300105` (ordinary, 104 bytes, `AUTHWRITE`; authValue sealed at `/var/lib/keylos/tpm/nv-auth/0x01300105.sealed` with the PCR11 `ready` ∧ PCR15 policy; created by `installer` at genesis, re-created by `rescue` in recovery):

```
head = SHA-256(last envelope line bytes) ‖ u64 BE seq ‖ SHA-256(JCS owner-presence key set) ‖ SHA-256(JCS owner Secure Boot certificate set)
```

- The owner-presence key set is the JCS array of the sorted active owner credential key IDs (protocols §22.3; computed by `keylos-presence::Registry::head()`).
- The Secure Boot certificate set is the JCS array of base64 DER certificates from the newest `set-secureboot-certs` entry (empty array if none).
- Reads use the public `PolicyCommandCode(TPM2_CC_NV_Read)` branch (protocols §19.6), so `boot` and verifiers need no authorization.

On every append `hearth` writes the new head; on start it replays the log and compares (REQ-HEARTH-031). The write order is: append the line with `fsync` of the file and the directory, then write NV. A crash between the two leaves the log one entry ahead of NV; on start `hearth` accepts exactly one trailing entry beyond the NV head if it verifies, and completes the NV write (receipt `ledger.alarm` is not raised). More than one trailing entry, or a trailing entry that does not verify, is an alarm.

#### 4.5.3 Export for config, boot and gate

`HearthSystem.owners()` returns `keylos.owners/1` (`{"schema", "entries", "head", "seq"}`). `config` places it at `/etc/keylos/owners.json` and copies each current owner's `sealKey` to `/etc/keylos/owner-seal/<ownerIndex>.spki` (and retired keys as defined by the `config` spec). `boot` replays it, requires the computed head to equal NV `0x01300105`, and takes `keys.ownerPresence` and `keys.ownerSeal` of the boot trust set from it (protocols §20.1). `gate` uses it to verify presence-signed mandates (protocols §14.4).

### 4.6 Owner-seal keys and sealing windows

#### 4.6.1 TPM objects (per owner *i*)

Created by `installer` for the genesis owner(s) and by `hearth` at `add-owner`, with the owner hierarchy authorization `hearth` holds (§4.7.1):

- **Seal gate** NV `0x01300140 + i`: ordinary, 1 byte, used only for its authValue; attributes `POLICYWRITE`, `AUTHREAD`, `OWNERREAD`; `NO_DA` **not** set (dictionary-attack protection applies); `authPolicy = PolicyCommandCode(NV_ChangeAuth) ∧ PolicyAuthValue` (protocols §19.6).
- **Owner-seal key** `0x81000140 + i`: persistent ECDSA P-256 signing key under the owner hierarchy, `userWithAuth` clear, policy `PolicySecret(0x01300140 + i)`.

The NV Name does not depend on the authValue, so the key's `PolicySecret` binding survives every gate rotation and every recovery re-definition with the same template.

#### 4.6.2 The `hmac-secret` chain (touch machines)

For owner *i* with seal credential *c* and chain index *k* (persisted in `/var/lib/keylos/hearth/seal-salts.json`, HMAC'd):

```
s_k = SHA-256("keylos-seal" ‖ u64_be(k))       (protocols §19.6)
o_k = hmac-secret(c, s_k)                      (requires UP and UV)
```

The seal gate's current authValue is `o_k`. The salts do not include *i*: the chain is per credential, and each owner's seal credential is distinct.

#### 4.6.3 Window lifecycle (touch machines)

**Open** (`openWindow(windowJson)`):
1. Validate `keylos.seal-window/1`: `owner` = the requesting human (must be an owner), `expires − opened ≤ 600 s`, `machine` = the machine key, `id` = fresh `w-` ULID set by `hearth`.
2. Refuse if a window of this owner is open (REQ-HEARTH-042).
3. Render on the trusted path (as §4.4.3), then one `getAssertion` with `allowList = [c]`, `clientDataHash = SHA-256(PAE(window payload))` and `hmac-secret{salt1 = s_k, salt2 = s_{k+1}}`. It yields the presence signature over the window document and `o_k`, `o_{k+1}`.
4. Keep `o_k`, `o_{k+1}` in `memfd_secret` memory for the window's lifetime. Receipt `seal.window{op: "open", windowDigest, drvs, project, expires}`.
5. Return `(windowId, presenceEnvelope)`.

**Sign** (`sealSign(windowId, statementJson)`, any `hearth#seal` holder):
1. Parse `keylos.seal/1` or `keylos.genstmt/1`. For seal statements check `generation`, `drv ∈ drvs`, `sealedAt` inside the window, `window = windowId`, `windowDigest = SHA-256(window envelope bytes)`, `machine` = the machine key. For generation statements check `drv ∈ drvs` and `issued` inside the window.
2. Policy session `PolicySecret(0x01300140 + i)` with auth `o_k`; `TPM2_Sign(0x81000140 + i, SHA-256(DSSE-PAE(<media type of the statement>, statement)))`.
3. Return the DER ECDSA signature and `keyRef = key:sha256:<SPKI of 0x81000140 + i>`.
4. An out-of-scope request closes the window and fails `kl:denied`.

**Close** (expiry, `closeWindow`, or scope violation):
1. `TPM2_NV_ChangeAuth(0x01300140 + i, newAuth = o_{k+1})` in a policy session `PolicyCommandCode(NV_ChangeAuth) ∧ PolicyAuthValue` with auth `o_k`.
2. Persist `k := k+1`; zeroize `o_k`, `o_{k+1}`.
3. Receipt `seal.window{op: "close", reason}`.

After close a captured `o_k` is useless, because the gate's auth is now `o_{k+1}`, and obtaining `o_{k+2}` requires the authenticator and a touch. The authValue lives only in the TPM, so there is no blob to roll back.

**Gate rotation without `NV_ChangeAuth`.** Where the TPM library offers no safe `TPM2_NV_ChangeAuth`, `hearth` MAY rotate a gate by proving the current authValue (`PolicySecret` with `o_k`, counting against DA) and then undefining and re-defining the gate with the identical registry template and the new authValue, with the owner authorization (protocols §19.6, E10). The NV Name excludes the authValue and the gate is never written, so the Name and the `PolicySecret` bindings of the owner-seal key and the KEK/db signers are unchanged. The new value (`o_{k+1}` derivation state, or the new blob on quorum machines) is persisted before the undefine; a start that finds the gate absent re-defines it from that persisted state.

**Crash during a window.** `seal-salts.json` records `windowOpen` per owner, so a restart knows a window was open. On restart `hearth` cannot know whether `NV_ChangeAuth` ran. The next window's assertion carries the salts `s_{k+1}` and `s_{k+2}`; `hearth` first tries a policy session with `o_{k+1}` (gate rotated), and on failure asks for a second assertion with salt `s_k` and tries `o_k`. Each wrong attempt counts against DA lockout, so at most one retry is made per touch.

#### 4.6.4 Quorum machines

The gate is driven by a TPM-sealed blob instead of `hmac-secret` (protocols §5.4, §19.6):
- `/var/lib/keylos/hearth/seal-gate-<i>.sealed` holds the current gate authValue `A_k` (32 random bytes), sealed with `PolicyAuthorize(stream PCR11 key, "ready") ∧ PolicyPCR(15)`.
- **Open:** `openWindow` requires a quorum envelope of purpose `seal.window` over the window document (collected through §4.8); after verifying it, `hearth` unseals `A_k`.
- **Sign:** as §4.6.3 with auth `A_k`.
- **Close:** generate `A_{k+1}` (32 random bytes), `TPM2_NV_ChangeAuth(gate, A_{k+1})` with auth `A_k`, seal `A_{k+1}` into a new blob (sealing needs no policy session), replace the file atomically (`rename`), zeroize both.
- **Crash during close:** the old blob still holds `A_k`; if `NV_ChangeAuth` had run, the next window's first policy attempt fails once and `hearth` records an alarm (`seal gate desynchronised`) that requires the recovery path (§7).

#### 4.6.5 Changing the seal credential

`hearth seal-credential replace` (owner, touch machines): one window-style assertion from the current seal credential (`o_k`); `makeCredential` of a **fresh** credential *c′* (rpId `keylos.owner`, `hmac-secret`) and one `hmac-secret` assertion from it with salts `(s_0, s_1)`; then `NV_ChangeAuth(gate, o′_0)` with auth `o_k` (or the equivalent re-definition above); then a `remove-credential` entry for the old seal credential followed by an `enroll-credential` entry for *c′* with `seal: true`, in that order (an owner has at most one seal credential, and an existing credential is never re-marked: protocols §22.3, E26); and `k := 0` for *c′* in `seal-salts.json`. If the old seal credential is the owner's only credential, the owner first enrols another credential. Two touches. The S2 `setSealCredential(keyid)` stand-in, which pointed the gate at an already-enrolled credential without registry entries, is superseded.

**Lost seal credential.** In recovery mode, after a `recover` entry, `rescue` (installer spec) undefines and re-defines the seal gate for owner *i* with the new credential's chain start (`o′_0`); the owner-seal key is kept (its `PolicySecret` binds the NV Name, not the authValue). `hearth` resets `seal-salts.json` for that owner from the `recover` entry at the next normal boot. The key is re-created (and `sealKey` updated in the `recover` entry) only when the TPM was cleared.

#### 4.6.6 Export of owner-seal keys

The owner-seal public keys travel inside the owner registry entries (`sealKey`, §4.5.1), which `HearthSystem.owners()` returns to `config`. `config` writes them as `/etc/keylos/owner-seal/<ownerIndex>.spki`, which `boot` loads into `keys.ownerSeal` of the boot trust set (protocols §20.1). `hearth export-owner-seal` prints the same list for inspection.

### 4.7 TPM owner hierarchy (`HearthTpm`)

#### 4.7.1 Custody

- At install, `installer` sets the owner and endorsement hierarchy authorizations to random 32-byte values and seals each to `hearth` (`hierarchy-owner.sealed`, `hierarchy-endorsement.sealed`, §2.3 note 6) with `PolicyAuthorize(stream PCR11 key, "ready") ∧ PolicyPCR(15) ∧ PolicyCommandCode(Unseal)`. The lockout authorization is `HKDF-SHA256(recovery secret, "keylos-lockout/1")` and is never held by `hearth`.
- `hearth` unseals a hierarchy authorization only for the duration of one operation, keeps it in `memfd_secret` memory, and zeroizes it immediately afterwards.
- **Rotation** (REQ-HEARTH-055): write the new sealed blob and recovery copy as `hierarchy-owner.sealed.new` / `.recovery.new` (`fsync`), `TPM2_HierarchyChangeAuth(TPM_RH_OWNER, new)` with the current value, then `rename` both over the old pair. Crash rule at start: if `hierarchy-owner.sealed.new` exists, the old blob is tried first; if it still authorizes, the rotation is discarded (the `.new` files deleted); otherwise the `.new` pair is promoted. Rotation happens after `remove-owner`, after the first normal boot following a `recover` entry, and on `hearth tpm rotate` (owner, presence).
- **Recovery copy.** The recovery environment cannot unseal the blob (PCR11 holds `enter-recovery`), so a second copy of the owner authorization is kept HPKE-encrypted to the **recovery recipient** (protocols §5.2, §20.21): `/var/lib/keylos/tpm/hierarchy-owner.recovery` (protocols §10.7), mode base, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, recipient public key from `/var/lib/keylos/recovery/recipient.pub`, `info = "keylos-recovery-copy/1:hierarchy-owner"`, empty AAD, file = `enc` (32 bytes) ‖ ciphertext (48 bytes) (the parameters the installer spec §2.20 uses). `installer` writes the first copy; after every rotation `hearth` re-encrypts the new value and replaces the copy atomically. `hearth` never holds the recovery secret; `rescue` decrypts with the recipient private key it derives from the recovery key the owner types.

#### 4.7.2 `defineSpace(index)`

1. Identify the caller from the connection's peer principal (`ServiceHost.accept`). Look up the index in the `keylos-tpm-registry` table; refuse `kl:denied` unless the caller's service name equals the registered owner of the index (protocols §19.6 "Owner" column; for indices with two owners, either).
2. If the index exists: `TPM2_NV_UndefineSpace` with the owner authorization. (Counters lose their value; a re-defined counter starts at the TPM's highest counter value, which the owning service then increments past its last known value.)
3. `TPM2_NV_DefineSpace` from the template with a fresh random authValue for `AUTHWRITE` indices.
4. Seal the authValue to `/var/lib/keylos/tpm/nv-auth/<index>.sealed` in the nv-auth format and policy of protocols §19.6 (§2.3 note 5) and set the file's owner to the calling service's state UID (through the file's existing directory ownership managed by `warden`).
5. Receipt `key.enroll{nv: <index>, reason}`. Return.

#### 4.7.3 `evict(handle)`

- `0x81000103` (first-boot vault seed key): only `vault`, no presence, only if the handle exists; then `TPM2_EvictControl`. Receipt `key.remove`.
- Any other §19.6 handle: owner presence purpose `boot.tpm-evict` with `details.handle`, rendered on the trusted path; then `TPM2_EvictControl`. Receipt `key.remove`.

#### 4.7.4 Secure Boot signers and `sbSign`

- **Policy** (protocols §19.6): with one owner `PolicySecret(seal-gate/0)`; with two or more, `PolicyOR` over `PolicySecret(seal-gate/i)` of the enrolled owners.
- **Re-creation on owner changes** (REQ-HEARTH-054): create new KEK and db signers (RSA-2048) with the new policy under the owner hierarchy, issue their certificates (self-signed for the KEK; db signed by the new KEK), evict the old objects only after `courier` reports that firmware accepted the new certificates with `HearthTpm.sbAccepted(kekCert, dbCert)` (protocols §7.5.3, E20; REQ-HEARTH-059) (a KEK update signed by the owner PK, which the owner unwraps from the recovery kit, or a `set-secureboot-certs` re-enrolment ceremony in firmware setup mode). Until then the new signers live at the reserved staging handles `0x81000180` (new KEK) and `0x81000181` (new db), and the old ones are moved to `0x81000182`/`0x81000183` only for the swap (REQ-HEARTH-058). Swap: evict the old objects at `0x81000101`/`0x81000102`, `TPM2_EvictControl` the staged ones onto them (re-load from their saved blobs and persist), then evict the staging handles. A start with an occupied staging handle resumes at the step the ceremony log `/var/lib/keylos/hearth/sb-ceremony.json` records. The new certificate set is recorded in a `set-secureboot-certs` entry.
- **`sbSign(which, payload, presenceEnvelope)`** (caller `courier` only):
  1. Verify the envelope: purpose `boot.sb-sign`, `details.payloadDigest = SHA-256(payload)`, signed by an owner credential (or a quorum envelope on quorum machines).
  2. Obtain the gate authorization: on touch machines, if the envelope was produced through `hearth#presence` within the last 120 s, `hearth` asked for the seal credential's `hmac-secret` salts during that assertion and holds `o_k`, `o_{k+1}` keyed by the payload digest; otherwise it prompts once more for a seal-credential assertion with salts. On quorum machines it unseals the gate blob after verifying the quorum envelope.
  3. Policy session satisfying the signer's policy; `TPM2_Sign` (RSASSA-PKCS1-v1_5, SHA-256) over `payload`.
  4. Rotate the gate as at window close.
  5. Receipt `presence.assert{purpose: "boot.sb-sign"}` plus `key.enroll` is not written (no key change). Return the signature.

#### 4.7.5 `activateCredential(akHandle, credentialBlob, encryptedSecret)`

Callers `vouch` (pairing) and `fleet` (enrolment) on facet `tpm` (REQ-HEARTH-056):
1. Refuse any caller other than `vouch` or `fleet`, and any `akHandle` other than `0x81010002` (AK) or `0x81010003` (AK0) (`kl:denied`).
2. Parse `credentialBlob` as `TPM2B_ID_OBJECT` and `encryptedSecret` as `TPM2B_ENCRYPTED_SECRET` (`kl:invalid` on error).
3. Unseal the endorsement authorization (§4.7.1) for this operation only; start a policy session `PolicySecret(TPM_RH_ENDORSEMENT)` for the EK (`0x81010001`, or the EK created from the TCG template under the endorsement hierarchy if not persisted).
4. `TPM2_ActivateCredential(activateHandle = akHandle, keyHandle = EK, credentialBlob, secret)`; the AK's ADMIN role is satisfied by its empty authValue (protocols §19.6).
5. Zeroize the endorsement authorization; return the recovered secret; receipt `key.enroll{activation: {akHandle, caller}}`.

#### 4.7.6 `recreateKey(handle, presenceEnvelope)`

1. Look up `handle` in the `keylos-tpm-registry` persistent-handle table; refuse unless the caller is its registered owner service (for example `strata` for `0x81000110`) (`kl:denied`).
2. Verify the presence envelope (purpose `boot.recreate-key`, `details.handle`), or a quorum envelope on quorum machines.
3. If the handle holds an object whose public area matches the template, fail `kl:conflict`; if it holds a non-matching object, evict it first (owner authorization).
4. Create the object from the template under its registry parent with the owner hierarchy authorization; persist it with `TPM2_EvictControl` at `handle`.
5. Receipt `key.enroll{handle, reason: "recreate"}`.

### 4.8 Quorum presence (`HearthQuorum`)

#### 4.8.1 Requests

`request(purpose, payload, rendering)` (facet `presence`):
1. Validate `payload` for `purpose` as REQ-HEARTH-020.
2. Build `keylos.quorum/1`: fresh `q-` ULID, `machine` = the machine key ref, `payloadType` per purpose, `payload` (base64), `payloadDigest = SHA-256(PAE)`, `rendering` (caller-supplied entries, each `{title, body, mime}`, at most 256 KiB in total), `threshold = policy.threshold`, `approvers` = every non-removed owner credential in the registry, `created` = trusted time, `expires = created + hearth.quorum.expirySecs` (default 86 400, maximum 86 400).
3. Set `keyChain` to the `ledger.key.register` receipt for `hearth` (obtained once per boot with `Ledger.query` on `ledger#reader`, filter `eventTypes = ["ledger.key.register"]`, writer `service:hearth`), then DSSE-sign the request with `service/hearth` (§2.3 note 7).
4. Store under `/var/lib/keylos/hearth/quorum/<q-id>/request.dsse`. Receipt `quorum.request{id, purpose, payloadDigest, threshold, expires}`.
5. Return `(requestId, requestEnvelope)`. `fleet` distributes it to approvers; the owner shell can also export it (`hearth quorum export <q-id>`).

#### 4.8.2 Collecting signatures

`submit(requestId, signedEnvelope)` (facet `quorum`: `fleet`; also `admin` for files carried by hand; `collect` and `list` are also served on `admin`, protocols §19.2, E24; `list` returns JSON entries that include `requestEnvelope` in standard base64, so `hearth quorum export` works):
1. Load the request; refuse `kl:expired` after `expires`.
2. Parse `signedEnvelope`: its `payloadType` and `payload` MUST equal the request's.
3. For each signature: verify with `keylos-presence` (rpId `keylos.owner`, UV required for purposes that require it), check `keyid ∈ approvers`, and check against the registry state at `created`.
4. Merge new valid signatures into `/var/lib/keylos/hearth/quorum/<q-id>/signatures.json`. Return `(have = number of distinct owners, need = threshold)`.

`collect(requestId)` returns `kl:needs-approval:<q-id>` while `have < need`; then the quorum envelope (payload plus one signature per distinct owner, the first-received credential of each owner), and receipt `quorum.complete{id, owners}`. A completed request can be collected repeatedly until it expires.

#### 4.8.3 Using a quorum envelope

Every verifier of presence (`hearth`, `boot`, `config`, `gate`, `depot`) accepts a quorum envelope wherever a presence envelope is required on quorum machines (protocols §5.4); `hearth` verifies with the same rule when it consumes envelopes itself (seal windows, registry entries, `sbSign`, organisation unlock).

#### 4.8.4 Approver flow

Approvers sign on their own keylos machines (§4.4.6) or, without keylos, with `fleet-ctl` (fleet spec), which implements the same §5.3 construction with `libfido2` and rpId `keylos.owner`. An approver never needs to reach the target machine's trusted path.

#### 4.8.5 Enrolling owners on a quorum machine

A new owner's credential lives on their own authenticator. Enrolment:
1. On their keylos machine: `hearth credential export <keyid>` outputs `{keyid, cose, credentialId, label, aaguid}` (the replayed registry keeps no AAGUID, so `aaguid` is the zero AAGUID) for one of their `keylos.owner` credentials (credentials are not discoverable, so the `credentialId` is required for later assertions).
2. On the target machine (owner shell, or through `fleet`): `hearth owners add-remote <name> --credential <export>` builds the `add-owner` entry (new `ownerIndex`, `sealKey` of the newly created owner-seal key, no `seal` credential) and creates a quorum request for it (purpose `owners.entry`).
3. The new owner signs the entry remotely (proving possession of the credential); existing owners sign until the threshold is reached.
4. `hearth` appends the entry, writes the NV head, creates the seal gate (blob-driven) and owner-seal key, and re-creates the KEK/db signers.

#### 4.8.6 Genesis on quorum machines

On `server`, `server-k8s`, `cloud` and `appliance` profiles the genesis entry has `policy = {"mode": "quorum", "quorum": N, "threshold": N}` and lists every initial owner. It is written by `installer` (unattended `fleet_delegated` answers) or by the cloud first-boot stage from the fleet-signed seed (protocols §20.13), pre-signed remotely by the listed owners. `hearth` verifies it at first start exactly like any registry replay.

### 4.9 Organisation lock (`HearthFleet`)

`lockAll(commandEnvelope)` (facet `fleet-lock`, `fleet` only):
1. Verify REQ-HEARTH-070: `payloadType = application/vnd.keylos.fleet.command+json; version=1`; JCS payload `keylos.fleet.command/1` per protocols §20.23; `machine` and `org`; the time window; signatures by ≥ `commandQuorum` distinct approvers of `/etc/keylos/fleet/approvers.json` (counted by approver `id`); `id` not in `/var/lib/keylos/hearth/fleet-commands.json` (HMAC'd; ids kept for 30 days).
2. Record the `id`. For `unlock-org`: clear `orgLocked` on every session (users still authenticate), receipt `user.login{orgUnlock: true}` at each user's next unlock, and stop. For `lock` and `wipe`, continue: for every human session, `lock(session)` with `lockOnSuspend` behaviour `freeze` forced, and mark `orgLocked`.
3. For every agent session of every human: `BrokerSystem.revokeSession(s, "kill")`.
4. Receipt `user.lock{reason: "org", command: <id>, kind: "lock" | "wipe"}`; `atrium` shows "Locked by your organisation" (for `wipe`: "This device was wiped by your organisation; restart into recovery to complete").
5. New logins are refused with `kl:denied` ("locked by organisation") until unlocked.

**Unlock:** a verified `unlock-org` command (step 2), or an owner decision per §2.3 note 9 when the organisation is unreachable; then each user's normal authentication. A `wipe` lock is never lifted by `unlock-org`: the wipe completes in the recovery environment (protocols §14.5).

### 4.10 Guest sessions

Enabled with `hearth.guest.enabled` (default false; `kiosk` profile: false).
1. `login("", "guest", empty)` on facet `greeter`.
2. Allocate `guest-<8 lowercase base32>` and a UID from 59000–59999.
3. `StrataHomes.createEphemeralHome(name, uid)`: not snapshotted, ephemeral unit key.
4. `VaultUsers.createUser(name, [])`: guests get no slot (protocols §7.5.4, E11); their vault user exists in memory only.
5. Return a session; the `Human` entity for the guest has `guest = true` (protocols §16.1), which the broker policy uses to deny presence-class grants, persistent grants and agents (REQ-HEARTH-081).
6. Receipt `guest.start`.

**Logout, lock timeout or reboot:** revoke all the guest's sessions (`kill`), `VaultUsers.deleteUser`, `StrataHomes.deleteHome(name, forget = true)`, release the UID after 60 s, receipt `guest.end`. A guest session that survives a crash is destroyed at the next start (`hearth` keeps the active guest list in memory and in `/var/lib/keylos/hearth/guests.json`). Guests can lock the screen; unlocking needs no secret but is offered only to the same seat within `hearth.guest.idleEndSecs` (default 1 800 s), after which the session ends.

### 4.11 Family machines: the owner inbox

When a non-owner human (or a principal acting for one) needs an owner decision (REQ-HEARTH-082):
1. `hearth` stores the request in `/var/lib/keylos/hearth/inbox.json` (HMAC'd): `{id: fi-…, requester, purpose, payloadDigest, payload, rendering, created, expires}`, default lifetime 7 days. Family inbox IDs use the `fi-` prefix (protocols §3.5), never the broker's `a-`.
2. It returns `kl:needs-approval:<fi-id>` to the caller. `hearth` writes no `approval.*` receipt (those are broker events); it writes `presence.assert` when an owner signs.
3. When an owner next unlocks a session, `atrium` shows the pending items; the owner reviews each on the trusted path (`TrustedPrompt.presence` with the stored rendering and `requester` named in the title) and signs or declines.
4. The caller retries `presence(purpose, payload)` with the same payload; `hearth` returns the stored envelope (idempotent by payload digest) or `kl:denied` if declined.
5. If the owner has a paired phone, `hearth` asks `atrium` to send a notification through `vouch` that a decision is waiting; the phone cannot sign it (protocols §14.3).

Broker approval prompts with `requester` follow the same display path but are owned by `broker`; `hearth` handles only presence-class requests.

### 4.12 Recovery key and trustees

#### 4.12.1 Parsing

Per protocols §20.21: strip spaces and `-`, lower-case, require 80 hex digits (8 × (8 + 2)), check each group's CRC-8 (polynomial 0x07, init 0x00) over its 4 bytes, and report the first bad group by position (1–8). The secret is the concatenation of the 8 four-byte groups.

#### 4.12.2 Derivations used by `hearth`

| `info` (HKDF-SHA256, salt empty, IKM = 32-byte secret) | Use in `hearth` |
|---|---|
| `keylos-recovery-signer/1` | Ed25519 seed of `recoverySigner`; verifying `recover` entries and the trustee `check` link |
| `keylos-recovery-recipient/1` | Not derived by `hearth`: only the public key (`/var/lib/keylos/recovery/recipient.pub`) is used, as the HPKE recipient of the hierarchy recovery copy; `vault` uses the same public key for `recovery` slots |

`hearth` never uses the lockout or recovery-auth derivations; those belong to the recovery environment.

#### 4.12.3 Vault recovery slots

The recovery secret never reaches the running system. Vault recovery is available from the first boot:
1. When `hearth` creates a user (first boot for the genesis owner from the bundle's `owner` part, later through `HearthAdmin.createUser`), it includes `SlotSpec{kind: "recovery"}` with no factor for owners (and for all users with `hearth.recoverySlots = 'all`). `vault` wraps the user key with HPKE to `/var/lib/keylos/recovery/recipient.pub` (protocols §7.5.4).
2. `vaultRecovery: true` is set in the user record; receipt `key.enroll{kind: "vault-recovery"}`.
3. **Recipient rotation.** After `keylos-enrol recovery-key` (installer spec) writes a new `recipient.pub`, it calls `hearth recovery rewrap` in the owner shell (presence, purpose `vault.rewrap`): `hearth` adds a new `recovery` slot for each user (`VaultUsers.addSlot`), then removes the old one (`removeSlot`), and re-encrypts the hierarchy copy (§4.7.1). A crash between the two steps leaves both slots; the next `rewrap` removes the older one.
4. In the recovery environment `rescue` opens a `recovery` slot with the recipient private key derived from the typed recovery key; `hearth` is not involved.

#### 4.12.4 Trustee shares

`hearth trustee split --k K --n N [--label L]`:
1. Presence, purpose `trustee.split` (`details.k`, `details.n`, `details.set`).
2. Recovery key entry on the trusted path; parse it (§4.12.1), derive the recovery signer and require it to equal the registry's `recoverySigner`.
3. Shamir over GF(2^8), per byte, with the field arithmetic of SLIP-0039 (protocols §4): random polynomial coefficients from the OS CSPRNG, share indices 1…N.
4. For each share: `keylos.trustee/1` with `set` (8 random Crockford base32 characters, the same for all shares of the split), `machine`, `k`, `n`, `index`, `share` (base32 of 32 bytes), `check` (first 8 hex of SHA-256(secret)), `created`.
5. The cards are rendered on the trusted path one at a time for printing (QR binary mode, error correction Q, plus the share in 8-character groups), through `portal-print` with an explicit "print to local printer only" grant; nothing is written to disk. Receipt `presence.assert{purpose: "trustee.split", set, k, n}`.

`hearth trustee combine` (recovery environment and owner shell) reads K cards (QR or typed), checks that `set`, `machine`, `k` and `n` agree, reconstructs, verifies `check`, and outputs the recovery key text on the trusted path only. A new split does not revoke old shares; rotating the recovery key (installer `keylos-enrol recovery-key`) does.

**Inheritance.** The optional dead-man timer and the encrypted inheritance note are held by the owner's paired phone (`VouchLink.inheritance`, protocols §20.19); `hearth`'s part is only the `user.login` receipts the phone uses as the owner's heartbeat.

### 4.13 Lock on suspend and logout

`devd` calls `HearthSystem.prepareSuspend()` before suspend and `resumed()` after (`hearth` also subscribes to `PowerEvents` on `devd#service`). For each logged-in user with `lockOnSuspend`:

| Mode | Effect |
|---|---|
| `screen` | `atrium` lock only (`atrium` observes the session lock through the greeter facet's state) |
| `vault` (laptop default) | Screen lock, `VaultUsers.lockUser`, `StrataAdmin.lockUnits(user)`, `PrincipalControl.terminate(session, freeze)` for the user's agent and bench sessions |
| `freeze` | Additionally freezes all of the user's app sessions |

`prepareSuspend` returns when done, or after 2 s with a warning receipt (`user.lock{reason: "suspend", partial: true}`). `unlock` thaws what lock froze. Logout calls `BrokerSystem.revokeSession(session, "kill")` for every session of the human. Guest sessions end on suspend when `hearth.guest.endOnSuspend` is true (default).

### 4.13a User lock state for durable workflows

`hearth` keeps per user `{unlockedSessions: count, since}` updated by every `login`, `unlock`, `lock`, logout, suspend lock (§4.13), org lock and unlock (§4.9) and `disableUser`/`deleteUser`. A transition of `unlockedSessions` between 0 and ≥ 1 changes `userState` and emits a `watchUsers` event; deletion emits `{"deleted": true, "locked": true}`. Guest users are reported like others (their workflows cannot exist, protocols §20.25). The state is derived from `hearth`'s session table; whenever that table is not (yet) available, for example during a `hearthd` restart before it is rebuilt, every user counts as locked, so the default is conservative. `loom` treats an unreachable `hearth` as locked too.

### 4.14 Device access

`hearth` holds a persistent broker grant for `device` resources of subsystem `hidraw` (FIDO usage page), created by the installer's first-boot policy and permitted by the broker default policy for the hearth service generation. FIDO devices are opened per operation with `Broker.materialize` and closed afterwards. New FIDO devices are subject to `devd` USB authorization (protocols §9.5); the default `devices.autoAuthorize` includes the FIDO class. CTAP 2.2 hybrid transport (phones as passkeys over BLE) needs a Bluetooth LE channel that protocols 1.0 does not route to `hearth`; `hybridTransport` is therefore `false` and unsupported in 1.0 (§6.3).

---

## 5. Interfaces

### 5.1 Facets (protocols §19.2)

| Facet | Holders | Methods |
|---|---|---|
| `greeter` | atrium greeter and lock screen | `users`, `login`, `unlock`, `lock` |
| `presence` | broker, config, depot, courier, ledger, vault, aide, strata | `presence` (rendered through atrium, §4.4.3; quorum on quorum machines, §4.4.4); `HearthQuorum.request`, `collect` |
| `atrium` | atrium | `presence` (prompt already shown) |
| `admin` | owner `shell`, atrium settings | all `Hearth`; `HearthAdmin`; `HearthQuorum.submit`, `collect`, `list` (hand-carried files, protocols E24); repo-local `HearthCli` |
| `system` | warden, devd, config, broker, gate, vouch, strata, bench, depot, ledger, loom | `HearthSystem` (gate, vouch, strata, bench, depot, ledger: `owners` only; loom: `owners`, `userState`, `watchUsers`; protocols §19.2 wins) |
| `seal` | depot, forge | `HearthSeal` |
| `tpm` | courier, vault, strata, ledger, config, vouch, fleet | `HearthTpm` (`defineSpace`, `recreateKey`: the object's registered owner; `evict`: per §4.7.3; `sbSign`, `sbAccepted`: courier; `activateCredential`: vouch, fleet only) |
| `quorum` | fleet | `HearthQuorum.submit`, `list` |
| `fleet-lock` | fleet | `HearthFleet` |

### 5.2 Method notes

| Method | Notes |
|---|---|
| `Hearth.users` | Disabled users omitted on `greeter`; active guests listed only on `admin` |
| `Hearth.enrollKey(user, kind)` | `kind` ∈ `fido2`, `platform`, `password`; presence of an existing credential of `user` (for owners: an `enroll-credential` entry). Kinds backed by a vault slot need the target user's vault key unlocked (`VaultUsers.addSlot`): while it is locked the call fails `kl:unavailable:user-locked` and the caller retries after the user's next login (protocols §7.5.4, E11) |
| `Hearth.removeKey(keyRef)` | Refuses removing the last login method or an owner's last owner credential; for owner credentials a `remove-credential` entry |
| `HearthAdmin.addOwner/removeOwner` | Registry entries with quorum; `addOwner` provisions the seal gate and key (§4.6.1) and re-creates the KEK/db signers (§4.7.4) |
| `HearthAdmin.setQuorum(addOwner, remove)` | Superseded: always `kl:unsupported` (§2.3 note 3) |
| `HearthAdmin.setQuorumPolicy(mode, quorum, threshold)` | `set-quorum` entry signed by `policy.quorum` current owners (REQ-HEARTH-033) |
| `HearthAdmin.registry` | JSON: entries, head, NV head, policy, seal credentials, assisted credentials |
| `HearthSystem.userState`, `watchUsers` | §4.13a, REQ-HEARTH-016/017; loom only |
| `HearthQuorum.*` | §4.8 |
| `HearthTpm.*` | §4.7 (`activateCredential` §4.7.5, `recreateKey` §4.7.6) |
| `HearthFleet.lockAll` | §4.9 |

### 5.3 Repo-local interface (`hearth` CLI only)

File ID `0xe25a913c7f084d31`, via `Extensible.ext` on `admin`:

```capnp
@0xe25a913c7f084d31;
using C = import "common.capnp";

interface HearthCli {
  setSecureBootCerts @0 (certsDer :List(Data)) -> ();          # set-secureboot-certs entry (quorum presence)
  verifyRegistry     @1 () -> (ok :Bool, report :Text);
  setSealCredential  @2 (keyid :Text) -> ();                   # superseded by the §4.6.5 replace flow: MUST return kl:unsupported
  sessions           @3 () -> (json :Text);
  exportOwnerSeal    @4 () -> (json :Text);
  status             @5 () -> (json :Text);                    # alarms, DA lockout, open windows, sealing mode
  exportCredential   @6 (keyid :Text) -> (json :Text);         # §4.8.5 step 1
  addOwnerRemote     @7 (name :Text, credentialJson :Text) -> (requestId :Text);   # §4.8.5 step 2
  signRemote         @8 (requestEnvelope :Data) -> (signedEnvelope :Data);         # §4.4.6
  rewrapRecovery     @9 () -> ();                              # §4.12.3 step 3 (presence)
  trusteeSplit       @10 (k :UInt8, n :UInt8, label :Text) -> (set :Text);         # §4.12.4 (cards on the trusted path)
  trusteeCombine     @11 () -> ();                             # §4.12.4 (result on the trusted path only)
  inbox              @12 () -> (json :Text);                   # §4.11 pending owner decisions
  rotateOwnerAuth    @13 () -> ();                             # §4.7.1 (presence)
  orgUnlock          @14 (user :Text, presenceEnvelope :Data) -> ();   # §2.3 note 9 owner decision
  logout             @15 (session :C.SessionId) -> ();         # §4.13
  # presence-mode changes use HearthAdmin.setQuorumPolicy (protocols §7.5.3)
}
```

### 5.4 CLI: `hearth`

| Command | Description | Exit |
|---|---|---|
| `hearth users` | Users: name, uid, owner, locked, methods | 0 |
| `hearth add <name> [--owner] [--display NAME]` | Create a user (presence); credential ceremony on the trusted path | 0, 3 |
| `hearth disable\|enable <name>` | Presence | 0, 3 |
| `hearth remove <name> [--forget-data]` | Presence | 0, 3 |
| `hearth passwd [<name>]` | Change password (trusted-path entry) | 0, 3 |
| `hearth keys [<name>]` | List credentials (roaming, platform, assisted) | 0 |
| `hearth enroll [--kind fido2\|platform\|password] [--label L]` | Enrol a credential (presence by an existing credential) | 0, 3 |
| `hearth unenroll <keyid>` | Remove a credential | 0, 3 |
| `hearth owners [add\|remove <name>] [--quorum N]` | Owner management (`--quorum` calls `setQuorumPolicy` with the current mode and threshold) | 0, 3 |
| `hearth owners add-remote <name> --credential <file>` | Quorum-machine owner enrolment (§4.8.5) | 0, 3, 5 |
| `hearth presence-policy touch\|quorum [--threshold N]` | `setQuorumPolicy` switching the presence mode | 0, 3 |
| `hearth credential export <keyid>` | Export a `keylos.owner` credential for remote enrolment | 0 |
| `hearth presence --remote <request.dsse> [--out FILE]` | Sign another machine's quorum request (§4.4.6) | 0, 3, 5 |
| `hearth quorum list\|export <q-id>\|submit <q-id> <signed.dsse>\|collect <q-id>` | Quorum requests (§4.8) | 0, 3, 5 |
| `hearth registry [verify]` | Show and verify the registry against NV | 0, 3 |
| `hearth secureboot set-certs <file>…` | Record the owner Secure Boot certificate set (quorum presence) | 0, 3 |
| `hearth seal-credential set <keyid>` | Change the seal credential (§4.6.5) | 0, 3 |
| `hearth seal-window --project DIR --drv D… [--minutes N]` | Open a window manually (normally `forge seal` does it) | 0, 3 |
| `hearth recovery rewrap` | Replace every vault `recovery` slot and the hierarchy copy after a recovery-key rotation (§4.12.3) | 0, 3 |
| `hearth trustee split --k K --n N [--label L]` | Print trustee share cards (§4.12.4) | 0, 3 |
| `hearth trustee combine` | Reconstruct the recovery key from cards | 0, 3, 5 |
| `hearth inbox` | Pending owner decisions (§4.11) | 0 |
| `hearth tpm rotate` | Rotate the owner hierarchy authorization (presence) | 0, 3, 6 |
| `hearth lock` | Lock the current session | 0 |
| `hearth sessions` | The caller's sessions | 0 |
| `hearth status` | Alarms, DA lockout, open windows, sealing mode, vault recovery state | 0, 4 if an alarm is active |

Exit codes: 0 ok; 2 usage; 3 refused or authentication failed; 4 alarm active; 5 verification failed or expired; 6 TPM error.

### 5.5 Files

```
/var/lib/keylos/hearth/
  users/<name>.dsse          user records
  owners.log                 owner registry (protocols §10.7)
  attempts.json              rate-limit state (HMAC'd)
  seal-salts.json            per-owner seal chain index k and seal credential (HMAC'd)
  seal-gate-<i>.sealed       quorum machines: sealed gate authValue (protocols §19.6)
  quorum/<q-id>/             request.dsse, signatures.json
  inbox.json                 owner inbox (HMAC'd)
  fleet-commands.json        accepted fleet command ids, kept 30 days (HMAC'd)
  sb-ceremony.json           KEK/db signer re-creation progress (§4.7.4)
  platform/<keyid>.blob      platform authenticator keys (§4.4.5; protocols §10.7)
  guests.json                active guest sessions
  platform-counters.json     platform authenticator signCounts (HMAC'd)
  tombstones.json            removed users (uid, name, removedAt)
/var/lib/keylos/tpm/nv-auth/
  0x01300105.sealed          authValue of NV 0x01300105 (owner-registry-head)
  0x01300106.sealed          authValue of NV 0x01300106 (login-failure-counter)
/var/lib/keylos/tpm/
  hierarchy-owner.sealed     owner hierarchy authorization (§4.7.1)
  hierarchy-endorsement.sealed endorsement hierarchy authorization
  hierarchy-owner.recovery   owner hierarchy authorization, HPKE to the recovery recipient (§4.7.1)
/var/lib/keylos/recovery/recipient.pub   recovery recipient public key (read only; written by installer)
/keystore/hearth/
  service-key.sealed         service/hearth key
```

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| Malware approves its own config change | Config statements need a FIDO2 assertion (or N remote assertions) over the exact statement; `boot` verifies against the registry anchored in NV |
| UI trick: the user touches a key for something else | Prompts are on `atrium`'s trusted path and render the payload; `clientDataHash` binds the assertion to it |
| Cloned security key | `signCount` regression detection; UV |
| Seal-window abuse during an open window | ≤ 600 s, listed `drv`s, one project; every seal receipted and shown by `depot` |
| Replay of a captured `hmac-secret` output or quorum-blob auth | The seal gate auth rotates every window |
| Registry tampering on disk | NV head anchoring; boot-time replay |
| Offline brute force of PIN or password | Vault slots need the TPM-held epoch subkey; online attempts rate-limited with an NV counter; platform-authenticator PINs protected by TPM DA lockout |
| Compromised service asks `hearth` for owner-hierarchy operations | `HearthTpm` accepts only registry indices from their registered owners; evictions need presence; the hierarchy auth never leaves `hearth` |
| Forged quorum request shown to an approver | Requests are signed by `service/hearth` with the ledger key-registration chain to the machine key; approvers render and verify before signing |
| One approver signs twice with two credentials | Distinct-owner counting |
| Forged or replayed organisation lock | `commandQuorum` approver signatures over a machine-bound command, 24-hour validity, 30-day id log; lock only (no data destruction) |
| Guest leaves data or credentials behind | Ephemeral home, vault user and unit key destroyed at logout; no presence or persistent grants |
| Non-owner tricks an owner into approving | Owner inbox shows `requester` and the rendered payload on the owner's trusted path |
| Lost keys | Recovery key in recovery mode; trustee shares |
| Coercion | Out of scope (protocols threat model) |

### 6.2 Confinement of `hearthd`

| Property | Value |
|---|---|
| Tier | t0 |
| Namespaces | mount, pid, ipc, uts, cgroup, net (`lo` only) |
| Mount view | hearth generation; `/var/lib/keylos/hearth` (rw); `/var/lib/keylos/tpm` (rw: `nv-auth/` and the hierarchy blobs); `/var/lib/keylos/recovery/recipient.pub` (ro); `/etc/keylos/fleet/approvers.json` (ro, fleet-enrolled machines); `/keystore/hearth` (rw); `/run/keylos/boot` (ro); `/var/lib/keylos/firstboot` (ro at first boot; `done/` rw); `/proc` subset |
| Capabilities | None (homes are created by `strata`) |
| Devices | `/dev/tpmrm0` fd from `warden`; FIDO `hidraw` fds through broker grants |
| seccomp additions | `memfd_secret`, `mlock` |

### 6.3 Residual risks and limitations

- A tier-0 or kernel compromise during an open window can seal arbitrary in-scope code until the window closes; receipts make it visible.
- On quorum machines the seal gate is protected by "N approvers signed and a verified `hearth` runs", not by a physical touch (protocols §5.4); `status` shows `sealing: quorum`.
- An assisted credential's user presence is a confirmation on the trusted path, which a kernel compromise could synthesise; it is shown wherever used.
- Without a TPM (`degraded` profile), PIN logins and platform authenticators are disabled, registry anchoring is file-only, and sealing is unavailable.
- Phones as passkeys (CTAP hybrid) are not supported in 1.0 (§4.14).

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| No authenticator when presence is required | Prompt "insert or tap your security key"; timeout → `kl:expired` |
| Owner-registry alarm (NV mismatch beyond the one-entry crash rule) | No presence assertions: no config apply, seals or presence approvals. Critical notification. Recovery: `hearth registry verify` shows the difference; the owner boots the recovery entry, where `rescue` appends a `recover` re-anchor entry signed with the recovery signer |
| `vault` unavailable at login | Login fails `kl:unavailable`; greeter offers retry |
| `strata` unavailable at user or guest creation | Creation fails atomically (nothing written) |
| TPM DA lockout (wrong seal-gate auth) | Seal windows fail; `hearth status` shows the lockout time; the lockout authorization is part of the recovery path (installer spec) |
| Crash during a window | §4.6.3 crash rule; quorum machines §4.6.4 |
| Quorum seal gate desynchronised | Alarm; sealing disabled until `rescue` re-defines the gate (installer spec) |
| Quorum request expires before threshold | `kl:expired`; the caller creates a new request |
| Hierarchy authorization blob does not unseal (PCR15 changed by a disk move, or an unapproved OS) | `HearthTpm` fails `kl:unavailable`; owner-hierarchy operations wait for the recovery path |
| KEK/db signer re-creation pending firmware acceptance | Old signers remain usable until `courier`'s `sbAccepted`; `status` shows "Secure Boot signer update pending" |
| `vault` not answering at start (it may itself wait for `defineSpace`) | `hearth` calls `Bootstrap.host` without waiting; pending vault users (`createUser`/`addSlot` not yet done) are completed with one 2 s attempt at start and otherwise in the background |
| Seal gate found absent at start after a crash during an undefine/redefine rotation | Re-defined from the persisted pending value (§4.6.3) |
| Guest session left after a crash | Destroyed at the next start (§4.10) |

---

## 8. Performance budgets

| Operation | Budget |
|---|---|
| Password login (excluding Argon2id, 400–900 ms) | ≤ 50 ms |
| FIDO2 login after touch (USB) | ≤ 150 ms |
| Presence envelope after touch | ≤ 100 ms |
| Platform-authenticator assertion after PIN (TPM P-256) | ≤ 150 ms |
| `sealSign` in a window (TPM P-256) | ≤ 80 ms |
| `validateSession` | ≤ 0.2 ms |
| `userState` | ≤ 0.2 ms |
| `watchUsers` event after lock, unlock, login or logout | ≤ 200 ms |
| `prepareSuspend` | ≤ 500 ms typical, 2 s cap |
| Registry replay at start (1 000 entries) | ≤ 200 ms |
| `HearthQuorum.submit` (verify 1 signature) | ≤ 10 ms |
| `defineSpace` | ≤ 300 ms (TPM-bound) |
| Guest session creation | ≤ 1 s |

---

## 9. Observability

- **Receipts** (protocols §19.3): `user.login` (method, outcome), `user.lock` (reason: `suspend`, `idle`, `manual`, `org`), `user.create`, `user.delete`, `key.enroll`, `key.remove` (keyid, owner, op, `nv`/`handle` for TPM objects), `presence.assert` (purpose, payload digest, keyid, uv, assisted, remote), `seal.window` (open/close, windowDigest, reason), `quorum.request`, `quorum.complete`, `guest.start`, `guest.end`.
- **Metrics** (records `0x1F`): `hearth_logins_total{method,outcome}`, `hearth_presence_total{purpose,assisted}`, `hearth_seal_windows_open`, `hearth_registry_seq`, `hearth_failed_attempt_backoff_seconds{user}`, `hearth_quorum_pending`, `hearth_guest_sessions`.
- **Logs:** alarms at level 2; ceremonies at level 5.

---

## 10. Configuration

```nickel
{
  hearth | {
    passwordPolicy | { minLength | Number | default = 12, allowPin | Bool | default = true, pinMinDigits | Number | default = 6 },
    lockOnSuspend | [| 'screen, 'vault, 'freeze |] | default = 'vault,
    idleLockSecs | Number | default = 300,
    presence | { uvDefault | Bool | default = true, timeoutSecs | Number | default = 120 },
    sealWindowMaxSecs | Number | default = 600,        # maximum 600 (protocols §20.4)
    quorum | { expirySecs | Number | default = 86400 },  # maximum 86400 (protocols §20.18)
    guest | {
      enabled | Bool | default = false,
      agents | Bool | default = false,                 # protocols §14.3
      endOnSuspend | Bool | default = true,
      idleEndSecs | Number | default = 1800,
    },
    family | { inboxDays | Number | default = 7, notifyPhone | Bool | default = true },
    platformAuthenticator | Bool | default = true,     # offer assisted presence enrolment
    recoverySlots | [| 'owners, 'all, 'none |] | default = 'owners,   # REQ-HEARTH-094; the vault creates a recovery slot only when asked
    kiosk | { user | String | optional },             # kiosk profile only (REQ-HEARTH-015)
    hybridTransport | Bool | default = false,          # unsupported in 1.0; must be false
  },
  config.presence.assistedAllowed | Array String | default = ["*"],   # purposes for which assisted credentials count
}
```

The owner set, quorum and presence mode are **not** configuration: they live in the owner registry and change only through registry entries.

---

## 11. Testing and acceptance criteria

Test rig: a FIDO2 key with `hmac-secret` (USB HID), `swtpm` for CI and a real fTPM and dTPM in the lab.

| ID | Scenario | Expected |
|---|---|---|
| IT-01 | Genesis install; reboot; `hearth registry verify` | Computed head equals NV `0x01300105` (read without authorization) |
| IT-02 | Config apply with the owner's key | Envelope verifies with `keylos-presence`; boot accepts |
| IT-03 | Config signed by an unenrolled FIDO2 key | Boot rejects |
| IT-04 | Remove the last line of `owners.log` | Registry alarm |
| IT-05 | Open a window, sign 2 in-scope statements, then 1 out of scope | Third refused; window closed; gate auth rotated |
| IT-06 | Replay a captured `o_k` after close | TPM rejects (auth failure) |
| IT-07 | 5 wrong passwords, reboot | Backoff persists (NV counter) |
| IT-08 | Suspend with `lockOnSuspend=vault` | Vault reports user locked; units locked; agent sessions frozen within 2 s |
| IT-09 | Lose all keys; `rescue` with the recovery key appends a `recover` entry and a new credential | Next normal boot: `hearth` replays and accepts the `recover` entry, forces enrolment of a new credential, NV head verifies |
| IT-10 | `signCount` regression | Rejected; alarm |
| IT-11 | `set-quorum` to 2, then `add-owner` | Third owner needs 2 signatures |
| IT-12 | Change seal credential to a spare key; seal with the spare | Works; old credential can no longer open windows |
| IT-13 | `presence` on facet `presence` | `atrium` renders and calls back on `hearth#atrium`; no double prompt |
| IT-14 | `set-secureboot-certs` | NV head's certificate-set hash updated |
| IT-15 | Salt vectors | `s_k` for k = 0, 1, 2⁶⁴−1 equals protocols `vectors/tpm/seal-salts` |
| IT-16 | Crash between log append and NV write | Next start completes the NV write; no alarm; two trailing entries do raise the alarm |
| IT-17 | `defineSpace(0x01300104)` from `vault`, then from `strata` | First succeeds and writes a sealed auth file `0x01300104.sealed`; second `kl:denied` |
| IT-18 | `evict(0x81000103)` from `vault` twice; `evict(0x81000110)` from `strata` | First succeeds, second `kl:not-found`; third needs presence |
| IT-19 | Quorum machine, threshold 2 of 3: config apply | `presence` returns `kl:needs-approval:q-…`; one remote signature → `have 1/2`; second owner signs → `collect` returns an envelope `boot` accepts |
| IT-20 | Quorum: same owner signs with two credentials | Counted once |
| IT-21 | Quorum: signature over the request instead of the payload | Rejected |
| IT-22 | Quorum seal window | Gate blob unsealed only with a `seal.window` quorum envelope; rotated and re-sealed at close; old blob copy no longer satisfies the gate |
| IT-23 | Remote enrolment of a new owner on a quorum machine | `add-owner` contains the new credential's own signature plus threshold; seal gate and key exist; KEK/db signers re-created |
| IT-24 | `lockAll` with a `lock` command signed by 2 of 3 approvers of `approvers.json` (`commandQuorum = 2`), then replayed | Sessions locked `orgLocked`, agents killed; replay refused (id seen); a command for another `machine` or with `expires − issued` > 24 h refused; one signed by a non-approver owner refused |
| IT-25 | Unlock after `lockAll` with password only | Refused; after a valid `unlock-org` command (or an owner `x-hearth.org-unlock` decision) the user's password unlocks; a `wipe` lock is not lifted by `unlock-org` |
| IT-26 | Guest login, write files, logout | Home, vault user and unit key gone; `guest.start`/`guest.end`; presence request from the guest denied |
| IT-27 | Non-owner requests a config apply on a family machine | `kl:needs-approval:fi-…`; owner sees it at next unlock with `requester`; retry returns the envelope |
| IT-28 | Assisted platform credential: enrol and sign `config.apply` | Envelope verifies; `assisted: true` in receipt and verdicts; refused when `assistedAllowed` excludes the purpose |
| IT-29 | Recovery key text with group 5 mistyped | Error names group 5 |
| IT-30 | Trustee split 2-of-3, combine any 2 | Recovers the key; `check` passes; a share from another `set` is refused |
| IT-31 | Create an owner, then recover in `rescue` with the recovery key | The owner's vault user has a `recovery` slot from creation; `rescue` opens it with the recipient key; `hearth` never received the secret |
| IT-34 | `activateCredential` from `vouch` for AK0 and AK; from `vouch` for `0x81000140`; from `courier` | Secrets match `MakeCredential`; second and third `kl:denied` |
| IT-35 | TPM cleared; `recreateKey(0x81000110)` from `strata` with presence; again; from `vault` | Key re-created from the template; second `kl:conflict`; third `kl:denied` |
| IT-36 | `setQuorum(2, 2)`; `setQuorumPolicy("quorum", 2, 2)` on a three-owner machine | First `kl:unsupported`; second writes a `set-quorum` entry signed by `policy.quorum` owners |
| IT-37 | `presence` on `hearth#presence` with non-empty `assist`; on `hearth#atrium` with an assisted credential | First `kl:invalid`; second produces an envelope with `UP | UV` |
| IT-38 | `login("", "kiosk", "")` on the `kiosk` profile and on `laptop`; `login(u, "platform", pin)` | Kiosk session on `kiosk`; `kl:denied` on `laptop`; unknown method `kl:invalid` |
| IT-39 | Quorum request `keyChain` | A remote approver verifies the chain with the machine key alone; a request whose chain names another service key is refused by `hearth presence --remote` |
| IT-40 | Owner hierarchy rotation, then recovery | New sealed blob and recovery copy both written; `rescue` decrypts the new copy with the recipient key; a crash before the TPM change leaves the old pair working |
| IT-41 | Add a second owner (KEK/db re-creation), kill `hearthd` mid-ceremony, restart | Staging handles `0x81000180`/`0x81000181` occupied → ceremony resumes; afterwards all staging handles empty |
| IT-43 | Platform authenticator key: policy session with PolicyPCR(15) only, without the PIN-derived authValue | Sign fails; with `PolicyAuthValue` and the PIN it succeeds; `userWithAuth` is clear in the public area |
| IT-44 | `vault` requests `defineSpace(0x01300111)`; `ledger` requests `defineSpace(0x01300100)` on a hearth-provisioned TPM | Both defined from the registry; nv-auth files carry the protocols §19.6 policy and unseal for the owner service only |
| IT-45 | `enrollKey(alice, fido2)` before alice's first login, then after | `kl:unavailable:user-locked`; then succeeds |
| IT-46 | Guest login | `VaultUsers.createUser("guest-…", [])` (no slots) |
| IT-47 | Seal gate rotation by undefine/redefine, kill `hearthd` between undefine and define | Restart re-defines the gate from the persisted value; NV Name unchanged; owner-seal signing works |
| IT-48 | `courier` calls `sbAccepted` with the staged certificate digests; with wrong digests | Swap performed and `set-secureboot-certs` written; wrong digests `kl:conflict` |
| IT-50 | Alice logs in, locks, unlocks, logs out; loom watches | Events `locked: false`, `true`, `false`, `true` in order, each ≤ 200 ms after the call; `userState` matches after each |
| IT-51 | Two sessions of alice, one locked | `userState(alice).locked == false`; after locking the second: `true`, one event |
| IT-52 | `deleteUser(alice)` | Event `{"user": "alice", "locked": true, "deleted": true}`; `userState` of the deleted user returns `locked = true` |
| IT-53 | `userState` from `gate` on facet `system`; `watchUsers` from `broker` | Both `kl:denied` |
| IT-54 | Restart `hearthd` with alice logged in and unlocked; call `userState` during startup | `locked = true` until the session table is available, then the true value with one event if it differs |
| IT-49 | `assist` with a prompt id other than `sha256:` of the payload PAE | Refused |
| IT-42 | Recovery recipient rotation with `hearth recovery rewrap` | Every user has exactly one `recovery` slot for the new recipient; the hierarchy copy decrypts only with the new key |
| IT-32 | `sbSign("db", payload, envelope)` from `courier` | Signature verifies with the db certificate; gate rotated; from any other caller `kl:denied` |
| IT-33 | `HearthSystem.owners` on facet `system` from `gate` | Returned; `exportPasswd` from `gate` denied |

**Fuzzing targets:** `fuzz_ctap_responses`, `fuzz_owner_registry`, `fuzz_seal_statement`, `fuzz_presence_payload`, `fuzz_quorum_request`, `fuzz_recovery_text`, `fuzz_trustee_card`, `fuzz_fleet_command`. 24 CPU-hours each.

**Conformance:** protocols `vectors/presence/`, `vectors/seal/`, `vectors/dsse/`, `vectors/ids/`, `vectors/firstboot/`, `vectors/tpm/`, `vectors/quorum/`, `vectors/trustee/`, `vectors/recoverykey/`, `vectors/fleetcommand/`.

**Acceptance:** all integration tests pass; §8 budgets are met; the seal-gate constructions (§4.6.3, §4.6.4) and `HearthTpm` (§4.7) are reviewed by two TPM practitioners and the review is recorded in `docs/reviews/`.

---

## 12. Implementation notes

| Crate | Use |
|---|---|
| `keylos-ctap` (in repo) | CTAP 2.1 over `hidraw`: `makeCredential`, `getAssertion`, `hmac-secret`, `clientPin`, `credProtect` |
| `keylos-formats::trustee` (protocols) | GF(2^8) Shamir and share format per protocols §4/§20.19 (no in-repo copy) |
| `coset` 0.3 | COSE keys |
| `ciborium` 0.2 | CBOR |
| `p256`, `ed25519-dalek` | Verification |
| `keylos-presence` | Envelope construction and verification, quorum counting |
| `keylos-tpm-registry` | NV and handle templates |
| `tss-esapi` 7 | TPM (NV, policy sessions, signing, hierarchy changes) |
| `crc` 3 | Recovery key CRC-8 |
| `qrcode` 0.14 | Trustee cards |
| `hkdf`, `sha2`, `zeroize` | Cryptography and memory hygiene |

```
hearth/
  crates/hearthd/ crates/hearth-cli/ crates/keylos-ctap/
  schema/hearth-cli.capnp     repo-local (§5.3)
  tests/ fuzz/ generation/
```

---

Inherited descriptors (fd 3, `KEYLOS_CAPWIRE_FDS`, `KEYLOS_TPM_FD`) are adopted with the `keylos-capwire` helper (protocols §10.5, E16); the binaries need no `unsafe`. Secrets (hierarchy authorizations, PIN-derived values, factors) are held in `memfd_secret` memory through `keylos-vault-client::SecretBuf`-style mapping or, until that is adopted, zeroized heap buffers; factor fds use the protocols §20.10 delivery format. Calls on `vault#hearth` that carry fds need no prior bootstrap resolution (protocols §7.1, E17).

## 13. Decisions and alternatives

| Decision | Alternatives | Rationale | ADR |
|---|---|---|---|
| FIDO2 assertions as presence signatures | TPM-held software key + PIN (malware with root can use it); passwords | A touch can't be performed remotely by malware | [ADR-0011](../../handbook/11-decisions/adr-0011-owner-presence-fido2.md) |
| Per-owner seal gates rotated with an `hmac-secret` chain (touch) or a sealed blob after quorum (headless) | PolicySigned (incompatible with FIDO2); hearth-enforced windows only | TPM-enforced fresh authorization per window | [ADR-0012](../../handbook/11-decisions/adr-0012-sealing-windows.md) |
| Quorum presence for headless machines | A device-local key acting as owner; no sealing on servers | One presence model, signed by humans | protocols §5.4 |
| `hearth` as sole owner-hierarchy holder (`HearthTpm`) | Every service holding owner auth | One place to audit TPM administration | protocols §19.6 |
| Owner registry anchored in NV and carried in config generations | Registry on disk only; keys in the UKI | Offline tamper detection; boot verifies config signatures without network | [ADR-0011](../../handbook/11-decisions/adr-0011-owner-presence-fido2.md) |
| Assisted presence through a TPM platform authenticator | Excluding owners who cannot use roaming keys | Accessibility, with the reduction made visible | protocols §5.3 |
| User lock state exported to `loom` (`userState`, `watchUsers`) | Inferring lock state from vault key wrapping or ledger receipts | Wrapping does not express lock policy, and receipts are a lossy, sealed signal; an explicit, conservative source lets loom pause owners' workflows (protocols §20.25) | [ADR-0068](../../handbook/11-decisions/adr-0068-durable-workflows-loom.md) |
| No root user, no sudo | PAM, sudo, polkit | Administrative acts are presence-signed transactions | [ADR-0023](../../handbook/11-decisions/adr-0023-no-root-no-setuid.md) |
| Recovery key format and derivations of protocols §20.21; trustee shares by Shamir | Vendor escrow; bespoke encodings | Offline, owner-held recovery; one format for every component | [ADR-0032](../../handbook/11-decisions/adr-0032-crypto-shredding.md) |
| Vault recovery slots wrapped to the recovery recipient public key at user creation | Entering the recovery key after first boot; passing the secret through the first-boot bundle | Recovery works from the first boot and the secret never reaches the running system | protocols §20.21, §7.5.4 |

### 13.1 Open issues against protocols

None. Resolved in protocols Appendix E (S2): nv-auth sealing policy and format for every service's file (E7); TPM fd and `KEYLOS_DEV_*` (E8); platform authenticator policy and blob (E9); undefine/redefine as equivalent of `NV_ChangeAuth` (E10); vault slot rules (E11); assist prompt id (E12); hearth-minted `a-` IDs (E13); `TrustedPrompt.secret` (E19); `HearthTpm.sbAccepted` (E20); quorum `admin` facet (E24); persistent-handle owners (E25); seal-credential rotation (E26); second vault-epoch index (E28).
