/** 改编自 AionUi（Apache-2.0）：已替换为本地导入并使用显式 DSH Host 适配器，见 SOURCE.md。 */
import type { GeaSalesPlanDetail, GeaSalesPlanListItem, GeaSalesPlanSkuAdjustment } from '../../../bridge.ts';
import { addExactDecimals, multiplyExactDecimals } from '../regionalApprovalQueryModel.ts';
import { salesPlanEditableQuantity } from './salesPlanAccessModel.ts';
import { salesPlanSkusMatchVersion } from './salesPlanDetailModel.ts';
import type { ApprovalStageId } from '../regionalApprovalFixture.ts';

export type SalesPlanLocalDraft = {
  planId: string;
  versionId: string;
  status: number;
  sourceSnapshot: string;
  adjustments: GeaSalesPlanSkuAdjustment[];
  remark: string;
  /** 草稿里的调整量是相对哪个节点口径算出来的；缺省表示按状态口径。 */
  role?: ApprovalStageId;
};

export type SalesPlanLocalDraftStore = Record<string, SalesPlanLocalDraft>;
const DECIMAL = /^[+-]?\d{1,15}(?:\.\d{1,3})?$/;

/** 只表示本地草稿的新鲜度；绝不作为服务端签发的权威或快照令牌发送。 */
export const salesPlanDraftSnapshot = (
  row: Pick<GeaSalesPlanListItem, 'planId' | 'versionId' | 'status'>,
  detail: GeaSalesPlanDetail
): string | undefined => {
  const version = detail.currentVersion;
  if (
    version.planId !== row.planId ||
    version.id !== row.versionId ||
    version.status !== row.status ||
    !version.effective ||
    !salesPlanSkusMatchVersion(row.versionId, detail.skus)
  )
    return undefined;
  return JSON.stringify([
    row.planId,
    row.versionId,
    row.status,
    detail.skus
      .map((sku) => [
        String(sku.skuCode),
        salesPlanEditableQuantity(sku, row.status),
        String(sku.price),
        sku.qty,
        sku.regionConfirmedQty,
        sku.provinceConfirmedQty,
        sku.areaConfirmedQty,
        sku.categoryConfirmedQty,
      ])
      .toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ]);
};

export const salesPlanDraftMatches = (
  draft: SalesPlanLocalDraft | undefined,
  row: Pick<GeaSalesPlanListItem, 'planId' | 'versionId' | 'status'> & Partial<Pick<GeaSalesPlanListItem, 'planTypeCode'>>,
  detail: GeaSalesPlanDetail,
  role?: ApprovalStageId
): draft is SalesPlanLocalDraft => {
  if (
    !draft ||
    draft.planId !== row.planId ||
    draft.versionId !== row.versionId ||
    draft.status !== row.status ||
    draft.sourceSnapshot !== salesPlanDraftSnapshot(row, detail) ||
    !Array.isArray(draft.adjustments) ||
    typeof draft.remark !== 'string' ||
    Array.from(draft.remark).length > 1000
  )
    return false;
  const codes = new Set<string>();
  if (draft.role !== undefined && !['region', 'province', 'area', 'category'].includes(draft.role)) return false;
  const baselineRole = role ?? draft.role;
  return draft.adjustments.every((adjustment) => {
    if (
      !adjustment ||
      typeof adjustment.skuCode !== 'string' ||
      typeof adjustment.adjustQty !== 'string' ||
      !DECIMAL.test(adjustment.adjustQty) ||
      codes.has(adjustment.skuCode)
    )
      return false;
    codes.add(adjustment.skuCode);
    const sku = detail.skus.find((item) => String(item.skuCode) === adjustment.skuCode);
    // 基线必须和写草稿的界面用同一套口径：优先用本次请求角色，其次用草稿自己记录的角色，最后按状态取值。
    const baseline = sku && salesPlanEditableQuantity(sku, row.status, row.planTypeCode ?? 'Y', baselineRole);
    const qty = baseline === undefined ? '—' : addExactDecimals([baseline, adjustment.adjustQty]);
    return !!sku && qty !== '—' && !qty.startsWith('-') && multiplyExactDecimals(qty, String(sku.price)) !== undefined;
  });
};

/** 本地草稿保存只校验数据形状，不回查 GEA，也不代表服务端审批权限。 */
export const salesPlanLocalDraftValid = (
  draft: unknown,
  planId: string,
  versionId: string,
): draft is SalesPlanLocalDraft => {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return false;
  const value = draft as Partial<SalesPlanLocalDraft>;
  if (value.planId !== planId || value.versionId !== versionId || !Number.isInteger(value.status)) return false;
  if (typeof value.sourceSnapshot !== 'string' || value.sourceSnapshot.length > 200_000) return false;
  if (typeof value.remark !== 'string' || Array.from(value.remark).length > 1000 || !Array.isArray(value.adjustments)) return false;
  const codes = new Set<string>();
  return value.adjustments.every((adjustment) => {
    if (!adjustment || typeof adjustment !== 'object' || typeof adjustment.skuCode !== 'string' ||
        typeof adjustment.adjustQty !== 'string' || !DECIMAL.test(adjustment.adjustQty) || codes.has(adjustment.skuCode)) return false;
    codes.add(adjustment.skuCode);
    return true;
  });
};

const storageKey = (scope: string) => `gea-dsh:sales-plan-local-drafts:v1:${encodeURIComponent(scope)}`;
export const readSalesPlanLocalDrafts = (scope: string | undefined): SalesPlanLocalDraftStore => {
  if (!scope) return {};
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey(scope)) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as SalesPlanLocalDraftStore) : {};
  } catch {
    return {};
  }
};

/** 本地写入失败必须报告，不能显示虚假的已保存状态。 */
export const writeSalesPlanLocalDrafts = (scope: string, drafts: SalesPlanLocalDraftStore): void => {
  window.localStorage.setItem(storageKey(scope), JSON.stringify(drafts));
};
