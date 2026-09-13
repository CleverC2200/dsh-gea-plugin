import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const { outputFiles } = await build({ stdin: { contents: "export * from './src/service-account.ts';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { submitWithServiceAccount, validateServiceAccounts, serviceAccountReady } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'));
const config = { clientIdEnv: 'GEA_TEST_CLIENT', clientSecretEnv: 'GEA_TEST_SECRET', tenantId: '0', allowedUserIds: ['user'] };
process.env.GEA_TEST_CLIENT = 'fixture-client'; process.env.GEA_TEST_SECRET = 'fixture-secret';
const receipt = { planId: 'p', versionId: 'v2', seq: 2, status: 2, replayed: false, requestId: 'request', traceId: 'trace', auditId: 'audit' };
test('service identity is environment-configured and does not authorize another tenant or user', () => {
  validateServiceAccounts({ production: config });
  assert.equal(serviceAccountReady(config, { id: 'user', tenantId: '0' }), true);
  assert.equal(serviceAccountReady(config, { id: 'other', tenantId: '0' }), false);
  assert.equal(serviceAccountReady(config, { id: 'user', tenantId: '1' }), false);
  assert.throws(() => validateServiceAccounts({ production: { ...config, secret: 'plaintext' } }));
});
test('OAuth form exchange precedes one submit with service Bearer and stable request keys', async () => {
  let calls = 0;
  const fetcher = async (url, init) => {
    calls++;
    assert.equal(init.redirect, 'error');
    if (calls === 1) {
      assert.equal(url, 'https://gea.test/gea-boot/api/v1/internal/auth/token');
      assert.equal(init.body.get('client_secret'), 'fixture-secret');
      assert.equal(init.body.get('grant_type'), 'client_credentials');
      return Response.json({ success: true, result: { access_token: 'fixture-token', token_type: 'Bearer', expires_in: 600, scope: 'sales-plan:write' } });
    }
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    assert.equal(init.headers['X-Access-Token'], undefined);
    assert.equal(init.headers['Idempotency-Key'], 'idem');
    assert.equal(init.body, '{"items":[]}');
    return Response.json({ success: true, result: { ...receipt, secret: 'must-not-return' } });
  };
  assert.deepEqual(await submitWithServiceAccount(config, 'https://gea.test/gea-boot', '{"items":[]}', 'request', 'idem', new AbortController().signal, fetcher), receipt);
  assert.equal(calls, 2);
});
test('token errors are redacted and never reach submission', async () => {
  let calls = 0;
  await assert.rejects(submitWithServiceAccount(config, 'https://gea.test', '{}', 'request', 'idem', new AbortController().signal, async () => {
    calls++; return Response.json({ message: 'fixture-secret fixture-client' }, { status: 401 });
  }), error => !error.message.includes('fixture-secret') && error.code === 'GEA_HTTP_401');
  assert.equal(calls, 1);
});
test('an uncertain submission exposes only a same-key retry hint', async () => {
  let calls = 0;
  await assert.rejects(submitWithServiceAccount(config, 'https://gea.test', '{}', 'request', 'idem', new AbortController().signal, async () => {
    if (++calls === 1) return Response.json({ success: true, result: { access_token: 'fixture-token', token_type: 'Bearer', expires_in: 600, scope: 'sales-plan:write' } });
    throw new TypeError('lost response');
  }), error => error.code === 'GEA_HTTP_502' && error.details.retrySameIntent === true);
  assert.equal(calls, 2);
});
