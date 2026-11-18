const codes = {
  作废率: "cancellation",
  改单率: "amendment",
  订单满足率: "fulfillment",
  准交率: "ontime",
  "货龄（>60天库存占比）": "stock_age",
  周转天数: "stock_turnover",
};
const fields = {
  base: "base_name",
  item: "item_name",
  category: "category_name",
  director: "director_name",
  sku: "sku_code",
  customer: "customer_code",
  region: "region_name",
  province: "province_name",
  salesRegion: "sales_region",
};
export async function readCubeFinalMetric(
  config,
  input,
  call,
  signal,
  envelope,
  contracts = { summary: envelope.contract, groups: envelope.contract },
) {
  const inspect = JSON.parse(
    await call("inspect_cube_model", { model: "order_kpi_result_v1", limit: 50 }, signal),
  );
  const models =
    inspect.semanticModel?.filter(
      (model) => model.meta?.source_table === "ai_db.order_kpi_result_v1" && model.type === "cube",
    ) ?? [];
  if (models.length !== 1) throw Error("GEA_CUBE_FINAL_METRIC_NOT_PUBLISHED");
  const model = models[0];
  const published = new Map(
    [...(model.measures ?? []), ...(model.dimensions ?? [])].map((m) => [
      m.name.split(".").at(-1),
      m.aliasMember ?? m.name,
    ]),
  );
  const member = (name) => {
    const key = published.get(name);
    if (!/^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(key ?? ""))
      throw Error("GEA_CUBE_FINAL_MEMBER_MISSING:" + name);
    return key;
  };
  if (input.view === "contract") return envelope;
  if (input.view === "details")
    return {
      ...envelope,
      details: {
        availability: "not-published",
        reason: "当前Cube最终指标模型尚未发布原始明细入口，分组能力独立提供。",
      },
    };
  const dimensions =
    input.view === "groups"
      ? [...(input.dimensions ?? envelope.contract.grouping.defaultDimensions)]
      : [];
  if (dimensions.some((key) => ["director", "sku"].includes(key)) && !dimensions.includes("base"))
    dimensions.unshift("base");
  const unsupported = envelope.contract.grouping.unsupported.filter((item) =>
    dimensions.includes(item.dimension),
  );
  if (unsupported.length)
    return {
      ...envelope,
      current: null,
      groups: {
        availability: "unsupported-dimension",
        dimensions,
        rows: [],
        total: null,
        unsupported,
      },
    };
  const queryEnd = ["stock_age", "stock_turnover"].includes(codes[input.metric])
    ? (input.inventoryEndExclusive ?? input.endExclusive)
    : input.endExclusive;
  const end = new Date(Date.parse(queryEnd) - 86400000).toISOString().slice(0, 10);
  if (input.start >= input.endExclusive) return envelope;
  const requestedPage = input.page ?? 1;
  let verifiedSummary;
  const run = async (
    grouped,
    queryBase = input.base,
    rule = grouped ? contracts.groups : contracts.summary,
  ) => {
    const selected = grouped ? dimensions : [];
    const query = {
      measures: ["numerator_final", "denominator_final", "pending_final", "value_final"].map(
        member,
      ),
      dimensions: [member("metric_result"), ...selected.map((k) => member(fields[k]))],
      filters: [
        {
          member: member("metric_code"),
          operator: "equals",
          values: [codes[input.metric]],
        },
        {
          member: member("scope_base"),
          operator: "equals",
          values: [queryBase || "全国"],
        },
      ],
      timeDimensions: [{ dimension: member("stat_time"), dateRange: [input.start, end] }],
      timezone: "Asia/Shanghai",
      limit: grouped ? 100 : 1,
      offset: grouped ? (requestedPage - 1) * 100 : 0,
      ...(grouped ? { order: selected.map((k) => [member(fields[k]), "asc"]) } : {}),
    };
    signal?.throwIfAborted();
    const response = JSON.parse(
      await call(
        "query_business_data",
        {
          action: "query",
          response_mode: "inline_complete",
          queries: [{ name: "order_kpi_final", query }],
        },
        signal,
      ),
    );
    const data = response.datasets?.[0];
    if (
      response.datasets?.length !== 1 ||
      !["ok", "partial", "no_data"].includes(data?.dataStatus) ||
      data.rowCount !== data.rows?.length ||
      !Number.isSafeInteger(data.totalRowCount)
    )
      throw Error("GEA_CUBE_FINAL_RESULT_INCOMPLETE");
    if (!grouped && (data.rowCount !== 1 || data.totalRowCount !== 1))
      throw Error("GEA_CUBE_FINAL_SUMMARY_MISSING");
    let inheritedRule;
    const decode = (row) =>
      typeof row[member("metric_result")] === "string"
        ? JSON.parse(row[member("metric_result")])
        : row[member("metric_result")];
    if (grouped && data.rows.some((row) => decode(row)?.formula == null)) {
      if (rule.formula === contracts.summary.formula) inheritedRule = verifiedSummary;
      else {
        const witnessBase = data.rows[0]?.[member("base_name")];
        if (!witnessBase || !dimensions.includes("base"))
          throw Error("GEA_CUBE_FINAL_SEMANTIC_MISSING");
        inheritedRule = (await run(false, witnessBase, rule)).values[0].value;
      }
      if (!inheritedRule || inheritedRule.dataset_generation !== verifiedSummary.dataset_generation)
        throw Error("GEA_CUBE_FINAL_SNAPSHOT_CHANGED");
    }
    const values = data.rows.map((row) => {
      const payload = row[member("metric_result")],
        value = typeof payload === "string" ? JSON.parse(payload) : payload;
      if (
        !value ||
        value.metric !== input.metric ||
        (value.base ?? "") !== (queryBase ?? "") ||
        value.period?.start !== input.start ||
        value.period?.endExclusive !== input.endExclusive ||
        !value.dataset_generation
      )
        throw Error("GEA_CUBE_FINAL_RESULT_SCOPE_MISMATCH");
      const contract = rule;
      const canonical = (text) => (typeof text === "string" ? text.replace(/\s+/gu, "") : null);
      const empty =
        value.status === "暂无数据" &&
        value.value == null &&
        value.numerator == null &&
        value.denominator == null;
      let expectedFormula = contract.formula;
      if (input.metric === "改单率" && value.population) {
        const p = value.population;
        expectedFormula += `；有效商品数量分母${p.denominator}，已确认有效明细调整量${p.knownNumerator}，待判定${p.unknown}条明细、数量差额${p.unknownQuantity}`;
      }
      if (value.coverageNote) expectedFormula += "；" + value.coverageNote;
      if (input.metric === "准交率" && value.pending > 0)
        expectedFormula +=
          "；显示已确认准交数÷全部应统计已发货执行单数；缺失数据的执行单保留在分母，暂不计入准交数，补齐后重算";
      if (
        canonical(value.periodBasis ?? inheritedRule?.periodBasis) !==
          canonical(contract.periodBasis) ||
        !canonical(contract.periodBasis) ||
        (!empty &&
          ((value.formula == null
            ? !inheritedRule
            : canonical(value.formula) !== canonical(expectedFormula)) ||
            !canonical(contract.formula))) ||
        (value.metricCode != null && value.metricCode !== codes[input.metric])
      )
        throw Error("GEA_CUBE_FINAL_SEMANTIC_MISMATCH");
      for (const [key, measure] of [
        ["numerator", "numerator_final"],
        ["denominator", "denominator_final"],
        ["pending", "pending_final"],
        ["value", "value_final"],
      ])
        if (
          !Object.hasOwn(row, member(measure)) ||
          (row[member(measure)] == null || value[key] == null
            ? row[member(measure)] !== value[key]
            : !Number.isFinite(Number(row[member(measure)])) ||
              !Number.isFinite(Number(value[key])) ||
              Math.abs(Number(row[member(measure)]) - Number(value[key])) >
                (key === "value"
                  ? 1e-10
                  : key === "denominator" && input.metric === "周转天数"
                    ? 8 * Number.EPSILON * Math.max(1, Math.abs(Number(value[key])))
                    : 0))
        )
          throw Error("GEA_CUBE_FINAL_COMPONENT_MISMATCH:" + key);
      return { value, row };
    });
    return { data, values };
  };
  const summary = await run(false),
    total = summary.values[0].value;
  verifiedSummary = total;
  const result = {
    ...envelope,
    current: total,
    datasetGeneration: total.dataset_generation,
    semanticVerification: {
      status: "matched",
      checks: [
        "metric",
        "formula",
        "periodBasis",
        "period",
        "authorizedScope",
        "components",
        "datasetGeneration",
      ],
      buildVersions: {
        local: {
          version: config.metricRuntime.version,
          revision: config.metricRuntime.revision,
        },
        cube: { version: total.version, revision: total.revision },
      },
      meaning:
        "已按实际口径、周期、当前授权范围、数值组件和数据批次核对。构建版本仅作来源诊断，不同构建号不代表业务口径冲突，不要求Cube改版本号。无数据行不宣称公式已核实。",
    },
    readAt: new Date().toISOString(),
    sources: [
      {
        id: model.name,
        status: summary.data.dataStatus,
        warnings: summary.data.warnings ?? [],
      },
    ],
  };
  if (input.view === "groups") {
    const grouped = await run(true);
    for (const { value } of grouped.values)
      if (value.dataset_generation !== total.dataset_generation)
        throw Error("GEA_CUBE_FINAL_SNAPSHOT_CHANGED");
    result.groups = {
      availability: "available",
      dimensions,
      rows: grouped.values.map(({ value, row }) => ({
        ...Object.fromEntries(dimensions.map((k) => [k, row[member(fields[k])]])),
        current: value,
      })),
      total:
        input.metric === "周转天数" && dimensions.includes("base") && !input.base ? null : total,
      contract: {
        ...envelope.contract,
        formula: grouped.values[0]?.value.formula ?? envelope.contract.formula,
        periodBasis: grouped.values[0]?.value.periodBasis ?? envelope.contract.periodBasis,
        grouping: { ...envelope.contract.grouping, dimensions },
      },
      ...(input.metric === "周转天数" && dimensions.includes("base") && !input.base
        ? {
            totalMissingReason:
              "Cube尚未发布全国集合按基地计划范围重算的合计；卡片全国值单独保留在current。",
          }
        : {}),
      calculationScope: dimensions.includes("base")
        ? "base"
        : dimensions.includes("item")
          ? "item"
          : "national",
      pagination: {
        page: requestedPage,
        pageSize: 100,
        totalGroups: grouped.data.totalRowCount,
        hasMore: grouped.data.hasMorePages === true,
      },
      empty: grouped.data.totalRowCount === 0,
    };
  }
  signal?.throwIfAborted();
  return result;
}
