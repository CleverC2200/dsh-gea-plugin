import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { readSession, readToolResults, until } from "./profile.mjs";
import { modelProfile as profile } from "./fixtures/model-profile.mjs";
test(
  "native result route, atomic skill load and structured evidence reuse retain authorization",
  { timeout: 90000 },
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
      env: { GEA_TEST_MODEL_KEY: "fixture" },
    });
    const skillDir = app.runtime + "/home/business-skills/sales-result-fixture";
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      skillDir + "/SKILL.md",
      "---\nname: sales-result-fixture\ndescription: result fixture\n---\nScoped rule body.",
    );
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
                currentQty: "10",
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
          result =
            a.action === "inspect"
              ? {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        semanticModel: [
                          { name: "inv", measures: [{ name: "inv.row_count", type: "number" }] },
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
                        datasets: [
                          { name: "inv", rows: [{ "inv.row_count": 42 }], complete: true },
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
      const args = step && typeof step[1] === "function" ? step[1](body) : step?.[1];
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
            choices: [{ index: 0, delta, finish_reason: step ? "tool_calls" : "stop" }],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return true;
    });
    await app.login();
    const made = await app.remote("session/create", {
      cwd: app.runtime + "/workspace",
      agentPreset: "gea-readonly",
    });
    const id = made.value.sessionId;
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
    let replies = await run("8月最终销售计划，只能使用Hive，不要使用在线计划接口。", [
      ["gea_sales_plan_read", { kind: "periods" }],
    ]);
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
    const chosen = JSON.parse(replies[1].text).skills.find(
      (x) => x.name === "sales-result-fixture",
    );
    assert.equal(chosen.enabled, true);
    assert.equal(chosen.bodyLoaded, true);
    const readArgs = (body) => {
      evidenceId ??= JSON.parse(
        body.messages.filter((m) => m.role === "tool").at(-1).content,
      ).evidenceId;
      return { evidenceId, limit: 4000 };
    };
    replies = await run("查询库存数量。", [
      ["gea_cube_query", { queries: [{ name: "inv", query: { measures: ["inv.row_count"] } }] }],
      ["gea_evidence_read", readArgs],
      ["gea_evidence_read", readArgs],
      ["gea_evidence_read", () => ({ evidenceId, format: "raw", offset: 0, limit: 100 })],
    ]);
    assert.equal(queryCalls, 1);
    const first = JSON.parse(replies[1].text);
    assert.equal(first.datasets[0].table.rows[0]["inv.row_count"], 42);
    assert.equal(first.content, undefined);
    assert.equal(JSON.parse(replies[2].text).projection, "already-delivered");
    const audit = JSON.parse(replies[3].text);
    assert.equal(audit.content.length, Math.min(audit.totalChars, 100));
    assert.match(audit.content, /inv.row_count/);
    revoked = true;
    replies = await run("继续读取刚才证据。", [["gea_evidence_read", () => ({ evidenceId })]]);
    assert.equal(replies[0].isError, true);
    assert.match(replies[0].text, /AUTHORIZATION_CHANGED/);
    assert.equal(queryCalls, 1);
  },
);
