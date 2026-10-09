import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";

test(
  "会话统计胶囊位于输入卡下方，完整seat贴底且工作台分隔线不侵入输入区",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        environment: "test",
        analysis: { mode: "receipt" },
        geaEnvironments: { production: base + "/production", test: base + "/test" },
      }),
    });
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1536, height: 920 },
    });
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(25000);
    // 夹具默认让登录轮询停在 pending；二维码出现后放行一次，把登录走完。
    let allowLogin = false;
    await page.route("**/api/gea-proof/login/poll", (route) =>
      allowLogin
        ? route.continue()
        : route.fulfill({ json: { ok: true, value: { status: "pending" } } }),
    );
    await page.goto(app.origin);
    const frame = await openSalesPlan(page);
    await frame.getByRole("button", { name: "刷新二维码", exact: true }).waitFor();
    allowLogin = true;
    await frame.getByRole("heading", { name: "销售计划审批", exact: true }).waitFor();

    // 本地 receipt 不调用模型；通过公开模型菜单选择它，再让实际会话生成统计。
    const conversation = page.getByRole("complementary", { name: "AI对话", exact: true });
    await expect(conversation).toBeVisible();
    await page.getByRole("button", { name: /^选择模型，当前/ }).click();
    await page.getByRole("menuitem", { name: /^模型/ }).click();
    await page.getByRole("menuitemradio", { name: /Local receipt \/ 本地验证回执/ }).click();
    const composer = conversation.locator('[contenteditable="true"], textarea').first();
    await composer.waitFor();
    await composer.click();
    await composer.fill("你好");
    await page.keyboard.press("Enter");
    const stats = conversation.locator("[data-composer-stat=activity]");
    await expect(stats).toBeVisible();
    await expect(stats).toContainText(/1\s*轮.*1\s*步/);

    const boxes = await conversation.evaluate((root) => {
      const rect = (selector) => {
        const element = root.querySelector(selector);
        if (!element) return null;
        const value = element.getBoundingClientRect();
        return {
          top: Math.round(value.top),
          bottom: Math.round(value.bottom),
          left: Math.round(value.left),
          right: Math.round(value.right),
        };
      };
      return {
        stats: rect("[data-composer-stat=activity]"),
        card: rect("[data-composer-card]"),
        seat: rect("[data-composer-seat]"),
      };
    });
    assert.ok(boxes.stats && boxes.card && boxes.seat, JSON.stringify(boxes));
    // 当前 Core dock 在输入卡下方；保留同一对话列内的精确中心线约束。
    assert.ok(
      boxes.stats.top >= boxes.card.bottom,
      `统计胶囊必须在输入卡下方: ${JSON.stringify(boxes)}`,
    );
    const leftInset = boxes.stats.left - boxes.card.left;
    const rightInset = boxes.card.right - boxes.stats.right;
    assert.equal(leftInset, rightInset, "统计与输入卡应保持相同中心线");
    assert.ok(leftInset >= 0 && rightInset >= 0, JSON.stringify(boxes));
    // 下方 dock 属于完整输入 seat；底部仍保留原 12px 上界。
    assert.ok(
      boxes.seat.bottom - boxes.stats.bottom <= 12,
      `完整输入seat必须贴底: ${JSON.stringify(boxes)}`,
    );

    // 登记 37：调整工作台宽度时，宿主右栏的分隔线不能继续压进对话框输入区。
    const railBoundary = await conversation.evaluate((rail) => {
      const seat = rail.querySelector("[data-composer-seat]");
      if (!seat) return null;
      const railBox = rail.getBoundingClientRect();
      const seatBox = seat.getBoundingClientRect();
      const style = getComputedStyle(rail);
      return {
        railLeft: Math.round(railBox.left),
        seatLeft: Math.round(seatBox.left),
        borderLeftWidth: style.borderLeftWidth,
      };
    });
    assert.ok(railBoundary, "右侧对话栏和输入区必须存在");
    // 当前 split 边界由公开「AI对话」列持有，Core inspector 不是这条线的所有者。
    // 原 1px 分隔线必须存在，原生输入 seat 的内边距不能使它侵入这条线。
    assert.equal(railBoundary.borderLeftWidth, "1px", JSON.stringify(railBoundary));
    assert.equal(railBoundary.seatLeft, railBoundary.railLeft + 1, JSON.stringify(railBoundary));
  },
);
