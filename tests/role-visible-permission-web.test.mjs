import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

test('granted visible region role can open approval when current-node capabilities are empty', {timeout:90000}, async t => {
  const app = await profile(t);
  const plan = {
    planId: 'p-role-visible',
    versionId: 'v-role-visible',
    periodId: 'period-1',
    planTypeCode: 'Y',
    status: 2,
    baseName: '跨节点区域审批',
    orgCode: 'region-a',
    orgName: 'region-a',
    dealerCode: 'customer-a',
    currentQty: '1',
    currentAmount: '10',
    targetAmount: '10',
    targetQty: '1',
    skuCount: 0,
  };

  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = result => { reply({success:true,result}); return true; };
    if (path.endsWith('/getPermCode')) return send({codeList:['sales-plan:plan:region-approve']});
    if (path.endsWith('/periods')) return send({records:[{periodId:'period-1',periodMonth:'2026-09',planTypeCode:'Y',status:'CLOSED'}],total:1,current:1,size:100});
    if (path.endsWith('/plans')) {
      const requestedStatus = req.url.searchParams.get('status');
      const records = requestedStatus === null || Number(requestedStatus) === plan.status ? [plan] : [];
      return send({records,total:records.length,current:1,size:20,pages:1});
    }
    if (path.endsWith(`/plans/${plan.planId}`)) return send({
      currentVersion:{...plan,id:plan.versionId,effective:true},
      versions:[],
      skus:[],
      logs:[],
      actionContext:{
        versionId:plan.versionId,
        status:plan.status,
        snapshotHash:'a'.repeat(64),
        policy:'role-visible-v1',
        allowedActions:[],
        roleActions:[],
      },
    });
    if (path.endsWith('/notifications')) return send({items:[],total:0});
    return false;
  });

  await app.login();
  const browser = await chromium.launch({channel:'chrome',headless:true});
  t.after(() => browser.close());
  const context = await browser.newContext({locale:'zh-CN',viewport:{width:1280,height:800}});
  await context.addCookies(app.cookie.split('; ').map(pair => ({
    name:pair.slice(0,pair.indexOf('=')),
    value:pair.slice(pair.indexOf('=')+1),
    url:app.origin,
  })));
  const page = await context.newPage();
  await page.goto(app.origin);
  await page.getByRole('dialog',{name:'内测声明',exact:true}).getByRole('button',{name:'继续',exact:true}).click();

  const frame = page.frameLocator('iframe[data-gea-workbench]');
  const row = frame.locator('tbody tr').filter({hasText:plan.baseName}).first();
  await expect(row).toBeVisible();
  await row.locator('label.arco-checkbox').click();
  const approve = frame.getByRole('button',{name:'通过',exact:true});
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(frame.getByRole('dialog',{name:'销售计划审批',exact:true})).toBeVisible();
});
