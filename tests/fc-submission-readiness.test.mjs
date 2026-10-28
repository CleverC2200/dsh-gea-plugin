import test from "node:test";
import assert from "node:assert/strict";
import { checkFcSubmissionReadiness } from "../src/host/fc-submission-readiness.ts";
const identity = { tenantId: "T1", userId: "U1" };
const dms = {
  gatewayUrl: "https://fixture.test/DMS",
  secretEnv: "FC_PREFLIGHT_FIXTURE_SECRET",
  users: [{ ...identity, username: "fixture" }],
};
const storage = {
  published: true,
  dataSourceCode: "fixture-db",
  users: [{ ...identity, warehouses: ["001"] }],
};
const order = {
  aiPreOrderCode: "AI1",
  customerCode: "C1",
  addressCode: "A1",
  pupCode: "01",
  itemList: [{ productCode: "SKU1", quantity: 10 }],
};
test("preflight rejects missing deployment, secret and warehouse binding before any transport", (t) => {
  const previous = process.env.FC_PREFLIGHT_FIXTURE_SECRET;
  const fetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => {
    requests++;
    throw Error("unexpected network");
  };
  t.after(() => {
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.FC_PREFLIGHT_FIXTURE_SECRET;
    else process.env.FC_PREFLIGHT_FIXTURE_SECRET = previous;
  });
  delete process.env.FC_PREFLIGHT_FIXTURE_SECRET;
  const check = (d = dms, s = storage, w = "001", o = order) =>
    checkFcSubmissionReadiness(d, s, identity, w, o);
  assert.throws(() => check(), /密钥未配置/);
  process.env.FC_PREFLIGHT_FIXTURE_SECRET = "fixture-secret-only";
  assert.throws(() => check({ ...dms, users: [] }), /用户映射/);
  assert.throws(() => check({ ...dms, users: [...dms.users, ...dms.users] }), /用户映射/);
  assert.throws(() => check(dms, { ...storage, published: false }), /入库配置/);
  assert.throws(() => check(dms, { ...storage, dataSourceCode: "" }), /入库配置/);
  assert.throws(() => check(dms, storage, "OTHER"), /分仓.*授权/);
  assert.throws(() => check(dms, storage, "001", { ...order, itemList: [] }), /产品明细/);
  assert.deepEqual(check(), { ready: true, scope: "local-configuration" });
  assert.equal(requests, 0);
  assert.doesNotMatch(JSON.stringify(check()), /fixture-secret|username|access_token/);
});
