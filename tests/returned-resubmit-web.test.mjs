import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { testBrowser } from "./fixtures/test-browser.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";

const PLAN_A = "p-jxs-2026-10-00001";
const PLAN_B = "p-jxs-2026-10-00002";
const PLAN_C = "p-jxs-2026-10-00003";

const fixture = async (
  t,
  {
    role = "region",
    returnedStatus = 7,
    denySubmit = false,
    readbackFailure = false,
    serviceReady = true,
    shortened = false,
    unknownOnce = false,
    normalBatch = false,
    sameIdPeriod = false,
  } = {},
) => {
  const app = await profile(t, {
    roles: role === "customer" ? [] : [{ code: `sales_plan_${role}_approver`, name: role }],
    config: serviceReady
      ? {
          serviceAccounts: {
            production: {
              clientIdEnv: "GEA_SUBMIT_CLIENT",
              clientSecretEnv: "GEA_SUBMIT_SECRET",
              tenantId: "0",
              allowedUserIds: ["9007199254740993"],
            },
          },
        }
      : {},
    env: { GEA_SUBMIT_CLIENT: "fixture", GEA_SUBMIT_SECRET: "fixture-secret" },
  });
  const state = new Map([
    [
      PLAN_A,
      {
        versionId: "v1",
        seq: 1,
        status: returnedStatus,
        dealerCode: "456",
        name: "乌鲁木齐退回区域",
      },
    ],
    [PLAN_B, { versionId: "v2", seq: 1, status: 7, dealerCode: "457", name: "济南退回区域" }],
    [PLAN_C, { versionId: "v3", seq: 1, status: 1, dealerCode: "458", name: "沈阳待审批" }],
  ]);
  const submitted = [];
  const logs = [];
  let readbackBlocked = readbackFailure;
  let submittedQty = "2.000";
  let submitReceipt;
  if (normalBatch) state.get(PLAN_B).status = 1;
  const approved = [];
  const rejected = [];
  const attempts = [];
  const version = (planId, effective = true) => {
    const row = state.get(planId);
    return {
      id: row.versionId,
      planId,
      periodId: "20261001",
      planTypeCode: "Y",
      orderType: "M",
      status: row.status,
      effective,
      seq: row.seq,
      dealerCode: row.dealerCode,
      submitter: "9007199254740993",
      returnReason: "请核对数量与继承确认值",
      targetQty: "1.000",
      targetAmount: "12.34",
    };
  };
  const sku = (planId) => ({
    id: "s-" + planId,
    versionId: state.get(planId).versionId,
    skuCode: "789",
    productCategName: "Category",
    baseQty: "1.000",
    qty: planId === PLAN_A ? submittedQty : "2.000",
    regionConfirmedQty: returnedStatus >= 7 ? "1.250" : null,
    regionConfirmedAmount: returnedStatus >= 7 ? "15.43" : null,
    provinceConfirmedQty: returnedStatus >= 8 ? "1.500" : null,
    provinceConfirmedAmount: returnedStatus >= 8 ? "18.51" : null,
    areaConfirmedQty: returnedStatus >= 9 ? "1.750" : null,
    areaConfirmedAmount: returnedStatus >= 9 ? "21.60" : null,
    price: "12.3400",
    amt: planId === PLAN_A && submittedQty === "3.000" ? "37.02" : "24.68",
    amtBase: "12.34",
  });
  const rowVersions = (planId, current) =>
    current.seq === 1
      ? [current]
      : [
          current,
          {
            ...current,
            id: "v1",
            seq: 1,
            status: returnedStatus,
            effective: false,
          },
        ];
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    if (shortened && path.endsWith("/ai/gateway/sql/execute")) {
      const body = JSON.parse(req.body);
      const rows = ["0", "1", "3", "4", "Y"].map((node, index) => ({
        id: index + 1,
        type_code: "Y",
        examine_level: String(index),
        node_num: node,
      }));
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
    const send = (result) => {
      reply({ success: true, result });
      return true;
    };
    if (path.endsWith("/getPermCode"))
      return send({ codeList: [`sales-plan:plan:${role}-approve`] });
    if (path.endsWith("/periods"))
      return send({
        records: [
          ...(sameIdPeriod
            ? [{ periodId: "20261001", periodMonth: "2026-10", planTypeCode: "DC", status: "OPEN" }]
            : []),
          { periodId: "20261001", periodMonth: "2026-10", planTypeCode: "Y", status: "OPEN" },
        ],
        total: sameIdPeriod ? 2 : 1,
        current: 1,
        size: 100,
      });
    if (path.endsWith("/plans")) {
      const status = req.url.searchParams.get("status");
      const type = req.url.searchParams.get("planTypeCode");
      const records = [...state.keys()]
        .filter(
          (planId) =>
            (!type || type === "Y") &&
            (status === null || status === String(state.get(planId).status)),
        )
        .map((planId) => {
          const row = state.get(planId);
          return {
            planId,
            versionId: row.versionId,
            seq: row.seq,
            periodId: "20261001",
            planTypeCode: "Y",
            orderType: "M",
            status: row.status,
            dealerCode: row.dealerCode,
            dealerName: row.name,
            orgName: row.name,
            orgCode: "org-" + planId,
            provinceCode: "province-" + planId,
            provinceName: row.name,
            areaCode: "area-" + planId,
            areaName: row.name,
            currentQty: "2.000",
            currentAmount: "24.68",
            targetQty: "1.000",
            targetAmount: "12.34",
            skuCount: 1,
          };
        });
      if (sameIdPeriod && !type && status === null)
        records.unshift({
          ...records[0],
          planId: "p-jxs-2026-10-99999",
          versionId: "other-type-version",
          planTypeCode: "DC",
          orgName: "DC周期来源",
          dealerName: "DC周期来源",
        });
      return send({
        records,
        total: records.length,
        current: 1,
        size: Number(req.url.searchParams.get("pageSize") || 20),
        pages: 1,
      });
    }
    const detail = /\/plans\/(p-jxs-2026-10-\d+)$/.exec(path);
    if (detail) {
      const planId = detail[1];
      const current = version(planId);
      return send({
        currentVersion: current,
        versions: rowVersions(planId, current),
        skus: readbackBlocked && submitted.length && planId === PLAN_A ? [] : [sku(planId)],
        logs,
        actionContext: {
          versionId: current.id,
          status: current.status,
          policy: "role-visible-v1",
          allowedActions: [],
          roleActions: [{ role, allowedActions: [] }],
          snapshotHash: "a".repeat(64),
        },
      });
    }

    const versionSkus = /\/versions\/([^/]+)\/skus$/.exec(path);
    if (versionSkus) {
      const planId = [...state.entries()].find(([, row]) => row.versionId === versionSkus[1])?.[0];
      return send(planId ? [sku(planId)] : []);
    }
    const action = /\/versions\/(v[123])\/actions$/.exec(path);
    if (action) {
      const body = JSON.parse(req.body);
      assert.ok(["APPROVE", "REJECT"].includes(body.action));
      const [planId, row] = [...state.entries()].find(([, row]) => row.versionId === action[1]);
      assert.equal(body.approvalRole, role);
      assert.equal(body.approvalPolicy, "role-visible-v1");
      assert.equal(body.expectedSnapshot, "a".repeat(64));
      assert.equal(body.expectedStatus, row.status);
      attempts.push(body);
      if (body.action === "APPROVE" && row.status >= 6) {
        reply({ success: false, message: "当前用户不具备审批权限" }, 403);
        return true;
      }
      const fromStatus = row.status;
      const rejectTarget = { region: 6, province: 7, area: 8, category: 9 }[role];
      row.status = body.action === "REJECT" ? rejectTarget : 2;
      (body.action === "REJECT" ? rejected : approved).push({ planId, body });
      return send({
        planId,
        versionId: row.versionId,
        fromStatus,
        toStatus: row.status,
        approvalRole: role,
        requestId: req.headers["x-request-id"],
        traceId: "t",
        auditId: "a",
        replayed: false,
      });
    }
    if (path.endsWith("/api/v1/internal/auth/token"))
      return send({
        access_token: "fixture-service",
        token_type: "Bearer",
        expires_in: 600,
        scope: "sales-plan:write",
      });
    if (path.endsWith("/api/v1/internal/sales-plans")) {
      const body = JSON.parse(req.body);
      submitted.push({
        body,
        key: req.headers["idempotency-key"],
        requestId: req.headers["x-request-id"],
      });
      if (submitReceipt) return send({ ...submitReceipt, replayed: true });
      if (denySubmit) {
        reply({ success: false, message: "提报窗口已关闭，请联系业务管理员" }, 403);
        return true;
      }
      assert.equal(body.status, returnedStatus - 5);
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0].price, "12.3400");
      const row = state.get(PLAN_A);
      row.versionId = "v-new";
      row.seq = 2;
      row.status = body.status;
      const nodes = shortened ? [1, 3, 4] : [1, 2, 3, 4];
      row.nextActor = { 1: "region", 2: "province", 3: "area", 4: "category" }[
        nodes.find((node) => node >= body.status)
      ];
      submittedQty = body.items[0].qty;
      logs.push({
        planId: PLAN_A,
        versionId: "v-new",
        actionCode: "RESUBMIT",
        requestId: req.headers["x-request-id"],
      });
      submitReceipt = {
        planId: PLAN_A,
        versionId: "v-new",
        seq: 2,
        status: body.status,
        requestId: req.headers["x-request-id"],
        traceId: "t",
        auditId: "a",
        replayed: false,
      };
      if (unknownOnce) {
        reply({ message: "结果暂时未知" }, 502);
        return true;
      }
      return send(submitReceipt);
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
  page.setDefaultTimeout(15000);
  await page.goto(app.origin);
  const frame = await openSalesPlan(page);
  await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
  await expect(frame.getByTestId("regional-approval-flow-toggle")).toBeVisible();
  return {
    app,
    frame,
    page,
    submitted,
    approved,
    rejected,
    attempts,
    state,
    allowReadback: () => {
      readbackBlocked = false;
    },
  };
};

