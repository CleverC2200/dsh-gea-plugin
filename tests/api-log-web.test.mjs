import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { profile } from "./profile.mjs";

test(
  "API log center lists real Host calls, redacts credentials and replays safe reads",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t);
    await app.login();
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1440, height: 900 },
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
    page.setDefaultTimeout(15000);
    await page.goto(app.origin);
    const notice = page.getByRole("dialog", { name: "内测声明", exact: true });
    try {
      await notice.waitFor({ state: "visible", timeout: 5000 });
      await notice.getByRole("button", { name: "继续", exact: true }).click();
    } catch {}
    await page.locator('iframe[data-gea-workbench]').contentFrame()
      .getByRole("heading", { name: "销售计划审批", exact: true })
      .waitFor();
    await page.locator('button[aria-label="账户菜单"]').evaluate((element) => element.click());
    await page.getByRole("menuitem", { name: "设置", exact: true }).click({ force: true });
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "接口日志", exact: true }).dispatchEvent("click");
    await page
      .getByRole("heading", { name: "接口日志中心", exact: true })
      .waitFor();
    await expect(settings).toHaveCount(0);
    assert.deepEqual(
      await page.locator(".AppFrame_sidebarCol, .AppFrame_rightbarCol").evaluateAll((elements) =>
        elements.map((element) => Math.round(element.getBoundingClientRect().width)),
      ),
      [0, 0],
    );

    await expect(
      page.getByText("24 个已登记接口", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => page.locator(".gea-api-catalog-item").count())
      .toBeGreaterThanOrEqual(20);
    assert.ok((await page.locator(".gea-api-call-row").count()) >= 3);
    const visibleText = await page.locator(".gea-api-log-center").innerText();
    assert.equal(visibleText.includes("fixture-gea-token"), false);
    assert.equal(visibleText.includes("fixture-delegation"), false);
    assert.equal(visibleText.includes("[已脱敏]"), true);

    await page
      .locator(".gea-api-catalog-item")
      .filter({ hasText: "读取当前用户" })
      .click();
    const profileCall = page.locator(".gea-api-call-row").first();
    await expect(profileCall).toContainText("读取当前用户");
    await profileCall.click();
    await expect(
      page.getByText("查看接口定义与请求字段", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "重发请求", exact: true }).click();
    await expect(page.locator(".gea-api-replayed")).toHaveCount(1);
    assert.ok(
      app.requests.filter((request) =>
        request.url.pathname.endsWith("/getUserInfo"),
      ).length >= 2,
    );

    await mkdir(".impeccable/review", { recursive: true });
    await page.screenshot({
      path: ".impeccable/review/desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".gea-api-log-center")).toBeVisible();
    await page.screenshot({
      path: ".impeccable/review/mobile.png",
      fullPage: true,
    });
    await page.locator(".gea-api-call-row").nth(1).click();
    await expect(page.locator(".gea-api-detail")).toBeInViewport();
    await page.screenshot({
      path: ".impeccable/review/mobile-detail.png",
    });
    assert.deepEqual(errors, []);
  },
);
