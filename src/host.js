/** Independent GEA read-only proof. Login credentials live only in this Host process. */
import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import QRCode from 'qrcode';
import z from '@deepseek-ai/schemastery';

export const inject = ['connection', 'llm'];
export const Config = z.object({
  geaBaseUrl: z.string().required(),
  pageSize: z.natural().min(1).max(10).required(),
  requestTimeoutMs: z.natural().min(1000).max(30000).required(),
});
const runtime = new URL('../.runtime/', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');

/** Preserve exact JSON numbers for business identifiers and decimal quantities. */
function parseJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && (/Id$|Code$|Qty$|Amount$/.test(key) || key === 'id')) return context.source;
    return value;
  });
}

/** The receipt adapter exercises the real session loop without external inference. */
class ReceiptAdapter extends LlmAdapter {
  providerInfo(id) { return { id, name: 'GEA local verification (no AI)' }; }
  async listModels() { return [{ id: 'receipt', name: 'Local receipt / 本地验证回执' }]; }
  async *stream(options) {
    if (options.signal?.aborted) throw options.signal.reason;
    const requestText = JSON.stringify(options.messages);
    const match = requestText.match(/GEA_SNAPSHOT_SHA256=([a-f0-9]{64})/);
    const text = match
      ? `本地验证回执（非 AI 分析）：销售计划快照已进入 dsh 模型请求。\n\nSHA-256: ${match[1]}\n\n这是数据传递验证，不构成审批意见。`
      : 'GEA integration verification';
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    await appendFile(new URL('receipts.jsonl', runtime), JSON.stringify({ at: new Date().toISOString(), snapshotHash: match?.[1] ?? null, requestHash: hash(requestText), provider: options.provider, model: options.model }) + '\n', { mode: 0o600 });
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

/** Mount an authenticated RPC channel and a local receipt provider. */
export function apply(ctx, config) {
  const url = new URL(config.geaBaseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('INVALID_GEA_BASE_URL');
  const base = url.toString().replace(/\/$/, '');
  let auth;
  let qr;
  let snapshot;
  const active = new AbortController();
  ctx.effect(() => () => { active.abort(); auth = undefined; qr = undefined; snapshot = undefined; });
  ctx.effect(() => ctx.llm.registerAdapter(['gea-proof'], new ReceiptAdapter()));

  async function get(path, authenticated = false, signal) {
    if (authenticated && !auth) throw new Error('LOGIN_REQUIRED');
    const headers = { Accept: 'application/json' };
    if (authenticated) Object.assign(headers, { 'X-Access-Token': auth.token, 'X-Tenant-Id': auth.tenantId });
    let response;
    try {
      response = await fetch(base + path, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.any([active.signal, AbortSignal.timeout(config.requestTimeoutMs), ...(signal ? [signal] : [])]) });
    } catch { throw new Error('GEA_NETWORK_ERROR'); }
    if (!response.ok) {
      if (response.status === 401) auth = undefined;
      throw new Error(`GEA_HTTP_${response.status}`);
    }
    let data;
    try { data = parseJson(await response.text()); } catch { throw new Error('GEA_INVALID_JSON'); }
    if (data.success !== true) throw new Error('GEA_REQUEST_REJECTED');
    return data.result;
  }

  const state = () => ({ authenticated: Boolean(auth), user: auth ? { name: auth.name, tenantId: auth.tenantId } : null, workspace: new URL('workspace/', runtime).pathname, source: base, provider: 'gea-proof/receipt' });
  const handle = async (endpoint, payload, signal) => {
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('INVALID_PAYLOAD');
      let value;
      switch (endpoint) {
        case 'status': value = state(); break;
        case 'login/start': {
          const result = await get('/sys/getLoginQrcode', false, signal);
          if (typeof result?.qrcodeId !== 'string' || !result.qrcodeId.trim()) throw new Error('GEA_INVALID_QR');
          qr = { id: result.qrcodeId, createdAt: Date.now() };
          const login = new URL(base + '/sys/thirdLogin/sso/lark/login');
          login.searchParams.set('state', `gea-client://scan-login?feishuScanQrcodeId=${encodeURIComponent(qr.id)}`);
          login.searchParams.set('tenantId', '0');
          value = { image: await QRCode.toDataURL(login.toString(), { width: 256, margin: 2 }), expiresIn: 120 };
          break;
        }
        case 'login/poll': {
          if (auth) { value = { status: 'authenticated', ...state() }; break; }
          if (!qr || Date.now() - qr.createdAt > 120000) { value = { status: 'expired' }; break; }
          const result = await get('/sys/getQrcodeToken?qrcodeId=' + encodeURIComponent(qr.id), false, signal);
          if (result?.token === '-1') { value = { status: 'pending' }; break; }
          if (result?.token === '-2') { value = { status: 'expired' }; break; }
          if (result?.success !== true || typeof result.token !== 'string' || !result.token.trim()) throw new Error('GEA_INVALID_LOGIN');
          const identityResponse = await fetch(base + '/sys/user/getUserInfo', { headers: { Accept: 'application/json', 'X-Access-Token': result.token }, redirect: 'error', signal: AbortSignal.any([active.signal, AbortSignal.timeout(config.requestTimeoutMs)]) });
          if (!identityResponse.ok) throw new Error('GEA_IDENTITY_FAILED');
          const identity = parseJson(await identityResponse.text());
          const user = identity.success === true ? identity.result?.userInfo : null;
          const tenantId = String(user?.loginTenantId ?? user?.tenantId ?? '');
          if (!user?.id || !(user.realname || user.username) || !/^\d+$/.test(tenantId)) throw new Error('GEA_IDENTITY_INCOMPLETE');
          auth = { token: result.token, tenantId, name: user.realname || user.username };
          qr = undefined;
          value = { status: 'authenticated', ...state() };
          break;
        }
        case 'plans': {
          const page = await get('/sales-plan/plans?pageNo=1&pageSize=' + config.pageSize, true, signal);
          if (!Array.isArray(page?.records) || typeof page.total !== 'number') throw new Error('GEA_INVALID_PAGE');
          const fields = ['planId', 'versionId', 'seq', 'periodId', 'planTypeCode', 'dealerCode', 'dealerName', 'orgName', 'provinceName', 'status', 'targetQty', 'targetAmount', 'currentQty', 'currentAmount', 'skuCount', 'updatedAt'];
          const records = page.records.map(row => Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]])));
          snapshot = { source: 'GEA_LIVE_READONLY', endpoint: '/sales-plan/plans', fetchedAt: new Date().toISOString(), tenantId: auth.tenantId, current: page.current, size: page.size, total: page.total, records };
          value = snapshot;
          break;
        }
        case 'fixture':
          snapshot = { source: 'LOCAL_FIXTURE_NOT_REAL_BUSINESS', fetchedAt: new Date().toISOString(), current: 1, size: 1, total: 1, records: [{ planId: 'fixture-001', versionId: 'fixture-version-001', planTypeCode: 'Y', dealerName: '演示经销商（虚构）', status: 10, currentQty: '12.500', targetQty: '20.000' }] };
          value = snapshot;
          break;
        case 'prepare': {
          if (!snapshot || !Number.isInteger(payload.index) || payload.index < 0 || payload.index >= snapshot.records.length) throw new Error('INVALID_SELECTION');
          const { records, ...metadata } = snapshot;
          const selected = { ...metadata, coverage: 'one selected record from the displayed page', record: records[payload.index] };
          const json = JSON.stringify(selected, null, 2);
          const snapshotHash = hash(json);
          value = { snapshotHash, prompt: `请核对以下销售计划数据已进入本会话。本次只做传递验证，不执行审批或写回。\nGEA_SNAPSHOT_SHA256=${snapshotHash}\n\n${json}` };
          await mkdir(runtime, { recursive: true, mode: 0o700 });
          await appendFile(new URL('handoffs.jsonl', runtime), JSON.stringify({ at: new Date().toISOString(), source: snapshot.source, snapshotHash }) + '\n', { mode: 0o600 });
          break;
        }
        default: throw new Error('UNKNOWN_ENDPOINT');
      }
      return { ok: true, value };
    } catch (error) {
      const code = /^[A-Z][A-Z_0-9]+$/.test(error?.message ?? '') ? error.message : 'PROOF_REQUEST_FAILED';
      return { ok: false, error: { code, message: code, details: {} } };
    }
  };
  for (const endpoint of ['status', 'login/start', 'login/poll', 'plans', 'fixture', 'prepare']) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/gea-proof/' + endpoint,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => {
        let payload;
        try { payload = await request.json(); } catch { return Response.json({ ok: false, error: { message: 'INVALID_JSON' } }, { status: 400 }); }
        return Response.json(await handle(endpoint, payload, request.signal), { headers: { 'Cache-Control': 'no-store' } });
      },
    }));
  }
}
