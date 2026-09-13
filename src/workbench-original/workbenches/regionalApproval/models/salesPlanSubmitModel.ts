/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import { salesPlanWorkflow, type SalesPlanWorkflowRow } from '../../../salesPlanWorkflow.ts';
import { isBackendHttpError } from '../../../http-error.ts';
import type {
  GeaSalesPlanDetail,
  GeaSalesPlanPeriod,
  GeaSalesPlanSku,
  GeaSalesPlanSubmitParams,
  GeaSalesPlanSubmitReceipt,
  GeaSalesPlanSubmitRequest,
  GeaSalesPlanVersion,
} from '../../../bridge.ts';

export type SalesPlanCurrentUser = { id: string; username: string };

export type SalesPlanSubmitClient = {
  detail: { invoke: (query: { planId: string; signal?: AbortSignal }) => Promise<GeaSalesPlanDetail> };
  versionSkus: {
    invoke: (query: { versionId: string; signal?: AbortSignal }) => Promise<GeaSalesPlanSku[]>;
  };
  currentUser: { invoke: () => Promise<SalesPlanCurrentUser> };
  submit: { invoke: (params: GeaSalesPlanSubmitParams) => Promise<GeaSalesPlanSubmitReceipt> };
};

export type SalesPlanResubmitSource = {
  period: GeaSalesPlanPeriod;
  planId: string;
  versionId: string;
  detail: GeaSalesPlanDetail;
  skus: GeaSalesPlanSku[];
  currentUser: SalesPlanCurrentUser;
  channelCode?: string;
};

export type SalesPlanSubmitInput = {
  request: GeaSalesPlanSubmitRequest;
  sourceSummary: {
    skuCount: number;
    submittedQty: string;
    submittedAmount: string;
  };
  expected: {
    planId: string;
    previousVersionId: string;
    nextSeq: number;
    nextStatus: number;
  };
};

export type SalesPlanSubmitErrorKind =
  | 'validation'
  | 'sourceMismatch'
  | 'authentication'
  | 'permission'
  | 'conflict'
  | 'rateLimited'
  | 'serviceUnavailable'
  | 'retryExhausted'
  | 'unavailable'
  | 'failed';

export class SalesPlanSubmitError extends Error {
  constructor(
    readonly kind: SalesPlanSubmitErrorKind,
    readonly retrySameIntent: boolean,
    readonly retryAfterMs?: number,
    options?: ErrorOptions
  ) {
    super(kind, options);
    this.name = 'SalesPlanSubmitError';
  }
}

const POSITIVE_LONG_PATTERN = /^[1-9]\d*$/;
const MAX_SIGNED_LONG = BigInt('9223372036854775807');
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const CHANNEL_PATTERN = /^[a-z0-9]{1,12}$/;
const BUSINESS_PLAN_ID_PATTERN = /^p-([a-z0-9]{1,12})-(\d{4}-(?:0[1-9]|1[0-2]))-\d{5}$/;

const fail = (kind: SalesPlanSubmitErrorKind = 'validation'): never => {
  throw new SalesPlanSubmitError(kind, false);
};

const validateText = (value: string, max: number): string => {
  const normalized = value.trim();
  if (!normalized || Array.from(value).length > max) return fail();
  return normalized;
};

const validateOptionalText = (value: string | null | undefined, max: number): string | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  if (Array.from(value).length > max) return fail();
  return value;
};

const validatePositiveLong = (value: string): string => {
  if (!POSITIVE_LONG_PATTERN.test(value) || BigInt(value) > MAX_SIGNED_LONG) return fail();
  return value;
};

const parseUnsignedDecimal = (
  value: string,
  maxInteger: number,
  maxFraction: number,
  targetScale: number
): { scaled: bigint; canonical: string } => {
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return fail();
  const integerDigits = match[1].replace(/^0+/, '').length || 1;
  const fraction = match[2] ?? '';
  if (integerDigits > maxInteger || fraction.length > maxFraction) return fail();
  const integer = BigInt(match[1]);
  const paddedFraction = fraction.padEnd(targetScale, '0');
  const scaled = integer * BigInt(`1${'0'.repeat(targetScale)}`) + BigInt(paddedFraction || '0');
  return {
    scaled,
    canonical: `${integer.toString()}${targetScale > 0 ? `.${paddedFraction}` : ''}`,
  };
};

const fixedDecimal = (scaled: bigint, scale: number): string => {
  const raw = scaled.toString().padStart(scale + 1, '0');
  return scale === 0 ? raw : `${raw.slice(0, -scale)}.${raw.slice(-scale)}`;
};

export const salesPlanChannelCodeForPlanId = (planId: string, periodMonth: string): string | undefined => {
  const match = planId.trim().match(BUSINESS_PLAN_ID_PATTERN);
  return match?.[2] === periodMonth ? match[1] : undefined;
};

