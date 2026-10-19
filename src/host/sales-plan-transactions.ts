import {
  correctionAccess,
  correctionAdjustments,
  correctionDecimal,
  salesPlanAccessForRow,
  salesPlanStagesForRoles,
  salesPlanVersionEvidenceStale,
  salesPlanWorkflow,
  validateSalesPlanActionInput,
  prepareSalesPlanResubmit,
  type SalesPlanApprovalRole,
  type SalesPlanWorkflowRow,
  type GeaSalesPlanActionRequest,
  type GeaSalesPlanDetail,
  type GeaSalesPlanPeriod,
  type GeaSalesPlanSku,
} from "@cleverc2200/dsh-agent-workbench/sales-plan";
import { isDeepStrictEqual } from "node:util";
import { GeaResponseError, geaResponseError } from "../shared/gea-error.js";
import { object, text, keys } from "./payload.ts";
import {
  serviceAccountReady,
  submitWithServiceAccount,
  type ServiceAccountConfig,
} from "./service-account.ts";

/** Borrow Business's current identity for one write attempt. */
export type SalesPlanWriteIdentity = {
  token: string;
  tenantId: string;
  id: string;
  name: string;
  username: string;
  roles?: SalesPlanApprovalRole[];
};
type SalesPlanWriteScope = {
  auth: SalesPlanWriteIdentity;
  base: string;
  signal: AbortSignal;
  serviceAccount: ServiceAccountConfig | undefined;
};
type WriteIntent = {
  fingerprint: string;
  body?: string;
  flight?: Promise<unknown>;
  receipt?: unknown;
};
type SalesPlanHost = {
  scope(effect: "submit" | "approve"): SalesPlanWriteScope;
  query(payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  workflow(signal: AbortSignal): Promise<SalesPlanWorkflowRow[]>;
  permissions(signal: AbortSignal): Promise<void>;
  fetch: typeof fetch;
  expire(identity: SalesPlanWriteIdentity): void;
  decode(raw: string): unknown;
  timeoutMs: number;
  periodPageSize: number;
};

const UPSTREAM_ACTION_FIELDS = [
  "action",
  "expectedStatus",
  "remark",
  "adjustments",
  "notification",
] as const;
function upstreamActionBody(request: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of UPSTREAM_ACTION_FIELDS)
    if (request[field] !== undefined) body[field] = request[field];
  if (request.approvalPolicy === "role-visible-v1") {
    for (const field of ["approvalRole", "approvalPolicy", "expectedSnapshot"])
      if (request[field] !== undefined) body[field] = request[field];
  }
  if (request.adjustmentMode === "ABSOLUTE_NET") {
    for (const field of ["adjustmentMode", "approvalRole", "expectedSnapshot"])
      if (request[field] !== undefined) body[field] = request[field];
  }
  return body;
}

/** Owns validated write intent, exact retry body and receipts for one Business login lifetime. */
export class SalesPlanTransactions {
  constructor(private readonly host: SalesPlanHost) {}
  clear(): void {
    this.resubmissions.clear();
    this.correctionRequests.clear();
  }
  /** 在本次登录生命周期内，将一个幂等键绑定到一份已校验请求。 */
  private readonly resubmissions = new Map<string, WriteIntent>();

