/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import { Alert, Button, Input, InputNumber, Modal, Select, Tabs, Tag } from '@arco-design/web-react';
import type { TFunction } from 'i18next';
import React, { useEffect, useMemo, useState } from 'react';
import { regionalApprovalSkuFixtures } from './regionalApprovalDetailFixture.ts';
import {
  approvalPlan,
  approvalPlanValidationErrors,
  isApprovalPlanDirty,
  reduceApprovalDetailStore,
  type ApprovalDetailAction,
  type ApprovalDetailStore,
} from './regionalApprovalDetailModel.ts';
import {
  APPROVAL_DIMENSIONS_BY_STAGE,
  type ApprovalDimension,
  type ApprovalStageId,
  type ApprovalVersion,
  type RegionalApprovalRow,
} from './regionalApprovalFixture.ts';
import styles from './RegionalApprovalPlanDetail.module.css';

type PendingTransition =
  | { type: 'close' }
  | { type: 'row'; rowId: string }
  | { type: 'version'; version: ApprovalVersion };

type ApprovalAdjustmentDimension = ApprovalDimension | 'category';

const RegionalApprovalPlanDetail: React.FC<{
  visible: boolean;
  rows: readonly RegionalApprovalRow[];
  row: RegionalApprovalRow;
  approvalStage: ApprovalStageId;
  categoryComparison: boolean;
  version: ApprovalVersion;
  store: ApprovalDetailStore;
  t: TFunction;
  onStoreChange: (store: ApprovalDetailStore) => void;
  onClose: () => void;
  onRowChange: (rowId: string) => void;
  onVersionChange: (version: ApprovalVersion) => void;
}> = ({
  visible,
  rows,
  row,
  approvalStage,
  categoryComparison,
  version,
  store,
  t,
  onStoreChange,
  onClose,
  onRowChange,
  onVersionChange,
}) => {
  const [pendingTransition, setPendingTransition] = useState<PendingTransition>();
  const adjustmentDimensions = useMemo<readonly ApprovalAdjustmentDimension[]>(
    () =>
      categoryComparison
        ? [...APPROVAL_DIMENSIONS_BY_STAGE[approvalStage], 'category']
        : APPROVAL_DIMENSIONS_BY_STAGE[approvalStage],
    [approvalStage, categoryComparison]
  );
  const [adjustmentDimension, setAdjustmentDimension] = useState<ApprovalAdjustmentDimension>(adjustmentDimensions[0]);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const plan = approvalPlan(store, row, version);
  const skuFixtures = useMemo(() => regionalApprovalSkuFixtures(row, version), [row, version]);
  const validationErrors = approvalPlanValidationErrors(plan);
  const dirty = isApprovalPlanDirty(plan);
  const canEdit = row.permission === 'writable' && row.approvalState === 'pending';
  const totals = Object.values(plan.working).reduce(
    (result, adjustment) => ({
      quantity: result.quantity + adjustment.editedQuantity,
      amount: result.amount + adjustment.editedAmount,
    }),
    { quantity: 0, amount: 0 }
  );
  const reasons = [...new Set(Object.values(plan.working).map((adjustment) => adjustment.reason))];
  const businessReason = reasons.length === 1 ? reasons[0] : '';

  useEffect(() => {
    setSaveAttempted(false);
    setSavedFeedback(false);
  }, [row.id, version]);

  useEffect(() => {
    if (!adjustmentDimensions.includes(adjustmentDimension)) setAdjustmentDimension(adjustmentDimensions[0]);
  }, [adjustmentDimension, adjustmentDimensions]);

  const applyAction = (action: ApprovalDetailAction) => {
    onStoreChange(reduceApprovalDetailStore(store, row, version, action));
    setSavedFeedback(false);
  };

  const completeTransition = (transition: PendingTransition) => {
    setPendingTransition(undefined);
    if (transition.type === 'close') onClose();
    if (transition.type === 'row') onRowChange(transition.rowId);
    if (transition.type === 'version') onVersionChange(transition.version);
  };

  const requestTransition = (transition: PendingTransition) => {
    if (dirty) setPendingTransition(transition);
    else completeTransition(transition);
  };

  const discardAndContinue = () => {
    if (!pendingTransition) return;
    onStoreChange(reduceApprovalDetailStore(store, row, version, { type: 'discard' }));
    completeTransition(pendingTransition);
  };

  const save = () => {
    setSaveAttempted(true);
    if (validationErrors.length > 0) return;
    onStoreChange(reduceApprovalDetailStore(store, row, version, { type: 'save' }));
    setSavedFeedback(true);
    setSaveAttempted(false);
  };

  return (
    <>
      <Modal
        visible={visible}
        className={styles.detailModal}
        title={t('common.assistantSurface.regionalApproval.detail.title')}
        maskClosable={false}
        autoFocus={false}
        focusLock
        onCancel={() => requestTransition({ type: 'close' })}
        footer={
          <div className={styles.footer}>
            <span>
              <Tag color={dirty ? 'orange' : 'green'}>
                {t(
                  dirty
                    ? 'common.assistantSurface.regionalApproval.detail.dirty'
                    : 'common.assistantSurface.regionalApproval.detail.saved'
                )}
              </Tag>
              <small>{t('common.assistantSurface.regionalApproval.detail.localBoundary')}</small>
            </span>
            <span>
              <Button onClick={() => requestTransition({ type: 'close' })}>
                {t('common.assistantSurface.regionalApproval.detail.close')}
              </Button>
              <Button type='primary' disabled={!dirty || !canEdit} onClick={save}>
                {t('common.assistantSurface.regionalApproval.detail.save')}
              </Button>
            </span>
          </div>
        }
      >
        <div className={styles.body} data-testid='regional-approval-plan-detail'>
          <Alert type='info' showIcon content={t('common.assistantSurface.regionalApproval.detail.fixtureBoundary')} />
          <div className={styles.scopeControls}>
            <div>
              <span>{t('common.assistantSurface.regionalApproval.detail.organization')}</span>
              <Select
                value={row.id}
                aria-label={t('common.assistantSurface.regionalApproval.detail.organization')}
                onChange={(rowId) => requestTransition({ type: 'row', rowId: String(rowId) })}
              >
                {rows.map((candidate) => (
                  <Select.Option key={candidate.id} value={candidate.id}>
                    {t(`common.assistantSurface.regionalApproval.organizations.${candidate.organizationKey}`)}
                  </Select.Option>
                ))}
              </Select>
            </div>
            <div>
              <span>{t('common.assistantSurface.regionalApproval.detail.version')}</span>
              <Select
                value={version}
                aria-label={t('common.assistantSurface.regionalApproval.detail.version')}
                onChange={(next) => requestTransition({ type: 'version', version: next as ApprovalVersion })}
              >
                {(['current', 'previous', 'initial'] as const).map((candidate) => (
                  <Select.Option key={candidate} value={candidate}>
                    {t(`common.assistantSurface.regionalApproval.versions.${candidate}`)}
                  </Select.Option>
                ))}
              </Select>
            </div>
            <div className={styles.evidenceReceipt}>
              <span>{t('common.assistantSurface.regionalApproval.detail.evidenceReceipt')}</span>
              <strong>{row.id}</strong>
              <small>{version} · regional-approval-fixture-v3</small>
            </div>
          </div>

          <Tabs defaultActiveTab='adjustment'>
            <Tabs.TabPane key='adjustment' title={t('common.assistantSurface.regionalApproval.detail.tabs.adjustment')}>
              {saveAttempted && validationErrors.length > 0 ? (
                <Alert
                  type='error'
                  content={t('common.assistantSurface.regionalApproval.detail.reasonError', {
                    count: validationErrors.length,
                  })}
                />
              ) : null}
              {savedFeedback ? (
                <Alert type='success' content={t('common.assistantSurface.regionalApproval.detail.savedFeedback')} />
              ) : null}

              <div className={styles.planSummary}>
                <span>
                  <small>{t('common.assistantSurface.regionalApproval.detail.totalQuantity')}</small>
                  <InputNumber
                    min={1}
                    precision={0}
                    value={totals.quantity}
                    disabled={!canEdit}
                    aria-label={t('common.assistantSurface.regionalApproval.detail.planQuantity')}
                    onChange={(quantity) =>
                      applyAction({ type: 'edit-plan-quantity', quantity: Number(quantity ?? totals.quantity) })
                    }
                  />
                </span>
                <span>
                  <small>{t('common.assistantSurface.regionalApproval.detail.totalAmount')}</small>
                  <InputNumber
                    min={1}
                    precision={0}
                    value={totals.amount}
                    disabled={!canEdit}
                    aria-label={t('common.assistantSurface.regionalApproval.detail.planAmount')}
                    onChange={(amount) =>
                      applyAction({ type: 'edit-plan-amount', amount: Number(amount ?? totals.amount) })
                    }
                  />
                </span>
                <Button disabled={!canEdit} onClick={() => applyAction({ type: 'accept-all-suggestions' })}>
                  {t('common.assistantSurface.regionalApproval.detail.acceptAll')}
                </Button>
              </div>
              <Tabs
                activeTab={adjustmentDimension}
                type='rounded'
                onChange={(dimension) => setAdjustmentDimension(dimension as ApprovalAdjustmentDimension)}
              >
                {adjustmentDimensions.map((dimension) => (
                  <Tabs.TabPane
                    key={dimension}
                    title={t(`common.assistantSurface.regionalApproval.dimensions.${dimension}`)}
                  />
                ))}
              </Tabs>
              <div className={styles.businessReason}>
                <span>{t('common.assistantSurface.regionalApproval.detail.businessReason')}</span>
                <Input.TextArea
                  value={businessReason}
                  disabled={!canEdit}
                  aria-label={t('common.assistantSurface.regionalApproval.detail.businessReason')}
                  placeholder={t('common.assistantSurface.regionalApproval.detail.businessReasonPlaceholder')}
                  autoSize={{ minRows: 2, maxRows: 3 }}
                  onChange={(reason) => applyAction({ type: 'reason-all', reason })}
                />
              </div>
              <div className={styles.skuList}>
                {skuFixtures.map((fixture) => {
                  const adjustment = plan.working[fixture.id];
                  const delta = adjustment.editedQuantity - adjustment.initialQuantity;
                  const reasonInvalid = saveAttempted && validationErrors.includes(fixture.id);
                  return (
                    <section className={styles.skuCard} key={fixture.id} data-testid={`approval-detail-${fixture.id}`}>
                      <header>
                        <span>
                          <strong>{fixture.id.split('-').at(-1)}</strong>
                          <small>
                            {t(`common.assistantSurface.regionalApproval.detail.products.${fixture.productKey}`)}
                          </small>
                        </span>
                        <Tag color={delta === 0 ? 'gray' : 'orange'}>
                          {t('common.assistantSurface.regionalApproval.detail.delta', { delta })}
                        </Tag>
                      </header>
                      <div className={styles.quantityGrid}>
                        <span>
                          <small>{t('common.assistantSurface.regionalApproval.detail.initialQuantity')}</small>
                          <strong>{adjustment.initialQuantity.toLocaleString()}</strong>
                        </span>
                        <span>
                          <small>{t('common.assistantSurface.regionalApproval.detail.editedQuantity')}</small>
                          <InputNumber
                            min={0}
                            precision={0}
                            value={adjustment.editedQuantity}
                            disabled={!canEdit}
                            aria-label={t('common.assistantSurface.regionalApproval.detail.editedQuantityFor', {
                              sku: fixture.id.split('-').at(-1),
                            })}
                            onChange={(quantity) =>
                              applyAction({ type: 'edit', skuId: fixture.id, quantity: Number(quantity ?? 0) })
                            }
                          />
                        </span>
                        <span>
                          <small>{t('common.assistantSurface.regionalApproval.detail.amount')}</small>
                          <InputNumber
                            min={0}
                            precision={0}
                            value={adjustment.editedAmount}
                            disabled={!canEdit}
                            aria-label={t('common.assistantSurface.regionalApproval.detail.editedAmountFor', {
                              sku: fixture.id.split('-').at(-1),
                            })}
                            onChange={(amount) =>
                              applyAction({ type: 'edit-amount', skuId: fixture.id, amount: Number(amount ?? 0) })
                            }
                          />
                        </span>
                      </div>
                      <Alert
                        className={styles.suggestion}
                        type='info'
                        showIcon
                        content={
                          <div>
                            <strong>{t('common.assistantSurface.regionalApproval.detail.aiSuggestion')}</strong>
                            <Tag color='arcoblue'>
                              {t('common.assistantSurface.regionalApproval.detail.fixtureSource')}
                            </Tag>
                            <p>
                              {t(`common.assistantSurface.regionalApproval.detail.evidence.${fixture.evidenceKey}`, {
                                quantity: adjustment.aiQuantity,
                              })}
                            </p>
                          </div>
                        }
                        action={
                          <div className={styles.suggestionActions}>
                            <Button
                              size='mini'
                              disabled={!canEdit}
                              onClick={() => applyAction({ type: 'accept-suggestion', skuId: fixture.id })}
                            >
                              {t('common.assistantSurface.regionalApproval.detail.accept')}
                            </Button>
                            <Button
                              size='mini'
                              disabled={!canEdit}
                              onClick={() => applyAction({ type: 'ignore-suggestion', skuId: fixture.id })}
                            >
                              {t('common.assistantSurface.regionalApproval.detail.ignore')}
                            </Button>
                            <Button
                              size='mini'
                              disabled={!canEdit}
                              onClick={() => applyAction({ type: 'restore-suggestion', skuId: fixture.id })}
                            >
                              {t('common.assistantSurface.regionalApproval.detail.restore')}
                            </Button>
                            <Tag>
                              {t(
                                `common.assistantSurface.regionalApproval.detail.suggestionState.${adjustment.suggestionDisposition}`
                              )}
                            </Tag>
                          </div>
                        }
                      />
                      <div className={styles.reasonField}>
                        <span>
                          {t(
                            adjustment.reasonRequirement === 'required'
                              ? 'common.assistantSurface.regionalApproval.detail.reasonRequired'
                              : 'common.assistantSurface.regionalApproval.detail.reasonOptional'
                          )}
                        </span>
                        <Input.TextArea
                          value={adjustment.reason}
                          status={reasonInvalid ? 'error' : undefined}
                          autoSize={{ minRows: 1, maxRows: 2 }}
                          disabled={!canEdit}
                          aria-label={t('common.assistantSurface.regionalApproval.detail.reasonFor', {
                            sku: fixture.id.split('-').at(-1),
                          })}
                          onChange={(reason) => applyAction({ type: 'reason', skuId: fixture.id, reason })}
                        />
                      </div>
                    </section>
                  );
                })}
              </div>
            </Tabs.TabPane>
            <Tabs.TabPane key='customers' title={t('common.assistantSurface.regionalApproval.detail.tabs.customers')}>
              <Alert type='info' content={t('common.assistantSurface.regionalApproval.detail.customerEvidence')} />
            </Tabs.TabPane>
            <Tabs.TabPane key='evidence' title={t('common.assistantSurface.regionalApproval.detail.tabs.evidence')}>
              <Alert type='info' content={t('common.assistantSurface.regionalApproval.detail.versionEvidence')} />
            </Tabs.TabPane>
          </Tabs>
        </div>
      </Modal>

      <Modal
        visible={Boolean(pendingTransition)}
        title={t('common.assistantSurface.regionalApproval.detail.unsavedTitle')}
        maskClosable={false}
        closable={false}
        footer={
          <div className={styles.guardActions}>
            <Button onClick={() => pendingTransition && completeTransition(pendingTransition)}>
              {t('common.assistantSurface.regionalApproval.detail.retainAndContinue')}
            </Button>
            <Button status='danger' onClick={discardAndContinue}>
              {t('common.assistantSurface.regionalApproval.detail.discardAndContinue')}
            </Button>
            <Button type='primary' onClick={() => setPendingTransition(undefined)}>
              {t('common.assistantSurface.regionalApproval.detail.cancelTransition')}
            </Button>
          </div>
        }
      >
        <p>{t('common.assistantSurface.regionalApproval.detail.unsavedDescription')}</p>
      </Modal>
    </>
  );
};

export default RegionalApprovalPlanDetail;
