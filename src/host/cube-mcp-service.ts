/** GEA selects the Consumer from the real Core Session, never from tool arguments. */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { Business } from "./business.ts";
import { assertSessionResourceAvailable, toolConsumer } from "./business-identity.ts";
import { profileFor } from "./prompt-policy.ts";
import { throwIfAborted, readableError } from "../shared/abort.ts";
import { stopExpiredGateway } from "./agent-tools.ts";
import type { CubeMcpTool } from "./cube-mcp-client.ts";
import { isDeepStrictEqual } from "node:util";

export function createCubeMcpService(ctx: Context, business: Business) {
  return {
    version: 2 as const,
    authenticated: () => business.status().authenticated,
    identitySignal: () => business.identitySignal(),
    watch: (listener: () => void) => {
      const offs = [
        business.watchIdentity(listener),
        ...(
          ["agent/created", "agent/disposed", "agent-preset/selected", "skills/change"] as const
        ).map((event) => ctx.on(event, listener)),
      ];
      return () => offs.forEach((off) => off());
    },
    allows: (sessionId: string) => {
      const agent = ctx.agents.get(sessionId as SessionId);
      const preset = agent
        ? ctx.sessionProjections.stateOf(agent.session, "agentPreset")
        : undefined;
      return business.status().authenticated && !!profileFor(preset ?? undefined);
    },
    listTools: async (signal: AbortSignal) => {
      signal = AbortSignal.any([signal, business.identitySignal()]);
      const attempted = new Set<string>();
      let failure: unknown;
      const discovered = new Map<string, CubeMcpTool>();
      let available = false;
      for (const agent of ctx.agents.list()) {
        const preset = ctx.sessionProjections.stateOf(agent.session, "agentPreset");
        if (!profileFor(preset ?? undefined)) continue;
        try {
          await assertSessionResourceAvailable(ctx, agent.id, signal);
          const consumer = toolConsumer(ctx, business, agent.id, undefined);
          if (attempted.has(consumer)) continue;
          attempted.add(consumer);
          const module = await business.moduleMcp(consumer, signal);
          throwIfAborted(signal);
          await assertSessionResourceAvailable(ctx, agent.id, signal);
          if (toolConsumer(ctx, business, agent.id, undefined) !== consumer)
            throw Error("GEA_MCP_EXECUTION_OWNER_CHANGED");
          for (const tool of module.tools()) {
            const previous = discovered.get(tool.name);
            if (previous && !isDeepStrictEqual(previous.inputSchema, tool.inputSchema))
              throw Error("GEA_MCP_SCHEMA_CONFLICT");
            if (!previous) discovered.set(tool.name, tool);
          }
          available = true;
        } catch (error) {
          throwIfAborted(signal);
          if (error instanceof Error && error.message === "GEA_MCP_SCHEMA_CONFLICT") throw error;
          failure ??= error;
        }
      }
      if (available) return [...discovered.values()];
      if (failure) throw failure;
      return [];
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
          !signal.aborted &&
          toolConsumer(ctx, business, sessionId, undefined) === consumer &&
          (("code" in error && error.code === "DATA_QUERY_MEMBER_NOT_PUBLISHED") ||
            ("category" in error && error.category === "RESPONSE_CONTRACT"))
        )
          business.stopTurn(sessionId, error.message);
        throw readableError(error);
      }
    },
  };
}
