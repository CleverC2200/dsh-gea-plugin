import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { profile, readSession, until } from "./profile.mjs";
import {
  PromptEvidenceStore,
  projectEvidence,
  withoutHistoricalEvidence,
  exactResult,
} from "../src/host/prompt-evidence.ts";
import {
  instructionVisible,
  mountBusinessPrompts,
} from "../src/host/prompt-runtime.ts";
import { businessUiIssue } from "../src/host/prompt-policy.ts";
import { computeForecast, forecastTool } from "../src/host/forecast-compute.ts";
import {
  forecastInputHash,
  hasUserForecastInput,
} from "../src/host/forecast-source.ts";

test("evidence projection preserves exact numbers and scope; original reads cannot cross identities or sessions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gea-evidence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new PromptEvidenceStore(dir);
  const text =
    '{"coverage":"complete","amount":12.3400,"id":9007199254740993,"rows":' +
    JSON.stringify(
      Array.from({ length: 200 }, (_, i) => ({ i, name: "商品".repeat(30) })),
    ) +
    "}";
  const id = await store.put("a", "gea_cube_query", text);
  const result = JSON.parse(projectEvidence(text, id));
  assert.equal(result.projection, "partial");
  assert.equal(result.id, "9007199254740993");
  assert.equal(result.amount, "12.3400");
  assert.ok(JSON.stringify(result).length <= 6000);
  assert.ok(result.omittedPaths.includes("$.rows"));
  let offset = 0,
    restored = "";
  while (offset !== null) {
    const part = await store.read("a", id, offset, 1000);
    restored += part.content;
    offset = part.nextOffset;
  }
  assert.equal(restored, text);
  await assert.rejects(store.read("b", id), /UNAVAILABLE/);
  store.clear();
  await assert.rejects(store.read("a", id), /UNAVAILABLE/);
  assert.deepEqual(exactResult('{"n":0,"q":0.00001}'), { n: 0, q: "0.00001" });
});

const forecastInput = () => ({
  schema_version: 1,
  data_mode: "mock",
  base_month: "2026-09",
  target_month: "2026-10",
  prior_base_month: "2025-09",
  prior_target_month: "2025-10",
  snapshot_at: "2026-09-12T12:00:00+08:00",
  period_mapping_confirmation: "fixture",
  candidate_policy_confirmation: "fixture",
  records: [
    {
      customer_id: "c",
      sku_id: "s",
      unit: "件",
      source_ref: "fixture",
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
    },
  ],
});
test("forecast calculator preserves §5.5, missing/new/seasonal branches, exact decimals and no writes", () => {
  const input = forecastInput(),
    result = computeForecast(input);
  assert.equal(result.rows[0].forecast1, "1500");
  assert.equal(result.rows[0].forecast2, "1260");
  assert.equal(result.external_writes, false);
  delete input.records[0].target_mom_growth;
  assert.equal(computeForecast(input).rows[0].recommended_baseline, null);
  input.records[0].product_kind = "new";
  assert.equal(computeForecast(input).rows[0].status, "blocked");
  const seasonal = forecastInput();
  seasonal.records[0].seasonal = true;
  assert.equal(computeForecast(seasonal).rows[0].final_forecast, null);
  const zero = forecastInput();
  zero.records[0].prior_base_actual_qty = "0";
  assert.equal(computeForecast(zero).rows[0].status, "blocked");
  const duplicate = forecastInput();
  duplicate.records.push({ ...duplicate.records[0] });
  assert.throws(() => computeForecast(duplicate), /DUPLICATE/);
  const huge = forecastInput();
  huge.records[0].base_plan_qty = 1e308;
  huge.records[0].prior_base_actual_qty = 1e-308;
  assert.equal(computeForecast(huge).rows[0].status, "blocked");
});

