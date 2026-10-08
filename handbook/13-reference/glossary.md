# Glossary

> The vocabulary of keylos. Terms are used with exactly these meanings across the handbook and the specs.
> Where a term comes from an external standard, the standard's meaning applies and the entry says how keylos uses it.

| Term | Meaning | See |
|---|---|---|
| **A/B update** | Keeping the previous OS generation bootable next to the new one, with automatic fallback | [Updates and rollback](../10-operations/updates-and-rollback.md) |
| **Actor** | The software part of a principal: `app:`, `service:`, `agent:`, `legacy:`, `bench:`, `shell` or `kernel` | [protocols §3.4](../../specs/protocols/spec.md#34-principal-identifiers) |
| **Agent desktop** | A tier-3 VM with a nested atrium where a computer-use agent operates GUI apps; the human can watch and take over | [Computer use](../07-agents/computer-use.md) |
| **Agent principal** | A principal whose actor is an agent-template generation; runs in a workbench | [Agent principal](../07-agents/agent-principal.md) |
| **Agent template** | A generation pinning an agent harness, its tool definitions (by digest), system prompt and policy | [Tools and MCP](../07-agents/tools-and-mcp.md) |
| **AgentHost** | The capwire interface aide serves to a harness inside a workbench | [Harness API](../07-agents/harness-api.md) |
| **AK0** | The pre-unlock attestation key (`0x81010003`) that signs verify-before-unlock quotes; AK (`0x81010002`) signs runtime quotes | [Attestation and vouch](../05-integrity/attestation-and-vouch.md) |
| **Ambient authority** | Authority a process has merely by existing (its UID, the filesystem namespace). keylos has none | [Principles](../01-overview/principles.md) |
| **Approval tier** | T0–T3: how much human involvement an action needs | [Approvals](../07-agents/approvals.md) |
| **Assisted presence** | Presence through hearth's TPM-backed platform authenticator, confirmed inside the trusted-path prompt; marked `assisted: true` | [Users and homes](../08-state/users-and-homes.md) |
| **`AT_EXECVE_CHECK`** | `execveat` flag (Linux 6.14) letting an interpreter ask whether the kernel would execute a file | [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md) |
| **Attenuation** | Adding Datalog checks to a token so it allows less; offline and append-only | [Tokens](../04-contracts/tokens.md) |
| **bench-net** | bench's userspace network stack that terminates a VM's virtio-net device and turns each flow into a `ShimEndpoint.connect` on gate | [Network egress](../06-security/network-egress.md) |
| **Biscuit** | The token format (v3) used for capabilities: Ed25519-signed blocks with Datalog | [ADR-0005](../11-decisions/adr-0005-biscuit-capability-tokens.md) |
| **Boot counting** | systemd-boot's tries-left counter in the UKI file name (`+3-0`) | [Updates and rollback](../10-operations/updates-and-rollback.md) |
| **Boot trust set** | `/run/keylos/boot/trust.json`: the release-stream, owner-presence, owner-seal and publisher keys against which generation statements are verified before `kl-exec` registration | [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md) |
| **broker** | The capability broker: policy decisions, tokens, materialization, labels, approvals | [broker spec](../../specs/broker/spec.md) |
| **capability** | An unforgeable reference that conveys authority: an fd, a capwire capability, or a Biscuit token | [Capabilities and the broker](../06-security/capabilities-and-broker.md) |
| **Capability diff** | The difference in `needs`, `tier`, `effects` and services between two manifests; widening needs consent | [Manifest](../04-contracts/manifest.md) |
| **capwire** | keylos IPC: Cap'n Proto RPC over `SOCK_SEQPACKET` with `SCM_RIGHTS` fd passing | [capwire](../04-contracts/capwire.md) |
| **capwire-vsock** | The capwire profile between a VM guest and the host: `AF_VSOCK`, no fd passing, identity by CID | [Capwire](../04-contracts/capwire.md#capwire-over-vsock) |
| **Cedar** | The policy language broker evaluates; namespace `Keylos` | [Cedar policy](../04-contracts/cedar-policy.md) |
| **Checkpoint** | A C2SP signed note committing to a log's size and root hash | [Receipts](../04-contracts/receipts.md) |
| **cmdsig** | A command signature: arguments, flags, I/O types and effects of a native command | [Command signatures and pipes](../04-contracts/cmdsig-and-pipes.md) |
| **Compensable** | An effect class: it can be undone by a registered compensating action | [Effects and the outbox](../07-agents/effects-and-outbox.md) |
| **composefs** | EROFS metadata image plus content-addressed backing files, mounted via overlayfs with verity | [Store and composefs](../05-integrity/supply-chain.md) |
| **Confext** | A configuration extension image merged over `/etc`; keylos config generations are confexts | [Config generations](../08-state/config-generations.md) |
| **Confinement report** | JSON describing how a process is confined (`Process.confinement`) | [protocols §9.4](../../specs/protocols/spec.md#94-confinement-report) |
| **Consent record** | A depot-signed `keylos.consent/1` recording that a human approved an app's capability set | [Manifest](../04-contracts/manifest.md) |
| **Container generation** | An OCI image converted deterministically by depot into a generation; runs in the `keylos-sealed` runtime class when signed by an org publisher | [Kubernetes nodes](../10-operations/kubernetes.md) |
| **cri** | keylos's Kubernetes container runtime: CRI v1 for kubelet, pod VMs, sealed pods, admission | [cri](../03-components/cri.md) |
| **Crypto-shredding** | Forgetting data by destroying its unit key | [Crypto-shredding](../08-state/crypto-shredding.md) |
| **D-Bus island** | A private D-Bus instance shared only by a reused daemon and its keylos adapter | [ADR-0035](../11-decisions/adr-0035-fd-only-portals-dbus-islands.md) |
| **Debug pair** | A `kl_debug_pairs` entry allowing one tracer cgroup to ptrace or perf one target cgroup until it expires | [Debugging](../06-security/debugging.md) |
| **Declassification** | Allowing a session that holds two of U, P, X to acquire the third, by T3 approval or a flow proof | [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md) |
| **Delegation** | Giving a child session attenuated tokens; never broader than the parent's | [Capabilities and the broker](../06-security/capabilities-and-broker.md) |
| **Derivation (drv)** | The canonical JSON description of a build: inputs, builder, environment, outputs | [Supply chain](../05-integrity/supply-chain.md) |
| **DSSE** | Dead Simple Signing Envelope; the wrapper of every signed keylos document | [Signed documents](../04-contracts/signed-documents.md) |
| **Dynamic UID** | A UID allocated by warden for one running principal instance | [ADR-0024](../11-decisions/adr-0024-dynamic-uids-per-principal.md) |
| **Effect** | An action with consequences outside the machine (email, push, payment) | [Effects and the outbox](../07-agents/effects-and-outbox.md) |
| **Effect kind** | A registered name such as `email.send` with a default class | [protocols §14.2](../../specs/protocols/spec.md#142-effect-kinds) |
| **Facet** | A server-defined restriction of an interface for one class of caller; every facet is registered in protocols §19.2 and routes are written `service#facet` | [Registries](../04-contracts/registries.md#facets) |
| **Feature level (KL1–KL3)** | The kernel capability tier a component detects at runtime | [protocols §2.1](../../specs/protocols/spec.md#21-kernel-feature-levels) |
| **Flow proof** | An attestation from a CaMeL-style harness that a value leaving the session does not derive from untrusted control | [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md) |
| **fs-verity** | Kernel per-file Merkle-tree integrity; every store object has it enabled | [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md) |
| **`fsv256`** | The fs-verity SHA-256 file digest, the identity of objects and generations | [Names, paths and identifiers](names-paths-and-ids.md) |
| **Generation** | A content-addressed, signed tree (EROFS composefs image) of kind os, runtime, app, service, agent-template, bench-image, legacy-image, config, policy or data | [protocols §6](../../specs/protocols/spec.md#6-generation-manifest) |
| **Generation statement** | A `keylos.genstmt/1` signed by a release stream, publisher or owner-seal key; the authorising signature of a generation | [Supply chain](../05-integrity/supply-chain.md) |
| **Graft** | Emergency rewrite of references to a fixed dependency without a full rebuild; always temporary | [ADR-0018](../11-decisions/adr-0018-grafts-are-temporary.md) |
| **Grant** | Authority issued by broker; a token plus, if persistent, a grant record | [Authority flow](../02-architecture/authority-flow.md) |
| **Grant record** | broker's stored form of a persistent grant; re-minted into a token each boot | [ADR-0040](../11-decisions/adr-0040-per-boot-token-keys.md) |
| **Guest session** | An ephemeral `guest-…` user with a home and unit key destroyed at logout | [Users and homes](../08-state/users-and-homes.md) |
| **Harness** | The agent loop running inside a workbench, talking to aide's `AgentHost` | [Harness API](../07-agents/harness-api.md) |
| **Human** | A person with a hearth account; the accountable part of every principal | [Users and homes](../08-state/users-and-homes.md) |
| **Integrity profile** | The strength of a machine's chain of trust, derived at every boot: `full`, `shared-boot`, `shim`, `cloud-vtpm`, `cvm`, `degraded` | [Profiles and hardware](../01-overview/profiles-and-hardware.md) |
| **Intent** | A staged effect in gate's outbox | [Effects and the outbox](../07-agents/effects-and-outbox.md) |
| **IPE** | Integrity Policy Enforcement LSM. In keylos a second layer: it allows the initramfs and denies kexec; host exec integrity is `kl-exec` | [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md) |
| **Irreversible** | An effect class that can never be undone; always a pivot, always T3 | [Effects and the outbox](../07-agents/effects-and-outbox.md) |
| **`kl-exec`** | The BPF LSM that allows exec and mmap-exec on the host only from mounts of verified generations, plus cgroup-scoped JIT exceptions | [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md) |
| **kmod generation** | A release-signed out-of-tree kernel module set for one kernel release | [ADR-0057](../11-decisions/adr-0057-oot-modules-project-signed-only.md) |
| **Label** | `{confidentiality, integrity}` on objects and sessions | [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md) |
| **Label authority** | The broker facet (`LabelAuthority`) through which services raise a receiving session's label before handing it data | [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md) |
| **Landlock** | Unprivileged, stackable kernel access control; the base of every sandbox | [Confinement tiers](../06-security/confinement-tiers.md) |
| **Launchable** | A generation with an authorising generation statement that verifies against the boot trust set, not revoked, and whose capability diff has consent | [depot spec](../../specs/depot/spec.md) |
| **ledger** | The append-only, hash-chained, signed receipt log | [ledger spec](../../specs/ledger/spec.md) |
| **Legacy tier** | Unmodified Linux software in an FHS view with a user namespace, confined | [Legacy apps](../09-experience/legacy-apps.md) |
| **Mandate** | A signed approval bound to the digest of a specific effect payload | [protocols §14.4](../../specs/protocols/spec.md#144-mandates-keylosmandate1) |
| **Materialize** | Turning a token into a usable handle (fd, socket, capability) through broker | [Authority flow](../02-architecture/authority-flow.md) |
| **Media VM** | A tier-3 VM that mounts removable storage so the host kernel never parses it | [Devices and media](../06-security/devices-and-media.md) |
| **Model drift** | A remote model reporting a different model or version than the session's `model(...)` fact; escalates T1 to T2 | [Approvals](../07-agents/approvals.md) |
| **Mount view** | The mount namespace contents warden builds for a principal | [Namespaces](../06-security/namespaces.md) |
| **NV counter** | A TPM non-volatile monotonic counter used against rollback; keylos's live in the owner NV block `0x01300100–0x013001FF` | [Registries](../04-contracts/registries.md#tpm-objects) |
| **Outbox** | gate's store of staged intents; irreversible effects run only from here | [Effects and the outbox](../07-agents/effects-and-outbox.md) |
| **Owner** | The human who enrolled the machine and holds the presence keys | [Install and enrolment](../10-operations/install-and-enrolment.md) |
| **Owner presence** | A FIDO2 assertion proving the owner touched their key for a specific payload | [ADR-0011](../11-decisions/adr-0011-owner-presence-fido2.md) |
| **Owner registry** | The presence-signed log of owners and their FIDO2 credentials, anchored in TPM NV `0x01300105` | [Users and homes](../08-state/users-and-homes.md) |
| **Owner seal** | A signature by an owner's TPM-resident owner-seal key that lets owner-built code run on the host | [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md) |
| **PCR** | TPM Platform Configuration Register; keylos binds keys to PCR0–7 (pcrlock), 11 (signed policy) and 15 (volume identity) | [Boot chain](../05-integrity/boot-chain.md) |
| **Pivot** | The irreversible step of a saga, ordered last | [Effects and the outbox](../07-agents/effects-and-outbox.md) |
| **Plan** | A proposed config generation with its diff, restarts and capability changes | [Config generations](../08-state/config-generations.md) |
| **Pod VM** | A bench microVM running one Kubernetes pod sandbox (`keylos-vm` runtime class) | [Kubernetes nodes](../10-operations/kubernetes.md) |
| **Powerbox** | A trusted chooser whose selection is the grant | [Portals and the powerbox](../09-experience/portals-and-powerbox.md) |
| **Principal** | (actor, human, session chain): the unit of authority | [Principals and identity](../06-security/principals-and-identity.md) |
| **Profile** | desktop, laptop, server or appliance configuration of the distribution | [Profiles and hardware](../01-overview/profiles-and-hardware.md) |
| **Provenance** | Who created a file, recorded at creation in `security.bpf.keylos.prov` | [Provenance](../08-state/provenance.md) |
| **Quorum presence** | Presence on headless machines: at least N distinct owners sign remotely | [Servers and cloud](../10-operations/servers-and-cloud.md) |
| **RAM class** | `small`, `medium` or `large`; sets the maximum number of concurrent VMs | [Profiles and hardware](../01-overview/profiles-and-hardware.md) |
| **Realisation** | The claim that a derivation produced a given output; attested by rebuilders | [Transparency and rebuilders](../05-integrity/transparency-and-rebuilders.md) |
| **Reboot heals** | The property that userspace compromise does not survive a reboot | [Reboot heals](../05-integrity/reboot-heals.md) |
| **Rebuilder** | An independent operator who rebuilds derivations and signs realisations | [Transparency and rebuilders](../05-integrity/transparency-and-rebuilders.md) |
| **Receipt** | A signed, hash-chained ledger record of one decision or event | [Receipts](../04-contracts/receipts.md) |
| **Release statement** | A `keylos.release/1` signed by a release stream: the OS update's TUF target and its release-log entry | [Transparency and rebuilders](../05-integrity/transparency-and-rebuilders.md) |
| **Release stream** | `stable`, `beta` or `dev`; each has its own signing and PCR-policy keys | [Supply chain](../05-integrity/supply-chain.md) |
| **Reversible** | An effect class confined to the transaction (for example overlay writes) | [Effects and the outbox](../07-agents/effects-and-outbox.md) |
| **Revocation age** | Time since the newest verified revocation list; drives offline rules | [Updates and rollback](../10-operations/updates-and-rollback.md) |
| **Revocation list** | A signed list of objects, generations and keys to evict or block | [protocols §11.7](../../specs/protocols/spec.md#117-revocation-list) |
| **Root ID** | The identifier of a token family; revoking it revokes every derived token | [Tokens](../04-contracts/tokens.md) |
| **Route** | A declared, policy-allowed connection from a principal to a service facet, wired by warden | [protocols §7.2](../../specs/protocols/spec.md#72-routes-and-facets) |
| **Rule of Two** | No session may hold untrusted input (U), private data (P) and external effect (X) at once | [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md) |
| **Runtime class** | `keylos-vm` (pod per microVM) or `keylos-sealed` (signed container generations on the host) | [Kubernetes nodes](../10-operations/kubernetes.md) |
| **Seal gate** | A per-owner TPM NV index whose auth, rotated each sealing window with FIDO2 `hmac-secret`, unlocks that owner's owner-seal key | [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md) |
| **Sealed** | Code in a generation whose generation statement verifies against the boot trust set, so warden registers its mount with `kl-exec` | [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md) |
| **Sealed receipt** | A receipt whose `data` and `label` are encrypted under a per-human, per-month ledger unit key | [Receipt privacy](../08-state/receipt-privacy.md) |
| **Sealing window** | At most 600 s of sealing authorised by one presence assertion, scoped to one project and a list of derivations | [ADR-0012](../11-decisions/adr-0012-sealing-windows.md) |
| **Session** | One run of a principal; `s-` + ULID; chains record delegation | [protocols §3.5](../../specs/protocols/spec.md#35-other-identifiers) |
| **Session label** | The maximum label of everything a session has read | [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md) |
| **Sink-safe host** | A host policy marks as unable to receive exfiltrated data (for example a read-only package mirror) | [Network egress](../06-security/network-egress.md) |
| **Snapshot** | A read-only btrfs snapshot of a data subvolume | [Snapshots and transactions](../08-state/snapshots-and-transactions.md) |
| **Store object** | A file in `/store/objects` with fs-verity enabled, named by its `fsv256` digest | [Filesystem layout](../08-state/filesystem-layout.md) |
| **System interface** | One of the 22 canonical schema files of protocols §7.5 that tier-0 services use with each other | [System interfaces](../04-contracts/system-interfaces.md) |
| **Tier** | t0 (services), t1 (apps), t2 (untrusted app VMs), t3 (workbenches), legacy | [Confinement tiers](../06-security/confinement-tiers.md) |
| **Time floor** | The newest ledger checkpoint time, used for expiry checks until the first NTS sync | [Identifiers](../04-contracts/identifiers.md) |
| **TPM2 + PIN** | Disk unlock requiring both the TPM's measured state and the owner's PIN | [Boot chain](../05-integrity/boot-chain.md) |
| **Transaction** | A command or agent run against an overlay, committed or aborted as a whole | [Snapshots and transactions](../08-state/snapshots-and-transactions.md) |
| **Trusted path** | UI surfaces drawn by atrium that no client can draw over or imitate | [Trusted path](../06-security/trusted-path.md) |
| **Trustee share** | One of *n* Shamir shares of the recovery key; *k* reconstruct it | [Users and homes](../08-state/users-and-homes.md) |
| **TUF** | The Update Framework; signed metadata for freshness and anti-rollback | [Supply chain](../05-integrity/supply-chain.md) |
| **UKI** | Unified Kernel Image: kernel, initrd, command line and policy signatures in one signed PE file | [Boot chain](../05-integrity/boot-chain.md) |
| **Unit (crypto-shred)** | A forgettable set of data with its own key | [Crypto-shredding](../08-state/crypto-shredding.md) |
| **USB authorization** | Devices stay unbound until approved on the trusted path; keyboard-like devices need an already-authorized input device | [Devices and media](../06-security/devices-and-media.md) |
| **Verify before unlock** | Checking an AK0 TPM quote on the phone before typing the unlock PIN (protocols §20.5) | [Attestation and vouch](../05-integrity/attestation-and-vouch.md) |
| **View** | See *mount view* | [Namespaces](../06-security/namespaces.md) |
| **Web app** | An `app` generation with a `webapp` section, bound to one origin through gate | [ADR-0055](../11-decisions/adr-0055-webapps.md) |
| **Witness** | An independent party that cosigns log checkpoints to prevent split views | [Transparency and rebuilders](../05-integrity/transparency-and-rebuilders.md) |
| **Workbench** | A crosvm microVM for unsealed code: development environments and agent sessions (tier 3) | [Sessions and workbenches](../07-agents/sessions-and-workbenches.md) |
| **Workbench app** | A GUI app (such as an IDE) running inside a project workbench, displayed on the host | [IDEs](../09-experience/ides.md) |

## Related

- [Names, paths and identifiers](names-paths-and-ids.md)
- [protocols spec](../../specs/protocols/spec.md)
- [Contributing: terminology](../CONTRIBUTING.md#terminology)
