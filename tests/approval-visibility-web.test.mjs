import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

test('region sees own pending and tracking rows; other returns stay hidden and read-only rows cannot approve', {timeout:90000}, async t => {
  const app = await profile(t);
  const plans = Array.from({length:11}, (_, status) => ({planId:`p${status}`,versionId:`v${status}`,periodId:'period-1',planTypeCode:'Y',status,baseName:`scope-${status}-row`,orgCode:'region-a',orgName:'region-a',dealerCode:`c${status}`,currentQty:'1',currentAmount:'10',targetAmount:'10',targetQty:'1',skuCount:0}));
  app.route((req,res,reply) => {
    const path = req.url.pathname;
    const send = result => {reply({success:true,result});return true;};
    if (path.endsWith('/getPermCode')) return send({codeList:['sales-plan:plan:region-approve'],allAuth:[{action:'sales-plan:plan:category-approve'}]});
    if (path.endsWith('/periods')) return send({records:[{periodId:'period-1',periodMonth:'2026-09',planTypeCode:'Y',status:'CLOSED'}],total:1,current:1,size:100});
    if (path.endsWith('/plans')) {
      const status = req.url.searchParams.get('status');
      const rows = plans.filter(p => status === null || p.status === Number(status));
      const size = Number(req.url.searchParams.get('pageSize') || 20);
      return send({records:rows.slice(0,size).map(p => req.url.searchParams.get("orderType") === "Z" ? {...p, orderType:"Z", dealerName:p.baseName, monthlyApproved:false} : p),total:rows.length,current:1,size,pages:1});
    }
    const match = /\/plans\/(p\d+)(\/versions)?$/.exec(path);
    if (match) {
      const plan = plans.find(p=>p.planId===match[1]);
      const version = {...plan,id:plan.versionId,effective:true};
      return send(match[2] ? [version] : {currentVersion:version,versions:[version],skus:[],logs:[]});
    }
    if (path.endsWith('/notifications')) return send({items:[],total:0});
    return false;
  });
  await app.login();
  const browser = await chromium.launch({channel:'chrome',headless:true});
  t.after(()=>browser.close());
  const context = await browser.newContext({locale:'zh-CN',viewport:{width:1536,height:920}});
  await context.addCookies(app.cookie.split('; ').map(pair=>({name:pair.slice(0,pair.indexOf('=')),value:pair.slice(pair.indexOf('=')+1),url:app.origin})));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(app.origin);
  await page.getByRole('dialog',{name:'内测声明',exact:true}).getByRole('button',{name:'继续',exact:true}).click();
  const frame = page.frameLocator('iframe[data-gea-workbench]');
  await frame.getByRole('heading',{name:'销售计划审批',exact:true}).waitFor();
  const table = frame.locator('tbody').first();
  for (const status of [1,2,3,4,5,6,7,10]) await expect(table.getByText(`scope-${status}-row`,{exact:true})).toBeVisible();
  for (const status of [0,8,9]) await expect(table.getByText(`scope-${status}-row`,{exact:true})).toHaveCount(0);
  const returned = table.locator('tr').filter({hasText:'scope-7-row'});
  await returned.locator('label.arco-checkbox').click();
  await expect(frame.getByRole('button',{name:'通过',exact:true})).toBeEnabled();
  await expect(frame.getByRole('button',{name:'退回',exact:true})).toBeEnabled();
  const tracked = table.locator('tr').filter({hasText:'scope-6-row'});
  await returned.locator('label.arco-checkbox').click();
  await tracked.locator('label.arco-checkbox').click();
  await expect(frame.getByRole('button',{name:'通过',exact:true})).toBeDisabled();
  await expect(frame.getByRole('button',{name:'退回',exact:true})).toBeDisabled();
  const region = frame.getByRole('button',{name:/区域审批.*进度/});
  await region.click();
  await expect(table.getByText('scope-6-row',{exact:true})).toHaveCount(0);
  await expect(region).toHaveAttribute('aria-pressed', 'true');
  await region.click();
  await expect(table.getByText('scope-6-row',{exact:true})).toBeVisible();
  await frame.getByRole('tab',{name:'纠偏',exact:true}).click();
  for (const status of [1,2,3,4,5,6,7,10]) await expect(table.getByText(`scope-${status}-row`,{exact:true})).toBeVisible();
  for (const status of [0,8,9]) await expect(table.getByText(`scope-${status}-row`,{exact:true})).toHaveCount(0);
  assert.ok(app.requests.some(r => r.url.searchParams.get('orderType') === 'Z'));
  const queries = app.requests.filter(r=>r.url.pathname.endsWith('/plans'));
  assert.ok(queries.length);
  assert.ok(queries.every(r=>[1,2,3,4,5,6,7,10].includes(Number(r.url.searchParams.get('status'))) && r.url.searchParams.has('status')));
  assert.ok(!app.requests.some(r=>r.method==='POST' && r.url.pathname.endsWith('/actions')));
});
