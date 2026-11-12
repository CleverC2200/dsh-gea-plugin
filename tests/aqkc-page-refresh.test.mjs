import test from "node:test";
import assert from "node:assert/strict";
import {
  bindModulePage,
  modulePagePrompt,
} from "../src/host/module-page-scope.ts";
const observation = (bases, current) => ({
  parts: {
    pageFilters: { selectedBases: bases, tab: "基地结构" },
    queryState: { state: "ready", scope: bases.join(",") },
    stockOverview: {
      state: "ready",
      scope: bases.join(","),
      cards: { stock: { current, target: 0 } },
      rows: bases.map((base) => ({ base })),
      version: { month: "2026-11", version: "纠偏" },
    },
  },
});
test("each turn uses the latest AQKC selected-base cards instead of the preceding scope", () => {
  const host = { surfaceFor: () => ({ menu: "inventory-aqkc" }) };
  const binding = bindModulePage(
    host,
    "session",
    "inventory-aqkc",
    new AbortController().signal,
  );
  binding.observe(observation(["华南基地", "郑州基地"], 2360453));
  assert.match(modulePagePrompt(host, "session") ?? "", /2360453/);
  binding.observe(observation(["华南基地"], 298114));
  const next = modulePagePrompt(host, "session");
  assert.match(next, /298114/);
  assert.doesNotMatch(next, /2360453|郑州基地/);
  assert.match(next, /"target":0/);
});
for (const state of [
  "loading",
  "error",
  "empty",
  "mismatched",
  "filter-changed",
]) {
  test(`AQKC ${state} observation cannot publish stale card values`, () => {
    const host = { surfaceFor: () => ({ menu: "inventory-aqkc" }) };
    const binding = bindModulePage(
      host,
      "s",
      "inventory-aqkc",
      new AbortController().signal,
    );
    const payload = observation(["华南基地"], 298114);
    if (state === "mismatched") payload.parts.stockOverview.scope = "郑州基地";
    else if (state === "filter-changed")
      payload.parts.pageFilters.selectedBases = ["郑州基地"];
    else payload.parts.queryState.state = state;
    binding.observe(payload);
    const prompt = modulePagePrompt(host, "s");
    assert.match(prompt, /PAGE_CONTEXT_NOT_READY/);
    assert.doesNotMatch(prompt, /298114|"target":0/);
  });
}
test("AQKC observations retain grant ownership and do not claim a Cube restriction", async () => {
  const {
    inheritModuleCubeScope,
    moduleCubeScopeReceipt,
    moduleScopeSignature,
  } = await import("../src/host/module-page-scope.ts");
  let menu = "inventory-aqkc";
  const host = { surfaceFor: () => ({ menu }) };
  const old = bindModulePage(host, "s", menu, new AbortController().signal);
  const controller = new AbortController();
  const current = bindModulePage(host, "s", menu, controller.signal);
  current.observe(observation(["华南基地"], 298114));
  const signature = moduleScopeSignature(host, "s");
  old.observe(observation(["郑州基地"], 2062339));
  old.release();
  assert.match(modulePagePrompt(host, "s"), /298114/);
  current.observe(observation(["华南基地"], 298114));
  assert.equal(moduleScopeSignature(host, "s"), signature);
  current.observe(observation(["郑州基地"], 2062339));
  assert.notEqual(moduleScopeSignature(host, "s"), signature);
  const args = { action: "query", queries: [] };
  assert.equal(inheritModuleCubeScope(host, "s", args), args);
  assert.equal(moduleCubeScopeReceipt(host, "s", '{"rows":[]}'), '{"rows":[]}');
  assert.match(modulePagePrompt(host, "other"), /PAGE_CONTEXT_NOT_READY/);
  menu = "other";
  assert.equal(modulePagePrompt(host, "s"), undefined);
  menu = "inventory-aqkc";
  controller.abort();
  assert.doesNotMatch(modulePagePrompt(host, "s"), /2062339/);
  current.release();
  assert.match(modulePagePrompt(host, "s"), /PAGE_CONTEXT_NOT_READY/);
});
