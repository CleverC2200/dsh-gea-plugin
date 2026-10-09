import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
const result = await build({
  entryPoints: ["src/host/business.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const module = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { Business } = module.exports;
const limits = {
  maxRequests: 24,
  periods: 8,
  list: 12,
  detail: 2,
  versionSkus: 2,
  workflowSql: 2,
  maxWorkflowRows: 200,
  metadata: 8,
};
const signal = () => new AbortController().signal;
function fixture(
  t,
  overrides = {},
  respond = () => ({ records: [], total: 0, current: 1, size: 200, pages: 0 }),
) {
  const prior = globalThis.fetch,
    requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: new URL(input instanceof Request ? input.url : String(input)), init });
    return Response.json({ success: true, code: 200, result: respond(requests.at(-1)) });
  };
  t.after(() => {
    globalThis.fetch = prior;
  });
  const business = new Business({
    geaBaseUrl: "https://gea.fixture/root",
    analysisAgentCode: "sales_forecast",
    workbenchCapability: { enabled: true, readonlyValidation: { ...limits, ...overrides } },
    pageSize: 50,
    periodPageSize: 100,
    requestTimeoutMs: 1000,
    inputByteBudget: 32000,
    runtimeDir: "/unused/read-only-fixture",
  });
  business.auth = { token: "fixture", tenantId: "0", id: "fixture" };
  return { business, requests };
}
const deniedPrefix = /^GEA_SALES_READONLY_/;
const denied = (error) => deniedPrefix.test(error.code ?? "");

test("validation refuses extra query kinds, other Consumers, local drafts, model reads and prepare before any transport", async (t) => {
  const { business, requests } = fixture(t);
  for (const kind of ["versions", "logs", "compare", "aggregate"])
    await assert.rejects(
      business.workbenchQuery(
        { kind, query: { planId: "fixture", fromVersionId: "a", toVersionId: "b" } },
        signal(),
      ),
      denied,
    );
  for (const method of [
    "salesPlanDraft",
    "salesPlanSubmit",
    "salesPlanAction",
    "agentQuery",
    "prepareWorkbench",
  ])
    await assert.rejects(business[method]({}, signal()), denied);
  await assert.rejects(business.modelRoute(signal()), denied);
  await assert.rejects(
    business.openMcpConnection({ consumerType: "AGENT", consumerCode: "sales_forecast" }, signal()),
    denied,
  );
  assert.throws(() => business.assertExecutionAllowed("another-consumer"), denied);
  assert.equal(requests.length, 0);
});

test("period scan consumes each physical page and refuses an incomplete collection at its cap", async (t) => {
  const { business, requests } = fixture(t, { periods: 2 }, ({ url }) => ({
    records: [
      {
        planId: "p" + url.searchParams.get("pageNo"),
        periodId: "20261001",
        planTypeCode: "Y",
        orderType: "M",
      },
    ],
    total: 3,
    current: Number(url.searchParams.get("pageNo")),
    size: 1,
    pages: 3,
  }));
  await assert.rejects(
    business.workbenchQuery({ kind: "periods", query: { pageNo: 1, pageSize: 100 } }, signal()),
    denied,
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((x) => x.url.searchParams.get("pageNo")),
    ["1", "2"],
  );
});

test("shared list budget includes repeated automatic views and survives identity resets/config edits", async (t) => {
  const { business, requests } = fixture(t, { list: 2 });
  const query = {
    kind: "list",
    query: { orderType: "M", periodId: "20261001", pageNo: 1, pageSize: 200 },
  };
  await business.workbenchQuery(query, signal());
  await business.workbenchQuery(query, signal());
  business.logout({});
  business.auth = { token: "fixture2", tenantId: "0", id: "fixture2" };
  business.config.workbenchCapability.readonlyValidation.list = 100;
  await assert.rejects(business.workbenchQuery(query, signal()), denied);
  assert.equal(requests.length, 2);
});

test("REST total is shared across allowed kinds and public counts contain only physical attempts", async (t) => {
  const { business, requests } = fixture(t, { maxRequests: 1 });
  await business.workbenchQuery({ kind: "list", query: { pageNo: 1, pageSize: 200 } }, signal());
  await assert.rejects(business.workbenchQuery({ kind: "periods", query: {} }, signal()), denied);
  assert.equal(requests.length, 1);
  assert.equal(business.status().readonlyValidation.spent.maxRequests, 1);
  assert.equal(business.status().readonlyValidation.spent.periods, 0);
});

test("fixed workflow SQL counts pages and stops before page2 instead of returning a partial config", async (t) => {
  const { business, requests } = fixture(t, { workflowSql: 1 }, ({ url, init }) => {
    if (url.pathname.endsWith("/agent/session"))
      return { accessDecision: { allowed: true }, delegationToken: "fixture-delegation" };
    const body = JSON.parse(init.body);
    return {
      requestId: init.headers["X-Request-Id"],
      operation: "SELECT",
      tables: ["agents_scm_plan_workflow_config"],
      total: 101,
      pageNo: body.pageNo,
      pageSize: 100,
      rows: Array.from({ length: 100 }, (_, i) => ({
        id: String(i + 1),
        type_code: "Y",
        examine_level: 0,
        node_num: "0",
      })),
    };
  });
  await assert.rejects(business.workflowConfig({}, signal()), denied);
  assert.equal(requests.filter((x) => x.url.pathname.endsWith("/sql/execute")).length, 1);
  assert.equal(requests.length, 2);
});

