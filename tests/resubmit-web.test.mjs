import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

test(
  "returned plans open real-source quantity editing while disconnected submission stays disabled",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    const plan = {
      planId: "p-jxs-2026-10-00001",
      versionId: "v1",
      seq: 1,
      periodId: "123",
      planTypeCode: "Y",
      orderType: "M",
      dealerCode: "456",
      status: 6,
      currentQty: "1",
      targetQty: "1",
      currentAmount: "12.34",
      targetAmount: "12.34",
      baseName: "Fixture",
      orgCode: "org",
      orgName: "Returned plan",
      skuCount: 1,
    };
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path.endsWith("/periods")) {
        reply({
          success: true,
          result: {
            records: [
              {
                periodId: "123",
                periodMonth: "2026-10",
                planTypeCode: "Y",
                status: "OPEN",
              },
            ],
            total: 1,
            pages: 1,
            current: 1,
            size: 100,
          },
        });
        return true;
      }
      if (path.endsWith("/plans")) {
        reply({
          success: true,
          result: { records: [plan], total: 1, pages: 1, current: 1, size: 20 },
        });
        return true;
      }
      if (path.endsWith("/plans/" + plan.planId)) {
        reply({
          success: true,
          result: {
            currentVersion: { ...plan, id: "v1", effective: true },
            skus: [],
            versions: [],
            logs: [],
          },
        });
        return true;
      }
      if (path.endsWith("/versions")) {
        reply({
          success: true,
          result: [{ ...plan, id: "v1", effective: true }],
        });
        return true;
      }
      if (path.endsWith("/versions/v1/skus")) {
        reply({
          success: true,
          result: [
            {
              id: "sku",
              versionId: "v1",
              skuCode: "789",
              productCategName: "Fixture SKU",
              baseQty: "1",
              qty: "1",
              price: "12.34",
              amt: "12.34",
              amtBase: "12.34",
            },
          ],
        });
        return true;
      }
    });
    await app.login();
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
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: "内测声明", exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    const frame = page.frameLocator("iframe[data-gea-workbench]");
    await frame.getByRole("tab", { name: "按基地", exact: true }).click();
    await frame.locator("tbody label.arco-checkbox").first().click();
    await frame.getByRole("button", { name: "重提", exact: true }).click();
    const dialog = frame.getByRole("dialog", {
      name: "真实销售计划退回重提",
      exact: true,
    });
    const quantity = dialog.getByRole("textbox", {
      name: "提报数量 789",
      exact: true,
    });
    await quantity.fill("2.000");
    await expect(dialog).toContainText("24.68");
    await expect(dialog).toContainText("重提目标状态: 1");
    await dialog.locator("label.arco-checkbox").click();
    await expect(dialog.getByRole("checkbox")).toBeChecked();
    await expect(
      dialog.getByRole("button", { name: "确认重提", exact: true }),
    ).toBeDisabled();
    await expect(dialog).toContainText("当前环境的服务凭据或用户授权未就绪");
    assert.equal(
      app.requests.some(
        (r) =>
          r.method === "POST" &&
          r.url.pathname.includes("/internal/sales-plans"),
      ),
      false,
    );
  },
);
