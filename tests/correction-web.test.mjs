import { mkdir } from "node:fs/promises";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";
import { testBrowser } from "./fixtures/test-browser.mjs";

test(
  "correction tab uses an explicit Z query and blocks customers without an approved monthly baseline",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    let responseMode = "normal";
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/getPermCode")) {
        reply({ success: true, result: { codeList: ["sales-plan:plan:region-approve"] } });
        return true;
      }
      if (req.url.pathname.endsWith("/plans")) {
        const requestedStatus = req.url.searchParams.get("status");
        if (requestedStatus !== null && Number(requestedStatus) !== 1) {
          reply({
            success: true,
            result: { records: [], total: 0, current: 1, size: 20, pages: 1 },
          });
          return true;
        }
        reply({
          success: true,
          result: {
            records: [
              {
                planId: "p-jxs-2026-09-00001",
                versionId: "v",
                seq: 1,
                periodId: responseMode === "wrong-period" ? "20260902" : "20260901",
                planTypeCode: "Y",
                orderType:
                  responseMode === "monthly" ? "M" : (req.url.searchParams.get("orderType") ?? "Z"),
                dealerCode: "123",
                dealerName: "纠偏客户",
                status: 1,
                targetAmount: "1000",
                targetQty: "100",
                currentQty: "100",
                currentAmount: "1000",
                skuCount: 1,
                monthlyApproved: false,
                mPlanQty: "100",
                mPlanAmount: "800",
                shipQty: "25",
                shipAmount: "400",
              },
            ],
            total: 1,
            size: 20,
            current: 1,
            pages: 1,
          },
        });
        return true;
      }
    });
    await app.login();
    const browser = await testBrowser(t, () =>
      chromium.launch({ channel: "chrome", headless: true }),
    );
    const page = await browser.newPage({ locale: "zh-CN" });
    page.on("pageerror", (e) => console.error("PAGE ERROR", e.message));
    await page.context().addCookies(
      app.cookie.split("; ").map((p) => {
        const [name, ...v] = p.split("=");
        return { name, value: v.join("="), url: app.origin };
      }),
    );
    await page.goto(app.origin);
    const frame = await openSalesPlan(page);
    await expect(frame.getByRole("columnheader", { name: "月度目标", exact: true })).toBeVisible();
    await frame
      .getByRole("tab", { name: "纠偏", exact: true })
      .click({ timeout: 10000 })
      .catch(async (e) => {
        console.error(await frame.locator("body").innerText());
        throw e;
      });
    await expect(frame.getByText("纠偏客户", { exact: true })).toBeVisible();
    await expect(frame.getByText("不可纠偏：月初未终审", { exact: true })).toBeVisible();
    await expect(frame.getByRole("button", { name: "纠偏客户", exact: true })).toBeDisabled();
    assert.ok(app.requests.some((r) => r.url.searchParams.get("orderType") === "Z"));
    await expect(frame.getByRole("combobox", { name: "纠偏周期", exact: true })).toContainText(
      "2026-09",
    );
    responseMode = "monthly";
    await frame.getByRole("button", { name: "刷新纠偏", exact: true }).click();
    await expect(frame.getByRole("button", { name: "纠偏客户", exact: true })).toBeDisabled();
    await expect(frame.getByText("不可纠偏：月初未终审", { exact: true })).toBeVisible();
    responseMode = "wrong-period";
    await frame.getByRole("button", { name: "刷新纠偏", exact: true }).click();
    await expect(frame.getByText(/其他周期或非纠偏数据/)).toBeVisible();
    assert.equal(
      app.requests.filter((request) => request.url.pathname.endsWith("/actions")).length,
      0,
    );
    await expect(frame.getByText("纠偏客户", { exact: true })).toHaveCount(0);
    await expect(frame.getByTestId("correction-summary")).toContainText("目标金额");
    await expect(frame.getByTestId("correction-summary").locator("strong")).toHaveText([
      "—",
      "—",
      "—",
      "—",
    ]);
  },
);

