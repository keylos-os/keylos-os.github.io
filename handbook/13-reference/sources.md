# Sources

> The research the keylos design rests on: kernel documentation, specifications, papers, advisories and incident reports, as of October 2026.
> Each entry says what it supports in the design. Version-specific claims (kernel releases, CVE fix versions, draft status) should be re-checked when implementing.

## Kernel and confinement

| Source | Supports |
|---|---|
| Landlock userspace API, by kernel version: https://kernel.org/doc/html/v7.0/userspace-api/landlock.html, https://kernel.org/doc/html/v7.1/userspace-api/landlock.html, https://kernel.org/doc/html/v7.2/userspace-api/landlock.html, https://kernel.org/doc/html/v7.3-rc2/userspace-api/landlock.html | Feature levels KL1–KL3; ABI 7–11 features; limits of Landlock |
| Landlock limitations: https://docs.kernel.org/userspace-api/landlock.html | What Landlock cannot restrict; the 16-layer limit |
| IPE LSM: https://docs.kernel.org/6.12/admin-guide/LSM/ipe.html | Exec only from verity-backed sources |
| Executability check (`AT_EXECVE_CHECK`, exec securebits): https://docs.kernel.org/userspace-api/check_exec.html, https://lwn.net/Articles/1005958/ | Interpreter integrity |
| seccomp user notification: https://man7.org/linux/man-pages/man2/seccomp_unotify.2.html | TOCTOU caveats; `ADDFD` emulation pattern for the legacy open-broker |
| mseal: https://docs.kernel.org/userspace-api/mseal.html | Exploit hardening of mappings |
| BPF LSM: https://docs.kernel.org/bpf/prog_lsm.html; BPF signing: https://docs.kernel.org/bpf/signing.html | JIT exceptions; creation-time provenance; signed BPF |
| kCTF VRP learnings (user namespaces in 44% of exploits): https://security.googleblog.com/2023/06/learnings-from-kctf-vrps-42-linux.html | Only warden builds namespaces; no userns for sandboxed code |
| Ubuntu unprivileged userns restriction bypasses: https://blog.qualys.com/vulnerabilities-threat-research/2025/03/27/qualys-tru-discovers-three-bypasses-of-ubuntu-unprivileged-user-namespace-restrictions, https://lwn.net/Articles/1015649/ | Distribution-level gating is defense in depth, not a boundary |
| Flatpak sandbox escape CVE-2026-34078: https://cve.circl.lu/cve/CVE-2026-34078 | Trusted helpers must not follow paths (invariant I7) |
| Wayland security context protocol: https://wayland.app/protocols/security-context-v1 | Tagging sandboxed Wayland clients |
| Fuchsia capabilities: https://fuchsia.dev/fuchsia-src/concepts/components/v2/capabilities | Declarative capability routing |
| WASI 0.3: https://wasi.dev/releases/wasi-p3 | Capability-based plugins (tier W) |
| virtio-gpu and DRM native context: https://www.qemu.org/docs/master/system/devices/virtio/virtio-gpu.html | GPU in tier-2 and tier-3 VMs |
| Qubes OS documentation: https://www.qubes-os.org/doc/; ChromeOS containers and VMs: https://chromium.googlesource.com/chromiumos/docs/+/HEAD/containers_and_vms.md | VM-per-domain desktops in production; trusted UI borders |

## Boot, TPM and runtime integrity

| Source | Supports |
|---|---|
| composefs: https://github.com/containers/composefs/blob/main/README.md | One digest commits to a whole tree |
| bootc sealed images: https://github.com/bootc-dev/bootc/pull/1706; Fedora sealed test images: https://tim.siosm.fr/blog/2026/04/28/sealed-atomic-desktops-test-images/ | composefs digest in the UKI command line; maturity |
| systemd-pcrlock: https://man.archlinux.org/man/systemd-pcrlock.8.en | PCR0–7 prediction and NV policies |
| Microsoft UEFI CA 2011 expiry: https://lwn.net/Articles/1079808/ | Owner-controlled Secure Boot keys by default |
| CERT VU#616257 (trusted vulnerable shims): https://www.kb.cert.org/vuls/id/616257 | Staging db/dbx revocations; avoiding the third-party CA |
| TPM unlock filesystem confusion: https://forge.fedoraproject.org/security/tickets/issues/7; CVE-2026-32606: https://advisories.gitlab.com/golang/github.com/lxc/incus-os/incus-osd/CVE-2026-32606/ | PCR15 volume identity before leaving the initrd |
| bitpixie downgrade: https://neodyme.io/blog/bitlocker_screwed_without_a_screwdriver/ | NV version floor, owner db |
| TPM bus sniffing: https://blog.scrt.ch/2024/10/28/privilege-escalation-through-tpm-sniffing-when-bitlocker-pin-is-enabled/ | TPM + PIN; salted sessions with a pinned SRK |
| Hash-based kernel module integrity: https://lwn.net/Articles/1012946 | Reproducible kernels without build-time signing keys |

