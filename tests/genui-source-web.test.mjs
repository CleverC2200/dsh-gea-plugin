import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { modelProfile as profile } from "./fixtures/model-profile.mjs";

test(
  "source GenUI renders a persisted model reply and restores local input after refresh",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 90000,
  },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        analysis: {
          mode: "model",
          source: "direct",
          baseUrl: base + "/v1",
          model: "fixture",
          apiKeyEnv: "GEA_GENUI_TEST_KEY",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: { GEA_GENUI_TEST_KEY: "fixture-only" },
    });
    let modelCalls = 0;
    const spec = {
      title: "GenUI 隔离验收",
      items: [
        { type: "stat", label: "样例已完成", value: "3" },
        { type: "input", id: "verification-note", label: "本地备注", placeholder: "填写验收备注" },
      ],
    };
    app.route((req, res) => {
      if (req.url.pathname !== "/v1/chat/completions") return false;
      modelCalls++;
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  content: "以下是隔离测试样例。\n```dsh-ui\n" + JSON.stringify(spec) + "\n```",
                },
                finish_reason: "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return true;
    });
    await app.login();
    const provenance = JSON.parse(
      await readFile(join(app.runtime, "company-plugins.json"), "utf8"),
    );
    assert.equal(
      provenance["@changfenhuang/dsh-genui"].commit,
      "382db5575ad3068efeff0322eec9cc499f79ae01",
    );
    const modules = join(app.runtime, "home/profiles/plugin-split-validation/node_modules");
    assert.equal(
      await realpath(join(modules, "@changfenhuang/dsh-genui/node_modules/@deepseek-ai/cordis")),
      await realpath(
        join(modules, "@cleverc2200/gea-dsh-prototype/node_modules/@deepseek-ai/cordis"),
      ),
      "GenUI and GEA must share the source host's Cordis instance",
    );
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1536, height: 920 },
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
    const opening = Promise.withResolvers(),
      releaseOpening = Promise.withResolvers();
    let heldOpening = false;
    t.after(() => releaseOpening.resolve());
    await page.route("**/api/agent-workbench/config", async (route) => {
      if (heldOpening) return route.continue();
      heldOpening = true;
      opening.resolve();
      await releaseOpening.promise;
      await route.continue();
    });
    const messages = [];
    page.on("console", (message) => messages.push(message.text()));
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: /内测声明|预览版说明/ })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    const composer = page.locator('[contenteditable="true"], textarea').first();
    await opening.promise;
    await expect(page.locator("iframe[data-gea-workbench]")).toBeVisible();
    await expect(composer).toBeHidden();
    releaseOpening.resolve();
    await expect(composer).toBeVisible();
    await composer.fill("用卡片展示测试样例，不查询业务数据。");
    await composer.press("Enter");
    const card = page.locator("[data-genui]").filter({ hasText: "样例已完成" }).first();
    await expect(card).toBeVisible();
    assert.ok(
      messages.some((message) => message.includes("[genui] client active")),
      messages.join("\n"),
    );
    const input = page.getByPlaceholder("填写验收备注");
    await input.fill("刷新后保留");
    await input.blur();
    // GenUI debounces durable state writes; reload only after the save is observable.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = JSON.parse(localStorage.getItem("dsh.genui.interaction") ?? "{}");
          return Object.values(state.blocks ?? {}).some(
            (block) => block.fields?.["verification-note"] === "刷新后保留",
          );
        }),
      )
      .toBe(true);
    await page.reload();
    await expect(page.getByPlaceholder("填写验收备注")).toHaveValue("刷新后保留");
    assert.equal(modelCalls, 1, "local input and reload must not call the model again");
    await mkdir(".runtime/source-compatibility", { recursive: true });
    await page.screenshot({
      path: ".runtime/source-compatibility/genui-source-rendered.png",
      fullPage: true,
    });
  },
);
