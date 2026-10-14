import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readSession, readToolResults, until } from "./profile.mjs";
import { modelProfile as profile } from "./fixtures/model-profile.mjs";
import { createBusinessSession } from "./fixtures/business-session.mjs";
import { fixtureCubeTools, querySchema } from "./fixtures/cube-wire.mjs";

test(
  "native queries preserve successful reads, server denial, expiry and next-turn recovery",
  { timeout: 45000 },
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
      env: { GEA_TEST_MODEL_KEY: "fixture-key" },
    });
    const requests = [],
      queries = [],
      sessions = [];
    let phase = "read",
      step = 0;
    const query = (name) => ({
      action: "query",
      queries: [{ name, query: { measures: [name + ".row_count"], limit: 3 } }],
    });
    const call = (name) => ({
      index: 0,
      id: randomUUID(),
      type: "function",
      function: {
        name: "mcp__gea-gateway__query_business_data",
        arguments: JSON.stringify(query(name)),
      },
    });
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path.endsWith("/ai/gateway/session")) {
        const body = JSON.parse(req.body);
        sessions.push(body);
        reply({
          success: true,
          result: {
            accessDecision: { allowed: true },
            gatewayContext: {
              consumerType: "AGENT",
              consumerCode: body.consumerCode,
              sessionId: "trusted-session",
              conversationId: body.conversationId,
            },
            delegationToken: "delegation-fixture-secret",
          },
        });
        return true;
      }
      if (path.endsWith("/ai/gateway/mcp/proxy/mcp")) {
        const wire = JSON.parse(req.body);
        if (wire.method === "notifications/initialized") {
          res.statusCode = 202;
          res.end();
          return true;
        }
        let result = {};
        if (wire.method === "initialize") result = { protocolVersion: wire.params.protocolVersion };
        else if (wire.method === "tools/list") result = { tools: fixtureCubeTools };
        else if (wire.method === "tools/call") {
          queries.push(wire.params);
          const name = wire.params.arguments.queries[0].name;
          if (phase === "denied")
            result = {
              isError: true,
              structuredContent: {
                success: false,
                code: "AI_GATEWAY_DATA_PERMISSION_DENIED",
                category: "AUTHORIZATION",
                message: "该库存资源已撤权",
                requestId: "fixture-denial",
              },
            };
          else if (phase === "expired")
            result = {
              isError: true,
              structuredContent: {
                success: false,
                code: "AI_GATEWAY_SESSION_EXPIRED",
                category: "SESSION",
                message: "会话已过期",
              },
            };
          else if (name === "ship")
            result = {
              isError: true,
              structuredContent: {
                success: false,
                code: "SHIP_FIXTURE_FAILED",
                message: "fixture shipment failed",
              },
            };
          else
            result = {
              structuredContent: {
                action: "query",
                status: "completed",
                executedQueryCount: 1,
                datasets: [
                  {
                    name,
                    rowCount: 1,
                    dataStatus: "partial",
                    totalRowCount: 1,
                    offset: 0,
                    hasMorePages: false,
                    fields: [{ name: name + ".row_count", type: "number" }],
                    rows: [{ [name + ".row_count"]: 42 }],
                  },
                ],
              },
            };
        }
        reply({ jsonrpc: "2.0", id: wire.id, result });
        return true;
      }
      if (path !== "/v1/chat/completions") return false;
      const body = JSON.parse(req.body);
      requests.push({ phase, body });
      let delta;
      if (step++ === 0) {
        const calls =
          phase === "read" ? [call("inv"), { ...call("ship"), index: 1 }] : [call("inv")];
        delta = { tool_calls: calls };
      } else if (phase === "expired" && step === 2) delta = { tool_calls: [call("inv")] };
      else
        delta = {
          content:
            phase === "read"
              ? "库存返回42；发货失败，未提供单位与币种。"
              : phase === "denied"
                ? "本轮库存资源未授权。"
                : phase === "expired"
                  ? "会话过期，本轮停止。"
                  : "新一轮重新读取库存42。",
        };
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return true;
    });
    await app.login();
    const id = await createBusinessSession(app);
    await app.remote("session/selectModel", {
      sessionId: id,
      provider: "gea-analysis",
      model: "fixture",
    });
    let turns = 0;
    async function ask(text) {
      const before = await readSession(app.runtime, id);
      step = 0;
      const sent = await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId: id,
        mode: "queue",
        content: [{ type: "text", text }],
      });
      assert.equal(sent.ok, true, JSON.stringify(sent));
      const rows = await until(
        () => readSession(app.runtime, id),
        (events) => events.filter((event) => event.type === "turn/end").length > turns,
        15000,
      );
      turns++;
      return readToolResults(rows.slice(before.length));
    }
    const initial = await ask("查询库存和发货，缺失单位与币种不能补造。");
    assert.equal(queries.length, 2);
    assert.equal(initial[0].isError, false, initial[0].text);
    assert.equal(JSON.parse(initial[0].text).datasets[0].rows[0]["inv.row_count"], 42);
    assert.equal(JSON.parse(initial[0].text).datasets[0].dataStatus, "partial");
    assert.match(initial[1].text, /SHIP_FIXTURE_FAILED/);
    const schema = requests[0].body.tools.find(
      (tool) => tool.function.name === "mcp__gea-gateway__query_business_data",
    ).function.parameters;
    assert.deepEqual(schema, querySchema);
    assert.ok(
      queries.every(
        (entry) =>
          entry._meta.agentCode === "sales_forecast" &&
          entry._meta.mcpCode === "cube" &&
          entry._meta.sessionId === "trusted-session",
      ),
    );
    assert.doesNotMatch(JSON.stringify(requests), /delegation-fixture-secret|trusted-session/);
    phase = "denied";
    const denied = await ask("重新查询当前库存授权范围。");
    assert.equal(denied[0].isError, true);
    assert.match(denied[0].text, /AI_GATEWAY_DATA_PERMISSION_DENIED.*fixture-denial/s);
    assert.equal(
      queries.length,
      3,
      "current authorization is checked by one real server call, never by cached inspect visibility",
    );
    phase = "expired";
    const expired = await ask("会话过期时停止当前轮查询。");
    assert.equal(expired.length, 2);
    assert.match(expired[0].text, /GEA_GATEWAY_SESSION_EXPIRED/);
    assert.match(expired[1].text, /GEA_TURN_STOPPED/);
    assert.equal(
      queries.length,
      4,
      "the second tool attempt cannot reopen an expired gateway in the same turn",
    );
    const opened = sessions.length;
    phase = "recovered";
    const recovered = await ask("新一轮重新查询库存。");
    assert.equal(recovered[0].isError, false, recovered[0].text);
    assert.equal(queries.length, 5);
    assert.equal(sessions.length, opened + 1);
  },
);
