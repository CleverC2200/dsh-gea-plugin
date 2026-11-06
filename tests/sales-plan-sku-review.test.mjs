import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const bundle = await build({
  entryPoints: ["src/host/sales-plan-sku-review.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { readSalesPlanSkuReview: read } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64")
);
const query = { planId: "p1", versionId: "v1" };
const detail = async () => ({
  currentVersion: { id: "v1", planId: "p1", dealerCode: "customer1" },
  skus: [{ skuCode: "1001", versionId: "v1", qty: "501.600", amt: "1234.50" }],
});
const signal = () => new AbortController().signal;

test("historical shipment query binds only the authorized customer and three actual shipping months", async () => {
  const calls = [];
  const result = await read(
    query,
    detail,
    async (input) => {
      calls.push(input);
      assert.match(input.sql, /SUM\(act_dl_qty\)/);
      assert.match(input.sql, /WHERE cust_code = :customer AND ship_month IN/);
      assert.deepEqual(input.parameters, {
        customer: "customer1",
        month0: "202511",
        month1: "202609",
        month2: "202610",
      });
      return {
        rows: [{ material_code: "1001", ship_month: "202609", ship_qty: "31.5" }],
        total: 1,
      };
    },
    () => "2026-11",
    signal(),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(result.rows[0].shipments, ["0", "31.5", "0"]);
  assert.equal(result.skus[0].amt, "1234.50");
  assert.equal(result.skus[0].qty, "501.600");
});

test("wrong version and denied detail fail before any SQL request", async () => {
  let sqlCalls = 0;
  const sql = async () => {
    sqlCalls++;
    return { rows: [], total: 0 };
  };
  await assert.rejects(
    read({ ...query, versionId: "v2" }, detail, sql, () => "2026-11", signal()),
    /IDENTITY_MISMATCH/,
  );
  await assert.rejects(
    read(
      query,
      async () => {
        throw Error("403");
      },
      sql,
      () => "2026-11",
      signal(),
    ),
    /403/,
  );
  assert.equal(sqlCalls, 0);
});

test("partial pages, malformed facts and query failure never become zero shipments", async () => {
  for (const sql of [
    async () => {
      throw Error("403");
    },
    async () => ({ rows: [], total: 10 }),
    async () => ({
      rows: [{ material_code: "1001", ship_month: "202609", ship_qty: null }],
      total: 1,
      rejectedColumns: ["ship_qty"],
    }),
  ]) {
    const result = await read(query, detail, sql, () => "2026-11", signal());
    assert.equal(result.shipmentUnavailable, true);
    assert.deepEqual(result.rows[0].shipments, [null, null, null]);
  }
});

test("pagination consumes every row and explicit null remains unknown", async () => {
  const pages = [];
  const result = await read(
    query,
    detail,
    async ({ pageNo }) => {
      pages.push(pageNo);
      return {
        rows: [
          {
            material_code: "1001",
            ship_month: pageNo === 1 ? "202511" : "202609",
            ship_qty: pageNo === 1 ? null : "5",
          },
        ],
        total: 2,
      };
    },
    () => "2026-11",
    signal(),
  );
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(result.rows[0].shipments, [null, "5", "0"]);
});

test("identity cancellation discards late SQL data", async () => {
  const controller = new AbortController();
  await assert.rejects(
    read(
      query,
      detail,
      async () => {
        controller.abort();
        return { rows: [], total: 0 };
      },
      () => "2026-11",
      controller.signal,
    ),
    /abort/i,
  );
});

test("workbench route derives the customer and month from authorized detail and rejects model use", async (t) => {
  const bundled = await build({
    entryPoints: ["src/host/business.ts"],
    alias: {
      "@cleverc2200/dsh-agent-workbench/sales-plan": resolve(
        process.env.DSH_TEST_WORKBENCH ?? "../dsh-agent-workbench",
        "src/sales-plan.ts",
      ),
    },
    bundle: true,
    packages: "external",
    write: false,
    platform: "node",
    format: "cjs",
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  const business = new module.exports.Business({
    geaBaseUrl: "https://gea.test",
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 2000,
    pageSize: 20,
  });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://gea.test",
    auth: { token: "fixture", tenantId: "1", id: "u", name: "Test", username: "test" },
  });
  t.after(() => business.dispose());
  const planId = "p-y-2026-11-00001";
  const sqlRequests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    init.signal.throwIfAborted();
    const path = new URL(url).pathname;
    let result;
    if (path.endsWith("/plans/" + planId))
      result = {
        currentVersion: { id: "v1", planId, cust_code: 10001, orderType: "M" },
        skus: [
          {
            versionId: "v1",
            skuCode: "1001",
            materialDescription: "水饺",
            qty: "501.600",
            amt: "1234.50",
          },
        ],
        versions: [],
        logs: [],
      };
    else if (path.endsWith("/agent/session"))
      result = { accessDecision: { allowed: true }, delegationToken: "fixture-delegation" };
    else if (path.endsWith("/sql/execute")) {
      sqlRequests.push(JSON.parse(init.body));
      result = { rows: [], total: 0, rejectedColumns: [] };
    } else throw Error("unexpected request " + path);
    return Response.json({ success: true, code: 200, result });
  });
  const result = await business.workbenchQuery(
    { kind: "skuReview", query: { planId, versionId: "v1" } },
    signal(),
  );
  assert.equal(result.versionId, "v1");
  assert.equal(result.skus[0].amt, "1234.50");
  assert.equal(sqlRequests.length, 1);
  await assert.rejects(
    business.agentQuery({ kind: "skuReview", query: { planId, versionId: "v1" } }, signal()),
    /INVALID_QUERY/,
  );
});
