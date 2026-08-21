import { readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { configSchema, type InvestigatorConfig } from "./schema";

export async function loadConfig(workspace: string, configPath: string): Promise<InvestigatorConfig> {
  const absolutePath = path.resolve(workspace, configPath);
  const relative = path.relative(workspace, absolutePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Config path escapes the workspace: ${configPath}`);
  }

  let parsed: unknown = {};
  try {
    parsed = yaml.load(await readFile(absolutePath, "utf8")) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  return configSchema.parse(parsed);
}

export interface RuntimeOverrides {
  engine?: string;
  provider?: string;
  model?: string;
  mode?: string;
}

export function applyRuntimeOverrides(
  original: InvestigatorConfig,
  overrides: RuntimeOverrides,
): InvestigatorConfig {
  const config = structuredClone(original);
  if (overrides.engine) config.investigation.engine = overrides.engine as InvestigatorConfig["investigation"]["engine"];
  if (overrides.provider) config.investigation.provider = overrides.provider;
  if (overrides.mode) config.investigation.mode = overrides.mode as InvestigatorConfig["investigation"]["mode"];
  const selectedProvider = config.investigation.provider;
  if (overrides.model) {
    if (!selectedProvider || !config.providers[selectedProvider]) {
      throw new Error("A model override requires a selected provider profile");
    }
    config.providers[selectedProvider] = { ...config.providers[selectedProvider], model: overrides.model };
  }
  return configSchema.parse(config);
}
