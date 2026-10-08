# keylos/vault — the secrets broker

| | |
|---|---|
| Repository | `github.com/keylos-os/vault` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `vaultd` (tier-0 service generation `io.keylos.vault`), `vault` (CLI generation `io.keylos.vault-cli`), `vault-import-island` (legacy-image generation `io.keylos.vault-import`, run inside a `compat` D-Bus island only for importing from the Secret Service), crate `keylos-vault-client` (SDK helper: `SecretBuf` for the delivery format, SSH agent socket use) |
| Depends on | `keylos-protocols 1.0` (`keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-labels`, `keylos-presence`, `keylos-tpm-registry`) |
| Runtime peers | `warden` (`Bootstrap`, `ServiceHost`, `FdStore`, TPM fd), `ledger` (`ledger#writer`), `hearth` (`hearth#presence`; `hearth#tpm`: `defineSpace` for `0x01300104`/`0x01300110`, `evict` for `0x81000103`), `broker` (`broker#system`: `requestFor` for non-presence confirmations), `depot` (`depot#user`, granted by the distribution default policy, for generation metadata) |
| Provides | `Vault` (protocols §7.3.6) on facets `app`, `admin`, `broker`, `gate`, `strata`, `ledger`, `aide`, `net`, `adapter`, `journal`, `loom`; `VaultUsers` (protocols §7.5.4) on facet `hearth`; the keystore hierarchy under `/keystore/vault` |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as described in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`vault` holds every secret on a keylos machine and every key whose destruction means "forget". It:

1. **Stores secret items** (passwords, tokens, API keys, private keys, Wi-Fi credentials) with **per-item ACLs bound to generation identity**. Items are never bound to paths, PIDs or bus names.
2. **Delivers secret values** to authorized apps in the delivery format of protocols §20.10. Values never pass through environment variables or arguments.
3. **Signs on behalf of callers** with keys that never leave the vault (software Ed25519 and P-256, or TPM-resident P-256), and runs a **per-principal SSH agent** with per-host policy.
4. **Supports credential injection for agents.** It issues single-use injection handles that only `gate` can redeem, so agents use credentials without ever seeing them.
5. **Holds crypto-shred unit keys** for `strata`, `ledger`, `gate`, `aide`, `journal` and `loom`, and **destroys** them so that copies in snapshots, backups and old disk blocks become unreadable.
6. **Manages the key hierarchy:** a TPM-sealed system key, a TPM-NV-resident epoch key for true destruction, per-user keys unlocked by login factors, recovery slots, and a TPM keystore floor counter against rollback.
7. **Imports** secrets from legacy stores and **exports** recovery bundles.

**Non-goals**

- The vault does not encrypt the root filesystem (LUKS2, `boot`).
- The vault does not run network authentication protocols (OAuth flows). Apps and `gate` do; the vault stores and uses the resulting tokens.
- The vault has no GUI. Presence prompts are rendered by `atrium` on behalf of `hearth`; settings use the `vault` CLI records.

---

## 2. Context and embedded contracts

### 2.1 Position

```
apps/shell/legacy ──(vault#app)──────┐
owner shell `vault` CLI ─(vault#admin)┤
broker ──(vault#broker)──────────────┤
gate ──(vault#gate)──────────────────┤       /keystore/vault (excluded from snapshots)
strata ──(vault#strata)──────────────┼──► vaultd ──► TPM: KS sealed object, NV 0x01300110 (epoch key),
ledger ──(vault#ledger)──────────────┤        │            NV 0x01300104 (keystore floor), key 0x81000103 (first boot)
aide ──(vault#aide)──────────────────┤        ├──► ledger#writer (receipts)
net ──(vault#net)────────────────────┤        ├──► hearth#presence (presence prompts), hearth#tpm (NV, evict)
compat islands ──(vault#adapter)─────┤        ├──► broker#system (requestFor: non-presence confirmations)
journal ──(vault#journal)────────────┤        └──► depot#user (generation metadata)
loom ──(vault#loom)──────────────────┤
hearth ──(vault#hearth: VaultUsers)──┘
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

<!-- BEGIN protocols §7.3.8 (verbatim) -->
> **protocols 7.3.8 `depot.capnp`**

```capnp
@0xc7a1e5d3b2f40008;
using C = import "common.capnp";

struct GenerationInfo {
  ref       @0 :C.Ref;
  kind      @1 :Text;
  name      @2 :Text;
  version   @3 :Text;
  manifest  @4 :Data;         # manifest JSON bytes
  launchable @5 :Bool;
  sealedBy  @6 :List(Text);   # key refs whose signatures over the generation statement verified
  grafted   @7 :Bool;
  revoked   @8 :Bool;
  installed @9 :C.Timestamp;
  launchReasons @10 :List(Text);   # why launchable is false: "no-authorising-signature", "revoked:<reason>", "needs-consent",
                                   # "quorum-deferred", "unreviewed-tier2", "offline-install-needs-t3", "kernel-mismatch" (kmod)
}

interface Depot {
  get        @0 (ref :C.Ref) -> (info :GenerationInfo);
  list       @1 (kind :Text, name :Text) -> (list :List(GenerationInfo));
  install    @2 (source :Text) -> (info :GenerationInfo, capabilityDiff :Text);  # "oci://…[#gen=fsv256:…]", "tuf:<stream>/<name>", ".klb" bundle fd path via powerbox
  mount      @3 (ref :C.Ref) -> (tree :C.Fd);          #! facet mounter (warden, bench, compat) and config (kind config only); fsmount fd (composefs, verity=require)
  openObject @4 (ref :C.Ref) -> (fd :C.Fd);            # read-only fd of store object
  importTree @5 (tree :C.Fd, manifest :Data) -> (info :GenerationInfo);   # facets forge (all kinds), config (config, policy), compat (legacy-image)
  seal       @6 (ref :C.Ref, statement :Data) -> (info :GenerationInfo);  # attach owner seal (DSSE seal statement signed via HearthSeal)
  root       @7 (ref :C.Ref, holder :Text) -> ();      # GC root
  unroot     @8 (ref :C.Ref, holder :Text) -> ();
  gc         @9 (dryRun :Bool) -> (freedBytes :UInt64, removed :List(C.Ref));
  verify     @10 (ref :C.Ref) -> (ok :Bool, problems :List(Text));
  revocations @11 () -> (listEnvelope :Data);
  openPath   @12 (ref :C.Ref, path :Text) -> (fd :C.Fd);
      #! read-only fd of a regular file inside a generation, resolved in the generation's own tree (no symlink escape).
      #! facet user: only paths under /.keylos/ (manifest.json, cmdsig/*, l10n/*, agent/*, icons/*, sbom.spdx.json,
      #! provenance.json, workflows/*) of generations the caller may spawn, agent templates, or catalog entries; facet mounter: any path;
      #! facet loom: /.keylos/manifest.json and /.keylos/workflows/* of any installed generation
  revocationStatus @13 () -> (serial :UInt64, issued :C.Timestamp, ageSecs :UInt64);
      #! facets user, mounter, compat: the newest verified revocation list; ageSecs measured against trusted time (§3.6, §14.5)
}
```

**GC roots** are named `<holder>:<purpose>:<id>`. Registered holder prefixes: `loom:workflow:<wf-id>` (the pinned definition generation of every workflow that is not yet terminal, and of a terminal one until it is forgotten; §20.25), `warden:running:<session>` (every generation `warden` mounted; `warden` calls `unroot` when the last principal using that mount exits, so `depot` needs no unmount notification), `cri:pod:<pod-id>` (container generations and images of a pod), `courier:os:<seq>` (bootable OS generations), `courier:kmod:<kernel-release>` (kmod generations for an installed kernel). Other prefixes are repo-local.

**Container mounts.** `mount` of a `container` generation succeeds only while it is rooted by a `cri:pod:<pod-id>` holder; `cri` roots it before calling `PodSpawn` (§21.4).

`install("tuf:<stream>/<name>")` and `install("tuf:org:<org>/<name>")` are resolved through `CourierResolver.resolve` (§7.5.6), which also returns the catalog review status; `depot` is never a TUF client. Revocation lists reach `depot` the same way: `courier` resolves `tuf:<stream>/revocations` and `depot` takes the DSSE list from `Resolution.revocations` (§7.5.6). Source form `oci+container://<registry>/<repo>@sha256:<manifest>` (facet `cri` only) converts an OCI image into a `container` generation (§21.4). `courier` installs OS generations with the source form `oci://<registry>/<repo>@sha256:<manifest>#gen=fsv256:<hex>`, which `depot` MUST accept (the fragment pins the expected generation digest).
<!-- END protocols §7.3.8 -->

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

#### 2.2.5 Layout, registries and shared formats

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

<!-- BEGIN protocols §19.2 rows=^\| vault \| (verbatim) -->
> **protocols 19.2 Facets** (rows for this repository)

