# Generation manifest

> Every generation carries `/.keylos/manifest.json`, a signed declaration of what it is and what authority it asks for.
> The manifest drives installation consent, the capability diff on updates, tier placement, and the grants the broker is
> willing to mint. This page explains the format; the normative schema is `protocols §6`.

Status: specified (v1.0). Owners: [protocols](../../specs/protocols/spec.md) (schema), [depot](../../specs/depot/spec.md) (validation, diff, consent), [forge](../../specs/forge/spec.md) (generation).

## What a manifest is for

| Consumer | Uses the manifest to |
|---|---|
| `depot` | Validate the generation, compute the capability diff, request consent, decide launchability |
| `warden` | Choose the tier, build the mount view, wire service routes, apply the JIT exception |
| `broker` | Turn `needs` requests into grants at install time or on first use |
| `kish` / `aide` | Find commands (`provides.commands`) and their signatures (`/.keylos/cmdsig/`) |
| `atrium` | Show the app, its MIME types and URI schemes, and its permissions |
| `gate` | Know which effect kinds the app may stage |

## Kinds

| Kind | Launchable by | Tier | Example |
|---|---|---|---|
| `os` | `boot` | — | `io.keylos.os.desktop` |
| `runtime` | (mounted under apps) | — | `io.keylos.runtime.gtk` |
| `app` | `warden` | 1, 2 or L | `org.mozilla.Firefox` |
| `service` | `warden` | 0 | `io.keylos.service.vault` |
| `agent-template` | `aide` → `bench` | 3 | `io.keylos.agent.coding` |
| `bench-image` | `bench` | 2/3 | `io.keylos.workbench-dev` |
| `legacy-image` | `compat` | 2 (imported) or L (forge-built, reproducible, trusted key) | imported Debian rootfs |
| `config` | `boot`, `config` | — | config generation 57 |
| `policy` | `broker` | — | Cedar policy set |
| `data` | `warden` (ro bind) | — | fonts, models, datasets |
| `part` | `forge`, `bench` (store mounts) | — | build intermediates: libraries, headers, toolchain parts |

## Anatomy

```json
{
  "schema": "keylos.manifest/1",
  "kind": "app",
  "name": "org.example.Editor",
  "version": "2.5.0",
  "derivation": "drv:sha256:…",
  "runtime": "gen:fsv256:…",
  "tier": 1,
  "entrypoints": { "main": { "exec": "/usr/bin/editor", "kind": "gui" } },
  "needs": {
    "jit": false,
    "gpu": "render",
    "network": [{ "host": "api.example.com", "ports": [443], "proto": "tcp", "methods": ["GET","POST"], "why": "Sync" }],
    "listen": [],
    "services": ["portal-files"],
    "secrets": [{ "name": "sync-token", "why": "Account sync" }],
    "dataUnits": ["default"],
    "portalIsland": false
  },
  "provides": { "commands": ["editor"], "mimeTypes": ["text/plain"] },
  "effects": [],
  "l10n": { "default": "en", "languages": ["en", "uk", "de"] },
  "compat": null,
  "agent": null,
  "grafted": false,
  "reproducible": true
}
```

| Field group | Meaning |
|---|---|
| Identity: `schema`, `kind`, `name`, `version` | Reverse-DNS name, SemVer version |
| Provenance: `derivation`, `reproducible`, `publisher` | Links the generation to the build that produced it; non-reproducible forces tier ≥ 2 |
| Placement: `tier`, `runtime`, `requiresFeatureLevel` | Where and on which kernel feature level it runs |
| Authority requests: `needs.*` | Requests, never grants; the broker decides |
| Offers: `provides.*`, `effects` | What it exports (commands, services, MIME handlers, agent tools) and which effect kinds it may stage |
| Presentation: `l10n` | Default language and translations in `/.keylos/l10n/<lang>.json`; display code applies bidi isolation and confusable checks |
| Kind-specific: `compat`, `agent` | `keylos.compat/1` for `legacy-image`; the agent template pointer and `flowProof` for `agent-template` |
| Emergency: `grafted` | True for outputs of an emergency graft; flagged in every UI and replaced by the real rebuild |
| Extensions: `x-*` | Ignored by verifiers and never carry authority |

