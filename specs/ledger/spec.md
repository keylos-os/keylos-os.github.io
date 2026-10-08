# keylos/ledger — the receipt log

| | |
|---|---|
| Repository | `github.com/keylos-os/ledger` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `ledgerd` (tier-0 service generation `io.keylos.ledger`), `ledger` (CLI generation `io.keylos.ledger-cli`), crate `keylos-ledger-verify` (offline verifier library and `ledger-verify` binary for Linux, macOS and Windows), crate `keylos-ledger-tiles` (C2SP tlog-tiles implementation) |
| Depends on | `keylos-protocols 1.0` (`keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-presence`, `keylos-tpm-registry`) |
| Runtime peers | `warden` (`Bootstrap`, `ServiceHost`, `FdStore`, TPM fd), `vault` (`vault#ledger`: unit keys), `hearth` (`hearth#presence`: presence and quorum for admin operations; `hearth#tpm`: re-definition of the counter index after a TPM clear; `hearth#system`: `owners` only, for the `recoverySigner` of pending receipts), `journal` (metrics records) |
| Provides | `Ledger` (protocols §7.3.5) on facets `writer` and `reader`; `LedgerWitness` and `LedgerAdmin` (protocols §7.5.5) on facets `witness`, `admin`, `time` and `fleet-export`; the on-disk receipt log; signed, counter-bound checkpoints; the machine identity key |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as described in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

The ledger is the machine's append-only memory of authority. Every grant, approval, effect, spawn, configuration change, seal and transaction in keylos produces a **receipt**. The ledger:

1. **Accepts receipts** from tier-0 writers, completes them (sequence number, chain link, time) and countersigns them.
2. **Commits them to a Merkle tree** in C2SP tlog-tiles layout with RFC 6962 hashing, so any receipt can be proven included and any two states proven consistent.
3. **Publishes signed checkpoints** in C2SP signed-note format and **binds them to a TPM NV monotonic counter** (`0x01300100`), so an offline rollback of the log is detected.
4. **Collects witness cosignatures** from the `vouch` phone, a `fleet` witness or other C2SP witnesses.
5. **Answers queries** by principal, session, event type and time under the read-access rule of protocols §7.3.5, and pushes live updates to watchers.
6. **Protects privacy without breaking verifiability.** Receipts about a human are **sealed** (protocols §13.4): their `data` and `label` are encrypted under the unit key `ledger:<human>:<YYYY-MM>` inside the final payload, so a month of a human's history can be crypto-shredded while the chain, the tree and every proof stay valid. A retention job shreds months older than `ledger.retentionMonths` (default 13).
9. **Replays recovery receipts** that the recovery environment spooled, as `service:ledger` with `onBehalfOf` (protocols §19.3).
7. **Exports** verifiable bundles for audits, incident review and fleet collection.
8. **Provides the time floor** (protocols §3.6) and the **machine identity key** (protocols §3.5).

**Non-goals**

- The ledger is not a general log. Application logs go to `journal`.
- The ledger does not decide anything. It records what writers report and refuses malformed or unauthenticated submissions.
- The ledger does not replace the public transparency logs (`tlog`), which serve distribution. This log is per machine.
- The ledger does not interpret `data` fields beyond the redaction rules of §4.9 and the copying of workflow IDs into `refs` (§4.3.2).
- The ledger is **evidence only** for durable workflows (protocols §20.25): it is not a workflow store, never deduplicates submissions, and offers no coordinator+ledger transaction. `loom`, `broker` and `gate` keep their own durable stores and reconcile their submissions against the ledger with the rules below.

---

## 2. Context and embedded contracts

### 2.1 Position

```
broker, gate, warden, vault, depot, courier, config, strata, aide, hearth, devd, net, bench, compat, journal, fleet, vouch
        │ append(envelope) — route ledger#writer
        ▼
     ledgerd ──► /store/rcpt (tiles, entry bundles, bodies, index) ──► TPM NV counter 0x01300100
        ▲  get/query/checkpoint/prove/consistency/watch — ledger#reader (every principal, filtered)
        │  LedgerWitness — ledger#witness (vouch, fleet)
        │  LedgerAdmin — ledger#admin (owner shell); timeFloor — ledger#time (net, warden)
        │  LedgerAdmin.export, metadata only — ledger#fleet-export (fleet)
        │
   shell (`ledger` CLI), atrium (activity view), aide (session timelines), fleet, vouch
```

`warden` starts `ledgerd` first among the tier-0 services, before `broker`: every other writer needs it.

### 2.2 Embedded contracts (verbatim from `keylos-protocols 1.0.0`)

The following blocks are copied mechanically from `protocols/spec.md`. If anything here disagrees with protocols, protocols wins.

#### 2.2.1 Identifiers, time and signed documents

<!-- BEGIN protocols §3.2 (verbatim) -->
> **protocols 3.2 Typed references**

```
ref         = kind ":" digest
kind        = "obj" / "gen" / "src" / "drv" / "rcpt" / "key"
```

| Kind | Meaning | Digest algo |
|---|---|---|
| `obj` | A store object (a regular file in the store) | `fsv256` |
| `gen` | A generation: an EROFS composefs metadata image | `fsv256` |
| `src` | A source input (git tree or archive) | `sha256` of the **canonical tar stream** defined in §11.2 (for git trees and for archives after normalisation) |
| `drv` | A build derivation (recipe + resolved inputs) | `sha256` of the canonical JSON derivation |
| `rcpt` | A ledger receipt | `sha256` of the DSSE envelope bytes |
| `key` | A public key | `sha256` of the SubjectPublicKeyInfo DER |

Example: `gen:fsv256:3f9a…c01e` (64 hex characters).
<!-- END protocols §3.2 -->

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

<!-- BEGIN protocols §3.6 (verbatim) -->
> **protocols 3.6 Time**

- On the wire: `Timestamp { unixNanos :Int64 }` in UTC.
- In documents: RFC 3339 with `Z` and at most nanosecond precision.
- The system clock MUST be disciplined by NTS-authenticated time (owned by the `net` repo).
- Components that check expiry (tokens, TUF, certificates) MUST treat the clock as **untrusted until the first NTS sync after boot**. Until then they use the **time floor**: the time of the newest ledger checkpoint (`LedgerAdmin.timeFloor`, §7.5.5). `net` steps the clock forward to the time floor at boot if the RTC is earlier. The RTC is never trusted to move time backwards past the floor.
<!-- END protocols §3.6 -->

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

<!-- BEGIN protocols §7.5.5 (verbatim) -->
> **protocols 7.5.5 `ledger-sys.capnp`**

```capnp
@0xc7a1e5d3b2f40024;
using C = import "common.capnp";
using L = import "ledger.capnp";

interface LedgerWitness {          # facet witness (vouch, fleet)
  pending        @0 (afterTreeSize :UInt64) -> (checkpoint :L.Checkpoint, consistency :List(Data), fromSize :UInt64);
  addCosignature @1 (treeSize :UInt64, cosignatureLine :Text) -> ();
}

interface LedgerAdmin {            # facet admin (owner shell, warden for timeFloor)
  export           @0 (filterJson :Text, out :C.Fd) -> (bytes :UInt64);
  resetWriter      @1 (service :Text, presenceEnvelope :Data) -> ();
  timeFloor        @2 () -> (time :C.Timestamp);
  status           @3 () -> (json :Text);
  acknowledgeAlarm @4 (alarmId :Text, presenceEnvelope :Data) -> ();
  shred            @5 (human :Text, month :Text, presenceEnvelope :Data) -> (receipts :UInt64);
      #! month "YYYY-MM": destroys the ledger unit key ledger:<human>:<month> through vault.forget; writes ledger.shred.
      #! Without presence only months older than the configured retention (default 13) may be shredded (automatic job)
}
```

`timeFloor` is also served on facet `time` (net, warden). On facet `fleet-export`, `export` returns metadata-only receipts (sealed payloads omitted) unless an owner exception of kind `fleet-receipt-access` (§20.9) covers the event type.
<!-- END protocols §7.5.5 -->

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

<!-- BEGIN protocols §7.3.6 (verbatim) -->
> **protocols 7.3.6 `vault.capnp`**

```capnp
@0xc7a1e5d3b2f40006;
using C = import "common.capnp";

struct ItemAcl {
  actors  @0 :List(Text);        # actor patterns, e.g. "app:gen:fsv256:…", "app:name=org.example.Editor"
  ops     @1 :List(Op);
  prompt  @2 :PromptPolicy;
  enum Op { read @0; use @1; update @2; delete @3; }
  enum PromptPolicy { never @0; perSession @1; always @2; presence @3; }
}

struct ItemInfo { name @0 :Text; kind @1 :Text; created @2 :C.Timestamp; acl @3 :ItemAcl; }

interface Vault {
  open    @0 (name :Text, purpose :Text) -> (secret :C.Fd);       #! delivery format §20.10 (memfd_secret, mmap-only, length-prefixed)
  store   @1 (name :Text, kind :Text, value :C.Fd, acl :ItemAcl) -> ();   # value.index 0xFFFF = ACL-only update
  delete  @2 (name :Text) -> ();
  list    @3 () -> (items :List(ItemInfo));
  sign    @4 (name :Text, alg :Text, data :Data) -> (signature :Data);   # key never leaves vault
  sshAgent @5 () -> (socket :C.Fd);                                     # per-principal SSH agent protocol socket
  dataKey @6 (unit :Text) -> (key :C.Fd);                                # crypto-shred unit key (facets strata, ledger, gate, aide, journal, loom; each only for its own unit prefix)
  forget  @7 (unit :Text) -> ();                                         # destroy unit key (same facets)
  inject  @8 (name :Text, target :Text) -> (handle :Data);              # facet gate only: opaque handle for credential injection
}
```

An injection handle is redeemed by `gate` with `open("inject:<hex handle>", purpose)` on facet `gate`.
<!-- END protocols §7.3.6 -->

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

#### 2.2.5 Receipts

<!-- BEGIN protocols §13.1 (verbatim) -->
> **protocols 13.1 Receipt payload (`keylos.receipt/1`)**

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

Rules:
- `seq` and `prev` are assigned by `ledger`. The writer signs the payload with `seq: 0` and `prev: null` (the **submitted form**); `ledger` fills them in, countersigns the final payload, and stores both signatures with the submitted form's digest. Verifiers reconstruct the submitted form (set `seq` to 0 and `prev` to null) to verify the writer's signature, and verify `service/ledger`'s signature over the final payload.
- **Signatures.** The stored envelope carries exactly two signatures, in this order: the writer's (over the PAE of the submitted form), then `service/ledger`'s (over the PAE of the final payload). They are told apart by `keyid`; signature objects carry no other members (no `scope`).
- **Ledger-originated receipts** (events the ledger writes itself, such as its own `ledger.key.register`, `ledger.alarm`, `ledger.redact` and `ledger.shred`): `writer` is the ledger's own principal and so is `subject`, except for replays of spooled receipts (§20.22), which keep the original subject and are sealed exactly when §13.4 requires it (a person's subject); a receipt whose subject is the ledger is never sealed. The envelope carries exactly one signature, `service/ledger`'s over the final payload; there is no submitted-form signature. `subject` is never empty: a writer whose event has no natural subject names its own principal. The first receipt of an empty ledger, and of every ledger epoch after an alarm, is the ledger's own `ledger.key.register {service: "ledger", spki, keyRef}`, so readers obtain the machine key through `Ledger.serviceKey("ledger")`. Verifiers (`keylos-formats`) accept both forms.
- **Time order.** `time` is non-decreasing in `seq`. The ledger orders each group commit by (`time`, arrival) before assigning sequence numbers, and refuses a submission whose `time` is earlier than the current head's with `kl:invalid` and a message containing `re-sign`. The writer then rebuilds the submitted form with a fresh `time`, signs it again and resubmits (writer libraries do this, with bounded retries). A resubmission is a new submission; the ledger does not deduplicate, and logical deduplication is the writer's responsibility. The rule keeps every month unit, retention cut and `since`/`until` range a contiguous `seq` range, so a late receipt can never land in a month that was already shredded or expired.
- Event names are registered in §19.3.
- Receipts with personal payloads carry `sealed` instead of clear `data` and `label` (§13.4).
<!-- END protocols §13.1 -->

<!-- BEGIN protocols §13.3 (verbatim) -->
> **protocols 13.3 Checkpoints**

- `ledger` emits a **C2SP signed-note checkpoint** (origin `keylos-ledger/<machine key>`) at least every 60 s while there is activity, and on shutdown.
- The TPM NV counter `0x01300100` (§19.6) is incremented at most once per 900 s while there is activity, at shutdown, and immediately after security-class events (`grant.revoke`, `config.apply`, `gen.seal`, `update.commit`, `key.enroll`, `key.remove`, `ledger.alarm`). Every checkpoint note carries the extension line `counter <n>` with the current counter value, binding the tree size and root hash in the signed note to the counter. A ledger whose newest checkpoint counter is below the NV value has been rolled back.
- Checkpoints MAY be submitted to owner-configured witnesses (`LedgerWitness`, §7.5.5: the `vouch` phone, a fleet witness).
- `ledger.key.register` receipts are never sealed; their `data` is `{"service": "<name>", "spki": "<base64 DER>", "keyRef": "key:sha256:…"}`. `Ledger.serviceKey` (§7.3.5) answers from them.
<!-- END protocols §13.3 -->

<!-- BEGIN protocols §19.3 (verbatim) -->
> **protocols 19.3 Receipt events**

| Event | Writer |
|---|---|
| `boot`, `shutdown`, `spawn`, `exit`, `debug.attach`, `debug.detach` | warden |
| `grant.issue`, `grant.attenuate`, `grant.delegate`, `grant.revoke`, `grant.deny`, `label.raise`, `approval.request`, `approval.decide` | broker |
| `effect.stage`, `effect.commit`, `effect.fail`, `effect.cancel`, `effect.compensate`, `effect.complete`, `effect.unknown`, `effect.resolve`, `net.connect` (sampled per policy), `net.listen`, `budget.charge`, `budget.exhausted`, `budget.carve`, `budget.open`, `budget.settle`, `budget.close` | gate (for caller-executed kinds, §14.2, and for every durable effect, `effect.commit` means "authorized"; `effect.complete` records a confirmed outcome and `effect.unknown` an unknown one, §20.26; the executor of a caller-executed kind writes its own completion receipt) |
| `secret.open`, `secret.store`, `secret.delete` | vault |
| `gen.install`, `gen.seal`, `gen.revoke`, `gen.gc` | depot |
| `update.stage`, `update.commit`, `update.rollback` | courier |
| `config.plan`, `config.apply`, `config.revert`, `config.activation-rollback` | config |
| `txn.begin`, `txn.commit`, `txn.abort`, `txn.undo`, `snapshot.create`, `snapshot.delete`, `unit.create`, `unit.forget`, `backup.run`, `backup.restore-test`, `anchor.rollback-detected` | strata |
| `agent.start`, `agent.stop`, `agent.merge`, `model.change` | aide |
| `workflow.enroll`, `workflow.claim`, `workflow.step`, `workflow.wait`, `workflow.pause`, `workflow.resume`, `workflow.outcome-unknown`, `workflow.resolve`, `workflow.migrate`, `workflow.complete`, `workflow.fail`, `workflow.cancel`, `workflow.forget`, `workflow.recover`, `workflow.rollback-detected` | loom (§20.25: minimal transition metadata, never model or tool content) |
| `user.login`, `user.lock`, `user.create`, `user.delete`, `key.enroll`, `key.remove`, `presence.assert`, `seal.window`, `quorum.request`, `quorum.complete`, `guest.start`, `guest.end` | hearth |
| `device.grant`, `device.authorize`, `device.deauthorize` | devd |
| `net.change` | net |
| `vm.start`, `vm.stop`, `vm.snapshot`, `vm.fork`, `vm.commit`, `vm.discard`, `media.attach`, `media.eject`, `media.export` | bench |
| `recovery.enter`, `recovery.delay`, `recovery.wipe` | recovery environment (`rescue`), spooled (§20.22) and appended by ledger |
| `legacy.import`, `legacy.open` | compat |
| `journal.segment` | journal |
| `ledger.key.register`, `ledger.redact`, `ledger.alarm`, `ledger.witness`, `ledger.export`, `ledger.shred` | ledger |
| `fleet.enrol`, `fleet.unenrol`, `fleet.policy.apply`, `fleet.command`, `fleet.attest` | fleet |
| `vouch.pair`, `vouch.remove`, `vouch.witness.cosigned`, `vouch.witness.conflict` | vouch |
| `pod.admit`, `pod.deny`, `pod.start`, `pod.stop` | cri |

