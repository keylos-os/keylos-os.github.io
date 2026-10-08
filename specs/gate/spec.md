# keylos/gate: the effect broker

| | |
|---|---|
| Repository | `github.com/keylos-os/gate` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | Service generation `io.keylos.gate` (processes `gate-core`, `gate-net`, `gate-tls`, `gate-render`); `gate-shim` (egress forwarder for tier-L views, a separate output of the same derivation); crate `keylos-gate-client` (Rust, with C ABI); CLI `gate`; repo-local schema `schema/gate-local.capnp` |
| Depends on | `keylos-protocols 1.0` (final) — crates `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-biscuit`, `keylos-labels`, `keylos-presence`; runtime services `warden`, `broker` (including `broker#workflow` for workflow effects), `vault`, `ledger`, `net`, `hearth` (owner registry), `strata` (`fs.merge` compensation), `bench` (merge executor), `depot` (revocation age), `fleet` (compliance assertions, fleet-enrolled machines only) |
| Provides | `Gate` (protocols §7.3.7); `ShimEndpoint`, `GateDebug`, `GateMeterAdmin` (protocols §7.5.12); `DurableEffects` and `WorkflowBudget` (protocols §7.5.25): durable effect records of workflows and workflow-lifetime budget accounts; the outbox of effect intents; metering, hard sub-meters and budgets; model-identity recording and drift escalation; credential injection; listening sockets for `listen:` grants; per-pod egress shims for `cluster.egressViaGate` |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`gate` is the **only path from a keylos principal to anything outside the machine**, other than `net`'s own link-level traffic (DHCP, upstream DNS, NTS, WireGuard handshakes). It does five things:

1. **Egress proxy.** It turns network capability tokens into connected sockets. It checks the destination host, port, protocol and (where needed) HTTP method. DNS for every principal goes through it.
2. **Effect broker.** Requests that change the outside world irreversibly or compensably are **staged** as intents in an outbox. They run only after policy and, when required, a signed approval mandate whose digest matches the exact payload.
3. **Metering.** It keeps budgets (money, model tokens, calls) keyed by token root ID, carves hard sub-meters for sub-agents (`GateMeterAdmin.carve`), and stops spending at the ceiling. Hard stops, not alerts. It records the model identity every provider reports and escalates a session whose model drifted (protocols §14.5).
4. **Credential injection.** Agents and tier-L/2/3 workloads never see raw credentials. `gate` adds `Authorization` headers, API keys, SSH signatures or fleet compliance assertions on the wire, using opaque handles from `vault`.
5. **Inbound listening.** It binds listening sockets for `listen:` grants. Opening a port reachable from non-loopback addresses is the compensable effect `net.listen` (protocols §14.2); after it commits, gate asks `net` to open the matching firewall hole.

It also applies the **offline rules** of protocols §14.5 to egress (new hosts need T2 after 30 days without a fresh revocation list) and serves the per-pod egress shims that `cri` uses when `cluster.egressViaGate` is set (protocols §21.5).

For **durable workflows** (protocols §20.25) gate is the effect side of the coordinator `loom`: it keeps a **durable effect record** per effect ID, owned by the workflow and independent of the attempt sessions that prepare or observe it, executes it according to the retry strategy its executor declares, reports `authorized` separately from the confirmed outcome, exposes unknown outcomes explicitly, and keeps the workflow's **budget account** across attempts and reboots (protocols §20.26, §7.5.25). gate never takes authority from loom: every workflow effect is authorized at commit time by `broker` (`BrokerWorkflow.authorizeEffect`).

`gate` enforces the **Rule of Two** (protocols §14.1) at the moment authority over external communication is exercised, by asking `broker` (`BrokerSystem.checkFlow`) before every non-sink-safe connect, every stage and every commit, and applies covert-channel limits to tainted sessions.

### 1.1 Non-goals

- Link management, routing, Wi-Fi, VPN tunnels, upstream DNS transport, the host firewall and time: these belong to `net`.
- Deciding policy and verifying flow proofs: `broker` evaluates Cedar, the Rule of Two and flow proofs, and issues tokens and mandates. `gate` verifies tokens and mandates and enforces what they say.
- Drawing prompts: `atrium` draws trusted-path prompts. `gate` produces the `RenderedEffect` content.
- The VM-side network stack: `bench-net` (bench repo) terminates the guest NIC and calls `ShimEndpoint`. `gate` sees each guest flow as one `ShimEndpoint` call.
- A general web cache, content filter or ad blocker.
- Inspecting TLS traffic that no grant requires inspecting. Interception is narrow and disclosed (§4.4).

---

## 2. Context and embedded contracts

### 2.1 Position in the system

```
 native principal (t0/t1)                 tier-L principal (netns, lo only)        tier-2/3 VM (bench)
   │ broker.materialize(net) ──► broker     │ plain TCP/UDP/DNS                       │ guest virtio-net
   │   └─ Gate.connect (facet broker)       ▼                                         ▼
   │ or Gate.connect (facet client)       gate-shim (in the view)                   bench-net (host, VM principal's cgroup)
   │                                        │ ShimEndpoint (facet shim)                │ ShimEndpoint (facet shim)
   ▼                                        ▼                                          ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ gate-core (t0, lo-only netns): tokens · checkFlow · labels · outbox · meter · mandates · receipts  │
 │ gate-net (t0, host netns): upstream sockets, splice relay, listeners                               │
 │ gate-tls (t0, per intercepting session): TLS termination, HTTP policy, injection, usage parsing    │
 │ gate-render (t0): WASI effect renderers (Wasmtime, Pulley interpreter, no JIT)                     │
 └──────────────────────────────────────────────────────────────────────────────────────────────────┘
   │ upstream (host netns, firewalled by UID)            │ capwire
   ▼                                                     ▼
 internet / LAN (when granted)            broker · vault · ledger · net · bench · fleet · warden
```

Only `gate-net`, `net` and UIDs `warden` publishes through `NetPlumbing` have sockets in the host network namespace that may leave the machine. `warden` gives every other principal one of:
- a network namespace containing only `lo` (tiers 0, 1, L), or
- a microVM whose single virtio-net device is terminated on the host by `bench-net` (tiers 2 and 3).

Two documented exceptions bypass gate, and gate knows about both:
- **Captive-portal VMs** admitted by `net` (`NetCaptive.admitSession`) reach TCP 80/443 and DNS on the captive link directly for at most 600 s (protocols §7.5.11). Any other traffic of that VM still goes through gate with a `captive(true)` token (§4.3.7).
- **Pods** (`server-k8s`, protocols §21.5) live in the `cri` network namespace. Pod-to-pod and in-cluster traffic never touches gate. Only with `cluster.egressViaGate = true` is pod egress to addresses outside the cluster CIDRs redirected to a per-pod gate shim (§4.3.8).

### 2.2 Routes

**Facets gate serves** (protocols §19.2, embedded in §2.3.17): `client`, `broker`, `shim`, `meter`, `aide`, `admin`, `debug`.

**Routes gate holds** (declared in the `io.keylos.gate` service manifest):

