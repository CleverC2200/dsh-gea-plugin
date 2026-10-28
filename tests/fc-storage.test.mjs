import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { fcStorage } from "../src/host/fc-storage.ts";
import { submitOwnedDmsOrder } from "../src/host/dms-orders.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const config = { published: true, dataSourceCode: "fixture-db", users: [] };
const identity = { tenantId: "T1", userId: "U1", warehouses: ["001"] };
const scope = { kind: "plans", warehouseCode: "001" };
const value = {
  plans: [
    {
      warehouseCode: "001",
      warehouseName: "分仓",
      sku: "001SKU",
      productName: "产品",
      month: "2026-10",
      outboundQty: 10,
      transferQty: 0,
    },
  ],
};
function fixture() {
  const data = new Map(),
    receipts = new Map(),
    history = new Map(),
    calls = [];
  const execute = async (req) => {
    calls.push(req);
    assert.equal(req.dataSourceCode, "fixture-db");
    assert.ok(!/ON CONFLICT|RETURNING|BEGIN|COMMIT|::|\$\d|\*/.test(req.sql));
    assert.ok(!("tenantId" in req) && !("userId" in req));
    assert.equal(req.parameters.tenant, "T1");
    const p = req.parameters,
      key = JSON.stringify([
        req.sql.match(/(?:FROM|INTO) (\w+)/)[1],
        p.tenant,
        p.warehouse,
        p.entity,
      ]);
    if (req.sql.startsWith("SELECT"))
      return {
        success: true,
        code: 200,
        result: {
          records: p.expectedRevision
            ? history.has(key + ":" + p.expectedRevision)
              ? [history.get(key + ":" + p.expectedRevision)]
              : []
            : data.has(key)
              ? [data.get(key)]
              : [],
        },
      };
    assert.ok(!("pageNo" in req) && !("pageSize" in req));
    assert.ok(req.idempotencyKey.length <= 128);
    if (receipts.has(req.idempotencyKey)) return receipts.get(req.idempotencyKey);
    if (data.get(key)?.revision >= p.revision)
      return { success: false, code: 409, retryable: false };
    data.set(key, { revision: p.revision, payload_text: p.payload, idempotency_key: p.key });
    history.set(key + ":" + p.revision, data.get(key));
    const r = { success: true, code: 200, result: { affectedRows: 1 } };
    receipts.set(req.idempotencyKey, r);
    return r;
  };
  return { calls, execute };
}
test("insert and verified read preserve warehouse leading zero; retry same write uses exact SQL and idempotency key", async () => {
  const f = fixture(),
    request = { ...scope, operation: "save", baseRevision: "0", value };
  const result = await fcStorage(config, identity, request, f.execute);
  assert.equal(result.status, "saved");
  assert.deepEqual(result.value, value);
  await fcStorage(config, identity, request, f.execute);
  const writes = f.calls.filter((r) => r.sql.startsWith("INSERT"));
  assert.deepEqual(writes[0], writes[1]);
});
test("concurrent editors cannot overwrite same revision", async () => {
  const f = fixture();
  await fcStorage(
    config,
    identity,
    { ...scope, operation: "save", baseRevision: "0", value },
    f.execute,
  );
  const result = await fcStorage(
    config,
    identity,
    {
      ...scope,
      operation: "save",
      baseRevision: "0",
      value: { plans: [{ ...value.plans[0], outboundQty: 20 }] },
    },
    f.execute,
  );
  assert.equal(result.status, "failed");
});
test("acknowledged write with failed refresh returns saved-unverified; verify is read only", async () => {
  const f = fixture();
  let fail = true;
  const execute = (req) => {
    if (fail && req.sql.startsWith("SELECT")) throw Error("network");
    return f.execute(req);
  };
  const request = { ...scope, operation: "save", baseRevision: "0", value };
  const saved = await fcStorage(config, identity, request, execute);
  assert.equal(saved.status, "saved-unverified");
  fail = false;
  const before = f.calls.filter((x) => x.sql.startsWith("INSERT")).length;
  assert.equal(
    (await fcStorage(config, identity, { ...request, operation: "verify" }, execute)).status,
    "saved",
  );
  assert.equal(f.calls.filter((x) => x.sql.startsWith("INSERT")).length, before);
});
test("lost acknowledgement remains unknown; read verification finds original commit without another write", async () => {
  const f = fixture(),
    request = { ...scope, operation: "save", baseRevision: "0", value };
  const result = await fcStorage(config, identity, request, async (r) => {
    await f.execute(r);
    throw Error("lost");
  });
  assert.equal(result.status, "unknown");
  assert.equal(
    (await fcStorage(config, identity, { ...request, operation: "verify" }, f.execute)).status,
    "saved",
  );
  assert.equal(f.calls.filter((x) => x.sql.startsWith("INSERT")).length, 1);
});
test("not published, wrong warehouse, user-supplied SQL and invalid quantities stop before transport", async () => {
  for (const [cfg, input] of [
    [
      { ...config, published: false },
      { ...scope, operation: "load" },
    ],
    [config, { ...scope, warehouseCode: "002", operation: "load" }],
    [config, { ...scope, operation: "load", sql: "SELECT 1" }],
    [
      config,
      {
        ...scope,
        operation: "save",
        baseRevision: "0",
        value: { plans: [{ ...value.plans[0], outboundQty: null }] },
      },
    ],
  ])
    await assert.rejects(
      () =>
        fcStorage(cfg, identity, input, () => {
          throw Error("UNEXPECTED TRANSPORT");
        }),
      (e) => !e.message.includes("UNEXPECTED"),
    );
});
test("cycle paused status and dates round-trip; wrong warehouse rule rejected", async () => {
  const f = fixture(),
    input = {
      kind: "cycles",
      warehouseCode: "001",
      operation: "save",
      baseRevision: "0",
      value: {
        days: 7,
        rules: [
          {
            level: "sku",
            object: "001SKU",
            days: 14,
            from: "2026-10-01",
            to: "2026-10-31",
            status: "paused",
          },
        ],
      },
    };
  assert.equal(
    (await fcStorage(config, identity, input, f.execute)).value.rules[0].status,
    "paused",
  );
  await assert.rejects(() =>
    fcStorage(
      config,
      identity,
      {
        ...input,
        value: { days: 7, rules: [{ ...input.value.rules[0], level: "warehouse", object: "002" }] },
      },
      f.execute,
    ),
  );
});
test("unknown business result, HTTP-success business failure and oversized atomic versions do not claim success", async () => {
  const req = { ...scope, operation: "save", baseRevision: "0", value };
  assert.equal(
    (
      await fcStorage(config, identity, req, async () => ({
        success: false,
        code: 409,
        errorCode: "SQL_WRITE_RESULT_UNKNOWN",
      }))
    ).status,
    "unknown",
  );
  assert.equal(
    (await fcStorage(config, identity, req, async () => ({ success: false, code: 403 }))).status,
    "failed",
  );
  await assert.rejects(
    () =>
      fcStorage(
        config,
        identity,
        {
          ...req,
          value: {
            plans: Array.from({ length: 500 }, (_, i) => ({ ...value.plans[0], sku: String(i) })),
          },
        },
        async () => {
          throw Error("not reached");
        },
      ),
    /BATCH_TOO_LARGE/,
  );
});

