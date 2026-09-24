import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Spin } from '@arco-design/web-react';
import type { TFunction } from 'i18next';
import { salesPlan, type GeaSalesPlanSku } from '../../bridge.ts';
import type { ApprovalStageId } from './regionalApprovalFixture.ts';
import type { RegionalApprovalLiveRow } from './regionalApprovalQueryModel.ts';
import { formatExactDecimal } from './regionalApprovalQueryModel.ts';
import { summarizeGroupSkus, type GroupSkuSummaryRow } from './models/salesPlanGroupSkuModel.ts';
import styles from './InlineSkuDetails.module.css';

type SkuReader = {
  versionSkus: { invoke: (query: { versionId: string; signal?: AbortSignal }) => Promise<GeaSalesPlanSku[]> };
};
type SummaryResult = { status: 'ready'; rows: GroupSkuSummaryRow[] } | { status: 'error' };

export function GroupSkuSummary({ members, approvalRole, pendingValues, client = salesPlan, t }: {
  members: readonly RegionalApprovalLiveRow[];
  approvalRole?: ApprovalStageId;
  pendingValues?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  client?: SkuReader;
  t: TFunction;
}) {
  const [skusByPlan, setSkusByPlan] = useState<GeaSalesPlanSku[][]>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const currentMembers = useRef(members);
  currentMembers.current = members;
  const versions = members.map((plan) => `${plan.versionId}:${plan.skuCount}`).join('|');

  useEffect(() => {
    const plans = currentMembers.current;
    const controller = new AbortController();
    const values: GeaSalesPlanSku[][] = Array.from({ length: plans.length });
    let cursor = 0;
    setSkusByPlan(undefined);
    setFailed(false);
    const worker = async () => {
      while (cursor < plans.length && !controller.signal.aborted) {
        const index = cursor++;
        // oxlint-disable-next-line no-await-in-loop -- 同一分组的完整 SKU 最多四路并发读取。
        values[index] = await client.versionSkus.invoke({ versionId: plans[index].versionId, signal: controller.signal });
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, plans.length) }, worker))
      .then(() => { if (!controller.signal.aborted) setSkusByPlan(values); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [client, versions, retry]);

  const summary = useMemo<SummaryResult | undefined>(() => {
    if (!skusByPlan || skusByPlan.length !== members.length) return undefined;
    try {
      return { status: 'ready', rows: summarizeGroupSkus(
        members.map((plan, index) => ({ plan, skus: skusByPlan[index] })), approvalRole, pendingValues,
      ) };
    } catch {
      return { status: 'error' };
    }
  }, [approvalRole, members, pendingValues, skusByPlan]);
  const tr = (key: string, values?: Record<string, unknown>) =>
    t(`common.assistantSurface.regionalApproval.groupSku.${key}`, values);
  const column = (key: string) => t(`common.assistantSurface.regionalApproval.liveAdjustment.columns.${key}`);
  const categories = new Map<string, GroupSkuSummaryRow[]>();
  if (summary?.status === 'ready') {
    for (const row of summary.rows) {
      categories.set(row.categoryName, [...(categories.get(row.categoryName) ?? []), row]);
    }
  }

  return <section className={styles.root} data-testid='regional-approval-group-sku-summary' aria-label={tr('title')}>
    <div className={styles.groupScope}>{tr('scope', { plans: members.length, skus: summary?.status === 'ready' ? summary.rows.length : '—' })}</div>
    {failed || summary?.status === 'error' ? <div>
      <Alert type='error' content={tr('loadError')} />
      <Button size='small' onClick={() => setRetry((value) => value + 1)}>{tr('retry')}</Button>
    </div> : !summary ? <Spin /> : summary.rows.length === 0 ? <p>{tr('empty')}</p> :
      <div className={styles.viewport} tabIndex={0} role='region' aria-label={tr('title')}>
        <table className={styles.table}>
          <colgroup>
            <col className={styles.skuColumn} />
            {['baseQty', 'qty', 'baseAmount', 'amount'].map((key) => <col className={styles.metricColumn} key={key} />)}
          </colgroup>
          <thead><tr>{['sku', 'baseQty', 'qty', 'baseAmount', 'amount'].map((key) =>
            <th scope='col' key={key}>{column(key)}</th>)}</tr></thead>
          {[...categories].map(([category, rows]) => <tbody key={category}>
            <tr className={styles.group}><th colSpan={5} scope='rowgroup'>{category} · {rows.length} SKU</th></tr>
            {rows.map((row) => <tr key={row.skuCode}>
              <td><span className={styles.sku}>{row.skuCode}</span>{row.description && <span className={styles.description}>{row.description}</span>}</td>
              <td>{formatExactDecimal(row.baseQty)}</td>
              <td>{formatExactDecimal(row.qty)}</td>
              <td>{formatExactDecimal(row.baseAmount)}</td>
              <td>{formatExactDecimal(row.amount)}</td>
            </tr>)}
          </tbody>)}
        </table>
      </div>}
  </section>;
}
