/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import {
  type GeaSalesPlanActionReceipt,
  type GeaSalesPlanActionRequest,
  type GeaSalesPlanDetail,
  type GeaSalesPlanSku,
} from '../../bridge.ts';
import { Alert, Button, Checkbox, Input, Modal, Radio, Spin } from '@arco-design/web-react';
import type { TFunction } from 'i18next';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSalesPlanAction } from './hooks/useSalesPlanAction.ts';
import {
  salesPlanActionTargetStatus,
  salesPlanApprovalNodeForStatus,
  type SalesPlanActionClient,
  type SalesPlanActionErrorKind,
} from './models/salesPlanActionModel.ts';
import { salesPlanSkusMatchVersion, salesPlanSkuNodeComparison } from './models/salesPlanDetailModel.ts';
import {
  addExactDecimals,
  multiplyExactDecimals,
  subtractExactDecimals,
  formatExactDecimal,
  type RegionalApprovalLiveRow,
} from './regionalApprovalQueryModel.ts';
import type { ApprovalStageId } from './regionalApprovalFixture.ts';
import { salesPlanAccessForRow, salesPlanEditableQuantity } from './models/salesPlanAccessModel.ts';
import styles from './RegionalApprovalActionDialog.module.css';

export type LiveActionKind = 'APPROVE' | 'REJECT' | 'SAVE';

const SIGNED_DECIMAL_PATTERN = /^[+-]?\d+(?:\.\d{1,3})?$/;
const ZERO_DECIMAL_PATTERN = /^[+-]?0+(?:\.0{1,3})?$/;

type AdjustmentSkuState =
  | { status: 'idle' | 'loading' }
  | { status: 'success'; data: GeaSalesPlanSku[] }
  | { status: 'error' };

