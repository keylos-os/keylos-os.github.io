# Names, paths and identifiers

> Every identifier grammar, filesystem path, socket, extended attribute, TPM index, UID range, cgroup path and environment variable keylos defines, in one place.
> The normative source is [protocols](../../specs/protocols/spec.md). This page is a lookup table that cites it.

## Identifiers

| Identifier | Form | Example | protocols |
|---|---|---|---|
| Digest | `algo:hex` with `sha256`, `sha512`, `fsv256` | `fsv256:3f9a…c01e` | §3.1 |
| Typed reference | `kind:digest` with `obj`, `gen`, `src`, `drv`, `rcpt`, `key` | `gen:fsv256:3f9a…` | §3.2 |
| Store object | `obj:fsv256:<hex>` | | §3.2 |
| Generation | `gen:fsv256:<hex>`, the fs-verity digest of the EROFS image | | §6 |
| Source | `src:sha256:<hex>`, SHA-256 of the canonical tar stream (git trees and normalised archives) | | §3.2, §11.2 |
| Derivation | `drv:sha256:<hex>`, SHA-256 of the JCS bytes | | §11.1 |
| Receipt | `rcpt:sha256:<hex>`, SHA-256 of the DSSE envelope bytes | | §13 |
| Key | `key:sha256:<hex of SPKI DER>` | | §4 |
| Generation name | Reverse DNS, `^[a-z][a-z0-9-]*(\.[a-zA-Z0-9-]+){2,}$`; `io.keylos.` and `org.keylos.` reserved | `org.example.Editor` | §3.3 |
| Service name | `[a-z][a-z0-9-]{0,62}` | `portal-files` | §3.3 |
| Username | `[a-z_][a-z0-9_-]{0,31}`; `_system` and `_cluster` reserved; prefix `guest-` reserved for guest sessions | `alice`, `guest-k3x9p2ma` | §3.3 |
| Principal | `<actor>@<human>/<session>{/<session>}` | `shell@alice/s-01JB6Q8Z0RXQ4M3W9V2N7T5K1C` | §3.4 |
| Pod principal | `pod:<ns>/<name>:<gen ref or oci:sha256:…>@_cluster/<session…>` | `pod:web/api:oci:sha256:9e1f…@_cluster/s-…/s-…` | §3.4 |
| Session | `s-` + ULID | `s-01JB6Q8Z0RXQ4M3W9V2N7T5K1C` | §3.5 |
| Token root ID | `t-` + base32 of 16 random bytes | | §3.5 |
| Effect intent | `e-` + ULID | | §3.5 |
| Transaction | `x-` + ULID | | §3.5 |
| Approval | `a-` + ULID | | §3.5 |
| Snapshot | `snap-` + ULID | | §3.5 |
| Grant record | `g-` + ULID | | §3.5 |
| Config plan | `p-` + ULID | | §3.5 |
| Seal window | `w-` + ULID | | §3.5 |
| Quorum request | `q-` + ULID | | §3.5 |
| Debug grant | `dbg-` + ULID | | §3.5 |
| Pod sandbox (cri) | `pod-` + ULID; the Kubernetes pod UID is metadata | | §3.5 |
| Media session (bench) | `med-` + ULID | | §3.5 |
| Family inbox item (hearth) | `fi-` + ULID | | §3.5 |
| Fleet command | `fc-` + ULID | | §3.5 |
| Machine identity key | `key:sha256:…` of the machine's ledger signing key | | §3.5 |
| Facet | `[a-z][a-z0-9-]{0,31}`; routes written `service#facet` | `vault#app` | §3.3, §19.2 |
| Device | `dev:<subsystem>:<stable path>` | `dev:video4linux:pci-0000:00:14.0-usb-0:5:1.0` | §3.5 |
| Error reason | `kl:<code>[:<ref>] <message>` | `kl:needs-approval:a-01JB… Sending email requires approval` | §7.3.1 |

## Media types

