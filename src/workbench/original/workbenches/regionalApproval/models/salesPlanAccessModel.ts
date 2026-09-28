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
import { salesPlanEditableQuantity } from './salesPlanQuantityModel.ts';
import type { ApprovalStageId } from '../regionalApprovalFixture.ts';
export { salesPlanEditableQuantity };

/**
 * 审批身份只看账号角色：GEA 网关解析出的角色编码（或中文名）→ 审批节点。
 * 节点名字在客户端与后端流程里叫法不同（region 后端叫"区域审批"、客户端叫"城市经理审批"），
 * 所以编码优先、名字兜底；角色以外的任何东西（通知、任务）都不参与身份判定。
 */
const NODE_ROLES: readonly [Exclude<ApprovalStageId, 'customer'>, string, string][] = [
  ['region', 'sales_plan_region_approver', '区域审批'],
  ['province', 'sales_plan_province_approver', '省区审批'],
  ['area', 'sales_plan_area_approver', '大区审批'],
  ['category', 'sales_plan_category_approver', '品类审批'],
];

export type SalesPlanApprovalRole = { code?: string | null; name?: string | null };

/** 当前账号能审批哪些节点；只有这几个节点在界面上可点。 */
export const salesPlanStagesForRoles = (
  roles: readonly SalesPlanApprovalRole[] = []
): Exclude<ApprovalStageId, 'customer'>[] =>
  NODE_ROLES.filter(([, code, name]) =>
    roles.some((role) => {
      const roleCode = (role?.code ?? '').trim().toLowerCase();
      const roleName = (role?.name ?? '').trim();
      return (roleCode.length > 0 && roleCode === code) || (roleName.length > 0 && roleName === name);
    })
  ).map(([stage]) => stage);

export type SalesPlanAccess = Omit<GeaSalesPlanActionContext, 'snapshotHash'> & {
  snapshotHash?: string;
  approvalRole: Exclude<ApprovalStageId, 'customer'>;
  roleContractSupported: boolean;
};

/**
 * 版本或状态证据已经变化：这属于并发冲突，必须提示刷新，不能报成"你没有权限"。
 * 只判断证据是否还成立，不判断角色权限，权限缺失仍走无权限分支。
 */
export const salesPlanVersionEvidenceStale = (
  detail: GeaSalesPlanDetail | undefined,
  expected: { planId: string; versionId: string; status: number },
): boolean => {
  const v = detail?.currentVersion;
  if (!v) return true;
  if (v.planId !== expected.planId || v.id !== expected.versionId || v.effective !== true) return true;
  if (v.status !== expected.status || ![1, 2, 3, 4, 6, 7, 8, 9].includes(v.status)) return true;
  const context = detail?.actionContext;
  return Boolean(
    context &&
    (context.versionId !== v.id || context.status !== v.status ||
      !/^[a-f0-9]{64}$/.test(context.snapshotHash) || !Array.isArray(context.allowedActions)),
  );
};

/** 能力结果是 UI 入口的保守投影；审批身份只认账号角色推出的节点，写入时仍由 GEA 校验。 */
export const salesPlanAccessForRow = (
  row: Pick<GeaSalesPlanListItem, 'planId' | 'versionId' | 'status'> & Partial<Pick<GeaSalesPlanListItem, 'planTypeCode'>>,
  detail: GeaSalesPlanDetail,
  grantedStages: readonly ApprovalStageId[] = [],
  stage?: ApprovalStageId,
  workflowRows?: readonly SalesPlanWorkflowRow[],
): SalesPlanAccess | undefined => {
  const v = detail.currentVersion, context = detail.actionContext;
  const typeCode = row.planTypeCode ?? v.planTypeCode;
  const flow = salesPlanWorkflow(typeCode, workflowRows);
  if (v.id !== row.versionId || v.planId !== row.planId || !v.effective || v.status !== row.status ||
      ![1,2,3,4,6,7,8,9].includes(row.status) ||
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
  // 审批身份只来自账号角色：角色决定能进哪些节点，数据权限决定明细，
  // 只要这一行出现在表里就允许提交/退回，最终由 GEA 写接口按组织、角色、版本、状态和快照校验。
  const roles = [...new Set(grantedStages)].filter(role => role !== 'customer');
  // 多角色用户必须在动作对话框中明确选择角色。
  const role = stage ?? (roles.length === 1 ? roles[0] : undefined);
  if (!role || role === 'customer' || !roles.includes(role)) return undefined;
  const roleEntry = supported ? context.roleActions!.find(entry => entry.role === role) : undefined;
  const nodeOrder = SALES_PLAN_ROLES.indexOf(role) + 1;
  // 账号权限决定能否审批；服务端对象能力只能补充动作，不能撤销已有权限。
  // GEA 写接口仍会按组织、角色、版本、状态和快照重新校验，客户端这里只负责准确投影入口。
  const grantedRoleActions = ['APPROVE', 'REJECT'] as const;
  const allowedActions = supported ? [...new Set([...grantedRoleActions, ...(roleEntry?.allowedActions ?? [])])] :
    context && (context.nodeOrder === nodeOrder || context.allowedActions.length === 0) ? context.allowedActions : ['APPROVE', 'REJECT'] as const;
  return {
    versionId: v.id, status: v.status, nodeOrder, approvalRole: role,
    allowedActions: [...allowedActions].filter(action => action !== 'REJECT' || flow.pending(role) !== undefined),
    ...(context?.snapshotHash ? {snapshotHash: context.snapshotHash} : {}),
    roleContractSupported: supported,
  };
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
