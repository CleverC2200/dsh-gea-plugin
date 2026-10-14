import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readSession, until } from "./profile.mjs";
import { modelProfile as profile } from "./fixtures/model-profile.mjs";
import { createBusinessSession } from "./fixtures/business-session.mjs";

test(
  "native model loop retains ordinary MCP evidence after later failure and resets next turn",
  { timeout: 45000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        cubeMcpCodes: { production: "cube", test: "cube" },
        analysis: {
          mode: "model",
          baseUrl: base + "/v1",
          model: "fixture-model",
          apiKeyEnv: "GEA_TEST_MODEL_KEY",
          agentCode: "sales_forecast",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: { GEA_TEST_MODEL_KEY: "fixture-only-key" },
    });
    const requests = [];
    let upstreamQueries = 0;
    let secondTurn = false;
    const mcpArgs = {
      action: "query",
      queries: [
        {
          name: "region",
          query: { dimensions: ["plans.region"], measures: ["plans.row_count"], limit: 3 },
        },
      ],
    };
    const event = (delta, finish) =>
      "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/ai/gateway/mcp/proxy/resources")) {
        const request = JSON.parse(req.body);
        reply({
          success: true,
          resources: [
            {
              capabilityCode: `MCP_TOOL:${request.mcpCode}:query_business_data`,
              resourceCode: "plans-cube",
              resourceName: "plans",
              resourceType: "EXTERNAL_MCP",
              queryTarget: "plans",
              version: "1",
              maxRows: 200,
              maxBytes: 262144,
            },
          ],
        });
        return true;
      }

      const path = req.url.pathname;
      if (path.endsWith("/sales-plan/plans")) {
        reply({
          success: true,
          result: {
            records: [
              {
                planId: "p",
                versionId: "v",
                periodId: "20261001",
                orderType: "M",
                planTypeCode: "Y",
                baseName: "华东",
                status: 2,
                skuCount: 1,
                updatedAt: "stable",
              },
            ],
            total: 1,
            size: 200,
            current: 1,
            pages: 1,
          },
        });
        return true;
      }
      if (path.endsWith("/sales-plan/plans/versions/v/skus")) {
        reply({
          success: true,
          result: [
            { versionId: "v", skuCode: "sku-1", productCategName: "饺子", qty: "3", amt: "123.45" },
          ],
        });
        return true;
      }
      if (path.endsWith("/ai/gateway/session")) {
        reply({
          success: true,
          result: {
            accessDecision: { allowed: true },
            gatewayContext: {
              consumerType: "AGENT",
              consumerCode: "sales_forecast",
              sessionId: "business-session",
              conversationId: "conversation",
            },
            delegationToken: "fixture-only-delegation",
          },
        });
        return true;
      }
      if (path.endsWith("/ai/gateway/mcp/proxy/mcp")) {
        const b = JSON.parse(req.body);
        let result;
        if (b.method === "initialize") result = { protocolVersion: b.params.protocolVersion };
        else if (b.method === "notifications/initialized") {
          res.statusCode = 202;
          res.end();
          return true;
        } else if (b.method === "tools/list")
          result = {
            tools: [
              {
                name: "query_business_data",
                _meta: { sourceType: "MCP", sourceCode: "cube" },
                inputSchema: {
                  type: "object",
                  properties: { action: { type: "string" }, queries: { type: "array" } },
                  required: ["action", "queries"],
                },
              },
            ],
          };
        else if (b.method === "tools/call") {
          if (b.params.arguments.action === "inspect")
            result = { content: [{ type: "text", text: "{}" }] };
          else if (b.params.arguments.queries[0].name === "inventory") {
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    action: "query",
                    status: "completed",
                    executedQueryCount: 1,
                    datasets: [
                      {
                        name: "inventory",
                        rowCount: 1,
                        dataStatus: "ok",
                        totalRowCount: 1,
                        offset: 0,
                        hasMorePages: false,
                        fields: [{ name: "plans.row_count" }],
                        rows: [{ "plans.row_count": 60948 }],
                      },
                    ],
                  }),
                },
              ],
            };
          } else {
            upstreamQueries++;
            result = {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    businessCode: "AI_GATEWAY_DATA_PERMISSION_DENIED",
                    message:
                      "Cube 查询成员未唯一匹配数据目录资源；模型须与 dataAssetCode 一致，跨模型查询请分别调用",
                    requestId: "fixture-request",
                  }),
                },
              ],
            };
          }
        } else {
          reply({ jsonrpc: "2.0", id: b.id, result: {} });
          return true;
        }
        reply({ jsonrpc: "2.0", id: b.id, result });
        return true;
      }
      if (path === "/v1/chat/completions") {
        const body = JSON.parse(req.body);
        res.setHeader("Content-Type", "text/event-stream");
        requests.push(body);
        const n = requests.length;
        if (secondTurn || n === 3) {
          res.end(
            event(
              {
                content: secondTurn
                  ? "本轮未重新取数。"
                  : "已取得库存查询记录数 60948；大区查询失败，库存记录数不是客户数。",
              },
              "stop",
            ) + "data: [DONE]\n\n",
          );
          return true;
        }
        const name = "mcp__gea-gateway__query_business_data";
        res.end(
          event(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call-" + n,
                  type: "function",
                  function: {
                    name,
                    arguments: JSON.stringify(
                      n === 1
                        ? {
                            ...mcpArgs,
                            action: "query",
                            queries: [
                              {
                                name: "inventory",
                                query: { measures: ["plans.row_count"], limit: 200 },
                              },
                            ],
                          }
                        : mcpArgs,
                    ),
                  },
                },
              ],
            },
            "tool_calls",
          ) + "data: [DONE]\n\n",
        );
        return true;
      }
      return false;
    });
    await app.login();
    const id = await createBusinessSession(app);
    const selected = await app.remote("session/selectModel", {
      sessionId: id,
      provider: "gea-analysis",
      model: "fixture-model",
    });
    assert.equal(selected.ok, true, JSON.stringify(selected));
    const prompt = async (text) =>
      app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId: id,
        mode: "queue",
        content: [{ type: "text", text }],
      });
    assert.equal((await prompt("哪些销售大区已提报，按品类看金额占比")).ok, true);
    const rows = await until(
      () => readSession(app.runtime, id),
      (x) => x.some((r) => r.type === "turn/end"),
      15000,
    );
    assert.equal(rows.find((r) => r.type === "turn/end").data.reason.kind, "completed");
    assert.equal(upstreamQueries, 1, "one denied query is delivered without an automatic retry");
    assert.equal(requests.length, 3);
    const notices = (i) => JSON.stringify(requests[i].messages.filter((m) => m.role === "system"));
    assert.doesNotMatch(notices(2), /60948/);
    const history = JSON.stringify(requests[2].messages.filter((m) => m.role === "tool"));
    assert.match(history, /60948/);
    assert.match(history, /AI_GATEWAY_DATA_PERMISSION_DENIED/);
    assert.doesNotMatch(history, /fixture-only-delegation/);
    secondTurn = true;
    assert.equal((await prompt("新一轮，仅说明尚未重新取数")).ok, true);
    await until(
      () => readSession(app.runtime, id),
      (x) => x.filter((r) => r.type === "turn/end").length === 2,
      10000,
    );
    assert.doesNotMatch(
      notices(3),
      /本轮已返回证据/,
      "previous turn must not appear as current-turn evidence",
    );
  },
);
