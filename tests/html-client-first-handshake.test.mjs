import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const css = await readFile(new URL('../../dsh-agent-workbench/theme/tokens.css', import.meta.url), 'utf8');
const sample = (await readFile(new URL('../../dsh-agent-workbench/samples/html-table.html', import.meta.url), 'utf8'))
  .replace('/* SHARED_THEME_RESOURCE */', css);
const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {registerHtmlClient} from './src/html-client.tsx';
  import {createBusinessIdentityReader} from './src/business-identity-client.ts';
  const root=createRoot(document.getElementById('app'));
  window.unmount=()=>root.unmount();
  function useMainSessionId(select) {
    const [value,set]=React.useState('session-1');window.changeSession=set;return select(value);
  }
  registerHtmlClient({effect:f=>f(),agentWorkbench:{register:()=>()=>{},open:async()=>{},showConversation:()=>()=>{}},
    layout:{selectPanel(){}},slots:{inject:(_,f)=>f(),register:(_,Component)=>{
      root.render(<Component useMainSessionId={useMainSessionId}/>);return ()=>{};
    }}}, undefined, createBusinessIdentityReader());
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser' });

async function fixture(t, { managed = false } = {}) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  const calls = [];
  page.on('pageerror', error => errors.push(error.message));
  const html = Promise.withResolvers();
  const requestedHtml = Promise.withResolvers();
  const opens = new Map(['session-2', 'session-3'].map(session => [session, {
    requested: Promise.withResolvers(), release: Promise.withResolvers(), completed: Promise.withResolvers(),
  }]));
  await page.addInitScript(() => {
    window.connects = [];
    window.readyCount = 0;
    addEventListener('message', event => {
      if (event.data?.type === 'ready') window.readyCount++;
      if (event.data?.type === 'connect') window.connects.push(event.data.context);
    });
  });
  await page.route('http://localhost:43119/**', async route => {
    const url = new URL(route.request().url());
    const data = route.request().postDataJSON();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="app"></div>` });
    if (url.pathname.endsWith('/status')) return route.fulfill({ json: { ok: true, value: { htmlPlugins: true } } });
    if (url.pathname.endsWith('/identity')) return route.fulfill({ json: { scope: 'fixture-identity' } });
    if (url.pathname.endsWith('/plugins')) return route.fulfill({ json: [{ id: 'inventory-fc', name: '表格样板', ...(managed ? { agentResources: { provider: 'dsh-agent-manage' } } : {}) }] });
    if (url.pathname.endsWith('/open')) {
      const gate = opens.get(data.session);
      if (gate) { gate.requested.resolve(); await gate.release.promise; }
      await route.fulfill({ json: { lease: 'lease-' + data.session } });
      gate?.completed.resolve();
      return;
    }
    if (url.pathname.endsWith('/call')) {
      calls.push(data);
      return route.fulfill({ json: data.method === 'events' ? [] : {} });
    }
    if (url.pathname.endsWith('/html')) {
      requestedHtml.resolve();
      await html.promise;
      return route.fulfill({ contentType: 'text/html', body: managed
        ? sample.replace('port = event.ports[0];', 'port = event.ports[0]; window.testPort = port; window.testSession = () => context?.session;')
        : sample });
    }
    return route.abort();
  });
  await page.goto('http://localhost:43119/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await requestedHtml.promise;
  await page.evaluate(() => window.changeSession('session-2'));
  await opens.get('session-2').requested.promise;
  html.resolve();
  const child = page.frames().find(frame => frame !== page.mainFrame());
  await child.waitForSelector('#controls');
  await page.waitForFunction(() => readyCount > 0);
  return { page, child, opens, errors, calls };
}

test('first ready during a Session switch connects the actual sample after its current lease is ready', async t => {
  const { child, opens } = await fixture(t);
  assert.equal(await child.locator('#query').isDisabled(), true);
  opens.get('session-2').release.resolve();
  await expect(child.locator('#query')).toBeEnabled({ timeout: 2500 });
  await expect(child.locator('#rows tr')).toHaveCount(4);
  assert.deepEqual(await child.evaluate(() => connects), [{ plugin: 'inventory-fc', session: 'session-2' }]);
});


test('repeated ready and a superseded opening transfer only the latest Session port once', async t => {
  const { page, child, opens, errors } = await fixture(t);
  await page.evaluate(() => window.changeSession('session-3'));
  await opens.get('session-3').requested.promise;
  await child.evaluate(() => {
    for (let i = 0; i < 3; i++) parent.postMessage({ protocol: 'gea-html-v1', type: 'ready' }, '*');
  });
  opens.get('session-3').release.resolve();
  await expect(child.locator('#query')).toBeEnabled({ timeout: 2500 });
  opens.get('session-2').release.resolve();
  await opens.get('session-2').completed.promise;
  await expect(child.locator('#rows tr')).toHaveCount(4);
  assert.deepEqual(await child.evaluate(() => connects), [{ plugin: 'inventory-fc', session: 'session-3' }]);
  assert.deepEqual(errors, []);
});

test('ready survives an absent Session until a later valid binding is available', async t => {
  const { page, child, opens, errors } = await fixture(t);
  await page.evaluate(() => window.changeSession(undefined));
  await child.evaluate(() => parent.postMessage({ protocol: 'gea-html-v1', type: 'ready' }, '*'));
  assert.deepEqual(await child.evaluate(() => connects), []);
  await page.evaluate(() => window.changeSession('session-3'));
  await opens.get('session-3').requested.promise;
  opens.get('session-3').release.resolve();
  await expect(child.locator('#query')).toBeEnabled({ timeout: 2500 });
  opens.get('session-2').release.resolve();
  await opens.get('session-2').completed.promise;
  assert.deepEqual(await child.evaluate(() => connects), [{ plugin: 'inventory-fc', session: 'session-3' }]);
  assert.deepEqual(errors, []);
});

test('unmount cancels a pending first handshake before its opening completes', async t => {
  const { page, child, opens, errors } = await fixture(t);
  assert.deepEqual(await child.evaluate(() => connects), []);
  await page.evaluate(() => window.unmount());
  opens.get('session-2').release.resolve();
  await opens.get('session-2').completed.promise;
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.deepEqual(errors, []);
});

test('a late managed page request cannot follow a new Session lease', async t => {
  const { page, child, opens, calls, errors } = await fixture(t, { managed: true });
  opens.get('session-2').release.resolve();
  await expect(child.locator('#query')).toBeEnabled();
  await page.evaluate(() => window.changeSession('session-3'));
  await opens.get('session-3').requested.promise;
  opens.get('session-3').release.resolve();
  await child.waitForFunction(() => window.testSession?.() === 'session-3');
  await child.evaluate(() => window.testPort.postMessage({ type: 'request', id: 'stale', method: 'context', parameters: { marker: 'old' }, session: 'session-2' }));
  await child.evaluate(() => window.testPort.postMessage({ type: 'request', id: 'current', method: 'context', parameters: { marker: 'new' }, session: 'session-3' }));
  await expect.poll(() => calls.some(call => call.method === 'context' && call.parameters?.marker === 'new')).toBe(true);
  assert.equal(calls.some(call => call.method === 'context' && call.parameters?.marker === 'old'), false);
  assert.equal(calls.find(call => call.parameters?.marker === 'new').lease, 'lease-session-3');
  assert.deepEqual(errors, []);
});
