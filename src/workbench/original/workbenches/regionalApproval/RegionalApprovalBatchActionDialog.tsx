/** 改编自 AionUi（Apache-2.0）：已替换为本地导入并使用显式 DSH Host 适配器，见 SOURCE.md。 */
import { Alert, Button, Checkbox, Input, Modal, Spin } from '@arco-design/web-react';
import type { TFunction } from 'i18next';
import React, { useEffect, useRef, useState } from 'react';
import type { GeaSalesPlanActionRequest } from '../../bridge.ts';
import {
  SalesPlanActionAttempt,
  classifySalesPlanActionError,
  type SalesPlanActionClient,
  type SalesPlanActionError,
} from './models/salesPlanActionModel.ts';
import type { SalesPlanAccess } from './models/salesPlanAccessModel.ts';
import type { RegionalApprovalLiveRow } from './regionalApprovalQueryModel.ts';
import { actionErrorText } from './RegionalApprovalLiveActionDialog.tsx';
import styles from './RegionalApprovalActionDialog.module.css';

export type BatchActionKind = 'APPROVE' | 'REJECT';

/** 全部成功后自动收起弹窗，避免每次提交都要再点一次「关闭」。 */
const AUTO_CLOSE_SECONDS = 5;

export type BatchActionItem = {
  row: RegionalApprovalLiveRow;
  /** 与单笔按钮同源的能力证据；缺失时该笔不提交，只在结果里说明原因。 */
  access?: SalesPlanAccess;
  /** 与单笔按钮同源的置灰原因键，用于把「为什么这一笔没提交」说清楚。 */
  skipReason?: string;
};

export type BatchActionOutcome = {
  planId: string;
  label: string;
  /** 组织路径，便于在结果里认人是哪一笔。 */
  context?: string;
  status: 'success' | 'failed' | 'skipped';
  /** 失败或跳过时的业务语言说明。 */
  detail?: string;
};

const planLabel = (row: RegionalApprovalLiveRow) =>
  row.dealerName?.trim() || row.orgName?.trim() || row.planId;

const planContext = (row: RegionalApprovalLiveRow) =>
  [row.areaName, row.provinceName, row.orgName]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(' / ');

/**
 * 批量审批：按用户勾选逐笔提交，逐笔校验并逐笔回报结果。
 * 一笔失败不回滚已成功的，也不阻止后续提交；返回时会汇总成功、失败与跳过。
 */
