import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";
import { testBrowser } from "./fixtures/test-browser.mjs";

test("节点百分比悬停显示分子/分母", { timeout: 90000 }, async (t) => {
  const app = await profile(t);
  const plan = {
    planId: "p-jxs-2026-09-00001",
    versionId: "v",
    seq: 1,
    periodId: "period-1",
    planTypeCode: "Y",
    orderType: "M",
    cust_code: 10070026,
    dealerName: "客户A",
    sales_group_code: "org",
    orgName: "宝阳销售组",
    province_region_code: "province",
    provinceName: "华南省区",
    region_code: "area",
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
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => {
      reply({ success: true, result });
      return true;
    };
    if (path.endsWith("/plans")) {
      const status = req.url.searchParams.get("status");
      const size = Number(req.url.searchParams.get("pageSize") ?? 20);

      if (status === null)
        return send({ records: size > 1 ? [plan] : [], total: 4, pages: 4, current: 1, size });
      return send({
        records: status === "1" ? [plan] : [],
        total: status === "1" ? 1 : 0,
        pages: 1,
        current: 1,
        size,
      });
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
  if (!(await frame.getByTestId("regional-approval-flow-lane").isVisible()))
    await frame.getByTestId("regional-approval-flow-toggle").click();

  const progressOf = (stage) =>
    frame.getByTestId(`regional-approval-stage-${stage}`).locator("small");

  await expect(progressOf("customer")).toHaveAttribute("title", "本节点已完成 1 单 / 该月共 4 单");
  await expect(progressOf("customer")).toContainText("进度 25%");
  await expect(progressOf("region")).toHaveAttribute("title", "本节点已完成 0 单 / 该月共 4 单");
  await expect(progressOf("category")).toHaveAttribute("title", "本节点已完成 0 单 / 该月共 4 单");
});
