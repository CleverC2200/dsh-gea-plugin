import {
  correctionDecimal,
  salesPlanAccessForRow,
  salesPlanStagesForRoles,
  salesPlanVersionEvidenceStale,
  salesPlanWorkflow,
  validateSalesPlanActionInput,
  verifyReturnedSalesPlan,
  salesPlanReturnDestination,
  prepareSalesPlanResubmit,
  type SalesPlanApprovalRole,
  type SalesPlanWorkflowRow,
  type GeaSalesPlanActionRequest,
  type GeaSalesPlanAddedSku,
  type GeaSalesPlanActionReceipt,
  type GeaSalesPlanDetail,
  type GeaSalesPlanPeriod,
  type GeaSalesPlanSku,
} from "@cleverc2200/dsh-agent-workbench/sales-plan";
import * as salesPlan from "@cleverc2200/dsh-agent-workbench/sales-plan";
import { isDeepStrictEqual } from "node:util";
import { GeaResponseError } from "../shared/gea-error.js";
import { object, text, keys } from "./payload.ts";
import { serializeSalesPlanSubmission } from "./sales-plan-wire.ts";

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
};
type WriteIntent = {
  fingerprint: string;
  body?: string;
  flight?: Promise<unknown>;
  receipt?: unknown;
  actionReceipt?: GeaSalesPlanActionReceipt;
  matchesActionReceipt?: (receipt: GeaSalesPlanActionReceipt) => boolean;
  addedEvidence?: {
    planId: string;
    node: number;
    items: GeaSalesPlanAddedSku[];
  };
  returnEvidence?: {
    detail: GeaSalesPlanDetail;
    request: GeaSalesPlanActionRequest;
    planId: string;
  };
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
  "addedSkus",
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
  return body;
}

export class SalesPlanTransactions {
  constructor(private readonly host: SalesPlanHost) {}
  clear(): void {
    this.resubmissions.clear();
    this.correctionRequests.clear();
  }

  private readonly resubmissions = new Map<string, WriteIntent>();

