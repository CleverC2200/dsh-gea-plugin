/** Black-box checks against the running published dsh and its durable session files. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { zstdDecompressSync, constants } from 'node:zlib';

const origin = 'http://127.0.0.1:3199';
const installed = JSON.parse(await readFile('node_modules/@deepseek-ai/dsh/package.json', 'utf8'));
const report = { checkedAt: new Date().toISOString(), dshVersion: installed.version, checks: [], sessions: [], liveBusinessVerified: false };
const record = (name, detail) => report.checks.push({ name, passed: true, detail });
const request = (endpoint, headers = {}, payload = {}) => fetch(origin + '/api/gea-proof/' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
assert.equal((await request('status')).status, 401);
record('unauthenticated Host access rejected', 'HTTP 401');
const log = await readFile('.runtime/server.log', 'utf8');
const launch = [...log.matchAll(/dsh web: (http[^\s]+)/g)].at(-1)?.[1];
assert.ok(launch, 'Run npm start first');
const exchange = await fetch(launch, { redirect: 'manual' });
const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie, 'The standard launch-token exchange must establish a browser session');
const headers = { Cookie: cookie, Origin: origin };
const status = await (await request('status', headers)).json();
assert.equal(status.ok, true);
record('external authenticated Fetch route responds', { authenticatedToGea: status.value.authenticated, source: status.value.source });
assert.equal((await request('status', { ...headers, Origin: 'https://example.invalid' })).status, 403);
record('foreign Origin rejected', 'HTTP 403');
if (!status.value.authenticated) {
  const plans = await (await request('plans', headers)).json();
  assert.equal(plans.error.code, 'LOGIN_REQUIRED');
  record('business query requires GEA login', 'LOGIN_REQUIRED');
}
const invalid = await (await request('prepare', headers, { index: -1 })).json();
assert.equal(invalid.error.code, 'INVALID_SELECTION');
record('invalid selected record rejected', 'INVALID_SELECTION');

const root = '.runtime/home/sessions';
for (const workspace of await readdir(root)) {
  for (const session of await readdir(root + '/' + workspace)) {
    const path = root + '/' + workspace + '/' + session + '/session.v3.jsonl.zstd';
    const compressed = await readFile(path);
    let offset = 0;
    let content = '';
    while (offset < compressed.length) {
      const frame = zstdDecompressSync(compressed.subarray(offset), { info: true, finishFlush: constants.ZSTD_e_flush });
      assert.ok(frame.engine.bytesWritten > 0);
      content += frame.buffer.toString();
      offset += frame.engine.bytesWritten;
    }
    const rows = content.trim().split('\n').map(line => JSON.parse(line));
    const user = rows.find(row => row.type === 'user/message' && JSON.stringify(row).includes('GEA_SNAPSHOT_SHA256='));
    if (!user) continue;
    const texts = [];
    const collect = value => { if (typeof value === 'string') texts.push(value); else if (Array.isArray(value)) value.forEach(collect); else if (value && typeof value === 'object') Object.values(value).forEach(collect); };
    collect(user);
    const text = texts.find(value => value.includes('GEA_SNAPSHOT_SHA256='));
    const expected = text.match(/GEA_SNAPSHOT_SHA256=([a-f0-9]{64})/)?.[1];
    const json = text.slice(text.indexOf('\n\n') + 2);
    assert.equal(createHash('sha256').update(json).digest('hex'), expected);
    const snapshot = JSON.parse(json);
    assert.ok(rows.some(row => row.type === 'assistant/message' && JSON.stringify(row).includes(expected)));
    assert.ok(rows.some(row => row.type === 'turn/end'));
    report.sessions.push({ sessionId: session, source: snapshot.source, sourceUrl: snapshot.sourceUrl ?? null, snapshotHash: expected, events: rows.length, durableFile: path });
  }
}
assert.ok(report.sessions.length > 0, 'Send a selected record through the UI first');
record('durable user snapshot hash equals assistant receipt', report.sessions.length + ' session(s)');
const receipts = (await readFile('.runtime/receipts.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
const handoffs = (await readFile('.runtime/handoffs.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
for (const session of report.sessions) {
  assert.ok(receipts.some(receipt => receipt.snapshotHash === session.snapshotHash && receipt.provider === 'gea-proof'));
  assert.ok(handoffs.some(handoff => handoff.snapshotHash === session.snapshotHash && handoff.source === session.source));
}
record('local adapter received the same snapshot', 'No external model used');
report.liveBusinessVerified = report.sessions.some(session => session.source === 'GEA_LIVE_READONLY' && session.sourceUrl === status.value.source + '/sales-plan/plans');
await writeFile('.runtime/verification.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
if (process.argv.includes('--require-live')) assert.ok(report.liveBusinessVerified, 'Real GEA query and selected-record handoff have not yet been verified');
console.log(JSON.stringify(report, null, 2));
