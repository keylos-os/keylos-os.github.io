# keylos/net: networking

| | |
|---|---|
| Repository | `github.com/keylos-os/net` |
| Version | 1.0.0 |
| Status | Normative |
| Artifacts | Service generation `io.keylos.net` with processes `netd` (links, addressing, DHCP, firewall, WireGuard, captive probe, cluster uplink), `net-resolver` (validating DNS stub), `net-mdns` (mDNS/DNS-SD querier and responder), `net-time` (NTS, built on ntpd-rs), `net-wifi-bus` (`dbus-broker` island), `net-wifi-iwd` (`iwd`), `net-wifi` (island adapter); CLI `net`; Nickel schema module `keylos.net` |
| Depends on | `keylos-protocols 1.0` (final) — crates `keylos-ids`, `keylos-formats`, `keylos-capwire`, `keylos-schemas`; runtime: `warden`, `vault`, `ledger`, `broker` (captive tokens), `journal`; consumers `gate`, `atrium`, `bench`, `courier`, `portals` (`portal-discovery`, `portal-print`), `cri` |
| Provides | `Net` (protocols §7.3.15), `NetWatch`, `NetResolver`, `NetPlumbing`, `NetCaptive`, `NetPlumbingCluster`, `NetDiscovery` (protocols §7.5.11); the host firewall; the DNS resolver used by `gate`; authenticated system time; the `cri` network namespace uplink on `server-k8s` nodes; mDNS/DNS-SD for `portal-discovery` |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and OPTIONAL are used as in RFC 2119 and RFC 8174.

---

## 1. Purpose and scope

`net` owns the machine's network stack in the **host network namespace**:

- **Links:** Ethernet, Wi-Fi, WWAN (ModemManager in a D-Bus island, optional), loopback.
- **Addressing:** DHCPv4 client, IPv6 SLAAC (kernel) with RA options (RDNSS, DNSSL), DHCPv6 (stateful and prefix delegation for the router profile), static configuration.
- **Wi-Fi** through `iwd`, confined, reachable only through a private D-Bus island.
- **DNS:** a validating stub resolver with DNS-over-TLS and DNS-over-HTTPS upstreams, DNSSEC validation, per-link and global upstreams, and split DNS for VPNs.
- **VPN:** WireGuard (kernel), from declarative profiles, keys in `vault`.
- **Host firewall:** an nftables ruleset generated from config and runtime sets. It makes `gate-net`, `net` and UIDs `warden` publishes the only sockets that may leave the machine, and defines inbound exposure.
- **Time:** NTS-authenticated time (RFC 8915) via ntpd-rs. It disciplines the clock, enforces the ledger time floor and reports trust state.
- **Captive portals:** detection; sign-in (`NetCaptive.signIn`, asked by atrium) happens in a disposable captive-browser VM that net starts itself through `bench#net` and admits by the cgroup it reads with `Vm.info`.
- **Metered-connection** state for other services (for example `courier` defers large downloads).
- **Local discovery:** mDNS/DNS-SD browsing and publishing on behalf of `portal-discovery` (`NetDiscovery`).
- **Cluster uplink:** on `server-k8s` nodes, the `cri` network namespace with its veth uplink, pod-CIDR routes, forwarding and NAT (`NetPlumbingCluster`, protocols §21.5).

### 1.1 Non-goals

- Per-principal egress policy, proxies, credential injection and listening sockets: `gate`.
- Network plumbing inside principal namespaces: `warden` creates `lo`-only namespaces; `gate-shim` (tier L) and `bench-net` (VMs) forward flows to `gate`.
- Bridging or NAT for VMs. A VM's single virtio-net device is terminated in host userspace by `bench-net`; no tap, bridge or forwarding exists on the host. The only exception is the `cri` network namespace on `server-k8s` nodes (§4.11): net builds its uplink, and `cri` owns everything inside it (bridge, taps for pod VMs, IPAM, overlay, NetworkPolicy).
- Per-app inbound ports. Inbound listeners are created by `gate` for `listen:` grants (non-loopback listens are the effect `net.listen`, decided at gate); `net` opens only the matching firewall holes.
- Deciding which principal may publish or browse services: `portal-discovery` checks grants; net enforces only that a published port is in the current listen set.

---

## 2. Context and embedded contracts

### 2.1 Position

```
 kernel (host netns) ◄── netd (rtnetlink, nftables, wireguard genl, DHCP packet/UDP sockets, captive probe)
                     ◄── net-resolver (UDP/TCP 53, DoT 853, DoH 443 upstream)
                     ◄── net-time (NTS-KE 4460/TCP, NTP 123/UDP)
                     ◄── net-wifi-iwd ◄─ island dbus-broker ─► net-wifi ─► netd
                     ◄── gate-net (all principal egress; gate spec)
                     ◄── net-mdns (UDP 5353 multicast on local links)
                     ◄── UIDs in local_link_uids (portal-print mDNS/IPP; published by warden)
                     ◄── captive VM bench-net cgroup (admitted by session, ≤ 600 s)
                     ◄── veth "kl-criup" ─► cri network namespace (server-k8s only; bridge kl-cri0 inside; forwarding + NAT)
 consumers: gate (resolver, plumbing), warden (plumbing), atrium/bench (captive), cri (cluster plumbing),
            portal-discovery (discovery), courier and apps (status)
```

### 2.2 Routes

**Facets net serves** (protocols §19.2, embedded in §2.3.10): `user`, `status`, `resolver`, `captive`, `plumbing`, `discovery`.

**Routes net holds:**

| Route | Used for |
|---|---|
| `warden#service` | `Supervisor.identify`; `FdStore` (island socket dir fd, WireGuard netlink state is in the kernel) |
| `vault#net` | `open`/`store`/`delete` of `_system` items of kinds `wifi` and `token` |
| `ledger#writer` | `net.change` receipts |
| `ledger#time` | `LedgerAdmin.timeFloor` |
| `broker#system` | `BrokerSystem.mintCaptive` (captive-portal token for the admitted VM session) |
| `bench#net` | `Bench.start` (purpose `captive` only), `Vm.info`, `Vm.stop` for the captive-browser VM (protocols §19.2) |
| `atrium#notify` | `TrustedPrompt.notify` (captive sign-in, time trust loss, kill-switch block) |

### 2.3 Embedded contracts (verbatim from `keylos-protocols 1.0`)

#### 2.3.1 protocols §2.1 Kernel feature levels

Components MUST probe for features and MUST pick behaviour by **feature level**, not by kernel version string.

| Level | Required kernel features | Typical kernel |
|---|---|---|
| `KL1` | Landlock ABI ≥ 7, BPF LSM (`lsm=` includes `bpf`), IPE, fs-verity, overlayfs `verity=require`, pidfd (`CLONE_PIDFD`, `pidfd_getfd`, `SO_PEERPIDFD`), `openat2`, new mount API, `MOVE_MOUNT_BENEATH`, idmapped mounts, `AT_EXECVE_CHECK`, `memfd_secret`, `mseal`, cgroup v2 (`cgroup.freeze`, `cgroup.kill`) | 6.18 |
| `KL2` | KL1 + Landlock ABI ≥ 9 (`FS_RESOLVE_UNIX`, `RESTRICT_SELF_TSYNC`) | 7.1 |
| `KL3` | KL2 + Landlock ABI ≥ 10 (UDP rules) | 7.2 |

On KL1 and KL2 there are no Landlock rules for pathname unix sockets or UDP. Components MUST compensate: the sandbox gets a private network namespace with only `lo`, and egress goes through `gate`; the mount view gives no access to pathname sockets. That compensation MUST be recorded in the process's confinement report (§9.4).

The LSM order on the kernel command line is `lsm=landlock,lockdown,yama,ipe,bpf`.

#### 2.3.2 protocols §3.6 Time

- On the wire: `Timestamp { unixNanos :Int64 }` in UTC.
- In documents: RFC 3339 with `Z` and at most nanosecond precision.
- The system clock MUST be disciplined by NTS-authenticated time (owned by the `net` repo).
- Components that check expiry (tokens, TUF, certificates) MUST treat the clock as **untrusted until the first NTS sync after boot**. Until then they use the **time floor**: the time of the newest ledger checkpoint (`LedgerAdmin.timeFloor`, §7.5.5). `net` steps the clock forward to the time floor at boot if the RTC is earlier. The RTC is never trusted to move time backwards past the floor.

#### 2.3.3 protocols §7.1 Model

All keylos IPC between principals on one kernel uses **Cap'n Proto RPC (rpc.capnp, level 1 plus promise pipelining)** over **AF_UNIX `SOCK_SEQPACKET`** sockets.

- **There is no system bus.** A process can reach only the capabilities it was handed:
  - the bootstrap capability of each socket `warden` passed to it at spawn (listed in `KEYLOS_CAPWIRE_FDS`, §10.5),
  - capabilities returned by calls on those.
- **The one exception is the CRI boundary** (§21): the upstream `kubelet` speaks the Kubernetes CRI v1 gRPC API to `cri` over an `AF_UNIX` `SOCK_STREAM` socket that `warden` creates and passes to `kubelet` (route `cri#kubelet`). No other non-capwire IPC between keylos principals is allowed.
- **Holding is authority.** A capability or an fd received through capwire is itself the authority to use it. capwire has **no call-attached tokens**: methods that need token-based authority take an explicit `C.Token` parameter; otherwise the route facet or the held capability is the authority.
- **Framing:** one Cap'n Proto message (standard segment-table framing) per datagram.
  - Maximum datagram size: 4 MiB.
  - Larger data MUST use a `ByteStream`/`ByteSource` capability or a passed fd.
