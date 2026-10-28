import test from "node:test";
import { expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { openSalesPlanPresentation } from "./fixtures/sales-plan-presentation.mjs";

const plan = {
  planId: "p-jxs-2026-09-00001",
  versionId: "v",
  currentQty: "20",
  currentAmount: "200",
  targetQty: "40",
  targetAmount: "400",
  amountProgress: "37.5",
  shipQty: "15",
  shipAmount: "150",
};
const sku = {
  id: "s",
  skuCode: "1001",
  versionId: "v",
  productCategName: "汤圆",
  materialDescription: "黑芝麻汤圆 500g",
  qty: "20",
  baseQty: "10",
  amt: "200",
  amtBase: "100",
  price: "10",
};
const otherSku = {
  ...sku,
  id: "s2",
  skuCode: "2001",
  productCategName: "面点",
  materialDescription: "面点测试 SKU",
  qty: "30",
  baseQty: "5",
  amt: "300",
  amtBase: "50",
};

test(
  "detail summary uses selected version SKUs while monthly and category values keep their basis",
  { timeout: 30000 },
  async (t) => {
    const page = await openSalesPlanPresentation(t, [plan], {
      versionSkus: { v: [sku, otherSku] },
    });
    const totals = page.getByRole("region", { name: "当前页明细汇总", exact: true });
    await expect(totals).toContainText("¥500");
    await expect(totals).toContainText("50 件");
    await expect(totals).not.toContainText("¥200");
    await expect(page.getByRole("button", { name: "保存调整", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "重提", exact: true })).toHaveCount(0);
    await expect(
      page.locator("header").first().getByRole("tab", { name: "月初", exact: true }),
    ).toBeVisible();
    const monthPlan = page.getByTestId("regional-approval-month-plan-p-jxs-2026-09-00001");
    await expect(monthPlan.locator("span").first()).toHaveText("¥150");
    await expect(page.locator("tbody").first()).toContainText("37.5%");
    await expect(page.getByText(/数量 .*%/)).toHaveCount(0);
    await expect(page.locator("thead")).not.toContainText("AI 核对意见");
    await page.getByRole("switch").first().click();
    const category = page.getByTestId("regional-approval-category-row-p-jxs-2026-09-00001-汤圆");
    await category.getByRole("button").click();
    await expect(page.locator('tbody th[scope="rowgroup"]')).toHaveText("汤圆 · 1 SKU");
    await expect(page.locator("tbody")).toContainText(["黑芝麻汤圆 500g"]);
    await expect(page.getByText("面点测试 SKU", { exact: true })).toHaveCount(0);
    await expect(category.locator("xpath=ancestor::tr[1]")).toContainText("¥266.67");
    await expect(category.locator("xpath=ancestor::tr[1]")).toContainText("75.0%");
    await expect(page.getByRole("textbox", { name: "确认计划量 1001", exact: true })).toHaveCount(
      0,
    );
    const artifacts = `.runtime/detail-summary-presentation/${process.pid}`;
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: artifacts + "/desktop.png", fullPage: true });
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(category).toBeVisible();
    await expect(page.locator('tbody th[scope="rowgroup"]')).toBeVisible();
    await expect(totals).toContainText("¥500");
    await page.screenshot({ path: artifacts + "/narrow.png", fullPage: true });
    await category.getByRole("button").click();
    await expect(page.locator('tbody th[scope="rowgroup"]')).toHaveCount(0);
  },
);
