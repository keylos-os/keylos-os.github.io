# Diagrams

> Every diagram in the handbook, in one gallery. All are generated deterministically by `scripts/diagrams.py` (`make diagrams`).
> Static diagrams show structure; sequence diagrams use the method names of the protocols schemas.

## Structure

### System context

![System context](../images/system-context.svg)

Used in: [Handbook landing page](../README.md), [System context and layers](../02-architecture/system-context-and-layers.md).

### Layers and components

![Layers and components](../images/layers-and-components.svg)

Used in: [Architecture](../02-architecture/README.md).

### Repository dependencies

![Repository dependencies](../images/repo-dependencies.svg)

Used in: [Dependency rules](../02-architecture/dependency-rules.md).

### Process tree and tiers

![Process tree and tiers](../images/process-tree-and-tiers.svg)

Used in: [Process tree and tiers](../02-architecture/process-tree-and-tiers.md).

### Confinement stack

![Confinement stack](../images/confinement-stack.svg)

Used in: [Confinement tiers](../06-security/confinement-tiers.md).

### Store and composefs

![Store and composefs](../images/store-composefs.svg)

Used in: [Exec integrity and sealing](../05-integrity/exec-integrity-and-sealing.md), [Supply chain](../05-integrity/supply-chain.md).

### Labels and the Rule of Two

![Labels and the Rule of Two](../images/labels-rule-of-two.svg)

Used in: [Labels and the Rule of Two](../06-security/labels-and-rule-of-two.md).

## Chains

### Boot chain

![Boot chain](../images/boot-chain.svg)

Used in: [Boot chain](../05-integrity/boot-chain.md).

### Supply chain

![Supply chain](../images/supply-chain.svg)

Used in: [Supply chain](../05-integrity/supply-chain.md).

## Flows

### Authority flow

![Authority flow](../images/authority-flow.svg)

Used in: [Authority flow](../02-architecture/authority-flow.md).

### Powerbox

![Powerbox](../images/powerbox.svg)

Used in: [Portals and the powerbox](../09-experience/portals-and-powerbox.md).

### Agent session

![Agent session](../images/agent-session.svg)

Used in: [Agent session flow](../02-architecture/agent-session-flow.md).

### Effect outbox

![Effect outbox](../images/effect-outbox.svg)

Used in: [Effects and the outbox](../07-agents/effects-and-outbox.md).

### Durable workflow

![Durable workflow](../images/durable-workflow.svg)

Used in: [Durable workflows](../08-state/durable-workflows.md).

### Config apply

![Config apply](../images/config-apply.svg)

Used in: [Config generations](../08-state/config-generations.md).

### Transactions: try, commit, undo

![Transactions](../images/transaction-try.svg)

Used in: [Snapshots and transactions](../08-state/snapshots-and-transactions.md).

### Verify before unlock

![Verify before unlock](../images/verify-before-unlock.svg)

Used in: [Attestation and vouch](../05-integrity/attestation-and-vouch.md).

### Update flow

![Update flow](../images/update-flow.svg)

Used in: [Updates and rollback](../10-operations/updates-and-rollback.md).

### Cluster node

![Cluster node](../images/cluster-node.svg)

Used in: [Kubernetes nodes](../10-operations/kubernetes.md).

### Removable media

![Removable media](../images/media-bench.svg)

Used in: [Devices and media](../06-security/devices-and-media.md).

## Related

- [Contributing: diagrams](../CONTRIBUTING.md#diagrams)
- [Reference](README.md)
