# Cedar policy

> Every authority decision in keylos is a Cedar evaluation over one fixed schema. Policy decides whether something is allowed and, with a `@tier` annotation, which approval it needs first.
> Policy is written by humans in the system configuration, compiled into a signed `policy` generation, and evaluated only by `broker`.

**Status:** specified (v1.0). Schema: [protocols §16](../../specs/protocols/spec.md). Evaluation: [broker §4.4](../../specs/broker/spec.md).

## Where policy comes from

![Config apply: source, compile, sign, activate](../images/config-apply.svg)

1. The owner edits the configuration repository. The broker module holds host tables, label rules and Cedar fragments.
2. `config` compiles it into a `policy` generation (`/policy/policies.cedar`, `hosts.json`, `labels.json`, `effects.json`, …) and checks it against the schema.
3. Applying the configuration needs owner presence: a FIDO2 touch signs the `keylos.configgen/1` statement.
4. `warden` mounts the new generation read-only at `/policy` and tells `broker` to reload. The broker verifies the statement against the owner registry and activates the policy atomically.

Agents can **propose** policy diffs. Only a human's touch activates them ([ADR-0029](../11-decisions/adr-0029-agents-propose-humans-sign.md)).

## The schema

| Entity | Key attributes | Built from |
|---|---|---|
| `Human` | `owner` | `hearth` user records |
| `Principal` (parent: `Human`) | `kind` (app, service, agent, legacy, bench, shell), `generationName`, `generation`, `tier`, `depth`, `label` | Capwire identity plus the broker's session table |
| `Path` | `root` (fdkey such as `home:alice`), `rel`, `labelConf`, `labelInteg` | Held root plus xattrs or location defaults |
| `Host` | `name`, `port`, `sinkSafe`, `trusted` | Policy host table |
| `Device` | `subsystem` | `devd` |
| `Secret` | `owner` | Vault item scope |
| `Effect` | `kind`, `class` | Effect registry |
| `Generation` | `name`, `publisher`, `reproducible` | `depot` |
| `Service` | `name`, `facet` | Routes |
| `Budget` | `unit` | Request |

| Actions | Apply to |
|---|---|
| `read`, `write`, `create`, `delete`, `exec` | `Path` |
| `connect`, `bind` | `Host` |
| `use` | `Device`, `Secret`, `Service` |
| `spend` | `Budget` |
| `spawn` | `Generation` |
| `stage`, `commit` | `Effect` |
| `delegate` | `Principal` |

The context carries `time`, `persist`, `durationSecs`, `reason`, `approvalTier`, and optionally `amount` (spending), `channel` (`local`, `phone` or `org`) and `approver` (the approver key ref of an org decision).

## Decisions and tiers

| Policy outcome | Result |
|---|---|
| Any matching `forbid` | Denied |
| A matching `permit` with no annotation | Allowed at T0/T1 (no prompt) |
| A matching `permit` annotated `@tier("t2")` | Allowed after a batched review on the trusted path |
| A matching `permit` annotated `@tier("t3")` | Allowed after a synchronous approval, with presence where required |
| `@presence("true")` | Presence (FIDO2 touch) required regardless of tier |
| `@orgApproval("<group>")` | Allowed after `OrgDecider.decide` for that approver group (fleet-enrolled machines only); the mandate is signed by an `approver/<id>` key |
| `@channels("local,phone")` | Approval channels allowed for that permit; default `local`. A phone or org approval never satisfies a presence requirement |
| No matching `permit` | Denied |

When several permits match with different annotations, the lowest annotated tier wins. The broker then applies **floors** that policy cannot lower:

| Condition | Floor |
|---|---|
| Committing an irreversible effect | T3 |
| Persisting a grant | T2 + presence |
| Agent connecting to a host it has no token for | T2 |
| Agent writing outside its workbench overlay | T3 |
| Agent using a secret | T2 |
| Capture devices (camera, microphone, raw HID, input) | T2 for apps, T3 for agents |
| Declassification (Rule of Two) | T3 |

On fleet-enrolled machines, org `forbid` policies are loaded into the same policy set and owner `permit`s cannot override them.

An optional **classifier** can raise the tier of a T0/T1 decision. It can never lower one ([ADR-0028](../11-decisions/adr-0028-approval-tiers.md)).

## Examples

```cedar
// Let my editor read and write my thesis folder without asking.
@id("editor-thesis")
permit (principal, action in [Keylos::Action::"read", Keylos::Action::"write", Keylos::Action::"create"], resource is Keylos::Path)
when { principal.generationName == "org.example.Editor" && resource.root like "home:alice" && resource.rel like "Documents/Thesis*" };

// Agents may open pull requests (compensable) after a batched review.
@id("agents-open-prs")
@tier("t2")
permit (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { principal.kind == "agent" && resource.kind == "git.pr.open" };

// Nothing tainted by untrusted input may talk to the payroll API.
@id("no-untrusted-payroll")
forbid (principal, action == Keylos::Action::"connect", resource is Keylos::Host)
when { resource.name == "payroll.example.com" && principal.label.integ == "untrusted" };
```

## Testing policy

`grants policy check` evaluates a single request against the active policy. `grants policy test <dir>` runs `*.cedartest.json` cases against a candidate policy before you apply it:

```json
{"principal":{"kind":"agent","generationName":"io.keylos.agents.coder","depth":0,"label":{"conf":"private","integ":"untrusted"}},
 "action":"connect","resource":{"type":"Host","name":"api.github.com","port":443,"sinkSafe":false,"trusted":false},
 "context":{"persist":false,"durationSecs":1800},
 "expect":{"decision":"permit","tier":"t2"}}
```

`config` runs the owner's policy tests automatically before it asks for the presence touch.

## The default policy set

Without owner policy, keylos runs the broker's compiled-in defaults ([broker §10.3](../../specs/broker/spec.md)):

- Shells may act within their own home.
- Apps silently use only their own data. Other paths come through the powerbox, or need T2.
- New hosts for apps and agents need T2.
- Agents read project grants silently. They can stage effects. Committing needs T3, or T2 for compensable effects.
- Agents never read `secret`-labelled files. Legacy principals never spawn.

## Limitations

- Cedar sees labels as they were **at decision time**. Data read later through an attached directory is covered by the directory's label ceiling, not by per-file decisions.
- The schema is fixed by protocols 1.0. New entity attributes need a protocols minor version.

## Related

- [Capability tokens](tokens.md)
- [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md)
- [Capabilities and the broker](../06-security/capabilities-and-broker.md)
- [ADR-0006 Cedar policy](../11-decisions/adr-0006-cedar-policy.md)
- [broker spec](../../specs/broker/spec.md) · [protocols §16](../../specs/protocols/spec.md#16-cedar-policy-schema)
