/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import { Alert, Button, Checkbox, Input, Modal, Radio, Select, Spin, Tabs, Tag } from '@arco-design/web-react';
import type { TFunction } from 'i18next';
import React, { useMemo, useRef, useState } from 'react';
import type { SavedApprovalAdjustment } from './regionalApprovalDetailModel.ts';
import type { ApprovalStageId, ApprovalVersion, RegionalApprovalRow } from './regionalApprovalFixture.ts';
import {
  executeRegionalApprovalFixtureAction,
  reduceRegionalApprovalActionStore,
  regionalApprovalActionKey,
  regionalApprovalReturnValidationErrors,
  regionalApprovalSubmitValidationErrors,
  type RegionalApprovalActionCommand,
  type RegionalApprovalActionExecutor,
  type RegionalApprovalActionKind,
  type RegionalApprovalActionScope,
  type RegionalApprovalActionStore,
} from './regionalApprovalActionModel.ts';
import styles from './RegionalApprovalActionDialog.module.css';

const RegionalApprovalActionDialog: React.FC<{
  visible: boolean;
  rows: readonly RegionalApprovalRow[];
  version: ApprovalVersion;
  approvalStage: ApprovalStageId;
  savedAdjustments: SavedApprovalAdjustment[];
  store: RegionalApprovalActionStore;
  t: TFunction;
  executor?: RegionalApprovalActionExecutor;
  onStoreChange: React.Dispatch<React.SetStateAction<RegionalApprovalActionStore>>;
  onClose: () => void;
}> = ({
  visible,
  rows,
  version,
  approvalStage,
  savedAdjustments,
  store,
  t,
  executor = executeRegionalApprovalFixtureAction,
  onStoreChange,
  onClose,
}) => {
  const [kind, setKind] = useState<RegionalApprovalActionKind>('return');
  const [attempted, setAttempted] = useState(false);
  const [batchSummary, setBatchSummary] = useState<{ success: number; failed: number }>();
  const [failedRowIds, setFailedRowIds] = useState<string[]>([]);
  const requestSequence = useRef(0);
  const inFlight = useRef(false);
  const cancelRequested = useRef(false);
  const scopedAdjustments = useMemo(
    () =>
      savedAdjustments.filter(
        (adjustment) => rows.some((row) => row.id === adjustment.organizationId) && adjustment.version === version
      ),
    [rows, savedAdjustments, version]
  );
  const scopes = useMemo<RegionalApprovalActionScope[]>(
    () =>
      rows.map((row) => ({
        organizationId: row.id,
        version,
        approvalStage,
        savedAdjustmentCount: scopedAdjustments.filter((adjustment) => adjustment.organizationId === row.id).length,
      })),
    [approvalStage, rows, scopedAdjustments, version]
  );
  const actionKeys = scopes.map((scope) => regionalApprovalActionKey(kind, scope));
  const completedResult = actionKeys.length > 0 && actionKeys.every((key) => store.results[key]);
  const operation = store.operation;
  const operationForCurrentAction = operation && actionKeys.includes(operation.command.key) ? operation : undefined;
  const loading = operation?.status === 'loading';
  const validationErrors =
    kind === 'return' ? regionalApprovalReturnValidationErrors(store) : regionalApprovalSubmitValidationErrors(store);

  const dispatch = (action: Parameters<typeof reduceRegionalApprovalActionStore>[1]) =>
    onStoreChange((current) => reduceRegionalApprovalActionStore(current, action));

  const buildCommand = (scope: RegionalApprovalActionScope, attempt: number): RegionalApprovalActionCommand => {
    const requestId = `${kind}-${scope.organizationId}-${version}-${++requestSequence.current}`;
    return {
      requestId,
      key: regionalApprovalActionKey(kind, scope),
      kind,
      attempt,
      scope,
      ...(kind === 'return'
        ? {
            returnTarget: store.returnDraft.target || undefined,
            reason: store.returnDraft.reason.trim(),
            impactScope: store.returnDraft.impactScope,
          }
        : {}),
    };
  };

  const run = async (attempt = 1, targetRows = rows) => {
    setAttempted(true);
    if (validationErrors.length > 0 || completedResult || inFlight.current) return;
    inFlight.current = true;
    cancelRequested.current = false;
    setBatchSummary(undefined);
    const failed: string[] = [];
    let success = 0;
    for (const row of targetRows) {
      if (cancelRequested.current) break;
      const scope = scopes.find((candidate) => candidate.organizationId === row.id);
      if (!scope) continue;
      const command = buildCommand(scope, attempt);
      dispatch({ type: 'start', command });
      try {
        const outcome = await executor(command);
        dispatch({ type: 'success', requestId: command.requestId, outcome });
        success += 1;
      } catch (error) {
        failed.push(row.id);
        dispatch({
          type: 'failure',
          requestId: command.requestId,
          errorCode: error instanceof Error && error.message ? error.message : 'fixture_action_failed',
        });
      }
    }
    setFailedRowIds(failed);
    setBatchSummary({ success, failed: failed.length });
    inFlight.current = false;
  };

  const retry = () =>
    run(
      (operationForCurrentAction?.command.attempt ?? 1) + 1,
      rows.filter((row) => failedRowIds.includes(row.id))
    );
  const cancelLoading = () => {
    if (operation?.status !== 'loading') return;
    cancelRequested.current = true;
    dispatch({ type: 'cancel', requestId: operation.command.requestId });
    inFlight.current = false;
  };
  const switchKind = (next: string | number) => {
    if (loading) return;
    setKind(next as RegionalApprovalActionKind);
    setAttempted(false);
    setBatchSummary(undefined);
    setFailedRowIds([]);
    dispatch({ type: 'clear-operation' });
  };

  const statusAlert = () => {
    if (!operationForCurrentAction) return null;
    if (operationForCurrentAction.status === 'loading') {
      return (
        <Alert type='info' showIcon content={t('common.assistantSurface.regionalApproval.action.status.loading')} />
      );
    }
    if (operationForCurrentAction.status === 'success') {
      return (
        <Alert type='success' showIcon content={t('common.assistantSurface.regionalApproval.action.status.success')} />
      );
    }
    if (operationForCurrentAction.status === 'failure') {
      return (
        <Alert
          type='error'
          showIcon
          content={t('common.assistantSurface.regionalApproval.action.status.failure', {
            code: operationForCurrentAction.errorCode ?? 'fixture_action_failed',
          })}
        />
      );
    }
    return (
      <Alert type='warning' showIcon content={t('common.assistantSurface.regionalApproval.action.status.cancelled')} />
    );
  };

  return (
    <Modal
      visible={visible}
      className={styles.modal}
      title={t('common.assistantSurface.regionalApproval.action.title')}
      maskClosable={false}
      closable={!loading}
      focusLock
      onCancel={() => !loading && onClose()}
      footer={
        <div className={styles.footer}>
          <span>{t('common.assistantSurface.regionalApproval.action.localBoundary')}</span>
          <div>
            <Button disabled={loading} onClick={onClose}>
              {t('common.assistantSurface.regionalApproval.action.cancel')}
            </Button>
            {loading ? (
              <Button status='danger' onClick={cancelLoading}>
                {t('common.assistantSurface.regionalApproval.action.cancelExecution')}
              </Button>
            ) : operationForCurrentAction?.status === 'failure' || operationForCurrentAction?.status === 'cancelled' ? (
              <Button type='primary' onClick={retry}>
                {t('common.assistantSurface.regionalApproval.action.retry')}
              </Button>
            ) : (
              <Button type='primary' disabled={Boolean(completedResult)} onClick={() => run()}>
                {t(
                  completedResult
                    ? 'common.assistantSurface.regionalApproval.action.completed'
                    : kind === 'return'
                      ? 'common.assistantSurface.regionalApproval.action.confirmReturn'
                      : 'common.assistantSurface.regionalApproval.action.confirmSubmit'
                )}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className={styles.body} data-testid='regional-approval-action-dialog'>
        <Alert type='warning' showIcon content={t('common.assistantSurface.regionalApproval.action.fixtureBoundary')} />
        <div className={styles.scopeSummary}>
          <span>
            <small>{t('common.assistantSurface.regionalApproval.action.organization')}</small>
            <strong>
              {rows.length === 1
                ? t(`common.assistantSurface.regionalApproval.organizations.${rows[0].organizationKey}`)
                : t('common.assistantSurface.regionalApproval.action.batchOrganizations', { count: rows.length })}
            </strong>
          </span>
          <span>
            <small>{t('common.assistantSurface.regionalApproval.action.version')}</small>
            <strong>{t(`common.assistantSurface.regionalApproval.versions.${version}`)}</strong>
          </span>
          <span>
            <small>{t('common.assistantSurface.regionalApproval.action.savedAdjustments')}</small>
            <strong>{scopedAdjustments.length}</strong>
          </span>
          <Tag color='red'>{t('common.assistantSurface.regionalApproval.action.fixtureTag')}</Tag>
        </div>

        <Tabs activeTab={kind} onChange={switchKind}>
          <Tabs.TabPane key='return' title={t('common.assistantSurface.regionalApproval.action.tabs.return')}>
            <div className={styles.form}>
              <div className={styles.formControl}>
                <span>{t('common.assistantSurface.regionalApproval.action.returnTarget')}</span>
                <Select
                  aria-label={t('common.assistantSurface.regionalApproval.action.returnTarget')}
                  value={store.returnDraft.target || undefined}
                  status={attempted && validationErrors.includes('target') ? 'error' : undefined}
                  placeholder={t('common.assistantSurface.regionalApproval.action.returnTargetPlaceholder')}
                  onChange={(target) => dispatch({ type: 'return-target', target })}
                >
                  <Select.Option value='previous-stage'>
                    {t('common.assistantSurface.regionalApproval.action.returnTargets.previousStage')}
                  </Select.Option>
                  <Select.Option value='submitting-organization'>
                    {t('common.assistantSurface.regionalApproval.action.returnTargets.submittingOrganization')}
                  </Select.Option>
                </Select>
              </div>
              <div className={styles.formControl}>
                <span>{t('common.assistantSurface.regionalApproval.action.impactScope')}</span>
                <Radio.Group
                  value={store.returnDraft.impactScope}
                  aria-label={t('common.assistantSurface.regionalApproval.action.impactScope')}
                  onChange={(impactScope) => dispatch({ type: 'return-impact', impactScope })}
                >
                  <Radio value='current-organization'>
                    {t('common.assistantSurface.regionalApproval.action.impactScopes.currentOrganization')}
                  </Radio>
                  <Radio value='filtered-scope'>
                    {t('common.assistantSurface.regionalApproval.action.impactScopes.filteredScope')}
                  </Radio>
                </Radio.Group>
              </div>
              <div className={styles.formControl}>
                <span>{t('common.assistantSurface.regionalApproval.action.returnReason')}</span>
                <Input.TextArea
                  value={store.returnDraft.reason}
                  status={attempted && validationErrors.includes('reason') ? 'error' : undefined}
                  aria-label={t('common.assistantSurface.regionalApproval.action.returnReason')}
                  placeholder={t('common.assistantSurface.regionalApproval.action.returnReasonPlaceholder')}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  onChange={(reason) => dispatch({ type: 'return-reason', reason })}
                />
              </div>
              {attempted && validationErrors.length > 0 ? (
                <Alert type='error' content={t('common.assistantSurface.regionalApproval.action.requiredError')} />
              ) : null}
            </div>
          </Tabs.TabPane>
          <Tabs.TabPane key='submit' title={t('common.assistantSurface.regionalApproval.action.tabs.submit')}>
            <div className={styles.form}>
              <div className={styles.adjustmentSummary}>
                <strong>{t('common.assistantSurface.regionalApproval.action.adjustmentSummary')}</strong>
                {scopedAdjustments.length > 0 ? (
                  scopedAdjustments.map((adjustment) => (
                    <span key={adjustment.skuId}>
                      {adjustment.skuId.split('-').at(-1)} · {adjustment.initialQuantity} → {adjustment.editedQuantity}{' '}
                      · {adjustment.reason}
                    </span>
                  ))
                ) : (
                  <span>{t('common.assistantSurface.regionalApproval.action.noSavedAdjustments')}</span>
                )}
              </div>
              <Checkbox
                checked={store.submitConfirmed}
                aria-label={t('common.assistantSurface.regionalApproval.action.submitConfirmation')}
                onChange={(confirmed) => dispatch({ type: 'submit-confirmed', confirmed })}
              >
                {t('common.assistantSurface.regionalApproval.action.submitConfirmation')}
              </Checkbox>
              {attempted && validationErrors.length > 0 ? (
                <Alert type='error' content={t('common.assistantSurface.regionalApproval.action.confirmationError')} />
              ) : null}
            </div>
          </Tabs.TabPane>
        </Tabs>

        {loading ? (
          <div className={styles.loadingState}>
            <Spin size={20} />
            <span>{t('common.assistantSurface.regionalApproval.action.status.loading')}</span>
          </div>
        ) : null}
        {statusAlert()}
        {batchSummary ? (
          <Alert
            type={batchSummary.failed > 0 ? 'warning' : 'success'}
            showIcon
            content={t('common.assistantSurface.regionalApproval.action.status.batch', batchSummary)}
          />
        ) : null}
      </div>
    </Modal>
  );
};

export default RegionalApprovalActionDialog;
