# Architecture

## Controller pipeline

1. Parse the GitHub Issue event as untrusted data.
2. Load a trusted, versioned default-branch configuration.
3. Handle Confirm or Issue-author follow-up state transitions.
4. Apply deterministic trigger policy and retrieve bounded duplicate candidates.
5. Resolve engine, Provider/model, exact CLI lifecycle, and Provider fallback order.
6. Copy source into a filtered `.git`-less disposable workspace.
7. Start a short-lived credential proxy when environment authentication is configured.
8. Run the Agent with bounded time/output and a strict output Schema.
9. Capture controller-observable CLI events and workspace changes.
10. Optionally run one Agent-requested, controller-approved probe on another clean copy.
11. Rebind identity, validate duplicate targets, normalize evidence, and cap priority.
12. Return outputs and optionally upsert one bot-owned sticky comment.
13. Apply labels, assignee, or closure only after an authorized maintainer adds Confirm.

## Separation of concerns

### Agent engine

The engine supplies repository-aware reasoning and tools:

- `codex`
- `claude`
- `dsh`
- `custom`

### Model provider

The provider profile selects transport and economics independently of the engine:

- provider kind: native, compatible, enterprise, or local;
- protocol: Responses, Chat Completions, or Anthropic Messages;
- base URL;
- model identifier;
- environment or command-backed authentication;
- optional headers sourced from environment variables.

This design supports direct configuration, enterprise gateways, local models, and configuration managers such as CCSwitch without depending on any one switcher.

### Investigation protocol

Every engine must produce the same report shape. In particular, it must keep these concepts separate:

- user-reported reproduction steps;
- agent-proposed steps;
- steps independently observed by the agent;
- runner/environment equivalence;
- commands and code locations used as evidence;
- investigation limitations.

## Clean replay

The Agent may request only a probe name defined in trusted configuration. It cannot supply replay argv. The controller executes the approved command on a fresh copy and upgrades configured steps to verified only when the expected exit condition matches.

Container replay requires an immutable image digest and uses no capabilities, no-new-privileges, bounded memory/PIDs, a read-only root, and no network by default.

## Evidence ownership

Agent observations remain untrusted. Controller-observed command events, file changes, duplicate candidates, and clean replay results are separate evidence lanes. Only controller evidence can preserve a `reproduced` claim or produce `verified_steps` under the default policy.
