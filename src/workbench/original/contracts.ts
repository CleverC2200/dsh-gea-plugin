import type { CorrectionFields } from './workbenches/regionalApproval/models/salesPlanCorrectionModel.ts';
/** 从 AionUi 复制的销售计划 API 字段；标识和精确小数保持字符串，避免 Renderer 丢失精度。 */
export type GeaSalesPlanId = string;
/** 精确小数跨越 JavaScript/Core/GEA 边界时始终保持字符串。 */
export type GeaSalesPlanDecimal = string;

export type GeaSalesPlanPage<T> = {
  records: T[];
  total: number;
  size: number;
  current: number;
  pages: number;
};

export type GeaSalesPlanPeriod = {
  periodId: GeaSalesPlanId;
  tenantId: GeaSalesPlanId;
  periodMonth: string;
  planType: string;
  planTypeCode: string;
  /** 旧周期状态已移除；从可见计划重建周期时为 UNKNOWN。 */
  status?: string;
  submitDeadline?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type GeaSalesPlanPeriodQuery = {
  periodMonth?: string;
  planType?: string;
  pageNo?: number;
  pageSize?: number;
  signal?: AbortSignal;
};

export type GeaSalesPlanListItem = {
  orderType?: "M" | "Z";
  monthlyApproved?: boolean;
  hasCorrection?: boolean;
  mPlanAmount?: string;
  mPlanQty?: string;
  shipAmount?: string;
  shipQty?: string;
  corrPlanAmount?: string;
  corrPlanQty?: string;
  planId: string;
  versionId: string;
  seq: number;
  periodId: GeaSalesPlanId;
  planTypeCode: string;
  dealerCode: GeaSalesPlanId;
  orgCode?: string | null;
  orgName?: string | null;
  provinceCode?: string | null;
  provinceName?: string | null;
  areaCode?: string | null;
  areaName?: string | null;
  /** 兼容旧版 GEA 部署接受的历史别名。 */
  regionName?: string | null;
  provinceRegionName?: string | null;
  salesGroupName?: string | null;
  baseName?: string | null;
  dealerName?: string | null;
  status: number;
  returnReason?: string | null;
  targetQty: GeaSalesPlanDecimal;
  targetAmount: GeaSalesPlanDecimal;
  skuCount: number;
  currentQty: GeaSalesPlanDecimal;
  currentAmount: GeaSalesPlanDecimal;
  submitter?: string | null;
  submitTime?: string | null;
  finishedAt?: string | null;
  updatedAt?: string | null;
};

export type GeaSalesPlanPageQuery = {
  orderType?: "M" | "Z";
  periodId?: GeaSalesPlanId;
  planTypeCode?: string;
  dealerCode?: GeaSalesPlanId;
  areaCode?: string;
  provinceCode?: string;
  orgCode?: string;
  baseName?: string;
  status?: number;
  pageNo?: number;
  pageSize?: number;
  signal?: AbortSignal;
};

export type GeaSalesPlanVersion = {
  orderType?: 'M' | 'Z';
  id: string;
  planId: string;
  seq: number;
  periodId: GeaSalesPlanId;
  planTypeCode: string;
  dealerCode: GeaSalesPlanId;
  orgCode?: string | null;
  orgName?: string | null;
  provinceCode?: string | null;
  provinceName?: string | null;
  areaCode?: string | null;
  areaName?: string | null;
  baseName?: string | null;
  status: number;
  effective: boolean;
  returnReason?: string | null;
  targetAmount: GeaSalesPlanDecimal;
  targetQty: GeaSalesPlanDecimal;
  submitter?: string | null;
  submitTime?: string | null;
  finishedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type GeaSalesPlanSku = CorrectionFields & {
  id: GeaSalesPlanId;
  versionId: string;
  skuCode: GeaSalesPlanId;
  /** todo/material 端点可选提供的描述。 */
  materialDescription?: string | null;
  skuName?: string | null;
  productCategName: string;
  baseQty: GeaSalesPlanDecimal;
  qty: GeaSalesPlanDecimal;
  price: GeaSalesPlanDecimal;
  amt: GeaSalesPlanDecimal;
  amtBase: GeaSalesPlanDecimal;
  regionConfirmedQty?: GeaSalesPlanDecimal | null;
  regionConfirmedAmount?: GeaSalesPlanDecimal | null;
  provinceConfirmedQty?: GeaSalesPlanDecimal | null;
  provinceConfirmedAmount?: GeaSalesPlanDecimal | null;
  areaConfirmedQty?: GeaSalesPlanDecimal | null;
  areaConfirmedAmount?: GeaSalesPlanDecimal | null;
  categoryConfirmedQty?: GeaSalesPlanDecimal | null;
  categoryConfirmedAmount?: GeaSalesPlanDecimal | null;
};

export type GeaSalesPlanApprovalLog = {
  id: GeaSalesPlanId;
  planId: string;
  versionId: string;
  fromStatus?: number | null;
  toStatus: number;
  actionCode: string;
  operatorCode: string;
  operatorName?: string | null;
  remark?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  serviceClientId?: string | null;
  actionAt: string;
};

export type GeaSalesPlanApprovalRole = 'region' | 'province' | 'area' | 'category';

export type GeaSalesPlanActionContext = {
  /** 显式支持按角色限定写入、结果失效和仅通知路由。 */
  policy?: 'role-visible-v1';
  roleActions?: Array<{ role: GeaSalesPlanApprovalRole; allowedActions: GeaSalesPlanAction[] }>;
  versionId: string;
  status: number;
  nodeOrder?: number | null;
  allowedActions: GeaSalesPlanAction[];
  snapshotHash: string;
  reason?: 'MISSING_PERMISSION' | 'NOT_CANDIDATE' | 'UNAVAILABLE' | null;
};

export type GeaSalesPlanDetail = {
  /** 带版本的适配器契约；证据缺失时保持纠偏写入禁用。 */
  correctionContext?: { contract: 'absolute-net-v1'; monthlyApproved: boolean; approvalOpen: boolean };
  dmsMock?: { source: 'DMS_MOCK'; syncStatus: string; finishedAt: string | null; receipts: Array<{key:string;dmsId:string}> };

  /** 当前用户任务分配；由已认证 Host 匹配并刷新。 */
  actionContext?: GeaSalesPlanActionContext;
  /** 服务端把该版本的可处理审批任务派给当前用户时由 Host 匹配；代表"这一笔现在归你办"。 */

  currentVersion: GeaSalesPlanVersion;
  skus: GeaSalesPlanSku[];
  versions: GeaSalesPlanVersion[];
  logs: GeaSalesPlanApprovalLog[];
};

export type GeaSalesPlanChangeType = 'ADDED' | 'DELETED' | 'UPDATED';

export type GeaSalesPlanSkuDiff = {
  skuCode: GeaSalesPlanId;
  changeType: GeaSalesPlanChangeType;
  before?: GeaSalesPlanSku | null;
  after?: GeaSalesPlanSku | null;
  qtyDelta: GeaSalesPlanDecimal;
  amountDelta: GeaSalesPlanDecimal;
};

export type GeaSalesPlanResourceQuery = {
  planId: string;
  signal?: AbortSignal;
};

export type GeaSalesPlanVersionSkuQuery = {
  versionId: string;
  signal?: AbortSignal;
};

export type GeaSalesPlanCompareQuery = {
  planId: string;
  fromVersionId: string;
  toVersionId: string;
  signal?: AbortSignal;
};

export type GeaSalesPlanSubmitItem = {
  adjAddQty?: string;
  adjCutQty?: string;
  skuCode: GeaSalesPlanId;
  productCategName: string;
  baseQty: GeaSalesPlanDecimal;
  qty: GeaSalesPlanDecimal;
  price: GeaSalesPlanDecimal;
};

export type GeaSalesPlanSubmitRequest = {
  adjustmentMode?: "ABSOLUTE_NET";
  orderType: 'M' | 'Z';
  status: number;
  periodId: GeaSalesPlanId;
  periodMonth: string;
  planTypeCode: string;
  channelCode: string;
  dealerCode: GeaSalesPlanId;
  orgCode?: string;
  provinceCode?: string;
  areaCode?: string;
  baseName?: string;
  targetQty: GeaSalesPlanDecimal;
  targetAmount: GeaSalesPlanDecimal;
  submitterCode: string;
  submitterName?: string;
  items: GeaSalesPlanSubmitItem[];
};

export type GeaSalesPlanSubmitReceipt = {
  planId: GeaSalesPlanId;
  versionId: GeaSalesPlanId;
  seq: number;
  status: number;
  replayed: boolean;
  requestId: string;
  traceId: string;
  auditId: string;
};

export type GeaSalesPlanSubmitParams = {
  source: { planId: string; versionId: string };
  request: GeaSalesPlanSubmitRequest;
  idempotencyKey: string;
  requestId: string;
};

export type GeaSalesPlanAction = 'APPROVE' | 'REJECT' | 'SAVE';

export type GeaSalesPlanSkuAdjustment = {
  skuCode: GeaSalesPlanId;
  /** 带符号的数量增量，而不是绝对数量。 */
  adjustQty: GeaSalesPlanDecimal;
};

export type GeaSalesPlanActionRequest = {
  approvalPolicy?: 'role-visible-v1';
  approvalRole?: GeaSalesPlanApprovalRole;
  adjustmentMode?: "ABSOLUTE_NET";
  expectedSnapshot?: string;
  action: GeaSalesPlanAction;
  expectedStatus: number;
  remark?: string;
  adjustments?: GeaSalesPlanSkuAdjustment[];
};

export type GeaSalesPlanActionReceipt = {
  approvalRole?: GeaSalesPlanApprovalRole;
  /** 对结果数据快照仍然有效的角色决策。 */
  approvedRoles?: GeaSalesPlanApprovalRole[];
  planId: GeaSalesPlanId;
  versionId: GeaSalesPlanId;
  fromStatus: number;
  toStatus: number;
  replayed: boolean;
  requestId: string;
  traceId: string;
  auditId: string;
};

export type GeaSalesPlanActionParams = {
  /** Host 重新验证 SAVE 能力时必需的字段。 */
  planId?: GeaSalesPlanId;
  versionId: GeaSalesPlanId;
  request: GeaSalesPlanActionRequest;
  idempotencyKey: string;
  requestId: string;
};
