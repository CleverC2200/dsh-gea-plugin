// 同一轮里的重复读收敛：单键最多认真回 2 次；一轮累计重复到上限就停手。
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/host/repeat-guard.ts';",
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

test("单键前两次放行，第三次起只回提示；不同 key 互不影响", () => {
  const guard = m.createRepeatGuard();
  assert.equal(guard.note("s1", "catalog|"), "fresh");
  assert.equal(guard.note("s1", "catalog|"), "fresh");
  assert.equal(guard.note("s1", "catalog|"), "repeat");
  // 换个 key（比如另一个模型/另一条查询）还是 fresh
  assert.equal(guard.note("s1", "catalog|agents_sales_plan_detail_mi"), "fresh");
  // 换个会话也算新的
  assert.equal(guard.note("s2", "catalog|"), "fresh");
});

test("一轮里重复累计到上限就 stop（线上 117 步那种循环要被拦住）", () => {
  const guard = m.createRepeatGuard({ perKey: 1, perTurn: 3 });
  assert.equal(guard.note("s1", "a"), "fresh");
  assert.equal(guard.note("s1", "a"), "repeat"); 
  assert.equal(guard.note("s1", "b"), "fresh");
  assert.equal(guard.note("s1", "b"), "repeat"); 
  assert.equal(guard.note("s1", "c"), "fresh");
  assert.equal(guard.note("s1", "c"), "stop"); 
  assert.equal(guard.repeats("s1"), 3);
});

test("clear 之后重新计数（换身份或新一轮）", () => {
  const guard = m.createRepeatGuard({ perKey: 1, perTurn: 2 });
  assert.equal(guard.note("s1", "a"), "fresh");
  assert.equal(guard.note("s1", "a"), "repeat");
  guard.clear();
  assert.equal(guard.repeats("s1"), 0);
  assert.equal(guard.note("s1", "a"), "fresh");
});
