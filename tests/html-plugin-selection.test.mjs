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

import { groupBusinessPanels } from "../src/business-navigation.ts";
test("unified APS is the single top-level collaboration entry", () => {
  const panels = [{ id: 'inventory-apsplan', title: '产销协同工作台', order: 10 }];
  const groups = groupBusinessPanels(panels);
  assert.equal(groups.board.id, 'inventory-apsplan');
  assert.deepEqual(groups.plan, []);
});
