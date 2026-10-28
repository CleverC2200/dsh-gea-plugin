import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import {
  fixture,
  PLAN_A,
  PLAN_B,
  PLAN_C,
  captureEvidence,
  selectPlan,
} from "./fixtures/returned-review.mjs";

for (const mixed of [false, true])
  test(
    `returned and pending selections submit with one confirmation; mixed=${mixed}`,
    { timeout: 90000 },
    async (t) => {
      const { frame, page, app, submitted, approved, state } = await fixture(t);
      await selectPlan(frame);
      if (mixed) {
        page.on("console", (message) => {
          if (message.text().startsWith("[gea-draft]")) t.diagnostic(message.text());
        });
        await frame
          .getByRole("button", {
            name: "打开 沈阳待审批 调整明细",
            exact: true,
          })
          .click();
        const quantity = frame.getByRole("spinbutton", {
          name: "确认计划量 789",
          exact: true,
        });
        await expect(quantity).toHaveValue("1.250");
        await quantity.fill("3.000");
        await expect(quantity).toHaveValue("3.000");
        await expect
          .poll(
            async () => {
              const result = await app.rpc("sales-plan/draft", {
                planId: PLAN_C,
                versionId: "v3",
                approvalRole: "region",
              });
              return {
                ok: result.ok,
                error: result.error,
                adjustments: result.value?.draft?.adjustments,
              };
            },
            { timeout: 15000 },
          )
          .toEqual({
            ok: true,
            error: undefined,
            adjustments: [{ skuCode: "789", adjustQty: "1.750" }],
          });
      }
      await selectPlan(frame, mixed ? "沈阳待审批" : "济南退回区域");
      const submit = frame.getByRole("button", {
        name: "提交所选",
        exact: true,
      });
      await expect(submit).toBeEnabled();
      await submit.click();
      const dialog = frame.getByRole("dialog");
      await expect(dialog.locator("label.arco-checkbox")).toHaveCount(0);
      await expect(dialog).toContainText("乌鲁木齐退回区域");
      await expect(dialog).toContainText(mixed ? "沈阳待审批" : "济南退回区域");
      const returned = dialog.getByRole("region", {
        name: "乌鲁木齐退回区域",
        exact: true,
      });
      await returned.locator("summary").press("Enter");
      await returned.getByRole("textbox", { name: "提报数量 789" }).fill("3.000");
      await expect(returned).toContainText("24.68");
      await expect(returned).toContainText("37.02");
      await expect(dialog).not.toContainText("9007199254740993");
      if (mixed && process.env.S1_EVIDENCE_DIR) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await captureEvidence(page, app, "mixed-comparison-desktop");
        await page.setViewportSize({ width: 820, height: 900 });
        await captureEvidence(page, app, "mixed-comparison-narrow");
        await page.setViewportSize({ width: 1536, height: 920 });
      }
      await dialog.getByRole("button", { name: "确认提交", exact: true }).dblclick();
      await expect(dialog).toContainText("成功 2 笔", { timeout: 30000 });
      assert.deepEqual(
        submitted.map(({ planId }) => planId).sort(),
        mixed ? [PLAN_A] : [PLAN_A, PLAN_B],
      );
      assert.ok(submitted.every(({ body }) => body.status === 2 && body.items.length === 1));
      assert.deepEqual(
        approved.map(({ planId }) => planId),
        mixed ? [PLAN_C] : [],
      );
      assert.equal(state.get(PLAN_A).seq, 2);
      if (!mixed) assert.equal(state.get(PLAN_B).seq, 2);
      if (mixed) {
        assert.equal(state.get(PLAN_C).seq, 1);
        assert.equal(
          Number(approved[0].body.adjustments.find((line) => line.skuCode === "789").adjustQty),
          1.75,
        );
      }
    },
  );

test(
  "mixed batch preserves approval success when returned submission is refused",
  { timeout: 90000 },
  async (t) => {
    const { frame, submitted, approved } = await fixture(t, {
      denySubmit: true,
    });
    await selectPlan(frame);
    await selectPlan(frame, "沈阳待审批");
    await frame.getByRole("button", { name: "提交所选", exact: true }).click();
    const dialog = frame.getByRole("dialog");
    await dialog.getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(dialog).toContainText("成功 1 笔", { timeout: 30000 });
    await expect(dialog).toContainText("提报窗口已关闭，请联系业务管理员");
    assert.equal(submitted.length, 1);
    assert.deepEqual(
      approved.map(({ planId }) => planId),
      [PLAN_C],
    );
  },
);

test(
  "mixed batch keeps successful receipt and refreshes without another submission",
  { timeout: 90000 },
  async (t) => {
    const { frame, submitted, approved, allowReadback } = await fixture(t, {
      readbackFailure: true,
    });
    await selectPlan(frame);
    await selectPlan(frame, "沈阳待审批");
    await frame.getByRole("button", { name: "提交所选", exact: true }).click();
    const dialog = frame.getByRole("dialog");
    await dialog.getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(dialog).toContainText("重提已成功");
    await expect.poll(() => approved.length).toBe(1);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await frame.getByRole("button", { name: "恢复待处理重提", exact: true }).click();
    allowReadback();
    await dialog.getByRole("button", { name: "刷新权威状态", exact: true }).click();
    await expect(dialog).toContainText("成功 2 笔", { timeout: 30000 });
    assert.equal(submitted.length, 1);
    assert.equal(approved.length, 1);
  },
);

test(
  "mixed batch retries only unknown intent and never repeats approved items",
  { timeout: 90000 },
  async (t) => {
    const { frame, submitted, approved, state } = await fixture(t, {
      unknownOnce: true,
    });
    await selectPlan(frame);
    await selectPlan(frame, "沈阳待审批");
    await frame.getByRole("button", { name: "提交所选", exact: true }).click();
    const dialog = frame.getByRole("dialog");
    await dialog.getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(dialog).toContainText("结果暂时未知");
    await expect.poll(() => approved.length).toBe(1);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await frame.getByRole("button", { name: "恢复待处理重提", exact: true }).click();
    await dialog.getByRole("button", { name: "以原幂等键重试", exact: true }).click();
    await expect(dialog).toContainText("成功 2 笔", { timeout: 30000 });
    assert.equal(approved.length, 1);
    assert.equal(submitted.length, 2);
    assert.deepEqual(submitted[1], submitted[0]);
    assert.equal(state.get(PLAN_A).seq, 2);
  },
);
