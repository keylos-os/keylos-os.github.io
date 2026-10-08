# keylos/courier: updates, boot assessment and rollback

| | |
|---|---|
| Repository | `github.com/keylos-os/courier` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | Service generation `io.keylos.courier` (binary `courier-svc`); CLI `courier`; firmware island helper `courier-fw` (Rust); island definition for fwupd; crate `keylos-tuf` (the TUF client profile used by courier only); repo-local schema `schema/courier-local.capnp` (`CourierAdmin`) |
| Depends on | `keylos-protocols 1.0`. Runtime services: `depot`, `ledger`, `warden`, `gate`, `atrium` (TrustedPrompt), `hearth` (`HearthTpm`), `strata`, `net`, `vouch` (when paired), `broker`. Artifacts of `boot`: the `kl-boot-tpm` crate and `kl-uki verify`. External: fwupd ≥ 2.0 and dbus-broker (both in a private island) |
| Provides | `Courier` (protocols §7.3.9); `CourierResolver` (protocols §7.5.6), including revocation-list delivery through `Resolution.revocations`; ESP and boot-entry management; PCR prediction and pcrlock NV updates; boot-version floor management; boot assessment; `kmod` generation updates for new kernels; offline-operation status (revocation age); firmware and Secure Boot database updates (owner, shared-boot and shim modes) |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`courier` is the only component that changes what the machine boots, and the machine's only TUF client. It:

1. **Discovers updates** for the OS, the recovery generation, installed apps and revocation lists through TUF.
2. **Verifies** each release before anything is staged:
   - release-log inclusion with witness cosignatures;
   - the rebuilder quorum in the realisation log;
   - capability-widening rules.
3. **Resolves** `tuf:` sources for `depot` (`CourierResolver`).
4. **Stages** OS updates as boot entries on the ESP. Before rebooting, it updates the pcrlock NV policy so the new boot unseals.
5. **Assesses** each boot. After a good boot it marks the entry good and writes the boot-version floor. After a bad boot it records the failure. (PCR11 `sysinit` and `ready` are extended by `warden`, protocols §19.6.)
6. **Rolls back** to a previous good entry on request.
7. **Updates firmware** through a confined fwupd, and manages Secure Boot `db`/`dbx` and SBAT changes in staged, presence-approved steps.

**Non-goals:**
- **Extending PCR11.** `warden` extends `sysinit` and `ready` before any tier-0 service starts; `courier` only relies on PCR11 being at `ready` for its NV writes.
- **Fetching and writing store objects.** `depot` does that, from sources that `courier` resolves.
- **Capability consent for apps.** `depot` records consent (`keylos.consent/1`).
- **Applying configuration.** That is `config`.
- **Building.** That is `forge`.

---

## 2. Context and embedded contracts

```
               TUF repo (tuf.keylos.org)          release log (log.keylos.org/releases)   realisation log
                        │                                  │                                   │
                        ▼                                  ▼                                   ▼
 courier ── verify(TUF → release statement → log inclusion + witness cosignatures → rebuilder quorum)
    │  resolve ─► depot.install("oci://…@sha256:…#gen=fsv256:…")   (depot writes objects, checks digests)
    │  ESP: /EFI/Linux/keylos_<seq>+3-0.efi        pcrlock NV 0x01300103 (kl-boot-tpm)
    │  assess boot ─► rename entry, floor NV 0x01300102 (PCR11 already at "ready", extended by warden)
    └  fwupd island (firmware), efivarfs (LoaderEntryDefault, db/dbx/SBAT)
```

The contracts below are copied **verbatim** from `keylos/protocols` 1.0.0 (final). Section numbers and cross-references inside the excerpts refer to protocols. If an excerpt differs from protocols, protocols wins.

### 2.1 Time (protocols §3.6)

- On the wire: `Timestamp { unixNanos :Int64 }` in UTC.
- In documents: RFC 3339 with `Z` and at most nanosecond precision.
- The system clock MUST be disciplined by NTS-authenticated time (owned by the `net` repo).
- Components that check expiry (tokens, TUF, certificates) MUST treat the clock as **untrusted until the first NTS sync after boot**. Until then they use the **time floor**: the time of the newest ledger checkpoint (`LedgerAdmin.timeFloor`, §7.5.5). `net` steps the clock forward to the time floor at boot if the RTC is earlier. The RTC is never trusted to move time backwards past the floor.

### 2.2 Cryptography (protocols §4)

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

### 2.3 Signed documents and trust roots (protocols §5.1, §5.2)

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

### 2.4 Presence signatures (protocols §5.3)

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

### 2.5 `common.capnp` and errors (protocols §7.3.1)

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

### 2.6 `courier.capnp` (protocols §7.3.9, implemented)

```capnp
@0xc7a1e5d3b2f40009;
using C = import "common.capnp";

struct UpdateInfo {
  stream   @0 :Text;
  current  @1 :C.Ref;
  available @2 :C.Ref;
  version  @3 :Text;
  notes    @4 :Text;
  capabilityDiff @5 :Text;
  security @6 :Bool;
  rebuilderQuorum @7 :Text;   # e.g. "3/3"
}

interface Courier {
  check    @0 () -> (updates :List(UpdateInfo));
  stage    @1 (target :C.Ref) -> ();          # download, verify, predict PCRs, install boot entry
  status   @2 () -> (state :Text, staged :C.Ref, bootCounter :Text);
  rollback @3 () -> ();                       # make previous generation default
  pin      @4 (ref :C.Ref) -> ();             # keep this generation bootable
}
```

### 2.7 `courier-sys.capnp` (protocols §7.5.6, implemented)

```capnp
@0xc7a1e5d3b2f40025;
using C = import "common.capnp";

struct Resolution {
  oci          @0 :Text;           # "oci://<repository>@sha256:<manifest>"
  expectedGen  @1 :C.Ref;
  attestations @2 :Data;           # JCS bundle: realisation DSSEs + keylos.tlogproof/1 proofs
  publisher    @3 :Text;           # key ref
  quorum       @4 :Text;           # "k/n" or "none"; authoritative for depot's quorum decision
  statement    @5 :Data;           # DSSE generation statement (§20.7)
  revocations  @6 :Data;           # DSSE keylos.revocations/1 (only for source "tuf:<stream>/revocations"; other fields empty)
  review       @7 :Text;           # catalog review status of the resolved generation: "reviewed-reproducible" | "unreviewed" | "" (not a catalog app)
  catalogEntry @8 :Data;           # JCS catalog entry (§20.20) when the generation is listed; empty otherwise
}

interface CourierResolver {        # facet depot
  resolve @0 (source :Text) -> (resolution :Resolution);
      #! source grammar:
      #!   "tuf:<stream>/<name>[@<version>]"       distro or publisher generation
      #!   "tuf:org:<org>/<name>[@<version>]"     org generation from the enrolled fleet's TUF repository
      #!   "tuf:<stream>/revocations"             revocation list (only `revocations` is set)
      #!   "tuf:catalog/<name>[@<version>]"       catalog lookup only (only `review` and `catalogEntry` are set)
}
```

### 2.8 Consumed interfaces

| Interface (protocols §) | Facet held by courier | Methods called |
|---|---|---|
| `Depot` (§7.3.8) | `depot#courier` | `install`, `root`, `unroot`, `get`, `list`, `revocations` |
| `Supervisor` (§7.3.2) | `warden#admin` | `services`, `control` |
| `TrustedPrompt` (§7.3.4) | `atrium#presence` | `presence`; `notify` through `atrium#notify` |
| `Ledger` (§7.3.5) | `ledger#writer` | `append`, `checkpoint` |
| `Gate` (§7.3.7) | `gate#client` | `connect` |
| `StrataAdmin` (§7.5.7) | `strata#courier` | `preUpdate` |
| `VouchLink` (§7.5.22) | `vouch#announce` | `announce` |
| `Net` (§7.3.15) | `net#status` | `time`, `status` (metered links) |
| `HearthTpm` (§7.5.3) | `hearth#tpm` | `sbSign` (owner-mode `db`/`dbx` updates), `sbAccepted` (firmware accepted new owner KEK/db certificates, REQ-COURIER-045), `defineSpace` (`0x01300103` after a TPM clear; the floor is re-initialised only in recovery) |
| `HearthQuorum` (§7.5.3) | `hearth#presence` | `request`, `collect`: presence for `update.*` and `boot.sb-sign` on quorum machines (headless profiles, protocols §5.4), where there is no `atrium` |
| `Bootstrap` (§7.5.1) | fd 3 (every tier-0 service) | `host`, `ready`, `status` (first-boot completion) |

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

