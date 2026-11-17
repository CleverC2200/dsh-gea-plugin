import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_LAYERS,
  LAYER_POLICY,
  layerForEffect,
  layerRank,
  layersForContract,
} from "../src/capability/layers.ts";
import { channelPlan } from "../src/capability/channel.ts";

test("影响等级映射到能力层，写业务数据的两层必须确认", () => {
  assert.deepEqual(CAPABILITY_LAYERS, ["read", "draft", "submit", "approve", "export"]);
  assert.equal(layerForEffect("view"), "read");
  assert.equal(layerForEffect("draft"), "draft");
  assert.equal(layerForEffect("submit"), "submit");
  assert.equal(layerForEffect("approve"), "approve");

  for (const layer of ["submit", "approve"]) {
    assert.equal(LAYER_POLICY[layer].writes, true);
    assert.equal(LAYER_POLICY[layer].confirm, true);
    assert.equal(LAYER_POLICY[layer].receipt, true);
  }
  assert.equal(LAYER_POLICY.read.writes, false);
  assert.equal(LAYER_POLICY.draft.writes, false);
  assert.equal(LAYER_POLICY.draft.confirm, false);

  assert.ok(layerRank("approve") > layerRank("submit"));
  assert.ok(layerRank("submit") > layerRank("draft"));
  assert.ok(layerRank("draft") > layerRank("read"));
});

test("模块有哪几层由事实派生，最大等级之上的层不放行", () => {
  assert.deepEqual(layersForContract({ hasView: true, maxEffect: "view" }), ["read"]);

  assert.deepEqual(layersForContract({ hasView: true, hasData: true, maxEffect: "draft" }), [
    "read",
    "draft",
  ]);

  assert.deepEqual(layersForContract({ hasView: true, hasData: true, maxEffect: "approve" }), [
    "read",
    "draft",
    "submit",
    "approve",
  ]);

  assert.deepEqual(layersForContract({ maxEffect: "view" }), []);

  assert.deepEqual(
    layersForContract({
      hasData: true,
      maxEffect: "draft",
      declared: ["export"],
    }),
    ["read", "draft", "export"],
  );
});

test("通道顺序由宿主算好：当前页 → 模块 MCP → 受管只读", () => {
  const page = {
    pluginId: "inventory-dealer",
    consumerCode: "dealer-inventory-replenishment",
    label: "经销商库存",
    pageTool: "inventory_dealer_page",
    at: Date.now(),
  };
  const plan = channelPlan({
    currentPage: page,
    module: {
      consumerCode: "dealer-inventory-replenishment",
      label: "经销商库存",
      readableTables: 1,
    },
  });
  assert.equal(plan.page.tool, "inventory_dealer_page");
  assert.equal(plan.module.tool, "mcp__gea-gateway__query_business_data");
  assert.equal(plan.read.tool, "gea_plugin_read");
  assert.equal(plan.read.consumerCode, "dealer-inventory-replenishment");
  assert.match(plan.note, /不要三条通道各试一遍/);
  assert.match(plan.page.when, /这一屏/);
});

test("没有页面时不给页面通道；演示页面要点名“不能当业务事实”", () => {
  const bare = channelPlan({});
  assert.equal(bare.page, undefined);
  assert.equal(bare.module, undefined);
  assert.equal(bare.read.tool, "gea_plugin_read");

  const mock = channelPlan({
    currentPage: {
      pluginId: "inventory-customer",
      consumerCode: "customer_inventory",
      label: "客户库存",
      pageTool: "inventory_customer_page",
      mock: true,
      at: Date.now(),
    },
    module: {
      consumerCode: "customer_inventory",
      label: "客户库存",
      readableTables: 0,
    },
  });
  assert.match(mock.note, /演示模块/);

  assert.match(mock.read.when, /没有登记可直读的表/);
});
