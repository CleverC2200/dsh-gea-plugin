import styles from './InlineSkuDetails.module.css';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Alert, Input, Spin} from '@arco-design/web-react';
import type {TFunction} from 'i18next';
import {salesPlan, type GeaSalesPlanDetail, type GeaSalesPlanSku} from '../../bridge.ts';
import {addExactDecimals, formatExactDecimal, subtractExactDecimals, type RegionalApprovalLiveRow} from './regionalApprovalQueryModel.ts';
import {salesPlanDraftSnapshot, type SalesPlanLocalDraft} from './models/salesPlanLocalDraftModel.ts';
import {salesPlanEditableQuantity} from './models/salesPlanAccessModel.ts';
import type {ApprovalStageId} from './regionalApprovalFixture.ts';

const DECIMAL = /^[+-]?\d{1,15}(?:\.\d{1,3})?$/;

export function InlineSkuDetails({row,t,detail,canEdit,approvalRole,categoryName}:{
 row:RegionalApprovalLiveRow;
 t:TFunction;
 detail?:GeaSalesPlanDetail;
 canEdit?:boolean;
 approvalRole?:ApprovalStageId;
 categoryName?:string;
}) {
 const [skus,setSkus]=useState<GeaSalesPlanSku[]>(); const [failed,setFailed]=useState(false);
 const [confirmedValues,setConfirmedValues]=useState<Record<string,string>>({});
 const [draftState,setDraftState]=useState<'idle'|'loading'|'saved'|'saving'|'failed'>('idle');
 const savedDraft=useRef('');
 useEffect(()=>{const controller=new AbortController(); setSkus(undefined); setFailed(false);
  const source = detail?.skus && detail.currentVersion.id === row.versionId ? Promise.resolve(detail.skus) : salesPlan.versionSkus.invoke({versionId:row.versionId,signal:controller.signal});
  void source.then(data=>{if(!controller.signal.aborted)setSkus(data);}).catch(()=>{if(!controller.signal.aborted)setFailed(true);});
  return ()=>controller.abort();},[row.versionId]);
 useEffect(()=>{
  if (!canEdit || !detail) { setDraftState('idle'); return; }
  const controller=new AbortController(); setDraftState('loading');
  void salesPlan.draft!.invoke({planId:row.planId,versionId:row.versionId,signal:controller.signal}).then(result=>{
   if (controller.signal.aborted) return;
   const baseline = (sku:GeaSalesPlanSku) => salesPlanEditableQuantity(sku,row.status,row.planTypeCode,approvalRole) ?? String(sku.qty);
   const next = Object.fromEntries((result.draft?.adjustments ?? []).map(item=>{
    const sku=detail.skus.find(candidate=>String(candidate.skuCode)===item.skuCode);
    if (!sku) return [item.skuCode,item.adjustQty];
    return [item.skuCode, addExactDecimals([baseline(sku), item.adjustQty])];
   }));
   savedDraft.current=JSON.stringify(next); setConfirmedValues(next); setDraftState('saved');
  }).catch(()=>{if (!controller.signal.aborted) setDraftState('failed');});
  return ()=>controller.abort();
 },[approvalRole,canEdit,detail,row.planId,row.planTypeCode,row.status,row.versionId]);
 const baselineFor = (sku:GeaSalesPlanSku) => salesPlanEditableQuantity(sku,row.status,row.planTypeCode,approvalRole) ?? String(sku.qty);
 const draftAdjustments = useMemo(() => (skus ?? []).map(sku => {
  const code=String(sku.skuCode), value=confirmedValues[code];
  if (value === undefined || value.trim() === '') return undefined;
  const adjustQty=subtractExactDecimals(value,baselineFor(sku));
  return DECIMAL.test(adjustQty) && !/^[-+]?0(?:\.0{1,3})?$/.test(adjustQty) ? {skuCode:code,adjustQty} : undefined;
 }).filter((item): item is {skuCode:string;adjustQty:string} => Boolean(item)), [confirmedValues,skus,row.status,row.planTypeCode,approvalRole]);
 useEffect(()=>{
  if (!canEdit || !detail || !skus || draftState === 'loading') return;
  const serialized=JSON.stringify(confirmedValues);
  if (serialized===savedDraft.current) return;
  if (Object.values(confirmedValues).some(value=>value.trim() && !DECIMAL.test(value))) { setDraftState('failed'); return; }
  const snapshot=salesPlanDraftSnapshot({planId:row.planId,versionId:row.versionId,status:row.status},detail);
  if (!snapshot) { setDraftState('failed'); return; }
  const controller=new AbortController(); setDraftState('saving');
  const timer=setTimeout(()=>{
   const draft:SalesPlanLocalDraft={planId:row.planId,versionId:row.versionId,status:row.status,sourceSnapshot:snapshot,remark:'',adjustments:draftAdjustments};
   void salesPlan.draft!.invoke({planId:row.planId,versionId:row.versionId,draft,signal:controller.signal}).then(()=>{
    if (!controller.signal.aborted) {savedDraft.current=serialized;setDraftState('saved');}
   }).catch(()=>{if (!controller.signal.aborted)setDraftState('failed');});
  },500);
  return ()=>{clearTimeout(timer);controller.abort();};
 },[canEdit,confirmedValues,detail,draftAdjustments,draftState,row.planId,row.status,row.versionId,skus]);
 const tr=(key:string)=>t(`common.assistantSurface.regionalApproval.liveAdjustment.${key}`);
 const groups = new Map<string, GeaSalesPlanSku[]>();
 for (const sku of skus ?? []) {
  const category = sku.productCategName.trim() || '其他';
  if (categoryName !== undefined && category !== categoryName) continue;
  groups.set(category, [...(groups.get(category) ?? []), sku]);
 }
 return <section className={styles.root} aria-label={tr('columns.sku')}>
  {canEdit && draftState !== 'idle' ? <div className={styles.toolbar}><span role='status'>{t(`common.assistantSurface.regionalApproval.liveAdjustment.draft.${draftState}`)}</span></div> : null}
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
     const code=String(sku.skuCode), baseline=baselineFor(sku), confirmed=confirmedValues[code] ?? baseline;
     return <tr key={code+':'+index} className={changed ? styles.changed : undefined}>
      <td><span className={styles.sku}>{code}</span><span className={styles.description}>{sku.materialDescription || tr('missingDescription')}</span></td>
      <td>{formatExactDecimal(sku.baseQty)}</td><td>{canEdit ? <Input size='small' value={confirmed} aria-label={`${tr('columns.qty')} ${code}`} onChange={value=>setConfirmedValues(current=>({...current,[code]:value}))} /> : formatExactDecimal(sku.qty)}</td><td>{formatExactDecimal(sku.amtBase)}</td><td>{formatExactDecimal(sku.amt)}</td></tr>;
    })}
   </tbody>)}
   </table></div>}
 </section>;
}
