import { SALES_PLAN_ROLES, salesPlanWorkflow } from '../../../salesPlanWorkflow.ts';
import type { GeaSalesPlanSku } from '../../../bridge.ts';
import type { ApprovalStageId } from '../regionalApprovalFixture.ts';

/** 已保存节点仍是下一次编辑和后续审批的基线。 */
export const salesPlanEditableQuantity = (
  sku: GeaSalesPlanSku, status: number, typeCode = 'Y', role?: ApprovalStageId,
): string | undefined => {
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
  for (const candidate of roles) {
    const value = sku[fields[candidate]];
    if (value !== null && value !== undefined) return String(value);
  }
  return undefined;
};
