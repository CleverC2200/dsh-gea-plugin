import type { Context } from "@deepseek-ai/cordis";
import type {} from "dsh-agent-manage/user-agent-cube";
import type { Business } from "./business.ts";
import { profileFor } from "./prompt-policy.ts";

/** Cube-only ownership. A personal reference never enters the business profile registry. */
export function resolveCubeAccess(ctx: Context, business: Business, sessionId: string) {
  if (!business.status().authenticated) throw Error("GEA_IDENTITY_REQUIRED");
  const agent = ctx.agents.get(sessionId as Parameters<typeof ctx.agents.get>[0]);
  if (!agent) throw Error("GEA_BUSINESS_PROFILE_REQUIRED: CALLING_AGENT_MISSING");
  const preset = ctx.sessionProjections.stateOf(agent.session, "agentPreset") ?? undefined;
  const profile = profileFor(preset);
  const association = profile ? undefined : ctx.userAgents?.cubeFor(agent);
  if (!profile && !association) throw Error("GEA_BUSINESS_PROFILE_REQUIRED: CUBE_NOT_SELECTED");
  association?.signal.throwIfAborted();
  const sourceRef = association?.sourceRef ?? preset!;
  const source = ctx.agentResources.cubeSource(sourceRef);
  if (!source) throw Error("GEA_CUBE_SOURCE_UNAVAILABLE");
  source.signal.throwIfAborted();
  const identity = business.identitySignal();
  identity.throwIfAborted();
  return {
    preset,
    sourceRef,
    consumerCode:
      sourceRef === "gea-readonly" ? business.config.analysisAgentCode : source.consumerCode,
    sourceSignal: source.signal,
    associationSignal: association?.signal,
    generation: association?.generation,
    identity,
  };
}
export function cubeAllowed(ctx: Context, business: Business, sessionId: string): boolean {
  try {
    resolveCubeAccess(ctx, business, sessionId);
    return true;
  } catch {
    return false;
  }
}
export function sameCubeAccess(
  a: ReturnType<typeof resolveCubeAccess>,
  b: ReturnType<typeof resolveCubeAccess>,
): boolean {
  return (
    a.preset === b.preset &&
    a.sourceRef === b.sourceRef &&
    a.consumerCode === b.consumerCode &&
    a.sourceSignal === b.sourceSignal &&
    a.associationSignal === b.associationSignal &&
    a.generation === b.generation &&
    a.identity === b.identity
  );
}
