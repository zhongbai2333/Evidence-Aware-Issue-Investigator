import { describe, expect, it } from "vitest";
import { planAgentInvocation } from "../src/adapters";
import { resolveProvider } from "../src/adapters/base";
import { buildInvestigationPrompt } from "../src/prompt";
import { assertExecutionSafety } from "../src/runner";
import { configSchema } from "../src/schema";
import { issueFixture } from "./fixtures";

function makeConfig(engine: "codex" | "claude" | "dsh", provider = "economical") {
  return configSchema.parse({
    providers: {
      economical: {
        kind: "compatible",
        model: "coder-small",
        baseUrl: "https://gateway.example/v1",
        protocol: engine === "claude"
          ? "anthropic-messages"
          : (engine === "dsh" ? "chat-completions" : "responses"),
        auth: { mode: "environment", env: "COMPANY_LLM_KEY" },
      },
      secure: {
        kind: "enterprise",
        model: "secure-coder",
        baseUrl: "https://llm.corp.example/v1",
        protocol: "responses",
        auth: {
          mode: "command",
          command: "/usr/local/bin/fetch-token",
          args: ["--audience", "investigator"],
        },
      },
    },
    investigation: {
      engine,
      provider,
      trigger: "always",
    },
  });
}

function plan(engine: "codex" | "claude" | "dsh", provider?: string) {
  const config = makeConfig(engine, provider);
  const resolved = resolveProvider(config);
  return planAgentInvocation({
    config,
    providerName: resolved.name,
    provider: resolved.provider,
    prompt: buildInvestigationPrompt(issueFixture),
    workspace: "/workspace",
  });
}

describe("agent adapters", () => {
  it("builds an isolated Codex custom-provider configuration", () => {
    const invocation = plan("codex");
    const config = invocation.generatedFiles["codex-home/config.toml"];
    expect(invocation.command).toBe("codex");
    expect(invocation.args).toContain("--output-schema");
    expect(config).toContain('model = "coder-small"');
    expect(config).toContain('base_url = "{proxyBaseUrl}"');
    expect(config).toContain('env_key = "ISSUE_INVESTIGATOR_PROXY_TOKEN"');
    expect(invocation.credentialProxy?.upstreamBaseUrl).toBe("https://gateway.example/v1");
    expect(config).toContain("ignore_default_excludes = false");
  });

  it("switches the Codex model and endpoint by selecting another provider", () => {
    const invocation = plan("codex", "secure");
    const config = invocation.generatedFiles["codex-home/config.toml"];
    expect(invocation.provider).toBe("secure");
    expect(invocation.model).toBe("secure-coder");
    expect(config).toContain('base_url = "https://llm.corp.example/v1"');
    expect(config).toContain('command = "/usr/local/bin/fetch-token"');
  });

  it("maps a provider profile to Claude Code without requiring CCSwitch", () => {
    const invocation = plan("claude");
    expect(invocation.command).toBe("claude");
    expect(invocation.args).toContain("--json-schema");
    expect(invocation.environment.ANTHROPIC_BASE_URL?.value).toBe("{proxyBaseUrl}");
    expect(invocation.environment.ANTHROPIC_MODEL?.value).toBe("coder-small");
    expect(invocation.environment.ANTHROPIC_API_KEY?.value).toBe("{proxyToken}");
    expect(invocation.credentialProxy?.sourceEnv).toBe("COMPANY_LLM_KEY");
  });

  it("rejects protocol and engine combinations that cannot preserve tool semantics", () => {
    const config = makeConfig("codex");
    config.providers.economical!.protocol = "anthropic-messages";
    const resolved = resolveProvider(config);
    expect(() => planAgentInvocation({
      config,
      providerName: resolved.name,
      provider: resolved.provider,
      prompt: "investigate",
      workspace: "/workspace",
    })).toThrow("Responses protocol");
  });

  it("rejects Chat Completions for Codex because current Codex wire_api only supports Responses", () => {
    const config = makeConfig("codex");
    config.providers.economical!.protocol = "chat-completions";
    const resolved = resolveProvider(config);
    expect(() => planAgentInvocation({
      config,
      providerName: resolved.name,
      provider: resolved.provider,
      prompt: "investigate",
      workspace: "/workspace",
    })).toThrow("Responses protocol");
  });

  it("keeps dsh as an optional headless adapter", () => {
    const invocation = plan("dsh");
    expect(invocation.command).toBe("dsh");
    expect(invocation.args.slice(0, 2)).toEqual(["--profile", "headless"]);
    expect(invocation.outputFormat).toBe("text");
    expect(invocation.generatedFiles["dsh-home/settings.yaml"]).toContain('model: "coder-small"');
    expect(invocation.environment.DSH_HOME?.value).toBe("{tempDir}/dsh-home");
  });

  it("uses only an exact pinned package version in npx lifecycle mode", () => {
    const config = makeConfig("codex");
    config.cli.install = "npx";
    config.cli.versions.codex = "1.2.3";
    const resolved = resolveProvider(config);
    const invocation = planAgentInvocation({
      config,
      providerName: resolved.name,
      provider: resolved.provider,
      prompt: "investigate",
      workspace: "/workspace",
    });
    expect(invocation.command).toBe("npx");
    expect(invocation.args.slice(0, 2)).toEqual(["-y", "@openai/codex@1.2.3"]);
    expect(invocation.versionCheck?.expectedVersion).toBe("1.2.3");
  });

  it("blocks unsafe direct credential inheritance for a custom engine without a proxy adapter", () => {
    const config = makeConfig("claude");
    config.investigation.mode = "execute";
    config.investigation.engine = "custom";
    const provider = resolveProvider(config).provider;
    expect(() => assertExecutionSafety(config, provider)).toThrow("credential");
  });
});
