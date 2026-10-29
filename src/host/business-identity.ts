import type { Context } from "@deepseek-ai/cordis";
import type { Business } from "./business.ts";
import { profileFor } from "./prompt-policy.ts";
import { WORKBENCH_AGENT_CODE } from "./shared-agent.ts";

/** HTML resource availability comes from Manage's current validated registration, not the retained preset profile. */
export async function assertBusinessResourceAvailable(
  ctx: Context,
  preset: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (preset !== "gea-readonly" && !preset?.startsWith("gea-html-")) return;
  signal?.throwIfAborted();
  const resource = (await ctx.agentResources.list({ signal })).find(
    (item) => item.id === preset && item.kind === "prompt" && item.installed,
  );
  signal?.throwIfAborted();
  let code: string | undefined;
  if (!resource) code = "GEA_AGENT_RESOURCE_MISSING";
  else if (resource.error) code = "GEA_AGENT_RESOURCE_UNAVAILABLE";
  else if (!resource.enabled) code = "GEA_AGENT_RESOURCE_DISABLED";
  if (code) throw Object.assign(Error(code), { code });
}

/** Persistent Session presets must be checked again before model or tool execution. */
export async function assertSessionResourceAvailable(
  ctx: Context,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const agent = sessionId
    ? ctx.agents?.get(sessionId as Parameters<typeof ctx.agents.get>[0])
    : undefined;
  const preset = agent ? ctx.sessionProjections.stateOf(agent.session, "agentPreset") : undefined;
  await assertBusinessResourceAvailable(ctx, preset ?? undefined, signal);
}

/** The GEA environment, tenant and user jointly own page Sessions and saved references. */
export function businessIdentityKey(business: Business): string | undefined {
  const status = business.status();
  return status.user?.id
    ? JSON.stringify([status.environment, status.user.tenantId ?? null, status.user.id])
    : undefined;
}

/** The selected business preset owns model and tool identity, including unbound sessions. */
export function sessionConsumer(ctx: Context, business: Business, sessionId?: string): string {
  const agent = sessionId
    ? ctx.agents?.get(sessionId as Parameters<typeof ctx.agents.get>[0])
    : undefined;
  const preset = agent ? ctx.sessionProjections.stateOf(agent.session, "agentPreset") : undefined;
  const profile = profileFor(preset ?? undefined);
  if (profile)
    return preset === "gea-readonly" ? business.config.analysisAgentCode : profile.consumerCode;
  if (agent && ctx.userAgents?.cubeFor(agent)) return WORKBENCH_AGENT_CODE;
  return (
    (preset ? ctx.agentResources?.cubeSource(preset)?.consumerCode : undefined) ??
    WORKBENCH_AGENT_CODE
  );
}

/** Explicit cross-domain paths come from the trusted profile, never model-supplied registration claims. */
export function toolConsumer(
  ctx: Context,
  business: Business,
  sessionId: string | undefined,
  requested: unknown,
): string {
  const agent = sessionId
    ? ctx.agents?.get(sessionId as Parameters<typeof ctx.agents.get>[0])
    : undefined;
  const preset = agent ? ctx.sessionProjections.stateOf(agent.session, "agentPreset") : undefined;
  const profile = profileFor(preset ?? undefined);
  if (!profile)
    throw Error(
      "GEA_BUSINESS_PROFILE_REQUIRED: 请先选用已安装启用的业务资源；Skill或页面可见不授予Consumer业务权限。",
    );
  const current = sessionConsumer(ctx, business, sessionId);
  if (typeof requested !== "string" || !requested.trim()) return current;
  const target = requested.trim();
  const routes =
    profile?.crossConsumers?.map((code) =>
      code === "sales_forecast" ? business.config.analysisAgentCode : code,
    ) ?? [];
  if (target !== current && !routes.includes(target))
    throw Error(
      "GEA_CONSUMER_ROUTE_NOT_REGISTERED: 当前Agent未登记此跨业务路径；不得通过更换consumer试探。请使用当前身份或交付该范围的能力缺口。",
    );
  return target;
}

export function mountBusinessIdentity(
  ctx: Pick<Context, "effect" | "connection">,
  business: Business,
): void {
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: "/api/gea-html/identity",
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async () => {
        const { environment, environments, authenticated, loginState, user } = business.status();
        return Response.json(
          {
            scope: business.pageSessionScope() ?? null,
            subject: businessIdentityKey(business) ?? null,
            status: { environment, environments, authenticated, loginState, user },
            // A projection of the gateway-verified receipt. It is intentionally
            // absent until the customer-inventory page has requested its own
            // delegated session; page labels never manufacture an access range.
            customerInventory: business.customerInventoryIdentity?.() ?? null,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    }),
  );
}
