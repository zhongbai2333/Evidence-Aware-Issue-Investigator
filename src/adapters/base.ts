import type { AgentInvocationPlan } from "../contracts";
import type { InvestigatorConfig, ProviderConfig } from "../schema";

export interface AdapterContext {
  config: InvestigatorConfig;
  providerName: string | null;
  provider: ProviderConfig | null;
  prompt: string;
  workspace: string;
}

export interface AgentAdapter {
  plan(context: AdapterContext): AgentInvocationPlan;
}

const npmPackages = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  dsh: "@deepseek-ai/dsh",
} as const;

export function resolveCli(
  config: InvestigatorConfig,
  engine: keyof typeof npmPackages,
  defaultCommand: string,
): {
  command: string;
  prefix: string[];
  versionCheck: AgentInvocationPlan["versionCheck"];
} {
  if (config.investigation.command) {
    return {
      command: config.investigation.command,
      prefix: config.investigation.argsPrefix,
      versionCheck: null,
    };
  }
  const version = config.cli.versions[engine] ?? null;
  if (config.cli.install === "npx") {
    if (!version) throw new Error(`cli.versions.${engine} is required for pinned npx installation`);
    const prefix = ["-y", `${npmPackages[engine]}@${version}`];
    return {
      command: "npx",
      prefix: [...prefix, ...config.investigation.argsPrefix],
      versionCheck: { command: "npx", args: [...prefix, "--version"], expectedVersion: version },
    };
  }
  return {
    command: defaultCommand,
    prefix: config.investigation.argsPrefix,
    versionCheck: { command: defaultCommand, args: ["--version"], expectedVersion: version },
  };
}

export function resolveProvider(config: InvestigatorConfig): {
  name: string | null;
  provider: ProviderConfig | null;
} {
  const name = config.investigation.provider ?? null;
  if (!name) return { name: null, provider: null };

  const provider = config.providers[name];
  if (!provider) throw new Error(`Unknown provider profile: ${name}`);
  return { name, provider };
}

export function authEnvironment(
  provider: ProviderConfig | null,
  targetName?: string,
): AgentInvocationPlan["environment"] {
  if (!provider || provider.auth.mode !== "environment" || !provider.auth.env) return {};
  const target = targetName ?? provider.auth.env;
  return {
    [target]: {
      fromEnv: provider.auth.env,
      sensitive: true,
    },
  };
}

export function proxiedCredential(
  provider: ProviderConfig | null,
  targetName: string,
  defaultBaseUrl: string,
): {
  environment: AgentInvocationPlan["environment"];
  proxy: AgentInvocationPlan["credentialProxy"];
  baseUrl: string | null;
  envKey: string | null;
} {
  if (!provider || provider.auth.mode !== "environment" || !provider.auth.env) {
    return { environment: {}, proxy: null, baseUrl: provider?.baseUrl ?? null, envKey: null };
  }
  return {
    environment: {
      [targetName]: { value: "{proxyToken}", sensitive: true },
    },
    proxy: {
      upstreamBaseUrl: provider.baseUrl ?? defaultBaseUrl,
      sourceEnv: provider.auth.env,
      protocol: provider.protocol,
      maxRequests: 100,
      headersFromEnv: provider.headersFromEnv,
    },
    baseUrl: "{proxyBaseUrl}",
    envKey: targetName,
  };
}

export function headerEnvironment(provider: ProviderConfig | null): AgentInvocationPlan["environment"] {
  if (!provider) return {};
  return Object.fromEntries(
    Object.values(provider.headersFromEnv).map((name) => [
      name,
      { fromEnv: name, sensitive: true },
    ]),
  );
}

export function timeoutMs(config: InvestigatorConfig): number {
  return config.investigation.timeoutMinutes * 60_000;
}
