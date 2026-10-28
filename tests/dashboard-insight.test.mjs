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
    finish = "stop";
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
        text: "总量：库存100件。\n结构分析：缺口未知。\n建议：核对订单【待人工确认】。",
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
