import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { stockRows, stockState, installStockRoutes } from "./fixtures/branch-stock.mjs";
import {
  branchStockAcceptance,
  branchStockExpectedText,
} from "./fixtures/branch-stock-acceptance.mjs";

const planSql =
  "SELECT p.plan_snapshot_date::text AS plan_snapshot_date FROM plans WHERE pickup_point=:gea_p1";

test("branch acceptance supplies two independent months for the fixed September sample", () => {
  const rows = stockRows(planSql, "ok", { gea_p1: "06" }, branchStockAcceptance);
  assert.deepEqual(
    rows.map((row) => [
      row.target_month,
      row.material_code,
      row.shipment_plan_qty,
      row.transfer_plan_qty,
    ]),
    [
      ["2026-09-01", "FC001", 300, 0],
      ["2026-09-01", "FC002", 300, 0],
      ["2026-10-01", "FC001", 300, 0],
      ["2026-10-01", "FC002", 300, 0],
    ],
  );
});

test("fixed September shipments are not returned for October or a missing period parameter", () => {
  const sql =
    "SELECT material_code AS sku, SUM(metric_value) AS shipped_qty FROM facts WHERE period_month=:gea_p2::date";
  assert.deepEqual(
    stockRows(sql, "ok", { gea_p1: "06", gea_p2: "2026-09-01" }, branchStockAcceptance),
    [
      { sku: "FC001", shipped_qty: 20 },
      { sku: "FC002", shipped_qty: 20 },
    ],
  );
  assert.deepEqual(
    stockRows(sql, "ok", { gea_p1: "06", gea_p2: "2026-10-01" }, branchStockAcceptance),
    [],
  );
  assert.deepEqual(stockRows(sql, "ok", { gea_p1: "2026-09-01" }, branchStockAcceptance), []);
});

test("the full historical oracle gains only the documented refresh action", async () => {
  const raw = await readFile(new URL("./fixtures/branch-stock-original.json.raw", import.meta.url));
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(digest(raw), "84699437b156626a58bc05460e30d45142d704e4188871db2f9b4ac46b8b4cfc");
  const legacy = JSON.parse(raw).results.find((result) => result.label === "legacy").text;
  assert.equal(
    digest(branchStockExpectedText(legacy)),
    "f8eade9a24e1ddc9ebc3323aeede90b4c9f4f47599442a0c6049969cf1cda8fe",
  );
});

test("acceptance plans opt in through the route without changing other stock fixtures", () => {
  const planRequest = {
    url: new URL("http://127.0.0.1/ai/gateway/sql/execute"),
    headers: { "x-request-id": "fixture" },
    body: JSON.stringify({ sql: planSql, parameters: { gea_p1: "06" } }),
  };
  for (const [state, months] of [
    [stockState(), ["2026-09-01", "2026-09-01"]],
    [stockState(branchStockAcceptance), ["2026-09-01", "2026-09-01", "2026-10-01", "2026-10-01"]],
  ]) {
    let route, reply;
    installStockRoutes(
      {
        route: (handler) => {
          route = handler;
        },
      },
      state,
    );
    assert.equal(
      route(planRequest, {}, (value) => {
        reply = value;
      }),
      true,
    );
    assert.deepEqual(
      reply.result.rows.map((row) => row.target_month),
      months,
    );
    assert.deepEqual(stockRows(planSql, "empty", { gea_p1: "06" }, state.sample), []);
  }
});

test("full-text expectation refuses a missing or duplicated historical UI anchor", () => {
  assert.throws(
    () => branchStockExpectedText("没有原锚点"),
    /historical refresh anchor must be unique/,
  );
  assert.throws(
    () => branchStockExpectedText("大日期处理\n长沙分仓\n大日期处理\n长沙分仓"),
    /historical refresh anchor must be unique/,
  );
});
