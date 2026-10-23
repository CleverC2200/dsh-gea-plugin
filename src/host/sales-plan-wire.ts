import type { GeaSalesPlanSubmitRequest } from "@cleverc2200/dsh-agent-workbench/sales-plan";

const dimensions = new Map([
  ["areaCode", "region_code"],
  ["provinceCode", "province_region_code"],
  ["orgCode", "sales_group_code"],
  ["baseName", "belong_base"],
  ["dealerCode", "cust_code"],
]);
const maximumCustomer = 9223372036854775807n;

export function salesPlanCustomer(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value) ||
    value.length > 19 ||
    BigInt(value) > maximumCustomer
  )
    throw new Error("GEA_INVALID_CUSTOMER");
  return value;
}

export function salesPlanWireKey(key: string): string {
  return dimensions.get(key) ?? key;
}

export function salesPlanDimensionsPath(path: string): boolean {
  return /^\/sales-plan\/plans(?:\/[^/?]+(?:\/versions)?)?$/.test(path.split("?")[0]);
}

export function salesPlanQueryValue(key: string, value: unknown): string {
  if (key === "dealerCode") return salesPlanCustomer(value);
  if (typeof value !== "string" || (dimensions.has(key) && value.length > 64))
    throw new Error("GEA_INVALID_DIMENSION");
  return value;
}

function row(value: unknown, names = false): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized: Record<string, unknown> = { ...value };
  for (const [internal, wire] of dimensions) {
    delete normalized[internal];
    if (!Object.hasOwn(normalized, wire)) continue;
    const value = normalized[wire];
    normalized[internal] =
      value === null || internal === "dealerCode" ? value : salesPlanQueryValue(internal, value);
    delete normalized[wire];
  }
  if (names) {
    if (normalized.dealerName == null && normalized.dealer_name != null)
      normalized.dealerName = normalized.dealer_name;
    if (normalized.provinceName == null && normalized.province_name != null)
      normalized.provinceName = normalized.province_name;
    delete normalized.dealer_name;
    delete normalized.province_name;
  }
  return normalized;
}

export function decodeSalesPlanResult(path: string, value: unknown): unknown {
  const pathname = path.split("?")[0];
  if (!salesPlanDimensionsPath(path)) return value;
  if (Array.isArray(value)) return value.map((item) => row(item));
  if (!value || typeof value !== "object") return value;
  const result = { ...value };
  if (pathname === "/sales-plan/plans" && "records" in result && Array.isArray(result.records))
    result.records = result.records.map((item) => row(item, true));
  if ("currentVersion" in result) result.currentVersion = row(result.currentVersion);
  if ("versions" in result && Array.isArray(result.versions))
    result.versions = result.versions.map((item) => row(item));
  if (pathname.endsWith("/versions") && "records" in result && Array.isArray(result.records))
    result.records = result.records.map((item) => row(item));
  return result;
}

export function serializeSalesPlanSubmission(request: GeaSalesPlanSubmitRequest): string {
  const fields = Object.entries(request)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const encoded =
        key === "dealerCode"
          ? salesPlanCustomer(value)
          : JSON.stringify(dimensions.has(key) ? salesPlanQueryValue(key, value) : value);
      return `${JSON.stringify(salesPlanWireKey(key))}:${encoded}`;
    });
  return `{${fields.join(",")}}`;
}