const captureEvidence = async (page, app, name) => {
  const directory = process.env.S1_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, name + ".png"),
    fullPage: true,
    animations: "disabled",
  });
  await writeFile(
    resolve(directory, name + ".aria.txt"),
    await page
      .frameLocator('iframe[src^="/api/agent-workbench/native?"]')
      .locator("body")
      .ariaSnapshot(),
  );
  await writeFile(
    resolve(directory, name + ".host.json"),
    await readFile(resolve(app.runtime, "source-host.json")),
  );
  const host = JSON.parse(await readFile(resolve(app.runtime, "source-host.json"), "utf8"));
  await writeFile(
    resolve(directory, name + ".plugins.json"),
    await readFile(
      resolve(app.runtime, "source-combinations", host.combination, "company-plugins.json"),
    ),
  );
  await writeFile(
    resolve(directory, name + ".warnings.txt"),
    app.output
      .split("\n")
      .filter((line) => /warning|failed to import/.test(line))
      .join("\n"),
  );
};

const selectPlan = (frame, name = "乌鲁木齐退回区域") =>
  frame
    .locator("tbody tr")
    .filter({ hasText: name })
    .first()
    .locator("label.arco-checkbox")
    .click();

for (const [role, returnedStatus] of [
  ["region", 7],
  ["province", 8],
  ["area", 9],
  ["customer", 6],
])
  test(
    `returned ${returnedStatus} edits and submits one successor with fixed status`,
    { timeout: 90000 },
    async (t) => {
      const { frame, page, app, submitted, approved, state } = await fixture(t, {
        role,
        returnedStatus,
        shortened: returnedStatus === 7,
        sameIdPeriod: returnedStatus === 7,
      });
      if (returnedStatus === 7) {
        const periods = await app.rpc("workbench/query", { kind: "periods", query: {} });
        assert.deepEqual(
          periods.value.records.map((period) => period.planTypeCode),
          ["DC", "Y"],
        );
      }
      await selectPlan(frame);
      const edit = frame.getByRole("button", { name: "修改后提交", exact: true });
      await expect(edit).toBeEnabled();
      if (returnedStatus === 7) await captureEvidence(page, app, "returned-entry");
      await edit.click();
      const dialog = frame.getByRole("dialog", { name: "真实销售计划退回重提", exact: true });
      await dialog.getByRole("textbox", { name: "提报数量 789" }).fill("3.000");
      await expect(dialog).toContainText("请核对数量与继承确认值");
      if (returnedStatus >= 7) await expect(dialog).toContainText("1.250");
      await expect(dialog).toContainText("37.02");
      if (returnedStatus === 7) await captureEvidence(page, app, "inheritance-confirmation");
      await dialog.locator("label.arco-checkbox").click();
      await dialog.getByRole("button", { name: "确认重提", exact: true }).dblclick();
      await expect(dialog).toContainText("服务端已确认计划");
      assert.equal(submitted.length, 1);
      assert.equal(submitted[0].body.status, returnedStatus - 5);
      assert.equal(submitted[0].body.items[0].qty, "3.000");
      assert.equal(state.get(PLAN_A).seq, 2);
      assert.equal(
        state.get(PLAN_A).nextActor,
        { 6: "region", 7: "area", 8: "area", 9: "category" }[returnedStatus],
      );
      assert.deepEqual(approved, []);
    },
  );

