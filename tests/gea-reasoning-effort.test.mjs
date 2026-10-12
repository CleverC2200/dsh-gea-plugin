import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { profile, readSession, until } from "./profile.mjs";

/**
 * 个人模型网关 v2.6/v2.7 允许客户端按单次请求传 `extra_params` 覆盖模型默认参数。
 * 上游只认 high / max 两档，所以这里验证：GEA 模型在 DSH 模型目录里只声明这两档、
 * 默认 high；档位只以 `extra_params.reasoning_effort` 出现，且用户选择会被保留。
 */
test(
  "GEA personal model exposes reasoning efforts and sends the chosen one as extra_params",
  { timeout: 120000 },
  async (t) => {
    const app = await profile(t, {
      config: () => ({
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
    const bodies = [];
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
          result: { id: "fixture-gea-model", name: "GEA 测试模型" },
        });
        return true;
      }
      if (path === "/personal/models") {
        reply({ data: [{ id: "fixture-gea-model" }] });
        return true;
      }
      if (path !== "/personal/chat/completions") return false;
      bodies.push(JSON.parse(request.body));
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.write(
        "data: " +
          JSON.stringify({
            choices: [{ index: 0, delta: { content: "基于当前计划。" }, finish_reason: null }],
          }) +
          "\r\n\r\n",
      );
      response.end(
        "data: " +
          JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }) +
          "\r\n\r\ndata: [DONE]\r\n\r\n",
      );
      return true;
    });
    await app.login();
    const sourceProfile = process.env.GEA_TEST_SOURCE_CORE === "1";
    const settingsPath = resolve(
      app.runtime,
      sourceProfile
        ? "home/profiles/plugin-split-validation/cordis.patch.yml"
        : "home/settings.yaml",
    );
    const settings = async () => {
      try {
        return await readFile(settingsPath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return "";
        throw error;
      }
    };
    const submit = async () => {
      const page = (await app.rpc("plans")).value;
      const prepared = await app.rpc("prepare", {
        queryId: page.queryId,
        planId: page.records[0].planId,
      });
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      const sent = await app.rpc("submit", { previewId: prepared.value.previewId });
      assert.equal(sent.ok, true, JSON.stringify(sent));
      return until(
        () => readSession(app.runtime, sent.value.sessionId),
        (rows) => rows.some((row) => row.type === "turn/end"),
      );
    };
    // app.remote 固定把入参包成 {request}，无参方法要走原始协议。
    const remoteNoArgs = async (method) => {
      const response = await fetch(app.origin + "/api/" + method, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: app.cookie,
          Origin: app.origin,
        },
        body: JSON.stringify({
          type: "client-request",
          rpcId: randomUUID(),
          method,
          payload: { args: {} },
        }),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      const result = body.result ?? body;
      assert.equal(result.ok, true, text);
      return result.value;
    };

    await t.test("模型目录只声明高/最高两档，默认档位是 high", async () => {
      await app.rpc("model/discover");
      const catalog = await remoteNoArgs("session/modelCatalog");
      const group = catalog.groups.find((entry) => entry.id === "gea-analysis");
      assert.ok(group, JSON.stringify(catalog));
      const model = group.models.find((entry) => entry.id === "fixture-gea-model");
      assert.ok(model, JSON.stringify(group));
      assert.deepEqual(
        model.reasoning?.efforts.map((effort) => [effort.id, effort.name]),
        [
          ["high", "高"],
          ["max", "最高"],
        ],
      );
      assert.equal(model.reasoning?.defaultEffort, "high");
    });

    await t.test("未显式选档位时按默认档位发送 extra_params", async () => {
      await submit();
      assert.equal(bodies.length >= 1, true);
      for (const body of bodies) assert.deepEqual(body.extra_params, { reasoning_effort: "high" });
    });

    await t.test("选中的档位只以 extra_params 覆盖，且模型发现不冲掉档位", async () => {
      const before = bodies.length;
      const stored = await settings();
      await app.stop();
      await writeFile(
        settingsPath,
        sourceProfile
          ? stringify([
              ...parse(stored).filter((row) => row.id !== "agent-default-model"),
              {
                id: "agent-default-model",
                config: {
                  provider: "gea-analysis",
                  model: "fixture-gea-model",
                  reasoningEffort: "max",
                },
              },
            ])
          : stored.replace(/agent-default-model:\n( {2}.*\n)*/, "") +
              [
                "agent-default-model:",
                "  provider: gea-analysis",
                '  model: "fixture-gea-model"',
                "  reasoningEffort: max",
                "",
              ].join("\n"),
      );
      await app.start();
      await app.login();
      await app.rpc("model/discover");
      const saved = parse(await settings());
      assert.equal(
        (sourceProfile
          ? saved.find((row) => row.id === "agent-default-model")?.config
          : saved["agent-default-model"]
        )?.reasoningEffort,
        "max",
        "模型发现重写默认选择时必须保留已选档位",
      );
      await submit();
      const sent = bodies.slice(before).at(-1);
      assert.deepEqual(sent.extra_params, { reasoning_effort: "max" });
      assert.equal(sent.model, "fixture-gea-model");
      assert.equal(sent.reasoning_effort, undefined);
      assert.equal(sent.stream, true);
      assert.equal(Array.isArray(sent.messages), true);
    });
  },
);