import { correctionService } from "./fixtures/correction-service.mjs";
test(
  "correction saves absolute drafts, blocks returned approvals, and reconciles legal terminal DMS mock",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      roles: ["region", "province", "area", "category"].map((role) => ({
        code: `sales_plan_${role}_approver`,
        name: role,
      })),
    });
    let service = correctionService();
    app.route(service.route);
    await app.login();
    const browser = await testBrowser(t, () =>
      chromium.launch({ channel: "chrome", headless: true }),
    );
    const page = await browser.newPage({ locale: "zh-CN" });
    await page.context().addCookies(
      app.cookie.split("; ").map((p) => ({
        name: p.slice(0, p.indexOf("=")),
        value: p.slice(p.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    await page.goto(app.origin);
    const f = await openSalesPlan(page);
    await f.getByRole("tab", { name: "纠偏", exact: true }).click();
    await expect(f.getByRole("tab", { name: "纠偏", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      f.getByTestId("correction-workbench").getByText("50.0%", { exact: true }),
    ).toBeVisible();
    const open = async () => {
      const status = service.detail().currentVersion.status;
      const node =
        status >= 5 && status <= 10 && status !== 9
          ? "品类计划审批"
          : { 1: "城市经理", 2: "省区经理", 3: "大区总监", 4: "品类计划审批", 9: "大区总监" }[
              status
            ];
      const toggle = f.locator('button[aria-controls="correction-stage-lane"]');
      if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
      const lane = f.getByRole("navigation", { name: "纠偏查看节点", exact: true });
      await lane
        .getByRole("button", {
          name: new RegExp((status === 5 || status === 10 ? "当前节点" : node) + "$"),
        })
        .click();
      await f.getByRole("button", { name: "纠偏客户", exact: true }).click();
    };
    for (const outcome of ["reject", "approve"]) {
      if (outcome === "approve") {
        service = correctionService();
        app.route(service.route);
        await f.getByRole("button", { name: "刷新纠偏", exact: true }).click();
      }
      await open();
      const d = f.getByRole("dialog", { name: "纠偏调整明细", exact: true });
      await expect(d.getByRole("textbox", { name: "调整量 123" })).toHaveValue("2");
      await mkdir(".runtime/correction-evidence", { recursive: true });
      await page.screenshot({
        path: ".runtime/correction-evidence/detail.png",
        fullPage: true,
        animations: "disabled",
      });
      await d.getByRole("textbox", { name: "调整量 123" }).fill("8");
      await d.getByRole("button", { name: "保存调整", exact: true }).click();
      await expect(d).toHaveCount(0);
      assert.equal(service.detail().skus[0].regionAdjAddQty, "8");
      assert.equal(service.detail().skus[0].regionAdjAddAmount, "16.00");
      assert.equal(service.detail().skus[0].regionAdjCutAmount, "0.00");
      assert.equal(service.detail().skus[0].regionConfirmedQty, undefined);
      assert.equal(service.detail().currentVersion.status, 1);
      for (const _stage of [1, 2]) {
        await open();
        await expect(d.getByRole("textbox", { name: "调整量 123" })).toHaveValue("8");
        await d.getByRole("button", { name: "通过", exact: true }).click();
        await expect(d).toHaveCount(0);
      }
      assert.equal(service.detail().skus[0].provinceConfirmedQty, "38");
      await open();
      await d.getByRole("textbox", { name: "调整量 123" }).fill("-31");
      await expect(d.getByRole("button", { name: "通过", exact: true })).toBeDisabled();
      await d.getByRole("textbox", { name: "调整量 123" }).fill("-3");
      await d.getByRole("button", { name: "通过", exact: true }).click();
      await expect(d).toHaveCount(0);
      assert.equal(service.detail().skus[0].areaConfirmedQty, "27");
      await open();
      if (outcome === "reject") {
        await d.getByRole("textbox", { name: "退回原因" }).fill("重新核对");
        await d.getByRole("button", { name: "退回", exact: true }).click();
        await expect(d).toHaveCount(0);
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
        const writes = service.writes.length;
        const requests = app.requests.filter((r) => r.url.pathname.endsWith("/actions")).length;
        await open();
        for (const name of ["保存调整", "通过", "退回"])
          await expect(d.getByRole("button", { name, exact: true })).toBeDisabled();
        await d.getByRole("button", { name: "关闭", exact: true }).click();
        assert.equal(service.writes.length, writes);
        assert.equal(
          app.requests.filter((r) => r.url.pathname.endsWith("/actions")).length,
          requests,
        );
        assert.equal(service.detail().currentVersion.status, 9);
        continue;
      }
      await d.getByRole("button", { name: "通过", exact: true }).click();
      await expect(d).toHaveCount(0);
      assert.equal(service.detail().currentVersion.status, 5);
      service.deliver("partial");
      await open();
      await expect(d.getByText("DMS mock · UNKNOWN", { exact: true })).toBeVisible();
      await d.getByRole("button", { name: "关闭", exact: true }).click();
      service.reconcile();
      service.deliver("success");
      await f.getByRole("button", { name: "刷新纠偏", exact: true }).click();
      await open();
      await expect(d.getByText("DMS mock · SYNCED", { exact: true })).toBeVisible();
      assert.equal(service.detail().currentVersion.status, 10);
    }
  },
);
