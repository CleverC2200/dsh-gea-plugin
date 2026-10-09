import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openBusinessPage, htmlFrameElement } from "./fixtures/business-page.mjs";

test(
  "主生产计划（MPS） is its own menu page and reuses the 主计划参谋 assistant",
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
    page.setDefaultTimeout(15000);
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: /内测声明|预览版说明/, exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();

    // 「主生产计划（MPS）(开发中)」不再是灰色占位，而是挂了「月计划协调数字人」原型的可点页面。
    const entry = page.locator('[data-gea-business-entry="plan-category-production"]');
    await openBusinessPage(page, "plan-category-production");
    await expect(entry).toBeEnabled();
    await page
      .locator(".agent-workbench-document")
      .getByRole("button", { name: "新建对话", exact: true })
      .click();
    const prototype = htmlFrameElement(page, "plan-category-production").contentFrame();
    await expect(prototype.getByText("需求确认").first()).toBeVisible();
    await expect(prototype.getByText("三路数据").first()).toBeVisible();
    // 原型自带的数字人会话列关掉，会话只留外壳右侧这一个。
    await expect(prototype.locator("aside.ap-dock")).toBeHidden();
    // 右侧会话区跟着这一页换成「主计划参谋」。
    await expect(page.getByText("主生产计划Agent").first()).toBeVisible();
    // 已登录时工作台必须落在中间列里，不能铺成整屏登录遮罩。
    const frame = htmlFrameElement(page, "plan-category-production");
    await expect(frame).not.toHaveClass(/gea-login-frame/);
    const box = await frame.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(
      box.width < viewport.width * 0.9,
      `workbench frame must stay inside the center column, got ${box.width} of ${viewport.width}`,
    );
    // 右栏和产销协同等工作台页共用同一套业务页布局：DSH 原生欢迎区的品牌块
    // （鲸鱼「探索未至之境」）和「工作区 / Agent 预设」选择器都要让开，否则主计划页会退回原生落地页样式。
    await expect(page.locator(".agent-workbench-document")).toBeVisible();
    await expect(page.locator(".agent-workbench-native-conversation")).toHaveCount(1);
    const conversation = page.locator(".agent-workbench-native-conversation");
    await expect(conversation.getByText("探索未至之境").first()).toBeHidden();
    await expect(conversation.getByText("workspace", { exact: true }).first()).toBeHidden();
    // 欢迎区里已经有助手名片，右栏顶部不再重复一行「主计划参谋」标题。
    await expect(page.locator(".agent-workbench-native-conversation .gea-agent-head")).toHaveCount(
      0,
    );
  },
);
