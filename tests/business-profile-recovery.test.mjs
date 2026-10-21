import test from "node:test";
import assert from "node:assert/strict";
import { currentMcp, inspectTool } from "./fixtures/current-mcp.mjs";

const value = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(
    result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  );
};

test("ordinary AI diagnosis explains resource recovery without requiring a page or granting access", async (t) => {
  const f = await currentMcp(t, { prompts: true });
  f.agents.get("ordinary").preset = "auto-negotiation";
  const state = value(await f.execute("gea_runtime_diagnose", {}, "ordinary"));
  assert.equal(state.preset, "auto-negotiation");
  assert.equal(state.businessProfileDeclared, false);
  assert.equal(state.pageBound, false);
  assert.deepEqual(state.independentQuery, { available: false, pageRequired: false });
  assert.match(state.recovery, /GEA Workbench/);
  assert.match(state.recovery, /无需.*页面/);
  const refused = await f.execute(inspectTool, {}, "ordinary");
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused), /GEA_BUSINESS_PROFILE_REQUIRED|TOOL_NOT_FOUND/);
  assert.equal(f.calls.filter(({ wire }) => wire.method === "tools/call").length, 0);
});

test("selected personal GEA source permits independent queries with no business profile or page", async (t) => {
  const f = await currentMcp(t, { prompts: true, personal: true });
  const state = value(await f.execute("gea_runtime_diagnose", {}, "personal"));
  assert.equal(state.businessProfileDeclared, false);
  assert.equal(state.pageBound, false);
  assert.equal(state.consumerCode, "workbench");
  assert.deepEqual(state.independentQuery, { available: true, pageRequired: false });
  assert.match(state.recovery, /无需.*页面/);
  assert.equal(state.businessAuthorization, "not-checked");
  value(await f.execute(inspectTool, {}, "personal"));
  assert.ok(
    f.calls.some(
      ({ wire }) => wire.method === "tools/call" && wire.params._meta.agentCode === "workbench",
    ),
  );
});

test("business resource queries do not require a page and disabled resources remain denied", async (t) => {
  const f = await currentMcp(t, { prompts: true, personal: true });
  const state = value(await f.execute("gea_runtime_diagnose", {}));
  assert.equal(state.businessProfileDeclared, true);
  assert.equal(state.pageBound, false);
  assert.deepEqual(state.independentQuery, { available: true, pageRequired: false });
  value(await f.execute(inspectTool, {}));
  f.setEnabled(false);
  const disabled = value(await f.execute("gea_runtime_diagnose", {}, "personal"));
  assert.equal(disabled.independentQuery.available, false);
  assert.match(disabled.recovery, /启用/);
  const refused = await f.execute(inspectTool, {}, "personal");
  assert.equal(refused.isError, true);
});

test("runtime diagnosis distinguishes login recovery from selecting a resource", async (t) => {
  const f = await currentMcp(t, { prompts: true, personal: true });
  t.mock.method(f.business, "status", () => ({ authenticated: false }));
  const state = value(await f.execute("gea_runtime_diagnose", {}, "personal"));
  assert.equal(state.authenticated, false);
  assert.equal(state.independentQuery.available, false);
  assert.match(state.recovery, /登录/);
  assert.equal(state.businessAuthorization, "not-checked");
});

test("server Consumer denial survives local source readiness without retrying another identity", async (t) => {
  const f = await currentMcp(t, { prompts: true, personal: true });
  f.setHandler((wire) =>
    wire.method === "tools/call"
      ? Response.json({
          jsonrpc: "2.0",
          id: wire.id,
          error: { code: -32000, message: "AGENT_ACCESS_DENIED" },
        })
      : undefined,
  );
  const refused = await f.execute(inspectTool, {}, "personal");
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused), /AGENT_ACCESS_DENIED/);
  const calls = f.calls.filter(({ wire }) => wire.method === "tools/call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].wire.params._meta.agentCode, "workbench");
});

test("diagnosis without an actual calling Agent requests attribution instead of granting a profile", async (t) => {
  const f = await currentMcp(t, { prompts: true });
  const state = value(await f.execute("gea_runtime_diagnose", {}, "missing"));
  assert.equal(state.callingAgentPresent, false);
  assert.equal(state.sessionId, null);
  assert.equal(state.independentQuery.available, false);
  assert.equal(state.consumerCode, null);
  assert.match(state.recovery, /调用归属/);
});
