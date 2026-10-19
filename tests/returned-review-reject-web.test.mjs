import test from "node:test";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, PLAN_A, PLAN_C } from "./fixtures/returned-review.mjs";

test(
  "returned and pending plans can be rejected together, each from its own status",
  { timeout: 90000 },
  async (t) => {
    const { frame, rejected } = await fixture(t);
    const rowBox = (name) =>
      frame.locator("tbody tr").filter({ hasText: name }).first().locator("label.arco-checkbox");
    await rowBox("乌鲁木齐退回区域").click();
    await rowBox("沈阳待审批").click();
    await frame.getByRole("button", { name: "退回", exact: true }).click();
    const dialog = frame.getByTestId("regional-approval-batch-action-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("退回版本继续逐级退回");
    await expect(dialog).toContainText("正常审批退回");
    await dialog.getByRole("textbox", { name: "批量审批备注" }).fill("继续退回客户核对");
    await dialog.locator("label.arco-checkbox").click();
    await frame.getByRole("button", { name: "确认批量退回", exact: true }).click();
    const result = frame.getByTestId("regional-approval-batch-result");
    await expect(result).toContainText("成功 2 笔", { timeout: 30000 });
    await expect(result.locator("ul")).toHaveCount(0);
    assert.deepEqual(rejected.map(({ planId }) => planId).sort(), [PLAN_A, PLAN_C]);
    assert.deepEqual(rejected.map(({ body }) => body.expectedStatus).sort(), [1, 7]);
    assert.ok(
      rejected.every(({ body }) => body.action === "REJECT" && body.remark === "继续退回客户核对"),
    );
  },
);

test(
  "a returned regional plan can be rejected again to the customer",
  { timeout: 90000 },
  async (t) => {
    const { frame, rejected } = await fixture(t);
    await frame
      .locator("tbody tr")
      .filter({ hasText: "乌鲁木齐退回区域" })
      .first()
      .locator("label.arco-checkbox")
      .click();
    await frame.getByRole("button", { name: "退回", exact: true }).click();
    const dialog = frame.getByRole("dialog", { name: "退回", exact: true });
    await dialog.getByRole("textbox", { name: "退回原因（必填）" }).fill("继续退回客户核对");
    await dialog.getByRole("button", { name: "确认退回", exact: true }).click();
    await expect.poll(() => rejected.length, { timeout: 15000 }).toBe(1);
    assert.equal(rejected[0].planId, PLAN_A);
    assert.equal(rejected[0].body.expectedStatus, 7);
  },
);

test("queue column headings stay visible while its rows scroll", { timeout: 90000 }, async (t) => {
  const { frame } = await fixture(t);
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