All signed keylos documents use `application/vnd.keylos.<doc>+json; version=<major>` with a matching `schema` field. The full registry is [protocols §19.4](../../specs/protocols/spec.md#194-media-types-and-formats), summarised in [Registries](../04-contracts/registries.md#media-types-and-formats).

| Document | Media type |
|---|---|
| Generation manifest | `application/vnd.keylos.manifest+json; version=1` |
| Generation statement | `application/vnd.keylos.genstmt+json; version=1` |
| Release statement (release-log entry) | `application/vnd.keylos.release+json; version=1` |
| Command signature | `application/vnd.keylos.cmdsig+json; version=1` |
| Receipt | `application/vnd.keylos.receipt+json; version=1` |
| Mandate | `application/vnd.keylos.mandate+json; version=1` |
| Config generation statement | `application/vnd.keylos.configgen+json; version=1` |
| Seal statement, seal window | `application/vnd.keylos.seal+json; version=1`, `application/vnd.keylos.seal-window+json; version=1` |
| Owner registry entry | `application/vnd.keylos.owners-entry+json; version=1` |
| Consent record, owner exception | `application/vnd.keylos.consent+json; version=1`, `application/vnd.keylos.exception+json; version=1` |
| Presence payload, flow proof | `application/vnd.keylos.presence+json; version=1`, `application/vnd.keylos.flowproof+json; version=1` |
| Revocation list | `application/vnd.keylos.revocations+json; version=1` |
| Realisation attestation | `application/vnd.in-toto+json`, predicate `https://keylos.org/realisation/v1` |
| Quorum request | `application/vnd.keylos.quorum+json; version=1` |
| Trustee share, inheritance note | `keylos.trustee/1` (printed card, QR), `keylos.inheritance/1` |
| App catalog | `keylos.catalog/1` (TUF target) |
| Service table, policy reference | `keylos.services/1` (`/etc/keylos/services.json`), `keylos.policyref/1` (`/etc/keylos/policy.ref`) |
| Pod spec (admission input) | `keylos.podspec/1` |
| Pending recovery receipt | `application/vnd.keylos.pendingreceipt+json; version=1` (§20.22) |
| Fleet command, fleet approvers | `application/vnd.keylos.fleet.command+json; version=1`, `keylos.fleetapprovers/1` (§20.23) |
| Cloud image record (release log) | `application/vnd.keylos.cloudimage+json; version=1` (§20.24) |
| Pre-authorized input devices | `keylos.preauth/1` (`/var/lib/keylos/devd/preauthorized.json`, §9.5) |
| OCI conversion descriptor | `keylos.ociconv/1`, algorithm `oci-convert/1` (§21.4) |
| cri uplink object | `keylos.cri.uplink/1` (§21.5) |

## Host filesystem

| Path | Content | Writable by |
|---|---|---|
| `/` and `/usr` | OS generation (composefs, `verity=require`) | nobody |
| `/etc` | Merged config generation (confext) | nobody (config produces new generations) |
| `/var` | btrfs `@var`, `nosuid,nodev,noexec` | services, each in its own directory |
| `/home/<user>` | Per-user btrfs subvolume, `nosuid,nodev,noexec` | the human's principals, through grants |
| `/home/<user>/.apps/<app-name>/{config,data,cache,state}` | Per-app, per-user subvolumes | that app |
| `/store/objects/<2 hex>/<62 hex>` | Store objects with fs-verity, mode 0444 | depot |
| `/store/gens/<64 hex>.erofs` | Generation images | depot |
| `/store/evidence/` | Generation statements, attestations, consent records, owner exceptions | depot |
| `/store/db/` | depot database | depot |
| `/store/rcpt/` | ledger data | ledger |
| `/keystore` | btrfs `@keystore`, never snapshotted | vault, hearth, ledger, strata (wrapped key material) |
| `/snapshots` | btrfs snapshot area | strata |
| `/run/keylos/svc/<svc>/` | Service sockets, mode 0700, owned by warden | warden |
| `/run/keylos/boot/trust.json`, `report.json` | Boot trust set and boot report, mode 0444 | boot |
| `/var/lib/keylos/hearth/owners.log` | Owner registry (presence-signed JSON Lines) | hearth |
| `/var/lib/keylos/firstboot/bundle.json` | First-boot bundle, removed when consumed | installer, then each consumer |
| `/efi` | ESP, mounted only during updates | courier |

## Inside an app's view

| Path | Content |
|---|---|
| `/` | The app generation (with `/usr` from its runtime generation if declared) |
| `/etc` | The app-visible subset of `/etc` (`/etc/keylos/app-visible.list`) |
| `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `$XDG_CACHE_HOME`, `$XDG_STATE_HOME` | The app's `.apps/<name>` subvolumes |
| `/run/user/<uid>/` | The app's Wayland socket (security-context tagged) and, if granted, its PipeWire remote |
| `/tmp` | Private tmpfs |
| `/grants/<name>` | Runtime directory grants: idmapped bind mounts attached by warden (`GrantMounts.attachGrant`) |
| `/proc` | Fresh procfs, `hidepid=invisible,subset=pid` |

## Disk layout

| Partition | Content |
|---|---|
| 1 | ESP, 1 GiB, FAT32: systemd-boot, UKIs (`<name>+<tries>-<done>.efi`), recovery UKI |
| 2 | `keylos-root`: LUKS2 with dm-integrity AEAD (`aegis128`, or `aes-gcm-random` + HMAC-SHA256), btrfs subvolumes `@store`, `@var`, `@home`, `@keystore`, `@snapshots` |
| 3 (optional) | `keylos-swap`: encrypted with an ephemeral random key at every boot; no hibernation (lockdown refuses it) |

## Extended attributes

| xattr | Writer | Content |
|---|---|---|
| `security.bpf.keylos.prov` | BPF LSM at inode creation (strata) | CBOR `{p: principal, g: generation, x: transaction, t: time}` |
| `security.bpf.keylos.label` | broker, strata | 2 bytes: confidentiality, integrity ordinals |
| `security.keylos.unit` | strata | Crypto-shred unit ID |
| `trusted.overlay.metacopy`, `trusted.overlay.redirect` | depot (composefs) | Object digest and redirect |

## TPM

From [protocols §19.6](../../specs/protocols/spec.md#196-tpm-objects). All NV indices live in the owner-hierarchy block `0x01300100–0x013001FF`.

| PCR | Content | Use |
|---|---|---|
| 0–7 | Firmware, option ROMs, Secure Boot state | pcrlock policy in NV `0x01300103` |
| 11 | UKI sections and boot phases (`enter-initrd`, `leave-initrd`, `sysinit`, `ready`, `enter-recovery`) | Signed PCR11 policy (`.pcrsig`) |
| 12 | Kernel command line and credentials | Predicted in the release statement |
| 13 | System extensions | Always the "no extension" value |
| 14 | shim/MOK state | Shim fallback mode only |
| 15 | Volume identity, extended after unlock | Policies for secrets released after unlock |

| NV index | Name | Owner |
|---|---|---|
| `0x01300100` | ledger-counter | ledger |
| `0x01300101` | config-counter | config (read by boot) |
| `0x01300102` | os-floor (minimum bootable release `seq`) | courier (read by boot) |
| `0x01300103` | pcrlock-policy | courier, boot (recovery) |
| `0x01300104` | keystore-floor | vault |
| `0x01300105` | owner-registry-head | hearth (read by boot) |
| `0x01300106` | login-failure-counter | hearth |
| `0x01300107` | strata-anchor-counter | strata |
| `0x01300108` | attestation-key names (AK, AK0) | installer, boot |
| `0x01300110` | vault-epoch/0 (alternates with /1) | vault |
| `0x01300111` | vault-epoch/1 (alternates with /0) | vault |
| `0x01300140 + i` | seal-gate/i, one per owner | hearth |

**Read model.** Every NV index has `OWNERREAD | AUTHREAD | POLICYREAD` and a public `PolicyCommandCode(NV_Read)` policy branch, so anyone with TPM access (including boot in the initrd) can read counters, floors and heads; writes stay controlled per index. The two `vault-epoch` indices are the exception (secret: read and written only with their sealed authValue). `os-floor` is written only under an exact-target policy authorized by the release-stream key. The owner-hierarchy and endorsement auths are random values sealed for hearth; the lockout auth derives from the recovery key.

**Seal-gate salts.** Owner *i*'s window *k* uses `s_k = SHA-256("keylos-seal" ‖ u64_be(k))`; the assertion carries `(s_k, s_{k+1})`.

**NV auth files.** Sealed authValues of NV indices live in `/var/lib/keylos/tpm/nv-auth/0x<8 lowercase hex>.sealed`, for example `0x01300107.sealed` (protocols §10.7, §19.6). Each file is `TPM2B_PRIVATE ‖ TPM2B_PUBLIC` of a sealed data object under the SRK `0x81000001`, with `userWithAuth` clear and the policy `PolicyAuthorize(signed PCR11 ready) ∧ PolicyPCR(15)`; development builds without a signed PCR11 policy use `PolicyPCR(15)` alone, which production builds refuse. Only the index's registered owner reads it, and after genesis only hearth defines indices (`HearthTpm.defineSpace`).

**TPM fd and development knobs.** A service with `privileges.tpm` receives an open `/dev/tpmrm0` fd named in `KEYLOS_TPM_FD`. Names starting with `KEYLOS_DEV_` are development knobs (for example `KEYLOS_DEV_TPM_TCTI` for swtpm); production builds never read them and the real warden never sets them.

**Recovery recipient.** An X25519 key derived from the recovery key (HKDF label `keylos-recovery-recipient/1`); recovery copies (for example `hierarchy-owner.recovery`) are HPKE-encrypted to it. The owner Secure Boot PK derives with label `keylos-sb-pk/1` (§20.21).

**PCR11 phases** in order: `enter-initrd` (`kl-initrd`), `leave-initrd` (boot), `sysinit` (warden), `ready` (warden, before the first tier-0 service), or `enter-recovery` (boot, recovery profile). Nothing extends PCR11 after `ready`.

| Persistent handle | Object |
|---|---|
| `0x81000001` | SRK |
| `0x81000101`, `0x81000102` | Owner Secure Boot KEK and db signers |
| `0x81000103` | First-boot vault seed key (P-256, HPKE DHKEM(P-256)); evicted at first boot |
| `0x81000105` | Recovery auth object |
| `0x81000110` | strata anchor HMAC key |
| `0x81000120` | fleet device key |
| `0x81000140 + i` | owner-seal/i |
| `0x81010002` | AK (runtime attestation) |
| `0x81010003` | AK0 (pre-unlock quotes) |
| `0x81000180`–`0x81000183` | Reserved staging handles for re-creating the KEK/db signers (hearth) |

## kl-exec maps

| Map | Content |
|---|---|
| `kl_exec_allowed_sb` | Superblocks of registered generation mounts |
| `kl_exec_jit_cgroups` | cgroups of `needs.jit` generations |
| `kl_exec_policy` | `{enforce, audit_allow, phase, warden_tgid}`, frozen after hand-over |
| `kl_exec_events` | Denial ring buffer |
| `kl_debug_pairs` | Tracer cgroup → `{target cgroup, expiry, scope}` (debug grants, open-broker read pairing) |

boot hands the five map fds to warden as fds 3–7 (`keylos.execmapfds=3,4,5,6,7`). The boot report is `/run/keylos/boot/report.json`, also passed to warden as fd 8. The ten `kl-exec` hook link fds follow as fds 9–18 (`keylos.execlinkfds=9,…,18`); warden keeps them open, and closing them would detach the program.

## vsock ports (host CID 2)

| Port | Use |
|---|---|
| 1024 | bench control (`benchd`, capwire-vsock) |
| 1025–1535 | bench bulk streams |
| 7002 | aide `AgentHost` (agent VMs only) |
| 7004 | bench-relay `GuestPortals` (tier-2 app VMs and agent desktops; never workbenches) |

## UIDs and cgroups

| Range | Use |
|---|---|
| 0 | Kernel threads and warden (PID 1) only |
| 1000–59999 | Humans (hearth) |
| `0x00100000`–`0x0FFEFFFF` | Dynamic principal UIDs (warden), quarantined 60 s after release |
| `0x0FFF0000` | On-disk owner of `_cluster` data (pod volumes); containers see their own UIDs through idmapped trees (protocols §10.3) |
| `0x10000000`–`0x7FFEFFFF` | Legacy-tier user-namespace blocks of 65,536 UIDs (warden) |

```
/keylos.slice/system.slice/<service>.scope
/keylos.slice/user-<uid>.slice/{shell,apps,agents,benches,legacy}.slice/<session>.scope
/keylos.slice/kube.slice/<pod-id>.slice/<container-or-vm>.scope   (delegated to cri)
/keylos.slice/guest-<id>.slice/…                                  (guest sessions, removed at logout)
```

## Environment variables

| Variable | Meaning |
|---|---|
| `KEYLOS_PRINCIPAL` | The process's principal (text form) |
| `KEYLOS_SESSION` | Its session ID |
| `KEYLOS_TIER` | `t0`, `t1`, `t2`, `t3` or `legacy` |
| `KEYLOS_CAPWIRE_FDS` | `name=fdnum` list of passed service sockets, for example `broker=3,portal-files=4` |
| `KEYLOS_ARGFD_<arg>` | fd number(s) of a `file`/`dir` argument opened by the shell |
| `KEYLOS_PIPE_IN`, `KEYLOS_PIPE_OUT` | `cbor-seq` when the shell negotiated record pipes |
| `KEYLOS_TXN` | The strata transaction ID, when spawned with `SpawnSpec.transaction` |
| `KEYLOS_AGENT_HOST` | `vsock:2:7002` inside agent workbenches |
| `KEYLOS_GUEST_PORTALS` | `vsock:2:7004` inside tier-2 guests and agent desktops |
| `KEYLOS_BPF_FDS` | `name=fdnum` list of BPF map fds warden loaded for a tier-0 service |
| `XDG_*_HOME` | The app's per-app subvolumes |

No secret is ever passed in the environment. Names starting with `KEYLOS_` are reserved: `SpawnSpec.env` can't set them, except that a `shell` principal may set `KEYLOS_ARGFD_*`, `KEYLOS_PIPE_IN` and `KEYLOS_PIPE_OUT`, and warden checks every fd named in `KEYLOS_ARGFD_*` is actually passed.

## Log records

| Form | Encoding |
|---|---|
| Plain | Text lines on fd 2 (connected to the journal stream by warden) |
| Structured | A datagram starting with `0x1E` followed by a CBOR map `{l: level 0–7, m: message, f: fields}` |
| Metrics | A datagram starting with `0x1F` followed by a CBOR map `{n: name, t: counter/gauge/histogram, v: value, l: labels}` |

## Transparency log origins

| Log | Origin line |
|---|---|
| Realisations | `log.keylos.org/realisations` |
| Releases | `log.keylos.org/releases` |
| Machine ledger | `keylos-ledger/<machine key>` |

## Related

- [protocols spec](../../specs/protocols/spec.md)
- [Glossary](glossary.md)
- [Filesystem layout](../08-state/filesystem-layout.md)
- [Kernel configuration and sysctls](kernel-config-and-sysctls.md)
- [Registries](../04-contracts/registries.md)
