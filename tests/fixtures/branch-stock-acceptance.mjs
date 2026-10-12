import assert from "node:assert/strict";

// Constructed test inputs, not historical producer proof or real business plans.
// Separate September and October records supply the two calendar months used
// by the September 29 forward calculation. Original stock rows stay immutable.
export const branchStockAcceptance = {
  fixedTime: "2026-09-29T12:00:00+08:00",
  plans: [
    { month: "2026-09-01", shipmentQty: 300, transferQty: 0 },
    { month: "2026-10-01", shipmentQty: 300, transferQty: 0 },
  ],
  shippedMonth: "2026-09-01",
};

export function branchStockExpectedText(legacyText) {
  // W 3202a531 added this actual button on 2026-09-30. No business text or
  // numbers are regenerated from the rendered page; every other byte remains.
  const anchor = "大日期处理\n长沙分仓";
  assert.equal(legacyText.split(anchor).length, 2, "historical refresh anchor must be unique");
  return legacyText.replace(anchor, "大日期处理\n刷新\n长沙分仓");
}
