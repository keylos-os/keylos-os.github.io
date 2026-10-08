# Principles

> The architecture, security and engineering principles every keylos repository follows. Each has a one-line rationale and a link to the decision that fixes it.
> When a design question is not answered elsewhere, these principles decide it.

## Architecture principles

| # | Principle | Rationale | Decision |
|---|---|---|---|
| P1 | **protocols is the only coupling.** Repositories share identifiers, interfaces and formats through [protocols](../../specs/protocols/spec.md) and nothing else. Specs embed what they use word for word. | 31 repositories must be implementable independently and in parallel; a shared contract is the only safe coupling. | [ADR-0001](../11-decisions/adr-0001-multi-repo-protocols-only-coupling.md) |
| P2 | **Stock kernel, probed features.** keylos runs on upstream Linux and selects behaviour by feature level (KL1–KL3), never by version string. | The kernel already has the primitives; forking it would trade security for maintenance debt. | [ADR-0003](../11-decisions/adr-0003-stock-kernel-feature-levels.md) |
| P3 | **No system bus.** All IPC is capwire (Cap'n Proto RPC over `SOCK_SEQPACKET` with fd passing). A process reaches only the capabilities warden handed it or that it received in a reply. | A global bus is ambient authority; object capabilities make reachability equal authority. | [ADR-0004](../11-decisions/adr-0004-capwire-no-system-bus.md) |
| P4 | **Everything that runs is a generation.** The OS, runtimes, apps, services, agent templates, bench images, configuration and policy are all content-addressed generations with a signed manifest. | One identity, one verification path and one rollback mechanism for everything. | [ADR-0007](../11-decisions/adr-0007-composefs-fsverity-store.md) |
| P5 | **Unsealed code runs in a VM.** The host runs sealed code only. Developer builds, downloads and agent-written code run in crosvm workbenches with their own kernel. | Exec integrity and a usable developer and agent workflow cannot both live on one kernel. | [ADR-0009](../11-decisions/adr-0009-unsealed-code-in-workbenches.md), [ADR-0010](../11-decisions/adr-0010-crosvm-single-vmm.md) |
| P6 | **State changes are transactions.** System and config changes are generations; data changes are snapshots and transactions; external effects are intents in an outbox. | Undo must be a property of the system, not of each application. | [ADR-0027](../11-decisions/adr-0027-effect-outbox-and-mandates.md), [ADR-0022](../11-decisions/adr-0022-read-only-etc-confext.md) |
| P7 | **Configuration is code, compiled and signed.** Nickel source compiles to a confext generation signed with owner presence; `/etc` is read-only. | Config drift and persistence through config disappear when only signed generations are mounted. | [ADR-0021](../11-decisions/adr-0021-nickel-configuration.md), [ADR-0022](../11-decisions/adr-0022-read-only-etc-confext.md) |
| P8 | **One store for every ecosystem.** Cargo, npm, PyPI and others keep their resolvers; their lockfiles become fixed-output fetches into the same verified store. | One cache, one trust root and one garbage collector instead of a dozen. | [ADR-0042](../11-decisions/adr-0042-one-store-for-language-ecosystems.md) |
| P9 | **Compatibility is a tier, not an afterthought.** Unmodified Linux software runs in the legacy tier with an FHS view, confined. | Adoption depends on running what people already use. | [ADR-0037](../11-decisions/adr-0037-legacy-tier-fhs-views.md) |

## Security principles

| # | Principle | Rationale | Decision |
|---|---|---|---|
| S1 | **No ambient authority.** Every process starts with an empty Landlock domain, an allowlist seccomp filter and only the fds it was given. | Least privilege by construction, not by configuration. | [ADR-0005](../11-decisions/adr-0005-biscuit-capability-tokens.md) |
| S2 | **Grants are objects, not paths.** Authority is delivered as file descriptors; trusted helpers never resolve paths on behalf of less-trusted principals. | Path re-resolution and symlink following are where sandbox escapes come from. | [ADR-0035](../11-decisions/adr-0035-fd-only-portals-dbus-islands.md) |
| S3 | **Policy is code, evaluated outside the requester.** Cedar policies, authored by humans, evaluated by broker. Agents may only propose policy diffs. | Reviewable, testable, deterministic permissions that the subject cannot influence. | [ADR-0006](../11-decisions/adr-0006-cedar-policy.md) |
| S4 | **Host executes only sealed code.** The `kl-exec` BPF LSM allows exec and mmap-exec only from composefs mounts of generations whose signatures warden verified against the boot trust set. | Persistence needs code; deny the code and a reboot heals. | [ADR-0008](../11-decisions/adr-0008-host-executes-only-sealed-code.md) |
| S5 | **Persistent trust needs a touch.** Config generations, seals, policy changes and irreversible mandates are signed by the owner's FIDO2 key. | Malware that owns userspace still cannot make itself trusted. | [ADR-0011](../11-decisions/adr-0011-owner-presence-fido2.md), [ADR-0012](../11-decisions/adr-0012-sealing-windows.md) |
| S6 | **No root, no setuid, no sudo.** Only warden runs as UID 0; administration is a signed transaction. | Ambient super-user authority is the largest single escalation target. | [ADR-0023](../11-decisions/adr-0023-no-root-no-setuid.md) |
| S7 | **Only warden builds namespaces.** Sandboxed code never gets user namespaces; the legacy tier gets one without nesting. | User namespaces expose the kernel code paths most kernel exploits use. | [ADR-0025](../11-decisions/adr-0025-namespaces-only-by-warden.md) |
| S8 | **The Rule of Two is enforced by the OS.** A session may hold at most two of: untrusted input, private data, external effect. The third needs declassification. | Prompt injection cannot be filtered reliably; its consequences can be bounded. | [ADR-0026](../11-decisions/adr-0026-labels-and-rule-of-two.md) |
| S9 | **Show effects, not commands, and ask rarely.** Only T3 interrupts. Prompts render the effect and argument provenance on the trusted path. Classifiers can only escalate. | Approval fatigue turns frequent prompts into rubber stamps. | [ADR-0028](../11-decisions/adr-0028-approval-tiers.md), [ADR-0034](../11-decisions/adr-0034-wayland-only-trusted-path.md) |
| S10 | **Agents propose, humans sign.** Agents never change the system directly; their tools are pinned by digest. | Bounds agent mistakes and supply-chain rug-pulls to proposals a human sees. | [ADR-0029](../11-decisions/adr-0029-agents-propose-humans-sign.md), [ADR-0030](../11-decisions/adr-0030-pinned-agent-tools.md) |
| S11 | **Secrets never travel as values when a handle will do.** No secrets in environment or argv; `memfd_secret` for apps; credential injection at the proxy for agents. | Environment and argv leak through `/proc`, children and logs. | [ADR-0039](../11-decisions/adr-0039-secrets-never-in-env.md) |
| S12 | **Trust is verified by several parties.** Binaries need a k-of-n rebuilder quorum and transparency-log inclusion with witness cosignatures. | One compromised builder or signing key must not be enough. | [ADR-0016](../11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md) |
| S13 | **The owner verifies before typing a secret.** Before the unlock PIN, the phone checks a TPM quote against published predictions. | Secure Boot alone never tells a human that their machine was tampered with. | [ADR-0015](../11-decisions/adr-0015-verify-before-unlock.md) |
| S14 | **Forgetting is cryptographic.** Each forgettable unit has its own key in a keystore that is never snapshotted. | Snapshots and backups otherwise keep deleted data forever. | [ADR-0032](../11-decisions/adr-0032-crypto-shredding.md) |

## Engineering principles

| # | Principle | Rationale | Decision |
|---|---|---|---|
| E1 | **Rust for the TCB.** No new C in trusted components; reused C components run confined. | Memory safety removes the largest class of TCB bugs. | [ADR-0002](../11-decisions/adr-0002-rust-for-the-tcb.md) |
| E2 | **Specs are complete and testable.** Every spec has numbered requirements and acceptance criteria; there is no "later phase". | Independent implementations converge only on a precise target. | [ADR-0001](../11-decisions/adr-0001-multi-repo-protocols-only-coupling.md) |
| E3 | **Conformance vectors gate every release.** Each repository runs the protocols vectors for the formats it touches. | Interop is tested, not hoped for. | [ADR-0001](../11-decisions/adr-0001-multi-repo-protocols-only-coupling.md) |
| E4 | **Everything writes receipts.** Tier-0 components record decisions in the ledger with a schema per event. | Accountability and debugging use the same evidence. | [ADR-0031](../11-decisions/adr-0031-receipts-ledger.md) |
| E5 | **Reproducible or demoted.** Packages that do not reproduce bit for bit run in tier 2 unless the owner makes an exception. | Reproducibility is what makes rebuilder quorums meaningful. | [ADR-0043](../11-decisions/adr-0043-non-reproducible-means-tier-2.md) |
| E6 | **Time is authenticated.** Expiry checks treat the clock as untrusted until NTS has synchronised it, and never move it before the last checkpoint. | Freeze and rollback attacks often start with the clock. | [ADR-0038](../11-decisions/adr-0038-nts-time.md) |
| E7 | **Fail closed, recover open.** Verification failures refuse to run, but a known-good generation, a recovery key and a recovery environment are always available. | Security that bricks machines gets turned off. | [ADR-0014](../11-decisions/adr-0014-tpm-pin-signed-pcr-policy.md) |

## Applying the principles

- A new component that needs to reach another component asks for a **route** in its manifest. Opening a socket by path is not an option.
- A new kind of external effect is registered as an effect kind with a class (see [protocols §14.2](../../specs/protocols/spec.md#142-effect-kinds)). Its class can be raised by policy, never lowered.
- Anything that would let unsealed code execute on the host is a design change and needs an ADR. The default answer is a workbench.
- Anything that would lower an approval tier automatically is rejected.

## Related

- [Vision](vision.md)
- [Threat model](threat-model.md)
- [Dependency rules](../02-architecture/dependency-rules.md)
- [Decisions](../11-decisions/README.md)
