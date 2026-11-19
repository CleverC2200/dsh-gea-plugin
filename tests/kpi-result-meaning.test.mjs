import test from "node:test";
import assert from "node:assert/strict";
import { cubeKpiResultMeaning, kpiResultMeaning } from "../src/host/kpi-result-meaning.mjs";

test("sample rate and pending units remain explicit without changing source values", () => {
  const current = {
    value: 3.81,
    numerator: 161453,
    denominator: 4232553,
    pending: 3046,
    pendingUnit: "条候选商品明细",
    scope: "可判定样本，非全量",
    sample: { known: 80587, total: 83633 },
  };
  const payload = {
    metric: "作废率",
    metricCode: "cancellation",
    dataset_generation: "batch",
    current,
  };
  const response = {
    datasets: [{ name: "month", rows: [{ "K.metric_result": JSON.stringify(payload) }] }],
  };
  const result = JSON.parse(cubeKpiResultMeaning(JSON.stringify(response)));
  assert.deepEqual(result.datasets, response.datasets);
  assert.match(result.metricInterpretation[0].statement, /不能称完整率或全量率/);
  assert.match(result.metricInterpretation[0].statement, /不能声称已经计入分母/);
  assert.match(result.metricInterpretation[0].statement, /3046条候选商品明细/);
});
test("null pending is unknown, real zero is retained, other Cube results unchanged", () => {
  assert.match(kpiResultMeaning({ pending: null }).statement, /不能断言不适用/);
  assert.match(kpiResultMeaning({ pending: 0 }).statement, /待确认数量为0/);
  const text = JSON.stringify({ datasets: [{ rows: [{ "K.total": 0 }] }] });
  assert.equal(cubeKpiResultMeaning(text), text);
});
