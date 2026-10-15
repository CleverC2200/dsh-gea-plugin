import test from "node:test";
import assert from "node:assert/strict";
import { compactDatasetProjection } from "../src/host/prompt-result.ts";
import { salesSourceIssue, salesSourceIssueForTurns } from "../src/host/sales-result-contract.ts";
const model = "agents_sales_plan_detail_mi";
test("mixed rejection retains readable success rows and rejection, instead of raw envelope", () => {
  const raw = JSON.stringify({
    source: "GEA_CUBE_BATCH",
    results: [
      {
        names: ["bad"],
        status: "rejected",
        code: "GEA_CUBE_MEMBER_UNKNOWN",
        message: "bad member",
      },
      {
        names: ["good"],
        status: "returned",
        result: {
          datasets: [
            {
              name: "good",
              rows: [
                {
                  [model + ".row_count"]: 10,
                  [model + ".allnum_sum"]: null,
                  [model + ".province_region_name"]: "",
                },
              ],
              complete: true,
            },
          ],
        },
      },
    ],
  });
  const text = compactDatasetProjection(raw, "ev-test");
  assert.ok(text);
  const value = JSON.parse(text);
  assert.equal(value.sourceOutcome, "partial");
  assert.equal(value.queryFailures[0].code, "GEA_CUBE_MEMBER_UNKNOWN");
  assert.equal(value.datasets[0].table.rows[0][model + ".row_count"], 10);
  assert.match(JSON.stringify(value.datasets[0].businessFacts), /guarded-null|有记录/);
});
test("source gate distinguishes result, workflow, mixed and result follow-ups", () => {
  assert.match(salesSourceIssue("8月最终销售计划") || "", /GEA_SALES_RESULT_SOURCE/);
  assert.match(
    salesSourceIssue("只能使用Hive，不要使用在线计划接口。") || "",
    /GEA_SALES_RESULT_SOURCE/,
  );
  assert.equal(salesSourceIssue("请查在线销售计划汇总及审批状态"), undefined);
  assert.equal(salesSourceIssue("计划结果只从Hive取，同时查在线审批日志"), undefined);
  assert.equal(salesSourceIssue("帮我解释生产计划"), undefined);
  assert.ok(salesSourceIssueForTurns(["8月计划结果", "按客户再列前5条"]));
  assert.equal(salesSourceIssueForTurns(["8月计划结果", "再查当前审批状态"]), undefined);
  assert.equal(
    salesSourceIssueForTurns(["8月计划结果", "查当前在线审批日志", "继续刚才的明细"]),
    undefined,
  );
});
