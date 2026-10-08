# Supply chain

> How a line of upstream source becomes a byte the kernel agrees to execute. Every link is pinned, built hermetically,
> rebuilt independently, logged publicly, signed per file, and checked again by the kernel on every page read.
> This page walks the chain end to end and names the component that owns each step.

Status: specified (v1.0). Components: [pkgs](../../specs/pkgs/spec.md), [forge](../../specs/forge/spec.md), [tlog](../../specs/tlog/spec.md), [depot](../../specs/depot/spec.md), with image assembly in [keylos](../../specs/keylos/spec.md).

![Supply chain from source to execution](../images/supply-chain.svg)

## The chain

| # | Step | Owner | What is guaranteed |
|---|---|---|---|
| 1 | Pin the source | `pkgs` recipe | Git commit and canonical tree digest; archives only with an explained tarball-vs-git diff |
| 2 | Evaluate the recipe | `forge` | Pure Nickel evaluation → derivation JSON → `drv:sha256:…` |
| 3 | Build | `forge` build VM | No network, masked CPU, fixed clock, tests invisible during build, generated files regenerated |
| 4 | Canonicalise | `forge` | Ownership, modes, timestamps, ordering fixed; setuid, devices, build paths rejected |
| 5 | Content-address | `depot` | Each file → object `obj:fsv256:…`; tree → composefs image `gen:fsv256:…` |
| 6 | Rebuild independently | rebuilders (`forge-rebuilder`) | k-of-n operators reproduce the same digest from source with their own bootstrapped toolchains |
| 7 | Log | `tlog` | Realisation attestations and release statements in witnessed append-only logs |
| 8 | Sign | release engineering (`forge-sign`) | Generation statement `keylos.genstmt/1` (Ed25519, release stream); release statement `keylos.release/1` |
| 9 | Distribute | TUF over OCI, resolved by `courier` (the only TUF client) | Freshness, anti-rollback, threshold root keys; partial object fetch |
| 10 | Install | `depot` | All of the above verified; capability diff consented (`keylos.consent/1`) |
| 11 | Execute | kernel (`kl-exec`) | composefs `verity=require` checks every file and page; `kl-exec` allows exec only from mounts warden registered after verifying the generation statement against the boot trust set |

## Sources: the rules that come from xz

The 2024 xz-utils backdoor lived in release tarballs and binary test fixtures, not in git, and reproducible builds would not have caught it. keylos applies five source rules:

| Rule | Mechanism |
|---|---|
| Build from git trees | Recipes pin `commit` and `tree` (canonical tar digest) |
| Explain every tarball difference | `forge srcdiff`; unexplained differences fail the build |
| Regenerate generated files | `configure`, `Makefile.in`, `m4` copies deleted and regenerated (`autoreconf -fi`) |
| Hide tests and blobs from the build | `testPaths` invisible in build VMs; blobs must be listed with reviewer |
| Budget tier-0 dependencies | `linkBudget` per tier-0 service; codecs via `dlopen` |

Plus process: two-party review, signed commits, elevated review for new maintainers, and a bot that watches upstreams for maintainer and release-process changes.

## Builds: hermetic by construction

A build runs in a crosvm microVM started from `io.keylos.build-vm`:

- no network device at all;
- dependencies mounted read-only at `/usr` as a composed view of parts;
- the guest clock starts at `SOURCE_DATE_EPOCH`, the CPU model is masked to the architecture baseline;
- the `check` phase runs in a second VM that cannot modify outputs.

Outputs are **parts**: trees installed at final paths (`/usr/lib/libz.so.1`). Generations are unions of parts. Because there are no hash-named prefixes inside binaries, the same part bytes are valid in every composition. This gives two properties:

- **Early cutoff.** Dependents reference parts by content digest. If a rebuild produces identical bytes, nothing downstream rebuilds.
- **Cheap emergency grafts.** Replacing a vulnerable library is a recomposition with an ABI-checked replacement part. Graft outputs carry `grafted: true` in their manifests, are flagged in every UI, expire within 30 days, and are always followed by a full rebuild.

## Language ecosystems in the same store

Lockfiles already contain content hashes. forge translates `Cargo.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, `pylock.toml`, `go.sum`, `Gemfile.lock` and `pixi.lock` into fixed-output fetches; language tools then run offline inside the build VM. Every crate, wheel or npm tarball is stored once and shared by every project.

## Signing and execution

Signing happens once per generation, and verification is split between userspace and the kernel:

| Layer | What | Who checks | Purpose |
|---|---|---|---|
| Generation statement (`keylos.genstmt/1`) | Signed by `release-stream/<stream>` (Ed25519), a publisher key, or an owner-seal key; binds the generation digest, manifest digest and the sorted object list of the closure | `depot` at install; `warden` (or `boot`) again before registering a mount with `kl-exec` | Decides launchability |
| composefs `verity=require` | One fs-verity digest commits to every file's content and metadata | The kernel, lazily on every open and page read | Bytes on disk can't drift from the verified image |
| `kl-exec` allow map | Superblocks of registered generation mounts | The kernel, on exec, mmap-exec, mprotect-exec and firmware/module reads | Nothing else can run, even for a compromised service |

There are no per-file kernel signatures: the kernel can't verify Ed25519, and one signature per store object would mean millions of signatures. Verifying one statement per generation in userspace, then letting the kernel enforce "only from verified mounts", gives the same guarantee. This is the basis of [reboot heals](reboot-heals.md).

## Your own code: seals

Code you build yourself runs in workbenches without any of this. To run it on the host, `forge seal` rebuilds it, asks for one FIDO2 touch that opens a sealing window (≤ 600 s, one project, listed derivations) through `HearthSeal.openWindow`, and gets a generation statement and a `keylos.seal/1` statement signed by your TPM-resident owner-seal key through `HearthSeal.sealSign`. See [Exec integrity and sealing](exec-integrity-and-sealing.md).

## Limitations

- Reproducibility proves the binary matches the source, not that the source is benign. Source rules and review reduce, but cannot remove, xz-class risk.
- k colluding rebuilders can attest a malicious build of benign source; operator independence is a governance control.
- Runtime string evaluation in interpreters (`eval`) and JIT engines are outside exec integrity.
- Firmware blobs ship as data generations with vendor provenance only.

## Related

- [Transparency and rebuilders](transparency-and-rebuilders.md)
- [Generation manifest](../04-contracts/manifest.md)
- [forge spec](../../specs/forge/spec.md) · [depot spec](../../specs/depot/spec.md) · [pkgs spec](../../specs/pkgs/spec.md) · [tlog spec](../../specs/tlog/spec.md)
- [ADR-0016 rebuilder quorum and transparency logs](../11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md)
- [ADR-0018 grafts are temporary](../11-decisions/adr-0018-grafts-are-temporary.md)
- [ADR-0019 source rules after xz](../11-decisions/adr-0019-source-rules-after-xz.md)
- [ADR-0042 one store for language ecosystems](../11-decisions/adr-0042-one-store-for-language-ecosystems.md)
