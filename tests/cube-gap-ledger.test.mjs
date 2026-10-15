// 结构性缺口账本：同一个（模块 + 模型）确认取不到，第二次直接给结论，不再撞一次。
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/host/cube-gap-ledger.ts';",
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

test("记一笔之后能查到，换模块/换模型互不影响", () => {
  const ledger = m.createCubeGapLedger();
  ledger.note("branch-inventory", "agents_scm_inventory_age", {
    kind: "resource-permission",
    code: "AI_GATEWAY_DATA_PERMISSION_DENIED",
    detail: "缺资源 ALLOW：agents_scm_inventory_age-cube",
  });
  const hit = ledger.find("branch-inventory", "agents_scm_inventory_age");
  assert.equal(hit?.kind, "resource-permission");
  assert.match(hit.detail, /缺资源 ALLOW/);
  // 不同模块、不同模型都不算命中
  assert.equal(ledger.find("base-safety-stock", "agents_scm_inventory_age"), undefined);
  assert.equal(ledger.find("branch-inventory", "agents_scm_safety_stock"), undefined);
  ledger.clear();
  assert.equal(ledger.size(), 0);
  assert.equal(ledger.find("branch-inventory", "agents_scm_inventory_age"), undefined);
});

test("TTL 到期后放行一次：管理员刚配好权限，重问就能恢复", () => {
  let now = 1_000_000;
  const ledger = m.createCubeGapLedger({ ttlMs: 60_000, now: () => now });
  ledger.note("branch-inventory", "agents_scm_inventory_age", {
    kind: "resource-permission",
    code: "AI_GATEWAY_DATA_PERMISSION_DENIED",
    detail: "缺资源 ALLOW",
  });
  assert.ok(ledger.find("branch-inventory", "agents_scm_inventory_age"));
  now += 59_000;
  assert.ok(ledger.find("branch-inventory", "agents_scm_inventory_age"));
  now += 2_000;
  assert.equal(ledger.find("branch-inventory", "agents_scm_inventory_age"), undefined);
});

test("空编码或空模型不记账（避免把整通道一棍子打死）", () => {
  const ledger = m.createCubeGapLedger();
  ledger.note("", "agents_scm_inventory_age", {
    kind: "resource-permission",
    code: "AI_GATEWAY_DATA_PERMISSION_DENIED",
    detail: "x",
  });
  ledger.note("branch-inventory", "  ", {
    kind: "resource-permission",
    code: "AI_GATEWAY_DATA_PERMISSION_DENIED",
    detail: "x",
  });
  assert.equal(ledger.size(), 0);
});

test("从查询里取模型名：只看 dimensions/measures/segments 的完整成员名", () => {
  assert.equal(
    m.modelOfQueries([
      { name: "a", query: { dimensions: ["agents_scm_safety_stock.base_name"], limit: 10 } },
    ]),
    "agents_scm_safety_stock",
  );
  // 裸字段/非字符串取不出来（那是 preflight 会拦的形状）
  assert.equal(m.modelOfQueries([{ name: "a", query: { dimensions: ["base_name"] } }]), undefined);
  assert.equal(m.modelOfQueries([{ name: "a", query: { limit: 10 } }]), undefined);
  assert.equal(m.modelOfQueries("not-an-array"), undefined);
});
