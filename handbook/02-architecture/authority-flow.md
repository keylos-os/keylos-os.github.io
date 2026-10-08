# Authority flow

> How a principal gets authority: a request is decided by Cedar policy, approved on the trusted path if the policy says so, minted as a Biscuit token, and materialized into a file descriptor.
> The worked example follows an editor asking to read a project directory.

![Authority flow](../images/authority-flow.svg)

## The five steps

| Step | Call | Who decides | Result |
|---|---|---|---|
| 1. Request | `Broker.request(GrantRequest)` | — | A request with resource, rights, reason, duration and persistence |
| 2. Decide | Cedar `is_authorized(principal, action, resource, context)` | Policy generation, authored by humans | `deny`, `permit` (T0/T1), or `permit @tier("t2"/"t3")` |
| 3. Approve | `TrustedPrompt.approve(ApprovalPrompt)` (atrium facet `approve`); `@orgApproval` permits also go to `OrgDecider.decide`, `@channels` may route to the phone | The owner, on atrium's trusted path | `Decision{approved, scope, mandate}`; the requester reads the mandate from `Approval.mandate` (gate, acting for a staging session, from `BrokerSystem.requestFor`'s `GrantResult`) |
| 4. Mint | Biscuit authority block (protocols §8.2) | broker | A token with `right`, `expires`, `root_id`, `tier_floor`, `label_ceiling` |
| 5. Materialize | `Broker.materialize(token, resource, rights)` | broker (token check + revocation + label) | An fd, a socket or a service capability, delivered by `SCM_RIGHTS` |

Every step writes a receipt: `approval.request`, `approval.decide`, `grant.issue` and, on use, a label raise if one happened (see [protocols §19.3](../../specs/protocols/spec.md#193-receipt-events)).

## Worked example: an editor opens a project

An editor (`app:gen:fsv256:…@alice/s-01JB…`) wants read and write access to `~/src/keylos`. Its manifest declares no filesystem access, as is normal, so it asks:

```text
Broker.request(GrantRequest{
  resource: path "/home/alice/src/keylos",
  rights:   [read, write, create, delete],
  reason:   "Open folder keylos",
  durationSecs: 0,          # policy default
  persist:  true
})
```

broker evaluates the Cedar request. The context records the reason, the requested duration and persistence, and the session's approval-tier history:

```cedar
// keylos default policy, desktop profile (excerpt)
@tier("t2")
permit (principal is Keylos::Principal, action in [Keylos::Action::"read", Keylos::Action::"write",
        Keylos::Action::"create", Keylos::Action::"delete"], resource is Keylos::Path)
when { principal.kind == "app" && resource.root == "home" && context.persist };

forbid (principal, action, resource is Keylos::Path)
when { resource.rel like ".ssh*" || resource.rel like ".gnupg*" };
```

The decision is "permit after T2 approval", so broker sends a prompt to atrium. Because the editor named a path, the prompt renders it, with the generation name, publisher and tier:

```text
Editor (org.example.Editor 2.5.0, publisher example.org, tier 1)
wants to read and change:  ~/src/keylos   (keep access: yes)
[ Allow ]  [ Allow this time ]  [ Deny ]
```

Most of the time this step is unnecessary. Had the editor used `Broker.powerbox(openDirectory)`, the user's own pick in the trusted chooser *is* the grant, and no extra prompt appears (see [Powerbox](../09-experience/portals-and-powerbox.md)).

After approval, broker mints a token. The authority block, in protocols §8.2 vocabulary:

```datalog
principal("app:gen:fsv256:…@alice/s-01JB…");
session("s-01JB…");
root_id(hex:7f3c…);
path_root("home:alice");
right("path", "src/keylos", "read");   right("path", "src/keylos", "write");
right("path", "src/keylos", "create"); right("path", "src/keylos", "delete");
tier_floor(1);
persist("g-01JB…");
```

broker records a grant record, so the token can be re-minted after a reboot (tokens never outlive a boot), and appends `grant.issue` to the ledger.

The editor then materializes it:

```text
Broker.materialize(token, path "/home/alice/src/keylos", [read, write]) -> Handle.fd
```

broker:

1. verifies the token signature and the authorizer checks against ambient facts (`time`, `operation`, `resource`, `path_under`);
2. checks the revocation list for `root_id`;
3. resolves the directory itself, with `openat2(home_root_fd, "src/keylos", O_PATH|O_DIRECTORY, RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)`;
4. asks warden to attach that directory (`GrantMounts.attachGrant`, warden facet `broker`) as an idmapped bind mount at `/grants/<grant-id>` inside the editor's mount namespace, read-only or read-write to match the rights;
5. opens the `O_PATH` dirfd *through that mount*;
6. raises the editor session's label to the directory's label (`private/user`);
7. returns the dirfd over capwire with `SCM_RIGHTS`.

Step 4 is what makes dynamic grants compatible with Landlock. A process's Landlock domain is fixed when warden spawns it and can only ever be narrowed. The domain allows the process's view, including the `/grants` directory. Landlock evaluates every path walk against the ancestors of the file, across mount points, so anything mounted under `/grants` later is covered, while the rest of `/home` does not exist in the editor's view at all. A dirfd opened outside the view would be refused by Landlock on the first `openat`. Single files need no mount: operations on an already-open file descriptor are not path walks.

## Why each step exists

| Step | If it were missing |
|---|---|
| Policy outside the requester | The requester could decide its own authority |
| Approval on a trusted path | Any app could draw a fake prompt, or flood the user |
| Tokens rather than ACL entries | Delegation would need the broker online for every hop; attenuation would not be offline-verifiable |
| Materialize by broker | The app would resolve the path itself, which is where symlink and rename races live |
| Receipts | Nobody could reconstruct who granted what to whom |

## Delegation and attenuation

A principal can narrow a token offline with `Broker.attenuate`, or hand narrowed tokens to a child with `Broker.delegate`. Attenuation blocks are Datalog checks:

```datalog
check if operation("path", $op), ["read"].contains($op);
check if time($t), $t <= 2026-10-07T21:30:00Z;
check if depth($d), $d <= 1;
```

Delegation can only narrow. broker verifies that every child token is derived from a token the parent holds, and records `grant.delegate`. Revoking the root ID revokes the whole tree. Processes that already hold materialized fds are killed (agents) or frozen (apps, until the human decides). See [Capabilities and the broker](../06-security/capabilities-and-broker.md).

## Limitations

- An fd that has been materialized cannot be taken back from a running process. Revocation therefore acts on the holder (kill or freeze), not on the fd.
- A process's Landlock domain cannot be widened. Dynamic directory grants therefore depend on warden attaching mounts under `/grants` in the principal's mount namespace; a grant revoked later is detached from the namespace, and open fds are handled by kill or freeze.
- Network grants cannot be enforced by host name in the kernel. The socket broker hands out is always a connection through gate.

## Related

- [Capabilities and the broker](../06-security/capabilities-and-broker.md)
- [Tokens](../04-contracts/tokens.md)
- [Cedar policy](../04-contracts/cedar-policy.md)
- [Trusted path](../06-security/trusted-path.md)
- [broker spec](../../specs/broker/spec.md)
