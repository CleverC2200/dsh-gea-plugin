/** 改编自 AionUi（Apache-2.0）：已替换为本地导入并使用显式 DSH Host 适配器，见 SOURCE.md。 */
import { SALES_PLAN_ROLES, salesPlanWorkflow, type SalesPlanWorkflowRow } from '../../../salesPlanWorkflow.ts';
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
import { salesPlanApprovalNodeForStatus } from './salesPlanActionModel.ts';
import type { ApprovalStageId } from '../regionalApprovalFixture.ts';

const NODE_PERMISSIONS: readonly [ApprovalStageId, string][] = [
  ['customer', 'sales-confirm'],
  ['region', 'region-approve'],
  ['province', 'province-approve'],
  ['area', 'area-approve'],
  ['category', 'category-approve'],
];

/** 已认证的节点权限只决定 UI 入口；每次写入仍由 GEA 校验。 */
export const salesPlanStagesForPermissions = (permissions: readonly string[] = []): ApprovalStageId[] =>
  NODE_PERMISSIONS.filter(([, permission]) => permissions.includes(`sales-plan:plan:${permission}`)).map(
    ([stage]) => stage
  );

export type SalesPlanAccess = Omit<GeaSalesPlanActionContext, 'snapshotHash'> & {
  snapshotHash?: string;
  approvalRole: Exclude<ApprovalStageId, 'customer'>;
  roleContractSupported: boolean;
};

/** 能力结果是 UI 入口的保守投影；普通通知不会授予权限，只有 Host 刷新的同版本可处理任务可证明当前节点，写入时仍由 GEA 校验。 */
export const salesPlanAccessForRow = (
  row: Pick<GeaSalesPlanListItem, 'planId' | 'versionId' | 'status'> & Partial<Pick<GeaSalesPlanListItem, 'planTypeCode'>>,
  detail: GeaSalesPlanDetail,
  permissions: readonly string[] = [],
  stage?: ApprovalStageId,
  workflowRows?: readonly SalesPlanWorkflowRow[],
  options: { allowReturned?: boolean } = {},
): SalesPlanAccess | undefined => {
  const v = detail.currentVersion, context = detail.actionContext;
  const typeCode = row.planTypeCode ?? v.planTypeCode;
  const flow = salesPlanWorkflow(typeCode, workflowRows);
  if (v.id !== row.versionId || v.planId !== row.planId || !v.effective || v.status !== row.status ||
      ![1,2,3,4,6,7,8,9].includes(row.status) ||
      (!options.allowReturned && row.status >= 6 && row.status <= 9) ||
      (row.planTypeCode !== undefined && row.planTypeCode !== v.planTypeCode)) return undefined;
  const supported = context?.policy === 'role-visible-v1';
  if (context && (context.versionId !== v.id || context.status !== v.status ||
      !/^[a-f0-9]{64}$/.test(context.snapshotHash) || !Array.isArray(context.allowedActions))) return undefined;
  const knownActions = (actions: readonly string[]) => actions.every(a => ['SAVE','APPROVE','REJECT'].includes(a));
  if (context && !knownActions(context.allowedActions)) return undefined;
  if (supported && (!Array.isArray(context.roleActions) || context.roleActions.some(entry =>
      !entry || !['region','province','area','category'].includes(entry.role) ||
      !Array.isArray(entry.allowedActions) || !knownActions(entry.allowedActions)) ||
      new Set(context.roleActions.map(entry => entry.role)).size !== context.roleActions.length)) return undefined;
  const granted = salesPlanStagesForPermissions(permissions).filter(role => role !== 'customer');
  // 已认证对象能力，或 Host 对同版本重新确认的可处理任务，才能证明角色。
  // 后者只映射到当前状态的节点，不能用来处理其他节点或旧版本。
  const workflowRole = detail.workflowApproval?.versionId === v.id && detail.workflowApproval.actionable === true
    ? flow.actor(row.status) : undefined;
  const capabilityRoles = supported ? context.roleActions!.filter(entry => entry.allowedActions.length).map(entry => entry.role) :
    context?.allowedActions.length && context.nodeOrder != null && context.nodeOrder >= 2 && context.nodeOrder <= 5
      ? [SALES_PLAN_ROLES[context.nodeOrder - 1]] : [];
  const roles = [...new Set([...granted, ...capabilityRoles, ...(workflowRole && workflowRole !== 'customer' ? [workflowRole] : [])])].filter(role => role !== 'customer');
  if (!roles.some(role => flow.visibility(row.status, role) !== 'denied')) return undefined;
  // 多角色用户必须在动作对话框中明确选择角色。
  const role = stage ?? (roles.length === 1 ? roles[0] : undefined);
  if (!role || role === 'customer' || !roles.includes(role)) return undefined;
  const roleEntry = supported ? context.roleActions!.find(entry => entry.role === role) : undefined;
  const nodeOrder = SALES_PLAN_ROLES.indexOf(role) + 1;
  // 角色权限决定能否审批；对象能力可补充动作，但不能把“当前未通知该角色”误当成撤销角色权限。
  // GEA 写接口仍会按组织、角色、版本、状态和快照重新校验，客户端这里只负责准确投影入口。
  const grantedRoleActions = granted.includes(role) ? ['APPROVE', 'REJECT'] as const : [];
  const allowedActions = supported ? [...new Set([...grantedRoleActions, ...(roleEntry?.allowedActions ?? [])])] :
    context && (context.nodeOrder === nodeOrder || context.allowedActions.length === 0) ? context.allowedActions : ['APPROVE', 'REJECT'] as const;
  return {
    versionId: v.id, status: v.status, nodeOrder, approvalRole: role,
    allowedActions: [...allowedActions].filter(action => action !== 'REJECT' || flow.pending(role) !== undefined),
    ...(context?.snapshotHash ? {snapshotHash: context.snapshotHash} : {}),
    roleContractSupported: supported,
  };
};

