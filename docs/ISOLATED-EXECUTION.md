# Isolated online investigations

This mode places the execution boundary around a disposable Linux container. Codex runs with `danger-full-access` and `approval_policy=never` **inside that container only**. Public networking, package downloads, HTTP requests, and WebSockets do not require per-request model approval. The previous offline process/broker mode remains available for compatibility.

## Boundary and data flow

1. The trusted workflow checks out the default branch without persistent Git credentials and builds `container/Dockerfile` from the same pinned Action revision. Both base images are digest pinned; the resulting immutable local image ID is supplied through `container-image`.
2. The controller redacts known credentials from Issue/duplicate data. A separate model call reviews that input for exposed private data or a primary abuse request. Quoted malicious instructions remain untrusted data, not controller instructions. The disposable source snapshot excludes Git metadata, credential files, local dependency/build directories, and is bounded and scanned for known credentials/private keys before staging.
3. A non-root container starts with no host mounts, no Docker socket, no capabilities, default Docker seccomp, no new privileges, a read-only image, and bounded writable tmpfs. It has separate process and network namespaces. No untrusted code starts until namespace firewall rules are installed by the controller.
4. Public IPv4 traffic is allowed. Host/private/link-local/metadata/reserved destinations are blocked; IPv6 is disabled and its OUTPUT policy denies traffic. Only a random authenticated model proxy endpoint is reachable on the host bridge. The namespace also has a public outbound byte quota and a 20 Mbit/s egress limit. These are deterministic limits, not an HTTP or protocol allowlist.
5. The controller retains the real model key and any GitHub token. The executor receives only a random proxy token, scoped to the chosen model, model endpoints, maximum request count, input/response sizes, and maximum output tokens per request. Hosted provider tools, background storage, and model changes are denied. The proxy closes at the end of the run and aborts in-flight upstream requests.
6. Only a bounded report and bounded executor telemetry return. No executable artifact, workspace archive or agent-created script is imported into the host. Source mutations remain inside the container. Output is schema checked, bound back to the original Issue identity, normalized against the evidence policy, scrubbed for credentials/endpoints/workflow commands, and independently reviewed before the trusted controller publishes it.
7. Failure, timeout, oversized output, missing Docker/firewall support, or a rejected boundary review fails closed. There is no fallback to running the online agent directly on the host. Container removal kills its remaining processes and removes its writable storage and network namespace.

## Configuration

```yaml
cli:
  install: preinstalled
  versions:
    codex: 0.163.0
investigation:
  engine: codex
  provider: deepseek
  mode: execute
  timeoutMinutes: 20
  approvalMode: never
  network: true
  isolation:
    executor: container
    cpus: 2
    memoryMb: 4096
    diskMb: 3072
    pids: 256
    modelRequests: 40
    maxOutputTokens: 8192
    publicNetworkMb: 512
```

Select a Responses-compatible provider with environment authentication. The key belongs to the controller, not the container. The trusted workflow builds the executor and passes its image ID:

```yaml
- name: Build isolated executor
  id: sandbox
  run: |
    docker build --iidfile "$RUNNER_TEMP/eai-image.id" -f /trusted/action/container/Dockerfile /trusted/action
    echo "image=$(cat "$RUNNER_TEMP/eai-image.id")" >> "$GITHUB_OUTPUT"
- uses: zhongbai2333/Evidence-Aware-Issue-Investigator@<same-reviewed-commit>
  env:
    DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
  with:
    github-token: ${{ github.token }}
    container-image: ${{ steps.sandbox.outputs.image }}
    publish-comment: "true"
```

An `image` under `isolation` may alternatively be a repository digest or local `sha256:` image ID. Tags are rejected. Linux, Docker, passwordless controller `sudo nsenter`, iptables quota support, ip6tables and `tc` are required. Bubblewrap/AppArmor setup is unnecessary in this mode. Model-request/token ceilings bound usage but are not an exact dollar-spend guarantee; provider-side spending limits can add a monetary ceiling. The input/output reviews add at most two bounded provider requests per attempt.

## Verification and limits

CI builds the actual executor and checks public HTTPS, real-key substitution at the controller proxy, inaccessible host sentinel files, blocked host and metadata requests, zero capabilities, no Docker socket, read-only root, inability to change firewall rules, PID limits, unchanged original source, and cleanup after timeout.

Containers share the host kernel. This is an explicit isolation boundary, not a claim of absolute isolation or immunity to kernel/runtime vulnerabilities. Use an ephemeral dedicated hosted runner, not a persistent machine containing unrelated secrets. A microVM can be substituted when a separate kernel is required.

Input screening and an independent reviewer cannot prove arbitrary data is safe, nor can they prove a model's conclusion correct. Public networking means executor-visible data can leave the container; do not seed private logs, private source, or confidential attachments without a separate data policy. The DeepSeek cloud model remains outside the container and receives the selected input via the controller proxy. Executor JSONL is untrusted telemetry, not independent reproduction proof; clean trusted replay remains the stronger verification mechanism.