const RegionalApprovalBatchActionDialog: React.FC<{
  visible: boolean;
  kind: BatchActionKind;
  items: readonly BatchActionItem[];
  t: TFunction;
  client?: SalesPlanActionClient;
  onPermissionDenied: (versionId: string) => void;
  onCompleted: (outcomes: readonly BatchActionOutcome[]) => void | Promise<void>;
  onClose: () => void;
}> = ({ visible, kind, items, t, client, onPermissionDenied, onCompleted, onClose }) => {
  const [remark, setRemark] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<BatchActionOutcome[]>();
  const [secondsToClose, setSecondsToClose] = useState<number>();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // 只在全部成功时倒计时；有失败或跳过时保持打开，别把原因一闪而过。
  useEffect(() => {
    if (!outcomes) return;
    if (outcomes.some((outcome) => outcome.status !== 'success')) {
      setSecondsToClose(undefined);
      return;
    }
    setSecondsToClose(AUTO_CLOSE_SECONDS);
    const timer = window.setInterval(() => setSecondsToClose((current) => (current === undefined ? current : Math.max(0, current - 1))), 1000);
    return () => window.clearInterval(timer);
  }, [outcomes]);

  useEffect(() => {
    if (secondsToClose !== 0) return;
    closeRef.current();
  }, [secondsToClose]);

  const mixedReject = kind === 'REJECT' && items.some((item) => item.row.status >= 7 && item.row.status <= 9)
    && items.some((item) => item.row.status >= 1 && item.row.status <= 4);
  const submittable = items.filter((item) => item.access?.allowedActions.includes(kind));
  const submitted = outcomes?.filter((outcome) => outcome.status === 'success').length ?? 0;
  const failed = outcomes?.filter((outcome) => outcome.status === 'failed').length ?? 0;
  const skipped = outcomes?.filter((outcome) => outcome.status === 'skipped').length ?? 0;
  const unsuccessful = outcomes?.filter((outcome) => outcome.status !== 'success') ?? [];
  const locked = busy || outcomes !== undefined;
  const invalid = !submittable.length || !confirmed || (kind === 'REJECT' && !remark.trim());

  const skipText = (item: BatchActionItem) =>
    item.skipReason
      ? t(`common.assistantSurface.regionalApproval.liveAction.disabled.${item.skipReason}`)
      : t('common.assistantSurface.regionalApproval.liveBatch.skipped');

  const submit = async () => {
    setAttempted(true);
    if (invalid || locked || !client) return;
    setBusy(true);
    const collected: BatchActionOutcome[] = [];
    for (const item of items) {
      const label = planLabel(item.row);
      const context = planContext(item.row) || undefined;
      if (!item.access?.allowedActions.includes(kind)) {
        collected.push({ planId: item.row.planId, label, ...(context ? { context } : {}), status: 'skipped', detail: skipText(item) });
        continue;
      }
      const request: GeaSalesPlanActionRequest = {
        approvalRole: item.access.approvalRole,
        ...(item.access.roleContractSupported ? { approvalPolicy: 'role-visible-v1' as const } : {}),
        action: kind,
        expectedStatus: item.row.status,
        ...(item.access.snapshotHash ? { expectedSnapshot: item.access.snapshotHash } : {}),
        ...(remark.trim() ? { remark: remark.trim() } : {}),
      };
      const attempt = new SalesPlanActionAttempt(client);
      try {
        // 逐笔串行提交：每笔都有自己的幂等键，失败不会影响已提交的其它计划。
        // eslint-disable-next-line no-await-in-loop
        await attempt.submit({
          planId: item.row.planId,
          versionId: item.row.versionId,
          planTypeCode: item.row.planTypeCode,
          request,
          serverWorkflowResult: !item.access.snapshotHash,
          serverRoleResult: item.access.roleContractSupported,
        });
        collected.push({ planId: item.row.planId, label, ...(context ? { context } : {}), status: 'success' });
      } catch (error) {
        const classified = classifySalesPlanActionError(error);
        if (classified.kind === 'permission') onPermissionDenied(item.row.versionId);
        collected.push({
          planId: item.row.planId,
          label,
          ...(context ? { context } : {}),
          status: 'failed',
          detail: actionErrorText(t, classified as SalesPlanActionError),
        });
      }
    }
    setOutcomes(collected);
    setBusy(false);
    await onCompleted(collected);
  };

  return (
    <Modal
      visible={visible}
      className={styles.liveModal}
      title={t(
        kind === 'APPROVE'
            ? 'common.assistantSurface.regionalApproval.liveBatch.approveTitle'
            : 'common.assistantSurface.regionalApproval.liveBatch.rejectTitle',
        { count: items.length },
      )}
      maskClosable={false}
      closable={!busy}
      onCancel={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className={styles.footer}>
          <div>
            <Button disabled={busy} onClick={onClose}>
              {t('common.assistantSurface.regionalApproval.liveBatch.close')}
            </Button>
          </div>
          <Button
            type='primary'
            status={kind === 'REJECT' ? 'danger' : undefined}
            loading={busy}
            disabled={invalid || locked || !client}
            onClick={() => void submit()}
          >
            {t(
              kind === 'APPROVE'
                  ? 'common.assistantSurface.regionalApproval.liveBatch.confirmApprove'
                  : 'common.assistantSurface.regionalApproval.liveBatch.confirmReject',
            )}
          </Button>
        </div>
      }
    >
      <div className={styles.body} data-testid='regional-approval-batch-action-dialog'>
        <p data-testid='regional-approval-batch-summary'>
          {t('common.assistantSurface.regionalApproval.liveBatch.summary', {
            total: items.length,
            ready: submittable.length,
          })}
        </p>
        <ul className={styles.businessChecksum} data-testid='regional-approval-batch-items'>
          {items.map((item) => (
            <li key={item.row.planId}>
              <strong>{planLabel(item.row)}</strong>
              {planContext(item.row) ? <span> · {planContext(item.row)}</span> : null}
              {item.access?.allowedActions.includes(kind) ? (
                mixedReject ? <span> · {t(`common.assistantSurface.regionalApproval.liveBatch.${item.row.status >= 7 ? 'repeatRejectTag' : 'rejectTag'}`)}</span>
                  : null
              ) : (
                <span> · {skipText(item)}</span>
              )}
            </li>
          ))}
        </ul>
        <label className={styles.formControl}>
          <span>
            {t(
              kind === 'REJECT'
                ? 'common.assistantSurface.regionalApproval.liveAction.rejectRemark'
                : 'common.assistantSurface.regionalApproval.liveBatch.approveRemark',
            )}
          </span>
          <Input.TextArea
            value={remark}
            maxLength={1000}
            showWordLimit
            disabled={locked}
            status={attempted && kind === 'REJECT' && !remark.trim() ? 'error' : undefined}
            aria-label={t('common.assistantSurface.regionalApproval.liveBatch.remarkLabel')}
            placeholder={t('common.assistantSurface.regionalApproval.liveAction.remarkPlaceholder')}
            autoSize={{ minRows: 3, maxRows: 5 }}
            onChange={setRemark}
          />
        </label>
        <Checkbox checked={confirmed} disabled={locked} onChange={setConfirmed}>
          {t('common.assistantSurface.regionalApproval.liveBatch.confirmation', {
            count: submittable.length,
          })}
        </Checkbox>
        {attempted && invalid && !locked ? (
          <Alert type='error' showIcon content={t('common.assistantSurface.regionalApproval.liveBatch.required')} />
        ) : null}
        {busy ? (
          <div className={styles.loadingState}>
            <Spin size={16} />
            <span>{t('common.assistantSurface.regionalApproval.liveBatch.loading', { count: items.length })}</span>
          </div>
        ) : null}
        {outcomes ? (
          <div data-testid='regional-approval-batch-result' aria-live='polite'>
            <Alert
              type={failed ? 'warning' : 'success'}
              showIcon
              content={t('common.assistantSurface.regionalApproval.liveBatch.result', {
                success: submitted,
                failed,
                skipped,
              })}
            />
            {secondsToClose === undefined ? null : (
              <p className={styles.formControl} data-testid='regional-approval-batch-autoclose'>
                {t('common.assistantSurface.regionalApproval.liveBatch.autoClose', { seconds: secondsToClose })}
              </p>
            )}
            {unsuccessful.length > 0 ? <ul className={styles.businessChecksum}>
              {unsuccessful.map((outcome) => (
                  <li key={outcome.planId}>
                    <strong>{outcome.label}</strong>
                    {outcome.context ? <span> · {outcome.context}</span> : null}
                    <span> · {outcome.detail ?? t('common.assistantSurface.regionalApproval.liveBatch.skipped')}</span>
                  </li>
                ))}
            </ul> : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
};

export default RegionalApprovalBatchActionDialog;
