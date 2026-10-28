import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const bundle = await build({
  entryPoints: ["src/host/business.ts"],
  bundle: true,
  packages: "external",
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);

function fixture(t, rows) {
  const business = new module.exports.Business({
    geaBaseUrl: "https://gea.test",
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 2000,
    pageSize: 20,
  });
  const login = () =>
    business.restoreDesktopLogin({
      schema: 1,
      environment: "production",
      base: "https://gea.test",
      auth: { token: "fixture", tenantId: "1", id: "u", name: "Test", username: "test" },
    });
  login();
  t.after(() => business.dispose());
  const sqlRequests = [];
  const skus = [
    { skuCode: "10003243", versionId: "v1", skuName: null },
    { skuCode: "10003245", versionId: "v1", skuName: "计划原名称" },
  ];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    init.signal.throwIfAborted();
    const path = new URL(url).pathname;
    let result;
    if (path.endsWith("/versions/v1/skus")) result = skus;
    else if (path.endsWith("/plans/p1"))
      result = { currentVersion: { id: "v1", planId: "p1" }, versions: [], logs: [], skus };
    else if (path.endsWith("/agent/session"))
      result = { accessDecision: { allowed: true }, delegationToken: "fixture-delegation" };
    else if (path.endsWith("/sql/execute")) {
      sqlRequests.push(JSON.parse(init.body));
      if (rows instanceof Error) throw rows;
      result = { rows, total: rows.length, rejectedColumns: [] };
    } else throw Error("unexpected request: " + path);
    return Response.json({ success: true, result });
  });
  return { business, sqlRequests, login, skus };
}

test("detail and version SKU reads fill a missing material name from an exact unique master record", async (t) => {
  const { business, sqlRequests } = fixture(t, [
    { material_code: "10003243", material_name: "思念400g简装黑芝麻汤圆（20袋）" },
  ]);
  const detail = await business.workbenchQuery(
    { kind: "detail", query: { planId: "p1" } },
    new AbortController().signal,
  );
  assert.equal(detail.skus[0].materialDescription, "思念400g简装黑芝麻汤圆（20袋）");
  assert.equal(detail.skus[1].materialDescription, "计划原名称");
  const skus = await business.workbenchQuery(
    { kind: "versionSkus", query: { versionId: "v1" } },
    new AbortController().signal,
  );
  assert.equal(skus[0].materialDescription, detail.skus[0].materialDescription);
  assert.equal(sqlRequests.length, 1);
  assert.match(sqlRequests[0].sql, /agents_dim_product_list_mi/);
  assert.deepEqual(
    Object.values(sqlRequests[0].parameters).filter((value) => typeof value === "string"),
    ["10003243"],
  );
});

test("ambiguous master names are not selected arbitrarily", async (t) => {
  const { business } = fixture(t, [
    { material_code: "10003243", material_name: "名称甲" },
    { material_code: "10003243", material_name: "名称乙" },
  ]);
  const skus = await business.workbenchQuery(
    { kind: "versionSkus", query: { versionId: "v1" } },
    new AbortController().signal,
  );
  assert.equal(skus[0].materialDescription, undefined);
  assert.equal(skus[0].skuName, null);
});

test("a master read failure preserves the available plan detail", async (t) => {
  const { business } = fixture(t, Error("source-unavailable"));
  const detail = await business.workbenchQuery(
    { kind: "detail", query: { planId: "p1" } },
    new AbortController().signal,
  );
  assert.equal(detail.skus.length, 2);
  assert.equal(detail.skus[0].materialDescription, undefined);
  assert.equal(detail.skus[1].materialDescription, "计划原名称");
});

test("an invalid version is rejected before querying material master data", async (t) => {
  const { business, sqlRequests, skus } = fixture(t, []);
  skus[0].versionId = "different-version";
  await assert.rejects(
    business.workbenchQuery(
      { kind: "detail", query: { planId: "p1" } },
      new AbortController().signal,
    ),
    /GEA_IDENTITY_MISMATCH/,
  );
  assert.equal(sqlRequests.length, 0);
});
