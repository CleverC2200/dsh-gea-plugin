/** 改编自 AionUi（Apache-2.0）：已替换为本地导入并使用显式 DSH Host 适配器，见 SOURCE.md。 */
import { SALES_PLAN_ROLES, salesPlanWorkflow, type SalesPlanWorkflowRow } from '../../../salesPlanWorkflow.ts';
import { isBackendHttpError } from '../../../http-error.ts';
import type {
  GeaSalesPlanActionParams,
  GeaSalesPlanActionReceipt,
  GeaSalesPlanActionRequest,
  GeaSalesPlanSku,
  GeaSalesPlanSkuAdjustment,
  GeaSalesPlanVersionSkuQuery,
} from '../../../bridge.ts';

export type SalesPlanActionClient = {
  action: { invoke: (params: GeaSalesPlanActionParams) => Promise<GeaSalesPlanActionReceipt> };
  versionSkus?: { invoke: (query: GeaSalesPlanVersionSkuQuery) => Promise<GeaSalesPlanSku[]> };
};

export type SalesPlanActionInput = {
  planId: string;
  versionId: string;
  request: GeaSalesPlanActionRequest;
  serverWorkflowResult?: boolean;
  serverRoleResult?: boolean;
  planTypeCode?: string;
};

export type SalesPlanActionErrorKind =
  | 'validation'
  | 'authentication'
  | 'permission'
  | 'conflict'
  | 'rateLimited'
  | 'unavailable'
  | 'failed';

/** 动作模型同时负责输入白名单、状态转换、回执一致性和“是否可重试”分类。 */
export class SalesPlanActionError extends Error {
  constructor(
    readonly kind: SalesPlanActionErrorKind,
    readonly retrySameIntent: boolean,
    readonly retryAfterMs?: number,
    options?: ErrorOptions
  ) {
    super(kind, options);
    this.name = 'SalesPlanActionError';
  }
}

const DECIMAL_PATTERN = /^[+-]?(\d+)(?:\.(\d{1,3}))?$/;
const POSITIVE_LONG_PATTERN = /^[1-9]\d*$/;
const MAX_SIGNED_LONG = BigInt('9223372036854775807');

/** 节点顺序表示角色身份（customer=1、region=2……），绝不是计划状态。 */
export const salesPlanApprovalNodeForStatus = (status: number, typeCode = 'Y', workflowRows?: readonly SalesPlanWorkflowRow[]): number | undefined => {
  const role = salesPlanWorkflow(typeCode, workflowRows).actor(status);
  return role && role !== 'customer' ? SALES_PLAN_ROLES.indexOf(role) + 1 : undefined;
};

export const salesPlanActionTargetStatus = (
  action: GeaSalesPlanActionRequest['action'],
  status: number,
  typeCode = 'Y',
  workflowRows?: readonly SalesPlanWorkflowRow[]
): number | undefined => salesPlanWorkflow(typeCode, workflowRows).transition(status, action);

const isValidAdjustment = (adjustment: GeaSalesPlanSkuAdjustment): boolean => {
  const value = adjustment.adjustQty.trim();
  const decimal = value.match(DECIMAL_PATTERN);
  const skuCode = adjustment.skuCode;
  return Boolean(
    decimal &&
    decimal[1].replace(/^0+/, '').length <= 15 &&
    POSITIVE_LONG_PATTERN.test(skuCode) &&
    BigInt(skuCode) <= MAX_SIGNED_LONG
  );
};

