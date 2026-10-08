# config

> System configuration as typed source. config evaluates Nickel against a schema per service, renders native config files, packs them as a confext generation, and applies it only after the owner signs the plan with a FIDO2 touch.
> `/etc` is read-only. Changes are transactions with history, revert and drift reports, and agents can only propose them.

**Status:** specified (v1.0) · **Spec:** [`config/spec.md`](../../specs/config/spec.md)

![Config apply](../images/config-apply.svg)

## Responsibilities

- **Source:** a git repository of Nickel modules, with service schemas shipped inside service generations.
- **Plan:** `Config.propose(source, origin)` evaluates and validates (generations can't be signed if they fail their schemas) and renders a `Plan`: file diff, service restarts, capability changes.
- **Apply:**
  - `Plan.apply` asks for presence through [hearth](hearth.md) and [atrium](atrium.md);
  - signs `keylos.configgen/1` with `counter = NV 0x01300101 + 1`;
  - builds the confext generation in [depot](depot.md);
  - bumps the NV counter;
  - reloads or restarts the affected services.
- **History and revert:** every generation is kept. `revert` produces a new plan, so it is still signed and counted, never a rollback of the counter.
- **Drift:** compare rendered output with what's live, plus the mutable app layers.
- **Adopt:** `adopt(app)` diffs an app's mutable config layer against the declaration and proposes a patch.
- **Policy:** Cedar policy and Biscuit authorizer templates are authored here and compiled into `policy` generations for [broker](broker.md).

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Config`, `Plan` (`config.capnp`) | Facets `owner`, `user`, `propose`, `read` |
| Provides | `ConfigFleet` (`config-sys`) | Facet `fleet` |
| Consumes | atrium `TrustedPrompt.presence`, hearth `presence` | Presence-signed `keylos.configgen/1` |
| Consumes | depot (facet `config`) | `importTree` of `config` and `policy` generations; `mount` of `config` |
| Consumes | broker `BrokerSystem.loadPolicy`, `validatePolicy` | Policy activation |
| Consumes | warden `Supervisor.control` (facet `admin`) | Reloads through `ServiceHost.reload` |
| Consumes | TPM NV `0x01300101` | Config counter (AUTHWRITE, auth sealed to config) |
| Consumes | ledger (facet `writer`) | Receipts |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| config | `owner` | owner `shell` | all, incl. `Plan.apply` |
| config | `user` | non-owner `shell`s | `current`, `history`, `drift`, `adopt` (own apps), `propose` |
| config | `propose` | aide | `propose` (with origin), `current` |
| config | `fleet` | fleet | `ConfigFleet`, `current`, `drift` |
| config | `read` | courier, journal | `current`, `history` |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`config-sys.capnp`](../../specs/protocols/spec.md#7514-config-syscapnp) | `0xc7a1e5d3b2f4002d` | `ConfigFleet` |
<!-- /generated:sysif -->

## Runs as

A t0 service with the vault `admin` facet and TPM NV access to the config counter. Nickel evaluation runs in a confined child process with no network.

## State

| Path | Content |
|---|---|
| `/var/lib/config/repo/` | The config git repository (human-owned; agents propose via workbench forks) |
| `/store/gens/` | Config and policy generations (through depot) |
| TPM NV `0x01300101` | Config counter (AUTHWRITE; incremented only after the signed generation is durably in the store) |

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `config.plan`, `config.apply`, `config.revert`, `config.activation-rollback`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Key decisions

- [ADR-0021: Nickel configuration](../11-decisions/adr-0021-nickel-configuration.md)
- [ADR-0022: Read-only /etc via confext](../11-decisions/adr-0022-read-only-etc-confext.md)
- [ADR-0029: Agents propose, humans sign](../11-decisions/adr-0029-agents-propose-humans-sign.md)

## Related

- [Configuration generations](../08-state/config-generations.md)
- [Write policy](../12-guides/write-policy.md)
- [Reboot heals](../05-integrity/reboot-heals.md)
