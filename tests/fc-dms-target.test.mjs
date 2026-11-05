import test from "node:test";
import assert from "node:assert/strict";
import { resolveFcDmsTarget, FC_DMS_WAREHOUSE_TARGET_SQL } from "../src/host/fc-dms-target.ts";
const signal = new AbortController().signal;
const source = {
  warehouse_code: "A110",
  warehouse_name: "沈阳分仓",
  customer_code: "C1",
  address_code: "A1",
  pup_code: "01",
  address_name: "收货地址一",
};
const resolve = (rows, selected = "") =>
  resolveFcDmsTarget("A110", selected, async () => ({ rows }), signal);
test("one authorized address fills all three codes, preserving pickup leading zeros", async () => {
  let calls = 0;
  const r = await resolveFcDmsTarget(
    "A110",
    "",
    async (q) => {
      calls++;
      assert.equal(q.sql, FC_DMS_WAREHOUSE_TARGET_SQL);
      assert.deepEqual(q.parameters, { gea_p1: "A110" });
      return { rows: [source] };
    },
    signal,
  );
  assert.equal(calls, 1);
  assert.deepEqual(r.fields, { customerCode: "C1", addressCode: "A1", pupCode: "01" });
  assert.deepEqual(r.addresses, [{ code: "A1", name: "收货地址一" }]);
});
test("multiple addresses require a named choice and do not guess the first address", async () => {
  const rows = [source, { ...source, address_code: "A2", address_name: "收货地址二" }];
  const r = await resolve(rows);
  assert.equal(r.fields.addressCode, "");
  assert.equal(r.addresses.length, 2);
  assert.match(r.message, /请选择收货地址/);
  const chosen = await resolve(rows, "A2");
  assert.deepEqual(chosen.fields, { customerCode: "C1", addressCode: "A2", pupCode: "01" });
});
test("an address belonging to another warehouse cannot be injected", async () => {
  const r = await resolve([source], "OTHER");
  assert.equal(r.fields.addressCode, "");
  assert.equal(r.addresses.length, 0);
  assert.match(r.message, /不属于当前分仓/);
});
test("warehouse routing is based on explicit summary codes, not equal customer names", async () => {
  const r = await resolve([{ ...source, customer_name: "不同名称的分仓客户" }]);
  assert.equal(r.fields.customerCode, "C1");
  await assert.rejects(resolve([{ ...source, warehouse_code: "OTHER" }]), /范围不一致/);
});
test("duplicate identical address rows collapse to one choice", async () => {
  const r = await resolve([source, { ...source }]);
  assert.equal(r.addresses.length, 1);
  assert.equal(r.fields.addressCode, "A1");
});
test("conflicting customer or pickup relations cannot be used for an order", async () => {
  for (const row of [
    { ...source, customer_code: "C2" },
    { ...source, pup_code: "02" },
    { ...source, pup_code: null },
  ]) {
    const r = await resolve([source, row]);
    assert.deepEqual(r.fields, { addressCode: "", customerCode: "", pupCode: "" });
  }
});
test("inconsistent names for one address fail closed", async () => {
  const r = await resolve([source, { ...source, address_name: "冲突地址" }]);
  assert.equal(r.fields.addressCode, "");
  assert.match(r.message, /冲突/);
});
test("permission rejection is not retried and no alternate customer query is used", async () => {
  let calls = 0;
  const r = await resolveFcDmsTarget(
    "A110",
    "",
    async () => {
      calls++;
      throw Error("RESOURCE_NOT_IN_DATASET");
    },
    signal,
  );
  assert.equal(calls, 1);
  assert.equal(r.fields.customerCode, "");
  assert.match(r.message, /RESOURCE_NOT_IN_DATASET/);
});
test("rejected return columns and missing records never become editable fallback codes", async () => {
  for (const result of [
    { rows: [] },
    { rows: [source], rejectedColumns: ["customer_code"] },
    { rows: [source], failure: { reasonCode: "NO_RETURN_COLUMN_ALLOWED" } },
  ]) {
    const r = await resolveFcDmsTarget("A110", "", async () => result, signal);
    assert.equal(r.fields.addressCode, "");
    assert.equal(r.addresses.length, 0);
  }
});
test("cancellation remains cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    resolveFcDmsTarget("A110", "", async () => ({ rows: [] }), controller.signal),
    { name: "AbortError" },
  );
});
test("an incomplete address page is never offered as a complete set", async () => {
  const r = await resolve(
    Array.from({ length: 200 }, (_, i) => ({ ...source, address_code: String(i) })),
  );
  assert.equal(r.addresses.length, 0);
});
test("the governed read uses warehouseid and the enabled summary batch", () => {
  assert.match(FC_DMS_WAREHOUSE_TARGET_SQL, /t\.warehouseid=:gea_p1/);
  assert.match(FC_DMS_WAREHOUSE_TARGET_SQL, /__BRANCH_READY__/);
  assert.match(FC_DMS_WAREHOUSE_TARGET_SQL, /DMS_TARGET/);
  assert.doesNotMatch(
    FC_DMS_WAREHOUSE_TARGET_SQL,
    /agents_dim_dealer|warehouse_transfer_plan|OVER\s*\(/i,
  );
});
