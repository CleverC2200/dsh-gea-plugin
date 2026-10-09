import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountBusinessPrompts } from "../src/host/prompt-runtime.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gea-execution-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map(),
    registered = new Map();
  let guard,
    assemble,
    preset = "gea-readonly";
  const names = [
    "skill",
    "skill_reference_read",
    "forecast_compute",
    "gea_cube_query",
    "gea_capabilities",
    "gea_evidence_read",
  ];
  const tools = {
    register: (tool) => {
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
    guard: (fn) => {
      guard = fn;
      return () => {};
    },
    schemas: () => names.map((name) => ({ name })),
    get: (name) => (names.includes(name) ? { name } : undefined),
  };
  const agent = {
    id: "actual-scope",
    session: {
      header: { cwd: "/project" },
      snapshotEvents: () => [],
      deriveMessages: () => [],
    },
    ctx: { effect: (fn) => fn(), tools: { restrict: () => () => {} } },
  };
  const ctx = {
    tools,
    agents: { get: () => agent },
    sessionProjections: { stateOf: () => preset },
    skills: {
      list: async () => {
        throw Error("GEA must not load catalog");
      },
      get: async () => {
        throw Error("GEA must not load body");
      },
    },
    on: (name, fn) => {
      handlers.set(name, fn);
      return () => {};
    },
    inject: (names, fn) =>
      fn({
        on: (_name, callback) => {
          assemble = callback;
        },
      }),
  };
  const business = {
    config: { runtimeDir: root, analysisAgentCode: "sales" },
    status: () => ({ source: "test", user: { id: "one" } }),
    watchIdentity: () => () => {},
    readTurnRevision: () => 1,
    surfaceFor: () => undefined,
    turnStopKind: () => undefined,
  };
  t.after(
    mountBusinessPrompts(ctx, business, { readModules: () => [] }, new Map()),
  );
  return {
    agent,
    handlers,
    registered,
    guard: (exec) => guard(exec),
    assemble: (assembled) => assemble({}, { agent }, async () => assembled),
    setPreset: (value) => {
      preset = value;
    },
  };
}

test("GEA registers execution metadata and evidence only, preserving the original official Skill and persona assembly", async (t) => {
  const current = await fixture(t);
  assert.deepEqual([...current.registered.keys()].sort(), [
    "gea_capabilities",
    "gea_evidence_read",
  ]);
  const original = {
    sections: [
      { name: "skill:catalog", text: "Exact original catalog" },
      { name: "deployment:persona-prefix", text: "Exact source persona" },
      { name: "platform:security", text: "Exact platform rule" },
    ],
    tools: [{ name: "skill", description: "Official full-body loader" }],
  };
  const result = await current.assemble(original);
  for (const section of original.sections)
    assert.ok(result.sections.includes(section));
  assert.equal(
    result.tools.find((tool) => tool.name === "skill").description,
    "Official full-body loader",
  );
  assert.equal(
    result.sections.some((section) => section.name === "gea:capabilities"),
    false,
  );
  const capability = JSON.parse(
    await current.registered
      .get("gea_capabilities")
      .execute(
        { complex: true },
        { agent: current.agent, signal: new AbortController().signal },
      ),
  );
  assert.equal(capability.callLimit, 40);
  assert.equal("skills" in capability, false);
  assert.equal("packs" in capability, false);
  assert.equal("loaded" in capability, false);
});

test("business admission and concurrent budget reservations survive resource orchestration removal", async (t) => {
  const current = await fixture(t);
  const exec = { name: "gea_cube_query", agent: current.agent, arguments: {} };
  for (let i = 0; i < 20; i++) assert.equal(current.guard(exec), undefined);
  assert.match(current.guard(exec), /GEA_CALL_BUDGET/);
  current.setPreset("agent-resource-skill");
  assert.match(current.guard(exec), /GEA_BUSINESS_PROFILE_REQUIRED/);
  assert.equal(current.guard({ ...exec, name: "skill" }), undefined);
});