#### 2.8.1a `warden-sys.capnp` (protocols §7.5.1)

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

#### 2.8.2 `prompt.capnp` (protocols §7.3.4)

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

#### 2.8.3 `ledger.capnp` (protocols §7.3.5)

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

#### 2.8.4 `gate.capnp` (protocols §7.3.7)

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

#### 2.8.5 `depot.capnp` (protocols §7.3.8)

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

#### 2.8.6 `net.capnp` (protocols §7.3.15, the `net.capnp` block)

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

#### 2.8.7 `strata-sys.capnp` (protocols §7.5.7)

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

#### 2.8.8 `vouch-sys.capnp` (protocols §7.5.22)

```capnp
@0xc7a1e5d3b2f40035;
using C = import "common.capnp";
using P = import "prompt.capnp";

struct Phone { id @0 :Text; label @1 :Text; platform @2 :Text; lastSeen @3 :C.Timestamp; witness @4 :Bool; approvals @5 :Bool; pending @6 :Bool; }

interface VouchLink {              # facets settings (atrium), approvals (atrium), announce (courier), witness (ledger bridge)
  phones        @0 () -> (list :List(Phone));
  pairStart     @1 () -> (qr :Text, expires :C.Timestamp);
  pairCode      @2 (words :List(Text)) -> ();
  pairWait      @3 () -> (phone :Phone);
  remove        @4 (id :Text) -> ();
  routeApproval @5 (prompt :P.ApprovalPrompt) -> (decision :P.Decision);   #! never satisfies requiresPresence (§14.3)
  announce      @6 (kind :Text, detailJson :Text) -> ();                    # "release-staged" | "firmware-pending" | "baseline-update"
  inheritance   @7 (configJson :Text) -> ();
      #! facet settings: configures the optional dead-man timer (§20.19): after N days without an owner login heartbeat,
      #! the paired phone releases the owner's encrypted inheritance note to the listed trustees. Never a key.
}
```

#### 2.8.9 `hearth-sys.capnp` (protocols §7.5.3)

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

### 2.9 Supply-chain formats (protocols §11.4, §11.5, §11.7)

An in-toto Statement v1 with:
- `subject` = the output generation: `name` = `<name>-<version>.<output>`, `digest: {"fsv256": hex}`;
- `predicateType` = `https://keylos.org/realisation/v1`;
- predicate = `{"drv": "drv:sha256:…", "output": "out", "builder": "<operator id>", "buildHost": {"arch":…, "kernel":…, "forgeVersion":…}, "started":…, "finished":…}`.

It is signed by `rebuilder/<operator>` and logged in the **realisation log** (§11.5).

keylos operates two logs, both following **C2SP tlog-tiles** with checkpoints per **C2SP tlog-checkpoint** and witness cosignatures per **C2SP tlog-cosignature**:

| Log | Origin line | Entries |
|---|---|---|
| Realisation log | `log.keylos.org/realisations` | DSSE realisation attestations (§11.4) |
| Release log | `log.keylos.org/releases` | DSSE release statements (`keylos.release/1`, §20.6) and cloud image records (`keylos.cloudimage/1`, §20.24), signed by `release-stream/<stream>` |

Clients MUST verify inclusion against a checkpoint cosigned by at least `witnessThreshold` (default **2**) witnesses from the witness list in TUF targets metadata (`rebuilders.json`: `witnesses`, `witnessThreshold`). A generation is installable from a distro or publisher channel only if its realisation log entries reach the rebuilder quorum named in its release or app-release statement.

```json
{"schema":"keylos.revocations/1","stream":"stable","serial":1234,"issued":"…",
 "objects":[{"ref":"obj:fsv256:…","reason":"CVE-2026-XXXX","action":"evict"}],
 "generations":[{"ref":"gen:fsv256:…","reason":"…","action":"unlaunchable"}],
 "keys":[{"ref":"key:sha256:…","reason":"compromised","after":"…"}]}
```

- Distributed as a TUF target by `courier` and logged (its digest) in the release statement.
- Actions: `unlaunchable`, `evict`, `warn`.
- A `keys[]` entry for a `publisher/<id>` or `org-publisher/…` key makes every generation whose only authorising signature is by that key `unlaunchable` from `after` onwards; generations signed before `after` stay launchable only if their realisations reach the rebuilder quorum.

### 2.10 Receipts (protocols §13.1)

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

`courier` writes `update.stage`, `update.commit` and `update.rollback` (protocols §19.3).

### 2.11 Approval tiers (protocols §14.3)

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

### 2.12 Presence purposes (protocols §20.2)

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

### 2.13 TPM objects and PCRs (protocols §19.6)

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

### 2.14 Release statement (protocols §20.6)

DSSE-signed by `release-stream/<stream>`; it is both the TUF target for the OS update and the release-log entry.

```json
{"schema":"keylos.release/1","stream":"stable","seq":4211,"version":"1.4.2","arch":"x86_64",
 "released":"2026-10-01T12:00:00Z","floor":4150,"security":true,
 "profiles":{
   "desktop":{"osGen":"gen:fsv256:…","osDrv":"drv:sha256:…",
              "uki":{"sha256":"…","size":98304000,"ociBlob":"sha256:…"},
              "pcr11":{"enter-initrd":"sha256:…","leave-initrd":"sha256:…","sysinit":"sha256:…","ready":"sha256:…","enter-recovery":"sha256:…"},
              "pcr12":"sha256:…","pcrlock":"sha256:<pcrlock component bundle>",
              "recoveryGen":"gen:fsv256:<recovery environment generation inside the UKI>"},
   "laptop":{"…":"…"}},
 "oci":{"repository":"oci.keylos.org/os/stable","manifest":"sha256:…"},
 "installer":{"iso":"sha256:…","uki":"sha256:…"},
 "kernel":{"uname":"7.2.4-keylos1","featureLevel":"KL3"},
 "revocations":{"serial":1235,"digest":"sha256:…"},
 "rebuilders":{"required":"2-of-3","attested":["op-a","op-b","op-c"]},
 "ceremony":{"transcript":"sha256:…","holders":["key:sha256:…","key:sha256:…"]},
 "policyDefaultsDiff":"","newServices":[],"firmwareNotes":"","notes":"…"}
```

- There is no separate recovery UKI: the recovery environment is the `recovery` profile inside each profile's UKI (PCR11 phase `enter-recovery`); `recoveryGen` names the generation it runs.
- The `cloud` profile's UKI carries an additional `seed` profile (the first-boot seed stage, §20.13) whose PCR11 phase predictions are listed under `pcr11Seed` in that profile's object.
- `kmod` generations for a release's kernel are TUF targets at `kmod/<kernel-release>/<name>` in the same stream; `courier` installs those listed for the machine and roots them as `courier:kmod:<kernel-release>`.
- `seq` strictly increases per stream. `floor` ≤ `seq` is the minimum release `seq` that may still unseal; `courier` writes exactly this value to NV `0x01300102` after the release is assessed healthy, under the exact-target policy of §19.6 ("Floor writes"), and writes nothing while a pin holds the machine below it.
- Consumers: `courier` (staging), `boot` (PCR policies), `installer` (floor initialisation), `vouch` (PCR predictions), `tlog` monitors (serial and quorum rules).

### 2.15 Generation statement (protocols §20.7)

```json
{"schema":"keylos.genstmt/1","generation":"gen:fsv256:…","kind":"app","name":"org.example.Editor",
 "version":"2.5.0","manifestDigest":"sha256:…","drv":"drv:sha256:…","stream":"stable",
 "objects":"sha256:<digest of sorted object list>","issued":"2026-10-01T00:00:00Z"}
```

`objects` is SHA-256 over the newline-terminated, sorted, lowercase hex fs-verity digests of the closure. Authorising signatures:

| Origin | Signer |
|---|---|
| Distro (OS, runtimes, distro apps, services, bench images, agent templates) | `release-stream/<stream>` |
| Third-party publisher | `publisher/<id>` |
| Owner-sealed | `owner-seal/<i>` (via `HearthSeal.sealSign`), accompanied by a `keylos.seal/1` statement |
| Config and policy | `owner-presence` over `keylos.configgen/1` (the configgen statement is the authorising statement) |

### 2.16 First-boot bundle (protocols §20.13)

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

### 2.17 Transparency-log proof bundle (protocols §20.14)

