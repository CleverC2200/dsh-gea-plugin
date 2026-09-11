/** Explicit host methods for the copied workbench; no AionUi process or IPC is loaded. */
import type * as Api from './contracts.ts';

export type * from './contracts.ts';

/** Host-owned GEA transport. Authentication, authorization and writes remain on the server. */
export interface WorkbenchHost {
  salesPlan: {
    periods: { invoke(query?: Api.GeaSalesPlanPeriodQuery): Promise<Api.GeaSalesPlanPage<Api.GeaSalesPlanPeriod>> };
    list: { invoke(query?: Api.GeaSalesPlanPageQuery): Promise<Api.GeaSalesPlanPage<Api.GeaSalesPlanListItem>> };
    detail: { invoke(query: Api.GeaSalesPlanResourceQuery): Promise<Api.GeaSalesPlanDetail> };
    versions: { invoke(query: Api.GeaSalesPlanResourceQuery): Promise<Api.GeaSalesPlanVersion[]> };
    logs: { invoke(query: Api.GeaSalesPlanResourceQuery): Promise<Api.GeaSalesPlanApprovalLog[]> };
    versionSkus: { invoke(query: Api.GeaSalesPlanVersionSkuQuery): Promise<Api.GeaSalesPlanSku[]> };
    compare: { invoke(query: Api.GeaSalesPlanCompareQuery): Promise<Api.GeaSalesPlanSkuDiff[]> };
    action: { invoke(params: Api.GeaSalesPlanActionParams): Promise<Api.GeaSalesPlanActionReceipt> };
    submit: { invoke(params: Api.GeaSalesPlanSubmitParams): Promise<Api.GeaSalesPlanSubmitReceipt> };
  };
  modelInference: {
    invoke(params: { question: string; signal?: AbortSignal }): Promise<{
      status: 'ok' | 'noAnswer' | 'toolsRequired' | 'timeout' | 'failed';
      provider_id: string;
      model: string;
      answer?: string;
    }>;
  };
}

let current: WorkbenchHost | undefined;

/**
 * Bind one host before mounting this independent workbench document.
 * The returned release only removes that binding. Concurrent workbenches use separate documents.
 */
export function bindWorkbenchHost(host: WorkbenchHost): () => void {
  if (current) throw new Error('WORKBENCH_HOST_ALREADY_BOUND');
  current = host;
  return () => {
    if (current === host) current = undefined;
  };
}

function host(): WorkbenchHost {
  if (!current) throw new Error('WORKBENCH_HOST_NOT_BOUND');
  return current;
}

/** Compatibility names used by the original presentation; every call reaches the configured host. */
export const salesPlan: WorkbenchHost['salesPlan'] = {
  periods: { invoke: (query) => host().salesPlan.periods.invoke(query) },
  list: { invoke: (query) => host().salesPlan.list.invoke(query) },
  detail: { invoke: (query) => host().salesPlan.detail.invoke(query) },
  versions: { invoke: (query) => host().salesPlan.versions.invoke(query) },
  logs: { invoke: (query) => host().salesPlan.logs.invoke(query) },
  versionSkus: { invoke: (query) => host().salesPlan.versionSkus.invoke(query) },
  compare: { invoke: (query) => host().salesPlan.compare.invoke(query) },
  action: { invoke: (params) => host().salesPlan.action.invoke(params) },
  submit: { invoke: (params) => host().salesPlan.submit.invoke(params) },
};

/** Stateless SKU advice retains the original response statuses. */
export const modelInference: WorkbenchHost['modelInference'] = {
  invoke: (params) => host().modelInference.invoke(params),
};
