/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import type { GeaSalesPlanSku } from '../../../bridge.ts';
import type { ApprovalDimension } from '../regionalApprovalFixture.ts';
import { addExactDecimals, subtractExactDecimals, type RegionalApprovalLiveRow } from '../regionalApprovalQueryModel.ts';

export type SalesPlanAdjustmentRecord = {
  recordId: string;
  plan: RegionalApprovalLiveRow;
  sku: GeaSalesPlanSku;
  qty: string;
  amount: string;
};

export type SalesPlanAdjustmentGroup = {
  id: string;
  dimensionName: string;
  skuCode: string;
  categoryName: string;
  materialDescription?: string;
  records: SalesPlanAdjustmentRecord[];
  baseQty: string;
  qty: string;
  baseAmount: string;
  amount: string;
  quantityDelta: string;
  amountDelta: string;
  price: string;
};

export type SalesPlanAdjustmentDraft = {
  versionId: string;
  skuCode: string;
  sourceQty: string;
  sourceAmount: string;
  qty: string;
  amount: string;
};

const DIMENSION_ORDER: readonly ApprovalDimension[] = ['base', 'area', 'province', 'region', 'customer'];

export const adjustmentDimensionsFrom = (dimension: ApprovalDimension): ApprovalDimension[] =>
  DIMENSION_ORDER.slice(Math.max(0, DIMENSION_ORDER.indexOf(dimension)));

export const adjustmentDimensionName = (row: RegionalApprovalLiveRow, dimension: ApprovalDimension): string => {
  if (dimension === 'area') return row.areaName?.trim() || row.regionName?.trim() || '';
  if (dimension === 'province') return row.provinceName?.trim() || row.provinceRegionName?.trim() || '';
  if (dimension === 'region') return row.orgName?.trim() || row.salesGroupName?.trim() || '';
  if (dimension === 'base') return row.baseName?.trim() || '';
  return row.dealerName?.trim() || '';
};

export const adjustmentDimensionKey = (row: RegionalApprovalLiveRow, dimension: ApprovalDimension): string => {
  if (dimension === 'area') return row.areaCode?.trim() || adjustmentDimensionName(row, dimension);
  if (dimension === 'province') return row.provinceCode?.trim() || adjustmentDimensionName(row, dimension);
  if (dimension === 'region') return row.orgCode?.trim() || adjustmentDimensionName(row, dimension);
  if (dimension === 'base') return row.baseName?.trim() || adjustmentDimensionName(row, dimension);
  return row.dealerCode.trim();
};

export const adjustmentScopeRows = (
  rows: readonly RegionalApprovalLiveRow[],
  selected: RegionalApprovalLiveRow,
  dimension: ApprovalDimension
): RegionalApprovalLiveRow[] => {
  const selectedKey = adjustmentDimensionKey(selected, dimension);
  return rows.filter((row) => adjustmentDimensionKey(row, dimension) === selectedKey);
};

export const createSalesPlanAdjustmentRecords = (
  entries: readonly { plan: RegionalApprovalLiveRow; skus: readonly GeaSalesPlanSku[] }[]
): SalesPlanAdjustmentRecord[] =>
  entries.flatMap(({ plan, skus }) =>
    skus.map((sku) => ({
      recordId: `${plan.versionId}:${String(sku.skuCode)}`,
      plan,
      sku,
      qty: String(sku.qty),
      amount: String(sku.amt),
    }))
  );