for (const mixed of [false, true])
  test(`returned selection requires one plan; mixed=${mixed}`, { timeout: 90000 }, async (t) => {
    const { frame, submitted, approved } = await fixture(t);
    await selectPlan(frame);
    await selectPlan(frame, mixed ? "沈阳待审批" : "济南退回区域");
    await expect(frame.getByRole("button", { name: "修改后提交", exact: true })).toBeDisabled();
    await expect(frame.getByRole("button", { name: "修改后提交", exact: true })).toHaveAttribute(
      "title",
      /逐笔/,
    );
    assert.deepEqual(submitted, []);
    assert.deepEqual(approved, []);
  });

test(
  "successful submission with incomplete readback only retries reading",
  { timeout: 90000 },
  async (t) => {
    const { frame, submitted, allowReadback } = await fixture(t, { readbackFailure: true });
    await selectPlan(frame);
    await frame.getByRole("button", { name: "修改后提交", exact: true }).click();
    const dialog = frame.getByRole("dialog", { name: "真实销售计划退回重提", exact: true });
    await expect(dialog.getByRole("textbox", { name: "提报数量 789" })).toBeVisible();
    await dialog.locator("label.arco-checkbox").click();
    await dialog.getByRole("button", { name: "确认重提", exact: true }).click();
    await expect(dialog).toContainText("重提已成功");
    await expect(dialog).not.toContainText("未更新");
    allowReadback();
    await dialog.getByRole("button", { name: "刷新权威状态", exact: true }).click();
    await expect(dialog).toContainText("服务端已确认计划");
    assert.equal(submitted.length, 1);
  },
);

