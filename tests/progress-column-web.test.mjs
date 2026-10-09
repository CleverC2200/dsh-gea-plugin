import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

/**
 * V1.8 #09：达成率列用「细进度条 + 百分比」，百分比前不带「金额」，
 * 配色按 D23 推荐口径分档：<95% 红、95–100% 橙、≥100% 绿。
 */
test(
  "progress column shows a bar with percent-only text and threshold colours",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t);
    const plans = [
      { planId: "p1", versionId: "v1", qty: "50" },
      { planId: "p2", versionId: "v2", qty: "97" },
      { planId: "p3", versionId: "v3", qty: "120" },
    ].map((item, index) => ({
      ...item,
      seq: 1,
      periodId: "period-1",
      planTypeCode: "Y",
      orderType: "M",
      // 三条计划分别落在不同的组织维度上，保证它们是三行、不是一行汇总。
      dealerCode: `d${index}`,
      dealerName: `客户${index}`,
      orgCode: `org${index}`,
      orgName: `销售组${index}`,
      provinceCode: `province${index}`,
      provinceName: `华南省区${index}`,
      areaCode: `area${index}`,
      areaName: `华南大区${index}`,
      regionCode: `region${index}`,
      regionName: `区域${index}`,
      baseName: `基地${index}`,
      status: 1,
      currentQty: item.qty,
      currentAmount: item.qty,
      targetQty: "100",
      targetAmount: "100",
      skuCount: 1,
    }));
    const skuOf = (plan) => ({
      id: "s" + plan.planId,
      skuCode: "9001",
      versionId: plan.versionId,
      productCategName: "汤圆",
      materialDescription: "黑芝麻汤圆 500g",
      qty: plan.qty,
      baseQty: plan.qty,
      amt: plan.qty,
      amtBase: plan.qty,
      price: "1",
    });
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
        const records = status === null || status === "1" ? plans : [];
        return send({ records, total: records.length, pages: 1, current: 1, size: 20 });
      }
      const plan = plans.find((item) => path.endsWith("/plans/" + item.planId));
      if (plan)
        return send({
          currentVersion: { ...plan, id: plan.versionId, effective: true },
          skus: [skuOf(plan)],
          versions: [],
          logs: [],
        });
      if (path.endsWith("/versions"))
        return send(plans.map((plan) => ({ ...plan, id: plan.versionId, effective: true })));
      const skus = plans.find((item) => path.endsWith("/versions/" + item.versionId + "/skus"));
      if (skus) return send([skuOf(skus)]);
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
    page.setDefaultTimeout(15000);
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: /内测声明|预览版说明/, exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    const frame = page.frameLocator("iframe[data-gea-workbench]");
    await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
    await expect.poll(async () => (await cellInfo(frame)).length, { timeout: 30000 }).toBe(3);

    // 进度条颜色带过渡动画，等它稳定后再断言。
    const expected = [
      ["50.0%", "rgb(245, 63, 63)", "低于 95% 用红色"],
      ["97.0%", "rgb(255, 125, 0)", "95–100% 用橙色"],
      ["120.0%", "rgb(0, 180, 42)", "≥100% 用绿色"],
    ];
    for (const [text, color, message] of expected)
      await expect
        .poll(async () => (await cellInfo(frame)).find((cell) => cell.text === text)?.color, {
          timeout: 8000,
        })
        .toBe(color, { message });
    // 宽度也是动画出来的，等颜色稳定后再量。
    await expect
      .poll(async () => (await cellInfo(frame)).every((cell) => cell.barWidth > 20), {
        timeout: 8000,
      })
      .toBe(true);
    const cells = await cellInfo(frame);
    assert.deepEqual(
      cells.map((cell) => cell.text).toSorted(),
      ["120.0%", "50.0%", "97.0%"],
      "百分比前不再带「金额」",
    );
    for (const cell of cells) {
      assert.ok(
        cell.text.includes("%") && !cell.text.includes("金额"),
        `达成率文案应为纯百分比，实际「${cell.text}」`,
      );
    }
  },
);

const cellInfo = (frame) =>
  frame.locator("tbody tr").evaluateAll((rows) =>
    rows
      .map((row) => {
        const label = row.querySelector("strong");
        const bar = row.querySelector(".arco-progress-line-inner");
        if (!label || !bar) return undefined;
        const text = (label.textContent || "").trim();
        return text.endsWith("%")
          ? {
              text,
              color: getComputedStyle(bar).backgroundColor,
              barWidth: Math.round(bar.getBoundingClientRect().width),
            }
          : undefined;
      })
      .filter(Boolean),
  );
