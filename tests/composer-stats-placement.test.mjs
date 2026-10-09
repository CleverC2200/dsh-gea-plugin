import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";

/**
 * 固定Core5bad通过公开conversation.composer.dock将统计胶囊放在输入卡下方。
 * 保留统计、居中和完整seat贴底目的，不再要求退场壳层将统计移到上方。
 * 主对话和工作台右侧会话列共用同一个输入条组件，所以这一条同时覆盖两个界面。
 */
test("官方统计胶囊在输入卡下方，完整输入seat贴着对话列底部", { timeout: 90000 }, async (t) => {
  const app = await profile(t, {
    config: (base) => ({
      environment: "test",
      geaEnvironments: {
        production: base + "/production",
        test: base + "/test",
      },
      analysis: { mode: "receipt" },
    }),
  });
  await app.login();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1600, height: 950 },
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
  await page.goto(app.origin);
  await page
    .getByRole("dialog", { name: /内测声明|预览版说明/, exact: true })
    .getByRole("button", { name: "继续", exact: true })
    .click();

  const newSession = page
    .getByRole("complementary", { name: "业务导航", exact: true })
    .getByRole("button", { name: "新会话", exact: true })
    .filter({ hasText: "AI工作台" });
  await expect(newSession).toHaveAccessibleName("新会话");
  await expect(newSession).toContainText("AI工作台");
  await expect(newSession.locator("svg")).toHaveCount(1);
  await openSalesPlan(page);
  await expect(page.locator("[data-composer-dock]").first()).toBeAttached();

  /** 发一条消息（receipt 模式是本地回执，不调模型），让宿主渲染出统计行。 */
  const ask = async (root) => {
    const input = page.locator(`${root} [contenteditable="true"]`).first();
    await page.getByRole("button", { name: /^选择模型，当前/ }).click();
    await page.getByRole("menuitem", { name: /^模型/ }).click();
    await page.getByRole("menuitemradio", { name: /Local receipt \/ 本地验证回执/ }).click();
    await input.click();
    await input.type("1");
    await page.keyboard.press("Enter");
    await expect(page.locator(`${root} [data-composer-stat=activity]`).first()).toBeVisible();
  };

  /** 统计行必须在当前Core输入卡下方，输入卡必须贴着对话列底部。 */
  const placement = async (root) =>
    page.evaluate((scope) => {
      const seat = document.querySelector(`${scope} [data-composer-seat]`);
      const stats = document.querySelector(`${scope} [data-composer-stat=activity]`);
      const editable = document.querySelector(`${scope} [contenteditable="true"]`);
      if (!seat || !stats || !editable) return null;
      const dock = stats.closest("[data-composer-dock]") ?? stats;
      const card = editable.closest("[data-composer-card]");
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          height: Math.round(rect.height),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        };
      };
      return {
        seat: box(seat),
        stats: box(stats),
        input: box(editable),
        card: card && card !== seat ? box(card) : null,
        order: getComputedStyle(dock).order,
      };
    }, root);

  const assertPlacement = async (surface, root) => {
    const geometry = await placement(root);
    assert.ok(geometry, `${surface}：composer geometry must be measurable`);
    await expect(page.locator(`${root} [data-composer-stat=activity]`)).toContainText(
      /1\s*轮.*1\s*步/,
    );
    assert.ok(
      Math.abs(
        geometry.stats.left + geometry.stats.right - (geometry.card.left + geometry.card.right),
      ) <= 2,
      `${surface}：统计与输入卡保持同中心线`,
    );
    assert.equal(geometry.order, "0", `${surface}：${JSON.stringify(geometry)}`);
    assert.ok(
      geometry.stats.top >= geometry.card.bottom,
      `${surface}：统计行必须在当前Core输入卡下方：${JSON.stringify(geometry)}`,
    );
    assert.ok(
      geometry.card !== null && geometry.seat.bottom - geometry.stats.bottom <= 12,
      `${surface}：完整原生输入seat必须贴着对话列底部：${JSON.stringify(geometry)}`,
    );
  };

  // ① 工作台右侧会话列（登录后默认停在销售计划页）。
  await expect(page.locator(".agent-workbench-native-conversation").first()).toBeVisible();
  await ask(".agent-workbench-native-conversation");
  await assertPlacement("工作台", ".agent-workbench-native-conversation");

  await mkdir(".runtime/composer-evidence", { recursive: true });
  await page.screenshot({
    path: ".runtime/composer-evidence/stats-current-dock-workbench.png",
  });

  // ② 主对话：同一个输入条组件，规则必须同样生效。
  await newSession.click();
  await expect(page.locator(".gea-company-main").first()).toBeVisible();
  await ask(".gea-company-main");
  await assertPlacement("主对话", ".gea-company-main");
  await page.screenshot({
    path: ".runtime/composer-evidence/stats-current-dock-main.png",
  });
});
