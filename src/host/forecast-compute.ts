import { Decimal } from "decimal.js";
import { defineTool } from "@deepseek-ai/dsh-tools";

const D = Decimal.clone({ precision: 40 });
type RecordValue = Record<string, unknown>;
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw Error(`${field}: required`);
  return value;
}
function month(value: unknown, field: string): number {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(text(value, field));
  if (!match || Number(match[1]) < 1) throw Error(`${field}: YYYY-MM required`);
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}
function number(value: unknown, field: string, minimum = 0): Decimal {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(String(value))
  )
    throw Error(`${field}: finite decimal required; missing is not zero`);
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value)
  )
    throw Error(`${field}: unsafe number; use a decimal string`);
  const result = new D(value);
  if (!result.isFinite() || result.lt(minimum))
    throw Error(`${field}: must be >= ${minimum}`);
  return result;
}
function rowResult(row: RecordValue): RecordValue {
  const result: RecordValue = {
    customer_id: row.customer_id,
    sku_id: row.sku_id,
    unit: row.unit,
    source_ref: row.source_ref,
    status: "blocked",
    forecast1: null,
    forecast2: null,
    recommended_baseline: null,
    final_forecast: null,
    amount: null,
    issues: [],
    basis: "ontology-v2-section-5.5-draft",
  };
  try {
    if (row.eligible === false)
      return {
        ...result,
        status: "excluded",
        issues: [text(row.exclusion_reason, "exclusion_reason")],
      };
    if (row.eligible !== true)
      throw Error("eligible: candidate eligibility unresolved");
    if (row.product_kind !== "regular")
      throw Error(
        "new/short_shelf products require a separate evidenced method",
      );
    if (typeof row.seasonal !== "boolean")
      throw Error("seasonal: explicit boolean required");
    if (
      !Array.isArray(row.quality_issues) ||
      row.quality_issues.some((x) => typeof x !== "string" || !x.trim())
    )
      throw Error("quality_issues: explicit string array required");
    const plan = number(row.base_plan_qty, "base_plan_qty"),
      actual = number(
        row.base_actual_to_cutoff_qty,
        "base_actual_to_cutoff_qty",
      );
    const h0 = number(row.prior_base_actual_qty, "prior_base_actual_qty"),
      h1 = number(row.prior_target_actual_qty, "prior_target_actual_qty");
    if (h0.isZero())
      throw Error("prior_base_actual_qty is zero; ratio method unavailable");
    const weights = row.weights as RecordValue | undefined;
    if (
      "weights" in row &&
      (!weights || typeof weights !== "object" || Array.isArray(weights))
    )
      throw Error("weights: exactly yoy and mom required");
    if (weights && Object.keys(weights).sort().join(",") !== "mom,yoy")
      throw Error("weights: exactly yoy and mom required");
    const wy = number(
      weights?.yoy ?? (weights ? undefined : "0.5"),
      "weights.yoy",
    );
    const wm = number(
      weights?.mom ?? (weights ? undefined : "0.5"),
      "weights.mom",
    );
    if (wy.plus(wm).minus(1).abs().gt("0.000000001"))
      throw Error("weights must sum to 1");
    const estimate = D.max(plan, actual),
      yoy = estimate.div(h0).minus(1),
      mom = h1.div(h0).minus(1);
    const f1 = h1
      .mul(yoy.plus(1))
      .mul(wy)
      .plus(estimate.mul(mom.plus(1)).mul(wm));
    const gy =
      row.target_yoy_growth == null
        ? undefined
        : number(row.target_yoy_growth, "target_yoy_growth", -1);
    const gm =
      row.target_mom_growth == null
        ? undefined
        : number(row.target_mom_growth, "target_mom_growth", -1);
    const issues = [...row.quality_issues];
    const f2 =
      gy && gm
        ? h1
            .mul(gy.plus(1))
            .mul(wy)
            .plus(estimate.mul(gm.plus(1)).mul(wm))
        : undefined;
    if (
      [estimate, yoy, mom, f1, ...(f2 ? [f2] : [])].some(
        (value) => !Number.isFinite(value.toNumber()),
      )
    )
      throw Error("calculation overflow; no numerical forecast emitted");
    if (!f2)
      issues.push(
        "growth plan missing: forecast2 unavailable; no automatic forecast1 substitution",
      );
    if (row.seasonal)
      issues.push(
        "seasonal adjustment unimplemented/unconfirmed; baseline only",
      );
    return {
      ...result,
      status: issues.length ? "partial" : "calculated",
      forecast1: f1.toFixed(),
      forecast2: f2?.toFixed() ?? null,
      recommended_baseline: f2?.toFixed() ?? null,
      final_forecast: issues.length ? null : (f2?.toFixed() ?? null),
      issues,
      weights: { yoy: wy.toFixed(), mom: wm.toFixed() },
      weight_basis: weights ? "provided" : "V2 section 5.5 default 50/50",
      intermediate: {
        base_estimate_qty: estimate.toFixed(),
        base_yoy_growth: yoy.toFixed(),
        prior_target_mom_growth: mom.toFixed(),
      },
    };
  } catch (error) {
    return {
      ...result,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/** Port of the suite's pure §5.5 calculator; no source verification, prices, network or business writes. */
export function computeForecast(data: RecordValue): RecordValue {
  if (
    data.schema_version !== 1 ||
    typeof data.data_mode !== "string" ||
    !["provided", "mock", "live"].includes(String(data.data_mode))
  )
    throw Error("INVALID_FORECAST_ENVELOPE");
  text(data.period_mapping_confirmation, "period_mapping_confirmation");
  text(data.candidate_policy_confirmation, "candidate_policy_confirmation");
  const base = month(data.base_month, "base_month");
  if (
    month(data.target_month, "target_month") !== base + 1 ||
    month(data.prior_base_month, "prior_base_month") !== base - 12 ||
    month(data.prior_target_month, "prior_target_month") !== base - 11
  )
    throw Error("FORECAST_MONTH_MAPPING_INVALID");
  const snapshot = text(data.snapshot_at, "snapshot_at");
  const calendar = new Date(snapshot.slice(0, 10) + "T00:00:00Z");
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== snapshot.slice(0, 10)
  )
    throw Error("FORECAST_SNAPSHOT_INVALID");
  if (
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(snapshot) ||
    !Number.isFinite(Date.parse(snapshot)) ||
    snapshot.slice(0, 7) !== data.base_month
  )
    throw Error("FORECAST_SNAPSHOT_INVALID");
  if (
    !Array.isArray(data.records) ||
    data.records.length < 1 ||
    data.records.length > 200
  )
    throw Error("FORECAST_ROWS_LIMIT");
  const keys = new Set<string>();
  for (const item of data.records) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw Error("FORECAST_ROW_INVALID");
    const row = item as RecordValue;
    const key = JSON.stringify([
      text(row.customer_id, "customer_id"),
      text(row.sku_id, "sku_id"),
    ]);
    text(row.unit, "unit");
    text(row.source_ref, "source_ref");
    if (keys.has(key)) throw Error("FORECAST_DUPLICATE_CUSTOMER_SKU");
    keys.add(key);
  }
  const rows = data.records.map((row) => rowResult(row as RecordValue));
  return {
    schema_version: 1,
    calculator_version: "gea-v2-5.5-decimal-1",
    decimalPrecision: 40,
    artifact_status: "draft",
    business_review: "pending",
    source_verified_by_calculator: false,
    data_mode: data.data_mode,
    snapshot_at: snapshot,
    base_month: data.base_month,
    target_month: data.target_month,
    prior_base_month: data.prior_base_month,
    prior_target_month: data.prior_target_month,
    period_mapping_confirmation: data.period_mapping_confirmation,
    candidate_policy_confirmation: data.candidate_policy_confirmation,
    coverage: {
      input_rows: rows.length,
      ...Object.fromEntries(
        ["calculated", "partial", "blocked", "excluded"].map((status) => [
          status,
          rows.filter((row) => row.status === status).length,
        ]),
      ),
      full_candidate_pool_coverage: "unknown",
    },
    rows,
    external_writes: false,
  };
}

const decimal = {
  type: "string",
  description: "精确十进制字符串，不传 JSON 浮点数。",
} as const;
export const forecastTool = defineTool({
  name: "gea_forecast_compute",
  description:
    "按已确认月份映射和候选口径计算 §5.5 数量基线，返回精确十进制字符串。仅核算输入，不核验来源、不定价、不写入系统；新品/短保、缺历史及节令缺口单列。先加载基线 Skill。",
  parameters: {
    schema_version: { type: "integer", required: true },
    data_mode: {
      type: "string",
      required: true,
      enum: ["provided", "mock", "live"],
    },
    base_month: { type: "string", required: true },
    target_month: { type: "string", required: true },
    prior_base_month: { type: "string", required: true },
    prior_target_month: { type: "string", required: true },
    snapshot_at: { type: "string", required: true },
    period_mapping_confirmation: { type: "string", required: true },
    candidate_policy_confirmation: { type: "string", required: true },
    records: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          customer_id: { type: "string" },
          sku_id: { type: "string" },
          unit: { type: "string" },
          source_ref: { type: "string" },
          eligible: { type: "boolean" },
          exclusion_reason: { type: "string" },
          product_kind: {
            type: "string",
            enum: ["regular", "new", "short_shelf"],
          },
          seasonal: { type: "boolean" },
          quality_issues: { type: "array", items: { type: "string" } },
          base_plan_qty: decimal,
          base_actual_to_cutoff_qty: decimal,
          prior_base_actual_qty: decimal,
          prior_target_actual_qty: decimal,
          target_yoy_growth: decimal,
          target_mom_growth: decimal,
          weights: {
            type: "object",
            additionalProperties: false,
            properties: { yoy: decimal, mom: decimal },
          },
        },
      },
    },
  },
  output: {
    schema: { type: "string" },
    render: (_args, value) => [{ type: "text", text: value }],
  },
  isConcurrencySafe: () => true,
  execute: async (args) => JSON.stringify(computeForecast(args)),
});