```json
{"schema":"keylos.tlogproof/1",
 "origin":"log.keylos.org/realisations",
 "index":123456,
 "entry":"<base64 of entry bytes>",
 "checkpoint":"<full signed note text including cosignature lines>",
 "inclusion":["<base64 hash>"]}
```

Verification: verify the log signature on the checkpoint with the origin's key (TUF `logs.json`); verify ≥ `witnessThreshold` cosignatures from distinct listed witnesses; compute the RFC 6962 leaf hash of `entry` and verify inclusion at `index`; update the persisted last-seen checkpoint (consistency-checked) when online.

### 2.17a Profiles and integrity profiles (protocols §2.2)

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

### 2.17b Operating rules: offline operation (protocols §14.5)

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.

### 2.17c Cross-repository files (protocols §10.7)

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

### 2.18 Boot-chain contract (from `boot`, consumed through `kl-boot-tpm`)

| Item | Value |
|---|---|
| UKI file name | `/EFI/Linux/keylos_<seq>+<tries-left>-<tries-done>.efi` |
| PCR11 phases | `enter-initrd`, `leave-initrd` (boot), `sysinit`, `ready` (warden), `enter-recovery` (boot, recovery profile) — systemd-pcrphase strings |
| UKI command line pins | `composefs=<os hex>`, `keylos.seq=`, `keylos.revocations=<serial>:<sha256>`, `keylos.recovery=<recovery generation hex>` (signed inside the UKI; read by `courier` from the `.cmdline` section for verification) |
| Unlock policy start digest | `PolicyAuthorize(streamKey, "keylos/unlock/1")` constant |
| pcrlock and floor NV writes | Authorized by stream-signed policies in the running UKI's `.pcrsig` (`keylos/pcrlock-write/1`, `keylos/floor-write/1`), usable only at PCR11 `ready`; the floor-write policy binds the one value `F` of that release (boot spec §4.4.4) |
| LUKS2 token `keylos-tpm2` | Fields `pcrlock_branches` (list of `{sel, values}`) and `ui` (`vbu`, `pinAttemptsPerBoot`, `console`), written through `kl-boot-tpm` |
| `kl-uki verify --uki S --trust T` | UKI verification against the stream keys |

---

## 3. Requirements

### 3.1 Discovery and verification

- **REQ-COURIER-001** `courier` MUST be the only TUF client on the machine. `depot` resolves `tuf:` sources through `CourierResolver` (§4.10).
- **REQ-COURIER-002** TUF metadata MUST be verified per the TUF specification 1.0.x:
  - the root rotation chain;
  - threshold signatures;
  - expiry;
  - rollback protection (version monotonicity);
  - freeze protection (timestamp expiry);
  - mix-and-match protection (snapshot consistency).

  Expiry checks MUST use the time rule of protocols §3.6. Until `Net.time()` reports `synced`, the clock (which `net` has already stepped to at least the ledger time floor) is used, but no metadata that is valid only because of clock uncertainty is accepted for staging.
- **REQ-COURIER-003** An OS release MUST NOT be staged unless all of these hold:
  1. its release statement is a TUF target of `streams/<stream>/releases/<seq>.dsse`, and its DSSE signature verifies with the `release-stream/<stream>` key named in the TUF delegation;
  2. the release statement is included in the release log, proved by a `keylos.tlogproof/1` bundle against a checkpoint cosigned by ≥ `witnessThreshold` witnesses from `rebuilders.json`;
  3. for the machine's profile, `profiles.<p>.osGen` is attested by realisation attestations from distinct operators in `rebuilders.json`, numbering at least the `rebuilders.required` k. The attestations name the same `osDrv` and output, and each one is included in the realisation log (`keylos.tlogproof/1`);
  4. `seq` is greater than the highest staged or booted `seq` for this stream, unless it is an explicit rollback target already on disk;
  5. `seq ≥` the current floor (NV `0x01300102`).
- **REQ-COURIER-004** App releases (`keylos.apprelease/1`, §4.3.2) MUST satisfy items 1–3 of REQ-COURIER-003, with the publisher delegation in place of the stream:
  - The rebuilder quorum is required when the delegation declares `quorum > 0`.
  - Otherwise the resolution reports `quorum: "none"`, and `depot` applies the `reproducible: false` rule (protocols §6.3), unless the publisher is in the owner's `trustedPublishersWithoutQuorum` list. That list only affects whether `courier` resolves the source; the tier rule stays with `depot` and `warden`.
- **REQ-COURIER-005** Revocation lists:
  - MUST be fetched on every metadata refresh, as TUF targets `streams/<stream>/revocations/<serial>.dsse`;
  - MUST be verified (signature by the stream key; digest equal to `revocations.digest` of the newest verified release statement, or a newer serial signed by the same key);
  - MUST be offered to `depot` through `CourierResolver` (§4.10.2), in `Resolution.revocations`, before any other update action.
- **REQ-COURIER-006** Before staging, `courier` MUST read the new UKI's `.cmdline` section and check that `keylos.revocations=<serial>:<sha256>` equals the release statement's `revocations` (`serial`, `digest`), that `composefs=` equals `profiles.<p>.osGen` and that `keylos.seq=` equals `seq`. The UKI is signed, so `courier` never writes the command line: the pin is the UKI's own release's revocation list, set by the release build (protocols §10.7), and `courier` only verifies it. It also checks that `keylos.recovery=` equals `profiles.<p>.recoveryGen`.

### 3.2 Staging

- **REQ-COURIER-007** Org sources (protocols §7.5.6): `resolve("tuf:org:<org>/<name>[@<version>]")` MUST be answered only on machines enrolled in fleet `<org>`, from that fleet's TUF repository (root pinned at enrolment in `/etc/keylos/courier.json` `orgs.<org>`, rendered by `config`'s fleet module). Targets are `apps/<name>/<version>.json` app-release documents and `gen-statements/<hex>.dsse` in the `org-publishers` delegations; the statement MUST verify against an `org-publisher/<org>/<id>` key that is enabled in the boot trust set's publishers with scope `org:<org>`. Unknown or unenrolled orgs fail with `kl:not-found`. Container generations for `keylos-sealed` pods are resolved the same way, by the name and version `depot` derives with `oci-convert/1` (protocols §21.4).
- **REQ-COURIER-008** Catalog (protocols §11.8, §20.20): `courier` MUST keep the newest verified `keylos.catalog/1` (TUF target `catalog/catalog.json`, signed by the delegated `catalog` role, expiry checked against trusted time). For every generation resolution it fills `Resolution.review` and `Resolution.catalogEntry` from the entry whose `name` matches and whose `latest.generation` (or a listed older version) equals the resolved generation; a generation not listed gets `review = ""` and an empty `catalogEntry`. `resolve("tuf:catalog/<name>[@<version>]")` returns only `review` and `catalogEntry`. With an expired catalog, `review` is `"unreviewed"` for every listed app.
- **REQ-COURIER-009** Release statements (protocols §20.6) MUST carry `profiles.<p>.recoveryGen` for every profile; for the `cloud` profile they MUST also carry `pcr11Seed` with predictions for all five phases of the `seed` profile. A statement missing either for the machine's profile is not stageable.
- **REQ-COURIER-010** Staging an OS release MUST perform these steps:
  1. `StrataAdmin.preUpdate("os <seq>")`, which records the pre-update snapshot set;
  2. install `profiles.<p>.osGen` and `profiles.<p>.recoveryGen` (protocols §20.6; the recovery environment runs in the UKI's `recovery` profile, and the UKI's `keylos.recovery=` MUST equal `recoveryGen`, REQ-COURIER-006), through `depot.install("oci://<repository>@<manifest>#gen=fsv256:<hex>")`;
  2a. when the release's `kernel.uname` differs from the running kernel, install for every enabled `kmod` name (§10, `kmods`) the matching `kmod` generation (TUF target `streams/<stream>/kmod/<kernel-release>/<name>.json`, protocols §20.6: an app-release document with `"kind": "kmod"` and the generation statement next to it) and root it as `courier:kmod:<kernel-release>`; roots for kernel releases no longer present on the ESP are removed with `depot.unroot`; a missing one blocks auto-staging and is shown as `kmod-missing:<name>` (manual staging asks the owner to confirm booting without it);
  3. download the UKI blob (`profiles.<p>.uki.ociBlob`) through `gate` and verify its SHA-256 and size against the release statement;
  4. verify the UKI with `kl-uki verify` against the stream keys;
  5. compute the pcrlock branches covering the current boot, the new boot and the rollback entry (§4.5);
  6. write the NV policy and the token's `pcrlock_branches` (requires PCR11 at `ready`, which `warden` reached before `courier` started; §4.4);
  7. write the UKI to the ESP as `keylos_<seq>+3-0.efi`;
  8. `depot.root` both generations with holder `courier:boot:<seq>`.

  Each step MUST be idempotent. A crash at any point MUST leave the previously good entry bootable.
