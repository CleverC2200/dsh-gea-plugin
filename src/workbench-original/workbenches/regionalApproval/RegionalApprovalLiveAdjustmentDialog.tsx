/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import { Alert, Button, Empty, InputNumber, Modal, Spin, Table, Tabs, Tag } from '@arco-design/web-react';
import type { TableColumnProps } from '@arco-design/web-react';
import type { TFunction } from 'i18next';
import React, { useEffect, useMemo, useState } from 'react';
import type { SalesPlanDetailClient } from './hooks/useSalesPlanDetail.ts';
import {
  adjustmentDimensionName,
  adjustmentDimensionsFrom,
  adjustmentRecordDraft,
  adjustmentScopeRows,
  createSalesPlanAdjustmentRecords,
  groupSalesPlanAdjustmentRecords,
  updateAggregateAmount,
  updateAggregateQuantity,
  updateCustomerAmount,
  updateCustomerQuantity,
  type SalesPlanAdjustmentDraft,
  type SalesPlanAdjustmentGroup,
  type SalesPlanAdjustmentRecord,
} from './models/salesPlanAdjustmentModel.ts';
import { salesPlanSkusMatchVersion } from './models/salesPlanDetailModel.ts';
import { addExactDecimals, formatExactDecimal, type RegionalApprovalLiveRow } from './regionalApprovalQueryModel.ts';
import type { ApprovalDimension } from './regionalApprovalFixture.ts';
import styles from './RegionalApprovalLiveAdjustmentDialog.module.css';
import { useSalesPlanAdvice } from './hooks/useSalesPlanAdvice.ts';

type LoadState =
  | { status: 'loading' }
  | { status: 'success'; records: SalesPlanAdjustmentRecord[] }
  | { status: 'error' };

const isZero = (value: string) => /^-?0(?:\.0+)?$/.test(value);
const signed = (value: string, currency = false) => {
  const prefix = value.startsWith('-') || isZero(value) ? '' : '+';
  return `${prefix}${currency ? '¥' : ''}${formatExactDecimal(value)}`;
};

