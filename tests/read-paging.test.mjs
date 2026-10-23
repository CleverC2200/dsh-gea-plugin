/**
 * versionSkus 的模型侧读取必须有界分页，不能把整份 SKU 灌回模型。
 *
 * 线上问题：一个版本的 SKU 可能上千条，kind=versionSkus 整包返回会直接顶到
 * 输入预算。这里验证投影后的分页契约：
 *   - 不是最后一页时 coverage=partial，并给出可继续取的 nextQuery；
 *   - 最后一页 coverage=complete，nextQuery=null；
 *   - 单页仍然超预算时自动缩页，而不是报 SNAPSHOT_TOO_LARGE。
 * 页面自身的工作台读取不受影响，这里只看模型读到的内容。
 */
import { readFile } from "node:fs/promises";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { profile, readSession, until } from "./profile.mjs";

const CONTEXT_WINDOW = 32768;
const MAX_TOKENS = 2048;
const MAX_SNAPSHOT_BYTES = 100000;
const INPUT_BUDGET = Math.min(MAX_SNAPSHOT_BYTES, CONTEXT_WINDOW - MAX_TOKENS - 1000);

const planId = "p-paging-0001";
const versionId = planId + "-1";

function skuRows(count, descriptionLength) {
  return Array.from({ length: count }, (_, index) => ({
    id: `sku-${index}`,
    versionId,
    skuCode: String(100000 + index),
    materialDescription:
      descriptionLength === undefined
        ? `分页测试物料 ${index} 号`
        : `分页测试物料 ${index} 号`.repeat(Math.ceil(descriptionLength / 9)),
    qty: "12.5",
    amt: "12345.67",
    price: "987.65",
  }));
}

test(
  "versionSkus 模型侧按页投影：partial + nextQuery，最后一页 complete",
  { timeout: 180000 },
  async (t) => {
    const app = await profile(t, {
      startupTimeoutMs: 120000,
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
      "data: " +
      JSON.stringify({
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) +
      "\n\n";
    const modelRequests = [];
    const skus = skuRows(400);
    // 每一次"新对话"按顺序取一条脚本；同一对话的第二轮就是收尾回答。
    const scripted = [
      { pageNo: 1, pageSize: 5 },
      { pageNo: 80, pageSize: 5 },
    ];
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path.endsWith("/user-agent-credential/my/list")) {
        reply({
          success: true,
          result: {
            records: [{ id: "credential", status: "ACTIVE" }],
            total: 1,
          },
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
      if (path.endsWith(`/sales-plan/plans/versions/${versionId}/skus`)) {
        reply({ success: true, result: skus });
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
              cust_code: 10070026,
              dealerName: "分页测试经销商",
              targetAmount: "1539999.99",
              targetQty: "26445",
              status: 10,
              effective: true,
            },
            versions: [{ id: versionId, planId, seq: 1 }],
            logs: [],
            skus: [],
          },
        });
        return true;
      }
      if (path !== "/personal/chat/completions") return false;
      const body = JSON.parse(req.body);
      modelRequests.push(body);
      res.setHeader("Content-Type", "text/event-stream");
      const toolResults = body.messages.filter((message) => message.role === "tool").length;
      if (toolResults === 0) {
        const next = scripted.shift();
        assert.ok(next, "脚本耗尽：多跑了一轮对话");
        res.end(
          event(
            {
              tool_calls: [
                {
                  index: 0,
                  id: `skus-${next.pageNo}`,
                  type: "function",
                  function: {
                    name: "gea_sales_plan_read",
                    arguments: JSON.stringify({
                      kind: "versionSkus",
                      query: {
                        versionId,
                        pageNo: next.pageNo,
                        pageSize: next.pageSize,
                      },
                    }),
                  },
                },
              ],
            },
            "tool_calls",
          ),
        );
      } else res.end(event({ content: "已按分页读完该版本 SKU。" }, "stop"));
      return true;
    });
    await app.login();

    const ask = async () => {
      const page = (await app.rpc("plans")).value;
      const preview = await app.rpc("prepare", {
        queryId: page.queryId,
        planId: page.records[0].planId,
      });
      assert.equal(preview.ok, true, JSON.stringify(preview));
      const submitted = await app.rpc("submit", {
        previewId: preview.value.previewId,
      });
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      await until(
        () => readSession(app.runtime, submitted.value.sessionId),
        (rows) => rows.some((row) => row.type === "turn/end"),
      );
    };

    await ask();
    await ask();

    const toolPayloads = modelRequests
      .filter((body) => body.messages.some((message) => message.role === "tool"))
      .map((body) => String(body.messages.find((message) => message.role === "tool").content));
    assert.equal(toolPayloads.length, 2, "应当有两轮工具结果");
    for (const payload of toolPayloads) {
      assert.equal(payload.includes("SNAPSHOT_TOO_LARGE"), false);
      assert.ok(Buffer.byteLength(payload, "utf8") <= INPUT_BUDGET, "工具结果超过输入预算");
    }

    const first = JSON.parse(toolPayloads[0]).value;
    assert.equal(first.total, 400, "总数应当是上游完整 SKU 数");
    assert.equal(first.offset, 0);
    assert.equal(first.records.length, 5);
    assert.deepEqual(first.nextQuery, { versionId, offset: 5, pageSize: 5 });
    assert.ok(first.note.includes("nextQuery"), "提示没有指向下一页: " + first.note);
    assert.equal(JSON.parse(toolPayloads[0]).coverage, "partial");
    // 投影只留模型需要的字段，不带版本内内部标识。
    assert.deepEqual(Object.keys(first.records[0]).sort(), [
      "amt",
      "amtBase",
      "areaConfirmedQty",
      "baseQty",
      "categoryConfirmedQty",
      "materialDescription",
      "price",
      "productCategName",
      "provinceConfirmedQty",
      "qty",
      "regionConfirmedQty",
      "skuCode",
    ]);

    const last = JSON.parse(toolPayloads[1]).value;
    assert.equal(last.offset, 395);
    assert.equal(last.records.length, 5);
    assert.equal(last.nextQuery, null, "最后一页不该再给下一页");
    assert.equal(JSON.parse(toolPayloads[1]).coverage, "complete");
  },
);

