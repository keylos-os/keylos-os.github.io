# Seal a tool

> Your own scripts and binaries run freely in workbenches. To run one on the host, rebuild it hermetically and **seal** it with your owner key: one FIDO2 touch opens a sealing window of at most 600 s scoped to one project. Sealed generations are trusted on the host (warden registers them with `kl-exec`) until you remove them.

**Status:** specified (v1.0). See [sdk](../../specs/sdk/spec.md) and [protocols §11.6](../../specs/protocols/spec.md#116-owner-seal).

## When to seal

| Situation | Do |
|---|---|
| A tool you use only while developing | Keep it in the workbench (`work run -- mytool`) |
| A personal CLI you want in your host shell | Seal it |
| Something you want others to install | Publish it instead ([Package an app](package-an-app.md)) |

## Steps

1. Give the tool a package description:

   ```sh
   $ cd ~/src/dotfiles-tools
   $ kl-sdk init cli-rust . --name me.alice.Tidy
   ```

   Declare the command signature through the derive or `commands` in `package.ncl`, so `kish` passes file arguments as fds.

2. Build:

   ```sh
   $ kl-sdk build --release
   ```

3. Seal:

   ```sh
   $ kl-sdk seal
   ```

   **What happens:**
   - atrium shows a presence prompt with the project, source tree digest and derivation.
   - You touch your security key.
   - hearth (`HearthSeal.openWindow`) checks the presence-signed `keylos.seal-window/1` and uses the same touch's FIDO2 `hmac-secret` output to unlock your NV seal gate (`0x01300140+i`), which authorises the TPM-held owner-seal key (`0x81000140+i`) for at most 600 s, for this project and these derivations only.
   - hearth signs the seal statement and the generation statement (`HearthSeal.sealSign`); depot attaches them to the generation. When the window closes, hearth rotates the gate auth.
   - The host already trusts your owner-seal key: its public key is in your config generation (`/etc/keylos/owner-seal/<i>.spki`) and enters the boot trust set at every boot. warden verifies the generation statement against it before registering the mount with `kl-exec`.

4. Install it into your profile and use it:

   ```sh
   $ tidy ~/Downloads        # kish passes ~/Downloads as a dirfd
   ```

## What the seal records

```json
{"schema":"keylos.seal/1","generation":"gen:fsv256:…","drv":"drv:sha256:…",
 "sourceTree":"src:sha256:…","sealedAt":"2026-10-07T21:30:00Z","machine":"key:sha256:…",
 "window":"w-…","windowDigest":"sha256:…"}
```

The window and the statement are receipted (`seal.window`, `gen.seal`) in the ledger. Running `why $(which tidy)` shows who sealed it and from which source.

## Several builds in one touch

Within the window (at most 600 s), further `kl-sdk seal` calls **in the same project** succeed without another touch, as long as their derivations were listed when the window opened (`kl-sdk seal --all` lists every package in the project). A different project, or a derivation not in the list, needs a new touch.

## Removing trust

```sh
$ depot unroot gen:fsv256:… --holder profile:alice
```

The generation becomes unlaunchable after garbage collection. To revoke all owner seals at once (for example after a compromise), rotate the owner-seal key through `hearth`. That needs presence and bumps the config counter.

## Limitations

- Sealing does not review code. It records that you chose to trust this exact build.
- JIT runtimes (for example a Node-based tool) also need `needs.jit = true`, which is shown when sealing.
- Interpreted scripts run on the host only when sealed. The keylos interpreters enforce this with `AT_EXECVE_CHECK`.

## Related

- [Developer workbench](../09-experience/developer-workbench.md)
- [sdk spec](../../specs/sdk/spec.md)
- [ADR-0012 Sealing windows](../11-decisions/adr-0012-sealing-windows.md)
- [ADR-0008 Host executes only sealed code](../11-decisions/adr-0008-host-executes-only-sealed-code.md)
- [ADR-0011 Owner presence with FIDO2](../11-decisions/adr-0011-owner-presence-fido2.md)
