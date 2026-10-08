# keylos website

Public project site at **https://keylos-os.github.io/**, with the engineering handbook at **https://keylos-os.github.io/handbook/**.

The homepage is a technical introduction to the agent workstation. Five example requests explain file grants, credential access, labels, effect approval and recovery, with implementation status and handbook references. The request explorer is explanatory: it does not evaluate policy, execute commands or connect to a VM.

## Hosting

GitHub Pages publishes the `main` branch, repository root. `.nojekyll` keeps the site static. No custom domain, build service, analytics, third-party scripts or runtime dependencies are required.

The component implementation repositories remain separate. This repository contains website assets, an explicitly published handbook snapshot and component **specification Markdown only**.

## Local preview

```sh
python3 -m http.server 8789 --bind 127.0.0.1
```

Open `http://127.0.0.1:8789/`. The handbook uses `fetch`, so serve it over HTTP rather than opening HTML files directly.

## Editing the landing page

- `index.html`: introduction, request explorer, system boundaries, status and reading routes.
- `styles.css`: responsive visual design and reduced-motion behavior.
- `site.js`: the five request examples and their component paths.
- `assets/keylos-mark.png`: project mark.

Keep the early-development status visible. Update the status snapshot from actual implementation reports; specification versions are not released OS versions. Do not describe illustrative terminal output as a running demonstration.

## Updating the handbook and specification snapshots

The builder expects this repository beside `docs/` and the component repositories in a Keylos workspace:

```sh
python3 scripts/build-handbook.py --include-specs
```

For a different workspace location:

```sh
python3 scripts/build-handbook.py --workspace /path/to/keylos --include-specs
```

This copies an allowlist of handbook content and exact component `spec.md` files. It adapts the reader and links for this public site; it does not change the source documentation. Implementation code, Git data and internal development files must not be copied into the published snapshot.

Review the generated diff before committing and pushing. This repository intentionally uses checked-in snapshots, so GitHub Pages does not need credentials to private repositories. Rebuilding without `--include-specs` produces a handbook-only snapshot with publication notices for unavailable specifications.

## Checks before publishing

- Check HTML links and local asset paths, including handbook/spec cross-links.
- Exercise all request buttons and the additional-use disclosure with keyboard and pointer input.
- Check narrow mobile, tablet and desktop widths and reduced-motion mode.
- Confirm that no private-repository links, credentials, development fixtures or implementation files slipped into the publication set.
- Verify the public root, handbook and representative specification after Pages deploys.

## A future live demo

The current site is entirely static. GitHub Pages would host the UI for a live demo, while an independently operated HTTPS/WebSocket service would host its sessions.

A proposed invite-only demo uses one Keylos VM with a separate non-owner account, confined terminal session, workspace and resource limits for each visitor. This needs a browser-to-Hearth session bridge, PTY integration, reconnect/expiry handling and verified isolation between users. Regular non-owner demo accounts are needed for Loom because it currently refuses guest enrollment. Use synthetic fixtures and no production credentials; the machine shares a kernel and its reboot affects all visitors. Provisioning an AWS backend is a separate task.
