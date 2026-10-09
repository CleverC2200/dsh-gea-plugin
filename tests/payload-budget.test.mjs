/**
 * 上下文预算：不要让整屏/整表灌进模型上下文。
 *   - 小载荷原样过，不做无谓压缩；
 *   - 带 focus 只留相关行/字段；
 *   - 不带 focus 又超预算时退成摘要（数量 + 字段名 + 极少样本），并如实标注省略多少。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_PAYLOAD_BUDGET,
  compressForModel,
  focusTokens,
} from "@cleverc2200/dsh-agent-workbench/page-interaction/payload-budget";

const rows = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: "row-" + index,
    org: "组织" + index,
    cust: "客户 " + index,
    qty: index,
    note: "x".repeat(120),
  }));

test("小载荷原样通过，不做无谓压缩", () => {
  const small = { scope: "长沙分仓", page: 1, total: 3 };
  const out = compressForModel(small);
  assert.equal(out.compressed, false);
  assert.deepEqual(JSON.parse(out.json), small);
});

test("带 focus 时只留命中的行，并说明省略了多少", () => {
  // 用户点名一般是不带空格的整词（带空格会被切成"组织"+"7"，单字符会被当噪音丢掉）。
  const out = compressForModel({ visibleRows: rows(50) }, { focus: "组织7" });
  assert.equal(out.compressed, true);
  const value = JSON.parse(out.json);
  assert.equal(value.visibleRows.length, 1, "只应留下与 focus 相关的那一行");
  assert.match(JSON.stringify(value.visibleRows[0]), /组织7/);
  assert.equal(out.omitted, 49);
  assert.match(out.note, /focus/);
  assert.match(out.note, /未展开/);
});

test("不带 focus 的超大载荷退成摘要：只给数量与字段名，不整行塞进来", () => {
  const out = compressForModel({ visibleRows: rows(200) });
  assert.ok(
    Buffer.byteLength(out.json, "utf8") <= MODEL_PAYLOAD_BUDGET,
    "必须在预算内",
  );
  const value = JSON.parse(out.json);
  assert.equal(value.visibleRows.count, 200);
  assert.ok(Array.isArray(value.visibleRows.fields));
  assert.ok(value.visibleRows.sample.length <= 1, "摘要最多带一条样本");
  assert.match(out.note, /摘要/);
});

test("focus 关键词切词：太短的词没有区分度，丢掉", () => {
  assert.deepEqual(focusTokens("长沙分仓, 补货量 a 12"), ["长沙分仓", "补货量", "12"]);
  assert.deepEqual(focusTokens(undefined), []);
});
