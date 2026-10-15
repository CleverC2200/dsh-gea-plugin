import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";
import { testBrowser } from "./fixtures/test-browser.mjs";

/** 建一条可编辑的计划并打开工作台，供本文件的样式断言复用。 */
const openWorkbench = async (t) => {
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
  await page.goto(app.origin);
  const frame = await openSalesPlan(page);
  await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
  return { frame, page };
};

/** V1.8 #02：可编辑的数量输入框要白底 + 浅灰描边 + 圆角，跟只读灰底区分开。 */
test("editable quantity inputs are white, outlined and rounded", { timeout: 90000 }, async (t) => {
  const { frame } = await openWorkbench(t);
  await frame
    .getByRole("button", { name: /宝阳销售组/ })
    .first()
    .click();
  const input = frame.getByRole("spinbutton", { name: "确认计划量 1001", exact: true });
  await expect(input).toBeVisible();

  let idle;
  await expect
    .poll(async () => {
      idle = await input.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          bg: s.backgroundColor,
          borderWidth: s.borderTopWidth,
          borderColor: s.borderTopColor,
          radius: s.borderRadius,
        };
      });
      return idle;
    })
    .toMatchObject({ bg: "rgb(255, 255, 255)", borderWidth: "1px" });
  assert.notEqual(idle.borderColor, "rgba(0, 0, 0, 0)", "描边不能是透明");
  assert.ok(parseFloat(idle.radius) >= 4, `圆角要明显，实际 ${idle.radius}`);

  // 聚焦时描边变色，方便看出当前在改哪一格。
  await input.click();
  // 边框带过渡动画，聚焦后要等一小会儿再读计算值。
  await expect
    .poll(() => input.evaluate((el) => getComputedStyle(el).borderTopColor), { timeout: 3000 })
    .not.toBe(idle.borderColor);
});

/** V1.8 #03：顶部标签加粗，取值保持常规字重。 */
test(
  "top toolbar labels are bold while their values stay normal",
  { timeout: 90000 },
  async (t) => {
    const { frame } = await openWorkbench(t);
    const measured = await frame.getByTestId("regional-approval-workbench").evaluate((el) => {
      const doc = el.ownerDocument;
      const weight = (node) => (node ? Number(getComputedStyle(node).fontWeight) : 0);
      const labels = [...doc.querySelectorAll("small")]
        .filter((node) => ["计划月份", "版本", "对比"].includes(node.textContent.trim()))
        .map((node) => ({ text: node.textContent.trim(), weight: weight(node) }));
      // 取值要和标签同一个字段容器，避免 CSS Module 类名被哈希后选不中。
      const values = [...doc.querySelectorAll("small")]
        .filter((node) => ["计划月份", "版本", "对比"].includes(node.textContent.trim()))
        .flatMap((label) => [
          ...(label.parentElement?.querySelectorAll(".arco-select-view-value") ?? []),
        ])
        .map((node) => ({ text: node.textContent.trim().slice(0, 12), weight: weight(node) }));
      return { labels, values };
    });
    // 版本 / 对比两个下拉已按业务方反馈收起，顶部只剩「计划月份」。
    assert.equal(
      measured.labels.length,
      1,
      `顶部只剩计划月份标签，实际：${JSON.stringify(measured.labels)}`,
    );
    for (const label of measured.labels)
      assert.ok(label.weight >= 600, `${label.text} 要加粗，实际 ${label.weight}`);
    assert.ok(measured.values.length > 0, "顶部要能读到取值");
    for (const value of measured.values)
      assert.equal(value.weight, 400, `取值「${value.text}」保持常规字重`);
  },
);

/** V1.8 #04：表格表头加粗，但底色不加深、不加分隔线。 */
test("table headers are bold without a darker background", { timeout: 90000 }, async (t) => {
  const { frame } = await openWorkbench(t);
  await frame
    .getByRole("button", { name: /宝阳销售组/ })
    .first()
    .click();
  await expect(
    frame.getByRole("spinbutton", { name: "确认计划量 1001", exact: true }),
  ).toBeVisible();
  const tables = await frame.locator("table").evaluateAll((nodes) =>
    nodes
      .map((table) => ({
        // 只取本表直属 thead，避免把展开行里嵌套的明细表头算两遍。
        head: [...table.querySelectorAll(":scope > thead > tr > th")].map((node) => ({
          text: (node.textContent || "").trim(),
          weight: Number(getComputedStyle(node).fontWeight),
          bg: getComputedStyle(node).backgroundColor,
        })),
      }))
      .filter((table) => table.head.length > 0),
  );
  const queue = tables.find((table) => table.head.some((cell) => cell.text === "组织名称"));
  const detail = tables.find((table) => table.head.some((cell) => cell.text === "确认计划量"));
  assert.ok(queue, "找不到队列表格表头");
  assert.ok(detail, "找不到 SKU 明细表头");
  // V1.8 #08：达成率列名要写清是「计划金额 / 目标金额」，不再用含糊的「计划/目标」。
  const queueColumnNames = queue.head.map((cell) => cell.text);
  assert.ok(
    queueColumnNames.includes("计划金额 / 目标金额"),
    `队列表头缺少金额口径列名，实际 ${JSON.stringify(queueColumnNames)}`,
  );
  assert.ok(!queueColumnNames.includes("计划/目标"), "不要再用「计划/目标」这种含糊列名");
  for (const table of [queue, detail]) {
    for (const cell of table.head) {
      if (!cell.text) continue;
      assert.ok(cell.weight >= 600, `表头「${cell.text}」要加粗，实际 ${cell.weight}`);
      assert.equal(cell.bg, "rgb(242, 243, 245)", `表头「${cell.text}」底色不能被加深`);
    }
  }
});