  private async requireSkuWriteContract(
    scope: SalesPlanWriteScope,
    signal: AbortSignal,
    operation: "action" | "resubmit",
    confirmedQty = false,
  ): Promise<void> {
    try {
      const response = await this.host.fetch(scope.base + "/v3/api-docs", {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Access-Token": scope.auth.token,
          "X-Tenant-Id": scope.auth.tenantId,
        },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.host.timeoutMs)]),
      });
      if (response.status === 401) this.host.expire(scope.auth);
      if (!response.ok) throw new Error("SALES_PLAN_CONTRACT_UNAVAILABLE");
      const document = object(this.host.decode(await response.text()));
      const resolve = (value: unknown, seen = new Set<string>()): Record<string, unknown> => {
        const schema = object(value);
        if (typeof schema.$ref !== "string") return schema;
        if (!schema.$ref.startsWith("#/") || seen.has(schema.$ref))
          throw new Error("SALES_PLAN_CONTRACT_INVALID");
        seen.add(schema.$ref);
        let target: unknown = document;
        for (const segment of schema.$ref.slice(2).split("/"))
          target = object(target)[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
        return resolve(target, seen);
      };
      const property = (value: unknown, name: string): unknown => {
        const schema = resolve(value);
        if (schema.properties && name in object(schema.properties))
          return object(schema.properties)[name];
        for (const part of Array.isArray(schema.allOf) ? schema.allOf : []) {
          const found = property(part, name);
          if (found !== undefined) return found;
        }
        return undefined;
      };
      const path =
        operation === "action"
          ? "/sales-plan/plans/versions/{versionId}/actions"
          : "/sales-plan/plans/resubmit";
      const post = object(object(document.paths)[path]);
      const content = object(resolve(object(post.post).requestBody).content);
      const schema = object(content["application/json"]).schema;
      const rows = resolve(property(schema, operation === "action" ? "addedSkus" : "items"));
      if (rows.type !== "array" || !property(rows.items, "skuCode"))
        throw new Error("SALES_PLAN_CONTRACT_INVALID");
      if (operation === "action") {
        if (!property(rows.items, "qty")) throw new Error("SALES_PLAN_CONTRACT_INVALID");
      } else if (
        !property(schema, "sourceVersionId") ||
        resolve(property(rows.items, "useLatestSkuPrice")).type !== "boolean" ||
        (confirmedQty && !property(rows.items, "confirmedQty"))
      )
        throw new Error("SALES_PLAN_CONTRACT_INVALID");
      signal.throwIfAborted();
    } catch {
      if (scope.signal.aborted) throw new Error("STALE_LOGIN");
      signal.throwIfAborted();
      throw new GeaResponseError(409, {
        message: "管理端尚未支持新增 SKU 或无法确认写入契约，请更新管理端后重试，草稿已保留",
      });
    }
  }

  async submit(payload: Record<string, unknown>, caller: AbortSignal): Promise<unknown> {
    const scope = this.host.scope("submit");
    payload = structuredClone(payload);
    keys(payload, ["source", "request", "requestId", "idempotencyKey"]);
    const auth = scope.auth;
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
    if (typeof salesPlan.salesPlanCanResubmit !== "function")
      throw Object.assign(new Error("请先完成 Workbench 更新后再修改重提销售计划"), {
        code: "GEA_WORKBENCH_UPDATE_REQUIRED",
      });
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
        if (version.status > 6) await this.host.permissions(signal);
        if (!salesPlan.salesPlanCanResubmit(version, salesPlanStagesForRoles(auth.roles), auth.id))
          throw new GeaResponseError(403, {
            message: "当前用户不是该退回版本的修改责任人，请由对应责任人修改后提交",
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
        if (
          !Array.isArray(request.items) ||
          request.items.length < skus.length ||
          request.items.length > 5000
        )
          throw new Error("INVALID_PAYLOAD");
        const items = request.items.map(object);
        const byCode = new Map(items.map((row) => [text(row.skuCode), row]));
        if (byCode.size !== items.length) throw new Error("INVALID_PAYLOAD");
        const known = new Set(skus.map((sku) => sku.skuCode));
        const confirmedQuantities: Record<string, string> = {};
        const edited = skus.map((sku) => {
          const item = byCode.get(sku.skuCode);
          if (!item || item.useLatestSkuPrice !== undefined || typeof item.qty !== "string")
            throw new Error("INVALID_PAYLOAD");
          if (version.orderType === "Z") {
            if (
              !correctionDecimal(item.qty).eq(correctionDecimal(sku.qty)) ||
              typeof item.adjAddQty !== "string" ||
              typeof item.adjCutQty !== "string"
            )
              throw new Error("INVALID_PAYLOAD");
            if (item.confirmedQty !== undefined)
              confirmedQuantities[sku.skuCode] = text(item.confirmedQty);
            return {
              ...sku,
              adjAddQty: item.adjAddQty,
              adjCutQty: item.adjCutQty,
            };
          }
          return { ...sku, qty: item.qty };
        });
        const addedSkus = items.flatMap((item) => {
          const skuCode = text(item.skuCode);
          if (known.has(skuCode)) return [];
          if (item.useLatestSkuPrice !== true) throw new Error("INVALID_PAYLOAD");
          const qty =
            version.orderType === "Z"
              ? text(version.status === 6 ? item.adjAddQty : item.confirmedQty)
              : text(item.qty);
          return [
            {
              skuCode,
              qty,
              price: text(item.price),
              productCategName: text(item.productCategName),
            },
          ];
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
            addedSkus,
            confirmedQuantities,
          },
          rows,
        );

        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(prepared.request)), request))
          throw new GeaResponseError(409, {
            message: "提交数据与当前 GEA 来源不一致，请重新核对",
          });
        if (scope.signal.aborted) throw new Error("STALE_LOGIN");
        signal.throwIfAborted();
        if (addedSkus.length || Object.keys(confirmedQuantities).length)
          await this.requireSkuWriteContract(
            scope,
            signal,
            "resubmit",
            Object.keys(confirmedQuantities).length > 0 ||
              (addedSkus.length > 0 && version.orderType === "Z" && version.status > 6),
          );
        const submission = {
          ...prepared.request,
          ...(addedSkus.length || Object.keys(confirmedQuantities).length
            ? { sourceVersionId: versionId }
            : {}),
          submitterCode: text(version.submitter),
        };
        delete submission.submitterName;
        attempt.body = serializeSalesPlanSubmission(submission);
      }
      const receipt = await this.executeResubmission(
        requestId,
        idempotencyKey,
        attempt.body,
        scope,
        signal,
      );
      attempt.receipt = receipt;
      return receipt;
    };
    attempt.flight = run().finally(() => {
      attempt.flight = undefined;
    });
    return attempt.flight;
  }

  private async executeResubmission(
    requestId: string,
    idempotencyKey: string,
    body: string,
    scope: SalesPlanWriteScope,
    signal: AbortSignal,
  ): Promise<unknown> {
    const uncertain = () => {
      const error = new GeaResponseError(502, {
        message: "重提结果暂时未知，请使用原操作重试或回读状态",
      });
      error.details.retrySameIntent = true;
      return error;
    };
    const assertCurrent = () => {
      if (scope.signal.aborted) throw new Error("STALE_LOGIN");
      if (signal.aborted) throw uncertain();
    };
    let response: Response;
    try {
      response = await this.host.fetch(scope.base + "/sales-plan/plans/resubmit", {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Access-Token": scope.auth.token,
          "X-Tenant-Id": scope.auth.tenantId,
          "X-Request-Id": requestId,
          "Idempotency-Key": idempotencyKey,
        },
        body,
      });
    } catch {
      assertCurrent();
      throw uncertain();
    }
    assertCurrent();
    if (!response.ok) {
      const data = await response.text().then(
        (raw) => {
          try {
            return object(this.host.decode(raw));
          } catch {
            return undefined;
          }
        },
        () => undefined,
      );
      const error = new GeaResponseError(response.status, data, [scope.auth.token]);
      assertCurrent();
      if (response.status === 401) this.host.expire(scope.auth);
      if (data?.success === false) error.details.retrySameIntent = false;
      else if (
        (response.status >= 500 || response.status === 408) &&
        error.details.retryable !== false
      )
        error.details.retrySameIntent = true;
      throw error;
    }
    let data: Record<string, unknown>;
    try {
      data = object(this.host.decode(await response.text()));
    } catch {
      assertCurrent();
      throw uncertain();
    }
    assertCurrent();
    if (data.success !== true || !data.result) {
      const status =
        data.code === 510
          ? 403
          : typeof data.code === "number" && data.code >= 400 && data.code <= 599
            ? data.code
            : 502;
      const error = new GeaResponseError(status, data, [scope.auth.token]);
      if (status === 401) this.host.expire(scope.auth);
      if (data.success === false) error.details.retrySameIntent = false;
      else if (status >= 500 && error.details.retryable !== false)
        error.details.retrySameIntent = true;
      throw error;
    }
    let receipt: Record<string, unknown>;
    try {
      receipt = object(data.result);
    } catch {
      throw uncertain();
    }
    if (
      typeof receipt.planId !== "string" ||
      !receipt.planId.trim() ||
      typeof receipt.versionId !== "string" ||
      !receipt.versionId.trim() ||
      typeof receipt.seq !== "number" ||
      !Number.isSafeInteger(receipt.seq) ||
      receipt.seq <= 0 ||
      typeof receipt.status !== "number" ||
      !Number.isInteger(receipt.status) ||
      receipt.status < 0 ||
      receipt.status > 10 ||
      typeof receipt.replayed !== "boolean" ||
      receipt.requestId !== requestId ||
      typeof receipt.traceId !== "string" ||
      !receipt.traceId.trim() ||
      (receipt.auditId != null && typeof receipt.auditId !== "string")
    )
      throw uncertain();
    return {
      planId: receipt.planId,
      versionId: receipt.versionId,
      seq: receipt.seq,
      status: receipt.status,
      replayed: receipt.replayed,
      requestId: receipt.requestId,
      traceId: receipt.traceId,
      auditId: receipt.auditId ?? null,
    };
  }

  private readonly correctionRequests = new Map<string, WriteIntent>();

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
      "addedSkus",
      "expectedReturnTargetStage",
      "adjustmentMode",
      "approvalRole",
      "approvalPolicy",
    ]);
    const action = request.action;
    if (action !== "SAVE" && action !== "APPROVE" && action !== "REJECT")
      throw new Error("INVALID_ACTION");
    if (
      request.action === "APPROVE" &&
      Number(request.expectedStatus) >= 6 &&
      Number(request.expectedStatus) <= 9
    )
      throw new GeaResponseError(409, {
        message: "退回版本不能直接审批通过，请修改后重新提交新版本",
      });
    const auth = scope.auth;
    const signal = AbortSignal.any([caller, scope.signal]);
    if (![1, 2, 3, 4, 6, 7, 8, 9].includes(request.expectedStatus as number))
      throw new GeaResponseError(400, {
        message: "未提交、已完成或无效状态不允许写入",
      });

    if (
      request.approvalPolicy != null &&
      (request.approvalPolicy !== "role-visible-v1" || !request.approvalRole)
    )
      throw new Error("INVALID_PAYLOAD");
    if (
      request.approvalRole != null &&
      !["region", "province", "area", "category"].includes(text(request.approvalRole))
    )
      throw new Error("INVALID_PAYLOAD");
    if (!intent.body) {
      const planId = text(payload.planId);
      const detail = (await this.host.query(
        { kind: "detail", query: { planId } },
        signal,
      )) as GeaSalesPlanDetail;
      if (detail.currentVersion.orderType === "Z" && request.action === "SAVE")
        throw new GeaResponseError(400, { message: "纠偏调整请使用本地暂存" });
      if (request.approvalRole == null)
        throw new GeaResponseError(400, { message: "请明确本次审批角色" });
      if (request.adjustmentMode != null) throw new Error("INVALID_PAYLOAD");
      await this.host.permissions(signal);
      const workflowRows = await this.host.workflow(signal);
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
      const row = {
        planId,
        versionId,
        status: request.expectedStatus as number,
        planTypeCode: detail.currentVersion.planTypeCode,
      };
      const role = request.approvalRole as NonNullable<GeaSalesPlanActionRequest["approvalRole"]>;
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
      if (request.expectedReturnTargetStage !== undefined) {
        if (request.action !== "REJECT") throw new Error("INVALID_PAYLOAD");
        const context = salesPlanReturnDestination(detail, role);
        if (
          context.versionId !== versionId ||
          context.status !== request.expectedStatus ||
          context.currentStage !==
            ["customer", "region", "province", "area", "category"].indexOf(role) + 1 ||
          context.targetStage !== request.expectedReturnTargetStage
        )
          throw new GeaResponseError(409, { message: "退回节点已变化，请刷新后重试" });
        intent.returnEvidence = { detail, request: request as GeaSalesPlanActionRequest, planId };
      }
      validateSalesPlanActionInput(
        {
          planId,
          versionId,
          planTypeCode: row.planTypeCode,
          request: request as GeaSalesPlanActionRequest,
        },
        workflowRows,
      );
      const addedSkus = request.addedSkus;
      if (addedSkus !== undefined && (!Array.isArray(addedSkus) || addedSkus.length > 0)) {
        if (
          typeof salesPlan.salesPlanAddedSkusValid !== "function" ||
          typeof salesPlan.verifySalesPlanAddedSkus !== "function"
        )
          throw new GeaResponseError(409, { message: "请更新销售计划工作台后再添加 SKU" });
        if (!salesPlan.salesPlanAddedSkusValid(addedSkus)) throw new Error("INVALID_PAYLOAD");
        if (
          detail.skus.length + addedSkus.length > 5000 ||
          addedSkus.some((item) => detail.skus.some((sku) => sku.skuCode === item.skuCode))
        )
          throw new GeaResponseError(409, {
            message: "新增 SKU 与当前明细重复或超出明细上限",
          });
        await this.requireSkuWriteContract(scope, signal, "action");
        intent.addedEvidence = {
          planId,
          items: addedSkus,
          node:
            action === "REJECT"
              ? salesPlanReturnDestination(detail, role).targetStage
              : ["customer", "region", "province", "area", "category"].indexOf(role) + 1,
        };
      }
      const flow = salesPlanWorkflow(row.planTypeCode, workflowRows);
      const approvalRoles: NonNullable<GeaSalesPlanActionRequest["approvalRole"]>[] = [
        "region",
        "province",
        "area",
        "category",
      ];
      intent.matchesActionReceipt = (receipt) => {
        if (access.roleContractSupported && receipt.approvalRole !== role) return false;
        if (request.expectedReturnTargetStage !== undefined)
          return receipt.toStatus === Number(request.expectedReturnTargetStage) + 5;
        if (action === "SAVE") return receipt.toStatus === row.status;
        if (!access.roleContractSupported)
          return (
            receipt.toStatus === flow.transition(row.status, action) ||
            (action === "APPROVE" &&
              receipt.toStatus === 10 &&
              flow.transition(row.status, action) === 5) ||
            (action === "APPROVE" && !access.snapshotHash && receipt.toStatus === row.status)
          );
        if (action === "REJECT") {
          const pending = flow.pending(role);
          return pending !== undefined && receipt.toStatus === flow.transition(pending, action);
        }
        if (receipt.toStatus === 5 || receipt.toStatus === 10) {
          const approvedRoles = receipt.approvedRoles;
          return (
            Array.isArray(approvedRoles) &&
            approvalRoles.every(
              (stage) => flow.pending(stage) === undefined || approvedRoles.includes(stage),
            )
          );
        }
        return (
          receipt.toStatus === row.status ||
          ([1, 2, 3, 4].includes(receipt.toStatus) && flow.actor(receipt.toStatus) !== undefined)
        );
      };
      if (scope.signal.aborted) throw new Error("STALE_LOGIN");
      const body = upstreamActionBody(request);
      if (request.action !== "SAVE") {
        const planKind =
          detail.currentVersion.orderType === "Z"
            ? "纠偏"
            : detail.currentVersion.orderType === "M"
              ? "月初"
              : "";
        const roleName = {
          region: "区域审批",
          province: "省区审批",
          area: "大区审批",
          category: "品类审批",
        }[role];
        body.notification =
          request.action === "APPROVE"
            ? {
                title: "需求预测审批待处理",
                content: `一份${planKind}需求预测已通过${roleName}，请查看并按最新内容处理。`,
              }
            : {
                title: "需求预测退回待处理",
                content: `一份${planKind}需求预测已退回，请查看退回原因并修改后重新提报。`,
              };
      }
      intent.body = JSON.stringify(body);
    }
    signal.throwIfAborted();
    const uncertain = () => {
      const error = new GeaResponseError(502, {
        message: "审批结果暂时未知，请使用原操作重试或回读状态",
      });
      error.details.retrySameIntent = true;
      return error;
    };
    if (!intent.actionReceipt) {
      const transportSignal = AbortSignal.any([signal, AbortSignal.timeout(this.host.timeoutMs)]);
      const assertCurrent = () => {
        if (scope.signal.aborted) throw new Error("STALE_LOGIN");
        if (transportSignal.aborted) throw uncertain();
      };
      let response: Response;
      try {
        response = await this.host.fetch(
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
            signal: transportSignal,
          },
        );
      } catch {
        assertCurrent();
        throw uncertain();
      }
      assertCurrent();
      let data: Record<string, unknown>;
      try {
        data = object(this.host.decode(await response.text()));
      } catch {
        assertCurrent();
        if (!response.ok && response.status < 500 && response.status !== 408) {
          if (response.status === 401) this.host.expire(auth);
          throw new GeaResponseError(response.status, undefined);
        }
        throw uncertain();
      }
      assertCurrent();
      if (!response.ok || data.success === false) {
        const status = !response.ok
          ? response.status
          : data.code === 510
            ? 403
            : typeof data.code === "number" && data.code >= 400 && data.code <= 599
              ? data.code
              : 502;
        const error = new GeaResponseError(status, data, [auth.token]);
        if (status === 401) this.host.expire(auth);
        if (
          data.errorCode === "SALES_PLAN_DMS_WRITEBACK_FAILED" &&
          typeof data.message === "string" &&
          data.message.includes("终审明细已保存")
        )
          error.details.retrySameIntent = true;
        else if (data.success === false) error.details.retrySameIntent = false;
        else if ((status >= 500 || status === 408) && error.details.retryable !== false)
          error.details.retrySameIntent = true;
        throw error;
      }
      if (data.success !== true) throw uncertain();
      let receipt: Record<string, unknown>;
      try {
        receipt = object(data.result);
      } catch {
        throw uncertain();
      }
      if (
        receipt.planId !== payload.planId ||
        receipt.versionId !== versionId ||
        receipt.requestId !== payload.requestId ||
        typeof receipt.fromStatus !== "number" ||
        receipt.fromStatus !== request.expectedStatus ||
        typeof receipt.toStatus !== "number" ||
        !Number.isInteger(receipt.toStatus) ||
        receipt.toStatus < 0 ||
        receipt.toStatus > 10 ||
        typeof receipt.replayed !== "boolean" ||
        typeof receipt.traceId !== "string" ||
        !receipt.traceId.trim() ||
        (receipt.auditId != null && typeof receipt.auditId !== "string")
      )
        throw uncertain();
      const received = {
        ...receipt,
        planId: text(receipt.planId),
        versionId: text(receipt.versionId),
        requestId: text(receipt.requestId),
        fromStatus: receipt.fromStatus,
        toStatus: receipt.toStatus,
        replayed: receipt.replayed,
        traceId: receipt.traceId,
        auditId: receipt.auditId ?? null,
      };
      if (!intent.matchesActionReceipt?.(received)) throw uncertain();
      intent.actionReceipt = received;
    }
    const receipt = intent.actionReceipt;
    const returned = intent.returnEvidence;
    const added = intent.addedEvidence;
    const readbackPlanId = returned?.planId ?? added?.planId;
    if (readbackPlanId) {
      try {
        const after = (await this.host.query(
          { kind: "detail", query: { planId: readbackPlanId } },
          signal,
        )) as GeaSalesPlanDetail;
        if (
          (returned &&
            !verifyReturnedSalesPlan(returned.detail, after, returned.request, receipt)) ||
          (added &&
            (after.currentVersion.id !== receipt.versionId ||
              !salesPlan.verifySalesPlanAddedSkus(after, added.items, added.node)))
        )
          throw new Error("SALES_PLAN_READBACK_MISMATCH");
      } catch {
        if (scope.signal.aborted) throw new Error("STALE_LOGIN");
        const error = new GeaResponseError(502, {
          message: returned
            ? "退回结果尚未核对，请刷新或使用原操作重试"
            : "新增明细尚未核对，请刷新或使用原操作重试",
        });
        error.details.retrySameIntent = true;
        throw error;
      }
    }
    return receipt;
  }
}
