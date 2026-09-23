/**
 * 同轮元信息去重：同一份目录/成员/工具清单第二次直接回上一次的，并提醒不要重复读。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/host/call-dedup.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
  outdir: "out",
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { createCallDedup, CALL_DEDUP_TTL_MS } = module.exports;

test("第一次原样返回，第二次带提醒；不同的 key 互不影响", () => {
  const dedup = createCallDedup();
  assert.equal(dedup.hit("a"), undefined);
  assert.equal(dedup.remember("a", "目录内容"), "目录内容");
  const again = dedup.hit("a");
  assert.match(again, /目录内容/);
  assert.match(again, /已经给过一次/);
  assert.equal(dedup.hit("b"), undefined);
});

test("重新 remember 会覆盖旧内容", () => {
  const dedup = createCallDedup();
  dedup.remember("k", "旧");
  dedup.remember("k", "新");
  assert.match(dedup.hit("k"), /新/);
  assert.doesNotMatch(dedup.hit("k"), /旧/);
});

test("超过 TTL 就失效（下一轮重新读一次）", () => {
  let now = 1_000_000;
  const dedup = createCallDedup({ ttlMs: 1000, now: () => now });
  dedup.remember("k", "x");
  assert.ok(dedup.hit("k"));
  now += 1001;
  assert.equal(dedup.hit("k"), undefined);
  assert.equal(CALL_DEDUP_TTL_MS, 10 * 60 * 1000);
});

test("身份变化时 clear 掉（缓存里是上一个身份看得见的东西）", () => {
  const dedup = createCallDedup();
  dedup.remember("k", "x");
  dedup.clear();
  assert.equal(dedup.hit("k"), undefined);
});

test("条目数有上限，超了丢最早的", () => {
  const dedup = createCallDedup({ limit: 2 });
  dedup.remember("a", "A");
  dedup.remember("b", "B");
  dedup.remember("c", "C");
  assert.equal(dedup.hit("a"), undefined);
  assert.ok(dedup.hit("b"));
  assert.ok(dedup.hit("c"));
});
