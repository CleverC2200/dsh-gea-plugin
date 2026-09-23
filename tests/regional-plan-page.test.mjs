import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

test(
  "区域计划工作台 is its own menu page and the approval page drops the evaluation switch",
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
      .getByRole("dialog", { name: "内测声明", exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();

    // 独立的菜单页：内嵌业务原型，不依赖 GEA 登录或业务接口。
    // 侧栏用的是原型目录里的名字（保留「开发中」标记），页面标题才是「区域计划工作台」。
    await page.locator('[data-gea-business-entry="gea-regional-plan"]').click();
    const prototype = page.frameLocator("iframe[title='区域计划工作台']");
    await expect(
      prototype.getByRole("heading", { name: /区域计划工作台/ }),
    ).toBeVisible();
    await expect(prototype.getByText("计划事件线").first()).toBeVisible();
    await expect(
      prototype.getByRole("button", { name: "总览", exact: true }),
    ).toBeVisible();

    // 单据类型切换（月初/纠偏）按业务方反馈收起（2026-09-23），审批页只做月度计划；
    // 不能出现「区域计划评估」这排工作台页签。
    await page.getByRole("button", { name: "销售计划", exact: true }).click();
    const workbench = page.frameLocator("iframe[data-gea-workbench]");
    const header = workbench.locator("header").first();
    await expect(
      workbench.getByRole("heading", { name: "销售计划审批", exact: true }),
    ).toBeVisible();
    await expect(header.getByRole("tab", { name: "月初", exact: true })).toHaveCount(0);
    await expect(
      workbench.getByRole("tab", { name: "区域计划评估", exact: true }),
    ).toHaveCount(0);
    // 已登录时工作台必须落在中间列里；一旦铺上整屏登录遮罩，切面板就会整屏闪一下。
    const workbenchFrame = page.locator("iframe[data-gea-workbench]");
    await expect(workbenchFrame).not.toHaveClass(/gea-login-frame/);
    const box = await workbenchFrame.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(
      box.width < viewport.width * 0.9,
      `workbench frame must stay inside the center column, got ${box.width} of ${viewport.width}`,
    );
    assert.ok(true);
  },
);
