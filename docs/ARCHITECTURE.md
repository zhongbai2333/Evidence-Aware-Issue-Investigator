# Architecture

## Controller pipeline

1. Parse the GitHub Issue event as untrusted data.
2. Load a trusted, versioned default-branch configuration.
3. Handle Confirm or Issue-author follow-up state transitions.
4. Apply deterministic trigger policy and retrieve bounded duplicate candidates.
5. Resolve engine, Provider/model, exact CLI lifecycle, and Provider fallback order.
6. Copy source into a filtered `.git`-less disposable workspace.
7. Start a short-lived credential proxy when environment authentication is configured.
8. Optionally let a controller-side Reviewer approve exact public Issue attachments, download approved files through a narrow allowlist, and seed them into the disposable workspace.
9. Start a controller-polled filesystem-queue egress broker when Auto-review is enabled. It reviews and validates every proposed public HTTPS `GET`/`HEAD` and redirect while the Agent's direct network remains disabled.
10. Run the investigation Agent offline with bounded time/output and a strict output Schema.
11. Capture controller-observable CLI events, reviewed-request audit counts, and workspace changes.
12. Optionally run one Agent-requested, controller-approved probe on another clean copy.
13. Rebind identity, validate duplicate targets, normalize evidence, and cap priority.
14. Return outputs and optionally upsert one bot-owned sticky comment.
15. Apply labels, assignee, or closure only after an authorized maintainer adds Confirm.

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

Agent observations and Auto-review decisions remain untrusted. The controller, not the Agent, enforces attachment URL shape plus dynamic-request method, HTTPS, credentials, ports, DNS address class, redirects, request count, and response byte limits. Controller-observed command events, reviewed-request counts, file changes, duplicate candidates, and clean replay results are separate evidence lanes. Only controller evidence can preserve a `reproduced` claim or produce `verified_steps` under the default policy. Endpoint URLs are redacted before report publication and marker encoding.
