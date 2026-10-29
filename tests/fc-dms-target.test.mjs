import test from "node:test";
import assert from "node:assert/strict";
import { resolveFcDmsTarget, FC_DMS_TARGET_SQL } from "../src/host/fc-dms-target.ts";
const signal = new AbortController().signal;
test("unmatched warehouse leaves manual fields and never guesses a code", async () => {
  let calls = 0;
  const r = await resolveFcDmsTarget(
    "A160",
    "",
    async (q) => {
      calls++;
      assert.equal(q.parameters.gea_p1, "A160");
      return { rows: [] };
    },
    signal,
  );
  assert.deepEqual(r.fields, { addressCode: "", customerCode: "", pupCode: "" });
  assert.equal(calls, 1);
});
test("unique exact warehouse/customer name and one coded ship-to fill only known fields", async () => {
  const row = {
    warehouse_code: "A160",
    warehouse_name: "南京分仓",
    customer_code: "49001039",
    customer_name: "南京分仓",
    receive_addresses: JSON.stringify([{ cust_code: "49001039", cust_name: "南京分仓" }]),
  };
  const r = await resolveFcDmsTarget("A160", "", async () => ({ rows: [row] }), signal);
  assert.deepEqual(r.fields, { addressCode: "49001039", customerCode: "49001039", pupCode: "" });
  assert.match(r.message, /按分仓名称/);
  const multiple = await resolveFcDmsTarget(
    "A160",
    "",
    async () => ({
      rows: [
        { ...row, receive_addresses: JSON.stringify([{ cust_code: "A1" }, { cust_code: "A2" }]) },
      ],
    }),
    signal,
  );
  assert.equal(multiple.fields.addressCode, "");
  assert.equal(multiple.fields.customerCode, "49001039");
  const conflict = await resolveFcDmsTarget("A160", "", async () => ({ rows: [row, row] }), signal);
  assert.deepEqual(conflict.fields, { addressCode: "", customerCode: "", pupCode: "" });
});
test("exact address resolves customer and first default pickup; preserves leading zeros", async () => {
  const r = await resolveFcDmsTarget(
    "A160",
    " 49001039 ",
    async (q) => {
      assert.deepEqual(q.parameters, { gea_p1: "49001039" });
      assert.equal(q.sql, FC_DMS_TARGET_SQL);
      assert.match(q.sql, /p.is_default_shipping=TRUE/);
      assert.doesNotMatch(q.sql, /hive\.|data_service\.|OVER\s*\(|DISTINCT ON/);
      return { rows: [{ address_code: "49001039", customer_code: "49001039", pup_code: "02" }] };
    },
    signal,
  );
  assert.deepEqual(r.fields, { addressCode: "49001039", customerCode: "49001039", pupCode: "02" });
});
test("ambiguous customer does not assign a pickup; absent pickup can be supplied manually", async () => {
  for (const [customer, pickup] of [
    [null, "02"],
    ["C1", null],
  ]) {
    const r = await resolveFcDmsTarget(
      "W1",
      "A1",
      async () => ({ rows: [{ address_code: "A1", customer_code: customer, pup_code: pickup }] }),
      signal,
    );
    assert.equal(r.fields.customerCode, customer ?? "");
    assert.equal(r.fields.pupCode, "");
  }
});
test("permission rejection is attempted once and becomes explicit manual fallback; cancellation stays cancelled", async () => {
  let calls = 0;
  const r = await resolveFcDmsTarget(
    "W1",
    "A1",
    async () => {
      calls++;
      throw Error("RESOURCE_NOT_IN_DATASET");
    },
    signal,
  );
  assert.equal(calls, 1);
  assert.match(r.message, /RESOURCE_NOT_IN_DATASET/);
  assert.equal(r.fields.customerCode, "");
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    resolveFcDmsTarget("W1", "A1", async () => ({ rows: [] }), c.signal),
    (e) => e.name === "AbortError",
  );
});
test("out-of-scope or rejected returned fields never autofill", async () => {
  await assert.rejects(
    resolveFcDmsTarget(
      "W1",
      "A1",
      async () => ({ rows: [{ address_code: "OTHER", customer_code: "C1" }] }),
      signal,
    ),
    /范围不一致/,
  );
  const r = await resolveFcDmsTarget(
    "W1",
    "A1",
    async () => ({
      rows: [{ address_code: "A1", customer_code: "C1" }],
      rejectedColumns: ["pup_code"],
    }),
    signal,
  );
  assert.equal(r.fields.customerCode, "");
});

test("a denied default-pickup lookup preserves the already matched customer and address", async () => {
  let calls = 0;
  const r = await resolveFcDmsTarget(
    "A160",
    "",
    async () => {
      calls++;
      if (calls === 1)
        return {
          rows: [
            {
              warehouse_code: "A160",
              warehouse_name: "南京分仓",
              customer_name: "南京分仓",
              customer_code: "49001039",
              receive_addresses: '[{"cust_code":"49001039"}]',
            },
          ],
        };
      throw Error("RESOURCE_NOT_IN_DATASET");
    },
    signal,
  );
  assert.equal(calls, 2);
  assert.deepEqual(r.fields, { addressCode: "49001039", customerCode: "49001039", pupCode: "" });
  assert.match(r.message, /RESOURCE_NOT_IN_DATASET/);
});
test("only a unique first-default relation fills the pickup automatically", async () => {
  for (const points of [[{ pup_code: "02" }], [{ pup_code: "02" }, { pup_code: "01" }]]) {
    let calls = 0;
    const r = await resolveFcDmsTarget(
      "W1",
      "",
      async () =>
        ++calls === 1
          ? {
              rows: [
                {
                  warehouse_code: "W1",
                  warehouse_name: "分仓",
                  customer_name: "分仓",
                  customer_code: "C1",
                  receive_addresses: '[{"cust_code":"A1"}]',
                },
              ],
            }
          : { rows: points },
      signal,
    );
    assert.equal(r.fields.pupCode, points.length === 1 ? "02" : "");
  }
});