const decimalText = (value: unknown): string | undefined => {
  if (typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

const signedDecimal = (value: string, currency = false) => {
  const negative = value.startsWith('-');
  const absolute = negative ? value.slice(1) : value;
  const prefix = negative ? '-' : /^0(?:\.0+)?$/.test(absolute) ? '' : '+';
  return `${prefix}${currency ? '¥' : ''}${formatExactDecimal(absolute)}`;
};

const errorKey = (kind: SalesPlanActionErrorKind) =>
  `common.assistantSurface.regionalApproval.liveAction.errors.${kind}` as const;

const InlineAction: React.FC<React.ComponentProps<typeof Modal>> = ({ children, footer }) => (
  <div>
    {children}
    {typeof footer === 'function' ? footer(null, null) : footer}
  </div>
);

const RegionalApprovalLiveActionDialog: React.FC<{
  visible: boolean;
  embedded?: boolean;
  row: RegionalApprovalLiveRow;
  approvalStage: ApprovalStageId;
  initialAction?: LiveActionKind;
  t: TFunction;
  client?: SalesPlanActionClient;
  evidence?: GeaSalesPlanDetail;
  permissionCodes?: readonly string[];
  onPermissionDenied: (versionId: string) => void;
  onSucceeded: (receipt: GeaSalesPlanActionReceipt, request: GeaSalesPlanActionRequest) => void | Promise<void>;
  onRefresh: () => void;
  onClose: () => void;
}> = ({
  visible,
  embedded = false,
  row,
  approvalStage,
  initialAction = 'APPROVE',
  t,
  client,
  evidence,
  permissionCodes,
  onPermissionDenied,
  onSucceeded,
  onRefresh,
  onClose,
}) => {
  const [snapshot] = useState(evidence);
  const Container = embedded ? InlineAction : Modal;
  const access = snapshot && salesPlanAccessForRow(row, snapshot, permissionCodes, approvalStage);
  const submittedRequest = useRef<GeaSalesPlanActionRequest | undefined>(undefined);
  const [kind, setKind] = useState<LiveActionKind>(initialAction);
  const [remark, setRemark] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [discardConfirmVisible, setDiscardConfirmVisible] = useState(false);
  const [adjustmentValues, setAdjustmentValues] = useState<Record<string, string>>({});
  const [confirmedInputs, setConfirmedInputs] = useState<Record<string, string>>({});
  const [adjustmentSkus, setAdjustmentSkus] = useState<AdjustmentSkuState>({ status: 'idle' });
  const action = useSalesPlanAction({ client });
  const loading = action.state.status === 'loading';
  const canClose = !loading;
  const intentLocked =
    loading ||
    action.state.status === 'success' ||
    (action.state.status === 'error' && action.state.error.retrySameIntent);
  const targetStatus = salesPlanActionTargetStatus(kind, row.status, row.planTypeCode);
  const approvalNodeOrder = row.status === 10 ? 5 : salesPlanApprovalNodeForStatus(row.status, row.planTypeCode);
  const supportsAdjustments = approvalNodeOrder !== undefined && approvalNodeOrder >= 2;
  const adjustments = useMemo(
    () =>
      Object.entries(adjustmentValues)
        .map(([skuCode, adjustQty]) => ({ skuCode, adjustQty: adjustQty.trim() }))
        .filter(({ adjustQty }) => adjustQty && !ZERO_DECIMAL_PATTERN.test(adjustQty)),
    [adjustmentValues]
  );
  const adjustmentsInvalid = Object.values(adjustmentValues).some((value) => {
    const normalized = value.trim();
    return normalized.length > 0 && !SIGNED_DECIMAL_PATTERN.test(normalized);
  });
  const nodeComparisons = useMemo(() => {
    if (adjustmentSkus.status !== 'success') return [];
    return adjustmentSkus.data.map((sku) => {
      const skuCode = String(sku.skuCode);
      const input = adjustmentValues[skuCode]?.trim() ?? '';
      const adjustmentQty = input || '0';
      const adjustmentValid = SIGNED_DECIMAL_PATTERN.test(adjustmentQty);
      const previousQty = salesPlanEditableQuantity(sku, row.status, row.planTypeCode);
      const price = decimalText(sku.price);
      const previousAmount = previousQty && price ? multiplyExactDecimals(previousQty, price) : undefined;
      const confirmedQty = previousQty && adjustmentValid ? addExactDecimals([previousQty, adjustmentQty]) : undefined;
      const normalizedConfirmedQty = confirmedQty === '—' ? undefined : confirmedQty;
      if (kind !== 'SAVE') {
        const saved = salesPlanSkuNodeComparison(sku, approvalStage);
        return {
          sku,
          skuCode,
          adjustmentQty: saved.qtyDelta,
          adjustmentValid: SIGNED_DECIMAL_PATTERN.test(saved.qtyDelta),
          previousQty: saved.previousQty,
          previousAmount: saved.previousAmount,
          confirmedQty: saved.currentQty,
          confirmedAmount: saved.currentAmount,
          amountDelta: saved.amountDelta,
        };
      }
      return {
        sku,
        skuCode,
        adjustmentQty,
        adjustmentValid,
        previousQty,
        previousAmount,
        confirmedQty: normalizedConfirmedQty,
        confirmedAmount:
          normalizedConfirmedQty && price ? multiplyExactDecimals(normalizedConfirmedQty, price) : undefined,
        amountDelta: adjustmentValid && price ? multiplyExactDecimals(adjustmentQty, price) : undefined,
      };
    });
  }, [adjustmentSkus, adjustmentValues, row.status, kind, approvalStage]);
  const nodeTotals = useMemo(() => {
    if (nodeComparisons.length === 0) return undefined;
    const total = (values: Array<string | undefined>) => {
      if (values.some((value) => value === undefined)) return undefined;
      const result = addExactDecimals(values as string[]);
      return result === '—' ? undefined : result;
    };
    return {
      previousQty: total(nodeComparisons.map((item) => item.previousQty)),
      previousAmount: total(nodeComparisons.map((item) => item.previousAmount)),
      adjustmentQty: total(nodeComparisons.map((item) => (item.adjustmentValid ? item.adjustmentQty : undefined))),
      amountDelta: total(nodeComparisons.map((item) => item.amountDelta)),
      confirmedQty: total(nodeComparisons.map((item) => item.confirmedQty)),
      confirmedAmount: total(nodeComparisons.map((item) => item.confirmedAmount)),
    };
  }, [nodeComparisons]);
  const visibleComparisons =
    kind === 'SAVE'
      ? nodeComparisons
      : nodeComparisons.filter(
          (item) =>
            (item.adjustmentValid && !ZERO_DECIMAL_PATTERN.test(item.adjustmentQty)) ||
            Boolean(item.amountDelta && !ZERO_DECIMAL_PATTERN.test(item.amountDelta))
        );
  const invalid =
    !confirmed ||
    !access?.allowedActions.includes(kind) ||
    (kind === 'SAVE' && (adjustments.length === 0 || adjustmentSkus.status !== 'success')) ||
    targetStatus === undefined ||
    (kind === 'REJECT' && !remark.trim()) ||
    Array.from(remark.trim()).length > 1000 ||
    (kind !== 'REJECT' &&
      (adjustmentsInvalid || nodeComparisons.some((item) => !item.confirmedQty || item.confirmedQty.startsWith('-'))));
  const unknown = t('common.assistantSurface.regionalApproval.liveAction.checksum.unknown');
  const hasAdjustmentDraft = Object.values(adjustmentValues).some((value) => value.trim().length > 0);
  const displayDecimal = (value: unknown, currency = false) =>
    typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())
      ? `${currency ? '¥' : ''}${formatExactDecimal(value)}`
      : unknown;
  const displayNodeTotal = (quantity: string | undefined, amount: string | undefined) =>
    quantity && amount ? `${formatExactDecimal(quantity)} · ¥${formatExactDecimal(amount)}` : unknown;
  const organizationPath = [
    row.areaName ?? row.regionName,
    row.provinceName ?? row.provinceRegionName,
    row.orgName ?? row.salesGroupName,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const organization = `${row.baseName?.trim() || row.dealerCode?.trim() || unknown} · ${
    organizationPath.length > 0 ? organizationPath.join(' / ') : unknown
  }`;
  const checksum = [
    {
      label: t('common.assistantSurface.regionalApproval.liveAction.checksum.organization'),
      value: organization,
    },
    {
      label: t('common.assistantSurface.regionalApproval.liveAction.checksum.stage'),
      value: t(`common.assistantSurface.regionalApproval.stages.${approvalStage}`),
    },
    {
      label: t('common.assistantSurface.regionalApproval.liveAction.checksum.difference'),
      value: t('common.assistantSurface.regionalApproval.liveAction.checksum.differenceValue', {
        currentQty: displayDecimal(row.currentQty),
        targetAmount: displayDecimal(row.targetAmount, true),
        currentAmount: displayDecimal(row.currentAmount, true),
      }),
    },
    {
      label: t('common.assistantSurface.regionalApproval.liveAction.checksum.scope'),
      value: t('common.assistantSurface.regionalApproval.liveAction.checksum.scopeValue', {
        planCount: 1,
        skuCount: Number.isSafeInteger(row.skuCount) && row.skuCount >= 0 ? row.skuCount : unknown,
      }),
    },
  ];

  useEffect(() => {
    if (!visible || !supportsAdjustments) {
      setAdjustmentSkus({ status: 'idle' });
      return;
    }
    setAdjustmentSkus(
      snapshot && salesPlanSkusMatchVersion(row.versionId, snapshot.skus)
        ? { status: 'success', data: snapshot.skus }
        : { status: 'error' }
    );
  }, [snapshot, row.versionId, supportsAdjustments, visible]);

  const complete = async (promise: Promise<GeaSalesPlanActionReceipt>) => {
    try {
      const receipt = await promise;
      try {
        if (!submittedRequest.current) throw new Error('Missing submitted request');
        await onSucceeded(receipt, submittedRequest.current);
        setRefreshFailed(false);
      } catch {
        setRefreshFailed(true);
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'kind' in error && error.kind === 'permission') {
        onPermissionDenied(row.versionId);
      }
    }
  };

  const submit = () => {
    setAttempted(true);
    if (invalid || loading || action.state.status === 'success') return;
    const request: GeaSalesPlanActionRequest = {
      action: kind,
      expectedStatus: row.status,
      ...(access?.snapshotHash ? { expectedSnapshot: access.snapshotHash } : {}),
      ...(remark.trim() ? { remark: remark.trim() } : {}),
      ...(kind !== 'REJECT' && adjustments.length > 0 ? { adjustments } : {}),
    };
    submittedRequest.current = request;
    void complete(
      action.execute({
        planId: row.planId,
        planTypeCode: row.planTypeCode,
        versionId: row.versionId,
        request,
        serverWorkflowResult: !access?.snapshotHash,
      })
    );
  };

  const retry = () => {
    if (loading || action.state.status !== 'error' || !action.state.error.retrySameIntent) return;
    void complete(action.retry());
  };

  const requestClose = () => {
    if (!canClose) return;
    if (hasAdjustmentDraft && action.state.status !== 'success') {
      setDiscardConfirmVisible(true);
      return;
    }
    onClose();
  };

  return (
    <>
      <Container
        visible={visible}
        className={styles.liveModal}
        title={t(
          kind === 'SAVE'
            ? 'common.assistantSurface.regionalApproval.liveAction.saveTitle'
            : 'common.assistantSurface.regionalApproval.liveAction.title'
        )}
        maskClosable={false}
        closable={canClose}
        focusLock
        onCancel={requestClose}
        footer={
          <div className={styles.footer}>
            <div>
              <Button disabled={!canClose} onClick={requestClose}>
                {t('common.assistantSurface.regionalApproval.liveAction.close')}
              </Button>
              {refreshFailed && action.state.status === 'success' ? (
                <Button
                  type='primary'
                  onClick={() =>
                    action.state.status === 'success' && void complete(Promise.resolve(action.state.receipt))
                  }
                >
                  {t('common.assistantSurface.regionalApproval.liveAction.verifySave')}
                </Button>
              ) : action.state.status === 'error' && action.state.error.retrySameIntent ? (
                <Button type='primary' disabled={loading} onClick={retry}>
                  {t('common.assistantSurface.regionalApproval.liveAction.retry')}
                </Button>
              ) : action.state.status === 'error' && action.state.error.kind === 'conflict' ? (
                <Button
                  type='primary'
                  onClick={() => {
                    onRefresh();
                    onClose();
                  }}
                >
                  {t('common.assistantSurface.regionalApproval.liveAction.refresh')}
                </Button>
              ) : (
                <Button
                  type='primary'
                  disabled={invalid || loading || action.state.status === 'success'}
                  onClick={submit}
                >
                  {t(
                    action.state.status === 'success'
                      ? 'common.assistantSurface.regionalApproval.liveAction.completed'
                      : kind === 'SAVE'
                        ? 'common.assistantSurface.regionalApproval.liveAction.confirmSave'
                        : kind === 'APPROVE'
                          ? 'common.assistantSurface.regionalApproval.liveAction.confirmApprove'
                          : 'common.assistantSurface.regionalApproval.liveAction.confirmReject'
                  )}
                </Button>
              )}
            </div>
          </div>
        }
      >
        <div className={styles.body} data-testid='regional-approval-live-action-dialog'>
          <section className={styles.businessChecksum} data-testid='regional-approval-live-action-checksum'>
            <h3>
              {t(
                kind === 'SAVE'
                  ? 'common.assistantSurface.regionalApproval.liveAction.saveChecksumTitle'
                  : 'common.assistantSurface.regionalApproval.liveAction.checksum.title'
              )}
            </h3>
            <dl>
              {checksum.map((item) => (
                <div key={String(item.label)}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <div className={styles.form}>
            <div className={styles.formControl}>
              <span>{t('common.assistantSurface.regionalApproval.liveAction.action')}</span>
              {initialAction === 'SAVE' ? (
                <span>{t('common.assistantSurface.regionalApproval.liveAction.saveBoundary')}</span>
              ) : (
                <Radio.Group
                  value={kind}
                  aria-label={t('common.assistantSurface.regionalApproval.liveAction.action')}
                  disabled={approvalNodeOrder === undefined || intentLocked}
                  onChange={(value) => {
                    setKind(value as LiveActionKind);
                    setAttempted(false);
                  }}
                >
                  <Radio value='APPROVE' disabled={!access?.allowedActions.includes('APPROVE')}>
                    {t('common.assistantSurface.regionalApproval.liveAction.approve')}
                  </Radio>
                  <Radio
                    value='REJECT'
                    disabled={
                      !access?.allowedActions.includes('REJECT') ||
                      salesPlanActionTargetStatus('REJECT', row.status, row.planTypeCode) === undefined
                    }
                  >
                    {t('common.assistantSurface.regionalApproval.liveAction.reject')}
                  </Radio>
                </Radio.Group>
              )}
            </div>
            {targetStatus === undefined ? (
              <Alert
                type='info'
                showIcon
                content={t('common.assistantSurface.regionalApproval.liveAction.finalNode')}
              />
            ) : null}
            {kind !== 'REJECT' && supportsAdjustments ? (
              <section
                className={styles.adjustments}
                aria-label={t('common.assistantSurface.regionalApproval.liveAction.adjustments.title')}
              >
                <div className={styles.adjustmentHeader}>
                  <strong>{t('common.assistantSurface.regionalApproval.liveAction.adjustments.title')}</strong>
                  <span>
                    {t('common.assistantSurface.regionalApproval.liveAction.adjustments.summary', {
                      count: kind === 'SAVE' ? adjustments.length : visibleComparisons.length,
                    })}
                  </span>
                </div>
                <p>{t('common.assistantSurface.regionalApproval.liveAction.adjustments.help')}</p>
                {adjustmentSkus.status === 'loading' ? (
                  <div className={styles.loadingState}>
                    <Spin size={18} />
                    <span>{t('common.assistantSurface.regionalApproval.liveAction.adjustments.loading')}</span>
                  </div>
                ) : adjustmentSkus.status === 'error' ? (
                  <Alert
                    type='warning'
                    showIcon
                    content={t('common.assistantSurface.regionalApproval.liveAction.adjustments.loadFailed')}
                  />
                ) : adjustmentSkus.status === 'success' ? (
                  <>
                    <div
                      className={styles.nodeTotals}
                      aria-label={t('common.assistantSurface.regionalApproval.liveAction.adjustments.nodeSummary')}
                    >
                      <span>
                        <small>
                          {t('common.assistantSurface.regionalApproval.liveAction.adjustments.previousTotal')}
                        </small>
                        <strong>{displayNodeTotal(nodeTotals?.previousQty, nodeTotals?.previousAmount)}</strong>
                      </span>
                      <span>
                        <small>
                          {t('common.assistantSurface.regionalApproval.liveAction.adjustments.changeTotal')}
                        </small>
                        <strong>
                          {nodeTotals?.adjustmentQty && nodeTotals.amountDelta
                            ? `${signedDecimal(nodeTotals.adjustmentQty)} · ${signedDecimal(nodeTotals.amountDelta, true)}`
                            : unknown}
                        </strong>
                      </span>
                      <span>
                        <small>
                          {t('common.assistantSurface.regionalApproval.liveAction.adjustments.confirmedTotal')}
                        </small>
                        <strong>{displayNodeTotal(nodeTotals?.confirmedQty, nodeTotals?.confirmedAmount)}</strong>
                      </span>
                    </div>
                    <div className={styles.adjustmentTable} role='table'>
                      <div className={styles.adjustmentTableHeader} role='row'>
                        <span role='columnheader'>
                          {t('common.assistantSurface.regionalApproval.liveAction.adjustments.sku')}
                        </span>
                        <span role='columnheader'>
                          {t('common.assistantSurface.regionalApproval.liveAction.adjustments.previousNode')}
                        </span>
                        <span role='columnheader'>
                          {t('common.assistantSurface.regionalApproval.liveAction.adjustments.adjustQty')}
                        </span>
                        <span role='columnheader'>
                          {t('common.assistantSurface.regionalApproval.liveAction.adjustments.currentNode')}
                        </span>
                      </div>
                      {visibleComparisons.map((comparison) => {
                        const value = adjustmentValues[comparison.skuCode] ?? '';
                        const invalidValue = !comparison.adjustmentValid;
                        const inputLabel = t(
                          'common.assistantSurface.regionalApproval.liveAction.adjustments.inputLabel',
                          {
                            sku: comparison.skuCode,
                          }
                        );
                        return (
                          <div className={styles.adjustmentTableRow} role='row' key={comparison.sku.id}>
                            <span role='cell'>
                              <strong>{comparison.skuCode}</strong>
                              {comparison.sku.materialDescription ? (
                                <small>{comparison.sku.materialDescription}</small>
                              ) : null}
                              <small>{comparison.sku.productCategName}</small>
                            </span>
                            <span role='cell' className={styles.nodeValue}>
                              <strong>{displayDecimal(comparison.previousQty)}</strong>
                              <small>{displayDecimal(comparison.previousAmount, true)}</small>
                            </span>
                            <span role='cell'>
                              {kind === 'SAVE' ? (
                                <Input
                                  size='small'
                                  value={
                                    embedded
                                      ? (confirmedInputs[comparison.skuCode] ?? comparison.confirmedQty ?? '')
                                      : value
                                  }
                                  status={invalidValue ? 'error' : undefined}
                                  disabled={intentLocked}
                                  aria-label={
                                    embedded
                                      ? t('common.assistantSurface.regionalApproval.liveAdjustment.editQty', {
                                          sku: comparison.skuCode,
                                        })
                                      : inputLabel
                                  }
                                  placeholder={t(
                                    'common.assistantSurface.regionalApproval.liveAction.adjustments.placeholder'
                                  )}
                                  onChange={(nextValue) => {
                                    if (embedded)
                                      setConfirmedInputs((current) => ({
                                        ...current,
                                        [comparison.skuCode]: nextValue,
                                      }));
                                    setAdjustmentValues((current) => ({
                                      ...current,
                                      [comparison.skuCode]: embedded
                                        ? subtractExactDecimals(nextValue, comparison.previousQty ?? '0')
                                        : nextValue,
                                    }));
                                  }}
                                />
                              ) : (
                                <span>{signedDecimal(comparison.adjustmentQty)}</span>
                              )}
                            </span>
                            <span role='cell' className={styles.nodeValue}>
                              <strong>{displayDecimal(comparison.confirmedQty)}</strong>
                              {embedded ? (
                                <Input
                                  readOnly
                                  value={displayDecimal(comparison.confirmedAmount, true)}
                                  aria-label={t('common.assistantSurface.regionalApproval.liveAdjustment.editAmount', {
                                    sku: comparison.skuCode,
                                  })}
                                />
                              ) : (
                                <small>{displayDecimal(comparison.confirmedAmount, true)}</small>
                              )}
                              <em>
                                {comparison.adjustmentValid && comparison.amountDelta
                                  ? `${signedDecimal(comparison.adjustmentQty)} · ${signedDecimal(comparison.amountDelta, true)}`
                                  : unknown}
                              </em>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    {kind !== 'SAVE' && visibleComparisons.length === 0 ? (
                      <Alert
                        type='info'
                        showIcon
                        content={t('common.assistantSurface.regionalApproval.liveAction.adjustments.empty')}
                      />
                    ) : null}
                  </>
                ) : (
                  <Alert
                    type='warning'
                    showIcon
                    content={t('common.assistantSurface.regionalApproval.liveAction.adjustments.unavailable')}
                  />
                )}
              </section>
            ) : (
              <Alert
                type='info'
                showIcon
                content={t(
                  kind === 'REJECT'
                    ? 'common.assistantSurface.regionalApproval.liveAction.adjustments.rejectBoundary'
                    : 'common.assistantSurface.regionalApproval.liveAction.adjustments.nodeBoundary'
                )}
              />
            )}
            <div className={styles.formControl}>
              <span>
                {t(
                  kind === 'SAVE'
                    ? 'common.assistantSurface.regionalApproval.liveAction.saveRemark'
                    : kind === 'REJECT'
                      ? 'common.assistantSurface.regionalApproval.liveAction.rejectRemark'
                      : 'common.assistantSurface.regionalApproval.liveAction.approveRemark'
                )}
              </span>
              <Input.TextArea
                value={remark}
                maxLength={1000}
                showWordLimit
                disabled={intentLocked}
                status={attempted && kind === 'REJECT' && !remark.trim() ? 'error' : undefined}
                aria-label={t(
                  kind === 'SAVE'
                    ? 'common.assistantSurface.regionalApproval.liveAction.saveRemark'
                    : kind === 'REJECT'
                      ? 'common.assistantSurface.regionalApproval.liveAction.rejectRemark'
                      : 'common.assistantSurface.regionalApproval.liveAction.approveRemark'
                )}
                placeholder={t('common.assistantSurface.regionalApproval.liveAction.remarkPlaceholder')}
                autoSize={{ minRows: 2, maxRows: 4 }}
                onChange={setRemark}
              />
            </div>
            <Checkbox
              checked={confirmed}
              disabled={intentLocked}
              aria-label={t(
                kind === 'SAVE'
                  ? 'common.assistantSurface.regionalApproval.liveAction.saveConfirmation'
                  : 'common.assistantSurface.regionalApproval.liveAction.confirmation'
              )}
              onChange={setConfirmed}
            >
              {t(
                kind === 'SAVE'
                  ? 'common.assistantSurface.regionalApproval.liveAction.saveConfirmation'
                  : 'common.assistantSurface.regionalApproval.liveAction.confirmation'
              )}
            </Checkbox>
            {attempted && invalid ? (
              <Alert
                type='error'
                showIcon
                content={t('common.assistantSurface.regionalApproval.liveAction.required')}
              />
            ) : null}
          </div>

          {loading ? (
            <div className={styles.loadingState}>
              <Spin size={20} />
              <span>{t('common.assistantSurface.regionalApproval.liveAction.loading')}</span>
            </div>
          ) : null}
          {action.state.status === 'error' ? (
            <Alert type='error' showIcon content={t(errorKey(action.state.error.kind))} />
          ) : null}
          {action.state.status === 'success' ? (
            <Alert
              type='success'
              showIcon
              content={t(
                kind === 'SAVE'
                  ? 'common.assistantSurface.regionalApproval.liveAction.saveReceipt'
                  : 'common.assistantSurface.regionalApproval.liveAction.success',
                {
                  from: action.state.receipt.fromStatus,
                  to: action.state.receipt.toStatus,
                  auditId: action.state.receipt.auditId,
                }
              )}
            />
          ) : null}
          {refreshFailed ? (
            <Alert
              type='warning'
              showIcon
              content={t(
                kind === 'SAVE'
                  ? 'common.assistantSurface.regionalApproval.liveAction.saveRefreshFailed'
                  : 'common.assistantSurface.regionalApproval.liveAction.refreshFailed'
              )}
            />
          ) : null}
        </div>
      </Container>
      <Modal
        visible={discardConfirmVisible}
        title={t('common.assistantSurface.regionalApproval.liveAction.adjustments.discardTitle')}
        okText={t('common.assistantSurface.regionalApproval.liveAction.adjustments.discard')}
        cancelText={t('common.assistantSurface.regionalApproval.liveAction.adjustments.keepEditing')}
        okButtonProps={{ status: 'danger' }}
        maskClosable={false}
        focusLock
        onCancel={() => setDiscardConfirmVisible(false)}
        onOk={() => {
          setDiscardConfirmVisible(false);
          onClose();
        }}
      >
        {t('common.assistantSurface.regionalApproval.liveAction.adjustments.discardDescription')}
      </Modal>
    </>
  );
};

export default RegionalApprovalLiveActionDialog;
