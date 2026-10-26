import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
const built = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts'; export {createCapabilityRegistry} from './src/capability/registry.ts'",
    resolveDir: process.cwd(),
  },
  bundle: true,
  packages: "external",
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
function fixture(t) {
  const business = new module.exports.Business({
    geaBaseUrl: "https://gea.example.test",
    geaEnvironments: {
      production: "https://gea.example.test",
      test: "https://gea-test.example.test",
    },
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 1000,
  });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://gea.example.test",
    auth: {
      token: "fixture-private-token",
      tenantId: "1",
      name: "Test",
      id: "user-1",
      username: "test",
    },
  });
  business.setCapabilities(
    module.exports.createCapabilityRegistry([
      {
        id: "stock",
        label: "Stock",
        maxEffect: "view",
        skills: [],
        routing: { keywords: [], summary: "Stock" },
        data: { consumerCode: "base-safety-stock", tables: [], rules: [] },
      },
    ]),
  );
  t.after(() => business.dispose());
  return business;
}
const query = {
  consumerCode: "base-safety-stock",
  sql: "SELECT sku FROM inventory ORDER BY sku",
  pageNo: 1,
  pageSize: 1,
};
function success(url, init) {
  init.signal.throwIfAborted();
  return Response.json(
    url.endsWith("/session")
      ? {
          success: true,
          result: { accessDecision: { allowed: true }, delegationToken: "fixture-delegation" },
        }
      : { success: true, result: { rows: [{ sku: "A" }], total: 1 } },
  );
}
test("an explicit expired SQL session renews despite a generic authentication reason", async (t) => {
  const business = fixture(t);
  let sessions = 0;
  const tokens = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    init.signal.throwIfAborted();
    if (url.endsWith("/session")) {
      sessions++;
      return Response.json({
        success: true,
        result: { accessDecision: { allowed: true }, delegationToken: `delegation-${sessions}` },
      });
    }
    tokens.push(init.headers["X-Delegation-Token"]);
    if (tokens.length === 1)
      return Response.json({
        success: false,
        errorCode: "AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED",
        failure: { reasonCode: "AUTHENTICATION_FAILED" },
      });
    return success(url, init);
  });
  assert.deepEqual((await business.pluginSql(query, new AbortController().signal)).rows, [
    { sku: "A" },
  ]);
  assert.deepEqual(tokens, ["delegation-1", "delegation-2"]);
  assert.equal(sessions, 2);
  assert.equal(business.status().authenticated, true);
});
for (const errorCode of ["ROW_SCOPE_DENIED", "AI_GATEWAY_SESSION_EXPIRED"])
  test(`SQL 403 ${errorCode} preserves denial without renewing a delegation`, async (t) => {
    const business = fixture(t);
    let sessions = 0;
    let reads = 0;
    t.mock.method(globalThis, "fetch", async (url, init) => {
      if (url.endsWith("/session")) {
        sessions++;
        return success(url, init);
      }
      reads++;
      return Response.json(
        {
          success: false,
          errorCode,
          result: { failure: { reasonCode: "AUTHENTICATION_FAILED" } },
        },
        { status: 403 },
      );
    });
    await assert.rejects(business.pluginSql(query, new AbortController().signal), {
      code: errorCode,
      status: 403,
      retryable: false,
    });
    assert.equal(sessions, 1);
    assert.equal(reads, 1);
    assert.equal(business.status().authenticated, true);
  });

test("three cancelled reads do not trip the consumer failure circuit; a new range can read", async (t) => {
  const business = fixture(t);
  t.mock.method(globalThis, "fetch", async (url, init) => success(url, init));
  for (let i = 0; i < 3; i++) {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(business.pluginSql(query, controller.signal), { name: "AbortError" });
  }
  const result = await business.pluginSql(query, new AbortController().signal);
  assert.deepEqual(result.rows, [{ sku: "A" }]);
});
test("repeated SQL failures remain individual failures and the next explicit read can succeed", async (t) => {
  const business = fixture(t);
  let fetches = 0;
  let failing = true;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    init.signal.throwIfAborted();
    if (url.endsWith("/session")) return success(url, init);
    fetches++;
    if (failing) throw Error("fixture-read-failure");
    return success(url, init);
  });
  for (let i = 0; i < 4; i++)
    await assert.rejects(
      business.pluginSql(query, new AbortController().signal),
      /GEA SQL 查询服务暂时不可用/,
    );
  assert.equal(fetches, 4);
  failing = false;
  const result = await business.pluginSql(query, new AbortController().signal);
  assert.deepEqual(result.rows, [{ sku: "A" }]);
  assert.equal(fetches, 5);
});

test("a current login rejected by SQL delegation preserves its original 401 while invalidating identity", async (t) => {
  const business = fixture(t);

  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ message: "login expired" }, { status: 401 }),
  );
  await assert.rejects(
    business.pluginSql(query, new AbortController().signal),
    (error) => error.code === "GEA_HTTP_401",
  );
  assert.equal(business.status().authenticated, false);
});

for (const transition of ["caller", "logout", "user", "environment"])
  test("late delegation 401 cannot override " + transition + " cancellation", async (t) => {
    const business = fixture(t);

    const controller = new AbortController();
    t.mock.method(globalThis, "fetch", async () => {
      if (transition === "caller") controller.abort();
      else if (transition === "logout") business.logout({});
      else if (transition === "environment") business.selectEnvironment({ environment: "test" });
      else
        business.restoreDesktopLogin({
          schema: 1,
          environment: "production",
          base: "https://gea.example.test",
          auth: {
            token: "fixture-new-user-token",
            tenantId: "1",
            name: "Second",
            id: "user-2",
            username: "second",
          },
        });
      return Response.json({ message: "late login expired" }, { status: 401 });
    });
    await assert.rejects(business.pluginSql(query, controller.signal), { name: "AbortError" });
    if (transition === "caller")
      assert.equal(
        business.status().authenticated,
        true,
        "an abandoned late response does not clear the current login",
      );
    if (transition === "user") assert.equal(business.status().user.id, "user-2");
    if (transition === "environment") assert.equal(business.status().environment, "test");
  });

