import test from "node:test";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./fixtures/returned-resubmit.mjs";

for (const [role, returnedStatus] of [
  ["region", 6],
  ["province", 7],
  ["area", 8],
  ["category", 9],
])
  test(
    `the rejecting role can review a return addressed to the previous node: ${role}/${returnedStatus}`,
    { timeout: 90000 },
    async (t) => {
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
      await frame.getByRole("button", { name: "通过", exact: true }).click();
      await expect.poll(() => approved.length).toBe(1);
      assert.equal(approved[0].body.approvalRole, role);
      assert.equal(approved[0].body.expectedStatus, returnedStatus);
      assert.deepEqual(submitted, []);
    },
  );
