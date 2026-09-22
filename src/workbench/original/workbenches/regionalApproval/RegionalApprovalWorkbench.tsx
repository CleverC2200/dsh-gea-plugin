import { InlineSkuDetails } from './InlineSkuDetails.tsx';
import { correctionMetrics } from './models/salesPlanCorrectionModel.ts';
import { CorrectionWorkbench } from './CorrectionWorkbench.tsx';
import type { GeaSalesPlanPeriod } from '../../contracts.ts';
/** 改编自 AionUi（Apache-2.0）：已替换为本地导入并使用显式 DSH Host 适配器，见 SOURCE.md。 */
import { salesPlanQueueStatusText, salesPlanStatusText } from './regionalApprovalQueryModel.ts';
import { SALES_PLAN_RETURN_CODES } from '../../salesPlanWorkflow.ts';
import {
  aggregateSalesPlanExportAmounts,
  SALES_PLAN_EXPORT_AMOUNT_PAIRS,
  type SalesPlanExportAmounts,
} from './models/salesPlanExportModel.ts';
import { useSalesPlanAccess } from './hooks/useSalesPlanAccess.ts';
import {
  salesPlanAccessForRow,
  salesPlanStagesForPermissions,
  verifySavedSalesPlan,
} from './models/salesPlanAccessModel.ts';
import { salesPlanProgressBarColor } from './models/salesPlanProgressModel.ts';
import { salesPlanVarianceClass } from './models/salesPlanVarianceModel.ts';
import {
  Alert,
  Button,
  Empty,
  Modal,
  Pagination,
  Progress,
  Select,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from '@arco-design/web-react';
import type { TableColumnProps } from '@arco-design/web-react';
import { CheckOne, Down, Download, Filter, Info, Refresh, Right, ChartHistogram, Up } from '@icon-park/react';
import type { TFunction } from 'i18next';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBusinessSurfaceSession } from '../../session-context.tsx';
import {
  getAssistantSurfaceWorkbenchScope,
  readAssistantSurfaceState,
  writeAssistantSurfaceState,
} from '../../storage.ts';
import {
  APPROVAL_STAGE_FIXTURES,
  APPROVAL_DIMENSIONS_BY_STAGE,
  REGIONAL_APPROVAL_ROWS,
  approvalRowsForStage,
  isApprovalStageId,
  type ApprovalHealth,
  type ApprovalDimension,
  type ApprovalStageId,
  type ApprovalState,
  type ApprovalVersion,
  type RegionalApprovalRow,
} from './regionalApprovalFixture.ts';
import {
  ALL_ORGANIZATIONS,
  DEFAULT_APPROVAL_FILTERS,
  approvalFilterOptions,
  buildApprovalCsv,
  metricsForApprovalVersion,
  normalizeApprovalFilters,
  paginateApprovalRows,
  projectApprovalRows,
  updateApprovalFilter,
  type ApprovalCsvLabels,
  type ApprovalOrganizationFilterField,
  type ApprovalOrganizationFilters,
} from './regionalApprovalModel.ts';
import RegionalApprovalPlanDetail from './RegionalApprovalPlanDetail.tsx';
import RegionalApprovalLivePlanDetail, {
  type RegionalApprovalLivePlanDetailTab,
} from './RegionalApprovalLivePlanDetail/index.tsx';
import RegionalApprovalActionDialog from './RegionalApprovalActionDialog.tsx';
import RegionalApprovalLiveActionDialog, { type LiveActionKind } from './RegionalApprovalLiveActionDialog.tsx';
import { groupRegionalApprovalLiveRows } from './regionalApprovalQueryModel.ts';
import RegionalApprovalLiveProgress from './RegionalApprovalLiveProgress.tsx';
import {
  EMPTY_REGIONAL_APPROVAL_ACTION_STORE,
  regionalApprovalFixtureResults,
  type RegionalApprovalActionExecutor,
  type RegionalApprovalActionStore,
} from './regionalApprovalActionModel.ts';
import {
  EMPTY_APPROVAL_DETAIL_STORE,
  savedApprovalAdjustments,
  type ApprovalDetailStore,
} from './regionalApprovalDetailModel.ts';
import {
  aggregateRegionalApprovalLiveCategories,
  addExactDecimals,
  clampSalesPlanPageNumber,
  formatExactDecimal,
  projectRegionalApprovalLiveDimension,
  regionalApprovalLiveProgress,
  salesPlanPeriodOptionLabel,
  subtractExactDecimals,
  toRegionalApprovalLiveRow,
  type RegionalApprovalLiveCategorySummary,
  type RegionalApprovalLiveRow,
} from './regionalApprovalQueryModel.ts';
import {
  useRegionalApprovalQuery,
  type RegionalApprovalQueryError,
  type SalesPlanQueryClient,
} from './useRegionalApprovalQuery.ts';
import type { SalesPlanDetailClient } from './hooks/useSalesPlanDetail.ts';
import { salesPlanApprovalNodeForStatus, type SalesPlanActionClient } from './models/salesPlanActionModel.ts';
import type { GeaSalesPlanActionReceipt, GeaSalesPlanVersion } from '../../bridge.ts';
import { salesPlan } from '../../bridge.ts';
import type { PageElement } from '../../../../page-bridge/catalog.ts';
import { buildWorkbenchElements } from '../../../workbench-elements.ts';
import {
  buildSalesPlanFilterSummary,
  projectFixtureSalesPlanContext,
  projectSalesPlanActionContext,
  projectSalesPlanQueryContext,
  type SalesPlanAuthorityContext,
  type SalesPlanContextApprovalStage,
} from './models/salesPlanContextModel.ts';
import styles from './RegionalApprovalWorkbench.module.css';

type ApprovalContextFilters = { [Field in keyof ApprovalOrganizationFilters]: string };

export type RegionalApprovalContextEntity = {
  source: 'gea' | 'fixture';
  id: string;
  organizationKey: string;
  approvalState: ApprovalState | 'returned';
  health: ApprovalHealth | 'unknown';
  versionId?: string;
  seq?: number;
  status?: number;
  planTypeCode?: string;
  dealerCode?: string;
  orgCode?: string;
  provinceCode?: string;
  areaCode?: string;
  currentQty?: string;
  currentAmount?: string;
  targetQty?: string;
  targetAmount?: string;
  skuCount?: number;
  submitter?: string;
  returnReason?: string;
  customerCode?: string;
  category?: RegionalApprovalRow['category'];
  quantity?: string;
  amount?: string;
  previousQuantity?: string;
  previousAmount?: string;
  adjustmentQuantity?: string;
  adjustmentAmount?: string;
};

export type RegionalApprovalWorkbenchContext = {
  analysisSummary?: ReturnType<typeof useRegionalApprovalQuery>['analysisSummary'];
  view: 'regional-approval';
  fixtureState: 'ready' | 'live' | 'mixed';
  scope: {
    dimension?: ApprovalDimension;
    categoryComparison?: boolean;
    primaryVersionId?: string;
    versionReferencePlanId?: string;
    currentVersionId?: string;
    compareVersionId?: string;
    planType: string;
    month: string;
    approvalStage: SalesPlanContextApprovalStage;
    authority: 'organization';
    primaryVersion: ApprovalVersion;
    compareVersion: ApprovalVersion;
    appliedFilters: ApprovalContextFilters;
  };
  visibleEntities: RegionalApprovalContextEntity[];
  selectedEntities: RegionalApprovalContextEntity[];
  /** 当前展开的行（实时队列里就是 planId），用于让外部读到"展开了什么"。 */
  expandedPlanIds: string[];
  /** 已展开行里的可编辑字段（SKU 确认计划量）：让外部能回读改后的值。 */
  expandedFields: Array<{
    id: string;
    label: string;
    value: string;
    editable: boolean;
  }>;
  changes: ReturnType<typeof savedApprovalAdjustments>;
  localApprovalResults: ReturnType<typeof regionalApprovalFixtureResults>;
  metrics: {
    visibleCount: number;
    pendingCount: number;
    warningCount: number;
    quantity: string;
    amount: string;
    targetQuantity?: string;
    targetAmount?: string;
    savedAdjustmentCount: number;
    localApprovalResultCount: number;
  };
  pagination: { page: number; pageSize: number; total: number };
  evidence: {
    source: 'fixture' | 'gea-user-session' | 'unverified';
    permission: 'read-only' | 'user-session-action';
    completeness: 'skeleton' | 'periods-only' | 'paged-queue' | 'none';
    queryState: 'fixture' | 'loading' | 'error' | 'empty-periods' | 'empty' | 'success' | 'refreshing' | 'stale-error';
    error?: RegionalApprovalQueryError;
    dataVersion: string;
  };
  authority?: SalesPlanAuthorityContext;
};

const stageLabelKey = (stage: ApprovalStageId) => `common.assistantSurface.regionalApproval.stages.${stage}` as const;

const organizationLabelKey = (organization: RegionalApprovalRow['organizationKey']) =>
  `common.assistantSurface.regionalApproval.organizations.${organization}` as const;

const areaLabelKey = (area: RegionalApprovalRow['areaKey']) =>
  `common.assistantSurface.regionalApproval.areas.${area}` as const;

const branchLabelKey = (branch: RegionalApprovalRow['branchKey']) =>
  `common.assistantSurface.regionalApproval.branches.${branch}` as const;

const departmentLabelKey = (department: RegionalApprovalRow['departmentKey']) =>
  `common.assistantSurface.regionalApproval.departments.${department}` as const;

const customerLabelKey = (customer: RegionalApprovalRow['customerKey']) =>
  `common.assistantSurface.regionalApproval.customers.${customer}` as const;

const number = (value: number) => value.toLocaleString();
const money = (value: number) => `¥${value.toLocaleString()}`;
const exactMoney = (value: string) => `¥${formatExactDecimal(value)}`;
const quantityText = (value: string) => formatExactDecimal(value).replace(/\.0+$/, '');
const exactSignedMoney = (value: string) => {
  const formatted = formatExactDecimal(value);
  return formatted.startsWith('-') ? `−¥${formatted.slice(1)}` : `¥${formatted}`;
};
const isExactZero = (value: string) => /^-?0(?:\.0+)?$/.test(value);
const formattedProgress = (value: number | undefined) => (value === undefined ? '—' : `${value.toFixed(1)}%`);
const projectLiveContextEntity = (
  row: RegionalApprovalLiveRow,
  dimension: ApprovalDimension
): RegionalApprovalContextEntity => ({
  source: 'gea',
  id: row.planId,
  organizationKey: projectRegionalApprovalLiveDimension(row, dimension).name ?? row.orgCode ?? row.dealerCode,
  approvalState: row.approvalState,
  health: 'unknown',
  versionId: row.versionId,
  seq: row.seq,
  status: row.status,
  planTypeCode: row.planTypeCode,
  dealerCode: row.dealerCode,
  ...(row.orgCode ? { orgCode: row.orgCode } : {}),
  ...(row.provinceCode ? { provinceCode: row.provinceCode } : {}),
  ...(row.areaCode ? { areaCode: row.areaCode } : {}),
  currentQty: row.currentQty,
  currentAmount: row.currentAmount,
  targetAmount: row.targetAmount,
  skuCount: row.skuCount,
  ...(row.submitter ? { submitter: row.submitter } : {}),
  ...(row.returnReason ? { returnReason: row.returnReason } : {}),
});

const projectFixtureContextEntity = (
  row: RegionalApprovalRow,
  version: ApprovalVersion
): RegionalApprovalContextEntity => {
  const versionMetrics = metricsForApprovalVersion(row, version);
  return {
    source: 'fixture',
    id: row.id,
    organizationKey: row.organizationKey,
    approvalState: row.approvalState,
    health: row.health,
    customerCode: row.customerCode,
    category: row.category,
    quantity: String(versionMetrics.quantity),
    amount: String(versionMetrics.amount),
    previousQuantity: String(row.previousQuantity),
    previousAmount: String(row.previousAmount),
    adjustmentQuantity: String(row.adjustmentQuantity),
    adjustmentAmount: String(row.adjustmentAmount),
    ...(row.returnReason ? { returnReason: row.returnReason } : {}),
  };
};

type ExportFeedback = { type: 'success' | 'warning' | 'error'; message: string };
type LiveApprovalFilters = {
  areaCode: string;
  provinceCode: string;
  orgCode: string;
  dealerCode: string;
  status: string;
};

const EMPTY_LIVE_APPROVAL_FILTERS: LiveApprovalFilters = {
  areaCode: ALL_ORGANIZATIONS,
  provinceCode: ALL_ORGANIZATIONS,
  orgCode: ALL_ORGANIZATIONS,
  dealerCode: ALL_ORGANIZATIONS,
  status: ALL_ORGANIZATIONS,
};

const uniqueLiveNamedFilterOptions = (
  rows: readonly RegionalApprovalLiveRow[],
  valueFor: (row: RegionalApprovalLiveRow) => string | null | undefined,
  labelFor: (row: RegionalApprovalLiveRow) => string | null | undefined
) =>
  rows
    .map((row) => ({ value: valueFor(row)?.trim(), label: labelFor(row)?.trim() }))
    .filter((option): option is { value: string; label: string | undefined } => Boolean(option.value))
    .filter((option, index, options) => options.findIndex((candidate) => candidate.value === option.value) === index)
    .toSorted((left, right) => (left.label ?? left.value).localeCompare(right.label ?? right.value, 'zh-CN'));

type RegionalApprovalLiveTableRow =
  | {
      kind: 'plan';
      tableRowId: string;
      plan: RegionalApprovalLiveRow;
      members?: RegionalApprovalLiveRow[];
      childPlan?: boolean;
      displayDimension?: ApprovalDimension;
      children?: RegionalApprovalLiveTableRow[];
    }
  | {
      kind: 'category';
      tableRowId: string;
      plan: RegionalApprovalLiveRow;
      category: RegionalApprovalLiveCategorySummary;
    };

const categoryComparisonState = (summary: RegionalApprovalLiveCategorySummary) => {
  if (
    (summary.amountProgress === undefined && !isExactZero(summary.amountDelta)) ||
    (summary.quantityProgress === undefined && !isExactZero(summary.quantityDelta))
  ) {
    return 'warning' as const;
  }
  const progress = [summary.amountProgress, summary.quantityProgress].filter(
    (value): value is number => value !== undefined
  );
  if (progress.some((value) => value < 85 || value > 115)) return 'warning' as const;
  if (progress.some((value) => value < 95 || value > 105)) return 'attention' as const;
  return 'healthy' as const;
};

type PersistedApprovalWorkbenchState = {
  currentStage: ApprovalStageId;
  draftFilters: ApprovalOrganizationFilters;
  appliedFilters: ApprovalOrganizationFilters;
  primaryVersion: ApprovalVersion;
  compareVersion: ApprovalVersion;
  page: number;
  pageSize: number;
  dimension: ApprovalDimension;
  categoryComparison: boolean;
  /** 审批流程图默认收起；同一次会话内记住用户展开/收起的选择。 */
  stageLaneOpen: boolean;
  selectedRowIds: string[];
  liveActionReceipts: Record<string, GeaSalesPlanActionReceipt>;
};

const APPROVAL_VERSIONS = ['current', 'previous', 'initial'] as const satisfies readonly ApprovalVersion[];
const approvalVersionOffset = (version: ApprovalVersion) => APPROVAL_VERSIONS.indexOf(version);

const isApprovalVersion = (value: unknown): value is ApprovalVersion =>
  APPROVAL_VERSIONS.includes(value as ApprovalVersion);

const normalizeLiveActionReceipts = (value: unknown): Record<string, GeaSalesPlanActionReceipt> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([versionId, receipt]) => {
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
      const candidate = receipt as Partial<GeaSalesPlanActionReceipt>;
      return (
        candidate.versionId === versionId &&
        typeof candidate.planId === 'string' &&
        Number.isInteger(candidate.fromStatus) &&
        Number.isInteger(candidate.toStatus) &&
        typeof candidate.replayed === 'boolean' &&
        typeof candidate.requestId === 'string' &&
        typeof candidate.traceId === 'string' &&
        typeof candidate.auditId === 'string'
      );
    })
  ) as Record<string, GeaSalesPlanActionReceipt>;
};

const queryErrorKey = (error: RegionalApprovalQueryError) =>
  `common.assistantSurface.regionalApproval.query.errors.${error}` as const;

const fixturePriority = (row: RegionalApprovalRow) => {
  if (row.approvalState === 'pending' && row.health === 'warning') return 0;
  if (row.approvalState === 'pending') return 1;
  if (row.health === 'warning' || row.health === 'attention') return 2;
  if (row.approvalState === 'approved') return 3;
  return 4;
};

const livePriority = (row: RegionalApprovalLiveRow) => {
  if (row.approvalState === 'returned') return 0;
  if (row.approvalState === 'pending') return 1;
  return 2;
};

