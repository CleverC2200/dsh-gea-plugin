import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['src/host/business.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', Buffer.from(compiled.outputFiles[0].contents).toString())(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { Business } = module.exports;

const makeBusiness = () => {
  const business = new Business({
    geaEnvironments: { production: 'https://gea.test', test: 'https://test.gea.test' },
    requestTimeoutMs: 1000,
    inputByteBudget: 32000,
    pageSize: 50,
    periodPageSize: 100,
  });
  business.auth = { token: 'fixture', tenantId: '0', id: 'fixture' };
  return business;
};

test('period discovery uses visible plans after the period dependency was removed', async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname.endsWith('/periods')) {
      return Response.json(
        { code: 'SALES_PLAN_DEPENDENCY_UNAVAILABLE', message: 'period storage removed' },
        { status: 503 },
      );
    }
    assert.equal(url.pathname, '/sales-plan/plans');
    const pageNo = Number(url.searchParams.get('pageNo'));
    return Response.json({
      success: true,
      result: {
        records: pageNo === 1
          ? [
              { planId: 'p1', periodId: '20261001', planTypeCode: 'Y', orderType: 'M' },
              { planId: 'p2', periodId: '20261002', planTypeCode: 'DC', orderType: 'M' },
            ]
          : [{ planId: 'p3', periodId: '20260901', planTypeCode: 'Y', orderType: 'M' }],
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
      { kind: 'periods', query: { pageNo: 1, pageSize: 100 } },
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
        { periodId: '20261001', periodMonth: '2026-10', planTypeCode: 'Y', status: 'UNKNOWN' },
        { periodId: '20261002', periodMonth: '2026-10', planTypeCode: 'DC', status: 'UNKNOWN' },
        { periodId: '20260901', periodMonth: '2026-09', planTypeCode: 'Y', status: 'UNKNOWN' },
      ],
    );
    assert.equal(page.total, 3);
    assert.equal(requests.some((url) => url.pathname.endsWith('/periods')), false);
    assert.deepEqual([...new Set(requests.map((url) => url.pathname))], ['/sales-plan/plans']);
    assert.deepEqual(requests.map((url) => url.searchParams.get('pageNo')), ['1', '2']);
  } finally {
    globalThis.fetch = original;
    business.dispose();
  }
});
