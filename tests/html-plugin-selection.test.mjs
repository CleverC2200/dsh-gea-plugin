import test from "node:test";
import assert from "node:assert/strict";
import { selectHtmlPlugins } from "../src/html-plugin-selection.ts";

const legacy = ["inventory-apsboard", "inventory-apsdemand", "inventory-apsdelivery"].map(id => ({ id }));
const unified = { id: "inventory-apsplan", replaces: legacy.map(item => item.id) };
test("APS upgrade registers one plugin while preserving unrelated plugins in either installation order", () => {
  const inventory = { id: "inventory-aqkc" };
  for (const plugins of [[unified, ...legacy, inventory], [...legacy, unified, inventory]]) {
    assert.deepEqual(selectHtmlPlugins(plugins), [unified, inventory]);
  }
});
test("legacy installations remain available until the consolidated plugin is installed", () => {
  const plugins = [{ id: "inventory-apsplan" }, ...legacy];
  assert.deepEqual(selectHtmlPlugins(plugins), plugins);
});
test("replacement declarations cannot suppress unrelated plugins", () => {
  const inventory = { id: "inventory-aqkc" };
  assert.equal(selectHtmlPlugins([{ ...unified, replaces: [inventory.id] }, inventory]).length, 2);
});

import { BUSINESS_MENU_PRESET, GEA_SHELL_PANELS, businessMenuLabel, isGeaBusinessPanel, resolveBusinessMenu } from "../src/business-navigation.ts";

test("外壳自己接管右栏的页面都算业务页（漏一个就退回原生落地页样式）", () => {
  // 主生产计划（MPS）是靠这条判定挂上 gea-business-shell 的：漏登记时右栏会冒出
  // DSH 原生欢迎区（鲸鱼 + 工作区/Agent 预设选择器），所以每个菜单里的原型页都要在册。
  for (const item of BUSINESS_MENU_PRESET.flatMap((group) => group.items))
    // HTML 插件页按注册上来的面板动态判定；「(待设计)」的条目还没有页面，不用登记。
    if (!item.id.startsWith("inventory-") && !item.title.includes("待设计"))
      assert.equal(isGeaBusinessPanel(item.id, []), true, `${item.title} 要按业务页布局`);
  assert.deepEqual(
    GEA_SHELL_PANELS,
    ["gea-proof", "gea-regional-plan", "plan-region-category", "plan-category-production", "gea-inbox"],
  );
  // HTML 插件页按注册上来的面板动态判定，不写死在这张表里。
  assert.equal(isGeaBusinessPanel("inventory-qll", []), false);
  assert.equal(
    isGeaBusinessPanel("inventory-qll", [{ options: { key: "inventory-qll", label: "全链库存工作台" } }]),
    true,
  );
});

test("business menu labels rename inventory pages without republishing plugin bundles", () => {
  // 插件包清单里仍是旧名字，菜单按这里的业务叫法展示。
  assert.equal(businessMenuLabel("inventory-aqkc", "安全库存"), "基地库存");
  assert.equal(businessMenuLabel("inventory-qll", "全链路库存"), "全链库存");
  assert.equal(businessMenuLabel("inventory-fc", "分仓库存"), "分仓库存");
});
const menuOf = (ids) => resolveBusinessMenu(BUSINESS_MENU_PRESET, new Map(ids.map(id => [id, `${id} 名称`])));
test("left menu follows the fixed prototype directory and disables unavailable pages", () => {
  const groups = menuOf(['gea-proof', 'gea-regional-plan', 'inventory-apsplan', 'inventory-qll', 'inventory-aqkc', 'inventory-fc', 'inventory-dealer', 'inventory-customer', 'inventory-personal']);
  assert.deepEqual(groups.map(group => [group.key, group.title]), [['supply', '产销协同'], ['plan', '计划管理'], ['inventory', '库存管理']]);
  assert.equal(groups[0].flat, false);
  assert.deepEqual(groups[0].entries.map(entry => entry.id), ['inventory-apsplan']);
  assert.deepEqual(groups[1].entries.map(entry => entry.id), ['plan-region-category', 'gea-proof', 'gea-regional-plan', 'plan-category-production', 'plan-capacity-assessment']);
  assert.deepEqual(groups[2].entries.map(entry => entry.id), ['inventory-qll', 'inventory-aqkc', 'inventory-fc']);
  assert.equal(groups[2].entries[0].title, '全链库存工作台');
  assert.equal(groups[2].entries[0].disabled, false);
  assert.equal(groups[1].entries[0].disabled, true);
  assert.equal(groups[1].entries[1].disabled, false);
});
test("演示与下架模块即便已安装也不占菜单位", () => {
  // 订单管理整组都是演示（mock）页面：装上了也不该冒出来；空分组直接不渲染。
  const groups = menuOf(['inventory-orderworkbench', 'inventory-orderfulfillment', 'inventory-customer', 'inventory-personal']);
  assert.equal(groups.some(group => group.key === 'orders'), false);
  const ids = groups.flatMap(group => group.entries.map(entry => entry.id));
  for (const id of ['inventory-orderworkbench', 'inventory-orderfulfillment', 'inventory-customer', 'inventory-personal'])
    assert.equal(ids.includes(id), false, `${id} 不该出现在业务菜单里`);
});
