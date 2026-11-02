import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { fcStorage } from "../src/host/fc-storage.ts";
import { submitOwnedDmsOrder } from "../src/host/dms-orders.ts";

const workbench = resolve("../dsh-agent-workbench");
const modules = {
  FcPersistence: "business/shared/fc-persistence.ts",
  fcSubmissionIdentity: "business/shared/fc-submission-identity.ts",
  fcSubmissionProvenance: "business/shared/fc-provenance.ts",
  applyFcPlan: "business/inventory-fc/source/inventory-light-plugins/src/pages/fc-workflow.ts",
  persistAndSubmitFc:
    "business/inventory-fc/source/inventory-light-plugins/src/pages/fc-submission-persistence.ts",
  verifyFcReceiptArchive:
    "business/inventory-fc/source/inventory-light-plugins/src/pages/fc-submission-persistence.ts",
};
const compiled = await build({
  stdin: {
    contents: Object.entries(modules)
      .map(([name, file]) => `export { ${name} } from ${JSON.stringify(resolve(workbench, file))};`)
      .join("\n"),
    resolveDir: workbench,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "submission-store",
      setup(api) {
        api.onResolve({ filter: /fc-storage-client$/ }, () => ({
          path: "store",
          namespace: "fixture",
        }));
        api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents:
            "export const fcPersistence = new Proxy({}, {get: (_target, key) => (...args) => globalThis.fcIntegratedStore[key](...args)});",
        }));
      },
    },
  ],
});
const flow = await import(
  "data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64")
);

