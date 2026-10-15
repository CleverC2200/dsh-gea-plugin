import { fixtureCubeTools, fixtureCubeDiscovery } from "./fixtures/cube-wire.mjs";
import { writeHtmlDeclarations } from "./fixtures/html-resource.mjs";
import { fixtureWorkbench } from "./fixtures/workbench-profile.mjs";
import { selectBusinessResource } from "./fixtures/business-session.mjs";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readSession, until } from "./profile.mjs";
import { modelProfile as profile } from "./fixtures/model-profile.mjs";
import { transportSignal } from "../src/shared/transport-signal.ts";
import { networkError } from "../src/shared/net-error.ts";
import {
  resultView,
  transientResult,
  permissionDenied,
  resultOutcome,
  resultReceipt,
  datasetIndex,
  indexProjection,
  readDataset,
  compactDatasetProjection,
} from "../src/host/prompt-result.ts";
import { projectEvidence } from "../src/host/prompt-evidence.ts";
import { sessionConsumer, toolConsumer } from "../src/host/business-identity.ts";

test("timeout keeps its category while arbitrary caller reasons stay private", () => {
  const c = new AbortController(),
    t = transportSignal(c.signal);
  c.abort(new DOMException("private-detail", "TimeoutError"));
  const error = networkError(t.signal.reason, {
    what: "model",
    timeoutMs: 120000,
  });
  assert.match(error.message, /超时/);
  assert.doesNotMatch(error.message, /private-detail/);
  t.dispose();
  const other = new AbortController(),
    safe = transportSignal(other.signal);
  other.abort({ secret: "private-token" });
  assert.equal(safe.signal.reason.name, "AbortError");
  assert.doesNotMatch(String(safe.signal.reason), /private-token/);
  safe.dispose();
});
test("trusted business identity wins over a mismatched page; generic model routing uses its default", () => {
  let preset = "gea-html-inventory-fc";
  const ctx = {
    agents: { get: () => ({ session: {} }) },
    sessionProjections: { stateOf: () => preset },
  };
  const business = {
    config: { analysisAgentCode: "sales" },
    currentPageIdentity: () => ({
      consumerCode: "base-safety-stock",
      mock: false,
    }),
  };
  assert.equal(sessionConsumer(ctx, business, "id"), "branch-inventory");
  preset = "gea-readonly";
  assert.equal(sessionConsumer(ctx, business, "id"), "sales");
  preset = "auto-negotiation";
  assert.equal(sessionConsumer(ctx, business, "id"), "sales");
});
test("artifact presentation decodes rows without modifying JSON business columns or completeness", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    sku: String(i),
    qty: "9007199254740993",
    jsonColumn: '{"content":"leave unchanged"}',
  }));
  const raw = JSON.stringify({
    queryArtifact: {
      hydrated: true,
      resources: [
        {
          pageCount: 1,
          contents: [
            {
              text: JSON.stringify({
                datasetName: "inventory",
                complete: false,
                totalRows: 100,
                rows,
              }),
            },
          ],
        },
      ],
    },
  });
  const view = resultView(raw);
  assert.equal(view.queryArtifact.pages[0].displayTable.values.length, 25);
  assert.equal(view.queryArtifact.pages[0].complete, false);
  assert.equal(
    view.queryArtifact.pages[0].displayTable.values[0][
      view.queryArtifact.pages[0].displayTable.columns.indexOf("jsonColumn")
    ],
    rows[0].jsonColumn,
  );
  const projection = JSON.parse(projectEvidence(raw + " ".repeat(7000), "ev-test", 6000, view));
  assert.equal(projection.projection, "complete");
  assert.equal(projection.data.queryArtifact.pages[0].complete, false);
});
test("unproven knowledge is bounded and never advertises a reusable local artifact", () => {
  const result = transientResult("\u0000".repeat(20000));
  assert.ok(result.length <= 6000);
  const parsed = JSON.parse(result);
  assert.equal(parsed.rawAvailable, false);
  assert.equal(parsed.projection, "partial");
  assert.equal(parsed.evidenceId, undefined);
  assert.equal(parsed.nextRead, undefined);
});

