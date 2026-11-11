import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

const built = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts';export {networkError} from './src/shared/net-error.ts';export {modelHttpError} from './src/shared/model-http-error.ts';export {modelFailure,modelResponseDetails} from './src/shared/model-failure.ts';",
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
const { Business, networkError, modelHttpError, modelFailure, modelResponseDetails } = mod.exports;

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

test("model recovery preserves permanent rejections and unknown failures", async () => {
  for (const [status, upstreamCode, expected] of [
    [503, "MODEL_UPSTREAM_REJECTED", "GEA_MODEL_HTTP_503"],
    [401, "MODEL_UPSTREAM_TIMEOUT", "GEA_MODEL_HTTP_401"],
    [403, "permission_denied", "GEA_MODEL_HTTP_403"],
    [501, "upstream_error", "GEA_MODEL_HTTP_501"],
    [501, "MODEL_UPSTREAM_UNAVAILABLE", "GEA_MODEL_HTTP_501"],
    [400, "MODEL_UPSTREAM_UNAVAILABLE", "GEA_MODEL_HTTP_400"],
    [502, "MODEL_UPSTREAM_REJECTED", "GEA_MODEL_HTTP_502"],
    [502, "upstream_error", "SERVER"],
  ]) {
    const error = await modelHttpError(
      Response.json({ error: { code: upstreamCode } }, { status }),
      "workbench",
      "模型推理",
      [],
    );
    assert.equal(modelFailure(error).code, expected);
  }
  assert.equal(
    modelFailure(
      networkError(new Error("unexpected application error"), {
        what: "model",
      }),
    ).code,
    "GEA_NETWORK_FAILED",
  );
});

test("model response metadata validates identifiers and provider delays", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-11-11T00:00:00Z"));
  assert.deepEqual(
    modelResponseDetails(
      new Headers({
        "X-Request-Id": "safe-request",
        "X-Trace-Id": "safe-trace",
        "Retry-After": "1.5",
      }),
      [],
    ),
    {
      requestId: "safe-request",
      traceId: "safe-trace",
      providerRetryAfterMs: 1500,
    },
  );
  assert.equal(
    modelResponseDetails(new Headers({ "Retry-After": "Wed, 11 Nov 2026 00:00:02 GMT" }), [])
      .providerRetryAfterMs,
    2000,
  );
  for (const value of ["not-a-delay", "0", "-1", "Infinity"])
    assert.equal(
      modelResponseDetails(new Headers({ "Retry-After": value }), []).providerRetryAfterMs,
      undefined,
    );
  assert.deepEqual(
    modelResponseDetails(
      new Headers({
        "X-Request-Id": "fixture-secret",
        "X-Trace-Id": "x".repeat(129),
      }),
      ["fixture-secret"],
    ),
    {},
  );
});

const officialMetadata = {
  id: "fixture-model",
  provider: "DEEPSEEK",
  modelName: "deepseek-flash",
  baseUrl: "https://api.deepseek.com/v1",
};
for (const [label, declared, metadata, expected, reads] of [
  ["catalog capacity wins", 262144, officialMetadata, 262144, 0],
  ["official default without catalog capacity", undefined, officialMetadata, 1000000, 1],
  [
    "metadata capacity wins over default",
    undefined,
    { ...officialMetadata, contextWindow: 131072 },
    131072,
    1,
  ],
  [
    "metadata parameters win over default",
    undefined,
    { ...officialMetadata, modelParams: '{"contextWindow":65536}' },
    65536,
    1,
  ],
  ["invalid catalog capacity falls back", 0, officialMetadata, 1000000, 1],
  [
    "other provider remains unknown",
    undefined,
    { ...officialMetadata, provider: "VLLM" },
    undefined,
    1,
  ],
  [
    "proxy remains unknown",
    undefined,
    { ...officialMetadata, baseUrl: "https://proxy.invalid/v1" },
    undefined,
    1,
  ],
  [
    "lookalike official hostname remains unknown",
    undefined,
    { ...officialMetadata, baseUrl: "https://api.deepseek.com.evil.invalid/v1" },
    undefined,
    1,
  ],
  [
    "unknown wire model remains unknown",
    undefined,
    { ...officialMetadata, modelName: "unknown-model" },
    undefined,
    1,
  ],
  [
    "mismatched model metadata remains unknown",
    undefined,
    { ...officialMetadata, id: "other-model" },
    undefined,
    1,
  ],
  ["metadata denial does not disable an authorized route", undefined, undefined, undefined, 1],
]) {
  test("model discovery capacity: " + label, async (t) => {
    const { business } = loggedInBusiness(t);
    let metadataReads = 0;
    t.mock.method(globalThis, "fetch", async (input) => {
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
      if (url.endsWith("/models"))
        return Response.json({
          data: [
            {
              id: "fixture-model",
              name: "deepseek-flash",
              ...(declared === undefined ? {} : { contextWindow: declared }),
            },
          ],
        });
      assert.match(url, /\/airag\/airagModel\/queryById\?id=fixture-model$/);
      metadataReads++;
      return metadata
        ? Response.json({ success: true, result: metadata })
        : Response.json({ success: false }, { status: 403 });
    });
    const route = await business.modelRoute(new AbortController().signal);
    assert.equal(route.contextWindows["fixture-model"], expected);
    assert.equal(metadataReads, reads);
    assert.deepEqual(route.models, ["fixture-model"]);
    assert.equal(business.status().authenticated, true);
    await business.modelRoute(new AbortController().signal);
    assert.equal(metadataReads, reads);
  });
}

