/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import type {
  GeaSalesPlanApprovalLog,
  GeaSalesPlanDetail,
  GeaSalesPlanSku,
  GeaSalesPlanSkuDiff,
  GeaSalesPlanVersion,
} from '../../../bridge.ts';
import type { ApprovalStageId } from '../regionalApprovalFixture.ts';
import { subtractExactDecimals } from '../regionalApprovalQueryModel.ts';

export type SalesPlanSkuNodeComparison = {
  previousQty: string;
  previousAmount: string;
  currentQty: string;
  currentAmount: string;
  qtyDelta: string;
  amountDelta: string;
};

const decimalText = (value: unknown, fallback = '0'): string =>
  typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback;

const confirmedAt = (sku: GeaSalesPlanSku, stage: ApprovalStageId): { qty?: unknown; amount?: unknown } => {
  if (stage === 'region') return { qty: sku.regionConfirmedQty, amount: sku.regionConfirmedAmount };
  if (stage === 'province') return { qty: sku.provinceConfirmedQty, amount: sku.provinceConfirmedAmount };
  if (stage === 'area') return { qty: sku.areaConfirmedQty, amount: sku.areaConfirmedAmount };
  if (stage === 'category') return { qty: sku.categoryConfirmedQty, amount: sku.categoryConfirmedAmount };
  return { qty: sku.qty, amount: sku.amt };
};

const previousStages: Record<ApprovalStageId, readonly ApprovalStageId[]> = {
  customer: [],
  region: ['customer'],
  province: ['region', 'customer'],
  area: ['province', 'region', 'customer'],
  category: ['area', 'province', 'region', 'customer'],
};

export const salesPlanSkuNodeComparison = (
  sku: GeaSalesPlanSku,
  stage: ApprovalStageId
): SalesPlanSkuNodeComparison => {
  const previous = previousStages[stage]
    .map((candidate) => confirmedAt(sku, candidate))
    .find((value) => value.qty != null && value.amount != null) ?? { qty: sku.qty, amount: sku.amt };
  const current = confirmedAt(sku, stage);
  const previousQty = decimalText(previous.qty, decimalText(sku.qty));
  const previousAmount = decimalText(previous.amount, decimalText(sku.amt));
  const currentQty = decimalText(current.qty, previousQty);
  const currentAmount = decimalText(current.amount, previousAmount);
  return {
    previousQty,
    previousAmount,
    currentQty,
    currentAmount,
    qtyDelta: subtractExactDecimals(currentQty, previousQty),
    amountDelta: subtractExactDecimals(currentAmount, previousAmount),
  };
};

export const salesPlanOverviewMatches = (
  planId: string,
  initialVersionId: string,
  detail: GeaSalesPlanDetail,
  versions: readonly GeaSalesPlanVersion[],
  logs: readonly GeaSalesPlanApprovalLog[]
): boolean =>
  detail.currentVersion.planId === planId &&
  detail.currentVersion.id === initialVersionId &&
  versions.length > 0 &&
  versions.every((version) => version.planId === planId) &&
  versions.some((version) => version.id === initialVersionId) &&
  logs.every((log) => log.planId === planId && versions.some((version) => version.id === log.versionId));

export const salesPlanSkusMatchVersion = (versionId: string, skus: readonly GeaSalesPlanSku[]): boolean =>
  skus.every((sku) => sku.versionId === versionId);

export const salesPlanComparisonMatches = (
  fromVersionId: string,
  toVersionId: string,
  differences: readonly GeaSalesPlanSkuDiff[]
): boolean =>
  differences.every((difference) => {
    const beforeMatches =
      !difference.before ||
      (difference.before.versionId === fromVersionId && difference.before.skuCode === difference.skuCode);
    const afterMatches =
      !difference.after ||
      (difference.after.versionId === toVersionId && difference.after.skuCode === difference.skuCode);
    const shapeMatches =
      (difference.changeType === 'ADDED' && !difference.before && !!difference.after) ||
      (difference.changeType === 'DELETED' && !!difference.before && !difference.after) ||
      (difference.changeType === 'UPDATED' && !!difference.before && !!difference.after);
    return beforeMatches && afterMatches && shapeMatches;
  });
