import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const built = await build({
  entryPoints: ["src/host/business.ts"],
  bundle: true,
  packages: "external",
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);

function fixture(t, sqlResult, planRows, groupMetrics) {
  const business = new module.exports.Business({
    runtimeDir: tmpdir(),
    geaBaseUrl: "https://gea.test",
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 2000,
    pageSize: 20,
  });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://gea.test",
    auth: {
      token: "fixture",
      tenantId: "1",
      id: "u",
      name: "Test",
      username: "test",
    },
  });
  t.after(() => business.dispose());
  const sqlRequests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    init.signal.throwIfAborted();
    let result;
    const path = new URL(url).pathname;
    if (path.endsWith("/plans"))
      result = {
        records: planRows ?? [
          {
            planId: "p-jxs-2026-10-00001",
            periodId: "17",
            cust_code: 1001,
            currentQty: "100",
            currentAmount: "500",
            targetAmount: "1000",
          },
          {
            planId: "p-jxs-2026-10-00002",
            periodId: "17",
            cust_code: 1001,
            currentQty: "50",
            currentAmount: "200",
          },
          {
            planId: "p-jxs-2026-10-00003",
            periodId: "17",
            cust_code: 1002,
            currentQty: "70",
            currentAmount: "400",
          },
        ],
        groupMetrics: groupMetrics ?? [
          {
            dimension: "region",
            key: "org1",
            targetAmount: "3000",
            planAmount: "1100",
            planQty: "220",
            diffAmount: "-1900",
            shipQty: "9999",
            shipAmount: "8888",
            amountProgress: "777",
            shipmentError: "old source",
          },
        ],
        summary: {
          targetAmount: "3000",
          planAmount: "1100",
          planQty: "220",
          diffAmount: "-1900",
        },
        total: planRows?.length ?? 3,
        size: 20,
        current: 1,
        pages: 1,
      };
    else if (path.endsWith("/agent/session"))
      result = {
        accessDecision: { allowed: true },
        delegationToken: "fixture-delegation",
      };
    else if (path.endsWith("/sql/execute")) {
      sqlRequests.push(JSON.parse(init.body));
      if (sqlResult instanceof Error) throw sqlResult;
      result = typeof sqlResult === "function" ? await sqlResult(sqlRequests.at(-1)) : sqlResult;
    } else throw Error("unexpected external request: " + path);
    return Response.json({ success: true, result });
  });
  return { business, sqlRequests };
}

test("independent monthly quantity and amount queries start before either completes", async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const { business, sqlRequests } = fixture(t, async (request) => {
    if (request.sql.includes("qtyshipped")) await held;
    return { rows: [], total: 0, rejectedColumns: [] };
  });
  const pending = business.workbenchQuery(
    { kind: "list", query: { orderType: "Z" } },
    new AbortController().signal,
  );
  let started;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    started = sqlRequests.length;
  } finally {
    release();
  }
  await pending;
  assert.equal(started, 2);
});

test("the owned list can publish its plan rows while shipment SQL is still pending", async (t) => {
  const held = Promise.withResolvers();
  const { business, sqlRequests } = fixture(t, async () => {
    await held.promise;
    return { rows: [], total: 0, rejectedColumns: [] };
  });
  const pages = [];
  const finished = business.workbenchQuery(
    { kind: "list", query: { orderType: "Z" } },
    new AbortController().signal,
    undefined,
    (page) => pages.push(page),
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sqlRequests.length, 2);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].records.length, 3);
    assert.ok(
      pages[0].records.every(
        (row) => row.shipmentPending && row.shipQty == null && row.shipAmount == null,
      ),
    );
    assert.equal(pages[0].groupMetrics[0].shipAmount, undefined);
  } finally {
    held.resolve();
    await finished;
  }
  const result = await finished;
  assert.ok(result.records.every((row) => !row.shipmentPending && row.shipmentError));
});

