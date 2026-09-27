import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { profile, readSession, until } from "./profile.mjs";

test(
  "GEA personal model preserves text and terminal states through the real profile",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      config: () => ({
        modelRequestTimeoutMs: 1000,
        analysis: {
          mode: "model",
          source: "gea",
          agentCode: "sales_forecast",
          model: "obsolete-configured-model",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
    });
    let mode = "stop";
    let held;
    let heldClosed = false;
    const modelRequests = [];
    const parts = ["源数据：", "数量差额 1.11。", "仅依据当前计划。"];
    const event = (value) => "data: " + JSON.stringify(value) + "\r\n\r\n";
    app.route((request, response, reply) => {
      const path = request.url.pathname;
      if (path === "/gea/aidata/user-agent-credential/my/list") {
        reply({
          success: true,
          result: {
            records: [{ id: "credential-1", status: "ACTIVE" }],
            total: 1,
          },
        });
        return true;
      }
      if (path === "/gea/aidata/user-agent-credential/my/claim") {
        reply({
          success: true,
          result: {
            credentialId: "credential-1",
            status: "ACTIVE",
            baseUrl: app.base + "/personal",
            secret: "fixture-personal-model-secret",
          },
        });
        return true;
      }
      if (path === "/gea/airag/airagModel/queryById") {
        reply({
          success: true,
          result: {
            id: "fixture-gea-model",
            name: "GEA 测试模型",
            apiKey: "metadata-secret",
          },
        });
        return true;
      }
      if (path === "/personal/models") {
        reply({ data: [{ id: "fixture-gea-model" }] });
        return true;
      }
      if (path !== "/personal/chat/completions") return false;
      modelRequests.push(request);
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.write(": heartbeat\r\n\r\n");
      for (const content of mode === "dsml"
        ? ['<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="gea_cube_query">']
        : parts)
        response.write(
          event({
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          }),
        );
      if (mode === "hold") {
        held = response;
        response.once("close", () => {
          heldClosed = true;
        });
      } else if (mode === "truncated") response.end();
      else if (mode === "done-only") response.end("data: [DONE]\r\n\r\n");
      else
        response.end(
          event({
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: mode === "dsml" ? "stop" : mode,
              },
            ],
          }) + "data: [DONE]\r\n\r\n",
        );
      return true;
    });
    await app.login();
    const discovered = await app.rpc("model/discover");
    assert.deepEqual(discovered.value, {
      models: ["fixture-gea-model"],
      selected: "fixture-gea-model",
      names: { "fixture-gea-model": "GEA 测试模型" },
      selectedName: "GEA 测试模型",
    });
    assert.ok(
      !JSON.stringify(discovered).includes("fixture-personal-model-secret"),
    );
    const page = (await app.rpc("plans")).value;
    const select = { queryId: page.queryId, planId: page.records[0].planId };
    const submit = async () => {
      const prepared = await app.rpc("prepare", select);
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      const sent = await app.rpc("submit", {
        previewId: prepared.value.previewId,
      });
      assert.equal(sent.ok, true, JSON.stringify(sent));
      return sent.value.sessionId;
    };
    const ended = (id) =>
      until(
        () => readSession(app.runtime, id),
        (rows) => rows.some((row) => row.type === "turn/end"),
      );
    await t.test(
      "the authoritative assistant message retains every streamed text fragment",
      async () => {
        const rows = await ended(await submit());
        const message = rows.find((row) => row.type === "assistant/message");
        assert.ok(message, JSON.stringify(rows));
        assert.ok(
          JSON.stringify(message).includes(parts.join("")),
          JSON.stringify(message),
        );
        assert.equal(
          rows.find((row) => row.type === "turn/end").data.reason.kind,
          "completed",
        );
        assert.equal(modelRequests.length, 1);
        assert.equal(
          modelRequests[0].headers.authorization,
          "Bearer fixture-personal-model-secret",
        );
        assert.equal(
          modelRequests[0].headers["x-gea-agent-code"],
          "sales_forecast",
        );
        assert.equal(
          JSON.parse(modelRequests[0].body).model,
          "fixture-gea-model",
        );
        assert.equal(
          JSON.stringify(rows).includes("fixture-personal-model-secret"),
          false,
        );
      },
    );
    await t.test(
      "transport EOF and DONE without finish_reason cannot become completed answers",
      async () => {
        for (const failure of ["truncated", "done-only"]) {
          mode = failure;
          const rows = await ended(await submit());
          assert.equal(
            rows.filter(
              (row) =>
                row.type === "assistant/message" && !row.data.interrupted,
            ).length,
            0,
            failure,
          );
          assert.notEqual(
            rows.find((row) => row.type === "turn/end").data.reason.kind,
            "completed",
            failure,
          );
          assert.ok(
            rows.some((row) => row.type === "assistant/attempt"),
            failure,
          );
        }
      },
    );
    await t.test(
      "tool syntax in plain text is rejected rather than completed or executed",
      async () => {
        mode = "dsml";
        const rows = await ended(await submit());
        assert.notEqual(
          rows.find((row) => row.type === "turn/end").data.reason.kind,
          "completed",
        );
        assert.equal(rows.filter((row) => row.type === "tool/call").length, 0);
        assert.match(JSON.stringify(rows), /GEA_MODEL_TOOL_TEXT/);
        assert.match(JSON.stringify(rows), /PROVIDER_PROTOCOL/);
      },
    );
    await t.test(
      "scoped discovery reports its consumer and rejects unknown presets",
      async () => {
        const found = await app.rpc("model/discover", {
          agentPreset: "gea-html-inventory-apsplan",
        });
        assert.equal(found.ok, true, JSON.stringify(found));
        assert.equal(found.value.consumerCode, "aps");
        const unknown = await app.rpc("model/discover", {
          agentPreset: "made-up",
        });
        assert.equal(unknown.ok, false);
        assert.match(JSON.stringify(unknown), /GEA_AGENT_PRESET_UNSUPPORTED/);
      },
    );
    await t.test(
      "unsupported model fails with a specific code before a completion request",
      async () => {
        const created = await app.remote("session/create", {
          cwd: app.runtime + "/workspace",
          agentPreset: "gea-readonly",
        });
        const sessionId = created.value.sessionId;
        await app.remote("session/selectModel", {
          sessionId,
          provider: "gea-analysis",
          model: "not-allowed",
        });
        const count = modelRequests.length;
        await app.remote("session/prompt", {
          sessionId,
          requestId: crypto.randomUUID(),
          mode: "queue",
          content: [{ type: "text", text: "fixture" }],
        });
        const rows = await ended(sessionId);
        assert.equal(modelRequests.length, count);
        assert.match(JSON.stringify(rows), /MODEL_NOT_FOUND/);
        assert.notEqual(
          rows.find((row) => row.type === "turn/end").data.reason.kind,
          "completed",
        );
      },
    );
    await t.test(
      "length is persisted as max-tokens and retains the partial answer",
      async () => {
        mode = "length";
        const rows = await ended(await submit());
        assert.equal(
          rows.find((row) => row.type === "turn/end").data.reason.kind,
          "max-tokens",
        );
        assert.ok(
          JSON.stringify(
            rows.find((row) => row.type === "assistant/message"),
          ).includes(parts.join("")),
        );
      },
    );
    await t.test(
      "cancelling closes the upstream response and records an aborted turn",
      async () => {
        mode = "hold";
        const id = await submit();
        await until(async () => Boolean(held), Boolean);
        assert.equal(
          (await app.remote("session/cancel", { sessionId: id })).ok,
          true,
        );
        const rows = await ended(id);
        assert.equal(
          rows.find((row) => row.type === "turn/end").data.reason.kind,
          "aborted",
        );
        await until(async () => heldClosed, Boolean);
        assert.ok(
          rows
            .filter((row) => row.type === "assistant/message")
            .every((row) => row.data.interrupted === true),
        );
      },
    );
    await t.test('stream total timeout preserves partial output and writes bounded diagnostics', async () => {
      mode = 'hold';
      held = undefined;
      heldClosed = false;
      const id = await submit();
      const rows = await ended(id);
      assert.notEqual(rows.find(row => row.type === 'turn/end').data.reason.kind, 'completed');
      assert.match(JSON.stringify(rows), /GEA_NETWORK_TIMEOUT/);
      assert.match(JSON.stringify(rows), /总时限/);
      assert.match(JSON.stringify(rows), /已收到响应/);
      assert.doesNotMatch(JSON.stringify(rows), /这不是参数问题/);
      await until(async () => heldClosed, Boolean);
      const log = await readFile(app.runtime + '/server.log', 'utf8');
      const failure = log.split('\n').filter(line => line.includes('GEA_MODEL_FAILURE')).map(line => {
        try { return JSON.parse(line.slice(line.indexOf('{'))); } catch { return null; }
      }).find(row => row?.sessionId === id);
      assert.ok(failure, log.slice(-3000));
      assert.equal(failure.code, 'GEA_NETWORK_TIMEOUT');
      assert.equal(failure.stage, '流式读取');
      assert.ok(failure.responseReceivedMs >= 0);
      assert.ok(failure.elapsedMs >= 900);
      assert.equal(failure.textChars, parts.join('').length);
      assert.equal(failure.timeoutMs, 1000);
      assert.doesNotMatch(JSON.stringify(failure), /fixture-personal-model-secret|源数据/);
      const request = log.split('\n').find(line => line.includes('GEA_MODEL_REQUEST') && line.includes(failure.requestId));
      assert.ok(request, 'failure must correlate with its request');
    });
    await t.test(
      "changing environment closes an active model stream and clears authentication",
      async () => {
        mode = "hold";
        held = undefined;
        heldClosed = false;
        const id = await submit();
        await until(async () => Boolean(held), Boolean);
        const changed = await app.rpc("environment/select", {
          environment: "production",
        });
        assert.equal(changed.value.authenticated, false);
        await until(async () => heldClosed, Boolean);
        const rows = await ended(id);
        assert.notEqual(
          rows.find((row) => row.type === "turn/end").data.reason.kind,
          "completed",
        );
        assert.ok(
          rows
            .filter((row) => row.type === "assistant/message")
            .every((row) => row.data.interrupted === true),
        );
      },
    );
  },
);
