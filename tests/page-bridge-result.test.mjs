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
      { agent },
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
      { agent },
    ),
  );
  assert.equal(result.error, "PAGE_TOOL_PENDING");
  assert.deepEqual(cancelled, { id: sessionId, toolCallId: "call-timeout" });
});
