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
test("real repeated read failures still stop at three and cancellation does not clear an existing failure", async (t) => {
  const business = fixture(t);
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    init.signal.throwIfAborted();
    fetches++;
    if (url.endsWith("/session")) return success(url, init);
    throw Error("fixture-read-failure");
  });
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      business.pluginSql(query, new AbortController().signal),
      /GEA SQL 查询服务暂时不可用/,
    );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(business.pluginSql(query, cancelled.signal), { name: "AbortError" });
  await assert.rejects(
    business.pluginSql(query, new AbortController().signal),
    /GEA SQL 查询服务暂时不可用/,
  );
  const before = fetches;
  await assert.rejects(
    business.pluginSql(query, new AbortController().signal),
    /GEA_PLUGIN_RETRY_STOPPED/,
  );
  assert.equal(fetches, before);
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