test(
  "all six unbound business presets send the matching model identity",
  { timeout: 90000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "gea-v2-identities-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const configs = [
      ["apsplan", "aps"],
      ["qll", "full-chain-inventory"],
      ["aqkc", "base-safety-stock"],
      ["fc", "branch-inventory"],
      ["dealer", "dealer-inventory-replenishment"],
    ];
    const roots = {};
    for (const [suffix, consumerCode] of configs) {
      const id = "inventory-" + suffix,
        path = join(dir, id);
      roots[id] = path;
      await mkdir(path);
      await writeFile(join(path, "index.html"), "<html>fixture</html>");
      await writeFile(
        join(path, "SKILL.md"),
        "---\nname: " + id + "\ndescription: fixture\n---\nfixture",
      );
      await writeFile(
        join(path, "plugin.json"),
        JSON.stringify({
          schemaVersion: 1,
          id,
          name: id,
          version: "0.0.0",
          html: "index.html",
          skills: ["SKILL.md"],
          mcp: "mcp.json",
          declarations: { page: "page.json", capability: "capability.json" },
          agentResources: { provider: "dsh-agent-manage", prompt: "prompt.json" },
          gea: { consumerCode, readonly: true, contract: "gea-html-v2" },
        }),
      );
      await writeFile(
        join(path, "mcp.json"),
        JSON.stringify({
          provider: "gea",
          transport: "host-provided",
          contract: "gea-html-v2",
          consumer: { consumerType: "AGENT", consumerCode },
          capabilities: ["governed-sql-read"],
        }),
      );
      await writeHtmlDeclarations(path, {
        page: {
          surface: `gea-html-${id}`,
          protocol: "self-report",
          pageIds: [id],
          consumerCode: consumerCode,
          maxEffect: "view",
        },
        capability: {
          id: id,
          label: id,
          data: { consumerCode: consumerCode, tables: [], rules: [] },
          maxEffect: "view",
          layers: ["read"],
          skills: [id],
          routing: { keywords: [id], summary: id },
        },
        prompt: {
          label: id,
          consumerCode: consumerCode,
          persona: "只读测试页面，保留用户会话与权限边界。",
          skills: [id],
        },
      });
    }
    const app = await profile(t, {
      beforeStart: fixtureWorkbench(Object.values(roots)),
      config: {
        cubeMcpCodes: { production: "cube", test: "cube" },
        analysis: {
          mode: "model",
          source: "gea",
          agentCode: "sales_forecast",
          model: "fixture-model",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      },
      env: { GEA_HTML_PLUGIN_ROOTS: JSON.stringify(roots) },
    });
    const seen = [];
    app.route((req, res, reply) => {
      const p = req.url.pathname;
      if (fixtureCubeDiscovery(req, res, reply)) return true;
      if (p.endsWith("/user-agent-credential/my/list")) {
        reply({
          success: true,
          result: { records: [{ id: "fixture", status: "ACTIVE" }], total: 1 },
        });
        return true;
      }
      if (p.endsWith("/user-agent-credential/my/claim")) {
        reply({
          success: true,
          result: {
            credentialId: "fixture",
            status: "ACTIVE",
            baseUrl: app.base + "/personal",
            secret: "fixture-secret",
          },
        });
        return true;
      }
      if (p.endsWith("/airagModel/queryById")) {
        reply({
          success: true,
          result: { id: "fixture-model", name: "fixture" },
        });
        return true;
      }
      if (p === "/personal/models") {
        reply({ data: [{ id: "fixture-model" }] });
        return true;
      }
      if (p !== "/personal/chat/completions") return false;
      seen.push(req.headers["x-gea-agent-code"]);
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: "fixture done" },
                finish_reason: "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return true;
    });
    await app.login();
    assert.equal((await app.rpc("model/discover")).ok, true);
    for (const [preset, consumer] of [
      ["gea-readonly", "sales_forecast"],
      ...configs.map(([s, c]) => ["gea-html-inventory-" + s, c]),
    ]) {
      await selectBusinessResource(app, preset);
      const made = await app.remote("session/create", {
        cwd: app.runtime + "/workspace",
        agentPreset: preset,
      });
      assert.equal(made.ok, true);
      const sessionId = made.value.sessionId;
      await app.remote("session/selectModel", {
        sessionId,
        provider: "gea-analysis",
        model: "fixture-model",
      });
      await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId,
        mode: "queue",
        content: [{ type: "text", text: "查询当前业务范围" }],
      });
      await until(
        () => readSession(app.runtime, sessionId),
        (r) => r.some((e) => e.type === "turn/end"),
      );
      assert.equal(
        seen.at(-1),
        consumer,
        JSON.stringify({
          preset,
          seen,
          events: await readSession(app.runtime, sessionId),
        }),
      );
    }
  },
);

