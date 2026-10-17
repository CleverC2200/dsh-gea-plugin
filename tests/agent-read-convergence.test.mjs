import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
const out = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts'; export {registerGeaTools} from './src/host/agent-tools.ts'",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const m = { exports: {} };
new Function("require", "module", "exports", out.outputFiles[0].text)(
  createRequire(import.meta.url),
  m,
  m.exports,
);
const { Business, registerGeaTools } = m.exports;
function fixture(t) {
  const business = new Business({
    geaBaseUrl: "https://gea.example.test",
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 1000,
  });
  const tools = new Map();
  const agents = new Map();
  const agentFor = (scope) => {
    if (!agents.has(scope)) agents.set(scope, { id: scope, session: { preset: "gea-readonly" } });
    return agents.get(scope);
  };
  const ctx = {
    agents: { get: agentFor },
    sessionProjections: { stateOf: (session) => session.preset },
    effect: (f) => f(),
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool);
        return () => {};
      },
    },
  };
  registerGeaTools(ctx, business);
  t.after(() => business.dispose());
  const execute = (name, args, scope = "one") =>
    tools.get(name).execute(args, { agent: agentFor(scope), signal: new AbortController().signal });
  return { business, tools, execute };
}
const aggregateReceipt = () =>
  JSON.stringify({
    source: "GEA_LIVE_READONLY",
    environment: "production",
    fetchedAt: "2026-09-24T00:46:28Z",
    coverage: "complete",
    query: { kind: "aggregate", query: { periodId: "20261001" } },
    value: {
      planCount: 28,
      skuRowCount: 1143,
      distinctSkuCount: 331,
      basis: { geography: "baseName 是基地，不等同组织大区" },
      totals: [{ orderType: "M", planTypeCode: "Y", amt: "21453004.9", qty: "283546" }],
      bases: [{ baseName: "华东", amt: "2494990.05" }],
      groups: [{ baseName: "华东", productCategName: "饺子", amt: "920666.41" }],
    },
  });

test("success evidence survives a whole-turn stop but is cleared on a new question or identity change", async (t) => {
  const f = fixture(t);
  f.business.rememberTurnReplay("one", "plan|aggregate", aggregateReceipt());
  f.business.stopTurn("one", "网关会话已失效", "session-expired");
  const stopped = JSON.parse(
    await f.execute("gea_sales_plan_read", { kind: "list", query: { periodId: "20261001" } }),
  );
  assert.match(JSON.stringify(stopped.availableEvidence), /21453004\.9/);
  assert.equal(f.business.successfulPlanEvidence("two").length, 0);
  f.business.clearTurnReplays("one");
  assert.equal(f.business.successfulPlanEvidence("one").length, 0);
  f.business.rememberTurnReplay("one", "plan|test", aggregateReceipt());
  f.business.logout({});
  assert.equal(f.business.successfulPlanEvidence("one").length, 0);
});

// Current MCP execution and server-shaped requests are verified by current-mcp-tools.test.mjs.
