# keylos/tlog — transparency logs, witnesses and verification

| | |
|---|---|
| Repository | `github.com/keylos-os/tlog` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `tlog-sequencer` (log server), `tlog-witness` (witness server), `tlog-monitor` (log monitor), `tlog-index` (untrusted lookup service), `tlog` (CLI); crate `keylos-tlog-client` (verification library used by `courier`, `forge`, `vouch`, `fleet`, `ledger` tooling) |
| Depends on | `keylos-protocols 1.0`; external standards: C2SP `signed-note`, `tlog-checkpoint`, `tlog-tiles`, `tlog-cosignature`, `tlog-witness`; RFC 6962 Merkle tree hashing |
| Provides | The realisation log and the release log services; the witness profile; the monitor rules; the client verification library; the `keylos.logauth/1` submitter authorisation format |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

keylos relies on public, append-only logs so that **every build realisation and every release is visible to everyone**, which makes targeted or silent backdoors detectable. This repository provides:

1. the **log server** that sequences entries into a Merkle tree and serves it as static tiles;
2. the **witness** that cosigns checkpoints after verifying consistency, which defeats split views;
3. the **monitor** that follows the logs and alerts on suspicious entries or log behaviour, and (optionally) checks the app **catalog** against the realisations log;
4. the **untrusted index** that maps derivations and generations to log indexes;
5. the **client library** that verifies checkpoints, cosignatures, inclusion and consistency, keeps the last-seen checkpoints, and verifies offline proof bundles (`keylos.tlogproof/1`, protocols §20.14).

### 1.1 Non-goals

- The machine-local receipt ledger (`ledger`): it reuses the checkpoint and cosignature formats and this client library, but it is not a public log.
- Sigstore Rekor (publishers with keyless identities are verified by `courier`).
- TUF repositories and the documents distributed through them (`keylos.logs/1` and `keylos.rebuilders/1` are owned by `courier`; this repository consumes them only as inputs supplied by callers).
- Deciding whether an entry's content is true. Logs make entries visible; clients and monitors judge them.

---

## 2. Context and embedded contracts

```
release engineering ──DSSE keylos.release/1──────► releases log ─┐
rebuilders ──DSSE realisation / bootstrap / ddc──► realisations ─┤──► witnesses ──► cosigned checkpoints
                                                                 │
courier / vouch / fleet / forge ── keylos-tlog-client ── verify (online tiles or offline proof bundles)
monitors ── follow both logs ── alerts feed
ledger (per machine) ── C2SP checkpoints ── personal witness (vouch), fleet witness
```

### 2.1 Embedded contracts

Every block below is copied verbatim from `keylos/protocols` 1.0.0 (final). If an embedded copy differs from protocols, protocols wins.

#### protocols §5.1 Envelope

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

#### protocols §5.2 Trust roots

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

#### protocols §11.4 Realisation attestation

An in-toto Statement v1 with:
- `subject` = the output generation: `name` = `<name>-<version>.<output>`, `digest: {"fsv256": hex}`;
- `predicateType` = `https://keylos.org/realisation/v1`;
- predicate = `{"drv": "drv:sha256:…", "output": "out", "builder": "<operator id>", "buildHost": {"arch":…, "kernel":…, "forgeVersion":…}, "started":…, "finished":…}`.

It is signed by `rebuilder/<operator>` and logged in the **realisation log** (§11.5).

#### protocols §11.5 Transparency logs

keylos operates two logs, both following **C2SP tlog-tiles** with checkpoints per **C2SP tlog-checkpoint** and witness cosignatures per **C2SP tlog-cosignature**:

| Log | Origin line | Entries |
|---|---|---|
| Realisation log | `log.keylos.org/realisations` | DSSE realisation attestations (§11.4) |
| Release log | `log.keylos.org/releases` | DSSE release statements (`keylos.release/1`, §20.6) and cloud image records (`keylos.cloudimage/1`, §20.24), signed by `release-stream/<stream>` |

Clients MUST verify inclusion against a checkpoint cosigned by at least `witnessThreshold` (default **2**) witnesses from the witness list in TUF targets metadata (`rebuilders.json`: `witnesses`, `witnessThreshold`). A generation is installable from a distro or publisher channel only if its realisation log entries reach the rebuilder quorum named in its release or app-release statement.

#### protocols §11.7 Revocation list

```json
{"schema":"keylos.revocations/1","stream":"stable","serial":1234,"issued":"…",
 "objects":[{"ref":"obj:fsv256:…","reason":"CVE-2026-XXXX","action":"evict"}],
 "generations":[{"ref":"gen:fsv256:…","reason":"…","action":"unlaunchable"}],
 "keys":[{"ref":"key:sha256:…","reason":"compromised","after":"…"}]}
```

- Distributed as a TUF target by `courier` and logged (its digest) in the release statement.
- Actions: `unlaunchable`, `evict`, `warn`.
- A `keys[]` entry for a `publisher/<id>` or `org-publisher/…` key makes every generation whose only authorising signature is by that key `unlaunchable` from `after` onwards; generations signed before `after` stay launchable only if their realisations reach the rebuilder quorum.

#### protocols §11.8 Publishers and catalog

- **Onboarding.** A publisher is added to the TUF `publishers` delegated role (signed by `distro-root` delegation keys) with either an Ed25519 key held in hardware or a Sigstore identity (OIDC issuer + subject) and an accepted publisher policy version. Org publishers are delegated from a fleet's TUF repository (`org-publishers` role) and are trusted only on machines enrolled in that fleet.
- **Enabling.** A machine trusts a publisher only after the owner enables it in config (`/etc/keylos/publishers.json`, §20.20); it then enters the boot trust set at the next boot.
- **Catalog.** `keylos.catalog/1` (§20.20) is a TUF target signed by the `catalog` role. A listing is `reviewed-reproducible` only if its generations' realisations reach the rebuilder quorum and the catalog review passed; otherwise it is `unreviewed`. Installing an `unreviewed` app sets its effective tier floor to 2 unless the owner records an exception (`keylos.exception/1`, kind `reproducibility`).

#### protocols §13.3 Checkpoints (ledger usage of the same formats)

- `ledger` emits a **C2SP signed-note checkpoint** (origin `keylos-ledger/<machine key>`) at least every 60 s while there is activity, and on shutdown.
- The TPM NV counter `0x01300100` (§19.6) is incremented at most once per 900 s while there is activity, at shutdown, and immediately after security-class events (`grant.revoke`, `config.apply`, `gen.seal`, `update.commit`, `key.enroll`, `key.remove`, `ledger.alarm`). Every checkpoint note carries the extension line `counter <n>` with the current counter value, binding the tree size and root hash in the signed note to the counter. A ledger whose newest checkpoint counter is below the NV value has been rolled back.
- Checkpoints MAY be submitted to owner-configured witnesses (`LedgerWitness`, §7.5.5: the `vouch` phone, a fleet witness).
- `ledger.key.register` receipts are never sealed; their `data` is `{"service": "<name>", "spki": "<base64 DER>", "keyRef": "key:sha256:…"}`. `Ledger.serviceKey` (§7.3.5) answers from them.

#### protocols §19.4 Media types (rows owned by tlog)

| Schema | Media type | Owner (full definition) | Purpose |
|---|---|---|---|
| `keylos.logauth/1`, `keylos.candidates/1`, `keylos.mismatch/1` | (tlog/forge-internal) | tlog, forge | Log operator and rebuilder formats |

#### protocols §20.6 Release statement (`keylos.release/1`)

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

#### protocols §20.14 Transparency-log proof bundle (`keylos.tlogproof/1`)

```json
{"schema":"keylos.tlogproof/1",
 "origin":"log.keylos.org/realisations",
 "index":123456,
 "entry":"<base64 of entry bytes>",
 "checkpoint":"<full signed note text including cosignature lines>",
 "inclusion":["<base64 hash>"]}
```

