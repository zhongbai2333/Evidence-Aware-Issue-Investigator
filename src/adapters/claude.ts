import type { AgentInvocationPlan } from "../contracts";
import { REPORT_JSON_SCHEMA } from "../schema";
import { proxiedCredential, resolveCli, timeoutMs, type AdapterContext, type AgentAdapter } from "./base";

export class ClaudeAdapter implements AgentAdapter {
  plan(context: AdapterContext): AgentInvocationPlan {
    const { config, provider, providerName, prompt, workspace } = context;
    const cli = resolveCli(config, "claude", "claude");
    if (provider && provider.protocol !== "anthropic-messages") {
      throw new Error("Claude Code requires an Anthropic Messages-compatible provider");
    }
    if (provider?.auth.mode === "command") {
      throw new Error("Claude Code command-backed auth requires a trusted wrapper command; use environment proxy auth or investigation.command");
    }
    const tools = config.investigation.workspace === "read-only"
      ? "Read,Glob,Grep"
      : "Read,Glob,Grep,Bash,Edit,Write";

    const credential = proxiedCredential(provider, "ANTHROPIC_API_KEY", "https://api.anthropic.com");
    const environment: AgentInvocationPlan["environment"] = { ...credential.environment };
    if (credential.baseUrl ?? provider?.baseUrl) {
      environment.ANTHROPIC_BASE_URL = { value: credential.baseUrl ?? provider!.baseUrl!, sensitive: false };
    }
    if (provider?.model) {
      environment.ANTHROPIC_MODEL = { value: provider.model, sensitive: false };
    }

    return {
      engine: "claude",
      provider: providerName,
      model: provider?.model ?? null,
      command: cli.command,
      args: [
        ...cli.prefix,
        "--bare",
        "--print",
        prompt,
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(REPORT_JSON_SCHEMA),
        "--max-turns",
        String(config.investigation.maxTurns),
        "--permission-mode",
        "dontAsk",
        "--tools",
        tools,
        "--allowedTools",
        tools,
      ],
      cwd: workspace,
      environment,
      generatedFiles: {},
      outputFormat: "json",
      timeoutMs: timeoutMs(config),
      versionCheck: cli.versionCheck,
      credentialProxy: credential.proxy,
    };
  }
}
