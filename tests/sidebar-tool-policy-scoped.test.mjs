import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
const sdk = resolve("../../official-latest-standard/packages/core");
const { default: SystemPrompt } = await import(pathToFileURL(sdk + "/system-prompt/lib/index.js"));
const { default: ToolRuntime } = await import(pathToFileURL(sdk + "/tools/lib/index.js"));
const { createScope } = await import(pathToFileURL(sdk + "/scope/lib/index.js"));
const { agentEvents } = await import(pathToFileURL(sdk + "/agent/lib/index.js"));
const { outputFiles } = await build({
  stdin: {
    contents: `export{mountBusinessPrompts}from'./src/host/prompt-runtime.ts';export{mountSidebarToolVisibility}from'./src/host/sidebar-tool-visibility.ts';export{AgentOpenRegistry,registerOpenTool}from'./node_modules/dsh-better-sidebar/src/agent-opens.ts';export{SIDEBAR_PREFS_DEFAULTS}from'./node_modules/dsh-better-sidebar/src/prefs-shared.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  packages: "external",
});
await mkdir(".scratch", { recursive: true });
const modulePath = resolve(".scratch/sidebar-policy-scoped.mjs");
await writeFile(modulePath, outputFiles[0].text);
const m = await import(pathToFileURL(modulePath));
const tool = (name) => ({
  name,
  description: "offline registration " + name,
  parameters: { type: "object", properties: {} },
  output: {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }],
  },
  execute: async () => {
    throw Error("No tool execution/model/UI is permitted in this offline visibility test");
  },
});

test("official Agent-scoped Tools view admits the actual BSP registered UI tool without bypassing its registration gate or scope intersection", async (t) => {
  const external = [];
  const identity = new AbortController().signal;
  t.mock.method(globalThis, "fetch", async (input) => {
    external.push(String(input));
    assert.fail("offline scoped tool policy must not reach external wire");
  });
  const ctx = new Context();
  const system = ctx.plugin(SystemPrompt, {});
  await system;
  const tools = ctx.plugin(ToolRuntime, { mode: "native" });
  await tools;
  const directory = resolve(".scratch/sidebar-policy-evidence");
  await mkdir(directory, { recursive: true });
  const agent = {
    id: "session-sidebar-policy-fixture",
    session: { header: { cwd: directory }, snapshotEvents: () => [] },
  };
  let scope;
  await ctx.plugin(
    Object.assign(
      (inner) => {
        scope = createScope(inner, agent);
        agent.ctx = scope.ctx;
      },
      { inject: ["tools", "systemPrompt"] },
    ),
  );
  // This is the official scoped-test Agent subject over real Cordis/Tools, not a live Host Agent loop.
  ctx.provide("agents", {
    list: () => [agent],
    get: (id) => (id === agent.id ? agent : undefined),
  });
  ctx.provide("sessionProjections", { stateOf: () => "gea-readonly" });
  for (const name of [
    "mcp__gea-gateway__query_business_data",
    "mcp__browser__browser_click",
    "terminal_create",
    "gea_sales_plan_write",
  ])
    ctx.tools.register(tool(name));
  const business = {
    config: { runtimeDir: directory, analysisAgentCode: "sales_forecast" },
    status: () => ({ authenticated: true, user: { id: "offline" } }),
    identitySignal: () => identity,
    watchIdentity: () => () => {},
    assertExecutionAllowed: () => {},
    readTurnRevision: () => 1,
    surfaceFor: () => undefined,
  };
  ctx.provide("agentResources", {
    cubeSource: (id) =>
      id === "gea-readonly"
        ? { sourceRef: id, consumerCode: "sales_forecast", signal: identity }
        : undefined,
    list: async () => [{ id: "gea-readonly", kind: "prompt", installed: true, enabled: true }],
  });
  let authenticated = true;
  let visibilityRoute;
  ctx.provide("connection", {
    fetch: {
      register: (route) => {
        visibilityRoute = route;
        return () => {
          visibilityRoute = undefined;
        };
      },
    },
  });
  const offVisibility = m.mountSidebarToolVisibility(ctx, {
    status: () => ({ authenticated }),
  });
  const visibility = async (id = agent.id) => {
    const response = await visibilityRoute.fetch(
      new Request(
        "http://localhost/api/gea-proof/sidebar-tool-visibility?sessionId=" +
          encodeURIComponent(id),
      ),
    );
    return { status: response.status, value: await response.json() };
  };
  assert.deepEqual((await visibility()).value, {
    tool: "sidebar_open",
    registered: false,
    visible: false,
  });
  authenticated = false;
  assert.equal((await visibility()).status, 401);
  authenticated = true;
  assert.equal((await visibility("invalid")).status, 400);
  assert.equal((await visibility("session-unknown")).status, 404);
  const offBusiness = m.mountBusinessPrompts(ctx, business, { readModules: () => [] }, new Map());
  const registry = new m.AgentOpenRegistry();
  let prefs = { ...m.SIDEBAR_PREFS_DEFAULTS };
  let offSidebar;
  const preStep = () =>
    agentEvents(ctx, agent).waterfall("agent/pre-step", { messages: [] }, async () => ({
      kind: "enter",
      messages: [],
    }));
  const names = () => ctx.tools.schemas(agent).map((tool) => tool.name);
  t.after(async () => {
    offSidebar?.();
    offVisibility();
    offBusiness();
    registry.dispose();
    await scope.dispose();
    await tools.dispose();
    await system.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await preStep();
  assert.equal(prefs.agentOpenTools, false);
  assert.equal(
    ctx.tools.schemas().some((tool) => tool.name === "sidebar_open"),
    false,
  );
  assert.equal(
    names().includes("sidebar_open"),
    false,
    "GEA must not manufacture an unregistered tool",
  );
  prefs = { ...prefs, agentOpenTools: true };
  if (prefs.agentOpenTools)
    offSidebar = m.registerOpenTool(
      ctx,
      registry,
      async () => directory,
      () => prefs,
    );
  await preStep();
  assert.ok(
    ctx.tools.schemas().some((tool) => tool.name === "sidebar_open"),
    "original BSP has registered its tool",
  );
  assert.ok(
    names().includes("sidebar_open"),
    "business Agent scoped view must include the registered UI-only tool",
  );
  assert.deepEqual((await visibility()).value, {
    tool: "sidebar_open",
    registered: true,
    visible: true,
  });
  assert.ok(names().includes("mcp__gea-gateway__query_business_data"));
  for (const permitted of ["mcp__browser__browser_click", "terminal_create"])
    assert.equal(names().includes(permitted), true, permitted + " follows its owner registration");
  for (const denied of ["gea_sales_plan_write", "run_code"])
    assert.equal(names().includes(denied), false, denied + " must stay absent");
  const intersect = agent.ctx.tools.restrict({ deny: ["sidebar_open"] });
  assert.equal(
    names().includes("sidebar_open"),
    false,
    "another actual scope restriction still intersects the GEA allow",
  );
  assert.deepEqual((await visibility()).value, {
    tool: "sidebar_open",
    registered: true,
    visible: false,
  });
  intersect();
  assert.ok(names().includes("sidebar_open"));
  offSidebar();
  offSidebar = undefined;
  prefs = { ...prefs, agentOpenTools: false };
  await preStep();
  assert.equal(
    names().includes("sidebar_open"),
    false,
    "disabled registration leaves no manufactured schema",
  );
  assert.deepEqual(external, []);
});
