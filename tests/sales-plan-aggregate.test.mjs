import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const output = await build({
  entryPoints: ["src/host/business.ts"],
  bundle: true,
  packages: "external",
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
new Function("require", "module", "exports", output.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const plan = (id, extras = {}) => ({
  planId: id,
  versionId: id + "-1",
  periodId: "period-1",
  planTypeCode: "Y",
  orderType: "M",
  belong_base: "华东",
  status: 2,
  updatedAt: "v1",
  ...extras,
});
const sku = (id, amt, qty = "1", extras = {}) => ({
  versionId: id + "-1",
  skuCode: "sku-1",
  skuName: "测试水饺",
  productCategName: "饺子",
  amt,
  qty,
  ...extras,
});
function fixture(t, plans, skus, intercept) {
  const business = new module.exports.Business({
    geaBaseUrl: "https://gea.example.test",
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 2000,
    inputByteBudget: 30000,
    pageSize: 20,
  });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://gea.example.test",
    auth: { token: "fixture-token", tenantId: "1", name: "Test", id: "user-1", username: "test" },
  });
  t.after(() => business.dispose());
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(String(url));
    assert.equal(init.method, "GET");
    assert.equal(init.headers["X-Access-Token"], "fixture-token");
    const u = new URL(url);
    let value;
    if (u.pathname.endsWith("/skus"))
      value = skus[decodeURIComponent(u.pathname.split("/").at(-2))];
    else {
      const current = Number(u.searchParams.get("pageNo"));
      const size = 2;
      value = {
        records: plans.slice((current - 1) * size, current * size),
        total: plans.length,
        current,
        size,
        pages: Math.ceil(plans.length / size),
      };
    }
    value = (await intercept?.(value, u, init, calls)) ?? value;
    return Response.json({ success: true, result: value });
  });
  return {
    business,
    calls,
    read: (query = { periodId: "period-1" }, signal = new AbortController().signal) =>
      business.agentQuery({ kind: "aggregate", query }, signal).then(JSON.parse),
  };
}

