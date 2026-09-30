import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

test("native approval waits for the parent identity projection before requesting business status", {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 90000,
}, async t => {
  const app = await profile(t);
  await app.login();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1536, height: 920 } });
  await context.addCookies(app.cookie.split("; ").map(pair => ({ name: pair.slice(0, pair.indexOf("=")), value: pair.slice(pair.indexOf("=") + 1), url: app.origin })));
  await context.addInitScript(() => {
    if (window.parent === window) return;
    window.heldIdentitySnapshots = [];
    let hold = true;
    addEventListener("message", event => {
      if (!hold || event.origin !== location.origin || event.source !== parent || event.data?.type !== "gea:identity-snapshot") return;
      event.stopImmediatePropagation();
      window.heldIdentitySnapshots.push(event.data);
    }, true);
    window.releaseIdentitySnapshots = () => {
      hold = false;
      for (const data of window.heldIdentitySnapshots.splice(0)) dispatchEvent(new MessageEvent("message", { data, origin: location.origin, source: parent }));
    };
  });
  const page = await context.newPage();
  const requests = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/gea-proof/status") && request.frame().url().includes("/api/gea-proof/workbench")) requests.push(request);
  });
  await page.goto(app.origin);
  await page.getByRole("dialog", { name: /内测声明|预览版说明/ }).getByRole("button", { name: "继续", exact: true }).click();
  const frame = page.frameLocator("iframe[data-gea-workbench]");
  await expect.poll(() => frame.locator("body").evaluate(() => window.heldIdentitySnapshots?.length ?? 0)).toBeGreaterThan(0);
  assert.equal(requests.length, 0, "an unconfirmed iframe must not start a cancellable Host status refresh");
  await frame.locator("body").evaluate(() => window.releaseIdentitySnapshots());
  await expect(frame.getByRole("heading", { name: "销售计划审批", exact: true })).toBeVisible();
  assert.equal(requests.length, 1, "one confirmed scope needs one business status request");
});
