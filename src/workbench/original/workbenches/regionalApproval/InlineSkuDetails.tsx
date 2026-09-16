import styles from './InlineSkuDetails.module.css';
import React, {useEffect, useState} from 'react';
import {Button, Spin, Alert} from '@arco-design/web-react';
import type {TFunction} from 'i18next';
import {salesPlan, type GeaSalesPlanSku} from '../../bridge.ts';
import {formatExactDecimal, type RegionalApprovalLiveRow} from './regionalApprovalQueryModel.ts';
export function InlineSkuDetails({row,t,onOpen}:{row:RegionalApprovalLiveRow;t:TFunction;onOpen:()=>void}) {
 const [skus,setSkus]=useState<GeaSalesPlanSku[]>(); const [failed,setFailed]=useState(false);
 useEffect(()=>{const controller=new AbortController(); setSkus(undefined); setFailed(false);
  void salesPlan.versionSkus.invoke({versionId:row.versionId,signal:controller.signal}).then(data=>{if(!controller.signal.aborted)setSkus(data);}).catch(()=>{if(!controller.signal.aborted)setFailed(true);});
  return ()=>controller.abort();},[row.versionId]);
 const tr=(key:string)=>t(`common.assistantSurface.regionalApproval.liveAdjustment.${key}`);
 const groups = new Map<string, GeaSalesPlanSku[]>();
 for (const sku of skus ?? []) {
  const category = sku.productCategName || '—';
  groups.set(category, [...(groups.get(category) ?? []), sku]);
 }
 return <section className={styles.root} aria-label={tr('columns.sku')}>
  <div className={styles.toolbar}><Button size='small' onClick={onOpen}>{t('common.assistantSurface.regionalApproval.inlineAdjustments')}</Button></div>
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
     return <tr key={String(sku.skuCode)+':'+index} className={changed ? styles.changed : undefined}>
      <td><span className={styles.sku}>{String(sku.skuCode)}</span><span className={styles.description}>{sku.materialDescription || tr('missingDescription')}</span></td>
      <td>{formatExactDecimal(sku.baseQty)}</td><td>{formatExactDecimal(sku.qty)}</td><td>{formatExactDecimal(sku.amtBase)}</td><td>{formatExactDecimal(sku.amt)}</td></tr>;
    })}
   </tbody>)}
   </table></div>}
 </section>;
}
