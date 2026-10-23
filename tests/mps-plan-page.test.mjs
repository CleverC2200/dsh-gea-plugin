import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import {
  openBusinessPage,
  openRegisteredWorkbenchPage,
  prepareWorkbenchPageAccess,
  htmlFrameElement,
} from "./fixtures/business-page.mjs";

test(
  "registered 主生产计划（MPS） page reuses its assistant and preserves the Core Session",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      beforeStart: prepareWorkbenchPageAccess([["plan-category-production", "主生产计划（MPS）"]]),
      config: (base) => ({
        environment: "test",
        geaEnvironments: {
          production: base + "/production",
          test: base + "/test",
        },
      }),
    });
    assert.equal((await app.login()).ok, true);
    const status = await app.rpc("status");
    assert.equal(status.ok, true);
    assert.equal(status.value.authenticated, true);
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

    const entry = page.locator('[data-gea-business-entry="plan-category-production"]');
    await openRegisteredWorkbenchPage(page, "主生产计划（MPS）");
    await expect(entry).toHaveCount(0);
    await page
      .locator(".agent-workbench-document")
      .getByRole("button", { name: "新建对话", exact: true })
      .click();
    const prototype = htmlFrameElement(page, "plan-category-production").contentFrame();
    await expect(prototype.getByRole("heading", { name: "需求确认", exact: true })).toBeVisible();
    for (const name of ["计划提报数据", "模型双期预测", "历史同期发货"]) {
      await expect(prototype.getByRole("region", { name, exact: true })).toBeVisible();
    }
    // 原型自带的数字人会话列关掉，会话只留外壳右侧这一个。
    await expect(prototype.locator("aside.ap-dock")).toBeHidden();
    // 右侧会话区跟着这一页换成「主计划参谋」。
    await expect(page.getByText("主生产计划Agent").first()).toBeVisible();
    const sessionContent = page
      .locator(".agent-workbench-document:visible")
      .locator('[data-conversation-content=""]');
    await expect(sessionContent).toHaveAttribute(
      "data-conversation-session",
      /^session-[0-9a-f-]{36}$/,
    );
    const sessionId = await sessionContent.getAttribute("data-conversation-session");
    const selected = await app.remote("session/projections", { sessionId });
    assert.equal(selected.ok, true);
    assert.ok(selected.value, "the MPS page must use a real Core Session");
    assert.equal(selected.value.values.agentPreset, "gea-html-inventory-mps");
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
    await openBusinessPage(page, "gea-regional-plan");
    const regionalFrame = htmlFrameElement(page, "gea-regional-plan");
    await expect(regionalFrame).toBeVisible();
    await expect(frame).toBeHidden();
    await openRegisteredWorkbenchPage(page, "主生产计划（MPS）");
    await expect(frame).toBeVisible();
    await expect(regionalFrame).toBeHidden();
    await expect(sessionContent).toHaveAttribute("data-conversation-session", sessionId);
    const restored = await app.remote("session/projections", { sessionId });
    assert.equal(restored.ok, true);
    assert.ok(restored.value, "returning to the MPS page must retain its Core Session");
    assert.equal(restored.value.values.agentPreset, "gea-html-inventory-mps");
  },
);
