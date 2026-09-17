import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {profile} from './profile.mjs';

test('V1.6 visual: compact header, stable progress, inline SKU, drawer and persistent private drafts', {timeout:90000}, async t=>{
 const app=await profile(t,{config:base=>({analysis:{mode:'model',source:'direct',baseUrl:base+'/v1',model:'fixture-model',apiKeyEnv:'GEA_V16_MODEL_KEY',contextWindow:32768,maxTokens:2048}}),env:{GEA_V16_MODEL_KEY:'fixture-key'}});
 let modelCalls=0;
 const plan={planId:'p',versionId:'v',seq:1,periodId:'period-1',planTypeCode:'Y',orderType:'M',dealerCode:'d',dealerName:'客户A',orgCode:'org',orgName:'宝阳销售组',provinceCode:'province',provinceName:'华南省区',areaCode:'area',areaName:'华南大区',status:1,mPlanQty:'20',mPlanAmount:'200',currentQty:'20',currentAmount:'200',targetQty:'40',targetAmount:'400',skuCount:1};
 const sku={id:'s',skuCode:'1001',versionId:'v',productCategName:'汤圆',materialDescription:'黑芝麻汤圆 500g',qty:'20',baseQty:'10',amt:'200',amtBase:'100',price:'10'};
 const unchangedSku={...sku,id:'unchanged',skuCode:'1002',productCategName:'饺子',materialDescription:'无调整测试物料',qty:'0',baseQty:'0',amt:'0',amtBase:'0'};
 let writes=0; let allowApproval=false;
 app.route((req,res,reply)=>{
  const path=req.url.pathname;
  if(path==='/v1/chat/completions') {
   modelCalls++;
   const body=JSON.parse(req.body);const content=JSON.stringify(body.messages);
   const answer=content.includes('r0') ? JSON.stringify({r0:'当前计划高于基准，请结合库存核对。'}) : '当前计划为 20，月度目标为 40，完成 50%。请核对库存后审批。';
   res.setHeader('Content-Type','text/event-stream');
   res.end('data: '+JSON.stringify({id:'reply',object:'chat.completion.chunk',choices:[{index:0,delta:{content:answer},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'reply',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return true;
  }
  if(path.endsWith('/plans')){const status=req.url.searchParams.get('status');const records=status===null || status==='1'?[plan]:[];reply({success:true,result:{records,total:records.length,pages:1,current:1,size:Number(req.url.searchParams.get('pageSize')||20)}});return true;}
  if(path.endsWith('/plans/p')){reply({success:true,result:{currentVersion:{...plan,id:'v',effective:true},skus:[sku,unchangedSku],versions:[],logs:[],actionContext:{versionId:'v',status:1,nodeOrder:2,allowedActions:['SAVE','APPROVE','REJECT'],snapshotHash:'a'.repeat(64)}}});return true;}
  if(path.endsWith('/versions')){reply({success:true,result:[{...plan,id:'v',effective:true},{...plan,id:'v0',seq:0,effective:false,targetQty:null,targetAmount:null}]});return true;}
  if(path.endsWith('/versions/v0/skus')){reply({success:true,result:[{...sku,versionId:'v0',qty:'10',amt:'100'}]});return true;}
  if(path.endsWith('/versions/v/skus')){reply({success:true,result:[sku,unchangedSku]});return true;}
  if(path.endsWith('/actions')){
   assert.equal(allowApproval,true); const body=JSON.parse(req.body);
   assert.equal(body.action,'APPROVE');assert.deepEqual(body.adjustments,[{skuCode:'1001',adjustQty:'2.125'}]);
   writes++;plan.status=2;
   reply({success:true,result:{planId:'p',versionId:'v',fromStatus:1,toStatus:2,replayed:false,requestId:req.headers['x-request-id'],traceId:'trace',auditId:'audit'}});return true;
  }
 });
 await app.login();
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const context=await browser.newContext({locale:'zh-CN',viewport:{width:1536,height:920}});
 await context.addCookies(app.cookie.split('; ').map(pair=>({name:pair.slice(0,pair.indexOf('=')),value:pair.slice(pair.indexOf('=')+1),url:app.origin})));
 const page=await context.newPage(); page.setDefaultTimeout(10000); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(app.origin);await page.getByRole('dialog',{name:'内测声明',exact:true}).getByRole('button',{name:'继续',exact:true}).click();
 await mkdir('.runtime/v16-visual',{recursive:true});
 const shot=async name=>{await page.waitForTimeout(400);await page.screenshot({path:'.runtime/v16-visual/'+name+'.png',fullPage:true,animations:'disabled'});};
 const frame=page.frameLocator('iframe[data-gea-workbench]');
 await expect(frame.getByTestId('regional-approval-workbench')).toBeVisible();
 await expect(frame.getByRole('button',{name:'保存调整',exact:true})).toHaveCount(0);
 await expect(frame.getByRole('button',{name:'重提',exact:true})).toHaveCount(0);
 const header=frame.locator('header').first();await expect(header.getByRole('tab',{name:'月初',exact:true})).toBeVisible();
 await expect(page.getByRole('dialog',{name:'建议生成失败',exact:true})).toHaveCount(0);
 await shot('01-02-09-initial');
 const compactHeader=frame.getByTestId('regional-approval-workbench').locator('header').first();
 const headerLayout=await compactHeader.evaluate(el=>({height:el.getBoundingClientRect().height,wrap:getComputedStyle(el).flexWrap}));
 assert.equal(headerLayout.wrap,'nowrap');assert.ok(headerLayout.height<=56,JSON.stringify(headerLayout));
 const stages=['region','province','area'];
 const readProgress=()=>frame.locator('[data-testid^="regional-approval-stage-"] small').allTextContents();
 const before=await readProgress(); assert.equal(before.length,5);
 for(const stage of stages){await frame.getByTestId('regional-approval-stage-'+stage).click();assert.deepEqual(await readProgress(),before);await shot('04-05-'+stage);}
 await frame.getByTestId('regional-approval-stage-region').click();
 await frame.getByRole('tab',{name:'按区域',exact:true}).click();
 const monthPlan=frame.getByTestId('regional-approval-month-plan-p');
 await expect(monthPlan.locator('span').first()).toHaveText('¥100');
 await expect(monthPlan.locator('small').first()).toHaveText('10');
 await expect(frame.locator('tbody').first()).toContainText('50.0%');
 await expect(frame.locator('tbody').first()).toContainText('版本②：¥100 / 10');
 await expect(frame.locator('tbody').first()).toContainText('该版本不含月度目标');
 await shot('03-version-comparison');
 await frame.getByRole('button',{name:/查看.*宝阳销售组|宝阳销售组.*调整/}).click();
 await expect(frame.locator('tbody').first()).toContainText('黑芝麻汤圆 500g');
 await expect(frame.locator('tbody th[scope="rowgroup"]')).toContainText(['汤圆 · 1 SKU','饺子 · 1 SKU']);
 const inline = frame.locator('div[role="region"][tabindex="0"]');
 assert.ok(await inline.evaluate(el=>getComputedStyle(el).maxHeight==='360px'));
 const nav=page.locator('.gea-shell-navigation');
 for (const width of ['64px','240px','64px','240px']) {
  await nav.evaluate((el,w)=>{el.style.width=w;},width);
  await expect(nav.locator('.gea-shell-label').first())[width==='64px'?'toBeHidden':'toBeVisible']();
 }
 await nav.evaluate(el=>el.style.removeProperty('width'));
 await page.screenshot({path:'.runtime/v16-feedback/inline-grouped.png',fullPage:true});
 await shot('08-inline');
 await frame.getByRole('button',{name:'查看调整明细',exact:true}).click();
 const drawer=frame.locator('.arco-drawer');await expect(drawer).toBeVisible();
 await expect(drawer).toContainText('黑芝麻汤圆 500g');
 await expect(drawer).toContainText('当前计划高于基准，请结合库存核对。',{timeout:15000});
 await expect(drawer).not.toContainText('无调整测试物料');
 await expect(drawer.locator('input')).toHaveCount(0);
 await shot('07-08-drawer');
 await drawer.getByRole('button',{name:'编辑调整草稿',exact:true}).click();
 const editor=drawer.getByRole('region',{name:'调整草稿'});
 await expect(editor.getByRole('status')).toContainText('已自动暂存');
 await editor.getByRole('textbox',{name:'调整数量 1001',exact:true}).fill('2.125');
 await expect(editor.getByRole('status')).toContainText('已自动暂存',{timeout:10000});
 await shot('06-autosaved');
 assert.equal(writes,0);
 const result=await app.rpc('sales-plan/draft',{planId:'p',versionId:'v'});
 assert.equal(result.value.draft.adjustments[0].adjustQty,'2.125');
 const forged=await app.rpc('sales-plan/draft',{planId:'p',versionId:'v',draft:{...result.value.draft,sourceSnapshot:'forged'}});
 assert.equal(forged.ok,false);assert.equal(forged.error.code,'STALE_DRAFT');
 const unchanged=await app.rpc('sales-plan/draft',{planId:'p',versionId:'v'});assert.equal(unchanged.value.draft.adjustments[0].adjustQty,'2.125');
 await mkdir('.runtime/v16-feedback',{recursive:true});await page.screenshot({path:'.runtime/v16-feedback/web-desktop.png',fullPage:true});
 await page.reload();
 await expect(frame.getByTestId('regional-approval-workbench')).toBeVisible();
 await frame.getByRole('button',{name:/查看.*宝阳销售组|宝阳销售组.*调整/}).click();
 await frame.getByRole('button',{name:'查看调整明细',exact:true}).click();
 await drawer.getByRole('button',{name:'编辑调整草稿',exact:true}).click();
 await expect(editor.getByRole('textbox',{name:'调整数量 1001',exact:true})).toHaveValue('2.125');
 await shot('06-restored');
 await page.setViewportSize({width:1024,height:768});await page.screenshot({path:'.runtime/v16-feedback/web-tablet.png',fullPage:true});
 await editor.getByRole('button',{name:'完成编辑',exact:true}).click();
 await expect(drawer.locator('dl dd')).toHaveCount(6);
 assert.ok(await drawer.locator('dl').evaluate(el=>el.scrollWidth<=el.clientWidth));
 await shot('08-tablet-drawer');
 assert.deepEqual(errors,[]);assert.equal(writes,0);
 await page.setViewportSize({width:1536,height:920});
 await drawer.getByRole('button',{name:'关闭',exact:true}).click();
 await shot('10-expanded');
 await page.getByRole('button',{name:/收起侧边栏|Collapse sidebar/}).click();
 await shot('10-sidebar-collapsed');
 await expect(page.locator('.gea-shell-navigation .gea-shell-label').first()).toBeHidden();
 const collapsedMenu=page.getByRole('button',{name:'展开业务菜单',exact:true});
 await expect(collapsedMenu).toBeVisible();
 await expect(page.locator('.gea-shell-navigation [data-nav-icon]')).toHaveCount(1);
 await expect(collapsedMenu.locator('[data-nav-icon="menu"]')).toBeVisible();
 assert.equal(await collapsedMenu.evaluate(el=>{
  const frame=el.closest('[data-sidebar-collapsed]');
  return frame?.firstElementChild ? getComputedStyle(frame.firstElementChild).boxShadow : null;
 }),'none');
 assert.equal(await collapsedMenu.evaluate(el=>{
  const frame=el.closest('[data-sidebar-collapsed]');
  return frame?.firstElementChild ? getComputedStyle(frame.firstElementChild).backgroundColor : null;
 }),'rgba(0, 0, 0, 0)');
 await collapsedMenu.click();
 await expect(page.getByRole('button',{name:/收起侧边栏|Collapse sidebar/})).toBeVisible();
 await expect(page.locator('.gea-shell-navigation [data-nav-icon]')).toHaveCount(0);
 await shot('10-sidebar-restored');
 await expect(page.getByRole('button',{name:'全屏展示',exact:true})).toHaveCount(0);
 await page.route('**/api/gea-proof/model/advice',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'RATE_LIMITED',message:'Rate limited'}})}));
 await frame.getByRole('button',{name:'查看调整明细',exact:true}).click();
 await expect(drawer.getByRole('button',{name:'重试未生成建议',exact:true})).toBeVisible();
 await shot('07-ai-failure');
 await page.unroute('**/api/gea-proof/model/advice');
 await drawer.getByRole('button',{name:'重试未生成建议',exact:true}).click();
 await expect(drawer).toContainText('当前计划高于基准，请结合库存核对。');
 await shot('07-ai-retry');
 await drawer.getByRole('button',{name:'关闭',exact:true}).click();

 await frame.locator('label.arco-checkbox:has(input[value="p"])').click();
 allowApproval=true;
 await frame.getByRole('button',{name:'通过',exact:true}).click();
 await expect.poll(()=>writes).toBe(1);
 await expect(frame.getByRole('dialog')).toHaveCount(0);
 await shot('01-approval-completed');
 plan.status=1;
 let automaticPrepareRequests=0;
 await page.route('**/api/gea-proof/workbench/prepare',route=>{automaticPrepareRequests++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'GEA_UNAVAILABLE',message:'Unavailable'}})});});
 await page.evaluate(()=>sessionStorage.clear()); await page.reload();
 await expect(frame.getByTestId('regional-approval-workbench')).toBeVisible();
 await page.waitForTimeout(1200);
 assert.equal(automaticPrepareRequests,0);
 await expect(page.getByRole('dialog',{name:'建议生成失败',exact:true})).toHaveCount(0);
 await shot('09-no-auto-analysis');
 await page.unroute('**/api/gea-proof/workbench/prepare');
 await page.route('**/api/gea-proof/workbench/query',route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'FORBIDDEN',message:'Forbidden'}})}));
 await frame.getByRole('button',{name:'刷新数据',exact:true}).click();
 await expect(frame.getByText('当前账号没有读取该销售计划范围的权限。',{exact:true})).toBeVisible();
 await shot('05-permission-denied');



});
