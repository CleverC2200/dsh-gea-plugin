import test from "node:test";
import assert from "node:assert/strict";
import { openSalesPlanPresentation } from "./fixtures/sales-plan-presentation.mjs";

test("queue column headings stay visible while its rows scroll", { timeout: 90000 }, async (t) => {
  const frame = await openSalesPlanPresentation(
    t,
    Array.from({ length: 12 }, () => ({
      currentQty: "10",
      targetQty: "12",
      currentAmount: "100",
      targetAmount: "120",
    })),
  );
  const pane = frame.locator(".arco-table-content-inner").first();
  const measured = await pane.evaluate((element) => {
    element.style.height = "80px";
    element.style.minHeight = "80px";
    element.style.maxHeight = "80px";
    element.scrollTop = 70;
    const heading = [
      ...element.querySelectorAll(":scope > table > thead > tr > th.arco-table-th"),
    ].find((cell) => cell.textContent?.trim() === "月计划");
    return {
      scrollTop: element.scrollTop,
      paneTop: element.getBoundingClientRect().top,
      headingTop: heading?.getBoundingClientRect().top,
    };
  });
  assert.ok(measured.scrollTop > 0, "队列必须发生纵向滚动");
  assert.ok(
    Math.abs(measured.headingTop - measured.paneTop) <= 1,
    `滚动后标题应贴住队列顶部：${JSON.stringify(measured)}`,
  );
});