**Recovery-replayable events.** The recovery environment cannot reach `ledger`; it spools receipts (`keylos.pendingreceipt/1`), which `ledger` appends at the next normal boot with `writer = service:ledger` and an extra field `onBehalfOf` naming the original writer. Only these events are recovery-replayable: `key.enroll`, `key.remove`, `presence.assert`, `config.revert`, `config.apply`, `update.rollback`, `user.create`, `recovery.enter`, `recovery.delay`, `recovery.wipe`.

**Extension rule.** A repository MAY emit additional events named `x-<repo>.<event>` (for example `x-strata.replica.send`). They MUST be listed in that repository's spec, MUST be written only by that repository's services, and carry no semantics for other components. Events named without a prefix MUST appear in this table.
<!-- END protocols §19.3 -->

#### 2.2.6 Layout, registries and shared formats

<!-- BEGIN protocols §10.1 (verbatim) -->
> **protocols 10.1 Host layout**

| Path | Content | Properties |
|---|---|---|
| `/` | OS generation (composefs, `verity=require`) | ro |
| `/usr` | Part of the OS generation | ro |
| `/etc` | Merged config generation (confext) | ro |
| `/var` | btrfs subvolume `@var` | rw, `nosuid,nodev,noexec` |
| `/home/<user>` | btrfs subvolume per user | rw, `nosuid,nodev,noexec` |
| `/home/<user>/.apps/<app-name>/{config,data,cache,state}` | Subvolume per app and user | the only writable paths in an app's view |
| `/store/objects/<2 hex>/<62 hex>` | Store objects, fs-verity enabled, mode 0444 | written only by `depot` |
| `/store/gens/<64 hex>.erofs` | Generation images | |
| `/store/evidence/` | Generation statements, attestations, consent records | `depot` |
| `/store/db/` | `depot` database | |
| `/store/rcpt/` | `ledger` data | |
| `/keystore` | btrfs subvolume `@keystore`, **excluded from all snapshots** | `vault`, `hearth`, `ledger`, `strata` key material (wrapped) |
| `/snapshots` | btrfs snapshot area, `strata` only | |
| `/run` | tmpfs | |
| `/run/keylos/svc/<svc>/` | Service socket directories | 0700 warden |
| `/run/keylos/boot/trust.json`, `report.json` | Boot trust set and boot report (§20.1) | 0444, written by `boot` |
| `/var/lib/keylos/<repo>/` | Each service's private state directory (other repos may read only the files listed in §10.7) | owned by the service's dynamic UID |
| `/var/lib/keylos/cri/images/` | OCI content store for `keylos-vm` pods (unsealed, never executed on the host) | `cri`; `noexec`; shared read-only into pod VMs |
| `/efi` | ESP | mounted only during updates (and by `boot` for `/efi/keylos/vbu-totp.sealed`) |

**App mount view** (what a tier-1 process sees):
- its app generation at `/` (with `/usr` from its runtime generation if it declares one);
- `/etc` filtered to the app-visible subset (`/etc/keylos/app-visible.list` in the config generation);
- its `.apps/<name>` subvolumes at `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `$XDG_CACHE_HOME`, `$XDG_STATE_HOME` (idmapped to its dynamic UID);
- `/run/user/<uid>/` with only its Wayland socket (security-context tagged) and its PipeWire remote if granted;
- `/grants/` (initially empty; runtime grants are attached here);
- `/tmp` as a private tmpfs;
- nothing else.
<!-- END protocols §10.1 -->

<!-- BEGIN protocols §10.6 (verbatim) -->
> **protocols 10.6 Log records**

Processes write logs to the journal stream fd (fd 2 is connected to it by default) as:
- plain text lines, or
- **structured records**: a datagram whose first byte is `0x1E` followed by a CBOR map with keys `l` (level 0–7), `m` (message) and `f` (fields map), or
- **metrics records**: a datagram whose first byte is `0x1F` followed by a CBOR map with keys `n` (metric name), `t` (`"counter"` | `"gauge"` | `"histogram"`), `v` (number, or for histograms a map of bucket bound → count plus `sum` and `count`) and `l` (labels map).
<!-- END protocols §10.6 -->

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

<!-- BEGIN protocols §19.2 rows=^\| ledger \| (verbatim) -->
> **protocols 19.2 Facets** (rows for this repository)

Every route names exactly one facet. Servers MUST implement exactly these facets; holders other than those listed are routed only when policy explicitly grants `right("service", "<svc>#<facet>", "use")`.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| ledger | `writer` | tier-0 services listed as writers in §19.3 | `Ledger` (all) |
| ledger | `reader` | every principal | `Ledger` except `append` (filtered, §7.3.5) |
| ledger | `witness` | vouch, fleet | `LedgerWitness` |
| ledger | `admin` | owner `shell` | `LedgerAdmin` (including `shred`) |
| ledger | `time` | net, warden, depot | `LedgerAdmin.timeFloor` |
| ledger | `vouch-heartbeat` | vouch | `Ledger.query`/`watch` restricted to metadata (time, subject human) of `user.login` receipts of every human (§20.19) |
| ledger | `fleet-export` | fleet | `LedgerAdmin.export` (metadata only unless an owner `fleet-receipt-access` exception covers the event type) |
<!-- END protocols §19.2 rows=^\| ledger \| -->

<!-- BEGIN protocols §19.4 rows=receipt|ledger (verbatim) -->
> **protocols 19.4 Media types and formats** (rows for this repository)

| Schema | Media type | Owner (full definition) | Purpose |
|---|---|---|---|
| `keylos.receipt/1`, `keylos.receipt-redacted/1` | `application/vnd.keylos.receipt+json; version=1` | protocols §13, ledger | Receipts |
| `keylos.pendingreceipt/1` | `application/vnd.keylos.pendingreceipt+json; version=1` | protocols §20.22 | Receipts spooled by the recovery environment |
| `keylos.ledger-export/1` | (export file) | ledger | Ledger exports |
<!-- END protocols §19.4 rows=receipt|ledger -->

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

#### 2.2.7 Receipt privacy, exceptions, quorum presence, TPM administration and cross-repository files

<!-- BEGIN protocols §13.4 (verbatim) -->
> **protocols 13.4 Receipt privacy**

- **Which receipts are sealed.** Every receipt whose `subject` has a human other than `_system` and `_cluster` is stored **sealed**: the final payload has `"data": null, "label": null` and
  `"sealed": {"unit": "ledger:<human>:<YYYY-MM>", "alg": "aes-256-gcm", "nonce": "<base64 12 bytes>", "ct": "<base64 of the JCS bytes of {\"data\":…, \"label\":…}>", "submitted": "sha256:<digest of the submitted form>"}`.
  The AEAD associated data is the UTF-8 bytes of `sealed.unit`, one `0x00` byte, then the UTF-8 bytes of `sealed.submitted`. Optional top-level `refs` (object; values only `rcpt:`/`gen:`/`drv:` refs and `e-`/`a-`/`wf-`/`wr-`/`ws-`/`fx-`/`dr-`/`ba-` IDs) is added by the ledger and is not part of the submitted form. `ledger.key.register` is never sealed. Final receipts start at `seq` 1 (`prev: null` exactly for `seq` 1); signatures follow §13.1. Replayed receipts carry a top-level `onBehalfOf`.
  The month is the receipt's `time` month (UTC). The unit key comes from `vault.dataKey` on facet `ledger`.
- **What stays in clear:** `schema`, `seq`, `prev`, `time`, `writer`, `subject`, `event`, `approval`, and reference values the event registry marks as `refs` (rcpt/gen/drv refs; intent, approval, workflow, run, step, effect, decision and budget-account IDs; never free text or paths). For `workflow.*` and for `effect.*`, `approval.*`, `grant.*` and `budget.*` receipts that name a workflow, the ledger copies `data.workflow`, `data.run`, `data.step`, `data.effect`, `data.decision` and `data.account` into `refs`, so cancellation and effect evidence stays readable after a month is shredded (§20.25).
- **Integrity.** The hash chain and `service/ledger`'s countersignature cover the final (sealed) payload, so shredding a month preserves chain integrity. The writer's signature covers the submitted (clear) form; it is verifiable while the unit key exists. After shredding, writer attribution rests on the ledger countersignature and `sealed.submitted`.
- **Shredding.** `LedgerAdmin.shred` (§7.5.5) destroys `ledger:<human>:<YYYY-MM>`; an automatic job shreds months older than `ledger.retentionMonths` (default 13, configurable, minimum 1). Event `ledger.shred`.
- **Readers** follow §7.3.5. `fleet` sees metadata only unless an owner exception of kind `fleet-receipt-access` lists the event types.
- **Backups and exports** contain the sealed form; `ledger export` produces a self-contained verifiable bundle (`keylos.ledger-export/1`) and decrypts payloads only for the exporting owner.
- **Returned form.** `Ledger.get`, `query` and `watch` return each receipt as the stored final DSSE envelope (JSON object). When the reader may decrypt a sealed payload, the returned object carries one extra top-level member `"clear": {"data": …, "label": …}` (JCS). Verifiers MUST remove `clear` before checking signatures and computing the `rcpt:` digest, and MUST check `sealed.submitted` against the submitted form rebuilt from the clear values when verifying the writer signature.
<!-- END protocols §13.4 -->

<!-- BEGIN protocols §20.9 (verbatim) -->
> **protocols 20.9 Owner exception (`keylos.exception/1`)**

Presence-signed (purpose `exception`):

```json
{"schema":"keylos.exception/1","kind":"reproducibility","name":"org.example.Tool","publisher":"key:sha256:…",
 "generation":null,"reason":"vendor binary","scope":"machine","decidedBy":"alice","time":"…","expires":null}
```

`kind`:
- `reproducibility`: allows effective tier 1 for a non-reproducible or `unreviewed` generation. `generation` null matches all generations of `name` from `publisher`.
- `fleet-receipt-access`: `{"events": ["<event type>", …]}` in an extra field `events`; lets `fleet` read sealed payloads of those events (§13.4). `name`/`publisher` are null.

Exceptions are written by `config` to `/etc/keylos/exceptions/` (§10.7); `depot` and `ledger` read them from the booted config generation.
<!-- END protocols §20.9 -->

<!-- BEGIN protocols §5.4 (verbatim) -->
> **protocols 5.4 Quorum presence**

Headless profiles (`server`, `server-k8s`, `cloud`, `appliance`) and managed machines use **quorum presence** instead of a local touch. The owner registry (§20.3) then has `policy.mode = "quorum"` and `policy.threshold = N`, with M approver credentials (the owners' FIDO2 credentials, enrolled like any owner credential).

- A **quorum presence envelope** is an ordinary DSSE envelope over the same payload with **≥ N signatures** (§5.3 construction) from credentials of **distinct owners**. Verifiers MUST count distinct owners, not signatures.
- Collection: `hearth` creates a quorum request (`keylos.quorum/1`, §20.18) through `HearthQuorum.request` (§7.5.3); approvers receive it through `fleet` (or out of band as a file), review the rendered payload on their own keylos machine, and sign it there with `hearth presence --remote <request>` (their machine's `hearth` signs with their own credential and rpId `keylos.owner`); signatures return through `HearthQuorum.submit`. The request expires after at most 24 h.
- Every purpose of §20.2 accepts a quorum envelope on quorum machines. On `desktop`/`laptop` profiles quorum envelopes are accepted only for owner-registry changes that the registry policy marks `quorum`.
- **Seal gate on quorum machines.** No touch reaches the machine, so the seal gate's authValue for the window is released differently: `hearth` holds the next gate authValue in a TPM-sealed blob bound to the signed PCR11 `ready` phase and PCR15, and unseals it only after verifying a quorum envelope of purpose `seal.window`. This reduces the guarantee from "a physical touch" to "N approvers signed and the machine runs a verified `hearth`"; the reduction is shown in `status` (`sealing: quorum`).
<!-- END protocols §5.4 -->

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

<!-- BEGIN protocols §20.16 (verbatim) -->
> **protocols 20.16 Service table (`keylos.services/1`)**

`/etc/keylos/services.json` (JCS), rendered by `config`, read by `warden`, `boot` and `ledger`:

```json
{"schema":"keylos.services/1",
 "bootstrapGens":{"journal":"gen:fsv256:…","ledger":"gen:fsv256:…","depot":"gen:fsv256:…"},
 "services":{
   "strata":{"generation":"gen:fsv256:…","entrypoint":"main","tier":0,"perHuman":false,
             "uid":"dynamic","network":"none","writer":true,
             "privileges":{"capabilities":["CAP_SYS_ADMIN"],"paths":[{"path":"/snapshots","access":"rw"}],
                           "devices":[],"tpm":false},
             "bpf":["/usr/lib/keylos/bpf/strata/provenance.o"],
             "routes":[{"to":"vault","facet":"strata"},{"to":"warden","facet":"strata"}],
             "readiness":{"timeoutSecs":30},"watchdogSecs":10,"restart":"on-failure"},
   "portal-files":{"generation":"gen:fsv256:…","perHuman":true,
             "privileges":{"paths":[{"path":"/home/{human}","access":"rw"}]}, "…":"…"}
 }}
