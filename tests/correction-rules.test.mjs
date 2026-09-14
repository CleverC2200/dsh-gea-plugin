import test from "node:test";
import assert from "node:assert/strict";
import {
  correctionAdjustments,
  correctionDecision,
  correctionLine,
  correctionMetrics,
} from "../src/workbench-original/workbenches/regionalApproval/models/salesPlanCorrectionModel.ts";

test("correction uses a fixed monthly baseline and absolute node decisions including explicit zero", () => {
  const sku = {
    qty: "30",
    price: "2.3456",
    adjAddQty: "2",
    adjCutQty: "0",
    regionAdjAddQty: "8",
    regionAdjCutQty: "0",
    regionConfirmedQty: "38",
  };
  assert.equal(correctionDecision(sku, 2, "Y"), "8");
  assert.equal(
    correctionDecision(
      { ...sku, provinceAdjAddQty: "0", provinceAdjCutQty: "0" },
      2,
      "Y",
    ),
    "0",
  );
  assert.deepEqual(correctionLine(sku, "-3"), {
    baseQty: "30",
    qty: "27",
    amount: "63.33",
    delta: "-3",
    deltaAmount: "-7.04",
    addQty: "0",
    cutQty: "3",
    participates: true,
  });
  assert.throws(() => correctionLine(sku, "-31"));
  assert.equal(
    correctionLine({ qty: "0", price: "1" }, "0").participates,
    false,
  );
  assert.equal(correctionLine(sku, "-30").participates, true);
});
test("actual progress keeps the monthly denominator and corrected progress measures target coverage", () => {
  assert.deepEqual(
    correctionMetrics({
      targetAmount: "1000",
      mPlanAmount: "800",
      mPlanQty: "40",
      shipAmount: "400",
      shipQty: "10",
      corrPlanAmount: "900",
    }),
    {
      amountProgress: "50.00",
      qtyProgress: "25.00",
      correctionProgress: "90.00",
      netAmount: "100.00",
    },
  );
  assert.equal(
    correctionMetrics({ targetAmount: "0", mPlanAmount: "0", mPlanQty: "0" })
      .correctionProgress,
    undefined,
  );
});

test("zero baseline cancellation sends an explicit zero decision instead of silently inheriting the previous addition", () => {
  const detail = {
    currentVersion: { status: 1, planTypeCode: "Y" },
    skus: [
      { skuCode: "123", qty: "0", price: "2", adjAddQty: "8", adjCutQty: "0" },
    ],
  };
  assert.deepEqual(correctionAdjustments(detail, { 123: "0" }), [
    { skuCode: "123", adjustQty: "0" },
  ]);
});
