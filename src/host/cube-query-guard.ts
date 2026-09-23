/**
 * Cube 查询的入参预检：只拦"发出去必然被数据库拒"的那一类。
 *
 * 线上实测（cube-core 原样日志）：
 *   WHERE ("agents_scm_safety_stock"."target_month" = $1)   -- $1 = "2026-10"
 *   error: invalid input syntax for type date: "2026-10"
 * 也就是模型把"年月"当日期传了。这类值在两种情况下都是错的：
 * - 该成员是 date/timestamp：必须写完整日期（按整月过滤就写该月第一天）；
 * - 该成员其实是文本年月（例如 plan_month 的值形如 202608）：要照它自己的格式写。
 * 所以拦下来并给出两种正确写法是安全的，不会误伤合法用法；我们不猜成员的列类型。
 */

/** `YYYY-MM` 形态：只有年月，没有日。 */
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export type YearMonthHit = {
  /** 出问题的位置，例如 queries[0].query.filters[0].values[0]。 */
  path: string;
  value: string;
};

function walkFilters(
  filters: unknown,
  path: string,
  hits: YearMonthHit[],
): void {
  if (!Array.isArray(filters)) return;
  filters.forEach((filter, index) => {
    const at = `${path}[${index}]`;
    if (!filter || typeof filter !== "object") return;
    const entry = filter as { values?: unknown; or?: unknown; and?: unknown };
    if (Array.isArray(entry.values))
      entry.values.forEach((value, valueIndex) => {
        if (typeof value === "string" && YEAR_MONTH.test(value.trim()))
          hits.push({ path: `${at}.values[${valueIndex}]`, value: value.trim() });
      });
    if (entry.or !== undefined) walkFilters(entry.or, `${at}.or`, hits);
    if (entry.and !== undefined) walkFilters(entry.and, `${at}.and`, hits);
  });
}

/** 扫 `queries[].query.filters[].values` 里的年月值；没有就返回空数组。 */
export function yearMonthValues(queries: unknown): YearMonthHit[] {
  const hits: YearMonthHit[] = [];
  if (!Array.isArray(queries)) return hits;
  queries.forEach((query, queryIndex) => {
    if (!query || typeof query !== "object") return;
    const cubeQuery = (query as { query?: unknown }).query;
    if (!cubeQuery || typeof cubeQuery !== "object") return;
    walkFilters(
      (cubeQuery as { filters?: unknown }).filters,
      `queries[${queryIndex}].query.filters`,
      hits,
    );
  });
  return hits;
}

/** 拦下来时给模型看的可读说明。 */
export function yearMonthHint(hits: readonly YearMonthHit[]): string {
  const listed = hits
    .slice(0, 3)
    .map((hit) => `${hit.value}（在 ${hit.path}）`)
    .join("、");
  return (
    `入参预检未通过：filters 里出现了只有年月的值 ${listed}。` +
    "这类值发出去会被数据库拒（invalid input syntax for type date）：" +
    "如果这个成员是日期/时间类型，写完整日期并按整月过滤就用该月第一天，例如 2026-10-01；" +
    "如果它其实是文本年月（目录里现有值形如 202608），就照目录里的格式写。" +
    "拿不准时先用 gea_gateway_catalog 的 members + values=true 取一行真实值。本次调用没有发出；改好之后再调一次。"
  );
}
