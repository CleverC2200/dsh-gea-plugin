import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { profile } from "./profile.mjs";

const plan = {
  planId: "9007199254740993",
  versionId: "version-1",
  seq: 1,
  periodId: "period-1",
  planTypeCode: "Y",
  dealerCode: "dealer-a",
  status: 5,
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
  "original workbench document and native DSH conversation remain side by side through a durable receipt",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t);
    let oversizedDetails = false;
    app.route((request, res, reply) => {
      const path = request.url.pathname;
      if (path.endsWith("/plans")) {
        const status = request.url.searchParams.get("status");
        const records = status === null || status === "5" ? [plan] : [];
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
            skus: oversizedDetails
              ? Array.from({ length: 1500 }, (_, index) => ({
                  id: `sku-${index}`, versionId: plan.versionId,
                  skuCode: `code-${index}`, qty: "1.000", amt: "2.000",
                  materialDescription: "A long but valid product description for a complete detail snapshot",
                }))
              : [],
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
      app.cookie
        .split("; ")
        .map((pair) => ({
          name: pair.slice(0, pair.indexOf("=")),
          value: pair.slice(pair.indexOf("=") + 1),
          url: app.origin,
        })),
    );
    const page = await context.newPage();
    const errors = [];
    const preparationScopes = [];
    page.on("request", request => {
      if (request.url().endsWith("/api/gea-proof/workbench/prepare"))
        preparationScopes.push(request.postDataJSON().scope);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(15000);
    await page.goto(app.origin);
    const frame = page.frameLocator("iframe[data-gea-workbench]");
    try {
      await frame
        .getByRole("button", { name: "飞书扫码登录", exact: true })
        .waitFor();
      const continueButton = page.getByRole("button", {
        name: "继续",
        exact: true,
      });
      if (await continueButton.isVisible()) await continueButton.click();
      await frame
        .getByRole("button", { name: "飞书扫码登录", exact: true })
        .click();
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
      const analysisScope = frame.getByRole("combobox", { name: "分析范围", exact: true });
      assert.equal(await analysisScope.inputValue(), "summary");
      await frame
        .getByRole("button", { name: "预览发送范围", exact: true })
        .click();
      await frame.getByRole("button", { name: "确认并验证传递", exact: true }).waitFor();
      await analysisScope.selectOption("details");
      await frame.getByRole("button", { name: "确认并验证传递", exact: true }).waitFor({ state: "detached" });
      assert.equal(await frame.getByRole("button", { name: "确认并验证传递", exact: true }).count(), 0);
      oversizedDetails = true;
      await frame.getByRole("button", { name: "预览发送范围", exact: true }).click();
      await frame.getByRole("alert").filter({ hasText: "所选内容超出模型输入限制。" }).waitFor();
      const budgetMessage = await frame.getByRole("alert").filter({ hasText: "所选内容超出模型输入限制。" }).innerText();
      assert.equal(budgetMessage.includes("SNAPSHOT_TOO_LARGE"), false);
      assert.equal(await frame.getByRole("button", { name: "确认并验证传递", exact: true }).count(), 0);
      oversizedDetails = false;
      await frame.getByRole("button", { name: "预览发送范围", exact: true }).click();
      await frame.getByRole("button", { name: "确认并验证传递", exact: true }).waitFor();
      await analysisScope.selectOption("summary");
      await frame.getByRole("button", { name: "确认并验证传递", exact: true }).waitFor({ state: "detached" });
      assert.equal(await frame.getByRole("button", { name: "确认并验证传递", exact: true }).count(), 0);
      await frame.getByRole("button", { name: "预览发送范围", exact: true }).click();
      await frame
        .getByRole("button", { name: "确认并验证传递", exact: true })
        .click();
      assert.deepEqual(preparationScopes, ["summary", "details", "details", "summary"]);
      await page
        .getByText("本地验证回执（非 AI 分析）：快照已进入 dsh 模型请求。", {
          exact: false,
        })
        .waitFor();
      await frame
        .getByRole("heading", { name: "销售计划审批", exact: true })
        .waitFor();
      const reply = await page
        .getByText("本地验证回执（非 AI 分析）：快照已进入 dsh 模型请求。", {
          exact: false,
        })
        .first()
        .boundingBox();
      assert.ok(
        reply.x >= bounds.x + bounds.width - 2,
        JSON.stringify({ bounds, reply }),
      );
      await mkdir(".runtime/web-evidence", { recursive: true });
      await page.screenshot({ path: ".runtime/web-evidence/desktop.png" });
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
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.waitFor();
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
