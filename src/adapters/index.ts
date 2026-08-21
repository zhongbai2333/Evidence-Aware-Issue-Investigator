import type { AgentAdapter, AdapterContext } from "./base";
import type { AgentInvocationPlan } from "../contracts";
import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { CustomAdapter } from "./custom";
import { DshAdapter } from "./dsh";

export function planAgentInvocation(context: AdapterContext): AgentInvocationPlan {
  const engine = context.config.investigation.engine;
  let adapter: AgentAdapter;

  switch (engine) {
    case "codex":
      adapter = new CodexAdapter();
      break;
    case "claude":
      adapter = new ClaudeAdapter();
      break;
    case "dsh":
      adapter = new DshAdapter();
      break;
    case "custom":
      adapter = new CustomAdapter();
      break;
    case "none":
      throw new Error("No investigation agent engine is configured");
  }

  return adapter.plan(context);
}
