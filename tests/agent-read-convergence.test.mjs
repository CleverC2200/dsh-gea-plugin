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
test("actual tool stops distinct detail reads at 20 but leaves aggregation and other sessions usable", async (t) => {
  const f = fixture(t);
  let reads = 0;
  t.mock.method(f.business, "agentQuery", async () => {
    reads++;
    return "{}";
  });
  for (let n = 0; n < 20; n++)
    await f.execute("gea_sales_plan_read", { kind: "detail", query: { planId: String(n) } });
  const limited = JSON.parse(
    await f.execute("gea_sales_plan_read", { kind: "detail", query: { planId: "21" } }),
  );
  assert.equal(limited.code, "GEA_PLAN_READ_LIMIT");
  assert.equal(reads, 20);
  await f.execute("gea_sales_plan_read", { kind: "aggregate", query: { periodId: "p" } });
  assert.equal(reads, 21);
  await f.execute("gea_sales_plan_read", { kind: "detail", query: { planId: "21" } }, "two");
  assert.equal(reads, 22);
  f.business.clearTurnReplays("one");
  f.business.repeatReads().clear("one");
  await f.execute("gea_sales_plan_read", { kind: "detail", query: { planId: "21" } });
  assert.equal(reads, 23);
});
test("aggregate argument order does not trigger a new scan and a replay keeps the summary table intact", async (t) => {
  const f = fixture(t);
  let reads = 0;
  const result = JSON.stringify({
    query: { kind: "aggregate" },
    coverage: "complete",
    value: { basis: "x".repeat(9000), groups: [{ amt: "EXACT_TABLE_AT_END" }] },
  });
  t.mock.method(f.business, "agentQuery", async () => {
    reads++;
    return result;
  });
  await f.execute("gea_sales_plan_read", {
    kind: "aggregate",
    query: { periodId: "p", orderType: "M" },
  });
  for (let i = 0; i < 5; i++)
    assert.match(
      await f.execute("gea_sales_plan_read", {
        query: { orderType: "M", periodId: "p" },
        kind: "aggregate",
      }),
      /EXACT_TABLE_AT_END/,
    );
  assert.equal(reads, 1);
});
test("resetting one conversation preserves another conversation guard and replay", (t) => {
  const f = fixture(t);
  for (let n = 0; n < 20; n++) f.business.allowPlanRead("two", false);
  f.business.rememberTurnReplay("two", "key", "two-private");
  f.business.stopTurn("two", "reason");
  f.business.clearTurnReplays("one");
  f.business.clearTurnStops("one");
  assert.equal(f.business.allowPlanRead("two", false), false);
  assert.equal(f.business.turnReplay("two", "key"), "two-private");
  assert.equal(f.business.turnStopped("two"), "reason");
  f.business.clearTurnReplays();
  assert.equal(f.business.turnReplay("two", "key"), undefined);
});

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
  t.mock.method(f.business, "agentQuery", async () => aggregateReceipt());
  await f.execute("gea_sales_plan_read", { kind: "aggregate", query: { periodId: "20261001" } });
  f.business.stopTurn("one", "预算耗尽");
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
