# kish

> The keylos shell. kish is a real programming language with an interactive syntax. Typed records flow between native commands and bytes between legacy ones, the arguments you type become granted fds (the CLI powerbox), and `try`, `undo`, `why` and `effects` are built in.
> Humans run it on the host's trusted terminal. Agents use the same command signatures as tool definitions inside their workbenches.

**Status:** specified (v1.0) · **Spec:** [`kish/spec.md`](../../specs/kish/spec.md)

## Responsibilities

- **Language:**
  - no word splitting, no implicit globbing of variables;
  - lists and records are values; lexical scope, immutable by default;
  - errors propagate by default.
- **Commands:**
  - reads `keylos.cmdsig/1` signatures for completion, validation, `--help` and dry-run;
  - opens `file`/`dir` arguments according to `access`, passes them as fds, and sets `KEYLOS_ARGFD_*`.
- **Pipes:** static negotiation: CBOR-sequence records when both ends declare records (`KEYLOS_PIPE_OUT`/`IN`), bytes otherwise.
- **Spawning:** every job goes through `Supervisor.spawn` with an explicit spec. A new pty is created per job.
- **Built-ins:**

  | Command | Does |
  |---|---|
  | `try { … }` | Runs a block in a strata transaction |
  | `undo` | Reverts the last transaction |
  | `why <file>` | Shows provenance and receipts |
  | `effects` | Lists staged intents |
  | `grant` / `grants` | Requests and lists grants |
  | `work` | Attaches to the project workbench |
  | `seal` | Requests a sealing window |
- **Interpreter integrity:** kish honours `AT_EXECVE_CHECK`. Scripts must be sealed. Interactive input is accepted only from the trusted terminal.

## Interfaces

| Direction | Interface | Notes |
|---|---|---|
| Consumes | warden `Supervisor` (facet `client`); `TrustedSpawn` through atrium-term | Spawning with argument fds; the trusted terminal |
| Consumes | broker (facet `principal`) | Grants and powerbox |
| Consumes | strata (facet `user`), `StrataTxn` | `try` blocks via `SpawnSpec.transaction` |
| Consumes | gate (facet `client`), depot (facet `user`), vault (facet `app`) | `effects`, `seal`, secrets |
| Consumes | compat (facet `user`), bench (facet `user`), ledger (facet `reader`) | Legacy commands, `work`, `why` and receipts |

## Runs as

Principal `shell@<user>/<session>`, tier 1, on a trusted-path terminal provided by [atrium](atrium.md) or the console.

## Key decisions

- [ADR-0036: Typed pipes via cmdsig](../11-decisions/adr-0036-typed-pipes-via-cmdsig.md)
- [ADR-0008: Host executes only sealed code](../11-decisions/adr-0008-host-executes-only-sealed-code.md)

## Related

- [Shell](../09-experience/shell.md)
- [Command signatures and pipes](../04-contracts/cmdsig-and-pipes.md)
- [Snapshots and transactions](../08-state/snapshots-and-transactions.md)
