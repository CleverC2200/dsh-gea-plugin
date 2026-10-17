import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const built = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts'; export {registerGeaTools} from './src/host/agent-tools.ts'; export {createCapabilityRegistry} from './src/capability/registry.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  packages: "external",
  write: false,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const module = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { Business, registerGeaTools, createCapabilityRegistry } = module.exports;

function fixture(t) {
  const business = new Business({
    geaBaseUrl: "https://localhost",
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 1000,
    agentSqlRead: true,
  });
  t.after(() => business.dispose());
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("OFFLINE_FIXTURE_FORBIDS_NETWORK");
  });
  const registered = new Map();
  const ctx = {
    agents: { get: () => ({ session: {} }) },
    sessionProjections: { stateOf: () => "gea-readonly" },
    effect: (fn) => {
      const off = fn();
      if (typeof off === "function") t.after(off);
    },
    tools: {
      register: (tool) => {
        registered.set(tool.name, tool);
        return () => registered.delete(tool.name);
      },
    },
  };
  registerGeaTools(ctx, business, createCapabilityRegistry([]));
  const execute = (name, args = {}, scope = "s1", signal = new AbortController().signal) =>
    registered.get(name).execute(args, { agent: { id: scope, session: {} }, signal });
  return { business, execute };
}
// Retired catalog/listing specifications are preserved under fixtures/retired-query/specifications.
// Current authorization, schema refresh and cancellation run through Core tools.execute in current-mcp-tools.test.mjs.
test("registered native read non-Error failures remain readable", async (t) => {
  const f = fixture(t);
  t.mock.method(f.business, "agentQuery", async () => {
    throw { message: "fixture read failed" };
  });
  await assert.rejects(
    f.execute("gea_sales_plan_read", { kind: "periods" }),
    (error) => error instanceof Error && !error.message.includes("[object Object]"),
  );
});

test("registered recipe executes parameterized SQL with only accepted query keys", async (t) => {
  const f = fixture(t);
  let input;
  t.mock.method(f.business, "pluginSql", async (payload) => {
    input = payload;
    return { rows: [{ shortage: 3 }] };
  });
  const result = await f.execute("gea_plugin_read", {
    consumerCode: "branch-inventory",
    recipe: "shortage-by-base-and-group",
    parameters: { base: "%郑州%", group: "%水饺%" },
  });
  assert.equal(JSON.parse(result).rows[0].shortage, 3);
  assert.deepEqual(Object.keys(input).sort(), ["consumerCode", "pageSize", "parameters", "sql"]);
  assert.equal(input.pageSize, 50);
  assert.deepEqual(input.parameters, { base: "%郑州%", group: "%水饺%" });
  assert.match(input.sql, /:base/);
  assert.match(input.sql, /:group/);
});