const RegionalApprovalLiveAdjustmentDialog: React.FC<{
  visible: boolean;
  readOnly?: boolean;
  rows: readonly RegionalApprovalLiveRow[];
  row: RegionalApprovalLiveRow;
  initialDimension: ApprovalDimension;
  drafts: Readonly<Record<string, SalesPlanAdjustmentDraft>>;
  t: TFunction;
  client?: SalesPlanDetailClient;
  onDraftsChange: (recordIds: string[], drafts: SalesPlanAdjustmentDraft[]) => void;
  onEdit?: () => void;
  editor?: React.ReactNode;
  onClose: () => void;
}> = ({
  visible,
  readOnly = true,
  rows,
  row,
  initialDimension,
  drafts,
  t,
  client,
  onDraftsChange,
  onEdit,
  editor,
  onClose,
}) => {
  const dimensions = useMemo(() => adjustmentDimensionsFrom(initialDimension), [initialDimension]);
  const [initialDrafts] = useState(drafts);
  const [dimension, setDimension] = useState<ApprovalDimension>(dimensions[0]);
  const [advicePage, setAdvicePage] = useState(1);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const scopedRows = useMemo(() => adjustmentScopeRows(rows, row, initialDimension), [initialDimension, row, rows]);

  useEffect(() => {
    setDimension(dimensions[0]);
    setAdvicePage(1);
  }, [dimensions]);

  useEffect(() => {
    if (!visible || !client) {
      setState(client ? { status: 'loading' } : { status: 'error' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    void Promise.all(
      scopedRows.map(async (plan) => {
        const skus = await client.versionSkus.invoke({ versionId: plan.versionId, signal: controller.signal });
        if (!salesPlanSkusMatchVersion(plan.versionId, skus)) throw new Error('version mismatch');
        return { plan, skus };
      })
    )
      .then((entries) => {
        if (controller.signal.aborted) return;
        const records = createSalesPlanAdjustmentRecords(entries).map((record) => {
          const draft = initialDrafts[record.recordId];
          if (draft && !readOnly) {
            record.qty = draft.qty;
            record.amount = draft.amount;
          }
          return record;
        });
        setState({ status: 'success', records });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [client, initialDrafts, scopedRows, visible, readOnly]);

  const records = state.status === 'success' ? state.records : [];
  const groups = useMemo(() => groupSalesPlanAdjustmentRecords(records, dimension), [dimension, records]);
  const pageGroups = groups.slice((advicePage - 1) * 20, advicePage * 20);
  const adviceScope =
    visible && state.status === 'success' && !editor && pageGroups.length > 0
      ? JSON.stringify({
          organization: adjustmentDimensionName(row, initialDimension),
          dimension,
          status: row.status,
          page: advicePage,
          total: groups.length,
          rows: pageGroups.map((group) => ({
            id: group.id,
            sku: group.skuCode,
            quantity: group.qty,
            amount: group.amount,
            baselineQuantity: group.baseQty,
            baselineAmount: group.baseAmount,
            versions: group.records.map((record) => record.plan.versionId),
          })),
        })
      : undefined;
  const advice = useSalesPlanAdvice(
    adviceScope,
    t('common.assistantSurface.regionalApproval.liveAdjustment.advicePrompt')
  );
  const totalDelta = addExactDecimals(groups.map((group) => group.quantityDelta));

  const commit = (next: SalesPlanAdjustmentRecord[]) => {
    if (readOnly) return;
    setState({ status: 'success', records: next });
    onDraftsChange(
      next.map((record) => record.recordId),
      next
        .filter((record) => record.qty !== String(record.sku.qty) || record.amount !== String(record.sku.amt))
        .map(adjustmentRecordDraft)
    );
  };

  const updateQuantity = (group: SalesPlanAdjustmentGroup, value: number | undefined) => {
    if (value === undefined) return;
    commit(
      dimension === 'customer'
        ? updateCustomerQuantity(records, group, value)
        : updateAggregateQuantity(records, group, value)
    );
  };
  const updateAmount = (group: SalesPlanAdjustmentGroup, value: number | undefined) => {
    if (value === undefined) return;
    commit(
      dimension === 'customer'
        ? updateCustomerAmount(records, group, value)
        : updateAggregateAmount(records, group, value)
    );
  };

  const columns: TableColumnProps<SalesPlanAdjustmentGroup>[] = [
    {
      title: t(`common.assistantSurface.regionalApproval.liveAdjustment.dimensions.${dimension}`),
      dataIndex: 'dimensionName',
      width: 150,
      render: (name) => <strong>{name || '—'}</strong>,
    },
    {
      title: t('common.assistantSurface.regionalApproval.liveAdjustment.columns.sku'),
      width: 180,
      render: (_, group) => (
        <span className={styles.skuCell}>
          <strong>{group.skuCode}</strong>
          <small>
            {group.materialDescription ||
              t('common.assistantSurface.regionalApproval.liveAdjustment.missingDescription')}
          </small>
          <small>{group.categoryName || '—'}</small>
        </span>
      ),
    },
    {
      title: t('common.assistantSurface.regionalApproval.liveAdjustment.columns.baseQty'),
      width: 110,
      render: (value) => formatExactDecimal(String(value)),
      dataIndex: 'baseQty',
    },
    {
      title: t('common.assistantSurface.regionalApproval.liveAdjustment.columns.qty'),
      width: 130,
      render: (_, group) =>
        readOnly ? (
          formatExactDecimal(group.qty)
        ) : (
          <InputNumber
            disabled={readOnly}
            min={0}
            precision={0}
            value={Number(group.qty)}
            aria-label={t('common.assistantSurface.regionalApproval.liveAdjustment.editQty', { sku: group.skuCode })}
            onChange={(value) => updateQuantity(group, value)}
          />
        ),
    },
    {
      title: t('common.assistantSurface.regionalApproval.liveAdjustment.columns.baseAmount'),
      width: 120,
      render: (value) => formatExactDecimal(String(value)),
      dataIndex: 'baseAmount',
    },
    {
      title: t('common.assistantSurface.regionalApproval.liveAdjustment.columns.amount'),
      width: 140,
      render: (_, group) =>
        readOnly ? (
          formatExactDecimal(group.amount)
        ) : (
          <InputNumber
            disabled={readOnly}
            min={0}
            precision={0}
            value={Number(group.amount)}
            aria-label={t('common.assistantSurface.regionalApproval.liveAdjustment.editAmount', { sku: group.skuCode })}
            onChange={(value) => updateAmount(group, value)}
          />
        ),
    },
    {
      title: t('common.assistantSurface.regionalApproval.liveAdjustment.columns.deltaQty'),
      width: 90,
      render: (_, group) => (
        <span className={group.quantityDelta.startsWith('-') ? styles.negative : styles.positive}>
          {signed(group.quantityDelta)}
        </span>
      ),
    },
    {
      title: t('common.assistantSurface.regionalApproval.liveAdjustment.columns.deltaAmount'),
      width: 130,
      render: (_, group) => (
        <span className={group.amountDelta.startsWith('-') ? styles.negative : styles.positive}>
          {signed(group.amountDelta)}
        </span>
      ),
    },
    {
      title: t('common.assistantSurface.regionalApproval.liveAdjustment.columns.aiAdvice'),
      width: 170,
      fixed: 'right',
      render: (_, group) => (
        <span>
          {advice.state.answers[group.id] ||
            (advice.state.status === 'idle'
              ? '—'
              : advice.state.status === 'ready'
                ? advice.state.answers[group.id] ||
                  t('common.assistantSurface.regionalApproval.liveAdjustment.advice.noAnswer')
                : t(`common.assistantSurface.regionalApproval.liveAdjustment.advice.${advice.state.status}`))}
        </span>
      ),
    },
  ];

  return (
    <Modal
      visible={visible}
      className={styles.modal}
      title={t('common.assistantSurface.regionalApproval.liveAdjustment.title', {
        organization: adjustmentDimensionName(row, initialDimension),
      })}
      footer={
        editor ? null : (
          <div className={styles.footer}>
            <span>
              {t(
                onEdit
                  ? 'common.assistantSurface.regionalApproval.liveAdjustment.editScope'
                  : readOnly
                    ? 'common.assistantSurface.regionalApproval.liveAdjustment.readOnlyReason'
                    : 'common.assistantSurface.regionalApproval.liveAdjustment.footer'
              )}
            </span>
            {onEdit ? (
              <Button type='primary' onClick={onEdit}>
                {t('common.assistantSurface.regionalApproval.liveAdjustment.editCurrent')}
              </Button>
            ) : null}
            <Button onClick={onClose}>{t('common.assistantSurface.regionalApproval.liveAdjustment.close')}</Button>
          </div>
        )
      }
      onCancel={editor ? undefined : onClose}
      closable={!editor}
      maskClosable={!editor}
      unmountOnExit
    >
      {editor || (
        <div className={styles.body}>
          <div className={styles.dimensionBar}>
            <Tabs
              activeTab={dimension}
              onChange={(value) => {
                setDimension(value as ApprovalDimension);
                setAdvicePage(1);
              }}
            >
              {dimensions.map((item) => (
                <Tabs.TabPane
                  key={item}
                  title={t(`common.assistantSurface.regionalApproval.liveAdjustment.dimensions.${item}`)}
                />
              ))}
            </Tabs>
            <span>
              {t('common.assistantSurface.regionalApproval.liveAdjustment.summary', {
                delta: signed(totalDelta),
                dimension: t(`common.assistantSurface.regionalApproval.liveAdjustment.dimensions.${dimension}`),
              })}
            </span>
            <Tag color={readOnly ? 'gray' : 'arcoblue'}>
              {t(
                readOnly
                  ? 'common.assistantSurface.regionalApproval.liveAdjustment.readOnly'
                  : 'common.assistantSurface.regionalApproval.liveAdjustment.localDraft'
              )}
            </Tag>
          </div>
          {state.status === 'success' && !['ready', 'idle', 'loading'].includes(advice.state.status) ? (
            <Alert
              type='warning'
              content={t(`common.assistantSurface.regionalApproval.liveAdjustment.advice.${advice.state.status}`)}
              action={
                <Button size='small' onClick={advice.retry}>
                  {t('common.assistantSurface.regionalApproval.liveAdjustment.adviceRetry')}
                </Button>
              }
            />
          ) : null}
          {state.status === 'loading' ? (
            <div className={styles.loading}>
              <Spin />
            </div>
          ) : state.status === 'error' ? (
            <Empty description={t('common.assistantSurface.regionalApproval.liveAdjustment.loadError')} />
          ) : (
            <Table
              borderCell
              rowKey='id'
              columns={columns}
              data={groups}
              pagination={{ current: advicePage, pageSize: 20, onChange: setAdvicePage, sizeCanChange: false }}
              scroll={{ x: 1220, y: 480 }}
              noDataElement={<Empty description={t('common.assistantSurface.regionalApproval.liveAdjustment.empty')} />}
            />
          )}
        </div>
      )}
    </Modal>
  );
};

export default RegionalApprovalLiveAdjustmentDialog;
