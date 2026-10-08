# Users and homes

> `hearth` manages the humans on a keylos machine: their records, home subvolumes, login methods and locks. It also manages the FIDO2 credentials that make someone an owner.
> Owner presence (a physical touch over the exact document) is how configuration, seals, persistent grants and policy changes are authorized. No root user, sudo or setuid binary exists.

**Status:** specified (v1.0). Specification: [hearth](../../specs/hearth/spec.md).

## Users

| Field | Meaning |
|---|---|
| `name`, `uid` | Username and human UID (1000–59999), never reused while a tombstone exists |
| `owner` | Owners can approve presence-gated acts |
| `methods` | `password` (passphrase or PIN), `fido2` (security key or phone passkey) |
| `credentials` | Enrolled FIDO2 credentials with COSE public keys |
| `lockOnSuspend` | `screen`, `vault` (default for laptops) or `freeze` |

Records are signed files in `/var/lib/keylos/hearth/users/`. For owners, the **owner registry** is authoritative, not the record.

## Homes

```
/home/alice/                     btrfs subvolume (nosuid, nodev, noexec)
  .apps/<app>/{config,data,cache,state}   one subvolume per app, created on first start
  Documents/ Downloads/ Projects/ …
```

- **noexec everywhere.** Code you build runs in a workbench, or on the host after you seal it ([Workbenches](../09-experience/README.md)).
- **Per-app subvolumes.** Each app has its own snapshots, rollback, backup policy and crypto-shred unit. Uninstalling an app deletes them cleanly.
- **Snapshots and transactions** come from `strata` ([State](README.md)).
- **Encryption.** The whole disk is LUKS2 with authenticated encryption. Where btrfs fscrypt is available, each home also gets a per-user key that is evicted when you lock.

## Logging in

| Method | How | Notes |
|---|---|---|
| Password / passphrase | Typed into `atrium`'s trusted greeter; verified by unwrapping your vault slot (Argon2id) | No separate password hash exists |
| PIN | Same, only with a TPM; failures counted in the TPM NV counter `0x01300106` so a reboot cannot reset the backoff | ≥ 6 digits |
| FIDO2 key | Touch, plus the key's PIN (UV); the key's `hmac-secret` output unlocks your vault slot | USB, NFC |
| Phone | Not a login method in v1.0: hearth has no Bluetooth route for CTAP hybrid transport. The paired phone verifies the machine and can route approvals ([Attestation and vouch](../05-integrity/attestation-and-vouch.md)) | |
| Recovery code | Only in recovery mode or after repeated failures; forces enrolling a new credential | |

**Rate limiting.** 5 failures start an exponential backoff that rises to 5 minutes.

**Login is not presence.** Greeter and screen-unlock assertions use the rpId `keylos.login` and are never accepted as presence signatures, which always use `keylos.owner`. Fingerprint readers can unlock the screen lock only.

**Locking.** Locking the screen keeps apps running. With `lockOnSuspend = vault`, suspend also locks your secrets and freezes your agent sessions before the machine sleeps.

## Owner presence

A FIDO2 authenticator cannot sign arbitrary documents. It signs `authenticatorData || clientDataHash`. keylos sets `clientDataHash = SHA-256(DSSE-PAE(document))`, so the touch binds exactly the document shown on the trusted path. The result is a normal DSSE envelope with signature algorithm `fido2-es256` or `fido2-eddsa`, which every verifier checks with the `keylos-presence` crate.

| Purpose | Document signed |
|---|---|
| Apply configuration | `keylos.configgen/1` (verified again by `boot` at the next start) |
| T3 approval / persistent grant | `keylos.mandate/1` |
| Open a sealing window | `keylos.seal-window/1` |
| Change owners or credentials | `keylos.owners-entry/1` |
| Vault backup and restore, ledger alarm acknowledgement, update pins | `keylos.presence/1` |

## Sealing windows

Sealing your own code needs your owner-seal key (`0x81000140+i`), which lives in the TPM. Its only policy is `PolicySecret` on your NV **seal gate** (`0x01300140+i`), so each use requires the gate's current authorization value:

1. One touch opens a window (`HearthSeal.openWindow`): at most 600 s, one project, a listed set of derivations, recorded as a presence-signed `keylos.seal-window/1`. The same assertion's `hmac-secret` output, with two salts, returns the current gate value and the next one.
2. During the window `hearth` signs only in-scope seal statements.
3. Closing the window changes the gate's authorization to the next value. A captured old value is then useless, and the value after that needs another touch.

Each owner has their own seal key and gate by default ([ADR-0012](../11-decisions/adr-0012-sealing-windows.md)).

## The owner registry and recovery

