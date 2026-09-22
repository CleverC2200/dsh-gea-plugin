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

import { BUSINESS_MENU_PRESET, businessMenuLabel, resolveBusinessMenu } from "../src/business-navigation.ts";

test("business menu labels rename inventory pages without republishing plugin bundles", () => {
  // 插件包清单里仍是旧名字，菜单按这里的业务叫法展示。
  assert.equal(businessMenuLabel("inventory-aqkc", "安全库存"), "基地库存");
  assert.equal(businessMenuLabel("inventory-qll", "全链路库存"), "全链库存");
  assert.equal(businessMenuLabel("inventory-fc", "分仓库存"), "分仓库存");
});
const menuOf = (ids) => resolveBusinessMenu(BUSINESS_MENU_PRESET, new Map(ids.map(id => [id, `${id} 名称`])));
test("left menu follows the fixed prototype directory and disables unavailable pages", () => {
  const groups = menuOf(['gea-proof', 'gea-regional-plan', 'inventory-apsplan', 'inventory-qll', 'inventory-aqkc', 'inventory-fc', 'inventory-dealer', 'inventory-customer', 'inventory-personal']);
  assert.deepEqual(groups.map(group => [group.key, group.title]), [['supply', '产销协同'], ['plan', '计划管理'], ['inventory', '库存管理'], ['orders', '订单管理']]);
  assert.equal(groups[0].flat, false);
  assert.deepEqual(groups[0].entries.map(entry => entry.id), ['inventory-apsplan']);
  assert.deepEqual(groups[1].entries.map(entry => entry.id), ['plan-region-category', 'gea-proof', 'gea-regional-plan', 'plan-category-production', 'plan-capacity-assessment']);
  assert.deepEqual(groups[2].entries.map(entry => entry.id), ['inventory-qll', 'inventory-aqkc', 'inventory-fc', 'inventory-customer']);
  assert.equal(groups[2].entries[0].title, '全链库存工作台');
  assert.equal(groups[2].entries[0].disabled, false);
  assert.deepEqual(groups[3].entries.map(entry => entry.id), ['inventory-orderworkbench', 'inventory-orderfulfillment']);
  assert.equal(groups[1].entries[0].disabled, true);
  assert.equal(groups[1].entries[1].disabled, false);
  assert.equal(groups[3].entries.every(entry => entry.disabled), true);
});
test("registered development pages become clickable without changing their labels", () => {
  const groups = menuOf(['inventory-orderworkbench', 'inventory-orderfulfillment']);
  const orders = groups.find(group => group.key === 'orders');
  assert.equal(orders.entries.every(entry => entry.disabled === false), true);
  assert.deepEqual(orders.entries.map(entry => entry.title), ['订单管理工作台(开发中)', '订单履约(开发中)']);
});
