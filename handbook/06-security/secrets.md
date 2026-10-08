# Secrets

> `vault` holds every secret and every key whose destruction means "forget". Apps reach their own items through ACLs bound to generation identity. Values arrive as `memfd_secret` descriptors, never as environment variables.
> Agents never see secret values: `gate` injects credentials into their requests, and the vault signs SSH challenges for them. Forgetting is real: an epoch key held in TPM NV is overwritten.

**Status:** specified (v1.0). Specification: [vault](../../specs/vault/spec.md).

## What is wrong with the usual model

| Common practice | Problem | keylos answer |
|---|---|---|
| Secret Service / keyring on the session bus | Once unlocked, any process on the bus can read every item | No session bus. Per-item ACLs keyed to **who the app is** (generation name + publisher key). Per-app UIDs. |
| Tokens in env vars | Leak through `/proc`, child processes, crash reports, logs | `warden` rejects secret-looking env names. Values come as fds. |
| `~/.aws/credentials`, `.netrc`, `.npmrc` | Plaintext readable by every same-user process | `vault import file` converts them, then offers to shred the source |
| Giving an agent your API token | Prompt injection exfiltrates it | Agents get *use* rights only. `gate` adds the credential to the outgoing request. |
| `ssh-agent` forwarding | Root on the remote host can use your keys | Vault SSH agent with per-host key policy (`session-bind`); forwarding denied by default |
| Deleting a secret | Copies survive in snapshots and backups | Crypto-shred with an epoch key in TPM NV |

## Item access

Each item has an ACL of `(actor pattern, operations, prompt policy)`:

| Pattern | Matches |
|---|---|
| `app:name=org.example.Editor;publisher=key:sha256:…` | Every version of that app from that publisher |
| `app:gen:fsv256:…` | Exactly one build |
| `app:name=…;sealed-by=owner` | Your own sealed builds of that app |
| `shell` | You at your terminal |
| `agent:gen:fsv256:…` | An agent template, only for `use` (injection or signing) |
| `service:net` | A system service (for `_system` items such as Wi-Fi) |

| Prompt policy | Behaviour |
|---|---|
| `never` | Silent |
| `perSession` | Ask once per app session |
| `always` | Ask every time |
| `presence` | Ask with a FIDO2 touch every time |

## Delivery

```
app ──vault.open("sync-token")──► vault: ACL ok → decrypt into secret memory
                                   → memfd_secret fd (u64 length ‖ value ‖ padding) ──► app maps it read-only
```

- The page holding the value is removed from the kernel's direct map. `vaultd` cannot dump core.
- secretmem fds can only be read through `mmap`, and can't be sealed. `keylos-vault-client::SecretBuf` maps the fd `PROT_READ`, reads the little-endian u64 length, exposes the bytes, and zeroizes and unmaps on drop ([protocols §20.10](../../specs/protocols/spec.md#2010-secret-delivery-vaultopen)).
- On kernels with secretmem disabled, a `memfd` with the same layout is used, sealed against write, shrink, grow and further sealing; the receipt records `delivery = "memfd-sealed"`.

## Agents and secrets

![Effect outbox: stage, approve, commit](../images/effect-outbox.svg)

1. The agent holds a token with `right("secret", "github-token", "use")` and `net("api.github.com", 443, "https", "*")`.
2. The agent sends its HTTP request through `gate`.
3. `gate` verifies the token and asks `vault` for a single-use **injection handle**, bound to item, host, agent principal and token root, valid 60 s.
4. `gate` redeems the handle, adds the `Authorization` header, sends the request, and wipes the value.
5. The item's `injectHosts` list must include the host. It is empty by default, so the owner must opt in.

SSH works the same way. The vault's per-principal SSH agent signs only for host keys the item allows. New hosts prompt.

## Key hierarchy

| Key | Where it lives | Purpose |
|---|---|---|
| System key KS | TPM-sealed. Policy: signed PCR11, PCR15 volume identity, keystore floor (NV `0x01300104`) | System items (Wi-Fi, VPN), system units |
| Epoch key KE | **TPM NV indices `0x01300110` and `0x01300111`**, alternating active and candidate; the previous one is erased after each rotation | Every wrap depends on it; erasing it destroys old copies |
| User key KU | Wrapped per login slot: password (Argon2id), FIDO2 `hmac-secret`, recovery code | A human's items and units; locked when the human locks |
| Item and unit DEKs | Wrapped under keys derived from KU/KS and KE | One per item or unit |

## Forgetting

`strata` (for data units such as a project or chat) and `ledger` (for receipt bodies) ask the vault for **unit keys**. To forget:

1. The unit's wrapped key is deleted and tombstoned.
2. Within an hour (configurable down to a minute), the vault **rotates the epoch**:
   1. it writes the new epoch key to the *other* NV index and reads it back;
   2. it commits the re-wrapped database together with an authenticated rotation record in one transaction;
   3. it advances the keystore floor;
   4. it erases the previous index and only then reports the forget as complete.

   A power cut at any point leaves either the old key or the new key active, never neither: interrupting an NV write can corrupt only the index being written, and startup reconciles the database, both indices and the floor before serving ([ADR-0059](../11-decisions/adr-0059-two-index-vault-epoch-rotation.md)).
3. Every copy of the old wrap is now useless: snapshots, local backups, old disk blocks. Backups you exported earlier are outside this guarantee; they stay readable with the recovery key.

Forgetting your own data while you are logged out completes the next time you unlock ([ADR-0032](../11-decisions/adr-0032-crypto-shredding.md)).

## Recovery

- At install you get a printed **recovery code**. It decrypts recovery slots and vault backups, and it can enrol new security keys in recovery mode.
- `vault backup` writes an age-encrypted bundle to the recovery recipient. It needs presence and excludes forgotten units.
- The vault keeps daily local backups for 7 days and deletes any that contain a forgotten unit.

## Limitations

- While you are unlocked, a kernel or tier-0 compromise can use your secrets.
- An app you allowed to `read` an item has the value in its memory. ACLs limit *which* apps that is.
- Without btrfs fscrypt, locking protects secrets and crypto-shred units, not ordinary home files. Those rely on full-disk LUKS2 at rest.

## Related

- [Network egress](network-egress.md)
- [Labels and the Rule of Two](labels-and-rule-of-two.md)
- [Users and homes](../08-state/users-and-homes.md)
- [ADR-0039 Secrets never in env](../11-decisions/adr-0039-secrets-never-in-env.md)
- [vault spec](../../specs/vault/spec.md)
