import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {readHtmlQuery} from '../src/html-query.ts';
import {createSqlReadLimit} from '../src/shared/sql-read-limit.js';
import {readDeployment, businessDeploymentPatch} from '../scripts/deployment.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const built = await build({
  stdin: {contents: "export {Business} from './src/host/business.ts'; export {createCapabilityRegistry} from './src/capability/registry.ts';", resolveDir: process.cwd()},
  bundle: true, packages: 'external', write: false, platform: 'node', format: 'cjs',
});
const module = {exports: {}};
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const {Business, createCapabilityRegistry} = module.exports;
function fixture(t, maxRequests = 0) {
  const business = new Business({geaBaseUrl: 'https://fixture.invalid', analysisAgentCode: 'sales_forecast', requestTimeoutMs: 1000,
    sqlReadLimit: {consumerCode: 'full-chain-inventory', maxRequests, maxPagesPerQuery: 3, maxRowsPerQuery: 600}});
  business.setCapabilities(createCapabilityRegistry([{id: 'inventory-qll', label: 'Company stock', maxEffect: 'view', skills: [],
    routing: {keywords: [], summary: 'Company stock'}, data: {consumerCode: 'full-chain-inventory', tables: [], rules: []}}]));
  t.after(() => business.dispose());
  return business;
}
test('a zero SQL request limit rejects before login or external transport', async t => {
  const business = fixture(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async input => {requests.push(String(input)); throw Error('EXTERNAL_FORBIDDEN');});
  await assert.rejects(business.pluginSql({consumerCode: 'full-chain-inventory', sql: 'SELECT 1'}, new AbortController().signal),
    error => error.code === 'GEA_SQL_REQUEST_LIMIT');
  assert.deepEqual(requests, []);
});

test('one Host allowance spans separate SQL calls and stops before another delegation', async t => {
  const business = fixture(t, 1);
  let sqlRequests = 0, delegations = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    init.signal.throwIfAborted();
    const url = String(input);
    if (url.endsWith('/session')) {
      delegations++;
      return Response.json({success: true, result: {accessDecision: {allowed: true}, delegationToken: 'fixture-delegation'}});
    }
    if (url.endsWith('/sql/execute')) {
      sqlRequests++;
      return Response.json({success: true, result: {rows: [{sku: 'A'}], total: 1}});
    }
    return Response.json({code: 200, result: {codeList: []}});
  });
  business.restoreDesktopLogin({schema: 1, environment: 'production', base: 'https://fixture.invalid',
    auth: {token: 'fixture-only', tenantId: '1', id: 'fixture-user', name: 'Fixture', username: 'fixture'}});
  const query = {consumerCode: 'full-chain-inventory', sql: 'SELECT sku FROM inventory ORDER BY sku', pageNo: 1, pageSize: 200};
  assert.deepEqual((await business.pluginSql(query, new AbortController().signal)).rows, [{sku: 'A'}]);
  await assert.rejects(business.pluginSql(query, new AbortController().signal), error => error.code === 'GEA_SQL_REQUEST_LIMIT');
  assert.equal(sqlRequests, 1);
  assert.equal(delegations, 1);
});

test('automatic SQL pages consume the same physical allowance', async () => {
  const pages = [];
  const limit = createSqlReadLimit({consumerCode: 'full-chain-inventory', maxRequests: 2, maxPagesPerQuery: 3, maxRowsPerQuery: 6});
  await assert.rejects(readHtmlQuery({sql: 'SELECT sku FROM inventory ORDER BY sku', pageSize: 2}, {
    endpoint: 'https://fixture.invalid', token: 'fixture-only', signal: new AbortController().signal, limit,
    fetch: async (_url, init) => {
      const parameters = JSON.parse(init.body).parameters;
      const page = parameters.fc_page_offset / parameters.fc_page_limit + 1;
      pages.push(page);
      return Response.json({success: true, result: {rows: page === 3 ? [{sku: 'E'}] : [{sku: 'A'}, {sku: 'B'}], total: 5}});
    },
  }), error => error.code === 'GEA_SQL_REQUEST_LIMIT');
  assert.deepEqual(pages, [1, 2]);
});

test('an oversized counted result stops after its first physical page', async () => {
  let calls = 0;
  const limit = createSqlReadLimit({consumerCode: 'full-chain-inventory', maxRequests: 10, maxPagesPerQuery: 3, maxRowsPerQuery: 4});
  await assert.rejects(readHtmlQuery({sql: 'SELECT sku FROM inventory ORDER BY sku', pageSize: 2}, {
    endpoint: 'https://fixture.invalid', token: 'fixture-only', signal: new AbortController().signal, limit,
    fetch: async (_url, init) => {
      calls++;
      const p = JSON.parse(init.body).parameters;
      return Response.json({success: true, result: {rows: p.fc_page_offset === 4 ? [{sku: 'E'}] : [{sku: 'A'}, {sku: 'B'}], total: 5}});
    },
  }), error => error.code === 'GEA_SQL_RESULT_LIMIT');
  assert.equal(calls, 1);
});

