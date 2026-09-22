import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

test(
  "会话统计胶囊排在输入框上方，输入框贴住面板底部",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        environment: "test",
        geaEnvironments: { production: base + "/production", test: base + "/test" },
      }),
    });
    const browser = await chromium.launch({ channel: "chrome", headless: true });
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
    await page
      .getByRole("dialog", { name: "内测声明", exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    const frame = page.frameLocator("iframe[data-gea-workbench]");
    await frame.getByRole("button", { name: "刷新二维码", exact: true }).waitFor();
    allowLogin = true;
    await frame
      .getByRole("heading", { name: "销售计划审批", exact: true })
      .waitFor();

    // 发一条消息，让会话出现「N 轮 M 步」统计胶囊。
    const composer = page.locator('[contenteditable="true"], textarea').first();
    await composer.waitFor();
    await composer.click();
    await composer.fill("你好");
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => Boolean(document.querySelector('[class*="bOPqQW_root"]'))),
      )
      .toBe(true);

    const boxes = await page.evaluate(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
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
        stats: rect('[class*="bOPqQW_root"]'),
        card: rect('[class*="uV2eYG_card"]'),
        seat: rect('[class*="wSkVaW_composerSeat"]'),
      };
    });
    assert.ok(boxes.stats && boxes.card && boxes.seat, JSON.stringify(boxes));
    // 统计胶囊在输入框上方，并且左右对齐同一栏。
    assert.ok(
      boxes.stats.bottom <= boxes.card.top,
      `统计胶囊必须在输入框上方: ${JSON.stringify(boxes)}`,
    );
    assert.equal(boxes.stats.left, boxes.card.left);
    assert.equal(boxes.stats.right, boxes.card.right);
    // 输入框贴住面板底部：底部只留原生的一点点内边距。
    assert.ok(
      boxes.seat.bottom - boxes.card.bottom <= 12,
      `输入框必须贴底: ${JSON.stringify(boxes)}`,
    );

    // 登记 37：调整工作台宽度时，宿主右栏的分隔线不能继续压进对话框输入区。
    const railBoundary = await page.evaluate(() => {
      const rail = document.querySelector(".AppFrame_rightbarCol");
      const seat = document.querySelector("[data-composer-seat]");
      if (!rail || !seat) return null;
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
    assert.equal(railBoundary.borderLeftWidth, "0px", JSON.stringify(railBoundary));
    assert.equal(railBoundary.seatLeft, railBoundary.railLeft, JSON.stringify(railBoundary));
  },
);