test("verification finds original committed version after newer edits, without another insert", async () => {
  const f = fixture(),
    original = { ...scope, operation: "save", baseRevision: "0", value };
  await fcStorage(config, identity, original, f.execute);
  await fcStorage(
    config,
    identity,
    { ...original, baseRevision: "1", value: { plans: [{ ...value.plans[0], outboundQty: 20 }] } },
    f.execute,
  );
  const result = await fcStorage(config, identity, { ...original, operation: "verify" }, f.execute);
  assert.equal(result.status, "saved");
  assert.equal(result.revision, "1");
  assert.equal(f.calls.filter((r) => r.sql.startsWith("INSERT")).length, 2);
  assert.match(f.calls.at(-1).sql, /revision = :expectedRevision/);
});
function submission() {
  const calculationContext = {
    asOf: "2026-10-26",
    warehouseCode: "001",
    stockDates: ["2026-10-26"],
    planSource: "BI",
    cycleSource: "default",
    plans: [],
    cycle: { days: 7, rules: [] },
    evidence: [{ sku: "001SKU", recommended_qty: 10 }],
  };
  const canonical = (v) =>
    JSON.stringify(v, (_k, x) =>
      x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, x[k]]),
          )
        : x,
    );
  return {
    kind: "submission",
    warehouseCode: "001",
    entityId: "S1",
    operation: "save",
    baseRevision: "0",
    value: {
      stage: "confirmed",
      month: "2026-10",
      planRevision: "0",
      cycleRevision: "0",
      consumptionReviewed: true,
      calculationContext,
      snapshotVersion:
        "sha256:" + createHash("sha256").update(canonical(calculationContext)).digest("hex"),
      aiPreOrderCode: "S1",
      rows: [{ sku: "001SKU", productName: "产品", recommendedQty: 10, actualQty: 10, reason: "" }],
    },
  };
}
test("submission validates calculation fingerprint and recommendation evidence", async () => {
  const f = fixture(),
    req = submission();
  assert.equal((await fcStorage(config, identity, req, f.execute)).status, "saved");
  for (const change of [
    (r) => (r.value.calculationContext.asOf = "2026-10-25"),
    (r) => (r.value.rows[0].recommendedQty = 11),
    (r) => (r.value.calculationContext.planSource = "human-trial"),
    (r) => (r.value.cycleRevision = "2"),
  ]) {
    const changed = structuredClone(req);
    change(changed);
    await assert.rejects(
      () =>
        fcStorage(config, identity, changed, () => {
          throw Error("UNEXPECTED TRANSPORT");
        }),
      (e) => !e.message.includes("UNEXPECTED"),
    );
  }
});