test("correction list adds monthly shipment quantities for visible customers without changing original plan values", async (t) => {
  const { business, sqlRequests } = fixture(t, (request) =>
    request.sql.includes("agents_order_execute_isontime_mi")
      ? {
          rows: [{ cust_code: "1001", ship_qty: "12.5000" }],
          total: 1,
          returnedColumns: ["cust_code", "ship_qty"],
          rejectedColumns: [],
        }
      : {
          rows: [
            { cust_code: "1001", ship_amount: "125.00" },
            { cust_code: "1002", ship_amount: "0" },
          ],
          total: 2,
          returnedColumns: ["cust_code", "ship_amount"],
          rejectedColumns: [],
        },
  );
  const page = await business.workbenchQuery(
    { kind: "list", query: { orderType: "Z", periodId: "17" } },
    new AbortController().signal,
  );
  assert.equal(page.records[0].shipQty, "12.5000");
  assert.equal(page.records[1].shipQty, "12.5000");
  assert.equal(page.records[2].shipQty, null);
  assert.equal(page.records[0].currentQty, "100");
  assert.equal(page.records[0].shipAmount, "125.00");
  assert.equal(page.records[1].shipAmount, "125.00");
  assert.equal(page.records[2].shipAmount, "0");
  assert.equal(page.records[0].amountProgress, "12.5");
  assert.equal(page.records[0].currentAmount, "500");
  assert.equal(page.total, 3);
  assert.deepEqual(page.groupMetrics, [
    {
      dimension: "region",
      key: "org1",
      targetAmount: "3000",
      planAmount: "1100",
      planQty: "220",
      diffAmount: "-1900",
    },
  ]);
  assert.deepEqual(page.summary, {
    targetAmount: "3000",
    planAmount: "1100",
    planQty: "220",
    diffAmount: "-1900",
  });
  assert.equal(sqlRequests.length, 2);
  assert.match(sqlRequests[1].sql, /agents_scm_cust_deliv_daily_di/);
  assert.match(sqlRequests[1].sql, /SUM\(income_excl_tax_local\)/i);
  assert.match(sqlRequests[1].sql, /ship_month\s*=/);
  assert.deepEqual(
    Object.values(sqlRequests[1].parameters).filter((value) => typeof value === "string"),
    ["202610", "1001", "1002"],
  );
  assert.match(sqlRequests[0].sql, /agents_order_execute_isontime_mi/);
  assert.match(sqlRequests[0].sql, /SUM\(qtyshipped\)/i);
  assert.match(sqlRequests[0].sql, /fromorderno_month\s*>=/);
  assert.match(sqlRequests[0].sql, /fromorderno_month\s*</);
  assert.deepEqual(
    Object.values(sqlRequests[0].parameters).filter((value) => typeof value === "string"),
    ["2026-10-01", "2026-11-01", "1001", "1002"],
  );
});

test("a rejected shipment source leaves original plans visible and shipment values unknown", async (t) => {
  const { business } = fixture(t, Error("fixture-permission-denied"));
  const page = await business.workbenchQuery(
    { kind: "list", query: { orderType: "Z" } },
    new AbortController().signal,
  );
  assert.equal(page.total, 3);
  assert.equal(page.records[0].currentAmount, "500");
  assert.equal(page.records[0].shipQty, null);
  assert.equal(page.records[0].shipAmount, null);
  assert.match(page.records[0].shipmentError, /发货|查询/);
  for (const key of ["shipQty", "shipAmount", "amountProgress", "shipmentError"])
    assert.equal(Object.hasOwn(page.groupMetrics[0], key), false);
});

test("monthly queries preserve reported shipment facts without reading them again", async (t) => {
  const { business, sqlRequests } = fixture(t, Error("must-not-read"), [
    {
      planId: "p-jxs-2026-10-00001",
      periodId: "17",
      cust_code: 1001,
      currentQty: "100",
      currentAmount: "500",
      targetAmount: "1000",
      shipQty: "0",
      shipAmount: "0",
      amountProgress: "0",
    },
  ]);
  const page = await business.workbenchQuery(
    { kind: "list", query: { orderType: "M" } },
    new AbortController().signal,
  );
  assert.equal(page.records[0].currentQty, "100");
  assert.equal(page.records[0].shipQty, "0");
  assert.equal(page.records[0].shipAmount, "0");
  assert.equal(page.records[0].amountProgress, "0");
  assert.equal(sqlRequests.length, 0);
  assert.equal(page.groupMetrics[0].shipQty, "9999");
  assert.equal(page.groupMetrics[0].shipAmount, "8888");
  assert.equal(page.groupMetrics[0].amountProgress, "777");
});

test("monthly plans with missing progress read shipment facts for their plan month", async (t) => {
  const { business, sqlRequests } = fixture(t, (request) => ({
    rows: request.sql.includes("agents_order_execute_isontime_mi")
      ? [{ cust_code: "1001", ship_qty: "12.5" }]
      : [{ cust_code: "1001", ship_amount: "125" }],
    total: 1,
    rejectedColumns: [],
  }));
  const page = await business.workbenchQuery(
    { kind: "list", query: { orderType: "M", periodId: "17" } },
    new AbortController().signal,
  );
  assert.equal(page.records[0].shipQty, "12.5");
  assert.equal(page.records[0].shipAmount, "125");
  assert.equal(page.records[0].amountProgress, "12.5");
  assert.equal(page.records[0].currentAmount, "500");
  assert.equal(sqlRequests.length, 2);
});

test("monthly shipment failures stay unknown", async (t) => {
  const { business } = fixture(t, Error("fixture-source-unavailable"));
  const page = await business.workbenchQuery(
    { kind: "list", query: { orderType: "M", periodId: "17" } },
    new AbortController().signal,
  );
  assert.equal(page.records[0].shipQty, null);
  assert.equal(page.records[0].shipAmount, null);
  assert.equal(page.records[0].amountProgress, null);
  assert.match(page.records[0].shipmentError, /发货.*读取失败/);
});