Every route names exactly one facet. Servers MUST implement exactly these facets; holders other than those listed are routed only when policy explicitly grants `right("service", "<svc>#<facet>", "use")`.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| vault | `app` | apps (per `needs.secrets`), `shell`, legacy, bench-relay (for its VM principal, §7.5.10 `GuestPortals.secret`) | `open`, `store`, `delete`, `list`, `sign`, `sshAgent` (own items) |
| vault | `admin` | owner `shell` | all `app` methods incl. ACL updates |
| vault | `broker` | broker | `open` on behalf of a principal |
| vault | `gate` | gate | `inject`, `open("inject:…")`, `dataKey`/`forget` for `gate:` units |
| vault | `strata` | strata | `dataKey`, `forget` |
| vault | `ledger` | ledger | `dataKey`, `forget` for `ledger:` units |
| vault | `aide` | aide | `store`/`delete`/`sign` of session keys; `dataKey`/`forget` for `aide:` units |
| vault | `hearth` | hearth | `VaultUsers` |
| vault | `net` | net | `open`/`store` of `_system` items of kinds `wifi` and `token` |
| vault | `adapter` | compat | `store` (import from legacy secret stores, on the human's behalf, with prompt) |
| vault | `journal` | journal | `dataKey`, `forget` for `journal:` units |
| vault | `loom` | loom | `dataKey`, `forget` for `loom:` units |
<!-- END protocols §19.2 rows=^\| vault \| -->

<!-- BEGIN protocols §19.3 rows=\| vault \|$ (verbatim) -->
> **protocols 19.3 Receipt events** (rows for this repository)

| Event | Writer |
|---|---|
| `secret.open`, `secret.store`, `secret.delete` | vault |
<!-- END protocols §19.3 rows=\| vault \|$ -->

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

<!-- BEGIN protocols §20.10 (verbatim) -->
> **protocols 20.10 Secret delivery (`Vault.open`)**

- **Primary:** a `memfd_secret(FD_CLOEXEC)` fd of the value's length plus 8, rounded up to the page size, laid out as `u64 little-endian length ‖ value ‖ zero padding`. secretmem fds are readable only through `mmap`; recipients map them `PROT_READ`, read the length, use the bytes, and zeroize and unmap on drop (`keylos-vault-client::SecretBuf`).
- **Fallback** (when `memfd_secret` is unavailable): a `memfd_create(MFD_CLOEXEC|MFD_ALLOW_SEALING|MFD_NOEXEC_SEAL)` fd with the same layout, sealed `F_SEAL_WRITE|F_SEAL_SHRINK|F_SEAL_GROW|F_SEAL_SEAL`. The receipt records `data.delivery = "memfd-sealed"`.
<!-- END protocols §20.10 -->

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

#### 2.2.6 Broker system interface, TPM administration, recovery key, guests and cross-repository files

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

<!-- BEGIN protocols §3.3 (verbatim) -->
> **protocols 3.3 Names**

- **Generation names** use reverse-DNS: `org.example.Editor`. The pattern is `^[a-z][a-z0-9-]*(\.[a-zA-Z0-9-]+){2,}$`, at most 255 characters. The prefixes `io.keylos.` and `org.keylos.` are reserved for the project.
- **Service names** are `[a-z][a-z0-9-]{0,62}` (for example `vault`, `portal-files`). The registry is §19.1.
- **Facet names** are `[a-z][a-z0-9-]{0,31}`. The registry is §19.2.
- **Usernames** are `[a-z_][a-z0-9_-]{0,31}`. `_system` and `_cluster` are reserved, and the prefix `guest-` is reserved for ephemeral guest sessions (`guest-<8 lowercase base32>`, created and destroyed by `hearth`).
- **Kubernetes names**: `pod-ns` and `pod-name` follow Kubernetes DNS-1123 label / subdomain rules (`[a-z0-9]([-a-z0-9]*[a-z0-9])?`, ≤ 63 and ≤ 253 characters).
<!-- END protocols §3.3 -->

<!-- BEGIN protocols §20.21 (verbatim) -->
> **protocols 20.21 Recovery key**

- **Secret:** 32 random bytes generated by the installer.
- **Text form:** 64 lowercase hex digits in 8 groups of 8; each group is followed by a 2-hex-digit CRC-8 (polynomial 0x07, init 0x00) of that group's 4 bytes; groups are separated by `-`: `xxxxxxxxcc-xxxxxxxxcc-…`. The CRC lets the recovery environment point at a mistyped group. Input is case-insensitive and ignores spaces.
- **LUKS2 recovery keyslot:** passphrase = the 64 hex digits without separators and CRCs; LUKS2 applies Argon2id (m = 1 GiB, t = 4, p = 4).
- **Derivations** (HKDF-SHA256 over the 32-byte secret, salt empty, info strings): `"keylos-recovery-auth/1"` (TPM recovery auth object `0x81000105`), `"keylos-lockout/1"` (TPM lockout auth), `"keylos-recovery-signer/1"` (Ed25519 seed of the owner-registry `recoverySigner`), `"keylos-escrow/1"` (optional backup-escrow wrapping key), `"keylos-recovery-recipient/1"` (X25519 private key of the **recovery recipient**; its public half is stored at `/var/lib/keylos/recovery/recipient.pub` and in the first-boot bundle, and running services encrypt recovery copies to it with HPKE (§4): the owner-hierarchy auth and vault `recovery` slots), `"keylos-sb-pk/1"` (seed of the owner Secure Boot **PK**: an RSA-2048 key generated deterministically with HMAC-DRBG-SHA256 seeded by this output, per FIPS 186-5 appendix B.3.3, so the recovery environment can re-create it to sign KEK updates; the PK is never stored).
- `hearth`, `boot`, `installer` and the trustee tooling MUST use exactly this format.
<!-- END protocols §20.21 -->

<!-- BEGIN protocols §10.7 rows=vault|nv-auth|firstboot (verbatim) -->
> **protocols 10.7 Cross-repository files** (rows for this repository)

A repository MAY read a file written by another repository **only if the file is listed here**; everything else is that repository's private state.

| Path | Format | Writer | Readers |
|---|---|---|---|
| `/etc/keylos/strata/snapshot-exclude.list` | newline-separated absolute paths | config | strata, vault |
| `/var/lib/keylos/tpm/nv-auth/<index>.sealed` | `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` of the sealed authValue object (§19.6, "Sealed secrets"); `<index>` is `0x` + 8 lowercase hex digits, e.g. `0x01300100.sealed` | installer at genesis; hearth on (re)definition (`HearthTpm.defineSpace`); `rescue` (recovery profile) | the index's registered owner service only |
| `/var/lib/keylos/recovery/recipient.pub` | 32-byte raw X25519 public key of the recovery recipient (§20.21) | installer | vault, hearth |
| `/var/lib/keylos/firstboot/bundle.json` | `keylos.firstboot/1` (§20.13) | installer | the consumers listed in §20.13 |
<!-- END protocols §10.7 rows=vault|nv-auth|firstboot -->

### 2.3 Interpretation notes (normative for this repo)

1. **`inject` target format.** `target` is `<scheme>://<host>[:<port>][#hostkey=<SHA256 fingerprint>]&for=<principal>&root=<rootId hex>` with schemes `https`, `http`, `ssh`. `for` and `root` name the subject principal and the token root that `gate` verified. For `ssh` targets `hostkey` is REQUIRED.
2. **Prompts.** Non-presence confirmations (`perSession`, `always`) go through the broker: the vault is a `broker#system` holder and calls `BrokerSystem.requestFor(subject = its own session, req, intent = "", idempotencyKey)` (protocols §7.5.2; `vault` may name only its own session). `req` is a `GrantRequest{resource: secret("<owner>/<name>"), rights: [use], durationSecs: 0, persist: false, reason}` with `onBehalfOf` = the caller's principal (protocols §7.3.3; informational, shown on the prompt and recorded in the broker's receipts) and `reason` = the human-readable line "<app> (<publisher>) wants to <op> \"<item>\"" (plus " for <sshHost>" for SSH signatures); the broker renders it on the trusted path at T2 and returns the decision with a mandate re-signed by `service/broker` (protocols §14.4), which the vault verifies against the key returned by `Ledger.serviceKey("broker")` (protocols §7.3.5, on the vault's `ledger#writer` route; the key is cached and re-fetched once when a mandate fails verification, then the failure is final). The mandate effect is the protocols §14.4 grant form (E3): kind `grant.secret`, target `secret:<owner>/<name>`, digest = SHA-256 of the JCS GrantRequest JSON form; the vault checks the kind, the digest, the approval ID and expiry. The `presence` policy uses `Hearth.presence` (purpose `vault.<op>`, protocols §20.2). On quorum machines presence means a quorum envelope (protocols §5.4). **Presence verification:** the vault holds no `hearth#system` route, so it verifies presence envelopes (from `Hearth.presence`, or supplied by the CLI) with `keylos-presence` against the boot trust set's `keys.ownerPresence` and `spki` (credential IDs are not in `trust.json`, so the credential-ID check is skipped), plus purpose, `requestedBy`, payload equality when the vault built the payload, freshness ≤ 300 s and nonce reuse.
3. **Generation identity.** An app's name and publisher come from `Depot.get(generation)` (`manifest.name`, `manifest.publisher`, `sealedBy`), cached per generation. The vault's route to `depot#user` is granted by the distribution's default config (protocols §19.2 rule for unlisted holders). The generation looked up is `ServiceHost.accept`'s `generation` when present, otherwise the generation in the actor; when `depot` fails, app and legacy callers get `kl:unavailable` unless the generation is cached.
4. **FIDO2 relying parties.** Login credentials and vault FIDO2 slots use rpId `keylos.login`; presence uses `keylos.owner` (protocols §5.3). `hearth` performs every CTAP exchange and passes the 32-byte `hmac-secret` output to the vault in a delivery-format fd.
5. **TPM objects.** NV `0x01300104` (keystore floor), `0x01300110` (vault-epoch/0) and `0x01300111` (vault-epoch/1) are defined only through `HearthTpm.defineSpace` (protocols §7.5.3, §19.6, E1, E28); their authValues are the sealed blobs `/var/lib/keylos/tpm/nv-auth/0x01300104.sealed`, `…/0x01300110.sealed` and `…/0x01300111.sealed` (protocols §10.7), in the nv-auth sealed-object format of protocols §19.6 (E7). Both epoch indices are `AUTHREAD | AUTHWRITE | NO_DA` with an empty authPolicy: every read and write uses the sealed authValue. The floor counter is read through its public `PolicyCommandCode(NV_Read)` branch, so startup can check the floor even when an authValue blob does not unseal; a never-incremented counter (`TPM_RC_NV_UNINITIALIZED`) is a genesis value, which the vault increments once at genesis and anchors `db.floor` to. **TPM access:** the vault uses the `/dev/tpmrm0` fd named by `KEYLOS_TPM_FD` (protocols §10.5, E8) and opens a TPM context per operation so other TPM users are never blocked; development builds may use `KEYLOS_DEV_TPM_TCTI` instead. **Sealing policy:** KS, the writer key and every other vault-sealed object use the production policy of protocols §19.6 (`PolicyAuthorize(PCR11 ready) ∧ PolicyPCR(15)`); development builds without a signed PCR11 policy use the stated development fallback (`PolicyPCR(15)`), chosen by comparing the object's authPolicy with both digests. The first-boot seed key `0x81000103` is an ECC P-256 decrypt key used with HPKE DHKEM(P-256, HKDF-SHA256) (protocols §4); after the first-boot import the vault evicts it with `HearthTpm.evict(0x81000103)`.
6. **Recovery key.** The recovery key is the 32-byte secret of protocols §20.21. The vault never sees it. Its recovery identity is the machine's **recovery recipient** (protocols §5.2, §20.21): the X25519 key derived with info `"keylos-recovery-recipient/1"`, whose public half the vault reads from `/var/lib/keylos/recovery/recipient.pub` (protocols §10.7) and checks against `recovery.recipient` of the first-boot bundle at first start. All recovery copies the vault makes (recovery slots, backups) are HPKE ciphertexts to that recipient (protocols §4).
7. **Guests.** Users named `guest-…` (protocols §3.3) are ephemeral (§4.12).
8. **Writer key.** The vault's `service/vault` Ed25519 key is TPM-sealed in `/keystore/vault/service-key.sealed` and registered with `ledger.key.register` before the first other receipt. A wiped keystore or a TPM clear loses it; the owner's `ledger writers reset vault` is then required, and `vault restore` creates a new key.
9. **Slot parameters** (protocols §7.5.4, E11). `SlotSpec.params` is JCS JSON with binary members in standard base64: password `{"alg": "argon2id", "m", "t", "p", "salt", "prehashed"?}`, fido2 `{"credentialId", "rpId": "keylos.login", "salt1"}`, recovery `{}` from `hearth` (the vault adds `ephemeralPublic`). For password slots the factor is the raw UTF-8 passphrase or PIN and the vault runs Argon2id with the stored parameters; only at creation may `params.prehashed = true` mark the factor as the 32-byte raw Argon2id output (first-boot password from the bundle hash). FIDO2 factors are the 32-byte `hmac-secret` output.
10. **Facet `ledger` receipts.** On facet `ledger` the `dataKey`-creation and `forget` receipts are written right after the reply (the ledger may call `dataKey` from inside an append and serialise appends); on every other facet before the reply (REQ-VAULT-026, REQ-VAULT-030).

---

## 3. Requirements

### 3.1 Keys and storage

- **REQ-VAULT-001** All vault state MUST live under `/keystore/vault/`. The vault MUST refuse to start if `/keystore` is not the `@keystore` subvolume (checked with `statfs` subvolume ID against `/proc/self/mountinfo` subvolume options) or if `@keystore` is not listed in `/etc/keylos/strata/snapshot-exclude.list`.
- **REQ-VAULT-002** The key hierarchy MUST be exactly §4.1. No secret value or data key is stored without a wrap that depends on the current epoch key.
- **REQ-VAULT-003** The current epoch key MUST reside only in one of the two TPM NV epoch indices `0x01300110`/`0x01300111` (the **active** index named in `vault.db`) and in vault process memory. Rotation MUST write the new key to the other (**candidate**) index, commit, advance the floor and then erase the previous index, exactly as §4.5.1; it MUST NOT depend on volatile state (no `FdStore` copy of the new key).
- **REQ-VAULT-004** Memory holding keys or secret values MUST be allocated with `memfd_secret` (fallback `mlock` + `MADV_DONTDUMP`) and zeroized on release. `vaultd` MUST set `PR_SET_DUMPABLE 0`.
- **REQ-VAULT-005** Every committed state change in the security set (item delete, ACL change, slot removal, unit forget, epoch rotation, user delete, restore) MUST advance the keystore floor (§4.9) so that rolling `/keystore/vault` back to an earlier copy is detected.
- **REQ-VAULT-006** The vault MUST NOT define, undefine or change attributes of TPM NV indices or persistent handles itself. It uses `HearthTpm.defineSpace(0x01300104 | 0x01300110 | 0x01300111)` to (re-)create its indices from the registry templates and `HearthTpm.evict(0x81000103)` to evict the first-boot seed key (protocols §7.5.3). It writes its indices only with the authValues sealed in `/var/lib/keylos/tpm/nv-auth/` (protocols §10.7, §19.6).

### 3.2 Access control

- **REQ-VAULT-010** The caller's principal, tier and generation MUST come from `ServiceHost.accept`. The caller's generation name, publisher and seal status MUST come from `Depot.get` (§2.3 note 3).
- **REQ-VAULT-011** Item ACL evaluation MUST follow §4.3. No matching ACL entry → `kl:denied`. Prompt policies `perSession` and `always` require a broker-mediated T2 confirmation and `presence` requires a presence prompt (§2.3 note 2) before the operation proceeds.
- **REQ-VAULT-012** Agent principals (`agent:` actor) MUST NOT receive secret values through `open` on any facet. Agents use secrets only through `gate` injection (§4.7).
- **REQ-VAULT-013** Items of a human are inaccessible while that human's user key is locked: `kl:unavailable` with message `user-locked`.
- **REQ-VAULT-014** Each facet MUST expose exactly the methods listed for it in protocols §19.2 (§5.1); other methods fail `kl:denied`.

### 3.3 Operations

- **REQ-VAULT-020** `store` reads the value from the passed fd (≤ 1 MiB; larger → `kl:invalid`), creates a fresh 256-bit DEK, encrypts the value and wraps the DEK (§4.1). Without a supplied ACL the item gets `{actors: [caller pattern], ops: [read, use, update, delete], prompt: never}`. Caller patterns: apps `app:name=<name>;publisher=<key>`; owner-sealed apps `app:name=<name>;sealed-by=owner`; `shell`; services `service:<name>`. An existing name the caller may not `update` → `kl:conflict`. `value.index = 0xFFFF` means an ACL-only update (admin facet).
- **REQ-VAULT-021** `list` MUST return only items for which the caller has at least one op. On facet `admin` the owner shell lists every item of its own human (so it can edit app items' ACLs); values still follow the ACL.
- **REQ-VAULT-022** `sign` MUST support `alg` `ed25519`, `ecdsa-p256-sha256`, `ssh-ed25519` and `ecdsa-sha2-nistp256`. Items of kind `tpm-p256` sign inside the TPM.
- **REQ-VAULT-023** `sshAgent` MUST return a connected `SOCK_STREAM` unix socket implementing the SSH agent protocol for the caller principal, including `session-bind@openssh.com`, with per-host policy (§4.6).
- **REQ-VAULT-024** `dataKey(unit)` MUST return the unit's 256-bit key in a delivery-format fd, creating it if absent. `forget(unit)` MUST make the key unrecoverable within `epochRotationMaxDelaySecs` (default 3 600 s, minimum 60 s) through epoch rotation (§4.5). Units are restricted per facet (§4.5, §5.1): `strata` all except reserved prefixes; `ledger` → `ledger:`; `gate` → `gate:`; `aide` → `aide:`; `journal` → `journal:`; `loom` → `loom:`.
- **REQ-VAULT-026** `dataKey` and `forget` on facet `ledger` MUST be served concurrently with the vault's own pending `Ledger.append` calls (the ledger seals receipts about the vault's callers with `ledger:` unit keys, ledger spec §4.8.1); the vault MUST NOT hold a lock across an append that `dataKey` needs.
- **REQ-VAULT-027** On facet `app`, item ownership and ACL matching MUST use the connection's principal as delivered by `ServiceHost.accept` (protocols §7.1, D2; `SO_PEERPIDFD` on warden-made socketpairs names warden). For connections from `bench-relay` this is the tier-2/3 VM principal (`app:`, `bench:` or `agent:` actor) it serves (`GuestPortals.secret`, protocols §7.5.10); ACL patterns match the VM principal's actor, and a VM principal never sees another VM's or the host app's items unless an ACL names it explicitly. Tier-2/3 VM principals get their principal text as owner scope; their items are wrapped under the human's `K_user` and lock with the human. ACL pattern `bench:gen:fsv256:<hex>` matches bench VM principals (§4.3).
- **REQ-VAULT-025** `inject` MUST return a 32-byte random handle that is single-use, valid 60 s, bound to `(item, target host, hostkey, for-principal, root)`, and redeemable only with `open("inject:<hex>", purpose)` on facet `gate`.

### 3.4 Prompts and receipts

- **REQ-VAULT-030** Every `open`, `store`, `delete`, `sign`, SSH sign, `inject` redemption, `dataKey` creation, `forget` and ACL change MUST produce a receipt before returning: `secret.open` (with `data.op` ∈ open, sign, ssh-sign, inject, datakey), `secret.store` (with `data.aclChange` for ACL updates) and `secret.delete` (with `data.unit` for forgets).
- **REQ-VAULT-031** Prompts (broker confirmations and presence prompts) MUST state the requesting app's display name and publisher, the item's display name, the operation and, for SSH, the destination host and key fingerprint. For presence prompts the vault builds the `keylos.presence/1` payload with these in `details`; for broker confirmations it puts them in the `GrantRequest.reason` JSON (§2.3 note 2).
- **REQ-VAULT-032** Every broker confirmation MUST carry an idempotency key `vault:<caller session>:<item>:<op>:<ULID per attempt>`; a retried attempt after a vault restart reuses the key stored in `vault.db` table `confirmations`, so no second prompt appears for the same attempt. `perSession` caches a granted confirmation per `(caller session, item, op)`; the vault cannot observe session ends, so a cache entry expires after 8 h (the default `shell`/app token lifetime) or on `lockUser` of the item's owner, whichever comes first.

### 3.5 Recovery and first boot

- **REQ-VAULT-040** At user creation the vault MUST create a recovery slot exactly when `slots` contains a `recovery` SlotSpec (§4.8); `hearth` decides which users get one (`hearth.recoverySlots`, default owners; protocols §7.5.4, E11). A recovery slot is created without any input secret (`SlotSpec.kind = recovery`, factor absent, protocols §7.5.4): the vault generates a random 32-byte slot secret, wraps KU under it and stores the slot secret only as an HPKE ciphertext to the recovery recipient. `addSlot` with `kind = recovery` and a factor fd MUST fail `kl:invalid`.
- **REQ-VAULT-044** The vault MUST refuse to create recovery slots or backups (`kl:unavailable`, `vault status` → `recovery-recipient-missing`) while `/var/lib/keylos/recovery/recipient.pub` is absent or differs from the first-boot bundle's `recovery.recipient` (first start) or from the value recorded in `vault.db` (later starts).
- **REQ-VAULT-041** `vault backup` MUST produce a bundle decryptable only with the recovery key, excluding every forgotten unit and deleted item.
- **REQ-VAULT-042** At first boot the vault MUST import the `vault` part of the first-boot bundle (protocols §20.13), decrypting values with HPKE base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, whose private key is the TPM key `0x81000103` (the ECDH step runs in the TPM with `TPM2_ECDH_ZGen`; protocols §4), store them as `_system` items, report its part done, and then call `HearthTpm.evict(0x81000103)`.
- **REQ-VAULT-043** The vault MUST verify after eviction that `0x81000103` is absent (`TPM2_ReadPublic` fails) and record `secret.delete{unit: "tpm:0x81000103"}`; if eviction fails it retries at every start and `vault status` shows `seed-key-present`.

### 3.6 Guests and user deletion

- **REQ-VAULT-050** For a guest user (`guest-…`), `createUser` MUST accept only an empty slot list (any other list → `kl:invalid`; protocols §7.5.4, E11), create KU in secret memory only (never wrapped, never written), and store the guest's items and units in memory-only tables. `lockUser` of a guest is equivalent to `deleteUser`. `deleteUser` (at guest logout, called by `hearth`) MUST zeroize everything of that guest; no epoch rotation is needed because nothing was persisted.
- **REQ-VAULT-052** On facet `loom` the vault MUST serve only `dataKey` and `forget`, for units `loom:<owner>:<wf-…>` and `loom:_system:<wf-…>` whose last component is a valid workflow ID (protocols §3.5); every other unit or method fails `kl:denied`. These units MUST be wrapped under `K_sys` and served while the owner is locked (§4.5).
- **REQ-VAULT-053** A forgotten `loom:` unit MUST follow REQ-VAULT-024 and §4.5.1 like every `K_sys` unit: `dataKey` → `kl:revoked` at once, erasure reported after the next completed rotation, and the name never reusable while its tombstone exists (workflow IDs are never reused anyway, protocols §3.5).
- **REQ-VAULT-054** The vault MUST NOT condition `dataKey` for `K_sys`-wrapped units (`ledger:`, `gate:`, `aide:`, `journal:`, `loom:`) on the owner's lock state; lock policies are the consuming service's (§4.5 "Lock policy is not key wrapping").
- **REQ-VAULT-051** `deleteUser(user)` of a persistent user MUST destroy every unit whose owner is that user under every prefix, including `ledger:<user>:*`, `aide:<user>:*`, `gate:<user>:*`, `journal:<user>:*` and `loom:<user>:*`, and rotate the epoch immediately (§4.5.1).

---

## 4. Design

### 4.1 Key hierarchy

```
TPM
 ├─ SRK 0x81000001 (owner hierarchy)
 │    ├─ KS_sealed  system key KS (256-bit), sealed object (/keystore/vault/system.sealed)
 │    │             policy = PolicyAuthorize(release-stream PCR11 key, phase "ready") ∧ PolicyPCR(15)
 │    ├─ /var/lib/keylos/tpm/nv-auth/0x01300104.sealed  authValue of NV 0x01300104 (PCR11 ready ∧ PCR15)
 │    ├─ /var/lib/keylos/tpm/nv-auth/0x01300110.sealed  authValue of NV 0x01300110 (same policy)
 │    └─ /var/lib/keylos/tpm/nv-auth/0x01300111.sealed  authValue of NV 0x01300111 (same policy)
 │       (all sealed objects: protocols §19.6 nv-auth template and policy, E7; development fallback PolicyPCR(15))
 ├─ NV 0x01300110  vault-epoch/0: epoch key KE (32 bytes) ‖ u64 BE epoch; AUTHREAD|AUTHWRITE|NO_DA, empty authPolicy
 ├─ NV 0x01300111  vault-epoch/1: same template (protocols §19.6, E1, E28). Exactly one is active (vault.db meta.active);
 │                 the other is the candidate of the next rotation or erased (all-zero key)
 ├─ NV 0x01300104  keystore floor (counter; registry template: public NV_Read branch, AUTHWRITE; NO_DA)
 └─ 0x81000103     first-boot vault seed key: ECC P-256 decrypt key for HPKE DHKEM(P-256, HKDF-SHA256),
                   evicted after first boot through HearthTpm.evict

Derived (in memory only):
  KE_sys        = HKDF-SHA256(ikm = KE, salt = "keylos-vault-epoch", info = "system")
  KE_u          = HKDF-SHA256(ikm = KE, salt = "keylos-vault-epoch", info = "user|<user>")
  K_sys(e)      = HKDF-SHA256(ikm = KS ‖ KE_sys, salt = "keylos-vault-sys", info = u64_be(e))
  KU            = per-human random 256-bit key, stored only wrapped per slot, in two layers:
                  inner      = AEAD(HKDF(ikm = factor_secret, salt = slot_salt, info = "keylos-vault-slot|<user>|<slotId>"), KU)
                  wrapped_ku = AEAD(HKDF(ikm = KE_u, salt = slot_salt, info = "keylos-vault-slot-epoch|<user>|<slotId>|" ‖ u64_be(e)), inner)
                  factor_secret = Argon2id(password/PIN, salt) | FIDO2 hmac-secret output | recovery slot secret r
  K_user(e)     = HKDF(ikm = KU ‖ KE_u, salt = "keylos-vault-user", info = u64_be(e))

  u64_be(e) is the epoch as 8 bytes big-endian (fixed vectors in vault-core kdf tests). The nested slot wrap keeps the
  dependency of every slot on both KE and the factor, while letting a rotation re-wrap the outer layer without the
  factor (which the vault never keeps), for locked and unlocked users alike.
  DEK           = per item / per unit; wrapped with AES-256-GCM under K_user(e) (human-owned) or K_sys(e)
                  (system-owned and ledger: units), AAD = "<owner>|<name or unit>"
```

Properties:
- **No epoch key, no key.** Every DEK wrap and every slot wrap depends on KE. Erasing KE from TPM NV (§4.5.1) makes every earlier wrap useless, wherever copies survive (old btrfs blocks, backups made without re-wrap, `/keystore` remnants).
- **System secrets are bound to the boot.** KS unseals only on a correctly booted system with the right volume identity.
- **User secrets need the user.** KU is reconstructible only with KE and a login factor, so while a human is locked their items stay locked even against runtime root.
- **Rollback is detected.** The keystore floor (§4.9) catches restoration of an older `vault.db`.

### 4.2 Users and slots

`VaultUsers` (facet `hearth`):

| Operation | Effect |
|---|---|
| `createUser(user, slots[])` | Generates KU; creates one slot per SlotSpec (a recovery slot only when one is requested, REQ-VAULT-040); returns slot IDs. Guests: empty list only |
| `unlockUser(user, slotId, factor)` | Reads the factor from the delivery-format fd, derives the slot wrap key, unwraps KU, keeps `K_user` in memory, re-wraps any pending rows (§4.5.1) |
| `lockUser(user)` | Zeroizes KU and `K_user` |
| `addSlot`, `removeSlot` | Require the user unlocked (`kl:unavailable` with message `user-locked` otherwise; `hearth`'s `enrollKey` surfaces it and the caller retries after a login, protocols §7.5.4, E11); removing the last non-recovery slot is refused (`kl:conflict`); removal advances the floor |
| `deleteUser(user)` | Deletes all slots, items and units of the user under every prefix (REQ-VAULT-051), tombstones them, advances the floor, rotates the epoch immediately. For guests: zeroizes memory-only state (REQ-VAULT-050) |
| `slots(user)` | JSON `[{slotId, kind, label, created, epoch}]` |

`SlotSpec.kind` ∈ `password`, `fido2`, `recovery`. `params` follow §2.3 note 9 (JCS JSON, standard base64): for `password` the Argon2id parameters and salt; for `fido2` `{"credentialId", "rpId": "keylos.login", "salt1"}`; for `recovery` `{}` (the vault stores `{"ephemeralPublic"}`).

**First-boot password slot.** The first-boot bundle carries the owner's Argon2id hash string (protocols §20.13 `owner.passwordHash`). `hearth` passes the decoded raw Argon2id output as the factor with `params.prehashed = true` and the parsed parameters and salt; later `unlockUser` calls pass the raw password and the vault recomputes Argon2id with the stored parameters. The bundle is deleted after consumption.

**Slot records** (table `slots`): `user`, `slot_id` (`slot-` + ULID), `kind`, `salt` (32 bytes), `params`, `wrapped_ku`, `epoch`, `label`, `created`.

### 4.3 Items and ACL evaluation

**Items** (table `items`): `owner` (human or `_system`), `name`, `kind`, `acl` (JCS JSON), `attrs` (JSON: display name, `injectHosts`, SSH host policy, created-by principal, `sessionKey` flag), `dek_wrapped`, `ct`, `epoch`, `created`, `updated`.

**Kinds:**

| Kind | Content | Injectable |
|---|---|---|
| `password` | UTF-8 value | no |
| `token` | Opaque bearer token | yes (`https`/`http`) |
| `http-basic` | Username and password | yes |
| `http-header` | Header name and value | yes |
| `aws-sigv4` | Access key, secret, session token | yes |
| `ssh-key` | OpenSSH private key (Ed25519 or ECDSA) | yes (`ssh`) |
| `tpm-p256` | TPM-resident key handle blob and public key | no (signing only) |
| `ed25519-key` | Raw Ed25519 private key (also agent session keys, `attrs.sessionKey = true`) | no (signing only) |
| `wifi` | SSID plus PSK or EAP credentials; `_system`, used by `net` | no |
| `opaque` | Arbitrary bytes | no |

**Name scope.** A human's items are internally `alice/<name>`; callers pass `<name>` and the vault prefixes the caller's human. System callers address `_system/<name>`. The SDK recommends app-prefixed names (`org.example.Editor/sync-token`).

**Actor patterns** (`ItemAcl.actors`):

| Pattern | Matches |
|---|---|
| `app:gen:fsv256:<hex>` | Exactly that generation |
| `app:name=<name>;publisher=<keyid>` | Any generation of that name whose `sealedBy` contains that publisher key |
| `app:name=<name>;sealed-by=owner` | Generations of that name whose `sealedBy` contains an owner-seal key of the boot trust set |
| `legacy:gen:fsv256:<hex>` | That legacy image |
| `shell` | The human's shell principal |
| `service:<name>` | A system service (for `_system` items) |
| `agent:gen:fsv256:<hex>` | An agent template; valid only with op `use` (injection, SSH signing via `gate`) |
| `bench:gen:fsv256:<hex>` | A bench VM principal of that image (tier-2/3 apps through `bench-relay`, REQ-VAULT-027) |

**Evaluation** for `(caller, op, item)`:
1. If the caller's human ≠ the item's owner and the item is not a `_system` item reachable through a `service:` pattern, deny.
2. Take the first `actors` entry matching the caller.
3. Check `op ∈ ops` (`read` implies `use`).
4. Apply the prompt policy:

| Policy | Behaviour |
|---|---|
| `never` | Proceed |
| `perSession` | Broker confirmation (T2, §4.13) the first time per caller session; cached per REQ-VAULT-032 |
| `always` | Broker confirmation every time |
| `presence` | Presence prompt every time (UV per policy); quorum envelope on quorum machines |

**ACL edits** (admin facet, owner shell): adding an `agent:` actor or a `prompt: never` entry for an actor other than the item's creator requires presence (`vault.acl`). Every ACL change advances the floor.

### 4.4 Delivery

`open(name, purpose)`:
1. Evaluate the ACL for `read` (on the caller, or on `onBehalfOf` for the broker facet).
2. Decrypt into secret memory.
3. Create the delivery fd exactly per protocols §20.10 (u64 little-endian length ‖ value ‖ zero padding; `memfd_secret`, fallback sealed memfd). Drop the vault's own mapping and descriptor before replying.
4. Write the receipt (`secret.open{op: "open", delivery}`).
5. Reply.

On facet `broker`, `purpose` is JSON `{"onBehalfOf": "<principal>", "grantRoot": "<hex>", "reason": "…"}`. The vault evaluates the ACL against `onBehalfOf` (whose generation it looks up with `Depot.get`), refuses `agent:` principals, and records `grantRoot` in the receipt. Holding the `broker` facet is the authority to act on behalf; the vault does not re-verify the broker's token.

### 4.5 Unit keys and forgetting

**Unit names and facets:**

| Facet | Units allowed |
|---|---|
| `strata` | any unit except `ledger:`, `gate:`, `aide:`, `journal:`, `loom:` prefixes |
| `ledger` | `ledger:<human>:<YYYY-MM>` (protocols §13.4; `_system` and `_cluster` receipts are not sealed, so there are no `ledger:_system:` units) |
| `gate` | `gate:<…>` |
| `aide` | `aide:<…>` |
| `journal` | `journal:<…>` (crash-dump and log-segment units, journal spec) |
| `loom` | `loom:<owner>:<wf-…>` and `loom:_system:<wf-…>` (one history unit per durable workflow, protocols §20.25) |

The owner is the human named in the unit (`<owner>:<…>` for strata units, the second component for `ledger:`, `gate:`, `aide:`, `journal:` and `loom:` units; a second component of `_system` means system-owned). Human-owned units are wrapped under `K_user` and require the human unlocked, **except** `ledger:`, `gate:`, `aide:`, `journal:` and `loom:` units, which are wrapped under `K_sys` so system services can write while the human is locked. They are forgettable all the same. Guest units live in memory only (§4.12). The payload units `gate` uses for workflow effects, `gate:<owner>:<wf-…>` (protocols §20.25), fall under the `gate:` rule.

**Lock policy is not key wrapping.** A `K_sys`-wrapped unit is served while its owner is locked; wrapping decides only who can unwrap a key, never whether work may run. Owner-lock policies that must hold while a human is locked are enforced by the service that runs the work: for durable workflows `loom` pauses user-owned workflows while the owner is locked unless they were enrolled with `runWhileLocked` (protocols §20.25), while still being able to record outcomes of in-flight operations under its `K_sys`-wrapped unit. The vault neither knows nor enforces that policy.

`forget(unit)`:
1. Delete the unit row, insert a tombstone `{unit, forgottenAt}`.
2. Advance the floor (§4.9).
3. Write `secret.delete{unit}`.
4. Schedule epoch rotation within `epochRotationMaxDelaySecs`.
5. Return. From now on the key is never served (`dataKey` → `kl:revoked`); cryptographic **erasure** is reported separately (§4.5.1 "Forget completion").

`dataKey` on a forgotten unit fails `kl:revoked`. Forgotten units and deleted items and users are tombstoned for 30 days; a deleted user's name is tombstoned too, so `dataKey` for any unit of a deleted user is `kl:revoked` until `createUser` reuses the name. A unit name cannot be reused for 30 days.

#### 4.5.1 Epoch rotation

The epoch key lives in one of two NV indices, `0x01300110` (vault-epoch/0) and `0x01300111` (vault-epoch/1), alternating active and candidate roles (protocols §19.6, E28). Two separate indices are required: the TPM architecture allows an interrupted NV write to invalidate the index being written while other indices survive (TCG TPM 2.0 Part 1, §37.7.1), so the active key is never the one being written. An index holding an **all-zero key** is erased.

`vault.db` table `meta` holds `epoch` (e), `active` (0 or 1), `activeDigest` (`SHA-256(KE ‖ u64_be(e))`) and `floor`. Table `rotation` holds at most one record:

```
rotation = {txn: ULID, fromEpoch: e, toEpoch: e+1, activeIndex: <candidate index>, previousIndex: <old active>,
            floorTarget: n+1, contentDigest: SHA-256(KE' ‖ u64_be(e+1)), phase: "committed",
            mac: HMAC-SHA256(HKDF(KE', salt = "keylos-vault-rotation/1", info = txn), JCS(record without mac))}
```

The MAC binds the record (transaction ID, epochs, floor target and NV content digest) to the candidate key itself, so a record that does not belong to the NV content fails verification.

```
rotate():                                     (one rotation at a time; serialized with every security-set mutation, REQ-VAULT-005)
  e := meta.epoch; A := meta.active; B := 1 − A; KE := current; n := meta.floor
  1. require rotation table empty and index B erased or never written (an index is reused only after its erase completed)
  2. KE' := random32; TPM2_NV_Write(B, KE' ‖ u64_be(e+1)); TPM2_NV_Read(B) and compare   (failure → abort, B stays candidate)
  3. begin transaction
       for row in items ∪ units ∪ slots ∪ pending where epoch == e and not tombstoned:
         slot rows: re-wrap the outer layer (§4.1) e → e+1           (no factor needed; locked users included)
         system-owned, ledger:/gate:/aide:/journal:/loom: units, rows of unlocked humans: re-wrap e → e+1
         rows of a locked human u: mark pending_user (they stay wrapped under K_user(e))
         pending entries PW_u of earlier epochs: re-wrap like system rows
       for each locked human u with newly pending rows:
         PW_u(e) := AEAD(key = HKDF(KE', "keylos-vault-pending|u"), plaintext = KE_u(e), aad = u ‖ u64_be(e))   (table pending)
       meta.epoch := e+1; meta.active := B; meta.activeDigest := SHA-256(KE' ‖ u64_be(e+1)); meta.floor := n+1
       insert rotation record (phase "committed", MAC as above)
     commit (SQLite WAL, synchronous=FULL)
  4. TPM2_NV_Increment(0x01300104)                                  (floor; §4.9)
  5. TPM2_NV_Write(A, 0^32 ‖ u64_be(e)); TPM2_NV_Read(A) == zero key, or A unreadable after an interrupted write → erased
     zeroize KE in memory; delete the rotation record (commit); write secret.delete{erased: [units], epoch: e} for the
     forgets this rotation completes (Forget completion, below)
on next unlock of u: unwrap PW_u(·) (newest first, chaining KE_u of each missed epoch), re-wrap u's pending rows under
  the current epoch, delete PW_u entries, advance floor; schedule a rotation if u had pending forgets
```

All NV writes are idempotent: after a lost acknowledgment the same content is rewritten and verified by read-back. The highest epoch found in NV is never selected blindly: the candidate may hold a key whose database transaction never committed.

**Startup reconciliation** (after the floor checks of §4.9, before serving any request):

| `rotation` record | Active index (`meta.active`) | Previous / other index | Meaning | Action |
|---|---|---|---|---|
| none | content digest = `meta.activeDigest` | erased, never written, or any content | Normal (other index may hold a candidate from a crash between steps 2 and 3, never referenced) | Start; erase a non-zero other index before reuse |
| none | digest mismatch, unreadable or index absent | any | Active key lost or tampered | Locked-system mode (`epoch-mismatch`); `vault restore` |
| committed, MAC verifies | digest = `contentDigest` | holds the old key | Crash after commit (step 3), before or during floor/erase | Finish step 4 per §4.9 (`db.floor == nv + 1` → increment), then step 5; start |
| committed, MAC verifies | digest = `contentDigest` | erased or unreadable (interrupted erase) | Crash during or after erase | Treat as erased; delete the record; write the completion receipt; start |
| committed | digest mismatch or unreadable | any | Candidate was verified before commit, so this is corruption or tampering | Locked-system mode (`epoch-mismatch`) |
| committed, MAC fails | any | any | Record does not belong to the NV content | Locked-system mode (`rotation-record-invalid`) |
| any | both epoch indices absent | — | TPM cleared | Locked-system mode; re-provisioning through `vault restore` (§4.9) |
| any | either index absent while the other is present | — | Index undefined outside the vault | Locked-system mode; the owner re-provisions with `vault restore` |

A **stale `vault.db`** (restored copy) is caught first by the floor (`db.floor < nv`, §4.9); if a stale copy names an epoch whose index was since erased, the active-digest check fails as well. Missing trusted floor or epoch state is never reconstructed from ordinary disk state.

**Forget completion.** `forget` returns once the tombstone is committed (the key is no longer served). The vault reports **cryptographic erasure** of a unit (receipt `secret.delete{erased: [...], epoch}`, `vault status` `pendingForgets`) only after step 5 of a rotation whose step 3 ran after the forget. Exceptions, which are the only places an old epoch-derived key survives:
- rows of a human locked at rotation time survive under `KE_u(e)` inside `PW_u(e)` until that human's next unlock; because old database blocks may still hold `PW_u(e)` wrapped under the then-current key, erasure of that human's forgotten units is reported only after the first rotation following the unlock ("forgetting your own data completes after you next unlock");
- a forget whose rotation is interrupted stays pending (rotation record or scheduled rotation), never reported complete;
- if a locked user has no other rows at the rotating epoch, no `PW_u` is created and the forget completes at once;
- deleting a user creates no `PW_u`, so destruction completes with the rotation.

**Erasure scope.** Erasing an epoch key destroys every local copy wrapped under it (old btrfs blocks, `/keystore` remnants, local backups made before the rotation). It cannot erase keys already delivered to callers, nor backups exported with `vault backup` (encrypted to the recovery recipient and independently decryptable with the recovery key); `vault backup` warns about this and the vault deletes and rewrites its own daily local backups after a forget (§4.8).

**Guarantee.** After a completed rotation a forgotten unit's DEK is unrecoverable from any retained disk, journal, snapshot or TPM artifact within the threat model: its wrap was deleted, surviving copies are wrapped under keys derived from KE(e), and KE(e) has been erased from the TPM. Consequences:
- Destruction is immediate for system units, for `ledger:`/`gate:`/`aide:`/`journal:`/`loom:` units, and for units of users unlocked at rotation time.
- A forget of a locked user's own unit completes per the exceptions above.

**NV wear.** Rotations happen at most once per `epochRotationMaxDelaySecs` and only when forgets are pending; each costs two NV writes (candidate, erase) and one floor increment: under 18 000 epoch-index writes per year in the worst case, spread over two indices. The vault refuses rotation more often than every 60 s.

### 4.6 SSH agent

**Socket.** One server per `sshAgent()` call, bound to the caller principal, backed by a socketpair.

**Messages:** `REQUEST_IDENTITIES` (keys of `ssh-key` and `tpm-p256` items whose ACL allows the principal `use`), `SIGN_REQUEST`, `EXTENSION session-bind@openssh.com` (the vault verifies the host-key signature and records the destination host key and `is_forwarding`). Everything else → `SSH_AGENT_FAILURE`.

**Host policy** (`attrs.ssh`):

```json
{"hosts":[{"hostKey":"SHA256:…","pattern":"github.com"}],"newHost":"prompt|deny|allow","forwarding":"deny|prompt"}
```

- A sign request without a preceding session-bind is host `unknown`: `prompt` for humans.
- `is_forwarding = 1` binds are checked when they arrive: refused unless the default policy or some visible key's policy has `forwarding: prompt`; the per-key policy and the presence prompt apply at sign time.
- Agents never get an SSH agent socket from the vault. Agent SSH goes through `gate` (`ShimEndpoint.sshAgent`), which obtains the key through injection (§4.7) for host keys listed in the item's policy; new hosts for agents are decided by `gate` with the broker.

### 4.7 Injection handles

From `gate`'s side:
1. `gate` verifies the subject's token (`right("secret", name, "use")` and the `net` right for the host) with the broker.
2. `gate` calls `inject(name, target)` on facet `gate`, naming the subject in `for=` and the token root in `root=`.
3. The vault checks: the item ACL allows `use` for the `for=` principal's pattern; the item kind is injectable; the target host is in `attrs.injectHosts` (default empty, so injection is denied until the owner sets hosts with presence `vault.inject-hosts`); for `ssh`, `hostkey` is listed in the item's SSH host policy.
4. The vault generates a handle (returned as the raw 32 bytes; redeemed in lowercase hex) and records `{handle → item, host, hostkey, for, root, expires: +60 s}`.
5. `gate` calls `open("inject:<hex handle>", purpose = "")` on facet `gate`. The vault consumes the handle and returns the delivery fd.
6. `gate` forms the request (header injection, SigV4 signing, or SSH signing) and zeroizes the value.

Receipt: `secret.open{op: "inject", for, host, root}`.

### 4.8 Recovery and escrow

**Owner recovery key.** The installer generates the 32-byte recovery secret and shows it once in the text form of protocols §20.21 (eight CRC-checked hex groups). The vault's recovery identity is the recovery recipient (§2.3 note 6); its 32-byte raw X25519 public key is `/var/lib/keylos/recovery/recipient.pub`, written by the installer (protocols §10.7). The secret and the recipient's private key are never stored on the machine.

**Recovery slot.** At creation the vault draws a random 32-byte `r`, sets `factor_secret = r`, wraps KU with the normal slot rule (§4.1) and stores `enc ‖ ct = HPKE.Seal(pk = recipient, info = "keylos-recovery-copy/1:vault-slot:<user>", aad = "", pt = r)` (protocols §4: mode base, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM) in the slot, then zeroizes `r`. Unlocking: `hearth`'s recovery flow checks the CRC groups, derives the recipient private key with HKDF info `"keylos-recovery-recipient/1"`, opens the slot's HPKE ciphertext (fetched with `VaultUsers.slots`, whose entry for a recovery slot is `{"slotId", "kind": "recovery", "suite": "x25519-hkdf-sha256/hkdf-sha256/aes-256-gcm", "info": "keylos-recovery-copy/1:vault-slot:<user>", "enc": "<base64>", "ct": "<base64>"}`, so `hearth` needs no vault-specific constants), and passes `r` as the factor in a delivery-format fd. The recovery secret never reaches the vault; the vault only ever sees `r`. Because the slot wrap also depends on KE_u (§4.1), an epoch rotation still destroys forgotten recovery slots.

**Backup** (`vault backup --out FILE`, presence `vault.backup`): a file `keylos-vault-backup/1` = magic ‖ HPKE `enc` ‖ AES-256-GCM stream (64 KiB chunks, STREAM construction: nonce `0^7 ‖ u32_be(i) ‖ last-flag byte`, empty AAD) whose content key is the 32-byte HPKE export secret (setup `info = "keylos-vault-backup/1"`, exporter context `"keylos-vault-backup/1"`) for the recovery recipient containing a JSON stream of items (decrypted values) and units (raw keys) for the system and every unlocked user, excluding tombstones. Locked users' items are included wrapped: their slot records plus `KE_u(e)` encrypted to the recovery recipient, restorable only with that user's factor or the recovery code.

**Restore** (`vault restore --in FILE`, presence `vault.restore` and the recovery code, given as 32 raw bytes or its protocols §20.21 text form and checked against `recipient.pub`): re-creates items and units under the current epoch and advances the floor. Exported backups are outside the erasure guarantee of §4.5.1.

**Daily local backups** (`/keystore/vault/backup/<date>.kvb`, kept 7 days, same format, encrypted to the recovery recipient). After a forget the vault deletes daily backups containing that unit and rewrites the newest one.

### 4.9 Keystore floor

`vault.db` has a `meta` row `floor`. NV `0x01300104` is a counter.

- **Write order:** commit the DB transaction with `floor = n+1`, then `TPM2_NV_Increment(0x01300104)`.
- **Startup:**

| Condition | Meaning | Action |
|---|---|---|
| `db.floor == nv` | Normal | Start |
| `db.floor == nv + 1` | Crash between commit and increment | Increment NV, start |
| `db.floor < nv` | `/keystore/vault` rolled back to an older copy | Locked-system mode (§7) |
| `db.floor > nv + 1` | NV index replaced | Locked-system mode |
| NV index absent (TPM cleared) | TPM reset | Locked-system mode; re-provisioning is part of `vault restore` (below) |

**Counter reads** use the public `PolicyCommandCode(NV_Read)` branch (§2.3 note 5); an uninitialised counter is a genesis value.

**Re-provisioning.** After a TPM clear (and on `vault restore`, which runs with presence and the recovery key), the vault calls `HearthTpm.defineSpace` for `0x01300104`, `0x01300110` and `0x01300111` on `hearth#tpm`; `hearth` defines the indices from the registry templates (protocols §19.6) and writes fresh sealed authValues to `/var/lib/keylos/tpm/nv-auth/`. The vault then writes a new epoch key to `0x01300110` (active), leaves `0x01300111` erased, re-wraps the restored rows under it, and sets `db.floor` to the new NV counter value.

**Rollback acceptance.** In locked-system mode after `rollback-detected` the owner may adopt the current database instead of restoring: `vault rollback-accept` (`VaultCli.acceptRollback`, presence `vault.rollback-accept`) re-anchors `db.floor` to the NV value and writes `secret.store{rollbackAccepted: true}`.

### 4.10 Import

| Command | Source | Mechanism |
|---|---|---|
| `vault import secret-service` | GNOME Keyring / KWallet | `compat` runs `io.keylos.vault-import` in a legacy-tier D-Bus island containing only the keyring daemon, against the user's old keyring files granted read-only through the powerbox. The helper unlocks the collection when the user types the old password into the island's prompt (rendered by `atrium`, marked legacy) and stores records with `Vault.store` on facet `adapter`, which presence-prompts once per connection; the importing human is the peer principal's human and imported items get the ACL `shell` |
| `vault import pass <dir>` | `pass` store | Directory granted through the powerbox; decryption in a workbench (`gpg`), records piped out to the CLI, stored on facet `app`/`admin` |
| `vault import ssh <file>…` | OpenSSH private keys | Encrypted keys prompt for the passphrase on the trusted path |
| `vault import file <file> --kind K --name N` | `~/.aws/credentials`, `.netrc`, Docker, npm, PyPI configs, `.env` | Parsed per kind (`aws`, `netrc`, `docker-config`, `npmrc`, `pypirc`, `env`) |

After a successful import the CLI offers `--shred-source`: overwrite with random data, `fsync`, unlink, and a warning that snapshots may retain copies, with an offer to `strata forget` the containing snapshot set.

### 4.11 First boot

1. `vaultd` reads `/var/lib/keylos/firstboot/bundle.json` (through its mount view, read-only) and takes the `vault` and `machine.machineKey` parts.
2. For each item: open `value` with HPKE (protocols §4: mode base, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM; `enc ‖ ct` layout and `info = "keylos-firstboot/1|<item name>"` per the installer spec). The KEM decapsulation computes the shared point with `TPM2_ECDH_ZGen` on `0x81000103`, which never leaves the TPM. Store each value as a `_system` item: bundle kind `wifi-psk` becomes item kind `wifi` with ACL `service:net` (`read`, `use`); other known kinds keep their kind with an empty actor list; unknown kinds become `opaque`. HPKE AAD is empty.
3. Create the epoch key NV contents and the floor (if the installer left them at genesis values), seal KS.
4. Zeroize the decrypted values, then mark its part done by creating `/var/lib/keylos/firstboot/done/vault` (the only writable path of that directory in the vault's view).
5. Call `HearthTpm.evict(0x81000103)` on `hearth#tpm` (no presence is required for this handle, protocols §7.5.3) and verify its absence (REQ-VAULT-043).


### 4.12 Guests

- `hearth` creates a guest with `VaultUsers.createUser("guest-<id>", [])`. The vault generates KU in `memfd_secret` memory and marks the user `ephemeral`. Items and units of the guest are kept in in-memory tables only; `dataKey` for a guest unit (for example `strata`'s ephemeral home unit) returns a key that exists only in memory.
- `unlockUser`/`addSlot` for a guest fail `kl:invalid` (there are no slots). `lockUser` of a guest behaves as `deleteUser` (a locked guest session cannot be resumed).
- At logout `hearth` calls `deleteUser`; the vault zeroizes and drops everything of the guest and writes `secret.delete{user: "guest-…", ephemeral: true}`. No floor advance and no epoch rotation are needed, because nothing of the guest was persisted.
- Guests never receive `prompt: presence` items and never get `sshAgent` with TPM keys; the broker refuses presence-class grants for them (protocols §14.3).

### 4.13 Broker confirmations

```
confirm(caller, item, op):
  key := confirmations[(caller.session, item, op, attempt)] ?? "vault:" + caller.session + ":" + item + ":" + op + ":" + ULID
  persist key in confirmations (vault.db) before calling
  result := BrokerSystem.requestFor(subject = vault's own session,
              GrantRequest{resource: secret(owner + "/" + item), rights: [use], persist: false, durationSecs: 0,
                           onBehalfOf: caller.principal, reason: "<app> (<publisher>) wants to <op> \"<item>\""},
              intent = "", idempotencyKey = key, intentSession = <empty>)
  result.outcome pending → Approval.wait (the caller's vault call blocks; the vault cancels after 120 s → kl:unavailable)
  granted → verify result.mandate (service/broker signature with the key from Ledger.serviceKey("broker"); payload approval id,
            effect kind grant.secret, target secret:<owner>/<item>, digest = SHA-256 of the JCS GrantRequest JSON form
            {"resource":{"secret":"<owner>/<item>"},"rights":["use"],"reason","durationSecs":0,"persist":false,
             "onBehalfOf":<caller principal>} (protocols §14.4, E3); on failure re-fetch the broker key once)
            → proceed; cache per REQ-VAULT-032; receipt secret.open{…, confirmation: approvalId}
  denied  → kl:denied
```

The vault discards the token in the outcome (it holds no authority the vault needs); only the decision matters. Because the subject is the vault's own session, the broker's Rule-of-Two and label logic do not apply to the caller; the vault's ACL remains the authorization, and the confirmation is an additional human check.

---

## 5. Interfaces

### 5.1 Facets

| Facet | Holders | Methods |
|---|---|---|
| `app` | Apps (per `needs.secrets`), `shell`, legacy, `bench-relay` (for its VM principal) | `open`, `store`, `delete`, `list`, `sign`, `sshAgent` (own items). `bench-relay` runs inside the VM principal's cgroup (`VmSpawn.spawnVmm`, protocols §7.5.1), so its connection identifies as that VM principal and items are owned by it (REQ-VAULT-027) |
| `admin` | Owner `shell` | All `app` methods incl. ACL updates (`store` with `value.index = 0xFFFF`) |
| `broker` | broker | `open` on behalf (§4.4) |
| `gate` | gate | `inject`, `open("inject:…")`, `dataKey`/`forget` for `gate:` units |
| `strata` | strata | `dataKey`, `forget` (§4.5 unit rules) |
| `ledger` | ledger | `dataKey`, `forget` for `ledger:` units |
| `aide` | aide | `store`/`delete`/`sign` of session keys (kind `ed25519-key`, `attrs.sessionKey`); `dataKey`/`forget` for `aide:` units |
| `hearth` | hearth | `VaultUsers` |
| `net` | net | `open`/`store` of `_system` items of kinds `wifi` and `token` |
| `adapter` | compat | `store` on the human's behalf with a presence prompt per import |
| `journal` | journal | `dataKey`, `forget` for `journal:` units |
| `loom` | loom | `dataKey`, `forget` for `loom:` units |

A facet not in this table fails `kl:invalid` at `ServiceHost.accept` (warden never routes one).

### 5.2 Repo-local interface (`vault` CLI only)

File ID `0xb6f20c4e81d37a21`, via `Extensible.ext` on `app` and `admin`:

```capnp
@0xb6f20c4e81d37a21;
using C = import "common.capnp";

interface VaultCli {
  setInjectHosts @0 (name :Text, hosts :List(Text), presenceEnvelope :Data) -> ();   # admin
  setSshPolicy   @1 (name :Text, policyJson :Text) -> ();                             # owner of the item
  backup         @2 (out :C.Fd, presenceEnvelope :Data) -> ();                        # admin
  restore        @3 (inp :C.Fd, recovery :C.Fd, presenceEnvelope :Data) -> ();         # admin
  status         @4 () -> (json :Text);
  rotate         @5 (presenceEnvelope :Data) -> ();                                   # admin
  importRecords  @6 (records :C.Fd, kind :Text) -> (count :UInt32);                   # CLI-side importers
  acceptRollback @7 (presenceEnvelope :Data) -> ();                                   # admin: adopt the current DB after rollback-detected (§4.9)
}
```

`status` returns JCS JSON `{"epoch", "activeIndex", "rotationPhase", "lastRotation", "rotationDue", "nvWrites", "floor", "nvFloor", "lockedUsers", "unlockedUsers", "pendingForgets", "pendingUnlockForgets", "locked", "problems": [...], "metrics"}`; `problems` include `rollback-detected`, `epoch-mismatch`, `rotation-record-invalid`, `recovery-recipient-missing`, `seed-key-present`. `restore`'s `recovery` fd carries the recovery secret as 32 raw bytes or its §20.21 text form.

### 5.3 CLI: `vault`

| Command | Description | Exit |
|---|---|---|
| `vault list` | Items visible to the caller | 0 |
| `vault get <name> [--to-fd N]` | Write the value to fd N, or to stdout only if stdout is not a terminal (otherwise refuse) | 0, 1 not found, 3 denied |
| `vault set <name> --kind K [--from-fd N | --prompt]` | Store an item; `--prompt` asks on the trusted path | 0, 3 |
| `vault rm <name>` | Delete | 0, 1, 3 |
| `vault acl <name> [--add PATTERN:ops[:prompt]] [--remove PATTERN]` | Edit the ACL. `ItemAcl` has one ops list and one prompt per item: `--add` adds the pattern, unions `ops` and sets the item-wide prompt; `agent:` patterns only ever match op `use` | 0, 3 |
| `vault inject-hosts <name> --add host…|--remove host…` | Injection hosts (presence). The CLI sends entries prefixed `+`/`-` to `setInjectHosts` to edit the current list; plain entries replace it | 0, 3 |
| `vault ssh-policy <name> …` | SSH host policy | 0, 3 |
| `vault sign <name> --alg A --in FILE` | Sign | 0, 3 |
| `vault import …` | §4.10 | 0, 2 |
| `vault backup --out FILE`, `vault restore --in FILE` | §4.8 | 0, 3 |
| `vault status` | Epoch, last rotation, NV writes, floor, locked users, pending forgets | 0 |
| `vault rotate` | Force an epoch rotation (presence) | 0 |
| `vault rollback-accept` | Adopt the current DB after `rollback-detected` (presence, §4.9) | 0, 3 |

### 5.4 Files

```
/keystore/vault/
  vault.db           SQLite (WAL, synchronous=FULL): items, units, tombstones, slots, pending, rotation,
                     meta(floor, epoch, active, activeDigest); also the `confirmations` table (§4.13)
  system.sealed      TPM2B_PRIVATE ‖ TPM2B_PUBLIC of the KS sealed object
  service-key.sealed the vault's service/vault writer key (§2.3 note 8)
  rotation.log       append-only {epoch, time, reason, forgottenUnits}
  backup/<date>.kvb  daily local backups (keylos-vault-backup/1)

/var/lib/keylos/tpm/nv-auth/0x01300104.sealed, 0x01300110.sealed, 0x01300111.sealed   (read-only for the vault; protocols §10.7)

/var/lib/keylos/recovery/recipient.pub   recovery recipient public key (read-only for the vault; protocols §10.7)
```

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| A same-user app reads another app's secrets (the Secret Service weakness) | ACLs bound to generation identity; no session bus; per-app dynamic UIDs |
| Secret leaks through env or argv | Values only through delivery fds; `warden` rejects env names matching `secretEnvPatterns` |
| An agent exfiltrates credentials | Agents never get values (injection and signing only, through `gate`); injection hosts allowlisted; every use receipted |
| Disk theft | Every wrap involves TPM-held keys; LUKS2 underneath |
| Rollback of `/keystore` to resurrect a deleted item or old ACL | Keystore floor counter (§4.9) |
| Forgotten data recovered from snapshots or old blocks | Epoch rotation destroys KE in TPM NV |
| SSH agent forwarding abuse | session-bind checks; forwarding denied by default |
| Prompt spoofing | Presence prompts are rendered on `atrium`'s trusted path by `hearth`; confirmations are broker approvals on the same trusted path; the vault verifies the broker's re-signed mandate |
| Replayed confirmation | Mandates bind the approval ID and the digest of the exact `GrantRequest`; idempotency keys are per attempt |
| First-boot seed key reuse | `0x81000103` evicted right after import (REQ-VAULT-042/043) |
| Memory scraping by root | `memfd_secret`; `PR_SET_DUMPABLE 0`; runtime kernel compromise is out of scope |

### 6.2 Confinement of `vaultd`

| Property | Value |
|---|---|
| Tier | t0 |
| Namespaces | mount, pid, ipc, uts, cgroup, net (`lo` only) |
| Mount view | Vault generation; `/keystore/vault` (rw); `/etc/keylos/strata/snapshot-exclude.list` (ro); `/var/lib/keylos/tpm/nv-auth/0x01300104.sealed`, `0x01300110.sealed`, `0x01300111.sealed` (ro); `/var/lib/keylos/recovery/recipient.pub` (ro); `/run/keylos/boot` (ro); `/var/lib/keylos/firstboot` (ro, first boot only; `done/` rw); `/proc` subset |
| Capabilities | None |
| Devices | `/dev/tpmrm0` fd from `warden` (`KEYLOS_TPM_FD`, protocols §10.5) |
| seccomp additions | `memfd_secret`, `memfd_create`, `mlock`, `munlock`, `madvise` |
| Landlock | rw on `/keystore/vault` only |
| Routes held | `ledger#writer`, `hearth#presence`, `hearth#tpm`, `broker#system`, `depot#user` |

### 6.3 Residual risks

- While a human is unlocked, a kernel or tier-0 compromise can use their secrets.
- Values delivered to apps live in the app's memory; ACLs limit which apps receive them.
- Forgetting your own data while locked completes at the next unlock (§4.5.1).
- `perSession`/`always` confirmations are T2 broker approvals: a click on the trusted path, not a touch. Items that need physical presence must use `prompt: presence`.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| KS unseal fails (PCR or volume mismatch) | **Locked-system mode:** `_system` items unavailable (`net` cannot use stored Wi-Fi credentials); user slots still unlock if the epoch key is readable; critical notification via `hearth`. Recovery: boot the recovery entry and re-seal after the owner's presence and recovery code (installer recovery flow) |
| Active NV epoch index unreadable or not matching `meta.activeDigest` | Locked-system mode (`epoch-mismatch`), and user slots unusable. Restore from backup with the recovery code (§4.5.1 reconciliation) |
| Crash or power loss at any rotation step | Reconciled at start per the §4.5.1 table; no committed row ever depends on a key that exists only in memory or `FdStore` |
| Interrupted NV write of the candidate | The candidate index may be invalid; the active index is untouched; the rotation is retried |
| Keystore floor mismatch (§4.9) | Locked-system mode; `vault status` shows `rollback-detected`; `vault restore` from the newest backup, or acknowledge with presence (`vault.rollback-accept`) to adopt the current DB and re-anchor the floor |
| `ledger` unavailable | Every operation except `lockUser` fails `kl:unavailable` (fail closed) |
| `hearth` unavailable | `presence` operations fail `kl:unavailable`; `prompt: never` items work; first-boot eviction retried at next start |
| `broker` unavailable or no trusted path (headless) | `perSession`/`always` operations fail `kl:unavailable`; on headless profiles the broker escalates them to quorum (broker spec REQ-BROKER-161) |
| `HearthTpm.defineSpace` fails during restore | Restore aborts before any row is re-wrapped; locked-system mode remains |
| `depot` unavailable | App identity lookups use the cache (generations seen this boot); unknown generations → `kl:unavailable` |
| SQLite corruption | Refuse to start; `vault restore` from the daily local backup or a recovery backup |

---

## 8. Performance budgets

| Operation | Budget (p99) |
|---|---|
| `open` (`prompt: never`) | ≤ 1.5 ms |
| `sign` Ed25519 (software) / P-256 (TPM) | ≤ 0.5 ms / ≤ 60 ms |
| SSH sign (software key) | ≤ 2 ms |
| `inject` + redeem | ≤ 1 ms |
| `dataKey` (cached unit) | ≤ 0.5 ms |
| `unlockUser` (password, Argon2id 256 MiB, t = 3) | 400–900 ms (by design) |
| Epoch rotation, 10 000 rows | ≤ 2 s |
| RSS | ≤ 48 MiB excluding Argon2 transient memory |

---

## 9. Observability

- **Receipts:** `secret.open` (`op`: open, sign, ssh-sign, inject, datakey; `confirmation` = approval ID when a broker confirmation was used), `secret.store` (with `aclChange`), `secret.delete` (with `unit` for forgets, `user` for user deletion, `unit: "tpm:0x81000103"` for the seed-key eviction).
- **Metrics** (records `0x1F`): `vault_ops_total{op,outcome}`, `vault_prompts_total{policy}`, `vault_epoch`, `vault_nv_writes_total`, `vault_floor`, `vault_pending_forgets`, `vault_locked_users`.
- **Logs:** decisions at level 6 (no item names of other humans), integrity issues at level 2.

---

## 10. Configuration

```nickel
{
  vault | {
    epochRotationMaxDelaySecs | Number | default = 3600,   # minimum 60
    argon2 | { memoryKiB | Number | default = 262144, iterations | Number | default = 3, parallelism | Number | default = 4 },
    fido2 | { requireUv | Bool | default = true },
    ssh | { defaultNewHost | [| 'prompt, 'deny, 'allow |] | default = 'prompt, forwarding | [| 'deny, 'prompt |] | default = 'deny },
    dailyBackups | { enabled | Bool | default = true, keepDays | Number | default = 7 },
    secretEnvPatterns | Array String | default = ["*_TOKEN", "*_SECRET", "*_PASSWORD", "*_KEY", "AWS_*", "GITHUB_TOKEN"],
  }
}
```

`secretEnvPatterns` is rendered into the config generation for `warden`, which rejects matching names in `SpawnSpec.env`.

---

## 11. Testing and acceptance criteria

### 11.1 Unit tests

- Key derivations (§4.1) against fixed vectors; wrap/unwrap with AAD binding.
- ACL evaluation for every actor pattern, including `sealed-by=owner` with a mocked trust set.
- Delivery format (protocols §20.10) for `memfd_secret` and the sealed-memfd fallback; `SecretBuf` zeroization.
- Floor state machine (§4.9) for each startup condition.
- Epoch rotation with locked and unlocked users; every row of the §4.5.1 reconciliation table; rotation-record MAC; nested slot wrap re-wrap without the factor; u64-BE epoch encoding vectors.
- HPKE DHKEM(P-256) decapsulation with a software stand-in for `TPM2_ECDH_ZGen` against RFC 9180 test vectors.
- Unit-prefix enforcement per facet (REQ-VAULT-024), including `journal:`.
- Confirmation idempotency key reuse and `perSession` cache expiry (REQ-VAULT-032); guest memory-only state (REQ-VAULT-050).

### 11.2 Integration tests

| ID | Scenario | Expected |
|---|---|---|
| IT-01 | App A stores an item; app B by another publisher opens it | `kl:denied` |
| IT-02 | App A updated by the same publisher | Access kept |
| IT-03 | Owner-sealed fork of A, no `sealed-by=owner` ACL entry | Denied |
| IT-04 | Agent calls `open` on `vault#app` | `kl:denied`; `secret.open{outcome: denied}` |
| IT-05 | Agent HTTP call through `gate` with an injected bearer token | Request carries the header; memory scan of the agent VM finds no token |
| IT-06 | `forget(alice:proj)` while alice is unlocked; old `/keystore` blocks restored in a lab VM without the pre-rotation TPM NV | Unrecoverable; with the captured pre-rotation NV it is recoverable (shows destruction relies on the NV overwrite) |
| IT-07 | Same forget while alice is locked | Completes at next unlock; `vault status` shows the pending forget |
| IT-08 | SSH for a human: allowed host key, then an unknown host | First OK; second presence prompt |
| IT-09 | SSH bind with `is_forwarding=1` | Refused |
| IT-10 | `memfd_secret` disabled | Sealed memfd; `delivery: memfd-sealed` |
| IT-11 | Backup, wipe `/keystore`, restore with the recovery code | Items restored; forgotten units absent |
| IT-12 | Replace `vault.db` with a copy from before an item delete | Floor mismatch → locked-system mode |
| IT-13 | `dataKey("gate:x")` on facet `strata` | `kl:denied` |
| IT-14 | First boot with a Wi-Fi item in the bundle | `_system/wifi/home` present; `net` can open it on facet `net` |
| IT-15 | Inject for `ssh://github.com#hostkey=…` with an unlisted host key | `kl:denied` |
| IT-16 | `open` of an item with `prompt: always` | `BrokerSystem.requestFor` with the vault's own session and an idempotency key; T2 prompt names the app and the item; mandate signed by `service/broker` verified; value delivered |
| IT-17 | Same as IT-16, vault restarted while the prompt is pending, caller retries | Same idempotency key reused; one prompt in total |
| IT-18 | `dataKey("journal:alice:crash-1")` on facet `journal`; on facet `ledger` | First succeeds; second `kl:denied` |
| IT-19 | First boot with an HPKE-encrypted Wi-Fi item | Item imported via `TPM2_ECDH_ZGen`; `HearthTpm.evict(0x81000103)` called; `TPM2_ReadPublic(0x81000103)` fails afterwards; `secret.delete{unit: tpm:0x81000103}` |
| IT-20 | TPM cleared, `vault restore` with presence and recovery key | `defineSpace` called for `0x01300104`, `0x01300110` and `0x01300111`; items restored; floor equals NV |
| IT-21 | Guest user: store an item, log out | Nothing written under `/keystore/vault`; after `deleteUser` the item is gone; no epoch rotation |
| IT-22 | Delete user alice | `ledger:alice:*` and `aide:alice:*` units destroyed; epoch rotated; `dataKey("ledger:alice:2026-10")` on facet `ledger` → `kl:revoked` |
| IT-23 | Ledger seals a receipt about the vault's caller while the vault waits for its own append | No deadlock; both complete within 10 ms |
| IT-24 | `createUser("bob", [password])` | Slot list contains a recovery slot holding only an HPKE ciphertext to `recipient.pub`; no input secret was supplied; `addSlot(recovery, factor fd)` → `kl:invalid` |
| IT-25 | Recovery unlock: test harness derives the recipient key from the recovery secret, opens bob's recovery slot ciphertext, passes `r` to `unlockUser` | Unlocks; the vault never received the recovery secret (fd contents equal `r`) |
| IT-26 | `recipient.pub` replaced by a different key | Recovery slot creation and `vault backup` fail `kl:unavailable`; `vault status` shows `recovery-recipient-missing` |
| IT-27 | `perSession` item opened by an app | `requestFor` carries `onBehalfOf` = the app principal and an empty `intentSession`; the returned mandate verifies against `Ledger.serviceKey("broker")`; a mandate signed by another key → `kl:integrity` |
| IT-28 | A tier-2 app VM stores an item through `bench-relay`, a second VM and the host app list items | The item is owned by the first VM principal; neither the second VM nor the host app sees it |
| IT-29 | `vault backup`, then `vault restore` with the recovery key in a fresh VM | Backup is `keylos-vault-backup/1` decryptable only with the recipient key; restore re-creates items under the current epoch |
| IT-31 | Power cut injected (swtpm + VM kill) at each boundary of §4.5.1: before/after the candidate NV write, during it (interrupted write), before/after the DB commit and its fsync, before/after the floor increment, before/during/after the erase write, and with each NV acknowledgment lost | After restart the reconciliation table is followed; every committed item and unit still opens; no state selects a convenient version; each forget is reported erased only after its erase step |
| IT-32 | Service crash (SIGKILL) and full reboot at the same boundaries, separately from IT-31 | Same outcome; no `FdStore` is used |
| IT-33 | Restore stale `vault.db` (and WAL) copies from before and after a rotation | `rollback-detected` or `epoch-mismatch`; locked-system mode; no silent re-anchoring |
| IT-34 | After a completed forget, attempt recovery with every retained artifact (old `/keystore` blocks, WAL, btrfs snapshots, daily backups, both NV indices, captured `PW_u` rows) | The forgotten unit key is not recoverable; with an exported `vault backup` it is (documented scope) |
| IT-35 | Locked user forgets a unit, unlocks, and a rotation follows | Erasure reported only after that later rotation |
| IT-36 | `createUser("guest-ab12cd34", [password])`; `createUser("bob", [password])` without a recovery SlotSpec; `addSlot` while bob is locked | `kl:invalid`; bob has no recovery slot; `kl:unavailable:user-locked` |
| IT-37 | Mandate for a `perSession` confirmation with kind `x-vault.confirm` or a wrong digest | `kl:integrity`; kind `grant.secret` with the E3 digest verifies |
| IT-38 | `dataKey("loom:alice:wf-01JB…")` on facet `loom` while alice is locked; `dataKey("aide:alice:x")` on facet `loom`; `dataKey("loom:alice:not-a-wf")` | First succeeds (same key as before the lock); second and third `kl:denied` |
| IT-39 | `forget("loom:alice:wf-01JB…")`, then `dataKey` of the same unit | `kl:revoked`; after the next rotation `secret.delete{erased: [unit]}`; the DEK is unrecoverable from `vault.db` copies (as IT-34) |
| IT-40 | Delete user alice with live `loom:alice:*` units | All destroyed (REQ-VAULT-051) |
| IT-30 | Create a recovery slot for user `alice`; open it with a reference HPKE implementation | Opens only with `info = "keylos-recovery-copy/1:vault-slot:alice"`, suite DHKEM(X25519, HKDF-SHA256)/HKDF-SHA256/AES-256-GCM, empty AAD (protocols §4, §20.2); any other `info` fails |

**Fuzzing targets:** `fuzz_acl_eval`, `fuzz_ssh_agent_protocol`, `fuzz_import_parsers` (aws, netrc, docker, npmrc, pypirc, env), `fuzz_inject_target`, `fuzz_slot_params`. 24 CPU-hours each.

**Conformance:** protocols `vectors/ids/`, `vectors/dsse/`, `vectors/presence/`, `vectors/firstboot/`, `vectors/tpm/`.

**Acceptance:** all integration tests pass; §8 budgets are met; an external review of §4.1, §4.5 and §4.9 by two cryptographers is recorded in `docs/reviews/`.

---

## 12. Implementation notes

| Crate | Use |
|---|---|
| `tss-esapi` 7 | TPM (sealed objects, NV, policies, ECDH) |
| `rusqlite` 0.32 | Storage |
| `aes-gcm` 0.10, `chacha20poly1305` 0.10, `hkdf` 0.12, `argon2` 0.5, `x25519-dalek` 2, `ed25519-dalek` 2, `p256` 0.13 | Cryptography |
| `age` 0.10 | Backups, recovery recipient |
| `ssh-key` 0.6, `ssh-encoding` 0.2 | SSH agent |
| `zeroize` 1 | Memory hygiene |
| `rustix` | `memfd_secret`, `memfd_create`, seals |

Inherited descriptors (fd 3, `KEYLOS_CAPWIRE_FDS`, `KEYLOS_TPM_FD`) are adopted with the `keylos-capwire` helper (protocols §10.5, E16). KS, KE, KU and guest values live in `memfd_secret` pages (`keylos-vault-client::secmem`, fallback `mlock` + `MADV_DONTDUMP`); short-lived derived keys (`K_sys(e)`, DEKs) are zeroized heap values.

```
vault/
  crates/vaultd/ crates/vault-cli/ crates/keylos-vault-client/ crates/vault-import-island/
  schema/vault-cli.capnp     repo-local (§5.2)
  tests/ fuzz/ generation/
```

---

## 13. Decisions and alternatives

| Decision | Alternatives | Rationale | ADR |
|---|---|---|---|
| ACLs bound to generation identity | Secret Service collections (any process on the bus) | Fixes same-user cross-app reads | [ADR-0039](../../handbook/11-decisions/adr-0039-secrets-never-in-env.md) |
| Epoch key in TPM NV for destruction | Deleting wraps only (CoW and backups keep copies) | Forget must survive snapshots and old blocks | [ADR-0032](../../handbook/11-decisions/adr-0032-crypto-shredding.md) |
| Two alternating NV epoch indices with an authenticated rotation record (ISS-001) | One index plus a volatile `FdStore` copy; an encrypted disk journal plus overwrite of the sole index | Survives power loss at every step; an interrupted NV write can only invalidate the index being written; no old-key copy under the new key | [ADR-0032](../../handbook/11-decisions/adr-0032-crypto-shredding.md) |
| Keystore floor counter | No rollback detection | Restoring an old keystore must not resurrect deleted items or ACLs | [ADR-0032](../../handbook/11-decisions/adr-0032-crypto-shredding.md) |
| Agents use secrets only through injection and signing | Delivering secrets to agent VMs | Agents are prompt-injectable; values must not reach them | [ADR-0039](../../handbook/11-decisions/adr-0039-secrets-never-in-env.md) |
| FIDO2 hmac-secret slots | Assertion-only unlock | Real key material that needs presence | [ADR-0011](../../handbook/11-decisions/adr-0011-owner-presence-fido2.md) |
| Recovery copies HPKE-encrypted to the machine's recovery recipient (protocols §20.21, `keylos-recovery-recipient/1`) | Vendor escrow; a separate vault recovery code; raw-secret recovery slots | One recovery key for the whole machine; owner-held offline; slots can be created without the secret | [ADR-0032](../../handbook/11-decisions/adr-0032-crypto-shredding.md) |
| Non-presence confirmations through the broker | Presence for every prompt (touch fatigue); a vault-owned dialog (no trusted path) | One approval path and receipt trail for all confirmations | [ADR-0028](../../handbook/11-decisions/adr-0028-approval-tiers.md) |
| HPKE over a TPM P-256 key for the first-boot seed | X25519 in the TPM (TPMs have no Curve25519) | Standard hybrid encryption the TPM can actually do | [ADR-0045](../../handbook/11-decisions/adr-0045-owner-nv-range-and-tpm-registry.md) |
| Durable-workflow history units (`loom:`) wrapped under `K_sys`, the owner-lock execution policy enforced by loom | `K_user` wrapping, so a locked owner stops workflows implicitly | Implicit pausing would also stop recording outcomes of operations already in flight, and wrapping cannot express `runWhileLocked`; an explicit policy is testable (protocols §20.25) | [ADR-0068](../../handbook/11-decisions/adr-0068-durable-workflows-loom.md) |
| Guests are memory-only | Persistent guest homes | Nothing to forget, nothing to leak after logout | [ADR-0032](../../handbook/11-decisions/adr-0032-crypto-shredding.md) |

### 13.1 Open issues against protocols

None. Resolved in protocols Appendix E (S2): vault-epoch template (E1) and second index with the power-loss-safe rotation (E28, ISS-001); nv-auth sealing policy and format (E7); TPM fd and `KEYLOS_DEV_*` (E8); slot rules and parameter encodings (E11); GrantRequest digest form for confirmation mandates (E3). The recovery recipient file and bundle field, and the structured `onBehalfOf`, raised earlier are resolved in protocols §10.7, §20.13 and §7.3.3.
