/**
 * "这个对话在主对话还是业务工作台"的判定。
 *
 * 线上现象：用户在主对话里问业务问题，助手却拿工作台留下的页面快照当"眼前这一屏"。
 * 现在只认前端上报的菜单状态字段：默认主对话，点菜单才切；快照/心跳都不能当判据。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { workbenchPresence } from "../src/host/workbench-presence.ts";
import { businessMenuTitle } from "../src/business-navigation.ts";
import {
  MAIN_MENU,
  MENU_MAX_CHARS,
  isMainSurface,
  normalizeSurface,
  surfaceLabel,
  surfacePromptLine,
} from "../src/host/workbench-surface.ts";

const now = 1_700_000_000_000;

test("没上报过菜单状态＝主对话", () => {
  const presence = workbenchPresence({});
  assert.equal(presence.inWorkbench, false);
  assert.equal(presence.signal, "menu");
  assert.equal(presence.menu, MAIN_MENU);
  assert.match(presence.menuTitle, /主对话/);
  assert.equal(presence.menuReportedAt, undefined);
});

test("报了 main 也是主对话", () => {
  const surface = normalizeSurface({ menu: MAIN_MENU }, now);
  const presence = workbenchPresence({ surface });
  assert.equal(presence.inWorkbench, false);
  assert.equal(presence.menu, MAIN_MENU);
  assert.equal(presence.menuReportedAt, new Date(now).toISOString());
});

test("点了业务菜单就在工作台，并且知道是哪一页", () => {
  const surface = normalizeSurface(
    { menu: "inventory-qll", title: "全链库存工作台" },
    now,
  );
  const presence = workbenchPresence({ surface });
  assert.equal(presence.inWorkbench, true);
  assert.equal(presence.signal, "menu");
  assert.equal(presence.menu, "inventory-qll");
  assert.equal(presence.menuTitle, "全链库存工作台");
});

test("菜单名缺省时用菜单 id 兜底，不会变成空字符串", () => {
  assert.equal(
    normalizeSurface({ menu: "inventory-fc" }, now).title,
    "inventory-fc",
  );
  assert.equal(surfaceLabel(undefined), "主对话（未上报菜单状态）");
});

test("菜单字段是不可信输入：缺 menu 报错，控制字符被清掉，超长被截断", () => {
  assert.throws(
    () => normalizeSurface({ menu: "  " }, now),
    /INVALID_WORKBENCH_MENU/,
  );
  assert.throws(
    () => normalizeSurface({ menu: 7 }, now),
    /INVALID_WORKBENCH_MENU/,
  );
  assert.equal(normalizeSurface({ menu: "a\u0000b" }, now).menu, "a b");
  const long = normalizeSurface({ menu: "x".repeat(200) }, now);
  assert.equal(long.menu.length, MENU_MAX_CHARS);
});

test("菜单状态字段是主对话/工作台的唯一判据", () => {
  assert.equal(isMainSurface(undefined), true);
  assert.equal(isMainSurface(normalizeSurface({ menu: MAIN_MENU }, now)), true);
  assert.equal(
    isMainSurface(normalizeSurface({ menu: "gea-proof" }, now)),
    false,
  );
});

test("菜单名解析：注册页面优先 → 原型目录 → 回退 id", () => {
  assert.equal(businessMenuTitle(MAIN_MENU), "主对话");
  assert.equal(
    businessMenuTitle("inventory-qll", [
      { id: "inventory-qll", title: "全链库存", order: 1 },
    ]),
    "全链库存",
  );
  assert.equal(businessMenuTitle("inventory-qll"), "全链库存工作台");
  assert.equal(businessMenuTitle("plan-region-category"), "区域及品类计划工作台");
  assert.equal(businessMenuTitle("unknown-page"), "unknown-page");
});

test("每轮注入的「业务位置」：主对话就明说别读页面", () => {
  const main = surfacePromptLine(undefined);
  assert.match(main, /业务位置/);
  assert.match(main, /主对话/);
  assert.match(main, /不要调用 gea_page 或 gea_visible_workbench_context/);
  assert.match(main, /gea_module_mcp/);
  // 报了 main 与没上报过是同一种事实，措辞一致。
  assert.equal(surfacePromptLine(normalizeSurface({ menu: MAIN_MENU })), main);
});

test("每轮注入的「业务位置」：业务菜单才允许读这一屏", () => {
  const line = surfacePromptLine(
    normalizeSurface({ menu: "inventory-qll", title: "全链库存工作台" }),
  );
  assert.match(line, /业务菜单「全链库存工作台」/);
  assert.match(line, /gea_page/);
  assert.equal(line.includes("不要调用 gea_page"), false);
});
