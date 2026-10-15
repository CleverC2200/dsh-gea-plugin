/** GEA selects the Consumer from the real Core Session, never from tool arguments. */
import type { Context } from "@deepseek-ai/cordis";
import type { Business } from "./business.ts";
import { cubeAllowed, resolveCubeAccess, sameCubeAccess } from "./cube-access.ts";
import { throwIfAborted, readableError } from "../shared/abort.ts";
import { stopExpiredGateway } from "./agent-tools.ts";
import type { GatewayMcpTool } from "./gateway-mcp-client.ts";
import { isDeepStrictEqual } from "node:util";

export function createGatewayMcpService(ctx: Context, business: Business) {
  return {
    version: 2 as const,
    authenticated: () => business.status().authenticated,
    identitySignal: () => business.identitySignal(),
    watch: (listener: () => void) => {
      const offs = [
        business.watchIdentity(listener),
        ...(ctx.agentResources.watch ? [ctx.agentResources.watch(listener)] : []),
        ...(ctx.userAgents ? [ctx.userAgents.watch(listener)] : []),
        ...(
          ["agent/created", "agent/disposed", "agent-preset/selected", "skills/change"] as const
        ).map((event) => ctx.on(event, listener)),
      ];
      return () => offs.forEach((off) => off());
    },
    allows: (sessionId: string) => cubeAllowed(ctx, business, sessionId),
    listTools: async (signal: AbortSignal) => {
      signal = AbortSignal.any([signal, business.identitySignal()]);
      const attempted = new Set<string>();
      let failure: unknown;
      const discovered = new Map<string, GatewayMcpTool>();
      let available = false;
      for (const agent of ctx.agents.list()) {
        if (!cubeAllowed(ctx, business, agent.id)) continue;
        try {
          const access = resolveCubeAccess(ctx, business, agent.id);
          const consumer = access.consumerCode;
          const ownedSignal = AbortSignal.any([
            signal,
            access.sourceSignal,
            ...(access.associationSignal ? [access.associationSignal] : []),
          ]);
          if (attempted.has(consumer)) continue;
          attempted.add(consumer);
          const module = await business.moduleMcp(consumer, ownedSignal);
          throwIfAborted(signal);
          if (!sameCubeAccess(access, resolveCubeAccess(ctx, business, agent.id)))
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
      const access = resolveCubeAccess(ctx, business, sessionId);
      signal = AbortSignal.any([
        signal,
        access.identity,
        access.sourceSignal,
        ...(access.associationSignal ? [access.associationSignal] : []),
      ]);
      const consumer = access.consumerCode;
      const stopped = business.turnStopped(sessionId);
      if (stopped) throw Error(`GEA_TURN_STOPPED: ${stopped}`);
      if (name === "inspect_cube_model" || name === "weknora_list_knowledge_bases")
        business.invalidateModuleMcp(consumer);
      const module = await business.moduleMcp(consumer, signal);
      signal.throwIfAborted();
      if (!sameCubeAccess(access, resolveCubeAccess(ctx, business, sessionId)))
        throw Error("GEA_MCP_EXECUTION_OWNER_CHANGED");
      try {
        const result = await module.call(name, args, signal);
        throwIfAborted(signal);
        if (!sameCubeAccess(access, resolveCubeAccess(ctx, business, sessionId)))
          throw Error("GEA_MCP_EXECUTION_OWNER_CHANGED");
        return result;
      } catch (error) {
        const current =
          !signal.aborted &&
          cubeAllowed(ctx, business, sessionId) &&
          sameCubeAccess(access, resolveCubeAccess(ctx, business, sessionId));
        const expired = current
          ? stopExpiredGateway(business, consumer, sessionId, error)
          : undefined;
        if (expired) throw expired;
        if (
          error instanceof Error &&
          current &&
          (("code" in error && error.code === "DATA_QUERY_MEMBER_NOT_PUBLISHED") ||
            ("category" in error && error.category === "RESPONSE_CONTRACT"))
        )
          business.stopTurn(sessionId, error.message);
        throw readableError(error);
      }
    },
  };
}
