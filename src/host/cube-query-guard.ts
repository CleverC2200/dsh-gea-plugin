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
  /** 这个值所属的成员名（用来判断它是不是时间成员）。 */
  member: string;
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
    const member =
      typeof (filter as { member?: unknown }).member === "string"
        ? (filter as { member: string }).member
        : "";
    if (Array.isArray(entry.values))
      entry.values.forEach((value, valueIndex) => {
        if (typeof value === "string" && YEAR_MONTH.test(value.trim()))
          hits.push({
            path: `${at}.values[${valueIndex}]`,
            value: value.trim(),
            member,
          });
      });
    if (entry.or !== undefined) walkFilters(entry.or, `${at}.or`, hits);
    if (entry.and !== undefined) walkFilters(entry.and, `${at}.and`, hits);
  });
}

/**
 * 扫 `queries[].query.filters[].values` 里的年月值；没有就返回空数组。
 *
 * **只有确认该成员是时间类型才拦**（`isTimeMember` 返回 true）。原因：
 * `agents_sales_plan_detail_mi.plane_date` 声明类型是 string、真实值就是 `2026-01`…`2026-08`
 * 这类文本年月，用它过滤是合法写法（2026-10-19 实测 `contains "2026-10"` 就是它的正常用法）。
 * 类型拿不到时**不拦**：误拦会把模型推向"写完整日期 / 用该月第一天"这种在文本年月列上
 * 一定 0 行的写法，比放过一次更糟。
 */
export function yearMonthValues(
  queries: unknown,
  isTimeMember?: (member: string) => boolean,
): YearMonthHit[] {
  const hits: YearMonthHit[] = [];
  if (!Array.isArray(queries)) return hits;
  queries.forEach((query, queryIndex) => {
    if (!query || typeof query !== "object") return;
    const cubeQuery = (query as { query?: unknown }).query;
    if (!cubeQuery || typeof cubeQuery !== "object") return;
    const found: YearMonthHit[] = [];
    walkFilters(
      (cubeQuery as { filters?: unknown }).filters,
      `queries[${queryIndex}].query.filters`,
      found,
    );
    for (const hit of found)
      if (!isTimeMember || isTimeMember(hit.member)) hits.push(hit);
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
    `入参预检未通过：filters 里给时间成员 ${hits[0]?.member || "（未标明成员）"} 用了只有年月的值 ${listed}。` +
    "这个成员在目录里标的是时间类型，值必须是完整日期（写 `2026-10` 会被数据库拒：invalid input syntax for type date）。" +
    "要筛整月**不要用 equals 该月第一天**（那只会命中那一天），两种正确写法：" +
    '① timeDimensions：[{dimension:"模型.该成员", dateRange:["2026-10-01","2026-11-01"]}]；' +
    '② filters 用两个条件覆盖整月：[{member,operator:"gte",values:["2026-10-01"]},{member,operator:"lt",values:["2026-11-01"]}]。' +
    "如果这个成员其实是文本年月（目录里标的是 string、现有值形如 2026-01），那就照它的格式写——那种情况宿主不会拦。" +
    "本次调用没有发出；改好之后再调一次。"
  );
}
