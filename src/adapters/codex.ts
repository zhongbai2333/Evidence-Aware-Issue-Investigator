import type { AgentInvocationPlan } from "../contracts";
import type { ProviderConfig } from "../schema";
import { headerEnvironment, proxiedCredential, resolveCli, timeoutMs, type AdapterContext, type AgentAdapter } from "./base";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function renderProviderConfig(
  providerName: string,
  provider: ProviderConfig,
  network: boolean,
  baseUrlOverride: string | null,
  envKeyOverride: string | null,
): string {
  const lines = [
    `model = ${tomlString(provider.model)}`,
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    "allow_login_shell = false",
    "",
    "[sandbox_workspace_write]",
    `network_access = ${network ? "true" : "false"}`,
    "",
    "[shell_environment_policy]",
    'inherit = "core"',
    "ignore_default_excludes = false",
  ];

  if (provider.kind === "native") {
    if (baseUrlOverride ?? provider.baseUrl) {
      lines.splice(1, 0, `openai_base_url = ${tomlString(baseUrlOverride ?? provider.baseUrl!)}`);
    }
    return `${lines.join("\n")}\n`;
  }

  if (provider.protocol !== "responses") {
    throw new Error("Codex custom providers currently require the Responses protocol");
  }
  lines.splice(1, 0, `model_provider = ${tomlString(providerName)}`);
  lines.push(
    "",
    `[model_providers.${providerName}]`,
    `name = ${tomlString(`Issue Investigator: ${providerName}`)}`,
    'wire_api = "responses"',
  );
  lines.push(`base_url = ${tomlString(baseUrlOverride ?? provider.baseUrl!)}`);
  if (envKeyOverride ?? (provider.auth.mode === "environment" ? provider.auth.env : null)) {
    lines.push(`env_key = ${tomlString(envKeyOverride ?? provider.auth.env!)}`);
  }
  const headerEntries = baseUrlOverride ? [] : Object.entries(provider.headersFromEnv);
  if (headerEntries.length) {
    const rendered = headerEntries
      .map(([header, envName]) => `${tomlString(header)} = ${tomlString(envName)}`)
      .join(", ");
    lines.push(`env_http_headers = { ${rendered} }`);
  }
  if (provider.auth.mode === "command" && provider.auth.command) {
    lines.push("", `[model_providers.${providerName}.auth]`);
    lines.push(`command = ${tomlString(provider.auth.command)}`);
    lines.push(`args = [${provider.auth.args.map(tomlString).join(", ")}]`);
    lines.push("timeout_ms = 5000");
  }

  return `${lines.join("\n")}\n`;
}

export class CodexAdapter implements AgentAdapter {
  plan(context: AdapterContext): AgentInvocationPlan {
    const { config, provider, providerName, prompt, workspace } = context;
    const cli = resolveCli(config, "codex", "codex");
    const credential = proxiedCredential(
      provider,
      provider?.kind === "native" ? "CODEX_API_KEY" : "ISSUE_INVESTIGATOR_PROXY_TOKEN",
      "https://api.openai.com/v1",
    );
    const args = [
      ...cli.prefix,
      "exec",
      "--ephemeral",
      "--json",
      "--sandbox",
      config.investigation.workspace,
      "--ask-for-approval",
      "never",
      "--ignore-rules",
      "--output-schema",
      "{schemaPath}",
      "--output-last-message",
      "{outputPath}",
      prompt,
    ];

    const generatedFiles: Record<string, string> = {};
    if (provider && providerName) {
      generatedFiles["codex-home/config.toml"] = renderProviderConfig(
        "investigator",
        provider,
        config.investigation.network,
        credential.baseUrl,
        credential.envKey,
      );
    }

    return {
      engine: "codex",
      provider: providerName,
      model: provider?.model ?? null,
      command: cli.command,
      args,
      cwd: workspace,
      environment: {
        ...credential.environment,
        ...(credential.proxy ? {} : headerEnvironment(provider)),
        ...(generatedFiles["codex-home/config.toml"]
          ? { CODEX_HOME: { value: "{tempDir}/codex-home", sensitive: false } }
          : {}),
      },
      generatedFiles,
      outputFormat: "jsonl",
      timeoutMs: timeoutMs(config),
      versionCheck: cli.versionCheck,
      credentialProxy: credential.proxy,
    };
  }
}
