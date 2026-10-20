import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";
import { testBrowser } from "./fixtures/test-browser.mjs";

test(
  "granted visible region role directly approves tracking rows when current-node capabilities are empty",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t);
    const plan = {
      planId: "p-jxs-2026-09-00001",
      versionId: "v-role-visible",
      periodId: "20260901",
      planTypeCode: "Y",
      orderType: "M",
      status: 2,
      baseName: "跨节点区域审批",
      orgCode: "region-a",
      orgName: "region-a",
      dealerCode: "customer-a",
      currentQty: "1",
      currentAmount: "10",
      targetAmount: "10",
      targetQty: "1",
      skuCount: 0,
    };

    const writes = [];
    app.route((req, _res, reply) => {
      const path = req.url.pathname;
      const send = (result) => {
        reply({ success: true, result });
        return true;
      };
      if (path.endsWith("/getPermCode"))
        return send({ codeList: ["sales-plan:plan:region-approve"] });
      if (path.endsWith("/periods"))
        return send({
          records: [
            {
              periodId: "20260901",
              periodMonth: "2026-09",
              planTypeCode: "Y",
              orderType: "M",
              status: "CLOSED",
            },
          ],
          total: 1,
          current: 1,
          size: 100,
        });
      if (path.endsWith("/plans")) {
        const requestedStatus = req.url.searchParams.get("status");
        const records =
          requestedStatus === null || Number(requestedStatus) === plan.status ? [plan] : [];
        return send({ records, total: records.length, current: 1, size: 20, pages: 1 });
      }
      if (path.endsWith(`/plans/${plan.planId}`))
        return send({
          currentVersion: { ...plan, id: plan.versionId, effective: true },
          versions: [],
          skus: [],
          logs: [],
          actionContext: {
            versionId: plan.versionId,
            status: plan.status,
            snapshotHash: "a".repeat(64),
            policy: "role-visible-v1",
            allowedActions: [],
            roleActions: [],
          },
        });
      if (path.endsWith("/notifications")) return send({ items: [], total: 0 });
      if (path.endsWith("/versions"))
        return send([{ ...plan, id: plan.versionId, effective: true }]);
      if (path.endsWith("/skus")) return send([]);
      if (path.endsWith(`/versions/${plan.versionId}/actions`)) {
        writes.push(JSON.parse(req.body));
        return send({
          planId: plan.planId,
          versionId: plan.versionId,
          fromStatus: 2,
          toStatus: 2,
          approvalRole: "region",
          requestId: req.headers["x-request-id"],
          traceId: "t",
          auditId: "a",
          replayed: false,
        });
      }
      return false;
    });

    await app.login();
    const browser = await testBrowser(t, () =>
      chromium.launch({ channel: "chrome", headless: true }),
    );
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1280, height: 800 },
    });
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const page = await context.newPage();
    await page.goto(app.origin);

    const frame = await openSalesPlan(page);
    // V1.8 #05：流程图默认收起，先展开再操作节点。
    if (!(await frame.getByTestId("regional-approval-flow-lane").isVisible()))
      await frame.getByTestId("regional-approval-flow-toggle").click();
    const region = frame.getByTestId("regional-approval-stage-region");
    await expect(region).toHaveAttribute("aria-pressed", "true");
    await region.click(); // Include tracking rows, not only this role's pending queue.
    const row = frame.locator("tbody tr").filter({ hasText: plan.baseName }).first();
    await expect(row).toBeVisible();
    await row.locator("label.arco-checkbox").click();
    const approve = frame.getByRole("button", { name: "通过", exact: true });
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(frame.getByRole("dialog", { name: "销售计划审批", exact: true })).toHaveCount(0);
    assert.equal(writes[0].action, "APPROVE");
    assert.equal(writes[0].approvalRole, "region");
    assert.equal(writes[0].approvalPolicy, "role-visible-v1");
    assert.equal(writes[0].expectedStatus, 2);
    assert.equal(writes[0].expectedSnapshot, "a".repeat(64));
  },
);
