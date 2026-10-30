import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { DmsClient } from "../src/host/dms-orders.ts";
import { resolveFcDmsDeployment, FC_DMS_TEST_GATEWAY } from "../src/host/fc-dms-default.ts";
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
test("installed formal GEA opens only test DMS without machine-specific DMS configuration", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url: String(url), body: new URLSearchParams(init.body) });
    return Response.json({
      success: true,
      code: 200,
      result: {
        access_token: "test-access-fixture",
        redirect: "https://dms.fixture/user/loginSSO?token=fixture-ticket&menu=/corder/ordermgt",
      },
    });
  });
  const business = fixture(t);
  for (const id of ["user-a", "user-b"]) {
    business.auth.id = id;
    const result = await business.branchDms({ operation: "login" }, new AbortController().signal);
    assert.match(result.redirect, /loginSSO/);
    assert.equal(business.status().environment, "production");
    assert.equal(business.status().user.id, id);
  }
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, "http://100.100.1.147:8000/synear_test/DMS/auth/oauthout/ssoLogin");
    const body = JSON.parse(request.body.get("ssoToken"));
    assert.equal(body.username, "zhangxin");
    assert.equal(body.menu, "/corder/ordermgt");
    assert.match(body.sign, /^[a-f0-9]{32}$/);
  }
});
test("an explicit deployment with no matching user remains denied, without sandbox fallback", async (t) => {
  const business = fixture(t, {
    production: {
      gatewayUrl: "https://custom.fixture/DMS",
      secretEnv: "UNCONFIGURED_FIXTURE",
      users: [],
    },
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw Error("must not request");
  });
  await assert.rejects(
    business.branchDms({ operation: "login" }, new AbortController().signal),
    /用户映射/,
  );
  assert.equal(calls, 0);
});

test("legacy per-user settings for the fixed test gateway do not exclude other GEA users", async () => {
  const result = resolveFcDmsDeployment(
    {
      production: {
        gatewayUrl: FC_DMS_TEST_GATEWAY,
        secretEnv: "OLD_LOCAL_ONLY_SECRET",
        users: [{ tenantId: "0", userId: "old-installer", username: "old-test-user" }],
      },
    },
    "production",
    { tenantId: "0", id: "another-user" },
  );
  assert.equal(result.credentialSource, "fc-bundled-dms-test");
  assert.deepEqual(result.users, [{ tenantId: "0", userId: "another-user", username: "zhangxin" }]);
});

test("the bundled test credential cannot sign for a different gateway", async () => {
  const config = resolveFcDmsDeployment(undefined, "production", {
    tenantId: "0",
    id: "user-a",
  });
  for (const url of [
    "https://different.fixture/DMS",
    FC_DMS_TEST_GATEWAY + "/other",
    FC_DMS_TEST_GATEWAY + "?other=1",
  ]) {
    let calls = 0;
    const client = new DmsClient({ ...config, gatewayUrl: url }, config.users[0], async () => {
      calls++;
      throw Error("must not request");
    });
    await assert.rejects(client.login(new AbortController().signal), /固定测试网关|地址配置无效/);
    assert.equal(calls, 0);
  }
});

test("sandbox login availability does not skip confirmation-storage readiness", async (t) => {
  const business = fixture(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw Error("must not request");
  });
  await assert.rejects(
    business.branchDms(
      {
        operation: "preflight",
        warehouseCode: "A030",
        order: {
          aiPreOrderCode: "AI-fixture",
          customerCode: "customer-fixture",
          addressCode: "address-fixture",
          pupCode: "02",
          itemList: [{ productCode: "sku-fixture", quantity: 1 }],
        },
      },
      new AbortController().signal,
    ),
    /分仓业务入库配置未完成/,
  );
  assert.equal(calls, 0);
});
