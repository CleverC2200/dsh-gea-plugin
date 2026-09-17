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
    assert.ok(instructions.includes("本会话只读"));
    assert.ok(instructions.includes("只使用当前已加载且有权限的 GEA MCP 工具"));
    assert.ok(instructions.includes("不要展示或解释接口、工具名、字段名、JSON、哈希"));
    assert.deepEqual(
      body.tools.map((tool) => tool.function.name).sort(),
      [
        "gea_sales_plan_read",
        "gea_skill_reference_read",
        "gea_visible_workbench_context",
        "skill",
      ],
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
