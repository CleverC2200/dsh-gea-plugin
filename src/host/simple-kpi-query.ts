type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
const date = (value: number) => new Date(value).toISOString().slice(0, 10);
const day = 86400000;

export function terminalCubeFailure(error: unknown): boolean {
  const value = object(error);
  const text = `${value?.code ?? ""} ${error instanceof Error ? error.message : String(error)}`;
  return (
    /\b(?:CUBE_UNAVAILABLE|GEA_NETWORK_TIMEOUT|GEA_MCP_RESPONSE_TOO_LARGE|AI_GATEWAY_MCP_RESULT_TOO_LARGE|GEA_MCP_HTTP_5\d\d)\b/.test(
      text,
    ) ||
    (error instanceof Error &&
      (error.name === "TimeoutError" || /fetch failed/i.test(error.message)))
  );
}

export function latestUserQuestion(events: readonly unknown[] = []): string {
  for (const event of [...events].reverse()) {
    const item = object(event);
    const data = object(item?.data);
    if (item?.type !== "user/message" || object(data?.source)?.kind !== "user") continue;
    return Array.isArray(data?.content)
      ? data.content
          .flatMap((part) => {
            const block = object(part);
            return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
          })
          .join("\n")
      : "";
  }
  return "";
}

export function simpleKpiPlan(question: string, now = new Date()) {
  const match = question
    .trim()
    .match(
      /^(?:请问|请|帮我查一下|帮我查询|查一下|查询)?\s*(?:全国)?\s*(上周|本周|上月|本月|昨天|今天)的?(作废率|改单率|满足率|准交率|60天以上货龄占比|可发货天数)(?:是多少|多少|为多少)?[？?。！!]*$/,
    );
  if (!match) return;
  const [, period, metric] = match;
  const today = Date.parse(date(now.getTime() + 8 * 3600000));
  const weekday = (new Date(today).getUTCDay() + 6) % 7;
  const monday = today - weekday * day;
  const month = Date.UTC(new Date(today).getUTCFullYear(), new Date(today).getUTCMonth(), 1);
  const previousMonth = Date.UTC(
    new Date(today).getUTCFullYear(),
    new Date(today).getUTCMonth() - 1,
    1,
  );
  const inventory = ["60天以上货龄占比", "可发货天数"].includes(metric);
  const end = today + (inventory ? day : 0);
  const [start, endExclusive] = {
    上周: [monday - 7 * day, monday],
    本周: [monday, end],
    上月: [previousMonth, month],
    本月: [month, end],
    昨天: [today - day, today],
    今天: [today, end],
  }[period]!;
  return {
    metric,
    period,
    start: date(start),
    endExclusive: date(endExclusive),
    endInclusive: date(endExclusive - day),
    empty: start >= endExclusive,
  };
}

export function simpleKpiPrompt(plan: NonNullable<ReturnType<typeof simpleKpiPlan>>): string {
  return (
    `本轮是简单指标问数：${plan.metric}，${plan.period}，周期[${plan.start},${plan.endExclusive})。` +
    (plan.empty
      ? "当前T-1口径下该周期尚无可统计日期，直接说明，不扩大周期查询。"
      : `先用inspect_cube_model定向核对该指标已发布模型和最终指标说明，再用query_business_data仅发起一条该周期的汇总查询。日期区间若使用Cube dateRange，应为[${plan.start},${plan.endInclusive}]。不附加周趋势、维度分组、比较期或原始明细查询；需要这些内容时由用户另行提出。指标值、分子、分母、待确认和必要单位按模型已发布定义读取，不另算或改公式，缺值不写0。已有完整成功结果直接作答。`) +
    "Cube失败或超时后本轮立即说明未取得有效结果，不拆分、换参数、换工具或重新查模型再次尝试。需要口径解释时仍使用原知识库链路，原Skill和权限保持不变。"
  );
}

export function validateSimpleKpiQuery(
  plan: NonNullable<ReturnType<typeof simpleKpiPlan>>,
  args: RecordValue,
): void {
  const queries = args.queries;
  const query =
    Array.isArray(queries) && queries.length === 1 ? object(object(queries[0])?.query) : undefined;
  const times = Array.isArray(query?.timeDimensions) ? query.timeDimensions.map(object) : [];
  const filters = Array.isArray(query?.filters) ? query.filters.map(object) : [];
  const matchesRange = (range: unknown) =>
    Array.isArray(range) &&
    range.length === 2 &&
    range[0] === plan.start &&
    range[1] === plan.endInclusive;
  const dated =
    times.some((time) => matchesRange(time?.dateRange)) ||
    filters.some((filter) => filter?.operator === "inDateRange" && matchesRange(filter.values));
  const valid =
    !plan.empty &&
    query &&
    (!Array.isArray(query.dimensions) ||
      query.dimensions.every(
        (member) => typeof member === "string" && /\.(?:unit|quantity_unit)$/.test(member),
      )) &&
    times.every((time) => !time?.granularity) &&
    dated;
  if (!valid)
    throw Object.assign(
      new Error(
        `GEA_SIMPLE_KPI_SUMMARY_REQUIRED: 本问题仅允许一条${plan.metric}周期汇总，不含分组或趋势。${simpleKpiPrompt(plan)}`,
      ),
      { code: "GEA_SIMPLE_KPI_SUMMARY_REQUIRED" },
    );
}