test(
  "catalog stalls block backend repetition while native query results retain every returned row",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        cubeMcpCodes: { production: "cube", test: "cube" },
        analysis: {
          mode: "model",
          baseUrl: base + "/v1",
          model: "fixture",
          apiKeyEnv: "V2_TEST_MODEL_KEY",
          agentCode: "sales_forecast",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: { V2_TEST_MODEL_KEY: "fixture" },
    });
    const datasets = ["a", "b"].map((name) => ({
      name,
      rowCount: 70,
      dataStatus: "partial",
      totalRowCount: 70,
      offset: 0,
      hasMorePages: false,
      fields: [{ name: name + ".quantity" }, { name: name + ".label" }],
      rows: Array.from({ length: 70 }, (_, index) => ({
        [name + ".id"]: String(index),
        [name + ".quantity"]: "9007199254740993",
        [name + ".label"]: "业务数据".repeat(40),
      })),
      tail: "END_" + name,
    }));
    const requests = [],
      calls = [];
    const args = {
      action: "query",
      queries: ["a", "b"].map((name) => ({
        name,
        query: { measures: [name + ".row_count"], limit: 100 },
      })),
    };
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path.endsWith("/ai/gateway/mcp/proxy/mcp")) {
        const wire = JSON.parse(req.body);
        if (wire.method === "notifications/initialized") {
          res.statusCode = 202;
          res.end();
          return true;
        }
        let result = {};
        if (wire.method === "initialize") result = { protocolVersion: wire.params.protocolVersion };
        else if (wire.method === "tools/list") result = { tools: fixtureCubeTools };
        else if (wire.method === "tools/call") {
          calls.push(wire.params);
          result = {
            structuredContent:
              wire.params.name === "inspect_cube_model"
                ? {
                    semanticModel: ["a", "b"].map((name) => ({
                      name,
                      measures: [{ name: name + ".row_count", type: "number" }],
                    })),
                  }
                : {
                    action: "query",
                    status: "completed",
                    executedQueryCount: 2,
                    datasets,
                  },
          };
        }
        reply({ jsonrpc: "2.0", id: wire.id, result });
        return true;
      }
      if (path !== "/v1/chat/completions") return false;
      const body = JSON.parse(req.body);
      requests.push(body);
      const step = requests.length;
      let call;
      if (step <= 4)
        call = {
          name: "mcp__gea-gateway__inspect_cube_model",
          arguments: JSON.stringify({ keyword: "a" }),
        };
      else if (step === 5) {
        assert.match(
          body.messages.filter((message) => message.role === "tool").at(-1).content,
          /GEA_CATALOG_NO_PROGRESS/,
        );
        call = {
          name: "mcp__gea-gateway__query_business_data",
          arguments: JSON.stringify(args),
        };
      } else {
        const value = JSON.parse(
          body.messages.filter((message) => message.role === "tool").at(-1).content,
        );
        assert.deepEqual(value.datasets, datasets);
        assert.equal(
          value.evidenceId,
          undefined,
          "direct results are already delivered through their native tool",
        );
      }
      const delta = call
        ? {
            tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: call }],
          }
        : { content: "返回两份各70行样本，源数据状态为partial。" };
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return true;
    });
    await app.login();
    const selected = await selectBusinessResource(app, "gea-readonly");
    const made = await app.remote("session/create", {
      cwd: app.runtime + "/workspace",
      agentPreset: selected.preset,
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
      content: [
        {
          type: "text",
          text: "按已发布成员读取a和b样本，不能把partial当全量。",
        },
      ],
    });
    await until(
      () => readSession(app.runtime, id),
      (rows) => rows.some((row) => row.type === "turn/end"),
      30000,
    );
    assert.equal(calls.filter((call) => call.name === "inspect_cube_model").length, 3);
    const sent = calls.filter((call) => call.name === "query_business_data");
    assert.equal(sent.length, 1, "caller-owned named queries stay in one native dispatch");
    assert.deepEqual(sent[0].arguments, args);
    assert.equal(requests.length, 6);
    assert.ok(
      requests.every((request) =>
        request.tools.some((tool) => tool.function.name === "mcp__gea-gateway__inspect_cube_model"),
      ),
    );
  },
);

