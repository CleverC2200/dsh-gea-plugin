import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { profile } from "./profile.mjs";

test(
  "the real Web page previews a selection and opens its durable receipt",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1440, height: 1000 },
    });
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.origin);
    await page.getByText("GEA 销售计划", { exact: true }).waitFor();
    await page.getByRole("button", { name: "继续", exact: true }).click();
    page.setDefaultTimeout(10000);
    await page.getByText("GEA 销售计划", { exact: true }).click();
    await page
      .getByRole("button", { name: "飞书扫码登录", exact: true })
      .click();
    await page.getByText("已登录：测试用户", { exact: true }).waitFor();
    await page.getByRole("button", { name: "查询计划", exact: true }).click();
    await page
      .getByRole("radio", { name: "选择 9007199254740993", exact: true })
      .waitFor();
    await page
      .getByRole("heading", { name: "销售计划审批", exact: true })
      .waitFor();
    await page
      .getByRole("group", { name: "组织视图", exact: true })
      .getByRole("button", { name: "按基地", exact: true })
      .waitFor();
    await page
      .getByRole("heading", { name: "需求预测 Agent", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "需求预测 Agent", exact: true })
      .waitFor();
    const rail = page.locator('[data-rail="forecast"]');
    await rail.waitFor();
    assert.equal(await rail.getAttribute("data-rail-availability"), "native-host-pending");
    assert.equal(await rail.locator("textarea").count(), 0);
    await page
      .getByText("暂不可操作：当前仅展示 GEA 数据，审批和写回接口尚未接入。", {
        exact: true,
      })
      .waitFor();
    await page
      .getByRole("group", { name: "组织视图", exact: true })
      .getByRole("button", { name: "按基地", exact: true })
      .click();
    const organizationSelect = page.getByRole("combobox", { name: "组织值", exact: true });
    await organizationSelect.waitFor();
    assert.equal(await organizationSelect.inputValue(), "华东");
    assert.equal(
      await page.getByRole("button", { name: "发送到 dsh 会话", exact: true }).isDisabled(),
      true,
    );
    await page
      .getByText("只读预览 · 不执行审批写回", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "预览发送范围", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "确认会话输入", exact: true })
      .waitFor();
    await mkdir(".runtime/web-evidence", { recursive: true });
    await page.screenshot({ path: ".runtime/web-evidence/desktop.png" });
    await page.setViewportSize({ width: 700, height: 900 });
    await page.screenshot({ path: ".runtime/web-evidence/narrow.png" });
    await page
      .getByRole("button", { name: "确认并验证传递", exact: true })
      .click();
    await page
      .getByText("本地验证回执（非 AI 分析）：快照已进入 dsh 模型请求。", {
        exact: false,
      })
      .waitFor();
    assert.deepEqual(errors, []);
  },
);
