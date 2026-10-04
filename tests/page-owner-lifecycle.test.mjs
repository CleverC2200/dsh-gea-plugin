import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The same frozen official services used by the assembled candidate, not the
// published development SDK or a substitute tools registration function.
const core = resolve("../../official-core");
const official = (path) => pathToFileURL(resolve(core, path)).href;
const { Context } = await import(official("vendor/cordis/lib/index.js"));
const { default: Tools } = await import(
  official("packages/core/tools/lib/index.js")
);
const { default: SystemPrompt } = await import(
  official("packages/core/system-prompt/lib/index.js")
);
const { default: Agents } = await import(
  official("packages/core/agent/lib/index.js")
);
const { createScope } = await import(
  official("packages/core/scope/lib/index.js")
);
const { Session, SessionId } = await import(
  official("packages/core/session/lib/index.js")
);
await mkdir(".scratch", { recursive: true });
const { outputFiles } = await build({
  stdin: {
    contents:
      "export * from './src/page-bridge/registry.ts';export * from './src/page-bridge/host.ts';export * from './src/host/native-page-owner.ts';export {startPageBridgeClient} from '../dsh-agent-workbench/src/page-interaction/page-bridge/client.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "official-tools",
      setup(builder) {
        builder.onResolve({ filter: /^@deepseek-ai\/dsh-tools$/ }, () => ({
          path: official("packages/core/tools/lib/index.js"),
          external: true,
        }));
      },
    },
  ],
});
const compiled = resolve(".scratch/page-owner-lifecycle.mjs");
await writeFile(compiled, outputFiles[0].text);
const {
  createPageToolRegistry,
  createPageBridge,
  startPageBridgeClient,
  createNativePageOwner,
} = await import(pathToFileURL(compiled).href);

async function mount(t) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(Tools);
  await ctx.plugin(Agents);
  const id = SessionId("session-11111111-1111-4111-8111-111111111111");
  const agent = { id, session: Session.create(id) };
  await ctx.plugin(
    Object.assign(
      (inner) => {
        agent.ctx = createScope(inner, agent).ctx;
      },
      { inject: ["tools", "systemPrompt"] },
    ),
  );
  const bridge = createPageBridge();
  const registry = createPageToolRegistry(ctx, bridge, { waitMs: 1000 });
  t.after(async () => {
    registry.shutdown();
    await ctx.fiber.dispose();
  });
  const catalog = (value) => ({
    surface: "gea-workbench",
    tool: "gea_workbench_apply",
    description: "Change this page view",
    elements: [
      {
        id: "filters",
        role: "control",
        label: "Filters",
        actions: ["reset"],
        value,
      },
    ],
  });
  const execute = (args) =>
    ctx.tools.execute({
      callId: "page-command",
      name: "gea_workbench_apply",
      arguments: args,
      agent,
      signal: new AbortController().signal,
    });
  return { ctx, agent, bridge, registry, catalog, execute };
}

for (const changed of [false, true])
  test(`native owner survives Agent mount and ${changed ? "changed" : "unchanged"} catalog accompanying its own reset result`, async (t) => {
    const { ctx, agent, bridge, registry, catalog, execute } = await mount(t);
    registry.declare(agent.id, catalog("customer"));
    await ctx.agents.register(agent);
    registry.declare(agent.id, catalog("customer"));
    const directory = await execute({ directory: true });
    assert.equal(directory.isError, false);
    let value = "customer";
    let applied = false;
    const stop = startPageBridgeClient({
      endpoint: "agui/workbench",
      sessionId: agent.id,
      initialDelayMs: 0,
      pollMs: 1,
      catalog: () => catalog(value),
      request: async (_endpoint, payload) => {
        registry.declare(payload.sessionId, payload.catalog);
        return { events: bridge.pull(payload.sessionId, payload.toolMessages) };
      },
      apply: (args) => {
        assert.deepEqual(args, {
          kind: "invoke",
          target: "filters",
          action: "reset",
          reason: "Reset the visible filters",
        });
        applied = true;
        if (changed) value = "all";
        return { applied: true };
      },
    });
    t.after(stop);
    const result = await execute({
      kind: "invoke",
      target: "filters",
      action: "reset",
      reason: "Reset the visible filters",
    });
    assert.equal(
      applied,
      true,
      "actual scoped execution reaches the bound page bridge",
    );
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(JSON.parse(result.content[0].text).applied, true);
    assert.equal(registry.receipts()[0].outcome, "applied");
    const refreshed = await execute({ directory: true, values: true });
    assert.equal(
      JSON.parse(refreshed.content[0].text).directory.entries[0].value,
      changed ? "all" : "customer",
    );
  });

