import type { Context } from "@deepseek-ai/cordis";
import type { Business } from "./business.ts";
import { resolveCubeAccess } from "./cube-access.ts";
import { WORKBENCH_AGENT_CODE } from "./shared-agent.ts";

/** Installed orchestration sources may reuse fixed inventory definitions, keeping their own Consumer. */
export function orchestrationInventoryAccess(ctx: Context, business: Business, sessionId: string) {
  const agent = ctx.agents.get(sessionId as Parameters<typeof ctx.agents.get>[0]);
  if (!agent || ctx.sessionProjections.stateOf(agent.session, "agentPreset") !== "auto-negotiation")
    return undefined;
  const access = resolveCubeAccess(ctx, business, sessionId);
  if (access.sourceRef !== "auto-negotiation" || access.consumerCode !== WORKBENCH_AGENT_CODE)
    throw Error("GEA_INVENTORY_SOURCE_UNAVAILABLE");
  return access;
}

export function orchestrationInventoryAllowed(ctx: Context, business: Business, sessionId: string) {
  try {
    return !!orchestrationInventoryAccess(ctx, business, sessionId);
  } catch {
    return false;
  }
}
