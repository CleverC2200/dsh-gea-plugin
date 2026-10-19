import test from "./fixtures/source-test.mjs";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";
import { testBrowser } from "./fixtures/test-browser.mjs";

/**
 * 节点身份只认账号角色：有省区审批角色的账号进来就默认落到「省区审批」，
 * 而不是「全部节点」；通知和权限码都不参与判定。
 */
test("default node follows the account role, not every node", { timeout: 90000 }, async (t) => {
  const app = await profile(t, {
    roles: [{ code: "sales_plan_province_approver", name: "省区审批" }],
  });
  const plan = {
    planId: "p-jxs-2026-09-00001",
    versionId: "v",
    seq: 1,
    periodId: "period-1",
    planTypeCode: "Y",
    orderType: "M",
    dealerCode: "d",
    dealerName: "客户A",
    orgCode: "org",
    orgName: "宝阳销售组",
    provinceCode: "province",
    provinceName: "华南省区",
    areaCode: "area",
    areaName: "华南大区",
    status: 1,
    currentQty: "20",
    currentAmount: "200",
    targetQty: "40",
    targetAmount: "400",
    skuCount: 1,
  };
  const sku = {
    id: "s",
    skuCode: "1001",
    versionId: "v",
    productCategName: "汤圆",
    materialDescription: "黑芝麻汤圆 500g",
    qty: "20",
    baseQty: "10",
    amt: "200",
    amtBase: "100",
    price: "10",
  };
  const requestedStatuses = [];
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => {
      reply({ success: true, result });
      return true;
    };
    // 权限码全空：节点身份不再看它。
    if (path.endsWith("/getPermCode")) return send({ codeList: [] });
    // 上游故意派了同版本可处理任务：它只该被当成提醒，不改变节点口径。
    if (path.endsWith("/notifications/n"))
      return send({
        id: "n",
        approval: { bizKey: "sales-plan:version:v", instanceId: "i", actionable: true },
      });
    if (path.endsWith("/notifications"))
      return send({
        items: [
          {
            id: "n",
            approval: { bizKey: "sales-plan:version:v", instanceId: "i", actionable: true },
          },
        ],
        total: 1,
      });
    if (path.endsWith("/plans")) {
      const status = req.url.searchParams.get("status");
      requestedStatuses.push(status);
      // 省区审批节点看的是待省区确认（2）与退回到省区的（7/8）。
      const records = status === null || ["2", "7", "8"].includes(status) ? [plan] : [];
      return send({ records, total: records.length, pages: 1, current: 1, size: 20 });
    }
    if (path.endsWith("/plans/p-jxs-2026-09-00001"))
      return send({
        currentVersion: { ...plan, id: "v", effective: true },
        skus: [sku],
        versions: [],
        logs: [],
      });
    if (path.endsWith("/versions")) return send([{ ...plan, id: "v", effective: true }]);
    if (path.endsWith("/versions/v/skus")) return send([sku]);
    return false;
  });
  await app.login();
  const browser = await testBrowser(t, () =>
    chromium.launch({ channel: "chrome", headless: true }),
  );
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1536, height: 920 },
  });
  await context.addCookies(
    app.cookie.split("; ").map((pair) => ({
      name: pair.slice(0, pair.indexOf("=")),
      value: pair.slice(pair.indexOf("=") + 1),
      url: app.origin,
    })),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(app.origin);
  const frame = await openSalesPlan(page);
  await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();

  // 默认节点 = 账号角色对应的省区审批，不是「全部节点」。
  await expect(frame.getByTestId("regional-approval-flow-toggle")).toContainText(
    "当前节点：省区审批",
    { timeout: 20000 },
  );
  await expect
    .poll(() => requestedStatuses.filter((status) => status !== null).length, { timeout: 20000 })
    .toBeGreaterThanOrEqual(1); // 按省区审批节点的状态重新取数
  await frame.getByTestId("regional-approval-flow-toggle").click();
  await expect(frame.getByTestId("regional-approval-stage-province")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // 只有账号有角色的节点可点，其它节点留在表里但置灰。
  await expect(frame.getByTestId("regional-approval-stage-province")).toBeEnabled();
  for (const stage of ["customer", "region", "area", "category"])
    await expect(frame.getByTestId(`regional-approval-stage-${stage}`)).toBeDisabled();
});
