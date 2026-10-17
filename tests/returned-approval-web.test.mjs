import test from "node:test";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, PLAN_A, PLAN_B, PLAN_C } from "./fixtures/returned-resubmit.mjs";

test(
  "a returned plan approves its current version without service credentials",
  { timeout: 90000 },
  async (t) => {
    const { frame, submitted, approved } = await fixture(t);
    await frame
      .locator("tbody tr")
      .filter({ hasText: "乌鲁木齐退回区域" })
      .first()
      .locator("label.arco-checkbox")
      .click();
    await expect(frame.getByRole("button", { name: "退回", exact: true })).toBeEnabled();
    await expect(frame.getByRole("button", { name: "通过", exact: true })).toBeEnabled();
    await frame.getByRole("button", { name: "通过", exact: true }).click();
    await expect.poll(() => approved.length).toBe(1);
    await expect(
      frame.getByRole("dialog", { name: "真实销售计划退回重提", exact: true }),
    ).toHaveCount(0);
    assert.equal(approved[0].body.expectedStatus, 7);
    assert.deepEqual(submitted, []);
  },
);

test(
  "upstream refusal of a returned approval never falls back to service-account resubmission",
  { timeout: 90000 },
  async (t) => {
    const { frame, submitted, approved, attempts } = await fixture(t, { denyApproval: true });
    await frame
      .locator("tbody tr")
      .filter({ hasText: "乌鲁木齐退回区域" })
      .first()
      .locator("label.arco-checkbox")
      .click();
    const approve = frame.getByRole("button", { name: "通过", exact: true });
    await approve.click();
    await expect(approve).toBeDisabled();
    await expect(approve).toHaveAttribute("title", /服务端.*拒绝/);
    assert.equal(attempts.length, 1);
    assert.deepEqual(approved, []);
    assert.deepEqual(submitted, []);
  },
);

for (const mixed of [false, true])
  test(
    `batch approves returned plans on their current versions; mixed=${mixed}`,
    { timeout: 90000 },
    async (t) => {
      const { frame, submitted, approved } = await fixture(t);
      for (const name of ["乌鲁木齐退回区域", mixed ? "沈阳待审批" : "济南退回区域"])
        await frame
          .locator("tbody tr")
          .filter({ hasText: name })
          .first()
          .locator("label.arco-checkbox")
          .click();
      await expect(frame.getByRole("button", { name: "通过", exact: true })).toBeEnabled();
      await frame.getByRole("button", { name: "通过", exact: true }).click();
      const dialog = frame.getByTestId("regional-approval-batch-action-dialog");
      await expect(dialog).not.toContainText("生成新版本");
      await dialog.locator("label.arco-checkbox").click();
      await frame.getByRole("button", { name: "确认批量通过", exact: true }).click();
      await expect(frame.getByTestId("regional-approval-batch-result")).toContainText("成功 2 笔", {
        timeout: 30000,
      });
      assert.deepEqual(approved.map((x) => x.planId).sort(), [PLAN_A, mixed ? PLAN_C : PLAN_B]);
      assert.deepEqual(approved.map((x) => x.body.expectedStatus).sort(), mixed ? [1, 7] : [7, 7]);
      assert.deepEqual(submitted, []);
    },
  );
