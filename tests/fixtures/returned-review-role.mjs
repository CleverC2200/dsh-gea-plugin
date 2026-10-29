import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./returned-review.mjs";

export async function returnedReviewRole(t, role, returnedStatus) {
  const { frame, approved, submitted } = await fixture(t, { role, returnedStatus });
  await frame.getByTestId("regional-approval-flow-toggle").click();
  await frame.getByTestId(`regional-approval-stage-${role}`).click();
  await frame
    .locator("tbody tr")
    .filter({ hasText: "乌鲁木齐退回区域" })
    .first()
    .locator("label.arco-checkbox")
    .click();
  await expect(frame.getByRole("button", { name: "退回", exact: true })).toBeEnabled();
  await expect(frame.getByRole("button", { name: "通过", exact: true })).toHaveCount(0);
  assert.deepEqual(approved, []);
  assert.deepEqual(submitted, []);
}
