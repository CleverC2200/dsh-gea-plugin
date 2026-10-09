import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { changeThemeSetting } from "./theme-settings.mjs";
import { profile, readSession, readToolResults, until } from "./profile.mjs";
import { fixtureWorkbench } from "./fixtures/workbench-profile.mjs";
import { selectBusinessResource } from "./fixtures/business-session.mjs";
import {
  preparePageStartup,
  openWorkbenchPage,
  htmlFrameElement,
} from "./fixtures/business-page.mjs";

// Only external GEA and model endpoints are fixtures. Workbench, Agent Manage,
// GEA, page bridge, registry, session loop and browser all run their built source.
test(
  "两份临时分离声明在真实工作台显示，Agent 管理装载能力，调用保持受控",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 90000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "gea-split-web-"));
    const plugins = [],
      skillProjections = [];
    for (const [originalId, name, split] of [
      ["inventory-fc", "分仓库存", false],
      ["inventory-aqkc", "基地库存", true],
    ]) {
      const id = split ? "inventory-split-aqkc-probe" : "inventory-split-fc-probe";
      const directory = join(root, originalId);
      plugins.push(directory);
      await mkdir(directory);
      const originalSkill = `---\nname: ${originalId}\ndescription: 隔离验收能力\n---\n只读查询。\n`;
      const activeSkill = originalSkill.replace(`name: ${originalId}\n`, `name: ${id}\n`);
      const instructions = originalSkill.slice(originalSkill.indexOf("\n---\n") + 5);
      assert.equal(activeSkill.slice(activeSkill.indexOf("\n---\n") + 5), instructions);
      skillProjections.push({
        originalId,
        id,
        originalSha256: createHash("sha256").update(originalSkill).digest("hex"),
        activeSha256: createHash("sha256").update(activeSkill).digest("hex"),
        instructionsSha256: createHash("sha256").update(instructions).digest("hex"),
      });
      await writeFile(join(directory, "historical-SKILL.md"), originalSkill);
      await writeFile(join(directory, "SKILL.md"), activeSkill);
      const consumerCode = originalId === "inventory-aqkc" ? "probe-consumer" : "legacy-consumer";
      // This temporary Prompt is derived from the original Skill, not a maintained business Prompt.
      await writeFile(
        join(directory, "prompt.json"),
        JSON.stringify({ label: name, consumerCode, persona: instructions, skills: [id] }),
      );
      await writeFile(
        join(directory, "plugin.json"),
        JSON.stringify({
          schemaVersion: 1,
          id,
          name,
          version: "0.0.0",
          html: "index.html",
          skills: ["SKILL.md"],
          mcp: "mcp.json",
          gea: { consumerCode, readonly: true, contract: "gea-html-v2" },
          declarations: { page: "page.json", capability: "capability.json" },
          agentResources: { provider: "dsh-agent-manage", prompt: "prompt.json" },
        }),
      );
      await writeFile(
        join(directory, "mcp.json"),
        JSON.stringify({
          provider: "gea",
          transport: "host-provided",
          contract: "gea-html-v2",
          consumer: { consumerType: "AGENT", consumerCode },
          capabilities: ["governed-sql-read"],
        }),
      );
      await writeFile(
        join(directory, "page.json"),
        JSON.stringify({
          surface: `gea-html-${id}`,
          protocol: "self-report",
          pageIds: [id],
          consumerCode,
          maxEffect: "view",
        }),
      );
      await writeFile(
        join(directory, "capability.json"),
        JSON.stringify({
          id,
          label: name,
          data: {
            consumerCode,
            tables: ["agents_scm_probe"],
            rules: ["只读"],
          },
          maxEffect: "view",
          skills: [id],
          routing: { keywords: ["验收"], summary: "隔离只读能力" },
        }),
      );
      await writeFile(
        join(directory, "index.html"),
        `<!doctype html><html lang="zh-CN"><head><style>body{background:var(--workbench-page)}</style></head><body><h1>${name}</h1><button id="read" disabled>读取样例</button><button id="write" disabled>尝试写入</button><output id="result"></output><script>
      const ready = () => parent.postMessage({protocol:'gea-html-v2',type:'ready'},'*');
      addEventListener('message', event => {
        if (event.source !== parent || event.data?.protocol !== 'gea-html-v2') return;
        if (event.data.type === 'request-ready') { ready(); return; }
        if (event.data.type !== 'connect' || typeof event.data.context?.session !== 'string' || !event.ports[0]) return;
        const port = event.ports[0], session = event.data.context.session;
        port.onmessage = e => { if(e.data.type === 'response') document.querySelector('output').textContent = JSON.stringify(e.data); };
        port.start();
        port.postMessage({type:'catalog',session,elements:[]});
        for (const id of ['read', 'write']) {
          const button = document.getElementById(id); button.disabled = false;
          button.onclick = () => port.postMessage({type:'request', id, session, method:'sql', parameters:{consumerCode:'forged-consumer', sql:id === 'read' ? 'SELECT * FROM agents_scm_probe' : 'UPDATE agents_scm_probe SET n = 9', pageNo:1, pageSize:20}});
        }
      });
      ready();
    </script></body></html>`,
      );
    }
    const app = await profile(t, {
      beforeStart: fixtureWorkbench(plugins),
      config: (base) => ({
        analysis: {
          mode: "model",
          source: "direct",
          baseUrl: base + "/v1",
          model: "fixture-model",
          apiKeyEnv: "GEA_SPLIT_TEST_KEY",
          agentCode: "probe-consumer",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: {
        GEA_SPLIT_TEST_KEY: "fixture-only",
      },
    });
    t.after(() => rm(root, { recursive: true, force: true }));
    const sqlRequests = [],
      mcpCalls = [],
      modelTools = [];
    let toolSent = false;
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path.endsWith("/ai/gateway/session")) {
        const consumer = JSON.parse(req.body);
        reply({
          success: true,
          result: {
            accessDecision: { allowed: true },
            gatewayContext: {
              consumerType: "AGENT",
              consumerCode: consumer.consumerCode,
              sessionId: "split-session",
              conversationId: "split-conversation",
            },
            delegationToken: "split-delegation",
          },
        });
        return true;
      }
      if (path.endsWith("/ai/gateway/sql/execute") && /agents_scm_probe/.test(req.body)) {
        sqlRequests.push(req);
        reply({
          success: true,
          result: { rows: [{ n: 42 }], total: 1, pageNo: 1, pageSize: 20 },
        });
        return true;
      }
      if (path.endsWith("/ai/gateway/mcp/proxy/mcp")) {
        const body = JSON.parse(req.body);
        if (body.method === "notifications/initialized") {
          res.statusCode = 202;
          res.end();
          return true;
        }
        let result = {};
        if (body.method === "initialize")
          result = {
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "split-fixture", version: "1" },
          };
        if (body.method === "tools/list")
          result = {
            tools: [
              {
                name: "probe_read",
                description: "Read isolated fixture",
                _meta: { sourceType: "MCP", sourceCode: "probe" },
                inputSchema: { type: "object", properties: {} },
              },
            ],
          };
        if (body.method === "tools/call") {
          mcpCalls.push(body);
          result = { content: [{ type: "text", text: "SPLIT_MCP_RESULT_42" }] };
        }
        reply({ jsonrpc: "2.0", id: body.id, result });
        return true;
      }
      if (path === "/v1/chat/completions") {
        const body = JSON.parse(req.body);
        modelTools.push(body.tools.map((tool) => tool.function.name));
        const delta = toolSent
          ? { content: "验收读取完成。" }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: "split-read",
                  type: "function",
                  function: {
                    name: "gea_module_mcp",
                    arguments: JSON.stringify({
                      consumerCode: "probe-consumer",
                      tool: "probe_read",
                      arguments: {},
                    }),
                  },
                },
              ],
            };
        toolSent = true;
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: delta.tool_calls ? "tool_calls" : "stop",
                },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
        return true;
      }
      return false;
    });
    await app.login();
    const agentSessions = () =>
      app.requests.filter((req) => req.url.pathname.endsWith("/ai/gateway/agent/session"));
    const initialAgentSessions = agentSessions().length;
    assert.equal(initialAgentSessions, 1, "login performs one real analysis-agent handshake");
    assert.deepEqual(
      agentSessions().map((req) => JSON.parse(req.body).agentCode),
      ["probe-consumer"],
    );
    const status = await app.rpc("status");
    assert.deepEqual(
      status.value.modules
        .filter((m) => m.id.startsWith("inventory-"))
        .map((m) => [m.id, m.consumerCode, m.pageIds]),
      [
        ["inventory-split-aqkc-probe", "probe-consumer", ["inventory-split-aqkc-probe"]],
        ["inventory-split-fc-probe", "legacy-consumer", ["inventory-split-fc-probe"]],
      ],
    );
    const browser = await chromium.launch({
      headless: true,
    });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1536, height: 920 },
    });
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.origin);
    const opens = new Map();
    page.on("response", async (response) => {
      if (!response.url().endsWith("/api/agent-workbench/page") || !response.ok()) return;
      const request = response.request().postDataJSON();
      if (request?.operation !== "open") return;
      opens.set(request.pageId, { ...request, ...(await response.json()) });
    });
    await preparePageStartup(page);
    const openThemeSettings = async () => {
      await page.getByRole("button", { name: "账户菜单", exact: true }).click();
      await page.getByRole("menuitem", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "通用设置", exact: true }).click();
    };
    await openThemeSettings();
    await changeThemeSetting(page, "深色", "preference");
    await changeThemeSetting(page, "增大字号", "fontSize");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    let themePageId;
    const checkSharedTheme = async (background) => {
      await expect(htmlFrameElement(page, themePageId).contentFrame().locator("body")).toHaveCSS(
        "background-color",
        background,
      );
      await expect(htmlFrameElement(page, themePageId)).toHaveCSS("font-size", "15px");
      assert.equal(
        await page
          .locator("body")
          .evaluate((element) =>
            getComputedStyle(element).getPropertyValue("--workbench-theme-version").trim(),
          ),
        '"1.1.1"',
      );
      await expect(page.locator('style[data-agent-workbench-theme="1.1.1"]')).toHaveCount(1);
      await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
    };
    for (const [id, name] of [
      ["inventory-split-fc-probe", "分仓库存"],
      ["inventory-split-aqkc-probe", "基地库存"],
    ]) {
      await openWorkbenchPage(page, name);
      const frame = htmlFrameElement(page, id).contentFrame();
      themePageId = id;
      await expect.poll(() => opens.get(id)?.owner).toEqual(expect.any(String));
      assert.equal(opens.get(id).resourceId, "gea-html-" + id);
      assert.match(opens.get(id).sessionId, /^session-[0-9a-f-]{36}$/);
      await expect(frame.getByRole("heading", { name })).toBeVisible();
      await checkSharedTheme("rgb(27, 29, 33)");
      await frame.getByRole("button", { name: "读取样例" }).click();
      await expect(frame.locator("output")).toContainText("42");
      const count = sqlRequests.length;
      await frame.getByRole("button", { name: "尝试写入" }).click();
      await expect(frame.locator("output")).toContainText("READ_ONLY");
      assert.equal(sqlRequests.length, count, "write rejected before external service");
    }
    await page.reload();
    await checkSharedTheme("rgb(27, 29, 33)");
    assert.equal(sqlRequests.length, 2);
    assert.ok(
      app.requests
        .filter((req) => req.url.pathname.endsWith("/ai/gateway/agent/session"))
        .every((req) => !req.body.includes("forged-consumer")),
    );
    assert.deepEqual(
      agentSessions()
        .slice(initialAgentSessions)
        .map((req) => JSON.parse(req.body).agentCode),
      ["legacy-consumer", "probe-consumer"],
      "the two SQL reads use their Host-owned Consumers, never the forged input",
    );
    assert.deepEqual(
      agentSessions().map((req) => JSON.parse(req.body).agentCode),
      ["probe-consumer", "legacy-consumer", "probe-consumer"],
      "all three physical handshakes, including login, remain counted",
    );
    await until(
      () => app.requests,
      (rows) => rows.some((req) => req.body.includes("tools/list")),
    );
    const selected = await selectBusinessResource(app, "gea-html-inventory-split-aqkc-probe");
    assert.equal(selected.preset, "gea-html-inventory-split-aqkc-probe");
    const created = await app.remote("session/create", {
      cwd: app.runtime + "/workspace",
      agentPreset: selected.preset,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const sessionId = created.value.sessionId;
    assert.equal(
      (
        await app.remote("session/selectModel", {
          sessionId,
          provider: "gea-analysis",
          model: "fixture-model",
        })
      ).ok,
      true,
    );
    assert.equal(
      (
        await app.remote("session/prompt", {
          requestId: randomUUID(),
          sessionId,
          mode: "queue",
          content: [{ type: "text", text: "调用隔离只读能力。" }],
        })
      ).ok,
      true,
    );
    const rows = await until(
      () => readSession(app.runtime, sessionId),
      (rows) => rows.some((row) => row.type === "turn/end"),
      20000,
    );
    assert.equal(
      mcpCalls.length,
      1,
      JSON.stringify({ modelTools, output: app.output.slice(-3000) }),
    );
    assert.equal(mcpCalls[0].params._meta.agentCode, "probe-consumer");
    const toolCalls = rows.filter((row) => row.type === "tool/call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].data.name, "gea_module_mcp");
    assert.deepEqual(JSON.parse(toolCalls[0].data.arguments), {
      consumerCode: "probe-consumer",
      tool: "probe_read",
      arguments: {},
    });
    const toolResults = readToolResults(rows);
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].callId, toolCalls[0].data.callId);
    assert.equal(toolResults[0].isError, false);
    assert.equal(modelTools.length, 2, "one model tool call and its follow-up");
    assert.ok(modelTools.every((tools) => tools.includes("gea_module_mcp")));
    assert.match(JSON.stringify(readToolResults(rows)), /SPLIT_MCP_RESULT_42/);
    assert.deepEqual(errors, []);
    await mkdir(".runtime/split-declarations", { recursive: true });
    await page.screenshot({ path: ".runtime/split-declarations/dark.png", fullPage: true });
    await openThemeSettings();
    await changeThemeSetting(page, "浅色", "preference");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await checkSharedTheme("rgb(247, 248, 250)");
    await page.screenshot({
      path: ".runtime/split-declarations/page.png",
      fullPage: true,
    });
    await writeFile(
      ".runtime/split-declarations/result.json",
      JSON.stringify(
        {
          modules: status.value.modules,
          skillProjections,
          sqlReads: sqlRequests.length,
          mcpCalls: mcpCalls.length,
          tools: modelTools,
          pageErrors: errors,
          sharedTheme: {
            version: "1.1.1",
            fontSize: 15,
            schemes: ["dark", "light"],
            survivesReload: true,
          },
        },
        null,
        2,
      ),
    );
  },
);
