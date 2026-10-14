import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { profile, readSession, readToolResults, until } from "./profile.mjs";
import {
  createBusinessSession,
  fixtureRequest,
} from "./fixtures/business-session.mjs";
test(
  "native result route, atomic skill load and structured evidence reuse retain authorization",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        cubeMcpCodes: { production: "cube", test: "cube" },
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
      env: { GEA_TEST_MODEL_KEY: "fixture" },
    });
    let script = [],
      captured = [],
      online = 0,
      queryCalls = 0,
      revoked = false,
      evidenceId;
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path.endsWith("/sales-plan/plans")) {
        online++;
        reply({
          success: true,
          result: {
            records: [
              {
                planId: "fixture-plan",
                versionId: "fixture-version",
                periodId: "20260801",
                planTypeCode: "Y",
                orderType: "M",
                status: 1,
                currentQty: revoked ? "11" : "10",
                currentAmount: "20",
                baseName: "fixture-base",
              },
            ],
            total: 1,
            current: 1,
            size: 200,
            pages: 1,
          },
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
              sessionId: "fixture",
              conversationId: "fixture",
            },
            delegationToken: "fixture",
          },
        });
        return true;
      }
      if (path.endsWith("/ai/gateway/mcp/proxy/resources")) {
        reply({
          success: true,
          resources: revoked
            ? []
            : [
                {
                  capabilityCode: "MCP_TOOL:cube:query_business_data",
                  resourceCode: "inv",
                  resourceName: "inv",
                  resourceType: "EXTERNAL_MCP",
                  queryTarget: "inv",
                  version: "1",
                  maxRows: 100,
                  maxBytes: null,
                },
              ],
        });
        return true;
      }
      if (path.endsWith("/ai/gateway/mcp/proxy/mcp")) {
        const b = JSON.parse(req.body);
        let result = {};
        if (b.method === "initialize")
          result = { protocolVersion: b.params.protocolVersion };
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
                  properties: {
                    action: { type: "string" },
                    queries: { type: "array" },
                  },
                  required: ["action", "queries"],
                },
              },
            ],
          };
        else if (b.method === "tools/call") {
          const a = b.params.arguments;
          result =
            a.action === "inspect"
              ? {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        semanticModel: [
                          {
                            name: "inv",
                            measures: [
                              { name: "inv.row_count", type: "number" },
                            ],
                          },
                        ],
                      }),
                    },
                  ],
                }
              : {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        action: "query",
                        status: "completed",
                        executedQueryCount: 1,
                        datasets: [
                          {
                            name: "inv",
                            rowCount: 1,
                            dataStatus: "ok",
                            totalRowCount: 1,
                            offset: 0,
                            hasMorePages: false,
                            fields: [{ name: "inv.row_count" }],
                            rows: [{ "inv.row_count": 42 }],
                          },
                        ],
                      }),
                    },
                  ],
                };
          if (a.action === "query") queryCalls++;
        }
        reply({ jsonrpc: "2.0", id: b.id, result });
        return true;
      }
      if (path !== "/v1/chat/completions") return false;
      const body = JSON.parse(req.body);
      captured.push(body);
      const step = script.shift();
      const args =
        step && typeof step[1] === "function" ? step[1](body) : step?.[1];
      const delta = step
        ? {
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: "function",
                function: { name: step[0], arguments: JSON.stringify(args) },
              },
            ],
          }
        : { content: "fixture finished" };
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              { index: 0, delta, finish_reason: step ? "tool_calls" : "stop" },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return true;
    });
    await app.login();
    const installed = await fixtureRequest(
      app,
      "/api/agent-plugins/user-panel/skills/create",
      {
        name: "sales-result-fixture",
        text: "---\nname: sales-result-fixture\ndescription: result fixture\n---\nScoped rule body.",
      },
    );
    assert.equal(installed.ok, true, JSON.stringify(installed));
    assert.equal(installed.value.ok, true, JSON.stringify(installed));
    const id = await createBusinessSession(app);
    await app.remote("session/selectModel", {
      sessionId: id,
      provider: "gea-analysis",
      model: "fixture",
    });
    let count = 0;
    async function run(question, steps) {
      script = steps;
      captured = [];
      const before = await readSession(app.runtime, id);
      await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId: id,
        mode: "queue",
        content: [{ type: "text", text: question }],
      });
      const events = await until(
        () => readSession(app.runtime, id),
        (e) => e.filter((x) => x.type === "turn/end").length > count,
        30000,
      );
      count++;
      return readToolResults(events.slice(before.length));
    }
    let replies = await run(
      "8月最终销售计划，只能使用Hive，不要使用在线计划接口。",
      [["gea_sales_plan_read", { kind: "periods" }]],
    );
    assert.match(replies[0].text, /GEA_SALES_RESULT_SOURCE/);
    assert.equal(online, 0);
    replies = await run("核对当前在线审批工作流周期。", [
      ["gea_sales_plan_read", { kind: "periods" }],
    ]);
    assert.equal(replies[0].isError, false, replies[0].text);
    assert(online > 0);
    replies = await run("加载业务规则解释口径。", [
      ["skill", { name: "sales-result-fixture" }],
      ["gea_capabilities", {}],
    ]);
    assert.equal(replies[0].isError, false, replies[0].text);
    assert.match(replies[0].text, /Scoped rule body/);
    const resources = await fetch(
      app.origin +
        "/api/agent-manage/resources?cwd=" +
        encodeURIComponent(app.runtime + "/workspace"),
      { headers: { Cookie: app.cookie, Origin: app.origin } },
    );
    assert.equal(resources.ok, true);
    const chosen = (await resources.json()).filter(
      (x) => x.id === "skill:sales-result-fixture",
    );
    assert.equal(chosen.length, 1);
    assert.equal(chosen[0].installed, true);
    assert.equal(chosen[0].enabled, true);
    assert.equal(chosen[0].provider, "user-panel");
    const catalogs = (await readSession(app.runtime, id)).filter(
      (row) =>
        row.type === "user/message" && row.data.source.kind === "skill-catalog",
    );
    assert.equal(catalogs.length, 1);
    assert.equal(catalogs[0].data.source.form, "catalog");
    assert.equal(
      catalogs[0].data.source.entries.filter(
        (x) => x.name === "sales-result-fixture",
      ).length,
      1,
    );
    assert.doesNotMatch(
      JSON.stringify(captured[0].messages),
      /Scoped rule body/,
    );
    assert.match(
      replies[0].text,
      /<skill_content name="sales-result-fixture">/,
    );
    const loaded = captured[1].messages.find(
      (message) =>
        message.role === "tool" && message.content.includes("Scoped rule body"),
    );
    assert.ok(loaded);
    assert.match(loaded.content, /<skill_content name="sales-result-fixture">/);
    const capabilities = JSON.parse(replies[1].text);
    assert.equal(capabilities.preset, "gea-readonly");
    assert.equal(capabilities.modulesAreConfiguredNotAuthorized, true);
    replies = await run("查询库存数量。", [
      [
        "mcp__gea-gateway__query_business_data",
        {
          action: "query",
          queries: [{ name: "inv", query: { measures: ["inv.row_count"] } }],
        },
      ],
    ]);
    assert.equal(queryCalls, 1);
    const direct = JSON.parse(replies[0].text);
    assert.equal(direct.datasets[0].rows[0]["inv.row_count"], 42);
    assert.equal(
      direct.evidenceId,
      undefined,
      "native MCP retains the direct server result",
    );
    const readArgs = (body) => {
      const receipt = body.messages
        .filter((message) => message.role === "system")
        .flatMap((message) => message.content.split("\n"))
        .find(
          (line) =>
            line.startsWith('{"evidenceId":') &&
            line.includes('"tool":"gea_sales_plan_read"'),
        );
      assert.ok(
        receipt,
        "sales evidence ID is advertised in the model's public result receipt",
      );
      evidenceId ??= JSON.parse(receipt).evidenceId;
      return { evidenceId, format: "raw", offset: 0, limit: 4000 };
    };
    replies = await run("核对当前在线审批清单及其证据。", [
      [
        "gea_sales_plan_read",
        { kind: "list", query: { periodId: "20260801" } },
      ],
      ["gea_evidence_read", readArgs],
      [
        "gea_evidence_read",
        () => ({ evidenceId, format: "raw", offset: 0, limit: 100 }),
      ],
    ]);
    assert.equal(replies[1].isError, false, replies[1].text);
    const first = JSON.parse(replies[1].text);
    assert.match(first.content, /"currentQty":"10"/);
    assert.match(first.content, /"currentAmount":"20"/);
    const audit = JSON.parse(replies[2].text);
    assert.equal(audit.content.length, Math.min(audit.totalChars, 100));
    revoked = true;
    replies = await run("继续读取刚才证据。", [
      ["gea_evidence_read", () => ({ evidenceId })],
    ]);
    assert.equal(replies[0].isError, true);
    assert.match(replies[0].text, /GEA_EVIDENCE_STALE/);
    assert.equal(
      queryCalls,
      1,
      "native sales evidence never reruns the MCP query",
    );
  },
);
