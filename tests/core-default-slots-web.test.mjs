import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

test(
  "native core without GEA preserves its default sidebar, welcome and header",
  { skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 60000 },
  async (t) => {
    const app = await profile(t, { coreOnly: true });
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ locale: "zh-CN" });
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const page = await context.newPage();
    await page.goto(app.origin);
    const preview = page.getByRole("dialog", { name: /内测声明|预览版说明/ });
    if (await preview.count())
      await preview.getByRole("button", { name: "继续", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "新建会话", exact: true }).filter({ hasText: "新会话" }),
    ).toBeVisible();
    await expect(page.getByText("探索未至之境", { exact: true })).toBeVisible();
    await expect(page.locator("[data-conversation-header-leading]")).toBeAttached();
    assert.equal(await page.locator(".gea-agent-welcome, .gea-sidebar-navigation").count(), 0);
  },
);
