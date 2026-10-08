# ADR-0007: composefs + fs-verity content-addressed store

> Every file keylos installs is an fs-verity-enabled object in one content-addressed store. Every installable unit (OS, runtime, app, service, agent template, bench image, config, policy, data) is a composefs generation: an EROFS metadata image whose fs-verity digest is its identity.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Store | depot, boot, warden, bench, compat, forge, courier |

## Context

- composefs puts all metadata in an EROFS image. Each file is an overlay metacopy pointing to a backing object whose expected fs-verity digest is stored in `trusted.overlay.metacopy`. Mounting with the image digest and `verity=require` (kernel ≥ 6.6) makes **one 32-byte digest commit to the whole tree**, enforced lazily at access time (https://github.com/containers/composefs/blob/main/README.md).
- dm-verity gives the same integrity at block level, but with fixed partitions and no file-level dedup across images.
- The Nix and Guix stores give dedup and multi-version coexistence, but have no runtime integrity: a substituted path can be modified by root without detection, and signatures exist only at the binary-cache layer (https://docs.tvix.dev/rust/nix_compat/narinfo/index.html).
- Flatpak runtimes proliferate. AppImage bundles duplicate libraries.
- bootc's composefs-native sealed images are still experimental (https://github.com/bootc-dev/bootc/pull/1706), so keylos owns its implementation in depot.

## Decision

- Object store at `/store/objects/<2>/<62>`, every object with fs-verity and mode 0444, written only by depot.
- Generations at `/store/gens/<digest>.erofs`, with `/.keylos/manifest.json` and optional cmdsig, SBOM and provenance.
- One store for everything, including language-ecosystem artifacts ([ADR-0042](adr-0042-one-store-for-language-ecosystems.md)).
- The OS generation digest goes on the signed UKI cmdline. Other generations are authorised by generation statements verified in userspace against the boot trust set, and executed only from mounts warden has registered with the `kl-exec` BPF LSM ([ADR-0008](adr-0008-host-executes-only-sealed-code.md)). No fs-verity builtin signatures are used.
- Distribution as OCI artifacts with zstd:chunked per-file TOCs, so clients fetch only missing objects.

## Alternatives considered

| Option | Why not |
|---|---|
| dm-verity images only | No cross-image dedup; partition sizing; every app as a block image is heavy |
| Nix/Guix store as-is | No runtime integrity; Nix CA derivations still experimental (https://github.com/NixOS/nix/milestone/35) |
| OSTree | Verification at pull time only (unless composefs-backed), GPG-centric signing |
| Flatpak runtimes | Runtime proliferation; separate store from the OS |

## Consequences

### Positive
- Cross-image dedup with kernel-enforced integrity.
- One identity scheme for everything that runs.

### Negative
- Depends on overlayfs metacopy and composefs semantics; kernel bugs there are in the TCB.
- fs-verity requires filesystem support (btrfs supports it).
- Custom tooling instead of an upstream image tool.

## Related

- [depot](../03-components/depot.md)
- [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md)
- [Manifest](../04-contracts/manifest.md)
