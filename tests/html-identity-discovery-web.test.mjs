import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

test("a stalled initial identity request cannot block HTML page discovery", {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 90000,
}, async t => {
  const app = await profile(t, { env: { GEA_HTML_PLUGIN_ROOTS: JSON.stringify([resolve("../dsh-agent-workbench/lib/business/inventory-fc")]) } });
  await app.login();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: "zh-CN" });
  await context.addCookies(app.cookie.split("; ").map(pair => ({ name: pair.slice(0, pair.indexOf("=")), value: pair.slice(pair.indexOf("=") + 1), url: app.origin })));
  const page = await context.newPage();
  const release = Promise.withResolvers();
  let held = 0, aborted = 0, discoveries = 0;
  page.on("request", request => { if (request.url().endsWith("/api/gea-html/plugins")) discoveries++; });
  page.on("requestfailed", request => { if (request.url().endsWith("/api/gea-html/identity")) aborted++; });
  await page.route("**/api/gea-html/identity", async route => {
    held++;
    await release.promise;
    await route.abort().catch(() => {});
  });
  try {
    await page.goto(app.origin);
    await page.getByRole("dialog", { name: /内测声明|预览版说明/ }).getByRole("button", { name: "继续", exact: true }).click();
    await expect.poll(() => held).toBeGreaterThan(0);
    const headers = { Cookie: app.cookie, "Content-Type": "application/json" };
    const available = {
      status: await (await fetch(app.origin + "/api/gea-proof/status", { method: "POST", headers, body: "{}" })).json(),
      plugins: await (await fetch(app.origin + "/api/gea-html/plugins", { headers })).json(),
    };
    assert.equal(available.status.ok, true);
    assert.ok(available.plugins.some(plugin => plugin.id === "inventory-fc"));
    try {
      await expect.poll(() => discoveries, { timeout: 7000 }).toBeGreaterThan(0);
      await expect.poll(() => aborted, { timeout: 7000 }).toBeGreaterThan(0);
    } finally {
      await mkdir(".runtime/review-08-evidence", { recursive: true });
      await writeFile(".runtime/review-08-evidence/identity-discovery.json", JSON.stringify({ held, aborted, discoveries, statusAvailable: available.status.ok, catalogContainsBranch: true, registeredEntries: await page.locator('[data-gea-business-entry="inventory-fc"]').count() }, null, 2));
    }
  } finally { release.resolve(); }
});
