import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const built = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts'; export {mountBusinessPrompts} from './src/host/prompt-runtime.ts'",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const module = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);

test("business section policy preserves native UI protocol and leaves ordinary coding sections untouched", async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "business-sections-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const business = new module.exports.Business({
    geaBaseUrl: "https://gea.example.test",
    analysisAgentCode: "sales_forecast",
    runtimeDir,
    requestTimeoutMs: 1000,
  });
  t.after(() => business.dispose());
  let preset = "gea-readonly";
  const hooks = new Map();
  const agent = {
    id: "fixture-session",
    session: { snapshotEvents: () => [] },
    ctx: { effect: (f) => f(), tools: { restrict: () => () => {} } },
  };
  const ctx = {
    effect: (f) => f(),
    tools: {
      register: () => () => {},
      guard: () => () => {},
      schemas: () => [],
      get: () => undefined,
    },
    agents: { get: () => agent },
    sessionProjections: { stateOf: () => preset },
    on: (name, fn) => {
      hooks.set(name, fn);
      return () => {};
    },
    inject: (_names, fn) => {
      fn(ctx);
      return () => {};
    },
  };
  const dispose = module.exports.mountBusinessPrompts(
    ctx,
    business,
    { readModules: () => [] },
    new Map(),
  );
  t.after(dispose);
  const sections = [
    { name: "app:web-surface", text: "Host GUI orientation and no replacement servers" },
    { name: "genui:fence", text: "vendor coding presentation policy" },
    { name: "kept-native-section", text: "native section survives" },
  ];
  const assembly = { sections, contexts: [], tools: [], variables: {} };
  const assemble = () =>
    hooks.get("system-prompt/assemble")(assembly, { agent }, async () => assembly);
  const businessView = await assemble();
  assert.equal(
    businessView.sections.some((section) => section.name === "app:web-surface"),
    true,
  );
  const ui = businessView.sections.find((section) => section.name === "genui:fence").text;
  assert.match(ui, /dsh-ui/);
  assert.match(ui, /render_ui/);
  assert.match(ui, /原生 skill 加载 genui/);
  assert.match(ui, /简单事实或明确纯文字请求使用文字/);
  assert.match(ui, /缺失时如实说明/);
  assert.equal(
    businessView.sections.find((section) => section.name === "kept-native-section").text,
    "native section survives",
  );
  assert.equal(
    assembly.sections[1].text,
    "vendor coding presentation policy",
    "the source assembly was not rewritten",
  );
  preset = "standard";
  assert.equal(await assemble(), assembly, "ordinary coding keeps the original native sections");
});
