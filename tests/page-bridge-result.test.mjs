import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/page-bridge/registry.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const compiled = join(process.cwd(), ".scratch", "gea-page-bridge-result-test.mjs");
await writeFile(compiled, outputFiles[0].text);
const m = await import(pathToFileURL(compiled).href + `?v=${Date.now()}`);

test("元素目录改成按需取：说明里只有数量，directory=true 才回目录且能按 focus 收窄", async () => {
  let registered;
  const sessionId = "session-page-directory";
  const agent = {
    id: sessionId,
    ctx: {
      tools: {
        register(tool) {
          registered = tool;
          return () => {};
        },
      },
    },
  };
  const registry = m.createPageToolRegistry(
    { agents: { get: () => agent } },
    { enqueue: () => "call-1", cancel: () => {}, wait: async () => undefined },
    { waitMs: 1, refreshWaitMs: 1 },
  );
  registry.declare(sessionId, {
    surface: "gea-workbench",
    tool: "gea_workbench_apply",
    description: "改页面",
    elements: [
      {
        id: "field:c1:qty",
        role: "field",
        label: "长沙分仓 补货量",
        value: "10",
        editable: true,
      },
      {
        id: "field:c2:qty",
        role: "field",
        label: "武汉分仓 补货量",
        value: "20",
        editable: true,
      },
      { id: "readout:c1:gap", role: "field", label: "缺口" },
    ],
  });
  // 工具说明只写数量：目录不再跟着每次请求一起付 token。
  assert.match(registered.description, /可操作元素 2 个/);
  assert.equal(registered.description.includes("field:c1:qty"), false);

  // 要目录时才回，且默认有上限、可 focus 收窄。
  const all = JSON.parse(
    await registered.execute({ kind: "invoke", directory: true }, { agent, signal:new AbortController().signal }),
  );
  assert.equal(all.directory.counts.total, 3);
  assert.equal(all.directory.counts.interactive, 2);
  assert.equal(all.directory.entries.length, 3);
  assert.equal(all.directory.entries[0].id, "field:c1:qty");
  // 渐进式暴露：默认只给字段索引，不给当前值。
  assert.equal(all.directory.entries[0].value, undefined);
  assert.match(all.directory.note, /values=true/);

  const focused = JSON.parse(
    await registered.execute(
      { kind: "invoke", directory: true, focus: "长沙", values: true },
      { agent, signal:new AbortController().signal },
    ),
  );
  assert.deepEqual(
    focused.directory.entries.map((entry) => entry.id),
    ["field:c1:qty"],
  );
  assert.equal(focused.directory.entries[0].value, "10");
  assert.match(focused.directory.note, /focus/);

  // 线上实测：模型会把"要目录"写成 kind=directory（不在动词枚举里）→ 这里也认。
  const alias = JSON.parse(
    await registered.execute({ kind: "directory" }, { agent, signal:new AbortController().signal }),
  );
  assert.ok(alias.directory, "kind=directory 当作要目录");

  // 既没给动词也不要目录：给一句能照着改的说明，而不是看不懂的元素错误。
  const missing = JSON.parse(await registered.execute({}, { agent, signal:new AbortController().signal }));
  assert.equal(missing.error, "PAGE_KIND_REQUIRED");
  assert.match(missing.note, /directory=true/);
});

test("页面明确回填 applied=false 时，宿主不会误报成功", async () => {
  let registered;
  const sessionId = "session-page-result";
  const agent = {
    id: sessionId,
    ctx: {
      tools: {
        register(tool) {
          registered = tool;
          return () => {};
        },
      },
    },
  };
  const registry = m.createPageToolRegistry(
    { agents: { get: () => agent } },
    {
      enqueue: () => "call-1",
      cancel: () => {},
      wait: async () => ({
        id: "result-1",
        role: "tool",
        toolCallId: "call-1",
        content: JSON.stringify({ applied: false, error: "ELEMENT_GONE" }),
      }),
    },
    { waitMs: 1, refreshWaitMs: 1 },
  );
  registry.declare(sessionId, {
    surface: "gea-workbench",
    tool: "gea_workbench_apply",
    description: "改页面",
    elements: [
      { id: "row:1", role: "row", label: "第一行", actions: ["expand"] },
    ],
  });
  const result = JSON.parse(
    await registered.execute(
      { kind: "invoke", target: "row:1", action: "expand" },
      { agent, signal:new AbortController().signal },
    ),
  );
  assert.equal(result.applied, false);
  assert.equal(result.error, "PAGE_TOOL_NOT_APPLIED");
  assert.equal(result.draft.outcome, "failed");
});


test("页面等待超时会取消排队调用", async () => {
  let registered;
  let cancelled;
  const sessionId = "session-page-timeout";
  const agent = {
    id: sessionId,
    ctx: {
      tools: {
        register(tool) {
          registered = tool;
          return () => {};
        },
      },
    },
  };
  const registry = m.createPageToolRegistry(
    { agents: { get: () => agent } },
    {
      enqueue: () => "call-timeout",
      cancel: (id, toolCallId) => { cancelled = { id, toolCallId }; },
      wait: async () => undefined,
    },
    { waitMs: 1, refreshWaitMs: 1 },
  );
  registry.declare(sessionId, {
    surface: "gea-workbench",
    tool: "gea_workbench_apply",
    description: "改页面",
    elements: [
      { id: "row:1", role: "row", label: "第一行", actions: ["expand"] },
    ],
  });
  const result = JSON.parse(
    await registered.execute(
      { kind: "invoke", target: "row:1", action: "expand" },
      { agent, signal:new AbortController().signal },
    ),
  );
  assert.equal(result.error, "PAGE_TOOL_PENDING");
  assert.deepEqual(cancelled, { id: sessionId, toolCallId: "call-timeout" });
});
