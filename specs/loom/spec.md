# keylos/loom — the durable workflow coordinator

| | |
|---|---|
| Repository | `github.com/keylos-os/loom` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `loomd` (tier-0 service generation `io.keylos.loom`), `loom` (CLI generation `io.keylos.loom-cli`), crate `keylos-loom-sdk` (activity-worker side of `AttemptHost`, definition builder and validator), test generations `io.keylos.loom.test-activity` and `io.keylos.loom.gate-double` (development images only, §12.4) |
| Depends on | `keylos-protocols 1.0` (crates `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-biscuit`, `keylos-labels`) |
| Runtime peers | `warden` (`warden#service`: `Supervisor.spawn` with `SpawnSpec.attempt`, `Process`), `broker` (`broker#workflow`: `BrokerWorkflow`), `gate` (`gate#loom`: `DurableEffects`, `WorkflowBudget`), `vault` (`vault#loom`: `dataKey`/`forget` of `loom:` units), `ledger` (`ledger#writer`), `hearth` (`hearth#system`: `userState`, `watchUsers`, `owners`), `aide` (`aide#loom`: `AgentWorkflowHost`), `depot` (`depot#loom`: definitions, GC roots, revocation status), `net` (`net#status`: `NetWatch` time trust), `atrium` (`atrium#notify`) |
| Provides | `Loom`, `Workflow`, `AttemptHost` (protocols §7.3.16) on facets `user`, `admin`, `attempt`; `LoomSystem` (protocols §7.5.25) on facet `aide`; the workflow store; the `workflow.*` receipts; the built-in engine for `keylos.workflow/1` definitions (protocols §20.27) |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as described in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`loom` makes long-running work **durable** without making it more powerful. An enrolled workflow remembers completed steps, pending decisions, timers and signals across process failure and reboot, and continues with **newly authorized execution attempts**. Its central invariant (protocols §20.25) is normative here:

> Workflow progress survives execution attempts. Authority is revalidated before every further effect, and persistence never resurrects revoked permissions or cancelled work.

`loom`:

1. **Enrolls** workflows: a human pins a definition (protocols §20.27), an input, a scope of authority and a budget; `broker` decides the enrollment as a durable decision (protocols §20.25).
2. **Runs** the pinned definition with a small built-in engine of explicit, versioned state machines. Every step execution is a **claim** with a fresh attempt ID and an advanced ownership epoch.
3. **Starts attempts** under fresh principals: process activities through `warden` (`SpawnSpec.attempt`), agent activities through `aide` (`AgentWorkflowHost`). It never gives an attempt authority; `broker` mints it from its workflow record at registration.
4. **Records** results and non-deterministic observations (model responses, tool results, clock readings, randomness, signals), encrypted under the workflow's `loom:` unit, so later attempts replay them instead of repeating them.
5. **Commits effects** only through `gate` (`DurableEffects.commit`), which revalidates authority with `broker` every time; it waits for confirmed outcomes and surfaces `outcome-unknown`.
6. **Waits** durably for decisions, timers, signals and effect outcomes without keeping any worker alive.
7. **Cancels and forgets** durably: tombstones, broker cancellation records and ledger evidence prevent resurrection; forgetting crypto-shreds history.
8. **Pauses** user-owned workflows while the owner is locked, unless they were enrolled `runWhileLocked`.
9. **Writes receipts** `workflow.*` through a durable receipt outbox with a reconciliation contract, and detects a restored older store against the ledger.

### 1.1 Non-goals

- **Not part of the trusted authority core.** `loom` holds no tokens of any workflow, decides no approvals, mints nothing and executes no effect. A compromised `loom` can delay, pause or misreport work, and can claim steps of workflows it coordinates; it cannot exceed what `broker` approved for those workflows, choose the code an attempt runs, or commit an effect `broker` does not authorize now (§6).
- **No new workflow language.** Definitions are declarative JSON state machines (protocols §20.27) without code, expressions beyond JSON-pointer tests, clocks or randomness.
- **No distributed cluster.** One `loomd` per machine owns its store exclusively. No replication or availability after destruction of the machine or its storage is promised; an acknowledgment means the state is durable on this machine's storage.
- **No transparent process checkpointing.** Attempts are restarted from recorded results and observations, never from memory images.
- **No automatic retry of shell commands or arbitrary effects.** Effects are retried only as their executor's declared strategy allows (protocols §20.26); activities only as their declared semantics allow.
- **Not a general job scheduler.** Periodic or system maintenance tasks keep their own owners' atomicity and recovery protocols; a generic workflow may orchestrate them later, but never replaces them.

---

## 2. Context and embedded contracts

### 2.1 Position in the system

```
 human shell / atrium ──loom#user──►┌────────────────────── loomd (t0) ───────────────────────┐
 owner shell ─────────loom#admin───►│ engine · claims · store (SQLite, loom: units) · timers  │
                                    │ receipt outbox · rollback anchor · lock policy           │
                                    └─┬──────────┬──────────┬───────────┬──────────┬──────────┘
          warden#service: spawn attempt│  broker#workflow     gate#loom    aide#loom   ledger#writer
          (SpawnSpec.attempt)          ▼  claim/enroll/       commit/     startAttempt  workflow.*
                    ┌──────────────────┐  decide/cancel       lookup      (agent VM)
                    │ process attempt  │──loom#attempt──► AttemptHost (record, effect, complete)
                    │ app:<gen>@alice/ │──gate#client──► DurableEffects.prepare (own token)
                    │ s-loom/s-attempt │
                    └──────────────────┘
   aide ──loom#aide──► LoomSystem.attempt → AttemptHost for agent attempts (model/tool observations)
   broker ◄──SessionReg.attempt── warden / bench (VmPrincipal.attempt): label restored, tokens from workflow record
```

| Peer | Role for loom |
|---|---|
| `broker` | Authority: workflow records, claims and fencing, attempt grants, durable decisions, cancellation records, label high-water mark |
| `gate` | Effects and budgets: durable effect records by effect ID, executor strategies, workflow budget accounts |
| `warden` | Fresh sessions for process attempts; `Process` capabilities to stop them |
| `aide` | Agent attempts: agent sessions bound to a workflow attempt |
| `vault` | One `loom:<owner>:<wf-…>` unit key per workflow, system-wrapped |
| `ledger` | Evidence and the rollback anchor; never the workflow store |
| `hearth` | Owner lock state |
| `depot` | Definition files, revocation state, GC roots of pinned generations |

### 2.2 Routes and facets

**Facets loom serves** (protocols §19.2, embedded in §2.3): `user`, `admin`, `attempt`, `aide`.

**Routes loom holds** (declared in the `io.keylos.loom` service manifest):

| Route | Used for |
|---|---|
| `warden#service` | `Supervisor.spawn` of process attempts with `SpawnSpec.attempt` (only `loom` may set it); `Process.kill`, `wait`; `identify`, `connectionInfo`. loom never uses `FdStore` |
| `broker#workflow` | `BrokerWorkflow.enroll`, `claim`, `decide`, `rebind`, `resume`, `cancel`, `record`, `raise` |
| `gate#loom` | `DurableEffects.commit`, `lookup`, `watch`, `cancel`, `reconcile`, `resolve`, `forget`; `WorkflowBudget.reserve`, `settle`, `release`, `status` |
| `vault#loom` | `dataKey`, `forget` for `loom:` units |
| `ledger#writer` | `append` of `workflow.*` receipts; `query` of its own receipts (receipt reconciliation and rollback anchor, protocols §7.3.5); `serviceKey` |
| `hearth#system` | `HearthSystem.userState`, `watchUsers`, `owners` |
| `aide#loom` | `AgentWorkflowHost.startAttempt`, `stopAttempt`, `status` |
| `depot#loom` | `get`, `openPath` (`/.keylos/manifest.json`, `/.keylos/workflows/*`), `revocationStatus`, `root`/`unroot` (prefix `loom:workflow:`) |
| `net#status` | `NetWatch` (`timeTrusted`) |
| `atrium#notify` | `TrustedPrompt.notify` (paused by lock, outcome unknown, rollback review) |

### 2.3 Embedded contracts (verbatim from `keylos-protocols 1.0.0`)

The following blocks are copied mechanically from `protocols/spec.md`. If anything here disagrees with protocols, protocols wins.

#### 2.3.1 Identifiers, time and signed documents

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

#### 2.3.2 capwire and interfaces

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

#### 2.3.3 loom's own interfaces

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

#### 2.3.4 System interfaces loom uses

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

#### 2.3.5 Tokens, environment and files

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

<!-- BEGIN protocols §8.4 (verbatim) -->
> **protocols 8.4 Revocation**

- Revoking a root ID invalidates every token derived from it, including tokens whose `budget_parent` names it. Revocations are in-memory and persisted until the next reboot, when keys rotate anyway.
- **Workflow revocation is durable.** Cancelling or revoking a workflow (`BrokerWorkflow.cancel`, §20.25) writes a persistent cancellation record in the broker, revokes every root carrying that workflow's `workflow` fact, and makes every later claim and attempt registration of the workflow fail, across restarts and reboots; it is not undone by the per-boot key rotation.
- The broker MUST check revocation on every `materialize`, and `gate` on every `connect`, `stage` and `charge`.
- **Already-materialized fds cannot be pulled back from a process.** Revoking therefore also terminates or freezes holders through `PrincipalControl.terminate` (§7.5.1), according to the grant record's `onRevoke`: `kill` (default for agents) or `freeze` (default for apps; the user decides). Attached grant mounts are detached (`GrantMounts.detachGrant`).
<!-- END protocols §8.4 -->

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

#### 2.3.6 Receipts, labels, effects and mandates

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

#### 2.3.7 Conformance and registries

<!-- BEGIN protocols §17 (verbatim) -->
> **protocols 17. Conformance**

This repo ships `vectors/`:

| Suite | Contents |
|---|---|
| `ids/` | Valid and invalid identifiers of every kind |
| `dsse/` | Envelopes with valid and invalid signatures, and non-JCS payloads that must be rejected |
| `presence/` | FIDO2 presence envelopes (ES256, EdDSA) with valid, wrong-rpId, missing-UP, missing-UV, removed-credential cases |
| `manifest/` | Manifests that must pass or fail validation (including agent and compat sections), plus capability-diff cases |
| `biscuit/` | Tokens with the §8 vocabulary, and authorizer cases with expected allow/deny |
| `capwire/` | Recorded datagram sequences, including fd-index edge cases and capwire-vsock fd rejection |
| `labels/` | Label propagation and Rule-of-Two cases |
| `cedar/` | Policy, request and expected decision (including tier, presence, orgApproval and channels annotations) |
| `receipts/` | Hash-chain, submitted-form reconstruction and checkpoint/counter verification cases |
| `boottrust/` | Trust sets and generation statements with expected allow/deny for kl-exec registration |
| `release/` | Release statements, release-log proofs, floor semantics |
| `vbu/` | VBU QR payloads (CBOR), quotes from swtpm with good/bad nonce, PCR mismatch, AK0 mismatch |
| `firstboot/`, `consent/`, `seal/`, `flowproof/`, `fsmerge/`, `tlogproof/` | Format validation cases for §20 |
| `tpm/` | The §19.6 registry as machine-readable JSON, checked by every TPM-using component |
| `quorum/` | Quorum requests and multi-signature envelopes: threshold met, duplicate owner, removed credential, expired request |
| `trustee/` | Shamir share sets (k-of-n reconstruction, wrong share, checksum failure) for §20.19 |
| `catalog/`, `publishers/` | Catalog and publisher-list validation (§20.20) |
| `services/`, `policyref/` | `keylos.services/1` and `keylos.policyref/1` validation (§20.16, §20.17) |
| `recoverykey/` | Recovery key text encoding and CRC-8 checks (§20.21) |
| `podspec/` | `keylos.podspec/1` normalisation and Cedar `admit` decisions (§21.3) |
| `debug/` | Debug grant minting constraints (agents, tiers, durations) |
| `receipts-sealed/` | Sealed receipts: encryption, chain verification after shredding, submitted-form digest, `clear` returned form |
| `ociconv/` | `oci-convert/1` conversions (§21.4): OCI layouts with whiteouts, hardlinks, device nodes, file capabilities; expected `keylos.ociconv/1` descriptors and generation digests |
| `uplink/` | `keylos.cri.uplink/1` validation (§21.5) |
| `pendingreceipt/`, `fleetcommand/`, `cloudimage/`, `preauth/` | Format validation for §20.22–§20.24 and §9.5 |
| `workflow/` | Durable execution (§20.25–§20.27): workflow, run, step, attempt, effect, decision and budget-account IDs (including effect-ID derivation from step IDs), `keylos.workflow/1` definitions that must pass or fail validation, effect request digests, decision digests, the status vocabulary and the receipt-outbox reconciliation table |

