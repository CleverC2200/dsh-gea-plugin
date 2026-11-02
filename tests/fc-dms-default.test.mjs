import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { DmsClient } from "../src/host/dms-orders.ts";
import {
  resolveFcDmsDeployment,
  FC_DMS_TEST_GATEWAY,
  FC_DMS_PRODUCTION_GATEWAY,
} from "../src/host/fc-dms-default.ts";
const built = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts';export {createCapabilityRegistry} from './src/capability/registry.ts';",
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
const { Business, createCapabilityRegistry } = module.exports;
function fixture(t, dms) {
  const business = new Business({
    geaBaseUrl: "https://formal-gea.fixture",
    requestTimeoutMs: 1000,
    ...(dms ? { dms } : {}),
  });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://formal-gea.fixture",
    auth: {
      token: "gea-fixture",
      tenantId: "0",
      id: "user-a",
      name: "Fixture",
      username: "workcode-a",
    },
  });
  business.setCapabilities(
    createCapabilityRegistry([
      {
        id: "inventory-fc",
        label: "FC",
        enabled: true,
        maxEffect: "view",
        skills: [],
        routing: { keywords: [], summary: "FC" },
        data: { consumerCode: "branch-inventory", tables: [], rules: [] },
      },
    ]),
  );
  t.after(() => business.dispose());
  return business;
}
function secret(t) {
  const previous = process.env.GEA_DMS_PRODUCTION_SECRET;
  process.env.GEA_DMS_PRODUCTION_SECRET = "production-fixture-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.GEA_DMS_PRODUCTION_SECRET;
    else process.env.GEA_DMS_PRODUCTION_SECRET = previous;
  });
}
function profile(id, workNo = id + "-work") {
  return Response.json({
    success: true,
    code: 200,
    result: {
      userInfo: { id, loginTenantId: "0", username: id + "-account", workNo },
    },
  });
}
test("production uses the current verified GEA employee for every login", async (t) => {
  secret(t);
  const business = fixture(t),
    requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/sys/user/getUserInfo")) {
      assert.equal(init.headers["X-Tenant-Id"], "0");
      return profile(business.auth.id);
    }
    requests.push({
      url: String(url),
      body: JSON.parse(new URLSearchParams(init.body).get("ssoToken")),
    });
    return Response.json({
      success: true,
      code: 200,
      result: {
        access_token: "fixture",
        redirect: "https://dms.fixture/user/loginSSO?token=fixture",
      },
    });
  });
  for (const id of ["user-a", "user-b"]) {
    business.auth.id = id;
    await business.branchDms({ operation: "login" }, new AbortController().signal);
  }
  assert.deepEqual(
    requests.map((r) => r.body.workcode),
    ["user-a-work", "user-b-work"],
  );
  assert.ok(
    requests.every(
      (r) => r.url === FC_DMS_PRODUCTION_GATEWAY + "/auth/oauthout/ssoLogin" && !r.body.username,
    ),
  );
});
test("legacy test deployments and static user mappings cannot select the production user", () => {
  const identity = {
    tenantId: "0",
    id: "current",
    workNo: "current-work",
    username: "current-account",
  };
  const old = {
    gatewayUrl: FC_DMS_TEST_GATEWAY,
    secretEnv: "GEA_DMS_TEST_SECRET",
    users: [{ tenantId: "0", userId: "current", username: "fixed-test" }],
  };
  const config = resolveFcDmsDeployment({ production: old }, "production", identity);
  assert.equal(config.gatewayUrl, FC_DMS_PRODUCTION_GATEWAY);
  assert.equal(config.secretEnv, "GEA_DMS_PRODUCTION_SECRET");
  assert.equal(config.credentialSource, undefined);
  assert.deepEqual(config.users, [{ tenantId: "0", userId: "current", workcode: "current-work" }]);
  const custom = resolveFcDmsDeployment(
    {
      production: {
        ...old,
        gatewayUrl: "https://production.fixture/DMS",
        secretEnv: "PROD_KEY",
      },
    },
    "production",
    identity,
  );
  assert.deepEqual(custom.users, config.users);
  assert.equal(custom.secretEnv, "PROD_KEY");
});
test("missing production signing secret never falls back to bundled sandbox credentials", async (t) => {
  const previous = process.env.GEA_DMS_PRODUCTION_SECRET;
  delete process.env.GEA_DMS_PRODUCTION_SECRET;
  t.after(() => {
    if (previous !== undefined) process.env.GEA_DMS_PRODUCTION_SECRET = previous;
  });
  const config = resolveFcDmsDeployment(undefined, "production", {
    tenantId: "0",
    id: "current",
    username: "account",
  });
  let calls = 0;
  const client = new DmsClient(config, config.users[0], async () => {
    calls++;
    throw Error("unexpected");
  });
  await assert.rejects(client.login(new AbortController().signal), /密钥未配置/);
  assert.equal(calls, 0);
});
test("mismatched profile or changed login blocks DMS before sending", async (t) => {
  secret(t);
  const business = fixture(t);
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.ok(String(url).endsWith("/sys/user/getUserInfo"));
    return profile("other");
  });
  await assert.rejects(
    business.branchDms({ operation: "login" }, new AbortController().signal),
    /身份核验失败/,
  );
  t.mock.method(globalThis, "fetch", async () => {
    business.auth = { ...business.auth, id: "new-user" };
    return profile("user-a");
  });
  await assert.rejects(
    business.branchDms({ operation: "login" }, new AbortController().signal),
    /STALE_LOGIN/,
  );
});
test("missing employee number uses only the verified account, never display name", () => {
  const config = resolveFcDmsDeployment(undefined, "production", {
    tenantId: "0",
    id: "current",
    username: "verified-account",
  });
  assert.deepEqual(config.users, [
    { tenantId: "0", userId: "current", username: "verified-account" },
  ]);
  const missing = resolveFcDmsDeployment(undefined, "production", {
    tenantId: "0",
    id: "current",
  });
  assert.throws(() => new DmsClient(missing, missing.users[0]).assertConfigured(), /登录账号/);
});
test("explicit test environment retains test-only credential boundary", async () => {
  const config = resolveFcDmsDeployment(undefined, "test", {
    tenantId: "0",
    id: "current",
  });
  assert.equal(config.gatewayUrl, FC_DMS_TEST_GATEWAY);
  const client = new DmsClient(
    { ...config, gatewayUrl: FC_DMS_PRODUCTION_GATEWAY },
    config.users[0],
  );
  await assert.rejects(client.login(new AbortController().signal), /固定测试网关/);
});