test('a counted result requiring too many pages stops before subsequent pages', async () => {
  let calls = 0;
  const limit = createSqlReadLimit({consumerCode: 'full-chain-inventory', maxRequests: 10, maxPagesPerQuery: 2, maxRowsPerQuery: 10});
  await assert.rejects(readHtmlQuery({sql: 'SELECT sku FROM inventory ORDER BY sku', pageSize: 2}, {
    endpoint: 'https://fixture.invalid', token: 'fixture-only', signal: new AbortController().signal, limit,
    fetch: async (_url, init) => {
      calls++;
      const p = JSON.parse(init.body).parameters;
      return Response.json({success: true, result: {rows: p.fc_page_offset === 4 ? [{sku: 'E'}] : [{sku: 'A'}, {sku: 'B'}], total: 5}});
    },
  }), error => error.code === 'GEA_SQL_PAGE_LIMIT');
  assert.equal(calls, 1);
});

test('a single requested page does not charge unrequested pages of its counted result', async () => {
  let calls = 0;
  const limit = createSqlReadLimit({consumerCode: 'dealer-inventory-replenishment', maxRequests: 1, maxPagesPerQuery: 60, maxRowsPerQuery: 12000});
  const rows = Array.from({length: 10}, (_, index) => ({sku: `S${index}`}));
  const input = {sql: 'SELECT sku FROM inventory ORDER BY sku', pageNo: 1, pageSize: 10};
  const transport = {
    endpoint: 'https://fixture.invalid', token: 'fixture-only', signal: new AbortController().signal, limit,
    fetch: async () => {
      calls++;
      return Response.json({success: true, result: {rows, total: 2730, pageNo: 1, pageSize: 10, offset: 0}});
    },
  };
  const result = await readHtmlQuery(input, transport);
  assert.deepEqual(result.rows, rows);
  assert.equal(result.total, 2730);
  assert.equal(calls, 1);
  await assert.rejects(readHtmlQuery(input, transport), error => error.code === 'GEA_SQL_REQUEST_LIMIT');
  assert.equal(calls, 1);
});

test('a requested page beyond the configured range is rejected before transport', async () => {
  let calls = 0;
  const limit = createSqlReadLimit({consumerCode: 'dealer-inventory-replenishment', maxRequests: 1, maxPagesPerQuery: 60, maxRowsPerQuery: 12000});
  await assert.rejects(readHtmlQuery({sql: 'SELECT sku FROM inventory ORDER BY sku', pageNo: 61, pageSize: 10}, {
    endpoint: 'https://fixture.invalid', token: 'fixture-only', signal: new AbortController().signal, limit,
    fetch: async () => {calls++; throw Error('TRANSPORT_FORBIDDEN');},
  }), error => error.code === 'GEA_SQL_PAGE_LIMIT');
  assert.equal(calls, 0);
});

test('a delegation 401 consumes an allowance and cannot renew after it is exhausted', async t => {
  const business = fixture(t, 1);
  let sqlRequests = 0, delegations = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    init.signal.throwIfAborted();
    if (String(input).endsWith('/session')) {
      delegations++;
      return Response.json({success: true, result: {accessDecision: {allowed: true}, delegationToken: 'fixture-delegation'}});
    }
    if (String(input).endsWith('/sql/execute')) {
      sqlRequests++;
      return Response.json({success: false, errorCode: 'AI_GATEWAY_SESSION_EXPIRED'}, {status: 401});
    }
    return Response.json({code: 200, result: {codeList: []}});
  });
  business.restoreDesktopLogin({schema: 1, environment: 'production', base: 'https://fixture.invalid',
    auth: {token: 'fixture-only', tenantId: '1', id: 'fixture-user', name: 'Fixture', username: 'fixture'}});
  await assert.rejects(business.pluginSql({consumerCode: 'full-chain-inventory', sql: 'SELECT 1'}, new AbortController().signal),
    error => error.code === 'GEA_SQL_REQUEST_LIMIT');
  assert.equal(sqlRequests, 1);
  assert.equal(delegations, 1);
});

