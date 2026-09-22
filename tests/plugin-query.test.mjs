/**
 * 受管只读查询稳定化：
 *   - 宿主统一补分页（模型不必记得传页码），页面要分组打包时保持原样；
 *   - 失败必须回可读原因，而不是一句裸 `GEA_REQUEST_FAILED`；
 *   - 可读原因不得带本机路径、凭据或超长文本。
 */
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
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].contents).toString("base64")
);

test("不带分页的查询由宿主补上分页，显式分页与打包读取不改动", () => {
  assert.deepEqual(
    m.withDefaultPaging({ consumerCode: "branch-inventory", sql: "SELECT 1" }),
    {
      consumerCode: "branch-inventory",
      sql: "SELECT 1",
      pageNo: 1,
      pageSize: 200,
    },
  );
  assert.deepEqual(
    m.withDefaultPaging({ sql: "SELECT 1", pageSize: 50 }),
    { sql: "SELECT 1", pageSize: 50, pageNo: 1 },
  );
  assert.deepEqual(
    m.withDefaultPaging({ sql: "SELECT 1", pageNo: 3, pageSize: 10 }),
    { sql: "SELECT 1", pageNo: 3, pageSize: 10 },
  );
  assert.deepEqual(
    m.withDefaultPaging({ sql: "SELECT 1", packing: { keys: ["a"], order: ["b"] } }),
    { sql: "SELECT 1", packing: { keys: ["a"], order: ["b"] } },
  );
});

test("超出网关上限的页大小由宿主钳制，不把模型的参数当错误", () => {
  // 线上现象：工具说明写"上限 1000"，模型照着要 1000 行 → INVALID_PAGE。
  assert.deepEqual(
    m.withDefaultPaging({ sql: "SELECT 1", pageNo: 2, pageSize: 1000 }),
    { sql: "SELECT 1", pageNo: 2, pageSize: 200 },
  );
  assert.equal(m.PLUGIN_QUERY_MAX_PAGE_SIZE, 200);
  // 非法页码/页大小退回默认值，而不是把非法值透给下游。
  assert.deepEqual(
    m.withDefaultPaging({ sql: "SELECT 1", pageNo: 0, pageSize: 0 }),
    { sql: "SELECT 1", pageNo: 1, pageSize: 200 },
  );
});

test("猜错表名时把“下一步”补进错误里，且仍在 200 字预算内", () => {
  const hinted = m.pluginReadHint(
    "GEA SQL 查询失败（业务码 500）：数据表未发布为可访问资源",
    ["agents_scm_branch_inventory_snapshot", "agents_scm_branch_pending_order"],
  );
  assert.match(hinted, /describe=true/);
  assert.match(hinted, /数据表未发布为可访问资源/);
  assert.ok(hinted.length <= 200, `提示过长: ${hinted.length}`);
  assert.equal(m.readableMessage(hinted), hinted, "补过提示的原因必须仍可读");
  // 没有契约时也要给出可执行的下一步。
  const bare = m.pluginReadHint("只读查询失败", []);
  assert.match(bare, /describe=true/);
  assert.ok(bare.length <= 200);
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
  assert.deepEqual(
    m.errorEnvelope(new Error("读取 /Users/synear/secret/config.json 失败")),
    { code: "GEA_REQUEST_FAILED", message: "GEA_REQUEST_FAILED" },
  );
  assert.deepEqual(
    m.errorEnvelope(new Error("token Bearer abc.def.ghi 已过期")),
    { code: "GEA_REQUEST_FAILED", message: "GEA_REQUEST_FAILED" },
  );
  assert.deepEqual(m.errorEnvelope(new Error("x".repeat(500))), {
    code: "GEA_REQUEST_FAILED",
    message: "GEA_REQUEST_FAILED",
  });
  assert.equal(m.readableMessage("  正常 说明  "), "正常 说明");
  assert.equal(m.readableMessage(undefined), undefined);
});
