// 接线检查：三个读工具都要走重复读闸门；目录要能吃内联 inspect 并把真因带出来；
// 中止要走可读错误。这些行为改别处时很容易丢，所以钉在源码层面。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("src/host/agent-tools.ts", "utf8");

test("重复读闸门接在三个读工具上", () => {
  // gea_sales_plan_read：同一条只读查询重复发要收敛
  assert.match(source, /销售计划 \$\{String\(args\.kind\)\}/);
  // gea_gateway_catalog：同一份目录/同一个模型明细重复读要收敛
  assert.match(source, /模型 \$\{String\(args\.model\)\} 的成员/);
  // gea_module_mcp：同一份工具清单重复列要收敛
  assert.match(source, /模块 \$\{consumerCode\} 的工具清单/);
  // 超过一轮上限要有停手文案
  assert.match(source, /GEA_TURN_REPEAT_STOPPED/);
});

test("目录：内联 inspect 能用，拿不到 URI 时把原始返回带出来", () => {
  assert.match(source, /const inline = inspectText\.trim\(\)\.startsWith\("\{"\)/);
  assert.match(source, /semanticModel/);
  assert.match(source, /GEA_CATALOG_RESOURCE_MISSING: tools=\$\{listed\}；原始返回=/);
});

test("中止与非 Error 抛出都走可读化，不算失败", () => {
  // 中止：既不记熔断也不记白跑，只回可读说明
  assert.match(source, /if \(isAbortError\(error\)\) throw readableError\(error\);/);
  // 其余重抛统一可读化
  assert.match(source, /throw readableError\(repaired \?\? error\);/);
  assert.match(source, /throw readableError\(error\);/);
});

test("新一轮开始时清掉『本轮』计数（重复读 + 白跑）", async () => {
  const host = await readFile("src/host.ts", "utf8");
  assert.match(host, /mountTurnAnchor\(ctx, \{/);
  assert.match(host, /business\.repeatReads\(\)\.clear\(\)/);
  assert.match(host, /business\.moduleMcpWaste\(\)\.clear\(\)/);
});
