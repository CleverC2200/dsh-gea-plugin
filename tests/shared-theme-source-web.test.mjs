import { testBrowser } from "./fixtures/test-browser.mjs";
/** Real source composition: settings, native conversation and shared shell. */
import { fileURLToPath } from "node:url";
import { changeThemeSetting } from "./theme-settings.mjs";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { prepareCoreDocuments } from "./fixtures/core-documents.mjs";

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
      beforeStart: prepareCoreDocuments(),
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
    const browser = await testBrowser(t, () =>
      chromium.launch({ channel: "chrome", headless: true }),
    );

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
    await expect(page.getByRole("dialog", { name: /内测声明|预览版说明/ })).toHaveCount(0);
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
          const el = typeof selector === "string" ? document.querySelector(selector) : selector;
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
          main: read('[data-slot="main.conversation"] [data-phase]'),
          shell: read(document.querySelector("[data-rightbar-col]")?.parentElement),
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
            const ring = s.boxShadow.match(/^(rgba?\([^)]+\)) 0px 0px 0px (\d+(?:\.\d+)?px)$/);
            return {
              color: ring?.[1],
              style: s.boxShadow === "none" ? "none" : "box-shadow",
              width: ring?.[2],
            };
          })(),
          menu: read('.gea-sidebar-tab[aria-controls="gea-panel-function"]'),
          workbenchPage: getComputedStyle(document.body)
            .getPropertyValue("--workbench-page")
            .trim(),
          workbenchText: getComputedStyle(document.body)
            .getPropertyValue("--workbench-text")
            .trim(),
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
      // Sample the declared Core model control, rather than relying on the preceding tab-order item.
      const focusControl = page.locator('[data-slot="conversation.input.model"] button').first();
      await page.keyboard.press("Tab");
      await focusControl.focus();
      await expect(focusControl).toBeFocused();
      const value = await sample();
      samples.push({ label, ...value });
      if (!baseline) {
        assert.equal(value.version, '"1.1.1"');
        assert.equal(value.composer.fontSize, `${size}px`);
        assert.equal(value.shell.fontSize, value.body.fontSize, "Core owns the shell base font");
        assert.equal(value.shell.background, value.body.background);
        assert.equal(
          value.main.background,
          value.body.background,
          "Native content consumes the Core palette",
        );
        assert.equal(value.workbenchPage, label === "深色" ? "#1b1d21" : "#f7f8fa");
        assert.equal(value.workbenchText, label === "深色" ? "#edf0f5" : "#20232a");
        assert.equal(
          value.body.background,
          label === "深色" ? "rgb(21, 21, 23)" : "rgb(255, 255, 255)",
        );
        assert.equal(value.source, label === "深色" ? "dark" : "light");
        assert.equal(value.metas, 1);
        assert.notEqual(value.focus.style, "none");
        assert.equal(value.focus.width, "2px");
        assert.equal(
          value.focus.color,
          label === "深色" ? "rgb(122, 170, 255)" : "rgb(65, 118, 230)",
        );
        assert.equal(value.menu.color, label === "深色" ? "rgb(237, 240, 245)" : "rgb(32, 35, 42)");
      }
      await page.screenshot({
        path: fileURLToPath(new URL(`${baseline ? "before" : "after"}-${size}.png`, output)),
        fullPage: true,
      });
      // Reinsert the shared sheet first and the upstream base sheet last.
      await page.evaluate(() => {
        const shared = document.querySelector('style[data-agent-workbench-theme="1.1.1"]');
        if (!shared) throw Error("Shared theme stylesheet is missing");
        document.head.prepend(shared);
        const base = document.querySelector('style[data-plugin-css$="/design-platform.css"]');
        if (!base) throw Error("Core base stylesheet is missing");
        document.head.append(base);
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
      const history = page.getByRole("button", { name: "工作台", exact: true });
      if ((await history.getAttribute("aria-expanded")) !== "true") await history.click();
      await page
        .getByRole("complementary", { name: "业务导航", exact: true })
        .getByText("检查主题，不查询业务数据", { exact: true })
        .click();
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
