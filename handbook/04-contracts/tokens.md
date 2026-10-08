# Capability tokens

> Every capability in keylos starts as a Biscuit v3 token minted by `broker`. A token states who holds it, what it covers, and how long it lasts, in a fixed Datalog vocabulary.
> Holders can narrow a token offline. Only the broker can widen authority, and only the broker turns tokens into kernel handles.

**Status:** specified (v1.0). Canonical definition: [protocols §8](../../specs/protocols/spec.md). Implementation: [broker](../../specs/broker/spec.md).

## Why tokens

A capability has to be passed between processes, narrowed before it is delegated, checked by several services (`gate`, `warden`, `devd`, `vault`), and revoked. Biscuit fits all of that:

| Need | Biscuit property |
|---|---|
| Verify without contacting the issuer | Ed25519 public-key signatures over each block |
| Narrow before handing to a child or tool | Holders append blocks with `check` rules; they cannot remove anything |
| Express conditions ("only GET to these hosts, until 21:30") | Datalog checks over ambient facts |
| Small enough to pass in every call | ≈1–2 KiB with three attenuations |

The alternatives and why they lost are in [ADR-0005](../11-decisions/adr-0005-biscuit-capability-tokens.md).

## Lifetime and keys

- The broker generates a fresh Ed25519 root key **at every boot** and keeps it only in memory ([ADR-0040](../11-decisions/adr-0040-per-boot-token-keys.md)).
- No token outlives a boot. Authority that must persist (an app's remembered folder, a manifest-declared host) is stored as a signed **grant record** and **re-minted** when the holder starts, after policy is evaluated again.
- Default lifetimes: 8 h for shells and apps, 30 min for agents. Policy can shorten them.

## The vocabulary

The broker writes only these facts into the authority block (the first block). Every component understands all of them.

| Fact | Example | Meaning |
|---|---|---|
| `principal($p)` | `principal("agent:gen:fsv256:9e1f…@alice/s-01JB…")` | Holder |
| `session($s)` | `session("s-01JB6Q…")` | Holder session; tokens are useless in another session |
| `root_id($r)` | `root_id(hex:4f2a…)` | Revocation handle |
| `right($kind, $resource, $op)` | `right("path", "src/proj", "read")` | One permission |
| `path_root($fdkey)` | `path_root("home:alice")` | Paths are relative to this broker-held directory |
| `net($host, $port, $proto, $method)` | `net("api.github.com", 443, "https", "GET")` | Network target; a host of the form `listen:<addr>` is a listening grant |
| `budget($unit, $amount)` | `budget("usd-micro", 5000000)` | Spending ceiling |
| `expires($time)` | `expires(2026-10-07T22:00:00Z)` | Expiry |
| `tier_floor($n)` | `tier_floor(3)` | Minimum confinement tier |
| `max_depth($n)` / `max_fanout($n)` | `max_depth(1)` | Delegation limits |
| `label_ceiling($conf)` | `label_ceiling("private")` | Highest confidentiality readable under this token |
| `persist($grantId)` | `persist("g-01JB…")` | Re-minted from a grant record |
| `captive($bool)` | `captive(true)` | Captive-portal token: valid only for the captive-browser VM while net reports a captive network; minted by `BrokerSystem.mintCaptive`, at most 10 minutes, `tier_floor(2)` |

Rights kinds: `path`, `net`, `device`, `secret`, `budget`, `spawn`, `service`, `effect`, `delegate`. Operations are the `Right` enum: `read`, `write`, `create`, `delete`, `exec`, `connect`, `bind`, `use`, `spend`, `spawn`, `stage`, `commit`, `delegate`.

## Narrowing (attenuation)

Any holder can append checks. The ambient facts available to checks are `time`, `operation`, `resource`, `path_under`, `host`, `port`, `method`, `depth`, `session_label`, `principal_kind` and `amount`.

```
// Only reads, only until 21:30, only GitHub with safe methods, no further delegation
check if time($t), $t <= 2026-10-07T21:30:00Z;
check if operation("path", $op), ["read"].contains($op);
check if resource("net", $r), host($h), ["api.github.com"].contains($h), method($m), ["GET","HEAD"].contains($m);
check if depth($d), $d <= 0;
```

Attenuation is offline. `Broker.attenuate` exists only for clients without a Biscuit library.

## Delegation is different from attenuation

Giving authority to a **child principal** goes through the broker: `Broker.delegate` for a spawned tool, and VM registration for VM principals (`VmSpawn.register`; a sub-agent VM is a `Vm.fork(ForkSpec{offered, checks, budgets})` whose checks and budgets the broker applies). The broker then:

1. checks that every child right is covered by the parent token;
2. mints the child's tokens as **new roots**, recording the parent root as ancestor;
3. **carves** budgets: the child's amount is reserved against the parent's meter in `gate` and refunded when the child ends;
4. enforces `max_depth` and `max_fanout`.

New roots give each child its own meter and make revocation cascade cleanly. Widening a child's scope after creation needs a T2 approval.

## From token to handle

Tokens are not authority by themselves. The kernel enforces handles, so a token must be **materialized**:

![Authority flow: request, decide, mint, materialize](../images/authority-flow.svg)

| Resource kind | Materialized as | By |
|---|---|---|
| File | Open fd (`openat2` with `RESOLVE_BENEATH|NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV` from a held root) | broker |
| Directory | Bind-mount into the holder's `/grants/<name>`, plus an fd opened inside the holder's namespace | broker + warden |
| Network | Connected socket through the egress proxy | gate |
| Device | Device fd | devd |
| Secret | `memfd_secret` fd for apps; never for agents (injection instead) | vault |
| Service | Connected capwire socket | warden |
| Spawn, effect, budget, delegate | Checked at the point of use; not materialized | warden, gate, broker |

## Revocation

- `Broker.revoke(rootId)` invalidates the root and every descendant within 50 ms.
- An fd that was already handed out cannot be recalled. So revocation also **kills or freezes** every session that held a revoked root: agents are killed, apps are frozen and the user decides ([ADR-0041](../11-decisions/adr-0041-revocation-kills-or-freezes.md)).
- Revocations survive a broker restart within a boot. A reboot rotates the key, which revokes everything.

## Limitations

- Biscuit verification costs about 50–150 µs. Services that check often (for example `gate`) cache `inspect` results for 5 s, keyed by token hash. Revocation invalidates the cache.
- Directory rights finer than read-only versus read-write (create-only, delete-only) depend on an extra Landlock layer that the holder must opt into (`restrictable: true`).

## Related

- [Cedar policy](cedar-policy.md)
- [Receipts](receipts.md)
- [Capabilities and the broker](../06-security/capabilities-and-broker.md)
- [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md)
- [broker spec](../../specs/broker/spec.md) · [protocols §8](../../specs/protocols/spec.md)
