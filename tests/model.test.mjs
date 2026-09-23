import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { profile, readSession, until } from "./profile.mjs";

test(
  "configured model receives the exact logged snapshot with the GEA read and skill tools and no duplicate title calls",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        analysis: {
          mode: "model",
          baseUrl: base + "/v1",
          model: "fixture-model",
          apiKeyEnv: "GEA_TEST_MODEL_KEY",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: { GEA_TEST_MODEL_KEY: "fixture-model-key" },
    });
    const modelRequests = [];
    app.route((req, res) => {
      if (req.url.pathname === "/v1/chat/completions") {
        modelRequests.push(req);
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          "data: " +
            JSON.stringify({
              id: "fixture-completion",
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: {
                    content:
                      "基于源数据：数量差额 1.11。未提供 SKU，无法判断结构。",
                  },
                  finish_reason: null,
                },
              ],
            }) +
            "\n\ndata: " +
            JSON.stringify({
              id: "fixture-completion",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
        return true;
      }
    });
    await app.login();
    const page = (await app.rpc("plans")).value;
    const prepared = (
      await app.rpc("prepare", {
        queryId: page.queryId,
        planId: page.records[0].planId,
      })
    ).value;
    const sent = await app.rpc("submit", { previewId: prepared.previewId });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const rows = await until(
      () => readSession(app.runtime, sent.value.sessionId),
      (rows) => rows.some((row) => row.type === "turn/end"),
    );
    assert.equal(modelRequests.length, 1);
    assert.equal(
      modelRequests[0].headers.authorization,
      "Bearer fixture-model-key",
    );
    const body = JSON.parse(modelRequests[0].body);
    assert.equal(body.model, "fixture-model");
    const instructions = JSON.stringify(
      body.messages.filter((message) => message.role !== "user"),
    );
    assert.ok(instructions.includes("只有用户明确要求时才动用页面操作工具"));
    assert.ok(instructions.includes("只使用当前已加载且有权限的 GEA MCP 工具"));
    // 位置事实由宿主每轮注入：没有业务菜单的会话直接告诉模型"别读页面"，
    // 免得它先调页面工具去问一次（那一次必然白跑）。
    assert.ok(
      JSON.stringify(body.messages).includes("【业务位置｜宿主事实】"),
      "系统提示里要带当前业务位置",
    );
    // Cube 侧实测的两类错法要写进协议：dimension 塞进 measures 会回
    // "not found for path"；日期值写成年月会报 invalid input syntax for type date。
    assert.ok(
      instructions.includes("not found for path"),
      "协议里要写清 Cube 的 not found for path 该怎么理解",
    );
    assert.ok(
      instructions.includes("YYYY-MM-DD"),
      "协议里要写清日期成员的取值格式",
    );
    assert.ok(instructions.includes("不要展示或解释接口、工具名、字段名、JSON、哈希"));
    // 内置插件 dsh-genui 会向系统提示追加 ```dsh-ui 围栏契约，让模型能在
    // 回答里渲染界面；这里显式记录该行为，避免它变成无声的提示词漂移。
    assert.ok(instructions.includes("dsh-ui"));
    assert.deepEqual(
      body.tools.map((tool) => tool.function.name).sort(),
      [
        // 问答侧关掉受管 SQL 之后，取数工具只剩模块 MCP（gea_module_mcp）与计划只读。
        "gea_gateway_catalog",
        "gea_module_mcp",
        "gea_page",
        "gea_sales_plan_read",
        "gea_skill_reference_read",
        "gea_visible_workbench_context",
        // 内置插件 dsh-genui 注册的界面渲染与校验工具。
        "render_ui",
        "skill",
        "validate_dsh_ui",
      ],
    );
    // 默认不允许模型自己写 SQL：受管只读工具不能出现在工具清单里。
    assert.equal(
      body.tools.some((tool) => tool.function.name === "gea_plugin_read"),
      false,
      "默认配置下不给模型暴露 gea_plugin_read",
    );
    const submitted = rows.find(
      (row) =>
        row.type === "user/message" && row.data.source.plugin === "gea-proof",
    );
    assert.equal(submitted.data.source.form, "notice");
    assert.equal(
      submitted.data.source.summary,
      "已提交只读分析：对比所选计划的数量和金额差异",
    );
    assert.equal(
      rows.some(
        (row) => row.type === "user/message" && row.data.source.kind === "user",
      ),
      false,
    );
    const user = body.messages.find((message) => message.role === "user");
    const prompt = JSON.stringify(user);
    assert.ok(prompt.includes("业务资料（共 1 条计划）"));
    assert.ok(prompt.includes("数量（目标 / 当前）"));
    assert.equal(prompt.includes("GEA_SNAPSHOT_SHA256"), false);
    assert.equal(prompt.includes("gea-readonly-v1"), false);
    assert.equal(prompt.includes("sourceUrl"), false);
    assert.equal(prompt.includes("fetchedAt"), false);
    const archive = JSON.parse(
      await readFile(
        resolve(
          app.runtime,
          "analysis-snapshots",
          sent.value.sessionId + ".json",
        ),
        "utf8",
      ),
    );
    assert.equal(archive.sessionId, sent.value.sessionId);
    assert.equal(archive.snapshotHash, prepared.snapshotHash);
    assert.deepEqual(archive.snapshot, prepared.snapshot);
    assert.equal(prepared.snapshot.calculations.quantityGap.value, "1.11");
    assert.equal(prepared.snapshot.calculations.amountGap.value, "2.2");
    assert.ok(
      JSON.stringify(
        rows.find((row) => row.type === "assistant/message"),
      ).includes("未提供 SKU"),
    );
    assert.equal(JSON.stringify(rows).includes("fixture-model-key"), false);
  },
);

