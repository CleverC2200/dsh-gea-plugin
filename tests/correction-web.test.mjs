import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openReadySalesPlan } from "./fixtures/business-page.mjs";
import { testBrowser } from "./fixtures/test-browser.mjs";
import { correctionService } from "./fixtures/correction-service.mjs";

const roles = ["region", "province", "area", "category"];
const actionRequests = (app) =>
  app.requests.filter((request) => request.url.pathname.endsWith("/actions"));
const customerRow = (frame) => frame.getByRole("row").filter({ hasText: "纠偏客户" }).first();

async function openProfile(t, app) {
  await app.login();
  const browser = await testBrowser(t, () =>
    chromium.launch({ channel: "chrome", headless: true }),
  );
  const page = await browser.newPage({ locale: "zh-CN" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.context().addCookies(
    app.cookie.split("; ").map((cookie) => ({
      name: cookie.slice(0, cookie.indexOf("=")),
      value: cookie.slice(cookie.indexOf("=") + 1),
      url: app.origin,
    })),
  );
  await page.goto(app.origin);
  return openReadySalesPlan(page);
}

async function selectStage(frame, role) {
  const expand = frame.getByRole("button", { name: "展开审批流程图", exact: true });
  if (await expand.isVisible()) await expand.click();
  const stage = frame.getByTestId("regional-approval-stage-" + role);
  await expect(stage).toBeEnabled();
  if ((await stage.getAttribute("aria-pressed")) !== "true") await stage.click();
  await frame.getByRole("tab", { name: "按客户", exact: true }).click();
  await expect(customerRow(frame)).toBeVisible();
}

async function selectCustomer(frame) {
  const checkbox = customerRow(frame).getByRole("checkbox");
  await expect(checkbox).toBeEnabled();
  if (!(await checkbox.isChecked())) await checkbox.locator("..").click();
}

test(
  "shared correction query keeps Z scope and rejects unapproved, monthly-source and wrong-period writes",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    const service = correctionService({ monthlyApproved: false });
    app.route(service.route);
    const frame = await openProfile(t, app);
    const workbench = frame.getByTestId("regional-approval-workbench");
    await frame.getByRole("tab", { name: "纠偏", exact: true }).click();
    await selectStage(frame, "region");
    await expect(workbench).toBeVisible();
    await expect(customerRow(frame).getByRole("checkbox")).toBeDisabled();
    for (const name of ["通过", "退回"])
      await expect(frame.getByRole("button", { name, exact: true })).toBeDisabled();
    assert.ok(app.requests.some((request) => request.url.searchParams.get("orderType") === "Z"));
    await expect(frame.getByRole("combobox", { name: "销售计划周期", exact: true })).toContainText(
      "2026-09",
    );

    service.setResponseMode("monthly");
    await frame.getByRole("tab", { name: "月初", exact: true }).click();
    await frame.getByRole("tab", { name: "纠偏", exact: true }).click();
    await selectStage(frame, "region");
    await expect(customerRow(frame)).toContainText("月初来源（只读）");
    await expect(customerRow(frame).getByRole("checkbox")).toBeDisabled();
    for (const name of ["通过", "退回"])
      await expect(frame.getByRole("button", { name, exact: true })).toBeDisabled();

    service.setResponseMode("wrong-period");
    await frame.getByRole("tab", { name: "月初", exact: true }).click();
    await frame.getByRole("tab", { name: "纠偏", exact: true }).click();
    await expect(frame.getByText("审批队列读取失败", { exact: true })).toBeVisible();
    await expect(frame.getByRole("row").filter({ hasText: "纠偏客户" })).toHaveCount(0);
    for (const label of ["目标金额", "计划金额", "差额（计划 − 目标）", "计划数量"])
      await expect(
        workbench.getByText(label, { exact: true }).locator("..").locator("strong"),
      ).toHaveText("—");
    assert.equal(actionRequests(app).length, 0);
    assert.equal(service.writes.length, 0);
  },
);

test(
  "shared correction locally stages drafts and preserves frozen baselines through approvals, rejection and receipts",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      roles: roles.map((role) => ({ code: "sales_plan_" + role + "_approver", name: role })),
    });
    let service = correctionService({ versionId: "v-reject" });
    app.route(service.route);
    const frame = await openProfile(t, app);
    await frame.getByRole("tab", { name: "纠偏", exact: true }).click();

    const approve = async (from) => {
      await selectCustomer(frame);
      const button = frame.getByRole("button", { name: "通过", exact: true });
      await expect(button).toBeEnabled();
      await button.click();
      await expect.poll(() => service.detail().currentVersion.status).toBe(from + 1);
    };
    const open = async (role) => {
      await selectStage(frame, role);
      const button = frame.getByRole("button", {
        name: "打开 纠偏客户 调整明细",
        exact: true,
      });
      await button.click();
      const input = frame.getByRole("spinbutton", { name: "追加/追减 123", exact: true });
      await expect(input).toBeEnabled();
      return { input, button };
    };

    for (const outcome of ["reject", "approve"]) {
      if (outcome === "approve") {
        service = correctionService({ versionId: "v-approve" });
        app.route(service.route);
        await frame.getByRole("tab", { name: "月初", exact: true }).click();
        await frame.getByRole("tab", { name: "纠偏", exact: true }).click();
      }
      const initial = service.detail();
      const initialActions = actionRequests(app).length;
      const city = await open("region");
      await expect(city.input).toHaveValue("0");
      const skuRow = frame.getByRole("row").filter({ hasText: "冻结基准SKU" }).last();
      await expect(skuRow.getByRole("cell").nth(1)).toHaveText("30");
      await expect(skuRow.getByRole("cell").nth(3)).toHaveText("60");
      await city.input.fill("8");
      await expect
        .poll(async () => {
          const result = await app.rpc("sales-plan/draft", {
            planId: initial.currentVersion.planId,
            versionId: initial.currentVersion.id,
            approvalRole: "region",
          });
          return result.ok ? result.value.draft?.adjustments : undefined;
        })
        .toEqual([{ skuCode: "123", adjustQty: "8" }]);
      assert.equal(actionRequests(app).length, initialActions);
      assert.equal(service.writes.length, 0);
      assert.deepEqual(service.detail().skus, initial.skus);
      assert.equal(service.detail().currentVersion.status, 1);
      await city.button.click();
      await city.button.click();
      await expect(city.input).toHaveValue("8");
      await selectCustomer(frame);
      const current = frame.getByTestId("regional-approval-stage-region");
      await current.click();
      await expect(current).toHaveAttribute("aria-pressed", "true");
      await expect(customerRow(frame).getByRole("checkbox")).toBeChecked();
      await expect(city.input).toHaveValue("8");
      await approve(1);
      assert.equal(service.detail().skus[0].regionAdjAddQty, "8");
      assert.equal(service.detail().skus[0].regionAdjAddAmount, "16.00");
      assert.equal(service.detail().skus[0].regionAdjCutAmount, "0.00");
      assert.equal(service.detail().skus[0].regionConfirmedQty, "38");

      await open("province");
      await approve(2);
      assert.equal(service.detail().skus[0].provinceConfirmedQty, "38");
      assert.equal(service.detail().skus[0].provinceConfirmedAmount, "76");

      const area = await open("area");
      await area.input.fill("-39");
      await expect(frame.getByText("暂存失败", { exact: true })).toBeVisible();
      const beforeNegative = actionRequests(app).length;
      await selectCustomer(frame);
      const through = frame.getByRole("button", { name: "通过", exact: true });
      await through.click();
      await expect(
        frame
          .getByRole("alert")
          .filter({ hasText: "操作请求失败且未更新本地状态；请刷新权威队列后再决定。" })
          .first(),
      ).toBeVisible();
      await expect(through).toBeEnabled();
      assert.equal(actionRequests(app).length, beforeNegative);
      assert.equal(service.detail().currentVersion.status, 3);
      assert.equal(service.writes.length, 2);
      await area.input.fill("-3");
      await approve(3);
      assert.equal(service.detail().skus[0].areaConfirmedQty, "35");
      assert.equal(service.detail().skus[0].areaConfirmedAmount, "70");

      await open("category");
      if (outcome === "reject") {
        await selectCustomer(frame);
        await frame.getByRole("button", { name: "退回", exact: true }).click();
        const dialog = frame.getByRole("dialog", { name: "退回", exact: true });
        const confirm = dialog.getByRole("button", { name: "确认退回", exact: true });
        await expect(confirm).toBeDisabled();
        await dialog
          .getByRole("textbox", { name: "退回原因（必填）", exact: true })
          .fill("重新核对");
        await expect(confirm).toBeEnabled();
        await confirm.click();
        await expect(dialog).toHaveCount(0);
        assert.equal(service.detail().currentVersion.status, 9);
        assert.equal(service.detail().skus[0].areaAdjCutQty, "3");
        for (const suffix of [
          "AdjAddQty",
          "AdjCutQty",
          "AdjAddAmount",
          "AdjCutAmount",
          "ConfirmedQty",
          "ConfirmedAmount",
        ])
          assert.equal(service.detail().skus[0]["category" + suffix], null);
        await selectStage(frame, "area");
        await expect(frame.getByRole("button", { name: "通过", exact: true })).toHaveCount(0);
        assert.equal(service.writes.length, 4);
      } else {
        await approve(4);
        assert.equal(service.detail().currentVersion.status, 5);
        assert.equal(service.detail().skus[0].categoryConfirmedQty, "35");
        assert.equal(service.writes.length, 4);
      }

      const after = service.detail();
      for (const field of ["qty", "corrBaseQty", "amt", "price", "adjAddQty", "adjCutQty"])
        assert.equal(after.skus[0][field], initial.skus[0][field]);
      assert.deepEqual(
        service.writes.map((body) => body.action),
        ["APPROVE", "APPROVE", "APPROVE", outcome === "reject" ? "REJECT" : "APPROVE"],
      );
      assert.equal(service.receipts.length, 4);
      assert.equal(after.logs.length, 4);
      for (const [index, receipt] of service.receipts.entries()) {
        assert.equal(receipt.requestId, after.logs[index].requestId);
        assert.equal(receipt.auditId, "sales-plan-log:" + after.logs[index].id);
        assert.equal(receipt.toStatus, after.logs[index].toStatus);
        assert.equal(JSON.parse(after.logs[index].decisionJson)[0].skuCode, "123");
      }
      assert.equal(actionRequests(app).length, initialActions + 4);
    }
  },
);
