/**
 * detail 读取不能被上游整包撑爆。
 *
 * 线上问题：kind=detail 直接展开上游响应（含该计划全部 SKU），单条计划就超过按
 * 上下文算出的输入预算，工具永远返回 SNAPSHOT_TOO_LARGE，"逐条看计划卡点"不可用。
 * 这里用一个带 400 条 SKU 的计划验证：模型侧拿到的是投影+截断后的结果，
 * 明确标注 partial，并且整体仍在预算内。
 */
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { profile, readSession, until } from "./profile.mjs";

const CONTEXT_WINDOW = 32768;
const MAX_TOKENS = 2048;
const MAX_SNAPSHOT_BYTES = 100000;
// 与 deployment.mjs 一致：输入预算 = min(maxSnapshotBytes, context − maxTokens − 1000)
const INPUT_BUDGET = Math.min(MAX_SNAPSHOT_BYTES, CONTEXT_WINDOW - MAX_TOKENS - 1000);

test("detail 结果被投影并截断，不再 SNAPSHOT_TOO_LARGE", { timeout: 90000 }, async (t) => {
  const app = await profile(t, {
    config: () => ({
      maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
      analysis: {
        mode: "model",
        source: "gea",
        agentCode: "sales_forecast",
        model: "model",
        contextWindow: CONTEXT_WINDOW,
        maxTokens: MAX_TOKENS,
      },
    }),
  });
  const event = (delta, finish = null) =>
    "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
  const modelRequests = [];
  const planId = "p-budget-0001";
  const versionId = planId + "-1";
  const skus = Array.from({ length: 400 }, (_, index) => ({
    id: `sku-${index}`,
    versionId,
    skuCode: String(100000 + index),
    materialDescription: `预算压力测试物料 ${index} 号`.repeat(3),
    qty: "12.5",
    amt: "12345.67",
    price: "987.65",
  }));
  app.route((req, res, reply) => {
    const path = req.url.pathname;
    if (path.endsWith("/user-agent-credential/my/list")) {
      reply({
        success: true,
        result: { records: [{ id: "credential", status: "ACTIVE" }], total: 1 },
      });
      return true;
    }
    if (path.endsWith("/user-agent-credential/my/claim")) {
      reply({
        success: true,
        result: {
          credentialId: "credential",
          status: "ACTIVE",
          baseUrl: app.base + "/personal",
          secret: "fixture-secret",
        },
      });
      return true;
    }
    if (path === "/personal/models") {
      reply({ data: [{ id: "model", name: "Test model" }] });
      return true;
    }
    if (path.endsWith(`/sales-plan/plans/${planId}`)) {
      reply({
        success: true,
        result: {
          actionContext: { versionId, status: 10 },
          currentVersion: {
            id: versionId,
            planId,
            periodId: "20260901",
            planTypeCode: "Y",
            dealerCode: "10070026",
            dealerName: "测试经销商",
            targetAmount: "1539999.99",
            targetQty: "26445",
            status: 10,
            effective: true,
          },
          versions: [{ id: versionId, planId, seq: 1 }],
          logs: [{ id: "log-1", planId, versionId, action: "SUBMIT" }],
          skus,
        },
      });
      return true;
    }
    if (path !== "/personal/chat/completions") return false;
    const body = JSON.parse(req.body);
    modelRequests.push(body);
    res.setHeader("Content-Type", "text/event-stream");
    const hasToolResult = body.messages.some((message) => message.role === "tool");
    if (!hasToolResult)
      res.end(
        event(
          {
            tool_calls: [
              {
                index: 0,
                id: "detail-1",
                type: "function",
                function: {
                  name: "gea_sales_plan_read",
                  arguments: JSON.stringify({ kind: "detail", query: { planId } }),
                },
              },
            ],
          },
          "tool_calls",
        ),
      );
    else res.end(event({ content: "已按计划明细完成只读分析。" }, "stop"));
    return true;
  });
  await app.login();
  const page = (await app.rpc("plans")).value;
  const preview = await app.rpc("prepare", {
    queryId: page.queryId,
    planId: page.records[0].planId,
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const submitted = await app.rpc("submit", { previewId: preview.value.previewId });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  await until(
    () => readSession(app.runtime, submitted.value.sessionId),
    (rows) => rows.some((row) => row.type === "turn/end"),
  );

  assert.equal(modelRequests.length, 2, "应当是 模型→工具→模型 两轮");
  const toolMessage = modelRequests[1].messages.find((message) => message.role === "tool");
  const payload = String(toolMessage.content);
  console.log("工具结果字节数:", Buffer.byteLength(payload, "utf8"), "预算:", INPUT_BUDGET);
  console.log("工具结果开头:", payload.slice(0, 200));
  console.log("含 skuCoverage=partial:", payload.includes('"skuCoverage":"partial"'));
  console.log("含旧错误 SNAPSHOT_TOO_LARGE:", payload.includes("SNAPSHOT_TOO_LARGE"));
  assert.equal(payload.includes("SNAPSHOT_TOO_LARGE"), false, "detail 仍然超出预算");
  assert.ok(Buffer.byteLength(payload, "utf8") <= INPUT_BUDGET, "工具结果超过输入预算");
  // 400 条 SKU 必然被截断；截断必须显式标注，不能把子集当全集。
  assert.ok(payload.includes('"skuCoverage":"partial"'), "截断没有标注 partial");
  assert.ok(payload.includes("skuHint"), "缺少继续分页的提示");
  assert.ok(payload.includes("p-budget-0001"), "计划身份丢失");
});
