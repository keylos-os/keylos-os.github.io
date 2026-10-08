# sdk

> The developer kit for keylos-native apps, services, commands and agent templates. It covers manifest and cmdsig authoring and validation, capwire client helpers for every interface, packaging into generations through [forge](forge.md), signing with publisher keys or Sigstore identities, and a test harness that runs a component under the real confinement baseline.

**Status:** specified (v1.0) · **Spec:** [`sdk/spec.md`](../../specs/sdk/spec.md)

## Responsibilities

- **Crates:** ergonomic wrappers over `keylos-schemas`, for example:
  - receive passed fds from `KEYLOS_CAPWIRE_FDS` and `KEYLOS_ARGFD_*`;
  - request grants;
  - use the powerbox;
  - stage effects;
  - emit structured logs;
  - produce CBOR-sequence records on typed pipes.
- **CLI (`keylos-sdk`):** `new` (templates for app, service, command and agent template), `manifest check`, `cmdsig check`, `build` (forge), `run` (local confined run), `sign`, `publish` (OCI + referrers), `diff-capabilities`.
- **Test harness:** run under warden's baseline with a fake broker/gate (deterministic approvals), a capwire recorder, conformance vectors from [protocols](protocols.md), and confinement-report assertions.
- **Language bindings:** Rust first-class. C ABI and Python/TypeScript bindings generated from the capnp schemas.
- **Docs:** API reference and examples. Tutorials live in the handbook guides.

## Interfaces

Consumes every public protocols interface as a client. Provides none at runtime.

## Key decisions

- [ADR-0001: Multi-repo, protocols is the only coupling](../11-decisions/adr-0001-multi-repo-protocols-only-coupling.md)
- [ADR-0036: Typed pipes via cmdsig](../11-decisions/adr-0036-typed-pipes-via-cmdsig.md)

## Related

- [Package an app](../12-guides/package-an-app.md)
- [Write a service](../12-guides/write-a-service.md)
- [Write an agent template](../12-guides/write-an-agent-template.md)
- [Manifest](../04-contracts/manifest.md)
