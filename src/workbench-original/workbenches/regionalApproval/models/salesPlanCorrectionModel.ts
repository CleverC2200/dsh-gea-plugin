import { Decimal } from "decimal.js";
import {
  salesPlanWorkflow,
  type SalesPlanWorkflowRow,
  type SalesPlanRole,
} from "../../../salesPlanWorkflow.ts";
import type { GeaSalesPlanSku } from "../../../contracts.ts";

const Exact = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
export type CorrectionNode = Exclude<SalesPlanRole, "customer">;
export type CorrectionFields = Partial<
  Record<
    | `${CorrectionNode}AdjAddQty`
    | `${CorrectionNode}AdjCutQty`
    | "adjAddQty"
    | "adjCutQty",
    string | null
  >
>;
export type CorrectionSku = Pick<GeaSalesPlanSku, "qty" | "price"> &
  CorrectionFields;
export function correctionDecimal(value: unknown): Decimal {
  if (typeof value !== "string" || !/^[+-]?\d+(?:\.\d+)?$/.test(value))
    throw new Error("纠偏数据缺失或格式错误");
  return new Exact(value);
}

/** NULL means inherit; an explicit pair of zeroes is a recorded decision. */
export function correctionDecision(
  sku: CorrectionSku,
  status: number,
  typeCode: string,
  includeCurrent = true,
  workflowRows?: readonly SalesPlanWorkflowRow[],
): string {
  const roles = salesPlanWorkflow(typeCode, workflowRows).confirmationRoles(
    status,
  );
  for (const role of includeCurrent ? roles : roles.slice(1)) {
    const add = role === "customer" ? sku.adjAddQty : sku[`${role}AdjAddQty`];
    const cut = role === "customer" ? sku.adjCutQty : sku[`${role}AdjCutQty`];
    if (add == null && cut == null) continue;
    if (add == null || cut == null) throw new Error("纠偏追加与追减字段不完整");
    const a = correctionDecimal(add),
      c = correctionDecimal(cut);
    if (a.isNegative() || c.isNegative() || (!a.isZero() && !c.isZero()))
      throw new Error("纠偏调整必须是绝对净量");
    return a.minus(c).toFixed();
  }
  throw new Error("纠偏继承数据缺失");
}
export function correctionLine(
  sku: Pick<GeaSalesPlanSku, "qty" | "price">,
  input: string,
) {
  if (!/^[+-]?\d{1,15}(?:\.\d{1,3})?$/.test(input))
    throw new Error("调整量最多三位小数");
  const base = correctionDecimal(sku.qty),
    price = correctionDecimal(sku.price),
    delta = correctionDecimal(input);
  const qty = base.plus(delta);
  if (base.isNegative() || price.isNegative() || qty.isNegative())
    throw new Error("纠偏后计划数量不可为负");
  if (qty.gte("1000000000000000")) throw new Error("纠偏后计划数量超出范围");
  return {
    baseQty: base.toFixed(),
    qty: qty.toFixed(),
    amount: qty.times(price).toFixed(2),
    delta: delta.toFixed(),
    deltaAmount: delta.times(price).toFixed(2),
    addQty: delta.isNegative() ? "0" : delta.toFixed(),
    cutQty: delta.isNegative() ? delta.negated().toFixed() : "0",
    participates: !base.isZero() || !delta.isZero(),
  };
}
export function correctionMetrics(row: {
  targetAmount?: string;
  mPlanAmount?: string;
  mPlanQty?: string;
  shipAmount?: string;
  shipQty?: string;
  corrPlanAmount?: string;
}) {
  const ratio = (n?: string, d?: string) => {
    try {
      const denominator = correctionDecimal(d);
      return denominator.gt(0)
        ? correctionDecimal(n).div(denominator).times(100).toFixed(2)
        : undefined;
    } catch {
      return undefined;
    }
  };
  let netAmount: string | undefined;
  try {
    netAmount = correctionDecimal(row.corrPlanAmount)
      .minus(correctionDecimal(row.mPlanAmount))
      .toFixed(2);
  } catch {
    /* Missing is not zero. */
  }
  return {
    amountProgress: ratio(row.shipAmount, row.mPlanAmount),
    qtyProgress: ratio(row.shipQty, row.mPlanQty),
    correctionProgress: ratio(row.corrPlanAmount, row.targetAmount),
    netAmount,
  };
}

import type {
  GeaSalesPlanDetail,
  GeaSalesPlanActionRequest,
  GeaSalesPlanActionReceipt,
} from "../../../contracts.ts";

