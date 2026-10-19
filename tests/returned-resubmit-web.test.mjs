import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, PLAN_A, PLAN_B, PLAN_C } from "./fixtures/returned-review.mjs";

const captureEvidence = async (page, app, name) => {
  const directory = process.env.S1_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, name + ".png"),
    fullPage: true,
    animations: "disabled",
  });
  await writeFile(
    resolve(directory, name + ".layout.json"),
    JSON.stringify(
      await page
        .frameLocator('iframe[src^="/api/agent-workbench/native?"]')
        .locator("body")
        .evaluate((body) => {
          const node = body.querySelector('[role="dialog"]');
          if (!node) return { viewport: window.innerWidth };
          const rect = node.getBoundingClientRect();
          return {
            viewport: window.innerWidth,
            x: rect.x,
            width: rect.width,
            right: rect.right,
          };
        }),
    ),
  );
  await writeFile(
    resolve(directory, name + ".aria.txt"),
    await page
      .frameLocator('iframe[src^="/api/agent-workbench/native?"]')
      .locator("body")
      .ariaSnapshot(),
  );
  await writeFile(
    resolve(directory, name + ".host.json"),
    await readFile(resolve(app.runtime, "source-host.json")),
  );
  const host = JSON.parse(await readFile(resolve(app.runtime, "source-host.json"), "utf8"));
  await writeFile(
    resolve(directory, name + ".plugins.json"),
    await readFile(
      resolve(app.runtime, "source-combinations", host.combination, "company-plugins.json"),
    ),
  );
  await writeFile(
    resolve(directory, name + ".warnings.txt"),
    app.output
      .split("\n")
      .filter((line) => /warning|failed to import/.test(line))
      .join("\n"),
  );
};

const selectPlan = (frame, name = "乌鲁木齐退回区域") =>
  frame
    .locator("tbody tr")
    .filter({ hasText: name })
    .first()
    .locator("label.arco-checkbox")
    .click();

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
      await dialog.getByRole("button", { name: "确认重提", exact: true }).dblclick();
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

for (const mixed of [false, true])
  test(
    `returned and pending selections submit with one confirmation; mixed=${mixed}`,
    { timeout: 90000 },
    async (t) => {
      const { frame, page, app, submitted, approved, state } = await fixture(t);
      await selectPlan(frame);
      if (mixed) {
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
      name: "真实销售计划退回重提",
      exact: true,
    });
    await expect(dialog.getByRole("textbox", { name: "提报数量 789" })).toBeVisible();
    await expect(dialog.locator("label.arco-checkbox")).toHaveCount(0);
    await dialog.getByRole("button", { name: "确认重提", exact: true }).click();
    await expect(dialog).toContainText("重提已成功");
    await expect(dialog).not.toContainText("未更新");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await selectPlan(frame);
    await selectPlan(frame, "济南退回区域");
    await frame.getByRole("button", { name: "修改后提交", exact: true }).click();
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
  "unknown submission survives close and reopens the original intent without another version",
  { timeout: 90000 },
  async (t) => {
    const { frame, submitted, state } = await fixture(t, { unknownOnce: true });
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
    await expect(dialog).not.toBeVisible();
    await frame.getByRole("button", { name: "恢复待处理重提", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "提报数量 789" })).toHaveValue("2.000");
    await dialog.getByRole("button", { name: "以原幂等键重试", exact: true }).click();
    await expect(dialog).toContainText("提交成功");
    assert.equal(submitted.length, 2);
    assert.deepEqual(submitted[1], submitted[0]);
    assert.equal(state.get(PLAN_A).seq, 2);
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
  const { app, frame, submitted } = await fixture(t, { unknownOnce: true });
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
  await app.login();
  await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
  await expect(resume).toHaveCount(0);
  assert.equal(submitted.length, 1);
});