test("real calculation, page persistence and Host adapters complete two batches and recover a lost archive acknowledgement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fc-complete-flow-"));
  t.after(async () => {
    delete globalThis.fcIntegratedStore;
    await rm(directory, { recursive: true, force: true });
  });
  const db = new Map(),
    journal = new Map(),
    events = [];
  const identity = { tenantId: "T1", userId: "U1", warehouses: ["001"] };
  const config = { published: true, dataSourceCode: "fixture-db", users: [] };
  let loseArchiveAck = false;
  const execute = async (request) => {
    assert.equal(request.dataSourceCode, config.dataSourceCode);
    const table = request.sql.match(/(?:FROM|INTO) (\w+)/)[1];
    const p = request.parameters;
    assert.equal(p.tenant, identity.tenantId);
    assert.equal(p.warehouse, "001");
    const key = JSON.stringify([table, p.tenant, p.warehouse, p.entity]);
    const rows = db.get(key) ?? [];
    if (request.sql.startsWith("SELECT")) {
      const selected = p.expectedRevision
        ? rows.filter((r) => r.revision === p.expectedRevision)
        : rows.slice(-1);
      return { success: true, code: 200, result: { records: selected } };
    }
    assert.equal(rows.length ? rows.at(-1).revision + 1 : 1, p.revision);
    const value = JSON.parse(p.payload);
    events.push(value.stage ?? (value.plans ? "plans" : "cycles"));
    rows.push({ revision: p.revision, payload_text: p.payload, idempotency_key: p.key });
    db.set(key, rows);
    if (loseArchiveAck && value.stage === "dms-received")
      throw Error("fixture lost acknowledgement after commit");
    return { success: true, code: 200, result: { affectedRows: 1 } };
  };
  const storage = {
    keys: () => [...journal.keys()],
    getItem: (k) => journal.get(k) ?? null,
    setItem: (k, v) => journal.set(k, v),
    removeItem: (k) => journal.delete(k),
  };
  const call = async (method, payload) => {
    assert.equal(method, "branch-storage");
    return fcStorage(config, identity, payload, execute);
  };
  let persistence = new flow.FcPersistence(call, storage);
  globalThis.fcIntegratedStore = persistence;
  const signal = new AbortController().signal;
  const plans = [
    {
      warehouseCode: "001",
      warehouseName: "测试分仓",
      sku: "0001",
      productName: "测试产品",
      month: "2026-10",
      outboundQty: 310,
      transferQty: 20,
    },
  ];
  const planRecord = await persistence.save(
    { kind: "plans", warehouseCode: "001" },
    "0",
    { plans },
    signal,
  );
  const cycleRecord = await persistence.save(
    { kind: "cycles", warehouseCode: "001" },
    "0",
    { days: 7, rules: [] },
    signal,
  );
  const makeBatch = async (stockDate) => {
    const row = flow.applyFcPlan(
      {
        warehouse_code: "001",
        sku: "0001",
        stock_date: stockDate,
        stat_month: "202610",
        available_qty: 25,
        inventory_qty: 50,
        open_transfer_reported_qty: 40,
        current_order_remaining: 80,
        calculation_order_remaining: 0,
        month_ship_positive: 30,
        period_next_out: 300,
        cycle_days: 7,
      },
      plans,
      "2026-10-26",
      7,
    );
    assert.equal(row.recommended_qty, 35);
    const provenance = await flow.fcSubmissionProvenance({
      warehouse: "001",
      asOf: "2026-10-26",
      plans,
      days: 7,
      rules: [],
      cycleWarehouse: "001",
      stored: { "001": { plans: planRecord, cycles: cycleRecord } },
      rows: [row],
    });
    assert.equal(provenance.calculationContext.planSource, "human-saved");
    const rows = [
      {
        sku: "0001",
        productName: "测试产品",
        recommendedQty: 35,
        actualQty: 110,
        reason: "人工确认增补75件",
      },
    ];
    const order = {
      customerCode: "C1",
      addressCode: "A1",
      pupCode: "01",
      itemList: [{ productCode: "0001", quantity: 110 }],
    };
    const ids = await flow.fcSubmissionIdentity({
      warehouseCode: "001",
      month: "2026-10",
      ...provenance,
      consumptionReviewed: true,
      rows,
      order,
    });
    return {
      ...ids,
      order,
      snapshot: {
        ...provenance,
        stage: "confirmed",
        month: "2026-10",
        consumptionReviewed: true,
        aiPreOrderCode: ids.aiPreOrderCode,
        rows,
      },
    };
  };
  let orders = 0;
  const dms = {
    login: async () => ({ accessToken: "fixture-only" }),
    submit: async (order) => {
      events.push("DMS");
      assert.deepEqual(order.itemList, [{ productCode: "0001", quantity: 110 }]);
      return { orderCode: "ORDER" + ++orders, aiPreOrderCode: order.aiPreOrderCode };
    },
  };
  const send = (batch) =>
    flow.persistAndSubmitFc(
      "001",
      batch.snapshot,
      signal,
      () =>
        submitOwnedDmsOrder(
          directory,
          "fixture-owner",
          { ...batch.order, aiPreOrderCode: batch.aiPreOrderCode },
          dms,
          signal,
          "001",
        ),
      () => {},
      batch.legacyAiPreOrderCode,
    );
  const first = await makeBatch("2026-10-25");
  const receipt = await send(first);
  assert.equal(receipt.requestAiPreOrderCode, first.aiPreOrderCode);
  assert.notEqual(receipt.aiPreOrderCode, first.aiPreOrderCode);
  assert.deepEqual(await send(first), receipt);
  assert.equal(orders, 1);
  const second = await makeBatch("2026-10-26");
  assert.notEqual(second.aiPreOrderCode, first.aiPreOrderCode);
  loseArchiveAck = true;
  await assert.rejects(() => send(second), /待核对/);
  assert.equal(orders, 2);
  persistence = new flow.FcPersistence(call, storage);
  globalThis.fcIntegratedStore = persistence;
  const pending = persistence.pendingReceipts();
  assert.equal(pending.length, 1);
  const before = [...events];
  const recovered = await flow.verifyFcReceiptArchive(pending[0], signal);
  assert.equal(recovered.orderCode, "ORDER2");
  assert.deepEqual(events, before);
  assert.equal(persistence.pendingReceipts().length, 0);
  assert.deepEqual(await send(second), recovered);
  assert.equal(orders, 2);
  assert.deepEqual(events, [
    "plans",
    "cycles",
    "confirmed",
    "DMS",
    "dms-received",
    "confirmed",
    "DMS",
    "dms-received",
  ]);
});
