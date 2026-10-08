# keylos/journal: structured logs, metrics and crash reports

| | |
|---|---|
| Repository | `github.com/keylos-os/journal` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | Service generation `io.keylos.journal` (binaries `journald-kl` and `journal-unwind`); helper `/usr/lib/keylos/journal/coredump` (invoked through the kernel's `core_pattern`; shipped in the OS generation); CLI `journal`; crate `keylos-journal-client` (record and metrics encoder for Rust programs) |
| Depends on | `keylos-protocols 1.0`. Runtime services: `warden`, `ledger`, `vault` (crypto-shred unit keys, facet `journal`), `broker` (label authority), `atrium` (notifications) |
| Provides | `Journal` (protocols §7.3.15); `JournalWarden`, `Crashes`, `Metrics` (protocols §7.5.9); the on-disk log store; OpenMetrics exposition; confidential crash reports |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`journal` collects every log line and metric sample produced on the machine. It tags each with the principal that produced it, taken from the stream and never from the content, stores them compactly and encrypted per human, and answers queries.

It also turns crashes into **confidential crash reports**. By default a report is a symbolised stack trace without process memory, readable only by the human the crashed principal acted for.

**Non-goals:**
- **Receipts.** `ledger` is the audit log; logs are diagnostic data, not evidence.
- **Remote log shipping.** It is optional, goes through `gate` as ordinary egress, and is configured by `fleet` or the owner.
- **Kubernetes container log files.** `cri` writes the CRI log files kubelet expects; `journal` receives the pod principals' own diagnostic streams like any other principal's.

---

## 2. Context and embedded contracts

The contracts below are copied **verbatim** from `keylos/protocols` 1.0.0 (final). Section numbers and cross-references inside the excerpts refer to protocols. If an excerpt differs from protocols, protocols wins.

### 2.1 Principal identifiers (protocols §3.3, §3.4)

- **Generation names** use reverse-DNS: `org.example.Editor`. The pattern is `^[a-z][a-z0-9-]*(\.[a-zA-Z0-9-]+){2,}$`, at most 255 characters. The prefixes `io.keylos.` and `org.keylos.` are reserved for the project.
- **Service names** are `[a-z][a-z0-9-]{0,62}` (for example `vault`, `portal-files`). The registry is §19.1.
- **Facet names** are `[a-z][a-z0-9-]{0,31}`. The registry is §19.2.
- **Usernames** are `[a-z_][a-z0-9_-]{0,31}`. `_system` and `_cluster` are reserved, and the prefix `guest-` is reserved for ephemeral guest sessions (`guest-<8 lowercase base32>`, created and destroyed by `hearth`).
- **Kubernetes names**: `pod-ns` and `pod-name` follow Kubernetes DNS-1123 label / subdomain rules (`[a-z0-9]([-a-z0-9]*[a-z0-9])?`, ≤ 63 and ≤ 253 characters).

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

### 2.2 `common.capnp` and errors (protocols §7.3.1)

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

### 2.3 `journal.capnp` (protocols §7.3.15, the `journal.capnp` block; implemented)

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

### 2.4 `journal-sys.capnp` (protocols §7.5.9, implemented)

```capnp
@0xc7a1e5d3b2f40028;
using C = import "common.capnp";

interface JournalWarden {          # facet warden
  attach     @0 (principal :C.PrincipalId, session :C.SessionId, stream :C.Fd) -> ();   # journal-side end; warden keeps a dup
  heartbeats @1 (watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);   # service names emitting watchdog records
}

struct CrashInfo { id @0 :Text; principal @1 :C.PrincipalId; generation @2 :C.Ref; signal @3 :Int32;
                   time @4 :C.Timestamp; backtrace @5 :Text; coreKept @6 :Bool; }

interface Crashes {                # facets client (own human), admin
  list    @0 (limit :UInt32) -> (list :List(CrashInfo));
  core    @1 (id :Text) -> (core :C.Fd);         # decrypted core as sealed memfd; raises the reader's label to the crash's label
  forget  @2 (id :Text) -> ();
  setKeep @3 (generationName :Text, keep :Bool) -> ();
}

interface Metrics {                # facets client (own principals), admin, fleet
  scrape @0 (filterJson :Text) -> (openMetrics :Text);
}
```

### 2.5 Log records (protocols §10.6)

Processes write logs to the journal stream fd (fd 2 is connected to it by default) as:
- plain text lines, or
- **structured records**: a datagram whose first byte is `0x1E` followed by a CBOR map with keys `l` (level 0–7), `m` (message) and `f` (fields map), or
- **metrics records**: a datagram whose first byte is `0x1F` followed by a CBOR map with keys `n` (metric name), `t` (`"counter"` | `"gauge"` | `"histogram"`), `v` (number, or for histograms a map of bucket bound → count plus `sum` and `count`) and `l` (labels map).

Levels follow syslog: 0 emerg, 1 alert, 2 crit, 3 err, 4 warning, 5 notice, 6 info, 7 debug.

### 2.6 Labels (protocols §14.1)

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

### 2.7 Code integrity: the core-dump helper (protocols §9.3, excerpt)

- **Core dumps.** The kernel `core_pattern` pipe helper (`|/usr/lib/keylos/journal/coredump %P %s %t`) is started by the kernel in the root cgroup. This is the one userspace exception to "only the warden core runs in the root cgroup": the helper is an OS-generation binary, installs its own seccomp filter before reading any input, and **moves itself** into `/keylos.slice/system.slice/journal-coredump.scope` before reading the dump (cgroup v2 delegation rules allow only a process in the root cgroup's domain with root credentials to make that move; `journal` cannot). `journal` verifies the move and refuses dumps from a helper still in the root cgroup. `kl-exec`'s `bpf` rule does not depend on cgroup membership, so the exception grants it nothing. The helper is not exempt from `ptrace_access_check` either: it reads only `/proc/%P/{cgroup,status}` (not ptrace-guarded) and takes the crashed process's file mappings from the core's `NT_FILE` note, never from `/proc/%P/maps`.

### 2.8 Consumed interfaces

| Interface (protocols §) | Facet held by journal | Methods called |
|---|---|---|
| `Supervisor` (§7.3.2) | `warden#service` | `identify` (crash attribution), `spawn` (`journal-unwind`) |
| `LabelAuthority` (§7.5.2) | `broker#label-authority` | `labelOf`, `raiseFor` |
| `Vault` (§7.3.6) | `vault#journal` | `dataKey`, `forget` for units `journal:logs:<scope>` and `journal:crash:<human>` |
| `Ledger` (§7.3.5) | `ledger#writer` | `append` (`journal.segment`), `query` (for `journal verify`) |
| `TrustedPrompt` (§7.3.4) | `atrium#notify` | `notify` (crash announcements) |
| `Gate` (§7.3.7) | `gate#client` | `connect` (optional forwarding) |

#### 2.8.1 `warden.capnp` (protocols §7.3.2)

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

#### 2.8.2 `broker-sys.capnp` (protocols §7.5.2)

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

#### 2.8.3 `vault.capnp` (protocols §7.3.6)

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

#### 2.8.4 `ledger.capnp` (protocols §7.3.5)

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

### 2.9 Secret delivery (protocols §20.10)

Unit keys from `Vault.dataKey` arrive in this format.

- **Primary:** a `memfd_secret(FD_CLOEXEC)` fd of the value's length plus 8, rounded up to the page size, laid out as `u64 little-endian length ‖ value ‖ zero padding`. secretmem fds are readable only through `mmap`; recipients map them `PROT_READ`, read the length, use the bytes, and zeroize and unmap on drop (`keylos-vault-client::SecretBuf`).
- **Fallback** (when `memfd_secret` is unavailable): a `memfd_create(MFD_CLOEXEC|MFD_ALLOW_SEALING|MFD_NOEXEC_SEAL)` fd with the same layout, sealed `F_SEAL_WRITE|F_SEAL_SHRINK|F_SEAL_GROW|F_SEAL_SEAL`. The receipt records `data.delivery = "memfd-sealed"`.

### 2.10 Receipts (protocols §13.1, §19.3)

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

| Event | Writer |
|---|---|
| `journal.segment` | journal |

**Extension rule.** A repository MAY emit additional events named `x-<repo>.<event>` (for example `x-strata.replica.send`). They MUST be listed in that repository's spec, MUST be written only by that repository's services, and carry no semantics for other components. Events named without a prefix MUST appear in this table.

`journal` writes `journal.segment` and no other events.

### 2.11 Facets (protocols §19.2, `journal` rows)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| journal | `client` | every principal | `writer`, `query`/`follow` (own), `Crashes` (own human), `Metrics` (own) |
| journal | `admin` | owner `shell` | all |
| journal | `warden` | warden | `JournalWarden` |
| journal | `fleet` | fleet | `Metrics` (aggregate, no user data) |

### 2.12 Files read from other repositories

`journal` reads no file written by another repository (protocols §10.7). Its configuration is the rendered file `/etc/journal/journal.toml` (§10), produced by `config` from the `journal` module.

---

## 3. Requirements

### 3.1 Ingestion

- **REQ-JOURNAL-001** Each principal MUST have its own writer stream.
  - `warden` creates the `SOCK_SEQPACKET` pair and gives one end to the principal (fd 2, and fd 1 unless mapped).
  - `warden` keeps a duplicate of the other end and attaches it with `JournalWarden.attach(principal, session, stream)`. `session` MUST equal the principal's last session (`kl:invalid` otherwise); a second attach for the same session replaces the first.
  - `journal` MUST attribute every datagram on that stream to that principal. Principal-like fields in the content MUST be ignored for attribution: they are stored as fields prefixed `claimed.`.
  - `Journal.writer()` returns an additional stream attributed to the caller (facet `client`).
- **REQ-JOURNAL-002** Streams are `SOCK_SEQPACKET`; a datagram is one record. A datagram that starts with neither `0x1E` nor `0x1F` is text:
  - it is split at `\n`, one entry per line;
  - a trailing `\r` is stripped;
  - invalid UTF-8 is replaced with U+FFFD;
  - the level is 6, unless the line starts with `<N>` (N in 0–7), which sets the level and is stripped.
- **REQ-JOURNAL-003** Structured records (`0x1E`) MUST be CBOR maps with `l` (uint 0–7), `m` (text ≤ 64 KiB) and an optional `f` (map text → text|int|float|bool|bytes, ≤ 64 KiB in total). Invalid structured records are stored as text entries with the field `journal.invalid=1`.
- **REQ-JOURNAL-004** Metrics records (`0x1F`) MUST follow protocols §10.6: keys `n`, `t`, `v` and `l`.
  - Records are accepted from every principal.
  - A principal may hold at most 256 live series (4 096 for tier-0 services). Further series are dropped and counted in `journal_dropped_total{reason="series"}`.
  - Metric names starting with `journal_`, `warden_`, `broker_` or any other registered service name prefix (protocols §19.1) are accepted only from that service.
- **REQ-JOURNAL-005** Per-principal rate limit:
  - 10 000 entries per 10 s and 16 MiB per 10 s, with bursts of 2×;
  - excess entries are dropped and replaced by one summary entry `journal.suppressed=<n>` per window.
- **REQ-JOURNAL-006** Kernel messages from `/dev/kmsg` MUST be ingested with principal `kernel@_system/s-<boot ULID>`. On first start after boot, the initrd records already in the ring buffer MUST be imported.
- **REQ-JOURNAL-007** Records MUST be timestamped by `journal` on receipt (`CLOCK_REALTIME` and `CLOCK_MONOTONIC`). Client-supplied times are stored as `claimed.time`.
- **REQ-JOURNAL-008** Records whose fields contain `watchdog=1` from a tier-0 service MUST be reported on `JournalWarden.heartbeats` as that service's name.

### 3.2 Storage

- **REQ-JOURNAL-010** Entries MUST be stored in per-boot, append-only segment files (§4.2) under `/var/lib/keylos/journal/logs/<boot-id>/`, one segment set per **scope**:
  - `_system` (services and the kernel);
  - `_cluster` (pod principals, protocols §3.4);
  - each human (username), including `guest-…` humans.

  A human's logs are therefore crypto-shreddable as a unit.
- **REQ-JOURNAL-011** Each scope's segments MUST be encrypted with the unit key `journal:logs:<scope>`, using AES-256-GCM per block. **Guest scopes** (usernames with the reserved prefix `guest-`, protocols §3.3) are the exception: their key is generated randomly in `journald-kl`'s memory, never obtained from or stored in `vault`, and destroyed with the scope (REQ-JOURNAL-014).
- **REQ-JOURNAL-012** Retention:
  - total size ≤ `maxBytes` (default 2 GiB, or 5% of `/var`, whichever is smaller);
  - age ≤ `maxAgeDays` (default 30);
  - the oldest sealed segments are deleted first;
  - each human scope is capped at 50% of `maxBytes`.
- **REQ-JOURNAL-013** A segment is sealed at 64 MiB, at shutdown, or after 1 h. When sealed, its SHA-256 MUST be recorded in a `journal.segment` receipt, which gives tamper evidence for sealed segments. Guest scopes are never sealed into receipts.
- **REQ-JOURNAL-014** When the last stream attributed to a guest human closes (the guest session ended), `journal` MUST delete that scope's segments and zeroize its key within 10 s. Guest segments left over from a crash or power loss are unreadable (the key existed only in memory) and MUST be deleted at the next start.

### 3.3 Query and access control

- **REQ-JOURNAL-020** `query` and `follow` MUST return only entries the caller may read:

  | Caller | Readable entries |
  |---|---|
  | A human's `shell` principal (facet `client`) | Its own human scope |
  | The owner's `shell` (facet `admin`) | Every scope |
  | An app (facet `client`) | Only its own principal's entries (same generation name, same human) |
  | An agent (facet `client`) | Only its own session subtree |
  | Tier-0 services | Nothing, except with facet `admin` |
- **REQ-JOURNAL-021** Before returning entries labelled `private` or `secret` (field `label.conf`), `journal` MUST raise the reader's session label with `LabelAuthority.raiseFor(readerSession, maxLabel, "journal read")` (protocols §14.1).
- **REQ-JOURNAL-022** The filter language (§4.4) MUST be total. Every filter terminates and is bounded by `limit` (at most 10 000 per call) and a 2 s budget, enforced as a wall-clock bound on the scan. A `query` response MUST NOT exceed 3 MiB of entries (a capwire datagram is at most 4 MiB, protocols §7.1): `journal` returns fewer entries than `limit` and a cursor to continue whenever the next entry would cross 3 MiB or the budget is spent.

### 3.4 Crash reports

- **REQ-JOURNAL-030** `kernel.core_pattern` MUST be `|/usr/lib/keylos/journal/coredump %P %s %t` (protocols §9.3), with `kernel.core_pipe_limit=4` and global `fs.suid_dumpable=0`.
- **REQ-JOURNAL-031** The helper runs as the kernel's usermode helper: root, in the initial namespaces, in the root cgroup. It MUST, in this order and before reading any input:
  1. open everything it will use: `/run/keylos/journal/coredump.sock` (connect), `/sys/fs/cgroup/keylos.slice/system.slice/journal-coredump.scope/cgroup.procs` (`O_WRONLY`), and `pidfd_open(%P)` plus a `/proc/<%P>` dirfd;
  2. install its own seccomp filter: `read`, `write`, `sendmsg`, `openat` relative to the pre-opened `/proc` dirfd only (`cgroup`, `status`), `close`, `exit_group`; everything else kills the helper (so the helper never drops an fd it holds after this step: Rust debug builds' `OwnedFd` drop calls `fcntl`; the kernel closes them at exit);
  3. write its own PID into the pre-opened `journal-coredump.scope/cgroup.procs`, leaving the root cgroup.

  Under cgroup v2 delegation rules the process being moved from the root cgroup needs write access to the root's `cgroup.procs` (the common ancestor), which only a root process has, so the helper performs the move itself; `journald-kl` **verifies** it (REQ-JOURNAL-032) and the move completes within 1 s of the helper's start (protocols §9.3).

  The helper then only:
  - reads `/proc/%P/{cgroup,status}` through the pre-opened dirfd (neither is ptrace-guarded; `/proc/%P/maps` is, and `kl-exec` refuses it to every task, protocols §9.3);
  - reads the core from stdin, up to the default limit of 512 MiB (it cannot read `journal.toml`; `journald-kl` applies the configured `coreLimitBytes` and marks a cut core `journal.crash.truncated`);
  - forwards the core stream, the pidfd and the metadata to `journald-kl` over the connected socket;
  - exits.

  It MUST NOT parse the core.
- **REQ-JOURNAL-032** `journald-kl` MUST take the helper's pidfd through `SO_PEERPIDFD` at `accept` (valid: the helper itself `connect()`s to journald's listening socket; protocols §7.1). The helper connects before it moves (REQ-JOURNAL-031), so `journald-kl` checks the helper's cgroup when the helper's first frame arrives, retrying for up to 1 s. `journald-kl` runs in its own cgroup namespace rooted at its scope `/keylos.slice/system.slice/journal.scope`, so it resolves the cgroup path it reads against that root and requires exactly `/keylos.slice/system.slice/journal-coredump.scope`. A helper in any other cgroup (the root cgroup included) is refused (its data dropped and counted in `journal_dropped_total{reason="coredump-cgroup"}`). It then MUST:
  - attribute the crash to the principal of the crashed process's cgroup (`Supervisor.identify` on the forwarded pidfd), **before** acknowledging the helper: the kernel keeps the crashed process only while the helper runs (`core_pipe_limit`);
  - produce a **minimal report**: the signal; a symbolised backtrace of the crashing thread from the core's registers and stack, using `.eh_frame` from the generation's store objects plus debuginfo generations when installed; and the generation ref;
  - discard the core unless the human opted in (`keepCores`) for that generation. Kept cores are encrypted under `journal:crash:<human>`.
- **REQ-JOURNAL-033** Cores of principals whose session label is `secret` (`LabelAuthority.labelOf`) MUST never be kept, regardless of opt-in. Cores of agent sessions are kept only when the owner listed the agent template's name in `keepAgentCores` **and** the human opted in. Cores of guest and pod principals are never kept.
- **REQ-JOURNAL-034** Crash reports MUST be visible to the human through `journal crashes` (`Crashes.list`). On facet `client`, a `shell` principal of a person sees every crash report of its human; an app or agent principal sees only reports of its own generation name and human (the reader rule of REQ-JOURNAL-020); tier-0 services, `_system` and `_cluster` principals see none. `atrium` announces them through `notify` (severity `warning`), coalesced to one per generation per hour.
- **REQ-JOURNAL-035** `Crashes.core(id)` MUST raise the reader's label to the crash's label with `LabelAuthority.raiseFor` before returning the decrypted core as a sealed memfd.

---

## 4. Design

### 4.1 Ingestion path

```
principal fd 2 ──SEQPACKET──► journald-kl reader task (one per stream, tokio)
       │                          ├─ decode (text | 0x1E record | 0x1F metrics)
       │                          ├─ attach: principal, session, gen, tier, human, label (cached from labelOf), boot id, seq
       │                          ├─ rate limit
       │                          └─ append to in-memory block (per scope) ─► segment writer (fsync policy)
/dev/kmsg ───────────────────► kmsg reader ─► same
coredump helper ─────────────► crash pipeline (§4.5)
```

**Scope selection:** `_system` for humans `_system` and the kernel; `_cluster` for human `_cluster`; otherwise the principal's human.

**fsync policy:** on each block flush (every 64 KiB or 1 s), and immediately for level ≤ 3.

**Label cache:** `labelOf` results are cached per session for 5 s. Labels only go up, so a stale cache only under-labels for at most 5 s, and REQ-JOURNAL-021 re-queries at read time.

### 4.2 Segment format

```
segment file: <scope>-<seq>.klj
header (64 B): magic "KLJ1", version u16, scope (human name, 32 B padded), boot id (16 B), created (i64 ns)
blocks:        [len u32][nonce 12 B][AES-256-GCM(ciphertext of zstd(CBOR array of entries))][tag 16 B]
               AAD = header bytes ‖ block index (u64 BE)
footer on seal: [index offset u64][entry count u64][min time][max time][sha256 of all preceding bytes]
index (encrypted like a block): per block {offset, first time, last time, principal set bloom (1 KiB)}
```

Entry CBOR: `{t: realtime ns, m: monotonic ns, p: principal, l: level, msg: text, f: map, seq: u64, lb: [conf, integ]}`.

**Key handling:**
- Keys come from `Vault.dataKey("journal:logs:<scope>")` (facet `journal`) in the delivery format of protocols §20.10: a `memfd_secret` fd read through `mmap`, holding a u64 little-endian length and the key. They are copied into locked memory and cached while the scope's human is unlocked; for `_system` and `_cluster`, while the system runs.
- While a human is locked (suspend or lock screen), new entries for that scope are buffered in memory under an ephemeral key (at most 8 MiB) and re-encrypted when the human unlocks. If the buffer overflows, entries are dropped with a count.
- Guest scopes use an in-memory random key (REQ-JOURNAL-011).

### 4.3 Metrics

**Semantics** (record format: protocols §10.6):
- `counter` values are cumulative per writer. `journal` keeps the latest sample per (principal, name, labels) in an in-memory table of at most 100 000 series; the oldest series are evicted.
- `gauge` values replace the previous sample.
- `histogram` values carry the bucket map plus `sum` and `count`.
- Samples are downsampled to 1-minute aggregates in metrics segments (`/var/lib/keylos/journal/metrics/metrics-<seq>.klm`), which use the same block format and are retained for 7 days.

**Exposition:** `Metrics.scrape(filterJson)` returns OpenMetrics text with labels `principal_kind`, `generation_name` and `human`:
- on facet `client`, only the caller's own principals;
- on facet `admin`, everything;
- on facet `fleet`, aggregates per generation name with the `human` label removed, and no per-session series.

`keylos-journal-client` provides `metrics!` macros that emit `0x1F` records.

### 4.4 Filter language (`filterJson`)

```json
{
  "since": "2026-10-07T00:00:00Z",          // or {"boot": 0} for the current boot, {"boot": -1} for the previous one
  "until": "…",
  "principal": "app:gen:fsv256:…@alice/",   // prefix match on the principal text
  "generationName": "org.example.Editor",
  "session": "s-…",                          // includes descendants
  "level": 4,                                 // max level (≤ 4 = warning and worse)
  "match": {"field": "value"},               // exact match on fields (AND)
  "text": "connection refused",              // case-insensitive substring of the message
  "kernel": false,
  "after": "<cursor>"
}
```

- All keys are optional; keys combine with AND.
- The cursor is opaque: base64 of `(scope, segment seq, block, entry index)` plus the entry's `(time, seq)`. Continuation compares `(time, seq)`, so a cursor stays valid across segment sealing and retention.
- Evaluation scans the index blooms first, then decrypts the matching blocks.

### 4.5 Crash pipeline

1. Accept the helper connection; verify the helper left the root cgroup (REQ-JOURNAL-032). Receive `{pid, signal, time, comm, dumpable}`, the pidfd and the core stream fd.
2. Resolve the principal with `Supervisor.identify(pidfd)`.
3. Read the core into a sealed memfd. Parse the ELF core with a bounded parser: at most 512 MiB and at most 4 096 segments.
4. Map files to store objects. The mapped files come from the core's `NT_FILE` note (start, end, offset, path in the crashed principal's view); each is matched by path against the crashed principal's generation mount. Its store object is read **read-only** from `/store/objects` (`journal-unwind`'s view includes `/store/objects` read-only; store objects are `public/trusted`).
5. Unwind the crashing thread with `.eh_frame` and `.debug_frame`. Symbolise from `.symtab`/`.dynsym`, plus DWARF from a `<name>-debug` data generation when installed.
6. Produce the report `{principal, generation, signal, time, backtrace: [{pc, module, symbol, file?, line?}], threads: n, coreKept: bool, label}`. Store it as a log entry at level 2 with field `journal.crash=1`, plus a crash index entry.
7. Keep or discard the core per REQ-JOURNAL-032/033. Kept cores go to `/var/lib/keylos/journal/cores/<human>/<ulid>.core.enc`, encrypted under `journal:crash:<human>`, and are retained for 7 days or until `journal forget-crashes`.

