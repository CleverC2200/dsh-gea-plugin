import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { serializeReference } from "../packages/page-interaction/src/reference.ts";

test("display projection covers pending and queue messages, and restores native text nodes on unload", async (t) => {
  const bundle = await build({
    entryPoints: ["packages/page-interaction/src/reference-display.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "PageReferenceDisplay",
    platform: "browser",
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<div data-chat-flow-kind="user"><span id="sent"></span></div><div data-submission-echo><span id="pending"></span></div><div data-queue-dock><span id="queued"></span></div>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const label = "销售计划 · 客户[直营]/50%";
  const wire = serializeReference({ id: "R123456abcdef", label }) + "分析这些";
  await page.evaluate((text) => {
    for (const id of ["sent", "pending", "queued"])
      document.getElementById(id).textContent = text;
    window.disposeReferences = PageReferenceDisplay.mountReferenceDisplay();
  }, wire);
  for (const id of ["sent", "pending", "queued"])
    await expect(page.locator("#" + id)).toHaveText(label + " 分析这些");
  assert.equal(
    await page.evaluate(() => CSS.highlights.get("dsh-page-reference").size),
    3,
  );
  const next =
    serializeReference({ id: "Rabcdef123456", label: "库存 · 新范围" }) +
    "比较";
  await page.evaluate((text) => {
    document.getElementById("sent").firstChild.data = text;
  }, next);
  await expect(page.locator("#sent")).toHaveText("库存 · 新范围 比较");
  await page.evaluate(() => window.disposeReferences());
  await expect(page.locator("#sent")).toHaveText(next);
  await expect(page.locator("#queued")).toHaveText(wire);
});
