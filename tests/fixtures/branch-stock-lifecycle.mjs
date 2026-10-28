import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export const pageRequest = (page, input) =>
  page.evaluate(async (input) => {
    const response = await fetch("/api/agent-workbench/page", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return { status: response.status, value: await response.json() };
  }, input);

export const assertOwnerReleased = async (page, owner) => {
  let reply;
  await expect
    .poll(async () => {
      reply = await pageRequest(page, { operation: "access", owner });
      return reply.status;
    })
    .toBe(400);
  assert.equal(reply.value.error, "PAGE_OWNER_RELEASED");
};

export const assertOldFrameHidden = async (frame) => {
  assert.ok(frame, "Capture the actual iframe instance before identity revocation");
  await expect
    .poll(() =>
      frame.evaluate((element) => {
        if (!element.isConnected) return true;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width === 0 ||
          rect.height === 0 ||
          style.visibility === "hidden" ||
          style.visibility === "collapse"
        );
      }),
    )
    .toBe(true);
};

export const presentation = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("agent-workbench.presentation.v2")));

export const evidence = ".runtime/branch-stock-lifecycle-evidence";

export const identity = (page) =>
  page.evaluate(async () => {
    const response = await fetch("/api/gea-html/identity", { cache: "no-store" });
    return response.json();
  });
