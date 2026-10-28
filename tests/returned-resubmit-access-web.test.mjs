import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, captureEvidence, selectPlan } from "./fixtures/returned-review.mjs";

test(
  "service configuration unavailable permits review but blocks submission",
  { timeout: 90000 },
  async (t) => {
    const { frame, page, app, submitted } = await fixture(t, {
      serviceReady: false,
    });
    await selectPlan(frame);
    await frame.getByRole("button", { name: "修改后提交", exact: true }).click();
    const dialog = frame.getByRole("dialog", {
      name: "真实销售计划退回重提",
      exact: true,
    });
    await expect(dialog).toContainText("当前账号的修改重提入口尚未就绪或权限不足");
    await expect(dialog.getByRole("button", { name: "确认重提", exact: true })).toBeDisabled();
    await captureEvidence(page, app, "submission-unavailable");
    assert.equal(submitted.length, 0);
  },
);

test(
  "submission refusal preserves the business reason without another write path",
  { timeout: 90000 },
  async (t) => {
    const { frame, submitted, approved } = await fixture(t, {
      denySubmit: true,
    });
    await selectPlan(frame);
    await frame.getByRole("button", { name: "修改后提交", exact: true }).click();
    const dialog = frame.getByRole("dialog", {
      name: "真实销售计划退回重提",
      exact: true,
    });
    await expect(dialog.getByRole("textbox", { name: "提报数量 789" })).toBeVisible();
    await expect(dialog.locator("label.arco-checkbox")).toHaveCount(0);
    await dialog.getByRole("button", { name: "确认重提", exact: true }).click();
    await expect(dialog).toContainText("提报窗口已关闭，请联系业务管理员");
    assert.equal(submitted.length, 1);
    assert.equal(approved.length, 0);
  },
);

test(
  "unconfirmed customer responsibility is explained on its disabled row",
  { timeout: 90000 },
  async (t) => {
    const { frame, page, app, submitted } = await fixture(t, {
      role: "customer",
      returnedStatus: 6,
      originalSubmitter: "other-owner",
    });
    const row = frame.locator("tbody tr").filter({ hasText: "乌鲁木齐退回区域" }).first();
    await expect(row.locator('input[type="checkbox"]')).toBeDisabled();
    await expect(row).toContainText("无法确认修改责任身份");
    await captureEvidence(page, app, "unconfirmed-customer");
    assert.equal(submitted.length, 0);
  },
);

test("logout revokes a hidden pending submission", { timeout: 90000 }, async (t) => {
  const { app, frame, page, submitted } = await fixture(t, { unknownOnce: true });
  let allowLogin = false;
  await page.route("**/api/gea-proof/login/poll", (route) =>
    allowLogin
      ? route.continue()
      : route.fulfill({ json: { ok: true, value: { status: "pending" } } }),
  );
  await selectPlan(frame);
  await frame.getByRole("button", { name: "修改后提交", exact: true }).click();
  const dialog = frame.getByRole("dialog", {
    name: "真实销售计划退回重提",
    exact: true,
  });
  await expect(dialog.getByRole("textbox", { name: "提报数量 789" })).toBeVisible();
  await expect(dialog.locator("label.arco-checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "确认重提", exact: true }).click();
  await expect(dialog).toContainText("结果暂时未知");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const resume = frame.getByRole("button", {
    name: "恢复待处理重提",
    exact: true,
  });
  await expect(resume).toBeVisible();
  await app.rpc("logout");
  await expect(resume).not.toBeVisible();
  await expect(frame.getByRole("button", { name: "刷新二维码", exact: true })).toBeVisible();
  allowLogin = true;
  await expect.poll(async () => (await app.rpc("status")).value.authenticated).toBe(true);
  await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
  await expect(resume).toHaveCount(0);
  assert.equal(submitted.length, 1);
});
