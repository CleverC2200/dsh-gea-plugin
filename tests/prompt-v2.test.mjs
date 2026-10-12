import { currentHtmlResource } from "./fixtures/html-resource.mjs";
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
test("business identity wins over a mismatched page, coding still follows the page", () => {
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
  assert.equal(sessionConsumer(ctx, business, "id"), "base-safety-stock");
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
          gea: { consumerCode, readonly: true, contract: "gea-html-v1" },
        }),
      );
      await writeFile(
        join(path, "mcp.json"),
        JSON.stringify({
          provider: "gea",
          transport: "host-provided",
          contract: "gea-html-v1",
          consumer: { consumerType: "AGENT", consumerCode },
          capabilities: ["governed-sql-read"],
        }),
      );
    }
    for (const path of Object.values(roots)) await currentHtmlResource(path);
    const app = await profile(t, {
      beforeStart: fixtureWorkbench(Object.values(roots)),
      config: {
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
    const probe = (value) => console.log("[CI-CONSUMER-PROBE] " + JSON.stringify(value));
    await app.login();
    assert.equal((await app.rpc("model/discover")).ok, true);
    for (const [preset, consumer] of [
      ["gea-readonly", "sales_forecast"],
      ...configs.map(([s, c]) => ["gea-html-inventory-" + s, c]),
    ]) {
      const seenBefore = seen.length;
      const selected = await selectBusinessResource(app, preset);
      probe({
        operation: "resource/select",
        preset,
        selectedPreset: typeof selected.preset === "string" ? selected.preset : null,
      });
      const made = await app.remote("session/create", {
        cwd: app.runtime + "/workspace",
        agentPreset: preset,
      });
      probe({
        operation: "session/create",
        preset,
        ok: made.ok,
        sessionId: made.value?.sessionId ?? null,
      });
      assert.equal(made.ok, true);
      const sessionId = made.value.sessionId;
      const modelSelection = await app.remote("session/selectModel", {
        sessionId,
        provider: "gea-analysis",
        model: "fixture-model",
      });
      probe({
        operation: "session/selectModel",
        preset,
        sessionId,
        ok: modelSelection.ok,
        errorCode: modelSelection.error?.code ?? null,
      });
      const prompted = await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId,
        mode: "queue",
        content: [{ type: "text", text: "查询当前业务范围" }],
      });
      probe({
        operation: "session/prompt",
        preset,
        sessionId,
        ok: prompted.ok,
        errorCode: prompted.error?.code ?? null,
      });
      let rows = [];
      try {
        await until(
          async () => (rows = await readSession(app.runtime, sessionId)),
          (r) => r.some((e) => e.type === "turn/end"),
        );
      } finally {
        probe({
          operation: "turn/end",
          preset,
          sessionId,
          expectedConsumer: consumer,
          seenBefore,
          seenAfter: seen.length,
          newModelRequests: seen.length - seenBefore,
          consumers: seen.slice(seenBefore),
          lastConsumer: seen.at(-1) ?? null,
          turns: rows
            .filter((e) => e.type === "turn/end")
            .map((e) => ({
              kind: e.data?.reason?.kind ?? null,
              code: e.data?.reason?.error?.code ?? null,
              codes: [...new Set(
                JSON.stringify(e.data?.reason ?? {}).match(/\b(?:GEA|MODEL|AGENT|SOURCE)_[A-Z0-9_]+\b/g) ?? [],
              )],
            })),
        });
      }
      assert.equal(seen.at(-1), consumer);
    }
  },
);