test("a user switch during login rejection still cancels the old delegated request", async (t) => {
  const business = fixture(t);

  let changed = false;
  const unwatch = business.watchIdentity(() => {
    if (changed || business.status().authenticated) return;
    changed = true;
    business.restoreDesktopLogin({
      schema: 1,
      environment: "production",
      base: "https://gea.example.test",
      auth: {
        token: "fixture-new-user-token",
        tenantId: "1",
        name: "Second",
        id: "user-2",
        username: "second",
      },
    });
  });
  t.after(unwatch);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ message: "login expired" }, { status: 401 }),
  );
  await assert.rejects(business.pluginSql(query, new AbortController().signal), {
    name: "AbortError",
  });
  assert.equal(business.status().user.id, "user-2");
});

test("configured SQL uses the authenticated Consumer delegation and forwards one unchanged named request", async (t) => {
  const business = fixture(t),
    requests = [];
  const configured = {
    consumerCode: "base-safety-stock",
    sql: "SELECT t.sku AS sku FROM inventory AS t WHERE t.sku IN (:gea_p1) ORDER BY t.sku LIMIT :gea_p2 OFFSET :gea_p3",
    parameters: { gea_p1: ["A", "B"], gea_p2: 10, gea_p3: 10 },
    includeTotal: false,
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return success(url, init);
  });
  const result = await business.pluginSql(configured, new AbortController().signal, true);
  assert.deepEqual(result.rows, [{ sku: "A" }]);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/agent\/session$/);
  assert.equal(requests[0].body.agentCode, "base-safety-stock");
  assert.equal(requests[1].headers["X-Delegation-Token"], "fixture-delegation");
  const { consumerCode: _consumerCode, ...expected } = configured;
  assert.deepEqual(requests[1].body, expected);
  business.logout({});
  await assert.rejects(business.pluginSql(configured, new AbortController().signal, true));
  assert.equal(requests.length, 2, "logged-out reads must not reach the gateway");
});

test("four inventory Consumers reuse completed SQL snapshots and explicit refresh bypasses them", async (t) => {
  const business = fixture(t),
    consumers = ["base-safety-stock", "branch-inventory", "full-chain-inventory", "aps"];
  business.setCapabilities(
    module.exports.createCapabilityRegistry(
      consumers.map((consumerCode) => ({
        id: consumerCode,
        label: consumerCode,
        maxEffect: "view",
        skills: [],
        routing: { keywords: [], summary: consumerCode },
        data: { consumerCode, tables: [], rules: [] },
      })),
    ),
  );
  let physicalReads = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.endsWith("/execute")) physicalReads++;
    return success(url, init);
  });
  for (const consumerCode of consumers) {
    const input = { consumerCode, sql: "SELECT t.sku AS sku FROM inventory AS t", parameters: {} };
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await business.pluginSql(input, new AbortController().signal, true)).rows[0].sku,
        "A",
      );
  }
  assert.equal(physicalReads, 4);
  await business.pluginSql(
    {
      consumerCode: consumers[0],
      sql: "SELECT t.sku AS sku FROM inventory AS t",
      parameters: {},
      cacheFreshAfter: Date.now() + 1,
    },
    new AbortController().signal,
    true,
  );
  assert.equal(physicalReads, 5);
  business.setCapabilities(module.exports.createCapabilityRegistry([]));
  await assert.rejects(
    business.pluginSql(
      {
        consumerCode: consumers[0],
        sql: "SELECT t.sku AS sku FROM inventory AS t",
        parameters: {},
      },
      new AbortController().signal,
      true,
    ),
  );
  assert.equal(physicalReads, 5, "current capability must still gate cache hits");
});

test("all four inventory Consumers recover the first empty snapshot and cache the recovered data", async (t) => {
  const business = fixture(t);
  const consumers = ["base-safety-stock", "branch-inventory", "full-chain-inventory", "aps"];
  business.setCapabilities(
    module.exports.createCapabilityRegistry(
      consumers.map((consumerCode) => ({
        id: consumerCode,
        label: consumerCode,
        maxEffect: "view",
        skills: [],
        routing: { keywords: [], summary: consumerCode },
        data: { consumerCode, tables: [], rules: [] },
      })),
    ),
  );
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.endsWith("/session")) return success(url, init);
    requests.push(JSON.parse(init.body));
    return Response.json({
      success: true,
      result: { rows: [{ day: requests.length % 2 ? null : "2026-10-25" }] },
    });
  });
  for (const consumerCode of consumers) {
    const input = {
      consumerCode,
      sql: "SELECT MAX(t.stat_date) AS day FROM inventory AS t",
      parameters: {},
    };
    for (let i = 0; i < 2; i++) {
      const result = await business.pluginSql(
        input,
        new AbortController().signal,
        true,
        undefined,
        true,
      );
      assert.equal(result.rows[0].day, "2026-10-25");
    }
  }
  assert.equal(
    requests.length,
    8,
    "one empty read plus one recovery per Consumer; subsequent reads use cache",
  );
  for (let i = 0; i < requests.length; i += 2) assert.deepEqual(requests[i], requests[i + 1]);
});
