import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";

for (const change of ["hidden", "reordered", "quantity", "reason"]) test(`a ${change} change invalidates a pending row reference`, {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 90000,
}, async t => {
  const { page, frame, quote, readReference } = await stockReferencePage(t, { editable: change === "quantity" || change === "reason" });
  let edited;
  if (change === "quantity") edited = frame.getByRole("textbox", { name: "FC001 实际补货量", exact: true });
  if (change === "reason") edited = frame.getByRole("textbox", { name: "FC001调减原因", exact: true });
  const beforeValue = change === "quantity" ? "11" : "";
  const afterValue = change === "quantity" ? "12" : "新调减原因";
  if (edited) {
    await edited.fill(beforeValue);
    await expect(edited).toHaveValue(beforeValue);
  }
  const release = Promise.withResolvers(), completed = Promise.withResolvers();
  t.after(() => release.resolve());
  let posted;
  await page.evaluate(() => {
    window.referenceErrors = [];
    addEventListener('message', event => {
      if (event.data?.protocol === 'dsh-page-interaction-v1' && event.data.type === 'selection-error') referenceErrors.push(event.data.error);
    });
  });
  await page.route("**/api/page-interaction/reference", async route => {
    posted = route.request().postDataJSON();
    await release.promise;
    const response = await route.fetch();
    await route.fulfill({ response }).catch(() => {});
    completed.resolve();
  });
  try {
    await page.keyboard.down("Alt");
    await expect(page.locator("[data-page-selection-trigger]")).toHaveAttribute("aria-pressed", "true");
    await expect(frame.locator("main.agent-root")).toHaveAttribute("data-page-reference-ready", "true");
    if (edited) await edited.click();
    else await frame.locator(".replenishment-table tbody tr").filter({ hasText: "FC001" }).first().locator("td").first().click();
    await expect.poll(() => posted, { timeout: 10000 }).toBeTruthy();
    await page.keyboard.up("Alt");
    if (change === "hidden") {
      // Real rendered column visibility changes, without touching the picker, bridge or React state.
      await frame.locator(".replenishment-table").evaluate(table => {
        const index = [...table.querySelectorAll("thead th")].findIndex(cell => cell.dataset.column === "productName");
        for (const row of table.rows) row.cells[index].hidden = true;
      });
      await expect(frame.getByRole("columnheader", { name: "产品名称", exact: true })).toHaveCount(0);
    } else if (change === "reordered") {
      await frame.locator('th[data-column="inventoryQty"]').dragTo(frame.locator('th[data-column="productName"]'));
      await expect.poll(() => frame.locator("thead th[data-column]").evaluateAll(cells => cells.map(cell => cell.dataset.column).indexOf("inventoryQty"))).toBe(1);
    }
    if (edited) {
      if (change === "quantity") assert.match(posted.text, /实际补货量：11(?:\n|$)/);
      else assert.doesNotMatch(posted.text, /新调减原因/);
      await edited.fill(afterValue);
      await expect(edited).toHaveValue(afterValue);
      await expect(edited).toBeFocused();
      assert.equal(await frame.locator("main.agent-root").getAttribute("data-page-reference-scope"), posted.scope,
        "this edit must exercise the unchanged-scope path before blur");
    }
    release.resolve();
    await completed.promise;
    await page.waitForTimeout(500);
    const text = await page.locator('[contenteditable="true"]').first().innerText();
    await mkdir(".runtime/reference-columns-evidence", { recursive: true });
    await writeFile(`.runtime/reference-columns-evidence/${change}.json`, JSON.stringify({ change, quotedText: posted.text, beforeScope: posted.scope, afterScope: await frame.locator("main.agent-root").getAttribute("data-page-reference-scope"), composer: text, inputValue: edited ? await edited.inputValue() : undefined, inputFocused: edited ? await edited.evaluate(input => input === document.activeElement) : undefined, errors: await page.evaluate(() => referenceErrors) }, null, 2));
    assert.equal(text.trim(), "", "obsolete visible content must not be inserted into the current question");
    await expect.poll(() => page.evaluate(() => referenceErrors.join("\n"))).toMatch(/引用已失效/);
    await page.unroute("**/api/page-interaction/reference");
    const fresh = page.waitForResponse(response => response.url().endsWith("/api/page-interaction/reference") && response.status() === 200);
    if (edited) {
      await page.keyboard.down("Alt");
      await expect(page.locator("[data-page-selection-trigger]")).toHaveAttribute("aria-pressed", "true");
      await edited.click();
      await page.keyboard.up("Alt");
    } else await quote();
    const receipt = await (await fresh).json();
    const read = await readReference(receipt.id);
    assert.match(read.text, /USER_PAGE_REFERENCE/);
    if (change === "hidden") assert.doesNotMatch(read.text, /产品名称|测试常温奶/);
    if (edited) {
      if (change === "quantity") assert.match(JSON.parse(read.text).text, /实际补货量：12(?:\n|$)/);
      else assert.match(read.text, /新调减原因/);
      await edited.fill(change === "quantity" ? "13" : "再次修改原因");
      const saved = await readReference(receipt.id);
      assert.equal(saved.text, read.text, "a completed reference remains an immutable snapshot after later input edits");
    }
  } finally {
    release.resolve();
    await page.keyboard.up("Alt");
  }
});