test(
  "service configuration unavailable permits review but blocks submission",
  { timeout: 90000 },
  async (t) => {
    const { frame, page, app, submitted } = await fixture(t, { serviceReady: false });
    await selectPlan(frame);
    await frame.getByRole("button", { name: "修改后提交", exact: true }).click();
    const dialog = frame.getByRole("dialog", { name: "真实销售计划退回重提", exact: true });
    await expect(dialog).toContainText("服务凭据或用户授权未就绪");
    await expect(dialog.getByRole("button", { name: "确认重提", exact: true })).toBeDisabled();
    await captureEvidence(page, app, "submission-unavailable");
    assert.equal(submitted.length, 0);
  },
);

test(
  "returned and pending plans can be rejected together, each from its own status",
  { timeout: 90000 },
  async (t) => {
    const { frame, rejected } = await fixture(t);
    const rowBox = (name) =>
      frame.locator("tbody tr").filter({ hasText: name }).first().locator("label.arco-checkbox");
    await rowBox("乌鲁木齐退回区域").click();
    await rowBox("沈阳待审批").click();
    await frame.getByRole("button", { name: "退回", exact: true }).click();
    const dialog = frame.getByTestId("regional-approval-batch-action-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("退回版本继续逐级退回");
    await expect(dialog).toContainText("正常审批退回");
    await dialog.getByRole("textbox", { name: "批量审批备注" }).fill("继续退回客户核对");
    await dialog.locator("label.arco-checkbox").click();
    await frame.getByRole("button", { name: "确认批量退回", exact: true }).click();
    const result = frame.getByTestId("regional-approval-batch-result");
    await expect(result).toContainText("成功 2 笔", { timeout: 30000 });
    await expect(result.locator("ul")).toHaveCount(0);
    assert.deepEqual(rejected.map(({ planId }) => planId).sort(), [PLAN_A, PLAN_C]);
    assert.deepEqual(rejected.map(({ body }) => body.expectedStatus).sort(), [1, 7]);
    assert.ok(
      rejected.every(({ body }) => body.action === "REJECT" && body.remark === "继续退回客户核对"),
    );
  },
);

test(
  "a returned regional plan can be rejected again to the customer",
  { timeout: 90000 },
  async (t) => {
    const { frame, rejected } = await fixture(t);
    await frame
      .locator("tbody tr")
      .filter({ hasText: "乌鲁木齐退回区域" })
      .first()
      .locator("label.arco-checkbox")
      .click();
    await frame.getByRole("button", { name: "退回", exact: true }).click();
    const dialog = frame.getByRole("dialog", { name: "退回", exact: true });
    await dialog.getByRole("textbox", { name: "退回原因（必填）" }).fill("继续退回客户核对");
    await dialog.getByRole("button", { name: "确认退回", exact: true }).click();
    await expect.poll(() => rejected.length, { timeout: 15000 }).toBe(1);
    assert.equal(rejected[0].planId, PLAN_A);
    assert.equal(rejected[0].body.expectedStatus, 7);
  },
);

test("queue column headings stay visible while its rows scroll", { timeout: 90000 }, async (t) => {
  const { frame } = await fixture(t);
  const pane = frame.locator(".arco-table-content-inner").first();
  const measured = await pane.evaluate((element) => {
    element.style.height = "80px";
    element.style.minHeight = "80px";
    element.style.maxHeight = "80px";
    element.scrollTop = 70;
    const heading = [
      ...element.querySelectorAll(":scope > table > thead > tr > th.arco-table-th"),
    ].find((cell) => cell.textContent?.trim() === "月计划");
    return {
      scrollTop: element.scrollTop,
      paneTop: element.getBoundingClientRect().top,
      headingTop: heading?.getBoundingClientRect().top,
    };
  });
  assert.ok(measured.scrollTop > 0, "队列必须发生纵向滚动");
  assert.ok(
    Math.abs(measured.headingTop - measured.paneTop) <= 1,
    `滚动后标题应贴住队列顶部：${JSON.stringify(measured)}`,
  );
});

test(
  "unknown submission survives close and reopens the original intent without another version",
  { timeout: 90000 },
  async (t) => {
    const { frame, submitted, state } = await fixture(t, { unknownOnce: true });
    await selectPlan(frame);
    await frame.getByRole("button", { name: "修改后提交", exact: true }).click();
    const dialog = frame.getByRole("dialog", { name: "真实销售计划退回重提", exact: true });
    await expect(dialog.getByRole("textbox", { name: "提报数量 789" })).toBeVisible();
    await dialog.locator("label.arco-checkbox").click();
    await dialog.getByRole("button", { name: "确认重提", exact: true }).click();
    await expect(dialog).toContainText("结果暂时未知");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await frame.getByRole("button", { name: "恢复待处理重提", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "提报数量 789" })).toHaveValue("2.000");
    await dialog.getByRole("button", { name: "以原幂等键重试", exact: true }).click();
    await expect(dialog).toContainText("服务端已确认计划");
    assert.equal(submitted.length, 2);
    assert.deepEqual(submitted[1], submitted[0]);
    assert.equal(state.get(PLAN_A).seq, 2);
  },
);