- **File descriptors** travel as `SCM_RIGHTS` ancillary data on the same datagram, at most 64 per datagram. Inside the message, an fd is referenced by an `Fd` struct whose `index` is its position in that datagram's fd array.
  - **No fd** is written as `index = 0xFFFF`, which is the struct default; a null `Fd` pointer also means "no fd". Senders SHOULD write `Fd` structs explicitly. A method that requires an fd fails with `kl:invalid` when it gets none.
  - An `Fd.index` that is out of range, or that a receiver resolves a second time, fails **that call** (or that result's processing) with `kl:invalid`; the connection stays up. The transport is schema-unaware, so an index is checked when the receiver resolves the field.
  - Every received fd that no field took is closed when the receiver releases the message (call parameters released, or the response dropped).
  - Fds can be attached to any parameter or result struct of a message built on a capwire connection, including structs with pointer fields only; a caller does not need to resolve a bootstrap promise before sending fds on it.
  - `ENOBUFS` and `ENOMEM` from `sendmsg` are transient: the sender retries with backoff for up to 1 s before it fails the connection.
- **Datagram rules** (violations are protocol errors that fail the **whole connection**, reported to the local side as `kl:invalid`): exactly one standard-framed message per datagram with no trailing bytes; size ≤ 4 MiB; ≤ 64 fds; ancillary data not truncated (`MSG_TRUNC`/`MSG_CTRUNC`); fds never on capwire-vsock. Senders MUST NOT send zero-length datagrams; a receiver reads a zero-byte datagram as end of connection. A sender whose own outgoing message would exceed 4 MiB fails the connection rather than leave the peer waiting.
- **Socket buffers.** `warden` (and any component that creates capwire sockets for others) sets `SO_SNDBUFFORCE` and `SO_RCVBUFFORCE` to at least 4 MiB + 64 KiB (4 259 840 bytes) on both ends of every capwire socketpair it creates, so 4 MiB datagrams fit; distributions set `net.core.wmem_max` and `net.core.rmem_max` ≥ 4 259 840 (§2). capwire-vsock endpoints set `SO_VM_SOCKETS_BUFFER_SIZE`/`_MAX_SIZE` to the same value.
- **Peer identity:**
  - Every capwire connection between principals is a `socketpair` created by `warden` (§7.2). For such sockets the kernel records the **creating** process (`warden`) as the peer of both ends, so `SO_PEERPIDFD` and `SO_PEERCRED` name `warden`, not the peer. Servers MUST take the peer's principal, tier, generation and facet **only** from `ServiceHost.accept` (§7.5.1), or from `Supervisor.connectionInfo` for a connection ID `warden` delivered.
  - `SO_PEERPIDFD` + `Supervisor.identify` MAY be used only for sockets the peer itself `connect()`ed to a listening socket (not used between keylos principals in 1.0; reserved for diagnostics and future listeners).
  - Servers MUST NOT use PIDs, executable paths, or claims inside messages to decide who the caller is.
- **Bootstrap:** the socket's bootstrap capability implements the service's root interface **and** `common.Extensible` (§7.3.1). It is already narrowed by `warden` to the route's facet (§7.2).

#### 2.3.4 protocols §7.2 Routes and facets

`warden` wires services according to **routes** declared in service and app manifests plus policy.

```
route = { from: <principal pattern>, to: <service-name>, facet: <facet-name> }
```

- A **facet** is a server-defined restriction name. The registry of every facet, its holders and the methods it allows is §19.2. Servers MUST refuse methods their facet doesn't allow with `kl:denied`.
- Route references are written `service#facet` (for example `vault#app`).
- The server learns the facet of each connection from `ServiceHost.accept` (§7.5.1) or `Supervisor.connectionInfo`.
- Service sockets live under `/run/keylos/svc/<service>/` with mode `0700`, owned by `warden`'s UID. No other principal can `connect()` to them. Connections are created by `warden` (`socketpair` + hand-off through `ServiceHost.accept`).
- Dynamic routes (a service capability granted at runtime) are materialised by `broker` through `ServiceConnect.connectService` (§7.5.1).

#### 2.3.5 protocols §7.3.1 `common.capnp`

```capnp
@0xc7a1e5d3b2f40001;

struct Digest {
  algo  @0 :Algo;
  bytes @1 :Data;            #! sha256/fsv256: 32 bytes; sha512: 64 bytes
  enum Algo { sha256 @0; sha512 @1; fsv256 @2; }
}

struct Ref {                 # typed reference, protocols §3.2
  kind   @0 :Kind;
  digest @1 :Digest;
  enum Kind { obj @0; gen @1; src @2; drv @3; rcpt @4; key @5; }
}

struct Fd { index @0 :UInt16 = 0xFFFF; }   #! index into the SCM_RIGHTS array of the carrying datagram; 0xFFFF (the default) and a null pointer mean "no fd"

struct Timestamp { unixNanos @0 :Int64; }

struct PrincipalId { text @0 :Text; }   #! canonical text form, protocols §3.4
struct SessionId   { text @0 :Text; }

struct Label {
  conf  @0 :Conf;
  integ @1 :Integ;
  enum Conf  { public @0; internal @1; private @2; secret @3; }
  enum Integ { trusted @0; user @1; untrusted @2; }
}

struct Token { biscuit @0 :Data; }      #! Biscuit v3 serialized token, protocols §8

struct KeyValue { key @0 :Text; value @1 :Text; }

struct AttemptBinding {          #! one execution attempt of a durable workflow (§20.25); epoch 0 (the default) = not an attempt
  workflow @0 :Text;             # wf-…
  attempt  @1 :Text;             # wa-…
  epoch    @2 :UInt64;           # ownership epoch of the claim (BrokerWorkflow.claim, §7.5.25)
  step     @3 :Text;             # ws-… the attempt executes
  owner    @4 :Text;             # the workflow's owning human; warden uses it as the attempt principal's human
}

interface ByteStream {
  write @0 (bytes :Data) -> stream;
  done  @1 ();
}

interface ByteSource {
  read @0 (maxBytes :UInt32) -> (bytes :Data, eof :Bool);
}

interface Cancelable { cancel @0 (); }

interface Watcher(T) {          # server-push subscription
  event @0 (event :T) -> stream;
}

interface Extensible {          #! implemented by every bootstrap capability
  ext     @0 (interfaceId :UInt64) -> (cap :Capability);   #! kl:denied if the facet does not allow that interface, or the server does not implement it
  version @1 () -> (protocols :Text, implementation :Text);   #! protocols: SemVer of this document ("1.0.0"); implementation: "<repo>/<SemVer>"
}
```

**Errors.** Methods signal failure with a Cap'n Proto exception of type `failed`. The exception `reason` string MUST start with `kl:<code>`, optionally followed by `:<ref>` (non-empty), then optionally a space and a human-readable message. Codes outside the table are a parse error. Root interfaces are not declared `extends(C.Extensible)`; clients obtain the `Extensible` view of a bootstrap capability by casting the same capability.

| Code | Meaning |
|---|---|
| `denied` | Policy refused. Not retryable without new authority. |
| `needs-approval` | `:<ref>` is an approval ID (`a-…`). Retry after the approval resolves, or use the returned `Approval`. |
| `not-found` | |
| `invalid` | Malformed request |
| `conflict` | State changed concurrently |
| `expired` | |
| `revoked` | |
| `budget` | Budget exhausted |
| `integrity` | Verification failure: signature, digest, fs-verity |
| `unavailable` | Transient; MAY retry with backoff |
| `unsupported` | Feature level or platform lacks support |
| `internal` | |

Example: `kl:needs-approval:a-01JB6R… Sending email requires approval`.

#### 2.3.6 protocols §7.3.6 `vault.capnp`

```capnp
@0xc7a1e5d3b2f40006;
using C = import "common.capnp";

struct ItemAcl {
  actors  @0 :List(Text);        # actor patterns, e.g. "app:gen:fsv256:…", "app:name=org.example.Editor"
  ops     @1 :List(Op);
  prompt  @2 :PromptPolicy;
  enum Op { read @0; use @1; update @2; delete @3; }
  enum PromptPolicy { never @0; perSession @1; always @2; presence @3; }
}

struct ItemInfo { name @0 :Text; kind @1 :Text; created @2 :C.Timestamp; acl @3 :ItemAcl; }

interface Vault {
  open    @0 (name :Text, purpose :Text) -> (secret :C.Fd);       #! delivery format §20.10 (memfd_secret, mmap-only, length-prefixed)
  store   @1 (name :Text, kind :Text, value :C.Fd, acl :ItemAcl) -> ();   # value.index 0xFFFF = ACL-only update
  delete  @2 (name :Text) -> ();
  list    @3 () -> (items :List(ItemInfo));
  sign    @4 (name :Text, alg :Text, data :Data) -> (signature :Data);   # key never leaves vault
  sshAgent @5 () -> (socket :C.Fd);                                     # per-principal SSH agent protocol socket
  dataKey @6 (unit :Text) -> (key :C.Fd);                                # crypto-shred unit key (facets strata, ledger, gate, aide, journal, loom; each only for its own unit prefix)
  forget  @7 (unit :Text) -> ();                                         # destroy unit key (same facets)
  inject  @8 (name :Text, target :Text) -> (handle :Data);              # facet gate only: opaque handle for credential injection
}
```

An injection handle is redeemed by `gate` with `open("inject:<hex handle>", purpose)` on facet `gate`.

#### 2.3.7 protocols §7.3.15 `net.capnp` (implemented by this repo)

```capnp
@0xc7a1e5d3b2f40015;   # net.capnp
using C = import "common.capnp";
struct Link { name @0 :Text; kind @1 :Text; state @2 :Text; addresses @3 :List(Text); metered @4 :Bool; }
struct WifiNetwork { ssid @0 :Text; security @1 :Text; signal @2 :Int16; known @3 :Bool; }
interface Net {
  links     @0 () -> (list :List(Link));
  wifiScan  @1 () -> (list :List(WifiNetwork));
  wifiJoin  @2 (ssid :Text, credential :C.Fd) -> ();    #! facet user only; credential stored via vault
  vpnUp     @3 (profile :Text) -> ();                   #! facet user only
  vpnDown   @4 (profile :Text) -> ();                   #! facet user only
  resolve   @5 (name :Text) -> (addresses :List(Text), dnssec :Bool);
  time      @6 () -> (synced :Bool, offsetNanos :Int64, source :Text);
  status    @7 () -> (json :Text);
}
```

#### 2.3.8 protocols §7.5.5 `ledger-sys.capnp`

```capnp
@0xc7a1e5d3b2f40024;
using C = import "common.capnp";
using L = import "ledger.capnp";

interface LedgerWitness {          # facet witness (vouch, fleet)
  pending        @0 (afterTreeSize :UInt64) -> (checkpoint :L.Checkpoint, consistency :List(Data), fromSize :UInt64);
  addCosignature @1 (treeSize :UInt64, cosignatureLine :Text) -> ();
}

interface LedgerAdmin {            # facet admin (owner shell, warden for timeFloor)
  export           @0 (filterJson :Text, out :C.Fd) -> (bytes :UInt64);
  resetWriter      @1 (service :Text, presenceEnvelope :Data) -> ();
  timeFloor        @2 () -> (time :C.Timestamp);
  status           @3 () -> (json :Text);
  acknowledgeAlarm @4 (alarmId :Text, presenceEnvelope :Data) -> ();
  shred            @5 (human :Text, month :Text, presenceEnvelope :Data) -> (receipts :UInt64);
      #! month "YYYY-MM": destroys the ledger unit key ledger:<human>:<month> through vault.forget; writes ledger.shred.
      #! Without presence only months older than the configured retention (default 13) may be shredded (automatic job)
}
```

`timeFloor` is also served on facet `time` (net, warden). On facet `fleet-export`, `export` returns metadata-only receipts (sealed payloads omitted) unless an owner exception of kind `fleet-receipt-access` (§20.9) covers the event type.

#### 2.3.9 protocols §7.5.11 `net-sys.capnp` (implemented by this repo)

```capnp
@0xc7a1e5d3b2f4002a;
using C = import "common.capnp";

struct NetEvent {
  union {
    linkChanged      @0 :Text;      # JSON Link
    timeTrusted      @1 :Bool;
    captive          @2 :Bool;
    metered          @3 :Bool;
    vpnChanged       @4 :Text;      # JSON {profile, up}
    resolverInsecure @5 :Text;      # upstream id
  }
}

interface NetWatch {               # facets user, status, resolver, captive
  watch @0 (watcher :C.Watcher(NetEvent)) -> (cancel :C.Cancelable);
}

interface NetResolver {            # facet resolver (gate, tier-0 services)
  query @0 (wire :Data) -> (wire :Data, secure :Bool);   # RFC 1035 wire format, one question
}

struct ListenPort {
  port  @0 :UInt16;
  proto @1 :Proto;
  scope @2 :Scope;
  enum Proto { tcp @0; udp @1; }
  enum Scope { loopback @0; lan @1; any @2; }
}

interface NetPlumbing {            # facet plumbing
  setEgressUids    @0 (uids :List(UInt32)) -> ();                         # warden: UIDs allowed host-netns egress (gate, net helpers)
  setListenPorts   @1 (tcp :List(UInt16), udp :List(UInt16), ports :List(ListenPort)) -> ();
      #! gate: subset of config listenPorts; when ports is non-empty it supersedes tcp/udp (which then MUST be empty)
      #! and carries each port's scope (needs.listen scope, §6.3)
  setLocalLinkUids @2 (uids :List(UInt32)) -> ();                         # warden: UIDs allowed mDNS/IPP on local links (portal-print)
}

interface NetCaptive {             # facet captive (atrium)
  status @0 () -> (captive :Bool, ssid :Text, portalUrl :Text);
  admit  @1 (vmUid :UInt32) -> ();  #! superseded before release: MUST return kl:unsupported
  admitSession @2 (vmSession :C.SessionId) -> (expires :C.Timestamp);   #! superseded before release: MUST return kl:unsupported; use signIn
  portalUrl    @3 () -> (url :Text);  # the detected portal URL
  signIn       @4 () -> (expires :C.Timestamp);
      #! atrium ("Sign in to network"): net starts the captive VM itself through bench#net (purpose captive, image
      #! io.keylos.bench.captive-browser, display true, bootArgs captive.url), reads its session and cgroup with Vm.info,
      #! mints the captive token (BrokerSystem.mintCaptive), which the broker attaches to the VM session (bench-net reads it
      #! with Broker.myGrants), and allows that VM's bench-net direct egress on tcp/80, tcp/443 and udp+tcp/53 for at most
      #! 600 s while the network is captive. The window appears through atrium's Display like any tier-3 VM
  endSignIn    @5 () -> ();
      #! atrium (sign-in window closed): net stops the captive VM (Vm.stop) and revokes its direct egress immediately
}

interface NetPlumbingCluster {     # facet plumbing (clusterUplink: cri; clusterNetns: warden)
  clusterUplink @0 (configJson :Text) -> (netns :C.Fd);
      #! configJson is keylos.cri.uplink/1 (§21.5): op "uplink" configures the cri network namespace (pod CIDR routes,
      #! NAT, overlay) and returns it; op "podNetns" creates a pod network namespace attached to the cri bridge and
      #! returns it; op "release" deletes a pod namespace. cri holds CAP_NET_ADMIN only inside the cri namespace
  clusterNetns  @1 () -> (netns :C.Fd);
      #! warden: the cri network namespace, created by net at its own start on server-k8s from config cluster.*;
      #! warden starts services with services.json network "cluster" (crid, kubelet, kube-proxy) inside it
}

interface NetDiscovery {           # facet discovery (portal-discovery)
  browse  @0 (serviceType :Text, onLink :Text, watcher :C.Watcher(Text)) -> (cancel :C.Cancelable);   # JSON ServiceInstance
  publish @1 (instance :Text, serviceType :Text, port :UInt16, txtJson :Text, forUid :UInt32) -> (handle :C.Cancelable);
}
```

#### 2.3.9a protocols §7.5.2 `broker-sys.capnp` (`mintCaptive`)

```capnp
@0xc7a1e5d3b2f40021;
using C = import "common.capnp";
using B = import "broker.capnp";
using P = import "prompt.capnp";

struct SessionReg {
  child    @0 :C.PrincipalId;
  parent   @1 :C.SessionId;        # empty for warden-originated system services
  offered  @2 :List(C.Token);
  onRevoke @3 :Text;               # "kill" | "freeze"
  budgets  @4 :List(B.Budget);     #! hard sub-budget ceilings for the child (VmPrincipal/ForkSpec budgets): the broker carves each from
                                   #! the matching offered root (GateMeterAdmin.carve) before issuing tokens; kl:budget if a parent meter is short
  attempt  @5 :C.AttemptBinding;   #! workflow attempt (§20.25): verified against the broker's workflow record (claimed epoch, attempt,
                                   #! allowed generation and spawner); the child's label and tokens then come from that record (§7.5.25)
}

struct SessionRegResult {
  tokens    @0 :List(C.Token);
  label     @1 :C.Label;
  tierFloor @2 :UInt8;             # 0..4 = t0..legacy
}

struct FlowCheck {
  session       @0 :C.SessionId;
  kind          @1 :Text;          # effect kind or "net"
  target        @2 :Text;
  payloadDigest @3 :C.Digest;
  rendered      @4 :List(P.RenderedEffect);
  provenance    @5 :List(P.ArgProvenance);
  flowProof     @6 :Data;          # optional DSSE keylos.flowproof/1 (§20.11)
  intent        @7 :Text;          # e-… id of the staged intent; empty for connect-time "net" checks
}

struct GrantResult {
  outcome @0 :B.GrantOutcome;
  mandate @1 :Data;                # DSSE keylos.mandate/1 when the outcome was decided by approval; empty otherwise.
                                   #! presence-signed when presence was required; otherwise signed by service/broker (§14.4)
}

struct PodAdmission {
  allowed   @0 :Bool;
  reasons   @1 :List(Text);        # forbid/permit policy ids and failed checks
  tierFloor @2 :UInt8;             # 1 = keylos-sealed allowed, 2 = keylos-vm required
  approval  @3 :Text;              # a-… when an @tier/@orgApproval permit applies (pods wait for it)
}

interface BrokerSystem {           # facet system
  registerSession    @0 (reg :SessionReg) -> (result :SessionRegResult);           # warden
  sessionEnded       @1 (session :C.SessionId, exitText :Text) -> ();              # warden
  checkFlow          @2 (check :FlowCheck) -> (result :GrantResult);               # gate: Rule of Two at stage/commit/connect
  requestFor         @3 (subject :C.SessionId, req :B.GrantRequest, intent :Text, idempotencyKey :Text,
                          intentSession :C.SessionId, decidedOnTrustedPath :Bool) -> (result :GrantResult);
      #! approval request on behalf of a subject session (intent = e-… id or empty). Allowed subjects per caller:
      #! gate → sessions that staged the intent (intentSession = the staging session when it differs from subject);
      #! aide → its agent sessions; strata, depot, vault, atrium → only their own session (atrium: device authorization).
      #! The broker deduplicates by (caller, idempotencyKey) for 24 h: a repeated call returns the same approval/result.
      #! decidedOnTrustedPath: atrium only (device authorization): the human already decided on atrium's trusted-path card;
      #! the broker evaluates policy, records approval.decide with channel "local" and returns the mandate without
      #! prompting again. MUST be false (else kl:invalid) for every other caller or when policy requires presence.
  registerApprover   @4 (publicKey :Data, alg :Text, channel :Text) -> ();         # atrium ("local") and vouchd ("phone"), once per boot
  registerSessionKey @5 (session :C.SessionId, publicKey :Data) -> ();             # aide: agent session key (flow proofs, commits)
  annotateRequest    @6 (session :C.SessionId, provenanceJson :Text) -> ();        # aide: provenance hints for the next request
  rootsChanged       @7 (fdkeys :List(Text)) -> ();                                # strata: re-open held roots after rollback
  revokeSession      @8 (session :C.SessionId, mode :Text) -> ();                  # hearth (lock/logout), warden
  loadPolicy         @9 (generation :C.Ref) -> ();                                 # config: activate a policy generation
  validatePolicy     @10 (tree :C.Fd) -> (ok :Bool, problems :List(Text));         # config: dry-run a candidate policy tree
  mintCaptive        @11 (session :C.SessionId) -> (token :C.Token);               # net: captive-portal token (§8.2 captive fact)
  admitPod           @12 (podSpecJson :Text, runtimeClass :Text) -> (admission :PodAdmission);
      #! cri: Cedar evaluation of action "admit" on a PodSpec entity (§16, §21.3); podSpecJson is the CRI PodSandboxConfig
      #! plus container configs, normalised by cri to keylos.podspec/1 (§21.3)
}

interface LabelAuthority {         # facet label-authority
  labelOf  @0 (session :C.SessionId) -> (label :C.Label);
  raiseFor @1 (session :C.SessionId, label :C.Label, reason :Text) -> (label :C.Label);   #! labels only go up; receipt label.raise
}
```

`registerApprover.publicKey` is a DER SubjectPublicKeyInfo; other encodings fail `kl:invalid`. A method whose receipt must be written before it replies (§19.3) answers `kl:unavailable` while the serving component's own `ledger.key.register` has not been appended; the broker registers its key before it serves facet `system`.

#### 2.3.9b protocols §7.3.15 `portals.capnp` (`ServiceInstance`, `Discovery`, for `NetDiscovery` results)

```capnp
@0xc7a1e5d3b2f40018;   # portals.capnp
using C = import "common.capnp";
struct CaptureStream { nodeId @0 :UInt32; width @1 :UInt32; height @2 :UInt32; sourceDescription @3 :Text; }
interface ScreenCapture { start @0 (kind :Text) -> (streams :List(CaptureStream), remote :C.Fd); }   # remote = PipeWire remote fd restricted to the nodes
interface Camera        { open @0 () -> (remote :C.Fd); }
interface Microphone    { open @0 () -> (remote :C.Fd); }
interface OpenUri       { open @0 (uri :Text) -> (); openFile @1 (file :C.Fd) -> (); }
interface NotifyHandler { activated @0 (id :UInt32, action :Text) -> (); }
interface Notify        { post @0 (title :Text, body :Text, actions :List(Text), handler :NotifyHandler) -> (id :UInt32); close @1 (id :UInt32) -> (); }
  #! handler is optional; when null, activation spawns the app's "notify-action" entrypoint with the action id as argv[1]
interface Print         { print @0 (document :C.Fd, mime :Text, optionsJson :Text) -> (jobId :Text); }
interface Clipboard     { read @0 (mime :Text) -> (data :C.Fd); write @1 (mime :Text, data :C.Fd) -> (); }
interface Location      { current @0 (accuracy :Text) -> (lat :Float64, lon :Float64, accuracyM :Float64); }
interface Accessibility { observe @0 () -> (observer :Capability); }    # returns an A11yObserver (§7.5.17); assistive-tech principals only
struct ServiceInstance { name @0 :Text; type @1 :Text; host @2 :Text; port @3 :UInt16; addresses @4 :List(Text); txt @5 :List(C.KeyValue); }
interface Discovery {                                                    # portal-discovery (mDNS / DNS-SD)
  browse  @0 (serviceType :Text, watcher :C.Watcher(ServiceInstance)) -> (cancel :C.Cancelable);   #! results raise the caller's label to integ untrusted
  publish @1 (instance :Text, serviceType :Text, port :UInt16, txt :List(C.KeyValue)) -> (handle :C.Cancelable);
      #! requires a listen grant for port (needs.listen scope lan) and a publish grant; on the local link only
}
struct ScanOptions { resolutionDpi @0 :UInt16; mode @1 :Text; source @2 :Text; format @3 :Text; }   # mode: color|gray|lineart; format: png|pdf|jpeg
interface Scan {                                                         # portal-scan (SANE backends in a compat island)
  scanners @0 () -> (list :List(Text));
  scan     @1 (scanner :Text, options :ScanOptions) -> (image :C.Fd);    #! trusted-path confirmation per scan; result labelled public/user
}
```

#### 2.3.9c protocols §7.3.13 `bench.capnp` (`Bench.start`, `Vm.info`, `Vm.stop` for the captive VM)

```capnp
@0xc7a1e5d3b2f40013;
using C = import "common.capnp";
using W = import "warden.capnp";
using B = import "broker.capnp";

struct Share { name @0 :Text; dir @1 :C.Fd; writable @2 :Bool; overlay @3 :Bool; }

struct VmSpec {
  image     @0 :C.Ref;              # bench-image generation
  shares    @1 :List(Share);
  vcpus     @2 :UInt16;
  memoryMiB @3 :UInt32;
  gpu       @4 :Bool;               # virtio-gpu native context
  network   @5 :List(C.Token);      # net grants; all egress via bench-net → gate
  display   @6 :Bool;               # Wayland proxy to atrium (tier-2 apps, workbench apps such as IDEs, agent-desktop mirrors)
  fromSnapshot @7 :Text;
  session       @8 :C.SessionId;    # the VM principal's session; bench generates it if empty
  parentSession @9 :C.SessionId;    # session the VM principal descends from (agent: the aide-created session chain parent)
  principalKind @10 :W.SpawnSpec.ActorKind;   # bench (default), agent, legacy, pod
  storeSet      @11 :List(C.Ref);   # generations exposed read-only in the guest store (/store) in addition to the image closure
  unsignedImageOk @12 :Bool;        #! honoured only for facet user calls by service:forge with purpose build, tier 3
  purpose       @13 :Purpose;
  displayMode   @14 :DisplayMode;   # meaningful when display = true
  gpuPassthrough @15 :Text;         # PCI address of a VFIO-claimed GPU (needs.gpu "passthrough"); empty = none
  blockDevices  @16 :List(BlockDev);   # media VMs and pod VMs: block devices claimed through devd MediaAttach
  enum Purpose { workbench @0; agent @1; app @2; media @3; build @4; captive @5; pod @6; agentDesktop @7; }
  enum DisplayMode { interactive @0; readOnly @1; }   # readOnly: human watches an agent desktop; takeOver switches to interactive
  struct BlockDev { device @0 :Text; fd @1 :C.Fd; readOnly @2 :Bool; }
  bootArgs      @17 :List(C.KeyValue);  # delivered to the guest over benchd control at boot (e.g. "captive.url" for purpose captive)
  tap           @18 :C.Fd;              #! purpose pod only (facet cri): tap device created in the cri network namespace; index 0xFFFF = none
  tapConfig     @19 :TapConfig;
  podId         @20 :Text;              # purpose pod: pod-… (§3.5); bench places the VMM processes under the pod's cgroup
  struct TapConfig { ifname @0 :Text; mac @1 :Text; mtu @2 :UInt16; }
  attempt       @21 :C.AttemptBinding;  #! facet aide only (agent attempts of a workflow, §20.25); copied to VmPrincipal.attempt
}

struct ForkSpec {
  session       @0 :C.SessionId;    # session of the forked VM principal; bench generates it if empty
  parentSession @1 :C.SessionId;    # defaults to the source VM's parentSession
  principalKind @2 :W.SpawnSpec.ActorKind;   # aide forks: agent; default: the source VM's kind
  offered       @3 :List(C.Token);    #! tokens for the fork; default: the source VM principal's tokens (sub-agents: the parent agent's)
  checks        @4 :List(Text);       #! attenuation checks for the fork (copied to VmPrincipal.checks)
  budgets       @5 :List(B.Budget);   #! sub-budgets for the fork (copied to VmPrincipal.budgets)
  attempt       @6 :C.AttemptBinding; #! facet aide only: the fork is an attempt of a workflow (§20.25); copied to VmPrincipal.attempt
}

interface Vm {
  exec     @0 (argv :List(Text), env :List(C.KeyValue), fds :List(W.FdMapping), tty :Bool) -> (process :W.Process);
  snapshot @1 (name :Text) -> (id :Text);
  fork     @2 (spec :ForkSpec) -> (vm :Vm);         #! spec null = defaults; the fork is a new VM principal registered through VmSpawn
  changes  @3 () -> (shares :List(Text));          # per-share change summaries
  commit   @4 (share :Text) -> (transaction :Text); # human workbenches only; agent overlays merge via BenchMerge (§7.5.10)
  discard  @5 () -> ();
  stop     @6 () -> ();
  console  @7 () -> (pty :C.Fd);
  attachShare @8 (share :Share) -> ();             #! hot-plug: new virtio-fs export in the running VM; the guest sees /shares/<name>
  detachShare @9 (name :Text) -> ();               #! open guest files on the share get EIO afterwards
  desktop  @10 () -> (desktop :Capability);        #! purpose agentDesktop only: returns an aide-sys AgentDesktop (§7.5.13)
  takeOver @11 (interactive :Bool) -> ();          # agentDesktop: switch the human's mirror between readOnly and interactive
  info        @12 () -> (session :C.SessionId, cgroupId :UInt64, cid :UInt32, purpose :VmSpec.Purpose);
  attachBlock @13 (dev :VmSpec.BlockDev) -> ();    #! hot-plug a virtio-blk device (pod VMs: CSI volumes published after start)
  detachBlock @14 (device :Text) -> ();
}

interface Bench {
  start     @0 (spec :VmSpec) -> (vm :Vm);
  project   @1 (projectDir :C.Fd) -> (vm :Vm);     # start/attach project workbench per project.ncl
  snapshots @2 () -> (list :List(Text));
  media     @3 (device :Text) -> (vm :Vm, browser :Capability);
      #! starts (or attaches to) the media VM for an authorized removable block device; browser is a bench-sys MediaBrowser (§7.5.10)
  reattach  @4 (session :C.SessionId) -> (vm :Vm);
      #! a new Vm capability for a running VM started by the same caller principal (cri after a crid restart, aide).
      #! VMs of purposes pod, agent and agentDesktop outlive their Vm capability until Vm.stop, the end of their parent
      #! session, or a bench restart (which stops every VM)
}
```

#### 2.3.10 protocols §19.2 Facets (net and the routes net holds)

| Service | Facet | Holders | Interfaces and methods |
|---|---|---|---|
| warden | `service` | tier-0 services | `Supervisor.spawn`, `identify`, `connectionInfo`; `FdStore`. `SpawnSpec.attempt` only from `loom` |
| broker | `system` | warden, gate, aide, atrium, config, hearth, strata, net, depot, vault, vouch, cri | `BrokerSystem` (per-method callers as commented in §7.5.2; `requestFor` with the allowed-subject rule, atrium only for its own session (device authorization); `registerApprover`: atrium, vouch; `admitPod`: cri; `mintCaptive`: net); `Broker.inspect` |
| ledger | `writer` | tier-0 services listed as writers in §19.3 | `Ledger` (all) |
| ledger | `time` | net, warden, depot | `LedgerAdmin.timeFloor` |
| vault | `net` | net | `open`/`store` of `_system` items of kinds `wifi` and `token` |
| net | `user` | owner `shell`, atrium | `Net` (all); `NetWatch` |
| net | `status` | tier 0; apps declaring `net-status` | `links` (redacted), `time`, `status`; `NetWatch` |
| net | `resolver` | gate, tier-0 services with network needs | `resolve`; `NetResolver`; `NetWatch` |
| net | `captive` | atrium | `NetCaptive` (`status`, `portalUrl`, `signIn`); `NetWatch` |
| net | `plumbing` | warden, gate, cri | `NetPlumbing` (`setEgressUids`, `setLocalLinkUids`: warden; `setListenPorts`: gate); `NetPlumbingCluster` (`clusterUplink`: cri; `clusterNetns`: warden) |
| net | `discovery` | portal-discovery | `NetDiscovery` |
| bench | `net` | net | `start` (purpose captive only), `Vm.info`, `Vm.stop` |
| atrium | `notify` | tier-0 services, portal-notify | `TrustedPrompt.notify` |

#### 2.3.11 protocols §9.1 Baseline

1. `PR_SET_NO_NEW_PRIVS`.
2. Own cgroup, own dynamic UID (§10.3), no supplementary groups. Human-owned data and directory grants reach dynamic UIDs through **idmapped mounts** (§7.5.1); mapping-only user namespaces used for idmapping are held by `warden`, and no process ever runs inside them.
3. Landlock ruleset at the highest available ABI:
   - starts from deny-all for all handled access rights;
   - allows only the mount view (§10.1), `/grants` (runtime grant mounts) and explicitly granted fds/paths;
   - scopes `ABSTRACT_UNIX_SOCKET` and `SIGNAL`;
   - uses `RESTRICT_SELF_TSYNC` when available.
4. seccomp-bpf allowlist profile `baseline-1`, default action `ENOSYS`. Always denied:
   - `unshare`, `setns`, and namespace flags on `clone`/`clone3` (clone3 → `ENOSYS`, forcing the libc `clone` fallback, which is then flag-checked);
   - `io_uring_*`, `bpf`, `perf_event_open`, `userfaultfd`;
   - `keyctl`, `add_key`, `request_key`;
   - `kexec_*`, `init_module`, `finit_module`, `delete_module`;
   - `mount`, `umount2`, `pivot_root`, `chroot`, `fsopen`, `fsmount`, `fsconfig`, `move_mount`, `open_tree`, `mount_setattr`;
   - `ptrace`, `process_vm_readv`, `process_vm_writev`;
   - `personality` (except the default);
   - `acct`, `swapon`, `swapoff`, `reboot`, `settimeofday`, `clock_settime`, `clock_adjtime`, `adjtimex` (read-only calls included: seccomp cannot inspect `struct timex`, so both are denied with `EPERM`);
   - `ioctl` `TIOCSTI` and `TIOCLINUX`.
5. Namespaces created by `warden` without a user namespace: mount, pid, ipc, uts, cgroup; net unless the principal is a tier-0 service with `network: "host"` (or `"cluster"`, which joins the cri network namespace, §20.16). **Single exception to "only `warden` creates namespaces":** on `server-k8s`, `net` creates the cri network namespace and the per-pod network namespaces inside the cri network (network namespaces only, never user or mount namespaces; §21.5).
6. A fresh `/proc` (`hidepid=invisible,subset=pid`).
7. No controlling terminal unless one is given; `TIOCSTI` disabled system-wide (`dev.tty.legacy_tiocsti=0`).
8. `mseal` of the stack and libc read-only segments (done by the keylos libc startup shim where available); `PR_SET_MDWE` (W^X) unless the generation has `needs.jit`.
9. `RLIMIT_RTPRIO = 0` unless the generation has `needs.realtime` (then 20, with `RLIMIT_RTTIME = 200 000 µs`).

The only other seccomp profiles are `baseline-1+<digest>` (baseline-1 plus the tier-0 extras a service's `privileges.syscalls` and `privileges.socketFamilies` list in `services.json`, §20.16; `<digest>` is the lowercase hex SHA-256 of the extras' names, syscalls and socket families together, sorted by bytes, each followed by `\n`), used only for tier-0 services; `debug-1` (baseline-1 plus `ptrace`, `process_vm_readv`, `perf_event_open`) and `debug-1k` (`debug-1` plus `bpf`, for scope `kernel`), used exclusively for `DebugAttach` debuggers (§9.3); `openbroker-1` (baseline-1 plus `process_vm_readv`; `ptrace`, `process_vm_writev` and `pidfd_getfd` stay denied), used exclusively for `compat`'s per-app open-broker processes (§9.3); and `runtime-default` (baseline-1 ∩ the Kubernetes RuntimeDefault profile) for `keylos-sealed` pods.

#### 2.3.11a protocols §2.2 Profiles and integrity profiles

A machine runs exactly one **profile** (chosen at install, recorded in the first-boot bundle and the boot report) and has exactly one **integrity profile** (derived at every boot, shown in status, in the boot report and in the `vouch` verdict).

| Profile | Use | Notes |
|---|---|---|
| `desktop`, `laptop` | Interactive machines | atrium, portals, presence by touch |
| `server` | Headless | No atrium; presence by **quorum** (§5.4); serial-console recovery with the recovery key |
| `server-k8s` | Kubernetes node | `server` + `cri`, `kubelet`, `kube-proxy` (§21) |
| `cloud` | VM image in a public or private cloud | vTPM (provider EK chains in the attestation trust store); confidential VMs (SEV-SNP, TDX) supported, SVSM vTPM preferred; first-boot bundle from the metadata service (§20.13); quorum presence |
| `kiosk` | Single-app appliance | Autologin to one app principal; atrium kiosk mode; trusted path still present for owners |
| `appliance` | Fixed-function device | As `server`, without `bench` |

| Integrity profile | Condition |
|---|---|
| `full` | Owner-controlled Secure Boot keys (no Microsoft CAs in db), TPM 2.0, IOMMU, every check passes |
| `shared-boot` | `secureboot.keepMicrosoftCAs = true` (dual boot): the Microsoft Windows and third-party UEFI CAs are in db. Bitpixie-class downgrade risk is mitigated by TPM+PIN, the signed PCR11 policy and the NV release floor, and is documented |
| `shim` | Booted through shim + MOK (no custom-key Secure Boot available) |
| `cloud-vtpm` | `cloud` profile with a provider vTPM and no confidential-VM report |
| `cvm` | `cloud` profile in a confidential VM whose report is verified together with the TPM quote |
| `degraded` | No TPM, or Secure Boot off; no sealing, no VBU, persistent warning |

#### 2.3.11b protocols §8.2 Authority block vocabulary (`captive`)

The broker MUST write the authority block using only these facts. Other components MUST understand all of them.

| Fact | Meaning |
|---|---|
| `principal($p)` | Holder principal text |
| `session($s)` | Holder session |
| `root_id($r)` | Root ID (bytes) |
| `right($kind, $resource, $op)` | Resource text by kind: `path` — `<rel>`, a normalised relative path (no leading `/`, no `.`/`..`, no trailing `/`, `""` = the whole root) naming a subtree matched on component boundaries, under the root named by the token's `path_root` fact; `net` — the host (or `listen:<addr>`), with the `net(...)` facts for that host carrying port, proto and method (a net right without a `net` fact for its host is invalid; a grant with only specific methods does not authorise a protocol-level connect, `"*"` does); `delegate` — `"*"`. `$kind` ∈ {"path", "net", "device", "secret", "budget", "spawn", "service", "effect", "delegate", "principal", "screen", "model"}; `$op` is a `Right` enumerant name. Kind `principal` (resource `session:s-…` or `gen:fsv256:…`) carries only `debug`; kind `screen` (resource `window:<id>`) only `read`, single use; kind `model` (resource `<provider>/<model>@<version>`) only `use` |
| `debug_scope($scope)` | `"process"` or `"kernel"` for a `debug` right; absent means `process` |
| `path_root($fdkey)` | Declares a broker-held root dirfd `$fdkey`; a path right applies under every `path_root` of the authority block. The broker mints at most one `path_root` per token |
| `net($host, $port, $proto, $method)` | `$method` is "*" for no HTTP restriction; `$host` "listen:<addr>" for listening grants |
| `budget($unit, $amount)` | Ceiling per charge in the authorizer (`amount ≤ ceiling`); cumulative spending is tracked by `gate` keyed by root_id |
| `expires($time)` | |
| `tier_floor($n)` | Minimum confinement tier for any process using this token |
| `max_depth($n)` | Maximum **absolute** delegation depth (the root holder is depth 0) |
| `max_fanout($n)` | Maximum number of child sessions |
| `label_ceiling($conf)` | Highest confidentiality the holder may read under this token: bounds both the session label and, when supplied, the object label |
| `persist($grantId)` | Token re-minted from persistent grant `$grantId` |
| `captive($bool)` | Captive-portal token: valid only for the captive-browser VM while `net` reports a captive network (minted by `BrokerSystem.mintCaptive`, ≤ 10 min, `tier_floor` ≥ 2) |
| `model($provider, $model, $version)` | A model identity approved for an agent session (§14.5); the authority block may list several (the approved set). An observed model must match a `model` fact of every block that has one; `gate` compares observed model versions against them |
| `budget_parent($rootId)` | The token's budget is a hard sub-meter of `$rootId` (`GateMeterAdmin.carve`) |
| `workflow($wf, $epoch)` | The token was minted for an attempt of workflow `$wf` (`wf-…`) at ownership epoch `$epoch` (§20.25). Verifiers that act for workflows (`gate` `DurableEffects`) MUST compare `$epoch` with the binding they are given and with the current claim; the fact never authorizes anything by itself |
| `budget_account($ba)` | Spending under this token is charged to the durable workflow budget account `$ba` (`ba-…`, `WorkflowBudget`, §7.5.25) in addition to the root meter, so a fresh attempt's new root never resets spent amounts |

**Fact multiplicity.** The authority block has exactly one `principal`, `session` and `root_id`, and at most one each of `expires`, `tier_floor`, `max_depth`, `max_fanout`, `label_ceiling`, `persist`, `captive`, `debug_scope` (per right), `budget_parent`, `workflow` and `budget_account`; `model` may occur several times. `persist`, `workflow` and `budget_account` are trusted only in the authority block.

#### 2.3.11c protocols §10.3 UIDs and cgroups

**UIDs:**

| Range | Use |
|---|---|
| 0 | Kernel threads, `warden` (PID 1). No other process. |
| 1000–59999 | Humans (allocated by `hearth`) |
| 0x00100000–0x0FFEFFFF | Dynamic principal UIDs, allocated by `warden` per running principal instance. Quarantined for 60 s after release. |
| 0x0FFF0000 | Reserved on-disk owner of `_cluster` data (pod volumes, cri state); reached by containers only through idmapped mounts; never allocated to a process |
| 0x0FFF0001–0x0FFFFFFF | Reserved |
| 0x10000000–0x7FFEFFFF | Legacy-tier user-namespace ranges, 65536-UID blocks, allocated by `warden` |

**cgroups:**

```
/keylos.slice/system.slice/<service>.scope
/keylos.slice/user-<uid>.slice/{shell,apps,agents,benches,legacy}.slice/<session>.scope
/keylos.slice/kube.slice/<pod-id>.slice/<container-or-vm>.scope      (cgroup subtree delegated to cri)
/keylos.slice/guest-<id>.slice/…                                    (ephemeral guest sessions, removed at logout)
```

#### 2.3.11d protocols §14.2 Effect kinds (`net.listen`)

Registered kinds, with their default class:

| Kind | Class |
|---|---|
| `fs.merge` | compensable (undo snapshot; compensator `fs.undo`) |
| `git.push` | compensable for new branches; irreversible for force pushes, pushes to protected branches and any other push to an existing branch |
| `git.pr.open` | compensable |
| `email.send` | irreversible |
| `message.send` (chat) | irreversible |
| `http.post`, `http.put`, `http.patch` | irreversible unless the host policy registers a compensator |
| `http.delete` | irreversible |
| `payment.authorize` | irreversible (requires an AP2-style mandate in `data`) |
| `publish.package` | irreversible |
| `cloud.iam.change` | irreversible |
| `db.write.prod` | irreversible |
| `calendar.create` | compensable |
| `file.share` | compensable |
| `device.actuate` | irreversible |
| `net.listen` | compensable (close the port). Required for any port reachable from non-loopback addresses (scope `lan`/`any`); loopback-only listening needs no effect |
| `media.export` | compensable (delete the file on the device); counts as egress (property X) for the Rule of Two |
| `config.propose` | reversible (a proposal only; applying it is `config.apply`) |

Policy can register additional kinds (`x-…`), each optionally with an effect renderer component (§20.15). Classes can be raised, never lowered.

**Mandate-only kinds.** The broker records decisions that are not intents with these kinds in mandate `effects[]` (§14.4): `grant.<k>` for every resource kind *k* of §8.2 (`grant.path`, `grant.net`, `grant.device`, `grant.secret`, `grant.budget`, `grant.spawn`, `grant.service`, `grant.effect`, `grant.delegate`, `grant.principal`, `grant.screen`, `grant.model`), `grant.declassify`, `debug.attach`, `pod.admit`, and for durable workflows (§20.25) `workflow.enroll` (target `wf-…`, digest = SHA-256 of the JCS `EnrollRequest` JSON form `{"workflow", "definition": {"generation": <gen ref text>, "name", "digest": <digest text>}, "inputDigest": <digest text>, "scope": [<GrantRequest JSON forms>], "budgets": [{"unit", "amount"}], "resume": "manual" | "automatic", "runWhileLocked", "horizonSecs", "reason", "account"}`), `workflow.resume` (target `wf-…`) and `workflow.decide` (target the `ws-…` or `fx-…` the decision is about, digest = SHA-256 of the JCS question or resolution document). They are valid only in mandates, written only by `broker`, and never appear in manifests, command signatures, intents or `gate` intents.

**Required review details.** Approval of an effect requires that the trusted path presents at least these details of the exact payload (§7.3.4); a policy-registered kind's renderer declares its own, and a kind without a declaration requires the complete canonical payload:

| Kind | Required details |
|---|---|
| `email.send`, `message.send` | every recipient (to, cc, bcc), subject, complete body, attachment names, types and sizes |
| `http.*` | method, complete URL, request body (or its digest plus a complete canonical rendering for bodies over the channel limit) |
| `payment.authorize` | amount, currency, payee, mandate terms |
| `fs.merge` | the complete `keylos.fsmerge/2` manifest and the diff of every changed text file; binary changes by path, size and digest |
| `git.push`, `git.pr.open` | remote, refs (old → new), commits with titles; force flag |
| `publish.package`, `cloud.iam.change`, `db.write.prod`, `device.actuate` | target and the complete operation |
| `file.share`, `calendar.create`, `media.export`, `net.listen` | target (people, device or port and scope) and the object |
| `config.propose`, `config.apply` | the complete plan diff |
| `grant.*`, `debug.attach`, `pod.admit`, `grant.declassify` | resource, rights, duration, persistence, requesting principal and `onBehalfOf` |
| `workflow.enroll` | definition (name, version, generation, digest), every scope item as for `grant.*`, budget ceilings, resume policy (`automatic` stated as "runs again after restarts without asking"), `runWhileLocked`, horizon, the owner and the label the workflow starts with |
| `workflow.resume`, `workflow.decide` | workflow, definition, current step, the complete question or resolution document, and for `workflow.decide` on an effect the effect's own required details |

**Caller-executed effects.** For `media.export`, `device.actuate` and `config.propose`, `gate` stages, renders and decides the intent but does not perform it. A successful `Intent.commit` returns, in `IntentStatus.result`, the base64 delivered mandate (§14.4) bound to the payload digest, and `gate` writes `effect.commit` meaning "authorized". The executor (`bench` `MediaBrowser.export`/`ExportCompletion.finish`, the device's owning service, `config` for `propose`) MUST verify the mandate (owner-presence or `service/broker` signature, payload digest, expiry, single use) before acting, and writes its own completion receipt (`media.export` by `bench`). Stagers of `media.export` are `portal-files` and `atrium` on behalf of the requesting app. **Authorization is not completion**: an intent in `committed` state of a caller-executed kind, and an effect in `authorized` state (§20.26), say only that the effect may be performed; a workflow waits for the executor's authenticated completion (its receipt, `DurableEffects.complete`) before it treats the effect as done.

#### 2.3.11e protocols §21.5 Cluster networking

- `net` creates the **cri network namespace** at its own start on `server-k8s` (veth uplink to the host, bridge `kl-cri0`), from config `cluster.*`. `warden` obtains it with `NetPlumbingCluster.clusterNetns` and starts `crid`, `kubelet` and `kube-proxy` in it. `cri` configures it dynamically with `clusterUplink` (the pod CIDR assigned through the Node object, NAT, overlay) and obtains per-pod network namespaces from `net` with op `podNetns`. This is the single exception to "only `warden` creates namespaces" (§9.1): network namespaces only.
- **`keylos.cri.uplink/1`** (JCS JSON passed to `clusterUplink`):
  - `{"schema":"keylos.cri.uplink/1","op":"uplink","podCidr":"10.244.3.0/24","clusterCidrs":["10.244.0.0/16"],"serviceCidr":"10.96.0.0/12","mtu":1450,"nat":true,"overlay":{"mode":"none" | "vxlan","vni":4242,"peers":[{"node":"…","ip":"…","podCidr":"…"}]}}` → returns the cri namespace;
  - `{"schema":"keylos.cri.uplink/1","op":"podNetns","podId":"pod-…","ip":"10.244.3.17","mac":"…","mtu":1450}` → returns a new pod namespace with a veth attached to `kl-cri0`;
  - `{"schema":"keylos.cri.uplink/1","op":"release","podId":"pod-…"}` → deletes it (returns no fd: `Fd.index` 0xFFFF).
- Pod VMs attach a **tap** device to a bridge inside the cri namespace. This is the only use of tap devices in keylos; workbench and tier-2 VMs never get one. Sealed pods get a veth pair into the same bridge.
- IPAM is host-local per pod CIDR; cross-node connectivity is direct routing or a VXLAN overlay configured by `cri`. Third-party CNI plugins are not supported; eBPF-based CNIs are not supported on the host.
- NetworkPolicy objects (watched by `cri` through the node's credential) are compiled to nftables in the cri namespace.
- With `cluster.egressViaGate = true`, pod egress to addresses outside the cluster CIDRs is redirected to a per-pod `gate` shim endpoint (`PodSpawn.egressShim`, §7.5.1; `keylos-vm` pods use their VM's `bench-net`) and is subject to gate policy. The broker attaches the pod principals' tokens at `registerSession` from policy `cluster.egress`.

#### 2.3.12 protocols §13.1 Receipt payload

```json
{
  "schema": "keylos.receipt/1",
  "seq": 1042,
  "prev": "rcpt:sha256:…",
  "time": "2026-10-07T21:30:00.123456789Z",
  "writer": "service:broker:gen:fsv256:…@_system/s-…",
  "subject": "agent:gen:fsv256:…@alice/s-…",
  "event": "grant.issue",
  "data": {"rootId": "t-…", "rights": ["path:/home/alice/src/proj:read"], "expires": "…"},
  "label": {"conf": "private", "integ": "untrusted"},
  "approval": null
}
```

Rules:
- `seq` and `prev` are assigned by `ledger`. The writer signs the payload with `seq: 0` and `prev: null` (the **submitted form**); `ledger` fills them in, countersigns the final payload, and stores both signatures with the submitted form's digest. Verifiers reconstruct the submitted form (set `seq` to 0 and `prev` to null) to verify the writer's signature, and verify `service/ledger`'s signature over the final payload.
- **Signatures.** The stored envelope carries exactly two signatures, in this order: the writer's (over the PAE of the submitted form), then `service/ledger`'s (over the PAE of the final payload). They are told apart by `keyid`; signature objects carry no other members (no `scope`).
- **Ledger-originated receipts** (events the ledger writes itself, such as its own `ledger.key.register`, `ledger.alarm`, `ledger.redact` and `ledger.shred`): `writer` is the ledger's own principal and so is `subject`, except for replays of spooled receipts (§20.22), which keep the original subject and are sealed exactly when §13.4 requires it (a person's subject); a receipt whose subject is the ledger is never sealed. The envelope carries exactly one signature, `service/ledger`'s over the final payload; there is no submitted-form signature. `subject` is never empty: a writer whose event has no natural subject names its own principal. The first receipt of an empty ledger, and of every ledger epoch after an alarm, is the ledger's own `ledger.key.register {service: "ledger", spki, keyRef}`, so readers obtain the machine key through `Ledger.serviceKey("ledger")`. Verifiers (`keylos-formats`) accept both forms.
- **Time order.** `time` is non-decreasing in `seq`. The ledger orders each group commit by (`time`, arrival) before assigning sequence numbers, and refuses a submission whose `time` is earlier than the current head's with `kl:invalid` and a message containing `re-sign`. The writer then rebuilds the submitted form with a fresh `time`, signs it again and resubmits (writer libraries do this, with bounded retries). A resubmission is a new submission; the ledger does not deduplicate, and logical deduplication is the writer's responsibility. The rule keeps every month unit, retention cut and `since`/`until` range a contiguous `seq` range, so a late receipt can never land in a month that was already shredded or expired.
- Event names are registered in §19.3.
- Receipts with personal payloads carry `sealed` instead of clear `data` and `label` (§13.4).

#### 2.3.13 protocols §19.3 Receipt events

| Event | Writer |
|---|---|
| `boot`, `shutdown`, `spawn`, `exit`, `debug.attach`, `debug.detach` | warden |
| `grant.issue`, `grant.attenuate`, `grant.delegate`, `grant.revoke`, `grant.deny`, `label.raise`, `approval.request`, `approval.decide` | broker |
| `effect.stage`, `effect.commit`, `effect.fail`, `effect.cancel`, `effect.compensate`, `effect.complete`, `effect.unknown`, `effect.resolve`, `net.connect` (sampled per policy), `net.listen`, `budget.charge`, `budget.exhausted`, `budget.carve`, `budget.open`, `budget.settle`, `budget.close` | gate (for caller-executed kinds, §14.2, and for every durable effect, `effect.commit` means "authorized"; `effect.complete` records a confirmed outcome and `effect.unknown` an unknown one, §20.26; the executor of a caller-executed kind writes its own completion receipt) |
| `secret.open`, `secret.store`, `secret.delete` | vault |
| `gen.install`, `gen.seal`, `gen.revoke`, `gen.gc` | depot |
| `update.stage`, `update.commit`, `update.rollback` | courier |
| `config.plan`, `config.apply`, `config.revert`, `config.activation-rollback` | config |
| `txn.begin`, `txn.commit`, `txn.abort`, `txn.undo`, `snapshot.create`, `snapshot.delete`, `unit.create`, `unit.forget`, `backup.run`, `backup.restore-test`, `anchor.rollback-detected` | strata |
| `agent.start`, `agent.stop`, `agent.merge`, `model.change` | aide |
| `workflow.enroll`, `workflow.claim`, `workflow.step`, `workflow.wait`, `workflow.pause`, `workflow.resume`, `workflow.outcome-unknown`, `workflow.resolve`, `workflow.migrate`, `workflow.complete`, `workflow.fail`, `workflow.cancel`, `workflow.forget`, `workflow.recover`, `workflow.rollback-detected` | loom (§20.25: minimal transition metadata, never model or tool content) |
| `user.login`, `user.lock`, `user.create`, `user.delete`, `key.enroll`, `key.remove`, `presence.assert`, `seal.window`, `quorum.request`, `quorum.complete`, `guest.start`, `guest.end` | hearth |
| `device.grant`, `device.authorize`, `device.deauthorize` | devd |
| `net.change` | net |
| `vm.start`, `vm.stop`, `vm.snapshot`, `vm.fork`, `vm.commit`, `vm.discard`, `media.attach`, `media.eject`, `media.export` | bench |
| `recovery.enter`, `recovery.delay`, `recovery.wipe` | recovery environment (`rescue`), spooled (§20.22) and appended by ledger |
| `legacy.import`, `legacy.open` | compat |
| `journal.segment` | journal |
| `ledger.key.register`, `ledger.redact`, `ledger.alarm`, `ledger.witness`, `ledger.export`, `ledger.shred` | ledger |
| `fleet.enrol`, `fleet.unenrol`, `fleet.policy.apply`, `fleet.command`, `fleet.attest` | fleet |
| `vouch.pair`, `vouch.remove`, `vouch.witness.cosigned`, `vouch.witness.conflict` | vouch |
| `pod.admit`, `pod.deny`, `pod.start`, `pod.stop` | cri |

**Recovery-replayable events.** The recovery environment cannot reach `ledger`; it spools receipts (`keylos.pendingreceipt/1`), which `ledger` appends at the next normal boot with `writer = service:ledger` and an extra field `onBehalfOf` naming the original writer. Only these events are recovery-replayable: `key.enroll`, `key.remove`, `presence.assert`, `config.revert`, `config.apply`, `update.rollback`, `user.create`, `recovery.enter`, `recovery.delay`, `recovery.wipe`.

**Extension rule.** A repository MAY emit additional events named `x-<repo>.<event>` (for example `x-strata.replica.send`). They MUST be listed in that repository's spec, MUST be written only by that repository's services, and carry no semantics for other components. Events named without a prefix MUST appear in this table.

#### 2.3.14 protocols §20.10 Secret delivery

- **Primary:** a `memfd_secret(FD_CLOEXEC)` fd of the value's length plus 8, rounded up to the page size, laid out as `u64 little-endian length ‖ value ‖ zero padding`. secretmem fds are readable only through `mmap`; recipients map them `PROT_READ`, read the length, use the bytes, and zeroize and unmap on drop (`keylos-vault-client::SecretBuf`).
- **Fallback** (when `memfd_secret` is unavailable): a `memfd_create(MFD_CLOEXEC|MFD_ALLOW_SEALING|MFD_NOEXEC_SEAL)` fd with the same layout, sealed `F_SEAL_WRITE|F_SEAL_SHRINK|F_SEAL_GROW|F_SEAL_SEAL`. The receipt records `data.delivery = "memfd-sealed"`.

### 2.4 How net applies the shared contracts

| Topic | Rule |
|---|---|
| Authority for `wifiJoin`, `vpnUp`, `vpnDown` | `Net` methods take no token; the route facet is the authority (protocols §7.1, §7.3.15). net refuses these methods on every facet except `user` with `kl:denied`. |
| Vault items | Wi-Fi credentials: `_system` item `net/wifi/<hex(ssid)>`, kind `wifi`. WireGuard private and preshared keys: `_system` items named in profiles, kind `token`. Values are read through the mmap delivery of protocols §20.10 and zeroized after use. |
| Receipts | net writes `net.change` (protocols §19.3) for the events in §9. |
| Time floor | net reads `LedgerAdmin.timeFloor` on facet `time` and never lets the clock run behind it (protocols §3.6). |
| Captive sign-in | `NetCaptive.signIn()` (caller `atrium` on facet `captive`): net starts the captive-browser VM itself through `bench#net`, identifies it with `Vm.info`, admits that VM's cgroup for direct, firewall-limited egress while captive, and mints the VM session's captive token with `BrokerSystem.mintCaptive` (§4.7). `admit(vmUid)` and `admitSession(vmSession)` are superseded and MUST return `kl:unsupported`. |
| Cluster plumbing | On `server-k8s` net creates the cri network namespace at start; `NetPlumbingCluster.clusterNetns()` serves it to `warden` and `clusterUplink(keylos.cri.uplink/1)` (ops `uplink`, `podNetns`, `release`) serves `cri`, both on facet `plumbing` with caller identity checked (§4.11, protocols §21.5). These are the only namespaces net creates (protocols §9.1 exception). |
| Discovery | `NetDiscovery` is served only to `portal-discovery` on facet `discovery`. Results are opaque data to net; labelling them `public/untrusted` is `portal-discovery`'s job (protocols §14.1). |
| Listening | `setListenPorts` from gate uses the `ports` form: each `ListenPort` carries its own scope (`loopback`, `lan`, `any`) from the subject's `needs.listen` (protocols §7.5.11). net config `firewall.listenPorts` is the upper bound: a port must be listed there, and the effective scope is the narrower of the requested and the configured scope. The decision whether a principal may listen at all (`net.listen` effect) is made at gate. |
| Version probe | Every bootstrap capability implements `common.Extensible`; `version()` returns `("1.0.0", "net <semver>")`. |

---

## 3. Requirements

### 3.1 General

- **REQ-NET-001** net MUST run as tier-0 processes spawned by `warden` from `io.keylos.net`, each with its own dynamic UID, in the host network namespace (service manifest `network: "host"`).
- **REQ-NET-002** All persistent configuration MUST come from the active config generation (`/etc/keylos/net/net.json`). Runtime changes through `Net` persist only as credentials in `vault` and the list `/var/lib/keylos/net/known.json`, which `config adopt` can lift into the declaration.
- **REQ-NET-003** netd MUST reconcile kernel state to the desired state at start and after every change, so a restart never leaves the host in an undefined network state.

### 3.2 Links and addressing

- **REQ-NET-010** netd MUST manage links through rtnetlink only and MUST NOT invoke external tools.
- **REQ-NET-011** netd MUST implement a DHCPv4 client: RFC 2131; RFC 2132 options 1, 3, 6, 12, 15, 26, 51, 54, 58, 59, 119, 121; RFC 4361 client identifiers; RFC 3442 classless routes; INIT-REBOOT, RENEW and REBIND (§4.3). With `privacy = true` (default on Wi-Fi) it MUST use a random client ID per network and send no hostname.
- **REQ-NET-012** IPv6 MUST use kernel SLAAC with `addr_gen_mode=stable-privacy` (RFC 7217) plus temporary addresses (RFC 8981) on client profiles. netd MUST read RDNSS/DNSSL (RFC 8106) from `RTM_NEWNDUSEROPT` and run DHCPv6 when RA M/O flags demand it.
- **REQ-NET-013** Wi-Fi MAC randomization MUST be on by default: a stable random locally administered address per SSID, regenerated when the network is forgotten.
- **REQ-NET-014** Link and route state MUST be observable through `Net.links` and `NetWatch.watch` within 100 ms of the kernel event.

### 3.3 Wi-Fi

- **REQ-NET-020** Wi-Fi MUST use `iwd` (≥ 2.x) confined in tier 0 and connected only to a **private D-Bus island**: a `dbus-broker` whose socket is reachable only by iwd and `net-wifi`.
- **REQ-NET-021** Credentials MUST be stored in vault (§2.4) and handed to iwd through its agent API at connect time. iwd runs with `/var/lib/iwd` on tmpfs; net provisions known networks there without passphrases.
- **REQ-NET-022** `wifiJoin` MUST be served only on facet `user`.

### 3.4 DNS

- **REQ-NET-030** `net-resolver` MUST validate DNSSEC (RFC 4033–4035; algorithms 8, 13, 14, 15) for every answer when `dnssec = 'require`, opportunistically when `'allow-downgrade` (default on client profiles), and not at all when `'off`.
- **REQ-NET-031** Upstreams MUST support DoT (RFC 7858) and DoH (RFC 8484) with certificate validation. Plain DNS on port 53 is used only when `allowPlainUpstream = true` or when no encrypted upstream is reachable and `dnssec ≠ 'require` (then marked insecure).
- **REQ-NET-032** The resolver MUST serve only facet `resolver` holders (`gate`, tier-0 services with network needs) and MUST NOT listen on any inet socket.
- **REQ-NET-033** Split DNS: names under a VPN profile's `dnsDomains` MUST resolve only through that profile's resolvers while the VPN is up, and MUST fail with `SERVFAIL` when it is down. Search domains MUST NOT be applied to names containing a dot.
- **REQ-NET-034** The cache MUST cap TTLs at 1 day, MUST NOT serve stale validated answers after RRSIG expiry, MUST randomize query IDs and source ports, and MUST apply 0x20 case randomization on plain upstreams.

### 3.5 VPN

- **REQ-NET-040** WireGuard profiles MUST be applied through generic netlink (`WG_CMD_SET_DEVICE`). Private keys MUST be read from vault and wiped after the netlink call.
- **REQ-NET-041** A profile MAY be `alwaysOn` with `killSwitch = true`; while its tunnel is down, the firewall MUST drop all egress except to the WireGuard endpoints and DHCP/ND.
- **REQ-NET-042** Routing for WireGuard MUST use policy routing (fwmark and table) so endpoints stay reachable while the default route goes through the tunnel.

### 3.6 Firewall

- **REQ-NET-050** netd MUST install the complete nftables table `inet keylos` at start and on every change in **one** atomic netlink transaction.
- **REQ-NET-051** Outbound inet traffic from host-netns sockets MUST be accepted only for UIDs in `egress_uids` (net's own processes plus those published by `NetPlumbing.setEgressUids`), for `local_link_uids` to local-link destinations (§4.4), for admitted captive UIDs (§4.7), and for kernel-generated ICMP. Everything else MUST be rejected with `admin-prohibited` and logged with a rate limit.
- **REQ-NET-052** Inbound: default drop; allow established/related, ICMP/ICMPv6 essentials (RFC 4890), DHCP replies, WireGuard listen ports, mDNS on local links when `local_link_uids` is non-empty, and ports in the active listen set.
- **REQ-NET-053** `NetPlumbing.setListenPorts` MUST accept only ports (with matching protocol) in config `firewall.listenPorts`; any other port makes the whole call fail with `kl:denied` and leaves the set unchanged. When `ports` is non-empty, `tcp` and `udp` MUST be empty (`kl:invalid` otherwise); the legacy `tcp`/`udp` form is treated as scope `lan` for every port.
- **REQ-NET-054** `setEgressUids` and `setLocalLinkUids` are accepted only from `warden`, `setListenPorts` only from `gate` (facet `plumbing`, caller identity checked).
- **REQ-NET-055** Forwarding MUST be disabled except on the `router` profile and, on `server-k8s`, between the `kl-criup` uplink and the configured uplink links for the pod CIDR (§4.11).
- **REQ-NET-056** Inbound acceptance of a listen-set port MUST follow its **effective scope**, the narrower of the scope in the `ListenPort` and the scope configured for that port (`loopback` < `lan` < `any`): `lan` accepts only sources in `onlink4`/`onlink6`; `any` accepts every source; `loopback` ports are never added to the inet input chain.

### 3.7 Time

- **REQ-NET-060** `net-time` MUST use NTS servers from config (default: four servers from at least two operators) and MUST NOT use unauthenticated sources unless `allowUnauthenticated = true` (never set by default profiles).
- **REQ-NET-061** The clock is **trusted** only after a sync in which at least `minimumAgreeing` (default 2) NTS sources agree within 100 ms. Until then `Net.time` returns `synced = false`.
- **REQ-NET-062** At start, before any sync, net-time MUST step the clock forward to `LedgerAdmin.timeFloor` if the clock is earlier. Forward steps of any size are allowed at the first sync; backward steps larger than 1 s require 3 agreeing sources and are logged at warning; no step may go below the time floor.
- **REQ-NET-063** net MUST publish `NetEvent.timeTrusted` on every change of trust state.

### 3.8 Captive portals

- **REQ-NET-070** After each link reaches `Configured` with a default route, netd MUST probe `http://<probeHost>/generate_204` (config list, tried in order) with a 5 s timeout from its own UID, following no redirects.
- **REQ-NET-071** A response other than `204` marks the link `captive`. While any default-route link is captive, `NetEvent.captive = true` is published, and `gate` refuses non-captive egress (gate spec).
- **REQ-NET-072** `NetCaptive.signIn()` MUST be served only to `atrium` (facet `captive`) and only while a default-route link is captive (`kl:denied` otherwise). It MUST start the captive VM itself through `bench#net` (purpose `captive`, image config `captive.browserImage`, `display = true`, no shares, `bootArgs` `captive.url` = the detected portal URL), verify the purpose with `Vm.info`, admit exactly the cgroup returned by `Vm.info` (TCP 80/443 to any address, TCP/UDP 53 to the captive link's resolvers), call `BrokerSystem.mintCaptive(session)`, and return `expires = now + min(admitSeconds, 600 s)`. A second call while the VM runs returns the same `expires`.
- **REQ-NET-076** The admission rule and the captive VM MUST be removed at expiry, when the link leaves captive state, or when the VM's session ends, whichever comes first; net MUST call `Vm.stop` in the first two cases. `NetCaptive.admitSession` MUST return `kl:unsupported`.
- **REQ-NET-097** `NetCaptive.endSignIn()` (caller `atrium`, facet `captive`; `protocols §7.5.11`) MUST stop the captive VM (`Vm.stop`), remove its admission rule and revoke its direct egress immediately, in one nft transaction, and emit `net.change {kind: "captive.end"}`. It is idempotent: with no captive VM running it returns without error.
- **REQ-NET-074** `NetCaptive.admit(vmUid)` MUST return `kl:unsupported` (superseded before release, protocols §7.5.11).
- **REQ-NET-075** `NetCaptive.portalUrl()` MUST return the portal URL detected by the last probe (§4.7), or `kl:not-found` when no link is captive.
- **REQ-NET-073** net MUST re-probe every 10 s while captive and every 5 min while online (only on link change on the `server` profile).

### 3.9 Metered

- **REQ-NET-080** A link is metered if config marks it, if DHCP option 43 contains `ANDROID_METERED`, if it is WWAN, or if the user overrides it at runtime. The state MUST be exposed in `Link.metered` and `NetEvent.metered`.

### 3.10 Cluster networking (`server-k8s`)

- **REQ-NET-090** Cluster networking MUST be active only when the active profile is `server-k8s` (protocols §2.2) and config `cluster.enabled = true`; otherwise `clusterUplink` and `clusterNetns` fail with `kl:unsupported`.
- **REQ-NET-091** net MUST create the cri network namespace at its own start, before signalling readiness to warden (§4.11), and MUST reuse an existing one after a net restart. `clusterNetns` MUST be served only to `warden`.
- **REQ-NET-092** Every value that shapes host routing and NAT (pod CIDRs, cluster CIDRs, service CIDR, overlay mode, node CIDRs) MUST come from net config `cluster.*`. A `keylos.cri.uplink/1` request MAY only narrow them; a value outside config fails with `kl:denied`. `clusterUplink` MUST be served only to `cri` and MUST reject documents whose `schema` is not `keylos.cri.uplink/1` or whose `op` is unknown (`kl:invalid`).
- **REQ-NET-093** Op `uplink` MUST be idempotent and atomic (one nftables transaction); op `podNetns` MUST allocate each IP at most once per pod CIDR; op `release` MUST be idempotent.
- **REQ-NET-094** Pod egress leaving the node to non-cluster destinations MUST be source-NATed on the uplink when the request's `nat` and config `cluster.masquerade` are both true; traffic to cluster CIDRs MUST NOT be NATed.
- **REQ-NET-095** The host firewall MUST NOT accept traffic from the cri netns to host-netns services except DNS to `net-resolver`'s cluster listener (`cluster.hostDns`) and the overlay port from configured node CIDRs.
- **REQ-NET-096** net MUST NOT create any other namespace, and MUST create pod namespaces only through op `podNetns`.

### 3.11 Discovery

- **REQ-NET-100** `NetDiscovery.browse` MUST run mDNS/DNS-SD queries (RFC 6762, RFC 6763) only on links whose config has `discovery = true` (default on desktop and laptop links, off elsewhere) and stream each resolved instance as `ServiceInstance` JSON (protocols §7.3.15).
- **REQ-NET-101** `NetDiscovery.publish(instance, type, port, txt, forUid)` MUST refuse a port that is not in the current listen set with scope `lan` or `any` (`kl:denied`), MUST answer only on links with `discovery = true`, and MUST withdraw the record (goodbye packet, TTL 0) when the returned handle is cancelled or the connection drops.
- **REQ-NET-102** net MUST rate-limit browse queries to 1 query per service type per link per second and cap cached instances at 4 096.

---

## 4. Design

### 4.1 Processes

| Process | Function | Capabilities | Notes |
|---|---|---|---|
| `netd` | Links, addressing, DHCP, RA, nftables, WireGuard genl, captive probe, cluster uplink, `Net`/`NetWatch`/`NetPlumbing`/`NetCaptive`/`NetPlumbingCluster` server | `CAP_NET_ADMIN`, `CAP_NET_RAW`; on `server-k8s` also `CAP_SYS_ADMIN` for `unshare(CLONE_NEWNET)` and `setns` (§6.2) | Single-threaded tokio runtime |
| `net-mdns` | mDNS/DNS-SD querier and responder; `NetDiscovery` backend | none | UDP 5353 multicast sockets only; started only when some link has `discovery = true` |
| `net-resolver` | Validating stub resolver and cache; `NetResolver`; `Net.resolve` backend | none | Upstream sockets only |
| `net-time` | ntpd-rs in NTS-only mode, plus the trust adapter | `CAP_SYS_TIME` | |
| `net-wifi-bus` | `dbus-broker` island with a two-client policy | none | |
| `net-wifi-iwd` | `iwd` | `CAP_NET_ADMIN`, `CAP_NET_RAW` | `/var/lib/iwd` on tmpfs |
| `net-wifi` | Island adapter (zbus client) | none | |

All are spawned by `warden` from the generation's `service` entrypoints; internal routes connect netd to net-resolver, net-time and net-wifi over private capwire socketpairs.

### 4.2 Link state machine (per interface)

```
 Absent ─NEWLINK─► Down ─managed ∧ carrier─► Configuring ─addr ∧ default route─► Configured ─probe 204─► Online
   ▲                ▲                            │ timeout 30 s (DHCP)                │ probe ≠ 204          │
   │                │◄──── carrier lost / admin down / DELLINK ◄────────────────────┤                      │
   │                │                            ▼                                    ▼                      │
   └── DELLINK ─────┘                         NoAddress ─retry backoff─► Configuring  Captive ─probe 204──┘
```

| State | Entry actions |
|---|---|
| Down | Remove addresses and routes netd installed; publish `linkChanged` |
| Configuring | Start DHCPv4 (or apply static); enable SLAAC; wait ≤ 3 s for the first RA |
| NoAddress | Exponential backoff 4 s → 64 s, then restart DHCP; publish state |
| Configured | Install routes and metrics; register resolvers; start the probe (unless `probe = false`) |
| Online | Publish; clear captive for this link |
| Captive | Publish `captive = true`; notify atrium; start the 10 s re-probe |

### 4.3 DHCPv4 client

**States:** INIT → SELECTING → REQUESTING → BOUND → RENEWING → REBINDING; INIT-REBOOT → REBOOTING when a stored lease for the same network exists.

**Algorithm:**
1. INIT-REBOOT: if `/var/lib/keylos/net/leases/<ifname>-<network-id>.json` exists and is unexpired, broadcast DHCPREQUEST with option 50 (requested address); wait 2 s; on NAK or timeout go to INIT.
2. INIT/SELECTING: DHCPDISCOVER with retransmission 4 s, 8 s, 16 s, 32 s (±1 s jitter); take the first offer; REQUESTING sends DHCPREQUEST with server ID.
3. On ACK: ARP probe (RFC 5227, 3 probes, 1 s apart); conflict → DHCPDECLINE, wait 10 s, INIT. Otherwise apply address, routes (option 121 over option 3), MTU (26, only 1280–9000), DNS (6) and search list (119).
4. BOUND timers: T1 = option 58 or 0.5 × lease; T2 = option 59 or 0.875 × lease. RENEWING unicasts to the server; REBINDING broadcasts; expiry → remove address, INIT.
5. **Sockets:** `AF_PACKET` (cooked, bound to the interface) for INIT/SELECTING/REBOOTING; a UDP socket bound to the leased address with `SO_BINDTODEVICE` for RENEWING.
6. **network-id** = first 16 hex chars of SHA-256(SSID or link MAC ‖ gateway MAC).

DHCPv6 (when RA M or O flags are set) follows RFC 8415 with the same lease-store layout; prefix delegation only on the `router` profile.

### 4.4 Firewall

**Ruleset** (generated; sets are filled at runtime):

```
table inet keylos {
  set egress_uids      { type uid; }                  # net processes + NetPlumbing.setEgressUids
  set local_link_uids  { type uid; }                  # NetPlumbing.setLocalLinkUids (portal-print)
  set mdns_uids        { type uid; }                  # net-mdns only
  set listen_tcp_lan   { type inet_service; }         # setListenPorts ∩ config scope lan
  set listen_tcp_any   { type inet_service; }         # setListenPorts ∩ config scope any
  set listen_udp_lan   { type inet_service; }
  set listen_udp_any   { type inet_service; }
  set wg_ports         { type inet_service; }
  set onlink4          { type ipv4_addr; flags interval; }
  set onlink6          { type ipv6_addr; flags interval; }
  set link_resolvers4  { type ipv4_addr; }
  set link_resolvers6  { type ipv6_addr; }
  set cluster4         { type ipv4_addr; flags interval; }   # server-k8s: cluster.clusterCidrs (empty otherwise)
  set cluster6         { type ipv6_addr; flags interval; }
  chain input {
    type filter hook input priority filter; policy drop;
    ct state established,related accept
    ct state invalid drop
    iif lo accept
    meta l4proto ipv6-icmp icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert,
        packet-too-big, time-exceeded, parameter-problem, destination-unreachable, echo-request } limit rate 50/second accept
    meta l4proto icmp icmp type { destination-unreachable, time-exceeded, parameter-problem, echo-request } limit rate 50/second accept
    udp dport 68 udp sport 67 accept
    udp dport 546 udp sport 547 accept
    udp dport @wg_ports accept
    tcp dport @listen_tcp_any accept
    udp dport @listen_udp_any accept
    ip saddr @onlink4 tcp dport @listen_tcp_lan accept
    ip6 saddr @onlink6 tcp dport @listen_tcp_lan accept
    ip saddr @onlink4 udp dport @listen_udp_lan accept
    ip6 saddr @onlink6 udp dport @listen_udp_lan accept
    udp dport 5353 ip saddr @onlink4 accept      # present only when local_link_uids is non-empty or discovery is on
    udp dport 5353 ip6 saddr @onlink6 accept
    iifname "kl-criup" jump cluster_in             # server-k8s only
    limit rate 5/second log prefix "keylos-in-drop " level info
  }
  chain output {
    type filter hook output priority filter; policy drop;
    oif lo accept
    ct state established,related accept
    jump killswitch
    meta skuid @egress_uids accept
    meta skuid @mdns_uids ip daddr { 224.0.0.251 } udp dport 5353 accept
    meta skuid @mdns_uids ip6 daddr { ff02::fb } udp dport 5353 accept
    meta skuid @local_link_uids ip daddr { 224.0.0.251 } udp dport 5353 accept
    meta skuid @local_link_uids ip6 daddr { ff02::fb } udp dport 5353 accept
    meta skuid @local_link_uids ip daddr @onlink4 tcp dport { 631, 443, 9100 } accept
    meta skuid @local_link_uids ip6 daddr @onlink6 tcp dport { 631, 443, 9100 } accept
    jump captive_admit
    meta l4proto { icmp, ipv6-icmp } meta skuid 0 accept
    limit rate 5/second log prefix "keylos-out-drop " level info
    reject with icmpx type admin-prohibited
  }
  chain forward {
    type filter hook forward priority filter; policy drop;
    jump cluster_fwd                               # empty unless server-k8s with cluster.enabled
  }
  chain killswitch { }        # see below
  chain captive_admit { }     # one rule pair for the captive VM's cgroup (from Vm.info, §4.7)
  chain cluster_in { }        # §4.11
  chain cluster_fwd { }       # §4.11
}
table inet keylos_nat {       # present only on server-k8s with cluster.enabled
  chain postrouting { type nat hook postrouting priority srcnat; policy accept; }   # §4.11
}
```

**Kill switch.** While an `alwaysOn` + `killSwitch` profile is down, `killswitch` contains: accept UDP to the profile's endpoint addresses and ports; accept DHCP (UDP 67/68, 546/547) and ICMPv6 ND; `reject with icmpx type admin-prohibited`. Otherwise it is empty.

**Reconciliation algorithm** (on start and every change):
1. Compute the desired ruleset text from config and the current runtime sets.
2. If it equals the last applied text (SHA-256 compare), stop.
3. Build one nft netlink batch: delete table `inet keylos` if present, add the full table with set elements.
4. Apply. On failure keep the old table (the batch is atomic), log err, and retry with exponential backoff (1 s → 60 s).
5. Write `net.change` with `data.kind = "firewall"` and the ruleset digest when the digest changes due to config or plumbing (not for captive admissions and their expiry, which have their own `captive.*` kinds).

The listen sets are filled from the last `setListenPorts` call: each `ListenPort` goes into the `_lan` or `_any` set according to its effective scope (min of requested and configured, REQ-NET-056); `loopback` ports go into neither. The current set with scopes is shown by `net status` and `net listen`.

### 4.5 DNS resolver

**Upstream selection** for a query name `q`:
1. If a VPN is up and `q` falls under one of its `dnsDomains` (longest suffix wins), use that VPN's resolvers only.
2. Else if a VPN with `dnsAll = true` is up, use its resolvers.
3. Else if `usePrivateResolvers = true` and `upstreams` is non-empty, use them (default on desktop and laptop).
4. Else use link-provided resolvers, preferring DoT: strict DoT when DDR (RFC 9462) designates a resolver name, opportunistic DoT otherwise, plain DNS last (marked insecure).

**Query algorithm:**
1. Normalize; refuse names longer than 253 bytes or with labels > 63 bytes (`FORMERR`).
2. Cache lookup by (name, type, class, upstream set id). A hit with a validated RRset whose RRSIGs have not expired is returned directly.
3. Send to the first healthy upstream of the selected set; hedge to the next after 250 ms; overall timeout 5 s.
4. Validate (DNSSEC mode): build the chain of trust from the root trust anchor (`/etc/keylos/net/root-anchors.xml` in the config generation, RFC 5011 rollover handled by config updates); results `secure`, `insecure`, `bogus`, `indeterminate`.
5. `bogus` → `SERVFAIL` (all modes except `'off`). `'require` also returns `SERVFAIL` for `indeterminate`.
6. Cache with TTL = min(record TTL, RRSIG remaining, 86 400 s); negative answers per RFC 2308 (SOA minimum, ≤ 3 600 s).
7. Return the answer with `secure` reported to the caller (`NetResolver.query` second result; `Net.resolve` `dnssec` flag).

**Upstream health:** an upstream is marked unhealthy after 3 consecutive failures and probed again every 30 s. In `'allow-downgrade` mode, an upstream that strips DNSSEC records (a probe of a signed canary zone returns no RRSIG) is marked `insecure` for that link and reported with `NetEvent.resolverInsecure`.

**Cache:** ≤ 100 000 RRsets, LRU per upstream set; flushed for a set when its links or VPNs change.

### 4.6 WireGuard

- **Profile:** `{name, privateKeyItem, address[], dns[], dnsDomains[], dnsAll, peers[{publicKey, presharedKeyItem?, endpoint, allowedIps[], keepalive?}], mtu?, fwmark, table, alwaysOn, killSwitch}`.
- **Bring-up:**
  1. Resolve endpoint names through net-resolver using link resolvers only.
  2. Create link `wg-<name>` (rtnetlink, kind `wireguard`).
  3. Read keys: `vault.open(privateKeyItem)` (and preshared keys), map, build `WG_CMD_SET_DEVICE`, send, zeroize, unmap.
  4. Add addresses; set MTU.
  5. Policy routing: rule `not fwmark <fwmark> table <table>` (full tunnel) plus `default dev wg-<name> table <table>`, or specific routes (split tunnel). Set `fwmark` on the device.
  6. Publish DNS to the resolver; publish `vpnChanged`; write `net.change`.
- **Monitoring:** read handshake age every 10 s; a profile with no handshake for 180 s is reported `stale`; endpoint names are re-resolved every 5 min.
- **Tear-down:** reverse order; kill switch engaged if `alwaysOn ∧ killSwitch`.

### 4.7 Captive-portal flow

net owns the whole sign-in: atrium only asks for it and displays the resulting window (protocols §7.5.11 `signIn`, §19.2 `bench#net`).

```
netd: link Configured → probe ≠ 204 → link Captive; remember portalUrl
  ├─ NetWatch: captive=true → gate pauses non-captive egress (gate spec); atrium notified
  ├─ TrustedPrompt.notify("Sign in to <ssid>")
  └─ user clicks "Sign in to network" → atrium → NetCaptive.signIn()          (facet captive, caller atrium only)
       netd:
        1  require some default-route link is captive                          ?→ kl:denied
        2  if a captive VM is already running: return its expires              # idempotent while it lives
        3  vm := Bench.start(VmSpec{purpose: captive, image: config captive.browserImage
                                    (default io.keylos.bench.captive-browser), display: true, shares: [],
                                    bootArgs: [("captive.url", portalUrl)], memoryMiB: 768, vcpus: 1})   # bench#net
        4  (session, cgroupId, cid, purpose) := vm.info();  require purpose == captive   ?→ vm.stop(); kl:integrity
        5  scope := cgroup path of cgroupId (resolved through /proc/self/mountinfo + open_by_handle_at on the
           cgroup2 mount; exactly one scope, under /keylos.slice)               ?→ vm.stop(); kl:not-found
        6  captive_admit += { socket cgroupv2 level L "<scope>" tcp dport { 80, 443 } accept
                              socket cgroupv2 level L "<scope>" ip[6] daddr @link_resolvers{4,6} th dport 53 accept }
        7  BrokerSystem.mintCaptive(session)       # broker attaches a captive(true), tier_floor(2) token ≤ 10 min
                                                   # to the VM session; bench-net reads it with Broker.myGrants
        8  expires := now + min(captive.admitSeconds, 600 s); schedule vm.stop() and rule removal at expires
        9  receipt net.change {kind: "captive.admit", link, vmSession: session, expires}
       10  return expires
  the VM's window appears through atrium's Display like any tier-3 VM; the guest browser opens captive.url
netd re-probes every 10 s → 204 → link Online
  ├─ captive_admit flushed; vm.stop(); NetWatch captive=false → gate resumes
  └─ receipt net.change {kind: "captive.leave"}
```

- `NetCaptive.status()` returns `(captive, ssid, portalUrl)`; `portalUrl` is the `Location` of the probe's redirect when present, else `http://<probeHost>/`. `portalUrl()` returns the same URL.
- net identifies the VM only through the `Vm` capability it obtained itself (`Vm.info`): no cgroup-path scanning by session name and no trust in a third party's claim about purpose or image. The cgroup match covers every process of the VM principal (crosvm device processes and `bench-net`) and nothing else. `L` is the depth of the scope below the cgroup root.
- When the user closes the sign-in window, atrium calls `NetCaptive.endSignIn()`: netd removes the admission rule in one nft transaction, calls `vm.stop()`, drops the `Vm` capability and emits `net.change {kind: "captive.end"}` (REQ-NET-097).
- When the VM exits early for another reason, bench ends its session; warden removes the scope and the rule stops matching; netd removes the rule on its next reconciliation (≤ 10 s) and drops the `Vm` capability.
- Admitted traffic bypasses `gate` only for TCP 80/443 and DNS: the VM is disposable, has no shares, no vault access, and the firewall limits it for at most 600 s. Its other flows go through `bench-net` → gate with the captive token.
- `admit(vmUid)` and `admitSession(vmSession)` return `kl:unsupported` (superseded before release, protocols §7.5.11).

### 4.8 Time discipline

- **Floor:** at start, `net-time` calls `LedgerAdmin.timeFloor()`; if `CLOCK_REALTIME` < floor, it steps the clock to the floor. If the ledger is unavailable it retries every 1 s for 30 s, then continues and retries in the background (the clock stays untrusted).
- **ntpd-rs configuration** generated by net-time:

```toml
[observability]
observation-path = "/run/keylos/net-time/observe"
[[source]]
mode = "nts"
address = "time.cloudflare.com"
# … one [[source]] per configured NTS server
[synchronization]
minimum-agreeing-sources = 2
single-step-panic-threshold = { forward = "inf", backward = 1.0 }
startup-step-panic-threshold = { forward = "inf", backward = 86400 }
```

- **Trust algorithm** (adapter, every 1 s from the observation socket):
  1. `synced` = ntpd-rs reports a selected system peer set of ≥ `minimumAgreeing` sources with offsets within 100 ms of each other.
  2. On the transition to `synced`, publish `timeTrusted(true)`.
  3. If no agreeing set exists for 1 h, publish `timeTrusted(false)` and notify atrium.
  4. Any proposed step below the floor is refused (the adapter clamps by restarting ntpd-rs with the floor applied) and logged at warning.

### 4.9 Wi-Fi

**Island:** `net-wifi-bus` runs `dbus-broker` with policy `island/dbus-policy.xml` allowing exactly two connections: iwd (owner of `net.connman.iwd`) and `net-wifi`. The bus socket lives in a directory reachable only in the island's mount namespaces.

**Join sequence (`wifiJoin(ssid, credential)`):**
1. Validate the credential: passphrase 8–63 printable ASCII or 64 hex for PSK/SAE; JSON for 802.1X (`{"eap": "peap"|"ttls"|"tls", "identity", "password"?, "caCertItem"?, "clientCertItem"?}`); empty for open/OWE.
2. `vault.store("net/wifi/<hex(ssid)>", "wifi", credential, acl{actors:["service:net:*"], ops:[read], prompt: never})`.
3. Write the iwd known-network file to tmpfs without secrets; set `AutoConnect`.
4. `Station.ConnectHiddenNetwork` or `Network.Connect`.
5. iwd calls the agent (`RequestPassphrase` / `RequestUserNameAndPassword`); net-wifi fetches the item with `vault.open`, replies, zeroizes.
6. On success add the SSID to `known.json` (no secrets), apply the per-SSID MAC, write `net.change`. On `net.connman.iwd.Failed` with authentication error: delete the vault item, fail `kl:denied`.

**Forget:** delete the vault item and known entry, regenerate the per-SSID MAC, write `net.change`.

### 4.10 Per-namespace plumbing (cooperation with warden, gate, bench)

| Principal kind | Namespace network | Egress |
|---|---|---|
| Tier 0 (non-net) and tier 1 | Private netns, `lo` only | Sockets from `gate` |
| Tier L | Private netns, `lo` only, nftables redirect installed by warden | `gate-shim` → `ShimEndpoint` → gate |
| Tier 2/3 VMs | Guest stack; one virtio-net device terminated by `bench-net` on the host | `bench-net` → `ShimEndpoint` → gate (captive VM: §4.7) |
| Pods (`server-k8s`) | cri network namespace built by net (§4.11); everything inside it is `cri`'s | Forwarded through `kl-cri0` with NAT; with `cluster.egressViaGate`, `cri` redirects non-cluster egress to gate pod shims |
| net, gate-net, local-link UIDs | Host netns | Direct, firewalled by UID |

Apart from the cri uplink, net never creates veth pairs, bridges, taps or NAT for principals.

### 4.11 Cluster networking (`server-k8s`)

On `server-k8s` with `cluster.enabled = true`, net creates the **cri network namespace** at its own start; this and the pod namespaces of op `podNetns` are the single exception to "only `warden` creates namespaces" (protocols §9.1, §21.5), and they are network namespaces only.

**Creation at start (before net reports ready to warden):**

```
 1  require profile == server-k8s ∧ cluster.enabled                    (else skip the whole section)
 2  if /run/keylos/net/cri-netns exists and is an nsfs mount: reuse it (net restart), go to 7
 3  unshare(CLONE_NEWNET) in a short-lived netd helper thread; bind-mount /proc/self/task/<tid>/ns/net
    at /run/keylos/net/cri-netns; setns back to the host netns
 4  veth pair "kl-criup" (host) ↔ "uplink0" (cri netns); bridge "kl-cri0" inside the cri netns (uplink0 is
    NOT enslaved: the bridge is the pods' L2 segment, uplink0 is the routed path to the host)
 5  host: 169.254.244.1/30 and fe80::1 on kl-criup; cri netns: 169.254.244.2/30 on uplink0, default route via
    169.254.244.1, lo up, net.ipv4.ip_forward=1 and net.ipv6.conf.all.forwarding=1 inside the cri netns only
 6  host sysctls: forwarding=1 on kl-criup and the configured uplink links only (all others stay 0); rp_filter=1
    on kl-criup
 7  firewall: cluster_in (host) accepts from kl-criup only DNS to net-resolver's cluster listener (cluster.hostDns)
    and the overlay port; cluster_fwd (host) stays empty until the first op "uplink"
 8  receipt net.change {kind: "cluster.netns"}
```

`clusterNetns()` (facet `plumbing`, caller `warden` only) returns an `O_RDONLY` fd of `/run/keylos/net/cri-netns`; warden starts the services with `services.json` `network: "cluster"` (`crid`, `kubelet`, `kube-proxy`) inside it (protocols §20.16). It fails `kl:unavailable` until step 8 has run and `kl:unsupported` on other profiles.

**`clusterUplink(configJson)`** (facet `plumbing`, caller `cri` only) takes `keylos.cri.uplink/1` (protocols §21.5) and dispatches on `op`:

| `op` | Validation | Effect | Returns |
|---|---|---|---|
| `uplink` | `podCidr` ⊆ config `cluster.podCidrs` (v4 and v6 independently); `clusterCidrs` ⊆ config `cluster.clusterCidrs`; `serviceCidr` = config `cluster.serviceCidr`; `mtu` ≤ uplink MTU − (50 if `overlay.mode = vxlan`); `overlay.mode` ∈ {`none`, config `cluster.overlay`}; every `peers[].ip` inside config `cluster.nodeCidrs` | Host routes `podCidr` via 169.254.244.2 (kl-criup); `cluster_fwd` rules (uplink ↔ kl-criup for `clusterCidrs`, established/related return traffic); NAT `oifname @uplinks ip saddr podCidr ip daddr != @cluster masquerade` when `nat` (and config `cluster.masquerade`); `cluster_in` VXLAN port from `@nodes` when overlay is `vxlan` (the VXLAN device itself is created by `cri` inside the cri netns). Repeating the call with a changed peer list or CIDR replaces the previous state atomically (one nft transaction). | the cri netns fd |
| `podNetns` | `podId` matches `pod-…` (protocols §3.5); `ip` ∈ the current `podCidr` and not already allocated; `mtu` ≤ the uplink op's `mtu` | Create a network namespace (helper thread as in step 3) bind-mounted at `/run/keylos/net/pods/<podId>`; veth `eth0` (pod) ↔ `kp<8 hex of podId>` (cri netns) attached to `kl-cri0`; pod side: `ip`, `mac`, MTU, `lo` up, default route via the bridge gateway (`podCidr` .1, which `cri` assigns to `kl-cri0`) | the pod netns fd |
| `release` | `podId` known | Delete the veth and unmount/remove `/run/keylos/net/pods/<podId>`; idempotent for unknown IDs after a crash (no-op) | no fd (`Fd.index` 0xFFFF) |

- `cri` holds `CAP_NET_ADMIN` only inside the cri netns (protocols §21.5) and builds the bridge address, pod taps (for `keylos-vm` pods), the VXLAN device, IPAM and NetworkPolicy nftables there. net never modifies the inside of the cri netns after creation, except veths for `podNetns`.
- `cluster.hostDns = true` makes `net-resolver` listen on `169.254.244.1:53` (UDP/TCP) for queries from the cri netns.
- On every start net reconciles `/run/keylos/net/pods/*` with its persisted allocation table (`/var/lib/keylos/net/cluster.json`) and removes orphans that have no attached process left (checked with `NS_GET_NSTYPE` + `/proc/*/ns/net` inode scan).
- Teardown (`cluster.enabled` set false in a new config generation): release every pod netns, delete `kl-criup`, flush `cluster_*` chains and NAT rules, unmount and remove `/run/keylos/net/cri-netns`, write `net.change {kind: "cluster.down"}`.

### 4.12 Discovery (`net-mdns`)

- **Querier:** `browse(serviceType, onLink, watcher)` sends PTR queries for `<serviceType>.local` on the named link (or all `discovery` links when `onLink` is empty) with the RFC 6762 §5.2 continuous-query backoff (1 s, 2 s, 4 s … 60 min), resolves SRV, TXT, A and AAAA, and pushes one `ServiceInstance` JSON per resolved instance (and a JSON `{"removed": "<instance>"}` on goodbye or TTL expiry). Known-answer suppression is used. The watcher is held until the caller cancels.
- **Responder:** `publish(instance, type, port, txtJson, forUid)` probes the instance name (three probes, 250 ms apart; on conflict appends ` (2)`, ` (3)` …), announces twice, answers queries on discovery links, and withdraws on cancel. `port` MUST be in the current listen set with scope `lan` or `any` (REQ-NET-101). `forUid` is recorded in the `net.change` receipt to attribute the publication; it does not grant anything.
- **Hostname:** published records use `<machine-name>-<4 hex>.local` from config, never the user's name.
- **Sockets:** `net-mdns` binds UDP 5353 with `SO_REUSEADDR` on the discovery links (IPv4 224.0.0.251, IPv6 ff02::fb). Its UID is in the set `mdns_uids`, whose output rules allow only the mDNS groups and port; it is **not** in `egress_uids`.

---

## 5. Interfaces

### 5.1 Facets and method semantics

Facets are those of protocols §19.2 (embedded in §2.3.10).

| Method | Semantics |
|---|---|
| `links()` | All managed links: `state` ∈ {`down`, `configuring`, `noaddress`, `configured`, `online`, `captive`}; addresses in CIDR; `metered`. On facet `status`, addresses are redacted to their prefix |
| `wifiScan()` | Triggers an iwd scan (rate limited to one per 10 s) and returns merged results; `security` ∈ {`open`, `owe`, `wpa2-psk`, `wpa3-sae`, `wpa2-wpa3`, `8021x`} |
| `wifiJoin(ssid, credential)` | §4.9. Errors: `kl:invalid`, `kl:denied` (authentication failed), `kl:not-found` (SSID not visible), `kl:unavailable` (no Wi-Fi device) |
| `vpnUp(profile)` / `vpnDown(profile)` | Idempotent; `kl:not-found` for unknown profiles |
| `resolve(name)` | A and AAAA through the resolver; `dnssec = true` only if validated secure |
| `time()` | `(synced, offsetNanos, source)` from §4.8 |
| `status()` | JCS JSON: links, routes, resolvers in use (with `insecure`), VPNs (handshake age), time, captive, metered, listen set, firewall digest |
| `NetWatch.watch` | Pushes `NetEvent`s; the first events after subscription are the current state of each kind |
| `NetResolver.query(wire)` | One question; returns the response wire and `secure` |
| `NetPlumbing.*` | REQ-NET-053, REQ-NET-054; each call replaces the whole set |
| `NetCaptive.status`, `portalUrl`, `signIn`, `endSignIn` | §4.7; facet `captive`, caller `atrium`; `admit` and `admitSession` → `kl:unsupported` |
| `NetPlumbingCluster.clusterUplink` | §4.11; facet `plumbing`, caller `cri` only; ops `uplink`, `podNetns`, `release` |
| `NetPlumbingCluster.clusterNetns` | §4.11; facet `plumbing`, caller `warden` only |
| `NetDiscovery.browse`, `publish` | §4.12; facet `discovery`, caller `portal-discovery` only |

### 5.2 CLI: `net`

| Command | Description | Exit codes |
|---|---|---|
| `net status [--json]` | Summary | 0 |
| `net links` | Records: name, kind, state, addresses, metered | 0 |
| `net wifi scan` | Records: ssid, security, signal, known | 0, 2 no Wi-Fi |
| `net wifi join <ssid> [--passphrase-stdin]` | Passphrase from atrium's secret prompt by default, or stdin | 0, 1 authentication failed, 2 error |
| `net wifi forget <ssid>` | §4.9 | 0, 1 |
| `net vpn up\|down <profile>` / `net vpn list` | | 0, 1 not found, 2 |
| `net dns query <name> [--type T]` | Through the resolver; shows the DNSSEC state | 0, 1 NXDOMAIN, 2 SERVFAIL |
| `net time` | Synced, offset, sources | 0 synced, 1 not synced |
| `net firewall show` | Current ruleset (read-only) | 0 |
| `net metered <link> on\|off\|auto` | Runtime override until reboot | 0 |
| `net captive` | Captive status, portal URL and the captive VM if running (session, expiry) | 0 captive, 1 not captive |
| `net cluster` | Cluster state: namespace, pod CIDR, overlay, NAT, allocated pod namespaces, forwarding counters (`server-k8s`) | 0, 1 not enabled |
| `net discovery [--link L]` | Active browse subscriptions and published records (owner) | 0 |

All commands accept `--format text|json|records`.

### 5.3 Files

| Path | Purpose |
|---|---|
| `/etc/keylos/net/net.json` | Rendered config |
| `/etc/keylos/net/root-anchors.xml` | DNSSEC trust anchors |
| `/var/lib/keylos/net/leases/` | DHCP leases (no secrets) |
| `/var/lib/keylos/net/known.json` | Runtime-joined networks (no secrets) |
| `/var/lib/keylos/net/macs.json` | Per-SSID random MACs |
| `/var/lib/keylos/net/firewall.sha256` | Digest of the last applied ruleset |
| `/run/keylos/net-time/observe` | ntpd-rs observation socket |
| `/run/keylos/net-wifi/bus` | Island socket (island mount namespaces only) |
| `/run/keylos/net/cri-netns` | Bind mount holding the cri network namespace (`server-k8s`) |
| `/run/keylos/net/pods/<podId>` | Bind mounts holding pod network namespaces (op `podNetns`) |
| `/var/lib/keylos/net/cluster.json` | Pod netns allocation table (podId → IP, veth) for reconciliation |

---

## 6. Security

### 6.1 Threats and mitigations

| Threat | Mitigation |
|---|---|
| A principal bypasses gate with inet sockets | Principals have `lo`-only netns; the UID allowlist (REQ-NET-051) is a second layer |
| Rogue DHCP or RA poisons DNS or routes | Private DoH/DoT resolvers by default; option 121 routes only for on-link prefixes and the default route; route metrics under net's control |
| DNS spoofing | DoT/DoH with certificate validation; DNSSEC; randomized IDs, ports, 0x20 |
| Clock rollback to revive expired tokens or certificates | NTS only; agreement of ≥ 2 sources; ledger time floor; bounded backward steps (REQ-NET-062) |
| iwd compromise via a malicious AP | iwd is confined (own UID, tmpfs state, Landlock) and reaches only the island bus |
| Captive portal attacks the host | The portal renders only in a disposable tier-2 VM with no shares and no secrets; other egress is paused; admission is time-limited and port-limited |
| Wi-Fi or VPN key leakage | Keys only in vault; mmap delivery; zeroized after use; iwd state on tmpfs |
| Tracking via MAC or hostname | Per-SSID random MACs; no hostname and random client ID on Wi-Fi |
| VPN leaks | Kill switch; split DNS confined to declared domains; policy routing |
| Abuse of plumbing calls | Caller identity checks (REQ-NET-054); listen ports limited to config (REQ-NET-053) |
| Captive admission abused to bypass gate | Admission only while captive, only for a VM session bench vouches for, by cgroup, ports 80/443/53, ≤ 600 s (REQ-NET-072) |
| Pods reach host services or the LAN | `cluster_in` admits only the overlay port and optional DNS; forwarding limited to `kl-criup` ↔ uplinks; cri-supplied values cannot widen config (REQ-NET-092) |
| mDNS spoofing or name squatting | Browse results are untrusted data labelled by portal-discovery; publishing requires a listen-set port; conflict probing per RFC 6762 |

### 6.2 Confinement of net itself

| Aspect | netd | net-resolver | net-time | net-wifi-iwd | net-wifi-bus, net-wifi |
|---|---|---|---|---|---|
| Tier | t0 | t0 | t0 | t0 | t0 |
| Network namespace | host | host | host | host | host (no inet use) |
| Capabilities | `CAP_NET_ADMIN`, `CAP_NET_RAW`; `CAP_SYS_ADMIN` only on `server-k8s` (for the cri netns, below) | — | `CAP_SYS_TIME` | `CAP_NET_ADMIN`, `CAP_NET_RAW` | — |
| Landlock fs | rw `/var/lib/keylos/net`; ro `/etc/keylos/net` | ro `/etc/keylos/net` | rw `/run/keylos/net-time` | rw `/var/lib/iwd` (tmpfs) | rw island socket dir |
| Landlock net (KL3) | connect TCP 80 (probe); bind/connect UDP 67, 68, 546, 547 | connect TCP 53/853/443, UDP 53 | connect TCP 4460, UDP 123 | — (netlink, packet) | — |
| seccomp beyond baseline | `socket(AF_NETLINK, AF_PACKET, AF_INET*)`, `setsockopt(SO_BINDTODEVICE)`; on `server-k8s` `unshare(CLONE_NEWNET)` (no other flag), `setns(fd, CLONE_NEWNET)`, `mount(MS_BIND)` of `/proc/self/task/*/ns/net` onto `/run/keylos/net/cri-netns` and `/run/keylos/net/pods/*` only | inet sockets | `clock_adjtime`, `clock_settime`, `adjtimex` | netlink, packet, `ioctl(SIOC*)` allowlist | — |
| Routes | §2.2 | netd only | netd, `ledger#time` | island only | netd (net-wifi), `vault#net` (net-wifi) |

### 6.3 Residual risks

- Kernel networking code reachable from net and gate-net (netlink, nftables) is in the TCB. Other principals have no `CAP_NET_ADMIN` in any namespace and cannot create user namespaces.
- DNSSEC `'allow-downgrade` on hostile networks can be silently insecure; status and `resolverInsecure` events show it, and `'require` is available.
- iwd and dbus-broker are C code in tier 0, confined and reachable only from the island.
- Captive-portal admission lets one disposable VM reach the network directly for up to 10 minutes.
- **netd creates a network namespace** on `server-k8s` (the cri namespace), which departs from "only warden creates namespaces" ([ADR-0025](../../handbook/11-decisions/adr-0025-namespaces-only-by-warden.md)). The exception is bounded (protocols §9.1, §21.5): network namespaces only (the cri namespace plus one per pod for op `podNetns`), never a user namespace, seccomp-filtered to `CLONE_NEWNET`, recorded in netd's confinement report as `compensations: ["cri-netns"]`, and absent on every other profile.
- Forwarding and NAT on `server-k8s` put more kernel networking code in reach of pod traffic.

---

## 7. Failure modes and recovery

| Failure | Behaviour |
|---|---|
| netd crash | warden restarts it; kernel state persists; netd reconciles (§4.4, links diffed via netlink dump) |
| net-resolver crash | Restarted ≤ 1 s; gate queries fail `kl:unavailable` meanwhile; cache lost |
| net-time crash | Restarted; trust recomputed; `timeTrusted(false)` published if not re-established in 60 s |
| iwd or island crash | Wi-Fi drops; warden restarts the island; netd reconnects to the last network |
| All NTS servers unreachable | `synced = false`; consumers use the ledger floor; atrium notified after 1 h |
| Ledger unavailable at start | Clock untrusted until the floor is read or NTS sync completes |
| DNSSEC bogus answers | `SERVFAIL`; logged with the zone |
| vault unavailable | Wi-Fi joins and VPN bring-up fail `kl:unavailable`; established links continue |
| Invalid net section in config | Rejected by config before signing; if present anyway, netd keeps the previous state and logs err |
| Kill-switch VPN cannot connect | Egress blocked by design; status explains; owner `net vpn down` lifts it until reboot |
| nft apply fails | Old table stays (atomic batch); retry with backoff; status shows `firewall: stale` |
| DHCP server unreachable | `noaddress` with backoff; IPv6 may still bring the link to `configured` |
| `Bench.start` of the captive VM fails (RAM class cap, image missing) | `signIn` fails with bench's error; nothing admitted |
| `Vm.info` reports a purpose other than `captive`, or no unique scope for its cgroup | VM stopped; `signIn` fails `kl:integrity` / `kl:not-found` |
| `mintCaptive` fails (broker unavailable) | Firewall admission rolled back, VM stopped, `signIn` fails `kl:unavailable` |
| `podNetns` for a pod whose IP is already allocated | `kl:conflict`; nothing created |
| net restarts with pods running | Pod namespaces persist (bind mounts); the allocation table is reloaded; orphans removed (§4.11) |
| netd restart on `server-k8s` | The cri namespace survives (bind mount); netd re-reads it and reconciles `cluster_*` chains and NAT |
| net-mdns crash | Browse watchers end; portal-discovery re-subscribes; published records are re-announced from netd's record of handles |

---

## 8. Performance budgets

| Metric | Budget |
|---|---|
| Link up → configured (DHCPv4 INIT-REBOOT) | ≤ 500 ms on a typical LAN |
| Link up → online (probe included) | ≤ 1.5 s |
| Resolver cache hit | ≤ 0.2 ms p99 |
| Resolver cold DoH query | upstream RTT + ≤ 5 ms |
| Resolver memory | ≤ 64 MiB |
| nft ruleset apply | ≤ 50 ms |
| `NetWatch` event latency | ≤ 100 ms after the kernel event |
| WireGuard bring-up | ≤ 200 ms excluding the handshake |
| First NTS sync after boot | ≤ 10 s on a working network |
| netd RSS | ≤ 24 MiB |
| `signIn` (VM start excluded: info + scope lookup + rule add + mint) | ≤ 50 ms; end to end with a warm bench pool ≤ 1.5 s |
| cri netns creation at start | ≤ 200 ms |
| `clusterUplink` op `uplink` | ≤ 50 ms (one nft transaction) |
| `clusterUplink` op `podNetns` / `release` | ≤ 20 ms / ≤ 10 ms |
| mDNS browse first result on a quiet LAN | ≤ 1.5 s |
| Forwarded pod throughput through `kl-cri0` with NAT | ≥ 90% of uplink line rate on 10 GbE |

---

## 9. Observability

**Logs:** link transitions (info); DHCP events (info); captive detection (notice); firewall drops (rate-limited, info); DNSSEC failures (warning); clock steps (notice; warning if backward); VPN up/down (info).

**Receipts** (`net.change`, writer `net`):

| `data.kind` | When | `data` |
|---|---|---|
| `wifi.join`, `wifi.forget` | §4.9 | `{ssidHex, security}` |
| `vpn.up`, `vpn.down` | Tunnel state changes requested through `Net` or alwaysOn | `{profile, reason}` |
| `metered` | Runtime override | `{link, value}` |
| `captive.enter`, `captive.leave`, `captive.admit` | §4.7 | `{link, ssidHex, vmSession?, expires?}` |
| `cluster.netns`, `cluster.uplink`, `cluster.down` | §4.11 | `{podCidr, overlay, nat}` (pod namespace create/release are not receipted; they are journal records) |
| `discovery.publish`, `discovery.withdraw` | §4.12 | `{instance, type, port, forUid}` |
| `firewall` | Ruleset digest changed by config or plumbing | `{digest, cause}` |
| `time.trust` | Trust state changes | `{trusted, sources}` |

DHCP renewals and resolver activity are not receipted.

**Metrics** (`0x1F` metrics records to the journal): `net_link_state{link}`, `net_dhcp_events_total{type}`, `net_dns_queries_total{result,secure}`, `net_dns_latency_seconds`, `net_dns_cache_entries`, `net_time_offset_seconds`, `net_time_trusted`, `net_fw_drops_total{direction}`, `net_wg_handshake_age_seconds{profile}`, `net_captive`, `net_captive_admissions`, `net_cluster_forward_bytes_total{direction}`, `net_mdns_instances`, `net_mdns_published`.

---

## 10. Configuration

```nickel
# module keylos.net → /etc/keylos/net/net.json
{
  net | {
    profile | [| 'desktop, 'laptop, 'server, 'server-k8s, 'cloud, 'kiosk, 'appliance, 'router |] | default = 'desktop,
                                                       # protocols §2.2 profiles, plus net-local 'router
    links | Array {
      match | { name | String | optional, mac | String | optional, kind | [| 'ethernet, 'wifi, 'wwan |] | optional },
      dhcp4 | Bool | default = true,
      ipv6 | [| 'slaac, 'dhcp6, 'off |] | default = 'slaac,
      static | Array { address | String, gateway | String | optional } | default = [],
      metric | Number | optional,
      metered | [| 'auto, 'yes, 'no |] | default = 'auto,
      probe | Bool | default = true,
      sendHostname | Bool | default = false,
      privacy | Bool | default = true,
      discovery | Bool | optional,                     # mDNS/DNS-SD on this link; default true on desktop/laptop/kiosk, false elsewhere
    } | default = [{ match = {} }],
    wifi | {
      known | Array { ssid | String, metered | [| 'auto, 'yes, 'no |] | default = 'auto,
                      hidden | Bool | default = false, autoConnect | Bool | default = true } | default = [],
      randomizeMac | Bool | default = true,
    } | default = {},
    dns | {
      dnssec | [| 'require, 'allow-downgrade, 'off |] | default = 'allow-downgrade,
      usePrivateResolvers | Bool | default = true,
      upstreams | Array { kind | [| 'dot, 'doh, 'plain |], address | String, name | String | optional, url | String | optional }
                | default = [
                    { kind = 'doh, address = "1.1.1.1", url = "https://cloudflare-dns.com/dns-query" },
                    { kind = 'dot, address = "9.9.9.9", name = "dns.quad9.net" },
                  ],
      allowPlainUpstream | Bool | default = false,
      searchDomains | Array String | default = [],
    } | default = {},
    vpn | Array {
      name | String,
      privateKeyItem | String,
      address | Array String,
      dns | Array String | default = [],
      dnsDomains | Array String | default = [],
      dnsAll | Bool | default = false,
      peers | Array { publicKey | String, presharedKeyItem | String | optional, endpoint | String,
                      allowedIps | Array String, keepalive | Number | optional },
      mtu | Number | optional,
      fwmark | Number | default = 51820,
      table | Number | default = 51820,
      alwaysOn | Bool | default = false,
      killSwitch | Bool | default = false,
    } | default = [],
    firewall | {
      listenPorts | Array { port | Number, proto | [| 'tcp, 'udp |], scope | [| 'loopback, 'lan, 'any |] | default = 'lan }
                  | default = [],
      icmpEcho | Bool | default = true,
    } | default = {},
    discovery | {
      hostname | String | optional,                    # default: "<machine name>-<4 hex>"
      maxInstances | Number | default = 4096,
    } | default = {},
    cluster | {                                        # honoured only on profile 'server-k8s
      enabled | Bool | default = false,
      podCidrs4 | Array String | default = [],         # the node's pod CIDR must fall inside one of these
      podCidrs6 | Array String | default = [],
      clusterCidrs4 | Array String | default = [],     # all pod and node networks of the cluster (no NAT)
      clusterCidrs6 | Array String | default = [],
      serviceCidr4 | String | optional,                 # must equal keylos.cri.uplink/1 serviceCidr when set
      overlay | [| 'none, 'vxlan |] | default = 'none,
      vxlanPort | Number | default = 4789,
      masquerade | Bool | default = true,
      hostDns | Bool | default = false,
      uplinks | Array String | default = [],           # link names allowed to forward pod traffic; empty = default-route links
      nodeCidrs4 | Array String | default = [],        # addresses of cluster nodes (overlay peers, node-to-node pod traffic)
      nodeCidrs6 | Array String | default = [],
    } | default = {},
    time | {
      nts | Array String | default = ["time.cloudflare.com", "nts.netnod.se", "ptbtime1.ptb.de", "ntppool1.time.nl"],
      minimumAgreeing | Number | default = 2,
      allowUnauthenticated | Bool | default = false,
    } | default = {},
    captive | {
      probeHosts | Array String | default = ["captive.keylos.org", "connectivitycheck.gstatic.com"],
      browserImage | String | default = "io.keylos.bench.captive-browser",
      admitSeconds | Number | default = 600,
    } | default = {},
  }
}
```

**Validation** (config compiler): `listenPorts` changes (including scope widening `lan` → `any`), `cluster.enabled`, `cluster.masquerade = false` with non-empty `uplinks`, and `allowUnauthenticated = true` are capability changes requiring T3; `minimumAgreeing ≥ 2` unless `profile = 'appliance`; `admitSeconds ≤ 600`; `cluster.enabled = true` is rejected unless `profile = 'server-k8s`; pod CIDRs MUST be inside `clusterCidrs`.

Profile defaults are owned by the distribution: `server` and `server-k8s` set `probe = false`, `dnssec = 'require`, `usePrivateResolvers = false` and `discovery = false`; `cloud` additionally trusts the provider's link resolvers for metadata names only; `router` enables forwarding and DHCPv6-PD.

---

## 11. Testing and acceptance

### 11.1 Unit

- DHCP option parsing and serialization (RFC vectors); timers with a simulated clock; ARP conflict handling.
- RA user-option parsing.
- nft ruleset generation: golden files per profile and state (normal, captive with admission, kill switch, local-link UIDs).
- Upstream selection including split DNS and VPN changes.
- Time trust algorithm with simulated observations (agreement, loss, floor clamping).

### 11.2 Fuzz

`fuzz_mdns_packet`, `fuzz_cluster_config_json`, `fuzz_dhcp_packet`, `fuzz_dhcp6_packet`, `fuzz_ra_options`, `fuzz_dns_wire` (client and upstream sides), `fuzz_iwd_dbus_messages`, `fuzz_wifi_credential_json`.

### 11.3 Integration (network namespaces and VMs in CI; a test netns plays the LAN)

| ID | Scenario | Expected |
|---|---|---|
| NT-1 | dnsmasq in the test LAN | Configured ≤ 500 ms with a cached lease; SLAAC and RDNSS applied |
| NT-2 | A process with a non-allowlisted UID in the host netns connects to 1.1.1.1:443 | Rejected (admin-prohibited) and logged |
| NT-3 | Bogus signed zone | `SERVFAIL` in require and allow-downgrade |
| NT-4 | Captive simulation (probe returns 302); atrium calls `signIn` | net starts the captive-browser VM via `bench#net` with `captive.url`; 80/443/53 open only for the cgroup from `Vm.info`; captive token minted for the VM session; another cgroup → rejected; after 204 the chain is flushed, the VM stopped and `captive=false`; `admit(uid)` and `admitSession` → `kl:unsupported` |
| NT-5 | WireGuard full tunnel with kill switch; drop the peer | All egress except to the endpoint blocked; restore → traffic resumes |
| NT-6 | NTS with one reachable server | Not trusted; with two → trusted; RTC set back a year → stepped to the ledger floor before sync |
| NT-7 | mac80211_hwsim + hostapd (WPA3-SAE) | Join via vault; iwd state contains no passphrase; `net.change` written |
| NT-8 | VPN `dnsDomains=["corp.example"]` | `host.corp.example` via VPN resolver; VPN down → SERVFAIL for it; `example.org` via private resolver |
| NT-9 | `setListenPorts` with a port outside config | `kl:denied`; set unchanged |
| NT-10 | `setEgressUids` called by a non-warden principal | `kl:denied` |
| NT-11 | Local-link UID sends mDNS and IPP to an on-link printer | Allowed; the same UID to an off-link address → rejected |
| NT-12 | netd killed during a config change | Restart reconciles to the new ruleset digest; no window with an empty table |
| NT-13 | Wi-Fi join with a wrong passphrase | `kl:denied`; vault item deleted |
| NT-14 | Ledger floor above RTC and NTS unreachable | Clock stepped to the floor; `synced=false`; gate sees untrusted time |
| NT-15 | `signIn` from a principal other than atrium, or while not captive | `kl:denied`; no VM started |
| NT-24 | During an admitted sign-in, atrium calls `endSignIn` | admission rule gone and VM stopped before the call returns; a further `endSignIn` returns without error; receipt `net.change {kind: "captive.end"}` |
| NT-16 | `server-k8s` boot | cri netns exists before warden starts crid; `clusterNetns` from warden returns it, from any other caller → `kl:denied`; op `uplink` twice → same namespace, one nft transaction each; pod (via op `podNetns`) pings an external host → NATed; unsolicited inbound to pods dropped; node-to-node from `clusterCidrs` accepted; pod CIDR outside config → `kl:denied`; on `desktop` → `kl:unsupported` |
| NT-17 | Port 8443 configured with scope `lan`, set by gate | Connection from an on-link host accepted; from an off-link host (routed) dropped; scope `any` accepts both |
| NT-18 | `portal-discovery` browses `_ipp._tcp` with an avahi responder on the test LAN | Instance streamed within 1.5 s; goodbye removes it; browse on a link with `discovery = false` returns nothing |
| NT-19 | `publish` of port 9000 not in the listen set | `kl:denied`; after gate sets 9000 (scope `lan`) the record is announced and withdrawn on cancel |
| NT-20 | netd killed on `server-k8s` | cri namespace and pod traffic survive; reconciliation restores `cluster_*` chains |
| NT-21 | Op `podNetns` for two pods, then `release` one twice; IP reuse | Two namespaces with veths on `kl-cri0`; release idempotent; the released IP can be allocated again; a duplicate live IP → `kl:conflict` |
| NT-22 | `setListenPorts` with `ports` [{8080,tcp,any}] where config says scope `lan` | Effective scope `lan`: off-link source dropped; `ports` non-empty together with `tcp` → `kl:invalid` |
| NT-23 | net restarted with 5 pod namespaces live | All 5 kept and listed by `net cluster`; an orphaned namespace without processes is removed |

### 11.4 Acceptance criteria

NT-1…NT-23 pass on KL1 and KL3; §8 budgets met; firewall golden files match (including captive admission, cluster and scoped-listen variants); zero fuzz crashes.

---

## 12. Implementation notes

### 12.1 Crates

| Crate | Use |
|---|---|
| `rtnetlink` 0.14, `netlink-packet-route` | Links, addresses, routes, rules |
| `rustables` (netlink nftables) | Atomic ruleset install (including `socket cgroupv2` expressions) |
| `hickory-proto` (mDNS feature) or `mdns-sd` 0.13 | mDNS/DNS-SD in `net-mdns` |
| `netlink-packet-generic`, `netlink-packet-wireguard` | WireGuard |
| `dhcproto` 0.12 | DHCPv4/v6 encoding |
| `hickory-resolver` 0.24, `hickory-proto` (DNSSEC, DoT, DoH features) | Resolver |
| `rustls` 0.23 | TLS |
| ntpd-rs (`ntpd` 1.x) | Time; shipped as a supervised binary if library embedding is not viable at a release |
| `zbus` 5.x | iwd client in `net-wifi` |
| `tokio` 1.x, `keylos-capwire`, `keylos-schemas`, `keylos-formats` | |

External programs in the generation: `iwd` (≥ 2.x), `dbus-broker`, ntpd-rs when not embedded.

### 12.2 Layout

```
net/
  crates/netd/  crates/net-resolver/  crates/net-mdns/  crates/net-time/  crates/net-wifi/  crates/net-cli/
  island/dbus-policy.xml
  nickel/keylos-net.ncl
  fuzz/  tests/it/
```

---

## 13. Decisions and alternatives

| Decision | Alternatives | Reason |
|---|---|---|
| No host-netns sockets for principals; gate is the only egress ([ADR-0025](../../handbook/11-decisions/adr-0025-namespaces-only-by-warden.md), [ADR-0004](../../handbook/11-decisions/adr-0004-capwire-no-system-bus.md)) | veth plus NAT per app; shared netns with Landlock port rules | Landlock cannot filter by host; veth/NAT adds forwarding attack surface |
| iwd in a D-Bus island ([ADR-0035](../../handbook/11-decisions/adr-0035-fd-only-portals-dbus-islands.md)) | wpa_supplicant control socket; a new supplicant | iwd is the best-maintained modern supplicant; its only API is D-Bus, so it gets a two-party island |
| NTS-only time with a ledger floor ([ADR-0038](../../handbook/11-decisions/adr-0038-nts-time.md)) | Plain NTP; roughtime | Token, TUF and certificate expiry need authenticated, non-rollback time |
| Captive portal in a disposable VM with firewall admission | Show the portal in the user's browser; route it through gate | Portal pages are untrusted content on an untrusted network; gate's egress rules cannot work before the network is usable |
| Private resolvers by default | Network-provided DNS | Hostile networks; validation; privacy |
| Captive admission by VM session cgroup ([ADR-0044](../../handbook/11-decisions/adr-0044-vsock-control-and-userspace-nic.md)) | Admission by UID; routing the portal through gate | The VM principal is a cgroup, not a UID; gate's egress rules cannot work before the network is usable |
| cri network namespace built by net ([ADR-0047](../../handbook/11-decisions/adr-0047-cri-microvm-pods.md)) | warden builds it; cri builds the uplink itself with host `CAP_NET_ADMIN` | Only net may change host routing, forwarding and NAT; cri gets `CAP_NET_ADMIN` only inside its own namespace |
| Listen scope declared in net config | Scope carried by `setListenPorts` | The protocols call carries ports only; the owner decides exposure per port in config, gate decides per principal |
| Declarative config with an adopt path ([ADR-0021](../../handbook/11-decisions/adr-0021-nickel-configuration.md), [ADR-0022](../../handbook/11-decisions/adr-0022-read-only-etc-confext.md)) | Mutable connection profiles | Drift-free; reboot heals |
