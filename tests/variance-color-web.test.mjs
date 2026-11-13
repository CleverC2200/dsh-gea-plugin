import test from "node:test";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { openSalesPlanPresentation } from "./fixtures/sales-plan-presentation.mjs";

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

const semanticColor = (metrics, token) =>
  metrics.evaluate((element, name) => {
    const probe = document.createElement("span");
    probe.style.color = `rgb(var(${name}))`;
    element.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);

test(
  "positive variance uses danger-7 while the plan amount stays neutral",
  { timeout: 90000 },
  async (t) => {
    const positive = await both(t, "1200", "1000");
    const danger = await semanticColor(positive, "--danger-7");
    const success = await semanticColor(positive, "--success-8");
    assert.notEqual(danger, success);
    await expect.poll(() => colorOf(positive, "差额"), { timeout: 15000 }).toBe(danger);
    await expect(
      positive.locator("span").filter({ hasText: "差额" }).locator("strong").first(),
    ).toHaveText("¥200");

    const neutral = await colorOf(positive, "计划金额");
    assert.notEqual(neutral, danger, "计划金额不能跟着变红");
    assert.notEqual(neutral, success, "计划金额不能跟着变绿");
  },
);

test("negative variance uses success-8", { timeout: 90000 }, async (t) => {
  const negative = await both(t, "800", "1000");
  const success = await semanticColor(negative, "--success-8");
  await expect.poll(() => colorOf(negative, "差额"), { timeout: 15000 }).toBe(success);
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