**Sandboxing.** Steps 3–5 run in `journal-unwind`, a child of `journald-kl` spawned through `Supervisor.spawn` on facet `warden#service` with `actorKind = service` and entrypoint `unwind` of the journal generation (a service child, protocols §22.7). It runs with:
- the `baseline-1` seccomp profile and none of `journal`'s service privileges;
- no network;
- no routes other than its pipe to `journald-kl`;
- fd conventions: the sealed core memfd as fd 0 and the report pipe as fd 1; the store-object dirfd is passed as an additional explicit fd.

The unwinder parses untrusted data (a crashed process may be malicious), so it must not run inside the main service.

### 4.6 Forwarding (optional)

`forward` config entries define remote sinks: syslog over TLS (RFC 5425) or OTLP/HTTP logs. Forwarding:
- uses `gate.connect` with the configured host grants;
- sends only the `_system` and `_cluster` scopes, plus human scopes whose human enabled forwarding (never guest scopes);
- is filtered by level.

Entries with `conf ≥ private` are never forwarded unless the host is marked `sink-safe` in policy (protocols §14.1).

### 4.7 Crypto-shredding

- `journal forget --human <h>` (owner, facet `admin`) calls `Vault.forget("journal:logs:<h>")` and `Vault.forget("journal:crash:<h>")`, then deletes the scope's files.
- When `hearth` deletes a user with `forgetData`, `vault` destroys the user's units; `journal` notices it at the next `dataKey` call, which answers `kl:revoked` (the unit name stays tombstoned, protocols §22.7; `kl:not-found` is treated the same), and deletes that scope's segments. The unit name cannot be reused, so entries for that scope that still arrive (from principals of the deleted human that have not ended yet) are dropped and counted in `journal_dropped_total{reason="shredded"}`.

