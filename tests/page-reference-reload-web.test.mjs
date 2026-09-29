import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";

test("reloading the same iframe cancels a pending confirmation and reopening permits a fresh quote", {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 90000,
}, async t => {
  const { page, frame, quote, readReference } = await stockReferencePage(t, { holdMessage: "reference-committed" });
  t.after(() => page.evaluate(() => releaseReferenceMessages()).catch(() => {}));
  const saved = page.waitForResponse(response => response.url().endsWith("/api/page-interaction/reference") && response.status() === 200);
  await quote();
  const receipt = await (await saved).json();
  await expect.poll(() => page.evaluate(() => heldReferenceMessages.length)).toBe(1);
  const frameElement = page.locator('iframe[src*="/api/gea-html/inventory-fc/html"]');
  await frameElement.evaluate(iframe => {
    window.referenceReloads = 0;
    iframe.addEventListener("load", () => window.referenceReloads++);
    iframe.src = iframe.src;
  });
  await expect.poll(() => page.evaluate(() => referenceReloads)).toBe(1);
  const feedback = page.getByText("页面已重新加载，请重新选择引用。", { exact: true });
  await mkdir(".runtime/reference-reload-evidence", { recursive: true });
  await writeFile(".runtime/reference-reload-evidence/reload.json", JSON.stringify({
    saved: receipt.id, reloads: await page.evaluate(() => referenceReloads),
    heldConfirmations: await page.evaluate(() => heldReferenceMessages.length),
    composer: await page.locator('[contenteditable="true"]').first().innerText(),
    feedback: await feedback.isVisible(),
  }, null, 2));
  await expect(feedback).toBeVisible({ timeout: 6000 });
  await page.evaluate(() => releaseReferenceMessages());
  await page.getByText("AI工作台", { exact: true }).click();
  await page.getByText("分仓库存", { exact: true }).click();
  await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(300);
  assert.equal((await page.locator('[contenteditable="true"]').first().innerText()).trim(), "", "a late confirmation from the old document cannot insert a reference");
  const fresh = page.waitForResponse(response => response.url().endsWith("/api/page-interaction/reference") && response.status() === 200);
  await quote();
  const current = await (await fresh).json();
  await expect(page.locator('[contenteditable="true"]').first()).toContainText("FC001");
  assert.match((await readReference(current.id)).text, /USER_PAGE_REFERENCE/);
});

test("a confirmed capture cannot be cancelled again by Escape before its acknowledgment arrives", {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 90000,
}, async t => {
  const { page, quote } = await stockReferencePage(t, { holdMessage: ["reference-committed", "cancel-reference"] });
  t.after(() => page.evaluate(() => releaseReferenceMessages()).catch(() => {}));
  await quote();
  await expect.poll(() => page.evaluate(() => heldReferenceMessages.length)).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-page-selection-trigger]")).toHaveAttribute("aria-pressed", "false");
  const cancelled = await page.evaluate(() => heldReferenceMessages.filter(event => event.data.type === "cancel-reference").length);
  await mkdir(".runtime/reference-reload-evidence", { recursive: true });
  await writeFile(".runtime/reference-reload-evidence/accepted-escape.json", JSON.stringify({ cancelled }, null, 2));
  assert.equal(cancelled, 0, "accepted snapshots are complete; Escape exits selection without cancelling them again");
  await page.evaluate(() => releaseReferenceMessages("reference-committed"));
  await expect(page.locator('[contenteditable="true"]').first()).toContainText("FC001");
});

test("confirmation delivery has a bounded wait after the page accepts the snapshot", {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 90000,
}, async t => {
  const { page, quote } = await stockReferencePage(t, { holdMessage: ["reference-committed", "cancel-reference"] });
  t.after(() => page.evaluate(() => releaseReferenceMessages()).catch(() => {}));
  await quote();
  await expect.poll(() => page.evaluate(() => heldReferenceMessages.length)).toBe(1);
  await expect(page.getByText("引用未加入，请重试。", { exact: true })).toBeVisible({ timeout: 7000 });
  assert.equal(await page.evaluate(() => heldReferenceMessages.filter(event => event.data.type === "cancel-reference").length), 0,
    "acceptance stops the picker timer; the parent owns the delivery deadline");
  await page.evaluate(() => releaseReferenceMessages());
  await page.waitForTimeout(300);
  assert.equal((await page.locator('[contenteditable="true"]').first().innerText()).trim(), "");
});

test("a stalled final Host confirmation expires without inserting a reference", {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 90000,
}, async t => {
  const { page, quote } = await stockReferencePage(t);
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  await page.route("**/api/page-interaction/reference/confirm", async route => {
    const response = await route.fetch();
    reached.resolve(response.status());
    await release.promise;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await quote();
    assert.equal(await reached.promise, 200);
    await expect(page.getByText("引用未加入，请重试。", { exact: true })).toBeVisible({ timeout: 7000 });
    release.resolve();
    await page.waitForTimeout(300);
    assert.equal((await page.locator('[contenteditable="true"]').first().innerText()).trim(), "");
  } finally { release.resolve(); }
});
