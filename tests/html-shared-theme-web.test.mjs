import {
  prepareWorkbenchHtmlRoots,
  htmlFrameElement,
  openBusinessPage,
  openWorkbenchPage,
} from "./fixtures/business-page.mjs";
/** Real profile/iframe acceptance; the table itself is a workbench-owned local sample. */
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readProfileSources } from "./fixtures/profile-inputs.mjs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { changeThemeSetting } from "./theme-settings.mjs";

const output = new URL("../.runtime/html-theme-evidence/", import.meta.url);
test(
  "workbench HTML sample shares theme inside the restricted iframe",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 120000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "workbench-html-sample-"));
    const sources = await readProfileSources(process.env.GEA_TEST_SOURCE_INPUTS);
    const workbench = sources.find((source) => source.repo === "dsh-agent-workbench");
    const sample = await readFile(
      resolve(workbench.assetRoot, "lib/samples/html-table.html"),
      "utf8",
    );
    await writeFile(join(root, "index.html"), sample);
    // Temporary verification material consumed by the existing loader, never a shipped plugin.
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "inventory-customer",
        name: "项目清单样板",
        version: "0.0.0",
        mode: "mock",
        html: "index.html",
      }),
    );
    const app = await profile(t, { beforeStart: prepareWorkbenchHtmlRoots([root]) });
    t.after(async () => {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    });
    try {
      await app.login();
    } catch (error) {
      await writeFile(new URL("../.runtime/unified-sample-start.log", import.meta.url), app.output);
      throw error;
    }
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1440, height: 900 },
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
    await mkdir(output, { recursive: true });
    let htmlResponse;
    page.on("response", (response) => {
      if (response.url().includes("/api/agent-workbench/html?id=inventory-customer"))
        htmlResponse = response;
    });
    try {
      await page.goto(app.origin);
      await page
        .getByRole("dialog", { name: /内测声明|预览版说明/ })
        .getByRole("button", { name: "继续", exact: true })
        .click();
      await openBusinessPage(page, "inventory-customer");
      // The shipped sample is static; use the public Core conversation action for draft checks.
      await page
        .locator(".agent-workbench-document")
        .getByRole("button", { name: "新建对话", exact: true })
        .click();
      await expect(page.locator('[contenteditable="true"], textarea').first()).toBeVisible();
      const iframe = htmlFrameElement(page, "inventory-customer");
      const frame = iframe.contentFrame();
      await expect(frame.getByRole("heading", { name: "项目交付清单" })).toBeVisible();
      await expect(frame.locator("#summary")).toHaveText("共 4 个项目");
      const sidebarPreferenceWidth = await page
        .getByRole("complementary", { name: "业务导航", exact: true })
        .evaluate((el) => Math.round(el.getBoundingClientRect().width));
      assert.equal(
        htmlResponse.headers()["content-security-policy"],
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
      );
      await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-downloads");
      const sandbox = await iframe.getAttribute("sandbox");
      const child = page
        .frames()
        .find((f) => f.url().includes("/api/agent-workbench/html?id=inventory-customer"));
      assert.equal(
        await child.evaluate(() => {
          try {
            return !!parent.document;
          } catch {
            return false;
          }
        }),
        false,
      );
      assert.equal(
        await child.evaluate(async () => {
          try {
            await fetch("/api/gea-html/plugins");
            return true;
          } catch {
            return false;
          }
        }),
        false,
      );
      await frame.getByLabel("项目名称").fill("页面");
      const loading = await frame
        .getByRole("button", { name: "查询", exact: true })
        .evaluate((button) => {
          button.click();
          return document.querySelector("#results").getAttribute("aria-busy");
        });
      assert.equal(loading, "true", "submitting immediately enters the loading state");
      await expect(frame.locator("#summary")).toHaveText("共 1 个项目");
      await expect(frame.locator("tbody tr")).toHaveCount(1);
      await frame.getByLabel("项目名称").fill("归档");
      await frame.getByLabel("项目名称").press("Enter");
      await expect(frame.locator("tbody")).toContainText("月度资料归档");
      await frame.getByRole("button", { name: "重置", exact: true }).click();
      await frame.getByLabel("交付进度").selectOption("已完成");
      await frame.getByRole("button", { name: "查询", exact: true }).click();
      await expect(frame.locator("tbody")).toContainText("月度资料归档");
      await frame.getByRole("button", { name: "重置", exact: true }).click();
      await expect(frame.locator("#summary")).toHaveText("共 4 个项目");
      await frame.getByText("演示状态", { exact: true }).click();
      await frame.getByRole("button", { name: "演示空结果" }).click();
      await expect(frame.getByText("没有匹配的项目")).toBeVisible();
      await frame.getByRole("button", { name: "演示查询失败" }).click();
      await expect(frame.getByText("暂时无法读取项目")).toBeVisible();
      await page.screenshot({ path: fileURLToPath(new URL("error.png", output)), fullPage: true });
      await frame.getByRole("button", { name: "重新查询" }).click();
      await expect(frame.locator("#summary")).toHaveText("共 4 个项目");
      const settings = async () => {
        await page.getByRole("button", { name: "账户菜单", exact: true }).click();
        await page.getByRole("menuitem", { name: "设置", exact: true }).click();
        await page.getByRole("button", { name: "通用设置", exact: true }).click();
      };
      const samples = [];
      for (const [label, size, color] of [
        ["浅色", 14, "rgb(247, 248, 250)"],
        ["深色", 17, "rgb(27, 29, 33)"],
      ]) {
        await settings();
        if (label === "深色") {
          await changeThemeSetting(page, label, "preference");
          for (let n = 14; n < size; n++) await changeThemeSetting(page, "增大字号", "fontSize");
        } else await page.getByRole("button", { name: label, exact: true }).click();
        await page.getByRole("button", { name: "关闭", exact: true }).click();
        await expect(frame.locator("body")).toHaveCSS("background-color", color);
        await expect(frame.locator("body")).toHaveCSS("font-size", size + "px");
        await expect(page.locator(".agent-workbench-document")).toHaveCSS("font-size", size + "px");
        await expect
          .poll(() =>
            page
              .locator("body")
              .evaluate((element) =>
                getComputedStyle(element).getPropertyValue("--dsh-content-font-size").trim(),
              ),
          )
          .toBe(size + "px");
        await expect(page.locator("body")).toHaveCSS(
          "background-color",
          label === "深色" ? "rgb(21, 21, 23)" : "rgb(255, 255, 255)",
        );
        const surface = label === "深色" ? "rgb(36, 38, 43)" : "rgb(255, 255, 255)";
        const bodyText = label === "深色" ? "rgb(199, 205, 214)" : "rgb(85, 93, 104)";
        for (const selector of [
          ".gea-agent-welcome",
          ".gea-agent-intro",
          ".gea-agent-prompts button",
        ]) {
          for (const element of await page.locator(selector).all()) {
            await expect(element).toHaveCSS("background-color", surface);
            // The container carries primary text; description and suggestion text consume body typography.
            await expect(element).toHaveCSS(
              "color",
              selector === ".gea-agent-welcome"
                ? label === "深色"
                  ? "rgb(237, 240, 245)"
                  : "rgb(32, 35, 42)"
                : bodyText,
            );
          }
        }
        await expect(page.locator(".gea-agent-welcome")).toHaveCSS("background-image", "none");
        await expect(page.locator(".gea-agent-identity h2")).toHaveCSS(
          "color",
          label === "深色" ? "rgb(237, 240, 245)" : "rgb(32, 35, 42)",
        );
        const welcomeCanvas = await page
          .locator(".gea-agent-welcome")
          .evaluate(
            (el) =>
              getComputedStyle(el.closest(".agent-workbench-native-conversation")).backgroundColor,
          );
        assert.equal(
          welcomeCanvas,
          surface,
          "the entire conversation canvas must follow its theme",
        );
        const suggestion = page.locator(".gea-agent-prompts button").first();
        await suggestion.hover();
        await expect(suggestion).toHaveCSS(
          "background-color",
          label === "深色" ? "rgb(53, 39, 46)" : "rgb(255, 250, 251)",
        );
        await suggestion.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(suggestion).toBeFocused();
        await expect(suggestion).toHaveCSS("outline-width", "2px");
        const promptText = await suggestion.innerText();
        await suggestion.click();
        const composer = page.locator('[contenteditable="true"], textarea').first();
        await expect(composer).toHaveText(promptText);
        await composer.fill("");
        await page.mouse.move(0, 0);
        await frame.getByLabel("项目名称").focus();
        await page.keyboard.press("Tab");
        await expect(frame.getByLabel("交付进度")).toBeFocused();
        await expect(frame.getByLabel("交付进度")).toHaveCSS("outline-width", "2px");
        await expect(frame.getByLabel("交付进度")).toHaveCSS("outline-style", "solid");
        const placeholder = await frame.getByLabel("项目名称").evaluate((el) => {
          const luminance = (color) => {
            const channels = color
              .match(/[\d.]+/g)
              .slice(0, 3)
              .map(Number)
              .map((value) => {
                const channel = value / 255;
                return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
              });
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
          };
          const style = getComputedStyle(el, "::placeholder");
          const background = getComputedStyle(el).backgroundColor;
          const levels = [luminance(style.color), luminance(background)].sort((a, b) => b - a);
          return {
            color: style.color,
            background,
            opacity: style.opacity,
            contrast: (levels[0] + 0.05) / (levels[1] + 0.05),
          };
        });
        assert.equal(placeholder.opacity, "1");
        assert.ok(placeholder.contrast >= 4.5, "placeholder must remain readable in each theme");
        samples.push({
          label,
          size,
          background: color,
          placeholder,
          focus: await frame
            .getByLabel("交付进度")
            .evaluate((el) => getComputedStyle(el).outlineColor),
        });
        await page.screenshot({
          path: fileURLToPath(new URL(label === "深色" ? "dark.png" : "light.png", output)),
          fullPage: true,
        });
      }
      // Theme switches must also restore the same mounted welcome, without a reload.
      await settings();
      await changeThemeSetting(page, "浅色", "preference");
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(page.locator(".gea-agent-welcome")).toHaveCSS(
        "background-color",
        "rgb(255, 255, 255)",
      );
      await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(247, 248, 250)");
      await page.screenshot({
        path: fileURLToPath(new URL("restored-light.png", output)),
        fullPage: true,
      });
      await settings();
      await changeThemeSetting(page, "深色", "preference");
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(page.locator(".gea-agent-welcome")).toHaveCSS(
        "background-color",
        "rgb(36, 38, 43)",
      );
      await page.setViewportSize({ width: 720, height: 900 });
      await expect(frame.getByRole("button", { name: "查询", exact: true })).toBeVisible();
      // AppFrame commits its ResizeObserver measurement on the next animation frame.
      await expect
        .poll(() =>
          child.evaluate(
            () => innerWidth > 0 && document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      const dimensions = await child.evaluate(() => ({
        width: innerWidth,
        document: document.documentElement.scrollWidth,
        table: document.querySelector(".table-scroll").scrollWidth,
        region: document.querySelector(".table-scroll").clientWidth,
      }));
      assert.equal(dimensions.document, dimensions.width, "only the table may scroll horizontally");
      await page.screenshot({
        path: fileURLToPath(new URL("narrow-top.png", output)),
        fullPage: true,
      });
      await frame.locator("#table-region").scrollIntoViewIfNeeded();
      await expect(frame.locator("tbody tr").last()).toBeVisible();
      await page.screenshot({ path: fileURLToPath(new URL("narrow.png", output)), fullPage: true });
      const narrowSuggestion = page.locator(".gea-agent-prompts button").last();
      await narrowSuggestion.scrollIntoViewIfNeeded();
      await expect(narrowSuggestion).toBeInViewport();
      const narrowPrompt = await narrowSuggestion.innerText();
      await narrowSuggestion.click();
      const narrowComposer = page.locator('[contenteditable="true"], textarea').first();
      await expect(narrowComposer).toHaveText(narrowPrompt);
      await expect(narrowComposer).toBeInViewport();
      await page.screenshot({
        path: fileURLToPath(new URL("narrow-right.png", output)),
        fullPage: true,
      });
      await page.getByRole("button", { name: "中间区域最大，隐藏会话区", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 900 });
      await child.evaluate(() => {
        scrollTo(0, 0);
        document.querySelector(".table-scroll").scrollLeft = 0;
      });
      await expect(frame.getByRole("button", { name: "查询", exact: true })).toBeVisible();
      assert.equal(
        await child.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      // The shared layout stacks at 720px; the smaller page exercises real table overflow.
      await expect
        .poll(() =>
          child.evaluate(
            () =>
              innerWidth > 0 &&
              document.querySelector(".table-scroll").scrollWidth >
                document.querySelector(".table-scroll").clientWidth,
          ),
        )
        .toBe(true);
      await frame.locator(".table-scroll").evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      await expect
        .poll(() => frame.locator(".table-scroll").evaluate((el) => el.scrollLeft))
        .toBeGreaterThan(0);

      await page.screenshot({ path: fileURLToPath(new URL("mobile.png", output)), fullPage: true });
      await child.evaluate(() => {
        window.retainedPageMarker = "same-frame";
      });
      const retainedValue = await frame.getByLabel("项目名称").inputValue();
      await page.getByRole("button", { name: "会话区最大，隐藏中间区域", exact: true }).click();
      await expect(iframe).toBeHidden();
      await expect(page.locator(".gea-agent-welcome")).toBeVisible();
      assert.equal(await child.evaluate(() => window.retainedPageMarker), "same-frame");
      await page.getByRole("button", { name: "同时显示中间区域和会话区", exact: true }).click();
      await expect(iframe).toBeVisible();
      assert.equal(await child.evaluate(() => window.retainedPageMarker), "same-frame");
      assert.equal(await frame.getByLabel("项目名称").inputValue(), retainedValue);
      assert.equal(
        await page.locator(".gea-agent-welcome").count(),
        1,
        "one Conversation is mounted",
      );
      await page.getByRole("button", { name: "中间区域最大，隐藏会话区", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "同时显示中间区域和会话区", exact: true }),
      ).toBeVisible();
      // Parent DOM edits are not theme authority; the public snapshot owns updates.
      await page.evaluate(() =>
        document.body.style.setProperty("--workbench-theme-version", '"2.0.0"'),
      );
      await expect(frame.locator("#summary")).toHaveText("共 4 个项目");
      await expect(frame.getByRole("alert")).toBeHidden();
      await page.evaluate(() => document.body.style.removeProperty("--workbench-theme-version"));
      // The fixed iframe resource also refuses a damaged assembled sample.
      await writeFile(
        join(root, "index.html"),
        sample.replace(/<style data-workbench-resource="1.1.1">[\s\S]*?<\/style>/, ""),
      );
      await child.goto(child.url());
      await expect(frame.getByRole("alert")).toContainText("共享样式资源缺失");
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect
        .poll(() =>
          page
            .getByRole("complementary", { name: "业务导航", exact: true })
            .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
        )
        .toBe(sidebarPreferenceWidth);

      await page
        .getByRole("complementary", { name: "业务导航", exact: true })
        .getByRole("button", { name: "新会话", exact: true })
        .filter({ hasText: "AI工作台" })
        .click();
      const nativeComposer = page.locator('[contenteditable="true"], textarea').first();
      await page.getByRole("button", { name: /^选择模型，当前/ }).click();
      await page.getByRole("menuitem", { name: /^模型/ }).click();
      await page.getByRole("menuitemradio", { name: /Local receipt \/ 本地验证回执/ }).click();
      await nativeComposer.fill("日志返回会话与栏宽验收");
      await nativeComposer.press("Enter");
      await expect(
        page.getByText("本地验证回执（非 AI 分析）：业务资料已进入会话。", { exact: true }),
      ).toBeVisible();
      await page.keyboard.press("ControlOrMeta+Shift+B");
      const nativeRightbar = page.locator("[data-sidebar-right-panel]");
      await expect(nativeRightbar).toBeVisible();
      const exitFullscreen = nativeRightbar.locator('[data-sidebar-right-mode="push"]');
      if (await exitFullscreen.isVisible()) await exitFullscreen.click();
      await expect(nativeRightbar).toBeVisible();
      const nativeSessionId = await nativeRightbar.getAttribute("data-sidebar-right-session");
      assert.match(nativeSessionId, /^session-/);
      const nativeRightbarWidth = await nativeRightbar.evaluate((el) =>
        Math.round(el.getBoundingClientRect().width),
      );
      await expect(page.locator('[data-side="rightbar"]')).toBeVisible();
      await openWorkbenchPage(page, "接口日志");
      await expect(page.getByRole("heading", { name: "接口日志中心", exact: true })).toBeVisible();
      const navigation = page.getByRole("complementary", { name: "业务导航", exact: true });
      await expect(navigation).toBeVisible();
      const navigationBox = await navigation.boundingBox();
      const logBox = await page.locator(".gea-api-log-center").boundingBox();
      assert.ok(
        logBox && navigationBox && logBox.x >= navigationBox.x + navigationBox.width - 1,
        "the current main page fits its Core seat without covering company navigation",
      );
      await expect
        .poll(() =>
          navigation.evaluate((element) => Math.round(element.getBoundingClientRect().width)),
        )
        .toBe(sidebarPreferenceWidth);
      await expect(nativeRightbar).toBeHidden();
      await expect(page.locator('[data-side="rightbar"]')).toHaveCount(0);
      const history = page.getByRole("button", { name: "历史会话", exact: true });
      if ((await history.getAttribute("aria-expanded")) !== "true") await history.click();
      await page
        .getByRole("complementary", { name: "业务导航", exact: true })
        .getByText("日志返回会话与栏宽验收", { exact: true })
        .click();
      await expect(nativeRightbar).toBeVisible();
      await expect(nativeRightbar).toHaveAttribute("data-sidebar-right-session", nativeSessionId);
      await expect
        .poll(() => nativeRightbar.evaluate((el) => Math.round(el.getBoundingClientRect().width)))
        .toBe(nativeRightbarWidth);
      await expect(page.locator('[data-side="rightbar"]')).toBeVisible();
      const restoredHandle = await page.locator('[data-side="rightbar"]').boundingBox();
      await page.mouse.move(restoredHandle.x + restoredHandle.width / 2, restoredHandle.y + 60);
      await page.mouse.down();
      await page.mouse.move(restoredHandle.x - 20, restoredHandle.y + 60, { steps: 3 });
      await page.mouse.up();
      await expect
        .poll(() => nativeRightbar.evaluate((el) => Math.round(el.getBoundingClientRect().width)))
        .not.toBe(nativeRightbarWidth);

      assert.deepEqual(errors, []);
      await writeFile(
        new URL("observations.json", output),
        JSON.stringify({ samples, dimensions, sandbox, errors }, null, 2),
      );
    } catch (error) {
      await page.screenshot({
        path: fileURLToPath(new URL("failure.png", output)),
        fullPage: true,
      });
      await writeFile(new URL("failure.txt", output), await page.locator("body").innerText());
      throw error;
    }
  },
);