test("permission and partial delivery are not ordinary successful receipts", () => {
  const denial = "模块数据未授权：fixture";
  assert.equal(permissionDenied(denial), true);
  assert.equal(resultOutcome(denial), "blocked");
  assert.equal(
    JSON.parse(resultReceipt("mcp__gea-gateway__query_business_data", {}, "ev", denial)).outcome,
    "blocked",
  );
  const raw = {
    source: "GEA_MCP_CONTENT",
    payloads: ['{"rows":[{"qty":"1"}]}'],
    presentation: "first resource succeeded; second failed",
    delivery: {
      sourceReadComplete: false,
      unreadArtifacts: [{ uri: "data-artifact://missing", reason: "read-failed" }],
      notes: ["partial coverage"],
    },
  };
  const view = resultView(raw);
  assert.equal(view.delivery.sourceReadComplete, false);
  assert.equal(view.delivery.unreadArtifacts.length, 1);
  assert.equal(resultOutcome(JSON.stringify(raw)), "partial");
  assert.equal(resultOutcome(JSON.stringify({ ...raw, payloads: [] })), "blocked");
  assert.equal(
    resultOutcome(
      JSON.stringify({
        source: "GEA_CUBE_BATCH",
        results: [{ status: "returned", result: JSON.stringify(raw) }],
      }),
    ),
    "partial",
  );
});

test("structured evidence paginates actual rows, preserves coverage and never parses JSON columns", () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({
    id: String(i),
    qty: "9007199254740993",
    note: '{"datasetName":"do-not-parse","rows":[]}',
  }));
  const raw = JSON.stringify({
    source: "GEA_MCP_CONTENT",
    delivery: {
      sourceReadComplete: false,
      unreadArtifacts: [{ uri: "data-artifact://not-read" }],
    },
    payloads: [
      JSON.stringify({
        queryArtifact: {
          resources: [
            {
              contents: [
                {
                  text: JSON.stringify({
                    datasetName: "stock",
                    rows,
                    complete: false,
                    totalRows: 200,
                  }),
                },
              ],
            },
          ],
        },
      }),
    ],
  });
  const index = datasetIndex(raw, "ev-id");
  assert.equal(index.length, 1);
  assert.equal(index[0].availableRows, 80);
  assert.equal(index[0].nextRead.args.dataset, index[0].key);
  let offset = 0;
  const restored = [];
  do {
    const page = readDataset(raw, "ev-id", "stock", offset, 30);
    assert.equal(page.sourceOutcome, "partial");
    assert.equal(page.sourceCoverage[0].complete, false);
    assert.ok(JSON.stringify(page).length <= 5400);
    const table = page.table.displayTable;
    if (table)
      restored.push(
        ...table.values.map((row) => Object.fromEntries(table.columns.map((k, i) => [k, row[i]]))),
      );
    else restored.push(...page.table.rows);
    offset = page.nextRead?.args.rowOffset ?? null;
  } while (offset !== null);
  assert.deepEqual(restored, rows);
  assert.throws(() => readDataset(raw, "ev-id", "invented"), /UNAVAILABLE/);
  assert.throws(() => readDataset(raw, "ev-id", "stock", 0, 101), /ROW_RANGE/);
});
test("explicit cross-domain calls require trusted profile routes", () => {
  let preset = "gea-html-inventory-fc";
  const ctx = {
    agents: { get: () => ({ session: {} }) },
    sessionProjections: { stateOf: () => preset },
  };
  const business = {
    config: { analysisAgentCode: "custom-sales" },
    currentPageIdentity: () => undefined,
  };
  assert.equal(toolConsumer(ctx, business, "id", undefined), "branch-inventory");
  assert.throws(
    () => toolConsumer(ctx, business, "id", "base-safety-stock"),
    /ROUTE_NOT_REGISTERED/,
  );
  preset = "gea-html-inventory-aqkc";
  assert.equal(toolConsumer(ctx, business, "id", "custom-sales"), "custom-sales");
  assert.throws(
    () => toolConsumer(ctx, business, "id", "branch-inventory"),
    /ROUTE_NOT_REGISTERED/,
  );
});