---

## 5. Interfaces

### 5.1 `Journal` (protocols §7.3.15)

| Method | Facet | Semantics |
|---|---|---|
| `writer()` | `client` | Returns a stream attributed to the **caller's** principal, for example a second stream per thread |
| `query(filter, limit)` | `client`, `admin` | REQ-JOURNAL-020..022 |
| `follow(filter, watcher)` | `client`, `admin` | Live tail with the same access control. The watcher receives entries in order; slow watchers are dropped after a 4 MiB backlog |

### 5.2 `journal-sys` interfaces (protocols §7.5.9)

| Interface | Facet | Semantics |
|---|---|---|
| `JournalWarden.attach` | `warden` | Registers a stream for (principal, session); a second attach for the same session replaces the first (after a `warden` restart) |
| `JournalWarden.heartbeats` | `warden` | Emits a service name for each `watchdog=1` record from that service (REQ-JOURNAL-008) |
| `Crashes` | `client` (REQ-JOURNAL-034), `admin` | `list`, `core` (REQ-JOURNAL-035), `forget`, `setKeep` |
| `Metrics` | `client` (own principals), `admin`, `fleet` (aggregate) | §4.3 |

### 5.3 CLI `journal`

| Command | Description | Exit |
|---|---|---|
| `journal [-f] [--since T] [--until T] [--boot N] [--principal P] [--app NAME] [--session S] [--level L] [--grep TEXT] [--match k=v]… [--json] [-n N]` | Query or follow | 0, 1 denied |
| `journal kernel [-f]` | Kernel messages (owner) | 0, 1 |
| `journal crashes [--json]` | List crash reports | 0 |
| `journal crash <id> [--core OUT]` | Show a report; with `--core`, export the decrypted core (raises the caller's label) | 0, 1, 3 |
| `journal keep-cores <app> on\|off` | Opt in or out of keeping cores | 0 |
| `journal forget-crashes [--all]` | Delete crash data | 0 |
| `journal forget --human <h>` | Crypto-shred a human's logs and crash data (owner) | 0, 1 |
| `journal metrics [--filter …]` | OpenMetrics output | 0 |
| `journal usage` | Disk usage per scope | 0 |
| `journal verify [--boot N]` | Owner: verify sealed segment hashes against `journal.segment` receipts. The CLI cannot read `/var/lib/keylos/journal`, so `JournalCli.segments` recomputes each sealed segment's SHA-256 from disk inside `journald-kl` (not from the footer) and the CLI compares it with the receipts it reads through its `ledger#reader` route; segments whose receipt the reader cannot open (another human's sealed receipt) report `NO RECEIPT` | 0 ok, 4 mismatch |

