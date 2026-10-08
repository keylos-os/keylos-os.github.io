# keylos/broker — the capability broker

| | |
|---|---|
| Repository | `github.com/keylos-os/broker` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `brokerd` (tier-0 service generation `io.keylos.broker`), `grants` (CLI generation `io.keylos.grants`), crate `keylos-broker-policy` (Cedar entity builders, default policy set, policy-test runner; also used by the `config` policy compiler test suite), default policy set `policy/default/*.cedar` |
| Depends on | `keylos-protocols 1.0` (crates `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-biscuit`, `keylos-labels`, `keylos-presence`, `keylos-tpm-registry`) |
| Runtime peers | `warden` (`warden#service`, `warden#broker`: `GrantMounts`, `PrincipalControl`, `ServiceConnect`, `DebugAttach`), `ledger` (`ledger#writer`), `net` (`net#status`, for `NetWatch`), `atrium` (`atrium#approve`), `hearth` (`hearth#system`; `hearth#presence` for quorum requests on quorum machines), `gate` (`gate#broker`: `connect`, `stage`, `GateMeterAdmin`), `vault` (`vault#broker`), `devd` (`devd#broker`), `portal-files` (`portal-files#broker`), `fleet` (`fleet#decider`, fleet-enrolled machines only), `classifier` (`classifier#broker`, optional), `depot` (`depot#user`, granted by the distribution default policy) |
| Provides | `Broker` (protocols §7.3.3) on facet `principal`; `BrokerSystem` and `LabelAuthority` (protocols §7.5.2) on facets `system` and `label-authority`; `BrokerWorkflow` (protocols §7.5.25) on facet `workflow`; session labels; Rule-of-Two enforcement; the persistent grant store (`keylos.grant/1`); durable workflow records (`keylos.workflow-grant/1`) and durable decision records (`keylos.decision/1`) |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as described in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

The broker is the single place where authority is created in keylos. Every capability any principal holds is either:

- a token the broker minted, or
- a handle (an fd, a socket or a capability) that the broker materialized from such a token.

The broker:

1. **Identifies** callers. Identity comes from capwire peer identity delivered by `warden`, never from claims inside messages.
2. **Decides** requests by evaluating the active **Cedar policy generation** (protocols §16). Tier annotations turn a permit into "permit after approval".
3. **Obtains approvals** on the trusted path through `atrium`'s `TrustedPrompt.approve`; for `@orgApproval` permits through `fleet`'s `OrgDecider`.
4. **Mints** Biscuit v3 tokens using the protocols §8 vocabulary. Root keys are generated per boot and never written to persistent storage.
5. **Materializes** tokens into kernel-enforced handles: files through `openat2` from held root directory fds, directories through `warden`'s `GrantMounts`, network sockets through `gate`, devices through `devd`, secrets through `vault`, and service capabilities through `warden`'s `ServiceConnect`.
6. **Tracks session labels**, serves the **label authority** for other tier-0 services, and **enforces the Rule of Two** (protocols §14.1), including declassification approvals and flow-proof acceptance.
7. **Attenuates and delegates** authority to child principals, enforcing depth and fan-out.
8. **Revokes** authority, cascading through the delegation tree and terminating or freezing holders through `warden`'s `PrincipalControl`.
9. **Persists grants** across boots as grant records, re-minting them on each boot after re-evaluating policy.
10. **Writes receipts** for every authority event to `ledger`.
11. **Keeps the authority side of durable workflows** (protocols §20.25): the workflow record of every enrolled workflow (approved scope, ownership epoch, label high-water mark, budget account, cancellation), the claims that fence stale attempts, fresh attempt authority minted at attempt registration after re-evaluating current policy, durable decisions that survive restarts and reboots and are rebound explicitly to fresh attempts, current authority for every workflow effect (`authorizeEffect`), and the durable workflow-level cancellation and revocation record.

**Non-goals**

- The broker does not proxy data. File I/O, network bytes and secret bytes never pass through it.
- The broker does not stage or commit effects. That is `gate`; the broker only decides approvals for them (`checkFlow`, `requestFor`).
- The broker does not render prompts. That is `atrium`.
- The broker does not store secrets. That is `vault`.
- The broker does not choose confinement tiers at spawn. That is `warden`; the broker only supplies `tier_floor` facts.
- There is no second policy language. Policy is Cedar plus the annotations of protocols §16.2.
- The broker does not orchestrate workflows, schedule steps or store workflow history. That is `loom`; the broker trusts `loom` only for the identity of the next claim, and re-decides every attempt and every effect itself.
- Boot-scoped authority is not relaxed for workflows: root keys, tokens and `a-…` prompt IDs still never outlive their boot. Only records of approved scope and decisions persist.

---

## 2. Context and embedded contracts

### 2.1 Position in the system

```
         principals (apps, shell, legacy, VM principals via bench, agents via aide)
                 │ capwire route broker#principal
                 ▼
 warden ◄────── brokerd ──────► ledger#writer (receipts)
 (warden#broker:  │   │ └──────► atrium#approve (TrustedPrompt.approve)
  GrantMounts,    │   └────────► fleet#decider (OrgDecider, org approvals)
  PrincipalControl,├───────────► gate#broker (connect for the token holder)
  ServiceConnect; ├───────────► vault#broker (open on behalf)
  warden#service: ├───────────► devd#broker (open, DeviceAdmin)
  FdStore)        ├───────────► portal-files#broker (FilePicker.pick)
                  ├───────────► hearth#system (owner registry, sessions)
                  └───────────► depot#user (generation metadata), classifier#broker (optional)
 broker#system ◄── warden, gate, aide, atrium, config, hearth, strata, net, depot, vault, vouch, cri
 broker#label-authority ◄── gate, bench, portal-*, atrium, strata, aide, journal, warden
 broker#workflow ◄── loom (enroll, claim, decide, rebind, resume, cancel, record, raise), gate (authorizeEffect, verify),
                     aide (offer, verify, decide, rebind), strata, bench (verify, record)
                  ├───────────► gate#broker (WorkflowBudget.open, close, status: workflow budget accounts)
                  ├───────────► gate#broker (GateMeterAdmin: hard budget sub-meters)
                  └───────────► hearth#presence (HearthQuorum, quorum machines)
```

`brokerd` is a tier-0 service started by `warden` immediately after `ledger`. It needs `ledger` to write receipts and refuses to create authority without it (REQ-BROKER-091).

### 2.2 Embedded contracts (verbatim from `keylos-protocols 1.0.0`)

The following blocks are copied mechanically from `protocols/spec.md`. If anything here disagrees with protocols, protocols wins.

#### 2.2.1 Identifiers and signed documents

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

<!-- BEGIN protocols §7.3.7 (verbatim) -->
> **protocols 7.3.7 `gate.capnp`**

```capnp
@0xc7a1e5d3b2f40007;
using C = import "common.capnp";
using B = import "broker.capnp";

enum EffectClass { reversible @0; compensable @1; irreversible @2; }

struct EffectArg { name @0 :Text; value @1 :Text; source @2 :Text; label @3 :C.Label; }

struct EffectIntent {
  kind        @0 :Text;            # registered effect kind, protocols §14.2
  class       @1 :EffectClass;
  target      @2 :Text;            # e.g. "smtp:mail.example.com", "https://api.github.com/repos/o/r/pulls"
  args        @3 :List(EffectArg);
  idempotencyKey @4 :Text;
  compensator @5 :Text;            # registered compensator kind, empty if none
  payload     @6 :C.Fd;            # full request body / message
}

struct IntentStatus {
  id     @0 :Text;
  state  @1 :State;
  result @2 :Text;
  receipt @3 :Text;                # rcpt ref
  enum State { staged @0; approved @1; committed @2; failed @3; canceled @4; compensated @5; }
}

interface Intent {
  status   @0 () -> (status :IntentStatus);
  dryRun   @1 () -> (rendered :List(Text));
  commit   @2 () -> (status :IntentStatus);          # may throw kl:needs-approval
  cancel   @3 () -> ();
  compensate @4 () -> (status :IntentStatus);
}

interface Gate {
  connect   @0 (target :B.NetTarget, token :C.Token) -> (socket :C.Fd);   # proxied, policy-checked stream; target.host "listen:<addr>" returns a listening socket
  stage     @1 (intent :EffectIntent) -> (intent :Intent);
  intents   @2 (session :C.SessionId) -> (list :List(IntentStatus));
      #! facet client: the named session MUST be the caller's own session or a descendant; returns intents of that session
      #! and all its descendant sessions, recursively
  meter     @3 (rootId :Data) -> (spent :List(B.Budget), remaining :List(B.Budget));
  charge    @4 (rootId :Data, amount :B.Budget, reason :Text) -> ();      # facet meter only
  intent    @5 (id :Text) -> (intent :Intent);
      #! facet client: only intents staged by the caller's session or its descendants (kish `effects` commit/cancel)
}
```

**Terminated HTTP mode.** For `https` grants that need method filtering or credential injection, a native client does not get an end-to-end TLS stream: `connect` returns a socket on which the client speaks **plain HTTP/1.1** to `gate`, which terminates the request, applies method checks and credential injection, and performs TLS to the real host itself. Clients detect this from the token's `net` fact (`$method` ≠ `"*"`). Legacy and VM clients use the TLS-interception path instead (§9.4). SDKs MUST support the terminated mode.

**Acting for a subject.** On facet `aide`, `stage` acts for the agent session whose token is carried in the intent arg `x-subject-token` (base64 Biscuit); `gate` stages for that token's `principal` after verifying `right("effect", kind, "stage")`. On facet `broker`, `connect` acts for the token's `principal`. On every other facet the subject is the caller.
<!-- END protocols §7.3.7 -->

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

<!-- BEGIN protocols §7.5.8 (verbatim) -->
> **protocols 7.5.8 `devd-sys.capnp`**

```capnp
@0xc7a1e5d3b2f40027;
using C = import "common.capnp";

struct NodePlan {
  id @0 :Text; name @1 :Text; kind @2 :Kind; major @3 :UInt32; minor @4 :UInt32;
  enum Kind { char @0; block @1; }
}

struct PendingDevice {
  device    @0 :Text;              # dev:… id
  bus       @1 :Text;              # "usb" | "thunderbolt" | "pci"
  vendor    @2 :UInt16;
  product   @3 :UInt16;
  serial    @4 :Text;
  port      @5 :Text;              # physical port path
  classes   @6 :List(Text);        # interface classes, e.g. "hid", "mass-storage", "audio", "fido", "net"
  name      @7 :Text;              # descriptor strings, untrusted (rendered as untrusted text)
  hidSafety @8 :Text;              # "none" | "keyboard-like" (requires confirmation with an already-authorized input device)
}

interface DeviceAdmin {            # facets warden, broker (plan, revoke); authorize (atrium: authorize, deauthorize, pending)
  plan   @0 (principal :C.PrincipalId, tokens :List(C.Token)) -> (nodes :List(NodePlan));
  revoke @1 (rootId :Data) -> ();
  authorize   @2 (device :Text, persist :Bool, decisionEnvelope :Data) -> ();
      #! sets the kernel authorized flag (USB) or approves the Thunderbolt/USB4 domain; decisionEnvelope is the mandate
      #! atrium obtained through BrokerSystem.requestFor (resource device, §14.4): devd verifies only the service/broker
      #! or owner-presence signature and the device id; persist stores the identity (vendor, product, serial, port)
  deauthorize @3 (device :Text, forget :Bool) -> ();
  pending     @4 (watcher :C.Watcher(PendingDevice)) -> (cancel :C.Cancelable);
}

interface MediaAttach {            # facets bench, cri
  claimBlock @0 (device :Text, readOnly :Bool) -> (fd :C.Fd, info :Text);
      #! fd of the whole authorized removable block device for a media or pod VM; the host never mounts it (§9.5);
      #! info = JSON {sizeBytes, model, removable, partitions}
  claimVfio  @1 (pciAddress :Text) -> (groupFd :C.Fd, deviceFd :C.Fd);
      #! binds the device to vfio-pci (it must be listed for passthrough in config); the host driver is unbound
  release    @2 (device :Text) -> ();
}

struct PowerEvent { union { preSleep @0 :Text; postResume @1 :Text; battery @2 :Text; sensor @3 :Text; lid @4 :Bool; } }

interface PowerEvents {            # facet client (events), service (subscribe + ack: hearth, strata, atrium)
  subscribe @0 (watcher :C.Watcher(PowerEvent)) -> (cancel :C.Cancelable);
  ack       @1 (op :Text) -> ();
}

struct BtDevice { address @0 :Text; name @1 :Text; paired @2 :Bool; connected @3 :Bool; kind @4 :Text; battery @5 :Int8; }

interface Bluetooth {              # facet admin
  power      @0 (on :Bool) -> ();
  scan       @1 (watcher :C.Watcher(BtDevice)) -> (cancel :C.Cancelable);
  pair       @2 (address :Text) -> ();             # confirmation on the trusted path
  connect    @3 (address :Text) -> ();
  disconnect @4 (address :Text) -> ();
  forget     @5 (address :Text) -> ();
  devices    @6 () -> (list :List(BtDevice));
}

interface Backlight {              # facet atrium
  list @0 () -> (devices :List(Text));
  set  @1 (device :Text, permille :UInt16) -> ();
  get  @2 (device :Text) -> (permille :UInt16);
}
```
<!-- END protocols §7.5.8 -->

<!-- BEGIN protocols §7.5.19 (verbatim) -->
> **protocols 7.5.19 `picker.capnp`**

```capnp
@0xc7a1e5d3b2f40032;
using C = import "common.capnp";
using B = import "broker.capnp";

struct PickResult {
  fd          @0 :C.Fd;
  rootKey     @1 :Text;          # identifies the held root dirfd (matches the broker path_root fact)
  relPath     @2 :Text;          # path relative to root, normalised, no ".."
  displayName @3 :Text;
  kind        @4 :Kind;
  persist     @5 :Bool;          # user ticked "Remember access"
  enum Kind { file @0; directory @1; created @2; }
}

interface FilePicker {             # portal-files facets broker (pick), drop (atrium: confirmDrop)
  pick        @0 (req :B.PowerboxRequest, requester :C.PrincipalId, user :Text) -> (results :List(PickResult));
      #! empty list = user cancelled
  confirmDrop @1 (tokens :List(C.Token), target :C.PrincipalId) -> (results :List(PickResult));
}
```
<!-- END protocols §7.5.19 -->

<!-- BEGIN protocols §7.5.21 (verbatim) -->
> **protocols 7.5.21 `fleet-sys.capnp`**

```capnp
@0xc7a1e5d3b2f40034;
using C = import "common.capnp";
using P = import "prompt.capnp";

interface FleetCompliance {        # facets gate (complianceToken), client (status)
  status          @0 () -> (json :Text);
  complianceToken @1 (audience :Text) -> (envelope :Data);   # DSSE compliance assertion for org services
}

interface OrgDecider {             # facet decider (broker)
  decide @0 (prompt :P.ApprovalPrompt, group :Text) -> (decision :P.Decision);
      #! for permits annotated @orgApproval("<group>"); the mandate is signed by an approver/<id> key
}

interface FleetCluster {           # facet cluster (cri)
  joinAttested @0 (quote :Data, eventLog :Data, cvmReport :Data, challenge :Data) -> (joinJson :Text);
      #! fleet verifies the TPM quote (AK, §19.6; qualifyingData = SHA-256("keylos-join/1" ‖ challenge ‖ machine key))
      #! against the release log and, for cvm, the confidential-VM report; challenge MUST come from joinChallenge and be
      #! unexpired; returns the cluster API endpoint, CA bundle and a bootstrap token bound to the node identity
  kubeletCertificate @1 (csrDer :Data) -> (chainPem :Text, expires :C.Timestamp);   # = clusterCertificate("kubelet", …)
  joinChallenge      @2 () -> (challenge :Data, expires :C.Timestamp);   # 32 random bytes, valid ≤ 300 s, single use
  clusterCertificate @3 (role :Text, csrDer :Data) -> (chainPem :Text, expires :C.Timestamp);
      #! role "kubelet" | "kube-proxy" | "cri" (cri's own cluster credential: NetworkPolicy and Pod watches, drain);
      #! issued only to attested nodes; renewed by cri before expiry; private keys stay in the cri state directory
}
```
<!-- END protocols §7.5.21 -->

<!-- BEGIN protocols §7.5.16 (verbatim) -->
> **protocols 7.5.16 `display.capnp`**

```capnp
@0xc7a1e5d3b2f4002f;
using C = import "common.capnp";
using W = import "warden.capnp";

enum ClientClass { trusted @0; t1 @1; t2 @2; legacyX @3; assistive @4; ime @5; }

interface Display {                # facets warden, bench, compat (xwaylandWm), settings (outputs)
  clientSocket @0 (principal :C.PrincipalId, tier :W.Tier, generation :C.Ref, process :W.Process)
                -> (socketDir :C.Fd, name :Text, cls :ClientClass);
      #! socketDir: O_PATH dirfd containing the listening socket `name`; the binding lives until process.wait resolves
  xwaylandWm   @1 (principal :C.PrincipalId, wm :C.Fd) -> ();
      #! facet compat only; wm = socketpair end connected to Xwayland's -wm fd
  outputs      @2 () -> (json :Text);
  windowOwner  @3 (window :Text) -> (principal :C.PrincipalId, human :Text, app :Text);
      #! facet broker only: owner of "window:<id>" (ResourceRef.screen); app = the generation name; kl:not-found if unknown
}
```
<!-- END protocols §7.5.16 -->

<!-- BEGIN protocols §7.5.24 (verbatim) -->
> **protocols 7.5.24 `classifier.capnp`**

```capnp
@0xc7a1e5d3b2f40037;
using C = import "common.capnp";

struct ClassifyRequest {
  principal @0 :C.PrincipalId;
  kind      @1 :Text;              # request kind: "grant.<resource kind>", an effect kind, or "net"
  summary   @2 :Text;              # request summary (resource and rights as text; never data)
  label     @3 :C.Label;           # current session label
  recent    @4 :List(Text);        # summaries of at most the last 20 receipts of the session
  tier      @5 :UInt8;             # tier the broker decided (0..3)
}

struct ClassifyResult {
  escalate @0 :Escalate;
  reason   @1 :Text;
  enum Escalate { none @0; t2 @1; t3 @2; }   #! can only raise the tier; failure, timeout or malformed output raises by one level
}

interface Classifier {             # facet broker (holder broker only)
  classify @0 (request :ClassifyRequest) -> (result :ClassifyResult);
}
```
<!-- END protocols §7.5.24 -->

#### 2.2.5 Tokens, labels, approvals and policy

<!-- BEGIN protocols §8.1 (verbatim) -->
> **protocols 8.1 Format**

Tokens are **Biscuit v3** tokens:
- Ed25519 root key; the broker holds the root keys.
- Datalog blocks; attenuation is offline and append-only.

There is one root keypair per boot per machine, rotated at reboot. **Persistent grants** are stored by the broker as **grant records** (broker-local format `keylos.grant/1`) and re-minted on each boot. Tokens never outlive a boot.
<!-- END protocols §8.1 -->

<!-- BEGIN protocols §8.2 (verbatim) -->
> **protocols 8.2 Authority block vocabulary**

The broker MUST write the authority block using only these facts. Other components MUST understand all of them.

| Fact | Meaning |
|---|---|
| `principal($p)` | Holder principal text |
| `session($s)` | Holder session |
| `root_id($r)` | Root ID (bytes) |
| `right($kind, $resource, $op)` | Resource text by kind: `path` — `<rel>`, a normalised relative path (no leading `/`, no `.`/`..`, no trailing `/`, `""` = the whole root) naming a subtree matched on component boundaries, under the root named by the token's `path_root` fact; `net` — the host (or `listen:<addr>`), with the `net(...)` facts for that host carrying port, proto and method (a net right without a `net` fact for its host is invalid; a grant with only specific methods does not authorise a protocol-level connect, `"*"` does); `delegate` — `"*"`. `$kind` ∈ {"path", "net", "device", "secret", "budget", "spawn", "service", "effect", "delegate", "principal", "screen", "model"}; `$op` is a `Right` enumerant name. Kind `principal` (resource `session:s-…` or `gen:fsv256:…`) carries only `debug`; kind `screen` (resource `window:<id>`) only `read`, single use; kind `model` (resource `<provider>/<model>@<version>`) only `use` |
| `debug_scope($scope)` | `"process"` or `"kernel"` for a `debug` right; absent means `process` |
| `path_root($fdkey)` | Declares a broker-held root dirfd `$fdkey`; a path right applies under every `path_root` of the authority block. The broker mints at most one `path_root` per token |
| `net($host, $port, $proto, $method)` | `$method` is "*" for no HTTP restriction; `$host` "listen:<addr>" for listening grants |
| `budget($unit, $amount)` | Ceiling per charge in the authorizer (`amount ≤ ceiling`); cumulative spending is tracked by `gate` keyed by root_id |
| `expires($time)` | |
| `tier_floor($n)` | Minimum confinement tier for any process using this token |
| `max_depth($n)` | Maximum **absolute** delegation depth (the root holder is depth 0) |
| `max_fanout($n)` | Maximum number of child sessions |
| `label_ceiling($conf)` | Highest confidentiality the holder may read under this token: bounds both the session label and, when supplied, the object label |
| `persist($grantId)` | Token re-minted from persistent grant `$grantId` |
| `captive($bool)` | Captive-portal token: valid only for the captive-browser VM while `net` reports a captive network (minted by `BrokerSystem.mintCaptive`, ≤ 10 min, `tier_floor` ≥ 2) |
| `model($provider, $model, $version)` | A model identity approved for an agent session (§14.5); the authority block may list several (the approved set). An observed model must match a `model` fact of every block that has one; `gate` compares observed model versions against them |
| `budget_parent($rootId)` | The token's budget is a hard sub-meter of `$rootId` (`GateMeterAdmin.carve`) |
| `workflow($wf, $epoch)` | The token was minted for an attempt of workflow `$wf` (`wf-…`) at ownership epoch `$epoch` (§20.25). Verifiers that act for workflows (`gate` `DurableEffects`) MUST compare `$epoch` with the binding they are given and with the current claim; the fact never authorizes anything by itself |
| `budget_account($ba)` | Spending under this token is charged to the durable workflow budget account `$ba` (`ba-…`, `WorkflowBudget`, §7.5.25) in addition to the root meter, so a fresh attempt's new root never resets spent amounts |

**Fact multiplicity.** The authority block has exactly one `principal`, `session` and `root_id`, and at most one each of `expires`, `tier_floor`, `max_depth`, `max_fanout`, `label_ceiling`, `persist`, `captive`, `debug_scope` (per right), `budget_parent`, `workflow` and `budget_account`; `model` may occur several times. `persist`, `workflow` and `budget_account` are trusted only in the authority block.
<!-- END protocols §8.2 -->

<!-- BEGIN protocols §8.3 (verbatim) -->
> **protocols 8.3 Attenuation checks**

Attenuation blocks MAY contain any Datalog check over the authorizer's ambient facts. Delegation helpers MAY also append limit facts (`expires`, `max_depth`, `max_fanout`, `label_ceiling`, `tier_floor`, `budget_parent`, `model`, `debug_scope`, `captive`) to attenuation blocks; Biscuit scoping hides them from other blocks, so the authorizer MUST read every block's limit facts and enforce the **most restrictive** value across blocks (minimum for limits, maximum for floors, any-true for restrictions). Limits can therefore only narrow. `expires` is inclusive (`time ≤ expires`), with one-second resolution.

| Ambient fact | Meaning |
|---|---|
| `time($t)` | Now (trusted time, §3.6) |
| `operation($kind, $op)` | Requested operation |
| `resource($kind, $resource)` | Requested resource |
| `path_under($root, $rel)` | Path relation |
| `host($h)`, `port($p)`, `method($m)` | Network attributes |
| `depth($n)` | Current delegation depth |
| `session_label($conf, $integ)` | Current session label |
| `principal_kind($k)` | Actor kind |
| `amount($unit, $n)` | Amount being spent |
| `offline_days($n)` | Days since the last fresh revocation list (§14.5) |
| `proto($p)` | Requested network protocol (`tcp`, `udp`, `https`) |
| `object_label($conf, $integ)` | Label of the object being read (enforces `label_ceiling`) |
| `requested_debug_scope($s)` | Scope of a requested `debug` operation (enforces `debug_scope`) |
| `process_tier($n)` | Confinement tier of the process that will use the materialised resource (enforces `tier_floor`; legacy counts as 1, t2 as 2, t3 as 3) |
| `captive_network($b)` | Whether `net` currently reports a captive network (enforces `captive`) |

Examples:

```
check if time($t), $t <= 2026-10-07T21:30:00Z;
check if operation("path", $op), ["read"].contains($op);
check if resource("net", $r), host($h), ["api.github.com"].contains($h), method($m), ["GET","HEAD"].contains($m);
check if depth($d), $d <= 1;
```
<!-- END protocols §8.3 -->

<!-- BEGIN protocols §8.4 (verbatim) -->
> **protocols 8.4 Revocation**

- Revoking a root ID invalidates every token derived from it, including tokens whose `budget_parent` names it. Revocations are in-memory and persisted until the next reboot, when keys rotate anyway.
- **Workflow revocation is durable.** Cancelling or revoking a workflow (`BrokerWorkflow.cancel`, §20.25) writes a persistent cancellation record in the broker, revokes every root carrying that workflow's `workflow` fact, and makes every later claim and attempt registration of the workflow fail, across restarts and reboots; it is not undone by the per-boot key rotation.
- The broker MUST check revocation on every `materialize`, and `gate` on every `connect`, `stage` and `charge`.
- **Already-materialized fds cannot be pulled back from a process.** Revoking therefore also terminates or freezes holders through `PrincipalControl.terminate` (§7.5.1), according to the grant record's `onRevoke`: `kill` (default for agents) or `freeze` (default for apps; the user decides). Attached grant mounts are detached (`GrantMounts.detachGrant`).
<!-- END protocols §8.4 -->

<!-- BEGIN protocols §14.1 (verbatim) -->
> **protocols 14.1 Labels**

| Dimension | Values (lowest → highest) |
|---|---|
| Confidentiality | `public` (0) < `internal` (1) < `private` (2) < `secret` (3) |
| Integrity | `trusted` (0) < `user` (1) < `untrusted` (2). Higher means *less* trustworthy |

- **Objects:**
  - Files carry `security.bpf.keylos.label`. Files without one inherit the default for their location: home data `private/user`; downloads and web content `public/untrusted`; store objects `public/trusted`.
  - Sockets get a label per connection from `gate`: responses from hosts are `untrusted` unless the policy marks the host `user`.
- **Sessions:** each principal session has a label. On every broker-mediated read, `session.conf = max(session.conf, object.conf)` and `session.integ = max(session.integ, object.integ)`. Labels never decrease within a session.
- **Label authority:** services that hand data from one principal to another (gate, bench, portals, atrium, strata, aide, journal, warden) raise the receiver's label with `LabelAuthority.raiseFor` (§7.5.2) **before** handing the data over. `warden` reads live labels with `labelOf` for `ConnectionInfo.label`.
- **Removable media and discovery:** bytes from `MediaBrowser` and results from `Discovery.browse` are `public/untrusted`.
- **Rule of Two** (enforced by `broker` and `gate`): define three properties of a session:
  - **U** = `integ == untrusted`
  - **P** = `conf ≥ private`
  - **X** = holds or requests a capability with `Right.commit`, an `effect` resource, or egress to a host not marked `sink-safe`

  A session MUST NOT hold all three. Requesting the third turns into a **declassification** approval at tier T3, unless a policy-registered **flow proof** (§20.11) is accepted. A flow proof is accepted only from an `agent-template` whose manifest `agent.flowProof` is `"camel/1"` and whose harness runtime is in the policy's trusted list.
- **Directory grants** (ceilings). A directory exposed to a session through a grant has an **exposure label** *c*, and the label assumptions hold only if *c* bounds everything readable through the grant for its whole lifetime:
  - The receiver's session label is raised to *c* (`raiseFor`) **before** the directory is exposed, and the resulting policy decision (Rule of Two) is enforced at that point.
  - *c* is enforced by `warden` (§7.3.3, §9.3): objects labelled above *c*, or with a malformed label, are not readable through the grant, whenever they appeared. Unlabelled objects count at their location default.
  - The broker may choose *c* as the join of a **complete** assessment of the tree. A bounded or truncated walk never justifies anything lower than the location default; entries above *c* then stay unreadable through the grant and are reported as hidden.
  - Without enforcement (null ceiling) the exposure label is the lattice maximum `secret/untrusted`.
  - Writes, relabels and renames into the tree, retained handles and concurrent changes are covered because enforcement happens at every open and read through the grant, not at grant time. A retained fd loses read access as soon as its object's label rises above *c*.
  - Agent input SHOULD be an **immutable assessed view** (a transaction base snapshot or a bench share snapshot): its complete assessment is final, so its exposure label can be lower without losing workflows to the `secret` deny of agent policy.
<!-- END protocols §14.1 -->

<!-- BEGIN protocols §14.2 (verbatim) -->
> **protocols 14.2 Effect kinds**

Registered kinds, with their default class:

| Kind | Class |
|---|---|
| `fs.merge` | compensable (undo snapshot; compensator `fs.undo`) |
| `git.push` | compensable for new branches; irreversible for force pushes, pushes to protected branches and any other push to an existing branch |
| `git.pr.open` | compensable |
| `email.send` | irreversible |
| `message.send` (chat) | irreversible |
| `http.post`, `http.put`, `http.patch` | irreversible unless the host policy registers a compensator |
| `http.delete` | irreversible |
| `payment.authorize` | irreversible (requires an AP2-style mandate in `data`) |
| `publish.package` | irreversible |
| `cloud.iam.change` | irreversible |
| `db.write.prod` | irreversible |
| `calendar.create` | compensable |
| `file.share` | compensable |
| `device.actuate` | irreversible |
| `net.listen` | compensable (close the port). Required for any port reachable from non-loopback addresses (scope `lan`/`any`); loopback-only listening needs no effect |
| `media.export` | compensable (delete the file on the device); counts as egress (property X) for the Rule of Two |
| `config.propose` | reversible (a proposal only; applying it is `config.apply`) |

