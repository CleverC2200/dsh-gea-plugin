import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const built = await build({
  entryPoints: ["src/host/business.ts"],
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

function fixture(t, config = {}) {
  const business = new module.exports.Business({
    geaBaseUrl: "https://catalog.fixture.invalid/gea",
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 2000,
    workbenchCapability: { enabled: false },
    ...config,
  });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://catalog.fixture.invalid/gea",
    auth: {
      token: "catalog-fixture-token",
      tenantId: "7",
      id: "user-1",
      name: "User",
      username: "user",
    },
  });
  t.after(() => business.dispose());
  return business;
}

const envelope = (result) => ({
  success: true,
  code: 200,
  result,
  requestId: null,
  traceId: null,
  auditId: null,
  errorCode: null,
});
const signal = () => new AbortController().signal;

test("catalog reads the full authorized market with Host credentials independently of the sales Consumer", async (t) => {
  const business = fixture(t);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return Response.json(
      envelope(
        url.endsWith("/market")
          ? [
              {
                id: "2076599088169181186",
                agentCode: "base-safety-stock",
                agentName: "基地库存",
                businessDomain: "supply_chain",
                enterpriseManaged: false,
                applicableRoles: "unrelated-role",
                visibleDepartIds: "another-department",
                externalAuthRef: "private-configuration",
                tenantId: 0,
                sortNo: null,
              },
              { id: "second", agentCode: null, agentName: null, businessDomain: null },
            ]
          : [{ value: "supply_chain", text: "产销协同", description: "lucide:boxes", color: null }],
      ),
    );
  });
  assert.deepEqual(await business.navigationCatalog({}, signal()), {
    agents: [
      {
        id: "2076599088169181186",
        agentCode: "base-safety-stock",
        agentName: "基地库存",
        businessDomain: "supply_chain",
      },
      { id: "second", agentCode: null, agentName: null, businessDomain: null },
    ],
    domains: {
      kind: "available",
      items: [{ value: "supply_chain", text: "产销协同", description: "lucide:boxes" }],
    },
  });
  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "https://catalog.fixture.invalid/gea/aiportal/agent/market",
      "https://catalog.fixture.invalid/gea/sys/dict/getDictItems/business_domain",
    ],
  );
  for (const { init } of requests) {
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.headers["X-Access-Token"], "catalog-fixture-token");
    assert.equal(init.headers["X-Tenant-Id"], "7");
  }
});

test("dictionary failure keeps the market order and a successful empty market stays empty", async (t) => {
  const business = fixture(t);
  let market = [{ id: "b" }, { id: "a", businessDomain: "unknown" }];
  t.mock.method(globalThis, "fetch", async (url) =>
    url.endsWith("/market")
      ? Response.json(envelope(market))
      : Response.json({ message: "Dictionary temporarily unavailable" }, { status: 503 }),
  );
  const catalog = await business.navigationCatalog({}, signal());
  assert.deepEqual(
    catalog.agents.map((item) => item.id),
    ["b", "a"],
  );
  assert.deepEqual(catalog.domains, { kind: "unavailable", message: "业务分类暂不可用" });
  market = [];
  assert.deepEqual((await business.navigationCatalog({}, signal())).agents, []);
});

test("market HTTP and business failures are preserved without trusting success alone or optional tracking fields", async (t) => {
  const business = fixture(t);
  let response = () => Response.json({ message: "当前账号不可访问目录" }, { status: 403 });
  t.mock.method(globalThis, "fetch", async () => response());
  await assert.rejects(business.navigationCatalog({}, signal()), { code: "GEA_HTTP_403" });
  response = () =>
    Response.json({
      ...envelope([]),
      code: 503,
      errorCode: "MARKET_UNAVAILABLE",
      message: "目录暂不可用",
    });
  await assert.rejects(business.navigationCatalog({}, signal()), {
    code: "MARKET_UNAVAILABLE",
    message: "目录暂不可用",
  });
  response = () =>
    Response.json({ ...envelope([]), success: false, message: "访问被拒绝 catalog-fixture-token" });
  await assert.rejects(
    business.navigationCatalog({}, signal()),
    (error) =>
      error.code === "GEA_REQUEST_REJECTED" && !error.message.includes("catalog-fixture-token"),
  );
  response = () => Response.json({ ...envelope([]), code: undefined });
  await assert.rejects(business.navigationCatalog({}, signal()), { code: "GEA_REQUEST_REJECTED" });
  response = () => Response.json(envelope({ records: [] }));
  await assert.rejects(business.navigationCatalog({}, signal()), /NAVIGATION_INVALID_RESPONSE/);
  response = () => Response.json(envelope([{ id: 42 }]));
  await assert.rejects(business.navigationCatalog({}, signal()), /NAVIGATION_INVALID_RESPONSE/);
});

test("both catalog requests belong to one identity epoch and caller cancellation rejects late responses", async (t) => {
  const business = fixture(t);
  let pending;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/market")) return Response.json(envelope([{ id: "old-user" }]));
    pending = Promise.withResolvers();
    return pending.promise;
  });
  const reading = business.navigationCatalog({}, signal());
  while (!pending) await new Promise((resolve) => setImmediate(resolve));
  const old = pending;
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: business.base,
    auth: { token: "new-token", tenantId: "9", id: "user-2", username: "other", name: "Other" },
  });
  old.resolve(Response.json(envelope([{ value: "old", text: "旧用户" }])));
  await assert.rejects(reading);
  pending = undefined;
  const controller = new AbortController();
  const cancelled = business.navigationCatalog({}, controller.signal);
  while (!pending) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  pending.resolve(Response.json(envelope([])));
  await assert.rejects(cancelled);
});

test("catalog expires login on HTTP or business 401 and cannot bypass restricted sales validation", async (t) => {
  const business = fixture(t);
  let dictionary = false;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (dictionary && url.endsWith("/market")) return Response.json(envelope([]));
    return Response.json({ message: "登录过期" }, { status: 401 });
  });
  await assert.rejects(business.navigationCatalog({}, signal()), { code: "GEA_HTTP_401" });
  assert.equal(business.status().loginState, "expired");
  const second = fixture(t);
  dictionary = true;
  await assert.rejects(second.navigationCatalog({}, signal()));
  assert.equal(second.status().authenticated, false);
  const third = fixture(t);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ success: false, code: 401, message: "登录过期" }),
  );
  await assert.rejects(third.navigationCatalog({}, signal()));
  assert.equal(third.status().loginState, "expired");
  const restricted = fixture(t, {
    workbenchCapability: {
      enabled: true,
      readonlyValidation: {
        maxRequests: 0,
        periods: 0,
        list: 0,
        detail: 0,
        versionSkus: 0,
        workflowSql: 0,
        maxWorkflowRows: 1,
        metadata: 0,
      },
    },
  });
  await assert.rejects(restricted.navigationCatalog({}, signal()), {
    code: "GEA_SALES_READONLY_OPERATION",
  });
  await assert.rejects(
    fixture(t).navigationCatalog({ tenantId: "0" }, signal()),
    /INVALID_PAYLOAD/,
  );
});