const validateSku = (sku: GeaSalesPlanSku) => {
  const qty = parseUnsignedDecimal(sku.qty, 15, 3, 3);
  const price = parseUnsignedDecimal(sku.price, 14, 4, 4);
  return {
    item: {
      skuCode: validatePositiveLong(sku.skuCode),
      productCategName: validateText(sku.productCategName, 128),
      baseQty: parseUnsignedDecimal(sku.baseQty, 15, 3, 3).canonical,
      qty: qty.canonical,
      price: price.canonical,
    },
    qty: qty.scaled,
    roundedAmount: (qty.scaled * price.scaled + BigInt(50_000)) / BigInt(100_000),
  };
};

export const prepareSalesPlanResubmit = (source: SalesPlanResubmitSource, rows?: readonly SalesPlanWorkflowRow[]): SalesPlanSubmitInput => {
  const version: GeaSalesPlanVersion = source.detail.currentVersion;
  const nextStatus = salesPlanWorkflow(version.planTypeCode, rows).resubmit(version.status);
  if (
    !nextStatus ||
    !version.effective ||
    version.planId !== source.planId ||
    version.id !== source.versionId ||
    version.periodId !== source.period.periodId ||
    version.planTypeCode !== source.period.planTypeCode ||
    version.status < 6 ||
    version.status > 9 ||
    (salesPlanWorkflow(version.planTypeCode, rows).actor(version.status) === 'customer' && source.period.status.toUpperCase() !== 'OPEN') ||
    !['M', 'Z'].includes(version.orderType ?? '') ||
    source.skus.length < 1 ||
    source.skus.length > 5000
  ) {
    return fail('sourceMismatch');
  }

  if (!MONTH_PATTERN.test(source.period.periodMonth)) return fail();
  const derivedChannelCode = salesPlanChannelCodeForPlanId(version.planId, source.period.periodMonth);
  const suppliedChannelCode = source.channelCode?.trim();
  if (
    !derivedChannelCode ||
    (suppliedChannelCode !== undefined &&
      (!CHANNEL_PATTERN.test(suppliedChannelCode) || suppliedChannelCode !== derivedChannelCode))
  ) {
    return fail('sourceMismatch');
  }
  const channelCode = suppliedChannelCode ?? derivedChannelCode;
  validatePositiveLong(source.period.periodId);
  validatePositiveLong(version.dealerCode);
  const planTypeCode = validateText(source.period.planTypeCode, 32);
  const submitterCode = validateText(source.currentUser.id, 64);
  const submitterName = validateOptionalText(source.currentUser.username, 128);

  const skuCodes = new Set<string>();
  let totalQty = BigInt(0);
  let totalAmount = BigInt(0);
  const items = source.skus.map((sku) => {
    if (sku.versionId !== version.id || skuCodes.has(sku.skuCode)) return fail('sourceMismatch');
    skuCodes.add(sku.skuCode);
    const validated = validateSku(sku);
    totalQty += validated.qty;
    totalAmount += validated.roundedAmount;
    return validated.item;
  });

  const versionQty = parseUnsignedDecimal(version.targetQty, 15, 3, 3).canonical;
  const versionAmount = parseUnsignedDecimal(version.targetAmount, 16, 2, 2).canonical;

  return {
    request: {
      orderType: version.orderType as 'M' | 'Z',
      status: nextStatus,
      periodId: source.period.periodId,
      periodMonth: source.period.periodMonth,
      planTypeCode,
      channelCode,
      dealerCode: version.dealerCode,
      orgCode: validateOptionalText(version.orgCode, 64),
      provinceCode: validateOptionalText(version.provinceCode, 64),
      areaCode: validateOptionalText(version.areaCode, 64),
      baseName: validateOptionalText(version.baseName, 64),
      targetQty: versionQty,
      targetAmount: versionAmount,
      submitterCode,
      submitterName,
      items,
    },
    sourceSummary: {
      skuCount: items.length,
      submittedQty: fixedDecimal(totalQty, 3),
      submittedAmount: fixedDecimal(totalAmount, 2),
    },
    expected: {
      planId: version.planId,
      previousVersionId: version.id,
      nextSeq: version.seq + 1,
      nextStatus,
    },
  };
};

