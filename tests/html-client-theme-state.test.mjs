import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

test('HTML theme subscription is scoped to the frame, live session and mounted connection', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {registerHtmlClient} from './src/html-client.tsx';
  import {createBusinessIdentityReader} from './src/business-identity-client.ts';
  import {createThemeClient} from './tests/fixtures/theme-client.mjs';
  const themeContext=createThemeClient();window.testTheme=themeContext;
    const root=createRoot(document.getElementById('app'));
    window.unmount=()=>root.unmount();
    function useMainSessionId(select) {const [value,set]=React.useState('session-1');window.changeSession=set;return select(value);}
    registerHtmlClient({...themeContext,effect:f=>f(),agentWorkbench:{register:()=>()=>{},open:async()=>{},showConversation:()=>()=>{}},layout:{selectPanel(){}},slots:{inject:(_,f)=>f(),register:(_,Component)=>{root.render(<Component useMainSessionId={useMainSessionId}/>);return ()=>{}}}}, undefined, createBusinessIdentityReader());
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://localhost:43119/**', async route => {
      const url = new URL(route.request().url());
      const data = route.request().postDataJSON();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<style>body{--workbench-theme-version:"1.0.0";--workbench-font-size:14px;--workbench-page:#f7f8fa}</style><div id="app"></div>' });
      if (url.pathname.endsWith('/status')) return route.fulfill({ json: { ok: true, value: { htmlPlugins: true } } });
      if (url.pathname.endsWith('/identity')) return route.fulfill({ json: { scope: 'fixture-identity' } });
      if (url.pathname.endsWith('/plugins')) return route.fulfill({ json: [{ id: 'inventory-fc', name: '验收' }] });
      if (url.pathname.endsWith('/open')) return route.fulfill({ json: { lease: 'lease-' + data.session } });
      if (url.pathname.endsWith('/call')) return route.fulfill({ json: data.method === 'events' ? [] : {} });
      if (url.pathname.endsWith('/html')) return route.fulfill({ contentType: 'text/html', body: `<script>
        window.received=[];
        addEventListener('message',event=>{
          if(event.source!==parent||event.data?.type!=='connect'||window.port)return;
          window.port=event.ports[0];port.onmessage=e=>received.push(e.data);port.start();
        });
        parent.postMessage({protocol:'gea-html-v1',type:'ready'},'*');
      </script>` });
      return route.abort();
    });
    await page.goto('http://localhost:43119/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await expect(page.locator('iframe')).toBeVisible();
    const child = page.frames().find(frame => frame.url().includes('/html'));
    await child.waitForFunction(() => !!window.port);
    // Window messages are not the authenticated port; a sibling cannot subscribe either.
    await page.evaluate(() => window.postMessage({ protocol: 'gea-html-v1', type: 'ready' }, '*'));
    await child.evaluate(() => port.postMessage({ type: 'theme:subscribe', session: 'stale-session' }));
    await page.waitForTimeout(100);
    assert.equal(await child.evaluate(() => received.filter(m => m.type === 'theme').length), 0);
    await child.evaluate(() => port.postMessage({ type: 'theme:subscribe', session: 'session-1' }));
    await child.waitForFunction(() => received.some(m => m.type === 'theme'));
    const first = await child.evaluate(() => received.find(m => m.type === 'theme'));
    assert.equal(first.context.session, 'session-1');
    assert.equal(first.version, '1.0.0');
    assert.equal(first.fontSize, 14);
    const themeCount = await child.evaluate(() => received.filter(m => m.type === 'theme').length);
    await page.evaluate(() => document.body.style.setProperty('--workbench-font-size', '17px'));
    await page.waitForTimeout(100);
    assert.equal(await child.evaluate(() => received.filter(m => m.type === 'theme').length), themeCount, 'DOM style edits do not replace the public theme projection');
    await page.evaluate(() => window.changeSession('session-2'));
    await child.waitForFunction(() => received.some(m => m.type === 'theme' && m.context.session === 'session-2'));
    const messages = await child.evaluate(() => received);
    const suspended = messages.findIndex(m => m.type === 'context' && m.context === null);
    const rebound = messages.findIndex(m => m.type === 'context' && m.context?.session === 'session-2');
    assert.ok(suspended >= 0 && rebound > suspended);
    await page.evaluate(() => window.testTheme.publish({ fontSize:17, active:{ colorScheme:'dark',tokens:{'--dsw-alias-label-primary':'#112233'} } }));
    await child.waitForFunction(() => received.some(m => m.type === 'theme' && m.fontSize === 17));
    const changed = await child.evaluate(() => received.filter(m => m.type === 'theme').at(-1));
    assert.equal(changed.colorScheme, 'dark');
    assert.equal(changed.tokens['--dsw-alias-label-primary'], '#112233');
    await page.evaluate(() => window.unmount());
    await expect(page.locator('iframe')).toHaveCount(0);
    await page.evaluate(() => window.testTheme.publish({ fontSize:12, active:{ colorScheme:'light',tokens:{} } }));
    assert.equal(await page.evaluate(() => window.testTheme.listenerCount()), 0);
  } finally { await browser.close(); }
});