test(
  "versionSkus 单页仍超预算时自动缩页，而不是报 SNAPSHOT_TOO_LARGE",
  { timeout: 180000 },
  async (t) => {
    const app = await profile(t, {
      startupTimeoutMs: 120000,
      config: () => ({
        maxSnapshotBytes: 4300,
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
      "data: " +
      JSON.stringify({
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) +
      "\n\n";
    const modelRequests = [];
    const skus = skuRows(9, 900).map((row, index) => ({
      ...row,
      materialDescription: index % 2 === 0 ? row.materialDescription : "短物料",
      qty: index === 4 ? null : row.qty,
    }));
    const delivered = [];
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path.endsWith("/user-agent-credential/my/list")) {
        reply({
          success: true,
          result: {
            records: [{ id: "credential", status: "ACTIVE" }],
            total: 1,
          },
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
      if (path.endsWith(`/sales-plan/plans/versions/${versionId}/skus`)) {
        reply({ success: true, result: skus });
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
              cust_code: 10070026,
              dealerName: "分页测试经销商",
              targetAmount: "1539999.99",
              targetQty: "26445",
              status: 10,
              effective: true,
            },
            versions: [{ id: versionId, planId, seq: 1 }],
            logs: [],
            skus: [],
          },
        });
        return true;
      }
      if (path !== "/personal/chat/completions") return false;
      const body = JSON.parse(req.body);
      modelRequests.push(body);
      res.setHeader("Content-Type", "text/event-stream");
      const toolResults = body.messages.filter((message) => message.role === "tool");
      const latest = toolResults.length
        ? JSON.parse(String(toolResults.at(-1).content))
        : undefined;
      if (latest) {
        assert.notEqual(
          latest.projection,
          "partial",
          "model must receive the actual bounded page, not a shorter evidence preview",
        );
        delivered.push(...latest.value.records);
      }
      const nextQuery = latest ? latest.value.nextQuery : { versionId, pageNo: 1, pageSize: 50 };
      if (nextQuery)
        res.end(
          event(
            {
              tool_calls: [
                {
                  index: 0,
                  id: `skus-wide-${toolResults.length}`,
                  type: "function",
                  function: {
                    name: "gea_sales_plan_read",
                    arguments: JSON.stringify({
                      kind: "versionSkus",
                      query: nextQuery,
                    }),
                  },
                },
              ],
            },
            "tool_calls",
          ),
        );
      else res.end(event({ content: "已读取该版本 SKU。" }, "stop"));
      return true;
    });
    await app.login();
    const page = (await app.rpc("plans")).value;
    const preview = await app.rpc("prepare", {
      queryId: page.queryId,
      planId: page.records[0].planId,
    });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const submitted = await app.rpc("submit", {
      previewId: preview.value.previewId,
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    await until(
      () => readSession(app.runtime, submitted.value.sessionId),
      (rows) => rows.some((row) => row.type === "turn/end"),
    );

    const toolMessage = modelRequests[1].messages.find((message) => message.role === "tool");
    const payload = String(toolMessage.content);
    const bytes = Buffer.byteLength(payload, "utf8");
    console.log("宽 SKU 工具结果字节数:", bytes, "预算:", 4300);
    assert.equal(payload.includes("SNAPSHOT_TOO_LARGE"), false);
    assert.ok(bytes <= 4300, "自动缩页后仍然超过输入预算");
    const value = JSON.parse(payload).value;
    assert.ok(value.pageSize < 50, "超预算时没有缩页: " + value.pageSize);
    assert.ok(value.records.length <= value.pageSize);
    if (value.records.length < value.pageSize) {
      const projected = JSON.parse(payload);
      assert.equal(projected.projection, "partial");
      assert.match(projected.evidenceId, /^ev-/);
      const original = JSON.parse(
        await readFile(`${app.runtime}/prompt-evidence/${projected.evidenceId}.txt`, "utf8"),
      );
      assert.equal(
        original.value.records.length,
        original.value.pageSize,
        "host paging remains intact behind the bounded model projection",
      );
    }
    assert.deepEqual(value.nextQuery, {
      versionId,
      offset: value.records.length,
      pageSize: 50,
    });
    assert.deepEqual(
      delivered.map((row) => row.skuCode),
      ["100000", "100001", "100002", "100003", "100004", "100005", "100006", "100007", "100008"],
    );
    assert.equal(delivered[4].qty, null);
    const last = JSON.parse(
      String(
        modelRequests
          .at(-1)
          .messages.filter((message) => message.role === "tool")
          .at(-1).content,
      ),
    );
    assert.equal(last.value.nextQuery, null);
    assert.equal(last.coverage, "complete");
    assert.equal(JSON.parse(payload).coverage, "partial");
  },
);
