# Changelog

## Unreleased

- Add isolated online Codex execution with disposable hardened containers, normal public networking, external credentials/publication, independent input/output reviews and Linux boundary integration tests.

- Initial Node 24 GitHub Action.
- Pluggable Codex, Claude Code, dsh, and custom engines.
- Native model/provider switching with exact CLI lifecycle controls.
- Disposable execution, credential proxy, evidence normalization, clean replay, duplicate retrieval, and maintainer-confirmed GitHub state transitions.
- Document the Ubuntu 24.04 AppArmor prerequisite for Bubblewrap-backed Codex sandboxes.
- Add Provider-neutral controller Auto-review for public Issue attachments and dynamically proposed HTTPS `GET`/`HEAD` evidence while keeping the investigation Agent directly offline; redact endpoint URLs from reports.
- Use a controller-polled filesystem queue for reviewed dynamic egress so Codex's Bubblewrap sandbox can reach the broker without Unix-socket permissions.
