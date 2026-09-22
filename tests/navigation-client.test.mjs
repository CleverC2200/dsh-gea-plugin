import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {chromium,expect} from '@playwright/test';

test('页面登录后续跳，详情真正可见才发送 ACK，重复轮询不重新打开', {timeout:30000}, async t=>{
  assert.ok(existsSync(new URL('../src/client/desktop-navigation.tsx',import.meta.url)),'缺少导航页面消费组件');
  const output=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{DesktopNavigation}from'./src/client/desktop-navigation.tsx';import{Inbox}from'./src/client/inbox.tsx';import{zh}from'./src/client/locales.ts';
    const listeners=new Set();let target=null;
    function App(){const [item,setItem]=React.useState(null);React.useEffect(()=>{listeners.add(setItem);return()=>listeners.delete(setItem)},[]);
      const open=React.useCallback((value,signal)=>new Promise((resolve,reject)=>{window.opens=(window.opens||0)+1;target={...value,visible:resolve,failed:reject};listeners.forEach(fn=>fn(target));signal.addEventListener('abort',()=>{target=null;listeners.forEach(fn=>fn(null));reject(Error('cancelled'))},{once:true})}),[]);
      return <><DesktopNavigation t={key=>zh[key]} open={open} login={()=>{window.loginClicked=true}}/><Inbox t={key=>zh[key]} navigation={item}/></>}
    createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser'});
  let logged=false,finished=0,release,identityRevision=0,detailRequests=0;
  const ready={state:'ready',receipt:'receipt-1',panel:'gea-inbox',notificationId:'notice-1',interactionRequestId:'ir-1'};
  const detail={id:'notice-1',interaction_request_id:'ir-1',title:'测试待办',state:'unread'};
  const server=createServer(async(req,res)=>{
    const reply=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,value}));};
    if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(output.outputFiles[0].text);return;}
    if(req.url?.endsWith('/navigation/poll'))return reply({...(!logged?{state:'login'}:finished?{state:'idle'}:ready),identityRevision});
    if(req.url?.endsWith('/navigation/finish')){finished++;return reply({state:'idle'});}
    if(req.url?.endsWith('/notifications')){let body='';for await(const c of req)body+=c;const value=JSON.parse(body);
      if(value.id){detailRequests++;if(value.id==='notice-2')return reply({detail:{...detail,id:'notice-2',title:'另一条通知',interactionRequestId:'ir-2'}});release=()=>reply({detail:{...detail,interactionRequestId:'ir-1'}});return;}
      return reply({items:[{...detail,id:'notice-2',title:'另一条通知'}],total:1,unreadCount:1,pageSize:20});}
    res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.goto('http://127.0.0.1:'+server.address().port);await expect(page.getByRole('button',{name:'登录并继续'})).toBeVisible();assert.equal(finished,0);
  logged=true;await expect.poll(()=>Boolean(release)).toBe(true);assert.equal(finished,0);assert.equal(await page.evaluate(()=>window.opens),1);
  release();await expect(page.getByRole('dialog')).toBeVisible();await expect.poll(()=>finished).toBe(1);assert.equal(await page.evaluate(()=>window.opens),1);
  // 已完成唤醒不能锁死消息列表，用户仍可手动阅读另一条详情。
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'另一条通知',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('另一条通知');
  await expect.poll(()=>detailRequests).toBe(2);
  // 同目标的新 receipt 必须等待本次详情，不能复用旧详情提前确认。
  ready.receipt='receipt-2';finished=0;release=undefined;
  await expect.poll(()=>detailRequests).toBe(3);assert.equal(finished,0);
  // 退出登录撤销旧页面，即使上一导航曾经完成或本次详情尚未返回。
  logged=false;identityRevision++;
  await expect(page.getByRole('button',{name:'登录并继续'})).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();release();assert.equal(finished,0);
});
