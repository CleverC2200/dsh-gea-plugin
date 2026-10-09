import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

/**
 * 设置弹窗左栏顺序由各插件注册的 order 决定，第三方「侧边卡片」会落到系统项后面。
 * 复用已经装载的插件导航，仅在旧夹具缺项时补行，再把两行摆成待排序的顺序，
 * 验证外壳的排序逻辑（卡片要排在系统项前面，并且不会反复上移）。
 */
test("设置左栏把「侧边卡片」排在「软件更新」前面", { timeout: 90000 }, async (t) => {
  const app = await profile(t, {
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
  const frame = page.frameLocator("iframe[data-gea-workbench]");
  await frame.getByRole("button", { name: "刷新二维码", exact: true }).waitFor();
  allowLogin = true;
  await frame.getByRole("heading", { name: "销售计划审批", exact: true }).waitFor();
  await page.getByRole("button", { name: "账户菜单", exact: true }).click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  const navList = page.locator('[role="dialog"] [class*="navList"]');
  await navList.waitFor();

  // 同时支持已装载插件中心的源码组合和缺少该插件的旧运行环境。
  await page.evaluate(() => {
    const list = document.querySelector('[role="dialog"] [class*="navList"]');
    const add = (label) => {
      const cell =
        [...list.children].find((node) => node.textContent?.trim() === label) ??
        document.createElement("button");
      cell.type = "button";
      cell.textContent = label;
      list.append(cell);
      return cell;
    };
    add("软件更新");
    add("侧边卡片");
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const list = document.querySelector('[role="dialog"] [class*="navList"]');
        return [...list.children].map((cell) => (cell.textContent ?? "").trim()).slice(-2);
      }),
    )
    .toEqual(["侧边卡片", "软件更新"]);

  // 再触发一次变更：已经就位的卡片不能再往上跑。
  await page.evaluate(() => {
    const list = document.querySelector('[role="dialog"] [class*="navList"]');
    const cell = document.createElement("button");
    cell.type = "button";
    cell.textContent = "模型";
    list.prepend(cell);
  });
  await page.waitForTimeout(300);
  assert.deepEqual(
    await page.evaluate(() => {
      const list = document.querySelector('[role="dialog"] [class*="navList"]');
      return [...list.children].map((cell) => (cell.textContent ?? "").trim()).slice(0, 2);
    }),
    ["模型", "通用设置"],
    "卡片不能继续上移",
  );
});
