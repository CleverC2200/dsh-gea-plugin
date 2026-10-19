import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["src/host/business.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const module = { exports: {} };
new Function(
  "require",
  "module",
  "exports",
  Buffer.from(compiled.outputFiles[0].contents).toString(),
)(createRequire(import.meta.url), module, module.exports);
const { Business } = module.exports;

const makeBusiness = () => {
  const business = new Business({
    geaEnvironments: { production: "https://gea.test", test: "https://test.gea.test" },
    requestTimeoutMs: 1000,
    inputByteBudget: 32000,
    pageSize: 50,
    periodPageSize: 100,
  });
  business.auth = { token: "fixture", tenantId: "0", id: "fixture" };
  return business;
};

test("period discovery uses visible plans after the period dependency was removed", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname.endsWith("/periods")) {
      return Response.json(
        { code: "SALES_PLAN_DEPENDENCY_UNAVAILABLE", message: "period storage removed" },
        { status: 503 },
      );
    }
    assert.equal(url.pathname, "/sales-plan/plans");
    const pageNo = Number(url.searchParams.get("pageNo"));
    return Response.json({
      success: true,
      result: {
        records:
          pageNo === 1
            ? [
                { planId: "p1", periodId: "20261001", planTypeCode: "Y", orderType: "M" },
                { planId: "p2", periodId: "20261002", planTypeCode: "DC", orderType: "M" },
              ]
            : [{ planId: "p3", periodId: "20260901", planTypeCode: "Y", orderType: "M" }],
        total: 3,
        current: pageNo,
        size: 2,
        pages: 2,
      },
    });
  };
  const business = makeBusiness();
  try {
    const page = await business.workbenchQuery(
      { kind: "periods", query: { pageNo: 1, pageSize: 100 } },
      new AbortController().signal,
    );
    assert.deepEqual(
      page.records.map(({ periodId, periodMonth, planTypeCode, status }) => ({
        periodId,
        periodMonth,
        planTypeCode,
        status,
      })),
      [
        { periodId: "20261001", periodMonth: "2026-10", planTypeCode: "Y", status: "UNKNOWN" },
        { periodId: "20261002", periodMonth: "2026-10", planTypeCode: "DC", status: "UNKNOWN" },
        { periodId: "20260901", periodMonth: "2026-09", planTypeCode: "Y", status: "UNKNOWN" },
      ],
    );
    assert.equal(page.total, 3);
    assert.equal(
      requests.some((url) => url.pathname.endsWith("/periods")),
      false,
    );
    assert.deepEqual([...new Set(requests.map((url) => url.pathname))], ["/sales-plan/plans"]);
    assert.deepEqual(
      requests.map((url) => url.searchParams.get("pageNo")),
      ["1", "2"],
    );
  } finally {
    globalThis.fetch = original;
    business.dispose();
  }
});

function visiblePlans(t, records) {
  const business = makeBusiness();
  t.after(() => business.dispose());
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(url.pathname, "/sales-plan/plans");
    const current = Number(url.searchParams.get("pageNo"));
    return Response.json({
      success: true,
      result: {
        records: records.slice((current - 1) * 2, current * 2),
        total: records.length,
        current,
        size: 2,
        pages: Math.ceil(records.length / 2),
      },
    });
  });
  return { business, requests };
}

test("monthly and correction tabs discover a shared period regardless of M/Z row order", async (t) => {
  const monthly = { planId: "m", periodId: "20261001", planTypeCode: "Y", orderType: "M" };
  const correction = { ...monthly, planId: "z", orderType: "Z" };
  for (const records of [
    [monthly, correction],
    [correction, monthly],
  ]) {
    await t.test(records.map((row) => row.orderType).join(","), async (t) => {
      const f = visiblePlans(t, records);
      for (const planType of ["MONTHLY", "CORRECTION"]) {
        const page = await f.business.workbenchQuery(
          { kind: "periods", query: { planType, periodMonth: "2026-10" } },
          new AbortController().signal,
        );
        assert.equal(page.total, 1);
        assert.deepEqual(page.records, [
          {
            periodId: "20261001",
            tenantId: "0",
            periodMonth: "2026-10",
            planType,
            planTypeCode: "Y",
            status: "UNKNOWN",
          },
        ]);
      }
      assert.equal(
        f.requests.every((url) => url.pathname === "/sales-plan/plans"),
        true,
      );
    });
  }
});

test("an M-only month remains discoverable for read-only correction browsing with unknown period status", async (t) => {
  const f = visiblePlans(t, [
    { planId: "m", periodId: "20261001", planTypeCode: "Y", orderType: "M", status: 5 },
  ]);
  const page = await f.business.workbenchQuery(
    { kind: "periods", query: { planType: "CORRECTION", periodMonth: "2026-10" } },
    new AbortController().signal,
  );
  assert.equal(page.total, 1);
  assert.deepEqual(page.records, [
    {
      periodId: "20261001",
      tenantId: "0",
      periodMonth: "2026-10",
      planType: "CORRECTION",
      planTypeCode: "Y",
      status: "UNKNOWN",
    },
  ]);
  assert.equal(f.requests.length, 1);
});

test("untyped period discovery keeps tuple deduplication, month filtering and result pagination", async (t) => {
  const f = visiblePlans(t, [
    { planId: "m", periodId: "20261001", planTypeCode: "Y", orderType: "M" },
    { planId: "z", periodId: "20261001", planTypeCode: "Y", orderType: "Z" },
    { planId: "dc", periodId: "20261002", planTypeCode: "DC", orderType: "M" },
    { planId: "past", periodId: "20260901", planTypeCode: "Y", orderType: "M" },
  ]);
  const all = await f.business.workbenchQuery(
    { kind: "periods", query: {} },
    new AbortController().signal,
  );
  assert.equal(all.total, 3);
  assert.deepEqual(
    all.records.map((row) => row.periodId),
    ["20261001", "20261002", "20260901"],
  );
  const filtered = await f.business.workbenchQuery(
    { kind: "periods", query: { periodMonth: "2026-10", pageNo: 2, pageSize: 1 } },
    new AbortController().signal,
  );
  assert.equal(filtered.total, 2);
  assert.equal(filtered.current, 2);
  assert.equal(filtered.size, 1);
  assert.equal(filtered.pages, 2);
  assert.equal(filtered.records[0].periodId, "20261002");
  assert.equal(filtered.records[0].status, "UNKNOWN");
  assert.deepEqual(
    f.requests.map((url) => url.searchParams.get("pageNo")),
    ["1", "2", "1", "2"],
  );
});
