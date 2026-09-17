import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

test('region sees own pending and tracking rows; other returns stay hidden and visible tracking rows expose role approval', {timeout:90000}, async t => {
  const app = await profile(t);
  const plans = Array.from({length:11}, (_, status) => ({planId:`p${status}`,versionId:`v${status}`,periodId:'period-1',planTypeCode:'Y',status,baseName:`scope-${status}-row`,orgCode:'region-a',orgName:'region-a',dealerCode:`c${status}`,currentQty:'1',currentAmount:'10',targetAmount:'10',targetQty:'1',skuCount:0}));
  const writes=[];
  app.route((req,res,reply) => {
    const path = req.url.pathname;
    const send = result => {reply({success:true,result});return true;};
    if (path.endsWith('/getPermCode')) return send({codeList:['sales-plan:plan:region-approve'],allAuth:[{action:'sales-plan:plan:category-approve'}]});
    if (path.endsWith('/periods')) return send({records:[{periodId:'period-1',periodMonth:'2026-09',planTypeCode:'Y',status:'CLOSED'}],total:1,current:1,size:100});
    if (path.endsWith('/plans')) {
      const status = req.url.searchParams.get('status');
      const rows = plans.filter(p => status === null || p.status === Number(status));
      const size = Number(req.url.searchParams.get('pageSize') || 20);
      return send({records:rows.slice(0,size),total:rows.length,current:1,size,pages:1});
    }
    const match = /\/plans\/(p\d+)(\/versions)?$/.exec(path);
    if (match) {
      const plan = plans.find(p=>p.planId===match[1]);
      const version = {...plan,id:plan.versionId,effective:true};
      return send(match[2] ? [version] : {currentVersion:version,versions:[version],skus:[],logs:[], ...(plan.status === 2 ? {actionContext:{versionId:plan.versionId,status:2,snapshotHash:'a'.repeat(64),policy:'role-visible-v1',allowedActions:[],roleActions:[{role:'region',allowedActions:['APPROVE','REJECT']}]}} : {})});
    }
    if(path.endsWith('/versions/v2/skus')) return send([]);
    if(path.endsWith('/versions/v2/actions')) {const body=JSON.parse(req.body);writes.push(body);return send({planId:'p2',versionId:'v2',fromStatus:2,toStatus:2,approvalRole:'region',requestId:req.headers['x-request-id'],traceId:'t',auditId:'a',replayed:false});}
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
  const region = frame.getByRole('button',{name:/区域审批.*进度/});
  await expect(region).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.getByRole('button',{name:/客户提报.*进度/})).not.toContainText('进度 0%');
  await region.click();
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
  await expect(frame.getByRole('button',{name:'通过',exact:true})).toBeEnabled();
  await expect(frame.getByRole('button',{name:'退回',exact:true})).toBeEnabled();
  await region.click();
  await expect(table.getByText('scope-6-row',{exact:true})).toHaveCount(0);
  await expect(region).toHaveAttribute('aria-pressed', 'true');
  await region.click();
  await expect(table.getByText('scope-6-row',{exact:true})).toBeVisible();
  const queries = app.requests.filter(r=>r.url.pathname.endsWith('/plans'));
  assert.ok(queries.length);
  const queueQueries = queries.filter(r => r.url.searchParams.has('status') && r.url.searchParams.get('pageSize') !== '1');
  assert.ok(queueQueries.length);
  assert.ok(queueQueries.every(r=>[1,2,3,4,5,6,7,10].includes(Number(r.url.searchParams.get('status')))));
  assert.ok(queries.some(r => !r.url.searchParams.has('status')));
  assert.equal(writes.length,0);
  for (const checked of await table.locator('label.arco-checkbox-checked').all()) await checked.click();
  const regionCanReview = table.locator('tr').filter({hasText:'scope-2-row'});
  await regionCanReview.locator('label.arco-checkbox').click();
  await frame.getByRole('button',{name:'通过',exact:true}).click();
  await expect(frame.getByRole('dialog',{name:'销售计划审批',exact:true})).toHaveCount(0);
  await expect.poll(() => writes.length).toBe(1);
  assert.equal(writes.length,1);
  assert.equal(writes[0].approvalRole,'region');
  assert.equal(writes[0].approvalPolicy,'role-visible-v1');
  assert.equal(writes[0].expectedStatus,2);
  await expect(regionCanReview.locator('label.arco-checkbox')).toBeVisible();
  await regionCanReview.locator('label.arco-checkbox').click();
  await frame.getByRole('button',{name:'退回',exact:true}).click();
  const rejectDialog = frame.getByRole('dialog',{name:'退回',exact:true});
  await expect(rejectDialog.getByRole('textbox',{name:'退回原因（必填）',exact:true})).toBeVisible();
  await expect(rejectDialog.getByTestId('regional-approval-live-action-checksum')).toHaveCount(0);
});
