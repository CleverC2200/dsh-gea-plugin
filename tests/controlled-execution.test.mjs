import test from "node:test";
import assert from "node:assert/strict";
import {
  toolConsumer,
  sessionConsumer,
} from "../src/host/business-identity.ts";
import { createPageBridge } from "../src/page-bridge/host.ts";
test("a generic Skill session can use ordinary model routing but cannot claim a business Consumer", () => {
  const ctx = {
    agents: { get: () => ({ session: {} }) },
    sessionProjections: { stateOf: () => "agent-resource-skill" },
  };
  const business = {
    config: { analysisAgentCode: "sales" },
    currentPageIdentity: () => ({ consumerCode: "branch-inventory" }),
  };
  assert.equal(sessionConsumer(ctx, business, "generic"), "branch-inventory");
  assert.throws(
    () => toolConsumer(ctx, business, "generic", undefined),
    /GEA_BUSINESS_PROFILE_REQUIRED/,
  );
  assert.throws(
    () => toolConsumer(ctx, business, "generic", "branch-inventory"),
    /GEA_BUSINESS_PROFILE_REQUIRED/,
  );
});
test("page bridge cancellation ends the wait and rejects late, unknown and previous-owner replies", async () => {
  const bridge = createPageBridge();
  const signal = new AbortController();
  const id = bridge.enqueue("session", { toolCallName: "view", args: {} });
  const pending = bridge.wait("session", id, 30, 1, signal.signal);
  signal.abort(new Error("Caller stopped"));
  await assert.rejects(pending, /Caller stopped/);
  bridge.pull("session", [
    { id: "late", role: "tool", toolCallId: id, content: "late" },
  ]);
  assert.equal(bridge.take("session", id), undefined);
  const older = bridge.enqueue("session", { toolCallName: "view", args: {} });
  bridge.reset("session");
  bridge.pull("session", [
    { id: "old", role: "tool", toolCallId: older, content: "old owner" },
  ]);
  assert.equal(bridge.take("session", older), undefined);
});

test("releasing a page tool owner cancels queued commands and the waiting public execution", async () => {
  const { build } = await import("esbuild");
  const { outputFiles } = await build({
    entryPoints: ["src/page-bridge/registry.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
  });
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  await mkdir(".scratch", { recursive: true });
  const file = process.cwd() + "/.scratch/ticket03-controlled-registry.mjs";
  await writeFile(file, outputFiles[0].text);
  const { createPageToolRegistry } = await import(pathToFileURL(file).href);
  const bridge = createPageBridge();
  let tool;
  const agent = {
    id: "session-owned",
    ctx: {
      tools: {
        register: (value) => {
          tool = value;
          return () => {};
        },
      },
    },
  };
  const registry = createPageToolRegistry(
    { agents: { get: () => agent } },
    bridge,
    { waitMs: 10000 },
  );
  registry.declare(agent.id, {
    surface: "owned",
    tool: "owned_view",
    description: "view",
    elements: [{ id: "row:1", role: "row", label: "Row", actions: ["expand"] }],
  });
  const signal = new AbortController();
  const pending = tool.execute(
    { kind: "invoke", target: "row:1", action: "expand" },
    { agent, signal: signal.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 1));
  registry.dispose(agent.id);
  await assert.rejects(pending, /PAGE_TOOL_OWNER_RELEASED/);
  assert.deepEqual(bridge.pull(agent.id, []), []);
  assert.equal(registry.receipts()[0].outcome, "failed");
  registry.shutdown();
});
test("business prompt masks keep the selected native ancestor loader and refuse generic business execution", async () => {
  const { build } = await import("esbuild");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const { outputFiles } = await build({
    entryPoints: ["src/host/prompt-runtime.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
  });
  await mkdir(".scratch", { recursive: true });
  const file = process.cwd() + "/.scratch/ticket03-controlled-prompts.mjs";
  await writeFile(file, outputFiles[0].text);
  const { mountBusinessPrompts } = await import(pathToFileURL(file).href);
  const handlers = new Map();
  let guard;
  let mask;
  let preset = "gea-readonly";
  const native = new Set(["skill", "skill_reference_read"]);
  const tools = {
    register: () => () => {},
    guard: (fn) => {
      guard = fn;
      return () => {};
    },
    schemas: () =>
      ["gea_capabilities", "skill", "gea_cube_query", "run_code"].map(
        (name) => ({ name }),
      ),
    get: (name) => (native.has(name) ? { name } : undefined),
  };
  const agent = {
    id: "owned",
    session: { header: { cwd: process.cwd() }, snapshotEvents: () => [] },
    ctx: {
      effect: (fn) => fn(),
      tools: {
        restrict: (filter) => {
          mask = filter;
          return () => {};
        },
      },
    },
  };
  const ctx = {
    tools,
    agents: { get: () => agent },
    sessionProjections: { stateOf: () => preset },
    on: (name, fn) => {
      handlers.set(name, fn);
      return () => {};
    },
    inject: () => {},
  };
  const business = {
    config: {
      runtimeDir: process.cwd() + "/.scratch",
      analysisAgentCode: "sales",
    },
    status: () => ({ user: { id: "one" } }),
    watchIdentity: () => () => {},
    readTurnRevision: () => 1,
    surfaceFor: () => undefined,
  };
  const dispose = mountBusinessPrompts(
    ctx,
    business,
    { readModules: () => [] },
    new Map(),
  );
  await handlers.get("agent/pre-step")({ agent, messages: [] }, async () => ({
    kind: "enter",
    messages: [],
  }));
  assert.ok(mask.allow.includes("skill"));
  assert.ok(mask.allow.includes("skill_reference_read"));
  assert.equal(mask.allow.includes("run_code"), false);
  preset = "agent-resource-skill";
  assert.match(
    guard({ name: "gea_cube_query", agent, arguments: {} }),
    /GEA_BUSINESS_PROFILE_REQUIRED/,
  );
  assert.match(
    guard({ name: "gea_cube_query", arguments: {} }),
    /GEA_BUSINESS_PROFILE_REQUIRED/,
  );
  assert.equal(guard({ name: "skill", agent, arguments: {} }), undefined);
  dispose();
});
