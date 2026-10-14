import { selectBusinessResource } from "./fixtures/business-session.mjs";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readSession, readToolResults, until } from "./profile.mjs";
import { modelProfile as profile } from "./fixtures/model-profile.mjs";

for (const batchSize of [1, 3])
  test(
    "evidence budget ends tool use and resets on a new user turn; batch size " +
      batchSize,
    { timeout: 90000 },
    async (t) => {
      const app = await profile(t, {
        config: (base) => ({
          analysis: {
            mode: "model",
            baseUrl: base + "/v1",
            model: "fixture",
            apiKeyEnv: "GEA_BUDGET_TEST_KEY",
            agentCode: "sales_forecast",
            contextWindow: 32768,
            maxTokens: 2048,
          },
        }),
        env: { GEA_BUDGET_TEST_KEY: "fixture" },
      });
      let step = 0,
        evidenceId,
        phase = "exhaust";
      const captured = [];
      app.route((req, res, reply) => {
        const path = req.url.pathname;
        if (path.endsWith("/sales-plan/plans")) {
          reply({
            success: true,
            result: {
              records: [
                {
                  planId: "fixture-plan",
                  versionId: "fixture-version",
                  periodId: "20261001",
                  orderType: "M",
                  planTypeCode: "Y",
                  status: 1,
                  baseName: "fixture",
                  currentQty: "42",
                  currentAmount: "12.3400",
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
        if (path !== "/v1/chat/completions") return false;
        const body = JSON.parse(req.body);
        captured.push({ phase, step, body });
        const names = body.tools?.map((t) => t.function.name) || [];
        let call;
        if (phase === "exhaust") {
          if (step === 0)
            call = [
              "gea_sales_plan_read",
              { kind: "list", query: { periodId: "20261001" } },
            ];
          else {
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
            // Imitate a model that keeps following the advertised read tool after its allowance is spent.
            if (
              step <= 12 / batchSize + 2 &&
              names.includes("gea_evidence_read")
            )
              call = ["gea_evidence_read", { evidenceId, reload: true }];
          }
        }
        step++;
        const delta = call
          ? {
              tool_calls: Array.from(
                { length: call[0] === "gea_evidence_read" ? batchSize : 1 },
                (_, index) => ({
                  index,
                  id: randomUUID(),
                  type: "function",
                  function: {
                    name: call[0],
                    arguments: JSON.stringify(call[1]),
                  },
                }),
              ),
            }
          : { content: "已取得数量42；未读范围未完成，不据此排列全量。" };
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: call ? "tool_calls" : "stop",
                },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
        return true;
      });
      await app.login();
      await selectBusinessResource(app, "gea-readonly");
      const made = await app.remote("session/create", {
        cwd: app.runtime + "/workspace",
        agentPreset: "gea-readonly",
      });
      assert.equal(made.ok, true, JSON.stringify(made));
      const sessionId = made.value.sessionId;
      await app.remote("session/selectModel", {
        sessionId,
        provider: "gea-analysis",
        model: "fixture",
      });
      const ask = async (text) =>
        app.remote("session/prompt", {
          requestId: randomUUID(),
          sessionId,
          mode: "queue",
          content: [{ type: "text", text }],
        });
      await ask("读取当前在线工作流清单，并验证证据读取额度。");
      const events = await until(
        () => readSession(app.runtime, sessionId),
        (r) => r.some((e) => e.type === "turn/end"),
        40000,
      );
      const after = captured.find(
        (r) => r.phase === "exhaust" && r.step === 1 + 12 / batchSize,
      );
      assert.ok(after, "12 successful reads reached the budget boundary");
      assert.equal(
        after.body.tools?.length ?? 0,
        0,
        "exhausted evidence must end tool use even when ordinary query allowance remains",
      );
      assert.match(
        JSON.stringify(after.body.messages),
        /42/,
        "successful evidence survives the stop",
      );
      assert.match(
        JSON.stringify(after.body.messages),
        /证据读取额度已用完/,
        "the final-answer request must explain the stop",
      );
      const replies = readToolResults(events);
      assert.ok(replies.length > 0);
      assert.ok(
        replies.every((r) => !r.isError),
        "no repeated budget errors should be generated: " +
          JSON.stringify(replies.filter((r) => r.isError)),
      );
      assert.equal(
        events.filter(
          (e) => e.type === "tool/call" && e.data.name === "gea_evidence_read",
        ).length,
        12,
      );
      phase = "next-turn";
      step = 0;
      await ask("下一轮只解释缺货口径，不查数据。");
      await until(
        () => readSession(app.runtime, sessionId),
        (r) => r.filter((e) => e.type === "turn/end").length === 2,
        15000,
      );
      assert.ok(
        captured
          .find((r) => r.phase === "next-turn")
          .body.tools.some((t) => t.function.name === "gea_evidence_read"),
        "new user turn restores the bounded read allowance",
      );
    },
  );
