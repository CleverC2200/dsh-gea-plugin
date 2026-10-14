import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readSession, until } from "./profile.mjs";
import { modelProfile as profile } from "./fixtures/model-profile.mjs";
import { selectBusinessResource } from "./fixtures/business-session.mjs";
test(
  "native typed query exposes its schema, splits requests and refuses a revoked resource next turn",
  { timeout: 45000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        analysis: {
          mode: "model",
          baseUrl: base + "/v1",
          model: "fixture",
          apiKeyEnv: "GEA_TEST_MODEL_KEY",
          agentCode: "sales_forecast",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: { GEA_TEST_MODEL_KEY: "fixture-key" },
    });
    const requests = [],
      queries = [],
      discovery = [];
    let revoked = false;
    let evidenceId;
    let expired = false;
    let resourceCalls = 0;
    let sessionsOpened = 0;
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path.endsWith("/ai/gateway/session")) {
        sessionsOpened++;
        reply({
          success: true,
          result: {
            accessDecision: { allowed: true },
            gatewayContext: {
              consumerType: "AGENT",
              consumerCode: "sales_forecast",
              sessionId: "trusted-session",
              conversationId: "trusted-conversation",
            },
            delegationToken: "delegation-fixture-secret",
          },
        });
        return true;
      }
      if (path.endsWith("/ai/gateway/mcp/proxy/resources")) {
        resourceCalls++;
        if (expired) {
          reply({ success: false, code: "AI_GATEWAY_SESSION_EXPIRED", category: "SESSION" });
          return true;
        }
        const b = JSON.parse(req.body);
        discovery.push(b);
        reply({
          success: true,
          resources: revoked
            ? []
            : ["inv", "ship"].map((model) => ({
                capabilityCode: "MCP_TOOL:cube:query_business_data",
                resourceCode: model,
                resourceName: model,
                resourceType: "EXTERNAL_MCP",
                queryTarget: model,
                version: "1",
                maxRows: 100,
                maxBytes: null,
              })),
        });
        return true;
      }
      if (path.endsWith("/ai/gateway/mcp/proxy/mcp")) {
        const b = JSON.parse(req.body);
        let result = {};
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
          const a = b.params.arguments;
          if (a.action === "inspect")
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    semanticModel: ["inv", "ship"].map((name) => ({
                      name,
                      measures: [{ name: name + ".row_count", type: "number" }],
                    })),
                  }),
                },
              ],
            };
          else {
            queries.push(a);
            result =
              a.queries[0].name === "ship"
                ? { isError: true, content: [{ type: "text", text: "fixture shipment failed" }] }
                : {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          datasets: [{ name: "inv", rows: [{ "inv.row_count": 42 }] }],
                        }),
                      },
                    ],
                  };
          }
        }
        reply({ jsonrpc: "2.0", id: b.id, result });
        return true;
      }
      if (path === "/v1/chat/completions") {
        const body = JSON.parse(req.body);
        requests.push(body);
        const n = requests.length;
        if (n === 2)
          evidenceId = JSON.stringify(body.messages.filter((x) => x.role === "system")).match(
            /ev-[a-f0-9]{24}/,
          )?.[0];
        res.setHeader("Content-Type", "text/event-stream");
        const query = (name) => ({ name, query: { measures: [name + ".row_count"], limit: 3 } });
        const delta =
          n === 7
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "evidence-first-expiry",
                    type: "function",
                    function: {
                      name: "gea_evidence_read",
                      arguments: JSON.stringify({ evidenceId }),
                    },
                  },
                ],
              }
            : n === 3 || n === 8
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: "read-revoked-evidence",
                      type: "function",
                      function: {
                        name: "gea_evidence_read",
                        arguments: JSON.stringify({ evidenceId }),
                      },
                    },
                  ],
                }
              : n === 1 || n === 5 || n === 10
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-" + n,
                        type: "function",
                        function: {
                          name: "gea_cube_query",
                          arguments: JSON.stringify({
                            consumerCode: "sales_forecast",
                            queries: n === 1 ? [query("inv"), query("ship")] : [query("inv")],
                          }),
                        },
                      },
                    ],
                  }
                : { content: revoked ? "本轮没有匹配授权资源。" : "库存结果 42，发货失败。" };
        res.end(
          "data: " +
            JSON.stringify({
              choices: [
                { index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
        return true;
      }
      return false;
    });
    await app.login();
    await selectBusinessResource(app);
    const created = await app.remote("session/create", {
      cwd: app.runtime + "/workspace",
      agentPreset: "gea-readonly",
    });
    assert.equal(created.ok, true);
    const id = created.value.sessionId;
    await app.remote("session/selectModel", {
      sessionId: id,
      provider: "gea-analysis",
      model: "fixture",
    });
    const ask = (text) =>
      app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId: id,
        mode: "queue",
        content: [{ type: "text", text }],
      });
    await ask("查询库存和发货。");
    await until(
      () => readSession(app.runtime, id),
      (rows) => rows.some((x) => x.type === "turn/end"),
    );
    assert.equal(queries.length, 2);
    assert.ok(queries.every((x) => x.queries.length === 1));
    const schema = requests[0].tools.find((x) => x.function.name === "gea_cube_query").function
      .parameters;
    assert.deepEqual(
      schema.properties.queries.items.properties.query.properties.order.items.properties.direction
        .enum,
      ["asc", "desc"],
    );
    assert.match(JSON.stringify(requests[0].messages), /业务范围、期间、版本/);
    assert.match(JSON.stringify(requests[0].messages), /单位和币种未知时保持未知/);
    assert.match(JSON.stringify(requests[1].messages), /42/);
    assert.doesNotMatch(JSON.stringify(requests), /delegation-fixture-secret|trusted-session/);
    assert.ok(
      discovery.every(
        (x) =>
          x.agentCode === "sales_forecast" &&
          x.mcpCode === "cube" &&
          x.sessionId === "trusted-session",
      ),
    );
    revoked = true;
    await ask("继续读取刚才的库存证据。");
    await until(
      () => readSession(app.runtime, id),
      (rows) => rows.filter((x) => x.type === "turn/end").length === 2,
    );
    assert.equal(queries.length, 2, "revoked resource must not reach the data tool");
    assert.match(JSON.stringify(requests[3].messages), /GEA_EVIDENCE_AUTHORIZATION_CHANGED/);
    await ask("重新查询库存。");
    await until(
      () => readSession(app.runtime, id),
      (rows) => rows.filter((x) => x.type === "turn/end").length === 3,
    );
    assert.equal(queries.length, 2);
    assert.match(JSON.stringify(requests[5].messages), /GEA_RESOURCE_NOT_AUTHORIZED/);
    assert.doesNotMatch(
      JSON.stringify(requests[3].messages.filter((x) => x.role === "system")),
      /本轮成功取数回执/,
    );
    const beforeExpiredCalls = resourceCalls,
      beforeSessions = sessionsOpened;
    expired = true;
    await ask("重新读取已有证据。");
    await until(
      () => readSession(app.runtime, id),
      (rows) => rows.filter((x) => x.type === "turn/end").length === 4,
    );
    assert.match(JSON.stringify(requests[8].messages), /GEA_GATEWAY_SESSION_EXPIRED/);
    assert.equal(
      resourceCalls,
      beforeExpiredCalls + 1,
      "evidence read must not reopen the expired gateway in the same turn",
    );
    assert.equal(sessionsOpened, beforeSessions);
    expired = false;
    revoked = false;
    await ask("新一轮重新查询库存。");
    await until(
      () => readSession(app.runtime, id),
      (rows) => rows.filter((x) => x.type === "turn/end").length === 5,
    );
    assert.equal(queries.length, 3, "the next user turn may establish a fresh authorized gateway");
    assert.equal(sessionsOpened, beforeSessions + 1);
  },
);
