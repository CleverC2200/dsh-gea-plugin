import type { SalesPlanLocalDraft } from './workbenches/regionalApproval/models/salesPlanLocalDraftModel.ts';
/** 这是独立工作台与 Host 的唯一端口；不加载 AionUi 进程或 IPC，认证、授权和写入仍由 Host 负责。 */
import type * as Api from './contracts.ts';

export type * from './contracts.ts';

/** 由 Host 持有的 GEA 传输；认证、授权和写入仍由服务端负责。 */
export interface WorkbenchHost {
  salesPlan: {
    draft?: { invoke(params: {planId: string; versionId: string; draft?: SalesPlanLocalDraft; signal?: AbortSignal}): Promise<{draft: SalesPlanLocalDraft | null; sourceSnapshot?: string; savedAt?: string; stale?: boolean}> };
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
 * 挂载独立工作台文档前绑定一个 Host。
 * 返回的释放函数只移除这次绑定；并行工作台使用各自的文档。
 */
export function bindWorkbenchHost(host: WorkbenchHost): () => void {
  // 同一文档只允许一个绑定；释放时核对对象，避免旧文档清掉新 Host。
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

/** 原界面使用的兼容名称；每次调用都会到达已配置的 Host。 */
export const salesPlan: WorkbenchHost['salesPlan'] = {
  draft: { invoke: (input) => { const adapter = host().salesPlan.draft; if (!adapter) return Promise.reject(new Error('DRAFT_UNAVAILABLE')); return adapter.invoke(input); } },
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

/** 无状态 SKU 建议保留原有响应状态。 */
export const modelInference: WorkbenchHost['modelInference'] = {
  invoke: (params) => host().modelInference.invoke(params),
};
