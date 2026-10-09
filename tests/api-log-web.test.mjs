import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { profile } from "./profile.mjs";
import { openSalesPlan, openWorkbenchPage } from "./fixtures/business-page.mjs";

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
    const before = await page.locator("[data-shell-bottom]").evaluate((bottom) => {
      const frame = bottom.parentElement;
      return {
        sidebar: Number.parseFloat(getComputedStyle(frame).gridTemplateColumns),
        sidebarCollapsed: frame.getAttribute("data-sidebar-collapsed"),
      };
    });
    assert.deepEqual(before, { sidebar: 280, sidebarCollapsed: null });
    await openWorkbenchPage(page, "接口日志");
    await page.getByRole("heading", { name: "接口日志中心", exact: true }).waitFor();
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
    // Core's ordinary Web main retains navigation; the retired fullscreen assertion is frozen at a429.
    assert.deepEqual(
      [layout.columns[0], layout.columns[2]],
      [before.sidebar, 0],
      JSON.stringify(layout),
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
    const visibleText = await page.locator(".gea-api-log-center").innerText();
    assert.equal(visibleText.includes("fixture-gea-token"), false);
    assert.equal(visibleText.includes("fixture-delegation"), false);
    assert.equal(visibleText.includes("[已脱敏]"), true);

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

    await mkdir(".runtime/api-log-evidence", { recursive: true });
    await page.screenshot({
      path: ".runtime/api-log-evidence/desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".gea-api-log-center")).toBeVisible();
    await page.screenshot({
      path: ".runtime/api-log-evidence/mobile.png",
      fullPage: true,
    });
    await page.locator(".gea-api-call-row").nth(1).click();
    await expect(page.locator(".gea-api-detail")).toBeInViewport();
    await page.screenshot({
      path: ".runtime/api-log-evidence/mobile-detail.png",
    });
    assert.deepEqual(errors, []);
  },
);
