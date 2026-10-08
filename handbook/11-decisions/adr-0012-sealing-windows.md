# ADR-0012: Sealing windows

> One owner-presence touch can authorise a **sealing window** of at most 600 s, scoped to one project directory and an explicit list of derivations. During it, forge may rebuild and seal outputs for host execution without further touches. The window is a presence-signed `keylos.seal-window/1`, and every `keylos.seal/1` statement names it.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Integrity | forge, depot, hearth, kish, atrium |

## Context

- [ADR-0008](adr-0008-host-executes-only-sealed-code.md) requires host code to be sealed. Developers who build host tools iteratively would otherwise need a touch per build, and that much friction trains people to tap without reading.
- An unbounded window would let malware seal arbitrary code after one touch.
- The owner-seal key is TPM-resident and gated by `PolicySecret` on the owner's NV seal gate, whose auth hearth rotates with FIDO2 `hmac-secret` each window ([ADR-0011](adr-0011-owner-presence-fido2.md)). A window is one touch that both signs the window document and unlocks the gate for a bounded time and scope.

## Decision

- `kish seal` / `forge seal --window 600s --project <dir> --drv <list>` shows on the trusted path: the project, the derivations (or patterns limited to that project's recipes), source tree hashes and the duration.
- One touch opens the window. forge rebuilds hermetically (not reusing workbench outputs) and seals each output whose `drv` is in scope.
- Maximum 600 s, one project. The window closes on screen lock, suspend or logout; at close hearth rotates the gate auth.
- The window is opened with `HearthSeal.openWindow` (a presence-signed `keylos.seal-window/1`: owner, project, derivations, opened, expires, machine, ID), and seals are signed only through `HearthSeal.sealSign`. A seal statement is valid only if its `drv` is in the window's list and its `sealedAt` lies inside the window.
- Each seal statement includes `window`, `windowDigest` and `sourceTree`. ledger records `seal.window` and `gen.seal` receipts.

## Alternatives considered

| Option | Why not |
|---|---|
| Touch per seal | Fatigue and training to tap blindly |
| Persistent "trusted developer" mode | Equivalent to disabling I1 |
| Sign with a software key after login | Malware in the session can use it |
| Let workbench outputs run on the host unsealed | Breaks "reboot heals" |

## Consequences

### Positive
- Practical host tooling for developers without weakening I1 permanently.
- Every sealed artifact traces to one touch, a source tree and a scope.

### Negative
- A malicious change in the project during the window can get sealed. Mitigation: hermetic rebuild from a committed source tree, and the window shows source hashes.
- Adds complexity to forge and hearth.

## Related

- [Seal a tool](../12-guides/seal-a-tool.md)
- [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md)
- [ADR-0011: Owner presence via FIDO2](adr-0011-owner-presence-fido2.md)