Every keylos component MUST run the suites for the formats it parses or produces in CI. A release of any repo MUST state which protocols version it conforms to.

**Cross-component invariants.** Format vectors check one component at a time. The guarantees below span several components, so each is owned by the sections listed, and each MUST have an **integration acceptance test that runs the real components** across their actual boundaries (in the `warden` conformance harness, as the S2 exit test does), not test doubles that each assume the other side's behaviour:

| ID | Invariant | Sections |
|---|---|---|
| INV-1 | An effect is executed only with a mandate whose effect digest equals the digest of exactly the content that was presented and approved (prepared merges, required renderings) | §7.3.4, §14.2–§14.4, §20.12 |
| INV-2 | A file grant exposes exactly the granted object or subtree (single-file views; no parent, siblings or nested mounts) | §7.3.3, §7.5.1, §7.5.19 |
| INV-3 | A session is raised to a label that bounds everything it can read through a grant, before exposure, for the grant's lifetime | §7.3.3, §9.3, §14.1 |
| INV-4 | A revoked token cannot be materialised again, and holders of materialised fds are terminated or frozen | §8.4, §7.5.1 |
| INV-5 | A peer's identity comes only from `warden` (`ServiceHost.accept`, `connectionInfo`), across restarts and route changes | §7.1, §7.5.1 |
| INV-6 | Power loss at any point leaves every committed state recoverable and every completed erasure irreversible (vault epochs, OS floor, strata commits, ledger appends) | §13, §19.6, §20.6, vault and strata specs |
| INV-7 | A component that must write a receipt before replying does not reply success without it (`kl:unavailable` while it cannot) | §13.1, §7.5.2 |
| INV-8 | Workflow progress survives execution attempts, and persistence never resurrects cancelled or forgotten work: after a durable cancel, forget or workflow revocation no claim, attempt registration, token, dispatch or effect of that workflow happens again, across loom and broker restarts, reboots and restores of an older loom store | §8.4, §20.25, loom, broker |
| INV-9 | Authority is revalidated before every further effect: every attempt and every workflow effect is authorized by current policy with fresh boot-scoped authority, and a stale owner (lower ownership epoch) can neither register, dispatch, record nor complete anything | §8, §20.25, §7.5.25, loom, broker, gate, warden |
| INV-10 | An effect ID is executed at most as its executor's declared strategy allows: no automatic repetition after an unknown outcome except under verified downstream idempotency within its window or after authoritative reconciliation; otherwise the effect is `outcomeUnknown` until resolved; authorization is never reported as completion | §14.2, §20.26, gate, executors, loom |
| INV-11 | Workflow labels and budgets never reset across attempts: every attempt starts at the workflow's label high-water mark, the budget account's spent and unresolved amounts never decrease, and each reservation key is settled at most once | §8.2, §14.1, §20.25, broker, gate, aide, loom |
| INV-12 | A durable-execution acknowledgment (enroll, transition, record, complete, cancel, forget, decision, effect prepare) is given only after the owning store's durability barrier and, where a receipt is required, after the receipt is acknowledged; a failed barrier (fsync error, full store) is never acknowledged as success | §10.7, §13.1, §20.25, loom, broker, gate |

The integration tests for INV-8 to INV-12 run in the `warden` conformance harness with real `loom`, `broker`, `ledger` and `vault`; until `gate`, `aide`, `strata` and `bench` exist (stages S6, S7), the effect and agent sides use the documented `gate` test double of the loom spec, and those tests are rerun against the real components when they land.

**Changing a contract.** A shared format or interface whose meaning changes gets a new name or version (for example `keylos.fsmerge/2`) or, before release, an explicit "superseded" rule (`kl:unsupported`) for the old method; its meaning never changes silently. Contract excerpts in other repositories' specs are generated mechanically from this document and checked for equality; requirement IDs, algorithm order, failure tables, recovery rules and acceptance tests of the owning component specs change together with the contract. The excerpt generator and its equality check currently run from workspace tooling outside the repositories; until they move into this repository's `xtask`, a release MUST record that check's result.
<!-- END protocols §17 -->

<!-- BEGIN protocols §19.1 rows=`loom` (verbatim) -->
> **protocols 19.1 Service names** (rows for this repository)

| Service | Repo | Tier | Notes |
|---|---|---|---|
| `loom` | loom | t0 | Durable workflow coordinator (§20.25); orchestrates only: it holds no workflow authority of its own, and `broker` and `gate` authorize every attempt and effect |
<!-- END protocols §19.1 rows=`loom` -->

<!-- BEGIN protocols §19.2 rows=^\| (loom|ledger) \||^\| broker \| `workflow`|^\| gate \| `loom`|^\| aide \| `loom`|^\| vault \| `loom`|^\| depot \| `loom`|^\| hearth \| `system`|^\| warden \| `service` (verbatim) -->
> **protocols 19.2 Facets** (rows for this repository)

