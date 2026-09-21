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

import { BUSINESS_MENU_PRESET, resolveBusinessMenu } from "../src/business-navigation.ts";
const menuOf = (ids) => resolveBusinessMenu(BUSINESS_MENU_PRESET, new Map(ids.map(id => [id, `${id} 名称`])));
test("left menu follows the prototype group order and hides entries without a page", () => {
  const groups = menuOf(['gea-proof', 'gea-regional-plan', 'inventory-apsplan', 'inventory-qll', 'inventory-aqkc', 'inventory-fc', 'inventory-dealer', 'inventory-personal']);
  assert.deepEqual(groups.map(group => [group.key, group.title]), [['supply', '产销协同'], ['plan', '计划管理'], ['inventory', '库存管理']]);
  assert.deepEqual(groups[0].entries.map(entry => entry.id), ['inventory-apsplan']);
  assert.deepEqual(groups[1].entries.map(entry => entry.id), ['gea-regional-plan', 'gea-proof']);
  assert.deepEqual(groups[2].entries.map(entry => entry.id), ['inventory-qll', 'inventory-aqkc', 'inventory-fc', 'inventory-dealer']);
  assert.equal(groups.some(group => group.key === 'orders'), false);
});
test("menu keeps prototype entries out until their page is registered", () => {
  const groups = menuOf(['inventory-production', 'orders-workbench', 'orders-fulfillment']);
  assert.deepEqual(groups.map(group => group.key), ['plan', 'orders']);
  assert.deepEqual(groups[0].entries.map(entry => entry.id), ['inventory-production']);
  assert.deepEqual(groups[1].entries.map(entry => entry.id), ['orders-workbench', 'orders-fulfillment']);
});
