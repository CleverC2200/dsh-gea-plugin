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
      : `先用inspect_cube_model定向核对该指标已发布模型和最终指标说明，再用query_business_data仅发起一条该周期的汇总查询。成员放置严格按模型声明：measures只放已发布的度量，dimensions只放已发布的维度；数值类型不代表可聚合度量。metric_result是最终指标结果维度，放入dimensions，不放入measures；它用于返回最终结果，不增加基地、品项等业务分组。可以只读取metric_result和已发布单位维度，不自行推断求和或平均。日期区间若使用Cube dateRange，应为[${plan.start},${plan.endInclusive}]。不附加周趋势、维度分组、比较期或原始明细查询；需要这些内容时由用户另行提出。指标值、分子、分母、待确认和必要单位按模型已发布定义读取，不另算或改公式，缺值不写0。已有完整成功结果直接作答。`) +
    "模型摘要members_truncated时，先用model参数读取对应模型详情，按发布的分页继续取齐所需成员，再发起业务查询。优先使用业务View的成员名，保留View的meta.fixed_source固定来源条件；如使用aliasMember底层别名，必须将该View已发布source_flag成员的别名与meta.fixed_source原值作为equals筛选一起传入，不遗漏指标类别、不猜字段或值。" +
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
  if (
    Array.isArray(query?.measures) &&
    query.measures.some((member) => typeof member === "string" && member.endsWith(".metric_result"))
  )
    throw Object.assign(
      new Error(
        "GEA_SIMPLE_KPI_MEMBER_ROLE_INVALID: metric_result是最终结果维度，应放入dimensions；measures仅使用inspect_cube_model已发布的度量。不自动改写或重复请求。",
      ),
      { code: "GEA_SIMPLE_KPI_MEMBER_ROLE_INVALID" },
    );
  const times = Array.isArray(query?.timeDimensions) ? query.timeDimensions.map(object) : [];
  const filters = Array.isArray(query?.filters) ? query.filters.map(object) : [];
  const metricCode = {
    作废率: "cancellation",
    改单率: "amendment",
    满足率: "fulfillment",
    准交率: "ontime",
    "60天以上货龄占比": "stock_age",
    可发货天数: "stock_turnover",
  }[plan.metric];
  if (
    Array.isArray(query?.dimensions) &&
    query.dimensions.includes("order_kpi_result_v1.metric_result") &&
    !filters.some(
      (filter) =>
        filter?.member === "order_kpi_result_v1.metric_code" &&
        filter.operator === "equals" &&
        Array.isArray(filter.values) &&
        filter.values.length === 1 &&
        filter.values[0] === metricCode,
    )
  )
    throw Object.assign(
      new Error(
        "GEA_SIMPLE_KPI_SOURCE_REQUIRED: 使用最终指标底层别名时必须保留业务View已发布的固定指标来源筛选；请按inspect_cube_model的source_flag与meta.fixed_source构造请求。不自动改写或重复请求。",
      ),
      { code: "GEA_SIMPLE_KPI_SOURCE_REQUIRED" },
    );
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
        (member) =>
          typeof member === "string" && /\.(?:metric_result|unit|quantity_unit)$/.test(member),
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