test("same dataset labels from different models keep distinct source keys", () => {
  const raw = JSON.stringify({
    source: "GEA_CUBE_BATCH",
    consumerCode: "fixture",
    results: ["a", "b"].map((model, i) => ({
      model,
      names: ["q" + i],
      resourceCode: model,
      status: "returned",
      result: JSON.stringify({ rows: [{ quantity: i + 3 }] }),
    })),
  });
  const index = datasetIndex(raw, "ev");
  assert.equal(index.length, 2);
  assert.notEqual(index[0].key, index[1].key);
  assert.throws(() => readDataset(raw, "ev", "result"), /AMBIGUOUS/);
  for (const [i, item] of index.entries()) {
    const page = readDataset(raw, "ev", item.key);
    assert.equal(page.availableRows, 1);
    assert.equal(page.sourceCoverage[0].model, i === 0 ? "a" : "b");
    assert.equal(page.table.rows[0].quantity, i + 3);
  }
});
test("adding an evidence index never replaces inline datasets or their coverage", () => {
  const raw = JSON.stringify({
    datasets: [{ name: "stock", rows: [{ quantity: "123.45" }], complete: false }],
  });
  const shown = JSON.parse(indexProjection(raw, "ev", datasetIndex(raw, "ev")));
  assert.equal(shown.datasets[0].rows[0].quantity, "123.45");
  assert.equal(shown.datasets[0].complete, false);
  assert.equal(shown.evidenceDatasets.length, 1);
});

test("small nested artifacts expose exact business rows with coverage, not escaped envelopes", () => {
  const rows = [
    { "inventory.material_code": "SKU01", "inventory.qty": "12.3400" },
    { "inventory.material_code": "SKU02", "inventory.qty": null },
  ];
  const raw = JSON.stringify({
    source: "GEA_MCP_CONTENT",
    delivery: { sourceReadComplete: true, notes: ["not a complete snapshot"] },
    payloads: [
      JSON.stringify({
        warnings: ["source batch unverified"],
        queryArtifact: {
          resources: [
            {
              contents: [
                {
                  text: JSON.stringify({
                    datasetName: "stock",
                    rows,
                    totalRows: 2,
                    hasMore: false,
                  }),
                },
              ],
            },
          ],
        },
      }),
    ],
  });
  const output = JSON.parse(compactDatasetProjection(raw, "ev-fixture"));
  assert.equal(output.projection, "complete");
  assert.deepEqual(output.datasets[0].table.rows, rows);
  assert.equal(output.evidenceDatasets[0].nextRead, null);
  assert.match(JSON.stringify(output), /not a complete snapshot|source batch unverified/);
  assert.ok(!JSON.stringify(output).includes('\\\\\\"rows'));
  const mixed = JSON.stringify({
    source: "GEA_CUBE_BATCH",
    results: [
      { status: "returned", result: raw },
      { status: "rejected", code: "DENIED" },
    ],
  });
  const partial = JSON.parse(compactDatasetProjection(mixed, "ev-fixture"));
  assert.equal(partial.sourceOutcome, "partial");
  assert.equal(partial.queryFailures[0].code, "DENIED");
  assert.deepEqual(partial.datasets[0].table.rows, rows);
});

test("compact dataset paging never presents its row slice as the full returned dataset", () => {
  const raw = JSON.stringify({
    rows: Array.from({ length: 150 }, (_, i) => ({
      sku: "SKU" + i,
      qty: i === 1 ? null : i,
    })),
    hasMore: true,
    totalRows: 999,
  });
  const output = JSON.parse(compactDatasetProjection(raw, "ev-fixture", 3000));
  assert.equal(output.projection, "partial");
  assert.equal(output.datasets[0].sourceCoverage[0].hasMore, true);
  assert.equal(output.datasets[0].sourceCoverage[0].totalRows, 999);
  assert.ok(output.datasets[0].nextRead.args.rowOffset > 0);
  assert.ok(JSON.stringify(output).length <= 3000);
});
