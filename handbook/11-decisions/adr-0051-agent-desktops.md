# ADR-0051: GUI-operating agents use their own desktop in a VM

> Agents never capture the screen, read the accessibility tree, inject input or read another principal's clipboard on a human's real session. A computer-use agent gets an **agent desktop**: a tier-3 VM running a nested atrium and the apps it needs, driven through `AgentDesktop`. The human can watch a read-only mirror and take over at any time.

| Status | Date | Area | Affects |
|---|---|---|---|
| Accepted | 2026-10-08 | Agents | aide, bench, atrium, portals, broker, protocols |

## Context

- Computer-use agents operate GUIs through screenshots and synthetic input. On a real desktop, that combination is total authority:
  - the agent sees everything on screen (passwords, messages, documents);
  - it can click any button, including approval dialogs not protected by a trusted path;
  - it can be steered by anything displayed, such as a web page containing instructions.
- Prompt injection through displayed content is the computer-use form of the "lethal trifecta" ([Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)). Browser agents have been steered by on-page content to exfiltrate data ([Brave on Comet](https://brave.com/blog/comet-prompt-injection/)).
- Input injection and screen capture are exactly what Wayland denies to ordinary clients ([ADR-0034](adr-0034-wayland-only-trusted-path.md)). An exception for agents would reopen the holes.

## Decision

- **Real-session prohibition** ([protocols §14.5](../../specs/protocols/spec.md#145-operating-rules)): no `ScreenCapture`, `Accessibility.observe`, `A11yGate`, `GlobalShortcuts` or input injection for agents, and no clipboard access to another principal's data.
- **Agent desktops.** A template with `vm.desktop: true` starts a VM with `purpose: agentDesktop`, running a nested atrium and the needed apps.
  - The agent drives it through `AgentDesktop` (`screenshot`, `input`, `a11yTree`, `launch`, `status`).
  - Files enter only through shares and leave only through effects ([gate](../../specs/gate/spec.md)).
- **Human oversight.** The host shows a read-only mirror (`displayMode: readOnly`). `Vm.takeOver(true)` switches it to interactive and refuses agent input until it is handed back.
- **Single-shot observation.** A real-session window can be shown to an agent only through a separate T3 grant, `screen.window.snapshot`: one window, one still image per approval, never continuous.

## Alternatives considered

| Option | Why not |
|---|---|
| Screen capture plus input on the real session behind a prompt | One approval grants total authority for the session; users approve prompts habitually |
| A separate Wayland session on the host | Shares the host kernel, user data and clipboard paths; files are reachable |
| Accessibility API only (no pixels) | Still exposes all on-screen text of the real session; still allows actions |
| Forbid computer-use agents | Useful work needs GUIs (legacy apps, web flows without APIs) |

## Consequences

### Positive
- What the agent can see and touch is exactly what was put in its desktop.
- Effects still pass through gate with labels, the Rule of Two and mandates.
- The human can intervene instantly with take-over; agent input stops while the human drives.

### Negative
- Apps the agent needs must run inside the VM. Host apps, logged-in host sessions and host browser profiles are unavailable unless deliberately shared.
- The agent desktop counts against the RAM-class VM cap ([protocols §2.3](../../specs/protocols/spec.md#23-resource-classes)).

## Related

- [Computer use](../07-agents/computer-use.md)
- [Sessions and workbenches](../07-agents/sessions-and-workbenches.md)
- [Trusted path](../06-security/trusted-path.md)
- [ADR-0026: Labels and the Rule of Two](adr-0026-labels-and-rule-of-two.md)