test(
  "catalog stalls block backend repetition without removing tools, while mixed-model evidence stays recoverable",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
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
    const bodies = Object.fromEntries(
      ["a", "b"].map((name) => [
        name,
        JSON.stringify({
          datasetName: name,
          complete: false,
          rows: Array.from({ length: 70 }, (_, i) => ({
            id: String(i),
            quantity: "9007199254740993",
            label: "业务数据".repeat(40),
          })),
          tail: "END_" + name,
        }),
      ]),
    );
    let phase = 0,
      evidenceId,
      rawDone = false;
    let catalogCalls = 0,
      catalogPaused = false,
      checkedResume = false;
    const pages = [];
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path.endsWith("/ai/gateway/session")) {
        reply({
          success: true,
          result: {
            accessDecision: { allowed: true },
            gatewayContext: {
              consumerType: "AGENT",
              consumerCode: "sales_forecast",
              sessionId: "trusted",
              conversationId: "trusted",
            },
            delegationToken: "fixture",
          },
        });
        return true;
      }
      if (path.endsWith("/ai/gateway/mcp/proxy/resources")) {
        reply({
          success: true,
          resources: ["a", "b"].map((name) => ({
            capabilityCode: "MCP_TOOL:cube:query_business_data",
            resourceCode: name,
            resourceName: name,
            resourceType: "EXTERNAL_MCP",
            queryTarget: name,
            version: "1",
            maxRows: 200,
            maxBytes: null,
          })),
        });
        return true;
      }
      if (path.endsWith("/ai/gateway/mcp/proxy/mcp")) {
        const b = JSON.parse(req.body);
        let result = {};
        if (b.method === "initialize") result = { protocolVersion: b.params.protocolVersion };
        else if (b.method === "notifications/initialized") {
          res.statusCode = 202;
          res.end();
          return true;
        } else if (b.method === "tools/list")
          result = {
            tools: [
              {
                name: "query_business_data",
                _meta: { sourceType: "MCP", sourceCode: "cube" },
                inputSchema: {
                  type: "object",
                  properties: {
                    action: { type: "string" },
                    queries: { type: "array" },
                  },
                  required: ["action", "queries"],
                },
              },
            ],
          };
        else if (b.method === "tools/call") {
          const a = b.params.arguments;
          result = {
            content: [
              {
                type: "text",
                text:
                  a.action === "inspect"
                    ? JSON.stringify({
                        semanticModel: ["a", "b"].map((name) => ({
                          name,
                          measures: [{ name: name + ".row_count", type: "number" }],
                        })),
                      })
                    : bodies[a.queries[0].name],
              },
            ],
          };
        }
        reply({ jsonrpc: "2.0", id: b.id, result });
        return true;
      }
      if (path !== "/v1/chat/completions") return false;
      const b = JSON.parse(req.body);
      let call;
      const offersCatalog =
        b.tools?.some((x) => x.function?.name === "gea_gateway_catalog") ?? false;
      if (!catalogPaused) {
        if (catalogCalls < 5) {
          catalogCalls++;
          call = {
            name: "gea_gateway_catalog",
            arguments: JSON.stringify({ model: "a" }),
          };
        } else {
          assert.equal(offersCatalog, true, "keep the tool schema stable for provider validation");
          assert.match(
            b.messages.filter((m) => m.role === "tool").at(-1).content,
            /GEA_CATALOG_NO_PROGRESS/,
          );
          catalogPaused = true;
        }
      }
      if (call) {
        /* The next model step observes the catalog result. */
      } else if (phase++ === 0)
        call = {
          name: "gea_cube_query",
          arguments: JSON.stringify({
            queries: ["a", "b"].map((name) => ({
              name,
              query: { measures: [name + ".row_count"], limit: 100 },
            })),
          }),
        };
      else {
        if (!checkedResume) {
          assert.equal(offersCatalog, true, "a real query attempt restores targeted discovery");
          checkedResume = true;
        }
        const value = JSON.parse(b.messages.filter((m) => m.role === "tool").at(-1).content);
        if (!evidenceId) {
          evidenceId = value.evidenceId;
          assert.ok(evidenceId);
          call = {
            name: "gea_evidence_read",
            arguments: JSON.stringify({ evidenceId, format: "raw", limit: 6000 }),
          };
        } else if (!rawDone) {
          pages.push(value.content);
          if (value.nextRead)
            call = {
              name: value.nextRead.tool,
              arguments: JSON.stringify(value.nextRead.args),
            };
          else {
            rawDone = true;
            call = {
              name: "gea_evidence_read",
              arguments: JSON.stringify({
                evidenceId,
                datasetId: "a",
                rowOffset: 1,
                rowLimit: 2,
              }),
            };
          }
        } else {
          assert.equal(value.representation, "rows");
          assert.equal(value.rowOffset, 1);
          assert.equal(value.returnedRows, 2);
          assert.equal(value.name, "a");
        }
      }
      const delta = call
        ? {
            tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: call }],
          }
        : { content: "complete" };
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
    await selectBusinessResource(app, "gea-readonly");
    const made = await app.remote("session/create", {
      cwd: app.runtime + "/workspace",
      agentPreset: "gea-readonly",
    });
    const sessionId = made.value.sessionId;
    await app.remote("session/selectModel", {
      sessionId,
      provider: "gea-analysis",
      model: "fixture",
    });
    await app.remote("session/prompt", {
      requestId: randomUUID(),
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: "读取两个模型并续读完整正文" }],
    });
    await until(
      () => readSession(app.runtime, sessionId),
      (r) => r.some((e) => e.type === "turn/end"),
      40000,
    );
    assert.ok(
      catalogPaused && checkedResume,
      JSON.stringify({
        catalogCalls,
        catalogPaused,
        checkedResume,
        events: (await readSession(app.runtime, sessionId)).slice(-3),
        output: app.output.slice(-4000),
      }),
    );
    const raw = JSON.parse(pages.join(""));
    assert.equal(raw.source, "GEA_CUBE_BATCH");
    assert.equal(raw.results.length, 2);
    for (const result of raw.results) {
      assert.equal(result.result, bodies[result.model]);
      assert.equal(result.resultOmitted, false);
      assert.equal(JSON.parse(result.result).complete, false);
    }
  },
);

test("permission and partial delivery are not ordinary successful receipts", () => {
  const denial = "模块数据未授权：fixture";
  assert.equal(permissionDenied(denial), true);
  assert.equal(resultOutcome(denial), "blocked");
  assert.equal(JSON.parse(resultReceipt("gea_module_mcp", {}, "ev", denial)).outcome, "blocked");
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

test("knowledge projection uses cited chunks instead of a cut JSON envelope", () => {
  const chunks = Array.from({ length: 6 }, (_, i) => ({
    chunk_id: "chunk-" + i,
    reference_id: "ref-" + i,
    content: "业务规则。".repeat(500),
  }));
  const raw =
    JSON.stringify({ result: JSON.stringify({ document_ids: [], chunks }) }) + "\ntransport note";
  const shown = JSON.parse(transientResult(raw, 6000, true));
  assert.equal(shown.source, "GEA_KNOWLEDGE_EXCERPTS");
  assert.ok(shown.excerpts.length > 0);
  assert.ok(shown.excerpts[0].content.startsWith("业务规则"));
  assert.equal(shown.excerpts[0].chunkId, "chunk-0");
  assert.ok(JSON.stringify(shown).length <= 6000);
  assert.equal(shown.rawAvailable, false);
  const broken = JSON.stringify({
    result: '{"chunks":[' + JSON.stringify(chunks[0]) + ',{"chunk_id":"broken","content":"cut',
  });
  const partial = JSON.parse(transientResult(broken + " ".repeat(7000), 6000, true));
  assert.equal(partial.sourceComplete, false);
  assert.equal(partial.excerpts.length, 1);
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
    rows: Array.from({ length: 150 }, (_, i) => ({ sku: "SKU" + i, qty: i === 1 ? null : i })),
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
