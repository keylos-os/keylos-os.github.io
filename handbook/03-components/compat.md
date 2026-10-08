# compat

> The legacy tier. compat imports foreign software (OCI images, Flatpaks, distribution root filesystems) as `legacy-image` generations and runs it in an FHS view built by [warden](warden.md) inside a user namespace with nesting disabled.
> An open-broker turns `open()` calls on ungranted paths into powerbox prompts. X11 apps get a per-app nested Xwayland, and legacy D-Bus daemons live in islands. Software downloaded from the internet runs in tier 2.

**Status:** specified (v1.0) · **Spec:** [`compat/spec.md`](../../specs/compat/spec.md)

## Responsibilities

- **Import:** `importImage("oci://…" | "flatpak://…" | "rootfs:<dirfd>")` converts the image to a composefs `legacy-image` generation, records its origin, and marks it non-reproducible unless proven otherwise.
- **Run:**
  - `Compat.run(gen, argv, fds, grants)`;
  - a supervisor-built user namespace (65536-UID block, child `user.max_user_namespaces=0`);
  - an FHS view composed from store objects;
  - an idmapped home view containing only granted directories.
- **Open-broker:** seccomp user-notify with `ADDFD`. An `open()` of an ungranted path triggers a powerbox prompt, and the fd is injected on approval. The broker never follows paths for the target (invariant I7).
- **X11:** a per-app nested Xwayland, never the host's Wayland data-control.
- **D-Bus islands:** a private dbus-broker per legacy daemon or app (for example BlueZ, CUPS drivers), bridged to capwire by an adapter.
- **Placement:** imports from the internet or non-reproducible images default to tier 2 through [bench](bench.md).
- **Graduation:** a legacy package becomes native by shipping a manifest and passing the reproducibility gate.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Provides | `Compat` (`compat.capnp`) | Facets `user`, `service`, `admin` |
| Provides | `CompatIsland` (`compat-sys`) | Facet `adapter` (devd, portal-print, vault) |
| Consumes | warden (facet `compat`) | `LegacySpawn.spawnLegacy` (returns the seccomp-notify listener), `GrantMounts.idmappedDir` |
| Consumes | depot (facets `compat`, `mounter`) | Import `legacy-image` generations; mount them |
| Consumes | bench (facet `compat`) | Tier-2 placement of every imported image |
| Consumes | broker `powerbox`, `LabelAuthority` | Open-broker prompts and labels |
| Consumes | atrium `Display.xwaylandWm` (facet `display`) | Per-app Xwayland |
| Consumes | strata (facet `compat`), vault (facet `adapter`) | Legacy app units; imports from legacy secret stores |

<!-- generated:facets -->
## Facets served

From the facet registry ([protocols §19.2](../../specs/protocols/spec.md#192-facets)). A route names exactly one facet; the service exposes only that facet's methods.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| compat | `user` | kish, atrium launcher | `importImage`, `run` (own apps) |
| compat | `service` | warden routes for legacy services | `run` of tier-L legacy services |
| compat | `adapter` | devd, portal-print, portal-scan, vault | `CompatIsland` |
| compat | `admin` | owner `shell` | all, compat-local admin |
<!-- /generated:facets -->

<!-- generated:sysif -->
## System interfaces

Canonical schema files this repository serves ([protocols §7.5](../../specs/protocols/spec.md#75-system-interfaces)).

| File | File ID | Interfaces |
|---|---|---|
| [`compat-sys.capnp`](../../specs/protocols/spec.md#7515-compat-syscapnp) | `0xc7a1e5d3b2f4002e` | `CompatIsland` |
<!-- /generated:sysif -->

<!-- generated:receipts -->
## Receipts

Events this repository writes ([protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)): `legacy.import`, `legacy.open`.
Repository-specific extension events use the `x-<repo>.<event>` form and are listed in the repo spec.
<!-- /generated:receipts -->

## Runs as

A t0 service. Legacy principals are `legacy:<gen>@<user>/<session>`.

## Key decisions

- [ADR-0037: Legacy tier with FHS views](../11-decisions/adr-0037-legacy-tier-fhs-views.md)
- [ADR-0025: Namespaces only by warden](../11-decisions/adr-0025-namespaces-only-by-warden.md)
- [ADR-0035: fd-only portals and D-Bus islands](../11-decisions/adr-0035-fd-only-portals-dbus-islands.md)

## Limitations

- Each intercepted `open()` costs about 10–50 µs.
- Proprietary kernel modules are not supported on the integrity profile.

## Related

- [Legacy apps](../09-experience/legacy-apps.md)
- [Port a legacy app](../12-guides/port-a-legacy-app.md)
- [Namespaces](../06-security/namespaces.md)
