import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { openReadySalesPlan } from "./fixtures/business-page.mjs";
import { testBrowser } from "./fixtures/test-browser.mjs";
import { profile } from "./profile.mjs";

test("月初与纠偏入口恢复，客户重提仍受服务授权控制", { timeout: 60000 }, async (t) => {
  const app = await profile(t);
  const plan = {
    planId: "p-jxs-2026-10-00001",
    versionId: "v1",
    seq: 1,
    periodId: "20261001",
    planTypeCode: "Y",
    orderType: "Z",
    monthlyApproved: true,
    hasCorrection: true,
    cust_code: 456,
    dealerName: "Returned customer",
    submitter: "9007199254740993",
    status: 6,
    currentQty: "1",
    targetQty: "1",
    currentAmount: "12.34",
    targetAmount: "12.34",
    belong_base: "Fixture",
    sales_group_code: "org",
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
              periodId: "20261001",
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
      // 纠偏列表会按当前角色的可见状态逐个 status 查询再合并；上游 mock 必须认 status，
      // 否则同一条会被每个状态各返回一次，页面上就出现重复行。
      const status = req.url.searchParams.get("status");
      const orderType = req.url.searchParams.get("orderType");
      const records =
        (status === null || Number(status) === plan.status) &&
        (orderType === null || orderType === plan.orderType)
          ? [plan]
          : [];
      reply({
        success: true,
        result: { records, total: records.length, pages: 1, current: 1, size: 20 },
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
            adjAddQty: "0",
            adjCutQty: "0",
          },
        ],
      });
      return true;
    }
  });
  await app.login();
  const browser = await testBrowser(t, () =>
    chromium.launch({
      channel: "chrome",
      headless: true,
    }),
  );
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
  await page.goto(app.origin);
  const frame = await openReadySalesPlan(page);
  await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
  await expect(frame.getByRole("tab", { name: "月初", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(frame.getByRole("button", { name: "修改后提交", exact: true })).toHaveCount(0);
  await frame.getByRole("tab", { name: "纠偏", exact: true }).click();
  await expect(frame.getByRole("tab", { name: "纠偏", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await frame.getByRole("tab", { name: "按客户", exact: true }).click();
  await frame.getByRole("button", { name: "筛选条件", exact: true }).click();
  await frame.getByLabel("审批状态", { exact: true }).click();
  await frame.getByRole("option", { name: "退回销售", exact: true }).click();
  const customerRow = frame.getByRole("row").filter({ hasText: plan.dealerName }).first();
  await expect(customerRow).toBeVisible();
  const rowSelection = customerRow.getByRole("checkbox");
  await expect(rowSelection).toBeEnabled();
  await rowSelection.locator("..").click();
  await expect(rowSelection).toBeChecked();
  const resubmit = frame.getByRole("button", { name: "修改后提交", exact: true });
  await expect(resubmit).toBeEnabled();
  await resubmit.click();
  const dialog = frame.getByRole("dialog", { name: "确认修改并重提", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("spinbutton")).toHaveCount(0);
  await expect(dialog).toContainText("没有数量修改");
  await expect(dialog).toContainText(
    "修改重提入口尚未就绪或权限不足，可核对以下修改，暂不发送重提",
  );
  await expect(dialog.getByRole("button", { name: "确认重提", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await frame.getByRole("tab", { name: "月初", exact: true }).click();
  await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
  assert.equal(
    app.requests.some(
      (r) => r.method === "POST" && r.url.pathname.includes("/internal/sales-plans"),
    ),
    false,
  );
});