export const validateSalesPlanActionInput = (input: SalesPlanActionInput, workflowRows?: readonly SalesPlanWorkflowRow[]): void => {
  const { request } = input;
  if (!input.planId.trim() || !input.versionId.trim()) throw new SalesPlanActionError('validation', false);
  const flow = salesPlanWorkflow(input.planTypeCode ?? 'Y', workflowRows);
  if (![1,2,3,4,6,7,8,9].includes(request.expectedStatus)) throw new SalesPlanActionError('validation', false);
  if (request.approvalRole && !['region','province','area','category'].includes(request.approvalRole)) throw new SalesPlanActionError('validation', false);
  const approvalNodeOrder = request.approvalRole ? SALES_PLAN_ROLES.indexOf(request.approvalRole) + 1 :
    salesPlanApprovalNodeForStatus(request.expectedStatus, input.planTypeCode, workflowRows);
  if (
    request.action === 'SAVE' &&
    (!/^[a-f0-9]{64}$/.test(request.expectedSnapshot ?? '') || (!request.adjustments?.length && request.adjustmentMode !== 'ABSOLUTE_NET'))
  ) {
    throw new SalesPlanActionError('validation', false);
  }
  if (approvalNodeOrder === undefined) throw new SalesPlanActionError('validation', false);
  const remark = request.remark?.trim() ?? '';
  if (Array.from(remark).length > 1000) throw new SalesPlanActionError('validation', false);
  if (request.action === 'REJECT' && !remark) throw new SalesPlanActionError('validation', false);
  if (request.approvalRole
    ? (!flow.rolesKnown || (request.action === 'REJECT' && flow.pending(request.approvalRole) === undefined))
    : salesPlanActionTargetStatus(request.action, request.expectedStatus, input.planTypeCode, workflowRows) === undefined) {
    throw new SalesPlanActionError('validation', false);
  }
  if (request.action === 'REJECT' && request.adjustments?.length) {
    throw new SalesPlanActionError('validation', false);
  }
  if (approvalNodeOrder === 1 && request.adjustments?.length) {
    throw new SalesPlanActionError('validation', false);
  }
  const skuCodes = new Set<string>();
  for (const adjustment of request.adjustments ?? []) {
    if (!isValidAdjustment(adjustment) || skuCodes.has(adjustment.skuCode)) {
      throw new SalesPlanActionError('validation', false);
    }
    skuCodes.add(adjustment.skuCode);
  }
};

