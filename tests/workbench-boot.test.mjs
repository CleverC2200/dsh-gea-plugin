import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { profile } from "./profile.mjs";
test(
  "published DSH loads the replacement workbench",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t);
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    t.after(() => browser.close());
    const context = await browser.newContext({ locale: "zh-CN" });
    await context.addCookies(
      app.cookie
        .split("; ")
        .map((pair) => ({
          name: pair.slice(0, pair.indexOf("=")),
          value: pair.slice(pair.indexOf("=") + 1),
          url: app.origin,
        })),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(app.origin);
    try {
      await page
        .getByRole("dialog", { name: "内测声明", exact: true })
        .waitFor({ timeout: 12000 });
    } catch {
      throw new Error(
        JSON.stringify({
          errors,
          body: (await page.locator("body").innerText()).slice(0, 4000),
          log: app.output.slice(-4000),
        }),
      );
    }
    const entries = await page.evaluate(() =>
      window.__DSH_BOOT__.entries.map((row) => row.id),
    );
    assert.ok(entries.includes("@cleverc2200/dsh-agent-workbench"));
    assert.ok(!entries.includes("@deepseek-ai/dsh-client-ui-layout"));
    assert.deepEqual(errors, []);
  },
);
