# Provider and model routing

Model switching is a core feature, not a dependency on a third-party profile manager.

## Native routing

Use the CLI vendor's normal provider with an explicit model profile.

## Compatible routing

Supply a compatible endpoint, wire protocol, model name, and credential reference. The adapter translates the neutral profile into the selected CLI's configuration.

## Enterprise routing

Use a company gateway and prefer `auth.mode: command` so the CLI fetches a short-lived token instead of inheriting a long-lived API key. Network and data residency remain properties of the customer's gateway.

## Local routing

Point at a loopback or private-network provider. The selected model must still implement the tool-use and structured-output behavior required by its engine.

## External switchers

CCSwitch and similar products may remain useful for interactive desktops and manually prepared runners. They can be integrated later as import/export helpers or custom commands. The Action does not require them and does not read their private databases by default.

## Compatibility is not guaranteed by protocol alone

An endpoint accepting an OpenAI- or Anthropic-shaped request may still differ in reasoning fields, tool-call streaming, context length, JSON Schema support, or retry behavior. Each engine/provider pair therefore needs an explicit compatibility test before being described as supported.

Current enforced pairings are Codex → Responses, Claude Code → Anthropic Messages, and dsh's built-in DeepSeek adapter → Chat Completions.