Verification: verify the log signature on the checkpoint with the origin's key (TUF `logs.json`); verify ≥ `witnessThreshold` cosignatures from distinct listed witnesses; compute the RFC 6962 leaf hash of `entry` and verify inclusion at `index`; update the persisted last-seen checkpoint (consistency-checked) when online.

#### protocols §20.20 Publishers and catalog

`/etc/keylos/publishers.json` (`keylos.publishers/1`, rendered by `config`): `{"schema", "publishers": [{"id": "…", "keys": ["key:sha256:…"], "sigstore": [{"issuer": "…", "subject": "…"}], "spki": {"key:sha256:…": "<base64 DER>"}, "scope": "distro" | "org:<org>"}]}`.

`keylos.catalog/1` (TUF target signed by the `catalog` role):

```json
{"schema":"keylos.catalog/1","issued":"…","expires":"…",
 "entries":[{"name":"org.example.Editor","publisher":"example","summary":"…","categories":["development"],
             "latest":{"version":"2.5.0","generation":"gen:fsv256:…","statement":"sha256:<genstmt envelope digest>"},
             "review":"reviewed-reproducible" | "unreviewed","quorum":"3/3","capabilities":"sha256:<JCS digest>",
             "icons":["https://…"],"homepage":"https://…"}]}
```

#### protocols §20.24 Cloud image records (`keylos.cloudimage/1`)

DSSE-signed by `release-stream/<stream>`, published as TUF targets `cloud/<provider>/<region>/<seq>.json` and logged in the release log next to the release statement:

```json
{"schema":"keylos.cloudimage/1","stream":"stable","seq":4211,"provider":"aws","region":"eu-central-1",
 "imageId":"ami-…","arch":"x86_64","osGen":"gen:fsv256:…","ukiSha256":"…","published":"…"}
```

`fleet` uses these records to check that a cloud node booted a published image before attesting it.

---

## 3. Requirements

### 3.1 Log server

- **REQ-TLOG-001** Each log MUST implement C2SP `tlog-tiles`: full and partial hash tiles at `/tile/<L>/<N>[.p/<W>]`, entry bundles at `/tile/entries/<N>[.p/<W>]`, and `/checkpoint`, with tile height 8 (256 hashes per tile) and RFC 6962 hashing (`leaf = SHA-256(0x00 ‖ entry)`, `node = SHA-256(0x01 ‖ left ‖ right)`).
- **REQ-TLOG-002** Entries MUST be the exact DSSE envelope bytes as submitted (JSON, ≤ 60 KiB). Entry bundles use the tlog-tiles encoding (big-endian `uint16` length prefix per entry).
- **REQ-TLOG-003** The sequencer MUST accept an entry only if:
  1. it is a well-formed DSSE envelope whose payload is JCS-canonical (protocols §5.1) and whose `payloadType` is accepted by that log (§4.1);
  2. at least one signature verifies with a key **authorised for that log** (§4.3);
  3. for the releases log, release statements: the payload's `schema` is `keylos.release/1`, its `stream` is one the signing key is authorised for, its `seq` is strictly greater than the highest `seq` already logged for that stream, and it passes the structural rules of §4.2 (in particular: **no `recovery` object** at the top level or inside a profile, and every profile's `pcr11` map contains the five phases `enter-initrd`, `leave-initrd`, `sysinit`, `ready`, `enter-recovery`);
  3a. for the releases log, cloud image records: the payload's `schema` is `keylos.cloudimage/1` (protocols §20.24), its `stream` is one the signing key is authorised for, a release statement with the same `stream` and `seq` is already integrated, and it passes the structural rules of §4.2;
  4. it is not a duplicate (same entry bytes); duplicates return the existing index.
- **REQ-TLOG-004** The sequencer MUST integrate accepted entries and publish a new checkpoint within 2 s (p99) of acceptance, batching entries.
- **REQ-TLOG-005** The checkpoint MUST be a C2SP signed note: body lines `<origin>`, `<tree size>`, `<base64 root hash>`, optional extension lines, signed with the log's Ed25519 note key held in an HSM.
- **REQ-TLOG-006** Published full tiles and full entry bundles MUST be immutable. Partial tiles are superseded by larger partial tiles or the full tile.
- **REQ-TLOG-007** The sequencer MUST NOT publish two checkpoints without a consistency proof between them (no forks). Before signing, it MUST verify consistency from its previous checkpoint using durable state.

### 3.2 Witness

- **REQ-TLOG-010** `tlog-witness` MUST implement the C2SP `tlog-witness` API (`POST /add-checkpoint` with the old size, a consistency proof and the new checkpoint) and return a `tlog-cosignature` (`cosignature/v1`, timestamped Ed25519).
- **REQ-TLOG-011** A witness MUST cosign a checkpoint only if the log signature verifies, the size is ≥ its last cosigned size for that origin, and the consistency proof from its stored checkpoint verifies. It MUST persist the new checkpoint before returning the cosignature.
- **REQ-TLOG-012** A witness MUST refuse (HTTP 409) a checkpoint with the same size but a different root hash, or a smaller size than its stored one, and MUST record conflicting signed checkpoints as **split-view evidence** retrievable at `/evidence/<origin hash>`.

### 3.3 Client library

- **REQ-TLOG-020** `keylos-tlog-client` MUST verify log note signatures, witness cosignatures against a witness policy `(witness keys, threshold)`, inclusion proofs, consistency proofs, and proofs constructed from fetched tiles.
- **REQ-TLOG-021** The client MUST persist, per origin, verified checkpoints through a caller-supplied store and MUST require a consistency proof from the newest stored checkpoint to any newer one. A checkpoint of equal size MUST have the same root; a smaller one MUST be consistent with the stored newest checkpoint.
- **REQ-TLOG-022** The client MUST verify `keylos.tlogproof/1` bundles without network access (§4.6).
- **REQ-TLOG-023** The client MUST NOT trust `tlog-index` answers without inclusion verification and content comparison.
- **REQ-TLOG-024** The client MUST NOT parse TUF documents. Log keys, witness keys and thresholds are passed in by callers (which read them from courier-owned TUF targets).
- **REQ-TLOG-025** The client MUST provide `verify_cloudimage(record, release)`: it checks both envelopes' inclusion as for release statements and then the binding rules of §4.2 (cloud image records) between the record and the release statement of the same `stream` and `seq`. `fleet` uses it before attesting a cloud node (protocols §20.24).

### 3.4 Monitor and index

- **REQ-TLOG-030** `tlog-monitor` MUST follow both logs from index 0, verify each checkpoint is consistent with the previous one, check every entry against the rules of §4.8, and publish alerts.
- **REQ-TLOG-031** `tlog-index` MUST derive its maps only from verified log content and MUST serve answers that clients can verify (`origin`, `index`).
- **REQ-TLOG-032** When configured with a catalog source (§4.8.1), `tlog-monitor` MUST check every `keylos.catalog/1` version against the realisations log and alert on the catalog rules. Catalog monitoring is OPTIONAL for third-party monitors and REQUIRED for the project-run monitor.

### 3.5 Operations

- **REQ-TLOG-040** Each log MUST publish a daily archive (§4.10) signed by the log's note key as a signed note whose body is `<origin> archive\n<date>\n<size>\n<base64 SHA-256 of the archive>`.
- **REQ-TLOG-041** A frozen log MUST reject submissions with `403 frozen` and MUST keep serving tiles, bundles and its final checkpoint.
- **REQ-TLOG-042** Sequencer failover MUST fence the previous active instance (HSM session revoked) before the new instance signs any checkpoint.
- **REQ-TLOG-043** Every service MUST expose its version and the protocols version it conforms to at `GET /version` (`{"implementation":…,"protocols":"1.0.0"}`).

---

## 4. Design

### 4.1 Logs operated