test("monthly missing group metrics allow completed row facts to be aggregated", async (t) => {
  const { business, sqlRequests } = fixture(
    t,
    Error("must-not-read"),
    [
      {
        planId: "p-jxs-2026-10-00001",
        periodId: "17",
        cust_code: 1001,
        targetAmount: "1000",
        shipQty: "0",
        shipAmount: "0",
      },
    ],
    [
      {
        dimension: "region",
        key: "org1",
        shipQty: null,
        shipAmount: null,
        amountProgress: null,
      },
    ],
  );
  const page = await business.workbenchQuery(
    { kind: "list", query: { orderType: "M", periodId: "17" } },
    new AbortController().signal,
  );
  assert.equal(page.records[0].amountProgress, "0");
  assert.equal(sqlRequests.length, 0);
  assert.deepEqual(page.groupMetrics, [{ dimension: "region", key: "org1" }]);
});

test("monthly empty shipment results stay missing with the plan month", async (t) => {
  const { business } = fixture(t, { rows: [], total: 0, rejectedColumns: [] });
  const page = await business.workbenchQuery(
    { kind: "list", query: { orderType: "M", periodId: "17" } },
    new AbortController().signal,
  );
  assert.equal(page.records[0].shipAmount, null);
  assert.equal(page.records[0].amountProgress, null);
  assert.match(page.records[0].shipmentError, /2026-10/);
});

test("an unavailable amount source preserves shipment quantities and original plans", async (t) => {
  const { business } = fixture(t, (request) => {
    if (request.sql.includes("agents_scm_cust_deliv_daily_di"))
      throw Error("amount-permission-denied");
    return {
      rows: [{ cust_code: "1001", ship_qty: "12.5000" }],
      total: 1,
      returnedColumns: ["cust_code", "ship_qty"],
      rejectedColumns: [],
    };
  });
  const page = await business.workbenchQuery(
    { kind: "list", query: { orderType: "Z" } },
    new AbortController().signal,
  );
  assert.equal(page.records[0].shipQty, "12.5000");
  assert.equal(page.records[0].shipAmount, null);
  assert.equal(page.records[0].amountProgress, null);
  assert.equal(page.records[0].currentAmount, "500");
  assert.match(page.records[0].shipmentError, /发货金额.*查询服务暂时不可用/);
});

test("M and Z lists reject every wrong or missing requested period before shipment queries", async (t) => {
  const rows = [
    { planId: "p-jxs-2026-10-00001", periodId: "17", cust_code: 1001 },
    { planId: "p-jxs-2026-10-00002", periodId: "18", cust_code: 1002 },
  ];
  const { business, sqlRequests } = fixture(t, Error("must-not-query-shipments"), rows);
  for (const orderType of ["M", "Z"]) {
    for (const periodId of ["18", undefined, null]) {
      rows[1].periodId = periodId;
      await assert.rejects(
        business.workbenchQuery(
          { kind: "list", query: { orderType, periodId: "17" } },
          new AbortController().signal,
        ),
        /GEA_PLAN_PERIOD_MISMATCH/,
      );
      assert.equal(sqlRequests.length, 0);
    }
  }
});

test("M and Z matching periods preserve original plan values with string and numeric response IDs", async (t) => {
  const rows = [
    {
      planId: "p-jxs-2026-10-00001",
      periodId: 17,
      cust_code: 1001,
      currentQty: "100",
      currentAmount: "500",
    },
    {
      planId: "p-jxs-2026-10-00002",
      periodId: "17",
      cust_code: 1002,
      currentQty: "70",
      currentAmount: "400",
    },
  ];
  const { business } = fixture(t, Error("fixture-source-unavailable"), rows);
  for (const orderType of ["M", "Z"]) {
    const page = await business.workbenchQuery(
      { kind: "list", query: { orderType, periodId: "17" } },
      new AbortController().signal,
    );
    assert.equal(page.total, 2);
    for (let index = 0; index < rows.length; index++)
      for (const field of ["planId", "currentQty", "currentAmount"])
        assert.equal(page.records[index][field], rows[index][field]);
    assert.deepEqual(
      page.records.map((row) => row.periodId),
      ["17", "17"],
    );
    assert.deepEqual(page.summary, {
      targetAmount: "3000",
      planAmount: "1100",
      planQty: "220",
      diffAmount: "-1900",
    });
  }
});

test("unfiltered period discovery and an empty filtered summary keep their existing contracts", async (t) => {
  const rows = [
    { planId: "p-jxs-2026-10-00001", periodId: "17", cust_code: 1001 },
    { planId: "p-jxs-2026-11-00001", periodId: "18", cust_code: 1001 },
  ];
  const { business, sqlRequests } = fixture(t, Error("must-not-query-shipments"), rows);
  const discovered = await business.workbenchQuery(
    { kind: "list", query: {} },
    new AbortController().signal,
  );
  assert.deepEqual(
    discovered.records.map((row) => row.periodId),
    ["17", "18"],
  );
  rows.length = 0;
  const summary = await business.workbenchQuery(
    {
      kind: "list",
      query: { orderType: "Z", periodId: "17", summaryOnly: true },
    },
    new AbortController().signal,
  );
  assert.deepEqual(summary.records, []);
  assert.deepEqual(summary.summary, {
    targetAmount: "3000",
    planAmount: "1100",
    planQty: "220",
    diffAmount: "-1900",
  });
  assert.equal(sqlRequests.length, 0);
});
