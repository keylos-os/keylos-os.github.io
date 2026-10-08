# keylos/vouch: phone companion for verify-before-unlock, witnessing and remote approvals

| | |
|---|---|
| Repository | `github.com/keylos-os/vouch` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `vouch` Android app (Kotlin + Jetpack Compose), `vouch` iOS app (Swift + SwiftUI), `vouch-core` (Rust, shared with the apps via UniFFI), `vouch-proto` (Rust crate: pairing and session wire formats, used by `vouchd` and by `installer`), `vouchd` (machine-side tier-0 service, service name `vouch`), `vouch` (machine CLI), `vouch-relay` (optional, self-hostable store-and-forward relay) |
| Depends on | `keylos-protocols 1.0` (crates `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-tpm-registry`); `tlog` 1.0 client library (C2SP verification); TPM vendor CA bundle (shipped in this repo, updated per release) |
| Provides | `VouchLink` (protocols §7.5.22); the phone side of the VBU protocol (protocols §20.5), with integrity-profile verdicts; ledger checkpoint witnessing; optional release-log witnessing; phone approvals over the `phone` channel (approver keys registered with the broker each boot); the optional inheritance dead-man timer (protocols §20.19) |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

Secure Boot alone never tells the owner whether the machine in front of them is the one they left. vouch gives the owner an independent device that does three things:

1. **Verify before unlock.** Before the owner types the disk PIN, the phone checks a fresh TPM quote from the machine (signed by AK0 over PCRs 0–15 with a phone-chosen challenge) against the release-log predictions for the booted UKI and the machine's recorded firmware baseline (protocols §20.5).
2. **Witness.** The phone cosigns the machine's ledger checkpoints and detects rollback or split views of the receipt log. It can also act as a public witness of the keylos release log.
3. **Approve remotely.** When the owner is away from the machine (an agent session running unattended, for example), the phone can approve or deny T2/T3 requests that **do not require presence** and whose policy allows the `phone` channel (protocols §14.3, §16.2).
4. **Inheritance (optional).** The phone holds an encrypted inheritance note and releases it to the owner's trustees after a configurable period without an owner login (protocols §20.19). It never holds a key; trustees still need *k* trustee cards.

### 1.1 Non-goals

- **Presence.** vouch never substitutes for owner presence (protocols §14.3: a phone approval "never satisfies `requiresPresence`"). Config apply, seal, policy change, payment, persistent grants and any effect whose policy says `presence` need the owner's FIDO2 credential at the machine's trusted path.
- **Unlocking the disk.** The phone holds no disk key material.
- **Remote control or data access.** The phone never receives files, receipt payloads (except the rendered approval prompt), or agent transcripts.
- **Cloud dependency.** Every function works over a direct local connection. The relay is optional and sees only ciphertext.

---

## 2. Context and embedded contracts

Every shared contract below is copied **verbatim** from `keylos-protocols 1.0`; if a copy differs, protocols wins.

### 2.1 Verify-before-unlock protocol (protocols §20.5)

Shared by `boot` (initrd side) and `vouch` (phone side).

**Keys.** AK0 (`0x81010003`) signs pre-unlock quotes. The phone stores AK0's public key, the EK certificate chain fingerprint, the machine key, the stream and the TUF root of the stream at pairing time.

**Flow:**

```
initrd                                   phone (vouch)
  │ QR1 = KLV1 + CBOR{1:v=1, 2:t="vbu-hello", 3:machine-key, 4:stream, 5:seq, 6:osGen}
  │──────────────── scan ─────────────────►│
  │                                         │ challenge N = 8 Crockford base32 characters (40 bits), shown; expires after 120 s
  │◄──────────── user types N ─────────────│
  │ qualifyingData = SHA-256("keylos-vbu/1" ‖ N ‖ machine-key)
  │ TPM2_Quote(AK0, sha256 PCRs 0–15, qualifyingData)
  │ QR2 = KLV1 + CBOR{1:v, 2:t="vbu-quote", 7:TPMS_ATTEST, 8:TPMT_SIGNATURE, 9:{pcr→value}, 10:event-log digest,
  │                   11:{resetCount, restartCount}, 12:UKI sha256, 13:{stream, seq}}
  │──────────────── scan ─────────────────►│ verify → VERIFIED / FIRMWARE CHANGED / NOT VERIFIED (+ reason)
  │ prompt: continue to PIN / power off / recovery
```

**Phone verification:**
1. The signature on `TPMS_ATTEST` verifies with AK0; `magic = TPM_GENERATED_VALUE`; `type = TPM_ST_ATTEST_QUOTE`; `extraData = qualifyingData` computed from the phone's own N.
2. `pcrDigest` equals SHA-256 over the reported PCR values for the quoted selection.
3. PCR11 equals the `enter-initrd` prediction for (stream, seq, profile) in a `keylos.release/1` statement the phone holds with a `keylos.tlogproof/1` proof cosigned by ≥ `witnessThreshold` witnesses.
4. PCR12 equals the release statement's `pcr12`; PCR13 is the "no extension" value; PCR15 is all zeros (not yet unlocked).
5. PCRs 0, 2, 4, 7 (and 14 in shim mode) equal an accepted firmware baseline (amber "firmware changed" when a pending firmware update was announced via `VouchLink.announce`).
6. `seq` ≥ the highest `seq` seen for this machine; `resetCount` did not increase unexpectedly.

**QR encoding:** CBOR (RFC 8949 deterministic) with the integer keys above, prefixed by the 4-byte magic `KLV1`; binary-mode QR, error correction M. Payloads over 1 000 bytes are split into a rotating sequence (400 ms) prefixed `KLV1<idx>/<total>`.

