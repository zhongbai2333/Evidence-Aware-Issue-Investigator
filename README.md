# Evidence-Aware Issue Investigator

A GitHub Action that turns a selectable coding-agent CLI into a bounded, evidence-aware first-line Issue investigator.

It can read a disposable copy of a repository, trace code, run bounded tests, propose clearer reproduction steps, request an approved clean-room probe, retrieve duplicate candidates, and produce a maintainer-confirmed triage decision.

The project separates three choices that are often incorrectly coupled:

1. **Investigation policy** — which Issues deserve a code-aware investigation.
2. **Agent engine** — Codex CLI, Claude Code, DeepSeek Harness, or a custom CLI.
3. **Model provider** — official APIs, lower-cost compatible providers, local models, or an enterprise gateway.

Provider and model switching are native features. CCSwitch and similar tools may prepare an external CLI environment, but they are not required.

## Implemented capabilities

- Node 24 ESM Action with Codex, Claude Code, dsh, and custom CLI adapters.
- Named Provider profiles plus runtime engine/provider/model overrides and fallback order.
- Exact preinstalled CLI version checks or exact-version `npx` execution.
- Filtered `.git`-less disposable Agent workspaces.
- Short-lived controller credential proxy; real environment Provider keys do not enter built-in Agent processes.
- Codex JSONL command-event capture and controller-observed workspace changes.
- Strict bounded report Schema, duplicate-target validation, and priority caps for unreproduced reports.
- Controller-approved probe replay on a second clean copy, optionally in a digest-pinned container.
- Bot-owned sticky reports plus maintainer Confirm and Needs-Info follow-up state transitions.

## Example workflow

```yaml
name: Investigate Issues

on:
  issues:
    types: [opened, reopened, labeled]
  issue_comment:
    types: [created]

permissions:
  contents: read
  issues: write

concurrency:
  group: issue-investigator-${{ github.repository }}-${{ github.event.issue.number }}
  cancel-in-progress: false

jobs:
  investigate:
    if: github.event_name != 'issue_comment' || github.event.issue.pull_request == null
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
          fetch-depth: 0

      - uses: zhongbai2333/evidence-aware-issue-investigator@v1
        env:
          COMPANY_CODING_KEY: ${{ secrets.COMPANY_CODING_KEY }}
        with:
          github-token: ${{ github.token }}
          config-path: .github/issue-investigator.yml
          publish-comment: "true"
```

See [the example configuration](examples/issue-investigator.yml), [architecture](docs/ARCHITECTURE.md), and [security model](SECURITY.md).

## Model switching

Define any number of named providers and select one by changing only `investigation.provider`:

```yaml
providers:
  economical:
    kind: compatible
    baseUrl: https://gateway.example.com/v1
    protocol: responses
    model: company-coder-small
    auth:
      mode: environment
      env: COMPANY_CODING_KEY

  private:
    kind: enterprise
    baseUrl: https://llm.corp.example/v1
    protocol: responses
    model: secure-coder
    auth:
      mode: command
      command: /usr/local/bin/fetch-llm-token

investigation:
  engine: codex
  provider: economical
  fallbackProviders: [private]
```

The same engine can therefore use an official model, a compatible commercial model, an internal gateway, or a local endpoint without changing the investigation pipeline.

The workflow can switch at runtime too:

```yaml
with:
  agent-engine: codex
  provider: private
  model: secure-coder-v2
  execution-mode: execute
```

## Evidence semantics

- `user_steps`: text reported by the Issue author.
- `proposed_steps`: Agent suggestions that have not been independently verified.
- `verified_steps`: steps promoted only by an approved clean replay.
- `inconclusive`: the correct result when runner and reporter environments differ.

Without reproduction, priority is capped at Medium by default. Security, data-loss, and complete-outage flags remain advisory unless maintainers explicitly allow unreproduced high-impact priority. Model confidence cannot override this controller rule.

## Development

```bash
npm ci
npm run all
npm audit
```

`npm run all` performs type checking, unit and integration tests, bundles `dist/index.js`, and runs both plan-mode and full mock-CLI execute-mode Action smoke tests.

See [configuration](docs/CONFIGURATION.md), [architecture](docs/ARCHITECTURE.md), and the [security model](SECURITY.md). Live CLI/provider compatibility must still be tested for every combination a release advertises because tool streaming and model behavior are external contracts.

## License

MIT
