// 中止与"非 Error 被抛出"的可读化：线上点停止后界面出现 Error: [object Object]。
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/shared/abort.ts';",
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

// dsh 中止时携带的就是这个形状（会话记录 turn/end 里的 reason）。
const abortReason = { kind: "aborted", reason: { kind: "user" } };

test("中止原因（对象）翻成可读的中止说明，不再是 [object Object]", () => {
  const error = m.readableError(abortReason);
  assert.ok(error instanceof Error);
  assert.equal(error.code, "GEA_TURN_ABORTED");
  assert.match(error.message, /已中止/);
  assert.match(error.message, /user/);
  assert.equal(String(error.message).includes("[object Object]"), false);
  assert.equal(m.isAbortError(abortReason), true);
});

test("throwIfAborted：带对象 reason 的中止信号也抛可读错误", () => {
  const controller = new AbortController();
  assert.equal(m.throwIfAborted(controller.signal), undefined);
  controller.abort(abortReason);
  assert.throws(
    () => m.throwIfAborted(controller.signal),
    (error) => {
      assert.match(error.message, /GEA_TURN_ABORTED/);
      assert.equal(error.message.includes("[object Object]"), false);
      return true;
    },
  );
});

test("AbortError / 超时也算中止；普通 Error 原样返回", () => {
  const abortError = Object.assign(new Error("This operation was aborted"), {
    name: "AbortError",
  });
  assert.equal(m.isAbortError(abortError), true);
  assert.equal(m.isAbortError(new Error("别的错")), false);
  const plain = new Error("原样返回");
  assert.equal(m.readableError(plain), plain);
});

test("普通对象被抛出时带出内容与错误码，不再只说 [object Object]", () => {
  const withMessage = m.readableError({ code: "GEA_X", message: "网关说不行" });
  assert.match(withMessage.message, /GEA_X: 网关说不行/);
  const withoutMessage = m.readableError({ foo: "bar", n: 1 });
  assert.match(withoutMessage.message, /"foo":"bar"/);
  assert.equal(withoutMessage.message.includes("[object Object]"), false);
  // 原始值兜底
  assert.equal(m.readableError("字符串错").message, "字符串错");
  assert.equal(m.readableError(undefined).message, "undefined");
});

test("describe：对象给 JSON、超长截断、循环引用不炸", () => {
  assert.equal(m.describe({ a: 1 }), '{"a":1}');
  assert.equal(m.describe("x".repeat(400)).length, 300);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(typeof m.describe(cyclic), "string");
});
