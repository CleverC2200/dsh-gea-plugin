import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

test("logout clears identity and invalidates previous QR login", { timeout: 60000 }, async (t) => {
  const app = await profile(t);
  assert.equal((await app.rpc("logout")).value.authenticated, false);
  await app.login();
  assert.equal((await app.rpc("logout", { unexpected: true })).ok, false);
  assert.equal((await app.rpc("status")).value.authenticated, true);
  const plans = (await app.rpc("plans")).value;
  const preview = (await app.rpc("prepare", { queryId: plans.queryId, planId: plans.records[0].planId })).value;
  const result = await app.rpc("logout");
  assert.equal(result.value.authenticated, false);
  assert.equal(result.value.user, null);
  assert.deepEqual(result.value.discoveredModels, []);
  assert.equal((await app.rpc("plans")).ok, false);
  assert.equal((await app.rpc("submit", { previewId: preview.previewId })).ok, false);
  const qr = await app.rpc("login/start");
  await app.rpc("logout");
  assert.equal((await app.rpc("login/poll", { loginId: qr.value.loginId })).ok, false);
  assert.equal((await app.rpc("status")).value.authenticated, false);
  await app.login();
  assert.equal((await app.rpc("status")).value.authenticated, true);
});

test("Chrome logout works from both shells, retries failure and signs out other tabs", { timeout: 90000 }, async (t) => {
  const app = await profile(t);
  app.route((request,_res,reply)=>{
    if (!request.url.pathname.endsWith('/getUserInfo')) return false;
    reply({success:true,result:{userInfo:{id:'user',realname:'测试用户',loginTenantId:'0',avatar:'https://avatar.test/feishu.png'}}});return true;
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1536, height: 920 } });
  await context.addCookies(app.cookie.split("; ").map(pair => ({
    name: pair.slice(0, pair.indexOf("=")), value: pair.slice(pair.indexOf("=") + 1), url: app.origin,
  })));
  await context.route('https://avatar.test/feishu.png',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64')}));
  let allowLogin = false;
  await context.route("**/api/gea-proof/login/poll", route => allowLogin ? route.continue() : route.fulfill({ json: { ok: true, value: { status: "pending" } } }));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(app.origin);
  await page.getByRole("dialog", { name: "内测声明", exact: true }).getByRole("button", { name: "继续", exact: true }).click();
  await page.frameLocator("iframe[data-gea-workbench]").getByRole("button", { name: "刷新二维码", exact: true }).waitFor();
  allowLogin = true;
  await expect.poll(async () => (await app.rpc("status")).value.authenticated).toBe(true);
  await expect(page.locator('.gea-user-avatar img')).toHaveAttribute('src','https://avatar.test/feishu.png');
  await page.getByRole("button", { name: "账户菜单", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "退出登录", exact: true })).toBeVisible();
  allowLogin = false;
  const second = await context.newPage();
  await second.goto(app.origin);
  await second.getByRole("button", { name: "账户菜单", exact: true }).click();
  await expect(second.getByRole("menuitem", { name: "退出登录", exact: true })).toBeVisible();
  await page.bringToFront();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.locator(".gea-brand-switch").click();
  await page.getByRole("button", { name: "账户菜单", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "设置", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "退出登录", exact: true })).toBeFocused();
  await expect(page.getByRole("menuitem", { name: "退出登录", exact: true })).toBeVisible();
  await page.route("**/api/gea-proof/logout", route => route.fulfill({ status: 500, json: { ok: false } }));
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "退出失败，请重试。" })).toBeVisible();
  assert.equal((await app.rpc("status")).value.authenticated, true);
  await page.unroute("**/api/gea-proof/logout");
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
  for (const tab of [page, second]) {
    await expect(tab.frameLocator("iframe[data-gea-workbench]").getByRole("button", { name: "刷新二维码", exact: true })).toBeVisible();
    await expect(tab.getByRole("menuitem", { name: "退出登录", exact: true })).toHaveCount(0);
  }
  assert.equal((await app.rpc("status")).value.authenticated, false);
  await second.close();
  await page.frameLocator("iframe[data-gea-workbench]").getByRole("button", { name: "刷新二维码", exact: true }).click();
  allowLogin = true;
  await expect.poll(async () => (await app.rpc("status")).value.authenticated).toBe(true);
  await page.getByRole("button", { name: "账户菜单", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "退出登录", exact: true })).toBeVisible();
  allowLogin = false;
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
  await expect(page.frameLocator("iframe[data-gea-workbench]").getByRole("button", { name: "刷新二维码", exact: true })).toBeVisible();
  assert.equal((await app.rpc("status")).value.authenticated, false);
});
