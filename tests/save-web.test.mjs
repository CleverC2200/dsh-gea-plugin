import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

test(
  "server SAVE capability enables status 10 without legacy menu roles and verifies same-version persistence",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    let saved = false;
    let writes = 0;
    let log;
    const plan = {
      planId: "p",
      versionId: "v",
      seq: 1,
      periodId: "123",
      planTypeCode: "Y",
      orderType: "M",
      dealerCode: "456",
      status: 10,
      currentQty: "1",
      targetQty: "1",
      currentAmount: "12.34",
      targetAmount: "12.34",
      baseName: "Fixture",
      orgCode: "org",
      orgName: "Effective plan",
      skuCount: 1,
    };
    const item = () => ({
      id: "sku",
      versionId: "v",
      skuCode: "789",
      productCategName: "Fixture SKU",
      baseQty: "1",
      qty: "1",
      price: "12.34",
      amt: "12.34",
      amtBase: "12.34",
      categoryConfirmedQty: saved ? "2.000" : "1.000",
      categoryConfirmedAmount: saved ? "24.68" : "12.34",
    });
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
      if (path.endsWith("/plans/p")) {
        reply({
          success: true,
          result: {
            currentVersion: { ...plan, id: "v", effective: true },
            actionContext: {
              versionId: "v",
              status: 10,
              nodeOrder: 5,
              allowedActions: ["SAVE"],
              snapshotHash: (saved ? "b" : "a").repeat(64),
            },
            skus: [item()],
            versions: [],
            logs: log ? [log] : [],
          },
        });
        return true;
      }
      if (path.endsWith("/versions")) {
        reply({
          success: true,
          result: [{ ...plan, id: "v", effective: true }],
        });
        return true;
      }
      if (path.endsWith("/versions/v/skus")) {
        reply({ success: true, result: [item()] });
        return true;
      }
      if (path.endsWith("/versions/v/actions")) {
        const body = JSON.parse(req.body);
        assert.equal(body.action, "SAVE");
        assert.equal(body.expectedStatus, 10);
        assert.equal(body.expectedSnapshot, "a".repeat(64));
        assert.deepEqual(body.adjustments, [
          { skuCode: "789", adjustQty: "1.000" },
        ]);
        writes++;
        saved = true;
        log = {
          id: "1",
          planId: "p",
          versionId: "v",
          fromStatus: 10,
          toStatus: 10,
          actionCode: "SAVE",
          requestId: req.headers["x-request-id"],
          traceId: "trace",
        };
        reply({
          success: true,
          result: {
            planId: "p",
            versionId: "v",
            fromStatus: 10,
            toStatus: 10,
            replayed: false,
            requestId: log.requestId,
            traceId: "trace",
            auditId: "sales-plan-log:1",
          },
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
    const save = frame.getByRole("button", { name: "保存调整", exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    const dialog = frame.getByRole("dialog", {
      name: "保存销售计划调整",
      exact: true,
    });
    await dialog.locator("input.arco-input").first().fill("1.000");
    await dialog.locator("label.arco-checkbox").click();
    await dialog.getByRole("button", { name: "确认保存", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    assert.equal(writes, 1);
    assert.equal(saved, true);
  },
);
