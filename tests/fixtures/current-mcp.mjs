/** Run current Manage registrations and GEA execution against a caller-owned HTTP fixture. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { Context } from "@deepseek-ai/cordis";

const built = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts';export {mountBusinessPrompts} from './src/host/prompt-runtime.ts';export {createGatewayMcpService} from './src/host/gateway-mcp-service.ts';export {mountGeaMcp} from '../dsh-agent-manage/src/runtime/gea-mcp.ts';export {createCapabilityRegistry} from './src/capability/registry.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
  plugins: [
    {
      name: "manage-external-dependencies",
      setup(build) {
        build.onResolve({ filter: /^zod$/ }, () => ({
          path: createRequire(resolve("../dsh-agent-manage/package.json")).resolve("zod"),
        }));
      },
    },
  ],
});
const module = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const {
  Business,
  mountBusinessPrompts,
  createGatewayMcpService,
  mountGeaMcp,
  createCapabilityRegistry,
} = module.exports;
const official = (part) =>
  import(
    pathToFileURL(resolve("../../official-latest-standard/packages/core", part, "lib/index.js"))
  );
const { default: SystemPrompt } = await official("system-prompt");
const { default: Tools } = await official("tools");
const { createScope } = await official("scope");

export const inspectTool = "mcp__gea-gateway__inspect_cube_model";
export const queryTool = "mcp__gea-gateway__query_business_data";
export const cubeCode = "2109581866385289217";
export const query = {
  action: "query",
  response_mode: "inline_complete",
  queries: [
    {
      name: "inventory",
      query: {
        measures: ["inventory.qty"],
        order: { "inventory.qty": "desc" },
        limit: 1,
        offset: 0,
        total: true,
      },
    },
  ],
};
export const rawResult =
  '{"action":"query","status":"completed","executedQueryCount":1,"datasets":[{"name":"inventory","rowCount":1,"dataStatus":"partial","totalRowCount":2,"offset":0,"hasMorePages":true,"fields":[{"name":"inventory.qty","type":"number"}],"rows":[{"inventory.qty":9007199254740993.1234,"inventory.code":"001","inventory.unknown":null,"inventory.zero":0}]}]}';
export const serverSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["query"] },
    response_mode: { type: "string" },
    queries: { type: "array", items: { type: "object" } },
  },
  required: ["action", "queries"],
  additionalProperties: false,
};

export async function currentMcp(t, options = {}) {
  const calls = [],
    warnings = [];
  let handler = options.handler;
  const ctx = new Context();
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) =>
      warnings.push(
        message.args
          .map((value) => (value instanceof Error ? value.stack : String(value)))
          .join(" "),
      ),
  });
  const system = ctx.plugin(SystemPrompt, {});
  await system;
  const tools = ctx.plugin(Tools, { mode: "native" });
  await tools;
  const runtime = options.prompts ? await mkdtemp(join(tmpdir(), "knowledge-runtime-")) : undefined;
  const business = new Business({
    ...(runtime ? { runtimeDir: runtime } : {}),
    geaBaseUrl: "https://mcp.fixture.invalid",
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 1000,
    mcpRequestTimeoutMs: options.timeoutMs ?? 1000,
    cubeMcpCodes: options.cubeMcpCodes ?? { production: cubeCode },
  });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://mcp.fixture.invalid",
    auth: {
      token: "fixture-private-login",
      tenantId: "0",
      id: "fixture-user",
      name: "Fixture",
      username: "fixture",
    },
  });
  if (options.dealer)
    business.setCapabilities(
      createCapabilityRegistry([
        {
          id: "gea-workbench",
          label: "Sales",
          maxEffect: "view",
          skills: [],
          routing: { keywords: [], summary: "Sales" },
        },
        {
          id: "dealer",
          label: "Dealer",
          maxEffect: "view",
          skills: [],
          routing: { keywords: [], summary: "Dealer" },
          data: {
            consumerCode: "dealer-inventory-replenishment",
            tables: [],
            rules: [],
          },
        },
      ]),
    );
  const agents = new Map();
  const scopes = [];
  for (const [id, preset] of [
    ["sales", "gea-readonly"],
    ["ordinary", "standard"],
    ...(options.dealer ? [["dealer", "gea-html-inventory-dealer"]] : []),
    ...(options.personal ? [["personal", "personal-knowledge"]] : []),
  ]) {
    const agent = {
      id,
      preset,
      session: {
        header: { cwd: process.cwd() },
        snapshotEvents: () => [],
        deriveMessages: () => [],
      },
    };
    await ctx.plugin(
      Object.assign(
        (host) => {
          const scope = createScope(host, agent);
          agent.ctx = scope.ctx;
          scopes.push(scope);
        },
        { inject: ["tools", "systemPrompt"] },
      ),
    );
    agents.set(id, agent);
  }
  ctx.provide("agents", {
    get: (id) => agents.get(id),
    list: () => [...agents.values()],
  });
  ctx.provide("agentPresets", { composedPreset: () => undefined });
  ctx.provide("sessionProjections", {
    stateOf: (session) => [...agents.values()].find((agent) => agent.session === session)?.preset,
  });
  let enabled = true;
  const sourceSignal = new AbortController().signal;
  ctx.provide("agentResources", {
    cubeSource: (id) =>
      enabled &&
      ["gea-readonly", ...(options.dealer ? ["gea-html-inventory-dealer"] : [])].includes(id)
        ? {
            consumerCode:
              id === "gea-readonly" ? "sales_forecast" : "dealer-inventory-replenishment",
            signal: sourceSignal,
          }
        : undefined,
    list: async () =>
      ["gea-readonly", ...(options.dealer ? ["gea-html-inventory-dealer"] : [])].map((id) => ({
        id,
        kind: "prompt",
        installed: true,
        enabled,
        cube: true,
      })),
  });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(
      String(url).startsWith("https://mcp.fixture.invalid/"),
      "fixture must not reach another endpoint",
    );
    init.signal.throwIfAborted();
    const wire = JSON.parse(init.body);
    calls.push({ url: String(url), wire, headers: new Headers(init.headers) });
    if (String(url).endsWith("/session"))
      return Response.json({
        success: true,
        result: {
          accessDecision: { allowed: true },
          gatewayContext: {
            consumerType: "AGENT",
            consumerCode: wire.consumerCode,
            sessionId: "fixture-business-session",
            conversationId: "fixture-conversation",
          },
          delegationToken: "fixture-private-delegation",
        },
      });
    assert.ok(String(url).endsWith("/mcp"), "direct queries never discover resource catalogs");
    const reply = (result, headers) =>
      Response.json({ jsonrpc: "2.0", id: wire.id, result }, { headers });
    if (wire.method === "initialize") {
      if (options.initializeStatus) return new Response(null, { status: options.initializeStatus });
      return reply(
        {
          protocolVersion: options.protocolVersion ?? "2025-11-25",
        },
        options.transportSession ? { "MCP-Session-Id": options.transportSession } : undefined,
      );
    }
    if (wire.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (wire.method === "tools/list")
      return reply({
        tools: [
          ...(options.extraTools ?? []),
          {
            name: "inspect_cube_model",
            description: "Server inspect",
            inputSchema: {
              type: "object",
              properties: { keyword: { type: "string" } },
              additionalProperties: false,
            },
            _meta: { sourceType: "MCP", sourceCode: cubeCode },
          },
          {
            name: "query_business_data",
            description: "Server query",
            inputSchema: options.schema ?? serverSchema,
            _meta: { sourceType: "MCP", sourceCode: cubeCode },
          },
        ],
      });
    const custom = await handler?.(wire, init, reply);
    if (custom !== undefined) return custom;
    if (wire.method === "tools/call" && wire.params.name === "inspect_cube_model")
      return reply({
        structuredContent: {
          semanticModel: [{ name: "inventory", measures: [{ name: "inventory.qty" }] }],
        },
      });
    if (wire.method === "tools/call")
      return new Response(
        '{"jsonrpc":"2.0","id":' +
          JSON.stringify(wire.id) +
          ',"result":{"structuredContent":' +
          rawResult +
          "}}",
        { headers: { "content-type": "application/json" } },
      );
    throw Error("UNEXPECTED_FIXTURE_REQUEST: " + wire.method);
  });
  if (options.personal)
    ctx.provide("userAgents", {
      cubeFor: (agent) =>
        agent.id === "personal"
          ? { sourceRef: "gea-readonly", signal: business.identitySignal(), generation: 1 }
          : undefined,
      watch: () => () => {},
    });
  const stopPrompts = options.prompts
    ? mountBusinessPrompts(ctx, business, { readModules: () => [] })
    : undefined;
  ctx.provide("geaMcp", createGatewayMcpService(ctx, business));
  const mount = ctx.plugin(mountGeaMcp);
  await mount;
  const deadline = Date.now() + 1000;
  while (
    !(options.discoveryFailure
      ? warnings.some((warning) => warning.includes("discovery failed"))
      : ctx.tools.get(options.readyTool ?? queryTool)) &&
    Date.now() < deadline
  )
    await new Promise((done) => setTimeout(done, 5));
  if (!options.discoveryFailure)
    assert.ok(
      ctx.tools.get(options.readyTool ?? queryTool),
      "Manage must register the current server tool " +
        JSON.stringify({
          warnings,
          calls,
          names: ctx.tools.schemas().map((x) => x.name),
        }),
    );
  t.after(async () => {
    await mount.dispose();
    stopPrompts?.();
    business.dispose();
    for (const scope of scopes) await scope.dispose();
    await tools.dispose();
    await system.dispose();
    if (runtime) await rm(runtime, { recursive: true, force: true });
  });
  return {
    ctx,
    business,
    calls,
    agents,
    warnings,
    setHandler: (next) => {
      handler = next;
    },
    setEnabled: (value) => {
      enabled = value;
    },
    execute: (
      name = queryTool,
      args = query,
      id = "sales",
      signal = new AbortController().signal,
    ) =>
      ctx.tools.execute({
        callId: randomUUID(),
        name,
        arguments: args,
        agent: agents.get(id),
        signal,
      }),
  };
}
