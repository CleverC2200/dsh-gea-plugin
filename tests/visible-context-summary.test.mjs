import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/host/visible-context-summary.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const m = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].contents).toString("base64"),
);

const snapshot = JSON.stringify({
  source: "GEA_RENDERED_WORKBENCH",
  coverage: "current-visible-page",
  renderedAt: "2026-09-22T07:00:00.000Z",
  context: {
    scope: { month: "2026-10", planType: "dealer", approvalStage: "region" },
    pagination: { page: 1, pageSize: 1, total: 1 },
    evidence: { source: "gea-user-session", completeness: "paged-queue", queryState: "success" },
    visibleRows: [{ id: "row-1", organization: "宝阳销售组", target: "100", plan: "90" }],
    selectedPlanIds: ["plan-1"],
    expandedFields: [],
  },
});

test("页面快照优先交给 DSH 子 Agent，父 Agent 只收到摘要", async () => {
  let request;
  let disposed = false;
  const agent = {
    ctx: {
      get(name) {
        if (name !== "subagents") return undefined;
        return {
        async start(provider, value) {
          request = { provider, value };
          return {
            result: Promise.resolve({
              stopReason: "completed",
              output: [{ type: "text", text: "范围：2026-10 区域审批；宝阳销售组目标 100、计划 90。" }],
            }),
            async dispose() {
              disposed = true;
            },
          };
        },
        };
      },
    },
  };
  const result = JSON.parse(
    await m.summarizeVisibleWorkbenchContext(snapshot, agent, new AbortController().signal),
  );
  assert.equal(result.processor, "dsh-subagent");
  assert.match(result.summary, /宝阳销售组/);
  assert.equal(request.provider, "spawn");
  assert.match(request.value.prompt[0].text, /宝阳销售组/);
  assert.equal(disposed, true);
});

test("子 Agent 不可用时保留可读的本地压缩快照", async () => {
  const result = JSON.parse(
    await m.summarizeVisibleWorkbenchContext(snapshot, {}, new AbortController().signal),
  );
  assert.equal(result.processor, "local-fallback");
  assert.equal(result.visibleRows[0].organization, "宝阳销售组");
  assert.equal(result.rawSnapshotAvailable, undefined);
});

test("非当前页结果不启动子 Agent，避免改变错误语义", async () => {
  let started = false;
  const agent = { ctx: { subagents: { start: async () => { started = true; throw new Error("unexpected"); } } } };
  const result = await m.summarizeVisibleWorkbenchContext('{"coverage":"none"}', agent, new AbortController().signal);
  assert.equal(result, '{"coverage":"none"}');
  assert.equal(started, false);
});