Rules that matter in practice:

- Unknown fields are rejected unless prefixed `x-`. This keeps verifiers strict and makes accidental capability fields impossible.
- `needs.network[]` is per host, port, protocol and HTTP method. `"*"` hosts exist (browsers) and are rendered prominently at consent.
- `needs.jit: true` is limited to an allowlist in `pkgs` and always shown at install.
- `needs.listen[]` (`port`, `proto`, `scope`: `loopback`/`lan`/`any`) asks for inbound listening; it is granted only through gate `listen:` targets and net firewall plumbing.
- `needs.portalIsland: true` runs a GTK/Qt portal shim inside the app's own principal; it grants no authority.
- Entrypoint kinds are `gui`, `cli`, `service`, `harness`, `handler` (spawned by portal-openuri) and `notify-action` (spawned when a notification action is activated).
- The effective tier is `max(manifest.tier, policy floor, token tier_floor)`; policy floors are config options `apps.<name>.tierFloor`. Nothing can lower it.
- `reproducible: false` forces tier ≥ 2 unless an owner exception record (`keylos.exception/1`) exists.

## The capability diff

On every update `depot` compares the installed capability set with the new one, field by field. Widening needs consent; narrowing and neutral changes do not.

| Field | Widening when |
|---|---|
| `tier` | Moves to a less isolated tier |
| `needs.jit` | Turns on |
| `needs.gpu` | `none` → `display` → `render` |
| `needs.network` | A new host, port, protocol or method appears |
| `needs.listen` | A new port appears, or the scope widens |
| `needs.devices`, `services`, `secrets`, `spawn` | A new element appears |
| `effects` | A new kind appears, or a class is lowered |
| `provides.services`, `provides.agentTools` | A new element appears |

The trusted path shows the diff as lines such as:

```
+ network: api.analytics.example.com:443/tcp GET,POST  (why: "Usage analytics")
+ jit: true
- services: portal-camera
```

Approval tier: T2 for most widenings, T3 when the diff adds JIT, devices, an irreversible effect kind, or relies on an owner tier exception. The result is a consent record (`keylos.consent/1`, signed by depot) that covers later generations of the same name and publisher whose capability set is a subset, so routine updates are silent. Consent never makes code launchable on its own; that needs an authorising generation statement.

## Where the manifest lives and how it is protected

- Inside the generation image at `/.keylos/manifest.json`. Its bytes are covered by the image's fs-verity digest, which is the generation ID.
- The generation statement (`keylos.genstmt/1`) signed by the release stream, a publisher, or the owner seal binds the image digest and the manifest digest.
- Manifests are therefore as tamper-evident as the code they describe; a modified manifest is a different generation.

## Companion files

| Path | Content |
|---|---|
| `/.keylos/cmdsig/<command>.json` | Command signatures (`keylos.cmdsig/1`) for typed pipes and agent tools |
| `/.keylos/sbom.spdx.json` | SBOM generated by forge from part metadata |
| `/.keylos/provenance.json` | SLSA provenance plus realisation attestations and `keylos.tlogproof/1` log proofs |
| `/.keylos/l10n/<lang>.json` | Localised summary, entrypoint names and `why` strings |
| `/.keylos/agent/` | Agent templates only: `template.json`, `prompt.md`, `tools.json`, `policy.json`, harness component |

## Limitations

- `needs` describes what an app asks for; it cannot prove the app does not misuse what it gets. Labels and the Rule of Two limit flows, not intent.
- Wildcard network hosts (`*`) are necessary for browsers and make their egress policy coarse; browsers rely on their own site isolation within the tier.

## Related

- [Supply chain](../05-integrity/supply-chain.md)
- [Transparency and rebuilders](../05-integrity/transparency-and-rebuilders.md)
- [depot spec](../../specs/depot/spec.md) · [forge spec](../../specs/forge/spec.md) · [protocols spec](../../specs/protocols/spec.md)
- [ADR-0007 composefs and fs-verity store](../11-decisions/adr-0007-composefs-fsverity-store.md)
- [ADR-0043 non-reproducible means tier 2](../11-decisions/adr-0043-non-reproducible-means-tier-2.md)