test("owner-scoped DMS receipt archives against the page intent and replays without a new order", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fc-dms-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture(),
    req = submission();
  const confirmed = await fcStorage(config, identity, req, f.execute);
  let sends = 0;
  const client = {
    login: async () => ({ accessToken: "fixture" }),
    submit: async (order) => {
      sends++;
      assert.notEqual(order.aiPreOrderCode, req.entityId);
      return { orderCode: "DMS1", aiPreOrderCode: order.aiPreOrderCode };
    },
  };
  const order = {
    aiPreOrderCode: req.entityId,
    customerCode: "C1",
    addressCode: "A1",
    pupCode: "01",
    itemList: [{ productCode: "001SKU", quantity: 10 }],
  };
  const signal = new AbortController().signal;
  const receipt = await submitOwnedDmsOrder(directory, "owner", order, client, signal);
  assert.equal(receipt.requestAiPreOrderCode, req.entityId);
  const received = {
    ...req,
    baseRevision: confirmed.revision,
    value: { ...req.value, stage: "dms-received", receipt },
  };
  assert.equal((await fcStorage(config, identity, received, f.execute)).status, "saved");
  const restored = await fcStorage(
    config,
    identity,
    {
      operation: "load",
      kind: "submission",
      warehouseCode: "001",
      entityId: req.entityId,
    },
    f.execute,
  );
  assert.deepEqual(restored.value.receipt, receipt);
  assert.deepEqual(await submitOwnedDmsOrder(directory, "owner", order, client, signal), receipt);
  assert.equal(sends, 1);
  const bad = structuredClone(received);
  bad.value.receipt.requestAiPreOrderCode = "OTHER";
  await assert.rejects(() => fcStorage(config, identity, bad, f.execute), /FC_DMS_RECEIPT_INVALID/);
  delete bad.value.receipt.requestAiPreOrderCode;
  await assert.rejects(() => fcStorage(config, identity, bad, f.execute), /FC_DMS_RECEIPT_INVALID/);
  bad.value.receipt.aiPreOrderCode = req.entityId;
  assert.equal(
    (await fcStorage(config, identity, { ...bad, baseRevision: "2" }, f.execute)).status,
    "saved",
  );
  await assert.rejects(
    () => fcStorage(config, identity, { ...req, entityId: "OTHER" }, f.execute),
    /FC_SUBMISSION_ENTITY_MISMATCH/,
  );
});
