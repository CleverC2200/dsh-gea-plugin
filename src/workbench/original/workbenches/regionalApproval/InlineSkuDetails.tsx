import styles from './InlineSkuDetails.module.css';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Alert, Input, Spin} from '@arco-design/web-react';
import type {TFunction} from 'i18next';
import {salesPlan, type GeaSalesPlanDetail, type GeaSalesPlanSku} from '../../bridge.ts';
import {addExactDecimals, formatExactDecimal, multiplyExactDecimals, subtractExactDecimals, type RegionalApprovalLiveRow} from './regionalApprovalQueryModel.ts';
import {salesPlanDraftSnapshot, type SalesPlanLocalDraft} from './models/salesPlanLocalDraftModel.ts';
import {salesPlanEditableQuantity} from './models/salesPlanAccessModel.ts';
import type {ApprovalStageId} from './regionalApprovalFixture.ts';

const DECIMAL = /^[+-]?\d{1,15}(?:\.\d{1,3})?$/;
const quantityText = (value: string) => formatExactDecimal(value).replace(/\.0+$/, '');
/** 输入框不能出现千分位：`type=number` 会把 “1,111” 当非法值并清空整格。 */
const editableQuantityText = (value: string) => quantityText(value).replace(/,/g, '');
const draftLog = (stage: string, detail: unknown) => console.warn(`[gea-draft] ${stage}`, detail);

