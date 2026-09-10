import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { profile, readSession, until } from "./profile.mjs";

test(
  "model authentication, rate limit, truncated stream, cancellation and explicit retry retain separate attempts",
  { timeout: 90000 },
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
    let mode = "401",
      held;
    let calls = 0;
    app.route((req, res, reply) => {
      if (req.url.pathname !== "/v1/chat/completions") return;
      calls += 1;
      if (mode === "401" || mode === "429") {
        reply(
          { error: { message: "fixture rejection", type: "fixture" } },
          Number(mode),
        );
        return true;
      }
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        "data: " +
          JSON.stringify({
            id: "fixture",
            choices: [
              {
                index: 0,
                delta: { content: "尚未完成的内容" },
                finish_reason: null,
              },
            ],
          }) +
          "\n\n",
      );
      if (mode === "hold") held = res;
      else if (mode === "truncated") res.end();
      else
        res.end(
          "data: " +
            JSON.stringify({
              id: "fixture",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
      return true;
    });
    await app.login();
    const page = (await app.rpc("plans")).value;
    const select = { queryId: page.queryId, planId: page.records[0].planId };
    let last;
    for (const failure of ["401", "429", "truncated"]) {
      mode = failure;
      const preview = (await app.rpc("prepare", select)).value;
      const sent = await app.rpc("submit", { previewId: preview.previewId });
      assert.equal(sent.ok, true, JSON.stringify(sent));
      last = sent.value.sessionId;
      const rows = await until(
        () => readSession(app.runtime, last),
        (rows) => rows.some((row) => row.type === "turn/end"),
      );
      assert.equal(
        rows.filter((row) => row.type === "assistant/message").length,
        0,
        failure +
          ": " +
          JSON.stringify(
            rows.filter((row) =>
              ["turn/end", "assistant/attempt"].includes(row.type),
            ),
          ),
      );
      assert.ok(
        rows.some((row) => row.type === "assistant/attempt"),
        JSON.stringify(rows.map((row) => row.type)),
      );
    }
    assert.equal(calls, 3);
    mode = "hold";
    const preview = (await app.rpc("prepare", select)).value;
    const id = (await app.rpc("submit", { previewId: preview.previewId })).value
      .sessionId;
    await until(async () => Boolean(held), Boolean);
    assert.equal(
      (await app.remote("session/cancel", { sessionId: id })).ok,
      true,
    );
    const cancelled = await until(
      () => readSession(app.runtime, id),
      (rows) => rows.some((row) => row.type === "turn/end"),
    );
    assert.ok(
      cancelled
        .filter((row) => row.type === "assistant/message")
        .every((row) => row.data.interrupted === true),
    );
    assert.equal(
      cancelled.find((row) => row.type === "turn/end").data.reason.kind,
      "aborted",
    );
    mode = "success";
    const retried = await app.remote("session/prompt", {
      requestId: randomUUID(),
      sessionId: id,
      mode: "queue",
      content: [
        { type: "text", text: "请基于同一个历史快照重试，不要重新查询。" },
      ],
    });
    assert.equal(retried.ok, true, JSON.stringify(retried));
    const rows = await until(
      () => readSession(app.runtime, id),
      (rows) => rows.filter((row) => row.type === "turn/end").length === 2,
    );
    assert.equal(
      rows.filter(
        (row) => row.type === "assistant/message" && !row.data.interrupted,
      ).length,
      1,
    );
    assert.equal(calls, 5);
    assert.equal(
      app.requests.filter((req) => req.url.pathname.endsWith("/plans")).length,
      1,
    );
  },
);