for (const failure of [503, 429, "network", "timeout"]) {
  test("model metadata recovers in the same login after " + failure, async (t) => {
    const { business } = loggedInBusiness(t);
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const calls = { list: 0, claim: 0, models: 0, metadata: 0 };
    t.mock.method(globalThis, "fetch", async (input) => {
      const url = String(input);
      if (url.includes("/my/list")) {
        calls.list++;
        return credentialList();
      }
      if (url.includes("/my/claim")) {
        calls.claim++;
        return Response.json({
          success: true,
          result: {
            credentialId: "fixture-credential",
            status: "ACTIVE",
            baseUrl: "https://fixture.invalid/ai/v1",
            secret: "fixture-secret",
          },
        });
      }
      if (url.endsWith("/models")) {
        calls.models++;
        return Response.json({ data: [{ id: "fixture-model", name: "deepseek-flash" }] });
      }
      assert.match(url, /queryById/);
      if (++calls.metadata === 1) {
        if (failure === "network") throw new TypeError("fetch failed");
        if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError");
        return Response.json({ success: false }, { status: failure });
      }
      return Response.json({ success: true, result: officialMetadata });
    });
    const first = await business.modelRoute(new AbortController().signal);
    assert.equal(first.contextWindows["fixture-model"], undefined);
    assert.equal(await business.modelRoute(new AbortController().signal), first);
    assert.equal(calls.metadata, 1);
    now += 30001;
    const recovered = await business.modelRoute(new AbortController().signal);
    assert.equal(recovered.contextWindows["fixture-model"], 1000000);
    assert.deepEqual(calls, { list: 1, claim: 1, models: 1, metadata: 2 });
    now += 30001;
    assert.equal(await business.modelRoute(new AbortController().signal), recovered);
    assert.equal(calls.metadata, 2);
    assert.equal(first.contextWindows["fixture-model"], undefined);
  });
}

for (const change of ["cancel", "login"]) {
  test("late metadata refresh cannot publish after " + change, async (t) => {
    const { business, login } = loggedInBusiness(t);
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    let metadataReads = 0;
    let release;
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    t.mock.method(globalThis, "fetch", async (input) => {
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
      if (url.endsWith("/models"))
        return Response.json({ data: [{ id: "fixture-model", name: "Fixture" }] });
      if (++metadataReads === 1) return Response.json({ success: false }, { status: 503 });
      if (metadataReads === 2) {
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return Response.json({
        success: true,
        result: { ...officialMetadata, contextWindow: 65536 },
      });
    });
    await business.modelRoute(new AbortController().signal);
    now += 30001;
    const controller = new AbortController();
    const pending = business.modelRoute(controller.signal);
    const rejected = assert.rejects(pending, /STALE_SELECTION|fixture-cancelled/);
    await started;
    if (change === "login") login("replacement-login");
    else controller.abort(new Error("fixture-cancelled"));
    release(Response.json({ success: true, result: officialMetadata }));
    await rejected;
    const route = await business.modelRoute(new AbortController().signal);
    assert.equal(route.contextWindows["fixture-model"], 65536);
    assert.equal(metadataReads, 3);
  });
}

for (const [label, error, expected] of [
  [
    "IPv4 and IPv6 connection failures",
    new TypeError("fetch failed", {
      cause: new AggregateError([
        Object.assign(new Error("v4"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("v6"), { code: "ENETUNREACH" }),
      ]),
    }),
    "TRANSPORT",
  ],
  [
    "all address attempts timed out",
    new TypeError("fetch failed", {
      cause: new AggregateError([
        Object.assign(new Error("v4"), { code: "ETIMEDOUT" }),
        Object.assign(new Error("v6"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
      ]),
    }),
    "TIMEOUT",
  ],
  [
    "direct transport error",
    Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
    "TRANSPORT",
  ],
  [
    "aggregate includes an unknown application error",
    new TypeError("fetch failed", {
      cause: Object.assign(
        new AggregateError([
          Object.assign(new Error("v4"), { code: "ECONNREFUSED" }),
          new Error("application failed"),
        ]),
        { code: "ECONNREFUSED" },
      ),
    }),
    "GEA_NETWORK_FAILED",
  ],
]) {
  test("model transport classification: " + label, () => {
    const converted = networkError(error, { what: "fixture model" });
    assert.equal(modelFailure(converted).code, expected);
  });
}
