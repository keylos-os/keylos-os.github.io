# Reboot heals

> keylos's central integrity claim: reboot restores verified code and owner-approved configuration. Writable state may still contain hostile data and may require quarantine or recovery.
> This page states the argument precisely, shows which mechanism closes each persistence path, and lists honestly what still breaks it.

**Status:** specified (v1.0). The property emerges from [boot](../../specs/boot/spec.md), [warden](../../specs/warden/spec.md), [config](../../specs/config/spec.md), [depot](../../specs/depot/spec.md) and [courier](../../specs/courier/spec.md).

## The claim

> Reboot restores verified code and owner-approved configuration. Writable state may still contain hostile data and may require quarantine or recovery.

Precisely: after any compromise of userspace that does not include a kernel, firmware or hardware exploit, the next boot executes exactly the same sealed bytes and the same owner-signed configuration as before the compromise. The claim is about **code and configuration integrity**. It is not a claim that the workload can safely resume over whatever data the compromise left behind (protocols §9, [ADR-0008](../11-decisions/adr-0008-host-executes-only-sealed-code.md)).

## Why it holds

To persist, malware needs something the next boot will execute or obey. keylos closes every such path:

| Persistence path on ordinary Linux | keylos mechanism | Result |
|---|---|---|
| Modify a binary or library in `/usr` | `/` is a composefs generation pinned by the signed cmdline; `verity=require` | The modified file fails verification at open |
| Drop a binary in `$HOME`, `/var`, `/tmp` and arrange for it to run | Writable mounts are `noexec`; `kl-exec` allows only allowed generation mounts | It cannot execute |
| Script in `.bashrc`, a cron file, an autostart entry | Interpreters check `AT_EXECVE_CHECK`; services and agents cannot run interactive code; the shell's startup files live in the signed config generation, not in `$HOME` | Not executed, or executed only from sealed files |
| Edit `/etc` (a systemd unit, an LD_PRELOAD, PAM) | `/etc` is a read-only confext of an owner-signed config generation | Cannot be changed at runtime; a new generation needs a FIDO2 touch |
| Roll the config back to an older signed generation | TPM NV config counter (`0x01300101`) | The older generation is refused at boot |
| Install a malicious package | Installs must be signed (stream, publisher or owner seal), pass the rebuilder quorum, and show a capability diff | No signature, no launch |
| Replace the kernel, initrd or boot loader | Secure Boot (owner keys), PCR11 signed policy, phone verification | Firmware refuses, or the TPM refuses to unseal, or the phone shows NOT VERIFIED |
| Downgrade to an old vulnerable release | The TPM os-floor (`0x01300102`) is inside the signed policy | The old release cannot unlock |
| Roll the ledger, keystore or snapshots back to hide evidence | NV counters `0x01300100`, `0x01300104`, `0x01300107` | Detected at the next start |
| Persist in a service's state database | State is data: never executed, parsed by services that run sealed code | Only a parser bug can be triggered (see below) |
| Hide in a backup or snapshot | Restored data is still data | Same as above |
| Plug in a USB stick with a crafted filesystem or a fake keyboard | Unauthorized until approved; removable filesystems parsed only in a media VM | The host kernel never parses it; a fake keyboard can't approve itself |
| Load a kernel module | Only release-signed modules from the OS or `kmod` generations | No owner or attacker path to kernel code |
| Break config activation to force an older config | Activation failure leads to a recovery revert signed by an owner, never an automatic fallback | The counter still refuses older generations |

The only state a compromise can change is **data**: home directories, `/var`, app data. The host never executes data, but sealed code still parses it, so hostile data is the one persistence path that remains (next section).

## What still breaks it

| Residual path | Why it remains | Mitigation |
|---|---|---|
| Kernel exploit with persistence (for example writing firmware or a bootkit) | The kernel is trusted | Measured boot makes firmware changes visible to the phone and to `courier`; untrusted code runs in VMs, which shrinks reachable kernel surface |
| Firmware or hardware implants | Below the OS | Out of scope; PCR0/2 changes are reported |
| Poisoned data that re-triggers a parser bug at every boot | Services and apps parse writable state at startup and when a session is restored | Services are Rust; risky parsers run in separate sandboxed workers (for example the crash unwinder, thumbnailers); fuzzing in CI; safe start and quarantine (below) |
| The owner seals malicious code | Sealing is the owner's decision | Presence prompt shows source, diff and provenance; seals are receipted |
| N colluding approvers seal malicious code on a quorum machine | Quorum presence replaces the touch on headless profiles | Status shows `sealing: quorum`; seals are receipted with every approver |
| The owner approves a malicious config generation | Same | Plan rendering shows every capability change |
| JIT generations exploited at runtime | W^X exception by design | Not persistent by itself; it needs one of the paths above to survive |

## Safe start and quarantine

Restoring code and configuration integrity is not the same as safely resuming a workload over potentially hostile state. When a compromise seems to come back after a reboot, the owner chooses **safe start** in the boot menu:

| Step | What happens |
|---|---|
| Boot | The same verified code and owner-signed configuration as a normal boot |
| Session | atrium does not restore the previous session and does not reopen documents or tabs automatically |
| App data | Apps start with their data units quarantined: strata snapshots each unit and mounts it read-only until the owner releases it |
| Recovery | Per app, the owner releases the unit, restores it from an earlier snapshot, or exports useful files through the powerbox before discarding it |

Quarantine never deletes data; the owner keeps the ability to recover anything useful. See [Recovery](../10-operations/recovery.md) and the [suspected-compromise runbook](../10-operations/runbooks/suspected-compromise.md).

## How to check it on a running machine

| Check | Command |
|---|---|
| Running generation equals the signed cmdline | `kl-boot status` |
| Every boot service's generation is signed and launchable | `warden services`, `depot verify <ref>` |
| No unexpected exec attempts | `warden exec-denials` |
| The config generation is owner-signed and current | `config current` |
| The boot was verified by the phone | the `vbu` field in the boot report (`kl-boot status --json`) |

## Related

- [Exec integrity and sealing](exec-integrity-and-sealing.md)
- [Boot chain](boot-chain.md)
- [Attestation and vouch](attestation-and-vouch.md)
- [ADR-0008 The host executes only sealed code](../11-decisions/adr-0008-host-executes-only-sealed-code.md), [ADR-0022 Read-only /etc via confext](../11-decisions/adr-0022-read-only-etc-confext.md), [ADR-0011 Owner presence with FIDO2](../11-decisions/adr-0011-owner-presence-fido2.md)
