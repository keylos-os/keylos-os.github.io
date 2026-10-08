# keylos engineering handbook

> keylos is a Linux userland where every program, service and AI agent holds only the authority it was handed. Every change can be undone or leaves a signed receipt, and a reboot puts the machine back on verified code.
> This handbook explains how the system is designed and why. It covers how its 31 repositories fit together and how to build on it. The normative detail lives in each repository's `spec.md`.

## What keylos is

keylos keeps the upstream Linux kernel and replaces everything above it. It is built on three primitives:

| Primitive | In one sentence |
|---|---|
| **A sealed, content-addressed store** | Every file the host executes is an fs-verity object, committed to by a signed 32-byte generation digest, so the kernel checks every page it runs. |
| **Capabilities as the only authority** | A process starts with nothing. Files, sockets, devices, secrets, money and the right to cause external effects arrive as handles from the broker, scoped by Biscuit tokens and Cedar policy. |
| **Signed, versioned state transactions** | System, configuration and data changes are generations or transactions. They can be inspected, undone or signed, and each one writes a receipt to the ledger. |

Humans, applications, services and **AI agents** are all distinct principals:

- **Unsealed code** runs only in disposable crosvm microVM workbenches. That covers dev builds, downloaded binaries and everything an agent writes.
- **Irreversible effects** (sending email, paying, publishing, force-pushing) are staged in an outbox, rendered for the owner, and run only with a signed mandate.
- **Persistent change to the system** (configuration, sealing code for the host, policy) needs the owner's touch on a FIDO2 key.

The result is the property the design is built around:

> **Reboot heals.** Reboot restores verified code and owner-approved configuration. Writable state may still contain hostile data and may require quarantine or recovery. Short of a kernel or firmware exploit, no code planted by a userspace compromise runs again after a reboot.

![System context](images/system-context.svg)

## How to read this handbook

| If you want to… | Start with |
|---|---|
| Understand the idea and why it is worth building | [Vision](01-overview/vision.md) → [Principles](01-overview/principles.md) → [Threat model](01-overview/threat-model.md) |
| See the shape of the system | [Architecture](02-architecture/README.md) → [System context and layers](02-architecture/system-context-and-layers.md) → [Dependency rules](02-architecture/dependency-rules.md) |
| Follow one request end to end | [Authority flow](02-architecture/authority-flow.md), [Agent session flow](02-architecture/agent-session-flow.md) |
| Find what a repository does | [Components](03-components/README.md) and the [repository catalogue](13-reference/repo-catalogue.md) |
| Implement a component | The repository's `spec.md` (for example [protocols](../specs/protocols/spec.md)) plus [Contracts](04-contracts/README.md) |
| Understand the integrity chain | [Integrity](05-integrity/README.md) |
| Understand authority and confinement | [Security](06-security/README.md) |
| Run agents safely | [Agents](07-agents/README.md) |
| Know why something is the way it is | [Decisions](11-decisions/README.md) |
| Look up a name, path or term | [Reference](13-reference/README.md) |

## Sections

| Section | Contents |
|---|---|
| [01 Overview](01-overview/README.md) | Vision, principles, threat model, quality attributes, profiles and hardware |
| [02 Architecture](02-architecture/README.md) | System context and layers, dependency rules, process tree and tiers, boot to desktop, authority flow, agent session flow |
| [03 Components](03-components/README.md) | One page per repository: role, interfaces, tier, key decisions, link to its spec |
| [04 Contracts](04-contracts/README.md) | capwire, identifiers, signed documents, manifest, tokens, Cedar policy, receipts, command signatures and pipes, versioning |
| [05 Integrity](05-integrity/README.md) | Boot chain, exec integrity and sealing, reboot heals, supply chain, transparency and rebuilders, attestation and vouch |
| [06 Security](06-security/README.md) | Principals, capabilities and the broker, confinement tiers, namespaces, labels and the Rule of Two, secrets, network egress, trusted path, residual risks |
| [07 Agents](07-agents/README.md) | The agent principal, sessions and workbenches, effects and the outbox, approvals, budgets, tools and MCP, harness API |
| [08 State](08-state/README.md) | Filesystem layout, snapshots and transactions, config generations, crypto-shredding, provenance, backup and sync, users and homes |
| [09 Experience](09-experience/README.md) | Shell, desktop, portals and the powerbox, accessibility and i18n, developer workbench, legacy apps |
| [10 Operations](10-operations/README.md) | Install and enrolment, updates and rollback, recovery, key ceremonies, fleet, observability, runbooks |
| [11 Decisions](11-decisions/README.md) | Architecture decision records ADR-0001 to ADR-0068 |
| [12 Guides](12-guides/README.md) | Package an app, write a service, write an agent template, seal a tool, port a legacy app, add an effect kind, write policy |
| [13 Reference](13-reference/README.md) | Repository catalogue, glossary, names, paths and identifiers, kernel configuration, diagrams, sources, status |

## The workspace

The handbook sits next to the repositories it describes:

```
keylos/
  README.md            repository index
  docs/                this handbook
  protocols/spec.md    shared contracts (every other spec embeds what it uses from here)
  warden/spec.md       …one directory per repository of the keylos organisation
```

The [repository index](13-reference/repo-catalogue.md) lists all 31 repositories. [protocols](../specs/protocols/spec.md) is the only coupling between them: identifiers, the capwire IPC protocol and every interface schema, signed document formats, the token vocabulary, the policy schema, labels and effects, and the filesystem layout.

## Status

Every component is **specified (v1.0)**. The specs are written to be implemented in full, independently and in parallel. There is no "phase 1": optional behaviour is specified as optional, and every spec closes with testable acceptance criteria. See [Status](13-reference/status.md).

## Viewing this handbook

The Markdown renders anywhere. For navigation, search and working links into the repository specs, serve the workspace root:

```bash
cd docs
make serve      # then open http://localhost:8000/docs/
make diagrams   # regenerate images/*.svg from scripts/diagrams.py
make check      # titles, links, anchors, images and wording
```

See [Contributing to the handbook](CONTRIBUTING.md) for the writing and diagram conventions.

## Related

- [Repository index](13-reference/repo-catalogue.md)
- [protocols spec](../specs/protocols/spec.md)
- [Glossary](13-reference/glossary.md)
- [Diagram gallery](13-reference/diagrams.md)