  /** 重提前重新读取 GEA 当前版本和 SKU；浏览器只允许改变数量，身份、价格与路由由服务端来源决定。 */
  async submit(payload: Record<string, unknown>, caller: AbortSignal): Promise<unknown> {
    const scope = this.host.scope("submit");
    payload = structuredClone(payload);
    keys(payload, ["source", "request", "requestId", "idempotencyKey"]);
    const auth = scope.auth;
    const config = scope.serviceAccount;
    if (!config || !serviceAccountReady(config, auth))
      throw new GeaResponseError(403, {
        message: "当前环境尚未配置当前用户可用的重提服务账号",
      });
    const source = object(payload.source);
    keys(source, ["planId", "versionId"]);
    const planId = text(source.planId),
      versionId = text(source.versionId);
    const request = object(payload.request);
    const requestId = text(payload.requestId),
      idempotencyKey = text(payload.idempotencyKey);
    if (
      !/^[A-Za-z0-9:_-]{1,64}$/.test(requestId) ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(idempotencyKey)
    )
      throw new Error("INVALID_PAYLOAD");
    const fingerprint = JSON.stringify(payload);
    let entry = this.resubmissions.get(idempotencyKey);
    if (entry && entry.fingerprint !== fingerprint)
      throw new GeaResponseError(409, { message: "幂等键已绑定其他重提请求" });
    if (entry?.receipt) return entry.receipt;
    if (entry?.flight) return entry.flight;
    if (!entry) {
      entry = { fingerprint };
      this.resubmissions.set(idempotencyKey, entry);
    }
    const attempt = entry;
    const signal = AbortSignal.any([
      caller,
      scope.signal,
      AbortSignal.timeout(this.host.timeoutMs),
    ]);
    const run = async () => {
      if (!attempt.body) {
        const detail = (await this.host.query(
          { kind: "detail", query: { planId } },
          signal,
        )) as GeaSalesPlanDetail;
        const version = detail.currentVersion;
        if (
          version.id !== versionId ||
          !version.effective ||
          ![6, 7, 8, 9].includes(version.status)
        )
          throw new GeaResponseError(409, {
            message: "计划已变化，请刷新后核对重提版本",
          });
        const periods = object(
          await this.host.query(
            {
              kind: "periods",
              query: {
                periodMonth: request.periodMonth,
                pageSize: this.host.periodPageSize,
              },
            },
            signal,
          ),
        );
        const period = (periods.records as GeaSalesPlanPeriod[]).find(
          (row) => row.periodId === version.periodId && row.planTypeCode === version.planTypeCode,
        );
        if (!period)
          throw new GeaResponseError(409, {
            message: "未找到当前计划对应的周期，请刷新后核对",
          });
        const skus = (await this.host.query(
          { kind: "versionSkus", query: { versionId } },
          signal,
        )) as GeaSalesPlanSku[];
        if (!Array.isArray(request.items) || request.items.length !== skus.length)
          throw new Error("INVALID_PAYLOAD");
        const items = request.items.map(object);
        if (new Set(items.map((row) => row.skuCode)).size !== skus.length)
          throw new Error("INVALID_PAYLOAD");
        const edited = skus.map((sku) => {
          const item = items.find((row) => row.skuCode === sku.skuCode);
          if (!item || typeof item.qty !== "string") throw new Error("INVALID_PAYLOAD");
          if (version.orderType === "Z") {
            if (
              !correctionDecimal(item.qty).eq(correctionDecimal(sku.qty)) ||
              typeof item.adjAddQty !== "string" ||
              typeof item.adjCutQty !== "string"
            )
              throw new Error("INVALID_PAYLOAD");
            return {
              ...sku,
              adjAddQty: item.adjAddQty,
              adjCutQty: item.adjCutQty,
            };
          }
          return { ...sku, qty: item.qty };
        });
        const rows = await this.host.workflow(signal);
        const prepared = prepareSalesPlanResubmit(
          {
            planId,
            versionId,
            detail,
            period,
            skus: edited,
            currentUser: auth,
          },
          rows,
        );
        // 浏览器只能改变数量；身份、价格和路由必须来自 GEA。
        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(prepared.request)), request))
          throw new GeaResponseError(409, {
            message: "提交数据与当前 GEA 来源不一致，请重新核对",
          });
        if (scope.signal.aborted) throw new Error("STALE_LOGIN");
        signal.throwIfAborted();
        attempt.body = JSON.stringify(prepared.request);
      }
      const receipt = await submitWithServiceAccount(
        config,
        scope.base,
        attempt.body,
        requestId,
        idempotencyKey,
        signal,
        this.host.fetch,
      );
      attempt.receipt = receipt;
      return receipt;
    };
    attempt.flight = run().finally(() => {
      attempt.flight = undefined;
    });
    return attempt.flight;
  }

  private readonly correctionRequests = new Map<string, WriteIntent>();

  /** 审批动作按幂等键缓存；即使首次响应丢失，重试也只能重放同一已授权意图。 */
  async action(payload: Record<string, unknown>, caller: AbortSignal): Promise<unknown> {
    const scope = this.host.scope("approve");
    payload = structuredClone(payload);
    const key = text(payload.idempotencyKey),
      fingerprint = JSON.stringify(payload);
    let entry = this.correctionRequests.get(key);
    if (entry && entry.fingerprint !== fingerprint)
      throw new GeaResponseError(409, { message: "幂等键已绑定另一审批请求" });
    if (entry?.receipt) return entry.receipt;
    if (entry?.flight) return entry.flight;
    if (!entry) {
      entry = { fingerprint };
      this.correctionRequests.set(key, entry);
    }
    const intent = entry;
    intent.flight = this.executeAction(payload, caller, scope, intent)
      .then((receipt) => {
        intent.receipt = receipt;
        return receipt;
      })
      .finally(() => {
        intent.flight = undefined;
      });
    return intent.flight;
  }

  /** 执行一次已完成来源、角色和快照校验的 GEA 动作；DMS 写回有意不在此方法内。 */
  private async executeAction(
    payload: Record<string, unknown>,
    caller: AbortSignal,
    scope: SalesPlanWriteScope,
    intent: WriteIntent,
  ): Promise<unknown> {
    keys(payload, ["planId", "versionId", "request", "idempotencyKey", "requestId"]);
    const versionId = text(payload.versionId);
    const request = object(payload.request);
    keys(request, [
      "expectedSnapshot",
      "action",
      "expectedStatus",
      "remark",
      "adjustments",
      "adjustmentMode",
      "approvalRole",
      "approvalPolicy",
    ]);
    if (!["SAVE", "APPROVE", "REJECT"].includes(text(request.action)))
      throw new Error("INVALID_ACTION");
    const auth = scope.auth;
    const signal = AbortSignal.any([caller, scope.signal]);
    if (![1, 2, 3, 4, 6, 7, 8, 9].includes(request.expectedStatus as number))
      throw new GeaResponseError(400, {
        message: "未提交、已完成或无效状态不允许写入",
      });
    if (request.approvalRole == null && request.adjustmentMode == null)
      throw new GeaResponseError(400, { message: "请明确本次审批角色" });
    if (
      request.approvalPolicy != null &&
      (request.approvalPolicy !== "role-visible-v1" || !request.approvalRole)
    )
      throw new Error("INVALID_PAYLOAD");
    if (request.approvalRole != null && !intent.body) {
      if (!["region", "province", "area", "category"].includes(text(request.approvalRole)))
        throw new Error("INVALID_PAYLOAD");
      const planId = text(payload.planId);
      const detail = (await this.host.query(
        { kind: "detail", query: { planId } },
        signal,
      )) as GeaSalesPlanDetail;
      await this.host.permissions(signal);
      const row = {
        planId,
        versionId,
        status: request.expectedStatus as number,
        planTypeCode: detail.currentVersion.planTypeCode,
      };
      const role = request.approvalRole as NonNullable<GeaSalesPlanActionRequest["approvalRole"]>;
      const workflowRows = await this.host.workflow(signal);
      // 版本或状态已经变化属于并发冲突：提示刷新，而不是笼统地报成无权限并禁用本轮操作。
      if (
        salesPlanVersionEvidenceStale(detail, {
          planId,
          versionId,
          status: request.expectedStatus as number,
        })
      )
        throw new GeaResponseError(409, {
          message: "该计划版本或审批状态已变化，请刷新权威队列后重试",
        });
      // 退回版本按本次账号角色重审；退回目标不授予或撤销审批权限。
      const access = salesPlanAccessForRow(
        row,
        detail,
        salesPlanStagesForRoles(auth.roles),
        role,
        workflowRows,
      );
      if (!access?.allowedActions.includes(request.action as GeaSalesPlanActionRequest["action"]))
        throw new GeaResponseError(403, {
          message: "当前角色不具备该版本的操作权限",
        });
      if (request.expectedSnapshot !== access.snapshotHash)
        throw new GeaResponseError(409, {
          message: "审批依据已变化，请刷新后重试",
        });
      if (
        request.approvalPolicy === "role-visible-v1"
          ? !access.roleContractSupported
          : access.roleContractSupported ||
            salesPlanWorkflow(row.planTypeCode, workflowRows).actor(row.status) !== role
      )
        throw new GeaResponseError(409, {
          message: "GEA 尚未支持本次角色审批契约，请升级服务端后重试",
        });
      validateSalesPlanActionInput(
        {
          planId,
          versionId,
          planTypeCode: row.planTypeCode,
          request: request as GeaSalesPlanActionRequest,
        },
        workflowRows,
      );
      if (scope.signal.aborted) throw new Error("STALE_LOGIN");
    }
    if (request.adjustmentMode != null && !intent.body) {
      if (request.adjustmentMode !== "ABSOLUTE_NET") throw new Error("INVALID_PAYLOAD");
      const planId = text(payload.planId);
      const detail = (await this.host.query(
        { kind: "detail", query: { planId } },
        signal,
      )) as GeaSalesPlanDetail;
      const workflowRows = await this.host.workflow(signal);
      await this.host.permissions(signal);
      if (
        salesPlanVersionEvidenceStale(detail, {
          planId,
          versionId,
          status: request.expectedStatus as number,
        })
      )
        throw new GeaResponseError(409, {
          message: "该计划版本或审批状态已变化，请刷新权威队列后重试",
        });
      const access = correctionAccess(
        detail,
        workflowRows,
        request.approvalRole as GeaSalesPlanActionRequest["approvalRole"],
        salesPlanStagesForRoles(auth.roles),
      );
      if (
        detail.correctionContext?.contract !== "absolute-net-v1" ||
        detail.correctionContext.monthlyApproved !== true ||
        detail.correctionContext.approvalOpen !== true ||
        !access ||
        !access.allowedActions.includes(request.action as GeaSalesPlanActionRequest["action"]) ||
        !detail.currentVersion.submitter ||
        detail.currentVersion.submitter === auth.id
      )
        throw new GeaResponseError(403, {
          message: "纠偏契约、月初终审或角色权限未获确认",
        });
      if (
        detail.currentVersion.id !== versionId ||
        access.status !== request.expectedStatus ||
        access.snapshotHash !== request.expectedSnapshot
      )
        throw new GeaResponseError(409, {
          message: "纠偏版本或快照已变化，请刷新",
        });
      request.approvalRole = access.approvalRole;
      const typed = request as GeaSalesPlanActionRequest;
      validateSalesPlanActionInput(
        {
          planId,
          versionId,
          planTypeCode: detail.currentVersion.planTypeCode,
          request: typed,
        },
        workflowRows,
      );
      if (typed.action !== "REJECT") {
        const edits = Object.fromEntries(
          (typed.adjustments ?? []).map((x) => [x.skuCode, x.adjustQty]),
        );
        if (Object.keys(edits).some((code) => !detail.skus.some((sku) => sku.skuCode === code)))
          throw new Error("INVALID_PAYLOAD");
        const expected = correctionAdjustments(
          detail,
          edits,
          workflowRows,
          request.approvalRole as GeaSalesPlanActionRequest["approvalRole"],
        );
        if (!isDeepStrictEqual(expected, typed.adjustments))
          throw new GeaResponseError(400, {
            message: "纠偏必须提交完整的本节点绝对调整决定",
          });
      }
      if (scope.signal.aborted) throw new Error("STALE_LOGIN");
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    intent.body ??= JSON.stringify(upstreamActionBody(request));
    const response = await this.host.fetch(
      scope.base + "/sales-plan/plans/versions/" + encodeURIComponent(versionId) + "/actions",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Access-Token": auth.token,
          "X-Tenant-Id": auth.tenantId,
          "X-Request-Id": text(payload.requestId),
          "Idempotency-Key": text(payload.idempotencyKey),
        },
        body: intent.body,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.host.timeoutMs)]),
      },
    );
    signal.throwIfAborted();
    if (!response.ok) {
      const error = await geaResponseError(response, [auth.token]);
      signal.throwIfAborted();
      if (response.status === 401) this.host.expire(auth);
      throw error;
    }
    const data = object(this.host.decode(await response.text()));
    if (data.success !== true || !data.result) throw new Error("GEA_WRITE_REJECTED");
    if (scope.signal.aborted) throw new Error("STALE_LOGIN");
    signal.throwIfAborted();
    return data.result;
  }
}
