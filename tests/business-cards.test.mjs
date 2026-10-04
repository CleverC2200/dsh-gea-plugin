import test from "node:test";
import assert from "node:assert/strict";
import { prefersBusinessCards } from "../src/host/business-presentation.ts";

test("business presentation respects plain text requests and leaves one-off facts alone", () => {
  assert.equal(prefersBusinessCards("看下9月份需求预测情况"), true);
  assert.equal(
    prefersBusinessCards("10月份销售预测结果是多少，供应是否存在缺口"),
    true,
  );
  assert.equal(
    prefersBusinessCards("只用一句文字说明预测情况，不要卡片"),
    false,
  );
  assert.equal(prefersBusinessCards("这条记录的日期是什么"), false);
});
