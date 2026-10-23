import test from "node:test";
import assert from "node:assert/strict";
import {
  bindModulePage,
  inheritModuleCubeScope,
  modulePagePrompt,
  moduleScopeSignature,
} from "../src/host/module-page-scope.ts";
const query = (model) => ({
  action: "query",
  queries: [
    {
      name: "test",
      query: {
        measures: [model + ".record_count"],
        filters: [{ member: model + ".region_name", operator: "equals", values: ["original"] }],
      },
    },
  ],
});
test("customer Cube intersects complete filtered customer set and snapshot, without mutating caller", () => {
  const host = { surfaceFor: () => ({ menu: "inventory-customer" }) };
  const c = new AbortController();
  const binding = bindModulePage(host, "s", "inventory-customer", c.signal);
  const args = query("agents_scm_cust_jxc_ai_daliy_d");
  assert.throws(() => inheritModuleCubeScope(host, "s", args), /NOT_READY/);
  binding.observe({
    inventorySnapshot: "2026-10-21",
    filteredCustomerCodes: ["1001", "1002"],
    metrics: [{ label: "库存价值", unit: "万元" }],
  });
  const result = inheritModuleCubeScope(host, "s", args);
  assert.equal(args.queries[0].query.filters.length, 1);
  assert.equal(result.queries[0].query.filters.length, 3);
  assert.deepEqual(result.queries[0].query.filters[2].values, ["1001", "1002"]);
  assert.match(modulePagePrompt(host, "s"), /万元/);
  assert.throws(() => inheritModuleCubeScope(host, "s", query("unknown_model")), /UNMAPPED/);
  c.abort();
  assert.throws(() => inheritModuleCubeScope(host, "s", args), /NOT_READY/);
});
test("fulfillment Cube preserves source date, exact order and all UI filters, failing closed on timezone changes", () => {
  const host = { surfaceFor: () => ({ menu: "inventory-orderfulfillment" }) };
  const b = bindModulePage(host, "s", "inventory-orderfulfillment", new AbortController().signal);
  b.observe({
    filters: {
      start: "2026-10-23",
      end_exclusive: "2026-10-24",
      base: "郑州",
      order: "O1",
      customer: "客户",
      sales_group: "G1",
    },
  });
  const args = query("agents_scm_execute_detail_d"),
    r = inheritModuleCubeScope(host, "s", args);
  const f = r.queries[0].query.filters;
  assert(
    f.some(
      (x) =>
        x.member?.endsWith("header_addtime") &&
        x.operator === "beforeDate" &&
        x.values[0] === "2026-10-24T00:00:00",
    ),
  );
  assert(f.some((x) => x.member?.endsWith("cust_order_no") && x.operator === "equals"));
  assert(f.some((x) => x.member?.endsWith("sales_group_name")));
  assert(f.some((x) => x.or?.[0].member.endsWith("cust_code")));
  args.queries[0].query.timezone = "Asia/Shanghai";
  assert.throws(() => inheritModuleCubeScope(host, "s", args), /TIMEZONE/);
  b.observe({ state: "unavailable" });
  assert.throws(() => inheritModuleCubeScope(host, "s", args), /NOT_READY/);
});
test("page rebind cannot be released by old owner; heartbeat preserves scope signature; other modules unchanged", () => {
  let menu = "inventory-customer";
  const host = { surfaceFor: () => ({ menu }) };
  const a = bindModulePage(host, "s", menu, new AbortController().signal);
  const b = bindModulePage(host, "s", menu, new AbortController().signal);
  const payload = { inventorySnapshot: "2026-10-21", filteredCustomerCodes: ["A"] };
  b.observe(payload);
  a.release();
  const key = moduleScopeSignature(host, "s");
  b.observe(payload);
  assert.equal(moduleScopeSignature(host, "s"), key);
  b.observe({ ...payload, filteredCustomerCodes: ["B"] });
  assert.notEqual(moduleScopeSignature(host, "s"), key);
  menu = "inventory-orderworkbench";
  const args = query("any");
  assert.equal(inheritModuleCubeScope(host, "s", args), args);
  assert.equal(modulePagePrompt(host, "s"), undefined);
});
