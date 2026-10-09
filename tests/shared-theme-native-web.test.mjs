/** Native DSH profile proves theme resources do not depend on company plugins. */
import { profile } from "./profile.mjs";
import { changeThemeSetting } from "./theme-settings.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

test(
  "native profile consumes shared theme without loading workbench",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 90000,
  },
  async (t) => {
    const app = await profile(t, { coreOnly: true });
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.context().addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: /内测声明|预览版说明/ })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    const setup = page.getByRole("button", { name: "稍后配置", exact: true });
    const addKey = page.getByRole("button", { name: "添加 API Key", exact: true });
    const deferSetup = async () => {
      await setup.or(addKey).first().waitFor({ state: "visible" });
      if (await addKey.isVisible()) await addKey.click();
      await setup.click();
    };
    await deferSetup();
    await expect(
      page.locator(
        'style[data-plugin-css$="/workbench-theme.css"],style[data-agent-workbench-theme]',
      ),
    ).toHaveCount(0);
    await expect(page.locator(".gea-agent-welcome, .gea-company-main")).toHaveCount(0);
    const resources = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((x) => x.name),
    );
    assert.equal(
      resources.some((x) => x.includes("dsh-agent-workbench")),
      false,
    );
    const composer = page.locator('[contenteditable="true"]').first();
    await expect(composer).toBeVisible();
    await composer.fill("独立原生输入验收");
    await mkdir(".runtime/theme-evidence", { recursive: true });
    await page.screenshot({ path: ".runtime/theme-evidence/native-light.png", fullPage: true });
    const buttons = await page.getByRole("button").evaluateAll((nodes) =>
      nodes.map((n) => ({
        text: n.textContent,
        label: n.getAttribute("aria-label"),
        title: n.getAttribute("title"),
      })),
    );
    await mkdir(".runtime/theme-evidence", { recursive: true });
    await writeFile(
      ".runtime/theme-evidence/native-buttons.json",
      JSON.stringify(buttons, null, 2),
    );
    await page
      .getByRole("button", { name: /设置|Settings/ })
      .first()
      .click();
    await page.getByRole("button", { name: "通用设置", exact: true }).click();
    await changeThemeSetting(page, "深色", "preference");
    await changeThemeSetting(page, "增大字号", "fontSize");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(composer).toHaveCSS("font-size", "15px");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(21, 21, 23)");
    await page.reload();
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(21, 21, 23)");
    await expect(composer).toHaveCSS("font-size", "15px");
    // An unconfigured Core may offer setup again after reload; defer through its current public UI.
    await deferSetup();
    await expect(setup).toHaveCount(0);
    await page.screenshot({ path: ".runtime/theme-evidence/native-dark.png", fullPage: true });
    assert.deepEqual(errors, []);
  },
);
