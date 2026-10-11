import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";

/**
 * 账号角色原来只在登录时解析一次并缓存，管理员改完权限得重新登录才生效。
 * 现在点界面上的「刷新数据」会重新解析角色并覆盖节点口径。这条钉住：
 * 刷新前按旧角色亮节点，刷新后按新角色亮，而且确实又请求了一次当前用户解析。
 */
test(
  "the refresh button re-resolves account roles and updates clickable nodes",
  { timeout: 90000 },
  async (t) => {
    const roles = [{ code: "sales_plan_region_approver", name: "区域审批" }];
    const app = await profile(t, { roles });
    const plan = {
      planId: "p",
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
    let resolves = 0;
    app.route((req, _res, reply) => {
      const path = req.url.pathname;
      const send = (result) => {
        reply({ success: true, result });
        return true;
      };
      if (path.endsWith("/ai/gateway/agent/session/current-user/resolve")) {
        resolves += 1;
        return false;
      }
      if (path.endsWith("/plans")) {
        const status = req.url.searchParams.get("status");
        const records = status === null || status === "1" ? [plan] : [];
        return send({ records, total: records.length, pages: 1, current: 1, size: 20 });
      }
      if (path.endsWith("/plans/p"))
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
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1536, height: 920 },
    });
    await context.addCookies(
      app.cookie
        .split("; ")
        .map((pair) => ({
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

    const toggle = frame.getByTestId("regional-approval-flow-toggle");
    if (!(await frame.getByTestId("regional-approval-flow-lane").isVisible())) await toggle.click();
    await expect(toggle).toContainText("当前节点：城市经理审批");
    await expect(frame.getByTestId("regional-approval-stage-region")).toBeEnabled();
    await expect(frame.getByTestId("regional-approval-stage-province")).toBeDisabled();
    assert.ok(resolves >= 1, `登录时至少要解析一次角色，实际 ${resolves}`);
    const before = resolves;

    // 管理员把「区域审批」换成「省区审批」，用户不重新登录、只点刷新。
    roles.length = 0;
    roles.push({ code: "sales_plan_province_approver", name: "省区审批" });
    await frame.getByRole("button", { name: "刷新数据", exact: true }).click();
    await expect(toggle).toContainText("当前节点：省区审批", { timeout: 20000 });
    await expect(frame.getByTestId("regional-approval-stage-province")).toBeEnabled();
    await expect(frame.getByTestId("regional-approval-stage-region")).toBeDisabled();
    assert.ok(resolves > before, `点刷新要重新解析角色，实际 ${before} -> ${resolves}`);
  },
);