Policy can register additional kinds (`x-…`), each optionally with an effect renderer component (§20.15). Classes can be raised, never lowered.

**Mandate-only kinds.** The broker records decisions that are not intents with these kinds in mandate `effects[]` (§14.4): `grant.<k>` for every resource kind *k* of §8.2 (`grant.path`, `grant.net`, `grant.device`, `grant.secret`, `grant.budget`, `grant.spawn`, `grant.service`, `grant.effect`, `grant.delegate`, `grant.principal`, `grant.screen`, `grant.model`), `grant.declassify`, `debug.attach`, `pod.admit`, and for durable workflows (§20.25) `workflow.enroll` (target `wf-…`, digest = SHA-256 of the JCS `EnrollRequest` JSON form `{"workflow", "definition": {"generation": <gen ref text>, "name", "digest": <digest text>}, "inputDigest": <digest text>, "scope": [<GrantRequest JSON forms>], "budgets": [{"unit", "amount"}], "resume": "manual" | "automatic", "runWhileLocked", "horizonSecs", "reason", "account"}`), `workflow.resume` (target `wf-…`) and `workflow.decide` (target the `ws-…` or `fx-…` the decision is about, digest = SHA-256 of the JCS question or resolution document). They are valid only in mandates, written only by `broker`, and never appear in manifests, command signatures, intents or `gate` intents.

**Required review details.** Approval of an effect requires that the trusted path presents at least these details of the exact payload (§7.3.4); a policy-registered kind's renderer declares its own, and a kind without a declaration requires the complete canonical payload:

| Kind | Required details |
|---|---|
| `email.send`, `message.send` | every recipient (to, cc, bcc), subject, complete body, attachment names, types and sizes |
| `http.*` | method, complete URL, request body (or its digest plus a complete canonical rendering for bodies over the channel limit) |
| `payment.authorize` | amount, currency, payee, mandate terms |
| `fs.merge` | the complete `keylos.fsmerge/2` manifest and the diff of every changed text file; binary changes by path, size and digest |
| `git.push`, `git.pr.open` | remote, refs (old → new), commits with titles; force flag |
| `publish.package`, `cloud.iam.change`, `db.write.prod`, `device.actuate` | target and the complete operation |
| `file.share`, `calendar.create`, `media.export`, `net.listen` | target (people, device or port and scope) and the object |
| `config.propose`, `config.apply` | the complete plan diff |
| `grant.*`, `debug.attach`, `pod.admit`, `grant.declassify` | resource, rights, duration, persistence, requesting principal and `onBehalfOf` |
| `workflow.enroll` | definition (name, version, generation, digest), every scope item as for `grant.*`, budget ceilings, resume policy (`automatic` stated as "runs again after restarts without asking"), `runWhileLocked`, horizon, the owner and the label the workflow starts with |
| `workflow.resume`, `workflow.decide` | workflow, definition, current step, the complete question or resolution document, and for `workflow.decide` on an effect the effect's own required details |

