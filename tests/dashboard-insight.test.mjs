import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir(".scratch", { recursive: true });
const result = await build({
  entryPoints: ["src/host/dashboard-insight.ts"],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  write: false,
});
await writeFile(".scratch/dashboard-insight.mjs", result.outputFiles[0].text);
const { createDashboardInsightGenerator } = await import("../.scratch/dashboard-insight.mjs");
const owner = {
  session: "session-base-fixture",
  principal: "user-A",
  consumer: "base-safety-stock",
  promptPath: "/installed/insight-prompt.md",
};
const input = { evidence: { metrics: { current: 100, target: 80 }, missing: ["orders"] } };
function fixture() {
  let time = 1000,
    calls = [],
    allowed = true,
    prompt = "用户提供的提示词",
    finish = "stop",
    answer = "总量：库存100件。\n结构分析：缺口未知。\n建议：核对订单【待人工确认】。";
  const generate = createDashboardInsightGenerator({
    authorize: async () => {
      if (!allowed) throw Error("DENIED");
    },
    prompt: async () => prompt,
    model: async () => "base-model",
    now: () => time,
    stream: async function* (options) {
      calls.push(options);
      yield {
        type: "text-delta",
        text: answer,
      };
      yield { type: "finish", reason: { kind: finish } };
    },
  });
  return {
    generate,
    calls,
    time: (v) => (time = v),
    allow: (v) => (allowed = v),
    prompt: (v) => (prompt = v),
    finish: (v) => (finish = v),
    answer: (v) => (answer = v),
  };
}
test("uses bound GEA session and immutable prompt; model receives evidence as data with no tools", async () => {
  const f = fixture();
  const r = await f.generate(owner, input, new AbortController().signal);
  assert.match(r.answer, /待人工确认/);
  const q = f.calls[0];
  assert.equal(q.sessionId, owner.session);
  assert.equal(q.provider, "gea-analysis");
  assert.equal(q.model, "base-model");
  assert.ok(q.system.startsWith("用户提供的提示词"));
  assert.deepEqual(q.tools, []);
  assert.match(q.messages[0].content[0].text, /"current"/);
  assert.match(JSON.stringify(q.messages), /orders/);
  await assert.rejects(
    f.generate(owner, { ...input, prompt: "override" }, new AbortController().signal),
    /INVALID/,
  );
});
test("20 minute success cache isolates scope, user, session, prompt and forced refresh", async () => {
  const f = fixture(),
    s = new AbortController().signal;
  await f.generate(owner, input, s);
  await f.generate(owner, input, s);
  assert.equal(f.calls.length, 1);
  f.allow(false);
  await assert.rejects(f.generate(owner, input, s), /DENIED/);
  f.allow(true);
  await f.generate({ ...owner, principal: "user-B" }, input, s);
  await f.generate({ ...owner, session: "session-other" }, input, s);
  await f.generate(owner, { evidence: { metrics: { current: 99 } } }, s);
  f.prompt("new");
  await f.generate(owner, input, s);
  assert.equal(f.calls.length, 5);
  f.time(2000);
  await f.generate(owner, { ...input, freshAfter: 1500 }, s);
  assert.equal(f.calls.length, 6);
  f.time(1202001);
  await f.generate(owner, input, s);
  assert.equal(f.calls.length, 7);
});
test("incomplete answers and cancelled requests are never cached", async () => {
  const f = fixture(),
    s = new AbortController().signal;
  f.finish("length");
  await assert.rejects(f.generate(owner, input, s), /INCOMPLETE/);
  f.finish("stop");
  await f.generate(owner, input, s);
  assert.equal(f.calls.length, 2);
  const c = new AbortController();
  c.abort();
  await assert.rejects(f.generate(owner, input, c.signal), { name: "AbortError" });
  let allowed = true,
    calls = 0;
  const run = createDashboardInsightGenerator({
    authorize: async () => {
      if (!allowed) throw Error("REVOKED");
    },
    prompt: async () => "prompt",
    model: async () => "model",
    stream: async function* () {
      calls++;
      yield { type: "text-delta", text: "answer" };
      allowed = false;
      yield { type: "finish", reason: { kind: "stop" } };
    },
  });
  await assert.rejects(run(owner, input, s), /REVOKED/);
  allowed = true;
  await assert.rejects(run(owner, input, s), /REVOKED/);
  assert.equal(calls, 2);
});

test("branch dashboard uses its own one-paragraph prompt and consumer without base-only output instructions", async () => {
  const f = fixture();
  f.prompt("分仓规则：150–200字，不换行。{{按第 3 节字段注入，缺失字段注明「缺失」}}");
  f.answer(
    "当前可用库存46.2万件，高于目标37.8万件，但仍有1.9万件订单缺口，整体偏高与局部缺货并存，应按结构矛盾处理。缺口集中在饺子和汤圆，合计占63%，面点库存偏高；现有证据只能确认品类分布，不能判断具体SKU的规格或批次原因。建议今日优先复核饺子、汤圆缺口SKU与备单占用，确认紧急补货范围；本周控制面点新增补货并安排去化【待人工确认】。",
  );
  const branch = {
    ...owner,
    consumer: "branch-inventory",
    promptPath: "/installed/fc/insight-prompt.md",
  };
  await f.generate(branch, input, new AbortController().signal);
  const request = f.calls[0];
  assert.match(request.system, /分仓库存看板/);
  assert.match(request.system, /150–200字/);
  assert.doesNotMatch(request.system, /基地库存看板|第5节|\{\{/);
  assert.match(request.system, /null 表示缺失/);
  assert.deepEqual(request.tools, []);
  await f.generate(owner, input, new AbortController().signal);
  assert.equal(f.calls.length, 2);
});

test("branch invalid format is rewritten at most once and never cached; base behavior remains separate", async () => {
  const f = fixture(),
    branch = { ...owner, consumer: "branch-inventory" };
  f.answer("过短的建议【待人工确认】。");
  await assert.rejects(f.generate(branch, input, new AbortController().signal), /FORMAT_INVALID/);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].messages[1].content[0].text, /格式未通过/);
  await assert.rejects(f.generate(branch, input, new AbortController().signal), /FORMAT_INVALID/);
  assert.equal(f.calls.length, 4);
});
