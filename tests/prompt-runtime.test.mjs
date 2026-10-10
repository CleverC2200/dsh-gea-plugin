import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PromptEvidenceStore,
  projectEvidence,
  withoutHistoricalEvidence,
  exactResult,
} from "../src/host/prompt-evidence.ts";
import { mountBusinessPrompts } from "../src/host/prompt-runtime.ts";
import { businessUiIssue } from "../src/host/prompt-policy.ts";
test("evidence projection preserves exact numbers and scope; original reads cannot cross identities or sessions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gea-evidence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new PromptEvidenceStore(dir);
  const text =
    '{"coverage":"complete","amount":12.3400,"id":9007199254740993,"rows":' +
    JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ i, name: "商品".repeat(30) }))) +
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
  const id = await first.put("s", "gea_cube_query", "original business data", first.epoch(), grant);
  const restored = new PromptEvidenceStore(dir);
  let resourceVersion = "v1";
  const authorize = async (saved) => {
    assert.equal(saved.owner, "user-a");
    if (saved.resources !== resourceVersion) throw Error("AUTHORIZATION_CHANGED");
  };
  assert.equal(
    (await restored.read("s", id, 0, 4000, authorize)).content,
    "original business data",
  );
  await assert.rejects(restored.read("another-session", id, 0, 4000, authorize), /UNAVAILABLE/);
  resourceVersion = "revoked";
  await assert.rejects(restored.read("s", id, 0, 4000, authorize), /AUTHORIZATION_CHANGED/);
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
    assert.match(businessUiIssue({ spec: { items: [{ type, delta: "−10" }] } }), /SEMANTICS/);
  assert.equal(
    businessUiIssue({
      spec: {
        items: [{ type: "table", columns: ["差额"], rows: [[-10], ["少于计划 10"]] }],
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
  const projected = JSON.parse(projectEvidence(JSON.stringify(original), "ev-id"));
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
    "skill",
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
    restrict({ deny }) {
      const mask = new Set(names.filter((name) => !deny.includes(name)));
      masks.add(mask);
      return () => masks.delete(mask);
    },
    schemas: (scope) =>
      names
        .filter((n) => scope === undefined || [...masks].every((m) => m.has(n)))
        .map((name) => ({ name })),
    get: (name, scope) =>
      (scope === undefined || [...masks].every((m) => m.has(name))) && names.includes(name)
        ? { name }
        : undefined,
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
    agentResources: {
      list: async () => [{ id: preset, kind: "prompt", installed: true, enabled: true }],
    },
    skills: { list: async () => [] },
    on: (event, fn) => {
      handlers.set(event, fn);
      return () => {};
    },
    inject: () => {},
  };
  const business = {
    config: { runtimeDir: dir, analysisAgentCode: "sales_forecast" },
    assertExecutionAllowed: () => {},
    status: () => ({ source: "fixture", user: { id: "one" } }),
    turnStopKind: () => undefined,
    watchIdentity: (fn) => {
      identityChanged = fn;
      return () => {};
    },
    readTurnRevision: () => revision,
    surfaceFor: () => undefined,
  };
  t.after(mountBusinessPrompts(ctx, business, { readModules: () => [] }, new Map()));
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
    assert.equal(
      guard({ name: "gea_gateway_catalog", agent, arguments: {} }),
      undefined,
      transition + " ignores stale replies",
    );
    await finish(await start());
    await finish(await start());
    const paused = await visible();
    assert.match(
      guard({ name: "gea_gateway_catalog", agent, arguments: {} }),
      /GEA_CATALOG_NO_PROGRESS/,
      transition + " current duplicate replies should pause",
    );
    assert.ok(paused.includes("gea_cube_query"), "actual query remains callable");
    await start("gea_cube_query");
    assert.ok((await visible()).includes("gea_gateway_catalog"));
    assert.equal(guard({ name: "gea_gateway_catalog", agent, arguments: {} }), undefined);
  }
  handlers.get("session/event")({ id: agent.id }, { type: "turn/start" });
  for (let i = 0; i < 20; i++)
    assert.equal(guard({ name: "gea_cube_query", agent, arguments: {} }), undefined);
  assert.match(guard({ name: "gea_cube_query", agent, arguments: {} }), /GEA_CALL_BUDGET/);
  for (let i = 0; i < 12; i++)
    assert.equal(
      guard({ name: "gea_evidence_read", agent, arguments: {} }),
      undefined,
      "already acquired evidence retains a bounded read allowance",
    );
  assert.match(guard({ name: "gea_evidence_read", agent, arguments: {} }), /GEA_EVIDENCE_BUDGET/);
  for (const name of ["gea_cube_query", "gea_capabilities", "gea_gateway_catalog"])
    assert.match(
      guard({ name, agent, arguments: {} }),
      /GEA_EVIDENCE_BUDGET/,
      "read exhaustion cannot be bypassed via " + name,
    );
  handlers.get("session/event")({ id: agent.id }, { type: "turn/start" });
  assert.equal(guard({ name: "gea_evidence_read", agent, arguments: {} }), undefined);
});
