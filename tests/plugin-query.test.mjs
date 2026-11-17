import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents:
      "export * from './src/host/plugin-query.ts'; export * from './src/host/error-envelope.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const m = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
);

test("不带分页的查询由宿主补上分页，显式分页与打包读取不改动", () => {
  assert.deepEqual(m.withDefaultPaging({ consumerCode: "branch-inventory", sql: "SELECT 1" }), {
    consumerCode: "branch-inventory",
    sql: "SELECT 1",
    pageNo: 1,
    pageSize: 200,
  });
  assert.deepEqual(m.withDefaultPaging({ sql: "SELECT 1", pageSize: 50 }), {
    sql: "SELECT 1",
    pageSize: 50,
    pageNo: 1,
  });
  assert.deepEqual(m.withDefaultPaging({ sql: "SELECT 1", pageNo: 3, pageSize: 10 }), {
    sql: "SELECT 1",
    pageNo: 3,
    pageSize: 10,
  });
  assert.deepEqual(
    m.withDefaultPaging({ sql: "SELECT 1", packing: { keys: ["a"], order: ["b"] } }),
    { sql: "SELECT 1", packing: { keys: ["a"], order: ["b"] } },
  );
});

test("超出网关上限的页大小由宿主钳制，不把模型的参数当错误", () => {
  assert.deepEqual(m.withDefaultPaging({ sql: "SELECT 1", pageNo: 2, pageSize: 1000 }), {
    sql: "SELECT 1",
    pageNo: 2,
    pageSize: 200,
  });
  assert.equal(m.PLUGIN_QUERY_MAX_PAGE_SIZE, 200);

  assert.deepEqual(m.withDefaultPaging({ sql: "SELECT 1", pageNo: 0, pageSize: 0 }), {
    sql: "SELECT 1",
    pageNo: 1,
    pageSize: 200,
  });
});

test("猜错表名时把“下一步”补进错误里，且仍在 200 字预算内", () => {
  const hinted = m.pluginReadHint("GEA SQL 查询失败（业务码 500）：数据表未发布为可访问资源", [
    "agents_scm_branch_inventory_snapshot",
    "agents_scm_branch_pending_order",
  ]);
  assert.match(hinted, /describe=true/);
  assert.match(hinted, /数据表未发布为可访问资源/);
  assert.ok(hinted.length <= 200, `提示过长: ${hinted.length}`);
  assert.equal(m.readableMessage(hinted), hinted, "补过提示的原因必须仍可读");

  const bare = m.pluginReadHint("只读查询失败", []);
  assert.match(bare, /describe=true/);
  assert.ok(bare.length <= 200);
});

test("失败提示按原因区分：参数写法不再被说成“表不在清单”", () => {
  const parameters = m.pluginReadHint(
    "UNUSED_QUERY_PARAMETER：parameters 里的 1 在 SQL 里没有被引用",
    ["agents_scm_cust_inventory_daily_keys"],
  );
  assert.match(parameters, /:name/);
  assert.equal(parameters.includes("该表或列不在本模块可读清单"), false);
  assert.ok(parameters.length <= 200, `提示过长: ${parameters.length}`);
  assert.equal(m.readableMessage(parameters), parameters, "补过提示的原因必须仍可读");

  const missingTable = m.pluginReadHint(
    "GEA SQL 查询失败（业务码 500）：数据表未发布为可访问资源",
    ["agents_scm_branch_inventory_snapshot"],
  );
  assert.match(missingTable, /describe=true/);
  assert.match(missingTable, /该表或列不在本模块可读清单/);
  assert.ok(missingTable.length <= 200);

  const upstream = m.pluginReadHint("GEA SQL 查询失败（业务码 500）：受控 SQL 执行失败", [
    "agents_scm_cust_inventory_daily",
  ]);
  assert.equal(upstream.includes("该表或列不在本模块可读清单"), false);
  assert.match(upstream, /收窄口径/);
  assert.ok(upstream.length <= 200, `提示过长: ${upstream.length}`);
  assert.equal(m.readableMessage(upstream), upstream, "补过提示的原因必须仍可读");
});

test("列清单探查有预算：不串行探爆工具超时，没探完的如实回报", async () => {
  const slow = (table, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve([`col_${table}`]), 400);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
  const tables = Array.from({ length: 12 }, (_, index) => `agents_t${index}`);
  const started = Date.now();
  const { outcomes, skipped } = await m.probeTables(tables, slow, {
    limit: 6,
    concurrency: 3,
    budgetMs: 2000,
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2500, `耗时 ${elapsed}ms 说明还是在串行等待`);
  assert.equal(outcomes.length, 6);
  assert.equal(skipped.length, 6);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.table),
    tables.slice(0, 6),
    "结果要按契约里的表顺序返回",
  );

  const hung = await m.probeTables(
    ["agents_slow"],
    (table, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve([]), 5000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      }),
    { perProbeMs: 200, budgetMs: 1000 },
  );
  assert.equal(hung.outcomes.length, 1);
  assert.ok(hung.outcomes[0].error, "卡住的表要作为错误回报");
});

test("带错误码的失败保留错误码与可读原因", () => {
  const error = new Error("GEA SQL 查询失败（TABLE_NOT_PUBLISHED）");
  error.code = "GEA_SQL_QUERY_FAILED";
  error.retryable = true;
  assert.deepEqual(m.errorEnvelope(error), {
    code: "GEA_SQL_QUERY_FAILED",
    message: "GEA SQL 查询失败（TABLE_NOT_PUBLISHED）",
    retryable: true,
  });
});

test("大写错误码原样返回，未带码的中文原因也能读出来", () => {
  assert.deepEqual(m.errorEnvelope(new Error("LOGIN_REQUIRED")), {
    code: "LOGIN_REQUIRED",
    message: "LOGIN_REQUIRED",
  });
  assert.deepEqual(m.errorEnvelope(new Error("请先登录 GEA")), {
    code: "GEA_REQUEST_FAILED",
    message: "请先登录 GEA",
  });
});

test("可读原因过滤本机路径、凭据与超长文本", () => {
  assert.deepEqual(m.errorEnvelope(new Error("读取 /Users/synear/secret/config.json 失败")), {
    code: "GEA_REQUEST_FAILED",
    message: "GEA_REQUEST_FAILED",
  });
  assert.deepEqual(m.errorEnvelope(new Error("token Bearer abc.def.ghi 已过期")), {
    code: "GEA_REQUEST_FAILED",
    message: "GEA_REQUEST_FAILED",
  });
  assert.deepEqual(m.errorEnvelope(new Error("x".repeat(500))), {
    code: "GEA_REQUEST_FAILED",
    message: "GEA_REQUEST_FAILED",
  });
  assert.equal(m.readableMessage("  正常 说明  "), "正常 说明");
  assert.equal(m.readableMessage(undefined), undefined);
});
