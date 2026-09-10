import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geaResponseError } from '../src/gea-error.js';

test('403 preserves upstream reason and correlation fields without returning arbitrary body data', async () => {
  const response = Response.json({ message: '没有销售计划查询权限', errorCode: 'PLAN_FORBIDDEN', category: 'AUTHORIZATION', requestId: 'request-123', result: { private: 'must not return' } }, { status: 403 });
  const error = await geaResponseError(response, []);
  assert.equal(error.message, 'GEA_HTTP_403：没有销售计划查询权限');
  assert.deepEqual(error.details, { httpStatus: 403, upstreamCode: 'PLAN_FORBIDDEN', category: 'AUTHORIZATION', requestId: 'request-123' });
});

test('an echoed access token is redacted from both message and correlation fields', async () => {
  const token = 'test-secret-with-no-jwt-format';
  const error = await geaResponseError(Response.json({ message: `invalid token ${token}`, requestId: token }, { status: 403 }), [token]);
  assert.equal(error.message.includes(token), false);
  assert.equal(JSON.stringify(error.details).includes(token), false);
});

test('non-JSON gateway denial does not invent a permission reason', async () => {
  const error = await geaResponseError(new Response('<h1>Denied</h1>', { status: 403 }), []);
  assert.equal(error.message, 'GEA_HTTP_403');
  assert.deepEqual(error.details, { httpStatus: 403 });
});
