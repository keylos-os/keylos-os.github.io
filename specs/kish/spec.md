# keylos/kish — the keylos shell

| | |
|---|---|
| Repository | `github.com/keylos-os/kish` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | `kish` binary (interactive shell and script interpreter); `kish-lsp` (language server); `libkish` crate (parser, evaluator, value model; embeddable); generation `io.keylos.kish` (kind `app`, entrypoints `main`, `lsp`); cmdsig files for all builtins; `kish.ncl` config schema module |
| Depends on | `keylos-protocols 1.0` (crates `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-labels`); runtime services `warden`, `broker`, `strata`, `gate`, `bench`, `aide`, `depot` (via capabilities handed over at spawn) |
| Provides | The `shell` principal's user interface; the CLI powerbox; typed pipelines; the script language for sealed keylos scripts; builtins `try`, `undo`, `why`, `effects`, `grant`, `debug`, `seal`, `work`, `agent` and the data builtins |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

kish is the command language and interactive shell of keylos. It replaces the POSIX shell as the way humans drive the system, and it is the scripting language for sealed keylos scripts. It is designed around three keylos properties:

1. **The shell is the CLI powerbox.** File and directory arguments the human types become file descriptors granted to the command. A command receives nothing else. `$PATH` lookup, ambient filesystem access and inherited environment do not exist.
2. **Pipelines are typed.** Commands describe themselves with command signatures (`cmdsig`). kish checks pipelines before running them and negotiates a structured record stream between native commands, falling back to bytes for everything else.
3. **Changes are transactions.** `try { … }` runs a block against a copy-on-write view and lets the human commit or discard it. `undo` reverts the last committed transaction. `why` explains where a file came from. `effects` lists actions waiting in the outbox and lets the human commit or cancel those staged by commands they started.

kish is also where a human asks for a time-limited **debug grant** (`debug`) to attach a debugger or profiler to one of their own host processes (protocols §9.3).

### 1.1 In scope

- The kish language: lexical structure, grammar, values, types, scoping, functions, errors, pipelines, redirections and globbing.
- Running external commands through `warden` with explicit fds and grants.
- Job control built on pidfds and cgroups, with a pty relay instead of process groups.
- Builtins, including the data builtins and the keylos builtins.
- Interactive features: line editing, completion from cmdsig, history with labels, the prompt.
- Script execution rules: sealing, `AT_EXECVE_CHECK`, interactive input on the trusted terminal only.
- POSIX compatibility mode (`kish --posix`), which runs only in the legacy tier.
- The language server `kish-lsp`.

### 1.2 Non-goals

- POSIX sh conformance in native mode. POSIX scripts run with `kish --posix` inside the legacy tier (§4.14).
- Being a terminal emulator. The terminal is drawn by `atrium` (`atrium-term`). kish relays bytes between that terminal and per-job ptys.
- Running unsealed code on the host. kish refuses; it points the user to `seal` or `work`.
- Remote shells. `ssh` is an ordinary external command.

---

## 2. Context and embedded contracts

### 2.1 Where kish sits

```
atrium-term (trusted terminal, owns outer pty)
   └── kish   principal shell@<user>/<session>, tier t1, sealed generation io.keylos.kish,
         │    spawned with TrustedSpawn.spawnTerminal (protocols §7.5.1)
         ├── capabilities at spawn (KEYLOS_CAPWIRE_FDS): warden#client, broker#principal, strata#user, gate#client,
         │                                              bench#user, aide#user, depot#user, vault#app, compat#user,
         │                                              ledger#reader, journal#client
         ├── job 1: external command  → warden.spawn(SpawnSpec) → own principal app:<gen>@<user>/<s>/<s'>, own pty
         ├── job 2: pipeline a | b     → two spawns joined by a pipe (cbor-seq or bytes)
         └── in-process: builtins, functions, data operations
```

- kish runs as the **`shell` principal** of the logged-in human. At login, `atrium-term` starts it from the sealed generation `io.keylos.kish` with `TrustedSpawn.spawnTerminal` (protocols §7.5.1, facet `trusted-terminal`), attached to the trusted terminal. That is the only spawn path for which `warden` withholds `SECBIT_EXEC_DENY_INTERACTIVE` (protocols §9.3).
- The shell principal holds the **shell root grants**: tokens for the human's home and any extra roots the human configured (§10). These are the human's directly exercised authority. Commands kish spawns receive only what the shell hands them (§4.8).
- Scripts run as their own principals. A sealed script is a generation like any app (§4.13).

### 2.2 Embedded contracts

kish implements or consumes the following contracts. Appendix A has verbatim copies, so this file is self-contained with only the `keylos-protocols` 1.0.0 crates:

