# Security model

## Trust boundaries

The controller and its configuration from the checked-out trusted revision are trusted. Issue titles, bodies, comments, repository files, dependency scripts, agent output, test output, and generated reproduction steps are untrusted data.

The project does not treat prompt instructions as a security boundary.

## Defaults

- `investigation.mode` defaults to `plan`.
- Investigation starts only after the configured trigger policy selects the Issue.
- No commit, push, release, PR creation, or source-code fix is part of the v1 investigation contract.
- The agent subprocess receives a small environment allowlist rather than the controller's complete environment.
- `GITHUB_TOKEN` is used only by the controller and is never intentionally forwarded to the agent subprocess.
- Generated temporary paths are validated against path traversal.
- CLI processes are started with argument arrays and `shell: false`.
- Reports must match a strict schema, and controller-owned Issue/agent identity is rebound after execution.

## Credential warning

A model CLI must authenticate, while the same CLI may expose a shell tool. Passing a real API key directly to that process can allow an untrusted repository script or prompt-injected agent command to read the key.

The implementation:

- starts a short-lived controller proxy for environment-authenticated built-in engines;
- passes only a random, rate-bounded proxy token to the Agent;
- restricts the proxy to the configured upstream host and known model endpoints;
- injects real authorization and configured secret headers only on the upstream request;
- generates a Codex shell-environment policy that excludes secret-shaped variables from spawned commands.

`allowUnsafeCredentialInheritance: true` is an explicit escape hatch for disposable, externally isolated environments. It is not recommended for public repositories.

## Required caller practices

- Check out an immutable trusted revision with `persist-credentials: false`.
- Grant only `contents: read` and, when publishing a report, `issues: write`.
- Pass provider credentials at the Action step, never at job scope.
- Do not combine investigation with release, deployment, package publishing, or organization-wide secrets in the same job.
- Pin the Action and CLI versions for production use.
- Use a dedicated enterprise gateway or short-lived credential helper for private repositories.

## Engine-specific boundary

Codex execution uses its workspace sandbox and network policy. Claude Code and dsh use their own permission systems inside the filtered disposable workspace; do not enable broader tool permissions than needed. A custom engine that directly inherits a key is rejected unless the caller explicitly opts into unsafe inheritance.

Replay container isolation does not automatically containerize the Agent CLI itself. For private source requiring hard egress containment, run this Action on a dedicated runner with an outbound policy or keep `investigation.mode: plan`.

The distributed `dist/index.js` is rebuilt and compared in CI. Consumers should pin releases by a full commit SHA when their supply-chain policy requires immutability.