test(
  "显式打开 agentSqlRead 时，受管只读 SQL 工具才回到工具清单",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        agentSqlRead: true,
        analysis: {
          mode: "model",
          baseUrl: base + "/v1",
          model: "fixture-model",
          apiKeyEnv: "GEA_TEST_MODEL_KEY",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: { GEA_TEST_MODEL_KEY: "fixture-model-key" },
    });
    const modelRequests = [];
    app.route((req, res) => {
      if (req.url.pathname !== "/v1/chat/completions") return;
      modelRequests.push(req);
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            id: "fixture-completion",
            object: "chat.completion.chunk",
            choices: [
              { index: 0, delta: { content: "已按只读通道作答。" }, finish_reason: null },
            ],
          }) +
          "\n\ndata: " +
          JSON.stringify({
            id: "fixture-completion",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return true;
    });
    await app.login();
    const page = (await app.rpc("plans")).value;
    const prepared = (
      await app.rpc("prepare", {
        queryId: page.queryId,
        planId: page.records[0].planId,
      })
    ).value;
    const sent = await app.rpc("submit", { previewId: prepared.previewId });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await until(
      () => readSession(app.runtime, sent.value.sessionId),
      (rows) => rows.some((row) => row.type === "turn/end"),
    );
    const names = JSON.parse(modelRequests[0].body).tools.map(
      (tool) => tool.function.name,
    );
    assert.ok(names.includes("gea_plugin_read"), "显式打开后 SQL 工具应存在");
    // 索引只挂一份：SQL 通道开着时挂在 gea_plugin_read，不再重复挂在 MCP 说明里。
    const mcp = JSON.parse(modelRequests[0].body).tools.find(
      (tool) => tool.function.name === "gea_module_mcp",
    );
    assert.equal(
      mcp.function.description.includes("模块清单（只有名称与编码，细节按需取）："),
      false,
      "索引只挂一份：SQL 通道开着时不再重复挂到 MCP 说明里",
    );
  },
);