| Contract | Use in kish | Appendix |
|---|---|---|
| protocols §3.4 principals | Parsing and displaying principals in prompts, `why` and `effects` | A.1 |
| protocols §7.1–7.2 capwire model, routes and facets | Connecting to services from `KEYLOS_CAPWIRE_FDS` | A.2 |
| `common.capnp` + error codes | Every call; `kl:<code>` errors mapped to kish error values | A.3 |
| `warden.capnp` | `Supervisor.spawn` (with `SpawnSpec.transaction`), `Process` (jobs, `freeze`/`thaw`) | A.4 |
| `broker.capnp` | `request`, `materialize`, `attenuate`, `delegate`, `powerbox`, `myGrants`, `revoke`, `label`, `debug` (`DebugTarget`, `Right.debug`) | A.5 |
| protocols §8.2 token vocabulary | Displaying grants; `debug_scope`; `net` method facts (terminated mode) | A.22 |
| `strata.capnp`, `strata-sys.capnp` | `try`, `txn`, `undo`, `why`, `snapshot`, `restore`; `StrataTxn`, `TransactionExt` | A.6, A.16 |
| `gate.capnp` | `effects`: `intents` (listing) and `intent` (commit, cancel, compensate, dry run of intents in kish's own session tree); terminated HTTP mode for native tools | A.7 |
| `bench.capnp` | `work`, `run --tier t2`, tier-2 native apps (purpose `app`) | A.8 |
| `aide.capnp` | `agent` | A.9 |
| `depot.capnp` | Command index, `which` | A.10 |
| `vault.capnp` | `secret-ref` completion (`list`, own items) | A.18 |
| `ledger.capnp` | `receipts` | A.19 |
| `compat.capnp` | `kish --posix` | A.20 |
| `warden-sys.capnp` | `TrustedSpawn` and the trusted-terminal tree; `DebugAttach` semantics behind `Broker.debug` | A.17 |
| protocols §9.1–9.3 confinement and code integrity | Script execution rules, securebits | A.11 |
| protocols §10.1, §10.5 layout and environment | Paths, XDG, environment for children | A.12, A.15 |
| protocols §12 command signatures, fd passing, pipe protocol | Typing, completion, fd passing, pipe negotiation | A.13 |
| protocols §14.1–14.5 labels, effect kinds, approval tiers, mandates, operating rules | History labels, prompt label indicator, approval handling, debug rules | A.14 |
| protocols §19.2 facets | The facets kish holds | A.21 |

---

## 3. Requirements

### 3.1 Language

- **REQ-KISH-001** kish MUST parse source text according to the grammar in §4.2. A parse error MUST report file, line, column and a caret excerpt. Nothing in the file runs if parsing fails.
- **REQ-KISH-002** Variables MUST be lexically scoped. `let` bindings MUST be immutable. Only `var` bindings may be reassigned.
- **REQ-KISH-003** Expanding a variable MUST produce exactly one value. Word splitting, field splitting and implicit glob expansion of variable contents MUST NOT happen.
- **REQ-KISH-004** Globbing MUST happen only for unquoted glob literals written in source (§4.6). A glob literal that matches nothing MUST raise `glob-empty` unless written with the optional marker `?`.
- **REQ-KISH-005** Errors MUST propagate by default. A failing command, builtin or expression aborts the enclosing block unless handled with `catch` or `??` (§4.10).
- **REQ-KISH-006** A non-zero exit of an external command MUST become an error value, except for exit codes the command's cmdsig marks as non-fatal (§4.10.2).
- **REQ-KISH-007** Functions declared with `fn` MUST get an in-memory cmdsig derived from their parameter declarations, and MUST participate in pipeline type checking like external commands.

### 3.2 Execution and authority

- **REQ-KISH-010** kish MUST NOT search the filesystem for commands. A command name resolves only to, in order: a function in scope, a builtin, or an entry in the **command index** built from `depot` (§4.7).
- **REQ-KISH-011** kish MUST start external commands only through `Supervisor.spawn`. It MUST NOT call `fork`, `execve`, `posix_spawn` or `clone` for external programs.
- **REQ-KISH-012** For each argument whose cmdsig type is `file` or `dir`, kish MUST open the path with the cmdsig `access`, pass the fd, replace the argument text with `/dev/fd/<n>`, and set `KEYLOS_ARGFD_<argname>` (protocols §12.1).
- **REQ-KISH-013** kish MUST resolve all paths with `openat2` relative to a held root dirfd, using `RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS`. A path outside every held root MUST trigger a broker grant request (interactive) or fail with `denied` (non-interactive).
- **REQ-KISH-014** A spawned command MUST receive only: fds 0–2, argument fds, redirection fds, the service sockets its manifest routes to (wired by `warden`, not kish), and the tokens kish attaches explicitly. kish MUST NOT pass its own service capabilities or shell root grants to children.
- **REQ-KISH-015** The environment passed to a child MUST be exactly the set of `export`ed variables plus the variables of protocols §10.5. kish MUST refuse to export any variable whose value is a `secret` value, or whose name matches the policy secret patterns (§10).
- **REQ-KISH-016** Paths a human types on the trusted terminal count as powerbox grants. Paths that appear in scripts, variables or command output MUST NOT be granted without a broker request, which the broker MAY turn into an approval.

### 3.3 Pipelines

- **REQ-KISH-020** Before running a pipeline, kish MUST check that each adjacent pair of stages is type-compatible (§4.5.2). An incompatibility MUST be reported before any stage starts.
- **REQ-KISH-021** When both adjacent external stages declare `records`, kish MUST set `KEYLOS_PIPE_OUT=cbor-seq` on the producer and `KEYLOS_PIPE_IN=cbor-seq` on the consumer. Otherwise the pipe carries bytes (protocols §12.2).
- **REQ-KISH-022** In-process stages (builtins, functions) MUST exchange kish values directly, without serialisation. At a boundary with an external stage, kish MUST encode as a CBOR sequence when the external side declares `records`, and as text (TSV for records) otherwise.
- **REQ-KISH-023** A pipeline fails if any stage fails (pipefail semantics). The reported error MUST name the first stage that failed, ordered by stage position.

### 3.4 Jobs

- **REQ-KISH-030** Each foreground job MUST get its own pty pair. kish relays bytes between the outer terminal and the job pty. A child process MUST NOT receive kish's outer terminal.
- **REQ-KISH-031** Jobs MUST be tracked by `Process` capability and pidfd. kish MUST NOT use process groups, `tcsetpgrp` or `SIGTSTP` on its own terminal.
- **REQ-KISH-032** Suspending a job (Ctrl-Z, `stop`) MUST freeze every stage's cgroup with `Process.freeze`; resuming MUST call `Process.thaw` on every stage (§4.9.3).
- **REQ-KISH-033** A background job MUST NOT read from or write to the terminal. Its stdin is `/dev/null` (an empty pipe) unless redirected; its stdout and stderr go to the job log unless redirected (§4.9.4).

### 3.5 Transactions, provenance and effects

- **REQ-KISH-040** `try { block }` MUST run the block inside a `strata` transaction. Every external command spawned in the block MUST be spawned with `SpawnSpec.transaction` set to the transaction ID, so that `warden` mounts the transaction's views over the transaction's directories (protocols §7.3.2). kish itself MUST resolve paths under transaction directories through the `Transaction.view` dirfds.
- **REQ-KISH-041** By default a transaction MUST deny network (`NetworkPolicy.deny`). `try --net` passes `NetworkPolicy.gate`, which allows egress only through `gate`, where it is recorded as effects. `try --net-inherit` passes `NetworkPolicy.inherit` (allowed by `strata` only for `shell` principals).
- **REQ-KISH-042** At the end of a `try` block in interactive mode, kish MUST show the change summary and ask commit, discard, diff or keep. In non-interactive mode, the default is `--abort` unless `--commit` or `--keep` is given.
- **REQ-KISH-043** `undo` MUST call `Strata.undo` for the most recent transaction this session committed, or for the transaction ID given.
- **REQ-KISH-044** `why <path>` MUST print the `Provenance` returned by `Strata.why`.
- **REQ-KISH-045** `effects` MUST list `IntentStatus` entries for the current session and all its descendant sessions with a single `Gate.intents(<kish session>)` call on facet `client`, which gate answers recursively for the whole session tree (protocols §7.3.7, §19.2). kish MUST NOT keep its own record of job sessions for this purpose.
- **REQ-KISH-046** `effects commit|cancel|compensate|dry-run <e-id>` MUST obtain the intent with `Gate.intent(id)` (facet `client`, protocols §7.3.7), which gate limits to intents staged by kish's own session or its descendants. kish MUST NOT try any other path to an intent. A `kl:not-found` from gate is shown as "no such intent in this shell's sessions".
- **REQ-KISH-076** When `warden.spawn` of a native `app` generation fails with `kl:unsupported:t2`, kish MUST launch it through `bench#user` with `VmSpec.purpose = app` and image `io.keylos.app-vm` (§4.8), and MUST NOT fall back to tier 1. A generation whose effective tier is t2 or higher MUST never be spawned on the host.
- **REQ-KISH-047** `effects commit` MUST NOT decide approvals. When `Intent.commit` raises `kl:needs-approval:<a-…>`, kish waits for the decision made on `atrium`'s trusted path (§4.10.3) and retries the commit once the approval resolves; it never signs or forwards mandates.
- **REQ-KISH-048** Interactive `effects commit` and `effects cancel` MUST show the intent's rendering (`Intent.dryRun`) and ask for confirmation in the terminal before calling gate; scripts need `--yes`.

### 3.6 Integrity

- **REQ-KISH-050** Before interpreting any script file, kish MUST call `execveat(fd, "", AT_EXECVE_CHECK | AT_EMPTY_PATH)`. If the kernel refuses, kish MUST NOT run the file and MUST exit with status 126 and error `integrity`.
- **REQ-KISH-051** If `SECBIT_EXEC_RESTRICT_FILE` is set, kish MUST apply REQ-KISH-050 also to files loaded with `source` and `use`, and to config modules containing code.
- **REQ-KISH-052** If `SECBIT_EXEC_DENY_INTERACTIVE` is set, kish MUST refuse interactive mode and refuse to read commands from stdin or `-c` strings, exiting with 126.
- **REQ-KISH-053** Interactive mode is allowed only when kish was spawned through `TrustedSpawn.spawnTerminal` (protocols §7.5.1). `warden` withholds `SECBIT_EXEC_DENY_INTERACTIVE` only for the **trusted-terminal tree** (protocols §9.3): the kish process itself and every process kish spawns as a job, foreground or background, including REPLs started from the prompt.
- **REQ-KISH-055** kish MUST spawn every job itself, directly through `Supervisor.spawn` on its own `warden#client` route, with `actorKind` per §4.8, so that `warden` can recognise the spawn as a trusted-terminal job (protocols §9.3: decided by the spawning principal's actor kind `shell` from the trusted terminal and the `SpawnSpec` origin, not by process ancestry). kish MUST NOT ask another program to spawn a job on its behalf. Processes that a job spawns itself (an editor's helper, a build tool's compiler) are outside the tree and get both securebits.
- **REQ-KISH-054** kish MUST NOT execute code from its configuration directory. Configuration is data (§10). User functions loaded at startup MUST come from a sealed generation (a kish module).

### 3.6a Debugging

- **REQ-KISH-070** `debug` MUST request a `Right.debug` grant with `Broker.request(GrantRequest{resource: principal(DebugTarget{target, scope}), rights: [debug], durationSecs, reason})` (protocols §7.3.3). The broker mints it only at T3 with presence (protocols §9.3); kish MUST wait for the decision like any approval and MUST NOT offer a way around it.
- **REQ-KISH-071** `durationSecs` MUST NOT exceed 3 600 for scope `process` and 900 for scope `kernel`; kish MUST refuse larger values before asking broker.
- **REQ-KISH-072** kish MUST resolve the debugger by name through the command index restricted to generations whose names are in the config `debug.debuggers` list (mirroring the policy list `debug.debuggers` warden enforces), and MUST pass its generation ref to `Broker.debug(token, debugger, entrypoint, argv, pty)`. The returned process is run as a foreground job on a fresh job pty.
- **REQ-KISH-073** A `debug` target MUST be either `session:<s-…>` (a job's principal session, resolved from `%N` or `jobs`) or `gen:fsv256:<…>` (any instance of a generation of the same human). kish MUST NOT accept a target that names another human's session; broker and warden enforce this too.
- **REQ-KISH-074** When the debug job exits or the grant expires (warden kills the debugger and writes `debug.detach`), kish MUST report it and drop the token.

### 3.6b Network clients

- **REQ-KISH-075** kish has no network access itself. When it materialises a `net` grant for a native child (`run --grant net:host:port[:method,…]`), `--explain` and `job info` MUST state whether gate will hand the child a **terminated** socket (the grant's `net` fact has `$method ≠ "*"`, protocols §7.3.7) or a relayed one, so the human knows the tool must speak plain HTTP to gate (native tools built with `keylos-gate-client` do this automatically).

### 3.7 Interactive

- **REQ-KISH-060** Completion MUST derive from cmdsig: argument names, flags, enum values and types. `file` and `dir` completion MUST list only entries under held roots.
- **REQ-KISH-061** History MUST store, for each entry: the text, start time, duration, exit status, cwd, and the session label at the time it ran. Entries whose label confidentiality is `secret` MUST NOT be written to disk.
- **REQ-KISH-062** The prompt MUST show the current session label whenever it differs from `internal/user`. This indicator is drawn by kish and is in addition to atrium's frame colour.
- **REQ-KISH-063** kish MUST start in under 30 ms to the first prompt on reference hardware (§8).

---

## 4. Design

### 4.1 Lexical structure

**Source encoding.** UTF-8. A byte-order mark is an error. Lines end with LF; a CR before LF is ignored.

**Comments.** `#` to end of line, outside strings. A first line starting with `#!` is a shebang and is ignored by the parser.

**Tokens:**

| Token | Form | Notes |
|---|---|---|
| Newline | LF | Statement separator, except inside `()`, `[]`, `{}` and after a trailing `\|`, `and`, `or`, `,` or a binary operator |
| `;` | | Statement separator |
| Keyword | `let var fn if else match for in while loop break continue return try catch use export and or not true false null` | Reserved in expression position. In command-argument position a keyword is a bareword unless it starts the statement |
| Identifier | `[A-Za-z_][A-Za-z0-9_]*` | Variables, record fields, function parameters |
| Command name | `[A-Za-z0-9_][A-Za-z0-9_.+-]*` | Command position only; may contain `-` and `.` |
| Variable | `$` identifier, `$env.` identifier, `$in`, `$_` | `$in` is the pipeline input of a function; `$_` is the last result in interactive mode |
| Integer | `-?[0-9][0-9_]*`, `0x[0-9a-fA-F_]+`, `0o[0-7_]+`, `0b[01_]+` | 64-bit signed; overflow is an error |
| Float | `-?[0-9][0-9_]*\.[0-9_]+([eE][+-]?[0-9]+)?` | IEEE 754 binary64 |
| Size | integer or float followed by `B kB MB GB TB KiB MiB GiB TiB` | Stored as bytes (u64) |
| Duration | `([0-9]+(ns\|us\|ms\|s\|m\|h\|d))+` | `1h30m`; stored as nanoseconds (i64) |
| Time | `@` RFC 3339 timestamp, or `@now` | `@2026-10-07T21:00:00Z` |
| Raw string | `'…'` | No escapes, no interpolation; `''` inside is a literal `'` |
| String | `"…"` | Escapes `\n \t \\ \" \$ \u{XXXX}`; interpolation `$var`, `${expr}` |
| Bytes | `b"…"` or `0x"…"` | Escapes as strings without interpolation; `0x"de ad"` is hex |
| Path literal | Bareword that starts with `/`, `./`, `../`, `~/` or `~`, or contains `/` | Value of type `path` (§4.3.3) |
| Glob literal | Unquoted bareword in argument position containing `*`, `?` or `[`; or `g"…"` | Value of type `glob` (§4.6) |
| Host literal | `host:` + name[`:`port] | `host:api.github.com:443` |
| URL literal | Bareword starting with `https://` or `http://` | Value of type `url` |
| Bareword | Any other run of non-delimiter characters in argument position | A `text` value, converted by the parameter type (§4.4.3) |
| Operators | `\| \|\| && = == != < <= > >= + - * / % ** .. ..< ?? ? . , : -> => ! @` | `\|\|` and `&&` exist only to give a targeted error pointing to `or`/`and` |
| Redirection | `> >> < 2> 2>> &> &>> 2>&1 >&2 <<<` | §4.5.4 |
| Delimiters | `( ) [ ] { }` | |

Delimiter characters for barewords are whitespace, `|`, `;`, `(`, `)`, `{`, `}`, `[`, `]` (except inside a glob class), `"`, `'`, `<`, `>`, and `#` at the start of a word.

### 4.2 Grammar

EBNF (ISO 14977 style). `NL` is a newline token; `sep` is `NL` or `;`.

```ebnf
program        = { sep } , [ statement , { sep , { sep } , statement } ] , { sep } ;
statement      = let_stmt | var_stmt | assign_stmt | fn_decl | export_stmt | use_stmt
               | if_stmt | match_stmt | for_stmt | while_stmt | loop_stmt
               | "break" | "continue" | return_stmt
               | try_stmt | pipeline_stmt ;

let_stmt       = "let" , pattern , [ ":" , type ] , "=" , expr ;
var_stmt       = "var" , identifier , [ ":" , type ] , "=" , expr ;
assign_stmt    = lvalue , ( "=" | "+=" | "-=" | "*=" | "/=" ) , expr ;
lvalue         = identifier , { "." , identifier | "[" , expr , "]" } ;
export_stmt    = "export" , identifier , [ "=" , expr ] ;
use_stmt       = "use" , module_ref , [ "as" , identifier ] ;
module_ref     = identifier , { "." , identifier } ;            (* resolved in sealed module generations *)
return_stmt    = "return" , [ expr ] ;

fn_decl        = "fn" , cmd_name , "(" , [ params ] , ")" , [ "->" , type ] , [ fn_attrs ] , block ;
params         = param , { "," , param } , [ "," ] ;
param          = positional | flag | rest | input ;
positional     = identifier , [ ":" , type ] , [ "=" , expr ] ;
flag           = "--" , identifier , [ "(" , "-" , letter , ")" ] , [ ":" , type ] , [ "=" , expr ] ;
rest           = "..." , identifier , [ ":" , type ] ;
input          = "$in" , ":" , type ;                            (* declares pipeline input type *)
fn_attrs       = "[" , fn_attr , { "," , fn_attr } , "]" ;
fn_attr        = "effects" , "=" , list_lit | "summary" , "=" , string ;

if_stmt        = "if" , expr , block , { "else" , "if" , expr , block } , [ "else" , block ] ;
match_stmt     = "match" , expr , "{" , { arm } , "}" ;
arm            = pattern , [ "if" , expr ] , "=>" , ( expr | block ) , [ "," | NL ] ;
for_stmt       = "for" , pattern , "in" , expr , block ;
while_stmt     = "while" , expr , block ;
loop_stmt      = "loop" , block ;
try_stmt       = "try" , { try_opt } , block ;
try_opt        = "--in" , arg | "--net" | "--commit" | "--abort" | "--keep" | "--name" , arg ;

pipeline_stmt  = pipeline , [ "&" ] ;
pipeline       = stage , { "|" , { NL } , stage } , [ catch_clause ] , [ "??" , expr ] ;
stage          = command | expr_stage ;
expr_stage     = "(" , expr , ")" | block_expr | literal_value ;   (* a value as pipeline source *)
command        = cmd_head , { arg | flag_arg | redirection } ;
cmd_head       = cmd_name | path_lit | "^" , cmd_name ;           (* ^name forces external lookup *)
arg            = bareword | string | raw_string | number | size | duration | time
               | path_lit | glob_lit | host_lit | url_lit | variable_ref
               | "(" , expr , ")" | "$(" , pipeline , ")" | list_lit | record_lit ;
flag_arg       = "--" , flag_name , [ "=" , arg ] | "-" , letter , { letter } ;
redirection    = redir_op , arg ;
redir_op       = ">" | ">>" | "<" | "2>" | "2>>" | "&>" | "&>>" | "2>&1" | ">&2" | "<<<" ;
catch_clause   = "catch" , [ identifier ] , block ;

block          = "{" , program , "}" ;
block_expr     = block , [ catch_clause ] ;

expr           = or_expr , [ "??" , expr ] ;
or_expr        = and_expr , { "or" , and_expr } ;
and_expr       = not_expr , { "and" , not_expr } ;
not_expr       = [ "not" ] , cmp_expr ;
cmp_expr       = range_expr , [ cmp_op , range_expr ] ;
cmp_op         = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not" , "in" | "=~" | "!~" ;
range_expr     = add_expr , [ ( ".." | "..<" ) , add_expr ] ;
add_expr       = mul_expr , { ( "+" | "-" ) , mul_expr } ;
mul_expr       = pow_expr , { ( "*" | "/" | "%" ) , pow_expr } ;
pow_expr       = unary , [ "**" , pow_expr ] ;
unary          = [ "-" ] , postfix ;
postfix        = primary , { "." , identifier | "?." , identifier | "[" , expr , "]" | call_args | "?" } ;
call_args      = "(" , [ expr , { "," , expr } ] , ")" ;           (* closure call *)
primary        = literal_value | variable_ref | "(" , expr , ")" | "$(" , pipeline , ")"
               | if_expr | match_expr | closure | block_expr ;
if_expr        = "if" , expr , block , "else" , ( block | if_expr ) ;
match_expr     = match_stmt ;
closure        = "|" , [ identifier , { "," , identifier } ] , "|" , ( expr | block ) ;
literal_value  = number | size | duration | time | string | raw_string | bytes | "true" | "false" | "null"
               | path_lit | glob_lit | host_lit | url_lit | list_lit | record_lit ;
list_lit       = "[" , [ expr , { ( "," | NL ) , expr } , [ "," ] ] , "]" ;
record_lit     = "{" , [ field , { ( "," | NL ) , field } , [ "," ] ] , "}" ;   (* disambiguated from block: §4.2.1 *)
field          = ( identifier | string ) , ":" , expr | "..." , expr ;
pattern        = identifier | "_" | literal_value | "[" , [ pattern , { "," , pattern } ] , [ "," , "..." , [ identifier ] ] , "]"
               | "{" , identifier , [ ":" , pattern ] , { "," , identifier , [ ":" , pattern ] } , [ "," , "..." ] , "}" ;
type           = simple_type | "list" , "<" , type , ">" | "record" , "{" , [ field_type , { "," , field_type } ] , "}"
               | "table" , "<" , type , ">" | type , "?" | "enum" , "[" , string , { "," , string } , "]" ;
simple_type    = "any" | "null" | "bool" | "int" | "float" | "text" | "bytes" | "time" | "duration" | "size"
               | "path" | "file" | "dir" | "host" | "url" | "glob" | "secret" | "grant" | "job" | "error" | "closure" ;
field_type     = identifier , ":" , type ;
```

#### 4.2.1 Disambiguation rules

1. **Statement head.** A statement that starts with a keyword is parsed by that keyword's rule. A statement that starts with `$`, `(`, `[`, a literal, or `{` at expression position is an expression stage. Anything else is a command.
2. **`{` after an expression-taking keyword** (`if`, `while`, `for … in`, `match`, `fn`, `try`, `catch`) is a block.
3. **`{` elsewhere** is a record literal when its first non-whitespace content is `}` (empty record), `identifier :`, `"string" :` or `...`. Otherwise it is a block.
4. **Bareword vs. path vs. glob.** In argument position, the lexer classifies an unquoted word as a URL, then a path literal, then a glob literal (if it contains unquoted `*`, `?` or `[` … `]`), then a number/size/duration/time literal, then a bareword. Quoting always produces a string.
5. **`-` in argument position.** A word starting with `-` is a flag argument (`-x`, `--name`, `--name=value`) unless it is a numeric literal or the token `--`, after which all remaining words are positional.
6. **Line continuation.** No backslash continuation exists. Lines continue implicitly after `|`, `and`, `or`, `,`, an opening delimiter, or a binary operator.

### 4.3 Values and types

#### 4.3.1 Type list

| Type | Representation | Text form (for byte pipes and printing) |
|---|---|---|
| `null` | | empty string |
| `bool` | | `true` / `false` |
| `int` | i64 | decimal |
| `float` | f64 | shortest round-trip decimal |
| `text` | UTF-8 string | itself |
| `bytes` | byte vector | raw bytes |
| `time` | i64 ns since Unix epoch, UTC | RFC 3339 |
| `duration` | i64 ns | `1h30m5s` style |
| `size` | u64 bytes | `10.0 MiB` (display), exact integer in TSV |
| `path` | Unopened path: (root key, relative components) | the path as typed, normalised |
| `file` | Open file capability: fd + access + display name + label | display name |
| `dir` | Open `O_PATH` dirfd + access + display name + label | display name |
| `glob` | Pattern + base | the pattern |
| `host` | name + optional port | `name:port` |
| `url` | Parsed URL | the URL |
| `secret` | Opaque reference to a vault item or a memfd_secret fd | `«secret:name»` (never the value) |
| `grant` | Biscuit token + decoded summary | `grant(t-…: net api.github.com:443 GET 29m left)` |
| `job` | Job handle (§4.9) | `%3` |
| `list<T>` | Vector | one element per line |
| `record{…}` | Ordered map text → value | `key=value` pairs separated by tabs |
| `table<record>` | List of records with a common schema | TSV with header row |
| `closure` | Captured environment + body | `<closure>` |
| `error` | Error record (§4.10) | `error: <kind>: <message>` |

#### 4.3.2 Labels on values

Every value that came from outside kish carries the **label** of its source:
- output of an external command → that command's session label at exit, as reported by `broker` for its principal;
- file contents → the file's `security.bpf.keylos.label` or the location default (protocols §14.1);
- network responses fetched through `gate` → the connection label.

Labels propagate through operations (the result's label is the join of the inputs' labels). They do not restrict what kish computes; they are recorded in history and shown in the prompt (§4.12). kish reports a raise to `broker` with `Broker.raiseLabel` only when it actually reads labelled bytes into its own process. This keeps the shell principal's broker label honest.

#### 4.3.3 Paths are not capabilities

A `path` value is only a name. It becomes a capability (`file` or `dir`) when:
- kish passes it to a parameter typed `file`/`dir` (§4.4.3), or
- the human uses `open` (§4.11).

Resolution rule (REQ-KISH-013):
1. Normalise the path lexically. `..` above the root is an error.
2. Find the **held root** with the longest prefix that contains the path. Held roots are: the shell root grants, the cwd dirfd, and dirs opened earlier in this session.
3. `openat2(rootfd, rel, flags, RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS)`. Symlinks are allowed only if they resolve beneath the root.
4. If no held root contains the path, then:
   - in interactive mode, call `Broker.request` with `ResourceRef.path`; this may show a T2/T3 approval or a powerbox confirmation, depending on policy;
   - in script mode, raise `denied`.

`~` expands to the human's home root. `.` and relative paths resolve against the cwd dirfd.

#### 4.3.4 Conversions

| From → To | Rule |
|---|---|
| text → int/float/size/duration/time/bool | Parse with the literal syntax; failure raises `type` |
| text → path | Path literal rules |
| text → host/url | Parse; failure raises `type` |
| record list → table | When every record has the same keys |
| any → text | Text form (§4.3.1) |
| bytes → text | UTF-8 decode; invalid sequences raise `type` unless `to text --lossy` |
| secret → any | Forbidden. A secret value can only be passed to parameters typed `secret-ref` or to `vault` builtins |

### 4.4 Commands and functions

#### 4.4.1 Command resolution

For `name args…`, kish resolves `name` in this order:
1. A function declared with `fn` in a lexical scope enclosing the call.
2. A builtin (§4.11).
3. The **command index** entry for `name` (§4.7).

`^name` skips steps 1–2. A path in command position (`./build.sh`, `/usr/bin/x`) is accepted only when it resolves inside a sealed generation's view (for example a script shipped in an installed generation). Otherwise kish raises `integrity` with the hint `this file is not sealed; run it in a workbench (work) or seal it (seal)`.

#### 4.4.2 Function declarations

```kish
fn deploy(target: host, --dry-run(-n): bool = false, ...extra: text) -> record [summary = "Deploy the build"] {
    let build = open ./dist          # dir capability
    if $dry_run { return { target: $target, files: (ls $build | count) } }
    rsync --archive $build $target
}
```

- Parameters map to a cmdsig: positionals → `args`, `--name` → `flags` (a flag's parameter is reachable as `$name` with `-` replaced by `_`), `...rest` → a variadic arg, `$in: T` → `input.type`.
- The return type maps to `output`: `record`/`table`/`list<record>` → `records` with the derived schema; `text`/`bytes` → `bytes`; anything else → `any`.
- A function runs in-process with the caller's authority. Functions are not principals.
- Recursion is allowed, with a depth limit of 1000.

#### 4.4.3 Argument conversion by signature

Each argument is converted to the declared parameter type of the resolved command:
- For external commands, the type comes from cmdsig `args[i].type` or `flags[j].type`.
- **Commands without a cmdsig** (legacy): every argument is `text`, except arguments written as path literals or produced by glob literals. Those are what the human typed as paths, so they are treated as `file`/`dir` parameters with access `read`: opened, passed as fds, and replaced by `/dev/fd/<n>`. `run --write <path>` upgrades one named path to `readwrite` (or `create` if it does not exist). The cwd is granted read-only, unless `run --rw-cwd` is given.
- `file` and `dir` parameters: a `path` value is opened per `access`:

  | `access` | file | dir |
  |---|---|---|
  | `read` | `O_RDONLY` | `O_PATH \| O_DIRECTORY` + read grant |
  | `write` | `O_WRONLY \| O_TRUNC` | `O_PATH \| O_DIRECTORY` + write grant |
  | `create` | `O_WRONLY \| O_CREAT \| O_EXCL` | create the dir, then `O_PATH` |
  | `readwrite` | `O_RDWR` | `O_PATH \| O_DIRECTORY` + read/write grant |

  A `file`/`dir` value already open is passed as is, if its access is at least what the parameter needs.
- **Directory grants for external commands.** An fd alone does not let a Landlocked child open files beneath an `O_PATH` dirfd if Landlock denies the path. kish therefore also passes a token: it calls `Broker.attenuate` on the shell root token, with checks limiting it to the directory and the access, and attaches the result in `SpawnSpec.grants`. `warden` turns it into the Landlock rule (protocols §9.1, item 3).
- `host` and `url` parameters: kish requests (or reuses) a `net` grant for the host and port, attenuated with the cmdsig `net[]` methods, and attaches it. The child connects through `gate`; kish never opens sockets for it.
- `secret-ref` parameters: kish passes the vault item name as text, plus a grant for `ResourceRef.secret`. The child opens the secret itself through `vault`.

### 4.5 Pipelines

#### 4.5.1 Stage kinds

| Kind | Runs | Input/output |
|---|---|---|
| Builtin | In-process (async task) | kish values |
| Function | In-process | kish values |
| External, native (has cmdsig) | `warden.spawn` | `records` (CBOR sequence) or bytes, per cmdsig |
| External, legacy (no cmdsig) | `warden.spawn` (tier legacy via `compat` if the generation kind is `legacy-image`) | bytes |
| Expression stage | In-process | value(s) |

#### 4.5.2 Type checking

For each adjacent pair (P, C), with P's output type and C's input type:

| P output \ C input | `none` | `bytes` | `records` | `any` |
|---|---|---|---|---|
| `none` | ok | ok (empty) | ok (empty) | ok |
| `bytes` | **error** `pipe-type` | ok | **error** unless an in-process `from <format>` stage is inserted by the user | ok (bytes) |
| `records` | **error** | ok (TSV text) | ok (cbor-seq; schemas checked) | ok (records) |
| `any` (in-process value stream) | **error** | ok (text form) | ok if values are records | ok |

- **Schema check:** if both sides declare record schemas, every field the consumer declares as required MUST exist in the producer schema with a compatible type. Otherwise kish raises `pipe-schema` before starting.
- `kish --explain` (and the language server) prints the negotiated format of each pipe.

#### 4.5.3 Execution

1. Build all stages. For each external–external edge, create a pipe with `pipe2(O_CLOEXEC)` and pass the ends as fd 1 and fd 0 (no `O_CLOEXEC` in the child; `warden` maps them).
2. For in-process ↔ external edges, kish owns one end and pumps values: it encodes CBOR sequence items (RFC 8742) or text lines, with backpressure.
3. Spawn the external stages left to right. Because spawns can fail (`denied`, `integrity`), kish spawns all of them before writing any input. If a spawn fails, it kills the stages already started.
4. Wait for all stages. The pipeline result is:
   - the value stream of the last in-process stage, or
   - for an external last stage in an expression context (`$(…)`, assignment): its decoded output (records → table/list; bytes → `text` if valid UTF-8, else `bytes`). In statement context, output goes to the job's stdout.

`SIGPIPE`: an external producer whose consumer has exited sees `EPIPE`/`SIGPIPE`. A stage that exits from `SIGPIPE` after its consumer finished is **not** an error.

#### 4.5.4 Redirections

| Operator | Meaning | Open flags |
|---|---|---|
| `> p` | stdout to file | `O_WRONLY \| O_CREAT \| O_TRUNC` |
| `>> p` | stdout append | `O_WRONLY \| O_CREAT \| O_APPEND` |
| `< p` | stdin from file | `O_RDONLY` |
| `2> p`, `2>> p` | stderr | as above |
| `&> p`, `&>> p` | stdout and stderr | as above |
| `2>&1`, `>&2` | duplicate | |
| `<<< expr` | stdin from a value (text form or CBOR if the consumer reads records) | pipe |

Redirection targets follow the path resolution rules (§4.3.3). In `try` blocks they resolve against the transaction view. A redirection to a `file` value uses that fd directly.

Redirecting the output of a `records` producer to a file writes the TSV text form, unless the target name ends in `.cbor` or `.cborseq` (CBOR sequence) or `.json`/`.jsonl` (kish converts in-process).

### 4.6 Globbing

- **Glob literals** are expanded at the point of evaluation, relative to the resolved base dir (the cwd or the literal's directory prefix), using `openat2` beneath held roots. Patterns: `*`, `?`, `[…]`, `**` (recursive, does not follow symlinks), `{a,b}` (alternation). Hidden entries (starting with `.`) match only if the pattern component starts with `.`.
- **Results** are sorted by byte order of the path and produced as a `list<path>`. In argument position the list is spread into separate arguments, each a `path`.
- **No match** raises `glob-empty`. The optional form `g?"*.rs"` yields an empty list instead. There is no bareword spelling of the optional form.
- Variables and command output are never glob-expanded. `glob $pattern` (builtin) expands an explicit pattern held in a variable.

### 4.7 The command index

- At startup kish calls `Depot.list("app", "")` and `Depot.list("legacy-image", "")`. From each launchable generation's manifest it builds the map `provides.commands[i] → (generation ref, entrypoint, cmdsig)`:
  - The cmdsig is read from the generation's `/.keylos/cmdsig/<name>.json` with `Depot.openObject`, verified by the generation's fs-verity chain.
  - Entrypoint selection: the manifest entrypoint whose `kind` is `cli` and whose exec basename equals the command name, else `cli`, else `main`.
- **Conflicts:** two generations providing the same command. The human's config `commands.prefer` chooses; otherwise kish uses the most recently installed and warns once. Qualified invocation: `org.example.Editor::editor-cli`.
- The index is cached in `$XDG_CACHE_HOME/index.cbor`, keyed by the depot generation list digest, and refreshed when depot's list changes (`watch` loop on `Depot.list` polling every 10 s, or on `rehash`).
- `which name` prints the resolution: function, builtin, or generation name, version, ref and entrypoint.

### 4.8 Spawning external commands

For each external stage, kish constructs a `SpawnSpec`:

| Field | Value |
|---|---|
| `generation` | From the command index |
| `entrypoint` | From the command index |
| `argv` | Converted arguments (file/dir args replaced by `/dev/fd/<n>`) |
| `env` | `export`ed variables + `KEYLOS_PIPE_IN/OUT` + `KEYLOS_ARGFD_*` (protocols §12.1, §12.2) + `TERM`/`COLUMNS`/`LINES` for terminal jobs. These `KEYLOS_*` names are the `shell` exception of protocols §10.5: `warden` accepts them only from a `shell` spawner and verifies that every fd named in `KEYLOS_ARGFD_*` is present in `fds`. `KEYLOS_PRINCIPAL`, `KEYLOS_SESSION`, `KEYLOS_TIER`, `KEYLOS_CAPWIRE_FDS`, `KEYLOS_TXN` and XDG variables are set by `warden`, not kish. kish sets no other `KEYLOS_*` name |
| `fds` | 0, 1, 2 (job pty secondary, pipes or redirect fds), then argument fds from 3 upward, in argument order |
| `grants` | Attenuated tokens for dir arguments, net arguments and secret-refs (§4.4.3); plus tokens from `run --grant` |
| `cwd` | The cwd dirfd, or a transaction view dirfd inside `try` |
| `transaction` | The `try` transaction ID inside a `try` block; empty otherwise |
| `limits` | Defaults from config; `run --mem 2GiB --cpu-weight 50 --timeout 10m` overrides |
| `terminal` | Job pty secondary for foreground jobs with a tty; none for pipelines' inner stages and background jobs |
| `session` | Empty; `warden` generates the child session |
| `actorKind` | `app` (or `legacy` for legacy-image generations) |

- The argument fd numbering is deterministic, so cmdsig-aware programs can rely on `KEYLOS_ARGFD_*` and legacy programs on `/dev/fd/<n>`.
- **Tier selection** is `warden`'s and `broker`'s job (manifest tier and policy floor). kish can only raise it.
- **Tier-2 native apps.** When the effective tier of a native `app` generation is t2 (manifest `tier: 2`, `reproducible: false`, an unreviewed catalog entry, or a policy floor; protocols §6.3, §11.8), `warden.spawn` fails with `kl:unsupported:t2`. kish then launches it in a VM on `bench#user` with purpose `app` (allowed to kish and the atrium launcher, protocols §19.2): `Bench.start(VmSpec{purpose: app, image: config vm.app_image (default io.keylos.app-vm), storeSet: [<app generation>, <its runtime>], shares: <the dir arguments, read-only unless the cmdsig access is write>, display: <entrypoint kind == gui>, vcpus and memory from config `vm`})`, then `Vm.exec` of the entrypoint with the argument mapping above rewritten to guest paths (`/shares/<name>/…`). File arguments are copied into the VM's `grants` share (bench §4.6). The VM is stopped when the job ends.
- `run --tier t2 cmd args` uses the same path for a command whose generation would otherwise run at tier 1. For a command that is not an `app` generation (an arbitrary tool), kish uses purpose `workbench` with `io.keylos.workbench-base`, which gives tier-3 isolation, at least as strong as the requested tier 2.

### 4.9 Jobs

#### 4.9.1 Job model

A **job** is one pipeline statement. It has:
- an ID (`%1`, `%2`, … per session);
- its stages' `Process` capabilities and pidfds;
- for a foreground job with a terminal, its pty pair;
- a state: `running`, `stopped`, `done(status)`, `failed(error)`;
- a **job log**: a ring buffer, 1 MiB by default, holding output of background jobs;
- the start time and the command text.

#### 4.9.2 Terminal relay

- kish puts the outer terminal (fd 0 from `atrium-term`) into raw mode while a foreground job runs, and relays:
  - outer input → job pty primary
  - job pty primary output → outer terminal
  - `SIGWINCH` on the outer terminal → `TIOCSWINSZ` on the job pty
- Relay uses `epoll` with edge-triggered reads, 64 KiB buffers, and no extra copies beyond one read and one write.
- The job's line discipline handles `^C` (`SIGINT` to the job's foreground process group inside its own session), `^\` and so on. That is ordinary pty behaviour inside the job.
- kish intercepts only these keys on the outer stream while relaying:

  | Key | Action |
  |---|---|
  | `Ctrl-Z` (when `job.suspend_key` is enabled, default on) | Suspend the job (§4.9.3) and return to the prompt |
  | `Ctrl-\` `Ctrl-\` (double, within 300 ms) | Send `kill` to the job (`Process.kill` on every stage) and return to the prompt |

  All other bytes pass through untouched. A single `Ctrl-\` passes through.
- When the job has no terminal (non-tty pipeline), kish keeps the outer terminal in cooked mode. `Ctrl-C` is read by kish as an interrupt (via `ISIG`'s `SIGINT` to kish itself), and kish forwards `SIGINT` to every stage with `Process.signal`.

#### 4.9.3 Suspend and resume

There are no process groups or `SIGTSTP` on kish's terminal. Suspend means freezing the job's cgroups:
1. For each stage, kish calls `Process.freeze()` (cgroup freezer, protocols §7.3.2). Every process of the stage's principal stops, including helpers it forked. The job state becomes `stopped`.
2. kish restores the outer terminal to its own mode and prints `[%1 stopped] <cmd>`.
3. `fg %1`: return the terminal relay to the job, then `Process.thaw()` for every stage. `bg %1`: `thaw` without a terminal. The job's pty stays allocated; output produced while in the background goes to the job log, because the relay is detached. Reads from its pty block until it returns to the foreground.

`stop` and `cont` are the builtin forms of the same calls. Signals to a job (`kill --signal`, `^C` forwarding) use `Process.signal`, which `warden` delivers to every process of the stage's cgroup.

#### 4.9.4 Background jobs

`cmd &` starts a job without a terminal:
- stdin is an empty pipe;
- stdout/stderr go to the job log, unless redirected.

When it finishes, kish prints `[%2 done 0] cmd` before the next prompt. `job log %2` prints the log. `job log %2 --follow` streams it.

#### 4.9.5 Job builtins

`jobs`, `fg`, `bg`, `stop`, `cont`, `kill`, `wait`, `job log`, `job info` (shows principal, tier, generation, pidfds and the confinement report from `Process.confinement`).

#### 4.9.6 Exit of kish

On exit, kish:
- sends `SIGHUP` to foreground and stopped jobs (`Process.signal`), followed by `kill` after 5 s;
- leaves background jobs running only if started with `&!`. Those are detached: kish drops its `Process` capabilities and `warden` keeps them in the user's apps slice.

### 4.10 Errors

#### 4.10.1 Error values

An error is a record:

```
{ kind: text, message: text, code: text?, ref: text?, exit: int?, signal: int?, stage: int?, cmd: text?, source: { file: text, line: int, col: int }?, cause: error? }
```

**Kinds:**

| Kind | Meaning |
|---|---|
| `parse`, `type`, `name` (unknown variable/command), `arity` | Language errors |
| `glob-empty`, `pipe-type`, `pipe-schema` | §4.5, §4.6 |
| `exit` | External command failed; `exit` or `signal` set |
| `kl` | A `kl:<code>` error from a service; `code` is the protocols error code; `ref` is set for `needs-approval` |
| `io` | OS error; `code` is the errno name |
| `interrupted` | User interrupt |
| `user` | Raised by `error "msg"` / `fail` |

#### 4.10.2 Exit codes of external commands

- 0 is success.
- A non-zero code `c` is **non-fatal** if the cmdsig `exit` map has key `"c"` whose description is `ok` or starts with `partial` or `no-match`. The statement then succeeds, and `$status` holds `c` and the description.
- Any other code is an `exit` error.
- Commands without cmdsig: every non-zero code is an error. `^grep pattern ?? null` handles it.

#### 4.10.3 Handling

- **Propagation:** an error aborts the current statement and every enclosing block up to the nearest handler. In interactive mode, an unhandled error prints a diagnostic and returns to the prompt. In a script, it exits with status 1, or the external exit code if the error kind is `exit`.
- **`catch`:** `pipeline catch err { … }` or `{ … } catch err { … }`. The handler's value replaces the failed value. `catch` without a name binds `$err`.
- **`??`:** `expr ?? fallback` evaluates `fallback` if `expr` raises **or** yields `null`.
- **`?` postfix:** `expr?` turns an error into `null` (and drops it).
- **`error "msg"`** raises a `user` error. **`fail`** re-raises `$err` inside a handler.
- **`needs-approval`:** when a service raises `kl:needs-approval:<a-…>`:
  - Interactive: kish prints `waiting for approval a-… (decide on the trusted path)` and waits:
    - when the approval came from kish's own `Broker.request` (grants, `debug`), on the returned `Approval` (`wait`);
    - otherwise (for example `Intent.commit` at gate), by watching the ledger for the `approval.decide` receipt of that approval ID (`Ledger.watch` on `ledger#reader`, filter `eventTypes: ["approval.decide"]`, own session) with a fallback poll of the call's status every 2 s (`Intent.status` for intents).

    On a granted decision kish retries the original call once. `Ctrl-C` stops waiting (the approval itself stays pending on the trusted path until it expires or the human denies it).
  - Scripts: the same, unless `--no-wait-approval` is set, in which case the `kl` error propagates.

### 4.11 Builtins

All builtins ship cmdsig files in the kish generation, so completion, help and the language server treat them like external commands.

#### 4.11.1 Core

| Builtin | Signature | Behaviour |
|---|---|---|
| `cd` | `cd [dir: dir(read)]` | Changes the cwd dirfd. `cd -` returns to the previous one. Without an argument, goes to the home root. |
| `pwd` | `pwd -> text` | Display path of the cwd |
| `print` | `print ...values: any [--err] [--no-newline]` | Writes text forms |
| `echo` | alias of `print` | |
| `exit` | `exit [code: int = 0]` | |
| `help` | `help [name: text]` | From cmdsig: summary, arguments, flags, input/output types, effects, exit codes |
| `which` | `which name: text -> record` | §4.7 |
| `rehash` | `rehash` | Rebuild the command index |
| `env` | `env -> record` | Exported variables |
| `history` | `history [--search text] [--forget range] [--label]` | §4.12.2 |
| `source` | `source file: file(read)` | Runs a **sealed** kish file in the current scope (REQ-KISH-050, -051) |
| `time` | `time { block } -> record` | Wall, user and sys time (from `ExitStatus.cpuNanos`) and max RSS |
| `timeout` | `timeout d: duration { block }` | Kills jobs started in the block on expiry and raises `interrupted` |
| `retry` | `retry [--times 3] [--backoff 1s] { block }` | Retries on `exit` and `kl:unavailable` errors only |
| `run` | `run [--tier t1\|t2] [--grant g...] [--write path...] [--rw-cwd] [--mem size] [--cpu-weight int] [--timeout duration] cmd args...` | Spawns with explicit limits, grants, write access for named paths (§4.4.3) or a raised tier |
| `open` | `open p: path [--write] [--create] [--append] -> file\|dir` | Opens a path into a capability value |
| `glob` | `glob pattern: text [--base dir] -> list<path>` | Explicit expansion |
| `error` / `fail` | | §4.10.3 |
| `is` | `is value type -> bool` | Type test |
| `describe` | `describe value -> text` | Type and label |

#### 4.11.2 Data

All data builtins run in-process and operate on value streams.

| Builtin | Purpose |
|---|---|
| `get path` | Field or index access (`get a.b.0`) |
| `select ...fields` | Keep fields |
| `reject ...fields` | Drop fields |
| `where closure` | Filter, e.g. `where { $it.size > 1MiB }` |
| `each closure` | Map |
| `reduce --init v closure` | Fold |
| `sort-by ...fields [--reverse]` | Stable sort |
| `group-by field` | Records → record of tables |
| `uniq [--by field]` | Deduplicate |
| `first [n]`, `last [n]`, `skip n`, `take n` | Slicing |
| `count`, `sum`, `min`, `max`, `avg` | Aggregates |
| `flatten`, `zip`, `enumerate`, `range` | List operations |
| `insert`, `update`, `rename`, `merge` | Record operations |
| `lines`, `split by sep`, `trim`, `replace pattern with`, `matches regex` | Text (regex dialect: Rust `regex` crate syntax) |
| `from json\|jsonl\|yaml\|toml\|csv\|tsv\|cbor\|cbor-seq\|ini\|xml` | Parse bytes/text into values |
| `to json\|jsonl\|yaml\|toml\|csv\|tsv\|cbor\|cbor-seq\|text\|table` | Render values. `to table` is the default for interactive display |
| `table` | Pretty-print with column widths, truncation and colour |

#### 4.11.3 Variables and modules

`let`, `var`, `export` (keywords); `unexport name`; `use module` (sealed modules, §4.13.4); `vars` (list bindings in scope).

#### 4.11.4 keylos builtins

| Builtin | Signature | Service calls |
|---|---|---|
| `grant` | `grant (dir\|file p \| net host:port [--method M...] \| device id \| secret name \| effect kind \| budget amount unit) [--rights r...] [--for duration] [--persist] [--reason text] -> grant` | `Broker.request`; waits on `Approval` if pending |
| `grants` | `grants [--all] -> table` | `Broker.myGrants` + `Broker.inspect` |
| `revoke` | `revoke g: grant\|text` | `Broker.revoke(rootId)` |
| `label` | `label -> record` | `Broker.label` |
| `try` | `try [--in dir...] [--net \| --net-inherit] [--commit\|--abort\|--keep] [--name text] { block }` | `Strata.begin`, `StrataTxn.txnExt`, `Transaction.*`, `TransactionExt.*` (§4.11.5) |
| `txn` | `txn (list \| show id \| diff id [path] \| resolve id path (ours\|theirs\|--merged file) \| keep id \| commit id \| abort id)` | `Strata` transactions begun by this session (`StrataTxn.txnExt`) |
| `undo` | `undo [txn-id: text]` | `Strata.undo` |
| `why` | `why p: path -> record` | `Strata.why(fd)` |
| `snapshot` | `snapshot [subvolume] [--reason text]`; `snapshot list [subvolume]` | `Strata.snapshot`, `Strata.snapshots` |
| `restore` | `restore snap-id path [--to dir]` | `Strata.restore` |
| `effects` | `effects [--session id...] [--state s]`; `effects show e-id`; `effects commit e-id [--yes] [--no-wait]`; `effects cancel e-id [--yes]`; `effects compensate e-id`; `effects dry-run e-id` | `Gate.intents` for listing; `Gate.intent(id)` → `Intent.*` for the rest (§4.11.6) |
| `debug` | `debug target [--kernel] [--with name] [--for duration] [--reason text] [-- args...]` | `Broker.request` (Right.debug, T3 + presence) → `Broker.debug` → foreground job (§4.11.7) |
| `seal` | `seal [--project dir] [target...]` | Runs the `seal` command from the `forge` generation through the command index, with the project dir granted. `forge` builds in a workbench, opens a sealing window through `HearthSeal` (one presence touch on the trusted path, at most 600 s, one project), and attaches the seal statement with `Depot.seal`. kish adds nothing except fd passing and waiting. |
| `work` | `work [project: dir = .] [--fresh] [--snapshot name]` | `Bench.project(projectDir)` → `Vm.console()` relayed like a foreground job. `exit` in the VM shell returns to kish. |
| `agent` | `agent start --template gen\|name [--task text] [--project dir] [--budget usd] [--for duration] [--grant g...]`; `agent list`; `agent attach id`; `agent send id text`; `agent review id`; `agent stop id`; `agent fork id` | `Aide.start`, `Aide.sessions`, `Aide.attach`, `AgentSession.*`. Grants passed to an agent are attenuated from the shell's own with `Broker.delegate` (child session). |
| `approvals` | `approvals` | Lists pending approvals for this human (`Broker.myGrants` plus `kl:needs-approval` refs kish is waiting on). Deciding them happens only in atrium's trusted UI, never in kish. |

#### 4.11.5 `try` in detail

```kish
try --in ./project --name "bump deps" {
    cargo update
    cargo build --release
}
```

1. Resolve the `--in` dirs (default: the cwd) to `dir` capabilities. Call `Strata.begin(dirs, networkPolicy)` with `NetworkPolicy.deny`, `gate` if `--net`, or `inherit` if `--net-inherit`. Then get the `TransactionExt` with `StrataTxn.txnExt(id)`.
2. Get the view dirfds with `Transaction.view()`. Inside the block, kish's own path resolution maps any path under a transaction dir to the corresponding view dirfd. The cwd dirfd is replaced if it is under a transaction dir.
3. Run the block. External commands are spawned with `SpawnSpec.transaction = id`, so `warden` mounts the views over the original paths in each child's namespace and sets `KEYLOS_TXN`. Their argument, cwd and redirection fds are opened through the view dirfds. Grants are attenuated tokens over the **view** roots.
4. At the end of the block, or when it raises:
   - Call `Transaction.changes()` and `Transaction.conflicts()`.
   - Interactive: show a summary (counts by kind, first 20 paths, conflicts) and prompt: `[c]ommit [d]iscard [v]iew diff [k]eep [?]`. `v` pages `Transaction.diff(path)` output through the pager.
   - With conflicts, commit is offered only after each conflicting path is resolved with `TransactionExt.resolve(path, ours | theirs | merged)`, or after the human chooses keep.
   - Keep: `TransactionExt.pin(true)`, so the transaction stays `Open`, is exempt from the TTL, and can be resumed with `try --resume x-…` or finished with `txn`.
   - On commit: `Transaction.commit()` returns the pre-commit snapshot ID. kish records `{txn, snapshot, name, time}` in the session's undo stack.
5. If the block raised and the human did not choose commit, kish aborts.
6. The value of `try` is a record `{ id, committed: bool, changes: int, snapshot: text? }`.

Nested `try` is an error (`kl:unsupported`).

#### 4.11.6 `effects` in detail

```kish
effects                                   # table: id, kind, class, state, target, session, age
effects show e-01JB…                      # rendering (Intent.dryRun), args with provenance, state history, result
effects commit e-01JB…                    # shows the rendering, asks y/N, then Intent.commit()
effects cancel e-01JB…
```

1. **List:** `Gate.intents(<kish's own session>)`, which returns the intents of kish's session and of every descendant session, recursively (protocols §7.3.7); `--session id` narrows the call to that descendant session (gate returns an empty list for a session outside kish's tree). Records are typed `{id, kind, class, state, target, session, result, receipt}`.
2. **Obtain:** `intent := Gate.intent(id)` (REQ-KISH-046). gate returns it only for kish's own session tree; `kl:not-found` otherwise.
3. **Commit:** print `Intent.dryRun()` lines (rendered effect, rendered by gate, shown as untrusted text: control characters stripped, bidi isolated); ask `commit e-… (<kind>, <class>)? [y/N]` unless `--yes`; call `Intent.commit()`:
   - success → print the `IntentStatus` (for caller-executed kinds the result names the executor);
   - `kl:needs-approval:<a-…>` → wait per §4.10.3, then retry `commit` once; with `--no-wait`, print the approval ID and return the `kl` error;
   - `kl:denied` / `kl:integrity` → error value.
4. **Cancel:** confirmation as above, then `Intent.cancel()`.
5. **Compensate:** `Intent.compensate()`; for caller-executed kinds gate answers `kl:unsupported` and kish prints gate's hint.
6. The prompt field `approvals` counts pending approvals kish is waiting on; `effects` marks intents in `staged` with an awaiting-approval result.

#### 4.11.7 `debug` in detail

```kish
debug %2                                  # gdb on job 2's principal for the default 30 minutes
debug %2 --with perf -- record -g         # perf on the same target
debug gen:fsv256:3f9a… --kernel --with bpftrace --for 10m -- -e 'tracepoint:syscalls:sys_enter_openat { @[comm] = count(); }'
```

1. **Target:** `%N` → the session of job N's principal (from `Process.principal()`); `session:s-…` or `gen:fsv256:…` literally. The target's human MUST be kish's human (REQ-KISH-073).
2. **Debugger:** `--with name` (default `debug.default` from config) resolved through the command index; the generation name MUST be in config `debug.debuggers`.
3. **Grant:** `Broker.request(GrantRequest{resource: {principal: {target, scope: process | kernel}}, rights: [debug], reason, durationSecs: --for (default 1800; ≤ 3600 process, ≤ 900 kernel)})`. The trusted path shows a T3 prompt with presence; kish waits (§4.10.3).
4. **Attach:** allocate a job pty; `Broker.debug(token, debuggerRef, entrypoint, argv, ptySecondary)`; the returned `Process` becomes a foreground job named `debug:<target>`. warden spawns the debugger with seccomp profile `debug-1` and writes the `kl_debug_pairs` entry (protocols §7.5.1, §9.3).
5. **End:** when the job exits or the grant expires, warden removes the pair and writes `debug.detach`; kish prints `[debug %3 ended: <reason>]` and drops the token.
6. A debugger session is a normal job: `Ctrl-Z` freezes the debugger (not the target), `kill` ends it.

### 4.12 Interactive mode

#### 4.12.1 Line editor

- Emacs and vi keymaps, multi-line editing, bracket matching, and syntax highlighting with live parse.
- Variables and commands are coloured by resolution: function, builtin, indexed command, unknown.
- Hints come from history.
- `Alt-Enter` inserts a newline. `Ctrl-R` searches history. `Ctrl-X Ctrl-E` edits in `$EDITOR`: kish spawns the editor command with a temp file in its own `.apps` cache dir, granted read-write.

#### 4.12.2 History

- Stored in `$XDG_STATE_HOME/history.cbor`, as a CBOR sequence, append-only, fsync on each entry.
- Fields: `{text, start, duration, exit, cwd, label, txn?, session}`.
- Entries labelled `secret` are kept in memory only (REQ-KISH-061). Entries labelled `private` are excluded from any sync.
- `history --forget <range>` rewrites the file without those entries. Because the file lives in the kish data unit, `Strata.forget` of that unit crypto-shreds all history including snapshots.

#### 4.12.3 Completion

| Context | Completion source |
|---|---|
| Command position | Functions, builtins, index commands (with summary) |
| Arguments | By cmdsig type: `file`/`dir` → entries beneath held roots; `enum` → values; `host` → hosts from current grants and `known_hosts`-style history; `bool` flags → none; `secret-ref` → vault item names (`Vault.list`, names only) |
| Flags | `--` → declared flags with summaries |
| Variables | `$` → bindings in scope; `$env.` → exported |
| Legacy commands (no cmdsig) | Generic path completion only |

#### 4.12.4 Prompt

- The prompt is produced by the config template (§10) with fields: `user`, `host`, `cwd`, `status`, `duration`, `jobs`, `label`, `txn` (open transactions), `approvals` (pending count), `git` (branch and dirty state, computed by running the `git` command with the cwd granted read-only, cached with a 2 s budget, and disabled automatically if slower).
- **Label indicator:** when the session label is not `internal/user`, the prompt starts with `[conf/integ]`, for example `[private/untrusted]`. Colours: `private` amber, `secret` red; `untrusted` underlined.

### 4.13 Scripts and integrity

#### 4.13.1 Script files

- Script files use the extension `.ksh` (not to be confused with other shells; kish never reads other shells' rc files) and the shebang `#!/usr/bin/kish`.
- A script that is meant to run as a command ships inside a generation (kind `app`). Its manifest declares `provides.commands` and a cmdsig. Its parameters are the parameters of a top-level `fn main(…)`, which kish calls with the converted arguments.

#### 4.13.2 Execution checks

When kish is asked to interpret a file (`kish file.ksh`, an index command whose entrypoint is a `.ksh`, `source`, `use`):
1. Open the file `O_RDONLY | O_CLOEXEC`.
2. `execveat(fd, "", NULL, NULL, AT_EMPTY_PATH | AT_EXECVE_CHECK)`. On error: `EACCES`/`EPERM` → `integrity` error and exit 126; `ENOSYS`/`EINVAL` (feature level below KL1) → refuse unless `kish.integrity.allow_unchecked` is set. That setting cannot be enabled in the config generation when the system is in the integrity profile; `config` rejects it.
3. Read and parse from that same fd. Never reopen by path.

#### 4.13.3 Interactive input

At start:
- read securebits with `prctl(PR_GET_SECUREBITS)`;
- if `SECBIT_EXEC_DENY_INTERACTIVE` is set, refuse `-i`, `-c`, and reading commands from stdin (exit 126, `integrity`).

`warden` sets this bit for every host principal **except** the **trusted-terminal tree** (protocols §9.3), which gets only `SECBIT_EXEC_RESTRICT_FILE`. The tree is:
- the kish process spawned through `TrustedSpawn.spawnTerminal`;
- every process kish spawns as a job, foreground or background, including interactive interpreters (a Python or kish REPL started from the prompt).

A process spawned by any other program in that tree (an editor that starts a helper, a build tool that starts a compiler) is outside the tree and gets both bits. `warden` decides by the spawning principal's actor kind (`shell` from the trusted terminal) and the `SpawnSpec` origin, which is why kish spawns every job itself (REQ-KISH-055). kish does not try to infer trust from environment variables or tty names.

#### 4.13.4 Modules

- A **kish module** is a sealed generation of kind `data` containing `.ksh` files under `/kish/modules/<name>/`.
- `use name` searches the module generations listed in the config (`modules = ["gen:fsv256:…" or names]`), resolved through `Depot`.
- Users keep personal functions in a project directory and run `seal --project ~/kish-functions` to make them loadable. That is the only way to get startup functions; there is no rc file containing code.

### 4.14 POSIX compatibility mode

- `kish --posix script.sh [args…]` runs the script with a POSIX shell (dash) **inside the legacy tier**:
  - kish asks `Compat.run` with the configured legacy shell image (`io.keylos.legacy.posix-sh`, kind `legacy-image`);
  - argv is `["/bin/sh", "/grants/script/<name>", args…]`;
  - the script file and its directory are granted read-only;
  - the cwd is granted read-write only if `--rw-cwd` is given.
- If the script came from the internet (its label is `untrusted`), or if `--vm` is given, it runs in tier t2.
- `kish --posix -c 'cmd'` works the same with `-c`.
- There is **no** interactive POSIX mode on the host. `kish --posix -i` is refused; use `work` for an interactive POSIX environment.
- Script heuristics: when the human runs a file whose shebang is `#!/bin/sh` or `#!/bin/bash` via `kish file`, kish explains the legacy route and offers `kish --posix` (interactive confirmation; scripts never auto-run).

### 4.15 Language server

`kish-lsp` speaks LSP 3.17 over stdio and provides:
- diagnostics (parse, type and pipe-type checks),
- hover (cmdsig help),
- completion,
- go-to-definition for functions and modules,
- formatting (`kish fmt` rules: 4-space indent, one statement per line, pipelines broken before `|` when longer than 100 columns).

It reads cmdsigs through the same command index. It never executes code.

---

## 5. Interfaces

### 5.1 Command line

```
kish [OPTIONS] [FILE [ARGS…]]
kish -c COMMAND [ARGS…]
kish --posix [--vm] [--rw-cwd] (FILE | -c COMMAND) [ARGS…]
kish fmt [--check] FILE…
kish check FILE…
kish --explain (FILE | -c COMMAND)
```

| Option | Meaning |
|---|---|
| `-i`, `--interactive` | Force interactive mode (requires the trusted terminal, §4.13.3) |
| `-c COMMAND` | Run a command string (refused when `SECBIT_EXEC_DENY_INTERACTIVE` is set) |
| `--posix` | §4.14 |
| `--no-wait-approval` | Approvals raise errors instead of waiting |
| `--commit-txn`, `--abort-txn`, `--keep-txn` | Default action for `try` blocks in scripts |
| `--explain` | Print the resolved commands, tiers, granted fds and negotiated pipe formats without running |
| `--config PATH` | Alternate config file (data only) |
| `--norc` | Skip loading modules listed in config |
| `--version` | Prints `kish 1.0.0 (protocols 1.0.0)` |

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unhandled error (non-exit kind) |
| 2 | Usage or parse error |
| 126 | Integrity refusal (not sealed, interactive denied) |
| 127 | Command not found |
| 128+n | Killed by signal n (from the last stage) |
| other | Exit code of the failing external command |

`kish fmt --check` exits 1 if a file is not formatted. `kish check` exits 2 on parse errors and 1 on type or pipe errors.

### 5.2 Capwire usage

kish is a capwire client only; it implements no capwire server interface.

| Service | Facet (protocols §19.2, Appendix A.21) | Used for |
|---|---|---|
| warden | `client` | `Supervisor.spawn` (children of kish's session), `identify` |
| broker | `principal` | Grants, powerbox, labels, `debug` |
| strata | `user` | `try`, `txn`, `undo`, `why`, snapshots; `StrataTxn` |
| gate | `client` | `effects`: `intents` (own session tree, recursive), `intent` (own session tree) and the returned `Intent` |
| bench | `user` | `work`, `run --tier t2`, `start` with purpose `app` for tier-2 native apps |
| aide | `user` | `agent` |
| depot | `user` | Command index (`list`, `get`, `openObject`) |
| vault | `app` | `list` of own item names for `secret-ref` completion |
| compat | `user` | `kish --posix` (`run`) |
| ledger | `reader` | `receipts` |
| journal | `client` | Logs and metrics |

### 5.3 Manifest of the kish generation

```json
{
  "schema": "keylos.manifest/1", "kind": "app", "name": "io.keylos.kish", "version": "1.0.0",
  "tier": 1,
  "entrypoints": {
    "main": {"exec": "/usr/bin/kish", "args": [], "kind": "cli"},
    "lsp":  {"exec": "/usr/bin/kish-lsp", "args": [], "kind": "cli"}
  },
  "needs": {"jit": false, "gpu": "none", "network": [], "devices": [],
            "services": ["warden#client", "broker#principal", "strata#user", "gate#client", "bench#user", "aide#user", "depot#user", "vault#app", "compat#user", "ledger#reader", "journal#client"],
            "secrets": [], "dataUnits": ["history"], "spawn": ["*"], "labels": {"readsUntrusted": true}},
  "provides": {"commands": ["kish", "kish-lsp"], "services": [], "mimeTypes": ["text/x-kish"], "uriSchemes": [], "agentTools": []},
  "effects": [], "compat": null, "requiresFeatureLevel": "KL1", "reproducible": true
}
```

`needs.spawn: ["*"]` is honoured only for `shell` actor spawns. For any other actor, the broker policy grants spawn rights only for the generations a session explicitly requests.

### 5.4 Files

| Path | Content |
|---|---|
| `$XDG_CONFIG_HOME/kish.ncl` | Config (§10), data only |
| `$XDG_STATE_HOME/history.cbor` | History (§4.12.2) |
| `$XDG_CACHE_HOME/index.cbor` | Command index cache |
| `$XDG_CACHE_HOME/edit/` | Temp files for `Ctrl-X Ctrl-E` |
| `/.keylos/cmdsig/*.json` (in the kish generation) | Cmdsigs of `kish`, `kish-lsp` and every builtin |

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| Malicious command reads files the user didn't name | Children receive only argument fds and attenuated tokens (REQ-KISH-014); Landlock enforced by `warden` |
| Path traversal or symlink tricks in arguments | `openat2(RESOLVE_BENEATH \| RESOLVE_NO_MAGICLINKS)` from held roots (REQ-KISH-013) |
| Script widens its own authority by building paths | Paths not typed on the trusted terminal need broker requests (REQ-KISH-016) |
| Code injection via variable expansion or globbing | One value per expansion, no implicit glob (REQ-KISH-003, -004); external commands get argv vectors, never re-parsed strings |
| Unsealed code on the host | `AT_EXECVE_CHECK` before interpreting (REQ-KISH-050); no rc code (REQ-KISH-054); `--posix` only in the legacy tier |
| Piping commands to the shell from a non-human source (`curl … \| kish`) | `SECBIT_EXEC_DENY_INTERACTIVE` set for every non-trusted-terminal spawn; kish refuses stdin commands |
| Secrets leaking via env or history | No secret export (REQ-KISH-015); `secret` labelled history not persisted |
| Terminal escape injection from command output | kish relays the job pty to `atrium-term`, which filters escape sequences that could change titles or clipboards (OSC 52 disabled; atrium spec). kish strips control characters when rendering untrusted values in tables |
| `TIOCSTI` input injection | Disabled system-wide; separate pty per job |
| Confused deputy: kish acting on a child's behalf | kish never resolves paths a child sends it; there is no interface for children to call kish |
| A child stages a misleading effect and waits for the human to commit it from the shell | `effects commit` shows gate's rendering (not the child's text) and asks for confirmation; irreversible kinds still need a trusted-path approval and mandate |
| Debug grant abuse (attaching to another human's process, long-lived tracing) | Broker mints `Right.debug` only at T3 with presence, ≤ 3 600 s / ≤ 900 s; target human checked by kish, broker and warden; debugger generations limited to the policy list |
| A job's helper gets interactive interpreter rights | Only jobs kish spawns are in the trusted-terminal tree (REQ-KISH-055); helpers spawned by jobs get both securebits |

### 6.2 Confinement of kish itself

- **Tier** t1, sealed generation, its own dynamic UID. Spawned only through `TrustedSpawn.spawnTerminal` for interactive sessions; scripts run as their own principals with both securebits set (protocols §9.3).
- **Landlock:** the shell root grants (home, configured extra roots) at read/write/create/delete/truncate/refer; `/dev/pts` and the outer terminal fd; its `.apps/io.keylos.kish/*` dirs; nothing else. On KL2+, it gets no pathname unix sockets: all services arrive as passed fds.
- **seccomp:** baseline plus `openat2`, `execveat` (only with `AT_EXECVE_CHECK`, enforced by an argument filter on the flags register), `ioctl` on ttys (`TCGETS`, `TCSETS*`, `TIOCSWINSZ`, `TIOCGWINSZ`, `TIOCGPTN`, `TIOCSPTLCK`), and `posix_openpt` (`openat` on `/dev/ptmx`).
- **Privileges:** none. No capabilities, no setuid.
- **Network:** none. The network namespace has only `lo`.
- **Securebits:** `SECBIT_EXEC_RESTRICT_FILE` always; `SECBIT_EXEC_DENY_INTERACTIVE` unless spawned through `TrustedSpawn`.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| `warden` unreachable at start | Print a diagnostic and offer a minimal built-in mode: data builtins only, no spawning. Exit status 69 in scripts |
| `depot` unreachable | Use the cached command index (read-only) and warn. `rehash` fails |
| `broker` unreachable | Commands needing grants fail with `kl:unavailable`; commands with only fd arguments still work if `warden` attaches no tokens |
| `strata` unavailable inside `try` | `try` fails before running the block |
| Transaction commit conflict | The transaction is kept (state `kept`); `txn` shows it; nothing is lost |
| Job pty allocation fails (`ENOSPC`) | Fall back to no-terminal execution for non-interactive commands; interactive commands fail with `io` |
| History file corrupt | Rename to `history.cbor.corrupt-<time>`, start new, warn once |
| Child killed by OOM | `exit` error with `signal = 9` plus `ExitStatus.maxRss` in the message |
| Terminal hang-up | `SIGHUP` handling per §4.9.6 |

---

## 8. Performance budgets

Reference hardware: 4-core x86-64-v3 at 3 GHz, NVMe, 16 GiB.

| Metric | Budget |
|---|---|
| Start to first prompt (index cached) | ≤ 30 ms p95 |
| Start to first prompt (cold index rebuild, 2000 generations) | ≤ 400 ms p95 |
| Keystroke to redraw (highlighting a 200-line buffer) | ≤ 4 ms p99 |
| Parse + type-check of a 1000-line script | ≤ 20 ms |
| Pipeline spawn overhead added by kish (excluding warden) | ≤ 1 ms per stage |
| End-to-end `true` command latency (kish + warden spawn + exit) | ≤ 8 ms p50, ≤ 15 ms p99 |
| Pty relay added latency | ≤ 0.5 ms p99; throughput ≥ 1 GiB/s for `cat` of a large file |
| In-process record throughput (`where`/`select`) | ≥ 2 M records/s single core |
| CBOR-seq encode/decode at external boundary | ≥ 500 MiB/s |
| Resident memory, idle interactive session | ≤ 25 MiB |

---

## 9. Observability

- **Logs:** structured records to the journal stream (protocols §10.6) at levels `info` (startup, index rebuilds), `warning` (conflicts, fallbacks) and `debug` (spawn specs without argument contents). Argument contents and command text are **not** logged. History is the user's record, not the system's.
- **Receipts:** kish writes no receipts (it is not tier 0). The services it calls emit them:
  - `spawn` and `exit` by `warden`;
  - `grant.issue` by `broker`;
  - `txn.begin` and `txn.commit` by `strata`;
  - `effect.commit` and `effect.cancel` by `gate` (also when the human commits from `effects`);
  - `debug.attach` and `debug.detach` by `warden`, `grant.issue` with the debug right by `broker`;
  - `agent.start` by `aide`.

  kish displays receipts on request with `receipts [--session id]`, using a ledger reader capability if granted.
- **Metrics** (exposed through the journal's metrics records every 60 s):
  - `kish_spawn_total`
  - `kish_spawn_errors_total{code}`
  - `kish_pipeline_stages_histogram`
  - `kish_relay_bytes_total`
  - `kish_index_rebuild_seconds`

---

## 10. Configuration

`$XDG_CONFIG_HOME/kish.ncl` is data validated against this Nickel contract. There is no code execution. The system-wide defaults come from the config generation (`/etc/keylos/kish.ncl`) and are merged under the user's file.

```nickel
{
  KishConfig = {
    prompt | String | default = "{label}{cwd} {status}{jobs}› ",
    keymap | [| 'emacs, 'vi |] | default = 'emacs,
    roots | Array { path | String, rights | Array [| 'read, 'write, 'create, 'delete |] } | default = [],
    modules | Array String | default = [],
    commands = {
      prefer | { _ : String } | default = {},
      aliases | { _ : String } | default = {},
    },
    history = {
      max_entries | Number | default = 100000,
      persist_private | Bool | default = true,
    },
    job = {
      suspend_key | Bool | default = true,
      log_size | Number | default = 1048576,
      default_limits = {
        memory_max | Number | default = 0,
        cpu_weight | Number | default = 100,
      },
    },
    try = {
      default_net | [| 'deny, 'gate |] | default = 'deny,
    },
    secrets = {
      env_name_patterns | Array String | default = ["*TOKEN*", "*SECRET*", "*PASSWORD*", "*_KEY", "*APIKEY*"],
    },
    legacy = {
      posix_image | String | default = "io.keylos.legacy.posix-sh",
    },
    vm = {                                              # tier-2 native apps and run --tier t2 (§4.8)
      app_image | String | default = "io.keylos.app-vm",
      tool_image | String | default = "io.keylos.workbench-base",
      vcpus | Number | default = 2,
      memory_mib | Number | default = 2048,
    },
    integrity = {
      allow_unchecked | Bool | default = false,
    },
    git_prompt | Bool | default = true,
    approvals = { wait | Bool | default = true },
    effects = { confirm | Bool | default = true },
    debug = {
      default | String | default = "gdb",
      debuggers | Array String | default = ["gdb", "lldb", "perf", "bpftrace"],   # names; must also be in policy debug.debuggers
      default_duration | Number | default = 1800,
    },
  },
}
```

Notes:
- `commands.aliases` values are command lines that are parsed, not evaluated text substitution. `ll = "ls --long --all"`.
- `roots` adds shell root grants beyond home. Each entry becomes a `Broker.request` at login with `persist: true`. The broker decides; T2 approval by default.

---

## 11. Testing and acceptance criteria

### 11.1 Unit tests

- Lexer and parser: every EBNF production; the disambiguation rules of §4.2.1 (≥ 300 cases); error recovery positions.
- Value model: conversions table §4.3.4; label joins.
- Pipeline typing: the full matrix of §4.5.2, including schema mismatches.
- Exit-code mapping §4.10.2.
- Glob engine against a fixture tree (hidden files, `**`, alternation, symlinks beneath and outside roots).

### 11.2 Integration tests (against `warden`/`broker`/`strata` test doubles from `keylos-protocols` test kits, and against a full keylos VM image in CI)

1. `cat ./a.txt` spawns cat with exactly fds 0, 1, 2, 3, argv `["/dev/fd/3"]` and `KEYLOS_ARGFD_files=3`.
2. A command trying to `openat` a non-granted path in the home dir fails with `EACCES` (Landlock).
3. `let x = "a b *"; printargs $x` passes exactly one argument `a b *`.
4. `ls *.nomatch` raises `glob-empty`; `ls g?"*.nomatch"` passes no arguments.
5. `native-producer | native-consumer`: both see `KEYLOS_PIPE_*=cbor-seq`, and records arrive intact.
6. `native-producer | ^legacy-wc -l` gets TSV text.
7. `try { touch ./new }` with discard: `./new` does not exist afterwards; with commit, it exists; `undo` removes it.
8. `try { curl https://example.com }` fails with a network error under the default policy.
9. `kish ./unsealed.ksh` exits 126 with `integrity`.
10. `echo 'print hi' | kish` exits 126 when spawned with `SECBIT_EXEC_DENY_INTERACTIVE`.
11. Ctrl-Z freezes all stages of `yes | head -c 1G | sha256sum`; `fg` thaws them; the result is correct.
12. `export TOKEN = "x"` is refused.
13. `effects` lists the intents staged by a child spawned from kish; `effects commit e-…` obtains the intent with `Gate.intent`, shows the dry run, and after confirmation commits; an intent of another human's session → "no such intent" (`kl:not-found` from gate).
14. `kish --posix -c 'echo $0'` runs via `Compat.run` and prints `/bin/sh`.
15. `try { touch ./new }` spawns `touch` with `SpawnSpec.transaction` set; the `warden` test double receives the transaction ID and kish's own resolution of `./new` goes through the view dirfd.
16. Ctrl-Z on `sh -c 'sleep 100 & sleep 100'` (a stage that forks) calls `Process.freeze` once for the stage; `fg` calls `Process.thaw`.
17. `effects commit` on an irreversible intent: gate raises `kl:needs-approval`; after the approval is decided on the trusted path (ledger `approval.decide`), kish retries and reports `committed`.
18. `debug %1` on a running job: `Broker.request` with `Right.debug` (T3 + presence); `Broker.debug` returns a process attached as a foreground job; `--for 2h` is refused before any request; a target of another human is refused.
19. In the full VM image, `python3` started from the kish prompt runs interactively (trusted-terminal tree); `python3` started by an editor job's helper refuses interactive input.
20. `kish --explain run --grant net:api.example.com:443:GET curl https://api.example.com` reports "terminated by gate".
21. A non-reproducible native GUI app (`reproducible: false`) started from kish: `warden.spawn` → `kl:unsupported:t2`; kish starts `io.keylos.app-vm` with purpose `app` on `bench#user`, the window appears with a tier-2 border, a file argument is visible at its guest path, and the VM stops when the job exits.
22. `effects` after a three-level job tree stages intents at every level: one `Gate.intents` call lists all of them; `effects --session <unrelated>` lists nothing.

### 11.3 Fuzzing

`cargo-fuzz` targets:
- `fuzz_lexer`, `fuzz_parser` (grammar-aware via `arbitrary`), `fuzz_glob`;
- `fuzz_cbor_seq_decode`, `fuzz_cmdsig_parse`, `fuzz_history_decode`.

Each runs 24 h before a release with no crashes.

### 11.4 Conformance

Pass `keylos-protocols` vectors `capwire/`, `labels/` and the cmdsig cases in `manifest/`.

### 11.5 Acceptance

A release is accepted when:
- every REQ-KISH requirement maps to at least one passing test in the traceability matrix (`tests/traceability.toml`);
- the §8 budgets hold on the reference hardware in CI benchmarks (`criterion` suites, plus end-to-end timing in the keylos VM image).

---

## 12. Implementation notes

### 12.1 Crates

| Crate | Use |
|---|---|
| `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`, `keylos-labels` 1.0 | Contracts |
| `capnp` 0.19, `capnp-rpc` 0.19 | Via keylos-capwire |
| `tokio` 1 | Async runtime (current-thread for the main loop, plus one blocking pool for file I/O) |
| `rustix` 0.38 | `openat2`, `execveat`, pty, termios, prctl securebits |
| `reedline` | Line editor (pinned exact version in `Cargo.lock`; vendored fork patches allowed for raw-mode handover) |
| `nu-ansi-term` | Colours |
| `ciborium` 0.2 | CBOR and CBOR sequences |
| `serde`, `serde_json` 1 | JSON |
| `regex` 1 | Text matching |
| `miette` 7 | Diagnostics rendering |
| `tower-lsp` 0.20 | Language server |
| `nickel-lang-core` | Config validation (pinned exact version) |
| `arbitrary` 1, `libfuzzer-sys` 0.4 | Fuzzing |
| `criterion` 0.5 | Benchmarks |

`#![forbid(unsafe_code)]` everywhere except a small `kish-sys` module for ioctls rustix lacks. Each `unsafe` block carries a safety comment.

### 12.2 Repository layout

```
crates/
  kish-syntax/      lexer, parser, AST, formatter
  kish-types/       value model, types, labels, conversions, cmdsig model
  kish-eval/        evaluator, scopes, functions, errors
  kish-exec/        command index, spawn, pipes, jobs, pty relay, try/txn
  kish-builtins/    builtins (+ cmdsig JSON generation at build time)
  kish-sys/         minimal unsafe ioctls
  kish/             binary: interactive + script front end
  kish-lsp/         language server
cmdsig/             generated cmdsig files (checked in, CI verifies they match)
config/kish.ncl     Nickel contract
tests/              integration tests, traceability.toml
fuzz/               cargo-fuzz targets
pkg/recipe.ncl      forge recipe for io.keylos.kish
```

### 12.3 Build

- `cargo build --release` with `panic = "abort"`, LTO, `codegen-units = 1`.
- Reproducible: `SOURCE_DATE_EPOCH`, `--remap-path-prefix`.
- The forge recipe produces the generation with the cmdsig files in `/.keylos/cmdsig/`.

---

## 13. Decisions and alternatives

### 13.1 Decisions

| Decision | Alternatives considered | Reason | Handbook ADR |
|---|---|---|---|
| Statically negotiated typed pipes from cmdsig | Runtime handshake on the pipe (magic bytes); always-JSON | No in-band negotiation can be spoofed or corrupt legacy byte streams; the shell already knows both ends | [ADR-0036](../../handbook/11-decisions/adr-0036-typed-pipes-via-cmdsig.md) |
| No `$PATH`; command index from depot | Path search over sealed dirs | Commands are generations with identity, cmdsig and tier; filesystem search adds nothing and invites unsealed code | [ADR-0008](../../handbook/11-decisions/adr-0008-host-executes-only-sealed-code.md) |
| Arguments become fds plus attenuated tokens | Bind-mount granted paths only; pass paths and rely on Landlock rules | fds are exact and race-free; tokens let Landlock allow beneath-dir access; paths alone re-resolve | [ADR-0005](../../handbook/11-decisions/adr-0005-biscuit-capability-tokens.md) |
| Per-job pty relay instead of process groups | Classic POSIX job control | Process groups and `tcsetpgrp` give children the shared terminal and `TIOCSTI`-class risks; cgroups plus pidfds are exact | [ADR-0025](../../handbook/11-decisions/adr-0025-namespaces-only-by-warden.md) |
| No code in rc files; sealed modules | `.kishrc` code | An unsealed rc file is persistent code execution on the host, which breaks "reboot heals" | [ADR-0012](../../handbook/11-decisions/adr-0012-sealing-windows.md) |
| `try` is the transaction keyword; errors use `catch` and `??` | `txn { }` keyword; exceptions with `try/catch` | `try` matches the user-facing promise "try it and see"; error handling stays postfix and lightweight | — (kish-local decision) |
| POSIX only in the legacy tier | A POSIX mode on the host | POSIX semantics (implicit splitting and globbing, ambient paths) conflict with the authority model | [ADR-0037](../../handbook/11-decisions/adr-0037-legacy-tier-fhs-views.md) |
| Interactive trust from securebits, not env | `KEYLOS_TRUSTED_TTY` env, tty name checks | Env and names are forgeable; securebits are kernel state set by warden | [ADR-0034](../../handbook/11-decisions/adr-0034-wayland-only-trusted-path.md) |
| `effects` can commit and cancel intents of the shell's own tree | Read-only listing; commit only by the stager | The human who started the command is the natural decider for its staged effects; gate still requires approvals and mandates per kind | [ADR-0027](../../handbook/11-decisions/adr-0027-effect-outbox-and-mandates.md) |
| `debug` builtin over `Right.debug` | `ptrace`/`perf` allowed to shells; debugging only in workbenches | Host apps must be debuggable without weakening the baseline; one presence-gated, time-limited grant per session | [ADR-0049](../../handbook/11-decisions/adr-0049-debug-capability.md) |

### 13.2 Rejected features

- **Implicit `$PATH` fallback for legacy binaries.** Use `run`, `kish --posix` or `work`.
- **`eval` of strings.** Not provided. `kish -c` exists only for trusted callers, and `source` requires sealed files.
- **Here-documents with interpolation.** `<<<` with a string value covers the use case without a second quoting grammar.

### 13.3 Assumptions on other components (stated here so this spec is implementable alone)

All of these are normative in protocols 1.0.0; kish relies on them without fallback:
1. `Process.signal` reaches every process of the stage's cgroup, and `Process.freeze`/`thaw` use the cgroup freezer (protocols §7.3.2).
2. **`KEYLOS_ARGFD_*` and `KEYLOS_PIPE_IN/OUT`** are the `shell` exception of protocols §10.5: warden accepts exactly these `KEYLOS_*` names from `shell` spawners and checks the `KEYLOS_ARGFD_*` fds.
3. **Interactive descendants.** protocols §9.3 defines the trusted-terminal tree as kish plus every job it spawns, decided by warden from the spawning principal and the `SpawnSpec` origin (REQ-KISH-053, REQ-KISH-055).
4. **`Gate.intents` and `Gate.intent`** cover kish's own session tree, recursively (protocols §7.3.7); commit approvals are decided on the trusted path.
5. **`Broker.debug`** materialises `Right.debug` through warden's `DebugAttach` with profile `debug-1`; grants are T3 with presence and expire after at most 3 600 s (process) or 900 s (kernel) (protocols §9.3).
6. **Tier-2 apps.** `warden.spawn` of a generation whose effective tier is t2 fails with `kl:unsupported:t2`, and `bench#user` accepts purpose `app` from `shell` principals with image `io.keylos.app-vm` (protocols §7.3.13, §19.2).

## Appendix A — Embedded contracts (verbatim)

### A.1 protocols §3.4 — Principal identifiers

> Verbatim copy of `protocols/spec.md` lines 152–182 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 3.4 Principal identifiers

A principal is the tuple **(actor, human, session chain)**.

```
principal   = actor "@" human "/" session *( "/" session )
actor       = "app:" ref-gen
            / "service:" service-name ":" ref-gen
            / "agent:" ref-gen
            / "legacy:" ref-gen
            / "bench:" ref-gen
            / "pod:" pod-ns "/" pod-name ":" ref-gen-or-image
            / "shell"
            / "kernel"
human       = username / "_system" / "_cluster"
ref-gen-or-image = ref-gen / "oci:sha256:" 64HEXDIGLC   ; sealed container generation, or OCI image digest (keylos-vm pods)
session     = "s-" ULID          ; Crockford base32, 26 characters
ref-gen     = "gen:fsv256:" 64HEXDIGLC
```

Examples:
- `shell@alice/s-01JB6Q8Z0RXQ4M3W9V2N7T5K1C`
- `agent:gen:fsv256:9e1f…@alice/s-01JB6Q…/s-01JB6R…` (a sub-agent: the last session is the child)
- `service:vault:gen:fsv256:77aa…@_system/s-01JB5…`

Rules:
- The **session chain** records delegation. A child principal's chain is its parent's chain plus one new session. Its authority MUST be a subset of its parent's (§8).
- The **canonical key** for maps and log indexes is the full text form.
- Within a kernel, a running principal instance maps 1:1 to a **(UID, cgroup)** pair allocated by `warden` (§10.3). The mapping is published through `Supervisor.identify` (§7.3.2).
- A VM principal (tier 2 or 3) maps to the cgroup of its VMM process; processes inside the guest are not separate host principals.
- **Pod principals** (§21) always have human `_cluster`. A `keylos-vm` pod is one VM principal per pod sandbox whose actor names the pod's first container image; a `keylos-sealed` pod has one principal per container. The session chain starts at the `cri` service session.


### A.2 protocols §7.1–§7.2 — capwire model, routes and facets

> Verbatim copy of `protocols/spec.md` lines 503–527, 529–541 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 7.1 Model

All keylos IPC between principals on one kernel uses **Cap'n Proto RPC (rpc.capnp, level 1 plus promise pipelining)** over **AF_UNIX `SOCK_SEQPACKET`** sockets.

- **There is no system bus.** A process can reach only the capabilities it was handed:
  - the bootstrap capability of each socket `warden` passed to it at spawn (listed in `KEYLOS_CAPWIRE_FDS`, §10.5),
  - capabilities returned by calls on those.
- **The one exception is the CRI boundary** (§21): the upstream `kubelet` speaks the Kubernetes CRI v1 gRPC API to `cri` over an `AF_UNIX` `SOCK_STREAM` socket that `warden` creates and passes to `kubelet` (route `cri#kubelet`). No other non-capwire IPC between keylos principals is allowed.
- **Holding is authority.** A capability or an fd received through capwire is itself the authority to use it. capwire has **no call-attached tokens**: methods that need token-based authority take an explicit `C.Token` parameter; otherwise the route facet or the held capability is the authority.
- **Framing:** one Cap'n Proto message (standard segment-table framing) per datagram.
  - Maximum datagram size: 4 MiB.
  - Larger data MUST use a `ByteStream`/`ByteSource` capability or a passed fd.
- **File descriptors** travel as `SCM_RIGHTS` ancillary data on the same datagram, at most 64 per datagram. Inside the message, an fd is referenced by an `Fd` struct whose `index` is its position in that datagram's fd array.
  - **No fd** is written as `index = 0xFFFF`, which is the struct default; a null `Fd` pointer also means "no fd". Senders SHOULD write `Fd` structs explicitly. A method that requires an fd fails with `kl:invalid` when it gets none.
  - An `Fd.index` that is out of range, or that a receiver resolves a second time, fails **that call** (or that result's processing) with `kl:invalid`; the connection stays up. The transport is schema-unaware, so an index is checked when the receiver resolves the field.
  - Every received fd that no field took is closed when the receiver releases the message (call parameters released, or the response dropped).
  - Fds can be attached to any parameter or result struct of a message built on a capwire connection, including structs with pointer fields only; a caller does not need to resolve a bootstrap promise before sending fds on it.
  - `ENOBUFS` and `ENOMEM` from `sendmsg` are transient: the sender retries with backoff for up to 1 s before it fails the connection.
- **Datagram rules** (violations are protocol errors that fail the **whole connection**, reported to the local side as `kl:invalid`): exactly one standard-framed message per datagram with no trailing bytes; size ≤ 4 MiB; ≤ 64 fds; ancillary data not truncated (`MSG_TRUNC`/`MSG_CTRUNC`); fds never on capwire-vsock. Senders MUST NOT send zero-length datagrams; a receiver reads a zero-byte datagram as end of connection. A sender whose own outgoing message would exceed 4 MiB fails the connection rather than leave the peer waiting.
- **Socket buffers.** `warden` (and any component that creates capwire sockets for others) sets `SO_SNDBUFFORCE` and `SO_RCVBUFFORCE` to at least 4 MiB + 64 KiB (4 259 840 bytes) on both ends of every capwire socketpair it creates, so 4 MiB datagrams fit; distributions set `net.core.wmem_max` and `net.core.rmem_max` ≥ 4 259 840 (§2). capwire-vsock endpoints set `SO_VM_SOCKETS_BUFFER_SIZE`/`_MAX_SIZE` to the same value.
- **Peer identity:**
  - Every capwire connection between principals is a `socketpair` created by `warden` (§7.2). For such sockets the kernel records the **creating** process (`warden`) as the peer of both ends, so `SO_PEERPIDFD` and `SO_PEERCRED` name `warden`, not the peer. Servers MUST take the peer's principal, tier, generation and facet **only** from `ServiceHost.accept` (§7.5.1), or from `Supervisor.connectionInfo` for a connection ID `warden` delivered.
  - `SO_PEERPIDFD` + `Supervisor.identify` MAY be used only for sockets the peer itself `connect()`ed to a listening socket (not used between keylos principals in 1.0; reserved for diagnostics and future listeners).
  - Servers MUST NOT use PIDs, executable paths, or claims inside messages to decide who the caller is.
- **Bootstrap:** the socket's bootstrap capability implements the service's root interface **and** `common.Extensible` (§7.3.1). It is already narrowed by `warden` to the route's facet (§7.2).

### 7.2 Routes and facets

`warden` wires services according to **routes** declared in service and app manifests plus policy.

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

- A **facet** is a server-defined restriction name. The registry of every facet, its holders and the methods it allows is §19.2. Servers MUST refuse methods their facet doesn't allow with `kl:denied`.
- Route references are written `service#facet` (for example `vault#app`).
- The server learns the facet of each connection from `ServiceHost.accept` (§7.5.1) or `Supervisor.connectionInfo`.
- Service sockets live under `/run/keylos/svc/<service>/` with mode `0700`, owned by `warden`'s UID. No other principal can `connect()` to them. Connections are created by `warden` (`socketpair` + hand-off through `ServiceHost.accept`).
- Dynamic routes (a service capability granted at runtime) are materialised by `broker` through `ServiceConnect.connectService` (§7.5.1).


### A.3 protocols §7.3.1 — common.capnp and error codes

> Verbatim copy of `protocols/spec.md` lines 555–636 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.1 `common.capnp`

```capnp
@0xc7a1e5d3b2f40001;

struct Digest {
  algo  @0 :Algo;
  bytes @1 :Data;            #! sha256/fsv256: 32 bytes; sha512: 64 bytes
  enum Algo { sha256 @0; sha512 @1; fsv256 @2; }
}

struct Ref {                 # typed reference, protocols §3.2
  kind   @0 :Kind;
  digest @1 :Digest;
  enum Kind { obj @0; gen @1; src @2; drv @3; rcpt @4; key @5; }
}

struct Fd { index @0 :UInt16 = 0xFFFF; }   #! index into the SCM_RIGHTS array of the carrying datagram; 0xFFFF (the default) and a null pointer mean "no fd"

struct Timestamp { unixNanos @0 :Int64; }

struct PrincipalId { text @0 :Text; }   #! canonical text form, protocols §3.4
struct SessionId   { text @0 :Text; }

struct Label {
  conf  @0 :Conf;
  integ @1 :Integ;
  enum Conf  { public @0; internal @1; private @2; secret @3; }
  enum Integ { trusted @0; user @1; untrusted @2; }
}

struct Token { biscuit @0 :Data; }      #! Biscuit v3 serialized token, protocols §8

struct KeyValue { key @0 :Text; value @1 :Text; }

struct AttemptBinding {          #! one execution attempt of a durable workflow (§20.25); epoch 0 (the default) = not an attempt
  workflow @0 :Text;             # wf-…
  attempt  @1 :Text;             # wa-…
  epoch    @2 :UInt64;           # ownership epoch of the claim (BrokerWorkflow.claim, §7.5.25)
  step     @3 :Text;             # ws-… the attempt executes
  owner    @4 :Text;             # the workflow's owning human; warden uses it as the attempt principal's human
}

interface ByteStream {
  write @0 (bytes :Data) -> stream;
  done  @1 ();
}

interface ByteSource {
  read @0 (maxBytes :UInt32) -> (bytes :Data, eof :Bool);
}

interface Cancelable { cancel @0 (); }

interface Watcher(T) {          # server-push subscription
  event @0 (event :T) -> stream;
}

interface Extensible {          #! implemented by every bootstrap capability
  ext     @0 (interfaceId :UInt64) -> (cap :Capability);   #! kl:denied if the facet does not allow that interface, or the server does not implement it
  version @1 () -> (protocols :Text, implementation :Text);   #! protocols: SemVer of this document ("1.0.0"); implementation: "<repo>/<SemVer>"
}
```

**Errors.** Methods signal failure with a Cap'n Proto exception of type `failed`. The exception `reason` string MUST start with `kl:<code>`, optionally followed by `:<ref>` (non-empty), then optionally a space and a human-readable message. Codes outside the table are a parse error. Root interfaces are not declared `extends(C.Extensible)`; clients obtain the `Extensible` view of a bootstrap capability by casting the same capability.

| Code | Meaning |
|---|---|
| `denied` | Policy refused. Not retryable without new authority. |
| `needs-approval` | `:<ref>` is an approval ID (`a-…`). Retry after the approval resolves, or use the returned `Approval`. |
| `not-found` | |
| `invalid` | Malformed request |
| `conflict` | State changed concurrently |
| `expired` | |
| `revoked` | |
| `budget` | Budget exhausted |
| `integrity` | Verification failure: signature, digest, fs-verity |
| `unavailable` | Transient; MAY retry with backoff |
| `unsupported` | Feature level or platform lacks support |
| `internal` | |

Example: `kl:needs-approval:a-01JB6R… Sending email requires approval`.


### A.4 protocols §7.3.2 — warden.capnp

> Verbatim copy of `protocols/spec.md` lines 638–722 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.2 `warden.capnp`

```capnp
@0xc7a1e5d3b2f40002;
using C = import "common.capnp";

enum Tier { t0 @0; t1 @1; t2 @2; t3 @3; legacy @4; }

struct FdMapping { target @0 :Int32; fd @1 :C.Fd; }

struct Limits {
  cpuWeight  @0 :UInt16 = 100;    # cgroup cpu.weight
  memoryMax  @1 :UInt64;          # bytes, 0 = inherit
  pidsMax    @2 :UInt32;          # 0 = inherit
  ioWeight   @3 :UInt16 = 100;
  wallSecs   @4 :UInt32;          # 0 = unlimited
}

struct SpawnSpec {
  generation  @0 :C.Ref;          #! kind gen; MUST be launchable (sealed, not revoked)
  entrypoint  @1 :Text;           # manifest entrypoint key, default "main"
  argv        @2 :List(Text);     # appended to entrypoint args
  env         @3 :List(C.KeyValue);  #! secrets MUST NOT be passed via env; warden rejects names matching policy secret patterns and reserved KEYLOS_* names;
                                     #! for actorKind pod the secret-pattern check is skipped (the admitted Kubernetes env may carry secrets, §21)
  fds         @4 :List(FdMapping);   # explicit fds; nothing else is inherited
  grants      @5 :List(C.Token);     # tokens attached to the new principal
  cwd         @6 :C.Fd;              # O_PATH dirfd; optional
  limits      @7 :Limits;
  terminal    @8 :C.Fd;              # pty secondary; optional; warden calls setsid+TIOCSCTTY
  session     @9 :C.SessionId;       # new child session id; warden generates if empty
  actorKind   @10 :ActorKind;
  transaction @11 :Text;             # optional strata transaction id (x-…); warden mounts the transaction views over the granted dirs
  enum ActorKind { app @0; service @1; agent @2; legacy @3; bench @4; shell @5; pod @6; }
  attempt     @12 :C.AttemptBinding; #! workflow attempt (§20.25): honoured only from service loom (facet service); warden forwards it
                                     #! unchanged in SessionReg.attempt and never interprets it; set by any other caller: kl:denied
}

struct ExitStatus {
  union {
    exited   @0 :Int32;
    signaled @1 :Int32;
    failedToStart @2 :Text;   # kl:<code> reason
  }
  cpuNanos @3 :UInt64;
  maxRss   @4 :UInt64;
}

interface Process {
  pidfd     @0 () -> (fd :C.Fd);             # kl:unsupported for VM processes
  principal @1 () -> (id :C.PrincipalId);
  wait      @2 () -> (status :ExitStatus);
  signal    @3 (signo :Int32) -> ();         #! delivered to every process of the principal's cgroup
  kill      @4 () -> ();                     # cgroup.kill
  confinement @5 () -> (report :Text);       # JSON confinement report, protocols §9.4
  freeze    @6 () -> ();                     # cgroup.freeze = 1
  thaw      @7 () -> ();                     # cgroup.freeze = 0
}

struct ConnectionInfo {
  peer   @0 :C.PrincipalId;
  facet  @1 :Text;
  tier   @2 :Tier;
  label  @3 :C.Label;          # current session label (from broker)
  generation @4 :C.Ref;
}

interface Supervisor {
  spawn          @0 (spec :SpawnSpec) -> (process :Process);   #! the child's session chain extends the caller's
  identify       @1 (pidfd :C.Fd) -> (id :C.PrincipalId, tier :Tier, generation :C.Ref);
  connectionInfo @2 (connectionId :UInt64) -> (info :ConnectionInfo);
  services       @3 () -> (list :List(ServiceStatus));
  control        @4 (service :Text, op :ServiceOp) -> (status :ServiceStatus);
      #! service "_system" is the pseudo-target for system power: ops poweroff/reboot (facet admin only)
  enum ServiceOp { start @0; stop @1; restart @2; reload @3; poweroff @4; reboot @5; }
}

struct ServiceStatus {
  name       @0 :Text;
  state      @1 :State;
  generation @2 :C.Ref;
  since      @3 :C.Timestamp;
  restarts   @4 :UInt32;
  enum State { inactive @0; starting @1; running @2; stopping @3; failed @4; }
}
```


### A.5 protocols §7.3.3 — broker.capnp

> Verbatim copy of `protocols/spec.md` lines 724–835 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.3 `broker.capnp`

```capnp
@0xc7a1e5d3b2f40003;
using C = import "common.capnp";

struct NetTarget {
  host    @0 :Text;            # DNS name or IP literal; "listen:<addr>" requests a listening socket (§7.3.7)
  port    @1 :UInt16;
  proto   @2 :Proto;
  methods @3 :List(Text);      # HTTP methods, empty = protocol-level grant only
  enum Proto { tcp @0; udp @1; https @2; }
}

struct Budget { unit @0 :Text; amount @1 :Int64; }   # unit: "usd-micro", "tokens", "calls"

struct ResourceRef {
  union {
    path      @0 :Text;          # resolved by broker with openat2(RESOLVE_BENEATH) from a held root
    dirFd     @1 :C.Fd;          # caller already holds it; request attenuation/annotation
    net       @2 :NetTarget;
    device    @3 :Text;          # device id, protocols §3.5
    secret    @4 :Text;          # vault item name (caller-scoped)
    budget    @5 :Budget;
    spawn     @6 :C.Ref;         # right to spawn a generation
    service   @7 :Text;          # "name#facet"
    effect    @8 :Text;          # effect kind, e.g. "email.send"
    delegate  @9 :Void;          # right to create sub-principals
    principal @10 :DebugTarget;  # debug target (Right.debug), §9.3
    screen    @11 :Text;         # "window:<atrium window id>": one still snapshot of a real-session window (Right.read), §14.5
    model     @12 :Text;         # "<provider>/<model>@<version>": re-approval of an agent session's model after drift (Right.use), §14.5
  }
}

struct DebugTarget {
  target  @0 :Text;              # "session:s-…" (a running session and its descendants) or "gen:fsv256:…" (any instance of a generation of the requesting human)
  scope   @1 :Scope;
  enum Scope { process @0; kernel @1; }   #! kernel: bpftrace-class tracing, presence-only, ≤ 900 s
}

enum Right { read @0; write @1; create @2; delete @3; exec @4; connect @5; bind @6; use @7; spend @8; spawn @9; stage @10; commit @11; delegate @12; debug @13; }

struct GrantRequest {
  resource     @0 :ResourceRef;
  rights       @1 :List(Right);
  reason       @2 :Text;         # shown to the human
  durationSecs @3 :UInt32;       # 0 = policy default
  persist      @4 :Bool;         # request a persistent grant (survives session and reboot; needs presence)
  onBehalfOf   @5 :C.PrincipalId; # informational only (vault, depot, strata, atrium via requestFor): the principal the service acts for;
                                  #! shown on the prompt and recorded in receipts; never used for authorization
}

struct GrantOutcome {
  union {
    granted @0 :C.Token;
    pending @1 :Approval;
    denied  @2 :Text;
  }
}

interface Approval {
  id      @0 () -> (id :Text);
  wait    @1 () -> (outcome :GrantOutcome);
  cancel  @2 () -> ();
  mandate @3 () -> (mandate :Data);   #! DSSE keylos.mandate/1 after approval; kl:not-found before or if denied
}

struct Handle {
  union {
    fd      @0 :C.Fd;            # file, dirfd (O_PATH), device, memfd
    socket  @1 :C.Fd;            # connected socket (usually to gate) or capwire socket to a service
    cap     @2 :Capability;      # service capability
  }
}

interface Broker {
  request     @0 (req :GrantRequest) -> (outcome :GrantOutcome);
  materialize @1 (token :C.Token, resource :ResourceRef, rights :List(Right)) -> (handle :Handle);
  attenuate   @2 (token :C.Token, checks :List(Text)) -> (token :C.Token);  #! Datalog checks, protocols §8.3
  delegate    @3 (tokens :List(C.Token), child :C.SessionId, checks :List(Text)) -> (tokens :List(C.Token));
  revoke      @4 (rootId :Data) -> ();
  inspect     @5 (token :C.Token) -> (facts :List(Text), expires :C.Timestamp, rootId :Data);
  label       @6 () -> (label :C.Label);
  raiseLabel  @7 (label :C.Label, reason :Text) -> (label :C.Label);  #! raises the CALLER's session label only; labels only go up
  powerbox    @8 (req :PowerboxRequest) -> (grants :List(PowerboxGrant));
  myGrants    @9 () -> (tokens :List(C.Token));
  debug       @10 (token :C.Token, debugger :C.Ref, entrypoint :Text, argv :List(Text), pty :C.Fd) -> (process :Capability);
      #! materialises a Right.debug grant through warden DebugAttach (§7.5.1); returns a warden.Process
}

struct PowerboxRequest {
  kind     @0 :Kind;
  title    @1 :Text;
  mimeTypes @2 :List(Text);
  multiple @3 :Bool;
  suggestedName @4 :Text;
  enum Kind { openFile @0; openDirectory @1; saveFile @2; }
}

struct PowerboxGrant {
  fd    @0 :C.Fd;        # opened file, or O_PATH dirfd usable in the holder's view (attached via GrantMounts, §7.5.1)
  token @1 :C.Token;     # token describing the grant (for persistence / delegation)
  displayName @2 :Text;
  viewPath @3 :Text;     # path of the grant inside the holder's view (/grants/<name>), for path-expecting code
}
```

**Directory grants and Landlock.** A Landlock domain cannot be widened after `restrict_self`. A directory granted at runtime is therefore made reachable by `warden` attaching a bind mount at `/grants/<name>` inside the holder's mount namespace (`GrantMounts.attachGrant`, §7.5.1), whose subtree is covered by the Landlock rule the view was built with (`/grants` is allowed at spawn with the access rights of the highest possible grant; actual access is bounded by mount flags and the attached tree). `materialize` of a path or dirFd grant returns an fd opened **through that mount**.

**Directory grant ceilings.** Every directory grant has an **exposure label** (its ceiling, §14.1). The broker raises the holder's session label to the ceiling **before** the mount is attached, and passes the ceiling to `attachGrant`; `warden` then refuses, for the grant's lifetime, every open of an object through that mount (and every read through an fd opened through it) whose label exceeds the ceiling or is malformed (§9.3). Grant trees are non-recursive bind mounts: mounts nested below the granted directory are not reachable through the grant.

**Single-file grants.** A file picked for a path-expecting client is never exposed by attaching its parent directory. It is exposed as a **single-file view** `/grants/<name>/<basename>`: a directory served by `portal-files` that contains only the selected file and the holder's own temporary files. Writes follow the granted rights (a read-only grant refuses every write); a safe-save `rename(<temporary> → <basename>)` is carried out by `portal-files` as an atomic replace of the selected file in its real parent, whose dirfd `portal-files` holds and never exposes; every other name is refused. Access to the parent or any sibling needs an explicit `openDirectory` consent. Remembered grants, re-materialization, revocation and drag-and-drop keep the same single-file scope.


### A.6 protocols §7.3.10 — strata.capnp

> Verbatim copy of `protocols/spec.md` lines 1099–1144 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.10 `strata.capnp`

```capnp
@0xc7a1e5d3b2f40010;
using C = import "common.capnp";

enum NetworkPolicy { deny @0; gate @1; inherit @2; }
  #! deny: processes in the transaction get no network; gate: egress only via gate with the caller's tokens; inherit: the spawner's own policy

struct Change { path @0 :Text; kind @1 :Kind; enum Kind { added @0; modified @1; deleted @2; renamed @3; meta @4; } from @2 :Text; }

struct Conflict { path @0 :Text; reason @1 :Text; }

interface Transaction {
  id      @0 () -> (id :Text);
  view    @1 () -> (dirs :List(C.Fd));         # O_PATH dirfds of the overlay views (same order as begin)
  changes @2 () -> (changes :List(Change));
  diff    @3 (path :Text) -> (diff :C.Fd);
  conflicts @4 () -> (conflicts :List(Conflict));
  commit  @5 () -> (snapshot :Text);           # returns pre-commit snapshot id (undo point)
  abort   @6 () -> ();
}

struct Provenance {
  principal   @0 :C.PrincipalId;
  generation  @1 :C.Ref;
  transaction @2 :Text;
  created     @3 :C.Timestamp;
  label       @4 :C.Label;
}

struct SnapshotInfo { id @0 :Text; subvolume @1 :Text; created @2 :C.Timestamp; reason @3 :Text; pinned @4 :Bool; }

interface Strata {
  begin     @0 (dirs :List(C.Fd), networkPolicy :NetworkPolicy) -> (txn :Transaction);   #! holding the dirfds is the authority
  snapshot  @1 (subvolume :Text, reason :Text) -> (info :SnapshotInfo);
  snapshots @2 (subvolume :Text) -> (list :List(SnapshotInfo));
  restore   @3 (snapshot :Text, path :Text, target :C.Fd) -> ();
  undo      @4 (transaction :Text) -> ();
  why       @5 (file :C.Fd) -> (provenance :Provenance);
  forget    @6 (unit :Text) -> ();             # crypto-shred a data unit
  createUnit @7 (path :C.Fd, unit :Text, policy :Text) -> ();
}
```

**Transaction storage backends.** `begin` dispatches each target dirfd to a registered backend. A plain btrfs directory uses the snapshot and overlay path. A plaintext view of a sealed unit served over FUSE (`keylos.unitfs/1`) is resolved through `strata`'s own mount records to (unit, relative subtree); `strata` clones the unit's ciphertext backing subvolume (a read-only base and a writable working clone) and serves a transaction-specific plaintext view of that subtree only. Changes and prepared merges are computed on the logical plaintext views; commit applies the logical operations to the live backing through the unit format, after quiescing the unit and fencing its writers. No plaintext upper layer, undo copy or journal content of a sealed unit is ever stored outside its encrypted backing; undo uses a ciphertext pre-commit snapshot, and `forget` of the unit aborts its transactions and leaves every transaction artifact undecryptable. While the unit is locked its transaction views are unavailable and commits fail `kl:unavailable`. Mixed backends in one transaction, nested units and cross-unit transactions fail `kl:unsupported`.


### A.7 protocols §7.3.7 — gate.capnp

> Verbatim copy of `protocols/spec.md` lines 969–1021 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.7 `gate.capnp`

```capnp
@0xc7a1e5d3b2f40007;
using C = import "common.capnp";
using B = import "broker.capnp";

enum EffectClass { reversible @0; compensable @1; irreversible @2; }

struct EffectArg { name @0 :Text; value @1 :Text; source @2 :Text; label @3 :C.Label; }

struct EffectIntent {
  kind        @0 :Text;            # registered effect kind, protocols §14.2
  class       @1 :EffectClass;
  target      @2 :Text;            # e.g. "smtp:mail.example.com", "https://api.github.com/repos/o/r/pulls"
  args        @3 :List(EffectArg);
  idempotencyKey @4 :Text;
  compensator @5 :Text;            # registered compensator kind, empty if none
  payload     @6 :C.Fd;            # full request body / message
}

struct IntentStatus {
  id     @0 :Text;
  state  @1 :State;
  result @2 :Text;
  receipt @3 :Text;                # rcpt ref
  enum State { staged @0; approved @1; committed @2; failed @3; canceled @4; compensated @5; }
}

interface Intent {
  status   @0 () -> (status :IntentStatus);
  dryRun   @1 () -> (rendered :List(Text));
  commit   @2 () -> (status :IntentStatus);          # may throw kl:needs-approval
  cancel   @3 () -> ();
  compensate @4 () -> (status :IntentStatus);
}

interface Gate {
  connect   @0 (target :B.NetTarget, token :C.Token) -> (socket :C.Fd);   # proxied, policy-checked stream; target.host "listen:<addr>" returns a listening socket
  stage     @1 (intent :EffectIntent) -> (intent :Intent);
  intents   @2 (session :C.SessionId) -> (list :List(IntentStatus));
      #! facet client: the named session MUST be the caller's own session or a descendant; returns intents of that session
      #! and all its descendant sessions, recursively
  meter     @3 (rootId :Data) -> (spent :List(B.Budget), remaining :List(B.Budget));
  charge    @4 (rootId :Data, amount :B.Budget, reason :Text) -> ();      # facet meter only
  intent    @5 (id :Text) -> (intent :Intent);
      #! facet client: only intents staged by the caller's session or its descendants (kish `effects` commit/cancel)
}
```

**Terminated HTTP mode.** For `https` grants that need method filtering or credential injection, a native client does not get an end-to-end TLS stream: `connect` returns a socket on which the client speaks **plain HTTP/1.1** to `gate`, which terminates the request, applies method checks and credential injection, and performs TLS to the real host itself. Clients detect this from the token's `net` fact (`$method` ≠ `"*"`). Legacy and VM clients use the TLS-interception path instead (§9.4). SDKs MUST support the terminated mode.

**Acting for a subject.** On facet `aide`, `stage` acts for the agent session whose token is carried in the intent arg `x-subject-token` (base64 Biscuit); `gate` stages for that token's `principal` after verifying `right("effect", kind, "stage")`. On facet `broker`, `connect` acts for the token's `principal`. On every other facet the subject is the caller.


### A.8 protocols §7.3.13 — bench.capnp

> Verbatim copy of `protocols/spec.md` lines 1196–1274 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.13 `bench.capnp`

```capnp
@0xc7a1e5d3b2f40013;
using C = import "common.capnp";
using W = import "warden.capnp";
using B = import "broker.capnp";

struct Share { name @0 :Text; dir @1 :C.Fd; writable @2 :Bool; overlay @3 :Bool; }

struct VmSpec {
  image     @0 :C.Ref;              # bench-image generation
  shares    @1 :List(Share);
  vcpus     @2 :UInt16;
  memoryMiB @3 :UInt32;
  gpu       @4 :Bool;               # virtio-gpu native context
  network   @5 :List(C.Token);      # net grants; all egress via bench-net → gate
  display   @6 :Bool;               # Wayland proxy to atrium (tier-2 apps, workbench apps such as IDEs, agent-desktop mirrors)
  fromSnapshot @7 :Text;
  session       @8 :C.SessionId;    # the VM principal's session; bench generates it if empty
  parentSession @9 :C.SessionId;    # session the VM principal descends from (agent: the aide-created session chain parent)
  principalKind @10 :W.SpawnSpec.ActorKind;   # bench (default), agent, legacy, pod
  storeSet      @11 :List(C.Ref);   # generations exposed read-only in the guest store (/store) in addition to the image closure
  unsignedImageOk @12 :Bool;        #! honoured only for facet user calls by service:forge with purpose build, tier 3
  purpose       @13 :Purpose;
  displayMode   @14 :DisplayMode;   # meaningful when display = true
  gpuPassthrough @15 :Text;         # PCI address of a VFIO-claimed GPU (needs.gpu "passthrough"); empty = none
  blockDevices  @16 :List(BlockDev);   # media VMs and pod VMs: block devices claimed through devd MediaAttach
  enum Purpose { workbench @0; agent @1; app @2; media @3; build @4; captive @5; pod @6; agentDesktop @7; }
  enum DisplayMode { interactive @0; readOnly @1; }   # readOnly: human watches an agent desktop; takeOver switches to interactive
  struct BlockDev { device @0 :Text; fd @1 :C.Fd; readOnly @2 :Bool; }
  bootArgs      @17 :List(C.KeyValue);  # delivered to the guest over benchd control at boot (e.g. "captive.url" for purpose captive)
  tap           @18 :C.Fd;              #! purpose pod only (facet cri): tap device created in the cri network namespace; index 0xFFFF = none
  tapConfig     @19 :TapConfig;
  podId         @20 :Text;              # purpose pod: pod-… (§3.5); bench places the VMM processes under the pod's cgroup
  struct TapConfig { ifname @0 :Text; mac @1 :Text; mtu @2 :UInt16; }
  attempt       @21 :C.AttemptBinding;  #! facet aide only (agent attempts of a workflow, §20.25); copied to VmPrincipal.attempt
}

struct ForkSpec {
  session       @0 :C.SessionId;    # session of the forked VM principal; bench generates it if empty
  parentSession @1 :C.SessionId;    # defaults to the source VM's parentSession
  principalKind @2 :W.SpawnSpec.ActorKind;   # aide forks: agent; default: the source VM's kind
  offered       @3 :List(C.Token);    #! tokens for the fork; default: the source VM principal's tokens (sub-agents: the parent agent's)
  checks        @4 :List(Text);       #! attenuation checks for the fork (copied to VmPrincipal.checks)
  budgets       @5 :List(B.Budget);   #! sub-budgets for the fork (copied to VmPrincipal.budgets)
  attempt       @6 :C.AttemptBinding; #! facet aide only: the fork is an attempt of a workflow (§20.25); copied to VmPrincipal.attempt
}

interface Vm {
  exec     @0 (argv :List(Text), env :List(C.KeyValue), fds :List(W.FdMapping), tty :Bool) -> (process :W.Process);
  snapshot @1 (name :Text) -> (id :Text);
  fork     @2 (spec :ForkSpec) -> (vm :Vm);         #! spec null = defaults; the fork is a new VM principal registered through VmSpawn
  changes  @3 () -> (shares :List(Text));          # per-share change summaries
  commit   @4 (share :Text) -> (transaction :Text); # human workbenches only; agent overlays merge via BenchMerge (§7.5.10)
  discard  @5 () -> ();
  stop     @6 () -> ();
  console  @7 () -> (pty :C.Fd);
  attachShare @8 (share :Share) -> ();             #! hot-plug: new virtio-fs export in the running VM; the guest sees /shares/<name>
  detachShare @9 (name :Text) -> ();               #! open guest files on the share get EIO afterwards
  desktop  @10 () -> (desktop :Capability);        #! purpose agentDesktop only: returns an aide-sys AgentDesktop (§7.5.13)
  takeOver @11 (interactive :Bool) -> ();          # agentDesktop: switch the human's mirror between readOnly and interactive
  info        @12 () -> (session :C.SessionId, cgroupId :UInt64, cid :UInt32, purpose :VmSpec.Purpose);
  attachBlock @13 (dev :VmSpec.BlockDev) -> ();    #! hot-plug a virtio-blk device (pod VMs: CSI volumes published after start)
  detachBlock @14 (device :Text) -> ();
}

interface Bench {
  start     @0 (spec :VmSpec) -> (vm :Vm);
  project   @1 (projectDir :C.Fd) -> (vm :Vm);     # start/attach project workbench per project.ncl
  snapshots @2 () -> (list :List(Text));
  media     @3 (device :Text) -> (vm :Vm, browser :Capability);
      #! starts (or attaches to) the media VM for an authorized removable block device; browser is a bench-sys MediaBrowser (§7.5.10)
  reattach  @4 (session :C.SessionId) -> (vm :Vm);
      #! a new Vm capability for a running VM started by the same caller principal (cri after a crid restart, aide).
      #! VMs of purposes pod, agent and agentDesktop outlive their Vm capability until Vm.stop, the end of their parent
      #! session, or a bench restart (which stops every VM)
}
```


### A.9 protocols §7.3.14 — aide.capnp

> Verbatim copy of `protocols/spec.md` lines 1276–1332 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.14 `aide.capnp`

```capnp
@0xc7a1e5d3b2f40014;
using C = import "common.capnp";

struct AgentEvent {
  time    @0 :C.Timestamp;
  session @1 :C.SessionId;
  union {
    message   @2 :Text;            # agent → human text
    toolCall  @3 :Text;            # JSON {tool, args}
    toolResult @4 :Text;
    approval  @5 :Text;            # approval id pending
    effect    @6 :Text;            # intent id
    label     @7 :C.Label;
    budget    @8 :Text;
    finished  @9 :Text;
    rich      @10 :Text;           # JCS JSON {"type": "state"|"question"|"breaker"|"mcpPinMismatch"|"discrepancy"|"grant"|"modelChange"|"desktop", …}
  }
}

interface AgentSession {
  id       @0 () -> (id :C.SessionId);
  send     @1 (text :Text) -> ();                      # human → agent
  events   @2 (watcher :C.Watcher(AgentEvent)) -> (cancel :C.Cancelable);
  changes  @3 () -> (summary :Text);
  review   @4 () -> (prompt :Text);                    # stages fs.merge intents; opens T3 review on trusted path
  stop     @5 () -> ();
  fork     @6 () -> (session :AgentSession);
  takeOver @7 (interactive :Bool) -> ();             # human: switch the agent-desktop mirror (relayed to Vm.takeOver)
  attempt  @8 () -> (binding :C.AttemptBinding);     # the workflow attempt this session executes (§20.25); epoch 0 if none
}

struct SessionSpec {
  template  @0 :C.Ref;               # agent-template generation
  task      @1 :Text;
  grants    @2 :List(C.Token);       # attenuated from the human's authority
  project   @3 :C.Fd;                # optional project dirfd
  budget    @4 :List(Text);          # e.g. "usd-micro:5000000"
  deadlineSecs @5 :UInt32;
}

interface Aide {
  start    @0 (spec :SessionSpec) -> (session :AgentSession);
  sessions @1 () -> (list :List(C.SessionId));
  attach   @2 (id :C.SessionId) -> (session :AgentSession);
}

interface AgentHost {                 # served by aide to the harness inside the workbench (vsock port 7002)
  tools     @0 () -> (json :Text);     # pinned tool definitions
  callTool  @1 (name :Text, argsJson :Text, provenanceJson :Text) -> (resultJson :Text, label :C.Label);
  model     @2 (requestJson :Text) -> (responseJson :Text);   # model API via gate (metered)
  emit      @3 (event :AgentEvent) -> ();
  requestGrant @4 (reasonJson :Text) -> (outcomeJson :Text);
}
```


### A.10 protocols §7.3.8 — depot.capnp

> Verbatim copy of `protocols/spec.md` lines 1023–1071 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.8 `depot.capnp`

```capnp
@0xc7a1e5d3b2f40008;
using C = import "common.capnp";

struct GenerationInfo {
  ref       @0 :C.Ref;
  kind      @1 :Text;
  name      @2 :Text;
  version   @3 :Text;
  manifest  @4 :Data;         # manifest JSON bytes
  launchable @5 :Bool;
  sealedBy  @6 :List(Text);   # key refs whose signatures over the generation statement verified
  grafted   @7 :Bool;
  revoked   @8 :Bool;
  installed @9 :C.Timestamp;
  launchReasons @10 :List(Text);   # why launchable is false: "no-authorising-signature", "revoked:<reason>", "needs-consent",
                                   # "quorum-deferred", "unreviewed-tier2", "offline-install-needs-t3", "kernel-mismatch" (kmod)
}

interface Depot {
  get        @0 (ref :C.Ref) -> (info :GenerationInfo);
  list       @1 (kind :Text, name :Text) -> (list :List(GenerationInfo));
  install    @2 (source :Text) -> (info :GenerationInfo, capabilityDiff :Text);  # "oci://…[#gen=fsv256:…]", "tuf:<stream>/<name>", ".klb" bundle fd path via powerbox
  mount      @3 (ref :C.Ref) -> (tree :C.Fd);          #! facet mounter (warden, bench, compat) and config (kind config only); fsmount fd (composefs, verity=require)
  openObject @4 (ref :C.Ref) -> (fd :C.Fd);            # read-only fd of store object
  importTree @5 (tree :C.Fd, manifest :Data) -> (info :GenerationInfo);   # facets forge (all kinds), config (config, policy), compat (legacy-image)
  seal       @6 (ref :C.Ref, statement :Data) -> (info :GenerationInfo);  # attach owner seal (DSSE seal statement signed via HearthSeal)
  root       @7 (ref :C.Ref, holder :Text) -> ();      # GC root
  unroot     @8 (ref :C.Ref, holder :Text) -> ();
  gc         @9 (dryRun :Bool) -> (freedBytes :UInt64, removed :List(C.Ref));
  verify     @10 (ref :C.Ref) -> (ok :Bool, problems :List(Text));
  revocations @11 () -> (listEnvelope :Data);
  openPath   @12 (ref :C.Ref, path :Text) -> (fd :C.Fd);
      #! read-only fd of a regular file inside a generation, resolved in the generation's own tree (no symlink escape).
      #! facet user: only paths under /.keylos/ (manifest.json, cmdsig/*, l10n/*, agent/*, icons/*, sbom.spdx.json,
      #! provenance.json, workflows/*) of generations the caller may spawn, agent templates, or catalog entries; facet mounter: any path;
      #! facet loom: /.keylos/manifest.json and /.keylos/workflows/* of any installed generation
  revocationStatus @13 () -> (serial :UInt64, issued :C.Timestamp, ageSecs :UInt64);
      #! facets user, mounter, compat: the newest verified revocation list; ageSecs measured against trusted time (§3.6, §14.5)
}
```

**GC roots** are named `<holder>:<purpose>:<id>`. Registered holder prefixes: `loom:workflow:<wf-id>` (the pinned definition generation of every workflow that is not yet terminal, and of a terminal one until it is forgotten; §20.25), `warden:running:<session>` (every generation `warden` mounted; `warden` calls `unroot` when the last principal using that mount exits, so `depot` needs no unmount notification), `cri:pod:<pod-id>` (container generations and images of a pod), `courier:os:<seq>` (bootable OS generations), `courier:kmod:<kernel-release>` (kmod generations for an installed kernel). Other prefixes are repo-local.

**Container mounts.** `mount` of a `container` generation succeeds only while it is rooted by a `cri:pod:<pod-id>` holder; `cri` roots it before calling `PodSpawn` (§21.4).

`install("tuf:<stream>/<name>")` and `install("tuf:org:<org>/<name>")` are resolved through `CourierResolver.resolve` (§7.5.6), which also returns the catalog review status; `depot` is never a TUF client. Revocation lists reach `depot` the same way: `courier` resolves `tuf:<stream>/revocations` and `depot` takes the DSSE list from `Resolution.revocations` (§7.5.6). Source form `oci+container://<registry>/<repo>@sha256:<manifest>` (facet `cri` only) converts an OCI image into a `container` generation (§21.4). `courier` installs OS generations with the source form `oci://<registry>/<repo>@sha256:<manifest>#gen=fsv256:<hex>`, which `depot` MUST accept (the fragment pins the expected generation digest).


### A.11 protocols §9.1–§9.3 — Baseline confinement, tiers and code integrity

> Verbatim copy of `protocols/spec.md` lines 2912–2937, 2939–2951, 2953–3021 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 9.1 Baseline for every non-kernel process except `warden` itself

1. `PR_SET_NO_NEW_PRIVS`.
2. Own cgroup, own dynamic UID (§10.3), no supplementary groups. Human-owned data and directory grants reach dynamic UIDs through **idmapped mounts** (§7.5.1); mapping-only user namespaces used for idmapping are held by `warden`, and no process ever runs inside them.
3. Landlock ruleset at the highest available ABI:
   - starts from deny-all for all handled access rights;
   - allows only the mount view (§10.1), `/grants` (runtime grant mounts) and explicitly granted fds/paths;
   - scopes `ABSTRACT_UNIX_SOCKET` and `SIGNAL`;
   - uses `RESTRICT_SELF_TSYNC` when available.
4. seccomp-bpf allowlist profile `baseline-1`, default action `ENOSYS`. Always denied:
   - `unshare`, `setns`, and namespace flags on `clone`/`clone3` (clone3 → `ENOSYS`, forcing the libc `clone` fallback, which is then flag-checked);
   - `io_uring_*`, `bpf`, `perf_event_open`, `userfaultfd`;
   - `keyctl`, `add_key`, `request_key`;
   - `kexec_*`, `init_module`, `finit_module`, `delete_module`;
   - `mount`, `umount2`, `pivot_root`, `chroot`, `fsopen`, `fsmount`, `fsconfig`, `move_mount`, `open_tree`, `mount_setattr`;
   - `ptrace`, `process_vm_readv`, `process_vm_writev`;
   - `personality` (except the default);
   - `acct`, `swapon`, `swapoff`, `reboot`, `settimeofday`, `clock_settime`, `clock_adjtime`, `adjtimex` (read-only calls included: seccomp cannot inspect `struct timex`, so both are denied with `EPERM`);
   - `ioctl` `TIOCSTI` and `TIOCLINUX`.
5. Namespaces created by `warden` without a user namespace: mount, pid, ipc, uts, cgroup; net unless the principal is a tier-0 service with `network: "host"` (or `"cluster"`, which joins the cri network namespace, §20.16). **Single exception to "only `warden` creates namespaces":** on `server-k8s`, `net` creates the cri network namespace and the per-pod network namespaces inside the cri network (network namespaces only, never user or mount namespaces; §21.5).
6. A fresh `/proc` (`hidepid=invisible,subset=pid`).
7. No controlling terminal unless one is given; `TIOCSTI` disabled system-wide (`dev.tty.legacy_tiocsti=0`).
8. `mseal` of the stack and libc read-only segments (done by the keylos libc startup shim where available); `PR_SET_MDWE` (W^X) unless the generation has `needs.jit`.
9. `RLIMIT_RTPRIO = 0` unless the generation has `needs.realtime` (then 20, with `RLIMIT_RTTIME = 200 000 µs`).

The only other seccomp profiles are `baseline-1+<digest>` (baseline-1 plus the tier-0 extras a service's `privileges.syscalls` and `privileges.socketFamilies` list in `services.json`, §20.16; `<digest>` is the lowercase hex SHA-256 of the extras' names, syscalls and socket families together, sorted by bytes, each followed by `\n`), used only for tier-0 services; `debug-1` (baseline-1 plus `ptrace`, `process_vm_readv`, `perf_event_open`) and `debug-1k` (`debug-1` plus `bpf`, for scope `kernel`), used exclusively for `DebugAttach` debuggers (§9.3); `openbroker-1` (baseline-1 plus `process_vm_readv`; `ptrace`, `process_vm_writev` and `pidfd_getfd` stay denied), used exclusively for `compat`'s per-app open-broker processes (§9.3); and `runtime-default` (baseline-1 ∩ the Kubernetes RuntimeDefault profile) for `keylos-sealed` pods.

### 9.2 Tiers

| Tier | Isolation | Code allowed |
|---|---|---|
| t0 | Baseline + service-specific allowances (system services) | Sealed only |
| t1 | Baseline (apps) | Sealed only |
| t2 | microVM (crosvm) managed by `bench`, display via Wayland proxy | Any (inside guest) |
| t3 | microVM workbench (dev environments, agent sessions) | Any (inside guest) |
| legacy | Baseline + a user namespace built by `warden` (child `user.max_user_namespaces=0`) + FHS view + seccomp user-notification open broker (`compat`). Only forge-built, reproducible legacy images signed by a trusted key run as tier L on the host; every imported image runs in t2 | Sealed legacy image |
| pod (`keylos-sealed`) | t1 baseline with `runtime-default` seccomp, in the pod network namespace inside the `cri` network (§21) | Sealed `container` generations signed by an org publisher |
| pod (`keylos-vm`) | t2-class microVM per pod sandbox managed by `bench` for `cri` | Any OCI image (inside guest) |

Media VMs (removable storage, §9.5), captive-portal browser VMs and agent desktops are tier-3 VMs with their own `VmSpec.purpose`.

### 9.3 Code integrity (host)

**Primary enforcement: the `kl-exec` BPF LSM.** `boot` loads `kl-exec` in the initrd before executing any file other than itself, and hands its maps and links to `warden` across `switch_root`. The program reads kernel structures at offsets the loader computes from the running kernel's BTF (`/sys/kernel/btf/vmlinux`) before load; a missing member fails the load.

| Hook | Decision |
|---|---|
| `bprm_check_security` | Allow if the file's superblock `s_dev` ∈ `kl_exec_allowed_sb`, or (phase INITRD and the file is on the initramfs). Else `-EACCES` |
| `bprm_creds_for_exec` with `bprm->is_check` set (`execveat(…, AT_EXECVE_CHECK)`) | Same rule as `bprm_check_security`. A check-only exec returns after this hook and never reaches `bprm_check_security`, so this row is what refuses an interpreter's check of an unregistered script. Regular execs are decided only by `bprm_check_security` (one event per denial) |
| `mmap_file` with `PROT_EXEC` | File-backed: same rule as exec. Anonymous: allow only if the task's cgroup ID ∈ `kl_exec_jit_cgroups`. Else `-EACCES` |
| `file_mprotect` adding `PROT_EXEC` | File-backed: same as exec. Anonymous or private-writable: allow only for JIT cgroups |
| `kernel_read_file` (firmware, modules, policy, X.509) | Allow if the file's sb ∈ allowed set or (phase INITRD and initramfs). kexec reads are always denied |
| `kernel_load_data` (`init_module`, firmware blobs) | Deny (modules load only via `finit_module` from verified files) |
| `bpf` (`BPF_PROG_LOAD`, `BPF_LINK_DETACH`, `BPF_PROG_DETACH`) | Allow for the `warden` core (thread-group ID recorded in `kl_exec_policy.warden_tgid` at hand-over) and for `boot` in phase INITRD. Allow for a debugger task whose cgroup has a `kl_debug_pairs` entry with scope `kernel`, for tracing program types only (kprobe, tracepoint, raw_tracepoint, perf_event), never LSM, cgroup or XDP types. Deny for every other task |
| `ptrace_access_check` | Allow only if the tracer's cgroup has an unexpired `kl_debug_pairs` entry whose target cgroup contains the tracee (or is an ancestor of it). Yama and the seccomp profile apply in addition. The hook also guards every other `ptrace_may_access` path (`/proc/<pid>/{mem,maps,environ,fd,ns/*,root,…}`, `kcmp`, `pidfd_getfd`, `setns` and `PIDFD_GET_*_NAMESPACE` on a pidfd, `process_vm_*`); no task is exempt, including the `warden` core. Checks with `PTRACE_MODE_NOAUDIT` are refused without an event |
| `perf_event_open` | Allow only for a task whose cgroup has an unexpired `kl_debug_pairs` entry (the hook sees only the `PERF_SECURITY_*` type, not the target) |
| `perf_event_alloc` (events created by a `perf_event_open(2)` call admitted above) | Scope `process`: allow only task events whose target task is in the target cgroup (or a descendant) and cgroup events on the target cgroup; CPU-wide events are refused. Scope `kernel`: allow system-wide events. Kernel-internal counters (watchdog, ptrace hardware breakpoints) are not `perf_event_open(2)` requests and are not checked |

**Map contract.** `boot` passes the map fds to `warden` as fds 3–7 in the order given by the kernel command line `keylos.execmapfds=3,4,5,6,7`:

| Map | Type | Key → value | Writer |
|---|---|---|---|
| `kl_exec_allowed_sb` | `BPF_MAP_TYPE_HASH`, 65 536 entries | `u32 s_dev` (kernel `dev_t`, below) → `u32 gen_index` | warden core only |
| `kl_exec_jit_cgroups` | `BPF_MAP_TYPE_HASH`, 4 096 entries | `u64 cgroup_id` → `u8 1` | warden core only |
| `kl_exec_policy` | `BPF_MAP_TYPE_ARRAY`, 1 entry | `u32 0` → `struct {u8 enforce; u8 audit_allow; u8 phase; u8 pad; u32 warden_tgid;}` | boot only, then frozen (`bpf_map_freeze`) after `warden_tgid` is written at hand-over |
| `kl_exec_events` | `BPF_MAP_TYPE_RINGBUF`, 1 MiB | denial events `{u64 cgroup_id; u32 pid; u32 hook; u32 s_dev; u64 ino;}` | warden core (reader) |
| `kl_debug_pairs` | `BPF_MAP_TYPE_HASH`, 256 entries | `u64 tracer_cgroup_id` → `struct {u64 target_cgroup_id; u64 expires_boottime_ns; u8 scope;}` (scope 0 = process, 1 = kernel) | warden core only (`DebugAttach`) |

Internal maps of the program (for example the LRU map that limits the `perf_event_alloc` check to `perf_event_open(2)` requests) are not handed over and are not part of this contract.

**Numeric values.** Decoders (`warden`, `journal`, tools) rely on these:
- `kl_exec_policy.phase`: INITRD = 0, SYSTEM = 1. `enforce` = 1 refuses denials; `enforce` = 0 is permissive (denials are logged and allowed; development only). `audit_allow` = 1 also logs allowed decisions.
- `kl_exec_events.hook` IDs: 1 `bprm_check_security`, 2 `mmap_file`, 3 `file_mprotect`, 4 `kernel_read_file`, 5 `kernel_load_data`, 6 `bpf`, 7 `ptrace_access_check`, 8 `perf_event_open`, 9 `bprm_creds_for_exec`, 10 `perf_event_alloc`; bit 31 set marks an audit-allow record. The C layout has 4 bytes of padding before `ino` (record size 32 bytes).
- File hooks carry the file's superblock `s_dev` and inode number (anonymous mappings: 0, 0). Other hooks reuse the two fields: `kernel_load_data` `s_dev` = the `kernel_load_data_id`; `bpf` `s_dev` = the command, `ino` = the program type for `BPF_PROG_LOAD`; `ptrace_access_check` `s_dev` = the mode, `ino` = the tracee's thread-group ID; `perf_event_open` `s_dev` = the `PERF_SECURITY_*` type; `perf_event_alloc` `s_dev` = 1 task event, 2 cgroup event, 3 CPU-wide event, `ino` = the target cgroup ID when known.
- `s_dev` everywhere is the **kernel** encoding of `super_block.s_dev` (`MKDEV`: `major << 20 | minor`), not the userspace `st_dev`/`makedev()` encoding. Registrants convert `statx`'s `stx_dev_major`/`stx_dev_minor`.

**Links.** The program's hooks are attached with `BPF_LINK_CREATE` links and live exactly as long as a link fd is open (no bpffs pins after `switch_root`). `boot` passes the ten link fds to `warden` as fds 9–18, one per hook row, in no particular order, with `keylos.execlinkfds=9,10,11,12,13,14,15,16,17,18` in `warden`'s argv (the boot report is fd 8, §20.1). The `warden` core MUST keep them open for its lifetime and never closes or passes them on; closing them detaches `kl-exec`.

**Registering a generation.** Before adding a mount's superblock to `kl_exec_allowed_sb`, the registrant (`boot` for the OS and bootstrap generations; `warden` for everything else, including mounts it makes on behalf of `bench` and `compat`) MUST:
1. obtain the tree from `depot.mount` (or mount it itself with `verity=require` from a digest-checked image, as `boot` does);
2. verify the generation statement (§20.7) DSSE signatures against the **boot trust set** (§20.1): release-stream keys for distro generations, publisher keys enabled in the config generation, and the owner-seal keys for owner-sealed generations;
3. check the generation is not listed `unlaunchable` in the current revocation list (§11.7);
4. read the superblock device with `statx(tree_fd, "", AT_EMPTY_PATH)` and convert it to the kernel `dev_t` (`stx_dev_major << 20 | stx_dev_minor`).

The decision is sound because the composefs overlay was mounted with `verity=require` from an image whose digest was checked, overlay superblocks are not shared across mounts from different images, and only `warden` can update the map. Writable mounts are always `noexec` in addition.

**Second layer: IPE.** IPE runs a policy signed by `kernel-policy/<stream>`:

```
policy_name=keylos policy_version=1.0.0
DEFAULT action=ALLOW
op=KEXEC_IMAGE action=DENY
op=KEXEC_INITRAMFS action=DENY
op=EXECUTE boot_verified=TRUE action=ALLOW
op=KERNEL_READ boot_verified=TRUE action=ALLOW
```

**Other code paths:**
- `module.sig_enforce=1`. Modules load only from the OS generation or from a **`kmod` generation** (§6.1), and every module MUST carry a signature by the release stream's module-signing key: only project-built, release-signed out-of-tree modules exist. Owner-sealed modules are impossible by design (lockdown enforces module signatures, and owners hold no module-signing key). `warden` registers a `kmod` generation's mount only if its manifest `kmod.kernel` equals the running kernel release.
- `vm.memfd_noexec=2`; `kernel.unprivileged_bpf_disabled=2`; signed BPF loaders only for `boot` and `warden`.
- **Service BPF programs.** Some tier-0 services need BPF programs (strata provenance, net firewall helpers, gate accounting). `warden` loads them only from the **OS generation**, from `/usr/lib/keylos/bpf/<service>/<program>.o` files listed for that service in `services.json` (§20.16), before starting the service; it attaches them and passes their map fds to the service as `KEYLOS_BPF_FDS` (§10.5). Services never call `bpf()` themselves.
- **Grant ceilings.** The warden core loads a label-ceiling LSM program (`kl-label`, separate from the `kl-exec` hand-over) that enforces the exposure label of directory grants (§7.3.3, §14.1): an `open` through a grant mount, and a read through an fd opened through one, fails with `-EACCES` when the object's `security.bpf.keylos.label` (§10.4) exceeds the grant's ceiling or is malformed. `kl-label` attaches `file_open` and `file_permission` (plus `mmap_file` for reads through a mapping), keyed by the grant mount's ID in its map `kl_grant_ceiling`, and reads kernel structures at BTF-computed offsets as `kl-exec` does. Unlabelled objects get their location default (§14.1), except that on kernels without the `bpf-init-inode-xattr` feature an unlabelled object created after the grant was attached counts as `secret/untrusted`. Where `warden` cannot enforce ceilings, `attachGrant` gets a null ceiling and the broker MUST raise the holder to `secret/untrusted`.
- **JIT.** Generations with `needs.jit: true` get their cgroup added to `kl_exec_jit_cgroups` by `warden` and no `PR_SET_MDWE`.
- **Interpreters.** Interpreters shipped in keylos generations MUST honour `AT_EXECVE_CHECK` and the `SECBIT_EXEC_RESTRICT_FILE` / `SECBIT_EXEC_DENY_INTERACTIVE` securebits. `warden` sets both securebits on every host principal **except** the **trusted-terminal tree**, which gets only `SECBIT_EXEC_RESTRICT_FILE`.
- **Trusted-terminal tree.** The tree is the process spawned through `TrustedSpawn.spawnTerminal` and every process that `kish` running in it spawns as a job (foreground or background, including REPLs started from the prompt). A process spawned by any *other* program in that tree (for example an editor that spawns a helper) is outside the tree and gets both securebits; `warden` decides by the spawning principal's actor kind (`shell` from the trusted terminal) and the `SpawnSpec` origin, not by process ancestry alone.
- **Core dumps.** The kernel `core_pattern` pipe helper (`|/usr/lib/keylos/journal/coredump %P %s %t`) is started by the kernel in the root cgroup. This is the one userspace exception to "only the warden core runs in the root cgroup": the helper is an OS-generation binary, installs its own seccomp filter before reading any input, and **moves itself** into `/keylos.slice/system.slice/journal-coredump.scope` before reading the dump (cgroup v2 delegation rules allow only a process in the root cgroup's domain with root credentials to make that move; `journal` cannot). `journal` verifies the move and refuses dumps from a helper still in the root cgroup. `kl-exec`'s `bpf` rule does not depend on cgroup membership, so the exception grants it nothing. The helper is not exempt from `ptrace_access_check` either: it reads only `/proc/%P/{cgroup,status}` (not ptrace-guarded) and takes the crashed process's file mappings from the core's `NT_FILE` note, never from `/proc/%P/maps`.
- **Supervising without ptrace access.** Because `ptrace_access_check` exempts no task, `warden` and every other component observe and control other processes only through operations the hook does not guard: pidfds (from `clone3(CLONE_PIDFD)` or `pidfd_open`) for signals (`pidfd_send_signal`) and exit (`waitid(P_PIDFD)`), `PIDFD_GET_INFO` for credentials and the cgroup ID, `/proc/<pid>/{cgroup,status}`, and cgroup files. A child's namespace fds are captured at spawn: the child opens its own `/proc/self/ns/*` (a task's access to itself is not checked) and passes them to the spawner before its start barrier, and a mapping helper passes its own user-namespace fd the same way. No keylos component opens another task's `/proc/<pid>/{ns/*,root,cwd,fd,maps,mem,environ}` or uses `PIDFD_GET_*_NAMESPACE`, `setns` on a pidfd, `pidfd_getfd`, `kcmp` or `process_vm_*` on another task, except a debugger or open broker within its `kl_debug_pairs` entry.
- **Known limitation (composefs `mprotect`).** For an overlay (composefs) file mapping the kernel passes the backing file to `file_mprotect`, whose superblock is not the registered overlay superblock, so adding `PROT_EXEC` to such a mapping with `mprotect` is refused outside JIT cgroups. `execve` and `mmap(PROT_EXEC)` see the overlay file and are unaffected; only text relocations and similar are refused. Generations needing them declare `needs.jit`.
- **Legacy open broker.** `compat` runs **one open-broker process per legacy app** (the `kl_debug_pairs` map holds one target per tracer). At `LegacySpawn` time (parameter `brokerSession`, §7.5.1) `warden` writes a `kl_debug_pairs` entry (scope `process`, no expiry while the app runs) from that open-broker process's cgroup to the legacy app's cgroup. For this pair `ptrace_access_check` permits `PTRACE_MODE_READ` and `PTRACE_MODE_ATTACH_REALCREDS` (the mode the kernel checks for `process_vm_readv`). The open broker runs with seccomp profile `openbroker-1`, which allows `process_vm_readv` and denies `ptrace`, `process_vm_writev` and `pidfd_getfd`, so the pairing yields read access to the app's memory for decoding seccomp-notification syscall arguments and nothing else.
- **Debugging (`Right.debug`).** A debug grant is minted only at tier T3 with presence, lasts at most 3 600 s (scope `process`) or 900 s (scope `kernel`), and is never minted to an agent principal unless the target session lies inside that agent's own session tree; agents never get scope `kernel` and never a `gen:` target. A request with `durationSecs = 0` resolves to the policy default before minting (default 900 s for `process`, 300 s for `kernel`). It is materialised by `Broker.debug` → `DebugAttach.attach` (§7.5.1): `warden` spawns the debugger generation (policy list `debug.debuggers`, e.g. gdb, lldb, perf, bpftrace) with seccomp profile `debug-1`, writes the `kl_debug_pairs` entry, and grants the debugger ambient capabilities: `CAP_SYS_PTRACE` and `CAP_PERFMON` for scope `process` (tracing another dynamic UID and opening cgroup-scoped perf events need them), plus `CAP_BPF` for scope `kernel`. `kl-exec`'s `ptrace_access_check`, `perf_event_open` and `bpf` hooks bound what those capabilities reach to the paired target. Receipts `debug.attach`/`debug.detach`. Inside workbench VMs debugging is unrestricted.


### A.12 protocols §10.1 — Host layout

> Verbatim copy of `protocols/spec.md` lines 3058–3089 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 10.1 Host layout

| Path | Content | Properties |
|---|---|---|
| `/` | OS generation (composefs, `verity=require`) | ro |
| `/usr` | Part of the OS generation | ro |
| `/etc` | Merged config generation (confext) | ro |
| `/var` | btrfs subvolume `@var` | rw, `nosuid,nodev,noexec` |
| `/home/<user>` | btrfs subvolume per user | rw, `nosuid,nodev,noexec` |
| `/home/<user>/.apps/<app-name>/{config,data,cache,state}` | Subvolume per app and user | the only writable paths in an app's view |
| `/store/objects/<2 hex>/<62 hex>` | Store objects, fs-verity enabled, mode 0444 | written only by `depot` |
| `/store/gens/<64 hex>.erofs` | Generation images | |
| `/store/evidence/` | Generation statements, attestations, consent records | `depot` |
| `/store/db/` | `depot` database | |
| `/store/rcpt/` | `ledger` data | |
| `/keystore` | btrfs subvolume `@keystore`, **excluded from all snapshots** | `vault`, `hearth`, `ledger`, `strata` key material (wrapped) |
| `/snapshots` | btrfs snapshot area, `strata` only | |
| `/run` | tmpfs | |
| `/run/keylos/svc/<svc>/` | Service socket directories | 0700 warden |
| `/run/keylos/boot/trust.json`, `report.json` | Boot trust set and boot report (§20.1) | 0444, written by `boot` |
| `/var/lib/keylos/<repo>/` | Each service's private state directory (other repos may read only the files listed in §10.7) | owned by the service's dynamic UID |
| `/var/lib/keylos/cri/images/` | OCI content store for `keylos-vm` pods (unsealed, never executed on the host) | `cri`; `noexec`; shared read-only into pod VMs |
| `/efi` | ESP | mounted only during updates (and by `boot` for `/efi/keylos/vbu-totp.sealed`) |

**App mount view** (what a tier-1 process sees):
- its app generation at `/` (with `/usr` from its runtime generation if it declares one);
- `/etc` filtered to the app-visible subset (`/etc/keylos/app-visible.list` in the config generation);
- its `.apps/<name>` subvolumes at `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `$XDG_CACHE_HOME`, `$XDG_STATE_HOME` (idmapped to its dynamic UID);
- `/run/user/<uid>/` with only its Wayland socket (security-context tagged) and its PipeWire remote if granted;
- `/grants/` (initially empty; runtime grants are attached here);
- `/tmp` as a private tmpfs;
- nothing else.


### A.13 protocols §12 — Command signatures, fd passing, pipe protocol

> Verbatim copy of `protocols/spec.md` lines 3327–3368 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

## 12. Command signatures (`keylos.cmdsig/1`)

Every native command ships `/.keylos/cmdsig/<name>.json`. `kish`, `aide` (tool definitions) and the SDK consume them.

```json
{
  "schema": "keylos.cmdsig/1",
  "name": "ls",
  "summary": "List directory entries",
  "args": [{"name": "dirs", "type": "dir", "access": "read", "variadic": true, "default": "."}],
  "flags": [{"name": "all", "short": "a", "type": "bool", "summary": "Include hidden entries"}],
  "input": {"type": "none"},
  "output": {"type": "records", "schema": {"name": "text", "size": "int", "kind": "text", "modified": "time"}},
  "effects": [],
  "net": [],
  "exit": {"0": "ok", "1": "partial", "2": "error"}
}
```

**Types:**

| Category | Values |
|---|---|
| Scalars | `bool`, `int`, `float`, `text`, `bytes`, `time`, `duration`, `size` |
| Filesystem | `path` (no access), `file`, `dir` (both with `access`: `read` / `write` / `create` / `readwrite`) |
| Network | `host`, `url` |
| Composite | `list<T>`, `record{...}`, `enum[...]`, `secret-ref` |

The shell opens `file` and `dir` arguments according to `access` and passes them as fds (§12.1).

### 12.1 Argument fd passing

For each `file` or `dir` argument, the shell passes an fd and replaces the argument text with `/dev/fd/<n>`. It also sets `KEYLOS_ARGFD_<argname>=<n>[,<n>…]`.

Native programs SHOULD use the fd environment variables. Legacy programs simply open `/dev/fd/<n>`.

### 12.2 Pipe protocol

Pipes negotiate their format **statically**: the shell knows both ends' signatures.
- If the producer's `output.type` is `records` and the consumer's `input.type` is `records` (or `any`), the shell sets `KEYLOS_PIPE_OUT=cbor-seq` on the producer and `KEYLOS_PIPE_IN=cbor-seq` on the consumer.
- In that mode, records are an RFC 8742 CBOR sequence of maps that conform to the declared schema.
- In every other case the pipe carries bytes, and records are rendered as text by the producer's text formatter (TSV for `records` unless `--format` is given).


### A.14 protocols §14.1–§14.5 — Labels, effect kinds, approval tiers, mandates, operating rules

> Verbatim copy of `protocols/spec.md` lines 3427–3452, 3454–3498, 3500–3519, 3521–3539, 3541–3554 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 14.1 Labels

| Dimension | Values (lowest → highest) |
|---|---|
| Confidentiality | `public` (0) < `internal` (1) < `private` (2) < `secret` (3) |
| Integrity | `trusted` (0) < `user` (1) < `untrusted` (2). Higher means *less* trustworthy |

- **Objects:**
  - Files carry `security.bpf.keylos.label`. Files without one inherit the default for their location: home data `private/user`; downloads and web content `public/untrusted`; store objects `public/trusted`.
  - Sockets get a label per connection from `gate`: responses from hosts are `untrusted` unless the policy marks the host `user`.
- **Sessions:** each principal session has a label. On every broker-mediated read, `session.conf = max(session.conf, object.conf)` and `session.integ = max(session.integ, object.integ)`. Labels never decrease within a session.
- **Label authority:** services that hand data from one principal to another (gate, bench, portals, atrium, strata, aide, journal, warden) raise the receiver's label with `LabelAuthority.raiseFor` (§7.5.2) **before** handing the data over. `warden` reads live labels with `labelOf` for `ConnectionInfo.label`.
- **Removable media and discovery:** bytes from `MediaBrowser` and results from `Discovery.browse` are `public/untrusted`.
- **Rule of Two** (enforced by `broker` and `gate`): define three properties of a session:
  - **U** = `integ == untrusted`
  - **P** = `conf ≥ private`
  - **X** = holds or requests a capability with `Right.commit`, an `effect` resource, or egress to a host not marked `sink-safe`

  A session MUST NOT hold all three. Requesting the third turns into a **declassification** approval at tier T3, unless a policy-registered **flow proof** (§20.11) is accepted. A flow proof is accepted only from an `agent-template` whose manifest `agent.flowProof` is `"camel/1"` and whose harness runtime is in the policy's trusted list.
- **Directory grants** (ceilings). A directory exposed to a session through a grant has an **exposure label** *c*, and the label assumptions hold only if *c* bounds everything readable through the grant for its whole lifetime:
  - The receiver's session label is raised to *c* (`raiseFor`) **before** the directory is exposed, and the resulting policy decision (Rule of Two) is enforced at that point.
  - *c* is enforced by `warden` (§7.3.3, §9.3): objects labelled above *c*, or with a malformed label, are not readable through the grant, whenever they appeared. Unlabelled objects count at their location default.
  - The broker may choose *c* as the join of a **complete** assessment of the tree. A bounded or truncated walk never justifies anything lower than the location default; entries above *c* then stay unreadable through the grant and are reported as hidden.
  - Without enforcement (null ceiling) the exposure label is the lattice maximum `secret/untrusted`.
  - Writes, relabels and renames into the tree, retained handles and concurrent changes are covered because enforcement happens at every open and read through the grant, not at grant time. A retained fd loses read access as soon as its object's label rises above *c*.
  - Agent input SHOULD be an **immutable assessed view** (a transaction base snapshot or a bench share snapshot): its complete assessment is final, so its exposure label can be lower without losing workflows to the `secret` deny of agent policy.

### 14.2 Effect kinds

Registered kinds, with their default class:

| Kind | Class |
|---|---|
| `fs.merge` | compensable (undo snapshot; compensator `fs.undo`) |
| `git.push` | compensable for new branches; irreversible for force pushes, pushes to protected branches and any other push to an existing branch |
| `git.pr.open` | compensable |
| `email.send` | irreversible |
| `message.send` (chat) | irreversible |
| `http.post`, `http.put`, `http.patch` | irreversible unless the host policy registers a compensator |
| `http.delete` | irreversible |
| `payment.authorize` | irreversible (requires an AP2-style mandate in `data`) |
| `publish.package` | irreversible |
| `cloud.iam.change` | irreversible |
| `db.write.prod` | irreversible |
| `calendar.create` | compensable |
| `file.share` | compensable |
| `device.actuate` | irreversible |
| `net.listen` | compensable (close the port). Required for any port reachable from non-loopback addresses (scope `lan`/`any`); loopback-only listening needs no effect |
| `media.export` | compensable (delete the file on the device); counts as egress (property X) for the Rule of Two |
| `config.propose` | reversible (a proposal only; applying it is `config.apply`) |

Policy can register additional kinds (`x-…`), each optionally with an effect renderer component (§20.15). Classes can be raised, never lowered.

**Mandate-only kinds.** The broker records decisions that are not intents with these kinds in mandate `effects[]` (§14.4): `grant.<k>` for every resource kind *k* of §8.2 (`grant.path`, `grant.net`, `grant.device`, `grant.secret`, `grant.budget`, `grant.spawn`, `grant.service`, `grant.effect`, `grant.delegate`, `grant.principal`, `grant.screen`, `grant.model`), `grant.declassify`, `debug.attach`, `pod.admit`, and for durable workflows (§20.25) `workflow.enroll` (target `wf-…`, digest = SHA-256 of the JCS `EnrollRequest` JSON form `{"workflow", "definition": {"generation": <gen ref text>, "name", "digest": <digest text>}, "inputDigest": <digest text>, "scope": [<GrantRequest JSON forms>], "budgets": [{"unit", "amount"}], "resume": "manual" | "automatic", "runWhileLocked", "horizonSecs", "reason", "account"}`), `workflow.resume` (target `wf-…`) and `workflow.decide` (target the `ws-…` or `fx-…` the decision is about, digest = SHA-256 of the JCS question or resolution document). They are valid only in mandates, written only by `broker`, and never appear in manifests, command signatures, intents or `gate` intents.

**Required review details.** Approval of an effect requires that the trusted path presents at least these details of the exact payload (§7.3.4); a policy-registered kind's renderer declares its own, and a kind without a declaration requires the complete canonical payload:

| Kind | Required details |
|---|---|
| `email.send`, `message.send` | every recipient (to, cc, bcc), subject, complete body, attachment names, types and sizes |
| `http.*` | method, complete URL, request body (or its digest plus a complete canonical rendering for bodies over the channel limit) |
| `payment.authorize` | amount, currency, payee, mandate terms |
| `fs.merge` | the complete `keylos.fsmerge/2` manifest and the diff of every changed text file; binary changes by path, size and digest |
| `git.push`, `git.pr.open` | remote, refs (old → new), commits with titles; force flag |
| `publish.package`, `cloud.iam.change`, `db.write.prod`, `device.actuate` | target and the complete operation |
| `file.share`, `calendar.create`, `media.export`, `net.listen` | target (people, device or port and scope) and the object |
| `config.propose`, `config.apply` | the complete plan diff |
| `grant.*`, `debug.attach`, `pod.admit`, `grant.declassify` | resource, rights, duration, persistence, requesting principal and `onBehalfOf` |
| `workflow.enroll` | definition (name, version, generation, digest), every scope item as for `grant.*`, budget ceilings, resume policy (`automatic` stated as "runs again after restarts without asking"), `runWhileLocked`, horizon, the owner and the label the workflow starts with |
| `workflow.resume`, `workflow.decide` | workflow, definition, current step, the complete question or resolution document, and for `workflow.decide` on an effect the effect's own required details |

**Caller-executed effects.** For `media.export`, `device.actuate` and `config.propose`, `gate` stages, renders and decides the intent but does not perform it. A successful `Intent.commit` returns, in `IntentStatus.result`, the base64 delivered mandate (§14.4) bound to the payload digest, and `gate` writes `effect.commit` meaning "authorized". The executor (`bench` `MediaBrowser.export`/`ExportCompletion.finish`, the device's owning service, `config` for `propose`) MUST verify the mandate (owner-presence or `service/broker` signature, payload digest, expiry, single use) before acting, and writes its own completion receipt (`media.export` by `bench`). Stagers of `media.export` are `portal-files` and `atrium` on behalf of the requesting app. **Authorization is not completion**: an intent in `committed` state of a caller-executed kind, and an effect in `authorized` state (§20.26), say only that the effect may be performed; a workflow waits for the executor's authenticated completion (its receipt, `DurableEffects.complete`) before it treats the effect as done.

### 14.3 Approval tiers

| Tier | Covers | Interaction |
|---|---|---|
| T0 | Reads and overlay writes within grants | None, receipt only |
| T1 | Reversible egress to granted hosts | None; a classifier MAY escalate to T2/T3 |
| T2 | Compensable effects, new hosts, widening a sub-principal's scope | Batched review on the trusted path |
| T3 | Irreversible effects, declassification, budget overrun, merge of an agent overlay, config apply, seal, policy change | Synchronous trusted-path prompt with rendered effects and argument provenance. Presence (FIDO2 touch) is REQUIRED for config apply, seal, policy change, payment, persistent grants, and any effect whose policy says `presence` |

Rules:
- No automated component may lower a tier.
- A remote approval routed to a paired phone (`VouchLink.routeApproval`) or an org approval (`OrgDecider.decide`) MAY satisfy a T2/T3 approval only when the policy explicitly allows that channel for that effect kind, and **never** satisfies `requiresPresence`.
- **Channel selection.** The broker puts `"phone"` in `ApprovalPrompt.channels` only when the matching permit's `@channels` includes `phone` **and** a `vouchd` approver key is registered this boot (`registerApprover(…, "phone")`); `"org"` only for `@orgApproval` permits on fleet-enrolled machines. The mandate's `channel` records the channel that decided.
- **Family machines.** A non-owner human's request that needs an owner decision (config proposal, seal, persistent grant, policy change, install of an unreviewed app) becomes an approval prompt to the owners with `requester` set; it is shown on the next owner trusted-path session or routed to an owner's paired phone (never satisfying presence).
- **Quorum machines.** Wherever presence is required, a quorum presence envelope (§5.4) is required instead.
- **Headless machines without fleet.** On profiles without `atrium` that are not fleet-enrolled, every approval at T2 or above is escalated to a quorum presence request (`HearthQuorum.request`); there is no local trusted path. The resulting mandate has `channel: "quorum"`.
- **Guest sessions** never receive presence-class grants, agent sessions (unless `hearth.guest.agents` is true) or persistent grants.
- **Fail closed on rendering.** No channel may produce an approving decision for an effect whose required review details (§14.2) were not presented completely (§7.3.4). This holds for local prompts, presence cards, phone, org and quorum review alike; a channel that cannot present them leaves the approval pending for a capable channel, or it expires and is denied.
- **Org approver keys** come only from `/etc/keylos/fleet/approvers.json` (`keylos.fleetapprovers/1`, §20.23).
- **Durable decisions** (§20.25). An approval for a workflow is a durable decision record (`dr-…`) in the broker. Its prompt (`a-…`) is boot-local: a pending decision survives restarts and reboots and is presented again, with a new prompt ID, until it is decided or expires; `expires` is fixed when the decision is created (default 7 days, never beyond the workflow's horizon) and is never extended. Waiting never makes an earlier, incomplete rendering sufficient: each presentation needs the complete required material of that moment. A decided approval is used by a later attempt only through an explicit rebind (`BrokerWorkflow.rebind`), which re-checks current policy, revocation, expiry and presence; it never turns a historical approval into standing authority.

### 14.4 Mandates (`keylos.mandate/1`)

```json
{"schema":"keylos.mandate/1","approval":"a-…","principal":"…","tier":"t3",
 "effects":[{"kind":"email.send","target":"smtp:…","digest":"sha256:<payload digest>"}],
 "scope":"once","constraints":{"maxAmount":null,"expires":"…"},"decidedBy":"alice","presence":true,
 "channel":"local"}
```

- `channel`: `local` (atrium trusted path), `phone` (vouch), `org` (fleet approver), `quorum` (a quorum presence envelope, §5.4; `decidedBy` is `"quorum"`).
- `constraints.workflow` and `constraints.decision`: present exactly in mandates of durable decisions (§20.25): the `wf-…` the decision belongs to and its `dr-…`. A verifier acting for a workflow MUST require `constraints.workflow` to equal the effect's workflow; verifiers that do not know these members reject the mandate (unknown members, §5.1), so an older verifier fails closed.
- `constraints.channels`: the channels the broker allowed for this approval (§14.3, `ApprovalPrompt.channels`), a non-empty array of channel names without duplicates. The deciding `channel` MUST be one of them unless it is `quorum` (quorum presence replaces local presence on quorum machines).
- **Drafts.** `ApprovalPrompt.mandateDraft` is not a valid mandate: it carries placeholder `decidedBy` and `channel` values until the deciding channel fills them in and signs. Only a decided mandate is validated as `keylos.mandate/1`.
- **Extensions carry no authority.** `x-` members (§5.1) of a mandate are informational; no verifier may base an authorization decision on them.
- **Grant effects.** For a grant decision the broker writes one effect `{"kind": "grant.<k>", "target": <canonical resource string>, "digest": "sha256:" + SHA-256(JCS(R))}`, where R is the JSON form of the `GrantRequest`: `{"resource": {<union member>: v}, "rights": [Right enumerant names], "reason", "durationSecs", "persist", "onBehalfOf": <principal text or null>}`, with v = the text value for `path`, `device`, `secret`, `service`, `effect`, `screen`, `model` and `spawn`; `null` for `dirFd` and `delegate`; `{"host", "port", "proto", "methods"}` for `net`; `{"unit", "amount"}` for `budget`; `{"target", "scope"}` for `principal`. A service that asked for a confirmation through `requestFor` (vault: `grant.secret` with `{"secret": "<owner>/<name>"}`) verifies kind and digest.
- **Decision signatures** (inside the approval flow): presence-signed (§5.3) when `presence` is true; otherwise signed by the deciding channel's approver key: the atrium approver key or the `vouchd` phone key (both registered with `BrokerSystem.registerApprover`), or an `approver/<id>` key.
- **Mandates as delivered** (`Approval.mandate`, `GrantResult.mandate`): a presence-signed mandate is delivered as is; a non-presence mandate is re-signed by `service/broker` after the broker has verified the channel's decision signature. Relying services (gate, strata, bench, depot, devd) therefore verify only owner-presence keys (owner registry, via `HearthSystem.owners`) and the `service/broker` key (as registered with `ledger`, `Ledger.serviceKey`, §7.3.5); they never need approver keys.
- The `approval.decide` receipt carries `mandateDigest` (SHA-256 of the delivered mandate envelope).
- `gate` MUST NOT commit an irreversible intent without a mandate whose `effects[].digest` matches the intent payload digest.

### 14.5 Operating rules

**Agent desktops (computer use).** Agents never receive `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts`, clipboard access to another principal's data, or input injection on a human's real session. GUI-operating agents run an **agent desktop**: a tier-3 VM (`VmSpec.purpose = agentDesktop`) running a nested atrium and the needed apps, driven through `AgentDesktop` (§7.5.13). The human can watch a read-only mirror (`displayMode = readOnly`) and take over (`Vm.takeOver`); while taken over, agent input is refused. Files enter only through shares and leave only through effects. Observation of a real-session window is a separate T3 grant (`ResourceRef.screen`, right `read`, Cedar action `snapshot`): one window, one still image per approval, never continuous.

**Model drift.** For every agent session, `gate` records the provider's reported model identifier and version (response headers or body fields defined per provider adapter) in the session's `effect.*`/`budget.charge` receipts. When the observed `(model, version)` differs from the session token's `model(...)` fact (§8.2), `aide` emits event `model.change`, and until the human re-approves (T2 request for `ResourceRef.model`, right `use`, which mints a **new root** token for the session carrying the approved `model(...)` facts; the broker links it to the session's original root, so revoking the original revokes it too), every T1 action of that session is treated as T2. Local models are pinned by their weights data generation and cannot drift.

**Offline operation.** Let *revocation age* be the time since the newest verified revocation list (§11.7), measured against trusted time (§3.6).
- TUF timestamp expired: updates pause; installed generations keep launching; status shows the revocation age.
- Revocation age > 30 days: installing any new third-party generation needs T3; newly imported legacy images get effective tier ≥ 2; agent egress to hosts not contacted before by that agent template needs T2; `offline_days(n)` is an ambient fact for policies (§8.3).
- Generation statements are never accepted with an `issued` time later than trusted time plus 24 h.

**Debugging** follows §9.3 (`Right.debug`).

**Remote lock and wipe** (fleet-enrolled machines). A verified `keylos.fleet.command/1` `lock` is executed at once through `HearthFleet.lockAll`. A `wipe` command locks immediately and is completed only at the next recovery entry, where the recovery environment verifies a quorum envelope (§5.4) of the machine's owners before destroying keyslots; a machine is never wiped by a command alone.


### A.15 protocols §10.5 — Environment conventions

> Verbatim copy of `protocols/spec.md` lines 3131–3177 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 10.5 Environment conventions

Processes receive:
- `KEYLOS_PRINCIPAL` (text)
- `KEYLOS_SESSION`
- `KEYLOS_TIER`
- `KEYLOS_CAPWIRE_FDS`: a comma list of `name=fdnum` for passed service sockets, for example `broker=3,portal-files=4`. Names follow the route-name rule below.
- `KEYLOS_ARGFD_<argname>` and `KEYLOS_PIPE_IN` / `KEYLOS_PIPE_OUT` (§12)
- `KEYLOS_TXN`: the strata transaction ID when spawned with `SpawnSpec.transaction`
- `KEYLOS_AGENT_HOST`: `vsock:2:7002` inside agent workbenches
- `KEYLOS_GUEST_PORTALS`: `vsock:2:7004` inside tier-2 guests
- `KEYLOS_BPF_FDS`: `name=fdnum` list of BPF map fds `warden` loaded for a tier-0 service (§9.3)
- `KEYLOS_TPM_FD`: for services whose `services.json` entry has `privileges.tpm: true`, the number of an inherited fd of `/dev/tpmrm0` that `warden` opened for the service; services use it as their TPM (for example TCTI `device:/proc/self/fd/<n>`) and never open TPM devices by path
- XDG variables, with paths per §10.1

In tier-0 services fd 3 is the `warden` bootstrap socket (`Bootstrap`, §7.5.1) and is not listed in `KEYLOS_CAPWIRE_FDS`.

**Route names in `KEYLOS_CAPWIRE_FDS`:**

| Route | Name |
|---|---|
| `<svc>#client`, `<svc>#default` | `<svc>` |
| `broker#principal` | `broker` |
| `warden#client`, `warden#service` | `warden` |
| any other `<svc>#<facet>` | `<svc>#<facet>` |

**Adopting inherited descriptors.** Programs take ownership of fd 3 and of the descriptors named in `KEYLOS_CAPWIRE_FDS`, `KEYLOS_BPF_FDS` and `KEYLOS_TPM_FD` exactly once at start-up through the `keylos-capwire` inheritance helper (§18), which checks that each fd is open and sets `FD_CLOEXEC`; programs need no `unsafe` code of their own for it.

**Development knobs.** Names starting with `KEYLOS_DEV_` are reserved for development-only settings, for example `KEYLOS_DEV_TPM_TCTI` (a TPM TCTI string such as `swtpm:host=127.0.0.1,port=2321`, which replaces `KEYLOS_TPM_FD`). Production builds never read them, and `warden` never sets them; only the development supervisor of a development image may. Every other development knob of a keylos component uses this prefix. The registered knobs are:

| Knob | Read by | Effect (development builds only) |
|---|---|---|
| `KEYLOS_DEV_TPM_TCTI` | every TPM-using service (vault, hearth, ledger, broker, strata, courier, config) | TPM TCTI string that replaces `KEYLOS_TPM_FD` |
| `KEYLOS_DEV_LEDGER_SELF_PROVISION` | ledger | `1`: on a fresh store with the counter `0x01300100` absent, define it itself (`x-devProvision`) instead of waiting for `HearthTpm.defineSpace`; never after hearth genesis |
| `KEYLOS_DEV_LEDGER_SAMPLE_EXPORT` | ledger (tests) | Directory for sample exports written by the privacy test harness |
| `KEYLOS_DEV_HEARTH_SOFT_AUTHENTICATOR` | hearth | Use a software FIDO2 authenticator instead of a CTAP2 device |
| `KEYLOS_DEV_BROKER_IMPLICIT_SESSIONS` | broker | `1`: register an unregistered `broker#principal` peer implicitly instead of failing `kl:denied` |
| `KEYLOS_DEV_BROKER_POLICY_DIR` | broker | Directory that replaces the warden-mounted `/policy` generation |
| `KEYLOS_DEV_BROKER_GENERATION` | broker | Generation ref used for the broker's own principal when `ServiceHost.accept` and `policy.ref` give none |
| `KEYLOS_DEV_TIME_TRUSTED` | broker, loom | `1`: treat the system clock as trusted without a `NetWatch` `timeTrusted` event |
| `KEYLOS_DEV_WATCHDOG_SECS` | broker and every other daemon with a `watchdogSecs` of its own (it reads the knob itself; the `warden-svc` host reads none) | Watchdog interval that replaces the manifest's `watchdogSecs` |
| `KEYLOS_DEV_LOOM_FAULTS` | loom | Comma list of fault-injection points (`crash:<point>`, `fsync-fail:<point>`, `enospc:<point>`, points named in the loom spec) for the durability acceptance tests |
| `KEYLOS_DEV_LOOM_CLOCK_SKEW_SECS` | loom | Signed offset added to loom's view of trusted time, for timer, expiry and long-downtime tests |

A knob that is not listed here MUST NOT be read by any component; a new knob is registered here before use.

No secrets, ever. Names starting with `KEYLOS_` are reserved; `SpawnSpec.env` MUST NOT set them, with one exception: a `shell` principal MAY set `KEYLOS_ARGFD_*`, `KEYLOS_PIPE_IN` and `KEYLOS_PIPE_OUT` (§12); `warden` verifies that every fd named in `KEYLOS_ARGFD_*` is present in `SpawnSpec.fds`.


### A.16 protocols §7.5.7 — strata-sys.capnp

> Verbatim copy of `protocols/spec.md` lines 1986–2072 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.5.7 `strata-sys.capnp`

```capnp
@0xc7a1e5d3b2f40026;
using C = import "common.capnp";
using S = import "strata.capnp";

enum Choice { ours @0; theirs @1; merged @2; }

interface TransactionExt {
  policy            @0 () -> (networkPolicy :S.NetworkPolicy, views :List(Text));   # view paths for warden mounting
  resolve           @1 (path :Text, choice :Choice, merged :C.Fd) -> ();
  changeSet         @2 () -> (jcs :C.Fd, digest :C.Digest);                         # keylos.changeset/1
  commitWithMandate @3 (mandate :Data) -> (snapshot :Text);                         #! superseded before release by prepare + PreparedMerge.commit: MUST return kl:unsupported
  pin               @4 (pinned :Bool) -> ();
  owner             @5 () -> (session :C.SessionId);                                # session that began the transaction
  prepare           @6 () -> (prepared :PreparedMerge);
      #! freezes the views, captures the live state of every affected path, applies recorded resolutions and clean three-way
      #! merges, and stores the result as an immutable prepared merge (§20.12 keylos.fsmerge/2); kl:conflict while conflicts remain
  bindWorkflow      @7 (binding :C.AttemptBinding) -> ();
      #! facets bench, aide: the transaction (and every prepared merge of it) is owned by binding.workflow from now on (§20.25);
      #! strata verifies the binding for the transaction's owner session with BrokerWorkflow.verify; idempotent; kl:conflict if
      #! the transaction is already bound to another workflow
}

interface PreparedMerge {
  id       @0 () -> (id :Text);                                  # pm-… (§3.5)
  manifest @1 () -> (jcs :C.Fd, digest :C.Digest);               # keylos.fsmerge/2; digest = the fs.merge payload digest
  diff     @2 (path :Text) -> (diff :C.Fd);                      # unified diff of the stored result ("" = whole merge)
  commit   @3 (mandate :Data) -> (snapshot :Text);
      #! verifies the mandate binds digest, takes a writer fence (PrincipalControl.fenceWriters), revalidates every expectedLive
      #! entry and applies exactly the stored operations (no new merge, no overlay read); stale live state → kl:conflict
  discard  @4 () -> ();
  status   @5 () -> (state :Text, transaction :Text, snapshot :Text);
      #! durable completion record: state "prepared" | "committed" | "discarded" | "stale"; for "committed" the commit's
      #! transaction id and pre-commit (undo) snapshot. Retained at least until the owning workflow's horizon (§20.25)
}

interface StrataTxn {              # facets user, bench, aide, cli, warden
  txnExt @0 (id :Text) -> (txn :S.Transaction, ext :TransactionExt);
      #! user/bench/aide/cli: only transactions begun by the caller (or its session ancestors).
      #! warden: any; warden MUST check that the spawner's session equals owner() or descends from it before mounting views
  prepared @1 (id :Text) -> (prepared :PreparedMerge);
      #! user/bench/aide/cli: prepared merges of the caller's own transactions (same ownership rule as txnExt); not on facet warden
  preparedFor @2 (id :Text, binding :C.AttemptBinding) -> (prepared :PreparedMerge);
      #! facets bench, aide: a prepared merge of a transaction bound to binding.workflow (bindWorkflow), for a fresh attempt of that
      #! workflow that does not descend from the session that prepared it; strata verifies the binding is current
      #! (BrokerWorkflow.verify); a stale or foreign binding: kl:not-found
}

struct UnitInfo { id @0 :Text; alias @1 :Text; mode @2 :Text; subvolumes @3 :List(Text); mounted @4 :Bool; backend @5 :Text; }
struct SubvolInfo { uuid @0 :Text; path @1 :Text; kind @2 :Text; human @3 :Text; owner @4 :Text; unit @5 :Text; snapshotClass @6 :Text; backupClass @7 :Text; }
struct BackupStatus { target @0 :Text; lastRun @1 :C.Timestamp; lastResult @2 :Text; lastRestoreTest @3 :C.Timestamp; nextRun @4 :C.Timestamp; }

interface StrataAdmin {            # facet admin; mountUnit also on facet warden; lockUnits/unlockUnits also on facet hearth; preUpdate also on facet courier
  subvolumes      @0 (human :Text) -> (list :List(SubvolInfo));
  createSubvolume @1 (parent :C.Fd, name :Text, kind :Text, owner :Text) -> (info :SubvolInfo);
  deleteSubvolume @2 (uuid :Text) -> ();
  units           @3 () -> (list :List(UnitInfo));
  mountUnit       @4 (unit :Text) -> (view :C.Fd);       # detached mount fd of the plaintext view
  lockUnits       @5 (human :Text) -> ();
  unlockUnits     @6 (human :Text) -> ();
  pin             @7 (snapshot :Text, pinned :Bool) -> ();
  deleteSnapshot  @8 (snapshot :Text) -> ();
  backupNow       @9 (target :Text) -> (run :Text);
  backups         @10 () -> (list :List(BackupStatus));
  status          @11 () -> (json :Text);
  preUpdate       @12 (reason :Text) -> (set :Text);      # snapshot set before an OS update
}

interface StrataHomes {            # facet hearth
  createHome @0 (user :Text, uid :UInt32) -> (info :SubvolInfo);
  deleteHome @1 (user :Text, forget :Bool) -> ();
  createEphemeralHome @2 (user :Text, uid :UInt32) -> (info :SubvolInfo);   # guest sessions: not snapshotted, ephemeral unit key
}

interface StrataVolumes {          # facet cri
  create  @0 (podId :Text, name :Text, kind :Text, sizeBytes :UInt64) -> (dir :C.Fd);
      #! kind "emptyDir" (subvolume, deleted with the pod) | "local" (local PersistentVolume, kept until release);
      #! dir is an O_PATH fd; sizeBytes is enforced without qgroups: strata scans usage every 30 s and reports
      #! over-limit volumes in usage(), and cri evicts the pod (Kubernetes ephemeral-storage semantics)
  release @1 (podId :Text, name :Text) -> ();
  usage   @2 (podId :Text) -> (json :Text);
}
```

On facet `gate`, strata serves `Strata.undo` only, for transactions that were committed by an `fs.merge` intent whose compensation `gate` executes (§14.2).


### A.17 protocols §7.5.1 — warden-sys.capnp (TrustedSpawn, DebugAttach)

> Verbatim copy of `protocols/spec.md` lines 1573–1744 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.5.1 `warden-sys.capnp`

```capnp
@0xc7a1e5d3b2f40020;
using C = import "common.capnp";
using W = import "warden.capnp";
using B = import "broker.capnp";

interface Bootstrap {                  #! bootstrap of fd 3 in every tier-0 service (connection to warden)
  host     @0 (host :ServiceHost) -> ();   # the service registers its ServiceHost; MUST be called first
  ready    @1 () -> ();                    # readiness signal
  watchdog @2 () -> ();                    # liveness ping (interval from the service manifest)
  status   @3 (text :Text) -> ();          # human-readable status line
}

interface ServiceHost {                #! implemented by every tier-0 service; warden is the only caller
  accept @0 (socket :C.Fd, connectionId :UInt64, facet :Text, peer :C.PrincipalId, tier :W.Tier, generation :C.Ref) -> ();
  stop   @1 (reason :Text) -> ();          # cooperative stop before SIGTERM
  reload @2 () -> ();                      # the config generation changed; warden has rebuilt the service's /etc view
}

interface GrantMounts {                # facets broker, bench, compat, portals, cri (idmappedDir only)
  attachGrant @0 (session :C.SessionId, name :Text, tree :C.Fd, readOnly :Bool, ceiling :C.Label) -> (inView :C.Fd, viewPath :Text);
      #! bind-mounts tree (non-recursive, idmapped to the holder's dynamic UID) at /grants/<name> in the holder's mount namespace;
      #! inView = O_PATH fd of the mount root opened through the holder's namespace;
      #! ceiling = the grant's exposure label (§14.1): objects labelled above it are never readable through the mount;
      #! a null ceiling means no enforcement (the caller MUST then have raised the holder to secret/untrusted)
  detachGrant @1 (session :C.SessionId, name :Text) -> ();
  idmappedDir @2 (dir :C.Fd, forPrincipal :C.PrincipalId, readOnly :Bool) -> (tree :C.Fd);
      #! detached idmapped clone (open_tree + mount_setattr MOUNT_ATTR_IDMAP); used by bench/compat for shares
}

enum TerminateMode { kill @0; freeze @1; thaw @2; }

struct PrincipalEvent {
  session   @0 :C.SessionId;
  principal @1 :C.PrincipalId;
  time      @2 :C.Timestamp;
  union {
    spawned @3 :W.Tier;
    exited  @4 :W.ExitStatus;
    frozen  @5 :Void;
    thawed  @6 :Void;
  }
  cgroupId  @7 :UInt64;          # kernel cgroup id of the principal's scope (stable for the session's lifetime)
}

interface PrincipalControl {           # facets broker, admin, hearth (terminate own humans' sessions), strata (events, mountView), cri (pod sessions)
  terminate @0 (session :C.SessionId, mode :TerminateMode) -> ();   #! applies to the session and all descendant sessions
  list      @1 (humanFilter :Text) -> (sessions :List(C.PrincipalId));
  events    @2 (watcher :C.Watcher(PrincipalEvent), replay :Bool) -> (cancel :C.Cancelable);
      #! replay = true: first emits one `spawned` event for every currently running session (visible to the facet), then live events
  mountView @3 (session :C.SessionId) -> (json :Text);               # JCS: [{target, source, flags, grant}]
  fenceWriters @4 (tree :C.Fd, exclude :List(C.SessionId)) -> (fence :WriterFence);
      #! facet strata: freezes every session (except exclude and their descendants) whose view can write inside tree,
      #! and returns once they are frozen; kl:conflict if a writer cannot be frozen (tier-0 service other than strata,
      #! kernel or network filesystem writer); released by WriterFence.release, when the capability is dropped, or after 30 s
}

interface WriterFence {
  sessions @0 () -> (list :List(C.SessionId));   # the frozen sessions
  release  @1 () -> ();                         # thaws them
}

interface ServiceConnect {             # facet broker
  connectService @0 (session :C.SessionId, service :Text, facet :Text) -> (socket :C.Fd);
      #! creates a route for an existing principal; returns the principal-side capwire socket
}

interface FdStore {                    # facet service (each service sees only its own keys)
  store @0 (key :Text, fd :C.Fd) -> ();    #! survives the service's restarts within one boot
  fetch @1 (key :Text) -> (fd :C.Fd);
  drop  @2 (key :Text) -> ();
}

struct LegacyGrant { tree @0 :C.Fd; target @1 :Text; readOnly @2 :Bool; }

struct LegacyView {
  image    @0 :C.Ref;                  # legacy-image generation
  stateDir @1 :C.Fd;                   # per-image writable state (overlay upper + work)
  grants   @2 :List(LegacyGrant);
  netMode  @3 :Text;                   # "none" | "pasta"
}

interface LegacySpawn {                # facet compat
  spawnLegacy @0 (spec :W.SpawnSpec, view :LegacyView, brokerSession :C.SessionId) -> (process :W.Process, notifyFd :C.Fd);
      #! user namespace with a 65 536-UID block, child user.max_user_namespaces=0;
      #! notifyFd = seccomp user-notification listener for the open broker (protocols §9.2);
      #! brokerSession = the per-app open-broker session that gets the read pairing to this app (§9.3)
}

interface UserSpawn {                  # facets launcher (atrium launcher), handler (portal-openuri, portal-notify, portal-background)
  spawnForHuman @0 (spec :W.SpawnSpec, human :Text, initialLabel :C.Label) -> (process :W.Process);
      #! new top-level session under the human's current shell session; label starts at max(default, initialLabel)
}

interface TrustedSpawn {               # facet trusted-terminal (atrium-term only)
  spawnTerminal @0 (spec :W.SpawnSpec, pty :C.Fd) -> (process :W.Process);
      #! actorKind MUST be shell; warden withholds SECBIT_EXEC_DENY_INTERACTIVE for exactly this process tree (§9.3)
}

interface DebugAttach {                # facet broker (materialises Right.debug, §9.3)
  attach @0 (target :Text, scope :Text, debugger :C.Ref, entrypoint :Text, argv :List(Text),
             pty :C.Fd, expiresSecs :UInt32, grantId :Text, requester :C.PrincipalId) -> (process :W.Process);
      #! target "session:s-…" | "gen:fsv256:…"; scope "process" | "kernel"; expiresSecs ≤ 3600 (process), ≤ 900 (kernel);
      #! debugger MUST be a launchable generation whose manifest name is in the policy list debug.debuggers;
      #! warden spawns it as a child of requester's shell session (the human the grant was minted to) with seccomp profile
      #! debug-1 and the ambient capabilities of §9.3, writes kl_debug_pairs, and on expiry or exit removes the pair,
      #! kills the debugger and writes debug.detach
}

struct PodMount {
  tree       @0 :C.Fd;
  target     @1 :Text;
  readOnly   @2 :Bool;
  tmpfsBytes @3 :UInt64;   # 0: bind tree at target; > 0: warden creates a tmpfs of that size at target and copies tree into it
                           #  (configMap, secret, projected and downwardAPI volumes, §21.6)
}

struct PodContext {
  podId        @0 :Text;               # pod-… (§3.5)
  namespace    @1 :Text;
  name         @2 :Text;
  uid          @3 :Text;               # Kubernetes pod UID (metadata)
  netns        @4 :C.Fd;               # pod network namespace created by cri inside the cri network
  sharePid     @5 :Bool;               # shareProcessNamespace
  mounts       @6 :List(PodMount);     # volumes, prepared by cri (strata volumes, projected tmpfs)
  cgroupParent @7 :Text;               # under /keylos.slice/kube.slice/
  seccomp      @8 :Text;               # "baseline-1" | "runtime-default" (baseline-1 ∩ the CRI RuntimeDefault profile)
  readOnlyRoot @9 :Bool;
  runAsUid     @10 :UInt32;            # container-visible UID; mapped through a per-pod mapping-only userns held by warden (idmapped rootfs)
}

interface PodSpawn {                   # facet cri (keylos-sealed runtime class only, §21)
  spawnContainer @0 (spec :W.SpawnSpec, pod :PodContext) -> (process :W.Process);
      #! spec.generation MUST be kind container with an org-publisher genstmt; actorKind pod; tier t1;
      #! the container joins pod.netns and (if sharePid) the pod's pid namespace; no added capabilities, ever;
      #! the root is read-only plus tmpfs at /tmp, /run, /var/tmp and /dev/shm (§21.8)
  execInContainer @1 (spec :W.SpawnSpec, container :C.SessionId) -> (process :W.Process);
      #! CRI Exec/ExecSync: a child session of the container's principal that joins its mount, pid, net, ipc and uts
      #! namespaces and its cgroup; spec.generation MUST equal the container's generation; no added capabilities
  egressShim      @2 (podId :Text) -> (shim :Capability);
      #! a gate-sys ShimEndpoint (§7.5.12) bound to the pod's principals, created by warden as for tier L; cri runs the
      #! pod's egress redirector with it when cluster.egressViaGate is set (§21.5)
}

struct VmPrincipal {
  session       @0 :C.SessionId;
  parentSession @1 :C.SessionId;      # session the VM descends from (agent: the aide-created chain; pod: cri's session)
  principalKind @2 :W.SpawnSpec.ActorKind;   # bench, agent, legacy or pod
  image         @3 :C.Ref;            # bench-image generation
  template      @4 :C.Ref;            # agent-template generation for agent VMs, else empty
  tier          @5 :W.Tier;           # t2 or t3
  offered       @6 :List(C.Token);    #! tokens held by parentSession (e.g. the launching human's), to be attenuated for the VM
  purpose       @7 :Text;             # VmSpec.Purpose enumerant name
  podId         @8 :Text;             # purpose pod only
  checks        @9 :List(Text);       #! Datalog checks (§8.3) the broker appends when attenuating `offered` for this VM (sub-agents: aide narrows the parent's grants)
  budgets       @10 :List(B.Budget);  #! hard sub-meters carved from the offered roots (GateMeterAdmin.carve, §7.5.12) for this VM principal
  attempt       @11 :C.AttemptBinding; #! from VmSpec.attempt / ForkSpec.attempt; forwarded unchanged in SessionReg.attempt
}

interface VmSpawn {                    # facet bench
  register   @0 (vm :VmPrincipal) -> (principal :C.PrincipalId, cgroupId :UInt64, tokens :List(C.Token));
      #! creates the VM principal (dynamic UID, cgroup scope, BrokerSystem.registerSession); the actor follows §3.4
      #! (agent: "agent:" + template; pod: "pod:…"; otherwise "<kind>:" + image); tokens are those the broker issued
  spawnVmm   @1 (session :C.SessionId, spec :W.SpawnSpec) -> (process :W.Process);
      #! spawns crosvm, its device processes, bench-net and bench-relay inside the VM principal's cgroup;
      #! spec.generation MUST be the bench generation; warden wires bench-net to gate#shim and bench-relay to
      #! aide#host (agent VMs), broker#principal, vault#app and portal-*#default for that principal
  unregister @2 (session :C.SessionId) -> ();   # after the last VMM process of the principal exited
}
```


### A.18 protocols §7.3.6 — vault.capnp

> Verbatim copy of `protocols/spec.md` lines 938–967 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.6 `vault.capnp`

```capnp
@0xc7a1e5d3b2f40006;
using C = import "common.capnp";

struct ItemAcl {
  actors  @0 :List(Text);        # actor patterns, e.g. "app:gen:fsv256:…", "app:name=org.example.Editor"
  ops     @1 :List(Op);
  prompt  @2 :PromptPolicy;
  enum Op { read @0; use @1; update @2; delete @3; }
  enum PromptPolicy { never @0; perSession @1; always @2; presence @3; }
}

struct ItemInfo { name @0 :Text; kind @1 :Text; created @2 :C.Timestamp; acl @3 :ItemAcl; }

interface Vault {
  open    @0 (name :Text, purpose :Text) -> (secret :C.Fd);       #! delivery format §20.10 (memfd_secret, mmap-only, length-prefixed)
  store   @1 (name :Text, kind :Text, value :C.Fd, acl :ItemAcl) -> ();   # value.index 0xFFFF = ACL-only update
  delete  @2 (name :Text) -> ();
  list    @3 () -> (items :List(ItemInfo));
  sign    @4 (name :Text, alg :Text, data :Data) -> (signature :Data);   # key never leaves vault
  sshAgent @5 () -> (socket :C.Fd);                                     # per-principal SSH agent protocol socket
  dataKey @6 (unit :Text) -> (key :C.Fd);                                # crypto-shred unit key (facets strata, ledger, gate, aide, journal, loom; each only for its own unit prefix)
  forget  @7 (unit :Text) -> ();                                         # destroy unit key (same facets)
  inject  @8 (name :Text, target :Text) -> (handle :Data);              # facet gate only: opaque handle for credential injection
}
```

An injection handle is redeemed by `gate` with `open("inject:<hex handle>", purpose)` on facet `gate`.


### A.19 protocols §7.3.5 — ledger.capnp

> Verbatim copy of `protocols/spec.md` lines 902–936 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

#### 7.3.5 `ledger.capnp`

```capnp
@0xc7a1e5d3b2f40005;
using C = import "common.capnp";

struct ReceiptRef { seq @0 :UInt64; digest @1 :C.Digest; }

struct Checkpoint { note @0 :Text; }   #! C2SP signed-note checkpoint text, protocols §13.3

struct Filter {
  principalPrefix @0 :Text;
  sessionId  @1 :Text;
  eventTypes @2 :List(Text);
  since      @3 :C.Timestamp;
  until      @4 :C.Timestamp;
  limit      @5 :UInt32;
  fromSeq    @6 :UInt64;          # 0 = from the start; only receipts with seq ≥ fromSeq (continuation: fromSeq = query's next)
}

interface Ledger {
  append     @0 (envelope :Data) -> (ref :ReceiptRef);     #! facet "writer" only
  get        @1 (seq :UInt64) -> (envelope :Data);
  query      @2 (filter :Filter) -> (envelopes :List(Data), next :UInt64);
  checkpoint @3 () -> (checkpoint :Checkpoint);
  prove      @4 (seq :UInt64, treeSize :UInt64) -> (hashes :List(Data));   # RFC 6962 inclusion proof
  consistency @5 (from :UInt64, to :UInt64) -> (hashes :List(Data));
  watch      @6 (filter :Filter, watcher :C.Watcher(Data)) -> (cancel :C.Cancelable);
  serviceKey @7 (service :Text) -> (spki :Data, keyRef :Text, registered :C.Timestamp);
      #! facet reader: the currently registered key of service/<service> (from ledger.key.register); kl:not-found if none.
      #! Relying services use it to verify service-signed records, e.g. non-presence mandates signed by service/broker (§14.4)
}
```

**Read access** (facet `reader`; `writer` includes it): a principal sees receipts whose `subject` or `writer` is itself or a descendant session; a `shell` principal sees every receipt whose subject's human is its human; agent principals see only their own session chain; tier-0 services see receipts per their facet entry in §19.2, and every writer service sees every receipt whose `writer` actor is its own service name under any session and generation (`service:<name>:…`, also from earlier boots), so it can reconcile its own submissions (§20.25); `fleet` (facet `fleet-export`) sees metadata only, unless an owner exception of kind `fleet-receipt-access` (§20.9) lists the event type. Sealed payloads (§13.4) are decrypted for a reader only if the reader may read the receipt **and** the unit key still exists; receipts of crypto-shredded units are returned redacted (`keylos.receipt-redacted/1`). The returned form of a decrypted sealed receipt is defined in §13.4. `query` returns matching visible receipts in increasing `seq`, at most `limit`; `next` is the `seq` of the first matching visible receipt that was not returned (0 = none), and a client continues with the same filter and `fromSeq = next`. `watch` ignores `fromSeq`. Facet `vouch-heartbeat` (vouchd) sees only the metadata (time, subject human) of `user.login` receipts of every human, for the inheritance dead-man timer (§20.19).


### A.20 protocols §7.3.15 — compat.capnp

> Verbatim copy of `protocols/spec.md` lines 1404–1412 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

```capnp
@0xc7a1e5d3b2f40019;   # compat.capnp
using C = import "common.capnp";
using W = import "warden.capnp";
interface Compat {
  importImage @0 (source :Text) -> (generation :C.Ref);   # "oci://…", "flatpak://remote/ref", "distro:<name>:<release>", "rootfs:<dirfd>"
  run         @1 (generation :C.Ref, argv :List(Text), fds :List(W.FdMapping), grants :List(C.Token)) -> (process :W.Process);
}
```


### A.21 protocols §19.2 — Facets kish holds

> Verbatim copy of `protocols/spec.md` lines 3783–3785, 3798, 3803, 3809, 3830, 3844, 3849, 3861, 3879, 3888, 3892, 3899 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| warden | `client` | every principal | `Supervisor.spawn` (child of caller's session), `identify` |
| broker | `principal` | every principal | `Broker` |
| ledger | `reader` | every principal | `Ledger` except `append` (filtered, §7.3.5) |
| vault | `app` | apps (per `needs.secrets`), `shell`, legacy, bench-relay (for its VM principal, §7.5.10 `GuestPortals.secret`) | `open`, `store`, `delete`, `list`, `sign`, `sshAgent` (own items) |
| gate | `client` | principals with net needs, portal-files, atrium (staging `media.export`) | `connect`, `stage` (own session), `intents` (own session tree, recursive), `intent` (own session tree), `meter` (own roots); `DurableEffects.prepare`, `complete`, `lookup`, `watch` (attempt sessions, own workflow) |
| aide | `user` | human `shell`s, atrium | `Aide` (own human's sessions) |
| depot | `user` | `shell`, atrium, aide, portal-openuri, portal-discovery, gate, any principal granted `depot#user` | `get`, `list`, `install`, `verify`, `revocations`, `revocationStatus`, `openObject` (closures the caller may spawn), `openPath` (`/.keylos/…` only) |
| strata | `user` | `shell`, apps with the route, kish | `begin`, `snapshot`/`snapshots`/`restore`/`undo` (own), `why`, `createUnit` (own home subtree); `StrataTxn` |
| devd | `client` | every principal | `list`, `watch` (filtered); `PowerEvents.subscribe` |
| journal | `client` | every principal | `writer`, `query`/`follow` (own), `Crashes` (own human), `Metrics` (own) |
| bench | `user` | kish, `work`, atrium, portal-files, forge | `project`, `start` (purposes workbench; build (forge only, `unsignedImageOk`); app (kish, atrium launcher: non-reproducible native apps at tier 2)), `snapshots`, `media` (atrium, portal-files), `reattach` (own VMs) |
| compat | `user` | kish, atrium launcher | `importImage`, `run` (own apps) |


### A.22 protocols §8.2–§8.3 — Authority block vocabulary and attenuation checks

> Verbatim copy of `protocols/spec.md` lines 2838–2864, 2866–2895 (keylos-protocols 1.0.0 final). If this copy and protocols differ, protocols wins.

### 8.2 Authority block vocabulary

The broker MUST write the authority block using only these facts. Other components MUST understand all of them.

| Fact | Meaning |
|---|---|
| `principal($p)` | Holder principal text |
| `session($s)` | Holder session |
| `root_id($r)` | Root ID (bytes) |
| `right($kind, $resource, $op)` | Resource text by kind: `path` — `<rel>`, a normalised relative path (no leading `/`, no `.`/`..`, no trailing `/`, `""` = the whole root) naming a subtree matched on component boundaries, under the root named by the token's `path_root` fact; `net` — the host (or `listen:<addr>`), with the `net(...)` facts for that host carrying port, proto and method (a net right without a `net` fact for its host is invalid; a grant with only specific methods does not authorise a protocol-level connect, `"*"` does); `delegate` — `"*"`. `$kind` ∈ {"path", "net", "device", "secret", "budget", "spawn", "service", "effect", "delegate", "principal", "screen", "model"}; `$op` is a `Right` enumerant name. Kind `principal` (resource `session:s-…` or `gen:fsv256:…`) carries only `debug`; kind `screen` (resource `window:<id>`) only `read`, single use; kind `model` (resource `<provider>/<model>@<version>`) only `use` |
| `debug_scope($scope)` | `"process"` or `"kernel"` for a `debug` right; absent means `process` |
| `path_root($fdkey)` | Declares a broker-held root dirfd `$fdkey`; a path right applies under every `path_root` of the authority block. The broker mints at most one `path_root` per token |
| `net($host, $port, $proto, $method)` | `$method` is "*" for no HTTP restriction; `$host` "listen:<addr>" for listening grants |
| `budget($unit, $amount)` | Ceiling per charge in the authorizer (`amount ≤ ceiling`); cumulative spending is tracked by `gate` keyed by root_id |
| `expires($time)` | |
| `tier_floor($n)` | Minimum confinement tier for any process using this token |
| `max_depth($n)` | Maximum **absolute** delegation depth (the root holder is depth 0) |
| `max_fanout($n)` | Maximum number of child sessions |
| `label_ceiling($conf)` | Highest confidentiality the holder may read under this token: bounds both the session label and, when supplied, the object label |
| `persist($grantId)` | Token re-minted from persistent grant `$grantId` |
| `captive($bool)` | Captive-portal token: valid only for the captive-browser VM while `net` reports a captive network (minted by `BrokerSystem.mintCaptive`, ≤ 10 min, `tier_floor` ≥ 2) |
| `model($provider, $model, $version)` | A model identity approved for an agent session (§14.5); the authority block may list several (the approved set). An observed model must match a `model` fact of every block that has one; `gate` compares observed model versions against them |
| `budget_parent($rootId)` | The token's budget is a hard sub-meter of `$rootId` (`GateMeterAdmin.carve`) |
| `workflow($wf, $epoch)` | The token was minted for an attempt of workflow `$wf` (`wf-…`) at ownership epoch `$epoch` (§20.25). Verifiers that act for workflows (`gate` `DurableEffects`) MUST compare `$epoch` with the binding they are given and with the current claim; the fact never authorizes anything by itself |
| `budget_account($ba)` | Spending under this token is charged to the durable workflow budget account `$ba` (`ba-…`, `WorkflowBudget`, §7.5.25) in addition to the root meter, so a fresh attempt's new root never resets spent amounts |

**Fact multiplicity.** The authority block has exactly one `principal`, `session` and `root_id`, and at most one each of `expires`, `tier_floor`, `max_depth`, `max_fanout`, `label_ceiling`, `persist`, `captive`, `debug_scope` (per right), `budget_parent`, `workflow` and `budget_account`; `model` may occur several times. `persist`, `workflow` and `budget_account` are trusted only in the authority block.

### 8.3 Attenuation checks

Attenuation blocks MAY contain any Datalog check over the authorizer's ambient facts. Delegation helpers MAY also append limit facts (`expires`, `max_depth`, `max_fanout`, `label_ceiling`, `tier_floor`, `budget_parent`, `model`, `debug_scope`, `captive`) to attenuation blocks; Biscuit scoping hides them from other blocks, so the authorizer MUST read every block's limit facts and enforce the **most restrictive** value across blocks (minimum for limits, maximum for floors, any-true for restrictions). Limits can therefore only narrow. `expires` is inclusive (`time ≤ expires`), with one-second resolution.

| Ambient fact | Meaning |
|---|---|
| `time($t)` | Now (trusted time, §3.6) |
| `operation($kind, $op)` | Requested operation |
| `resource($kind, $resource)` | Requested resource |
| `path_under($root, $rel)` | Path relation |
| `host($h)`, `port($p)`, `method($m)` | Network attributes |
| `depth($n)` | Current delegation depth |
| `session_label($conf, $integ)` | Current session label |
| `principal_kind($k)` | Actor kind |
| `amount($unit, $n)` | Amount being spent |
| `offline_days($n)` | Days since the last fresh revocation list (§14.5) |
| `proto($p)` | Requested network protocol (`tcp`, `udp`, `https`) |
| `object_label($conf, $integ)` | Label of the object being read (enforces `label_ceiling`) |
| `requested_debug_scope($s)` | Scope of a requested `debug` operation (enforces `debug_scope`) |
| `process_tier($n)` | Confinement tier of the process that will use the materialised resource (enforces `tier_floor`; legacy counts as 1, t2 as 2, t3 as 3) |
| `captive_network($b)` | Whether `net` currently reports a captive network (enforces `captive`) |

Examples:

```
check if time($t), $t <= 2026-10-07T21:30:00Z;
check if operation("path", $op), ["read"].contains($op);
check if resource("net", $r), host($h), ["api.github.com"].contains($h), method($m), ["GET","HEAD"].contains($m);
check if depth($d), $d <= 1;
```
