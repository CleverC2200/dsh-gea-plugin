import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { profile, readSession, until } from "./profile.mjs";

test(
  "GEA tools use the native model-tool-model loop and persist success, permission errors and cancellation",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      config: () => ({
        requestTimeoutMs: 1000,
        analysis: {
          mode: "model",
          source: "gea",
          agentCode: "sales_forecast",
          model: "model",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
    });
    let outcome = "success";
    let toolReply;
    let closed = false;
    let modelRequests = [];
    const event = (delta, finish = null) =>
      "data: " +
      JSON.stringify({
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) +
      "\n\n";
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path.endsWith("/user-agent-credential/my/list")) {
        reply({
          success: true,
          result: {
            records: [{ id: "credential", status: "ACTIVE" }],
            total: 1,
          },
        });
        return true;
      }
      if (path.endsWith("/user-agent-credential/my/claim")) {
        reply({
          success: true,
          result: {
            credentialId: "credential",
            status: "ACTIVE",
            baseUrl: app.base + "/personal",
            secret: "fixture-only-model-secret",
          },
        });
        return true;
      }
      if (path === "/personal/models") {
        reply({ data: [{ id: "model", name: "Test model" }] });
        return true;
      }
      if (path.endsWith("/periods")) {
        if (outcome === "forbidden") reply({ message: "Forbidden" }, 403);
        else if (outcome === "hold" || outcome === "timeout") {
          toolReply = res;
          res.once("close", () => {
            closed = true;
          });
        } else if (outcome === "oversize")
          reply({
            success: true,
            result: {
              records: [{ periodId: "x", notes: "x".repeat(40000) }],
              total: 1,
            },
          });
        else
          reply({
            success: true,
            result: {
              records: [{ periodId: "period-1", periodMonth: "2026-09" }],
              total: 2,
              size: 1,
              current: 1,
              pages: 2,
            },
          });
        return true;
      }
      if (path !== "/personal/chat/completions") return false;
      const body = JSON.parse(req.body);
      modelRequests.push(body);
      res.setHeader("Content-Type", "text/event-stream");
      if (!body.messages.some((x) => x.role === "tool")) {
        res.end(
          event(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "read-1",
                  type: "function",
                  function: {
                    name: "gea_sales_plan_read",
                    arguments: JSON.stringify({
                      kind: outcome === "status-filter" ? "list" : "periods",
                      query:
                        outcome === "invalid"
                          ? { tenantId: "forged" }
                          : outcome === "status-filter"
                            ? { pageSize: 1, status: 5 }
                            : { pageSize: 1 },
                    }),
                  },
                },
              ],
            },
            "tool_calls",
          ),
        );
      } else
        res.end(
          event({ content: "已根据工具返回的覆盖范围完成只读分析。" }, "stop"),
        );
      return true;
    });
    await app.login();
    const page = (await app.rpc("plans")).value;
    async function submit() {
      const preview = await app.rpc("prepare", {
        queryId: page.queryId,
        planId: page.records[0].planId,
      });
      assert.equal(preview.ok, true, JSON.stringify(preview));
      const result = await app.rpc("submit", {
        previewId: preview.value.previewId,
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.value.sessionId;
    }
    const ended = (id) =>
      until(
        () => readSession(app.runtime, id),
        (rows) => rows.some((x) => x.type === "turn/end"),
      );
    await t.test(
      "successful query is logged before the next model request and preserves paging coverage",
      async () => {
        const rows = await ended(await submit());
        assert.equal(
          rows.find((x) => x.type === "turn/end").data.reason.kind,
          "completed",
        );
        assert.equal(modelRequests.length, 2);
        assert.deepEqual(
          modelRequests[0].tools.map((x) => x.function.name),
          ["gea_sales_plan_read", "skill"],
        );
        const result = modelRequests[1].messages.find((x) => x.role === "tool");
        assert.equal(result.tool_call_id, "read-1");
        const value = JSON.parse(result.content);
        assert.equal(value.coverage, "partial");
        assert.equal(value.value.total, 2);
        const snapshot = JSON.parse(
          await readFile(
            new URL(
              "./fixtures/gea-agent-tools.snapshot.json",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        const call = rows.find((x) => x.type === "tool/call");
        assert.deepEqual(
          {
            events: rows
              .filter((x) => snapshot.events.includes(x.type))
              .map((x) => x.type),
            tool: call.data.name,
            arguments: JSON.parse(call.data.arguments),
            coverage: value.coverage,
            value: value.value,
            finish: rows.find((x) => x.type === "turn/end").data.reason.kind,
          },
          snapshot,
        );
        assert.ok(
          rows.findIndex((x) => x.type === "tool/call") <
            rows.findIndex((x) => x.type === "tool/result"),
        );
        assert.equal(
          JSON.stringify(rows).includes("fixture-only-model-secret"),
          false,
        );
        assert.equal(JSON.stringify(rows).includes("fixture-gea-token"), false);
        const read = app.requests.find((x) =>
          x.url.pathname.endsWith("/periods"),
        );
        assert.equal(read.method, "GET");
        assert.equal(read.headers["x-tenant-id"], "0");
      },
    );
    await t.test(
      "integer plan status reaches GEA through the advertised tool schema",
      async () => {
        outcome = "status-filter";
        modelRequests = [];
        const rows = await ended(await submit());
        const result = modelRequests[1].messages.find((x) => x.role === "tool");
        assert.equal(JSON.parse(result.content).source, "GEA_LIVE_READONLY");
        assert.equal(
          app.requests
            .filter((x) => x.url.pathname.endsWith("/plans"))
            .at(-1)
            .url.searchParams.get("status"),
          "5",
        );
        assert.equal(
          rows.find((x) => x.type === "turn/end").data.reason.kind,
          "completed",
        );
      },
    );
    await t.test(
      "403 is a persisted tool failure, never an empty successful collection",
      async () => {
        outcome = "forbidden";
        modelRequests = [];
        const rows = await ended(await submit());
        const result = rows.find((x) => x.type === "tool/result");
        assert.ok(result, JSON.stringify(rows));
        assert.match(JSON.stringify(result), /403|PERMISSION|FORBIDDEN/i);
        assert.match(
          modelRequests[1].messages.find((x) => x.role === "tool").content,
          /403|PERMISSION|FORBIDDEN/i,
        );
      },
    );
    await t.test(
      "invalid routing and oversized results fail without fabricating a successful collection",
      async () => {
        for (const [mode, code] of [
          ["invalid", "invalid arguments"],
          ["oversize", "SNAPSHOT_TOO_LARGE"],
        ]) {
          outcome = mode;
          modelRequests = [];
          const before = app.requests.filter((x) =>
            x.url.pathname.endsWith("/periods"),
          ).length;
          const rows = await ended(await submit());
          assert.match(
            modelRequests[1].messages.find((x) => x.role === "tool").content,
            new RegExp(code),
          );
          assert.ok(
            rows.find((x) => x.type === "tool/result").data.message.content[0]
              .isError,
          );
          if (mode === "invalid")
            assert.equal(
              app.requests.filter((x) => x.url.pathname.endsWith("/periods"))
                .length,
              before,
            );
        }
      },
    );
    await t.test(
      "read timeout is recorded explicitly and a subsequent analysis can finish",
      async () => {
        outcome = "timeout";
        modelRequests = [];
        const rows = await ended(await submit());
        assert.match(
          modelRequests[1].messages.find((x) => x.role === "tool").content,
          /GEA_REQUEST_TIMEOUT|tool call timed out/,
        );
        assert.equal(
          rows.find((x) => x.type === "turn/end").data.reason.kind,
          "completed",
        );
        await until(async () => closed, Boolean);
        toolReply = undefined;
        closed = false;
      },
    );
    await t.test(
      "cancel closes a pending business read and persists an aborted turn",
      async () => {
        outcome = "hold";
        toolReply = undefined;
        closed = false;
        modelRequests = [];
        const id = await submit();
        await until(async () => Boolean(toolReply), Boolean);
        await app.remote("session/cancel", { sessionId: id });
        const rows = await ended(id);
        assert.equal(
          rows.find((x) => x.type === "turn/end").data.reason.kind,
          "aborted",
        );
        await until(async () => closed, Boolean);
        assert.ok(rows.some((x) => x.type === "tool/call"));
        assert.ok(rows.some((x) => x.type === "tool/result"));
        assert.equal(modelRequests.length, 1);
      },
    );
  },
);