Exit codes: 0 ok, 1 denied, 2 unreachable, 3 not found, 4 integrity failure, 64 usage.

`journal usage`, `journal crash <id>`, `journal forget-crashes`, `journal forget --human` and `journal verify` have no protocols method; they use the repo-local `JournalCli` (§5.4).

### 5.4 Repo-local interface (`journal` CLI only)

File ID `0xd7f1c3a5b9e2a001`, served on facets `client` and `admin` through `Extensible.ext` (protocols §1, §22.7); no other repository consumes it. Methods marked admin answer `kl:denied` on facet `client`.

```capnp
@0xd7f1c3a5b9e2a001;

interface JournalCli {
  usage         @0 () -> (json :Text);                 # disk usage per readable scope
  crash         @1 (id :Text) -> (json :Text);         # one crash report (own human per REQ-JOURNAL-034; admin: all)
  forgetHuman   @2 (human :Text) -> ();                # admin: crypto-shred a human's logs and crash data (§4.7)
  forgetCrashes @3 (all :Bool) -> (count :UInt32);     # own human's crash data; all = every human (admin)
  segments      @4 (boot :Int32) -> (json :Text);      # admin: sealed segments of a boot with recomputed SHA-256 (`journal verify`)
  sealNow       @5 () -> ();                           # admin: seal every open segment now (as at shutdown)
}
```

