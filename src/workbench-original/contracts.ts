/** Sales-plan API fields copied from AionUi; identifiers and exact decimals remain strings. */
/** GEA Long identifiers remain strings so Renderer code cannot lose precision. */
export type GeaSalesPlanId = string;
/** Exact decimals remain strings across the JavaScript/Core/GEA boundary. */
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
  status: string;
  submitDeadline?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type GeaSalesPlanPeriodQuery = {
  periodMonth?: string;
  planType?: string;
  status?: string;
  pageNo?: number;
  pageSize?: number;
  signal?: AbortSignal;
};

export type GeaSalesPlanListItem = {
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
  /** Legacy aliases accepted from older GEA deployments. */
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

export type GeaSalesPlanSku = {
  id: GeaSalesPlanId;
  versionId: string;
  skuCode: GeaSalesPlanId;
  /** Optional description supplied by the todo/material endpoint. */
  materialDescription?: string | null;
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

export type GeaSalesPlanActionContext = {
  versionId: string;
  status: number;
  nodeOrder?: number | null;
  allowedActions: GeaSalesPlanAction[];
  snapshotHash: string;
  reason?: 'MISSING_PERMISSION' | 'NOT_CANDIDATE' | 'UNAVAILABLE' | null;
};

export type GeaSalesPlanDetail = {
  /** Current-user task assignment, matched and refreshed by the authenticated Host. */
  workflowApproval?: { versionId: string; notificationId: string; instanceId: string; actionable: true };
  actionContext?: GeaSalesPlanActionContext;

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
  skuCode: GeaSalesPlanId;
  productCategName: string;
  baseQty: GeaSalesPlanDecimal;
  qty: GeaSalesPlanDecimal;
  price: GeaSalesPlanDecimal;
};

export type GeaSalesPlanSubmitRequest = {
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
  request: GeaSalesPlanSubmitRequest;
  idempotencyKey: string;
  requestId: string;
};

export type GeaSalesPlanAction = 'APPROVE' | 'REJECT' | 'SAVE';

export type GeaSalesPlanSkuAdjustment = {
  skuCode: GeaSalesPlanId;
  /** Signed quantity delta, not an absolute quantity. */
  adjustQty: GeaSalesPlanDecimal;
};

export type GeaSalesPlanActionRequest = {
  expectedSnapshot?: string;
  action: GeaSalesPlanAction;
  expectedStatus: number;
  remark?: string;
  adjustments?: GeaSalesPlanSkuAdjustment[];
};

export type GeaSalesPlanActionReceipt = {
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
  /** Required by the Host for fresh SAVE capability verification. */
  planId?: GeaSalesPlanId;
  versionId: GeaSalesPlanId;
  request: GeaSalesPlanActionRequest;
  idempotencyKey: string;
  requestId: string;
};