const RegionalApprovalWorkbench: React.FC<{
  headerControls?: React.ReactNode;
  stateScope: string;
  t: TFunction;
  onContextChange: (context: RegionalApprovalWorkbenchContext, conversationId: string | null) => void;
  actionExecutor?: RegionalApprovalActionExecutor;
  queryClient?: SalesPlanQueryClient | null;
  detailClient?: SalesPlanDetailClient;
  liveActionClient?: SalesPlanActionClient;
  liveActionsEnabled?: boolean;
  automaticAnalysisEnabled?: boolean;
  onResubmit?: (planId: string, versionId: string, period: GeaSalesPlanPeriod) => void;
  permissionCodes?: readonly string[];
  /** AG-UI 前端工具调用：agent 让页面改这一屏怎么看。 */
  toolCall?: { toolCallId: string; command: Record<string, unknown> };
  onToolResult?: (toolCallId: string, applied: boolean, error?: string) => void;
  /** 页面元素清单单独上报：它是页面能力，不属于页面状态快照。 */
  onCatalogChange?: (elements: PageElement[]) => void;
}> = ({
  headerControls,
  stateScope,
  t,
  onContextChange,
  actionExecutor,
  queryClient,
  detailClient,
  liveActionClient,
  liveActionsEnabled = false,
  automaticAnalysisEnabled = false,
  permissionCodes,
  onResubmit,
  toolCall,
  onToolResult,
  onCatalogChange,
}) => {
  const { conversationId } = useBusinessSurfaceSession();
  const scopedState = getAssistantSurfaceWorkbenchScope(stateScope);
  const [initialState] = useState<PersistedApprovalWorkbenchState>(() => {
    const saved = readAssistantSurfaceState<Partial<PersistedApprovalWorkbenchState>>(
      'forecast',
      `${scopedState}:regional-approval-state`,
      {}
    );
    const legacyStage = readAssistantSurfaceState<unknown>('forecast', `${scopedState}:approval-stage`, 'area');
    const currentStage = isApprovalStageId(saved.currentStage)
      ? saved.currentStage
      : isApprovalStageId(legacyStage)
        ? legacyStage
        : 'area';
    const stageRows = approvalRowsForStage(REGIONAL_APPROVAL_ROWS, currentStage);
    return {
      currentStage,
      draftFilters: normalizeApprovalFilters(stageRows, {
        ...DEFAULT_APPROVAL_FILTERS,
        ...saved.draftFilters,
      }),
      appliedFilters: normalizeApprovalFilters(stageRows, {
        ...DEFAULT_APPROVAL_FILTERS,
        ...saved.appliedFilters,
      }),
      primaryVersion: isApprovalVersion(saved.primaryVersion) ? saved.primaryVersion : 'current',
      compareVersion: isApprovalVersion(saved.compareVersion) ? saved.compareVersion : 'previous',
      page: typeof saved.page === 'number' && saved.page >= 1 ? Math.floor(saved.page) : 1,
      pageSize: [10, 20, 50, 100].includes(saved.pageSize ?? 0) ? saved.pageSize! : 20,
      dimension: APPROVAL_DIMENSIONS_BY_STAGE[currentStage].includes(saved.dimension as ApprovalDimension)
        ? (saved.dimension as ApprovalDimension)
        : APPROVAL_DIMENSIONS_BY_STAGE[currentStage][0],
      categoryComparison: saved.categoryComparison === true,
      stageLaneOpen: saved.stageLaneOpen === true,
      selectedRowIds: Array.isArray(saved.selectedRowIds)
        ? saved.selectedRowIds.filter((value): value is string => typeof value === 'string')
        : [],
      liveActionReceipts: normalizeLiveActionReceipts(saved.liveActionReceipts),
    };
  });
  const [currentStage, setCurrentStage] = useState(initialState.currentStage);
  const [draftFilters, setDraftFilters] = useState(initialState.draftFilters);
  const [appliedFilters, setAppliedFilters] = useState(initialState.appliedFilters);
  const [primaryVersion, setPrimaryVersion] = useState(initialState.primaryVersion);
  const [compareVersion, setCompareVersion] = useState(initialState.compareVersion);
  const [pageSize, setPageSize] = useState(initialState.pageSize);
  const [page, setPage] = useState(initialState.page);
  const [dimension, setDimension] = useState(initialState.dimension);
  const [categoryComparison, setCategoryComparison] = useState(initialState.categoryComparison);
  const [stageLaneOpen, setStageLaneOpen] = useState(initialState.stageLaneOpen);
  const [liveCategorySummaries, setLiveCategorySummaries] = useState<
    Record<string, RegionalApprovalLiveCategorySummary[]>
  >({});
  const [liveCategoriesLoading, setLiveCategoriesLoading] = useState(false);
  // 只有最后一次品类汇总请求可以复位加载态，避免被中断的那次把遮罩留在页面上。
  const liveCategoriesRequest = useRef(0);
  const [versionMetrics, setVersionMetrics] = useState<Record<string, {versionId?:string; qty:string; amount:string; baseQty:string; baseAmount:string; targetQty:string; targetAmount:string; compareQty?:string; compareAmount?:string; compareTargetQty?:string; compareTargetAmount?:string}>>({});
  const [inlinePlanId, setInlinePlanId] = useState<string>();
  const [draftLiveFilters, setDraftLiveFilters] = useState<LiveApprovalFilters>(EMPTY_LIVE_APPROVAL_FILTERS);
  const [appliedLiveFilters, setAppliedLiveFilters] = useState<LiveApprovalFilters>(EMPTY_LIVE_APPROVAL_FILTERS);
  const roleStages = useMemo(() => salesPlanStagesForPermissions(permissionCodes), [permissionCodes]);
  const [liveStageFilter, setLiveStageFilter] = useState<ApprovalStageId | undefined>(() => roleStages[0]);
  const roleKey = roleStages.join(',');
  useEffect(() => {
    const firstStage = salesPlanStagesForPermissions(permissionCodes)[0];
    setLiveStageFilter(firstStage);
    if (queryClient && firstStage) setDimension(APPROVAL_DIMENSIONS_BY_STAGE[firstStage][0]);
    setSelectedRowIds([]);
    setPage(1);
  }, [roleKey]);
  const [selectedRowIds, setSelectedRowIds] = useState(initialState.selectedRowIds);
  const [progressOpen, setProgressOpen] = useState(false);
  const tableViewportRef = useRef<HTMLDivElement>(null);
  const [tableViewportWidth, setTableViewportWidth] = useState(0);
  useEffect(() => {
    const viewport = tableViewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      setTableViewportWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // 登记 51：进入销售计划审批默认不展开筛选，需要时点漏斗图标再展开。
  const [narrowFiltersExpanded, setNarrowFiltersExpanded] = useState(false);
  const filterPanelId = React.useId();
  const [exportFeedback, setExportFeedback] = useState<ExportFeedback>();
  const [detailRowId, setDetailRowId] = useState<string>();
  const [liveDetailPlanId, setLiveDetailPlanId] = useState<string>();
  const [focusedLivePlanId, setFocusedLivePlanId] = useState<string>();
  const [liveVersions, setLiveVersions] = useState<GeaSalesPlanVersion[]>([]);
  const [liveVersionsLoading, setLiveVersionsLoading] = useState(false);
  const [livePrimaryVersionId, setLivePrimaryVersionId] = useState<string>();
  const [liveCompareVersionId, setLiveCompareVersionId] = useState<string>();
  const [liveDetailInitialTab, setLiveDetailInitialTab] = useState<RegionalApprovalLivePlanDetailTab>('skus');
  const [liveAdjustmentMetrics, setLiveAdjustmentMetrics] = useState<Record<string, {quantity: string; amount: string}>>({});
  // 内联明细里当前显示的本节点确认量（用户改过但可能还没落盘）；通过时优先用这份内存值，避免丢数。
  const [livePendingValues, setLivePendingValues] = useState<Record<string, Record<string, string>>>({});
  const [liveActionPlanId, setLiveActionPlanId] = useState<string>();
  const [liveActionKind, setLiveActionKind] = useState<LiveActionKind>('APPROVE');
  // 对话下发的审批确认 / 退回理由草稿；审批本身仍走页面原有的对话框逻辑。
  const [approvalSubmitRequest, setApprovalSubmitRequest] = useState<{ at: number }>();
  const [approvalRemarkPatch, setApprovalRemarkPatch] = useState<{ at: number; remark: string }>();
  const [liveActionReceipts, setLiveActionReceipts] = useState(initialState.liveActionReceipts);
  const [liveAuthorityContext, setLiveAuthorityContext] = useState<SalesPlanAuthorityContext>();
  const handleLiveAdjustmentMetrics = useCallback((planId: string, metrics?: {quantity: string; amount: string}) => {
    setLiveAdjustmentMetrics((current) => {
      if (metrics === undefined) {
        if (!(planId in current)) return current;
        const next = { ...current };
        delete next[planId];
        return next;
      }
      const previous = current[planId];
      if (previous?.quantity === metrics.quantity && previous.amount === metrics.amount) return current;
      return { ...current, [planId]: metrics };
    });
  }, []);
  const handleLivePendingValues = useCallback((planId: string, values: Record<string, string>) => {
    setLivePendingValues((current) => {
      const previous = current[planId];
      const keys = Object.keys(values);
      if (previous && Object.keys(previous).length === keys.length && keys.every((key) => previous[key] === values[key]))
        return current;
      return { ...current, [planId]: values };
    });
  }, []);
  const [permissionDeniedVersions, setPermissionDeniedVersions] = useState<Set<string>>(() => new Set());
  const [actionRowId, setActionRowId] = useState<string>();
  const [detailStore, setDetailStore] = useState<ApprovalDetailStore>(() =>
    readAssistantSurfaceState<ApprovalDetailStore>(
      'forecast',
      `${scopedState}:regional-approval-detail-state`,
      EMPTY_APPROVAL_DETAIL_STORE
    )
  );
  const [actionStore, setActionStore] = useState<RegionalApprovalActionStore>(() =>
    readAssistantSurfaceState<RegionalApprovalActionStore>(
      'forecast',
      `${scopedState}:regional-approval-action-state`,
      EMPTY_REGIONAL_APPROVAL_ACTION_STORE
    )
  );
  const liveQueryScope = useMemo(
    () => ({
      areaCode: appliedLiveFilters.areaCode === ALL_ORGANIZATIONS ? undefined : appliedLiveFilters.areaCode,
      provinceCode: appliedLiveFilters.provinceCode === ALL_ORGANIZATIONS ? undefined : appliedLiveFilters.provinceCode,
      orgCode: appliedLiveFilters.orgCode === ALL_ORGANIZATIONS ? undefined : appliedLiveFilters.orgCode,
      dealerCode: appliedLiveFilters.dealerCode === ALL_ORGANIZATIONS ? undefined : appliedLiveFilters.dealerCode,
      status: appliedLiveFilters.status === ALL_ORGANIZATIONS ? undefined : Number(appliedLiveFilters.status),
    }),
    [appliedLiveFilters]
  );
  const liveQuery = useRegionalApprovalQuery({
    client: queryClient,
    page,
    pageSize,
    scope: liveQueryScope,
    loadStageProgress: queryClient !== null,
    loadAnalysisSummary: queryClient !== null,
    stage: liveStageFilter,
    roles: roleStages,
  });
  const stageRows = useMemo(() => approvalRowsForStage(REGIONAL_APPROVAL_ROWS, currentStage), [currentStage]);
  const filterOptions = useMemo(() => approvalFilterOptions(stageRows, draftFilters), [draftFilters, stageRows]);
  const visibleRows = useMemo(() => projectApprovalRows(stageRows, appliedFilters), [appliedFilters, stageRows]);
  const prioritizedVisibleRows = useMemo(
    () => visibleRows.toSorted((left, right) => fixturePriority(left) - fixturePriority(right)),
    [visibleRows]
  );
  const pageData = useMemo(
    () => paginateApprovalRows(prioritizedVisibleRows, page, pageSize),
    [page, pageSize, prioritizedVisibleRows]
  );
  const filtersDirty = JSON.stringify(draftFilters) !== JSON.stringify(appliedFilters);
  const liveFiltersDirty = JSON.stringify(draftLiveFilters) !== JSON.stringify(appliedLiveFilters);
  const savedAdjustments = useMemo(() => savedApprovalAdjustments(detailStore), [detailStore]);
  const localApprovalResults = useMemo(() => regionalApprovalFixtureResults(actionStore), [actionStore]);
  // 筛选范围内的完整计划集合：分组要覆盖全部数据，再按外层组织行分页。
  const allLiveRows = useMemo(
    () => (liveQuery.queueState.data?.records ?? []).map(toRegionalApprovalLiveRow),
    [liveQuery.queueState.data?.records]
  );
  const draftedAllLiveRows = useMemo(
    () => allLiveRows.map((row) => {
      const metrics = versionMetrics[row.planId];
      const adjusted = liveAdjustmentMetrics[row.planId];
      const next = metrics
        ? {...row,mPlanQty:metrics.baseQty,mPlanAmount:metrics.baseAmount,currentQty:metrics.qty,currentAmount:metrics.amount,targetQty:metrics.targetQty,targetAmount:metrics.targetAmount}
        : row;
      return adjusted
        ? {...next,mPlanQty:adjusted.quantity,mPlanAmount:adjusted.amount,currentQty:adjusted.quantity,currentAmount:adjusted.amount}
        : next;
    }),
    [liveAdjustmentMetrics, allLiveRows, versionMetrics]
  );
  const dimensionStage = liveQuery.enabled ? (liveStageFilter ?? 'category') : currentStage;
  const availableDimensions = APPROVAL_DIMENSIONS_BY_STAGE[dimensionStage];
  const liveStageProgress = liveQuery.progressState.data ?? {
    customer: 0,
    region: 0,
    province: 0,
    area: 0,
    category: 0,
  };

  useEffect(() => {
    if (availableDimensions.includes(dimension)) return;
    setDimension(availableDimensions[0]);
  }, [availableDimensions, dimension]);

  const liveFilterOptions = useMemo(() => {
    const provinceRows =
      draftLiveFilters.areaCode !== ALL_ORGANIZATIONS
        ? allLiveRows.filter((row) => row.areaCode?.trim() === draftLiveFilters.areaCode)
        : allLiveRows;
    const organizationRows =
      draftLiveFilters.provinceCode !== ALL_ORGANIZATIONS
        ? provinceRows.filter((row) => row.provinceCode?.trim() === draftLiveFilters.provinceCode)
        : provinceRows;
    const customerRows =
      draftLiveFilters.orgCode !== ALL_ORGANIZATIONS
        ? organizationRows.filter((row) => row.orgCode?.trim() === draftLiveFilters.orgCode)
        : organizationRows;
    return {
      areas: uniqueLiveNamedFilterOptions(
        allLiveRows,
        (row) => row.areaCode,
        (row) => row.areaName ?? row.regionName
      ),
      provinces: uniqueLiveNamedFilterOptions(
        provinceRows,
        (row) => row.provinceCode,
        (row) => row.provinceName ?? row.provinceRegionName
      ),
      organizations: uniqueLiveNamedFilterOptions(
        organizationRows,
        (row) => row.orgCode,
        (row) => row.orgName ?? row.salesGroupName
      ),
      customers: customerRows
        .map((row) => ({
          dealerCode: String(row.dealerCode ?? '').trim(),
          dealerName: row.dealerName?.trim(),
          baseName: row.baseName?.trim(),
        }))
        .filter(
          (option, index, options) => Boolean(option.dealerCode) && options.findIndex((item) => item.dealerCode === option.dealerCode) === index
        ),
    };
  }, [draftLiveFilters.areaCode, draftLiveFilters.orgCode, draftLiveFilters.provinceCode, allLiveRows]);
  const prioritizedLiveRows = useMemo(
    () => allLiveRows.toSorted((left, right) => livePriority(left) - livePriority(right)),
    [allLiveRows]
  );
  // 外层行分页：先按维度分组，再按组织行翻页；页脚与分页器统计的都是外层行条数。
  // 分组只依赖计划本身，不依赖版本汇总 / 品类汇总，避免“汇总刷新 → 行数组更新 → effect 再跑”的相互触发。
  const liveOuterRows = useMemo(() => {
    const levels: ApprovalDimension[] = ['base', 'area', 'province', 'region', 'customer'];
    const level = levels.indexOf(dimension);
    if (level === levels.length - 1)
      return prioritizedLiveRows.map((plan) => ({ key: `plan:${plan.planId}`, members: [plan] }));
    return groupRegionalApprovalLiveRows(prioritizedLiveRows, levels[level]).map((group) => ({
      key: `group:${group.key}`,
      members: group.members,
    }));
  }, [dimension, prioritizedLiveRows]);
  const livePageCount = Math.max(1, Math.ceil(liveOuterRows.length / Math.max(1, pageSize)));
  const liveCurrentPage = Math.min(clampSalesPlanPageNumber(page), livePageCount);
  const livePageRange = useMemo(
    () => [(liveCurrentPage - 1) * pageSize, liveCurrentPage * pageSize] as const,
    [liveCurrentPage, pageSize]
  );
  const pagedOuterRows = useMemo(
    () => liveOuterRows.slice(livePageRange[0], livePageRange[1]),
    [liveOuterRows, livePageRange]
  );
  // 当前页可见的计划行（未合并版本汇总与本节点调整）：能力预取、选择、导出、详情都只看这一页。
  const liveRows = useMemo(() => pagedOuterRows.flatMap((row) => row.members), [pagedOuterRows]);
  // 展示用：把版本汇总与本节点调整叠加到当前页每条计划上（指标卡、助手上下文也读这份）。
  const draftedRowsByPlanId = useMemo(
    () => new Map(draftedAllLiveRows.map((row) => [String(row.planId), row])),
    [draftedAllLiveRows]
  );
  const draftedLiveRows = useMemo(
    () => liveRows.map((row) => draftedRowsByPlanId.get(String(row.planId)) ?? row),
    [draftedRowsByPlanId, liveRows]
  );
  // 当前位置的展示树：外层行已在分组阶段切好，组内成员不会被拆到两页。
  const liveTableRows = useMemo<RegionalApprovalLiveTableRow[]>(() => {
    const planRows = (plans: RegionalApprovalLiveRow[], childPlan = false): RegionalApprovalLiveTableRow[] =>
      plans.flatMap((plan) => [
        { kind: 'plan' as const, tableRowId: plan.planId, plan, childPlan },
        ...(categoryComparison
          ? (liveCategorySummaries[plan.planId] ?? []).map((category) => ({
              kind: 'category' as const,
              tableRowId: `${plan.planId}:category:${category.categoryName}`,
              plan,
              category,
            }))
          : []),
      ]);
    const levels: ApprovalDimension[] = ['base', 'area', 'province', 'region', 'customer'];
    const build = (plans: RegionalApprovalLiveRow[], level: number, parent = ''): RegionalApprovalLiveTableRow[] =>
      groupRegionalApprovalLiveRows(plans, levels[level]).flatMap((group) => {
        if (level === levels.length - 1) return planRows(group.members, true);
        if (!parent && group.members.length === 1) return planRows(group.members);
        const id = `${parent}/group:${group.key}`;
        return [
          {
            kind: 'plan',
            tableRowId: id,
            plan: group.summary,
            members: group.members,
            displayDimension: levels[level],
            children: build(group.members, level + 1, id),
          },
        ];
      });
    return build(draftedLiveRows, levels.indexOf(dimension));
  }, [categoryComparison, draftedLiveRows, liveCategorySummaries, dimension]);
  const liveTableRowById = useMemo(() => {
    const rows = new Map<string, RegionalApprovalLiveTableRow>();
    const visit = (tableRows: RegionalApprovalLiveTableRow[]) => {
      tableRows.forEach((row) => {
        rows.set(row.tableRowId, row);
        if (row.kind === 'plan' && row.children) visit(row.children);
      });
    };
    visit(liveTableRows);
    return rows;
  }, [liveTableRows]);
  const [expandedLiveGroups, setExpandedLiveGroups] = useState<Array<string | number>>([]);
  // 对话下发的草稿改写（确认计划量），交给对应行的内联编辑器应用。
  const [draftPatch, setDraftPatch] = useState<{
    at: number;
    planId: string;
    quantity: string;
    skuCodes?: string[];
  }>();
  // 已展开行上报的"可编辑字段 + 集合"，合进本页元素清单。
  const [inlineElements, setInlineElements] = useState<
    Record<
      string,
      {
        fields: Array<{ id: string; label: string; value: string; editable: boolean }>;
        collection?: { id: string; label: string; members: string[] };
      }
    >
  >({});
  const handleInlineElements = useCallback(
    (
      planId: string,
      fields: Array<{ id: string; label: string; value: string; editable: boolean }>,
      collection?: { id: string; label: string; members: string[] },
    ) => {
      setInlineElements((current) => {
        const next = { ...current, [planId]: { fields, collection } };
        // 子组件回调身份每轮都会变，内容没变就不要触发父级重渲染。
        return JSON.stringify(next) === JSON.stringify(current) ? current : next;
      });
    },
    [],
  );
  const selectableFixtureRow = (row: RegionalApprovalRow) =>
    row.approvalState === 'pending' && row.permission === 'writable' && row.reachedStage === currentStage;
  const selectedFixtureRows = useMemo(
    () => visibleRows.filter((row) => selectedRowIds.includes(row.id)),
    [selectedRowIds, visibleRows]
  );
  const selectedLiveRows = useMemo(
    () => liveRows.filter((row) => selectedRowIds.includes(row.planId)),
    [liveRows, selectedRowIds]
  );
  const selectedLiveTableRowIds = useMemo(() => {
    const selected = new Set(selectedRowIds);
    const visit = (rows: RegionalApprovalLiveTableRow[]) => {
      rows.forEach((row) => {
        if (row.kind === 'plan' && row.members?.length && row.members.every((member) => selected.has(member.planId))) {
          selected.add(row.tableRowId);
        }
        if (row.kind === 'plan' && row.children) visit(row.children);
      });
    };
    visit(liveTableRows);
    return [...selected];
  }, [liveTableRows, selectedRowIds]);
  const displayStage = liveQuery.enabled ? liveStageFilter : currentStage;
  const effectiveStage: SalesPlanContextApprovalStage = liveQuery.enabled ? (liveStageFilter ?? 'all') : currentStage;
  const contextAppliedFilters = useMemo<ApprovalContextFilters>(
    () =>
      liveQuery.enabled
        ? {
            area: appliedLiveFilters.areaCode,
            branch: appliedLiveFilters.provinceCode,
            department: appliedLiveFilters.orgCode,
            customer: appliedLiveFilters.dealerCode,
            approval: appliedLiveFilters.status,
            health: ALL_ORGANIZATIONS,
          }
        : appliedFilters,
    [appliedFilters, appliedLiveFilters, liveQuery.enabled]
  );
  const activeDetailRow = visibleRows.find((row) => row.id === detailRowId);
  const activeLiveDetailRow = liveRows.find((row) => row.planId === liveDetailPlanId);
  const focusedLiveRow = liveRows.find((row) => row.planId === focusedLivePlanId) ?? liveRows[0];
  const scopedPrimaryVersionId = liveVersions.some(
    (version) => version.planId === focusedLiveRow?.planId && version.id === livePrimaryVersionId
  )
    ? livePrimaryVersionId
    : undefined;
  const scopedCompareVersionId = liveVersions.some(
    (version) => version.planId === focusedLiveRow?.planId && version.id === liveCompareVersionId
  )
    ? liveCompareVersionId
    : undefined;
  useEffect(() => {
    if (!detailClient || !liveQuery.enabled || !liveRows.length) {setVersionMetrics({});setLiveCategorySummaries({});return;}
    const requestId = ++liveCategoriesRequest.current;
    const controller = new AbortController();
    const reference = liveVersions.find(v => v.id === focusedLiveRow?.versionId);
    const primary = liveVersions.find(v => v.id === scopedPrimaryVersionId);
    const compare = liveVersions.find(v => v.id === scopedCompareVersionId);
    const primaryOffset = primary && reference ? reference.seq - primary.seq : 0;
    const compareOffset = compare && reference ? reference.seq - compare.seq : primaryOffset;
    setLiveCategoriesLoading(true);
    setVersionMetrics({});
    void (async () => {
      const metrics: typeof versionMetrics = {};
      const categories: typeof liveCategorySummaries = {};
      for (const row of liveRows) {
        controller.signal.throwIfAborted();
        const versions = primaryOffset || compareOffset ? await detailClient.versions.invoke({planId:row.planId,signal:controller.signal}) : [];
        const current = versions.find(v=>v.id===row.versionId);
        const chosen = primaryOffset ? versions.find(v=>current && v.seq===current.seq-primaryOffset) : undefined;
        const versionId = primaryOffset ? chosen?.id : row.versionId;
        if (!versionId) {metrics[row.planId]={qty:'—',amount:'—',baseQty:'—',baseAmount:'—',targetQty:'',targetAmount:''};continue;}
        const skus = await detailClient.versionSkus.invoke({versionId,signal:controller.signal});
        categories[row.planId]=aggregateRegionalApprovalLiveCategories(skus);
        const aggregate = aggregateRegionalApprovalLiveCategories(skus);
        metrics[row.planId]={versionId,qty:addExactDecimals(aggregate.map(c=>c.quantity)),amount:addExactDecimals(aggregate.map(c=>c.amount)),baseQty:addExactDecimals(aggregate.map(c=>c.baseQuantity)),baseAmount:addExactDecimals(aggregate.map(c=>c.baseAmount)),
          targetQty:String(primaryOffset ? chosen?.targetQty ?? '' : row.targetQty),targetAmount:String(primaryOffset ? chosen?.targetAmount ?? '' : row.targetAmount)};
        if (compareOffset !== primaryOffset) {
          const other = compareOffset ? versions.find(v=>current && v.seq===current.seq-compareOffset) : current;
          if (other) {
            const compared = aggregateRegionalApprovalLiveCategories(await detailClient.versionSkus.invoke({versionId:other.id,signal:controller.signal}));
            metrics[row.planId].compareTargetQty=String(other.targetQty ?? '');
            metrics[row.planId].compareTargetAmount=String(other.targetAmount ?? '');
            metrics[row.planId].compareQty=addExactDecimals(compared.map(c=>c.quantity));
            metrics[row.planId].compareAmount=addExactDecimals(compared.map(c=>c.amount));
          }
        }
      }
      if (!controller.signal.aborted) {setVersionMetrics(metrics);setLiveCategorySummaries(categories);}
    })().catch(()=>{}).finally(()=>{if(liveCategoriesRequest.current===requestId)setLiveCategoriesLoading(false);});
    return ()=>controller.abort();
  },[detailClient,liveRows,scopedPrimaryVersionId,scopedCompareVersionId]);
  const historicalSummaryUnavailable = Boolean(
    liveQuery.enabled && scopedPrimaryVersionId && scopedPrimaryVersionId !== focusedLiveRow?.versionId
  );
  const scopeSummary = useMemo<typeof liveQuery.analysisSummary>(
    () => (historicalSummaryUnavailable ? { status: 'error', error: 'unavailable' } : liveQuery.analysisSummary),
    [historicalSummaryUnavailable, liveQuery.analysisSummary]
  );
  const liveAccess = useSalesPlanAccess(
    liveRows,
    detailClient,
    liveQuery.enabled && liveActionsEnabled && liveQuery.queueState.status === 'success'
  );

  // 有权限审批的节点只来自当前账号的审批权限码，不再采集待办通知或服务端角色能力。
  const authorizedStages = useMemo(
    () => roleStages.filter((stage): stage is Exclude<ApprovalStageId, 'customer'> => stage !== 'customer'),
    [roleStages]
  );
  // 流程图收起态的节点口径：与展开态高亮一致（用户所选的节点，默认即其第一个有权限审批的节点）。
  const stageIndicatorStage = displayStage ?? authorizedStages[0];
  // 默认节点：权限码给出的已在上面的 effect 设好；这里补“没有权限码、但服务端给了同版本可处理任务”的账号，
  // 且只自动设一次，之后用户自己切到「全部节点」或别的节点都不再覆盖。
  const defaultStageApplied = useRef(false);
  useEffect(() => {
    if (!liveQuery.enabled || defaultStageApplied.current) return;
    if (liveStageFilter !== undefined) {
      defaultStageApplied.current = true;
      return;
    }
    const fallback = authorizedStages[0];
    if (!fallback) return;
    defaultStageApplied.current = true;
    setLiveStageFilter(fallback);
    setDimension(APPROVAL_DIMENSIONS_BY_STAGE[fallback][0]);
    setSelectedRowIds([]);
    setPage(1);
  }, [authorizedStages, liveQuery.enabled, liveStageFilter]);


  const refreshLiveAuthority = () => {
    setPermissionDeniedVersions(new Set());
    liveAccess.refresh();
    liveQuery.retryQueue();
  };
  const activeLiveActionRow = liveRows.find((row) => row.planId === liveActionPlanId);
  const activeActionRow = visibleRows.find((row) => row.id === actionRowId);
  const contextFilterSummary = useMemo(
    () =>
      buildSalesPlanFilterSummary({
        periodMonth: liveQuery.selectedPeriodMonth ?? (liveQuery.enabled ? undefined : '2026-09'),
        planTypeCode: liveQuery.selectedPlanTypeCode ?? (liveQuery.enabled ? undefined : 'monthly'),
        approvalStage: effectiveStage,
        queueMode: 'approval',
        appliedFilters: contextAppliedFilters,
      }),
    [contextAppliedFilters, effectiveStage, liveQuery.enabled, liveQuery.selectedPeriodMonth, liveQuery.selectedPlanTypeCode]
  );

  useEffect(() => {
    const planId = focusedLiveRow?.planId;
    const currentVersionId = focusedLiveRow?.versionId;
    if (!liveQuery.enabled || !detailClient || !planId || !currentVersionId) {
      setLiveVersions([]);
      setLiveVersionsLoading(false);
      setLivePrimaryVersionId(undefined);
      setLiveCompareVersionId(undefined);
      return;
    }
    const controller = new AbortController();
    setLiveVersionsLoading(true);
    void detailClient.versions
      .invoke({ planId, signal: controller.signal })
      .then((versions) => {
        if (controller.signal.aborted) return;
        const matchingVersions = versions
          .filter((version) => version.planId === planId)
          .toSorted((left, right) => right.seq - left.seq);
        const currentVersion = matchingVersions.find((version) => version.id === currentVersionId);
        if (!currentVersion) {
          setLiveVersions([]);
          setLivePrimaryVersionId(undefined);
          setLiveCompareVersionId(undefined);
          return;
        }
        const currentIndex = matchingVersions.findIndex((version) => version.id === currentVersion.id);
        const previousVersion = matchingVersions[currentIndex + 1] ?? currentVersion;
        setLiveVersions(matchingVersions);
        setLivePrimaryVersionId(currentVersion.id);
        setLiveCompareVersionId(previousVersion.id);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLiveVersions([]);
        setLivePrimaryVersionId(undefined);
        setLiveCompareVersionId(undefined);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLiveVersionsLoading(false);
      });
    return () => controller.abort();
  }, [detailClient, focusedLiveRow?.planId, focusedLiveRow?.versionId, liveQuery.enabled]);

  const liveActionDisabledReason = (row: RegionalApprovalLiveRow, kind: LiveActionKind = 'APPROVE') => {
    if (historicalSummaryUnavailable) return 'queueNotFresh';
    if (!liveActionsEnabled) return 'missingAuthority';

    if (permissionDeniedVersions.has(row.versionId)) return 'permission';
    if (liveQuery.queueState.status !== 'success') return 'queueNotFresh';
    if (liveAccess.failedVersions.has(row.versionId)) return 'detailUnavailable';
    const detail = liveAccess.entries[row.versionId];
    if (!detail || !(liveStageFilter ? [liveStageFilter] : ['region','province','area','category'] as const).some(role => salesPlanAccessForRow(row, detail, permissionCodes, role)?.allowedActions.includes(kind)))
      return 'missingAuthority';
    if (kind === 'SAVE') return undefined;

    return undefined;
  };
  const liveRowCanApprove = (row: RegionalApprovalLiveRow) =>
    !liveActionDisabledReason(row, 'APPROVE');
  const metrics = useMemo(() => {
    if (liveQuery.enabled) {
      const detailMetrics = liveRows.map((row) => versionMetrics[row.planId]);
      const hasCompleteDetailMetrics =
        detailMetrics.length === liveRows.length &&
        detailMetrics.length > 0 &&
        detailMetrics.every(
          (detail) =>
            detail &&
            /^-?\d+(?:\.\d+)?$/.test(detail.baseQty) &&
            /^-?\d+(?:\.\d+)?$/.test(detail.baseAmount)
        );
      return {
        visibleCount: liveRows.length,
        pendingCount: liveRows.filter((row) => row.approvalState === 'pending').length,
        warningCount: liveRows.filter((row) => row.approvalState === 'returned').length,
        // 汇总读展示行（含版本汇总与本节点调整），和表格里看到的数保持一致。
        quantity: draftedLiveRows.length === 0
          ? '0'
          : draftedLiveRows.every((row) => /^-?\d+(?:\.\d+)?$/.test(row.currentQty))
            ? addExactDecimals(draftedLiveRows.map((row) => row.currentQty))
            : hasCompleteDetailMetrics ? addExactDecimals(detailMetrics.map((detail) => detail!.baseQty)) : '—',
        amount: draftedLiveRows.length === 0
          ? '0'
          : draftedLiveRows.every((row) => /^-?\d+(?:\.\d+)?$/.test(row.currentAmount))
            ? addExactDecimals(draftedLiveRows.map((row) => row.currentAmount))
            : hasCompleteDetailMetrics ? addExactDecimals(detailMetrics.map((detail) => detail!.baseAmount)) : '—',
        targetAmount: addExactDecimals(draftedLiveRows.map((row) => row.targetAmount)),
        savedAdjustmentCount: 0,
        localApprovalResultCount: 0,
      };
    }
    return {
      visibleCount: visibleRows.length,
      pendingCount: visibleRows.filter((row) => row.approvalState === 'pending').length,
      warningCount: visibleRows.filter((row) => row.health === 'warning').length,
      quantity: addExactDecimals(
        visibleRows.map((row) => String(metricsForApprovalVersion(row, primaryVersion).quantity))
      ),
      amount: addExactDecimals(visibleRows.map((row) => String(metricsForApprovalVersion(row, primaryVersion).amount))),
      targetAmount: undefined as string | undefined,
      savedAdjustmentCount: savedAdjustments.length,
      localApprovalResultCount: localApprovalResults.length,
    };
  }, [
    scopeSummary,
    draftedLiveRows,
    liveRows,
    liveQuery.enabled,
    localApprovalResults.length,
    primaryVersion,
    savedAdjustments.length,
    visibleRows,
    versionMetrics,
  ]);
  const dashboardReady = liveQuery.queueState.status === 'success' && !liveCategoriesLoading;
  const amountVariance =
    metrics.targetAmount !== undefined && metrics.amount !== '—'
      ? subtractExactDecimals(metrics.amount, metrics.targetAmount)
      : undefined;

  useEffect(() => {
    writeAssistantSurfaceState('forecast', `${scopedState}:approval-stage`, currentStage);
    writeAssistantSurfaceState<PersistedApprovalWorkbenchState>('forecast', `${scopedState}:regional-approval-state`, {
      currentStage,
      draftFilters,
      appliedFilters,
      primaryVersion,
      compareVersion,
      page,
      pageSize,
      dimension,
      categoryComparison,
      stageLaneOpen,
      selectedRowIds,
      liveActionReceipts,
    });
  }, [
    appliedFilters,
    categoryComparison,
    stageLaneOpen,
    compareVersion,
    currentStage,
    dimension,
    draftFilters,
    liveActionReceipts,
    page,
    pageSize,
    primaryVersion,
    scopedState,
    selectedRowIds,
  ]);

  useEffect(() => {
    writeAssistantSurfaceState('forecast', `${scopedState}:regional-approval-detail-state`, detailStore);
  }, [detailStore, scopedState]);

  useEffect(() => {
    setLiveDetailPlanId(undefined);
    setLiveActionPlanId(undefined);
    setLiveAuthorityContext(undefined);
    setPermissionDeniedVersions(new Set());
  }, [appliedFilters, appliedLiveFilters, currentStage, liveQuery.selectedPeriodMonth, page, pageSize]);

  useEffect(() => {
    writeAssistantSurfaceState('forecast', `${scopedState}:regional-approval-action-state`, actionStore);
  }, [actionStore, scopedState]);

  useEffect(() => {
    if (!liveQuery.enabled) {
      if (page !== pageData.page) setPage(pageData.page);
      return;
    }
    if (liveQuery.queueState.status !== 'success') return;
    // 分页改为按分组后的外层行：页码只受本地页数约束，数据变化后越界就回到最后一页。
    if (page !== liveCurrentPage) setPage(liveCurrentPage);
  }, [liveQuery.enabled, liveQuery.queueState.status, page, liveCurrentPage, pageData.page]);

  const liveEvidence = useMemo<RegionalApprovalWorkbenchContext['evidence']>(() => {
    if (!liveQuery.enabled) {
      return {
        source: 'fixture',
        permission: 'read-only',
        completeness: 'skeleton',
        queryState: 'fixture',
        dataVersion: 'regional-approval-fixture-v3',
      };
    }

    const queueData = liveQuery.queueState.data;
    const queryError =
      liveQuery.queueState.status === 'error'
        ? liveQuery.queueState.error
        : liveQuery.periodsState.status === 'error'
          ? liveQuery.periodsState.error
          : undefined;
    if (queueData) {
      return {
        source: 'gea-user-session',
        permission: 'read-only',
        completeness: 'paged-queue',
        queryState: queryError
          ? 'stale-error'
          : liveQuery.queueState.status === 'loading' || liveQuery.periodsState.status === 'loading'
            ? 'refreshing'
            : queueData.records.length === 0
              ? 'empty'
              : 'success',
        error: queryError,
        dataVersion: 'sales-plan-v1.11',
      };
    }

    if (liveQuery.periodsState.status === 'success') {
      return {
        source: 'gea-user-session',
        permission: 'read-only',
        completeness: 'periods-only',
        queryState:
          liveQuery.periods.length === 0
            ? 'empty-periods'
            : liveQuery.queueState.status === 'error'
              ? 'error'
              : 'loading',
        error: queryError,
        dataVersion: 'sales-plan-v1.11',
      };
    }

    return {
      source: 'unverified',
      permission: 'read-only',
      completeness: 'none',
      queryState: queryError ? 'error' : 'loading',
      error: queryError,
      dataVersion: 'unverified',
    };
  }, [liveQuery.enabled, liveQuery.periods.length, liveQuery.periodsState, liveQuery.queueState]);

  // 这一屏"渲染出来的元素"：行 / 控件 / 可编辑字段，供页面桥声明给模型。
  const catalogElements = useMemo<PageElement[]>(() => {
    if (!liveQuery.enabled) return [];
    const fields = liveRows.flatMap((row) =>
      expandedLiveGroups.includes(row.planId)
        ? inlineElements[row.planId]?.fields ?? []
        : [],
    );
    // 每一行都给一个"整行一起改"的集合：不必先展开，页面收到后会自己展开并加载 SKU。
    const collections = liveRows.map((row) => {
      const label =
        projectRegionalApprovalLiveDimension(row, dimension).name ?? row.planId;
      const members = (inlineElements[row.planId]?.fields ?? []).map(
        (field) => field.id,
      );
      return {
        id: `collection:${row.planId}:qty`,
        label: `${label} 全部 SKU 的确认计划量（无需展开，填同一个值）`,
        members,
      };
    });
    const detailRow = liveRows.find((row) => row.planId === liveDetailPlanId);
    return buildWorkbenchElements({
      rows: liveRows.map((row) => ({
        planId: row.planId,
        // label 不带勾选状态：勾选变化不该让元素清单整份变掉（它已经在页面状态里）。
        label:
          projectRegionalApprovalLiveDimension(row, dimension).name ?? row.planId,
        value: String(row.currentAmount ?? ""),
        expanded: expandedLiveGroups.includes(row.planId),
      })),
      selectedPlanIds: selectedRowIds,
      stage: liveStageFilter ?? "all",
      stageOptions: [
        { value: "all", label: "不限阶段" },
        ...roleStages.map((stage) => ({
          value: stage,
          label: t(stageLabelKey(stage)),
        })),
      ],
      filters: [
        {
          field: "areaCode",
          label: "大区筛选",
          value: appliedLiveFilters.areaCode,
          options: liveFilterOptions.areas.map((option) => ({
            value: option.value,
            label: option.label ?? option.value,
          })),
        },
        {
          field: "provinceCode",
          label: "省区筛选",
          value: appliedLiveFilters.provinceCode,
          options: liveFilterOptions.provinces.map((option) => ({
            value: option.value,
            label: option.label ?? option.value,
          })),
        },
        {
          field: "orgCode",
          label: "组织筛选",
          value: appliedLiveFilters.orgCode,
          options: liveFilterOptions.organizations.map((option) => ({
            value: option.value,
            label: option.label ?? option.value,
          })),
        },
        {
          field: "dealerCode",
          label: "经销商筛选",
          value: appliedLiveFilters.dealerCode,
          options: liveFilterOptions.customers.map((option) => ({
            value: option.dealerCode,
            label: option.dealerName ?? option.baseName ?? option.dealerCode,
          })),
        },
        {
          field: "status",
          label: "状态筛选",
          value: appliedLiveFilters.status,
          options: [],
        },
      ],
      page,
      pages: liveQuery.queueState.data?.pages ?? 1,
      ...(detailRow && liveDetailPlanId
        ? {
            detail: {
              planId: liveDetailPlanId,
              label:
                projectRegionalApprovalLiveDimension(detailRow, dimension).name ??
                detailRow.planId,
            },
          }
        : {}),
      fields,
      collections,
      ...(() => {
        // 工具栏动作：只有按钮当前可点时才声明，和人工能点的范围一致。
        const actionRow = selectedLiveRows.length === 1 ? selectedLiveRows[0] : undefined;
        const actionElements: Array<{
          id: string;
          label: string;
          actions: string[];
        }> = [];
        if (liveActionsEnabled && actionRow) {
          if (!liveActionDisabledReason(actionRow))
            actionElements.push({
              id: "action:approve",
              label: `通过（${projectRegionalApprovalLiveDimension(actionRow, dimension).name ?? actionRow.planId}）`,
              actions: ["invoke"],
            });
          if (
            actionRow.status !== 5 &&
            !liveActionDisabledReason(actionRow, "REJECT")
          )
            actionElements.push({
              id: "action:reject",
              label: `退回（${projectRegionalApprovalLiveDimension(actionRow, dimension).name ?? actionRow.planId}）`,
              actions: ["invoke"],
            });
        }
        return actionElements.length === 0 ? {} : { actionElements };
      })(),
      ...(activeLiveActionRow
        ? {
            dialog: {
              label: `${liveActionKind === "REJECT" ? "退回" : "通过"}审批对话框（${
                projectRegionalApprovalLiveDimension(activeLiveActionRow, dimension).name ??
                activeLiveActionRow.planId
              }）`,
              actions:
                liveActionKind === "APPROVE" ? [] : ["confirm", "cancel"],
              fields:
                liveActionKind === "REJECT"
                  ? [
                      {
                        id: "dialog:approval:remark",
                        label: "退回理由",
                        value: "",
                        editable: true,
                      },
                    ]
                  : [],
            },
          }
        : {}),
    });
  }, [
    appliedLiveFilters,
    dimension,
    expandedLiveGroups,
    inlineElements,
    liveDetailPlanId,
    liveFilterOptions,
    liveQuery.enabled,
    liveQuery.queueState.data?.pages,
    liveRows,
    liveStageFilter,
    page,
    roleStages,
    selectedRowIds,
    t,
  ]);

  useEffect(() => {
    const usingLiveQueue = liveQuery.enabled;
    const selectedAuthority =
      usingLiveQueue && selectedLiveRows.length === 1
        ? liveAuthorityContext?.planId === selectedLiveRows[0].planId &&
          liveAuthorityContext.source === 'gea-user-session-action'
          ? liveAuthorityContext
          : projectSalesPlanQueryContext(selectedLiveRows[0], contextFilterSummary)
        : undefined;
    const authority = usingLiveQueue
      ? (selectedAuthority ??
        (liveQuery.queueState.status === 'success'
          ? projectSalesPlanQueryContext(undefined, contextFilterSummary)
          : undefined))
      : projectFixtureSalesPlanContext(contextFilterSummary);
    onContextChange(
      {
        ...(usingLiveQueue && automaticAnalysisEnabled ? { analysisSummary: scopeSummary } : {}),
        view: 'regional-approval',
        fixtureState: usingLiveQueue ? 'live' : 'ready',
        scope: {
          dimension,
          categoryComparison,
          ...(usingLiveQueue
            ? {
                primaryVersionId: scopedPrimaryVersionId,
                compareVersionId: scopedCompareVersionId,
                versionReferencePlanId: focusedLiveRow?.planId,
                currentVersionId: focusedLiveRow?.versionId,
              }
            : {}),
          planType: liveQuery.selectedPlanTypeCode ?? (usingLiveQueue && liveQuery.selectedPeriods.length > 1 ? 'mixed' : usingLiveQueue ? 'unknown' : 'monthly'),
          month: liveQuery.selectedPeriodMonth ?? (usingLiveQueue ? '' : '2026-09'),
          approvalStage: effectiveStage,
          authority: 'organization',
          primaryVersion: usingLiveQueue ? 'current' : primaryVersion,
          compareVersion: usingLiveQueue ? 'previous' : compareVersion,
          appliedFilters: contextAppliedFilters,
        },
        visibleEntities: usingLiveQueue
          ? draftedLiveRows.map((row) => projectLiveContextEntity(row, dimension))
          : visibleRows.map((row) => projectFixtureContextEntity(row, primaryVersion)),
        selectedEntities: usingLiveQueue
          ? selectedLiveRows.map((row) => projectLiveContextEntity(row, dimension))
          : selectedFixtureRows.map((row) => projectFixtureContextEntity(row, primaryVersion)),
        expandedPlanIds: usingLiveQueue
          ? expandedLiveGroups.filter((id): id is string => typeof id === 'string')
          : [],
        expandedFields: usingLiveQueue
          ? liveRows
              .filter((row) => expandedLiveGroups.includes(row.planId))
              .flatMap((row) => inlineElements[row.planId]?.fields ?? [])
              .slice(0, 120)
          : [],
        changes: usingLiveQueue ? [] : savedAdjustments,
        localApprovalResults: usingLiveQueue ? [] : localApprovalResults,
        metrics,
        pagination: usingLiveQueue
          ? {
              // 与界面一致：分页对象是分组后的外层组织行。
              page: liveCurrentPage,
              pageSize,
              total: liveOuterRows.length,
            }
          : { page: pageData.page, pageSize: pageData.pageSize, total: pageData.total },
        evidence: liveEvidence,
        authority,
      },
      conversationId
    );
  }, [
    automaticAnalysisEnabled,
    scopeSummary,
    dimension,
    categoryComparison,
    scopedPrimaryVersionId,
    scopedCompareVersionId,
    focusedLiveRow?.planId,
    focusedLiveRow?.versionId,
    compareVersion,
    contextAppliedFilters,
    conversationId,
    currentStage,
    metrics,
    localApprovalResults,
    liveQuery.enabled,
    liveQuery.queueState.data,
    liveQuery.selectedPeriodMonth,
    liveQuery.selectedPeriods.length,
    liveQuery.selectedPlanTypeCode,
    liveEvidence,
    liveAuthorityContext,
    draftedLiveRows,
    liveRows,
    liveCurrentPage,
    liveOuterRows,
    expandedLiveGroups,
    onContextChange,
    page,
    pageData,
    pageSize,
    primaryVersion,
    savedAdjustments,
    selectedFixtureRows,
    selectedLiveRows,
    contextFilterSummary,
    visibleRows,
  ]);

  const selectLivePlanContext = (row: RegionalApprovalLiveRow) => {
    setLiveAuthorityContext(projectSalesPlanQueryContext(row, contextFilterSummary));
  };

  const changeStage = (stage: ApprovalStageId) => {
    if (liveQuery.enabled) {
      const nextStage = liveStageFilter === stage ? undefined : stage;
      setLiveStageFilter(nextStage);
      setDimension(APPROVAL_DIMENSIONS_BY_STAGE[nextStage ?? 'category'][0]);
      setDraftLiveFilters((current) => ({ ...current, status: ALL_ORGANIZATIONS }));
      setAppliedLiveFilters((current) => ({ ...current, status: ALL_ORGANIZATIONS }));
      setSelectedRowIds([]);
      setPage(1);
      return;
    }
    const nextRows = approvalRowsForStage(REGIONAL_APPROVAL_ROWS, stage);
    setCurrentStage(stage);
    setDraftFilters((current) => normalizeApprovalFilters(nextRows, current));
    setAppliedFilters((current) => normalizeApprovalFilters(nextRows, current));
    setDimension(APPROVAL_DIMENSIONS_BY_STAGE[stage][0]);
    setSelectedRowIds([]);
    setPage(1);
    setExportFeedback(undefined);
  };

  const updateDraftFilter = <Field extends ApprovalOrganizationFilterField>(
    field: Field,
    value: ApprovalOrganizationFilters[Field]
  ) => {
    setDraftFilters((current) => updateApprovalFilter(stageRows, current, field, value));
    setExportFeedback(undefined);
  };

  const updateLiveDraftFilter = (field: keyof LiveApprovalFilters, value: string) => {
    if (field === 'status') setLiveStageFilter(undefined);
    const next = { ...draftLiveFilters, [field]: value };
    if (field === 'areaCode') {
      next.provinceCode = ALL_ORGANIZATIONS;
      next.orgCode = ALL_ORGANIZATIONS;
      next.dealerCode = ALL_ORGANIZATIONS;
    } else if (field === 'provinceCode') {
      next.orgCode = ALL_ORGANIZATIONS;
      next.dealerCode = ALL_ORGANIZATIONS;
    } else if (field === 'orgCode') {
      next.dealerCode = ALL_ORGANIZATIONS;
    }
    setDraftLiveFilters(next);
    setAppliedLiveFilters(next);
    setSelectedRowIds([]);
    setPage(1);
    setExportFeedback(undefined);
  };

  const applyFilters = () => {
    if (liveQuery.enabled) {
      setAppliedLiveFilters(draftLiveFilters);
      setSelectedRowIds([]);
      setPage(1);
      return;
    }
    setAppliedFilters(draftFilters);
    setSelectedRowIds([]);
    setPage(1);
  };

  const resetFilters = () => {
    if (liveQuery.enabled) {
      setDraftLiveFilters(EMPTY_LIVE_APPROVAL_FILTERS);
      setAppliedLiveFilters(EMPTY_LIVE_APPROVAL_FILTERS);
      setLiveStageFilter(undefined);
      setSelectedRowIds([]);
      setPage(1);
      setExportFeedback(undefined);
      return;
    }
    setDraftFilters(DEFAULT_APPROVAL_FILTERS);
    setAppliedFilters(DEFAULT_APPROVAL_FILTERS);
    setSelectedRowIds([]);
    setPage(1);
    setExportFeedback(undefined);
  };

  const applyHealthFilter = (health: ApprovalHealth) => {
    const nextFilters = { ...draftFilters, health };
    setDraftFilters(nextFilters);
    setAppliedFilters(nextFilters);
    setSelectedRowIds([]);
    setPage(1);
  };

  const changePrimaryVersion = (version: ApprovalVersion) => {
    setSelectedRowIds([]);
    setPrimaryVersion(version);
    if (approvalVersionOffset(version) > approvalVersionOffset(compareVersion)) {
      setCompareVersion(version);
    } else if (version === compareVersion && approvalVersionOffset(version) > 0) {
      setCompareVersion(APPROVAL_VERSIONS[approvalVersionOffset(version) - 1]);
    }
    setPage(1);
  };

  const changeCompareVersion = (version: ApprovalVersion) => {
    setSelectedRowIds([]);
    setCompareVersion(version);
    if (approvalVersionOffset(primaryVersion) > approvalVersionOffset(version)) setPrimaryVersion(version);
    setPage(1);
  };

  const openDetail = (row: RegionalApprovalRow) => {
    if (selectableFixtureRow(row)) setSelectedRowIds([row.id]);
    setDetailRowId(row.id);
  };
  const openAction = (row: RegionalApprovalRow) => setActionRowId(row.id);

  const versionLabel = (version: ApprovalVersion) => t(`common.assistantSurface.regionalApproval.versions.${version}`);

  const liveVersionLabel = (versionId: string) => {
    const offset = liveVersions.findIndex((version) => version.id === versionId);
    return offset <= 0
      ? t('common.assistantSurface.regionalApproval.versions.current')
      : t('common.assistantSurface.regionalApproval.versions.offset', { offset });
  };

  const openLiveVersionComparison = (primaryVersionId: string, compareVersionId: string) => {
    const row = focusedLiveRow;
    if (!row) return;
    setLivePrimaryVersionId(primaryVersionId);
    setLiveCompareVersionId(compareVersionId);
    setSelectedRowIds([]);
    setLiveAuthorityContext(undefined);
    setLiveDetailInitialTab('compare');
    setLiveDetailPlanId(row.planId);
  };

  const changeLivePrimaryVersion = (versionId: string) => {
    const primary = liveVersions.find((version) => version.id === versionId);
    const compare = liveVersions.find((version) => version.id === liveCompareVersionId);
    if (!primary) return;
    openLiveVersionComparison(primary.id, compare && compare.seq <= primary.seq ? compare.id : primary.id);
  };

  const changeLiveCompareVersion = (versionId: string) => {
    const primary = liveVersions.find((version) => version.id === livePrimaryVersionId);
    const compare = liveVersions.find((version) => version.id === versionId);
    if (!compare) return;
    openLiveVersionComparison(primary && primary.seq >= compare.seq ? primary.id : compare.id, compare.id);
  };

  // AG-UI 前端工具：右侧对话让页面改这一屏怎么看，只改视图，不改任何 GEA 数据。
  // 参数是外部来源，先按当前可见行核对 planId，再走和手动操作一样的 setState；
  // 结果统一按 AG-UI 的 tool 消息回填（失败必须带 error）。
  const appliedToolCallRef = useRef<string>();
  // 始终指向最新的字段上报，供 apply 等待"值真的落上去"。
  const inlineElementsRef = useRef(inlineElements);
  inlineElementsRef.current = inlineElements;
  // 元素清单改变时上报给页面桥（独立通道，不进页面状态快照）。
  useEffect(() => {
    onCatalogChange?.(catalogElements);
  }, [catalogElements, onCatalogChange]);
  useEffect(() => {
    if (!toolCall || appliedToolCallRef.current === toolCall.toolCallId) return;
    appliedToolCallRef.current = toolCall.toolCallId;
    void (async () => {
    const { toolCallId, command } = toolCall;
    const settled = (applied: boolean, error?: string) =>
      onToolResult?.(toolCallId, applied, error);
    // 只有已经连上实时查询的工作台才能被改动；只读夹具页如实回报失败。
    if (!liveQuery.enabled) {
      settled(false, "WORKBENCH_NOT_LIVE");
      return;
    }
    const args = command;
    const kind = typeof args.kind === "string" ? args.kind : "";
    const targets = [
      ...(typeof args.target === "string" ? [args.target] : []),
      ...(Array.isArray(args.targets)
        ? (args.targets as unknown[]).filter(
            (value): value is string => typeof value === "string",
          )
        : []),
    ];
    const value = typeof args.value === "string" ? args.value : undefined;
    const action = typeof args.action === "string" ? args.action : undefined;
    const rejectWith = (error: string) => settled(false, error);

    switch (kind) {
      case "invoke": {
        for (const id of targets) {
          if (id === "detail" && action === "close") {
            setLiveDetailPlanId(undefined);
            continue;
          }
          if (id === "filters" && action === "reset") {
            resetFilters();
            continue;
          }
          if (id === "action:approve" || id === "action:reject") {
            const row = selectedLiveRows.length === 1 ? selectedLiveRows[0] : undefined;
            if (!row) return rejectWith("NO_SELECTED_ROW");
            const kind = id === "action:approve" ? "APPROVE" : "REJECT";
            if (liveActionDisabledReason(row, kind === "REJECT" ? "REJECT" : undefined))
              return rejectWith("ACTION_NOT_ALLOWED");
            selectLivePlanContext(row);
            setLiveActionKind(kind);
            setLiveActionPlanId(row.planId);
            continue;
          }
          if (id === "dialog:approval") {
            if (action === "confirm") {
              setApprovalSubmitRequest({ at: Date.now() });
              continue;
            }
            if (action === "cancel") {
              setLiveActionPlanId(undefined);
              continue;
            }
            return rejectWith("ACTION_NOT_ALLOWED");
          }
          if (id.startsWith("row:")) {
            const planId = id.slice("row:".length);
            if (action === "expand") {
              setExpandedLiveGroups((current) =>
                current.includes(planId) ? current : [...current, planId],
              );
            } else if (action === "collapse") {
              setExpandedLiveGroups((current) =>
                current.filter((candidate) => candidate !== planId),
              );
            } else if (action === "openDetail") {
              const row = liveRows.find((candidate) => candidate.planId === planId);
              if (!row) return rejectWith("PLAN_NOT_ON_CURRENT_PAGE");
              selectLivePlanContext(row);
              setLiveDetailPlanId(row.planId);
            } else {
              return rejectWith("ACTION_NOT_ALLOWED");
            }
            continue;
          }
          return rejectWith("UNKNOWN_ELEMENT");
        }
        break;
      }
      case "select": {
        if (targets.some((id) => !id.startsWith("row:")))
          return rejectWith("UNKNOWN_ELEMENT");
        setSelectedRowIds([...new Set(targets.map((id) => id.slice("row:".length)))]);
        break;
      }
      case "setValue": {
        if (value === undefined) return rejectWith("MISSING_VALUE");
        for (const id of targets) {
          if (id === "stage") {
            const stage = value === "all" ? undefined : (value as ApprovalStageId);
            setLiveStageFilter(stage);
            setDimension(APPROVAL_DIMENSIONS_BY_STAGE[stage ?? "category"][0]);
            setDraftLiveFilters((current) => ({
              ...current,
              status: ALL_ORGANIZATIONS,
            }));
            setAppliedLiveFilters((current) => ({
              ...current,
              status: ALL_ORGANIZATIONS,
            }));
            setSelectedRowIds([]);
            setPage(1);
            continue;
          }
          if (id === "pager") {
            const next = Number(value);
            const pages = liveQuery.queueState.data?.pages ?? 1;
            if (!Number.isInteger(next) || next < 1 || next > pages)
              return rejectWith("PAGE_OUT_OF_RANGE");
            setPage(next);
            setSelectedRowIds([]);
            continue;
          }
          if (id.startsWith("filter:")) {
            updateLiveDraftFilter(
              id.slice("filter:".length) as keyof LiveApprovalFilters,
              value,
            );
            continue;
          }
          if (id === "dialog:approval:remark") {
            setApprovalRemarkPatch({ at: Date.now(), remark: value });
            continue;
          }
          if (id.startsWith("field:") || id.startsWith("collection:")) {
            const planId = id.split(":")[1];
            const row = liveRows.find((candidate) => candidate.planId === planId);
            if (!row) return rejectWith("PLAN_NOT_ON_CURRENT_PAGE");
            // 复用界面自己的编辑权限判断：不允许编辑的计划，对话也改不了。
            if (!inlineSkuAccess(row).detail)
              return rejectWith("NO_EDIT_PERMISSION");
            const skuCode = id.startsWith("field:") ? id.split(":")[2] : undefined;
            setExpandedLiveGroups((current) =>
              current.includes(row.planId) ? current : [...current, row.planId],
            );
            setDraftPatch({
              at: Date.now(),
              planId: row.planId,
              quantity: value,
              ...(skuCode === undefined ? {} : { skuCodes: [skuCode] }),
            });
            // 等字段真的变成目标值再回执：只报"收到"会让模型以为改好了。
            const landedDeadline = Date.now() + 4000;
            let landed = false;
            while (Date.now() < landedDeadline) {
              await new Promise((resolve) => setTimeout(resolve, 150));
              const reported = inlineElementsRef.current[row.planId]?.fields ?? [];
              const target = skuCode
                ? reported.filter((field) => field.id.endsWith(`:${skuCode}:qty`))
                : reported;
              if (
                target.length > 0 &&
                target.every((field) => field.value === value)
              ) {
                landed = true;
                break;
              }
            }
            if (!landed) return rejectWith("VALUE_NOT_APPLIED");
            continue;
          }
          return rejectWith("UNKNOWN_ELEMENT");
        }
        break;
      }
      case "clear": {
        setLiveDetailPlanId(undefined);
        break;
      }
      default:
        return rejectWith("UNKNOWN_VERB");
    }
    settled(true);
    })();
  }, [toolCall]);

  const exportScope = JSON.stringify([
    scopedState,
    liveQueryScope,
    liveQuery.selectedPeriodMonth,
    liveStageFilter,
    page,
    pageSize,
  ]);
  const exportScopeRef = useRef(exportScope);
  const exportRowsRef = useRef(liveRows);
  const exportMountedRef = useRef(true);
  const exportRequestRef = useRef<AbortController | null>(null);
  const [exporting, setExporting] = useState(false);
  useEffect(() => () => exportRequestRef.current?.abort(), [exportScope, liveRows]);
  exportScopeRef.current = exportScope;
  exportRowsRef.current = liveRows;
  useEffect(() => {
    exportMountedRef.current = true;
    return () => {
      exportMountedRef.current = false;
    };
  }, []);
  const exportQueue = async () => {
    if (exportRequestRef.current) return;
    if (liveQuery.enabled) {
      if (liveQuery.queueState.status !== 'success' || liveRows.length === 0) {
        setExportFeedback({
          type: 'warning',
          message: t('common.assistantSurface.regionalApproval.exportFeedback.empty'),
        });
        return;
      }
      const request = new AbortController();
      exportRequestRef.current = request;
      setExporting(true);
      const timeout = window.setTimeout(() => request.abort(), 30_000);
      let readingDetails = false;
      const scopeChanged = () =>
        !exportMountedRef.current || exportScopeRef.current !== exportScope || exportRowsRef.current !== liveRows;
      try {
        const XLSX = await import('xlsx-republish');
        if (!exportMountedRef.current || exportScopeRef.current !== exportScope || exportRowsRef.current !== liveRows)
          return;
        if (
          liveRows.some(
            (row) =>
              [row.planId, row.versionId, row.periodId, row.dealerCode].some((value) => !String(value ?? '').trim()) ||
              [row.targetQty, row.targetAmount].some((value) => !/^-?\d+(?:\.\d+)?$/.test(value))
          )
        ) {
          setExportFeedback({
            type: 'error',
            message: t('common.assistantSurface.regionalApproval.exportFeedback.missingData'),
          });
          return;
        }
        readingDetails = true;
        const amounts: SalesPlanExportAmounts[] = [];
        let nextRow = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, liveRows.length) }, async () => {
            while (nextRow < liveRows.length) {
              request.signal.throwIfAborted();
              const index = nextRow++;
              const row = liveRows[index];
              // oxlint-disable-next-line no-await-in-loop -- bound detail reads to four concurrent requests；详情读取并发限制为四个。
              const skus = await (detailClient ?? salesPlan).versionSkus.invoke({
                versionId: row.versionId,
                signal: request.signal,
              });
              amounts[index] = aggregateSalesPlanExportAmounts(row, skus);
            }
          })
        );
        request.signal.throwIfAborted();
        if (scopeChanged()) return;
        readingDetails = false;
        const numericValue = (value: string) => {
          const numeric = Number(value);
          return Number.isFinite(numeric) &&
            Math.abs(numeric) <= Number.MAX_SAFE_INTEGER &&
            value.replace(/[-.]/g, '').replace(/^0+/, '').replace(/0+$/, '').length <= 15 &&
            !String(numeric).includes('e') &&
            isExactZero(subtractExactDecimals(String(numeric), value))
            ? numeric
            : value;
        };
        const headers = [
          'planId',
          'versionId',
          'periodId',
          'dealerCode',
          'status',
          'seq',
          'areaCode',
          'areaName',
          'provinceCode',
          'provinceName',
          'orgCode',
          'orgName',
          'baseName',
          'dealerName',
          'skuCount',
          'targetQty',
          'targetAmount',
          'qty',
          'amt',
          'regionConfirmedQty',
          'regionConfirmedAmount',
          'provinceConfirmedQty',
          'provinceConfirmedAmount',
          'areaConfirmedQty',
          'areaConfirmedAmount',
          'categoryConfirmedQty',
          'categoryConfirmedAmount',
          'submitter',
          'submitTime',
          'finishedAt',
          'updatedAt',
          'returnReason',
          'statusCode',
        ] as const;
        const sheet = XLSX.utils.aoa_to_sheet([
          headers.map((field) => t(`common.assistantSurface.regionalApproval.exportColumns.${field}`)),
          ...liveRows.map((row, index) => [
            row.planId,
            row.versionId,
            row.periodId,
            row.dealerCode,
            salesPlanStatusText(row.status, row.planTypeCode, t),
            row.seq,
            row.areaCode ?? '',
            row.areaName ?? row.regionName ?? '',
            row.provinceCode ?? '',
            row.provinceName ?? row.provinceRegionName ?? '',
            row.orgCode ?? '',
            row.orgName ?? row.salesGroupName ?? '',
            row.baseName ?? '',
            row.dealerName ?? '',
            row.skuCount,
            numericValue(row.targetQty),
            numericValue(row.targetAmount),
            ...SALES_PLAN_EXPORT_AMOUNT_PAIRS.flatMap((fields) =>
              fields.map((field) => (amounts[index][field] == null ? null : numericValue(amounts[index][field])))
            ),
            row.submitter ?? '',
            row.submitTime ?? '',
            row.finishedAt ?? '',
            row.updatedAt ?? '',
            row.returnReason ?? '',
            row.status,
          ]),
        ]);
        sheet['!cols'] = headers.map(() => ({ wch: 24 }));
        for (let row = 2; row <= liveRows.length + 1; row++) {
          for (const field of ['targetAmount', ...SALES_PLAN_EXPORT_AMOUNT_PAIRS.map((pair) => pair[1])] as const) {
            const column = XLSX.utils.encode_col(headers.indexOf(field));
            if (sheet[`${column}${row}`]?.t === 'n') sheet[`${column}${row}`].z = '#,##0.00';
          }
        }
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(
          workbook,
          sheet,
          t('common.assistantSurface.regionalApproval.exportColumns.sheet')
        );
        const exportLabel = (key: string) => t(`common.assistantSurface.regionalApproval.exportScope.${key}`);
        const metadata = [
          [exportLabel('scope'), exportLabel('currentPage')],
          [exportLabel('month'), liveQuery.selectedPeriodMonth ?? '—'],
          [exportLabel('version'), exportLabel('currentVersion')],
          [exportLabel('page'), liveCurrentPage],
          [exportLabel('pageSize'), pageSize],
          [exportLabel('exported'), liveRows.length],
          [exportLabel('total'), liveOuterRows.length],
          [exportLabel('stage'), t(`common.assistantSurface.regionalApproval.stages.${liveStageFilter ?? 'all'}`)],
          ...(['areaCode', 'provinceCode', 'orgCode', 'dealerCode', 'status'] as const).map((field) => [
            exportLabel(field),
            String(liveQueryScope[field] ?? exportLabel('all')),
          ]),
        ];
        const scopeSheet = XLSX.utils.aoa_to_sheet(metadata);
        scopeSheet['!cols'] = [{ wch: 20 }, { wch: 42 }];
        XLSX.utils.book_append_sheet(workbook, scopeSheet, exportLabel('sheet'));
        const data = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
        const url = URL.createObjectURL(
          new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = `sales-plan-approval-${liveQuery.selectedPeriodMonth ?? 'period'}-${liveStageFilter ?? 'all'}-page-${liveCurrentPage}.xlsx`;
        link.click();
        URL.revokeObjectURL(url);
        setExportFeedback({
          type: 'success',
          message: t('common.assistantSurface.regionalApproval.exportFeedback.successLive', { count: liveRows.length }),
        });
      } catch {
        request.abort();
        if (!scopeChanged()) {
          setExportFeedback({
            type: 'error',
            message: t(
              readingDetails
                ? 'common.assistantSurface.regionalApproval.exportFeedback.detailsFailed'
                : 'common.assistantSurface.regionalApproval.exportFeedback.failed'
            ),
          });
        }
      } finally {
        window.clearTimeout(timeout);
        if (exportRequestRef.current === request) {
          exportRequestRef.current = null;
          if (exportMountedRef.current) setExporting(false);
        }
      }
      return;
    }
    if (visibleRows.length === 0) {
      setExportFeedback({
        type: 'warning',
        message: t('common.assistantSurface.regionalApproval.exportFeedback.empty'),
      });
      return;
    }
    const csvLabels: ApprovalCsvLabels = {
      version: t('common.assistantSurface.regionalApproval.csv.version'),
      stage: t('common.assistantSurface.regionalApproval.csv.stage'),
      organization: t('common.assistantSurface.regionalApproval.csv.organization'),
      area: t('common.assistantSurface.regionalApproval.csv.area'),
      branch: t('common.assistantSurface.regionalApproval.csv.branch'),
      department: t('common.assistantSurface.regionalApproval.csv.department'),
      customer: t('common.assistantSurface.regionalApproval.csv.customer'),
      quantity: t('common.assistantSurface.regionalApproval.csv.quantity'),
      amount: t('common.assistantSurface.regionalApproval.csv.amount'),
      versionValues: {
        current: versionLabel('current'),
        previous: versionLabel('previous'),
        initial: versionLabel('initial'),
      },
    };
    try {
      const csv = buildApprovalCsv(visibleRows, primaryVersion, currentStage, csvLabels);
      const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `regional-approval-${primaryVersion}-fixture.csv`;
      link.click();
      URL.revokeObjectURL(url);
      setExportFeedback({
        type: 'success',
        message: t('common.assistantSurface.regionalApproval.exportFeedback.success', {
          count: visibleRows.length,
          version: versionLabel(primaryVersion),
        }),
      });
    } catch {
      setExportFeedback({
        type: 'error',
        message: t('common.assistantSurface.regionalApproval.exportFeedback.failed'),
      });
    }
  };

  const visibleStageFixtures = APPROVAL_STAGE_FIXTURES.filter((stage) => stage.id !== ('evaluation' as ApprovalStageId));
  const currentStageIndex = visibleStageFixtures.findIndex((stage) => stage.id === displayStage);
  const healthColors: Record<ApprovalHealth, 'green' | 'orange' | 'red'> = {
    healthy: 'green',
    attention: 'orange',
    warning: 'red',
  };
  const approvalColors: Record<ApprovalState, 'arcoblue' | 'green' | 'gray'> = {
    pending: 'arcoblue',
    approved: 'green',
    future: 'gray',
  };
  const localResultFor = (row: RegionalApprovalRow) =>
    localApprovalResults
      .toReversed()
      .find((result) => result.scope.organizationId === row.id && result.scope.version === primaryVersion);
  // 先保留可读的最小宽度，再把面板剩余空间分配给内容列。
  const comparisonFor = (row: Extract<RegionalApprovalLiveTableRow, {kind:'plan'}>) => {
    const metrics = (row.members ?? [row.plan]).map(plan=>versionMetrics[plan.planId]);
    const sum = (field:'compareQty'|'compareAmount'|'compareTargetQty'|'compareTargetAmount') => metrics.length && metrics.every(value=>value?.[field] && /^-?\d+(?:\.\d+)?$/.test(value[field]!))
      ? addExactDecimals(metrics.map(value=>value[field]!)) : '';
    return {compareQty:sum('compareQty'),compareAmount:sum('compareAmount'),compareTargetQty:sum('compareTargetQty'),compareTargetAmount:sum('compareTargetAmount')};
  };
  // Keep the approval queue dense once its columns have enough room to scan.
  // The expanded SKU table deliberately follows a separate, roomier layout.
  const liveMinimumWidths = [220, 112, 112, 136];
  // 选择框与展开按钮各占 40px，必须一起计入列宽预算。
  const liveMinimumWidth = liveMinimumWidths.reduce((total, width) => total + width, 80);
  const liveTableWidth = Math.max(
    liveMinimumWidth,
    Math.min(tableViewportWidth || liveMinimumWidth, 960)
  );
  const liveExtraWidth = Math.max(0, liveTableWidth - liveMinimumWidth);
  const liveColumnWeights = [0.44, 0.2, 0.2, 0.16];
  const liveColumnWidths = liveMinimumWidths.map((width, index) => width + liveExtraWidth * liveColumnWeights[index]);
  const pinLiveColumns = tableViewportWidth >= liveTableWidth;
  const liveApprovalStatusTag = (tableRow: Extract<RegionalApprovalLiveTableRow, {kind: 'plan'}>) => {
    const row = tableRow.plan;
    return (
      <Tag
        color={row.approvalState === 'approved' ? 'green' : row.approvalState === 'returned' ? 'orange' : 'arcoblue'}
        data-testid={`regional-approval-status-${row.planId}`}
      >
        {tableRow.members && new Set(tableRow.members.map((member) => member.status)).size > 1
          ? t('common.assistantSurface.regionalApproval.mixedApprovalStatus')
          : salesPlanQueueStatusText(row.status, row.planTypeCode, liveStageFilter ?? 'category', t)}
      </Tag>
    );
  };
  const fixtureApprovalStatusTag = (row: RegionalApprovalRow) => {
    const localResult = localResultFor(row);
    return localResult ? (
      <Tag
        color={localResult.kind === 'submit' ? 'green' : 'orange'}
        data-testid={`regional-approval-status-${row.id}`}
      >
        {t(`common.assistantSurface.regionalApproval.action.rowStatus.${localResult.kind}`)}
      </Tag>
    ) : (
      <Tag color={approvalColors[row.approvalState]} data-testid={`regional-approval-status-${row.id}`}>
        {t(`common.assistantSurface.regionalApproval.status.${row.approvalState}`)}
      </Tag>
    );
  };
  const liveColumns: TableColumnProps<RegionalApprovalLiveTableRow>[] = [
    {
      title: t('common.assistantSurface.regionalApproval.columns.organization'),
      width: liveColumnWidths[0],
      fixed: pinLiveColumns ? 'left' : undefined,
      render: (_, tableRow) => {
        if (tableRow.kind === 'category') {
          return (
            <div
              className={styles.categoryOrganizationCell}
              data-testid={`regional-approval-category-row-${tableRow.plan.planId}-${tableRow.category.categoryName}`}
            >
              <div>
                <Button type='text' size='small' aria-expanded={expandedLiveGroups.includes(tableRow.tableRowId)} onClick={() => setExpandedLiveGroups(current => current.includes(tableRow.tableRowId) ? current.filter(id => id !== tableRow.tableRowId) : [...current, tableRow.tableRowId])}>
                  {t('common.assistantSurface.regionalApproval.categoryRows.name', {
                    category: tableRow.category.categoryName,
                  })}
                </Button>
                <small>
                  {t('common.assistantSurface.regionalApproval.categoryRows.skuCount', {
                    count: tableRow.category.skuCount,
                  })}
                </small>
              </div>
            </div>
          );
        }
        const row = tableRow.plan;
        const projection = projectRegionalApprovalLiveDimension(
          tableRow.plan,
          tableRow.displayDimension ?? (tableRow.childPlan ? 'customer' : dimension)
        );
        const organizationName =
          projection.name ?? t('common.assistantSurface.regionalApproval.query.unnamedOrganization');
        const rowExpanded = tableRow.members
          ? expandedLiveGroups.includes(tableRow.tableRowId)
          : inlinePlanId === row.planId;
        return (
          <div
            className={styles.organizationCell}

          >
            <div className={styles.organizationTitle}>
              <Button
                type='text'
                size='small'
                className={styles.detailTrigger}
                onClick={() => {
                  if (tableRow.members) {
                    setExpandedLiveGroups((current) =>
                      current.includes(tableRow.tableRowId)
                        ? current.filter((id) => id !== tableRow.tableRowId)
                        : [...current, tableRow.tableRowId]
                    );
                    return;
                  }
                  selectLivePlanContext(row);
                  setFocusedLivePlanId(row.planId);
                  setInlinePlanId(current => current === row.planId ? undefined : row.planId);
                }}
                aria-label={t(
                  tableRow.members
                    ? 'common.assistantSurface.regionalApproval.expandOrganization'
                    : 'common.assistantSurface.regionalApproval.liveAdjustment.openFor',
                  {
                    plan: organizationName,
                  }
                )}
                aria-expanded={tableRow.members ? expandedLiveGroups.includes(tableRow.tableRowId) : undefined}
                title={
                  organizationName === t('common.assistantSurface.regionalApproval.query.unnamedOrganization')
                    ? t('common.assistantSurface.regionalApproval.query.unnamedOrganizationHint')
                    : organizationName
                }
              >
                {/* 展开态用名称前置小三角体现，不再单独占一列控件。 */}
                <span className={styles.organizationCaret} data-expanded={rowExpanded} aria-hidden='true'>
                  {rowExpanded ? <Down size={12} /> : <Right size={12} />}
                </span>
                {organizationName}
              </Button>
              {liveApprovalStatusTag(tableRow)}
            </div>
            <span
              className={styles.organizationPath}
              data-testid={`regional-approval-scope-${row.planId}`}
              title={projection.context.join(' / ')}
            >
              {tableRow.members
                ? t('common.assistantSurface.regionalApproval.organizationGroupCount', {
                    count: tableRow.members.length,
                  })
                : projection.context.length > 0
                  ? projection.context.map((name, index) => (
                      <React.Fragment key={`${name}-${index}`}>
                        {index > 0 ? ' / ' : null}
                        <span>{name}</span>
                      </React.Fragment>
                    ))
                  : '—'}
            </span>
          </div>
        );
      },
    },
    {
      title: t('common.correction.target'),
      width: liveColumnWidths[1],
      render: (_, tableRow) => {
        const row = tableRow.plan;
        if (tableRow.kind === 'category') {
          const categories = liveCategorySummaries[row.planId] ?? [];
          const baseTotal = addExactDecimals(categories.map((item) => item.baseAmount));
          const categoryTarget =
            /^-?\d+(?:\.\d+)?$/.test(row.targetAmount) && /^-?\d+(?:\.\d+)?$/.test(baseTotal) && Number(baseTotal) !== 0
              ? String(Number(row.targetAmount) * Number(tableRow.category.baseAmount) / Number(baseTotal))
              : '';
          return <div className={styles.stackCell}><span>{categoryTarget ? exactMoney(Number(categoryTarget).toFixed(2)) : '—'}</span></div>;
        }
        return <div className={styles.stackCell}><span>{/^-?\d+(?:\.\d+)?$/.test(row.targetAmount) ? exactMoney(row.targetAmount) : t('common.assistantSurface.regionalApproval.versionTargetMissing')}</span></div>;
      },
    },
    {
      title: t('common.correction.plan'),
      width: liveColumnWidths[2],
      render: (_, tableRow) => tableRow.kind === 'category' ? <div className={styles.stackCell}><span>{exactMoney(tableRow.category.amount)}</span></div> : <div className={styles.stackCell} data-testid={`regional-approval-month-plan-${tableRow.tableRowId}`}>
        <span>{/^-?\d+(?:\.\d+)?$/.test(tableRow.plan.mPlanAmount ?? '') ? exactMoney(tableRow.plan.mPlanAmount!) : '—'}</span>
        <small>{/^-?\d+(?:\.\d+)?$/.test(tableRow.plan.mPlanQty ?? '') ? quantityText(tableRow.plan.mPlanQty!) : '—'}</small>
        {tableRow.kind === 'plan' && comparisonFor(tableRow).compareAmount && <small>{t('common.assistantSurface.regionalApproval.comparePlan', {amount:exactMoney(comparisonFor(tableRow).compareAmount!),qty:quantityText(comparisonFor(tableRow).compareQty ?? '—')})}</small>}
      </div>,
    },
    {
      title: categoryComparison
        ? t('common.assistantSurface.regionalApproval.columns.categoryProgress')
        : t('common.assistantSurface.regionalApproval.columns.progress'),
      width: liveColumnWidths[3],
      render: (_, tableRow) => {
        if (tableRow.kind === 'plan') {
          const progress = regionalApprovalLiveProgress({...tableRow.plan,currentAmount:tableRow.plan.mPlanAmount ?? '—'});
          return <div className={styles.categoryProgressCell}>
            {/* V1.8 #09：达成率用进度条 + 百分比，百分比前不再带「金额」。 */}
            <strong>{formattedProgress(progress.amount)}</strong>
            <Progress
              percent={Math.min(Math.max(progress.amount ?? 0, 0), 100)}
              showText={false}
              size='small'
              color={salesPlanProgressBarColor(progress.amount)}
            />
            {comparisonFor(tableRow).compareAmount && <small>{t('common.assistantSurface.regionalApproval.compareProgress', {value:comparisonFor(tableRow).compareTargetAmount
              ? formattedProgress(regionalApprovalLiveProgress({...tableRow.plan,currentQty:comparisonFor(tableRow).compareQty!,currentAmount:comparisonFor(tableRow).compareAmount!,targetQty:comparisonFor(tableRow).compareTargetQty!,targetAmount:comparisonFor(tableRow).compareTargetAmount!}).amount)
              : t('common.assistantSurface.regionalApproval.versionTargetMissing')})}</small>}

          </div>;
        }
        const { category } = tableRow;
        const categories = liveCategorySummaries[tableRow.plan.planId] ?? [];
        const baseTotal = addExactDecimals(categories.map((item) => item.baseAmount));
        const categoryTarget = /^-?\d+(?:\.\d+)?$/.test(tableRow.plan.targetAmount) && /^-?\d+(?:\.\d+)?$/.test(baseTotal) && Number(baseTotal) !== 0
          ? Number(tableRow.plan.targetAmount) * Number(category.baseAmount) / Number(baseTotal)
          : undefined;
        // 品类金额进度统一按「计划金额 ÷ 目标金额」计算，避免把原计划金额误当作分母。
        const categoryProgress = categoryTarget && categoryTarget !== 0 ? Number(category.amount) / categoryTarget * 100 : undefined;
        return (
          <div className={styles.categoryProgressCell}>
            <strong>{formattedProgress(categoryProgress)}</strong>
            <Progress
              percent={Math.min(categoryProgress ?? 0, 100)}
              showText={false}
              size='small'
              color={salesPlanProgressBarColor(categoryProgress)}
            />
            <small>
              {t('common.assistantSurface.regionalApproval.categoryRows.targetAmount', {
                amount: categoryTarget == null ? '—' : exactMoney(Number(categoryTarget).toFixed(2)),
              })}
            </small>
            <small>
              {t('common.assistantSurface.regionalApproval.categoryRows.planAmount', {
                amount: exactMoney(category.amount),
              })}
            </small>
          </div>
        );
      },
    },
  ];
  const columns: TableColumnProps<RegionalApprovalRow>[] = [
    {
      title: t('common.assistantSurface.regionalApproval.columns.organization'),
      width: 220,
      render: (_, row) => (
        <div className={styles.organizationCell}>
          <div className={styles.organizationTitle}>
            <Button
              type='text'
              size='small'
              className={styles.detailTrigger}
              onClick={() => openDetail(row)}
              aria-label={t('common.assistantSurface.regionalApproval.detail.openFor', {
                organization: t(organizationLabelKey(row.organizationKey)),
              })}
            >
              {t(organizationLabelKey(row.organizationKey))}
            </Button>
            {fixtureApprovalStatusTag(row)}
          </div>
          <span>
            {t(areaLabelKey(row.areaKey))} · {t(branchLabelKey(row.branchKey))} ·{' '}
            {t(departmentLabelKey(row.departmentKey))}
          </span>
          <small>
            {row.customerCode} · {t(customerLabelKey(row.customerKey))}
            <Button
              type='text'
              size='mini'
              className={styles.healthFilterAction}
              aria-label={t('common.assistantSurface.regionalApproval.healthFilter', {
                health: t(`common.assistantSurface.regionalApproval.health.${row.health}`),
              })}
              onClick={() => applyHealthFilter(row.health)}
            >
              <Tag size='small' color={healthColors[row.health]}>
                {t(`common.assistantSurface.regionalApproval.health.${row.health}`)}
              </Tag>
            </Button>
          </small>
        </div>
      ),
    },
    ...(categoryComparison
      ? [
          {
            title: t('common.assistantSurface.regionalApproval.columns.category'),
            width: 110,
            render: (_: unknown, row: RegionalApprovalRow) => (
              <Tag>{t(`common.assistantSurface.regionalApproval.categories.${row.category}`)}</Tag>
            ),
          },
        ]
      : []),
    {
      title: t('common.assistantSurface.regionalApproval.columns.quantity'),
      width: 100,
      render: (_, row) => <strong>{number(metricsForApprovalVersion(row, primaryVersion).quantity)}</strong>,
    },
    {
      title: t('common.assistantSurface.regionalApproval.columns.amount'),
      width: 110,
      render: (_, row) => <strong>{money(metricsForApprovalVersion(row, primaryVersion).amount)}</strong>,
    },
    {
      title: t('common.assistantSurface.regionalApproval.columns.progress'),
      width: 125,
      render: (_, row) => (
        <div className={styles.stackCell}>
          <span>{t('common.assistantSurface.regionalApproval.amountProgress', { progress: row.amountProgress })}</span>
        </div>
      ),
    },
    ...(primaryVersion !== compareVersion
      ? [
          {
            title: t('common.assistantSurface.regionalApproval.columns.comparison'),
            width: 145,
            render: (_: unknown, row: RegionalApprovalRow) => {
              const primary = metricsForApprovalVersion(row, primaryVersion);
              const compare = metricsForApprovalVersion(row, compareVersion);
              return (
                <div className={styles.stackCell}>
                  <strong>
                    {primary.quantity - compare.quantity >= 0 ? '+' : ''}
                    {number(primary.quantity - compare.quantity)}
                  </strong>
                  <span>
                    {primary.amount - compare.amount >= 0 ? '+' : ''}
                    {money(primary.amount - compare.amount)}
                  </span>
                </div>
              );
            },
          },
          {
            title: t('common.assistantSurface.regionalApproval.columns.returnReason'),
            width: 170,
            render: (_: unknown, row: RegionalApprovalRow) =>
              row.returnReason ?? t('common.assistantSurface.regionalApproval.columns.noReturnReason'),
          },
        ]
      : []),
  ];
  const approvalActionButtons = liveQuery.enabled ? (
    <>
      {liveActionsEnabled ? (
        <Button
          size='small'
          status='danger'
          disabled={
            selectedLiveRows.length !== 1 ||
            selectedLiveRows[0]?.status === 5 ||
            (selectedLiveRows[0] ? Boolean(liveActionDisabledReason(selectedLiveRows[0], 'REJECT')) : true)
          }
          onClick={() => {
            const row = selectedLiveRows[0];
            if (!row) return;
            selectLivePlanContext(row);
            setLiveActionKind('REJECT');
            setLiveActionPlanId(row.planId);
          }}
        >
          {t('common.assistantSurface.regionalApproval.liveAction.reject')}
        </Button>
      ) : null}
      {liveActionsEnabled ? (
        <Button
          type='primary'
          size='small'
          loading={liveActionKind === 'APPROVE' && liveActionPlanId !== undefined}
          disabled={
            selectedLiveRows.length !== 1 ||
            liveActionPlanId !== undefined ||
            (selectedLiveRows[0] ? Boolean(liveActionDisabledReason(selectedLiveRows[0])) : true)
          }
          onClick={() => {
            const row = selectedLiveRows[0];
            if (!row) return;
            selectLivePlanContext(row);
            setLiveActionKind('APPROVE');
            setLiveActionPlanId(row.planId);
          }}
        >
          {t('common.assistantSurface.regionalApproval.liveAction.approve')}
        </Button>
      ) : null}
    </>
  ) : (
    <>
      <Button
        size='small'
        status='danger'
        disabled={selectedFixtureRows.length === 0 || !selectedFixtureRows.every(selectableFixtureRow)}
        onClick={() => selectedFixtureRows[0] && openAction(selectedFixtureRows[0])}
      >
        {t('common.assistantSurface.regionalApproval.footer.return')}
      </Button>
      <Button
        type='primary'
        size='small'
        disabled={
          selectedFixtureRows.length === 0 ||
          !selectedFixtureRows.every(selectableFixtureRow) ||
          currentStage === 'category'
        }
        onClick={() => selectedFixtureRows[0] && openAction(selectedFixtureRows[0])}
      >
        {t('common.assistantSurface.regionalApproval.footer.submit')}
      </Button>
    </>
  );

  const liveActionDialog =
    activeLiveActionRow && liveActionsEnabled ? (
      <RegionalApprovalLiveActionDialog
        key={`${activeLiveActionRow.versionId}:${liveActionKind}`}
        visible
        embedded={false}
        autoSubmitApproval={liveActionKind === 'APPROVE'}
        row={activeLiveActionRow}
        approvalStage={liveStageFilter ?? (roleStages.length === 1 ? roleStages[0] : 'customer')}
        initialAction={liveActionKind}
        t={t}
        client={liveActionClient}
        permissionCodes={permissionCodes}
        evidence={liveAccess.entries[activeLiveActionRow.versionId]}
        pendingValues={livePendingValues[activeLiveActionRow.planId]}
        onPermissionDenied={(versionId) => setPermissionDeniedVersions((current) => new Set(current).add(versionId))}
        remarkPatch={approvalRemarkPatch}
        submitRequest={approvalSubmitRequest}
        onSucceeded={async (receipt, request) => {
          setLivePendingValues((current) => {
            if (!(activeLiveActionRow.planId in current)) return current;
            const next = { ...current };
            delete next[activeLiveActionRow.planId];
            return next;
          });
          if (request.action === 'SAVE') {
            const before = liveAccess.entries[receipt.versionId];
            if (!before || !detailClient) throw new Error('Save verification unavailable');
            const after = await detailClient.detail.invoke({ planId: receipt.planId });
            if (!verifySavedSalesPlan(before, after, request, receipt)) throw new Error('Save readback mismatch');
          } else {
            setLiveActionReceipts((current) => ({ ...current, [receipt.versionId]: receipt }));
          }
          setLiveAuthorityContext(projectSalesPlanActionContext(activeLiveActionRow, receipt, contextFilterSummary));
          setSelectedRowIds([]);
          setLiveActionPlanId(undefined);
          refreshLiveAuthority();
        }}
        onRefresh={refreshLiveAuthority}
        onFailed={() => {
          setLiveActionPlanId(undefined);
          setExportFeedback({ type: 'error', message: t('common.assistantSurface.regionalApproval.liveAction.errors.failed') });
        }}
        onClose={() => setLiveActionPlanId(undefined)}
      />
    ) : null;

  const inlineSkuAccess = (row: RegionalApprovalLiveRow) => {
    const detail = liveAccess.entries[row.versionId] ?? Object.values(liveAccess.entries).find(
      (candidate) => candidate.currentVersion.planId === row.planId && candidate.currentVersion.id === row.versionId,
    );
    if (!detail) return { detail: undefined, role: undefined, canEdit: false };
    const accessRoles: Exclude<ApprovalStageId, 'customer'>[] = roleStages.length
      ? roleStages.filter((candidate): candidate is Exclude<ApprovalStageId, 'customer'> => candidate !== 'customer')
      : ['region', 'province', 'area', 'category'];
    const editableRole = accessRoles
      .map((candidate) => ({
        candidate,
        access: salesPlanAccessForRow(row, detail, permissionCodes, candidate),
      }))
      .find(({ access }) => access?.allowedActions.includes('SAVE') || access?.allowedActions.includes('APPROVE'));
    const actionContextAllowsEdit = detail.actionContext?.allowedActions.some(
      (action) => action === 'SAVE' || action === 'APPROVE',
    );
    return {
      detail,
      role: editableRole?.candidate ?? liveStageFilter ?? roleStages[0],
      canEdit: Boolean(editableRole || actionContextAllowsEdit),
    };
  };

  return (
    <main
      className={styles.root}
      aria-label={t('common.assistantSurface.regionalApproval.ariaLabel')}
      data-testid='regional-approval-workbench'
    >
      <h1
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {t('common.assistantSurface.regionalApproval.title')}
      </h1>
      <header className={styles.header}>
        <div className={styles.titleLine}>
          <span className={styles.workspaceTitle}>{t('common.assistantSurface.regionalApproval.title')}</span>
          {headerControls}
          {!liveQuery.enabled ? (
            <Tag className={styles.fixtureTag} color='red'>
              {t('common.assistantSurface.regionalApproval.fixtureTag')}
            </Tag>
          ) : null}
          {!liveQuery.enabled ? (
            <Tag color='orange'>{t('common.assistantSurface.regionalApproval.query.fixtureCapabilitiesTag')}</Tag>
          ) : null}
        </div>
        <div className={styles.headerRight}>
          {/* 流程图默认收起：收起态只在标题行右侧留一个「当前节点」入口，点开才占一整行。 */}
          <Button
            type='text'
            size='small'
            className={styles.stageLaneToggle}
            data-testid='regional-approval-flow-toggle'
            aria-expanded={stageLaneOpen}
            aria-controls='regional-approval-stage-lane'
            aria-label={t(
              `common.assistantSurface.regionalApproval.stageLaneToggle.${stageLaneOpen ? 'collapse' : 'expand'}`
            )}
            title={t(
              `common.assistantSurface.regionalApproval.stageLaneToggle.${stageLaneOpen ? 'collapse' : 'expand'}`
            )}
            onClick={() => setStageLaneOpen((open) => !open)}
          >
            <span>
              {t('common.assistantSurface.regionalApproval.stageLaneToggle.current', {
                stage: stageIndicatorStage
                  ? t(stageLabelKey(stageIndicatorStage))
                  : t('common.assistantSurface.regionalApproval.stages.all'),
              })}
            </span>
            {stageLaneOpen ? <Up size={12} /> : <Down size={12} />}
          </Button>
          <div className={styles.scope} aria-label={t('common.assistantSurface.regionalApproval.scopeAria')}>
          <span className={styles.monthField}>
            <small>{t('common.assistantSurface.regionalApproval.planMonth')}</small>
            {liveQuery.enabled ? (
              <Spin loading={liveQuery.periodsState.status === 'loading' && liveQuery.periods.length === 0} size={14}>
                <Select
                  size='small'
                  value={liveQuery.selectedPeriodMonth}
                  aria-label={t('common.assistantSurface.regionalApproval.query.periodSelect')}
                  placeholder={t('common.assistantSurface.regionalApproval.query.noPeriod')}
                  onChange={(periodMonth) => {
                    setSelectedRowIds([]);
                    setPage(1);
                    liveQuery.selectPeriodMonth(periodMonth);
                  }}
                  disabled={liveQuery.periods.length === 0}
                >
                  {liveQuery.periodMonths.map((periodMonth) => (
                    <Select.Option key={periodMonth} value={periodMonth}>
                      {salesPlanPeriodOptionLabel(periodMonth)}
                    </Select.Option>
                  ))}
                </Select>
              </Spin>
            ) : (
              <Select size='small' value='2026-09' aria-label={t('common.assistantSurface.regionalApproval.planMonth')}>
                <Select.Option value='2026-09'>
                  {t('common.assistantSurface.regionalApproval.planMonthValue')}
                </Select.Option>
              </Select>
            )}
          </span>
          <div
            className={styles.versionControls}
            aria-label={t('common.assistantSurface.regionalApproval.versions.group')}
            data-testid='regional-approval-version-controls'
          >
            <span className={styles.versionField}>
              <small>{t('common.assistantSurface.regionalApproval.versions.primaryCompact')}</small>
              {liveQuery.enabled ? (
                <Select
                  size='small'
                  value={livePrimaryVersionId}
                  aria-label={t('common.assistantSurface.regionalApproval.versions.primary')}
                  placeholder={t('common.assistantSurface.regionalApproval.versions.unavailable')}
                  disabled={liveVersionsLoading || liveVersions.length === 0}
                  onChange={(value) => changeLivePrimaryVersion(String(value))}
                >
                  {liveVersions.map((version) => (
                    <Select.Option key={version.id} value={version.id}>
                      {liveVersionLabel(version.id)}
                    </Select.Option>
                  ))}
                </Select>
              ) : (
                <Select
                  size='small'
                  value={primaryVersion}
                  aria-label={t('common.assistantSurface.regionalApproval.versions.primary')}
                  onChange={(value) => changePrimaryVersion(value as ApprovalVersion)}
                >
                  {APPROVAL_VERSIONS.map((version) => (
                    <Select.Option key={version} value={version}>
                      {versionLabel(version)}
                    </Select.Option>
                  ))}
                </Select>
              )}
            </span>
            <span className={styles.versionField}>
              <small>{t('common.assistantSurface.regionalApproval.versions.compareCompact')}</small>
              {liveQuery.enabled ? (
                <Select
                  size='small'
                  value={liveCompareVersionId}
                  aria-label={t('common.assistantSurface.regionalApproval.versions.compare')}
                  placeholder={t('common.assistantSurface.regionalApproval.versions.unavailable')}
                  disabled={liveVersionsLoading || liveVersions.length === 0}
                  onChange={(value) => changeLiveCompareVersion(String(value))}
                >
                  {liveVersions.map((version) => (
                    <Select.Option key={version.id} value={version.id}>
                      {liveVersionLabel(version.id)}
                    </Select.Option>
                  ))}
                </Select>
              ) : (
                <Select
                  size='small'
                  value={compareVersion}
                  aria-label={t('common.assistantSurface.regionalApproval.versions.compare')}
                  onChange={(value) => changeCompareVersion(value as ApprovalVersion)}
                >
                  {APPROVAL_VERSIONS.map((version) => (
                    <Select.Option key={version} value={version}>
                      {versionLabel(version)}
                    </Select.Option>
                  ))}
                </Select>
              )}
            </span>
            <Tooltip content={t('common.assistantSurface.regionalApproval.versions.description')}>
              <Button
                className={styles.versionInfo}
                type='text'
                size='mini'
                aria-label={t('common.assistantSurface.regionalApproval.versions.info')}
                icon={<Info size={14} />}
              />
            </Tooltip>
          </div>
        </div>
        </div>
      </header>

      <div
        className={styles.stageViewport}
        data-testid='regional-approval-flow-lane'
        data-collapsed={!stageLaneOpen}
      >
        <nav
          id='regional-approval-stage-lane'
          className={styles.stageLane}
          data-live-status={liveQuery.enabled}
          aria-label={t('common.assistantSurface.regionalApproval.stageLane')}
        >
          {visibleStageFixtures.map((stage, index) => {
            const state = liveQuery.enabled
              ? liveQuery.progressState.status !== 'success'
                ? 'unavailable'
                : stage.id !== 'category' &&
                    (liveQuery.progressState.statusTotals?.[SALES_PLAN_RETURN_CODES[stage.id] ?? -1] ?? 0) > 0
                  ? 'critical'
                  : liveStageProgress[stage.id] === 100
                    ? 'completed'
                    : 'partial'
              : index < currentStageIndex
                ? 'completed'
                : index === currentStageIndex
                  ? 'current'
                  : 'available';
            return (
              <React.Fragment key={stage.id}>
                <Button
                  type='text'
                  className={styles.stageButton}
                  data-state={state}
                  data-selected={liveQuery.enabled && liveStageFilter === stage.id}
                  data-testid={`regional-approval-stage-${stage.id}`}
                  aria-current={stage.id === displayStage ? 'step' : undefined}
                  aria-pressed={liveQuery.enabled ? liveStageFilter === stage.id : undefined}
                  disabled={
                    liveQuery.enabled &&
                    liveQuery.progressState.status !== 'success'
                  }
                  onClick={() => changeStage(stage.id)}
                >
                  <span className={styles.stageMarker}>
                    {state === 'completed' ? <CheckOne size={14} /> : index + 1}
                  </span>
                  <span className={styles.stageCopy}>
                    <strong>
                      {liveQuery.enabled && stage.id === displayStage ? (
                        <span style={{ color: 'rgb(var(--warning-6))' }} aria-hidden>
                          ➜{' '}
                        </span>
                      ) : null}
                      {t(stageLabelKey(stage.id))}
                    </strong>
                    <small>
                      {t('common.assistantSurface.regionalApproval.stageProgress', {
                        progress: liveQuery.enabled ? liveStageProgress[stage.id] : stage.progress,
                      })}
                    </small>
                  </span>
                </Button>
                {!liveQuery.enabled && index < visibleStageFixtures.length - 1 ? (
                  <span className={styles.stageConnector} data-state={state} aria-hidden='true' />
                ) : null}
              </React.Fragment>
            );
          })}
        </nav>
      </div>

      <div className={styles.content}>
        {liveQuery.enabled && liveQuery.periodsState.status === 'error' ? (
          <Alert
            className={styles.queryAlert}
            type='error'
            showIcon
            title={t(liveQuery.periodsState.error === 'workflow' ? 'common.assistantSurface.regionalApproval.query.workflowErrorTitle' : 'common.assistantSurface.regionalApproval.query.periodErrorTitle')}
            content={t(queryErrorKey(liveQuery.periodsState.error))}
            action={
              <Button size='small' onClick={liveQuery.retryPeriods}>
                {t('common.assistantSurface.regionalApproval.query.retry')}
              </Button>
            }
          />
        ) : null}
        {liveQuery.enabled && liveQuery.periodsState.status === 'success' && liveQuery.periods.length === 0 ? (
          <Alert
            className={styles.queryAlert}
            type='info'
            showIcon
            title={t('common.assistantSurface.regionalApproval.query.noPeriod')}
            content={t('common.assistantSurface.regionalApproval.query.noPeriodDescription')}
          />
        ) : null}
        <section className={styles.queue} aria-label={t('common.assistantSurface.regionalApproval.queue.ariaLabel')}>
          <header className={styles.dashboardHeader}>
            <div
              className={styles.queueMetrics}
              role='region'
              aria-label={t('common.assistantSurface.regionalApproval.scopeTotals.pageTitle')}
              title={t('common.assistantSurface.regionalApproval.scopeTotals.pageTitle')}
            >
              <span>
                <small>{t('common.assistantSurface.regionalApproval.scopeTotals.targetAmount')}</small>
                <strong>{(liveQuery.enabled && !dashboardReady) || metrics.targetAmount === undefined ? '—' : exactMoney(metrics.targetAmount)}</strong>
              </span>
              <span>
                <small>{t('common.assistantSurface.regionalApproval.scopeTotals.planAmount')}</small>
                <strong>{liveQuery.enabled && !dashboardReady ? '—' : exactMoney(metrics.amount)}</strong>
              </span>
              <span>
                <small>{t('common.assistantSurface.regionalApproval.scopeTotals.amountVariance')}</small>
                <strong className={salesPlanVarianceClass(amountVariance, styles.variancePositive, styles.varianceNegative)}>
                  {liveQuery.enabled && !dashboardReady || amountVariance === undefined ? '—' : exactSignedMoney(amountVariance)}
                </strong>
              </span>
              <span>
                <small>{t('common.assistantSurface.regionalApproval.scopeTotals.planQuantity')}</small>
                <strong>{liveQuery.enabled && !dashboardReady ? '—' : `${quantityText(metrics.quantity)} ${t('common.assistantSurface.regionalApproval.scopeTotals.quantityUnit')}`}</strong>
              </span>
              {liveQuery.enabled && (liveQuery.queueState.status === 'loading' || liveCategoriesLoading) ? <Spin className={styles.dashboardSpinner} size={14} /> : null}
              {liveQuery.enabled && (liveQuery.queueState.status === 'error' || (dashboardReady && metrics.amount === '—')) ? (
                <Button className={styles.dashboardMessage} size='mini' onClick={refreshLiveAuthority}>
                  {t('common.assistantSurface.regionalApproval.scopeTotals.retry')}
                </Button>
              ) : null}
            </div>
          </header>
          <div className={styles.queueHeader}>
            <div className={styles.controlToolbar}>
              <div className={styles.dimensionControls}>
                <label className={styles.categorySwitch}>
                  <Switch
                    size='small'
                    checked={categoryComparison}
                    aria-label={t('common.assistantSurface.regionalApproval.categoryComparison')}
                    onChange={setCategoryComparison}
                  />
                  <span>{t('common.assistantSurface.regionalApproval.categoryComparison')}</span>
                </label>
                <div
                  className={styles.dimensionTabs}
                  role='tablist'
                  aria-label={t('common.assistantSurface.regionalApproval.dimensions.ariaLabel')}
                >
                  {availableDimensions.map((candidate) => (
                    <Button
                      key={candidate}
                      size='small'
                      type='text'
                      role='tab'
                      aria-selected={candidate === dimension}
                      data-active={candidate === dimension}
                      onClick={() => {
                        setSelectedRowIds([]);
                        setLiveAuthorityContext(undefined);
                        setDimension(candidate);
                      }}
                    >
                      {t(`common.assistantSurface.regionalApproval.dimensions.${candidate}`)}
                    </Button>
                  ))}
                </div>
              </div>
              <div className={styles.toolbarActions} data-testid='regional-approval-toolbar-actions'>
                <Button
                  className={styles.advancedToggle}
                  size='small'
                  aria-label={t('common.assistantSurface.regionalApproval.filters.toggle')}
                  aria-controls={filterPanelId}
                  aria-expanded={narrowFiltersExpanded}
                  data-active={narrowFiltersExpanded}
                  onClick={() => setNarrowFiltersExpanded((expanded) => !expanded)}
                >
                  <Filter size={16} strokeWidth={3} />
                </Button>
                <Button size='small' icon={<ChartHistogram size={16} />} aria-label={t('common.assistantSurface.regionalApproval.toolbar.progress')} title={t('common.assistantSurface.regionalApproval.toolbar.progress')} onClick={() => setProgressOpen(true)} />
                {liveQuery.enabled ? (
                  <Button
                    size='small'
                    icon={<Refresh size={14} />}
                    loading={liveQuery.refreshing}
                    loadingFixedWidth
                    disabled={liveQuery.refreshing}
                    onClick={() => {
                      setPermissionDeniedVersions(new Set());
                      liveAccess.refresh();
                      liveQuery.refresh();
                    }}
                  aria-label={t('common.assistantSurface.regionalApproval.toolbar.refreshData')}
                  title={t('common.assistantSurface.regionalApproval.toolbar.refreshData')}
                  />
                ) : null}
                <Button
                  size='small'
                  icon={<Download size={14} />}
                  disabled={liveQuery.enabled && liveQuery.queueState.status !== 'success'}
                  onClick={() => void exportQueue()}
                  loading={exporting}
                  aria-label={t(liveQuery.enabled ? 'common.assistantSurface.regionalApproval.toolbar.exportPage' : 'common.assistantSurface.regionalApproval.toolbar.export')}
                  title={t(liveQuery.enabled ? 'common.assistantSurface.regionalApproval.toolbar.exportPage' : 'common.assistantSurface.regionalApproval.toolbar.export')}
                />
                <div className={styles.approvalToolbarActions}>{approvalActionButtons}</div>
              </div>
            </div>
          </div>
          <section
            className={styles.controls}
            aria-label={t('common.assistantSurface.regionalApproval.filters.ariaLabel')}
          >
            <div id={filterPanelId} className={styles.advancedControls} data-expanded={narrowFiltersExpanded}>
              <div className={`${styles.filterRow} ${liveQuery.enabled ? styles.liveFilterRow : ''}`}>
                <div className={styles.fieldControl}>
                  <span>{t('common.assistantSurface.regionalApproval.filters.area')}</span>
                  <Select
                    size='small'
                    value={liveQuery.enabled ? draftLiveFilters.areaCode : draftFilters.area}
                    aria-label={t('common.assistantSurface.regionalApproval.filters.area')}
                    onChange={(value) =>
                      liveQuery.enabled ? updateLiveDraftFilter('areaCode', value) : updateDraftFilter('area', value)
                    }
                  >
                    <Select.Option value={ALL_ORGANIZATIONS}>
                      {t('common.assistantSurface.regionalApproval.filters.allAreas')}
                    </Select.Option>
                    {liveQuery.enabled
                      ? liveFilterOptions.areas.map((option) => (
                          <Select.Option key={option.value} value={option.value}>
                            {option.label ?? option.value}
                          </Select.Option>
                        ))
                      : filterOptions.area.map((value) => (
                          <Select.Option key={value} value={value}>
                            {t(areaLabelKey(value as RegionalApprovalRow['areaKey']))}
                          </Select.Option>
                        ))}
                  </Select>
                </div>
                <div className={styles.fieldControl}>
                  <span>{t('common.assistantSurface.regionalApproval.filters.branch')}</span>
                  <Select
                    size='small'
                    value={liveQuery.enabled ? draftLiveFilters.provinceCode : draftFilters.branch}
                    aria-label={t('common.assistantSurface.regionalApproval.filters.branch')}
                    onChange={(value) =>
                      liveQuery.enabled
                        ? updateLiveDraftFilter('provinceCode', value)
                        : updateDraftFilter('branch', value)
                    }
                  >
                    <Select.Option value={ALL_ORGANIZATIONS}>
                      {t('common.assistantSurface.regionalApproval.filters.allBranches')}
                    </Select.Option>
                    {liveQuery.enabled
                      ? liveFilterOptions.provinces.map((option) => (
                          <Select.Option key={option.value} value={option.value}>
                            {option.label ?? option.value}
                          </Select.Option>
                        ))
                      : filterOptions.branch.map((value) => (
                          <Select.Option key={value} value={value}>
                            {t(branchLabelKey(value as RegionalApprovalRow['branchKey']))}
                          </Select.Option>
                        ))}
                  </Select>
                </div>
                <div className={styles.fieldControl}>
                  <span>{t('common.assistantSurface.regionalApproval.filters.department')}</span>
                  <Select
                    size='small'
                    value={liveQuery.enabled ? draftLiveFilters.orgCode : draftFilters.department}
                    aria-label={t('common.assistantSurface.regionalApproval.filters.department')}
                    onChange={(value) =>
                      liveQuery.enabled
                        ? updateLiveDraftFilter('orgCode', value)
                        : updateDraftFilter('department', value)
                    }
                  >
                    <Select.Option value={ALL_ORGANIZATIONS}>
                      {t('common.assistantSurface.regionalApproval.filters.allDepartments')}
                    </Select.Option>
                    {liveQuery.enabled
                      ? liveFilterOptions.organizations.map((option) => (
                          <Select.Option key={option.value} value={option.value}>
                            {option.label ?? option.value}
                          </Select.Option>
                        ))
                      : filterOptions.department.map((value) => (
                          <Select.Option key={value} value={value}>
                            {t(departmentLabelKey(value as RegionalApprovalRow['departmentKey']))}
                          </Select.Option>
                        ))}
                  </Select>
                </div>
                <div className={styles.fieldControl}>
                  <span>{t('common.assistantSurface.regionalApproval.filters.customer')}</span>
                  <Select
                    size='small'
                    value={liveQuery.enabled ? draftLiveFilters.dealerCode : draftFilters.customer}
                    aria-label={t('common.assistantSurface.regionalApproval.filters.customer')}
                    onChange={(value) =>
                      liveQuery.enabled
                        ? updateLiveDraftFilter('dealerCode', value)
                        : updateDraftFilter('customer', value)
                    }
                    showSearch
                  >
                    <Select.Option value={ALL_ORGANIZATIONS}>
                      {t('common.assistantSurface.regionalApproval.filters.allCustomers')}
                    </Select.Option>
                    {liveQuery.enabled
                      ? liveFilterOptions.customers.map((option) => (
                          <Select.Option key={option.dealerCode} value={option.dealerCode}>
                            {option.dealerName ?? option.dealerCode}
                            {option.baseName ? ` · ${option.baseName}` : ''}
                          </Select.Option>
                        ))
                      : filterOptions.customer.map((value) => (
                          <Select.Option key={value} value={value}>
                            {REGIONAL_APPROVAL_ROWS.find((row) => row.customerKey === value)?.customerCode} ·{' '}
                            {t(customerLabelKey(value as RegionalApprovalRow['customerKey']))}
                          </Select.Option>
                        ))}
                  </Select>
                </div>
                <div className={styles.fieldControl}>
                  <span>{t('common.assistantSurface.regionalApproval.filters.approval')}</span>
                  <Select
                    size='small'
                    value={liveQuery.enabled ? draftLiveFilters.status : draftFilters.approval}
                    aria-label={t('common.assistantSurface.regionalApproval.filters.approval')}
                    onChange={(value) =>
                      liveQuery.enabled ? updateLiveDraftFilter('status', value) : updateDraftFilter('approval', value)
                    }
                  >
                    <Select.Option value={ALL_ORGANIZATIONS}>
                      {t('common.assistantSurface.regionalApproval.filters.allApprovals')}
                    </Select.Option>
                    {liveQuery.enabled
                      ? Array.from({ length: 11 }, (_, index) => String(index)).map((value) => (
                          <Select.Option key={value} value={value}>
                            {salesPlanStatusText(Number(value), liveQuery.selectedPlanTypeCode ?? 'Y', t)}
                          </Select.Option>
                        ))
                      : filterOptions.approval.map((value) => (
                          <Select.Option key={value} value={value}>
                            {t(`common.assistantSurface.regionalApproval.status.${value}`)}
                          </Select.Option>
                        ))}
                  </Select>
                </div>
                {!liveQuery.enabled ? (
                  <div className={styles.fieldControl}>
                    <span>{t('common.assistantSurface.regionalApproval.filters.health')}</span>
                    <Select
                      size='small'
                      value={draftFilters.health}
                      aria-label={t('common.assistantSurface.regionalApproval.filters.health')}
                      onChange={(value) => updateDraftFilter('health', value)}
                    >
                      <Select.Option value={ALL_ORGANIZATIONS}>
                        {t('common.assistantSurface.regionalApproval.filters.allHealth')}
                      </Select.Option>
                      {filterOptions.health.map((value) => (
                        <Select.Option key={value} value={value}>
                          {t(`common.assistantSurface.regionalApproval.health.${value}`)}
                        </Select.Option>
                      ))}
                    </Select>
                  </div>
                ) : null}
                {/* 删掉「组织范围」标题行后，状态标签跟查询/重置放在同一格，不丢信息也不挤占筛选列。 */}
                <div className={styles.filterActions}>
                  {!liveQuery.enabled ? (
                    <Tag color='orange'>{t('common.assistantSurface.regionalApproval.query.fixtureScopeTag')}</Tag>
                  ) : null}
                  {(liveQuery.enabled ? liveFiltersDirty : filtersDirty) ? (
                    <Tag color='orange'>{t('common.assistantSurface.regionalApproval.filters.dirty')}</Tag>
                  ) : null}
                  <Button
                    size='small'
                    onClick={applyFilters}
                    disabled={liveQuery.enabled ? !liveFiltersDirty : !filtersDirty}
                  >
                    {t('common.assistantSurface.regionalApproval.filters.query')}
                  </Button>
                  <Button size='small' icon={<Refresh size={14} />} onClick={resetFilters}>
                    {t('common.assistantSurface.regionalApproval.filters.reset')}
                  </Button>
                </div>
              </div>
            </div>
            {exportFeedback ? (
              <Alert
                className={styles.exportFeedback}
                type={exportFeedback.type}
                content={exportFeedback.message}
                closable
                onClose={() => setExportFeedback(undefined)}
              />
            ) : null}
          </section>
          <div ref={tableViewportRef} className={styles.tableViewport}>
            {liveQuery.enabled ? (
              <Spin loading={liveQuery.queueState.status === 'loading'} className={styles.querySpin}>
                {liveQuery.queueState.status === 'error' ? (
                  <Alert
                    className={styles.queryAlert}
                    type='error'
                    showIcon
                    title={t('common.assistantSurface.regionalApproval.query.queueErrorTitle')}
                    content={t(queryErrorKey(liveQuery.queueState.error))}
                    action={
                      <Button size='small' onClick={refreshLiveAuthority}>
                        {t('common.assistantSurface.regionalApproval.query.retry')}
                      </Button>
                    }
                  />
                ) : null}
                {liveQuery.queueState.status === 'success' && liveRows.length === 0 ? (
                  <Empty
                    description={
                      <div>
                        <strong>{t('common.assistantSurface.regionalApproval.query.emptyQueue')}</strong>
                        <br />
                        <small>{t('common.assistantSurface.regionalApproval.query.emptyQueueHint')}</small>
                      </div>
                    }
                  />
                ) : (
                  <Table
                    rowKey='tableRowId'
                    columns={liveColumns}
                    data={liveTableRows}
                    className={styles.organizationTable}
                    tableLayoutFixed
                    indentSize={20}
                    expandedRowRender={(record) => {
                      if (record.kind === 'plan' && record.members) return null;
                      const access = inlineSkuAccess(record.plan);
                      return (
                        <InlineSkuDetails
                          row={{ ...record.plan, versionId: versionMetrics[record.plan.planId]?.versionId ?? record.plan.versionId }}
                          t={t}
                          detail={access.detail}
                          approvalRole={access.role}
                          canEdit={record.kind === 'plan' && Boolean(access.detail)}
                          categoryName={record.kind === 'category' ? record.category.categoryName : undefined}
                          onMetricsChange={record.kind === 'plan' && !record.members ? (metrics) => handleLiveAdjustmentMetrics(record.plan.planId, metrics) : undefined}
                          onPendingValuesChange={record.kind === 'plan' && !record.members ? (values) => handleLivePendingValues(record.plan.planId, values) : undefined}
                          draftPatch={draftPatch && draftPatch.planId === record.plan.planId ? draftPatch : undefined}
                          onElementsChange={(fields, collection) =>
                            handleInlineElements(record.plan.planId, fields, collection)
                          }
                        />
                      );
                    }}
                    // V1.8 #10：去掉行首独立展开箭头，展开/收起统一走组织名称；这里只保留展开能力。
                    // 宽度必须给非 0 值：Arco 计算固定列偏移时用 `width || 40`，给 0 会被当成 40，左列会压掉 40px。
                    expandProps={{ width: 1, icon: () => null }}
                    expandedRowKeys={[...expandedLiveGroups, ...(inlinePlanId ? [inlinePlanId] : [])]}
                    onExpandedRowsChange={setExpandedLiveGroups}
                    loading={liveCategoriesLoading}
                    rowClassName={(row) => row.kind === 'category' ? styles.categoryComparisonRow : row.members ? styles.organizationGroupRow : ''}
                    rowSelection={{
                      type: 'checkbox',
                      checkAll: false,
                      fixed: pinLiveColumns,
                      columnWidth: 40,
                      selectedRowKeys: selectedLiveTableRowIds,
                      onChange: (keys) => {
                        // 分组行的勾选状态是「组内成员全部选中」的派生结果，不能按 key 是否存在直接重算：
                        // 取消分组时只去掉分组 key，成员计划还在选，下一次渲染又把分组派生成勾选，表现为取消不掉。
                        const next = new Set(keys.map(String));
                        const displayed = new Set(selectedLiveTableRowIds);
                        const planIds = new Set(selectedRowIds);
                        const coveredPlans = (row: RegionalApprovalLiveTableRow | undefined) =>
                          row?.kind !== 'plan'
                            ? []
                            : row.members?.length
                              ? row.members.map((member) => member.planId)
                              : [row.plan.planId];
                        for (const key of next)
                          if (!displayed.has(key))
                            coveredPlans(liveTableRowById.get(key)).forEach((planId) => planIds.add(planId));
                        for (const key of displayed) {
                          if (next.has(key)) continue;
                          const row = liveTableRowById.get(key);
                          // 分组行只有在成员仍全部保留时才是「用户取消了整个分组」；
                          // 否则它只是成员变化引起的派生取消，交给成员自己的 key 处理。
                          if (row?.kind === 'plan' && row.members?.length) {
                            const members = row.members.map((member) => member.planId);
                            if (!members.every((planId) => next.has(planId))) continue;
                            members.forEach((planId) => planIds.delete(planId));
                            continue;
                          }
                          coveredPlans(row).forEach((planId) => planIds.delete(planId));
                        }
                        setSelectedRowIds([...planIds]);
                      },
                      checkboxProps: (row) => ({
                        // 返回状态只能进入纠偏重提流程，不能在当前审批节点再次提交。
                        disabled: row.kind !== 'plan' || (row.kind === 'plan' && row.plan.status >= 6 && row.plan.status <= 9),
                      }),
                    }}
                    pagination={false}
                    size='small'
                    scroll={{ x: liveTableWidth }}
                  />
                )}
              </Spin>
            ) : (
              <Table
                rowKey='id'
                columns={columns}
                data={pageData.rows}
                rowSelection={{
                  selectedRowKeys: selectedRowIds,
                  onChange: (keys) => setSelectedRowIds(keys.map(String)),
                }}
                pagination={false}
                size='small'
                scroll={{ x: 1360 }}
              />
            )}
          </div>
          <footer className={styles.queueFooter} data-testid='regional-approval-queue-footer'>
            <div className={styles.footerControls}>
              <div className={styles.pageSizeControl}>
                <span>{t('common.assistantSurface.regionalApproval.pagination.pageSize')}</span>
                <Select
                  size='small'
                  value={pageSize}
                  aria-label={t('common.assistantSurface.regionalApproval.pagination.pageSize')}
                  onChange={(value) => {
                    setPageSize(Number(value));
                    setPage(1);
                  }}
                >
                  {[10, 20, 50, 100].map((size) => (
                    <Select.Option key={size} value={size}>
                      {t('common.assistantSurface.regionalApproval.pagination.pageSizeValue', { count: size })}
                    </Select.Option>
                  ))}
                </Select>
              </div>
              <span>
                {t('common.assistantSurface.regionalApproval.pagination.total', {
                  count: liveQuery.enabled ? liveOuterRows.length : pageData.total,
                })}
              </span>
              <Pagination
                size='small'
                current={liveQuery.enabled ? liveCurrentPage : pageData.page}
                pageSize={liveQuery.enabled ? pageSize : pageData.pageSize}
                total={liveQuery.enabled ? liveOuterRows.length : pageData.total}
                onChange={(next) => setPage(Math.min(Math.max(1, next), liveQuery.enabled ? livePageCount : pageData.pageCount))}
              />
            </div>
          </footer>
        </section>
      </div>

      <Modal
        visible={progressOpen}
        title={t('common.assistantSurface.regionalApproval.progressDialog.title', {
          stage: liveQuery.enabled
            ? t('common.assistantSurface.regionalApproval.progressDialog.allStages')
            : t(stageLabelKey(currentStage)),
        })}
        footer={
          <Button onClick={() => setProgressOpen(false)}>
            {t('common.assistantSurface.regionalApproval.progressDialog.close')}
          </Button>
        }
        onCancel={() => setProgressOpen(false)}
        className={styles.progressModal}
      >
        <Typography.Paragraph type='secondary'>
          {liveQuery.enabled
            ? t('common.assistantSurface.regionalApproval.progressDialog.liveScope', {
                month: liveQuery.selectedPeriodMonth ?? '—',
                stage: t(`common.assistantSurface.regionalApproval.stages.${liveStageFilter ?? 'all'}`),
              })
            : t('common.assistantSurface.regionalApproval.progressDialog.description', {
                version: versionLabel(primaryVersion),
                count: metrics.visibleCount,
              })}
        </Typography.Paragraph>
        <div className={styles.progressList} data-testid='regional-approval-progress-results'>
          {liveQuery.enabled ? (
            <RegionalApprovalLiveProgress
              key={JSON.stringify([liveQuery.selectedPeriodMonth, liveQueryScope, liveStageFilter])}
              records={liveQuery.analysisRecords}
              status={liveQuery.analysisSummary.status}
              error={liveQuery.analysisSummary.error}
              t={t}
              onRetry={liveQuery.retryQueue}
            />
          ) : (
            visibleRows.map((row) => {
              const versionMetrics = metricsForApprovalVersion(row, primaryVersion);
              const progress = Math.round((row.quantityProgress + row.amountProgress) / 2);
              return (
                <div className={styles.progressRow} key={row.id}>
                  <span>
                    <strong>{t(organizationLabelKey(row.organizationKey))}</strong>
                    <small>
                      {number(versionMetrics.quantity)} · {money(versionMetrics.amount)}
                    </small>
                  </span>
                  <Progress percent={progress} size='small' />
                  <Tag color={approvalColors[row.approvalState]}>
                    {t(`common.assistantSurface.regionalApproval.status.${row.approvalState}`)}
                  </Tag>
                </div>
              );
            })
          )}
        </div>
      </Modal>

      {activeDetailRow ? (
        <RegionalApprovalPlanDetail
          visible
          rows={visibleRows}
          row={activeDetailRow}
          approvalStage={currentStage}
          categoryComparison={categoryComparison}
          version={primaryVersion}
          store={detailStore}
          t={t}
          onStoreChange={setDetailStore}
          onClose={() => setDetailRowId(undefined)}
          onRowChange={setDetailRowId}
          onVersionChange={changePrimaryVersion}
        />
      ) : null}

      {activeLiveDetailRow ? (
        <RegionalApprovalLivePlanDetail
          visible
          rows={liveRows}
          row={activeLiveDetailRow}
          t={t}
          client={detailClient}
          initialTab={liveDetailInitialTab}
          initialFromVersionId={liveCompareVersionId}
          initialToVersionId={livePrimaryVersionId}
          onClose={() => setLiveDetailPlanId(undefined)}
          onRowChange={(planId) => {
            const row = liveRows.find((candidate) => candidate.planId === planId);
            if (row) selectLivePlanContext(row);
            setLiveDetailPlanId(planId);
          }}
          onCompareFromVersionChange={changeLiveCompareVersion}
          onCompareToVersionChange={changeLivePrimaryVersion}
        />
      ) : null}

      {liveActionDialog}

      {activeActionRow ? (
        <RegionalApprovalActionDialog
          visible
          rows={selectedFixtureRows.length > 0 ? selectedFixtureRows : [activeActionRow]}
          version={primaryVersion}
          approvalStage={currentStage}
          savedAdjustments={savedAdjustments}
          store={actionStore}
          t={t}
          executor={actionExecutor}
          onStoreChange={setActionStore}
          onClose={() => setActionRowId(undefined)}
        />
      ) : null}
    </main>
  );
};

