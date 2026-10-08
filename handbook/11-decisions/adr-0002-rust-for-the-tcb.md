# ADR-0002: Rust for the trusted computing base

> Every component in the trusted computing base (warden, broker, gate, vault, ledger, depot, strata, config, hearth, portals, atrium, bench, boot's initrd tools) is written in Rust. Reused C components are confined in tier 0 with dedicated policies, and new C code is not added to the TCB.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Engineering | All TCB repos |

## Context

- Memory-safety bugs remain the dominant class of exploitable vulnerabilities in systems software. Both Microsoft and Chromium have reported about 70% of their serious security bugs as memory-safety issues (https://www.chromium.org/Home/chromium-security/memory-safety/).
- The keylos TCB parses untrusted input everywhere: capwire messages from sandboxed principals, OCI layers, Cap'n Proto, CBOR records, Wayland, TPM responses, DNS, HTTP through gate.
- 2024–2026 sandbox escapes in Flatpak and in AI agent harnesses were path-handling and confused-deputy bugs in trusted helpers (for example CVE-2026-34078, CVE-2026-39861). Those helpers must be small and correct. A language that makes ownership of fds and lifetimes explicit helps.
- The ecosystem pieces exist in Rust: capnp-rust, biscuit-auth, cedar-policy, rustls, Smithay, crosvm, ntpd-rs, tss-esapi, Wasmtime, nickel-lang.

## Decision

- Rust (edition 2024) for all TCB components, with an MSRV published per release.
- `#![forbid(unsafe_code)]` by default. `unsafe` only in designated modules (ancillary data, ioctls, FFI), each block with a safety comment, and covered by Miri or fuzzing where possible.
- Reused C components (systemd-boot, systemd-stub, libcryptsetup, tpm2-tss underneath tss-esapi, iwd, PipeWire, BlueZ) run confined, each in its own tier-0 principal with a dedicated seccomp and Landlock policy, or as build-time-only tools.
- Every parser of untrusted input has a fuzz target in CI (cargo-fuzz).

## Alternatives considered

| Option | Why not |
|---|---|
| C with hardening (FORTIFY, CFI, MTE) | Mitigates; does not remove the bug class |
| C++ | Same memory-safety exposure; heavier ABI story |
| Go | GC pauses in PID 1 and the compositor; larger binaries; weaker control over fds and threads at spawn time (fork/exec semantics) |
| Zig | Promising, but not memory-safe and a younger ecosystem for TPM, Wayland and Cap'n Proto |

## Consequences

### Positive
- Eliminates most memory-corruption bugs in the components that hold authority.
- Strong typing of fds (`OwnedFd`) fits the capability model.

### Negative
- Compile times and toolchain bootstrapping (Rust must come out of the full-source bootstrap chain; see [pkgs](../03-components/pkgs.md)).
- Reused C components remain. They are confined, not eliminated.

### Follow-ups
- Track replacements of reused C components where mature Rust alternatives appear.

## Related

- [ADR-0003: Stock kernel, feature levels](adr-0003-stock-kernel-feature-levels.md)
- [Residual risks](../06-security/residual-risks.md)
