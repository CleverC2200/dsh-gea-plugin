/** Real source composition: settings, native conversation and shared shell. */
import { fileURLToPath } from "node:url";
import { changeThemeSetting } from "./theme-settings.mjs";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

const baseline = process.env.THEME_BASELINE === "1";
const output = new URL("../.runtime/theme-evidence/", import.meta.url);
test(
  "shared theme follows settings and survives stylesheet reorder and refresh",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 120000,
  },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        analysis: {
          mode: "model",
          source: "direct",
          baseUrl: base + "/v1",
          model: "fixture",
          apiKeyEnv: "GEA_THEME_TEST_KEY",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: { GEA_THEME_TEST_KEY: "fixture-only" },
    });
    let calls = 0;
    app.route((req, res) => {
      if (req.url.pathname !== "/v1/chat/completions") return false;
      calls++;
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            choices: [{ index: 0, delta: { content: "主题验收回复" }, finish_reason: "stop" }],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return true;
    });
    await app.login();
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1280, height: 900 },
    });
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: /内测声明|预览版说明/ })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    const composer = page.locator('[contenteditable="true"], textarea').first();
    await composer.fill("检查主题，不查询业务数据");
    await composer.press("Enter");
    await expect(page.getByText("主题验收回复", { exact: true })).toBeVisible();
    await mkdir(output, { recursive: true });
    const settings = async () => {
      await page.getByRole("button", { name: "账户菜单", exact: true }).click();
      await page.getByRole("menuitem", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "通用设置", exact: true }).click();
    };
    const sample = () =>
      page.evaluate(() => {
        const read = (selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const s = getComputedStyle(el);
          return {
            background: s.backgroundColor,
            color: s.color,
            fontSize: s.fontSize,
            fontFamily: s.fontFamily,
            outlineColor: s.outlineColor,
            outlineStyle: s.outlineStyle,
          };
        };
        return {
          body: read("body"),
          shell: read(".AppFrame_frame"),
          composer: read('[contenteditable="true"], textarea'),
          card: read('[data-slot="conversation.composer.bar"]'),
          dark: document.body.hasAttribute("data-ds-dark-theme"),
          source: document.documentElement.dataset.dsThemeSource,
          axis: document.body.style.getPropertyValue("--dsh-content-font-size"),
          version: getComputedStyle(document.body)
            .getPropertyValue("--workbench-theme-version")
            .trim(),
          focus: (() => {
            const s = getComputedStyle(document.activeElement);
            return { color: s.outlineColor, style: s.outlineStyle, width: s.outlineWidth };
          })(),
          menu: read(".gea-shell-nav-heading"),
          metas: document.querySelectorAll('meta[name="theme-color"]').length,
        };
      });
    const samples = [];
    for (const [label, size] of [
      ["浅色", 14],
      ["深色", 17],
    ]) {
      await settings();
      if (label === "深色") await changeThemeSetting(page, label, "preference");
      else await page.getByRole("button", { name: label, exact: true }).click();
      for (let n = 14; n < size; n++) await changeThemeSetting(page, "增大字号", "fontSize");
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await expect.poll(async () => (await sample()).axis).toBe(`${size}px`);
      await composer.fill("输入框字号与焦点验收");
      await expect(composer).toBeFocused();
      await composer.press("Tab");
      await composer.press("Shift+Tab");
      const value = await sample();
      samples.push({ label, ...value });
      if (!baseline) {
        assert.equal(value.version, '"1.1.1"');
        assert.equal(value.composer.fontSize, `${size}px`);
        assert.equal(value.shell.fontSize, `${size}px`);
        assert.equal(
          value.body.background,
          label === "深色" ? "rgb(27, 29, 33)" : "rgb(247, 248, 250)",
        );
        assert.equal(value.source, label === "深色" ? "dark" : "light");
        assert.equal(value.metas, 1);
        assert.notEqual(value.focus.style, "none");
        assert.equal(value.focus.width, "2px");
        assert.equal(
          value.focus.color,
          label === "深色" ? "rgb(255, 128, 146)" : "rgb(223, 23, 50)",
        );
        assert.equal(value.menu.color, label === "深色" ? "rgb(237, 240, 245)" : "rgb(32, 35, 42)");
      }
      await page.screenshot({
        path: fileURLToPath(new URL(`${baseline ? "before" : "after"}-${size}.png`, output)),
        fullPage: true,
      });
      // Reinsert the shared sheet first and the upstream base sheet last.
      await page.evaluate(() => {
        const shared = document.querySelector('style[data-plugin-css$="/workbench-theme.css"]');
        if (shared) document.head.prepend(shared);
        const base = document.querySelector('style[data-plugin-css$="/design-platform.css"]');
        if (base) document.head.append(base);
      });
      assert.deepEqual(
        await sample(),
        value,
        "stylesheet loading order must not change computed theme",
      );
    }
    await composer.fill("");
    await page.reload();
    await expect.poll(async () => (await sample()).axis).toBe("17px");
    assert.equal((await sample()).dark, true);
    // GEA may land on its default page; reopen the persisted conversation through history.
    if (!(await page.getByText("主题验收回复", { exact: true }).isVisible())) {
      await page.getByRole("button", { name: "历史会话", exact: true }).click();
      await page.getByText("检查主题，不查询业务数据", { exact: true }).first().click();
    }
    await expect(page.getByText("主题验收回复", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 720, height: 900 });
    await expect(composer).toBeVisible();
    await composer.fill("窄屏仍可输入");
    await page.screenshot({
      path: fileURLToPath(new URL(`${baseline ? "before" : "after"}-narrow.png`, output)),
      fullPage: true,
    });
    assert.equal(calls, 1);
    assert.deepEqual(errors, []);
    await writeFile(
      new URL(`${baseline ? "before" : "after"}.json`, output),
      JSON.stringify(samples, null, 2),
    );
  },
);
