/**
 * 能力契约：模块只交一份契约，宿主不再按模块写分支。
 *
 * 这里盯三件真事：
 *   1) 从模块自己的 SQL 里静态提取"可读表"要准（CTE、函数、别的 schema 都不算表）；
 *   2) 口径只从 SKILL.md 里带"口径/规则/边界"的小节摘，且有长度上限；
 *   3) 注册表产出的页面白名单、草稿白名单、只读工具模块清单，都只由契约决定。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents:
      "export * from './src/capability/contract.ts'; export * from './src/capability/registry.ts';",
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

test("formal customer Consumer keeps underscores through normalization and registry lookup", () => {
  const contract = m.contractFromPlugin({
    id: "inventory-customer",
    label: "客户库存",
    consumerCode: "customer_inventory",
    pageIds: ["inventory-customer"],
    maxEffect: "view",
    sources: [],
  });
  const registry = m.createCapabilityRegistry([m.normalizeContract(contract)]);
  assert.equal(registry.byConsumer("customer_inventory").id, "inventory-customer");
  assert.equal(registry.byConsumer("customer-inventory-preview"), undefined);
});

test("只从模块自己的 SQL 里提取受管业务表，CTE 与函数不算表", () => {
  const html = [
    "WITH dsh_packet_source AS (SELECT * FROM agents_scm_branch_inventory_snapshot),",
    "     ranked_order_details AS (SELECT * FROM inventory_batches)",
    "SELECT * FROM data_service.agents_scm_order_fulfillment",
    "JOIN data_service.agents_scm_branch_plan ON true",
    "LEFT JOIN agents_scm_branch_transfer_detail ON true",
    "CROSS JOIN other_schema.pg_thing ON true",
    "CROSS JOIN generate_series(1, 3)",
  ].join("\n");
  assert.deepEqual(m.tablesFromSource(html), [
    "agents_scm_branch_inventory_snapshot",
    "agents_scm_branch_plan",
    "agents_scm_branch_transfer_detail",
    "agents_scm_order_fulfillment",
  ]);
});

test("别的 schema 与非法输入不产生表", () => {
  assert.deepEqual(m.tablesFromSource("SELECT * FROM other_schema.agents_scm_x", ""), []);
  assert.deepEqual(m.tablesFromSource(undefined, "SELECT 1"), []);
});

test("口径只摘带口径/规则/边界的小节，并有长度上限", () => {
  const skill = [
    "---",
    "name: inventory-fc",
    "description: 分仓库存页面。",
    "---",
    "",
    "# 分仓库存",
    "",
    "## 工作顺序",
    "",
    "先读页面再回答。",
    "",
    "## 必须保留的分仓解释口径",
    "",
    "补货采用 order-net-gap-v3，缺失输入按未知处理。",
    "",
    "## 能力边界",
    "",
    "HTML 不持有凭据。",
    "",
  ].join("\n");
  const rules = m.rulesFromSkill(skill);
  assert.equal(rules.length, 2);
  assert.match(rules[0], /order-net-gap-v3/);
  assert.match(rules[1], /不持有凭据/);
  assert.ok(!rules.join("").includes("先读页面再回答"));
  assert.equal("skillDescription" in m, false);
  assert.deepEqual(m.rulesFromSkill("x".repeat(10000)), []);
});

test("迁移页面派生成 self-report 契约，工作台派生成 self-report 契约", () => {
  const plugin = m.contractFromPlugin({
    id: "inventory-fc",
    label: "分仓库存",
    consumerCode: "branch-inventory",
    pageIds: ["inventory-fc"],
    description: "分仓库存页面。",
    skill: "---\ndescription: 分仓库存页面。\n---\n\n## 口径\n\n按 V3 计算。\n",
    sources: ["SELECT * FROM data_service.agents_scm_branch_inventory_snapshot"],
  });
  assert.equal(plugin.view.surface, "gea-html-inventory-fc");
  assert.equal(plugin.view.protocol, "self-report");
  assert.equal(plugin.data.consumerCode, "branch-inventory");
  assert.deepEqual(plugin.data.tables, ["agents_scm_branch_inventory_snapshot"]);
  assert.equal(plugin.maxEffect, "draft");

  const workbench = m.workbenchContract({
    surface: "gea-workbench",
    pageIds: ["gea-workbench"],
  });
  assert.equal(workbench.view.protocol, "self-report");
  assert.equal(workbench.maxEffect, "approve");
});

test("注册表只由契约产出白名单与只读模块清单", () => {
  const plugin = m.contractFromPlugin({
    id: "inventory-fc",
    label: "分仓库存",
    consumerCode: "branch-inventory",
    pageIds: ["inventory-fc"],
    description: "分仓库存页面。",
    skill: "---\ndescription: 分仓库存页面。\n---\n\n## 口径\n\n按 V3 计算。\n",
    sources: ["SELECT * FROM data_service.agents_scm_branch_inventory_snapshot"],
  });
  const readOnly = m.contractFromPlugin({
    id: "inventory-aqkc",
    label: "基地库存",
    consumerCode: "base-safety-stock",
    pageIds: ["inventory-aqkc"],
    maxEffect: "view",
    sources: ["SELECT * FROM data_service.agents_scm_order_fulfillment"],
  });
  const registry = m.createCapabilityRegistry([
    plugin,
    readOnly,
    m.workbenchContract({ surface: "gea-workbench", pageIds: ["gea-workbench"] }),
  ]);
  // 顺序按模块 id 稳定排序，白名单本身不看顺序。
  assert.deepEqual(registry.surfaces(), [
    "gea-workbench",
    "gea-html-inventory-aqkc",
    "gea-html-inventory-fc",
  ]);
  assert.deepEqual(registry.draftSurfaces(), ["gea-workbench", "gea-html-inventory-fc"]);
  assert.equal(registry.allows("gea-html-inventory-aqkc", "draft"), false);
  assert.equal(registry.allows("gea-html-inventory-fc", "draft"), true);
  assert.equal(registry.allows("gea-html-inventory-fc", "approve"), false);
  assert.equal(registry.allows("gea-workbench", "approve"), true);
  assert.equal(registry.readModules().length, 2);
  const index = registry.readToolIndex();
  // 渐进式暴露：索引只给"模块名 + 编码 + 一句话 + 能力层"，表和口径用 describe 按需取。
  assert.match(index, /分仓库存：consumerCode=branch-inventory/);
  assert.match(index, /能力层：/);
  assert.equal(index.includes("agents_scm_branch_inventory_snapshot"), false);
  // 但要去前缀留着"表名关键词"：模型靠它选模块（实测为了找"货龄"会把几个模块的
  // 契约逐个翻一遍，索引里有 inventory_age 就能直接指到安全库存）。
  assert.match(index, /表：/);
  assert.match(index, /branch_inventory_snapshot/);
  assert.ok(index.length < 600, `索引过长会占每次请求的上下文: ${index.length}`);
});

test("已声明的下划线Consumer保持原身份及只读边界，未声明身份不获授权", () => {
  const contract = m.normalizeContract(
    m.contractFromPlugin({
      id: "inventory-customer",
      label: "客户库存",
      consumerCode: "customer_inventory",
      pageIds: ["inventory-customer"],
      maxEffect: "view",
    }),
  );
  const registry = m.createCapabilityRegistry([contract]);
  assert.equal(registry.byConsumer("customer_inventory").id, "inventory-customer");
  assert.equal(registry.byConsumer("customer-inventory"), undefined);
  assert.equal(registry.byConsumer("another_customer"), undefined);
  assert.equal(registry.allows("gea-html-inventory-customer", "view"), true);
  assert.equal(registry.allows("gea-html-inventory-customer", "draft"), false);
  assert.throws(
    () => m.normalizeContract({ ...contract, data: { consumerCode: "customer/inventory" } }),
    /INVALID_CAPABILITY_CONTRACT/,
  );
});

test("关键词能把用户问题路由到模块", () => {
  const plugin = m.contractFromPlugin({
    id: "inventory-fc",
    label: "分仓库存",
    consumerCode: "branch-inventory",
    pageIds: ["inventory-fc"],
  });
  const registry = m.createCapabilityRegistry([plugin]);
  assert.deepEqual(
    registry.route("分仓库存这个月缺货多少").map((contract) => contract.id),
    ["inventory-fc"],
  );
  assert.deepEqual(registry.route("今天天气怎么样"), []);
});

test("模块自己交的契约形状不对就整份丢掉", () => {
<<<<<<< HEAD
  for (const consumerCode of [
    "customer inventory",
    "customer/inventory",
    "customer.inventory",
    "Customer_inventory",
  ]) {
    const contract = m.contractFromPlugin({
      id: "inventory-customer",
      label: "客户库存",
      consumerCode,
      pageIds: ["inventory-customer"],
    });
    assert.throws(() => m.normalizeContract(contract), /INVALID_CAPABILITY_CONTRACT/);
    assert.throws(() => m.createCapabilityRegistry([contract]), /INVALID_CONSUMER_CODE/);
  }
=======
>>>>>>> 0615d33
  assert.throws(() => m.normalizeContract({ id: "x" }), /INVALID_CAPABILITY_CONTRACT/);
  assert.throws(
    () =>
      m.normalizeContract({
        id: "x",
        label: "X",
        data: { consumerCode: "Bad Code" },
      }),
    /INVALID_CAPABILITY_CONTRACT/,
  );
  const ok = m.normalizeContract({
    id: "inventory-x",
    label: "某页面",
    view: {
      surface: "gea-html-inventory-x",
      protocol: "self-report",
      pageIds: ["inventory-x"],
    },
    data: {
      consumerCode: "branch-inventory",
      tables: ["agents_scm_x", "not_a_table"],
      rules: ["口径"],
    },
    skills: ["inventory-x"],
    routing: { keywords: ["库存"], summary: "看库存" },
  });
  assert.equal(ok.maxEffect, "draft");
  assert.deepEqual(ok.data.tables, ["agents_scm_x"]);
});
