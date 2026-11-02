import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { Business } from "./business.ts";
import type { GeaMemoryService } from "./memory-service.ts";

function untilAborted<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function mountMemorySessionGuard(
  ctx: Context,
  business: Business,
  memory: GeaMemoryService,
) {
  const activities = new Map<Agent, () => void>();
  const release = (agent: Agent) => {
    activities.get(agent)?.();
    activities.delete(agent);
  };
  ctx.effect(() =>
    ctx.on("agent/status", ({ agent, status }) => {
      release(agent);
      if (status !== "running") return;
      const identity = business.identitySignal();
      const changed = () => agent.cancel({ kind: "hook", reason: "GEA identity changed" });
      identity.addEventListener("abort", changed, { once: true });
      activities.set(agent, () => identity.removeEventListener("abort", changed));
      if (identity.aborted) changed();
    }),
  );
  ctx.effect(() => ctx.on("agent/disposed", ({ agent }) => release(agent)));
  ctx.effect(() => () => {
    for (const off of activities.values()) off();
    activities.clear();
  });
  ctx.effect(() =>
    ctx.on("llm/stream", async function* (options, next) {
      const identity = business.identitySignal();
      const invalidation = new AbortController();
      const agent = options.sessionId
        ? ctx.agents.get(brandString<SessionId>(options.sessionId))
        : undefined;
      const changed = () => {
        invalidation.abort(Error("MEMORY_IDENTITY_CHANGED"));
        agent?.cancel({ kind: "hook", reason: "GEA identity changed" });
      };
      identity.addEventListener("abort", changed, { once: true });
      if (identity.aborted) changed();
      const signal = AbortSignal.any(
        options.signal ? [options.signal, invalidation.signal] : [invalidation.signal],
      );
      let iterator: AsyncIterator<StreamChunk> | undefined;
      try {
        const sessionId = options.sessionId;
        if (sessionId) await untilAborted(() => memory.assertSession(sessionId, signal), signal);
        signal.throwIfAborted();
        const stream = next()[Symbol.asyncIterator]();
        iterator = stream;
        while (true) {
          const part = await untilAborted(() => stream.next(), signal);
          signal.throwIfAborted();
          if (part.done) return;
          yield part.value;
        }
      } finally {
        identity.removeEventListener("abort", changed);
        if (signal.aborted) void iterator?.return?.().catch(() => {});
        else await iterator?.return?.();
      }
    }),
  );
}
