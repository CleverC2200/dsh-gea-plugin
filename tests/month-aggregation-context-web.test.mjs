import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";

test(
  "one month merges Y and DC plans and synchronises the combined page with the conversation",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      roles: [{ code: "sales_plan_province_approver", name: "省区审批" }],
    });
    const plans = {
      20261001: {
        planId: "plan-y",
        versionId: "version-y",
        seq: 1,
        periodId: "20261001",
        planTypeCode: "Y",
        status: 2,
        baseName: "月度计划客户",
        dealerCode: "dealer-y",
        dealerName: "月度计划客户",
        orgCode: "org",
        orgName: "南京直营分区",
        provinceCode: "province",
        provinceName: "华东直营省区",
        areaCode: "area",
        areaName: "直营渠道销售",
        currentQty: "1",
        currentAmount: "10",
        targetQty: "2",
        targetAmount: "20",
        skuCount: 0,
      },
      20261002: {
        planId: "plan-dc",
        versionId: "version-dc",
        seq: 1,
        periodId: "20261002",
        planTypeCode: "DC",
        status: 2,
        baseName: "大仓计划客户",
        dealerCode: "dealer-dc",
        dealerName: "大仓计划客户",
        orgCode: "org",
        orgName: "南京直营分区",
        provinceCode: "province",
        provinceName: "华东直营省区",
        areaCode: "area",
        areaName: "直营渠道销售",
        currentQty: "3",
        currentAmount: "30",
        targetQty: "4",
        targetAmount: "40",
        skuCount: 0,
      },
      20260901: {
        planId: "plan-history",
        versionId: "version-history",
        seq: 1,
        periodId: "20260901",
        planTypeCode: "Y",
        status: 10,
        baseName: "历史计划客户",
        dealerCode: "dealer-history",
        dealerName: "历史计划客户",
        orgCode: "org",
        orgName: "南京直营分区",
        provinceCode: "province",
        provinceName: "华东直营省区",
        areaCode: "area",
        areaName: "直营渠道销售",
        currentQty: "1",
        currentAmount: "10",
        targetQty: "1",
        targetAmount: "10",
        skuCount: 0,
      },
    };
    app.route((req, _res, reply) => {
      const path = req.url.pathname;
      const send = (result) => {
        reply({ success: true, result });
        return true;
      };
      if (path.endsWith("/ai/gateway/sql/execute")) {
        const body = JSON.parse(req.body);
        const rows = [
          ...["0", "1", "2", "3", "4", "Y"].map((node, index) => ({
            id: String(index + 1),
            type_code: "Y",
            examine_level: String(index),
            node_num: node,
          })),
          ...["0", "2", "3", "4", "Y"].map((node, index) => ({
            id: String(index + 7),
            type_code: "DC",
            examine_level: String(index),
            node_num: node,
          })),
        ];
        reply({
          success: true,
          code: 200,
          result: {
            requestId: req.headers["x-request-id"],
            operation: "SELECT",
            tables: ["agents_scm_plan_workflow_config"],
            total: rows.length,
            pageNo: body.pageNo,
            pageSize: body.pageSize,
            rows,
          },
        });
        return true;
      }
      if (path.endsWith("/getPermCode"))
        return send({ codeList: ["sales-plan:plan:province-approve"] });
      if (path.endsWith("/plans")) {
        const periodId = req.url.searchParams.get("periodId");
        const candidates =
          periodId === null ? Object.values(plans) : [plans[periodId]].filter(Boolean);
        const status = req.url.searchParams.get("status");
        const records = candidates.filter(
          (plan) => status === null || Number(status) === plan.status,
        );
        return send({
          records,
          total: records.length,
          current: Number(req.url.searchParams.get("pageNo") ?? 1),
          size: Number(req.url.searchParams.get("pageSize") ?? 20),
          pages: 1,
        });
      }
      const detail = Object.values(plans).find((plan) => path.endsWith("/plans/" + plan.planId));
      if (detail)
        return send({
          currentVersion: { ...detail, id: detail.versionId, effective: true, orderType: "M" },
          skus: [],
          versions: [],
          logs: [],
          actionContext: {
            versionId: detail.versionId,
            status: detail.status,
            nodeOrder: 3,
            allowedActions: ["APPROVE", "REJECT"],
            snapshotHash: "a".repeat(64),
          },
        });
      if (path.endsWith("/versions")) return send([]);
      if (path.endsWith("/skus")) return send([]);
      if (path.endsWith("/notifications")) return send({ items: [], total: 0 });
      return false;
    });
    await app.login();
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1440, height: 900 },
    });
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const page = await context.newPage();
    const contextPayloads = [];
    const listResponses = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/agent-workbench/page")) {
        const body = request.postDataJSON();
        if (body.operation === "context") contextPayloads.push(body.parameters);
      }
    });
    page.on("response", async (response) => {
      if (!response.url().endsWith("/api/gea-proof/workbench/query")) return;
      const request = response.request().postDataJSON();
      if (request.kind !== "list") return;
      const payload = await response.json();
      if (payload.value?.records?.length)
        listResponses.push({
          query: request.query,
          plans: payload.value.records.map((row) => row.planId),
        });
    });
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: /内测声明|预览版说明/, exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    const frame = await openSalesPlan(page);
    const month = frame.getByRole("combobox", { name: "销售计划周期" });
    await expect(month).toHaveText("2026-10");
    await month.click();
    const options = frame.getByRole("option");
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toHaveText("2026-10");
    await expect(options.nth(1)).toHaveText("2026-09");
    await expect(frame.locator("body")).not.toContainText("2026-10 · Y");
    await expect(frame.locator("body")).not.toContainText("2026-10 · DC");
    await page.keyboard.press("Escape");
    await frame.getByRole("tab", { name: "按客户", exact: true }).click();
    await expect(frame.locator("tbody").first()).toContainText("月度计划客户");
    assert.deepEqual(
      [
        ...new Set(
          app.requests
            .filter(
              (req) => req.url.pathname.endsWith("/plans") && req.url.searchParams.has("periodId"),
            )
            .map(
              (req) =>
                `${req.url.searchParams.get("periodId")}:${req.url.searchParams.get("planTypeCode")}`,
            ),
        ),
      ].toSorted(),
      ["20261001:Y", "20261002:DC"],
    );
    assert.equal(
      app.requests.some((req) => req.url.pathname.endsWith("/periods")),
      false,
    );
    const readContexts = () => contextPayloads.filter(Boolean);
    await expect.poll(() => readContexts().length).toBeGreaterThan(0);
    const combined = readContexts().at(-1);
    assert.ok(
      Number.isInteger(combined.sequence) && combined.sequence >= 1,
      JSON.stringify(combined),
    );
    assert.equal(combined.scope.month, "2026-10");
    assert.equal(combined.scope.planType, "mixed");
    assert.deepEqual(
      combined.visibleRows.map((row) => row.planId).toSorted(),
      ["plan-dc", "plan-y"],
      JSON.stringify(listResponses),
    );
    await expect(frame.locator("tbody").first()).toContainText("大仓计划客户");

    await frame.locator('label.arco-checkbox:has(input[value="plan-dc"])').click();
    await expect.poll(() => readContexts().at(-1)?.selectedPlanIds).toEqual(["plan-dc"]);
    const planRequests = app.requests.filter((req) => req.url.pathname.endsWith("/plans"));
    assert.ok(
      planRequests.some(
        (req) =>
          req.url.searchParams.get("periodId") === "20261001" &&
          req.url.searchParams.get("planTypeCode") === "Y",
      ),
    );
    assert.ok(
      planRequests.some(
        (req) =>
          req.url.searchParams.get("periodId") === "20261002" &&
          req.url.searchParams.get("planTypeCode") === "DC",
      ),
    );
  },
);