test(
  "normal pending records retain batch approval without submission",
  { timeout: 90000 },
  async (t) => {
    const { frame, approved, submitted } = await fixture(t, { normalBatch: true });
    await selectPlan(frame, "济南退回区域");
    await selectPlan(frame, "沈阳待审批");
    await frame.getByRole("button", { name: "通过", exact: true }).click();
    const dialog = frame.getByTestId("regional-approval-batch-action-dialog");
    await dialog.locator("label.arco-checkbox").click();
    await frame.getByRole("button", { name: "确认批量通过", exact: true }).click();
    await expect(frame.getByTestId("regional-approval-batch-result")).toContainText("成功 2 笔", {
      timeout: 30000,
    });
    assert.equal(approved.length, 2);
    assert.equal(submitted.length, 0);
  },
);

test(
  "submission refusal preserves the business reason without another write path",
  { timeout: 90000 },
  async (t) => {
    const { frame, submitted, approved } = await fixture(t, { denySubmit: true });
    await selectPlan(frame);
    await frame.getByRole("button", { name: "修改后提交", exact: true }).click();
    const dialog = frame.getByRole("dialog", { name: "真实销售计划退回重提", exact: true });
    await expect(dialog.getByRole("textbox", { name: "提报数量 789" })).toBeVisible();
    await dialog.locator("label.arco-checkbox").click();
    await dialog.getByRole("button", { name: "确认重提", exact: true }).click();
    await expect(dialog).toContainText("提报窗口已关闭，请联系业务管理员");
    assert.equal(submitted.length, 1);
    assert.equal(approved.length, 0);
  },
);