---

## 6. Security

| Threat | Mitigation |
|---|---|
| Log spoofing (a process claims to be another) | Attribution by stream, assigned by `warden`; claimed fields are prefixed |
| Log flooding | Per-principal rate limits; per-scope caps; per-principal series caps |
| Secrets in logs | Logs are encrypted per human and crypto-shreddable; reading `private` or `secret` entries raises the reader's label; forwarding is gated by labels |
| Guest data outliving the guest session | Guest scopes use in-memory keys and are deleted when the guest's last stream closes (REQ-JOURNAL-014) |
| Malicious core files attacking the unwinder | A separate sandboxed `journal-unwind`, a bounded parser, no network |
| Tampering with sealed logs | Segment hashes in ledger receipts; `journal verify` |
| Core dumps leaking memory of sensitive sessions | By default no cores are kept; `secret`-labelled, guest and pod sessions never; cores are encrypted per human |
| The coredump helper as an escalation path | Minimal OS-generation helper: pre-opens its fds, installs seccomp before reading input, leaves the root cgroup, never parses the core, talks only to `journald-kl`, which refuses helpers still in the root cgroup (protocols §9.3) |

**Self-confinement** (service-set entry):

| Aspect | Setting |
|---|---|
| Tier and network | t0, dynamic UID, `network: "none"` (forwarding sockets come from `gate`) |
| Paths | `/var/lib/keylos/journal` (rw, state subvolume); `/store/objects` (ro, for `journal-unwind`); `/run/keylos/journal` (rw, the coredump socket, mode 0600, owned by journal's UID with an exception ACL for UID 0 connect) |
| Devices | `/dev/kmsg` (read, through a broker device grant) |
| Syscalls | no extras |

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| `journald-kl` crash | `warden` restarts it and calls `attach` again for every live principal, using the journal-side ends it duplicated. Datagrams written meanwhile wait in the socket buffers up to `SO_SNDBUF`, after which writers block or get `EAGAIN`; nothing is lost below that bound. Guest scopes' in-memory keys are lost, so their earlier segments are deleted (REQ-JOURNAL-014) |
| Disk full | Drop debug and info entries first; keep warning and worse in a 16 MiB memory ring; critical notice |
| Corrupt segment | The segment is quarantined (renamed `.bad`); queries skip it; `journal verify` reports it |
| Vault unavailable at boot | `_system` entries are buffered in memory under an ephemeral key (32 MiB) and flushed when `vault` is ready |
| Unit key forgotten (`Vault.forget`) | Segments of that scope become unreadable; queries skip them; retention deletes them |
| Coredump helper still in the root cgroup after 1 s | Refused (REQ-JOURNAL-032); the crash is logged without a report |

---

## 8. Performance budgets

| Operation | Budget |
|---|---|
| Ingestion throughput | ≥ 200 000 entries/s per core, sustained |
| Ingestion latency (record → durable, level ≤ 3) | ≤ 10 ms p99 |
| Query of the last hour, filtered by principal, on a 1 GiB store | ≤ 300 ms |
| Storage efficiency | ≤ 40 bytes per typical 120-byte entry after zstd |
| Crash report generation | ≤ 2 s for a 200 MiB core |
| Coredump helper start → leaves the root cgroup | ≤ 50 ms (budget 1 s, protocols §9.3) |
| Memory | ≤ 96 MiB RSS at 2 000 streams |

---

## 9. Observability

- **Metrics (self):** `journal_entries_total{scope_kind,level}` (`scope_kind` ∈ `system`, `cluster`, `human`, `guest`), `journal_dropped_total{reason}`, `journal_bytes{scope}`, `journal_streams`, `journal_crashes_total{kept}`, `journal_unwind_seconds`.
- **Receipts:** `journal.segment` with data `{scope, segment, sha256, entries, minTime, maxTime}`: `segment` is `<boot-id>/<file name>` (file names repeat across boots), `sha256` the lowercase hex SHA-256 of the whole sealed file (the footer's own hash covers only the bytes before it), times RFC 3339. The subject is `journal` itself for `_system` and `_cluster`; for a human scope it is the first principal of that human seen in the segment, so the receipt is sealed to that human (protocols §13.4).

---

## 10. Configuration

`config` renders `/etc/journal/journal.toml` from the `journal` module:

```nickel
{
  journal | {
    maxBytes | String | default = "2G",
    maxAgeDays | Number | default = 30,
    rateLimit | { entries | Number | default = 10000, bytes | String | default = "16M", windowSecs | Number | default = 10 },
    coreLimitBytes | String | default = "512M",
    keepCoresDefault | Bool | default = false,
    keepAgentCores | Array String | default = [],          # agent-template generation names
    forward | Array {
      kind | [| 'syslog-tls, 'otlp-http |],
      host | String, port | Number,
      minLevel | Number | default = 4,
      humans | Array String | default = [],
    } | default = [],
  }
}
```

---

## 11. Testing and acceptance criteria

**Unit:**
- record decoding: text, `0x1E`, `0x1F` (protocols §10.6 metrics keys), malformed CBOR;
- the rate limiter and the series cap;
- segment encode/decode with tampered blocks (GCM failure → the block is skipped and reported);
- scope selection (`_system`, `_cluster`, human, guest);
- filter evaluation and bounds;
- cursor round trips.

**Integration:**
1. Two apps log a forged `principal` field; the stored principal is the real one.
2. A human cannot query another human's scope (`kl:denied`); the owner can.
3. `Vault.forget("journal:logs:bob")` makes bob's segments unreadable; queries skip them.
4. A crashing test app produces a report with a symbolised backtrace. The core is discarded by default, and kept and encrypted when opted in.
5. Segment seal: the receipt exists and `journal verify` passes; flipping a byte in a sealed segment makes `verify` fail.
6. Reading a `private` entry raises the reader's label (observed with `Broker.label`).
7. The coredump helper leaves the root cgroup before reading stdin, and a helper prevented from moving (test hook) is refused by `journald-kl`.
8. A guest session logs, then logs out: its segments are deleted within 10 s; after a simulated crash during a guest session, the leftover segments are deleted at the next start.
9. Pod principals' entries land in the `_cluster` scope and are readable only by the owner.
10. The throughput benchmark meets §8.

**Fuzzing:** the record decoder, the filter parser, the ELF core parser in `journal-unwind`, and the segment reader.

**Acceptance:** all of the above on x86_64 and aarch64.

---

## 12. Implementation notes

**Crates:**
- `tokio` 1, `ciborium` 0.2, `zstd` 0.13, `aes-gcm` 0.10
- `object` 0.36 (ELF), `gimli` 0.31 (unwinding and DWARF), `addr2line` 0.24
- `capnp-rpc` 0.19, `serde_json` 1
- the helper: `rustix` with a hand-written seccomp filter (`seccompiler` 0.4), statically linked

**Repository layout:**

```
journal/
  crates/journald-kl/  crates/journal-coredump/  crates/journal-unwind/  crates/journal-cli/  crates/keylos-journal-client/
  tests/  fuzz/
```

The helper is built by `forge` as part of this repository and installed into the **OS generation** at `/usr/lib/keylos/journal/coredump` (the kernel invokes it by path, so it must be in the booted OS tree, protocols §9.3).

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reference |
|---|---|---|
| Attribution by per-principal stream | `SCM_CREDENTIALS` PIDs (racy and spoofable across PID reuse) | [ADR-0004](../../handbook/11-decisions/adr-0004-capwire-no-system-bus.md) |
| Per-human encrypted, crypto-shreddable logs | A plain system-wide journal readable by admins | [ADR-0032](../../handbook/11-decisions/adr-0032-crypto-shredding.md) |
| No cores by default | Keeping everything (memory leakage of secrets and agent context) | [ADR-0039](../../handbook/11-decisions/adr-0039-secrets-never-in-env.md) |
| Logs separate from receipts | One combined log (receipts must be minimal, signed and permanent; logs are voluminous and prunable) | [ADR-0031](../../handbook/11-decisions/adr-0031-receipts-ledger.md) |
| Metrics as `0x1F` records on the same stream | A separate metrics socket per principal (more fds, same attribution problem) | protocols §10.6 |

### 13.1 Notes on cross-repository contracts

- **N1.** The core-dump helper moves itself out of the root cgroup and `journald-kl` verifies the move, exactly as protocols §9.3 states (REQ-JOURNAL-031/032).
