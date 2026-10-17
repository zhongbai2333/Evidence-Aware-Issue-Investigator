# Changelog

## Unreleased

- Make the bundled Rust compiler and Cargo work under Codex's core shell environment without inherited rustup settings; compile and execute a Rust readiness probe in Linux isolation CI.

- Preserve explicit boundary-phase errors, retry malformed controller JSON once without retrying valid rejections, conservatively format unstructured executor reports, and bound normalized telemetry to the publication schema.

- Warn the executor before its hard model-request budget is exhausted; distinguish controller budget denials from upstream rate limiting in sanitized runtime evidence.

- Exercise the actual pinned Codex CLI against a streaming mock provider inside the executor; preserve redacted JSONL failure diagnostics and allow client-executed namespaced tools through the model proxy.

- Add isolated online Codex execution with disposable hardened containers, normal public networking, external credentials/publication, independent input/output reviews and Linux boundary integration tests.

- Initial Node 24 GitHub Action.
- Pluggable Codex, Claude Code, dsh, and custom engines.
- Native model/provider switching with exact CLI lifecycle controls.
- Disposable execution, credential proxy, evidence normalization, clean replay, duplicate retrieval, and maintainer-confirmed GitHub state transitions.
- Document the Ubuntu 24.04 AppArmor prerequisite for Bubblewrap-backed Codex sandboxes.
- Add Provider-neutral controller Auto-review for public Issue attachments and dynamically proposed HTTPS `GET`/`HEAD` evidence while keeping the investigation Agent directly offline; redact endpoint URLs from reports.
- Use a controller-polled filesystem queue for reviewed dynamic egress so Codex's Bubblewrap sandbox can reach the broker without Unix-socket permissions.