const retryAfterMsFromDetails = (details: unknown): number | undefined => {
  if (!details || typeof details !== 'object') return undefined;
  const value = (details as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
};

export const classifySalesPlanSubmitError = (error: unknown): SalesPlanSubmitError => {
  if (error instanceof SalesPlanSubmitError) return error;
  if (isBackendHttpError(error)) {
    if (error.status === 400) return new SalesPlanSubmitError('validation', false, undefined, { cause: error });
    if (error.status === 401) return new SalesPlanSubmitError('authentication', false, undefined, { cause: error });
    if (error.status === 403) return new SalesPlanSubmitError('permission', false, undefined, { cause: error });
    if (error.status === 409) return new SalesPlanSubmitError('conflict', false, undefined, { cause: error });
    if (error.status === 429) {
      return new SalesPlanSubmitError('rateLimited', false, retryAfterMsFromDetails(error.details), { cause: error });
    }
    if (error.status >= 500 && error.details && typeof error.details === 'object' && 'retrySameIntent' in error.details && error.details.retrySameIntent === true) return new SalesPlanSubmitError('unavailable', true, undefined, { cause: error });
    if (error.status >= 500) return new SalesPlanSubmitError('serviceUnavailable', false, undefined, { cause: error });
    return new SalesPlanSubmitError('failed', false, undefined, { cause: error });
  }
  if (error instanceof TypeError) return new SalesPlanSubmitError('unavailable', true, undefined, { cause: error });
  return new SalesPlanSubmitError('failed', false, undefined, { cause: error });
};

export const salesPlanSubmitReceiptMatches = (
  input: SalesPlanSubmitInput,
  requestId: string,
  receipt: GeaSalesPlanSubmitReceipt
): boolean =>
  receipt.planId === input.expected.planId &&
  receipt.versionId !== input.expected.previousVersionId &&
  receipt.versionId.trim().length > 0 &&
  receipt.seq === input.expected.nextSeq &&
  receipt.status === input.expected.nextStatus &&
  receipt.requestId === requestId &&
  receipt.traceId.trim().length > 0 &&
  receipt.auditId.trim().length > 0;

export class SalesPlanSubmitAttempt {
  private static readonly MAX_CALLS = 3;
  private command?: GeaSalesPlanSubmitParams;
  private input?: SalesPlanSubmitInput;
  private inFlight?: Promise<GeaSalesPlanSubmitReceipt>;
  private receipt?: GeaSalesPlanSubmitReceipt;
  private failure?: SalesPlanSubmitError;
  private callCount = 0;

  constructor(
    private readonly client: Pick<SalesPlanSubmitClient, 'submit'>,
    private readonly createId: () => string = () => crypto.randomUUID()
  ) {}

  submit(input: SalesPlanSubmitInput): Promise<GeaSalesPlanSubmitReceipt> {
    if (this.receipt) return Promise.resolve(this.receipt);
    if (this.inFlight) return this.inFlight;
    if (this.command) return Promise.reject(this.failure ?? new SalesPlanSubmitError('failed', false));

    this.input = input;
    this.command = {
      source: { planId: input.expected.planId, versionId: input.expected.previousVersionId },
      request: input.request,
      idempotencyKey: `gea-sales-plan-submit:${this.createId()}`,
      requestId: this.createId(),
    };
    return this.invoke();
  }

  retry(): Promise<GeaSalesPlanSubmitReceipt> {
    if (this.receipt) return Promise.resolve(this.receipt);
    if (this.inFlight) return this.inFlight;
    if (!this.command || !this.failure?.retrySameIntent) {
      return Promise.reject(this.failure ?? new SalesPlanSubmitError('failed', false));
    }
    if (this.callCount >= SalesPlanSubmitAttempt.MAX_CALLS) {
      return Promise.reject(this.exhausted());
    }
    return this.invoke();
  }

  private invoke(): Promise<GeaSalesPlanSubmitReceipt> {
    const command = this.command;
    const input = this.input;
    if (!command || !input) return Promise.reject(new SalesPlanSubmitError('failed', false));
    if (this.callCount >= SalesPlanSubmitAttempt.MAX_CALLS) return Promise.reject(this.exhausted());
    this.callCount += 1;
    this.failure = undefined;
    this.inFlight = this.client.submit
      .invoke(command)
      .then((receipt) => {
        if (!salesPlanSubmitReceiptMatches(input, command.requestId, receipt)) {
          throw new SalesPlanSubmitError('unavailable', true);
        }
        this.receipt = receipt;
        return receipt;
      })
      .catch((error: unknown) => {
        let classified = classifySalesPlanSubmitError(error);
        if (classified.retrySameIntent && this.callCount >= SalesPlanSubmitAttempt.MAX_CALLS) {
          classified = this.exhausted(classified);
        }
        this.failure = classified;
        throw classified;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private exhausted(cause: unknown = this.failure): SalesPlanSubmitError {
    const error = new SalesPlanSubmitError('retryExhausted', false, undefined, { cause });
    this.failure = error;
    return error;
  }
}

/** Confirm the new effective version and its resubmission log before refreshing the queue. */
export const salesPlanResubmitReadbackMatches = (
  previousVersionId: string,
  receipt: GeaSalesPlanSubmitReceipt,
  detail: GeaSalesPlanDetail
): boolean => {
  const current = detail.currentVersion;
  const old = detail.versions.find(row => row.id === previousVersionId);
  return current.planId === receipt.planId && current.id === receipt.versionId &&
    current.seq === receipt.seq && current.status === receipt.status && current.effective === true &&
    old?.effective === false && old.planId === receipt.planId &&
    detail.logs.some(log => log.requestId === receipt.requestId && log.planId === receipt.planId &&
      log.versionId === receipt.versionId && log.actionCode === 'RESUBMIT');
};
