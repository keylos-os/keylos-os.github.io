# Run a Kubernetes node

> Install keylos with the `server-k8s` profile, set up quorum presence, enrol the node with your fleet so it can attest, join the cluster, and run pods in both runtime classes. Every step matches the v1.0 specs.
> Prerequisites: a cluster control plane you operate, a keylos fleet for your organisation, and at least two owners with FIDO2 keys on their own keylos machines.

## 1. Install with the server-k8s profile

Boot the installer and choose profile `server-k8s` (or pass it in an unattended install). Enrol at least two owners, and choose the quorum threshold.

```
installer: profile            server-k8s
installer: presence           quorum, threshold 2 of 3
installer: fleet enrolment    org.example (seed key from your fleet)
```

The installer writes the owner registry with `policy.mode = "quorum"`, prints the recovery key, and creates the TPM objects (including AK and AK0 for attestation).

## 2. Configure the cluster

```nickel
# infra-config/cluster.ncl
{
  cluster = {
    apiServer = "https://k8s.example.internal:6443",
    podCidr = "10.244.12.0/24",
    overlay = "vxlan",
    egressViaGate = true,
    hostPathAllowlist = ["/var/lib/keylos/cri/shared-ro"],
    runtimeClasses = ["keylos-vm", "keylos-sealed"],
  },
  devices.passthrough = ["0000:65:00.0"],     # optional: a GPU for VFIO pods
}
```

```
$ config propose ./infra-config
quorum request q-01JC… needs 2 of 3 owners
```

Two owners approve on their own machines (`hearth presence --remote q-01JC…`). Once the quorum completes, the config generation activates.

## 3. Attest and join

On activation, `cri` starts and runs the join:

1. `FleetCluster.joinChallenge`, then `FleetCluster.joinAttested` with an AK quote over that challenge. `fleet` checks it against the release log.
2. `FleetCluster.clusterCertificate` issues the kubelet, kube-proxy and cri credentials.
3. cri writes the kubeconfig. kubelet and kube-proxy start.

```
$ cri node
attestation   ok (release 2026.10.2, full)   renewed 2026-10-08T10:02Z
kubelet       v1.36.1   runtime classes keylos-vm, keylos-sealed
$ kubectl get node keylos-k8s-07
NAME            STATUS   ROLES    VERSION
keylos-k8s-07   Ready    <none>   v1.36.1
```

## 4. Run a pod in a microVM (default)

```yaml
apiVersion: v1
kind: Pod
metadata: { name: web }
spec:
  runtimeClassName: keylos-vm
  containers:
    - name: app
      image: ghcr.io/example/web@sha256:3f9a…
      resources: { limits: { memory: 512Mi, cpu: "1" } }
```

cri admits the pod through the broker, starts a pod VM through bench, and runs the container under youki in the guest. `ledger query --event pod.` shows `pod.admit` and `pod.start`.

## 5. Run a sealed pod

Sealed pods need a `container` generation signed by your org publisher key:

```
work$ kl-sdk container sign ghcr.io/example/api@sha256:9e1f… --publisher org.example
```

```yaml
spec:
  runtimeClassName: keylos-sealed
  containers:
    - name: api
      image: ghcr.io/example/api@sha256:9e1f…
```

`depot` converts the image to a `container` generation, finds your genstmt in the org TUF repository, and cri spawns the container through `PodSpawn`.

## 6. See a denial

```yaml
spec:
  hostNetwork: true
```

```
Error: PermissionDenied: admit forbidden: hostNetwork (default policy)
```

The denial is recorded as `pod.deny` with the reasons.

## 7. Day-two

| Task | Command |
|---|---|
| Drain for maintenance | `cri drain --reason "kernel update"` |
| Update the node | `courier stage` (boot counting and the NV floor protect unattended reboots) |
| Check images | `cri images` |
| Review admissions | `ledger query --event pod.deny --since 7d` |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Node never becomes Ready | Attestation failed (`cri node` shows the reason; check firmware changes against the release log) |
| Pod stuck `pending-approval` | A permit with `@tier`/`@orgApproval` matched; approve in the approvals centre or via fleet |
| Sealed pod `CreateContainerError` | No org genstmt for that image digest, or the publisher key isn't enabled in `publishers.json` |
| Pod evicted for storage | `ephemeral-storage` exceeded; strata scans usage every 30 s |

## Related

- [Kubernetes nodes](../10-operations/kubernetes.md)
- [Servers and cloud](../10-operations/servers-and-cloud.md)
- [cri spec](../../specs/cri/spec.md)
- [ADR-0047: Pods in microVMs](../11-decisions/adr-0047-cri-microvm-pods.md)