test(
  "real Harness business prompt starts small, expands typed tools, loads domain rules, and preserves coding mode",
  { timeout: 90000 },
  async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), "gea-prompt-pages-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const pageProfiles = [
      ["inventory-apsplan", "aps"],
      ["inventory-qll", "full-chain-inventory"],
      ["inventory-aqkc", "base-safety-stock"],
      ["inventory-fc", "branch-inventory"],
      ["inventory-dealer", "dealer-inventory-replenishment"],
    ];
    const roots = {};
    for (const [id, consumerCode] of pageProfiles) {
      const dir = join(fixture, id);
      roots[id] = dir;
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "index.html"),
        "<!doctype html><html><body>fixture</body></html>",
      );
      await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: ${id}\ndescription: fixture\n---\nOLD_PAGE_RULE_MUST_NOT_REPLACE_MANAGED_RULE`,
      );
      await writeFile(
        join(dir, "plugin.json"),
        JSON.stringify({
          schemaVersion: 1,
          id,
          name: id,
          version: "0.0.0",
          html: "index.html",
          skills: ["SKILL.md"],
          mcp: "mcp.json",
          gea: { consumerCode, readonly: true, contract: "gea-html-v1" },
        }),
      );
      await writeFile(
        join(dir, "mcp.json"),
        JSON.stringify({
          provider: "gea",
          transport: "host-provided",
          contract: "gea-html-v1",
          consumer: { consumerType: "AGENT", consumerCode },
          capabilities: ["governed-sql-read"],
        }),
      );
    }
    const app = await profile(t, {
      config: (base) => ({
        analysis: {
          mode: "model",
          baseUrl: base + "/v1",
          model: "fixture",
          apiKeyEnv: "GEA_TEST_MODEL_KEY",
          agentCode: "sales_forecast",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: {
        GEA_TEST_MODEL_KEY: "fixture-key",
        GEA_HTML_PLUGIN_ROOTS: JSON.stringify(roots),
      },
    });
    const requests = [];
    let phase = "expand",
      skillName;
    app.route((req, res) => {
      if (req.url.pathname !== "/v1/chat/completions") return false;
      const body = JSON.parse(req.body);
      requests.push(body);
      res.setHeader("Content-Type", "text/event-stream");
      const toolReplies = body.messages.filter((x) => x.role === "tool");
      const delta =
        phase === 'inventory-recovery' && toolReplies.length === 0
          ? {tool_calls:[{index:0,id:'inventory-recovery',type:'function',function:{name:'gea_skill',arguments:JSON.stringify({name:'inventory-qll',path:'offset 1, limit 80, reload=true'})}}]}
          : phase === 'reference' && toolReplies.length < 2
          ? {tool_calls:[{index:0,id:'ref-'+toolReplies.length,type:'function',function:{name:'gea_skill',arguments:JSON.stringify({name:skillName,...(toolReplies.length===1?{path:'references/metric-definitions.md'}:{})})}}]}
          : phase === "skill" && toolReplies.length === 0
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "skill",
                  type: "function",
                  function: {
                    name: "gea_skill",
                    arguments: JSON.stringify({ name: skillName }),
                  },
                },
              ],
            }
          : phase === "forbidden" && toolReplies.length === 0
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "denied",
                    type: "function",
                    function: { name: "gea_forecast_compute", arguments: "{}" },
                  },
                ],
              }
            : phase === "expand" && toolReplies.length === 0
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: "expand",
                      type: "function",
                      function: {
                        name: "gea_capabilities",
                        arguments: JSON.stringify({ pack: "knowledge" }),
                      },
                    },
                  ],
                }
              : { content: "已经核对当前可用能力。" };
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
    });
    await app.login();
    const ask = async (preset, question = "看下本月提报情况。") => {
      const made = await app.remote("session/create", {
        cwd: app.runtime + "/workspace",
        agentPreset: preset,
      });
      assert.equal(made.ok, true, JSON.stringify(made));
      const id = made.value.sessionId;
      await app.remote("session/selectModel", {
        sessionId: id,
        provider: "gea-analysis",
        model: "fixture",
      });
      await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId: id,
        mode: "queue",
        content: [{ type: "text", text: question }],
      });
      return until(
        () => readSession(app.runtime, id),
        (rows) => rows.some((x) => x.type === "turn/end"),
      );
    };
    const rows = await ask("gea-readonly");
    assert.equal(
      rows.find((x) => x.type === "turn/end").data.reason.kind,
      "completed",
      JSON.stringify(rows).slice(-2000),
    );
    assert.equal(requests.length, 2);
    const first = requests[0],
      second = requests[1];
    const names = (body) => body.tools?.map((x) => x.function.name) ?? [];
    assert.ok(names(first).includes("gea_cube_query"));
    assert.ok(!names(first).includes("page_reference_read"));
    assert.ok(names(first).includes("gea_sales_plan_read"));
    assert.ok(!names(first).includes("gea_module_mcp"));
    assert.ok(names(second).includes("gea_module_mcp"));
    assert.ok(names(second).includes("gea_cube_query"));
    assert.ok(!names(first).some((x) => x.startsWith("mcp__gea-gateway__")));
    const system = first.messages
      .filter((x) => x.role === "system")
      .map((x) => x.content)
      .join("\n");
    await mkdir(".runtime/prompt-acceptance", { recursive: true });
    await writeFile(".runtime/prompt-acceptance/sales-system.txt", system);
    assert.doesNotMatch(
      system,
      /HMR receiver|默认就该出 UI|全程只读|本轮工具返回的结果才是证据/,
    );
    assert.match(system, /Asia\/Shanghai/);
    const size = system.length + JSON.stringify(first.tools).length;
    assert.ok(
      size <= 12000,
      `first prompt ${size} chars; system ${system.length}; tools ${JSON.stringify(first.tools).length}`,
    );
    const metrics = [
      {
        preset: "gea-readonly",
        system: system.length,
        tools: JSON.stringify(first.tools).length,
        total: size,
        names: names(first),
      },
    ];
    for (const [id] of pageProfiles) {
      phase = "skill";
      skillName = id;
      const start = requests.length;
      const log = await ask("gea-html-" + id);
      assert.equal(
        log.find((x) => x.type === "turn/end").data.reason.kind,
        "completed",
        id + JSON.stringify(log).slice(-1800),
      );
      const initial = requests[start];
      const body = initial.messages
        .filter((x) => x.role === "system")
        .map((x) => x.content)
        .join("\n");
      assert.doesNotMatch(
        body,
        /OLD_PAGE_RULE|HMR receiver|默认就该出 UI|implementation checkout/,
      );
      assert.ok(body.length <= 2200, id + " system " + body.length);
      const total = body.length + JSON.stringify(initial.tools).length;
      assert.ok(total <= 12000, id + " total " + total);
      const result = log.filter((x) => x.type === "tool/result");
      assert.ok(result.length);
      assert.doesNotMatch(
        JSON.stringify(result),
        /GEA_SKILL_UNAVAILABLE|GEA_SKILL_NOT_LOADED|OLD_PAGE_RULE/,
      );
      metrics.push({
        preset: "gea-html-" + id,
        system: body.length,
        tools: JSON.stringify(initial.tools).length,
        total,
        names: names(initial),
      });
    }
    phase = 'inventory-recovery';
    const recoveryStart = requests.length;
    const recovered = await ask('gea-html-inventory-qll', '基地到分仓的库存怎么走？');
    assert.equal(recovered.find(row => row.type === 'turn/end').data.reason.kind, 'completed');
    const recoveryReplies = JSON.stringify(recovered.filter(row => row.type === 'tool/result'));
    assert.doesNotMatch(recoveryReplies, /GEA_SKILL_REFERENCE_NOT_LINKED/);
    assert.match(recoveryReplies, /argumentCorrection/);
    assert.match(recoveryReplies, /静态库存快照只能证明分布/);
    assert.equal(requests.length - recoveryStart, 2, 'one recovered tool call then a final response');
    const recoverySystem = requests[recoveryStart].messages.filter(row => row.role === 'system').map(row => row.content).join('\n');
    assert.match(recoverySystem, /默认先解释一般流转过程/);
    for (const name of ['sales-forecast-result-analysis','sales-ops-problem-analysis']) {
      phase='reference'; skillName=name;
      const log=await ask('gea-html-inventory-apsplan');
      const replies=JSON.stringify(log.filter(e=>e.type==='tool/result'));
      assert.doesNotMatch(replies,/GEA_SKILL_UNAVAILABLE|GEA_SKILL_NOT_LOADED|REFERENCE_NOT_LINKED/);
      assert.match(replies,/age_days/);
      assert.match(replies,/50%/);
      assert.equal(log.filter(e=>e.type==='tool/result').length,2);
    }
    await writeFile(
      ".runtime/prompt-acceptance/metrics.json",
      JSON.stringify(metrics, null, 2),
    );
    phase = "forbidden";
    const forbidden = await ask("gea-readonly");
    assert.match(
      JSON.stringify(forbidden),
      /UNKNOWN_TOOL|not found|not available|未注册/,
    );
    phase = "coding";
    await ask("auto-negotiation");
    assert.ok(
      names(requests.at(-1)).some((x) => /bash|shell|read_file/.test(x)),
      "coding capabilities remain intact",
    );
  },
);

test("protected evidence restores after restart only with current authorization", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gea-evidence-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = new PromptEvidenceStore(dir);
  const grant = {
    owner: "user-a",
    consumer: "stock",
    resourceTool: "query_business_data",
    resources: "v1",
  };
  const id = await first.put(
    "s",
    "gea_cube_query",
    "original business data",
    first.epoch(),
    grant,
  );
  const restored = new PromptEvidenceStore(dir);
  let resourceVersion = "v1";
  const authorize = async (saved) => {
    assert.equal(saved.owner, "user-a");
    if (saved.resources !== resourceVersion)
      throw Error("AUTHORIZATION_CHANGED");
  };
  assert.equal(
    (await restored.read("s", id, 0, 4000, authorize)).content,
    "original business data",
  );
  await assert.rejects(
    restored.read("another-session", id, 0, 4000, authorize),
    /UNAVAILABLE/,
  );
  resourceVersion = "revoked";
  await assert.rejects(
    restored.read("s", id, 0, 4000, authorize),
    /AUTHORIZATION_CHANGED/,
  );
});

test("instruction reuse requires the exact body still on the model-visible surface", () => {
  const content = "mandatory domain rule",
    instructionId = "version-range-key";
  const message = {
    source: { kind: "tool" },
    content: [
      {
        type: "tool-result",
        content: [
          { type: "text", text: JSON.stringify({ instructionId, content }) },
        ],
      },
    ],
  };
  assert.equal(instructionVisible([message], instructionId, content), true);
  assert.equal(
    instructionVisible(
      [{ ...message, source: { kind: "user" } }],
      instructionId,
      content,
    ),
    false,
  );
  assert.equal(
    instructionVisible(
      [
        {
          source: { kind: "tool" },
          content: [
            {
              type: "text",
              text: JSON.stringify({ instructionId, alreadyLoaded: true }),
            },
          ],
        },
      ],
      instructionId,
      content,
    ),
    false,
  );
  assert.equal(
    instructionVisible([], instructionId, content),
    false,
    "compaction removed the body: reload it",
  );
  assert.equal(instructionVisible([message], "new-version", content), false);
});

test("capability cancellation, catalog and native restriction failures commit no state", async (t) => {
  const registered = new Map(),
    masks = new Set(),
    effects = [];
  const names = [
    "gea_capabilities",
    "gea_skill",
    "gea_evidence_read",
    "gea_gateway_catalog",
    "gea_cube_query",
    "gea_sales_plan_read",
    "gea_forecast_compute",
    "render_ui",
    "validate_dsh_ui",
  ];
  let list = async () => [],
    failMask = false,
    revision = 1;
  const toolService = {
    register(tool) {
      registered.set(tool.name, tool);
      return () => {};
    },
    guard() {
      return () => {};
    },
    restrict({ allow }) {
      if (!allow) throw Error("known global tools: " + names.join(","));
      if (failMask) throw Error("restriction fixture failure");
      const mask = new Set(allow);
      masks.add(mask);
      return () => masks.delete(mask);
    },
    schemas(scope) {return names.filter(name=>scope===undefined || [...masks].every(mask=>mask.has(name))).map(name=>({name}));},
    get(name,scope) {return this.schemas(scope).find(tool=>tool.name===name);},
  };
  const ctx = {
    tools: toolService,
    sessionProjections: { stateOf: () => "gea-readonly" },
    skills: { list: (...args) => list(...args) },
    on: () => () => {},
    inject: () => {},
  };
  const business = {
    config: { runtimeDir: tmpdir() },
    watchIdentity: () => () => {},
    readTurnRevision: () => revision,
    turnStopKind: () => undefined,
    surfaceFor: () => undefined,
  };
  t.after(
    mountBusinessPrompts(ctx, business, { readModules: () => [] }, new Map()),
  );
  const agent = {
    id: "fixture",
    ctx: { tools: toolService, effect: (fn) => effects.push(fn()) },
    session: { header: { cwd: tmpdir() }, snapshotEvents: () => [] },
  };
  const readEvidence = (args) =>
    registered
      .get("gea_evidence_read")
      .execute(args, { agent, signal: new AbortController().signal });
  await assert.rejects(
    readEvidence({ evidenceId: "fixture", rowOffset: 30, rowLimit: 30 }),
    /GEA_EVIDENCE_READ_MODE/,
  );
  await assert.rejects(
    readEvidence({ evidenceId: "fixture", dataset: "a", offset: 30 }),
    /GEA_EVIDENCE_READ_MODE/,
  );
  await assert.rejects(
    readEvidence({ evidenceId: "fixture", dataset: "a", datasetId: "b" }),
    /GEA_EVIDENCE_ARGUMENT/,
  );
  await assert.rejects(
    readEvidence({ evidenceId: "fixture", dataset: "a", page: 2 }),
    /GEA_EVIDENCE_ARGUMENT/,
  );
  const execute = (args, signal = new AbortController().signal) =>
    registered
      .get("gea_capabilities")
      .execute(args, { agent, signal })
      .then(JSON.parse);
  assert.deepEqual((await execute({ pack: "forecast" })).loaded, ["forecast"]);
  let release;
  list = () => new Promise((resolve) => (release = resolve));
  const controller = new AbortController();
  const pending = execute({ pack: "ui", complex: true }, controller.signal);
  controller.abort();
  release([]);
  await assert.rejects(pending, /abort/i);
  list = async () => {
    throw Error("catalog fixture failure");
  };
  await assert.rejects(
    execute({ pack: "ui", complex: true }),
    /catalog fixture/,
  );
  list = async () => [];
  failMask = true;
  await assert.rejects(
    execute({ pack: "ui", complex: true }),
    /restriction fixture/,
  );
  failMask = false;
  const state = await execute({});
  assert.deepEqual(state.loaded, ["forecast"]);
  assert.equal(state.callLimit, 20);
  assert.ok(!state.tools.includes("render_ui"));
  assert.equal(masks.size, 1);
  await execute({ pack: "ui" });
  assert.equal(masks.size, 1);
  for (const cleanup of effects) cleanup();
  assert.equal(masks.size, 0);
});

test("forecast never silently treats an unsafe JSON integer as exact", () => {
  const input = forecastInput();
  input.records[0].base_plan_qty = Number("9007199254740993");
  assert.equal(computeForecast(input).rows[0].status, "blocked");
  input.records[0].base_plan_qty = "9007199254740993";
  assert.notEqual(computeForecast(input).rows[0].status, "blocked");
});

test("forecast tool schema accepts missing data but continues to reject numeric decimal inputs", async () => {
  for (const field of [
    "base_plan_qty",
    "base_actual_to_cutoff_qty",
    "prior_base_actual_qty",
    "prior_target_actual_qty",
    "eligible",
    "seasonal",
    "target_yoy_growth",
    "target_mom_growth",
  ]) {
    const data = forecastInput();
    data.records.push({ ...data.records[0], sku_id: "valid" });
    data.records[0][field] = null;
    const result = JSON.parse(await forecastTool.execute(data, {}));
    assert.equal(result.coverage.calculated, 1, field);
    assert.notEqual(result.rows[0].status, "calculated", field);
    assert.equal(result.rows[0].final_forecast, null, field);
  }
  for (const numeric of [0.1, Number("9007199254740993")]) {
    const data = forecastInput();
    data.records[0].base_plan_qty = numeric;
    await assert.rejects(forecastTool.execute(data, {}), /invalid arguments/);
  }
});

test("computation provenance requires exact complete JSON in a genuine user message", () => {
  const data = forecastInput(),
    digest = forecastInputHash(data);
  const message = (kind, text) => ({
    source: { kind },
    content: [{ type: "text", text }],
  });
  const pretty = "Input:\n```json\n" + JSON.stringify(data, null, 2) + "\n```";
  assert.equal(hasUserForecastInput([message("user", pretty)], digest), true);
  for (const kind of ["tool", "plugin", "assistant"])
    assert.equal(hasUserForecastInput([message(kind, pretty)], digest), false);
  assert.equal(
    hasUserForecastInput([message("user", "data_mode=provided")], digest),
    false,
  );
  assert.equal(
    hasUserForecastInput(
      [message("user", pretty)],
      forecastInputHash({ ...data, snapshot_at: "changed" }),
    ),
    false,
  );
  const live = { ...data, data_mode: "live" };
  assert.equal(
    hasUserForecastInput(
      [message("user", JSON.stringify(live))],
      forecastInputHash(live),
    ),
    false,
  );
  const reordered = Object.fromEntries(Object.entries(data).reverse());
  assert.equal(forecastInputHash(reordered), digest);
});

test("business UI rejects sign-based colours and unverified automatic totals", () => {
  for (const cell of [" +10", "\t−10", " -.5", "+.2", "\n+  10"])
    assert.match(
      businessUiIssue({
        spec: { items: [{ type: "table", columns: ["差额"], rows: [[cell]] }] },
      }),
      /SEMANTICS/,
    );
  for (const type of ["hero", "stat"])
    assert.match(
      businessUiIssue({ spec: { items: [{ type, delta: "−10" }] } }),
      /SEMANTICS/,
    );
  assert.equal(
    businessUiIssue({
      spec: {
        items: [
          { type: "table", columns: ["差额"], rows: [[-10], ["少于计划 10"]] },
        ],
      },
    }),
    undefined,
  );
  assert.match(
    businessUiIssue({
      items: [{ type: "stat", label: "计划差额", value: "100", delta: "+100" }],
    }),
    /SEMANTICS/,
  );
  assert.match(
    businessUiIssue({
      spec: JSON.stringify({
        items: [{ type: "table", columns: ["金额"], rows: [[1]], total: true }],
      }),
    }),
    /SEMANTICS/,
  );
  assert.match(
    businessUiIssue({
      items: [{ type: "table", columns: ["差额"], rows: [["+100"]] }],
    }),
    /SEMANTICS/,
  );
  assert.equal(
    businessUiIssue({
      items: [{ type: "table", columns: ["差额"], rows: [["超计划 100"]] }],
    }),
    undefined,
  );
});

test("decimal calculator matches the unchanged suite reference across fourteen scenario groups", async () => {
  const reference = JSON.parse(
    await readFile(
      new URL("./fixtures/forecast-v2-reference.json", import.meta.url),
      "utf8",
    ),
  );
  for (const fixture of reference.cases) {
    const actual = computeForecast(fixture.input);
    assert.deepEqual(actual.coverage, fixture.expected.coverage, fixture.name);
    for (let i = 0; i < actual.rows.length; i++) {
      const row = actual.rows[i],
        expected = fixture.expected.rows[i];
      assert.equal(row.status, expected.status, fixture.name);
      for (const key of [
        "forecast1",
        "forecast2",
        "recommended_baseline",
        "final_forecast",
        "amount",
      ]) {
        if (expected[key] === null)
          assert.equal(row[key], null, fixture.name + " " + key);
        else
          assert.ok(
            Math.abs(Number(row[key]) - expected[key]) <=
              Math.max(1, Math.abs(expected[key])) * 1e-12,
            fixture.name + " " + key,
          );
      }
    }
    assert.equal(actual.source_verified_by_calculator, false);
    assert.equal(actual.external_writes, false);
  }
});

test("one evidence grant never includes another consumer historical receipt", () => {
  const previous = {
    source: "GEA_CUBE_BATCH",
    consumerCode: "B",
    results: [
      {
        result: JSON.stringify({
          source: "GEA_MODULE_MCP",
          value: 2,
          availableEvidence: [{ consumerCode: "A", secret: "A-private" }],
        }),
      },
    ],
    availableEvidence: [{ consumerCode: "A", secret: "A-private" }],
  };
  const cleaned = withoutHistoricalEvidence(JSON.stringify(previous));
  assert.doesNotMatch(cleaned, /A-private|availableEvidence/);
  assert.match(cleaned, /B/);
  const business =
    '{"source":"GEA_CUBE_BATCH","rows":[{"availableEvidence":"actual business column"}]}';
  assert.equal(withoutHistoricalEvidence(business), business);
});

test("large top-level data and reserved metadata fields remain represented in the preview", () => {
  const original = {
    data: [
      { sku: "one", qty: "12.3400" },
      { sku: "two", qty: "0" },
    ],
    meta: "x".repeat(9000),
  };
  const projected = JSON.parse(
    projectEvidence(JSON.stringify(original), "ev-id"),
  );
  assert.equal(projected.projection, "partial");
  assert.deepEqual(projected.data.data, original.data);
  assert.ok(projected.omittedPaths.includes("$.meta"));
  assert.ok(!projected.omittedPaths.includes("$.data"));
});

test("late catalog replies cannot undo query recovery or leak into a new turn or preset", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gea-catalog-generation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handlers = new Map(),
    masks = new Set();
  const names = [
    "gea_capabilities",
    "gea_skill",
    "gea_evidence_read",
    "gea_gateway_catalog",
    "gea_cube_query",
    "gea_sales_plan_read",
  ];
  let preset = "gea-readonly",
    revision = 1,
    identityChanged,
    guard;
  const toolService = {
    register: () => () => {},
    guard: (fn) => {
      guard = fn;
      return () => {};
    },
    restrict({ allow }) {
      if (!allow) throw Error("known global tools: " + names.join(","));
      const mask = new Set(allow);
      masks.add(mask);
      return () => masks.delete(mask);
    },
    schemas: scope => names.filter(n=>scope===undefined || [...masks].every(m=>m.has(n))).map(name=>({name})),
    get: (name,scope) => (scope===undefined || [...masks].every(m=>m.has(name))) && names.includes(name) ? {name} : undefined,
  };
  const agent = {
    id: "fixture",
    ctx: { tools: toolService, effect: (fn) => fn() },
    session: {
      header: { cwd: dir },
      snapshotEvents: () => [],
      deriveMessages: () => [],
    },
  };
  const ctx = {
    tools: toolService,
    agents: { get: () => agent },
    sessionProjections: { stateOf: () => preset },
    skills: { list: async () => [] },
    on: (event, fn) => {
      handlers.set(event, fn);
      return () => {};
    },
    inject: () => {},
  };
  const business = {
    config: { runtimeDir: dir, analysisAgentCode: "sales_forecast" },
    status: () => ({ source: "fixture", user: { id: "one" } }),
    turnStopKind: () => undefined,
    watchIdentity: (fn) => {
      identityChanged = fn;
      return () => {};
    },
    readTurnRevision: () => revision,
    surfaceFor: () => undefined,
  };
  t.after(
    mountBusinessPrompts(ctx, business, { readModules: () => [] }, new Map()),
  );
  const start = async (name = "gea_gateway_catalog") => {
    const exec = {
      name,
      token: Symbol(),
      agent,
      arguments: {},
      signal: new AbortController().signal,
    };
    await handlers.get("tools/execute")(exec, async () => {});
    return exec;
  };
  const finish = (exec) =>
    handlers.get("tools/post-execute")(
      exec,
      { content: [{ type: "text", text: '{"source":"GEA_CATALOG_REUSED"}' }] },
      async () => ({ kind: "accept" }),
    );
  const visible = async () => {
    await handlers.get("agent/pre-step")({ agent }, async () => ({
      kind: "accept",
      messages: [],
    }));
    return toolService.schemas(agent).map((x) => x.name);
  };
  for (const transition of ["query", "turn", "preset", "identity"]) {
    const old1 = await start(),
      old2 = await start();
    if (transition === "query") await start("gea_cube_query");
    if (transition === "turn") {
      revision++;
      handlers.get("session/event")({ id: agent.id }, { type: "turn/start" });
    }
    if (transition === "preset") preset = "gea-html-inventory-aqkc";
    if (transition === "identity") identityChanged();
    await finish(old1);
    await finish(old2);
    assert.ok((await visible()).includes("gea_gateway_catalog"), transition);
    assert.equal(guard({name:"gea_gateway_catalog",agent,arguments:{}}), undefined, transition+" ignores stale replies");
    await finish(await start());
    await finish(await start());
    const paused = await visible();
    assert.match(
      guard({name:"gea_gateway_catalog",agent,arguments:{}}),
      /GEA_CATALOG_NO_PROGRESS/,
      transition + " current duplicate replies should pause",
    );
    assert.ok(
      paused.includes("gea_cube_query"),
      "actual query remains callable",
    );
    await start("gea_cube_query");
    assert.ok((await visible()).includes("gea_gateway_catalog"));
    assert.equal(
      guard({ name: "gea_gateway_catalog", agent, arguments: {} }),
      undefined,
    );
  }
  handlers.get('session/event')({id:agent.id},{type:'turn/start'});
  for(let i=0;i<20;i++) assert.equal(guard({name:'gea_cube_query',agent,arguments:{}}),undefined);
  assert.match(guard({name:'gea_cube_query',agent,arguments:{}}),/GEA_CALL_BUDGET/);
  for(let i=0;i<12;i++) assert.equal(guard({name:'gea_evidence_read',agent,arguments:{}}),undefined,'already acquired evidence retains a bounded read allowance');
  assert.match(guard({name:'gea_evidence_read',agent,arguments:{}}),/GEA_EVIDENCE_BUDGET/);
  for(const name of ['gea_cube_query','gea_capabilities','gea_gateway_catalog'])
    assert.match(guard({name,agent,arguments:{}}),/GEA_EVIDENCE_BUDGET/,'read exhaustion cannot be bypassed via '+name);
  handlers.get('session/event')({id:agent.id},{type:'turn/start'});
  assert.equal(guard({name:'gea_evidence_read',agent,arguments:{}}),undefined);
});