export const groupSalesPlanAdjustmentRecords = (
  records: readonly SalesPlanAdjustmentRecord[],
  dimension: ApprovalDimension
): SalesPlanAdjustmentGroup[] => {
  const grouped = new Map<string, SalesPlanAdjustmentRecord[]>();
  records.forEach((record) => {
    const dimensionKey = adjustmentDimensionKey(record.plan, dimension);
    const key = `${dimensionKey}\u0000${String(record.sku.skuCode)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  });
  return [...grouped.entries()].map(([id, items]) => {
    const baseQty = addExactDecimals(items.map((item) => String(item.sku.baseQty)));
    const qty = addExactDecimals(items.map((item) => item.qty));
    const baseAmount = addExactDecimals(items.map((item) => String(item.sku.amtBase)));
    const amount = addExactDecimals(items.map((item) => item.amount));
    return {
      id,
      dimensionName: adjustmentDimensionName(items[0].plan, dimension),
      skuCode: String(items[0].sku.skuCode),
      categoryName: items[0].sku.productCategName,
      materialDescription:
        [...new Set(items.map((item) => item.sku.materialDescription?.trim()).filter(Boolean))].join(' / ') ||
        undefined,
      records: items,
      baseQty,
      qty,
      baseAmount,
      amount,
      quantityDelta: subtractExactDecimals(qty, baseQty),
      amountDelta: subtractExactDecimals(amount, baseAmount),
      price: String(items[0].sku.price),
    };
  });
};

const rounded = (value: number) => String(Math.round(value));

/**
 * The frozen business rule: allocate by each customer's original base share,
 * round every row except the last, then put the exact remainder on the last row.
 */
export const distributeAggregateQuantity = (
  records: readonly SalesPlanAdjustmentRecord[],
  desiredQuantity: number
): SalesPlanAdjustmentRecord[] => {
  if (!Number.isFinite(desiredQuantity) || desiredQuantity < 0 || records.length === 0) return [...records];
  const totalBase = records.reduce((sum, record) => sum + Number(record.sku.baseQty), 0);
  const price = Number(records[0].sku.price);
  if (!Number.isFinite(totalBase) || totalBase <= 0 || !Number.isFinite(price)) return [...records];

  let allocated = 0;
  return records.map((record, index) => {
    const quantity =
      index === records.length - 1
        ? desiredQuantity - allocated
        : Math.round(desiredQuantity * (Number(record.sku.baseQty) / totalBase));
    allocated += quantity;
    return { ...record, qty: rounded(quantity), amount: rounded(quantity * price) };
  });
};

export const updateAggregateQuantity = (
  records: readonly SalesPlanAdjustmentRecord[],
  group: SalesPlanAdjustmentGroup,
  desiredQuantity: number
): SalesPlanAdjustmentRecord[] => {
  const updated = new Map(
    distributeAggregateQuantity(group.records, desiredQuantity).map((record) => [record.recordId, record])
  );
  return records.map((record) => updated.get(record.recordId) ?? record);
};

export const updateAggregateAmount = (
  records: readonly SalesPlanAdjustmentRecord[],
  group: SalesPlanAdjustmentGroup,
  desiredAmount: number
): SalesPlanAdjustmentRecord[] => {
  const price = Number(group.price);
  if (!Number.isFinite(desiredAmount) || desiredAmount < 0 || !Number.isFinite(price) || price <= 0)
    return [...records];
  return updateAggregateQuantity(records, group, Math.round(desiredAmount / price));
};

export const updateCustomerQuantity = (
  records: readonly SalesPlanAdjustmentRecord[],
  group: SalesPlanAdjustmentGroup,
  desiredQuantity: number
): SalesPlanAdjustmentRecord[] => {
  const record = group.records[0];
  const price = Number(record?.sku.price);
  if (!record || !Number.isFinite(desiredQuantity) || desiredQuantity < 0 || !Number.isFinite(price))
    return [...records];
  return records.map((candidate) =>
    candidate.recordId === record.recordId
      ? { ...candidate, qty: rounded(desiredQuantity), amount: rounded(desiredQuantity * price) }
      : candidate
  );
};

export const updateCustomerAmount = (
  records: readonly SalesPlanAdjustmentRecord[],
  group: SalesPlanAdjustmentGroup,
  desiredAmount: number
): SalesPlanAdjustmentRecord[] => {
  const price = Number(group.price);
  if (!Number.isFinite(desiredAmount) || desiredAmount < 0 || !Number.isFinite(price) || price <= 0)
    return [...records];
  return updateCustomerQuantity(records, group, Math.round(desiredAmount / price));
};

export const adjustmentRecordDraft = (record: SalesPlanAdjustmentRecord): SalesPlanAdjustmentDraft => ({
  versionId: record.plan.versionId,
  skuCode: String(record.sku.skuCode),
  sourceQty: String(record.sku.qty),
  sourceAmount: String(record.sku.amt),
  qty: record.qty,
  amount: record.amount,
});
