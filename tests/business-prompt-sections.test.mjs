import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readSupportedCore } from "../scripts/supported-cores.mjs";
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
  const core = resolve("../../official-latest-standard");
  await readSupportedCore(core);
  const nativeSections = [];
  const nativeLifetimes = [];
  const { apply } = await import(
    pathToFileURL(join(core, "packages/client/ui-deliverables/lib/index.js"))
  );
  apply({
    connection: { fetch: { register: () => () => {} } },
    effect: (fn) => nativeLifetimes.push(fn()),
    systemPrompt: {
      getSectionOrder: () => 0,
      section: (section) => nativeSections.push(section),
    },
  });
  t.after(async () => {
    for (const dispose of nativeLifetimes.reverse()) await dispose?.();
  });
  const nativeFiles = nativeSections.find(
    (section) => section.name === "ui:deliverable-file-references",
  );
  assert.ok(nativeFiles, "the admitted Core must register its native file protocol");
  const sections = [
    {
      name: "app:web-surface",
      text: "Host GUI orientation and no replacement servers",
    },
    { name: "genui:fence", text: "vendor coding presentation policy" },
    { name: "kept-native-section", text: "native section survives" },
    nativeFiles,
    {
      name: "gea:independent-extension",
      text: "independent GEA source remains authoritative",
    },
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
  const files = businessView.sections.find(
    (section) => section.name === "ui:deliverable-file-references",
  ).text;
  assert.equal(files, nativeFiles.text, "GEA must preserve Core's file-reference protocol");
  assert.match(
    files,
    /!\[Description\]\(<path\/to\/image.png>\).*\[Description\]\(<path\/to\/image.png>\)/,
  );
  assert.match(
    files,
    /every mention of an existing file.*repeats and tables.*relative to the working directory or absolute/,
  );
  assert.match(files, /#L24.*#L24-L30/);
  assert.match(files, /image supports an explanation or comparison/);
  assert.match(files, /present when a separate file card.*complete deliverable/);
  assert.match(
    files,
    /Do not call present just to list edited source files.*run commands to check whether a diff view/,
  );
  assert.equal(assembly.sections[3].text, nativeFiles.text);
  preset = "standard";
  const ordinary = await assemble();
  assert.deepEqual(
    ordinary.sections.slice(0, -1),
    sections,
    "ordinary coding keeps every Core and independent source section",
  );
  for (const [index, section] of sections.entries())
    assert.equal(ordinary.sections[index], section);
  assert.deepEqual(ordinary.sections.at(-1), {
    name: "gea:admission",
    text: "当前实际会话预设未声明 GEA 业务身份。Skill 可用于规则说明，但实际库存取数需点击工作台的‘使用基地库存 Agent 分析’入口或选用相应业务资源。子智能体的角色名和提示词不改变其实际父会话的业务身份。GEA 工具当前不可用；其它 MCP 结果应标明独立来源，不证明 GEA 页面或授权恢复。",
  });
  assert.equal(ordinary.sections.length, sections.length + 1);
  assert.deepEqual(ordinary.tools, assembly.tools);
  assert.equal(ordinary.contexts, assembly.contexts);
  assert.equal(ordinary.variables, assembly.variables);
  assert.equal(assembly.sections, sections, "GEA does not mutate the original Core assembly");
});
