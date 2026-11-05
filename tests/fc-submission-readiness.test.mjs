import test from "node:test";
import assert from "node:assert/strict";
import {
  checkFcDmsOrderTarget,
  checkFcSubmissionReadiness,
} from "../src/host/fc-submission-readiness.ts";
const identity = { tenantId: "T1", userId: "U1" };
const dms = {
  gatewayUrl: "https://fixture.test/DMS",
  secretEnv: "FC_PREFLIGHT_FIXTURE_SECRET",
  users: [{ ...identity, username: "fixture" }],
};
const order = {
  aiPreOrderCode: "AI1",
  customerCode: "C1",
  addressCode: "A1",
  pupCode: "01",
  itemList: [{ productCode: "SKU1", quantity: 10 }],
};
test("DMS preflight validates account, secret and order without a GEA write dependency", (t) => {
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
  const check = (d = dms, w = "001", o = order) => checkFcSubmissionReadiness(d, identity, w, o);
  assert.throws(() => check(), /密钥未配置/);
  process.env.FC_PREFLIGHT_FIXTURE_SECRET = "fixture-secret-only";
  assert.throws(() => check({ ...dms, users: [] }), /用户映射/);
  assert.throws(() => check({ ...dms, users: [...dms.users, ...dms.users] }), /用户映射/);
  assert.throws(() => check(dms, ""), /分仓编码/);
  assert.throws(() => check(dms, "001", { ...order, itemList: [] }), /产品明细/);
  assert.deepEqual(check(), { ready: true, scope: "dms-direct" });
  assert.equal(requests, 0);
  assert.doesNotMatch(JSON.stringify(check()), /fixture-secret|username|access_token/);
});

test("DMS preflight works without optional GEA submission storage", (t) => {
  const before = process.env.FC_PREFLIGHT_FIXTURE_SECRET;
  process.env.FC_PREFLIGHT_FIXTURE_SECRET = "fixture-secret-only";
  t.after(() => {
    if (before === undefined) delete process.env.FC_PREFLIGHT_FIXTURE_SECRET;
    else process.env.FC_PREFLIGHT_FIXTURE_SECRET = before;
  });
  assert.deepEqual(checkFcSubmissionReadiness(dms, identity, "001", order), {
    ready: true,
    scope: "dms-direct",
  });
});

test("DMS submission routing matches governed warehouse, customer, address and pickup", () => {
  const target = {
    warehouseCode: "001",
    fields: { customerCode: "C1", addressCode: "A1", pupCode: "01" },
    addresses: [{ code: "A1", name: "收货地" }],
    message: "",
  };
  assert.equal(checkFcDmsOrderTarget("001", order, target).customerCode, "C1");
  for (const changed of [
    { ...target, warehouseCode: "OTHER" },
    { ...target, fields: { ...target.fields, customerCode: "C2" } },
    { ...target, fields: { ...target.fields, addressCode: "A2" } },
    { ...target, fields: { ...target.fields, pupCode: "02" } },
    { ...target, fields: { customerCode: "", addressCode: "", pupCode: "" } },
  ])
    assert.throws(() => checkFcDmsOrderTarget("001", order, changed), /收货信息/);
});
