import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

/** 暂存失败提示必须贴着改过的数字，重试成功后原地消失，不再占用表格顶部通栏。 */
test(
  "inline draft status sits next to the edited number and clears after retry",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t);
    const plan = {
      planId: "p",
      versionId: "v",
      seq: 1,
      periodId: "period-1",
      planTypeCode: "Y",
      orderType: "M",
      dealerCode: "d",
      dealerName: "客户A",
      orgCode: "region",
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
    app.route((req, _res, reply) => {
      const path = req.url.pathname;
      const send = (result) => {
        reply({ success: true, result });
        return true;
      };
      if (path.endsWith("/getPermCode"))
        return send({ codeList: ["sales-plan:plan:region-approve"] });
      // 队列会按节点状态分别取数，同一条计划只能出现一次。
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
          actionContext: {
            versionId: "v",
            status: 1,
            nodeOrder: 2,
            allowedActions: ["APPROVE", "REJECT"],
            snapshotHash: "a".repeat(64),
          },
        });
      if (path.endsWith("/versions")) return send([{ ...plan, id: "v", effective: true }]);
      if (path.endsWith("/versions/v/skus")) return send([sku]);
      return false;
    });
    await app.login();
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
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
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: /内测声明|预览版说明/, exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    const frame = page.frameLocator("iframe[data-gea-workbench]");
    await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
    await frame
      .getByRole("button", { name: /宝阳销售组/ })
      .first()
      .click();
    const input = frame.getByRole("spinbutton", { name: "确认计划量 1001", exact: true });
    await expect(input).toBeVisible();
    // 明细表嵌在队列行的展开格里，取最近的一层 td 才是数字所在的单元格。
    const cell = input.locator("xpath=ancestor::td[1]");

    // 让暂存请求失败，模拟服务端拒绝。
    let failWrites = true,
      writeAttempts = 0;
    await page.route("**/api/gea-proof/sales-plan/draft", async (route) => {
      const payload = route.request().postDataJSON();
      if (!payload.draft) {
        await route.continue();
        return;
      }
      writeAttempts++;
      if (failWrites) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "GEA_DRAFT_NOT_EDITABLE", message: "当前角色不具备该版本的调整权限" },
          }),
        });
        return;
      }
      await route.continue();
    });
    await input.fill("22.125");
    await expect(cell.getByText("暂存失败", { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(cell.getByRole("button", { name: "重试", exact: true })).toBeVisible();
    // 提示只出现在改过的那一行，并且必须落在数字所在单元格内（不是表格顶部通栏）。
    await expect(frame.getByText("暂存失败", { exact: true })).toHaveCount(1);
    assert.equal(
      await frame
        .getByText("暂存失败", { exact: true })
        .evaluate((el) => el.closest("td") !== null),
      true,
      "提示必须在数字所在单元格内",
    );

    failWrites = false;
    await cell.getByRole("button", { name: "重试", exact: true }).click();
    await expect.poll(() => writeAttempts, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
    await expect(frame.getByText("暂存失败", { exact: true })).toHaveCount(0, { timeout: 10000 });
    await expect(frame.locator("td").getByRole("status")).toHaveCount(0, { timeout: 10000 });
    const stored = await app.rpc("sales-plan/draft", { planId: "p", versionId: "v" });
    assert.equal(stored.ok, true);
    assert.deepEqual(stored.value.draft.adjustments, [{ skuCode: "1001", adjustQty: "2.125" }]);
    assert.deepEqual(errors, []);
  },
);
