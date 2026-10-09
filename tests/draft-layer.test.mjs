/**
 * "改草稿"这一层：页面只声明能力，限流/超时/确认/回执统一在这里。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/capability/draft.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const m = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].contents).toString("base64")
);

const request = (overrides = {}) => ({
  sessionId: "session-1",
  surface: "gea-html-inventory-fc",
  kind: "setValue",
  targets: ["field:sku-1:补货量"],
  effect: "draft",
  ...overrides,
});

test("每一次改动都留下可追溯的回执", () => {
  const layer = m.createDraftLayer({ id: (() => {
    let n = 0;
    return () => "draft-" + ++n;
  })(), now: () => 1000 });
  const begun = layer.begin(request({ reason: "用户要求把补货量改成 200" }));
  assert.equal(begun.ok, true);
  const receipt = layer.finish(begun.receiptId, { applied: true });
  assert.equal(receipt.outcome, "applied");
  assert.equal(receipt.surface, "gea-html-inventory-fc");
  assert.equal(receipt.kind, "setValue");
  assert.deepEqual(receipt.targets, ["field:sku-1:补货量"]);
  assert.equal(receipt.durationMs, 0);
  assert.equal(receipt.reason, "用户要求把补货量改成 200");
  assert.equal(layer.receipts().length, 1);
  assert.equal(layer.lastFor("session-1").id, receipt.id);
});

test("失败、超时与被拒也记得下来，不混成同一种结果", () => {
  const layer = m.createDraftLayer();
  const a = layer.begin(request());
  assert.equal(layer.finish(a.receiptId, { applied: false, error: "ELEMENT_GONE" }).outcome, "failed");
  const b = layer.begin(request());
  assert.equal(layer.finish(b.receiptId, { applied: false, error: "PAGE_TOOL_PENDING", timedOut: true }).outcome, "timeout");
  const c = layer.begin(request());
  assert.equal(layer.finish(c.receiptId, { applied: false }).outcome, "rejected");
});

test("同一会话短时间改太频繁会被挡住", () => {
  const layer = m.createDraftLayer({ maxPerWindow: 2, now: () => 1000 });
  assert.equal(layer.begin(request()).ok, true);
  assert.equal(layer.begin(request()).ok, true);
  const blocked = layer.begin(request());
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "DRAFT_RATE_LIMITED");
  assert.match(blocked.reason, /改动太频繁/);
  // 别的会话不受影响。
  assert.equal(layer.begin(request({ sessionId: "session-2" })).ok, true);
});

test("窗口滑过去以后可以继续改，回执只保留最近若干条", () => {
  let at = 1000;
  const layer = m.createDraftLayer({ maxPerWindow: 1, windowMs: 1000, now: () => at });
  assert.equal(layer.begin(request()).ok, true);
  assert.equal(layer.begin(request()).ok, false);
  at += 1500;
  assert.equal(layer.begin(request()).ok, true);

  const bounded = m.createDraftLayer({ maxReceipts: 3, maxPerWindow: 100, now: () => at });
  for (let index = 0; index < 5; index++) bounded.begin(request());
  assert.equal(bounded.receipts().length, 3);
});
