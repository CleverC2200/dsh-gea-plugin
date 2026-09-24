/**
 * 销售计划查询的字段容错。
 *
 * 线上实测（session-2bb0684f）：模型调 `kind=versionSkus` 时顺手带上了 detail 的 planId，
 * 校验只允许 versionId/pageNo/pageSize，于是同一轮连报 5 次 INVALID_QUERY、白烧 5 次调用。
 * 这里钉住"多余但无害的字段丢掉继续跑、真正用错的字段仍然报可读原因"。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/host/business.ts"],
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
const { normalizePlanQuery } = module.exports;

test("versionSkus：带上 detail 的 planId 不再报错（只丢多余字段）", () => {
  assert.deepEqual(
    normalizePlanQuery("versionSkus", {
      planId: "p-1",
      versionId: "p-1-1",
      pageNo: 1,
      pageSize: 200,
    }),
    { versionId: "p-1-1", pageNo: 1, pageSize: 200 },
  );
});

test("versionSkus：只给 planId（没有 versionId）仍然报错，并说清该给什么", () => {
  assert.throws(
    () => normalizePlanQuery("versionSkus", { planId: "p-1" }),
    /INVALID_QUERY: kind=versionSkus accepts only versionId/,
  );
});

test("detail：顺手带的分页参数被丢掉（原有容错保持）", () => {
  assert.deepEqual(
    normalizePlanQuery("detail", { planId: "p-1", pageSize: 50 }),
    { planId: "p-1" },
  );
});

test("detail：真给错字段仍然报错", () => {
  assert.throws(
    () => normalizePlanQuery("detail", { versionId: "p-1-1" }),
    /INVALID_QUERY: kind=detail accepts only planId/,
  );
});

test("未知 kind 直接报 INVALID_QUERY", () => {
  assert.throws(() => normalizePlanQuery("nope", {}), /INVALID_QUERY/);
});
