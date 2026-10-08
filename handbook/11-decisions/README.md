# Decisions

> Architecture decision records for keylos. Each record states the context with evidence, the decision, the alternatives that were rejected and why, and the consequences, including the costs.
> When a design question isn't answered elsewhere in the handbook, these records and the [principles](../01-overview/principles.md) decide it.

All records below are **Accepted** as of 2026-10-07 (specification v1.0). ADR-0008, 0011, 0012 and 0014 were revised when protocols 1.0 final resolved conflicts between the repository specs; ADR-0044 to 0046 record those resolutions. ADR-0047 to 0057 (2026-10-08) record the gaps round: servers and Kubernetes, presence without a local touch, devices, debugging, IDEs, agent desktops, receipt privacy, dual boot, web apps, offline operation and out-of-tree modules. ADR-0058 records the schema compile gate added with protocols round 3. ADR-0059 to 0067 (2026-10-08) record the S2 feedback pass: power-loss-safe vault epoch rotation, exact-target floor writes, prepared merges, enforced directory label ceilings, single-file grants, fail-closed approval rendering, encrypted unitfs transactions, the S2 contract fixes and the precise reboot claim.

| # | Title | Area |
|---|---|---|
| [ADR-0001](adr-0001-multi-repo-protocols-only-coupling.md) | Multi-repo, protocols is the only coupling | Architecture |
| [ADR-0002](adr-0002-rust-for-the-tcb.md) | Rust for the trusted computing base | Engineering |
| [ADR-0003](adr-0003-stock-kernel-feature-levels.md) | Stock upstream kernel with feature levels | Platform |
| [ADR-0004](adr-0004-capwire-no-system-bus.md) | capwire, with no system bus | Architecture |
| [ADR-0005](adr-0005-biscuit-capability-tokens.md) | Biscuit capability tokens | Security |
| [ADR-0006](adr-0006-cedar-policy.md) | Cedar for policy | Security |
| [ADR-0007](adr-0007-composefs-fsverity-store.md) | composefs + fs-verity content-addressed store | Store |
| [ADR-0008](adr-0008-host-executes-only-sealed-code.md) | The host executes only sealed code | Integrity |
| [ADR-0009](adr-0009-unsealed-code-in-workbenches.md) | Unsealed code runs only in workbenches | Execution |
| [ADR-0010](adr-0010-crosvm-single-vmm.md) | crosvm as the single VMM | Execution |
| [ADR-0011](adr-0011-owner-presence-fido2.md) | Owner presence via FIDO2 | Identity |
| [ADR-0012](adr-0012-sealing-windows.md) | Sealing windows | Integrity |
| [ADR-0013](adr-0013-owner-secure-boot-keys.md) | Owner-controlled Secure Boot keys by default | Boot |
| [ADR-0014](adr-0014-tpm-pin-signed-pcr-policy.md) | TPM2+PIN with signed PCR policy, prediction, NV floor and PCR15 | Boot |
| [ADR-0015](adr-0015-verify-before-unlock.md) | Verify before unlock | Integrity |
| [ADR-0016](adr-0016-rebuilder-quorum-and-transparency-logs.md) | Rebuilder quorum and transparency logs | Supply chain |
| [ADR-0017](adr-0017-tuf-over-oci.md) | TUF over OCI for distribution | Supply chain |
| [ADR-0018](adr-0018-grafts-are-temporary.md) | Grafts are temporary | Supply chain |
| [ADR-0019](adr-0019-source-rules-after-xz.md) | Source rules after xz | Supply chain |
| [ADR-0020](adr-0020-btrfs-luks2-aead.md) | btrfs on LUKS2 with authenticated encryption | State |
| [ADR-0021](adr-0021-nickel-configuration.md) | Nickel for configuration | State |
| [ADR-0022](adr-0022-read-only-etc-confext.md) | Read-only /etc via signed confext generations | State / integrity |
| [ADR-0023](adr-0023-no-root-no-setuid.md) | No root in userspace, no setuid, no sudo | Security |
| [ADR-0024](adr-0024-dynamic-uids-per-principal.md) | Dynamic UIDs per principal instance | Security |
| [ADR-0025](adr-0025-namespaces-only-by-warden.md) | Only warden creates namespaces; user namespaces only for legacy | Security |
| [ADR-0026](adr-0026-labels-and-rule-of-two.md) | Labels and the Rule of Two, enforced by the OS | Security / agents |
| [ADR-0027](adr-0027-effect-outbox-and-mandates.md) | Effect outbox and payload-bound mandates | Effects |
| [ADR-0028](adr-0028-approval-tiers.md) | Approval tiers T0–T3 | Security / UX |
| [ADR-0029](adr-0029-agents-propose-humans-sign.md) | Agents propose, humans sign | Agents |
| [ADR-0030](adr-0030-pinned-agent-tools.md) | Agent tools and MCP servers are pinned by digest | Agents |
| [ADR-0031](adr-0031-receipts-ledger.md) | A receipts ledger, separate from logs | Audit |
| [ADR-0032](adr-0032-crypto-shredding.md) | Crypto-shredding for deletion | State / privacy |
| [ADR-0033](adr-0033-creation-time-provenance.md) | Creation-time provenance only | State |
| [ADR-0034](adr-0034-wayland-only-trusted-path.md) | Wayland only, with a compositor-owned trusted path | Experience / security |
| [ADR-0035](adr-0035-fd-only-portals-dbus-islands.md) | fd-only portals, and D-Bus islands for legacy daemons | Experience / security |
| [ADR-0036](adr-0036-typed-pipes-via-cmdsig.md) | Typed pipes, negotiated statically through command signatures | Experience |
| [ADR-0037](adr-0037-legacy-tier-fhs-views.md) | Legacy tier with FHS views and an open-broker | Compatibility |
| [ADR-0038](adr-0038-nts-time.md) | NTS-authenticated time | Integrity |
| [ADR-0039](adr-0039-secrets-never-in-env.md) | Secrets never in environment variables; agents never see raw secrets | Security |
| [ADR-0040](adr-0040-per-boot-token-keys.md) | Per-boot token keys; persistent grants are re-minted | Security |
| [ADR-0041](adr-0041-revocation-kills-or-freezes.md) | Revocation kills or freezes holders | Security |
| [ADR-0042](adr-0042-one-store-for-language-ecosystems.md) | One store for language ecosystems | Supply chain |
| [ADR-0043](adr-0043-non-reproducible-means-tier-2.md) | Non-reproducible means tier 2 | Supply chain / execution |
| [ADR-0044](adr-0044-vsock-control-and-userspace-nic.md) | vsock for control, a userspace NIC for traffic | Execution / networking |
| [ADR-0045](adr-0045-owner-nv-range-and-tpm-registry.md) | Owner NV range and one TPM registry | Boot / integrity |
| [ADR-0046](adr-0046-courier-sole-tuf-client.md) | courier is the only TUF client | Supply chain |
| [ADR-0047](adr-0047-cri-microvm-pods.md) | Kubernetes pods run in microVMs by default, through a keylos CRI | Execution / servers |
| [ADR-0048](adr-0048-quorum-presence.md) | Quorum presence for headless and managed machines | Identity |
| [ADR-0049](adr-0049-debug-capability.md) | Debugging host processes is a time-limited capability | Security / developers |
| [ADR-0050](adr-0050-ides-in-workbenches.md) | Full IDEs run inside project workbenches | Experience / developers |
| [ADR-0051](adr-0051-agent-desktops.md) | GUI-operating agents use their own desktop in a VM | Agents |
| [ADR-0052](adr-0052-usb-authorization-and-media-bench.md) | USB authorization, mandatory IOMMU and a media VM for removable storage | Hardware / security |
| [ADR-0053](adr-0053-receipt-payload-encryption.md) | Receipt payloads are sealed per human per month | Audit / privacy |
| [ADR-0054](adr-0054-dual-boot-option.md) | Dual boot is an explicit option with its own integrity profile | Boot |
| [ADR-0055](adr-0055-webapps.md) | Installable web apps are app generations bound to one origin | Experience / apps |
| [ADR-0056](adr-0056-offline-mode.md) | Defined behaviour for long offline periods | Supply chain / operations |
| [ADR-0057](adr-0057-oot-modules-project-signed-only.md) | Out-of-tree kernel modules are project-built and release-signed only | Integrity / hardware |
| [ADR-0058](adr-0058-capnp-schemas-compile-checked.md) | Cap'n Proto schemas are extracted from protocols and compiled in CI | Contracts / tooling |
| [ADR-0059](adr-0059-two-index-vault-epoch-rotation.md) | Vault epoch rotation alternates between two TPM NV indices | Secrets / recovery |
| [ADR-0060](adr-0060-exact-target-floor-authorization.md) | The OS floor is written only to one exact, release-signed target | Boot / updates |
| [ADR-0061](adr-0061-prepared-merges-and-writer-fence.md) | Agent merges commit an immutable prepared result under a writer fence | State / agents |
| [ADR-0062](adr-0062-directory-label-ceilings.md) | Directory grants have enforced label ceilings | Security / labels |
| [ADR-0063](adr-0063-single-file-grant-views.md) | A single-file pick exposes only that file | Experience / portals |
| [ADR-0064](adr-0064-fail-closed-approval-rendering.md) | Approvals fail closed when required details can't be shown | Agents / trusted path |
| [ADR-0065](adr-0065-encrypted-unitfs-transactions.md) | Transactions on sealed units run on ciphertext clones | State / encryption |
| [ADR-0066](adr-0066-s2-contract-fixes.md) | Contract fixes from the first authority-core implementation | Contracts |
| [ADR-0067](adr-0067-reboot-restores-code-not-data.md) | Reboot restores code and configuration; hostile data needs safe start | Integrity / recovery |
| [ADR-0068](adr-0068-durable-workflows-loom.md) | Durable workflows run in a separate coordinator that keeps progress, never authority | Agents / state |
| [ADR-0069](adr-0069-s3-execution-core-contract-fixes.md) | File labels live in `security.bpf.*`; kl-exec gains its missing hooks, numbers and link hand-over; warden supervises without a ptrace exemption | Contracts / integrity |

## Writing a new record

- Take the next number. The file name is `adr-NNNN-<slug>.md`.
- Start with `# ADR-NNNN: <Title>`, a one-to-three-line summary in a blockquote, and the status table.
- Sections: Context (with evidence and links), Decision, Alternatives considered (table), Consequences (positive, negative, follow-ups), Related.
- A record that changes a contract in [protocols](../../specs/protocols/spec.md) also needs a protocols release ([Versioning](../04-contracts/versioning.md)).
- Superseded records stay. Mark them `Superseded by ADR-NNNN`.

## Related

- [Principles](../01-overview/principles.md)
- [Components](../03-components/README.md)
- [Contracts](../04-contracts/README.md)
