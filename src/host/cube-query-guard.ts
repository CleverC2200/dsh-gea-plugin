const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export type YearMonthHit = {
  path: string;
  value: string;

  member: string;
};

function walkFilters(filters: unknown, path: string, hits: YearMonthHit[]): void {
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
    for (const hit of found) if (!isTimeMember || isTimeMember(hit.member)) hits.push(hit);
  });
  return hits;
}

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