export function correctionAccess(
  detail: GeaSalesPlanDetail,
  workflowRows?: readonly SalesPlanWorkflowRow[],
) {
  const {
    currentVersion: v,
    actionContext: c,
    correctionContext: policy,
  } = detail;
  const role = salesPlanWorkflow(v.planTypeCode, workflowRows).actor(v.status);
  return v.orderType === "Z" &&
    v.effective === true &&
    policy?.contract === "absolute-net-v1" &&
    policy.monthlyApproved === true &&
    policy.approvalOpen === true &&
    role &&
    role !== "customer" &&
    c?.versionId === v.id &&
    c.status === v.status &&
    c.nodeOrder ===
      ["customer", "region", "province", "area", "category"].indexOf(role) +
        1 &&
    /^[a-f0-9]{64}$/.test(c.snapshotHash)
    ? c
    : undefined;
}

/** Build all absolute decisions, including unchanged inherited values and explicit zeroes. */
export function correctionAdjustments(
  detail: GeaSalesPlanDetail,
  edits: Record<string, string>,
  workflowRows?: readonly SalesPlanWorkflowRow[],
) {
  return detail.skus.flatMap((sku) => {
    const delta =
      edits[sku.skuCode] ??
      correctionDecision(
        sku,
        detail.currentVersion.status,
        detail.currentVersion.planTypeCode,
        true,
        workflowRows,
      );
    const line = correctionLine(sku, delta);
    // Zero is explicit intent; the service removes double-zero rows only after validation.
    return [{ skuCode: sku.skuCode, adjustQty: line.delta }];
  });
}

/** Readback checks node data as well as status and the matching action log. */
export function verifyCorrectionAction(
  before: GeaSalesPlanDetail,
  after: GeaSalesPlanDetail,
  request: GeaSalesPlanActionRequest,
  receipt: GeaSalesPlanActionReceipt,
): boolean {
  const v = before.currentVersion,
    a = after.currentVersion;
  const flow = salesPlanWorkflow(v.planTypeCode),
    role = flow.actor(v.status);
  if (
    !role ||
    role === "customer" ||
    a.id !== v.id ||
    a.planId !== v.planId ||
    a.seq !== v.seq ||
    !a.effective ||
    a.orderType !== "Z" ||
    a.status !== flow.transition(v.status, request.action) ||
    receipt.planId !== v.planId ||
    receipt.versionId !== v.id ||
    receipt.fromStatus !== v.status ||
    receipt.toStatus !== a.status ||
    !after.logs.some(
      (l) =>
        l.requestId === receipt.requestId &&
        l.versionId === v.id &&
        l.planId === v.planId &&
        l.actionCode === request.action &&
        l.fromStatus === v.status &&
        l.toStatus === a.status &&
        `sales-plan-log:${l.id}` === receipt.auditId,
    )
  )
    return false;
  const decisions = new Map(
    (request.adjustments ?? []).map((x) => [x.skuCode, x.adjustQty]),
  );
  if (
    new Set(after.skus.map((x) => x.skuCode)).size !== after.skus.length ||
    after.skus.some(
      (x) =>
        x.versionId !== v.id ||
        !before.skus.some((s) => s.skuCode === x.skuCode),
    )
  )
    return false;
  const equal = (x: unknown, y: unknown) => {
    try {
      return correctionDecimal(x).eq(correctionDecimal(y));
    } catch {
      return x == null && y == null;
    }
  };
  return before.skus.every((sku) => {
    const saved = after.skus.find((x) => x.skuCode === sku.skuCode);
    const delta = decisions.get(sku.skuCode);
    if (
      request.action !== "REJECT" &&
      delta != null &&
      correctionLine(sku, delta).participates === false
    )
      return !saved;
    if (!saved || !equal(saved.qty, sku.qty) || !equal(saved.price, sku.price))
      return false;
    for (const other of ["region", "province", "area", "category"] as const) {
      for (const suffix of [
        "AdjAddQty",
        "AdjCutQty",
        "ConfirmedQty",
        "ConfirmedAmount",
      ] as const) {
        if (
          other !== role ||
          (request.action === "SAVE" && suffix.startsWith("Confirmed"))
        ) {
          if (!equal(saved[`${other}${suffix}`], sku[`${other}${suffix}`]))
            return false;
        }
      }
    }
    if (request.action === "REJECT")
      return [
        "AdjAddQty",
        "AdjCutQty",
        "ConfirmedQty",
        "ConfirmedAmount",
      ].every((s) => saved[`${role}${s}` as keyof GeaSalesPlanSku] == null);
    if (delta == null) return false;
    const expected = correctionLine(sku, delta);
    return (
      equal(saved[`${role}AdjAddQty`], expected.addQty) &&
      equal(saved[`${role}AdjCutQty`], expected.cutQty) &&
      (request.action === "SAVE" ||
        (equal(saved[`${role}ConfirmedQty`], expected.qty) &&
          equal(saved[`${role}ConfirmedAmount`], expected.amount)))
    );
  });
}
