# Configuration reference

The default path is `.github/issue-investigator.yml`. Configuration is loaded from the checked-out trusted revision and validated before any Agent process starts.

## CLI lifecycle

```yaml
cli:
  install: preinstalled # preinstalled | npx
  versions:
    codex: 0.149.0
    claude: 2.1.238
    dsh: 0.1.1-rc.1
```

`preinstalled` verifies the binary with `--version`. `npx` requires an exact version and invokes only the allowlisted official npm package for the selected engine. Floating tags and semver ranges are rejected.

## Providers

```yaml
providers:
  economical:
    kind: compatible # native | compatible | enterprise | local
    baseUrl: https://gateway.example.com/v1
    protocol: responses # responses | chat-completions | anthropic-messages
    model: coder-small
    auth:
      mode: environment # none | environment | command
      env: COMPANY_CODING_KEY
    headersFromEnv:
      X-Tenant: COMPANY_TENANT
```

Environment authentication uses the controller credential proxy for built-in engines. Command authentication is intended for short-lived enterprise credential helpers and is currently translated natively by the Codex adapter. For other engines, use their preconfigured wrapper or environment mode.

Engine protocol requirements are strict: Codex custom Providers currently require Responses, Claude Code requires Anthropic Messages, and the built-in dsh DeepSeek adapter requires Chat Completions. A gateway must perform protocol conversion before an otherwise incompatible model can be selected.

## Investigation

```yaml
investigation:
  engine: codex
  provider: economical
  fallbackProviders: [company-secure]
  trigger: label # never | label | bugs | always
  triggerLabel: AI-Investigate
  bugLabels: [bug, BUG]
  mode: execute # plan | execute
  timeoutMinutes: 15
  maxTurns: 20
  workspace: workspace-write # read-only | workspace-write
  network: false
```

`command` and `argsPrefix` may select a trusted preinstalled wrapper. They are configuration, not Issue-controlled input, and are always executed with `shell: false`.

## Triage and evidence

```yaml
triage:
  duplicateSearch: true
  maxDuplicateCandidates: 8

evidencePolicy:
  unreproducedMaxPriority: medium
  requireObservedCommandForReproduced: true
  requireReplayForVerifiedSteps: true
  allowUnreproducedHighImpactPriority: false
```

The controller retrieves candidates; the Agent cannot invent a valid duplicate target. The evidence policy is applied after strict report parsing.

## Clean replay

```yaml
replay:
  enabled: true
  executor: container
  containerImage: ghcr.io/example/project-test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  probes:
    search-smoke:
      command: [./scripts/reproduce-search.sh]
      timeoutMinutes: 5
      expectedExitCodes: [7]
      outcome: reproduced
      verifiedSteps:
        - Run the release search smoke script and observe its documented failure exit code.
      network: true
```

The Agent may return `requested_probe: search-smoke`; it cannot change command argv, expected codes, outcome, image, or networking. Host replay exists only for externally isolated development and requires `allowUnsafeHostExecution: true`.

## Labels and mutation

```yaml
mutation:
  mode: maintainer-confirm # suggest | maintainer-confirm
  confirmLabel: Confirm
  rerunLabel: AI-Rerun
  assignConfirmer: true
  applySuggestedTitle: false
  closeNegativeDispositions: true
  rerunOnAuthorFollowup: true

labels:
  types:
    bug: BUG
    enhancement: Enhancement
    documentation: Documentation
    question: Question
    unknown: Question
  priorities:
    critical: "priority: critical"
    high: "priority: high"
    medium: "priority: medium"
    low: "priority: low"
  dispositions:
    duplicate: Duplicate
    wontfix: WontFix
    invalid: Invalid
  needsInfo: Needs-Info
```

Confirm is accepted only from an actor with `triage`, `write`, `maintain`, or `admin` permission and only when a valid bot-owned report marker for the same repository/Issue exists.

## Action inputs

- `github-token`
- `config-path`
- `publish-comment`
- `agent-engine`
- `provider`
- `model`
- `execution-mode`

The last four values override the validated configuration for one run. Base URL, credentials, commands, and permission policy cannot be overridden from Issue text.
