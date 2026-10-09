import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";

test(
  "reload while a saved response is delayed cannot insert into the replacement page",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 90000,
  },
  async (t) => {
    const { page, frame, quote, readReference } = await stockReferencePage(t);
    const saved = Promise.withResolvers(),
      release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/page-interaction/reference", async (route) => {
      const response = await route.fetch();
      saved.resolve({ status: response.status(), receipt: await response.json() });
      await release.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    await quote();
    const outcome = await saved.promise;
    assert.equal(outcome.status, 200);
    const frameElement = page.locator('iframe[src*="/api/gea-html/inventory-fc/html"]');
    await frameElement.evaluate(
      (iframe) =>
        new Promise((resolve) => {
          iframe.addEventListener("load", resolve, { once: true });
          iframe.src = iframe.src;
        }),
    );
    release.resolve();
    await page.waitForTimeout(300);
    assert.equal((await page.locator('[contenteditable="true"]').first().innerText()).trim(), "");
    await page.unroute("**/api/page-interaction/reference");
    await page.getByText("AI工作台", { exact: true }).click();
    await page.getByRole("button", { name: "业务工作台", exact: true }).click();
    if (!(await page.getByText("分仓库存", { exact: true }).isVisible()))
      await page.getByText("库存管理", { exact: true }).click();
    await page.getByText("分仓库存", { exact: true }).click();
    await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible({ timeout: 15000 });
    const fresh = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/page-interaction/reference") && response.status() === 200,
    );
    await quote();
    const receipt = await (await fresh).json();
    await expect(page.locator('[contenteditable="true"]').first()).toContainText("FC001");
    assert.match((await readReference(receipt.id)).text, /USER_PAGE_REFERENCE/);
  },
);
