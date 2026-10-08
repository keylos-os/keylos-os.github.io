# Capabilities and the broker

> `broker` is the only component that creates authority in keylos. It decides requests with Cedar, obtains approvals on the trusted path, mints Biscuit tokens, and materializes them into kernel-enforced handles.
> It also tracks session labels, carves budgets for sub-principals, revokes authority, and keeps persistent grants honest across reboots.

**Status:** specified (v1.0). Specification: [broker](../../specs/broker/spec.md).

## The request pipeline

![Authority flow: request, decide, mint, materialize](../images/authority-flow.svg)

| Step | What happens | Fails as |
|---|---|---|
| 1. Identify | The caller is resolved from the capwire connection via `warden` | `kl:denied` |
| 2. Validate | Resource and rights are well-formed | `kl:invalid` |
| 3. Build entities | Paths resolved against held roots, labels read, hosts looked up | — |
| 4. Cedar | Each requested right evaluated; `forbid` wins; `@tier` annotations read | `kl:denied` |
| 5. Floors | Fixed minimum tiers applied (irreversible commit is T3, persist is T2 + presence, …) | — |
| 6. Classifier | Optional; may raise T0/T1 to T2/T3 | — |
| 7. Rule of Two | If granting would complete untrusted + private + egress, the request becomes a T3 declassification | — |
| 8. Approve | T0/T1: none. T2: batched review. T3: synchronous prompt, with presence where required | `denied` outcome |
| 9. Mint + receipt | Biscuit token; `grant.issue` receipt written **before** the reply | `kl:unavailable` if the ledger is down |

## Approvals

| Tier | Example | What the human sees |
|---|---|---|
| T0 | App reads its own data | Nothing (receipt only) |
| T1 | Agent GETs from a host it already holds | Nothing (receipt only; a classifier may escalate) |
| T2 | App asks for `~/Documents` without the powerbox; agent wants a new host | A batched review card listing the requests in plain language |
| T3 | Agent commits an irreversible effect; declassification; merging agent changes | A blocking prompt with rendered effects and argument provenance; FIDO2 touch for presence-required acts |

**Mandates.** Every approval yields a signed `keylos.mandate/1`. `atrium` signs it with its per-boot approver key (registered with `BrokerSystem.registerApprover`), the owner's FIDO2 credential signs it when presence is required, and phone or org approvals sign with their own keys when policy allows that channel. The broker verifies the mandate before minting and returns it with the outcome (`Approval.mandate`, or `GrantResult.mandate` when gate asked through `BrokerSystem.requestFor` on behalf of the session that staged an intent). `gate` refuses to commit an irreversible effect unless a mandate binds the exact payload digest ([ADR-0027](../11-decisions/adr-0027-effect-outbox-and-mandates.md)).

**Rules that keep approvals meaningful:**
- T2 requests from one session are batched: 3 s or 10 requests.
- A session may have at most 5 pending approvals.
- Prompts expire after 10 minutes.
- Persistent approvals always need a touch.

## Materialization

A token becomes a kernel handle only through `Broker.materialize` (or through `gate`, `warden` and `devd` for their kinds).

**Files** are opened by the broker with `openat2` from a held root (`home:alice`, `appdata:alice:org.example.Editor`, `pbx:<grant>`, `proj:…`). The resolve flags forbid escaping, symlinks, magic links and mount crossings. The holder receives an open fd.

**Directories** cannot be passed as broker-opened fds. Landlock judges access by the path hierarchy, and a broker fd lies outside the holder's allowed tree. Instead:
1. The broker calls `GrantMounts.attachGrant` (warden facet `broker`): warden bind-mounts the directory, idmapped to the holder's dynamic UID, into the holder's mount namespace at `/grants/<name>`, read-only if no write rights were granted.
2. warden returns an `O_PATH` fd opened **inside** the holder's view, plus the view path; the confinement report lists it under `grants`.
3. For VM principals, the directory becomes a virtio-fs share (bench uses `GrantMounts.idmappedDir`).
4. Revocation detaches the mount (`GrantMounts.detachGrant`).

**Network** sockets come from `gate` (the egress proxy), never from the broker. **Devices** come from `devd`. **Secrets** come from `vault` for apps, and never as values for agents. **Services** are routed sockets from `warden`.

## The powerbox

The usual way an app gets a user file is the user picking it:

![Powerbox: the choice is the grant](../images/powerbox.svg)

1. The app calls `Broker.powerbox(openFile | openDirectory | saveFile, …)`.
2. `portal-files` shows a chooser on `atrium`'s trusted surface. The app cannot draw it or see what else is on disk.
3. **The selection is the grant.** There is no extra approval. The broker mints a token, opens the file or attaches the directory, raises the session label, and writes a receipt.
4. "Remember for this app" turns it into a persistent grant record, which needs a touch.

The shell is a powerbox too: paths you type become fds handed to the command ([Shell](../09-experience/README.md)).

## Delegation and budgets

When a principal starts a child (a sub-agent, a tool, a spawned app), `warden` asks the broker to register the child session:

- **Taint is inherited.** The child's label starts at the parent's.
- **Authority shrinks.** The child's tokens are new roots whose rights are a subset of the parent's, limited by `max_depth` and `max_fanout`.
- **Budgets are carved.** A child given $2 from a $5 parent has $2 reserved on the parent's meter in `gate`. The unspent remainder is refunded when the child ends.
- **Widening later** needs a T2 approval.

## Revocation

| Action | Effect |
|---|---|
| `grants revoke <root>` | Root and all descendants invalid within 50 ms |
| Holders of revoked roots | `PrincipalControl.terminate` on the session and its descendants: agents killed; apps frozen (cgroup freeze), then the user chooses resume, keep frozen or kill. Attached grant mounts are detached |
| Session end | Its non-persistent roots revoked |
| Reboot | Root key rotates; all tokens gone; persistent grants re-minted only if policy still allows |

## Persistent grants

Grant records live in `/var/lib/keylos/broker/grants/` as DSSE files signed with a TPM-bound key. They are **not trusted blindly**. At each re-mint the broker:

1. re-evaluates the record against the current policy;
2. requires an owner-presence mandate for any record that needed T2/T3 approval;
3. for directory grants, checks that the directory is still the same object (inode, generation and creation provenance). If it isn't, the grant is suspended.

So a grant record forged at runtime by malware grants nothing beyond what a signed policy already allows without a prompt. That is part of "reboot heals".

## Limitations

- Reads inside an attached directory are not individually mediated by the broker. Instead each grant has a label ceiling that warden's LSM enforces on open and read, so nothing above the label the holder was raised to is reachable ([ADR-0062](../11-decisions/adr-0062-directory-label-ceilings.md)).
- Directory distinctions finer than read-only and read-write (create-only, delete-only) need the holder to opt into an extra Landlock layer.
- Revocation cannot recall data already read. It stops further access and kills or freezes the holder.

## Related

- [Capability tokens](../04-contracts/tokens.md)
- [Cedar policy](../04-contracts/cedar-policy.md)
- [Labels and the Rule of Two](labels-and-rule-of-two.md)
- [Trusted path](trusted-path.md)
- [Principals and identity](principals-and-identity.md)
- [broker spec](../../specs/broker/spec.md)
