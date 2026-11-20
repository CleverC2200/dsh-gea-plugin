import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/host/sales-plan-monthly-report.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { readSalesPlanReportFacts: read } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64")
);
const query = { planId: "p1", versionId: "v1" };
const signal = () => new AbortController().signal;
const detail = (codes = ["1001"]) => ({
  currentVersion: {
    id: "v1",
    planId: "p1",
    dealerCode: "c1",
    baseName: "base1",
    provinceCode: "0005",
    effective: true,
  },
  skus: codes.map((skuCode) => ({ skuCode, versionId: "v1" })),
});

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE agents_sales_target_data_d(cust_code TEXT,belong_base TEXT,bill_date TEXT,warehouse_group_type TEXT);
    CREATE TABLE agents_dim_dealer_data_d(cust_code TEXT,cust_type TEXT,cust_group_name TEXT,province_region_code TEXT,region_name TEXT);
    CREATE TABLE agents_dim_cust_sales_material_detail_d(cust_code TEXT,material_code TEXT,material_group TEXT,material_group_name TEXT);
    CREATE TABLE agents_scm_cust_deliv_daily_di(cust_code TEXT,belong_base TEXT,material_code TEXT,act_ship_date TEXT,inventory_org TEXT,act_dl_qty REAL);
    INSERT INTO agents_sales_target_data_d VALUES('c1','base1','202610','FACTORY_WH');
    INSERT INTO agents_dim_dealer_data_d VALUES('c1','dealer','group1','0005','华南经销大区');
    INSERT INTO agents_dim_cust_sales_material_detail_d VALUES('c1','1001','group-code','material-group');
  `);
  const calls = [];
  const sql = async (input, active) => {
    active.throwIfAborted();
    assert.doesNotMatch(input.sql, /\bLIMIT\s+\d+/i);
    calls.push(input);
    const all = db.prepare(input.sql).all(input.parameters);
    return {
      rows: all.slice((input.pageNo - 1) * input.pageSize, input.pageNo * input.pageSize),
      total: all.length,
      rejectedColumns: [],
    };
  };
  return { db, sql, calls };
}

test("report inventory ranks shipment record count, then latest date, then name within authorized customer base SKU", async (t) => {
  const { db, sql, calls } = fixture(t);
  const insert = db.prepare("INSERT INTO agents_scm_cust_deliv_daily_di VALUES(?,?,?,?,?,?)");
  for (const row of [
    ["1001", "20261001", "A", 1],
    ["1001", "20261001", "A", 1],
    ["1001", "20261002", "A", 1],
    ["1001", "20261003", "B", 1000],
    ["1001", "20261003", "B", 1000],
    ["1002", "20261001", "A", 1],
    ["1002", "20261003", "B", 1],
    ["1003", "20261001", "B", 1],
    ["1003", "20261001", "A", 1],
    ["1004", "20261001", "old", 1],
    ["1004", "20261101", "future", 1],
    ["1005", "20261001", null, 1],
    ["1005", "20261001", "", 1],
  ])
    insert.run("c1", "base1", ...row);
  for (let i = 0; i < 10; i++) insert.run("other", "base1", "1001", "20261010", "outside", 1);
  for (let i = 0; i < 10; i++) insert.run("c1", "other", "1001", "20261010", "outside", 1);
  const result = await read(
    query,
    async () => detail(["1001", "1002", "1003", "1004", "1005"]),
    sql,
    () => "2026-10",
    signal(),
  );
  assert.deepEqual(
    result.rows.map((row) => row.inventoryOrganization),
    ["A", "B", "A", "old", null],
  );
  assert.equal(result.rows[0].grading, "FACTORY_WH");
  assert.equal(result.rows[0].customerType, "dealer");
  assert.equal(result.rows[0].customerGroup, "group1");
  assert.equal(result.rows[0].materialGroupCode, "group-code");
  assert.equal(result.rows[1].materialGroupName, null);
  assert.equal(calls.length, 4);
  assert(calls.every((call) => call.includeTotal && call.parameters.customer === "c1"));
  assert.equal(Object.hasOwn(result, "fallbackAreaName"), false);

  for (let i = 0; i < 6; i++) insert.run("c1", "base1", "0999", "20261002", "baseInventory", 1);
  insert.run("c1", "base1", "1006", "20261101", "future", 1);
  const withFallback = await read(
    query,
    async () => detail(["1001", "1005", "1006", "1007"]),
    sql,
    () => "2026-10",
    signal(),
  );
  assert.deepEqual(
    withFallback.rows.map((row) => row.inventoryOrganization),
    ["A", null, "baseInventory", "baseInventory"],
  );
  assert.deepEqual(calls.at(-1).parameters, { customer: "c1", base: "base1", before: "20261101" });
});

test("report facts consume all SKU batches with explicit null for successful empty lookups", async (t) => {
  const { sql, calls } = fixture(t);
  const codes = Array.from({ length: 201 }, (_, index) => String(1001 + index));
  const result = await read(
    query,
    async () => detail(codes),
    sql,
    () => "2026-10",
    signal(),
  );
  assert.equal(result.rows.length, 201);
  assert.equal(result.rows.at(-1).inventoryOrganization, null);
  assert.equal(calls.length, 7);
  assert.equal(calls.filter((call) => call.sql.includes("GROUP BY inventory_org")).length, 1);
});

test("report only fills area names that uniquely match the authorized customer and province", async (t) => {
  const { db, sql, calls } = fixture(t);
  db.exec(`
    INSERT INTO agents_dim_dealer_data_d VALUES('c1','dealer','group1','0006','华东经销大区');
    INSERT INTO agents_dim_dealer_data_d VALUES('other','dealer','group1','0005','另一个大区');
    INSERT INTO agents_dim_dealer_data_d VALUES('c1','dealer','group1','0005',' 华南经销大区 ');
  `);
  const resolve = (readDetail = async () => detail()) =>
    read({ ...query, resolveAreaName: true }, readDetail, sql, () => "2026-10", signal());
  assert.equal((await resolve()).fallbackAreaName, "华南经销大区");
  assert.deepEqual(calls.find((call) => call.sql.includes("region_name")).parameters, {
    customer: "c1",
    province: "0005",
  });
  db.exec(
    "INSERT INTO agents_dim_dealer_data_d VALUES('c1','dealer','group1','0005','冲突的大区')",
  );
  assert.equal((await resolve()).fallbackAreaName, null);
  const missingProvince = detail();
  missingProvince.currentVersion.provinceCode = null;
  calls.length = 0;
  assert.equal((await resolve(async () => missingProvince)).fallbackAreaName, null);
  assert.equal(
    calls.some((call) => call.sql.includes("region_name")),
    false,
  );
});

test("denied, stale or mismatched report detail never reaches SQL", async () => {
  for (const readDetail of [
    async () => {
      throw Error("403");
    },
    async () => ({ ...detail(), currentVersion: { ...detail().currentVersion, effective: false } }),
    async () => ({ ...detail(), currentVersion: { ...detail().currentVersion, id: "v2" } }),
    async () => ({ ...detail(), skus: [{ skuCode: "1001", versionId: "v2" }] }),
  ]) {
    let calls = 0;
    await assert.rejects(
      read(
        query,
        readDetail,
        async () => {
          calls++;
          return { rows: [], total: 0 };
        },
        () => "2026-10",
        signal(),
      ),
    );
    assert.equal(calls, 0);
  }
});

test("unpublished, malformed and partial report reads fail instead of creating zero facts", async () => {
  for (const sql of [
    async () => {
      throw Error("FIELD_NOT_PUBLISHED");
    },
    async () => ({ rows: [], total: 1 }),
    async () => ({ rows: [], total: 0, rejectedColumns: ["cust_type"] }),
    async () => ({ rows: [{}], total: 1 }),
  ])
    await assert.rejects(
      read(
        query,
        async () => detail(),
        sql,
        () => "2026-10",
        signal(),
      ),
    );
});

test("conflicting master data fails while duplicate identical facts are deduplicated by SQL", async (t) => {
  const { db, sql } = fixture(t);
  db.exec(
    "INSERT INTO agents_dim_dealer_data_d VALUES('c1','dealer','group1','0005','华南经销大区')",
  );
  await read(
    query,
    async () => detail(),
    sql,
    () => "2026-10",
    signal(),
  );
  db.exec(
    "INSERT INTO agents_dim_dealer_data_d VALUES('c1','other','group2','0005','华南经销大区')",
  );
  await assert.rejects(
    read(
      query,
      async () => detail(),
      sql,
      () => "2026-10",
      signal(),
    ),
    /AMBIGUOUS_REPORT_FACTS/,
  );
});

test("identity cancellation after a report SQL read discards its result", async () => {
  const controller = new AbortController();
  await assert.rejects(
    read(
      query,
      async () => detail(),
      async () => {
        controller.abort();
        return { rows: [], total: 0 };
      },
      () => "2026-10",
      controller.signal,
    ),
    { name: "AbortError" },
  );
});