- **REQ-COURIER-011** The ESP MUST hold at most `keepEntries` (default 3) keylos UKIs plus pinned ones. Removal order: the oldest unpinned entry first; never the current boot; never the newest known-good entry.
- **REQ-COURIER-012** A release that widens system authority MUST be approved with presence before staging. Widening means a non-empty `policyDefaultsDiff`, or entries in `newServices`. Approval uses `TrustedPrompt.presence(purpose = "update.stage-widening", payload = keylos.presence/1 with details {seq, policyDefaultsDiff, newServices})`, and the payload is rendered on the trusted path. Releases that do not widen are staged automatically when `autoStage` is `security` (and `security: true`) or `all`.

### 3.3 Boot assessment

- **REQ-COURIER-020** After every boot, `courier` MUST decide **good** or **bad** within `assessTimeoutSecs` (default 300 s). Good means all of:
  - every `x-start: "boot"` service of the service table (protocols §20.16) is `running` for ≥ 60 s, with zero restarts in that window;
  - `ledger` has produced a checkpoint after boot;
  - in graphical profiles (`desktop`, `laptop`, `kiosk`), the `atrium` service is `running` and healthy; on `server-k8s`, `cri` and `kubelet` are `running`;
  - the boot report (`/run/keylos/boot/report.json`) says `profile: default` and `safeConfig: false`, and its `integrity` is not lower than the previous good boot's (a drop, for example `full` → `shim`, makes the boot bad).
- **REQ-COURIER-021** On good:
  1. rename the entry to drop the counter (`keylos_<seq>.efi`);
  2. `depot.root` with holder `courier:good:<seq>`;
  3. apply the floor rule (§4.6);
  4. write `update.commit`;
  5. call `VouchLink.announce("baseline-update", …)` when the measured firmware PCRs changed.
- **REQ-COURIER-022** On bad, or if the running entry is not the newest staged entry (the boot loader fell back):
  - mark the failed entry `+0-<n>` (exhausted);
  - write `update.rollback` with reason `boot-failed`;
  - notify through `atrium` with severity `critical`.
- **REQ-COURIER-023** PCR11 phases: `courier` MUST NOT extend PCR11 (protocols §19.6: `warden` extends `sysinit` and `ready`, and nothing extends PCR11 after `ready`). At start it MUST read PCR11 and compare it with the booted release's `profiles.<p>.pcr11.ready` prediction; on a mismatch it refuses every NV write, raises a critical notice and assesses the boot as bad. The floor is written only after a good assessment, even though the NV policy would accept a write as soon as PCR11 is at `ready`.

### 3.4 Floor, rollback, pin

- **REQ-COURIER-030** The floor is written only by the procedure in §4.6, and only with the exact value `F` = the booted release statement's `floor` (protocols §20.6, §19.6): the running UKI's approved floor-write policy binds that one value (`PolicyNV(current ≤ F) ∧ PolicyCpHash(write F)`), so `courier` cannot write any other value, and never computes `max` or intermediate targets. Under the protocols assumptions (release-stream key not compromised; exactly one approved floor-write policy per UKI digest) the floor cannot decrease.
- **REQ-COURIER-033** If a pinned release has `seq < F`, `courier` MUST NOT write the floor at all (the current floor is retained; status `floor held by pin`); it never writes an intermediate value to preserve a pin. A write whose acknowledgment was lost is repeated with the same `F` (idempotent: `PolicyNV` still holds when the floor already equals `F`). A write refused because the floor is already above `F` is not an error.
- **REQ-COURIER-031** `rollback()` MUST set `LoaderEntryDefault` to the newest good entry older than the current one whose `seq` is ≥ the floor. If none exists, it fails with `kl:not-found`. It requires presence (purpose `update.rollback`).
- **REQ-COURIER-032** Pins:
  - `pin(ref)` MUST keep the boot entry and the generations of that release from removal;
  - pinning a release whose `seq` is below the newest verified release's `floor` MUST be refused with `kl:denied`;
  - pinned releases at or above the floor stay bootable until unpinned.

### 3.5 Firmware and Secure Boot databases

- **REQ-COURIER-040** Firmware updates:
  - MUST run through fwupd in a private island (§4.8);
  - applying one requires presence (purpose `update.firmware`);
  - before the reboot that applies a capsule, `courier` MUST add a pcrlock branch that omits PCR0 and PCR2, or uses vendor-provided predictions when the LVFS metadata carries pcrlock data;
  - it MUST re-lock to measured values on the next good boot;
  - it MUST record the weakened window in the `update.stage` receipt and announce it with `VouchLink.announce("firmware-pending", …)`.
- **REQ-COURIER-041** `db` updates (adding stream certificates) MUST precede `dbx` updates (revoking certificates) by at least one good boot signed under the new certificate.
- **REQ-COURIER-042** In owner-key mode, authenticated variable updates are signed by the owner Secure Boot KEK and db signers, which are TPM objects (`0x81000101`, `0x81000102`, protocols §19.6) behind the owners' seal gates. `courier` builds the `EFI_VARIABLE_AUTHENTICATION_2` payload, obtains a presence envelope with purpose `boot.sb-sign` whose `keylos.presence/1` payload `details` carry `{"which": "kek"|"db", "payloadSha256": "<hex>"}` (protocols §20.2; quorum envelope on quorum machines), and calls `HearthTpm.sbSign(which, payload, presenceEnvelope)` on `hearth#tpm`. `hearth` verifies the envelope, opens the seal gate and returns the PKCS#7 signature.
- **REQ-COURIER-044** With `secureboot.keepMicrosoftCAs = true` (dual boot, integrity profile `shared-boot`, protocols §2.2), the owner `db` also holds the Microsoft Windows Production PCA 2011 / Windows UEFI CA 2023 and the Microsoft UEFI CA 2011 / 2023 certificates. `courier` then applies Microsoft's published `dbx` revocation content (shipped per release as `dbxupdate.bin`) after re-signing it with the owner KEK (REQ-COURIER-042), following the `db`-before-`dbx` order of REQ-COURIER-041 and refusing any revocation that would make the current or newest good keylos UKI unbootable. Turning `keepMicrosoftCAs` off removes those certificates through a `db` rewrite signed the same way.
- **REQ-COURIER-045** Firmware acceptance of owner certificates (protocols §7.5.3 `HearthTpm.sbAccepted`): while `hearth` has KEK/db signers staged for an owner change, `courier` MUST, at every boot after `ready`, read back the `KEK` and `db` EFI variables, and when they contain the staged certificates (matched by SHA-256 of the DER certificate) call `HearthTpm.sbAccepted(kekCert, dbCert)` on `hearth#tpm` once; `hearth` then swaps the staged signers. Until then the old signers stay in use and `status` shows `secureBootCerts: pending`.
- **REQ-COURIER-043** In shim mode, SBAT revocations (`SbatLevel`) MUST be applied only after a good boot with a shim whose SBAT generation already satisfies the new level.

### 3.6 Scheduling and network

- **REQ-COURIER-050** Metadata refresh MUST happen:
  - at boot, after `net` reports trusted time;
  - every `checkIntervalHours` (default 6, ±20% jitter);
  - on demand.

  On metered links (`net`), only metadata and revocation lists are fetched, unless `allowMetered = true`.
