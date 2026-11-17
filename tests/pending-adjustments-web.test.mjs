import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openReadySalesPlan } from "./fixtures/business-page.mjs";
import { testBrowser } from "./fixtures/test-browser.mjs";

const fixture = async (t) => {
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
  const writes = [];
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => {
      reply({ success: true, result });
      return true;
    };
    if (path.endsWith("/getPermCode"))
      return send({ codeList: ["sales-plan:plan:region-approve"] });

    if (path.endsWith("/plans")) {
      const status = req.url.searchParams.get("status");
      const records = status === null || status === "1" ? [plan] : [];
      return send({ records, total: records.length, pages: 1, current: 1, size: 20 });
    }
    if (path.endsWith("/plans/p-jxs-2026-09-00001"))
      return send({
        currentVersion: { ...plan, id: "v", effective: true },
        skus: [sku],
        versions: [],
        logs: [],
        actionContext: {
          versionId: "v",
          status: 1,
          nodeOrder: 2,
          allowedActions: ["SAVE", "APPROVE", "REJECT"],
          snapshotHash: "a".repeat(64),
        },
      });
    if (path.endsWith("/versions")) return send([{ ...plan, id: "v", effective: true }]);
    if (path.endsWith("/versions/v/skus")) return send([sku]);
    if (path.endsWith("/versions/v/actions")) {
      writes.push(JSON.parse(req.body));
      return send({
        planId: "p-jxs-2026-09-00001",
        versionId: "v",
        fromStatus: 1,
        toStatus: 2,
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
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.origin);
  const frame = await openReadySalesPlan(page);
  await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
  return { app, frame, writes, errors, page };
};

test(
  "inline edit right before approval still reaches the action body",
  { timeout: 90000 },
  async (t) => {
    const { frame, writes, errors } = await fixture(t);
    await frame.locator('label.arco-checkbox:has(input[value="p-jxs-2026-09-00001"])').click();
    await frame
      .getByRole("button", { name: /宝阳销售组/ })
      .first()
      .click();
    const input = frame.getByRole("spinbutton", { name: "确认计划量 1001", exact: true });
    await expect(input).toBeVisible();
    await expect(frame.locator("td").getByRole("status")).toHaveCount(0, { timeout: 10000 });

    await input.fill("22.125");
    await expect(input.locator("xpath=ancestor::td[1]").locator("small")).toHaveText("¥220.00");
    await frame.getByRole("button", { name: "通过", exact: true }).click();
    await expect.poll(() => writes.length, { timeout: 15000 }).toBe(1);
    assert.equal(writes[0].action, "APPROVE");
    assert.deepEqual(
      writes[0].adjustments,
      [{ skuCode: "1001", adjustQty: "2" }],
      "通过必须带上刚改的调整量",
    );

    await expect(frame.getByRole("dialog")).toHaveCount(0);
    assert.deepEqual(errors, []);
  },
);

test(
  "reverting the inline edit does not resubmit the old draft adjustment",
  { timeout: 90000 },
  async (t) => {
    const { frame, writes, errors } = await fixture(t);
    await frame
      .getByRole("button", { name: /宝阳销售组/ })
      .first()
      .click();
    const input = frame.getByRole("spinbutton", { name: "确认计划量 1001", exact: true });
    await expect(input).toBeVisible();
    await expect(frame.locator("td").getByRole("status")).toHaveCount(0, { timeout: 10000 });

    await input.fill("22.125");
    await expect(frame.getByText("正在暂存…", { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(frame.locator("td").getByRole("status")).toHaveCount(0, { timeout: 10000 });

    await input.fill("20");
    await frame.locator('label.arco-checkbox:has(input[value="p-jxs-2026-09-00001"])').click();
    await frame.getByRole("button", { name: "通过", exact: true }).click();
    await expect.poll(() => writes.length, { timeout: 15000 }).toBe(1);
    assert.equal(writes[0].action, "APPROVE");
    assert.equal(writes[0].adjustments, undefined, "改回原值后不能再提交草稿里的旧调整量");
    assert.deepEqual(errors, []);
  },
);
