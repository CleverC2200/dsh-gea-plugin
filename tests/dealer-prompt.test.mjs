import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { profile, readSession, readToolResults, until } from "./profile.mjs";
import { fixtureWorkbench } from "./fixtures/workbench-profile.mjs";
import { createBusinessSession, selectBusinessResource } from "./fixtures/business-session.mjs";
import { requireSourceInputs } from "../scripts/source-profile.mjs";
import { nativeWebPrompt, withoutNativeWebPrompt } from "./fixtures/native-web-prompt.mjs";

test(
  "dealer inventory uses the maintained skill in the real assembled prompt, without altering the sales-plan context",
  { timeout: 45000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "gea-stock-prompt-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "history", "skills", "aqkc"), { recursive: true });
    await mkdir(join(root, "skills", "dealer"), { recursive: true });
    const sources = requireSourceInputs(
      JSON.parse(await readFile(process.env.GEA_TEST_SOURCE_INPUTS, "utf8")),
    );
    const maintainedRoot = join(
      sources.find((source) => source.repo === "dsh-agent-manage").source,
      "business-resources",
      "inventory-dealer",
    );
    const maintained = {};
    for (const [file, sha256] of Object.entries({
      "prompt.json": "b42862eeace4af14a875e25e7b454070088d50d68b18bef4549337ade4fc96bf",
      "capability.json": "17645e9a1803587d34ff42ff2ead47ca20a39f07627bc6a7a5c51dd2e764baa4",
      "skills/dealer/SKILL.md": "e4bc4ded2a7f6b60f7147e2c48b9fc9826944e55c94d0e5c8709a7e12e7cfb74",
    })) {
      const bytes = await readFile(join(maintainedRoot, file));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, file);
      maintained[file] = bytes.toString("utf8");
      await writeFile(join(root, file), bytes);
    }
    assert.equal(
      JSON.parse(maintained["prompt.json"]).consumerCode,
      "dealer-inventory-replenishment",
    );
    assert.equal(
      JSON.parse(maintained["capability.json"]).data.consumerCode,
      "dealer-inventory-replenishment",
    );
    const oldSkill =
      "---\nname: inventory-dealer\ndescription: 经销商库存\n---\n先调用 inventory_dealer_page，name=context；必须保持页面打开。\n";
    // Preserve the original input separately; no current resource registers this historical Skill.
    await writeFile(join(root, "history", "skills", "aqkc", "SKILL.md"), oldSkill);
    await writeFile(join(root, "index.html"), "<!doctype html><body>经销商库存</body>");
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "inventory-dealer",
        name: "经销商库存",
        version: "0.0.0",
        html: "index.html",
        skills: ["skills/dealer/SKILL.md"],
        declarations: { page: "page.json", capability: "capability.json" },
        agentResources: { provider: "dsh-agent-manage", prompt: "prompt.json" },
        mcp: "mcp.json",
        gea: {
          consumerCode: "dealer-inventory-replenishment",
          readonly: true,
          contract: "gea-html-v2",
        },
      }),
    );
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        provider: "gea",
        transport: "host-provided",
        contract: "gea-html-v2",
        consumer: { consumerType: "AGENT", consumerCode: "dealer-inventory-replenishment" },
        capabilities: ["governed-sql-read"],
      }),
    );
    await writeFile(
      join(root, "page.json"),
      JSON.stringify({
        surface: "gea-html-inventory-dealer",
        protocol: "self-report",
        pageIds: ["inventory-dealer"],
        consumerCode: "dealer-inventory-replenishment",
        maxEffect: "view",
      }),
    );
    const app = await profile(t, {
      beforeStart: fixtureWorkbench([root]),
      config: (base) => ({
        cubeMcpCodes: { production: "cube" },
        analysis: {
          mode: "model",
          baseUrl: base + "/v1",
          model: "fixture-model",
          apiKeyEnv: "GEA_TEST_MODEL_KEY",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: {
        GEA_TEST_MODEL_KEY: "fixture-only",
      },
    });
    const requests = [];
    const catalogConsumers = [];
    const inspections = [];
    let loadSkill = false;
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/ai/gateway/session")) {
        const body = JSON.parse(req.body);
        catalogConsumers.push(body.consumerCode);
        reply({
          success: true,
          result: {
            accessDecision: { allowed: true },
            gatewayContext: {
              consumerType: "AGENT",
              consumerCode: body.consumerCode,
              sessionId: "fixture-session",
              conversationId: "fixture-conversation",
            },
            delegationToken: "fixture-delegation",
          },
        });
        return true;
      }
      if (req.url.pathname.endsWith("/ai/gateway/mcp/proxy/mcp")) {
        const b = JSON.parse(req.body);
        let result;
        if (b.method === "initialize")
          result = {
            protocolVersion: b.params.protocolVersion,
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "fixture", version: "1" },
          };
        else if (b.method === "notifications/initialized") {
          res.statusCode = 202;
          res.end();
          return true;
        } else if (b.method === "tools/list")
          result = {
            tools: [
              {
                name: "inspect_cube_model",
                _meta: { sourceType: "MCP", sourceCode: "cube" },
                inputSchema: {
                  type: "object",
                  properties: {
                    keyword: { type: "string" },
                  },
                  additionalProperties: false,
                },
              },
            ],
          };
        else if (b.method === "tools/call") {
          assert.equal(b.params.name, "inspect_cube_model");
          assert.deepEqual(b.params.arguments, { keyword: "stock_cube" });
          inspections.push(b.params._meta.agentCode);
          result = {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  semanticModel: [
                    {
                      name: "stock_cube",
                      dimensions: [{ name: "stock_cube.base", type: "string" }],
                      measures: [{ name: "stock_cube.row_count", type: "number" }],
                    },
                  ],
                }),
              },
            ],
          };
        } else result = {};
        reply({ jsonrpc: "2.0", id: b.id, result });
        return true;
      }
      if (req.url.pathname !== "/v1/chat/completions") return false;
      const body = JSON.parse(req.body);
      res.setHeader("Content-Type", "text/event-stream");
      requests.push(body);
      const callTool = !body.messages.some((x) => x.role === "tool");
      const delta = callTool
        ? {
            tool_calls: [
              {
                index: 0,
                id: "load-stock-context",
                type: "function",
                function: {
                  name: loadSkill ? "skill" : "mcp__gea-gateway__inspect_cube_model",
                  arguments: JSON.stringify(
                    loadSkill ? { name: "inventory-dealer" } : { keyword: "stock_cube" },
                  ),
                },
              },
            ],
          }
        : { content: "收到。" };
      res.end(
        "data: " +
          JSON.stringify({
            choices: [{ index: 0, delta, finish_reason: callTool ? "tool_calls" : "stop" }],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return true;
    });
    // Discovery needs an actual eligible Core Session; login does not grant one.
    await createBusinessSession(app);
    await app.login();
    if (process.env.GEA_TEST_SOURCE_CORE === "1") {
      // The combined profile also connects Agent Manage's default MCP bridge at login.
      await until(
        () => catalogConsumers,
        (values) => values.length > 0,
      );
      assert.deepEqual(catalogConsumers, ["sales_forecast"]);
      catalogConsumers.length = 0;
    }
    async function ask(preset) {
      const selected = await selectBusinessResource(app, preset);
      assert.equal(selected.preset, preset);
      const requestStart = requests.length;
      const created = await app.remote("session/create", {
        cwd: app.runtime + "/workspace",
        agentPreset: selected.preset,
      });
      assert.equal(created.ok, true, JSON.stringify(created));
      const id = created.value.sessionId;
      assert.equal(
        (
          await app.remote("session/selectModel", {
            sessionId: id,
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
            sessionId: id,
            mode: "queue",
            content: [{ type: "text", text: "按基地看库存合计，并列出前十个缺货 SKU。" }],
          })
        ).ok,
        true,
      );
      const records = await until(
        () => readSession(app.runtime, id),
        (r) => r.some((x) => x.type === "turn/end"),
      );
      assert.equal(
        records.find((x) => x.type === "turn/end").data.reason.kind,
        "completed",
        JSON.stringify(records.find((x) => x.type === "turn/end").data.reason),
      );
      assert.equal(requests.length - requestStart, 2, "one tool call and its model follow-up");
      if (loadSkill) {
        const calls = records.filter((record) => record.type === "tool/call");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].data.name, "skill");
        assert.deepEqual(JSON.parse(calls[0].data.arguments), { name: "inventory-dealer" });
        const results = readToolResults(records);
        assert.equal(results.length, 1);
        assert.equal(results[0].callId, calls[0].data.callId);
        assert.equal(results[0].isError, false, results[0].text);
        const text = results[0].text;
        assert.ok(text.startsWith('<skill_content name="inventory-dealer">'));
        assert.ok(
          text.includes(
            "Base directory for this skill: " + (await realpath(join(root, "skills", "dealer"))),
          ),
        );
        const instructions = /<skill_instructions>\n([\s\S]*)\n<\/skill_instructions>/.exec(text);
        assert.ok(instructions, "the public skill result contains instruction content");
        assert.equal(
          instructions[1],
          maintained["skills/dealer/SKILL.md"].replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""),
          "Manage projects only frontmatter; the maintained instruction bytes are unchanged",
        );
      }
      return requests.at(-1);
    }
    const nativeWeb = await nativeWebPrompt(app.origin);
    const stock = await ask("gea-html-inventory-dealer");
    const system = stock.messages
      .filter((x) => x.role === "system")
      .map((x) => x.content)
      .join("\n");
    assert.equal(
      system,
      "You are the smartest and most useful AI assistant in the world, capable of helping users complete all tasks.\n\n" +
        JSON.parse(maintained["prompt.json"]).persona,
    );
    assert.doesNotMatch(
      withoutNativeWebPrompt(system, nativeWeb),
      /inventory_dealer_page|name=context|明细既不做交付物|没有任何模型同时具备|HMR receiver|pnpm run dev:web|销售计划汇总例外/,
    );
    assert.ok(stock.tools.some((x) => x.function.name === "mcp__gea-gateway__inspect_cube_model"));
    assert.ok(!stock.tools.some((x) => x.function.name === "gea_page"));
    const stockCatalog = JSON.stringify(stock.messages.filter((x) => x.role === "tool"));
    assert.match(stockCatalog, /stock_cube.row_count/);
    assert.equal(
      catalogConsumers.at(-1),
      "dealer-inventory-replenishment",
      "inspection uses the selected business resource Consumer",
    );
    const managed = maintained["skills/dealer/SKILL.md"];
    assert.match(managed, /action=context/);
    assert.doesNotMatch(managed, /inventory_dealer_page/);
    assert.equal(
      await readFile(join(root, "history", "skills", "aqkc", "SKILL.md"), "utf8"),
      oldSkill,
      "the historical page artifact is unchanged and is not a registered Skill",
    );
    const sales = await ask("gea-readonly");
    const salesSystem = sales.messages
      .filter((x) => x.role === "system")
      .map((x) => x.content)
      .join("\n");
    assert.match(salesSystem, /agents_sales_plan_detail_mi/);
    assert.match(salesSystem, /实时审批状态/);
    assert.match(salesSystem, /query_business_data/);
    assert.doesNotMatch(
      withoutNativeWebPrompt(salesSystem, nativeWeb),
      /HMR receiver/,
      "GEA business instructions cannot introduce development-only guidance",
    );
    assert.match(
      JSON.stringify(sales.messages.filter((x) => x.role === "tool")),
      /stock_cube.row_count/,
    );
    assert.equal(catalogConsumers.at(-1), "sales_forecast");
    assert.deepEqual(
      [...new Set(catalogConsumers)],
      ["dealer-inventory-replenishment", "sales_forecast"],
      "discovery and refreshed inspection stay in the owning Agent context",
    );
    assert.deepEqual(
      inspections,
      ["dealer-inventory-replenishment", "sales_forecast"],
      "exactly one inspection per selected business Consumer",
    );
    const handshakesBeforeSkill = catalogConsumers.length;
    loadSkill = true;
    // Explicit Skill loading uses the owning Agent's selected reference.
    const loaded = await ask("gea-html-inventory-dealer");
    const skillReply = JSON.stringify(loaded.messages.filter((x) => x.role === "tool"));
    // Consumer identity is verified by the stock gateway receipt above, not invented in Skill prose.
    assert.equal(catalogConsumers.length, handshakesBeforeSkill);
    assert.deepEqual(inspections, ["dealer-inventory-replenishment", "sales_forecast"]);
    assert.match(skillReply, /action=context/);
    assert.doesNotMatch(
      skillReply,
      /inventory_dealer_page/,
      "explicit skill loading must use the same maintained content as the stock persona",
    );
    for (const [file, bytes] of Object.entries(maintained)) {
      assert.equal(await readFile(join(root, file), "utf8"), bytes, file);
    }
  },
);
