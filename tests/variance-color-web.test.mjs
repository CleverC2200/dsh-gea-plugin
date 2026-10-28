import test from "node:test";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { openSalesPlanPresentation } from "./fixtures/sales-plan-presentation.mjs";

/**
 * V1.8 #14：顶部指标卡「差额（计划 − 目标）」正数红、负数绿；
 * 颜色只作用于差额数值本身，其他指标卡保持原字色。
 */
const both = async (t, planAmount, targetAmount) => {
  const page = await openSalesPlanPresentation(t, [
    { currentQty: "10", currentAmount: planAmount, targetQty: "10", targetAmount },
  ]);
  const metrics = page.getByRole("region", { name: "当前页明细汇总" });
  await expect
    .poll(
      async () =>
        (await metrics.locator("strong").allTextContents()).filter(
          (text) => text.includes("¥") && text !== "—",
        ).length,
    )
    .toBeGreaterThan(1);
  return metrics;
};

const colorOf = (metrics, label) =>
  metrics
    .locator("span")
    .filter({ hasText: label })
    .locator("strong")
    .first()
    .evaluate((element) => getComputedStyle(element).color);

test("positive variance is red and negative variance is green", { timeout: 90000 }, async (t) => {
  const positive = await both(t, "1200", "1000");
  await expect.poll(() => colorOf(positive, "差额"), { timeout: 15000 }).toBe("rgb(200, 17, 42)");
  await expect(
    positive.locator("span").filter({ hasText: "差额" }).locator("strong").first(),
  ).toHaveText("¥200");
  // 颜色只作用于差额：另外两张指标卡保持默认字色。
  const neutral = await colorOf(positive, "计划金额");
  assert.notEqual(neutral, "rgb(200, 17, 42)", "计划金额不能跟着变红");
  assert.notEqual(neutral, "rgb(22, 142, 88)", "计划金额不能跟着变绿");
});

test("loss (plan below target) is green, not red", { timeout: 90000 }, async (t) => {
  const negative = await both(t, "800", "1000");
  await expect.poll(() => colorOf(negative, "差额"), { timeout: 15000 }).toBe("rgb(22, 142, 88)");
  await expect(
    negative.locator("span").filter({ hasText: "差额" }).locator("strong").first(),
  ).toHaveText("−¥200");
});

test(
  "approval overview shows readable amounts and keeps exact figures available",
  { timeout: 90000 },
  async (t) => {
    const metrics = await both(t, "6296877.25", "6416787.34");
    const target = metrics
      .locator("span")
      .filter({ hasText: "目标金额" })
      .locator("strong")
      .first();
    const plan = metrics.locator("span").filter({ hasText: "计划金额" }).locator("strong").first();
    await expect(target).toHaveText("¥641.68万");
    await expect(target).toHaveAttribute("title", "¥6,416,787.34");
    await expect(plan).toHaveText("¥629.69万");
    await expect(plan).toHaveAttribute("title", "¥6,296,877.25");
  },
);
