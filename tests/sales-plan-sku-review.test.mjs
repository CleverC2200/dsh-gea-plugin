import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("history reads only the plan SKUs once and preserves missing months and partial nulls", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE agents_scm_cust_deliv_daily_di(cust_code TEXT, ship_month TEXT, material_code TEXT, act_dl_qty REAL)",
  );
  const insert = db.prepare("INSERT INTO agents_scm_cust_deliv_daily_di VALUES (?, ?, ?, ?)");
  for (const row of [
    ["customer1", "202511", "1001", 8],
    ["customer1", "202511", "1001", 2],
    ["customer1", "202609", "1001", null],
    ["customer1", "202609", "1001", 5],
    ["customer1", "202610", "1002", 7],
    ["other-customer", "202610", "1002", 900],
    ...Array.from({ length: 400 }, (_, index) => ["customer1", "202610", "unplanned-" + index, 99]),
  ])
    insert.run(...row);
  let calls = 0;
  try {
    const result = await read(
      query,
      async () => ({
        currentVersion: { id: "v1", planId: "p1", dealerCode: "customer1" },
        skus: ["1001", "1002", "1003"].map((skuCode) => ({ skuCode, versionId: "v1" })),
      }),
      async (input) => {
        calls++;
        const rows = db.prepare(input.sql).all(input.parameters);
        return {
          rows: rows.slice((input.pageNo - 1) * 200, input.pageNo * 200),
          total: rows.length,
        };
      },
      () => "2026-11",
      signal(),
    );
    assert.equal(result.shipmentUnavailable, true);
    assert.deepEqual(
      result.rows.map((row) =>
        row.shipments.map((value) => (value === null ? null : Number(value))),
      ),
      [
        [10, null, 0],
        [0, 0, 7],
        [0, 0, 0],
      ],
    );
    assert.deepEqual(result.rows[1].shipments.slice(0, 2), ["0", "0"]);
    assert.equal(calls, 1);
  } finally {
    db.close();
  }
});

test("historical shipment query binds only the authorized customer and three actual shipping months", async () => {
  const calls = [];
  const result = await read(
    query,
    detail,
    async (input) => {
      calls.push(input);
      assert.match(input.sql, /SUM\(CASE WHEN ship_month/);
      assert.match(input.sql, /WHERE cust_code = :customer AND ship_month IN/);
      assert.deepEqual(input.parameters, {
        customer: "customer1",
        month0: "202511",
        month1: "202609",
        month2: "202610",
        sku0: "1001",
      });
      return {
        rows: [{ material_code: "1001", ship_qty0: "0", ship_qty1: "31.5", ship_qty2: "0" }],
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

test("bounded SKU batches consume every row and explicit null remains unknown", async () => {
  const pages = [];
  const result = await read(
    query,
    async () => ({
      currentVersion: { id: "v1", planId: "p1", dealerCode: "customer1" },
      skus: Array.from({ length: 201 }, (_, index) => ({
        skuCode: String(1001 + index),
        versionId: "v1",
      })),
    }),
    async ({ pageNo, parameters }) => {
      pages.push(pageNo);
      return {
        rows: [
          {
            material_code: parameters.sku0,
            ship_qty0: null,
            ship_qty1: "5",
            ship_qty2: "0",
          },
        ],
        total: 1,
      };
    },
    () => "2026-11",
    signal(),
  );
  assert.deepEqual(pages, [1, 1]);
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

test("workbench SKU review derives authorized scope and reuses a validated draft detail once per page load", async (t) => {
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
  const runtimeDir = await mkdtemp(resolve(tmpdir(), "sales-plan-sku-review-"));
  const business = new module.exports.Business({
    runtimeDir,
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
  t.after(async () => {
    business.dispose();
    await rm(runtimeDir, { recursive: true, force: true });
  });
  const planId = "p-y-2026-11-00001";
  const sqlRequests = [];
  let detailReads = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    init.signal.throwIfAborted();
    const path = new URL(url).pathname;
    let result;
    if (path.endsWith("/plans/" + planId)) {
      detailReads++;
      result = {
        currentVersion: {
          id: "v1",
          planId,
          cust_code: 10001,
          orderType: "M",
          planTypeCode: "Y",
          status: 1,
          effective: true,
        },
        skus: [
          {
            versionId: "v1",
            skuCode: "1001",
            materialDescription: "水饺",
            qty: "501.600",
            amt: "1234.50",
            price: "2",
          },
        ],
        versions: [],
        logs: [],
      };
    } else if (path.endsWith("/agent/session"))
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
  const load = { pageOwner: "page-a", generation: "current-load" };
  const readDraft = () => business.salesPlanDraft({ planId, versionId: "v1" }, signal(), load);
  const review = (scope) =>
    business.workbenchQuery({ kind: "skuReview", query: { planId, versionId: "v1" } }, signal(), {
      detailLoad: scope,
    });
  assert.equal((await readDraft()).draft, null);
  assert.equal(detailReads, 2);
  assert.deepEqual(await review({ ...load, pageOwner: "page-b" }), result);
  assert.deepEqual(await review({ ...load, generation: "refresh" }), result);
  assert.equal(detailReads, 4);
  const cancelled = AbortSignal.abort();
  await assert.rejects(
    business.workbenchQuery({ kind: "skuReview", query: { planId, versionId: "v1" } }, cancelled, {
      detailLoad: load,
    }),
    /Abort/i,
  );
  assert.deepEqual(await review(load), result);
  assert.equal(detailReads, 4);
  assert.deepEqual(await review(load), result);
  assert.equal(detailReads, 5);

  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await readDraft();
  t.mock.timers.tick(15_001);
  assert.deepEqual(await review(load), result);
  assert.equal(detailReads, 7);

  await assert.rejects(
    business.agentQuery({ kind: "skuReview", query: { planId, versionId: "v1" } }, signal()),
    /INVALID_QUERY/,
  );
});