export function InlineSkuDetails({row,t,detail,canEdit,approvalRole,categoryName,onMetricsChange,onPendingValuesChange,draftPatch,onElementsChange}:{
 row:RegionalApprovalLiveRow;
 t:TFunction;
 detail?:GeaSalesPlanDetail;
 canEdit?:boolean;
 approvalRole?:ApprovalStageId;
 categoryName?:string;
 onMetricsChange?: (metrics?: {quantity: string; amount: string}) => void;
 /**
  * 把「界面上现在的本节点确认量」直接交给上层：通过时不必等 500ms 防抖落盘，
  * 也不会因为草稿里的旧值把用户刚改的数字冲掉。
  */
 onPendingValuesChange?: (values: Record<string,string>) => void;
 /** 外部（对话）下发的草稿改写：把指定 SKU 的确认计划量改成同一个值。 */
 draftPatch?: {at: number; quantity: string; skuCodes?: string[]};
 /** 把这一块“可编辑字段 + 集合”报给工作台，供页面桥声明成本页元素。 */
 onElementsChange?: (
  fields: Array<{id:string;label:string;value:string;editable:boolean}>,
  collection?: {id:string;label:string;members:string[]},
 ) => void;
}) {
 const [skus,setSkus]=useState<GeaSalesPlanSku[]>(); const [failed,setFailed]=useState(false);
 const [confirmedValues,setConfirmedValues]=useState<Record<string,string>>({});
 const [draftState,setDraftState]=useState<'idle'|'loading'|'saved'|'saving'|'failed'>('idle');
 const [saveRetry,setSaveRetry]=useState(0);
 // 已保存在 Host 上的草稿内容；失败时不写入，用来判断哪些行还没暂存成功。
 const [savedDraft,setSavedDraft]=useState('');
 const appliedPatch=useRef<number>();
 // 对话下发的草稿改写：只改“确认计划量”输入，等价于人工在格子里填数；保存仍要人工点。
 useEffect(()=>{
  if (!draftPatch || !canEdit || !skus || skus.length === 0) return;
  if (appliedPatch.current === draftPatch.at) return;
  appliedPatch.current = draftPatch.at;
  const target = draftPatch.skuCodes?.length
   ? skus.filter(sku=>draftPatch.skuCodes!.includes(String(sku.skuCode)))
   : skus;
  if (target.length === 0) return;
  setConfirmedValues(current=>{
   const next={...current};
   for (const sku of target) next[String(sku.skuCode)] = draftPatch.quantity;
   return next;
  });
 },[canEdit,draftPatch,skus]);
 useEffect(()=>{const controller=new AbortController(); setSkus(undefined); setFailed(false);
  const source = detail?.skus && detail.currentVersion.id === row.versionId ? Promise.resolve(detail.skus) : salesPlan.versionSkus.invoke({versionId:row.versionId,signal:controller.signal});
  void source.then(data=>{if(!controller.signal.aborted)setSkus(data);}).catch(()=>{if(!controller.signal.aborted)setFailed(true);});
  return ()=>controller.abort();},[row.versionId]);
 useEffect(()=>{
  if (!canEdit || !detail) { setDraftState('idle'); return; }
  const controller=new AbortController(); setDraftState('loading'); setSavedDraft('');
  void salesPlan.draft!.invoke({planId:row.planId,versionId:row.versionId,approvalRole,signal:controller.signal}).then(result=>{
   if (controller.signal.aborted) return;
   // 草稿自带写入时的节点口径；按它还原用户当时填的数字，而不是按当前筛选节点重算。
   const restoreRole = result.draft?.role ?? approvalRole;
   const baseline = (sku:GeaSalesPlanSku) => salesPlanEditableQuantity(sku,row.status,row.planTypeCode,restoreRole) ?? String(sku.qty);
   const next = Object.fromEntries((result.draft?.adjustments ?? []).map(item=>{
    const sku=detail.skus.find(candidate=>String(candidate.skuCode)===item.skuCode);
    if (!sku) return [item.skuCode,item.adjustQty];
    return [item.skuCode, addExactDecimals([baseline(sku), item.adjustQty])];
   }));
   setSavedDraft(JSON.stringify(next)); // 已落盘基线，用来判断哪几行还没存成功
   // 草稿读取可能晚于用户输入：只补齐用户还没动过的行，别把刚敲进去的数字冲掉。
   setConfirmedValues(current=>({...next,...current}));
   setDraftState('saved');
  }).catch((error:unknown)=>{
   // 读取失败时按“服务端尚无草稿”处理：用户下一次编辑仍会尝试暂存，但不会凭空写入空草稿覆盖旧稿。
   if (controller.signal.aborted) return;
   draftLog('读取草稿失败，按无草稿继续', error);
   setSavedDraft('{}'); setDraftState('failed');
  });
  return ()=>controller.abort();
 },[approvalRole,canEdit,detail,row.planId,row.planTypeCode,row.status,row.versionId]);
 useEffect(() => {
  if (draftState !== 'saved') return;
  const timer = window.setTimeout(() => setDraftState('idle'), 1400);
  return () => window.clearTimeout(timer);
 }, [draftState]);
 const baselineFor = (sku:GeaSalesPlanSku) => salesPlanEditableQuantity(sku,row.status,row.planTypeCode,approvalRole) ?? String(sku.qty);
 const confirmedMetrics = useMemo(() => {
  if (!skus || skus.length === 0) return undefined;
  const quantities = skus.map(sku => confirmedValues[String(sku.skuCode)] ?? baselineFor(sku));
  const amounts = skus.map(sku => multiplyExactDecimals(confirmedValues[String(sku.skuCode)] ?? baselineFor(sku), String(sku.price)));
  return amounts.every((amount): amount is string => amount !== undefined)
    ? {quantity: addExactDecimals(quantities), amount: addExactDecimals(amounts)}
    : undefined;
 }, [confirmedValues, skus, row.status, row.planTypeCode, approvalRole]);
 useEffect(() => { onMetricsChange?.(confirmedMetrics); }, [confirmedMetrics, onMetricsChange]);
 const draftAdjustments = useMemo(() => (skus ?? []).map(sku => {
  const code=String(sku.skuCode), value=confirmedValues[code];
  if (value === undefined || value.trim() === '') return undefined;
  const adjustQty=subtractExactDecimals(value,baselineFor(sku));
  return DECIMAL.test(adjustQty) && !/^[-+]?0(?:\.0{1,3})?$/.test(adjustQty) ? {skuCode:code,adjustQty} : undefined;
 }).filter((item): item is {skuCode:string;adjustQty:string} => Boolean(item)), [confirmedValues,skus,row.status,row.planTypeCode,approvalRole]);
 useEffect(() => { onPendingValuesChange?.(confirmedValues); }, [confirmedValues, onPendingValuesChange]);
 // 元素上报：字段 id / label / 当前值 / 是否可编辑，外加一个“整列一起改”的集合。
 useEffect(() => {
  if (!onElementsChange) return;
  if (!skus || skus.length === 0) {
   onElementsChange([]);
   return;
  }
  const fields = skus.map(sku => {
   const code = String(sku.skuCode);
   const quantity = confirmedValues[code] ?? baselineFor(sku);
   return {
    id: `field:${row.planId}:${code}:qty`,
    label: `${sku.materialDescription ?? sku.productCategName ?? code} 确认计划量`,
    value: quantityText(quantity),
    editable: Boolean(canEdit),
   };
  });
  onElementsChange(fields, {
   id: `collection:${row.planId}:qty`,
   label: `${row.dealerName ?? row.orgName ?? row.planId} 全部 SKU 的确认计划量`,
   members: fields.map(field => field.id),
  });
 }, [canEdit, confirmedValues, onElementsChange, row.dealerName, row.orgName, row.planId, skus]);
 useEffect(()=>{
  if (!canEdit || !detail || !skus || draftState === 'loading') return;
  const serialized=JSON.stringify(confirmedValues);
  if (serialized===savedDraft) return;
  const invalidValues=Object.values(confirmedValues).filter(value=>value.trim() && !DECIMAL.test(value));
  if (invalidValues.length) { draftLog('暂存跳过：调整量格式不合法', invalidValues); setDraftState('failed'); return; }
  const snapshot=salesPlanDraftSnapshot({planId:row.planId,versionId:row.versionId,status:row.status},detail);
  if (!snapshot) {
   draftLog('暂存跳过：本地快照无法生成（行与详情的版本/状态/生效标记不一致）', {rowVersionId:row.versionId,detailVersionId:detail.currentVersion.id,rowStatus:row.status,detailStatus:detail.currentVersion.status,effective:detail.currentVersion.effective});
   setDraftState('failed'); return;
  }
  const controller=new AbortController(); setDraftState('saving');
  const timer=setTimeout(()=>{
   const draft:SalesPlanLocalDraft={planId:row.planId,versionId:row.versionId,status:row.status,sourceSnapshot:snapshot,remark:'',adjustments:draftAdjustments,...(approvalRole?{role:approvalRole}:{})};
   void salesPlan.draft!.invoke({planId:row.planId,versionId:row.versionId,approvalRole,draft,signal:controller.signal}).then(()=>{
    if (!controller.signal.aborted) {setSavedDraft(serialized);setDraftState('saved');}
   }).catch((error:unknown)=>{if (!controller.signal.aborted){draftLog('暂存失败（服务端拒绝）', error);setDraftState('failed');}});
  },500);
  return ()=>{clearTimeout(timer);controller.abort();};
 },[approvalRole,canEdit,confirmedValues,detail,draftAdjustments,row.planId,row.status,row.versionId,saveRetry,savedDraft,skus]);
 const tr=(key:string)=>t(`common.assistantSurface.regionalApproval.liveAdjustment.${key}`);
 // 已暂存草稿里的值；用于判断某一行是不是“改过但还没暂存成功”。
 const savedValues=useMemo(()=>{
  try {
   const parsed:unknown=JSON.parse(savedDraft||'{}');
   return parsed && typeof parsed==='object' && !Array.isArray(parsed) ? parsed as Record<string,string> : {};
  } catch { return {}; }
 },[savedDraft]);
 const groups = new Map<string, GeaSalesPlanSku[]>();
 for (const sku of skus ?? []) {
  const category = sku.productCategName.trim() || '其他';
  if (categoryName !== undefined && category !== categoryName) continue;
  groups.set(category, [...(groups.get(category) ?? []), sku]);
 }
 // 暂存状态就近展示在改过的数字旁；失败给就地重试，不再用表格顶部通栏。
 return <section className={styles.root} aria-label={tr('columns.sku')}>
  {failed ? <Alert type='error' content={tr('loadError')} /> : !skus ? <Spin /> :
   <div className={styles.viewport} tabIndex={0} role="region" aria-label={tr('columns.sku')}>
   <table className={styles.table}>
    <colgroup>
     <col className={styles.skuColumn} />
     {['baseQty','qty','baseAmount','amount'].map(key=><col className={styles.metricColumn} key={key} />)}
    </colgroup>
    <thead><tr>{['sku','baseQty','qty','baseAmount','amount'].map(key=><th scope="col" key={key}>{tr('columns.'+key)}</th>)}</tr></thead>
   {[...groups].map(([category, items])=><tbody key={category}>
    <tr className={styles.group}><th colSpan={5} scope="rowgroup">{category} · {items.length} SKU</th></tr>
    {items.map((sku,index)=>{
     const changed = formatExactDecimal(sku.baseQty) !== formatExactDecimal(sku.qty) || formatExactDecimal(sku.amtBase) !== formatExactDecimal(sku.amt);
     const code=String(sku.skuCode), baseline=baselineFor(sku), confirmed=confirmedValues[code] ?? editableQuantityText(baseline);
     return <tr key={code+':'+index} className={changed ? styles.changed : undefined}>
      <td><span className={styles.sku}>{code}</span><span className={styles.description}>{sku.materialDescription || sku.skuName || tr('missingDescription')}</span></td>
      <td>{quantityText(sku.baseQty)}</td><td>{canEdit ? <div className={styles.quantityCell}>
       <Input className={styles.quantityInput} type='number' step={1} size='small' value={confirmed} aria-label={`${tr('columns.qty')} ${code}`} onChange={value=>setConfirmedValues(current=>({...current,[code]:value}))} />
       {savedValues[code] === confirmedValues[code] ? null : draftState === 'failed' ? <span className={styles.draftFailed} role='alert' title={tr('draft.failed')}>
        <span className={styles.draftFailedText}>{tr('draft.failedShort')}</span>
        <button type='button' className={styles.draftRetry} onClick={()=>setSaveRetry(value=>value+1)}>{tr('draft.retryShort')}</button>
       </span> : draftState === 'saving' ? <span className={styles.draftSaving} role='status'>{tr('draft.saving')}</span> : null}
      </div> : quantityText(sku.qty)}</td><td>{formatExactDecimal(sku.amtBase)}</td><td>{formatExactDecimal(sku.amt)}</td></tr>;
    })}
   </tbody>)}
   </table></div>}
 </section>;
}
