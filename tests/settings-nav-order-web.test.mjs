import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import {
  openRegisteredWorkbenchPage,
  prepareWorkbenchPageAccess,
  salesPlanFrame,
} from "./fixtures/business-page.mjs";

// This private package uses Core's published client loader and settings.section ledger.
const settingsClient = `window.__ModuleLoader__.load({
  id: '@fixture/settings-order',
  factory(require) {
    const React = require('react');
    return {
      inject: ['slots'],
      apply(ctx) {
        let removeTemporary;
        const Temporary = () => React.createElement('p', null, '临时测试导航内容');
        const SoftwareUpdate = () => React.createElement('section', { 'aria-label': '软件更新夹具' },
          React.createElement('button', { type: 'button', onClick() {
            if (!removeTemporary) removeTemporary = ctx.slots.register({
              name: 'settings.section', id: 'fixture-temporary', order: 150,
              label: () => '临时测试导航',
            }, Temporary);
          } }, '注册测试导航'),
          React.createElement('button', { type: 'button', onClick() {
            removeTemporary?.(); removeTemporary = undefined;
          } }, '移除测试导航'));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'fixture-software-update', order: 200,
          label: () => '软件更新',
        }, SoftwareUpdate));
        ctx.effect(() => () => removeTemporary?.());
      },
    };
  },
});`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Native General/Models and Sidebar retain their real order while a public registrant changes. */
test("设置扩展保持顺序且插件管理位于末尾", { timeout: 90000 }, async (t) => {
  let fixtureFiles, profilePatch;
  const app = await profile(t, {
    async beforeStart(input) {
      const { runtime } = input;
      const directory = resolve(runtime, "fixtures/settings-order");
      await mkdir(directory, { recursive: true });
      const files = {
        "package.json": JSON.stringify({
          name: "@fixture/settings-order",
          version: "0.0.1",
          private: true,
          type: "module",
          main: "index.js",
          exports: { ".": "./index.js", "./client": "./client.js" },
          dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web" } },
        }),
        "index.js": "export function apply() {}\n",
        "client.js": settingsClient,
        "cordis.patch.yml": JSON.stringify([
          { insert: [{ id: "fixture-settings-order", name: "@fixture/settings-order" }] },
        ]),
      };
      fixtureFiles = Object.entries(files).map(([name, bytes]) => ({
        path: resolve(directory, name),
        sha256: digest(bytes),
      }));
      for (const [name, bytes] of Object.entries(files))
        await writeFile(resolve(directory, name), bytes);
      const profileDirectory = resolve(runtime, "home/profiles/plugin-split-validation");
      await mkdir(profileDirectory, { recursive: true });
      const patch = resolve(profileDirectory, "cordis.patch.yml");
      // Keep any actual profile entries instead of replacing a prepared user patch.
      let entries = [];
      try {
        entries = YAML.parse(await readFile(patch, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      entries.push({
        insert: [{ id: "fixture-settings-order", name: resolve(directory, "index.js") }],
      });
      await writeFile(patch, JSON.stringify(entries));
      await prepareWorkbenchPageAccess([["gea-proof", "销售计划"]])(input);
      profilePatch = {
        path: patch,
        sha256: digest(await readFile(patch)),
        entry: { id: "fixture-settings-order", name: resolve(directory, "index.js") },
      };
      const evidence = resolve(".runtime/settings-order-evidence");
      await mkdir(evidence, { recursive: true });
      await writeFile(
        resolve(evidence, "input.json"),
        JSON.stringify({ fixtureFiles, profilePatch }, null, 2),
      );
    },
    config: (base) => ({
      environment: "test",
      geaEnvironments: { production: base + "/production", test: base + "/test" },
    }),
  });
  const browser = await chromium.launch({ headless: true });
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
  page.setDefaultTimeout(25000);
  let allowLogin = false;
  await page.route("**/api/gea-proof/login/poll", (route) =>
    allowLogin
      ? route.continue()
      : route.fulfill({ json: { ok: true, value: { status: "pending" } } }),
  );
  await page.goto(app.origin);
  await page
    .getByRole("dialog", { name: /内测声明|预览版说明/, exact: true })
    .getByRole("button", { name: "继续", exact: true })
    .click();
  await openRegisteredWorkbenchPage(page, "销售计划");
  const frame = salesPlanFrame(page);
  await frame.getByRole("button", { name: "刷新二维码", exact: true }).waitFor();
  allowLogin = true;
  await frame.getByRole("heading", { name: "销售计划审批", exact: true }).waitFor();
  await page.getByRole("button", { name: "账户菜单", exact: true }).click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  const navigation = dialog.getByRole("navigation");
  const labels = () => navigation.getByRole("button").allTextContents();
  const relevant = new Set(["通用设置", "模型", "侧边卡片", "临时测试导航", "软件更新"]);
  const order = async () =>
    (await labels()).map((label) => label.trim()).filter((label) => relevant.has(label));
  const unchanged = ["通用设置", "模型", "侧边卡片", "软件更新"];
  await expect.poll(order).toEqual(unchanged);
  assert.deepEqual((await labels()).map((label) => label.trim()).slice(-4), [
    "侧边卡片",
    "软件更新",
    "GEA 接口日志",
    "插件管理",
  ]);
  await navigation.getByRole("button", { name: "软件更新", exact: true }).click();
  const fixture = dialog.getByRole("region", { name: "软件更新夹具", exact: true });
  await expect(fixture).toBeVisible();
  for (let iteration = 0; iteration < 2; iteration++) {
    await fixture.getByRole("button", { name: "注册测试导航", exact: true }).click();
    await expect.poll(order).toEqual(["通用设置", "模型", "侧边卡片", "临时测试导航", "软件更新"]);
    await fixture.getByRole("button", { name: "移除测试导航", exact: true }).click();
    await expect.poll(order).toEqual(unchanged);
    assert.deepEqual(
      (await labels()).map((label) => label.trim()).slice(-4),
      ["侧边卡片", "软件更新", "GEA 接口日志", "插件管理"],
      "注册与移除扩展后保留原顺序及插件管理末位",
    );
  }
  for (const file of fixtureFiles)
    assert.equal(digest(await readFile(file.path)), file.sha256, file.path);
  // Core may persist/normalize this user configuration; executable fixture inputs remain immutable.
  const savedPatch = await readFile(profilePatch.path, "utf8");
  await writeFile(resolve(".runtime/settings-order-evidence/saved-patch.yml"), savedPatch);
  await writeFile(
    resolve(".runtime/settings-order-evidence/saved-patch.json"),
    JSON.stringify(
      {
        beforeSha256: profilePatch.sha256,
        afterSha256: digest(savedPatch),
        entry: profilePatch.entry,
      },
      null,
      2,
    ),
  );
  const includesEntry = (value) =>
    Array.isArray(value)
      ? value.some(includesEntry)
      : value !== null &&
        typeof value === "object" &&
        ((value.id === profilePatch.entry.id && value.name === profilePatch.entry.name) ||
          Object.values(value).some(includesEntry));
  assert.equal(
    includesEntry(YAML.parse(savedPatch)),
    true,
    "saved public configuration retains the real fixture registration",
  );
});