Every route names exactly one facet. Servers MUST implement exactly these facets; holders other than those listed are routed only when policy explicitly grants `right("service", "<svc>#<facet>", "use")`.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| warden | `service` | tier-0 services | `Supervisor.spawn`, `identify`, `connectionInfo`; `FdStore`. `SpawnSpec.attempt` only from `loom` |
| broker | `workflow` | loom, gate, aide, strata, bench | `BrokerWorkflow` (§7.5.25): `enroll`, `claim`, `decide`, `rebind`, `resume`, `cancel`, `cancelDecision`, `record`, `raise`: loom; `authorizeEffect`, `verify`, `record`, `cancelDecision`: gate; `offer`, `verify`, `decide`, `rebind`: aide (its agent attempts); `verify`, `record`: strata, bench |
| ledger | `writer` | tier-0 services listed as writers in §19.3 | `Ledger` (all) |
| ledger | `reader` | every principal | `Ledger` except `append` (filtered, §7.3.5) |
| ledger | `witness` | vouch, fleet | `LedgerWitness` |
| ledger | `admin` | owner `shell` | `LedgerAdmin` (including `shred`) |
| ledger | `time` | net, warden, depot | `LedgerAdmin.timeFloor` |
| ledger | `vouch-heartbeat` | vouch | `Ledger.query`/`watch` restricted to metadata (time, subject human) of `user.login` receipts of every human (§20.19) |
| ledger | `fleet-export` | fleet | `LedgerAdmin.export` (metadata only unless an owner `fleet-receipt-access` exception covers the event type) |
| vault | `loom` | loom | `dataKey`, `forget` for `loom:` units |
| hearth | `system` | warden, devd, config, broker, gate, vouch, strata, bench, depot, ledger, loom | `HearthSystem` (gate, vouch, strata, bench, depot, ledger: `owners` only; loom: `owners`, `userState`, `watchUsers`) |
| gate | `loom` | loom | `DurableEffects` (all except `prepare`), `WorkflowBudget` (`reserve`, `settle`, `release`, `status`) (§7.5.25) |
| aide | `loom` | loom | `AgentWorkflowHost` (§7.5.25) |
| depot | `loom` | loom | `get`, `openPath` (`/.keylos/manifest.json`, `/.keylos/workflows/*`), `revocationStatus`, `root`/`unroot` (holder prefix `loom:` only) |
| loom | `user` | human `shell`s, atrium | `Loom`, `Workflow` (own human's workflows; `enroll` with the caller as owner) |
| loom | `admin` | owner `shell` | `Loom`, `Workflow` for every human (read, `pause`, `cancel`, `forget`); loom-local admin (rollback review) |
| loom | `attempt` | attempt sessions spawned by loom (`SpawnSpec.attempt`) | `AttemptHost`, bound to the connecting attempt session |
| loom | `aide` | aide | `LoomSystem` (§7.5.25) for agent attempts aide started |
<!-- END protocols §19.2 rows=^\| (loom|ledger) \||^\| broker \| `workflow`|^\| gate \| `loom`|^\| aide \| `loom`|^\| vault \| `loom`|^\| depot \| `loom`|^\| hearth \| `system`|^\| warden \| `service` -->

<!-- BEGIN protocols §19.3 rows=\| (loom|gate|broker) (\||\() (verbatim) -->
> **protocols 19.3 Receipt events** (rows for this repository)

| Event | Writer |
|---|---|
| `grant.issue`, `grant.attenuate`, `grant.delegate`, `grant.revoke`, `grant.deny`, `label.raise`, `approval.request`, `approval.decide` | broker |
| `effect.stage`, `effect.commit`, `effect.fail`, `effect.cancel`, `effect.compensate`, `effect.complete`, `effect.unknown`, `effect.resolve`, `net.connect` (sampled per policy), `net.listen`, `budget.charge`, `budget.exhausted`, `budget.carve`, `budget.open`, `budget.settle`, `budget.close` | gate (for caller-executed kinds, §14.2, and for every durable effect, `effect.commit` means "authorized"; `effect.complete` records a confirmed outcome and `effect.unknown` an unknown one, §20.26; the executor of a caller-executed kind writes its own completion receipt) |
| `workflow.enroll`, `workflow.claim`, `workflow.step`, `workflow.wait`, `workflow.pause`, `workflow.resume`, `workflow.outcome-unknown`, `workflow.resolve`, `workflow.migrate`, `workflow.complete`, `workflow.fail`, `workflow.cancel`, `workflow.forget`, `workflow.recover`, `workflow.rollback-detected` | loom (§20.25: minimal transition metadata, never model or tool content) |
<!-- END protocols §19.3 rows=\| (loom|gate|broker) (\||\() -->

#### 2.3.8 Durable execution

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

<!-- BEGIN protocols §20.27 (verbatim) -->
> **protocols 20.27 Workflow definitions (`keylos.workflow/1`)**

A workflow definition is an explicit, versioned state machine shipped in a generation at `/.keylos/workflows/<name>.json` and listed in the manifest's `provides.workflows` (§6.3). `loom` interprets it; definitions contain no code. Activities run as separate attempts with their own principals and confinement. The file MUST be canonical JCS JSON; `DefinitionRef.digest` (what a workflow pins) is the SHA-256 of the file's bytes exactly as shipped. Defaults a validator fills in (for example an absent `effects` member read as `[]`) are never part of the digest, so a definition is never re-serialized for hashing.

```json
{"schema":"keylos.workflow/1","name":"coding-task","version":"1.0.0","stateVersion":1,
 "summary":"Change code, test it, merge the exact reviewed result, publish",
 "input":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["task"],
          "properties":{"task":{"type":"string"}}},
 "activities":{
   "edit":{"kind":"agent","template":"gen:fsv256:…","timeoutSecs":7200,"semantics":"replayable",
           "retry":{"max":3,"backoffSecs":[30,300,1800]},"effects":["merge"]},
   "test":{"kind":"process","entrypoint":"run-tests","timeoutSecs":1800,"semantics":"idempotent",
           "retry":{"max":2,"backoffSecs":[10]}},
   "publish":{"kind":"process","entrypoint":"publish","timeoutSecs":600,"semantics":"at-most-once","effects":["push"]}},
 "start":"edit",
 "states":{
   "edit":{"run":"edit","next":{"ok":"test","failed":"failed"}},
   "test":{"run":"test","next":{"ok":"merge","failed":"edit"}},
   "merge":{"commit":{"state":"edit","effect":"merge"},"next":{"succeeded":"publish","failed":"edit","denied":"failed","cancelled":"failed"}},
   "publish":{"run":"publish","next":{"ok":"push","failed":"failed"}},
   "push":{"commit":{"state":"publish","effect":"push"},"next":{"succeeded":"done","failed":"failed","denied":"failed","cancelled":"failed"}},
   "done":{"end":"completed"},
   "failed":{"end":"failed"}},
 "signals":{"abort":{"schema":{"type":"object"},"goto":"failed"}},
 "limits":{"maxTransitions":10000,"maxOccurrences":100},
 "migrateFrom":[]}
```

**Rules** (loom refuses a definition that breaks any of them, `kl:invalid`):
- `name` matches `[a-z][a-z0-9-]{0,62}` and equals the file name; `version` is SemVer; `stateVersion` is a positive integer that changes whenever the state set or the meaning of recorded results changes.
- `input` is a JSON Schema 2020-12 document without remote references; the enrollment input MUST validate against it.
- Activities: `kind` `process` (an entrypoint of the definition's own generation, spawned by loom with `SpawnSpec.attempt`, reaching loom on `loom#attempt`) or `agent` (an agent session of the pinned `template` generation, started by `aide` through `AgentWorkflowHost`); `timeoutSecs` ≤ 86 400; `retry.max` ≤ 10, `backoffSecs` non-decreasing; `effects` lists the effect names the activity may register with `AttemptHost.effect`. `semantics` is one of `idempotent` (an attempt that ended without a recorded result is retried), `replayable` (retried, with the recorded observations replayed by key) and `at-most-once` (an attempt that ended without a recorded result makes the workflow `outcome-unknown` until the owner resolves it).
- States: every state has exactly one of `run` (an activity; outcomes `ok`, `failed`), `commit` (`{state, effect}`: commits the effect that the most recent occurrence of `state` registered under `effect`; outcomes `succeeded`, `failed`, `denied` (decision denied or expired) and `cancelled`; an unknown outcome makes the workflow `outcome-unknown` until it is resolved, then the resolved outcome's `next` is taken), `wait` (`{"afterSecs": n}` or `{"at": "<JSON pointer into the input or a recorded result>"}` with outcome `timer`, or `{"signal": "<name>", "timeoutSecs": n}` with outcomes `signal` and `timeout`), `decide` (`{"question": "<JSON pointer>", "options": ["…"]}`: a durable decision of kind `workflow.decide`, outcomes the option names and `denied`), `choice` (a list of `{"if": {"pointer", "equals" | "exists"}, "next"}` over recorded results and the input, plus `default`) and `end` (`completed` or `failed`). `next` maps every outcome of the state to a state; there are no other transitions.
- Determinism: the next state is a function of the state, its outcome and recorded data only. JSON pointers address `/input/…` and `/steps/<state>/result/…` (the most recent occurrence). There are no clocks, randomness or external lookups in definitions.
- `signals` names the signals the workflow accepts, each with a JSON Schema and an optional `goto` taken from any non-terminal state (for example `abort`, which runs compensating effects as ordinary authorized effects before the workflow ends).
- `limits.maxTransitions` (≤ 100 000) bounds a run and `limits.maxOccurrences` (≤ 10 000) every state; exceeding either fails the workflow (`error:limits`).
- **Pinning and upgrades.** A workflow runs the definition it pinned for its whole run; a new version of the generation never changes a running workflow. The pinned generation stays rooted (`loom:workflow:<wf-…>`, §7.3.8). If the generation is revoked or no longer launchable, the workflow becomes `blocked-by-authority` (`definition-revoked`) before its next claim; pinning never bypasses revocation. `Workflow.migrate` moves it to another definition only when that definition's `migrateFrom` lists the pinned `(version, stateVersion)` with a `states` map from every non-terminal old state to a new state; it needs a new enrollment decision for the target (the same `wf-` ID, a new `wr-` run) and replays no old history under new code.
<!-- END protocols §20.27 -->

### 2.4 Interpretation notes (normative for this repo)

1. **Caller identity.** loom takes the caller's principal, facet and session only from `ServiceHost.accept` (protocols §7.1). On facet `attempt` the connecting session MUST be an attempt session loom spawned (recorded at spawn); every call is bound to that attempt's binding. On facet `aide` the caller MUST be the `aide` service; `LoomSystem.attempt` is accepted only for bindings of agent attempts loom asked `aide` to start.
2. **Owner.** The owner of a workflow is the human of the enrolling principal (`shell@alice/…` → `alice`). `_system` workflows are enrolled only through `loom#admin` by an owner `shell` for definitions shipped in service generations.
3. **No authority in loom.** loom never presents a token to any service, never calls `Broker.request`, `materialize` or `requestFor`, and never receives tokens (`BrokerWorkflow.offer` is aide's, not loom's).
4. **Status names.** `WorkflowStatus` enumerants map to the protocols §20.25 text forms (`blockedByAuthority` ↔ `blocked-by-authority`, `outcomeUnknown` ↔ `outcome-unknown`); the CLI and receipts use the text forms.
5. **Epochs.** loom's store epoch is a cache of the broker's: the broker's record is authoritative, and a claim that the broker refuses with `kl:conflict` means loom's store is not the newest view of the workflow (§4.9).
6. **Time.** "Now" in this spec is trusted time (protocols §3.6); with `KEYLOS_DEV_LOOM_CLOCK_SKEW_SECS` (development builds) the skew is added to it.
7. **Version probe.** Every bootstrap capability implements `common.Extensible`; `version()` returns `("1.0.0", "loom <semver>")`.

---
## 3. Requirements

### 3.1 Enrollment and definitions

- **REQ-LOOM-001** `Loom.enroll` MUST be served only on facets `user` (the caller becomes the owner) and `admin` (`_system` workflows, §2.4 note 2). It MUST refuse callers whose human is a guest (`guest-…`) or whose actor kind is not `shell` (or `atrium` acting for its human's shell) with `kl:denied`, before contacting `broker`.
- **REQ-LOOM-002** Before enrollment loom MUST verify the definition: `Depot.get(generation)` reports it launchable and not revoked; its manifest lists `name` in `provides.workflows`; the file `/.keylos/workflows/<name>.json` read with `Depot.openPath` is JCS-canonical, the SHA-256 of its bytes as read (never of a re-serialized definition, protocols §20.27) equals `DefinitionRef.digest` (else `kl:integrity`), and it satisfies every rule of protocols §20.27 (else `kl:invalid`). The enrollment scope MUST contain an effect item for every kind an activity of the definition declares in `effects` (else `kl:invalid`): attempts receive tokens only from the scope (protocols §20.25). The input MUST be JCS-canonical, ≤ 1 MiB and validate against the definition's input schema.
- **REQ-LOOM-003** loom MUST commit the `enrolling` workflow (new `wf-` and `wr-` IDs, owner, pinned definition, input digest, encrypted input, scope, budgets, resume policy, `runWhileLocked`, horizon, enrolling principal) before calling `BrokerWorkflow.enroll`, and MUST deduplicate `enroll` by (owner, `idempotencyKey`): a repeat returns the same workflow while the request is equal, and fails `kl:conflict` when it differs.
- **REQ-LOOM-004** A workflow MUST remain `waiting` (`enrollment:<dr-…>`) until the broker's enrollment decision is approved; a denied or expired enrollment MUST end the workflow `failed` (`error:enrollment-denied` / `error:enrollment-expired`) and forget its input. loom MUST NOT claim, spawn or record anything for a workflow before approval.
- **REQ-LOOM-005** loom MUST root the pinned definition generation with `Depot.root(ref, "loom:workflow:<wf-…>")` before the first claim and unroot it when the workflow is forgotten.
- **REQ-LOOM-006** Before every claim loom MUST re-check that the pinned generation is launchable and not revoked (`Depot.get`, cached ≤ 60 s, refreshed on `Depot.revocationStatus` serial changes); if not, the workflow MUST become `blocked-by-authority` (`definition-revoked`) and no claim is made.
- **REQ-LOOM-007** `Workflow.migrate` MUST accept only a target definition whose `migrateFrom` names the pinned `(version, stateVersion)` with a complete state map, MUST obtain a new enrollment decision for the target (same `wf-`, new `wr-`), and MUST start the new run at the mapped state without replaying old history under the new definition. The old run's records stay readable until the workflow is forgotten.

### 3.2 Claims, attempts and fencing

- **REQ-LOOM-010** Every step execution MUST be preceded by a claim: loom commits (attempt ID `wa-`, epoch e+1, step ID, activity generation, spawner session) in its store, then calls `BrokerWorkflow.claim`; it MUST NOT spawn, start or commit anything for the step before the claim succeeds.
- **REQ-LOOM-011** A claim refused with `kl:conflict` MUST stop all dispatch for that workflow and trigger the rollback check (§4.12); one refused with `kl:revoked` MUST finish the workflow's cancellation (§4.13).
- **REQ-LOOM-012** Process attempts MUST be spawned with `Supervisor.spawn(SpawnSpec{generation: <definition generation>, entrypoint: <activity entrypoint>, session: <empty>, attempt: <binding>, grants: [], fds: [], env: []})`: no grants, no fds and no environment beyond warden's, so their only authority is what `broker` mints at registration.
- **REQ-LOOM-013** Agent attempts MUST be started with `AgentWorkflowHost.startAttempt(binding, template, task, input, label)`; loom MUST NOT start an agent attempt for a workflow whose definition does not pin that template.
- **REQ-LOOM-014** Every `AttemptHost` and `LoomSystem` call MUST be checked against the workflow's current claim: an attempt whose epoch is not the current one gets `kl:conflict`, one of a cancelled or forgotten workflow `kl:revoked`, and nothing it sends is recorded.
- **REQ-LOOM-015** On a new claim loom MUST end every earlier attempt of the workflow: `Process.kill` for process attempts, `AgentWorkflowHost.stopAttempt(binding, "fence")` for agent attempts; their results arriving afterwards are rejected (REQ-LOOM-014).
- **REQ-LOOM-016** loom MUST hold its store exclusively (SQLite `locking_mode=EXCLUSIVE` and an `flock` on `/var/lib/keylos/loom/lock`); a second instance MUST exit without serving.

### 3.3 Engine and recorded observations

- **REQ-LOOM-020** The engine MUST compute the next state only from the definition, the current state, its outcome and recorded data (protocols §20.27); it MUST NOT read clocks, randomness or external services to choose a transition.
- **REQ-LOOM-021** Occurrences MUST be counted per (run, state) and step IDs derived per protocols §3.5; effect IDs MUST be derived from the step ID and effect name per protocols §3.5 and never generated randomly.
- **REQ-LOOM-022** `AttemptHost.record` MUST store the observation durably before returning, keyed by (step, key); a repeat with identical bytes returns the existing sequence number, different bytes fail `kl:conflict`. `AttemptHost.recorded` MUST return observations recorded by any earlier attempt of the same step.
- **REQ-LOOM-023** `AttemptHost.complete` MUST store the result and its label durably before returning; the engine transition that consumes it MUST be committed in the same transaction.
- **REQ-LOOM-024** When an attempt ends without `complete` or `fail` (process exit, `LoomSystem.ended`, timeout, fence), loom MUST apply the activity's semantics: `idempotent` and `replayable` → a new claim after backoff while `retry.max` allows, else the `failed` outcome; `at-most-once` → `outcome-unknown` (detail `step:<ws-…>`) until the owner resolves it with `Workflow.resolve(<ws-…>, "succeeded" | "failed")`.
- **REQ-LOOM-025** Exceeding `limits.maxTransitions` or `limits.maxOccurrences` MUST fail the workflow (`error:limits`).

### 3.4 Effects

- **REQ-LOOM-030** loom MUST commit effects only through `DurableEffects.commit(effect, binding)` on `gate#loom`, with the binding of a claim made for the `commit` state's step; it MUST NOT call any executor itself.
- **REQ-LOOM-031** `AttemptHost.effect(name, requestDigest)` MUST accept only names the activity declares in `effects`, MUST return the derived effect ID, and MUST record (effect ID, name, request digest) durably before returning.
- **REQ-LOOM-032** A `commit` state MUST take its `next` only from a confirmed outcome (`succeeded`, `failed`), from `cancelled`, or from `denied` (decision denied or expired); `authorized` MUST never be treated as completion. `outcomeUnknown` MUST set the workflow `outcome-unknown` (`effect:<fx-…>`) until reconciliation or `Workflow.resolve`.
- **REQ-LOOM-033** `Workflow.resolve` for an effect MUST be accepted only from the owner's `shell`, MUST obtain a `workflow.decide` decision (key `resolve:<fx-…>`) and pass its mandate to `DurableEffects.resolve`; it MUST NOT re-dispatch the effect.
- **REQ-LOOM-034** While a commit waits for a decision, loom MUST keep the workflow `waiting` (`decision:<dr-…>`) with no live attempt. loom observes the decision only through `commit` (protocols §20.26): while its commit claim is still the workflow's current claim it MUST re-issue `DurableEffects.commit` with that claim at every `decision-poll` interval (60 s; gate answers from its record, the broker returns the existing decision), and after a restart it MUST claim again (fresh epoch) before committing.

### 3.5 Store durability and encryption

- **REQ-LOOM-040** The store MUST be SQLite in WAL mode with `synchronous=FULL`, `foreign_keys=ON`, at `/var/lib/keylos/loom/loom.db`. loom MUST acknowledge a durable operation only after the commit returned success, and MUST answer `kl:unavailable` (never success) on any commit, `fsync` or space error (INV-12).
- **REQ-LOOM-041** Blobs above 64 KiB MUST be written to `/var/lib/keylos/loom/blobs/<sha256 of ciphertext>` with `O_TMPFILE`, `fsync`, `linkat` and an `fsync` of the directory before the transaction that references them commits; unreferenced blobs are deleted only after the dereferencing transaction committed.
- **REQ-LOOM-042** Inputs, results, observations, signal payloads and checkpoints MUST be encrypted with AES-256-GCM under the workflow's unit key from `vault.dataKey("loom:<owner>:<wf-…>")`, with a 96-bit random nonce and AAD = `wf-… ‖ 0x00 ‖ row kind ‖ 0x00 ‖ row key`. Metadata (IDs, states, epochs, digests, labels, times) is stored in clear inside the store.
- **REQ-LOOM-043** After an `fsync` failure loom MUST close and reopen the store, run `PRAGMA integrity_check` and replay nothing it did not commit; while that fails it MUST serve reads only and answer writes `kl:unavailable`.
- **REQ-LOOM-044** loom MUST NOT keep durable state in `FdStore`, `/run`, diagnostic snapshots or ledger receipts alone (protocols §10.7).

### 3.6 Authority, labels and budgets

- **REQ-LOOM-050** loom MUST raise the workflow label with `BrokerWorkflow.raise` before it records any observation, result or signal whose label exceeds the stored high-water mark, and MUST store every record with its label.
- **REQ-LOOM-051** `AttemptHost.task` MUST return the workflow label high-water mark; replayed observations MUST be returned with their recorded labels.
- **REQ-LOOM-052** loom MUST NOT reset or reopen a budget account; spending it reports in `WorkflowInfo` MUST come from `WorkflowBudget.status`. Charges loom itself reports (none in 1.0 beyond what attempts report) use keys derived from step and observation keys.
- **REQ-LOOM-053** `Workflow.resume` MUST call `BrokerWorkflow.resume(<caller session>, wf)` and act only on an approved decision.

### 3.7 Cancellation, forgetting and lock policy

- **REQ-LOOM-060** `Workflow.cancel` MUST follow §4.13 and return only after the broker cancellation record is persisted, loom's tombstone is committed and `workflow.cancel` is acknowledged by the ledger.
- **REQ-LOOM-061** After cancellation loom MUST keep resolving authorized and dispatching effects of the workflow (lookup, reconcile) and record their outcomes, and MUST NOT run further workflow logic.
- **REQ-LOOM-062** `Workflow.forget` MUST follow §4.14; after it returns, `info` reports `forgotten` and no plaintext or key of the workflow remains in loom's memory or store.
- **REQ-LOOM-063** loom MUST recheck the workflow's tombstone after every asynchronous `dataKey` fetch or blob read before caching or delivering the result, and discard the result if the workflow was forgotten meanwhile.
- **REQ-LOOM-064** A user-owned workflow not enrolled `runWhileLocked` MUST be `paused` (`locked`) while `HearthSystem.userState` reports its owner locked or hearth is unreachable; while so paused loom MUST make no claim, dispatch nothing and decrypt no history except to store incoming outcomes.
- **REQ-LOOM-065** When `watchUsers` reports a user deleted, loom MUST forget every workflow of that user (§4.14) with an empty cancel subject.

### 3.8 Time and timers

- **REQ-LOOM-070** Timers MUST fire only when trusted time ≥ due time. While time is untrusted, timer-driven work due beyond the time floor MUST stay `paused` (`time-untrusted`).
- **REQ-LOOM-071** Overdue work MUST be caught up in due order at no more than `catchUpPerMinute` claims per minute; every overdue item MUST re-check cancellation, pause, lock, budget and horizon before its claim.
- **REQ-LOOM-072** A workflow past its horizon MUST become `blocked-by-authority` (`horizon`) and loom MUST make no further claim for it; the owner can only cancel or forget it.

### 3.9 Receipts, outbox and rollback

- **REQ-LOOM-080** Every state change listed in §9.1 MUST produce exactly one receipt per logical event (`workflow`, `n`) through the receipt outbox (§4.11); a reply that requires a receipt MUST wait for its acknowledgment.
- **REQ-LOOM-081** Receipt `data` MUST contain only the members listed in §9.1 (IDs, states, epochs, digests, reason codes); never inputs, results, observations, model or tool content, or signal payloads.
- **REQ-LOOM-082** At start loom MUST run receipt reconciliation (§4.11) and the rollback check (§4.12) before serving facets `user`, `attempt` or `aide`.
- **REQ-LOOM-083** On a detected rollback loom MUST write `workflow.rollback-detected`, pause every workflow (`rollback-review`), apply the authoritative records of §4.12 and resume dispatch only after `loom rollback accept` with a verified presence envelope of purpose `loom.rollback-accept`.

### 3.10 Restart and resume policy

- **REQ-LOOM-090** After a loom restart or reboot every workflow with `resume = manual` that was not terminal MUST be `paused` (`awaiting-resume`) until its owner calls `Workflow.resume`; with `resume = automatic` loom MUST claim it again without asking, subject to the lock policy and catch-up limits.
- **REQ-LOOM-091** At start loom MUST look up every effect that is not in a confirmed state (`DurableEffects.lookup`) before any new claim of its workflow.

### 3.11 aide integration

- **REQ-LOOM-095** `LoomSystem.attempt(binding, session)` MUST return an `AttemptHost` bound to the binding only when loom started that attempt with `startAttempt` and `session` is the session `startAttempt` returned; otherwise `kl:not-found`.
- **REQ-LOOM-096** `LoomSystem.ended` MUST be treated as an attempt end per REQ-LOOM-024 and never as a cancellation; `LoomSystem.cancelRequested` MUST be treated as `Workflow.cancel` by the given subject (Cedar `cancel` evaluated by the broker).

### 3.12 CLI, observability and test double

- **REQ-LOOM-100** The `loom` CLI MUST ship a `keylos.cmdsig/1` per subcommand (§5.3) and use only `loom#user` or `loom#admin`.
- **REQ-LOOM-101** loom MUST export the metrics of §9.2 and never log decrypted content.
- **REQ-LOOM-102** Development knobs MUST be exactly `KEYLOS_DEV_LOOM_FAULTS`, `KEYLOS_DEV_LOOM_CLOCK_SKEW_SECS` and `KEYLOS_DEV_TIME_TRUSTED` (protocols §10.5), compiled only into development builds (cargo feature `dev`).
- **REQ-LOOM-103** The test generations `io.keylos.loom.gate-double` and `io.keylos.loom.test-activity` (§12.4) MUST be built only into development images (the release image recipe excludes them), and `loomd` production builds MUST refuse a `gate#loom` route whose server generation is `io.keylos.loom.gate-double`.

---
## 4. Design

### 4.1 Process structure

`loomd` is one tier-0 process, `#![forbid(unsafe_code)]`, async on tokio:

| Task | Role |
|---|---|
| capwire server | facets `user`, `admin`, `attempt`, `aide` |
| engine | one logical actor per workflow; consumes outcomes, commits transitions, schedules claims |
| dispatcher | outbox rows of kind `claim`, `spawn`, `agent-start`, `commit`, `cancel`, `budget`, `receipt`; delivers with retries and backoff (1 s → 60 s) |
| timer wheel | due timers by trusted time |
| watchers | `HearthSystem.watchUsers`, `NetWatch`, `DurableEffects.watch` per open effect, `Process.wait` per process attempt, `Ledger.query` polling for `grant.revoke` naming a workflow (every 10 s while workflows are active) |
| key cache | unit keys per workflow (≤ 256 entries, evicted after 10 min idle and on forget) |

All mutations of one workflow are serialized by its actor; each actor step is one SQLite transaction.

### 4.2 Store schema

`/var/lib/keylos/loom/loom.db`, WAL, `synchronous=FULL`, `locking_mode=EXCLUSIVE`, `user_version = 1`. Columns marked *enc* hold AES-256-GCM ciphertext (§4.3) or a blob reference.

| Table | Key | Columns |
|---|---|---|
| `meta` | name | `storeSeq` (u64, incremented by every committed transaction), `lastAckedSeq` (ledger seq of the newest acknowledged loom receipt), `recoverPending`, `rollbackState` (`ok` \| `review` \| `accepted`), `schemaVersion` |
| `workflows` | `wf` | `run`, `owner`, `enrolledBy` (principal text), `definition` (gen ref, name, digest, version, stateVersion), `status`, `detail`, `epoch`, `label`, `resume`, `runWhileLocked`, `horizon`, `account`, `idemKey`, `inputDigest`, `input` *enc*, `scope` (JCS), `budgets`, `created`, `updated`, `eventSeq` (last `n`) |
| `runs` | `run` | `wf`, `definitionDigest`, `startState`, `migratedFrom`, `created`, `ended` |
| `steps` | `step` (ws-…) | `wf`, `run`, `state`, `occurrence`, `kind` (`run` \| `commit` \| `wait` \| `decide` \| `choice` \| `end`), `status`, `outcome`, `result` *enc*, `resultLabel`, `attempts` (count), `started`, `ended` |
| `attempts` | `attempt` (wa-…) | `wf`, `step`, `epoch`, `kind` (`process` \| `agent` \| `commit` \| `decide`), `generation`, `spawner`, `session`, `state` (`claimed` \| `running` \| `ended`), `endReason`, `claimed`, `ended` |
| `observations` | (`step`, `key`) | `seq`, `kind`, `requestDigest`, `bodyDigest`, `body` *enc*, `label`, `attempt`, `recorded` |
| `effects` | `effect` (fx-…) | `wf`, `step`, `name`, `requestDigest`, `state` (last `EffectRecord.state`), `decision`, `outcome`, `updated` |
| `decisions` | `decision` (dr-…) | `wf`, `key`, `state`, `expires`, `updated` |
| `timers` | (`wf`, `step`) | `due`, `kind` (`after` \| `at` \| `signal-timeout` \| `retry` \| `decision-poll`) |
| `signals` | (`wf`, `name`, `key`) | `seq`, `digest`, `payload` *enc*, `label`, `sender`, `received`, `consumed` |
| `outbox` | `id` (u64) | `wf`, `kind`, `payload` (JCS, IDs only), `state` (`pending` \| `submitted` \| `done`), `attempts`, `nextTry`, `submittedTime`, `submittedDigest`, `ledgerSeq` |
| `tombstones` | `wf` | `runs`, `owner`, `terminal` (`cancelled` \| `forgotten` \| `completed` \| `failed`), `time`, `storeSeq`, `forgetGen` |

Every state change of §9.1 inserts its receipt row into `outbox` in the same transaction (§4.11).

### 4.3 Encryption and keys

- One unit per workflow: `loom:<owner>:<wf-…>` (`loom:_system:<wf-…>` for system workflows), obtained with `Vault.dataKey` on `vault#loom`. The vault wraps `loom:` units under its system key, so keys are available while the owner is locked; whether loom **uses** them for execution follows the lock policy (§4.15), not the wrapping.
- AEAD: AES-256-GCM (XChaCha20-Poly1305 without hardware AES, protocols §4), nonce 96 random bits, AAD = `wf ‖ 0x00 ‖ kind ‖ 0x00 ‖ key` (kind ∈ `input`, `result`, `obs`, `signal`, `blob`), so a ciphertext moved to another row fails.
- Key cache entries carry the workflow's `forgetGen`; after every `dataKey` reply loom re-reads the tombstone and drops the key if `forgetGen` changed or the workflow is forgotten (REQ-LOOM-063).
- Keys live in `memfd_secret` mappings via `keylos-vault-client::SecretBuf`; plaintext buffers are zeroized after use.

### 4.4 Engine

```
on_outcome(wf, step, outcome, result?):                 # one SQLite transaction
  require step is wf's current step and the reporting attempt is the current claim       (else kl:conflict)
  store result (enc) and outcome; steps[step].status := done
  s := definition.states[step.state]
  next := s.next[outcome]                                # total by §20.27 validation
  if signal goto pending (consumed in signal order): next := signal.goto; mark consumed
  enter(wf, next)

enter(wf, st):
  occ := count(steps where run = wf.run ∧ state = st);   step := "ws-" + ulid(run) + "." + st + "." + occ
  limits check (REQ-LOOM-025)
  insert steps(step, kind of st); receipt workflow.step{step, state: st, occurrence: occ}
  match kind(st):
    run    → schedule claim(step, activity)                         (status running)
    commit → schedule claim(step, commit)                            (status running)
    wait   → insert timer (after/at) or wait for signal (+timeout timer); status waiting (timer:/signal:)
    decide → schedule claim(step, decide)                            (status running, then waiting decision:)
    choice → evaluate JSON-pointer tests on /input and /steps/*/result; enter(wf, chosen)
    end    → status completed|failed; receipt workflow.complete|workflow.fail; WorkflowBudget.close via broker
```

`choice` and `next` are pure functions of stored data (REQ-LOOM-020). Results are decrypted only inside the transaction that evaluates them and only when the lock policy allows execution.

### 4.5 Claim algorithm

```
claim(wf, step, kind):
  pre: wf not terminal; not paused (user, locked, awaiting-resume, rollback-review, time-untrusted, budget); now < horizon
       definition generation launchable (REQ-LOOM-006); catch-up budget available (§4.17)
  1  e := wf.epoch + 1; a := "wa-" + ULID; gen := activity generation (process: definition generation;
     agent: template; commit/decide: definition generation); spawner := loom's session (process, commit, decide)
     or aide's service session (agent)
  2  commit: attempts(a, step, e, kind, gen, spawner, state claimed); wf.epoch := e;
             outbox claim row; receipt workflow.claim{step, attempt: a, epoch: e, kind}
  3  dispatcher: BrokerWorkflow.claim({wf, a, e, step, owner}, gen, spawner)
       ok           → attempts[a].state := running; continue with §4.6 / §4.7 / §4.8
       kl:conflict  → stop dispatch for wf; rollback check (§4.12)
       kl:revoked   → finish cancellation (§4.13)
       kl:unavailable → retry with backoff (the claim row stays pending)
  4  end every earlier attempt of wf (REQ-LOOM-015)
```

The broker revokes earlier attempts' roots inside its `claim`, so a stale worker loses its authority before the new attempt exists.

### 4.6 Attempts

**Process attempts.** After the claim, the dispatcher calls `Supervisor.spawn(SpawnSpec{generation: gen, entrypoint, attempt: binding, limits: activity limits, …})` (REQ-LOOM-012). `warden` creates a fresh session `s-…`, forms the principal `<actor>@<owner>/<loom session>/<s-…>` from `binding.owner`, registers it with the broker (`SessionReg.attempt`), and wires the route `loom#attempt`. The broker verifies the binding and mints the attempt's tokens from the workflow record, after restoring the label (protocols §20.25). loom records the session from `Process.principal()`; a connection on `loom#attempt` from that session is bound to the attempt. The worker (with `keylos-loom-sdk`) calls `AttemptHost.task`, replays `recorded` observations by key, records new ones, registers and prepares effects at `gate` with its own token (obtained with `Broker.myGrants` on `broker#principal`; `warden` passes no tokens, protocols §20.25) (`DurableEffects.prepare` on `gate#client`), and ends with `complete` or `fail`. `Process.wait` resolving without either is an attempt end (REQ-LOOM-024). An activity's `timeoutSecs` is enforced by `Process.kill`.

**Agent attempts.** loom calls `AgentWorkflowHost.startAttempt(binding, template, task, input, label)` on `aide#loom`. `aide` builds the VM (`VmSpec.attempt = binding`, shares from `BrokerWorkflow.offer` tokens), registers it through `bench` and `warden` with `VmPrincipal.attempt`, and obtains an `AttemptHost` for the attempt with `LoomSystem.attempt(binding, session)`. `aide` records every model response and host-tool result through `AttemptHost.record` before returning it to the harness, and on a later attempt serves recorded responses for identical request digests in key order before calling live. A crashed VM, a lost heartbeat, a breaker trip or a pause is reported with `LoomSystem.ended` (never a cancellation); the human stopping the session is `LoomSystem.cancelRequested`.

**Heartbeats.** Process workers call `AttemptHost.heartbeat` at least every 30 s; three missed heartbeats end the attempt (`Process.kill`, reason `heartbeat-lost`).

### 4.7 Effect flow

```
in an activity attempt (worker holds its token):
  fx := AttemptHost.effect(name, requestDigest)        # derived id, recorded
  record := DurableEffects.prepare({fx, binding, intent}, token)   # gate#client or gate#aide; durable in gate
  AttemptHost.complete(result that names the prepared effect)

commit state (loom, no token):
  claim(step, commit) → binding
  record := DurableEffects.commit(fx, binding)          # gate → BrokerWorkflow.authorizeEffect
  match record.state:
    awaitingApproval → status waiting (decision:<record.decision>); re-issue commit at each decision-poll (REQ-LOOM-034)
    authorized, dispatching → status waiting (effect:<fx>); watch
    succeeded | failed  → on_outcome(step, succeeded|failed)
    cancelled, outcome.reason ∈ {decision-denied, decision-expired, policy-denied}
                        → on_outcome(step, denied)        (protocols §20.26)
    cancelled (any other) → on_outcome(step, cancelled)
    outcomeUnknown      → status outcome-unknown (effect:<fx>); receipt workflow.outcome-unknown;
                          TrustedPrompt.notify(owner); wait for reconcile or Workflow.resolve
```

`Workflow.resolve(fx, outcome)`: owner `shell` only; loom asks `BrokerWorkflow.decide(binding, "resolve:<fx>", [], [{kind: "workflow.decide", target: fx, digest: "sha256:" + SHA-256(JCS {"effect", "outcome"})}])` (exactly the resolution digest of protocols §20.26; `note` is not digested), waits for approval, passes the mandate to `DurableEffects.resolve`, then continues with the resolved outcome (receipt `workflow.resolve`). The same path with target = a step ID resolves an `at-most-once` activity; that digest is loom-local: SHA-256 of the JCS `{"step", "outcome", "note"}`.

### 4.8 Decisions and waits

- **Enrollment** (`enrollment:<dr-…>`): loom polls `BrokerWorkflow.record` every 30 s and re-calls `enroll` with the same request after a restart (the broker returns the same decision).
- **`decide` states**: claim(step, decide), then `BrokerWorkflow.decide(binding, "decide:<ws-…>", [], effects)` with one `DecisionEffect` per option: `{kind: "workflow.decide", target: "<ws-…>#<option>", digest: SHA-256(JCS {"question": <value at the pointer>, "option"})}` (protocols §20.25; the decision's own digest already binds the workflow and its key binds the step). The broker presents the options as alternatives; the delivered mandate's `effects[]` contains exactly the entry of the option the human chose, which loom verifies (digest recomputed) and takes as the outcome. While pending the workflow is `waiting` (`decision:<dr-…>`) with a `decision-poll` timer (60 s) and no live attempt; a denied or expired decision takes outcome `denied`. A definition with a single option is a plain approval.
- **Effect approvals**: the record's `decision` (§4.7).
- A decision's prompt may be re-presented by the broker after restarts; loom never shows prompts and never treats a signal as a decision.

### 4.9 Epoch conflicts and takeover

A `kl:conflict` from `claim` (or from `AttemptHost` calls of loom's own attempts after a restart) means the broker's record has a newer epoch than loom's store. loom reads `BrokerWorkflow.record(wf)`: if the record's epoch is higher than any epoch loom committed, the store is stale: rollback check (§4.12). A second `loomd` cannot run concurrently (REQ-LOOM-016); a takeover after a crash simply continues with `record.epoch + 1`.

### 4.10 Labels and budgets

- Every `record`, `complete` and `signal` carries a label; loom joins it into the workflow label, and when the join exceeds the stored high-water mark calls `BrokerWorkflow.raise` before committing (REQ-LOOM-050). The broker also raises the mark itself when an attempt session's label rises, and loom refreshes its copy from `record` at each claim.
- Budgets are gate's: loom displays `WorkflowBudget.status`; a claim whose activity declares an estimated cost is preceded by `WorkflowBudget.reserve(ba, "<ws-…>:est", amount)`; `kl:budget` pauses the workflow (`budget`) until the owner raises the account through a new enrollment decision or cancels. Reservations of fenced attempts are settled `unresolved` by gate (protocols §20.25).

### 4.11 Receipt outbox

**History.** `Workflow.history` returns one `WorkflowEvent` per `workflow.*` receipt row of the workflow, with `seq` = its `n` (protocols §22.7): `workflow.claim` → `attempt`, `workflow.step` → `step`, `workflow.enroll` → `decision`, the status events → `status`, `workflow.resolve` → `effect`, any other event → `note`. Status changes that write no receipt (for example `running`) appear in no history event.

**Submission.** Every row of kind `receipt` is delivered in `n` order per workflow, at most one outstanding submission per workflow:

```
deliver(row):
  form := submitted form (protocols §13.1) {time: now, writer: loom, subject: wf.enrolledBy (or loom itself for
          workflow.recover / workflow.rollback-detected), event, data: row.payload ∪ {workflow, run, n, storeSeq}}
  sign; commit row.submittedTime := form.time, row.submittedDigest := SHA-256(JCS(form)), state submitted
  Ledger.append(envelope)
    ok(seq)                   → commit row.state := done, row.ledgerSeq := seq, meta.lastAckedSeq := max(…, seq)
    kl:invalid "re-sign"      → rebuild with a fresh time (repeat, ≤ 10 times)
    kl:unavailable / transport → keep submitted; retry the same envelope after backoff
```

A retry of the same envelope bytes is safe within one connection-loss window only through reconciliation; loom therefore never resubmits a `submitted` row blindly after a restart.

**Reconciliation at start:**

```
R := outbox rows with state submitted
wait until now > max(R.submittedTime)                       # clock behind the old submissions
append workflow.recover{storeSeq, outstanding: |R|} (subject loom) → seq_r
receipts := Ledger.query({principalPrefix: "service:loom:", fromSeq: meta.lastAckedSeq + 1}) up to seq_r
for row in R:
  found := receipt in receipts whose submitted-form digest (sealed.submitted, or rebuilt for clear receipts) = row.submittedDigest
  found     → row.state := done, row.ledgerSeq := its seq
  not found → row.state := pending (it can no longer be appended, protocols §13.1); deliver again as a new submission
every other receipt in receipts (not matched, not seq_r) → rollback detected (§4.12)
```

| Outbox row state at crash | Ledger has the receipt | Result after reconciliation |
|---|---|---|
| `pending` | no | delivered normally |
| `submitted` | yes (appended before the crash, reply lost) | marked `done` with its seq; no duplicate |
| `submitted` | no (never reached the ledger, or refused) | resubmitted once with a fresh time |
| `done` | yes | nothing |
| (row missing: store older than ledger) | yes | rollback detected |

### 4.12 Rollback detection

```
after reconciliation (seq_r known):
  unmatched := loom receipts (writer = loom; principalPrefix also matches receipts others wrote with loom as subject,
               protocols §22.7) with lastAckedSeq < seq < seq_r not matched to an outbox row
  ledgerBehind := seq of this start's workflow.recover ≤ meta.lastAckedSeq (the ledger just appended it, so its head
                  cannot be older; checkpoints may lag the head), or the ledger reports a new epoch after an alarm
  if unmatched ≠ ∅ ∨ ledgerBehind ∨ any BrokerWorkflow.claim kl:conflict with record.epoch > store epoch:
     meta.rollbackState := review; append workflow.rollback-detected{storeSeq, lastAckedSeq, unmatched: count}
     every workflow → paused (rollback-review); TrustedPrompt.notify(owners, critical)
     apply evidence:
       workflow.cancel / workflow.forget receipts in unmatched (refs.workflow) → tombstone; forget unit keys
       for each workflow: r := BrokerWorkflow.record(wf): cancelled → tombstone; r.epoch > wf.epoch → wf.epoch := r.epoch
       for each effect row: DurableEffects.lookup → store state and outcome; for each workflow: WorkflowBudget.status
       workflow known only from unmatched receipts (no row) → tombstone failed (history-lost); listed in the rollback
          report; the broker record is left as it is (the broker needs a live subject unless forget = true, and its own
          rollback anchoring covers its records)
       steps whose results are older than gate/broker evidence → re-run per activity semantics after acceptance
  loom rollback accept (owner shell, presence purpose loom.rollback-accept verified with keylos-presence against
     HearthSystem.owners) → rollbackState := accepted; workflows leave rollback-review (manual ones to awaiting-resume)
```

Claims after acceptance use `record.epoch + 1`, so attempts of the restored store's era are fenced; gate's effect records and the broker's decisions prevent any effect or decision from being repeated. An empty store on a machine whose ledger has loom receipts is handled identically.

### 4.13 Cancellation

```
cancel(wf, subject, reason):
  1  commit tombstone(terminal cancelling), status cancelled-pending (not visible as cancelled yet)
  2  BrokerWorkflow.cancel(subject, wf, reason, forget=false)   # durable; revokes roots; cancels pending decisions
       kl:denied → roll back step 1, return kl:denied
  3  end attempts: Process.kill / AgentWorkflowHost.stopAttempt(…, "cancel"); drop timers and unconsumed signals
  4  for effects in prepared | awaitingApproval: DurableEffects.cancel
     for effects in authorized | dispatching | outcomeUnknown: keep watching; record outcomes as they arrive
  5  commit status cancelled (by:<human>); receipt workflow.cancel{reason, openEffects}; wait for its ack; return
```

A crash between steps resumes at the first step whose effect is not yet visible (the tombstone makes the workflow non-runnable from step 1 on). `BrokerWorkflow.cancel` is idempotent. Step 2 evaluates Cedar `cancel` for `subject`, so after a crash between steps 1 and 2 the subject's session (the owner's shell of the previous boot) is gone and loom cannot finish step 2 by itself: the workflow stays non-runnable (tombstone `cancelling`, no claims, no attempts) and loom finishes steps 3–5 when `BrokerWorkflow.record` shows the cancellation or when the owner calls `cancel` again (protocols §20.25). A crash after step 2 finishes without the broker.

### 4.14 Forgetting

```
forget(wf):
  if not terminal: cancel(wf, subject, "forget")
  1  commit tombstone forgotten, forgetGen += 1; drop key cache entry; status forgotten
  2  vault.forget("loom:<owner>:<wf>"); DurableEffects.forget(wf); AgentWorkflowHost.stopAttempt(…, "cancel") for
     any agent attempt still known (aide discards its units and retained overlays of the workflow's attempts);
     BrokerWorkflow.cancel(…, forget=true); Depot.unroot(definition, "loom:workflow:<wf>")
  3  delete enc columns, observations, signals, blobs of wf (one transaction; blob unlink after commit)
  4  receipt workflow.forget; ack
```

Retained prepared merges of the workflow are discarded by `gate` as part of `DurableEffects.forget` (it discards the `fs.merge` records' prepared merges through `bench`). The vault reports cryptographic erasure later (vault rotation); `loom status` shows `pendingErasure` until the vault's `secret.delete{erased}` receipt names the unit.

### 4.15 Lock policy

```
locked(owner) := owner ≠ _system ∧ (HearthSystem.userState(owner).locked ∨ hearth unreachable)
on watchUsers event or every 60 s:
  for wf of owner, not terminal, ¬wf.runWhileLocked:
     locked → status paused (locked); stop claims; running attempts get stopAttempt(…, "pause") / Process.kill;
              the step is re-run after unlock per its semantics (replayable/idempotent) — at-most-once steps are
              allowed to finish (they are not killed) because killing them would create an unknown outcome
     unlocked → leave paused(locked) to the previous status; schedule claims (catch-up, §4.17)
```

While paused by the lock loom still stores incoming effect outcomes and decision changes (metadata only) and encrypts arriving records, but does not decrypt history.

### 4.16 Restart

```
start:
  open store (exclusive); integrity_check; reconciliation (§4.11); rollback check (§4.12)
  for wf not terminal:
     r := BrokerWorkflow.record(wf): cancelled → finish cancel (§4.13) ; forgotten → finish forget
     attempts in claimed|running → ended(reason "coordinator-restart")
     effects not confirmed → DurableEffects.lookup (REQ-LOOM-091)
     resume = manual   → paused (awaiting-resume)
     resume = automatic → per step semantics: re-claim (lock, catch-up, budget, horizon checks apply)
  serve facets
```

### 4.17 Timers, signals and catch-up

- Timers fire when `trustedNow ≥ due`. Before the first `timeTrusted` event loom uses `max(now, LedgerAdmin time floor from the newest checkpoint note)`; a timer due after that value waits (`time-untrusted`).
- `catchUpPerMinute` (default 6) bounds claims caused by overdue timers and post-restart resumption, in due order across workflows, round-robin across owners.
- Signals: `Workflow.signal(name, key, payload)` requires the name to be declared; payload ≤ 1 MiB validated against the signal schema; recorded with the caller's session label (`LabelAuthority` label reported in `ServiceHost.accept`'s connection info); deduplicated by (name, key) and payload digest. A signal with `goto` is taken at the next transition boundary; others are consumed by `wait` states in arrival order.
- Retries use `retry.backoffSecs` as timers, so they survive restarts.

### 4.18 Reference workflow: the coding agent (S7)

The `io.keylos.agent.coder` generation ships `coding-task` (protocols §20.27 example) — edit → test → prepare exact merge → wait for approval → commit → publish:

| Step | Kind | Semantics / strategy | Notes |
|---|---|---|---|
| `edit` | agent activity (aide) | `replayable` | The agent changes code in its overlay; model and tool results are recorded; at the end aide prepares the merge (`BenchMerge.manifest` → strata prepared merge `pm-…`, `TransactionExt.bindWorkflow`), registers effect `merge` and prepares an `fs.merge` durable effect whose payload is the `keylos.fsmerge/2` manifest |
| `test` | process or agent activity | `idempotent` | Runs the tests against the prepared content (the frozen snapshot), so results are tied to what will be merged |
| `merge` | commit of `edit.merge` | `transactional` (`BenchMerge.commitPrepared` by `pm-…`) | Waits for the T3 decision rendered from the prepared merge; gate revalidates authority and live preconditions; `kl:conflict` (stale live tree) → `failed` → back to `edit`, which prepares a new merge with a new effect ID and a new approval |
| `publish` | process activity | `at-most-once` | Prepares `git.push` (effect `push`) |
| `push` | commit of `publish.push` | `reconciliation` (remote ref equals the pushed commit) | An interrupted push is reconciled by the effect ID, never repeated blindly |

A reboot at any point resumes (automatic resume) or pauses (manual) the workflow; the human sees one prompt per prepared merge, never a second prompt for the same decision.

### 4.19 Retention

- History (`enc` columns, observations, signals, blobs) is kept until forgotten, or `historyRetentionDays` after the workflow became terminal, when loom forgets it automatically (§4.14).
- Tombstones and outbox rows of kind `receipt` in state `done` older than 400 days are compacted to their tombstone; tombstones are never deleted.
- Effect dedup records are gate's (protocols §20.26); decision records the broker's.

---
## 5. Interfaces

### 5.1 Facets served

| Facet | Holders | Interfaces | Rules |
|---|---|---|---|
| `user` | human `shell`s, atrium | `Loom`, `Workflow` | `enroll` with the caller as owner; `workflows`/`open` only for the caller's human; `pause`, `resume`, `cancel`, `forget`, `signal`, `resolve`, `migrate` only on own workflows (Cedar decides `resume` and `cancel` in the broker) |
| `admin` | owner `shell` | `Loom`, `Workflow` for every human (read, `pause`, `cancel`, `forget`); `LoomAdmin` (§5.2) via `Extensible.ext` | `_system` enrollment; rollback review |
| `attempt` | attempt sessions loom spawned | `AttemptHost` | bound to the connecting attempt session (§2.4 note 1) |
| `aide` | aide | `LoomSystem` | agent attempts loom started through `aide` only |

Method semantics follow protocols §7.3.16 and §7.5.25. Errors: `kl:not-found` for workflows the caller may not see (never `kl:denied`, so IDs are not confirmed); `kl:conflict` for stale epochs and idempotency mismatches; `kl:revoked` for cancelled or forgotten workflows; `kl:unavailable` for barrier failures and unreachable peers; `kl:needs-approval:<a-…>` is never returned by loom (decisions are visible as `waiting`).

### 5.2 Repo-local interface (`loom` CLI only)

File ID `0xe1e32681dce8795c` (generated with `capnp id`), served on facet `admin` through `Extensible.ext`; no other repository consumes it.

```capnp
@0xe1e32681dce8795c;
using C = import "/common.capnp";   # protocols' schema/ directory on the import path

interface LoomAdmin {
  status         @0 () -> (json :Text);    # store state, rollbackState, outbox depth, lastAckedSeq, pendingErasure
  rollbackReport @1 () -> (json :Text);    # evidence applied during rollback review (§4.12)
  rollbackAccept @2 (presenceEnvelope :Data) -> ();   # purpose loom.rollback-accept (protocols §20.2)
  outbox         @3 (limit :UInt32) -> (json :Text);
  export         @4 (workflow :Text, out :C.Fd) -> (bytes :UInt64);   # keylos.loom.export/1, decrypted for the owner shell only
}
```

### 5.3 CLI: `loom`

Every subcommand ships a `keylos.cmdsig/1`; output is records when the shell negotiates `cbor-seq`, a table otherwise.

| Command | Description | Exit codes |
|---|---|---|
| `loom enroll <generation> <name> --input FILE [--scope FILE] [--budget unit:amount …] [--resume manual\|automatic] [--run-while-locked] [--horizon 30d] [--reason TEXT] [--key K]` | Enroll; prints the workflow ID and waits for the enrollment decision unless `--no-wait` | 0 enrolled, 3 denied, 4 decision pending (timed out waiting), 2 error |
| `loom ls [--all] [--human U]` | Workflows with status, detail, step, epoch, label, budget | 0 |
| `loom show <wf>` | `WorkflowInfo`, open effects, pending decisions | 0, 1 not found |
| `loom history <wf> [--from N]` | Event list | 0, 1 |
| `loom watch <wf>` | Live events | 0 |
| `loom pause <wf> [--reason TEXT]`, `loom resume <wf>` | Pause; manual resume | 0, 1, 3 |
| `loom cancel <wf> [--reason TEXT]` | Durable cancel; returns after the receipt | 0, 1, 3 |
| `loom forget <wf>` | Cancel if needed and crypto-shred | 0, 1, 3 |
| `loom signal <wf> <name> --key K --payload FILE` | Send a signal | 0, 1, 5 conflict |
| `loom resolve <wf> <fx-…\|ws-…> succeeded\|failed [--note TEXT]` | Resolve an unknown outcome (approval required) | 0, 1, 3 |
| `loom migrate <wf> <generation> <name>` | Explicit migration | 0, 1, 3 |
| `loom status` | `LoomAdmin.status` | 0 |
| `loom rollback show`, `loom rollback accept` | Rollback review; `accept` asks for presence (`Hearth.presence`, purpose `loom.rollback-accept`) | 0, 3 |
| `loom export <wf> --out FILE` | Owner export | 0, 1 |

### 5.4 Files

| Path | Owner | Mode | Content |
|---|---|---|---|
| `/var/lib/keylos/loom/loom.db`, `loom.db-wal` | loom | 0600 | The store (§4.2) |
| `/var/lib/keylos/loom/blobs/` | loom | 0700 | Encrypted blobs |
| `/var/lib/keylos/loom/lock` | loom | 0600 | Exclusive-instance lock |
| `/var/lib/keylos/loom/service-key.sealed` | loom | 0600 | TPM-sealed `service/loom` receipt-signing key (protocols §5.2, §19.6 "Sealed secrets") |
| `/etc/keylos/loom.json` | config | 0444 | Configuration (§10) |
| `/run/keylos/svc/loom/` | warden | 0700 | Service socket directory |

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| Compromised `loomd` | Holds no tokens; attempt authority is minted by the broker only for the claimed generation, spawner and owner, from the approved scope, under current policy; every effect is authorized by the broker through gate; decisions need the human on the trusted path. A compromised loom can deny service, misreport status, or run already-approved steps out of order within the approved scope; it cannot widen scope, change pinned code, approve, or repeat a consumed effect (gate dedups by effect ID) |
| Stale worker after a fence or cancel | Broker revokes its roots at the next claim or cancel; loom rejects its calls (`kl:conflict`/`kl:revoked`); gate rejects its epoch |
| Restored older store | Ledger-anchored rollback detection (§4.12); broker epochs and cancellation records, gate effect records and accounts are authoritative; resume needs owner presence |
| Forged or replayed signal | Signals are untrusted data labelled with the sender; never decisions (protocols §20.25); dedup by (name, key) |
| Approval replay | Durable decisions are bound to (workflow, key, digest), fixed expiry, consumed once per effect ID by gate; `rebind` revalidates; mandates carry `constraints.workflow` |
| Label laundering through a fresh attempt | Label high-water mark in the broker, restored before grants; observations replayed with their labels |
| Budget reset by new roots | Durable account independent of roots (`budget_account` fact) |
| Peer impersonation | Identity only from `ServiceHost.accept`; attempt sessions bound at spawn; `LoomSystem` only for aide-started attempts |
| Resurrection after forget | Tombstones, broker record, ledger refs; unit names never reused (wf IDs unique) |
| Plaintext leakage | Encrypted at rest under per-workflow units; receipts carry IDs only; keys in secret memory; no decrypted logs |
| Running while the owner is away | Lock policy pauses by default; `runWhileLocked` needs presence at enrollment |

### 6.2 Residual risks

- A loom compromise can stall or delay approved work and can re-run idempotent or replayable activities within their approved scope; it can learn workflow histories it decrypts (all of them while running).
- Effects dispatched before a fence may still complete remotely; they are settled by effect ID, not undone.
- Durability is that of one machine's storage. Destruction of the machine or of both the store and the ledger is not covered.
- Until vault rotation recovery and real power-cut tests are complete (S2 follow-ups V1, protocols INV-6), end-to-end power-loss safety of forgetting is claimed only within the vault's stated guarantees.

### 6.3 Confinement of `loomd`

| Property | Value |
|---|---|
| Tier | t0, dynamic UID, `network: "none"` |
| Mount view | own generation at `/`; `/etc` subset with `/etc/keylos/loom.json`; `/var/lib/keylos/loom` (rw); `/run/keylos/boot` (ro); `/proc` (subset=pid) |
| Landlock | rw only on its state directory; execute only in its own generation |
| Capabilities | none |
| seccomp | `baseline-1` plus `memfd_secret`, `mlock` |
| TPM | `KEYLOS_TPM_FD`, only to unseal `service-key.sealed` |
| Core dumps | `PR_SET_DUMPABLE 0` |

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| loom crash or kill | Restart per §4.16; acknowledged state is intact; unacknowledged requests are retried by callers (idempotent) |
| Reboot | As restart; all attempts are ended; manual workflows `awaiting-resume`, automatic ones reclaimed |
| `fsync` error, full disk | Transaction aborted, `kl:unavailable`, store reopened (REQ-LOOM-043); no success acknowledged |
| Store corruption (`integrity_check` fails) | No service; `loom status` reports it; restore from backup leads to rollback review |
| broker unavailable | No claims, enrollments, cancels; workflows keep their status; cancel returns `kl:unavailable` (the tombstone is committed and finished later) |
| gate unavailable | Commits wait; prepared effects stay; status `waiting` (`effect:`) |
| ledger unavailable | Receipt-requiring replies wait up to 30 s then `kl:unavailable`; outbox keeps rows; no state is lost |
| vault unavailable | Steps that need a unit key are retried with backoff; the workflow keeps its status (`running`, `step:<ws-…>`); nothing is decrypted or recorded without the key |
| hearth unavailable | Owners treated as locked (REQ-LOOM-064) |
| aide unavailable | Agent steps wait; claims retried with backoff |
| Attempt crash | REQ-LOOM-024 |
| Claim `kl:conflict` | Rollback check (§4.9, §4.12) |
| Definition revoked | `blocked-by-authority` (`definition-revoked`); migrate or cancel |
| Decision expired or denied | Step outcome `denied` |
| Effect `outcomeUnknown` | `outcome-unknown`; reconcile or owner resolution |
| Trusted time unavailable | Timers beyond the floor wait (`time-untrusted`) |
| Ledger alarm / ledger behind store | Rollback review |

---

## 8. Performance budgets

| Operation | Budget (p99, x86-64-v3 laptop, NVMe) |
|---|---|
| Durable `AttemptHost.record` (≤ 64 KiB) | ≤ 8 ms (one fsync) |
| Transition commit | ≤ 8 ms |
| Claim (store + broker) | ≤ 20 ms |
| `Workflow.cancel` end to end, no open effects | ≤ 300 ms |
| Restart with 1 000 non-terminal workflows (reconciliation, lookups) | ≤ 10 s before serving |
| Idle memory | ≤ 40 MiB plus 64 KiB per active workflow |
| Store growth | ≤ 1.2 × encrypted payload bytes |

---

## 9. Observability

### 9.1 Receipts

Writer `service/loom`; subject = the enrolling principal (`workflow.recover`, `workflow.rollback-detected`: loom itself). Every receipt's `data` has `workflow`, `run`, `n` and `storeSeq` (except the two loom-subject events, which have no `workflow`), plus:

| Event | Additional `data` members |
|---|---|
| `workflow.enroll` | `definition` (`{generation, name, digest}`), `decision`, `resume`, `runWhileLocked`, `horizon`, `account`, `inputDigest` |
| `workflow.claim` | `step`, `attempt`, `epoch`, `kind` |
| `workflow.step` | `step`, `state`, `occurrence`, `outcome` of the previous step |
| `workflow.wait` | `step`, `detail` |
| `workflow.pause` | `detail` |
| `workflow.resume` | `decision` (manual) or `automatic: true` |
| `workflow.outcome-unknown` | `effect` or `step` |
| `workflow.resolve` | `effect` or `step`, `outcome`, `decision` |
| `workflow.migrate` | `fromRun`, `definition`, `decision` |
| `workflow.complete`, `workflow.fail` | `state`, `detail` |
| `workflow.cancel` | `reason` (code, not free text), `openEffects` |
| `workflow.forget` | — |
| `workflow.recover` | `outstanding`, `lastAckedSeq` |
| `workflow.rollback-detected` | `lastAckedSeq`, `unmatched`, `ledgerBehind` |

### 9.2 Metrics

`loom_workflows{status}` (gauge), `loom_claims_total{kind,result}`, `loom_attempt_ends_total{reason}`, `loom_store_commit_seconds` (histogram), `loom_store_errors_total{kind}`, `loom_outbox_depth`, `loom_outbox_reconciled_total{result}`, `loom_effects{state}`, `loom_rollback_state` (0 ok, 1 review, 2 accepted), `loom_paused{detail}`, `loom_catchup_backlog`.

### 9.3 Logs

Structured records (protocols §10.6) with IDs, states and codes only; never decrypted content or tokens.

---

## 10. Configuration

```nickel
# module keylos.loom → /etc/keylos/loom.json
{
  horizonDefault      | Number | default = 2592000,      # 30 days
  horizonMax          | Number | default = 34560000,     # 400 days
  catchUpPerMinute    | Number | default = 6,
  historyRetentionDays | Number | default = 30,
  decisionExpirySecs  | Number | default = 604800,       # 7 days (requested from the broker; never beyond horizon)
  limits = {
    maxActiveWorkflowsPerHuman | Number | default = 32,
    maxObservationBytes        | Number | default = 67108864,
    maxInputBytes              | Number | default = 1048576,
    maxTransitions             | Number | default = 100000,
  },
  heartbeatSecs       | Number | default = 30,
  lockPollSecs        | Number | default = 60,
}
```

Definitions and the default policy limit the horizon further; `horizonMax` never exceeds the protocols maximum (400 days). Configuration changes reach loom through `ServiceHost.reload`.

---
## 11. Testing and acceptance criteria

### 11.1 Unit tests

- Definition validation against every rule of protocols §20.27 (the `vectors/workflow/` suite), including totality of `next`, pointer syntax, limits, `migrateFrom` maps.
- Step and effect ID derivation against the protocols vectors; occurrence counting across loops.
- Engine determinism: replaying a recorded run's outcomes produces the identical step sequence (property test over generated definitions).
- Outbox reconciliation for every row of the §4.11 table against a ledger double; at most one receipt per (`workflow`, `n`) under random crash points.
- AEAD AAD binding (a row moved to another workflow or kind fails); `forgetGen` recheck after asynchronous key fetches.
- Status/detail vocabulary: every emitted value is in the protocols §20.25 table.

### 11.2 Fuzzing

`cargo-fuzz` targets `fuzz_definition`, `fuzz_input_schema`, `fuzz_observation_record`, `fuzz_signal`, `fuzz_outbox_replay`; 8 CPU-hours each before release without crashes.

### 11.3 Fault injection

Development builds read `KEYLOS_DEV_LOOM_FAULTS` (protocols §10.5), a comma list of `crash:<point>` (abort the process at the point), `fsync-fail:<point>` (the next `fsync` at the point returns `EIO`) and `enospc:<point>` (the next write returns `ENOSPC`). Points: `after-record`, `before-complete-commit`, `after-complete-commit`, `after-transition-commit`, `before-claim-rpc`, `after-claim-rpc`, `before-dispatch`, `before-append`, `after-append`, `before-cancel-broker`, `after-cancel-broker`, `after-forget-tombstone`, `blob-link`. `KEYLOS_DEV_LOOM_CLOCK_SKEW_SECS` shifts loom's trusted time for timer and expiry tests.

### 11.4 Integration tests (warden conformance harness)

Tests run in `warden/conformance/s3-loom` (warden-lite, then the S3 supervisor) with real `loomd`, `brokerd`, `ledgerd`, `vaultd`, `hearthd`, the scripted dev-prompt approval path, and: **B** = Phase B, with the documented `gate-double` (§12.4) for `DurableEffects` and `WorkflowBudget` and `loom-test-activity` as the activity; **C** = needs the real `gate` (S6); **D** = needs real `aide`, `bench`, `strata` (S7). Tests marked B are rerun with the real components in C/D. "Restart the stack" means stopping every daemon and relaunching against the same state directories with new sessions and a new broker root key.

| ID | Proposal acceptance row | Setup and fault | Required observation | Stage |
|---|---|---|---|---|
| IT-01 | Kill after recording a step | Activity records observation `model:0` and completes; `crash:after-complete-commit`; restart | The engine continues from the next state; `loom-test-activity` call counter shows the step ran once; no repeated model/tool call | B |
| IT-02 | Kill before recording a result | `crash:before-complete-commit` for activities with `idempotent`, `replayable`, `at-most-once` | idempotent: re-run once; replayable: re-run with `recorded` served (no repeated live call for recorded keys); at-most-once: `outcome-unknown` with `step:` detail until `loom resolve` | B |
| IT-03 | Crash between state transition and dispatch | `crash:after-transition-commit` before the claim/commit outbox row is delivered | The pending claim or commit is delivered after restart with the same step and effect IDs; exactly one `workflow.claim` for it; the double sees one `commit` per effect ID | B |
| IT-04 | Lose executor reply after success | Double executes `x-loom.test-write` (strategy `transactional`), then drops the reply; restart loom | `DurableEffects.lookup` by effect ID returns `succeeded` with the original outcome; the double's write counter is 1 | B |
| IT-05 | Destination ignores idempotency header | Double target configured as `noSafeRetry` (header sent but not honoured); reply lost | Record `outcomeUnknown`; workflow `outcome-unknown`; no second dispatch; `loom resolve` with approval moves on | B |
| IT-06 | Destination dedup window expires | Strategy `downstreamIdempotency` with W = 10 s; loom stopped 30 s mid-dispatch (`KEYLOS_DEV_LOOM_CLOCK_SKEW_SECS`) | After W the record is `outcomeUnknown` (or reconciled when a reconciler is configured); never re-sent | B |
| IT-07 | Resume with a new session/root key | Reboot-style restart of the whole stack between two steps | New attempt sessions; tokens minted from the workflow record under the new broker root work within current policy; a token saved from the old boot is rejected by broker and the double | B |
| IT-08 | Pending approval / decision-before-response crash | Commit needs T3; dev-prompt approves; broker killed after persisting the decision and before replying; restart | The same `dr-` comes back approved; no second prompt; the effect is authorized and executed once (double counter 1); no fabricated authority before approval | B |
| IT-09 | Revoke or expire approval before resume | Decision approved, workflow paused; owner revokes the workflow scope item (`grants revoke`) or the decision expires; resume | Commit blocks: workflow `blocked-by-authority` (`policy` / `decision-expired:`); nothing dispatched until a new decision | B |
| IT-10 | Two owners/stale worker race | Attempt A stalls (SIGSTOP); loom claims attempt B (epoch + 1); A resumes and calls `complete`, `record`, `DurableEffects.prepare` | A gets `kl:conflict`; A's tokens revoked (`kl:revoked` at the double); B's result is the one recorded | B |
| IT-11 | Cancel then crash/reboot | `loom cancel` with an effect `dispatching` at the double; `crash:after-cancel-broker`; reboot | Workflow `cancelled`; no new claim ever (broker refuses); the in-flight effect's outcome is looked up and recorded; no resurrection | B |
| IT-12 | Restore an old workflow database | Copy `loom.db` before a cancel, a consumed effect and a budget charge; restore it after them; restart | `workflow.rollback-detected`; all workflows `rollback-review`; the cancelled workflow stays cancelled; the effect is not dispatched again (double counter 1); the account's spent amount is unchanged; resume only after `loom rollback accept` with presence | B |
| IT-13 | Fresh attempt after private/untrusted input | Activity records an observation labelled `private/untrusted`; next step in a fresh attempt requests egress to a non-sink-safe host | The fresh attempt's session label is `private/untrusted` before its first token is used; the request becomes a declassification (Rule of Two) | B |
| IT-14 | Budget reserve/charge/release crash | Reserve, crash before settle (`crash:before-dispatch`), restart; duplicate completion message from the double | The reservation is settled once (or `unresolved` when the attempt was fenced); spent never resets with the new root; the duplicate settle returns the same entry | B |
| IT-15 | Code upgrade/revocation | Install v2 of the definition's generation during a run; then revoke v1; then `loom migrate` to v2 with `migrateFrom` | The running workflow keeps v1 until revoked; after revocation `blocked-by-authority` (`definition-revoked`); migrate needs a new decision and starts a new run; no old history interpreted under v2 | B |
| IT-16 | Lock and unlock owner | Lock alice's session (hearth), with one normal and one `runWhileLocked` workflow; stop hearth briefly | Normal workflow `paused` (`locked`), no claims or decryption, incoming outcomes still stored; `runWhileLocked` one continues; hearth down → paused; unlock → resumes with catch-up | B |
| IT-17 | Forget with cached keys and pending effects | Workflow with cached unit key and an effect `awaitingApproval`; `loom forget`; inject a delayed `dataKey` reply after the forget | Execution stops; the effect is cancelled at the double; `dataKey` → `kl:revoked`; the late key reply is discarded (forgetGen); after restart the workflow is `forgotten` and cannot be recreated (enroll with the same key yields a new `wf-`) | B |
| IT-18 | Ledger acknowledgment lost | `crash:after-append` and, separately, ledger killed after commit before reply | Reconciliation finds the receipt by submitted digest: exactly one `workflow.*` receipt per (`workflow`, `n`); a never-appended one is submitted once after `workflow.recover` | B |
| IT-19 | Full-store or sync failure | `fsync-fail:after-record`, `enospc:blob-link` | The calls fail `kl:unavailable`; nothing is acknowledged; after the fault clears the state equals the last acknowledged one | B |
| IT-20 | Long downtime / uncertain time | Timers due during 10 days of downtime (`KEYLOS_DEV_LOOM_CLOCK_SKEW_SECS`); boot with untrusted time; a periodic timer | No timer fires before trusted time reaches it (`time-untrusted`); overdue claims ≤ `catchUpPerMinute`; the periodic timer fires once; decisions past expiry are expired, not used | B |
| IT-21 | INV-8 | Cancel, forget and broker-side workflow revocation, each followed by loom restart, reboot and store restore | No claim, registration, token or dispatch of the workflow afterwards | B |
| IT-22 | INV-9 | Policy changed between steps to forbid the activity's net right; stale-epoch worker | The next attempt has no such token; stale worker fully rejected | B |
| IT-23 | INV-10 | Every strategy × crash in `dispatching` against the real gate | Behaviour per protocols §20.26 table; `authorized` never reported as `succeeded` | C |
| IT-24 | INV-11 | Label and budget across 5 attempts and 2 reboots | Label never lower; spent never lower; each key settled once | B (C with real gate metering) |
| IT-25 | INV-12 | All fault points of §11.3 | No acknowledged operation lost; no failed barrier acknowledged | B |
| IT-26 | — | Manual vs automatic resume after reboot | Manual: `awaiting-resume` until `loom resume`; automatic: reclaimed without a prompt | B |
| IT-27 | — | Guest or agent session calls `Loom.enroll` | `kl:denied`, nothing stored at the broker | B |
| IT-28 | — | Real gate: `fs.merge` via `BenchMerge.commitPrepared` after a reboot between approval and commit | Fresh attempt commits the retained prepared merge once; stale live tree → `kl:conflict` → back to `edit` with a new effect ID and approval | C/D |
| IT-29 | — | Agent attempt: aide VM crash mid-`edit` | `LoomSystem.ended(crashed)`; new attempt replays recorded model responses (no repeated provider call for recorded keys, gate metering shows no charge for them) | D |
| IT-30 | S7 exit | `coding-task` end to end with a reboot after approval | One approval per prepared merge; merge committed once; push reconciled; all receipts verify | D |

### 11.5 Conformance

The protocols `vectors/workflow/`, `vectors/ids/`, `vectors/receipts/` and `vectors/presence/` suites.

### 11.6 Acceptance criteria for 1.0

1. IT-01 … IT-22 and IT-24 … IT-27 pass in Phase B; IT-23 and IT-28 with the real gate; IT-29 and IT-30 with real aide, bench and strata.
2. §8 budgets met.
3. No `unsafe` in `loomd`, the CLI or the SDK.
4. The INV-8 … INV-12 tests are part of the warden conformance gate.

---

## 12. Implementation notes

### 12.1 Crates

| Crate | Purpose |
|---|---|
| `rusqlite` 0.32 (bundled SQLite, WAL) | Store |
| `capnp` 0.20, `capnp-rpc` 0.20 (via `keylos-capwire`) | RPC |
| `tokio` 1.x | Runtime |
| `jsonschema` 0.26 | Input and signal schema validation (2020-12, no remote refs) |
| `aes-gcm` 0.10, `chacha20poly1305` 0.10 | AEAD |
| `keylos-ids`, `keylos-formats` | IDs, definitions, receipts, mandates (protocols §18) |
| `keylos-vault-client` | `SecretBuf` for unit keys |
| `keylos-presence` | `loom.rollback-accept` verification |

### 12.2 Repository layout

```
loom/
  crates/loomd/            store, engine, dispatcher, outbox, rollback, capwire server
  crates/loom-cli/         CLI
  crates/keylos-loom-sdk/  AttemptHost client, replay helper, definition builder and validator
  crates/gate-double/      Phase B test double (development images only)
  crates/loom-test-activity/
  schema/loom-local.capnp  repo-local (§5.2)
  definitions/test/        test definitions shipped in io.keylos.loom.test-activity
  tests/                   fault-injection and conformance tests
  generation/              manifests for io.keylos.loom, io.keylos.loom-cli and the test generations
```

### 12.3 Build

`forge` recipe `pkgs/system/loom.ncl`; reproducible; static musl; development features (`dev`) only in development images.

### 12.4 Test artifacts (development images only)

- **`gate-double`** serves `DurableEffects` and `WorkflowBudget` on a route named `gate#loom` (and `gate#client` for attempts) in the conformance harness. It implements the protocols §20.26 state machine for the single kind `x-loom.test-write` (an append to a counter file it owns; the test policy fixture registers the kind as `compensable`, so the default `compensable-commit` rule at tier t2 applies, protocols §22.4), with the strategy, a deduplication window, reply dropping and delays configurable per test. It verifies the preparing attempt with `BrokerWorkflow.verify(binding, <session from ServiceHost.accept>)` instead of Biscuit tokens, calls the real broker's `authorizeEffect`, checks a delivered mandate's `constraints.workflow`, payload digest and single consumption, and verifies the mandate signature when it has a `ledger#reader` route (`Ledger.serviceKey("broker")`); it keeps its records in its own SQLite file. The real `gate` always verifies tokens and signatures. It is a documented double, not `gate`: it proves loom's contract behaviour, not egress or rendering.
- **`loom-test-activity`** is a deterministic process activity: it reads its input, records configured observations, prepares `x-loom.test-write` effects and completes, crashing at configured points.

### 12.5 SDK (`keylos-loom-sdk`)

Worker side: connect `loom#attempt` from `KEYLOS_CAPWIRE_FDS`, `task()`, a replay helper that answers repeated requests from `recorded` by key and records new ones before returning them, `effect()` + `DurableEffects.prepare`, `complete`/`fail`, heartbeats. Author side: a typed builder that emits canonical `keylos.workflow/1` and runs the validator used by `loomd`.

### 12.6 External runtimes (informative)

An existing durable runtime (for example Temporal or Restate) MAY replace loom's built-in engine behind the same `Loom`/`AttemptHost` contract in a later version, only if it runs locally without network services, keeps its history in a store that meets §4.2–§4.3 (encrypted per workflow, forgettable by key destruction, durability barriers), leaves authority to `broker` and effects to `gate` with the protocols §20.26 strategies, supports ownership fencing by epoch, and keeps the receipt outbox and rollback anchoring. Its advertised execution semantics do not by themselves satisfy these requirements.

---

## 13. Decisions and alternatives

The eight decisions the durable-execution proposal left open are settled as follows ([ADR-0068](../../handbook/11-decisions/adr-0068-durable-workflows-loom.md)):

| # | Decision to settle | Decision | Rationale |
|---|---|---|---|
| 1 | Coordinator ownership | A separate small service `loom`, outside the trusted core; not hosted by aide. Phase B tests it with a regular test activity, so nothing depends on aide existing | Keeps orchestration out of aide's agent-facing attack surface and makes non-agent workflows possible; authority stays in broker and gate |
| 2 | Runtime and store | Built-in engine of explicit versioned state machines (`keylos.workflow/1`) with an SDK; SQLite WAL `synchronous=FULL` with checked barriers, per-workflow AES-GCM under `loom:` vault units; local only. External runtimes are an informative later option (§12.6) | Small, auditable, deterministic; SQLite gives transactional outbox rows and mature crash recovery (also used by vault) |
| 3 | Identity, fencing and versioning | Distinct `wf-`/`wr-`/`ws-`/`wa-`/`fx-`/`dr-`/`ba-` IDs and an ownership epoch advanced by every broker claim; step and effect IDs derived deterministically; new negotiated interfaces (`loom.capnp`, `loom-sys.capnp`) instead of optional fields older executors would ignore | Derived IDs survive store loss; epochs give every consumer a cheap stale-owner check; old servers fail closed |
| 4 | Durable approvals and fresh-attempt authorization | Broker durable decisions keyed by (workflow, logical key), digest without sessions, persisted before prompt and reply, fixed expiry, explicit `rebind`; effect decisions consumed once per effect ID by gate; attempt tokens minted from the workflow record at registration under current policy; presence never inherited | Separates logical decisions from boot-local prompts and tokens; no historical approval becomes standing authority |
| 5 | Labels, budgets, cancellation, rollback | Label high-water mark in the broker restored before grants; one durable gate budget account per workflow with keyed reserve/settle/release; durable broker cancellation record plus loom tombstones; ledger-anchored rollback detection, no new NV index | Each guarantee has one authoritative owner; the ledger's NV-counter protection is reused transitively |
| 6 | Executor retry and dedup retention | Every executor declares one of four strategies; unknown outcomes are explicit and never retried blindly; dedup records kept ≥ max(horizon, window, terminal + 30 d); workflows bounded by a horizon | Makes "exactly once" claims honest and retention part of correctness |
| 7 | History retention, lock, key cache, forget boundary | History until forgotten or 30 days after terminal; `loom:` units system-wrapped with an explicit lock policy (user-owned workflows pause while the owner is locked unless `runWhileLocked` with presence); key cache with forget generations and post-fetch rechecks; forget leaves only ID tombstones | Recording outcomes must work while locked; execution must not; forgetting must not leave decryptable copies |
| 8 | Prepared merges and writer exclusion | Prepared merges are bound to the workflow (`bindWorkflow`), reachable by a fresh attempt (`preparedFor`, `commitPrepared` by `pm-` id) with an idempotent completion record (`PreparedMerge.status`); writer exclusion stays strata's `fenceWriters` at commit | Reuses ISS-003's immutable prepared merge; no session ancestry needed after a reboot |

Further decisions:

| Decision | Alternatives rejected | Rationale |
|---|---|---|
| loom holds no tokens; gate commits with broker authorization | loom holds workflow tokens; attempts commit effects themselves | A compromised coordinator cannot exceed current policy; commits need no live worker |
| Fresh sessions per attempt, binding verified by the broker | Re-using a serialized principal or token across restarts | Boot-scoped authority stays boot-scoped |
| Deterministic effect IDs from step IDs | Random IDs persisted once | Survives loss or restore of loom's store; gate dedups across it |
| Receipt outbox reconciled through the ledger's time order | Exactly-once claims from append; a ledger dedup feature | Works with the existing append API; the ledger stays evidence only |
| Ledger-anchored rollback detection | A new TPM NV counter for loom | No NV wear or new index; the ledger counter already anchors |
| SQLite | redb | Mature WAL recovery, integrity checks and tooling; vault precedent |
| Interpreted JSON state machines | Workflow code in a language runtime | Determinism and pinning are checkable; no code runs in loom |
| Pause while locked by default | Run while locked by default; tie to K_user wrapping | Durable work must not silently continue for an absent user, yet outcomes must still be recorded |
