import { openSalesPlan, openWorkbenchPage } from "./fixtures/business-page.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { profile } from "./profile.mjs";

test(
  "API log center lists real Host calls, redacts credentials and replays safe reads",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t);
    await app.login();
    const browser = await chromium.launch({
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
    const frame = await openSalesPlan(page);
    await frame.getByRole("heading", { name: "销售计划审批", exact: true }).waitFor();
    const before = await page.locator("[data-rightbar-col]").evaluate((column) => {
      const frame = column.parentElement;
      return {
        sidebar: Number.parseFloat(getComputedStyle(frame).gridTemplateColumns),
        sidebarCollapsed: frame.getAttribute("data-sidebar-collapsed"),
      };
    });
    assert.deepEqual(before, { sidebar: 280, sidebarCollapsed: null });
    await page.locator('button[aria-label="账户菜单"]').evaluate((element) => element.click());
    await page.getByRole("menuitem", { name: "设置", exact: true }).click({ force: true });
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "关闭", exact: true }).click();
    await openWorkbenchPage(page, "接口日志");
    await page.getByRole("heading", { name: "接口日志中心", exact: true }).waitFor();
    await expect(settings).toHaveCount(0);
    const layout = await page.locator(".gea-api-log-center").evaluate((center) => {
      const frame = center.closest("[data-rightbar-collapsed]");
      if (!frame) throw Error("Current Core frame must expose its rightbar state");
      const columns = getComputedStyle(frame)
        .gridTemplateColumns.split(/\s+/)
        .map(Number.parseFloat);
      const frameBox = frame.getBoundingClientRect(),
        centerBox = center.getBoundingClientRect();
      return {
        columns,
        sidebarCollapsed: frame.getAttribute("data-sidebar-collapsed"),
        rightbarCollapsed: frame.getAttribute("data-rightbar-collapsed"),
        frame: { left: frameBox.left, right: frameBox.right, width: frameBox.width },
        center: { left: centerBox.left, right: centerBox.right, width: centerBox.width },
      };
    });
    assert.equal(layout.columns.length, 3, JSON.stringify(layout));
    // 公共 main 面板保留 Core 默认导航栏，不隐藏宿主框架。
    assert.deepEqual(
      await page
        .locator('[class*="sidebarCol"], [data-rightbar-col]')
        .evaluateAll((elements) =>
          elements.map((element) => Math.round(element.getBoundingClientRect().width)),
        ),
      [280, 0],
    );
    assert.equal(layout.sidebarCollapsed, before.sidebarCollapsed, JSON.stringify(layout));
    assert.equal(layout.rightbarCollapsed, "true", JSON.stringify(layout));
    assert.equal(layout.center.left, layout.frame.left + before.sidebar, JSON.stringify(layout));
    assert.equal(layout.center.width, layout.frame.width - before.sidebar, JSON.stringify(layout));
    assert.equal(layout.columns[1], layout.center.width, JSON.stringify(layout));
    assert.equal(layout.center.right, layout.frame.right, JSON.stringify(layout));

    await expect
      .poll(() => page.locator(".gea-api-catalog-item").count())
      .toBeGreaterThanOrEqual(20);
    await expect(
      page.getByText(
        `${await page.locator(".gea-api-catalog-scroll .gea-api-catalog-item").count()} 个已登记接口`,
        { exact: true },
      ),
    ).toBeVisible();
    assert.ok((await page.locator(".gea-api-call-row").count()) >= 3);
    await page.getByText("请求头与 Query · 已脱敏", { exact: true }).click();
    const visibleText = await page.locator(".gea-api-log-center").innerText();
    assert.equal(visibleText.includes("fixture-gea-token"), false);
    assert.equal(visibleText.includes("fixture-delegation"), false);
    assert.equal(visibleText.includes("[已脱敏]"), true, visibleText);

    await page.locator(".gea-api-catalog-item").filter({ hasText: "读取当前用户" }).click();
    const profileCall = page.locator(".gea-api-call-row").first();
    await expect(profileCall).toContainText("读取当前用户");
    await profileCall.click();
    await expect(page.getByText("查看接口定义与请求字段", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重发请求", exact: true }).click();
    await expect(page.locator(".gea-api-replayed")).toHaveCount(1);
    assert.ok(
      app.requests.filter((request) => request.url.pathname.endsWith("/getUserInfo")).length >= 2,
    );

    const readsBeforeBatch = app.requests.filter((request) =>
      request.url.pathname.endsWith("/getUserInfo"),
    ).length;
    await page.getByRole("button", { name: "批量", exact: true }).click();
    await page.getByRole("checkbox", { name: "选择读取当前用户", exact: true }).check();
    await page.getByRole("button", { name: "开始批量重发", exact: true }).click();
    await page.getByRole("button", { name: "确认批量重发", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("批量已结束");
    await expect
      .poll(
        () =>
          app.requests.filter((request) => request.url.pathname.endsWith("/getUserInfo")).length,
      )
      .toBe(readsBeforeBatch + 1);
    await expect(page.getByRole("combobox", { name: "选择重发批次", exact: true })).toBeVisible();

    await mkdir(".scratch", { recursive: true });
    const screenshots = await mkdtemp(resolve(".scratch/api-log-review-"));
    t.diagnostic(`API log screenshots: ${screenshots}`);
    await page.screenshot({
      path: join(screenshots, "desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".gea-api-log-center")).toBeVisible();
    await page.screenshot({
      path: join(screenshots, "mobile.png"),
      fullPage: true,
    });
    await page.locator(".gea-api-call-row").nth(1).click();
    await expect(page.locator(".gea-api-detail")).toBeInViewport();
    await page.screenshot({
      path: join(screenshots, "mobile-detail.png"),
    });
    assert.deepEqual(errors, []);
  },
);
