/**
 * 当前页身份：对话这一刻"人正看着哪个业务页"。
 *
 * 线上现象：用户在「经销商库存」页提问，会话却还绑着「客户库存」，模型手上一屏页面
 * 工具、没有任何权威信号，于是读了别的模块的页面、拿到空上下文、最后拒答。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PAGE_TOOL,
  PAGE_IDENTITY_TTL_MS,
  currentPageEnvelope,
  pageIdentityFresh,
} from "../src/host/page-identity.ts";

const dealer = {
  pluginId: "inventory-dealer",
  consumerCode: "dealer-inventory-replenishment",
  label: "经销商库存",
  pageTool: "gea_page",
  at: Date.now(),
};

test("HTML 插件页没有快照时，回答里必须带上“当前页是谁、该用哪个工具”", () => {
  const value = JSON.parse(currentPageEnvelope(dealer));
  assert.equal(value.code, "PAGE_HAS_NO_SNAPSHOT");
  assert.equal(value.currentPage.pluginId, "inventory-dealer");
  assert.equal(value.currentPage.tool, "gea_page");
  assert.match(value.reason, /经销商库存/);
  assert.match(value.reason, /gea_page/);
  assert.match(value.reason, /dealer-inventory-replenishment/);
});

test("演示（mock）页面要把“这是演示数据”说清", () => {
  const value = JSON.parse(
    currentPageEnvelope({
      ...dealer,
      pluginId: "inventory-customer",
      label: "客户库存",
      pageTool: "gea_page",
      mock: true,
    }),
  );
  assert.equal(value.currentPage.mock, true);
  assert.match(value.reason, /演示数据/);
});

test("身份按最近一次页面活动过期：还在轮询就是当前页，久没活动就不是", () => {
  const at = Date.now();
  assert.equal(pageIdentityFresh({ ...dealer, at }, at + 1000), true);
  assert.equal(pageIdentityFresh({ ...dealer, at }, at + PAGE_IDENTITY_TTL_MS), true);
  assert.equal(
    pageIdentityFresh({ ...dealer, at }, at + PAGE_IDENTITY_TTL_MS + 1),
    false,
  );
  // 页面桥每秒轮询，TTL 必须明显大于一轮轮询，否则会把打开的页面判成没打开。
  assert.ok(PAGE_IDENTITY_TTL_MS >= 60_000);
});

test("页面入口只有一个工具名：不再按模块各注册一个", () => {
  assert.equal(PAGE_TOOL, "gea_page");
  assert.equal(dealer.pageTool, PAGE_TOOL);
});
