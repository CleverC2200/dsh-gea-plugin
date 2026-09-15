import test from 'node:test';
import assert from 'node:assert/strict';
import {_electron as electron, expect} from '@playwright/test';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

test('slow system credential access completes before the backend login request starts', {timeout:45000}, async t => {
  assert.ok(process.env.GEA_ELECTRON_EXECUTABLE && process.env.GEA_DESKTOP_PAYLOAD);
  const root = await mkdtemp(join(tmpdir(), 'gea-slow-login-'));
  const data = join(root, 'data');
  await mkdir(data);
  const config = JSON.parse(await readFile('desktop/company.config.json', 'utf8'));
  const saved = {schema:1, environment:'production', base:config.geaEnvironments?.production ?? config.geaBaseUrl,
    auth:{token:'fixture-only-slow-login', tenantId:'0', name:'Tester', id:'1', username:'tester'}};
  await writeFile(join(data, 'login.encrypted'), 'fixture-ciphertext');
  await writeFile(join(root, 'package.json'), JSON.stringify({name:'gea-slow-login-test', main:'main.cjs'}));
  // Model a synchronous OS credential prompt without reading the real keychain.
  await writeFile(join(root, 'main.cjs'), `const {safeStorage}=require('electron');
safeStorage.isEncryptionAvailable=()=>true;
safeStorage.decryptString=()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,8000);return ${JSON.stringify(JSON.stringify(saved))};};
require(${JSON.stringify(resolve('desktop/main.cjs'))});`);
  let app;
  t.after(async () => { await app?.close(); await rm(root, {recursive:true, force:true}); });
  app = await electron.launch({executablePath:resolve(process.env.GEA_ELECTRON_EXECUTABLE), args:[root],
    env:{...process.env, DSH_GEA_DESKTOP_DATA:data, GEA_DESKTOP_PAYLOAD:resolve(process.env.GEA_DESKTOP_PAYLOAD)}});
  const page = await app.firstWindow();
  await expect.poll(() => page.url(), {timeout:25000}).toMatch(/^http:\/\/127\.0\.0\.1:/);
  const status = await page.evaluate(() => fetch('/api/gea-proof/status', {
    method:'POST', headers:{'Content-Type':'application/json', 'X-GEA-Desktop-Health':'1'}, body:'{}',
  }).then(r => r.json()));
  assert.equal(status.ok, true);
  assert.equal(status.value.authenticated, true);
  assert.equal(await readFile(join(data, 'login.encrypted'), 'utf8'), 'fixture-ciphertext');
  const log = await readFile(join(data, 'desktop.log'), 'utf8');
  assert.ok(!log.includes('STARTUP_ERROR'));
  assert.ok(!log.includes(saved.auth.token));
});
