import type { AgentInvocationPlan } from "../contracts";
import { proxiedCredential, resolveCli, timeoutMs, type AdapterContext, type AgentAdapter } from "./base";

export class DshAdapter implements AgentAdapter {
  plan(context: AdapterContext): AgentInvocationPlan {
    const { config, provider, providerName, prompt, workspace } = context;
    if (provider && provider.protocol !== "chat-completions") {
      throw new Error("dsh DeepSeek headless adapter requires a Chat Completions-compatible provider");
    }
    if (provider?.auth.mode === "command") {
      throw new Error("dsh command-backed auth requires a trusted wrapper command; use environment proxy auth or investigation.command");
    }
    const credential = proxiedCredential(provider, "DEEPSEEK_API_KEY", "https://api.deepseek.com");
    const environment: AgentInvocationPlan["environment"] = { ...credential.environment };
    if (credential.baseUrl ?? provider?.baseUrl) {
      environment.DEEPSEEK_BASE_URL = { value: credential.baseUrl ?? provider!.baseUrl!, sensitive: false };
    }
    if (provider) environment.DSH_HOME = { value: "{tempDir}/dsh-home", sensitive: false };
    const cli = resolveCli(config, "dsh", "dsh");

    return {
      engine: "dsh",
      provider: providerName,
      model: provider?.model ?? null,
      command: cli.command,
      args: [
        ...cli.prefix,
        "--profile",
        "headless",
        prompt,
      ],
      cwd: workspace,
      environment,
      generatedFiles: provider ? {
        "dsh-home/settings.yaml": [
          "agent-default-model:",
          "  provider: deepseek-official",
          `  model: ${JSON.stringify(provider.model)}`,
          "llm-deepseek:",
          `  baseURL: ${JSON.stringify(credential.baseUrl ?? provider.baseUrl ?? "https://api.deepseek.com")}`,
          "  apiKeyEnv: DEEPSEEK_API_KEY",
          "  models:",
          `    - id: ${JSON.stringify(provider.model)}`,
          "",
        ].join("\n"),
      } : {},
      outputFormat: "text",
      timeoutMs: timeoutMs(config),
      versionCheck: cli.versionCheck,
      credentialProxy: credential.proxy,
    };
  }
}
