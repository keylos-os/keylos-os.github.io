# Add an effect kind

> Effects are actions outside the machine that a non-human principal stages through gate: sending email, opening a pull request, creating a ticket. To add one you register a kind with its class, optionally a compensator, and a renderer that shows the human exactly what will happen.

**Status:** specified (v1.0). See [protocols §14](../../specs/protocols/spec.md), [gate](../../specs/gate/spec.md) and [sdk §4.7](../../specs/sdk/spec.md).

![Effect outbox](../images/effect-outbox.svg)

## 1. Pick the class honestly

| Class | Meaning | Approval |
|---|---|---|
| `reversible` | Has no lasting external result (or is undone automatically) | T1 |
| `compensable` | Can be undone by a registered compensating action | T2, batched |
| `irreversible` | Cannot be undone (sent, paid, published) | T3, with a mandate bound to the payload digest |

Classes can be raised by policy but never lowered. If you aren't sure, it is irreversible.

## 2. Name it

Custom kinds use the `x-` prefix and a reverse-DNS style: `x-com.acme.ticket.create`. The compensator is another kind: `x-com.acme.ticket.delete`.

## 3. Write a renderer

A renderer is a WASI component implementing `keylos:effects/renderer@1.0.0`. It turns the staged intent into what the approval prompt shows.

```sh
$ kl-sdk init effect-renderer ~/src/acme-ticket-renderer
```

```rust
impl Guest for Renderer {
    fn render(i: Intent) -> Result<Rendering, RenderError> {
        let req: TicketReq = serde_json::from_slice(&i.payload).map_err(|e| RenderError::Invalid(e.to_string()))?;
        Ok(Rendering {
            title: format!("Create ticket in {}", req.project),
            body: format!("**{}**\n\n{}\n\nAssignee: {}", req.summary, req.description, req.assignee),
            mime: "text/markdown".into(), attachment: None, reversible: true,
            warnings: i.args.iter().filter(|a| a.integ == 2).map(|a| format!("{} came from {}", a.name, a.source)).collect(),
        })
    }
}
```

Surface the provenance of untrusted arguments in `warnings`. That is the cue the human needs ("assignee came from a web page").

The rendering must present **every required review detail** of your kind (for a ticket: project, title, assignee, body). The prompt enables Approve only when the required renderings were presented completely; if your renderer crashes, times out or truncates, gate falls back to its canonical text view, and if that can't show everything either, the human can only deny or defer. A title alone never counts ([ADR-0064](../11-decisions/adr-0064-fail-closed-approval-rendering.md)). Your renderer can't mark its output as optional: only gate and broker set `review: decorative`.

```sh
$ kl-sdk test-renderer target/renderer.wasm fixtures/intent.json
```

## 4. Register the kind

Register it in the system configuration (gate's config module):

```nickel
{
  gate.effects."x-com.acme.ticket.create" = {
    class = 'compensable,
    compensator = "x-com.acme.ticket.delete",
    renderer = "com.acme.TicketRenderer@1.0.0",
    targets = ["https://acme.atlassian.net/rest/api/3/issue"],
  },
}
```

```sh
$ config propose ~/config && config apply      # T3 + presence
```

## 5. Declare it in apps and templates

```nickel
effects = [{ kind = "x-com.acme.ticket.create", class = 'compensable, compensator = "x-com.acme.ticket.delete" }],
```

Staging from code:

```rust
let intent = app.stage(Effect::new("x-com.acme.ticket.create")
    .class(EffectClass::Compensable)
    .target("https://acme.atlassian.net/rest/api/3/issue")
    .arg("summary", &summary, Source::User)
    .arg("assignee", &assignee, Source::Web(url))
    .idempotency_key(&key)
    .payload_json(&req)?)?;
let status = intent.commit_wait()?;       // waits for approval if needed
```

## 6. Test

Add a scenario with `approvals = [{ match_kind = "x-com.acme.ticket.create", decide = 'approve }]` and run `kl-sdk test`. The receipts must include `effect.stage` and `effect.commit`.

## Related

- [gate spec](../../specs/gate/spec.md)
- [sdk spec](../../specs/sdk/spec.md)
- [Write policy](write-policy.md)
- [ADR-0027 Effect outbox and mandates](../11-decisions/adr-0027-effect-outbox-and-mandates.md)
- [ADR-0028 Approval tiers](../11-decisions/adr-0028-approval-tiers.md)