## Supply chain

| Source | Supports |
|---|---|
| SLSA specification: https://slsa.dev/spec/ | Build and source tracks; provenance |
| Rekor v2: https://blog.sigstore.dev/rekor-v2-ga/ | Tile-based transparency logs |
| C2SP specifications (tlog-tiles, tlog-checkpoint, tlog-cosignature, signed-note): https://github.com/C2SP/C2SP | Log, checkpoint and witness formats for tlog and ledger |
| Go checksum database: https://sum.golang.org | Client-verified binary transparency |
| Guix grafts: https://guix.gnu.org/manual/en/html_node/Security-Updates.html | Grafts and their downsides |
| Guix full-source bootstrap: https://guix.gnu.org/en/blog/2023/the-full-source-bootstrap-building-from-source-all-the-way-down/ | Toolchain trust from a hex0 seed |
| Nix CA derivations milestone: https://github.com/NixOS/nix/milestone/35; Lix 2.93 deprecation: https://docs.lix.systems/manual/lix/2.93/release-notes/rl-2.93.html | Content-addressed outputs remain hard; keylos uses rebuilder-attested realisations |
| Trustix: https://tweag.io/blog/2020-12-16-trustix-announcement/ | Multi-party build attestation |
| Debian reproducibility gate: https://lwn.net/Articles/1072314/; https://reproduce.debian.net | Distribution-scale reproducibility is achievable |
| zstd:chunked: https://fedoraproject.org/wiki/Changes/zstd:chunked | Per-file partial pulls over OCI |
| xz-utils backdoor analysis: https://openwall.com/lists/oss-security/2024/03/29/4 | Source rules S1–S5 |
| Diverse double-compiling: https://dwheeler.com/trusting-trust/ | Toolchain cross-checks |

## Agents

| Source | Supports |
|---|---|
| The lethal trifecta: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/ | Why private data + untrusted content + exfiltration is the core risk |
| Agents Rule of Two: https://simonw.substack.com/p/new-prompt-injection-papers-agents | The Rule of Two enforced by broker and gate |
| The Attacker Moves Second: https://arxiv.org/abs/2510.09023 | Detection-based defenses fail; bound consequences instead |
| CaMeL: https://arxiv.org/abs/2503.18813 | Value-level provenance; flow proofs |
| FIDES: https://arxiv.org/abs/2505.23643 | Information-flow control for agents |
| Design Patterns for Securing LLM Agents: https://arxiv.org/abs/2506.08837 | Plan-then-execute, action-selector and related patterns |
| Claude Code auto mode: https://anthropic.com/engineering/claude-code-auto-mode | Approval rates (93%), classifier miss rates; classifiers only escalate |
| Claude Code sandboxing: https://code.claude.com/docs/en/sandboxing | State of agent sandboxing on Linux |
| GitHub MCP exfiltration: https://invariantlabs.ai/blog/mcp-github-vulnerability | Per-session scoped authority |
| postmark-mcp backdoor: https://koi.ai/blog/postmark-mcp-npm-malicious-backdoor-email-theft | Tools pinned by digest |
| MCP authorization (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization | Interop for MCP tools through gate |
| AgentCore Cedar policy: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html | Policy evaluated outside the agent |
| Agent action receipts draft: https://ftp.kaist.ac.kr/ietf/draft-sahu-agent-action-receipts-00.xml | Signed, hash-chained action logs |

## State, secrets and storage

| Source | Supports |
|---|---|
| try (OSDI '26): https://www.usenix.org/conference/osdi26/presentation/lamprou | Overlay transactions for commands |
| overlayfs index and hardlinks: https://lwn.net/Articles/751908/ | Mount options for transactional overlays |
| bcachefs leaves mainline: https://www.linuxjournal.com/content/bcachefs-ousted-mainline-kernel-move-dkms-and-what-it-means | Why btrfs is the default |
| btrfs fscrypt series: https://lkml.iu.edu/hypermail/linux/kernel/2602.0/09611.html | Per-unit keys in userspace until fscrypt lands |
| Secret Service weakness (CVE-2018-19358): https://gitlab.gnome.org/GNOME/gnome-keyring/issues/5 | vault with per-item ACLs keyed to generation identity |
| systemd-creds: https://man7.org/linux/man-pages/man1/systemd-creds.1.html | Per-service credentials, never in the environment |
| Provenance overhead study: https://arxiv.org/pdf/2608.11418 | Creation-time provenance only |
| systemd-homed: https://wiki.archlinux.org/title/Systemd-homed | Home directory model and its pitfalls |

## Related

- [Vision](../01-overview/vision.md)
- [Residual risks](../06-security/residual-risks.md)
- [Decisions](../11-decisions/README.md)