const SalesPlanWorkbench: React.FC<React.ComponentProps<typeof RegionalApprovalWorkbench>> = (props) => {
  const [orderType, setOrderType] = useState<'M' | 'Z'>('M');
  const context = useRef<RegionalApprovalWorkbenchContext>();
  const onContextChange: typeof props.onContextChange = useCallback((value, id) => {
    context.current = value;
    props.onContextChange(value, id);
  }, [props.onContextChange]);
  const monthlyClient = useMemo(() => props.queryClient ? {
    ...props.queryClient,
    list: { invoke: (query: Parameters<NonNullable<typeof props.queryClient>['list']['invoke']>[0]) => props.queryClient!.list.invoke({...query,orderType:'M'}) },
  } : props.queryClient, [props.queryClient]);
  const select = (value: 'M' | 'Z') => {
    if (value === orderType) return;
    if (context.current) props.onContextChange({ ...context.current, selectedEntities: [],
      evidence: { ...context.current.evidence, queryState: 'loading' } }, null);
    setOrderType(value);
  };
  const headerControls = <div role="tablist" aria-label={props.t("common.correction.tabs")} className={styles.orderTabs}>
      {(['M','Z'] as const).map(value => <Button size='small' key={value} role="tab" aria-selected={orderType === value}
        type={orderType === value ? 'primary' : 'secondary'} onClick={() => select(value)}>
        {props.t(value === 'M' ? 'common.correction.monthly' : 'common.correction.correction')}
      </Button>)}
    </div>;
  return orderType === 'M' ? <RegionalApprovalWorkbench {...props} headerControls={headerControls} queryClient={monthlyClient} onContextChange={onContextChange} /> :
      <CorrectionWorkbench headerControls={headerControls} t={props.t} queryClient={props.queryClient} detailClient={props.detailClient} actionClient={props.liveActionsEnabled ? props.liveActionClient : undefined} onResubmit={props.onResubmit} />;

};
export default SalesPlanWorkbench;
