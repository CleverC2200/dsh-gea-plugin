import { selectBusinessResource, fixtureRequest } from "./fixtures/business-session.mjs";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readSession, readToolResults, until } from "./profile.mjs";
import {
  assertCatalogScene,
  catalogSceneProfile,
  qaFixtureSkillNames,
} from "./fixtures/catalog-scene.mjs";

const out = new URL("../.runtime/prompt-qa-regression/", import.meta.url);
await mkdir(out, { recursive: true });
const findings = [];
const observations = [];
// Original native schema capture before business display compression, excluding descriptions only.
const nativeConstraints = JSON.parse(
  await readFile(
    new URL("./fixtures/native-business-tool-constraints.json", import.meta.url),
    "utf8",
  ),
);
const fixedNativeTools = [
  "forecast_compute",
  "gea_capabilities",
  "gea_evidence_read",
  "gea_sales_plan_read",
  "mcp__gea-gateway__inspect_cube_model",
  "mcp__gea-gateway__query_business_data",
  "render_ui",
  "skill",
  "skill_reference_read",
  "validate_dsh_ui",
];
function schemaConstraints(value) {
  if (Array.isArray(value)) return value.map(schemaConstraints);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description")
      .map(([key, item]) => [key, schemaConstraints(item)]),
  );
}
const input = (count = 2) => ({
  schema_version: 1,
  data_mode: "mock",
  snapshot_at: "2026-09-25T12:00:00+08:00",
  base_month: "2026-09",
  target_month: "2026-10",
  prior_base_month: "2025-09",
  prior_target_month: "2025-10",
  period_mapping_confirmation: "fixture-only",
  candidate_policy_confirmation: "fixture-only",
  records: Array.from({ length: count }, (_, i) => ({
    customer_id: "mock-c",
    sku_id: "mock-s-" + i,
    unit: "件",
    source_ref: "user-provided-fixture",
    eligible: true,
    product_kind: "regular",
    seasonal: false,
    quality_issues: [],
    base_plan_qty: "1000",
    base_actual_to_cutoff_qty: "800",
    prior_base_actual_qty: "800",
    prior_target_actual_qty: "1200",
    target_yoy_growth: "0.1",
    target_mom_growth: "0.2",
  })),
});
const action = (name, args) => ({ name, args });
const decode = readToolResults;
const resultObject = (e) => {
  try {
    return JSON.parse(e.text);
  } catch {
    return undefined;
  }
};

