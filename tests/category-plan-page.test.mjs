import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openBusinessPage, htmlFrameElement } from "./fixtures/business-page.mjs";

test(
  "品类计划工作台 is its own menu page and reuses the category plan assistant",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        environment: "test",
        geaEnvironments: {
          production: base + "/production",
          test: base + "/test",
        },
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
    page.setDefaultTimeout(15000);
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: /内测声明|预览版说明/, exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();

    // 目录里的「区域及品类计划工作台」不再是禁用占位，而是挂了原型的可点页面。
    const entry = page.locator('[data-gea-business-entry="plan-region-category"]');
    await openBusinessPage(page, "plan-region-category");
    await expect(entry).toBeEnabled();
    await page
      .locator(".agent-workbench-document")
      .getByRole("button", { name: "新建对话", exact: true })
      .click();
    const prototype = htmlFrameElement(page, "plan-region-category").contentFrame();
    // The author keeps this business heading visible beside the scope picker.
    const businessHeading = prototype.locator(".work > .work-head > .work-head-row > div > h2");
    await expect(businessHeading).toHaveCount(1);
    await expect(businessHeading).toHaveText("品类计划管理工作台");
    await expect(businessHeading).toBeVisible();
    await expect(prototype.getByText("品类计划指标监控").first()).toBeVisible();
    // 原型自带的那一列会话区要关掉，会话只留外壳右侧这一个。
    await expect(prototype.locator("aside.chat")).toBeHidden();
    // 右侧会话区跟着这一页换成品类计划助手。
    await expect(page.getByText("品类计划Agent").first()).toBeVisible();
    // 已登录时工作台必须落在中间列里，不能铺成整屏登录遮罩。
    const frame = htmlFrameElement(page, "plan-region-category");
    await expect(frame).not.toHaveClass(/gea-login-frame/);
    const box = await frame.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(
      box.width < viewport.width * 0.9,
      `workbench frame must stay inside the center column, got ${box.width} of ${viewport.width}`,
    );
  },
);
