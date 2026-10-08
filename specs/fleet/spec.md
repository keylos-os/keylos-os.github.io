# keylos/fleet: organisation management

| | |
|---|---|
| Repository | `github.com/keylos-os/fleet` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `fleetd` (on-device agent; service name `fleet`, tier 0), `fleet` (on-device CLI for the owner's shell), `fleet-server` (organisation server), `fleet-ctl` (administrator CLI, runs on any OS), `fleet-approve` (approver app for keylos desktops), Nickel schema module `fleet.ncl`, org TUF repository tooling, org policy lint (`fleet-lint`) |
| Depends on | `keylos-protocols 1.0` (crates `keylos-ids`, `keylos-formats`, `keylos-presence`, `keylos-capwire`, `keylos-schemas`, `keylos-tpm-registry`); `tlog` 1.0 client library; on the device, the 1.0 interfaces of `ledger`, `config`, `broker`, `courier`, `gate`, `hearth`, `warden`; on the server, PostgreSQL ≥ 15 (or SQLite ≥ 3.45 for ≤ 500 devices) and an OCI registry for org generations |
| Provides | `FleetCompliance`, `OrgDecider` and `FleetCluster` (protocols §7.5.21); org policy and config contracts distributed through an org TUF repository, including the `org-publishers` role; attestation and compliance (TPM quotes, confidential-VM reports); attested Kubernetes node join and kubelet certificates; ledger checkpoint witnessing; inventory; organisation approvals; relay of quorum presence signatures from org admins; recovery-key escrow; cloud seed signing; remote lock and wipe for org-owned devices |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

Fleet lets an organisation manage keylos machines without breaking keylos's model. The device enforces everything locally; the organisation can only add constraints, and it gets verifiable evidence in return.

Two ownership modes:

| Mode | Owners in the owner registry | Local human | Typical use |
|---|---|---|---|
| **BYOD** (`member`) | The person | The person (owner) | Personal laptops used for work |
| **Org-owned** (`managed`) | Org administrators, enrolled at install (`installer` `fleet_delegated`, or a later owner transfer) | A non-owner human | Company laptops, appliances, servers |

Fleet provides:
1. **Org policy generations**: Cedar `forbid`s, tier escalations and `@orgApproval` annotations, plus Nickel config contracts, distributed as signed generations through an org TUF repository.
2. **Attestation**: TPM quotes checked against release-log predictions, giving a per-device compliance state.
3. **Checkpoint witnessing**: the server cosigns the device's ledger checkpoints to detect rollback and split views. It never sees receipt contents.
4. **Inventory**: hardware, OS generation, profile, integrity profile, update state. App inventory is opt-in for BYOD.
5. **Organisation approvals**: org-designated approvers decide `@orgApproval` permits (protocols §16.2) through `OrgDecider`.
6. **Compliance tokens** for org services, injected by `gate`.
7. **Recovery-key escrow**: for managed devices, optional for BYOD.
8. **Remote lock and crypto-wipe**: managed devices only, and only with an admin quorum.
9. **Quorum presence relay**: on managed (quorum) machines, org admins are the owners; fleet carries `keylos.quorum/1` requests to them and their signatures back (protocols §5.4).
10. **Cluster node attestation**: `server-k8s` nodes join a Kubernetes cluster only after an attested quote (`FleetCluster`, protocols §21.7).
11. **Org publishers and cloud seeds**: the `org-publishers` TUF role for org apps and `container` generations, and signing keys for cloud first-boot seeds.

### 1.1 Non-goals

- Remote shell, screen viewing, file access or receipt-content access. Fleet cannot read user data in either mode. The only exception: a managed-mode policy MAY require exports of specific receipt event types to an org audit sink, and the device then shows this permanently (§4.9.3).
- Pushing arbitrary code. Org apps are ordinary app generations that pass the same `depot` checks, including the rebuilder quorum named in the org's app-release statements.
- Weakening any keylos default. An org can only forbid, raise tiers, add required approvals and add config contracts.
- Identity federation (LDAP, Kerberos, OIDC logins). Local humans remain `hearth` users; org SSO is reached through compliance tokens.

---

## 2. Context and embedded contracts

Every shared contract below is copied **verbatim** from `keylos-protocols 1.0`; if a copy differs, protocols wins.

### 2.1 Trust roots (protocols §5.2)

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

### 2.2 Presence signatures and quorum presence (protocols §5.3, §5.4)

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

Headless profiles (`server`, `server-k8s`, `cloud`, `appliance`) and managed machines use **quorum presence** instead of a local touch. The owner registry (§20.3) then has `policy.mode = "quorum"` and `policy.threshold = N`, with M approver credentials (the owners' FIDO2 credentials, enrolled like any owner credential).

- A **quorum presence envelope** is an ordinary DSSE envelope over the same payload with **≥ N signatures** (§5.3 construction) from credentials of **distinct owners**. Verifiers MUST count distinct owners, not signatures.
- Collection: `hearth` creates a quorum request (`keylos.quorum/1`, §20.18) through `HearthQuorum.request` (§7.5.3); approvers receive it through `fleet` (or out of band as a file), review the rendered payload on their own keylos machine, and sign it there with `hearth presence --remote <request>` (their machine's `hearth` signs with their own credential and rpId `keylos.owner`); signatures return through `HearthQuorum.submit`. The request expires after at most 24 h.
- Every purpose of §20.2 accepts a quorum envelope on quorum machines. On `desktop`/`laptop` profiles quorum envelopes are accepted only for owner-registry changes that the registry policy marks `quorum`.
- **Seal gate on quorum machines.** No touch reaches the machine, so the seal gate's authValue for the window is released differently: `hearth` holds the next gate authValue in a TPM-sealed blob bound to the signed PCR11 `ready` phase and PCR15, and unseals it only after verifying a quorum envelope of purpose `seal.window`. This reduces the guarantee from "a physical touch" to "N approvers signed and the machine runs a verified `hearth`"; the reduction is shown in `status` (`sealing: quorum`).

### 2.2a Profiles and integrity profiles (protocols §2.2)

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

### 2.3 Trusted-path prompt types (protocols §7.3.4)

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

### 2.4 Ledger interface (protocols §7.3.5)

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

### 2.5 Ledger system interfaces (protocols §7.5.5)

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

### 2.5a Hearth system interfaces used by fleet (protocols §7.5.3)

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

### 2.6 Config fleet interface (protocols §7.5.14)

```capnp
@0xc7a1e5d3b2f4002d;
using C = import "common.capnp";

interface ConfigFleet {            # facet fleet
  installFleetModule @0 (gen :C.Ref) -> ();   #! effective only after an owner-signed config apply accepts the enrolment
  removeFleetModule  @1 () -> ();
  applyRemote        @2 (statement :Data, approverEnvelopes :List(Data)) -> (generation :C.Ref);
      #! managed machines: statement is keylos.configgen/1; approverEnvelopes carry presence signatures of org admins who are
      #! owners of this machine; config merges them into one quorum envelope (§5.4) and applies like Plan.apply
}
```

### 2.7 Fleet system interfaces, implemented here (protocols §7.5.21)

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

### 2.8 Approval tiers (protocols §14.3)

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

### 2.9 Mandates (protocols §14.4)

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

### 2.10 Cedar policy schema (protocols §16)

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

### 2.11 Checkpoints (protocols §13.3)

- `ledger` emits a **C2SP signed-note checkpoint** (origin `keylos-ledger/<machine key>`) at least every 60 s while there is activity, and on shutdown.
- The TPM NV counter `0x01300100` (§19.6) is incremented at most once per 900 s while there is activity, at shutdown, and immediately after security-class events (`grant.revoke`, `config.apply`, `gen.seal`, `update.commit`, `key.enroll`, `key.remove`, `ledger.alarm`). Every checkpoint note carries the extension line `counter <n>` with the current counter value, binding the tree size and root hash in the signed note to the counter. A ledger whose newest checkpoint counter is below the NV value has been rolled back.
- Checkpoints MAY be submitted to owner-configured witnesses (`LedgerWitness`, §7.5.5: the `vouch` phone, a fleet witness).
- `ledger.key.register` receipts are never sealed; their `data` is `{"service": "<name>", "spki": "<base64 DER>", "keyRef": "key:sha256:…"}`. `Ledger.serviceKey` (§7.3.5) answers from them.

### 2.12 Transparency logs (protocols §11.5)

keylos operates two logs, both following **C2SP tlog-tiles** with checkpoints per **C2SP tlog-checkpoint** and witness cosignatures per **C2SP tlog-cosignature**:

| Log | Origin line | Entries |
|---|---|---|
| Realisation log | `log.keylos.org/realisations` | DSSE realisation attestations (§11.4) |
| Release log | `log.keylos.org/releases` | DSSE release statements (`keylos.release/1`, §20.6) and cloud image records (`keylos.cloudimage/1`, §20.24), signed by `release-stream/<stream>` |

Clients MUST verify inclusion against a checkpoint cosigned by at least `witnessThreshold` (default **2**) witnesses from the witness list in TUF targets metadata (`rebuilders.json`: `witnesses`, `witnessThreshold`). A generation is installable from a distro or publisher channel only if its realisation log entries reach the rebuilder quorum named in its release or app-release statement.

### 2.13 Release statement (protocols §20.6)

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

### 2.14 Transparency-log proof bundle (protocols §20.14)

```json
{"schema":"keylos.tlogproof/1",
 "origin":"log.keylos.org/realisations",
 "index":123456,
 "entry":"<base64 of entry bytes>",
 "checkpoint":"<full signed note text including cosignature lines>",
 "inclusion":["<base64 hash>"]}
```

Verification: verify the log signature on the checkpoint with the origin's key (TUF `logs.json`); verify ≥ `witnessThreshold` cosignatures from distinct listed witnesses; compute the RFC 6962 leaf hash of `entry` and verify inclusion at `index`; update the persisted last-seen checkpoint (consistency-checked) when online.

### 2.15 Revocation list, publishers and catalog (protocols §11.7, §11.8, §20.20)

```json
{"schema":"keylos.revocations/1","stream":"stable","serial":1234,"issued":"…",
 "objects":[{"ref":"obj:fsv256:…","reason":"CVE-2026-XXXX","action":"evict"}],
 "generations":[{"ref":"gen:fsv256:…","reason":"…","action":"unlaunchable"}],
 "keys":[{"ref":"key:sha256:…","reason":"compromised","after":"…"}]}
```

- Distributed as a TUF target by `courier` and logged (its digest) in the release statement.
- Actions: `unlaunchable`, `evict`, `warn`.
- A `keys[]` entry for a `publisher/<id>` or `org-publisher/…` key makes every generation whose only authorising signature is by that key `unlaunchable` from `after` onwards; generations signed before `after` stay launchable only if their realisations reach the rebuilder quorum.

- **Onboarding.** A publisher is added to the TUF `publishers` delegated role (signed by `distro-root` delegation keys) with either an Ed25519 key held in hardware or a Sigstore identity (OIDC issuer + subject) and an accepted publisher policy version. Org publishers are delegated from a fleet's TUF repository (`org-publishers` role) and are trusted only on machines enrolled in that fleet.
- **Enabling.** A machine trusts a publisher only after the owner enables it in config (`/etc/keylos/publishers.json`, §20.20); it then enters the boot trust set at the next boot.
- **Catalog.** `keylos.catalog/1` (§20.20) is a TUF target signed by the `catalog` role. A listing is `reviewed-reproducible` only if its generations' realisations reach the rebuilder quorum and the catalog review passed; otherwise it is `unreviewed`. Installing an `unreviewed` app sets its effective tier floor to 2 unless the owner records an exception (`keylos.exception/1`, kind `reproducibility`).

`/etc/keylos/publishers.json` (`keylos.publishers/1`, rendered by `config`): `{"schema", "publishers": [{"id": "…", "keys": ["key:sha256:…"], "sigstore": [{"issuer": "…", "subject": "…"}], "spki": {"key:sha256:…": "<base64 DER>"}, "scope": "distro" | "org:<org>"}]}`.

`keylos.catalog/1` (TUF target signed by the `catalog` role):

```json
{"schema":"keylos.catalog/1","issued":"…","expires":"…",
 "entries":[{"name":"org.example.Editor","publisher":"example","summary":"…","categories":["development"],
             "latest":{"version":"2.5.0","generation":"gen:fsv256:…","statement":"sha256:<genstmt envelope digest>"},
             "review":"reviewed-reproducible" | "unreviewed","quorum":"3/3","capabilities":"sha256:<JCS digest>",
             "icons":["https://…"],"homepage":"https://…"}]}
```

### 2.15a Receipt privacy and owner exceptions (protocols §13.4, §20.9)

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

Presence-signed (purpose `exception`):

```json
{"schema":"keylos.exception/1","kind":"reproducibility","name":"org.example.Tool","publisher":"key:sha256:…",
 "generation":null,"reason":"vendor binary","scope":"machine","decidedBy":"alice","time":"…","expires":null}
```

`kind`:
- `reproducibility`: allows effective tier 1 for a non-reproducible or `unreviewed` generation. `generation` null matches all generations of `name` from `publisher`.
- `fleet-receipt-access`: `{"events": ["<event type>", …]}` in an extra field `events`; lets `fleet` read sealed payloads of those events (§13.4). `name`/`publisher` are null.

Exceptions are written by `config` to `/etc/keylos/exceptions/` (§10.7); `depot` and `ledger` read them from the booted config generation.

### 2.15b Quorum requests (protocols §20.18)

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

### 2.15c First-boot bundle and cloud seed (protocols §20.13)

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

### 2.15d Operating rules: remote lock and wipe (protocols §14.5)

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.

### 2.15d1 Fleet commands and org approvers (protocols §20.23)

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

### 2.15d2 Cloud image records (protocols §20.24)

DSSE-signed by `release-stream/<stream>`, published as TUF targets `cloud/<provider>/<region>/<seq>.json` and logged in the release log next to the release statement:

```json
{"schema":"keylos.cloudimage/1","stream":"stable","seq":4211,"provider":"aws","region":"eu-central-1",
 "imageId":"ami-…","arch":"x86_64","osGen":"gen:fsv256:…","ukiSha256":"…","published":"…"}
```

`fleet` uses these records to check that a cloud node booted a published image before attesting it.

### 2.15e Cluster nodes (protocols §21)

- The `server-k8s` profile runs upstream `kubelet` and `kube-proxy` (sealed generations built by `forge`, packaged in `pkgs`) and the keylos `cri` service.
- `kubelet` reaches `cri` only through the route `cri#kubelet`: `warden` creates an `AF_UNIX` `SOCK_STREAM` socket pair and passes `kubelet` its end as `--container-runtime-endpoint=unix:///run/keylos/cri/cri.sock` (a path inside kubelet's view bound to that socket). This is the only non-capwire IPC in keylos (§7.1).
- `cri` implements CRI v1 (`runtime.v1.RuntimeService`, `runtime.v1.ImageService`) for the three most recent Kubernetes minor versions at release time.
- `kubelet` runs as a tier-1 service without root and without capabilities, in the cri network namespace (`services.json` `network: "cluster"`). It holds: the `cri#kubelet` route; the cgroup subtree `/keylos.slice/kube.slice` (delegated to `cri`, read-only to kubelet for stats); its state directory `/var/lib/keylos/cri/kubelet` (written by `cri`: certificates, kubeconfig). Volume mounts, networking and image handling are done by `cri`, never by kubelet.
- **Mount-free kubelet.** `pkgs` builds kubelet with the `keylos-mountless` patch set, which is part of this contract: kubelet never calls `mount`/`umount` (they are denied by seccomp anyway). Its volume plugins write configMap, secret, projected and downwardAPI contents into plain directories under `/var/lib/keylos/cri/kubelet/pods/<uid>/volumes/`, and every mount, unmount, and device-attach step is a no-op; `cri` turns those directories into `PodMount` trees (`tmpfsBytes > 0` for secret-bearing types, §7.5.1) or VM shares, and handles emptyDir, local, NFS/iSCSI/RBD and CSI volumes itself (§21.6).
- `kube-proxy` runs in nftables mode inside the `cri` network namespace with `CAP_NET_ADMIN` there only.

- Before kubelet starts, `cri` performs `FleetCluster.joinAttested` with an AK quote (and a confidential-VM report on `cvm`); `fleet` verifies it against the release log. Only then does `cri` obtain kubelet client certificates (`FleetCluster.kubeletCertificate`) and write the kubelet kubeconfig.
- Certificates are renewed by `cri` before expiry; a failed re-attestation (for example after an unapproved firmware change) stops renewal and the node drops out of the cluster when its certificate expires.

### 2.16 Owner registry (protocols §20.3)

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

### 2.17 Generation kinds (protocols §6.1)

| Kind | Content | Mounted by |
|---|---|---|
| `os` | Base OS tree (`/usr`, plus the initial `/` skeleton) | `boot` (initrd) |
| `runtime` | Shared library/runtime tree used by apps | `warden` (in app views) |
| `app` | A desktop or CLI application | `warden` |
| `service` | A system service | `warden` |
| `agent-template` | Harness, tool definitions, prompt and policy for an agent (§6.4) | `aide` → `bench` |
| `bench-image` | Guest OS image for workbenches and tier-2 VMs | `bench` |
| `legacy-image` | Imported foreign rootfs (OCI, Flatpak, distro); format in the `compat` spec (`keylos.compat/1`) | `compat` → `bench`/`warden` |
| `config` | Rendered configuration tree (a confext) | `boot` |
| `policy` | Cedar policy set + Biscuit authorizer templates | `broker` |
| `data` | A static data set (fonts, models, datasets) | `warden` (read-only bind) |
| `part` | A build intermediate (a derivation output that is not itself launchable: libraries, headers, toolchain parts) | `forge`, `bench` (store mounts) |
| `container` | An OCI container image converted deterministically into a generation, signed by an org publisher (§21); runnable only by `cri` in the `keylos-sealed` runtime class | `warden` (for `cri`) |
| `kmod` | Out-of-tree kernel modules built by the project for one exact kernel release (`/lib/modules/<uname>/extra/*.ko`, each module signed with the release stream's module-signing key) | `boot`, `warden` (module path only) |

### 2.18 Facets (protocols §19.2, rows that fleet serves or uses)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| ledger | `witness` | vouch, fleet | `LedgerWitness` |
| ledger | `fleet-export` | fleet | `LedgerAdmin.export` (metadata only unless an owner `fleet-receipt-access` exception covers the event type) |
| hearth | `tpm` | courier, vault, strata, ledger, config, vouch, fleet | `HearthTpm` (`defineSpace`, `recreateKey`: the object's registered owner; `sbSign`, `sbAccepted`: courier; `activateCredential`: vouch, fleet) |
| hearth | `quorum` | fleet | `HearthQuorum.submit`, `list` |
| hearth | `fleet-lock` | fleet | `HearthFleet` |
| gate | `client` | principals with net needs, portal-files, atrium (staging `media.export`) | `connect`, `stage` (own session), `intents` (own session tree, recursive), `intent` (own session tree), `meter` (own roots); `DurableEffects.prepare`, `complete`, `lookup`, `watch` (attempt sessions, own workflow) |
| config | `fleet` | fleet | `ConfigFleet`, `current`, `drift` |
| journal | `fleet` | fleet | `Metrics` (aggregate, no user data) |
| fleet | `client` | owner `shell`, atrium | `FleetCompliance.status` |
| fleet | `gate` | gate | `FleetCompliance.complianceToken` |
| fleet | `decider` | broker | `OrgDecider` |
| fleet | `cluster` | cri | `FleetCluster` (`joinChallenge`, `joinAttested`, `clusterCertificate`, `kubeletCertificate`) |
| cri | `status` | fleet, atrium | `CriAdmin.pods`, `node`, `images` |

### 2.19 Receipt events (protocols §19.3, fleet row)

| Event | Writer |
|---|---|
| `fleet.enrol`, `fleet.unenrol`, `fleet.policy.apply`, `fleet.command`, `fleet.attest` | fleet |
| `pod.admit`, `pod.deny`, `pod.start`, `pod.stop` | cri |

**Extension rule.** A repository MAY emit additional events named `x-<repo>.<event>` (for example `x-strata.replica.send`). They MUST be listed in that repository's spec, MUST be written only by that repository's services, and carry no semantics for other components. Events named without a prefix MUST appear in this table.

### 2.20 TPM objects (protocols §19.6)

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

### 2.21 Time (protocols §3.6)

- On the wire: `Timestamp { unixNanos :Int64 }` in UTC.
- In documents: RFC 3339 with `Z` and at most nanosecond precision.
- The system clock MUST be disciplined by NTS-authenticated time (owned by the `net` repo).
- Components that check expiry (tokens, TUF, certificates) MUST treat the clock as **untrusted until the first NTS sync after boot**. Until then they use the **time floor**: the time of the newest ledger checkpoint (`LedgerAdmin.timeFloor`, §7.5.5). `net` steps the clock forward to the time floor at boot if the RTC is earlier. The RTC is never trusted to move time backwards past the floor.

---

## 3. Requirements

### 3.1 Enrolment

- **REQ-FLEET-001** Enrolment MUST bind a device key (`0x81000120`, protocols §19.6) attested through EK → AK (`0x81010002`) → `TPM2_Certify` of the device key to an org device record. The server MUST validate the EK certificate chain against the TPM vendor CA bundle shipped with `fleet-server`, and MUST run `MakeCredential`/`ActivateCredential` to prove the AK and EK share a TPM. On the device the activation MUST go through `HearthTpm.activateCredential(0x81010002, credentialBlob, encryptedSecret)` on `hearth#tpm` (protocols §7.5.3); `fleetd` never holds the endorsement hierarchy authorization. During installer-path enrolment the installer performs the same activation directly.
- **REQ-FLEET-002** BYOD enrolment MUST require an owner-presence touch on the device (the config apply that installs the fleet module) and MUST show the privacy summary (§4.9) before the touch.
- **REQ-FLEET-003** Managed enrolment MUST happen only from the installer (answers with `fleet.enrol_token` and `fido2 = 'fleet_delegated`), from a cloud seed (§4.16), or through an owner transfer (§4.11.3). The resulting config generation MUST record `fleet.mode = 'managed`, and the owner registry MUST be in `quorum` mode with the org admins as owners (protocols §5.4).

### 3.2 Policy

- **REQ-FLEET-010** Org policy, contracts, admin-key generations, org app releases and the `org-publishers` delegated role MUST be published in the org's TUF repository and MUST be fetched only by `courier` (the single TUF client) from the org TUF root pinned in the device's config generation.
- **REQ-FLEET-011** On the device, the effective policy MUST be keylos defaults ∪ org policy ∪ owner policy, evaluated together by Cedar where any `forbid` wins (protocols §16.2). Owner policy MUST NOT be able to remove an org `forbid`, and org policy MUST NOT be able to remove a keylos baseline `forbid`. `config` rejects an owner config that removes the org policy set while enrolled (`config` spec).
- **REQ-FLEET-012** Org config contracts (§4.4) MUST be enforced by `config` at compile time. A config generation failing an org contract MUST NOT be signable.
- **REQ-FLEET-013** Org policy MUST NOT grant capabilities. `fleet-lint` (run by `fleet-ctl policy validate` and again by `fleetd` before `installFleetModule`) MUST reject an org policy containing a `permit` without `@tier("t2")`, `@tier("t3")` or `@orgApproval`, unless the permit only refines a keylos default permit to a higher tier.
- **REQ-FLEET-014** For BYOD devices, every `@orgApproval` permit MUST also carry `@tier("t3")`, so a local approval always precedes the org decision. Managed appliances without a local human MAY use `@orgApproval` alone.

### 3.3 Attestation and witnessing

- **REQ-FLEET-020** `fleetd` MUST answer attestation challenges with a TPM2 quote over PCR 0–15 using the AK `0x81010002` (no PCR binding on the key, protocols §19.6), the server-provided nonce in the qualifying data, the TCG event log, the current ledger checkpoint, the release statement reference of the booted OS generation and, on `cvm` machines, the confidential-VM attestation report bound to the same nonce.
- **REQ-FLEET-021** The server MUST mark a device `compliant` only if:
  - the quote verifies with the enrolled AK;
  - PCR 11 matches the release statement's `ready` prediction for the claimed OS generation and profile (protocols §20.6), from a statement whose release-log inclusion verifies with at least `witnessThreshold` witness cosignatures (protocols §20.14);
  - PCR 0–7 match the device's recorded firmware baseline, or a vendor firmware manifest;
  - PCR 15 equals the value recorded at enrolment (same disk);
  - the checkpoint is consistent with the previously witnessed one;
  - the integrity profile (protocols §2.2) is allowed by org policy;
  - on `cvm` machines, the confidential-VM report verifies against the vendor's root (AMD ARK/ASK/VCEK for SEV-SNP, Intel PCS for TDX), its measurement matches the release statement's launch measurement for the image, and its report data binds the quote nonce and the AK name.
- **REQ-FLEET-022** The server MUST cosign device checkpoints only after verifying an RFC 6962 consistency proof from the last cosigned checkpoint, and that the checkpoint's `counter` line is not lower than the last one.

### 3.4 Privacy

- **REQ-FLEET-030** `fleetd` MUST NOT send receipt payloads, file names, file contents, browsing data, agent transcripts or vault data. The only exception is the explicitly configured managed-mode audit export (§4.9.3), which MUST be visible in `status`.
- **REQ-FLEET-031** Every category of data sent MUST be listed in the device-side "What your organisation sees" page, generated from the active `fleet.ncl` settings.
- **REQ-FLEET-032** `FleetCompliance.status` MUST return the same category list (§5.1.1) so any keylos UI can show it without parsing fleet-local formats.

### 3.5 Remote actions

- **REQ-FLEET-040** Remote commands MUST be available only in managed mode. A command MUST be a `keylos.fleet.command/1` DSSE envelope exactly per protocols §20.23 (`command` ∈ `lock`, `wipe`, `unlock-org`, `unenrol`), signed by ≥ `commandQuorum` distinct approvers of the device's `/etc/keylos/fleet/approvers.json` (`keylos.fleetapprovers/1`) with the presence construction of protocols §5.3, with `machine` = the device's machine key and `expires − issued ≤ 24 h`. `fleetd` checks it first; `hearth` (`lock`, the lock part of `wipe`, `unlock-org`, through `HearthFleet.lockAll`) and `rescue` (`wipe`) verify it again independently (protocols §14.5, §20.23).
- **REQ-FLEET-040a** A `wipe` MUST additionally carry an **owner quorum envelope** (protocols §5.4) of purpose `boot.wipe` over a `keylos.presence/1` payload whose `details` are `{"command": <the keylos.fleet.command/1 object>, "commandDigest": "sha256:<digest of its JCS bytes>"}` (protocols §20.2); `fleet` writes the bundle to `/var/lib/keylos/fleet/wipe.dsse` (protocols §10.7); `rescue` destroys keyslots only after verifying both (§4.11.2).
- **REQ-FLEET-040b** Each command `id` (`fc-…`) MUST be accepted once. `fleetd` keeps the ids of the last 30 days in its command log, as `hearth` does (protocols §20.23).
- **REQ-FLEET-041** BYOD devices MUST NOT accept remote lock or wipe. A BYOD owner can be unenrolled by the org (policy removal), but the org cannot affect local data.

### 3.6 Unenrolment

- **REQ-FLEET-050** A BYOD owner MUST be able to unenrol at any time with one presence touch. This produces a config generation without the fleet module, and `fleetd` notifies the server (best effort).
- **REQ-FLEET-051** Managed devices are unenrolled only by an `unenrol` command, which starts unenrolment and becomes effective only after an owner-signed config apply removes the fleet module (protocols §20.23), by the ownership-transfer ceremony (§4.11.3), or by a `wipe`.

### 3.7 Approvals

- **REQ-FLEET-060** `OrgDecider.decide` MUST return a `Decision` whose `mandate` is a DSSE `keylos.mandate/1` with `"channel": "org"`, `"presence": false`, signed by an `approver/<id>` key listed in the current org admins generation for the requested group, binding exactly the `effects[].digest` values of the prompt's `mandateDraft`.
- **REQ-FLEET-061** `fleetd` MUST deny (return `approved = false`) when the org server is unreachable beyond the prompt's `expires`, and MUST NOT cache approvals across prompts.

### 3.8 Quorum presence relay

- **REQ-FLEET-070** On managed devices `fleetd` MUST poll `HearthQuorum.list` (facet `quorum`) every 30 s while requests are pending, upload each new `keylos.quorum/1` request to the server, and submit every approver signature it receives with `HearthQuorum.submit`. It MUST NOT alter requests or signatures; `hearth` verifies everything.
- **REQ-FLEET-071** Config applies on managed devices MUST use `ConfigFleet.applyRemote(statement, approverEnvelopes)` with presence signatures of ≥ `policy.threshold` distinct owners.

### 3.9 Cluster nodes

- **REQ-FLEET-080** `FleetCluster.joinChallenge` MUST return 32 random bytes obtained from the server, valid ≤ 300 s and usable once. `FleetCluster.joinAttested(quote, eventLog, cvmReport, challenge)` (facet `cluster`, `cri` only) MUST refuse an unknown, expired or already-used challenge (`kl:expired`), MUST forward the quote, event log, confidential-VM report and challenge to the server, which MUST verify the quote's `qualifyingData = SHA-256("keylos-join/1" ‖ challenge ‖ machine key)` (protocols §7.5.21) and everything of REQ-FLEET-021, and only then return the cluster API endpoint, CA bundle and a bootstrap token bound to the node identity (device certificate and AK name).
- **REQ-FLEET-080a** On the `cloud` profile, before attesting a node the server MUST find a `keylos.cloudimage/1` record (protocols §20.24) in the release log, with witness cosignatures, whose `provider`, `region`, `imageId` and `osGen` match the node's instance metadata and quoted OS generation; a node booted from an unpublished image is `noncompliant:unpublished-image`.
- **REQ-FLEET-081** `FleetCluster.clusterCertificate(role, csrDer)` MUST be issued only to a node whose last attestation is `compliant` and younger than 2 attestation intervals, with a validity of at most 24 h (a longer requested lifetime is capped), and MUST NOT be issued for a node name other than the one bound at join. Allowed roles and subjects:

  | Role | Subject | EKU |
  |---|---|---|
  | `kubelet` | `CN = system:node:<node name>`, `O = system:nodes` | `clientAuth`, or `serverAuth` with the node-IP and node-name SANs (serving certificate) |
  | `kube-proxy` | `CN = system:kube-proxy` | `clientAuth` |
  | `cri` | `CN = system:keylos-cri:<node name>`, `O = system:keylos-cri` | `clientAuth` |

  Any other role or subject MUST be refused (`kl:invalid`). `kubeletCertificate(csr)` is exactly `clusterCertificate("kubelet", csr)`.
- **REQ-FLEET-082** A node whose attestation becomes non-compliant MUST NOT receive renewed certificates; it leaves the cluster when its certificate expires (protocols §21.7).

### 3.10 Receipts, publishers, seeds

- **REQ-FLEET-090** Audit export MUST use only `ledger#fleet-export`, which returns metadata-only receipts unless an owner exception of kind `fleet-receipt-access` (protocols §20.9) lists the event type.
- **REQ-FLEET-091** Org publishers MUST be onboarded through the org TUF `org-publishers` delegated role (protocols §11.8); their keys are trusted only on machines enrolled in that fleet and only after the owners enable them (`publishers.json` scope `org:<org>`).
- **REQ-FLEET-092** Cloud seeds MUST be DSSE `keylos.firstboot/1` envelopes signed by an org seed key listed in the image's `fleet.seedKeys`; seed keys MUST be held offline or in an HSM, and every seed signature MUST be recorded in the org audit log.

---

## 4. Design

### 4.1 Architecture

```
 ┌──────────────────── device ───────────────────────┐            ┌──────────── org ────────────┐
 │ fleetd (service "fleet", t0)                       │  HTTPS     │ fleet-server                 │
 │  ├─ enrol, attest (TPM: AK, device key)            │  mTLS      │  ├─ API (axum)               │
 │  ├─ witness client   (ledger#witness)              │◄──────────►│  ├─ attestation verifier     │
 │  ├─ OrgDecider       (served to broker)            │  device    │  ├─ witness (C2SP cosigner)  │
 │  ├─ FleetCompliance  (served to gate, settings)    │  TPM key   │  ├─ approvals router         │
 │  ├─ module installer (config#fleet)                │            │  ├─ inventory + compliance   │
 │  └─ remote command verifier                        │            │  ├─ escrow store             │
 │ courier ── org TUF repo ───────────────────────────┼──────────► │  └─ org TUF repo + OCI       │
 │ config (org contracts), broker (org policy)        │            │                              │
 └────────────────────────────────────────────────────┘            └──────────────────────────────┘
                                                                     ▲ fleet-ctl (admins), fleet-approve (approvers)
```

### 4.2 Device-side service

| Property | Value |
|---|---|
| Service name | `fleet` (protocols §19.1); present only on enrolled machines |
| Binary | `fleetd` |
| Tier | t0 |
| Facets served | `client`, `gate`, `decider`, `cluster` (protocols §19.2) |
| Routes held | `ledger#witness`; `config#fleet`; `gate#client` (the org server host and audit sink only); `journal#fleet` (aggregate metrics); `cri#status` (`server-k8s`); `hearth#tpm` (`activateCredential` only, for enrolment); managed mode: `hearth#quorum` (always), `hearth#fleet-lock` (when `managed_routes.lock`), `ledger#fleet-export` (when `managed_routes.audit`) |
| Devices | `/dev/tpmrm0`, granted as the device `dev:tpmrm:tpmrm0` by the fleet service manifest (`needs.devices`) and the default policy for service `fleet` |
| State | `/var/lib/fleetd/` |

`hearth#quorum`, `hearth#fleet-lock` and `ledger#fleet-export` are registry facets whose only holder is `fleet`, and `hearth#tpm` lists `fleet` for `activateCredential` only (protocols §19.2); the managed config generation routes them only when the corresponding feature is enabled, and each one is listed on the device page (§4.9.2). `fleetd` holds no `admin` facet of any service.

### 4.3 Org content distribution

**Org TUF repository.** The org runs a TUF repository with its own root. The device pins it in the config generation (`fleet.ncl` → `org.tuf_root`, rendered to `/etc/keylos/fleet.json`). `courier` treats it as an additional TUF repository named `org:<org id>`; keylos project TUF metadata is not involved.

**Targets:**

| Target | Kind | Content |
|---|---|---|
| `org/module/<serial>` | `data` generation | The **fleet module**: `org.ncl` (contracts, §4.4), `policy/*.cedar` (org policy), `approvers.json` (`keylos.fleetapprovers/1`, protocols §20.23: the command approvers and `commandQuorum`, rendered by `config` to `/etc/keylos/fleet/approvers.json`), `admins.json` (§4.3.1, fleet-local), `fleet-policy.json` (serial, issued, groups, grace period) |
| `org/revocations/<serial>` | TUF target file | Org revocation list, protocols §11.7 schema with `stream: "org:<id>"` |
| `org/apps/<name>/<version>` | `app` generation | Org app releases (`keylos.apprelease/1`, consumed by `courier`), installed by `depot` from `tuf:org:<id>/<name>` |
| `org-publishers` (delegated role) | TUF delegation | Org publisher keys or Sigstore identities (`org-publisher/<org>/<id>`, protocols §5.2), signing generation statements of org apps and of `container` generations for `keylos-sealed` pods |
| `org/genstmt/<gen digest>` | TUF target file | `keylos.genstmt/1` envelopes signed by org publishers, fetched by `courier` for `depot` (protocols §21.4) |

**Publishers.** `fleet-ctl publisher add <id> --key <spki> | --sigstore <issuer> <subject>` adds an entry to the `org-publishers` delegated role. Owners enable an org publisher in config (`publishers.json` with `scope: "org:<org>"`, protocols §20.20); BYOD owners see the publisher list on the device page. For `container` generations (`keylos-sealed` pods, protocols §21.4), `fleet-ctl containers sign <oci-ref>` converts the image with the same deterministic conversion `depot` uses (`oci-convert/1`, crate `keylos-oci-convert` published by the `depot` repository, protocols §21.4), computes the generation digest, and publishes a `keylos.genstmt/1` signed by the publisher key as the target `org/genstmt/<digest>`.

**Applying a module.** `courier` installs a new `org/module` generation into `depot` and notifies `fleetd` through its update status. `fleetd`:
1. runs `fleet-lint` on the module's policy (REQ-FLEET-013, REQ-FLEET-014) and refuses modules that fail;
2. calls `ConfigFleet.installFleetModule(gen)`.

`config` then evaluates the org contracts against the device's configuration, merges the org policy files into the policy generation it compiles, and produces a plan rendered as "Organisation policy update" (§4.3.2). The plan becomes effective only after an owner-presence-signed config apply (protocols §7.5.14, §15):
- **BYOD:** the owner sees the plan on the trusted path and touches. The owner may postpone; the device becomes `noncompliant:policy-pending` after the org's grace period (default 72 h).
- **Managed:** the owners are the org admins (quorum mode). Their presence signatures over the config generation statement are collected by `fleet-server` and handed to `config` with `ConfigFleet.applyRemote` (§4.7.3). A device never applies a module without a quorum envelope from its current owner registry.

#### 4.3.1 `admins.json`

```json
{"schema":"keylos.fleet.admins/1","org":"org-7f3a","serial":12,"issued":"…",
 "quorum":{"command":2,"escrow":2,"ownerTransfer":2},
 "admins":[{"id":"alice@corp","keys":[{"keyid":"key:sha256:…","alg":"fido2-es256","cose":"<base64>","credentialId":"<base64>"}]}],
 "approverGroups":{"finance-approvers":[{"id":"bob@corp","keys":[{"keyid":"key:sha256:…","alg":"fido2-es256","cose":"<base64>","credentialId":"<base64>"},
                                                               {"keyid":"key:sha256:…","alg":"ecdsa-p256-sha256","spki":"<base64>","origin":"vouch"}]}]},
 "orgKey":"key:sha256:…"}
```

- Admin and approver FIDO2 credentials are registered with rpId `keylos.owner` and sign with the protocols §5.3 construction; vouch phone approval keys sign with `ecdsa-p256-sha256`.
- Approver keys are the `approver/<id>` trust root of protocols §5.2.
- `admins.json` stays fleet-local: `fleetd` and `fleet-server` read it. Two derived files leave this repository, each in a protocols-defined or `config`-defined format:
  - `approvers.json` (`keylos.fleetapprovers/1`, protocols §20.23): `org`, `commandQuorum = quorum.command`, and one entry `{id, keyid, spki, alg}` per key of every admin. `fleet-ctl admins set` builds it from `admins.json` and publishes both in the same module; `config` renders it to `/etc/keylos/fleet/approvers.json`, which `hearth`, `rescue` and `broker` read.
  - The approver groups for org approvals, which `config` compiles into the policy generation as `/policy/org-approvers.json` for `broker` (`config` and `broker` specs).
- Group approvers who are not admins are not listed in `approvers.json`, so they can decide org approvals but can never sign remote commands.

#### 4.3.2 Policy diff rendering

`fleet-ctl` and the device render a Cedar diff as:
- added and removed `forbid`s, in plain-language templates per entity type (for example "Agents may no longer connect to hosts outside `*.corp.example`");
- tier escalations;
- new `@orgApproval` requirements with group names;
- contract changes ("Integrity profile must be `full`").

Templates live in `fleet-lint`; a `forbid` without a template is rendered as its Cedar source.

### 4.4 Org config contracts (`org.ncl`)

```nickel
# Example org contracts module
{
  contracts = {
    integrity = std.contract.from_predicate (fun cfg => cfg.profile.integrity == 'full),
    updates = std.contract.from_predicate (fun cfg => cfg.courier.auto_apply_security == true),
    attest = std.contract.from_predicate (fun cfg => cfg.fleet.attest_interval_min <= 60),
    agents_hosts = std.contract.from_predicate (fun cfg =>
      std.array.all (fun h => std.string.is_match "\\.corp\\.example$" h) cfg.aide.default_hosts),
    min_screen_lock = std.contract.from_predicate (fun cfg => cfg.hearth.idle_lock_secs <= 600),
  },
  # What the device must report (BYOD owners see this list)
  reporting = { apps_inventory = false, audit_export = [] },
}
```

`config` applies every contract in `contracts` to the device's fully evaluated configuration and reports failures with the contract name. Contracts evaluate only the config tree, so they cannot read user data. `fleet-lint` rejects contracts that reference paths outside the config namespaces listed in the `config` spec's public schema.

### 4.5 Enrolment

#### 4.5.1 Token

An admin creates an enrolment token with `fleet-ctl enrol-token create --mode byod|managed --group <g> --expires 7d`. The token is a DSSE envelope (`application/vnd.keylos.fleet.enrol+json; version=1`, fleet-local) signed by the org key:

```json
{"schema":"keylos.fleet.enrol/1","org":"org-7f3a","server":"https://fleet.corp.example",
 "tufRoot":"sha256:<digest of root.json v1>","mode":"byod","group":"engineering",
 "expires":"…","nonce":"<base64 16 bytes>"}
```

#### 4.5.2 Device key

`fleetd` creates the fleet device key at `0x81000120` (protocols §19.6) from the `keylos-tpm-registry` template: ECC P-256 signing, `fixedTPM | fixedParent | sensitiveDataOrigin`, `userWithAuth` clear, `authPolicy` = `PolicyAuthorize(stream PCR key, …)` satisfied by the stream-signed PCR11 `ready` prediction ∧ `PolicyPCR(15 = this disk's volume identity value)`. The key is therefore usable only while the device runs a release-stream-signed OS on the enrolled disk. Creating the persistent handle needs owner hierarchy authorization; `fleetd` cannot hold it, so:
- **BYOD:** the key is created as a transient object under the SRK, its private blob stored in `/var/lib/fleetd/device-key.blob`, and loaded per use (the handle `0x81000120` stays unused);
- **Managed (installer path):** the installer creates the persistent object at `0x81000120` during installation.

Both forms have the same policy and the same certification.

#### 4.5.3 Protocol

1. `fleetd` → `POST /v1/enrol/start` with the token, the EK certificate chain, AK public area and name (from NV `0x01300108`), and a hardware summary. The server checks the token signature, expiry and nonce, validates the EK chain, and returns a `MakeCredential` challenge for the AK.
2. `fleetd` obtains the `ActivateCredential` result through `HearthTpm.activateCredential(0x81010002, credentialBlob, encryptedSecret)` on `hearth#tpm` (protocols §7.5.3), because the activation needs the endorsement hierarchy authorization, which only `hearth` holds (protocols §19.6); during installer-path enrolment the installer performs the same activation directly. `fleetd` then certifies the device key with the AK (`TPM2_Certify`, authorised by the AK's empty authValue) and calls `POST /v1/enrol/finish` with the activation proof, the certification, a quote (§4.6) over a server nonce, and the device key public area. A failed activation aborts enrolment (`kl:integrity`); there is no unverified enrolment mode.
3. The server validates everything, records the PCR 15 value and the firmware baseline (PCR 0–7 + event log), creates the device record and returns:
   - a device certificate (X.509, org device CA, device key subject, 90-day validity, renewed automatically over mTLS from day 60);
   - the org TUF root metadata;
   - the initial policy, contracts and admins serials.
4. **BYOD:** `fleet enrol <token>` in the owner's shell shows the privacy summary and the policy diff, then calls `ConfigFleet.installFleetModule`; the owner applies the resulting plan with presence (REQ-FLEET-002).
5. **Managed (installer path):** the installer bundle's `fleet` part carries the token. At first boot `fleetd` completes steps 1–3; the first config generation already contains `fleet.ncl`, pre-signed by the org admins (installer `presigned.config`).

### 4.6 Attestation

**Challenge.** On a server request, or on schedule (org setting, default every 60 min while online), `fleetd` sends:

```json
{"schema":"keylos.fleet.attest/1","nonce":"<base64 32 bytes from server>","quote":"<base64 TPMS_ATTEST>",
 "signature":"<base64 TPMT_SIGNATURE>","pcrs":{"sha256":{"0":"…","1":"…","…":"…","15":"…"}},
 "eventLog":"<base64 TCG log>","osGeneration":"gen:fsv256:…","profile":"laptop",
 "release":{"stream":"stable","seq":4211,"logIndex":81234},
 "configGeneration":"gen:fsv256:…","configCounter":12,
 "checkpoint":"<C2SP note text>","integrity":"full","featureLevel":"KL3","bootTime":"…"}
```

The quote is `TPM2_Quote(AK 0x81010002, sha256 PCRs 0–15, qualifyingData = SHA-256("keylos-fleet-attest/1" ‖ nonce ‖ machine key ref))`. The AK has no PCR policy (protocols §19.6); the quoted PCR 15 shows the volume identity, and the server compares it with the enrolment value, so a quote from another disk is detected rather than impossible.

On `cvm` machines the attestation also carries `"cvm": {"kind": "sev-snp" | "tdx", "report": "<base64>", "certs": "<base64 chain>"}`; the report's `REPORT_DATA` (SEV-SNP) or `REPORTDATA` (TDX) is `SHA-256("keylos-fleet-cvm/1" ‖ nonce ‖ Name(AK))`, binding the confidential-VM report to the same TPM and the same challenge.

**Server verification:**
1. Nonce freshness (5-minute validity, single use).
2. AK signature; `extraData` = the qualifying data above; PCR digest matches `pcrs`.
3. Replay the event log against PCR 0–7 and compare with the device's baseline, or with vendor firmware manifests from LVFS where available. Unknown firmware changes put the device in `noncompliant:firmware-changed`; an admin can accept them as the new baseline.
4. PCR 11 against the `ready` prediction of the release statement for `release.seq` and `profile`. The server fetches the statement and its `keylos.tlogproof/1` through its own `tlog` client and verifies at least `witnessThreshold` witness cosignatures.
5. PCR 12 against the statement's `pcr12`; PCR 13 equals the "no extension" value.
6. PCR 15 equals the enrolment value.
7. Checkpoint consistency (§4.7).
8. `cvm`: verify the report chain (AMD ARK → ASK → VCEK, fetched from the AMD KDS and cached; Intel PCS collateral for TDX quotes), the report data binding, the policy (debug disabled, migration agent absent), and the launch measurement against the release statement's `profiles.cloud` value; failure is `noncompliant:cvm-report`.

**Compliance states** (per device):
- `compliant`;
- `noncompliant:<reasons>`, reasons from `integrity-degraded` (an integrity profile the org does not allow, for example `shared-boot`), `stale-os` (release `seq` below the org minimum), `policy-pending`, `firmware-changed`, `checkpoint-regression`, `quote-invalid`, `cvm-report`, `revoked-generation`;
- `unknown` (no attestation within 2× the interval).

### 4.7 Checkpoint witnessing and remote presence

#### 4.7.1 Witnessing

- `fleetd` polls `LedgerWitness.pending(afterTreeSize = last cosigned size)` at most every 10 minutes and at shutdown. It receives the newest checkpoint and the consistency proof.
- It submits both to `POST /v1/witness`. The server verifies the note signature with the device's ledger key (recorded at enrolment from the bundle's machine key), the origin `keylos-ledger/<machine key>`, tree size ≥ last, the consistency proof, and `counter` ≥ last.
- The server cosigns per C2SP tlog-cosignature with the org witness key and returns the cosignature line. `fleetd` stores it with `LedgerWitness.addCosignature`.
- **Regression or inconsistency** means device state `noncompliant:checkpoint-regression`, an admin alert, and for managed devices an optional automatic lock (org setting).
- The server stores per device only: origin, tree size, root hash, counter value, time.

#### 4.7.2 Org approvals

**Policy side:**

```cedar
@tier("t3")
@orgApproval("finance-approvers")
permit (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { resource.kind == "payment.authorize" && context.amount > 100000000 };   // > 100 USD in usd-micro
```

**Device side:**
1. `broker` reaches a decision for a permit with `@orgApproval`. On BYOD (REQ-FLEET-014) it first obtains the local T3 decision with presence where required, as for any `@tier("t3")` permit.
2. `broker` calls `OrgDecider.decide(prompt, group)` on `fleetd` (facet `decider`).
3. `fleetd` sends `POST /v1/approvals` with: effect kinds and targets; the rendered effects, reduced by the org's redaction rules (amounts and recipients for payments; repository and branch for `git.push`); payload digests; the requesting human; the device; the digest of the local mandate when one exists; the prompt's `expires`.
4. It long-polls `GET /v1/approvals/{id}` until a decision or `expires`.

**Server side:**
1. The server routes the request to the group's approvers: `fleet-approve` on their keylos desktops, or their `vouch` app.
2. An approver decides. Approve produces a `keylos.mandate/1` with `"channel": "org"`, `"presence": false`, `"decidedBy": "<approver id>@org:<org id>"`, the same `effects[].digest` values, signed by the approver key (`fido2-es256` with rpId `keylos.owner`, or the vouch phone key with `ecdsa-p256-sha256`).
3. The server returns the mandate; `fleetd` checks the signer is in the group in the current `admins.json` and the digests match the prompt, then returns `Decision{approved, scope: once, mandate}`.

**Timeouts.** Requests expire at the prompt's `expires` (policy default 24 h for org approvals). Expiry or an unreachable server results in `approved = false` (REQ-FLEET-061).

#### 4.7.3 Remote owner presence (managed, quorum machines)

Managed devices' owners are org admins, and the device's owner registry is in `quorum` mode (protocols §5.4).

**Config applies** (REQ-FLEET-071):
1. The device's pending plan is exported by `fleetd` to the server (`POST /v1/presence/{id}`) as the unsigned `keylos.configgen/1` payload plus the rendered plan.
2. `fleet-ctl config approve <device> <plan>` (or `fleet-approve`) shows the rendering, and each admin signs with their FIDO2 authenticator over the protocols §5.3 construction (purpose `config.apply`, UV, rpId `keylos.owner`). Admins on keylos machines may instead use `hearth presence --remote`.
3. When ≥ `policy.threshold` distinct admins have signed, the server returns the envelopes; `fleetd` calls `ConfigFleet.applyRemote(statement, approverEnvelopes)`; `config` merges them into one quorum envelope and applies.

**Every other presence purpose** (`owners.entry`, `seal.window`, `mandate`, `boot.<op>`, organisation unlock):
1. A local service asks `hearth` for presence; `hearth` creates a `keylos.quorum/1` request (protocols §20.18).
2. `fleetd` sees it through `HearthQuorum.list` (REQ-FLEET-070) and uploads it (`POST /v1/presence/{q-id}`, body = the request envelope).
3. Admins review the request's `rendering` and sign the payload's PAE (not the request) as above.
4. `fleetd` long-polls `GET /v1/presence/{q-id}` and passes each returned signed envelope to `HearthQuorum.submit`; `hearth` counts distinct owners. The requesting service then calls `HearthQuorum.collect`.

`fleetd` never holds a presence credential and never combines signatures itself.

### 4.8 Compliance tokens

`FleetCompliance.complianceToken(audience)` (facet `gate`) returns a DSSE envelope:

```json
{"schema":"keylos.fleet.compliance/1","org":"org-7f3a","device":"dev-91c2","audience":"https://sso.corp.example",
 "state":"compliant","integrity":"full","osRelease":{"stream":"stable","seq":4211},
 "issued":"…","expires":"…(issued + 1 h)","attested":"…"}
```

- Signed by the fleet device key (`ecdsa-p256-sha256`), with the device certificate chain in an envelope extension field `x-chain`.
- Issued only when the last server verdict is `compliant` and less than 2 attestation intervals old.
- `gate` injects it into requests to the configured audience (credential injection, `gate` spec); apps never see it.
- `fleet-server` publishes a verification library and a JWKS-like endpoint `/v1/compliance-keys` with the device CA, so org SSO can verify tokens offline.

### 4.9 Privacy boundaries

#### 4.9.1 Data sent by mode

| Category id | Data | BYOD | Managed |
|---|---|---|---|
| `hardware` | Device hardware summary (model, CPU, RAM, disk size, TPM vendor) | yes | yes |
| `os` | OS generation, stream, release seq, profile, integrity profile, feature level | yes | yes |
| `attestation` | Quotes and event logs | yes | yes |
| `checkpoints` | Ledger checkpoints (size, root, counter) | yes | yes |
| `apps` | Installed app generation names and versions | opt-in by owner | yes |
| `updates` | Update status | yes | yes |
| `approvals` | Org approval requests (redacted per §4.7.2) | only for org-approval effects | yes |
| `audit-export` | Receipt envelopes of listed event types | never | only if configured (§4.9.3) |
| `escrow` | Recovery key (encrypted to the org escrow key) | only if the owner opts in | yes |
| `users` | User names | owner username only | all local human names |
| — | Files, vault items, agent transcripts, browsing | never | never |

#### 4.9.2 Device page

Settings → Organisation shows, from `FleetCompliance.status`:
- the mode, org name and admins;
- the table above, filled in for this device;
- the managed-mode extra routes held by `fleetd` (§4.2);
- the policy diff relative to no org;
- the next attestation time and last verdict;
- the unenrol button (BYOD).

#### 4.9.3 Audit export (managed only)

An org policy may list receipt event types (protocols §19.3) to export, for example `agent.merge`, `effect.commit`, `config.apply`. When the list is non-empty:
- the managed config routes `fleetd` to `ledger#fleet-export` (REQ-FLEET-090);
- `fleetd` calls `LedgerAdmin.export(filterJson, out)` every 15 minutes with `{"eventTypes": [...], "since": <last exported time>}` into a sealed memfd, and forwards the envelopes to the org audit sink over mTLS;
- the export contains **metadata only** (sealed payloads omitted, protocols §13.4) unless an owner exception of kind `fleet-receipt-access` (protocols §20.9) lists the event type; on managed machines such an exception is a config change signed by the owner quorum (the admins), and on BYOD machines only the person can sign it;
- `status` and the greeter show "Organisation receives audit records: effect.commit, agent.merge" and whether payloads are included.

### 4.10 Recovery-key escrow

- The installer (managed answers, or the BYOD owner's later opt-in through `fleet escrow enable`) encrypts the recovery key to the org escrow public key (HPKE RFC 9180 base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM). `fleetd` uploads it at the first connection (`POST /v1/escrow`).
- **Release** needs `fleet-ctl escrow release <device>` signed by `quorum.escrow` admins. The server returns the ciphertext to the requesting admin, who decrypts it with the escrow private key (held offline or in the org HSM).
- Every release writes an org audit record. For BYOD devices it also notifies the owner through `fleetd` at the next contact (receipt `fleet.command` with `data.kind = "escrow-release-notice"`).

### 4.11 Remote commands (managed)

#### 4.11.1 Format

Commands are exactly protocols §20.23 (`keylos.fleet.command/1`, embedded in §2.15d1): `id` (`fc-` ULID), `org`, `machine` (the device's machine key), `command` (`lock`, `wipe`, `unlock-org`, `unenrol`), `reason`, `issued`, `expires`, `nonce`. `fleet-ctl command <kind> <device>` builds the payload from the device record (the machine key was recorded at enrolment).

**Signatures.** Each approver signs the command payload with the presence construction of protocols §5.3 (rpId `keylos.owner` of the approver's own machine, UV); the DSSE envelope carries one signature per approver. `fleet-server` collects signatures and releases the command only when `commandQuorum` distinct approvers have signed.

**Verification by `fleetd`** (a pre-check that rejects malformed commands early):
1. `payloadType = application/vnd.keylos.fleet.command+json; version=1`; JCS-canonical payload; `schema`, `org` and `machine` match the device.
2. ≥ `commandQuorum` distinct approvers of the admins generation `fleetd` last received from the org (`/var/lib/fleetd/admins.json`, the same keys and quorum the published `approvers.json` carries), each signature verified with `keylos-presence` against that approver's key (approvers are counted by `id`, not by signature). `fleetd` does not read `/etc/keylos/fleet/approvers.json`, whose registered readers are `hearth`, `rescue` and `broker` (protocols §10.7).
3. `issued ≤ now < expires`, `expires − issued ≤ 24 h` (trusted time, protocols §3.6).
4. `id` not in the command log (ids kept 30 days, REQ-FLEET-040b).

BYOD devices reject every command (REQ-FLEET-041). The authoritative checks are done independently by `hearth` (`lock`, `unlock-org`, the lock part of `wipe`) and `rescue` (`wipe`) against `/etc/keylos/fleet/approvers.json`; `fleetd` reads no `hearth` or `config` files.

#### 4.11.2 Effects

| Command | Effect |
|---|---|
| `lock` | `HearthFleet.lockAll(command)` (protocols §7.5.3, §14.5): `hearth` verifies the approver signatures again, locks every human session, kills every agent session and marks the sessions `orgLocked`. The greeter shows "Locked by your organisation" |
| `unlock-org` | `HearthFleet.lockAll(command)`: `hearth` verifies it and lifts the org lock; each user still unlocks their own session with normal authentication (protocols §20.23) |
| `wipe` | (1) Write a `fleet.command` receipt and push the final checkpoint to the witness. (2) Lock as above with `HearthFleet.lockAll` (a wipe command also authorizes the lock). (3) Write the **wipe bundle** `/var/lib/keylos/fleet/wipe.dsse`: JSON Lines of exactly two DSSE envelopes, the verified command envelope first and the owner quorum envelope of REQ-FLEET-040a second (both formats are protocols-defined, and the path is the protocols §10.7 row). The admins sign the `boot.wipe` presence payload together with the command in `fleet-ctl command wipe`; `fleet-server` delivers both. (4) `hearth` refuses new logins while the device is `orgLocked`, and `atrium` shows "This device was wiped by your organisation; restart into recovery to complete". (5) The next time the device enters the recovery environment, `rescue` (installer spec, REQ-INSTALLER-044) verifies the command against `approvers.json` and the quorum envelope against the replayed owner registry (≥ `policy.threshold` distinct owners), then performs a factory reset (crypto-erase of the LUKS2 header and keyslots, removal of keylos TPM objects). A command alone never wipes; until recovery the data stays protected by disk encryption, the TPM and the lock |
| `unenrol` | `fleetd` produces a config plan without the fleet module; it takes effect only when applied with remote owner presence (§4.7.3, protocols §20.23) |

#### 4.11.3 Ownership transfer

A managed device can be handed to a person as BYOD:
1. An admin starts the ceremony with `fleet-ctl transfer <device> --to <username>`. Transfer is not a remote command (protocols §20.23 has none): every step below is an owner-registry entry or a config apply with the signatures the owner registry requires.
2. The new owner enrols their FIDO2 credentials on the device's trusted path (`hearth`); `hearth` produces the `add-owner` entry, which needs the admin quorum (a quorum request relayed by `fleetd`, §4.7.3) and the new credential.
3. A `set-quorum` entry switches the registry to `mode = "touch"` with `quorum = 1`, signed by the admin quorum.
4. A `remove-owner` entry for each admin follows, signed by the new owner.
5. A config plan switching `fleet.mode` to `'byod` (or removing the module) is applied with the new owner's presence.

### 4.12 Server

**Components.** `fleet-server` is a Rust (axum + tokio) service. Storage:
- PostgreSQL in production; SQLite for small orgs;
- object storage (S3-compatible or filesystem) for event logs and quotes.

**Endpoints** (all under `/v1`, JSON, mTLS for device endpoints):

| Method | Path | Caller | Purpose |
|---|---|---|---|
| POST | `/enrol/start` | device (token auth) | Begin enrolment; returns the AK credential challenge |
| POST | `/enrol/finish` | device | Activation proof, certification, quote → device certificate |
| POST | `/cert/renew` | device | Renew the device certificate |
| POST | `/attest/nonce` | device | Get a nonce |
| POST | `/attest` | device | Submit an attestation |
| POST | `/witness` | device | Submit a checkpoint + consistency proof → cosignature |
| POST | `/inventory` | device | Inventory report |
| POST | `/approvals` | device | Create an approval request |
| GET | `/approvals/{id}` | device | Long-poll the decision |
| GET | `/commands` | device | Pending commands (also pushed over WebSocket `/commands/ws`) |
| POST | `/presence/{id}` | device | Upload a config plan or a `keylos.quorum/1` request needing remote owner presence |
| GET | `/presence/{id}` | device | Long-poll signed envelopes (one per admin, as they arrive) |
| POST | `/cluster/join` | device (`cri` through `fleetd`) | Attested cluster join (§4.15) |
| POST | `/cluster/cert` | device | Kubelet certificate issue and renewal |
| POST | `/escrow` | device | Upload the escrowed recovery key |
| POST | `/audit` | device | Audit export batch (managed) |
| GET | `/compliance-keys` | org SSO | Device CA bundle for compliance-token verification |
| GET | `/admin/devices` … | admin (mTLS with a FIDO2-backed client certificate, or OIDC + FIDO2) | Admin API used by `fleet-ctl` |
| POST | `/admin/approvals/{id}/decision` | approver | Submit a mandate |
| POST | `/admin/presence/{id}` | admin | Submit a presence envelope |

**Rate limits** per device: 60 requests/min, attestation at most once per minute.

**Server hardening.** The server SHOULD run on a keylos `server` profile machine as a tier-1 app generation, with its database on the same host or an org-managed PostgreSQL.

### 4.13 `fleet-approve`

A tier-1 keylos app for approvers and admins. It lists pending approval and presence requests with the rendered effect. To sign, it uses the approver's FIDO2 authenticator directly (CTAP2 over a `hidraw` device grant obtained through the powerbox-style device prompt of `devd`/`broker`, T2), with rpId `keylos.owner` and the protocols §5.3 construction. Approvers without keylos use `fleet-ctl` (any OS with `libfido2`) or `vouch` (`vouch` spec §4.5.3).

### 4.14 Device CLI (`fleet`)

The `fleet` binary runs in the owner's shell and talks to `fleetd` over the repo-local `FleetAdmin` interface (§5.1.2), obtained with `Extensible.ext` on the `client` facet. It is part of this repository, so the repo-local interface stays within one repository (protocols §7.4).

### 4.15 Cluster nodes (`FleetCluster`)

`server-k8s` machines join an org Kubernetes cluster only through fleet (protocols §21.7). The org configures each cluster in `fleet-server` with: the API endpoint, the cluster CA bundle, the node CA (a signer whose certificates the API server accepts for `system:nodes`; either delegated to `fleet-server` or reached through the API server's CSR API with a `fleet-server` approver identity), allowed node groups and the minimum release `seq`.

**`joinChallenge()`** (facet `cluster`, caller `cri`): `fleetd` obtains 32 random bytes from the server (`POST /v1/cluster/challenge`), records them with their expiry (≤ 300 s), and returns them. The server keeps each challenge until it is used or expires.

**`joinAttested(quote, eventLog, cvmReport, challenge)`** (facet `cluster`, caller `cri`):
1. `fleetd` refuses a challenge it did not issue, an expired one, or one already used (`kl:expired`). `cri` produced the quote with qualifying data `SHA-256("keylos-join/1" ‖ challenge ‖ machine key)` (protocols §7.5.21).
2. `fleetd` sends `POST /v1/cluster/join` with the quote, event log, CVM report (if any), the challenge, the device certificate (mTLS), the node name requested by `cri` and the booted release reference.
3. The server verifies the challenge (issued by it, unexpired, unused; then marked used), the qualifying data, everything of REQ-FLEET-021, and: the device is enrolled and assigned to a cluster group; the node name matches `<device id>` or the org's naming rule; the release `seq` is at least the cluster minimum; on the `cloud` profile a matching `keylos.cloudimage/1` record (REQ-FLEET-080a).
4. The server returns `joinJson`: `{"cluster": "<id>", "apiServer": "https://…", "caBundle": "<PEM>", "nodeName": "…", "bootstrapToken": "<opaque, 15 min, single use>", "labels": {…}, "taints": […]}`. The bootstrap token is bound to the node name and the AK name; it is usable only once, for the first `clusterCertificate` call.
5. Receipt `fleet.attest{purpose: "cluster-join", result}`.

**`clusterCertificate(role, csrDer)`** (REQ-FLEET-081; `kubeletCertificate(csr)` = `clusterCertificate("kubelet", csr)`):
1. `cri` generates each key in its state directory and sends a PKCS#10 CSR with the subject and EKU of the role (REQ-FLEET-081 table).
2. `fleetd` forwards it with the bootstrap token (first time) or with the current attestation reference (renewals).
3. The server checks the latest attestation (`compliant`, age < 2 intervals), the role, the CSR subject, SANs and EKU, and issues a certificate valid ≤ 24 h through the configured node CA (the `cri` role through the cluster CA with the RBAC binding the `cri` spec requires). It returns the chain and expiry.
4. `cri` renews at 2/3 of the lifetime. If the device becomes non-compliant, renewal fails with `kl:denied` and `fleetd` notes the reason in `FleetCompliance.status`; the node leaves the cluster when its certificate expires (REQ-FLEET-082).

### 4.16 Cloud seeds

`fleet-ctl seed create --profile cloud --org-key … --owners <file> --threshold N` produces the one metadata value a `cloud` image's `keylos-seed` stage reads (installer spec §4.15, protocols §20.13 "Cloud seed"): `keylos/firstboot`, a DSSE `keylos.firstboot/1` signed by an org **seed key** (REQ-FLEET-092) whose
- `fleet` part carries the enrolment token for this instance;
- `owners` part carries the owner-registry lines for the org admins in `quorum` mode (genesis first), which the admins pre-sign with `fleet-ctl presence sign` (rpId `keylos.owner`);
- `config` part carries the first config generation reference and its quorum-signed `keylos.configgen/1` statement.

Seed keys are listed in the image's config generation (`fleet.seedKeys`) when the org builds or customises its cloud image; the project's public images list no seed keys and therefore refuse to seed until the org's image customisation adds them. At first boot `fleetd` completes enrolment from the bundle's token (§4.5.3) and uploads the escrowed recovery key.

---

## 5. Interfaces

### 5.1 capwire

#### 5.1.1 Protocols interfaces implemented

`FleetCompliance` (facets `client`, `gate`), `OrgDecider` (facet `decider`) and `FleetCluster` (facet `cluster`), exactly as §2.7. `FleetCompliance.status` returns JCS JSON:

```json
{"enrolled":true,"mode":"byod","org":{"id":"org-7f3a","name":"Corp"},
 "compliance":"compliant","reasons":[],"lastAttest":"…","lastWitness":"…",
 "policySerial":41,"contractsSerial":9,"adminsSerial":12,
 "sends":["hardware","os","attestation","checkpoints","updates","approvals"],
 "extraRoutes":[],"nextAttest":"…",
 "integrityProfile":"full","quorum":{"pending":0},
 "cluster":{"joined":false,"node":null,"certExpires":null},
 "receiptAccess":"metadata-only"}
```

#### 5.1.2 Repo-local `FleetAdmin`

```capnp
@0xd4e1a5c3b2f40201;
using C = import "/keylos/common.capnp";

interface FleetAdmin {             # obtained via Extensible.ext on facet client; used only by the `fleet` CLI
  enrol        @0 (token :Text) -> (privacySummary :Text, policyDiff :Text);  # then installFleetModule; plan applied by the owner
  unenrol      @1 () -> (planId :Text);                                       # BYOD: presence via the config plan
  attestNow    @2 () -> (compliance :Text);
  escrowEnable @3 () -> ();                                                   # BYOD opt-in; recovery key typed on the trusted path
  inventoryOptIn @4 (apps :Bool) -> ();
}
```

### 5.2 CLI

```
fleet-ctl --server <url> <subcommand>          (admin tool, any OS)
  org init --name <n> --tuf-dir <dir> --escrow-pubkey <file>
  admins set --file <admins.json>              publish an admins generation (TUF threshold)
  enrol-token create --mode byod|managed --group <g> --expires <dur>
  policy validate <dir>                        REQ-FLEET-013/014 checks (fleet-lint)
  policy diff <dir> [--against <serial>]
  policy publish <dir>                         build the policy generation, sign TUF targets (threshold)
  contracts publish <org.ncl>
  apps publish <oci-ref>                       publish an org app release
  publisher add <id> --key <spki> | --sigstore <issuer> <subject>   org-publishers role (TUF threshold)
  publisher remove <id>                        revoke (org revocation list entry for the key)
  containers sign <oci-ref> --publisher <id>   convert deterministically, publish org/genstmt/<digest>
  cluster add <id> --api <url> --ca <pem> --node-ca <cfg> --min-seq <n>
  cluster nodes <id>                           attestation state and certificate expiry per node
  seed create --profile cloud --owners <file> --threshold N --out <dir>   cloud seed metadata (§4.16)
  presence sign <request.dsse|plan>            sign a quorum request or config plan with a FIDO2 key (rpId keylos.owner)
  devices list [--group g] [--compliance state]
  devices show <id>
  devices baseline accept <id>                 accept a firmware-changed baseline
  config approve <device> <plan-id>            remote owner presence (FIDO2)
  command lock|unlock-org|wipe|unenrol <id> --reason <text>   (collects commandQuorum signatures; wipe also
                                               collects the owner quorum envelope, REQ-FLEET-040a)
  transfer <id> --to <username>                ownership transfer ceremony (§4.11.3)
  escrow release <id>                          (quorum)
  escrow rotate --new-pubkey <file>            (quorum; re-encrypts every escrow record offline with the old private key)
  approvals list|show|decide
  audit export --since <t>

fleet status                                   (device, owner shell)
fleet enrol <token>
fleet unenrol
fleet attest
fleet escrow enable
fleet inventory --apps on|off

fleetd                                         (service)

Exit codes: 0 ok; 1 error; 2 usage; 3 quorum not reached; 4 verification failed; 5 server unreachable;
            6 not enrolled; 7 refused in BYOD mode.
```

### 5.3 Files

| Path | Content |
|---|---|
| `/etc/keylos/fleet.json` | Rendered by `config` from `fleet.ncl`: server URL, org ID, TUF root digest, mode, intervals, reporting settings, granted extra routes |
| `/var/lib/fleetd/device.crt` | Device certificate chain |
| `/var/lib/fleetd/device-key.blob` | BYOD transient device key blob (§4.5.2) |
| `/var/lib/fleetd/commands.log` | Verified command ids (kept 30 days) and outcomes |
| `/var/lib/fleetd/admins.json` | The current admins generation (§4.3.1), for command pre-checks |
| `/var/lib/fleetd/witness.json` | Last cosigned tree size, root, counter |
| `/var/lib/keylos/fleet/wipe.dsse` | Wipe bundle for `rescue`: command envelope and owner quorum envelope (§4.11.2) |

---

## 6. Security

### 6.1 Threats

| Threat | Mitigation |
|---|---|
| Malicious or compromised org server pushes permissive policy | Org policy cannot grant (REQ-FLEET-013); keylos baseline forbids remain; every change needs owner presence; BYOD owners see the diff |
| Org server pushes a malicious app | Same `depot` checks: TUF via `courier`, publisher key, capability-diff consent, rebuilder quorum; non-reproducible → tier 2 |
| Server compromise leaks user data | The server never receives user data (§4.9) |
| Forged remote wipe | `commandQuorum` approver signatures plus an owner quorum envelope; machine binding, expiry and single-use id; BYOD rejects; `rescue` verifies both again |
| Fake device enrolment | EK chain + credential activation + quote + PCR 15 binding |
| Stolen device certificate | Device key is TPM-bound with a PCR11-ready and PCR15 policy; unusable outside the genuine OS on that disk |
| Rollback of the device ledger to hide actions | Witness consistency checks; TPM counter in each checkpoint |
| Org approver coerced | Org approval is in addition to local approval on BYOD (REQ-FLEET-014) |
| Compliance token theft | One-hour validity; audience-bound; injected by `gate`, never exposed to apps |
| Managed-mode extra routes abused by a compromised `fleetd` | Only fleet-specific registry facets (`hearth#quorum`, `hearth#fleet-lock`, `ledger#fleet-export`), granted only when the feature is configured; listed on the device page; `fleetd` cannot produce presence signatures, so it cannot change config, owners or seals; a forged lock still needs `commandQuorum` approver signatures that `hearth` verifies against `approvers.json` |
| Compromised `fleetd` relays a forged quorum signature | `hearth` verifies every signature against the owner registry and counts distinct owners |
| Non-attested or downgraded node joins the cluster | Join and certificates require a fresh compliant attestation; certificates live ≤ 24 h |
| Forged confidential-VM report | Vendor root chain, report-data binding to nonce and AK name |
| Leaked cloud seed | Seeds are single-instance (enrolment token), signed by an offline seed key; owner entries carry admins' own presence signatures |
| Org reads personal receipt payloads | `fleet-export` is metadata-only unless the owners sign a `fleet-receipt-access` exception, shown on the device page |

### 6.2 Confinement of `fleetd`

- Tier 0, baseline seccomp (`baseline-1`) plus `ioctl` on the granted `tpmrm0` fd.
- Network only through `gate` to the configured server host and audit sink.
- TPM: only through `/dev/tpmrm0`; its policy sessions cannot satisfy the disk token, owner-seal, KEK/db or vault objects, whose policies need the PIN, seal gates or other services' sealed values.
- Landlock: `/var/lib/fleetd` read/write; `/var/lib/keylos/fleet` write; `/etc/keylos/fleet.json` read.
- The kubelet client key never passes through `fleetd`; it receives only the CSR and returns the certificate chain.
- No presence: `fleetd` has no `hearth#presence` or `atrium#presence` route.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| Server unreachable | The device keeps the last policy; compliance becomes `unknown` server-side after 2 intervals; org approvals deny at expiry; local behaviour otherwise unchanged |
| Policy update fails org contracts locally | BYOD: the owner sees conflicts and can change config or unenrol; managed: conflicts are reported to admins and the device stays on the previous policy |
| TPM cleared | Device key and AK lost → re-enrolment required; managed devices re-enrol after `rescue reenrol tpm` with the escrowed recovery key |
| Admin quorum lost | The org rotates admin keys through its TUF root (threshold) and publishes a new admins generation; managed owner-registry changes then need the remaining admins plus the recovery path |
| Checkpoint regression false positive (device restored legitimately) | Admin review; `devices baseline accept` resets the witness state with a recorded reason |
| Org TUF metadata expired (device offline long) | `courier` reports freeze; device stays on current policy; compliance `unknown` server-side |

---

## 8. Performance budgets

| Metric | Budget |
|---|---|
| `fleetd` RSS | ≤ 20 MiB |
| Attestation round trip (device CPU) | ≤ 300 ms (quote generation dominates) |
| Server attestation verification | ≤ 20 ms per device excluding the release statement fetch (cached) |
| Server capacity | 50 000 devices on 8 vCPU / 16 GiB with PostgreSQL, 60-minute attestation interval |
| Approval routing latency (approver online) | ≤ 5 s |
| Witness cosign round trip | ≤ 500 ms |

---

## 9. Observability

- **Receipts** written by `fleetd` through `ledger` (protocols §19.3): `fleet.enrol`, `fleet.unenrol`, `fleet.policy.apply`, `fleet.command` (lock, unlock-org, wipe, unenrol, escrow notices), `fleet.attest` (sampled: every 24 h and on state changes). `approval.request` / `approval.decide` for org approvals are written by `broker`.
- **Device metrics** (journal metrics records, protocols §10.6): `fleet_attest_total{result}`, `fleet_witness_total{result}`, `fleet_approval_seconds`, `fleet_server_errors_total`.
- **Server:**
  - structured logs;
  - an org audit log (append-only, hash-chained, `keylos.receipt/1`-shaped records with `writer: fleet-server:<org>`);
  - Prometheus metrics: devices by compliance state, attestation failures by reason, approval latency.

---

## 10. Configuration

```nickel
# fleet.ncl (device side, part of the config generation)
{
  Fleet = {
    enrolled | Bool | default = false,
    mode | [| 'byod, 'managed |] | optional,
    org | { id | String, name | String, server | String, tuf_root | String, audit_sink | String | optional } | optional,
    policy_serial | Number | optional,
    contracts_serial | Number | optional,
    admins_serial | Number | optional,
    attest_interval_min | Number | default = 60,
    witness | Bool | default = true,
    reporting | {
      apps_inventory | Bool | default = false,
      audit_export | Array String | default = [],    # managed only
    },
    managed_routes | {
      lock | Bool | default = false,                 # routes hearth#fleet-lock
      audit | Bool | default = false,                # routes ledger#fleet-export
    },
    cluster | { enabled | Bool | default = false, id | String | optional } | optional,   # server-k8s only
    seed_keys | Array String | default = [],         # rendered into the image config as fleet.seedKeys (cloud images)
    grace_hours | Number | default = 72,
    escrow | Bool | default = false,
    compliance_audiences | Array String | default = [],
  },
}
```

Contracts: `managed_routes.lock || managed_routes.audit` ⇒ `mode == 'managed`; `reporting.audit_export` non-empty ⇒ `managed_routes.audit`.

---

## 11. Testing and acceptance criteria

**Unit tests:**
- `fleet-lint`: a corpus of org policies covering REQ-FLEET-013 and REQ-FLEET-014;
- policy diff rendering;
- attestation verifier against recorded quotes and event logs (swtpm and three hardware TPM vendors);
- consistency-proof and cosignature verification against protocols `vectors/receipts/` and `tlog` vectors;
- command verification against `approvers.json` (distinct-approver counting by `id`, `machine` binding, `expires − issued ≤ 24 h`, single-use `id` over 30 days, wrong `org`), against protocols `vectors/fleetcommand/`;
- mandate checks for `OrgDecider` (group membership, digest binding, `channel = org`, `presence = false`) against protocols `vectors/cedar/` annotation cases.

**Integration**, in a VM fleet of 3 swtpm devices plus a server:
1. BYOD enrolment with presence; the privacy summary matches §4.9.1; `FleetCompliance.status.sends` matches.
2. Org policy forbidding agent hosts outside `*.corp.example` → `aide` sessions get denials; the owner cannot remove the forbid (config rejects).
3. Org approval for `payment.authorize` above a threshold → commit blocked until the approver mandate arrives; a wrong-digest org mandate and a mandate from a non-group key are rejected.
4. Firmware change → `firmware-changed` → baseline accept.
5. Device ledger restored from an old disk image → `checkpoint-regression` detected.
6. Managed wipe with 2-of-3 approver signatures and the owner quorum envelope → device crypto-erased by `rescue`; a single signature is rejected; a command without the quorum envelope locks but `rescue` refuses to wipe; a `boot.wipe` envelope whose `details.command` differs from the command object, or whose `commandDigest` is not `sha256:` of its JCS bytes, is refused; BYOD rejects the command.
7. Escrow release requires 2 admins; the BYOD owner is notified.
8. Managed config update with remote admin presence; a presence envelope from a non-owner admin key is rejected by `config`.
9. Compliance token: issued when compliant, refused when `noncompliant`, injected by `gate` only for the configured audience.
10. Quorum relay: a `seal.window` request on a managed device reaches two admins through the server; one signature gives `have 1/2`; the second completes it; a signature by a non-owner admin key is rejected by `hearth`.
11. Remote config apply: `applyRemote` with envelopes from 2 of 3 admins applies; with 1 it fails in `config`.
12. Cluster join: a compliant `server-k8s` node joins with a fresh challenge and receives 24-hour `kubelet`, `kube-proxy` and `cri` certificates with the REQ-FLEET-081 subjects; a second join with the same challenge, or with an expired one, is refused; a CSR with another node name or an unknown role is refused; after an unapproved firmware change renewal fails and the node leaves at expiry; a bootstrap token replay is refused.
17. Cloud image records: a `cloud` node booted from a published image (record in the release log) joins; the same node with an instance image ID absent from the records is `noncompliant:unpublished-image`.
18. Later BYOD enrolment: `fleetd` activates the AK credential through `HearthTpm.activateCredential`; the server sees a correct activation proof; a swapped AK name fails activation and aborts enrolment.
19. `unlock-org`: after `lock`, an `unlock-org` command signed by 2 of 3 approvers lifts the org lock; users still need their own authentication; a replayed `unlock-org` id is refused.
20. Group approvers: an org-approval approver who is not an admin can decide an `@orgApproval` prompt but a command signed by that approver does not count toward `commandQuorum`.
13. CVM: a SEV-SNP guest with a valid report is `cvm`/compliant; a report with debug enabled, or report data not bound to the nonce, is `noncompliant:cvm-report`.
14. Audit export: with no owner exception the sink receives metadata-only receipts; after the owners sign a `fleet-receipt-access` exception for `effect.commit`, payloads of that event type only are included.
15. Org publisher: `containers sign` produces a generation statement whose digest equals the one `depot` computes for the same image; a `keylos-sealed` pod with an image from a disabled publisher is refused.
16. Cloud seed: `seed create` output boots a `cloud` image to a quorum-mode, fleet-enrolled machine; altering any owner entry makes `keylos-seed` refuse.

**Fuzz:** server JSON endpoints, the event-log parser, the command parser, `admins.json` parser.

**Acceptance:** all of the above pass. A BYOD device's network capture over 24 h contains only the categories in §4.9.1 (privacy conformance test `fleet-privacy`).

---

## 12. Implementation notes

**Crates:**
- `axum` 0.7, `tokio` 1, `rustls` 0.23
- `sqlx` 0.8 (PostgreSQL/SQLite)
- `tss-esapi` 7 with `keylos-tpm-registry` templates
- `tough` (TUF repository tooling for `fleet-ctl`; devices use `courier`)
- `cedar-policy` 4 (`fleet-lint`)
- `nickel-lang-core` (contract tests; on devices `config` evaluates)
- `x509-cert` 0.2, `rcgen` 0.13 (device CA)
- `hpke` 0.12
- `libfido2` FFI for `fleet-ctl` and `fleet-approve`
- `serde` 1, `clap` 4
- `keylos-ids`, `keylos-formats`, `keylos-presence`, `keylos-capwire`, `keylos-schemas`

**Repository layout:**

```
fleet/
  crates/fleet-proto/      JSON types, DSSE helpers, admins.json, commands
  crates/fleet-attest/     quote + event-log verification
  crates/fleet-lint/       org policy rules and diff rendering
  bins/fleetd/  bins/fleet/  bins/fleet-server/  bins/fleet-ctl/
  apps/fleet-approve/
  data/tpm-vendor-cas/
  schema/fleet.ncl  schema/org-contracts-example.ncl
  tests/
```

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reference |
|---|---|---|
| Org can only forbid, escalate, add approvals and contracts | Full MDM-style control | Keeps the device's authority model intact |
| Every org policy change goes through an owner-presence-signed config apply | Silent push | [ADR-0011](../../handbook/11-decisions/adr-0011-owner-presence-fido2.md) |
| Managed devices: org admins are owners in the owner registry; presence signed remotely with their FIDO2 credentials | A device-local service key acting as owner | Keeps one presence model (protocols §5.3) |
| Org TUF repository fetched by `courier` | `fleetd` as a second TUF client | [ADR-0017](../../handbook/11-decisions/adr-0017-tuf-over-oci.md); protocols §7.3.8 |
| Witness cosigns checkpoints only | Upload receipts | [ADR-0031](../../handbook/11-decisions/adr-0031-receipts-ledger.md) |
| Org approvals add to local T3 on BYOD | Org-only approvals | [ADR-0028](../../handbook/11-decisions/adr-0028-approval-tiers.md) |
| Remote wipe only for managed devices, quorum-signed, executed by `rescue` | Any enrolled device; wipe from the running system | Privacy and abuse resistance; the running system holds no erase authority |
| Managed devices are quorum machines; fleet only relays signatures | `fleetd` holding a signing key for the org | `hearth` stays the only presence verifier; a compromised `fleetd` cannot approve anything |
| Cluster membership gated on attestation, short-lived kubelet certificates | Long-lived node certificates; static bootstrap tokens | A node that stops attesting leaves the cluster within a day |
| Audit export metadata-only by default | Full receipt export | Receipt payloads are personal data (protocols §13.4) |

### 13.1 Open contract dependencies

| Dependency | Needed for | Status in protocols 1.0 |
|---|---|---|
| Wipe bundle `/var/lib/keylos/fleet/wipe.dsse` (fleet writes, `rescue` reads) | Completing a wipe at the next recovery entry (§4.11.2) | Its two envelopes are protocols formats (§20.23, §5.4, §20.2) and the path is a protocols §10.7 row; `rescue` accepts the same bundle from removable media only when the file is absent (installer spec §4.13.3) |
| Compliance tokens through `gate` injection | Server-to-SSO integration | [ADR-0039](../../handbook/11-decisions/adr-0039-secrets-never-in-env.md) |
