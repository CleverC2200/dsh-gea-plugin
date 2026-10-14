/** Real rc.2 Tools/hooks, GEA Business and Manage calculator; only the local Skill body is supplied. */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";

const built = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts';export {mountBusinessPrompts} from './src/host/prompt-runtime.ts';export {createForecastTool} from '../dsh-agent-manage/src/runtime/forecast-compute.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const module = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { Business, mountBusinessPrompts, createForecastTool } = module.exports;
const official = (part) =>
  import(
    pathToFileURL(resolve("../../official-latest-standard/packages/core", part, "lib/index.js"))
  );
const { default: SystemPrompt } = await official("system-prompt");
const { default: Tools } = await official("tools");
const { createScope } = await official("scope");

const input = {
  schema_version: 1,
  data_mode: "provided",
  base_month: "2026-10",
  target_month: "2026-11",
  prior_base_month: "2025-10",
  prior_target_month: "2025-11",
  snapshot_at: "2026-10-14T00:00:00Z",
  period_mapping_confirmation: "confirmed",
  candidate_policy_confirmation: "provided row only",
  records: [
    {
      customer_id: "001",
      sku_id: "sku",
      unit: "件",
      source_ref: "user-row",
      eligible: true,
      product_kind: "regular",
      seasonal: false,
      quality_issues: [],
      base_plan_qty: "10",
      base_actual_to_cutoff_qty: "12",
      prior_base_actual_qty: "10",
      prior_target_actual_qty: "20",
      target_yoy_growth: "0.1",
      target_mom_growth: "0.2",
    },
  ],
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gea-owned-tools-"));
  const ctx = new Context();
  const system = ctx.plugin(SystemPrompt, {});
  await system;
  const tools = ctx.plugin(Tools, { mode: "native" });
  await tools;
  let events = [
    {
      type: "user/message",
      data: { source: { kind: "user" }, content: [{ type: "text", text: JSON.stringify(input) }] },
    },
  ];
  let baseline = {
    name: "sinian-demand-baseline",
    provider: "fixture",
    path: "/fixture/baseline",
    resourceBase: "/fixture",
    content: "fixed rule",
    invocation: { modelInvocable: true },
  };
  let enabled = true;
  const agent = {
    id: "session",
    session: { header: { cwd: root }, snapshotEvents: () => events, deriveMessages: () => [] },
  };
  let scope;
  await ctx.plugin(
    Object.assign(
      (host) => {
        scope = createScope(host, agent);
        agent.ctx = scope.ctx;
      },
      { inject: ["tools", "systemPrompt"] },
    ),
  );
  ctx.provide("agents", { get: () => agent });
  ctx.provide("sessionProjections", { stateOf: () => "gea-readonly" });
  ctx.provide("agentResources", {
    list: async () => [{ id: "gea-readonly", kind: "prompt", installed: true, enabled }],
  });
  ctx.provide("skills", { get: async () => baseline });
  const business = new Business({
    runtimeDir: root,
    analysisAgentCode: "sales_forecast",
    geaBaseUrl: "https://execution.fixture.invalid",
  });
  const unregister = ctx.tools.register(createForecastTool(ctx.skills));
  const unmount = mountBusinessPrompts(ctx, business, { readModules: () => [] });
  t.after(async () => {
    unmount();
    unregister();
    business.dispose();
    await scope.dispose();
    await tools.dispose();
    await system.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const execute = (name, args) =>
    ctx.tools.execute({
      callId: randomUUID(),
      name,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    });
  const text = (result) =>
    result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  const ids = async () =>
    (await readdir(join(root, "prompt-evidence")))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -5));
  return {
    execute,
    text,
    ids,
    turn: () => {
      // Host turn reset advances Business's public read revision before the Core event.
      business.clearTurnReplays(agent.id);
      return ctx.parallel("session/event", { id: agent.id }, { type: "turn/start" });
    },
    setEvents: (value) => {
      events = value;
    },
    changeBaseline: () => {
      baseline = { ...baseline, content: "changed rule" };
    },
    disableBaseline: () => {
      baseline = { ...baseline, invocation: { modelInvocable: false } };
    },
    disableResource: () => {
      enabled = false;
    },
  };
}

test("real Tools preserves user calculation evidence across turns and rejects changed rules, origin and resources", async (t) => {
  const f = await fixture(t);
  const calculated = await f.execute("forecast_compute", input);
  assert.equal(calculated.isError, false, f.text(calculated));
  assert.equal(JSON.parse(f.text(calculated)).rows[0].status, "calculated");
  const [evidenceId] = await f.ids();
  assert.ok(evidenceId);
  await f.turn();
  const read = await f.execute("gea_evidence_read", { evidenceId, format: "raw" });
  assert.equal(read.isError, false, f.text(read));
  assert.equal(JSON.parse(JSON.parse(f.text(read)).content).source.userInputVerified, true);
  f.setEvents([]);
  const noOrigin = await f.execute("gea_evidence_read", { evidenceId });
  assert.equal(noOrigin.isError, true);
  assert.match(f.text(noOrigin), /GEA_EVIDENCE_STALE/);
  f.changeBaseline();
  assert.match(
    f.text(await f.execute("gea_evidence_read", { evidenceId })),
    /GEA_CALCULATION_SOURCE_CHANGED/,
  );
  f.disableBaseline();
  assert.match(
    f.text(await f.execute("gea_evidence_read", { evidenceId })),
    /FORECAST_CAPABILITY_DISABLED/,
  );
  f.disableResource();
  assert.match(
    f.text(await f.execute("gea_evidence_read", { evidenceId })),
    /GEA_AGENT_RESOURCE_DISABLED/,
  );
});

test("real Tools keeps model supplied calculation evidence local to its turn", async (t) => {
  const f = await fixture(t);
  f.setEvents([]);
  const calculated = await f.execute("forecast_compute", input);
  assert.equal(calculated.isError, false, f.text(calculated));
  const [evidenceId] = await f.ids();
  await f.turn();
  const read = await f.execute("gea_evidence_read", { evidenceId });
  assert.equal(read.isError, true);
  assert.match(f.text(read), /GEA_EVIDENCE_STALE/);
});
