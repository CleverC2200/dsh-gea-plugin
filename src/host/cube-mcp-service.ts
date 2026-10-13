/** GEA selects the Consumer from the real Core Session, never from tool arguments. */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { Business } from "./business.ts";
import { assertSessionResourceAvailable, toolConsumer } from "./business-identity.ts";
import { profileFor } from "./prompt-policy.ts";
import { throwIfAborted, readableError } from "../shared/abort.ts";
import { stopExpiredGateway } from "./agent-tools.ts";

export function createCubeMcpService(ctx: Context, business: Business) {
  return {
    version: 2 as const,
    authenticated: () => business.status().authenticated,
    watch: (listener: () => void) => business.watchIdentity(listener),
    allows: (sessionId: string) => {
      const agent = ctx.agents.get(sessionId as SessionId);
      const preset = agent
        ? ctx.sessionProjections.stateOf(agent.session, "agentPreset")
        : undefined;
      return business.status().authenticated && !!profileFor(preset ?? undefined);
    },
    listTools: async (signal: AbortSignal) => {
      business.invalidateModuleMcp(business.config.analysisAgentCode);
      return (await business.moduleMcp(business.config.analysisAgentCode, signal)).tools();
    },
    call: async (
      sessionId: string,
      name: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => {
      signal = AbortSignal.any([signal, business.identitySignal()]);
      await assertSessionResourceAvailable(ctx, sessionId, signal);
      const consumer = toolConsumer(ctx, business, sessionId, undefined);
      const stopped = business.turnStopped(sessionId);
      if (stopped) throw Error(`GEA_TURN_STOPPED: ${stopped}`);
      if (name === "inspect_cube_model") business.invalidateModuleMcp(consumer);
      const module = await business.moduleMcp(consumer, signal);
      try {
        const result = await module.call(name, args, signal);
        throwIfAborted(signal);
        await assertSessionResourceAvailable(ctx, sessionId, signal);
        if (toolConsumer(ctx, business, sessionId, undefined) !== consumer)
          throw Error("GEA_MCP_EXECUTION_OWNER_CHANGED");
        return result;
      } catch (error) {
        const expired = stopExpiredGateway(business, consumer, sessionId, error);
        if (expired) throw expired;
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "DATA_QUERY_MEMBER_NOT_PUBLISHED"
        )
          business.stopTurn(sessionId, error.message);
        throw readableError(error);
      }
    },
  };
}
