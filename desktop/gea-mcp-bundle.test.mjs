import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { profile, until, readSession } from "../tests/profile.mjs";

test(
  "shipped plugin graph routes an MCP call through the model loop and removes it on logout",
  { timeout: 90000 },
  async (t) => {
    assert.ok(
      process.env.GEA_MANAGE_GRAPH,
      "Set GEA_MANAGE_GRAPH to the actual packaged plugin graph",
    );
    const app = await profile(t, {
      desktopGraph: resolve(process.env.GEA_MANAGE_GRAPH),
      config: () => ({
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
    await app.stop();
    const path = join(app.dir, "gea.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    config.geaEnvironments = {
      production: app.base + "/gea",
      test: app.base + "/test",
    };
    config.environment = "production";
    await writeFile(path, JSON.stringify(config));
    await app.start();
    let callCount = 0;
    let modelResult;
    app.route((request, res, reply) => {
      const path = request.url.pathname;
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
            secret: "fixture-model-secret",
          },
        });
        return true;
      }
      if (path === "/personal/models") {
        reply({ data: [{ id: "model", name: "Test model" }] });
        return true;
      }
      if (path === "/personal/chat/completions") {
        const input = JSON.parse(request.body);
        modelResult = input.messages.find((x) => x.role === "tool");
        const name = input.tools.find((x) =>
          x.function.name.includes("probe_read"),
        )?.function.name;
        const delta = modelResult
          ? { content: "Read succeeded" }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: "probe-1",
                  type: "function",
                  function: { name, arguments: "{}" },
                },
              ],
            };
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: modelResult ? "stop" : "tool_calls",
                },
              ],
            }) +
            "\n\n",
        );
        return true;
      }

      if (request.url.pathname.endsWith("/ai/gateway/session")) {
        const input = JSON.parse(request.body);
        reply({
          success: true,
          result: {
            accessDecision: { allowed: true },
            gatewayContext: {
              consumerType: input.consumerType,
              consumerCode: input.consumerCode,
              sessionId: "fixture-session",
              conversationId: input.conversationId,
            },
            delegationToken: "fixture-delegation",
          },
        });
        return true;
      }
      if (!request.url.pathname.endsWith("/mcp/proxy/mcp")) return false;
      if (request.method === "GET") {
        reply({}, 405);
        return true;
      }
      const message = JSON.parse(request.body);
      if (message.id === undefined) {
        reply({}, 202);
        return true;
      }
      if (message.method === "tools/call") {
        assert.equal(message.params._meta.mcpCode, "mcp.gateway.session");
        assert.equal(
          message.params._meta.delegationToken,
          "fixture-delegation",
        );
        assert.deepEqual(message.params.arguments, {});
        callCount++;
        reply({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "route-verified" }] },
        });
        return true;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture-gea", version: "1" },
            }
          : {
              tools: [
                {
                  name: "probe_read",
                  description: "Read-only fixture",
                  _meta: {
                    sourceType: "MCP",
                    sourceCode: "mcp.gateway.session",
                  },
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            };
      reply({ jsonrpc: "2.0", id: message.id, result });
      return true;
    });
    const mcp = async () => {
      const response = await fetch(
        app.origin + "/api/agent-plugins/mcp-status",
        { headers: { Cookie: app.cookie }, signal: AbortSignal.timeout(10000) },
      );
      assert.equal(response.status, 200);
      return (await response.json()).entries.filter((entry) =>
        entry.name.includes("gea"),
      );
    };
    assert.equal((await mcp()).length, 0);
    await app.login();
    await until(
      mcp,
      (entries) =>
        entries.some((entry) =>
          entry.tools.some((tool) => tool.name.includes("probe_read")),
        ),
      7000,
    );
    const page = (await app.rpc("plans")).value;
    const preview = await app.rpc("prepare", {
      queryId: page.queryId,
      planId: page.records[0].planId,
    });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const submitted = await app.rpc("submit", {
      previewId: preview.value.previewId,
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    await until(
      () => readSession(app.runtime, submitted.value.sessionId),
      (rows) => rows.some((x) => x.type === "turn/end"),
      15000,
    );
    assert.equal(callCount, 1);
    assert.match(modelResult.content, /route-verified/);
    await app.rpc("logout");
    await until(mcp, (entries) => entries.length === 0, 7000);
  },
);
