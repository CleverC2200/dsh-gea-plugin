import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";

for (const change of ["hidden", "reordered"]) test(`a ${change} visible column invalidates a pending row reference`, {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 90000,
}, async t => {
  const { page, frame, quote, readReference } = await stockReferencePage(t);
  const pending = Promise.withResolvers(), release = Promise.withResolvers(), completed = Promise.withResolvers();
  let posted;
  await page.evaluate(() => {
    window.referenceErrors = [];
    addEventListener('message', event => {
      if (event.data?.protocol === 'dsh-page-interaction-v1' && event.data.type === 'selection-error') referenceErrors.push(event.data.error);
    });
  });
  await page.route("**/api/page-interaction/reference", async route => {
    posted = route.request().postDataJSON();
    pending.resolve();
    await release.promise;
    const response = await route.fetch();
    await route.fulfill({ response }).catch(() => {});
    completed.resolve();
  });
  try {
    await page.keyboard.down("Alt");
    await expect(page.locator("[data-page-selection-trigger]")).toHaveAttribute("aria-pressed", "true");
    await frame.locator(".replenishment-table tbody tr").filter({ hasText: "FC001" }).first().locator("td").first().click();
    await pending.promise;
    await page.keyboard.up("Alt");
    if (change === "hidden") {
      // Real rendered column visibility changes, without touching the picker, bridge or React state.
      await frame.locator(".replenishment-table").evaluate(table => {
        const index = [...table.querySelectorAll("thead th")].findIndex(cell => cell.dataset.column === "productName");
        for (const row of table.rows) row.cells[index].hidden = true;
      });
      await expect(frame.getByRole("columnheader", { name: "产品名称", exact: true })).toHaveCount(0);
    } else {
      await frame.locator('th[data-column="inventoryQty"]').dragTo(frame.locator('th[data-column="productName"]'));
      await expect.poll(() => frame.locator("thead th[data-column]").evaluateAll(cells => cells.map(cell => cell.dataset.column).indexOf("inventoryQty"))).toBe(1);
    }
    release.resolve();
    await completed.promise;
    await page.waitForTimeout(500);
    const text = await page.locator('[contenteditable="true"]').first().innerText();
    await mkdir(".runtime/reference-columns-evidence", { recursive: true });
    await writeFile(`.runtime/reference-columns-evidence/${change}.json`, JSON.stringify({ change, quotedText: posted.text, beforeScope: posted.scope, afterScope: await frame.locator("main.agent-root").getAttribute("data-page-reference-scope"), composer: text, errors: await page.evaluate(() => referenceErrors) }, null, 2));
    assert.equal(text.trim(), "", "obsolete columns must not be inserted into the current question");
    await expect.poll(() => page.evaluate(() => referenceErrors.join("\n"))).toMatch(/引用已失效/);
    await page.unroute("**/api/page-interaction/reference");
    const fresh = page.waitForResponse(response => response.url().endsWith("/api/page-interaction/reference") && response.status() === 200);
    await quote();
    const receipt = await (await fresh).json();
    const read = await readReference(receipt.id);
    assert.match(read.text, /USER_PAGE_REFERENCE/);
    if (change === "hidden") assert.doesNotMatch(read.text, /产品名称|测试常温奶/);
  } finally {
    release.resolve();
    await page.keyboard.up("Alt");
  }
});