```

- `bootstrapGens` are mounted by `warden` before `depot` runs (§20.1).
- `writer: true` registers the service's key as a ledger writer (`ledger` reads this field).
- `privileges.paths` MAY use the placeholder `{human}` for per-human services; `warden` substitutes it per instance. Each entry's `access` is `ro` or `rw`.
- `bpf`: BPF objects `warden` loads for the service (§9.3); only paths under `/usr/lib/keylos/bpf/<service>/`.
- `network`: `"none"` (private netns with `lo`), `"gate"` (egress via gate only), `"host"` (host netns; listed services only: `net`, `gate`), `"cluster"` (the cri network namespace from `NetPlumbingCluster.clusterNetns`; `server-k8s` only: `cri`, `kubelet`, `kube-proxy`).
- Fields not listed here are `warden`-local and MUST be prefixed `x-`.
<!-- END protocols §20.16 -->

<!-- BEGIN protocols §10.7 rows=ledger|nv-auth (verbatim) -->
> **protocols 10.7 Cross-repository files** (rows for this repository)

A repository MAY read a file written by another repository **only if the file is listed here**; everything else is that repository's private state.

| Path | Format | Writer | Readers |
|---|---|---|---|
| `/etc/keylos/services.json` | `keylos.services/1` (§20.16) | config | warden, boot, ledger |
| `/etc/keylos/exceptions/*.dsse` | `keylos.exception/1` envelopes (§20.9) | config | depot, ledger, warden (effective tiers) |
| `/var/lib/keylos/tpm/nv-auth/<index>.sealed` | `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` of the sealed authValue object (§19.6, "Sealed secrets"); `<index>` is `0x` + 8 lowercase hex digits, e.g. `0x01300100.sealed` | installer at genesis; hearth on (re)definition (`HearthTpm.defineSpace`); `rescue` (recovery profile) | the index's registered owner service only |
| `/var/lib/keylos/recovery/pending/<ULID>.dsse` | `keylos.pendingreceipt/1` (§20.22) | recovery environment (`rescue`, installer repo) | ledger (appends at the next normal boot, then deletes) |
| `/keystore/ledger/signing.sealed` | TPM-sealed Ed25519 seed of the machine key | installer | ledger (MUST accept an existing key) |
<!-- END protocols §10.7 rows=ledger|nv-auth -->

#### 2.2.8 Durable execution (receipt outbox and rollback anchoring)

<!-- BEGIN protocols §20.25 (verbatim) -->
> **protocols 20.25 Durable execution**

A **workflow** is an enrolled, durable task: a pinned definition (§20.27) run by `loom` as a sequence of steps, each executed by one or more **attempts**. The central invariant is normative for every component named in this section:

> Workflow progress survives execution attempts. Authority is revalidated before every further effect, and persistence never resurrects revoked permissions or cancelled work.

Boot-scoped authority is unchanged: tokens, root keys, sessions and prompt IDs never outlive their boot (§8.1). What survives is the record of progress and of decisions, never the authority to act on it.

**Roles.**

| Component | Durable responsibility | Never |
|---|---|---|
| `loom` | Workflow store: enrollments, runs, steps, attempts, recorded observations, timers, signals, tombstones; scheduling, claims, cancellation; the receipt outbox | holds workflow authority, executes effects, decides approvals |
| `broker` | Workflow records (approved scope, ownership epoch, label high-water mark, cancellation), attempt authority at registration, durable decisions | trusts loom for anything but the identity of the next claim |
| `gate` | Durable effect records by effect ID, executor strategies, workflow budget accounts | executes an effect without current authorization |
| `warden` | A fresh session for every attempt process (`SpawnSpec.attempt`) | persists sessions or fds, interprets attempt bindings |
| `aide` | Agent sessions as attempts (`AgentWorkflowHost`); model and tool observations recorded through `loom` | resumes an agent session that is not an attempt of an enrolled workflow |
| `strata`, `bench` | Prepared merges and their completion records retained for the workflow's horizon, reachable by a fresh attempt | bind a prepared merge to a dead session only |
| `vault` | `loom:` unit keys (wrapped under the system key, forgettable) | enforce the owner-lock policy (loom does) |
| `ledger` | Signed evidence of decisions, transitions and outcomes | act as a workflow store or deduplicate submissions |
| `hearth` | The owner's lock state (`HearthSystem.userState`, `watchUsers`) | |

**Identities** (§3.5). `WorkflowId` (`wf-`) names the enrolled task, `RunId` (`wr-`) one run of it, `StepId` (`ws-`) one occurrence of one state in a run, `AttemptId` (`wa-`) one execution attempt, `EffectId` (`fx-`) one logical external or local operation shared by all retries, `OwnershipEpoch` the fence advanced by every claim, `DecisionId` (`dr-`) a durable approval, `BudgetAccountId` (`ba-`) the workflow's budget. Step and effect IDs are derived, so a replayed step finds the records of its earlier attempts. A session ID is never the identity of durable work: every attempt runs under fresh sessions, and loom records the attempt-to-session mapping. Old principals, bearer tokens, fds and prompt IDs are never stored as replay material; signatures and digests are stored as evidence and re-verified, never as a substitute for current policy.

**Status vocabulary.** `WorkflowInfo.status` (§7.3.16) and the `status` of `workflow.*` receipts take exactly these values; `detail` carries one of the listed codes.

| Status | Meaning | `detail` codes |
|---|---|---|
| `running` | An attempt is executing or a claim is scheduled | `step:<ws-…>` |
| `waiting` | No attempt is needed until an external event | `decision:<dr-…>`, `timer:<RFC 3339 time>`, `signal:<name>`, `effect:<fx-…>` (awaiting the executor's outcome), `enrollment:<dr-…>` |
| `paused` | Eligible work is held back by a pause condition | `user`, `locked` (owner locked), `awaiting-resume` (manual resume after a restart), `breaker`, `budget`, `time-untrusted`, `rollback-review`, `capacity` |
| `blocked-by-authority` | The next step needs authority that does not exist now | `revoked`, `policy`, `decision-denied:<dr-…>`, `decision-expired:<dr-…>`, `definition-revoked`, `horizon` |
| `outcome-unknown` | An effect's outcome cannot be established automatically | `effect:<fx-…>` |
| `completed`, `failed` | Terminal: the definition reached an `end` state (`failed` also for `history-lost`) | `end:<state>`, `error:<code>`, `history-lost` |
| `cancelled` | Terminal: durably cancelled | `by:<human>` |
| `forgotten` | Terminal: history crypto-shredded; only a tombstone remains | none |

**Enrollment.** Enrollment is the only way work becomes resumable; an agent, app or guest session never becomes durable by being paused, stopped or restarted.
1. A human's `shell` (or `atrium`) calls `Loom.enroll` on `loom#user`. loom checks the definition (§20.27): the generation is launchable and not revoked (`Depot.get`), its manifest lists the name in `provides.workflows`, and the file's digest equals `DefinitionRef.digest`; it validates the input against the definition's input schema, assigns the `wf-` ID, and commits an `enrolling` record (deduplicated by owner and `idempotencyKey`).
2. loom calls `BrokerWorkflow.enroll(<caller session>, EnrollRequest)`. The broker evaluates Cedar `enroll` (§16.1) and every scope item as a persistent request; the tier is the maximum, at least `t2`, with presence when `resume = automatic` or `runWhileLocked` (as for persistent grants); guest humans and non-`shell` subjects are denied by default policy. The decision is a durable decision (below) with key `enroll` and the mandate effects `workflow.enroll` plus one `grant.<k>` per scope item (§14.2).
3. When approved, the broker writes the workflow record `keylos.workflow-grant/1` (signed by `service/broker`, file and directory `fsync`ed), with the label baseline = the enrolling session's label at that moment, the horizon (`horizonSecs` capped by policy, default 30 days, maximum 400 days) and the budget account, which it opens with `WorkflowBudget.open` on `gate#broker`. Only then does the workflow leave `waiting` (`enrollment:<dr-…>`).
4. The enrolling session's tokens are never used by the workflow; the approved scope is the only authority later attempts can receive.

**Claims and ownership fencing.** loom executes every step through a **claim**: before an attempt, loom commits the claim (new `wa-`, epoch e + 1, the activity's generation, the spawner session) in its store, then calls `BrokerWorkflow.claim`. The broker accepts only epoch = its record's epoch + 1 (`kl:conflict` otherwise: a stale or second coordinator, or a restored store), persists it before replying, and revokes every root minted for earlier attempts of the workflow. Every consumer rejects a stale epoch where it can still prevent an action: loom's `AttemptHost` (every method), the broker at attempt registration and in `authorizeEffect`, `gate` in `DurableEffects` (binding versus the token's `workflow` fact and the current claim, `BrokerWorkflow.verify`), strata in `preparedFor` and `bindWorkflow`. A process that missed a cancellation or lost its coordinator may stay alive; it cannot act, because its roots are revoked and its epoch is stale. A cooperative stop or an expired lease alone never authorizes anything. A new fence cannot undo a request a remote system already accepted; such effects are settled by their effect ID (§20.26). One loom instance owns the store exclusively (SQLite exclusive locking plus a lock file); a second instance fails its first claim with `kl:conflict` and stops.

**Attempt authority.** An attempt is a fresh principal: a process spawned by loom (`SpawnSpec.attempt`, principal `<actor>@<owner>/<loom session>/<attempt session>`) or an agent VM started by `aide` (`VmSpec.attempt`). `warden` forwards the binding in `SessionReg.attempt` and uses `binding.owner` as the principal's human. At registration the broker requires the binding to be the current claim, the child's generation to be the claimed generation, its parent to be the claimed spawner and its human to be the record's owner; otherwise registration fails `kl:conflict` (stale) or `kl:revoked` (cancelled). It then, in this order:
1. sets the session label to the join of the default and the workflow's label high-water mark (labels before grants);
2. re-evaluates every scope item against current policy with the workflow principal entity (§16.1): `t0`/`t1` items are minted, `t2`/`t3` items only with the enrollment mandate, as for persistent grants; revoked, expired, cancelled or denied items are not minted;
3. mints fresh tokens for the attempt session with `workflow(<wf>, <epoch>)`, `budget_account(<ba>)` and `expires` no later than the horizon (§8.2).
The attempt process obtains these tokens like every principal, with `Broker.myGrants` on its `broker#principal` route; `warden` never passes the tokens of `SessionRegResult` to the process. An attempt therefore holds an effect token only for kinds in the enrolled scope: at `enroll`, loom refuses (`kl:invalid`) a scope that lacks an effect item for any kind an activity of the definition declares in `effects`, so `DurableEffects.prepare` always has a token to present. Offered tokens of the spawner are never delegated to an attempt. `BrokerWorkflow.offer` gives `aide` short-lived path and net tokens of the scope on its own session, only to build the attempt VM's shares, exactly as human-offered tokens are used today.

**Durable decisions.** `BrokerWorkflow.decide` creates or returns the durable decision of one logical operation. Its identity is (`workflow`, `key`) and its digest the SHA-256 of the JCS `{"workflow", "key", "requests": [<GrantRequest JSON forms, §14.4>], "effects": [{"kind", "target", "digest"}]}`; neither contains a session, attempt or prompt ID, so a fresh attempt finds the same decision. The same key with another digest fails `kl:conflict`. The broker persists the record before showing any prompt and persists the decision before replying to anyone (a crash between decision and reply loses nothing). Prompts are boot-local and re-presented after restarts (§14.3); `expires` is fixed at creation. A fresh attempt uses an approved grant decision only through `rebind`, which re-checks the record, current policy, revocation, expiry and presence and mints for the new session; an effect decision is consumed by `gate`, once per effect ID (§20.26). A trusted approval is always a decided mandate bound to the operation and payload, never a workflow signal. For a `decide` state (§20.27) the decision carries one `DecisionEffect` per option (kind `workflow.decide`, target `<ws-…>#<option>`, digest over the JCS `{"question", "option"}`); the human approves exactly one option, and the delivered mandate's `effects[]` holds only that entry, the one permitted difference from the draft. `BrokerWorkflow.cancelDecision` withdraws one pending decision (for example when its effect is cancelled).

**Effects.** loom never executes effects. An activity prepares an effect at `gate` with the effect ID loom assigned (`AttemptHost.effect`, `DurableEffects.prepare` with its token); loom commits it later with the current claim (`DurableEffects.commit` on `gate#loom`), and `gate` asks the broker for current authority (`authorizeEffect`) every time. The effect contract is §20.26.

**Labels.** The workflow label is a high-water mark kept by the broker (`BrokerWorkflow.raise`; the broker also raises it whenever an attempt session's label rises). loom stores every observation and result with its label; replayed observations keep their labels; `AttemptHost.task` returns the workflow label; a fresh attempt therefore never restarts at `public/trusted` after the workflow consumed more sensitive or less trusted data. The Rule of Two (§14.1) applies to workflow effects with the workflow label.

**Budgets.** Each workflow has one budget account (`ba-`) with the enrollment's ceilings, held by `gate` independently of token roots. Attempt tokens carry `budget_account`, so metered spending is charged to the account whatever root the attempt holds; new roots never reset spent amounts. Reservations are keyed (`reserve`, `settle`, `release` are idempotent per key): `gate` uses `<wa-…>:<request number>` for metered requests, loom and aide derive keys from step and observation keys. A reservation of an attempt that was fenced before settling is settled as `unresolved` (still counted against the ceiling) until the actual charge is known; a key is settled at most once with a final amount, so a duplicated completion message never double-charges. The account is closed when the workflow is terminal.

**Recorded observations and replay.** Orchestration is deterministic: the next state depends only on the definition and on recorded outcomes, results, signals and timer firings. Every non-deterministic observation that can influence a later decision (model responses, tool results, clock readings, randomness) is recorded through `AttemptHost.record` before the activity uses it. A later attempt of the same step obtains recorded observations by key (`AttemptHost.recorded`) instead of asking a model or tool again; it calls live only past the last recorded key. Observation keys are `<kind>:<n>` with a per-kind counter that starts at 0 in every step and counts in the order the activity makes the observations, so a deterministic replay reaches the same keys. An activity whose result was never recorded is retried, reconciled or reported per its declared semantics (§20.27); it is never treated as completed because it probably ran.

**Durability.** loom acknowledges an enrollment, transition, observation, result, signal, cancel or forget only after its SQLite transaction (WAL, `synchronous=FULL`) committed, every blob it references was written with `O_TMPFILE`, `fsync`ed, linked and its directory `fsync`ed, and, where a receipt is required, after the receipt is acknowledged. A failed `fsync`, a full disk or any other barrier failure aborts the transaction and is reported `kl:unavailable`; after an `fsync` failure the store is reopened and verified before the next write. A state transition and the messages it causes (claims, effect commits, receipts) are committed in the same transaction as outbox rows and delivered afterwards with stable IDs; deliveries are deduplicated by those IDs on the receiving side.

**Receipt outbox.** loom writes `workflow.*` receipts (§19.3) with `subject` = the principal that enrolled the workflow and `data` = `{workflow, run, n, …}` holding only IDs, states, epochs, digests and reason codes, never inputs, results or model and tool content; `n` is the per-workflow event number and (`workflow`, `n`) the stable logical event ID. Each receipt is an outbox row committed with its transition. Delivery: loom builds and signs the submitted form, persists its `time` and submitted-form digest in the row, then calls `Ledger.append`; on success it records the returned `seq`. A `re-sign` refusal (§13.1) is answered by persisting a new submitted form and resubmitting. **Reconciliation** after a restart: loom first appends `workflow.recover` (subject: loom itself) with a `time` later than every outstanding submission's `time`; once it is acknowledged, no outstanding submission can be appended any more (§13.1 time order), and each is settled by searching its submitted-form digest among loom's receipts after the last acknowledged `seq` (`Ledger.query`, `principalPrefix "service:loom:"`, §7.3.5): found → acknowledged with that `seq`; not found → it was never appended, and loom submits it again as a new submitted form. Each logical event therefore produces at most one receipt, and at least one once the ledger is reachable. The ledger itself never deduplicates; a coordinator+ledger atomic transaction is not claimed.

**Rollback detection.** loom's store records the ledger `seq` of its newest acknowledged receipt. After `workflow.recover` is acknowledged, every loom receipt between that `seq` and the recovery receipt must be an outstanding submission of the store; any other one, a store that is behind the ledger, or a ledger that is behind the store (an alarm epoch, §13.3) means an older store was restored. loom then writes `workflow.rollback-detected`, pauses every workflow (`rollback-review`) and re-applies the authoritative records: `workflow.cancel` and `workflow.forget` receipts after its anchor (their `refs` stay readable after shredding, §13.4) become tombstones; the broker's workflow records give the current epoch and cancellation state; `gate`'s effect records and budget accounts give effect outcomes and spent amounts; a workflow whose history the store no longer has becomes `failed` with `history-lost`, never restarted. Dispatch resumes only after the owner accepts with `loom rollback accept` (presence purpose `loom.rollback-accept`, §20.2). The broker's workflow and decision records and `gate`'s effect records and budget accounts are anchored the same way against their own receipts (`principalPrefix "service:broker:"`, `"service:gate:"`). The anchor rests on the ledger's own rollback protection (NV counter `0x01300100`, §13.3); no further NV index is used. Restoring an older store therefore cannot resurrect cancelled work, reset budgets or repeat effects; restoring the whole disk image is detected by the ledger's counter and leads to the same review.

**Cancellation.** `Workflow.cancel`: (1) loom commits a `cancelling` tombstone; (2) `BrokerWorkflow.cancel` writes the broker's durable cancellation record, revokes every root carrying the workflow fact and cancels the workflow's pending decisions; (3) loom terminates attempts (`Process.kill`, `AgentWorkflowHost.stopAttempt(…, "cancel")`), cancels prepared and awaiting effects (`DurableEffects.cancel`) and drops timers; (4) after `workflow.cancel` is acknowledged, `cancel` returns. Step 2 needs the subject's live session (the broker evaluates Cedar `cancel` for it). If loom restarts between steps 1 and 2 and that session no longer exists, the workflow stays non-runnable (the `cancelling` tombstone allows no claims and no attempts) and loom completes steps 2–4 when the broker's record shows the cancellation or when the owner calls `cancel` again; it never resumes the workflow. Effects already authorized or dispatched are not undone by cancellation: loom keeps resolving their outcomes (lookup, reconciliation) and records them. Cancellation runs no further workflow logic; compensation is a new authorized effect, run before cancelling through the definition's `abort` signal (§20.27). Recovery never re-enrolls a cancelled workflow: its tombstone, the broker's record and the ledger evidence each refuse it.

**Forgetting.** `Workflow.forget` cancels the workflow if it is not terminal, commits a `forgotten` tombstone, then destroys every copy of its private history: `vault.forget("loom:<owner>:<wf-…>")`, `DurableEffects.forget` (gate shreds the workflow's payload unit `gate:<owner>:<wf-…>`), discard of retained prepared merges, removal of `aide`'s attempt units and `Depot.unroot`. loom evicts cached keys and plaintext, and re-checks the tombstone after every asynchronous key or blob fetch before caching or delivering the result. What remains: loom's tombstone (`wf-`, run IDs, owner, terminal kind, time), the broker's cancellation record, `gate`'s minimal effect records (§20.26) and the ledger's ID-only receipts, which suffice to prevent recreation and contain no private data. Cryptographic erasure completes as the vault reports it (vault rotation). History that is deleted or expired is reported as `forgotten` or `history-lost`, never silently restarted.

**Owner lock.** Key wrapping does not decide execution: `loom:` units are wrapped under the vault's system key, so loom can keep recording outcomes of in-flight operations while the owner is locked. Execution follows an explicit lock policy: a workflow owned by a human pauses (`paused`, `locked`) while that human is locked (`HearthSystem.userState`: no authenticated, unlocked login session; logged out counts as locked), unless it was enrolled with `runWhileLocked` (presence-approved). While paused by the lock, loom makes no claims, dispatches nothing and decrypts no history for execution; overdue timers wait. When hearth is unreachable loom assumes the owner is locked. Workflows of `_system` never pause for a lock. When hearth reports a user deleted (`watchUsers`, `deleted`), loom forgets every workflow of that user.

**Restart and reboot.** At start loom runs the receipt reconciliation and the rollback check, then for each non-terminal workflow reads the broker's record (cancelled → finish the cancellation), looks up every effect that is not settled (`DurableEffects.lookup`), and treats every attempt of the previous run of loom as ended (its sessions are gone or fenced). A workflow with `resume = manual` becomes `paused` (`awaiting-resume`) until its owner calls `Workflow.resume` (Cedar `resume`); one with `resume = automatic` is claimed again without asking, still fully reauthorized by the broker. Steps whose activity result was not recorded continue per the activity's semantics (§20.27).

**Timers, signals and time.** Timers are stored rows; a timer fires only when trusted time (§3.6) has reached its due time, never early; while the clock is not trusted loom uses `max(now, time floor)` and pauses timer-driven work whose due time lies beyond the floor (`time-untrusted`). Decision expiry, horizons and deadlines are checked against trusted time. After a long downtime overdue work is caught up in due order at most `catchUpPerMinute` (default 6) claims per minute, a periodic timer fires once rather than once per missed period, and every overdue item re-checks cancellation, pause, lock, budget and horizon first. Signals are recorded with the sender's label, deduplicated by (name, key); a workflow past its horizon is `blocked-by-authority` (`horizon`): the broker refuses its claims.

**Retention.** History is kept until the workflow is forgotten, or `historyRetentionDays` (default 30) after it became terminal, when loom forgets it automatically. Decision records live until 30 days after the workflow is terminal; effect dedup records per §20.26; tombstones are never deleted. Replay retention is independent of the ledger's monthly audit retention: shredding a receipt month never removes history a live workflow needs, and forgetting a workflow leaves no decryptable copy of its history in any receipt.
<!-- END protocols §20.25 -->

### 2.3 Interpretation notes (normative for this repo)

1. **Submitted-form signatures.** The writer signs the payload with `seq = 0` and `prev = null` (protocols §13.1). The final envelope's payload is the completed payload and carries `signatures[0]` = the writer's signature over the PAE of the submitted form and `signatures[1]` = the ledger's signature over the completed payload's PAE, told apart by `keyid`; signature objects carry no `scope` member (protocols §13.4, E4). Ledger-originated receipts carry only the ledger's signature (§4.4). A verifier reconstructs the submitted form by setting `seq` to `0` and `prev` to `null` in the completed payload, and, for sealed receipts, replacing `data`/`label` with the decrypted values and removing `sealed` (§4.8.4); it then re-canonicalises with JCS and verifies the writer signature over that. `time` is part of both forms: the writer submits its own `time`, and the ledger keeps it if it is within ±5 s of the ledger clock and not earlier than the `time` of the receipt that precedes it in `seq` order; otherwise the append fails `kl:invalid` (§4.3.1). Receipt `time` is therefore non-decreasing in `seq` (protocols §13.1, E5). The committer sorts each group-commit batch by (`time`, arrival) before assigning `seq`, so concurrent writers whose submissions arrive out of order within one batch are not refused; a submission older than the current head fails `kl:invalid` with a message containing `re-sign`, and the writer MUST rebuild the submitted form with a fresh `time`, re-sign and resubmit (writer libraries retry at most 3 times). A resubmission is a new submission: the ledger does not deduplicate. Monotonic time keeps month units, shredding, retention and `since`/`until` filters contiguous in `seq`; a per-writer rule would let a late receipt land in a month that is already shredded. No other transformation is allowed.
2. **Counter binding.** A TPM NV counter can only be incremented. The ledger binds checkpoints to it by writing the counter's current value in every checkpoint note (`counter <n>`) and signing the note (protocols §13.3).
3. **Security-class events** that trigger an immediate counter increment are exactly those listed in protocols §13.3: `grant.revoke`, `config.apply`, `gen.seal`, `update.commit`, `key.enroll`, `key.remove`, `ledger.alarm`.
4. **Owner presence for admin operations** is verified with `keylos-presence` against the owner-presence key set of the boot trust set (`/run/keylos/boot/trust.json`, `keys.ownerPresence`, protocols §20.1). Credentials enrolled after the current boot are accepted for ledger admin operations only after the next boot. Presence payloads MUST be within ±600 s of the ledger clock (replay window) and a nonce is accepted once. Development systems without a boot trust set (no `boot`, development builds only) accept every active credential of the registry from `HearthSystem.owners`.
5. **Quorum machines.** When the owner registry's `policy.mode` is `quorum` (protocols §5.4), every presence envelope required by this spec MUST be a quorum envelope with signatures of at least `threshold` distinct owners; `keylos-presence` verifies it in quorum mode.
6. **Sealing is done by the ledger.** Writers submit receipts with clear `data` and `label` (the submitted form). The ledger seals them when it completes the payload (§4.8). The writer's signature covers the clear submitted form; the ledger's countersignature, the `rcpt` digest, the leaf and the tree cover the sealed final payload.
7. **Recovery spool.** The recovery environment writes `keylos.pendingreceipt/1` files (protocols §20.22) as `/var/lib/keylos/recovery/pending/<ULID>.dsse`; the path is registered in protocols §10.7 with the ledger as its only reader.
8. **Service keys.** `ledger.key.register` receipts are never sealed and their `data` is exactly `{service, spki, keyRef}` (protocols §13.4). `Ledger.serviceKey` answers from them; it is how relying services obtain `service/broker` and other service keys (protocols §14.4).
9. **TPM access.** The ledger uses the `/dev/tpmrm0` fd that `warden` passes as `KEYLOS_TPM_FD` (protocols §10.5, E8); development builds may instead honour `KEYLOS_DEV_TPM_TCTI`. After hearth genesis the ledger never uses owner-hierarchy authorization: an absent `0x01300100` is (re-)created only with `HearthTpm.defineSpace(0x01300100)` on `hearth#tpm` (protocols §19.6, E7). The authValue file follows the nv-auth sealed-object format and policy of protocols §19.6 (E7).
10. **Development knobs.** Development-only settings (`KEYLOS_DEV_*` environment variables, protocols §10.5; `x-` members of `/etc/keylos/ledger.json`) are ignored by production builds. Development provisioning of `0x01300100` without `hearth` (§4.7.2) exists only in development builds.

---

## 3. Requirements

### 3.1 Appending

- **REQ-LEDGER-001** `append` MUST be served only on facet `writer`. On any other facet it fails `kl:denied`.
- **REQ-LEDGER-002** The submitted envelope MUST be a DSSE envelope with payload type `application/vnd.keylos.receipt+json; version=1`, a JCS-canonical payload with `schema = "keylos.receipt/1"`, `seq == 0` and `prev == null`, and exactly one signature by the writer's registered key (§4.5).
- **REQ-LEDGER-003** The payload's `writer` MUST equal the connection's peer principal (as delivered by `ServiceHost.accept`), compared ignoring the session component.
- **REQ-LEDGER-004** The payload's `event` MUST be registered in protocols §19.3 for that writer's service name, or be named `x-<repo>.<event>` where `<repo>` is the writer's service name (the extension rule of protocols §19.3). Ledger-originated events are written only by the ledger.
- **REQ-LEDGER-005** The ledger MUST assign `seq = previous seq + 1` (the first receipt is `seq = 1`) and set `prev` to the `rcpt` reference of the previous receipt (`null` for `seq = 1`). It MUST check `time` per §2.3 note 1.
- **REQ-LEDGER-006** `append` MUST return only after the receipt is durable (WAL synced, §4.3) and the tree head updated. Group commit is allowed.
- **REQ-LEDGER-007** Envelopes larger than 256 KiB MUST be rejected with `kl:invalid`.
- **REQ-LEDGER-008** `append` MUST return the final envelope's `ReceiptRef{seq, digest}` where `digest` is SHA-256 of the final envelope bytes (the `rcpt:` reference, protocols §3.2).

### 3.2 Integrity

- **REQ-LEDGER-010** The ledger MUST maintain an RFC 6962 Merkle tree over leaf data (§4.1), stored in C2SP tlog-tiles layout.
- **REQ-LEDGER-011** The ledger MUST sign checkpoints with its signing key in C2SP signed-note format at least every 60 s while new receipts arrived since the last checkpoint, at shutdown, and on `checkpoint()` when the current one is more than 5 s older than the tree head.
- **REQ-LEDGER-012** The NV counter `0x01300100` MUST be incremented at most once per 900 s while there is activity, at clean shutdown, and immediately after the security-class events of §2.3 note 3. Every checkpoint note MUST carry `counter <n>` with the current value.
- **REQ-LEDGER-013** On startup the ledger MUST verify the stored tiles against the newest stored checkpoint, compare the checkpoint's counter with the NV value (§4.7.3), and refuse appends if either check fails, raising an integrity alarm (§7).
- **REQ-LEDGER-014** `prove` and `consistency` MUST return RFC 6962 proofs. `prove(seq, treeSize)` proves leaf index `seq − 1` in the tree of size `treeSize`.

### 3.3 Privacy and retention

- **REQ-LEDGER-020** Leaves, full tiles and full entry bundles MUST never be deleted or rewritten. A partial tile or bundle is replaced by the next wider partial and removed once its full tile is written (C2SP tlog-tiles allows deleting partial tiles).
- **REQ-LEDGER-021** Every receipt whose `subject`'s human is not `_system` or `_cluster` MUST be stored **sealed** exactly as protocols §13.4 defines: the final payload has `"data": null, "label": null` and a `sealed` object `{unit: "ledger:<human>:<YYYY-MM>", alg: "aes-256-gcm", nonce, ct, submitted}`, where `ct` is AES-256-GCM over the JCS bytes of `{"data": …, "label": …}` under the unit key from `Vault.dataKey("ledger:<human>:<YYYY-MM>")` on `vault#ledger`, the month being the receipt `time`'s UTC month, and `submitted` = `sha256:` of the submitted form's JCS bytes. Receipts about `_system`/`_cluster` subjects are stored in clear. Every receipt has a subject principal (protocols §13.1): writers name one, and ledger-originated receipts use the ledger's own principal (human `_system`, so clear).
- **REQ-LEDGER-022** The AEAD additional data for `ct` MUST be the UTF-8 bytes of `sealed.unit`, one `0x00` byte, then the UTF-8 bytes of `sealed.submitted` (protocols §13.4, D12; sealing and unsealing use `keylos-formats`). The ciphertext is thereby bound to its unit and, through `sealed.submitted`, to the submitted form's `subject`, `time`, `event` and `writer`; `seq` and `prev` are bound by the ledger countersignature and the hash chain, not by the AAD. The nonce MUST be 12 random bytes.
- **REQ-LEDGER-023** When a unit key no longer exists (shredded through `LedgerAdmin.shred`, the retention job, or a `vault.forget` triggered by user deletion), `get`, `query` and `watch` MUST return `keylos.receipt-redacted/1` stubs for that unit's receipts; inclusion and consistency proofs MUST keep working, because they cover the sealed payloads.
- **REQ-LEDGER-024** `LedgerAdmin.shred(human, month, presenceEnvelope)` MUST destroy the unit key `ledger:<human>:<month>` through `Vault.forget` and write a `ledger.shred` receipt (`data: {human, month, receipts}` where `receipts` is the number of index rows of that unit; the receipt itself is about `_system` and stays clear). The current month and future months fail `kl:invalid`; a second shred of the same unit fails `kl:invalid`. With a valid presence envelope (purpose `ledger.shred`, protocols §20.2) any month may be shredded; without one (empty `presenceEnvelope`) only months strictly older than the retention for that human may be.
- **REQ-LEDGER-025** A retention job MUST run at 00:10 UTC daily and shred every month strictly older than `retentionMonths` (default 13, minimum 1; per-human overrides allowed) for every human with sealed receipts. Shredding the current or previous month is never automatic.
- **REQ-LEDGER-026** Backups and exports MUST contain the sealed form only, except that `LedgerAdmin.export` on facet `admin` decrypts payloads of the exporting owner's own human only (protocols §13.4; "humans the owner owns" has no other definition in 1.0), writing them into a separate `clear/` part of the bundle that the verifier checks against `sealed.submitted`.

### 3.3a Recovery replay and keys

- **REQ-LEDGER-027** At every start, after the integrity checks, the ledger MUST append every spooled `keylos.pendingreceipt/1` from `/var/lib/keylos/recovery/pending/` whose event is recovery-replayable (protocols §19.3: `key.enroll`, `key.remove`, `presence.assert`, `config.revert`, `config.apply`, `update.rollback`, `user.create`, `recovery.enter`, `recovery.delay`, `recovery.wipe`), in the spool's order, as receipts with `writer = service:ledger:…`, the top-level `onBehalfOf` (protocols §13.4) set to the spooled `onBehalfOf` copied verbatim (a component name such as `config` or `rescue`, protocols §20.22), and `data.onBehalfOf` (the same value), `data.attested` and `data.pendingSeq` (the spooled `seq`) added to the spooled `data`. A file with `attested: true` MUST carry a valid DSSE signature by the owner registry's `recoverySigner` (protocols §20.3, §20.21; the ledger obtains the current `recoverySigner` SPKI with `HearthSystem.owners` on `hearth#system`, see §13.1); a file with `attested: false` MUST be unsigned. A file whose signature is missing, invalid or unexpected is **kept**, never appended, and reported once per file by `ledger.alarm{kind: "spool-signature", file}`. Files with any other event are moved to `rejected/` with `ledger.alarm{kind: "spool-rejected"}`. Each spool file is deleted only after its receipt is durable.
- **REQ-LEDGER-028** The ledger MUST use the machine key the installer created at `/keystore/ledger/signing.sealed` (protocols §10.7) and MUST NOT replace an existing key. It generates a key only if the file is absent **and** the store has no checkpoint (a machine installed by a pre-1.0 path); otherwise an absent key is an integrity alarm.
- **REQ-LEDGER-035** `serviceKey(service)` (facets `reader` and `writer`, protocols §7.3.5) MUST return the SPKI, `keyRef` and registration time of the newest `ledger.key.register` entry of `service/<service>` that has no `until` (the current key), or `kl:not-found`. It answers from the in-memory `writers.dsse` registry, never from callers' claims, and is not subject to the receipt read-access rule (service public keys are not personal data).
- **REQ-LEDGER-036** `ledger.key.register` receipts MUST be stored unsealed regardless of subject and their `data` MUST be exactly `{"service", "spki", "keyRef"}` with `keyRef = key:sha256:<SHA-256 of the SPKI DER>` and `service` equal to the connection's service name; any other shape fails `kl:invalid`.
- **REQ-LEDGER-037** On facet `vouch-heartbeat` (holder `vouchd`) the ledger MUST serve only `query` and `watch`, restricted to `eventTypes = ["user.login"]` and the `Filter` members `since`, `until`, `limit` and `fromSeq` (any other filter, including `principalPrefix` or `sessionId`, fails `kl:denied`), and MUST return for each match a metadata stub `{"schema":"keylos.receipt-meta/1","seq","time","event":"user.login","human"}`; no payload, subject session, writer or signature is returned.
- **REQ-LEDGER-029** Writer keys MUST be registered only for services whose entry in `/etc/keylos/services.json` (`keylos.services/1`, protocols §20.16) has `"writer": true` and whose generation equals the connection's generation (or the `bootstrapGens.ledger`/`journal`/`depot` entry). `warden` has no `services.json` entry; a registration from a `service:warden:…` peer is accepted, because warden is the source of capwire identity (§4.5).

### 3.4 Reading

- **REQ-LEDGER-030** `get`, `query`, `checkpoint`, `prove`, `consistency` and `watch` are served on facets `reader` and `writer`. Visibility follows protocols §7.3.5 exactly (§4.9): a sealed payload is decrypted for a reader only if the reader may read the receipt and the unit key exists.
- **REQ-LEDGER-034** On facet `fleet-export`, only `LedgerAdmin.export` is served. Exported receipts carry metadata only: sealed receipts are exported in their stored sealed form (ciphertext the fleet cannot decrypt, so every signature and proof still verifies) and no `clear/` part is produced, unless a valid owner exception of kind `fleet-receipt-access` (protocols §20.9) from `/etc/keylos/exceptions/*.dsse` lists the event type; then that event's payloads are decrypted into the bundle's `clear/` part.
- **REQ-LEDGER-031** `query` MUST return matching visible receipts with `seq ≥ Filter.fromSeq` in ascending `seq` order, at most `limit`; `next` is the `seq` of the first matching visible receipt not returned (0 = no more). A client continues with the same filter and `fromSeq = next` (protocols §7.3.5, E6). A `limit` of 0 or above 1 000 is treated as 1 000. `watch` ignores `fromSeq`.
- **REQ-LEDGER-032** `watch` MUST deliver every matching visible receipt appended after the call, in order, with back-pressure through Cap'n Proto `stream` flow control. A watcher more than 10 000 receipts behind is canceled: `Watcher` has no error channel, so the ledger stops delivering and drops the watcher capability (the client sees the disconnect and may re-query with `fromSeq`).
- **REQ-LEDGER-033** `checkpoint`, `prove` and `consistency` reveal no receipt content and are available to every reader without filtering.

### 3.5 Witnessing

- **REQ-LEDGER-040** `LedgerWitness.pending(afterTreeSize)` MUST return the newest checkpoint, a consistency proof from `afterTreeSize` (or from the witness's last cosigned size if larger) and that size. The connection's witness is the configured witness whose name's first path component equals the peer's service name (`vouch/…` for `service:vouch`); with exactly one match its last cosigned size is used, otherwise `afterTreeSize` alone.
- **REQ-LEDGER-041** `addCosignature` MUST verify the C2SP tlog-cosignature line against the configured witness keys (§10) and store it with the checkpoint. Lines from unknown keys or with bad signatures fail `kl:integrity`.
- **REQ-LEDGER-042** For any stored checkpoint the ledger MUST serve the note with all collected cosignature lines appended in canonical order: by witness name, then key ID.

### 3.6 Administration and time

- **REQ-LEDGER-050** `LedgerAdmin.export` MUST produce a bundle (§4.10) that `ledger-verify` checks offline: leaves, inclusion and consistency proofs against the included checkpoints, checkpoint signatures, cosignatures, and the ledger and writer signatures of each included body.
- **REQ-LEDGER-051** `LedgerAdmin.resetWriter`, `acknowledgeAlarm` and presence-backed `shred` MUST require a presence envelope with purpose `ledger.reset-writer:<svc>`, `ledger.ack-alarm` or `ledger.shred` (protocols §20.2), verified per §2.3 notes 4 and 5.
- **REQ-LEDGER-053** **Own receipts.** A connection whose peer is a tier-0 writer service MUST see, in `get`, `query` and `watch`, every receipt whose `writer` actor is `service:<its service name>:…` under any session and generation, including receipts written in earlier boots (protocols §7.3.5), with sealed payloads decrypted while the unit key exists. `Filter.principalPrefix = "service:<name>:"` together with `fromSeq` MUST return them in ascending `seq` order, so a writer can reconcile its outstanding submissions (protocols §20.25). This rule adds no visibility of other writers' receipts.
- **REQ-LEDGER-054** **Workflow refs.** When a submitted payload's `data` contains `workflow`, `run`, `step`, `effect`, `decision` or `account` members holding a valid `wf-`, `wr-`, `ws-`, `fx-`, `dr-` or `ba-` ID (protocols §3.5), the ledger MUST copy exactly those members into the final payload's top-level `refs` (protocols §13.4) before sealing, so the IDs stay in clear after the month is shredded. Malformed values are not copied (the receipt is still accepted); no other member is ever copied.
- **REQ-LEDGER-055** **No deduplication; time order is final.** The ledger MUST NOT deduplicate submissions: every accepted submission gets a new `seq`, whatever its content. The `time` refusal of REQ-LEDGER-005 MUST be applied at commit time to every submission in a batch, including submissions whose caller has closed its connection, and a refused submission is never committed later. Writers' receipt outboxes (protocols §20.25) rely on exactly this: once a receipt with time T is committed, no submission with an earlier time can be committed.
- **REQ-LEDGER-056** `loom` MUST be accepted as a writer of the `workflow.*` events of protocols §19.3 under REQ-LEDGER-029 (services.json `writer: true`); their receipts are sealed or clear by subject like every other receipt (`workflow.recover` and `workflow.rollback-detected` name loom itself as subject and stay clear).
- **REQ-LEDGER-057** **Post-fetch forgotten-state check.** A unit key obtained asynchronously from `vault` MUST be re-checked against the shredded/forgotten set after it arrives and before it is cached or used; a key for a unit shredded or forgotten while the fetch was in flight MUST be discarded (zeroized) and the receipt treated per §4.8.3 (redacted). Evicting the ledger's cache cannot retract plaintext already returned to readers; the ledger claims no more.
- **REQ-LEDGER-058** **Audit retention is not replay retention.** Shredding (REQ-LEDGER-024/025) and the retention job MUST NOT consider workflow state, and no workflow MAY depend on a receipt body for replay: workflow history lives in `loom`'s store (protocols §20.25), and the IDs a workflow's recovery or rollback check needs are in clear `refs`.
- **REQ-LEDGER-052** `timeFloor` MUST return the `time` of the newest verified checkpoint, served on facets `admin` and `time` (holders per protocols §19.2).

---

## 4. Design

### 4.1 Leaves

The leaf data for a receipt is the JCS bytes of:

```json
{"schema":"keylos.leaf/1","seq":1042,"rcpt":"rcpt:sha256:<SHA-256 of final envelope bytes>",
 "time":"…","writer":"<writer principal>","subject":"<subject principal>","event":"grant.issue","unit":"<privacy unit>"}
```

- Leaf hash = `SHA-256(0x00 ‖ leafData)`; interior node = `SHA-256(0x01 ‖ left ‖ right)` (RFC 6962).
- The leaf carries the metadata needed for indexing and proofs, never `data` or `label`.
- `unit` is the receipt's `sealed.unit` (`ledger:<human>:<YYYY-MM>`) for sealed receipts and `""` for clear receipts (§4.8).
- Leaf data is stored in plaintext inside the entry bundles. `keylos.leaf/1` is repo-local: only the ledger and `keylos-ledger-verify` parse it.

### 4.2 On-disk layout (`/store/rcpt/`)

```
/store/rcpt/
  tile/<L>/<N>[.p/<W>]               C2SP tlog-tiles hash tiles (height 8)
  tile/entries/<N>[.p/<W>]           entry bundles: leaf data, uint16 big-endian length prefixed, 256 per full bundle
  bodies/<YYYY-MM>/<firstSeq/4096>.seg  final envelopes, personal content sealed (§4.8.2)
  checkpoints/<treeSize>.note        signed checkpoint notes, cosignature lines appended as collected
  checkpoint                         newest checkpoint (atomically replaced with rename)
  index.sqlite                       query index (§4.9)
  writers.dsse                       writer key registry (§4.5), DSSE-signed by the ledger key
  alarms.json                        active and acknowledged integrity alarms
  epochs/<n>/                        read-only tiles and checkpoints of earlier epochs (§7.2)
  wal/                               write-ahead log of pending appends
  reserve                            64 MiB reserve file (§7)
```

`<N>` path encoding follows C2SP tlog-tiles exactly (groups of three digits, `x` prefix except the last, for example `x001/x234/067`). Partial tiles use the `.p/<W>` suffix.

### 4.3 Append path

#### 4.3.1 Validation

For each submitted envelope, in order:
1. Size ≤ 256 KiB; DSSE structure; `payloadType` exact; payload JCS-canonical (recompute and compare bytes).
2. `schema`, `seq == 0`, `prev == null`, `time` within ±5 s of the ledger clock and not earlier than the head's time after the batch is sorted (§2.3 note 1; otherwise `kl:invalid … re-sign`).
3. `writer` equals the connection's peer principal, ignoring the session component (REQ-LEDGER-003).
4. `event` allowed for the writer's service name (REQ-LEDGER-004).
5. Exactly one signature; `keyid` is the writer's current registered key (§4.5); signature verifies over the PAE.
6. `subject` parses as a principal (protocols §3.4); an empty subject is invalid (system events name the writer's own principal).
7. The submitted payload MUST NOT contain `sealed` or `onBehalfOf` (only the ledger sets them).

Failures are rejected individually (`kl:invalid`, `kl:denied` or `kl:integrity`) without affecting the rest of a batch.

#### 4.3.2 Group commit

```
appendQueue ← (envelope, peer, reply)          bounded 4 096; full → kl:unavailable
committer (single task):
  batch := drain up to 512 entries or 2 ms
  sort batch by (time, arrival)                    (§2.3 note 1)
  for each: validate (§4.3.1) → reject individually
            complete payload: seq := head+1, prev := rcpt(previous)
            refs := copy of data.workflow, data.run, data.step, data.effect, data.decision, data.account when present
                    and well-formed IDs (protocols §13.4; REQ-LEDGER-054); never any other data member
            if subject's human ∉ {_system, _cluster}: seal (§4.8.1) → data := null, label := null, sealed := {…}
            sign completed payload (ledger key) → final envelope = {payload, [writerSig (submitted form), ledgerSig]}
                                                 (keylos_formats::receipt::finalize; ledger-originated: [ledgerSig] only)
            rcpt := SHA-256(final envelope bytes); leaf := keylos.leaf/1
  write WAL record (final envelopes + leaves + CRC32C) → fdatasync(wal)
  append leaves to the partial entry bundle; update hash tiles in memory
  write changed tiles (temp file + fdatasync + rename for full and partial tiles) → fsync dir
  append final envelopes to the current body segment (§4.8.2) → fdatasync
  update index.sqlite (one transaction per batch)
  truncate WAL
  reply (seq, rcpt) to each submitter; notify watchers
  if the batch contains a security-class event → schedule an immediate counter increment (§4.7.2)
```

**Crash recovery.** On startup, replay every complete WAL record (length and trailing CRC32C match) not yet reflected in the tiles, then recompute the head. Incomplete records were never acknowledged and are discarded.

### 4.4 Ledger-originated events

| Event | When |
|---|---|
| `ledger.key.register` | A writer key is registered or rotated (written as the writer's own receipt, §4.5); and the ledger's own `{service: "ledger", spki, keyRef}` as the first receipt of an empty ledger and of every epoch, so readers obtain the machine key through `serviceKey("ledger")` |
| `ledger.redact` | A unit key disappeared without a `shred` call (user deletion through `strata`/`vault`, observed on the next decryption attempt or on the `unit.forget` receipt). `data: {human, unit, reason}`, or `{human, reason: "user-forget", units}` once per human on user deletion |
| `ledger.alarm` | An integrity alarm was raised, or acknowledged (new epoch). `data: {alarmId, kind, detail, blocking[, file]}`; a non-blocking acknowledgement `{alarmId, acknowledged: true}`; the first receipt of a new epoch after the ledger's key registration `{previousEpoch, previousHead, previousSize, discrepancy}` |
| `ledger.witness` | A cosignature was accepted |
| `ledger.export` | An export bundle was produced (`data: {filter, facet, bundleDigest, clearHumans[]}`) |
| `ledger.shred` | A unit-month key was destroyed by `LedgerAdmin.shred` or the retention job (`data: {human, month, receipts, by: "owner"|"retention"}`) |

Ledger-originated receipts (protocols §13.1, E4) carry exactly one signature, the ledger's over the final payload, with `writer` and `subject` set to the ledger's own principal; they are never sealed and the submitted-form rule does not apply to them. `keylos_formats` receipt and chain verification accepts them, so `keylos-ledger-verify` needs no separate mode.

### 4.5 Writer keys

Each tier-0 service owns a `service/<name>` Ed25519 key (protocols §5.2). The registry `writers.dsse` maps a service name to a list of `{keyid, alg, publicKey, since, until}`.

**Registration (anchored in capwire identity).**
1. A service with no registered key submits a receipt with `event: "ledger.key.register"`, `data: {"service": "<name>", "spki": "<base64 SPKI DER>", "keyRef": "key:sha256:…"}` (REQ-LEDGER-036), signed by that key. The algorithm is taken from the SPKI (Ed25519 for service keys, protocols §5.2).
2. The ledger accepts it only if the connection's peer principal is `service:<name>:…` and either `<name>` is `warden` (no `services.json` entry; warden is the identity source), or `/etc/keylos/services.json` (`keylos.services/1`) has an entry for `<name>` with `"writer": true` whose `generation` equals the connection's `generation` (from `ServiceHost.accept`), or `<name>` is one of `bootstrapGens` with that generation, and no key is registered for `<name>` (REQ-LEDGER-029).
3. The binding is persisted in `writers.dsse`, signed by the ledger key.

**Rotation.** A registered service rotates by submitting `ledger.key.register` for the new key (same `data` shape) signed by the **old** key; a register receipt for a service that already has a current key is a rotation and is accepted only with the current key's signature. The old entry gets `until`. `serviceKey` returns the new key from the moment the receipt is durable.

**Reset.** A service that lost its key cannot register again on its own. The owner runs `ledger writers reset <name>`, which calls `LedgerAdmin.resetWriter(service, presenceEnvelope)`. After verification (REQ-LEDGER-051) the current entry gets `until = now` and the next `ledger.key.register` from that service is accepted as a first registration.

### 4.6 Ledger signing key and machine identity

- **Key.** An Ed25519 keypair created by the **installer** (protocols §10.7) as a TPM-sealed seed `/keystore/ledger/signing.sealed` under the SRK `0x81000001` with policy `PolicyAuthorize(release-stream PCR11 key, phase "ready") ∧ PolicyPCR(15)`. At first start the ledger unseals it, derives the public key and checks that `key:sha256:<SPKI digest>` equals `machine.machineKey` in the first-boot bundle (protocols §20.13); a mismatch is an integrity alarm. The ledger never generates a key while that file exists (REQ-LEDGER-028).
- **Use.** Unsealed at start and kept in `memfd_secret` memory.
- **Identity.** `key:sha256:<SPKI DER digest>` is the **machine key** (protocols §3.5). The checkpoint origin is `keylos-ledger/<that digest's hex>`; the C2SP note key name is the origin, and the note key ID uses the C2SP Ed25519 derivation (algorithm byte `0x01`).
- **It signs:** the ledger countersignature on every receipt (`alg: "ed25519"`), checkpoint notes, `writers.dsse`, redacted stubs, and export manifests.

### 4.7 Checkpoints and the NV counter

#### 4.7.1 Checkpoint note

```
keylos-ledger/3f9ac0e1…
1042
<base64 root hash>
counter 57
time 2026-10-07T21:30:00Z
boot s-01JB5…
epoch 0

— keylos-ledger/3f9ac0e1… <base64 signature>
```

| Line | Meaning |
|---|---|
| `counter <n>` | The NV counter value at or before this checkpoint (protocols §13.3) |
| `time` | Ledger clock at signing; the time floor |
| `boot` | `warden`'s boot session ID (the writer session of the newest `boot` receipt); omitted until the first `boot` receipt exists |
| `epoch` | Epoch number (§7.2); 0 unless an alarm was acknowledged |

#### 4.7.2 Counter increments

The NV index `0x01300100` is created by `installer` with the registry template of protocols §19.6 (counter; common attributes including the public `NV_Read` policy branch; `AUTHWRITE`). Its authValue is held as the sealed blob `/var/lib/keylos/tpm/nv-auth/0x01300100.sealed` (protocols §10.7), bound to PCR11 phase `ready` and PCR15. `warden` extends PCR11 `ready` immediately before starting the first tier-0 service (protocols §19.6), so the ledger can unseal it and nothing launched earlier can. After a TPM clear the ledger re-creates the index with `HearthTpm.defineSpace(0x01300100)` on `hearth#tpm` during alarm acknowledgement (§7.2); `hearth` writes the new sealed authValue file. Once hearth genesis has set the owner-hierarchy authorization, `HearthTpm.defineSpace` is the only way the ledger obtains the index (protocols §19.6, E7); the ledger never defines NV with owner authorization.

**Development provisioning** (development builds only, enabled by a `KEYLOS_DEV_*` knob and only for swtpm/soft TPMs): on a fresh store with the index absent and no `hearth#tpm` route, the ledger may define `0x01300100` with the registry template, seal a fresh authValue in the nv-auth format under the SRK `0x81000001` with the development fallback policy (protocols §19.6) and increment once. Production builds have no such path.

The counter is incremented:
- at most once per `counterIntervalSecs` (default and maximum 900 s) while receipts have arrived since the last increment;
- at clean shutdown: publish the final checkpoint, increment, then publish one more checkpoint carrying the new value (so a ledger restarted on its own, without a `shutdown` receipt, passes §4.7.3);
- immediately after any receipt of a security-class event (§2.3 note 3), before the next checkpoint is published.

Algorithm:

```
increment():
  TPM2_NV_Increment(0x01300100, auth = counterAuth)     # 2 tries, then alarm on failure
  n := TPM2_NV_Read(0x01300100)
  publish checkpoint with "counter n"
```

**Endurance.** With 10 security events and 96 interval increments per day the worst case is about 106 increments per day, or 39 000 per year. The ledger exposes the counter as a metric and warns when the projected count exceeds 50 % of a conservative 300 000 lifetime budget, then doubles `counterIntervalSecs` for the projection window (security events still increment immediately).

#### 4.7.3 Startup checks

1. Read the newest checkpoint and verify its signature with the ledger key.
2. Recompute the root from the tiles up to `treeSize` and compare. The newest 16 full tiles and all partial tiles are verified before accepting appends; older full tiles are verified in the background at ≤ 5 % CPU, and a mismatch there raises an alarm.
3. Read the NV counter value `v`:

| Condition | Meaning | Action |
|---|---|---|
| `note.counter == v` | Normal | Start |
| `note.counter == v − 1` and the last receipt is `shutdown` | Normal: incremented after the final checkpoint | Start; publish a new checkpoint |
| `note.counter < v`, other cases | Rollback or loss of the newest checkpoint | Integrity alarm |
| `note.counter > v` | NV index replaced (TPM cleared or index re-created) | Integrity alarm |
| NV index absent | TPM cleared | Integrity alarm |

#### 4.7.4 Time floor

`timeFloor()` returns the newest verified checkpoint's `time`. `net` uses it to step the clock forward at boot (protocols §3.6). The ledger itself never signs a checkpoint with a `time` earlier than the previous checkpoint's.

### 4.8 Sealed receipts and body storage

#### 4.8.1 Sealing

```
seal(payload, submittedForm):                      (in the committer, after seq/prev are assigned)
  h     := human of payload.subject
  h ∈ {_system, _cluster} → return payload unchanged
  unit  := "ledger:" + h + ":" + utcMonth(payload.time)        e.g. ledger:alice:2026-10
  key   := monthKeys[unit] ?? Vault.dataKey(unit) on vault#ledger      (cached in memfd_secret memory)
  pt    := JCS({"data": payload.data, "label": payload.label})
  submitted := "sha256:" + SHA-256(JCS(submittedForm))
  aad   := utf8(unit) ‖ 0x00 ‖ utf8(submitted)      (REQ-LEDGER-022, protocols §13.4)
  final := payload with data := null, label := null,
           sealed := {unit, alg: "aes-256-gcm", nonce: random 12 bytes, ct: base64(AES-256-GCM(key, nonce, pt, aad)), submitted}
  return final
```

- **Fetch fencing.** Every asynchronous `Vault.dataKey` call carries the unit's shred generation as read before the call; when the key arrives the ledger re-checks `units.json` and the in-memory shred set and discards the key, without caching or using it, if the unit was shredded or seen forgotten meanwhile (REQ-LEDGER-057).
- **Key cache.** Keys for the current and previous month of every human seen in the last 24 h are cached in `memfd_secret` memory and stored in `warden`'s `FdStore` (`monthkeys`) so a ledger restart within the boot does not need `vault`. Keys are evicted from the cache when their unit is shredded.
- **`vault` unavailable.** If a needed unit key is not cached and `vault` does not answer within 30 s, the receipt is not completed: the append fails `kl:unavailable` and the writer retries (writers fail closed). The committer continues with the rest of the batch. Because `vault` is itself a writer, `vault` MUST serve `dataKey` on `vault#ledger` concurrently with its own pending appends (vault spec); the ledger asks for the keys of the current month of every human with an unlocked session at startup to warm the cache.
- **Locked humans.** `vault` serves `ledger:` unit keys under its system key even while the human is locked (vault spec), so receipts about locked humans can always be sealed.

#### 4.8.2 Segment format

Final envelopes (sealed or clear) are stored append-only in `bodies/<YYYY-MM>/<firstSeq/4096>.seg`:

```
record := u64 seq ‖ u32 len ‖ envelope bytes(len) ‖ u32 crc32c(seq ‖ len ‖ bytes)      (integers big-endian)
```

A segment index (`<seg>.idx`, big-endian `u64 seq → u64 offset`, rebuilt from the segment if missing) gives O(1) lookup. Segments need no further encryption: personal content inside them is already sealed, and the clear metadata is what protocols §13.4 keeps in clear. Bodies are bound to leaves through the `rcpt` digest in the leaf (SHA-256 of the envelope bytes).

#### 4.8.3 Reading sealed receipts

```
open(envelope, reader):
  visible(reader, receipt) per §4.9, else not-found
  receipt not sealed → return envelope
  key := monthKeys[sealed.unit] ?? Vault.dataKey(sealed.unit)
  unit recorded as shredded/forgotten in units.json → redacted stub; dataKey is never called for it again
  key gone (kl:revoked or kl:not-found from vault; both mean "key gone") → record the unit in units.json, return
      redacted stub (§4.8.5); write ledger.redact once per unit if no ledger.shred exists for it
  pt := AES-256-GCM-open(key, nonce, ct, aad = unit ‖ 0x00 ‖ submitted)   (failure → integrity alarm)
  return envelope with an added top-level member "clear": {data, label}      (§4.8.4)
```

Because `vault` may re-create a unit key 30 days after a forget, the ledger keeps the set of units it shredded or saw forgotten in `/store/rcpt/units.json` and never asks `vault` for them again, so a re-created key is never mistaken for the original (which would raise a false AEAD alarm). The stored final envelope is serialized as JCS by the ledger. For a decrypted sealed receipt, `get`, `query` and `watch` return that envelope with one extra top-level member `"clear": {"data": …, "label": …}`, re-serialized as JCS (§4.8.4). DSSE parsers that ignore unknown members parse it unchanged. A verifier reconstructs the submitted form from the final payload by setting `seq` to 0, `prev` to null, `data`/`label` to the decrypted values and removing `sealed`; it then checks `sealed.submitted` and the writer's signature.

#### 4.8.4 Returned form and verification by readers

- The `rcpt` digest is SHA-256 of the stored envelope bytes. A reader that received a `clear` member removes it, re-serializes with JCS (which reproduces the stored bytes exactly, because the stored envelope is JCS) and hashes.
- `ledger.query` callers that do not decrypt (fleet metadata exports, witnesses) never receive `clear`.
- `keylos-ledger-verify` implements both steps and the submitted-form reconstruction.

#### 4.8.5 Redaction

When a unit key no longer exists, `get` and `query` return a redacted stub signed by the ledger, with payload type `application/vnd.keylos.receipt+json; version=1` and schema `keylos.receipt-redacted/1` (protocols §19.4):

```json
{"schema":"keylos.receipt-redacted/1","seq":1042,"rcpt":"rcpt:sha256:…","leaf":{…leaf data…},
 "unit":"ledger:alice:2025-08","redactedAt":"…","reason":"retention|owner-shred|user-forget"}
```

The stored final envelope (with its now undecryptable `ct`) stays on disk, so the `rcpt` digest, the ledger countersignature and every proof still verify; only the content is gone.

#### 4.8.6 Triggers

| Trigger | Action |
|---|---|
| `LedgerAdmin.shred(human, month, presence)` | Verify presence (or retention eligibility, REQ-LEDGER-024); `Vault.forget(ledger:<human>:<month>)`; evict the cached key; write `ledger.shred{by: "owner"}` |
| Retention job (REQ-LEDGER-025) | For each human and each month older than the retention: as above with `by: "retention"` |
| `hearth` deletes a user with `forgetData` | `vault` destroys the user's units (vault spec); the ledger observes the `unit.forget`/`user.delete` receipts, evicts cached keys of `ledger:<user>:*` and writes `ledger.redact{human, reason: "user-forget"}` once |

### 4.9 Query index and read access

`index.sqlite` (WAL mode):

```sql
CREATE TABLE r (seq INTEGER PRIMARY KEY, time INTEGER NOT NULL, writer TEXT NOT NULL, subject TEXT NOT NULL,
                event TEXT NOT NULL, unit TEXT NOT NULL, human TEXT NOT NULL, writer_svc TEXT NOT NULL);
CREATE TABLE s (seq INTEGER NOT NULL, session TEXT NOT NULL);   -- every session in subject's and writer's chain
CREATE INDEX r_time ON r(time);
CREATE INDEX r_subject ON r(subject);
CREATE INDEX r_event_time ON r(event, time);
CREATE INDEX r_human_time ON r(human, time);
CREATE INDEX s_session ON s(session, seq);
```

**Filter semantics:**

| Field | Matching |
|---|---|
| `principalPrefix` | Byte prefix on `subject` or `writer` |
| `sessionId` | Any session in the subject's or writer's chain |
| `eventTypes` | Exact names, or a trailing `.*` wildcard (`grant.*`) |
| `since`, `until` | Inclusive and exclusive bounds on receipt `time` |
| `fromSeq` | Only receipts with `seq ≥ fromSeq` (0 = no bound); pagination per REQ-LEDGER-031 |

**Read access (protocols §7.3.5).** For a reader `R` (principal of the connection):

| Reader | Sees bodies of receipts where |
|---|---|
| Agent principal | `subject` or `writer` session chain begins with R's session chain (its own session and descendants) |
| App, legacy, bench principal | `subject` or `writer` is R or a descendant session |
| `shell` principal of human h | `subject`'s human is h, or (subject empty and) `writer`'s human is h |
| Tier-0 writer service (own receipts) | `writer`'s actor is the same service name, `service:<name>:…`, under any session and generation, including earlier boots (protocols §7.3.5): the writer can always find and reconcile its own submissions (REQ-LEDGER-053) |
| Tier-0 service | Its facet entry in protocols §19.2: `writer`/`reader` services see the receipts they wrote (the ledger cannot know which sessions a service serves, so "receipts whose subject is a session they serve" is not used); `vouch` sees no bodies; on facet `vouch-heartbeat` it receives `user.login` metadata stubs only (REQ-LEDGER-037) |
| `fleet` on facet `fleet-export` | Metadata of every receipt through `LedgerAdmin.export` only; sealed payloads only for event types listed by a valid `fleet-receipt-access` owner exception (REQ-LEDGER-034) |
| Owner `shell` on facet `admin` | Everything, through `LedgerAdmin.export`; payloads decrypted for the humans the owner owns (REQ-LEDGER-026) |

**Decryption rule.** A sealed payload is decrypted for a reader only if the receipt is visible to that reader by the table above **and** the unit key exists (protocols §7.3.5). Visibility without the key yields the redacted stub; the key without visibility yields nothing.

**Exceptions.** The ledger reads `/etc/keylos/exceptions/*.dsse` at startup and on `ServiceHost.reload`, verifies each envelope's presence signature against the owner registry (fetched with `HearthSystem.owners` on `hearth#system` and cached in `/var/lib/keylos/ledger/owners.json` for starts before hearth answers; the registry is re-fetched on reload; owner-presence keys of the boot trust set per §2.3 note 4), and keeps the `fleet-receipt-access` ones whose `expires` is null or in the future.

Receipts not visible to the reader are omitted from `query` and `watch`, and `get` fails `kl:not-found` for them. Receipts whose unit-month key was forgotten are returned as redacted stubs (§4.8.5).

### 4.10 Export bundle

`LedgerAdmin.export(filterJson, out)` writes a `.klx` file to the passed fd: a zstd-compressed tar containing

```
manifest.json           DSSE (ledger key) of {schema:"keylos.ledger-export/1", origin, from, to, filter, checkpoints:[…], created}
checkpoints/*.note      every checkpoint covering the range, with cosignatures
entries.bin             leaf data for the range (C2SP entry-bundle encoding)
proofs/<treeSize>.json  inclusion proofs for every included leaf and consistency proofs between consecutive checkpoints
bodies.jsonl            final envelopes (or redacted stubs) for the range, base64 per line
writers.dsse            writer key registry
```

Additions for sealed receipts:

```
clear/<seq>.json        {"seq", "data", "label"} for sealed receipts the exporter may decrypt (REQ-LEDGER-026, -034)
```

`ledger-verify` checks each `clear/` file against the receipt's `sealed.submitted` digest (it rebuilds the submitted form) and the writer's signature. On facet `fleet-export` the bundle contains `clear/` files only for events covered by a `fleet-receipt-access` exception; every other sealed receipt stays sealed in `bodies.jsonl`.

`filterJson` is `{"from": seq|time, "to": seq|time, "human": "<name>"|null, "events": [...]}`. `ledger-verify <bundle> [--origin-key <keyid>] [--witness <name>=<vkey>]…` checks everything in REQ-LEDGER-050 and exits 0 on success. A `ledger.export` receipt records the filter and the bundle digest.


### 4.11 Recovery replay

```
startup, after §4.7.3 checks and WAL replay, once hearth#system is reachable (retried every 10 s; replay never blocks appends):
  signer := recoverySigner of the newest genesis/recover entry from HearthSystem.owners()
  for file in sort(/var/lib/keylos/recovery/pending/*.dsse) by (ULID):
    p := parse keylos.pendingreceipt/1 (unparsable → move to rejected/, ledger.alarm{kind: spool-rejected})
    p.event ∉ recovery-replayable set (protocols §19.3) → move to rejected/, ledger.alarm{kind: spool-rejected}
    p.attested = true  → verify DSSE signature by the registry's recoverySigner; invalid/missing → keep file,
                         ledger.alarm{kind: spool-signature} (once per file), continue
    p.attested = false → the envelope MUST carry no signature; otherwise keep file + spool-signature alarm
    payload := {schema: keylos.receipt/1, time: max(p.time, head time), writer: ledger's principal,
                subject: p.subject, event: p.event, label: p.label, onBehalfOf: p.onBehalfOf (top level, verbatim),
                data: p.data ∪ {onBehalfOf: p.onBehalfOf, attested: p.attested, pendingSeq: p.seq}}
    append through the normal committer (sealing applies; ledger-only signature; §4.4 rule)
    after durable: unlink file
```

The presence envelopes the recovery environment collected (for `key.enroll`, `config.revert`, …) are carried inside `p.data` and verified by the services that act on them, not by the ledger; the ledger records them.

### 4.12 Retention job

A timer task runs daily at 00:10 UTC (and once at startup if the previous run is more than 25 h old):

```
for human in humans with sealed receipts (index: SELECT DISTINCT human FROM r WHERE unit != ''):
  keep := retentionOverrides[human] ?? retentionMonths            (minimum 1)
  for month in months of that human's units strictly older than (currentMonth − keep):
    if no ledger.shred receipt exists for (human, month): shred(human, month, by = "retention")
```

`currentMonth` is taken from trusted time; before the first NTS sync the job is deferred, so a clock set into the future cannot shred early. No protocols interface yet tells the ledger that time is NTS-trusted (§13.1): until one exists the job runs only in development builds (knob) or when the owner runs `ledger retention --run` with presence; presence-less shreds are refused while time is untrusted.

---

## 5. Interfaces

### 5.1 `Ledger`

Implemented exactly as embedded in §2.2.3. Facets: `writer` (all methods), `reader` (all except `append`; `serviceKey` per REQ-LEDGER-035), `vouch-heartbeat` (`query` and `watch` restricted per REQ-LEDGER-037). Returned envelopes of decrypted sealed receipts carry the extra top-level `clear` member (§4.8.4); redacted receipts are returned as `keylos.receipt-redacted/1` stubs (§4.8.5).

### 5.2 `LedgerWitness`, `LedgerAdmin`

Implemented exactly as embedded in §2.2.3 (protocols §7.5.5).

| Facet | Interfaces |
|---|---|
| `witness` | `LedgerWitness` |
| `admin` | `LedgerAdmin` (all methods) |
| `time` | `LedgerAdmin.timeFloor` only (holders net, warden, depot); other methods fail `kl:denied` |
| `fleet-export` | `LedgerAdmin.export` only, metadata form (REQ-LEDGER-034); other methods fail `kl:denied` |

`LedgerAdmin.shred(human, month, presenceEnvelope)`: REQ-LEDGER-024. `month` MUST match `^[0-9]{4}-(0[1-9]|1[0-2])$`; the current month cannot be shredded (`kl:invalid`), because receipts are still being sealed into it. Returns the number of sealed receipts in the unit.

`LedgerAdmin.status()` returns JSON: `{"treeSize", "head", "counter", "nvProjectedLifetimeFraction", "epoch", "alarms": [...], "witnesses": [{"name", "lastCosignedSize", "ageSecs"}], "writers": [{"service", "keyid", "since"}]}`.

### 5.3 Repo-local interface (`ledger` CLI only)

File ID `0xa41c7e93d5b20f11`, obtained with `Extensible.ext` on `reader` and `admin` routes:

```capnp
@0xa41c7e93d5b20f11;
using C = import "common.capnp";

interface LedgerCli {
  timeline    @0 (session :Text) -> (json :Text);                 # every visible receipt of the session and its descendants (sessionId filter), decrypted where visible
  verifyLocal @1 (full :Bool) -> (ok :Bool, problems :List(Text));  # admin only
  witnesses   @2 () -> (json :Text);
}
```

### 5.4 CLI: `ledger`

| Command | Description | Exit |
|---|---|---|
| `ledger tail [-f] [--session S] [--event E] [--principal P]` | Latest visible receipts (records: seq, time, event, subject, summary); optionally follow | 0, 2 |
| `ledger show <seq|rcpt:…>` | Full receipt with both signatures verified and an inclusion proof against the newest checkpoint | 0, 1 not found, 3 verify failed |
| `ledger query [--since T] [--until T] [--event E]… [--principal P] [--session S] [--limit N]` | Query | 0 |
| `ledger why <session>` | Timeline of a session and its descendants | 0 |
| `ledger checkpoint [--cosigned]` | Newest checkpoint note | 0 |
| `ledger verify [--full]` | Re-verify tiles against the checkpoint and NV counter; `--full` also decrypts and verifies every visible body | 0 ok, 3 integrity failure |
| `ledger export --from X --to Y [--human U] [--event E]… --out FILE` | §4.10 (owner, admin facet) | 0, 2 |
| `ledger witnesses` | Witnesses and last cosigned size per witness | 0 |
| `ledger writers [reset <svc>]` | List writer keys, or reset one (presence) | 0, 3 |
| `ledger alarm ack <id>` | Acknowledge an integrity alarm (presence) | 0, 3 |
| `ledger retention --run` | Run the retention job now (presence; needed while no trusted-time signal exists, §4.12) | 0, 3 |
| `ledger status` | Head, counter, alarms, NV wear projection, retention, oldest unshredded month per human | 0, 4 if an alarm is active |
| `ledger shred --human U --month YYYY-MM` | Crypto-shred one month of a human's receipts (presence) | 0, 3 |
| `ledger retention` | Effective retention per human and the next scheduled shreds | 0 |

Each command ships a `keylos.cmdsig/1`; records are emitted as CBOR sequences when the shell negotiates `cbor-seq`.

### 5.5 Files

- `/store/rcpt` mode `0700`, owned by the ledger's service UID (layout §4.2).
- `/keystore/ledger/` mode `0700`: `signing.sealed` (created by the installer, REQ-LEDGER-028).
- `/var/lib/keylos/tpm/nv-auth/0x01300100.sealed` (read-only for the ledger; protocols §10.7).
- `/var/lib/keylos/recovery/pending/` (read and unlink, §4.11), `rejected/` beside it.
- `/etc/keylos/exceptions/*.dsse`, `/etc/keylos/services.json` and `/etc/keylos/ledger.json` (the `ledger` record of §10, or `{"ledger": …}`; read-only; values outside the maxima/minima are clamped with a warning).
- `/var/lib/keylos/ledger/owners.json` (cached owner registry, §4.9) and `/store/rcpt/units.json` (shredded/forgotten units, §4.8.3).

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| A forged receipt from a non-writer | `writer` facet only; peer principal must equal `writer`; registered writer key required |
| A writer impersonating another writer | `writer` must match the peer; keys are bound per service name |
| Offline truncation or rollback of the log | NV counter binding and startup check (§4.7.3) |
| Offline modification of tiles or bodies | Tiles verified against the signed checkpoint; bodies AEAD-bound to their leaves |
| Runtime root tampering | Can append forged receipts while compromised; cannot rewrite history without breaking consistency with checkpoints already cosigned by witnesses |
| Privacy leak through receipts | Payloads about humans sealed per human and month (protocols §13.4); read-access rule; retention shredding; fleet sees ciphertext unless an owner exception allows |
| Replay of forged recovery receipts by writing to the spool | The spool directory is writable only by the recovery environment and the ledger (Landlock); only recovery-replayable events are accepted; every replayed receipt carries `onBehalfOf` and is attributed to `service:ledger`, so it is never mistaken for an original writer's signature |
| Log flooding | Per-writer rate limit (2 000 burst, 200/s sustained); queue bound returns `kl:unavailable`; writers aggregate (the broker's path-open summaries) |
| Counter wear-out attack (a writer spams security-class events) | Security-class events come only from tier-0 services; increments for them are additionally limited to 1 per second (bursts coalesce into one increment before the next checkpoint) |

### 6.2 Residual risks

- **No external witness configured.** A compromised running system can produce an alternative history from the point of compromise; detection across reboot then relies only on the counter. The installer configures the `vouch` witness by default when a phone is paired.
- **Shredding removes content, not the event.** The fact that an event of type X happened at time T for human U remains. That is the price of verifiability.
- **Writer attribution after shredding** rests on the ledger countersignature and `sealed.submitted` only, because the writer's signature covers the clear form (protocols §13.4).

### 6.3 Confinement of `ledgerd`

| Property | Value |
|---|---|
| Tier | t0 |
| Namespaces | mount, pid, ipc, uts, cgroup, net (`lo` only) |
| Mount view | Ledger generation at `/`; `/etc/keylos/services.json`, `/etc/keylos/exceptions` (ro); `/store/rcpt` (rw); `/keystore/ledger` (rw); `/var/lib/keylos/tpm/nv-auth/0x01300100.sealed` (ro); `/var/lib/keylos/recovery/pending` (rw); `/var/lib/keylos/firstboot/bundle.json` (ro, first start only); `/run/keylos/boot` (ro); `/proc` subset |
| Landlock | rw on `/store/rcpt`, `/keystore/ledger` and the recovery spool; nothing else writable |
| Capabilities | None |
| Devices | `/dev/tpmrm0` fd passed by `warden` |
| seccomp additions | `memfd_secret`, `mlock`, `fdatasync` |
| Routes held | `vault#ledger`, `hearth#presence`, `hearth#tpm` |

---

## 7. Failure modes and recovery

### 7.1 Table

| Failure | Behaviour |
|---|---|
| Disk full | Appends fail `kl:unavailable`; all writers fail closed; `atrium` shows a critical notification (writers report it). The ledger deletes `reserve` first so that `ledger.alarm` and recovery receipts can still be written |
| Corrupted partial tile or WAL (crash) | WAL replay; incomplete records discarded |
| Tile or checkpoint mismatch at startup | Integrity alarm (§7.2) |
| NV counter missing or mismatched | Integrity alarm (§7.2) |
| `vault` unavailable | Receipts needing an uncached unit key fail `kl:unavailable` after 30 s (§4.8.1); clear receipts (`_system`, `_cluster`) and receipts whose month key is cached continue. Re-sealing later is impossible by design (the final payload is chained and countersigned), so there is no deferred encryption |
| Spool file malformed or not replayable | Moved to `rejected/`; `ledger.alarm{kind: spool-rejected}`; appends continue |
| Installer-created signing key missing on a machine that has checkpoints | Integrity alarm (REQ-LEDGER-028) |
| Witness unreachable | No effect on appends; `ledger status` shows the age of the last cosignature; required witnesses past `maxAgeSecs` raise a warning |
| TPM transient failure on increment | Retry once after 100 ms; then raise an alarm but keep accepting appends (the next successful increment resolves it); security-class receipts are still acknowledged |

### 7.2 Integrity alarm and epochs

On an alarm:
1. Appends are refused (`kl:integrity`) except ledger-originated `ledger.alarm`. While a blocking alarm is active no checkpoint is published and the counter is not incremented (otherwise a rolled-back store would get a fresh checkpoint with the current counter and the alarm would vanish once `alarms.json` is removed); alarms also persist in `alarms.json`.
2. `broker` therefore refuses all grants (it fails closed without the ledger), and the machine runs in **safe mode**: `warden` keeps the human's shell, `atrium` and recovery tools running.
3. The owner inspects `ledger status` and either restores `/store/rcpt` from a backup whose newest checkpoint counter equals the NV value (`strata` restore of the `@store` snapshot set; the alarm clears on the next start), or acknowledges the alarm with presence (`acknowledgeAlarm`).

Acknowledging starts a **new epoch**:
- the current tiles, entry bundles, checkpoints, `bodies/`, `index.sqlite*` and `wal/` move to `epochs/<n>/` read-only (`writers.dsse`, `alarms.json` and private state stay);
- a new tree starts at `seq = 1` with `epoch n+1` in its checkpoints; its first receipt is the ledger's own `ledger.key.register` (§4.4), its second `ledger.alarm` with `data: {"previousEpoch": n, "previousHead": …, "previousSize": …, "discrepancy": …}`;
- if the NV index was missing (TPM cleared), the ledger re-creates it during acknowledgement with `HearthTpm.defineSpace(0x01300100)` on `hearth#tpm` (protocols §7.5.3; `hearth` writes the new sealed authValue file), then increments it once and binds the new epoch to its value.

Exports covering an epoch boundary include both epochs and the `ledger.alarm` receipt that links them.

---

## 8. Performance budgets

| Metric | Budget |
|---|---|
| `append` latency p50 / p99 (group commit, NVMe) | ≤ 1.5 ms / ≤ 6 ms |
| Sustained append throughput | ≥ 20 000 receipts/s |
| `get` p99 | ≤ 1 ms |
| `query` over 1 M receipts (indexed filter, 100 results) | ≤ 20 ms |
| `prove` | ≤ 1 ms |
| Storage per receipt (leaf + tiles + body, typical 600-byte envelope) | ≤ 900 bytes |
| Startup verification with 10 M receipts | ≤ 3 s before accepting appends |
| Counter increment (TPM) | ≤ 50 ms, off the append path |
| Sealing overhead per receipt (cached key) | ≤ 20 µs |
| `dataKey` fetch from `vault` on a cache miss | ≤ 5 ms p99 |
| RSS | ≤ 64 MiB |

---

## 9. Observability

- **Receipts:** `ledger.key.register`, `ledger.redact`, `ledger.alarm`, `ledger.witness`, `ledger.export`, `ledger.shred` (§4.4); replayed recovery receipts with `onBehalfOf` (§4.11).
- **Metrics** (records `0x1F`): `ledger_tree_size`, `ledger_append_seconds`, `ledger_queue_depth`, `ledger_nv_counter`, `ledger_nv_projected_lifetime_fraction`, `ledger_last_cosignature_age_seconds{witness}`, `ledger_alarms_active`, `ledger_redacted_units_total`, `ledger_sealed_receipts_total`, `ledger_shredded_units_total{by}`, `ledger_seal_key_wait_seconds`, `ledger_recovery_replayed_total`.
- **Logs:** writer registration and rotation (level 5); alarms (level 2); redactions (level 5).

---

## 10. Configuration

```nickel
{
  ledger | {
    checkpointIntervalSecs | Number | default = 60,      # max 60 (protocols §13.3)
    counterIntervalSecs    | Number | default = 900,     # max 900 (protocols §13.3)
    retentionMonths        | Number | default = 13,          # payload keys older than this are shredded (protocols §13.4); minimum 1
    retentionOverrides     | { _ : Number } | default = {},   # per human; minimum 1
    witnesses | Array {
      name       | String,            # C2SP witness name, e.g. "vouch/alice-phone"
      key        | String,            # C2SP vkey
      required   | Bool | default = false,
      maxAgeSecs | Number | default = 86400,
    } | default = [],
    rateLimit | { burst | Number | default = 2000, sustained | Number | default = 200 },
  }
}
```

Values above the protocols maxima are rejected by the config schema.

---

## 11. Testing and acceptance criteria

### 11.1 Unit tests

- RFC 6962 hashing and proofs against the Go `sumdb/tlog` reference vectors; C2SP tile path encoding.
- Signed-note encoding and Ed25519 note key ID derivation (C2SP vectors); cosignature line parsing.
- Submitted-form reconstruction (§2.3 note 1) round-trip, including `time` handling.
- Segment record encode/decode; `rcpt` binding of bodies to leaves.
- Sealing: AES-256-GCM with the AAD rule of REQ-LEDGER-022 against `vectors/receipts-sealed` (changing `unit` or `sealed.submitted` makes decryption fail; `seq`/`prev` changes are caught by the countersignature and chain); `sealed.submitted` digest; `clear` member strip-and-rehash round trip.
- Retention month arithmetic (overrides, minimum 1, no shredding before trusted time); recovery-replayable event filter.
- Read-access rule for each reader class (§4.9).
- Event authorization per writer service against the protocols §19.3 table and the extension rule.

### 11.2 Integration tests

| ID | Scenario | Expected |
|---|---|---|
| IT-01 | 100 000 appends from 8 writers concurrently | Strictly increasing `seq`; `time` non-decreasing in `seq`; `prev` chain valid; root equals a recomputation; submissions older than the head fail `kl:invalid … re-sign` and succeed after re-signing |
| IT-02 | `kill -9` during group commit, restart | No acknowledged receipt lost; no gap; tiles consistent |
| IT-03 | Restore `/store/rcpt` from a 1-hour-old btrfs snapshot | Startup alarm (counter mismatch) |
| IT-04 | Flip one byte in a full tile | Alarm (startup or background verification) |
| IT-05 | `append` on facet `reader` | `kl:denied` |
| IT-06 | Payload `writer` differs from the peer | `kl:denied` |
| IT-07 | Forget `ledger:alice:2026-10` | `get` returns a redacted stub; `prove` verifies; `ledger.redact` present |
| IT-08 | Export a range and verify on macOS with `ledger-verify` | Exit 0; tampering any file → non-zero |
| IT-09 | Cosignature with a wrong key | `kl:integrity` |
| IT-10 | `vault` stopped for 10 min during appends | Appends succeed; bodies re-encrypted after recovery |
| IT-11 | `config.apply` receipt appended | NV counter incremented before the next checkpoint; note carries the new value |
| IT-12 | Agent reader queries another session's receipts | Not returned |
| IT-13 | Event `x-gate.foo` submitted by `strata` | `kl:denied` (extension rule) |
| IT-14 | Alarm acknowledged with presence | New epoch; first receipt `ledger.alarm`; export across the boundary verifies |
| IT-15 | `timeFloor` on facet `time` from `net`; `export` on facet `time` | First succeeds; second `kl:denied` |
| IT-16 | Receipt about `alice` appended | Stored payload has `data: null`, `label: null`, `sealed.unit == "ledger:alice:<month>"`; a `shell` of alice gets `clear` with the original data; stripping `clear` and re-JCS reproduces the `rcpt` digest; writer signature verifies over the reconstructed submitted form |
| IT-17 | Receipt about `_system` | Stored in clear; no `sealed` |
| IT-18 | `shred alice 2026-09` with presence | `Vault.forget` called; subsequent `get` returns `keylos.receipt-redacted/1`; `prove` and `consistency` still verify; `ledger.shred{by: owner}` written |
| IT-19 | `shred` without presence of a month younger than retention | `kl:denied`; of the current month with presence → `kl:invalid` |
| IT-20 | Clock advanced 14 months, NTS trusted | Retention job shreds months older than 13; `ledger.shred{by: retention}` per month |
| IT-21 | `fleet-export` without exceptions | Bundle verifies; no `clear/`; sealed receipts present only as ciphertext |
| IT-22 | `fleet-export` with a `fleet-receipt-access` exception for `effect.commit` | `clear/` contains exactly the `effect.commit` payloads |
| IT-23 | Spool contains `config.revert` and `grant.issue` | `config.revert` appended with `writer` = ledger and top-level `onBehalfOf: "config"` (also in `data`); `grant.issue` rejected with `ledger.alarm{spool-rejected}` |
| IT-24 | First start with installer-created `signing.sealed` | Key reused; machine key matches the first-boot bundle; no new key generated |
| IT-25 | `ledger.key.register` from a service whose `services.json` entry has `writer: false` | `kl:denied` |
| IT-26 | `vault` stopped; receipt about a human whose month key is not cached | `kl:unavailable` after 30 s; a `_system` receipt in the same batch succeeds |
| IT-27 | Quorum machine: `acknowledgeAlarm` with signatures of one owner when threshold is 2 | `kl:denied`; with two distinct owners → accepted |
| IT-28 | `ledger.key.register` from broker, then `serviceKey("broker")` on facet `reader` | Receipt stored unsealed with `data = {service, spki, keyRef}`; `serviceKey` returns that SPKI; a register with `data.service = "gate"` from broker → `kl:invalid` |
| IT-29 | Broker rotates its key (register signed by the old key), then another register signed by the new-but-unregistered key | First: `serviceKey` returns the new key, old entry has `until`; second (not signed by the current key) → `kl:denied` |
| IT-30 | Spool with an attested `recovery.enter` (valid `recoverySigner` signature), an unattested `recovery.wipe`, an attested file with a bad signature, and a `grant.issue` | First two appended with `data.attested`, `data.pendingSeq`, `data.onBehalfOf`; bad-signature file kept, one `ledger.alarm{spool-signature}`, not appended on the next start either; `grant.issue` moved to `rejected/` |
| IT-31 | `vouchd` queries on `vouch-heartbeat` with `eventTypes = ["user.login"]`, then with `["grant.issue"]` | Metadata stubs only (no payload, no signatures); second → `kl:denied` |
| IT-32 | `depot` calls `timeFloor` on facet `time` | Returns the newest checkpoint time |
| IT-33 | Empty ledger starts; a reader calls `serviceKey("ledger")` and verifies receipt 1 with `keylos_formats::verify_chain` | Receipt 1 is the ledger's own `ledger.key.register`, single ledger signature, subject = ledger principal; verifies |
| IT-34 | `query` with `limit 10` over 25 matching receipts, continued with `fromSeq = next` | 10 + 10 + 5 receipts, no duplicates or gaps, final `next = 0` |
| IT-35 | `ServiceHost.stop` + start without a `shutdown` receipt | No rollback alarm (final checkpoint carries the incremented counter) |
| IT-36 | Three `ledger.key.register` appended; `checkpoint()` 6 s later | Tree size includes all three (REQ-LEDGER-011 refresh) |
| IT-38 | Writer `loom` appends `workflow.cancel{workflow: wf-…}` for alice; the month is shredded; a fresh loom session queries `principalPrefix "service:loom:"` | The receipt is returned as a redacted stub whose `refs.workflow` is the `wf-…`; receipts of other writers are not returned |
| IT-39 | Loom restarts in a new boot and queries its receipts from the previous boot with `fromSeq` | All its own receipts after `fromSeq` are returned, decrypted while the unit exists |
| IT-40 | A submission with time T is in a batch; the writer closes its connection; a receipt with time > T is committed first in the batch order | The earlier-time submission is refused (`re-sign`) and never appears later |
| IT-41 | Two identical submissions (same bytes, re-signed with new times) | Two receipts with different `seq` (no deduplication) |
| IT-42 | Shred a month while a `dataKey` for that unit is in flight (vault double delays the answer) | The returned key is discarded; the receipt is redacted; no AEAD alarm |
| IT-43 | `data.workflow = "wf-bogus"` | Receipt accepted; `refs` has no `workflow` member |
| IT-37 | Fresh hearth-provisioned TPM, `0x01300100` absent | Ledger calls `HearthTpm.defineSpace(0x01300100)`; no owner-auth use; nv-auth blob carries the protocols §19.6 policy |

### 11.3 Fuzzing

Targets: `fuzz_envelope_validate`, `fuzz_wal_replay`, `fuzz_note_parse`, `fuzz_cosignature_parse`, `fuzz_query_filter`, `fuzz_export_bundle` (in `ledger-verify`). 24 CPU-hours each.

### 11.4 Conformance

Protocols `vectors/receipts/`, `vectors/dsse/`, `vectors/presence/`, `vectors/tpm/`.

### 11.5 Acceptance

All integration tests pass on KL1 and KL3; §8 budgets are met; `ledger-verify` is reproducibly built for three operating systems.

---

## 12. Implementation notes

| Crate | Use |
|---|---|
| `tokio` 1 | Runtime |
| `rusqlite` 0.32 (bundled SQLite) | Index |
| `sha2` 0.10 | Hashing |
| `ed25519-dalek` 2 | Signing |
| `chacha20poly1305` 0.10 | Body encryption |
| `tss-esapi` 7 | TPM |
| `zstd` 0.13, `tar` 0.4 | Export |
| `crc32c` 0.6 | WAL |
| `rustix` | `O_TMPFILE`, `memfd_secret` |
| `keylos-presence` | Admin presence verification |

Inherited descriptors (fd 3, `KEYLOS_CAPWIRE_FDS`, `KEYLOS_TPM_FD`) are adopted with the `keylos-capwire` helper (protocols §10.5, E16); `ledgerd` is `deny(unsafe_code)` except for one documented block that maps `memfd_secret` unit keys (protocols §20.10).

The Merkle tile logic lives in `keylos-ledger-tiles` (≈1 500 lines), following the C2SP specs, cross-tested with the Go reference implementation in CI.

```
ledger/
  crates/ledgerd/  crates/ledger-cli/  crates/keylos-ledger-verify/  crates/keylos-ledger-tiles/
  schema/ledger-cli.capnp     repo-local (§5.3)
  tests/  fuzz/  generation/
```

---

## 13. Decisions and alternatives

| Decision | Alternatives | Rationale | ADR |
|---|---|---|---|
| Per-machine Merkle log with C2SP formats | Plain hash chain (no efficient proofs); journald FSS (no proofs or witnesses) | Inclusion and consistency proofs; standard witness ecosystem | [ADR-0031](../../handbook/11-decisions/adr-0031-receipts-ledger.md) |
| Rate-limited NV counter binding | Increment per checkpoint (wears out NV); no TPM binding (offline rollback undetected) | Detects rollback of security-relevant transitions within NV endurance | [ADR-0031](../../handbook/11-decisions/adr-0031-receipts-ledger.md) |
| Sealed payloads with per-human month keys inside the chained payload (protocols §13.4) | Deleting leaves (breaks proofs); keeping everything (fails privacy); encrypting whole bodies outside the payload (fleet and backups would need keys to verify anything) | Verifiable history plus real forgetting; metadata stays verifiable without keys | [ADR-0053](../../handbook/11-decisions/adr-0053-receipt-payload-encryption.md), [ADR-0032](../../handbook/11-decisions/adr-0032-crypto-shredding.md) |
| 13-month default retention for payload keys | Forever; 1 month | Covers a year of incident review and annual audits, then forgets | [ADR-0053](../../handbook/11-decisions/adr-0053-receipt-payload-encryption.md) |
| Recovery receipts replayed as `service:ledger` with `onBehalfOf` | Giving the recovery environment writer keys | The recovery environment holds no service keys; attribution stays honest | [ADR-0031](../../handbook/11-decisions/adr-0031-receipts-ledger.md) |
| Writer keys anchored in capwire identity and the OS service table | Provisioned PKI for services | Nothing to provision; reset requires presence | [ADR-0004](../../handbook/11-decisions/adr-0004-capwire-no-system-bus.md) |
| Evidence only for durable workflows: no deduplication, own-receipt reads and workflow refs | A ledger dedup key; using the ledger as the workflow journal | The writer's outbox reconciles with the time-order rule; audit retention stays monthly and independent of workflow replay (protocols §20.25) | [ADR-0068](../../handbook/11-decisions/adr-0068-durable-workflows-loom.md) |
| Epochs after acknowledged alarms | Refusing to run forever; silently continuing | The owner decides, and the break is recorded in the log itself | [ADR-0031](../../handbook/11-decisions/adr-0031-receipts-ledger.md) |

### 13.1 Open issues against protocols

- **Resolved in protocols Appendix E (S2):** sealed AAD and signature layout (D12, E4); ledger-originated receipts verifiable by `keylos-formats` (E4); time ordering and re-sign retry (E5); `Filter.fromSeq` (E6); nv-auth sealing policy and `defineSpace` after genesis (E7); TPM fd and `KEYLOS_DEV_*` (E8); inherited-fd helper (E16).
- **Open: trusted-time signal.** No interface tells the ledger that time is NTS-trusted (§4.12); retention is owner-triggered until one exists.
- **Resolved: `recoverySigner` access.** Protocols §19.2 lists `ledger` as a `hearth#system` holder (`owners` only, C51), so the ledger reads the registry's `recoverySigner` with `HearthSystem.owners` (§4.11).

The recovery spool path and the `clear` returned form raised earlier are resolved in protocols §10.7 and §13.4.
