/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import { metricsForApprovalVersion } from './regionalApprovalModel.ts';
import type { ApprovalVersion, RegionalApprovalRow } from './regionalApprovalFixture.ts';

export type ApprovalReasonRequirement = 'required' | 'optional';

export type RegionalApprovalSkuFixture = {
  id: string;
  productKey: 'dumpling' | 'wonton' | 'rice-ball';
  unitPrice: number;
  initialQuantity: number;
  aiQuantity: number;
  reasonRequirement: ApprovalReasonRequirement;
  evidenceKey: 'seasonal' | 'inventory' | 'policy';
};

const SKU_CATALOG = [
  {
    id: 'FSKU001',
    productKey: 'dumpling',
    unitPrice: 78,
    weight: 0.46,
    aiDelta: 0.08,
    reasonRequirement: 'required',
    evidenceKey: 'seasonal',
  },
  {
    id: 'FSKU002',
    productKey: 'wonton',
    unitPrice: 69,
    weight: 0.32,
    aiDelta: -0.04,
    reasonRequirement: 'optional',
    evidenceKey: 'inventory',
  },
  {
    id: 'FSKU003',
    productKey: 'rice-ball',
    unitPrice: 54,
    weight: 0.22,
    aiDelta: 0.24,
    reasonRequirement: 'required',
    evidenceKey: 'policy',
  },
] as const;

export const regionalApprovalSkuFixtures = (
  row: RegionalApprovalRow,
  version: ApprovalVersion
): RegionalApprovalSkuFixture[] => {
  const total = metricsForApprovalVersion(row, version).quantity;
  let allocated = 0;
  return SKU_CATALOG.map((sku, index) => {
    const initialQuantity = index === SKU_CATALOG.length - 1 ? total - allocated : Math.round(total * sku.weight);
    allocated += initialQuantity;
    return {
      id: `${row.id}-${sku.id}`,
      productKey: sku.productKey,
      unitPrice: sku.unitPrice,
      initialQuantity,
      aiQuantity: Math.max(0, Math.round(initialQuantity * (1 + sku.aiDelta))),
      reasonRequirement: sku.reasonRequirement,
      evidenceKey: sku.evidenceKey,
    };
  });
};
