# Computer use

> Agents that operate graphical apps never touch the human's real desktop. They get an **agent desktop**: a tier-3 VM with a nested atrium and the apps they need, driven through `AgentDesktop`. The human watches a read-only mirror and can take over at any moment. Everything the agent produces still leaves through `gate` as effects.
> Status: **specified (v1.0)**. Normative: [protocols §14.5](../../specs/protocols/spec.md#145-operating-rules), [§7.5.13](../../specs/protocols/spec.md#7513-aide-syscapnp), [aide](../../specs/aide/spec.md), [bench](../../specs/bench/spec.md).

## What an agent can never do on your session

| Capability | Why it is excluded |
|---|---|
| Screen capture (`ScreenCapture`) | Everything on screen, including secrets, becomes agent input |
| Accessibility tree (`Accessibility.observe`, `A11yGate`) | Same content as pixels, in text form |
| Input injection, global shortcuts | The agent could click approval dialogs or type into any app |
| Clipboard of another principal | A common place for passwords and copied documents |

These are denied by construction: no facet hands them to an agent principal, whatever the policy says.

## Agent desktops

A template enables computer use with `vm.desktop: true`:

```json
{"agent": {"vm": {"vcpus": 4, "memoryMiB": 6144, "gpu": false, "desktop": true}, "…": "…"}}
```

| Aspect | Behaviour |
|---|---|
| VM | `VmSpec.purpose = agentDesktop`, a bench-image with a nested atrium and the apps the template lists |
| Driving | `AgentDesktop.screenshot`, `input`, `a11yTree`, `launch`, `status` (served by bench to aide, by aide to the harness) |
| Files | Enter only through shares from the session's grants; leave only through effects (`fs.merge`, uploads through gate) |
| Network | The VM's bench-net, subject to the session's grants, labels and the Rule of Two |
| Watching | atrium shows a mirror window with `displayMode: readOnly`, framed as the agent principal |
| Take over | "Take over" calls `Vm.takeOver(true)`; agent input is refused (`status.takenOver = true`) until handed back |

## Showing the agent one real window

Sometimes the human wants an agent to look at something on the real desktop. That is a separate T3 grant, `screen.window.snapshot`: the human picks one window on the trusted path, and the agent receives one still image. There is no continuous capture and no input path back.

## Flow

```
human: agent start --template web-operator --task "file the expense report in the legacy portal"
aide  → bench.start(purpose agentDesktop) → nested atrium + browser in the VM
agent → AgentDesktop.screenshot / input …          (only the VM's pixels)
agent → gate: POST to expenses.example.com         (granted host; payload staged as http.post intent)
human ← trusted path: rendered intent (form fields, amount) → approve (T3)
```

## Limitations

- Host sessions, host browser profiles and logged-in host apps aren't available to the agent unless deliberately shared.
- An agent desktop counts against the machine's VM cap (RAM class).
- Visual grounding errors still happen inside the VM; staging and approvals are the safeguard against their effects.

## Related

- [Sessions and workbenches](sessions-and-workbenches.md)
- [Effects and the outbox](effects-and-outbox.md)
- [Approvals](approvals.md)
- [Trusted path](../06-security/trusted-path.md)
- [ADR-0051: Agent desktops](../11-decisions/adr-0051-agent-desktops.md)
