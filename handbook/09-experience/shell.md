# Shell

> kish is the keylos shell and script language. Paths you type become file descriptors granted to exactly the command you run. Pipelines between native commands carry typed records. `try { … }` runs anything against a copy-on-write view you can commit or throw away.

Status: **specified (v1.0)**. Normative spec: [kish/spec.md](../../specs/kish/spec.md).

## What changes compared to a POSIX shell

| POSIX shell | kish |
|---|---|
| `$PATH` search over directories | A **command index** built from installed, sealed generations; `which` shows generation, version and entrypoint |
| Children inherit everything: environment, open fds, filesystem access | Children get fds 0–2, the fds of the files you named, and attenuated grants; nothing else |
| `$x` is split on whitespace and glob-expanded | `$x` is always exactly one value; globbing only for glob literals written in source |
| Text everywhere | Records between native commands (CBOR sequence), text or bytes with legacy commands; checked before running |
| `set -e` that mostly works | Errors propagate by default; `catch`, `??` and `?` handle them |
| Job control with process groups and `SIGTSTP` | Jobs are cgroups plus pidfds; each foreground job gets its own pty; Ctrl-Z freezes the whole job |
| `.bashrc` runs arbitrary code at every start | Config is data; personal functions are a sealed kish module |
| `curl … \| sh` | Refused: only the trusted terminal may feed commands to an interpreter |

## A tour

```kish
# Typed listing, filtered in-process, rendered as a table
ls ~/Downloads | where { $it.modified > @now - 7d } | sort-by size --reverse

# Variables are values, never re-split
let name = "quarterly report (final).pdf"
cp ~/Downloads/$name ./docs/        # one argument, one fd

# Errors propagate; handle them explicitly
let cfg = (open ./app.toml | from toml) catch { {} }
let port = $cfg.server?.port ?? 8080

# Transactions
try --in ./project {
    cargo update
    cargo build --release
}
# → summary of changes; [c]ommit [d]iscard [v]iew diff [k]eep

undo                                 # revert the last committed transaction
why ./target/release/app             # who created this file, in which session and transaction
```

## The shell as powerbox

![Typed arguments become granted fds](../images/powerbox.svg)

1. The command's signature says `file`/`dir` and the access (`read`, `write`, `create`, `readwrite`).
2. kish opens the path beneath a held root (home, cwd, or an earlier grant) with `openat2(RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS)`.
3. The command receives the fd as `/dev/fd/<n>` and `KEYLOS_ARGFD_<name>`. For directories, kish also passes an attenuated token so `warden` can allow opens beneath that directory, and only there.
4. Paths that did not come from the human (from variables, files, command output) need a broker request, which policy may turn into an approval.

Legacy commands without a signature get read-only fds for arguments the human wrote as paths; `run --write <path>` grants write access explicitly.

## Running things

| Need | Command |
|---|---|
| Run a native command | `name args…` |
| Force the command index (skip functions and builtins) | `^name` |
| Run with a VM boundary | `run --tier t2 name args…` |
| Grant network to one command | `run --grant (grant net host:api.example.com:443 --method GET) curl …` |
| Explain what would happen (commands, tiers, fds, pipe formats) | `kish --explain -c '…'` |
| Run a POSIX script | `kish --posix script.sh` (legacy tier only) |
| Interactive POSIX environment, or unsealed code | `work` (a workbench VM) |

## Jobs

| Key or command | Effect |
|---|---|
| `cmd &` | Background job; output goes to the job log (`job log %1`) |
| `cmd &!` | Detached; survives kish exit |
| Ctrl-Z | Stops every process of the foreground job's cgroups; returns to the prompt |
| `fg %1` / `bg %1` | Resume in foreground (terminal relay reattached) or background |
| Ctrl-C | Delivered by the job's own pty line discipline |
| Ctrl-\ Ctrl-\ | Kill the foreground job |
| `job info %1` | Principal, tier, generation and confinement report |

Because each job has its own pty, a command can never inject input into kish's terminal, and `TIOCSTI` is disabled system-wide anyway.

## Transactions, provenance and effects

![try: a command against a copy-on-write view](../images/transaction-try.svg)

- `try` asks [strata](../../specs/strata/spec.md) for an overlay transaction over the given directories (`Strata.begin` with `NetworkPolicy.deny`, or `gate` with `--net`, where traffic is recorded as effects). Each command in the block is spawned with `SpawnSpec.transaction`, so warden mounts the transaction's views into it and sets `KEYLOS_TXN`.
- At the end you see the changes and choose commit, discard, diff or keep. Commit records a pre-commit snapshot, which is what `undo` returns to.
- `why <path>` reads the creation-time provenance xattr: principal, generation, transaction, time and label.
- `effects` lists actions staged in the outbox (emails, pushes, API calls) for your sessions. Committing an irreversible one opens a T3 prompt in atrium.

## keylos builtins

| Builtin | Purpose |
|---|---|
| `grant`, `grants`, `revoke`, `label` | Request, list and revoke capabilities; show the session label |
| `try`, `txn`, `undo`, `snapshot`, `restore`, `why` | Transactions and history |
| `effects` | Outbox |
| `seal` | Seal code from a project for this machine (owner presence, 10-minute window) |
| `work` | Attach to the project workbench VM |
| `agent` | Start, attach, review, fork and stop agent sessions |
| `approvals` | List pending approvals (deciding happens only in atrium) |

## Scripts

- On the host, a script is code. It runs only if it is **sealed**: kish calls `execveat(fd, "", AT_EXECVE_CHECK)` and refuses (exit 126) if the kernel says no.
- Scripts meant as commands ship inside a generation with a signature derived from `fn main(…)`.
- Personal helper functions live in a project you seal (`seal --project ~/kish-functions`) and load with `use`. There is no rc file containing code.

## Labels in the shell

- Values carry the label of where they came from.
- The prompt shows `[private/untrusted]`-style indicators when your session's label is raised.
- History records the label of every entry. `secret`-labelled entries are never written to disk. History lives in a crypto-shreddable data unit, so `forget` erases it from snapshots too.

## Limitations

- Muscle memory: `$PATH` tricks, `eval`, here-documents and backtick substitution do not exist. `kish --posix` covers scripts; `work` covers interactive POSIX use.
- Commands without signatures lose typing and get read-only file access unless you use `run --write`.
- Ctrl-Z uses `Process.freeze`/`thaw` (cgroup freeze) and `Process.signal` targets the job's whole cgroup, so a job can't escape suspension by forking; programs that expect `SIGTSTP` handling see none.

## Related

- [Command signatures and typed pipes](../04-contracts/cmdsig-and-pipes.md)
- [Desktop](desktop.md)
- [Developer workbench](developer-workbench.md)
- [Snapshots and transactions](../08-state/snapshots-and-transactions.md)
- [kish spec](../../specs/kish/spec.md)