for (const outcome of ['failure', 'cancel']) {
  test(`a physical SQL ${outcome} is charged and cannot be retried with another query`, async t => {
    const business = fixture(t, 1);
    const controller = new AbortController();
    let sqlRequests = 0;
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      init.signal.throwIfAborted();
      if (String(input).endsWith('/session'))
        return Response.json({success: true, result: {accessDecision: {allowed: true}, delegationToken: 'fixture-delegation'}});
      if (String(input).endsWith('/sql/execute')) {
        sqlRequests++;
        if (outcome === 'cancel') controller.abort();
        return Response.json({success: false, errorCode: 'RESOURCE_NOT_IN_DATASET'}, {status: 400});
      }
      return Response.json({code: 200, result: {codeList: []}});
    });
    business.restoreDesktopLogin({schema: 1, environment: 'production', base: 'https://fixture.invalid',
      auth: {token: 'fixture-only', tenantId: '1', id: 'fixture-user', name: 'Fixture', username: 'fixture'}});
    const query = {consumerCode: 'full-chain-inventory', sql: 'SELECT 1'};
    await assert.rejects(business.pluginSql(query, controller.signal), error =>
      outcome === 'cancel' ? error.name === 'AbortError' : error.code === 'RESOURCE_NOT_IN_DATASET');
    await assert.rejects(business.pluginSql({...query, sql: 'SELECT 2'}, new AbortController().signal), error => error.code === 'GEA_SQL_REQUEST_LIMIT');
    assert.equal(sqlRequests, 1);
  });
}

test('a missing delegation does not spend a physical SQL allowance', async () => {
  const limit = createSqlReadLimit({consumerCode: 'full-chain-inventory', maxRequests: 1, maxPagesPerQuery: 1, maxRowsPerQuery: 200});
  let calls = 0;
  const transport = {endpoint: 'https://fixture.invalid', signal: new AbortController().signal, limit,
    fetch: async () => {calls++; return Response.json({success: true, result: {rows: [{n: 1}], total: 1}});}};
  await assert.rejects(readHtmlQuery({sql: 'SELECT 1', pageNo: 1}, {...transport, token: ''}), error => error.code === 'GEA_GATEWAY_SESSION_REJECTED');
  assert.deepEqual((await readHtmlQuery({sql: 'SELECT 1', pageNo: 1}, {...transport, token: 'fixture-only'})).rows, [{n: 1}]);
  assert.equal(calls, 1);
});

test('a different installed Consumer cannot share a fixed company SQL allowance', async t => {
  const business = fixture(t, 39);
  business.setCapabilities(createCapabilityRegistry([{id: 'other', label: 'Other', maxEffect: 'view', skills: [], routing: {keywords: [], summary: ''}, data: {consumerCode: 'base-safety-stock', tables: [], rules: []}}]));
  const requests = [];
  t.mock.method(globalThis, 'fetch', async x => {requests.push(String(x)); throw Error('EXTERNAL_FORBIDDEN');});
  await assert.rejects(business.pluginSql({consumerCode: 'base-safety-stock', sql: 'SELECT 1'}, new AbortController().signal), error => error.code === 'GEA_SQL_CONSUMER_LIMIT');
  assert.deepEqual(requests, []);
});

test('deployment preserves zero limits and rejects malformed limits before a credential reader', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gea-sql-limit-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = join(dir, 'deployment.json');
  const limits = {consumerCode: 'full-chain-inventory', maxRequests: 0, maxPagesPerQuery: 3, maxRowsPerQuery: 600};
  const config = {geaBaseUrl: 'https://fixture.invalid', pageSize: 50, periodPageSize: 200, requestTimeoutMs: 1000, maxSnapshotBytes: 32000, analysis: {mode: 'receipt'}, sqlReadLimit: limits};
  await writeFile(file, JSON.stringify(config));
  const parsed = await readDeployment(file);
  const patch = businessDeploymentPatch(parsed, dir, dir);
  assert.deepEqual(patch.flatMap(x => x.insert ?? []).find(x => x.id === 'gea-proof').config.sqlReadLimit, limits);
  let credentials = 0;
  await writeFile(file, JSON.stringify({...config, sqlReadLimit: {...limits, maxRequests: 'unlimited'},
    serviceAccounts: {test: {clientIdEnv: 'GEA_TEST_CLIENT_ID', clientSecretEnv: 'GEA_TEST_CLIENT_SECRET', keychainService: 'fixture-limits', tenantId: '1', allowedUserIds: ['fixture-user']}}}));
  await assert.rejects(readDeployment(file, {platform: 'darwin', credentialEnv: {}, readKeychain: () => {credentials++; throw Error('CREDENTIAL_FORBIDDEN');}}), /INVALID_SQL_READ_LIMIT/);
  assert.equal(credentials, 0);
});