test("zero workflow or REST cap refuses before authorization metadata or transport", async (t) => {
  const { business, requests } = fixture(t, { workflowSql: 0, periods: 0 });
  await assert.rejects(business.workflowConfig({}, signal()), denied);
  await assert.rejects(business.workbenchQuery({ kind: "periods", query: {} }, signal()), denied);
  assert.equal(requests.length, 0);
});

test("central logged transport blocks raw models, arbitrary SQL, extra endpoints and mismatched Consumer", async (t) => {
  const { business, requests } = fixture(t);
  for (const [path, init] of [
    ["/v1/chat/completions", { method: "POST", body: "{}" }],
    ["/sales-plan/plans/p/logs", { method: "GET" }],
    ["/sales-plan/plans", { method: "GET" }],
    [
      "/ai/gateway/sql/execute",
      { method: "POST", body: JSON.stringify({ sql: "SELECT * FROM secret", parameters: {} }) },
    ],
    [
      "/ai/gateway/agent/session",
      { method: "POST", body: JSON.stringify({ agentCode: "another-consumer" }) },
    ],
  ])
    await assert.rejects(business.fetchExternal("https://gea.fixture/root" + path, init), denied);
  assert.equal(requests.length, 0);
});

test("authorization metadata has its own fixed Host cap", async (t) => {
  const { business, requests } = fixture(t, { metadata: 1 });
  await business.fetchExternal("https://gea.fixture/root/sys/user/getUserInfo");
  await assert.rejects(
    business.fetchExternal("https://gea.fixture/root/sys/permission/getPermCode"),
    denied,
  );
  assert.equal(requests.length, 1);
});

test("concurrent failed HTTP attempts are charged once and cannot overrun the shared cap", async (t) => {
  const { business, requests } = fixture(t, { list: 2, maxRequests: 2 }, () => {
    throw Error("offline");
  });
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => business.workbenchQuery({ kind: "list", query: {} }, signal())),
  );
  assert.equal(requests.length, 2);
  assert.equal(results.filter((x) => x.status === "rejected" && denied(x.reason)).length, 3);
  assert.equal(business.status().readonlyValidation.spent.list, 2);
  assert.equal(business.status().readonlyValidation.spent.maxRequests, 2);
});

test("already-cancelled reads spend no physical allowance", async (t) => {
  const { business, requests } = fixture(t);
  await assert.rejects(business.workbenchQuery({ kind: "list", query: {} }, AbortSignal.abort()));
  assert.equal(requests.length, 0);
  assert.equal(business.status().readonlyValidation.spent.maxRequests, 0);
});

test("cancellation while admission resumes cannot charge before physical fetch", async (t) => {
  const { business, requests } = fixture(t);
  const controller = new AbortController();
  const pending = business.fetchExternal("https://gea.fixture/root/sys/user/getUserInfo", {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending);
  assert.equal(requests.length, 0);
  assert.equal(business.status().readonlyValidation.spent.metadata, 0);
});

test("Request-shaped SQL uses the same fixed query and row cap; metadata permits only the current Consumer", async (t) => {
  const { business, requests } = fixture(t);
  const { WORKFLOW_CONFIG_SQL } = await import("../src/shared/workflow-query.js");
  const body = {
    sql: WORKFLOW_CONFIG_SQL,
    parameters: { active: 1, notDeleted: 1 },
    includeTotal: true,
    pageSize: 100,
    pageNo: 2,
  };
  await business.fetchExternal(
    new Request("https://gea.fixture/root/ai/gateway/sql/execute", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  await assert.rejects(
    business.fetchExternal(
      new Request("https://gea.fixture/root/ai/gateway/sql/execute", {
        method: "POST",
        body: JSON.stringify({ ...body, pageNo: 3 }),
      }),
    ),
    denied,
  );
  await business.fetchExternal("https://gea.fixture/root/ai/gateway/session", {
    method: "POST",
    body: JSON.stringify({ consumerType: "AGENT", consumerCode: "sales_forecast" }),
  });
  await assert.rejects(
    business.fetchExternal("https://other.fixture/root/sys/user/getUserInfo"),
    denied,
  );
  assert.equal(requests.length, 2);
  assert.equal(business.status().readonlyValidation.spent.workflowSql, 1);
  assert.equal(business.status().readonlyValidation.spent.metadata, 1);
});

test("public operation gate refuses local prepare, replay, mutations and model submission before payload work", (t) => {
  const { business, requests } = fixture(t);
  for (const operation of [
    "status",
    "workbench/query",
    "workflow/config",
    "approval/roles",
    "api-log/snapshot",
  ])
    business.assertOperation(operation);
  for (const operation of [
    "prepare",
    "submit",
    "api-log/replay",
    "api-log/clear",
    "model/advice",
    "model/discover",
    "workbench/prepare",
    "workbench/draft",
    "workbench/action",
    "workbench/submit",
    "html/sql",
    "logout",
    "environment/select",
  ])
    assert.throws(() => business.assertOperation(operation), denied);
  assert.throws(() => business.prepare({}), denied);
  assert.equal(requests.length, 0);
});