- **REQ-COURIER-051** All network access MUST go through `gate.connect`, using courier's grants for the configured TUF, OCI, log, witness and LVFS hosts.
- **REQ-COURIER-052** Offline operation (protocols §14.5): when the TUF timestamp metadata has expired, `courier` MUST pause updates (no staging, no app installs through `CourierResolver`, which answers `kl:expired`); already installed generations keep launching and known revocation lists keep applying. `courier` MUST compute the **revocation age** (time since the newest verified revocation list, against trusted time) and report it in `Courier.status` (`revocationAgeDays`). After 7 days without fresh metadata it raises a critical notice.
- **REQ-COURIER-053** NV re-provisioning: if NV `0x01300103` is missing (for example after a TPM clear in recovery), `courier` MUST call `HearthTpm.defineSpace` for it (protocols §19.6 registry template) before any write and initialise the pcrlock policy to the measured values. A missing or unreadable floor (`0x01300102`) is **not** repaired by `courier` in a normal boot: it is a recovery and re-enrolment condition (boot spec §4.12, `kl-boot floor init` in the recovery environment, baseline = the signed release statement's `floor`). `courier` raises a critical notice and refuses staging until it is resolved.

### 3.7 First boot

- **REQ-COURIER-060** On first boot, `courier` reads its part of the first-boot bundle (protocols §20.13: `secureBoot`, `tpm.pcrlockCoveredPcrs`), initialises its state from it, and reports completion with `Bootstrap.status("firstboot:done")`.

---

## 4. Design

### 4.1 Modules

| Module | Responsibility |
|---|---|
| `tuf` | TUF client (crate `keylos-tuf`, wrapping `tough`); metadata cache in `/var/lib/courier/tuf/` |
| `verify` | Release statements, tlogproof bundles, witness cosignatures, rebuilder quorum |
| `stage` | State machine of §4.4 |
| `esp` | ESP file operations (atomic writes: write `*.tmp`, fsync, rename, fsync the directory), `loader.conf`, EFI variables |
| `pcr` | Event-log replay, PCR prediction for new UKIs, pcrlock branch construction (through `kl-boot-tpm`) |
| `assess` | Boot assessment (§4.6) |
| `apps` | App update discovery and installation through `depot` |
| `fw` | Supervision of the firmware island (§4.8) |
| `sbdb` | Secure Boot `db`/`dbx`/SBAT procedures |
| `resolver` | `CourierResolver` for `depot` |
| `sched` | Timers and network-condition gating |

### 4.2 TUF repository layout

Repository base: `https://tuf.keylos.org/` (mirrors configurable). Roles:

| Role | Keys and threshold | Expiry | Signs |
|---|---|---|---|
| `root` | distro-root, 3-of-5 (offline, HSM) | 365 days | All top-level role keys |
| `timestamp` | 1 online key (HSM-backed service) | 1 day | `snapshot.json` hash |
| `snapshot` | 1 online key | 7 days | Versions of all targets metadata |
| `targets` | 2-of-3 offline | 90 days | Delegations, plus `rebuilders.json` and `logs.json` |
| `streams/<stream>` (delegated, paths `streams/<stream>/*`, terminating) | release-stream key (HSM) | 30 days | Release statements, revocation lists, firmware baselines |
| `publishers/<id>` (delegated, paths `apps/<name-prefix>/*`, terminating) | publisher key(s), threshold per delegation | 365 days | App release documents |
| `catalog` (delegated, path `catalog/*`, terminating) | project catalog key (HSM, Ed25519) | 30 days | The catalog |

A fleet's **org repository** (fleet-enrolled machines only) uses the same layout with its own `root` and an `org-publishers` delegation instead of `streams`; its root is pinned by digest in `/etc/keylos/courier.json` `orgs.<org>.root` (REQ-COURIER-007).

**Targets:**

| Target path | Content |
|---|---|
| `streams/<stream>/releases/<seq>.dsse` | Release statement (protocols §20.6) |
| `streams/<stream>/proofs/<seq>.json` | `keylos.tlogproof/1` for the release statement |
| `streams/<stream>/revocations/<serial>.dsse` | Revocation list DSSE (protocols §11.7) |
| `apps/<name>/<version>.json` | App release document (§4.3.2) |
| `streams/<stream>/kmod/<kernel-release>/<name>.json` | App release document with `"kind": "kmod"` for a release's kernel (protocols §20.6) |
| `catalog/catalog.json` | `keylos.catalog/1` (protocols §20.20), signed by the `catalog` role |
| `rebuilders.json` | `keylos.rebuilders/1` (§4.3.3) |
| `logs.json` | `keylos.logs/1`: log origins, public note keys and tile URLs for the release and realisation logs |

`keylos.rebuilders/1`, `keylos.logs/1` and `keylos.apprelease/1` are formats owned by `courier` (protocols §19.4). No other repository parses them.

### 4.3 Documents

#### 4.3.1 Release statement

The release statement is protocols §20.6. `courier` verifies:
- the DSSE signature by `release-stream/<stream>`;
- `stream` equals the subscribed stream;
- `arch` equals the machine;
- the machine's profile exists in `profiles`;
- `floor ≤ seq`;
- `revocations.serial` is ≥ any known serial;
- the tlogproof (protocols §20.14) against `logs.json` and `rebuilders.json` witnesses;
- `profiles.<p>.recoveryGen` is present, and for `cloud` also `pcr11Seed` (REQ-COURIER-009).

#### 4.3.2 App release document (`keylos.apprelease/1`, courier-owned)

```json
{"schema":"keylos.apprelease/1","name":"org.example.Editor","version":"2.5.0",
 "gen":"gen:fsv256:…","drv":"drv:sha256:…","oci":{"repository":"oci.example.com/editor","manifest":"sha256:…"},
 "publisher":"key:sha256:…","quorumRequired":0,"security":false,"notes":"…"}
```

#### 4.3.3 Rebuilders list (`keylos.rebuilders/1`, courier-owned)

```json
{"schema":"keylos.rebuilders/1",
 "operators":[{"id":"op-a","keys":["key:sha256:…"],"spki":{"key:sha256:…":"<base64 DER>"}}],
 "required":{"default":"2-of-3"},
 "witnesses":[{"name":"witness.example.org","vkey":"<C2SP note verifier key>"}],
 "witnessThreshold":2}
```

### 4.4 OS staging state machine

```
idle ─check()→ available(seq)
available ─stage(gen) or autoStage→ verifying           (REQ-COURIER-003; REQ-COURIER-012 widening approval)
verifying ─ok→ snapshot                                 (StrataAdmin.preUpdate)
snapshot ─ok→ fetching                                  (depot.install oci://…#gen=… for osGen, the recovery generation
                                                          named by the UKI cmdline, and kmods for a new kernel)
fetching ─ok→ uki                                       (download blob through gate, sha256, size, kl-uki verify)
uki ─ok→ predicting                                     (cmdline pins checked (REQ-COURIER-006); event-log replay +
                                                          new UKI Authenticode hash → PCR4; branches)
predicting ─ok→ locking                                 (kl-boot-tpm pcrlock update; NV 0x01300103 + token branches;
                                                          PCR11 is at "ready" for the whole runtime)
locking ─ok→ installing                                 (write ESP file keylos_<seq>+3-0.efi; systemd-boot sorts
                                                          entries by version, so the newest wins; LoaderEntryDefault
                                                          is set only by rollback)
installing ─ok→ staged                                  (update.stage receipt; VouchLink.announce("release-staged");
                                                          notify "Restart to finish updating")
staged ─reboot→ assessing (next boot)
any ─error→ failed(step, reason)                        (partial ESP artifacts removed; depot generations stay rooted
                                                          for retry)
```

State is persisted in `/var/lib/courier/state.json` after each transition, with an atomic write. On restart, `courier` resumes from the persisted state; every step is idempotent.

### 4.5 PCR prediction and pcrlock branches

1. **Replay.** Read the TCG event log through `kl-boot-tpm` and replay it to confirm it reproduces the current PCRs 0–7 (and 14 in shim mode). A PCR that fails to reproduce is marked **unpredictable**.
2. **Predict** the new boot's values per PCR:

   | PCR | Prediction |
   |---|---|
   | 0, 2 | Unchanged (no firmware update staged), omitted (firmware update staged, REQ-COURIER-040), or vendor-predicted |
   | 4 | Replay of the event log with the `EV_EFI_BOOT_SERVICES_APPLICATION` event for the UKI replaced by the new UKI's Authenticode PE hash; if systemd-boot itself is updated in this release, its event is replaced too |
   | 7 | Unchanged, unless a `db`/`dbx` update is staged (§4.9). Then the new variable contents are substituted in the `EV_EFI_VARIABLE_DRIVER_CONFIG` events, together with the authority event for the certificate that will verify the new UKI |
   | 14 (shim) | Recomputed from the MOK list |

3. **Branches:**
   - A: the current measured values, so the current entry keeps working until the reboot;
   - B: the predicted values for the staged entry;
   - C: the values for the previous good entry (rollback);
   - one branch per pinned entry;
   - at most `maxBranches` (default 4, never more than 8); the oldest unpinned branches are dropped first.
4. **Write.** `kl-boot-tpm` computes the `PolicyOR` composition from the `PolicyAuthorize(streamKey, "keylos/unlock/1")` start digest and writes NV `0x01300103`. Write authorization: the `PolicyAuthorize(release-stream key, "keylos/pcrlock-write/1")` branch, satisfied by the stream-signed `ready`-phase policy in the running UKI's `.pcrsig`. It then writes `pcrlock_branches` into the LUKS2 token.
5. **Unpredictable PCRs** are dropped from the selection of all branches when `dropUnpredictable = true` (the default). The weakened selection is recorded in the receipt and shown in `courier status`.
6. The **`ui` token field** is refreshed when `/etc/keylos/boot.json` changes the initrd UI keys (`vbu`, `pinAttemptsPerBoot`, `console`).

### 4.6 Assessment and floor rule

**Assessment** follows REQ-COURIER-020:
- poll `Supervisor.services()` every 5 s;
- watch the `ledger` checkpoint (`Ledger.checkpoint`) and the `atrium` service health;
- read the boot report.

**Floor rule on good:**

```
F := release(seq_booted).floor                      (the value the running UKI's floor-write approval binds)
if current_floor ≥ F:                    nothing to write
elif some pinned release has seq < F:    write nothing; status "floor held by pin"   (no intermediate value)
else:
    kl-boot-tpm floor write                (policy session: PolicyPCR(11 ready) ∧ PolicyNV(≤ F) ∧ PolicyCpHash(write F))
    on lost acknowledgment: read back; if floor ≠ F, repeat the same write
receipt update.commit {floor: {from, to}}  (to = F, or from when nothing was written)
```

After the floor rises, entries with `seq < floor` cannot unseal. `courier` deletes them from the ESP, except pinned ones, which by construction are not below the floor. **Interrupted update.** A power loss during the floor write can leave the index unreadable (TCG TPM 2.0 Part 1 §37.7.1); the next boot then cannot unlock (unlock policy step 2) and goes to recovery, where the floor is re-initialised (REQ-COURIER-053). A crash before the write simply repeats the rule at the next good boot.

### 4.7 App updates

1. `depot.list("app", "")` gives the installed apps and versions.
2. For each, look up the newest `apps/<name>/<version>.json` in its publisher delegation: SemVer-greater versions only, in the same major unless `allowMajorAppUpdates`.
3. Verify per REQ-COURIER-004.
4. Call `depot.install("oci://<repo>@<manifest>#gen=fsv256:<hex>")`. `depot` returns the capability diff and handles consent (`keylos.consent/1`). A widening update stays non-launchable until the human consents in `depot`'s flow.
5. Write an `update.stage` receipt with `kind: "app"`.

### 4.8 Firmware: the fwupd island

The island consists of three processes. `courier` spawns them itself as its children through `Supervisor.spawn` (facet `warden#service`). They are not registered services. Authority reaches them only as fds and broker-issued tokens:

| Process | Role | Authority given by courier |
|---|---|---|
| `dbus-broker` (private instance) | A bus with exactly two peers | A private tmpfs dirfd shared only with the two peers |
| `fwupd` | C daemon from `pkgs` | Device tokens for the update targets (`/dev/mtd*`, NVMe admin, the hidraw of supported docks), requested from `broker` per update and attached to the spawn; an fd of `/sys/firmware/efi/efivars` (rw); a dirfd of the ESP's `/EFI/UpdateCapsule` directory. No network |
| `courier-fw` | Rust adapter that speaks D-Bus to fwupd on the private bus and capwire to `courier` | Its connection to `courier` (an fd) |

**Flow:**
1. `courier` downloads the LVFS metadata (`firmware.xml.zst` plus the `.jcat` signature) through `gate`.
2. `courier-fw` passes it to fwupd as an fd (`UpdateMetadata`). fwupd verifies the jcat signatures itself, and `courier` also checks the jcat against the pinned LVFS certificate (`lvfsCertSha256`).
3. `courier fw list` → `GetDevices` and `GetUpgrades`.
4. `courier fw update <device>`: presence with purpose `update.firmware`. The rendered details include the vendor, the version, and the text "Firmware measurements will not be checked on the next boot; verify with your phone".
5. Download the cabinet through `gate`, verify its checksum from the metadata, and pass it as an fd to `Install` with the `offline` flag for capsules.
6. Stage the pcrlock branch without PCR0/2 (§4.5), announce `firmware-pending` to `vouch`, then reboot.
7. On the next good boot, re-lock PCR0/2 to their measured values and announce `baseline-update` with the new values.

### 4.9 Secure Boot database procedures

**Owner mode:**
1. **Add a certificate to `db`** (a new stream certificate, or an option-ROM hash):
   - build an `EFI_VARIABLE_AUTHENTICATION_2` append update and have it signed by the owner KEK (`0x81000101`) through `HearthTpm.sbSign("kek", payload, presenceEnvelope)` with a `boot.sb-sign` presence envelope (REQ-COURIER-042);
   - write it to `db` through efivarfs;
   - predict PCR7 (§4.5);
   - require one good boot with a UKI signed under the new certificate.
2. **Revoke via `dbx`**: only after step 1 is complete, with the same mechanics as an append to `dbx`. A revocation that would make the current or the newest good UKI unbootable MUST be refused. This is checked by verifying both UKIs against the would-be `db`/`dbx`.
3. **Shared boot** (`keepMicrosoftCAs`, REQ-COURIER-044): Microsoft `dbx` content is re-signed with the owner KEK and applied as in step 2. The Windows boot manager is checked against the would-be `dbx` too; a revocation that would stop Windows from booting is applied only after an owner confirmation on the trusted path naming that effect.

4. **Owner change** (new KEK/db signers staged by `hearth`, hearth spec §4.7.4): the firmware re-enrolment happens outside `courier` (owner PK-signed KEK update or setup-mode ceremony); `courier` detects it by reading back `KEK`/`db` at boot and reports it with `HearthTpm.sbAccepted` (REQ-COURIER-045). It never infers acceptance from a successful write alone.

**Shim mode:**
- Apply the vendor shim update first: the new `shimx64.efi` plus a MOK-signed systemd-boot.
- After a good boot, write the SBAT policy (`SbatPolicy=latest`) per REQ-COURIER-043.
- Install vendor `dbx` updates (shipped in the release as `dbxupdate.bin`) only after event-log replay confirms that no boot component in use is revoked.

### 4.10 Resolver for depot

#### 4.10.1 Generations

`depot.install("tuf:<stream>/<name>[@<version>]")` makes `depot` call `CourierResolver.resolve(source)` (facet `courier#depot`). `courier` performs the TUF lookup and the REQ-COURIER-003/004 verification, and returns a `Resolution`:
- `oci`: the `oci://` reference;
- `expectedGen`: the expected generation digest;
- `attestations`: a JCS bundle of the realisation DSSEs and their tlogproof bundles;
- `publisher`: the signing key ref;
- `quorum`: `"k/n"` or `"none"`;
- `statement`: the authorising generation statement DSSE (protocols §20.7), from the release or app delegation's `gen-statements/<hex>.dsse` target;
- `review`, `catalogEntry`: from the catalog (REQ-COURIER-008).

`tuf:org:<org>/<name>[@<version>]` follows REQ-COURIER-007 against the org repository and returns the same fields (`publisher` = the `org-publisher/<org>/<id>` key ref; `review` is always `""`, org apps are not catalog apps). `tuf:catalog/<name>[@<version>]` returns only `review` and `catalogEntry`; `depot` uses it for generations installed from other sources (for example `.klb` bundles).

#### 4.10.2 Revocation lists

`resolve("tuf:<stream>/revocations")` returns a `Resolution` whose `revocations` field is the newest verified revocation-list DSSE for the stream (protocols §7.5.6); every other field is empty (`quorum` is `"none"`). `depot` polls this after every `courier` refresh, signalled by `courier` calling `depot.revocations()` immediately after a refresh, and stores the list as `/store/revocations/<stream>.dsse` (protocols §10.7), where `boot` and `warden` read it.

#### 4.10.3 Offline answers

While TUF timestamp metadata is expired (REQ-COURIER-052), `resolve` of a generation source fails with `kl:expired` and the revocation age in the message; `resolve("tuf:<stream>/revocations")` still returns the newest known list.

### 4.11 Persisted state

| Path | Content |
|---|---|
| `/var/lib/courier/tuf/` | TUF metadata (root history, timestamp, snapshot, targets, delegations) |
| `/var/lib/courier/logs/` | Latest verified checkpoints per log (with cosignatures); a consistency proof is required from each stored checkpoint to the next |
| `/var/lib/courier/state.json` | Staging state machine; boot history `[{seq, entry, result, time}]` |
| `/var/lib/courier/pins.json` | Pinned releases |
| `/var/cache/courier/` | Downloaded blobs (UKI, LVFS) until staged, at most 4 GiB |

---

## 5. Interfaces

### 5.1 `Courier` (protocols §7.3.9)

| Method | Semantics |
|---|---|
| `check()` | Refresh metadata (REQ-COURIER-050 gating) and return OS and app updates. `UpdateInfo.current` and `available` are generation refs; `capabilityDiff` is the rendered `policyDefaultsDiff` plus `newServices`; `rebuilderQuorum` is `"<attesting>/<n>"` |
| `stage(target)` | `target` is the OS generation ref of an available release, or an app generation ref. Runs §4.4 or §4.7. A widening OS release first requests presence (REQ-COURIER-012); if it is declined, the method fails with `kl:denied` |
| `status()` | `state` is JCS JSON `{state, step, error, floor, current:{seq,gen}, staged:{seq,gen}, unpredictablePcrs:[…], firmwareWindowOpen:bool, metadataExpires, revocationAgeDays, updatesPaused:bool, integrity, kmodsMissing:[…]}`. `bootCounter` is the counter of the current entry, for example `"3-0"` or `"good"` |
| `rollback()` | REQ-COURIER-031 |
| `pin(ref)` | REQ-COURIER-032 |

Facets (protocols §19.2): `client` (`check`, `status`); `admin` (all methods, plus `CourierAdmin` through `Extensible.ext`); `depot` (`CourierResolver`).

### 5.2 `CourierAdmin` (repo-local)

`schema/courier-local.capnp` has a file ID outside the protocols range. It is used only by the `courier` CLI, through `Extensible.ext` on the `admin` facet.

```capnp
@0x9c41f0d2b7e6a315;
using C = import "common.capnp";

interface CourierAdmin {
  unpin          @0 (ref :C.Ref) -> ();
  history        @1 (limit :UInt32) -> (json :Text);
  firmwareList   @2 () -> (json :Text);
  firmwareUpdate @3 (deviceId :Text, release :Text) -> ();
  sbdbStage      @4 (op :Text, payload :C.Fd) -> ();     # "db-append" | "dbx-append" | "sbat-latest"
  assessNow      @5 () -> (result :Text);
  verifyRelease  @6 (seq :UInt64) -> (report :Text);
  stageFromMedia @7 (dir :C.Fd) -> ();                  # recovery environment: release bundle on removable media
}
```

### 5.3 CLI `courier`

| Command | Description | Exit |
|---|---|---|
| `courier check [--json]` | List updates | 0, 2 unreachable, 6 network unavailable |
| `courier stage [<seq>\|<app-name>]` | Stage the newest release, or a given one (OS by default) | 0, 1 denied, 4 verification failed, 7 approval declined |
| `courier stage --from-media <dir>` | Stage a release bundle from removable media (recovery environment; the same verification, using the bundle's tlogproofs and witness cosignatures) | 0, 4 |
| `courier status [--json]` | State, floor and entries | 0 |
| `courier entries` | ESP entries with seq, counter, good/bad and pinned | 0 |
| `courier rollback` | REQ-COURIER-031 | 0, 1, 3 none eligible |
| `courier pin <seq>` / `courier unpin <seq>` | Pins | 0, 1, 3 |
| `courier history [--limit N]` | Boot and update history | 0 |
| `courier fw list` / `courier fw update <device> [--release R]` | Firmware | 0, 1, 4, 7 |
| `courier sb status` / `courier sb db-append <cert.der>` / `courier sb dbx-append <hash\|cert>` | Secure Boot databases (owner mode) | 0, 1, 4, 7 |
| `courier assess` | Force an assessment now (diagnostics) | 0 good, 8 bad |
| `courier sb shared-boot on\|off` | Add or remove the Microsoft CAs in `db` (REQ-COURIER-044); presence | 0, 1, 7 |
| `courier offline` | Revocation age, metadata expiry and the active offline rules (protocols §14.5) | 0 |
| `courier verify-release <seq>` | Run the REQ-COURIER-003 verification without staging, printing every proof | 0, 4 |

Exit codes: 0 ok, 1 denied, 2 courier unreachable, 3 invalid state, 4 verification failed, 6 network, 7 approval declined, 8 assessment bad, 64 usage.

---

## 6. Security

| Threat | Mitigation |
|---|---|
| Compromised mirror or CDN | TUF; content digests; logs |
| Targeted malicious release (split view) | Release-log inclusion with ≥ `witnessThreshold` witness cosignatures; consistency proofs between stored checkpoints |
| Compromised build infrastructure | k-of-n independent rebuilders (`rebuilders.json`); attestations included in the realisation log |
| Freeze attack (stale metadata hides updates or revocations) | Timestamp expiry of 1 day; after 7 days without fresh metadata, staging stops with a critical notice (REQ-COURIER-052); known revocation lists keep applying |
| Rollback to a vulnerable OS | Floor (NV) plus TUF version monotonicity |
| Malicious firmware capsule | fwupd jcat verification plus the pinned LVFS certificate; presence; VBU recommended after the update; the PCR0/2 weakened window is explicit and limited to one boot |
| ESP tampering at runtime | The ESP is mounted only in courier's view; UKIs are verified at stage time and by Secure Boot at boot |
| A compromised courier | Can stage only stream-signed UKIs (Secure Boot enforces); can write the running release's own floor `F` early or despite a pin (a recoverable DoS); cannot write any other floor value, lower the floor, produce owner-presence signatures, or sign Secure Boot updates without a touch |

**Self-confinement** (service-set entry, shipped in the distribution defaults):

| Aspect | Setting |
|---|---|
| Tier and network | t0, dynamic UID, `network: "gate"` (grants for the TUF, OCI, log, witness and LVFS hosts) |
| Devices | `/dev/tpmrm0` (`privileges.tpm: true`) |
| Paths | the ESP (`/efi`) and `/sys/firmware/efi/efivars`, both read-write, as `privileges.paths` mounts in its view; the ESP is mounted only while `courier` runs |
| Syscalls | no extras |
| Capabilities | none; efivarfs and ESP write access come from the idmapped mounts owned by courier's UID |

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| Crash mid-stage | Resume from state (all steps are idempotent); the current entry is untouched until the UKI is written |
| ESP full | Remove old unpinned entries per REQ-COURIER-011; if still full, fail with `kl:unavailable` and a notification |
| NV write fails (TPM busy or lockout) | Retry 3× with backoff, then fail staging (the staged entry would not unseal without the branch) |
| Floor write acknowledgment lost | Read back; repeat the identical write of `F` (REQ-COURIER-033) |
| Floor index missing or unreadable | Critical notice; staging refused; re-initialisation only in the recovery environment (REQ-COURIER-053) |
| `ready` not reached (assessment pending) | pcrlock writes are deferred; staging waits in `predicting` |
| New boot fails 3× | systemd-boot falls back; `courier` detects it (REQ-COURIER-022) |
| No good boot possible (every entry bad) | Recovery profile; the recovery environment runs `courier stage --from-media` |
| Witnesses unreachable | Use cached cosigned checkpoints if they cover the entry; otherwise wait (no staging without inclusion) |
| Quorum not reached | The release stays `available` but not stageable; status shows `quorum 1/3`; re-checked on every refresh |
| `strata` unavailable | `preUpdate` is retried 3×; then staging proceeds with the `update.stage` receipt noting `snapshot: "unavailable"` |

---

## 8. Performance budgets

| Operation | Budget |
|---|---|
| Metadata refresh (warm) | ≤ 3 HTTP requests, ≤ 200 KiB |
| Verification of a release (logs + quorum), cached tiles | ≤ 500 ms |
| PCR prediction and NV update | ≤ 2 s |
| OS update download (zstd:chunked, typical security release) | ≤ 15% of a full image |
| Memory | ≤ 64 MiB RSS |

---

## 9. Observability

**Receipts** (protocols §19.3):

| Event | `data` |
|---|---|
| `update.stage` | `{kind: "os"\|"app"\|"firmware"\|"sbdb", seq, gen, uki, quorum, pcrSelection, weakened: [pcr], snapshot, presence}` |
| `update.commit` | `{kind, seq, floor: {from, to}, firmware: {pcr0, pcr2}?}` |
| `update.rollback` | `{from, to, reason: "user"\|"boot-failed"}` |

**Metrics** (`0x1F` records): `courier_last_check_timestamp`, `courier_metadata_expiry_seconds`, `courier_updates_available{kind}`, `courier_stage_failures_total{step}`, `courier_floor`, `courier_boot_assessment{result}`, `courier_unpredictable_pcrs`, plus `boot_unlock_seconds`, `boot_initrd_seconds`, `boot_vbu_result{result}` and `boot_pin_failures_total` from the boot report.

**Logs:** every verification step at `info`; failures at `err`, with the digests of the proof material.

---

## 10. Configuration

```nickel
{
  courier | {
    streams | Array String | default = ["stable"],
    profile | String | default = "desktop",
    mirrors | { tuf | Array String | default = ["https://tuf.keylos.org/"],
                oci | Array String | default = ["oci.keylos.org"] },
    checkIntervalHours | Number | default = 6,
    autoStage | [| 'none, 'security, 'all |] | default = 'security,
    allowMetered | Bool | default = false,
    keepEntries | Number | default = 3,
    maxBranches | Number | default = 4,
    dropUnpredictable | Bool | default = true,
    assessTimeoutSecs | Number | default = 300,
    trustedPublishersWithoutQuorum | Array String | default = [],
    allowMajorAppUpdates | Bool | default = false,
    firmware | { enabled | Bool | default = true, lvfsCertSha256 | String },
    kmods | Array String | default = [],        # enabled kmod names, shared with warden (warden.kmods)
    orgs | { _ : { tuf | String, root | String } } | default = {},   # org TUF repositories (fleet module): URL and pinned root digest
  },
  secureboot | {
    keepMicrosoftCAs | Bool | default = false,  # dual boot; integrity profile shared-boot
  }
}
```

---

## 11. Testing and acceptance criteria

**Unit:**
- the TUF conformance suite (the python-tuf and tough test vectors);
- release-statement validation against the protocols `release/` vectors;
- tlogproof verification against the `tlogproof/` vectors;
- quorum logic: k-of-n with duplicate operators, mismatched drv, mismatched output, and missing log inclusion;
- the floor rule as property tests: the only value ever written is the booted release's `F`; nothing is written while a pin is below `F`; the floor never decreases and never exceeds the booted seq.

**Integration** (qemu + OVMF + swtpm, with a local TUF repository, logs and witnesses):
1. Stage, reboot, good boot: the entry is renamed, the floor is written with the release's `floor`, and the receipts are present.
2. A new UKI that panics: three tries, fallback, and `update.rollback` with `boot-failed`.
3. A release missing a witness cosignature is not stageable.
4. Two rebuilders attest different digests: not stageable.
5. Expired timestamp (clock moved past): refresh fails, and staging is refused after 7 days.
6. Firmware update path with a fake capsule device (the fwupd test plugin): PCR0/2 are omitted for exactly one boot, then re-locked; `vouch` receives both announcements.
7. `db-append` then `dbx-append` in owner mode with OVMF custom keys: `dbx` is refused if it would revoke the current UKI.
8. Crash injection (`kill -9`) at every staging step: staging resumes correctly.
9. `depot.install("tuf:stable/org.example.Editor")` resolves through `CourierResolver` and returns a statement verifiable against a publisher key.
10. Revocation list refresh: `depot` receives a higher serial in `Resolution.revocations` through `resolve("tuf:<stream>/revocations")`.
11. A UKI whose `keylos.revocations=` pin differs from the release statement's `revocations` is not staged (REQ-COURIER-006).
12. Owner-mode `db-append`: `HearthTpm.sbSign` is called with a `boot.sb-sign` envelope whose `payloadSha256` matches; a mismatching envelope is refused by `hearth` and nothing is written.
13. Shared boot: with `keepMicrosoftCAs`, Microsoft `dbx` content is applied re-signed; a `dbx` entry revoking the running keylos UKI is refused.
14. Expired timestamp: `CourierResolver.resolve("tuf:…/app")` returns `kl:expired`; installed apps still launch; `status` shows `updatesPaused: true` and the revocation age.
15. New kernel release with an enabled `kmod`: the matching `kmod` generation is installed during staging; without one, auto-staging stops with `kmod-missing:<name>`.
16. PCR11 mismatch: with a test kernel that skips `warden`'s `ready` extension, `courier` refuses NV writes and assesses the boot bad.
17. TPM cleared in recovery: on the next boot `courier` re-defines NV `0x01300102`/`0x01300103` through `HearthTpm.defineSpace` and re-initialises them.
18. Org source: on a machine enrolled in fleet `acme`, `resolve("tuf:org:acme/com.acme.Tool")` returns a statement signed by an enabled `org-publisher/acme/…` key; the same call on an unenrolled machine fails with `kl:not-found`; a statement signed by a disabled org key fails with `kl:integrity`.
19. Catalog: a reviewed catalog app resolves with `review = "reviewed-reproducible"` and its entry; an unlisted app gets `review = ""`; with the catalog expired, a listed app gets `"unreviewed"`; `resolve("tuf:catalog/org.example.Editor")` returns only `review` and `catalogEntry`.
20. Recovery generation: a release whose `recoveryGen` differs from the UKI's `keylos.recovery=` is not staged; a `cloud` release without `pcr11Seed` is not staged.
21. kmod roots: after staging a release with a new kernel, the `kmod` generation is rooted `courier:kmod:<new kernel-release>`; after the old entry is removed from the ESP, the old kernel's root is gone.
22. Floor adversarial (swtpm, protocols §19.6 vectors): from a test tier-0 process with the TPM fd, raw writes of `F − 1`, of `F + 1`, at offset 4, of 4 bytes, and to `0x01300103` with the floor policy all fail; a policy session of the previous release's approval fails; two concurrent `kl-boot floor write` runs both leave the floor at `F`; a stale session started before a floor raise cannot write a lower value.
23. Floor and pins: with a pinned release `seq < F`, a good boot writes nothing and `status` shows `floor held by pin`; after unpinning, the next good boot writes exactly `F`.
24. Floor power loss: a power cut injected during the floor write (swtpm killed) leads either to floor `F` or to an unreadable index; in the latter case the next boot goes to recovery and `kl-boot floor init` restores `F` from the signed release statement; a lost acknowledgment (reply dropped by a TCTI proxy) is followed by an identical rewrite.
25. Owner certificate acceptance: with signers staged by `hearth`, `sbAccepted` is called only after a boot whose `KEK`/`db` read-back contains the staged certificates; with the old variables nothing is called.

**Fuzzing:** release statements, TUF metadata parsing (bounded), checkpoint notes, tlogproof bundles, and LVFS metadata pass-through (size limits only).

**Acceptance:** all integration tests pass on x86_64 and aarch64 qemu, plus one real-hardware update cycle per reference machine per release.

---

## 12. Implementation notes

**Crates:**
- `tough` 0.18 (TUF)
- `oci-client` 0.14 (OCI distribution; an in-house minimal client is allowed)
- the `keylos-tlog-verify` crate from the `tlog` repository, for C2SP note and cosignature verification
- `zbus` 4 (D-Bus, in `courier-fw` only)
- `kl-boot-tpm` (from `boot`)
- `goblin` 0.8 (Authenticode hashing)
- `serde_json` 1, `tokio` 1, `capnp-rpc` 0.19

**Repository layout:**

```
courier/
  crates/courier-svc/  crates/courier-cli/  crates/courier-fw/  crates/keylos-tuf/  crates/pcr-predict/
  islands/fwupd.json  schema/courier-local.capnp  tests/qemu/  fuzz/
```

`islands/fwupd.json` describes the three island processes, their generations (built by `pkgs`) and the authority `courier` hands them (§4.8).

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reference |
|---|---|---|
| TUF over OCI, with `courier` as the only TUF client | Per-component TUF clients (duplicated trust state); plain OCI signatures (no freeze or rollback protection) | [ADR-0017](../../handbook/11-decisions/adr-0017-tuf-over-oci.md) |
| Rebuilder quorum and release log required before staging | Single-builder signatures | [ADR-0016](../../handbook/11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md) |
| Floor taken from the release statement, written only at phase `ready` | Floor = current seq (no rollback); no floor (downgrade attacks) | [ADR-0014](../../handbook/11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md) |
| fwupd in a private island spawned by courier, with authority passed as fds | Reimplementing firmware update protocols; fwupd on a system bus | [ADR-0035](../../handbook/11-decisions/adr-0035-fd-only-portals-dbus-islands.md) |
| Grafted releases are temporary | Shipping grafts as permanent fixes | [ADR-0018](../../handbook/11-decisions/adr-0018-grafts-are-temporary.md) |

### 13.1 Notes on cross-repository contracts

The interim mechanisms of earlier drafts (the revocation-pin writer, the recovery generation's source, the `kmod` target path) are now defined by protocols 1.0.0 (final) §10.7 and §20.6; this repository has no open cross-repository notes.
