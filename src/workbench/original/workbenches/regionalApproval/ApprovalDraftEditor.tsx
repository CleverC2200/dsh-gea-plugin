import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Spin } from '@arco-design/web-react';
import type { TFunction } from 'i18next';
import { salesPlan, type GeaSalesPlanDetail } from '../../bridge.ts';
import { salesPlanDraftSnapshot, type SalesPlanLocalDraft } from './models/salesPlanLocalDraftModel.ts';
import { salesPlanEditableQuantity } from './models/salesPlanAccessModel.ts';

export function ApprovalDraftEditor({ detail, t, onClose }: {detail: GeaSalesPlanDetail; t: TFunction; onClose: () => void}) {
  const version = detail.currentVersion;
  const row = {planId: version.planId, versionId: version.id, status: version.status};
  const [values, setValues] = useState<Record<string,string>>({});
  const [ready, setReady] = useState(false);
  const [state, setState] = useState('loading');
  const [revision, setRevision] = useState(0);
  const saved = useRef('');
  const tr = (key: string) => t(`common.assistantSurface.regionalApproval.draft.${key}`);
  useEffect(() => {
    const controller = new AbortController();
    void salesPlan.draft!.invoke({planId:row.planId,versionId:row.versionId, signal: controller.signal}).then(result => {
      if (controller.signal.aborted) return;
      const next = Object.fromEntries((result.draft?.adjustments ?? []).map(item => [item.skuCode,item.adjustQty]));
      saved.current = JSON.stringify(next); setValues(next); setReady(true); setState(result.stale ? 'stale' : 'saved');
    }).catch(() => {if (!controller.signal.aborted) setState('loadFailed');});
    return () => controller.abort();
  }, [version.id]);
  const serialized = JSON.stringify(values);
  const valid = Object.values(values).every(value => value === '' || /^[+-]?\d{1,15}(?:\.\d{1,3})?$/.test(value));
  useEffect(() => {
    if (!ready || saved.current === serialized) return;
    if (!valid) {setState('invalid'); return;}
    const controller = new AbortController();
    setState('pending');
    const timer = setTimeout(() => {
      setState('saving');
      const draft: SalesPlanLocalDraft = {...row, sourceSnapshot: salesPlanDraftSnapshot(row,detail)!, remark:'',
        adjustments: Object.entries(values).filter(([,value]) => value !== '').map(([skuCode,adjustQty]) => ({skuCode,adjustQty}))};
      void salesPlan.draft!.invoke({planId:row.planId,versionId:row.versionId,draft,signal:controller.signal}).then(() => {
        if (!controller.signal.aborted) {saved.current=serialized; setState('saved');}
      }).catch(() => {if (!controller.signal.aborted) setState('failed');});
    },1500);
    return () => {clearTimeout(timer); controller.abort();};
  },[serialized,ready,valid,revision]);
  return <section aria-label={tr('title')}>
    <h3>{tr('title')}</h3>
    <Alert type={['failed','loadFailed','invalid','stale'].includes(state) ? 'warning' : 'info'} content={<span role='status'>{tr(state)}</span>} />
    <p>{tr('scope')}</p>
    {!ready ? <Spin /> : <table><thead><tr><th>{tr('sku')}</th><th>{tr('current')}</th><th>{tr('delta')}</th></tr></thead><tbody>
      {detail.skus.map(sku => <tr key={String(sku.skuCode)}><td>{String(sku.skuCode)} {sku.materialDescription}</td><td>{salesPlanEditableQuantity(sku,version.status,version.planTypeCode)}</td><td>
        <Input aria-label={`${tr('delta')} ${sku.skuCode}`} value={values[String(sku.skuCode)] ?? ''}
          onChange={value => setValues(current=>({...current,[String(sku.skuCode)]:value}))} />
      </td></tr>)}
    </tbody></table>}
    {state === 'stale' && <Button onClick={()=>{saved.current='';setRevision(n=>n+1);}}>{tr('discardStale')}</Button>}
    {state === 'failed' && <Button onClick={()=>setRevision(n=>n+1)}>{tr('retry')}</Button>}
    <Button disabled={!['saved','stale'].includes(state)} onClick={onClose}>{tr('close')}</Button>
  </section>;
}