| Log | Origin | Note key holder | Accepted `payloadType` | Accepted payloads |
|---|---|---|---|---|
| Realisations | `log.keylos.org/realisations` | keylos project HSM | `application/vnd.in-toto+json` | in-toto Statement v1 with `predicateType` `https://keylos.org/realisation/v1`, `https://keylos.org/bootstrap/v1` or `https://keylos.org/ddc/v1` |
| Releases | `log.keylos.org/releases` | keylos project HSM | `application/vnd.keylos.release+json; version=1`, `application/vnd.keylos.cloudimage+json; version=1` | `keylos.release/1` (protocols §20.6) and `keylos.cloudimage/1` cloud image records (protocols §20.24), both signed by `release-stream/<stream>` (protocols §11.5) |

Revocation lists are not separate log entries: each release statement binds the current revocation list by `revocations.serial` and `revocations.digest`, so a revocation list is published by logging a release statement.

**Key rotation.** A log note key is rotated by starting a **new log** with a new origin (for example `log.keylos.org/realisations/2027`) and freezing the old one: the sequencer accepts no more entries, a final checkpoint is published and cosigned by every witness, and the sequencer stays read-only. Active and frozen logs are listed in the courier-owned TUF target `logs.json`; clients receive that list from their caller.

### 4.2 Entry rules per log

**Realisations log** (`validate.realisation`):

| Check | Rule |
|---|---|
| Statement type | `_type` = `https://in-toto.io/Statement/v1` |
| Subjects | Exactly one subject; `name` matches `^[A-Za-z0-9._+-]+-[^.]+(\.[a-z0-9-]+)$` (`<name>-<version>.<output>`); `digest` has exactly the key `fsv256` with 64 lowercase hex |
| Predicate (realisation) | `drv` is a `drv:sha256:` ref; `output` is present and equals the subject's suffix; `builder` equals the operator ID the signing key is authorised for; `started` ≤ `finished` |
| Predicate (bootstrap, ddc) | `stage` or `compiler` fields present per §4.2.1 |
| Signer | One authorised `rebuilder/<operator>` key |

**Releases log** (`validate.release`):

| Check | Rule (rejection code) |
|---|---|
| Schema | `schema` = `keylos.release/1` (`release-schema`) |
| Stream | `stream` is one of the signing key's authorised streams (`release-stream`) |
| Sequence | `seq` strictly increases per stream (REQ-TLOG-003.3) (`release-seq`) |
| Floor | `floor` ≤ `seq` (`release-floor`) |
| Profiles | Every `profiles.<p>.osGen` is a `gen:fsv256:` ref; `osDrv` a `drv:sha256:` ref; `uki.sha256` 64 hex; `pcr11` has exactly the phases `enter-initrd`, `leave-initrd`, `sysinit`, `ready`, `enter-recovery`, each `sha256:<64 hex>`; `recoveryGen` is a `gen:fsv256:` ref (`release-profile`) |
| Cloud seed | Profile `cloud`, when present, carries `pcr11Seed`, a non-empty map of phase names to `sha256:<64 hex>`; no other profile carries `pcr11Seed` (`release-seed`) |
| No recovery object | No key named `recovery` at the top level or in any profile: the recovery environment is the `recovery` profile phase inside each UKI (protocols §20.6) (`release-recovery-object`) |
| Revocations | `revocations.serial` ≥ the previous release's for the stream; `revocations.digest` is `sha256:<64 hex>` (`release-revocations`) |
| Kernel | `kernel.uname` non-empty; `kernel.featureLevel` ∈ {`KL1`, `KL2`, `KL3`} (`release-kernel`) |

**Cloud image records** (`validate.cloudimage`, protocols §20.24):

| Check | Rule (rejection code) |
|---|---|
| Schema | `schema` = `keylos.cloudimage/1` (`cloudimage-schema`) |
| Stream | `stream` is one of the signing key's authorised streams (`release-stream`) |
| Release | A `keylos.release/1` entry for the same `stream` and `seq` is already integrated in this log (`cloudimage-release`) |
| Binding | `osGen` equals the `profiles.cloud.osGen` of that release statement and `ukiSha256` equals its `profiles.cloud.uki.sha256`; `arch` equals the release's `arch` (`cloudimage-binding`) |
| Fields | `provider` matches `^[a-z0-9-]{1,32}$`, `region` and `imageId` are non-empty and ≤ 128 bytes, `published` is RFC 3339 (`cloudimage-fields`) |
| Uniqueness | No earlier record with the same `stream`, `seq`, `provider`, `region` and `arch` (`cloudimage-dup`) |

The sequencer performs these structural checks only; whether the named generations exist and reached quorum is judged by clients and the monitor.

#### 4.2.1 Bootstrap and DDC predicates

```json
{"predicateType":"https://keylos.org/bootstrap/v1",
 "predicate":{"stage":"2","inputs":["src:sha256:…"],"seed":"sha256:<hex0 seed>","outputs":{"gcc":"gen:fsv256:…"},
              "builder":"rebuilder-a","forgeVersion":"1.0.4"}}
{"predicateType":"https://keylos.org/ddc/v1",
 "predicate":{"compiler":"gcc-15.2","pathA":"gen:fsv256:…","pathB":"gen:fsv256:…","identical":true,
              "builder":"rebuilder-b","forgeVersion":"1.0.4"}}
```

### 4.3 Submitter authorisation (`keylos.logauth/1`)

