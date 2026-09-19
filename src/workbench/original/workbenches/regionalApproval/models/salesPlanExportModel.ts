/** 改编自 AionUi（Apache-2.0）：已替换为本地导入并使用显式 DSH Host 适配器，见 SOURCE.md。 */
import type { GeaSalesPlanListItem, GeaSalesPlanSku } from '../../../bridge.ts';
import { addExactDecimals } from '../regionalApprovalQueryModel.ts';

export const SALES_PLAN_EXPORT_AMOUNT_PAIRS = [
  ['qty', 'amt'],
  ['regionConfirmedQty', 'regionConfirmedAmount'],
  ['provinceConfirmedQty', 'provinceConfirmedAmount'],
  ['areaConfirmedQty', 'areaConfirmedAmount'],
  ['categoryConfirmedQty', 'categoryConfirmedAmount'],
] as const;

type AmountField = (typeof SALES_PLAN_EXPORT_AMOUNT_PAIRS)[number][number];
export type SalesPlanExportAmounts = Record<AmountField, string | null>;

/** 导出每个节点自身的值，绝不从其他审批节点回填。 */
export const aggregateSalesPlanExportAmounts = (
  row: Pick<GeaSalesPlanListItem, 'versionId' | 'skuCount'>,
  skus: readonly GeaSalesPlanSku[]
): SalesPlanExportAmounts => {
  if (
    !Number.isSafeInteger(row.skuCount) ||
    row.skuCount < 0 ||
    skus.length !== row.skuCount ||
    skus.some((sku) => sku.versionId !== row.versionId || !sku.id?.trim() || !sku.skuCode?.trim()) ||
    new Set(skus.map((sku) => sku.id)).size !== skus.length ||
    new Set(skus.map((sku) => sku.skuCode)).size !== skus.length
  ) {
    throw new Error('Incomplete or mismatched sales-plan export SKUs');
  }
  const totals = {} as SalesPlanExportAmounts;
  for (const [quantity, amount] of SALES_PLAN_EXPORT_AMOUNT_PAIRS) {
    if (quantity !== 'qty' && skus.every((sku) => sku[quantity] == null && sku[amount] == null)) {
      totals[quantity] = null;
      totals[amount] = null;
      continue;
    }
    if (
      skus.some((sku) =>
        [quantity, amount].some((field) => typeof sku[field] !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(sku[field]))
      )
    ) {
      throw new Error('Incomplete or invalid sales-plan node amounts');
    }
    totals[quantity] = addExactDecimals(skus.map((sku) => sku[quantity]!));
    totals[amount] = addExactDecimals(skus.map((sku) => sku[amount]!));
  }
  return totals;
};
