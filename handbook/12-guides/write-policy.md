# Write policy

> Policy decides which principals may do what, and at which approval tier. It is Cedar, kept in your configuration repository, compiled into a signed `policy` generation and evaluated by broker on every request. Humans write policy; agents may only propose diffs.

**Status:** specified (v1.0). Schema in [protocols §16](../../specs/protocols/spec.md); evaluation in [broker](../../specs/broker/spec.md).

![Authority flow](../images/authority-flow.svg)

## How decisions map to tiers

| Cedar result | Outcome |
|---|---|
| A matching `forbid` | Denied (forbid always wins) |
| A matching `permit` with `@tier("t3")` | Allowed after a synchronous trusted-path approval |
| A matching `permit` with `@tier("t2")` | Allowed after a batched review |
| A matching `permit` without annotation | Allowed (T0/T1) |
| No matching `permit` | Denied |

Labels and the Rule of Two are checked **in addition** to Cedar. A permit cannot override them.

## The schema in one glance

- **Principal:** `Keylos::Principal` with `kind`, `generationName`, `tier`, `depth` and `label`.
- **Resources:** `Path`, `Host`, `Device`, `Secret`, `Effect`, `Generation`, `Service`, `Budget`.
- **Actions:** `read`, `write`, `create`, `delete`, `exec`, `connect`, `bind`, `use`, `spend`, `spawn`, `stage`, `commit`, `delegate`.
- **Context:** `time`, `persist`, `durationSecs`, `reason`, `approvalTier`, `amount`.

## Examples

**Let the notes app sync, silently:**

```cedar
permit (principal, action == Keylos::Action::"connect", resource is Keylos::Host)
when { principal.generationName == "org.example.Notes" && resource.name == "sync.example.org" && resource.port == 443 };
```

**Agents may read anything in a project, but only through their overlay:**

```cedar
permit (principal, action == Keylos::Action::"read", resource is Keylos::Path)
when { principal.kind == "agent" && resource.root == "project" };
```

**Every email sent by an agent needs a synchronous approval; payments are forbidden for agents:**

```cedar
@tier("t3")
permit (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { principal.kind == "agent" && resource.kind == "email.send" };

forbid (principal, action == Keylos::Action::"commit", resource is Keylos::Effect)
when { principal.kind == "agent" && resource.kind == "payment.authorize" };
```

**Sub-agents cannot delegate further than one level:**

```cedar
forbid (principal, action == Keylos::Action::"delegate", resource)
when { principal.depth >= 2 };
```

**Spending caps:**

```cedar
@tier("t3")
permit (principal, action == Keylos::Action::"spend", resource is Keylos::Budget)
when { resource.unit == "usd-micro" && context has amount && context.amount > 5000000 };
```

## Where policy lives

```
config/
  policy/
    apps.cedar
    agents.cedar
    devices.cedar
  policy.ncl          # which files are active, plus tier floors per generation name
```

```nickel
{
  policy = {
    files = ["policy/apps.cedar", "policy/agents.cedar", "policy/devices.cedar"],
    tier_floors = { "com.vendor.ClosedApp" = 2 },      # raise only, never lower
  },
}
```

## Apply

```sh
$ config propose ~/config     # validates against the schema, shows a decision diff on sample requests
$ config apply                # T3 + presence; a new policy generation is signed and loaded by broker
```

The plan shows **what changes in practice**, for example "agent principals: email.send moves from denied to T3". It also flags permits that widen authority.

## Testing policy

Put sample requests in `policy/tests/*.json` (principal, action, resource, context, expected decision and tier). `config propose` runs them and fails on any mismatch. The protocols `cedar/` conformance vectors use the same format.

## Agents and policy

An agent may produce a policy diff as a **proposal**; it can never apply one. You review it like any other T3 config change, with presence.

## Related

- [broker spec](../../specs/broker/spec.md)
- [config spec](../../specs/config/spec.md)
- [Write an agent template](write-an-agent-template.md)
- [ADR-0006 Cedar policy](../11-decisions/adr-0006-cedar-policy.md)
- [ADR-0028 Approval tiers](../11-decisions/adr-0028-approval-tiers.md)
- [ADR-0026 Labels and the Rule of Two](../11-decisions/adr-0026-labels-and-rule-of-two.md)