test("independent acceptance, no production writes", { timeout: 150000 }, async (t) => {
  const app = await catalogSceneProfile(
    t,
    {
      config: (base) => ({
        geaEnvironments: { production: base, test: base },
        analysis: {
          mode: "model",
          baseUrl: base + "/v1",
          model: "fixture",
          apiKeyEnv: "GEA_QA_MODEL_KEY",
          agentCode: "sales_forecast",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: { GEA_QA_MODEL_KEY: "fixture-only" },
    },
    "promptQa",
  );
  const fixtureSkills = qaFixtureSkillNames.map((name) => ({
    kind: "personal",
    name,
    description: "local regression fixture",
    content: "Explicit domain rule fixture.",
    enabled: true,
  }));
  async function saveFixtureSkills() {
    const saved = await fixtureRequest(app, "/api/agent-manage/agents/plugin/skills", {
      id: "gea-readonly",
      skills: fixtureSkills,
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
  }
  async function updateFixtureSkill(name, changes) {
    const skill = fixtureSkills.find((skill) => skill.name === name);
    assert.ok(skill);
    Object.assign(skill, changes);
    await saveFixtureSkills();
  }
  await saveFixtureSkills();
  let script = [],
    captured = [];
  app.route(async (req, res) => {
    if (req.url.pathname !== "/v1/chat/completions") return false;
    const body = JSON.parse(req.body);
    captured.push(body);
    const step = script.shift();
    await step?.before?.(body);
    res.setHeader("Content-Type", "text/event-stream");
    const delta = step
      ? {
          tool_calls: [
            {
              index: 0,
              id: "qa-" + randomUUID(),
              type: "function",
              function: {
                name: step.name,
                arguments: JSON.stringify(
                  typeof step.args === "function" ? step.args(body) : step.args,
                ),
              },
            },
          ],
        }
      : { content: "已完成本地测试步骤。" };
    res.end(
      "data: " +
        JSON.stringify({
          choices: [{ index: 0, delta, finish_reason: step ? "tool_calls" : "stop" }],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
    return true;
  });
  await app.login();
  async function create() {
    await selectBusinessResource(app, "gea-readonly");
    const made = await app.remote("session/create", {
      cwd: app.runtime + "/workspace",
      agentPreset: "gea-readonly",
    });
    assert.equal(made.ok, true, JSON.stringify(made));
    const id = made.value.sessionId;
    await app.remote("session/selectModel", {
      sessionId: id,
      provider: "gea-analysis",
      model: "fixture",
    });
    return id;
  }
  async function run(id, steps, label) {
    script = [...steps];
    captured = [];
    const prior = await readSession(app.runtime, id);
    const before = prior.filter((e) => e.type === "turn/end").length;
    const sent = await app.remote("session/prompt", {
      requestId: randomUUID(),
      sessionId: id,
      mode: "queue",
      content: [{ type: "text", text: label }],
    });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const rows = await until(
      () => readSession(app.runtime, id),
      (r) => r.filter((e) => e.type === "turn/end").length > before,
      25000,
    );
    const fresh = rows.slice(prior.length);
    return { rows: fresh, tools: decode(fresh), requests: [...captured] };
  }
  async function check(name, fn) {
    await t.test(name, async () => {
      try {
        const detail = await fn();
        observations.push({ name, status: "pass", detail });
      } catch (error) {
        findings.push({ name, status: "fail", message: error.message });
        throw error;
      }
    });
  }
  t.after(async () => {
    await writeFile(
      new URL("results.json", out),
      JSON.stringify({ kind: "regression", findings, observations }, null, 2),
    );
  });

  await check(
    "fixed native 10-tool prompt with four fixture forecast Skills preserves constraints and reports actual length",
    async () => {
      const r = await run(await create(), [], "本月提报情况");
      const b = r.requests[0];
      const system = b.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n");
      const catalog = b.messages
        .filter(
          (message) =>
            message.role === "user" && String(message.content).includes("<available_skills>"),
        )
        .map((message) => message.content)
        .join("\n");
      const total = system.length + catalog.length + JSON.stringify(b.tools).length;
      assert.match(catalog, /sinian-demand-dialogue/);
      assert.match(catalog, /sinian-forecast-review/);
      assertCatalogScene(app, b, r.rows);
      const businessSchemas = fixedNativeTools.map((name) => {
        const matches = b.tools.filter((tool) => tool.function.name === name);
        assert.equal(matches.length, 1, `frozen business schema must be unique: ${name}`);
        return matches[0];
      });
      assert.deepEqual(
        schemaConstraints(businessSchemas),
        nativeConstraints,
        "display compression must preserve every original field, required/enums/ranges/union constraint",
      );
      return {
        system: system.length,
        nativeCatalog: catalog.length,
        tools: JSON.stringify(b.tools).length,
        total,
        names: b.tools.map((t) => t.function.name),
      };
    },
  );
  await check(
    "invalid capability schema cannot change the configured tools or enlarge this turn budget",
    async () => {
      const r = await run(
        await create(),
        [
          action("gea_capabilities", {
            complex: "invalid",
          }),
          action("gea_capabilities", {}),
        ],
        "尝试一个无效能力组合后检查状态",
      );
      assert.equal(r.tools[0].isError, true);
      const state = resultObject(r.tools[1]);
      await writeFile(
        new URL("failed-capability-state.json", out),
        JSON.stringify(
          {
            firstError: r.tools[0].text,
            modulesAreConfiguredNotAuthorized: state.modulesAreConfiguredNotAuthorized,
            callLimit: state.callLimit,
            secondRequestTools: r.requests[1].tools.map((t) => t.function.name),
            afterInspectionTools: r.requests[2].tools.map((t) => t.function.name),
          },
          null,
          2,
        ),
      );
      assert.ok(
        state.modulesAreConfiguredNotAuthorized === true && state.callLimit === undefined,
        `failed call changed budget=${state.callLimit}`,
      );
    },
  );
  await check("capability inspection exposes no turn allowance", async () => {
    const id = await create();
    const a = await run(id, [action("gea_capabilities", {})], "本轮是复杂任务");
    assert.equal(resultObject(a.tools[0]).callLimit, undefined);
    const b = await run(id, [action("gea_capabilities", {})], "新一轮简单查询");
    assert.equal(resultObject(b.tools[0]).callLimit, undefined);
    return { first: 40, next: 20 };
  });
  await check(
    "native Skill instructions retain their Session revision and new Sessions read the updated Agent",
    async () => {
      const changed = action("skill", { name: "sinian-demand-dialogue" });
      changed.before = async () => {
        await updateFixtureSkill("sinian-demand-dialogue", {
          description: "changed fixture",
          content: "Updated original domain rule fixture.",
        });
      };
      const r = await run(
        await create(),
        [
          action("skill", { name: "sinian-demand-dialogue" }),
          action("skill", { name: "sinian-demand-dialogue" }),
          changed,
        ],
        "核对原生业务规则",
      );
      assert.ok(
        r.tools.every((tool) => !tool.isError),
        JSON.stringify(r.tools),
      );
      assert.match(r.tools[0].text, /<skill_content/);
      assert.match(r.tools[0].text, /Explicit domain rule fixture/);
      assert.match(
        JSON.stringify(r.requests[1].messages.filter((message) => message.role === "tool")),
        /Explicit domain rule fixture/,
      );
      assert.match(
        r.tools[1].text,
        /Explicit domain rule fixture/,
        "the current native contract returns the full validated body again",
      );
      assert.match(
        r.tools[2].text,
        /Explicit domain rule fixture/,
        "an existing Session retains its Skill revision",
      );
      const other = await run(
        await create(),
        [action("skill", { name: "sinian-demand-dialogue" })],
        "另一会话按当前原资源读取",
      );
      assert.match(other.tools[0].text, /Updated original domain rule fixture/);
      assert.equal(other.tools[0].isError, false);
    },
  );
  await check(
    "explicit null growth should mark only that row partial, not the valid row in the same forecast batch",
    async () => {
      const data = input();
      data.records[0].target_mom_growth = null;
      const r = await run(
        await create(),
        [action("gea_capabilities", {}), action("forecast_compute", data)],
        "两行输入，一行增长规划缺失，继续计算另一行",
      );
      await writeFile(
        new URL("null-growth-result.json", out),
        JSON.stringify({ isError: r.tools[1].isError, text: r.tools[1].text }, null, 2),
      );
      assert.equal(r.tools[1].isError, false, r.tools[1].text);
      const result = resultObject(r.tools[1]);
      assert.equal(result.coverage.calculated, 1);
      assert.equal(result.coverage.partial, 1);
    },
  );
  await check("omitted growth control preserves the independent valid row", async () => {
    const data = input();
    delete data.records[0].target_mom_growth;
    const r = await run(
      await create(),
      [action("gea_capabilities", {}), action("forecast_compute", data)],
      "缺失规划字段省略，其余一行继续",
    );
    const result = resultObject(r.tools[1]);
    assert.equal(r.tools[1].isError, false, r.tools[1].text);
    assert.equal(result.coverage.calculated, 1);
    assert.equal(result.coverage.partial, 1);
    return result.coverage;
  });
  await check(
    "a same-user follow-up can read the rest of an already computed large provided draft without recalculation",
    async () => {
      const id = await create();
      const supplied = input(24);
      supplied.data_mode = "provided";
      const r = await run(
        id,
        [action("gea_capabilities", {}), action("forecast_compute", supplied)],
        "按我提供的以下输入计算24行：" + JSON.stringify(supplied),
      );
      const projected = resultObject(r.tools[1]);
      assert.equal(projected.projection, "partial");
      assert.ok(projected.evidenceId);
      const next = await run(
        id,
        [
          action("gea_evidence_read", {
            evidenceId: projected.evidenceId,
            offset: 0,
            limit: 1000,
          }),
        ],
        "只补充展示刚才结果的明细，不重新计算",
      );
      await writeFile(
        new URL("followup-evidence.json", out),
        JSON.stringify(
          {
            evidenceId: projected.evidenceId,
            firstProjection: projected.projection,
            dataMode: "provided",
            nextError: next.tools[0].text,
            isError: next.tools[0].isError,
          },
          null,
          2,
        ),
      );
      assert.equal(next.tools[0].isError, false, next.tools[0].text);
    },
  );
  await check(
    "model-only provided and live inputs never gain a cross-turn source grant",
    async () => {
      for (const mode of ["provided", "live"]) {
        const id = await create();
        const data = input(24);
        data.data_mode = mode;
        const first = await run(
          id,
          [action("gea_capabilities", {}), action("forecast_compute", data)],
          mode === "live"
            ? "以下是 live 输入：" + JSON.stringify(data)
            : "执行计算，未提供任何输入正文",
        );
        const evidenceId = resultObject(first.tools[1]).evidenceId;
        const next = await run(id, [action("gea_evidence_read", { evidenceId })], "读取上轮结果");
        assert.equal(next.tools[0].isError, true);
        assert.match(next.tools[0].text, /GEA_EVIDENCE_STALE/);
      }
    },
  );
  await check("null quantities and eligibility block only their own row", async () => {
    const data = input(3);
    data.records[0].base_plan_qty = null;
    data.records[1].eligible = null;
    const r = await run(
      await create(),
      [action("gea_capabilities", {}), action("forecast_compute", data)],
      "检查缺失行与正常行",
    );
    assert.equal(r.tools[1].isError, false, r.tools[1].text);
    assert.equal(resultObject(r.tools[1]).coverage.blocked, 2);
    assert.equal(resultObject(r.tools[1]).coverage.calculated, 1);
  });
  await check(
    "failed budget changes preserve the selected resource capabilities across restart",
    async () => {
      const id = await create();
      const r = await run(
        id,
        [
          action("gea_capabilities", {}),
          action("gea_capabilities", {
            complex: "invalid",
          }),
          action("gea_capabilities", {}),
        ],
        "检查已有能力的失败升级",
      );
      assert.equal(r.tools[1].isError, true);
      assert.equal(resultObject(r.tools[2]).modulesAreConfiguredNotAuthorized, true);
      assert.deepEqual(
        r.requests.at(-1).tools.map((tool) => tool.function.name),
        r.requests[0].tools.map((tool) => tool.function.name),
        "a rejected budget change does not change configured tools",
      );
      assert.equal(resultObject(r.tools[2]).callLimit, undefined);
      assert.equal(
        r.requests.at(-1).tools.some((t) => t.function.name === "render_ui"),
        r.requests[0].tools.some((t) => t.function.name === "render_ui"),
      );
      await app.stop();
      await app.start();
      await app.login();
      const restored = await run(id, [], "重启后检查失败加载没有恢复");
      const names = restored.requests[0].tools.map((t) => t.function.name);
      assert.ok(names.includes("forecast_compute"));
      assert.equal(
        names.includes("render_ui"),
        r.requests[0].tools.some((t) => t.function.name === "render_ui"),
        "restart restores the configured resource tools, never the rejected change",
      );
    },
  );
  await check("provided computations restore after restart but never cross sessions", async () => {
    const id = await create(),
      data = input(24);
    data.data_mode = "provided";
    const r = await run(
      id,
      [action("gea_capabilities", {}), action("forecast_compute", data)],
      "输入：\n" + JSON.stringify(data, null, 2),
    );
    const evidenceId = resultObject(r.tools[1]).evidenceId;
    await app.stop();
    await app.start();
    await app.login();
    const next = await run(
      id,
      [action("gea_evidence_read", { evidenceId, limit: 1000 })],
      "重启后读取结果",
    );
    assert.equal(next.tools[0].isError, false, next.tools[0].text);
    const other = await run(
      await create(),
      [action("gea_evidence_read", { evidenceId })],
      "尝试另一个会话引用",
    );
    assert.equal(other.tools[0].isError, true);
    assert.match(other.tools[0].text, /UNAVAILABLE/);
  });
  await check("same-turn control can read the complete computed draft", async () => {
    const r = await run(
      await create(),
      [
        action("gea_capabilities", {}),
        action("forecast_compute", input(24)),
        action("gea_evidence_read", (body) => {
          const values = body.messages
            .filter((m) => m.role === "tool")
            .map((m) => {
              try {
                return JSON.parse(m.content);
              } catch {
                return {};
              }
            });
          const found = values.find((v) => v.evidenceId);
          return {
            evidenceId: found.evidenceId,
            format: "raw",
            offset: 0,
            limit: 1000,
          };
        }),
      ],
      "计算后在同轮读取明细",
    );
    assert.equal(r.tools[2].isError, false, r.tools[2].text);
    return {
      sameTurn: true,
      readChars: resultObject(r.tools[2]).content.length,
    };
  });
  await check("ASCII signed table cells are rejected by the business UI guard", async () => {
    const r = await run(
      await create(),
      [
        action("gea_capabilities", {}),
        action("render_ui", {
          spec: {
            items: [{ type: "table", columns: ["计划差额"], rows: [["+10"]] }],
          },
        }),
      ],
      "检验业务差额颜色",
    );
    assert.equal(r.tools[1].isError, true);
    assert.match(r.tools[1].text, /GEA_UI_BUSINESS_SEMANTICS/);
    return { blocked: true };
  });
  await check(
    "equivalent signed text and hero delta cannot bypass the business UI guard",
    async () => {
      const variants = [
        {
          name: "leading whitespace",
          node: { type: "table", columns: ["计划差额"], rows: [[" +10"]] },
        },
        {
          name: "Unicode minus",
          node: { type: "table", columns: ["计划差额"], rows: [["−10"]] },
        },
        {
          name: "hero delta",
          node: {
            type: "hero",
            title: "计划差额",
            value: "10",
            delta: "+10",
          },
        },
      ];
      const results = [];
      for (const item of variants) {
        const r = await run(
          await create(),
          [action("gea_capabilities", {}), action("render_ui", { spec: { items: [item.node] } })],
          "检验业务差额颜色边界",
        );
        assert.match(r.tools[1].text, /已渲染|GEA_UI_BUSINESS_SEMANTICS/, r.tools[1].text);
        results.push({
          name: item.name,
          isError: r.tools[1].isError,
          text: r.tools[1].text.slice(0, 900),
        });
      }
      await writeFile(new URL("ui-guard-variants.json", out), JSON.stringify(results, null, 2));
      assert.ok(
        results.every((item) => item.isError && /GEA_UI_BUSINESS_SEMANTICS/.test(item.text)),
        JSON.stringify(results.map(({ name, isError }) => ({ name, isError }))),
      );
    },
  );
  await check(
    "selected resource and native renderer restore after stopping and starting the Harness process",
    async () => {
      const id = await create();
      const rendered = await run(
        id,
        [
          action("render_ui", {
            spec: {
              title: "Fixture UI",
              items: [{ type: "text", content: "Fixture business result" }],
            },
          }),
        ],
        "显示本地只读测试结果",
      );
      assert.equal(rendered.tools[0].isError, false, rendered.tools[0].text);
      assert.match(rendered.tools[0].text, /status=rendered/);
      assert.match(rendered.tools[0].text, /title="Fixture UI"/);
      assert.match(
        JSON.stringify(rendered.rows),
        /Fixture business result/,
        "native render spec is preserved in the persisted presentation metadata",
      );
      assert.ok(
        rendered.rows.some((row) => row.type === "tool/result"),
        "native renderer receipt is persisted",
      );
      await app.stop();
      await app.start();
      await app.login();
      const r = await run(id, [], "恢复同一会话继续");
      const names = r.requests[0]?.tools.map((t) => t.function.name) ?? [];
      assert.ok(names.includes("render_ui"), JSON.stringify(names));
      return { restored: names };
    },
  );
  await check(
    "local calculations retain their Agent revision, new Sessions honor Skill revocation and a different GEA identity cannot reuse evidence",
    async () => {
      const id = await create(),
        data = input(24);
      data.data_mode = "provided";
      const first = await run(
        id,
        [action("forecast_compute", data)],
        "用户原始输入：" + JSON.stringify(data),
      );
      const oldId = resultObject(first.tools[0]).evidenceId;
      assert.ok(oldId);
      await updateFixtureSkill("sinian-demand-baseline", {
        description: "changed baseline fixture",
        content: "Changed current baseline body.",
      });
      const retained = await run(
        id,
        [action("gea_evidence_read", { evidenceId: oldId })],
        "旧会话继续读取原版本计算稿",
      );
      assert.equal(retained.tools[0].isError, false, retained.tools[0].text);
      const currentSession = await create();
      const current = await run(
        currentSession,
        [action("forecast_compute", data)],
        "用户原始输入：" + JSON.stringify(data),
      );
      const currentResult = resultObject(current.tools[0]);
      const currentId = currentResult.evidenceId;
      assert.ok(currentId);
      assert.notEqual(
        currentResult.source.baselineHash,
        resultObject(first.tools[0]).source.baselineHash,
      );
      await updateFixtureSkill("sinian-demand-baseline", { enabled: false });
      const revoked = await run(
        await create(),
        [action("forecast_compute", data)],
        "用户原始输入：" + JSON.stringify(data),
      );
      assert.equal(revoked.tools[0].isError, true);
      assert.match(revoked.tools[0].text, /FORECAST_CAPABILITY_DISABLED/);
      await updateFixtureSkill("sinian-demand-baseline", { enabled: true });
      assert.equal((await app.rpc("environment/select", { environment: "test" })).ok, true);
      await app.login();
      const otherIdentity = await run(
        currentSession,
        [action("gea_evidence_read", { evidenceId: currentId })],
        "不同GEA环境不得继承旧私有稿",
      );
      assert.equal(otherIdentity.tools[0].isError, true);
      assert.match(otherIdentity.tools[0].text, /GEA_EVIDENCE_IDENTITY_CHANGED/);
    },
  );
});
