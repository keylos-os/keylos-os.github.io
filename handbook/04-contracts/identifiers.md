# Identifiers

> Every object in keylos has a canonical text form and binary form. Digests name files and generations by content. Typed refs say what kind of thing a digest names. Principal IDs say who acts, for whom, and through which delegation chain.
> All of them are case-sensitive, lowercase-hex and parse with `keylos-ids`.

**Status:** specified (v1.0) · **Normative source:** [protocols §3](../../specs/protocols/spec.md#3-identifiers)

## Digests

| Algo | Computed over | Used for |
|---|---|---|
| `sha256:` | Raw bytes | Sources, documents, blobs that aren't store files, key IDs |
| `fsv256:` | fs-verity file digest (SHA-256, 4096-byte blocks, no salt), exactly what `FS_IOC_MEASURE_VERITY` returns | Every store object and every generation image |
| `sha512:` | Raw bytes | Only where an external format requires it |

`fsv256` is not the SHA-256 of the file contents. It is the digest of the fs-verity descriptor, which commits to the Merkle tree root, so the kernel can verify each page lazily on read. `keylos-ids` computes it in userspace for files that don't have verity enabled yet.

## Typed references

`<kind>:<algo>:<hex>`

| Kind | Names | Example |
|---|---|---|
| `obj` | A store object | `obj:fsv256:4be1…` |
| `gen` | A generation (EROFS composefs image) | `gen:fsv256:3f9a…` |
| `src` | A source input (canonical git tree tar stream or archive) | `src:sha256:91c0…` |
| `drv` | A derivation (JCS JSON) | `drv:sha256:0d2e…` |
| `rcpt` | A ledger receipt (DSSE envelope bytes) | `rcpt:sha256:aa71…` |
| `key` | A public key (SPKI DER) | `key:sha256:5c3f…` |

## Names

| Name | Pattern | Example |
|---|---|---|
| Generation name | Reverse DNS, at least 3 labels, at most 255 characters. `io.keylos.` and `org.keylos.` are reserved | `org.example.Editor` |
| Service name | `[a-z][a-z0-9-]{0,62}` | `portal-files` |
| Username | `[a-z_][a-z0-9_-]{0,31}`, `_system` reserved | `alice` |

Names are for humans and for update channels. Security decisions use digests.

## Principal IDs

```
<actor>@<human>/<session>[/<child-session>…]
```

| Actor | Form |
|---|---|
| App | `app:gen:fsv256:<hex>` |
| Service | `service:<name>:gen:fsv256:<hex>` |
| Agent | `agent:gen:fsv256:<hex>` (the agent-template generation) |
| Legacy | `legacy:gen:fsv256:<hex>` |
| Workbench | `bench:gen:fsv256:<hex>` |
| Shell | `shell` (the human acting directly) |
| Kernel | `kernel` |

Examples:

```
shell@alice/s-01JB6Q8Z0RXQ4M3W9V2N7T5K1C
agent:gen:fsv256:9e1f…@alice/s-01JB6Q…/s-01JB6R…        # a sub-agent of a session
service:vault:gen:fsv256:77aa…@_system/s-01JB5…
```

The session chain records delegation. A child's authority is always a subset of its parent's. At runtime each principal instance maps 1:1 to a (UID, cgroup) pair allocated by warden. `Supervisor.identify` resolves a pidfd to the principal. A VM principal (tier 2 or 3) maps to the cgroup of its VMM process; processes inside the guest are not separate host principals.

## Other identifiers

| ID | Form | Created by |
|---|---|---|
| Session | `s-` + ULID | Spawner (warden if empty) |
| Token root | `t-` + base32 of 16 random bytes | broker |
| Effect intent | `e-` + ULID | gate |
| Transaction | `x-` + ULID | strata |
| Approval | `a-` + ULID | broker |
| Snapshot | `snap-` + ULID | strata |
| Grant record | `g-` + ULID | broker (persistent grants) |
| Config plan | `p-` + ULID | config |
| Seal window | `w-` + ULID | hearth |
| Machine identity key | `key:sha256:…` of the machine's ledger signing key | ledger, at first boot |
| Device | `dev:<subsystem>:<stable path>` | devd |

ULIDs sort by creation time, which makes logs and receipts easy to scan.

## Time

- On the wire: `Timestamp { unixNanos }` in UTC. In documents: RFC 3339 with `Z`.
- The clock is **untrusted until the first NTS sync after boot**. Until then, expiry checks use the **time floor**: the time of the newest ledger checkpoint, served by `LedgerAdmin.timeFloor` (ledger facet `time`). net steps the clock forward to the floor at boot if the RTC is earlier, and never lets it move back past the floor.

## Related

- [Signed documents](signed-documents.md)
- [Capwire](capwire.md)
- [Principals and identity](../06-security/principals-and-identity.md)
- [Names, paths and IDs](../13-reference/names-paths-and-ids.md)