- **Format.** The registry is a hash-chained log of owner and credential changes. Every entry is signed by existing owners (quorum configurable).
- **Anchoring.** Its head (last-entry digest, sequence number, digests of the owner-presence key set and of the owner Secure Boot certificate set) is stored in TPM NV `0x01300105`. `boot` replays the log from `/var/lib/keylos/hearth/owners.log` and requires the computed head to equal the NV value, so it can verify configuration signatures before any service runs ([protocols §20.3](../../specs/protocols/spec.md#203-owner-registry)).
- **Recovery key.** Printed once at install: 64 hex digits in 8 groups of 8, each followed by a CRC-8 ([protocols §20.21](../../specs/protocols/spec.md#2021-recovery-key)). HKDF derives the TPM recovery auth object, the TPM lockout auth, an Ed25519 **recovery signer** recorded in the registry's genesis entry, and an optional backup-escrow wrapping key.
- **Lost every key.** Boot recovery mode, type the recovery key (or reconstruct it from trustee shares), and enrol a new security key. The registry accepts recovery-signed entries (op `recover`) only in recovery mode.

## Presence options

| Mode | Who | How presence works |
|---|---|---|
| Touch (default) | `desktop`, `laptop`, `kiosk` owners | A FIDO2 assertion over the document's PAE hash, on the trusted path |
| Assisted | Owners who can't operate a roaming key | hearth's TPM-backed platform authenticator: confirm with pointer, keyboard or switch access inside the atrium prompt, PIN as user verification. Enrolled with `assisted: true`; shown in status and in every prompt. Policy may forbid it per purpose (`config.presence.assistedAllowed`) |
| Quorum | `server`, `server-k8s`, `cloud`, `appliance`, managed machines | `policy.mode = "quorum"`: at least N distinct owners sign remotely ([ADR-0048](../11-decisions/adr-0048-quorum-presence.md)) |

## Guests and families

| Situation | Behaviour |
|---|---|
| **Guest session** | Username `guest-<8 base32>`. `StrataHomes.createEphemeralHome` creates a home that is never snapshotted, with an ephemeral unit key; both are destroyed at logout. Guests get no presence-class grants, no persistent grants, and no agent sessions unless `hearth.guest.agents` is true |
| **Family member (non-owner)** | Can use apps, workbenches and agents within their own grants. Requests that need an owner (config proposal, seal, persistent grant, policy change, installing an unreviewed app) become approval prompts to the owners with `requester` set, shown on the next owner trusted-path session or routed to an owner's phone. A phone approval never satisfies presence |
| **Kiosk** | Autologin to one app principal; the trusted path stays available for owner administration |

## Trustees and inheritance

- **Trustee shares.** The recovery key's 32-byte secret can be split into *n* Shamir shares with threshold *k* (2 ≤ k ≤ n ≤ 16), printed as cards with a QR code and a check value ([protocols §20.19](../../specs/protocols/spec.md#2019-trustee-shares-and-inheritance)). Splitting needs presence (purpose `trustee.split`). Old shares are revoked by rotating the recovery key.
- **Inheritance note** (optional). An encrypted note to the trustees is held by the owner's paired phone. If no owner login heartbeat arrives for the configured number of days (at least 30), the phone releases the note. The note never contains a key: trustees still need *k* shares.

## Managing users

| Task | Command |
|---|---|
| Add a user (owner touch) | `hearth add bob --display "Bob"` |
| Add a security key | `hearth enroll --kind fido2 --label "Spare key"` |
| Add an assisted authenticator | `hearth enroll --kind platform --assisted` |
| Split the recovery key for trustees (touch) | `hearth trustees split --k 2 --n 3` |
| Switch to quorum presence (owners' quorum) | `hearth quorum set --threshold 2` |
| Remove a key | `hearth unenroll key:sha256:…` |
| Make someone an owner | `hearth owners add bob` |
| Remove a user and forget their data | `hearth remove bob --forget-data` |
| Check the registry against the TPM | `hearth registry verify` |

## Limitations

- During an open sealing window, malware with tier-0 or kernel access could seal in-scope builds until the window closes. Every seal is receipted and shown.
- Machines without a TPM run a reduced profile: no PIN logins, file-only registry anchoring, and a visible "reduced integrity" status.

## Related

- [Principals and identity](../06-security/principals-and-identity.md)
- [Secrets](../06-security/secrets.md)
- [Trusted path](../06-security/trusted-path.md)
- [ADR-0011 Owner presence](../11-decisions/adr-0011-owner-presence-fido2.md) · [ADR-0023 No root](../11-decisions/adr-0023-no-root-no-setuid.md)
- [hearth spec](../../specs/hearth/spec.md) · [vault spec](../../specs/vault/spec.md)
