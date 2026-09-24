import type { GeaSalesPlanSku } from '../../../bridge.ts';
import type { ApprovalStageId } from '../regionalApprovalFixture.ts';
import type { RegionalApprovalLiveRow } from '../regionalApprovalQueryModel.ts';
import { addExactDecimals, multiplyExactDecimals } from '../regionalApprovalQueryModel.ts';
import { salesPlanEditableQuantity } from './salesPlanQuantityModel.ts';

type GroupSkuSource = {
  plan: RegionalApprovalLiveRow;
  skus: readonly GeaSalesPlanSku[];
};

export type GroupSkuSummaryRow = {
  skuCode: string;
  categoryName: string;
  description: string;
  baseQty: string;
  qty: string;
  baseAmount: string;
  amount: string;
};

const decimal = (value: string) => /^\d+(?:\.\d+)?$/.test(value);

/** 只有每个版本的 SKU 都完整时才汇总，金额按各计划自己的价格逐行计算后相加。 */
export const summarizeGroupSkus = (
  sources: readonly GroupSkuSource[],
  approvalRole?: ApprovalStageId,
  pendingValues: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
): GroupSkuSummaryRow[] => {
  const grouped = new Map<string, {
    categories: Set<string>;
    descriptions: Set<string>;
    baseQty: string[];
    qty: string[];
    baseAmount: string[];
    amount: string[];
  }>();
  for (const { plan, skus } of sources) {
    if (skus.length !== plan.skuCount || skus.some((sku) => sku.versionId !== plan.versionId))
      throw new Error('INCOMPLETE_GROUP_SKUS');
    const codes = new Set<string>();
    for (const sku of skus) {
      const code = String(sku.skuCode).trim();
      if (!code || codes.has(code)) throw new Error('INCOMPLETE_GROUP_SKUS');
      codes.add(code);
      const qty = pendingValues[plan.planId]?.[code] ??
        salesPlanEditableQuantity(sku, plan.status, plan.planTypeCode, approvalRole) ?? String(sku.qty);
      const baseQty = String(sku.baseQty);
      const baseAmount = String(sku.amtBase);
      const amount = multiplyExactDecimals(qty, String(sku.price));
      if (![qty, baseQty, baseAmount].every(decimal) || amount === undefined)
        throw new Error('INCOMPLETE_GROUP_SKUS');
      const item = grouped.get(code) ?? {
        categories: new Set<string>(), descriptions: new Set<string>(),
        baseQty: [], qty: [], baseAmount: [], amount: [],
      };
      item.categories.add(sku.productCategName.trim() || '其他');
      const description = sku.materialDescription?.trim() || sku.skuName?.trim();
      if (description) item.descriptions.add(description);
      item.baseQty.push(baseQty);
      item.qty.push(qty);
      item.baseAmount.push(baseAmount);
      item.amount.push(amount);
      grouped.set(code, item);
    }
  }
  return [...grouped].map(([skuCode, item]) => ({
    skuCode,
    categoryName: [...item.categories].join(' / '),
    description: [...item.descriptions].join(' / '),
    baseQty: addExactDecimals(item.baseQty),
    qty: addExactDecimals(item.qty),
    baseAmount: addExactDecimals(item.baseAmount),
    amount: addExactDecimals(item.amount),
  })).toSorted((left, right) =>
    left.categoryName.localeCompare(right.categoryName, 'zh-CN') || left.skuCode.localeCompare(right.skuCode));
};
