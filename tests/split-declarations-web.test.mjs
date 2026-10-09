import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { changeThemeSetting } from "./theme-settings.mjs";
import { profile, readSession, readToolResults, until } from "./profile.mjs";

// Only external GEA and model endpoints are fixtures. Workbench, Agent Manage,
// GEA, page bridge, registry, session loop and browser all run their built source.
test(
  "旧与分离声明在真实工作台显示，Agent 管理装载能力，调用保持受控",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 90000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "gea-split-web-"));
    const plugins = [];
    for (const [id, name, split] of [
      ["inventory-fc", "分仓库存", false],
      ["inventory-aqkc", "基地库存", true],
    ]) {
      const directory = join(root, id);
      plugins.push(directory);
      await mkdir(directory);
      await writeFile(
        join(directory, "SKILL.md"),
        `---\nname: ${id}\ndescription: 隔离验收能力\n---\n只读查询。\n`,
      );
      const consumerCode = id === "inventory-aqkc" ? "probe-consumer" : "legacy-consumer";
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
          gea: { consumerCode, readonly: true, contract: "gea-html-v1" },
          ...(split
            ? {
                declarations: {
                  page: "page.json",
                  capability: "capability.json",
                },
              }
            : {}),
        }),
      );
      await writeFile(
        join(directory, "mcp.json"),
        JSON.stringify({
          provider: "gea",
          transport: "host-provided",
          contract: "gea-html-v1",
          consumer: { consumerType: "AGENT", consumerCode },
          capabilities: ["governed-sql-read"],
        }),
      );
      if (split) {
        await writeFile(
          join(directory, "page.json"),
          JSON.stringify({
            surface: `gea-html-${id}`,
            protocol: "dom-scan",
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
      }
      await writeFile(
        join(directory, "index.html"),
        `<!doctype html><html lang="zh-CN"><body><h1>${name}</h1><button id="read" disabled>读取样例</button><button id="write" disabled>尝试写入</button><output id="result"></output><script>
      addEventListener('message', event => {
        if (event.data?.protocol !== 'gea-html-v1' || event.data.type !== 'connect') return;
        const port = event.ports[0];
        port.onmessage = e => { if(e.data.type === 'response') document.querySelector('output').textContent = JSON.stringify(e.data); };
        port.start();
        for (const id of ['read', 'write']) {
          const button = document.getElementById(id); button.disabled = false;
          button.onclick = () => port.postMessage({type:'request', id, method:'sql', parameters:{consumerCode:'forged-consumer', sql:id === 'read' ? 'SELECT * FROM agents_scm_probe' : 'UPDATE agents_scm_probe SET n = 9', pageNo:1, pageSize:20}});
        }
      });
      parent.postMessage({protocol:'gea-html-v1',type:'ready'},'*');
    </script></body></html>`,
      );
    }
    const app = await profile(t, {
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
        GEA_HTML_PLUGIN_ROOTS: JSON.stringify(plugins),
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
        const loaded = body.tools.some((tool) => tool.function.name === "gea_module_mcp");
        const delta = toolSent
          ? { content: "验收读取完成。" }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: loaded ? "split-read" : "split-load",
                  type: "function",
                  function: {
                    name: loaded ? "gea_module_mcp" : "gea_capabilities",
                    arguments: JSON.stringify(
                      loaded
                        ? {
                            consumerCode: "probe-consumer",
                            tool: "probe_read",
                            arguments: {},
                          }
                        : { pack: "knowledge" },
                    ),
                  },
                },
              ],
            };
        if (loaded) toolSent = true;
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
    const status = await app.rpc("status");
    assert.deepEqual(
      status.value.modules
        .filter((m) => m.id.startsWith("inventory-"))
        .map((m) => [m.id, m.consumerCode, m.pageIds]),
      [
        ["inventory-aqkc", "probe-consumer", ["inventory-aqkc"]],
        ["inventory-fc", "legacy-consumer", ["inventory-fc"]],
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
    await page
      .getByRole("dialog", { name: /内测声明|预览版说明/ })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    const openThemeSettings = async () => {
      await page.getByRole("button", { name: "账户菜单", exact: true }).click();
      await page.getByRole("menuitem", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "通用设置", exact: true }).click();
    };
    await openThemeSettings();
    await changeThemeSetting(page, "深色", "preference");
    await changeThemeSetting(page, "增大字号", "fontSize");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    const checkSharedTheme = async (background) => {
      await expect(page.locator("body")).toHaveCSS("background-color", background);
      await expect(page.locator(".AppFrame_frame")).toHaveCSS("font-size", "15px");
      assert.equal(
        await page
          .locator("body")
          .evaluate((element) =>
            getComputedStyle(element).getPropertyValue("--workbench-theme-version").trim(),
          ),
        '"1.0.0"',
      );
      await expect(page.locator('style[data-plugin-css$="/workbench-theme.css"]')).toHaveCount(1);
      await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
    };
    for (const [id, name] of [
      ["inventory-fc", "分仓库存"],
      ["inventory-aqkc", "基地库存"],
    ]) {
      if (!(await page.getByText(name, { exact: true }).isVisible()))
        await page.getByText("库存管理", { exact: true }).click();
      await page.getByText(name, { exact: true }).click();
      const frame = page.frameLocator(`iframe[src*="/api/gea-html/${id}/html"]`);
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
    await until(
      () => app.requests,
      (rows) => rows.some((req) => req.body.includes("tools/list")),
    );
    const created = await app.remote("session/create", {
      cwd: app.runtime + "/workspace",
      agentPreset: "gea-readonly",
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
          sqlReads: sqlRequests.length,
          mcpCalls: mcpCalls.length,
          tools: modelTools,
          pageErrors: errors,
          sharedTheme: {
            version: "1.0.0",
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