const retryAfterMsFromDetails = (details: unknown): number | undefined => {
  if (!details || typeof details !== 'object') return undefined;
  const value = (details as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
};

/**
 * V1.8 #12 对客红线：给业务的文案里不出现接口、字段名、参数名和错误码。
 * 后端原文只有在“看起来就是业务话术”时才透出；出现 payload./错误码/报文痕迹就退回通用文案。
 */
const TECHNICAL_ERROR_PATTERN = /payload\.|GEA_HTTP|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|为必填字段|\bnull\b|\bundefined\b|https?:\/\/|[{}<>[\]"]/;

export const businessSafeErrorMessage = (message: unknown): string | undefined => {
  if (typeof message !== 'string') return undefined;
  const text = message.trim();
  if (!text || text.length > 80 || TECHNICAL_ERROR_PATTERN.test(text)) return undefined;
  return text;
};

/** 技术细节只进日志，并返回一个可口头转述的错误编号，供用户报给管理员核对。 */
export const reportSalesPlanError = (scope: string, detail: unknown): string => {
  const id = Math.random().toString(36).slice(2, 8).toUpperCase();
  // eslint-disable-next-line no-console
  console.warn(`[gea-error] ${scope} 错误编号=${id}`, detail);
  return id;
};

export const classifySalesPlanActionError = (error: unknown): SalesPlanActionError => {
  if (error instanceof SalesPlanActionError) return error;
  if (isBackendHttpError(error)) {
    if (error.status === 400) return new SalesPlanActionError('validation', false, undefined, { cause: error });
    if (error.status === 401) return new SalesPlanActionError('authentication', false, undefined, { cause: error });
    if (error.status === 403) return new SalesPlanActionError('permission', false, undefined, { cause: error });
    if (error.status === 409) return new SalesPlanActionError('conflict', false, undefined, { cause: error });
    if (error.status === 429) {
      return new SalesPlanActionError('rateLimited', true, retryAfterMsFromDetails(error.details), { cause: error });
    }
    if (error.status >= 500) return new SalesPlanActionError('unavailable', true, undefined, { cause: error });
    return new SalesPlanActionError('failed', false, undefined, { cause: error });
  }
  if (error instanceof TypeError) return new SalesPlanActionError('unavailable', true, undefined, { cause: error });
  return new SalesPlanActionError('failed', false, undefined, { cause: error });
};

export const salesPlanActionReceiptMatches = (
  input: SalesPlanActionInput,
  requestId: string,
  receipt: GeaSalesPlanActionReceipt
): boolean => {
  if (receipt.planId !== input.planId || receipt.versionId !== input.versionId ||
      receipt.fromStatus !== input.request.expectedStatus || receipt.requestId !== requestId ||
      !receipt.traceId?.trim() || !receipt.auditId?.trim()) return false;
  const flow = salesPlanWorkflow(input.planTypeCode ?? 'Y');
  if (input.serverRoleResult) {
    const role = input.request.approvalRole;
    if (!flow.rolesKnown || !role || receipt.approvalRole !== role) return false;
    if (input.request.action === 'SAVE') return receipt.toStatus === receipt.fromStatus;
    if (input.request.action === 'REJECT') {
      const pending = flow.pending(role);
      return pending !== undefined && receipt.toStatus === flow.transition(pending, 'REJECT');
    }
    if (receipt.toStatus === 5) {
      return Array.isArray(receipt.approvedRoles) && SALES_PLAN_ROLES.filter(r => r !== 'customer' && flow.pending(r) !== undefined)
        .every(r => receipt.approvedRoles!.includes(r as NonNullable<typeof role>));
    }
    return receipt.toStatus === receipt.fromStatus ||
      ([1,2,3,4].includes(receipt.toStatus) && flow.actor(receipt.toStatus) !== undefined);
  }
  return receipt.toStatus === salesPlanActionTargetStatus(input.request.action, input.request.expectedStatus, input.planTypeCode) ||
    (input.serverWorkflowResult === true && input.request.action === 'APPROVE' &&
      salesPlanActionTargetStatus('APPROVE', input.request.expectedStatus, input.planTypeCode) !== undefined &&
      receipt.toStatus === input.request.expectedStatus);
};

const normalizedInput = (input: SalesPlanActionInput): SalesPlanActionInput => {
  const { remark, adjustments, ...request } = input.request;
  return {
    planId: input.planId,
    versionId: input.versionId,
    planTypeCode: input.planTypeCode,
    ...(input.serverRoleResult ? { serverRoleResult: true } : {}),
    ...(input.serverWorkflowResult ? { serverWorkflowResult: true } : {}),
    request: {
      ...request,
      ...(remark?.trim() ? { remark: remark.trim() } : {}),
      ...((adjustments?.length || request.adjustmentMode === 'ABSOLUTE_NET' && request.action !== 'REJECT')
        ? {
            adjustments: (adjustments ?? []).map((adjustment) => ({
              skuCode: adjustment.skuCode,
              adjustQty: adjustment.adjustQty,
            })),
          }
        : {}),
    },
  };
};

export class SalesPlanActionAttempt {
  // command 一旦生成便不可替换，保证重试携带同一 requestId 和 idempotencyKey。
  private command?: GeaSalesPlanActionParams;
  private input?: SalesPlanActionInput;
  private inFlight?: Promise<GeaSalesPlanActionReceipt>;
  private receipt?: GeaSalesPlanActionReceipt;
  private failure?: SalesPlanActionError;

  constructor(
    private readonly client: SalesPlanActionClient,
    private readonly createId: () => string = () => crypto.randomUUID()
  ) {}

  submit(input: SalesPlanActionInput): Promise<GeaSalesPlanActionReceipt> {
    validateSalesPlanActionInput(input);
    if (this.receipt) return Promise.resolve(this.receipt);
    if (this.inFlight) return this.inFlight;
    if (this.command) return Promise.reject(this.failure ?? new SalesPlanActionError('failed', false));

    this.input = normalizedInput(input);
    this.command = {
      planId: this.input.planId,
      versionId: this.input.versionId,
      request: this.input.request,
      idempotencyKey: `gea-sales-plan-action:${this.createId()}`,
      requestId: this.createId(),
    };
    return this.invoke();
  }

  retry(): Promise<GeaSalesPlanActionReceipt> {
    if (this.receipt) return Promise.resolve(this.receipt);
    if (this.inFlight) return this.inFlight;
    if (!this.command || !this.failure?.retrySameIntent) {
      return Promise.reject(this.failure ?? new SalesPlanActionError('failed', false));
    }
    return this.invoke();
  }

  private invoke(): Promise<GeaSalesPlanActionReceipt> {
    const command = this.command;
    const input = this.input;
    if (!command || !input) return Promise.reject(new SalesPlanActionError('failed', false));
    this.failure = undefined;
    this.inFlight = this.client.action
      .invoke(command)
      .then((receipt) => {
        if (!salesPlanActionReceiptMatches(input, command.requestId, receipt)) {
          throw new SalesPlanActionError('unavailable', true);
        }
        this.receipt = receipt;
        return receipt;
      })
      .catch((error: unknown) => {
        const classified = classifySalesPlanActionError(error);
        this.failure = classified;
        throw classified;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
}
