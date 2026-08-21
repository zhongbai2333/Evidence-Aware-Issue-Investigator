import type { AgentInvocationPlan } from "../contracts";
import { authEnvironment, timeoutMs, type AdapterContext, type AgentAdapter } from "./base";

export class CustomAdapter implements AgentAdapter {
  plan(context: AdapterContext): AgentInvocationPlan {
    const { config, provider, providerName, prompt, workspace } = context;
    if (!config.investigation.command) {
      throw new Error("investigation.command is required for the custom agent engine");
    }

    const configuredArgs = config.investigation.argsPrefix.length
      ? config.investigation.argsPrefix
      : ["{prompt}"];

    return {
      engine: "custom",
      provider: providerName,
      model: provider?.model ?? null,
      command: config.investigation.command,
      args: configuredArgs.map((arg) => arg === "{prompt}" ? prompt : arg),
      cwd: workspace,
      environment: authEnvironment(provider),
      generatedFiles: {},
      outputFormat: "json",
      timeoutMs: timeoutMs(config),
      versionCheck: null,
      credentialProxy: null,
    };
  }
}
