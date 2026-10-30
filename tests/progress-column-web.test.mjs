import test from "node:test";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { openSalesPlanPresentation } from "./fixtures/sales-plan-presentation.mjs";

/**
 * V1.8 #09：达成率列用「细进度条 + 百分比」，百分比前不带「金额」，
 * 配色按 D23 推荐口径分档：<95% 红、95–100% 橙、≥100% 绿。
 */
test(
  "progress column shows a bar with percent-only text and threshold colours",
  { timeout: 90000 },
  async (t) => {
    const frame = await openSalesPlanPresentation(
      t,
      ["50", "97", "120"].map((qty) => ({
        currentQty: qty,
        currentAmount: qty,
        amountProgress: qty,
        shipQty: qty,
        shipAmount: qty,
        targetQty: "100",
        targetAmount: "100",
      })),
    );
    await expect.poll(async () => (await cellInfo(frame)).length).toBe(3);

    // 进度条颜色带过渡动画，等它稳定后再断言。
    const expected = [
      ["50.0%", "rgb(245, 63, 63)", "低于 95% 用红色"],
      ["97.0%", "rgb(255, 125, 0)", "95–100% 用橙色"],
      ["120.0%", "rgb(0, 180, 42)", "≥100% 用绿色"],
    ];
    for (const [text, color, message] of expected)
      await expect
        .poll(async () => (await cellInfo(frame)).find((cell) => cell.text === text)?.color, {
          timeout: 8000,
        })
        .toBe(color, { message });
    // 宽度也是动画出来的，等颜色稳定后再量。
    await expect
      .poll(async () => (await cellInfo(frame)).every((cell) => cell.barWidth > 20), {
        timeout: 8000,
      })
      .toBe(true);
    const cells = await cellInfo(frame);
    assert.deepEqual(
      cells.map((cell) => cell.text).toSorted(),
      ["120.0%", "50.0%", "97.0%"],
      "百分比前不再带「金额」",
    );
    for (const cell of cells) {
      assert.ok(
        cell.text.includes("%") && !cell.text.includes("金额"),
        `达成率文案应为纯百分比，实际「${cell.text}」`,
      );
    }
  },
);

const cellInfo = (frame) =>
  frame.locator("tbody tr").evaluateAll((rows) =>
    rows
      .map((row) => {
        const bar = row.querySelector(".arco-progress-line-inner");
        const label = bar?.closest("td")?.querySelector("strong");
        if (!label || !bar) return undefined;
        const text = (label.textContent || "").trim();
        return text.endsWith("%")
          ? {
              text,
              color: getComputedStyle(bar).backgroundColor,
              barWidth: Math.round(bar.getBoundingClientRect().width),
            }
          : undefined;
      })
      .filter(Boolean),
  );

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
