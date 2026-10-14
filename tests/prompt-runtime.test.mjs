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
  const id = await store.put("a", "mcp__gea-gateway__query_business_data", text);
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
  const id = await first.put("s", "mcp__gea-gateway__query_business_data", "original business data", first.epoch(), grant);
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

test("catalog recovery and terminal evidence budgets preserve turn ownership", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gea-catalog-generation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handlers = new Map(),
    masks = new Set();
  const names = [
    "gea_capabilities",
    "skill",
    "gea_evidence_read",
    "mcp__gea-gateway__inspect_cube_model",
    "mcp__gea-gateway__query_business_data",
    "gea_sales_plan_read",
    "read_file",
    "run_code",
    "run_agent",
  ];
  let preset = "gea-readonly",
    revision = 1,
    identityChanged,
    guard,
    resourceEnabled = true;
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
    status: "running",
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
      list: async () => [{ id: preset, kind: "prompt", installed: true, enabled: resourceEnabled }],
    },
    skills: { list: async () => [] },
    on: (event, fn) => {
      handlers.set(event, fn);
      return () => {};
    },
    inject: (_services, mount) => mount(ctx),
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
  const start = async (name = "mcp__gea-gateway__inspect_cube_model") => {
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
  const assembly = {
    sections: [{ name: "native", text: "native policy survives" }],
    tools: names.map((name) => ({ name, description: name, parameters: {} })),
  };
  const assemble = (currentAgent = agent) =>
    handlers.get("system-prompt/assemble")(assembly, { agent: currentAgent }, async () => assembly);
  for (const transition of ["query", "turn", "preset", "identity"]) {
    const old1 = await start(),
      old2 = await start();
    if (transition === "query") await start("mcp__gea-gateway__query_business_data");
    if (transition === "turn") {
      revision++;
      handlers.get("session/event")({ id: agent.id }, { type: "turn/start" });
    }
    if (transition === "preset") preset = "gea-html-inventory-aqkc";
    if (transition === "identity") identityChanged();
    await finish(old1);
    await finish(old2);
    assert.ok((await visible()).includes("mcp__gea-gateway__inspect_cube_model"), transition);
    assert.equal(
      guard({ name: "mcp__gea-gateway__inspect_cube_model", agent, arguments: {} }),
      undefined,
      transition + " ignores stale replies",
    );
    await finish(await start());
    await finish(await start());
    const paused = await visible();
    assert.match(
      guard({ name: "mcp__gea-gateway__inspect_cube_model", agent, arguments: {} }),
      /GEA_CATALOG_NO_PROGRESS/,
      transition + " current duplicate replies should pause",
    );
    assert.ok(
      paused.includes("mcp__gea-gateway__query_business_data"),
      "actual query remains callable",
    );
    await start("mcp__gea-gateway__query_business_data");
    assert.ok((await visible()).includes("mcp__gea-gateway__inspect_cube_model"));
    assert.equal(
      guard({ name: "mcp__gea-gateway__inspect_cube_model", agent, arguments: {} }),
      undefined,
    );
  }
  handlers.get("session/event")({ id: agent.id }, { type: "turn/start" });
  const acquired = await start("gea_page");
  await handlers.get("tools/post-execute")(
    acquired,
    { content: [{ type: "text", text: '{"amount":"12.3400","coverage":"partial"}' }] },
    async () => ({ kind: "accept" }),
  );
  for (let i = 0; i < 20; i++)
    assert.equal(
      guard({ name: "mcp__gea-gateway__query_business_data", agent, arguments: {} }),
      undefined,
    );
  assert.match(
    guard({ name: "mcp__gea-gateway__query_business_data", agent, arguments: {} }),
    /GEA_CALL_BUDGET/,
  );
  const queryLimited = await assemble();
  assert.ok(queryLimited.tools.some((tool) => tool.name === "gea_evidence_read"));
  for (const name of ["read_file", "run_code", "run_agent"]) {
    assert.ok(
      queryLimited.tools.some((tool) => tool.name === name),
      name,
    );
    assert.equal(guard({ name, agent, arguments: {} }), undefined);
  }
  const retainedReceipt = queryLimited.sections.find(
    (section) => section.name === "gea:result-status",
  );
  assert.ok(retainedReceipt, "acquired evidence receipts exist before stopping");
  for (let i = 0; i < 12; i++)
    assert.equal(
      guard({ name: "gea_evidence_read", agent, arguments: {} }),
      undefined,
      "already acquired evidence retains a bounded read allowance",
    );
  const stopped = await assemble();
  assert.deepEqual(stopped.tools, [], "the final model assembly stops every tool after 12 reads");
  assert.deepEqual(
    stopped.sections.find((section) => section.name === "gea:result-status"),
    retainedReceipt,
    "stopping preserves acquired evidence receipts",
  );
  assert.equal(
    stopped.sections.find((section) => section.name === "native").text,
    "native policy survives",
  );
  assert.match(
    stopped.sections.find((section) => section.name === "gea:budget").text,
    /本轮全部工具/,
  );
  assert.match(guard({ name: "gea_evidence_read", agent, arguments: {} }), /GEA_EVIDENCE_BUDGET/);
  for (const name of [
    "mcp__gea-gateway__query_business_data",
    "gea_capabilities",
    "mcp__gea-gateway__inspect_cube_model",
    "read_file",
    "run_code",
    "run_agent",
  ])
    assert.match(
      guard({ name, agent, arguments: {} }),
      /GEA_EVIDENCE_BUDGET/,
      "read exhaustion cannot be bypassed via " + name,
    );
  agent.status = "idle";
  const idle = await assemble();
  for (const name of ["read_file", "run_code", "run_agent"]) {
    assert.ok(
      idle.tools.some((tool) => tool.name === name),
      "idle retains standard " + name,
    );
    assert.equal(guard({ name, agent, arguments: {} }), undefined);
  }
  assert.ok(!idle.tools.some((tool) => tool.name.startsWith("gea_")));
  assert.match(
    idle.sections.find((section) => section.name === "gea:budget").text,
    /通用文件、规划、任务和协作能力仍按官方规则可用/,
  );
  assert.deepEqual(
    idle.sections.find((section) => section.name === "gea:result-status"),
    retainedReceipt,
    "idle retains acquired evidence receipts",
  );
  for (const name of [
    "gea_evidence_read",
    "mcp__gea-gateway__query_business_data",
    "gea_capabilities",
  ])
    assert.match(guard({ name, agent, arguments: {} }), /GEA_EVIDENCE_BUDGET/);
  resourceEnabled = false;
  await assert.rejects(start("read_file"), /GEA_AGENT_RESOURCE_DISABLED/);
  resourceEnabled = true;
  agent.status = "running";
  assert.deepEqual((await assemble()).tools, [], "idle must not reopen the exhausted model driver");
  assert.match(guard({ name: "run_code", agent, arguments: {} }), /GEA_EVIDENCE_BUDGET/);
  const otherAgent = { ...agent, id: "other" };
  assert.equal(guard({ name: "read_file", agent: otherAgent, arguments: {} }), undefined);
  assert.ok((await assemble(otherAgent)).tools.some((tool) => tool.name === "read_file"));
  handlers.get("session/event")({ id: agent.id }, { type: "turn/start" });
  assert.equal(guard({ name: "gea_evidence_read", agent, arguments: {} }), undefined);
  assert.equal(
    guard({ name: "mcp__gea-gateway__query_business_data", agent, arguments: {} }),
    undefined,
  );
  for (const name of [
    "gea_evidence_read",
    "mcp__gea-gateway__query_business_data",
    "read_file",
    "run_code",
    "run_agent",
  ]) {
    assert.ok(
      (await assemble()).tools.some((tool) => tool.name === name),
      name + " restores next turn",
    );
  }
  assert.equal(guard({ name: "run_code", agent, arguments: {} }), undefined);
});
