import test from "node:test";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
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
