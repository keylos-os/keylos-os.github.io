# ADR-0021: Nickel for configuration

> System configuration, service schemas, package recipes and project workbench files (`project.ncl`) are written in Nickel. Nickel has contracts and gradual typing, has merge semantics designed for modular configuration, and embeds as a Rust library.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | State | config, forge, pkgs, bench, keylos, sdk |

## Context

- NixOS modules are the largest typed config corpus, with thousands of options. The Nix evaluator is slow and memory-hungry (≈0.8–1.5 GB RSS for modest configs, https://discourse.nixos.org/t/nix-eats-more-than-1-5-gib-ram-during-updates/79052), and the language has a steep learning curve.
- Candidates:

  | Language | Notes |
  |---|---|
  | Nickel | Contracts, gradual typing, merge system for modules; written in Rust |
  | Pkl | Most institutional adoption (https://docs.publishing.service.gov.uk/repos/govuk-infrastructure/architecture/decisions/0022-use-pkl-for-configuration.html); JVM/native-image toolchain |
  | CUE | Unification, good for validation |
  | KCL | Kubernetes-centric |
  | Dhall | Total, but the ecosystem has stalled |
- keylos's config compiler is in the TCB and written in Rust ([ADR-0002](adr-0002-rust-for-the-tcb.md)). Embedding the evaluator matters.

## Decision

- Nickel for all configuration and recipes. The evaluator is embedded in config and forge and runs confined with no network.
- Service schemas are Nickel contracts shipped inside service generations, seeded from nixpkgs module option definitions (as data, not by using the Nix evaluator).
- Strict validation: a config generation can't be signed if it fails its schemas.
- Outputs render to each service's native format.

## Alternatives considered

| Option | Why not |
|---|---|
| Nix language | Evaluator cost; learning curve |
| Pkl | JVM/GraalVM toolchain in the TCB |
| CUE | Weaker for modular overrides and functions |
| YAML/TOML + JSON Schema | No abstraction, no merging; drift-prone |

## Consequences

### Positive
- One typed language across config, recipes and projects. Good error messages via contracts.

### Negative
- A smaller ecosystem and a new language to learn. The schema corpus must be built (seeded from nixpkgs).

## Related

- [Configuration generations](../08-state/config-generations.md)
- [config](../03-components/config.md)
- [ADR-0022: Read-only /etc via confext](adr-0022-read-only-etc-confext.md)
