import test from 'node:test';
import assert from 'node:assert/strict';
import {projectCatalog} from '../src/host/gateway-catalog.ts';
import {preflightCubeArguments} from '../src/host/cube-preflight.ts';
import {memberIndexFrom} from '../src/host/member-index.ts';
import {compactDatasetProjection} from '../src/host/prompt-result.ts';
import {salesSourceIssue,salesSourceIssueForTurns} from '../src/host/sales-result-contract.ts';
const model='agents_sales_plan_detail_mi';
const catalog={semanticModel:[{name:model,dimensions:[{name:model+'.plane_date',type:'string'}],measures:[...Array.from({length:11},(_,i)=>({name:model+'.check_'+i,type:'number',description:'quality count'})),{name:model+'.plannum_sum',type:'number',description:'单月单批次；否则NULL不是无记录',meta:{unit:'件'}},{name:model+'.allnum_sum',type:'number',description:'最终合计；否则NULL',meta:{unit:'件'}}]}, {name:'agents_sales_forecast_detail_mi',description:model,dimensions:[],measures:[]}]};
test('exact model retains tail measure semantics without unrelated forecast candidates',()=>{
 const text=projectCatalog(catalog,{model});
 assert.match(text,/plannum_sum 语义：.*单位：件/);
 assert.doesNotMatch(text,/agents_sales_forecast_detail_mi/);
});
test('member lookup selects tail measures and dimensions, not the first eight',()=>{
 const text=projectCatalog(catalog,{model,members:[model+'.allnum_sum',model+'.plane_date']});
 assert.match(text,/allnum_sum 语义：.*单位：件/);
 assert.match(text,/plane_date.*2026-08/);
 assert.doesNotMatch(text,/check_0/);
 assert.match(text,/定向成员视图.*未列出不代表不存在/);
 const dimensionsOnly=projectCatalog(catalog,{model,members:[model+'.plane_date']});
 assert.doesNotMatch(dimensionsOnly,/这个模型没有定义 measure/);
 assert.match(dimensionsOnly,/模型已有13个度量/);
});
test('source-specific text months are checked before dispatch; unrelated strings unchanged',()=>{
 for(const [name,field,bad,good] of [[model,'plane_date','202608','2026-08'],['agents_sales_shipment','plan_month','2026-08','202608'],['agents_sales_target','plan_month','2026-08','202608'],['agents_sales_forecast_detail_mi','plan_month','2026-09','202609']]){
  const member=name+'.'+field,index=memberIndexFrom({semanticModel:[{name,dimensions:[{name:member,type:'string'}],measures:[]}]});
  const args=value=>({action:'query',queries:[{name:'month',query:{dimensions:[member],filters:[{or:[{member,operator:'equals',values:[value]}]}]}}]});
  assert.match(preflightCubeArguments(args(bad),index)||'',/GEA_CUBE_MONTH_FORMAT/);
  assert.equal(preflightCubeArguments(args(good),index),undefined);
 }
 assert.equal(preflightCubeArguments({action:'query',queries:[{name:'other',query:{dimensions:['other.month'],filters:[{member:'other.month',operator:'equals',values:['2026-08']}]}}]}),undefined);
});
test('mixed rejection retains readable success rows and rejection, instead of raw envelope',()=>{
 const raw=JSON.stringify({source:'GEA_CUBE_BATCH',results:[{names:['bad'],status:'rejected',code:'GEA_CUBE_MEMBER_UNKNOWN',message:'bad member'}, {names:['good'],status:'returned',result:{datasets:[{name:'good',rows:[{[model+'.row_count']:10,[model+'.allnum_sum']:null,[model+'.province_region_name']:''}],complete:true}]}}]});
 const text=compactDatasetProjection(raw,'ev-test');assert.ok(text);
 const value=JSON.parse(text);assert.equal(value.sourceOutcome,'partial');assert.equal(value.queryFailures[0].code,'GEA_CUBE_MEMBER_UNKNOWN');assert.equal(value.datasets[0].table.rows[0][model+'.row_count'],10);
 assert.match(JSON.stringify(value.datasets[0].businessFacts),/guarded-null|有记录/);
});
test('source gate distinguishes result, workflow, mixed and result follow-ups',()=>{
 assert.match(salesSourceIssue('8月最终销售计划')||'',/GEA_SALES_RESULT_SOURCE/);
 assert.match(salesSourceIssue('只能使用Hive，不要使用在线计划接口。')||'',/GEA_SALES_RESULT_SOURCE/);
 assert.equal(salesSourceIssue('请查在线销售计划汇总及审批状态'),undefined);
 assert.equal(salesSourceIssue('计划结果只从Hive取，同时查在线审批日志'),undefined);
 assert.equal(salesSourceIssue('帮我解释生产计划'),undefined);
 assert.ok(salesSourceIssueForTurns(['8月计划结果','按客户再列前5条']));
 assert.equal(salesSourceIssueForTurns(['8月计划结果','再查当前审批状态']),undefined);
 assert.equal(salesSourceIssueForTurns(['8月计划结果','查当前在线审批日志','继续刚才的明细']),undefined);
});
