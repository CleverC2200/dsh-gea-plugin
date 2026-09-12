/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import { salesPlanWorkflow } from '../../../salesPlanWorkflow.ts';
import type {
  GeaSalesPlanActionContext,
  GeaSalesPlanActionReceipt,
  GeaSalesPlanActionRequest,
  GeaSalesPlanDetail,
  GeaSalesPlanListItem,
  GeaSalesPlanSku,
} from '../../../bridge.ts';
import { addExactDecimals, multiplyExactDecimals } from '../regionalApprovalQueryModel.ts';
import { salesPlanSkusMatchVersion } from './salesPlanDetailModel.ts';
import { salesPlanActionTargetStatus, salesPlanApprovalNodeForStatus } from './salesPlanActionModel.ts';
import type { ApprovalStageId } from '../regionalApprovalFixture.ts';

const NODE_PERMISSIONS: readonly [ApprovalStageId, string][] = [
  ['customer', 'sales-confirm'],
  ['region', 'region-approve'],
  ['province', 'province-approve'],
  ['area', 'area-approve'],
  ['category', 'category-approve'],
];

/** Authenticated node permissions choose UI entry points; GEA validates each write. */
export const salesPlanStagesForPermissions = (permissions: readonly string[] = []): ApprovalStageId[] =>
  NODE_PERMISSIONS.filter(([, permission]) => permissions.includes(`sales-plan:plan:${permission}`)).map(
    ([stage]) => stage
  );

export type SalesPlanAccess = Omit<GeaSalesPlanActionContext, 'snapshotHash'> & { snapshotHash?: string };

/** Prefer object capabilities. Older GEA details omit them and enforce candidates on POST. */
export const salesPlanAccessForRow = (
  row: Pick<GeaSalesPlanListItem, 'planId' | 'versionId' | 'status'> &
    Partial<Pick<GeaSalesPlanListItem, 'planTypeCode'>>,
  detail: GeaSalesPlanDetail,
  permissions: readonly string[] = [],
  stage?: ApprovalStageId
): SalesPlanAccess | undefined => {
  const context = detail.actionContext;
  const typeCode = row.planTypeCode ?? detail.currentVersion.planTypeCode;
  const actor = salesPlanWorkflow(typeCode).actor(row.status);
  if (stage && row.status !== 10 && actor !== stage) return undefined;
  if (
    detail.currentVersion.id !== row.versionId ||
    detail.currentVersion.planId !== row.planId ||
    !detail.currentVersion.effective ||
    detail.currentVersion.status !== row.status
  )
    return undefined;
  if (!context && detail.workflowApproval?.actionable === true &&
      detail.workflowApproval.versionId === row.versionId && actor && actor !== 'customer' &&
      salesPlanActionTargetStatus('APPROVE', row.status, typeCode) !== undefined) {
    return {
      versionId: row.versionId, status: row.status,
      nodeOrder: NODE_PERMISSIONS.findIndex(([id]) => id === actor) + 1,
      allowedActions: ['APPROVE', 'REJECT'],
    };
  }
  if (!context) {
    if (!stage || !salesPlanStagesForPermissions(permissions).includes(stage) || !actor || actor === 'customer')
      return undefined;
    return {
      versionId: row.versionId,
      status: row.status,
      nodeOrder: NODE_PERMISSIONS.findIndex(([id]) => id === stage) + 1,
      allowedActions: ['APPROVE', 'REJECT'],
    };
  }
  if (
    context.versionId !== row.versionId ||
    context.status !== row.status ||
    !/^[a-f0-9]{64}$/.test(context.snapshotHash) ||
    !Array.isArray(context.allowedActions) ||
    context.allowedActions.some(
      (action) =>
        !['SAVE', 'APPROVE', 'REJECT'].includes(action) ||
        salesPlanActionTargetStatus(action, row.status, typeCode) === undefined
    )
  )
    return undefined;
  const node = row.status === 10 ? 5 : salesPlanApprovalNodeForStatus(row.status, typeCode);
  if (context.allowedActions.length && context.nodeOrder !== node) return undefined;
  return context;
};

/** A saved node remains the baseline for the next edit and subsequent approval. */
export const salesPlanEditableQuantity = (sku: GeaSalesPlanSku, status: number, typeCode = 'Y'): string | undefined => {
  const fields = {
    customer: 'qty',
    region: 'regionConfirmedQty',
    province: 'provinceConfirmedQty',
    area: 'areaConfirmedQty',
    category: 'categoryConfirmedQty',
  } as const;
  for (const role of salesPlanWorkflow(typeCode).confirmationRoles(status)) {
    const value = sku[fields[role]];
    if (value !== null && value !== undefined) return String(value);
  }
  return undefined;
};

/** A successful write receipt is followed by a same-version read, including its audit log. */
export const verifySavedSalesPlan = (
  before: GeaSalesPlanDetail,
  after: GeaSalesPlanDetail,
  request: GeaSalesPlanActionRequest,
  receipt: GeaSalesPlanActionReceipt
): boolean => {
  const version = before.currentVersion;
  if (
    request.action !== 'SAVE' ||
    receipt.planId !== version.planId ||
    receipt.versionId !== version.id ||
    receipt.fromStatus !== version.status ||
    receipt.toStatus !== version.status ||
    after.currentVersion.id !== version.id ||
    after.currentVersion.planId !== version.planId ||
    after.currentVersion.status !== version.status ||
    !after.currentVersion.effective ||
    !salesPlanSkusMatchVersion(version.id, after.skus) ||
    before.skus.length !== after.skus.length ||
    !after.logs.some(
      (log) =>
        `sales-plan-log:${log.id}` === receipt.auditId &&
        log.planId === version.planId &&
        log.requestId === receipt.requestId &&
        log.traceId === receipt.traceId &&
        log.actionCode === 'SAVE' &&
        log.versionId === version.id &&
        log.fromStatus === version.status &&
        log.toStatus === version.status
    )
  )
    return false;
  const deltas = new Map((request.adjustments ?? []).map((item) => [String(item.skuCode), String(item.adjustQty)]));
  return before.skus.every((sku) => {
    const code = String(sku.skuCode);
    const saved = after.skus.find((item) => String(item.skuCode) === code);
    const baseline = salesPlanEditableQuantity(sku, version.status, version.planTypeCode);
    const actual = saved && salesPlanEditableQuantity(saved, version.status, version.planTypeCode);
    if (baseline === undefined || actual === undefined) return false;
    const expected = addExactDecimals([baseline, deltas.get(code) ?? '0']);
    const node = version.status === 10 ? 5 : salesPlanApprovalNodeForStatus(version.status, version.planTypeCode);
    const amount =
      node === 5
        ? saved?.categoryConfirmedAmount
        : node === 4
          ? saved?.areaConfirmedAmount
          : node === 3
            ? saved?.provinceConfirmedAmount
            : saved?.regionConfirmedAmount;
    const expectedAmount = multiplyExactDecimals(expected, String(sku.price));
    const equal = (left: unknown, right: string) => /^0(?:\.0+)?$/.test(addExactDecimals([String(left), `-${right}`]));
    return (
      expected !== '—' &&
      expectedAmount !== undefined &&
      equal(actual, expected) &&
      equal(saved?.price, String(sku.price)) &&
      equal(amount, expectedAmount)
    );
  });
};
