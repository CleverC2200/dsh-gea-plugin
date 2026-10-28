import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, PLAN_A, captureEvidence, selectPlan } from "./fixtures/returned-review.mjs";

for (const [role, returnedStatus] of [
  ["region", 7],
  ["province", 8],
  ["area", 9],
  ["customer", 6],
])
  test(
    `returned ${returnedStatus} edits and submits one successor with fixed status`,
    { timeout: 90000 },
    async (t) => {
      const { frame, page, app, submitted, approved, state } = await fixture(t, {
        role,
        returnedStatus,
        shortened: returnedStatus === 7,
        sameIdPeriod: returnedStatus === 7,
      });
      if (returnedStatus === 7) {
        const periods = await app.rpc("workbench/query", {
          kind: "periods",
          query: {},
        });
        assert.deepEqual(
          periods.value.records.map((period) => period.planTypeCode),
          ["DC", "Y"],
        );
      }
      await selectPlan(frame);
      const edit = frame.getByRole("button", {
        name: "修改后提交",
        exact: true,
      });
      await expect(edit).toBeEnabled();
      if (returnedStatus === 7) await captureEvidence(page, app, "returned-entry");
      await edit.click();
      const dialog = frame.getByRole("dialog", {
        name: "真实销售计划退回重提",
        exact: true,
      });
      await dialog.getByRole("textbox", { name: "提报数量 789" }).fill("3.000");
      await expect(dialog).toContainText("37.02");
      if (returnedStatus === 7) await captureEvidence(page, app, "inheritance-confirmation");
      await expect(dialog.locator("label.arco-checkbox")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "确认重提", exact: true })).toBeEnabled();
      await dialog.getByRole("button", { name: "确认重提", exact: true }).evaluate((button) => {
        button.click();
        button.click();
      });
      await expect(dialog).toContainText("提交成功");
      assert.equal(submitted.length, 1);
      assert.equal(submitted[0].body.status, returnedStatus - 5);
      assert.equal(submitted[0].body.items[0].qty, "3.000");
      assert.equal(state.get(PLAN_A).seq, 2);
      assert.equal(
        state.get(PLAN_A).nextActor,
        { 6: "region", 7: "area", 8: "area", 9: "category" }[returnedStatus],
      );
      assert.deepEqual(approved, []);
    },
  );

test(
  "normal pending records retain batch approval without submission",
  { timeout: 90000 },
  async (t) => {
    const { frame, approved, submitted } = await fixture(t, {
      normalBatch: true,
    });
    await selectPlan(frame, "济南退回区域");
    await selectPlan(frame, "沈阳待审批");
    await frame.getByRole("button", { name: "通过", exact: true }).click();
    const dialog = frame.getByRole("dialog");
    await expect(dialog.locator("label.arco-checkbox")).toHaveCount(0);
    await dialog.getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(dialog).toContainText("成功 2 笔", {
      timeout: 30000,
    });
    assert.equal(approved.length, 2);
    assert.equal(submitted.length, 0);
  },
);
