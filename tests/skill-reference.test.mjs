import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const { createRequire } = await import("node:module");
const { outputFiles } = await build({
  entryPoints: ["src/skill-reference.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const module = { exports: {} };
new Function(
  "require",
  "module",
  "exports",
  Buffer.from(outputFiles[0].contents).toString(),
)(createRequire(import.meta.url), module, module.exports);
const { apply } = module.exports;

function fixture() {
  const tools = new Map();
  const reads = [];
  const ctx = {
    effect: (f) => f(),
    inject: (_services, f) => f(ctx),
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool);
        return () => {};
      },
    },
    skills: {
      get: async () => ({
        invocation: { modelInvocable: true },
        resourceBase: { kind: "directory", path: "/suite/skills/scope" },
        content: "先读 [规则](../../references/rules-and-conflicts.md)",
      }),
    },
    fs: {
      processPathFromHostPath: (p) => p,
      resolve: async (p) => ({ displayPath: p }),
      readBytes: async (target) => {
        reads.push(target.displayPath);
        return Buffer.from("规则：按实际期间查询。");
      },
    },
  };
  apply(ctx);
  return { tools, reads, ctx };
}

test("forecast can read a Skill local reference without sending file URI to MCP", async () => {
  const { tools, reads } = fixture();
  const tool = tools.get("gea_skill_reference_read");
  assert.ok(
    tool,
    "Missing local Skill reference reader: model only has MCP resource reader",
  );
  const result = await tool.execute(
    {
      skill: "sinian-forecast-scope",
      path: "../../references/rules-and-conflicts.md",
    },
    {
      signal: new AbortController().signal,
      agent: { session: { header: { cwd: "/workspace" } } },
    },
  );
  assert.match(result, /规则：按实际期间查询/);
  assert.deepEqual(reads, ["/suite/references/rules-and-conflicts.md"]);
  for (const path of [
    "../../secret.txt",
    "file:///etc/passwd",
    "https://example.com",
    "data-artifact://gateway/id",
  ]) {
    await assert.rejects(() =>
      tool.execute(
        { skill: "sinian-forecast-scope", path },
        { signal: new AbortController().signal },
      ),
    );
  }
  assert.equal(reads.length, 1);
});

test("forecast language and resource routing are present before the first model call", async () => {
  const source = await readFile(
    new URL("../presets/gea-readonly/agent.cordis.yml", import.meta.url),
    "utf8",
  );
  assert.match(source, /用户用中文提问时.*进度.*中文/);
  assert.match(source, /gea_skill_reference_read/);
  assert.match(source, /file:\/\//);
});

test("reference reader respects current skill visibility, cancellation and paging", async () => {
  const { tools, reads, ctx } = fixture();
  const reader = tools.get("gea_skill_reference_read");
  const args = {
    skill: "reference-scope",
    path: "../../references/rules-and-conflicts.md",
  };
  const signal = new AbortController().signal;
  for (const input of [{ offset: 0 }, { limit: 501 }])
    await assert.rejects(() =>
      reader.execute({ ...args, ...input }, { signal }),
    );
  const get = ctx.skills.get;
  ctx.skills.get = async () => ({
    ...(await get()),
    invocation: { modelInvocable: false },
  });
  await assert.rejects(() => reader.execute(args, { signal }), /不可用/);
  assert.equal(reads.length, 0);
  ctx.skills.get = get;
  ctx.fs.readBytes = async () => Buffer.from("第一行\n第二行\n第三行");
  const result = JSON.parse(
    await reader.execute({ ...args, offset: 2, limit: 1 }, { signal }),
  );
  assert.equal(result.content, "2\t第二行");
  assert.equal(result.nextOffset, 3);
  assert.equal(result.totalLines, 3);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() =>
    reader.execute(args, { signal: controller.signal }),
  );
});
