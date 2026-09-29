import type { Context } from "@deepseek-ai/cordis";
import type { Business } from "./business.ts";
import { profileFor } from "./prompt-policy.ts";

/** The GEA environment, tenant and user jointly own page Sessions and saved references. */
export function businessIdentityKey(business: Business): string | undefined {
  const status = business.status();
  return status.user?.id
    ? JSON.stringify([status.environment, status.user.tenantId ?? null, status.user.id])
    : undefined;
}

/** The selected business preset owns model and tool identity, including unbound sessions. */
export function sessionConsumer(
  ctx: Context,
  business: Business,
  sessionId?: string,
): string {
  const agent = sessionId
    ? ctx.agents?.get(sessionId as Parameters<typeof ctx.agents.get>[0])
    : undefined;
  const preset = agent
    ? ctx.sessionProjections.stateOf(agent.session, "agentPreset")
    : undefined;
  const profile = profileFor(preset ?? undefined);
  if (profile)
    return preset === "gea-readonly"
      ? business.config.analysisAgentCode
      : profile.consumerCode;
  const page = sessionId
    ? business.currentPageIdentity?.(sessionId)
    : undefined;
  return page && !page.mock
    ? page.consumerCode
    : business.config.analysisAgentCode;
}

/** Explicit cross-domain paths come from the trusted profile, never model-supplied registration claims. */
export function toolConsumer(
  ctx: Context,
  business: Business,
  sessionId: string | undefined,
  requested: unknown,
): string {
  const current = sessionConsumer(ctx, business, sessionId);
  if (typeof requested !== "string" || !requested.trim()) return current;
  const target = requested.trim();
  const agent = sessionId
    ? ctx.agents?.get(sessionId as Parameters<typeof ctx.agents.get>[0])
    : undefined;
  const preset = agent
    ? ctx.sessionProjections.stateOf(agent.session, "agentPreset")
    : undefined;
  const profile = profileFor(preset ?? undefined);
  const routes =
    profile?.crossConsumers?.map((code) =>
      code === "sales_forecast" ? business.config.analysisAgentCode : code,
    ) ?? [];
  if (profile && target !== current && !routes.includes(target))
    throw Error(
      "GEA_CONSUMER_ROUTE_NOT_REGISTERED: 当前Agent未登记此跨业务路径；不得通过更换consumer试探。请使用当前身份或交付该范围的能力缺口。",
    );
  return target;
}
