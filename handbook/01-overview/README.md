# Overview

> What keylos is, what problem it solves, the principles every repository follows, the threats it is designed against and the quality budgets it must meet.
> Read this section before any other. Every later section assumes its vocabulary.

## Pages

| Page | Contents |
|---|---|
| [Vision](vision.md) | The problem (1970s authority model, 2026 actors), why now, what keylos is and is not, the one-line pitch |
| [Principles](principles.md) | Architecture, security and engineering principles with their rationale and decision records |
| [Threat model](threat-model.md) | Attackers T1–T7, assets, trust boundaries, what is in and out of scope, and the control that answers each threat |
| [Quality attributes](quality-attributes.md) | Concrete budgets: boot, unlock, launch, workbench start, approval latency, update size, memory and battery overhead, recovery |
| [Profiles and hardware](profiles-and-hardware.md) | Profiles (desktop, laptop, server, server-k8s, cloud, kiosk, appliance), integrity profiles, RAM classes, supported hardware |

## keylos in five sentences

1. The host executes only code whose bytes are committed to by a signed root, so a reboot returns the machine to verified code.
2. No process has ambient authority. Every file, socket, device, secret, budget and effect is a handle granted by the broker and recorded in the ledger.
3. Unsealed code (developer builds, downloads, anything an AI agent writes) runs only in disposable microVM workbenches.
4. Changes to the system are signed transactions that need the owner's touch. Changes to data are snapshots and transactions that can be undone. Effects on the outside world are staged and rendered before they happen.
5. AI agents are principals like any other, with delegated, attenuated, budgeted, time-limited authority, information-flow labels and a receipt for everything they do.

## Related

- [Architecture](../02-architecture/README.md)
- [Decisions](../11-decisions/README.md)
- [Glossary](../13-reference/glossary.md)
