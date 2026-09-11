/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import { isBackendHttpError } from '../../../http-error.ts';
import {
  salesPlan,
  type GeaSalesPlanApprovalLog,
  type GeaSalesPlanDetail,
  type GeaSalesPlanResourceQuery,
  type GeaSalesPlanSku,
  type GeaSalesPlanSkuDiff,
  type GeaSalesPlanVersion,
  type GeaSalesPlanVersionSkuQuery,
  type GeaSalesPlanCompareQuery,
} from '../../../bridge.ts';
import { useEffect, useRef, useState } from 'react';
import {
  salesPlanComparisonMatches,
  salesPlanOverviewMatches,
  salesPlanSkusMatchVersion,
} from '../models/salesPlanDetailModel.ts';

const DETAIL_TIMEOUT_MS = 15_000;

export type SalesPlanDetailError =
  | 'permission'
  | 'expired'
  | 'missing'
  | 'versionMismatch'
  | 'timeout'
  | 'unavailable'
  | 'cancelled'
  | 'failed';

export type SalesPlanDetailState<T> =
  | { status: 'idle'; data?: undefined; error?: undefined }
  | { status: 'loading'; data?: undefined; error?: undefined }
  | { status: 'success'; data: T; error?: undefined }
  | { status: 'error'; data?: undefined; error: SalesPlanDetailError };

export type SalesPlanDetailClient = {
  detail: { invoke: (query: GeaSalesPlanResourceQuery) => Promise<GeaSalesPlanDetail> };
  versions: { invoke: (query: GeaSalesPlanResourceQuery) => Promise<GeaSalesPlanVersion[]> };
  logs: { invoke: (query: GeaSalesPlanResourceQuery) => Promise<GeaSalesPlanApprovalLog[]> };
  versionSkus: { invoke: (query: GeaSalesPlanVersionSkuQuery) => Promise<GeaSalesPlanSku[]> };
  compare: { invoke: (query: GeaSalesPlanCompareQuery) => Promise<GeaSalesPlanSkuDiff[]> };
};

type SalesPlanOverview = {
  detail: GeaSalesPlanDetail;
  versions: GeaSalesPlanVersion[];
  logs: GeaSalesPlanApprovalLog[];
};

const idle = { status: 'idle' } as const;

export const classifySalesPlanDetailError = (error: unknown, timedOut = false): SalesPlanDetailError => {
  if (timedOut) return 'timeout';
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  if (isBackendHttpError(error)) {
    if (error.status === 401) return 'expired';
    if (error.status === 403) return 'permission';
    if (error.status === 404) return 'missing';
    if (error.status === 408 || error.status === 504) return 'timeout';
    if (error.status >= 500) return 'unavailable';
  }
  if (error instanceof TypeError) return 'unavailable';
  return 'failed';
};

const beginRequest = () => {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DETAIL_TIMEOUT_MS);
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

