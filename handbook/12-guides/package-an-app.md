# Package an app

> Describe the app in `package.ncl`, build it hermetically in a workbench, test its grant and approval paths against the simulator, then publish a signed OCI artifact. The catalogue lists it only after independent rebuilders reproduce the same digest.

**Applies to:** `kind = app`, tier 1 (native) or tier 2. Specified in [sdk](../../specs/sdk/spec.md).

![Supply chain](../images/supply-chain.svg)

## 1. Create the project

```sh
$ kl-sdk init gui-rust ~/src/notes --name org.example.Notes --publisher "Example Org"
$ cd ~/src/notes
```

This writes `package.ncl`, `project.ncl` (the workbench), a starter `src/`, and `tests/open-and-save.scenario.ncl`.

## 2. Describe what the app needs

```nickel
let K = import "keylos/package@1" in
{
  name = "org.example.Notes",
  version = "1.0.0",
  kind = 'app,
  summary = "Plain-text notes with sync",
  license = "Apache-2.0",
  build = { language = 'rust, lockfiles = ["Cargo.lock"], check = [["cargo", "test", "--release"]] },
  entrypoints = { main = { exec = "/usr/bin/notes", kind = 'gui } },
  needs = {
    gpu = 'display,
    network = [{ host = "sync.example.org", ports = [443], proto = 'https, methods = ["GET", "PUT"], why = "Sync notes" }],
    services = ["portal-files", "portal-notify"],
    secrets = [{ name = "sync-token", why = "Authenticate to sync.example.org" }],
  },
  provides = { mime_types = ["text/plain"] },
} | K.PackageSchema
```

Rules to keep in mind:
- Every network request needs a `why`; it is shown to the user at install.
- Don't ask for `$HOME`. Files arrive through the powerbox.
- Don't read tokens from the environment. Use `app.secret("sync-token", …)`.

## 3. Use the runtime library

```rust
let app = keylos_sdk::App::from_env()?;
let file = app.pick_file(PickOptions::open("Open note").mime(["text/plain"]))?;   // powerbox
let token = app.secret("sync-token", "sync")?;                                     // vault, zeroised
let mut conn = app.http().put("https://sync.example.org/v1/notes/42").bearer(&token).body(text).send()?;  // through gate
app.notify("Synced", "Note 42 saved")?;
```

## 4. Generate and lint

```sh
$ kl-sdk gen          # .keylos/out/{manifest.json, cmdsig/, recipe.ncl}
$ kl-sdk lint
```

Commit `.keylos/out/`, so reviewers see capability changes in diffs.

## 5. Build in the workbench

```sh
$ kl-sdk build --release
```

The build runs `forge` inside the project workbench with networking disabled after fixed-output fetches. The result is a generation in your local store that runs only in workbenches until it is sealed or published.

## 6. Test with simulated authority

```nickel
# tests/sync.scenario.ncl
{
  seed = 7,
  grants = { network = ["sync.example.org:443/https"], secrets = { "sync-token" = "dGVzdA==" } },
  powerbox = [{ expect_kind = 'openFile, pick = "fixtures/note.txt" }],
  network = { "sync.example.org:443" = { kind = 'http, routes = [{ method = "PUT", path = "/v1/notes/42", status = 204 }] } },
  expect = { receipts = ["grant.issue", "net.connect"], exit = 0 },
}
```

```sh
$ kl-sdk test --tiers
```

`--tiers` runs the suite in tier 1 and, if the build is not reproducible, tier 2, and reports confinement differences.

## 7. Try it on the host

```sh
$ kl-sdk seal            # presence: touch your key; a 10-minute sealing window for this project
$ kl-sdk run --host
```

## 8. Publish

```sh
$ kl-sdk publish --to oci://ghcr.io/example/notes --key key:sha256:9c1e…
$ kl-sdk catalog submit
```

**What `publish` does:**
- Pushes the EROFS metadata image and store objects (zstd:chunked).
- Signs a DSSE statement.
- Attaches the SBOM and provenance as OCI referrers.

**What `catalog submit` does:**
- Sends only the recipe and source references.
- The catalogue's rebuilders build them independently. The app becomes installable once the quorum reproduces your `gen:` digest.

## 9. Updating

Bump `version`, regenerate, build and publish. If `needs` grows (a new host, a new service), users see a **capability diff** and must consent before the new version launches.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `kl-sdk build` exits 3: lockfile missing | `work run -- cargo generate-lockfile`, then commit `Cargo.lock` |
| Catalogue status `diverged` | Check `kl-sdk catalog status` for the diff report; usually timestamps or build paths. Use `SOURCE_DATE_EPOCH` and avoid embedding absolute paths |
| App can't reach a host | Add it to `needs.network` with a `why`; runtime misses trigger T2 prompts |

## Related

- [sdk spec](../../specs/sdk/spec.md)
- [Write a service](write-a-service.md)
- [Seal a tool](seal-a-tool.md)
- [ADR-0016 Rebuilder quorum and transparency logs](../11-decisions/adr-0016-rebuilder-quorum-and-transparency-logs.md)
- [ADR-0042 One store for language ecosystems](../11-decisions/adr-0042-one-store-for-language-ecosystems.md)
