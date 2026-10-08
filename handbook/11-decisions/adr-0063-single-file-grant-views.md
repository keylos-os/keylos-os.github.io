# ADR-0063: A single-file pick exposes only that file

> When a path-expecting app picks one file, it gets a single-file view: a portal-served directory containing just that file. Safe saves go through the portal as an atomic replace of the real file. The parent directory is never attached.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Experience / portals | portals, warden, broker, compat, protocols |

## Context

- For legacy and toolkit clients that need a path, portals attached the selected file's **parent directory**, while the portals acceptance test promised that siblings stay unreadable. `GrantMounts` mounts whole trees and has no sibling filtering (ISSUES.md ISS-005).
- Many editors save by writing a temporary file and renaming it over the original. A plain single-file bind mount breaks that (`rename` onto a mount point fails), which is why the parent was attached.

## Decision

- A file pick for a path-expecting client is exposed as `/grants/<name>/<basename>`: a directory served by portal-files (`keylos.singlefile`) containing only the selected file and the holder's own temporary files (protocols §7.3.3, §7.5.19, E32).
- Writes follow the granted rights; a read-only grant refuses every write.
- `rename(tmp → basename)` is executed by portal-files as an atomic replace in the real parent, whose dirfd it holds and never exposes. Every other name is refused.
- Directory access requires an explicit "open directory" consent.
- Remembered grants, re-materialization, revocation and drag-and-drop keep the single-file scope.

## Alternatives considered

| Option | Why not |
|---|---|
| Attach the parent directory | Exposes siblings; the bug |
| Bare single-file bind mount | Breaks safe saves |
| Copy the file in and out | Loses identity, races with other writers |

## Consequences

### Positive
- The grant matches what the user chose; siblings can't be listed or read.
- Safe-save editors keep working.

### Negative
- File access for path-expecting apps goes through FUSE in portal-files.

### Follow-ups
- Tests: sibling enumeration and reads, writes outside the destination, symlink and path replacement races, read-only enforcement, atomic save, persistent re-materialization, revocation.

## Related

- [Portals and the powerbox](../09-experience/portals-and-powerbox.md)
- [ADR-0035: fd-only portals and D-Bus islands](adr-0035-fd-only-portals-dbus-islands.md)
- [portals spec](../../specs/portals/spec.md)
