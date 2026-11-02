import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import Llm, { createUserMessage } from "@deepseek-ai/dsh-llm";
import Agents from "@deepseek-ai/dsh-agent";
import Sessions, { SessionId } from "@deepseek-ai/dsh-session";
import { createGeaMemoryService } from "../../src/host/memory-service.ts";
import { MemorySessionLedger } from "../../src/host/memory-session-ledger.ts";

const core = resolve("../../official-latest-standard");
export const load = (path) => import(pathToFileURL(join(core, path, "lib/index.js")).href);
const [
  { default: Projections },
  { default: Prompt },
  { default: Tools },
  { default: Loop },
  { default: Typert },
  { default: SessionController },
] = await Promise.all([
  load("packages/session/session-projection"),
  load("packages/core/system-prompt"),
  load("packages/core/tools"),
  load("packages/core/agent-loop"),
  load("packages/typert/registry"),
  load("packages/api/session-controller"),
]);
export const alice = {
  environment: "production",
  tenantId: "10",
  userId: "alice",
};
export const bob = { ...alice, userId: "bob" };
export const message = (kind = "user", text = "你好") =>
  createUserMessage({
    source: kind === "user" ? { kind } : { kind, plugin: kind.slice(7), scope: alice },
    content: [{ type: "text", text }],
  });
export async function fixture(t, { persist = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "memory-session-guard-"));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  await ctx.plugin(Typert);
  if (persist) {
    const { default: Persistence } = await load("packages/session/session-persistence-jsonl");
    await ctx.plugin(Persistence, {
      root: join(dir, "sessions"),
      compression: "none",
    });
  }
  await ctx.plugin(Llm);
  await ctx.plugin(Sessions);
  await ctx.plugin(Projections);
  if (persist) {
    const { default: Query } = await load("packages/session-query/session-query");
    new Query(ctx);
  }
  await ctx.plugin(Prompt);
  await ctx.plugin(Tools);
  await ctx.plugin(Agents);
  await ctx.plugin(Loop, { agents: [] });
  ctx.provide("fileUploads", { registerAgentResolver: () => () => {} });
  const controller = new SessionController(ctx, { nativeOpen: false });
  let scope = alice;
  let epoch = new AbortController();
  const business = {
    memory: { state: async () => ({ scope }) },
    memoryScope: () => {
      if (!scope) throw Error("MEMORY_UNAUTHENTICATED");
      return scope;
    },
    identitySignal: () => epoch.signal,
    status: () => ({ authenticated: !!scope }),
    watchIdentity: () => () => {},
  };
  const ledger = new MemorySessionLedger(dir);
  const service = () =>
    createGeaMemoryService(business, {
      ledger: new MemorySessionLedger(dir),
      sessions: controller,
    });
  return {
    ctx,
    dir,
    ledger,
    business,
    service,
    controller,
    swap(next) {
      const previous = epoch;
      scope = next;
      epoch = new AbortController();
      previous.abort(Error("identity changed"));
    },
    create(id) {
      return ctx.agentLoop.create(SessionId(id), {
        provider: "direct",
        model: "fixture",
      });
    },
  };
}