test("production submission preserves the current form and uses current user; identical retry does not resend", async t => {
  secret(t);
  const business=fixture(t);
  const directory=await mkdtemp(join(tmpdir(),"dms-production-fixture-"));
  business.config.runtimeDir=directory;
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const orders=[];
  t.mock.method(globalThis,"fetch",async(url,init)=>{
    if(String(url).endsWith("/sys/user/getUserInfo")) return profile("user-a");
    if(String(url).endsWith("/ssoLogin")) {
      const body=JSON.parse(new URLSearchParams(init.body).get("ssoToken"));
      assert.equal(body.workcode,"user-a-work");
      return Response.json({success:true,code:200,result:{access_token:"fixture-access",redirect:"https://dms.fixture/user/loginSSO?token=fixture"}});
    }
    assert.equal(String(url), FC_DMS_PRODUCTION_GATEWAY+"/dms/order/dmsOrderHead/submitZcOrderDirect");
    assert.equal(init.headers.Authorization,"Bearer fixture-access");
    const order=JSON.parse(init.body);orders.push(order);
    assert.equal(order.customerCode,"entered-customer");
    assert.equal(order.addressCode,"entered-address");
    assert.equal(order.pupCode,"07");
    assert.deepEqual(order.itemList,[{productCode:"selected-sku",quantity:17}]);
    return Response.json({success:true,code:200,result:{aiPreOrderCode:order.aiPreOrderCode,orderCode:"fixture-order"}});
  });
  const payload={operation:"submit",warehouseCode:"selected-warehouse",order:{aiPreOrderCode:"current-form",customerCode:"entered-customer",addressCode:"entered-address",pupCode:"07",itemList:[{productCode:"selected-sku",quantity:17}]}};
  const first=await business.branchDms(payload,new AbortController().signal);
  const again=await business.branchDms(payload,new AbortController().signal);
  assert.equal(first.orderCode,"fixture-order");
  assert.equal(again.orderCode,first.orderCode);
  assert.equal(orders.length,1);
});