export const useSalesPlanDetail = ({
  client = salesPlan,
  planId,
  initialVersionId,
  initialFromVersionId,
  initialToVersionId,
}: {
  client?: SalesPlanDetailClient;
  planId?: string;
  initialVersionId?: string;
  initialFromVersionId?: string;
  initialToVersionId?: string;
}) => {
  const [overviewState, setOverviewState] = useState<SalesPlanDetailState<SalesPlanOverview>>(idle);
  const [skuState, setSkuState] = useState<SalesPlanDetailState<GeaSalesPlanSku[]>>(idle);
  const [compareState, setCompareState] = useState<SalesPlanDetailState<GeaSalesPlanSkuDiff[]>>(idle);
  const [selectedVersionId, setSelectedVersionId] = useState<string>();
  const [fromVersionId, setFromVersionId] = useState<string>();
  const [toVersionId, setToVersionId] = useState<string>();
  const [overviewRevision, setOverviewRevision] = useState(0);
  const [skuRevision, setSkuRevision] = useState(0);
  const [compareRevision, setCompareRevision] = useState(0);
  const overviewRequest = useRef(0);
  const skuRequest = useRef(0);
  const compareRequest = useRef(0);

  useEffect(() => {
    if (!planId || !initialVersionId) {
      setOverviewState(idle);
      setSkuState(idle);
      setCompareState(idle);
      setSelectedVersionId(undefined);
      setFromVersionId(undefined);
      setToVersionId(undefined);
      return;
    }
    const requestId = ++overviewRequest.current;
    const request = beginRequest();
    setOverviewState({ status: 'loading' });
    setSkuState(idle);
    setCompareState(idle);
    setSelectedVersionId(undefined);
    setFromVersionId(undefined);
    setToVersionId(undefined);
    void Promise.all([
      client.detail.invoke({ planId, signal: request.signal }),
      client.versions.invoke({ planId, signal: request.signal }),
      client.logs.invoke({ planId, signal: request.signal }),
    ])
      .then(([detail, versions, logs]) => {
        if (overviewRequest.current !== requestId || request.signal.aborted) return;
        if (!salesPlanOverviewMatches(planId, initialVersionId, detail, versions, logs)) {
          setOverviewState({ status: 'error', error: 'versionMismatch' });
          return;
        }
        setOverviewState({ status: 'success', data: { detail, versions, logs } });
        setSelectedVersionId(initialVersionId);
        setToVersionId(initialVersionId);
        const current = versions.find((version) => version.id === initialVersionId);
        const previous = versions
          .filter((version) => version.id !== initialVersionId && (!current || version.seq < current.seq))
          .toSorted((left, right) => right.seq - left.seq)[0];
        setFromVersionId(previous?.id ?? versions.find((version) => version.id !== initialVersionId)?.id);
      })
      .catch((error: unknown) => {
        if (overviewRequest.current !== requestId) return;
        const classified = classifySalesPlanDetailError(error, request.didTimeOut());
        if (classified !== 'cancelled' || request.didTimeOut()) {
          setOverviewState({ status: 'error', error: classified });
        }
      })
      .finally(request.finish);
    return request.cancel;
  }, [client, initialVersionId, overviewRevision, planId]);

  useEffect(() => {
    if (overviewState.status !== 'success') return;
    const versionIds = new Set(overviewState.data.versions.map((version) => version.id));
    if (initialFromVersionId && versionIds.has(initialFromVersionId)) setFromVersionId(initialFromVersionId);
    if (initialToVersionId && versionIds.has(initialToVersionId)) setToVersionId(initialToVersionId);
  }, [initialFromVersionId, initialToVersionId, overviewState]);

  useEffect(() => {
    if (overviewState.status !== 'success' || !selectedVersionId) {
      setSkuState(idle);
      return;
    }
    if (!overviewState.data.versions.some((version) => version.id === selectedVersionId)) {
      setSkuState({ status: 'error', error: 'versionMismatch' });
      return;
    }
    const requestId = ++skuRequest.current;
    const request = beginRequest();
    setSkuState({ status: 'loading' });
    void client.versionSkus
      .invoke({ versionId: selectedVersionId, signal: request.signal })
      .then((skus) => {
        if (skuRequest.current !== requestId || request.signal.aborted) return;
        setSkuState(
          salesPlanSkusMatchVersion(selectedVersionId, skus)
            ? { status: 'success', data: skus }
            : { status: 'error', error: 'versionMismatch' }
        );
      })
      .catch((error: unknown) => {
        if (skuRequest.current !== requestId) return;
        const classified = classifySalesPlanDetailError(error, request.didTimeOut());
        if (classified !== 'cancelled' || request.didTimeOut()) setSkuState({ status: 'error', error: classified });
      })
      .finally(request.finish);
    return request.cancel;
  }, [client, overviewState, selectedVersionId, skuRevision]);

  useEffect(() => {
    if (overviewState.status !== 'success' || !fromVersionId || !toVersionId || fromVersionId === toVersionId) {
      setCompareState(idle);
      return;
    }
    const versionIds = new Set(overviewState.data.versions.map((version) => version.id));
    if (!versionIds.has(fromVersionId) || !versionIds.has(toVersionId)) {
      setCompareState({ status: 'error', error: 'versionMismatch' });
      return;
    }
    const requestId = ++compareRequest.current;
    const request = beginRequest();
    setCompareState({ status: 'loading' });
    void client.compare
      .invoke({
        planId: overviewState.data.detail.currentVersion.planId,
        fromVersionId,
        toVersionId,
        signal: request.signal,
      })
      .then((differences) => {
        if (compareRequest.current !== requestId || request.signal.aborted) return;
        setCompareState(
          salesPlanComparisonMatches(fromVersionId, toVersionId, differences)
            ? { status: 'success', data: differences }
            : { status: 'error', error: 'versionMismatch' }
        );
      })
      .catch((error: unknown) => {
        if (compareRequest.current !== requestId) return;
        const classified = classifySalesPlanDetailError(error, request.didTimeOut());
        if (classified !== 'cancelled' || request.didTimeOut()) {
          setCompareState({ status: 'error', error: classified });
        }
      })
      .finally(request.finish);
    return request.cancel;
  }, [client, compareRevision, fromVersionId, overviewState, toVersionId]);

  return {
    overviewState,
    skuState,
    compareState,
    selectedVersionId,
    fromVersionId,
    toVersionId,
    selectVersion: setSelectedVersionId,
    selectFromVersion: setFromVersionId,
    selectToVersion: setToVersionId,
    retryOverview: () => setOverviewRevision((revision) => revision + 1),
    retrySkus: () => setSkuRevision((revision) => revision + 1),
    retryCompare: () => setCompareRevision((revision) => revision + 1),
  };
};
