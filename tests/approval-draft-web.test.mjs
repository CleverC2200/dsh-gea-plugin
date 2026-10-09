import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";

for (const scenario of ["delayed", "stale", "unavailable"]) {
  test(
    `direct approval waits for its private draft: ${scenario}`,
    { timeout: 60000 },
    async (t) => {
      const app = await profile(t);
      const plan = {
        planId: "p",
        versionId: "v",
        periodId: "period-1",
        planTypeCode: "Y",
        status: 1,
        baseName: "草稿测试",
        orgCode: "region",
        orgName: "region",
        dealerCode: "dealer",
        currentQty: "20",
        currentAmount: "200",
        targetQty: "20",
        targetAmount: "200",
        skuCount: 1,
      };
      const sku = {
        id: "s",
        versionId: "v",
        skuCode: "1001",
        qty: "20",
        baseQty: "10",
        price: "10",
        amt: "200",
        amtBase: "100",
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
        if (path.endsWith("/plans"))
          return send({ records: [plan], total: 1, current: 1, size: 20, pages: 1 });
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
        if (path.endsWith("/versions/v/actions")) {
          writes.push(JSON.parse(req.body));
          return send({
            planId: "p",
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
      const source = await app.rpc("sales-plan/draft", { planId: "p", versionId: "v" });
      assert.equal(source.ok, true);
      const saved = await app.rpc("sales-plan/draft", {
        planId: "p",
        versionId: "v",
        draft: {
          planId: "p",
          versionId: "v",
          status: 1,
          sourceSnapshot: source.value.sourceSnapshot,
          remark: "",
          adjustments: [{ skuCode: "1001", adjustQty: "2.125" }],
        },
      });
      assert.equal(saved.ok, true, JSON.stringify(saved));
      const browser = await chromium.launch({ headless: true });
      t.after(() => browser.close());
      const page = await browser.newPage({
        locale: "zh-CN",
        viewport: { width: 1280, height: 800 },
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.context().addCookies(
        app.cookie.split("; ").map((pair) => ({
          name: pair.slice(0, pair.indexOf("=")),
          value: pair.slice(pair.indexOf("=") + 1),
          url: app.origin,
        })),
      );
      await page.goto(app.origin);
      const frame = await openSalesPlan(page);
      await frame.locator('label.arco-checkbox:has(input[value="p"])').click();
      const approve = frame.getByRole("button", { name: "通过", exact: true });
      await expect(approve).toBeEnabled();
      let draftCalls = 0;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      t.after(() => release());
      await page.route("**/api/gea-proof/sales-plan/draft", async (route) => {
        draftCalls++;
        if (scenario === "delayed") {
          await gate;
          await route.continue();
        } else
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(
              scenario === "stale"
                ? { ok: true, value: { draft: null, stale: true } }
                : { ok: false, error: { code: "GEA_UNAVAILABLE", message: "Unavailable" } },
            ),
          });
      });
      await approve.click();
      await expect.poll(() => draftCalls).toBe(1);
      assert.equal(
        writes.length,
        0,
        "approval cannot run before its draft is loaded and validated",
      );
      if (scenario === "delayed") {
        release();
        await expect.poll(() => writes.length).toBe(1);
        assert.deepEqual(writes[0].adjustments, [{ skuCode: "1001", adjustQty: "2.125" }]);
        assert.equal(writes[0].approvalRole, undefined, "上游报文只发接口文档声明的字段");
        assert.equal(writes[0].expectedSnapshot, undefined);
      } else {
        await expect(
          frame.getByText("操作请求失败且未更新本地状态；请刷新权威队列后再决定。", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(approve).toBeEnabled();
        assert.equal(writes.length, 0);
        const retained = await app.rpc("sales-plan/draft", { planId: "p", versionId: "v" });
        assert.deepEqual(retained.value.draft.adjustments, [
          { skuCode: "1001", adjustQty: "2.125" },
        ]);
      }
      await expect(frame.getByRole("dialog")).toHaveCount(0);
      assert.deepEqual(errors, []);
    },
  );
}