The sequencer loads an authorisation document from a TUF target signed through the `distro-root` delegation (fetched by the operator's deployment tooling, not by the sequencer):

```json
{"schema":"keylos.logauth/1","serial":17,
 "realisations":{"operators":[{"id":"rebuilder-a","keys":["key:sha256:…"],"spki":{"key:sha256:…":"<base64 DER>"}}]},
 "releases":{"streams":[{"stream":"stable","keys":["key:sha256:…"],"spki":{"key:sha256:…":"<base64 DER>"}}]}}
```

Rules:
- Unauthorised submissions are rejected with HTTP 403. Authorisation limits spam; entry correctness is still judged by clients and monitors.
- A new document is applied only when its `serial` is greater than the current one. Removing a key stops new submissions; existing entries stay.
- `keylos.logauth/1` is tlog-owned (protocols §19.4).

### 4.4 Sequencer

| Module | Role |
|---|---|
| `ingest` | HTTPS `POST /add` and `POST /add-batch` (≤ 256 entries) |
| `validate` | Payload type, JCS check, signature verification, authorisation, per-log entry rules, size limits |
| `dedup` | `SHA-256(entry)` → index map in durable state |
| `integrate` | Append leaves; compute new tiles and entry bundles |
| `sign` | Build the checkpoint body and sign through PKCS#11 (HSM, Ed25519) |
| `witness` | Submit the new checkpoint to the configured witnesses; collect cosignatures |
| `publish` | Write immutable objects to the object store, then the checkpoint last |

**Durable state** (redb): `meta` (tree size, root hash, latest signed checkpoint, latest cosignatures), `dedup` (`SHA-256(entry)` → index), `pending` (accepted, not yet integrated entries with their acceptance time), `streams` (releases log: highest `seq` per stream). Recovery after a crash re-derives everything from durable state, never from the object store.

**Integration cycle:**

```
loop:
  batch := take pending (≤ batchMaxEntries, or wait ≤ batchMaxDelayMs)
  for e in batch: idx := size++; leaf_hash[idx] := SHA-256(0x00 ‖ e)
  recompute the right edge of every affected tile level (tiles of height 8)
  write entry bundles and tiles (full: immutable path; partial: .p/<W>)
  root := RFC 6962 root over size leaves (from tiles)
  verify consistency(previous checkpoint → (size, root)) from tiles      # REQ-TLOG-007
  note := sign(origin \n size \n base64(root) \n)
  durable commit (meta, dedup, streams; pending emptied)
  cosigs := witness.submit(note) within 5 s
  publish /checkpoint = note + cosignature lines
  answer the waiting POST /add calls with {index, checkpoint}
```

**Publication order:** entry bundles and tiles before the checkpoint that covers them; the checkpoint object is replaced atomically. Cache headers: full tiles and bundles `Cache-Control: public, max-age=31536000, immutable`; partial tiles `max-age=60`; checkpoint `max-age=5`.

**Cosigned checkpoint publication:** `/checkpoint` contains the log signature line plus every witness cosignature line obtained within 5 s. Clients that need more cosignatures MAY query witnesses directly (`GET <witness>/checkpoint/<origin hash>`).

### 4.5 Witness

| Aspect | Specification |
|---|---|
| API | C2SP `tlog-witness`: `POST /add-checkpoint` with body `old <size>\n`, consistency proof lines (base64), a blank line, then the checkpoint note. Responses: `200` with the cosignature line; `409` conflict (body: the witness's latest checkpoint for the origin); `403` unknown log; `422` bad proof |
| Known logs | Configured list of `(origin, note verifier key)`; keylos witnesses MUST know both keylos logs |
| Cosignature | `cosignature/v1` timestamped Ed25519 over `cosignature/v1\ntime <unix seconds>\n<checkpoint body>` (C2SP tlog-cosignature) |
| State | Per origin: latest cosigned checkpoint; append-only history of `(size, root, time)` |
| Evidence | Conflicting signed checkpoints (same size, different roots; or a checkpoint inconsistent with a stored one) are stored and exposed at `/evidence/<origin hash>` |
| Rate limit | 10 requests/s per origin; checkpoints older than 1 h relative to the witness clock are accepted only when their size is greater than the stored size |

**Witness state machine per origin:**

```
empty ─first valid checkpoint (old size 0)─► tracking(size, root)
tracking ─valid consistency proof to larger size─► tracking(new)
tracking ─same size, same root─► tracking (re-issue the stored cosignature)
tracking ─same size, different root | inconsistent proof─► tracking + evidence recorded, 409
```

keylos witness operators: the project runs one; at least three independent organisations run others. The witness list and threshold are published in the courier-owned TUF target `rebuilders.json` (`witnesses`, `witnessThreshold`, default 2). keylos witnesses MAY also join public witness networks.

**Personal witnesses.** The `vouch` phone app embeds a witness for the release log and for its owner's `ledger` origins: it stores the largest checkpoint seen and alerts when a machine shows a checkpoint inconsistent with it. `fleet` MAY run a witness for its machines' ledgers. Both use this crate's verification core and the same cosignature format.

### 4.6 Proof bundles

`keylos.tlogproof/1` (protocols §20.14) is used in generation provenance (`/.keylos/provenance.json`), in `Resolution.attestations`, in `.klb` bundles, and by `vouch`.

**Construction** (`tlog prove`, rebuilders, release engineering):
1. fetch the current checkpoint with cosignatures (log `/checkpoint`, plus witnesses until `witnessThreshold` distinct cosignatures are present);
2. compute the inclusion proof for `index` from tiles (§4.9.2);
3. write `{schema, origin, index, entry (base64), checkpoint (full note text with cosignature lines), inclusion}`.

**Verification** (`verify_bundle`):
1. parse the note; verify the log signature with the origin's key supplied by the caller;
2. verify ≥ `threshold` cosignatures from distinct witnesses in the caller's policy;
3. compute `SHA-256(0x00 ‖ entry)`; verify RFC 6962 inclusion at `index` for the note's size and root;
4. **online:** fetch a consistency proof from the newest stored checkpoint to the bundle's checkpoint (or the reverse when the bundle's is older), verify it, and update the stored checkpoints (REQ-TLOG-021) → verdict `Verified`;
5. **offline:** if the bundle's checkpoint equals a stored checkpoint (same origin, size and root) → `Verified`; otherwise → `WitnessedOnly`: the threshold of independent witnesses vouches that no split view was shown to them, but consistency with this client's own stored view could not be checked. The caller decides (`courier` and `vouch` accept `WitnessedOnly` offline and re-verify at the next online refresh).

The client keeps, per origin, a ring of the last 64 verified checkpoints, each stored with the consistency proof from its predecessor, so a chain of stored checkpoints can be re-verified without network.

### 4.7 Index (`tlog-index`, untrusted)

- `GET /lookup/drv/<hex>` → `[{"origin", "index", "output", "builder"}]`
- `GET /lookup/gen/<hex>` → `[{"origin", "index"}]`
- `GET /lookup/release/<stream>/<seq>` → `{"origin", "index"}`
- `GET /lookup/cloudimage/<stream>/<seq>` → `[{"origin", "index", "provider", "region", "arch"}]`

Built by following the logs with the client library. Clients fetch the entry by index from tiles, verify inclusion against a verified checkpoint, and compare the entry content with the query. A lying index can only cause denial of service.

### 4.8 Monitor rules

| Rule | Alert when |
|---|---|
| `release-seq` | A stream's `keylos.release/1` `seq` does not strictly increase (should be impossible: the sequencer enforces it) |
| `release-floor` | `floor` > `seq`, or `floor` decreases between releases of a stream |
| `release-without-quorum` | A release names an `osGen` for which the realisations log lacks attestations from `rebuilders.required` distinct operators (from `rebuilders.attested`) at the time of the release |
| `release-revocations-regression` | `revocations.serial` decreases, or a revocation list (fetched by digest from the stream's TUF repository through the monitor's own TUF client) drops an `evict` or `unlaunchable` entry present in an earlier list |
| `unexpected-key` | An entry is signed by a key not in the current authorisation document |
| `mismatched-realisation` | Two realisations for the same `(drv, output)` name different generation digests |
| `log-inconsistency` | A checkpoint is not consistent with an earlier one |
| `witness-silence` | A witness has not cosigned for 1 h while the log grew |
| `witness-evidence` | Any witness publishes split-view evidence |
| `release-recovery-object` | A logged release statement carries a `recovery` object (should be impossible: the sequencer rejects it) |
| `cloudimage-unbound` | A logged cloud image record does not match the `profiles.cloud` of its release statement (should be impossible: the sequencer rejects it) |
| `cloudimage-late` | A cloud image record is logged more than 14 days after its release statement, or for a release older than the stream's current `floor` |

#### 4.8.1 Catalog monitoring

With `catalog` configured, the monitor fetches each new version of the `keylos.catalog/1` TUF target (through its own TUF client, verifying the `catalog` role) and evaluates:

| Rule | Alert when |
|---|---|
| `catalog-reviewed-without-quorum` | An entry has `review: "reviewed-reproducible"` but the realisations log does not contain attestations for `latest.generation` from at least *k* distinct operators, where `quorum` = `"k/n"` |
| `catalog-quorum-claim` | An entry's `quorum` claims more attesting operators than the realisations log shows for `latest.generation` |
| `catalog-version-regression` | `latest.version` of an entry decreases (SemVer order) between catalog versions without the entry having been removed in between |
| `catalog-expiry-regression` | `issued` decreases or `expires` ≤ `issued` |
| `catalog-capability-change` | `latest.capabilities` changes while `latest.version` stays the same |

Generations in the realisations log are matched by subject digest: an app generation's realisation is the attestation whose subject digest equals `latest.generation`. The monitor keeps, per catalog entry name, the last seen `latest` record. Alerts use the same feed and sinks as §4.8.

The monitor's TUF client is a deployment component of the monitor service (operator infrastructure), separate from the keylos machine-side `courier`.

**Alert feed** (`GET /alerts.json`, newest first, 1 000 entries):

```json
{"schema":"keylos.tlog.alerts/1","generated":"…",
 "alerts":[{"rule":"mismatched-realisation","origin":"log.keylos.org/realisations","indexes":[1201,1755],
            "detail":{"drv":"drv:sha256:…","output":"out"},"time":"…"}]}
```

Alerts also go to configured sinks (webhook JSON, operator email) and the public status page. Anyone can run a monitor.

### 4.9 Client library (`keylos-tlog-client`)

#### 4.9.1 API

```rust
pub struct LogKey { pub origin: String, pub verifier: NoteVerifier }        // Ed25519 note key
pub struct WitnessPolicy { pub witnesses: Vec<NoteVerifier>, pub threshold: usize }

pub struct Checkpoint { pub origin: String, pub size: u64, pub root: [u8; 32],
                        pub extensions: Vec<String>, pub note: String, pub cosigners: Vec<String> }

pub trait CheckpointStore {                                                   // caller-supplied
    fn load(&self, origin: &str) -> Result<Vec<StoredCheckpoint>>;           // ring, newest last
    fn store(&self, origin: &str, cp: &StoredCheckpoint) -> Result<()>;
}
pub struct StoredCheckpoint { pub cp: Checkpoint, pub consistency_from_prev: Vec<[u8; 32]> }

pub trait TileFetcher {                                                       // caller-supplied transport
    async fn tile(&self, level: u8, index: u64, width: u16) -> Result<Vec<u8>>;
    async fn entries(&self, index: u64, width: u16) -> Result<Vec<u8>>;
    async fn checkpoint(&self) -> Result<String>;
}

pub fn verify_checkpoint(note: &str, log: &LogKey, policy: &WitnessPolicy) -> Result<Checkpoint>;
pub fn verify_inclusion(cp: &Checkpoint, index: u64, entry: &[u8], proof: &[[u8; 32]]) -> Result<()>;
pub fn verify_consistency(old: &Checkpoint, new: &Checkpoint, proof: &[[u8; 32]]) -> Result<()>;
pub fn verify_bundle(b: &TlogProof, logs: &[LogKey], policy: &WitnessPolicy,
                     store: &dyn CheckpointStore) -> Result<BundleVerdict>;
pub enum BundleVerdict { Verified(VerifiedEntry), WitnessedOnly(VerifiedEntry) }
pub async fn prove_inclusion(f: &dyn TileFetcher, cp: &Checkpoint, index: u64) -> Result<Vec<[u8; 32]>>;
pub async fn prove_consistency(f: &dyn TileFetcher, old: u64, new: &Checkpoint) -> Result<Vec<[u8; 32]>>;
pub async fn update(f: &dyn TileFetcher, log: &LogKey, policy: &WitnessPolicy,
                    store: &dyn CheckpointStore) -> Result<Checkpoint>;
pub async fn fetch_entry(f: &dyn TileFetcher, cp: &Checkpoint, index: u64) -> Result<Vec<u8>>;
```

The verification core (`verify_*`, note and cosignature parsing, RFC 6962 math) is `#![no_std]` + `alloc` and `#![forbid(unsafe_code)]`, so `boot` and `vouch` can embed it. Async helpers sit behind the `fetch` feature.

#### 4.9.2 Proofs from tiles

**Tile coordinates** (C2SP tlog-tiles, height `h = 8`, width `w = 256`):

- Level-0 hashes are leaf hashes. A tile at tile-level `L` and index `N` holds up to 256 consecutive hashes of tree level `8·L`, namely the hashes of nodes `(8·L, 256·N … 256·N + 255)`.
- A **full tile** has 256 hashes; a **partial tile** of width `W` (1..255) exists only at the right edge and is addressed as `.p/<W>`.
- Path encoding of `N`: groups of three decimal digits, each but the last prefixed with `x`, separated by `/` (for example `N = 1234067` → `x001/x234/067`), as specified by tlog-tiles.
- Entry bundles use the same index and width rules for level-0 entries.

**Node hash lookup** for node `(ℓ, n)` in a tree of `size` leaves:

```
node(ℓ, n, size):
  if (n+1)·2^ℓ ≤ size:                       # subtree complete
     if ℓ mod 8 = 0:
        L := ℓ/8; N := ⌊n/256⌋; i := n mod 256
        return tile(L, N, width_for(L, N, size))[i]
     else:                                    # inside a tile: hash children from the tile below
        return H(0x01 ‖ node(ℓ-1, 2n, size) ‖ node(ℓ-1, 2n+1, size))
  else:                                       # right edge, incomplete subtree
     k := largest power of two < remaining leaves under (ℓ, n)
     return RFC 6962 MTH over the leaves [n·2^ℓ, size) split at k (computed from complete children)

width_for(L, N, size) := min(256, ⌊size / 2^(8L)⌋ − 256·N)     # 256 for full tiles
```

Hashes at levels that are not multiples of 8 are recomputed from the level below inside the same tile, so a proof touches at most one tile per tile-level along the path plus the right-edge partial tiles.

**Proofs:**
- `inclusion(index, size)`: RFC 6962 audit path `PATH(index, D[size])`; each sibling is `node(ℓ, n, size)` for the complete sibling subtree, or the right-edge MTH.
- `consistency(m, size)`: RFC 6962 `PROOF(m, D[size])` = `SUBPROOF(m, D[size], true)` with the same node lookup.

Typical cost: ≤ 3 tile fetches per proof for trees up to 2^24 leaves; fetched tiles are cached by the `TileFetcher` (full tiles forever, partial tiles until a larger one supersedes them).

#### 4.9.3 Note and cosignature parsing

- Notes per C2SP `signed-note`: body lines, a blank line, signature lines `— <name> <base64(key hash ‖ signature)>`; key hash = first 4 bytes of SHA-256(name ‖ 0x0A ‖ 0x01 ‖ public key) for Ed25519 keys.
- Cosignatures per C2SP `tlog-cosignature`: signature algorithm byte `0x04` (timestamped Ed25519), signature over `cosignature/v1\ntime <t>\n<body>`; `t` is returned with the verified checkpoint.
- Unknown signature lines are ignored (they may belong to other witnesses); a checkpoint needs the log's signature and `threshold` cosignatures from distinct policy witnesses.

### 4.10 Retention and availability

- Logs keep every entry forever; tiles are served from an object store replicated across at least two regions behind a CDN.
- Frozen logs stay readable indefinitely.
- Witnesses keep their checkpoint history forever (a few kilobytes per day per origin).
- The project publishes daily signed archives of each log (`tar` of all full tiles and bundles plus the day's last cosigned checkpoint) so third parties can mirror the logs completely.

### 4.11 Sequencer durable state

| redb table | Key | Value |
|---|---|---|
| `meta` | `"size"`, `"root"`, `"checkpoint"`, `"cosignatures"`, `"auth_serial"` | current values |
| `dedup` | `SHA-256(entry)` (32 B) | index (u64) |
| `pending` | acceptance sequence (u64) | entry bytes, accepted time, submitter key ID |
| `streams` | stream name | highest `seq` integrated (releases log only) |
| `rate` | key ID | token-bucket state |
| `published` | `(level, N)` | width last published (to resume partial-tile publication) |

**Acceptance is durable.** `POST /add` writes the entry into `pending` and `dedup` in one redb transaction before integrating. The HTTP response (with `index`) is sent only after the integration that includes the entry is durably committed and its checkpoint published. An acknowledged entry is therefore never lost.

**Rate limiting.** One token bucket per authorised key: refill 100 tokens/s, capacity 1 000. A batch costs one token per entry. Exhaustion returns `429` with `Retry-After` in seconds.

### 4.12 Witness state

Per origin, the witness stores in its state directory (an append-only file per origin plus an index):

```
<stateDir>/<origin hash>/history.log      lines: "<size> <base64 root> <unix time> <base64 log signature line>"
<stateDir>/<origin hash>/latest            the latest cosigned checkpoint note with the witness's cosignature line
<stateDir>/<origin hash>/evidence/<n>.json conflicting notes (JSON array of full note texts) and the request that revealed them
```

`latest` is written with write-to-temp + `fsync` + `rename` + directory `fsync` before the cosignature is returned (REQ-TLOG-011).

### 4.13 Monitor state machine

```
for each log:
  state := (size, root, cursor) persisted
  loop every 10 s:
    cp := verify_checkpoint(fetch /checkpoint)                          # log key + witness policy
    if cp.size < state.size or (cp.size = state.size and cp.root ≠ state.root): alert log-inconsistency
    verify consistency(state → cp) from tiles; on failure alert log-inconsistency
    for idx in state.cursor .. cp.size: entry := fetch_entry(idx); apply rules (§4.8)
    state := (cp.size, cp.root, cp.size); persist
  every 5 min: query each witness GET /checkpoint/<origin hash>; alert witness-silence or witness-evidence
```

The monitor keeps derived indexes (per `(drv, output)` the first generation digest seen; per generation digest the set of attesting operators; per stream the last `seq`, `floor` and revocation serial; per catalog entry the last `latest`) to evaluate the rules in O(1) per entry.

Catalog loop (when configured): every 10 min fetch the catalog TUF target; if its version is new, evaluate §4.8.1 for every entry against the realisations index, then persist the catalog version.

### 4.14 Client checkpoint store (reference implementation)

`keylos-tlog-client` ships `FileCheckpointStore`, used by `courier`, `vouch` (mobile build) and the CLI:

```
<dir>/<origin hash>.json  = {"schema":"keylos.tlog.store/1","origin":…,
                             "ring":[{"note":"<full note text>","consistencyFromPrev":["<base64>"…]}…]}   (≤ 64 entries)
```

Writes are atomic (temp + rename). The file is local state of the calling component and is never exchanged; `keylos.tlog.store/1` is tlog-owned and read only by this library.

### 4.15 Operational procedures

**Log key rotation:**
1. create the new origin's key in the HSM and the new log's empty state;
2. publish the new origin in `logs.json` (TUF, courier-owned) with state `active`, the old one still `active`;
3. switch submitters (rebuilders, release engineering) to the new origin;
4. set the old log `frozen: true`; publish its final checkpoint; wait until every listed witness has cosigned it;
5. publish `logs.json` with the old origin `frozen`.

**Witness onboarding:** the operator generates a note key, starts the witness with both keylos origins, and obtains initial checkpoints by calling `/add-checkpoint` with old size 0 for each log. The witness becomes eligible for the threshold only after release engineering adds its key to `rebuilders.json`.

**Authorisation update:** release engineering signs a new `keylos.logauth/1` with a higher `serial`; deployment tooling places it at `authorisationFile`; the sequencer reloads it on `SIGHUP` and logs the applied serial.

### 4.16 Wire examples

**Checkpoint note** (releases log, two witness cosignatures):

```
log.keylos.org/releases
48211
v2c7mN8o3iC2b0w1pYv9b3Z5r6qWJm2zL0dX4u1K8hA=

— log.keylos.org/releases Az3grlgtzhC2f8E…
— witness-1.example.org JWoQ5d4AAAAAZwd8…
— witness-2.example.net 4fG0YgAAAABnB3x…
```

Body: origin, decimal size, base64 root, then optional extension lines (the keylos logs use none). Every signature line starts with `—` (U+2014), a space, the key name, a space, and base64 of the 4-byte key hash followed by the signature (64 bytes for Ed25519; 8-byte timestamp + 64 bytes for cosignatures).

**`POST /add` request and response:**

```
POST /add HTTP/1.1
Host: log.keylos.org
Content-Type: application/vnd.dsse.envelope.v1+json

{"payloadType":"application/vnd.keylos.release+json; version=1","payload":"eyJmbG9vciI6…","signatures":[{"keyid":"key:sha256:…","sig":"…","alg":"ed25519"}]}

HTTP/1.1 200 OK
Content-Type: application/json

{"index":48210,"checkpoint":"log.keylos.org/releases\n48211\nv2c7…\n\n— log.keylos.org/releases Az3g…\n— witness-1.example.org JWoQ…\n"}
```

Error bodies are `{"error":"<code>","detail":"<text>"}` with codes `malformed`, `non-canonical`, `bad-signature`, `unauthorised`, `rule:<name>` (for example `rule:release-seq`), `too-large`, `rate-limited`, `overloaded`, `frozen`.

**`POST /add-checkpoint` (witness):**

```
POST /add-checkpoint HTTP/1.1
Content-Type: text/plain; charset=utf-8

old 48190
nT1…base64 hash…
q8Z…base64 hash…

log.keylos.org/releases
48211
v2c7mN8o3iC2b0w1pYv9b3Z5r6qWJm2zL0dX4u1K8hA=

— log.keylos.org/releases Az3grlgtzhC2f8E…

HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8

— witness-1.example.org JWoQ5d4AAAAAZwd8…
```

### 4.17 Reference deployment

| Component | Placement | Notes |
|---|---|---|
| Sequencer (one per log) | Two hosts in active/passive with a replicated redb volume; only the active host holds the HSM session | Failover fences the old host by revoking its HSM session before the new one signs |
| HSM | Network HSM with per-log key, Ed25519 support, `CKA_SENSITIVE` and `CKA_EXTRACTABLE=false` | Separate partitions for realisations and releases |
| Object store | S3-compatible, versioning off, two regions, CDN in front | Full tiles immutable; partial tiles and checkpoint short TTL |
| Witnesses | Separate organisations and infrastructure; each with its own key | ≥ 4 listed, threshold 2 |
| Monitors | Project-run monitor + public instructions for third parties | Feed published |
| Index | Stateless replicas over a shared read-only database built by a follower | Untrusted by design |

All hosts run the keylos `server` profile; services are tier-0 with Landlock limited to their state directories and egress only to the object store, the HSM, peers and witnesses.

### 4.18 Consumer integration

| Consumer | Uses | Inputs it supplies | Verdict handling |
|---|---|---|---|
| `courier` (machine) | `update`, `verify_bundle`, `verify_inclusion` for release statements and realisation attestations | Log keys and witness policy from its verified TUF targets; a `FileCheckpointStore` under `/var/lib/courier/logs/` | Requires `Verified` online; accepts `WitnessedOnly` for offline `.klb` hand-offs and re-verifies later |
| `vouch` (phone) | `verify_bundle` for release statements in VBU; personal witness for release and ledger origins | Keys pinned at pairing plus TUF-updated keys; mobile `CheckpointStore` | `WitnessedOnly` shown as amber when the phone has been offline for > 7 days |
| `forge-rebuilder` | `tlog submit`, `prove_inclusion` | Its log URL; witness policy from its config | Stores bundles next to published attestations |
| `fleet` | Witness cosigning of machine ledger checkpoints (`LedgerWitness`) | The machine ledger origin key from enrolment | Conflicts raise `fleet` alerts |
| `fleet` (cloud nodes) | `verify_cloudimage` for the image a cloud node reports booting (REQ-TLOG-025) | Release-log key and witness policy from its verified TUF targets | A node whose image has no included, bound record is not attested |
| `ledger` tooling (`ledger export --verify`) | `verify_checkpoint`, `verify_consistency` for exported ledger segments | The machine's ledger key | Inconsistency is reported as tampering |

The library never decides policy: it returns typed verdicts and errors (`BadLogSignature`, `InsufficientCosignatures{have, need}`, `InclusionMismatch`, `Inconsistent{stored, presented}`, `UnknownOrigin`), and callers map them to their own reason codes.

### 4.19 Limits and encodings

| Item | Limit or encoding |
|---|---|
| Entry size | ≤ 61 440 bytes (DSSE JSON as submitted, UTF-8, no BOM) |
| Batch | ≤ 256 entries and ≤ 8 MiB per `POST /add-batch` |
| Origin line | ≤ 255 bytes, printable ASCII without spaces |
| Checkpoint extension lines | none in the keylos logs; clients MUST ignore unknown extension lines but include them in the signed body |
| Tree size | u64; tile index paths support sizes up to 2^63 |
| Entry bundle | concatenation of `uint16` big-endian length + entry bytes, 256 entries for full bundles |
| Hash tiles | concatenation of 32-byte hashes, 256 per full tile |
| Timestamps in cosignatures | unix seconds, u64 big-endian inside the signed message |
| JSON in APIs | UTF-8, no trailing data; unknown fields in requests rejected |

### 4.20 Interaction with the ledger

`ledger` (on each keylos machine) produces C2SP checkpoints for its local receipt tree (protocols §13.3) and offers them to witnesses through `LedgerWitness`. The `vouch` phone and `fleet` witnesses use this repository's verification core and cosignature format, but the ledger is not served as tiles: witnesses receive the checkpoint and the consistency proof from `LedgerWitness.pending` and return a cosignature line. A ledger origin is `keylos-ledger/<machine key>`; ledger checkpoints carry the extension line `counter <n>`, which this library treats as an opaque extension line.

---

## 5. Interfaces

### 5.1 HTTP APIs

| Service | Endpoint | Request | Response |
|---|---|---|---|
| sequencer | `POST /add` | DSSE JSON body | `200 {"index": n, "checkpoint": "<note>"}`; `400 {"error": "<rule>"}` malformed or rule failure; `403` unauthorised; `409 {"index": n}` duplicate (with the existing index); `413` too large; `429` rate limit (Retry-After); `503` overloaded (Retry-After) |
| sequencer | `POST /add-batch` | JSON array of DSSE entries (≤ 256) | JSON array of per-entry results in the same shapes |
| sequencer (static) | `GET /checkpoint`, `/tile/…`, `/tile/entries/…` | — | tlog-tiles |
| witness | `POST /add-checkpoint` | tlog-witness body | tlog-witness responses (§4.5) |
| witness | `GET /checkpoint/<origin hash>` | — | Latest cosigned checkpoint note for the origin |
| witness | `GET /evidence/<origin hash>` | — | JSON array of conflicting signed notes |
| index | `GET /lookup/drv/<hex>`, `/lookup/gen/<hex>`, `/lookup/release/<stream>/<seq>` | — | JSON (§4.7) |
| monitor | `GET /alerts.json` | — | Alert feed (§4.8) |

`<origin hash>` is the lowercase hex SHA-256 of the origin line. All services use TLS 1.3 (rustls) and HTTP/1.1 + HTTP/2. Rate limits per authorised key: 100 entries/s sustained, burst 1 000.

### 5.2 CLI `tlog`

Exit codes: `0` verified or ok, `1` verification failed, `2` usage, `6` unavailable.

| Command | Description |
|---|---|
| `tlog checkpoint <log-url> --log-key KEY --witnesses FILE` | Fetch and verify the current checkpoint |
| `tlog get <log-url> <index> --log-key KEY --witnesses FILE` | Fetch an entry with inclusion verification |
| `tlog prove <log-url> <index> --log-key KEY --witnesses FILE -o FILE` | Write a `keylos.tlogproof/1` bundle |
| `tlog verify-bundle FILE --log-key KEY --witnesses FILE [--store DIR]` | Offline verification |
| `tlog consistency <log-url> <old-size> --log-key KEY` | Verify consistency from a size to the current checkpoint |
| `tlog submit <log-url> FILE` | Submit an entry (rebuilders, release engineering) |
| `tlog witness-status <witness-url> <origin>` | Show the witness view |
| `tlog monitor --config FILE` | Run a monitor in the foreground |

`--witnesses FILE` is a JSON file `{"witnesses": ["<note verifier key>"…], "threshold": 2}`; the CLI never fetches TUF itself.

Examples:

```
$ tlog checkpoint https://log.keylos.org/releases --log-key "$RELEASES_KEY" --witnesses witnesses.json
origin    log.keylos.org/releases
size      48211
root      v2c7mN8o3iC2b0w1pYv9b3Z5r6qWJm2zL0dX4u1K8hA=
cosigned  witness-1.example.org, witness-2.example.net (2/2 required)

$ tlog prove https://log.keylos.org/realisations 1201 --log-key "$REAL_KEY" --witnesses witnesses.json -o zlib.tlogproof.json
$ tlog verify-bundle zlib.tlogproof.json --log-key "$REAL_KEY" --witnesses witnesses.json --store ~/.local/state/tlog
verified  log.keylos.org/realisations #1201 (WitnessedOnly: offline)
```

### 5.3 Server configuration

Sequencer (`/etc/tlog/sequencer.json`, rendered from Nickel):

```nickel
{
  sequencer | {
    origin | String,
    listen | String | default = "[::]:8443",
    objectStore | { endpoint | String, bucket | String, region | String | optional },
    hsm | { module | String, slot | Number, keyLabel | String },
    authorisationFile | String,         # keylos.logauth/1 DSSE, refreshed by deployment tooling
    authorisationVerifier | String,     # key that signs the authorisation document
    witnesses | Array { url | String, verifier | String },
    batchMaxEntries | Number | default = 256,
    batchMaxDelayMs | Number | default = 500,
    maxEntryBytes | Number | default = 61440,
    frozen | Bool | default = false,
  }
}
```

Witness: `{ listen, key (HSM or file with mode 0400), logs: [{origin, verifier}], stateDir, rateLimitPerOrigin }`.
Monitor: `{ logs: [{origin, url, verifier}], witnesses, threshold, tufRepository, catalog: {target: "catalog.json", intervalSecs: 600} | null, sinks: [{kind: "webhook"|"email", target}], stateDir }`.

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| Log operator forks the log (split view) | Witness threshold; witnesses refuse inconsistent checkpoints and keep evidence; clients persist checkpoints; personal witnesses in `vouch` |
| Log key compromise | HSM; rotation by new origin; old log frozen and witnessed; active/frozen list in TUF |
| Witness collusion with the log | Threshold of independent witnesses; personal witnesses; public monitors |
| Malicious entries | Logs judge only format and signer; clients verify content; monitors flag anomalies |
| Spam / DoS | Submitter authorisation, per-key rate limits, size limits |
| Tile tampering at a CDN | Clients verify every hash against signed checkpoints |
| Rollback of a client's view | Persisted checkpoints; consistency required |
| Index lies | Clients verify inclusion and content (REQ-TLOG-023) |
| Release `seq` replay | Sequencer enforces strictly increasing `seq` per stream; monitor double-checks |
| Targeted withholding (log serves a stale checkpoint to one client) | Clients compare with witnesses' latest cosigned checkpoints (`GET /checkpoint/<origin hash>`) when online; `vouch` compares with the checkpoints it has seen |

### 6.2 Attack walk-throughs

**Targeted backdoored release.** An attacker who controls the release key and the log wants one victim to install a malicious OS release without anyone else seeing it.
1. To be installable, the release statement must be included in a checkpoint cosigned by ≥ 2 witnesses (courier, protocols §11.5).
2. Witnesses cosign only checkpoints consistent with what they have already cosigned, so the malicious entry must be in the same history everyone sees, or the attacker must fork while keeping witnesses unaware, which needs ≥ 2 colluding witnesses.
3. If the entry is in the shared history, monitors see a release whose `osGen` lacks a rebuilder quorum (`release-without-quorum`) or a realisation mismatch, and raise an alert.

**Silent rebuilder collusion.** k operators sign attestations for a malicious binary built from benign source. The attestations are public; any independent rebuilder or monitor that rebuilds the `drv` and gets a different digest publishes a `keylos.mismatch/1` report and the monitor raises `mismatched-realisation` once a conflicting realisation is logged.

**Freeze.** A network attacker serves an old checkpoint to a client. The client's stored checkpoint is newer, so the old one is accepted only as consistent history and never as "current"; freshness itself is courier's TUF timestamp role.

### 6.3 Residual risks

- A coalition of the log operator and `threshold` witnesses can show a client a forked view until the client talks to an honest witness, monitor or its own `vouch` phone.
- Logs prove publication, not correctness; source-level backdoors (xz class) are outside what logs can detect.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| Sequencer crash after the durable commit, before publishing | Restart re-publishes tiles, bundles and the checkpoint from durable state |
| Sequencer crash before the durable commit | Pending entries are integrated again; submitters retry and get `409` with the index for duplicates |
| Object store unavailable | `POST /add` returns `503`; the pending queue persists up to 10 000 entries |
| HSM unavailable | No new checkpoints; submissions queue up to the limit, then `503` |
| Witness unavailable | Checkpoint published with fewer cosignatures; clients ask other witnesses; `witness-silence` alert |
| Witness disk loss | The witness refuses all requests for affected origins until an operator re-seeds it from its last backup of `history.log`; it never cosigns a size smaller than the re-seeded size |
| CDN serves a stale checkpoint | Clients compare with witnesses' latest cosigned checkpoints when online; stale views never pass consistency checks against newer stored checkpoints |
| Authorisation document expired or missing | Sequencer keeps the last applied document and alerts; it never accepts entries from keys absent from every applied document |
| Monitor falls behind | Lag alert; monitor catches up from tiles without data loss (logs are append-only) |
| Client offline | Bundles verified against stored checkpoints (`WitnessedOnly` when not equal to one) |

---

## 8. Performance budgets

| Item | Budget |
|---|---|
| Sequencer integration latency | ≤ 2 s p99 |
| Throughput | ≥ 1 000 entries/s sustained |
| Inclusion proof construction (client, online) | ≤ 3 tile fetches typical; ≤ 300 ms at 50 ms RTT |
| Bundle verification (client) | ≤ 2 ms per bundle on reference hardware |
| Witness cosign | ≤ 50 ms per checkpoint excluding network |
| Monitor lag | ≤ 1 min behind the log head |

---

## 9. Observability

### 9.1 Metrics

- Sequencer: `tlog_tree_size`, `tlog_integrate_seconds` (histogram), `tlog_queue_depth`, `tlog_rejected_total{reason}`, `tlog_cosignatures{witness}`, `tlog_publish_seconds`.
- Witness: `witness_cosign_total{origin}`, `witness_conflicts_total`, `witness_request_seconds`.
- Monitor: `monitor_alerts_total{rule}`, `monitor_lag_entries`, `monitor_catalog_version`, `monitor_catalog_entries_checked_total`.
- Index: `index_lookups_total`, `index_lag_entries`.

### 9.2 Operational alerts

| Alert | Threshold |
|---|---|
| Integration latency | p99 > 2 s for 5 min |
| Queue depth | > 5 000 pending entries |
| Cosignatures on the published checkpoint | < `witnessThreshold` for 2 consecutive checkpoints |
| Monitor lag | > 1 000 entries or > 5 min |
| Witness conflicts | any |
| HSM errors | any signing failure |

### 9.3 Logs and receipts

Structured log records go to the journal (keylos `server` profile). These services are not keylos machine services with ledger writers, so they write no receipts.

---

## 10. Configuration

Server configuration is in §5.3. Client-side configuration belongs to the consumers: `courier` and `vouch` pass log keys and witness policies taken from the courier-owned TUF targets `logs.json` and `rebuilders.json`; `forge-rebuilder` takes its log URL from forge configuration.

---

## 11. Testing and acceptance

### 11.1 Unit and property

- RFC 6962 test vectors; C2SP signed-note, cosignature and tlog-tiles path vectors.
- Proof construction from tiles for every size 1..1025 and for random sizes up to 2^24, compared with a naive in-memory tree.
- Property: random append sequences; every pair of checkpoints consistent; inclusion for every leaf.
- Entry rules: valid and invalid realisation, bootstrap, ddc and release payloads (wrong subject name, missing `output`, decreasing `seq`, `floor` > `seq`, unauthorised stream).

### 11.2 Integration scenarios

| # | Scenario | Expected |
|---|---|---|
| 1 | Sequencer + 3 witnesses + monitor; submit 100 000 entries in batches | all integrated; every `POST` answered with its index; checkpoints cosigned by 3 |
| 2 | Kill the sequencer at 50 random points during scenario 1 | no fork; no acknowledged entry missing; duplicates answered `409` with the original index |
| 3 | Submit the same release statement twice | second gets `409` |
| 4 | Release statement with `seq` equal to the last | `400 release-seq` |
| 5 | Witness given a checkpoint of the same size and a different root | `409`; evidence stored; monitor raises `witness-evidence` |
| 6 | Sequencer test build that forks | witnesses refuse; client `update` fails with an inconsistency error |
| 7 | Bundle verification offline: equal to stored / witnessed only / under threshold | `Verified` / `WitnessedOnly` / error |
| 8 | Log key rotation procedure | both origins verifiable; frozen log rejects `POST /add` with `403` |
| 9 | Two realisations for one `(drv, output)` with different digests | monitor `mismatched-realisation` |
| 10 | Index returns a wrong index | client detects content mismatch; returns not-found |
| 11 | Release statement with a top-level `recovery` object, or a profile missing `enter-recovery` in `pcr11` | `400 rule:release-recovery-object` / `400 rule:release-profile` |
| 12 | Catalog entry marked `reviewed-reproducible` with `quorum: "3/3"` while only 2 operators attested `latest.generation` | monitor `catalog-reviewed-without-quorum` and `catalog-quorum-claim` |
| 13 | Catalog version whose entry `latest.version` goes 2.5.0 → 2.4.9 | monitor `catalog-version-regression` |
| 14 | Cloud image record for a `seq` not yet logged; then after the release statement | `400 rule:cloudimage-release`; then accepted |
| 15 | Cloud image record whose `ukiSha256` differs from the release's `profiles.cloud.uki.sha256` | `400 rule:cloudimage-binding` |
| 16 | Release statement whose `desktop` profile carries `pcr11Seed`, or whose profile lacks `recoveryGen` | `400 rule:release-seed` / `400 rule:release-profile` |

### 11.3 Fuzz targets

`note_parse`, `cosig_parse`, `tile_parse`, `bundle_parse`, `proof_bundle`, `dsse_entry`, `release_rules`, `cloudimage_rules`, `witness_request`, `catalog_rules`.

### 11.4 Acceptance criteria

- All of §11.1–§11.3 pass in CI.
- Interoperability: an independent C2SP tlog-tiles client implementation verifies checkpoints, inclusion and consistency on the same log.
- Budgets of §8 met on the reference deployment.
- protocols `vectors/tlogproof`, `vectors/release` and `vectors/cloudimage` pass.
- Every REQ-TLOG requirement mapped to a test in `tests/REQUIREMENTS.md`.

---

## 12. Implementation notes

| Need | Crate |
|---|---|
| HTTP | `hyper` 1.x, `axum` 0.8, `rustls` 0.23 |
| Ed25519 | `ed25519-dalek` 2.x |
| HSM | `cryptoki` |
| Durable state | `redb` 2.x |
| Object store | `object_store` (S3-compatible) |
| Hashing | `sha2` 0.10 |
| JSON/JCS/DSSE | `keylos-formats` |

Module structure of `keylos-tlog-client`:

| Module | Content |
|---|---|
| `note` | Signed-note parsing and Ed25519 note verification |
| `cosig` | `cosignature/v1` verification and timestamp extraction |
| `merkle` | RFC 6962 hashing, inclusion and consistency verification |
| `tiles` | Tile coordinates, path encoding, node lookup, proof construction |
| `bundle` | `keylos.tlogproof/1` parsing and verification |
| `store` | `CheckpointStore` trait and `FileCheckpointStore` |
| `fetch` (feature) | Async `TileFetcher` helpers over any HTTP transport |

Layout:

```
tlog/
  crates/keylos-tlog-client/   verification core (no_std + alloc) + async helpers
  crates/tlog-sequencer/ tlog-witness/ tlog-monitor/ tlog-index/ tlog-cli/
  vectors/  fuzz/
  deploy/                      reference deployment for the keylos server profile
```

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reference |
|---|---|---|
| C2SP tlog-tiles static logs | Dynamic proof APIs; Rekor v1 | [ADR-0016](../../handbook/11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md) |
| Witness threshold from TUF metadata supplied by callers | Trust the log operator | [ADR-0016](../../handbook/11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md) |
| Separate realisations and releases logs; release statements are the release-log entries | One log for everything; separate release-log entry format | [ADR-0016](../../handbook/11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md) |
| Proof bundles for offline verification | Online-only verification | [ADR-0017](../../handbook/11-decisions/adr-0017-tuf-over-oci.md) |
| Personal witnesses in `vouch` | Rely only on public witnesses | [ADR-0015](../../handbook/11-decisions/adr-0015-verify-before-unlock.md) |
| Catalog review claims checked publicly against the realisations log | Trust the catalog role alone | [ADR-0016](../../handbook/11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md) |
| Recovery is a UKI profile phase; release statements carry no `recovery` object | Separate recovery UKI with its own release entry | [ADR-0014](../../handbook/11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md) |