| Route | Used for |
|---|---|
| `warden#service` | `Supervisor.identify`, `connectionInfo`; `FdStore` (survive restarts with session CA keys and listener fds) |
| `broker#system` | `BrokerSystem.checkFlow`, `requestFor` (subjects: sessions that staged the intent, protocols §7.5.2); `Broker.inspect` |
| `broker#label-authority` | `LabelAuthority.labelOf`, `raiseFor` |
| `broker#workflow` | `BrokerWorkflow.authorizeEffect` (current authority and durable decisions for workflow effects), `verify` (current claim of a binding), `record` (horizon, owner, account, cancellation state) (protocols §7.5.25) |
| `vault#gate` | `inject`, `open("inject:…")`, `dataKey`/`forget` for `gate:` units |
| `ledger#writer` | `append` (receipts), `watch`/`query` (revocations, `approval.decide`, `txn.undo`, `key.enroll`/`key.remove`, gate's own receipts for rollback detection, §4.18; receipts of caller-executed completions, §4.16.5), `serviceKey("broker")` (the `service/broker` key, protocols §7.3.5). Returned receipts may carry a top-level `clear` member (protocols §13.4); gate strips it before any signature or digest check |
| `hearth#system` | `HearthSystem.owners` only (owner registry for presence-mandate verification) |
| `strata#gate` | `Strata.undo` (the `fs.undo` compensator of `fs.merge` intents) |
| `net#resolver` | `NetResolver.query`, `Net.resolve`, `NetWatch` (captive, time trust, status) |
| `net#plumbing` | `NetPlumbing.setListenPorts` (the `ports` form with per-port scope, protocols §7.5.11) |
| `bench#merge` | `BenchMerge.commitShare` (the `fs.merge` executor for ordinary intents), `commitPrepared` (the `fs.merge` executor for durable effects, by prepared-merge ID), `preparedStatus` (reconciliation), `render` |
| `depot#user` | `Depot.revocationStatus` (revocation age for the offline rules, §4.14); gate is a registered `depot#user` holder (protocols §19.2) |
| `fleet#gate` | `FleetCompliance.complianceToken` (only on fleet-enrolled machines) |
| `atrium#notify` | `TrustedPrompt.notify` (budget exhaustion, interception notices, model drift) |

### 2.3 Embedded contracts (verbatim from `keylos-protocols 1.0`)

#### 2.3.1 protocols §3.4 Principal identifiers

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

#### 2.3.2 protocols §3.5 Other identifiers

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

#### 2.3.3 protocols §3.6 Time

- On the wire: `Timestamp { unixNanos :Int64 }` in UTC.
- In documents: RFC 3339 with `Z` and at most nanosecond precision.
- The system clock MUST be disciplined by NTS-authenticated time (owned by the `net` repo).
- Components that check expiry (tokens, TUF, certificates) MUST treat the clock as **untrusted until the first NTS sync after boot**. Until then they use the **time floor**: the time of the newest ledger checkpoint (`LedgerAdmin.timeFloor`, §7.5.5). `net` steps the clock forward to the time floor at boot if the RTC is earlier. The RTC is never trusted to move time backwards past the floor.

#### 2.3.4 protocols §5.1 Envelope

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

#### 2.3.5 protocols §5.2 Trust roots

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

#### 2.3.6 protocols §5.3 Presence signatures

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

#### 2.3.7 protocols §7.1 Model

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

#### 2.3.8 protocols §7.2 Routes and facets

`warden` wires services according to **routes** declared in service and app manifests plus policy.

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

- A **facet** is a server-defined restriction name. The registry of every facet, its holders and the methods it allows is §19.2. Servers MUST refuse methods their facet doesn't allow with `kl:denied`.
- Route references are written `service#facet` (for example `vault#app`).
- The server learns the facet of each connection from `ServiceHost.accept` (§7.5.1) or `Supervisor.connectionInfo`.
- Service sockets live under `/run/keylos/svc/<service>/` with mode `0700`, owned by `warden`'s UID. No other principal can `connect()` to them. Connections are created by `warden` (`socketpair` + hand-off through `ServiceHost.accept`).
- Dynamic routes (a service capability granted at runtime) are materialised by `broker` through `ServiceConnect.connectService` (§7.5.1).

#### 2.3.9 protocols §7.2.1 capwire-vsock profile

Between a VM guest and the host, capwire runs over **`AF_VSOCK` `SOCK_SEQPACKET`** with these differences:
1. **No fd passing.** `Fd` fields MUST NOT appear in messages on this profile; receivers MUST reject them.
2. Bulk data uses `ByteStream`/`ByteSource` capabilities, or dedicated vsock stream connections on the bulk port range (§19.5) announced in messages.
3. **Authentication.** The host identifies the VM by its vsock CID, which `bench` assigns uniquely per running VM (CID ≥ 3). The guest is never trusted for identity claims; every host-side endpoint is bound to exactly one VM principal.
4. Ports are registered in §19.5. The guest initiates every connection to host CID 2.

#### 2.3.10 protocols §7.3.1 `common.capnp`

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

#### 2.3.11 protocols §7.3.3 `broker.capnp`

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

#### 2.3.12 protocols §7.3.4 `prompt.capnp`

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

#### 2.3.13 protocols §7.3.6 `vault.capnp`

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

#### 2.3.14 protocols §7.3.7 `gate.capnp` (implemented by this repo)

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

#### 2.3.13a protocols §7.3.5 `ledger.capnp` (`serviceKey`, read access)

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

#### 2.3.13b protocols §13.4 Receipt privacy (returned form with `clear`)

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

#### 2.3.14a protocols §7.3.8 `depot.capnp` (`revocationStatus`, revocation age)

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

#### 2.3.14b protocols §7.3.10 `strata.capnp` (`Strata.undo`)

```capnp
@0xc7a1e5d3b2f40010;
using C = import "common.capnp";

enum NetworkPolicy { deny @0; gate @1; inherit @2; }
  #! deny: processes in the transaction get no network; gate: egress only via gate with the caller's tokens; inherit: the spawner's own policy

struct Change { path @0 :Text; kind @1 :Kind; enum Kind { added @0; modified @1; deleted @2; renamed @3; meta @4; } from @2 :Text; }

struct Conflict { path @0 :Text; reason @1 :Text; }

interface Transaction {
  id      @0 () -> (id :Text);
  view    @1 () -> (dirs :List(C.Fd));         # O_PATH dirfds of the overlay views (same order as begin)
  changes @2 () -> (changes :List(Change));
  diff    @3 (path :Text) -> (diff :C.Fd);
  conflicts @4 () -> (conflicts :List(Conflict));
  commit  @5 () -> (snapshot :Text);           # returns pre-commit snapshot id (undo point)
  abort   @6 () -> ();
}

struct Provenance {
  principal   @0 :C.PrincipalId;
  generation  @1 :C.Ref;
  transaction @2 :Text;
  created     @3 :C.Timestamp;
  label       @4 :C.Label;
}

struct SnapshotInfo { id @0 :Text; subvolume @1 :Text; created @2 :C.Timestamp; reason @3 :Text; pinned @4 :Bool; }

interface Strata {
  begin     @0 (dirs :List(C.Fd), networkPolicy :NetworkPolicy) -> (txn :Transaction);   #! holding the dirfds is the authority
  snapshot  @1 (subvolume :Text, reason :Text) -> (info :SnapshotInfo);
  snapshots @2 (subvolume :Text) -> (list :List(SnapshotInfo));
  restore   @3 (snapshot :Text, path :Text, target :C.Fd) -> ();
  undo      @4 (transaction :Text) -> ();
  why       @5 (file :C.Fd) -> (provenance :Provenance);
  forget    @6 (unit :Text) -> ();             # crypto-shred a data unit
  createUnit @7 (path :C.Fd, unit :Text, policy :Text) -> ();
}
```

**Transaction storage backends.** `begin` dispatches each target dirfd to a registered backend. A plain btrfs directory uses the snapshot and overlay path. A plaintext view of a sealed unit served over FUSE (`keylos.unitfs/1`) is resolved through `strata`'s own mount records to (unit, relative subtree); `strata` clones the unit's ciphertext backing subvolume (a read-only base and a writable working clone) and serves a transaction-specific plaintext view of that subtree only. Changes and prepared merges are computed on the logical plaintext views; commit applies the logical operations to the live backing through the unit format, after quiescing the unit and fencing its writers. No plaintext upper layer, undo copy or journal content of a sealed unit is ever stored outside its encrypted backing; undo uses a ciphertext pre-commit snapshot, and `forget` of the unit aborts its transactions and leaves every transaction artifact undecryptable. While the unit is locked its transaction views are unavailable and commits fail `kl:unavailable`. Mixed backends in one transaction, nested units and cross-unit transactions fail `kl:unsupported`.

#### 2.3.15 protocols §7.5.2 `broker-sys.capnp`

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

#### 2.3.15a protocols §7.5.3 `hearth-sys.capnp` (`HearthSystem.owners`)

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

#### 2.3.15b protocols §7.5.7 `strata-sys.capnp` (facet `gate`)

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

#### 2.3.16 protocols §7.5.10 `bench-sys.capnp`

```capnp
@0xc7a1e5d3b2f40029;
using C = import "common.capnp";

interface BenchMerge {             # facet merge (gate fs.merge executor, aide for manifest/render)
  manifest    @0 (session :C.SessionId, share :Text) -> (manifestJson :Text, digest :C.Digest, snapshot :Text, prepared :Text);
      #! freezes a snapshot of the share's overlay and prepares the merge through strata (TransactionExt.prepare);
      #! manifestJson is that prepared merge's keylos.fsmerge/2 (§20.12), prepared its pm-… id
  render      @1 (session :C.SessionId, share :Text, snapshot :Text) -> (diff :C.Fd);   # unified diff
  commitShare @2 (session :C.SessionId, share :Text, manifestDigest :C.Digest, mandate :Data) -> (transaction :Text, undoSnapshot :Text);
      #! commits the prepared merge whose manifest digest is manifestDigest (PreparedMerge.commit); later agent writes are never included
  commitPrepared @3 (prepared :Text, manifestDigest :C.Digest, mandate :Data, binding :C.AttemptBinding) -> (transaction :Text, undoSnapshot :Text);
      #! gate only: commits a retained prepared merge by its pm-… id, independent of the session that prepared it (a fresh attempt
      #! of the owning workflow, §20.25; strata StrataTxn.preparedFor); idempotent: a committed prepared merge returns its
      #! stored completion record (PreparedMerge.status) instead of committing again
  preparedStatus @4 (prepared :Text) -> (state :Text, transaction :Text, undoSnapshot :Text);
      #! gate, aide: the prepared merge's durable completion record (PreparedMerge.status), for reconciliation by effect id
}

interface GrantDelegate {          # served by aide (facet grant-delegate), called by bench for agent VMs
  request @0 (vmSession :C.SessionId, kind :Text, detailJson :Text, reason :Text) -> (outcomeJson :Text);
      #! outcomeJson (JCS): {"outcome": "granted" | "denied" | "pending", "token": "<base64 Biscuit>" | null,
      #!                     "approval": "a-…" | null, "reason": "…"}
}

struct MediaEntry { name @0 :Text; kind @1 :Text; size @2 :UInt64; modified @3 :C.Timestamp; }   # kind: file | dir | symlink

interface MediaBrowser {           # returned by Bench.media; held by portal-files and atrium
  list   @0 (path :Text) -> (entries :List(MediaEntry));
  open   @1 (path :Text) -> (source :C.ByteSource, size :UInt64);    #! bytes are labelled public/untrusted
  export @2 (path :Text, data :C.Fd, mandate :Data) -> ();
      #! copies data into the media VM, which writes it to the device; requires a media.export mandate bound to the
      #! SHA-256 of data (caller-executed effect, §14.2); bench writes the receipt media.export
  eject  @3 () -> ();                 # unmount in the guest, release the device, stop the VM
  exportSeekable @4 (path :Text, sizeLimit :UInt64) -> (fd :C.Fd, done :ExportCompletion);
      #! a writable, seekable memfd for applications that must seek while saving; nothing reaches the device until
      #! done.finish with a media.export mandate bound to the SHA-256 of the final contents
}

interface ExportCompletion {
  finish @0 (mandate :Data) -> ();   # seals the memfd, verifies the mandate against its digest, writes it to the device
  abort  @1 () -> ();
}

interface GuestPortals {           # served by bench-relay to a tier-2 guest over capwire-vsock (port 7004)
  notify    @0 (title :Text, body :Text, actions :List(Text)) -> (id :UInt32);
  openUri   @1 (uri :Text) -> ();
  print     @2 (document :C.ByteSource, mime :Text, optionsJson :Text) -> (jobId :Text);
  capture   @3 () -> (stream :C.ByteSource);                  # this VM's own display only, never the host session
  secret    @4 (name :Text, purpose :Text) -> (value :Data);  #! vault facet app scoped to the VM principal; the value
                                                             #! crosses into the guest, so policy MUST allow it per item
  powerbox  @5 (kind :Text, title :Text, mimeTypes :List(Text)) -> (shareName :Text);
      #! host-side picker; the chosen file or directory is hot-plugged as a share (Vm.attachShare)
}
```

#### 2.3.17 protocols §7.5.11 `net-sys.capnp`

```capnp
@0xc7a1e5d3b2f4002a;
using C = import "common.capnp";

struct NetEvent {
  union {
    linkChanged      @0 :Text;      # JSON Link
    timeTrusted      @1 :Bool;
    captive          @2 :Bool;
    metered          @3 :Bool;
    vpnChanged       @4 :Text;      # JSON {profile, up}
    resolverInsecure @5 :Text;      # upstream id
  }
}

interface NetWatch {               # facets user, status, resolver, captive
  watch @0 (watcher :C.Watcher(NetEvent)) -> (cancel :C.Cancelable);
}

interface NetResolver {            # facet resolver (gate, tier-0 services)
  query @0 (wire :Data) -> (wire :Data, secure :Bool);   # RFC 1035 wire format, one question
}

struct ListenPort {
  port  @0 :UInt16;
  proto @1 :Proto;
  scope @2 :Scope;
  enum Proto { tcp @0; udp @1; }
  enum Scope { loopback @0; lan @1; any @2; }
}

interface NetPlumbing {            # facet plumbing
  setEgressUids    @0 (uids :List(UInt32)) -> ();                         # warden: UIDs allowed host-netns egress (gate, net helpers)
  setListenPorts   @1 (tcp :List(UInt16), udp :List(UInt16), ports :List(ListenPort)) -> ();
      #! gate: subset of config listenPorts; when ports is non-empty it supersedes tcp/udp (which then MUST be empty)
      #! and carries each port's scope (needs.listen scope, §6.3)
  setLocalLinkUids @2 (uids :List(UInt32)) -> ();                         # warden: UIDs allowed mDNS/IPP on local links (portal-print)
}

interface NetCaptive {             # facet captive (atrium)
  status @0 () -> (captive :Bool, ssid :Text, portalUrl :Text);
  admit  @1 (vmUid :UInt32) -> ();  #! superseded before release: MUST return kl:unsupported
  admitSession @2 (vmSession :C.SessionId) -> (expires :C.Timestamp);   #! superseded before release: MUST return kl:unsupported; use signIn
  portalUrl    @3 () -> (url :Text);  # the detected portal URL
  signIn       @4 () -> (expires :C.Timestamp);
      #! atrium ("Sign in to network"): net starts the captive VM itself through bench#net (purpose captive, image
      #! io.keylos.bench.captive-browser, display true, bootArgs captive.url), reads its session and cgroup with Vm.info,
      #! mints the captive token (BrokerSystem.mintCaptive), which the broker attaches to the VM session (bench-net reads it
      #! with Broker.myGrants), and allows that VM's bench-net direct egress on tcp/80, tcp/443 and udp+tcp/53 for at most
      #! 600 s while the network is captive. The window appears through atrium's Display like any tier-3 VM
  endSignIn    @5 () -> ();
      #! atrium (sign-in window closed): net stops the captive VM (Vm.stop) and revokes its direct egress immediately
}

interface NetPlumbingCluster {     # facet plumbing (clusterUplink: cri; clusterNetns: warden)
  clusterUplink @0 (configJson :Text) -> (netns :C.Fd);
      #! configJson is keylos.cri.uplink/1 (§21.5): op "uplink" configures the cri network namespace (pod CIDR routes,
      #! NAT, overlay) and returns it; op "podNetns" creates a pod network namespace attached to the cri bridge and
      #! returns it; op "release" deletes a pod namespace. cri holds CAP_NET_ADMIN only inside the cri namespace
  clusterNetns  @1 () -> (netns :C.Fd);
      #! warden: the cri network namespace, created by net at its own start on server-k8s from config cluster.*;
      #! warden starts services with services.json network "cluster" (crid, kubelet, kube-proxy) inside it
}

interface NetDiscovery {           # facet discovery (portal-discovery)
  browse  @0 (serviceType :Text, onLink :Text, watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);   # JSON ServiceInstance
  publish @1 (instance :Text, serviceType :Text, port :UInt16, txtJson :Text, forUid :UInt32) -> (handle :C.Cancelable);
}
```

#### 2.3.18 protocols §7.5.12 `gate-sys.capnp` (implemented by this repo)

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

#### 2.3.18a protocols §7.5.25 `loom-sys.capnp` (`DurableEffects`, `WorkflowBudget` implemented by this repo; `BrokerWorkflow` consumed)

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

#### 2.3.19 protocols §7.5.21 `fleet-sys.capnp`

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

#### 2.3.20 protocols §8 Capability tokens

**8.1 Format**

Tokens are **Biscuit v3** tokens:
- Ed25519 root key; the broker holds the root keys.
- Datalog blocks; attenuation is offline and append-only.

There is one root keypair per boot per machine, rotated at reboot. **Persistent grants** are stored by the broker as **grant records** (broker-local format `keylos.grant/1`) and re-minted on each boot. Tokens never outlive a boot.

**8.2 Authority block vocabulary**

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

**8.3 Attenuation checks**

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

**8.4 Revocation**

- Revoking a root ID invalidates every token derived from it, including tokens whose `budget_parent` names it. Revocations are in-memory and persisted until the next reboot, when keys rotate anyway.
- **Workflow revocation is durable.** Cancelling or revoking a workflow (`BrokerWorkflow.cancel`, §20.25) writes a persistent cancellation record in the broker, revokes every root carrying that workflow's `workflow` fact, and makes every later claim and attempt registration of the workflow fail, across restarts and reboots; it is not undone by the per-boot key rotation.
- The broker MUST check revocation on every `materialize`, and `gate` on every `connect`, `stage` and `charge`.
- **Already-materialized fds cannot be pulled back from a process.** Revoking therefore also terminates or freezes holders through `PrincipalControl.terminate` (§7.5.1), according to the grant record's `onRevoke`: `kill` (default for agents) or `freeze` (default for apps; the user decides). Attached grant mounts are detached (`GrantMounts.detachGrant`).

#### 2.3.21 protocols §9.4 Confinement report

`Process.confinement` returns JCS JSON:

```json
{"schema":"keylos.confinement/1","tier":"t1","featureLevel":"KL2","landlockAbi":9,
 "namespaces":["mnt","pid","ipc","uts","cgroup","net"],"userns":false,
 "seccompProfile":"baseline-1","compensations":["udp-via-netns"],"jit":false,
 "tlsInterception":{"active":false,"hosts":[]},"grants":["/grants/thesis"]}
```

`seccompProfile` is one of the profile names of §9.1: `baseline-1`, `baseline-1+<digest>` (tier `t0` only), `debug-1`, `debug-1k`, `openbroker-1` or `runtime-default`. A kernel below KL1 is not a supported platform (§2), so a truthful report from one does not validate.

`tlsInterception` is filled from `gate` (`GateDebug.interception`, §7.5.12): when `gate` intercepts TLS for the principal (method filtering or credential injection), `active` is true and `hosts` lists the intercepted hosts.

#### 2.3.21a protocols §9.5 Devices, removable media and DMA (`media.export`)

- **USB authorization.** `devd` sets `authorized_default=0` on every USB host controller. A newly attached device stays unauthorized (no driver binds) until approved on the trusted path and authorized through `DeviceAdmin.authorize` (§7.5.8). Approvals are stored per device identity (vendor, product, serial, port) when the human ticks "remember".
  - Input devices present during installation are pre-authorized.
  - A new device exposing a HID keyboard-like interface (`hidSafety: "keyboard-like"`) can only be approved using an **already-authorized** input device; its own keystrokes are discarded until then (BadUSB keystroke-injection defence).
  - Policy MAY auto-authorize device classes (`devices.autoAuthorize`, e.g. `["audio", "fido"]`); class `hid`, `net` and `mass-storage` are never auto-authorized by default.
  - **Before `devd` runs.** The kernel command line sets `usbcore.authorized_default=2` (only devices on internal, hard-wired ports are authorized). The initrd's authorizer (`boot`) additionally authorizes external hubs and devices whose interfaces are **all** HID, so external keyboards work for VBU, the PIN and the recovery prompt; it never authorizes storage, network or composite devices with a non-HID interface. In the initrd, keystrokes reach only those prompts (the TPM dictionary-attack lockout bounds PIN guessing). After `switch_root`, `devd` re-evaluates every authorized external device: a device that is neither remembered nor listed in `/var/lib/keylos/devd/preauthorized.json` is deauthorized and becomes pending. The remaining window is residual risk R15 of the distribution.
  - `/var/lib/keylos/devd/preauthorized.json` (written by the installer: the input devices present at installation; read by `devd`): `{"schema":"keylos.preauth/1","devices":[{"vendor":"046d","product":"c52b","serial":"…","port":"usb1-2","classes":["hid"]}]}` (vendor/product as 4 lowercase hex digits; `serial` empty when the device has none).
- **Thunderbolt / USB4 / external PCIe.** The IOMMU is required (§2). Domains and devices are authorized by `devd` only after trusted-path approval; without an IOMMU they are never authorized. Pre-boot DMA protection relies on firmware; the boot report records whether the firmware declared it.
- **Removable storage is never mounted by host filesystem drivers.** Authorizing a mass-storage, SD, optical or MTP device makes its block device (or MTP endpoint) available only through `MediaAttach.claimBlock` to a **media VM** (`VmSpec.purpose = media`, image `io.keylos.bench.media`), started by `Bench.media`. The VM mounts the filesystem and serves files through `MediaBrowser` (§7.5.10).
  - Bytes read through `MediaBrowser.open` are labelled `public/untrusted`; `portal-files` shows the device as the location "USB: <label>".
  - Writing to the device is the effect `media.export` (§14.2): data is copied into the media VM, which writes it.
  - Exception: a disk whose LUKS2 header carries the keylos backup token (`keylos-backup`) and verifies against the machine's backup key is unlocked and mounted on the host by `strata` for backups only.
- **Fingerprint readers** may unlock the screen lock only. They never satisfy presence and never unlock the disk.
- **VFIO passthrough** (`needs.gpu: "passthrough"`, pod VMs): only devices listed in config `devices.passthrough` are bound to `vfio-pci` through `MediaAttach.claimVfio`; the host driver is unbound for the VM's lifetime.

#### 2.3.22 protocols §10.5 Environment conventions

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

#### 2.3.22a protocols §10.7 Cross-repository files

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

#### 2.3.23 protocols §13.1 Receipt payload

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

#### 2.3.24 protocols §14 Labels, effects and approval tiers

**14.1 Labels**

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

**14.2 Effect kinds**

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

**14.3 Approval tiers**

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

**14.4 Mandates (`keylos.mandate/1`)**

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

**14.5 Operating rules**

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.

#### 2.3.25 protocols §19.2 Facets (rows for gate and the routes gate holds)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| warden | `service` | tier-0 services | `Supervisor.spawn`, `identify`, `connectionInfo`; `FdStore`. `SpawnSpec.attempt` only from `loom` |
| broker | `system` | warden, gate, aide, atrium, config, hearth, strata, net, depot, vault, vouch, cri | `BrokerSystem` (per-method callers as commented in §7.5.2; `requestFor` with the allowed-subject rule, atrium only for its own session (device authorization); `registerApprover`: atrium, vouch; `admitPod`: cri; `mintCaptive`: net); `Broker.inspect` |
| broker | `label-authority` | gate, bench, portal-*, atrium, strata, aide, journal, warden | `LabelAuthority` |
| broker | `workflow` | loom, gate, aide, strata, bench | `BrokerWorkflow` (§7.5.25): `enroll`, `claim`, `decide`, `rebind`, `resume`, `cancel`, `cancelDecision`, `record`, `raise`: loom; `authorizeEffect`, `verify`, `record`, `cancelDecision`: gate; `offer`, `verify`, `decide`, `rebind`: aide (its agent attempts); `verify`, `record`: strata, bench |
| ledger | `writer` | tier-0 services listed as writers in §19.3 | `Ledger` (all) |
| ledger | `reader` | every principal | `Ledger` except `append` (filtered, §7.3.5) |
| vault | `gate` | gate | `inject`, `open("inject:…")`, `dataKey`/`forget` for `gate:` units |
| hearth | `system` | warden, devd, config, broker, gate, vouch, strata, bench, depot, ledger, loom | `HearthSystem` (gate, vouch, strata, bench, depot, ledger: `owners` only; loom: `owners`, `userState`, `watchUsers`) |
| gate | `client` | principals with net needs, portal-files, atrium (staging `media.export`) | `connect`, `stage` (own session), `intents` (own session tree, recursive), `intent` (own session tree), `meter` (own roots); `DurableEffects.prepare`, `complete`, `lookup`, `watch` (attempt sessions, own workflow) |
| gate | `broker` | broker | `connect` and `stage` for the token holder; `GateMeterAdmin`; `WorkflowBudget.open`, `close`, `status` |
| gate | `shim` | per-principal endpoints created by warden (tier L) and bench (bench-net per VM) | `ShimEndpoint` |
| gate | `meter` | aide, configured model clients | `charge`, `meter` |
| gate | `aide` | aide | `connect`, `stage` for agent sessions (§7.3.7), `intents`, `meter`; `DurableEffects.prepare`, `complete`, `lookup`, `watch` and `WorkflowBudget.reserve`, `settle`, `release`, `status` for agent attempt sessions |
| gate | `admin` | owner `shell`, atrium | `intents`, `meter` (any session) |
| gate | `debug` | warden, atrium, owner `shell` | `GateDebug` |
| gate | `loom` | loom | `DurableEffects` (all except `prepare`), `WorkflowBudget` (`reserve`, `settle`, `release`, `status`) (§7.5.25) |
| net | `resolver` | gate, tier-0 services with network needs | `resolve`; `NetResolver`; `NetWatch` |
| net | `plumbing` | warden, gate, cri | `NetPlumbing` (`setEgressUids`, `setLocalLinkUids`: warden; `setListenPorts`: gate); `NetPlumbingCluster` (`clusterUplink`: cri; `clusterNetns`: warden) |
| depot | `user` | `shell`, atrium, aide, portal-openuri, portal-discovery, gate, any principal granted `depot#user` | `get`, `list`, `install`, `verify`, `revocations`, `revocationStatus`, `openObject` (closures the caller may spawn), `openPath` (`/.keylos/…` only) |
| strata | `gate` | gate | `Strata.undo` (fs.merge compensation only) |
| bench | `merge` | gate, aide | `BenchMerge` (`commitShare`, `commitPrepared`: gate only; `preparedStatus`: gate, aide) |
| atrium | `notify` | tier-0 services, portal-notify | `TrustedPrompt.notify` |
| fleet | `gate` | gate | `FleetCompliance.complianceToken` |

#### 2.3.26 protocols §19.3 Receipt events

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

#### 2.3.27 protocols §19.5 vsock ports

| Port | Direction | Service | Profile |
|---|---|---|---|
| 1024 | guest → host | `bench` (benchd control: `HostControl` / `Guest`) | capwire-vsock |
| 1025–1535 | either | `bench` bulk streams announced in control messages | raw byte streams |
| 7002 | guest → host | `aide` `AgentHost` (forwarded by `bench-relay` for agent VMs only) | capwire-vsock |
| 7004 | guest → host | `bench-relay` `GuestPortals` (tier-2 app VMs, agent desktops; never workbenches) | capwire-vsock |

All other guest network traffic leaves through the VM's single virtio-net device, terminated on the host by `bench-net`, which maps each flow to a `ShimEndpoint.connect` call on `gate` (§7.5.12).

#### 2.3.27a protocols §20.1 Boot trust set and boot report

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

#### 2.3.28 protocols §20.3 Owner registry

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

#### 2.3.29 protocols §20.10 Secret delivery

- **Primary:** a `memfd_secret(FD_CLOEXEC)` fd of the value's length plus 8, rounded up to the page size, laid out as `u64 little-endian length ‖ value ‖ zero padding`. secretmem fds are readable only through `mmap`; recipients map them `PROT_READ`, read the length, use the bytes, and zeroize and unmap on drop (`keylos-vault-client::SecretBuf`).
- **Fallback** (when `memfd_secret` is unavailable): a `memfd_create(MFD_CLOEXEC|MFD_ALLOW_SEALING|MFD_NOEXEC_SEAL)` fd with the same layout, sealed `F_SEAL_WRITE|F_SEAL_SHRINK|F_SEAL_GROW|F_SEAL_SEAL`. The receipt records `data.delivery = "memfd-sealed"`.

#### 2.3.30 protocols §20.11 Flow proof

DSSE, signed by the agent session key registered with `BrokerSystem.registerSessionKey`:

```json
{"schema":"keylos.flowproof/1","session":"s-…","intent":"e-…","payloadDigest":"sha256:…",
 "runtime":"gen:fsv256:<harness runtime generation>","policy":"camel/1",
 "controlSources":[{"source":"user","label":{"conf":"private","integ":"user"}}],
 "dataSources":[{"argument":"body","source":"file:/home/…","label":{"conf":"private","integ":"user"}}],
 "claims":["control-flow-independent-of-untrusted","recipients-from-user"]}
```

It is attached to a staged intent as the arg `x-flow-proof` (base64 DSSE) and passed by `gate` to `BrokerSystem.checkFlow`. The broker accepts it instead of a prompt only if: the template's `agent.flowProof` is `"camel/1"`; the runtime is listed in the policy's `flowproof-runtimes.json`; every `controlSources[].label.integ ≤ user`; and the payload digest matches.

#### 2.3.31 protocols §20.12 Merge manifest

```json
{"schema":"keylos.fsmerge/2","prepared":"pm-…","session":"s-…","share":"project",
 "targets":["/home/alice/src/proj"],"base":"snap-…","source":"snap-…",
 "changes":[{"target":0,"path":"src/main.rs","kind":"modified","expectedLive":"sha256:…","afterDigest":"sha256:…","mode":"0644","size":1834},
            {"target":0,"path":"README.md","kind":"added","expectedLive":"absent","afterDigest":"sha256:…","mode":"0644","size":210}]}
```

The manifest of a **prepared merge** (`TransactionExt.prepare`, §7.5.7), an immutable object that stores the exact result to be applied: conflicts are resolved and automatic three-way merges are done **before** the manifest exists. `BenchMerge.manifest` returns it for bench shares, and `strata` for every other merge. Its SHA-256 over the JCS is the payload digest of the `fs.merge` intent and is bound by the mandate; the rendered diff is derived from the same object.

- `share` is the bench share name or `null`; `targets` are the canonical live directories; `base` is the transaction's base snapshot, `source` the frozen snapshot of the working view the result was prepared from.
- `changes` is sorted by (`target`, `path` bytes) without duplicates. `kind` ∈ `added`, `modified`, `deleted`, `renamed` (with `from`), `meta`. `expectedLive` is the content digest the live path must still have at commit, or `"absent"` (required for `added`; every other kind needs a digest). `target` is the index of the change's entry in `targets`. `afterDigest` is `null` exactly for `deleted`; `mode` (4 octal digits) and `size` are required except for `deleted`.
- **Commit** (`PreparedMerge.commit`): the mandate's effect digest MUST equal the manifest digest; `strata` takes a writer fence (`PrincipalControl.fenceWriters`), checks every `expectedLive`, and applies exactly the stored operations. It never merges again and never reads the working view; a stale precondition fails `kl:conflict`, and a different result needs a new prepared merge and a new approval.

`keylos.fsmerge/1` (`{"schema":"keylos.fsmerge/1","session","share","base","snapshot","changes":[{path, kind, beforeDigest, afterDigest, mode, size}]}`) is superseded: it remains parseable, but no mandate is bound to it.

**Trust boundary.** `strata` holds the prepared object and enforces the commit rules above for every origin; `bench` maps its share manifests to the prepared object and calls its `commit`.

#### 2.3.32 protocols §20.15 Effect renderer components

Policies or apps that register an `x-…` effect kind MAY supply a renderer: a WASI 0.2 component that `gate` runs in Wasmtime with no imports beyond this WIT, fuel 50 million instructions, 64 MiB memory, no filesystem/network/clock, body ≤ 256 KiB, attachment ≤ 8 MiB.

```wit
package keylos:effects@1.0.0;

interface types {
  record arg { name: string, value: string, source: string, conf: u8, integ: u8 }
  record intent { kind: string, class: string, target: string, args: list<arg>, payload: list<u8> }
  record rendering { title: string, body: string, mime: string, attachment: option<list<u8>>, reversible: bool, warnings: list<string> }
  variant render-error { unsupported(string), invalid(string) }
}

world renderer {
  use types.{intent, rendering, render-error};
  export render: func(i: intent) -> result<rendering, render-error>;
}
```

#### 2.3.33 protocols §21.5 Cluster networking (pod egress)

- `net` creates the **cri network namespace** at its own start on `server-k8s` (veth uplink to the host, bridge `kl-cri0`), from config `cluster.*`. `warden` obtains it with `NetPlumbingCluster.clusterNetns` and starts `crid`, `kubelet` and `kube-proxy` in it. `cri` configures it dynamically with `clusterUplink` (the pod CIDR assigned through the Node object, NAT, overlay) and obtains per-pod network namespaces from `net` with op `podNetns`. This is the single exception to "only `warden` creates namespaces" (§9.1): network namespaces only.
- **`keylos.cri.uplink/1`** (JCS JSON passed to `clusterUplink`):
  - `{"schema":"keylos.cri.uplink/1","op":"uplink","podCidr":"10.244.3.0/24","clusterCidrs":["10.244.0.0/16"],"serviceCidr":"10.96.0.0/12","mtu":1450,"nat":true,"overlay":{"mode":"none" | "vxlan","vni":4242,"peers":[{"node":"…","ip":"…","podCidr":"…"}]}}` → returns the cri namespace;
  - `{"schema":"keylos.cri.uplink/1","op":"podNetns","podId":"pod-…","ip":"10.244.3.17","mac":"…","mtu":1450}` → returns a new pod namespace with a veth attached to `kl-cri0`;
  - `{"schema":"keylos.cri.uplink/1","op":"release","podId":"pod-…"}` → deletes it (returns no fd: `Fd.index` 0xFFFF).
- Pod VMs attach a **tap** device to a bridge inside the cri namespace. This is the only use of tap devices in keylos; workbench and tier-2 VMs never get one. Sealed pods get a veth pair into the same bridge.
- IPAM is host-local per pod CIDR; cross-node connectivity is direct routing or a VXLAN overlay configured by `cri`. Third-party CNI plugins are not supported; eBPF-based CNIs are not supported on the host.
- NetworkPolicy objects (watched by `cri` through the node's credential) are compiled to nftables in the cri namespace.
- With `cluster.egressViaGate = true`, pod egress to addresses outside the cluster CIDRs is redirected to a per-pod `gate` shim endpoint (`PodSpawn.egressShim`, §7.5.1; `keylos-vm` pods use their VM's `bench-net`) and is subject to gate policy. The broker attaches the pod principals' tokens at `registerSession` from policy `cluster.egress`.

#### 2.3.34 protocols §20.25 Durable execution

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

#### 2.3.35 protocols §20.26 Effect executor contract (implemented by this repo)

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

### 2.4 How gate applies the shared contracts

These rules are normative for gate and only restate how the embedded contracts combine; they add no cross-repo surface.

| Topic | Rule |
|---|---|
| Subject of a call | Facet `client`, `admin`, `debug`, `meter`: the caller (from `ServiceHost.accept`). Facet `broker`: the `principal` fact of the presented token, which MUST be a session registered with broker. Facet `aide`: the `principal` fact of the agent session token passed as `connect`'s `token`, or as the intent arg `x-subject-token` for `stage` (protocols §7.3.7). Facet `shim`: the peer principal of the endpoint connection (the tier-L principal, the VM principal for `bench-net`, or the pod principal for a pod shim). |
| Rule of Two | gate never computes the Rule of Two alone. It calls `BrokerSystem.checkFlow` with `kind = "net"` (connect) or the effect kind (stage, commit). `granted` → proceed; `pending` → `kl:needs-approval:<a-id>`; `denied` → `kl:denied`. |
| Approvals | For commits that need approval, gate calls `BrokerSystem.requestFor(subject, req, intent, idempotencyKey, intentSession)` with `req.resource.effect = <kind>`, `req.rights = [commit]`, `intent = <e-id>`, `idempotencyKey = "commit:" + <e-id>` and `intentSession` = the staging session when it differs from `subject` (the subject's ancestor that holds the grant), otherwise empty. broker deduplicates by `(gate, idempotencyKey)` for 24 h, so a restarted gate gets the same approval back. The mandate arrives in `GrantResult.mandate` or, for pending outcomes, from `Approval.mandate` after `Approval.wait`. |
| Mandate signatures | gate verifies only two kinds of signer (protocols §14.4): owner-presence credentials (owner registry from `HearthSystem.owners`) and the `service/broker` key. It never holds approver keys (§4.7). |
| Labels | gate reads labels with `LabelAuthority.labelOf` and raises them with `LabelAuthority.raiseFor` **before** the first response byte reaches the subject. |
| Terminated HTTP mode | Normative per protocols §7.3.7: a native subject gets a terminated socket exactly when the authorizing token's `net` fact has `$method ≠ "*"`. Injection rules for native subjects apply only to such method-filtered grants (§4.5), so the protocols detection rule is sufficient for clients. |
| Listening | `NetTarget.host = "listen:<addr>"` with `right("net", "listen:<addr>:<port>", "bind")` (protocols §7.3.3, §8.2). Loopback addresses bind directly. Any other address is the effect `net.listen` (compensable, protocols §14.2), committed before the socket is bound (§4.3.6). gate then calls `NetPlumbing.setListenPorts` with the full current set. |
| Captive networks | While `NetWatch` reports `captive = true`, gate admits only tokens carrying `captive(true)` (protocols §8.2) from subjects of effective tier ≥ 2; every other connect fails with `kl:unavailable`. |
| `fs.merge` compensation | gate executes the `fs.undo` compensator itself through `strata#gate` `Strata.undo(<transaction>)` (protocols §7.5.7). It also marks an intent `compensated` when the ledger shows a `txn.undo` for the intent's transaction performed directly by the human (§4.6.6). |
| Caller-executed effects | `media.export`, `device.actuate` and `config.propose` are executed by the staging principal, which holds the device-side or service capability (`MediaBrowser.export`, an app executor, `Config.propose`). gate's commit decides approval and returns the base64 delivered mandate in `IntentStatus.result`; the executor verifies it (§4.6.8, protocols §14.4). Stagers of `media.export` are `portal-files` and `atrium` (both `gate#client` holders, protocols §19.2). |
| Model drift | gate records the provider-reported model identity of every model response and compares it with the session token's `model(provider, model, version)` fact (protocols §8.2, §14.5). On a mismatch the session's T1 actions become T2 until the human re-approves (§4.13). `aide` emits `model.change`. |
| Offline operation | gate applies the revocation-age rules of protocols §14.5 to egress and supplies `offline_days(n)` as an ambient fact (§4.14). |
| Pod egress | With `cluster.egressViaGate = true`, `cri` spawns a pod shim per pod that holds a `gate#shim` endpoint bound to the pod principal (§4.3.8). |
| Interception disclosure | gate answers `GateDebug.interception(session)` (protocols §7.5.12) on facet `debug`; `warden` copies the result into the confinement report field `tlsInterception` (protocols §9.4). |
| Owner registry | gate never reads `/var/lib/keylos/hearth/owners.log` (protocols §10.7 lists only `boot` as a reader); it calls `HearthSystem.owners()` and replays the returned registry with `keylos-presence` (§4.7). |
| Durable effects | A workflow effect is a durable effect record keyed by its `fx-` ID and owned by its `wf-` workflow (protocols §20.26), never by a session. `prepare` comes from the attempt that holds the token (facets `client`, `aide`); `commit`, `cancel`, `reconcile`, `resolve` and `forget` come from `loom` (facet `loom`). Authority at commit is always `BrokerWorkflow.authorizeEffect`, evaluated when gate commits (§4.16). |
| Workflow budgets | A token with `budget_account(<ba>)` (protocols §8.2) is charged on its root meter **and** on the durable account `ba-…` (§4.17); fresh roots of later attempts never reset the account. |
| Version probe | Every bootstrap capability implements `common.Extensible`; `version()` returns `("1.0.0", "gate <semver>")`. |

### 2.5 Repo-local definitions

`schema/gate-local.capnp` (file ID `@0x9e4b2c7d1a35f601`, generated with `capnp id`, outside the protocols range) is used only by gate's own binaries and its CLI. No other repository may depend on it. The canonical `GateDebug` and `GateMeterAdmin` are protocols interfaces (§7.5.12); the local file adds only detail views.

```capnp
@0x9e4b2c7d1a35f601;
using C = import "/keylos/common.capnp";
using P = import "/keylos/prompt.capnp";

struct ConnInfo {
  id @0 :UInt64; subject @1 :C.PrincipalId; host @2 :Text; port @3 :UInt16; mode @4 :Text;
  bytesUp @5 :UInt64; bytesDown @6 :UInt64; opened @7 :C.Timestamp; intercepted @8 :Bool;
}

interface GateLocalDebug {                   # facet debug, via Extensible.ext (read-only)
  connections  @0 (session :C.SessionId) -> (list :List(ConnInfo));
  metrics      @1 () -> (openMetrics :Text);
  drift        @2 (session :C.SessionId) -> (json :Text);    # expected vs observed model identities (§4.13)
  offline      @3 () -> (json :Text);                        # revocation age and active offline rules (§4.14)
}

interface GateAdmin {                        # facet admin, via Extensible.ext
  intentDetail     @0 (id :Text) -> (json :Text, rendered :List(P.RenderedEffect));
  setLimitOverride @1 (session :C.SessionId, json :Text, mandate :Data) -> ();   # T3 mandate required
  flush            @2 () -> ();                                                   # retention sweep now
  kinds            @3 () -> (json :Text);                                         # effective effect-kind registry
  meterTree        @4 (rootId :Data) -> (json :Text);                             # sub-meter tree (§4.12)
}
```

`GateDebug` (protocols) is the bootstrap interface of facet `debug`; `GateLocalDebug` and `GateAdmin` are obtained through `Extensible.ext(interfaceId)` on the `debug` and `admin` bootstrap capabilities. `GateMeterAdmin` (protocols) is obtained through `Extensible.ext` on the `broker` bootstrap capability.

---

## 3. Requirements

### 3.1 Egress

- **REQ-GATE-001** gate MUST be the only principal, other than `net` and UIDs published by `warden` through `NetPlumbing`, that holds `AF_INET`/`AF_INET6` sockets in the host network namespace and connects to non-loopback addresses. `gate-net` is the only gate process with host-netns sockets.
- **REQ-GATE-002** `Gate.connect` and `ShimEndpoint.connect` MUST verify the token signature against the current boot's broker root public key (obtained once per boot with `Broker.inspect` on a broker-minted token and cached), check revocation (§4.10), check expiry against trusted time (§4.3.3 step 3), and evaluate the token's checks with the ambient facts of protocols §8.3 before opening any upstream socket.
- **REQ-GATE-003** For `proto = tcp`, gate MUST connect to the resolved address and return the client end of a connected `AF_UNIX SOCK_STREAM` socketpair, relaying bytes (§4.3.4).
- **REQ-GATE-004** For `proto = https` on a relayed connection, gate MUST check that the TLS ClientHello SNI equals the granted host (case-insensitive, IDNA A-label). It MUST refuse ECH outer names that do not match a grant, and connections without SNI unless the grant is for an IP literal.
- **REQ-GATE-005** When a grant restricts HTTP methods, or a credential-injection rule applies to the host and subject, gate MUST enforce HTTP policy per request:
  - for **shimmed** subjects (tier L, VMs, pods), by terminating TLS with a per-session interception certificate (§4.4);
  - for **native** subjects (tiers 0/1), by returning a **terminated** socket on which the client speaks plaintext HTTP/1.1 or HTTP/2 (prior knowledge) and gate originates TLS upstream (§4.3.4). This is the normative terminated HTTP mode of protocols §7.3.7: gate MUST use it **exactly** when the authorizing token's `net` fact has `$method ≠ "*"`. An injection rule applies to a native subject only through such a method-filtered grant (§4.5); a native subject presenting a `"*"` grant for a host with an injection rule gets a relayed connection without injection.

  Otherwise gate MUST NOT terminate or originate TLS on the subject's behalf.
- **REQ-GATE-006** gate MUST resolve DNS names only through `net` (`NetResolver.query`). Subjects MUST NOT get raw DNS. `ShimEndpoint.resolve` MUST answer only names that appear in a `net(...)` fact of a token the subject presented, or match a wildcard grant under §4.8 rules. All other names get `REFUSED`.
- **REQ-GATE-007** UDP egress MUST be allowed only for grants with `proto = udp`, via `ShimEndpoint.udpAssociate` (shimmed) or a connected `SOCK_DGRAM` pair from `Gate.connect` (native). UDP 443 to hosts granted as `https` MUST be refused, which forces HTTP/1.1 or HTTP/2 over TCP.
- **REQ-GATE-008** Listening sockets (`listen:` targets) MUST require `right("net", "listen:<addr>:<port>", "bind")`, a port in net's configured `listenPorts`, and MUST be bound with `SO_REUSEADDR` only, never `SO_REUSEPORT`. A non-loopback address (scope `lan` or `any`) MUST first pass the effect `net.listen` (compensable, T2 by default policy) through the outbox (§4.3.6); loopback addresses bind directly.
- **REQ-GATE-009** Every upstream connection MUST be attributed to exactly one subject session and one token root ID. gate MUST keep a connection table that revocation handling can enumerate.
- **REQ-GATE-010** A `ShimEndpoint` connection is bound to exactly one principal (protocols §7.2.1 point 3 for VMs). gate MUST reject tokens on it whose `principal` fact is not that principal or one of its descendant sessions.
- **REQ-GATE-011** Pod shims (§4.3.8) MUST identify the destination of every flow by TLS SNI (port 443 and any TLS ClientHello) or HTTP `Host` (cleartext HTTP); a flow whose destination is neither identifiable by name nor granted as an IP literal MUST be refused. Pod principals use only tokens broker attached to their sessions at `registerSession`.
- **REQ-GATE-012** When the revocation age exceeds `offline.thresholdDays` (default 30, protocols §14.5), a connect by an **agent** principal to a host its agent template has not contacted before MUST require a T2 approval (`requestFor`, resource `net`), and gate MUST supply the ambient fact `offline_days(n)` to every token authorization (§4.14).

### 3.2 Rule of Two and labels

- **REQ-GATE-020** Before egress to a host not marked `sink-safe`, before `stage`, and before `commit`, gate MUST call `BrokerSystem.checkFlow` for the subject session and act on the result (§2.4). A flow proof present as intent arg `x-flow-proof` MUST be passed in `FlowCheck.flowProof`.
- **REQ-GATE-021** Data received from a host MUST raise the receiving session's integrity label to `untrusted`, unless the host is marked `trusted` or `user` in policy. gate MUST call `LabelAuthority.raiseFor` and wait for its completion **before** delivering the first response byte.
- **REQ-GATE-022** For sessions with U ∧ P, gate MUST apply covert-channel limits (§4.8) to all traffic, including traffic to `sink-safe` hosts.

### 3.3 Effects and outbox

- **REQ-GATE-030** `Gate.stage` MUST validate the intent:
  - the kind is registered (protocols §14.2 or policy `x-` kinds);
  - the class is ≥ the registered class (raising allowed, lowering rejected with `kl:invalid`);
  - the subject holds `right("effect", "<kind>", "stage")`;
  - the payload fd is a regular file or memfd of ≤ 64 MiB.

  It MUST copy the payload into the outbox store, compute SHA-256 over it, and persist the intent before returning.
- **REQ-GATE-031** The outbox MUST be durable: an intent acknowledged by `stage` MUST survive a crash or power loss (fsync on the redb commit and on the blob).
- **REQ-GATE-032** `Intent.commit` MUST:
  1. check the subject holds `right("effect", "<kind>", "commit")`, or obtain approval through `requestFor` with `idempotencyKey = "commit:<e-id>"`;
  2. call `checkFlow`;
  3. for `reversible` intents within policy, execute;
  4. for `compensable` intents, require a registered compensator or an approved mandate, then execute;
  5. for `irreversible` intents, require a valid mandate (§4.7) whose `effects[].digest` equals the payload digest, whose `scope` permits this use and whose constraints hold, then execute exactly once.
- **REQ-GATE-033** Execution MUST be idempotent per `(subject, idempotencyKey)`: a second commit of an intent with the same key returns the first result.
- **REQ-GATE-034** On intercepted and terminated connections, gate MUST convert unsafe HTTP requests (POST, PUT, PATCH, DELETE) into **implicit intents** when the subject holds `stage` but not `commit` for the matching effect kind, and respond `428 Precondition Required` with header `Keylos-Intent: <e-id>` (§4.6.2).
- **REQ-GATE-035** `Intent.compensate` MUST be available only for committed intents of class `compensable` with a compensator. It MUST run the compensator once and record `effect.compensate`. For `fs.merge` the compensator is `Strata.undo(<transaction>)` on `strata#gate` (§4.6.6); for `net.listen` it is closing the port (§4.3.6); for caller-executed kinds gate returns `kl:unsupported` with the hint that the staging principal compensates (§4.6.8).
- **REQ-GATE-036** Every state transition of an intent MUST produce exactly one receipt with the event names of protocols §19.3.
- **REQ-GATE-037** Effect kinds registered with a renderer component (protocols §20.15) MUST be rendered by `gate-render` within the limits of §20.15; a renderer error or limit breach MUST fall back to gate's built-in **canonical-text renderer** (§4.6.7) with a warning line. The fallback counts as review material only if it presents every required review detail of the kind (REQ-GATE-046); otherwise the intent's rendering is incomplete and no approval can be obtained for it (it stays `AwaitingApproval` until it expires or is canceled).
- **REQ-GATE-038** `Gate.intent(id)` on facet `client` MUST return the `Intent` capability only when the intent was staged by the caller's session or one of its descendant sessions (the caller's session is a prefix of the intent subject's session chain); otherwise it MUST fail with `kl:not-found` (never `kl:denied`, so intent IDs of other trees are not confirmed).
- **REQ-GATE-039** For caller-executed kinds (`media.export`, `device.actuate`, `config.propose`; §4.6.8), a successful commit MUST move the intent to `Committed` with `IntentStatus.result` set to exactly the base64 encoding of the delivered mandate envelope (protocols §14.4) and MUST NOT perform any external action itself. The `effect.commit` receipt is written at that point with `data.executor = "caller"` (meaning "authorized"); the executor records its own completion receipt (`media.export` by bench).

- **REQ-GATE-046** **Required review details** (protocols §14.2, §14.3, E33). For every intent gate MUST produce renderings that present every required review detail of its kind (§4.6.7 table) completely, each as a `RenderedEffect` with `review = required` and `payloadDigest` = the intent payload digest (the mandate draft effect digest). Only gate marks a rendering `decorative` (previews, thumbnails, syntax-highlighted extras); requesters, stagers, intent args and renderer components can never make a required detail optional. A renderer component's output is accepted as required material only when it carries every required field of the kind's detail list; otherwise gate adds the canonical-text rendering as the required one.
- **REQ-GATE-047** gate MUST NOT commit an intent whose mandate was decided on renderings other than the ones gate produced for that payload digest: the `payloadDigest` of each required rendering, the mandate's effect digest and the stored payload's digest MUST be equal (§4.7 step 4).

### 3.4 Metering and budgets

- **REQ-GATE-040** gate MUST keep a meter account per token root ID and enforce every `budget(unit, amount)` fact on the presented token. A token carrying `budget_parent(<rootId>)` is a **hard sub-meter** (§4.12): every charge to it is also charged to the parent account and recursively to every ancestor. A charge that would exceed any ceiling on the path MUST fail with `kl:budget` before the spending action starts (pre-authorization), except as allowed by REQ-GATE-042.
- **REQ-GATE-041** For model-provider hosts listed in config (§10), gate MUST meter by parsing usage from responses (§4.9). It MUST pre-authorize the maximum possible cost of each request and MUST terminate a streaming response when the account reaches its ceiling.
- **REQ-GATE-042** Overrun MUST be at most one in-flight response's actual cost minus its pre-authorized estimate. On overrun, gate MUST record `budget.exhausted` and refuse further spending on that account until a T3 budget-overrun approval raises the ceiling.
- **REQ-GATE-043** `Gate.charge` MUST be accepted only on facets `meter` and `aide`.
- **REQ-GATE-044** `GateMeterAdmin` MUST be served only on facet `broker`. `carve(parentRoot, childRoot, budget)` MUST be refused with `kl:budget` when, for any unit, the sum of the ceilings of the parent's live children plus the requested ceiling exceeds the parent's remaining amount; it MUST write `budget.carve`. `release(childRoot)` MUST return the child's unspent ceiling to the parent's carve-able remainder and MUST be idempotent.
- **REQ-GATE-045** For every model-provider response gate MUST extract the provider-reported model identity (§4.13) and record it in the `budget.charge` receipt. When the observed `(model, version)` differs from the session token's `model(...)` fact, or from the identity the human last re-approved for the session, gate MUST treat every T1 action of the session (connects and reversible commits) as T2 until a `model.change` approval for that session is granted.

### 3.5 Credential injection

- **REQ-GATE-050** Credentials for agent sessions and tier-L/2/3 principals MUST be injected by gate, never delivered to the principal. Injection rules (§4.5) bind a vault item to host, path prefix, method and header template.
- **REQ-GATE-051** gate MUST obtain credentials only through `vault.inject(name, target)` handles redeemed with `vault.open("inject:<hex>", purpose)` on facet `gate`. Secret bytes MUST be handled only in the mmap of the delivered fd (protocols §20.10) and zeroized after use.
- **REQ-GATE-052** Headers named by a rule's `stripClientHeaders` MUST be removed. A subject-supplied `Authorization` header to a host with an applicable rule MUST be rejected (`403`, `kl:denied`).
- **REQ-GATE-053** gate MUST provide an SSH signing agent per shimmed subject (`ShimEndpoint.sshAgent`). `SIGN_REQUEST`s are forwarded to `vault.sign` after checking that the session holds `right("secret", "<item>", "use")` and that the destination host matches the item's host binding (§4.5).

### 3.6 Receipts and observability

- **REQ-GATE-060** `net.connect` receipts MUST be written for every connection of an agent principal. For other principals they are sampled at 1 in 100, plus every connection to a host first used in the session.
- **REQ-GATE-061** Receipt `data` MUST NOT contain credential values, interception keys or payload bodies. It contains payload digests and rendered summaries ≤ 4 KiB.
- **REQ-GATE-062** Every listening socket bound MUST produce a `net.listen` receipt; closing it produces none. Non-loopback listens additionally produce the `effect.stage`/`effect.commit` receipts of their `net.listen` intent.
- **REQ-GATE-063** Every `GateMeterAdmin.carve` MUST produce a `budget.carve` receipt `{parentRoot, childRoot, budget}`.

### 3.7 Service keys, listen scopes, session trees and resources

- **REQ-GATE-064** gate MUST obtain the `service/broker` public key only through `Ledger.serviceKey("broker")` (protocols §7.3.5) and MUST re-query it whenever a `ledger.key.register` receipt for `broker` is observed. It MUST NOT read service keys from the boot trust set or from receipt bodies.
- **REQ-GATE-065** gate MUST call `NetPlumbing.setListenPorts` only in the `ports` form (empty `tcp`/`udp` lists), with one `ListenPort` per bound non-loopback socket and its scope taken from the subject's `needs.listen` entry (`lan` or `any`); loopback binds are never reported to net.
- **REQ-GATE-066** `Gate.intents(session)` on facet `client` MUST return the intents of `session` and of every descendant session, recursively, and only when `session` is the caller's own session or one of its descendants; any other session yields an empty list.
- **REQ-GATE-067** A model-drift re-approval MUST be requested with `ResourceRef.model = "<provider>/<model>@<version>"` and `Right.use` (protocols §7.3.3); gate MUST NOT use an `effect` resource for it. gate never requests or materializes `ResourceRef.screen` grants (they are atrium's, protocols §14.5) and MUST reject a `connect` or `stage` whose token is authorized only by `screen` or `model` rights.
- **REQ-GATE-068** gate MUST accept mandates with `channel = "quorum"` only when they are presence-signed by at least `policy.threshold` distinct owners of the current owner registry (protocols §5.4, §14.4).
- **REQ-GATE-069** Every `requestFor` call MUST pass a non-empty `idempotencyKey` and MUST set `intentSession` to the staging session whenever the approval subject differs from it.
- **REQ-GATE-070** gate MUST derive the revocation age only from `Depot.revocationStatus().ageSecs`; when depot is unreachable it MUST keep the last value and fail closed per §4.14.

### 3.8 Durable effects (protocols §20.26)

- **REQ-GATE-071** gate MUST serve `DurableEffects` (protocols §7.5.25) through `Extensible.ext` on facets `client` and `aide` (`prepare`, `complete`, `lookup`, `watch`, for the caller's own workflow only) and as an interface of facet `loom` (every method except `prepare` and `complete`). A peer that does not implement the interface gets no durable semantics: gate MUST NOT emulate `DurableEffects` through `Gate.stage` or `Intent.commit`, and ordinary intents never carry workflow authority.
- **REQ-GATE-072** A durable effect record MUST be keyed by its effect ID and owned by the workflow named in the binding; no method may look it up, cancel or commit it by session. `prepare` MUST verify that the token's `principal` is the caller's subject (as for `stage`, §2.4), that the token's `workflow($wf, $epoch)` fact equals the binding's workflow and epoch, that the binding is the workflow's current claim (§4.16.1), that the subject holds `right("effect", <kind>, "stage")`, and the `stage` checks of REQ-GATE-030, then persist the record, its outbox intent and the encrypted payload in one redb transaction (fsync, blob `fsync` and directory `fsync`) before returning.
- **REQ-GATE-073** gate MUST compute `requestDigest` exactly as protocols §20.26. A `prepare` whose effect ID exists with an equal request digest MUST return the existing record unchanged; with a different digest it MUST fail `kl:conflict` and change nothing.
- **REQ-GATE-074** gate MUST record the executor's declared retry strategy (§4.6.1) in the record at `prepare` and MUST NOT change it afterwards. A kind or destination without a valid declaration is `noSafeRetry`; `downstreamIdempotency` MUST be used only for destinations configured `verified` with a window (§10).
- **REQ-GATE-075** `commit` (facet `loom`) MUST verify the binding is the current claim, then obtain authority with `BrokerWorkflow.authorizeEffect(binding, effect, kind, target, payloadDigest, rendered)` with gate's required renderings (REQ-GATE-046). An approved decision with a mandate MUST be verified as §4.7 plus `constraints.workflow` = the record's workflow and `constraints.decision` = the decision ID. gate MUST commit the transition to `authorized`, the mandate's consumption (`decisions_used`, `mandates_used`) and the epoch in one redb transaction before dispatching; a decision or mandate already consumed for another effect ID MUST be refused `kl:denied`.
- **REQ-GATE-076** gate MUST write `effect.commit` (meaning "authorized") before dispatch, and MUST report completion only as `succeeded` or `failed` with receipt `effect.complete`, or as `outcomeUnknown` with receipt `effect.unknown`. `authorized` and `dispatching` MUST never be presented as completion through `EffectRecord`, `IntentStatus` or receipts.
- **REQ-GATE-077** After a crash, a lost reply or an executor error in `dispatching`, gate MUST continue exactly as the record's strategy permits (protocols §20.26 table, §4.16.4): `transactional` → completion-record lookup; `downstreamIdempotency` → re-send with the same key only while now < `dedupUntil`; `reconciliation` → the registered reconciler; `noSafeRetry` → `outcomeUnknown`. gate MUST NOT re-dispatch a record in `outcomeUnknown`, and MUST NOT treat absence in an eventually consistent view as non-execution.
- **REQ-GATE-078** For caller-executed kinds, a durable effect MUST stop at `authorized` with the delivered mandate; `complete(effect, receipt)` MUST fetch the receipt from the ledger, verify it (protocols §13.1), require that its writer is the kind's registered executor and that its data names the effect ID and the payload digest, and only then record `succeeded` or `failed`.
- **REQ-GATE-079** `lookup` and `watch` MUST answer from the durable record (never from memory only). `cancel` MUST move `prepared` and `awaitingApproval` records to `cancelled` (and ask the broker to cancel the pending decision by cancelling the commit) and MUST return records in `authorized` or later unchanged. `resolve` MUST accept only `outcomeUnknown` records, only from facet `loom`, with a `workflow.decide` mandate bound to the record (presence for irreversible kinds), and MUST record `succeeded` or `failed` without dispatching.
- **REQ-GATE-080** Fencing: every `DurableEffects` call that names a binding MUST be refused `kl:conflict` when the binding's epoch is lower than the highest epoch gate has seen for that workflow, or when `BrokerWorkflow.verify` reports it stale; gate MUST cache `verify` results for at most 1 s and drop them on every `grant.revoke` receipt naming the workflow (§4.16.1).
- **REQ-GATE-081** Dedup retention: a durable effect record MUST be kept at least until the latest of the workflow's horizon (from `BrokerWorkflow.record`), `dedupUntil` and 30 days after it became terminal; a non-terminal record MUST never be deleted. The 30/7-day rule of §4.6.5 applies to payloads of ordinary intents only; payloads of durable effects are kept until terminal + 7 days or until `forget`.
- **REQ-GATE-082** Payloads of durable effects MUST be encrypted under the unit `gate:<owner>:<wf-…>` (`vault.dataKey` on facet `gate`). `forget(workflow)` (facet `loom`) MUST cancel the workflow's `prepared`/`awaitingApproval` records, `vault.forget` that unit, delete its blobs and keep only the minimal record (effect ID, workflow, digests, strategy, state, outcome summary, receipts, `dedupUntil`, `retainUntil`).
- **REQ-GATE-083** gate's effect records and workflow budget accounts MUST be anchored against gate's own receipts as protocols §20.25 "Rollback detection" describes (§4.18): on detection gate MUST stop dispatching durable effects, keep answering `lookup` from the reconciled state, and resume only after the owner's acceptance.

### 3.9 Workflow budget accounts

- **REQ-GATE-084** gate MUST serve `WorkflowBudget` (protocols §7.5.25): `open`, `close`, `status` on facet `broker`; `reserve`, `settle`, `release`, `status` on facets `loom` and `aide` (aide: accounts of its agent attempts only). Accounts MUST be durable (`meter.redb`, table `accounts`, fsync per transaction) and independent of token roots and boots.
- **REQ-GATE-085** `open` MUST be idempotent (same account and ceilings: no change; other ceilings: `kl:conflict`). `reserve` MUST be idempotent per `(account, key)` and MUST fail `kl:budget` when `spent + reserved + unresolved + amount` exceeds a ceiling of any unit. `settle` MUST be applied at most once per key with a final amount: a repeat with equal values returns the entry, a repeat with other values fails `kl:conflict`; outcome `unknown` keeps the amount as `unresolved`, which may be settled once more when the actual charge is known. `release` MUST be idempotent.
- **REQ-GATE-086** Every charge made under a token carrying `budget_account(<ba>)` MUST also be applied to that account in the same redb transaction as the root-meter charge, using reservation keys `<wa-…>:<n>` for metered requests (§4.17); a charge that would exceed the account fails `kl:budget` before the spending action starts, as REQ-GATE-040.
- **REQ-GATE-087** When an attempt is fenced (its roots revoked, `grant.revoke` naming the workflow) gate MUST settle the attempt's unsettled reservations as `unresolved`; they stay counted against the ceilings until settled.
- **REQ-GATE-088** gate MUST write `budget.open`, `budget.settle` (one per settled key; metered model requests keep `budget.charge`) and `budget.close` receipts (protocols §19.3) before replying.

---

## 4. Design

### 4.1 Process structure

gate is one service generation with four process types, each spawned by `warden` from the same generation:

| Process | Count | Role | Privileges beyond baseline |
|---|---|---|---|
| `gate-core` | 1 | capwire server for all facets, token checks, broker/vault/ledger clients, outbox, meter, mandates, executors, receipts | none |
| `gate-net` | 1 | All upstream sockets in the host netns; splice relay; TLS client for terminated mode; listeners | host network namespace; `CAP_NET_BIND_SERVICE` only when `listenPorts` contains ports < 1024 |
| `gate-tls` | 1 per intercepting or terminated subject session | TLS termination (intercepted), HTTP parsing (hyper), request policy, injection, usage parsing | none (works on fds handed in by gate-core and gate-net) |
| `gate-render` | 1 | Runs WASI effect renderers (protocols §20.15) in Wasmtime using the Pulley interpreter, so no executable anonymous memory is needed | none |

`gate-core` talks to the others over private capwire socketpairs created by `warden` from the generation's internal routes. Splitting the HTTP/TLS parser into per-session processes contains parser bugs: a compromised `gate-tls` holds one session's interception key and that session's fds only.

### 4.2 Data structures

```rust
struct ConnEntry {
    id: u64,                    // monotonic per boot
    subject: PrincipalId,
    session: SessionId,
    root_id: [u8; 16],
    target: NetTarget,          // as granted
    resolved: SocketAddr,
    mode: ConnMode,             // Relayed | Terminated | Intercepted | Udp | Listening
    opened: Timestamp,
    bytes_up: u64, bytes_down: u64,
    label_applied: Label,
}

struct Intent {
    id: IntentId,               // e-ULID
    subject: PrincipalId,
    session: SessionId,
    root_id: [u8; 16],
    kind: String,
    class: EffectClass,         // effective = max(requested, registry, classRules, policy)
    target: String,
    args: Vec<EffectArg>,
    idempotency_key: String,
    compensator: Option<String>,
    payload_digest: [u8; 32],   // SHA-256
    payload_ref: BlobId,
    state: IntentState,
    approval: Option<ApprovalId>,
    mandate: Option<Vec<u8>>,   // DSSE bytes
    merge_txn: Option<String>,  // fs.merge only: strata transaction id
    result: Option<String>,     // JSON
    created: Timestamp, updated: Timestamp,
    receipts: Vec<RcptRef>,
}

enum IntentState { Staged, AwaitingApproval, Approved, Committing, Committed, Failed, Canceled, Compensating, Compensated }

struct MeterAccount { root_id: [u8;16], session: SessionId,
                      parent_root: Option<[u8;16]>,            // budget_parent fact / GateMeterAdmin.carve
                      children: BTreeSet<[u8;16]>,             // live carved sub-meters
                      ceilings: BTreeMap<Unit, i64>, spent: BTreeMap<Unit, i64>, reserved: BTreeMap<Unit, i64>,
                      carved: BTreeMap<Unit, i64>,             // sum of live children's ceilings
                      frozen: bool }

struct SessionModelState {                                      // §4.13
    session: SessionId,
    expected: Option<ModelId>,                                  // from the token's model(...) fact
    approved: Option<ModelId>,                                  // last identity re-approved by the human
    observed: Option<ModelId>,                                  // last provider-reported identity
    drift: Option<ApprovalId>,                                  // pending model.change approval
}
struct ModelId { provider: String, model: String, version: String }

struct EffectRec {                                              // durable effect record (§4.16), table effects
    effect: EffectId,                                           // fx-…
    workflow: WorkflowId, owner: Username,                      // owner from BrokerWorkflow.record
    intent: IntentId,                                           // the outbox intent carrying payload and renderings
    state: EffectState,                                         // protocols §7.5.25
    strategy: RetryStrategy,                                    // fixed at prepare
    executor: String,                                           // registry executor name, e.g. "http-replay", "bench-commit-prepared"
    request_digest: [u8; 32], payload_digest: [u8; 32],
    decision: Option<DecisionId>, mandate_digest: Option<[u8; 32]>,
    epoch: u64,                                                 // epoch that last authorized or dispatched it
    dispatched: Option<Timestamp>, attempts: u32,               // executor dispatch count
    dedup_until: Option<Timestamp>, retain_until: Timestamp,
    outcome: Option<String>,                                    // JCS
    receipts: Vec<RcptRef>,
}

struct WorkflowAccount {                                        // table accounts (§4.17)
    account: BudgetAccountId, workflow: WorkflowId,
    ceilings: BTreeMap<Unit, i64>,
    entries: BTreeMap<String, BudgetEntry>,                     // key → reserved | settled | released | unresolved
    reserved: BTreeMap<Unit, i64>, spent: BTreeMap<Unit, i64>, unresolved: BTreeMap<Unit, i64>,
    closed: bool,
}
```

`IntentState` maps onto `IntentStatus.State`:

| IntentState | IntentStatus.State | `result` |
|---|---|---|
| Staged | staged | empty |
| AwaitingApproval | staged | `"awaiting-approval:<a-id>"` |
| Approved | approved | empty |
| Committing | approved | `"committing"` |
| Committed | committed | executor result JSON |
| Failed | failed | error JSON |
| Canceled | canceled | empty |
| Compensating | committed | `"compensating"` |
| Compensated | compensated | compensator result JSON |

### 4.3 Egress paths

#### 4.3.1 Native principals (tiers 0 and 1)

1. The principal calls `Broker.materialize(token, ResourceRef.net, [connect])`.
2. `broker` calls `Gate.connect(target, token)` on facet `broker`; the subject is the token's `principal`.
3. gate returns the socket fd; broker passes it on as `Handle.socket`.

A principal routed to `gate#client` MAY call `Gate.connect` itself; both paths run the same checks. Native principals have only `lo`, so these sockets are their only network access.

**`keylos-gate-client`** (Rust crate with a C ABI) wraps this for apps:
- `connect(host, port, proto) -> Socket`;
- `https(host) -> HttpClient`: applies the detection rule of protocols §7.3.7. When the authorizing token's `net` fact has `$method ≠ "*"`, the returned socket is in **terminated** mode and the client speaks plaintext HTTP/1.1 (or HTTP/2 prior knowledge) to gate, which applies method checks and injection and originates TLS. Otherwise the client runs TLS itself over the relayed socket. The crate reads the fact with `Broker.inspect` and exposes one API either way;
- `resolve(name)` for display only.

In terminated mode the client MUST send absolute-form or origin-form requests with a `Host` header equal to the granted host; gate rejects a `Host` that differs from the grant with `421 Misdirected Request`. TLS-level options the client cannot express in plaintext (client certificates, ALPN other than `h2`/`http/1.1`) are unavailable on terminated grants; such clients need an unfiltered grant.

#### 4.3.2 Shimmed principals

| Subject | Forwarder | Endpoint |
|---|---|---|
| Tier L (compat views) | `gate-shim` inside the principal's netns, spawned by `warden` as part of the legacy view | `gate#shim` route created by `warden` for that principal |
| Tier 2/3 VMs | `bench-net` (bench repo) on the host, in the VM principal's cgroup, terminating the guest's virtio-net | `gate#shim` route created by `warden` for the VM principal and handed to `bench-net` |
| Pods with `cluster.egressViaGate` | `gate-shim --pod` (§4.3.8), one per pod, spawned for `cri` | `gate#shim` route created by `warden` for the pod principal |

Either way gate sees one `ShimEndpoint` connection per principal. The peer identity delivered in `ServiceHost.accept` is the bound principal (REQ-GATE-010). Each guest or tier-L flow becomes one `ShimEndpoint.connect` or `udpAssociate` call carrying the tokens the forwarder holds for that principal:
- tier L: files under `/run/keylos/tokens/*.biscuit` in the view, provisioned by `warden` from the principal's grants;
- VMs: `VmSpec.network`, held by bench.

`gate-shim` (tier L) is a small unprivileged static binary with:

| Listener | Purpose |
|---|---|
| `127.0.0.1:3128`, `[::1]:3128` | HTTP proxy: `CONNECT host:port` and absolute-URI requests |
| `127.0.0.1:1080` | SOCKS5 with CONNECT and UDP ASSOCIATE, no auth |
| `127.0.0.53:53` UDP+TCP | DNS stub → `ShimEndpoint.resolve` |
| `127.0.0.1:3129` | Transparent redirect target (`SO_ORIGINAL_DST`) |
| `/run/keylos/ssh-agent.sock` | SSH agent → `ShimEndpoint.sshAgent` |

`warden` installs, inside the tier-L netns, an nftables table `keylos_gate` redirecting TCP (except to the shim's own ports) to `:3129` and UDP 53 to `:53`, and dropping other UDP except via the SOCKS relay. The environment for proxy-aware software (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY=localhost,127.0.0.1,::1`) is set by the legacy view. These variables are not secrets.

**The forwarders are not trusted.** A compromised shim or `bench-net` can only exercise the bound principal's own tokens, because every check is in gate.

#### 4.3.3 Connect algorithm

```
connect(target, tokens, subject):                          # tokens: 1 for Gate.connect, ≥1 for ShimEndpoint
  1  for t in tokens: t := verify_biscuit(t, broker_root_pk)          ?→ kl:integrity
  2  revoked(t.root_id) (in-memory set, §4.10)                         ?→ kl:revoked
  3  now := trusted_time() else max(clock, LedgerAdmin time floor via NetWatch.timeTrusted state)
  4  host := normalize(target.host)                         # IDNA A-label, lowercase, strip trailing dot
  5  if captive && !t.has(captive(true)): fail kl:unavailable "captive portal"
  6  facts := ambient(time(now), operation("net","connect"|"bind"), resource("net", host:port),
                      host(host), port(target.port), method("*"),
                      session_label(LabelAuthority.labelOf(subject.session)), principal_kind(subject.kind),
                      offline_days(offline.days()))                                    # §4.14
  7  pick the first token whose authorizer succeeds          ?→ kl:denied
  8  if host starts with "listen:": return bind_listener(...)                      # §4.3.6
  8a if model_drift(subject.session) ∧ !drift_approved(subject.session):          # §4.13
        fail kl:needs-approval:<a-id of the session's model.change approval>
  8b if subject.kind == agent ∧ offline.days() > thresholdDays ∧ host ∉ host_history(template(subject)):
        r := requestFor(subject.session, GrantRequest{net(host,port,proto), [connect], "new host while offline"}, intent "",
                        idempotencyKey "offline-host:"+session+":"+host, intentSession "")   # §4.14
        r.outcome pending → fail kl:needs-approval:<a-id>; denied → fail kl:denied
  9  if !policy.sink_safe(host):
        r := BrokerSystem.checkFlow({session, kind:"net", target:host, payloadDigest: empty, rendered:[], provenance:[]})
        r.outcome: granted → continue; pending → fail kl:needs-approval:<a-id>; denied → fail kl:denied
 10  addrs := NetResolver (cache by TTL, max 300 s)            ?→ kl:not-found
 11  addr := pick(addrs)                                     # address safety, below
 12  plan := classify(target, token, subject)               # Relayed | Terminated | Intercepted | Udp
 13  up := gate_net.open(addr, port, proto)                  # 10 s timeout
 14  pair := socketpair(AF_UNIX, SOCK_STREAM | SOCK_SEQPACKET for udp)
 15  conn_table.insert(...); maybe_receipt("net.connect")
 16  if !policy.trusted_or_user(host): LabelAuthority.raiseFor(subject.session, {conf: cur, integ: untrusted}, "net:"+host)
 17  start relay (or hand fds to gate-tls); return pair.client
```

**Address safety.** Resolved addresses in `127.0.0.0/8`, `::1`, `169.254.0.0/16`, `fe80::/10`, `0.0.0.0/8`, `100.64.0.0/10`, RFC 1918, ULA `fc00::/7` and IPv4-mapped forms of all of these are refused unless the grant names that IP literal or a configured `localNetworks` entry. This blocks DNS rebinding into the LAN or local services.

#### 4.3.4 Modes

| Mode | When | Data path |
|---|---|---|
| Relayed | `tcp`; `https` without method filters or injection | gate-net relays between upstream TCP and the socketpair with `splice(2)` through a pipe. For `https`, gate peeks the ClientHello (≤ 16 KiB, record parsing only) to check SNI (REQ-GATE-004), then forwards it unchanged |
| Terminated | Native subject; `https` with method filters or injection | The subject speaks plaintext HTTP/1.1 (or HTTP/2 prior knowledge, detected by preface) on the socketpair; gate-tls parses and applies HTTP policy; gate-net originates TLS 1.2+/1.3 upstream with rustls and verifies the server certificate (system roots + `extraRoots` + `pins`) |
| Intercepted | Shimmed subject; `https` with method filters or injection | gate-tls terminates TLS toward the subject with a per-session leaf certificate (§4.4) and originates TLS upstream as in Terminated |
| Udp | `udp` | Connected datagram relay; one upstream UDP socket per association |
| Listening | `listen:` | A listening socket bound in the host netns and passed to the subject; accepted connections are not relayed |

There is no mode that hands an upstream socket to a subject: every outbound connection stays cuttable by gate (§4.10).

#### 4.3.5 DNS for shimmed principals

`ShimEndpoint.resolve(name, qtype)`:
1. Normalize the name.
2. Allowed iff a presented token has a `net(name, …)` fact, or a wildcard `*.d` fact covers it and the name passes §4.8's wildcard rule for U ∧ P sessions.
3. Allowed: build a one-question wire query and call `NetResolver.query`; return the response with TTLs capped at 300 s and `AD` cleared unless `secure = true`.
4. Not allowed: return a synthesized `REFUSED` response with the same ID.

`qtype` is limited to A, AAAA, CNAME, HTTPS, SVCB, TXT, SRV, MX; other types get `NOTIMP`.

#### 4.3.6 Listening sockets

```
bind_listener(target, token, subject):
  addr := parse(target.host after "listen:")                  # "[::]", "0.0.0.0", "127.0.0.1", "[::1]", "lan"
  require right("net", "listen:"+addr+":"+port, "bind")         ?→ kl:denied
  require port ∈ net config listenPorts (from NetWatch status json)  ?→ kl:denied
  if addr ∉ {127.0.0.1, [::1]}:                                 # scope lan/any → effect net.listen
      i := outbox.stage_internal(kind "net.listen", class compensable, subject,
                                 target "listen:"+addr+":"+port+"/"+proto,
                                 idempotencyKey "net.listen:"+session+":"+addr+":"+port+":"+proto,
                                 payload JCS {addr, port, proto, scope, why: token reason})
      commit(i)                                                 # §4.6.4; T2 by default policy; may fail kl:needs-approval:<a-id>
  fd := gate_net.bind(addr, port, proto, SO_REUSEADDR)          ?→ kl:conflict (port in use)
  listen_set += (proto, port, scope, intent?)                   # scope: loopback | lan | any (from needs.listen)
  NetPlumbing.setListenPorts([], [], listen_set.as_ListenPorts())  # ports form; tcp/udp lists MUST be empty
  receipt net.listen {addr, port, proto, rootId, intent?}
  return fd
```

- An approved `net.listen` intent is idempotent per `(session, addr, port, proto)`: a re-bind after a restart of the subject reuses the committed intent for as long as it is not compensated.
- **Compensation** (`Intent.compensate`, or revocation of the grant): remove the port from the listen set and call `setListenPorts`, so `net` drops inbound traffic to it; close gate-net's dup. The subject still holds its listening fd, but nothing outside the machine can reach it; broker freezes or kills the holder on revocation.
- When the subject closes its fd, gate notices on the next `setListenPorts` reconciliation (every 10 s, and on revocation) via a dup kept in gate-net with `SO_ACCEPTCONN` polling, removes the port and calls `setListenPorts` again. The `net.listen` intent stays `Committed`; no compensation receipt is written for a voluntary close.

#### 4.3.7 Captive mode

`gate-core` subscribes to `NetWatch.watch`. On `captive = true`:
- new connects without `captive(true)` fail with `kl:unavailable` ("captive portal");
- existing connections continue;
- connects with `captive(true)` tokens are allowed only if the subject's effective tier is ≥ 2 (`tier_floor(2)` holds) and use the normal relay path; their responses raise the subject to `public/untrusted`.

The captive-browser VM itself reaches TCP 80/443 and DNS on the captive link **directly**: `net` admits its `bench-net` cgroup for at most 600 s through `NetCaptive.admitSession` (protocols §7.5.11). `bench-net` sends only other flows of that VM to gate, which then sees them under the captive token broker minted for the VM session (`BrokerSystem.mintCaptive`).

On `captive = false` the restriction is lifted.

#### 4.3.8 Pod egress shims

With `cluster.egressViaGate = true` (`server-k8s`, protocols §21.5), `cri` redirects pod egress to addresses outside the cluster CIDRs to a **pod shim**, one per pod:

| Runtime class | Where the pod shim runs | Redirect |
|---|---|---|
| `keylos-sealed` | `gate-shim --pod` spawned for `cri` (gate generation entrypoint `pod-shim`) inside the pod's network namespace | nftables `redirect to :3129` for TCP and `:53` for UDP DNS, installed by `cri` in the pod netns |
| `keylos-vm` | `gate-shim --pod` in the cri network namespace, bound to the pod's tap-side address | `cri` DNATs the pod's non-cluster egress to the shim's transparent port |

Each pod shim holds exactly one `gate#shim` endpoint bound to the pod principal (`pod:<ns>/<name>:<image>@_cluster/…`), created by `warden` when the shim is spawned. Its tokens are those broker attached to the pod session at `registerSession`, derived from the default policy (`connect` permits for actor kind `pod`, typically from config `cluster.egress` allowlists).

Pod-mode differences from the tier-L shim:
- **Transparent only.** No HTTP or SOCKS proxy listeners; destinations come from `SO_ORIGINAL_DST` plus the name in the TLS SNI or HTTP `Host` header (REQ-GATE-011). The shim peeks at most 16 KiB.
- **DNS.** Pods resolve cluster names through cluster DNS. Names outside the cluster domains that reach the shim's `:53` are answered by `ShimEndpoint.resolve` with the same granted-names rule as §4.3.5.
- **No interception and no injection.** Pod grants are protocol-level (`$method = "*"`) unless policy grants method-filtered hosts, in which case the shim intercepts with a per-pod CA delivered by `cri` as a projected volume; the default policy does not.
- **Labels and receipts.** Pod sessions have human `_cluster`, so their receipts are not sealed (protocols §13.4). `net.connect` sampling follows REQ-GATE-060 with pods counted as non-agent principals.

### 4.4 Narrow TLS interception (shimmed subjects)

Interception exists only so that method filtering and credential injection can be enforced for subjects whose TLS stack runs outside keylos control.

1. **Per-session CA.** At the first intercepted connection of a session, gate-core generates an ECDSA P-256 key and a self-signed CA certificate:
   - subject `CN=keylos gate <session>`;
   - `nameConstraints` permitting only the DNS names of hosts in the session's intercepting grants;
   - `pathLenConstraint=0`;
   - validity = token expiry + 5 min, at most 24 h.

   The CA key lives only in gate-core memory and in the session's `gate-tls` process (and, to survive a gate-core restart, in `FdStore` as a sealed memfd under key `ca/<session>`). It is never written to disk.
2. **Delivering the CA certificate** (public part only):
   - VMs: `bench` calls `ShimEndpoint.caBundle()` and provides it to the guest as the read-only `keylos-ca` share; the bench-image adds it to the guest trust store;
   - tier L: `gate-shim` calls `caBundle()` and writes `/run/keylos/gate/ca.pem` (the legacy image's system bundle followed by the session CA) in its tmpfs inside the view. That path is registered in protocols §10.7; `compat` sets `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS` to it.
3. **Leaf certificates** are minted per host with 1-hour validity, SAN = host, signed by the session CA.
4. **Disclosure:**
   - `net.connect` receipts carry `data.intercepted = true`;
   - `GateDebug.interception(session)` returns the intercepted hosts; `warden` copies them into the confinement report `tlsInterception` field;
   - `gate status --session` lists them.
5. **Pinning.** Software that pins certificates fails on intercepted hosts. That is expected. The user can grant the host without method filters and without injection, which disables interception and is shown as a wider grant at consent time.
6. **Upstream verification** uses rustls with the system roots plus config `extraRoots`; `pins` adds SPKI pinning. Failures surface to the client as HTTP `502` with JSON `{"error":"kl:integrity", …}`.

**HTTP policy per request** (intercepted and terminated):
- `method($m)` ambient fact → token authorization per request.
- Size limits: header block ≤ 64 KiB; body ≤ the grant's `maxBody` (default 64 MiB); U ∧ P limits per §4.8.
- Injection: apply matching rules (§4.5).
- Effect classification: unsafe methods are matched against the kind registry (§4.6.1); stage-only subjects get implicit intents (§4.6.2).
- Response: label raising before the first byte; usage metering for model hosts (§4.9).
- HTTP/2 on both legs via hyper; each stream is a separate request for policy purposes.
- Strict parsing: reject obs-fold, conflicting `Content-Length`/`Transfer-Encoding`, invalid header bytes; normalize the path (percent-decode unreserved characters, remove dot-segments, reject encoded `/`) before prefix checks.

### 4.5 Credential injection

Rule format (part of gate config; §10):

```json
{"name":"github-pat","vaultItem":"github/pat","host":"api.github.com","pathPrefix":"/",
 "kind":"header","header":"Authorization","template":"Bearer {{secret}}","principals":["agent:*","bench:*","legacy:*"],
 "methods":["GET","POST","PATCH","PUT","DELETE"],"stripClientHeaders":["Authorization","Cookie","Proxy-Authorization"]}
```

**Algorithm per request:**
1. Find rules matching (host, normalized path prefix, method, subject actor pattern). Longest path prefix wins; ties are a config error rejected at load.
2. Check the session holds `right("secret", "<vaultItem>", "use")`; otherwise `403` + `kl:denied`.
3. `handle := vault.inject(vaultItem, "https://<host><pathPrefix>")`, cached per session ≤ 10 min. `fd := vault.open("inject:" + hex(handle), "gate:<rule name>")`. Map the fd read-only (protocols §20.10), read the length-prefixed value.
4. Remove `stripClientHeaders`; set `header` from `template` with `{{secret}}` replaced; zeroize the temporary buffer after serialization; unmap and close the fd.
5. Bodies are never rewritten; response headers are not touched.

**Rule kinds:**

| Kind | Mechanism |
|---|---|
| `header` | As above |
| `query` | Append `<param>=<secret>` to the query; `param` in the rule |
| `basic` | `Authorization: Basic base64(user:secret)`; `user` in the rule |
| `aws-sigv4` | Sign the request with SigV4 using the item (access key ID + secret key, JSON) and `region`/`service` from the rule |
| `oauth-exchange` | The item holds a refresh token or client credentials. gate obtains short-lived access tokens, down-scoped with RFC 8693 token exchange where the provider supports it and audience-bound with RFC 8707 `resource=<target>`. Cached per session until 60 s before expiry. Used for remote MCP servers |
| `fleet-compliance` | On fleet-enrolled machines: `Keylos-Compliance: <base64 DSSE>` from `FleetCompliance.complianceToken(audience = host)`, cached until its expiry. No vault item |
| `ssh` | SSH agent per shimmed subject (`ShimEndpoint.sshAgent`): `REQUEST_IDENTITIES` lists only items whose `use` right the session holds; each `SIGN_REQUEST` is bound to a `connect` from the same session to the item's bound host within the previous 30 s; `session-bind@openssh.com` for other hosts is refused, so agent forwarding cannot be abused |
| `git-signing` | Items of vault kind `git-signing` (agent session keys created by `aide`) are offered by the same agent socket with **no host binding**, listed only to the session named in the item ACL. A `SIGN_REQUEST` whose data parses as an SSH `publickey` user-authentication request is rejected, so these keys sign commits and tags only |

### 4.6 Effects

#### 4.6.1 Kind registry

The registry is static data in the gate generation (`registry/effect-kinds.json`) plus policy additions. Each entry:

```json
{"kind":"git.push","class":"compensable","match":{"http":{"method":"POST","path":"*/git-receive-pack"}},
 "renderer":"git-receive-pack","executor":"http-replay","compensator":"git.delete-branch",
 "classRules":[{"if":"force || protectedRef","class":"irreversible"}],
 "dataFields":["body"],"controlFields":["refs","url"]}
```

| Kind | Match (implicit staging) | Renderer | Executor | Compensator |
|---|---|---|---|---|
| `fs.merge` | — (staged by `aide` only) | The prepared merge's `keylos.fsmerge/2` file list (protocols §20.12; payload = the manifest JCS, payload digest = the prepared-merge digest) plus the complete unified-diff attachment from `BenchMerge.render` (the prepared content, strata §4.5.6) | `BenchMerge.commitShare(session, share, manifestDigest, mandate)` on `bench#merge`, which commits exactly that prepared merge (`PreparedMerge.commit`); records the returned transaction and undo snapshot. A stale prepared merge (`kl:conflict`) moves the intent to `Failed` with `result = "stale; re-prepare"`; aide stages a new intent with the new digest | `fs.undo`: `Strata.undo(<transaction>)` on `strata#gate` (§4.6.6) |
| `git.push` | POST `*/git-receive-pack` | Ref updates (old→new), commit list from the pack, force flag (old-oid ≠ remote value at stage time, from a gate-side `ls-remote`), protected-ref flag | HTTP replay; receive-pack's old-oid check makes stale replays fail safely | `git.delete-branch` (refs created by this intent only) |
| `git.pr.open` | POST `/repos/{o}/{r}/pulls` (GitHub), `/merge_requests` (GitLab), Gitea equivalents | Title, base←head, body (sanitized markdown) | HTTP replay | Close PR |
| `email.send` | — (staged by tools; SMTP is never intercepted) | RFC 5322: From, To, Cc, Bcc, Subject, first 4 KiB of text, attachments with sizes and SHA-256 | SMTP submission (465/587) with injected credentials, or a provider HTTP API rule | none |
| `message.send` | Configured chat APIs | Channel, text | HTTP replay | none |
| `http.post`/`put`/`patch`/`delete` | Any unsafe method on an intercepted or terminated host not matched above | Method, URL, headers with credentials redacted, body pretty-printed if JSON ≤ 64 KiB, else size and digest | HTTP replay | Per-host registered compensator, else none |
| `payment.authorize` | Configured PSP APIs | AP2-style: merchant, amount, currency, items, recurring flag | HTTP replay | none |
| `publish.package` | `PUT`/`POST` to registries (crates.io, npm, PyPI) | Package, version, files | HTTP replay | none |
| `cloud.iam.change` | AWS IAM/STS mutations, GCP `setIamPolicy`, Azure role assignments | Principal, role, scope | HTTP replay | none |
| `db.write.prod` | Hosts tagged `prod-db` | Statement or body | HTTP replay | none |
| `calendar.create` | CalDAV `PUT`, Google Calendar `events.insert` | Title, time, attendees | HTTP replay | Delete event |
| `file.share` | Drive/Dropbox share APIs | File, grantee, role | HTTP replay | Revoke share |
| `device.actuate` | — (staged by device apps) | Device, action | **Caller-executed** (§4.6.8): the staging app performs the action with the delivered mandate | none |
| `net.listen` | — (staged internally by gate for non-loopback `listen:` binds, §4.3.6) | Address, port, protocol, scope (`lan`/`any`), reason from the grant | gate binds the socket and calls `NetPlumbing.setListenPorts` | Close the port (remove from the listen set) |
| `media.export` | — (staged by `portal-files` or `atrium` for the human's write to removable media, protocols §9.5) | Device label, destination path on the device, file name, size, SHA-256; counts as egress (property X) in `checkFlow` | **Caller-executed** (§4.6.8): the stager calls `MediaBrowser.export(path, data, mandate)`; bench verifies the mandate | Caller deletes the file on the device |
| `config.propose` | — (recorded by `aide` for agent proposals) | Plan summary and capability changes | **Caller-executed** (§4.6.8): `aide` calls `Config.propose` itself; the intent records the proposal | none (reversible: a proposal changes nothing) |
| `x-…` (policy) | Policy `match` | WASI renderer component (§4.6.7) or generic `http` | HTTP replay or registered executor | Policy-registered or none |

**Effective class** = max(class requested in `stage`, registry class, `classRules` result, policy class override).

**Retry strategy** (protocols §20.26). Every registry entry and every policy `x-` kind declares `"strategy"` for its executor; the HTTP-replay executor's strategy depends on the destination and is computed at `prepare` from the configured destinations (§10):

| Executor | Strategy | Completion lookup or reconciliation |
|---|---|---|
| `bench-commit-prepared` (`fs.merge` durable effects) | `transactional` | `BenchMerge.preparedStatus(pm-…)`: `committed` → `succeeded` with its transaction and undo snapshot; `prepared` → not executed, dispatch again (`commitPrepared` is idempotent); `stale` or `discarded` → `failed` |
| `http-replay` to a destination in `destinations[]` with `idempotency.verified = true` | `downstreamIdempotency` | Re-send with `Idempotency-Key: <fx-…>` and the identical stored request while now < `dedupUntil` = first dispatch + `windowSecs` |
| `http-replay` for `git.push` | `reconciliation` | `git-ref` reconciler: `ls-remote` the pushed refs: every ref equals the pushed new OID → `succeeded`; every ref still equals its old OID and the remote is authoritative (no mirror) → absent, dispatch again; otherwise `outcomeUnknown` |
| `http-replay` for `git.pr.open` | `reconciliation` | `pr-search` reconciler: list open pull requests for the head branch on the base repository and look for the marker line `Keylos-Effect: <fx-…>` gate appends to the body: found → `succeeded`; the provider's list endpoint is strongly consistent per its documentation and no match → absent; otherwise `outcomeUnknown` |
| `http-replay`, any other destination | `noSafeRetry` | none |
| `smtp` | `reconciliation` with an IMAP rule whose provider is configured `consistency: "strong"`; else `noSafeRetry` | IMAP search of the sent folder for `Message-ID: <fx-…@keylos>` |
| `net-listen` | `transactional` | The listen set in `meter.redb`/`outbox.redb` is the completion record |
| caller-executed (`media.export`, `device.actuate`, `config.propose`) | `noSafeRetry` | The executor's completion receipt (`DurableEffects.complete`) |

An `Idempotency-Key` header is sent on every HTTP replay, but it never by itself makes a destination `downstreamIdempotency`.

`dataFields`/`controlFields` are rendering hints: the prompt highlights control fields (recipients, URLs, amounts) and shows their argument provenance first.

#### 4.6.2 Implicit staging over HTTP

When an unsafe request on an intercepted or terminated connection matches a kind, and the session holds `right("effect", kind, "stage")` but not `commit`:
1. gate buffers the full request (bounded by `maxBody`, streamed to disk above 1 MiB) into the outbox as the payload, in canonical form: request line, headers in received order **without** injected credentials, then the body.
2. It creates the intent with idempotency key `implicit:<sha256 of payload>`.
3. It responds:

```
HTTP/1.1 428 Precondition Required
Keylos-Intent: e-01JB…
Content-Type: application/json

{"keylos":"staged","intent":"e-01JB…","kind":"git.push","class":"irreversible",
 "message":"Staged for approval. The request will be replayed after commit."}
```

Agents are taught by their template prompt that `428` with `Keylos-Intent` means "staged"; `aide` turns it into an `effect` event.

**Replay at commit:** the stored request is re-sent with credentials injected at that moment and the header `Idempotency-Key: <intent idempotency key>`. The response (status, headers, first 64 KiB of body) is the intent result, delivered to the session through `aide` or `gate intents show`.

#### 4.6.3 Rule of Two and flow proofs

`stage` and `commit` call `checkFlow` with:
- `kind` = the intent kind, `target` = the intent target, `payloadDigest` = SHA-256 of the payload;
- `rendered` = the rendering (§4.6.7), `provenance` = `ArgProvenance` built from `EffectArg.source`/`label`;
- `flowProof` = the DSSE from intent arg `x-flow-proof`, if present.

broker decides whether the flow proof is accepted (protocols §20.11). A flow proof waives only the declassification. It never waives an irreversible-class mandate.

#### 4.6.4 Outbox state machine

```
            stage()
   ──────────────────────► Staged ──cancel──► Canceled
                             │
            commit(): needs approval (class / checkFlow pending / policy tier)
                             ▼
                      AwaitingApproval ──Approval denied / expired / canceled──► Canceled
                             │ Approval.wait → granted; Approval.mandate → verified (§4.7)
                             ▼
   commit() within policy ─► Approved ──commit()──► Committing ──ok──► Committed ──compensate()──► Compensating ──ok──► Compensated
                                                      │                              │ fail
                                                      └─fail─► Failed                └──► Committed (result notes failure; retry allowed)
```

Rules:
- Caller-executed kinds (§4.6.8) go `Approved → Committed` without `Committing`: there is no gate-side executor.
- `Committing` is persisted before the executor runs. On restart, intents in `Committing` are **not** re-executed automatically; they move to `Failed` with `result = "interrupted; outcome unknown"`, unless the executor supports idempotent re-execution:
  - HTTP replay, which always sends `Idempotency-Key`;
  - SMTP with a `Message-ID` check against the sent folder when an IMAP rule exists;
  - `fs.merge`, because `BenchMerge.commitShare` is idempotent per manifest digest (a committed prepared merge returns its stored result; an interrupted one is rolled back by strata and stays committable with the same mandate, strata §4.5.6);
  - `net.listen`, because binding is re-done from the committed intent.
- `AwaitingApproval` intents expire with the approval (default 24 h) and become `Canceled`.
- With policy `autoCommitOnApproval = true` (default), gate commits as soon as the approval resolves with a verified mandate.

**Durable effects** (§4.16) use the states of protocols §20.26 and drive their outbox intent:

```
 prepare ─► prepared ──commit (loom)──► awaitingApproval ──decision approved, mandate consumed──► authorized ──► dispatching
    │            │ cancel                   │ cancel / denied / expired                           │ (caller-executed: stop, complete())
    │            ▼                          ▼                                                     ▼
    │        cancelled                  cancelled ("denied")                       succeeded │ failed │ outcomeUnknown
    │                                                                                   │                    │ reconcile / resolve
    └ same fx-, same requestDigest → same record; other digest → kl:conflict           compensated         succeeded │ failed
```

| EffectState | Intent state | `IntentStatus.state` / `result` |
|---|---|---|
| prepared | Staged | staged |
| awaitingApproval | AwaitingApproval | staged, `awaiting-decision:<dr-…>` |
| authorized | Approved (gate executor) or Committed (caller-executed: `result` = base64 mandate) | approved / committed |
| dispatching | Committing | approved, `committing` |
| succeeded | Committed | committed, executor result |
| failed | Failed | failed |
| outcomeUnknown | Failed | failed, `outcome-unknown:<fx-…>` |
| cancelled | Canceled | canceled |
| compensated | Compensated | compensated |

Unlike ordinary intents, a durable effect interrupted in `dispatching` is never simply marked failed: it continues per its strategy (REQ-GATE-077, §4.16.4).

#### 4.6.5 Outbox storage

- **Database:** `/var/lib/keylos/gate/outbox.redb` (redb 2.x), tables `intents`, `by_session`, `by_idempotency`, `mandates_used`, `blobs_meta`, and for durable effects `effects` (`fx-` → `EffectRec`), `effects_by_workflow` (`wf-` → effect IDs), `decisions_used` (`dr-` → `fx-`), `epochs` (`wf-` → highest epoch seen), `anchor` (last acknowledged ledger `seq`, §4.18). Every write is one redb transaction with `Durability::Immediate`.
- **Payload blobs:** `/var/lib/keylos/gate/blobs/<sha256>`, written with `O_TMPFILE` + `linkat` after `fsync`, mode 0400, encrypted with AES-256-GCM using the unit key `vault.dataKey("gate:<session>")` (facet `gate`). The digest names the plaintext; the AAD binds the digest.
- **Durable effect payloads** are encrypted under `vault.dataKey("gate:<owner>:<wf-…>")` instead of the session unit, so they outlive the attempt sessions; `DurableEffects.forget` shreds that unit (REQ-GATE-082).
- **Crypto-shredding:** `vault.forget("gate:<session>")` shreds staged payloads of a session (performed when a session is forgotten through strata/aide retention, or by `gate` after retention).
- **Retention:**

| Intents | Payloads | Metadata |
|---|---|---|
| Committed and compensated | Deleted after 30 days, unit key forgotten when the session has no live intents | Kept in ledger receipts |
| Canceled and failed | Deleted after 7 days | Kept in ledger receipts |
| Durable effects (any state) | Kept until terminal + 7 days, or until `forget` | `EffectRec` kept per REQ-GATE-081 (never while non-terminal, at least until the workflow horizon); then removed by the retention sweep |

#### 4.6.6 `fs.merge` compensation

The `fs.undo` compensator is executed by gate on `strata#gate`, which serves `Strata.undo` only for transactions committed by an `fs.merge` intent (protocols §7.5.7):

```
compensate(i):  i.kind == "fs.merge" ∧ i.state == Committed ∧ i.merge_txn = x
  1  state := Compensating (persisted)
  2  Strata.undo(x)                                        # strata restores the pre-commit snapshot of the merged tree
       ok                     → state := Compensated; receipt effect.compensate {intent, via: "executor", result}
       kl:conflict (tree changed after the merge) → state := Committed; result notes "undo conflicts: <paths>";
                                                    receipt effect.fail {intent, reason}; the human resolves with strata
       kl:unavailable         → retry with backoff (1 s → 60 s) for 10 min, then state := Committed with the error
```

A human may also undo the merge directly (`strata undo x`, strata facets `user`/`cli`). gate watches the ledger (`Ledger.watch`, `eventTypes = ["txn.undo"]`) and, when a `txn.undo` receipt names the intent's recorded transaction, moves the intent to `Compensated` and writes `effect.compensate` with `data.via = "strata"`. Compensation is idempotent: a second `compensate` on a `Compensated` intent returns the stored status.

#### 4.6.7 Renderers

- Built-in renderers are Rust code in gate-core.
- Policy `x-…` kinds MAY name a renderer component (a `data` generation with the component at `/renderer.wasm`). `gate-render` instantiates it with Wasmtime (Pulley interpreter, component model, no WASI imports beyond protocols §20.15), fuel 50 million, 64 MiB memory, body ≤ 256 KiB, attachment ≤ 8 MiB, wall time ≤ 2 s.
- Renderer output is sanitized: markdown rendered to the `text/markdown` subset atrium accepts (no HTML, no remote images, links shown as text), bidi isolation applied to every user-controlled string.
- Every `RenderedEffect` gate emits carries `review` and `payloadDigest` (protocols §7.3.4, E33). gate sets `review = decorative` only on its own optional extras; everything listed below is `required`.
- **Canonical-text renderer** (built in, `text/plain`, never fails on valid payloads): one line per required detail `name: value`, values escaped and bidi-isolated, lists one item per line, bodies in full (paged by atrium; at most 8 MiB as attachment), binary content as size + SHA-256 + MIME type. It is emitted as an additional `required` rendering whenever the primary renderer is a component, is a lossy summary, or failed; atrium uses it as the fallback (atrium REQ-ATRIUM-019c).

**Required review details** (REQ-GATE-046; a title, a summary or a digest alone never satisfies them):

| Kind | Required details |
|---|---|
| `fs.merge` | Every manifest entry (path, kind, rename source, mode, size) and the complete diff of every text change; binary changes as size + SHA-256 |
| `git.push` | Remote URL, every ref update (old → new, force flag, protected flag) and the commit list (author, subject) |
| `git.pr.open` | Repository, base ← head, title, full body |
| `email.send` | From, To, Cc, Bcc, Subject, the complete text body, and every attachment's name, size, MIME type and SHA-256 (text attachments in full) |
| `message.send` | Destination channel/recipient and the complete text |
| `http.post`/`put`/`patch`/`delete` | Method, full URL, headers (credentials redacted) and the complete body (pretty-printed JSON or text in full; binary as size + SHA-256 + type) |
| `payment.authorize` | Payee/merchant, amount, currency, items, recurring flag and schedule |
| `publish.package` | Registry, package, version and the file list with sizes and digests |
| `cloud.iam.change` | Principal, role, scope, change type |
| `db.write.prod` | Target host and database, the complete statement or body |
| `calendar.create` | Title, time and time zone, attendees |
| `file.share` | File, grantee, role |
| `device.actuate` | Device, action and parameters |
| `net.listen` | Address, port, protocol, scope |
| `media.export` | Device label, destination path, file name, size, SHA-256 |
| `config.propose` | Plan summary and every capability change |
| `x-…` | The `controlFields` and `dataFields` of the policy registration, in full |

#### 4.6.8 Caller-executed effects

Some effects can only be performed by the principal that staged them, because it holds the device-side capability (`MediaBrowser` for `media.export`, an app's own device protocol for `device.actuate`) or because the action is a call into a keylos service the stager holds (`config.propose`). For these kinds gate is the **decision and record point**, not the executor:

1. The stager calls `Gate.stage` with the full payload (for `media.export`: JCS `{device, path, name, size, sha256}` plus the file bytes as the payload fd, so the digest binds the content).
2. `Intent.commit` runs REQ-GATE-032 steps 1–2 and obtains the mandate exactly as for gate-executed kinds; `media.export` is X for the Rule of Two, so a U ∧ P session needs declassification.
3. gate moves the intent to `Committed` and returns `IntentStatus.result = <base64 of the delivered mandate DSSE envelope>` (nothing else in the field, so every executor decodes it the same way).
4. The stager performs the action and presents the mandate to the device side, which verifies it like gate does (§4.7): `MediaBrowser.export` (bench) checks that the mandate's `effects[].digest` equals the SHA-256 of the payload it receives.
5. `Intent.compensate` returns `kl:unsupported` with the message `compensate on the device side`; the stager deletes the file through `MediaBrowser` and records nothing at gate.

A mandate delivered for a caller-executed intent has `scope = once`; gate records it in `mandates_used` at step 3 so it cannot be reused for a second intent.

### 4.7 Mandates

**Sources:**
1. `GrantResult.mandate` from `requestFor` when the outcome was decided synchronously;
2. `Approval.mandate()` after `Approval.wait()` returns `granted`;
3. intent arg `x-mandate` (base64 DSSE) for pre-authorized mandates such as AP2 intent mandates.

**Signers.** Per protocols §14.4, a delivered mandate is either **presence-signed** (owner credentials, §5.3) or **re-signed by `service/broker`** after broker verified the deciding channel's signature (atrium approver key, the `vouchd` phone key, or an `approver/<id>` key). gate verifies only these two signer kinds and never holds approver keys.

**Key material:**
- **Owner registry.** `HearthSystem.owners()` on `hearth#system` returns `keylos.owners/1`. gate replays it with `keylos-presence` (protocols §20.3), requires its genesis-to-boot credential set to equal the `ownerPresence` keys of `/run/keylos/boot/trust.json` (a cross-repository file gate may read, protocols §10.7), caches it for 60 s, and refreshes it on every `key.enroll`/`key.remove` receipt (ledger watch).
- **`service/broker` key.** gate obtains broker's current service public key with `Ledger.serviceKey("broker")` (protocols §7.3.5) over its warden-authenticated `ledger` route, at start and whenever a `ledger.key.register` receipt with `data.service = "broker"` appears on its ledger watch, and pins it for the boot. A change of broker's key within a boot is accepted only when `serviceKey` returns the new key, and is reported in `gate status`. `kl:not-found` (broker not yet registered) leaves non-presence mandates unverifiable (§7).

**Verification (all steps MUST pass):**
1. Parse the DSSE envelope; payload type `application/vnd.keylos.mandate+json; version=1`; payload JCS-canonical; `schema = "keylos.mandate/1"`.
2. Signature:
   - `presence = true`: verify with `keylos-presence` (protocols §5.3, purpose `mandate`, `grant.persist` or `debug.grant`) against the owner registry state current at the payload's time. On quorum machines (`policy.mode = "quorum"`) the envelope MUST carry signatures of ≥ `policy.threshold` distinct owners (protocols §5.4).
   - `presence = false`: exactly one signature by the pinned `service/broker` key over the delivered envelope's PAE; `channel` ∈ {`local`, `phone`, `org`}.
   - `channel = "quorum"` (headless machines, protocols §14.3–14.4): the envelope MUST be presence-signed by ≥ `policy.threshold` distinct owners (the quorum case of `presence = true`); a `quorum` channel with `presence = false` is rejected.
   - Source 3 (`x-mandate`) with `presence = false`: rejected (`kl:denied`); pre-authorized mandates MUST be presence-signed.
3. `principal` equals the intent subject, or is an ancestor session of it with `scope ∈ {session, persistent}`.
4. Exactly one `effects[i]` has `kind == intent.kind`, `target == intent.target` and `digest == "sha256:" + hex(payload_digest)`.
5. `constraints.expires` > trusted now; for payments `constraints.maxAmount` ≥ the rendered amount.
6. `scope = once`: the envelope's SHA-256 MUST NOT be in `mandates_used`; it is recorded atomically with the transition to `Committing` (or to `Committed` for caller-executed kinds).
7. Effects whose policy requires presence MUST have `presence = true`; a mandate with `channel` `phone` or `org` is accepted only for kinds whose permit lists that channel (broker enforces `@channels`; gate re-checks that a `phone`/`org` mandate is never used for a presence-required kind). When `constraints.channels` is present, it MUST contain `channel` unless `channel` is `quorum` (protocols §14.4, E2).
8. `@orgApproval` mandates (`channel = "org"`) MUST carry `constraints.localDecision` when the permit also had `@tier` (protocols §16.2); gate checks only presence of the field, broker checked its content.

Failure → `kl:integrity` (signature, digest, non-canonical) or `kl:denied`/`kl:expired`; the intent stays `AwaitingApproval`. Because non-presence mandates are signed, gate re-verifies stored mandates after a restart without trusting the connection they arrived on.

### 4.8 Covert-channel limits for tainted sessions (U ∧ P)

| Limit | Default |
|---|---|
| URL length (path + query) | ≤ 512 bytes |
| Query string | ≤ 256 bytes; Shannon entropy of query value bytes ≤ 4.5 bits/byte, otherwise T2 approval |
| Client-added request headers (excluding an allowlist of standard headers) | ≤ 1 KiB total |
| Request body for safe methods | 0 bytes |
| New distinct hostnames per minute | ≤ 10 |
| Requests per host per minute | ≤ 120 |
| DNS | Only names already granted; `*.example.com` grants resolve only names seen in an HTTP response from that domain within the session, or listed explicitly |
| WebSocket upgrades | Refused |
| Opaque TLS to non-sink-safe hosts | Impossible: it is X and goes through `checkFlow` |

Exceeding a limit returns `429` (rates) or `403` with `kl:needs-approval:<a-id>` (sizes, entropy; the approval is requested with `requestFor`). Limits can be raised only by config changes flagged as capability changes (§10). Limits apply to relayed connections only at the connection level (host rate, new hosts, DNS); request-level limits need interception or terminated mode, which is why U ∧ P agent sessions get intercepted HTTPS by default policy.

### 4.9 Model-provider metering

| Adapter | Hosts (defaults) | Usage source |
|---|---|---|
| `anthropic` | `api.anthropic.com` | JSON `usage.input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`; SSE `message_start.message.usage`, `message_delta.usage` |
| `openai` | `api.openai.com` | `usage.prompt_tokens`/`completion_tokens` or `input_tokens`/`output_tokens`; SSE final chunk with `usage` (gate adds `stream_options.include_usage=true`) |
| `google` | `generativelanguage.googleapis.com` | `usageMetadata.promptTokenCount`, `candidatesTokenCount` |
| `openai-compatible` | configured | As `openai` |
| `bedrock` | `bedrock-runtime.*.amazonaws.com` | Body `usage` or `x-amzn-bedrock-*-token-count` headers |

**Pre-authorization:** reserve `estimate = ceil(body_bytes/3) × price_in + max_tokens × price_out` (usd-micro), `ceil(body_bytes/3) + max_tokens` tokens and 1 call. If `max_tokens` is absent gate inserts the adapter default (8192). Any failed reservation → HTTP `402` with JSON `{"error":"kl:budget"}`.

**Settlement:** replace the reservation with actual usage on completion. For streams keep a running total and end the stream with `event: error` / `data: {"type":"keylos_budget_exhausted"}` when remaining reaches 0.

Prices are config (usd-micro per million tokens) per model ID. Requests for model IDs missing from the price table are refused unless the account has no usd-micro ceiling. `Gate.charge` records spending that does not pass through gate (local GPU time priced by aide config).

**Model identity** (input to §4.13). Each adapter extracts `(model, version)` from every response:

| Adapter | `model` | `version` |
|---|---|---|
| `anthropic` | JSON `model` (or SSE `message_start.message.model`) | the `model` value itself when it is a dated snapshot ID; otherwise the response header named by config `versionHeader` (default none) |
| `openai`, `openai-compatible` | JSON `model` (or first SSE chunk `model`) | JSON `system_fingerprint` when present, else the `model` value |
| `google` | request model path segment | JSON `modelVersion` |
| `bedrock` | request `modelId` | header `x-amzn-bedrock-model-version` when present, else `modelId` |

The identity is written into the `budget.charge` receipt (`data.model = {provider, model, version}`). A response with no extractable identity is recorded as `version = "unknown"` and does not by itself count as drift.

### 4.10 Revocation

gate learns revocations from the ledger (`Ledger.watch`, `eventTypes = ["grant.revoke"]`) and checks the in-memory revoked set on every `connect`, `stage`, `commit` and `charge` (protocols §8.4). On a revocation:
1. Add the root ID to the revoked set.
2. Close all connections with that root ID: RST upstream, EOF to the subject; close listening sockets held by gate-net and update `setListenPorts`.
3. Move intents with that root ID in `Staged`/`AwaitingApproval` to `Canceled`.
4. Freeze meter accounts of that root ID and of every carved descendant (§4.12); release their carved ceilings.
5. Compensate committed `net.listen` intents of that root ID (close the port).

Holders keep any fd they already received (listening sockets); broker terminates or freezes them through `PrincipalControl` according to the grant's `onRevoke`.

During ledger unavailability gate re-checks tokens with `Broker.inspect` (cached ≤ 1 s) and fails closed when broker is unreachable.

### 4.11 Restart recovery

On `gate-core` start:
1. Fetch the per-session CA keys and listener dups from `FdStore` (`ca/<session>`, `listen/<port>`).
2. Reload intents. `Committing` → per §4.6.4. `AwaitingApproval` → call `requestFor` again with the same intent and `idempotencyKey = "commit:<e-id>"`; broker returns the same approval for 24 h (protocols §7.5.2).
3. Rebuild meter accounts and the sub-meter tree from `meter.redb`.
4. Re-subscribe to `NetWatch` and ledger watches from the stored cursor.
5. Reload `SessionModelState` and the per-template host history (`hosts.redb`), and re-read the revocation age (§4.14).
6. Re-pin broker's service key and reload the owner registry (§4.7).
7. Run the rollback check of §4.18 before serving `DurableEffects` or `WorkflowBudget`.
8. Durable effects: `prepared` and `awaitingApproval` records stay as they are (loom commits them again; `authorizeEffect` returns the same durable decision, which survives broker restarts, so no second prompt is created); `authorized` records of gate-executed kinds are dispatched; `dispatching` records continue per their strategy (§4.16.4), never re-executed blindly; `outcomeUnknown` records stay until reconciled or resolved.
9. Workflow accounts are reloaded from `meter.redb`; reservations whose attempt's roots were revoked while gate was down become `unresolved` (REQ-GATE-087).

### 4.12 Hard sub-meters (budget carving)

Sub-agents must not amplify spending through fan-out. broker carves a child budget from the parent when it delegates (protocols §7.5.12, §8.2):

```
carve(parentRoot P, childRoot C, budget B)        # facet broker only
  1  A_P := account(P) ?→ kl:not-found;  A_P.frozen → kl:revoked
  2  for (unit, amount) in B:
        remaining := A_P.ceilings[unit] − A_P.spent[unit] − A_P.reserved[unit] − A_P.carved[unit]
        amount ≤ remaining  ?→ kl:budget
  3  A_C := new account(C, parent_root = P, ceilings = B); A_P.children += C; A_P.carved += B
  4  persist (one redb transaction); receipt budget.carve {parentRoot: P, childRoot: C, budget: B}

charge(account C, unit, n) / reserve(…):
  path := [C, parent(C), parent(parent(C)), …]                     # follow parent_root to the top
  for a in path: a.spent[unit] + a.reserved[unit] + n ≤ a.ceilings[unit] ?→ kl:budget (no partial charge)
  for a in path: a.spent[unit] += n                                 # one redb transaction

release(childRoot C):
  A_P.carved −= A_C.ceilings; A_P.children −= C; A_C.frozen := true   # spent amounts stay charged to P
```

- A token with `budget_parent(P)` (protocols §8.2) is charged on its own account and on every ancestor (REQ-GATE-040). A token with a `budget` fact but no `budget_parent` is a root account.
- `GateMeterAdmin.meterFor(rootId)` returns `(spent, remaining, parent)` where `remaining` already subtracts the children's carved ceilings.
- Revoking a root freezes its account and every descendant account (§4.10); unspent carved amounts are released automatically.
- The tree depth is bounded by broker's `max_depth`; gate additionally refuses a carve that would make a path longer than 16.

### 4.13 Model drift

```
on model response for session S with identity O (§4.9):
  E := token model(...) fact of S, or SessionModelState.approved if a re-approval happened since
  record O in budget.charge
  if E is set ∧ O.version ≠ "unknown" ∧ (O.model ≠ E.model ∨ (E.version ≠ "" ∧ O.version ≠ E.version)):
      if S.drift is empty:
          r := BrokerSystem.requestFor(S, GrantRequest{resource: {model: O.provider+"/"+O.model+"@"+O.version},
                                        rights: [use], reason: "<provider> model changed: <E> → <O>"},
                                        intent "", idempotencyKey "model.change:"+S+":"+O, intentSession "")
          # ResourceRef.model, Cedar entity Model, action use (protocols §7.3.3, §16): T2 by default policy
          S.drift := r.approval;  TrustedPrompt.notify(warning)
      S.observed := O
on Approval for S.drift resolved granted:  S.approved := S.observed; S.drift := empty
on resolved denied/expired:               S.drift stays set (session remains escalated) until aide stops it
```

While `S.drift` is set, every T1 action of S is treated as T2 (protocols §14.5):
- **connects** (including model calls) fail with `kl:needs-approval:<S.drift>` (step 8a of §4.3.3);
- **reversible commits** require the same approval.

`aide` learns the drift from the `budget.charge` receipt and the approval request, writes `model.change` (writer aide, protocols §19.3) and shows it to the human. Local models are pinned by their weights generation and never drift. The `minVersion` of the template (protocols §6.4) is checked by broker when it mints the `model` fact; gate compares only identities.

### 4.14 Offline operation

- **Revocation age.** gate calls `Depot.revocationStatus()` (route `depot#user`, protocols §7.3.8) at start and every 10 min and computes `days = floor(ageSecs / 86 400)`; depot measures `ageSecs` of the newest verified list against trusted time, so gate does not parse revocation lists itself. Before the first trusted-time sync it uses the ledger time floor; if no list was ever available this boot it uses the value persisted in `/var/lib/keylos/gate/offline.json` from the previous boot, and with no value at all it assumes `thresholdDays + 1` (fail closed).
- **Ambient fact.** Every token authorization receives `offline_days(days)` (protocols §8.3), so owner policies can add checks such as `check if offline_days($d), $d <= 7`.
- **New-host rule.** When `days > offline.thresholdDays` (default 30), a connect by an agent principal to a host not present in the **host history** of its agent template requires a T2 approval (REQ-GATE-012). The history is `hosts.redb`: `(template generation name, host) → first-contact time`, written on every successful agent connect, never shrunk while offline, pruned of entries older than 180 days when online.
- **Status.** `gate status` and `GateLocalDebug.offline` show the revocation age, the list serial and whether the new-host rule is active.

### 4.15 Intents from the shell (`Gate.intent`)

`Gate.intent(id)` on facet `client` lets a human's shell (`kish effects commit|cancel|compensate|show`) operate intents staged by its own descendants:
1. Load the intent; if absent → `kl:not-found`.
2. Let `Cs` be the caller's session chain and `Ci` the intent subject's chain. If `Cs` is not a prefix of `Ci` → `kl:not-found` (REQ-GATE-038).
3. Return an `Intent` capability bound to that intent. `commit` on it behaves exactly as for the stager: approval through `requestFor` with the intent's subject as the subject (gate is the caller of `requestFor`; the subject is the session that staged, which is allowed by protocols §7.5.2), mandate verification, execution.

Agents never hold `gate#client` for their own humans' trees: agent principals are routed only to `aide#host`, and `aide` uses facet `aide`.

### 4.16 Durable effects (`DurableEffects`)

#### 4.16.1 Bindings and fencing

Every method that names an `AttemptBinding` runs:

```
fence(b):
  b.epoch < epochs[b.workflow]                         → kl:conflict ("stale epoch")
  r := verifyCache[b] (≤ 1 s old) or BrokerWorkflow.verify(b, <subject session or empty>) on broker#workflow
       kl:conflict / kl:revoked from broker          → same error
  epochs[b.workflow] := max(epochs[b.workflow], b.epoch)   (persisted with the operation's transaction)
```

The cache entry of a workflow is dropped on every `grant.revoke` receipt whose `refs.workflow` names it (ledger watch). On facets `client` and `aide` the token's `workflow($wf, $epoch)` fact must equal `(b.workflow, b.epoch)` in addition; a token without that fact can never prepare a durable effect.

#### 4.16.2 `prepare`

```
prepare(spec, token) on facet client|aide:
  1  subject := as §2.4; verify token (REQ-GATE-002); fence(spec.binding); token.workflow == (b.workflow, b.epoch)
  2  spec.intent.idempotencyKey MUST be empty (kl:invalid); spec.effect parses as fx-…
  3  stage checks of REQ-GATE-030 (kind, class, right effect/stage, payload); render (§4.6.7) and checkFlow (stage)
  4  rd := requestDigest(spec) (protocols §20.26)
  5  e := effects[spec.effect]:
        e exists ∧ e.request_digest == rd → return e        (idempotent; payload not copied again)
        e exists                          → kl:conflict
  6  owner := BrokerWorkflow.record(b.workflow).owner; encrypt payload under gate:<owner>:<wf>; strategy := §4.6.1
  7  one transaction: intent (Staged, subject = token principal), EffectRec{state: prepared, …}, effects_by_workflow, blob
  8  receipt effect.stage {intent, effect, workflow, kind, class, target, payloadDigest, requestDigest, strategy}; return record
```

The record is owned by the workflow: a later attempt (another session) looks it up, and loom commits it, without any relation to the preparing session.

#### 4.16.3 `commit`

```
commit(fx, b) on facet loom:
  1  e := effects[fx] ?→ kl:not-found; e.workflow == b.workflow ?→ kl:not-found; fence(b)
  2  e.state ∈ {authorized, dispatching, succeeded, failed, outcomeUnknown, cancelled, compensated} → continue at 6 (idempotent)
  3  d := BrokerWorkflow.authorizeEffect(b, fx, e.kind, e.target, e.payload_digest, renderings(e))
        d.state pending          → e.state := awaitingApproval, e.decision := d.id; receipt-free persist; return e
        d.state denied/expired   → e.state := cancelled, outcome {"reason": "decision-denied" | "decision-expired"};
                                   receipt effect.cancel; return e   (loom: commit outcome denied, protocols §20.26)
        kl:denied (policy)       → e.state := cancelled, outcome {"reason": "policy-denied"}; receipt effect.cancel; return e
  4  approved: d.mandate empty   → authorization by policy without approval (tier ≤ t1)
               else verify mandate (§4.7) ∧ constraints.workflow == e.workflow ∧ constraints.decision == d.id
               ∧ effects[].digest == payload digest; d.id ∉ decisions_used; mandate ∉ mandates_used (scope once)
  5  one transaction: e.state := authorized, e.epoch := b.epoch, decisions_used[d.id] := fx, mandates_used += digest
     receipt effect.commit {intent, effect, workflow, decision, mandateDigest, epoch, executor}  (meaning "authorized")
  6  caller-executed kind → return e (result = base64 mandate; completion through complete(), §4.16.5)
     else dispatch(e) (§4.16.4) unless already dispatching or terminal; return e when terminal or outcomeUnknown,
     or after 30 s with the current state (loom watches the record)
```

`autoCommitOnApproval` does not apply to durable effects: loom decides when to commit, and a commit after the decision is approved continues at step 4 with the same decision.

#### 4.16.4 Dispatch, crashes and lost replies

```
dispatch(e):
  persist e.state := dispatching, e.dispatched := e.dispatched or now, e.attempts += 1,
          e.dedup_until := (downstreamIdempotency) first dispatch + windowSecs
  run executor(e)                          # HTTP replay with Idempotency-Key: fx-…, SMTP with Message-ID, commitPrepared, …
     confirmed result → e.state := succeeded | failed; receipt effect.complete {effect, outcome, result digest}
     no confirmed result (timeout, connection loss, gate crash, 5xx without a body the executor documents as "not applied")
                      → recover(e)

recover(e):                                # also run for every dispatching record at start (§4.11)
  match e.strategy:
    transactional:          s := completion lookup (§4.6.1)  present → outcome;  absent → dispatch(e) again
    downstreamIdempotency:  now < e.dedup_until → dispatch(e) again (same key, same bytes)  else → unknown(e)
    reconciliation:         r := reconciler(e)  present → succeeded; authoritative absent → dispatch(e) again;
                                               indeterminate → unknown(e)
    noSafeRetry:            unknown(e)
unknown(e): e.state := outcomeUnknown, outcome {reason}; receipt effect.unknown {effect, reason, strategy}
```

Re-dispatches are bounded: at most `durable.maxDispatches` (default 5) per record with backoff 1 s → 5 min; after that the record becomes `outcomeUnknown`. A record in `outcomeUnknown` is never dispatched again by gate (REQ-GATE-077); `reconcile(fx)` runs the reconciler or completion lookup once more and may move it to `succeeded` or `failed`.

#### 4.16.5 Completion of caller-executed effects

The record stops at `authorized`; the stager performs the effect with the mandate from `IntentStatus.result`. `complete(fx, rcpt)` (facet `client`/`aide`, the preparing workflow's attempt): gate fetches the receipt (`Ledger.get` via its seq, or a `query` by digest), strips `clear` and verifies it (protocols §13.1, §13.4), requires `writer` = the kind's executor service (`bench` for `media.export`; `config` for `config.propose`; the device's owning service as configured for `device.actuate`), `data.effect` = fx and `data.payloadDigest` = the record's payload digest, then records `succeeded` (or `failed` when the receipt says so) and writes `effect.complete`. Without a valid receipt the record stays `authorized`; loom treats it as not completed.

#### 4.16.6 Lookup, cancel, resolve and forget

- `lookup`/`watch` read `effects` (facet `loom`: any workflow; facets `client`/`aide`: only when the caller presents, through a prior `prepare` in this connection or the binding of its token, the record's workflow; otherwise `kl:not-found`).
- `cancel(fx)`: `prepared` → `cancelled`; `awaitingApproval` → `cancelled` and the pending decision is abandoned (the broker cancels pending decisions of cancelled workflows itself); later states → unchanged record. Receipt `effect.cancel`.
- `resolve(fx, outcome, mandate)`: `outcomeUnknown` only; the mandate is verified as §4.7 with kind `workflow.decide`, target fx, digest = SHA-256 of the JCS `{"effect", "outcome"}`, `constraints.workflow` = the record's workflow, presence when the kind is irreversible; records `succeeded` or `failed`; receipt `effect.resolve`; never dispatches.
- `forget(wf)`: REQ-GATE-082; receipt-free beyond `effect.cancel` for the records it cancels.

### 4.17 Workflow budget accounts (`WorkflowBudget`)

```
reserve(ba, key, amount):  A := accounts[ba] ?→ kl:not-found; A.closed → kl:conflict
  A.entries[key] exists → return it (idempotent)
  ∀ unit: A.spent + A.reserved + A.unresolved + amount ≤ A.ceilings ?→ kl:budget
  A.entries[key] := reserved(amount); A.reserved += amount            (one transaction)
settle(ba, key, actual, outcome):
  reserved → settled(actual) (outcome "ok") | unresolved(amount) (outcome "unknown")
  unresolved → settled(actual)                                           (the one later settlement)
  settled with equal actual → return; otherwise kl:conflict
  receipt budget.settle {account, key, amount, outcome}
release(ba, key): reserved → released; other states unchanged (idempotent)
```

Metered model requests (§4.9) of a token with `budget_account(ba)` reserve on the account with key `<wa-…>:<n>` (the attempt from the token's workflow binding, n = gate's per-attempt request counter, persisted) in the same transaction as the root-meter reservation, and settle it on completion. When an attempt's roots are revoked, its open reservations become `unresolved` (REQ-GATE-087). `open` and `close` come from the broker (enrollment approval, terminal workflow); `close` refuses new reservations and keeps the spent and unresolved amounts. `status` returns ceilings, reserved, spent and unresolved per unit.

### 4.18 Rollback detection of gate's durable records

gate anchors `effects`, `decisions_used` and `accounts` against its own receipts (protocols §20.25 "Rollback detection"): `anchor` holds the ledger `seq` of gate's newest acknowledged durable-effect or budget receipt (`effect.*` and `budget.*` naming a workflow). At start gate appends no receipt until it has run `Ledger.query(principalPrefix "service:gate:", fromSeq = anchor + 1, eventTypes = effect.* ∪ budget.*)`; a receipt naming a workflow that the store does not reflect (an effect state or a budget settlement newer than the record) means an older store was restored. gate then refuses `commit`, `prepare` and `reserve` with `kl:unavailable` (`rollback-review`), re-applies what the receipts prove (authorized, completed, unknown and cancelled effects; settled amounts; consumed decisions), marks records it cannot reconstruct `outcomeUnknown`, and resumes only after the owner's `gate rollback accept` (presence purpose `loom.rollback-accept`, which loom's acceptance also satisfies). Effect IDs proven authorized are never authorized again.

---

## 5. Interfaces

### 5.1 Facets served

The facets and their methods are those of protocols §19.2 (embedded in §2.3.25). gate-specific clarifications:

| Facet | Clarification |
|---|---|
| `client` | `DurableEffects.prepare`, `complete`, `lookup`, `watch` via `Extensible.ext` for attempt sessions of a workflow (token with a `workflow` fact, §4.16); `connect` (tiers 0/1 only; shimmed principals use `shim`), `stage` for the caller's own session, `intents` for the caller's session tree, recursively (every descendant session, protocols §7.3.7), `intent` for intents of the caller's session tree (§4.15), `meter` for root IDs present in tokens the caller presents. Holders include `portal-files` and `atrium`, which stage `media.export` on behalf of the requesting app |
| `broker` | `connect` and `stage` with the presented token's `principal` as subject; `GateMeterAdmin` via `Extensible.ext` (§4.12); `WorkflowBudget.open`, `close`, `status` via `Extensible.ext` (§4.17) |
| `shim` | `ShimEndpoint`, bound to the route's principal |
| `meter` | `charge`, `meter` |
| `aide` | `connect` with the agent session token; `stage` with `x-subject-token`; `intents`, `meter`, `charge` for sessions whose tokens aide presents; `DurableEffects.prepare`, `complete`, `lookup`, `watch` and `WorkflowBudget.reserve`, `settle`, `release`, `status` for agent attempt sessions (the attempt token as `token`) |
| `admin` | `intents`, `meter` for any session; `GateAdmin` via `Extensible.ext` |
| `loom` | `DurableEffects` (`commit`, `lookup`, `watch`, `cancel`, `reconcile`, `resolve`, `forget`) and `WorkflowBudget` (`reserve`, `settle`, `release`, `status`) as the facet's interfaces (protocols §7.5.25); holder `loom` only |
| `debug` | `GateDebug` (protocols §7.5.12) as the bootstrap interface; `GateLocalDebug` via `Extensible.ext` |

### 5.2 CLI: `gate`

The CLI uses the shell's routes (`gate#admin` and `gate#debug` for the owner, `gate#client` otherwise). Output is records (cmdsig `records`) or text.

| Command | Description | Exit codes |
|---|---|---|
| `gate status [--session S] [--json]` | Connection counts, intercepted hosts, captive state, meter summary | 0, 2 |
| `gate connections [--session S] [--principal P]` | Live connections: id, principal, host, port, mode, bytes, opened | 0, 2 |
| `gate intents [--session S] [--state STATE] [--all]` | Lists intents | 0, 2 |
| `gate intents show <e-id> [--payload]` | Rendering, args with provenance, state history, result. `--payload` writes the payload (owner only; credentials never included) | 0, 1 not found, 2 |
| `gate intents commit <e-id> [--no-wait]` | Commits; waits for approval unless `--no-wait` | 0 committed, 3 pending, 4 denied, 5 failed |
| `gate intents cancel <e-id>` | | 0, 1, 2 |
| `gate intents compensate <e-id>` | Runs the compensator (`fs.merge`: `Strata.undo`; `net.listen`: close the port) | 0, 5 failed, 6 unsupported (caller-executed kinds) |
| `gate meter [<t-root>] [--session S] [--tree]` | Spent, reserved, remaining per unit; `--tree` shows carved sub-meters (owner) | 0, 2 |
| `gate drift [--session S]` | Expected, approved and observed model identities; pending `model.change` approvals | 0 |
| `gate offline` | Revocation age, list serial, whether the new-host rule is active | 0, 1 rule active |
| `gate kinds` | Effective effect-kind registry, including each executor's retry strategy | 0 |
| `gate effects [--workflow wf-…] [--state STATE]` | Durable effect records: effect, workflow, kind, state, strategy, decision, `dedupUntil`, `retainUntil` (owner: all; others: own workflows) | 0, 2 |
| `gate effects show <fx-…>` | One record with its receipts and outcome | 0, 1 not found, 2 |
| `gate accounts [<ba-…>]` | Workflow budget accounts: ceilings, reserved, spent, unresolved | 0, 2 |
| `gate rollback accept` | After §4.18 detection: presence-confirmed acceptance of the reconciled state | 0, 3 refused |
| `gate ca --session S` | Session CA PEM (public) | 0, 1 |
| `gate listen` | Active listening sockets | 0 |
| `gate test-connect <host> <port> [--https] [--method M]` | Dry-run authorization with the caller's tokens; no socket | 0 allowed, 3 needs approval, 4 denied |

All commands accept `--format text|json|records`. Exit code 2 is a usage or transport error.

### 5.3 Files and sockets

| Path | Purpose |
|---|---|
| `/var/lib/keylos/gate/outbox.redb` | Outbox; durable effect records (`effects`, `effects_by_workflow`, `decisions_used`, `epochs`, `anchor`) |
| `/var/lib/keylos/gate/blobs/` | Encrypted payloads |
| `/var/lib/keylos/gate/meter.redb` | Meter accounts and the sub-meter tree (current boot; persistent-grant accounts carried over by root grant ID); table `accounts`: durable workflow budget accounts (§4.17, kept across boots) |
| `/var/lib/keylos/gate/hosts.redb` | Per-template host history (§4.14) |
| `/var/lib/keylos/gate/models.redb` | `SessionModelState` per session (§4.13) |
| `/var/lib/keylos/gate/offline.json` | Last known revocation list serial and `issued` time |
| `/var/lib/keylos/gate/cursors.json` | Ledger watch cursors |
| `/etc/keylos/gate/gate.json` | Rendered config |
| `/run/keylos/svc/gate/` | Service sockets (warden) |
| `/run/keylos/boot/trust.json` | Boot trust set (read-only, protocols §10.7) |
| Tier-L views: `/run/keylos/tokens/*.biscuit`, `/run/keylos/gate/ca.pem`, `/run/keylos/ssh-agent.sock` | Shim inputs and outputs (`ca.pem` registered in protocols §10.7) |

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| Prompt-injected agent exfiltrates private data to an attacker host | Hosts must be granted (REQ-GATE-002); `checkFlow` blocks X for U ∧ P sessions (REQ-GATE-020); DNS only for granted names (REQ-GATE-006); covert-channel limits (§4.8) |
| Exfiltration via an allowed host that accepts user content (issues, gists, registries) | Unsafe methods become intents (REQ-GATE-034); the human sees the rendered payload with provenance; safe-method size and entropy limits |
| Token theft or replay by another principal | Tokens carry `principal`/`session` facts; gate binds the subject to the capwire peer (`ServiceHost.accept` identity), broker, or the shim endpoint's bound principal (REQ-GATE-010) |
| Credential theft by the agent | Credentials never enter the subject (REQ-GATE-050); client-supplied auth headers to injection hosts are rejected (REQ-GATE-052) |
| Request smuggling to carry an injected header to an unintended path | Injection happens per request after strict parsing and path normalization (§4.4) |
| DNS rebinding to LAN or local services | Address safety rules (§4.3.3) |
| Payload swapped between approval and execution | Mandate digest bound to the payload; blobs immutable, content-addressed, encrypted (§4.6.5, §4.7) |
| Replay of a once-mandate | `mandates_used` (§4.7 step 6) |
| Forged mandate | Presence mandates verified against the owner registry (from hearth, cross-checked with the boot trust set); non-presence mandates must carry a valid `service/broker` signature (§4.7) |
| Budget amplification through sub-agent fan-out | Hard sub-meters: every child charge also charges each ancestor; carve refused above the parent's remainder (§4.12) |
| Provider silently swaps the model behind an agent session | Model identity recorded per response; drift escalates T1 to T2 until the human re-approves (§4.13) |
| Stale revocations while offline | Revocation-age rules: new hosts for agents need T2 after 30 days; `offline_days` available to policy (§4.14) |
| Pod workload exfiltrates when egress via gate is required | Pod shims refuse flows without a nameable granted destination (REQ-GATE-011); pod tokens come only from broker policy |
| Shell commits another principal's intent | `Gate.intent` returns only intents of the caller's own session tree (REQ-GATE-038) |
| Caller-executed effect replayed with an old mandate | Mandates bound to the payload digest and recorded as used at commit (§4.6.8) |
| A workflow effect executed twice after a crash or lost reply | One record per effect ID; dispatch only as the declared strategy allows; otherwise `outcomeUnknown` (REQ-GATE-077) |
| A stale attempt or coordinator commits or prepares | Epoch fencing against the token fact, gate's high-water mark and `BrokerWorkflow.verify` (REQ-GATE-080) |
| Payload swapped under an existing effect ID | `requestDigest` binding, `kl:conflict` (REQ-GATE-073) |
| A durable approval used twice | `decisions_used` and `mandates_used` consumed atomically with `authorized` (REQ-GATE-075) |
| Budget reset by fresh roots after a reboot | Workflow accounts keyed by `ba-…`, not by roots (REQ-GATE-084) |
| Older gate store restored to repeat effects or refund budgets | Ledger-anchored rollback detection (§4.18) |
| A destination that ignores `Idempotency-Key` duplicates on retry | `downstreamIdempotency` only for destinations configured `verified`; otherwise reconciliation or `outcomeUnknown` |
| Compromised TLS/HTTP parser | Per-session `gate-tls` with no network, no other sessions' keys, minimal seccomp |
| Interception CA abused for other hosts | `nameConstraints`; CA public part only in that session's view; short validity |
| Malicious renderer component | Pulley interpreter, fuel and memory limits, no imports, output sanitized (§4.6.7) |
| Budget runaway | Hard pre-authorization (REQ-GATE-040); `budget.exhausted` stops spending; aide breakers |
| Captive-portal network attack | All non-captive egress paused while captive (§4.3.7) |
| gate itself compromised | It holds no long-term credentials (vault keeps them; handles are scoped and short-lived), cannot mint tokens or sign mandates, cannot merge without bench verifying the mandate, and every action is receipted and countersigned by the ledger |

### 6.2 Residual risks

- **Timing channels** and low-bandwidth encoding in allowed requests to sink-safe hosts remain.
- **Opaque TLS to granted non-intercepted hosts:** gate sees only the host. Such grants are shown at consent time as "all traffic to host".
- **Implicit-intent semantics** (HTTP 428) can confuse non-agent clients; policy gives tier-1 apps commit rights for their declared effects.
- **Listening sockets** already passed to a principal remain usable until broker terminates or freezes the holder.
- **Non-presence mandates** rely on broker's verification of the approver signature (gate does not hold approver keys); gate verifies broker's re-signature.
- **Caller-executed effects** (`media.export`, `device.actuate`) depend on the device side verifying the mandate; gate only decides and records.
- **Model drift detection** depends on providers reporting an identity; a provider that hides changes behind a stable ID is not detected.
- **Downstream idempotency** rests on the owner's `verified` destination configuration and the provider's documented window; a provider that silently breaks its contract can still duplicate within the window.
- **Reconcilers** are only as authoritative as the destination's read API; when it is not, the effect ends `outcomeUnknown` and needs a human.

### 6.3 Confinement of gate itself

| Aspect | `gate-core` | `gate-net` | `gate-tls` | `gate-render` |
|---|---|---|---|---|
| Tier | t0 | t0 | t0 | t0 |
| UID | dynamic | dynamic | dynamic per instance | dynamic |
| Network namespace | private (`lo` only) | **host** (`network: "host"` in the service manifest) | private | private |
| Capabilities | none | `CAP_NET_BIND_SERVICE` only if `listenPorts` contains ports < 1024 | none | none |
| Landlock fs | rw `/var/lib/keylos/gate`; ro `/run/keylos/boot/trust.json`, own generation | ro own generation | ro own generation | ro own generation and renderer `data` generations |
| Landlock net (KL3) | none | connect: any; bind: `listenPorts` | none | none |
| seccomp beyond baseline | none | `socket(AF_INET/AF_INET6, SOCK_STREAM/SOCK_DGRAM)`, allowlisted `setsockopt`, `splice`, `tee` | none | none |
| JIT | no | no | no | no (Pulley) |
| Routes | §2.2 | gate-core only | gate-core only | gate-core only |

`net`'s firewall allows outbound inet traffic from host-netns sockets only for UIDs `warden` publishes with `NetPlumbing.setEgressUids`; `gate-net`'s UID is one of them.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| `gate-core` crash | warden restarts it within 1 s. Relays in `gate-net` keep flowing. In-flight capwire calls fail with `disconnected`; clients retry. Recovery per §4.11 |
| `gate-net` crash | All relayed, terminated and intercepted connections drop; warden restarts it; listening sockets already handed out keep working; gate-core re-binds its dups from `FdStore` |
| `gate-tls` crash | Affects one session; respawned on the next connect. The session CA is restored from `FdStore` |
| `gate-render` crash or timeout | Rendering falls back to the canonical-text renderer with a warning (REQ-GATE-037); if that cannot present every required detail (payload over the limits), no approval is possible and the intent expires (REQ-GATE-046) |
| broker unavailable | No new connects or stages (`kl:unavailable`); existing connections continue; revocation fails closed after 1 s |
| vault unavailable | Requests needing injection fail with `503` + `kl:unavailable` |
| ledger unavailable | No irreversible commits (`kl:unavailable`); receipts for reversible traffic buffered in memory (≤ 10 000, then new connects refused) |
| net resolver unavailable | `kl:unavailable` for name targets; IP-literal grants work |
| Clock untrusted | Expiry checked against the ledger time floor; mandate `expires` checks fail closed until trusted |
| Disk full | `stage` fails with `kl:unavailable`; connects continue |
| Executor failure (5xx on replay) | Intent `Failed`; a retry needs a new commit, reusing the mandate only if `scope != once` |
| bench unavailable during `fs.merge` | Intent stays `Approved`; commit retried with backoff for 10 min, then `Failed` (safe: `commitShare` is idempotent per manifest digest) |
| hearth unavailable | Presence mandates verified against the cached registry for ≤ 60 s, then commits needing presence fail `kl:unavailable` |
| strata unavailable during compensation | `fs.merge` compensation retried for 10 min, then the intent stays `Committed` with the error in `result` |
| depot unavailable | Revocation age from the last known value (§4.14); without one, the new-host rule is active |
| Crash or lost executor reply during a durable effect's `dispatching` | Continues per its strategy on restart (§4.16.4); never a blind repeat |
| `BrokerWorkflow` unavailable | `prepare` and `commit` of durable effects fail `kl:unavailable`; `lookup`, `watch` and dispatch of already `authorized` records continue |
| Effect or account store behind the ledger at start | Rollback review (§4.18): no new authorizations, dispatches or reservations until accepted |
| Destination's dedup window elapsed while gate was down | The record becomes `outcomeUnknown` (REQ-GATE-077) |
| broker key not yet pinned (no `ledger.key.register` seen) | Non-presence mandates cannot be verified; commits needing them fail `kl:unavailable` until the receipt is seen |

---

## 8. Performance budgets

| Metric | Budget |
|---|---|
| `connect` overhead (token verify + checks + label + cached resolve), p50 / p99 | ≤ 0.5 ms / 3 ms excluding upstream RTT and `checkFlow` for non-sink-safe hosts |
| `checkFlow` round trip (local broker) | ≤ 1 ms p99 |
| Relayed throughput per connection | ≥ 95% of line rate on 10 GbE |
| Intercepted/terminated HTTPS throughput | ≥ 500 MB/s per connection; added latency ≤ 1 ms p50 |
| Concurrent connections | ≥ 50 000 total; ≥ 4 096 per session |
| `stage` latency (≤ 1 MiB payload, fsync) | ≤ 10 ms p99 on NVMe |
| Renderer | ≤ 50 ms p99 built-in; ≤ 2 s hard limit for components |
| `carve` / charge along a 4-level sub-meter path | ≤ 1 ms p99 (one redb transaction) |
| Model identity extraction | ≤ 50 µs per response |
| Memory | gate-core ≤ 64 MiB + 2 KiB per connection; gate-tls ≤ 32 MiB per process; gate-render ≤ 96 MiB |

---

## 9. Observability

**Logs** (journal, structured): info — startup, config load, CA generation (no key material); notice — each denied connect (subject, host, reason code); warning — Rule-of-Two blocks, budget exhaustion, interception failures, renderer fallbacks; err — executor failures.

**Receipts** (protocols §19.3, writer `gate`):

| Event | `data` |
|---|---|
| `net.connect` | `{conn, host, port, proto, mode, intercepted, rootId, label}` |
| `net.listen` | `{addr, port, proto, rootId}` |
| `effect.stage` | `{intent, kind, class, target, payloadDigest, implicit, args:[{name, source, label}]}` |
| `effect.commit` | `{intent, mandateDigest, channel, resultSummary, transaction?}` |
| `effect.fail`, `effect.cancel` | `{intent, reason}` |
| `effect.compensate` | `{intent, via: "executor"|"strata", result}` |
| `budget.charge` | `{rootId, session, unit, amount, reason}` (one per model request; other charges aggregated per minute per account) |
| `budget.exhausted` | `{rootId, session, unit, ceiling, spent}` |
| `budget.carve` | `{parentRoot, childRoot, budget}` |
| `effect.complete` | `{effect, workflow, intent, outcome, resultDigest, via: "executor"\|"lookup"\|"reconcile"\|"caller"}` |
| `effect.unknown` | `{effect, workflow, intent, strategy, reason}` |
| `effect.resolve` | `{effect, workflow, outcome, mandateDigest}` |
| `budget.open`, `budget.close` | `{account, workflow, ceilings}` |
| `budget.settle` | `{account, workflow, key, amount, outcome}` |

`budget.charge` for model requests carries `data.model = {provider, model, version}` and, when drift was detected, `data.drift = {expected, observed, approval}`. `effect.*` receipts for `net.listen`, `media.export` and `config.propose` intents use the same shapes as other kinds; caller-executed commits have `data.executor = "caller"`. Receipts of durable effects additionally carry `data.effect`, `data.workflow` and, where they exist, `data.decision`, `data.account` (copied into clear `refs` by the ledger, protocols §13.4); `effect.commit` of a durable effect means "authorized" for every kind.

**Metrics** (`GateLocalDebug.metrics`, and `0x1F` metrics records to the journal): `gate_connections_active{mode}`, `gate_connect_total{result}`, `gate_connect_latency_seconds`, `gate_bytes_total{direction}`, `gate_intents{state,kind}`, `gate_budget_remaining{unit}` (top 100 accounts), `gate_submeters_active`, `gate_rule_of_two_blocks_total`, `gate_covert_limit_hits_total{limit}`, `gate_tls_intercepted_total`, `gate_render_fallback_total`, `gate_model_drift_sessions`, `gate_offline_days`, `gate_pod_shim_flows_total{result}`.

---

## 10. Configuration

`/etc/keylos/gate/gate.json`, rendered by `config` from the Nickel module below. Policy facts (sink-safe and trusted hosts, effect class overrides, flow-proof runtimes) come from the active `policy` generation through broker, not from this file.

```nickel
# module keylos.gate → /etc/keylos/gate/gate.json
{
  gate | {
    localNetworks | Array String | default = [],                     # CIDRs reachable when granted by literal
    maxBodyBytes | Number | default = 67108864,
    interception | {
      leafValidityMins | Number | default = 60,
      caMaxValidityHours | Number | default = 24,
    } | default = {},
    extraRoots | Array String | default = [],                        # PEM paths in the config generation
    pins | Array { host | String, spkiSha256 | Array String } | default = [],
    injection | Array {
      name | String,
      vaultItem | String | optional,                                 # absent for 'fleet-compliance
      host | String,
      pathPrefix | String | default = "/",
      kind | [| 'header, 'query, 'basic, 'aws-sigv4, 'oauth-exchange, 'fleet-compliance, 'ssh, 'git-signing |] | default = 'header,
      header | String | default = "Authorization",
      template | String | default = "Bearer {{secret}}",
      param | String | optional,
      user | String | optional,
      principals | Array String | default = ["agent:*", "bench:*", "legacy:*"],
      methods | Array String | default = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
      stripClientHeaders | Array String | default = ["Authorization", "Cookie", "Proxy-Authorization"],
      region | String | optional,
      service | String | optional,
      oauth | { tokenEndpoint | String, audience | String, scopes | Array String } | optional,
    } | default = [],
    modelProviders | Array {
      adapter | [| 'anthropic, 'openai, 'google, 'openai-compatible, 'bedrock |],
      provider | String,                                             # matches agent template models[].provider
      hosts | Array String,
      defaultMaxTokens | Number | default = 8192,
      versionHeader | String | optional,                             # response header carrying a version (§4.13)
      prices | { _ : { inPerMTokUsdMicro | Number, outPerMTokUsdMicro | Number,
                       cacheReadPerMTokUsdMicro | Number | default = 0,
                       cacheWritePerMTokUsdMicro | Number | default = 0 } },
    } | default = [],
    effectKinds | Array { kind | String, class | [| 'reversible, 'compensable, 'irreversible |],
                          match | { method | String, host | String, path | String } | optional,
                          renderer | String | default = "http",                # built-in name or "gen:fsv256:…" renderer component
                          compensator | String | optional,
                          dataFields | Array String | default = [],
                          controlFields | Array String | default = [],
                          strategy | [| 'transactional, 'reconciliation, 'noSafeRetry |] | default = 'noSafeRetry,
                          reconciler | String | optional } | default = [],       # built-in reconciler name ("git-ref", "pr-search", "imap-message-id")
    destinations | Array {                                           # durable-effect strategies of HTTP replay (§4.6.1)
      host | String, pathPrefix | String | default = "/",
      idempotency | { verified | Bool | default = false,             # destination enforces Idempotency-Key + payload identity
                      header | String | default = "Idempotency-Key",
                      windowSecs | Number } | optional,
      consistency | [| 'eventual, 'strong |] | default = 'eventual,  # read-after-write guarantee of its lookup API (reconcilers)
    } | default = [],
    durable | { maxDispatches | Number | default = 5,
                minRetainDays | Number | default = 30 } | default = {},
    covert | {
      urlMax | Number | default = 512, queryMax | Number | default = 256,
      queryEntropyBitsPerByte | Number | default = 4.5,
      clientHeaderBytesMax | Number | default = 1024,
      newHostsPerMinute | Number | default = 10, requestsPerHostPerMinute | Number | default = 120,
    } | default = {},
    receipts | { sampleOneIn | Number | default = 100 } | default = {},
    retention | { committedDays | Number | default = 30, canceledDays | Number | default = 7 } | default = {},
    autoCommitOnApproval | Bool | default = true,
    offline | { thresholdDays | Number | default = 30, refreshMinutes | Number | default = 10 } | default = {},
    pods | {
      shimEnabled | Bool | default = true,                           # honoured only when cluster.egressViaGate = true
      maxPeekBytes | Number | default = 16384,
    } | default = {},
  }
}
```

Listening ports are configured in `net` (`net.firewall.listenPorts`); gate reads the effective set from `NetWatch` status.

**Validation** (by `config` before signing):
- Raising any `covert.*` value above its default, adding `localNetworks`, or adding injection rules whose `principals` include `app:*` is flagged as a capability change requiring T3.
- Injection rules MUST NOT target hosts that the same principals are granted opaquely.
- Raising `offline.thresholdDays` above 30 is a capability change requiring T3; lowering it is allowed.
- Every `modelProviders[].provider` MUST be unique; agent templates naming an unknown provider fail at session start (aide).
- Setting `destinations[].idempotency.verified = true` or `consistency = 'strong` is a capability change requiring T3 (it permits automatic re-dispatch); `windowSecs` is required with `verified`.

---

## 11. Testing and acceptance

### 11.1 Unit

- Biscuit authorization with the protocols `vectors/biscuit/` suite and gate's ambient facts.
- Mandate verification: valid presence (ES256, EdDSA); wrong rpId; removed credential; wrong digest; non-JCS payload; expired; once-scope reuse; `x-mandate` without presence.
- HTTP normalization and smuggling corpora.
- Effect kind matching and class computation including `classRules`.
- Meter arithmetic: hard sub-meters across ancestors, carve refusal at the remainder, release, overrun bound, freeze on revoke.
- Model identity extraction per adapter (golden responses); drift decision table.
- Revocation-age computation with untrusted time, ledger floor and persisted value.
- Mandate verification: broker re-signed mandates, quorum envelopes (distinct owners), wrong signer kinds.
- `requestDigest` against the protocols `vectors/workflow/` cases; strategy selection per kind and destination; the §4.16.4 recovery table for every strategy and every crash point; `WorkflowBudget` transitions (idempotent reserve, single settle, unresolved, release).

### 11.2 Fuzz targets (≥ 1 CPU-hour each per release)

`fuzz_clienthello`, `fuzz_pod_shim_peek`, `fuzz_owner_registry_replay`, `fuzz_http1_request`, `fuzz_h2_frames`, `fuzz_receive_pack`, `fuzz_rfc5322`, `fuzz_sse_usage` (each adapter), `fuzz_socks5`, `fuzz_dns_wire`, `fuzz_mandate_dsse`, `fuzz_capwire_fd_indices` (via keylos-capwire).

### 11.3 Integration (VM harness with real warden, broker, vault, ledger, net, bench)

| ID | Scenario | Expected |
|---|---|---|
| IT-1 | Tier-1 app with `net("example.org",443,"https","*")` | Connects; `evil.org` → `kl:denied`; `ShimEndpoint.resolve("evil.org")` from a tier-L view → REFUSED |
| IT-2 | Agent session U ∧ P connects to a non-sink-safe host | `checkFlow` pending → `kl:needs-approval`; T3 declassification prompt |
| IT-3 | Agent (VM via bench-net) with `stage` not `commit` on `git.push` runs `git push` | 428 + `Keylos-Intent`; rendered ref updates; approve → replay succeeds; second commit → same result |
| IT-4 | Approved email intent; tamper the blob on disk | Commit fails `kl:integrity` |
| IT-5 | Budget `usd-micro:1000000`; agent streams a long completion | Stream ended with `keylos_budget_exhausted`; overrun ≤ one response; `budget.exhausted` receipt |
| IT-6 | Injection rule for api.github.com; client sends `Authorization` | 403 `kl:denied`; without it upstream sees the injected header; guest memory dump contains no token |
| IT-7 | SSH signing via `ShimEndpoint.sshAgent` after connect to github.com:22 | Works; without the preceding connect → refused; `git-signing` key used for userauth → refused |
| IT-8 | Revoke a root ID mid-transfer | Connection closed ≤ 100 ms; staged intents canceled; listener closed and port removed via `setListenPorts` |
| IT-9 | Granted host resolves to 192.168.1.10 | Refused |
| IT-10 | Crash gate-core during `Committing` of a non-idempotent executor | Intent `Failed` "outcome unknown"; no second execution |
| IT-11 | Interception disclosure | `GateDebug.interception` (protocols §7.5.12) lists the host; warden's confinement report shows `tlsInterception.active = true` |
| IT-12 | camel/1 flow proof for an email (recipient from user, body untrusted) | `checkFlow` waives declassification; mandate still required |
| IT-13 | Native tier-1 app with a method-filtered grant uses `keylos-gate-client` | Terminated mode; POST staged as implicit intent; GET passes |
| IT-14 | `listen:[::]` TCP 8443 with bind right and port in `listenPorts` | `net.listen` intent staged; T2 approval; then listening fd returned, `effect.commit` and `net.listen` receipts; `listen:127.0.0.1` binds without an intent; port 9999 not in config → `kl:denied`; `compensate` removes the port from `setListenPorts` |
| IT-15 | Captive network | Non-captive connects `kl:unavailable`; captive token from a tier-2 VM admitted; after `captive=false` normal connects resume |
| IT-16 | `fs.merge` approved; `gate intents compensate` | gate calls `Strata.undo` on `strata#gate`; intent `Compensated` with `via = "executor"`; a second merge undone by the human with `strata undo` → `Compensated` with `via = "strata"` |
| IT-17 | Renderer component exceeding fuel | Canonical-text rendering (`review = required`, `payloadDigest` = payload digest) with warning; `gate_render_fallback_total` increments |
| IT-18 | kish (shell of alice) calls `Gate.intent` for an intent staged by its child; then for an intent of bob's agent | First returns an `Intent`, commit works after approval; second → `kl:not-found` |
| IT-19 | broker carves 3 children of 2 USD from a 5 USD parent | Third carve → `kl:budget`; a child spending 2 USD also reduces the parent's remaining by 2 USD; revoking the parent freezes the children |
| IT-20 | Fake provider switches `model` from `m-2026-08` to `m-2026-10` mid-session | `budget.charge` shows drift; next connect → `kl:needs-approval`; after the human approves, connects resume; denial keeps the session escalated |
| IT-21 | Revocation list `issued` 40 days before trusted time | Agent connect to a host never contacted by its template → T2 approval; a previously contacted host connects; `offline_days(40)` visible to a policy check |
| IT-22 | Non-presence mandate tampered after broker re-signing; mandate signed by the atrium approver key instead of broker | Both rejected `kl:integrity`; an untampered broker-signed mandate is accepted after a gate restart |
| IT-23 | `media.export` staged by portal-files with a 4 MiB file | Commit returns `IntentStatus.result` = base64 mandate (decodes to a DSSE envelope bound to the payload digest); `effect.commit` has `data.executor = "caller"`; bench's `MediaBrowser.export` accepts it once; reuse for a second intent → `kl:denied` |
| IT-24 | `server-k8s` with `cluster.egressViaGate`; sealed pod curls a granted host and an ungranted IP | Granted host via SNI passes through the pod shim; ungranted IP refused; in-cluster traffic never reaches gate |
| IT-25 | Restart broker so it registers a new service key; then commit an intent with a non-presence mandate | gate re-queries `Ledger.serviceKey("broker")` after the `ledger.key.register` receipt; mandate signed by the new key accepted; by the old key rejected `kl:integrity` |
| IT-26 | App with `needs.listen` scope `lan` binds `0.0.0.0:8080`; another with scope `any` binds `:9090` | After the `net.listen` approvals, net receives `setListenPorts([], [], [{8080,tcp,lan},{9090,tcp,any}])`; LAN peer reaches 8080, WAN-side peer reaches only 9090 |
| IT-27 | kish job tree three levels deep; grandchild stages an intent | `Gate.intents(<kish session>)` on `client` lists it; `intents(<unrelated session>)` returns empty |
| IT-28 | Model drift on an agent session | Approval request carries `ResourceRef.model`; Cedar `use` on `Model` evaluated; token with only a `model` right cannot `connect` |
| IT-29 | Headless `server` profile, threshold 2: quorum mandate with 2 owner signatures, then with 1 | First commit accepted (`channel: quorum`); second rejected `kl:integrity` |
| IT-30 | Required details: an `email.send` with a 2 MiB text attachment, a `x-…` kind whose renderer component omits a control field, and an `http.post` with a 20 MiB body | Every rendering carries `review` and `payloadDigest`; the component case adds a required canonical-text rendering; the 20 MiB case has no complete required rendering, so `checkFlow`/approval never yields a mandate and the intent expires `Canceled`; no stager-supplied arg can set `decorative` |
| IT-31 | `fs.merge` staged with the prepared-merge digest; a host edit makes the prepared merge stale before commit | `commitShare` returns `kl:conflict`; intent `Failed` (`stale; re-prepare`); a mandate for the old digest is refused for the re-prepared intent |
| IT-32 | Durable `http.post` to a `verified` destination (test server honouring keys for 600 s); drop gate's reply after the server applied it; loom commits again | Same record; re-dispatch with the same `Idempotency-Key`; server applied once; `succeeded`; one `effect.commit`, one `effect.complete` |
| IT-33 | Same as IT-32 against a destination that ignores the header and is not `verified` | Strategy `noSafeRetry`; after the lost reply the record is `outcomeUnknown` (`effect.unknown`); no second request reaches the server; `Workflow.resolve` with a `workflow.decide` mandate records `succeeded` without dispatch |
| IT-34 | `verified` destination with `windowSecs = 60`; kill gate in `dispatching`; restart after 120 s | `outcomeUnknown`; no request after the window |
| IT-35 | `git.push` durable effect; kill gate-core after the remote accepted the push | `git-ref` reconciler finds the new OID; `succeeded`; no second push. Variant: the push never left gate → reconciler finds the old OID → one re-dispatch |
| IT-36 | `fs.merge` durable effect committed through `commitPrepared`; kill gate after bench committed, before the reply | `preparedStatus` = `committed`; `succeeded` with the stored transaction; strata commits once |
| IT-37 | Attempt epoch 3 prepares; loom claims epoch 4; the epoch-3 attempt calls `prepare` and loom-at-epoch-3 calls `commit` | Both `kl:conflict`; the epoch-4 commit proceeds |
| IT-38 | `prepare` the same `fx-` twice with equal requests, then with a different payload | First: same record; second: `kl:conflict`, payload unchanged |
| IT-39 | Durable decision approved; two effects present the same decision; gate killed between consumption and dispatch | Second effect `kl:denied`; after restart the first continues from `authorized` (no second consumption, no second prompt) |
| IT-40 | Caller-executed `media.export` durable effect: commit, then `complete` with bench's `media.export` receipt, then with a forged receipt | Record `authorized` until `complete`; valid receipt → `succeeded`; forged or foreign-writer receipt → `kl:integrity`, still `authorized` |
| IT-41 | Workflow account 1 USD; attempt reserves 0.4 USD for a model call; kill gate before settle; fence the attempt; new attempt reserves; `settle` the first key twice | First reservation `unresolved` and counted; new attempt can reserve only 0.6; first settle applies once, the repeat with equal values returns the entry, a different value `kl:conflict`; spent never decreases across a reboot with new roots |
| IT-42 | Restore an older `outbox.redb` and `meter.redb` after an effect was authorized and a charge settled | Rollback review: commits refused; the authorized effect is not authorized again; the settled amount is restored from receipts; resumes after acceptance |
| IT-43 | `forget` a workflow with one `prepared` and one `succeeded` effect | Prepared → `cancelled`; unit `gate:<owner>:<wf>` forgotten; both records kept minimal; `lookup` still answers; payload unreadable |


### 11.4 Conformance

gate MUST pass protocols `vectors/biscuit`, `vectors/labels`, `vectors/presence`, `vectors/workflow` (effect IDs, request digests), `vectors/receipts` (as writer), `vectors/capwire` (including the vsock profile cases it relays through bench), `vectors/fsmerge` and `vectors/flowproof` (parsing).

### 11.5 Acceptance criteria

IT-1…IT-43 pass on KL1 and KL3 kernels (IT-32…IT-43 with real `loom` and `broker`, protocols §17 INV-8…INV-12); §8 budgets met on the reference hardware (8-core x86-64, NVMe, 10 GbE); zero open fuzz crashes.

---

## 12. Implementation notes

### 12.1 Crates (Rust, edition 2024)

| Crate | Use |
|---|---|
| `tokio` 1.x | Async runtime |
| `capnp` 0.20, `capnp-rpc` 0.20 | Via `keylos-capwire` |
| `biscuit-auth` 5.x | Via `keylos-biscuit` |
| `rustls` 0.23, `tokio-rustls` 0.26, `rustls-native-certs` | TLS |
| `rcgen` 0.13 | Session CA and leaves |
| `hyper` 1.x, `hyper-util`, `http-body-util`, `h2` 0.4 | HTTP |
| `hickory-proto` 0.24 | DNS wire format |
| `redb` 2.x | Outbox and meter |
| `lettre` 0.11 | SMTP executor |
| `gix` (pack parsing) | git renderer |
| `mail-parser` 0.9 | RFC 5322 renderer |
| `aws-sigv4` 1.x | SigV4 injection |
| `ssh-key` 0.6, `ssh-encoding` | SSH agent protocol |
| `wasmtime` (with the Pulley interpreter feature and component model) | `gate-render` |
| `rustix` 0.38 | splice, socket options |
| `sha2`, `p256`, `ed25519-dalek` 2.x, `aes-gcm` | |

### 12.2 Repository layout

```
gate/
  crates/gate-core/      capwire server, policy glue, outbox, meter, mandates, executors, receipts
  crates/gate-net/       upstream sockets, relay, listeners
  crates/gate-tls/       interception, terminated mode, HTTP policy, injection, usage parsing
  crates/gate-render/    WASI renderer host
  crates/gate-shim/      tier-L egress forwarder (static musl)
  crates/gate-client/    keylos-gate-client + C ABI
  crates/gate-cli/       `gate` + cmdsig files
  schema/gate-local.capnp
  registry/effect-kinds.json
  fuzz/  tests/it/
```

### 12.3 Build

- Built by `forge` as reproducible generation `io.keylos.gate` (kind `service`, tier 0); `gate-shim` is a second output consumed by `compat` for tier-L views.
- `#![forbid(unsafe_code)]` everywhere except the splice and socket-option shims in `gate-net`, which carry documented `unsafe` blocks.

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reason |
|---|---|---|
| One effect broker for all egress ([ADR-0027](../../handbook/11-decisions/adr-0027-effect-outbox-and-mandates.md)) | Per-app proxies; Landlock port rules only | Landlock cannot filter by host. One choke point gives uniform receipts, Rule of Two and metering |
| Rule of Two decided by broker, enforced at gate ([ADR-0026](../../handbook/11-decisions/adr-0026-labels-and-rule-of-two.md)) | gate computes it alone | One evaluator for labels, flow proofs and approvals; gate stays a mechanism |
| Terminated mode for native subjects; interception only for shimmed subjects | Always intercept | Native apps need no CA installation; interception is limited to software keylos does not control |
| Per-session CA with name constraints | One machine CA | A leaked key affects one session and its granted hosts |
| Implicit staging via HTTP 428 | Block unsafe methods | Unmodified tools (`git`, `curl`) participate in approval flows |
| Mandates from `GrantResult`/`Approval.mandate` ([ADR-0028](../../handbook/11-decisions/adr-0028-approval-tiers.md)) | Reading receipts | Direct, typed, no ledger dependency on the hot path |
| Secrets never in env; injection at gate ([ADR-0039](../../handbook/11-decisions/adr-0039-secrets-never-in-env.md)) | Mount credentials into workbenches | A VM protects the host, not credentials mounted into it |
| Revocation kills or freezes holders ([ADR-0041](../../handbook/11-decisions/adr-0041-revocation-kills-or-freezes.md)) | Pull back fds | Impossible on Linux; gate keeps every outbound connection cuttable instead |
| NTS time for expiry ([ADR-0038](../../handbook/11-decisions/adr-0038-nts-time.md)) | System clock as-is | Expiry checks need authenticated time |
| capwire, no system bus ([ADR-0004](../../handbook/11-decisions/adr-0004-capwire-no-system-bus.md)) | D-Bus | Ambient authority; no fd-capability model |
| Renderers on Pulley ([ADR-0008](../../handbook/11-decisions/adr-0008-host-executes-only-sealed-code.md)) | Cranelift JIT | No executable anonymous memory in a tier-0 service |
| Mandates verified by signature (owner-presence or `service/broker`) ([ADR-0027](../../handbook/11-decisions/adr-0027-effect-outbox-and-mandates.md)) | Trust the broker connection | Stored mandates stay verifiable after restarts; gate holds no approver keys |
| Hard sub-meters carved by broker ([ADR-0005](../../handbook/11-decisions/adr-0005-biscuit-capability-tokens.md)) | Soft per-child caps in aide | Fan-out cannot amplify spending; one enforcement point |
| `fs.undo` executed by gate through `strata#gate` | Human-only undo | Compensation is one call on the intent, receipted like every other effect |
| `fs.merge` payload = the strata prepared merge (`keylos.fsmerge/2`, protocols E30) | A bench-only manifest with strata merging again at commit | The approved digest names exactly the content that is committed |
| Required review details per kind, canonical-text fallback, only gate marks renderings decorative (protocols E33, ISSUES ISS-006) | Approve on a title after a renderer failure; requester-chosen optional fields | A title or hash does not establish content, destination, amount or authority |
| Caller-executed `media.export` and `device.actuate` | gate holds device capabilities | Device capabilities stay with the principal the human granted them to; gate remains the single decision and record point |
| Offline rules applied at egress ([ADR-0056](../../handbook/11-decisions/adr-0056-offline-mode.md)) | Block all agent egress when offline for long | Keeps working sessions useful while making new destinations a human decision |
| Courier is the only TUF client; gate reads revocation age from depot ([ADR-0046](../../handbook/11-decisions/adr-0046-courier-sole-tuf-client.md)) | gate fetches revocation lists itself | One freshness source; no second TUF client |
| Durable effects as a separate, negotiated interface (`DurableEffects`, protocols E40) owned by the workflow and keyed by effect ID ([ADR-0068](../../handbook/11-decisions/adr-0068-durable-workflows-loom.md)) | Optional workflow fields on `EffectIntent`; session-owned intents | An older gate that ignored optional fields could not enforce fencing or retry rules; attempt sessions die with every reboot |
| Executor-declared retry strategy, unknown outcomes explicit | Retry every interrupted effect; mark it failed | Retry duplicates irreversible effects; "failed" hides that it may have happened |
| Authorization for workflow effects from `BrokerWorkflow.authorizeEffect` at commit | loom presents a token; a mandate obtained once at enrollment | Authority is revalidated before every effect; loom holds no authority |
| Workflow budget accounts independent of roots | Carving from each attempt's root | Roots end with every boot; spent amounts must not reset |
| Dedup retention bound to the workflow horizon | Fixed 30/7-day retention | A workflow can resume after the fixed period and repeat an effect whose record was deleted |
