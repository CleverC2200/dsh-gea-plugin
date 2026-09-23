/** 改编自 AionUi（Apache-2.0）：已替换为本地导入并使用显式 DSH Host 适配器，见 SOURCE.md。 */
import { salesPlanWorkflow } from '../../salesPlanWorkflow.ts';
import { isBackendHttpError } from '../../http-error.ts';
import {
  salesPlan,
  type GeaSalesPlanListItem,
  type GeaSalesPlanPage,
  type GeaSalesPlanPageQuery,
  type GeaSalesPlanPeriod,
  type GeaSalesPlanPeriodQuery,
} from '../../bridge.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addExactDecimals,
  approvalStageProgressForSalesPlanPeriods,
  chooseInitialSalesPlanPeriod,
  clampSalesPlanPageNumber,
  SALES_PLAN_PROGRESS_STATUSES,
  salesPlanPeriodMonths,
  salesPlanPeriodsForMonth,
  salesPlanStageTallies,
  salesPlanVisibleStatuses,
  type RegionalApprovalQueryScope,
  type SalesPlanStageTally,
} from './regionalApprovalQueryModel.ts';
import type { ApprovalStageId } from './regionalApprovalFixture.ts';
import { REGIONAL_PLAN_EVALUATION_STATUSES } from './regionalApprovalFixture.ts';
import type { SalesPlanApprovalRole } from './models/salesPlanAccessModel.ts';

const QUERY_TIMEOUT_MS = 15_000;

/** 查询状态按“周期→队列→进度/分析”分层；请求序号和 AbortSignal 防止晚到结果覆盖新选择。 */
export type SalesPlanQueryClient = {
  periods: { invoke: (query?: GeaSalesPlanPeriodQuery) => Promise<GeaSalesPlanPage<GeaSalesPlanPeriod>> };
  list: { invoke: (query?: GeaSalesPlanPageQuery) => Promise<GeaSalesPlanPage<GeaSalesPlanListItem>> };
  /** 可选：点刷新时重新解析账号角色，拿到管理员刚改过的节点权限。 */
  approvalRoles?: { invoke: (input: { signal?: AbortSignal }) => Promise<{ roles: SalesPlanApprovalRole[] }> };
};

export type RegionalApprovalQueryError = 'workflow' | 'permission' | 'expired' | 'timeout' | 'unavailable' | 'cancelled' | 'failed';

type QueryState<T> =
  | { status: 'idle'; data?: undefined; error?: undefined }
  | { status: 'loading'; data?: T; error?: undefined }
  | { status: 'success'; data: T; error?: undefined }
  | { status: 'error'; data?: T; error: RegionalApprovalQueryError };

export type SalesPlanAnalysisSummary = {
  source: 'gea-user-session';
  completeness: 'filtered-scope';
  version: 'current';
  count: number;
  quantity: string;
  amount: string;
  targetAmount: string;
};

const idle = { status: 'idle' } as const;

export const classifyRegionalApprovalQueryError = (error: unknown, timedOut = false): RegionalApprovalQueryError => {
  if (isBackendHttpError(error) && error.code === 'GEA_WORKFLOW_LOAD_FAILED') return 'workflow';
  if (timedOut) return 'timeout';
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  if (isBackendHttpError(error)) {
    if (error.status === 401) return 'expired';
    if (error.status === 403) return 'permission';
    if (error.status === 408 || error.status === 504) return 'timeout';
    if (error.status >= 500) return 'unavailable';
  }
  if (error instanceof TypeError) return 'unavailable';
  return 'failed';
};

const beginTimedRequest = () => {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, QUERY_TIMEOUT_MS);
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    finish: () => window.clearTimeout(timeout),
    cancel: () => {
      window.clearTimeout(timeout);
      controller.abort();
    },
  };
};