test("aggregate reads all pages internally, sums exact decimals, separates M/Z and only returns summaries", async (t) => {
  const f = fixture(t, [plan("a"), plan("b"), plan("c", { orderType: "Z" })], {
    "a-1": [sku("a", "0.1")],
    "b-1": [sku("b", "0.2")],
    "c-1": [sku("c", "9")],
  });
  const result = await f.read();
  assert.equal(result.coverage, "complete");
  assert.equal(result.value.planCount, 3);
  assert.equal(result.value.bases[0].baseName, "华东");
  assert.equal(result.value.skuRowCount, 3);
  assert.equal(
    result.value.distinctSkuCount,
    1,
    "one SKU appearing in several plans is one product, not three",
  );
  assert.equal(result.value.totals.find((x) => x.orderType === "M").amt, "0.3");
  assert.equal(result.value.totals.find((x) => x.orderType === "Z").amt, "9");
  assert.equal(result.value.totals.find((x) => x.orderType === "M").statusSummary["审批中"], 2);
  assert.equal(result.value.categoryTotals.find((x) => x.orderType === "M").amt, "0.3");
  assert.equal(
    result.value.categoryTotals.find((x) => x.orderType === "M").amountShareWithinScope,
    "1",
  );
  assert.equal(result.value.groups[0].amountShareWithinBase, "1");
  assert.doesNotMatch(JSON.stringify(result.value), /sku-1|a-1|b-1/);
  assert.equal(f.calls.filter((x) => x.endsWith("/skus")).length, 3);
  assert.equal(
    f.calls.filter((x) => !x.endsWith("/skus")).length,
    4,
    "list is rechecked for concurrent changes",
  );
});
test("aggregate refuses an unbounded query before any network call", async (t) => {
  const f = fixture(t, [], {});
  await assert.rejects(f.read({}), /periodId/);
  assert.equal(f.calls.length, 0);
});
test("aggregate refuses changed totals or duplicate plans, never presents a partial sum as complete", async (t) => {
  const f = fixture(t, [plan("a"), plan("a"), plan("b")], {});
  await assert.rejects(f.read(), /GEA_AGGREGATE_(DUPLICATE|CHANGED)/);
});
test("aggregate rejects incomplete SKU collections", async (t) => {
  const f = fixture(t, [plan("a")], {
    "a-1": { records: [sku("a", "2")], total: 3, current: 1, pages: 2 },
  });
  await assert.rejects(f.read(), /GEA_INCOMPLETE_COLLECTION/);
});
test("aggregate rejects invalid amounts and missing categories rather than treating them as zero", async (t) => {
  const f = fixture(t, [plan("a")], { "a-1": [sku("a", null)] });
  await assert.rejects(f.read(), /GEA_AGGREGATE_DECIMAL/);
});
test("aggregate marks absent category and zero denominators explicitly", async (t) => {
  const f = fixture(t, [plan("a")], { "a-1": [sku("a", "0", "0", { productCategName: null })] });
  const r = await f.read();
  assert.equal(r.value.groups[0].productCategName, null);
  assert.equal(r.value.groups[0].amountShareWithinBase, null);
});
test("aggregate rejects a version or status changing during the scan", async (t) => {
  let lists = 0;
  const f = fixture(t, [plan("a")], { "a-1": [sku("a", "1")] }, (v, u) =>
    u.pathname.endsWith("/plans") && ++lists === 2
      ? { ...v, records: [plan("a", { status: 6 })] }
      : v,
  );
  await assert.rejects(f.read(), /GEA_AGGREGATE_CHANGED/);
});
test("aggregate cancellation and logout discard late data", async (t) => {
  const ctrl = new AbortController();
  const f = fixture(t, [plan("a")], { "a-1": [sku("a", "1")] }, (v, u) => {
    if (u.pathname.endsWith("/skus")) ctrl.abort();
    return v;
  });
  await assert.rejects(f.read({ periodId: "period-1" }, ctrl.signal));
});
test("aggregate empty scope returns a complete empty summary", async (t) => {
  const f = fixture(t, [], {});
  const r = await f.read();
  assert.equal(r.coverage, "complete");
  assert.equal(r.value.planCount, 0);
  assert.deepEqual(r.value.groups, []);
});
test("aggregate rejects a silently ignored orderType/status filter instead of calling monthly data correction data", async (t) => {
  const f = fixture(t, [plan("a")], { "a-1": [sku("a", "1")] });
  await assert.rejects(
    f.read({ periodId: "period-1", orderType: "Z" }),
    /GEA_AGGREGATE_FILTER_UNSUPPORTED/,
  );
  assert.equal(f.calls.filter((x) => x.endsWith("/skus")).length, 0);
});
test("missing status is unknown, never counted as pending submission", async (t) => {
  const f = fixture(t, [plan("a", { status: null })], { "a-1": [sku("a", "1")] });
  const r = await f.read();
  assert.deepEqual(r.value.totals[0].statusCounts, { unknown: 1 });
});
test("status buckets and cross-base categories are computed exactly instead of averaged or inferred from status codes", async (t) => {
  const f = fixture(
    t,
    [
      plan("a", { status: 1 }),
      plan("b", { status: 5, belong_base: "郑州" }),
      plan("c", { status: 8, belong_base: "郑州" }),
    ],
    {
      "a-1": [sku("a", "100", "1", { productCategName: "饺子" })],
      "b-1": [sku("b", "200", "1", { productCategName: "汤圆" })],
      "c-1": [sku("c", "700", "1", { productCategName: "饺子" })],
    },
  );
  const v = (await f.read()).value;
  assert.deepEqual(v.totals[0].statusSummary, {
    待提交: 0,
    审批中: 1,
    审批完成待回写: 1,
    退回: 1,
    回写完成: 0,
    状态未知: 0,
  });
  const dumpling = v.categoryTotals.find((x) => x.productCategName === "饺子");
  assert.equal(dumpling.amt, "800");
  assert.equal(dumpling.amountShareWithinScope, "0.8");
  assert.equal(
    v.categoryTotals.reduce((n, r) => n + Number(r.amt), 0),
    1000,
  );
});
