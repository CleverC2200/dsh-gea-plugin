import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { profile } from "./profile.mjs";

const plan = {
  planId: "9007199254740993",
  versionId: "version-1",
  seq: 1,
  periodId: "period-1",
  planTypeCode: "Y",
  dealerCode: "dealer-a",
  status: 1,
  currentQty: "26445.000",
  targetQty: "26445.000",
  currentAmount: "2064404.28",
  targetAmount: "1539999.99",
  baseName: "华东",
  orgName: "上海网点经销组",
  orgCode: "org-a",
  provinceName: "浙江经销业务",
  provinceCode: "province-a",
  skuCount: 1,
};

test(
  "workbench login, brand switching, avatar settings and responsive layout use the current shell",
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

    app.route((request, res, reply) => {
      const path = request.url.pathname;
      const task = {
        id: "task",
        approval: {
          biz_key: `sales-plan:version:${plan.versionId}`,
          instance_id: "instance",
          actionable: true,
        },
      };
      if (path.endsWith("/notifications")) {
        reply({ success: true, result: { items: [task], total: 1 } });
        return true;
      }
      if (path.endsWith("/notifications/task")) {
        reply({ success: true, result: task });
        return true;
      }
      if (path.endsWith("/plans")) {
        const status = request.url.searchParams.get("status");
        const records = status === null || status === "1" ? [plan] : [];
        reply({
          success: true,
          result: {
            records,
            total: records.length,
            pages: 1,
            current: 1,
            size: 20,
          },
        });
        return true;
      }
      if (path.endsWith("/plans/" + plan.planId)) {
        reply({
          success: true,
          result: {
            currentVersion: { ...plan, id: plan.versionId, effective: true },
            versions: [{ ...plan, id: plan.versionId }],
            skus: [],
            logs: [],
          },
        });
        return true;
      }
      if (path.endsWith("/versions")) {
        reply({ success: true, result: [{ ...plan, id: plan.versionId }] });
        return true;
      }
      return false;
    });
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
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
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(15000);
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
    try {
      await frame
        .getByRole("button", { name: "刷新二维码", exact: true })
        .waitFor();
      await frame.locator(".gea-login-qr img").waitFor();
      await frame.getByRole("radio", { name: "测试", exact: true }).waitFor();
      assert.equal(
        await frame
          .getByRole("radio", { name: "测试", exact: true })
          .isChecked(),
        true,
      );
      assert.equal(
        await frame.locator('input[type="url"], input[type="text"]').count(),
        0,
      );
      assert.equal(await page.locator('[contenteditable="true"]').count(), 0);
      const loginBounds = await page
        .locator("iframe[data-gea-workbench]")
        .boundingBox();
      assert.deepEqual(loginBounds, { x: 0, y: 0, width: 1536, height: 920 });
      await mkdir(".runtime/web-evidence", { recursive: true });
      await page.screenshot({
        path: ".runtime/web-evidence/login-desktop.png",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: ".runtime/web-evidence/login-mobile.png" });
      await page.setViewportSize({ width: 1536, height: 920 });
      await frame.getByRole("radio", { name: "正式", exact: true }).check();
      await frame
        .getByRole("button", { name: "刷新二维码", exact: true })
        .waitFor();
      await frame.getByRole("radio", { name: "测试", exact: true }).check();
      await frame.locator(".gea-login-qr img").waitFor();
      allowLogin = true;
      await frame
        .getByRole("heading", { name: "销售计划审批", exact: true })
        .waitFor();
      await frame.getByText("华东", { exact: true }).first().waitFor();
      await page
        .getByRole("navigation", { name: "业务导航", exact: true })
        .waitFor();
      assert.equal(await page.locator(".gea-agent-panel").count(), 0);
      assert.equal(await frame.locator("textarea").count(), 0);
      const bounds = await page
        .locator("iframe[data-gea-workbench]")
        .boundingBox();
      assert.ok(bounds.x > 200 && bounds.width < 1100, JSON.stringify(bounds));
      await frame.getByRole("tab", { name: "按基地", exact: true }).click();
      await frame.locator("tbody label.arco-checkbox").first().click();
      const approve = frame.getByRole("button", { name: "通过", exact: true });
      const reject = frame.getByRole("button", { name: "退回", exact: true });
      await expect(approve).toBeEnabled();
      await expect(reject).toBeEnabled();
      await approve.click();
      const approvalDialog = frame.getByRole("dialog");
      await approvalDialog.getByText("业务校验摘要", { exact: true }).waitFor();
      await approvalDialog
        .getByRole("button", { name: "关闭", exact: true })
        .click();
      const provinceStage = frame.getByRole("button", {
        name: /省区审批.*进度/,
      });
      await provinceStage.click();
      await expect(provinceStage).toHaveAttribute("aria-pressed", "true");
      await expect(approve).toBeDisabled();
      await provinceStage.click();
      await expect(provinceStage).toHaveAttribute("aria-pressed", "false");
      assert.equal(
        app.requests.some(
          (r) => r.method === "POST" && r.url.pathname.endsWith("/actions"),
        ),
        false,
      );

      assert.equal(
        await frame
          .getByRole("combobox", { name: "分析范围", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await frame
          .getByRole("button", { name: "预览发送范围", exact: true })
          .count(),
        0,
      );
      const brand = page.locator(".gea-brand-switch");
      assert.equal(
        await page
          .locator(".gea-shell-logo")
          .evaluate((el) => getComputedStyle(el).backgroundColor),
        "rgb(237, 0, 0)",
      );
      assert.equal(
        await page
          .locator(".gea-user-avatar")
          .evaluate((el) => getComputedStyle(el).borderRadius),
        "50%",
      );
      for (let view = 0; view < 2; view++) {
        await page.getByRole("button", { name: "设置", exact: true }).click();
        await page
          .getByRole("button", { name: "通用设置", exact: true })
          .waitFor();
        await page.getByRole("button", { name: "关闭", exact: true }).click();
        await brand.click();
        await page
          .locator("iframe[data-gea-workbench]")
          .waitFor({ state: view === 0 ? "detached" : "visible" });
      }
      assert.equal(
        await page
          .getByRole("button", { name: "DSH 对话", exact: true })
          .count(),
        0,
      );
      await page.reload();
      await frame
        .getByRole("heading", { name: "销售计划审批", exact: true })
        .waitFor();
      await page.setViewportSize({ width: 700, height: 1000 });
      await page.locator('[data-conversation-stacked="true"]').waitFor();
      assert.equal(
        await page
          .locator('[data-conversation-stacked="true"]')
          .evaluate((element) => getComputedStyle(element).transitionDuration),
        "0s",
      );
      await frame
        .getByRole("heading", { name: "销售计划审批", exact: true })
        .waitFor();
      await page.getByText("选择一个工作区开始", { exact: true }).waitFor();
      const narrowFrame = await page
        .locator("iframe[data-gea-workbench]")
        .boundingBox();
      assert.ok(
        narrowFrame && narrowFrame.height > 150 && narrowFrame.width > 250,
        JSON.stringify(narrowFrame),
      );
      await page.screenshot({ path: ".runtime/web-evidence/narrow.png" });
      assert.deepEqual(errors, []);
    } catch (error) {
      await mkdir(".runtime/web-evidence", { recursive: true });
      await page.screenshot({ path: ".runtime/web-evidence/failure.png" });
      throw new Error(
        `${error.message}\nBrowser: ${errors.join("\n")}\nDOM: ${(await page.locator("body").innerText()).slice(0, 3000)}`,
      );
    }
  },
);