**TOTP fallback:** a 20-byte HMAC secret sealed under `PolicyPCR(0,2,4,7,11=enter-initrd)`, stored at `/efi/keylos/vbu-totp.sealed` (created by the installer's `keylos-enrol vbu-totp`); the initrd shows a 6-digit RFC 6238 code (SHA-1, 30 s).

### 2.2 Release statement (protocols §20.6)

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

### 2.3 Transparency logs (protocols §11.5)

keylos operates two logs, both following **C2SP tlog-tiles** with checkpoints per **C2SP tlog-checkpoint** and witness cosignatures per **C2SP tlog-cosignature**:

| Log | Origin line | Entries |
|---|---|---|
| Realisation log | `log.keylos.org/realisations` | DSSE realisation attestations (§11.4) |
| Release log | `log.keylos.org/releases` | DSSE release statements (`keylos.release/1`, §20.6) and cloud image records (`keylos.cloudimage/1`, §20.24), signed by `release-stream/<stream>` |

Clients MUST verify inclusion against a checkpoint cosigned by at least `witnessThreshold` (default **2**) witnesses from the witness list in TUF targets metadata (`rebuilders.json`: `witnesses`, `witnessThreshold`). A generation is installable from a distro or publisher channel only if its realisation log entries reach the rebuilder quorum named in its release or app-release statement.

### 2.4 Transparency-log proof bundle (protocols §20.14)

```json
{"schema":"keylos.tlogproof/1",
 "origin":"log.keylos.org/realisations",
 "index":123456,
 "entry":"<base64 of entry bytes>",
 "checkpoint":"<full signed note text including cosignature lines>",
 "inclusion":["<base64 hash>"]}
```

Verification: verify the log signature on the checkpoint with the origin's key (TUF `logs.json`); verify ≥ `witnessThreshold` cosignatures from distinct listed witnesses; compute the RFC 6962 leaf hash of `entry` and verify inclusion at `index`; update the persisted last-seen checkpoint (consistency-checked) when online.

### 2.5 Checkpoints (protocols §13.3)

- `ledger` emits a **C2SP signed-note checkpoint** (origin `keylos-ledger/<machine key>`) at least every 60 s while there is activity, and on shutdown.
- The TPM NV counter `0x01300100` (§19.6) is incremented at most once per 900 s while there is activity, at shutdown, and immediately after security-class events (`grant.revoke`, `config.apply`, `gen.seal`, `update.commit`, `key.enroll`, `key.remove`, `ledger.alarm`). Every checkpoint note carries the extension line `counter <n>` with the current counter value, binding the tree size and root hash in the signed note to the counter. A ledger whose newest checkpoint counter is below the NV value has been rolled back.
- Checkpoints MAY be submitted to owner-configured witnesses (`LedgerWitness`, §7.5.5: the `vouch` phone, a fleet witness).
- `ledger.key.register` receipts are never sealed; their `data` is `{"service": "<name>", "spki": "<base64 DER>", "keyRef": "key:sha256:…"}`. `Ledger.serviceKey` (§7.3.5) answers from them.

### 2.6 Trusted-path prompt types (protocols §7.3.4)

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

### 2.7 vouch system interface, implemented here (protocols §7.5.22)

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

### 2.8 Ledger interfaces used by `vouchd` (protocols §7.3.5, §7.5.5)

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

### 2.9 Approval tiers (protocols §14.3)

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

### 2.10 Mandates (protocols §14.4)

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

### 2.11 Cedar decision mapping and annotations (protocols §16.2)

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

### 2.12 Signed documents (protocols §5.1)

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

### 2.13 Cryptography (protocols §4)

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

### 2.14 Trust roots (protocols §5.2)

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

### 2.15 TPM objects and PCRs (protocols §19.6)

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

### 2.15a Profiles and integrity profiles (protocols §2.2)

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

### 2.15b Trustee shares and inheritance (protocols §20.19)

**Trustee shares** split the 32-byte recovery key secret (§20.21) into *n* shares with threshold *k* (2 ≤ k ≤ n ≤ 16) using Shamir over GF(2^8) per byte. Splitting needs presence (purpose `trustee.split`).

```json
{"schema":"keylos.trustee/1","set":"<base32 8 chars>","machine":"key:sha256:…","k":2,"n":3,"index":1,
 "share":"<base32 of 32 bytes>","check":"<first 8 hex of SHA-256(recovery secret)>","created":"…"}
```

The printed card carries this JSON as a QR (binary mode, error correction Q) and the `share` in 8-character groups. Reconstruction (recovery environment or `hearth`) verifies `check` before use. A new split invalidates nothing cryptographically; owners revoke old shares by rotating the recovery key.

**Inheritance note** (`keylos.inheritance/1`, optional): a note encrypted with HPKE to each listed trustee's public key, held by the owner's paired `vouch` phone. If the dead-man timer (`VouchLink.inheritance`) sees no owner login heartbeat for the configured number of days (≥ 30), the phone releases the encrypted note to the trustees. The note never contains a key; trustees still need *k* shares.

### 2.15c Boot trust set and boot report (protocols §20.1)

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

### 2.15d Broker system interface (protocols §7.5.2)

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

### 2.16 Facets (protocols §19.2, rows that vouch serves or uses)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| broker | `system` | warden, gate, aide, atrium, config, hearth, strata, net, depot, vault, vouch, cri | `BrokerSystem` (per-method callers as commented in §7.5.2; `requestFor` with the allowed-subject rule, atrium only for its own session (device authorization); `registerApprover`: atrium, vouch; `admitPod`: cri; `mintCaptive`: net); `Broker.inspect` |
| ledger | `witness` | vouch, fleet | `LedgerWitness` |
| ledger | `vouch-heartbeat` | vouch | `Ledger.query`/`watch` restricted to metadata (time, subject human) of `user.login` receipts of every human (§20.19) |
| hearth | `system` | warden, devd, config, broker, gate, vouch, strata, bench, depot, ledger, loom | `HearthSystem` (gate, vouch, strata, bench, depot, ledger: `owners` only; loom: `owners`, `userState`, `watchUsers`) |
| hearth | `tpm` | courier, vault, strata, ledger, config, vouch, fleet | `HearthTpm` (`defineSpace`, `recreateKey`: the object's registered owner; `sbSign`, `sbAccepted`: courier; `activateCredential`: vouch, fleet) |
| gate | `client` | principals with net needs, portal-files, atrium (staging `media.export`) | `connect`, `stage` (own session), `intents` (own session tree, recursive), `intent` (own session tree), `meter` (own roots); `DurableEffects.prepare`, `complete`, `lookup`, `watch` (attempt sessions, own workflow) |
| vouch | `settings` | atrium settings, owner `shell` | `VouchLink` pairing methods, `phones`, `remove`, `inheritance` |
| vouch | `approvals` | atrium | `VouchLink.routeApproval` |
| vouch | `announce` | courier | `VouchLink.announce` |

### 2.17 Receipt events (protocols §19.3, vouch row)

| Event | Writer |
|---|---|
| `vouch.pair`, `vouch.remove`, `vouch.witness.cosigned`, `vouch.witness.conflict` | vouch |

**Extension rule.** A repository MAY emit additional events named `x-<repo>.<event>` (for example `x-strata.replica.send`). They MUST be listed in that repository's spec, MUST be written only by that repository's services, and carry no semantics for other components. Events named without a prefix MUST appear in this table.

### 2.18 vsock and network

`vouchd` has no vsock use. Its network access is through `gate` only (protocols §7.3.7 `Gate.connect`, including `"listen:<addr>"` targets for the LAN listener).

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

---

## 3. Requirements

### 3.1 Pairing

- **REQ-VOUCH-001** Pairing MUST authenticate both sides with a secret transferred out of band by a QR code displayed on the machine, and MUST NOT rely on DNS, mDNS or any third party.
- **REQ-VOUCH-002** During pairing the phone MUST verify:
  - the machine's EK certificate chain against its bundled TPM vendor CAs;
  - that AK0 (`0x81010003`) and AK (`0x81010002`) reside in the same TPM as the EK, via a `MakeCredential`/`ActivateCredential` exchange for each;
  - that the AK names match NV `0x01300108` as reported by the machine.
- **REQ-VOUCH-002a** On the machine side, `vouchd` MUST perform every credential activation through `HearthTpm.activateCredential(akHandle, credentialBlob, encryptedSecret)` on `hearth#tpm` (protocols §7.5.3), with `akHandle` = `0x81010003` (AK0) or `0x81010002` (AK). `vouchd` never holds the endorsement hierarchy authorization. During installation the installer performs the same activation directly while it still holds that authorization (installer spec §4.10); every pairing after installation goes through `HearthTpm`. There is no unverified pairing mode: an offline pairing stays `pending` until the activation succeeds at the first network contact (§4.3.2).
- **REQ-VOUCH-003** The phone MUST generate a hardware-backed **approval key** (P-256 in Android StrongBox/TEE or the iOS Secure Enclave), gated by biometric or device credential, and a **witness key** (Ed25519, software, wrapped by a hardware key, `ThisDeviceOnly`).
- **REQ-VOUCH-004** A machine MAY pair with several phones. A phone MAY pair with several machines.
- **REQ-VOUCH-005** At pairing the phone MUST store AK0's public key, the EK certificate chain fingerprint, the machine key, the stream and the TUF root of the stream (protocols §20.5 "Keys").

### 3.2 Verify-before-unlock

- **REQ-VOUCH-010** The phone MUST implement the phone side of protocols §20.5 exactly: QR1 `vbu-hello` scan, an 8-character Crockford base32 challenge `N` (40 bits) that expires after 120 s, QR2 `vbu-quote` scan, and the six verification steps.
- **REQ-VOUCH-011** The phone MUST show **VERIFIED** only when all six steps pass with a release statement whose `keylos.tlogproof/1` verified with at least `witnessThreshold` witness cosignatures, either now or within the last 30 days.
- **REQ-VOUCH-012** If the only failing check is step 5 and a firmware update was announced (`VouchLink.announce("firmware-pending", …)`), the phone MUST show **FIRMWARE CHANGED**. If the release statement cannot be verified (offline beyond 30 days, or never fetched), it MUST show **NOT VERIFIED (release unknown)**, never VERIFIED.
- **REQ-VOUCH-013** On any other failure the phone MUST show **NOT VERIFIED** with the reason, naming the differing PCRs and their meaning (§4.3.4).
- **REQ-VOUCH-014** The TOTP fallback (protocols §20.5) MAY be offered. The UI MUST label it as weaker.
- **REQ-VOUCH-015** Every VERIFIED and FIRMWARE CHANGED verdict MUST name the machine's **integrity profile** (protocols §2.2): `full`, `shared-boot` ("Microsoft boot keys are trusted for dual boot"), or `shim` ("booted through shim"); `degraded` machines have no VBU. The profile comes from the paired machine's boot report and MUST be consistent with the PCR 7 (and 14) baseline; a change of profile is a firmware/baseline change (§4.4.5).
- **REQ-VOUCH-016** The phone MUST show, on the machine's page and in every verdict, whether any owner credential is **assisted** (protocols §5.3), when that information is available (§4.2).

### 3.3 Witnessing

- **REQ-VOUCH-020** The phone MUST cosign a machine ledger checkpoint only after verifying the note signature with the machine key, the origin `keylos-ledger/<machine key>`, an RFC 6962 consistency proof from its last cosigned checkpoint, and that the `counter` extension line is not lower than the last one.
- **REQ-VOUCH-021** On a size decrease, a root mismatch at equal size, a failed consistency proof or a counter regression, the phone MUST alert the owner with a high-priority notification and MUST retain both conflicting signed checkpoints as evidence.
- **REQ-VOUCH-022** The phone MAY act as a public witness of the keylos release log if the owner opts in. Cosignatures are then submitted to the log's witness endpoint.

### 3.4 Remote approvals

- **REQ-VOUCH-030** The phone MUST refuse to approve any prompt with `requiresPresence = true`. It MAY show such prompts only as "approve at your computer".
- **REQ-VOUCH-031** Phone mandates MUST be `keylos.mandate/1` payloads equal to the prompt's `mandateDraft` with `"channel": "phone"`, `"presence": false`, `"decidedBy": "<owner>@vouch:<approval key ref>"`, signed with the approval key (`alg: "ecdsa-p256-sha256"`) after a biometric/device-credential prompt.
- **REQ-VOUCH-032** Whether a phone mandate is acceptable is decided by machine policy: the matching permit's `@channels` must include `phone` (protocols §16.2). The phone only signs what the machine asked for.
- **REQ-VOUCH-033** The phone MUST display the rendered effects, the argument provenance, the requesting principal (with agent template name and session) and the expiry. It MUST NOT allow approving until every rendering with `review = required` (protocols §7.3.4, §14.3, E33) has been presented completely and each `mandateDraft` effect has a required rendering bound to it by `payloadDigest`. A title, a digest or a truncation notice never substitutes for a required rendering.
- **REQ-VOUCH-033a** **No truncated review.** If any required rendering of a prompt cannot be presented on the phone in full (it exceeds the transfer or display limits of §4.7.2, its MIME type is not supported by the phone renderer, or its attachment is missing or malformed), `vouchd` MUST NOT send the prompt to the phone as approvable: it answers `routeApproval` with `kl:unsupported` (reason `cannot-present-required`), so the prompt stays pending for a capable channel (the local trusted path) and is denied when it expires. Decorative renderings MAY be truncated or dropped, with a "preview shown at your computer" note.
- **REQ-VOUCH-034** Phones grant only `scope = once`.
- **REQ-VOUCH-035** `vouchd` MUST register each active phone's approval public key with the broker once per boot through `BrokerSystem.registerApprover(publicKey, "ecdsa-p256-sha256", "phone")`, and MUST register nothing when no phone is active. The broker offers the `phone` channel only while a key is registered (protocols §14.3).
- **REQ-VOUCH-036** Phone mandates are re-signed by `service/broker` after verification (protocols §14.4); relying services never see phone keys.

### 3.4a Inheritance

- **REQ-VOUCH-037** The dead-man timer MUST be off by default and configurable only through `VouchLink.inheritance` (facet `settings`) by an owner, with a period of at least 30 days (protocols §20.19).
- **REQ-VOUCH-038** The owner's **login heartbeat** is the newest `user.login` receipt for that owner. `vouchd` MUST read it only through the facet `ledger#vouch-heartbeat` (protocols §7.3.5, §19.2), which returns the metadata (time, subject human) of `user.login` receipts of every human and nothing else, and forwards the time to the phone in `Ping`. `vouchd` MUST NOT hold `ledger#reader`.
- **REQ-VOUCH-038a** `vouchd` MUST read the owner set (owner names and whether a credential is assisted) only through `HearthSystem.owners` on `hearth#system` (protocols §19.2 lists `vouch` as a holder for `owners` only).
- **REQ-VOUCH-039** Before release the phone MUST warn the owner at 7, 3 and 1 days before the deadline with high-priority notifications; any owner action in the app (biometric-confirmed "I'm here") or a new heartbeat cancels the countdown.
- **REQ-VOUCH-040a** On release the phone MUST deliver only the HPKE-encrypted `keylos.inheritance/1` note to each listed trustee; it MUST NOT hold or send any key, recovery secret or trustee share.

### 3.5 Privacy and storage

- **REQ-VOUCH-040** All machine↔phone traffic MUST be end-to-end encrypted with Noise. The relay (if used) MUST see only ciphertext, sizes and timing.
- **REQ-VOUCH-041** Push notifications through APNs or FCM MUST carry no content: only an opaque wake-up token.
- **REQ-VOUCH-042** Phone keys MUST be excluded from cloud backups. Pairing state MAY be exported only as an encrypted vouch backup (§4.7).

---

## 4. Design

### 4.1 Components

| Component | Where | Role |
|---|---|---|
| `vouch-core` | Phone (Rust via UniFFI) | Noise, pairing, VBU verification, minimal TUF client for the stream's keylos repository, C2SP checkpoint verification and cosigning, mandate signing requests, storage encryption |
| Android app | Phone | UI, camera QR scanner, Android Keystore/StrongBox, BiometricPrompt, FCM |
| iOS app | Phone | UI, AVFoundation QR scanner, Secure Enclave, LocalAuthentication, APNs |
| `vouch-proto` | Machines | Pairing and session wire formats and Noise state machines, used by `vouchd` and `installer` |
| `vouchd` | Machine, tier-0 service `vouch` | Running-system side: pairing from Settings or the CLI, checkpoint push, approval routing, approver-key registration, announcements, inheritance heartbeat, connection management |
| `vouch` CLI | Machine, owner shell | Pairing and management through `VouchLink` (facet `settings` granted to the owner shell by policy) |
| `vouch-relay` | Optional server | Store-and-forward of Noise ciphertext, push wake-ups |

The initrd side of VBU is implemented by `boot` (`kl-initrd`), following protocols §20.5. `vouch` does not ship initrd code.

### 4.2 `vouchd`

| Property | Value |
|---|---|
| Service name | `vouch` (protocols §19.1); started when at least one phone is paired, or on demand by `pairStart` |
| Tier | t0 |
| Facets served | `settings`, `approvals`, `announce` (protocols §19.2) |
| Routes held | `ledger#witness` (`LedgerWitness`); `ledger#vouch-heartbeat` (metadata of `user.login` receipts for the inheritance heartbeat); `broker#system` (`registerApprover`); `gate#client` (relay host connect; `listen:` on the vouch port for LAN sessions); `hearth#system` (`HearthSystem.owners` only, for the owner list and assisted-credential display); `hearth#tpm` (`HearthTpm.activateCredential` only, for pairing). All are registry holder entries of protocols §19.2 |
| Devices | `dev:tpmrm:tpmrm0` (EK certificates, `ActivateCredential`, AK quotes for baseline updates); read-only securityfs event log |
| State | `/var/lib/vouchd/` |

Config changes (adding or removing a phone in `vouch.ncl`) are made by the caller that holds a `config` route: the Settings app or the `vouch` CLI in the owner's shell. `vouchd` returns the data; it holds no `config` route.

### 4.3 Pairing protocol

#### 4.3.1 Machine pairing QR

The machine (installer, Settings → Phones → Pair, or `vouch pair`) generates:
- an ephemeral X25519 key pair `M_e`;
- a 32-byte pairing secret `psk`;
- a listening TCP port on trusted local interfaces (via a `gate` `listen:` grant for the vouch port, default 47341).

It displays a QR with `keylos-vouch:1:` followed by base64url (no padding) of the deterministic CBOR map:

```
{
  1: 1,                         ; version
  2: h'…',                      ; machine key fingerprint (SHA-256 of the machine key SPKI)
  3: "laptop-ada",              ; machine name
  4: h'…',                      ; M_e public (32 B)
  5: h'…',                      ; psk (32 B)
  6: ["192.168.1.23:47341", "[fe80::…%wlan0]:47341"],   ; addresses (may be empty)
  7: "stable",                  ; stream
  8: 1730000000                 ; expiry (unix seconds, +10 min)
}
```

The QR is at most 300 bytes (version 10–13 at error-correction level M). This prefix is a `vouch-proto` contract between `vouchd`, `installer` and the phone; it is distinct from the VBU `KLV1` QRs.

#### 4.3.2 Handshake

**Network path.**
- The phone connects to one of the addresses. Noise pattern `Noise_XXpsk3_25519_ChaChaPoly_SHA256`; prologue `"keylos-vouch-pair-v1" ‖ machine fingerprint`; `psk` from the QR.
- The machine static key is `M_e` (pairing only). The phone static key is a fresh X25519 key `P_s`, which becomes the phone's long-term transport key for this machine.
- The handshake fails if the machine's static key differs from the QR, or if the PSK is wrong.

**Offline path (no common network).**
1. The phone scans the QR, generates its keys, and shows a **12-word code**: BIP-39 English words encoding 128 bits = the first 16 bytes of SHA-256(`"keylos-vouch-commit-v1"` ‖ CBOR(phone public keys) ‖ `psk`).
2. The owner types the words on the machine (`VouchLink.pairCode`). The machine stores the commitment.
3. The full exchange (§4.3.3) happens on the first network contact, inside a Noise session authenticated with `psk`; the machine checks the phone's public keys against the commitment.
4. Until then the pairing is `pending`. VBU already works if the phone received the machine data: in the offline path the machine shows the `MachineInfo` (§4.3.3 step 1) as a rotating QR sequence (`keylos-vouch:1:<idx>/<total>:` frames), and the credential activation (steps 3–6) is deferred to the first network contact. Until activation succeeds, VBU verdicts carry the note "AK0 not yet activated" and are never VERIFIED.

#### 4.3.3 Pairing exchange (inside Noise)

| # | Direction | Message (CBOR) |
|---|---|---|
| 1 | M→P | `MachineInfo`: machine key SPKI; EK certificate chain (DER list); EK public (TPM2B_PUBLIC); AK0 and AK public areas and names; NV `0x01300108` contents; stream; the stream's TUF `root.json` (current version) and its digest; current release statement (DSSE) and its `keylos.tlogproof/1`; profile; Secure Boot mode (`owner`/`shim`); PCR 0, 2, 4, 7 (and 14 in shim mode) baseline values + the TCG event log (zstd); TPM `resetCount`/`restartCount`; ledger origin line and latest checkpoint; owner name |
| 2 | P | Verify the EK chain against the bundled vendor CA set (REQ-VOUCH-002). Failure → abort with "TPM certificate not recognised". The owner can override only by typing the EK fingerprint shown on the machine; the pairing is then recorded as `ekUnverified` and every later VERIFIED verdict carries that note |
| 3 | P→M | `Challenge`: two `TPM2_MakeCredential(EK pub, name, secret_i = random 32 B)` outputs, one for AK0 and one for AK |
| 4 | M | `TPM2_ActivateCredential` for each (activate handle = AK0/AK, key handle = EK) → recovered secrets |
| 5 | M→P | `Activation`: recovered secrets |
| 6 | P | Compare; any mismatch → abort |
| 7 | P | Verify the release statement and tlogproof (§4.5.2); record the stream, TUF root, AK0/AK keys, machine key, baseline and `resetCount` |
| 8 | P→M | `PhoneInfo`: phone transport public `P_s`, witness key (Ed25519 public), approval key (P-256 SPKI), phone label, platform, app version, relay preference (none / project relay / custom URL + mailbox ID) |
| 9 | M | `vouchd` stores the phone record in its state as `pending-config` and returns it from `pairWait`; the caller adds it to `vouch.ncl` (config change with presence; the installer includes it in the first config generation) |
| 10 | M→P | `Done`: machine long-term transport public `M_s` (X25519, created now, persisted in `/var/lib/vouchd/`), machine relay mailbox ID |

After pairing, phone↔machine sessions use `Noise_IK_25519_ChaChaPoly_SHA256` with the static keys `P_s` and `M_s`. A phone record becomes **active** (witnessing, approvals) only once the config generation containing it is in effect; `vouchd` reads `vouch.ncl` from `/etc/keylos/vouch.json`.

**TPM details for activation.** AK0 and AK have exactly the protocols §19.6 attributes: `userWithAuth` set, `adminWithPolicy` clear, empty authValue and empty authPolicy. `TPM2_Quote` (USER role) and `TPM2_ActivateCredential` (ADMIN role on the activate handle) are both authorised by the empty authValue; quotes carry the PCR values, so the keys need no PCR policy. The EK is used through `PolicySecret(TPM_RH_ENDORSEMENT)`, which needs the endorsement hierarchy authorization. That authorization is held only by `hearth` (protocols §19.6), so step 4 is always `HearthTpm.activateCredential(akHandle, credentialBlob, encryptedSecret)` on `hearth#tpm` (REQ-VOUCH-002a):
- `vouchd` sends one call per key: `akHandle = 0x81010003` with the AK0 challenge, then `akHandle = 0x81010002` with the AK challenge. `credentialBlob` is the `TPM2B_ID_OBJECT` and `encryptedSecret` the `TPM2B_ENCRYPTED_SECRET` from the phone's `MakeCredential`.
- `hearth` refuses any other handle (`kl:denied`), so the call cannot be used to activate credentials for keys outside the attestation pair.
- **During installation** the installer acts as the machine role and performs the same activation directly while it still holds the endorsement authorization (installer spec §4.10); the result is identical.
- Any activation failure aborts the pairing ("attestation key does not belong to this TPM"); there is no degraded pairing.

#### 4.3.4 Data stored on the phone per machine

| Item | Purpose |
|---|---|
| Machine name, machine key, `M_s` public | Identity, transport |
| EK chain fingerprint and validation result | Pairing provenance |
| AK0 public (and AK public) | VBU and baseline-update quote verification |
| Stream, stream TUF root (with rotation state) | Release statement retrieval and verification |
| Release statements for the current and announced `seq`s, with tlogproofs and verification time | PCR 11/12 predictions |
| Highest `seq` seen; `resetCount` and `restartCount` at last verification | Downgrade and TPM-reset detection |
| PCR 0, 2, 4, 7 (14) baseline + event-log digest | Firmware expectation |
| Pending firmware announcement (vendor, version) | FIRMWARE CHANGED verdicts |
| Last cosigned ledger checkpoint (size, root, counter) | Witness state |
| Conflict evidence | REQ-VOUCH-021 |
| Approval history (IDs, decisions, timestamps) | Owner audit |

Storage: an SQLite database encrypted with AES-256-GCM. The data key is wrapped by a hardware-backed key (Android Keystore StrongBox if available, otherwise TEE; iOS Secure Enclave wrapping via ECIES) with `ThisDeviceOnly` accessibility.

### 4.4 Verify-before-unlock (phone side)

#### 4.4.1 Owner flow

```
Owner                 Phone (vouch)                              Machine (initrd, boot)
  │                       │                                       │ shows QR1 (KLV1 vbu-hello)
  │ "Verify laptop-ada"   │                                       │
  │ scans QR1 ───────────►│ looks up machine by machine-key        │
  │                       │ N = 8 Crockford base32 chars (40 bits) │
  │◄──── shows N ─────────│ (expires in 120 s)                    │
  │ types N on the machine ──────────────────────────────────────►│
  │                       │      qualifyingData = SHA-256("keylos-vbu/1" ‖ N ‖ machine-key)
  │                       │      TPM2_Quote(AK0, sha256 PCRs 0–15, qualifyingData)
  │                       │◄───── QR2 (KLV1 vbu-quote) ────────────│
  │ scans QR2 ───────────►│ six checks (protocols §20.5)           │
  │◄── VERIFIED / FIRMWARE CHANGED / NOT VERIFIED ────────────────│
  │ chooses on the machine: continue to PIN / power off / recovery ►│
```

- `N` uses the Crockford base32 alphabet without `I`, `L`, `O`, `U`, rendered in groups of 4 (`7KQ2-M9XD`); typing is case-insensitive and maps `I`/`L` to `1` and `O` to `0`.
- An attacker who wants to present a pre-computed quote must guess `N` (2⁴⁰ possibilities); each attempt costs a visible failure and the challenge expires after 120 s.
- The phone ignores QR2 payloads whose `qualifyingData` does not match its own `N`.

#### 4.4.2 Decoding

- QR payloads start with the 4-byte magic `KLV1`; rotating sequences start with `KLV1<idx>/<total>` and are reassembled before CBOR decoding.
- CBOR is decoded with deterministic-encoding checks (RFC 8949 §4.2); duplicate keys, indefinite lengths and unknown integer keys below 100 are rejected.
- `TPMS_ATTEST` and `TPMT_SIGNATURE` are parsed with bounds checks; the signature is ECDSA P-256 over SHA-256 of the attest bytes.

#### 4.4.3 Checks and verdicts

| Step (protocols §20.5) | Failure verdict |
|---|---|
| 1. AK0 signature, magic, type, `extraData` | NOT VERIFIED: "Quote not from this machine's TPM" |
| 2. `pcrDigest` over reported PCRs | NOT VERIFIED: "Inconsistent quote" |
| 3. PCR11 = `enter-initrd` prediction for (stream, seq, profile) from a verified statement | NOT VERIFIED: "Not a keylos release" (no statement matches) or NOT VERIFIED (release unknown) when the phone cannot obtain or verify the statement |
| 4. PCR12 = `pcr12`; PCR13 = "no extension" value; PCR15 = zeros | NOT VERIFIED: "Boot command line changed" / "Unexpected extension measured" / "Disk already unlocked (PCR15 not zero)" |
| 5. PCRs 0, 2, 4, 7 (14 in shim mode) = baseline | FIRMWARE CHANGED if a firmware update was announced, else NOT VERIFIED: "Firmware, option ROM or Secure Boot state changed" (with the PCR names) |
| 6. `seq` ≥ highest seen; `resetCount` not increased unexpectedly | NOT VERIFIED: "Older release than seen before" / "TPM was reset since last verification" |

**VERIFIED** text: "This is laptop-ada running keylos 1.4.2 (stable), unmodified. Integrity profile: full." For `shared-boot` the profile line reads "Integrity profile: shared-boot (Microsoft boot keys trusted for dual boot)", and for `shim` "Integrity profile: shim (booted through shim)" (REQ-VOUCH-015). When the pairing is `ekUnverified`, the text adds "(TPM certificate not verified at pairing)". When an owner credential is assisted, the verdict adds "Owner approvals may use an assisted (on-screen) authenticator" (REQ-VOUCH-016).

**Integrity profile source.** At pairing, `MachineInfo` carries the boot report (`/run/keylos/boot/report.json`, protocols §20.1: `secureBoot` = `owner` \| `shim` \| `off`) and the `keepMicrosoftCAs` choice (from the boot report's `secureBoot` and the PCR 7 event log, which lists the `db` certificates). The phone derives the profile from the PCR 7 baseline event log: Microsoft CA certificates present in `db` → `shared-boot`; shim mode (PCR 14 measured) → `shim`; otherwise `full`. A mismatch between the reported and the derived profile aborts pairing.

`resetCount` increases on every TPM reset (a normal reboot is a reset on most platforms), so step 6 compares against the number of boots the machine reported through `vouchd` since the last verification: each running-system session sends the current `resetCount` (§4.6, `Ping`). An increase larger than the reported boots plus one is "unexpected".

**Machine side.** `kl-initrd` offers "Verify with phone" whenever a phone is paired; the profile can make it mandatory, which disables the PIN field until QR2 has been shown. The PIN prompt stays available afterwards because the owner decides.

#### 4.4.4 PCR meanings shown on failure

| PCR | Shown as |
|---|---|
| 0 | Firmware code |
| 2 | Option ROMs / add-in card firmware |
| 4 | Boot loader or UKI image |
| 7 | Secure Boot policy and keys |
| 11 | keylos UKI and boot phase |
| 12 | Kernel command line |
| 13 | Extensions |
| 14 | Shim/MOK state |
| 15 | Disk volume identity |

#### 4.4.5 Expected-value updates

- **OS updates.** When `courier` stages an update it calls `VouchLink.announce("release-staged", {stream, seq, statement, tlogproof})`. `vouchd` pushes it to every paired phone; phones verify and keep both the current and the staged `seq` acceptable. Offline phones fetch the statement from the TUF repository at the next connection.
- **Firmware updates.** `courier` announces `"firmware-pending"` with the vendor and version before a firmware update. The first verification after the update shows FIRMWARE CHANGED. After the owner unlocks, `vouchd` sends a `BaselineUpdate` (§5.2): the new PCR 0–7 values, the event log, and an **AK quote** over PCRs 0–15 with qualifying data `SHA-256("keylos-vouch-baseline/1" ‖ session nonce ‖ machine key)`. The phone verifies the quote with AK and the event-log replay, shows the change, and stores the new baseline only when the owner accepts it.
- **Baseline drift without announcement** (for example a firmware setting change) is red until the owner explicitly accepts a `BaselineUpdate` delivered after unlock with the AK quote; the phone shows the PCR diff and a warning before accepting.
- **Recovery or re-enrolment.** After `rescue reenrol tpm` (installer spec), AK0/AK change only if the TPM was cleared; then the phone shows "TPM identity changed" and requires re-pairing.

#### 4.4.6 TOTP fallback

- Set up with `keylos-enrol vbu-totp` (installer repo), which creates the 20-byte secret, seals it under `PolicyPCR(0,2,4,7,11=enter-initrd)` (protocols §20.5) and stores the sealed blob where `kl-initrd` reads it (boot spec); `vouchd` delivers the secret to the phone inside the Noise session.
- The initrd shows a 6-digit RFC 6238 code (SHA-1, 30 s); the phone shows the expected code.
- **Weaker:** it proves only that the PCR-bound secret unsealed; the phone cannot inspect PCR values, and a screen recording replayed within 30 s defeats it. The UI labels it "Quick check (less thorough)".

### 4.5 Release verification on the phone

#### 4.5.1 TUF client

`vouch-core` runs a minimal TUF client (based on `tough`) for the stream's keylos repository, starting from the root obtained at pairing (`root.json` digest pinned; later roots accepted only through TUF root rotation). It fetches only:
- `timestamp.json`, `snapshot.json`, `targets.json`;
- the targets `logs.json` (log origins and keys) and `rebuilders.json` (`witnesses`, `witnessThreshold`);
- release statements announced by `vouchd`, or the stream head when the owner taps "Check now".

#### 4.5.2 Statement verification

1. DSSE signature by the `release-stream/<stream>` key named in TUF targets metadata.
2. `keylos.tlogproof/1` verification exactly as protocols §20.14: log signature, ≥ `witnessThreshold` distinct witness cosignatures, RFC 6962 inclusion, consistency with the last seen checkpoint when online.
3. `seq`, `stream`, `profiles.<profile>.pcr11["enter-initrd"]` and `pcr12` are stored with the verification time.

A statement verified within the last 30 days counts as verified when the phone is offline (REQ-VOUCH-011).

### 4.6 Witnessing

#### 4.6.1 Ledger checkpoints

- **Push.** `vouchd` calls `LedgerWitness.pending(afterTreeSize = the phone's last cosigned size)` at most every 10 minutes and at shutdown, and sends the result to each paired phone as a `WitnessRequest`: the checkpoint note text and the consistency proof.
- **Phone checks:** note signature with the machine key; origin `keylos-ledger/<machine key>`; tree size ≥ last; consistency proof; `counter` ≥ last.
- **Then** the phone produces a C2SP tlog-cosignature line (Ed25519 witness key, timestamped) and returns it. `vouchd` stores it with `LedgerWitness.addCosignature` and writes `vouch.witness.cosigned` (sampled daily).
- **On failure:** high-priority alert (REQ-VOUCH-021), evidence retention, and `vouchd` writes `vouch.witness.conflict` if the ledger accepts writes.
- **Offline phones** catch up at the next connection using a consistency proof from their last size, so no history is lost.

#### 4.6.2 Release log (opt-in)

The phone fetches release-log checkpoints, verifies consistency with its last seen checkpoint and, if the owner opted in as a public witness, cosigns per C2SP and submits the cosignature to the log's witness endpoint (listed in `logs.json`). Either way it uses the verified checkpoint for its own inclusion checks.

### 4.7 Remote approvals

#### 4.7.1 When the machine asks the phone

`atrium` routes a pending T2/T3 prompt to `vouchd` (`VouchLink.routeApproval`, facet `approvals`) when all of the following hold:
- `requiresPresence = false`;
- `ApprovalPrompt.channels` contains `"phone"`, which the broker sets only when the matching permit's `@channels` includes `phone` and a `vouchd` approver key is registered this boot (protocols §14.3);
- the routing preference in `vouch.ncl` allows it: no human active at the machine (screen locked or idle > 2 min), or the owner chose "also send to phone".

Example owner policy:

```cedar
// Accept phone approvals for agents opening pull requests and sending email.
@tier("t3")
@channels("local,phone")
permit (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { principal.kind == "agent" && ["git.pr.open", "email.send"].contains(resource.kind) };
```

`config` rejects a policy that combines `@channels` including `phone` with `@presence("true")` or with an effect kind whose policy requires presence (protocols §14.3), so such prompts never reach the phone.

#### 4.7.2 Flow

1. `vouchd` checks REQ-VOUCH-033a: every required rendering must fit the phone limits (body ≤ 256 KiB, attachment ≤ 8 MiB transferred in chunks, MIME type in the phone's renderer set `text/plain`, `text/markdown`, `text/x-diff`, `image/png`) and carry a `payloadDigest` of a `mandateDraft` effect. If not, `routeApproval` fails `kl:unsupported` and the prompt is not sent. Otherwise `vouchd` encrypts the `ApprovalPrompt` (all required renderings complete; decorative attachments over 256 KiB dropped with a "preview shown at your computer" note) to each phone over the Noise IK session, directly or through the relay with a push wake-up.
2. The phone shows the prompt (REQ-VOUCH-033), verifies each required rendering's `payloadDigest` against `mandateDraft`, and enables Approve only after every required rendering was displayed (scrolled to its end for long text and diffs); a rendering that fails to render on the phone disables Approve and the phone offers "Decide at your computer" instead. Then the biometric prompt.
3. On approve, the phone builds the mandate from `mandateDraft` with `channel`, `presence` and `decidedBy` set per REQ-VOUCH-031, and signs it as a DSSE envelope with the approval key (`ecdsa-p256-sha256`).
4. The phone returns `ApprovalDecision`; `vouchd` returns `Decision{approved, scope: once, mandate}` from `routeApproval`.
5. `broker` verifies the mandate against the phone approval keys `vouchd` registered this boot (`registerApprover`, REQ-VOUCH-035) and the permit's `@channels`, re-signs it with `service/broker` (protocols §14.4), and records `approval.decide` with `decidedBy` and `mandateDigest`.
6. If the prompt expires first, the result is a denial. The first decision wins, whether made at the machine or on any phone; `vouchd` sends `ApprovalCancel` to the others.

#### 4.7.3 Phone as approver for organisations

If the owner is an organisation approver (`fleet`), the phone can also decide org approval requests. The org registers the phone approval key as an approver key (`admins.json`, `fleet` spec). The flow is the same, but the mandate carries `"channel": "org"` and is returned through `fleet-server` instead of `vouchd`.

### 4.8 Transport

| Path | When | Properties |
|---|---|---|
| Direct LAN | Phone and machine on the same network; machine addresses learned at pairing and refreshed on each session | Noise IK over TCP; `vouchd` listens via a `gate` `listen:` grant on port 47341 (configurable), only on interfaces `net` marks trusted |
| Relay | Different networks; owner enabled relay | `vouch-relay` holds per-mailbox queues of Noise ciphertext; HTTPS long-poll or WebSocket; push wake-ups via APNs/FCM carry only `{"m":"<mailbox id hash>"}` |
| QR only | Unlock time (no network in the initrd) | §4.4 |

**`vouch-relay`:**
- Rust (axum), stateless except for queues (embedded `redb` or Redis), with a 72 h message TTL.
- Mailboxes are created by clients with a random 128-bit ID and an Ed25519 mailbox key. Posts are signed by the sender's mailbox key.
- The relay operator learns which mailbox IDs talk to each other, plus timing. It learns nothing else.
- The project runs `relay.keylos.org`. Owners can self-host.

### 4.9 Backup and phone loss

- **Encrypted backup.** The phone can export a vouch backup containing pairing data, witness state and evidence (not the keys), encrypted with a 24-character backup code shown once. Restoring it on a new phone requires **re-pairing** for keys, which needs a config change with presence on the machine. Witness history is preserved, so rollback detection continues.
- **Lost phone.** On the machine: Settings → Phones → Remove (`VouchLink.remove`, then a config change with presence). Mandates signed by the lost phone are rejected once the new config generation is in effect. Until then, a thief with the unlocked phone and a biometric bypass could approve non-presence actions the policy routes to phones, which is why the default policy routes very few (§10).
- **Multiple phones.** The owner may pair a second phone or a tablet as a backup witness.

### 4.10 Phone UI (normative behaviour)

| Screen | Behaviour |
|---|---|
| Machines | List with last verification result, last witness time, alerts |
| Verify | One tap opens the camera for QR1; the challenge is shown large in groups of 4; the camera reopens automatically for QR2; the verdict is full-screen with colour, icon and text (never colour alone) |
| Approval | Title; principal (agent template name, session, human); each effect as a card (rendered body; diff viewer with syntax highlighting for `text/x-diff`); provenance list with labels (`untrusted` with a warning icon); expiry countdown; buttons "Deny" (primary) and "Approve…" (enabled after scrolling to the end of the first effect, then biometric) |
| Alerts | Witness conflicts with evidence export (share sheet), TPM reset warnings, firmware changes |
| Settings | Relay choice, release-log witness opt-in, TOTP mode, backup, about (versions, vendor CA bundle date) |

Accessibility: every screen supports platform screen readers and dynamic type. Verdicts are announced as text.

### 4.11 Approver-key registration

At start and after every change of the active phone set, `vouchd` calls `BrokerSystem.registerApprover(approvalSpki, "ecdsa-p256-sha256", "phone")` for each active phone (REQ-VOUCH-035). Registrations last for the boot; `vouchd` re-registers after a restart of `broker` (it watches the connection). Removing a phone takes effect for new prompts at the next registration round; the broker drops keys of phones that `vouchd` no longer registers when `vouchd` reconnects.

### 4.12 Inheritance dead-man timer

**Trustees.** A trustee installs the vouch app and chooses "Be a trustee". The owner's phone and the trustee's phone exchange keys by QR (phone to phone): the trustee app shows a QR with its HPKE public key (X25519) and a relay mailbox; the owner's phone records `{name, hpkePublic, mailbox}`.

**Configuration** (`VouchLink.inheritance(configJson)`, facet `settings`, owner shell or Settings with presence-free owner session):

```json
{"enabled": true, "days": 60, "trustees": ["<trustee id>", "…"], "warnDays": [7, 3, 1]}
```

`days ≥ 30` (protocols §20.19). `vouchd` stores the setting and forwards it to every paired phone of that owner; the note itself is written on the phone.

**Note.** On the owner's phone, "Write inheritance note" encrypts the text (≤ 64 KiB, plus optional attachments ≤ 1 MiB total) separately to each trustee's HPKE key (base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, `info = "keylos-inheritance/1"`), and stores the ciphertexts with a `keylos.inheritance/1` metadata record `{schema, owner, machine, trustees, created, days}`. The note never contains a key (REQ-VOUCH-040a).

**Heartbeat.** `vouchd` subscribes with `Ledger.watch` on `ledger#vouch-heartbeat` (filter `eventTypes = ["user.login"]`), keeps the newest login time per owner (owner names from `HearthSystem.owners`), re-reads it with `Ledger.query` on the same facet at start and every 6 hours, and sends the time in `Ping` (REQ-VOUCH-038). The facet returns metadata only (time, subject human), so `vouchd` never sees login methods or any other receipt. The phone's deadline is `max(last heartbeat, last in-app confirmation) + days`.

**Countdown and release.** The phone schedules local notifications at the `warnDays` marks (REQ-VOUCH-039). If the deadline passes with no heartbeat and no confirmation, the phone posts each trustee's ciphertext to the trustee's relay mailbox (or, if the relay is unreachable for 7 days, offers the owner-defined fallback: the platform share sheet to a pre-chosen contact). The trustee app decrypts and shows the note, with the reminder that the recovery key needs *k* trustee cards. Release is recorded on the phone and, at the next machine contact, reported to `vouchd`, which notifies the owner on the trusted path.

**Cancellation and edits** need the owner's biometric on the phone. Losing the phone stops the timer; the owner re-creates it on the new phone.

---

## 5. Interfaces

### 5.1 capwire

`vouchd` implements `VouchLink` (§2.7) on its facets:

| Method | Facet | Semantics |
|---|---|---|
| `phones` | `settings` | Paired phones with status (`pending` = config not yet applied or offline activation pending) |
| `pairStart` | `settings` | Starts a pairing session; returns the `keylos-vouch:1:` QR payload and expiry |
| `pairCode` | `settings` | Offline path commitment (12 words) |
| `pairWait` | `settings` | Completes when the exchange finishes; returns the phone record to add to `vouch.ncl` |
| `remove` | `settings` | Marks the phone removed in `vouchd` state; the caller applies the config change |
| `routeApproval` | `approvals` | §4.7.2; never returns an approval for `requiresPresence = true` (throws `kl:denied`) |
| `announce` | `announce` | Kinds `release-staged`, `firmware-pending`, `baseline-update`; `detailJson` per §5.3 |
| `inheritance` | `settings` | §4.12; stores and forwards the dead-man timer configuration; refuses `days < 30` with `kl:invalid` |

### 5.2 Wire messages

All phone↔machine messages are deterministic CBOR maps inside Noise transport messages. Each has `0: type` and `1: version` keys.

| Type | Name | Direction |
|---|---|---|
| 1 | MachineInfo | M→P |
| 2 | Challenge | P→M |
| 3 | Activation | M→P |
| 4 | PhoneInfo | P→M |
| 5 | Done | M→P |
| 10 | WitnessRequest | M→P |
| 11 | WitnessResponse | P→M (cosignature line, or conflict report) |
| 20 | ApprovalRequest | M→P |
| 21 | ApprovalDecision | P→M |
| 22 | ApprovalCancel | M→P |
| 30 | Announce (`release-staged`, `firmware-pending`, `baseline-update`) | M→P |
| 31 | BaselineUpdate (PCR 0–7, event log, AK quote) | M→P |
| 32 | BaselineDecision (accept / reject) | P→M |
| 40 | Ping/Pong (address refresh, `resetCount`, boot count since last session, last owner login time, integrity profile) | both |
| 50 | InheritanceConfig | M→P |
| 51 | InheritanceReleased (report after a release) | P→M |
| 99 | Error | both |

The CDDL definitions are in `proto/vouch.cddl` and are normative. Unknown keys ≥ 100 MUST be ignored; unknown types MUST be answered with type 99.

### 5.3 `announce` detail payloads

| Kind | `detailJson` |
|---|---|
| `release-staged` | `{"stream", "seq", "statement": "<base64 DSSE>", "tlogproof": {…}}` |
| `firmware-pending` | `{"vendor", "component", "fromVersion", "toVersion", "lvfsId"}` |
| `baseline-update` | `{"reason": "firmware-applied" \| "manual"}` (the data itself follows as `BaselineUpdate` after unlock) |

### 5.4 QR formats

| Prefix | Content | Owner of the format |
|---|---|---|
| `keylos-vouch:1:` (and `keylos-vouch:1:<idx>/<total>:` frames) | Pairing QR and offline `MachineInfo` | this repository (`vouch-proto`) |
| `KLV1`, `KLV1<idx>/<total>` | VBU QR1/QR2 | protocols §20.5 |

### 5.5 CLI (machine)

```
vouch phones                  list paired phones
vouch pair                    show the pairing QR in the terminal, wait, then propose the config change
vouch pair --code             enter the 12-word commitment (offline path)
vouch remove <id>             remove a phone (config change with presence)
vouch test-approval           send a no-op T2 prompt to phones (setup check)

Exit codes: 0 ok; 1 error; 2 usage; 3 timeout; 4 verification failed; 5 no phone paired.
```

---

## 6. Security

### 6.1 Phone threat model

| Threat | Effect | Mitigation |
|---|---|---|
| Phone stolen, locked | None | Keys need biometric/device credential |
| Phone stolen and unlocked | Thief can approve phone-routed non-presence actions while prompts arrive; can see rendered prompts | Few kinds routed to phones by default (§10); prompts expire; owner removes the phone (presence); presence-class actions unaffected |
| Phone malware | Could show a false VERIFIED; could approve phone-routed actions; could leak prompt contents | VBU is an additional check (the disk still needs the TPM policy and the PIN); presence-class actions unaffected; prompt content minimised |
| Compromised relay | Traffic analysis | E2E Noise; no content in push |
| Evil maid with a lookalike machine relaying to the stolen original ("cuckoo") | A real quote is relayed; the owner types the PIN into the lookalike | Residual risk; partly mitigated because `kl-initrd` shows the owner's unlock picture sealed under the boot policy, which a lookalike cannot show without the real TPM (a relay with a camera can) |
| Screen recording of an old QR2 | Wrong `qualifyingData` | Fresh phone challenge per verification |
| Fake TPM (software TPM) | Fails EK chain validation at pairing | Vendor CA bundle; `ekUnverified` label when overridden |
| Old vulnerable release booted (downgrade) | PCR11 matches an old genuine statement | Step 6 (`seq` ≥ highest seen); the NV floor also prevents unseal |
| Microsoft CAs added to `db` silently (downgrade to a dual-boot trust set) | Bitpixie-class attacks become possible | PCR 7 changes → FIRMWARE CHANGED/NOT VERIFIED; the verdict names the new integrity profile `shared-boot` |
| Inheritance note released early by a thief with the unlocked phone | Trustees receive the note | The note holds no key; trustees still need *k* cards; release is reported to the owner |
| Trustee impersonation at enrolment | Note encrypted to the attacker | Phone-to-phone QR exchange in person; trustee fingerprint shown on both phones |
| Forged phone approval key registration | A rogue process registers an approver key | Only `vouchd` holds the `broker#system` route for `registerApprover` with channel `phone`; keys come from the presence-signed `vouch.ncl` config |

### 6.2 `vouchd` confinement

`vouchd` is a tier-0 service with:
- `gate#client` with a `listen:` grant for the vouch port on trusted interfaces and a connect grant for the configured relay host;
- `ledger#witness`, and `ledger#vouch-heartbeat` (metadata of `user.login` only);
- `broker#system`, used only for `registerApprover`;
- `hearth#system` (`owners` only) and `hearth#tpm` (`activateCredential` only, which `hearth` limits to the AK and AK0 handles);
- `/dev/tpmrm0` through the `dev:tpmrm:tpmrm0` device grant. Its sessions can use only AK, AK0 and the EK for `ActivateCredential` and AK quotes; it cannot satisfy the disk token, owner-seal, KEK/db or vault object policies (they need the PIN, seal gates or other services' sealed values);
- read access to `/sys/kernel/security/tpm0/binary_bios_measurements` (Landlock read rule);
- seccomp `baseline-1` plus `ioctl` on the granted `tpmrm0` fd;
- Landlock: `/var/lib/vouchd` read/write, `/etc/keylos/vouch.json` read.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| Phone lost | Remove on the machine; pair a new phone; restore the backup for witness history |
| Machine TPM cleared | AK0 changes → NOT VERIFIED "TPM identity changed"; re-pair after recovery |
| Release log or TUF unreachable for 30 days | NOT VERIFIED (release unknown); reconnect to restore VERIFIED |
| Relay down | Direct LAN still works; approvals at the machine |
| Phone clock wrong | Verdicts do not depend on phone time except challenge expiry (phone-local monotonic clock), cache age and prompt expiry display; when online the phone uses the TUF timestamp time |
| Unlock picture not shown | The owner should treat the machine as suspicious; the phone's verdict is still shown |

---

## 8. Performance budgets

| Metric | Budget |
|---|---|
| QR2 decode + verdict | ≤ 1 s on a 2021 mid-range phone (release cached) |
| Release statement + tlogproof verification (online) | ≤ 3 s |
| Witness cosign round trip (LAN) | ≤ 500 ms |
| Approval delivery via relay (phone online) | ≤ 3 s p95 |
| App cold start | ≤ 1.5 s |
| Battery: background witnessing and approvals | ≤ 1 % per day |

---

## 9. Observability

**Machine-side receipts** written by `vouchd` through `ledger` (protocols §19.3):
- `vouch.pair`, `vouch.remove`;
- `vouch.witness.cosigned` (sampled daily), `vouch.witness.conflict`;
- `approval.decide` is written by `broker` with `decidedBy` = the phone key.
- Inheritance releases are reported by the phone and appear as an atrium notification; they are not receipts (no registered event).

**Machine-side metrics** (journal metrics records): `vouch_sessions_total{path}`, `vouch_witness_total{result}`, `vouch_approvals_total{decision}`.

**Phone-side:** a local log of verifications, approvals and alerts (exportable); no telemetry.

---

## 10. Configuration

```nickel
# vouch.ncl (machine side, part of the config generation; rendered to /etc/keylos/vouch.json)
{
  Vouch = {
    phones | Array {
      id | String,
      label | String,
      transport_key | String,     # X25519 public, base64
      witness_key | String,       # key:sha256:… (Ed25519)
      approval_key | String,      # key:sha256:… (P-256)
      approval_spki | String,     # base64 DER
      relay_mailbox | String | optional,
      ek_unverified | Bool | default = false,
    } | default = [],
    verify_before_unlock | [| 'offered, 'mandatory, 'off |] | default = 'offered,
    totp_mode | Bool | default = false,
    listen_port | Number | default = 47341,
    relay | [| 'none, 'project, 'custom |] | default = 'none,
    relay_url | String | optional,
    phone_approvals | {
      enabled | Bool | default = true,             # false: vouchd registers no approver keys
      route_when | [| 'idle_or_locked, 'always |] | default = 'idle_or_locked,
    },
    inheritance_allowed | Bool | default = true,   # owners may enable the dead-man timer (§4.12)
  },
}
```

Phone approvals are authorised by policy (`@channels`), not by this module. The default owner policy shipped by the `keylos` distribution allows the `phone` channel only for `git.pr.open`, `calendar.create`, `file.share` and `fs.merge` initiated by agents.

---

## 11. Testing and acceptance criteria

**Unit tests:**
- CBOR and QR codecs, including `KLV1` rotating sequences and deterministic-encoding rejection;
- Noise handshakes (XXpsk3, IK) against the cacophony test vectors;
- VBU verification against protocols `vectors/vbu/` (good, bad nonce, PCR mismatch per step, AK0 mismatch, stale `seq`, unexpected `resetCount`);
- composite PCR digest computation;
- release statement and tlogproof verification against protocols `vectors/release/` and `vectors/tlogproof/`;
- C2SP checkpoint and cosignature verification against `tlog` vectors, including counter regression;
- mandate construction: `channel = phone`, `presence = false`, digests copied from `mandateDraft`;
- `MakeCredential`/`ActivateCredential` round trip for AK0 and AK (swtpm) with the §4.3.3 TPM attributes.

**Integration** (machine VM with swtpm + emulator phones):
1. Pairing over LAN and over the offline 12-word path (with deferred activation).
2. VBU VERIFIED on a clean boot; NOT VERIFIED after replacing the UKI with a different signed UKI of an older `seq`; FIRMWARE CHANGED after a simulated firmware update with an announcement, then baseline accepted after unlock with an AK quote.
3. Ledger rollback: restore the VM disk to an older state → the phone detects a size/counter regression.
4. Approval: an agent requests `git.pr.open` while the machine is locked → the phone approves → `gate` commits; a `config.apply` prompt is never routed to the phone, and `routeApproval` with `requiresPresence = true` throws.
4a. Required rendering on the phone (protocols E33): an `fs.merge` prompt whose required diff exceeds the phone limit, a prompt with an unsupported required MIME type, and one with a missing attachment are never sent (`routeApproval` → `kl:unsupported`) and remain approvable only at the computer; a phone whose renderer crashes on a required rendering cannot approve; a decorative preview over the limit is dropped and the prompt is still approvable. No case produces a phone mandate for a prompt whose required material was not shown.
5. Relay path with a self-hosted relay; the relay database contains no plaintext.
6. Approver registration: with a paired phone the broker sees one `phone` approver after boot; with `phone_approvals.enabled = false` none; a prompt whose permit lacks `@channels(…phone…)` is never routed.
7. Integrity profiles: a machine installed with `keepMicrosoftCAs` verifies as "shared-boot"; toggling the Microsoft CAs into `db` on a `full` machine yields NOT VERIFIED (PCR 7) until a baseline update is accepted, after which the verdict names `shared-boot`.
8. Assisted credentials: after an owner enrols an assisted credential, the phone's machine page and verdicts show the note.
9. Inheritance: with `days = 30` (time-accelerated test clock), warnings at 7, 3, 1 days; an owner login cancels; without logins the trustee app receives and decrypts the note; `days = 29` is refused.
10. Later pairing from Settings: `vouchd` activates AK0 and AK through `HearthTpm.activateCredential`; the phone's secrets match and the pairing completes. A call with any other handle is refused by `hearth`; a substituted AK (simulated by swapping the reported AK name) aborts the pairing at step 6.
11. Heartbeat facet: `vouchd` on `ledger#vouch-heartbeat` receives `user.login` time and subject only; a `Ledger.query` for any other event type, or a request for a payload field, returns nothing; `vouchd` has no `ledger#reader` route.

**Fuzz:** CBOR message decoder, QR payload decoders (pairing and VBU), `TPMS_ATTEST` parser.

**Acceptance:** OS conformance tests C-13 `evil-maid` and C-16 `state-rollback` (`keylos` spec §11.2) pass with vouch on Android and iOS reference phones.

---

## 12. Implementation notes

**Crates (`vouch-core`, `vouchd`):**
- `snow` 0.9 (Noise)
- `ciborium` 0.2
- `p256` 0.13, `ed25519-dalek` 2, `x25519-dalek` 2, `sha2` 0.10, `hkdf` 0.12
- `x509-cert` 0.2 (EK chains)
- `tss-esapi` 7 with `keylos-tpm-registry` (machine side only)
- `tough` (TUF client)
- `rusqlite` 0.31 with an encryption layer
- `uniffi` 0.28
- `qrcode` 0.14 (machine side)
- `bip39` 2
- `keylos-formats`, `keylos-ids`, `keylos-capwire`, `keylos-schemas`; `tlog` client crate

**Android:** Kotlin 2.x, Jetpack Compose, CameraX + ML Kit barcode; Android Keystore with `setIsStrongBoxBacked(true)` where available; BiometricPrompt `BIOMETRIC_STRONG or DEVICE_CREDENTIAL`; minimum SDK 29.

**iOS:** Swift 6, SwiftUI, AVFoundation; Secure Enclave P-256 (`SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave`), LocalAuthentication; minimum iOS 16.

**Repository layout:**

```
vouch/
  core/ (vouch-core)   proto/ (vouch-proto, vouch.cddl)   vouchd/   cli/   relay/ (vouch-relay)
  android/   ios/   data/tpm-vendor-cas/   tests/
```

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reference |
|---|---|---|
| Phone-generated typed challenge + full AK0 quote (protocols §20.5) | TOTP only | [ADR-0015](../../handbook/11-decisions/adr-0015-verify-before-unlock.md); TOTP kept as a labelled fallback |
| QR from machine to phone; characters from phone to machine | Bluetooth or NFC in the initrd | No radio stack in the initrd (attack surface, driver variety) |
| Phone never provides presence | Phone passkey as a presence factor | [ADR-0011](../../handbook/11-decisions/adr-0011-owner-presence-fido2.md); protocols §14.3 |
| Phone approvals authorised by `@channels` in policy | A config allowlist read by `broker` | protocols §16.2 annotations; one authorisation mechanism |
| Phone is an optional ledger witness | Cloud witness only | [ADR-0031](../../handbook/11-decisions/adr-0031-receipts-ledger.md) |
| Baseline updates accepted only with an AK quote after unlock | Trust the machine's report | A compromised running system cannot silently move the baseline |
| Relay is optional and E2E | Mandatory vendor cloud | Privacy, self-hostability |
| Phone approver keys registered with the broker each boot; mandates re-signed by the broker | Relying services verifying phone keys | One verification point (protocols §14.4) |
| Prompts whose required renderings do not fit the phone are not offered on it (protocols E33, ISSUES ISS-006) | Truncating attachments with a "view at your computer" note | A truncation notice does not show the content being approved |
| Inheritance note on the phone, never a key | Escrowing the recovery key with trustees through vouch | Trustee cards remain the only path to the key (protocols §20.19) |

### 13.1 Contract dependencies

Every cross-repository contract this repository uses is in protocols 1.0: credential activation (`HearthTpm.activateCredential`, §7.5.3), the owner list (`hearth#system`, §19.2), the heartbeat facet (`ledger#vouch-heartbeat`, §7.3.5) and approver registration (`BrokerSystem.registerApprover`, §7.5.2), and the required/decorative rendering contract (`RenderedEffect.review`, `payloadDigest`, §7.3.4, E33). There are no open dependencies.
