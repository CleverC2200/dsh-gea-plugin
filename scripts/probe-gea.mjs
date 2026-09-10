/** Reproduce GEA query failures through the running plugin without exporting credentials. */
import { readFile, writeFile } from 'node:fs/promises';
const log = await readFile('.runtime/server.log', 'utf8');
const launch = [...log.matchAll(/dsh web: (http[^\s]+)/g)].at(-1)[1];
const origin = new URL(launch).origin;
const exchange = await fetch(launch, { redirect: 'manual' });
const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const call = async endpoint => (await fetch(origin + '/api/gea-proof/' + endpoint, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin }, body: '{}',
})).json();
const deadline = Date.now() + (process.argv.includes('--wait-login') ? 110000 : 0);
let status = await call('status');
while (!status.value?.authenticated && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 2500));
  status = await call('status');
}
const report = { checkedAt: new Date().toISOString(), source: status.value?.source, authenticated: status.value?.authenticated === true, tenantId: status.value?.user?.tenantId ?? null };
if (report.authenticated) {
  report.diagnostics = await call('diagnostics');
  const plans = await call('plans');
  report.plans = plans.ok ? { ok: true, source: plans.value.source, returnedRecords: plans.value.records.length, total: plans.value.total } : plans;
} else report.plans = { ok: false, error: { code: 'LOGIN_REQUIRED' } };
await writeFile('.runtime/gea-probe.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (!report.plans.ok) process.exitCode = 1;