test("closing the exact native connection removes catalog and surface and rejects late polls without harming a replacement", async (t) => {
  const { ctx, agent, bridge, registry, catalog, execute } = await mount(t);
  await ctx.agents.register(agent);
  let surface;
  let context;
  let scope = "identity-epoch-one";
  const owner = createNativePageOwner(
    {
      pageSessionScope: () => scope,
      status: () => ({ authenticated: true }),
      setSurface: (_id, input) => (surface = { ...input }),
      clearSurface: (_id, menu) => {
        if (surface?.menu === menu) surface = undefined;
      },
      updateVisibleWorkbenchContext: (_id, value) => {
        context = value;
      },
      clearVisibleWorkbenchContext: (id) => {
        context = undefined;
        bridge.reset(id);
      },
      pullPageBridgeEvents: (id, messages) => ({
        events: bridge.pull(id, messages),
      }),
    },
    registry,
  );
  const first = owner.open(agent.id, { menu: "gea-proof", title: "Approval" });
  owner.context(agent.id, first.lease, { sequence: 1 });
  owner.poll(agent.id, first.lease, catalog("customer"), []);
  const pending = execute({
    kind: "invoke",
    target: "filters",
    action: "reset",
    reason: "Reset visible filters",
  });
  let events;
  for (let i = 0; i < 100; i++) {
    events = owner.poll(agent.id, first.lease, undefined, []).events;
    if (events.length) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const call = events.find((event) => event.type === "TOOL_CALL_START");
  assert.ok(call);
  owner.context(agent.id, first.lease, null);
  assert.equal((await pending).error.message, "PAGE_TOOL_OWNER_RELEASED");
  assert.equal(ctx.tools.get("gea_workbench_apply", agent), undefined);
  assert.equal(surface, undefined);
  assert.equal(context, undefined);
  assert.throws(
    () =>
      owner.poll(agent.id, first.lease, catalog("all"), [
        {
          id: "late",
          role: "tool",
          toolCallId: call.toolCallId,
          content: '{"applied":true}',
        },
      ]),
    /NATIVE_PAGE_OWNER_RELEASED/,
  );
  assert.equal(bridge.take(agent.id, call.toolCallId), undefined);
  const second = owner.open(agent.id, { menu: "gea-proof", title: "Approval" });
  assert.notEqual(second.lease, first.lease);
  owner.poll(agent.id, second.lease, catalog("all"), []);
  owner.context(agent.id, first.lease, null);
  assert.equal(surface.menu, "gea-proof");
  assert.ok(ctx.tools.get("gea_workbench_apply", agent));
  assert.throws(
    () => owner.poll(agent.id, first.lease, catalog("customer"), []),
    /NATIVE_PAGE_OWNER_RELEASED/,
  );
  scope = "identity-epoch-two";
  assert.throws(
    () => owner.poll(agent.id, second.lease, catalog("all"), []),
    /NATIVE_PAGE_OWNER_RELEASED/,
  );
  owner.disposeAll();
  assert.equal(ctx.tools.get("gea_workbench_apply", agent), undefined);
  assert.equal(surface, undefined);
});

test("a changed page surface releases the previous pending owner", async (t) => {
  const { ctx, agent, bridge, registry, catalog, execute } = await mount(t);
  await ctx.agents.register(agent);
  registry.declare(agent.id, catalog("customer"));
  const pending = execute({
    kind: "invoke",
    target: "filters",
    action: "reset",
    reason: "Reset filters",
  });
  for (let i = 0; i < 100; i++) {
    if (bridge.pull(agent.id, []).length) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  registry.declare(agent.id, { ...catalog("all"), surface: "another-view" });
  assert.equal((await pending).error.message, "PAGE_TOOL_OWNER_RELEASED");
  assert.deepEqual(bridge.pull(agent.id, []), []);
});
