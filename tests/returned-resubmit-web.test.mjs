import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, PLAN_A } from "./fixtures/returned-review.mjs";

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
        const periods = await app.rpc("workbench/query", { kind: "periods", query: {} });
        assert.deepEqual(
          periods.value.records.map((period) => period.planTypeCode),
          ["DC", "Y"],
        );
      }
      await selectPlan(frame);
      const edit = frame.getByRole("button", { name: "修改后提交", exact: true });
      await expect(edit).toBeEnabled();
      if (returnedStatus === 7) await captureEvidence(page, app, "returned-entry");
      await edit.click();
      const dialog = frame.getByRole("dialog", { name: "真实销售计划退回重提", exact: true });
      await dialog.getByRole("textbox", { name: "提报数量 789" }).fill("3.000");
      await expect(dialog).toContainText("请核对数量与继承确认值");
      if (returnedStatus >= 7) await expect(dialog).toContainText("1.250");
      await expect(dialog).toContainText("37.02");
      if (returnedStatus === 7) await captureEvidence(page, app, "inheritance-confirmation");
      await dialog.locator("label.arco-checkbox").click();
      await dialog.getByRole("button", { name: "确认重提", exact: true }).dblclick();
      await expect(dialog).toContainText("服务端已确认计划");
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
  test(`returned selection requires one plan; mixed=${mixed}`, { timeout: 90000 }, async (t) => {
    const { frame, submitted, approved } = await fixture(t);
    await selectPlan(frame);
    await selectPlan(frame, mixed ? "沈阳待审批" : "济南退回区域");
    await expect(frame.getByRole("button", { name: "修改后提交", exact: true })).toBeDisabled();
    await expect(frame.getByRole("button", { name: "修改后提交", exact: true })).toHaveAttribute(
      "title",
      /逐笔/,
    );
    assert.deepEqual(submitted, []);
    assert.deepEqual(approved, []);
  });

test(
  "successful submission with incomplete readback survives close and only resumes reading",
  { timeout: 90000 },
  async (t) => {
    const { frame, page, app, submitted, allowReadback } = await fixture(t, {
      readbackFailure: true,
    });
    await selectPlan(frame);
    await frame.getByRole("button", { name: "修改后提交", exact: true }).click();
    const dialog = frame.getByRole("dialog", { name: "真实销售计划退回重提", exact: true });
    await expect(dialog.getByRole("textbox", { name: "提报数量 789" })).toBeVisible();
    await dialog.locator("label.arco-checkbox").click();
    await dialog.getByRole("button", { name: "确认重提", exact: true }).click();
    await expect(dialog).toContainText("重提已成功");
    await expect(dialog).not.toContainText("未更新");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await selectPlan(frame);
    await selectPlan(frame, "济南退回区域");
    await frame.getByRole("button", { name: "修改后提交", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(frame.getByText(`计划 ${PLAN_A} 仍有待核对`, { exact: false })).toBeVisible();
    await frame.getByRole("button", { name: "刷新数据", exact: true }).click();
    await expect(frame.locator("tbody tr").filter({ hasText: "乌鲁木齐退回区域" })).toHaveCount(0);
    await captureEvidence(page, app, "pending-receipt-recovery");
    allowReadback();
    await frame.getByRole("button", { name: "恢复待处理重提", exact: true }).click();
    await expect(dialog).toContainText(PLAN_A);
    await dialog.getByRole("button", { name: "刷新权威状态", exact: true }).click();
    await expect(dialog).toContainText("服务端已确认计划");
    assert.equal(submitted.length, 1);
  },
);

test(
  "service configuration unavailable permits review but blocks submission",
  { timeout: 90000 },
  async (t) => {
    const { frame, page, app, submitted } = await fixture(t, { serviceReady: false });
    await selectPlan(frame);
    await frame.getByRole("button", { name: "修改后提交", exact: true }).click();
    const dialog = frame.getByRole("dialog", { name: "真实销售计划退回重提", exact: true });
    await expect(dialog).toContainText("服务凭据或用户授权未就绪");
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
    const dialog = frame.getByRole("dialog", { name: "真实销售计划退回重提", exact: true });
    await expect(dialog.getByRole("textbox", { name: "提报数量 789" })).toBeVisible();
    await dialog.locator("label.arco-checkbox").click();
    await dialog.getByRole("button", { name: "确认重提", exact: true }).click();
    await expect(dialog).toContainText("结果暂时未知");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await frame.getByRole("button", { name: "恢复待处理重提", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "提报数量 789" })).toHaveValue("2.000");
    await dialog.getByRole("button", { name: "以原幂等键重试", exact: true }).click();
    await expect(dialog).toContainText("服务端已确认计划");
    assert.equal(submitted.length, 2);
    assert.deepEqual(submitted[1], submitted[0]);
    assert.equal(state.get(PLAN_A).seq, 2);
  },
);

test(
  "normal pending records retain batch approval without submission",
  { timeout: 90000 },
  async (t) => {
    const { frame, approved, submitted } = await fixture(t, { normalBatch: true });
    await selectPlan(frame, "济南退回区域");
    await selectPlan(frame, "沈阳待审批");
    await frame.getByRole("button", { name: "通过", exact: true }).click();
    const dialog = frame.getByTestId("regional-approval-batch-action-dialog");
    await dialog.locator("label.arco-checkbox").click();
    await frame.getByRole("button", { name: "确认批量通过", exact: true }).click();
    await expect(frame.getByTestId("regional-approval-batch-result")).toContainText("成功 2 笔", {
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
    const { frame, submitted, approved } = await fixture(t, { denySubmit: true });
    await selectPlan(frame);
    await frame.getByRole("button", { name: "修改后提交", exact: true }).click();
    const dialog = frame.getByRole("dialog", { name: "真实销售计划退回重提", exact: true });
    await expect(dialog.getByRole("textbox", { name: "提报数量 789" })).toBeVisible();
    await dialog.locator("label.arco-checkbox").click();
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
  const dialog = frame.getByRole("dialog", { name: "真实销售计划退回重提", exact: true });
  await expect(dialog.getByRole("textbox", { name: "提报数量 789" })).toBeVisible();
  await dialog.locator("label.arco-checkbox").click();
  await dialog.getByRole("button", { name: "确认重提", exact: true }).click();
  await expect(dialog).toContainText("结果暂时未知");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const resume = frame.getByRole("button", { name: "恢复待处理重提", exact: true });
  await expect(resume).toBeVisible();
  await app.rpc("logout");
  await expect(resume).not.toBeVisible();
  await app.login();
  await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
  await expect(resume).toHaveCount(0);
  assert.equal(submitted.length, 1);
});
