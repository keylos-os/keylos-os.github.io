# Sessions and workbenches

> Every agent session runs in a tier-3 workbench: a crosvm microVM with its own kernel, started from a warm snapshot in about a second. The project is a copy-on-write overlay, so the agent can do anything to its copy and nothing to yours until you merge.
> This page covers the session lifecycle, placement, forks, sub-agents and the velocity breakers that stop runaway sessions.

**Status:** specified (v1.0). Components: [aide](../../specs/aide/spec.md), [bench](../../specs/bench/spec.md).

## Why a VM

The host executes only sealed code (the `kl-exec` BPF LSM). Agents write and run code constantly: builds, tests, scripts, `pip install`. That code is unsealed by definition, so it runs only behind a guest kernel. A kernel bug reachable from agent-run code compromises a disposable VM, not the machine.

| Property | Value |
|---|---|
| VMM | crosvm (one VMM for workbenches and tier-2 apps) |
| Start | ~100–300 ms from a warm snapshot of the bench-image; session ready ≤ 1.5 s p50 |
| Default size | 4 vCPU, 8 GiB, GPU off. Template-defined, capped by config. |
| Network | One virtio-net NIC, terminated on the host by `bench-net`: every guest flow becomes a `ShimEndpoint.connect` on gate, checked against the session's tokens. No tap device, no host network namespace. |
| Files | virtio-fs shares served by bench; labels raised on open |

## Lifecycle

```
Provisioning → Running ⇄ Paused → Reviewing → Merged / Discarded → Stopped
                  ↑ (per-call "waiting" for approvals; the session keeps working)
```

| State | Meaning |
|---|---|
| Provisioning | Template verified, tokens delegated, VM starting, guest connecting |
| Running | The harness is working. Tool calls that need approval wait individually. |
| Paused | Breaker trip, budget exhaustion, or human pause. The VM is frozen to a snapshot. |
| Reviewing | Merge intents staged; the human is looking at the diff |
| Merged / Discarded | The overlay was merged into the real tree, or thrown away |
| Stopped | VM stopped, tokens revoked, session key deleted. The overlay is kept until retention expiry (14 days default). |

aide persists session records. An aide restart does not stop VMs, and the guest agent reconnects.

## Placement

```
 Share "project"  ← the directory the human typed   (writable, overlay)
 Share "<name>"   ← read-only directory grants        (read-only)
 Share "agent"    ← the template's /agent directory    (read-only)
 Share "keylos-ca"← session CA, if gate intercepts     (read-only)
 virtio-net        → bench-net → gate ShimEndpoint (egress, DNS, SSH agent)
 vsock 1024        → bench control (benchd)
 vsock 7002        → aide AgentHost (host tools, model, events), agent VMs only
```

Inside the guest, `aide-guest` bootstraps the session:
1. git identity, commit trailers and signing through the shim's SSH agent;
2. proxy settings;
3. starting local MCP servers from their pinned generations;
4. launching the harness.

## Overlays and merging

The project share is an overlay. Writes land in the session's upper layer. Your tree is untouched.

- `aide changes <s>` shows a per-share summary at any time.
- `aide review <s>` calls `BenchMerge.manifest`, which freezes a snapshot of the share's overlay, has strata prepare an immutable merge result against the live tree, and returns that prepared merge's `keylos.fsmerge/2` manifest (paths, kinds, expected live state and resulting digests, sorted by path) and its digest. aide stages an `fs.merge` intent through gate with that digest as the payload digest. Agent merges are **T3**: the trusted-path prompt shows the diff, the session's label history, the effects already committed, and the spend.
- When you approve with a touch, gate's executor calls `BenchMerge.commitShare` with the manifest digest and the mandate. strata commits exactly that prepared merge: it verifies the mandate binds the digest, freezes concurrent writers, re-checks the live state and applies only the stored operations. Later agent writes are never included; if the live tree changed, the merge is refused and needs a new review.
- `aide undo <s>` compensates the merge (strata undo snapshot).

If your tree changed during the session, conflicting files are listed and not merged. You can merge the rest or resolve in a workbench.

## Forks

`aide fork <s>` creates a sibling session from a VM fork:
- same template;
- same overlay state (copy-on-write);
- fresh tokens delegated from the same parent;
- a new session key.

Use forks to try two approaches, or to give unrelated follow-up work a clean label.

## Sub-agents

The host tool `keylos.subagent.spawn` creates a child session.

| Rule | Effect |
|---|---|
| Delegation from the calling session | A child can never exceed its parent |
| `max_depth` decremented | Depth 0 cannot spawn |
| `max_fanout` | At most N live children per session |
| Template allowlist | Default: the parent's own template only |
| Budget carved from the parent's remaining budget | Spending is charged to the child and every ancestor ([Budgets](budgets.md)) |
| Child overlays merge into the parent's overlay | No T3 needed. Only the root session's review merges into your tree. |

## Velocity breakers

aide pauses a session subtree when it looks runaway:

| Breaker | Default |
|---|---|
| Same tool and arguments | > 5 per minute |
| Tool calls | > 600 per hour |
| Errors in a row | > 20 |
| Spend | > 10% of the budget per minute |
| Context growth | > 2 MB per model call |
| Sub-agent spawns | > `max_fanout` per 10 min |
| Deadline | `--deadline` |

A trip pauses the subtree and sends a notification. Resume with `aide resume` or by sending a message.

## Queueing and agent desktops

- **RAM classes.** On a `small` machine (under 12 GiB) at most 2 VMs run at once, 6 on `medium`, 16 on `large`. When the cap is reached, aide queues new sessions instead of failing them.
- **Agent desktops.** Templates with `vm.desktop: true` start a VM with `purpose: agentDesktop` and a nested atrium, for agents that operate GUIs ([Computer use](computer-use.md)).
- **Session chain.** aide passes `VmSpec.session` and `parentSession`, so the VM principal is `agent:<template>@<human>/<…>/<session>` and delegation stays attenuation-only.

## Running a session

```bash
aide start io.keylos.agent.coder --project ~/src/app \
  --task "Fix the flaky test in tests/net.rs" \
  --grant net:crates.io:443:https:GET,HEAD --grant net:static.crates.io:443:https:GET \
  --budget usd-micro:3000000 --deadline 2h --attach
aide changes s-01JB…
aide review s-01JB…      # trusted-path diff, approve with a touch
```

## Limitations

- GPU-heavy local models need a GPU with virtio-gpu native-context support (AMD today; Intel newer). Otherwise use remote models.
- Workbench I/O-heavy builds pay a virtio-fs overhead, typically 5–30% versus native.
- Live databases inside overlays (SQLite WAL, for example) are merged as files. Merging a database that is open in your tree is refused.

## Related

- [Computer use](computer-use.md)

- [Agent principal](agent-principal.md)
- [Effects and the outbox](effects-and-outbox.md)
- [Budgets](budgets.md)
- [bench specification](../../specs/bench/spec.md)
- [ADR-0009 Unsealed code in workbenches](../11-decisions/adr-0009-unsealed-code-in-workbenches.md)
- [ADR-0010 crosvm as the single VMM](../11-decisions/adr-0010-crosvm-single-vmm.md)
