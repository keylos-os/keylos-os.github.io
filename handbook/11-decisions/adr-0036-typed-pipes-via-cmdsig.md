# ADR-0036: Typed pipes, negotiated statically through command signatures

> Native commands ship `keylos.cmdsig/1` signatures that declare arguments, flags, input and output types, and effects. kish negotiates each pipe statically: CBOR-sequence records when both ends speak records, bytes otherwise. The same signatures drive completion, validation, fd passing for arguments, and agent tool definitions.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-07 | Experience | kish, sdk, pkgs, aide |

## Context

- Unix pipelines re-parse text everywhere (`ls | awk`), which is fragile and full of quoting bugs.
- PowerShell and Nushell move structured data, but as closed worlds where legacy tools feel second-class.
- `--help` prose is the only API description for most tools, which hurts completion and makes agent tool definitions guesswork.
- In-band negotiation over a pipe (magic bytes) breaks legacy tools.

## Decision

- `/.keylos/cmdsig/<name>.json` in each generation (protocols §12): types include `file` and `dir` with `access`, `host`, `url`, `records` with schema, and `secret-ref`.
- **Static negotiation:** kish knows both ends' signatures. When both declare records, it sets `KEYLOS_PIPE_OUT=cbor-seq` and `KEYLOS_PIPE_IN=cbor-seq` (RFC 8742). Otherwise bytes, with the producer rendering TSV text.
- Arguments of type `file`/`dir` are opened by kish according to `access`, passed as fds, and rewritten to `/dev/fd/N`, with `KEYLOS_ARGFD_<name>` for native tools.
- aide derives agent tool schemas from the cmdsigs of the commands a template pins.

## Alternatives considered

| Option | Why not |
|---|---|
| In-band negotiation (magic header) | Breaks legacy consumers |
| JSON lines always | Breaks legacy consumers; text tools would need adapters |
| Closed structured shell | Hostile to the existing tool ecosystem |

## Consequences

### Positive
- Structured data where both ends support it, and full compatibility where they don't. One signature serves humans, the shell and agents.

### Negative
- Tool authors must ship cmdsigs. Without them, a command is bytes-only.

## Related

- [Command signatures and pipes](../04-contracts/cmdsig-and-pipes.md)
- [Shell](../09-experience/shell.md)
- [kish](../03-components/kish.md)
