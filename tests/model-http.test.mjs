import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

const built = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts';export {networkError} from './src/shared/net-error.ts';export {modelHttpError} from './src/shared/model-http-error.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const mod = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url),
  mod,
  mod.exports,
);
const { Business, networkError, modelHttpError } = mod.exports;

function loggedInBusiness(t) {
  const business = new Business({
    geaBaseUrl: "https://fixture.invalid/gea-boot",
    analysisAgentCode: "aps",
    workbenchCapability: { enabled: true },
    requestTimeoutMs: 1000,
    runtimeDir: "/unused/model-request-fixture",
  });
  const login = (token) =>
    business.restoreDesktopLogin({
      schema: 1,
      environment: "production",
      base: business.base,
      auth: { token, tenantId: "0", id: "fixture-user", name: "Fixture", username: "fixture" },
    });
  login("original-login");
  t.after(() => business.dispose());
  return { business, login };
}

function credentialList() {
  return Response.json({
    success: true,
    result: { records: [{ id: "fixture-credential", status: "ACTIVE" }] },
  });
}

test("the default model route and status use the workbench catalog independently of sales configuration", async (t) => {
  const { business } = loggedInBusiness(t);
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    if (url.includes("/my/list")) return credentialList();
    if (url.includes("/my/claim"))
      return Response.json({
        success: true,
        result: {
          credentialId: "fixture-credential",
          status: "ACTIVE",
          baseUrl: "https://fixture.invalid/ai/v1",
          secret: "fixture-secret",
        },
      });
    assert.equal(url, "https://fixture.invalid/ai/v1/models");
    assert.equal(init.headers["X-GEA-Agent-Code"], "workbench");
    return Response.json({ data: [{ id: "workbench-model", name: "Workbench model" }] });
  });
  const route = await business.modelRoute(new AbortController().signal);
  assert.equal(route.agentCode, "workbench");
  assert.deepEqual(business.status().discoveredModels, ["workbench-model"]);
  assert.equal(business.status().model, "workbench-model");
});

test("cancelling a credential claim preserves cancellation instead of reporting a network failure", async (t) => {
  const { business } = loggedInBusiness(t);
  const controller = new AbortController();
  let entered;
  const claiming = new Promise((resolve) => {
    entered = resolve;
  });
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (String(input).includes("/my/list")) return credentialList();
    assert.match(String(input), /\/my\/claim/);
    entered();
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  });
  const result = business.modelRoute(controller.signal, "aps");
  await claiming;
  controller.abort(new Error("fixture-cancelled"));
  await assert.rejects(result, /STALE_SELECTION|fixture-cancelled/);
  assert.equal(business.status().authenticated, true);
});

test("a late credential-claim 401 cannot expire a replacement login", async (t) => {
  const { business, login } = loggedInBusiness(t);
  let entered;
  let respond;
  const claiming = new Promise((resolve) => {
    entered = resolve;
  });
  t.mock.method(globalThis, "fetch", async (input) => {
    if (String(input).includes("/my/list")) return credentialList();
    assert.match(String(input), /\/my\/claim/);
    entered();
    return new Promise((resolve) => {
      respond = resolve;
    });
  });
  const result = business.modelRoute(new AbortController().signal, "aps");
  await claiming;
  login("replacement-login");
  respond(Response.json({ success: false }, { status: 401 }));
  await assert.rejects(result, /STALE_SELECTION|STALE_LOGIN/);
  assert.equal(business.status().authenticated, true);
  assert.equal(business.desktopLoginSnapshot().auth.token, "replacement-login");
});

test("model error diagnostics redact credentials and never expose proxy HTML", async () => {
  const response = Response.json(
    {
      error: {
        code: "permission_denied",
        message: "fixture-private-secret Bearer private-bearer",
        requestId: "request-fixture",
        traceId: "trace-fixture",
        credential: "unrelated-private-field",
      },
    },
    { status: 403 },
  );
  const error = await modelHttpError(response, "aps", "模型列表读取", ["fixture-private-secret"]);
  assert.match(error.message, /permission_denied/);
  assert.match(error.message, /request-fixture/);
  assert.match(error.message, /trace-fixture/);
  assert.doesNotMatch(
    error.message,
    /fixture-private-secret|private-bearer|unrelated-private-field/,
  );
  const proxy = await modelHttpError(
    new Response("<html>private-proxy-content</html>", { status: 502 }),
    "aps",
    "模型推理",
    [],
  );
  assert.equal(proxy.code, "GEA_MODEL_HTTP_502");
  assert.doesNotMatch(proxy.message, /private-proxy-content|网络.*抖动|重问一次/);
});

test("an APS model-list 403 keeps its denial and identity instead of becoming a network retry", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("/my/list"))
      return Response.json({
        success: true,
        result: { records: [{ id: "fixture-credential", status: "ACTIVE" }] },
      });
    if (url.includes("/my/claim"))
      return Response.json({
        success: true,
        result: {
          credentialId: "fixture-credential",
          status: "ACTIVE",
          baseUrl: "https://fixture.invalid/ai/v1",
          secret: "fixture-secret",
        },
      });
    assert.equal(init.headers["X-GEA-Agent-Code"], "aps");
    return Response.json(
      {
        error: {
          code: "permission_denied",
          type: "invalid_request_error",
          message: "请求的Agent无权访问",
        },
      },
      { status: 403 },
    );
  });
  const business = new Business({
    geaBaseUrl: "https://fixture.invalid/gea-boot",
    analysisAgentCode: "aps",
    workbenchCapability: { enabled: true },
    requestTimeoutMs: 1000,
    runtimeDir: "/unused/model-denial-fixture",
  });
  business.auth = { token: "fixture-login", tenantId: "0", id: "fixture-user" };
  t.after(() => business.dispose());
  await assert.rejects(business.modelRoute(new AbortController().signal, "aps"), (error) => {
    const shown = networkError(error, { what: "GEA 模型网关", stage: "连接" });
    assert.equal(shown.code, "GEA_MODEL_HTTP_403");
    assert.match(shown.message, /permission_denied/);
    assert.match(shown.message, /请求的Agent无权访问/);
    assert.match(shown.message, /aps/);
    assert.doesNotMatch(shown.message, /网络.*抖动|重问一次|代理/);
    return true;
  });
  assert.equal(requests.length, 3, "no automatic retry, Consumer fallback or chat request");
  assert.equal(business.status().authenticated, true, "403 must not log out the user");
});

test("only explicit context rejection on a model inference request receives Core overflow classification", async () => {
  for (const [status, code, message, expected] of [
    [400, "context_length_exceeded", "request rejected", "CONTEXT_WINDOW_EXCEEDED"],
    [413, "invalid_request", "Input exceeds the model context window", "CONTEXT_WINDOW_EXCEEDED"],
    [400, "invalid_request", "max_tokens must be positive", "GEA_MODEL_HTTP_400"],
    [401, "context_length_exceeded", "maximum context length", "GEA_MODEL_HTTP_401"],
    [429, "rate_limit_exceeded", "token limit reached", "GEA_MODEL_HTTP_429"],
    [503, "upstream_error", "maximum context length", "GEA_MODEL_HTTP_503"],
  ]) {
    const error = await modelHttpError(
      Response.json({ error: { code, message, requestId: "request-id" } }, { status }),
      "aps",
      "模型推理",
      [],
    );
    assert.equal(error.code, expected);
    assert.equal(error.details.httpStatus, status);
    assert.equal(error.details.requestId, "request-id");
  }
});
