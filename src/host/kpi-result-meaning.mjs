export const KPI_RESULT_EVIDENCE_POLICY =
  "六指标回答按本次返回的scope、sample、pending、coverageNote和countMeaning解释。" +
  "标为可判定样本或非全量的只能称样本率，不能说待确认已计入商品数量分母或称完整率；准交率等其他指标按自身合同解释。" +
  "pending为空只写未提供，不写0、不推断不适用；真实0保留，并保留原单位。" +
  "月累计与其中本周是重叠集合，待确认数量分别列示，不能相加称为总数。" +
  "当前发布的value_final已由同口径分子分母计算，不需本地命令重算；没有比较期或维度证据，不扩写原因和分布。";

export function kpiResultMeaning(current) {
  if (!current || typeof current !== "object") return null;
  const sampleOnly =
    /可判定样本|非全量/.test(current.scope ?? "") || current.sample?.known < current.sample?.total;
  return {
    scope: current.scope ?? null,
    sample: current.sample ?? null,
    pending: current.pending ?? null,
    pendingUnit: current.pendingUnit ?? null,
    statement: [
      sampleOnly
        ? "当前值是可判定样本率，不能称完整率或全量率；待确认记录的数量不能直接加进商品数量分母，也不能声称已经计入分母。"
        : "是否完整以及待确认如何参与分子分母，按本指标scope、formula和coverageNote说明，不套用其他指标规则。",
      current.pending == null
        ? "待确认数量未提供，不是0；仅凭空值不能断言不适用或不存在待确认。"
        : `待确认数量为${current.pending}${current.pendingUnit ?? ""}，不是剔除数量。`,
      "sample中的候选记录覆盖率不是商品数量覆盖率；没有维度或比较期证据，不推断原因与分布。",
    ].join(""),
  };
}

export function cubeKpiResultMeaning(result) {
  let payload;
  try {
    payload = JSON.parse(result);
  } catch {
    return result;
  }
  const interpretation = [];
  for (const dataset of payload.datasets ?? [])
    for (const row of dataset.rows ?? [])
      for (const [key, raw] of Object.entries(row)) {
        if (!key.endsWith(".metric_result")) continue;
        let value;
        try {
          value = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
          continue;
        }
        if (!value?.metricCode || !value?.dataset_generation) continue;
        const meaning = kpiResultMeaning(value.current ?? value);
        if (meaning)
          interpretation.push({
            dataset: dataset.name,
            metric: value.metric,
            ...meaning,
          });
      }
  return interpretation.length
    ? JSON.stringify({ ...payload, metricInterpretation: interpretation })
    : result;
}