/** 已保存节点仍是下一次编辑和后续审批的基线。 */
export const salesPlanEditableQuantity = (sku: GeaSalesPlanSku, status: number, typeCode = 'Y', role?: ApprovalStageId): string | undefined => {
  const fields = {
    customer: 'qty',
    region: 'regionConfirmedQty',
    province: 'provinceConfirmedQty',
    area: 'areaConfirmedQty',
    category: 'categoryConfirmedQty',
  } as const;
  const flow = salesPlanWorkflow(typeCode);
  const roles = role ? SALES_PLAN_ROLES.slice(0, SALES_PLAN_ROLES.indexOf(role) + 1).toReversed()
    .filter(r => r === role || flow.pending(r) !== undefined) : flow.confirmationRoles(status);
  for (const role of roles) {
    const value = sku[fields[role]];
    if (value !== null && value !== undefined) return String(value);
  }
  return undefined;
};

/** 写入成功回执之后必须读取同一版本，并包含对应审计日志。 */
export const verifySavedSalesPlan = (
  before: GeaSalesPlanDetail,
  after: GeaSalesPlanDetail,
  request: GeaSalesPlanActionRequest,
  receipt: GeaSalesPlanActionReceipt
): boolean => {
  const version = before.currentVersion;
  if (
    request.action !== 'SAVE' ||
    request.expectedStatus !== version.status ||
    !version.effective ||
    !salesPlanSkusMatchVersion(version.id, before.skus) ||
    receipt.planId !== version.planId ||
    receipt.versionId !== version.id ||
    receipt.fromStatus !== version.status ||
    receipt.toStatus !== version.status ||
    after.currentVersion.id !== version.id ||
    after.currentVersion.planId !== version.planId ||
    after.currentVersion.status !== version.status ||
    after.currentVersion.seq !== version.seq ||
    after.currentVersion.planTypeCode !== version.planTypeCode ||
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
  const sourceCodes = new Set(before.skus.map(sku => String(sku.skuCode)));
  if (deltas.size !== request.adjustments?.length || [...deltas.keys()].some(code => !sourceCodes.has(code))) return false;
  return before.skus.every((sku) => {
    const code = String(sku.skuCode);
    const saved = after.skus.find((item) => String(item.skuCode) === code);
    const baseline = salesPlanEditableQuantity(sku, version.status, version.planTypeCode, request.approvalRole);
    const actual = saved && salesPlanEditableQuantity(saved, version.status, version.planTypeCode, request.approvalRole);
    if (baseline === undefined || actual === undefined) return false;
    const expected = addExactDecimals([baseline, deltas.get(code) ?? '0']);
    const node = request.approvalRole ? SALES_PLAN_ROLES.indexOf(request.approvalRole) + 1 : salesPlanApprovalNodeForStatus(version.status, version.planTypeCode);
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