**Caller-executed effects.** For `media.export`, `device.actuate` and `config.propose`, `gate` stages, renders and decides the intent but does not perform it. A successful `Intent.commit` returns, in `IntentStatus.result`, the base64 delivered mandate (§14.4) bound to the payload digest, and `gate` writes `effect.commit` meaning "authorized". The executor (`bench` `MediaBrowser.export`/`ExportCompletion.finish`, the device's owning service, `config` for `propose`) MUST verify the mandate (owner-presence or `service/broker` signature, payload digest, expiry, single use) before acting, and writes its own completion receipt (`media.export` by `bench`). Stagers of `media.export` are `portal-files` and `atrium` on behalf of the requesting app. **Authorization is not completion**: an intent in `committed` state of a caller-executed kind, and an effect in `authorized` state (§20.26), say only that the effect may be performed; a workflow waits for the executor's authenticated completion (its receipt, `DurableEffects.complete`) before it treats the effect as done.
<!-- END protocols §14.2 -->

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

<!-- BEGIN protocols §14.4 (verbatim) -->
> **protocols 14.4 Mandates (`keylos.mandate/1`)**

```json
{"schema":"keylos.mandate/1","approval":"a-…","principal":"…","tier":"t3",
 "effects":[{"kind":"email.send","target":"smtp:…","digest":"sha256:<payload digest>"}],
 "scope":"once","constraints":{"maxAmount":null,"expires":"…"},"decidedBy":"alice","presence":true,
 "channel":"local"}
```

- `channel`: `local` (atrium trusted path), `phone` (vouch), `org` (fleet approver), `quorum` (a quorum presence envelope, §5.4; `decidedBy` is `"quorum"`).
- `constraints.workflow` and `constraints.decision`: present exactly in mandates of durable decisions (§20.25): the `wf-…` the decision belongs to and its `dr-…`. A verifier acting for a workflow MUST require `constraints.workflow` to equal the effect's workflow; verifiers that do not know these members reject the mandate (unknown members, §5.1), so an older verifier fails closed.
- `constraints.channels`: the channels the broker allowed for this approval (§14.3, `ApprovalPrompt.channels`), a non-empty array of channel names without duplicates. The deciding `channel` MUST be one of them unless it is `quorum` (quorum presence replaces local presence on quorum machines).
- **Drafts.** `ApprovalPrompt.mandateDraft` is not a valid mandate: it carries placeholder `decidedBy` and `channel` values until the deciding channel fills them in and signs. Only a decided mandate is validated as `keylos.mandate/1`.
- **Extensions carry no authority.** `x-` members (§5.1) of a mandate are informational; no verifier may base an authorization decision on them.
- **Grant effects.** For a grant decision the broker writes one effect `{"kind": "grant.<k>", "target": <canonical resource string>, "digest": "sha256:" + SHA-256(JCS(R))}`, where R is the JSON form of the `GrantRequest`: `{"resource": {<union member>: v}, "rights": [Right enumerant names], "reason", "durationSecs", "persist", "onBehalfOf": <principal text or null>}`, with v = the text value for `path`, `device`, `secret`, `service`, `effect`, `screen`, `model` and `spawn`; `null` for `dirFd` and `delegate`; `{"host", "port", "proto", "methods"}` for `net`; `{"unit", "amount"}` for `budget`; `{"target", "scope"}` for `principal`. A service that asked for a confirmation through `requestFor` (vault: `grant.secret` with `{"secret": "<owner>/<name>"}`) verifies kind and digest.
- **Decision signatures** (inside the approval flow): presence-signed (§5.3) when `presence` is true; otherwise signed by the deciding channel's approver key: the atrium approver key or the `vouchd` phone key (both registered with `BrokerSystem.registerApprover`), or an `approver/<id>` key.
- **Mandates as delivered** (`Approval.mandate`, `GrantResult.mandate`): a presence-signed mandate is delivered as is; a non-presence mandate is re-signed by `service/broker` after the broker has verified the channel's decision signature. Relying services (gate, strata, bench, depot, devd) therefore verify only owner-presence keys (owner registry, via `HearthSystem.owners`) and the `service/broker` key (as registered with `ledger`, `Ledger.serviceKey`, §7.3.5); they never need approver keys.
- The `approval.decide` receipt carries `mandateDigest` (SHA-256 of the delivered mandate envelope).
- `gate` MUST NOT commit an irreversible intent without a mandate whose `effects[].digest` matches the intent payload digest.
<!-- END protocols §14.4 -->

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

<!-- BEGIN protocols §16.2 (verbatim) -->
> **protocols 16.2 Decision mapping and annotations**

- `forbid` wins.
- `permit` with annotation `@tier("t2")` or `@tier("t3")` means "permitted after approval at that tier".
- `permit` with `@presence("true")` requires presence regardless of tier.
- `permit` with `@orgApproval("<group>")` means "permitted after an approval decided by `OrgDecider.decide` for that approver group" (fleet-enrolled machines only); `context.channel` is `"org"` and `context.approver` the approver key ref during evaluation of the resulting mandate.
- **Evaluation order** when a permit carries both `@tier` and `@orgApproval`: the local tier approval (trusted path, or phone if allowed) is obtained **first**; only after it is granted is `OrgDecider.decide` called. Both decisions are required, and the delivered mandate records both (`channel: "org"`, with the local decision's digest in `constraints.localDecision`). On BYOD fleet machines org policies MUST use this form for effects that touch the owner's personal data.
- `permit` with `@channels("local,phone")` lists the approval channels allowed for that permit (default `local`).
- A `permit` without a tier annotation means **T1 for action `connect`** and **T0 otherwise**.
- **Several matching permits** combine to the most restrictive requirement: the highest `@tier`, presence if any permit requires it, every `@orgApproval` group, and the intersection of the `@channels` sets (an empty intersection denies). `phone` never satisfies presence and is dropped when presence is required; on quorum machines presence is satisfied through the `quorum` channel.
- Annotation values: `@tier` ∈ `t0`…`t3`; `@presence` ∈ `"true"`/`"false"`; `@channels` a comma-separated subset of `local`, `phone`; anything else fails closed (deny). `@presence("true")` requires a synchronous trusted-path prompt with presence whatever the tier. `@orgApproval` without `@tier` needs no local interaction; on machines that are not fleet-enrolled such permits are ignored. Policies carry an `@id("<name>")` annotation, used in receipts and diagnostics.
- No matching `permit` means `denied`.
- On fleet-enrolled machines, org `forbid` policies are loaded into the same policy set and cannot be overridden by owner `permit`s.
<!-- END protocols §16.2 -->

#### 2.2.6 Layout, registries and shared formats

<!-- BEGIN protocols §10.4 (verbatim) -->
> **protocols 10.4 Extended attributes**

| xattr | Writer | Content |
|---|---|---|
| `security.bpf.keylos.prov` | BPF LSM at inode creation (`strata`) | CBOR `{p: principal, g: generation, x: transaction, t: time}` |
| `security.bpf.keylos.label` | `broker` / `strata` | 2 bytes: conf, integ (§14.1 ordinals) |
| `security.keylos.unit` | `strata` | Crypto-shred unit ID |
| `trusted.overlay.metacopy`, `trusted.overlay.redirect` | `depot` (composefs) | |

Names a BPF LSM program must read or stamp use the `security.bpf.` prefix: the kernel's BPF xattr kfuncs (`bpf_get_file_xattr`, `bpf_get_dentry_xattr`, `bpf_set_dentry_xattr`) accept only `user.*` (read) and `security.bpf.*` names, and are available to LSM program types only. From userspace, setting or removing any `security.*` name, `security.bpf.*` included, needs `CAP_SYS_ADMIN` in the user namespace that owns the filesystem; no keylos BPF program attaches `inode_xattr_skipcap`, so that check always applies. Principals never hold `CAP_SYS_ADMIN` and never own a filesystem's user namespace, so only the writers listed above can set these names. `security.keylos.unit` is read only by `strata` and keeps its name.
<!-- END protocols §10.4 -->

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

<!-- BEGIN protocols §19.2 rows=^\| broker \| (verbatim) -->
> **protocols 19.2 Facets** (rows for this repository)

Every route names exactly one facet. Servers MUST implement exactly these facets; holders other than those listed are routed only when policy explicitly grants `right("service", "<svc>#<facet>", "use")`.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| broker | `principal` | every principal | `Broker` |
| broker | `system` | warden, gate, aide, atrium, config, hearth, strata, net, depot, vault, vouch, cri | `BrokerSystem` (per-method callers as commented in §7.5.2; `requestFor` with the allowed-subject rule, atrium only for its own session (device authorization); `registerApprover`: atrium, vouch; `admitPod`: cri; `mintCaptive`: net); `Broker.inspect` |
| broker | `label-authority` | gate, bench, portal-*, atrium, strata, aide, journal, warden | `LabelAuthority` |
| broker | `workflow` | loom, gate, aide, strata, bench | `BrokerWorkflow` (§7.5.25): `enroll`, `claim`, `decide`, `rebind`, `resume`, `cancel`, `cancelDecision`, `record`, `raise`: loom; `authorizeEffect`, `verify`, `record`, `cancelDecision`: gate; `offer`, `verify`, `decide`, `rebind`: aide (its agent attempts); `verify`, `record`: strata, bench |
<!-- END protocols §19.2 rows=^\| broker \| -->

<!-- BEGIN protocols §19.2 rows=^\| (atrium|classifier) \| `broker` (verbatim) -->
> **protocols 19.2 Facets** (rows for this repository)

Every route names exactly one facet. Servers MUST implement exactly these facets; holders other than those listed are routed only when policy explicitly grants `right("service", "<svc>#<facet>", "use")`.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| atrium | `broker` | broker | `Display.windowOwner` |
| classifier | `broker` | broker | `Classifier` (§7.5.24) |
<!-- END protocols §19.2 rows=^\| (atrium|classifier) \| `broker` -->

<!-- BEGIN protocols §19.3 rows=\| broker \|$ (verbatim) -->
> **protocols 19.3 Receipt events** (rows for this repository)

| Event | Writer |
|---|---|
| `grant.issue`, `grant.attenuate`, `grant.delegate`, `grant.revoke`, `grant.deny`, `label.raise`, `approval.request`, `approval.decide` | broker |
<!-- END protocols §19.3 rows=\| broker \|$ -->

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

<!-- BEGIN protocols §20.8 (verbatim) -->
> **protocols 20.8 Consent record (`keylos.consent/1`)**

Signed by `service/depot` after the human approves a capability set:

```json
{"schema":"keylos.consent/1","generation":"gen:fsv256:…","name":"org.example.Editor",
 "capabilities":"sha256:<JCS digest of capability set>","approval":"a-…","mandate":"rcpt:sha256:…",
 "scope":"machine","decidedBy":"alice","time":"…"}
```

A consent record covers every later generation of the same `name` and publisher whose capability set is a subset of the consented set. Consent never makes code launchable on its own; launchability requires an authorising signature (§20.7). The broker consults consent records when minting install-time grants.
<!-- END protocols §20.8 -->

<!-- BEGIN protocols §20.11 (verbatim) -->
> **protocols 20.11 Flow proof (`keylos.flowproof/1`)**

DSSE, signed by the agent session key registered with `BrokerSystem.registerSessionKey`:

```json
{"schema":"keylos.flowproof/1","session":"s-…","intent":"e-…","payloadDigest":"sha256:…",
 "runtime":"gen:fsv256:<harness runtime generation>","policy":"camel/1",
 "controlSources":[{"source":"user","label":{"conf":"private","integ":"user"}}],
 "dataSources":[{"argument":"body","source":"file:/home/…","label":{"conf":"private","integ":"user"}}],
 "claims":["control-flow-independent-of-untrusted","recipients-from-user"]}
```

It is attached to a staged intent as the arg `x-flow-proof` (base64 DSSE) and passed by `gate` to `BrokerSystem.checkFlow`. The broker accepts it instead of a prompt only if: the template's `agent.flowProof` is `"camel/1"`; the runtime is listed in the policy's `flowproof-runtimes.json`; every `controlSources[].label.integ ≤ user`; and the payload digest matches.
<!-- END protocols §20.11 -->

#### 2.2.7 Profiles, quorum presence, metering, debugging, operating rules, policy reference and pod admission

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

<!-- BEGIN protocols §5.4 (verbatim) -->
> **protocols 5.4 Quorum presence**

Headless profiles (`server`, `server-k8s`, `cloud`, `appliance`) and managed machines use **quorum presence** instead of a local touch. The owner registry (§20.3) then has `policy.mode = "quorum"` and `policy.threshold = N`, with M approver credentials (the owners' FIDO2 credentials, enrolled like any owner credential).

- A **quorum presence envelope** is an ordinary DSSE envelope over the same payload with **≥ N signatures** (§5.3 construction) from credentials of **distinct owners**. Verifiers MUST count distinct owners, not signatures.
- Collection: `hearth` creates a quorum request (`keylos.quorum/1`, §20.18) through `HearthQuorum.request` (§7.5.3); approvers receive it through `fleet` (or out of band as a file), review the rendered payload on their own keylos machine, and sign it there with `hearth presence --remote <request>` (their machine's `hearth` signs with their own credential and rpId `keylos.owner`); signatures return through `HearthQuorum.submit`. The request expires after at most 24 h.
- Every purpose of §20.2 accepts a quorum envelope on quorum machines. On `desktop`/`laptop` profiles quorum envelopes are accepted only for owner-registry changes that the registry policy marks `quorum`.
- **Seal gate on quorum machines.** No touch reaches the machine, so the seal gate's authValue for the window is released differently: `hearth` holds the next gate authValue in a TPM-sealed blob bound to the signed PCR11 `ready` phase and PCR15, and unseals it only after verifying a quorum envelope of purpose `seal.window`. This reduces the guarantee from "a physical touch" to "N approvers signed and the machine runs a verified `hearth`"; the reduction is shown in `status` (`sealing: quorum`).
<!-- END protocols §5.4 -->

<!-- BEGIN protocols §7.5.12 (verbatim) -->
> **protocols 7.5.12 `gate-sys.capnp`**

```capnp
@0xc7a1e5d3b2f4002b;
using C = import "common.capnp";
using B = import "broker.capnp";

interface ShimEndpoint {           # facet shim: one endpoint per principal (tier L shim, bench-net per VM)
  connect      @0 (target :B.NetTarget, tokens :List(C.Token)) -> (socket :C.Fd);   # gate picks the first authorizing token
  udpAssociate @1 (target :B.NetTarget, tokens :List(C.Token)) -> (dgram :C.Fd);
  resolve      @2 (name :Text, qtype :UInt16) -> (answer :Data);   # DNS wire-format response, granted names only
  sshAgent     @3 () -> (socket :C.Fd);
  caBundle     @4 () -> (pem :Text);                               # session CA (if TLS interception is active)
}

interface GateDebug {              # facet debug (warden, atrium, owner shell)
  interception @0 (session :C.SessionId) -> (active :Bool, hosts :List(Text));   # fills the confinement report (§9.4)
  status       @1 () -> (json :Text);
}

interface GateMeterAdmin {         # facet broker
  meterFor @0 (rootId :Data) -> (spent :List(B.Budget), remaining :List(B.Budget), parent :Data);
  carve    @1 (parentRoot :Data, childRoot :Data, budget :List(B.Budget)) -> ();
      #! creates a hard sub-meter: every charge to childRoot is also charged to parentRoot; gate refuses a carve that
      #! would make the sum of the children's ceilings exceed the parent's remaining amount (kl:budget)
  release  @2 (childRoot :Data) -> ();   # returns the unspent remainder to the parent
}
```
<!-- END protocols §7.5.12 -->

<!-- BEGIN protocols §9.3 (verbatim) -->
> **protocols 9.3 Code integrity (host)**

**Primary enforcement: the `kl-exec` BPF LSM.** `boot` loads `kl-exec` in the initrd before executing any file other than itself, and hands its maps and links to `warden` across `switch_root`. The program reads kernel structures at offsets the loader computes from the running kernel's BTF (`/sys/kernel/btf/vmlinux`) before load; a missing member fails the load.

| Hook | Decision |
|---|---|
| `bprm_check_security` | Allow if the file's superblock `s_dev` ∈ `kl_exec_allowed_sb`, or (phase INITRD and the file is on the initramfs). Else `-EACCES` |
| `bprm_creds_for_exec` with `bprm->is_check` set (`execveat(…, AT_EXECVE_CHECK)`) | Same rule as `bprm_check_security`. A check-only exec returns after this hook and never reaches `bprm_check_security`, so this row is what refuses an interpreter's check of an unregistered script. Regular execs are decided only by `bprm_check_security` (one event per denial) |
| `mmap_file` with `PROT_EXEC` | File-backed: same rule as exec. Anonymous: allow only if the task's cgroup ID ∈ `kl_exec_jit_cgroups`. Else `-EACCES` |
| `file_mprotect` adding `PROT_EXEC` | File-backed: same as exec. Anonymous or private-writable: allow only for JIT cgroups |
| `kernel_read_file` (firmware, modules, policy, X.509) | Allow if the file's sb ∈ allowed set or (phase INITRD and initramfs). kexec reads are always denied |
| `kernel_load_data` (`init_module`, firmware blobs) | Deny (modules load only via `finit_module` from verified files) |
| `bpf` (`BPF_PROG_LOAD`, `BPF_LINK_DETACH`, `BPF_PROG_DETACH`) | Allow for the `warden` core (thread-group ID recorded in `kl_exec_policy.warden_tgid` at hand-over) and for `boot` in phase INITRD. Allow for a debugger task whose cgroup has a `kl_debug_pairs` entry with scope `kernel`, for tracing program types only (kprobe, tracepoint, raw_tracepoint, perf_event), never LSM, cgroup or XDP types. Deny for every other task |
| `ptrace_access_check` | Allow only if the tracer's cgroup has an unexpired `kl_debug_pairs` entry whose target cgroup contains the tracee (or is an ancestor of it). Yama and the seccomp profile apply in addition. The hook also guards every other `ptrace_may_access` path (`/proc/<pid>/{mem,maps,environ,fd,ns/*,root,…}`, `kcmp`, `pidfd_getfd`, `setns` and `PIDFD_GET_*_NAMESPACE` on a pidfd, `process_vm_*`); no task is exempt, including the `warden` core. Checks with `PTRACE_MODE_NOAUDIT` are refused without an event |
| `perf_event_open` | Allow only for a task whose cgroup has an unexpired `kl_debug_pairs` entry (the hook sees only the `PERF_SECURITY_*` type, not the target) |
| `perf_event_alloc` (events created by a `perf_event_open(2)` call admitted above) | Scope `process`: allow only task events whose target task is in the target cgroup (or a descendant) and cgroup events on the target cgroup; CPU-wide events are refused. Scope `kernel`: allow system-wide events. Kernel-internal counters (watchdog, ptrace hardware breakpoints) are not `perf_event_open(2)` requests and are not checked |

**Map contract.** `boot` passes the map fds to `warden` as fds 3–7 in the order given by the kernel command line `keylos.execmapfds=3,4,5,6,7`:

| Map | Type | Key → value | Writer |
|---|---|---|---|
| `kl_exec_allowed_sb` | `BPF_MAP_TYPE_HASH`, 65 536 entries | `u32 s_dev` (kernel `dev_t`, below) → `u32 gen_index` | warden core only |
| `kl_exec_jit_cgroups` | `BPF_MAP_TYPE_HASH`, 4 096 entries | `u64 cgroup_id` → `u8 1` | warden core only |
| `kl_exec_policy` | `BPF_MAP_TYPE_ARRAY`, 1 entry | `u32 0` → `struct {u8 enforce; u8 audit_allow; u8 phase; u8 pad; u32 warden_tgid;}` | boot only, then frozen (`bpf_map_freeze`) after `warden_tgid` is written at hand-over |
| `kl_exec_events` | `BPF_MAP_TYPE_RINGBUF`, 1 MiB | denial events `{u64 cgroup_id; u32 pid; u32 hook; u32 s_dev; u64 ino;}` | warden core (reader) |
| `kl_debug_pairs` | `BPF_MAP_TYPE_HASH`, 256 entries | `u64 tracer_cgroup_id` → `struct {u64 target_cgroup_id; u64 expires_boottime_ns; u8 scope;}` (scope 0 = process, 1 = kernel) | warden core only (`DebugAttach`) |

Internal maps of the program (for example the LRU map that limits the `perf_event_alloc` check to `perf_event_open(2)` requests) are not handed over and are not part of this contract.

**Numeric values.** Decoders (`warden`, `journal`, tools) rely on these:
- `kl_exec_policy.phase`: INITRD = 0, SYSTEM = 1. `enforce` = 1 refuses denials; `enforce` = 0 is permissive (denials are logged and allowed; development only). `audit_allow` = 1 also logs allowed decisions.
- `kl_exec_events.hook` IDs: 1 `bprm_check_security`, 2 `mmap_file`, 3 `file_mprotect`, 4 `kernel_read_file`, 5 `kernel_load_data`, 6 `bpf`, 7 `ptrace_access_check`, 8 `perf_event_open`, 9 `bprm_creds_for_exec`, 10 `perf_event_alloc`; bit 31 set marks an audit-allow record. The C layout has 4 bytes of padding before `ino` (record size 32 bytes).
- File hooks carry the file's superblock `s_dev` and inode number (anonymous mappings: 0, 0). Other hooks reuse the two fields: `kernel_load_data` `s_dev` = the `kernel_load_data_id`; `bpf` `s_dev` = the command, `ino` = the program type for `BPF_PROG_LOAD`; `ptrace_access_check` `s_dev` = the mode, `ino` = the tracee's thread-group ID; `perf_event_open` `s_dev` = the `PERF_SECURITY_*` type; `perf_event_alloc` `s_dev` = 1 task event, 2 cgroup event, 3 CPU-wide event, `ino` = the target cgroup ID when known.
- `s_dev` everywhere is the **kernel** encoding of `super_block.s_dev` (`MKDEV`: `major << 20 | minor`), not the userspace `st_dev`/`makedev()` encoding. Registrants convert `statx`'s `stx_dev_major`/`stx_dev_minor`.

**Links.** The program's hooks are attached with `BPF_LINK_CREATE` links and live exactly as long as a link fd is open (no bpffs pins after `switch_root`). `boot` passes the ten link fds to `warden` as fds 9–18, one per hook row, in no particular order, with `keylos.execlinkfds=9,10,11,12,13,14,15,16,17,18` in `warden`'s argv (the boot report is fd 8, §20.1). The `warden` core MUST keep them open for its lifetime and never closes or passes them on; closing them detaches `kl-exec`.

**Registering a generation.** Before adding a mount's superblock to `kl_exec_allowed_sb`, the registrant (`boot` for the OS and bootstrap generations; `warden` for everything else, including mounts it makes on behalf of `bench` and `compat`) MUST:
1. obtain the tree from `depot.mount` (or mount it itself with `verity=require` from a digest-checked image, as `boot` does);
2. verify the generation statement (§20.7) DSSE signatures against the **boot trust set** (§20.1): release-stream keys for distro generations, publisher keys enabled in the config generation, and the owner-seal keys for owner-sealed generations;
3. check the generation is not listed `unlaunchable` in the current revocation list (§11.7);
4. read the superblock device with `statx(tree_fd, "", AT_EMPTY_PATH)` and convert it to the kernel `dev_t` (`stx_dev_major << 20 | stx_dev_minor`).

The decision is sound because the composefs overlay was mounted with `verity=require` from an image whose digest was checked, overlay superblocks are not shared across mounts from different images, and only `warden` can update the map. Writable mounts are always `noexec` in addition.

**Second layer: IPE.** IPE runs a policy signed by `kernel-policy/<stream>`:

```
policy_name=keylos policy_version=1.0.0
DEFAULT action=ALLOW
op=KEXEC_IMAGE action=DENY
op=KEXEC_INITRAMFS action=DENY
op=EXECUTE boot_verified=TRUE action=ALLOW
op=KERNEL_READ boot_verified=TRUE action=ALLOW
```

**Other code paths:**
- `module.sig_enforce=1`. Modules load only from the OS generation or from a **`kmod` generation** (§6.1), and every module MUST carry a signature by the release stream's module-signing key: only project-built, release-signed out-of-tree modules exist. Owner-sealed modules are impossible by design (lockdown enforces module signatures, and owners hold no module-signing key). `warden` registers a `kmod` generation's mount only if its manifest `kmod.kernel` equals the running kernel release.
- `vm.memfd_noexec=2`; `kernel.unprivileged_bpf_disabled=2`; signed BPF loaders only for `boot` and `warden`.
- **Service BPF programs.** Some tier-0 services need BPF programs (strata provenance, net firewall helpers, gate accounting). `warden` loads them only from the **OS generation**, from `/usr/lib/keylos/bpf/<service>/<program>.o` files listed for that service in `services.json` (§20.16), before starting the service; it attaches them and passes their map fds to the service as `KEYLOS_BPF_FDS` (§10.5). Services never call `bpf()` themselves.
- **Grant ceilings.** The warden core loads a label-ceiling LSM program (`kl-label`, separate from the `kl-exec` hand-over) that enforces the exposure label of directory grants (§7.3.3, §14.1): an `open` through a grant mount, and a read through an fd opened through one, fails with `-EACCES` when the object's `security.bpf.keylos.label` (§10.4) exceeds the grant's ceiling or is malformed. `kl-label` attaches `file_open` and `file_permission` (plus `mmap_file` for reads through a mapping), keyed by the grant mount's ID in its map `kl_grant_ceiling`, and reads kernel structures at BTF-computed offsets as `kl-exec` does. Unlabelled objects get their location default (§14.1), except that on kernels without the `bpf-init-inode-xattr` feature an unlabelled object created after the grant was attached counts as `secret/untrusted`. Where `warden` cannot enforce ceilings, `attachGrant` gets a null ceiling and the broker MUST raise the holder to `secret/untrusted`.
- **JIT.** Generations with `needs.jit: true` get their cgroup added to `kl_exec_jit_cgroups` by `warden` and no `PR_SET_MDWE`.
- **Interpreters.** Interpreters shipped in keylos generations MUST honour `AT_EXECVE_CHECK` and the `SECBIT_EXEC_RESTRICT_FILE` / `SECBIT_EXEC_DENY_INTERACTIVE` securebits. `warden` sets both securebits on every host principal **except** the **trusted-terminal tree**, which gets only `SECBIT_EXEC_RESTRICT_FILE`.
- **Trusted-terminal tree.** The tree is the process spawned through `TrustedSpawn.spawnTerminal` and every process that `kish` running in it spawns as a job (foreground or background, including REPLs started from the prompt). A process spawned by any *other* program in that tree (for example an editor that spawns a helper) is outside the tree and gets both securebits; `warden` decides by the spawning principal's actor kind (`shell` from the trusted terminal) and the `SpawnSpec` origin, not by process ancestry alone.
- **Core dumps.** The kernel `core_pattern` pipe helper (`|/usr/lib/keylos/journal/coredump %P %s %t`) is started by the kernel in the root cgroup. This is the one userspace exception to "only the warden core runs in the root cgroup": the helper is an OS-generation binary, installs its own seccomp filter before reading any input, and **moves itself** into `/keylos.slice/system.slice/journal-coredump.scope` before reading the dump (cgroup v2 delegation rules allow only a process in the root cgroup's domain with root credentials to make that move; `journal` cannot). `journal` verifies the move and refuses dumps from a helper still in the root cgroup. `kl-exec`'s `bpf` rule does not depend on cgroup membership, so the exception grants it nothing. The helper is not exempt from `ptrace_access_check` either: it reads only `/proc/%P/{cgroup,status}` (not ptrace-guarded) and takes the crashed process's file mappings from the core's `NT_FILE` note, never from `/proc/%P/maps`.
- **Supervising without ptrace access.** Because `ptrace_access_check` exempts no task, `warden` and every other component observe and control other processes only through operations the hook does not guard: pidfds (from `clone3(CLONE_PIDFD)` or `pidfd_open`) for signals (`pidfd_send_signal`) and exit (`waitid(P_PIDFD)`), `PIDFD_GET_INFO` for credentials and the cgroup ID, `/proc/<pid>/{cgroup,status}`, and cgroup files. A child's namespace fds are captured at spawn: the child opens its own `/proc/self/ns/*` (a task's access to itself is not checked) and passes them to the spawner before its start barrier, and a mapping helper passes its own user-namespace fd the same way. No keylos component opens another task's `/proc/<pid>/{ns/*,root,cwd,fd,maps,mem,environ}` or uses `PIDFD_GET_*_NAMESPACE`, `setns` on a pidfd, `pidfd_getfd`, `kcmp` or `process_vm_*` on another task, except a debugger or open broker within its `kl_debug_pairs` entry.
- **Known limitation (composefs `mprotect`).** For an overlay (composefs) file mapping the kernel passes the backing file to `file_mprotect`, whose superblock is not the registered overlay superblock, so adding `PROT_EXEC` to such a mapping with `mprotect` is refused outside JIT cgroups. `execve` and `mmap(PROT_EXEC)` see the overlay file and are unaffected; only text relocations and similar are refused. Generations needing them declare `needs.jit`.
- **Legacy open broker.** `compat` runs **one open-broker process per legacy app** (the `kl_debug_pairs` map holds one target per tracer). At `LegacySpawn` time (parameter `brokerSession`, §7.5.1) `warden` writes a `kl_debug_pairs` entry (scope `process`, no expiry while the app runs) from that open-broker process's cgroup to the legacy app's cgroup. For this pair `ptrace_access_check` permits `PTRACE_MODE_READ` and `PTRACE_MODE_ATTACH_REALCREDS` (the mode the kernel checks for `process_vm_readv`). The open broker runs with seccomp profile `openbroker-1`, which allows `process_vm_readv` and denies `ptrace`, `process_vm_writev` and `pidfd_getfd`, so the pairing yields read access to the app's memory for decoding seccomp-notification syscall arguments and nothing else.
- **Debugging (`Right.debug`).** A debug grant is minted only at tier T3 with presence, lasts at most 3 600 s (scope `process`) or 900 s (scope `kernel`), and is never minted to an agent principal unless the target session lies inside that agent's own session tree; agents never get scope `kernel` and never a `gen:` target. A request with `durationSecs = 0` resolves to the policy default before minting (default 900 s for `process`, 300 s for `kernel`). It is materialised by `Broker.debug` → `DebugAttach.attach` (§7.5.1): `warden` spawns the debugger generation (policy list `debug.debuggers`, e.g. gdb, lldb, perf, bpftrace) with seccomp profile `debug-1`, writes the `kl_debug_pairs` entry, and grants the debugger ambient capabilities: `CAP_SYS_PTRACE` and `CAP_PERFMON` for scope `process` (tracing another dynamic UID and opening cgroup-scoped perf events need them), plus `CAP_BPF` for scope `kernel`. `kl-exec`'s `ptrace_access_check`, `perf_event_open` and `bpf` hooks bound what those capabilities reach to the paired target. Receipts `debug.attach`/`debug.detach`. Inside workbench VMs debugging is unrestricted.
<!-- END protocols §9.3 -->

<!-- BEGIN protocols §10.7 rows=policy\.ref|fleet/approvers (verbatim) -->
> **protocols 10.7 Cross-repository files** (rows for this repository)

A repository MAY read a file written by another repository **only if the file is listed here**; everything else is that repository's private state.

| Path | Format | Writer | Readers |
|---|---|---|---|
| `/etc/keylos/policy.ref` | `keylos.policyref/1` (§20.17) | config | warden, broker |
| `/etc/keylos/fleet/approvers.json` | `keylos.fleetapprovers/1` (§20.23); the only source of org approver keys | config (fleet module) | hearth, rescue (recovery environment), broker |
<!-- END protocols §10.7 rows=policy\.ref|fleet/approvers -->

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

<!-- BEGIN protocols §20.17 (verbatim) -->
> **protocols 20.17 Policy reference (`keylos.policyref/1`)**

`/etc/keylos/policy.ref` (JCS): `{"schema":"keylos.policyref/1","generation":"gen:fsv256:…","digest":"sha256:<JCS digest of the policy generation's manifest>"}`. `warden` mounts that `policy` generation read-only at `/policy` in `broker`'s view; `broker` refuses to start if the mounted generation's manifest digest differs. `BrokerSystem.loadPolicy` switches policy at runtime only to the generation named by the newly activated config generation's `policy.ref`.
<!-- END protocols §20.17 -->

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

<!-- BEGIN protocols §21.3 (verbatim) -->
> **protocols 21.3 Admission**

`RunPodSandbox` carries no container configs, so `cri` admits against the **API server's Pod object** (read with its cluster credential, matched by pod UID); it normalises the Pod into `keylos.podspec/1` (the attributes of the Cedar `PodSpec` entity, §16.1, as JCS JSON) and calls `BrokerSystem.admitPod`. The broker evaluates action `admit` with principal `service:kubelet`. A denial makes `RunPodSandbox` fail with gRPC `PermissionDenied` and the reasons; an `@tier`/`@orgApproval` permit makes `cri` hold the sandbox in `pending-approval` until the approval resolves. `CreateContainer` re-admits when the container config adds anything the admitted Pod object did not contain (image, capability, mount, device). Receipts `pod.admit`/`pod.deny` (cri).
<!-- END protocols §21.3 -->

#### 2.2.8 Durable execution (workflow records, claims, durable decisions)

<!-- BEGIN protocols §7.3.16 (verbatim) -->
> **protocols 7.3.16 `loom.capnp`**

The durable workflow coordinator's public interface (served by `loom`, §20.25) and the attempt interface its activity workers use.

```capnp
@0xc7a1e5d3b2f40038;
using C = import "common.capnp";
using B = import "broker.capnp";

enum WorkflowStatus {             #! text forms (§20.25): running, waiting, paused, blocked-by-authority, outcome-unknown,
                                  #! completed, failed, cancelled, forgotten
  running @0; waiting @1; paused @2; blockedByAuthority @3; outcomeUnknown @4;
  completed @5; failed @6; cancelled @7; forgotten @8;
}

enum ResumePolicy { manual @0; automatic @1; }   #! automatic: loom resumes after restart and reboot without asking (§20.25)

struct DefinitionRef {
  generation @0 :C.Ref;           # generation whose manifest lists the definition in provides.workflows (§6.3)
  name       @1 :Text;            # /.keylos/workflows/<name>.json
  digest     @2 :C.Digest;        #! sha256 of the definition's JCS bytes (keylos.workflow/1, §20.27); a mismatch: kl:integrity
}

struct EnrollSpec {
  definition     @0 :DefinitionRef;
  input          @1 :C.Fd;                  # JCS input document (≤ 1 MiB), validated against the definition's input schema
  scope          @2 :List(B.GrantRequest);  # authority the workflow's attempts may receive, approved once at enrollment
  budgets        @3 :List(B.Budget);        # workflow-lifetime ceilings: one durable budget account (§20.25)
  resume         @4 :ResumePolicy;
  runWhileLocked @5 :Bool;                  #! keeps executing while the owner is locked; requires presence at enrollment
  horizonSecs    @6 :UInt64;                # lifetime bound; 0 = policy default; capped by policy
  reason         @7 :Text;                  # shown on the enrollment prompt
  idempotencyKey @8 :Text;                  # a repeated enroll by the same owner with the same key returns the same workflow
}

struct WorkflowInfo {
  id             @0 :Text;          # wf-…
  run            @1 :Text;          # wr-…
  definition     @2 :DefinitionRef;
  owner          @3 :Text;          # the owning human (_system for system workflows)
  status         @4 :WorkflowStatus;
  detail         @5 :Text;          # status detail code (§20.25), e.g. "decision:dr-…", "locked", "effect:fx-…"
  step           @6 :Text;          # current ws-…
  epoch          @7 :UInt64;        # current ownership epoch
  label          @8 :C.Label;       # accumulated workflow label
  resume         @9 :ResumePolicy;
  runWhileLocked @10 :Bool;
  created        @11 :C.Timestamp;
  updated        @12 :C.Timestamp;
  horizon        @13 :C.Timestamp;
  budget         @14 :Text;         # ba-…
  spent          @15 :List(B.Budget);
  remaining      @16 :List(B.Budget);
}

struct WorkflowEvent {
  seq      @0 :UInt64;              # per-workflow event number (the n of the workflow.* receipts, §20.25)
  time     @1 :C.Timestamp;
  workflow @2 :Text;
  union {
    status   @3 :WorkflowStatus;
    step     @4 :Text;              # ws-… entered
    attempt  @5 :C.AttemptBinding;  # a claim
    decision @6 :Text;              # dr-… requested or resolved
    effect   @7 :Text;              # JCS {"effect": "fx-…", "state": "<EffectState>"}
    label    @8 :C.Label;           # the workflow label rose
    note     @9 :Text;
  }
}

interface Workflow {
  info    @0 () -> (info :WorkflowInfo);
  history @1 (fromSeq :UInt64, limit :UInt32) -> (events :List(WorkflowEvent), next :UInt64);
  watch   @2 (watcher :C.Watcher(WorkflowEvent)) -> (cancel :C.Cancelable);
  pause   @3 (reason :Text) -> (info :WorkflowInfo);
  resume  @4 () -> (info :WorkflowInfo);             #! Cedar action resume (§16.1) evaluated for the caller
  cancel  @5 (reason :Text) -> (info :WorkflowInfo);
      #! durable: returns only after the broker's cancellation record, loom's tombstone and the workflow.cancel receipt (§20.25)
  forget  @6 () -> ();                                #! cancels first when needed, then crypto-shreds the history (§20.25)
  signal  @7 (name :Text, key :Text, payload :C.Fd) -> (seq :UInt64);
      #! external input, labelled with the caller's session label; deduplicated by (name, key); same key, other bytes: kl:conflict
  resolve @8 (effect :Text, outcome :Text, note :Text) -> (info :WorkflowInfo);
      #! owner resolution of an outcome-unknown effect: outcome "succeeded" | "failed" (§20.26); never re-dispatches the effect
  migrate @9 (to :DefinitionRef) -> (info :WorkflowInfo);
      #! explicit migration to a definition whose migrateFrom names the pinned one (§20.27); a new run; needs approval
}

interface Loom {
  enroll    @0 (spec :EnrollSpec) -> (workflow :Workflow, info :WorkflowInfo);
      #! the workflow is waiting ("decision:dr-…") until the broker's enrollment decision; it never runs before it
  workflows @1 (owner :Text, includeTerminal :Bool) -> (list :List(WorkflowInfo));
  open      @2 (id :Text) -> (workflow :Workflow);   #! kl:not-found for workflows the caller may not see
}

struct Observation {
  kind    @0 :Text;                 # "model" | "tool" | "clock" | "random" | "signal" | "other"
  key     @1 :Text;                 # deterministic position within the step, e.g. "model:3"; unique per step
  request @2 :C.Digest;             # sha256 of the request that produced it (absent for clock and random)
  body    @3 :C.Fd;                 # the observed bytes (≤ 64 MiB)
  label   @4 :C.Label;              # label of the observed data
}

interface AttemptHost {             # facet attempt (bound to the attempt session warden registered), and via LoomSystem.attempt
  task      @0 () -> (binding :C.AttemptBinding, activity :Text, input :C.Fd, label :C.Label, deadline :C.Timestamp);
  recorded  @1 (key :Text) -> (found :Bool, obs :Observation);
      #! replay: the observation an earlier attempt of the same step recorded under key
  record    @2 (obs :Observation) -> (seq :UInt64);
      #! durable before return; the workflow label rises to obs.label; same key with other bytes: kl:conflict
  effect    @3 (name :Text, requestDigest :C.Digest) -> (effect :Text);
      #! registers the step's named effect and returns its EffectId (§3.5), durable before return; same name with another
      #! request digest: kl:conflict
  complete  @4 (result :C.Fd, label :C.Label) -> ();   #! durable before return; ends the attempt
  fail      @5 (error :Text, retryable :Bool) -> ();
  heartbeat @6 () -> ();                               #! kl:conflict once a newer epoch is claimed; kl:revoked once cancelled
}
```

Every method of `AttemptHost` fails `kl:conflict` when the caller's attempt is not the workflow's current claim (a stale epoch), so a stale worker can neither record nor complete anything (§20.25).
<!-- END protocols §7.3.16 -->

<!-- BEGIN protocols §7.5.25 (verbatim) -->
> **protocols 7.5.25 `loom-sys.capnp`**

The system contracts of durable execution (§20.25, §20.26): durable effects and workflow budget accounts (gate), workflow records, claims and durable decisions (broker), agent attempts (aide) and attempt observations (loom).

```capnp
@0xc7a1e5d3b2f40039;
using C = import "common.capnp";
using B = import "broker.capnp";
using G = import "gate.capnp";
using P = import "prompt.capnp";
using L = import "loom.capnp";

enum RetryStrategy { transactional @0; downstreamIdempotency @1; reconciliation @2; noSafeRetry @3; }   #! §20.26

enum EffectState {                #! §20.26: authorized is not completion; only succeeded/failed are confirmed outcomes
  prepared @0; awaitingApproval @1; authorized @2; dispatching @3;
  succeeded @4; failed @5; outcomeUnknown @6; cancelled @7; compensated @8;
}

struct EffectSpec {
  effect  @0 :Text;                # fx-… from AttemptHost.effect
  binding @1 :C.AttemptBinding;    # the preparing attempt; MUST match the token's workflow fact (§8.2)
  intent  @2 :G.EffectIntent;      # kind, class, target, args, payload; idempotencyKey MUST be empty (the effect id is the key)
}

struct EffectRecord {
  effect        @0 :Text;            # fx-…
  workflow      @1 :Text;            # wf-…: the owner of the effect (never a session)
  state         @2 :EffectState;
  strategy      @3 :RetryStrategy;   #! declared by the executor, fixed at prepare (§20.26)
  kind          @4 :Text;
  target        @5 :Text;
  requestDigest @6 :C.Digest;        #! §20.26; a later prepare with the same effect id and another digest: kl:conflict
  payloadDigest @7 :C.Digest;
  decision      @8 :Text;            # dr-… when an approval was required
  intent        @9 :Text;            # e-… of gate's outbox intent
  epoch         @10 :UInt64;         # ownership epoch that last authorized or dispatched it
  dispatched    @11 :C.Timestamp;
  dedupUntil    @12 :C.Timestamp;    # end of the destination's deduplication window (downstreamIdempotency); 0 otherwise
  outcome       @13 :Text;           # JCS: executor result (succeeded, failed) or the reason (outcomeUnknown)
  receipts      @14 :List(Text);     # rcpt refs of the authorization and completion receipts
  retainUntil   @15 :C.Timestamp;    #! the dedup record is kept at least until then (§20.26)
}

interface DurableEffects {         # gate; facets client and aide: prepare, complete, lookup, watch; facet loom: all except prepare
  prepare   @0 (spec :EffectSpec, token :C.Token) -> (record :EffectRecord);
      #! stages the effect for its workflow (the token's principal is the attempt session); durable before return; idempotent
      #! per effect id with an equal request digest; a stale epoch: kl:conflict
  commit    @1 (effect :Text, binding :C.AttemptBinding) -> (record :EffectRecord);
      #! facet loom: authorizes with BrokerWorkflow.authorizeEffect (current policy, durable decision) and dispatches per strategy;
      #! returns the record when it is awaitingApproval, has a confirmed outcome, or is outcomeUnknown
  complete  @2 (effect :Text, receipt :Text) -> (record :EffectRecord);
      #! caller-executed kinds (§14.2): the executor's completion receipt (rcpt ref) is the authenticated outcome
  lookup    @3 (effect :Text) -> (record :EffectRecord);      #! durable lookup by effect id (facet client/aide: own workflow only)
  watch     @4 (effect :Text, watcher :C.Watcher(EffectRecord)) -> (cancel :C.Cancelable);
  cancel    @5 (effect :Text, reason :Text) -> (record :EffectRecord);
      #! prepared or awaitingApproval → cancelled; from authorized on it cannot be cancelled (record returned unchanged)
  reconcile @6 (effect :Text) -> (record :EffectRecord);      # run the executor's reconciliation now (strategy reconciliation)
  resolve   @7 (effect :Text, outcome :Text, mandate :Data) -> (record :EffectRecord);
      #! outcomeUnknown → succeeded | failed on the owner's decision (mandate kind workflow.decide bound to the record, §14.4)
  forget    @8 (workflow :Text) -> ();
      #! forgotten workflow: shreds its payloads (unit gate:<owner>:<wf-id>); keeps the minimal dedup records (§20.26)
}

struct BudgetEntry { key @0 :Text; state @1 :Text; amount @2 :List(B.Budget); }   # state "reserved" | "settled" | "released" | "unresolved"

interface WorkflowBudget {         # gate; facet broker: open, close, status; facet loom and facet aide: reserve, settle, release, status
  open    @0 (account :Text, workflow :Text, ceilings :List(B.Budget)) -> ();   #! idempotent; same account, other ceilings: kl:conflict
  reserve @1 (account :Text, key :Text, amount :List(B.Budget)) -> (entry :BudgetEntry);
      #! idempotent per (account, key); kl:budget when spent + reserved + unresolved + amount exceeds a ceiling
  settle  @2 (account :Text, key :Text, actual :List(B.Budget), outcome :Text) -> (entry :BudgetEntry);
      #! once per key: replaces the reservation by actual; outcome "unknown" keeps it as unresolved (still counted); a repeat with
      #! equal values returns the entry, with other values kl:conflict
  release @3 (account :Text, key :Text) -> (entry :BudgetEntry);   # drops an unsettled reservation; idempotent
  status  @4 (account :Text) -> (ceilings :List(B.Budget), reserved :List(B.Budget), spent :List(B.Budget), unresolved :List(B.Budget));
  close   @5 (account :Text) -> ();   # terminal workflow: no further reservations; spent amounts stay recorded
}

struct EnrollRequest {
  workflow       @0 :Text;            # wf-…
  definition     @1 :L.DefinitionRef;
  inputDigest    @2 :C.Digest;
  scope          @3 :List(B.GrantRequest);
  budgets        @4 :List(B.Budget);
  resume         @5 :L.ResumePolicy;
  runWhileLocked @6 :Bool;
  horizonSecs    @7 :UInt64;
  reason         @8 :Text;
  account        @9 :Text;            # ba-… the broker opens with WorkflowBudget.open when the enrollment is approved
}

struct DecisionRecord {
  id       @0 :Text;                  # dr-…
  workflow @1 :Text;
  key      @2 :Text;                  # logical operation, e.g. "enroll", "effect:fx-…", "grant:<name>", "decide:<ws-…>"
  digest   @3 :C.Digest;              #! sha256 of the JCS {workflow, key, requests, effects}: never a session or attempt (§20.25)
  state    @4 :Text;                  # "pending" | "approved" | "denied" | "expired" | "cancelled"
  approval @5 :Text;                  # boot-local a-… of the prompt currently shown; empty when none
  mandate  @6 :Data;                  # the delivered mandate (§14.4) when approved
  expires  @7 :C.Timestamp;           #! fixed when decided; never extended by a rebind or a later attempt
}

struct DecisionEffect { kind @0 :Text; target @1 :Text; digest @2 :C.Digest; rendered @3 :List(P.RenderedEffect); }

struct WorkflowRecordInfo {
  workflow       @0 :Text;
  owner          @1 :Text;
  state          @2 :Text;            # "enrolling" | "active" | "cancelled" | "forgotten"
  epoch          @3 :UInt64;          # highest claimed ownership epoch
  attempt        @4 :Text;            # wa-… of that claim
  label          @5 :C.Label;         # workflow label high-water mark
  horizon        @6 :C.Timestamp;
  account        @7 :Text;            # ba-…
  resume         @8 :L.ResumePolicy;
  runWhileLocked @9 :Bool;
  definition     @10 :L.DefinitionRef;
}

interface BrokerWorkflow {         # broker, facet workflow (holders per §19.2)
  enroll   @0 (subject :C.SessionId, req :EnrollRequest) -> (decision :DecisionRecord);
      #! loom: Cedar action enroll for the subject (the owner's session) plus every scope item as a persistent request (§20.25)
  claim    @1 (binding :C.AttemptBinding, generation :C.Ref, spawner :C.SessionId) -> (record :WorkflowRecordInfo);
      #! loom: binding.epoch MUST be record.epoch + 1 (else kl:conflict); persisted before return; revokes every root of
      #! earlier attempts; generation and spawner are the only ones allowed to register this attempt (SessionReg.attempt)
  verify   @2 (binding :C.AttemptBinding, session :C.SessionId) -> (record :WorkflowRecordInfo);
      #! gate, strata, bench, aide: binding is the current claim and session belongs to it; else kl:conflict (stale) or kl:revoked
  decide   @3 (binding :C.AttemptBinding, key :Text, requests :List(B.GrantRequest), effects :List(DecisionEffect)) -> (decision :DecisionRecord);
      #! durable logical request: deduplicated by (workflow, key) and the digest, never by session; persisted before any prompt
  rebind   @4 (decision :Text, binding :C.AttemptBinding, session :C.SessionId) -> (result :B.GrantOutcome);
      #! explicit use of an approved decision by a fresh attempt: revalidated against current policy, revocation and expiry;
      #! grants are minted for session; never extends expiry or presence
  authorizeEffect @5 (binding :C.AttemptBinding, effect :Text, kind :Text, target :Text, payloadDigest :C.Digest,
                      rendered :List(P.RenderedEffect)) -> (decision :DecisionRecord);
      #! gate: current authority for one workflow effect (record, policy, Rule of Two with the workflow label, epoch); approved
      #! immediately (no prompt, empty mandate) or through a durable decision with key "effect:<fx-…>"
  offer    @6 (binding :C.AttemptBinding) -> (tokens :List(C.Token));
      #! aide: path and net tokens of the workflow scope bound to aide's own session, expiring after 120 s, for building the
      #! shares and offered tokens of the attempt's VM (§20.25)
  resume   @7 (subject :C.SessionId, workflow :Text) -> (decision :DecisionRecord);   # loom: Cedar action resume for the subject
  cancel   @8 (subject :C.SessionId, workflow :Text, reason :Text, forget :Bool) -> (record :WorkflowRecordInfo);
      #! loom (subject = the cancelling session, Cedar action cancel; empty subject for loom's own forget of a deleted user's
      #! workflows, §20.25): durable cancellation and
      #! revocation record, persisted before return; revokes every root of the workflow; refuses every later claim
  record   @9 (workflow :Text) -> (record :WorkflowRecordInfo);   # loom, gate, strata
  raise    @10 (workflow :Text, label :C.Label, reason :Text) -> (label :C.Label);
      #! loom: raises the workflow label high-water mark (labels only go up), persisted before return
  cancelDecision @11 (decision :Text, reason :Text) -> (decision :DecisionRecord);
      #! loom, gate: withdraws one pending durable decision (its prompt is closed); idempotent; a decided one is returned unchanged
}

interface AgentWorkflowHost {      # aide, facet loom
  startAttempt @0 (binding :C.AttemptBinding, template :C.Ref, task :Text, input :C.Fd, label :C.Label) -> (session :C.SessionId);
      #! starts an agent session as the attempt (VmSpec.attempt); the harness reaches loom only through aide
  stopAttempt  @1 (binding :C.AttemptBinding, mode :Text) -> ();   # mode "cancel" | "fence" | "pause"
  status       @2 (binding :C.AttemptBinding) -> (json :Text);
}

interface LoomSystem {             # loom, facet aide
  attempt         @0 (binding :C.AttemptBinding, session :C.SessionId) -> (host :L.AttemptHost);
      #! the AttemptHost of an agent attempt aide started; aide records every model and host-tool observation through it
  ended           @1 (binding :C.AttemptBinding, reason :Text) -> ();
      #! the attempt ended without complete/fail: "crashed" | "paused" | "breaker" | "deadline" | "vm-lost"; never a cancellation
  cancelRequested @2 (binding :C.AttemptBinding, subject :C.SessionId, reason :Text) -> ();
      #! the human stopped the attached agent session (AgentSession.stop): loom treats it as Workflow.cancel by subject
}
```
<!-- END protocols §7.5.25 -->

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

<!-- BEGIN protocols §20.26 (verbatim) -->
> **protocols 20.26 Effect executor contract**

Every workflow effect is a **durable effect record** in `gate` (`DurableEffects`, §7.5.25), owned by its workflow and identified by its effect ID, independent of the attempt sessions that prepare, authorize or observe it. Ordinary intents (§7.3.7) keep their own rules; a durable effect is also an outbox intent (`EffectRecord.intent`) and appears in `Gate.intents` of the preparing session.

**States.** `prepared` → (`awaitingApproval` →) `authorized` → `dispatching` → `succeeded` | `failed` | `outcomeUnknown`; `prepared` and `awaitingApproval` → `cancelled`; `succeeded` → `compensated` (compensable kinds). `authorized` means only that the effect may be performed now: it is recorded by `effect.commit` and is never reported as completion. Only `succeeded` and `failed` are confirmed outcomes (receipt `effect.complete`); `outcomeUnknown` (receipt `effect.unknown`) is an explicit state, not a failure. For caller-executed kinds (§14.2) gate moves the record to `authorized` and returns the mandate; the executor's own completion receipt, presented through `DurableEffects.complete`, is the authenticated outcome that moves it to `succeeded` or `failed`.

**Request digest.** `requestDigest` = SHA-256 of the JCS `{"effect", "workflow", "kind", "class", "target", "args": [{"name", "value", "source", "label": {"conf", "integ"}}…] (sorted by name, without `x-subject-token`), "payloadDigest", "compensator"}` (class and label values as their enumerant names; `compensator` `null` when empty). It binds the effect ID to exactly one request: `prepare` with an existing effect ID and an equal digest returns the existing record; with another digest it fails `kl:conflict`, so a payload can never change under an existing effect ID. The mandate binds the payload digest (§14.4) and `constraints.workflow` the workflow.

**Authorization at commit.** `DurableEffects.commit` (facet `loom`) requires the binding to be the workflow's current claim, then calls `BrokerWorkflow.authorizeEffect` with the record's kind, target, payload digest and gate's required renderings. The broker revalidates the workflow record (not cancelled, not past its horizon), the owner's eligibility, current policy and revocation, the Rule of Two with the workflow label, and the budget; it answers approved (no approval needed) or with the durable decision of key `effect:<fx-…>`. The record waits in `awaitingApproval` (`decision`) until the decision is approved; loom observes the decision only through `commit` and re-issues `DurableEffects.commit` with its current claim at its poll interval (and with a fresh claim after a restart) while the record waits (gate answers from its record, the broker returns the existing decision; `DurableEffects.watch` is optional). A denied or expired decision, or a policy denial by `authorizeEffect`, moves the record to `cancelled` with outcome `{"reason": "decision-denied" | "decision-expired" | "policy-denied"}`, which loom reports as the commit outcome `denied`; any other `cancelled` record is the commit outcome `cancelled`. Once the decision is approved, gate verifies the delivered mandate (§14.4, `constraints.workflow`, payload digest, expiry) and consumes it: the transition to `authorized`, the mandate's single use and the effect ID are committed atomically, so a decision is consumed at most once and an effect ID is authorized at most once.

**Retry strategies.** Every executor declares exactly one strategy for every (kind, target) it executes; gate records it at `prepare` and never changes it for an existing record. A missing or unverifiable declaration is `noSafeRetry`.

| Strategy | Requirement on the executor | After a crash or a lost reply in `dispatching` |
|---|---|---|
| `transactional` | The operation and its completion record commit atomically inside the executing service, keyed by a stable ID (for `fs.merge`: the prepared merge and its `PreparedMerge.status`, `BenchMerge.commitPrepared`) | Look up the completion record: present → its outcome; absent → the operation did not happen and may be dispatched again under the same effect ID |
| `downstreamIdempotency` | The destination enforces the effect ID as key together with payload identity for a documented window W; gate's configuration MUST declare that destination `verified` with W. Sending an `Idempotency-Key` header alone is not proof | Re-send with the same key while now < `dedupUntil` (first dispatch + W); afterwards → `outcomeUnknown`, never a blind repeat |
| `reconciliation` | A registered reconciler queries authoritative destination state by the effect ID or the payload digest (for example the remote ref equals the pushed commit); a view that is only eventually consistent, or absence from a sent folder, is never proof of non-execution | `present` → `succeeded`; authoritative `absent` → may dispatch again; anything else → `outcomeUnknown` |
| `noSafeRetry` | none | → `outcomeUnknown` |

Retries reuse the effect ID; a retry never happens after the record left `dispatching` for a confirmed outcome, and a record in `outcomeUnknown` is never dispatched again automatically, whatever the strategy, after its window expired.

**Resolving an unknown outcome.** `outcomeUnknown` ends only by reconciliation (`DurableEffects.reconcile`) or by the owner (`Workflow.resolve` → `DurableEffects.resolve` with a `workflow.decide` mandate bound to the record; presence for irreversible kinds). The resolution mandate's effect is `{"kind": "workflow.decide", "target": "<fx-…>", "digest": "sha256:" + SHA-256(JCS({"effect": "<fx-…>", "outcome": "succeeded" | "failed"}))}`. The owner's resolution records `succeeded` or `failed`; it never re-dispatches the effect ID. Repeating the operation needs a new step occurrence and therefore a new effect ID, with its own authorization.

**Cancellation and compensation.** `DurableEffects.cancel` cancels a `prepared` or `awaitingApproval` record (and its pending decision); from `authorized` on the record cannot be cancelled and its outcome is settled as above. Compensation of a succeeded effect is `Intent.compensate` for its intent where a compensator is registered, or a new effect with its own effect ID; neither is a rollback guarantee.

**Dedup retention.** Retention is part of correctness. gate keeps every record (effect ID, workflow, request and payload digests, strategy, state, outcome, receipts, `dedupUntil`) at least until the latest of: the workflow's horizon (from the broker's record), `dedupUntil`, and 30 days after the record reached a terminal state; a record that is not terminal is never deleted. Payload blobs are kept until the record is terminal plus 7 days, or until the workflow is forgotten (`DurableEffects.forget`), which shreds them and keeps the minimal record. A workflow never runs past its horizon (the broker refuses its claims), so no workflow can re-request an effect ID whose record was deleted.

**Executors behind gate.** gate's kind registry declares the strategy per executor: `BenchMerge.commitPrepared` (`fs.merge`) is `transactional`; HTTP replay is `downstreamIdempotency` only for destinations configured as `verified`, otherwise `reconciliation` where a reconciler is registered (`git.push`: the remote ref; `git.pr.open`: a search by head branch and the effect ID in the body), otherwise `noSafeRetry`; SMTP is `reconciliation` only with an IMAP rule whose provider is configured as strongly consistent, otherwise `noSafeRetry`; `net.listen` is `transactional`; caller-executed kinds are `noSafeRetry` unless the executor documents a completion lookup.
<!-- END protocols §20.26 -->

### 2.3 Interpretation notes (normative for this repo)

1. **Facets.** The broker serves exactly the facets of protocols §19.2: `principal` (`Broker`), `system` (`BrokerSystem` plus `Broker.inspect`) and `label-authority` (`LabelAuthority`). `BrokerSystem` and `LabelAuthority` are obtained through `Extensible.ext` on the bootstrap of a `system` or `label-authority` route, or are the bootstrap's primary interface (protocols §7.5).
2. **Per-method callers on `system`.** The comments in protocols §7.5.2 name the expected caller of each `BrokerSystem` method. The broker enforces them by the peer's service name as delivered in `ServiceHost.accept` (§4.1.1): a `system` caller other than the named one receives `kl:denied`.
3. **Approval channels.** The broker sets `ApprovalPrompt.channels` (protocols §7.3.4) from the selected permit's `@channels` annotation, filtered by the channel-selection rule of protocols §14.3: `phone` only if a `vouchd` approver key is registered in this boot, `org` only for `@orgApproval` permits on fleet-enrolled machines. The same list is also written to the mandate draft as `constraints.channels` (a real `keylos.mandate/1` member, protocols §14.4, E2; never an `x-` member, which would carry no authority), so that the signed mandate records which channels were permitted. The broker rejects a returned decision whose `channel` is not in the list (a `quorum` decision substitutes for presence and need not be listed).
4. **Approver keys.** `registerApprover(publicKey, alg, channel)` binds each key to exactly one channel. Callers: `atrium` (channel `local`, its trusted-path approver key) and `vouchd` (channel `phone`, the paired phone's approval key). A caller may only register its own channel; a second key for the same `(caller, channel)` in one boot replaces the first. Every registration is receipted as `approval.request{kind: "approver-registration", channel, keyid}` (§9). The broker accepts a non-presence decision only if its signer's bound channel equals the decision's `channel` (§4.4.4).
5. **Mandates as delivered.** Decision signatures (atrium, phone, `approver/<id>`) stay inside the broker. Every non-presence mandate the broker returns through `Approval.mandate` or `GrantResult.mandate` is the decided payload **re-signed by `service/broker`** (protocols §14.4); presence-signed (or quorum-signed) mandates are returned as decided. The `approval.decide` receipt carries `mandateDigest`, the SHA-256 of the delivered envelope bytes.
6. **Quorum machines.** On profiles whose owner registry has `policy.mode = "quorum"` (protocols §5.4) every place where this spec says "presence" means "a quorum presence envelope", obtained through `HearthQuorum` (§4.17).
7. **Mandate effect kinds** (protocols §14.2, §14.4, E2, E3). Broker mandates use the mandate-only kinds `grant.<resource kind>` (with the E3 GrantRequest digest), `grant.declassify`, `debug.attach` and `pod.admit`; intents keep the kinds `gate` supplies. A mandate draft (`ApprovalPrompt.mandateDraft`, placeholder `decidedBy: ""` and `channel`) is not a valid `keylos.mandate/1` until the decider fills `decidedBy` and `channel`; the broker validates the decided payload, never the draft.
8. **Path rights** (protocols §8.2, E14). Path rights are `right("path", <rel>, op)` with the root named by `path_root(<fdkey>)`; every broker path token carries exactly one `path_root`. A **relative** path in `materialize` is resolved inside the token's granted subtree when the token names exactly one path prefix (so `a.txt` under a `Documents` grant works), else relative to the root; absolute paths map by longest prefix against the canonical root path.
9. **Development knobs.** `KEYLOS_DEV_BROKER_POLICY_DIR` (stand-in for the `/policy` mount) and `KEYLOS_DEV_BROKER_IMPLICIT_SESSIONS` are read only by development builds (protocols §10.5, E8). Production builds refuse a `broker#principal` peer that was never registered with `registerSession` (`kl:denied`, REQ-BROKER-002); the development knob registers such a peer implicitly on first contact with the parent's label (or bottom).
10. **Durable state.** The broker's persistent and restart-surviving files (`grants/`, `suspended/`, `workflows/`, `decisions/`, `roots.log`, `idem.log`, `agent-hosts.db`) are written with `fsync` of the file and, for creations, renames and deletions, of its parent directory before the operation is acknowledged or the result returned. Request deduplication (REQ-BROKER-105) is a 24-hour, boot-scoped convenience for retries; it is not a durable approval or effect identity and MUST NOT be relied on by callers that wait longer or across reboots.
11. **Two kinds of deduplication.** `requestFor`'s idempotency table (REQ-BROKER-105) is keyed by `(caller, idempotencyKey)` and the digest of `{subject, req, intent}`, so it includes the subject session and dies with the boot; it stays exactly as specified for non-workflow callers. Durable workflow decisions (REQ-BROKER-186) are keyed by `(workflow, key)` and a digest that contains no session, attempt or prompt ID (protocols §20.25), so a fresh attempt after a reboot finds the same decision. A workflow caller never uses `requestFor` for workflow operations, and a `requestFor` key never matches a durable decision.
12. **Workflow principal entity.** Decisions made for a workflow without a live requesting session (attempt registration, `authorizeEffect`, `decide`) use the principal entity of protocols §16.1 "Workflow decisions", built from the workflow record (kind of the activity's generation, human = owner, `depth` 1, label = the record's high-water mark) with `context.workflow` and `context.epoch`; the agent floors of §4.4.3 apply when the kind is `agent`.

---

## 3. Requirements

### 3.1 Identity and sessions

- **REQ-BROKER-001** The broker MUST determine the caller of every method from the capwire connection: the `peer`, `facet`, `tier` and `generation` delivered by `ServiceHost.accept`, or `Supervisor.connectionInfo(connectionId)`. It MUST NOT trust principal or session values that appear inside request parameters, except where a `BrokerSystem` method explicitly names a subject session and the caller is the service the method is reserved for.
- **REQ-BROKER-002** The broker MUST keep a session table entry for every live session that `warden` registers with `BrokerSystem.registerSession`; a `principal` caller with no entry fails `kl:denied` (development builds: §2.3 note 9). `SessionReg` carries no tier: the child's tier defaults by actor kind and is replaced by the tier `ServiceHost.accept` reports on its first connection. The entry holds: principal, parent session, label, label history, delegation depth, fan-out count, token root IDs, `onRevoke` mode, frozen flag.
- **REQ-BROKER-003** A child session's initial label MUST equal its parent's current label at registration time. System services registered with an empty parent start at `{public, trusted}`.
- **REQ-BROKER-004** On `sessionEnded`, the broker MUST revoke every root minted for that session that is not backed by a persistent grant record, detach its grant mounts, and drop the entry after 60 s so late receipts can still resolve.

### 3.2 Policy

- **REQ-BROKER-010** The broker MUST evaluate every `request`, `requestFor`, `delegate`, `powerbox` decision and declassification with `cedar-policy` in strict validation mode against the protocols §16.1 schema.
- **REQ-BROKER-011** The broker MUST load policy only from a `policy` generation that `warden` mounts read-only at `/policy` in the broker's view, and only the generation named by `/etc/keylos/policy.ref` (`keylos.policyref/1`, protocols §20.17) in the broker's config view (§4.9). At startup and on every `loadPolicy` the broker MUST compute the SHA-256 of the JCS bytes of `/policy/.keylos/manifest.json` and compare it with `policy.ref`'s `digest`; on mismatch it MUST refuse to start (startup) or fail `kl:integrity` (`loadPolicy`) and keep the previous policy.
- **REQ-BROKER-012** A policy that fails validation MUST NOT be activated. `loadPolicy` fails with `kl:invalid` carrying the first problem; the previous generation stays active.
- **REQ-BROKER-013** Decision mapping is exactly protocols §16.2 (protocols wins): several matching permits combine to the **most restrictive** requirement — the highest `@tier`, presence if any permit requires it, every `@orgApproval` group, and the intersection of the `@channels` sets (empty intersection → deny); `keylos_labels::tier::decision_tier` implements it. No policy can lower an approval below the floors of §4.4.3.
- **REQ-BROKER-014** If `/etc/keylos/policy.ref` does not exist (first boot before the first config apply, or the safe config of the OS generation), the broker MUST run the compiled-in default policy set (§10.3). If it exists, REQ-BROKER-011 applies and there is no fallback to the default set.
- **REQ-BROKER-015** On fleet-enrolled machines, the org `forbid` policies shipped in the policy generation (`/policy/org/*.cedar`) MUST be part of the active policy set and MUST NOT be overridable by owner permits.

### 3.3 Tokens

- **REQ-BROKER-020** At startup the broker MUST generate a fresh Ed25519 root keypair from `getrandom`. The private key MUST be held in memory allocated with `memfd_secret` (or `mlock`ed and `MADV_DONTDUMP` memory if `memfd_secret` is unavailable). Its only copy outside that memory is the `FdStore` entry of §4.10. It MUST NOT be written to persistent storage or swap.
- **REQ-BROKER-021** Authority blocks MUST use only the protocols §8.2 facts.
- **REQ-BROKER-022** Every minted token MUST carry `principal`, `session`, `root_id` and `expires`. Every token for a non-`shell` principal MUST carry `tier_floor`.
- **REQ-BROKER-023** Default durations: 8 h for `shell` and app principals, 30 min for agent principals, policy-overridable. `expires` MUST NOT exceed 7 days. Tokens are invalid after reboot because the root key rotates; persistent grants are re-minted.
- **REQ-BROKER-024** `inspect` MUST verify the signature and check revocation before returning facts, and otherwise fail with `kl:integrity` or `kl:revoked`.
- **REQ-BROKER-025** `attenuate` MUST only append blocks and MUST reject checks that reference facts outside protocols §8.3 with `kl:invalid`.

### 3.4 Materialization

- **REQ-BROKER-030** `materialize` MUST, in order: verify the token; check revocation; verify that the token's `session` is the caller's session or an ancestor of it; authorize the operation with a Biscuit authorizer populated with the protocols §8.3 ambient facts; evaluate the Rule of Two (§4.6) for the resulting label; raise the session label through the label authority; only then produce the handle.
- **REQ-BROKER-031** Path resolution MUST use `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV`, relative to the held root identified by `path_root`. The broker MUST NOT resolve caller-supplied absolute paths by any other means.
- **REQ-BROKER-032** Directory grants for host-confined principals (tiers t0, t1, legacy) MUST be attached into the holder's mount namespace through `GrantMounts.attachGrant` (protocols §7.5.1). The returned handle MUST be the `inView` fd, and `PowerboxGrant.viewPath` MUST be the returned `viewPath`.
- **REQ-BROKER-033** Network materialization MUST return a socket obtained from `Gate.connect` on facet `gate#broker`. The broker MUST NOT open network sockets itself.
- **REQ-BROKER-034** `materialize` for `spawn`, `effect`, `budget` and `delegate` resources MUST fail with `kl:invalid`. Those rights are checked where they are used (`warden`, `gate`, the broker's own `delegate`).
- **REQ-BROKER-035** Runtime directory and file grants to VM principals (tiers t2, t3, pod VMs) MUST NOT use `GrantMounts.attachGrant` (the VM has no host mount namespace). For a VM principal, `materialize` of a `path`/`dirFd` grant and `powerbox` MUST return an `O_PATH` (directory) or opened (file) fd to the caller, which is always `bench-relay` acting as the VM principal; `bench-relay` hot-plugs it into the guest with `Vm.attachShare` (protocols §7.3.13, §7.5.10 `GuestPortals.powerbox`). `PowerboxGrant.viewPath` is empty for VM principals. Calls of this kind from any other process of a VM principal's cgroup fail `kl:denied`.

### 3.5 Labels and the Rule of Two

- **REQ-BROKER-040** Session labels MUST be monotonic within a session.
- **REQ-BROKER-041** The broker MUST raise the session label at materialization time, before the handle is produced: for files to the label of the object; for directories to the grant's exposure label (ceiling) of §4.6.2, which it also passes to `GrantMounts.attachGrant` (protocols §7.5.1, §14.1, E31); for network sockets to the host's response label; for secrets to `secret`.
- **REQ-BROKER-042** The broker MUST refuse to issue or materialize a handle that would make the session hold U, P and X together (protocols §14.1). Such requests become a declassification approval at T3 (§4.7) unless an accepted flow proof covers them.
- **REQ-BROKER-043** `raiseLabel` and `LabelAuthority.raiseFor` MUST NOT lower any dimension. A request that would lower one returns the unchanged current label and writes no receipt; a request that raises writes a `label.raise` receipt.
- **REQ-BROKER-044** `LabelAuthority.raiseFor` MUST be served only on facet `label-authority` and MUST apply to any live session, including sessions of other humans, because the holders are tier-0 data-handoff services (protocols §14.1).

### 3.6 Approvals

- **REQ-BROKER-057** **Required renderings** (protocols §7.3.4, §14.2, §14.3, E33). Every `RenderedEffect` the broker puts in an `ApprovalPrompt` MUST carry `payloadDigest` = the digest of the mandate-draft effect it presents and `review = required`, unless the broker or `gate` itself produced it as an optional preview (`decorative`); a requester-supplied rendering is never `decorative`. For every draft effect the prompt MUST contain the required review details of protocols §14.2; when `gate`'s renderings (through `checkFlow`/`requestFor`) do not cover them, the broker uses the canonical-text fallback, and if that cannot present them within the limits the approval is created with Approve disabled (atrium shows Deny/Defer only). A returned decision that approves a prompt whose required renderings were incomplete MUST be rejected (`kl:integrity`) and recorded as `approval.decide{outcome: "rejected", reason: "incomplete-rendering"}`.
- **REQ-BROKER-050** Approvals at T2 and T3 MUST be obtained through `TrustedPrompt.approve` on `atrium#approve`, or, for permits annotated `@orgApproval("<group>")`, through `OrgDecider.decide` on `fleet#decider`. Before acting on a decision the broker MUST verify the mandate: DSSE signature by an accepted signer class (§4.4.4), `approval` ID, `principal`, JCS equality with the draft except `decidedBy`, `presence` and `channel`, `channel` in the allowed list, and `constraints.expires` not passed.
- **REQ-BROKER-051** Any approval of a request with `persist = true` MUST require presence (protocols §14.3). The mandate MUST be presence-signed (protocols §5.3) by an enrolled owner credential, verified with `keylos-presence` against the owner registry obtained from `HearthSystem.owners`.
- **REQ-BROKER-052** T2 requests from one session SHOULD be batched into a single prompt. A batch closes 3 s after its first request, at 10 requests, or when the requesting session blocks on `Approval.wait`, whichever comes first.
- **REQ-BROKER-053** The classifier hook (§4.8) MUST only raise the approval tier. If the classifier errors or times out (default 800 ms), the tier is raised by one level, capped at T3.
- **REQ-BROKER-054** Approval prompts MUST expire after 10 minutes (configurable from 1 to 60 minutes). An expired approval resolves as `denied` with reason `expired`.
- **REQ-BROKER-055** `Approval.mandate` MUST return the verified mandate DSSE after approval, and fail `kl:not-found` before a decision or after a denial. `GrantResult.mandate` returned by `requestFor` and `checkFlow` MUST carry the same bytes when the outcome was decided by approval.
- **REQ-BROKER-056** Phone (`channel: "phone"`) and org (`channel: "org"`) mandates MUST NOT satisfy any decision that requires presence (protocols §14.3).

### 3.7 Delegation and budgets

- **REQ-BROKER-060** `delegate` MUST mint the child's non-budget tokens as new roots, recording the parent root as ancestor, so that revocation cascades and receipts attribute use to the child.
- **REQ-BROKER-061** The child's rights MUST be a subset of the parent's: each child right is authorized against the parent token with the parent's authorizer before minting. An offered token none of whose rights authorize for the child (for example depth beyond `max_depth`) fails the call with `kl:denied`; it is not dropped silently.
- **REQ-BROKER-062** The child's delegation depth MUST NOT exceed the parent's `max_depth − 1`, and the number of live child sessions MUST NOT exceed `max_fanout`.
- **REQ-BROKER-063** `budget` rights MUST be delegated as a **new budget root that is a hard sub-meter** of the parent's budget root: the broker mints the child's budget token with `budget($unit, $childCeiling)` and `budget_parent($parentRoot)` (protocols §8.2) and, before returning it, calls `GateMeterAdmin.carve(parentRoot, childRoot, budgets)` on `gate#broker` (protocols §7.5.12). If `carve` fails with `kl:budget`, the delegation fails with `kl:budget` and no child budget token exists. On `sessionEnded` of the child and on revocation of the child root the broker calls `GateMeterAdmin.release(childRoot)` (§4.5.8).
- **REQ-BROKER-065** A child budget ceiling not given by the delegating caller defaults to the parent's remaining amount divided by `max(1, max_fanout)` (reported by `GateMeterAdmin.meterFor`), rounded down, at least 1 unit.
- **REQ-BROKER-064** Widening a sub-principal's scope after creation is a T2 approval (protocols §14.3).

### 3.8 Revocation

- **REQ-BROKER-070** `revoke(rootId)` is permitted to: the holder of a token with that root; any ancestor root's holder; a `shell` principal of the same human; the `system` facet callers `warden` and `hearth` (through `revokeSession`).
- **REQ-BROKER-071** Revocation MUST cascade to every descendant root, be recorded in the in-memory revocation set and the append log (§4.10), and take effect for every later `materialize` and `inspect` within 50 ms.
- **REQ-BROKER-072** After a revocation the broker MUST call `PrincipalControl.terminate(session, mode)` for every live session that held a revoked root, with mode `kill` (default for agent, bench and internet-origin legacy principals) or `freeze` (default for apps and shell children), detach every grant mount minted from a revoked root (`GrantMounts.detachGrant`), and call `DeviceAdmin.revoke(rootId)` for device roots. Freeze is followed by a T2 notification offering "resume, keep frozen, or kill".

### 3.9 Persistence

- **REQ-BROKER-080** Persistent grants MUST be stored as `keylos.grant/1` DSSE records signed by the broker's `service/broker` key (§4.3).
- **REQ-BROKER-081** At re-mint time (when a matching principal is registered), the broker MUST re-evaluate policy for each grant record and re-mint only if policy still permits it: at T0/T1 without a mandate, or at T2/T3 with the presence-signed mandate the record carries.
- **REQ-BROKER-082** A grant record whose integrity check fails MUST be ignored and reported with a `grant.deny` receipt (reason `integrity`). It MUST NOT be deleted automatically.

### 3.10 Receipts

- **REQ-BROKER-090** Every issue, attenuate, delegate, revoke, deny, label raise, approval request and approval decision MUST produce a receipt (protocols §19.3) before the corresponding result is returned.
- **REQ-BROKER-091** If `ledger` is unavailable, the broker MUST fail closed with `kl:unavailable` for every operation except `inspect`, `label`, `myGrants` and `LabelAuthority.labelOf`, which create no authority. `LabelAuthority.raiseFor` buffers the raise in memory (labels only go up, so applying it early is safe) and writes the receipt when `ledger` returns.

### 3.11 System interface

- **REQ-BROKER-100** `registerSession` MUST verify that every offered token belongs to the parent session (`session` fact equals the parent or an ancestor of it) and is not revoked, mint the child tokens by delegation, re-mint matching persistent grants, and return the `tierFloor` as the maximum `tier_floor` over the returned tokens.
- **REQ-BROKER-101** `requestFor(subject, req, intent, idempotencyKey, intentSession)` MUST evaluate `req` exactly as if `subject` had called `request`, with the approval prompt naming the subject (and the intent, if given), and return the outcome together with the delivered mandate (REQ-BROKER-111).
- **REQ-BROKER-104** **Allowed subjects for `requestFor`** (protocols §7.5.2): `gate` → a session that staged intent `intent`: `subject` MUST equal `intentSession` or be an ancestor of it in the session table, `intentSession` MUST be the session for which `gate` called `checkFlow` with that intent ID in `FlowCheck.intent` (protocols §7.5.2, E23; when it called `checkFlow` for the intent at all), and the intent ID MUST be non-empty; an empty `intentSession` from `gate` fails `kl:invalid`; `aide` → a session whose chain contains an agent session `aide` created (registered through `registerSessionKey` or recorded in the session table with `aide` as spawner); `strata`, `depot`, `vault`, `atrium` → only the caller's own service session (for `atrium`: device authorization only, i.e. `req.resource` is `device` with right `use`; any other resource from `atrium` fails `kl:denied`); for these callers `intentSession` MUST be empty. Any other subject fails `kl:denied` and writes `grant.deny{reason: "subject"}`.
- **REQ-BROKER-105** **Idempotency.** The broker MUST keep a table keyed by `(caller service name, idempotencyKey)` for 24 h. A repeated `requestFor` with the same key and the same request digest (SHA-256 of the JCS `{subject, req, intent}`) returns the same approval (still pending) or the same `GrantResult` (decided), and creates no second prompt or receipt. The same key with a different request digest fails `kl:conflict`. An empty `idempotencyKey` disables deduplication. The table is persisted in `/run/keylos/broker/idem.log` (each append `fsync`ed before the result is returned, §2.3 note 10) so a broker restart within the boot keeps it (decided results only; pending approvals are lost on restart and the caller re-calls with the same key, which then creates a fresh approval). This deduplication is boot-scoped by design and is not the identity of long-lived approvals (§2.3 note 10).
- **REQ-BROKER-106** **`GrantRequest.onBehalfOf` is informational.** When present (callers `vault`, `depot`, `strata`, `atrium` through `requestFor`), the broker MUST show it on the prompt (`ApprovalPrompt.summary` line "On behalf of: <rendered principal>") and record it in the `approval.request`, `approval.decide`, `grant.issue` and `grant.deny` receipts as `data.onBehalfOf`. It MUST NOT appear in the Cedar principal, entities or context, and MUST NOT change the tier, the channels, the token's `principal`/`session` facts, or the allowed-subject check. `onBehalfOf` in a `request` on facet `principal` is ignored and recorded as `data.onBehalfOfIgnored: true`.
- **REQ-BROKER-107** **Device authorization for `atrium`.** `atrium` calls `requestFor(<own session>, GrantRequest{resource: device(<id>), rights: [use], onBehalfOf: <human shell principal>}, "", key, <empty>)` when the human approves a pending USB/Thunderbolt device on the trusted path. The broker evaluates action `use` on the `Device` entity with the human's shell principal as the Cedar principal (the human is the one deciding; `atrium` is only the requester), applies the `device` tier floors of §4.4.3, and delivers the mandate (re-signed or presence-signed, REQ-BROKER-111). `atrium` passes the mandate to `DeviceAdmin.authorize`; `devd` verifies only the `service/broker` key or owner presence (protocols §14.4). The broker mints no token for this request (the outcome is `granted` with an empty token and the mandate).
- **REQ-BROKER-108** **`decidedOnTrustedPath`** (protocols §7.5.2). The broker MUST accept `decidedOnTrustedPath = true` only from `atrium`, only when `subject` is atrium's own session and the resource is `device`, and only when the evaluated decision does not require presence; in every other case it MUST fail with `kl:invalid` and change nothing. When accepted, the broker MUST NOT call `TrustedPrompt.approve`: it records `approval.request` and `approval.decide` (channel `local`, `decidedBy` = the `onBehalfOf` human) in one step and returns the mandate signed by `service/broker`. Policy `forbid` still applies (`kl:denied`). When the flag is false, the request follows the normal approval path (REQ-BROKER-107).
- **REQ-BROKER-109** **Registration budgets** (protocols §7.5.2 `SessionReg.budgets`, C56). For each entry of `SessionReg.budgets` the broker MUST carve a hard sub-meter from the matching offered root (same unit) via `GateMeterAdmin.carve` before minting the child's tokens, attach `budget_parent` facts to the child's tokens, and fail the whole registration with `kl:budget` (minting nothing) if any parent meter cannot cover its amount. Acceptance: IT-49 registers a fork with `budgets = [usd-micro:1000000]` against a parent meter of 500000 and gets `kl:budget` with no session created; with a parent meter of 2000000 the child's spend stops at exactly 1000000.
- **REQ-BROKER-102** `checkFlow` MUST evaluate the Rule of Two for the named session against the flow (`kind`, `target`; `FlowCheck.intent` names the intent, empty for connect-time `net` checks) — U ∧ P of the session label together with X of this flow, so a session that legitimately holds effect or egress rights gets a declassification approval rather than a hard refusal — accept a flow proof when §4.7 allows it, and otherwise run a T3 declassification approval whose mandate binds `payloadDigest`.
- **REQ-BROKER-103** Per-method callers on facet `system`: `loadPolicy`, `validatePolicy` → `config`; `mintCaptive` → `net`; `registerApprover` → `atrium` (channel `local`) and `vouch` (`vouchd`, channel `phone`); `registerSessionKey`, `annotateRequest` → `aide`; `rootsChanged` → `strata`; `registerSession`, `sessionEnded` → `warden`; `revokeSession` → `hearth`, `warden`; `checkFlow` → `gate`; `requestFor` → `gate`, `aide`, `strata`, `depot`, `vault`, `atrium` (subjects per REQ-BROKER-104); `admitPod` → `cri`. Any other caller receives `kl:denied`.


### 3.12 Mandates as delivered

- **REQ-BROKER-110** Before re-signing, the broker MUST verify a channel decision signature per §4.4.4 and check the decided payload against the draft (REQ-BROKER-050).
- **REQ-BROKER-111** A mandate returned by `Approval.mandate` or in `GrantResult.mandate` MUST be: the presence-signed (or quorum-signed) envelope as decided, when the mandate's `presence` is true; otherwise a new DSSE envelope over the **same payload bytes** signed only by `service/broker`. The payload is never modified when re-signing.
- **REQ-BROKER-112** The `approval.decide` receipt MUST carry `mandateDigest` = SHA-256 of the delivered envelope bytes, and MUST be appended before the mandate is returned to anyone.
- **REQ-BROKER-113** For `@orgApproval` permits combined with `@tier`, the broker MUST obtain the local tier decision first and call `OrgDecider.decide` only after it is granted (protocols §16.2). The delivered mandate has `channel: "org"` and `constraints.localDecision` = SHA-256 of the local decision's verified payload; it is re-signed by `service/broker` unless presence was required, in which case the local presence envelope is delivered together with the org mandate as a two-element JSON array `[presenceEnvelope, orgMandateResigned]` base64 inside `GrantResult.mandate` (§4.4.4).

### 3.13 Pod admission

- **REQ-BROKER-120** `admitPod(podSpecJson, runtimeClass)` MUST parse `podSpecJson` as `keylos.podspec/1` (protocols §21.3), reject unknown fields with `kl:invalid`, build a `Keylos::PodSpec` entity from it, and evaluate action `admit` with principal `service:kubelet` (the `Keylos::Principal` of the kubelet service session, human `_cluster`). If no `service:kubelet` session is registered, a synthetic `service:kubelet@_cluster` principal (generation name `io.keylos.kubelet`) is evaluated. `runtimeClass` MUST equal the pod spec's `runtimeClass` (`kl:invalid` otherwise).
- **REQ-BROKER-121** The compiled-in default policy MUST contain the forbids of protocols §16.1 (`privileged`, `hostNetwork`, `hostPID`, `hostIPC`, non-empty `addedCapabilities`, `seccompProfile == "unconfined"`, `allowPrivilegeEscalation`, `hostPaths` outside `cluster.hostPathAllowlist`), and for `runtimeClass == "keylos-sealed"` the forbid `@id("pod-sealed-gens-only") forbid(principal, action == Keylos::Action::"admit", resource) when { resource.runtimeClass == "keylos-sealed" && !resource.allImagesSealed };`. Owner and org policies MUST NOT be able to override them (they are `forbid`s; protocols §16.2).
- **REQ-BROKER-122** The result MUST be `PodAdmission{allowed, reasons, tierFloor, approval}`: `reasons` lists the `@id`s of matching forbids (denial) or failed checks; `tierFloor` is 2 when the runtime class is `keylos-vm` or any permit/forbid analysis requires a VM (any image not a `gen:` ref, `gpuPassthrough > 0`, non-empty `csiDrivers`), else 1; `approval` is set when the selected permit carries `@tier("t2"|"t3")` or `@orgApproval`, in which case an `Approval` is created with a `RenderedEffect` of kind `pod.admit`. `cri` holds the sandbox in `pending-approval` and calls `admitPod` again with the same `podSpecJson` (at most every 2 s); the broker deduplicates by the SHA-256 of the JCS `podSpecJson` plus `runtimeClass` and returns the same pending admission until the approval resolves, then the decided result (cached 10 min).
- **REQ-BROKER-124** The broker MUST NOT trust `allImagesSealed` blindly: before evaluation it recomputes it as "every element of `images` starts with `gen:fsv256:`" and fails the call with `kl:invalid` (reason `allImagesSealed-mismatch`) when the computed value differs from the submitted one.
- **REQ-BROKER-125** **Pod egress tokens.** For `registerSession` with actor kind `pod`, the broker MUST mint the egress token of §4.13 from `/policy/cluster-egress.json` (`keylos.cluster-egress/1`: `{"schema":"keylos.cluster-egress/1","rules":[{"namespace":"<glob>","pod":"<glob>","hosts":[{"host":"…","ports":[443],"methods":["*"]}]}]}`; rules whose `namespace` and `pod` globs match are unioned; namespace and pod name are taken from the principal text `pod:<namespace>/<name>:…`, protocols §3.4). No matching rule mints no token (pod egress through gate is then denied). The token is listed in `myGrants` of the pod session and written as `grant.issue{origin: "cluster-egress"}`. The file is part of the policy generation, so changes need a presence-signed config apply.
- **REQ-BROKER-123** `admitPod` MUST complete within 5 ms p99 when no approval is involved (kubelet `RunPodSandbox` latency budget), using a per-request evaluation without entity-store lookups other than the PodSpec itself.

### 3.14 Debug grants

- **REQ-BROKER-130** A `request` with `ResourceRef.principal` (a `DebugTarget`) and `Right.debug` MUST be evaluated with action `debug` on a `Keylos::DebugTarget` entity whose `targetHuman` and `targetKind` the broker derives from the session table (`session:` targets) or, for `gen:` targets, as `targetHuman` = the requester's human and `targetKind = "generation"`.
- **REQ-BROKER-131** Debug grants are minted only after a T3 approval with presence (purpose `debug.grant`, protocols §20.2), regardless of policy annotations; `durationSecs` is capped at 3 600 (scope `process`) and 900 (scope `kernel`); scope `kernel` additionally requires that the requester is an owner `shell` principal.
- **REQ-BROKER-132** A debug grant MUST be refused (`kl:denied`) to: agent principals unless the target session lies inside the agent's own session tree; guest humans; any target session of a different human unless the requester is an owner; any target whose principal kind is `service` with tier t0, unless the requester is an owner and the scope is `process`.
- **REQ-BROKER-133** `Broker.debug(token, debugger, entrypoint, argv, pty)` MUST verify the token carries `right("principal", target, "debug")` for the caller's session, check revocation and expiry, and call `DebugAttach.attach(target, scope, debugger, entrypoint, argv, pty, expiresSecs = remaining token lifetime, grantId = "dbg-<ULID>")` on `warden#broker`. The returned `Process` capability is returned unchanged. Revoking the token's root MUST terminate the debugger (`PrincipalControl.terminate(kill)`), which makes `warden` remove the `kl_debug_pairs` entry.

### 3.15 Model identity and offline operation

- **REQ-BROKER-140** Tokens minted for agent sessions whose template declares `models[]` (protocols §6.4) MUST carry one `model($provider, $model, $version)` fact per approved model in the authority block (several are allowed, protocols §8.2, E15), with `$version` the version last approved for the session (initially the template's `minVersion`, or `"*"` when null). `aide` re-approval after `model.change` produces a T2 `requestFor` whose approval yields fresh tokens with the new `$version`.
- **REQ-BROKER-141** The broker MUST provide the ambient fact `offline_days($n)` and `ctx.offlineDays` in every evaluation, computed as the whole days between trusted time and the `issued` time of the newest verified revocation list, read from `depot` (`Depot.revocations` on `depot#user`), refreshed every 10 min.
- **REQ-BROKER-143** Without consent records the broker cannot tell whether a generation is third-party; while `offline_days > 30` every `spawn` request is therefore T3.
- **REQ-BROKER-142** When `offline_days > 30` the broker MUST apply the floors of protocols §14.5: `spawn`/install consent for new third-party generations at T3; agent `connect` to a host that no token of the same agent template has held in the last 30 days (tracked in `/var/lib/keylos/broker/agent-hosts.db`) at least T2.

### 3.16 Guests and family machines

- **REQ-BROKER-150** For principals whose human is a guest (`guest-…` username, or `Human.guest = true` from `HearthSystem.owners`/`validateSession`), the broker MUST refuse: `persist = true`, any request whose approval requires presence, `Right.debug`, and agent sessions (`registerSession` with actor kind `agent`) unless the config option `hearth.guest.agents` (published in `/policy/defaults.json` as `guestAgents`) is true.
- **REQ-BROKER-151** On machines with non-owner humans, a request by a non-owner that needs an owner decision (protocols §14.3 list: config proposal, seal, persistent grant, policy change, install of an unreviewed app) MUST become an approval with `ApprovalPrompt.requester` = the requesting human. The broker queues it until an owner trusted-path session exists (atrium reports owner sessions through `hearth#system` `validateSession`) or routes it to an owner's phone when `@channels` allows `phone`; it never satisfies presence through the phone.

### 3.17 Headless and quorum machines

- **REQ-BROKER-160** On machines whose owner registry `policy.mode` is `quorum`, every decision that requires presence MUST be satisfied by a quorum presence envelope (protocols §5.4): the broker calls `HearthQuorum.request(purpose, payload, rendering)` on `hearth#presence` and later `HearthQuorum.collect(requestId)`; `collect` returning `kl:needs-approval` keeps the approval pending. The approval expires with the quorum request (≤ 24 h). The delivered mandate has `channel: "quorum"` and `decidedBy: "quorum"` (protocols §14.4).
- **REQ-BROKER-161** On profiles without `atrium` (`server`, `server-k8s`, `cloud`, `appliance`), T2 and T3 approvals that do not require presence MUST be decided through `OrgDecider` when the permit carries `@orgApproval` and the machine is fleet-enrolled; otherwise every T2 and T3 approval is escalated to a quorum presence request of purpose `mandate` (protocols §14.3; mandate `presence: true`, `channel: "quorum"`), with the threshold of the owner registry (`policy.threshold`, at least 1). An owner registry with no owner able to sign remotely (no credential reachable through `fleet` relay or `hearth presence --remote`) cannot satisfy it; such requests stay pending until the quorum request expires and are then denied with reason `no-trusted-path`.

### 3.18 Captive portals, screen snapshots, model re-approval and the broker key

- **REQ-BROKER-170** `mintCaptive(session)` MUST verify that `session` is a registered VM principal whose generation name is `io.keylos.bench.captive-browser` (the image named in its `bench:` actor, protocols §3.4; only the captive purpose uses that image, protocols §14.5), mint the captive token of §5.2, add it to the session's held tokens (so `Broker.myGrants` of that session returns it), write `grant.issue{origin: "captive"}` and return the token. A second `mintCaptive` for the same session revokes the previous captive root first. The token's root is revoked with `onRevoke: kill` when its 600 s expire.
- **REQ-BROKER-171** A request with `ResourceRef.model` MUST carry exactly right `use`; the broker parses `<provider>/<model>@<version>` (`kl:invalid` otherwise), evaluates action `use` on `Keylos::Model`, applies a t2 floor for agent principals, and on approval mints a **new root** token (fresh `root_id`) for the session with `right("model", r, "use")` and the session's approved `model(...)` facts including the new version, recorded in the root registry as a child of the session's original root, so revoking the original root revokes it (protocols §14.5, E15); budgets stay on their own roots. It clears the model-drift flag of §4.4.3 for that session.
- **REQ-BROKER-172** A request with `ResourceRef.screen` MUST carry exactly right `read` and a resource `window:<id>`; the broker resolves the `Keylos::Screen` entity (§4.4.1), evaluates action `snapshot`, applies a **t3** floor regardless of policy (protocols §14.5) and refuses it outright for guests and for windows of another human. On approval it mints a token `{right("screen", "window:<id>", "read"), expires(now + 120 s)}` whose root is **single-use**: the first successful `Broker.inspect` of that token by `portal-screen` (the only consumer) marks the root consumed, and the broker revokes it (`grant.revoke{reason: "single-use"}`) as soon as `portal-screen` calls `Broker.revoke` or 120 s pass, whichever comes first; a second `inspect` of a consumed root returns `kl:revoked`. `materialize` with a `screen` resource fails `kl:unsupported` (snapshots are taken by `portal-screen` through atrium `Screencast`, protocols §7.5.19).
- **REQ-BROKER-174** **Receipts need the key first** (protocols §7.5.2, E18). Until the broker's own `ledger.key.register` is durable, every `system` call whose result needs a receipt (including `registerApprover`) fails `kl:unavailable` (retryable), never `kl:internal`. `registerApprover`'s `publicKey` MUST be DER SubjectPublicKeyInfo; any other encoding (including raw 32-byte Ed25519) fails `kl:invalid`; `alg` ∈ `ed25519`, `ecdsa-p256-sha256`.
- **REQ-BROKER-173** **Broker service key.** At startup the broker MUST call `Ledger.serviceKey("broker")` (facet `reader`). If the call fails `kl:not-found` or returns an SPKI different from the unsealed `service/broker` key, the broker registers its key through the ledger's writer registration (`ledger.key.register`, data `{service: "broker", spki, keyRef}`) before it delivers any non-presence mandate. Until registration succeeds, approvals whose delivery needs re-signing stay pending (they are not lost) and `grants status` reports `serviceKey: unregistered`. Relying services (gate, strata, bench, depot, devd) obtain the key only through `Ledger.serviceKey` (protocols §14.4); the broker never hands its public key to them directly.

### 3.19 Durable workflows

- **REQ-BROKER-180** The broker MUST serve `BrokerWorkflow` (protocols §7.5.25) only on facet `workflow`, enforcing the per-method callers of protocols §19.2 by the peer's service name (`loom`: `enroll`, `claim`, `decide`, `rebind`, `resume`, `cancel`, `record`, `raise`; `gate`: `authorizeEffect`, `verify`, `record`; `aide`: `offer`, `verify`, `decide`, `rebind`, only for bindings whose claimed spawner is aide's own session; `strata`, `bench`: `verify`, `record`); any other caller or method fails `kl:denied`.
- **REQ-BROKER-181** **Workflow records.** For every approved enrollment the broker MUST keep a workflow record `keylos.workflow-grant/1` (§4.18.1) signed by `service/broker` in `/var/lib/keylos/broker/workflows/<wf-…>.dsse`. Every change (enrollment, claim, label raise, cancellation, forget) MUST be written as a new signed record with `recordSeq + 1` to a temporary file, `fsync`ed, renamed over the old one and the directory `fsync`ed before the method returns; a write error fails the method with `kl:unavailable` and changes nothing in memory.
- **REQ-BROKER-182** **Enrollment.** `enroll(subject, req)` MUST evaluate Cedar action `enroll` on the `Workflow` entity (protocols §16.1) with the subject session's principal, and every `req.scope` item exactly as a `request` with `persist = true` from the subject; the enrollment tier is the maximum of these, at least `t2`, with presence required when `req.resume = automatic` or `req.runWhileLocked` (natively, regardless of policy). Subjects whose human is a guest, and subjects that are not `shell` principals (or `atrium` acting for its human), MUST be denied (`kl:denied`, `grant.deny{reason: "enroll-subject"}`). The decision is a durable decision (REQ-BROKER-186) with key `enroll` whose mandate effects are `workflow.enroll` (digest = SHA-256 of the JCS `EnrollRequest` JSON form, §4.18.2) and one `grant.<k>` per scope item.
- **REQ-BROKER-183** When an enrollment decision is approved, the broker MUST, before it reports the decision approved to anyone: open the budget account with `WorkflowBudget.open(req.account, req.workflow, req.budgets)` on `gate#broker` (retrying `kl:unavailable`; a `kl:conflict` fails the enrollment), and write the workflow record with state `active`, epoch 0, owner = the subject's human, label = the subject session's label at decision time, horizon = decision time + `min(req.horizonSecs or policy default, workflow.maxHorizonSecs)` (defaults 30 d and 400 d), the definition, resume policy, `runWhileLocked`, the scope, the enrollment mandate and the subject principal text.
- **REQ-BROKER-184** **Claims.** `claim(binding, generation, spawner)` MUST succeed only when the record is `active`, trusted now < horizon, `binding.epoch == record.epoch + 1`, `binding.owner == record.owner` and `binding.workflow` names the record; otherwise `kl:revoked` (cancelled or forgotten), `kl:expired` (horizon) or `kl:conflict` (any epoch other than epoch + 1). On success it MUST persist the new epoch, attempt ID, step, generation and spawner (REQ-BROKER-181) before returning, and then revoke every root minted for earlier attempts of the workflow (cascade and holder termination per REQ-BROKER-071/072 with mode `kill`).
- **REQ-BROKER-185** **Attempt registration.** A `registerSession` whose `SessionReg.attempt` has epoch ≠ 0 MUST be accepted only when the binding is the record's current claim (epoch and attempt), the child's generation equals the claimed generation, the child's parent session equals the claimed spawner, the child's human equals the record's owner and the record is `active`; otherwise registration fails (`kl:conflict` or `kl:revoked`) and no session entry is created. When accepted, the broker MUST, in this order: (1) set the session label to the join of the default label and the record's label high-water mark; (2) re-evaluate every scope item against the current policy with the workflow principal entity (§2.3 note 12), minting `t0`/`t1` items and `t2`/`t3` items only with the record's enrollment mandate, and skipping items that are now denied, revoked or expired (each skip receipted `grant.deny{workflow, reason}`); (3) mint fresh roots for the attempt session carrying `workflow(<wf>, <epoch>)`, `budget_account(<ba>)` and `expires` ≤ min(policy duration, horizon). `SessionReg.offered` tokens of the spawner MUST NOT be delegated to an attempt session (they are ignored and recorded `data.offeredIgnored`).
- **REQ-BROKER-186** **Durable decisions.** `decide(binding, key, requests, effects)` MUST compute the decision digest of protocols §20.25 and look up `(workflow, key)`: an existing record with the same digest is returned unchanged; one with another digest fails `kl:conflict`. A new decision MUST be evaluated as `requestFor` would for the workflow principal entity (tiers, floors, Rule of Two with the workflow label, channels), persisted as `keylos.decision/1` in `/var/lib/keylos/broker/decisions/<dr-…>.json` (file and directory `fsync`ed) **before** any prompt is shown, with `expires` = creation + min(`workflow.decisionTtlSecs` (default 7 d), horizon − now), fixed for its life. The binding MUST be the current claim.
- **REQ-BROKER-187** A pending decision's prompt is boot-local: the broker MUST show it with a fresh `a-…` approval ID, record that ID in the decision's in-memory state only, and after every broker restart or reboot re-create the prompt from the persisted record (required renderings rebuilt and presented completely, REQ-BROKER-057) until the decision is decided, expires (→ `expired`) or is cancelled. A decided outcome (state, delivered mandate) MUST be persisted before it is returned to any caller and before the `approval.decide` receipt's result is delivered, so a crash between decision and reply loses nothing. Mandates of durable decisions carry `constraints.workflow` and `constraints.decision` (protocols §14.4).
- **REQ-BROKER-188** **Rebind.** `rebind(decision, binding, session)` MUST verify that the decision is `approved` and unexpired, belongs to `binding.workflow`, that the binding is the current claim and `session` is a registered session of that attempt, re-evaluate its requests against current policy and revocation, and require presence again exactly when the decision required it (a presence-signed mandate is reused only within its expiry; presence is never added or dropped); then mint the granted tokens for `session` (expiry ≤ min(decision expiry, horizon)). It MUST NOT extend `expires`. Effect decisions are not rebound; `gate` consumes them per effect ID.
- **REQ-BROKER-189** **Effect authorization.** `authorizeEffect(binding, effect, kind, target, payloadDigest, rendered)` from `gate` MUST: require the binding to be the current claim and the record `active` and within its horizon; evaluate action `commit` on the `Effect` entity with the workflow principal entity, the §4.4.3 floors and the Rule of Two with the record's label (a declassification becomes part of the same decision); return an approved `DecisionRecord` with an empty mandate when no approval is needed; otherwise call `decide` with key `effect:<fx-…>` and the effect `{kind, target, digest: payloadDigest, rendered}` and return that decision. It never mints tokens.
- **REQ-BROKER-190** **Offer.** `offer(binding)` from `aide` MUST require the binding to be the current claim whose spawner is aide's session, and return tokens for aide's own session covering only the scope's `path` and `net` items re-evaluated as in REQ-BROKER-185 step 2, with `workflow(<wf>, <epoch>)` and `expires` = now + 120 s; the roots are revoked with the attempt's roots at the next claim or cancellation.
- **REQ-BROKER-191** **Verify, record, resume, raise.** `verify(binding, session)` MUST return the record when the binding is the current claim and `session` is that attempt's session or one of its descendants, else `kl:conflict` (stale) or `kl:revoked`. `resume(subject, workflow)` MUST evaluate Cedar `resume` for the subject and return a durable decision with key `resume:<epoch>`. `raise(workflow, label, reason)` MUST raise the record's label high-water mark (labels only go up), persist it before returning and write `label.raise{workflow}`; the broker MUST also raise the record whenever it raises the label of an attempt session of the workflow (REQ-BROKER-040 path), before the raised label is returned.
- **REQ-BROKER-192** **Cancellation and revocation record.** `cancel(subject, workflow, reason, forget)` MUST evaluate Cedar `cancel` for the subject (an empty subject only from `loom` for the forget of a deleted user's workflows, protocols §20.25), set the record's state to `cancelled` (or `forgotten`) and persist it before doing anything else, then revoke every root carrying the workflow's `workflow` fact (attempt roots and `offer` roots), cancel the workflow's pending decisions (state `cancelled`, prompts withdrawn) and write `grant.revoke{workflow, reason, by}`. A cancelled or forgotten record MUST refuse every later `claim`, attempt registration, `decide`, `rebind`, `authorizeEffect` and `offer` (`kl:revoked`) across restarts and reboots. `grants revoke <wf-…>` by the owner's `shell` or an owner `shell` MUST have the same effect.
- **REQ-BROKER-193** **Forgetting.** For `forget = true` the broker MUST additionally delete the record's scope, mandates, subject text and label, keep only `{workflow, owner, state: forgotten, recordSeq, time}` and delete the workflow's decision records except `{id, workflow, state}`; the retained stubs are never deleted.
- **REQ-BROKER-194** **Rollback detection.** The broker MUST keep in `workflows/anchor.json` the ledger `seq` of its newest acknowledged receipt that names a workflow. At startup, before serving facet `workflow` or accepting an attempt registration, it MUST query its own receipts after that `seq` (`principalPrefix "service:broker:"`, protocols §7.3.5) and compare every receipt naming a workflow with the records: a receipt whose workflow record is missing or has a lower `recordSeq` or earlier state (for example a `grant.revoke{workflow}` for a record that is `active`) means an older store was restored; the broker then re-applies the receipt's state (cancelled, forgotten, higher epoch as a fence) to the record, writes `grant.deny{workflow, reason: "workflow-store-rollback"}`, and refuses claims for every affected workflow until the owner's `grants workflow accept-rollback <wf-…>` with presence (purpose `loom.rollback-accept`).
- **REQ-BROKER-195** **Receipts.** Every workflow operation MUST be receipted before its result is returned: enrollment and decisions as `approval.request`/`approval.decide` with `data.workflow`, `data.decision`; attempt and rebind grants as `grant.issue{workflow, epoch, attempt}`; claims as `grant.issue{workflow, epoch, origin: "claim"}`; cancellation as `grant.revoke{workflow}`. Receipt data names the workflow by ID only.

---

## 4. Design

### 4.1 Process structure

`brokerd` is one process. Because `capnp-rpc` is single-threaded, the RPC side runs on a current-thread tokio runtime with a `LocalSet`; CPU-heavy evaluation MAY be offloaded to worker threads.

| Module | Responsibility |
|---|---|
| `host` | `ServiceHost` implementation: accepts connections from `warden` with peer, facet, tier and generation; serves the facet's bootstrap; `reload`; `stop` |
| `ident` | Connection ID → `{peer, facet, tier, generation}` cache, populated by `ServiceHost.accept` |
| `sessions` | Session table, labels and label history, depth, fan-out, frozen flags, root membership |
| `policy` | Policy generation loader, Cedar `PolicySet` and schema, entity construction, annotation extraction |
| `mint` | Biscuit root key, minting, attenuation, verification, authorizer construction |
| `grants` | Persistent grant records: store, re-mint, integrity, suspension |
| `roots` | Root registry: root ID → session, ancestor root, `onRevoke`, kind; the revocation set |
| `approvals` | Approval objects, T2 batching, `TrustedPrompt` and `OrgDecider` calls, mandate verification |
| `materialize` | Per-resource-kind handle production |
| `labels` | Object label lookup (xattrs, location rules, host table), ceilings, Rule-of-Two evaluation, the label authority |
| `classifier` | Optional escalate-only hook |
| `powerbox` | Powerbox orchestration with `portal-files` |
| `receipts` | Receipt construction (submitted form, protocols §13.1) and append to `ledger` |
| `heldroots` | Registry of held root directory fds |
| `workflows` | Workflow records, claims, attempt grants, durable decisions, `BrokerWorkflow` (§4.18) |

Concurrency: state lives in single-owner structures on the RPC thread (`RefCell` maps for sessions and roots, an atomically swapped `ActivePolicy`, the revocation set as a hash set of root IDs); a sharded `DashMap`/`ArcSwap` layout is an allowed alternative for multi-threaded implementations. Either way the §8 budgets apply.

#### 4.1.1 Startup

1. Receive fd 3 (`Bootstrap` of `warden-sys`); call `Bootstrap.host(serviceHost)`.
2. `FdStore.fetch("root-key")`. If present (a restart within this boot), map it and reuse the root key; otherwise generate a new key (REQ-BROKER-020) and `FdStore.store("root-key", memfd_secret fd)`.
3. Replay `/run/keylos/broker/roots.log` if present (restart within this boot).
4. Unseal the `service/broker` signing key (§4.3.1) and check it against `Ledger.serviceKey("broker")`; register it (`ledger.key.register`, data `{service, spki, keyRef}`) if the ledger has none or a different one (REQ-BROKER-173).
5. Load policy (§4.9). Fall back to the default policy set if `/policy` is empty.
6. Read the persistent grant records into memory (verification is lazy, at re-mint).
6a. Load the workflow records and decision records (§4.18), verify the workflow record signatures, run the rollback check (§4.18.6) and re-create the prompts of pending, unexpired decisions. Until this step completes, facet `workflow` and attempt registrations answer `kl:unavailable`.
7. `Bootstrap.ready()`. Watchdog pings follow the interval from the service manifest.

### 4.2 Held roots

Path rights are relative to **held roots**: `O_PATH | O_DIRECTORY` file descriptors the broker opened and keeps, each with a stable `fdkey`:

| fdkey | Root | Created |
|---|---|---|
| `home:<user>` | `/home/<user>` | At first request for that user (lazily) |
| `appdata:<user>:<app-name>` | `/home/<user>/.apps/<app-name>` | Lazily |
| `pbx:<grantId or rootKey>` | A directory chosen through the powerbox, or a picked file's parent | At powerbox grant (§4.11) |
| `proj:<user>:<sha256 of canonical path>` | A project directory registered by a `shell` principal (`grants project add`) | On request from a `shell` principal |
| `media:<user>:<volume-uuid>` | Removable media mount root | On mount notification from `devd` |

Path tokens carry `path_root($fdkey)` and `right("path", $rel, $op)`, where `$rel` is canonical: no `..`, no leading `/`, NFC Unicode, `/`-separated. The empty `$rel` means the root itself. A right on `$rel` covers every descendant (prefix semantics on path components). The broker computes the ambient fact `path_under($fdkey, $requested_rel)` for each request.

After a `strata` rollback the inode behind a root may change. `strata` calls `BrokerSystem.rootsChanged(fdkeys)`; the broker re-opens those roots by walking from `/home/<user>` with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` one component at a time.

### 4.3 Grant records

Persistent grants live in `/var/lib/keylos/broker/grants/<grantId>.dsse`, one per grant. `grantId` is `g-` + ULID. Each file is a DSSE envelope with payload type `application/vnd.keylos.grant+json; version=1`, signed by `service/broker`.

#### 4.3.1 The `service/broker` key

An Ed25519 key generated at first start. The private key is stored as a TPM-sealed blob `/var/lib/keylos/broker/service-key.sealed` under the SRK (`0x81000001`, protocols §19.6) with policy `PolicyAuthorize(release-stream PCR11 key, phase "ready") ∧ PolicyPCR(15)`. It unseals only on a correctly booted system with the right volume identity. It signs receipts and grant records. §6.2 explains why this does not defend against runtime root, and why that is acceptable.

#### 4.3.2 Payload (`keylos.grant/1`)

```json
{
  "schema": "keylos.grant/1",
  "grantId": "g-01JB6Q8Z0RXQ4M3W9V2N7T5K1C",
  "created": "2026-10-07T21:30:00Z",
  "human": "alice",
  "actor": {"kind": "app", "name": "org.example.Editor", "publisher": "key:sha256:…", "generation": null},
  "resource": {"kind": "path", "root": "pbx:g-01JB…", "rootPath": "/home/alice/Documents/Thesis", "rel": "",
               "rootIno": 4711, "rootGen": 3, "rootProvTxn": "x-01JB…"},
  "rights": ["read", "write", "create"],
  "constraints": {"durationSecs": 0, "labelCeiling": "private", "netMethods": null},
  "tier": "t2",
  "mandate": "<base64 DSSE keylos.mandate/1, presence-signed>",
  "onRevoke": "freeze",
  "policyGeneration": "gen:fsv256:…",
  "origin": "powerbox"
}
```

Rules:
- **Actor binding.** `actor.generation` set means the record matches only that exact generation. `actor.generation = null` matches any generation with the same `name` and `publisher`, so updates keep the grant. An agent actor (`kind: "agent"`) MUST pin `generation`, because templates are pinned (protocols §6.4).
- **Root persistence.** For `pbx:` roots the record stores the canonical absolute `rootPath`, the inode number, an inode identity value `rootGen` (the inode generation from `FS_IOC_GETVERSION`, or the `statx` birth time where that ioctl is not available safely) and the creation transaction from `security.bpf.keylos.prov` (`null` when absent). At re-mint the broker re-opens the directory component by component from `/home/<user>` and compares all three. On mismatch the record is **suspended** (moved to `suspended/`), the user is notified, and only a new powerbox grant restores access.
- **Mandate requirement.** A record with `tier` t2 or t3 MUST carry a presence-signed mandate with `scope: "persistent"` (REQ-BROKER-051).
- **Install-time grants.** When an app's capability set has a `keylos.consent/1` record (protocols §20.8) the broker creates T1 grant records for the consented `needs.network` hosts and `needs.devices` at the app's first registration. Their `mandate` field holds the consent record's mandate receipt reference instead (`"consent": "rcpt:sha256:…"`), and they are re-validated against the consent record on each re-mint.
- **Revocation.** `grants revoke <grantId>` deletes the file (then `fsync` of `grants/`) and revokes the live roots minted from it.
- **Durability.** A record is written to a temporary file, `fsync`ed, renamed into `grants/` and the directory `fsync`ed before the grant is reported persistent; moves to `suspended/` `fsync` both directories (§2.3 note 10).
- **Re-mint evaluation.** A record's request is re-evaluated with `persist: false` (otherwise the persistence floor would demand presence at every boot); T2/T3 records need their persistent presence mandate. Powerbox-origin path records (`pbx:` roots, which the default policy does not permit by name) re-mint when the only denial is "no matching permit" (forbids still apply), and only with their verified presence mandate.

### 4.4 Request pipeline

```
request(req) on connection c                       (requestFor: P := subject's principal; caller and subject per REQ-BROKER-104;
                                                    duplicate idempotencyKey → cached approval/result, REQ-BROKER-105)
  1. P := ident.principal(c); S := sessions[P.session]               (kl:denied if unknown or frozen)
  2. validate req (resource well-formed, rights applicable to kind)    (kl:invalid)
  3. normalize resource → Cedar entity R (path: fdkey+rel, labels; net: host table; …)
  4. for each right r: decision_r := cedar.is_authorized(P, Action(r), R, ctx)
       ctx = {time, persist, durationSecs, reason, approvalTier: "", amount?, channel?: absent,
              offlineDays, profile, integrityProfile, requester?}
     forbid anywhere → deny
     no permit → deny
     tier_r := min @tier among matching permits (t1 if unannotated); presence_r := any @presence("true");
     channels_r := @channels of the permit that set tier_r; org_r := @orgApproval group of that permit, if any
     tier := max over r of tier_r
  5. tier := max(tier, floors(req, P, S))                                     (§4.4.3)
  6. tier := classifier.escalate(tier, req, P, S)    (only if tier ≤ t1 and the hook is enabled)
  7. violation := labels.ruleOfTwo(S, req)                                    (§4.6)
       violation → tier := t3, kind := declassification (unless an accepted flow proof covers it, §4.7)
  8. tier ∈ {t0,t1}: mint → receipt grant.issue → return granted
     tier = t2: enqueue in the session's batch → return pending(Approval)
     tier = t3: create approval → prompt (synchronous per request) → return pending(Approval)
  9. on approval: verify mandate (§4.4.4) → mint → receipts approval.decide + grant.issue
     persist && approved: write grant record
     on denial: receipts approval.decide{approved:false} + grant.deny; Approval.wait returns denied
```

#### 4.4.1 Entity construction

| Entity | Construction |
|---|---|
| `Keylos::Principal` | uid = principal text. Attributes from the session table. `generationName` from `Depot.get(generation).name` (cached per generation). `depth` = chain length − 1. `label` = current session label. `human` = the principal's human (`_system`, `_cluster` or a username); `humanOwner` and `humanGuest` copy the parent `Human` entity's `owner` and `guest`. Parent: `Keylos::Human::"<human>"`, `owner` from `HearthSystem.owners` (cached; refreshed on every `owners.entry` presence the broker verifies and every 10 min), `guest` per §4.16. |
| `Keylos::Screen` | uid = `window:<id>`. `window` = the atrium window ID, `app` = the generation name of the window's owner, resolved with `Display.windowOwner(window)` on `atrium#broker` at request time (protocols §7.5.16, E21; an unknown window fails `kl:not-found`, and with no route screen requests fail `kl:unavailable`). |
| `Keylos::Model` | uid = `<provider>/<model>@<version>`; attributes parsed from the resource string. |
| `Keylos::Path` | uid = `<fdkey>/<rel>`. `root` = fdkey, `rel` = rel. `labelConf`/`labelInteg` from `security.bpf.keylos.label`, falling back to the location rule (§4.6.1). For `create` on a missing object, the parent directory's label. |
| `Keylos::Host` | uid = `<host>:<port>`. `sinkSafe` and `trusted` from `/policy/hosts.json`. |
| `Keylos::Device` | uid = device ID. `subsystem` from `Devd.list`, cached. |
| `Keylos::Secret` | uid = `<human>/<name>`. `owner` = the human. |
| `Keylos::Effect` | uid = kind. `class` from protocols §14.2 plus `/policy/effects.json` additions (raise-only). |
| `Keylos::Generation` | uid = gen ref. `name`, `publisher` (manifest `publisher`) and `reproducible` from `Depot.get`, cached by ref. |
| `Keylos::Service` | uid = `name#facet`. |
| `Keylos::Budget` | uid = unit. |
| `Keylos::PodSpec` | §4.13; `allImagesSealed` is taken from the normalised `keylos.podspec/1` (computed by `cri`) and cross-checked by the broker (REQ-BROKER-124). |

#### 4.4.2 Contexts

- `ctx.time` is UNIX seconds from trusted time (protocols §3.6). The broker subscribes to `NetWatch` on `net#status` (a tier-0 holder) and treats the clock as trusted after the first `timeTrusted = true` event. Until then `ctx.time = max(now, floor)`, where `floor` is the `time` line of the newest checkpoint returned by `Ledger.checkpoint` (`net` also steps the clock forward to the floor at boot).
- `ctx.amount` is present only for `spend`.
- `ctx.offlineDays` per REQ-BROKER-141; `ctx.profile` and `ctx.integrityProfile` from `/run/keylos/boot/report.json` (protocols §10.7, §20.1), read once at startup; `ctx.requester` is set when a non-owner's request is being decided by an owner (REQ-BROKER-151).
- `ctx.channel` and `ctx.approver` are absent during request evaluation. They are set when the broker re-evaluates the selected permit against a returned org or phone mandate, so permits can constrain who approved.

#### 4.4.3 Tier floors (not lowerable by policy)

| Condition | Floor |
|---|---|
| Any right `commit` on an `effect` whose class is `irreversible` | t3 |
| `persist = true` | t2 plus presence (REQ-BROKER-051) |
| Principal kind `agent` requesting a `net` host not already in a token it holds | t2 |
| Principal kind `agent` requesting `path` with `write`, `create` or `delete` outside its workbench overlay roots (host paths are never overlay roots, so every such request on a host path) | t3 |
| `secret` resource with `use` requested by an agent | t2 |
| `device` resource in subsystems `video4linux`, `sound` (capture), `hidraw`, `input` | t2 for apps, t3 for agents |
| `delegate` that widens a child's scope (REQ-BROKER-064) | t2 |
| `spend` with `amount` exceeding the remaining budget reported by the requester's token ceiling | t3 (budget overrun) |
| Declassification (§4.7) | t3 |
| `Right.debug` (any scope) | t3 plus presence (REQ-BROKER-131) |
| `offline_days > 30`: consent or `spawn` of a new third-party generation; agent `connect` to a host not held by the template in 30 days | t3; t2 (REQ-BROKER-142) |
| Agent session whose observed model differs from its `model(...)` fact (reported by `aide` through `annotateRequest{"modelDrift": true}`) | every t1 decision becomes t2 (protocols §14.5) |
| Guest human: `persist`, presence-class, `debug`, agent sessions | denied (REQ-BROKER-150) |
| A request from a frozen session | denied |

#### 4.4.4 Approval objects and mandates

An `Approval` capability is backed by:

```
ApprovalState {
  id: "a-<ULID>", subject session, subject principal, requests: Vec<GrantRequest>, intent: Option<e-…>,
  tier, kind: grant | declassification | delegation-widen | budget-overrun,
  presence: bool, channels: [local|phone|org], orgGroup: Option<String>,
  prompt: ApprovalPrompt, created, expires,
  status: pending | approved{mandate, scope} | denied{reason} | expired | canceled
}
```

- `wait` resolves when the status leaves `pending`. `cancel` is allowed for the requester and the human's shell. `mandate` per REQ-BROKER-055.
- **Mandate draft.** The JCS payload of `keylos.mandate/1` with:
  - `effects[]`: one entry per request, `{kind: "grant.<resource-kind>", target: <canonical resource string>, digest: "sha256:<SHA-256 of the JCS GrantRequest JSON form>"}` (protocols §14.4, E3); a raw-egress declassification uses kind `grant.declassify`; for declassifications and `requestFor` with an intent, the entries `gate` supplies (kind, target, payload digest);
  - `constraints`: `{"maxAmount": …, "expires": …, "channels": [...]}` (§2.3 note 3); `expires` = approval expiry plus the longest requested duration, so `gate` can still use an effect mandate after the prompt;
  - `scope`: fixed by the draft (`session`; `once` for intents and declassifications; `persistent` for `persist`); `Decision.scope` is recorded in the receipt only;
  - `presence`: the required presence flag; `decidedBy` and `channel` empty, filled by the decider (the draft is not yet a valid mandate, §2.3 note 7).
- **Prompt routing.**
  1. Quorum machine and `presence` (or headless profile, REQ-BROKER-161) → quorum request through `HearthQuorum` (§4.17).
  2. `orgGroup` set without `@tier` → `OrgDecider.decide(prompt, group)`.
  3. `orgGroup` set with `@tier` → `TrustedPrompt.approve(prompt)` first; after a verified local approval, `OrgDecider.decide(prompt', group)` where `prompt'.mandateDraft.constraints.localDecision` holds the local decision's payload digest (REQ-BROKER-113).
  4. Otherwise `TrustedPrompt.approve(prompt)` with `requiresPresence = presence`, `channels` per §2.3 note 3, and `requester` per REQ-BROKER-151. `atrium` itself routes to the phone (`VouchLink.routeApproval`) when `phone` is in `channels`.
- **Delivery.** After verification the broker builds the delivered mandate per REQ-BROKER-111 and writes `approval.decide{mandateDigest}` (REQ-BROKER-112).
- **Accepted signer classes:**

| `channel` | Signer | Verification |
|---|---|---|
| `local`, presence | Owner credential (`fido2-es256`/`fido2-eddsa`) | `keylos-presence` against the owner registry from `HearthSystem.owners`, purpose `mandate` or `grant.persist` |
| `local`, no presence | The key `atrium` registered with `registerApprover(…, "local")` | Ed25519 or ECDSA P-256 over the DSSE PAE |
| `phone` | The key `vouchd` registered with `registerApprover(…, "phone")` | Same; never satisfies presence (REQ-BROKER-056) |
| `quorum` (`presence: true`, `decidedBy: "quorum"`) | ≥ `threshold` distinct owners' credentials | `keylos-presence` quorum verification against the owner registry (protocols §5.4) |
| `org` | An `approver/<id>` key listed in `/etc/keylos/fleet/approvers.json` (`keylos.fleetapprovers/1`, the single source, protocols §10.7, E27) | Same; the permit is re-evaluated with `context.channel = "org"` and `context.approver` |

#### 4.4.5 Rendering for prompts

Each request is rendered into a `RenderedEffect` with `review = required` and `payloadDigest` = its draft effect digest (REQ-BROKER-057), for example:
- "Read and change the folder ~/Documents/Thesis (and everything inside)"
- "Connect to api.github.com:443 (GET, HEAD) for 30 minutes"

`ArgProvenance` is filled from the requesting session's label history, the resource's label, and for agents the hints `aide` passed with `annotateRequest`. Strings come from `/policy/strings/<lang>.json` in the human's locale (default English).

### 4.5 Materialization by resource kind

#### 4.5.1 `path` (files)

```
materialize(token, path(rel or absolute), rights)
  verify(token); check session ancestry; authorize with ambient facts
  root := heldroots[fdkey from token]
  flags := read→O_RDONLY; write→O_WRONLY (O_RDWR with read); create→O_CREAT|O_EXCL (O_CREAT if write also granted)
  fd := openat2(root, rel, {flags | O_CLOEXEC | O_NOCTTY | O_NOFOLLOW,
                            resolve: BENEATH|NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV})
  fstat(fd): regular file required; devices, fifos and sockets → kl:invalid
  label := labels.of(fd); Rule-of-Two check; label authority raise
  receipt (path opens are summarized per session every 10 s as grant.issue{origin:"path-open-summary"})
  return Handle.fd
```

- An absolute path is mapped to `(fdkey, rel)` by longest-prefix match against the canonical path of the token's `path_root`. It is never opened directly.
- `delete` is performed by the broker after authorization: `unlinkat(root, rel)` (directories must be empty). The returned `Handle.fd` is an `O_PATH` fd of the parent directory, because the union requires a value.
- `exec` on host files is always refused with `kl:denied`: host code integrity is `kl-exec`'s domain (protocols §9.3).
- Files created through `create` rights get `security.bpf.keylos.label` set by the broker to the session label (it holds `CAP_FOWNER` for this, §6.3); later writes by holders are labelled by `strata`'s creation hook.

#### 4.5.2 `path` and `dirFd` (directories)

A Landlock domain cannot be widened (protocols §7.3.3 note). The broker never returns its own directory fds to t0, t1 or legacy principals:

```
  1. authorize (dir rights: read → list+read; write → modify existing; create → make entries; delete → remove entries)
  2. dir := openat2(root, rel, O_PATH|O_DIRECTORY, resolve flags as above)
  3. name := "<basename>" deduplicated per session ("Thesis", "Thesis-2")
  4. c := exposure label (§4.6.2); raise the session label to c (Rule-of-Two check first)
  5. (inView, viewPath) := GrantMounts.attachGrant(session, name, dir, readOnly = !(write|create|delete), ceiling = c)
     receipt grant.issue{viewPath, ceiling: c, assessment: "complete" | "truncated"}
  6. return Handle.fd = inView; PowerboxGrant.viewPath = viewPath
```

- The holder's baseline Landlock ruleset allows the highest grantable access beneath `/grants` (protocols §9.1); read-only enforcement is by the bind mount's `MS_RDONLY`. `write`, `create` and `delete` therefore collapse to "read and change" on attached directories, and prompts say so (§6.4).
- **`dirFd` resource.** A caller passes a directory fd it already holds to obtain a token describing it (for persistence or delegation). The broker identifies it with `fstat` and `name_to_handle_at`, and accepts it only if its mount is one of the caller's `/grants/*` attachments (checked through `PrincipalControl.mountView`) or one of the caller's own data subvolumes.
- **VM principals** (REQ-BROKER-035): the directory is opened `O_PATH|O_DIRECTORY` as above and returned as `Handle.fd` to `bench-relay`, which is the only process of a VM principal that holds `broker#principal`; `bench-relay` calls `Vm.attachShare` to hot-plug it. No `GrantMounts` call is made and `viewPath` is empty. The label ceiling raise and the receipt (`grant.issue{origin: "vm-share"}`) are the same.

#### 4.5.3 `net`

```
  authorize(op connect|bind, host, port, proto, method facts)
  Rule-of-Two check with X = (host not sinkSafe)
  sock := Gate.connect(target, token)          // gate#broker: acts for the token's principal (protocols §7.3.7)
  label raise: integ := max(integ, host.trusted ? user : untrusted)
  return Handle.socket
```

`bind` (listening) is materialized by `Gate.connect` with `target.host = "listen:<addr>"`, which returns a listening socket (protocols §7.3.7).

#### 4.5.4 `device`

`Devd.open(id, token, flags)` on `devd#broker`, with `flags` from rights: `read` → `O_RDONLY`, `write` → `O_RDWR`. On revocation of a device root the broker calls `DeviceAdmin.revoke(rootId)`.

#### 4.5.5 `secret`

- **Agents:** `materialize(secret)` MUST fail with `kl:denied`. Agents receive tokens carrying `right("secret", name, "use")`, which `gate` redeems for credential injection. The value never reaches the agent.
- **Apps, shell, legacy:** `Vault.open(name, purpose)` on `vault#broker`, with `purpose` = JSON `{"onBehalfOf":"<principal>","grantRoot":"<rootId hex>","reason":"…"}`. The vault applies its own ACL to `onBehalfOf`. The returned delivery fd (protocols §20.10) is returned as `Handle.fd`. Label raise: conf → `secret`.

#### 4.5.6 `service`

`ServiceConnect.connectService(session, name, facet)` on `warden#broker` returns a connected capwire socket for the holder; the broker returns it as `Handle.socket`. The token right is `right("service", "<name>#<facet>", "use")`.

#### 4.5.7 `spawn`, `effect`, `budget`, `delegate`

`kl:invalid` (REQ-BROKER-034). `warden` and `gate` verify these tokens with `Broker.inspect` on the `system` facet.

#### 4.5.8 Budgets and delegation

Budget tokens carry `budget($unit, $amount)`; `gate` meters spending per `root_id`. Delegation of a budget creates a **hard sub-meter** (protocols §7.5.12):

```
delegate(parentBudgetToken, child, ceiling?)            (from Broker.delegate or registerSession)
  parentRoot := root_id(parentBudgetToken)
  (spent, remaining, _) := GateMeterAdmin.meterFor(parentRoot)
  ceiling := ceiling ?? floor(remaining / max(1, max_fanout))     (REQ-BROKER-065)
  childRoot := new root (ancestor = parentRoot)
  childToken := mint{budget(unit, ceiling), budget_parent(parentRoot), session(child), expires ≤ parent's}
  GateMeterAdmin.carve(parentRoot, childRoot, [Budget(unit, ceiling)])      (kl:budget → delegation fails)
  receipt grant.delegate{parentRoot, childRoot, childSession, budgetCeiling}
on child sessionEnded or revocation of childRoot:
  GateMeterAdmin.release(childRoot)                      (unspent remainder returns to the parent)
```

Every charge to `childRoot` is also charged to `parentRoot`, and `gate` refuses carves whose children's ceilings would exceed the parent's remaining amount, so both the aggregate cap and each child's cap are hard. `aide` no longer needs soft caps. A `spend` above the child's own ceiling is a budget overrun: a T3 approval for the child. If approved, the broker mints a replacement budget token for the child with a new root carved from the parent for the approved ceiling, then releases the old child root (`release`); the child switches tokens with `myGrants`.

### 4.6 Labels and the Rule of Two

#### 4.6.1 Object labels

| Object | Label source | Default |
|---|---|---|
| File or directory with `security.bpf.keylos.label` | xattr (2 bytes) | — |
| Under `/home/<u>/Downloads`, `/home/<u>/.cache`, or created by a principal with `integ = untrusted` (`security.bpf.keylos.prov`) | location rule | `public/untrusted` |
| Under `/home/<u>/.apps/<app>/` | location rule | `private/user` |
| Other home data | location rule | `private/user` |
| Removable media | location rule | `internal/untrusted` |
| Store objects and generations | — | `public/trusted` |
| Network response from host H | host table | `trusted: true` → `public/user`; otherwise `public/untrusted` |
| Secret | — | `secret/user` |
| Camera, microphone and screen-capture handles | — | `private/user` |

Policy can override location rules with `/policy/labels.json`: an ordered list of `{rootKind, relGlob, label}`, first match wins.

#### 4.6.2 Directory label ceiling (exposure label)

A directory grant has an **exposure label** `c` (protocols §14.1, E31, ISS-004): the holder's session is raised to `c` **before** the handle exists, and for the grant's whole lifetime nothing labelled above `c` is readable through it. The bound is enforced, not sampled: `warden`'s BPF LSM refuses `open` of (and reads through fds opened via) any object under the grant mount whose label exceeds `c` or is malformed (protocols §7.5.1 `attachGrant(…, ceiling)`, §9.3). A bounded scan can therefore never justify a lower bound than what is enforced.

**Choosing `c`:**
1. `floor` := max(the directory's own label, its location rule from §4.6.1, `/policy/labels.json`).
2. Walk the directory (not crossing mounts; at most `labelWalkEntries` = 20 000 entries or `labelWalkMs` = 500 ms, reading `security.bpf.keylos.label` and the location rule of each entry).
3. **Complete walk:** `c` := max(`floor`, every entry's label). Nothing is hidden at grant time.
4. **Truncated walk:** `c` := `floor` (never lower), raised to the highest label seen so far. Entries above `c` exist or may exist; they are inaccessible through this grant and shown as hidden ("some items are hidden because they are more sensitive than this grant"). The human can re-grant with a higher ceiling (`grants raise-ceiling`, a new T2 approval that raises the label first).
5. The requester MAY ask for a higher ceiling (for example `secret/untrusted` to see everything); it is never lower than `floor`.
6. `attachGrant` with a null ceiling (no enforcement) is used only when `c` = `secret/untrusted` (the lattice top).

**Over time:**
- Objects created later through the grant carry the creating session's label (inode-init hook); objects renamed into the tree keep their xattr label; relabels raise only. Any of these above `c` become unreadable through the grant at once (checked on every `open` and on reads through fds opened via the grant mount, so retained handles are covered).
- Unlabelled objects get their location default; on kernels without `bpf-init-inode-xattr`, unlabelled objects created after the attach count as `secret/untrusted`.
- Grant trees are non-recursive bind mounts: nested mounts inside the directory are not part of the grant.
- The receipt `grant.issue` records `ceiling` and whether the assessment was complete.

**Agent input.** Agent sessions SHOULD receive immutable, completely assessed views (a `bench` share or strata transaction base snapshot): the base is immutable, so a complete assessment is exact for the grant's lifetime. The default policy denies `secret` resources to agents, so a live directory whose `c` would be `secret` is not granted to an agent.

Reads through the attached directory are not mediated by the broker afterwards; the kernel-enforced ceiling replaces the earlier "sample and hope" trade-off of [ADR-0026](../../handbook/11-decisions/adr-0026-labels-and-rule-of-two.md).

#### 4.6.3 Rule of Two evaluation

```
U(L)  = L.integ == untrusted
P(L)  = L.conf >= private
X(S)  = S holds any root with right commit, any effect right, or any net right to a host with sinkSafe=false
X(req)= req grants any of the above
L'    = S.label raised by req's resource

violation(S, req) = U(L') ∧ P(L') ∧ (X(S) ∨ X(req))
```

Checked at `request`/`requestFor` (predicted raise), `materialize` (actual label), `checkFlow` (gate at stage/commit/connect), and `raiseFor` (a raise that would complete the trifecta for a session already holding X freezes the session's effect and egress roots: their next use triggers declassification). Sink-safe hosts are those policy marks as unable to carry data to third parties; the default list is `localhost` only.

#### 4.6.4 Label authority

`LabelAuthority.labelOf(session)` returns the current label. `raiseFor(session, label, reason)` raises it monotonically, appends to the label history (`source` = `reason`, prefixed with the caller's service name), and writes `label.raise`. The holders are tier-0 services that hand data between principals (gate, bench, portal-*, atrium, strata, aide, journal, warden); they MUST call `raiseFor` before handing data over (protocols §14.1). `warden` additionally calls `labelOf` to fill `ConnectionInfo.label`.

### 4.7 Declassification and flow proofs

A declassification is a T3 approval whose prompt shows the session's current label and the sources that raised it (label history), the requested egress or effect, and argument provenance.

- Triggered by `gate` through `checkFlow`: the effect entries are those of the staged intent, and the mandate binds `payloadDigest`.
- Triggered by a raw egress request (no intent): the mandate binds `{host, port, methods, duration}` and the resulting token lives at most `declassifiedEgress` seconds (default 300).

A flow proof (`keylos.flowproof/1`, protocols §20.11, signed by the session key `aide` registered with `registerSessionKey`) is accepted instead of a prompt only if all hold:
1. The session's template generation's manifest has `agent.flowProof = "camel/1"` (read through `Depot.get`).
2. The proof's `runtime` is listed in `/policy/flowproof-runtimes.json`.
3. Every `controlSources[].label.integ ≤ user`.
4. `payloadDigest` equals the `FlowCheck.payloadDigest`.
5. The effect's class is not `irreversible`. Irreversible effects always need a human T3, even with a proof.

An accepted proof yields `GrantResult{outcome: granted, mandate: empty}` and an `approval.decide` receipt with `decidedBy: "flowproof"`.

### 4.8 Classifier hook

If `/policy/classifier.json` names a classifier service generation, the broker uses route `classifier#broker` and calls `Classifier.classify` (protocols §7.5.24, E22). For every T0/T1 decision of a non-`shell` principal it sends `ClassifyRequest{principal, kind, summary, label, recent (last 20 receipt summaries of the session), tier}` and receives `ClassifyResult{escalate: none|t2|t3, reason}`. A configured but unrouted classifier counts as a failure. The reply can only raise the tier; failure, timeout or malformed output raises it by one level (REQ-BROKER-053). The classifier sees summaries, not data, and holds no other route.

### 4.9 Policy generations

**Mounting.** The broker's service manifest declares a generation mount `/policy` whose source is the generation named by `/etc/keylos/policy.ref` in the active config generation. `warden` mounts it read-only at service start and re-mounts it before `ServiceHost.reload`.

| Path | Content |
|---|---|
| `/policy/policies.cedar` | Owner policy set (concatenated) |
| `/policy/org/*.cedar` | Org policies (fleet-enrolled machines only) |
| `/policy/schema.cedarschema` | MUST equal protocols §16.1 byte-wise (checked against the compiled-in copy) |
| `/policy/hosts.json` | Host table |
| `/policy/effects.json` | Effect registry additions (raise-only) |
| `/policy/labels.json` | Label location rules |
| `/policy/defaults.json` | Durations, batch windows, prompt expiry, `maxCallAmount` |
| `/policy/classifier.json` | Classifier configuration |
| `/policy/flowproof-runtimes.json` | Trusted flow-proof runtimes |
| `/policy/org-approvers.json` | Not used: org approver keys come only from `/etc/keylos/fleet/approvers.json` (protocols §10.7, E27); a policy generation that still ships this file is accepted and the file ignored with a warning |
| `/policy/strings/` | Prompt strings per locale |
| `/.keylos/manifest.json` | `kind: policy` |

**Activation:**
1. At startup, and on `BrokerSystem.loadPolicy(generation)` from `config` after `ServiceHost.reload`.
2. Check `/etc/keylos/policy.ref` (`keylos.policyref/1`) names the requested generation (on startup: whatever it names), `/policy/.keylos/manifest.json` has `kind: "policy"`, and the SHA-256 of that manifest's JCS bytes equals `policy.ref.digest` (REQ-BROKER-011). On startup a mismatch is fatal: the broker exits with status 78 and `warden` reports the service failed (no authority is created without the referenced policy).
3. Parse and validate. On failure: `kl:invalid`, keep the previous policy, `TrustedPrompt.notify(critical)` is left to `config`. If `policies.cedar` defines any default `@id` of §10.3 it is taken as the complete rendered set; otherwise the compiled-in defaults are prepended.
4. Swap atomically.

**Trust argument.** The config generation (and so `/etc/keylos/policy.ref`) is authorised by an owner-presence `keylos.configgen/1` statement that `boot` verifies at boot and `config` creates at apply (protocols §15, §20.7). The broker relies on `warden` mounting exactly the referenced generation; it does not re-verify the statement.

**`validatePolicy(tree)`.** `config` passes an `O_PATH` dirfd of a candidate policy tree. The broker reads it through the fd (holding the fd is the authority), validates schema equality, parses, validates the policy set, runs `*.cedartest.json` cases found under `tests/`, and returns problems. Nothing is activated.

**In-flight requests** finish under the policy they started with. Approvals created under the old policy are re-checked against the new policy when their decision arrives; if the new policy forbids the request, it is denied.

### 4.10 Roots and revocation

- **Roots** are held in memory with a write-through append log `/run/keylos/broker/roots.log` (tmpfs, current boot only; every append is written and `fsync`ed before the result is returned, and an append failure fails the operation), so a broker restart within the boot keeps the revocation set and ancestry.
- **Own root.** A holder revoking its own root is not frozen or killed itself; descendant holders are terminated per `onRevoke`.
- **Root key across restarts.** Kept in a `memfd_secret` stored in `warden`'s `FdStore` under key `root-key` (§4.1.1). `warden` keeps the fd and never reads it; on reboot it is gone.
- **Cascade.** Breadth-first over `children[root]`.
- **Holders.** For every session holding a revoked root: `PrincipalControl.terminate(session, mode)`; `GrantMounts.detachGrant` for each attached grant from a revoked root; `DeviceAdmin.revoke` for device roots.

### 4.11 Powerbox

```
app → Broker.powerbox(req)
broker: P := caller; require P.kind ∈ {app, legacy, shell} and tier ∈ {t1, legacy}  (agents use aide's keylos.powerbox.open host tool)
broker → portal-files#broker: FilePicker.pick(req, requester = P, user = P.human) → [PickResult]
   (the chooser runs in atrium's trusted surface; the user's selection IS the grant — no extra approval)
for each result:
   grantId := g-<ULID>; fdkey := "pbx:" + grantId; the right names exactly the picked object (a directory subtree, or the
         single file as rel = its basename under a root that is never exposed itself)
   file: reopen through the result fd: O_RDONLY (openFile), O_RDWR|O_CREAT (saveFile); for path-expecting clients
         the viewPath is portal-files' single-file view /grants/<name>/<basename> (protocols §7.3.3, E32, ISS-005):
         a directory containing only that file, safe-save renames executed by portal-files; the parent directory is
         never attached. Directory access only through openDirectory.
   directory: GrantMounts.attachGrant (§4.5.2)
   token := mint(right(kind, rel, ops), path_root(fdkey), expires = session lifetime, onRevoke default)
   label raise; receipt grant.issue{origin:"powerbox"}
   result.persist → presence-signed mandate (purpose grant.persist) obtained in the same chooser interaction
                    (TrustedPrompt.approve with requiresPresence, scope persistent) → grant record
return PowerboxGrant{fd, token, displayName, viewPath}
```

### 4.12 Session lifecycle with warden

```
warden.spawn(spec) from parent session Sp
  warden → BrokerSystem.registerSession{child=Pc, parent=Sp, offered=spec.grants, onRevoke}
     broker: verify each offered token belongs to Sp (or its ancestors) and is not revoked
             child tokens := delegate(offered, Pc.session)   (new roots; budgets carved as hard sub-meters, §4.5.8)
             re-mint persistent grants matching Pc's actor + human (§4.3)
             label := Sp.label ({public, trusted} for system services)
             return {tokens, label, tierFloor = max tier_floor}
  warden applies tierFloor, spawns, and the child obtains its tokens with Broker.myGrants
warden → BrokerSystem.sessionEnded(Pc.session, exitText)
hearth → BrokerSystem.revokeSession(session, "kill"|"freeze") at logout (kill) or lock (freeze of agent sessions)
```


### 4.13 Pod admission

```
cri → BrokerSystem.admitPod(podSpecJson, runtimeClass)
  1. caller check: service name "cri" (REQ-BROKER-103)
  2. key := SHA-256(JCS(podSpecJson) ‖ runtimeClass); cached decided result (≤ 10 min) or pending approval → return it
  3. spec := parse keylos.podspec/1 (unknown fields → kl:invalid); runtimeClass ∈ {keylos-vm, keylos-sealed} else kl:invalid
  4. R := Keylos::PodSpec{attributes of spec}; P := the kubelet service session's principal (human _cluster)
  5. decision := cedar(P, Action::"admit", R, ctx{time, profile, integrityProfile, offlineDays})
       forbid → PodAdmission{allowed:false, reasons:[forbid @ids]}             (no receipt here: cri writes pod.deny)
       no permit → PodAdmission{allowed:false, reasons:["no-permit"]}
       permit unannotated → PodAdmission{allowed:true, tierFloor}
       permit @tier/@orgApproval → create Approval{kind: pod-admission, effects:[pod.admit rendering]}; return
                                   PodAdmission{allowed:false, reasons:["pending-approval"], approval:"a-…"}
  6. tierFloor := 2 if runtimeClass = keylos-vm ∨ ¬allImagesSealed ∨ gpuPassthrough > 0 ∨ csiDrivers ≠ ∅, else 1
   (step 3 also recomputes allImagesSealed and rejects a mismatch, REQ-BROKER-124)
```

The rendering of a pod admission prompt lists namespace/name, service account, images (digests), host paths, volume types, CPU and memory. `approval.request`/`approval.decide` receipts are written by the broker as usual; `pod.admit`/`pod.deny` are `cri`'s. `cri` and `warden` (`PodSpawn`) enforce the admitted spec; a pod principal's authority comes from the VM or container confinement plus the `cri` network. The only broker tokens pods hold are **egress tokens** (REQ-BROKER-125): at `registerSession` of a principal with actor kind `pod` the broker mints, from the policy file `/policy/cluster-egress.json` (rendered by `config` from `cluster.egress`), one token per pod session with the listed `net(...)` facts, `tier_floor(<pod tier>)` and no expiry beyond the session (re-minted at each `registerSession`). `gate`'s per-pod shim (`PodSpawn.egressShim`, or the pod VM's `bench-net`) presents these tokens when `cluster.egressViaGate` is set. A pod principal that calls `broker#principal` (sealed pods are t1 principals) gets only the default policy for actor kind `pod`, which in the default set permits nothing.

### 4.14 Debug grants

```
shell → Broker.request{resource: principal(DebugTarget{target, scope}), rights: [debug], durationSecs}
  checks REQ-BROKER-130..132 → T3 approval, presence purpose "debug.grant", effects:
     [{kind: "debug.attach", target: "<target>:<scope>", digest: SHA-256(JCS GrantRequest)}]
  approved → token {right("principal", target, "debug"), debug_scope(scope), expires(now + min(durationSecs, cap))}
             receipt grant.issue{origin: "debug", dbgId}
shell → Broker.debug(token, debugger, entrypoint, argv, pty)
  verify token (session ancestry, revocation, expiry)
  DebugAttach.attach(target, scope, debugger, entrypoint, argv, pty, expiresSecs = expires − now, grantId)
  return Process
revoke(root) or expiry → PrincipalControl.terminate(debugger session, kill); warden removes kl_debug_pairs, writes debug.detach
```

`warden` checks the debugger generation against `debug.debuggers`; the broker does not duplicate that check. The `kish` builtin `debug` drives this flow.

### 4.15 Model identity and offline state

- **Model facts.** At `registerSession` of an agent session the broker reads the template's `models[]` (through `Depot.openPath(template, "/.keylos/agent/template.json")` on `depot#user`) and adds `model(provider, model, minVersion ?? "*")` facts to the agent's tokens. A re-approval after drift (`aide` → `requestFor(subject, GrantRequest{resource: model("<provider>/<model>@<version>"), rights: [use]}, …)`, T2 floor, Cedar action `use` on a `Keylos::Model` entity) yields a token with `right("model", "<provider>/<model>@<version>", "use")` and `model(provider, model, version)` carved from the session's agent root (REQ-BROKER-171); `gate` treats the session as re-approved once it presents that token. Until re-approval, the floor row of §4.4.3 applies to the session (flag set by `annotateRequest{"modelDrift": true}`, cleared by the approval).
- **Offline days.** A background task calls `Depot.revocations()` every 10 min, verifies nothing itself (depot verified the list), and reads `issued` from the envelope payload. `offline_days = floor((trustedNow − issued) / 86 400 s)`. Before trusted time exists (protocols §3.6) the time floor is used, which can only make `offline_days` smaller than the truth; the 30-day rule is therefore evaluated again at the first trusted-time event.
- **Agent host history.** `/var/lib/keylos/broker/agent-hosts.db` (redb) maps `(template name, host:port) → last grant time`; entries older than 90 days are pruned.

### 4.16 Guests and family requests

- `Human.guest` is `true` for `guest-…` users (also reported by `HearthSystem.validateSession`). Guest principals are evaluated normally except for the refusals of REQ-BROKER-150, applied before Cedar.
- A non-owner's owner-class request creates an `ApprovalState` with `requester = <human>` and `channels` from the permit. It is held in a per-machine owner queue (at most 50 entries, oldest expiring first, each ≤ 7 days). When `atrium` reports an owner's trusted-path session (it calls `TrustedPrompt.approve` only when an owner is at the seat; the broker learns owner presence from `hearth#system` session validation of the approver session), queued prompts are shown in order. The requester's `Approval.wait` stays pending; the requester sees "waiting for an owner" through `grants approvals`.

### 4.17 Quorum approvals

```
approval with presence on a quorum machine (or a headless T2/T3 escalated per REQ-BROKER-161)
  payload := mandate draft (JCS); rendering := RenderedEffect texts
  (requestId, requestEnvelope) := HearthQuorum.request("mandate" | "grant.persist" | "debug.grant", payload, rendering)
  ApprovalState.quorum := requestId; status pending
  poll HearthQuorum.collect(requestId) every 10 s (and on hearth notification) until envelope or expiry
  envelope := quorum presence envelope (≥ threshold distinct owners)
  verify with keylos-presence (quorum mode) → mandate channel "quorum", decidedBy "quorum" → deliver as is (presence: true)
  → approval.decide{channel: "quorum", decidedBy: "quorum", signers}
```

Quorum approvals never batch; each is one request. `fleet` relays requests to approvers (protocols §5.4); the broker never talks to approvers itself.

### 4.18 Durable workflows

The broker holds the authority side of every workflow (protocols §20.25); `loom` holds progress. Module `workflows` owns the records and decisions below; it uses `policy`, `mint`, `roots`, `approvals` and `labels` like any other request path.

#### 4.18.1 Workflow records (`keylos.workflow-grant/1`)

A DSSE envelope signed by `service/broker`, payload type `application/vnd.keylos.workflow-grant+json; version=1`:

```json
{"schema":"keylos.workflow-grant/1","workflow":"wf-…","recordSeq":7,"state":"active",
 "owner":"alice","subject":"shell@alice/s-…","definition":{"generation":"gen:fsv256:…","name":"coding-task","digest":"sha256:…"},
 "scope":[<GrantRequest JSON forms, protocols §14.4>],"budgets":[{"unit":"usd-micro","amount":5000000}],"account":"ba-…",
 "resume":"manual","runWhileLocked":false,"horizon":"2026-11-07T10:00:00Z","label":{"conf":"private","integ":"untrusted"},
 "enrollMandate":"<base64 delivered mandate>","decision":"dr-…",
 "claim":{"epoch":12,"attempt":"wa-…","step":"ws-….test.2","generation":"gen:fsv256:…","spawner":"s-…","time":"…"},
 "time":"…"}
```

- `state` ∈ `enrolling`, `active`, `cancelled`, `forgotten`; only `enrolling → active → cancelled → forgotten` (or `enrolling → cancelled`) transitions exist.
- `recordSeq` increases by one with every write; a record read from disk with a lower `recordSeq` than the in-memory or anchored value is stale (REQ-BROKER-194).
- The file is the authority for claims and attempt grants; the signature protects it against tampering by anything that cannot use the broker key, exactly as for grant records (§4.3). Records are loaded at startup; a record whose signature fails is ignored, reported (`grant.deny{reason: integrity, workflow}`) and refuses claims.

#### 4.18.2 Enrollment

```
enroll(subject, req)                                          (caller loom)
  1  S := sessions[subject] ?→ kl:denied;  S.human is guest or S.kind ∉ {shell} (atrium: only for its own human) → deny
  2  W := Workflow entity {definitionName, definition, owner = S.human, autoResume = req.resume == automatic,
                           runWhileLocked, horizonSecs, scopeKinds, effectKinds (from the definition, via loom's request)}
  3  tier := cedar(enroll, S.principal, W) ; for item in req.scope: tier := max(tier, request_tier(item, persist = true))
     tier := max(tier, t2); presence := presence ∨ W.autoResume ∨ W.runWhileLocked
  4  digest := SHA-256(JCS(EnrollRequest JSON form))            # members as in protocols §7.5.25, input as its digest
  5  D := decide-internal(workflow = req.workflow, key = "enroll",
                          effects = [{workflow.enroll, req.workflow, digest}] + [{grant.<k>, resource, GrantRequest digest}…],
                          tier, presence)                        # §4.18.3
  6  write record {state: enrolling, subject, owner, request} (REQ-BROKER-181)
  on D approved: WorkflowBudget.open(account, workflow, budgets); record := active (REQ-BROKER-183); receipt grant.issue{workflow, origin: "enroll"}
```

The prompt renders the `workflow.enroll` required details (protocols §14.2): the definition, every scope item, budgets, the resume policy ("runs again after restarts without asking" for `automatic`), `runWhileLocked`, the horizon, the owner and the starting label.

#### 4.18.3 Durable decisions (`keylos.decision/1`)

```json
{"schema":"keylos.decision/1","id":"dr-…","workflow":"wf-…","key":"effect:fx-…","digest":"sha256:…",
 "requests":[…],"effects":[{"kind":"fs.merge","target":"fs:~/src/proj","digest":"sha256:…"}],
 "tier":"t3","presence":false,"channels":["local"],"state":"pending","created":"…","expires":"…",
 "decidedBy":null,"mandate":null,"consumedBy":null}
```

- Written with temp file + `fsync` + rename + directory `fsync`, unsigned (the mandate inside is signed; the record grants nothing without a valid mandate and a current workflow record).
- **Lifecycle.** `pending` → `approved` | `denied` | `expired` | `cancelled`. On `pending` the broker creates an `ApprovalState` (§4.4.4) with a fresh `a-…` and the draft `constraints.workflow`/`constraints.decision`; the `a-…` is never persisted. On a verified decision: persist the record (state, delivered mandate) → write `approval.decide{decision, workflow, mandateDigest}` → return. At startup every `pending` record whose `expires` has not passed gets a new prompt (routed per §4.4.4; for an owner who is not at the trusted path it waits for the next owner trusted-path session or a permitted phone channel); `pending` records past `expires` become `expired`.
- **Deduplication** by `(workflow, key)` and digest (REQ-BROKER-186). The table is rebuilt from the directory at startup.
- **Consumption.** Effect decisions are consumed by `gate` (single use per effect ID, protocols §20.26); the broker records nothing further. Grant decisions are used only through `rebind` (REQ-BROKER-188); each rebind is receipted `grant.issue{decision, attempt}`.

#### 4.18.4 Claims, attempt registration and fencing

```
claim(binding, gen, spawner)                                  (caller loom)
  R := records[binding.workflow] ?→ kl:not-found
  R.state ∈ {cancelled, forgotten} → kl:revoked;  now ≥ R.horizon → kl:expired
  binding.epoch ≠ R.claim.epoch + 1 ∨ binding.owner ≠ R.owner → kl:conflict
  R.claim := {binding.epoch, binding.attempt, binding.step, gen, spawner}; write R (recordSeq+1, fsync)   # REQ-BROKER-181
  receipt grant.issue{workflow, epoch, origin: "claim"}
  revoke every root with workflow fact = R.workflow and epoch < binding.epoch (kill holders)
  return info(R)

registerSession(reg) with reg.attempt.epoch ≠ 0               (caller warden, after loom's spawn or bench's VmSpawn.register)
  R := records[reg.attempt.workflow]; require current claim, generation, parent == claim.spawner, human == R.owner
  label := join(default(kind), R.label)                        # labels before grants
  for item in R.scope: decide with the workflow principal entity (current policy, floors); t2/t3 need R.enrollMandate
  mint roots for reg.child.session: facts of the item + workflow(R.workflow, epoch) + budget_account(R.account)
                                    + expires(min(policy duration, R.horizon))
  receipts grant.issue{workflow, epoch, attempt, items}; return {tokens, label, tierFloor}
```

`verify` answers from memory (records are loaded at start and updated on every write). The broker never trusts loom's view of the epoch: a loom with a restored, older store presents an epoch ≤ the record's and gets `kl:conflict`.

#### 4.18.5 Cancellation, forgetting and revocation

`cancel` follows REQ-BROKER-192: the persisted `cancelled` record is the durable revocation record, written before any revocation, so a crash after it still leaves the workflow cancelled, and the startup scan (§4.1.1 step 6a) revokes nothing that survived the reboot anyway because tokens are per boot. `grants revoke wf-…` maps to `cancel(<caller>, wf, "grants-cli", false)`. Roots minted for a workflow are linked in the root registry to the workflow ID, so revocation by workflow is one lookup.

#### 4.18.6 Rollback anchoring

The broker anchors its workflow and decision records against its own receipts (protocols §20.25): `workflows/anchor.json` holds the ledger `seq` of the newest acknowledged receipt naming a workflow, written after each such receipt (best effort; the check below tolerates a lagging anchor because it compares states, not counts). At startup (§4.1.1 step 6a) the broker queries `Ledger.query({principalPrefix: "service:broker:", fromSeq: anchor + 1})`, keeps receipts whose `refs` name a workflow, and for each checks that the record's state and epoch are at least what the receipt shows. A record that is behind is brought forward (state, epoch fence) and marked `rollback-review`; claims for it fail `kl:conflict` with reason `rollback-review` until the owner accepts (REQ-BROKER-194). The ledger's own rollback protection (NV counter, protocols §13.3) anchors this transitively; no NV index of the broker's own exists.

---

## 5. Interfaces

### 5.1 `Broker` (facet `principal`)

Implemented exactly as embedded in §2.2.3.

| Method | Notes |
|---|---|
| `request` | `durationSecs` capped by policy; `persist` requires presence |
| `materialize` | Token session must be the caller's session or an ancestor (REQ-BROKER-030) |
| `attenuate` | Offline attenuation is equally valid; this method serves clients without a Biscuit library |
| `delegate` | `child` MUST be a live session registered by `warden` whose parent is the caller |
| `revoke` | REQ-BROKER-070 |
| `inspect` | Cached 5 s by SHA-256 of the token bytes; revocation invalidates the cache. Also on facet `system` |
| `label` | |
| `raiseLabel` | Raises the caller's own label (apps and harnesses that ingested untrusted data through an unmediated channel) |
| `powerbox` | §4.11 |
| `myGrants` | Tokens currently minted for the caller's session |
| `debug` | §4.14; caller must hold a `debug` token for its own session |

### 5.2 `BrokerSystem` (facet `system`) and `LabelAuthority` (facet `label-authority`)

Implemented exactly as embedded in §2.2.3 (protocols §7.5.2). Callers per REQ-BROKER-103.

| Method | Behaviour |
|---|---|
| `registerSession` | §4.12 |
| `sessionEnded` | REQ-BROKER-004 |
| `checkFlow` | §4.6.3, §4.7; returns `GrantResult` |
| `requestFor` | REQ-BROKER-101, -104, -105, -106, -107, -108; the prompt names the subject, the intent and `onBehalfOf`; `intentSession` is required from `gate` and empty from all other callers; deduplicated by `(caller, idempotencyKey)` |
| `registerApprover` | §2.3 note 4; `channel` must match the caller (`atrium` → `local`, `vouch` → `phone`) |
| `registerSessionKey` | Stores the agent session's public key for flow-proof verification; the key is forgotten at `sessionEnded` |
| `annotateRequest` | Stores provenance hints for the session's next request (consumed once, expires after 30 s) |
| `rootsChanged` | §4.2 |
| `revokeSession` | Revokes all roots of the session and its descendants with the given mode |
| `loadPolicy`, `validatePolicy` | §4.9 |
| `mintCaptive` | REQ-BROKER-170: mints `{captive(true), tier_floor(2), net("*", 80/443, "tcp", "*"), net("*", 53, "udp", "*"), expires(now+600s)}` for the captive-browser VM session named and **attaches it to that session** (returned by the VM session's `myGrants`, so `bench-net` picks it up); refused unless the session's image generation name is `io.keylos.bench.captive-browser` |
| `admitPod` | §4.13 |
| `labelOf`, `raiseFor` | §4.6.4 |

### 5.2a `BrokerWorkflow` (facet `workflow`)

Implemented exactly as embedded in §2.2.8 (protocols §7.5.25). Callers per REQ-BROKER-180.

| Method | Behaviour |
|---|---|
| `enroll` | §4.18.2, REQ-BROKER-182/183 |
| `claim` | §4.18.4, REQ-BROKER-184 |
| `verify` | REQ-BROKER-191 |
| `decide` | §4.18.3, REQ-BROKER-186/187 |
| `rebind` | REQ-BROKER-188 |
| `authorizeEffect` | REQ-BROKER-189 |
| `offer` | REQ-BROKER-190 |
| `resume` | REQ-BROKER-191 |
| `cancel` | §4.18.5, REQ-BROKER-192/193 |
| `record` | Returns `WorkflowRecordInfo` from memory |
| `raise` | REQ-BROKER-191 |

### 5.3 Repo-local interface (`grants` CLI only)

The `grants` CLI uses a repo-local schema on facet `principal` (obtained with `Extensible.ext`), file ID `0x9d3e41b7c2a65f01`:

```capnp
@0x9d3e41b7c2a65f01;
using C = import "common.capnp";

interface GrantsCli {
  roots      @0 (session :Text, persistent :Bool, human :Text) -> (json :Text);   # visible roots and records
  show       @1 (id :Text) -> (json :Text);                                       # rootId or grantId
  revokeId   @2 (id :Text, mode :Text) -> ();
  history    @3 (session :Text) -> (json :Text);                                  # label history
  approvals  @4 (pendingOnly :Bool) -> (json :Text);
  check      @5 (requestJson :Text) -> (json :Text);                              # dry-run Cedar evaluation
  test       @6 (tree :C.Fd) -> (json :Text);                                     # run *.cedartest.json
  heldRoots  @7 () -> (json :Text);
  addProject @8 (dir :C.Fd) -> (fdkey :Text);                                     # shell principals only
}
```

No other repository consumes it.

### 5.4 CLI: `grants`

`grants` ships a `keylos.cmdsig/1` for every subcommand. Output is records when the shell negotiates `cbor-seq`, a table otherwise.

| Command | Description | Exit codes |
|---|---|---|
| `grants list [--session S] [--persistent] [--human U]` | Live roots and persistent records visible to the caller (own sessions and descendants; a shell sees its human's). Fields: `root`, `grantId`, `principal`, `resource`, `rights`, `expires`, `tier`, `origin` | 0 ok, 2 error |
| `grants show <rootId|grantId>` | Facts, ancestry, label at issue, receipts | 0, 1 not found, 2 |
| `grants revoke <rootId|grantId> [--mode kill|freeze]` | Revoke and cascade; a `grantId` also deletes the record | 0, 1, 2 |
| `grants request <kind> <resource> --rights r,… [--for 30m] [--persist] [--reason TEXT]` | Request a grant for the current shell session | 0 granted, 3 denied, 4 pending timed out |
| `grants label [--session S]` | Session label and its raise history | 0 |
| `grants approvals [--pending]` | Approvals and their state | 0 |
| `grants project add <dir>` | Register a project directory as a held root (`proj:`) | 0, 3 |
| `grants policy check --principal P --action A --resource R [--context JSON]` | Dry-run evaluation: matching policies and the resulting tier | 0 permit, 3 deny |
| `grants policy test <dir>` | Run `*.cedartest.json` cases (§11.4) against a candidate policy directory | 0 all pass, 1 failures |
| `grants roots` | Held roots: fdkey, canonical path, holders | 0 |
| `grants workflows [--human U]` | Workflow records visible to the caller: workflow, owner, state, epoch, horizon, label, pending decisions | 0 |
| `grants revoke <wf-…>` | Durable workflow cancellation and revocation (REQ-BROKER-192) | 0, 1, 2 |
| `grants workflow accept-rollback <wf-…>` | Accept a workflow record brought forward after a store rollback (REQ-BROKER-194); presence | 0, 3 |
| `grants raise-ceiling <grantId|viewPath> [--to conf/integ]` | Re-grant a directory with a higher exposure label (T2; raises the session label first, §4.6.2) | 0, 3 |

### 5.5 Files and sockets

| Path | Owner | Mode | Content |
|---|---|---|---|
| `/var/lib/keylos/broker/grants/*.dsse` | broker | 0600 | Grant records |
| `/var/lib/keylos/broker/suspended/*.dsse` | broker | 0600 | Suspended grant records |
| `/var/lib/keylos/broker/workflows/<wf-…>.dsse`, `workflows/anchor.json` | broker | 0600 | Workflow records (§4.18.1) and the rollback anchor (§4.18.6); file and directory `fsync`ed |
| `/var/lib/keylos/broker/decisions/<dr-…>.json` | broker | 0600 | Durable decision records (§4.18.3); file and directory `fsync`ed |
| `/var/lib/keylos/broker/service-key.sealed` | broker | 0600 | TPM-sealed `service/broker` key |
| `/run/keylos/broker/roots.log` | broker | 0600 | Root ancestry and revocation log (current boot); each append `fsync`ed before the revocation or mint is acknowledged |
| `/run/keylos/broker/idem.log` | broker | 0600 | `requestFor` deduplication (REQ-BROKER-105; current boot, appends `fsync`ed) |
| `/var/lib/keylos/broker/agent-hosts.db` | broker | 0600 | Hosts held per agent template (REQ-BROKER-142) |
| `/policy/` | warden mount | ro | Active policy generation |
| `/run/keylos/svc/broker/` | warden | 0700 | Service socket directory (protocols §7.2) |

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| A caller impersonates another principal | Identity comes only from `warden` (`ServiceHost.accept`, `SO_PEERPIDFD`). Tokens are bound to sessions; `materialize` checks session ancestry |
| Token theft (copied to another process) | Useless in a non-descendant session; tokens expire; revocation |
| Path traversal and symlink races | `openat2` with `RESOLVE_BENEATH|NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV`; no string-path authorization |
| Confused deputy through directory fds | The broker never hands its own dirfds to host-confined principals; grants are attached in the holder's namespace |
| Policy tampering | Policy comes only from the generation named by the presence-authorised config generation, mounted by `warden` |
| Grant-record tampering by runtime root | Records are re-evaluated against policy at re-mint; T2/T3 records need a presence-signed mandate; a forged T0/T1 record grants nothing policy would not permit |
| Approval spoofing | Approvals arrive only through `atrium#approve` and `fleet#decider`; mandates are verified per signer class (§4.4.4) |
| Prompt fatigue | Tier floors, batching, effects rendered instead of requests, presence for persistence, classifier escalation |
| Classifier compromise | Escalate-only; failure escalates |
| Broker crash loses revocations | Append log plus `FdStore`-held root key |
| Approval flooding | At most 5 pending approvals per session; further requests fail `kl:unavailable` |
| Label-authority abuse | Facet limited to tier-0 data-handoff services; raises only; every raise receipted |

### 6.2 Residual risks

- **Runtime kernel or tier-0 compromise** can read the broker's memory and mint tokens until reboot. "Reboot heals": root keys rotate and grant records are re-evaluated against policy at the next boot.
- **Unmediated reads after a directory grant** make directory labels conservative ceilings rather than exact values.
- **Covert channels through sink-safe hosts.** A host wrongly marked sink-safe can carry data out.
- **Quorum sealing and approvals** reduce "a physical touch" to "N approvers signed and the machine runs a verified `hearth`" (protocols §5.4); `status` shows it.
- **Pod admission is spec-level.** The broker decides on the normalised `keylos.podspec/1`; enforcement of the admitted spec is `cri`'s and `warden`'s.

### 6.3 Confinement of `brokerd`

| Property | Value |
|---|---|
| Tier | t0 |
| UID | Dynamic principal UID allocated by `warden` for service `broker` |
| Namespaces | mount, pid, ipc, uts, cgroup, net (only `lo`) |
| Mount view | `/` = broker generation; `/etc` (app-visible config subset plus `/etc/keylos/policy.ref`); `/policy` (ro); `/var/lib/keylos/broker` (rw); `/run/keylos/broker` (rw); `/home` (ro, idmapped read access, `nosymfollow`) for held roots; removable media roots (ro); `/run/keylos/boot` (ro); `/proc` (subset=pid) |
| Landlock | Read on `/home` and media roots; read-write on its state dirs; execute only in its own generation |
| Linux capabilities | `CAP_DAC_READ_SEARCH` (open human-owned directories for held roots) and `CAP_FOWNER` (set `security.bpf.keylos.label` on files created through `create` rights) |
| seccomp additions | `openat2`, `name_to_handle_at`, `fgetxattr`, `fsetxattr`, `memfd_secret`, `mlock`, `unlinkat` |
| TPM | `/dev/tpmrm0` fd from `warden`, used only to unseal the `service/broker` key |
| Core dumps | `prctl(PR_SET_DUMPABLE, 0)` |

seccomp cannot inspect xattr names; the restriction to `security.keylos.*` is enforced in-process, and a BPF LSM rule owned by `warden` limits `security.bpf.keylos.label` writes to the broker and `strata`.

### 6.4 Known limitations

- `write`, `create` and `delete` on attached directories collapse to "read and change"; prompts say so.
- Labels of files written by holders inside attached directories are set by `strata`'s creation hook, not by the broker.
- Runtime file and directory grants to VM principals are delivered as hot-plugged shares by `bench-relay` (`Vm.attachShare`); a share appears as a new path `/shares/<name>` in the guest, not at a path the guest application chose.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| `ledger` unavailable | Fail closed (REQ-BROKER-091); `warden` restarts `ledger`; callers retry after `kl:unavailable` |
| `atrium` unavailable or headless profile | REQ-BROKER-161: org decision if allowed and fleet-enrolled; otherwise a quorum request on quorum machines; otherwise denied with reason `no-trusted-path` |
| `hearth` quorum request expires | Approval resolves `denied{reason: expired}` |
| `gate` refuses `carve` (`kl:budget`) | Delegation fails `kl:budget`; nothing minted |
| `requestFor` repeated after a broker restart with a pending approval | A new approval is created under the same idempotency key (pending state is not persisted) |
| Broker restart or reboot with a pending durable workflow decision | The decision record survives; a new prompt (new `a-…`) is shown; `decide` with the same key returns the same `dr-…` |
| Crash after a durable decision is verified, before the reply | The decision was persisted first; the retried `decide`/`authorizeEffect` returns it; the mandate is consumed only once by `gate` |
| Write of a workflow or decision record fails (`fsync`, disk full) | The method fails `kl:unavailable`; in-memory state unchanged; no receipt claims success |
| Restored older `workflows/` directory | Rollback check (§4.18.6) brings records forward from receipts and holds claims for owner review |
| `gate` unavailable at enrollment approval | The budget account cannot be opened; the record stays `enrolling` and the broker retries; the decision is reported approved only after the account exists |
| `policy.ref` digest mismatch at startup | Exit 78; `warden` marks the service failed; `config` activation-failure handling applies (protocols §15) |
| `hearth` unavailable | Presence mandates cannot be verified (registry): those decisions fail `kl:unavailable`. The cached owner registry is used for up to 1 h for `Human.owner` attributes |
| `gate` unavailable | Network materialization fails `kl:unavailable` |
| `devd`, `vault`, `portal-files` unavailable | The corresponding materialization or powerbox fails `kl:unavailable` |
| Policy generation invalid | Previous generation stays active; `loadPolicy` fails `kl:invalid` |
| No policy generation | Default policy set (§10.3) |
| Broker crash | `warden` restarts it; root key from `FdStore`; `roots.log` replayed; in-flight approvals lost (`wait` fails `kl:unavailable`; requesters retry) |
| Grant-record verification failure | Skipped; `grant.deny{reason: integrity}`; notification |
| Clock not trusted | Clamped clock (§4.4.2) |

---

## 8. Performance budgets

| Operation | Budget (p99, warm cache, x86-64-v3 laptop) |
|---|---|
| `request` resolved at T0/T1 (Cedar + mint + receipt) | ≤ 2.0 ms |
| `materialize` of a file | ≤ 0.6 ms |
| `materialize` of a directory (attach through `warden`) | ≤ 8 ms |
| `materialize` of a net socket (excluding gate and the TCP handshake) | ≤ 1.0 ms |
| `inspect` (cached) | ≤ 50 µs |
| `raiseFor` | ≤ 100 µs plus receipt append |
| Cedar evaluation, 5 000 policies | ≤ 300 µs |
| Revocation cascade, 10 000 descendants | ≤ 50 ms |
| Token size, authority block plus 3 attenuations | ≤ 2 KiB |
| Memory, 1 000 live sessions, 20 000 roots | ≤ 128 MiB RSS |
| Startup to ready (5 000 policies) | ≤ 300 ms |

---

## 9. Observability

**Receipts** (protocols §19.3):

| Event | `data` fields |
|---|---|
| `grant.issue` | `rootId`, `rights[]` (`kind:resource:op` with the token's resource text, e.g. `path:<rel>:read`, not an absolute path), `expires`, `tier`, `origin` (request, requestFor, powerbox, persistent, registerSession, path-open-summary, vm-share, debug, captive, cluster-egress, model, screen), `grantId?`, `viewPath?`, `dbgId?`, `onBehalfOf?` |
| `grant.attenuate` | `rootId`, `checksDigest` |
| `grant.delegate` | `parentRoot`, `childRoot`, `childSession`, `budgetCeiling?` |
| `grant.revoke` | `rootId`, `cascade` count, `mode`, `by`, `reason?` (`single-use`, `expired`, `captive-reissue`) |
| `grant.deny` | `requestDigest`, `reason` (policy, forbid, rule-of-two, integrity, expired, rate, unsupported) |
| `label.raise` | `session`, `from`, `to`, `source` (canonical resource, `raiseLabel:<reason>` or `<service>:<reason>`) |
| `approval.request` | `approvalId`, `tier`, `kind` (grant, declassification, delegation-widen, budget-overrun, pod-admission, debug, approver-registration), `channels`, `requester?`, `onBehalfOf?`, `quorumRequest?`, `effects[]` |
| `approval.decide` | `approvalId`, `approved`, `scope`, `decidedBy` (human, flowproof, org, quorum, expired), `channel` (local, phone, org, quorum), `signers?` (quorum), `mandateDigest` (SHA-256 of the delivered envelope, REQ-BROKER-112) |

**Logs** (journal records): level 6 for decisions (rate-limited per session), level 4 for denials, level 3 for integrity failures.

**Metrics** (records `0x1F`, protocols §10.6): `broker_requests_total{tier,outcome}`, `broker_materialize_seconds{kind}`, `broker_approvals_pending`, `broker_rule_of_two_violations_total`, `broker_revocations_total`, `broker_label_raises_total{service}`, `broker_policy_generation_info{gen}`, `broker_pod_admissions_total{outcome}`, `broker_quorum_pending`, `broker_idempotent_hits_total`, `broker_offline_days`.

---

## 10. Configuration

### 10.1 Nickel schema (`keylos.broker` module, rendered into the policy generation's `defaults.json`, `hosts.json`, `labels.json`, `flowproof-runtimes.json`, `cluster-egress.json` and `policies.cedar`)

`cluster-egress.json` is rendered from the `cluster.egress` option (a list of `{namespace, pod, hosts}` rules, default empty) by the `config` cluster module into the policy generation; its format `keylos.cluster-egress/1` is defined in REQ-BROKER-125 and read only by the broker.

```nickel
{
  broker | {
    durations | {
      shell      | Number | default = 28800,
      app        | Number | default = 28800,
      agent      | Number | default = 1800,
      legacy     | Number | default = 28800,
      declassifiedEgress | Number | default = 300,
    },
    approvals | {
      expirySecs      | Number | default = 600,
      t2BatchWindowMs | Number | default = 3000,
      t2BatchMax      | Number | default = 10,
      maxPendingPerSession | Number | default = 5,
    },
    maxCallAmount | { _ : Number } | default = {},        # per budget unit, optional per-call cap on delegated budgets
    classifier | {
      enabled    | Bool   | default = false,
      generation | String | optional,
      timeoutMs  | Number | default = 800,
    },
    onRevokeDefaults | {
      agent  | [| 'kill, 'freeze |] | default = 'kill,
      app    | [| 'kill, 'freeze |] | default = 'freeze,
      legacy | [| 'kill, 'freeze |] | default = 'freeze,
    },
    hosts | Array {
      name     | String,
      ports    | Array Number | default = [443],
      trusted  | Bool | default = false,
      sinkSafe | Bool | default = false,
    } | default = [],
    labels | Array { rootKind | String, relGlob | String, conf | String, integ | String } | default = [],
    flowProofRuntimes | Array String | default = [],
    guestAgents | Bool | default = false,          # mirrors hearth.guest.agents (REQ-BROKER-150)
    ownerQueue | { maxEntries | Number | default = 50, maxAgeDays | Number | default = 7 },
    cluster | {
      hostPathAllowlist | Array String | default = [],   # read-only host paths pods may mount (default forbids, §10.3)
    },
    policies | Array String | default = [],      # Cedar fragments appended after the defaults
  }
}
```

### 10.2 Policy composition

The compiled policy set is the default policy set (§10.3) followed by the owner's `broker.policies`, followed (on fleet-enrolled machines) by the org policies. Floors (§4.4.3) apply regardless.

### 10.3 Default policy set

```cedar
// Humans' shells may request anything in their own home.
@id("shell-home")
permit (principal, action in [Keylos::Action::"read", Keylos::Action::"write", Keylos::Action::"create", Keylos::Action::"delete"], resource is Keylos::Path)
when { principal.kind == "shell" && resource.root like "home:*" };

// Apps: own data subvolumes silently.
@id("app-own-data")
permit (principal, action in [Keylos::Action::"read", Keylos::Action::"write", Keylos::Action::"create", Keylos::Action::"delete"], resource is Keylos::Path)
when { principal.kind == "app" && resource.root like "appdata:*" };
// Cedar has no string concatenation, so "the app's own data" cannot be written in policy. The broker enforces it
// natively before Cedar: an app's appdata:<user>:<app> root must name the caller's own human and generation name,
// otherwise the request is denied without evaluating policy.

// Apps: other home paths outside the powerbox need T2.
@id("app-home-other")
@tier("t2")
permit (principal, action in [Keylos::Action::"read", Keylos::Action::"write", Keylos::Action::"create"], resource is Keylos::Path)
when { principal.kind == "app" && resource.root like "home:*" };

// Apps: hosts consented at install are T1 grant records; new hosts T2.
@id("app-net-new")
@tier("t2")
permit (principal, action == Keylos::Action::"connect", resource is Keylos::Host)
when { principal.kind == "app" };

// Agents: read inside project roots silently.
@id("agent-read")
permit (principal, action == Keylos::Action::"read", resource is Keylos::Path)
when { principal.kind == "agent" && resource.root like "proj:*" };

@id("agent-net")
@tier("t2")
permit (principal, action == Keylos::Action::"connect", resource is Keylos::Host)
when { principal.kind == "agent" };

@id("agent-effects-stage")
permit (principal, action == Keylos::Action::"stage", resource is Keylos::Effect)
when { principal.kind == "agent" };

@id("agent-effects-commit")
@tier("t3")
permit (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { principal.kind == "agent" };

@id("compensable-commit")
@tier("t2")
permit (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { resource.class == "compensable" };

@id("delegate-bounded")
permit (principal, action == Keylos::Action::"delegate", resource is Keylos::Principal)
when { principal.depth < 3 };

// Secrets: agents need T2 per secret (use only; never read).
@id("secret-use")
@tier("t2")
permit (principal, action == Keylos::Action::"use", resource is Keylos::Secret)
when { principal.kind == "agent" };

// hearth: FIDO2 authenticators (hidraw) without prompting; the device grant is how hearth reaches security keys.
@id("hearth-fido")
permit (principal, action == Keylos::Action::"use", resource is Keylos::Device)
when { principal.kind == "service" && principal.generationName == "io.keylos.hearth" && resource.subsystem == "hidraw" };

// Devices need approval.
@id("device-use")
@tier("t2")
permit (principal, action == Keylos::Action::"use", resource is Keylos::Device);

// Payments always need presence and allow only the local channel.
@id("payment-presence")
@tier("t3")
@presence("true")
@channels("local")
permit (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { resource.kind == "payment.authorize" };

// Never: secret-labelled files to agents.
@id("no-agent-secret-files")
forbid (principal, action == Keylos::Action::"read", resource is Keylos::Path)
when { principal.kind == "agent" && resource.labelConf == "secret" };

// Never: legacy principals spawn.
@id("no-legacy-spawn")
forbid (principal, action == Keylos::Action::"spawn", resource is Keylos::Generation)
when { principal.kind == "legacy" };

// Debugging: owners' shells only, T3 with presence (REQ-BROKER-131 enforces the floor regardless).
@id("debug-owner")
@tier("t3")
@presence("true")
@channels("local")
permit (principal, action == Keylos::Action::"debug", resource is Keylos::DebugTarget)
when { principal.kind == "shell" };

@id("no-agent-kernel-debug")
forbid (principal, action == Keylos::Action::"debug", resource is Keylos::DebugTarget)
when { principal.kind == "agent" && resource.scope == "kernel" };

// Pods: the mandatory admission forbids of protocols §16.1 (the hostPath allowlist is rendered from cluster.hostPathAllowlist).
@id("pod-no-privileged")
forbid (principal, action == Keylos::Action::"admit", resource is Keylos::PodSpec) when { resource.privileged };
@id("pod-no-host-namespaces")
forbid (principal, action == Keylos::Action::"admit", resource is Keylos::PodSpec)
when { resource.hostNetwork || resource.hostPID || resource.hostIPC };
@id("pod-no-added-caps")
forbid (principal, action == Keylos::Action::"admit", resource is Keylos::PodSpec)
when { !resource.addedCapabilities.isEmpty() };
@id("pod-no-unconfined-seccomp")
forbid (principal, action == Keylos::Action::"admit", resource is Keylos::PodSpec)
when { resource.seccompProfile == "unconfined" };
@id("pod-no-privilege-escalation")
forbid (principal, action == Keylos::Action::"admit", resource is Keylos::PodSpec)
when { resource.allowPrivilegeEscalation };
@id("pod-hostpath-allowlist")
forbid (principal, action == Keylos::Action::"admit", resource is Keylos::PodSpec)
when { !resource.hostPaths.isEmpty() && (!resource.hostPathsReadOnly || !(HOSTPATH_ALLOWLIST.containsAll(resource.hostPaths))) };
// Pods otherwise admitted at T0 for the cluster's kubelet.
@id("pod-admit-default")
permit (principal, action == Keylos::Action::"admit", resource is Keylos::PodSpec)
when { principal.kind == "service" && principal.generationName == "io.keylos.kubelet" };

// Durable workflows (protocols §16.1, §20.25). The broker enforces natively: tier ≥ t2 for enroll, presence for
// autoResume or runWhileLocked, guest and non-shell subjects denied.
@id("workflow-enroll")
@tier("t2")
permit (principal, action == Keylos::Action::"enroll", resource is Keylos::Workflow)
when { principal.kind == "shell" && resource.owner == principal.human && !principal.humanGuest
       && !resource.autoResume && !resource.runWhileLocked };

@id("workflow-enroll-durable")
@tier("t3")
@presence("true")
@channels("local")
permit (principal, action == Keylos::Action::"enroll", resource is Keylos::Workflow)
when { principal.kind == "shell" && resource.owner == principal.human && !principal.humanGuest
       && (resource.autoResume || resource.runWhileLocked) };

@id("workflow-resume")
permit (principal, action == Keylos::Action::"resume", resource is Keylos::Workflow)
when { principal.kind == "shell" && resource.owner == principal.human };

@id("workflow-cancel-owner")
permit (principal, action == Keylos::Action::"cancel", resource is Keylos::Workflow)
when { principal.kind == "shell" && (resource.owner == principal.human || principal.humanOwner) };

@id("no-guest-workflows")
forbid (principal, action == Keylos::Action::"enroll", resource is Keylos::Workflow)
when { principal.humanGuest };
```

Notes:
- `HOSTPATH_ALLOWLIST` is substituted by the policy compiler (`keylos-broker-policy::render_defaults`) with a set literal of `cluster.hostPathAllowlist` (empty by default, so every host path is forbidden).
- The `keylos-sealed` image rule (every image a `gen:` reference) cannot be written in Cedar (no string-prefix tests on set members). The broker evaluates it natively before Cedar, as a built-in forbid with id `pod-sealed-gens-only` that appears in `PodAdmission.reasons` like any other forbid (REQ-BROKER-121).
- Ownership for `debug` (owners only for other humans' targets and for scope `kernel`) is enforced natively by REQ-BROKER-131/132, because `Human.owner` is an attribute of the principal's parent entity and the rule is fixed.

### 10.4 Distribution routes

The distribution's default config grants the broker `right("service", "depot#user", "use")` (protocols §19.2 rule for unlisted holders), so it can call `Depot.get` for entity attributes. Without it, `Keylos::Generation` attributes are empty strings and policies using them do not match.

---

## 11. Testing and acceptance criteria

### 11.1 Unit tests

- Cedar entity construction for every resource kind; tier extraction with mixed annotations (REQ-BROKER-013); `@presence`, `@channels`, `@orgApproval` handling; floors never lowered.
- Biscuit mint, attenuate and verify with the §8 vocabulary; unknown facts rejected (REQ-BROKER-025).
- Rule-of-Two evaluator over every combination of label × holdings × request (exhaustive).
- Grant records: parsing, signature check, re-mint decisions, suspension logic, consent-backed T1 records.
- Mandate verification: draft equality, scope, expiry, channel list, signer class per channel; delivery re-signing keeps payload bytes identical (REQ-BROKER-111).
- `requestFor` subject rules per caller and idempotency table semantics (REQ-BROKER-104/105).
- `keylos.podspec/1` parsing and `PodSpec` entity construction; the built-in `pod-sealed-gens-only` rule; tier-floor derivation (REQ-BROKER-122).
- Debug duration caps and refusal matrix (REQ-BROKER-131/132); `offline_days` computation including the pre-trusted-time case.
- Per-method caller enforcement on `system` (REQ-BROKER-103).

### 11.2 Integration tests (in a `bench` VM running a keylos test image)

| ID | Scenario | Expected |
|---|---|---|
| IT-01 | App requests its own appdata path | Granted at T0; `grant.issue` receipt |
| IT-02 | App requests `~/Documents` without the powerbox | T2 prompt (mock atrium); token; `materialize` returns an fd; label `private/user` |
| IT-03 | Symlink escape: grant `~/proj`, symlink `~/proj/x → /etc/shadow`, materialize `x` | `kl:denied` |
| IT-04 | Directory attach; holder lists `/grants/<name>` | Works; `viewPath` returned; read-only flag enforced |
| IT-05 | Agent reads untrusted web content, then a private file, then requests POST to a non-sink-safe host | Third step → T3 declassification |
| IT-06 | IT-05 with a valid flow proof and a reversible effect | Accepted; `decidedBy: flowproof` |
| IT-07 | IT-05 with an irreversible effect and a flow proof | T3 prompt |
| IT-08 | Parent root with 10 USD delegates a 5 USD child; a second delegation of 6 USD | Second `carve` fails, delegation fails `kl:budget`; child charges of 5 succeed and reduce the parent's remaining to 5; a child charge of 0.01 more fails `kl:budget` |
| IT-09 | `revoke` of a parent root | Child roots revoked; agent child killed, app child frozen; grant mounts detached; T2 notification |
| IT-10 | Persistent powerbox grant | Presence required; record survives reboot; re-mint on app start; no prompt |
| IT-11 | Flip a byte in a grant record | Ignored at re-mint; `grant.deny{integrity}` |
| IT-12 | `loadPolicy` of a generation with a schema error | `kl:invalid`; previous policy active |
| IT-13 | Ledger stopped | Mutating ops `kl:unavailable`; `inspect` works; `raiseFor` buffered and receipted later |
| IT-14 | Broker killed and restarted | Revocations persist; live tokens verify (root key from `FdStore`) |
| IT-15 | Classifier times out | T1 becomes T2 |
| IT-16 | `requestFor` from gate for an email intent | Prompt names the subject; `GrantResult.mandate` binds the payload digest |
| IT-17 | Phone-channel mandate for a `@presence` permit | Rejected (REQ-BROKER-056) |
| IT-18 | `@orgApproval("finance")` permit on a fleet machine | `OrgDecider.decide` called; mandate signed by an `approver/<id>` key accepted |
| IT-19 | `BrokerSystem.loadPolicy` called by `aide` | `kl:denied` |
| IT-20 | Runtime directory grant to a tier-2 VM principal through `bench-relay` | `Handle.fd` is an `O_PATH` dirfd, `viewPath` empty, receipt `grant.issue{origin: vm-share}`; the same call from another process of the VM's cgroup fails `kl:denied` |
| IT-21 | `requestFor` from `aide` for its agent session | Approval created; prompt names the agent; delivered mandate re-signed by `service/broker` |
| IT-22 | `requestFor` from `strata` naming another principal's session | `kl:denied`, `grant.deny{reason: subject}` |
| IT-23 | `requestFor` repeated with the same idempotency key while pending, then after decision | Same `Approval` ID; one prompt; after decision the same `GrantResult` bytes; different request with same key → `kl:conflict` |
| IT-24 | Non-presence mandate delivered | Envelope has exactly one signature by `service/broker`; payload bytes equal the decided payload; `approval.decide.mandateDigest` = SHA-256 of the envelope |
| IT-25 | `registerApprover` from `vouch` with channel `local` | `kl:denied` |
| IT-26 | `@channels("local,phone")` permit, no `vouchd` key registered | `ApprovalPrompt.channels == ["local"]` |
| IT-27 | `admitPod` with `hostNetwork: true` | `allowed: false`, reasons contain `pod-no-host-namespaces`; p99 ≤ 5 ms |
| IT-28 | `admitPod` `keylos-sealed` with one `oci:` image | `allowed: false`, reason `pod-sealed-gens-only` |
| IT-29 | `admitPod` with a permit annotated `@tier("t2")` | Pending admission with approval ID; repeated call returns the same; after approval returns `allowed: true` |
| IT-30 | Owner shell requests `debug` on its own app session (scope process, 7 200 s) | T3 + presence prompt; token expires after 3 600 s; `Broker.debug` returns a `Process`; revoke kills the debugger |
| IT-31 | Agent requests `debug` on a session outside its tree | `kl:denied` |
| IT-32 | Guest human requests `persist: true` | `kl:denied` |
| IT-33 | Revocation list `issued` 31 days ago; agent connects to a new host that would be T1 | T2 prompt; `ctx.offlineDays == 31` |
| IT-34 | Quorum machine, persistent grant | `HearthQuorum.request` called; pending until 2 of 3 owners sign; envelope with 2 distinct owners accepted, 2 signatures of one owner rejected |
| IT-35 | `policy.ref` digest does not match the mounted policy generation | Broker exits 78 at startup; `loadPolicy` of such a generation fails `kl:integrity` |
| IT-36 | `@tier("t2") @orgApproval("finance")` permit on a BYOD fleet machine | Local prompt first; `OrgDecider.decide` only after local approval; mandate `channel: org`, `constraints.localDecision` set |
| IT-37 | Agent session flagged with model drift | A T1 request becomes T2 until re-approval; after re-approval tokens carry the new `model(...)` version |
| IT-38 | `requestFor` from `gate` with empty `intentSession` | `kl:invalid`; with `intentSession` = a session that never staged the intent → `kl:denied`, `grant.deny{reason: "subject"}` |
| IT-39 | `requestFor` from `vault` with `onBehalfOf = app:…@alice/s-…` | Prompt shows "On behalf of"; receipts carry `data.onBehalfOf`; the Cedar principal is vault's own session (verified via the `*.cedartest.json` trace) |
| IT-40 | `atrium` `requestFor` for a device authorization, then for a `net` resource | First: mandate delivered, empty token; `devd` accepts the mandate. Second: `kl:denied` |
| IT-48 | `atrium` device `requestFor` with `decidedOnTrustedPath = true`; then the same flag from `vault`; then from atrium for a device whose policy requires presence | First: no `TrustedPrompt.approve` call, `approval.decide{channel: local}` receipt, mandate returned. Second and third: `kl:invalid`, nothing recorded |
| IT-41 | Headless `server` profile, not fleet-enrolled, T2 request | `HearthQuorum.request` called; delivered mandate has `channel: "quorum"`, `decidedBy: "quorum"` |
| IT-42 | `admitPod` `keylos-sealed`, all images `gen:`, but `allImagesSealed: false` submitted | `kl:invalid` `allImagesSealed-mismatch`; with the true value → `allowed: true`, `tierFloor: 1` |
| IT-43 | Pod session registered with a matching `cluster-egress` rule | `myGrants` of the pod session returns one token with the rule's `net(...)` facts; no matching rule → no token |
| IT-44 | `mintCaptive` for a captive-browser VM session, then for a workbench session | First: token attached and visible in that session's `myGrants`, expires after 600 s; second: `kl:denied` |
| IT-45 | Agent requests `screen` on a window of its own human | T3 prompt; token expires in 120 s; first `inspect` by `portal-screen` succeeds, second returns `kl:revoked`; `materialize` → `kl:unsupported`. Window of another human → `kl:denied` |
| IT-46 | `model` re-approval request | T2 prompt; token carries `model(...)` with the new version and the session's root ID; the drift floor is cleared |
| IT-50 | Mandate draft for a path grant | effect kind `grant.path` (no `x-` prefix), `constraints.channels` present; the decided mandate validates with `keylos-formats`; a `constraints.x-channels` member is ignored for authorization |
| IT-51 | Directory with 30 000 entries (walk truncated) containing a `secret/untrusted` file beyond the walk; then a `secret` file renamed in after the grant | Session raised to the location default; both files `EACCES` through the grant mount (also via an fd opened before the rename's relabel); `grants raise-ceiling` makes them readable after a higher raise |
| IT-52 | Complete walk of a small directory with one `public/untrusted` file | Ceiling `private/untrusted`, nothing hidden; Rule of Two checked before exposure |
| IT-53 | Agent session requests a live home directory whose ceiling would be `secret` | Denied; the same content through an immutable bench share is granted with a complete assessment |
| IT-54 | `registerApprover` before the broker's key is registered; with a raw 32-byte key | `kl:unavailable`, then success; raw key `kl:invalid` |
| IT-55 | A requester-supplied rendering marked `decorative`; a decision approving a prompt whose required rendering is missing | Broker resets it to `required`; the decision is rejected with `kl:integrity` |
| IT-56 | Kill the broker after a persistent grant reports success; power-cut the VM | The grant record and its directory entry survive (`fsync` of file and `grants/`) |
| IT-57 | Unregistered `broker#principal` peer, production build vs development build with `KEYLOS_DEV_BROKER_IMPLICIT_SESSIONS=1` | `kl:denied`; implicit registration |
| IT-58 | Model re-approval for an agent session | New root with the new `model` fact; revoking the session's original root revokes it |
| IT-59 | `claim` with epoch = record epoch (a second loom, or a loom whose store was restored) | `kl:conflict`; record unchanged; the current attempt keeps its tokens |
| IT-60 | `claim` epoch n+1 while attempt n is running | Attempt n's roots revoked and its session killed within 50 ms; attempt n's `registerSession` retry fails `kl:conflict` |
| IT-61 | Kill the broker after the owner approves a durable decision, before the reply reaches `gate` | After restart `authorizeEffect` with the same effect returns the same `dr-…` approved with the same mandate bytes; no second prompt; `gate` consumes it once |
| IT-62 | Broker restart, then reboot, with a pending durable decision | Same `dr-…` after each; a new prompt with a new `a-…` each time; `expires` unchanged |
| IT-63 | `rebind` of an approved grant decision after its `expires` | `kl:expired`; no token; with a revoked enrollment scope item: `kl:denied` |
| IT-64 | `cancel` a workflow, restart the broker, then reboot; then `claim` and an attempt registration | Both fail `kl:revoked`; `grant.revoke{workflow}` written once |
| IT-65 | Restore a copy of `workflows/` taken before the cancellation, start the broker | Rollback check brings the record to `cancelled` from the `grant.revoke` receipt; claims refused |
| IT-66 | Attempt registration for a workflow whose label is `private/untrusted` | The session's first `label()` returns `private/untrusted` before any token is usable; the receipt order is label then `grant.issue` |
| IT-67 | Guest human's shell enrolls a workflow; an agent session enrolls one | Both `kl:denied`, `grant.deny{reason: "enroll-subject"}` |
| IT-68 | Enrollment with `resume = automatic` | T3 prompt with presence; without presence the decision is rejected; the delivered mandate carries `workflow.enroll` and `constraints.workflow` |
| IT-69 | Attempt registration whose generation differs from the claimed one, or whose parent is not the claimed spawner | `kl:conflict`; no session entry |
| IT-70 | `decide` twice with the same key and a different digest | Second call `kl:conflict` |
| IT-71 | Write failure (filesystem double returning `EIO` on `fsync`) during `claim` | `kl:unavailable`; epoch unchanged in memory and on disk |
| IT-72 | Policy changed after enrollment to forbid a scope host; next attempt registers | The host token is not minted; `grant.deny{workflow, reason: "policy"}`; other items minted |
| IT-47 | Ledger has no `broker` key at startup | Broker registers it; non-presence mandates pending until registration, then delivered; `Ledger.serviceKey("broker")` returns the unsealed key's SPKI |

### 11.3 Fuzzing

`cargo-fuzz` targets: `fuzz_grant_request`, `fuzz_biscuit_checks`, `fuzz_path_canonicalize`, `fuzz_grant_record`, `fuzz_mandate_verify`, `fuzz_flowproof`. Each runs 24 CPU-hours before release with no crashes.

### 11.4 Policy test format (`*.cedartest.json`)

```json
{"principal":{"kind":"agent","generationName":"io.keylos.agent.coder","depth":0,"label":{"conf":"private","integ":"untrusted"}},
 "action":"connect","resource":{"type":"Host","name":"api.github.com","port":443,"sinkSafe":false,"trusted":false},
 "context":{"persist":false,"durationSecs":1800},
 "expect":{"decision":"permit","tier":"t2","presence":false,"channels":["local"]}}
```

### 11.5 Conformance

The protocols `vectors/biscuit/`, `vectors/labels/`, `vectors/cedar/`, `vectors/dsse/`, `vectors/presence/` and `vectors/flowproof/` suites.

### 11.6 Acceptance criteria for 1.0

1. IT-01 … IT-72 pass on KL1 and KL3 kernels.
2. §8 budgets are met on the reference hardware named in the `keylos` distribution spec.
3. No `unsafe` outside the crates listed in §12.
4. The broker's root key never appears in a core dump (`PR_SET_DUMPABLE 0` verified).

---

## 12. Implementation notes

### 12.1 Crates

| Crate | Purpose |
|---|---|
| `biscuit-auth` 6.x | Tokens (via `keylos-biscuit`) |
| `cedar-policy` 4.x | Policy |
| `capnp` 0.20, `capnp-rpc` 0.20 (via `keylos-capwire`) | RPC |
| `tokio` 1.x | Runtime |
| `dashmap` 6, `arc-swap` 1, `roaring` 0.10 | State |
| `rustix` 0.38+ | `openat2`, `memfd_secret`, xattrs, `name_to_handle_at` |
| `tss-esapi` 7.x | Unseal of the `service/broker` key |
| `ed25519-dalek` 2.x, `p256` 0.13 | Signatures (via `keylos-formats`) |
| `keylos-presence` | Presence mandate verification |
| `tracing` 0.1 | Logs through the journal adapter |

`unsafe` is allowed only inside `rustix` and `keylos-capwire`; `brokerd` (library and binaries, including the `grants` CLI) is `#![forbid(unsafe_code)]`: inherited descriptors (fd 3, `KEYLOS_CAPWIRE_FDS`) are adopted with the `keylos-capwire` helper (protocols §10.5, E16). `FS_IOC_GETVERSION` may be replaced by the `statx` birth time (§4.3.2).

### 12.2 Repository layout

```
broker/
  Cargo.toml (workspace)
  crates/brokerd/                 main, modules per §4.1
  crates/grants-cli/              CLI
  crates/keylos-broker-policy/    entity builders, default policy, policy-test runner
  schema/grants-cli.capnp         repo-local (§5.3)
  policy/default/*.cedar
  tests/it/                       integration tests (bench VM harness)
  fuzz/
  generation/                     manifest templates for io.keylos.broker and io.keylos.grants; cmdsig/*.json
```

### 12.3 Build

- `forge` recipe `pkgs/system/broker.ncl`; reproducible; static musl.
- `cmdsig` files generated from `clap` definitions by `xtask cmdsig`.
- `xtask embed` re-copies the protocols excerpts of §2.2 from the pinned protocols version and fails CI on drift.

---

## 13. Decisions and alternatives

| Decision | Alternatives rejected | Rationale | ADR |
|---|---|---|---|
| Biscuit v3 tokens with per-boot root keys | Macaroons (verifiers need the secret); UCAN; OAuth tokens (online attenuation) | Offline attenuation, public-key verification, Datalog checks | [ADR-0005](../../handbook/11-decisions/adr-0005-biscuit-capability-tokens.md), [ADR-0040](../../handbook/11-decisions/adr-0040-per-boot-token-keys.md) |
| Cedar with tier, presence, channel and org annotations | OPA/Rego; ad-hoc rules | Analyzable, fast, schema-validated | [ADR-0006](../../handbook/11-decisions/adr-0006-cedar-policy.md) |
| Labels raised at materialization; directory ceilings; label authority for hand-off services | Per-read mediation (FUSE, fanotify permission events) | Conservative and cheap; exact flows belong to harness runtimes (flow proofs) | [ADR-0026](../../handbook/11-decisions/adr-0026-labels-and-rule-of-two.md) |
| Directory grants attached into the holder's namespace | Returning broker dirfds (blocked by Landlock hierarchy semantics) | Only mechanism compatible with Landlock deny-all | [ADR-0025](../../handbook/11-decisions/adr-0025-namespaces-only-by-warden.md) |
| Budgets delegated as hard sub-meters (`GateMeterAdmin.carve`) | Attenuating one shared meter (only the aggregate is hard); soft per-child caps in `aide` | Both the aggregate and each child's cap are hard; runaway sub-agents cannot drain siblings' budgets | [ADR-0028](../../handbook/11-decisions/adr-0028-approval-tiers.md) |
| Non-presence mandates re-signed by `service/broker` | Distributing approver keys to every relying service | Relying services verify only owner-presence keys and one broker key | [ADR-0027](../../handbook/11-decisions/adr-0027-effect-outbox-and-mandates.md) |
| Pod admission as Cedar `admit` plus native built-in forbids | A separate admission controller in `cri` | One policy engine, one receipt trail; mandatory forbids cannot be overridden | [ADR-0047](../../handbook/11-decisions/adr-0047-cri-microvm-pods.md) |
| Debug grants T3 + presence, time-boxed, owners only for others' sessions | No host debugging; a permanent debug group | Host debugging without a standing ptrace capability | [ADR-0049](../../handbook/11-decisions/adr-0049-debug-capability.md) |
| Quorum envelopes substitute presence on headless machines | Remote presence through a phone | Several humans must agree when no one can touch the machine | [ADR-0048](../../handbook/11-decisions/adr-0048-quorum-presence.md) |
| Revocation terminates or freezes holders | Revoking tokens only | fds cannot be recalled | [ADR-0041](../../handbook/11-decisions/adr-0041-revocation-kills-or-freezes.md) |
| Persistent approvals require presence | Plain click | Persistence outlives the session and must survive "reboot heals" analysis | [ADR-0011](../../handbook/11-decisions/adr-0011-owner-presence-fido2.md) |
| Classifier escalates only | Classifier auto-approves | No automated component may lower a tier | [ADR-0028](../../handbook/11-decisions/adr-0028-approval-tiers.md) |
| Workflow authority in broker records, attempts registered against a claimed epoch | Durable tokens; loom holding workflow tokens; reusing `requestFor` idempotency across reboots | Tokens stay per boot; loom stays outside the trusted core; a stale or restored coordinator is fenced by the broker | [ADR-0068](../../handbook/11-decisions/adr-0068-durable-workflows-loom.md) |
| Durable decisions keyed by (workflow, key) without sessions, prompts re-presented per boot | Persisting `a-…` approvals; extending the 24 h idem table | Decisions survive reboots without fabricating authority; prompt IDs stay boot-local; expiry is never extended | [ADR-0068](../../handbook/11-decisions/adr-0068-durable-workflows-loom.md) |

### 13.1 Open issues against protocols

None. Resolved in protocols Appendix E (S2): mandate-only effect kinds and `constraints.channels` (E2); GrantRequest digest form (E3); TPM fd and `KEYLOS_DEV_*` (E8); path-right resource text (E14); several `model` facts and model re-approval roots (E15); inherited-fd helper (E16); `registerApprover` encoding and `kl:unavailable` before key registration (E18); `Display.windowOwner` (E21); `classifier.capnp` (E22); `FlowCheck.intent` (E23); single source for org approver keys (E27); directory exposure labels (E31, ISS-004); single-file picks (E32, ISS-005); required renderings (E33, ISS-006). The quorum mandate channel, headless escalation, `intentSession` and `onBehalfOf` items raised earlier are resolved in protocols 1.0 (§14.3, §14.4, §7.5.2, §7.3.3).
