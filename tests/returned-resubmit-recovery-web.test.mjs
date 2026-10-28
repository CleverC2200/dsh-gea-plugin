import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import {
  fixture,
  PLAN_A,
  PLAN_B,
  captureEvidence,
  selectPlan,
} from "./fixtures/returned-review.mjs";

test(
  "successful submission with incomplete readback survives close and only resumes reading",
  { timeout: 90000 },
  async (t) => {
    const { frame, page, app, submitted, allowReadback } = await fixture(t, {
      readbackFailure: true,
    });
    await selectPlan(frame);
    await frame.getByRole("button", { name: "修改后提交", exact: true }).click();
    const dialog = frame.getByRole("dialog", {
      name: "确认修改并重提",
      exact: true,
    });
    await expect(dialog.getByRole("button", { name: "确认重提", exact: true })).toBeEnabled();
    await expect(dialog.locator("label.arco-checkbox")).toHaveCount(0);
    await dialog.getByRole("button", { name: "确认重提", exact: true }).click();
    await expect(dialog).toContainText("重提已成功");
    await expect(dialog).not.toContainText("未更新");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await selectPlan(frame);
    await selectPlan(frame, "济南退回区域");
    for (const name of ["乌鲁木齐退回区域", "济南退回区域"])
      await expect(
        frame.locator("tbody tr").filter({ hasText: name }).first().getByRole("checkbox"),
      ).toBeChecked();
    await frame.getByRole("button", { name: "提交所选", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("乌鲁木齐退回区域");
    await expect(dialog).not.toContainText("济南退回区域");
    assert.equal(submitted.length, 1);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await frame.getByRole("button", { name: "刷新数据", exact: true }).click();
    await expect(frame.locator("tbody tr").filter({ hasText: "乌鲁木齐退回区域" })).toHaveCount(0);
    await captureEvidence(page, app, "pending-receipt-recovery");
    allowReadback();
    await frame.getByRole("button", { name: "恢复待处理重提", exact: true }).click();
    await expect(dialog).toContainText("乌鲁木齐退回区域");
    await dialog.getByRole("button", { name: "刷新权威状态", exact: true }).click();
    await expect(dialog).toContainText("提交成功");
    assert.equal(submitted.length, 1);
  },
);

test(
  "unknown submission survives close and reopens the original intent without another version",
  { timeout: 90000 },
  async (t) => {
    const { frame, submitted, state } = await fixture(t, { unknownOnce: true });
    await selectPlan(frame);
    await frame.getByRole("button", { name: "修改后提交", exact: true }).click();
    const dialog = frame.getByRole("dialog", {
      name: "确认修改并重提",
      exact: true,
    });
    await expect(dialog.getByRole("button", { name: "确认重提", exact: true })).toBeEnabled();
    await expect(dialog.locator("label.arco-checkbox")).toHaveCount(0);
    await dialog.getByRole("button", { name: "确认重提", exact: true }).click();
    await expect(dialog).toContainText("结果暂时未知");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await frame.getByRole("button", { name: "恢复待处理重提", exact: true }).click();
    await expect(dialog).toContainText("2.000 件");
    await expect(dialog.getByRole("spinbutton")).toHaveCount(0);
    await dialog.getByRole("button", { name: "以原幂等键重试", exact: true }).click();
    await expect(dialog).toContainText("提交成功");
    assert.equal(submitted.length, 2);
    assert.deepEqual(submitted[1], submitted[0]);
    assert.equal(state.get(PLAN_A).seq, 2);
  },
);

test(
  "readback retry preserves a newly reselected prior successful row",
  { timeout: 90000 },
  async (t) => {
    const { frame, approved, submitted, allowReadback } = await fixture(t, {
      normalBatch: true,
      readbackFailure: true,
    });
    await frame.getByTestId("regional-approval-flow-toggle").click();
    await frame.getByTestId("regional-approval-stage-region").click();
    const rowBox = (id) =>
      frame.locator(`tbody label.arco-checkbox:has(input[value="${id}"])`).first();
    await rowBox(PLAN_A).click();
    await rowBox(PLAN_B).click();
    await frame.getByRole("button", { name: "提交所选", exact: true }).click();
    const dialog = frame.getByRole("dialog");
    await dialog.getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(dialog).toContainText("成功 1 笔");
    await expect(dialog).toContainText("待核实 1 笔");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await rowBox(PLAN_B).click();
    await expect(rowBox(PLAN_B).locator("input")).toBeChecked();
    allowReadback();
    await frame.getByRole("button", { name: "恢复待处理重提", exact: true }).click();
    await dialog.getByRole("button", { name: "刷新权威状态", exact: true }).click();
    await expect(dialog).toContainText("成功 2 笔");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(rowBox(PLAN_B).locator("input")).toBeChecked();
    assert.equal(approved.length, 1);
    assert.equal(submitted.length, 1);
  },
);