export const useRegionalApprovalQuery = ({
  client = salesPlan,
  page,
  pageSize,
  scope,
  loadStageProgress = false,
  loadAnalysisSummary = false,
  stageStatuses,
  stage,
  roles,
}: {
  client?: SalesPlanQueryClient | null;
  page: number;
  pageSize: number;
  scope?: RegionalApprovalQueryScope;
  loadStageProgress?: boolean;
  loadAnalysisSummary?: boolean;
  stageStatuses?: readonly number[];
  stage?: ApprovalStageId;
  roles?: readonly ApprovalStageId[];
}) => {
  const [analysisResult, setAnalysisResult] =
    useState<QueryState<{ summary: SalesPlanAnalysisSummary; records: GeaSalesPlanListItem[] }>>(idle);
  const analysisSummary = useMemo<QueryState<SalesPlanAnalysisSummary>>(
    () =>
      analysisResult.status === 'success'
        ? { status: 'success', data: analysisResult.data.summary }
        : analysisResult.status === 'error'
          ? { status: 'error', error: analysisResult.error }
          : { status: analysisResult.status },
    [analysisResult]
  );
  const [periodsState, setPeriodsState] = useState<QueryState<GeaSalesPlanPeriod[]>>(idle);
  const [queueState, setQueueState] = useState<QueryState<GeaSalesPlanPage<GeaSalesPlanListItem>>>(idle);
  const [progressState, setProgressState] = useState<
    QueryState<Record<ApprovalStageId, number>> & {
      statusTotals?: Partial<Record<number, number>>;
      /** 每个节点的分子/分母，界面悬停百分比时展示；百分比本身就是它算出来的。 */
      tallies?: Record<ApprovalStageId, SalesPlanStageTally>;
    }
  >(idle);
  const [selectedPeriodMonth, setSelectedPeriodMonth] = useState<string>();
  const [queueSettledPage, setQueueSettledPage] = useState<number>();
  const [queueSettledStageKey, setQueueSettledStageKey] = useState<string>();
  const [periodRevision, setPeriodRevision] = useState(0);
  const [queueRevision, setQueueRevision] = useState(0);
  const periodsRequest = useRef(0);
  const queueRequest = useRef(0);
  const progressRequest = useRef(0);
  const stableScope = useMemo(
    () => ({
      dealerCode: scope?.dealerCode,
      areaCode: scope?.areaCode,
      provinceCode: scope?.provinceCode,
      orgCode: scope?.orgCode,
      baseName: scope?.baseName,
      status: scope?.status,
    }),
    [scope?.areaCode, scope?.baseName, scope?.dealerCode, scope?.orgCode, scope?.provinceCode, scope?.status]
  );
  useEffect(() => {
    if (!client) {
      setPeriodsState(idle);
      setQueueState(idle);
      setProgressState(idle);
      setSelectedPeriodMonth(undefined);
      setQueueSettledPage(undefined);
      setQueueSettledStageKey(undefined);
      return;
    }
    const requestId = ++periodsRequest.current;
    const request = beginTimedRequest();
    setPeriodsState((current) => ({ status: 'loading', data: current.data }));
    void client.periods
      .invoke({ pageNo: 1, pageSize: 100, signal: request.signal })
      .then((response) => {
        if (periodsRequest.current !== requestId || request.signal.aborted) return;
        const records = Array.isArray(response.records) ? response.records : [];
        setPeriodsState({ status: 'success', data: records });
        setSelectedPeriodMonth((current) => {
          if (current && records.some((period) => period.periodMonth === current)) return current;
          return chooseInitialSalesPlanPeriod(records)?.periodMonth;
        });
      })
      .catch((error: unknown) => {
        if (periodsRequest.current !== requestId) return;
        const classified = classifyRegionalApprovalQueryError(error, request.didTimeOut());
        if (classified !== 'cancelled' || request.didTimeOut()) {
          setPeriodsState((current) => ({ status: 'error', data: current.data, error: classified }));
        }
      })
      .finally(request.finish);
    return request.cancel;
  }, [client, periodRevision]);

  const periods = periodsState.data ?? [];
  const periodMonths = salesPlanPeriodMonths(periods);
  const selectedPeriods = salesPlanPeriodsForMonth(periods, selectedPeriodMonth);
  const selectedPlanTypeCodes = [...new Set(selectedPeriods.map((period) => period.planTypeCode))];
  const selectedPlanTypeCode = selectedPlanTypeCodes.length === 1 ? selectedPlanTypeCodes[0] : undefined;
  const periodQueries = selectedPeriods.map((period) => {
    const roleStatuses = roles?.length ? salesPlanVisibleStatuses(period.planTypeCode, roles) : undefined;
    const requestedStatuses = stage
      ? (stage as string) === 'evaluation'
        ? [...REGIONAL_PLAN_EVALUATION_STATUSES]
        : salesPlanWorkflow(period.planTypeCode).queueStatuses(stage)
      : stageStatuses;
    const resolved = roleStatuses
      ? roleStatuses.filter((status) => !requestedStatuses || requestedStatuses.includes(status))
      : requestedStatuses;
    const statuses = resolved
      ? [...new Set(resolved.filter((status) => Number.isSafeInteger(status) && (scope?.status === undefined || scope.status === status)))].toSorted((a, b) => a - b)
      : undefined;
    return { period, statuses };
  });
  const stageStatusesKey = periodQueries
    .map(({ period, statuses }) => `${period.periodId}:${statuses === undefined ? '*' : statuses.join(',')}`)
    .join('|');

  useEffect(() => {
    if (periodsState.status !== 'success' || !client || periodQueries.length === 0) {
      setQueueState(idle);
      setQueueSettledPage(undefined);
      return;
    }
    const requestId = ++queueRequest.current;
    const request = beginTimedRequest();
    setQueueState((current) => ({ status: 'loading', data: current.data }));
    setQueueSettledStageKey(undefined);
    const requestedPage = clampSalesPlanPageNumber(page);
    const requestedSize = clampSalesPlanPageNumber(pageSize, 20);
    // 列表最终按“外层组织行”分页，必须在客户端拿到筛选范围内的完整计划集合才能分组，
    // 所以这里不再只取分页前缀，而是把每个分区取全（单页 200 条，按上游 total 循环补齐）。
    const serverPageSize = 200;
    const partitions = periodQueries.flatMap(({ period, statuses }) =>
      (statuses ?? [undefined]).map((status) => ({ period, status }))
    );
    const queuePromise = partitions.length === 0
      ? Promise.resolve({ records: [], total: 0, size: requestedSize, current: requestedPage, pages: 1 })
      : Promise.all(
          partitions.map(async ({ period, status }) => {
            const baseQuery = {
              ...stableScope,
              periodId: period.periodId,
              planTypeCode: period.planTypeCode,
              status,
              pageNo: 1,
              pageSize: serverPageSize,
              signal: request.signal,
            };
            const first = await client.list.invoke(baseQuery);
            const pageSizeOfUpstream = Math.max(1, Math.min(serverPageSize, first.size ?? serverPageSize));
            const pageCount = Math.max(1, Math.ceil(first.total / pageSizeOfUpstream));
            const rest = pageCount > 1
              ? await Promise.all(
                  Array.from({ length: pageCount - 1 }, (_, index) =>
                    client.list.invoke({ ...baseQuery, pageNo: index + 2 })
                  )
                )
              : [];
            return { records: [first, ...rest].flatMap((result) => result.records), total: first.total };
          })
        ).then((results) => {
          // 同一计划只会属于一个 (period, status) 分区；这里再去重一次，
          // 避免上游分页异常重发同一条导致列表出现重复组织行。
          const records = [...new Map(
            results
              .flatMap((result) => result.records)
              .map((record) => [String(record.planId), record] as const)
          ).values()]
            .toSorted((left, right) =>
              String(right.updatedAt ?? right.submitTime ?? right.planId).localeCompare(
                String(left.updatedAt ?? left.submitTime ?? left.planId)
              )
            );
          const total = results.reduce((sum, result) => sum + result.total, 0);
          // records 是完整集合；current / size / pages 只回显调用方请求的分页参数，
          // 真正的分页由工作台按分组后的外层行完成。
          return {
            records,
            total,
            size: requestedSize,
            current: requestedPage,
            pages: Math.max(1, Math.ceil(total / requestedSize)),
          } satisfies GeaSalesPlanPage<GeaSalesPlanListItem>;
        });
    void queuePromise
      .then((response) => {
        if (queueRequest.current !== requestId || request.signal.aborted) return;
        setQueueState({ status: 'success', data: response });
        setQueueSettledPage(requestedPage);
        setQueueSettledStageKey(stageStatusesKey);
      })
      .catch((error: unknown) => {
        if (queueRequest.current !== requestId) return;
        const classified = classifyRegionalApprovalQueryError(error, request.didTimeOut());
        if (classified !== 'cancelled' || request.didTimeOut()) {
          setQueueState((current) => ({ status: 'error', data: current.data, error: classified }));
        }
      })
      .finally(request.finish);
    return request.cancel;
  }, [
    periodsState.status,
    client,
    queueRevision,
    selectedPeriodMonth,
    stageStatusesKey,
    stableScope,
  ]);

  useEffect(() => {
    if (periodsState.status !== 'success' || !client || !loadStageProgress || selectedPeriods.length === 0) {
      setProgressState(idle);
      return;
    }
    const requestId = ++progressRequest.current;
    const request = beginTimedRequest();
    setProgressState((current) => ({ status: 'loading', data: current.data }));
    const statuses = SALES_PLAN_PROGRESS_STATUSES;
    // Progress is based on the full period and organization scope, not the active approval node.
    void Promise.all(selectedPeriods.map(async (period) => {
      const baseQuery = {
        periodId: period.periodId,
        planTypeCode: period.planTypeCode,
        pageNo: 1,
        pageSize: 1,
        ...stableScope,
        status: undefined,
        signal: request.signal,
      };
      const [allRows, ...statusPages] = await Promise.all([
        client.list.invoke(baseQuery),
        ...statuses.map((status) => client.list.invoke({ ...baseQuery, status })),
      ]);
      return {
        total: allRows.total,
        planTypeCode: period.planTypeCode,
        statusTotals: Object.fromEntries(statuses.map((status, index) => [status, statusPages[index]?.total ?? 0])),
      };
    }))
      .then((periodTotals) => {
        if (progressRequest.current !== requestId || request.signal.aborted) return;
        const statusTotals = Object.fromEntries(statuses.map((status) => [
          status,
          periodTotals.reduce((sum, period) => sum + (period.statusTotals[status] ?? 0), 0),
        ]));
        setProgressState({
          status: 'success',
          data: approvalStageProgressForSalesPlanPeriods(periodTotals),
          statusTotals,
          tallies: salesPlanStageTallies(periodTotals),
        });
      })
      .catch((error: unknown) => {
        if (progressRequest.current !== requestId) return;
        const classified = classifyRegionalApprovalQueryError(error, request.didTimeOut());
        if (classified !== 'cancelled' || request.didTimeOut()) {
          setProgressState((current) => ({ status: 'error', data: current.data, error: classified }));
        }
      })
      .finally(request.finish);
    return request.cancel;
  }, [
    periodsState.status,
    client,
    loadStageProgress,
    queueRevision,
    selectedPeriodMonth,
    stableScope,
  ]);

  useEffect(() => {
    if (periodsState.status !== 'success' || !client || !loadAnalysisSummary || periodQueries.length === 0) {
      setAnalysisResult(idle);
      return;
    }
    const request = beginTimedRequest();
    let active = true;
    setAnalysisResult({ status: 'loading' });
    request.signal.addEventListener(
      'abort',
      () => {
        if (active && request.didTimeOut()) setAnalysisResult({ status: 'error', error: 'timeout' });
      },
      { once: true }
    );
    const collect = async () => {
      const rows = new Map<string, GeaSalesPlanListItem>();
      let expectedTotal = 0;
      // 顺序读取页面，避免进入工作台时无界地扩散请求。
      for (const { period, statuses } of periodQueries) {
        for (const status of statuses ?? [stableScope.status]) {
          let pageCount = 1;
          let statusTotal = 0;
          let serverPageSize = 0;
          for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
            request.signal.throwIfAborted();
            // oxlint-disable-next-line no-await-in-loop -- 下一页依赖服务端页大小，并以此限制请求并发。
            const response = await client.list.invoke({
              ...stableScope,
              status,
              periodId: period.periodId,
              planTypeCode: period.planTypeCode,
              pageNo,
              pageSize: 200,
              signal: request.signal,
            });
            request.signal.throwIfAborted();
            if (
              response.current !== pageNo ||
              !Number.isSafeInteger(response.total) ||
              response.total < 0 ||
              !Number.isSafeInteger(response.size) ||
              response.size <= 0
            ) {
              throw new Error('Invalid analysis pagination');
            }
            if (pageNo === 1) {
              statusTotal = response.total;
              serverPageSize = response.size;
              expectedTotal += statusTotal;
              pageCount = Math.max(1, Math.ceil(statusTotal / response.size));
            } else if (response.total !== statusTotal || response.size !== serverPageSize) {
              throw new Error('Analysis scope changed during pagination');
            }
            if (
              response.records.length !==
              Math.min(serverPageSize, Math.max(0, statusTotal - (pageNo - 1) * serverPageSize))
            ) {
              throw new Error('Incomplete analysis page');
            }
            for (const row of response.records) {
              if (
                [row.currentQty, row.currentAmount, row.targetAmount].some(
                  (value) => !/^-?\d+(?:\.\d+)?$/.test(String(value))
                )
              ) {
                throw new Error('Invalid analysis decimal');
              }
              const key = `${period.periodId}:${row.planId}`;
              if (rows.has(key) || row.periodId !== period.periodId || row.planTypeCode !== period.planTypeCode) {
                throw new Error('Inconsistent analysis records');
              }
              rows.set(key, row);
            }
          }
        }
      }
      if (rows.size !== expectedTotal) throw new Error('Incomplete analysis scope');
      const records = [...rows.values()];
      return {
        records,
        summary: {
          source: 'gea-user-session',
          completeness: 'filtered-scope',
          version: 'current',
          count: records.length,
          quantity: addExactDecimals(records.map((row) => String(row.currentQty))),
          amount: addExactDecimals(records.map((row) => String(row.currentAmount))),
          targetAmount: addExactDecimals(records.map((row) => String(row.targetAmount))),
        } satisfies SalesPlanAnalysisSummary,
      };
    };
    void collect()
      .then((data) => {
        if (active && !request.signal.aborted) setAnalysisResult({ status: 'success', data });
      })
      .catch((error: unknown) => {
        if (!active || (request.signal.aborted && !request.didTimeOut())) return;
        setAnalysisResult({ status: 'error', error: classifyRegionalApprovalQueryError(error, request.didTimeOut()) });
      })
      .finally(request.finish);
    return () => {
      active = false;
      request.cancel();
    };
  }, [
    periodsState.status,
    client,
    loadAnalysisSummary,
    selectedPeriodMonth,
    stableScope,
    stageStatusesKey,
    queueRevision,
  ]);

  const refreshing =
    periodsState.status === 'loading' ||
    queueState.status === 'loading' ||
    (loadStageProgress && progressState.status === 'loading');

  return {
    analysisSummary,
    analysisRecords: analysisResult.status === 'success' ? analysisResult.data.records : undefined,
    enabled: client !== null,
    periodsState,
    queueState,
    progressState,
    queueSettledPage,
    queueSettledStageKey,
    stageStatusesKey,
    periods,
    periodMonths,
    selectedPeriodMonth,
    selectedPeriods,
    selectedPlanTypeCode,
    refreshing,
    selectPeriodMonth: (periodMonth: string) => setSelectedPeriodMonth(periodMonth),
    refresh: () => {
      if (refreshing) return;
      setPeriodRevision((current) => current + 1);
      setQueueRevision((current) => current + 1);
    },
    retryPeriods: () => setPeriodRevision((current) => current + 1),
    retryQueue: () => setQueueRevision((current) => current + 1),
  };
};
