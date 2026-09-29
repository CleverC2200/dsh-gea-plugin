import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

test('new conversation rebinds the existing HTML page without losing page state or its port', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {registerHtmlClient} from './src/html-client.tsx';
    const root=createRoot(document.getElementById('app'));
    function useMainSessionId(select) {const [value,set]=React.useState('session-1');window.changeSession=set;return select(value);}
    registerHtmlClient({effect:f=>f(),agentWorkbench:{register:()=>()=>{},open:async()=>{},showConversation:()=>()=>{}},layout:{selectPanel(){}},remote:{session:{prompt:async input=>{window.sent=input;return {ok:true}}}},slots:{inject:(_,f)=>f(),register:(_,Component)=>{root.render(<Component useMainSessionId={useMainSessionId}/>);return ()=>{}}}}, {bindFrame:({sessionId})=>{window.selectionSession=sessionId;return ()=>{window.selectionSession=null}}});
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    let htmlLoads=0; const calls=[];
    await page.route('http://localhost:43119/**', async route=>{
      const url=new URL(route.request().url()); const data=route.request().postDataJSON();
      if(url.pathname==='/') return route.fulfill({contentType:'text/html',body:'<div id="app"></div>'});
      if(url.pathname.endsWith('/status')) return route.fulfill({json:{ok:true,value:{htmlPlugins:true}}});
      if(url.pathname.endsWith('/identity')) return route.fulfill({json:{scope:'fixture-identity'}});
      if(url.pathname.endsWith('/plugins')) return route.fulfill({json:[{id:'inventory-fc',name:'分仓库存'}]});
      if(url.pathname.endsWith('/open')) return route.fulfill({json:{lease:'lease-'+data.session}});
      if(url.pathname.endsWith('/call')) { calls.push(data);return route.fulfill({json:data.method==='events'?[]:{ok:true}}); }
      if(url.pathname.endsWith('/html')) {
        htmlLoads++;
        return route.fulfill({contentType:'text/html',body:`<input id="filter"><div style="height:2000px">table</div><script>
        window.addEventListener('message',event=>{if(event.data.type!=='connect'||window.port)return;window.port=event.ports[0];port.start();port.postMessage({type:'register',name:'filter',description:'Filter rows'});window.read=()=>port.postMessage({type:'request',id:'read',method:'workspace'});window.ask=()=>port.postMessage({type:'request',id:'ask',method:'conversation',parameters:{text:'hello',context:{filter:document.querySelector('input').value}}});});
        parent.postMessage({protocol:'gea-html-v1',type:'ready'},'*');</script>`});
      }
      return route.abort();
    });
    await page.goto('http://localhost:43119/');await page.addScriptTag({content:bundle.outputFiles[0].text});
    const frame=page.frameLocator('iframe');await frame.locator('#filter').fill('华东');
    await page.waitForFunction(()=>!!document.querySelector('iframe'));
    const child=page.frames().find(f=>f.url().includes('/html'));
    await child.waitForFunction(()=>!!window.port);
    await child.evaluate(()=>{window.marker='retained';window.scrollTo(0,300)});
    await page.evaluate(()=>window.changeSession('session-2'));
    await page.waitForTimeout(250);
    await child.evaluate(()=>{window.read();window.ask()});
    await page.waitForFunction(()=>window.sent?.sessionId==='session-2', null, {timeout:5000}).catch(async error=>{console.log(JSON.stringify({calls,state:await page.evaluate(()=>({sent:window.sent,text:document.body.innerText}))}));throw error;});
    assert.equal(await page.evaluate(()=>window.selectionSession),'session-2');
    assert.equal(htmlLoads,1);
    assert.equal(await frame.locator('#filter').inputValue(),'华东');
    assert.equal(await child.evaluate(()=>window.marker),'retained');
    assert.equal(await child.evaluate(()=>window.scrollY),300);
    assert.ok(calls.some(c=>c.method==='workspace'&&c.lease==='lease-session-2'));
    assert.ok(calls.some(c=>c.method==='register'&&c.lease==='lease-session-2'));
    assert.ok(calls.some(c=>c.method==='close'&&c.lease==='lease-session-1'));
  } finally {await browser.close();}
});
