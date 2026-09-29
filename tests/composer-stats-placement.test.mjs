import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

/**
 * 会话统计（「N 轮 M 步」）原生挂在输入卡下方，会把输入卡顶离对话列底部。
 * 这里钉住外壳的排布：统计行在输入框上方，输入卡是对话列最下面一块。
 * 主对话和工作台右侧会话列共用同一个输入条组件，所以这一条同时覆盖两个界面。
 */
test(
  "会话统计行在输入框上方，输入框贴着对话列底部",
  { timeout: 90000 },
  async (t) => {
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
    const browser = await chromium.launch({ channel: "chrome", headless: true });
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

    /** 发一条消息（receipt 模式是本地回执，不调模型），让宿主渲染出统计行。 */
    const ask = async (root) => {
      const input = page.locator(`${root} [contenteditable="true"]`).first();
      await input.click();
      await input.type("1");
      await page.keyboard.press("Enter");
      await expect(
        page.locator(`${root} [data-composer-stats]`).first(),
      ).toBeVisible();
    };

    /** 统计行必须在输入框上方，输入卡必须贴着对话列底部。 */
    const placement = async (root) => page.evaluate((scope) => {
      const seat = document.querySelector(`${scope} [data-composer-seat]`);
      const stats = document.querySelector(`${scope} [data-composer-stats]`);
      const editable = document.querySelector(`${scope} [contenteditable="true"]`);
      if (!seat || !stats || !editable) return null;
      const dock = stats.closest('[data-slot="conversation.composer.dock"]') ?? stats;
      const card = editable.closest('[data-composer-card]');
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          height: Math.round(rect.height),
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
      assert.equal(geometry.order, "-1", `${surface}：${JSON.stringify(geometry)}`);
      assert.ok(
        geometry.stats.bottom <= geometry.input.top,
        `${surface}：统计行必须在输入框上方：${JSON.stringify(geometry)}`,
      );
      assert.ok(
        geometry.card !== null && geometry.seat.bottom - geometry.card.bottom <= 16,
        `${surface}：输入框必须贴着对话列底部：${JSON.stringify(geometry)}`,
      );
    };

    // ① 工作台右侧会话列（登录后默认停在销售计划页）。
    await expect(page.locator(".AppFrame_rightbarCol").first()).toBeVisible();
    await ask(".AppFrame_rightbarCol");
    await assertPlacement("工作台", ".AppFrame_rightbarCol");

    await mkdir(".runtime/composer-evidence", { recursive: true });
    await page.screenshot({
      path: ".runtime/composer-evidence/stats-above-composer-workbench.png",
    });

    // ② 主对话：同一个输入条组件，规则必须同样生效。
    await page.getByRole("button", { name: "AI工作台", exact: true }).first().click();
    await expect(page.locator(".AppFrame_centerCol").first()).toBeVisible();
    await ask(".AppFrame_centerCol");
    await assertPlacement("主对话", ".AppFrame_centerCol");
    await page.screenshot({
      path: ".runtime/composer-evidence/stats-above-composer-main.png",
    });
  },
);
