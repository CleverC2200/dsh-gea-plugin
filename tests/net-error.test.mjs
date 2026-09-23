// fetch failed 的翻译：线上那次界面只有 `fetch failed` + UNKNOWN，真实原因在 error.cause 里。
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/shared/net-error.ts';",
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

/** 造一个 undici 形状的失败：TypeError('fetch failed') + cause 带 code/hostname/syscall。 */
const undiciFailure = (code, extra = {}) =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(code), { code, ...extra }),
  });

test("连接被重置：翻成可读原因 + 带 code，不再是 UNKNOWN", () => {
  const error = m.networkError(undiciFailure("ECONNRESET", { syscall: "read", hostname: "gea.synear.cn" }), {
    what: "模型网关 GEA 模型网关",
    stage: "流式读取",
  });
  assert.equal(error.code, "GEA_NETWORK_FAILED");
  assert.match(error.message, /GEA_NETWORK_FAILED/);
  assert.match(error.message, /ECONNRESET/);
  assert.match(error.message, /gea\.synear\.cn/);
  assert.match(error.message, /流式读取/);
  assert.equal(error.message.includes("undefined"), false);
  assert.equal(error.message.includes("UNKNOWN"), false);
});

test("DNS 失败与多地址 AggregateError 都能说清", () => {
  const dns = m.networkError(undiciFailure("ENOTFOUND", { hostname: "gea.example" }), {
    what: "模型网关",
  });
  assert.match(dns.message, /ENOTFOUND/);
  const agg = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect failed"), {
      errors: [
        Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("y"), { code: "ETIMEDOUT" }),
      ],
    }),
  });
  const text = m.networkError(agg, { what: "模型网关" }).message;
  assert.match(text, /ECONNREFUSED/);
  assert.match(text, /ETIMEDOUT/);
});

test("超时单独成类，并写清上限", () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
    name: "TimeoutError",
  });
  const error = m.networkError(timeout, { what: "模型网关", timeoutMs: 300_000 });
  assert.equal(error.code, "GEA_NETWORK_TIMEOUT");
  assert.match(error.message, /300 秒/);
});

test("已有 code 的错误与用户中止保持原样（不重复包装）", () => {
  const http = Object.assign(new Error("GEA_MODEL_HTTP_500"), { code: "GEA_MODEL_HTTP_500" });
  assert.equal(m.networkError(http, { what: "x" }), http);
  const aborted = Object.assign(new TypeError("fetch failed"), {
    cause: { kind: "aborted", reason: { kind: "user" } },
  });
  const readable = m.networkError(aborted, { what: "x" });
  assert.match(readable.message, /GEA_TURN_ABORTED/);
  // dsh 实际就是把 reason 对象本身当拒绝原因抛出来
  const rawReason = m.networkError({ kind: "aborted", reason: { kind: "user" } }, { what: "x" });
  assert.match(rawReason.message, /GEA_TURN_ABORTED/);
});

test("接线：模型流式请求与 GEA 请求出口都走这套翻译", async () => {
  const host = await readFile("src/host.ts", "utf8");
  assert.match(host, /throw networkError\(error, \{/);
  assert.match(host, /stage = "流式读取"/);
  const log = await readFile("src/host/api-log.ts", "utf8");
  assert.match(log, /throw networkError\(error, \{/);
});
