import assert from "node:assert/strict";

export const branchStockAcceptance = {
  fixedTime: "2026-09-29T12:00:00+08:00",
  plans: [
    { month: "2026-09-01", shipmentQty: 300, transferQty: 0 },
    { month: "2026-10-01", shipmentQty: 300, transferQty: 0 },
  ],
  shippedMonth: "2026-09-01",
};

export function branchStockExpectedText(legacyText) {
  const anchor = "大日期处理\n长沙分仓";
  assert.equal(legacyText.split(anchor).length, 2, "historical refresh anchor must be unique");
  return legacyText.replace(anchor, "大日期处理\n刷新\n长沙分仓");
}
