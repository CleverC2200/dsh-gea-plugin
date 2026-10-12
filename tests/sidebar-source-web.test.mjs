import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

test(
  "source sidebar mounts native tabs and saves a workspace file across refresh",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 90000,
  },
  async (t) => {
    const shellHome = await mkdtemp(join(tmpdir(), "gea-sidebar-home-"));
    const app = await profile(t, {
      env: { HOME: shellHome, ZDOTDIR: shellHome, HISTFILE: join(shellHome, ".history") },
    });
    t.after(() => rm(shellHome, { recursive: true, force: true }));
    const file = join(app.runtime, "workspace/sidebar-smoke.txt");
    await writeFile(file, "original sidebar fixture\n");
    const workspace = await app.remote("workspace/create", {
      path: join(app.runtime, "workspace"),
    });
    assert.equal(
      workspace.ok,
      true,
      "the sidebar fixture must register its isolated workspace before native startup chooses a default",
    );
    await app.login();
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1800, height: 1000 },
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
    await expect(page.locator("[data-dsh-better-sidebar]")).toBeAttached({ timeout: 15000 });
    await page
      .getByRole("complementary", { name: "业务导航", exact: true })
      .getByRole("button", { name: "新会话", exact: true })
      .filter({ hasText: "AI工作台" })
      .click();
    await page.getByRole("button", { name: /^选择模型，当前/ }).click();
    await page.getByRole("menuitem", { name: /^模型/ }).click();
    await page.getByRole("menuitemradio", { name: /Local receipt \/ 本地验证回执/ }).click();
    const composer = page.locator('[contenteditable="true"], textarea').first();
    await composer.fill("侧栏隔离验收");
    await composer.press("Enter");
    const receipt = page.getByText("本地验证回执（非 AI 分析）：业务资料已进入会话。", {
      exact: true,
    });
    await expect(receipt).toBeVisible();
    // GEA intentionally hides auxiliary launch buttons; retain that policy and use the native shortcut.
    const pane = page.locator("[data-sidebar-right-panel]");
    const expandSidebar = async () => {
      await expect(pane).toBeAttached();
      if ((await pane.getAttribute("data-sidebar-right-open")) !== "true")
        await page.keyboard.press("ControlOrMeta+Shift+B");
      await expect(pane).toHaveAttribute("data-sidebar-right-open", "true");
      await expect(pane).toBeVisible();
    };
    await expandSidebar();
    const showGuide = async () => {
      const guide = page.locator("[data-sidebar-right-guide]");
      if (!(await guide.isVisible())) {
        const start = pane.getByRole("tab", { name: /^(开始|Start)$/ });
        if (await start.isVisible()) await start.click();
        else await pane.locator("[data-dockkit-add-tab]").first().click();
      }
      await expect(guide).toBeVisible();
    };
    await showGuide();
    const kinds = ["files", "git", "subagent", "sidechat", "terminal"];
    for (const kind of kinds)
      await expect(page.locator(`[data-sidebar-right-guide-entry="${kind}"]`)).toHaveCount(1);
    await expect(page.locator('[data-sidebar-right-guide-entry="browser"]')).toHaveCount(0);
    const open = async (kind) => {
      await showGuide();
      await page.locator(`[data-sidebar-right-guide-entry="${kind}"]`).click();
    };
    await open("files");
    const row = pane.locator('[role="button"][title$="sidebar-smoke.txt"]:visible');
    await expect(row).toHaveCount(1);
    await row.click({ position: { x: 8, y: 8 } });
    const editor = pane.locator(".cm-content:visible").first();
    await expect(editor).toContainText("original sidebar fixture");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("saved from isolated sidebar\n");
    await page.keyboard.press("ControlOrMeta+S");
    await expect.poll(() => readFile(file, "utf8")).toBe("saved from isolated sidebar\n");
    await page.reload();
    // GEA may land on its business page at boot; reopen the saved conversation through history.
    const history = page.getByRole("button", { name: "历史会话", exact: true });
    if ((await history.getAttribute("aria-expanded")) !== "true") await history.click();
    await page
      .getByRole("complementary", { name: "业务导航", exact: true })
      .getByText("侧栏隔离验收", { exact: true })
      .click();
    await expect(receipt).toBeVisible({ timeout: 15000 });
    await expandSidebar();
    await expect(pane.locator(".cm-content:visible").first()).toContainText(
      "saved from isolated sidebar",
    );
    for (const kind of ["git", "subagent", "sidechat"]) {
      await open(kind);
      await expect(pane.locator("[data-dsh-native-tab-host]:visible")).toHaveCount(1);
    }
    await expect
      .poll(() =>
        page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .some((entry) => entry.name.includes("/sidebar/api/sidechat.events")),
        ),
      )
      .toBe(true);
    await open("terminal");
    await expect(pane.locator(".xterm")).toBeVisible();
    const terminalInput = pane.locator(".xterm-helper-textarea");
    await expect(terminalInput).toBeEditable();
    await terminalInput.focus();
    await page.keyboard.insertText("printf 'SIDEBAR_%s\\n' READY");
    await page.keyboard.press("Enter");
    await expect(pane.locator(".xterm-rows")).toContainText("SIDEBAR_READY");
    assert.deepEqual(errors, []);
    const provenance = JSON.parse(
      await readFile(join(app.runtime, "company-plugins.json"), "utf8"),
    );
    assert.equal(
      provenance["dsh-better-sidebar"].commit,
      "e35120f1d9b3773062b68decb4f53a526d6c8baa",
    );
    await mkdir(".runtime/source-compatibility", { recursive: true });
    await page.screenshot({
      path: ".runtime/source-compatibility/sidebar-source.png",
      fullPage: true,
    });
  },
);
