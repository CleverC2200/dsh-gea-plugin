import { stockMcpRoute, stockState } from "./fixtures/branch-stock.mjs";
import { currentHtmlResource } from "./fixtures/html-resource.mjs";
import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { profile, readSession, readToolResults, until } from "./profile.mjs";
import { createBusinessSession } from "./fixtures/business-session.mjs";
import { prepareWorkbenchHtmlRoots } from "./fixtures/business-page.mjs";

test(
  "GEA tools use the native model-tool-model loop and persist success, permission errors and cancellation",
  { timeout: 90000 },
  async (t) => {
    // 一个最小的业务页面插件：只用来验证"普通对话里页面工具怎么回答模型"。
    const probeRoot = await mkdtemp(join(tmpdir(), "gea-page-probe-"));
    const probeSkill = [
      "---",
      "name: inventory-probe",
      "description: 探针业务规则，用于验证主对话能按需加载业务 skill。",
      "---",
      "",
      "# 探针页面",
      "",
      "## 计算规则",
      "",
      "PROBE-RULE-42：建议量 = ceil(max(0, 缺货量 − 调拨中量))，缺失输入按未知处理，不按零。",
      "",
    ].join("\n");
    await mkdir(join(probeRoot, "skills", "probe"), { recursive: true });
    // 页面里带上它自己的受管 SQL：能力契约据此静态导出"这个模块能读哪些表"。
    await writeFile(
      join(probeRoot, "index.html"),
      [
        "<!doctype html><html><body>probe",
        "<script>",
        'const rows = await sql("SELECT sku_code, shortage FROM data_service.agents_scm_probe_thing WHERE base = :base");',
        "</script></body></html>",
      ].join("\n"),
    );
    await writeFile(join(probeRoot, "skills", "probe", "SKILL.md"), probeSkill);
    // 主对话（标准 agent）按默认根扫描技能：这里把同一份业务规则挂到 DSH_AGENTS_HOME 下。
    const agentsHome = await mkdtemp(join(tmpdir(), "gea-agents-home-"));
    await mkdir(join(agentsHome, "skills", "inventory-probe"), { recursive: true });
    await writeFile(join(agentsHome, "skills", "inventory-probe", "SKILL.md"), probeSkill);
    await mkdir(join(agentsHome, "skills", "tdd"), { recursive: true });
    await writeFile(
      join(agentsHome, "skills", "tdd", "SKILL.md"),
      "---\nname: tdd\ndescription: DEVELOPER_SKILL_MUST_NOT_LEAK\n---\nDeveloper-only rules.\n",
    );
    await writeFile(
      join(probeRoot, "plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "inventory-probe",
        name: "探针页面",
        version: "0.0.0",
        html: "index.html",
        skills: ["skills/probe/SKILL.md"],
        mcp: "mcp.json",
        mode: "mock",
        gea: { consumerCode: "probe-consumer", readonly: true, contract: "gea-html-v1" },
      }),
    );
    await writeFile(
      join(probeRoot, "mcp.json"),
      JSON.stringify({
        provider: "gea",
        transport: "host-provided",
        contract: "gea-html-v1",
        consumer: { consumerType: "AGENT", consumerCode: "probe-consumer" },
        capabilities: [],
      }),
    );
    // 第二个模块：非演示（真实）模块，用来验证"权限没开通"这类网关侧状态。
    const realRoot = await mkdtemp(join(tmpdir(), "gea-real-probe-"));
    await mkdir(join(realRoot, "skills", "probe"), { recursive: true });
    await writeFile(
      join(realRoot, "index.html"),
      "<!doctype html><html><body>real probe</body></html>\n",
    );
    await writeFile(
      join(realRoot, "skills", "probe", "SKILL.md"),
      "---\nname: inventory-real\ndescription: 真模块探针。\n---\n\n先读 [规则](../../references/rules.md)\n",
    );
    await writeFile(
      join(realRoot, "plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "inventory-real",
        name: "真模块探针",
        version: "0.0.0",
        html: "index.html",
        skills: ["skills/probe/SKILL.md"],
        mcp: "mcp.json",
        gea: { consumerCode: "branch-inventory", readonly: true, contract: "gea-html-v1" },
      }),
    );
    await writeFile(
      join(realRoot, "mcp.json"),
      JSON.stringify({
        provider: "gea",
        transport: "host-provided",
        contract: "gea-html-v1",
        consumer: { consumerType: "AGENT", consumerCode: "branch-inventory" },
        capabilities: ["governed-sql-read"],
      }),
    );
    await mkdir(join(realRoot, "references"), { recursive: true });
    await writeFile(
      join(realRoot, "references", "rules.md"),
      "按实际期间查询；缺失数据不能编造。\n",
    );
    await currentHtmlResource(probeRoot);
    await currentHtmlResource(realRoot);
    const app = await profile(t, {
      pluginRoot: process.env.GEA_TEST_PLUGIN_ROOT,
      bundle: Boolean(process.env.GEA_TEST_PLUGIN_ROOT),
      env: { DSH_AGENTS_HOME: agentsHome },
      beforeStart: prepareWorkbenchHtmlRoots([probeRoot, realRoot]),
      config: () => ({
        cubeMcpCodes: { production: "cube" },
        requestTimeoutMs: 1000,
        visibleContextSubagent: false,
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
    if (process.env.GEA_TEST_LIFECYCLE_RECEIPT)
      t.after(() =>
        writeFile(process.env.GEA_TEST_LIFECYCLE_RECEIPT + ".host.log", app.output, {
          mode: 0o600,
        }),
      );
    let outcome = "success";
    let toolReply;
    let closed = false;
    let modelRequests = [];
    const mcpState = stockState();
    const event = (delta, finish = null) =>
      "data: " +
      JSON.stringify({
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) +
      "\n\n";
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path.endsWith("/ai/gateway/mcp/proxy/mcp")) {
        const wire = JSON.parse(req.body);
        if (outcome === "module-mcp-denied" && wire.method === "tools/call") {
          reply({
            jsonrpc: "2.0",
            id: wire.id,
            result: {
              isError: true,
              structuredContent: {
                code: "AI_GATEWAY_DATA_PERMISSION_DENIED",
                message: "当前用户无权访问该Agent",
              },
            },
          });
          return true;
        }
        if (stockMcpRoute(req, res, reply, mcpState)) return true;
      }
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
      if (path.endsWith("/plans") && req.url.searchParams.get("pageSize") === "200") {
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
              records: Array.from({ length: 200 }, (_, index) => ({
                planId: `oversize-${index}`,
                periodId: `202610${String(index).padStart(3, "0")}-${"x".repeat(200)}`,
                planTypeCode: "Y",
                orderType: "M",
              })),
              total: 200,
              size: 200,
              current: 1,
              pages: 1,
            },
          });
        else
          reply({
            success: true,
            result: {
              records: [
                {
                  planId: "period-plan-1",
                  periodId: "20261001",
                  planTypeCode: "Y",
                  orderType: "M",
                },
                {
                  planId: "period-plan-2",
                  periodId: "20260901",
                  planTypeCode: "Y",
                  orderType: "M",
                },
              ],
              total: 2,
              size: 200,
              current: 1,
              pages: 1,
            },
          });
        return true;
      }
      if (path !== "/personal/chat/completions") return false;
      const body = JSON.parse(req.body);
      res.setHeader("Content-Type", "text/event-stream");
      modelRequests.push(body);
      if (outcome === "skill-reference") {
        const results = body.messages.filter((x) => x.role === "tool");
        const name = results.length === 0 ? "skill" : "skill_reference_read";
        const args =
          results.length === 0
            ? { name: "reference-scope" }
            : { skill: "reference-scope", path: "../../references/rules.md" };
        res.end(
          results.length < 2
            ? event(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: `reference-${results.length}`,
                      type: "function",
                      function: { name, arguments: JSON.stringify(args) },
                    },
                  ],
                },
                "tool_calls",
              )
            : event({ content: "已读取本地规则，按实际期间查询。" }, "stop"),
        );
        return true;
      }
      if (outcome === "visible-context") {
        const hasVisibleContext = body.messages.some(
          (message) =>
            message.role === "tool" &&
            typeof message.content === "string" &&
            message.content.includes("GEA_RENDERED_WORKBENCH"),
        );
        res.end(
          hasVisibleContext
            ? event({ content: "已按当前可见客户范围回答。" }, "stop")
            : event(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "visible-context-1",
                      type: "function",
                      function: {
                        name: "gea_visible_workbench_context",
                        arguments: "{}",
                      },
                    },
                  ],
                },
                "tool_calls",
              ),
        );
        return true;
      }
      if (outcome === "module-mcp-denied") {
        const results = body.messages.filter((x) => x.role === "tool");
        res.end(
          results.length === 0
            ? event(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "module-mcp-denied-1",
                      type: "function",
                      function: {
                        name: "mcp__gea-gateway__query_business_data",
                        arguments: JSON.stringify({
                          action: "query",
                          queries: [
                            {
                              name: "branch_stock",
                              query: {
                                measures: ["branch_stock.available_qty"],
                                limit: 10,
                              },
                            },
                          ],
                        }),
                      },
                    },
                  ],
                },
                "tool_calls",
              )
            : event({ content: "这个模块的权限还没开通。" }, "stop"),
        );
        return true;
      }
      if (outcome === "module-mcp-mock") {
        const results = body.messages.filter((x) => x.role === "tool");
        res.end(
          results.length === 0
            ? event(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "module-mcp-1",
                      type: "function",
                      function: {
                        name: "mcp__gea-gateway__query_business_data",
                        arguments: JSON.stringify({
                          action: "query",
                          consumerCode: "probe-consumer",
                          queries: [
                            {
                              name: "branch_stock",
                              query: {
                                measures: ["branch_stock.available_qty"],
                                limit: 10,
                              },
                            },
                          ],
                        }),
                      },
                    },
                  ],
                },
                "tool_calls",
              )
            : event({ content: "这个模块是演示模块，没有真实数据。" }, "stop"),
        );
        return true;
      }
      if (outcome === "visible-context-twice") {
        const hasVisibleContext = body.messages.some(
          (message) =>
            message.role === "tool" &&
            typeof message.content === "string" &&
            message.content.includes("GEA_RENDERED_WORKBENCH"),
        );
        res.end(
          hasVisibleContext
            ? event({ content: "已按当前可见客户范围回答。" }, "stop")
            : event(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "visible-context-1",
                      type: "function",
                      function: {
                        name: "gea_visible_workbench_context",
                        arguments: "{}",
                      },
                    },
                    {
                      index: 1,
                      id: "visible-context-2",
                      type: "function",
                      function: {
                        name: "gea_visible_workbench_context",
                        arguments: "{}",
                      },
                    },
                  ],
                },
                "tool_calls",
              ),
        );
        return true;
      }
      if (outcome === "page-tool") {
        const results = body.messages.filter((x) => x.role === "tool");
        res.end(
          results.length === 0
            ? event(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "page-1",
                      type: "function",
                      function: {
                        name: "gea_visible_workbench_context",
                        arguments: "{}",
                      },
                    },
                  ],
                },
                "tool_calls",
              )
            : event({ content: "这个对话当前不在业务工作台，读不到页面数据。" }, "stop"),
        );
        return true;
      }
      // 每一轮都要先读一次"这一屏"，读到结果才收尾：用来验证"同一份快照，
      // 换菜单后还算不算本轮证据"。按"最后一条用户消息之后有没有工具结果"判断本轮。
      if (outcome === "page-evidence-guard") {
        if (!body.tools.some((tool) => tool.function.name === "gea_visible_workbench_context")) {
          res.end(event({ content: "当前主对话没有页面工具，未使用旧页面证据回答。" }, "stop"));
          return true;
        }
        const roles = body.messages.map((message) => message.role);
        const answered = body.messages
          .slice(roles.lastIndexOf("user") + 1)
          .some((message) => message.role === "tool");
        res.end(
          answered
            ? event({ content: "本轮先确认有没有页面证据，再决定用什么通道。" }, "stop")
            : event(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "guard-" + randomUUID().slice(0, 8),
                      type: "function",
                      function: {
                        name: "gea_visible_workbench_context",
                        arguments: "{}",
                      },
                    },
                  ],
                },
                "tool_calls",
              ),
        );
        return true;
      }
      if (outcome === "visible-context-unavailable") {
        const result = body.messages.find((message) => message.role === "tool");
        res.end(
          result
            ? event({ content: "当前页面上下文暂不可用，未据此编造业务结论。" }, "stop")
            : event(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "visible-context-unavailable-1",
                      type: "function",
                      function: {
                        name: "gea_visible_workbench_context",
                        arguments: "{}",
                      },
                    },
                  ],
                },
                "tool_calls",
              ),
        );
        return true;
      }
      if (outcome === "workbench-command") {
        const appliedResult = body.messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "workbench-command-1",
        );
        const rejectedResult = body.messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "workbench-command-2",
        );
        res.end(
          !appliedResult
            ? event(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "workbench-command-1",
                      type: "function",
                      function: {
                        name: "gea_workbench_apply",
                        arguments: JSON.stringify({
                          kind: "invoke",
                          target: "row:plan-hebei-1",
                          action: "expand",
                          reason: "展开这一行",
                        }),
                      },
                    },
                  ],
                },
                "tool_calls",
              )
            : !rejectedResult
              ? event(
                  {
                    tool_calls: [
                      {
                        index: 0,
                        id: "workbench-command-2",
                        type: "function",
                        function: {
                          name: "gea_workbench_apply",
                          arguments: JSON.stringify({
                            kind: "setValue",
                            target: "row:plan-hebei-1",
                            value: "200",
                          }),
                        },
                      },
                    ],
                  },
                  "tool_calls",
                )
              : event({ content: "已按当前页面范围回答。" }, "stop"),
        );
        return true;
      }
      if (outcome === "page-verb") {
        const rejected = body.messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "page-verb-1",
        );
        const delivered = body.messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "page-verb-2",
        );
        res.end(
          !rejected
            ? event(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "page-verb-1",
                      type: "function",
                      function: {
                        name: "gea_workbench_apply",
                        arguments: JSON.stringify({
                          kind: "setValue",
                          target: "row:p-1",
                          value: "200",
                        }),
                      },
                    },
                  ],
                },
                "tool_calls",
              )
            : !delivered
              ? event(
                  {
                    tool_calls: [
                      {
                        index: 0,
                        id: "page-verb-2",
                        type: "function",
                        function: {
                          name: "gea_workbench_apply",
                          arguments: JSON.stringify({
                            kind: "setValue",
                            target: "field:p-1:sku:1001:qty",
                            value: "200",
                          }),
                        },
                      },
                    ],
                  },
                  "tool_calls",
                )
              : event({ content: "已按元素操作。" }, "stop"),
        );
        return true;
      }
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
                            : { pageSize: outcome === "oversize" ? 200 : 1 },
                    }),
                  },
                },
              ],
            },
            "tool_calls",
          ),
        );
      } else res.end(event({ content: "已根据工具返回的覆盖范围完成只读分析。" }, "stop"));
      return true;
    });
    await app.login();
    const page = (await app.rpc("plans")).value;
    // Page operations use Workbench's actual owner token and the submit result's Core Session.
    const owners = new Map();
    async function pageOperation(sessionId, operation, parameters) {
      const response = await fetch(app.origin + "/api/agent-workbench/page", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: app.cookie, Origin: app.origin },
        body: JSON.stringify(
          operation === "open"
            ? { operation, pageId: "gea-proof", sessionId, resourceId: "gea-readonly" }
            : { operation, owner: owners.get(sessionId), parameters },
        ),
      });
      const value = await response.json();
      return { ok: response.ok, value };
    }
    async function openNativePage(sessionId) {
      const result = await pageOperation(sessionId, "open");
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(typeof result.value.owner, "string");
      owners.set(sessionId, result.value.owner);
      return result;
    }
    async function closeNativePage(sessionId) {
      const result = await pageOperation(sessionId, "close");
      owners.delete(sessionId);
      return result;
    }

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
    async function createPageSession() {
      const id = await createBusinessSession(app);
      await openNativePage(id);
      return id;
    }
    async function promptSession(id, question = "请看这一屏") {
      const prompted = await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId: id,
        mode: "queue",
        content: [{ type: "text", text: question }],
      });
      assert.equal(prompted.ok, true, JSON.stringify(prompted));
      return id;
    }
    async function startPageTurn(context) {
      const id = await createPageSession();
      if (context) {
        const synced = await pageOperation(id, "context", context);
        assert.equal(synced.ok, true, JSON.stringify(synced));
      }
      return promptSession(id);
    }
    async function pageEvents(id) {
      const response = await pageOperation(id, "catalog", { pageSource: "self-report" });
      assert.equal(response.ok, true, JSON.stringify(response));
      const receipts = readToolResults(await readSession(app.runtime, id));
      assert.ok(!receipts.some((receipt) => receipt.isError), JSON.stringify(receipts));
      return response.value.events;
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
        assert.equal(rows.find((x) => x.type === "turn/end").data.reason.kind, "completed");
        assert.equal(modelRequests.length, 2);
        const promptMessages = JSON.stringify(modelRequests[0].messages);
        const businessSystemMessages = JSON.stringify(
          modelRequests[0].messages.filter((message) => message.role === "system"),
        );
        assert.doesNotMatch(
          businessSystemMessages,
          /inventory-probe/,
          "local Skill summaries do not enter the business system prompt",
        );
        assert.doesNotMatch(businessSystemMessages, /DEVELOPER_SKILL_MUST_NOT_LEAK/);
        const localSkillCatalog = JSON.stringify(
          modelRequests[0].messages.filter((message) => message.role === "user"),
        );
        assert.match(localSkillCatalog, /<available_skills>/);
        assert.match(localSkillCatalog, /inventory-probe/);
        assert.match(localSkillCatalog, /DEVELOPER_SKILL_MUST_NOT_LEAK/);
        assert.doesNotMatch(promptMessages, /PROBE-RULE-42/);
        // 只要求核心工具在列；部署补丁还会挂其他工具（例如浏览器 MCP），不在这里锁死全集。
        const toolNames = modelRequests[0].tools.map((x) => x.function.name);
        for (const expected of [
          "gea_sales_plan_read",
          "skill",
          "gea_visible_workbench_context",
          "gea_capabilities",
        ])
          assert.ok(toolNames.includes(expected), `${expected} 在工具列表里`);
        for (const name of ["gea_page", "gea_workbench_apply", "gea_plugin_page_apply"])
          assert.equal(toolNames.includes(name), false, `${name} requires a bound page`);
        assert.match(
          modelRequests[0].messages
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n"),
          /不用其它会话或记忆充当公司事实/,
        );
        const result = modelRequests[1].messages.find((x) => x.role === "tool");
        assert.equal(result.tool_call_id, "read-1");
        const value = JSON.parse(result.content);
        assert.equal(value.coverage, "partial");
        assert.equal(value.value.total, 2);
        const snapshot = JSON.parse(
          await readFile(
            new URL("./fixtures/gea-agent-tools.snapshot.json", import.meta.url),
            "utf8",
          ),
        );
        const call = rows.find((x) => x.type === "tool/call");
        assert.deepEqual(
          {
            events: rows.filter((x) => snapshot.events.includes(x.type)).map((x) => x.type),
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
        assert.equal(JSON.stringify(rows).includes("fixture-only-model-secret"), false);
        assert.equal(JSON.stringify(rows).includes("fixture-gea-token"), false);
        const read = app.requests.find(
          (x) => x.url.pathname.endsWith("/plans") && x.url.searchParams.get("pageSize") === "200",
        );
        assert.equal(read.method, "GET");
        assert.equal(read.headers["x-tenant-id"], "0");
      },
    );
    await t.test(
      "a Native conversation receives its rendered context before the first model tool call",
      async () => {
        outcome = "visible-context";
        modelRequests = [];
        const rows = await ended(
          await startPageTurn({
            format: "gea-workbench-visible-v1",
            sequence: 1,
            view: "regional-approval",
            scope: {
              month: "2026-10",
              planType: "Y",
              approvalStage: "province",
              dimension: "customer",
            },
            visibleRows: [
              {
                planId: "9007199254740993",
                organization: "当前客户",
                planTypeCode: "Y",
                status: 3,
              },
            ],
            selectedPlanIds: [],
            expandedFields: [
              {
                id: "field:plan-hebei-1:1004273:qty",
                label: "BP思念150g黑芝麻肉松饭团 确认计划量",
                value: "200",
                editable: true,
              },
            ],
            pagination: { page: 1, pageSize: 20, total: 1 },
            evidence: {
              source: "gea-user-session",
              completeness: "paged-queue",
              queryState: "success",
              dataVersion: "sales-plan-v1.11",
            },
          }),
        );
        const result = modelRequests[1].messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "visible-context-1",
        );
        assert.match(result.content, /current-visible-page/);
        assert.match(result.content, /当前客户/);
        // 通道顺序由宿主算好一起给出，模型不必自己挑通道。
        assert.match(result.content, /"channels"/);
        // 问答侧关掉受管 SQL 之后，取数通道指向模块 MCP。
        assert.match(JSON.parse(result.content).channels.note, /query_business_data/);
        assert.match(JSON.parse(result.content).channels.note, /inspect_cube_model/);
        assert.equal(result.content.includes("gea_plugin_read"), false);
        assert.equal(
          rows.some(
            (entry) => entry.type === "tool/result" && entry.data.message.content[0].isError,
          ),
          false,
        );
      },
    );
    await t.test(
      "current MCP permission denial stays visible in the persisted tool result",
      async () => {
        outcome = "module-mcp-denied";
        modelRequests = [];
        const rows = await ended(await submit());
        const result = modelRequests[1].messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "module-mcp-denied-1",
        );
        assert.match(result.content, /AI_GATEWAY_DATA_PERMISSION_DENIED/);
        assert.match(result.content, /当前用户无权访问该Agent/);
        const receipt = readToolResults(rows).find((item) => item.callId === "module-mcp-denied-1");
        assert.equal(receipt.isError, true);
        assert.doesNotMatch(receipt.text, /"datasets"|"rows"/);
      },
    );
    await t.test(
      "current MCP rejects model-selected Consumers before external dispatch",
      async () => {
        outcome = "module-mcp-mock";
        modelRequests = [];
        const before = mcpState.cube.length;
        const rows = await ended(await submit());
        const result = modelRequests[1].messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "module-mcp-1",
        );
        assert.match(result.content, /GEA_MCP_PLATFORM_ARGUMENT_REJECTED|invalid arguments/);
        assert.equal(
          readToolResults(rows).find((item) => item.callId === "module-mcp-1").isError,
          true,
        );
        assert.equal(
          mcpState.cube.length,
          before,
          "rejected Consumer input cannot query any module",
        );
      },
    );
    await t.test("同一轮第二次读这一屏被挡回，避免工具调用堆成一组把正文挤进折叠区", async () => {
      outcome = "visible-context-twice";
      modelRequests = [];
      await ended(
        await startPageTurn({
          format: "gea-workbench-visible-v1",
          sequence: 1,
          view: "regional-approval",
          scope: {
            month: "2026-10",
            planType: "Y",
            approvalStage: "province",
            dimension: "customer",
          },
          visibleRows: [
            {
              planId: "9007199254740993",
              organization: "当前客户",
              planTypeCode: "Y",
              status: 3,
            },
          ],
          selectedPlanIds: [],
          expandedFields: [
            {
              id: "field:plan-hebei-1:1004273:qty",
              label: "BP思念150g黑芝麻肉松饭团 确认计划量",
              value: "200",
              editable: true,
            },
          ],
          pagination: { page: 1, pageSize: 20, total: 1 },
          evidence: {
            source: "gea-user-session",
            completeness: "paged-queue",
            queryState: "success",
            dataVersion: "sales-plan-v1.11",
          },
        }),
      );
      const first = modelRequests[1].messages.find(
        (message) => message.role === "tool" && message.tool_call_id === "visible-context-1",
      );
      const second = modelRequests[1].messages.find(
        (message) => message.role === "tool" && message.tool_call_id === "visible-context-2",
      );
      assert.match(first.content, /current-visible-page/);
      assert.match(second.content, /PAGE_CONTEXT_ALREADY_READ/);
      assert.match(second.content, /本轮已经读过/);
    });
    await t.test(
      "an unsynchronised page context is a safe tool result rather than a visible tool error",
      async () => {
        outcome = "visible-context-unavailable";
        modelRequests = [];
        const rows = await ended(await startPageTurn());
        const result = modelRequests[1].messages.find(
          (message) =>
            message.role === "tool" && message.tool_call_id === "visible-context-unavailable-1",
        );
        // 在业务菜单里但这一屏还没上报快照：如实说"没有快照"，而不是假装不在工作台。
        assert.match(result.content, /PAGE_HAS_NO_SNAPSHOT/);
        assert.match(result.content, /in-workbench-no-snapshot/);
        assert.match(result.content, /销售计划/);
        // 没有页面时也要给出兜底通道（受管只读），而不是让模型空转。
        assert.match(result.content, /"channels"/);
        assert.equal(
          rows.some(
            (entry) => entry.type === "tool/result" && entry.data.message.content[0].isError,
          ),
          false,
        );
      },
    );
    await t.test("回到主对话后，同一份页面快照不再当本轮证据（菜单状态字段说了算）", async () => {
      outcome = "page-evidence-guard";
      modelRequests = [];
      const id = await startPageTurn({
        format: "gea-workbench-visible-v1",
        sequence: 1,
        view: "regional-approval",
        scope: {
          month: "2026-10",
          planType: "Y",
          approvalStage: "province",
          dimension: "customer",
        },
        visibleRows: [{ planId: "plan-hebei-1", organization: "河北", planTypeCode: "Y" }],
        selectedPlanIds: [],
        pagination: { page: 1, pageSize: 20, total: 1 },
        evidence: {
          source: "gea-user-session",
          completeness: "paged-queue",
          queryState: "success",
          dataVersion: "sales-plan-v1.11",
        },
      });
      await ended(id);
      // 用户从业务菜单切回主对话：快照还在服务端，但不再是"你眼前这一屏"。
      const surface = await closeNativePage(id);
      assert.equal(surface.ok, true, JSON.stringify(surface));
      modelRequests = [];
      const prompted = await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId: id,
        mode: "queue",
        content: [{ type: "text", text: "河北这些行是什么计划类型？" }],
      });
      assert.equal(prompted.ok, true, JSON.stringify(prompted));
      const rows = await until(
        () => readSession(app.runtime, id),
        (entries) => entries.filter((entry) => entry.type === "turn/end").length === 2,
      );
      // 模型每次请求都带全量历史，只能看"最后一条用户消息之后"的那条工具结果。
      assert.equal(
        modelRequests.length,
        2,
        JSON.stringify(
          modelRequests.map((body) =>
            body.messages
              .filter((message) => message.role === "tool" || message.tool_calls)
              .map((message) => ({
                role: message.role,
                id: message.tool_call_id,
                calls: message.tool_calls,
                content:
                  typeof message.content === "string"
                    ? message.content.slice(-900)
                    : message.content,
              })),
          ),
        ),
      );
      const messages = modelRequests[1].messages;
      const lastUser = messages.map((message) => message.role).lastIndexOf("user");
      const result = messages
        .slice(lastUser + 1)
        .find(
          (message) => message.role === "tool" && String(message.tool_call_id).startsWith("guard-"),
        );
      assert.match(result.content, /PAGE_NOT_IN_WORKBENCH/);
      assert.match(result.content, /not-in-workbench/);
      assert.match(result.content, /主对话/);
      // 旧快照的行内容一个字都不能带出去。
      assert.equal(result.content.includes("河北"), false);
      assert.equal(
        rows.some((entry) => entry.type === "tool/result" && entry.data.message.content[0].isError),
        false,
      );
    });
    await t.test("MCP 目录可见不授予执行权限，受管 SQL 工具默认不注册", async () => {
      outcome = "success";
      modelRequests = [];
      await ended(await submit());
      // 默认（部署配置没打开 agentSqlRead）不给模型写 SQL 的机会。
      assert.equal(
        modelRequests[0].tools.some((candidate) => candidate.function.name === "gea_plugin_read"),
        false,
        "默认不应注册 gea_plugin_read",
      );
      assert.equal(
        modelRequests[0].tools.some(
          (tool) => tool.function.name === "mcp__gea-gateway__query_business_data",
        ),
        true,
      );
      assert.ok(modelRequests[0].tools.some((tool) => tool.function.name === "gea_capabilities"));
      assert.ok(
        modelRequests[0].tools.some(
          (tool) => tool.function.name === "mcp__gea-gateway__inspect_cube_model",
        ),
      );
    });
    await t.test(
      "a page tool in a plain conversation explains the rule instead of failing",
      async () => {
        outcome = "page-tool";
        modelRequests = [];
        const rows = await ended(await promptSession(await createBusinessSession(app)));
        assert.ok(
          modelRequests[0].tools.some((x) => x.function.name === "gea_visible_workbench_context"),
          "未绑定会话仍提供安全的只读上下文说明",
        );
        assert.ok(
          !modelRequests[0].tools.some((x) =>
            ["gea_page", "gea_workbench_apply"].includes(x.function.name),
          ),
          "未绑定会话不能获得页面动作",
        );
        const result = modelRequests[1].messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "page-1",
        );
        assert.match(result.content, /not-in-workbench/);
        const value = JSON.parse(result.content);
        assert.equal(value.code, "PAGE_NOT_IN_WORKBENCH");
        assert.equal(value.coverage, "none");
        assert.equal(value.context, undefined);
        assert.equal(value.rows, undefined);
        assert.equal(
          rows.some(
            (entry) => entry.type === "tool/result" && entry.data.message.content[0].isError,
          ),
          false,
          "普通对话里的页面工具结果不是错误",
        );
      },
    );
    await t.test(
      "the current conversation reads only its synchronised visible workbench page",
      async () => {
        outcome = "success";
        const id = await createPageSession();
        // 菜单状态字段：只有点了业务菜单才算"在工作台"（默认是主对话）。
        const synced = await pageOperation(id, "context", {
          format: "gea-workbench-visible-v1",
          sequence: 1,
          view: "regional-approval",
          scope: {
            month: "2026-10",
            planType: "Y",
            approvalStage: "province",
            dimension: "customer",
          },
          visibleRows: [
            {
              planId: "9007199254740993",
              organization: "当前客户",
              planTypeCode: "Y",
              status: 3,
            },
          ],
          selectedPlanIds: [],
          expandedFields: [
            {
              id: "field:plan-hebei-1:1004273:qty",
              label: "BP思念150g黑芝麻肉松饭团 确认计划量",
              value: "200",
              editable: true,
            },
          ],
          pagination: { page: 1, pageSize: 20, total: 1 },
          evidence: {
            source: "gea-user-session",
            completeness: "paged-queue",
            queryState: "success",
            dataVersion: "sales-plan-v1.11",
          },
        });
        assert.deepEqual(synced, { ok: true, value: { synced: true } });
        outcome = "visible-context";
        modelRequests = [];
        const prompted = await app.remote("session/prompt", {
          requestId: randomUUID(),
          sessionId: id,
          mode: "queue",
          content: [{ type: "text", text: "这几个客户是什么计划类型？" }],
        });
        assert.equal(prompted.ok, true, JSON.stringify(prompted));
        const rows = await until(
          () => readSession(app.runtime, id),
          (entries) => entries.filter((entry) => entry.type === "turn/end").length === 1,
        );
        assert.equal(modelRequests.length, 2);
        assert.equal(
          modelRequests[0].tools.some(
            (tool) => tool.function.name === "gea_visible_workbench_context",
          ),
          true,
        );
        const result = modelRequests[1].messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "visible-context-1",
        );
        const value = JSON.parse(result.content);
        assert.equal(value.source, "GEA_RENDERED_WORKBENCH");
        assert.equal(value.coverage, "current-visible-page");
        assert.equal(value.context.visibleRows[0].organization, "当前客户");
        assert.equal(value.context.expandedFields[0].id, "field:plan-hebei-1:1004273:qty");
        assert.equal(value.context.expandedFields[0].value, "200");
        assert.equal(
          rows.some(
            (entry) =>
              entry.type === "tool/call" && entry.data.name === "gea_visible_workbench_context",
          ),
          true,
        );
      },
    );
    await t.test(
      "the assistant drives the visible page through an AG-UI frontend tool",
      async () => {
        const page = (sequence, rows) => ({
          format: "gea-workbench-visible-v1",
          sequence,
          view: "regional-approval",
          scope: {
            month: "2026-10",
            planType: "Y",
            approvalStage: "province",
            dimension: "customer",
          },
          visibleRows: rows,
          selectedPlanIds: [],
          pagination: { page: 1, pageSize: 20, total: rows.length },
          evidence: {
            source: "gea-user-session",
            completeness: "paged-queue",
            queryState: "success",
            dataVersion: "sales-plan-v1.11",
          },
        });
        outcome = "success";
        const id = await createPageSession();
        // 菜单状态字段：这一屏的上下文只在"点了业务菜单"的对话里才算证据。
        // 页面自述能力：工具由通用桥按这份目录为该会话生成。
        const catalog = {
          surface: "gea-workbench",
          tool: "gea_workbench_apply",
          reasonField: "reason",
          description: "改工作台这一屏。",
          elements: [
            {
              id: "row:plan-hebei-1",
              role: "row",
              label: "河北 经销渠道虚拟二",
              value: "¥3,888,792.00",
              actions: ["expand", "collapse", "openDetail", "select"],
            },
            {
              id: "field:plan-hebei-1:1004273:qty",
              role: "field",
              label: "BP思念150g黑芝麻肉松饭团 确认计划量",
              value: "939",
              editable: true,
            },
            {
              id: "collection:plan-hebei-1:qty",
              role: "collection",
              label: "该行全部 SKU 的确认计划量",
              members: ["field:plan-hebei-1:1004273:qty"],
            },
            {
              id: "stage",
              role: "control",
              label: "审批阶段",
              value: "area",
              options: ["all", "area", "province"],
              editable: true,
            },
          ],
        };
        const declared = await pageOperation(id, "catalog", {
          pageSource: "self-report",
          toolMessages: [],
          catalog: catalog,
        });
        assert.equal(declared.ok, true, JSON.stringify(declared));
        await pageOperation(
          id,
          "context",
          page(1, [{ planId: "plan-hebei-1", organization: "河北", planTypeCode: "Y" }]),
        );
        outcome = "workbench-command";
        modelRequests = [];
        const prompted = await app.remote("session/prompt", {
          requestId: randomUUID(),
          sessionId: id,
          mode: "queue",
          content: [{ type: "text", text: "只看河北" }],
        });
        assert.equal(prompted.ok, true, JSON.stringify(prompted));
        // 工作台页面这一侧：按 AG-UI 取工具调用事件。
        await until(() => modelRequests.length > 0, Boolean);
        assert.ok(
          modelRequests[0].tools.some((tool) => tool.function.name === "gea_workbench_apply"),
          "页面声明后该会话应能看到生成的工具：" +
            JSON.stringify(modelRequests[0].tools.map((tool) => tool.function.name)),
        );
        assert.ok(
          !modelRequests[0].tools.some((tool) => tool.function.name === "gea_page"),
          "Native grant 不建立 HTML lease",
        );
        // 工具由桥按元素目录生成：模型只会 4 个通用动词；说明里只给数量，
        // 目录按需取（directory=true），不再随每次请求把标签全塞进上下文。
        const applyTool = modelRequests[0].tools.find(
          (tool) => tool.function.name === "gea_workbench_apply",
        );
        assert.deepEqual(applyTool.function.parameters.properties.kind.enum, [
          "invoke",
          "setValue",
          "select",
          "clear",
          "directory",
        ]);
        assert.match(applyTool.function.description, /可操作元素 4 个/);
        assert.match(applyTool.function.description, /只读元素/);
        assert.equal(
          applyTool.function.description.includes("河北 经销渠道虚拟二"),
          false,
          "元素标签不再写进工具说明，改用 directory=true 按需取",
        );
        assert.match(applyTool.function.description, /directory=true/);
        assert.equal(applyTool.function.parameters.properties.target.type, "string");
        assert.equal(applyTool.function.parameters.properties.action.type, "string");
        assert.equal(applyTool.function.parameters.properties.value.type, "string");
        assert.equal(
          (applyTool.function.parameters.required ?? []).includes("kind"),
          false,
          "kind 不再必填：只要元素目录时可以只传 directory=true",
        );
        const events = await until(
          () => pageEvents(id),
          (value) => value.length > 0,
        );
        assert.deepEqual(
          events.map((event) => event.type),
          ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"],
        );
        const [start, args, end] = events;
        assert.equal(start.toolCallName, "gea_workbench_apply");
        assert.equal(end.toolCallId, start.toolCallId);
        assert.deepEqual(JSON.parse(args.delta), {
          kind: "invoke",
          target: "row:plan-hebei-1",
          action: "expand",
          reason: "展开这一行",
        });
        // 页面执行完把结果按 AG-UI 的 tool 消息回填，并上报新的页面快照。
        const settled = await pageOperation(id, "catalog", {
          pageSource: "self-report",
          toolMessages: [
            {
              id: "tool-result-1",
              role: "tool",
              toolCallId: start.toolCallId,
              content: JSON.stringify({ toolCallId: start.toolCallId, applied: true }),
            },
          ],
        });
        assert.deepEqual(settled.value.events, []);
        await pageOperation(
          id,
          "context",
          page(2, [
            { planId: "plan-hebei-1", organization: "河北", planTypeCode: "Y" },
            { planId: "plan-hebei-2", organization: "河北", planTypeCode: "Y" },
          ]),
        );
        const rows = await until(
          () => readSession(app.runtime, id),
          (entries) => entries.filter((entry) => entry.type === "turn/end").length === 1,
        );
        const toolResult = modelRequests[1].messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "workbench-command-1",
        );
        const value = JSON.parse(toolResult.content);
        assert.equal(value.protocol, "ag-ui-frontend-tool");
        assert.equal(value.applied, true, JSON.stringify(value));
        assert.equal(value.kind, "invoke");
        // 改动后必须拿到"改动后"的快照，否则模型会拿旧页面下结论。
        assert.equal(value.snapshotAfterApply, true);
        assert.equal(value.authority, "view-only");
        assert.equal(value.tool.toolCallName, "gea_workbench_apply");
        assert.equal(value.state.visibleRows.length, 2);
        // 只改视图：整轮下来不能碰任何 GEA 写接口。
        assert.equal(
          app.requests.some((request) =>
            /\/actions$|\/submit$|\/sales-plan\/action$/.test(request.url.pathname),
          ),
          false,
          "改这一屏不应该触发任何 GEA 写接口",
        );
        assert.equal(
          rows.some(
            (entry) => entry.type === "tool/call" && entry.data.name === "gea_workbench_apply",
          ),
          true,
        );
        // 只读元素上的 setValue 必须被挡在宿主侧，不能变成"改好了"。
        // （命令没有下发到页面，所以这里是一个带错误码的成功结果，而不是工具异常。）
        assert.match(
          modelRequests[2].messages.find(
            (message) => message.role === "tool" && message.tool_call_id === "workbench-command-2",
          ).content,
          /ELEMENT_NOT_EDITABLE/,
        );
        assert.equal(rows.filter((entry) => entry.type === "turn/end").length, 1);
      },
    );
    await t.test("页面声明受策略收口：非白名单页面不注册，改数据的动作不暴露", async () => {
      outcome = "success";
      // 1) 不在白名单里的页面：声明了也不给工具。
      const foreign = await createPageSession();
      const foreignDeclaration = await pageOperation(foreign, "catalog", {
        pageSource: "self-report",
        toolMessages: [],
        catalog: {
          surface: "inventory-dealer",
          tool: "dealer_page_apply",
          description: "改经销商页面",
          actions: [{ name: "openRow", description: "打开某一行" }],
        },
      });
      assert.equal(foreignDeclaration.ok, false);
      assert.equal(foreignDeclaration.value.error, "PAGE_CATALOG_OWNER_MISMATCH");
      modelRequests = [];
      await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId: foreign,
        mode: "queue",
        content: [{ type: "text", text: "随便问一句" }],
      });
      await until(() => modelRequests.length > 0, Boolean);
      assert.equal(
        modelRequests[0].tools.some((tool) => tool.function.name === "dealer_page_apply"),
        false,
        "非白名单页面不应注册工具",
      );

      await ended(foreign);
      // 2) 白名单页面：改视图的动作和"填草稿"的动作都要暴露（它们都是页面开放的）。
      const allowed = await createPageSession();
      await pageOperation(allowed, "catalog", {
        pageSource: "self-report",
        toolMessages: [],
        catalog: {
          surface: "gea-workbench",
          tool: "gea_workbench_apply",
          description: "改工作台这一屏",
          actions: [
            { name: "expandRow", description: "展开某一行" },
            {
              name: "setConfirmedQuantity",
              description: "填确认计划量草稿",
              scope: "data",
              params: {
                planId: { type: "string", required: true },
                quantity: { type: "string", required: true },
              },
            },
          ],
        },
      });
      modelRequests = [];
      await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId: allowed,
        mode: "queue",
        content: [{ type: "text", text: "随便问一句" }],
      });
      await until(() => modelRequests.length > 0, Boolean);
      const tool = modelRequests[0].tools.find(
        (candidate) => candidate.function.name === "gea_workbench_apply",
      );
      assert.ok(tool, "白名单页面应注册工具");
      assert.deepEqual(tool.function.parameters.properties.kind.enum, [
        "expandRow",
        "setConfirmedQuantity",
      ]);
      // 动作里不存在"提交/审批"这类会落库的动作：页面没声明就永远调不到。
      assert.equal(
        tool.function.parameters.properties.kind.enum.some((kind) =>
          /submit|approve|save/i.test(kind),
        ),
        false,
      );
      await ended(allowed);
    });
    await t.test("切页即撤：页面声明为 null 后，上一屏的元素当场从会话里消失", async () => {
      outcome = "success";
      const id = await createPageSession();
      const declared = await pageOperation(id, "catalog", {
        pageSource: "self-report",
        toolMessages: [],
        catalog: {
          surface: "gea-workbench",
          tool: "gea_workbench_apply",
          description: "改工作台这一屏。",
          elements: [
            {
              id: "row:p-1",
              role: "row",
              label: "上一屏的行",
              actions: ["expand"],
            },
          ],
        },
      });
      assert.equal(declared.ok, true, JSON.stringify(declared).slice(0, 300));
      modelRequests = [];
      await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId: id,
        mode: "queue",
        content: [{ type: "text", text: "这一屏有什么" }],
      });
      await until(() => modelRequests.length > 0, Boolean);
      assert.equal(
        modelRequests[0].tools.some((tool) => tool.function.name === "gea_workbench_apply"),
        true,
        "页面声明后模型能看到页面工具",
      );
      await until(
        () => readSession(app.runtime, id),
        (entries) => entries.filter((entry) => entry.type === "turn/end").length === 1,
      );

      // 页面切走了：桥关闭 / 这一屏不再是工作台时报 null。
      const released = await pageOperation(id, "catalog", {
        pageSource: "self-report",
        toolMessages: [],
        catalog: null,
      });
      assert.equal(released.ok, true);
      modelRequests = [];
      await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId: id,
        mode: "queue",
        content: [{ type: "text", text: "现在这一屏有什么" }],
      });
      await until(() => modelRequests.length > 0, Boolean);
      assert.equal(
        modelRequests[0].tools.some((tool) => tool.function.name === "gea_workbench_apply"),
        false,
        "页面撤走后不能再把上一屏的元素留给模型",
      );
      await until(
        () => readSession(app.runtime, id),
        (entries) => entries.filter((entry) => entry.type === "turn/end").length === 2,
      );
    });
    await t.test("元素目录：只读元素改不动，只有可编辑字段才下发到页面", async () => {
      outcome = "success";
      const id = await createPageSession();
      await pageOperation(id, "catalog", {
        pageSource: "self-report",
        toolMessages: [],
        catalog: {
          surface: "gea-workbench",
          tool: "gea_workbench_apply",
          description: "通用页面操作：按元素调用四个通用动词。",
          elements: [
            {
              id: "row:p-1",
              role: "row",
              label: "经销渠道虚拟二",
              value: "¥3,888,792.00",
              actions: ["expand", "openDetail", "select"],
            },
            {
              id: "field:p-1:sku:1001:qty",
              role: "field",
              label: "BP思念150g黑芝麻肉松饭团 确认计划量",
              value: "939",
              editable: true,
            },
            {
              id: "collection:p-1:qty",
              role: "collection",
              label: "该行全部 SKU 的确认计划量",
              members: ["field:p-1:sku:1001:qty"],
            },
            {
              id: "stage",
              role: "control",
              label: "审批阶段",
              value: "area",
              options: ["all", "area", "province"],
              actions: ["setStage"],
            },
          ],
        },
      });
      outcome = "page-verb";
      modelRequests = [];
      await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId: id,
        mode: "queue",
        content: [{ type: "text", text: "把这行改成 200" }],
      });
      await until(() => modelRequests.length > 0, Boolean);
      assert.ok(
        modelRequests[0].tools.some(
          (candidate) => candidate.function.name === "gea_workbench_apply",
        ),
        "元素目录也要注册工具：" +
          JSON.stringify(modelRequests[0].tools.map((candidate) => candidate.function.name)),
      );
      const events = await until(
        () => pageEvents(id),
        (value) => value.length > 0,
      );
      const tool = modelRequests[0].tools.find(
        (candidate) => candidate.function.name === "gea_workbench_apply",
      );
      // 元素目录：模型只会四个通用动词。
      assert.deepEqual(tool.function.parameters.properties.kind.enum, [
        "invoke",
        "setValue",
        "select",
        "clear",
        "directory",
      ]);
      // 说明里区分了"可操作"和"只读"，并给出数量；元素 label 用 directory=true 按需取。
      assert.match(tool.function.description, /只读元素/);
      assert.match(tool.function.description, /可编辑/);
      assert.equal(
        tool.function.description.includes("经销渠道虚拟二"),
        false,
        "元素标签不再写进工具说明，改用 directory=true 按需取",
      );
      // 只读行上的 setValue 不会下发；事件来自第二个（可编辑字段）调用。
      const [start, args] = events;
      assert.deepEqual(JSON.parse(args.delta), {
        kind: "setValue",
        target: "field:p-1:sku:1001:qty",
        value: "200",
      });
      await pageOperation(id, "catalog", {
        pageSource: "self-report",
        toolMessages: [
          {
            id: "verb-result-1",
            role: "tool",
            toolCallId: start.toolCallId,
            content: JSON.stringify({ toolCallId: start.toolCallId, applied: true }),
          },
        ],
      });
      await until(
        () => readSession(app.runtime, id),
        (entries) => entries.filter((entry) => entry.type === "turn/end").length === 1,
      );
      const rejected = modelRequests[1].messages.find(
        (message) => message.role === "tool" && message.tool_call_id === "page-verb-1",
      );
      assert.match(rejected.content, /ELEMENT_NOT_EDITABLE/);
      const delivered = modelRequests[2].messages.find(
        (message) => message.role === "tool" && message.tool_call_id === "page-verb-2",
      );
      const value = JSON.parse(delivered.content);
      assert.equal(value.applied, true, JSON.stringify(value));
      assert.equal(value.kind, "setValue");
      // 这一屏的目录是页面自述的；这次改动在"改草稿"这一层留下了回执。
      assert.equal(value.pageSource, "self-report", JSON.stringify(value));
      assert.equal(value.draft.outcome, "applied");
      assert.match(value.draft.id, /^draft-/);
    });
    await t.test("元素很多（20 行 + 字段）时工具仍要注册，说明不能因为超长把工具弄没", async () => {
      outcome = "success";
      const id = await createPageSession();
      const elements = [
        ...Array.from({ length: 20 }, (_, index) => ({
          id: `row:p-jxs-2026-10-${String(index).padStart(5, "0")}`,
          role: "row",
          label: `经销渠道虚拟${index % 3}（河北逐平）`,
          value: "3,888,792.00",
          actions: ["expand", "collapse", "openDetail", "select"],
        })),
        ...Array.from({ length: 12 }, (_, index) => ({
          id: `field:p-jxs-2026-10-00000:1004273${index}:qty`,
          role: "field",
          label: `BP思念150g黑芝麻肉松饭团 ${index} 确认计划量`,
          value: "939",
          editable: true,
        })),
        {
          id: "collection:p-jxs-2026-10-00000:qty",
          role: "collection",
          label: "该行全部 SKU 的确认计划量",
          members: Array.from(
            { length: 12 },
            (_, index) => `field:p-jxs-2026-10-00000:1004273${index}:qty`,
          ),
        },
        ...["areaCode", "provinceCode", "orgCode", "dealerCode", "status"].map((field) => ({
          id: `filter:${field}`,
          role: "control",
          label: `${field} 筛选`,
          value: "all",
          editable: true,
        })),
        {
          id: "stage",
          role: "control",
          label: "审批阶段",
          value: "area",
          options: ["all", "area", "province"],
          editable: true,
        },
        { id: "filters", role: "control", label: "筛选", actions: ["reset"] },
        { id: "pager", role: "control", label: "分页", value: "1", editable: true },
      ];
      const declared = await pageOperation(id, "catalog", {
        pageSource: "self-report",
        toolMessages: [],
        catalog: {
          surface: "gea-workbench",
          tool: "gea_workbench_apply",
          description: "改工作台这一屏。",
          elements,
        },
      });
      assert.equal(declared.ok, true, JSON.stringify(declared).slice(0, 300));
      modelRequests = [];
      await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId: id,
        mode: "queue",
        content: [{ type: "text", text: "随便问一句" }],
      });
      await until(() => modelRequests.length > 0, Boolean);
      const tool = modelRequests[0].tools.find(
        (candidate) => candidate.function.name === "gea_workbench_apply",
      );
      assert.ok(tool, "元素数量大时工具也必须注册");
      assert.ok(
        tool.function.description.length <= 20_200,
        `说明长度 ${tool.function.description.length} 应在上限内`,
      );
      await ended(id);
    });
    await t.test(
      "Skill references use the local reader in the actual model-tool-model loop",
      async () => {
        await mkdir(`${agentsHome}/skills/reference-scope`, {
          recursive: true,
        });
        await mkdir(`${agentsHome}/references`, {
          recursive: true,
        });
        await writeFile(
          `${agentsHome}/skills/reference-scope/SKILL.md`,
          "---\nname: reference-scope\ndescription: 需求预测规则测试\n---\n先读 [规则](../../references/rules.md)\n",
        );
        await writeFile(
          `${agentsHome}/references/rules.md`,
          "按实际期间查询；缺失数据不能编造。\n",
        );
        outcome = "skill-reference";
        modelRequests = [];
        const rows = await ended(await submit());
        assert.equal(
          modelRequests.length,
          3,
          JSON.stringify(
            modelRequests.map((body) =>
              body.messages
                .filter((message) => message.role === "tool" || message.tool_calls)
                .map((message) => ({
                  role: message.role,
                  id: message.tool_call_id,
                  calls: message.tool_calls,
                  content:
                    typeof message.content === "string"
                      ? message.content.slice(-900)
                      : message.content,
                })),
            ),
          ),
        );
        const initialSystem = modelRequests[0].messages
          .filter((x) => x.role === "system")
          .map((x) => x.content)
          .join("\n");
        assert.match(initialSystem, /沿用用户语言及指定格式/);
        const results = modelRequests[2].messages.filter((x) => x.role === "tool");
        assert.match(results[0].content, /reference-scope/);
        assert.match(results[1].content, /按实际期间查询；缺失数据不能编造/);
        assert.ok(!rows.some((x) => x.type === "tool/call" && x.data.name.includes("mcp")));
        assert.equal(rows.find((x) => x.type === "turn/end").data.reason.kind, "completed");
      },
    );
    await t.test("integer plan status reaches GEA through the advertised tool schema", async () => {
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
      assert.equal(rows.find((x) => x.type === "turn/end").data.reason.kind, "completed");
    });
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
          const before = app.requests.filter(
            (x) =>
              x.url.pathname.endsWith("/plans") && x.url.searchParams.get("pageSize") === "200",
          ).length;
          const rows = await ended(await submit());
          assert.match(
            modelRequests[1].messages.find((x) => x.role === "tool").content,
            new RegExp(code),
          );
          assert.ok(readToolResults(rows)[0].isError);
          if (mode === "invalid")
            assert.equal(
              app.requests.filter(
                (x) =>
                  x.url.pathname.endsWith("/plans") && x.url.searchParams.get("pageSize") === "200",
              ).length,
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
        assert.equal(rows.find((x) => x.type === "turn/end").data.reason.kind, "completed");
        await until(async () => closed, Boolean);
        toolReply = undefined;
        closed = false;
      },
    );
    await t.test("cancel closes a pending business read and persists an aborted turn", async () => {
      outcome = "hold";
      toolReply = undefined;
      closed = false;
      modelRequests = [];
      const id = await submit();
      await until(async () => Boolean(toolReply), Boolean);
      await app.remote("session/cancel", { sessionId: id });
      const rows = await ended(id);
      assert.equal(rows.find((x) => x.type === "turn/end").data.reason.kind, "aborted");
      await until(async () => closed, Boolean);
      assert.ok(rows.some((x) => x.type === "tool/call"));
      assert.ok(rows.some((x) => x.type === "tool/result"));
      assert.equal(modelRequests.length, 1);
    });
    await t.test(
      "a live workbench read never wipes the visible page context it just synced",
      async () => {
        outcome = "success";
        const id = await createPageSession();
        const synced = {
          format: "gea-workbench-visible-v1",
          sequence: 1,
          view: "regional-approval",
          scope: {
            month: "2026-10",
            planType: "Y",
            approvalStage: "province",
            dimension: "customer",
          },
          visibleRows: [
            {
              planId: "9007199254740993",
              organization: "河北",
              planTypeCode: "Y",
            },
          ],
          selectedPlanIds: [],
          pagination: { page: 1, pageSize: 20, total: 1 },
          evidence: {
            source: "gea-user-session",
            completeness: "paged-queue",
            queryState: "success",
            dataVersion: "sales-plan-v1.11",
          },
        };
        assert.deepEqual((await pageOperation(id, "context", synced)).value, { synced: true });
        // 工作台页面自己的实时查询走的就是这条：它曾经把刚同步的可见页快照清掉。
        const live = await app.rpc("workbench/query", {
          kind: "periods",
          query: { pageSize: 1 },
        });
        assert.equal(live.ok, true, JSON.stringify(live));
        outcome = "visible-context";
        modelRequests = [];
        const prompted = await app.remote("session/prompt", {
          requestId: randomUUID(),
          sessionId: id,
          mode: "queue",
          content: [{ type: "text", text: "这一页是什么范围？" }],
        });
        assert.equal(prompted.ok, true, JSON.stringify(prompted));
        await until(
          () => readSession(app.runtime, id),
          (entries) => entries.filter((entry) => entry.type === "turn/end").length === 1,
        );
        const result = modelRequests[1].messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "visible-context-1",
        );
        const value = JSON.parse(result.content);
        assert.equal(value.coverage, "current-visible-page");
        assert.equal(value.context.visibleRows[0].organization, "河北");
      },
    );
  },
);
